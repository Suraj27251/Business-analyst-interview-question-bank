/* Interview Practice Studio
 * Loads after dashboard.html's inline script and dashboard_data.js / studio_index.js.
 * Reuses the dashboard's $ / all / safe / url / dateKey / dueAfter helpers and its
 * localStorage progress stores (baPracticedQuestions, baQuestionRatings,
 * baSavedQuestions, baQuestionAnswers) so Studio progress is shared with the
 * existing Question practice, Review queue, Saved questions and Coverage views.
 * Studio-only state uses the baStudio* namespace. Progress is browser-local and
 * does not synchronize across devices.
 */
'use strict';

const STUDIO = window.STUDIO_INDEX;
const $s = (sel, root) => (root || document).querySelector(sel);
const $$s = (sel, root) => [...(root || document).querySelectorAll(sel)];

/* ---------------- storage helpers (shared with the dashboard) ------------- */

function studioLS(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) ?? JSON.stringify(fallback)); }
  catch { return fallback; }
}
function studioSave(key, value) { localStorage.setItem(key, JSON.stringify(value)); }

const practicedStore = () => studioLS('baPracticedQuestions', {});
const ratingsStore = () => (typeof practiceRatings === 'function' ? practiceRatings() : studioLS('baQuestionRatings', {}));
const savedStore = () => studioLS('baSavedQuestions', {});
const answersStore = () => studioLS('baQuestionAnswers', {});

function sourceIndexFromId(id) {
  const tail = String(id).split('::').pop();
  const n = Number(tail);
  return Number.isFinite(n) ? n : 0;
}
function isPracticed(id) { return !!practicedStore()[id]; }
function isSaved(id) { return !!savedStore()[id]; }
function ratingOf(id) {
  const rec = ratingsStore()[id];
  return typeof rec === 'string' ? rec : (rec && rec.rating) || '';
}

function markPracticed(id) {
  const x = practicedStore();
  x[id] = true;
  studioSave('baPracticedQuestions', x);
}
function togglePracticed(id) {
  const x = practicedStore();
  if (x[id]) delete x[id]; else x[id] = true;
  studioSave('baPracticedQuestions', x);
}
function setAnswer(id, text) {
  const x = answersStore();
  x[id] = text;
  studioSave('baQuestionAnswers', x);
}
function rateItem(id, rating, meta) {
  markPracticed(id);
  const x = studioLS('baQuestionRatings', {});
  const old = typeof x[id] === 'object' && x[id] ? x[id] : null;
  const oldRating = old ? old.rating : (typeof x[id] === 'string' ? x[id] : null);
  const interval = rating === 'work' ? 1
    : rating === 'review' ? 2
    : (oldRating === 'know' ? Math.min(30, Math.max(7, ((old && old.intervalDays) || 7) * 2)) : 7);
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + interval);
  x[id] = {
    rating,
    lastRated: dateKey(),
    dueDate: dateKey(d),
    intervalDays: interval,
    question: (meta && meta.question) || '',
    sourceName: (meta && meta.name) || '',
    sourcePath: (meta && meta.path) || '',
  };
  studioSave('baQuestionRatings', x);
}
function toggleSaved(item) {
  const x = savedStore();
  const id = item.id;
  if (x[id]) delete x[id];
  else x[id] = {
    id,
    question: item.question,
    path: item.path,
    name: item.name,
    sourceIndex: sourceIndexFromId(id),
    savedAt: Date.now(),
  };
  studioSave('baSavedQuestions', x);
}
function pushRecent(item, action) {
  const list = studioLS('baStudioRecent', []);
  list.unshift({ id: item.id, kind: item.kind, question: item.question || item.title || '', name: item.name || '', at: Date.now(), action });
  studioSave('baStudioRecent', list.slice(0, 20));
}

/* ---------------- derived stats ------------------------------------------ */

function studioStats() {
  const items = STUDIO.items;
  const cases = STUDIO.cases;
  const practiced = practicedStore();
  const ratings = ratingsStore();
  const saved = savedStore();
  const today = dateKey();
  const all = [...items, ...cases];
  const practicedCount = all.filter((x) => practiced[x.id]).length;
  const savedCount = all.filter((x) => saved[x.id]).length;
  const ratedList = Object.values(ratings).filter((r) => r && typeof r === 'object' && r.rating);
  const dueCount = ratedList.filter((r) => r.dueDate && r.dueDate <= today).length;
  return {
    total: all.length,
    withAnswer: items.filter((x) => x.answer).length + cases.filter((c) => c.tasks.some((t) => t.answer)).length,
    cases: cases.length,
    caseWithTasks: cases.filter((c) => c.tasks.length).length,
    technical: items.filter((x) => x.kind === 'technical').length,
    questions: items.filter((x) => x.kind === 'question').length,
    situational: items.filter((x) => x.kind === 'situational').length,
    framework: STUDIO.framework.parts.reduce((n, p) => n + p.items.length, 0),
    practiced: practicedCount,
    unpracticed: all.length - practicedCount,
    saved: savedCount,
    rated: ratedList.length,
    due: dueCount,
  };
}

/* ---------------- module state ------------------------------------------- */

const studioState = {
  pane: 'home',
  filters: { query: '', topic: 'all', source: 'all', status: 'all', hasAnswer: 'all' },
  runner: null, // { list, at, title, returnPane, onDone }
};

const MODULE_LABEL = { B: 'BA interview questions', C: 'Technical practice', E: 'Situational & what-if' };
const PANE_LABEL = {
  home: 'Studio home', framework: 'General interview framework', ba: 'BA interview questions',
  technical: 'Technical practice', cases: 'Case study lab', situational: 'Situational practice',
  jd: 'Job description prep', mock: 'Mock interview builder',
};

function studioEscape(v) { return typeof safe === 'function' ? safe(v) : String(v ?? ''); }
function studioUrl(p) { return typeof url === 'function' ? url(p) : encodeURI(String(p).split('\\').join('/')); }

/* ---------------- unified item pool & filters ----------------------------- */

function poolFor(kind) {
  if (kind === 'case') return STUDIO.cases.map((c) => ({ ...c, question: c.title, answer: '' }));
  return STUDIO.items.filter((x) => x.kind === kind);
}

function allSources() {
  return [...new Set(STUDIO.items.map((x) => x.path))].sort((a, b) => a.localeCompare(b));
}

function applyFilters(list) {
  const f = studioState.filters;
  const q = f.query.trim().toLowerCase();
  return list.filter((x) => {
    if (f.topic !== 'all' && x.topic !== f.topic) return false;
    if (f.source !== 'all' && x.path !== f.source) return false;
    if (f.hasAnswer === 'yes' && !hasAnswer(x)) return false;
    if (f.hasAnswer === 'no' && hasAnswer(x)) return false;
    if (f.status === 'practiced' && !isPracticed(x.id)) return false;
    if (f.status === 'unpracticed' && isPracticed(x.id)) return false;
    if (f.status === 'saved' && !isSaved(x.id)) return false;
    if (f.status === 'rated' && !ratingOf(x.id)) return false;
    if (q) {
      const hay = ((x.question || x.title || '') + ' ' + (x.answer || '') + ' ' + x.name + ' ' + (x.topic || '')).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function hasAnswer(x) {
  if (x.kind === 'case') return x.tasks.some((t) => t.answer);
  return !!x.answer;
}

function filterBarHTML(opts) {
  const f = studioState.filters;
  const topics = STUDIO.topics;
  const sources = (opts && opts.hideSource) ? '' : `
    <label>Source file<select data-f="source"><option value="all">All sources</option>${allSources().map((s) => `<option value="${studioEscape(s)}" ${f.source === s ? 'selected' : ''}>${studioEscape(s.split('\\').pop())}</option>`).join('')}</select></label>`;
  return `<div class="studio-filters">
    <label>Search<input data-f="query" value="${studioEscape(f.query)}" placeholder="Search questions, answers, topics…"></label>
    <label>Topic<select data-f="topic"><option value="all">All topics</option>${topics.map((t) => `<option value="${studioEscape(t)}" ${f.topic === t ? 'selected' : ''}>${studioEscape(t)}</option>`).join('')}</select></label>
    ${sources}
    <label>Status<select data-f="status">
      <option value="all" ${f.status === 'all' ? 'selected' : ''}>Any status</option>
      <option value="unpracticed" ${f.status === 'unpracticed' ? 'selected' : ''}>Unpracticed</option>
      <option value="practiced" ${f.status === 'practiced' ? 'selected' : ''}>Practiced</option>
      <option value="saved" ${f.status === 'saved' ? 'selected' : ''}>Saved</option>
      <option value="rated" ${f.status === 'rated' ? 'selected' : ''}>Rated</option>
    </select></label>
    <label>Source answer<select data-f="hasAnswer">
      <option value="all" ${f.hasAnswer === 'all' ? 'selected' : ''}>Any</option>
      <option value="yes" ${f.hasAnswer === 'yes' ? 'selected' : ''}>Has source answer</option>
      <option value="no" ${f.hasAnswer === 'no' ? 'selected' : ''}>No paired answer</option>
    </select></label>
    <button class="smallbtn" type="button" onclick="studioResetFilters()">Reset</button>
  </div>`;
}

function bindFilterBar(root) {
  $$s('[data-f]', root).forEach((el) => {
    const evt = el.tagName === 'SELECT' ? 'change' : 'input';
    el.addEventListener(evt, () => {
      studioState.filters[el.dataset.f] = el.value;
      studioRenderPane();
      const again = $s(`[data-f="${el.dataset.f}"]`);
      if (again && evt === 'input') { again.focus(); again.selectionStart = again.value.length; }
    });
  });
}

function studioResetFilters() {
  studioState.filters = { query: '', topic: 'all', source: 'all', status: 'all', hasAnswer: 'all' };
  studioRenderPane();
}

/* ---------------- practice runner (question / technical / situational) ---- */

function startPractice(list, title, returnPane) {
  if (!list.length) return;
  studioState.runner = { list, at: 0, title: title || 'Practice', returnPane: returnPane || studioState.pane };
  studioRenderPane();
}

function runnerHTML() {
  const r = studioState.runner;
  const item = r.list[r.at];
  const pct = Math.round(((r.at + 1) / r.list.length) * 100);
  const status = ratingOf(item.id);
  const saved = isSaved(item.id);
  const practiced = isPracticed(item.id);
  const stored = answersStore()[item.id] || '';
  const revealed = studioState.reveal === item.id;
  const followUps = item.followUps || [];
  const locator = item.locator && item.locator.page ? ` · page ${item.locator.page}` : '';
  return `<article class="studio-runner">
    <div class="runner-top">
      <b>${studioEscape(r.title)} · question ${r.at + 1} of ${r.list.length}</b>
      <span>${hasAnswer(item) ? 'Source answer text available' : 'No paired answer in source — open the original file'}</span>
    </div>
    <div class="practice-progress"><span style="width:${pct}%"></span></div>
    <div class="tagrow">
      <span class="tag">${studioEscape(item.kind === 'question' ? 'BA question' : item.kind === 'technical' ? 'Technical' : 'Situational')}</span>
      ${item.topic ? `<span class="tag muted">${studioEscape(item.topic)}</span>` : ''}
      ${practiced ? '<span class="tag">Practiced ✓</span>' : ''}
      ${saved ? '<span class="tag muted">Saved ☆</span>' : ''}
      ${status ? `<span class="tag ${status === 'work' ? 'warn' : ''}">${status === 'know' ? 'Know it' : status === 'review' ? 'Review' : 'Needs work'}</span>` : ''}
    </div>
    <div class="runner-source">${studioEscape(item.name)}${locator} · <a href="${studioUrl(item.path)}" target="_blank" rel="noopener">open original source ↗</a></div>
    <div class="runner-question">${studioEscape(item.question)}</div>
    <label class="studio-answer-label" for="studioAnswer">Your answer</label>
    <textarea id="studioAnswer" class="studio-answer" placeholder="Answer aloud first, then jot down the key points…">${studioEscape(stored)}</textarea>
    <div class="studio-actions">
      <button class="smallbtn primary" type="button" onclick="studioSubmitAnswer()">Save answer & mark practiced</button>
      <button class="smallbtn" type="button" onclick="studioToggleSave()">${saved ? 'Saved for later ✓' : 'Save for later ☆'}</button>
      <button class="smallbtn" type="button" onclick="studioTogglePracticed()">${practiced ? 'Unmark practiced' : 'Mark practiced'}</button>
      <span class="studio-status" id="studioAnswerStatus">${stored ? 'Response saved in this browser.' : 'Submit a non-empty answer to mark this question practiced.'}</span>
    </div>
    <div class="studio-actions">
      <button class="smallbtn" type="button" id="studioReveal" aria-expanded="${revealed}" onclick="studioToggleReveal()">${revealed ? 'Hide source answer' : 'Reveal source answer'}</button>
    </div>
    <div class="runner-block ${revealed ? '' : 'hide'}">
      ${hasAnswer(item)
        ? `<h4>Source answer · verbatim excerpt</h4><pre class="runner-pre">${studioEscape(item.answer)}</pre>`
        : `<div class="studio-note">No paired answer text was found after this prompt in the extracted source. Inspect the original file above.</div>`}
      ${followUps.length && revealed ? `<h4 style="margin-top:12px">Likely follow-ups from the same source</h4><ul class="fw-followups">${followUps.map((f) => `<li>${studioEscape(f.question)}${f.answer ? ` — <span class="studio-note">${studioEscape(f.answer.slice(0, 400))}${f.answer.length > 400 ? ' …' : ''}</span>` : ''}</li>`).join('')}</ul>` : ''}
    </div>
    <div class="studio-actions">
      <span class="studio-note">How did you do?</span>
      <div class="studio-rating">
        <button class="ratebtn ${status === 'know' ? 'studio-selected' : ''}" type="button" aria-pressed="${status === 'know'}" onclick="studioRate('know')">Know it</button>
        <button class="ratebtn ${status === 'review' ? 'studio-selected' : ''}" type="button" aria-pressed="${status === 'review'}" onclick="studioRate('review')">Review</button>
        <button class="ratebtn ${status === 'work' ? 'studio-selected' : ''}" type="button" aria-pressed="${status === 'work'}" onclick="studioRate('work')">Needs work</button>
      </div>
    </div>
    <div class="studio-nav">
      <button class="smallbtn" type="button" onclick="studioMove(-1)" ${r.at === 0 ? 'disabled' : ''}>← Previous</button>
      <button class="smallbtn" type="button" onclick="studioExitRunner()">Back to list</button>
      <button class="smallbtn primary" type="button" onclick="studioMove(1)" ${r.at === r.list.length - 1 ? 'disabled' : ''}>Next →</button>
    </div>
    <p class="studio-note">Question and answer text come from the linked repository source. Opening a question does not mark it practiced — use the buttons above.</p>
  </article>`;
}

function studioMove(step) {
  const r = studioState.runner;
  if (!r) return;
  studioState.reveal = null;
  r.at = Math.max(0, Math.min(r.list.length - 1, r.at + step));
  studioRenderPane();
}
function studioExitRunner() { studioState.runner = null; studioState.reveal = null; studioRenderPane(); }
function studioToggleReveal() {
  const item = studioState.runner.list[studioState.runner.at];
  studioState.reveal = studioState.reveal === item.id ? null : item.id;
  studioRenderPane();
}
function studioSubmitAnswer() {
  const r = studioState.runner;
  const item = r.list[r.at];
  const field = $s('#studioAnswer');
  const status = $s('#studioAnswerStatus');
  if (!field || !field.value.trim()) { if (status) status.textContent = 'Write an answer before submitting.'; return; }
  setAnswer(item.id, field.value);
  markPracticed(item.id);
  pushRecent(item, 'answered');
  studioRenderPane();
}
function studioToggleSave() {
  const item = studioState.runner.list[studioState.runner.at];
  toggleSaved(item);
  studioRenderPane();
}
function studioTogglePracticed() {
  const item = studioState.runner.list[studioState.runner.at];
  togglePracticed(item.id);
  pushRecent(item, 'marked practiced');
  studioRenderPane();
}
function studioRate(value) {
  const item = studioState.runner.list[studioState.runner.at];
  rateItem(item.id, value, { question: item.question, name: item.name, path: item.path });
  pushRecent(item, 'rated ' + value);
  studioRenderPane();
}

/* ---------------- list pane (modules B / C / E) --------------------------- */

function listPaneHTML(kind, title) {
  const base = poolFor(kind);
  const list = applyFilters(base);
  const practiced = base.filter((x) => isPracticed(x.id)).length;
  if (studioState.runner) return runnerHTML();
  return `${filterBarHTML()}
    <p class="studio-count">${list.length} of ${base.length} items · ${practiced} practiced · answers save only in this browser</p>
    ${list.length ? `<div class="studio-list">${list.slice(0, 200).map((x) => listItemHTML(x)).join('')}</div>
      ${list.length > 200 ? `<p class="studio-count">Showing the first 200 matches. Narrow the filters to see more.</p>` : ''}
      <div class="studio-actions" style="margin-top:12px"><button class="smallbtn primary" type="button" onclick="studioPracticeFiltered('${kind}','${studioEscape(title)}')">Practice these ${list.length} question${list.length === 1 ? '' : 's'}</button></div>`
    : `<div class="studio-empty">No items match the current filters.</div>`}`;
}

function listItemHTML(x) {
  const ans = hasAnswer(x);
  const status = ratingOf(x.id);
  return `<div class="studio-list-item">
    <div class="item-main">
      <b>${studioEscape(x.question || x.title)}</b>
      <small>${studioEscape(x.name)}${x.locator && x.locator.page ? ' · page ' + x.locator.page : ''}${x.kind === 'case' ? ' · ' + x.tasks.length + ' task' + (x.tasks.length === 1 ? '' : 's') : ''}</small>
      <div class="tagrow">
        ${x.topic ? `<span class="tag muted">${studioEscape(x.topic)}</span>` : ''}
        <span class="tag ${ans ? '' : 'warn'}">${ans ? 'Source answer' : 'No paired answer'}</span>
        ${isPracticed(x.id) ? '<span class="tag">Practiced ✓</span>' : ''}
        ${isSaved(x.id) ? '<span class="tag muted">Saved ☆</span>' : ''}
        ${status ? `<span class="tag ${status === 'work' ? 'warn' : ''}">${status === 'know' ? 'Know it' : status === 'review' ? 'Review' : 'Needs work'}</span>` : ''}
      </div>
    </div>
    <div class="item-actions">
      ${x.kind === 'case'
        ? `<button class="smallbtn primary" type="button" onclick="studioOpenCase('${studioEscape(x.id)}')">Open case</button>`
        : `<button class="smallbtn primary" type="button" onclick="studioPracticeById('${studioEscape(x.id)}','${x.kind}')">Practice</button>`}
      <a class="smallbtn" href="${studioUrl(x.path)}" target="_blank" rel="noopener">Source ↗</a>
    </div>
  </div>`;
}

function studioPracticeFiltered(kind, title) {
  const list = applyFilters(poolFor(kind));
  startPractice(list, title, studioState.pane);
}
function studioPracticeById(id, kind) {
  const list = applyFilters(poolFor(kind));
  const at = list.findIndex((x) => x.id === id);
  startPractice(list.length ? list : poolFor(kind), MODULE_LABEL[kind] || 'Practice', studioState.pane);
  if (at >= 0) studioState.runner.at = at;
  studioRenderPane();
}

/* ---------------- Module A: framework ------------------------------------- */

const FW_RELATED = {
  'fw-P1-1': { topics: [], query: 'introduce yourself resume career summary' },
  'fw-P1-2': { topics: [], query: 'project ownership role responsibilities' },
  'fw-P1-3': { topics: ['Prioritization'], query: 'decision trade-off approach alternatives' },
  'fw-P1-4': { topics: ['Stakeholder management'], query: 'conflict stakeholder disagree' },
  'fw-P1-5': { topics: [], query: 'mistake failure lesson learned' },
  'fw-P1-6': { topics: ['Change management', 'Prioritization'], query: 'scope change deadline pressure escalate trade-off' },
  'fw-P1-7': { topics: [], query: 'company role why join motivation' },
  'fw-P1-8': { topics: [], query: 'questions to ask interviewer' },
  'fw-P2-R1': { topics: ['Requirements & elicitation'], query: '' },
  'fw-P2-R2': { topics: ['Requirements & elicitation', 'Documentation'], query: '' },
  'fw-P2-R3': { topics: ['Process mapping'], query: '' },
  'fw-P2-R4': { topics: ['Requirements & elicitation', 'Documentation'], query: 'functional non-functional' },
  'fw-P2-R5': { topics: ['Prioritization'], query: '' },
  'fw-P2-R6': { topics: ['Change management'], query: '' },
  'fw-P2-R7': { topics: ['UAT & testing'], query: '' },
  'fw-P2-R8': { topics: ['Traceability'], query: '' },
  'fw-P2-R9': { topics: ['Data analysis'], query: '' },
  'fw-P2-R10': { topics: ['Agile & Scrum'], query: '' },
};

function relatedItemsFor(fw) {
  const cfg = FW_RELATED[fw.id] || { topics: [], query: fw.question };
  const terms = (cfg.query || fw.question).toLowerCase().split(/\s+/).filter((w) => w.length > 4 && !['which', 'would', 'their', 'about'].includes(w));
  return STUDIO.items.filter((x) => {
    if (cfg.topics.length && cfg.topics.includes(x.topic)) return true;
    if (!terms.length) return false;
    const hay = (x.question + ' ' + x.answer).toLowerCase();
    return terms.some((t) => hay.includes(t));
  }).slice(0, 25);
}

function frameworkHTML() {
  const f = STUDIO.framework;
  const part1 = f.parts.find((p) => p.id === 'P1');
  const part2 = f.parts.find((p) => p.id === 'P2');
  const part3 = f.parts.find((p) => p.id === 'P3');
  const item = (it) => `<details class="framework-item">
    <summary><span class="fw-code">${studioEscape(it.code)}</span><b>${studioEscape(it.question)}</b></summary>
    <div class="fw-body">
      ${it.testing ? `<div><h4>They are testing</h4><p>${studioEscape(it.testing)}</p></div>` : ''}
      ${it.how ? `<div><h4>How to answer</h4><p>${studioEscape(it.how)}</p></div>` : ''}
      ${it.story ? `<div><h4>Your story to use (from the PDF)</h4><p>${studioEscape(it.story)}</p></div>` : ''}
      ${it.followUps.length ? `<div><h4>Likely follow-ups</h4><ul class="fw-followups">${it.followUps.map((q) => `<li>${studioEscape(q)}</li>`).join('')}</ul></div>` : ''}
      <div class="studio-actions">
        <button class="smallbtn primary" type="button" onclick="studioPracticeRelated('${it.id}')">Practice related repository questions</button>
        <button class="smallbtn" type="button" onclick="studioRateFramework('${it.id}','know')" aria-pressed="${ratingOf(it.id) === 'know'}">Mark rehearsed ✓</button>
      </div>
      ${ratingOf(it.id) ? `<p class="studio-note">Your status: ${ratingOf(it.id) === 'know' ? 'Rehearsed' : ratingOf(it.id)} (saved in this browser; included in the review queue).</p>` : ''}
    </div>
  </details>`;
  return `<div class="studio-hero">
    <div>
      <div class="readlabel">Source: ${studioEscape(f.frameworkSource)} (repository copy)</div>
      <h2>${studioEscape(f.title)}</h2>
      <p>${studioEscape(f.subtitle)} — Part 1 is the universal core, Part 2 the Business Analyst module, Part 3 the job-description tool ladder. Answer guides are structures to fill with your own examples, not scripts to memorise.</p>
    </div>
    <div class="studio-hero-actions">
      <a class="smallbtn primary" href="${studioUrl(f.frameworkSource)}" target="_blank" rel="noopener">Open ${studioEscape(f.frameworkSource)} ↗</a>
    </div>
  </div>
  <div class="cols">
    <div class="panel"><h3>Your proof points (from the PDF)</h3>${f.framework.proofPoints.map((p) => `<div class="focus-item"><b>${studioEscape(p)}</b></div>`).join('')}</div>
    <div class="panel"><h3>Do not claim (from the PDF)</h3>${f.framework.doNotClaim.map((p) => `<div class="focus-item"><b>${studioEscape(p)}</b></div>`).join('')}</div>
  </div>
  <div class="studyhead"><h2>${studioEscape(part1.title)}</h2><p>Prepare each once; almost every interview uses them.</p></div>
  <div class="framework-grid">${part1.items.map(item).join('')}</div>
  <div class="studyhead"><h2>${studioEscape(part2.title)}</h2><p>Role-specific competency questions with the PDF's own guidance and follow-ups.</p></div>
  <div class="framework-grid">${part2.items.map(item).join('')}</div>
  <div class="studyhead"><h2>${studioEscape(part3.title)}</h2><p>${studioEscape(f.framework.jdLadder ? f.framework.jdLadder.text : '')}</p></div>
  <div class="panel">
    <h3>The ladder, for every tool or term in a job description</h3>
    <ol class="fw-followups">${(f.framework.jdLadder ? f.framework.jdLadder.steps : []).map((s) => `<li>${studioEscape(s)}</li>`).join('')}</ol>
    <p class="studio-note">Terms the role usually lists (from the PDF): ${(f.framework.jdTerms || []).map(studioEscape).join(', ')}.</p>
    <h3 style="margin-top:12px">Questions to ask the interviewer (from the PDF)</h3>
    <ul class="fw-followups">${f.framework.questionsForInterviewer.map((q) => `<li>${studioEscape(q)}</li>`).join('')}</ul>
    <div class="studio-actions"><button class="smallbtn primary" type="button" onclick="studioGo('jd')">Open job-description prep →</button></div>
  </div>`;
}

function studioPracticeRelated(fwId) {
  const fw = [...STUDIO.framework.parts[0].items, ...STUDIO.framework.parts[1].items].find((x) => x.id === fwId);
  if (!fw) return;
  const list = relatedItemsFor(fw);
  if (!list.length) { alert('No repository questions matched this framework item.'); return; }
  startPractice(list, 'Related to ' + fw.code + '. ' + fw.question.slice(0, 60), 'framework');
}
function studioRateFramework(id) {
  rateItem(id, 'know', { question: 'Framework: ' + id, name: STUDIO.framework.frameworkSource, path: STUDIO.framework.frameworkSource });
  pushRecent({ id, kind: 'framework', question: id, name: STUDIO.framework.frameworkSource }, 'marked rehearsed');
  studioRenderPane();
}

/* ---------------- Module D: case study lab -------------------------------- */

function casesPaneHTML() {
  if (studioState.caseOpen) return caseRunnerHTML();
  const f = studioState.filters;
  const q = f.query.trim().toLowerCase();
  let list = STUDIO.cases.filter((c) => {
    if (f.topic !== 'all' && c.topic !== f.topic) return false;
    if (f.source !== 'all' && c.path !== f.source) return false;
    if (f.status === 'practiced' && !isPracticed(c.id)) return false;
    if (f.status === 'unpracticed' && isPracticed(c.id)) return false;
    if (f.status === 'saved' && !isSaved(c.id)) return false;
    if (q && !((c.title + ' ' + c.prompt + ' ' + c.name).toLowerCase().includes(q))) return false;
    return true;
  });
  const practiced = STUDIO.cases.filter((c) => isPracticed(c.id)).length;
  return `${filterBarHTML({ hideSource: false })}
    <p class="studio-count">${list.length} of ${STUDIO.cases.length} cases · ${STUDIO.stats.caseWithTasks} carry source-detected tasks · ${practiced} practised</p>
    ${list.length ? `<div class="studio-list">${list.slice(0, 200).map((c) => `<div class="studio-list-item">
      <div class="item-main">
        <b>${studioEscape(c.title)}</b>
        <small>${studioEscape(c.name)}${c.locator && c.locator.page ? ' · page ' + c.locator.page : ''} · ${c.tasks.length} detected task${c.tasks.length === 1 ? '' : 's'}${c.tasks.some((t) => t.answer) ? ' · source guidance available' : ''}</small>
        <div class="tagrow"><span class="tag muted">${studioEscape(c.topic)}</span>${isPracticed(c.id) ? '<span class="tag">Practiced ✓</span>' : ''}</div>
      </div>
      <div class="item-actions">
        <button class="smallbtn primary" type="button" onclick="studioOpenCase('${studioEscape(c.id)}')">Work this case</button>
        <a class="smallbtn" href="${studioUrl(c.path)}" target="_blank" rel="noopener">Source ↗</a>
      </div></div>`).join('')}</div>` : `<div class="studio-empty">No cases match the current filters.</div>`}`;
}

function studioOpenCase(id) {
  studioState.caseOpen = id;
  studioState.pane = 'cases';
  studioRenderPane();
}

function caseRunnerHTML() {
  const c = STUDIO.cases.find((x) => x.id === studioState.caseOpen);
  if (!c) { studioState.caseOpen = null; return casesPaneHTML(); }
  const responses = studioLS('baStudioCaseResponses', {});
  const stored = (responses[c.id] && responses[c.id].response) || '';
  const revealed = studioState.reveal === c.id;
  return `<article class="studio-runner">
    <div class="runner-top"><b>Case study lab</b><span>${c.tasks.length} detected task${c.tasks.length === 1 ? '' : 's'}${c.tasks.some((t) => t.answer) ? ' · source guidance available' : ' · no source answer provided in this file'}</span></div>
    <div class="tagrow"><span class="tag">${studioEscape(c.topic)}</span>${isPracticed(c.id) ? '<span class="tag">Practiced ✓</span>' : ''}${isSaved(c.id) ? '<span class="tag muted">Saved ☆</span>' : ''}</div>
    <div class="runner-source">${studioEscape(c.name)}${c.locator && c.locator.page ? ' · page ' + c.locator.page : ''} · <a href="${studioUrl(c.path)}" target="_blank" rel="noopener">open original source ↗</a></div>
    <div class="runner-question">${studioEscape(c.title)}</div>
    ${c.prompt ? `<div class="runner-block"><h4>Problem statement & context (extracted)</h4><div class="case-prompt">${studioEscape(c.prompt)}</div></div>` : ''}
    ${c.tasks.length ? `<div class="runner-block"><h4>Questions / tasks in the source</h4>${c.tasks.map((t, i) => `<div class="case-task"><b>${i + 1}. ${studioEscape(t.question)}</b>${revealed && t.answer ? `<p>${studioEscape(t.answer)}</p>` : revealed ? '<p class="studio-note">No source answer excerpt detected for this task.</p>' : ''}</div>`).join('')}</div>` : `<p class="studio-note">The extractor found no separate question list in this file — treat the problem statement above as the exercise and answer in your own words.</p>`}
    <label class="studio-answer-label" for="studioCaseResponse">Your response / notes</label>
    <textarea id="studioCaseResponse" class="studio-answer" placeholder="Structure: clarify, outline your approach, state an answer…">${studioEscape(stored)}</textarea>
    <div class="studio-actions">
      <button class="smallbtn primary" type="button" onclick="studioSaveCaseResponse()">Save response & mark practised</button>
      <button class="smallbtn" type="button" onclick="studioToggleCaseSave()">${isSaved(c.id) ? 'Saved for later ✓' : 'Save for later ☆'}</button>
      <button class="smallbtn" type="button" onclick="studioToggleCaseReveal()">${revealed ? 'Hide source guidance' : 'Reveal source guidance'}</button>
      <span class="studio-note">Source guidance is only shown when the extracted file actually contains it.</span>
    </div>
    <div class="studio-nav">
      <button class="smallbtn" type="button" onclick="studioCloseCase()">Back to case list</button>
    </div>
  </article>`;
}

function studioSaveCaseResponse() {
  const c = STUDIO.cases.find((x) => x.id === studioState.caseOpen);
  const field = $s('#studioCaseResponse');
  if (!c || !field) return;
  const responses = studioLS('baStudioCaseResponses', {});
  responses[c.id] = { response: field.value, savedAt: Date.now() };
  studioSave('baStudioCaseResponses', responses);
  markPracticed(c.id);
  pushRecent({ id: c.id, kind: 'case', question: c.title, name: c.name }, 'case response saved');
  studioRenderPane();
}
function studioToggleCaseSave() {
  const c = STUDIO.cases.find((x) => x.id === studioState.caseOpen);
  if (c) { toggleSaved({ id: c.id, question: c.title, path: c.path, name: c.name }); studioRenderPane(); }
}
function studioToggleCaseReveal() {
  studioState.reveal = studioState.reveal === studioState.caseOpen ? null : studioState.caseOpen;
  studioRenderPane();
}
function studioCloseCase() { studioState.caseOpen = null; studioState.reveal = null; studioRenderPane(); }

/* ---------------- Module F: job-description prep -------------------------- */

const JD_SYNONYMS = {
  'business analysis': ['business analysis', 'business analyst'],
  'brd / frs': ['brd', 'frs', 'business requirements document', 'functional requirements'],
  'jira / confluence': ['jira', 'confluence'],
  'uat / sit': ['uat', 'sit', 'user acceptance', 'system integration test'],
  'api basics': ['api', 'rest', 'http', 'endpoint'],
  'rtm (traceability)': ['rtm', 'traceability', 'trace matrix'],
  'acceptance criteria': ['acceptance criteria', 'ac ', 'given.when.then'],
  'user stories': ['user stor', 'story writing'],
  'gap analysis': ['gap analysis', 'as-is', 'to-be'],
  'sql': ['sql', ' joins', 'queries', 'database'],
  'bpmn': ['bpmn', 'process map', 'process model', 'visio'],
  'moscow': ['moscow', 'prioriti'],
  'power bi': ['power bi', 'dax', 'power pivot'],
  'excel': ['excel', 'pivot', 'vba', 'power query'],
};

function jdTermsFromText(text) {
  const lower = text.toLowerCase();
  const found = [];
  const seen = new Set();
  const consider = (term) => {
    const key = term.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    const syns = JD_SYNONYMS[key] || [key];
    const count = syns.reduce((n, s) => n + (lower.split(s).length - 1), 0);
    if (count > 0) found.push({ term, hits: count });
  };
  (STUDIO.jdTerms || []).forEach(consider);
  Object.keys(JD_SYNONYMS).forEach(consider);
  // Extra candidate tokens: standalone capitalized words / acronyms of length >= 3
  const stop = new Set(['and', 'the', 'for', 'with', 'you', 'our', 'will', 'are', 'has', 'have', 'this', 'that', 'your', 'must', 'should', 'years', 'experience', 'working', 'role', 'team', 'business', 'analyst', 'analysts', 'requirements', 'required', 'prefer', 'plus', 'good', 'strong', 'ability', 'etc', 'including', 'include', 'such', 'from', 'within', 'who', 'what', 'when', 'all', 'any', 'own', 'work', 'job', 'position', 'candidate', 'looking', 'need', 'needs', 'help', 'build', 'builds', 'using', 'used', 'use', 'tool', 'tools']);
  const caps = text.match(/\b[A-Z][A-Za-z+]{2,}\b|\b[A-Z]{2,}\b/g) || [];
  caps.forEach((w) => { if (!stop.has(w.toLowerCase())) consider(w); });
  return found.sort((a, b) => b.hits - a.hits);
}

function jdSupportFor(term) {
  const syns = JD_SYNONYMS[term.toLowerCase()] || [term.toLowerCase()];
  const match = (hay) => syns.some((s) => hay.includes(s));
  const items = STUDIO.items.filter((x) => match((x.question + ' ' + x.answer + ' ' + x.topic).toLowerCase()));
  const cases = STUDIO.cases.filter((c) => match((c.title + ' ' + c.prompt + ' ' + c.topic).toLowerCase()));
  const framework = STUDIO.framework.parts.flatMap((p) => p.items).filter((it) => match((it.question + ' ' + it.testing + ' ' + it.how + ' ' + it.story).toLowerCase()));
  const total = items.length + cases.length + framework.length;
  const level = total >= 5 ? 'covered' : total > 0 ? 'partial' : 'none';
  return { items, cases, framework, total, level };
}

function jdPaneHTML() {
  const last = studioLS('baStudioJdText', '');
  const notes = studioLS('baStudioJdNotes', {});
  const results = studioLS('baStudioJdResult', null);
  return `<div class="studio-hero">
    <div>
      <div class="readlabel">Module F · powered by the PDF's Part 3 tool ladder</div>
      <h2>Job description preparation</h2>
      <p>Paste a job description. Skills and tools named in it are matched against the indexed repository material. Coverage labels only reflect what exists in this repository — nothing is invented.</p>
    </div>
  </div>
  <div class="panel">
    <label class="studio-answer-label" for="jdText">Job description</label>
    <textarea id="jdText" class="jd-input" placeholder="Paste the job description here…">${studioEscape(last)}</textarea>
    <div class="studio-actions">
      <button class="smallbtn primary" type="button" onclick="studioAnalyzeJd()">Analyze against repository</button>
      <button class="smallbtn" type="button" onclick="studioClearJd()">Clear</button>
    </div>
    ${results ? jdResultsHTML(results, notes) : `<p class="studio-note">Nothing analyzed yet. The PDF's ladder for each matched term: (1) one-line definition, (2) where you used it for real, (3) one trade-off or limitation, (4) one thing that went wrong and how you handled it — fill the notes with your own experience.</p>`}
  </div>`;
}

function jdResultsHTML(results, notes) {
  const cols = [
    { key: 'covered', title: 'Covered by the repository', note: '5 or more indexed practice items mention this term.' },
    { key: 'partial', title: 'Partial coverage', note: 'Some related material exists, but it is thin.' },
    { key: 'none', title: 'No source material found', note: 'Nothing in the repository matched — prepare this one yourself using the ladder.' },
  ];
  return `<p class="studio-count">${results.length} term${results.length === 1 ? '' : 's'} detected in the pasted description.</p>
  <div class="jd-coverage">${cols.map((col) => {
    const terms = results.filter((r) => r.level === col.key);
    return `<div class="jd-col"><h3>${col.title} (${terms.length})</h3><p class="jd-col-note">${col.note}</p>
      ${terms.length ? terms.map((r) => {
        const support = jdSupportFor(r.term);
        const note = notes[r.term] || {};
        return `<div class="jd-term">
          <b>${studioEscape(r.term)}</b> <small>${support.total ? support.total + ' indexed item' + (support.total === 1 ? '' : 's') : 'no matches'} · ${r.hits} mention${r.hits === 1 ? '' : 's'} in the JD</small>
          <div class="item-actions">
            ${support.total ? `<button class="smallbtn primary" type="button" onclick="studioPracticeJdTerm('${studioEscape(r.term)}')">Practice related (${support.total})</button>` : ''}
            <a class="smallbtn" href="#studio" onclick="studioJdJump('${studioEscape(r.term)}')">Ladder notes ↓</a>
          </div>
          <div class="ladder-steps" id="jd-notes-${studioEscape(r.term).replace(/[^a-z0-9]+/gi, '-')}">
            <label>1 · One-line definition<input data-jd-note="${studioEscape(r.term)}" data-step="definition" value="${studioEscape(note.definition || '')}" placeholder="Your definition, in your words"></label>
            <label>2 · Where you used it for real<textarea data-jd-note="${studioEscape(r.term)}" data-step="evidence" rows="2" placeholder="Real example from your work (do not invent one)">${studioEscape(note.evidence || '')}</textarea></label>
            <label>3 · Trade-off or limitation<textarea data-jd-note="${studioEscape(r.term)}" data-step="tradeoff" rows="2" placeholder="One honest limitation">${studioEscape(note.tradeoff || '')}</textarea></label>
            <label>4 · Problem you hit and how you handled it<textarea data-jd-note="${studioEscape(r.term)}" data-step="problem" rows="2" placeholder="Story of something that went wrong and the fix">${studioEscape(note.problem || '')}</textarea></label>
          </div>
        </div>`;
      }).join('') : '<p class="studio-note">None.</p>'}
    </div>`;
  }).join('')}</div>`;
}

function studioAnalyzeJd() {
  const text = ($s('#jdText') || {}).value || '';
  if (!text.trim()) { alert('Paste a job description first.'); return; }
  studioSave('baStudioJdText', text);
  const terms = jdTermsFromText(text).map((t) => ({ ...t, level: jdSupportFor(t.term).level }));
  studioSave('baStudioJdResult', terms);
  studioRenderPane();
}
function studioClearJd() {
  studioSave('baStudioJdText', '');
  studioSave('baStudioJdResult', null);
  studioRenderPane();
}
function studioJdJump(term) {
  const el = document.getElementById('jd-notes-' + term.replace(/[^a-z0-9]+/gi, '-'));
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  return false;
}
function studioPracticeJdTerm(term) {
  const support = jdSupportFor(term);
  const list = [...support.framework.map((it) => ({
    id: it.id, kind: 'framework', question: it.question, answer: [it.testing, it.how, it.story].filter(Boolean).join('\n\n'),
    followUps: it.followUps.map((q) => ({ question: q, answer: '' })), path: STUDIO.framework.frameworkSource, name: STUDIO.framework.frameworkSource, topic: 'Framework',
  })), ...support.items, ...support.cases.map((c) => ({ ...c, question: c.title, answer: c.tasks.filter((t) => t.answer).map((t) => t.question + '\n' + t.answer).join('\n\n') }))];
  if (!list.length) { alert('No indexed items matched this term.'); return; }
  startPractice(list, 'JD term: ' + term, 'jd');
}

function bindJdNotes() {
  $$s('[data-jd-note]').forEach((el) => {
    el.addEventListener('change', () => {
      const notes = studioLS('baStudioJdNotes', {});
      const term = el.dataset.jdNote;
      notes[term] = notes[term] || {};
      notes[term][el.dataset.step] = el.value;
      studioSave('baStudioJdNotes', notes);
    });
  });
}

/* ---------------- Module G: mock interview builder ------------------------ */

function mockPaneHTML() {
  const session = studioLS('baStudioMockSession', null);
  const history = studioLS('baStudioMockHistory', []);
  if (session && !session.finished) return mockSessionHTML(session);
  const finish = session && session.finished ? mockFinishHTML(session) : '';
  return `${finish}
  <div class="studio-hero">
    <div>
      <div class="readlabel">Module G · uses real indexed repository questions</div>
      <h2>Mock interview builder</h2>
      <p>Assemble a timed session from the indexed content: universal framework questions, BA questions, technical questions, situational prompts and case studies. Answers stay in this browser.</p>
    </div>
  </div>
  <div class="panel">
    <div class="mock-options" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px">
      <label>Include content<select id="mockModules">
        <option value="all">Everything (framework + BA + technical + situational + cases)</option>
        <option value="framework">Universal framework questions only</option>
        <option value="question">BA interview questions only</option>
        <option value="technical">Technical practice only</option>
        <option value="situational">Situational &amp; what-if only</option>
        <option value="case">Case studies only</option>
      </select></label>
      <label>Topic<select id="mockTopic"><option value="all">All topics</option>${STUDIO.topics.map((t) => `<option value="${studioEscape(t)}">${studioEscape(t)}</option>`).join('')}</select></label>
      <label>Questions<select id="mockCount"><option>5</option><option selected>10</option><option>15</option><option>20</option></select></label>
      <label>Time limit<select id="mockLength"><option value="15">15 minutes</option><option value="30" selected>30 minutes</option><option value="45">45 minutes</option><option value="0">No limit</option></select></label>
    </div>
    <div class="studio-actions" style="margin-top:14px"><button class="smallbtn primary" type="button" onclick="studioBeginMock()">Start mock interview</button></div>
    <p class="studio-note">Ratings written during a mock session use the same storage as the rest of the dashboard, so they feed your spaced-review queue.</p>
  </div>
  ${history.length ? `<div class="panel"><h3>Recent studio mock sessions</h3>${history.slice(0, 5).map((h) => `<details class="mock-past"><summary>${new Date(h.finishedAt).toLocaleString()} · ${h.answered} of ${h.total} answered · ${h.durationMinutes ? h.durationMinutes + ' minutes' : 'untimed'}</summary>${(h.items || []).map((q, i) => `<div class="mock-past-item"><b>${studioEscape(q.question)}</b><small>${studioEscape(q.name || '')}</small><p><strong>Your response:</strong> ${studioEscape((h.responses || [])[i] || 'No response recorded.')}</p>${q.answer ? `<details><summary>Show source excerpt</summary><pre class="runner-pre">${studioEscape(q.answer)}</pre></details>` : ''}</div>`).join('')}</details>`).join('')}</div>` : ''}`;
}

function studioBuildMockPool(modulePref, topic) {
  let pool = [];
  const fwItems = STUDIO.framework.parts.flatMap((p) => p.items.filter((it) => p.id === 'P1').map((it) => ({
    id: it.id, kind: 'framework', question: it.question,
    answer: [it.testing, it.how, it.story].filter(Boolean).join('\n\n'),
    followUps: it.followUps.map((q) => ({ question: q, answer: '' })),
    path: STUDIO.framework.frameworkSource, name: STUDIO.framework.frameworkSource, topic: 'Universal core',
  })));
  if (modulePref === 'all' || modulePref === 'framework') pool.push(...fwItems);
  if (modulePref === 'all' || modulePref === 'question' || modulePref === 'technical' || modulePref === 'situational') {
    pool.push(...STUDIO.items.filter((x) => modulePref === 'all' || x.kind === modulePref));
  }
  if (modulePref === 'all' || modulePref === 'case') {
    pool.push(...STUDIO.cases.map((c) => ({
      id: c.id, kind: 'case',
      question: c.title + (c.prompt ? '\n\n' + c.prompt.slice(0, 500) : ''),
      answer: c.tasks.filter((t) => t.answer).map((t) => t.question + '\n' + t.answer).join('\n\n'),
      followUps: [], path: c.path, name: c.name, topic: c.topic,
    })));
  }
  if (topic !== 'all') pool = pool.filter((x) => x.topic === topic);
  return pool;
}

function studioBeginMock() {
  const modulePref = ($s('#mockModules') || {}).value || 'all';
  const topic = ($s('#mockTopic') || {}).value || 'all';
  const count = Number(($s('#mockCount') || {}).value || 10);
  const minutes = Number(($s('#mockLength') || {}).value || 30);
  const pool = studioBuildMockPool(modulePref, topic);
  if (!pool.length) { alert('No questions match that combination. Try a different module or topic.'); return; }
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  const items = pool.slice(0, Math.min(count, pool.length)).map(({ id, kind, question, answer, followUps, path, name, topic: t }) => ({ id, kind, question, answer, followUps: followUps || [], path, name, topic: t }));
  const session = {
    startedAt: Date.now(),
    endsAt: minutes ? Date.now() + minutes * 60000 : 0,
    durationMinutes: minutes,
    items, index: 0,
    responses: Array(items.length).fill(''),
    ratings: Array(items.length).fill(''),
    finished: false,
  };
  studioSave('baStudioMockSession', session);
  studioRenderPane();
}

let studioMockTimer = null;
function studioStartMockTimer() {
  if (studioMockTimer) clearInterval(studioMockTimer);
  studioMockTimer = setInterval(() => {
    const s = studioLS('baStudioMockSession', null);
    if (!s || s.finished || !s.endsAt) { clearInterval(studioMockTimer); studioMockTimer = null; return; }
    const el = $s('#studioMockClock');
    if (el) el.textContent = formatMockTime(Math.max(0, Math.ceil((s.endsAt - Date.now()) / 1000)));
    if (s.endsAt <= Date.now()) studioFinishMock();
  }, 1000);
}

function mockSessionHTML(s) {
  const item = s.items[s.index];
  const pct = Math.round(((s.index + 1) / s.items.length) * 100);
  const revealed = studioState.reveal === item.id;
  const status = s.ratings[s.index] || ratingOf(item.id);
  const elapsed = s.endsAt ? Math.max(0, Math.ceil((s.endsAt - Date.now()) / 1000)) : null;
  return `<div class="mock-session-head" style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:10px">
    <div><b>Question ${s.index + 1} of ${s.items.length}</b><small class="studio-note"> ${s.durationMinutes ? s.durationMinutes + '-minute session' : 'untimed session'} · answers save as you type</small></div>
    <div style="display:flex;gap:8px;align-items:center">
      ${s.endsAt ? `<b class="mock-clock" id="studioMockClock" style="font-variant-numeric:tabular-nums">${formatMockTime(elapsed)}</b>` : ''}
      <button class="smallbtn" type="button" onclick="studioFinishMock()">End interview</button>
    </div>
  </div>
  <div class="practice-progress"><span style="width:${pct}%"></span></div>
  <article class="studio-runner">
    <div class="runner-source">${studioEscape(item.name)} · <a href="${studioUrl(item.path)}" target="_blank" rel="noopener">open original source ↗</a></div>
    <div class="runner-question">${studioEscape(item.question)}</div>
    <label class="studio-answer-label" for="studioMockAnswer">Your answer</label>
    <textarea id="studioMockAnswer" class="studio-answer" placeholder="Answer aloud, then jot the key points…">${studioEscape(s.responses[s.index] || '')}</textarea>
    <div class="studio-actions">
      <button class="smallbtn" type="button" id="studioMockReveal" aria-expanded="${revealed}" onclick="studioMockToggleReveal()">${revealed ? 'Hide source answer' : 'Reveal source answer'}</button>
      <span class="studio-note">${(s.responses[s.index] || '').trim() ? 'Response saved in this browser.' : 'Your response saves automatically.'}</span>
    </div>
    <div class="runner-block ${revealed ? '' : 'hide'}">
      ${item.answer
        ? `<h4>Source answer · verbatim excerpt</h4><pre class="runner-pre">${studioEscape(item.answer)}</pre>`
        : `<div class="studio-note">No paired source answer was detected for this item — use the original file link above.</div>`}
    </div>
    <div class="studio-actions">
      <span class="studio-note">How did your answer go?</span>
      <div class="studio-rating">
        <button class="ratebtn ${status === 'know' ? 'studio-selected' : ''}" type="button" aria-pressed="${status === 'know'}" onclick="studioMockRate('know')">Know it</button>
        <button class="ratebtn ${status === 'review' ? 'studio-selected' : ''}" type="button" aria-pressed="${status === 'review'}" onclick="studioMockRate('review')">Review</button>
        <button class="ratebtn ${status === 'work' ? 'studio-selected' : ''}" type="button" aria-pressed="${status === 'work'}" onclick="studioMockRate('work')">Needs work</button>
      </div>
    </div>
    <div class="studio-nav">
      <button class="smallbtn" type="button" onclick="studioMockMove(-1)" ${s.index === 0 ? 'disabled' : ''}>← Previous</button>
      <button class="smallbtn primary" type="button" onclick="${s.index === s.items.length - 1 ? 'studioFinishMock()' : 'studioMockMove(1)'}">${s.index === s.items.length - 1 ? 'Finish interview' : 'Next question →'}</button>
    </div>
  </article>`;
}

function studioMockMove(step) {
  const s = studioLS('baStudioMockSession', null);
  if (!s) return;
  s.index = Math.max(0, Math.min(s.items.length - 1, s.index + step));
  studioSave('baStudioMockSession', s);
  studioState.reveal = null;
  studioRenderPane();
}
function studioMockToggleReveal() {
  const s = studioLS('baStudioMockSession', null);
  if (!s) return;
  const item = s.items[s.index];
  studioState.reveal = studioState.reveal === item.id ? null : item.id;
  studioRenderPane();
}
function studioMockRate(value) {
  const s = studioLS('baStudioMockSession', null);
  if (!s) return;
  const item = s.items[s.index];
  rateItem(item.id, value, { question: item.question.split('\n')[0], name: item.name, path: item.path });
  s.ratings[s.index] = value;
  pushRecent(item, 'mock rated ' + value);
  studioSave('baStudioMockSession', s);
  studioRenderPane();
}
function studioFinishMock() {
  const s = studioLS('baStudioMockSession', null);
  if (!s || s.finished) return;
  s.finished = true;
  s.finishedAt = Date.now();
  studioSave('baStudioMockSession', s);
  const history = studioLS('baStudioMockHistory', []);
  history.unshift({
    finishedAt: s.finishedAt,
    answered: s.responses.filter((x) => x && x.trim()).length,
    total: s.items.length,
    durationMinutes: s.durationMinutes,
    items: s.items.map(({ id, kind, question, answer, path, name }) => ({ id, kind, question, answer, path, name })),
    responses: [...s.responses],
  });
  studioSave('baStudioMockHistory', history.slice(0, 10));
  if (studioMockTimer) { clearInterval(studioMockTimer); studioMockTimer = null; }
  studioState.reveal = null;
  studioRenderPane();
}
function mockFinishHTML(s) {
  return `<div class="panel mock-finish">
    <div class="readlabel">Session complete</div>
    <h2>Studio mock interview finished</h2>
    <p>You answered ${s.responses.filter((x) => x && x.trim()).length} of ${s.items.length} questions. Responses and ratings are saved in this browser.</p>
    <button class="smallbtn primary" type="button" onclick="studioNewMock()">Set up another session</button>
  </div>`;
}
function studioNewMock() {
  localStorage.removeItem('baStudioMockSession');
  studioState.reveal = null;
  studioRenderPane();
}

/* ---------------- Studio home --------------------------------------------- */

function studioHomeHTML() {
  const st = studioStats();
  const recent = studioLS('baStudioRecent', []).slice(0, 6);
  const next = firstUnpracticed();
  return `<div class="studio-hero">
    <div>
      <div class="readlabel">Built from ${STUDIO.stats.sourcesIndexed} indexed repository sources + ${studioEscape(STUDIO.framework.frameworkSource)}</div>
      <h2>Interview Practice Studio</h2>
      <p>Structured practice across the PDF's interview framework, the BA question bank, technical sets, case studies and situational prompts. All question text and answers come from the repository's own extracted sources — nothing is invented. Progress is saved in this browser only and does not sync across devices.</p>
    </div>
    <div class="studio-hero-actions">
      ${next ? `<button class="smallbtn primary" type="button" onclick="studioContinue()">Continue practice →</button>` : ''}
      <a class="smallbtn" href="${studioUrl(STUDIO.framework.frameworkSource)}" target="_blank" rel="noopener">Open ${studioEscape(STUDIO.framework.frameworkSource)} ↗</a>
    </div>
  </div>
  <div class="studio-stats">
    <div class="stat"><b>${st.total.toLocaleString()}</b><small>indexed questions &amp; exercises</small></div>
    <div class="stat"><b>${st.withAnswer.toLocaleString()}</b><small>with source answers</small></div>
    <div class="stat"><b>${st.framework}</b><small>framework questions (PDF)</small></div>
    <div class="stat"><b>${st.questions.toLocaleString()}</b><small>BA questions</small></div>
    <div class="stat"><b>${st.technical.toLocaleString()}</b><small>technical prompts</small></div>
    <div class="stat"><b>${st.situational.toLocaleString()}</b><small>situational prompts</small></div>
    <div class="stat"><b>${st.cases.toLocaleString()}</b><small>case studies (${st.caseWithTasks} with detected tasks)</small></div>
    <div class="stat"><b>${st.practiced.toLocaleString()} / ${st.total.toLocaleString()}</b><small>practiced</small></div>
    <div class="stat"><b>${st.saved.toLocaleString()}</b><small>saved for later</small></div>
    <div class="stat"><b>${st.due.toLocaleString()}</b><small>reviews due</small></div>
  </div>
  <div class="cols">
    <div class="panel">
      <h3>Practice modules</h3>
      <div class="studio-list">
        ${[['framework', 'A · General interview framework', 'The PDF\'s universal core and BA competency module'],
        ['ba', 'B · BA interview questions', st.questions + ' questions from the BA question bank'],
        ['technical', 'C · Technical practice', st.technical + ' SQL / API / BI / tooling prompts'],
        ['cases', 'D · Case study lab', st.cases + ' cases from the case-study folders'],
        ['situational', 'E · Situational & what-if', st.situational + ' scenario prompts'],
        ['jd', 'F · Job description prep', 'Match a JD against the repository, using the tool ladder'],
        ['mock', 'G · Mock interview builder', 'Timed sessions from any of the above']].map(([pane, title, sub]) => `
          <div class="studio-list-item"><div class="item-main"><b>${title}</b><small>${sub}</small></div>
          <div class="item-actions"><button class="smallbtn primary" type="button" onclick="studioGo('${pane}')">Open</button></div></div>`).join('')}
      </div>
    </div>
    <div class="panel">
      <h3>Recently practised</h3>
      ${recent.length ? recent.map((r) => `<div class="studio-recent-item"><span>${studioEscape((r.question || '').slice(0, 90))}${(r.question || '').length > 90 ? '…' : ''}<br><small class="studio-note">${studioEscape(r.name)} · ${studioEscape(r.action)}</small></span><small>${new Date(r.at).toLocaleDateString()}</small></div>`).join('')
      : '<p class="studio-note">Nothing practised in the Studio yet. Answer, mark or rate a question and it will appear here.</p>'}
      <h3 style="margin-top:14px">Extraction notes</h3>
      <p class="studio-note">${STUDIO.issues.length} source files produced no usable prompts for the index (weak extraction or no question structure). They remain readable in the Source library. Index built ${new Date(STUDIO.generatedAt).toLocaleDateString()}.</p>
    </div>
  </div>`;
}

function firstUnpracticed() {
  const practiced = practicedStore();
  return STUDIO.items.find((x) => !practiced[x.id]) || STUDIO.cases.find((c) => !practiced[c.id]) || null;
}
function studioContinue() {
  const next = firstUnpracticed();
  if (!next) { alert('Every indexed item is practised — try the mock builder or review queue.'); return; }
  if (next.kind === 'case') { studioOpenCase(next.id); return; }
  const kind = next.kind;
  const list = applyFilters(poolFor(kind));
  const pool = list.some((x) => x.id === next.id) ? list : poolFor(kind);
  startPractice(pool, MODULE_LABEL[kind] || 'Practice', 'home');
  const at = pool.findIndex((x) => x.id === next.id);
  if (at >= 0) studioState.runner.at = at;
  studioRenderPane();
}

/* ---------------- routing & boot ------------------------------------------ */

function studioGo(pane) {
  studioState.pane = pane;
  studioState.runner = null;
  studioState.caseOpen = null;
  studioState.reveal = null;
  studioRenderPane();
  const el = $s('#studio');
  if (el) el.scrollIntoView({ block: 'start' });
}

function studioRenderPane() {
  const host = $s('#studioBody');
  if (!host || !STUDIO) return;
  const tabs = `<div class="studio-tabs" role="tablist">${Object.entries(PANE_LABEL).map(([key, label]) =>
    `<button role="tab" type="button" aria-selected="${studioState.pane === key}" class="${studioState.pane === key ? 'active' : ''}" onclick="studioGo('${key}')">${label}</button>`).join('')}</div>`;
  let body = '';
  switch (studioState.pane) {
    case 'framework': body = frameworkHTML(); break;
    case 'ba': body = listPaneHTML('question', 'BA interview questions'); break;
    case 'technical': body = listPaneHTML('technical', 'Technical practice'); break;
    case 'situational': body = listPaneHTML('situational', 'Situational practice'); break;
    case 'cases': body = casesPaneHTML(); break;
    case 'jd': body = jdPaneHTML(); break;
    case 'mock': body = mockPaneHTML(); break;
    default: body = studioHomeHTML();
  }
  host.innerHTML = `<div class="studio-shell">${tabs}<div class="studio-pane active" id="studioPane">${body}</div></div>`;
  bindFilterBar(host);
  bindJdNotes();
  if (studioState.pane === 'mock' && studioLS('baStudioMockSession', null) && !studioLS('baStudioMockSession', null).finished) studioStartMockTimer();
  const crumb = $s('#crumb');
  if (crumb) crumb.textContent = 'Workspace / Interview Practice Studio / ' + (PANE_LABEL[studioState.pane] || 'Studio');
  // Practice textareas: save as you type
  const answer = $s('#studioAnswer');
  if (answer) answer.addEventListener('input', () => {
    const item = studioState.runner.list[studioState.runner.at];
    setAnswer(item.id, answer.value);
  });
  const mockAnswer = $s('#studioMockAnswer');
  if (mockAnswer) mockAnswer.addEventListener('input', () => {
    const s = studioLS('baStudioMockSession', null);
    if (!s) return;
    s.responses[s.index] = mockAnswer.value;
    studioSave('baStudioMockSession', s);
  });
  const caseResponse = $s('#studioCaseResponse');
  if (caseResponse) caseResponse.addEventListener('input', () => {
    const responses = studioLS('baStudioCaseResponses', {});
    responses[studioState.caseOpen] = { response: caseResponse.value, savedAt: Date.now() };
    studioSave('baStudioCaseResponses', responses);
  });
}

function studioOnShow() {
  if (!STUDIO) {
    const host = $s('#studioBody');
    if (host) host.innerHTML = '<div class="studio-empty">studio_index.js could not be loaded. Regenerate it with <code>node scripts/build-studio-index.js</code> and reload.</div>';
    return;
  }
  studioRenderPane();
}

// Expose handlers used in inline onclick attributes.
Object.assign(window, {
  studioGo, studioResetFilters, studioPracticeFiltered, studioPracticeById, studioMove, studioExitRunner,
  studioToggleReveal, studioSubmitAnswer, studioToggleSave, studioTogglePracticed, studioRate,
  studioPracticeRelated, studioRateFramework, studioOpenCase, studioCloseCase, studioSaveCaseResponse,
  studioToggleCaseSave, studioToggleCaseReveal, studioAnalyzeJd, studioClearJd, studioJdJump, studioPracticeJdTerm,
  studioBeginMock, studioMockMove, studioMockToggleReveal, studioMockRate, studioFinishMock, studioNewMock,
  studioContinue, studioOnShow,
});
