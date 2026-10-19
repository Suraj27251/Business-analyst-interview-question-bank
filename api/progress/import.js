'use strict';

const { requireMethod, readJsonBody, ok, handleError } = require('../../lib/http');
const { requireWriteAuth } = require('../../lib/auth');
const { normalizeImportPayload } = require('../../lib/validate');
const { applyImport, getFullProgress } = require('../../lib/repository');

// POST /api/progress/import
// Body: a normalized snapshot from the browser's localStorage.
// strategy: "merge" (default, timestamp-guarded) or "replace" (explicit restore).
// Returns import counts plus the resulting canonical snapshot.
module.exports = async function handler(req, res) {
  if (!requireMethod(req, res, 'POST')) return;
  try {
    const user = await requireWriteAuth(req);
    const body = await readJsonBody(req);
    const payload = normalizeImportPayload(body);
    const result = await applyImport(user.id, payload);
    const progress = await getFullProgress(user.id);
    ok(res, {
      ok: true,
      strategy: payload.strategy,
      counts: result.counts,
      byDomain: result.byDomain,
      progress,
    });
  } catch (error) {
    handleError(res, error, 'progress/import');
  }
};
