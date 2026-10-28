import crypto from 'node:crypto';
import { COOKIE_NAMES, clearCookie, cookie, cookies, decode, seal, configuredAppUrl } from '../../server-lib/session.js';

export default async function handler(req, res) {
  const appUrl = configuredAppUrl();
  const expired = clearCookie(COOKIE_NAMES.OAUTH, !appUrl || appUrl.startsWith('https://'));
  const fail = (status, message) => { res.setHeader('Set-Cookie', expired); res.status(status).send(message); };
  if (!appUrl) return fail(503, 'Authentication is not configured.');
  if (req.method !== 'GET' || !req.query.code || !req.query.state) return fail(400, 'Sign-in could not be completed.');
  const oauth = decode(cookies(req)[COOKIE_NAMES.OAUTH]);
  const sentState = Buffer.from(String(req.query.state));
  if (!oauth || sentState.length !== Buffer.byteLength(String(oauth.state)) || !crypto.timingSafeEqual(Buffer.from(String(oauth.state)), sentState)) return fail(400, 'Sign-in could not be completed.');
  if (!process.env.GITHUB_CLIENT_ID || !process.env.GITHUB_CLIENT_SECRET || Buffer.byteLength(process.env.SESSION_SECRET || '') < 32) return fail(503, 'Authentication is not configured.');
  try {
    const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: process.env.GITHUB_CLIENT_ID, client_secret: process.env.GITHUB_CLIENT_SECRET, code: req.query.code, redirect_uri: `${appUrl}/api/auth/callback`, state: req.query.state, code_verifier: oauth.verifier }),
    });
    const token = await tokenResponse.json();
    if (!tokenResponse.ok || !token.access_token) return fail(401, 'Sign-in could not be completed.');
    const userResponse = await fetch('https://api.github.com/user', { headers: { Authorization: `Bearer ${token.access_token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'BA-Prep-Desk' } });
    const user = await userResponse.json();
    if (!userResponse.ok || !Number.isSafeInteger(user.id)) return fail(401, 'Sign-in could not be completed.');
    const allowed = String(process.env.GITHUB_ALLOWED_SUBJECT || '').split(',').map((x) => x.trim()).filter(Boolean);
    if (!allowed.includes(String(user.id))) return fail(403, 'This GitHub account is not authorized for this application.');
    const csrf = crypto.randomBytes(32).toString('base64url');
    res.setHeader('Set-Cookie', [expired, cookie(COOKIE_NAMES.SESSION, seal({ subject: String(user.id), csrf, exp: Date.now() + 604800000 }), 604800, appUrl.startsWith('https://'))]);
    res.status(302).setHeader('Location', '/').end();
  } catch { fail(502, 'Sign-in could not be completed.'); }
}
