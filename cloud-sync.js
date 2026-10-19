/*
 * BA Prep Desk - cloud persistence client.
 *
 * The dashboard was written against browser localStorage. This module keeps the
 * exact same synchronous API (a Proxy that reads/writes localStorage) so all
 * existing UI code is unchanged, while transparently mirroring changes to the
 * user's Neon-backed cloud account.
 *
 * Design:
 *  - localStorage remains an immediate, offline-capable cache.
 *  - Each change is diffed at record granularity and queued with a local
 *    timestamp. Unsynced entries survive reloads (__prep_* keys).
 *  - Writes to the API are debounced, retried with bounded backoff, and never
 *    marked clean until the server confirms them.
 *  - The server enforces per-user ownership and last-write-wins by timestamp,
 *    so a stale device cannot overwrite newer cloud data.
 *  - On first sign-in the existing browser data is offered for import; the
 *    original data is backed up under __prep_local_backup and never deleted by
 *    the migration itself.
 */
(function () {
  'use strict';

  var INTERNAL = {
    ts: '__prep_ts',
    dirty: '__prep_dirty',
    removals: '__prep_removals',
    owner: '__prep_owner',
    migrated: '__prep_migrated',
    backup: '__prep_local_backup',
    lastSync: '__prep_last_sync'
  };

  var BA_KEY = /^ba[A-Za-z0-9]+$/;
  var NOTE_KEY = /^baNote(\d+)$/;

  // --- storage primitives --------------------------------------------------

  var raw = (function () {
    try {
      var probe = '__prep_probe__';
      window.localStorage.setItem(probe, '1');
      window.localStorage.removeItem(probe);
      return window.localStorage;
    } catch (error) {
      return memoryStorage();
    }
  })();

  function memoryStorage() {
    var map = new Map();
    return {
      getItem: function (k) { return map.has(k) ? map.get(k) : null; },
      setItem: function (k, v) { map.set(k, String(v)); },
      removeItem: function (k) { map.delete(k); },
      clear: function () { map.clear(); },
      key: function (i) { return Array.from(map.keys())[i] || null; },
      get length() { return map.size; }
    };
  }

  function readJson(key, fallback) {
    try {
      var value = raw.getItem(key);
      if (value === null) return fallback;
      return JSON.parse(value);
    } catch (error) {
      return fallback;
    }
  }

  function writeJson(key, value) {
    try { raw.setItem(key, JSON.stringify(value)); } catch (error) { /* quota */ }
  }

  function parseStored(key, value) {
    if (value === null || value === undefined) return null;
    if (NOTE_KEY.test(key)) return value;
    try { return JSON.parse(value); } catch (error) { return null; }
  }

  function parseDateMs(date) {
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return 0;
    var ms = Date.parse(date + 'T00:00:00Z');
    return Number.isFinite(ms) ? ms : 0;
  }

  function splitQuestionId(id) {
    var index = String(id).lastIndexOf('::');
    if (index === -1) return { sourcePath: String(id), sourceIndex: null };
    return {
      sourcePath: String(id).slice(0, index),
      sourceIndex: Number(String(id).slice(index + 2))
    };
  }

  // --- internal sync state --------------------------------------------------

  var tsStore = readJson(INTERNAL.ts, {}) || {};
  var removals = readJson(INTERNAL.removals, {}) || {};
  var storedDirty = readJson(INTERNAL.dirty, []);
  var dirty = new Set(Array.isArray(storedDirty) ? storedDirty : []);

  function persistTs() { writeJson(INTERNAL.ts, tsStore); }
  function persistRemovals() { writeJson(INTERNAL.removals, removals); }
  function persistDirty() { writeJson(INTERNAL.dirty, Array.from(dirty)); }

  function tsFor(key, id) { return (tsStore[key] && tsStore[key][id]) || 0; }

  function clearTsFor(key, sent) {
    var map = tsStore[key];
    if (!map) return;
    Object.keys(sent).forEach(function (id) {
      if (map[id] === sent[id]) delete map[id];
    });
    if (!Object.keys(map).length) delete tsStore[key];
    persistTs();
  }

  function hasPendingForKey(key) {
    if (tsStore[key] && Object.keys(tsStore[key]).length) return true;
    if (removals[key] && removals[key].length) return true;
    return dirty.has(key) && isSingleton(key);
  }

  function isSingleton(key) {
    return key === 'baMockSession' || key === 'baFocusSession' || key === 'baRecent';
  }

  // --- change detection -----------------------------------------------------

  function itemId(key, item) {
    if (key === 'baMockHistory') return String(item.finishedAt != null ? item.finishedAt : item.startedAt || JSON.stringify(item));
    if (key === 'baFocusLog') return String(item.endedAt != null ? item.endedAt : JSON.stringify(item));
    return String(item);
  }

  function diffCollection(key, oldValue, newValue) {
    var changed = [];
    var removed = [];
    if (Array.isArray(newValue)) {
      var oldById = new Map();
      (Array.isArray(oldValue) ? oldValue : []).forEach(function (item) { oldById.set(itemId(key, item), item); });
      newValue.forEach(function (item) {
        var id = itemId(key, item);
        var prior = oldById.get(id);
        if (prior === undefined || JSON.stringify(prior) !== JSON.stringify(item)) changed.push(id);
      });
      oldById.forEach(function (_item, id) {
        if (!newValue.some(function (item) { return itemId(key, item) === id; })) removed.push(id);
      });
      return { changed: changed, removed: removed };
    }
    var oldObject = oldValue && typeof oldValue === 'object' ? oldValue : {};
    var newObject = newValue && typeof newValue === 'object' ? newValue : {};
    Object.keys(newObject).forEach(function (id) {
      if (!(id in oldObject) || JSON.stringify(oldObject[id]) !== JSON.stringify(newObject[id])) changed.push(id);
    });
    Object.keys(oldObject).forEach(function (id) {
      if (!(id in newObject)) removed.push(id);
    });
    return { changed: changed, removed: removed };
  }

  function recordChange(key, oldRaw, newRaw) {
    if (!BA_KEY.test(key) && !NOTE_KEY.test(key)) return;
    if (newRaw === oldRaw) return;

    if (key === 'baFocusSession') {
      var oldFocus = parseStored(key, oldRaw);
      var newFocus = parseStored(key, newRaw);
      if (oldFocus && newFocus &&
          oldFocus.running === newFocus.running &&
          oldFocus.startedAt === newFocus.startedAt &&
          oldFocus.endsAt === newFocus.endsAt &&
          oldFocus.durationMinutes === newFocus.durationMinutes &&
          oldFocus.day === newFocus.day) {
        return; // timer tick only - do not persist to the cloud every second
      }
    }

    var now = Date.now();
    tsStore[key] = tsStore[key] || {};

    if (NOTE_KEY.test(key)) {
      tsStore[key].note = now;
    } else if (key === 'baMockSession' || key === 'baFocusSession' || key === 'baRecent') {
      // singletons are synced as a whole; no per-record timestamp needed
    } else {
      var parsedOld = parseStored(key, oldRaw);
      var parsedNew = parseStored(key, newRaw);
      var diff = diffCollection(key, parsedOld, parsedNew);
      diff.changed.forEach(function (id) { tsStore[key][id] = now; });
      diff.removed.forEach(function (id) { tsStore[key][id] = now; });
      if (key === 'baSavedQuestions') {
        if (diff.changed.length && removals[key]) {
          // A question that was deleted and re-added before syncing is not a
          // removal any more; drop it from the pending delete queue.
          removals[key] = removals[key].filter(function (id) { return diff.changed.indexOf(id) === -1; });
          if (!removals[key].length) delete removals[key];
          persistRemovals();
        }
        if (diff.removed.length) {
          var queue = removals[key] || [];
          removals[key] = Array.from(new Set(queue.concat(diff.removed)));
          persistRemovals();
        }
      }
    }

    persistTs();
    markDirty(key);
  }

  function markDirty(key) {
    dirty.add(key);
    persistDirty();
    scheduleKey(key);
  }

  // --- proxy store ----------------------------------------------------------

  function writeKey(key, value) {
    var stringValue = value === undefined || value === null ? String(value) : String(value);
    var oldRaw = raw.getItem(key);
    try {
      raw.setItem(key, stringValue);
    } catch (error) {
      showToast('Could not save locally: browser storage is full.', true);
      return;
    }
    recordChange(key, oldRaw, stringValue);
  }

  function removeKey(key) {
    var oldRaw = raw.getItem(key);
    raw.removeItem(key);
    recordChange(key, oldRaw, null);
  }

  var store = new Proxy({}, {
    get: function (_target, key) {
      if (typeof key === 'symbol') return undefined;
      if (key === 'getItem') return function (k) { return raw.getItem(k); };
      if (key === 'setItem') return function (k, v) { writeKey(k, v); };
      if (key === 'removeItem') return function (k) { removeKey(k); };
      if (key === 'clear') return function () {
        Array.from(rawKeys()).forEach(function (k) { removeKey(k); });
      };
      if (key === 'key') return function (i) { return raw.key(i); };
      if (key === 'length') return raw.length;
      return raw.getItem(key);
    },
    set: function (_target, key, value) {
      if (typeof key === 'symbol') return true;
      writeKey(key, value);
      return true;
    },
    deleteProperty: function (_target, key) {
      if (typeof key !== 'symbol') removeKey(key);
      return true;
    },
    has: function (_target, key) {
      return typeof key === 'string' && raw.getItem(key) !== null;
    },
    ownKeys: function () { return []; },
    getOwnPropertyDescriptor: function () { return undefined; }
  });

  function rawKeys() {
    var out = [];
    for (var i = 0; i < raw.length; i += 1) {
      var key = raw.key(i);
      if (key) out.push(key);
    }
    return out;
  }

  // --- API helpers ----------------------------------------------------------

  var currentUser = null;
  var cloudConfigured = true;
  var started = false;
  var onApplied = null;
  var flushing = false;
  var retryAttempt = 0;
  var retryTimer = null;
  var keyTimers = {};
  var lastError = '';

  function getCookie(name) {
    var parts = String(document.cookie || '').split(';');
    for (var i = 0; i < parts.length; i += 1) {
      var part = parts[i].trim();
      if (part.indexOf(name + '=') === 0) return decodeURIComponent(part.slice(name.length + 1));
    }
    return '';
  }

  function api(path, options) {
    options = options || {};
    var method = options.method || 'GET';
    var headers = { Accept: 'application/json' };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    var csrf = getCookie('prep_csrf');
    if (csrf) headers['x-csrf-token'] = csrf;
    return fetch(path, {
      method: method,
      headers: headers,
      credentials: 'same-origin',
      cache: 'no-store',
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    }).then(function (response) {
      return response.json().catch(function () { return null; }).then(function (data) {
        if (!response.ok) {
          var error = new Error((data && data.error && data.error.message) || ('Request failed (' + response.status + ')'));
          error.status = response.status;
          error.code = data && data.error && data.error.code;
          throw error;
        }
        return data;
      });
    });
  }

  // --- status UI ------------------------------------------------------------

  var statusEl = null;
  var authBtn = null;

  function setStatus(state, detail) {
    if (!statusEl) return;
    var labels = {
      signedout: 'Sign in to sync progress',
      loading: 'Loading progress…',
      saving: 'Saving…',
      saved: 'All changes saved',
      offline: 'Offline or unable to sync',
      error: 'Sync error — retrying'
    };
    statusEl.textContent = labels[state] || state;
    statusEl.dataset.state = state;
    statusEl.title = detail || '';
    if (state === 'saved' && !detail) {
      statusEl.title = 'Last synced ' + new Date().toLocaleTimeString();
    }
  }

  function updateAuthUI() {
    if (!authBtn) return;
    authBtn.textContent = currentUser ? (currentUser.email.length > 22 ? currentUser.email.slice(0, 20) + '…' : currentUser.email) : 'Sign in';
    authBtn.title = currentUser ? 'Account and sync settings' : 'Sign in to sync progress across devices';
  }

  function refresh() {
    try { if (typeof onApplied === 'function') onApplied(); } catch (error) { /* keep UI alive */ }
  }

  // --- toast + banner -------------------------------------------------------

  function ensureToast() {
    var toast = document.getElementById('prepToast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'prepToast';
      toast.className = 'prep-toast';
      toast.setAttribute('role', 'status');
      document.body.appendChild(toast);
    }
    return toast;
  }

  function showToast(message, isError) {
    var toast = ensureToast();
    toast.textContent = message;
    toast.classList.toggle('prep-toast-error', Boolean(isError));
    toast.classList.add('prep-toast-visible');
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(function () {
      toast.classList.remove('prep-toast-visible');
    }, isError ? 9000 : 6000);
  }

  function showMigrationBanner(localPayload, onMerge, onKeep) {
    var existing = document.getElementById('prepMigration');
    if (existing) existing.remove();
    var banner = document.createElement('div');
    banner.id = 'prepMigration';
    banner.className = 'prep-banner';
    banner.innerHTML =
      '<div><b>Browser progress found</b><span>Merge your existing local progress into this account? Cloud data is kept when it is newer; nothing is deleted.</span></div>' +
      '<div class="prep-banner-actions"><button class="prep-btn primary" data-action="merge">Merge browser data</button>' +
      '<button class="prep-btn" data-action="keep">Keep cloud only</button></div>';
    banner.querySelector('[data-action="merge"]').addEventListener('click', function () { onMerge(); banner.remove(); });
    banner.querySelector('[data-action="keep"]').addEventListener('click', function () {
      raw.setItem(INTERNAL.migrated, currentUser.id);
      banner.remove();
      showToast('Keeping cloud progress. Your browser data was left untouched in the backup.');
      onKeep();
    });
    document.body.appendChild(banner);
    void localPayload;
  }

  // --- snapshot building (localStorage -> API payload) ----------------------

  function readObject(key) {
    return parseStored(key, raw.getItem(key)) || {};
  }

  function readArray(key) {
    var value = parseStored(key, raw.getItem(key));
    return Array.isArray(value) ? value : [];
  }

  function buildFullPayload() {
    var ratings = readObject('baQuestionRatings');
    var answers = readObject('baQuestionAnswers');
    var practiced = readObject('baPracticedQuestions');
    var saved = readObject('baSavedQuestions');
    var sources = readObject('baSources');
    var days = readObject('baDays');
    var tasks = readObject('baTaskChecks');
    var mockHistory = readArray('baMockHistory');
    var focusLog = readArray('baFocusLog');
    var recent = readArray('baRecent');

    var qpIds = new Set();
    [ratings, answers, practiced].forEach(function (map) { Object.keys(map).forEach(function (id) { qpIds.add(id); }); });

    var questionProgress = Array.from(qpIds).map(function (id) {
      var parts = splitQuestionId(id);
      var rating = ratings[id] && typeof ratings[id] === 'object' ? ratings[id] : null;
      var ratingTs = tsFor('baQuestionRatings', id) || parseDateMs(rating && rating.lastRated);
      var answerTs = tsFor('baQuestionAnswers', id);
      var practicedTs = tsFor('baPracticedQuestions', id);
      return {
        questionId: id,
        sourcePath: (rating && rating.sourcePath) || parts.sourcePath || null,
        sourceIndex: Number.isFinite(parts.sourceIndex) ? parts.sourceIndex : null,
        practiced: Boolean(practiced[id]),
        answer: typeof answers[id] === 'string' ? answers[id] : null,
        rating: rating && rating.rating ? rating.rating : null,
        lastRated: (rating && rating.lastRated) || null,
        dueDate: (rating && rating.dueDate) || null,
        intervalDays: rating && Number.isFinite(Number(rating.intervalDays)) ? Number(rating.intervalDays) : null,
        question: (rating && rating.question) || null,
        sourceName: (rating && rating.sourceName) || null,
        updatedAt: Math.max(ratingTs, answerTs, practicedTs, 0)
      };
    });

    var savedQuestions = Object.keys(saved).map(function (id) {
      var item = saved[id] || {};
      return {
        questionId: id,
        question: item.question || null,
        sourcePath: item.path || null,
        sourceName: item.name || null,
        sourceIndex: Number.isFinite(Number(item.sourceIndex)) ? Number(item.sourceIndex) : null,
        savedAt: Number.isFinite(Number(item.savedAt)) ? Number(item.savedAt) : null,
        updatedAt: tsFor('baSavedQuestions', id) || Number(item.savedAt) || 0
      };
    });

    var dayIds = new Set(Object.keys(days).map(String));
    Object.keys(tsStore).forEach(function (key) {
      var match = NOTE_KEY.exec(key);
      if (match) dayIds.add(match[1]);
    });
    var roadmapDays = Array.from(dayIds).map(function (day) {
      var note = raw.getItem('baNote' + day);
      return {
        day: Number(day),
        completed: Boolean(days[day]),
        note: note === null ? null : note,
        updatedAt: Math.max(tsFor('baDays', day), tsFor('baNote' + day, 'note'), 0)
      };
    });

    var roadmapTasks = Object.keys(tasks).map(function (key) {
      var separator = key.indexOf(':');
      return {
        day: Number(key.slice(0, separator)),
        taskId: key.slice(separator + 1),
        completed: Boolean(tasks[key]),
        updatedAt: tsFor('baTaskChecks', key)
      };
    });

    var sourceCoverage = Object.keys(sources).map(function (path) {
      return { sourcePath: path, reviewed: Boolean(sources[path]), updatedAt: tsFor('baSources', path) };
    });

    var mockSessions = mockHistory.map(function (item) {
      var finished = Number(item.finishedAt) || 0;
      var clientId = itemId('baMockHistory', item);
      return {
        clientId: clientId,
        startedAt: item.startedAt || null,
        finishedAt: finished || null,
        durationMinutes: item.durationMinutes == null ? null : Number(item.durationMinutes),
        answered: item.answered == null ? null : Number(item.answered),
        total: item.total == null ? null : Number(item.total),
        payload: item,
        updatedAt: tsFor('baMockHistory', clientId) || finished
      };
    });

    var focusSessions = focusLog.map(function (item) {
      var endedAt = Number(item.endedAt) || 0;
      var clientId = itemId('baFocusLog', item);
      return {
        clientId: clientId,
        date: item.date || null,
        minutes: item.minutes == null ? null : Number(item.minutes),
        day: item.day == null ? null : Number(item.day),
        completed: Boolean(item.completed),
        endedAt: endedAt || null,
        updatedAt: tsFor('baFocusLog', clientId) || endedAt
      };
    });

    var preferences = { recent: recent };
    var activeFocus = parseStored('baFocusSession', raw.getItem('baFocusSession'));
    var activeMock = parseStored('baMockSession', raw.getItem('baMockSession'));
    if (activeFocus) preferences.activeFocus = activeFocus;
    if (activeMock && !activeMock.finished) preferences.activeMock = activeMock;

    return {
      strategy: 'merge',
      questionProgress: questionProgress,
      savedQuestions: savedQuestions,
      roadmapDays: roadmapDays,
      roadmapTasks: roadmapTasks,
      sourceCoverage: sourceCoverage,
      mockSessions: mockSessions,
      focusSessions: focusSessions,
      preferences: preferences
    };
  }

  function payloadHasRecords(payload) {
    if (!payload) return false;
    return ['questionProgress', 'savedQuestions', 'roadmapDays', 'roadmapTasks',
      'sourceCoverage', 'mockSessions', 'focusSessions'].some(function (key) {
      return Array.isArray(payload[key]) && payload[key].length > 0;
    });
  }

  function cloudHasRecords(progress) {
    if (!progress) return false;
    return (progress.questionProgress && progress.questionProgress.length > 0) ||
      (progress.savedQuestions && progress.savedQuestions.length > 0) ||
      (progress.roadmap && ((progress.roadmap.days && progress.roadmap.days.length) || (progress.roadmap.tasks && progress.roadmap.tasks.length))) ||
      (progress.sourceCoverage && progress.sourceCoverage.length > 0) ||
      (progress.mockInterviews && progress.mockInterviews.length > 0) ||
      (progress.focusSessions && progress.focusSessions.length > 0);
  }

  // --- apply cloud snapshot -> localStorage cache ---------------------------

  var suppress = false;

  function setRaw(key, value) {
    try { raw.setItem(key, value); } catch (error) { /* quota */ }
  }

  function applySnapshot(progress) {
    suppress = true;
    try {
      // The cloud snapshot is canonical; drop stale local notes first so a
      // note deleted on another device does not linger in this browser.
      rawKeys().forEach(function (key) {
        if (NOTE_KEY.test(key)) raw.removeItem(key);
      });

      var ratings = {};
      var answers = {};
      var practiced = {};
      (progress.questionProgress || []).forEach(function (record) {
        if (record.practiced) practiced[record.questionId] = true;
        if (record.answer !== null && record.answer !== undefined) answers[record.questionId] = record.answer;
        if (record.rating) {
          ratings[record.questionId] = {
            rating: record.rating,
            lastRated: record.lastRated || '',
            dueDate: record.dueDate || '',
            intervalDays: record.intervalDays || 0,
            question: record.question || '',
            sourceName: record.sourceName || '',
            sourcePath: record.sourcePath || ''
          };
        }
      });
      setRaw('baQuestionRatings', JSON.stringify(ratings));
      setRaw('baQuestionAnswers', JSON.stringify(answers));
      setRaw('baPracticedQuestions', JSON.stringify(practiced));

      var saved = {};
      (progress.savedQuestions || []).forEach(function (record) {
        var parts = splitQuestionId(record.questionId);
        saved[record.questionId] = {
          id: record.questionId,
          question: record.question || '',
          path: record.sourcePath || parts.sourcePath,
          name: record.sourceName || '',
          sourceIndex: record.sourceIndex == null ? parts.sourceIndex : record.sourceIndex,
          savedAt: record.savedAt || 0
        };
      });
      setRaw('baSavedQuestions', JSON.stringify(saved));

      var days = {};
      var tasks = {};
      (progress.roadmap && progress.roadmap.days ? progress.roadmap.days : []).forEach(function (record) {
        days[record.day] = Boolean(record.completed);
        if (record.note !== null && record.note !== undefined) {
          setRaw('baNote' + record.day, record.note);
        }
      });
      (progress.roadmap && progress.roadmap.tasks ? progress.roadmap.tasks : []).forEach(function (record) {
        tasks[record.day + ':' + record.taskId] = Boolean(record.completed);
      });
      setRaw('baDays', JSON.stringify(days));
      setRaw('baTaskChecks', JSON.stringify(tasks));

      var sources = {};
      (progress.sourceCoverage || []).forEach(function (record) {
        if (record.reviewed) sources[record.sourcePath] = true;
      });
      setRaw('baSources', JSON.stringify(sources));

      var history = (progress.mockInterviews || []).slice().sort(function (a, b) {
        return (b.finishedAt || 0) - (a.finishedAt || 0);
      }).map(function (record) {
        var payload = record.payload || {};
        return {
          finishedAt: record.finishedAt || payload.finishedAt || 0,
          answered: record.answered == null ? (payload.answered || 0) : record.answered,
          total: record.total == null ? (payload.total || 0) : record.total,
          durationMinutes: record.durationMinutes == null ? (payload.durationMinutes || 0) : record.durationMinutes,
          questions: payload.questions || [],
          responses: payload.responses || []
        };
      });
      setRaw('baMockHistory', JSON.stringify(history.slice(0, 10)));

      var focusLog = (progress.focusSessions || []).slice().sort(function (a, b) {
        return (b.endedAt || 0) - (a.endedAt || 0);
      }).map(function (record) {
        return {
          date: record.date || '',
          minutes: record.minutes || 0,
          day: record.day || 0,
          completed: Boolean(record.completed),
          endedAt: record.endedAt || 0
        };
      });
      setRaw('baFocusLog', JSON.stringify(focusLog.slice(0, 100)));

      var recent = progress.preferences && Array.isArray(progress.preferences.recent)
        ? progress.preferences.recent
        : [];
      setRaw('baRecent', JSON.stringify(recent.slice(0, 8)));
    } finally {
      suppress = false;
    }
  }

  function clearSyncState() {
    // The caller has just applied a canonical snapshot or uploaded a full one.
    // Record timestamps can be discarded, but pending deletions and pending
    // singleton writes (canceled timers / cleared mock sessions) still need to
    // reach the server, so keep those queued.
    var keepDirty = new Set();
    ['baMockSession', 'baFocusSession'].forEach(function (key) {
      if (dirty.has(key)) keepDirty.add(key);
    });
    var pendingRemovals = removals.baSavedQuestions || [];
    if (pendingRemovals.length) keepDirty.add('baSavedQuestions');
    tsStore = {};
    dirty = keepDirty;
    removals = pendingRemovals.length ? { baSavedQuestions: pendingRemovals } : {};
    persistTs();
    persistDirty();
    persistRemovals();
  }

  function clearPrivateCache() {
    rawKeys().forEach(function (key) {
      if (BA_KEY.test(key) || NOTE_KEY.test(key)) raw.removeItem(key);
    });
    [INTERNAL.ts, INTERNAL.dirty, INTERNAL.removals, INTERNAL.owner, INTERNAL.migrated,
      INTERNAL.backup, INTERNAL.lastSync].forEach(function (key) { raw.removeItem(key); });
    tsStore = {};
    dirty = new Set();
    removals = {};
  }

  // --- incremental sync operations -----------------------------------------

  function postOp(endpoint, body, clean) {
    return { endpoint: endpoint, body: body, clean: clean || function () {} };
  }

  function buildOp(key) {
    var now = Date.now();

    if (NOTE_KEY.test(key)) {
      var day = Number(NOTE_KEY.exec(key)[1]);
      var note = raw.getItem(key);
      if (note === null) return null;
      var noteTs = tsFor(key, 'note') || now;
      return postOp('/api/roadmap', { notes: [{ day: day, note: note, updatedAt: noteTs }] }, function () {
        var sent = {}; sent.note = noteTs; clearTsFor(key, sent);
      });
    }

    if (key === 'baMockSession') {
      var rawMock = raw.getItem(key);
      var mock = parseStored(key, rawMock);
      var active = mock && !mock.finished ? mock : null;
      return postOp('/api/preferences', { activeMock: active }, function () {
        if (raw.getItem(key) === rawMock) markClean(key);
      });
    }

    if (key === 'baFocusSession') {
      var rawFocus = raw.getItem(key);
      var focus = parseStored(key, rawFocus);
      return postOp('/api/preferences', { activeFocus: focus || null }, function () {
        if (raw.getItem(key) === rawFocus) markClean(key);
      });
    }

    if (key === 'baRecent') {
      var rawRecent = raw.getItem(key);
      var recent = parseStored(key, rawRecent);
      return postOp('/api/preferences', { recent: Array.isArray(recent) ? recent : [] }, function () {
        if (raw.getItem(key) === rawRecent) markClean(key);
      });
    }

    var ids = Object.keys(tsStore[key] || {});
    if (!ids.length) return null;
    var obj = readObject(key);
    var sent = {};
    ids.forEach(function (id) { sent[id] = tsStore[key][id]; });

    if (key === 'baPracticedQuestions') {
      var practicedRecords = ids.map(function (id) {
        return { questionId: id, practiced: Boolean(obj[id]), updatedAt: sent[id] };
      });
      return postOp('/api/question-progress', { records: practicedRecords }, function () { clearTsFor(key, sent); });
    }

    if (key === 'baQuestionAnswers') {
      var answerRecords = ids.filter(function (id) { return typeof obj[id] === 'string'; }).map(function (id) {
        return { questionId: id, answer: obj[id], practiced: true, updatedAt: sent[id] };
      });
      if (!answerRecords.length) return null;
      return postOp('/api/question-progress', { records: answerRecords }, function () { clearTsFor(key, sent); });
    }

    if (key === 'baQuestionRatings') {
      var ratingRecords = ids.filter(function (id) { return obj[id] && obj[id].rating; }).map(function (id) {
        var record = obj[id];
        return {
          questionId: id,
          rating: record.rating,
          lastRated: record.lastRated || null,
          dueDate: record.dueDate || null,
          intervalDays: Number.isFinite(Number(record.intervalDays)) ? Number(record.intervalDays) : null,
          question: record.question || null,
          sourceName: record.sourceName || null,
          sourcePath: record.sourcePath || null,
          practiced: true,
          updatedAt: sent[id]
        };
      });
      if (!ratingRecords.length) return null;
      return postOp('/api/question-progress', { records: ratingRecords }, function () { clearTsFor(key, sent); });
    }

    if (key === 'baSavedQuestions') {
      var upserts = ids.filter(function (id) { return obj[id]; }).map(function (id) {
        var item = obj[id];
        return {
          questionId: id,
          question: item.question || null,
          sourcePath: item.path || null,
          sourceName: item.name || null,
          sourceIndex: Number.isFinite(Number(item.sourceIndex)) ? Number(item.sourceIndex) : null,
          savedAt: Number(item.savedAt) || null,
          updatedAt: sent[id]
        };
      });
      var removeIds = (removals[key] || []).slice();
      if (!upserts.length && !removeIds.length) return null;
      return postOp('/api/saved-questions', { upserts: upserts, removeIds: removeIds }, function () {
        clearTsFor(key, sent);
        var queue = (removals[key] || []).filter(function (id) { return removeIds.indexOf(id) === -1; });
        if (queue.length) removals[key] = queue; else delete removals[key];
        persistRemovals();
      });
    }

    if (key === 'baSources') {
      var coverage = ids.map(function (path) {
        return { sourcePath: path, reviewed: Boolean(obj[path]), updatedAt: sent[path] };
      });
      return postOp('/api/source-coverage', { records: coverage }, function () { clearTsFor(key, sent); });
    }

    if (key === 'baDays') {
      var dayRecords = ids.filter(function (day) { return /^\d+$/.test(day); }).map(function (day) {
        return { day: Number(day), completed: Boolean(obj[day]), updatedAt: sent[day] };
      });
      if (!dayRecords.length) return null;
      return postOp('/api/roadmap', { days: dayRecords }, function () { clearTsFor(key, sent); });
    }

    if (key === 'baTaskChecks') {
      var taskRecords = ids.filter(function (id) { return id.indexOf(':') !== -1; }).map(function (id) {
        var separator = id.indexOf(':');
        return {
          day: Number(id.slice(0, separator)),
          taskId: id.slice(separator + 1),
          completed: Boolean(obj[id]),
          updatedAt: sent[id]
        };
      });
      if (!taskRecords.length) return null;
      return postOp('/api/roadmap', { tasks: taskRecords }, function () { clearTsFor(key, sent); });
    }

    if (key === 'baMockHistory') {
      var history = readArray(key);
      var sessions = history.filter(function (item) {
        return sent[itemId(key, item)] !== undefined;
      }).map(function (item) {
        var finished = Number(item.finishedAt) || 0;
        return {
          clientId: itemId(key, item),
          startedAt: item.startedAt || null,
          finishedAt: finished || null,
          durationMinutes: item.durationMinutes == null ? null : Number(item.durationMinutes),
          answered: item.answered == null ? null : Number(item.answered),
          total: item.total == null ? null : Number(item.total),
          payload: item,
          updatedAt: sent[itemId(key, item)]
        };
      });
      if (!sessions.length) return null;
      return postOp('/api/mock-interviews', { sessions: sessions }, function () { clearTsFor(key, sent); });
    }

    if (key === 'baFocusLog') {
      var log = readArray(key);
      var focusRecords = log.filter(function (item) {
        return sent[itemId(key, item)] !== undefined;
      }).map(function (item) {
        return {
          clientId: itemId(key, item),
          date: item.date || null,
          minutes: item.minutes == null ? null : Number(item.minutes),
          day: item.day == null ? null : Number(item.day),
          completed: Boolean(item.completed),
          endedAt: Number(item.endedAt) || null,
          updatedAt: sent[itemId(key, item)]
        };
      });
      if (!focusRecords.length) return null;
      return postOp('/api/focus-sessions', { records: focusRecords }, function () { clearTsFor(key, sent); });
    }

    return null;
  }

  // --- queue / flush --------------------------------------------------------

  function delayForKey(key) {
    if (NOTE_KEY.test(key)) return 900;
    if (key === 'baMockSession') return 1500;
    if (key === 'baRecent') return 1500;
    if (key === 'baFocusSession') return 500;
    if (key === 'baQuestionAnswers') return 400;
    return 250;
  }

  function scheduleKey(key) {
    if (!currentUser) return;
    clearTimeout(keyTimers[key]);
    keyTimers[key] = setTimeout(function () { delete keyTimers[key]; flush(); }, delayForKey(key));
  }

  function markClean(key) {
    dirty.delete(key);
    persistDirty();
  }

  function scheduleRetry() {
    if (!currentUser) return;
    clearTimeout(retryTimer);
    var delay = Math.min(1000 * Math.pow(2, retryAttempt), 60000);
    delay += Math.floor(Math.random() * 1000);
    retryAttempt += 1;
    retryTimer = setTimeout(function () { flush(); }, delay);
  }

  function flush() {
    if (!started || !currentUser || flushing) return Promise.resolve();
    if (!dirty.size) { setStatus('saved'); return Promise.resolve(); }
    if (navigator.onLine === false) {
      setStatus('offline', 'Waiting for a network connection.');
      scheduleRetry();
      return Promise.resolve();
    }

    flushing = true;
    setStatus('saving');
    var keys = Array.from(dirty);
    var index = 0;

    function next() {
      if (index >= keys.length) return finish();
      var key = keys[index];
      index += 1;
      var op;
      try {
        op = hasPendingForKey(key) || isSingleton(key) ? buildOp(key) : null;
      } catch (error) {
        op = null;
      }
      if (!op) { markClean(key); return Promise.resolve().then(next); }
      return api(op.endpoint, { method: 'POST', body: op.body }).then(function () {
        try { op.clean(); } catch (error) { /* noop */ }
        if (!hasPendingForKey(key)) markClean(key);
        return next();
      }).catch(function (error) {
        lastError = error.message || String(error);
        if (error.status === 401) {
          currentUser = null;
          updateAuthUI();
          setStatus('signedout', 'Your session expired. Sign in again to sync.');
          flushing = false;
          return;
        }
        if (error.status && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429) {
          setStatus('error', lastError);
          showToast('Could not sync: ' + lastError, true);
          flushing = false;
          // Keep the pending change; do not spin on a permanent validation error.
          return;
        }
        setStatus('offline', lastError);
        flushing = false;
        scheduleRetry();
      });
    }

    function finish() {
      flushing = false;
      if (dirty.size) {
        setStatus('saving');
        scheduleRetry();
      } else {
        retryAttempt = 0;
        clearTimeout(retryTimer);
        raw.setItem(INTERNAL.lastSync, String(Date.now()));
        setStatus('saved');
      }
      return undefined;
    }

    return next();
  }

  function flushKeepalive() {
    if (!currentUser || !dirty.size) return;
    var csrf = getCookie('prep_csrf');
    Array.from(dirty).forEach(function (key) {
      var op;
      try { op = buildOp(key); } catch (error) { return; }
      if (!op) return;
      try {
        fetch(op.endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf, Accept: 'application/json' },
          credentials: 'same-origin',
          keepalive: true,
          body: JSON.stringify(op.body)
        });
      } catch (error) { /* best effort */ }
    });
  }

  // --- auth / load ----------------------------------------------------------

  function importSnapshot(payload, strategy) {
    var body = Object.assign({}, payload, { strategy: strategy || 'merge' });
    return api('/api/progress/import', { method: 'POST', body: body });
  }

  // Deletions cannot be expressed by a merge import, so replay queued saved
  // question removals before fetching the cloud snapshot. Without this the
  // snapshot would resurrect questions the user already deleted.
  function flushSavedRemovals() {
    var ids = (removals.baSavedQuestions || []).slice();
    if (!ids.length) return Promise.resolve();
    return api('/api/saved-questions', { method: 'POST', body: { upserts: [], removeIds: ids } })
      .then(function () {
        var map = tsStore.baSavedQuestions;
        if (map) {
          ids.forEach(function (id) { delete map[id]; });
          if (!Object.keys(map).length) delete tsStore.baSavedQuestions;
          persistTs();
        }
        var remaining = (removals.baSavedQuestions || []).filter(function (id) {
          return ids.indexOf(id) === -1;
        });
        if (remaining.length) removals.baSavedQuestions = remaining;
        else delete removals.baSavedQuestions;
        persistRemovals();
        if (!hasPendingForKey('baSavedQuestions')) {
          dirty.delete('baSavedQuestions');
          persistDirty();
        }
      })
      .catch(function () {
        // Keep the queue; the normal flush/retry path will try again.
      });
  }

  function loadCloud() {
    if (!currentUser) { setStatus('signedout'); updateAuthUI(); return Promise.resolve(); }
    setStatus('loading');
    updateAuthUI();
    return api('/api/auth/me').then(function (me) {
      if (!me.user) {
        currentUser = null;
        updateAuthUI();
        setStatus('signedout');
        return null;
      }
      currentUser = me.user;
      return flushSavedRemovals().then(function () {
        var previousOwner = raw.getItem(INTERNAL.owner);
        if (previousOwner && previousOwner !== currentUser.id) {
          // Never import another user's cached data into this account.
          clearPrivateCache();
        }
        var localPayload = buildFullPayload();
        var hasLocal = payloadHasRecords(localPayload);
        if (hasLocal) writeJson(INTERNAL.backup, localPayload);

        return api('/api/progress').then(function (cloudResponse) {
          var cloud = cloudResponse.progress;
          var hasCloud = cloudHasRecords(cloud);
          var pending = dirty.size > 0;
          var migrated = raw.getItem(INTERNAL.migrated) === currentUser.id;

          if (hasLocal && (pending || !hasCloud)) {
            return importSnapshot(localPayload, 'merge').then(function (result) {
              applySnapshot(result.progress);
              raw.setItem(INTERNAL.owner, currentUser.id);
              raw.setItem(INTERNAL.migrated, currentUser.id);
              clearSyncState();
              finishLoad();
              if (result.counts && (result.counts.imported || result.counts.skipped)) {
                showToast('Merged browser progress: ' + result.counts.imported + ' imported' +
                  (result.counts.skipped ? ', ' + result.counts.skipped + ' kept from cloud' : '') + '.');
              }
            });
          }

          applySnapshot(cloud);
          raw.setItem(INTERNAL.owner, currentUser.id);
          clearSyncState();
          finishLoad();
          if (hasLocal && hasCloud && !migrated) {
            showMigrationBanner(localPayload, function () {
              importSnapshot(localPayload, 'merge').then(function (result) {
                applySnapshot(result.progress);
                raw.setItem(INTERNAL.migrated, currentUser.id);
                clearSyncState();
                refresh();
                showToast('Merged ' + result.counts.imported + ' record(s); ' +
                  result.counts.skipped + ' kept from cloud.');
              }).catch(function (error) {
                showToast('Could not merge browser data: ' + error.message, true);
              });
            }, function () { refresh(); });
          }
          return null;
        });
      });
    }).catch(function (error) {
      if (error.status === 401) {
        currentUser = null;
        updateAuthUI();
        setStatus('signedout', 'Your session expired. Sign in again to sync.');
        return;
      }
      setStatus('offline', error.message || 'Unable to load cloud progress.');
      showToast('Unable to load cloud progress. Your local data is still available.', true);
    });

    function finishLoad() {
      retryAttempt = 0;
      clearTimeout(retryTimer);
      setStatus(dirty.size ? 'saving' : 'saved');
      updateAuthUI();
      refresh();
      if (dirty.size) flush();
    }
  }

  // --- auth UI --------------------------------------------------------------

  function ensureStyles() {
    if (document.getElementById('prepCloudStyles')) return;
    var style = document.createElement('style');
    style.id = 'prepCloudStyles';
    style.textContent = [
      '.prep-status{border:1px solid #dbe4dc;background:#f7faf7;color:#52705f;border-radius:999px;padding:7px 11px;font-size:12px;font-weight:650;white-space:nowrap;max-width:230px;overflow:hidden;text-overflow:ellipsis}',
      '.prep-status[data-state="saving"],.prep-status[data-state="loading"]{color:#8a6a14;background:#fdf7e6;border-color:#efe2b8}',
      '.prep-status[data-state="saved"]{color:#17684e;background:#e7f3e9;border-color:#cfe6d6}',
      '.prep-status[data-state="offline"],.prep-status[data-state="error"]{color:#a13a2c;background:#fdeeeb;border-color:#f2c9c1}',
      '.prep-auth-btn{border:1px solid #cfe0d3;background:#fff;color:#17684e;border-radius:9px;padding:8px 12px;font-size:12px;font-weight:750;max-width:190px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.prep-auth-btn:hover{background:#f1f7f2}',
      '.prep-modal-backdrop{position:fixed;inset:0;background:#10261d99;display:flex;align-items:center;justify-content:center;z-index:80;padding:18px;backdrop-filter:blur(3px)}',
      '.prep-modal-backdrop[hidden]{display:none!important}',
      '.prep-modal{position:relative;background:#fff;border-radius:16px;max-width:430px;width:100%;padding:26px;box-shadow:0 24px 70px #0c241a40;max-height:88vh;overflow:auto}',
      '.prep-modal h2{margin:0 0 6px;font-size:20px}',
      '.prep-modal-sub{color:#67766d;font-size:13px;margin:0 0 16px;line-height:1.55}',
      '.prep-modal-close{position:absolute;top:10px;right:12px;border:0;background:none;font-size:24px;line-height:1;color:#77857c;padding:4px}',
      '.prep-tabs{display:flex;gap:6px;background:#f2f5f1;border-radius:9px;padding:4px;margin-bottom:16px}',
      '.prep-tabs button{flex:1;border:0;background:transparent;padding:8px;border-radius:7px;color:#64756b;font-size:12px;font-weight:700}',
      '.prep-tabs button.active{background:#fff;color:#17684e;box-shadow:0 1px 3px #1d3b2c14}',
      '.prep-modal label{display:block;font-size:12px;color:#67766d;font-weight:650;margin-bottom:11px}',
      '.prep-modal input{display:block;width:100%;margin-top:5px;padding:10px 12px;border:1px solid #dfe6df;border-radius:9px;background:#fbfcfb;outline:none}',
      '.prep-modal input:focus{border-color:#69a58a;box-shadow:0 0 0 3px #17684e16}',
      '.prep-form-error{color:#a13a2c;font-size:12px;min-height:16px;margin:2px 0 10px}',
      '.prep-hint{color:#8a968e;font-size:11px;line-height:1.5;margin:14px 0 0}',
      '.prep-btn{display:inline-block;border:1px solid #dbe4dc;background:#fff;color:#335245;border-radius:9px;padding:9px 13px;font-size:12px;font-weight:750;text-decoration:none;text-align:center}',
      '.prep-btn:hover{background:#f5f9f5}',
      '.prep-btn.primary{background:#17684e;border-color:#17684e;color:#fff}',
      '.prep-btn.primary:hover{background:#12553f}',
      '.prep-btn.danger{color:#a13a2c;border-color:#efd2cc}',
      '.prep-btn.danger:hover{background:#fdf2ef}',
      '.prep-btn[disabled]{opacity:.65;cursor:progress}',
      '.prep-account-actions{display:grid;grid-template-columns:1fr 1fr;gap:9px}',
      '.prep-account-actions .prep-btn{width:100%}',
      '.prep-toast{position:fixed;right:22px;bottom:22px;z-index:95;max-width:360px;background:#12362a;color:#eef7f1;border-radius:11px;padding:12px 15px;font-size:12px;line-height:1.5;box-shadow:0 16px 42px #10261d3d;opacity:0;transform:translateY(8px);pointer-events:none;transition:opacity .18s,transform .18s}',
      '.prep-toast-visible{opacity:1;transform:translateY(0)}',
      '.prep-toast-error{background:#7d2d22}',
      '.prep-banner{position:fixed;left:50%;bottom:20px;transform:translateX(-50%);z-index:90;background:#fff;border:1px solid #d7e3da;border-radius:13px;box-shadow:0 18px 50px #10261d33;padding:14px 16px;display:flex;gap:16px;align-items:center;max-width:min(720px,94vw);flex-wrap:wrap}',
      '.prep-banner b{display:block;font-size:13px;margin-bottom:2px}',
      '.prep-banner span{display:block;font-size:12px;color:#67766d;line-height:1.45}',
      '.prep-banner-actions{display:flex;gap:8px;margin-left:auto}',
      '@media(max-width:760px){.prep-status{display:none}.prep-auth-btn{max-width:120px}.prep-account-actions{grid-template-columns:1fr}.prep-banner{left:12px;right:12px;transform:none;max-width:none}.prep-banner-actions{margin-left:0;width:100%}.prep-banner-actions .prep-btn{flex:1}}'
    ].join('\n');
    document.head.appendChild(style);
  }

  function buildUi() {
    ensureStyles();
    var top = document.querySelector('.top');
    if (top && !document.getElementById('prepAuthBtn')) {
      var status = document.createElement('button');
      status.type = 'button';
      status.id = 'prepStatus';
      status.className = 'prep-status';
      status.dataset.state = 'signedout';
      status.textContent = 'Sign in to sync progress';
      status.addEventListener('click', function () { openModal(); });

      authBtn = document.createElement('button');
      authBtn.type = 'button';
      authBtn.id = 'prepAuthBtn';
      authBtn.className = 'prep-auth-btn';
      authBtn.textContent = 'Sign in';
      authBtn.addEventListener('click', function () { openModal(); });

      var search = top.querySelector('.search');
      top.insertBefore(status, search || null);
      top.insertBefore(authBtn, search || null);
      statusEl = status;
    }

    if (document.getElementById('prepModal')) return;
    var modal = document.createElement('div');
    modal.id = 'prepModal';
    modal.className = 'prep-modal-backdrop';
    modal.hidden = true;
    modal.innerHTML =
      '<div class="prep-modal" role="dialog" aria-modal="true" aria-labelledby="prepModalTitle">' +
      '  <button type="button" class="prep-modal-close" id="prepModalClose" aria-label="Close">×</button>' +
      '  <div id="prepAuthPane">' +
      '    <h2 id="prepModalTitle">Sync your progress</h2>' +
      '    <p class="prep-modal-sub">Sign in to keep answers, ratings, saved questions, roadmap progress and focus history across devices. Cloud sync is optional; your browser data stays available.</p>' +
      '    <div class="prep-tabs">' +
      '      <button type="button" class="active" data-mode="login">Sign in</button>' +
      '      <button type="button" data-mode="signup">Create account</button>' +
      '    </div>' +
      '    <form id="prepAuthForm" novalidate>' +
      '      <label>Email<input type="email" id="prepEmail" autocomplete="email" required maxlength="254"></label>' +
      '      <label>Password<input type="password" id="prepPassword" autocomplete="current-password" required minlength="8" maxlength="200"></label>' +
      '      <p class="prep-form-error" id="prepAuthError" role="alert"></p>' +
      '      <button type="submit" class="prep-btn primary" id="prepAuthSubmit">Sign in</button>' +
      '    </form>' +
      '    <p class="prep-hint">Password must be at least 8 characters. Sessions use secure HTTP-only cookies.</p>' +
      '  </div>' +
      '  <div id="prepAccountPane" hidden>' +
      '    <h2>Account</h2>' +
      '    <p class="prep-modal-sub" id="prepAccountEmail"></p>' +
      '    <div class="prep-account-actions">' +
      '      <button type="button" class="prep-btn" id="prepSyncNow">Sync now</button>' +
      '      <a class="prep-btn" id="prepExport" href="/api/progress/export" target="_blank" rel="noopener">Export progress</a>' +
      '      <button type="button" class="prep-btn" id="prepImportLocal">Import browser data</button>' +
      '      <button type="button" class="prep-btn danger" id="prepDeleteCloud">Delete cloud progress</button>' +
      '      <button type="button" class="prep-btn danger" id="prepSignOut">Sign out</button>' +
      '    </div>' +
      '    <p class="prep-hint">Export creates a JSON backup you can restore later. Deleting cloud progress also clears this browser\'s cached copy.</p>' +
      '  </div>' +
      '</div>';
    document.body.appendChild(modal);

    var mode = 'login';
    var form = modal.querySelector('#prepAuthForm');
    var emailInput = modal.querySelector('#prepEmail');
    var passwordInput = modal.querySelector('#prepPassword');
    var submit = modal.querySelector('#prepAuthSubmit');
    var errorEl = modal.querySelector('#prepAuthError');

    function setMode(next) {
      mode = next;
      modal.querySelectorAll('.prep-tabs button').forEach(function (button) {
        button.classList.toggle('active', button.dataset.mode === mode);
      });
      submit.textContent = mode === 'login' ? 'Sign in' : 'Create account';
      passwordInput.autocomplete = mode === 'login' ? 'current-password' : 'new-password';
      errorEl.textContent = '';
    }
    modal.querySelectorAll('.prep-tabs button').forEach(function (button) {
      button.addEventListener('click', function () { setMode(button.dataset.mode); });
    });

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      errorEl.textContent = '';
      var email = emailInput.value.trim();
      var password = passwordInput.value;
      if (!email || !password) { errorEl.textContent = 'Enter your email and password.'; return; }
      if (mode === 'signup' && password.length < 8) { errorEl.textContent = 'Password must be at least 8 characters.'; return; }
      submit.disabled = true;
      submit.textContent = mode === 'login' ? 'Signing in…' : 'Creating account…';
      api('/api/auth/' + (mode === 'login' ? 'login' : 'signup'), {
        method: 'POST',
        body: { email: email, password: password }
      }).then(function (data) {
        currentUser = data.user;
        passwordInput.value = '';
        closeModal();
        return loadCloud();
      }).catch(function (error) {
        errorEl.textContent = error.message || 'Sign in failed.';
      }).finally(function () {
        submit.disabled = false;
        submit.textContent = mode === 'login' ? 'Sign in' : 'Create account';
      });
    });

    modal.querySelector('#prepModalClose').addEventListener('click', closeModal);
    modal.addEventListener('click', function (event) { if (event.target === modal) closeModal(); });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && !modal.hidden) closeModal();
    });

    modal.querySelector('#prepSyncNow').addEventListener('click', function () {
      if (!currentUser) return;
      loadCloud().then(function () { flush(); });
    });

    modal.querySelector('#prepImportLocal').addEventListener('click', function () {
      if (!currentUser) return;
      var backup = readJson(INTERNAL.backup, null);
      var payload = backup || buildFullPayload();
      if (!payloadHasRecords(payload)) { showToast('No browser progress was found to import.'); return; }
      importSnapshot(payload, 'merge').then(function (result) {
        applySnapshot(result.progress);
        raw.setItem(INTERNAL.migrated, currentUser.id);
        clearSyncState();
        refresh();
        showToast('Imported ' + result.counts.imported + ' record(s); ' + result.counts.skipped + ' kept from cloud.');
      }).catch(function (error) {
        showToast('Import failed: ' + error.message, true);
      });
    });

    modal.querySelector('#prepDeleteCloud').addEventListener('click', function () {
      if (!currentUser) return;
      if (!window.confirm('Delete all cloud progress for this account? This cannot be undone. Export a backup first if you need one.')) return;
      api('/api/progress/delete', { method: 'POST', body: { confirm: true } }).then(function () {
        clearPrivateCache();
        refresh();
        showToast('Cloud progress deleted and local cache cleared.');
        closeModal();
      }).catch(function (error) {
        showToast('Could not delete cloud progress: ' + error.message, true);
      });
    });

    modal.querySelector('#prepSignOut').addEventListener('click', function () {
      if (dirty.size && !window.confirm('Some changes have not reached the cloud yet. Sign out and discard the cached copy on this device?')) return;
      flushKeepalive();
      api('/api/auth/logout', { method: 'POST', body: {} }).catch(function () { /* clear locally regardless */ }).then(function () {
        currentUser = null;
        clearPrivateCache();
        updateAuthUI();
        setStatus('signedout');
        refresh();
        closeModal();
        showToast('Signed out. Cached private data was removed from this browser.');
      });
    });

    void setMode;
  }

  function openModal() {
    buildUi();
    var modal = document.getElementById('prepModal');
    if (!modal) return;
    var authPane = modal.querySelector('#prepAuthPane');
    var accountPane = modal.querySelector('#prepAccountPane');
    var title = modal.querySelector('#prepModalTitle');
    if (currentUser) {
      authPane.hidden = true;
      accountPane.hidden = false;
      modal.querySelector('#prepAccountEmail').textContent = currentUser.email;
      modal.querySelector('#prepImportLocal').hidden = !readJson(INTERNAL.backup, null) && !payloadHasRecords(buildFullPayload());
    } else {
      authPane.hidden = false;
      accountPane.hidden = true;
      if (title) title.textContent = 'Sync your progress';
    }
    modal.hidden = false;
    var first = modal.querySelector('#prepEmail');
    if (first && !currentUser) setTimeout(function () { first.focus(); }, 30);
  }

  function closeModal() {
    var modal = document.getElementById('prepModal');
    if (modal) modal.hidden = true;
  }

  // --- boot -----------------------------------------------------------------

  function start(options) {
    if (started) return;
    started = true;
    onApplied = options && options.onApplied;
    buildUi();
    updateAuthUI();
    setStatus('loading');

    window.addEventListener('online', function () {
      retryAttempt = 0;
      clearTimeout(retryTimer);
      if (currentUser) flush();
    });
    window.addEventListener('offline', function () {
      if (currentUser) setStatus('offline', 'You are offline. Changes are queued locally.');
    });
    window.addEventListener('pagehide', flushKeepalive);

    api('/api/auth/me').then(function (data) {
      cloudConfigured = data.cloudConfigured !== false;
      if (!cloudConfigured) {
        setStatus('offline', 'Cloud storage is not configured on this deployment.');
        if (statusEl) statusEl.textContent = 'Cloud sync unavailable';
        return;
      }
      currentUser = data.user;
      updateAuthUI();
      if (!currentUser) {
        setStatus('signedout');
        return;
      }
      return loadCloud();
    }).catch(function (error) {
      setStatus('offline', error.message || 'Unable to reach the cloud service.');
      updateAuthUI();
    });
  }

  window.PrepCloud = {
    store: store,
    start: start,
    // exposed for diagnostics/testing only
    _internal: {
      buildFullPayload: buildFullPayload,
      applySnapshot: applySnapshot,
      INTERNAL: INTERNAL
    }
  };
})();
