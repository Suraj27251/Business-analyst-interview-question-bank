'use strict';

const { requireMethod, readJsonBody, ok, handleError } = require('../lib/http');
const { requireWriteAuth } = require('../lib/auth');
const { normalizePreferences } = require('../lib/validate');
const { upsertPreferences } = require('../lib/repository');

// POST /api/preferences
// Body may contain any of: recent, activeFocus, activeMock, settings.
// Explicit null for activeFocus/activeMock clears the stored value.
module.exports = async function handler(req, res) {
  if (!requireMethod(req, res, 'POST')) return;
  try {
    const user = await requireWriteAuth(req);
    const body = await readJsonBody(req);
    const preferences = normalizePreferences(body);
    if (!Object.keys(preferences).length) {
      ok(res, { ok: true, updated: [] });
      return;
    }
    await upsertPreferences(user.id, preferences);
    ok(res, { ok: true, updated: Object.keys(preferences) });
  } catch (error) {
    handleError(res, error, 'preferences');
  }
};
