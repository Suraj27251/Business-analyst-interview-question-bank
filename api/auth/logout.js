import { clearCookie, getIdentity, requireCsrf, COOKIE_NAMES } from '../../server-lib/session.js';
import { json } from '../../server-lib/state.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
  const identity = await getIdentity(req);
  if (!identity) return json(res, 401, { error: 'unauthenticated' });
  if (!requireCsrf(req, identity)) return json(res, 403, { error: 'csrf_failed' });
  const secure = (req.headers['x-forwarded-proto'] || 'https') === 'https';
  res.setHeader('Set-Cookie', clearCookie(COOKIE_NAMES.SESSION, secure));
  json(res, 200, { ok: true });
}
