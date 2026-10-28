import crypto from 'node:crypto';
import { COOKIE_NAMES, cookie, seal, configuredAppUrl } from '../../server-lib/session.js';

export default function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  const appUrl = configuredAppUrl();
  if (!process.env.GITHUB_CLIENT_ID || !appUrl || Buffer.byteLength(process.env.SESSION_SECRET || '') < 32) return res.status(503).end('Authentication is not configured.');
  const state = crypto.randomBytes(32).toString('base64url');
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  res.setHeader('Set-Cookie', cookie(COOKIE_NAMES.OAUTH, seal({ state, verifier, exp: Date.now() + 600000 }), 600, appUrl.startsWith('https://')));
  const target = new URL('https://github.com/login/oauth/authorize');
  target.searchParams.set('client_id', process.env.GITHUB_CLIENT_ID);
  target.searchParams.set('redirect_uri', `${appUrl}/api/auth/callback`);
  target.searchParams.set('scope', 'read:user');
  target.searchParams.set('state', state);
  target.searchParams.set('code_challenge', challenge);
  target.searchParams.set('code_challenge_method', 'S256');
  res.status(302).setHeader('Location', target.toString()).end();
}
