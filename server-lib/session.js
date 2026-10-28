import crypto from 'node:crypto';

const SESSION = 'ba_session';
const OAUTH = 'ba_oauth_state';
const secret = () => process.env.SESSION_SECRET || '';
const sign = (data) => crypto.createHmac('sha256', secret()).update(data).digest('base64url');
const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
function decode(token) {
  if (Buffer.byteLength(secret()) < 32 || !token) return null;
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return null;
  const expected = sign(payload);
  if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  try { const value = JSON.parse(Buffer.from(payload, 'base64url').toString()); return value.exp > Date.now() ? value : null; }
  catch { return null; }
}
export function seal(value) { const payload = encode(value); return `${payload}.${sign(payload)}`; }
export function cookie(name, value, maxAge, secure = true) {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}
export function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map((part) => part.trim().split(/=(.*)/s).slice(0, 2)).filter((x) => x.length === 2));
}
export function clearCookie(name, secure = true) { return `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`; }
export function configuredAppUrl() {
  const value = process.env.APP_URL;
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.origin !== value || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) return null;
    return value;
  } catch { return null; }
}
export async function getIdentity(req) {
  const token = cookies(req)[SESSION];
  const session = decode(token);
  if (!session || !session.subject || !session.csrf) return null;
  return session;
}
export function requireCsrf(req, session) {
  const origin = req.headers.origin;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const appUrl = configuredAppUrl();
  return Boolean(appUrl && origin === appUrl && host && origin === `${proto}://${host}` && req.headers['x-csrf-token'] === session.csrf);
}
export const COOKIE_NAMES = { SESSION, OAUTH };
export { decode };
