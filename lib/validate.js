'use strict';

// Pure input validation and normalization. No database or HTTP dependencies so
// it can be unit-tested without external services. Every normalizer throws a
// ValidationError (HTTP 400) when input is not accepted, and returns a plain
// object with only the fields that are safe to persist.

const LIMITS = {
  EMAIL: 254,
  PASSWORD_MIN: 8,
  PASSWORD_MAX: 200,
  QUESTION_ID: 600,
  QUESTION_TEXT: 1000,
  ANSWER: 20000,
  NOTE: 20000,
  SOURCE_PATH: 1024,
  SOURCE_NAME: 512,
  SAVED_QUESTION_TEXT: 2000,
  RECORDS_PER_REQUEST: 10000,
  PREF_JSON_BYTES: 256 * 1024,
};

const RATINGS = ['know', 'review', 'work'];
const MAX_EPOCH_MS = 4102444800000; // 2100-01-01, guards against garbage timestamps

class ValidationError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'ValidationError';
    this.code = 'VALIDATION_ERROR';
    this.statusCode = 400;
    if (details) this.details = details;
  }
}

function bad(message, details) {
  throw new ValidationError(message, details);
}

function isValidEmail(value) {
  if (typeof value !== 'string') return false;
  const email = value.trim();
  if (email.length < 3 || email.length > LIMITS.EMAIL) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function normalizeEmail(value) {
  if (!isValidEmail(value)) bad('A valid email address is required.');
  return value.trim().toLowerCase();
}

function validatePassword(value) {
  if (typeof value !== 'string') bad('Password is required.');
  if (value.length < LIMITS.PASSWORD_MIN) bad(`Password must be at least ${LIMITS.PASSWORD_MIN} characters.`);
  if (value.length > LIMITS.PASSWORD_MAX) bad(`Password must be at most ${LIMITS.PASSWORD_MAX} characters.`);
  return value;
}

function asOptionalString(value, max, field) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') bad(`${field} must be a string.`);
  if (value.length > max) bad(`${field} must be at most ${max} characters.`);
  return value;
}

function asRequiredString(value, max, field) {
  if (typeof value !== 'string' || !value.trim()) bad(`${field} is required.`);
  if (value.length > max) bad(`${field} must be at most ${max} characters.`);
  return value;
}

function toBool(value, field) {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  bad(`${field} must be a boolean.`);
  return null;
}

function toOptionalBool(value, field) {
  if (value === undefined || value === null) return null;
  return toBool(value, field);
}

function toInt(value, { min, max, field }) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number) || !Number.isInteger(number)) bad(`${field} must be an integer.`);
  if (min !== undefined && number < min) bad(`${field} must be >= ${min}.`);
  if (max !== undefined && number > max) bad(`${field} must be <= ${max}.`);
  return number;
}

function toOptionalInt(value, options) {
  if (value === undefined || value === null || value === '') return null;
  return toInt(value, options);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function toOptionalDate(value, field) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !DATE_RE.test(value)) bad(`${field} must be a YYYY-MM-DD date.`);
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) bad(`${field} is not a valid date.`);
  return value;
}

function toOptionalEpochMs(value, field) {
  if (value === undefined || value === null || value === '') return null;
  let number;
  if (typeof value === 'number') number = value;
  else if (typeof value === 'string' && /^\d+$/.test(value)) number = Number(value);
  else {
    const parsed = Date.parse(value);
    if (Number.isNaN(parsed)) bad(`${field} must be a timestamp.`);
    number = parsed;
  }
  if (!Number.isFinite(number) || number < 0) bad(`${field} must be a non-negative timestamp.`);
  return Math.min(Math.floor(number), MAX_EPOCH_MS);
}

function toOptionalRating(value, field) {
  if (value === undefined || value === null || value === '') return null;
  if (!RATINGS.includes(value)) bad(`${field} must be one of: ${RATINGS.join(', ')}.`);
  return value;
}

function asRecordArray(value, field) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) bad(`${field} must be an array.`);
  if (value.length > LIMITS.RECORDS_PER_REQUEST) bad(`${field} has too many records.`);
  for (const item of value) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) bad(`${field} entries must be objects.`);
  }
  return value;
}

// --- B. Question progress --------------------------------------------------

function normalizeQuestionProgress(record) {
  const questionId = asRequiredString(record.questionId, LIMITS.QUESTION_ID, 'questionId');
  const hasPracticed = record.practiced !== undefined && record.practiced !== null;
  return {
    questionId,
    sourcePath: asOptionalString(record.sourcePath, LIMITS.SOURCE_PATH, 'sourcePath'),
    sourceIndex: toOptionalInt(record.sourceIndex, { min: 0, max: 1_000_000, field: 'sourceIndex' }),
    practiced: hasPracticed ? toBool(record.practiced, 'practiced') : true,
    answer: asOptionalString(record.answer, LIMITS.ANSWER, 'answer'),
    rating: toOptionalRating(record.rating, 'rating'),
    lastRated: toOptionalDate(record.lastRated, 'lastRated'),
    nextReviewDue: toOptionalDate(record.dueDate ?? record.nextReviewDue, 'dueDate'),
    reviewIntervalDays: toOptionalInt(record.intervalDays ?? record.reviewIntervalDays, {
      min: 0,
      max: 3650,
      field: 'intervalDays',
    }),
    questionText: asOptionalString(record.question ?? record.questionText, LIMITS.QUESTION_TEXT, 'question'),
    sourceName: asOptionalString(record.sourceName, LIMITS.SOURCE_NAME, 'sourceName'),
    updatedAt: toOptionalEpochMs(record.updatedAt, 'updatedAt') ?? 0,
  };
}

// --- C. Saved questions ----------------------------------------------------

function normalizeSavedQuestion(record) {
  const questionId = asRequiredString(record.questionId ?? record.id, LIMITS.QUESTION_ID, 'questionId');
  return {
    questionId,
    questionText: asOptionalString(record.question ?? record.questionText, LIMITS.SAVED_QUESTION_TEXT, 'question'),
    sourcePath: asOptionalString(record.sourcePath ?? record.path, LIMITS.SOURCE_PATH, 'sourcePath'),
    sourceName: asOptionalString(record.sourceName ?? record.name, LIMITS.SOURCE_NAME, 'sourceName'),
    sourceIndex: toOptionalInt(record.sourceIndex, { min: 0, max: 1_000_000, field: 'sourceIndex' }),
    savedAt: toOptionalEpochMs(record.savedAt, 'savedAt'),
    updatedAt: toOptionalEpochMs(record.updatedAt, 'updatedAt') ?? 0,
  };
}

// --- D. Roadmap ------------------------------------------------------------

function normalizeRoadmapDay(record) {
  return {
    day: toInt(record.day, { min: 1, max: 1000, field: 'day' }),
    completed: toBool(record.completed, 'completed'),
    note: asOptionalString(record.note, LIMITS.NOTE, 'note'),
    updatedAt: toOptionalEpochMs(record.updatedAt, 'updatedAt') ?? 0,
  };
}

function normalizeRoadmapNote(record) {
  return {
    day: toInt(record.day, { min: 1, max: 1000, field: 'day' }),
    note: asOptionalString(record.note, LIMITS.NOTE, 'note'),
    updatedAt: toOptionalEpochMs(record.updatedAt, 'updatedAt') ?? 0,
  };
}

function normalizeRoadmapTask(record) {
  return {
    day: toInt(record.day, { min: 1, max: 1000, field: 'day' }),
    taskId: asRequiredString(record.taskId, LIMITS.QUESTION_ID, 'taskId'),
    completed: toBool(record.completed, 'completed'),
    updatedAt: toOptionalEpochMs(record.updatedAt, 'updatedAt') ?? 0,
  };
}

// --- E. Source coverage ----------------------------------------------------

function normalizeSourceCoverage(record) {
  const sourcePath = asRequiredString(record.sourcePath ?? record.path, LIMITS.SOURCE_PATH, 'sourcePath');
  return {
    sourcePath,
    reviewed: toBool(record.reviewed, 'reviewed'),
    updatedAt: toOptionalEpochMs(record.updatedAt, 'updatedAt') ?? 0,
  };
}

// --- F. Mock sessions ------------------------------------------------------

function normalizeMockSession(record) {
  const clientId = asRequiredString(record.clientId, LIMITS.QUESTION_ID, 'clientId');
  const payload = record.payload;
  if (payload !== undefined && payload !== null) {
    if (typeof payload !== 'object' || Array.isArray(payload)) bad('payload must be an object.');
    if (JSON.stringify(payload).length > LIMITS.PREF_JSON_BYTES) bad('payload is too large.');
  }
  return {
    clientId,
    startedAt: toOptionalEpochMs(record.startedAt, 'startedAt'),
    finishedAt: toOptionalEpochMs(record.finishedAt, 'finishedAt'),
    durationMinutes: toOptionalInt(record.durationMinutes, { min: 0, max: 100000, field: 'durationMinutes' }),
    answered: toOptionalInt(record.answered, { min: 0, max: 100000, field: 'answered' }),
    total: toOptionalInt(record.total, { min: 0, max: 100000, field: 'total' }),
    payload: payload || {},
    updatedAt: toOptionalEpochMs(record.updatedAt, 'updatedAt') ?? 0,
  };
}

// --- G. Focus sessions -----------------------------------------------------

function normalizeFocusSession(record) {
  const clientId = asRequiredString(record.clientId, LIMITS.QUESTION_ID, 'clientId');
  return {
    clientId,
    sessionDate: toOptionalDate(record.date ?? record.sessionDate, 'date'),
    minutes: toOptionalInt(record.minutes, { min: 0, max: 100000, field: 'minutes' }),
    roadmapDay: toOptionalInt(record.day ?? record.roadmapDay, { min: 0, max: 1000, field: 'day' }),
    completed: toBool(record.completed, 'completed'),
    endedAt: toOptionalEpochMs(record.endedAt, 'endedAt'),
    updatedAt: toOptionalEpochMs(record.updatedAt, 'updatedAt') ?? 0,
  };
}

// --- H. Preferences --------------------------------------------------------

function normalizeJsonObject(value, field, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'object' || Array.isArray(value)) bad(`${field} must be an object.`);
  if (JSON.stringify(value).length > LIMITS.PREF_JSON_BYTES) bad(`${field} is too large.`);
  return value;
}

function normalizePreferences(record) {
  const out = {};
  if ('recent' in record) {
    if (!Array.isArray(record.recent)) bad('recent must be an array.');
    if (record.recent.length > 200) bad('recent has too many entries.');
    out.recent = record.recent.filter((item) => typeof item === 'string').slice(0, 200);
  }
  if ('activeFocus' in record) out.activeFocus = normalizeJsonObject(record.activeFocus, 'activeFocus', null);
  if ('activeMock' in record) out.activeMock = normalizeJsonObject(record.activeMock, 'activeMock', null);
  if ('settings' in record) out.settings = normalizeJsonObject(record.settings, 'settings', {});
  return out;
}

function normalizeRecordArray(value, field, normalizeFn) {
  return asRecordArray(value, field).map(normalizeFn);
}

// --- Bulk import payload ---------------------------------------------------

function normalizeImportPayload(body) {
  const strategy = body.strategy === 'replace' ? 'replace' : 'merge';
  return {
    strategy,
    questionProgress: asRecordArray(body.questionProgress, 'questionProgress').map(normalizeQuestionProgress),
    savedQuestions: asRecordArray(body.savedQuestions, 'savedQuestions').map(normalizeSavedQuestion),
    roadmapDays: asRecordArray(body.roadmapDays, 'roadmapDays').map(normalizeRoadmapDay),
    roadmapTasks: asRecordArray(body.roadmapTasks, 'roadmapTasks').map(normalizeRoadmapTask),
    sourceCoverage: asRecordArray(body.sourceCoverage, 'sourceCoverage').map(normalizeSourceCoverage),
    mockSessions: asRecordArray(body.mockSessions, 'mockSessions').map(normalizeMockSession),
    focusSessions: asRecordArray(body.focusSessions, 'focusSessions').map(normalizeFocusSession),
    preferences: normalizePreferences(body.preferences || {}),
  };
}

module.exports = {
  LIMITS,
  RATINGS,
  ValidationError,
  isValidEmail,
  normalizeEmail,
  validatePassword,
  normalizeQuestionProgress,
  normalizeSavedQuestion,
  normalizeRoadmapDay,
  normalizeRoadmapNote,
  normalizeRoadmapTask,
  normalizeSourceCoverage,
  normalizeMockSession,
  normalizeFocusSession,
  normalizePreferences,
  normalizeRecordArray,
  normalizeImportPayload,
};
