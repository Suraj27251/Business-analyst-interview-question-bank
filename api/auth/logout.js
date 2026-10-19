'use strict';

const { requireMethod, assertSameOrigin, ok, handleError } = require('../../lib/http');
const { destroySession, clearSessionCookies } = require('../../lib/auth');

// POST /api/auth/logout
module.exports = async function handler(req, res) {
  if (!requireMethod(req, res, 'POST')) return;
  try {
    assertSameOrigin(req);
    await destroySession(req);
    clearSessionCookies(req, res);
    ok(res, { ok: true });
  } catch (error) {
    // Logging out should never fail loudly; still clear the cookies.
    clearSessionCookies(req, res);
    handleError(res, error, 'auth/logout');
  }
};
