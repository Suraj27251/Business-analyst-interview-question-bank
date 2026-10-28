import test from 'node:test';
import assert from 'node:assert/strict';
import { COOKIE_NAMES, configuredAppUrl, getIdentity, requireCsrf, seal } from '../server-lib/session.js';

const originalSecret = process.env.SESSION_SECRET;
const originalAppUrl = process.env.APP_URL;
process.env.SESSION_SECRET = 'test-secret-that-is-long-enough-for-session-signing';
process.env.APP_URL = 'https://prep.example';

test('sessions bind a signed provider subject and ignore client user IDs', async () => {
  const token = seal({ subject: '1234567', csrf: 'token-a', exp: Date.now() + 60000 });
  const identity = await getIdentity({ headers: { cookie: `${COOKIE_NAMES.SESSION}=${token}` }, query: { userId: 'forged-user' } });
  assert.equal(identity.subject, '1234567');
  assert.equal(identity.userId, undefined);
});

test('expired and tampered sessions are rejected', async () => {
  const expired = seal({ subject: '1234567', csrf: 'token-a', exp: Date.now() - 1000 });
  const tampered = expired.slice(0, -1) + (expired.endsWith('a') ? 'b' : 'a');
  assert.equal(await getIdentity({ headers: { cookie: `${COOKIE_NAMES.SESSION}=${expired}` } }), null);
  assert.equal(await getIdentity({ headers: { cookie: `${COOKIE_NAMES.SESSION}=${tampered}` } }), null);
});

test('mutations require a matching same-origin CSRF token', () => {
  const identity = { csrf: 'expected' };
  assert.ok(requireCsrf({ headers: { origin: 'https://prep.example', host: 'prep.example', 'x-csrf-token': 'expected' } }, identity));
  assert.ok(!requireCsrf({ headers: { origin: 'https://attacker.example', host: 'prep.example', 'x-csrf-token': 'expected' } }, identity));
  assert.ok(!requireCsrf({ headers: { origin: 'https://prep.example', host: 'prep.example' } }, identity));
});

test('application origin must be explicit, canonical, and secure outside localhost', () => {
  assert.equal(configuredAppUrl(), 'https://prep.example');
  process.env.APP_URL = 'https://prep.example/path';
  assert.equal(configuredAppUrl(), null);
  process.env.APP_URL = 'http://prep.example';
  assert.equal(configuredAppUrl(), null);
  process.env.APP_URL = 'http://localhost:3000';
  assert.equal(configuredAppUrl(), 'http://localhost:3000');
  process.env.APP_URL = 'https://prep.example';
});

test.after(() => {
  if (originalSecret === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = originalSecret;
  if (originalAppUrl === undefined) delete process.env.APP_URL; else process.env.APP_URL = originalAppUrl;
});
