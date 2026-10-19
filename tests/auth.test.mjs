import test from 'node:test';
import assert from 'node:assert/strict';
import auth from '../lib/auth.js';

const { hashPassword, verifyPassword, sha256, timingSafeEqual, sessionTtlSeconds } = auth;

test('password hashing verifies only the correct password', async () => {
  const hash = await hashPassword('correct horse battery staple');
  assert.equal(await verifyPassword('correct horse battery staple', hash), true);
  assert.equal(await verifyPassword('wrong password', hash), false);
  assert.notEqual(hash, 'correct horse battery staple');
});

test('session tokens are hashed with SHA-256, never stored raw', () => {
  const token = 'opaque-token-value';
  const hash = sha256(token);
  assert.equal(hash.length, 64);
  assert.notEqual(hash, token);
  assert.equal(sha256(token), hash);
});

test('timingSafeEqual compares equal-length values safely', () => {
  assert.equal(timingSafeEqual('abc', 'abc'), true);
  assert.equal(timingSafeEqual('abc', 'abd'), false);
  assert.equal(timingSafeEqual('abc', 'abcd'), false);
});

test('session TTL falls back to 30 days and honors SESSION_TTL_SECONDS', () => {
  const previous = process.env.SESSION_TTL_SECONDS;
  delete process.env.SESSION_TTL_SECONDS;
  assert.equal(sessionTtlSeconds(), 60 * 60 * 24 * 30);
  process.env.SESSION_TTL_SECONDS = '3600';
  assert.equal(sessionTtlSeconds(), 3600);
  process.env.SESSION_TTL_SECONDS = 'not-a-number';
  assert.equal(sessionTtlSeconds(), 60 * 60 * 24 * 30);
  if (previous === undefined) delete process.env.SESSION_TTL_SECONDS;
  else process.env.SESSION_TTL_SECONDS = previous;
});
