(function () {
  'use strict';

  const keys = ['baDays', 'baTaskChecks', ...Array.from({ length: 15 }, (_, i) => `baNote${i + 1}`),
    'baPracticedQuestions', 'baQuestionRatings', 'baSavedQuestions', 'baQuestionAnswers', 'baRecent', 'baSources',
    'baMockSession', 'baMockHistory', 'baFocusSession', 'baFocusLog', 'baStudioRecent', 'baStudioCaseResponses',
    'baStudioJdText', 'baStudioJdChecklist', 'baStudioJdResult', 'baStudioJdConfidence', 'baStudioJdNotes',
    'baStudioMockSession', 'baStudioMockHistory'];
  const keySet = new Set(keys), revisions = new Map(), dirty = new Set(), conflicts = new Map(), deleteIntents = new Set(), changeVersion = new Map();
  const serverRecords = new Map();
  let csrf = '', initialized = false, applying = false, timer = 0, status = 'Not signed in';
  let migrationAvailable = false;
  let bootstrapLocal = new Map();
  const originalSet = Storage.prototype.setItem, originalRemove = Storage.prototype.removeItem, originalGet = Storage.prototype.getItem;

  function read(key) {
    const raw = originalGet.call(localStorage, key);
    if (raw === null) return undefined;
    if (/^baNote(?:[1-9]|1[0-5])$/.test(key)) return raw;
    try { return JSON.parse(raw); } catch { return raw; }
  }
  function setLocal(key, value) {
    applying = true;
    try { originalSet.call(localStorage, key, /^baNote(?:[1-9]|1[0-5])$/.test(key) ? String(value) : JSON.stringify(value)); } finally { applying = false; }
  }
  function sameStoredState(key, left, right) {
    if (key === 'baFocusSession' && left && right && left.running && right.running) {
      const omitTick = (value) => { const copy = { ...value }; delete copy.remainingMs; return copy; };
      return JSON.stringify(omitTick(left)) === JSON.stringify(omitTick(right));
    }
    return JSON.stringify(left) === JSON.stringify(right);
  }
  function activeSession(key, value) {
    if (!value) return false;
    if (key === 'baFocusSession') return typeof value === 'object';
    return ['baMockSession', 'baStudioMockSession'].includes(key) && value.finished !== true;
  }
  function render() {
    const el = document.getElementById('ba-sync-status');
    if (!el) return;
    el.querySelector('[data-label]').textContent = status;
    el.querySelector('[data-actions]').innerHTML = actionMarkup();
    el.querySelector('[data-conflicts]').innerHTML = conflicts.size
      ? [...conflicts.keys()].map((key) => `<div style="display:flex;gap:6px;align-items:center;justify-content:space-between;border-top:1px solid #ffffff33;padding:6px 0"><span>${key}</span><span><button data-server-key="${key}">Keep server</button> <button data-local-key="${key}">Keep this device</button></span></div>`).join('')
      : '';
  }
  function persistConflicts() {
    try {
      if (conflicts.size) originalSet.call(localStorage, 'baSyncConflictBackup', JSON.stringify(Object.fromEntries(conflicts)));
      else originalRemove.call(localStorage, 'baSyncConflictBackup');
    } catch { /* Keep in-memory conflicts visible if browser storage is full. */ }
  }
  function actionMarkup() {
    if (!csrf) return '<a href="/api/auth/login" style="color:white">Sign in</a> · <button data-export>Export backup</button>';
    const migration = migrationAvailable ? ' <button data-migrate>Import local progress</button>' : '';
    if (conflicts.size) return '<button data-export>Export both copies</button>' + migration + ' <button data-logout>Sign out</button>';
    return '<button data-export>Export backup</button>' + migration + ' <button data-sync>Sync now</button> <button data-logout>Sign out</button>';
  }
  function setup() {
    if (document.getElementById('ba-sync-status')) return;
    const box = document.createElement('div');
    box.id = 'ba-sync-status';
    box.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:9999;max-width:min(94vw,620px);background:#173b33;color:#fff;padding:9px 12px;border-radius:10px;font:12px system-ui;box-shadow:0 6px 24px #0003';
    box.innerHTML = '<b data-label>Connecting</b><span data-actions style="margin-left:10px"></span><div data-conflicts style="max-height:35vh;overflow:auto"></div>';
    document.body.appendChild(box);
    box.addEventListener('click', async (event) => {
      const button = event.target.closest('button'); if (!button) return;
      if (button.hasAttribute('data-export')) { downloadBackup(); return; }
      if (button.hasAttribute('data-migrate')) { await migrateLocalState(); return; }
      if (button.hasAttribute('data-sync')) { await syncState(); return; }
      if (button.hasAttribute('data-server-key')) { await resolveConflict(button.dataset.serverKey, 'server'); return; }
      if (button.hasAttribute('data-local-key')) { await resolveConflict(button.dataset.localKey, 'local'); return; }
      if (button.hasAttribute('data-logout')) await logout();
    });
    render();
  }
  function mark(key, removed = false) {
    if (applying || !keySet.has(key)) return;
    if (removed) deleteIntents.add(key); else deleteIntents.delete(key);
    dirty.add(key); changeVersion.set(key, (changeVersion.get(key) || 0) + 1); status = initialized ? 'Saving' : 'Connecting'; render();
    clearTimeout(timer); timer = setTimeout(() => syncState(), 900);
  }
  function syncNeeded(key, oldRaw, nextRaw) {
    if (oldRaw === nextRaw) return false;
    if (key === 'baFocusSession' && oldRaw !== null && nextRaw !== null) {
      try {
        const oldValue = JSON.parse(oldRaw), nextValue = JSON.parse(nextRaw);
        if (oldValue && nextValue && oldValue.running && nextValue.running) {
          const omitTick = (value) => { const copy = { ...value }; delete copy.remainingMs; return copy; };
          if (JSON.stringify(omitTick(oldValue)) === JSON.stringify(omitTick(nextValue))) return false;
        }
      } catch { /* Treat an unrecognized legacy record as a real state change. */ }
    }
    return true;
  }

  Storage.prototype.setItem = function (key, value) {
    const old = this === localStorage ? originalGet.call(this, key) : null;
    originalSet.call(this, key, value); if (this === localStorage && syncNeeded(String(key), old, String(value))) mark(String(key));
  };
  Storage.prototype.removeItem = function (key) {
    const existed = this === localStorage && originalGet.call(this, key) !== null;
    originalRemove.call(this, key); if (existed) mark(String(key), true);
  };
  // The dashboard uses Storage's legacy property setters as well as setItem.
  for (const key of keys) {
    try { Object.defineProperty(localStorage, key, { configurable: true, enumerable: true,
      get() { return originalGet.call(localStorage, key); },
      set(value) { const old = originalGet.call(localStorage, key); originalSet.call(localStorage, key, String(value)); if (syncNeeded(key, old, String(value))) mark(key); } }); } catch { /* Browser may expose a nonconfigurable Storage property. */ }
  }
  window.addEventListener('storage', (event) => { if (event.key && keySet.has(event.key)) mark(event.key, event.newValue === null); });

  function exportLocalState() {
    const stores = {};
    for (const key of keys) { const value = read(key); if (value !== undefined) stores[key] = value; }
    return { version: 1, exported_at: new Date().toISOString(), stores };
  }
  function downloadBackup(extra) {
    const payload = extra || exportLocalState();
    if (conflicts.size) payload.conflicts = Object.fromEntries(conflicts);
    const blobUrl = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = blobUrl;
    link.download = `ba-prep-progress-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    link.click(); setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
  }
  async function request(path, options = {}) {
    const response = await fetch(path, { credentials: 'same-origin', ...options,
      headers: { 'Content-Type': 'application/json', ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...(options.headers || {}) } });
    let body = {}; try { body = await response.json(); } catch { /* Generic error below. */ }
    if (!response.ok) { const error = new Error(body.error || 'request_failed'); error.status = response.status; error.body = body; throw error; }
    return body;
  }
  async function loadRemote(localBefore) {
    const wasInitialized = initialized, previousRecords = new Map(serverRecords);
    const result = await request('/api/state');
    const server = new Map(result.stores.map((record) => [record.key, record]));
    let applied = false;
    serverRecords.clear();
    for (const [key, record] of server) {
      const previousRevision = revisions.get(key), previous = previousRecords.get(key);
      const raw = originalGet.call(localStorage, key), local = raw === null ? undefined : read(key);
      const differs = raw !== null && !sameStoredState(key, local, record.data);
      if (raw === null && !dirty.has(key) && !conflicts.has(key)) {
        setLocal(key, record.data); applied = true;
      } else if (conflicts.has(key)) {
        const conflict = conflicts.get(key);
        conflict.server = record.data; conflict.revision = record.revision; conflict.updatedAt = record.updatedAt; conflict.serverExists = true;
      } else if (dirty.has(key)) {
        if (previousRevision !== record.revision) conflicts.set(key, { local, server: record.data, revision: record.revision, updatedAt: record.updatedAt, serverExists: true });
      } else if (previousRevision !== undefined && previousRevision !== record.revision && previous && sameStoredState(key, local, previous.data)) {
        if (activeSession(key, local) && differs) conflicts.set(key, { local, server: record.data, revision: record.revision, updatedAt: record.updatedAt, serverExists: true });
        else if (differs) { setLocal(key, record.data); applied = true; }
      } else if (differs) {
      conflicts.set(key, { local, server: record.data, revision: record.revision, updatedAt: record.updatedAt, serverExists: true });
      }
      revisions.set(key, record.revision);
      serverRecords.set(key, record);
    }
    if (localBefore) migrationAvailable = [...localBefore].some(([key, raw]) => {
      let local; try { local = /^baNote(?:[1-9]|1[0-5])$/.test(key) ? raw : JSON.parse(raw); } catch { local = raw; }
      const record = server.get(key);
      return !record || JSON.stringify(local) !== JSON.stringify(record.data);
    });
    initialized = true;
    persistConflicts();
    if (!wasInitialized || applied) document.dispatchEvent(new CustomEvent('ba-state-loaded', { detail: { applied } }));
    status = conflicts.size ? 'Conflict needs review' : migrationAvailable ? 'Local progress ready to import' : 'Synced'; render();
  }
  async function initialize() {
    setup(); status = 'Connecting'; render();
    try {
      const savedConflicts = JSON.parse(originalGet.call(localStorage, 'baSyncConflictBackup') || '{}');
      for (const [key, value] of Object.entries(savedConflicts)) if (keySet.has(key)) conflicts.set(key, value);
    } catch { /* Ignore a malformed internal conflict cache; local progress remains intact. */ }
    const localBefore = new Map(keys.flatMap((key) => { const raw = originalGet.call(localStorage, key); return raw === null ? [] : [[key, raw]]; }));
    bootstrapLocal = localBefore;
    try {
      const session = await request('/api/auth/session');
      if (!session.authenticated) { status = 'Not signed in'; render(); return; }
      csrf = session.csrf; status = 'Connecting'; render(); await loadRemote(localBefore);
      if (migrationAvailable) status = 'Local progress ready to import';
      else if (dirty.size) await syncState();
      render();
    } catch (error) {
      if (error.status === 401) csrf = '';
      status = error.status === 403 ? 'Not authorized' : error.status === 401 ? 'Not signed in' : 'Offline'; render();
    }
  }
  async function saveState(key, value) {
    if (!keySet.has(key)) throw new Error('unknown_store');
    setLocal(key, value); mark(key);
  }
  async function syncState() {
    if (!csrf) { status = 'Not signed in'; render(); return; }
    if (!initialized) {
      status = 'Connecting'; render();
      try { await loadRemote(bootstrapLocal); } catch (error) {
        if (error.status === 401) csrf = '';
        status = error.status === 401 ? 'Not signed in' : error.status === 403 ? 'Sync failed' : 'Offline'; render(); return;
      }
      if (migrationAvailable) { status = 'Local progress ready to import'; render(); return; }
    }
    try { await loadRemote(); } catch (error) {
      if (error.status === 401) csrf = '';
      status = error.status === 401 ? 'Not signed in' : error.status === 403 ? 'Sync failed' : 'Offline'; render(); return;
    }
    if (conflicts.size) { status = 'Conflict needs review'; render(); return; }
    if (!dirty.size) { status = migrationAvailable ? 'Local progress ready to import' : 'Synced'; render(); return; }
    status = 'Saving'; render();
    for (const key of [...dirty]) {
      try {
        const version = changeVersion.get(key) || 0;
        const data = deleteIntents.has(key) ? null : read(key), revision = revisions.get(key) || 0;
        const saved = await request('/api/state/' + encodeURIComponent(key), { method: 'PUT', body: JSON.stringify({ revision, data }) });
        revisions.set(key, saved.revision);
        serverRecords.set(key, { key, data, revision: saved.revision, updatedAt: saved.updatedAt });
        if ((changeVersion.get(key) || 0) === version) { dirty.delete(key); deleteIntents.delete(key); }
      } catch (error) {
        if (error.status === 409) {
          const current = error.body.current;
          conflicts.set(key, { local: deleteIntents.has(key) ? null : read(key), server: current && current.data, revision: current ? current.revision : 0, updatedAt: current && current.updatedAt, serverExists: Boolean(current) });
          persistConflicts();
          status = 'Conflict needs review'; render(); return;
        }
        if (error.status === 401) csrf = '';
        status = error.status === 401 ? 'Not signed in' : error.status === 403 ? 'Sync failed' : 'Offline'; render(); return;
      }
    }
    status = dirty.size ? 'Saving' : migrationAvailable ? 'Local progress ready to import' : 'Synced'; render();
  }
  async function migrateLocalState() {
    if (!csrf) return;
    const snapshot = exportLocalState(); downloadBackup(snapshot);
    let migrationId = originalGet.call(localStorage, 'baMigrationId');
    if (!/^[0-9a-f-]{36}$/i.test(migrationId || '')) {
      migrationId = crypto.randomUUID(); originalSet.call(localStorage, 'baMigrationId', migrationId);
    }
    status = 'Saving'; render();
    try {
      const result = await request('/api/migrate-local-state', { method: 'POST', body: JSON.stringify({ version: 1, migration_id: migrationId, stores: snapshot.stores }) });
      originalRemove.call(localStorage, 'baMigrationId');
      dirty.clear(); deleteIntents.clear(); await loadRemote(); migrationAvailable = result.invalid.length > 0;
      status = result.invalid.length ? 'Migration needs review · ' + result.invalid.length + ' invalid' : conflicts.size ? 'Conflict needs review' : 'Synced · import complete (' + result.imported.length + ' imported, ' + result.conflicting.length + ' already on server)'; render();
    } catch (error) {
      if (error.status === 401) csrf = '';
      status = error.status === 401 ? 'Not signed in' : 'Sync failed'; render();
    }
  }
  async function resolveConflict(key, choice) {
    const conflict = conflicts.get(key); if (!conflict) return;
    if (choice === 'server') {
      if (conflict.serverExists === false || (conflict.serverExists === undefined && conflict.server === undefined)) originalRemove.call(localStorage, key); else setLocal(key, conflict.server);
      revisions.set(key, conflict.revision); dirty.delete(key); deleteIntents.delete(key); conflicts.delete(key);
      document.dispatchEvent(new CustomEvent('ba-state-loaded'));
    } else {
      status = 'Saving'; render();
      try {
        const saved = await request('/api/state/' + encodeURIComponent(key), { method: 'PUT', body: JSON.stringify({ revision: conflict.revision, data: conflict.local }) });
        revisions.set(key, saved.revision); dirty.delete(key); deleteIntents.delete(key); conflicts.delete(key);
        serverRecords.set(key, { key, data: conflict.local, revision: saved.revision, updatedAt: saved.updatedAt });
      } catch (error) {
        if (error.status === 409) {
          const current = error.body.current;
          conflict.server = current ? current.data : undefined; conflict.revision = current ? current.revision : 0;
          conflict.updatedAt = current && current.updatedAt; conflict.serverExists = Boolean(current);
        }
        if (error.status === 401) csrf = '';
        persistConflicts(); status = error.status === 401 ? 'Not signed in' : 'Conflict needs review'; render(); return;
      }
    }
    persistConflicts(); status = conflicts.size ? 'Conflict needs review' : dirty.size ? 'Saving' : 'Synced'; render();
    if (!conflicts.size && dirty.size) await syncState();
  }
  async function logout() {
    try { await request('/api/auth/logout', { method: 'POST', body: '{}' }); } catch { /* The session may have expired already. */ }
    csrf = ''; initialized = false; migrationAvailable = false; revisions.clear(); dirty.clear(); deleteIntents.clear(); conflicts.clear(); status = 'Not signed in'; render();
  }
  window.BAState = { initialize, getState: read, saveState, syncState, migrateLocalState, getSyncStatus: () => status, getCsrfToken: () => csrf, exportLocalState };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true }); else initialize();
  document.addEventListener('ba-state-loaded', () => {
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) return;
    const active = document.querySelector('.view.active')?.id;
    if (active === 'home' && typeof home === 'function') home();
    if (active === 'plan' && typeof plan === 'function') plan();
    if (active === 'practice' && typeof initPractice === 'function') initPractice();
    if (active === 'review' && typeof renderReview === 'function') renderReview();
    if (active === 'mock' && typeof renderMock === 'function') renderMock();
    if (active === 'focus' && typeof renderFocus === 'function') renderFocus();
    if (active === 'saved' && typeof renderSaved === 'function') renderSaved();
    if (active === 'coverage' && typeof renderCoverage === 'function') renderCoverage();
    if (active === 'studio' && typeof studioOnShow === 'function') studioOnShow();
  });
})();
