import test from 'node:test';
import assert from 'node:assert/strict';
import { readBody, STORE_KEYS, validStore } from '../server-lib/state.js';
import { PassThrough } from 'node:stream';

const required = [
  'baDays', 'baTaskChecks', ...Array.from({ length: 15 }, (_, i) => `baNote${i + 1}`),
  'baPracticedQuestions', 'baQuestionRatings', 'baSavedQuestions', 'baQuestionAnswers',
  'baRecent', 'baSources', 'baMockSession', 'baMockHistory', 'baFocusSession', 'baFocusLog',
  'baStudioRecent', 'baStudioCaseResponses', 'baStudioJdText', 'baStudioJdChecklist',
  'baStudioJdResult', 'baStudioJdConfidence', 'baStudioJdNotes', 'baStudioMockSession', 'baStudioMockHistory',
];

test('the server allowlist accounts for every discovered progress key', () => {
  for (const key of required) assert.ok(STORE_KEYS.has(key), `Missing store key: ${key}`);
  assert.equal(STORE_KEYS.size, required.length);
  assert.ok(!STORE_KEYS.has('PREP_DATA'));
  assert.ok(!STORE_KEYS.has('STUDIO_INDEX'));
});

test('dynamic note stores preserve their legacy plain string format', () => {
  assert.ok(validStore('baNote1', 'true is a note, not a boolean'));
  assert.ok(validStore('baNote15', 'last note'));
  assert.ok(!validStore('baNote0', 'out of range'));
  assert.ok(!validStore('baNote3', { text: 'wrong format' }));
});

test('legacy rating values and metadata objects remain accepted', () => {
  assert.ok(validStore('baQuestionRatings', { 'q::1': 'know' }));
  assert.ok(validStore('baQuestionRatings', { 'q::1': { rating: 'review', intervalDays: 2, lastRated: '2026-10-20', sourcePath: 'book.pdf', metadata: { old: true } } }));
  assert.ok(validStore('baSavedQuestions', { 'q::1': true }));
  assert.ok(validStore('baSavedQuestions', { 'q::1': { id: 'q::1', savedAt: 123, question: 'Prompt' } }));
});

test('array history stores and nullable active sessions retain their native types', () => {
  for (const key of ['baRecent', 'baMockHistory', 'baFocusLog', 'baStudioRecent', 'baStudioMockHistory']) assert.ok(validStore(key, []));
  for (const key of ['baMockSession', 'baFocusSession', 'baStudioMockSession']) assert.ok(validStore(key, null));
  assert.ok(!validStore('baMockHistory', {}));
});

test('unknown keys and oversized records are rejected', () => {
  assert.ok(!validStore('baSourcesCache', {}));
  assert.ok(!validStore('baQuestionAnswers', 'x'.repeat(70000)));
  assert.ok(!validStore('baQuestionAnswers', undefined));
});

test('request parsing supports Vercel parsed bodies and enforces the byte limit', async () => {
  assert.deepEqual(await readBody({ headers: {}, body: { revision: 2 } }), { revision: 2 });
  const request = new PassThrough(); request.headers = { 'content-length': '10' };
  const pending = readBody(request, 5); request.end('1234567890');
  await assert.rejects(pending, (error) => error.status === 413);
});
