'use strict';

// Authentication utilities.
//
// Sessions are opaque, random 256-bit tokens. Only a SHA-256 hash of the token
// is stored in the database, so a database read cannot be replayed as a
// session. The raw token lives only in an HttpOnly cookie. Password hashing
// uses bcrypt (bcryptjs). CSRF uses a double-submit cookie that must be echoed
// in the x-csrf-token header for authenticated state-changing requests.

const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const {
  ApiError,
  parseCookies,
  serializeCookie,
  appendSetCookie,
  isHttps,
  assertSameOrigin,
} = require('./http');
const { getSql } = require('./db');

const SESSION_COOKIE = 'prep_session';
const CSRF_COOKIE = 'prep_csrf';
const CSRF_HEADER = 'x-csrf-token';
const BCRYPT_ROUNDS = 12;

function sessionTtlSeconds() {
  const value = Number(process.env.SESSION_TTL_SECONDS);
  if (Number.isFinite(value) && value > 0) return Math.floor(value);
  return 60 * 60 * 24 * 30; // 30 days
}

function hashPassword(password) {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function randomToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function timingSafeEqual(a, b) {
  const bufferA = Buffer.from(String(a));
  const bufferB = Buffer.from(String(b));
  if (bufferA.length !== bufferB.length) return false;
  return crypto.timingSafeEqual(bufferA, bufferB);
}

function setSessionCookies(req, res, token, ttlSeconds) {
  const secure = isHttps(req);
  appendSetCookie(
    res,
    serializeCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      secure,
      sameSite: 'Lax',
      maxAge: ttlSeconds,
    })
  );
}

function clearSessionCookies(req, res) {
  const secure = isHttps(req);
  for (const name of [SESSION_COOKIE, CSRF_COOKIE]) {
    appendSetCookie(
      res,
      serializeCookie(name, '', {
        httpOnly: name === SESSION_COOKIE,
        secure,
        sameSite: 'Lax',
        maxAge: 0,
      })
    );
  }
}

function ensureCsrfCookie(req, res) {
  const cookies = parseCookies(req);
  if (cookies[CSRF_COOKIE]) return cookies[CSRF_COOKIE];
  const value = randomToken();
  appendSetCookie(
    res,
    serializeCookie(CSRF_COOKIE, value, {
      httpOnly: false,
      secure: isHttps(req),
      sameSite: 'Lax',
      maxAge: sessionTtlSeconds(),
    })
  );
  return value;
}

function assertCsrf(req) {
  const cookies = parseCookies(req);
  const cookieValue = cookies[CSRF_COOKIE];
  const headerValue = req.headers[CSRF_HEADER];
  if (!cookieValue || !headerValue || !timingSafeEqual(cookieValue, headerValue)) {
    throw new ApiError(403, 'CSRF_FAILED', 'Request could not be verified. Reload the page and try again.');
  }
}

async function createSession(userId, ttlSeconds = sessionTtlSeconds()) {
  const sql = getSql();
  const token = randomToken();
  const tokenHash = sha256(token);
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
  await sql.query(
    'insert into sessions (user_id, token_hash, expires_at) values ($1, $2, $3)',
    [userId, tokenHash, expiresAt.toISOString()]
  );
  return { token, expiresAt, ttlSeconds };
}

async function destroySession(req) {
  const cookies = parseCookies(req);
  const token = cookies[SESSION_COOKIE];
  if (!token) return;
  const sql = getSql();
  await sql.query('update sessions set revoked_at = now() where token_hash = $1 and revoked_at is null', [
    sha256(token),
  ]);
}

async function destroyAllSessions(userId) {
  const sql = getSql();
  await sql.query('update sessions set revoked_at = now() where user_id = $1 and revoked_at is null', [userId]);
}

// Resolves the current user from the session cookie. Returns null when there is
// no valid session. Never trusts a client-supplied user id.
async function getSessionUser(req) {
  const cookies = parseCookies(req);
  const token = cookies[SESSION_COOKIE];
  if (!token) return null;
  const sql = getSql();
  const rows = await sql.query(
    `with touched as (
       update sessions set last_used_at = now()
       where token_hash = $1 and revoked_at is null and expires_at > now()
       returning user_id
     )
     select u.id, u.email, u.display_name
     from touched t join users u on u.id = t.user_id`,
    [sha256(token)]
  );
  if (!rows.length) return null;
  return { id: rows[0].id, email: rows[0].email, displayName: rows[0].display_name || null };
}

async function requireUser(req) {
  const user = await getSessionUser(req);
  if (!user) throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in to access this resource.');
  return user;
}

// Guard for state-changing requests: verifies same-origin, a valid session and
// the double-submit CSRF token, then returns the authenticated user.
async function requireWriteAuth(req) {
  assertSameOrigin(req);
  const user = await requireUser(req);
  assertCsrf(req);
  return user;
}

async function requireReadAuth(req) {
  return requireUser(req);
}

// DB-backed rate limiting so limits hold across serverless instances.
async function checkRateLimit(key, limit, windowSeconds) {
  const sql = getSql();
  const rows = await sql.query(
    `insert into auth_rate_limits (key, window_start, attempts)
     values ($1, now(), 1)
     on conflict (key) do update set
       attempts = case
         when auth_rate_limits.window_start < now() - make_interval(secs => $2::int) then 1
         else auth_rate_limits.attempts + 1
       end,
       window_start = case
         when auth_rate_limits.window_start < now() - make_interval(secs => $2::int) then now()
         else auth_rate_limits.window_start
       end
     returning attempts`,
    [key, windowSeconds]
  );
  const attempts = Number(rows[0]?.attempts || 0);
  if (attempts > limit) {
    throw new ApiError(429, 'RATE_LIMITED', 'Too many attempts. Please wait and try again.');
  }
}

module.exports = {
  SESSION_COOKIE,
  CSRF_COOKIE,
  CSRF_HEADER,
  sessionTtlSeconds,
  hashPassword,
  verifyPassword,
  createSession,
  destroySession,
  destroyAllSessions,
  getSessionUser,
  requireUser,
  requireWriteAuth,
  requireReadAuth,
  setSessionCookies,
  clearSessionCookies,
  ensureCsrfCookie,
  assertCsrf,
  checkRateLimit,
  sha256,
  timingSafeEqual,
};
