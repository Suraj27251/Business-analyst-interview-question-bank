'use strict';

// Small helpers shared by every API endpoint: consistent JSON responses,
// error shapes, method guards, body parsing with size limits, cookie handling
// and same-origin / CSRF checks.

// Vercel Functions accept request bodies up to ~4.5 MB. Stay under that while
// leaving room for a large first-time import of answers and mock sessions.
const MAX_BODY_BYTES = 4 * 1024 * 1024;

class ApiError extends Error {
  constructor(statusCode, code, message, details) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
    if (details) this.details = details;
  }
}

function json(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(payload);
}

function ok(res, body, statusCode = 200) {
  json(res, statusCode, body);
}

function fail(res, statusCode, code, message, details) {
  const error = { code, message };
  if (details) error.details = details;
  json(res, statusCode, { error });
}

function handleError(res, error, logContext = '') {
  if (error instanceof ApiError) {
    fail(res, error.statusCode, error.code, error.message, error.details);
    return;
  }
  // ValidationError and similar well-formed client errors (statusCode < 500).
  if (error && typeof error.statusCode === 'number' && error.statusCode < 500 && error.code) {
    fail(res, error.statusCode, error.code, error.message, error.details);
    return;
  }
  if (error && error.code === 'DB_NOT_CONFIGURED') {
    fail(res, 503, 'DB_NOT_CONFIGURED', 'Cloud storage is not configured on the server.');
    return;
  }
  // Never leak internal SQL, stack traces or secrets to the client.
  // Log a short, non-sensitive diagnostic server-side.
  const tag = logContext ? `[${logContext}] ` : '';
  console.error(`${tag}Unhandled API error: ${error && error.message ? error.message : 'unknown error'}`);
  fail(res, 500, 'INTERNAL_ERROR', 'An unexpected error occurred.');
}

function requireMethod(req, res, ...allowed) {
  if (!allowed.includes(req.method)) {
    res.setHeader('Allow', allowed.join(', '));
    fail(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
    return false;
  }
  return true;
}

async function readJsonBody(req) {
  const contentType = String(req.headers['content-type'] || '');
  if (!contentType.includes('application/json')) {
    throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Expected application/json.');
  }
  const body = await readRawBody(req);
  if (!body.length) return {};
  let parsed;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    throw new ApiError(400, 'INVALID_JSON', 'Request body is not valid JSON.');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ApiError(400, 'INVALID_BODY', 'Request body must be a JSON object.');
  }
  return parsed;
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        settled = true;
        reject(new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!settled) resolve(Buffer.concat(chunks));
    });
    req.on('error', (error) => {
      if (!settled) reject(error);
    });
  });
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${options.path || '/'}`);
  if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(options.maxAge)}`);
  if (options.httpOnly) parts.push('HttpOnly');
  if (options.secure) parts.push('Secure');
  parts.push(`SameSite=${options.sameSite || 'Lax'}`);
  return parts.join('; ');
}

function appendSetCookie(res, cookie) {
  const existing = res.getHeader('Set-Cookie');
  if (!existing) res.setHeader('Set-Cookie', [cookie]);
  else if (Array.isArray(existing)) res.setHeader('Set-Cookie', [...existing, cookie]);
  else res.setHeader('Set-Cookie', [existing, cookie]);
}

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return String(forwarded).split(',')[0].trim();
  const real = req.headers['x-real-ip'];
  if (real) return String(real);
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function isHttps(req) {
  if (String(process.env.INSECURE_COOKIES || '') === 'true') return false;
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  if (proto) return proto === 'https';
  return Boolean(process.env.VERCEL);
}

function originHost(req) {
  const origin = req.headers.origin;
  if (!origin) return null;
  try {
    return new URL(origin).host;
  } catch {
    return 'invalid';
  }
}

// Blocks cross-site form/fetch POSTs. Browsers send Origin on cross-origin
// requests; SameSite=Lax cookies already prevent cross-site cookie attachment.
function assertSameOrigin(req) {
  const origin = req.headers.origin;
  const referer = req.headers.referer;
  const host = req.headers.host;
  if (origin) {
    const parsed = originHost(req);
    if (parsed !== host) throw new ApiError(403, 'BAD_ORIGIN', 'Request origin is not allowed.');
    return;
  }
  if (referer) {
    try {
      if (new URL(referer).host !== host) throw new ApiError(403, 'BAD_ORIGIN', 'Request origin is not allowed.');
      return;
    } catch {
      throw new ApiError(403, 'BAD_ORIGIN', 'Request origin is not allowed.');
    }
  }
  // No Origin and no Referer: reject state-changing requests from browsers.
  throw new ApiError(403, 'MISSING_ORIGIN', 'Request origin could not be verified.');
}

module.exports = {
  ApiError,
  MAX_BODY_BYTES,
  json,
  ok,
  fail,
  handleError,
  requireMethod,
  readJsonBody,
  readRawBody,
  parseCookies,
  serializeCookie,
  appendSetCookie,
  isHttps,
  assertSameOrigin,
  clientIp,
};
