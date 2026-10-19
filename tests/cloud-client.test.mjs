import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

// Loads cloud-sync.js in a VM with a fake localStorage so the pure
// snapshot/diff logic can be tested without a browser or network.
const __dirname = dirname(fileURLToPath(import.meta.url));

function loadClient() {
  const storage = new Map();
  const raw = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
    clear: () => storage.clear(),
    key: (index) => Array.from(storage.keys())[index] || null,
    get length() {
      return storage.size;
    },
  };
  const sandbox = {
    window: { localStorage: raw },
    document: { cookie: '' },
    console,
    setTimeout,
    clearTimeout,
    Date,
    JSON,
    Map,
    Set,
    Number,
    String,
    Object,
    Array,
    Promise,
    Math,
    RegExp,
    decodeURIComponent,
    encodeURIComponent,
    fetch: () => Promise.reject(new Error('network disabled in tests')),
  };
  sandbox.window.window = sandbox.window;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(join(__dirname, '..', 'cloud-sync.js'), 'utf8'), sandbox);
  return { client: sandbox.window.PrepCloud, storage };
}

function seedLocal(client) {
  const store = client.store;
  store.baQuestionRatings = JSON.stringify({
    'a.pdf::1': {
      rating: 'know',
      lastRated: '2026-10-01',
      dueDate: '2026-10-08',
      intervalDays: 7,
      question: 'Question one?',
      sourceName: 'a.pdf',
      sourcePath: 'a.pdf',
    },
  });
  store.baPracticedQuestions = JSON.stringify({ 'a.pdf::1': true, 'b.pdf::2': true });
  store.baQuestionAnswers = JSON.stringify({ 'a.pdf::1': 'My answer' });
  store.baSavedQuestions = JSON.stringify({
    'a.pdf::1': { id: 'a.pdf::1', question: 'Question one?', path: 'a.pdf', name: 'a.pdf', sourceIndex: 1, savedAt: 1700000000000 },
  });
  store.baDays = JSON.stringify({ 1: true });
  store.baTaskChecks = JSON.stringify({ '1:2-1': true });
  store.baNote1 = 'A note';
  store.baSources = JSON.stringify({ 'a.pdf': true });
  store.baMockHistory = JSON.stringify([
    { finishedAt: 1700000000000, answered: 2, total: 3, durationMinutes: 10, questions: [], responses: [] },
  ]);
  store.baFocusLog = JSON.stringify([
    { date: '2026-10-19', minutes: 25, day: 1, completed: true, endedAt: 1700000001000 },
  ]);
  store.baRecent = JSON.stringify(['a.pdf']);
  store.baFocusSession = JSON.stringify({
    running: true,
    startedAt: 1700000002000,
    endsAt: 1700001502000,
    durationMinutes: 25,
    day: 1,
    remainingMs: 0,
  });
}

test('buildFullPayload maps every local key to the API shape', () => {
  const { client } = loadClient();
  seedLocal(client);
  const payload = client._internal.buildFullPayload();

  assert.equal(payload.strategy, 'merge');
  assert.equal(payload.questionProgress.length, 2);
  const question = payload.questionProgress.find((record) => record.questionId === 'a.pdf::1');
  assert.equal(question.answer, 'My answer');
  assert.equal(question.rating, 'know');
  assert.equal(question.sourcePath, 'a.pdf');
  assert.equal(question.sourceIndex, 1);
  assert.equal(question.updatedAt > 0, true);

  assert.equal(payload.savedQuestions[0].sourcePath, 'a.pdf');
  assert.equal(payload.roadmapDays[0].note, 'A note');
  assert.equal(payload.roadmapTasks[0].taskId, '2-1');
  assert.deepEqual(
    JSON.parse(JSON.stringify(payload.sourceCoverage)),
    [{ sourcePath: 'a.pdf', reviewed: true, updatedAt: payload.sourceCoverage[0].updatedAt }]
  );
  assert.equal(payload.mockSessions[0].clientId, '1700000000000');
  assert.equal(payload.focusSessions[0].clientId, '1700000001000');
  assert.deepEqual(JSON.parse(JSON.stringify(payload.preferences.recent)), ['a.pdf']);
  assert.equal(payload.preferences.activeFocus.startedAt, 1700000002000);
});

test('applySnapshot replaces local state and removes stale notes', () => {
  const { client, storage } = loadClient();
  seedLocal(client);

  client._internal.applySnapshot({
    questionProgress: [
      {
        questionId: 'c.pdf::0',
        practiced: true,
        answer: 'New answer',
        rating: 'review',
        dueDate: '2026-10-20',
        intervalDays: 2,
        question: 'New question?',
        sourceName: 'c.pdf',
        sourcePath: 'c.pdf',
      },
    ],
    savedQuestions: [],
    roadmap: { days: [{ day: 2, completed: true, note: null }], tasks: [] },
    sourceCoverage: [],
    mockInterviews: [],
    focusSessions: [],
    preferences: { recent: [] },
  });

  assert.deepEqual(JSON.parse(storage.get('baQuestionAnswers')), { 'c.pdf::0': 'New answer' });
  assert.equal(JSON.parse(storage.get('baPracticedQuestions'))['a.pdf::1'], undefined);
  assert.equal(JSON.parse(storage.get('baQuestionRatings'))['c.pdf::0'].rating, 'review');
  assert.equal(storage.get('baNote1') ?? null, null, 'note deleted in the cloud is removed locally');
  assert.equal(JSON.parse(storage.get('baDays'))['2'], true);
  assert.deepEqual(JSON.parse(storage.get('baSavedQuestions')), {});
  assert.deepEqual(JSON.parse(storage.get('baRecent')), []);
});

test('deleting and re-adding a saved question clears the pending removal', () => {
  const { client, storage } = loadClient();
  seedLocal(client);

  client.store.baSavedQuestions = JSON.stringify({});
  assert.deepEqual(JSON.parse(storage.get('__prep_removals')).baSavedQuestions, ['a.pdf::1']);

  client.store.baSavedQuestions = JSON.stringify({
    'a.pdf::1': { id: 'a.pdf::1', question: 'Question one?', path: 'a.pdf', name: 'a.pdf', sourceIndex: 1, savedAt: 1700000000000 },
  });
  const removals = JSON.parse(storage.get('__prep_removals') || '{}');
  assert.equal(removals.baSavedQuestions, undefined, 're-added question is no longer queued for deletion');
});

test('focus timer ticks do not queue a cloud write', () => {
  const { client, storage } = loadClient();
  client.store.baFocusSession = JSON.stringify({
    running: true,
    startedAt: 1700000002000,
    endsAt: 1700001502000,
    durationMinutes: 25,
    day: 1,
    remainingMs: 1000,
  });
  const first = storage.get('__prep_ts');
  client.store.baFocusSession = JSON.stringify({
    running: true,
    startedAt: 1700000002000,
    endsAt: 1700001502000,
    durationMinutes: 25,
    day: 1,
    remainingMs: 500,
  });
  assert.equal(storage.get('__prep_ts'), first, 'timer tick did not change sync timestamps');

  client.store.baFocusSession = JSON.stringify({
    running: false,
    startedAt: 1700000002000,
    endsAt: 1700001502000,
    durationMinutes: 25,
    day: 1,
    remainingMs: 500,
  });
  assert.equal(storage.get('__prep_ts'), first, 'singletons do not use per-record timestamps');
});
