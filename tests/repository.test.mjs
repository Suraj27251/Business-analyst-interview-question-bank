import test, { beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import db from '../lib/db.js';
import repo from '../lib/repository.js';

// A fake Neon-style `sql` (callable as a tagged template with .query) so the
// data-access code can be exercised without a live database. It records the
// static SQL and the bound parameter values, letting us assert parameterization
// and the timestamp guard without inspecting internals.
function makeFake() {
  const calls = [];
  const tag = (strings, ...values) => {
    calls.push({ kind: 'tag', text: strings.join('$?'), values });
    return Promise.resolve([{ question_id: 'q', client_id: 'c', day: 1, source_path: 'p', task_id: 't' }]);
  };
  tag.query = (text, params) => {
    calls.push({ kind: 'query', text, params });
    if (text.includes('from question_progress')) {
      return Promise.resolve([
        {
          question_id: 'p.pdf::2',
          source_path: 'p.pdf',
          source_index: 2,
          practiced: true,
          answer: 'answer',
          rating: 'know',
          last_rated: '2026-10-01',
          next_review_due: '2026-10-08',
          review_interval_days: 7,
          question_text: 'Question?',
          source_name: 'p.pdf',
          updated_at_ms: '1234',
        },
      ]);
    }
    if (text.includes('from saved_questions')) {
      return Promise.resolve([
        {
          question_id: 'p.pdf::2',
          question_text: 'Question?',
          source_path: 'p.pdf',
          source_name: 'p.pdf',
          source_index: 2,
          saved_at_ms: '1700000000000',
          updated_at_ms: '99',
        },
      ]);
    }
    if (text.includes('from mock_sessions')) {
      return Promise.resolve([
        {
          client_id: '1700000000000',
          started_at_ms: null,
          finished_at_ms: '1700000060000',
          duration_minutes: 30,
          answered: 3,
          total: 5,
          payload: { responses: ['a'] },
          updated_at_ms: '42',
        },
      ]);
    }
    if (text.includes('from focus_sessions')) {
      return Promise.resolve([
        {
          client_id: '1700000000001',
          session_date: '2026-10-19',
          minutes: 25,
          roadmap_day: 3,
          completed: true,
          ended_at_ms: '1700000000001',
          updated_at_ms: '7',
        },
      ]);
    }
    if (text.includes('from user_preferences')) {
      return Promise.resolve([{ recent: ['p.pdf'], active_focus: null, active_mock: null, settings: {} }]);
    }
    if (text.includes('from roadmap_days')) {
      return Promise.resolve([{ day: 1, completed: true, note: 'note', updated_at_ms: '5' }]);
    }
    if (text.includes('from roadmap_tasks')) {
      return Promise.resolve([{ day: 1, task_id: '2-1', completed: true, updated_at_ms: '6' }]);
    }
    if (text.includes('from source_coverage')) {
      return Promise.resolve([{ source_path: 'p.pdf', reviewed: true, updated_at_ms: '8' }]);
    }
    return Promise.resolve([]);
  };
  tag.unsafe = () => Promise.resolve([]);
  tag.transaction = (queries) => Promise.all(queries);
  return { tag, calls };
}

beforeEach(() => db.resetForTests());
after(() => db.resetForTests());

test('upsertQuestionProgress binds the server userId and uses the timestamp guard', async () => {
  const fake = makeFake();
  db.setSqlForTests(fake.tag);
  const applied = await repo.upsertQuestionProgress('user-1', [
    {
      questionId: 'p::0',
      sourcePath: 'p',
      sourceIndex: 0,
      practiced: true,
      answer: 'a',
      rating: 'know',
      lastRated: '2026-10-01',
      nextReviewDue: '2026-10-08',
      reviewIntervalDays: 7,
      questionText: 'Q?',
      sourceName: 'p',
      updatedAt: 1700000000000,
    },
  ]);
  assert.equal(applied, 1);
  const call = fake.calls.find((c) => c.kind === 'tag');
  assert.ok(call.text.includes('on conflict (user_id, question_id) do update'));
  assert.ok(call.text.includes('where excluded.updated_at_ms >= question_progress.updated_at_ms'));
  assert.equal(call.values[0], 'user-1');
  assert.deepEqual(call.values[1], ['p::0']);
  // Timestamp is sent as text and cast in SQL.
  assert.equal(call.values[call.values.length - 1][0], '1700000000000');
});

test('a user id in a record cannot override the authenticated user', async () => {
  const fake = makeFake();
  db.setSqlForTests(fake.tag);
  await repo.upsertQuestionProgress('real-user', [
    { questionId: 'q', practiced: true, updatedAt: 1, userId: 'attacker' },
  ]);
  const call = fake.calls.find((c) => c.kind === 'tag');
  assert.equal(call.values[0], 'real-user');
  assert.ok(!JSON.stringify(call.values).includes('attacker'));
});

test('saved question removals are parameterized with the authenticated user', async () => {
  const fake = makeFake();
  db.setSqlForTests(fake.tag);
  await repo.upsertSavedQuestions('user-2', [], ['q1', 'q2']);
  const del = fake.calls.find((c) => c.kind === 'tag' && c.text.includes('delete from saved_questions'));
  assert.ok(del, 'delete query was issued');
  assert.equal(del.values[0], 'user-2');
  assert.deepEqual(del.values[1], ['q1', 'q2']);
});

test('getFullProgress maps database rows to client field names', async () => {
  const fake = makeFake();
  db.setSqlForTests(fake.tag);
  const progress = await repo.getFullProgress('user-3');
  assert.equal(progress.questionProgress[0].dueDate, '2026-10-08');
  assert.equal(progress.questionProgress[0].updatedAt, 1234);
  assert.equal(progress.savedQuestions[0].savedAt, 1700000000000);
  assert.equal(progress.mockInterviews[0].finishedAt, 1700000060000);
  assert.equal(progress.focusSessions[0].date, '2026-10-19');
  assert.deepEqual(progress.preferences.recent, ['p.pdf']);
});

test('every read query is scoped with a user_id parameter', async () => {
  const fake = makeFake();
  db.setSqlForTests(fake.tag);
  await repo.getFullProgress('user-4');
  const reads = fake.calls.filter((c) => c.kind === 'query');
  assert.ok(reads.length >= 8);
  for (const call of reads) {
    assert.deepEqual(call.params, ['user-4']);
    assert.ok(call.text.includes('user_id = $1'));
  }
});

test('applyImport replace clears progress before applying the snapshot', async () => {
  const fake = makeFake();
  db.setSqlForTests(fake.tag);
  const result = await repo.applyImport('user-5', {
    strategy: 'replace',
    questionProgress: [{ questionId: 'q', practiced: true }],
    savedQuestions: [],
    roadmapDays: [],
    roadmapTasks: [],
    sourceCoverage: [],
    mockSessions: [],
    focusSessions: [],
    preferences: {},
  });
  assert.ok(fake.calls[0].text.includes('delete from question_progress'));
  assert.equal(fake.calls[0].params[0], 'user-5');
  assert.equal(result.counts.imported, 1);
});
