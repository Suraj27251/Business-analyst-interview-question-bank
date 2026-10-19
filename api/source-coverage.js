'use strict';

const { requireMethod, readJsonBody, ok, handleError } = require('../lib/http');
const { requireWriteAuth } = require('../lib/auth');
const { normalizeRecordArray, normalizeSourceCoverage } = require('../lib/validate');
const { upsertSourceCoverage } = require('../lib/repository');

// POST /api/source-coverage  { records: [{ sourcePath, reviewed, updatedAt }] }
module.exports = async function handler(req, res) {
  if (!requireMethod(req, res, 'POST')) return;
  try {
    const user = await requireWriteAuth(req);
    const body = await readJsonBody(req);
    const records = normalizeRecordArray(body.records, 'records', normalizeSourceCoverage);
    const applied = await upsertSourceCoverage(user.id, records);
    ok(res, { ok: true, received: records.length, applied });
  } catch (error) {
    handleError(res, error, 'source-coverage');
  }
};
