'use strict';

const { requireMethod, readJsonBody, ok, handleError } = require('../lib/http');
const { requireWriteAuth } = require('../lib/auth');
const { normalizeRecordArray, normalizeSavedQuestion, ValidationError, LIMITS } = require('../lib/validate');
const { upsertSavedQuestions } = require('../lib/repository');

// POST /api/saved-questions  { upserts: [...], removeIds: [...] }
module.exports = async function handler(req, res) {
  if (!requireMethod(req, res, 'POST')) return;
  try {
    const user = await requireWriteAuth(req);
    const body = await readJsonBody(req);
    const rawUpserts = body.upserts ?? body.records ?? [];
    const upserts = normalizeRecordArray(rawUpserts, 'upserts', normalizeSavedQuestion);

    const rawRemove = body.removeIds ?? [];
    if (!Array.isArray(rawRemove) || rawRemove.length > LIMITS.RECORDS_PER_REQUEST) {
      throw new ValidationError('removeIds must be an array of question ids.');
    }
    const removeIds = rawRemove.filter((id) => typeof id === 'string' && id.length <= LIMITS.QUESTION_ID);

    const applied = await upsertSavedQuestions(user.id, upserts, removeIds);
    ok(res, { ok: true, received: upserts.length, removed: removeIds.length, applied });
  } catch (error) {
    handleError(res, error, 'saved-questions');
  }
};
