'use strict';

const { requireMethod, readJsonBody, assertSameOrigin, ok, fail, handleError, clientIp } = require('../../lib/http');
const { normalizeEmail, validatePassword, ValidationError } = require('../../lib/validate');
const {
  hashPassword,
  createSession,
  setSessionCookies,
  ensureCsrfCookie,
  checkRateLimit,
} = require('../../lib/auth');
const { getSql } = require('../../lib/db');

// POST /api/auth/signup  { email, password, displayName? }
module.exports = async function handler(req, res) {
  if (!requireMethod(req, res, 'POST')) return;
  try {
    assertSameOrigin(req);
    const ip = clientIp(req);
    await checkRateLimit(`signup:${ip}`, 5, 900);

    const body = await readJsonBody(req);
    let email;
    let password;
    try {
      email = normalizeEmail(body.email);
      password = validatePassword(body.password);
    } catch (error) {
      if (error instanceof ValidationError) {
        fail(res, 400, error.code, error.message, error.details);
        return;
      }
      throw error;
    }
    const displayName = typeof body.displayName === 'string' ? body.displayName.slice(0, 120).trim() || null : null;

    const sql = getSql();
    const existing = await sql.query('select id from users where email_normalized = $1', [email]);
    if (existing.length) {
      // Do not reveal whether the address exists beyond this generic conflict.
      fail(res, 409, 'EMAIL_IN_USE', 'An account with this email already exists.');
      return;
    }

    const passwordHash = await hashPassword(password);
    const inserted = await sql.query(
      `insert into users (email, email_normalized, password_hash, display_name)
       values ($1, $2, $3, $4)
       returning id, email, display_name`,
      [body.email.trim(), email, passwordHash, displayName]
    );
    const user = inserted[0];

    const session = await createSession(user.id);
    setSessionCookies(req, res, session.token, session.ttlSeconds);
    ensureCsrfCookie(req, res);
    ok(res, { user: { id: user.id, email: user.email, displayName: user.display_name || null } }, 201);
  } catch (error) {
    // Another request may have created the same address between the check and
    // the insert; keep the response generic either way.
    if (error && error.code === '23505') {
      fail(res, 409, 'EMAIL_IN_USE', 'An account with this email already exists.');
      return;
    }
    handleError(res, error, 'auth/signup');
  }
};
