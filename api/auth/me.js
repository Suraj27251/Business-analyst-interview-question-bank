'use strict';

const { requireMethod, ok, handleError } = require('../../lib/http');
const { getSessionUser, ensureCsrfCookie } = require('../../lib/auth');
const { isDatabaseConfigured } = require('../../lib/db');

// GET /api/auth/me
// Returns the signed-in user (or null) and always (re)issues the CSRF cookie.
module.exports = async function handler(req, res) {
  if (!requireMethod(req, res, 'GET')) return;
  try {
    if (!isDatabaseConfigured()) {
      ok(res, { cloudConfigured: false, user: null });
      return;
    }
    ensureCsrfCookie(req, res);
    const user = await getSessionUser(req);
    ok(res, {
      cloudConfigured: true,
      user: user ? { id: user.id, email: user.email, displayName: user.displayName } : null,
    });
  } catch (error) {
    handleError(res, error, 'auth/me');
  }
};
