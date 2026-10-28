import { getIdentity } from '../../server-lib/session.js';
import { json } from '../../server-lib/state.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return json(res, 405, { error: 'method_not_allowed' });
  const identity = await getIdentity(req);
  if (!identity) return json(res, 200, { authenticated: false });
  const allowed = String(process.env.GITHUB_ALLOWED_SUBJECT || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (!allowed.includes(String(identity.subject))) return json(res, 403, { error: 'forbidden' });
  json(res, 200, { authenticated: true, csrf: identity.csrf });
}
