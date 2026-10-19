'use strict';

const { requireMethod, readJsonBody, ok, handleError } = require('../lib/http');
const { requireWriteAuth } = require('../lib/auth');
const {
  normalizeRecordArray,
  normalizeRoadmapDay,
  normalizeRoadmapNote,
  normalizeRoadmapTask,
} = require('../lib/validate');
const { upsertRoadmapDays, upsertRoadmapNotes, upsertRoadmapTasks } = require('../lib/repository');

// POST /api/roadmap  { days?: [...], tasks?: [...], notes?: [...] }
// - days:  { day, completed, updatedAt }
// - tasks: { day, taskId, completed, updatedAt }
// - notes: { day, note, updatedAt }  (never resets a completed day)
module.exports = async function handler(req, res) {
  if (!requireMethod(req, res, 'POST')) return;
  try {
    const user = await requireWriteAuth(req);
    const body = await readJsonBody(req);

    const days = normalizeRecordArray(body.days ?? [], 'days', normalizeRoadmapDay);
    const tasks = normalizeRecordArray(body.tasks ?? [], 'tasks', normalizeRoadmapTask);
    const notes = normalizeRecordArray(body.notes ?? [], 'notes', normalizeRoadmapNote);

    const [daysApplied, tasksApplied, notesApplied] = await Promise.all([
      upsertRoadmapDays(user.id, days),
      upsertRoadmapTasks(user.id, tasks),
      upsertRoadmapNotes(user.id, notes),
    ]);

    ok(res, {
      ok: true,
      received: { days: days.length, tasks: tasks.length, notes: notes.length },
      applied: { days: daysApplied, tasks: tasksApplied, notes: notesApplied },
    });
  } catch (error) {
    handleError(res, error, 'roadmap');
  }
};
