'use strict';

const { requireMethod, readJsonBody, assertSameOrigin, ok, fail, handleError, clientIp } = require('../../lib/http');
const { isValidEmail, validatePassword, ValidationError } = require('../../lib/validate');
const {
  verifyPassword,
  createSession,
  setSessionCookies,
  ensureCsrfCookie,
  checkRateLimit,
} = require('../../lib/auth');
const { getSql } = require('../../lib/db');

const DUMMY_HASH = '$2a$12$C6UzMDM.H6dfI/f/IKcEeO0m8X0pxeQ2Q0m8q4Q0m8q4Q0m8q4Q0m';

// POST /api/auth/login  { email, password }
module.exports = async function handler(req, res) {
  if (!requireMethod(req, res, 'POST')) return;
  try {
    assertSameOrigin(req);
    const ip = clientIp(req);
    await checkRateLimit(`login:${ip}`, 20, 900);

    const body = await readJsonBody(req);
    let email;
    try {
      if (typeof body.email !== 'string' || !isValidEmail(body.email)) {
        throw new ValidationError('A valid email and password are required.');
      }
      email = body.email.trim().toLowerCase();
      validatePassword(body.password);
    } catch (error) {
      if (error instanceof ValidationError) {
        fail(res, 400, error.code, error.message);
        return;
      }
      throw error;
    }

    await checkRateLimit(`login:${email}`, 10, 900);

    const sql = getSql();
    const rows = await sql.query(
      'select id, email, display_name, password_hash from users where email_normalized = $1',
      [email]
    );
    const user = rows[0];
    // Always perform a bcrypt comparison to avoid leaking account existence via timing.
    const valid = await verifyPassword(String(body.password), user ? user.password_hash : DUMMY_HASH);

    if (!user || !valid) {
      fail(res, 401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
      return;
    }

    const session = await createSession(user.id);
    setSessionCookies(req, res, session.token, session.ttlSeconds);
    ensureCsrfCookie(req, res);
    ok(res, { user: { id: user.id, email: user.email, displayName: user.display_name || null } });
  } catch (error) {
    handleError(res, error, 'auth/login');
  }
};
