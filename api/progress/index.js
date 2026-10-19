'use strict';

const { requireMethod, ok, handleError } = require('../../lib/http');
const { requireReadAuth } = require('../../lib/auth');
const { getFullProgress } = require('../../lib/repository');

// GET /api/progress
// Returns the authenticated user's full cloud snapshot. Never accepts a user id
// from the client.
module.exports = async function handler(req, res) {
  if (!requireMethod(req, res, 'GET')) return;
  try {
    const user = await requireReadAuth(req);
    const snapshot = await getFullProgress(user.id);
    ok(res, { userId: user.id, progress: snapshot });
  } catch (error) {
    handleError(res, error, 'progress/index');
  }
};
