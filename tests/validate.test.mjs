import test from 'node:test';
import assert from 'node:assert/strict';
import validate from '../lib/validate.js';

const {
  normalizeEmail,
  isValidEmail,
  validatePassword,
  normalizeQuestionProgress,
  normalizeSavedQuestion,
  normalizeSourceCoverage,
  normalizeFocusSession,
  normalizeImportPayload,
  ValidationError,
} = validate;

test('normalizeEmail trims and lowercases valid addresses', () => {
  assert.equal(normalizeEmail('  User@Example.COM '), 'user@example.com');
});

test('isValidEmail rejects malformed addresses', () => {
  for (const value of ['', 'nope', 'a@b', 'a b@c.com', null, 42]) {
    assert.equal(isValidEmail(value), false);
  }
});

test('validatePassword enforces length bounds', () => {
  assert.throws(() => validatePassword('short'), ValidationError);
  assert.throws(() => validatePassword('x'.repeat(201)), ValidationError);
  assert.equal(validatePassword('longenough'), 'longenough');
});

test('normalizeQuestionProgress keeps only supported fields and validates the rating enum', () => {
  const record = normalizeQuestionProgress({
    questionId: 'folder/file.pdf::3',
    sourcePath: 'folder/file.pdf',
    sourceIndex: '3',
    practiced: 'true',
    answer: 'An answer',
    rating: 'review',
    lastRated: '2026-10-01',
    dueDate: '2026-10-03',
    intervalDays: 2,
    question: 'What is a BA?',
    sourceName: 'file.pdf',
    updatedAt: '1767225600000',
    ignored: 'drop me',
  });
  assert.equal(record.questionId, 'folder/file.pdf::3');
  assert.equal(record.sourceIndex, 3);
  assert.equal(record.practiced, true);
  assert.equal(record.rating, 'review');
  assert.equal(record.nextReviewDue, '2026-10-03');
  assert.equal(record.reviewIntervalDays, 2);
  assert.equal(record.updatedAt, 1767225600000);
  assert.equal('ignored' in record, false);
});

test('normalizeQuestionProgress rejects invalid ratings and malformed dates', () => {
  assert.throws(() => normalizeQuestionProgress({ questionId: 'a', rating: 'expert' }), ValidationError);
  assert.throws(() => normalizeQuestionProgress({ questionId: 'a', dueDate: '10/03/2026' }), ValidationError);
  assert.throws(() => normalizeQuestionProgress({ questionId: 'a', practiced: 'yes' }), ValidationError);
  assert.throws(() => normalizeQuestionProgress({ questionId: '' }), ValidationError);
});

test('normalizeQuestionProgress defaults practiced to true when omitted', () => {
  assert.equal(normalizeQuestionProgress({ questionId: 'q1', answer: 'x' }).practiced, true);
});

test('normalizeSavedQuestion accepts legacy browser field names', () => {
  const record = normalizeSavedQuestion({
    id: 'p::1',
    question: 'Why?',
    path: 'p.pdf',
    name: 'p.pdf',
    sourceIndex: 1,
    savedAt: 1700000000000,
  });
  assert.equal(record.questionId, 'p::1');
  assert.equal(record.sourcePath, 'p.pdf');
  assert.equal(record.savedAt, 1700000000000);
});

test('oversized strings are rejected', () => {
  assert.throws(
    () => normalizeQuestionProgress({ questionId: 'q', answer: 'x'.repeat(20001) }),
    ValidationError
  );
});

test('normalizeSourceCoverage and normalizeFocusSession validate enums/ids', () => {
  assert.deepEqual(normalizeSourceCoverage({ sourcePath: 'a.pdf', reviewed: true }), {
    sourcePath: 'a.pdf',
    reviewed: true,
    updatedAt: 0,
  });
  const focus = normalizeFocusSession({
    clientId: '1700000000000',
    date: '2026-10-19',
    minutes: 25,
    day: 3,
    completed: true,
    endedAt: 1700000000000,
  });
  assert.equal(focus.sessionDate, '2026-10-19');
  assert.equal(focus.minutes, 25);
  assert.equal(focus.roadmapDay, 3);
});

test('normalizeImportPayload defaults to merge and is idempotent', () => {
  const input = {
    questionProgress: [{ questionId: 'q1', rating: 'know', updatedAt: 10 }],
    savedQuestions: [{ questionId: 'q1' }],
    roadmapDays: [{ day: 1, completed: true }],
    roadmapTasks: [{ day: 1, taskId: '2-1', completed: true }],
    sourceCoverage: [{ sourcePath: 'a.pdf', reviewed: true }],
    mockSessions: [{ clientId: '123', payload: { responses: ['hi'] } }],
    focusSessions: [{ clientId: '456', minutes: 25, completed: true }],
    preferences: { recent: ['a.pdf'] },
  };
  const first = normalizeImportPayload(input);
  const second = normalizeImportPayload(JSON.parse(JSON.stringify(first)));
  assert.equal(first.strategy, 'merge');
  assert.deepEqual(first, second);
  assert.equal(first.questionProgress.length, 1);
  assert.equal(first.roadmapTasks[0].taskId, '2-1');
});

test('normalizeImportPayload rejects non-object entries and unknown large payloads', () => {
  assert.throws(() => normalizeImportPayload({ questionProgress: ['not-an-object'] }), ValidationError);
  assert.throws(() => normalizeImportPayload({ questionProgress: null, savedQuestions: 'x' }), ValidationError);
});
