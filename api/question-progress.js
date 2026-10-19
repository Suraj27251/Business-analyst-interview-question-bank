'use strict';

const { requireMethod, readJsonBody, ok, handleError } = require('../lib/http');
const { requireWriteAuth } = require('../lib/auth');
const { normalizeRecordArray, normalizeQuestionProgress } = require('../lib/validate');
const { upsertQuestionProgress } = require('../lib/repository');

// POST /api/question-progress  { records: [...] }
// Idempotent, last-write-wins upsert of question practice, answers, ratings and
// spaced-repetition state for the authenticated user.
module.exports = async function handler(req, res) {
  if (!requireMethod(req, res, 'POST')) return;
  try {
    const user = await requireWriteAuth(req);
    const body = await readJsonBody(req);
    const records = normalizeRecordArray(body.records, 'records', normalizeQuestionProgress);
    const applied = await upsertQuestionProgress(user.id, records);
    ok(res, { ok: true, received: records.length, applied });
  } catch (error) {
    handleError(res, error, 'question-progress');
  }
};
