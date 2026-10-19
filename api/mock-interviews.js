'use strict';

const { requireMethod, readJsonBody, ok, handleError } = require('../lib/http');
const { requireWriteAuth } = require('../lib/auth');
const { normalizeRecordArray, normalizeMockSession } = require('../lib/validate');
const { upsertMockSessions } = require('../lib/repository');

// POST /api/mock-interviews  { sessions: [...] }
// Each session: { clientId, startedAt, finishedAt, durationMinutes, answered,
//                 total, payload, updatedAt }
// clientId must be stable per session (the start timestamp) so retries and
// cross-device imports are idempotent.
module.exports = async function handler(req, res) {
  if (!requireMethod(req, res, 'POST')) return;
  try {
    const user = await requireWriteAuth(req);
    const body = await readJsonBody(req);
    const sessions = normalizeRecordArray(body.sessions, 'sessions', normalizeMockSession);
    const applied = await upsertMockSessions(user.id, sessions);
    ok(res, { ok: true, received: sessions.length, applied });
  } catch (error) {
    handleError(res, error, 'mock-interviews');
  }
};
