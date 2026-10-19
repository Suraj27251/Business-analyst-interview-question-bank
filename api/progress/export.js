'use strict';

const { requireMethod, handleError } = require('../../lib/http');
const { requireReadAuth } = require('../../lib/auth');
const { getFullProgress } = require('../../lib/repository');

// GET /api/progress/export
// Downloads the authenticated user's progress as a JSON attachment.
module.exports = async function handler(req, res) {
  if (!requireMethod(req, res, 'GET')) return;
  try {
    const user = await requireReadAuth(req);
    const progress = await getFullProgress(user.id);
    const body = JSON.stringify(
      {
        format: 'ba-prep-desk-progress',
        version: 1,
        exportedAt: new Date().toISOString(),
        user: { id: user.id, email: user.email },
        progress,
      },
      null,
      2
    );
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="ba-prep-progress-${new Date().toISOString().slice(0, 10)}.json"`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(body);
  } catch (error) {
    handleError(res, error, 'progress/export');
  }
};
