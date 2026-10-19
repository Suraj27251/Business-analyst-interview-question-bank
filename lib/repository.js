'use strict';

// Data access layer. Every function is scoped to a single authenticated userId,
// which is always supplied by the server from the verified session - never from
// the request body. All writes are idempotent upserts guarded by an
// `updated_at_ms` last-write-wins check so an older client can never clobber
// newer cloud data.

const { getSql } = require('./db');

function s(value) {
  return value === undefined || value === null ? null : String(value);
}

function stamp(value) {
  return String(Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);
}

// --- B. Question progress --------------------------------------------------

async function upsertQuestionProgress(userId, records) {
  if (!records.length) return 0;
  const sql = getSql();
  const rows = await sql`
    insert into question_progress (
      user_id, question_id, source_path, source_index, practiced, answer, rating,
      last_rated, next_review_due, review_interval_days, question_text, source_name, updated_at_ms
    )
    select
      ${userId}::uuid,
      t.question_id,
      t.source_path,
      t.source_index::int,
      t.practiced::boolean,
      t.answer,
      t.rating,
      t.last_rated::date,
      t.next_review_due::date,
      t.review_interval_days::int,
      t.question_text,
      t.source_name,
      t.updated_at_ms::bigint
    from unnest(
      ${records.map((r) => r.questionId)}::text[],
      ${records.map((r) => s(r.sourcePath))}::text[],
      ${records.map((r) => (r.sourceIndex === null ? null : String(r.sourceIndex)))}::text[],
      ${records.map((r) => (r.practiced ? 'true' : 'false'))}::text[],
      ${records.map((r) => s(r.answer))}::text[],
      ${records.map((r) => s(r.rating))}::text[],
      ${records.map((r) => s(r.lastRated))}::text[],
      ${records.map((r) => s(r.nextReviewDue))}::text[],
      ${records.map((r) => (r.reviewIntervalDays === null ? null : String(r.reviewIntervalDays)))}::text[],
      ${records.map((r) => s(r.questionText))}::text[],
      ${records.map((r) => s(r.sourceName))}::text[],
      ${records.map((r) => stamp(r.updatedAt))}::text[]
    ) as t(
      question_id, source_path, source_index, practiced, answer, rating,
      last_rated, next_review_due, review_interval_days, question_text, source_name, updated_at_ms
    )
    on conflict (user_id, question_id) do update set
      source_path = coalesce(excluded.source_path, question_progress.source_path),
      source_index = coalesce(excluded.source_index, question_progress.source_index),
      practiced = excluded.practiced,
      answer = coalesce(excluded.answer, question_progress.answer),
      rating = coalesce(excluded.rating, question_progress.rating),
      last_rated = coalesce(excluded.last_rated, question_progress.last_rated),
      next_review_due = coalesce(excluded.next_review_due, question_progress.next_review_due),
      review_interval_days = coalesce(excluded.review_interval_days, question_progress.review_interval_days),
      question_text = coalesce(excluded.question_text, question_progress.question_text),
      source_name = coalesce(excluded.source_name, question_progress.source_name),
      updated_at_ms = greatest(excluded.updated_at_ms, question_progress.updated_at_ms),
      updated_at = now()
    where excluded.updated_at_ms >= question_progress.updated_at_ms
    returning question_id`;
  return rows.length;
}

// --- C. Saved questions ----------------------------------------------------

async function upsertSavedQuestions(userId, records, removeIds = []) {
  const sql = getSql();
  let applied = 0;
  if (records.length) {
    const rows = await sql`
      insert into saved_questions (
        user_id, question_id, question_text, source_path, source_name, source_index, saved_at, updated_at_ms
      )
      select
        ${userId}::uuid,
        t.question_id,
        t.question_text,
        t.source_path,
        t.source_name,
        t.source_index::int,
        coalesce(to_timestamp(t.saved_at::double precision / 1000), now()),
        t.updated_at_ms::bigint
      from unnest(
        ${records.map((r) => r.questionId)}::text[],
        ${records.map((r) => s(r.questionText))}::text[],
        ${records.map((r) => s(r.sourcePath))}::text[],
        ${records.map((r) => s(r.sourceName))}::text[],
        ${records.map((r) => (r.sourceIndex === null ? null : String(r.sourceIndex)))}::text[],
        ${records.map((r) => (r.savedAt === null ? null : String(r.savedAt)))}::text[],
        ${records.map((r) => stamp(r.updatedAt))}::text[]
      ) as t(question_id, question_text, source_path, source_name, source_index, saved_at, updated_at_ms)
      on conflict (user_id, question_id) do update set
        question_text = coalesce(excluded.question_text, saved_questions.question_text),
        source_path = coalesce(excluded.source_path, saved_questions.source_path),
        source_name = coalesce(excluded.source_name, saved_questions.source_name),
        source_index = coalesce(excluded.source_index, saved_questions.source_index),
        saved_at = least(excluded.saved_at, saved_questions.saved_at),
        updated_at_ms = greatest(excluded.updated_at_ms, saved_questions.updated_at_ms)
      where excluded.updated_at_ms >= saved_questions.updated_at_ms
      returning question_id`;
    applied += rows.length;
  }
  if (removeIds.length) {
    await sql`delete from saved_questions where user_id = ${userId}::uuid and question_id = any(${removeIds}::text[])`;
  }
  return applied;
}

// --- D. Roadmap ------------------------------------------------------------

async function upsertRoadmapDays(userId, records) {
  if (!records.length) return 0;
  const sql = getSql();
  const rows = await sql`
    insert into roadmap_days (user_id, day, completed, note, updated_at_ms, updated_at)
    select ${userId}::uuid, t.day::int, t.completed::boolean, t.note, t.updated_at_ms::bigint, now()
    from unnest(
      ${records.map((r) => String(r.day))}::text[],
      ${records.map((r) => (r.completed ? 'true' : 'false'))}::text[],
      ${records.map((r) => s(r.note))}::text[],
      ${records.map((r) => stamp(r.updatedAt))}::text[]
    ) as t(day, completed, note, updated_at_ms)
    on conflict (user_id, day) do update set
      completed = excluded.completed,
      note = coalesce(excluded.note, roadmap_days.note),
      updated_at_ms = greatest(excluded.updated_at_ms, roadmap_days.updated_at_ms),
      updated_at = now()
    where excluded.updated_at_ms >= roadmap_days.updated_at_ms
    returning day`;
  return rows.length;
}

// Notes are stored on roadmap_days. This variant only touches the note column so
// a note-only sync can never reset a completed day.
async function upsertRoadmapNotes(userId, records) {
  if (!records.length) return 0;
  const sql = getSql();
  const rows = await sql`
    insert into roadmap_days (user_id, day, completed, note, updated_at_ms, updated_at)
    select ${userId}::uuid, t.day::int, false, t.note, t.updated_at_ms::bigint, now()
    from unnest(
      ${records.map((r) => String(r.day))}::text[],
      ${records.map((r) => s(r.note))}::text[],
      ${records.map((r) => stamp(r.updatedAt))}::text[]
    ) as t(day, note, updated_at_ms)
    on conflict (user_id, day) do update set
      note = excluded.note,
      updated_at_ms = greatest(excluded.updated_at_ms, roadmap_days.updated_at_ms),
      updated_at = now()
    where excluded.updated_at_ms >= roadmap_days.updated_at_ms
    returning day`;
  return rows.length;
}

async function upsertRoadmapTasks(userId, records) {
  if (!records.length) return 0;
  const sql = getSql();
  const rows = await sql`
    insert into roadmap_tasks (user_id, day, task_id, completed, updated_at_ms, updated_at)
    select ${userId}::uuid, t.day::int, t.task_id, t.completed::boolean, t.updated_at_ms::bigint, now()
    from unnest(
      ${records.map((r) => String(r.day))}::text[],
      ${records.map((r) => r.taskId)}::text[],
      ${records.map((r) => (r.completed ? 'true' : 'false'))}::text[],
      ${records.map((r) => stamp(r.updatedAt))}::text[]
    ) as t(day, task_id, completed, updated_at_ms)
    on conflict (user_id, day, task_id) do update set
      completed = excluded.completed,
      updated_at_ms = greatest(excluded.updated_at_ms, roadmap_tasks.updated_at_ms),
      updated_at = now()
    where excluded.updated_at_ms >= roadmap_tasks.updated_at_ms
    returning task_id`;
  return rows.length;
}

// --- E. Source coverage ----------------------------------------------------

async function upsertSourceCoverage(userId, records) {
  if (!records.length) return 0;
  const sql = getSql();
  const rows = await sql`
    insert into source_coverage (user_id, source_path, reviewed, updated_at_ms, updated_at)
    select ${userId}::uuid, t.source_path, t.reviewed::boolean, t.updated_at_ms::bigint, now()
    from unnest(
      ${records.map((r) => r.sourcePath)}::text[],
      ${records.map((r) => (r.reviewed ? 'true' : 'false'))}::text[],
      ${records.map((r) => stamp(r.updatedAt))}::text[]
    ) as t(source_path, reviewed, updated_at_ms)
    on conflict (user_id, source_path) do update set
      reviewed = excluded.reviewed,
      updated_at_ms = greatest(excluded.updated_at_ms, source_coverage.updated_at_ms),
      updated_at = now()
    where excluded.updated_at_ms >= source_coverage.updated_at_ms
    returning source_path`;
  return rows.length;
}

// --- F. Mock interviews ----------------------------------------------------

async function upsertMockSessions(userId, records) {
  if (!records.length) return 0;
  const sql = getSql();
  const rows = await sql`
    insert into mock_sessions (
      user_id, client_id, started_at, finished_at, duration_minutes, answered, total, payload, updated_at_ms, updated_at
    )
    select
      ${userId}::uuid, t.client_id,
      to_timestamp(nullif(t.started_at, '')::double precision / 1000),
      to_timestamp(nullif(t.finished_at, '')::double precision / 1000),
      nullif(t.duration_minutes, '')::int,
      nullif(t.answered, '')::int,
      nullif(t.total, '')::int,
      t.payload::jsonb,
      t.updated_at_ms::bigint,
      now()
    from unnest(
      ${records.map((r) => r.clientId)}::text[],
      ${records.map((r) => (r.startedAt === null ? null : String(r.startedAt)))}::text[],
      ${records.map((r) => (r.finishedAt === null ? null : String(r.finishedAt)))}::text[],
      ${records.map((r) => (r.durationMinutes === null ? null : String(r.durationMinutes)))}::text[],
      ${records.map((r) => (r.answered === null ? null : String(r.answered)))}::text[],
      ${records.map((r) => (r.total === null ? null : String(r.total)))}::text[],
      ${records.map((r) => JSON.stringify(r.payload || {}))}::text[],
      ${records.map((r) => stamp(r.updatedAt))}::text[]
    ) as t(client_id, started_at, finished_at, duration_minutes, answered, total, payload, updated_at_ms)
    on conflict (user_id, client_id) do update set
      started_at = coalesce(excluded.started_at, mock_sessions.started_at),
      finished_at = coalesce(excluded.finished_at, mock_sessions.finished_at),
      duration_minutes = coalesce(excluded.duration_minutes, mock_sessions.duration_minutes),
      answered = coalesce(excluded.answered, mock_sessions.answered),
      total = coalesce(excluded.total, mock_sessions.total),
      payload = case when excluded.payload = '{}'::jsonb then mock_sessions.payload else excluded.payload end,
      updated_at_ms = greatest(excluded.updated_at_ms, mock_sessions.updated_at_ms),
      updated_at = now()
    where excluded.updated_at_ms >= mock_sessions.updated_at_ms
    returning client_id`;
  return rows.length;
}

// --- G. Focus sessions -----------------------------------------------------

async function upsertFocusSessions(userId, records) {
  if (!records.length) return 0;
  const sql = getSql();
  const rows = await sql`
    insert into focus_sessions (
      user_id, client_id, session_date, minutes, roadmap_day, completed, ended_at, updated_at_ms
    )
    select
      ${userId}::uuid, t.client_id,
      t.session_date::date,
      nullif(t.minutes, '')::int,
      nullif(t.roadmap_day, '')::int,
      t.completed::boolean,
      to_timestamp(nullif(t.ended_at, '')::double precision / 1000),
      t.updated_at_ms::bigint
    from unnest(
      ${records.map((r) => r.clientId)}::text[],
      ${records.map((r) => s(r.sessionDate))}::text[],
      ${records.map((r) => (r.minutes === null ? null : String(r.minutes)))}::text[],
      ${records.map((r) => (r.roadmapDay === null ? null : String(r.roadmapDay)))}::text[],
      ${records.map((r) => (r.completed ? 'true' : 'false'))}::text[],
      ${records.map((r) => (r.endedAt === null ? null : String(r.endedAt)))}::text[],
      ${records.map((r) => stamp(r.updatedAt))}::text[]
    ) as t(client_id, session_date, minutes, roadmap_day, completed, ended_at, updated_at_ms)
    on conflict (user_id, client_id) do update set
      session_date = coalesce(excluded.session_date, focus_sessions.session_date),
      minutes = coalesce(excluded.minutes, focus_sessions.minutes),
      roadmap_day = coalesce(excluded.roadmap_day, focus_sessions.roadmap_day),
      completed = excluded.completed,
      ended_at = coalesce(excluded.ended_at, focus_sessions.ended_at),
      updated_at_ms = greatest(excluded.updated_at_ms, focus_sessions.updated_at_ms)
    where excluded.updated_at_ms >= focus_sessions.updated_at_ms
    returning client_id`;
  return rows.length;
}

// --- H. Preferences --------------------------------------------------------

async function upsertPreferences(userId, prefs) {
  const sql = getSql();
  const hasRecent = Object.prototype.hasOwnProperty.call(prefs, 'recent');
  const hasFocus = Object.prototype.hasOwnProperty.call(prefs, 'activeFocus');
  const hasMock = Object.prototype.hasOwnProperty.call(prefs, 'activeMock');
  const hasSettings = Object.prototype.hasOwnProperty.call(prefs, 'settings');
  const recent = hasRecent ? JSON.stringify(prefs.recent) : null;
  const activeFocus = hasFocus ? (prefs.activeFocus === null ? null : JSON.stringify(prefs.activeFocus)) : null;
  const activeMock = hasMock ? (prefs.activeMock === null ? null : JSON.stringify(prefs.activeMock)) : null;
  const settings = hasSettings ? JSON.stringify(prefs.settings) : null;
  await sql`
    insert into user_preferences (user_id, recent, active_focus, active_mock, settings, updated_at)
    values (
      ${userId}::uuid,
      case when ${hasRecent}::boolean then ${recent}::jsonb else '[]'::jsonb end,
      case when ${hasFocus}::boolean then ${activeFocus}::jsonb else null end,
      case when ${hasMock}::boolean then ${activeMock}::jsonb else null end,
      case when ${hasSettings}::boolean then ${settings}::jsonb else '{}'::jsonb end,
      now()
    )
    on conflict (user_id) do update set
      recent = case when ${hasRecent}::boolean then ${recent}::jsonb else user_preferences.recent end,
      active_focus = case when ${hasFocus}::boolean then ${activeFocus}::jsonb else user_preferences.active_focus end,
      active_mock = case when ${hasMock}::boolean then ${activeMock}::jsonb else user_preferences.active_mock end,
      settings = case when ${hasSettings}::boolean then ${settings}::jsonb else user_preferences.settings end,
      updated_at = now()`;
}

// --- Read the full snapshot ------------------------------------------------

async function getFullProgress(userId) {
  const sql = getSql();
  const [qp, saved, days, tasks, sources, mocks, focus, prefs] = await Promise.all([
    sql.query(
      `select question_id, source_path, source_index, practiced, answer, rating,
              to_char(last_rated, 'YYYY-MM-DD') as last_rated,
              to_char(next_review_due, 'YYYY-MM-DD') as next_review_due,
              review_interval_days, question_text, source_name, updated_at_ms
       from question_progress where user_id = $1`,
      [userId]
    ),
    sql.query(
      `select question_id, question_text, source_path, source_name, source_index,
              (extract(epoch from saved_at) * 1000)::bigint as saved_at_ms, updated_at_ms
       from saved_questions where user_id = $1`,
      [userId]
    ),
    sql.query(
      'select day, completed, note, updated_at_ms from roadmap_days where user_id = $1',
      [userId]
    ),
    sql.query(
      'select day, task_id, completed, updated_at_ms from roadmap_tasks where user_id = $1',
      [userId]
    ),
    sql.query('select source_path, reviewed, updated_at_ms from source_coverage where user_id = $1', [userId]),
    sql.query(
      `select client_id,
              (extract(epoch from started_at) * 1000)::bigint as started_at_ms,
              (extract(epoch from finished_at) * 1000)::bigint as finished_at_ms,
              duration_minutes, answered, total, payload, updated_at_ms
       from mock_sessions where user_id = $1`,
      [userId]
    ),
    sql.query(
      `select client_id, to_char(session_date, 'YYYY-MM-DD') as session_date, minutes, roadmap_day, completed,
              (extract(epoch from ended_at) * 1000)::bigint as ended_at_ms, updated_at_ms
       from focus_sessions where user_id = $1`,
      [userId]
    ),
    sql.query(
      'select recent, active_focus, active_mock, settings from user_preferences where user_id = $1',
      [userId]
    ),
  ]);

  return {
    questionProgress: qp.map((r) => ({
      questionId: r.question_id,
      sourcePath: r.source_path,
      sourceIndex: r.source_index,
      practiced: r.practiced,
      answer: r.answer,
      rating: r.rating,
      lastRated: r.last_rated,
      dueDate: r.next_review_due,
      intervalDays: r.review_interval_days,
      question: r.question_text,
      sourceName: r.source_name,
      updatedAt: Number(r.updated_at_ms || 0),
    })),
    savedQuestions: saved.map((r) => ({
      questionId: r.question_id,
      question: r.question_text,
      sourcePath: r.source_path,
      sourceName: r.source_name,
      sourceIndex: r.source_index,
      savedAt: r.saved_at_ms === null ? null : Number(r.saved_at_ms),
      updatedAt: Number(r.updated_at_ms || 0),
    })),
    roadmap: {
      days: days.map((r) => ({
        day: r.day,
        completed: r.completed,
        note: r.note,
        updatedAt: Number(r.updated_at_ms || 0),
      })),
      tasks: tasks.map((r) => ({
        day: r.day,
        taskId: r.task_id,
        completed: r.completed,
        updatedAt: Number(r.updated_at_ms || 0),
      })),
    },
    sourceCoverage: sources.map((r) => ({
      sourcePath: r.source_path,
      reviewed: r.reviewed,
      updatedAt: Number(r.updated_at_ms || 0),
    })),
    mockInterviews: mocks.map((r) => ({
      clientId: r.client_id,
      startedAt: r.started_at_ms === null ? null : Number(r.started_at_ms),
      finishedAt: r.finished_at_ms === null ? null : Number(r.finished_at_ms),
      durationMinutes: r.duration_minutes,
      answered: r.answered,
      total: r.total,
      payload: r.payload,
      updatedAt: Number(r.updated_at_ms || 0),
    })),
    focusSessions: focus.map((r) => ({
      clientId: r.client_id,
      date: r.session_date,
      minutes: r.minutes,
      day: r.roadmap_day,
      completed: r.completed,
      endedAt: r.ended_at_ms === null ? null : Number(r.ended_at_ms),
      updatedAt: Number(r.updated_at_ms || 0),
    })),
    preferences: {
      recent: prefs[0]?.recent || [],
      activeFocus: prefs[0]?.active_focus ?? null,
      activeMock: prefs[0]?.active_mock ?? null,
      settings: prefs[0]?.settings || {},
    },
  };
}

async function deleteAllProgress(userId) {
  const sql = getSql();
  await sql.query(
    `delete from question_progress where user_id = $1;
     delete from saved_questions where user_id = $1;
     delete from roadmap_days where user_id = $1;
     delete from roadmap_tasks where user_id = $1;
     delete from source_coverage where user_id = $1;
     delete from mock_sessions where user_id = $1;
     delete from focus_sessions where user_id = $1;
     delete from user_preferences where user_id = $1;`,
    [userId]
  );
}

// Apply a full local snapshot. 'merge' upserts with last-write-wins guarding so
// older browser data never overwrites newer cloud data. 'replace' clears the
// user's progress first (used only by the explicit restore flow).
async function applyImport(userId, payload) {
  const byDomain = {};
  let imported = 0;
  let sent = 0;

  // 'replace' is only reachable from the explicit restore flow; it clears the
  // user's cloud progress before applying the provided snapshot.
  if (payload.strategy === 'replace') {
    await deleteAllProgress(userId);
  }

  const run = async (name, records, fn) => {
    sent += records.length;
    const applied = await fn(records);
    byDomain[name] = { sent: records.length, applied };
    imported += applied;
  };

  await run('questionProgress', payload.questionProgress, (r) => upsertQuestionProgress(userId, r));
  await run('savedQuestions', payload.savedQuestions, (r) => upsertSavedQuestions(userId, r, []));
  await run('roadmapDays', payload.roadmapDays, (r) => upsertRoadmapDays(userId, r));
  await run('roadmapTasks', payload.roadmapTasks, (r) => upsertRoadmapTasks(userId, r));
  await run('sourceCoverage', payload.sourceCoverage, (r) => upsertSourceCoverage(userId, r));
  await run('mockSessions', payload.mockSessions, (r) => upsertMockSessions(userId, r));
  await run('focusSessions', payload.focusSessions, (r) => upsertFocusSessions(userId, r));
  if (Object.keys(payload.preferences || {}).length) {
    await upsertPreferences(userId, payload.preferences);
    byDomain.preferences = { sent: 1, applied: 1 };
  }

  // Preferences don't carry a record count; keep `imported` meaningful.
  return {
    counts: { imported, skipped: Math.max(0, sent - imported) },
    byDomain,
  };
}

module.exports = {
  upsertQuestionProgress,
  upsertSavedQuestions,
  upsertRoadmapDays,
  upsertRoadmapNotes,
  upsertRoadmapTasks,
  upsertSourceCoverage,
  upsertMockSessions,
  upsertFocusSessions,
  upsertPreferences,
  getFullProgress,
  deleteAllProgress,
  applyImport,
};
