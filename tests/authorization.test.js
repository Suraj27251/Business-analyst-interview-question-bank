import test from 'node:test';
import assert from 'node:assert/strict';
import { authorized } from '../server-lib/state.js';
import { COOKIE_NAMES, seal } from '../server-lib/session.js';

const originalSecret = process.env.SESSION_SECRET;
const originalAllowlist = process.env.GITHUB_ALLOWED_SUBJECT;
const originalAppUrl = process.env.APP_URL;
process.env.SESSION_SECRET = 'authorization-test-secret-with-at-least-32-bytes';
process.env.GITHUB_ALLOWED_SUBJECT = '1234567';
process.env.APP_URL = 'https://prep.example';

function responseCapture() {
  return { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, setHeader() { return this; }, end(body) { this.body = body; } };
}
function requestFor(subject, extra = {}) {
  const token = seal({ subject, csrf: 'csrf-1', exp: Date.now() + 60000 });
  return { headers: { cookie: `${COOKIE_NAMES.SESSION}=${token}` }, query: {}, ...extra };
}

test('unauthenticated callers receive 401', async () => {
  const res = responseCapture();
  assert.equal(await authorized({ headers: {} }, res), null);
  assert.equal(res.statusCode, 401);
});

test('allowlisted provider subject is accepted, while another subject receives 403', async () => {
  const accepted = await authorized(requestFor('1234567'), responseCapture());
  assert.equal(accepted.subject, '1234567');
  const res = responseCapture();
  assert.equal(await authorized(requestFor('9999999'), res), null);
  assert.equal(res.statusCode, 403);
});

test('a client-supplied user ID cannot change the signed provider identity', async () => {
  const req = requestFor('1234567', { query: { userId: '9999999' }, body: { userId: '9999999' } });
  const accepted = await authorized(req, responseCapture());
  assert.equal(accepted.subject, '1234567');
  assert.equal(accepted.userId, undefined);
});

test('state-changing requests require CSRF and same-origin headers', async () => {
  const res = responseCapture();
  assert.equal(await authorized(requestFor('1234567'), res, true), null);
  assert.equal(res.statusCode, 403);
  const req = requestFor('1234567', { headers: { cookie: requestFor('1234567').headers.cookie, origin: 'https://prep.example', host: 'prep.example', 'x-csrf-token': 'csrf-1' } });
  assert.equal((await authorized(req, responseCapture(), true)).subject, '1234567');
});

test.after(() => {
  if (originalSecret === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = originalSecret;
  if (originalAllowlist === undefined) delete process.env.GITHUB_ALLOWED_SUBJECT; else process.env.GITHUB_ALLOWED_SUBJECT = originalAllowlist;
  if (originalAppUrl === undefined) delete process.env.APP_URL; else process.env.APP_URL = originalAppUrl;
});
