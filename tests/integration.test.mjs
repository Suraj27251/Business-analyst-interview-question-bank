import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import db from '../lib/db.js';
import repo from '../lib/repository.js';

const testUrl = process.env.TEST_DATABASE_URL;

// Real-database coverage. Skipped unless TEST_DATABASE_URL points at a
// disposable Neon/Postgres database that has had `npm run migrate` applied.
// Only rows created by this test (unique @example.invalid users) are touched,
// and they are deleted in the finally block.
test(
  'integration: per-user isolation, last-write-wins and idempotent import',
  { skip: testUrl ? false : 'TEST_DATABASE_URL is not set' },
  async (t) => {
    process.env.DATABASE_URL = testUrl;
    db.resetForTests();
    const sql = db.getSql();

    const schema = await sql.query("select to_regclass('public.question_progress') as table_name");
    if (!schema[0] || !schema[0].table_name) {
      t.skip('Run `npm run migrate` against TEST_DATABASE_URL first.');
      return;
    }

    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const userA = randomUUID();
    const userB = randomUUID();

    try {
      for (const [index, id] of [userA, userB].entries()) {
        await sql.query('insert into users (id, email, password_hash) values ($1, $2, $3)', [
          id,
          `prep-test-${suffix}-${index}@example.invalid`,
          'not-a-real-hash',
        ]);
      }

      await repo.upsertQuestionProgress(userA, [
        { questionId: 'q-a', practiced: true, rating: 'know', updatedAt: 1000 },
      ]);
      await repo.upsertQuestionProgress(userB, [
        { questionId: 'q-b', practiced: true, updatedAt: 1000 },
      ]);

      const a = await repo.getFullProgress(userA);
      const b = await repo.getFullProgress(userB);
      assert.equal(a.questionProgress.length, 1);
      assert.equal(a.questionProgress[0].questionId, 'q-a');
      assert.equal(b.questionProgress.length, 1);
      assert.equal(b.questionProgress[0].questionId, 'q-b');

      // An older write must not overwrite newer cloud data.
      await repo.upsertQuestionProgress(userA, [
        { questionId: 'q-a', practiced: false, updatedAt: 999 },
      ]);
      const afterStale = await repo.getFullProgress(userA);
      assert.equal(afterStale.questionProgress[0].practiced, true);

      const payload = {
        strategy: 'merge',
        questionProgress: [{ questionId: 'q-a', practiced: true, rating: 'know', updatedAt: 2000 }],
        savedQuestions: [{ questionId: 'q-a', savedAt: 1700000000000 }],
        roadmapDays: [{ day: 1, completed: true, note: 'note' }],
        roadmapTasks: [{ day: 1, taskId: 'task-1', completed: true }],
        sourceCoverage: [{ sourcePath: 'a.pdf', reviewed: true }],
        mockSessions: [],
        focusSessions: [],
        preferences: { recent: ['a.pdf'] },
      };

      // Applying the same snapshot twice must not duplicate rows.
      await repo.applyImport(userA, payload);
      await repo.applyImport(userA, payload);

      const counts = await sql.query(
        `select
           (select count(*) from saved_questions where user_id = $1) as saved,
           (select count(*) from roadmap_tasks where user_id = $1) as tasks,
           (select count(*) from roadmap_days where user_id = $1) as days,
           (select count(*) from source_coverage where user_id = $1) as sources`,
        [userA]
      );
      assert.equal(Number(counts[0].saved), 1);
      assert.equal(Number(counts[0].tasks), 1);
      assert.equal(Number(counts[0].days), 1);
      assert.equal(Number(counts[0].sources), 1);

      const imported = await repo.getFullProgress(userA);
      assert.equal(imported.savedQuestions[0].savedAt, 1700000000000);
      assert.equal(imported.roadmap.days[0].note, 'note');
      assert.deepEqual(imported.preferences.recent, ['a.pdf']);
    } finally {
      for (const id of [userA, userB]) {
        await sql.query('delete from users where id = $1', [id]);
      }
      db.resetForTests();
    }
  }
);
