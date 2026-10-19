'use strict';

const { requireMethod, readJsonBody, ok, handleError } = require('../lib/http');
const { requireWriteAuth } = require('../lib/auth');
const { normalizeRecordArray, normalizeFocusSession } = require('../lib/validate');
const { upsertFocusSessions } = require('../lib/repository');

// POST /api/focus-sessions  { records: [...] }
// Only completed focus sessions are stored here; the live timer's ticking state
// is persisted through /api/preferences (activeFocus) at meaningful transitions.
module.exports = async function handler(req, res) {
  if (!requireMethod(req, res, 'POST')) return;
  try {
    const user = await requireWriteAuth(req);
    const body = await readJsonBody(req);
    const records = normalizeRecordArray(body.records, 'records', normalizeFocusSession);
    const applied = await upsertFocusSessions(user.id, records);
    ok(res, { ok: true, received: records.length, applied });
  } catch (error) {
    handleError(res, error, 'focus-sessions');
  }
};
