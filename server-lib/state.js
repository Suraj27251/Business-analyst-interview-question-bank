import { Pool } from '@neondatabase/serverless';
import { getIdentity, requireCsrf } from './session.js';

export const STORE_KEYS = new Set([
  'baDays', 'baTaskChecks', ...Array.from({ length: 15 }, (_, i) => `baNote${i + 1}`),
  'baPracticedQuestions', 'baQuestionRatings', 'baSavedQuestions', 'baQuestionAnswers',
  'baRecent', 'baSources', 'baMockSession', 'baMockHistory', 'baFocusSession', 'baFocusLog',
  'baStudioRecent', 'baStudioCaseResponses', 'baStudioJdText', 'baStudioJdChecklist',
  'baStudioJdResult', 'baStudioJdConfidence', 'baStudioJdNotes', 'baStudioMockSession',
  'baStudioMockHistory',
]);

let pool;
export function db() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not configured');
  if (!pool) pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
  return pool;
}

export function json(res, status, body) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

export function readBody(req, limit = 256 * 1024) {
  const declaredLength = Number(req.headers['content-length'] || 0);
  if (declaredLength > limit) return Promise.reject(Object.assign(new Error('Request too large'), { status: 413 }));
  // Vercel's Node runtime lazily parses JSON requests into request.body.
  try {
    if (req.body !== undefined) {
      let body = req.body;
      if (Buffer.isBuffer(body) || typeof body === 'string') body = JSON.parse(body.toString());
      const serialized = JSON.stringify(body);
      if (serialized === undefined) throw new Error('Invalid JSON');
      if (Buffer.byteLength(serialized, 'utf8') > limit) throw Object.assign(new Error('Request too large'), { status: 413 });
      return Promise.resolve(body);
    }
  } catch (error) {
    return Promise.reject(error.status ? error : Object.assign(new Error('Invalid JSON'), { status: 400 }));
  }
  return new Promise((resolve, reject) => {
    let size = 0; let oversized = false; const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) { oversized = true; chunks.length = 0; return; }
      if (!oversized) chunks.push(chunk);
    });
    req.on('end', () => {
      if (oversized) { reject(Object.assign(new Error('Request too large'), { status: 413 })); return; }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(Object.assign(new Error('Invalid JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

export async function authorized(req, res, mutation = false) {
  const identity = await getIdentity(req);
  if (!identity) { json(res, 401, { error: 'unauthenticated' }); return null; }
  const allowed = String(process.env.GITHUB_ALLOWED_SUBJECT || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (!allowed.includes(String(identity.subject))) { json(res, 403, { error: 'forbidden' }); return null; }
  if (mutation && !requireCsrf(req, identity)) { json(res, 403, { error: 'csrf_failed' }); return null; }
  return identity;
}

export function validStore(key, value) {
  if (!STORE_KEYS.has(key)) return false;
  const serialized = JSON.stringify(value);
  if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > 65536) return false;
  if (key.startsWith('baNote')) return typeof value === 'string';
  if (['baRecent', 'baMockHistory', 'baFocusLog', 'baStudioRecent', 'baStudioMockHistory'].includes(key)) return Array.isArray(value);
  if (key === 'baStudioJdText') return typeof value === 'string';
  if (['baMockSession', 'baFocusSession', 'baStudioMockSession', 'baStudioJdChecklist'].includes(key)) return value === null || (typeof value === 'object' && !Array.isArray(value));
  if (key === 'baStudioJdResult') return value === null || Array.isArray(value);
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export async function userRow(client, identity) {
  const { rows } = await client.query(
    `INSERT INTO app_users (auth_provider, provider_subject) VALUES ('github', $1)
     ON CONFLICT (auth_provider, provider_subject) DO UPDATE SET updated_at = now()
     RETURNING id`, [String(identity.subject)],
  );
  return rows[0].id;
}
