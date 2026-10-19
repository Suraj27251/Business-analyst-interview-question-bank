'use strict';

const { requireMethod, readJsonBody, ok, fail, handleError } = require('../../lib/http');
const { requireWriteAuth } = require('../../lib/auth');
const { deleteAllProgress } = require('../../lib/repository');

// POST /api/progress/delete  { confirm: true }
// Deletes the authenticated user's cloud progress (keeps the account).
module.exports = async function handler(req, res) {
  if (!requireMethod(req, res, 'POST')) return;
  try {
    const user = await requireWriteAuth(req);
    const body = await readJsonBody(req);
    if (body.confirm !== true) {
      fail(res, 400, 'CONFIRM_REQUIRED', 'Send { "confirm": true } to delete cloud progress.');
      return;
    }
    await deleteAllProgress(user.id);
    ok(res, { ok: true, deleted: true });
  } catch (error) {
    handleError(res, error, 'progress/delete');
  }
};
