/* Interview Practice Studio
 * Loads after dashboard.html's inline script and dashboard_data.js / studio_index.js.
 * Reuses the dashboard's $ / all / safe / url / dateKey / dueAfter helpers and its
 * localStorage progress stores (baPracticedQuestions, baQuestionRatings,
 * baSavedQuestions, baQuestionAnswers) so Studio progress is shared with the
 * existing Question practice, Review queue, Saved questions and Coverage views.
 * Studio-only state uses the baStudio* namespace. Progress is stored locally and
 * syncs across devices after sign-in.
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
  aiDraft: null,
  aiGenerating: false,
  aiMessage: '',
};

const MODULE_LABEL = { B: 'BA interview questions', C: 'Technical practice', E: 'Situational & what-if' };
const PANE_LABEL = {
  home: 'Studio home', framework: 'General interview framework', ba: 'BA interview questions',
  technical: 'Technical practice', cases: 'Case study lab', situational: 'Situational practice',
  jd: 'Job description prep', mock: 'Mock interview builder',
};

function studioEscape(v) { return typeof safe === 'function' ? safe(v) : String(v ?? ''); }
function studioUrl(p) {
  if (p == null || p === '') return '#';
  return typeof url === 'function' ? url(String(p)) : encodeURI(String(p).split('\\').join('/'));
}

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
  const aiDraft = studioState.aiDraft && studioState.aiDraft.id === item.id ? studioState.aiDraft : null;
  const followUps = item.followUps || [];
  const locator = item.locator && item.locator.page ? ` · page ${item.locator.page}` : '';
  return `<article class="studio-runner">
    <div class="runner-top">
      <b>${studioEscape(r.title)} · question ${r.at + 1} of ${r.list.length}</b>
    <span>${item.generated ? 'Custom prompt based on this JD' : hasAnswer(item) ? 'Source answer text available' : 'No paired answer in source — open the original file'}</span>
    </div>
    <div class="practice-progress"><span style="width:${pct}%"></span></div>
    <div class="tagrow">
      <span class="tag">${studioEscape(item.generated ? 'JD practice' : item.kind === 'question' ? 'BA question' : item.kind === 'technical' ? 'Technical' : 'Situational')}</span>
      ${item.topic ? `<span class="tag muted">${studioEscape(item.topic)}</span>` : ''}
      ${practiced ? '<span class="tag">Practiced ✓</span>' : ''}
      ${saved ? '<span class="tag muted">Saved ☆</span>' : ''}
      ${status ? `<span class="tag ${status === 'work' ? 'warn' : ''}">${status === 'know' ? 'Know it' : status === 'review' ? 'Review' : 'Needs work'}</span>` : ''}
    </div>
    <div class="runner-source">${item.generated ? 'Built from the role details and requirements in your JD.' : `${studioEscape(item.name)}${locator} · <a href="${studioUrl(item.path)}" target="_blank" rel="noopener">open original source ↗</a>`}</div>
    <div class="runner-question">${studioEscape(item.question)}</div>
    <div class="studio-ai-answer">
      <button class="smallbtn" type="button" onclick="studioGenerateAnswer()" ${studioState.aiGenerating ? 'disabled' : ''}>${studioState.aiGenerating ? 'Generating draft…' : 'Generate personalized draft'}</button>
      <details><summary>Optional: add a work example or detail to emphasize</summary><textarea id="studioAiContext" rows="3" placeholder="Add a real example or detail you want the draft to use. Do not include confidential information."></textarea></details>
      <span class="studio-status" id="studioAiStatus">${studioEscape(studioState.aiMessage || 'Drafts use candidate project/profile evidence and are checked before display. Generic study examples are not treated as your experience.')}</span>
      ${aiDraft ? `<section class="studio-ai-preview"><h4>AI answer draft · review before using</h4><textarea id="studioAiDraftText" rows="8">${studioEscape(aiDraft.draft)}</textarea><div class="studio-note">Evidence used: ${aiDraft.sources.map((source) => `[${studioEscape(source.id)}] ${studioEscape(source.source)} (${studioEscape(source.kind)})`).join(' · ') || 'No matching excerpts'}</div><div class="studio-actions"><button class="smallbtn primary" type="button" onclick="studioAcceptAiDraft()">Use and save draft</button><button class="smallbtn" type="button" onclick="studioDiscardAiDraft()">Discard</button></div><p class="studio-note">Using a draft saves it to your answer without marking the question practiced. Review it, then use the existing practice controls if you want to mark it practiced.</p></section>` : ''}
    </div>
    <label class="studio-answer-label" for="studioAnswer">Your answer</label>
    <textarea id="studioAnswer" class="studio-answer" placeholder="Answer aloud first, then jot down the key points…">${studioEscape(stored)}</textarea>
    <div class="studio-actions">
      <button class="smallbtn primary" type="button" onclick="studioSubmitAnswer()">Save answer & mark practiced</button>
      <button class="smallbtn" type="button" onclick="studioToggleSave()">${saved ? 'Saved for later ✓' : 'Save for later ☆'}</button>
      <button class="smallbtn" type="button" onclick="studioTogglePracticed()">${practiced ? 'Unmark practiced' : 'Mark practiced'}</button>
      <span class="studio-status" id="studioAnswerStatus">${stored ? 'Response saved locally; syncs when signed in.' : 'Submit a non-empty answer to mark this question practiced.'}</span>
    </div>
    <div class="studio-actions">
      <button class="smallbtn" type="button" id="studioReveal" aria-expanded="${revealed}" onclick="studioToggleReveal()">${revealed ? 'Hide source answer' : 'Reveal source answer'}</button>
    </div>
    <div class="runner-block ${revealed ? '' : 'hide'}">
      ${item.generated
        ? '<div class="studio-note">This is a practice prompt. Build your answer from your own work examples; the tool does not supply a model answer.</div>'
        : hasAnswer(item)
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
    <p class="studio-note">${item.generated ? 'Answer with truthful examples from your experience. Opening a prompt does not mark it practiced — use the buttons above.' : 'Question and answer text come from the linked repository source. Opening a question does not mark it practiced — use the buttons above.'}</p>
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
async function studioGenerateAnswer() {
  const r = studioState.runner;
  if (!r || studioState.aiGenerating) return;
  const item = r.list[r.at];
  const status = $s('#studioAiStatus');
  const csrf = window.BAState?.getCsrfToken?.();
  if (!csrf) { if (status) status.textContent = 'Sign in first to generate a personalized draft.'; return; }
  studioState.aiGenerating = true;
  studioState.aiMessage = '';
  studioRenderPane();
  try {
    const response = await fetch('/api/ai/personalized-answer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: JSON.stringify({
        question: item.question,
        jobDescription: localStorage.getItem('baStudioJdText') || '',
        personalContext: $s('#studioAiContext')?.value || '',
      }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      const messages = { ai_not_configured: 'AI answer generation is not configured on this deployment.', unauthenticated: 'Sign in again to generate a draft.', forbidden: 'This account is not allowed to generate a draft.', csrf_failed: 'Your session changed. Refresh the page and try again.', ai_rate_limited: 'Groq is rate limiting requests. Try again shortly.', insufficient_evidence: 'I could not find enough verified project or profile evidence for a personal answer. Add accurate details in the context box and try again.', ai_evidence_unverified: 'I blocked this draft because I could not verify every factual claim against your evidence. Add accurate details in the context box and try again.' };
      throw new Error(messages[result.error] || 'The draft could not be generated. Try again.');
    }
    if (!studioState.runner || studioState.runner.list[studioState.runner.at].id !== item.id) return;
    studioState.aiDraft = { id: item.id, draft: result.draft, sources: result.sources || [] };
  } catch (error) {
    studioState.aiMessage = error.message;
  } finally {
    studioState.aiGenerating = false;
    studioRenderPane();
  }
}
function studioAcceptAiDraft() {
  const draft = studioState.aiDraft;
  const field = $s('#studioAiDraftText');
  if (!draft || !field) return;
  const value = field.value.trim();
  if (!value) return;
  setAnswer(draft.id, value);
  studioState.aiDraft = null;
  studioState.aiMessage = 'Draft saved to your answer. It was not marked practiced.';
  studioRenderPane();
}
function studioDiscardAiDraft() { studioState.aiDraft = null; studioState.aiMessage = 'Draft discarded.'; studioRenderPane(); }
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
    <p class="studio-count">${list.length} of ${base.length} items · ${practiced} practiced · answers save locally and sync when signed in</p>
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
      ${(it.followUps || []).length ? `<div><h4>Likely follow-ups</h4><ul class="fw-followups">${(it.followUps || []).map((q) => `<li>${studioEscape(q)}</li>`).join('')}</ul></div>` : ''}
      <div class="studio-actions">
        <button class="smallbtn primary" type="button" onclick="studioPracticeRelated('${it.id}')">Practice related repository questions</button>
        <button class="smallbtn" type="button" onclick="studioRateFramework('${it.id}','know')" aria-pressed="${ratingOf(it.id) === 'know'}">Mark rehearsed ✓</button>
      </div>
      ${ratingOf(it.id) ? `<p class="studio-note">Your status: ${ratingOf(it.id) === 'know' ? 'Rehearsed' : ratingOf(it.id)} (saved locally; syncs when signed in; included in the review queue).</p>` : ''}
    </div>
  </details>`;
  return `<div class="studio-hero">
    <div>
      <div class="readlabel">Source: ${studioEscape(STUDIO.frameworkSource)} (repository copy)</div>
      <h2>${studioEscape(f.title)}</h2>
      <p>${studioEscape(f.subtitle)} — Part 1 is the universal core, Part 2 the Business Analyst module, Part 3 the job-description tool ladder. Answer guides are structures to fill with your own examples, not scripts to memorise.</p>
    </div>
    <div class="studio-hero-actions">
      <a class="smallbtn primary" href="${studioUrl(STUDIO.frameworkSource)}" target="_blank" rel="noopener">Open ${studioEscape(STUDIO.frameworkSource)} ↗</a>
    </div>
  </div>
  <div class="cols">
    <div class="panel"><h3>Your proof points (from the PDF)</h3>${f.proofPoints.map((p) => `<div class="focus-item"><b>${studioEscape(p)}</b></div>`).join('')}</div>
    <div class="panel"><h3>Do not claim (from the PDF)</h3>${f.doNotClaim.map((p) => `<div class="focus-item"><b>${studioEscape(p)}</b></div>`).join('')}</div>
  </div>
  <div class="studyhead"><h2>${studioEscape(part1.title)}</h2><p>Prepare each once; almost every interview uses them.</p></div>
  <div class="framework-grid">${part1.items.map(item).join('')}</div>
  <div class="studyhead"><h2>${studioEscape(part2.title)}</h2><p>Role-specific competency questions with the PDF's own guidance and follow-ups.</p></div>
  <div class="framework-grid">${part2.items.map(item).join('')}</div>
  <div class="studyhead"><h2>${studioEscape(part3.title)}</h2><p>${studioEscape(f.jdLadder ? f.jdLadder.text : '')}</p></div>
  <div class="panel">
    <h3>The ladder, for every tool or term in a job description</h3>
    <ol class="fw-followups">${(f.jdLadder ? f.jdLadder.steps : []).map((s) => `<li>${studioEscape(s)}</li>`).join('')}</ol>
    <p class="studio-note">Terms the role usually lists (from the PDF): ${(f.jdTerms || []).map(studioEscape).join(', ')}.</p>
    <h3 style="margin-top:12px">Questions to ask the interviewer (from the PDF)</h3>
    <ul class="fw-followups">${f.questionsForInterviewer.map((q) => `<li>${studioEscape(q)}</li>`).join('')}</ul>
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
  rateItem(id, 'know', { question: 'Framework: ' + id, name: STUDIO.frameworkSource, path: STUDIO.frameworkSource });
  pushRecent({ id, kind: 'framework', question: id, name: STUDIO.frameworkSource }, 'marked rehearsed');
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
  'brd / frs': ['brd', 'frd', 'frs', 'business requirements document', 'functional requirements'],
  'jira / confluence': ['jira', 'confluence'],
  'uat / sit': ['uat', 'user acceptance', 'system integration test'],
  'api basics': ['api', 'rest', 'http', 'endpoint'],
  'rtm (traceability)': ['rtm', 'traceability', 'trace matrix'],
  'acceptance criteria': ['acceptance criteria', 'ac ', 'given.when.then'],
  'user stories': ['user stor', 'story writing'],
  'gap analysis': ['gap analysis', 'as-is', 'to-be'],
  'sql': ['sql'],
  'bpmn': ['bpmn', 'process map', 'process model', 'visio'],
  'moscow': ['moscow', 'prioriti'],
  'power bi': ['power bi', 'dax', 'power pivot'],
  'excel': ['excel', 'pivot', 'vba', 'power query'],
  'requirements gathering & elicitation': ['requirements gathering', 'requirement gathering', 'gathering requirements', 'requirements elicitation', 'elicitation'],
  'functional specifications': ['functional specification', 'functional specifications', 'functional requirements'],
  'use cases': ['use case', 'use cases'],
  'process workflows': ['process workflow', 'process workflows', 'workflow', 'workflows', 'process flow', 'process mapping'],
  'stakeholder management': ['stakeholder management'],
  'meetings & workshops': ['stakeholder meeting', 'stakeholder meetings', 'workshop', 'workshops'],
  'cross-functional delivery': ['coordinate with developers', 'developers and project managers', 'project manager coordination'],
  'communication': ['communication'],
  'telecom domain': ['telecom', 'telecommunications', 'telco'],
  'data analysis': ['data analysis', 'data analytics'],
  'test cases & issue tracking': ['test case', 'test cases', 'issue tracking', 'track issues', 'defect tracking'],
  'agile / project delivery': ['agile', 'project delivery'],
  'process improvement': ['process improvement', 'continuous improvement'],
  'analytical & problem solving': ['analytical', 'problem-solving', 'problem solving'],
  'business documentation': ['business documentation', 'user manual', 'user manuals', 'process document', 'process documents'],
};

const JD_CHECKLIST_RULES = [
  { category: 'Business analysis', label: 'Business analysis experience', supportTerm: 'business analysis', matches: ['business analysis', 'business analyst'] },
  { category: 'Requirements & documentation', label: 'Requirements gathering & elicitation', supportTerm: 'requirements gathering & elicitation', matches: ['requirement gathering', 'requirements gathering', 'gathering requirements', 'elicitation'] },
  { category: 'Requirements & documentation', label: 'BRD / FRD', supportTerm: 'brd / frs', matches: ['brd', 'frd', 'business requirements document', 'functional requirements document'] },
  { category: 'Requirements & documentation', label: 'Functional specifications', supportTerm: 'functional specifications', matches: ['functional specification', 'functional specifications', 'functional spec'] },
  { category: 'Requirements & documentation', label: 'Use cases', supportTerm: 'use cases', matches: ['use case', 'use cases'] },
  { category: 'Requirements & documentation', label: 'Process workflows', supportTerm: 'process workflows', matches: ['process workflow', 'process workflows', 'workflow', 'workflows', 'process flow'] },
  { category: 'Requirements & documentation', label: 'Business documentation & user manuals', supportTerm: 'business documentation', matches: ['business documentation', 'user manual', 'process document'] },
  { category: 'Stakeholders & delivery', label: 'Stakeholder management', supportTerm: 'stakeholder management', matches: ['stakeholder management', 'stakeholder', 'stakeholders'] },
  { category: 'Stakeholders & delivery', label: 'Meetings & workshops', supportTerm: 'meetings & workshops', matches: ['stakeholder meeting', 'stakeholder meetings', 'workshop', 'workshops'] },
  { category: 'Stakeholders & delivery', label: 'Developer / project manager coordination', supportTerm: 'cross-functional delivery', matches: ['developer', 'developers', 'project manager', 'project managers', 'coordinate with'] },
  { category: 'Stakeholders & delivery', label: 'Communication', supportTerm: 'communication', matches: ['communication'] },
  { category: 'Data & tools', label: 'Excel', supportTerm: 'excel', matches: ['excel', 'pivot table', 'power query', 'vba'] },
  { category: 'Data & tools', label: 'SQL', supportTerm: 'sql', matches: ['sql', 'database query', 'database queries'] },
  { category: 'Data & tools', label: 'Data analysis', supportTerm: 'data analysis', matches: ['data analysis', 'data analytics', 'analyze data', 'analyse data'] },
  { category: 'Testing & delivery', label: 'UAT', supportTerm: 'uat / sit', matches: ['uat', 'user acceptance testing', 'user acceptance test'] },
  { category: 'Testing & delivery', label: 'Test cases & issue tracking', supportTerm: 'test cases & issue tracking', matches: ['test case', 'test cases', 'track issues', 'issue tracking'] },
  { category: 'Testing & delivery', label: 'Agile / project delivery', supportTerm: 'agile / project delivery', matches: ['agile', 'project delivery'] },
  { category: 'Process improvement & strengths', label: 'Process improvement', supportTerm: 'process improvement', matches: ['process improvement', 'process improvements', 'improve processes'] },
  { category: 'Process improvement & strengths', label: 'Analytical & problem-solving skills', supportTerm: 'analytical & problem solving', matches: ['analytical', 'problem-solving', 'problem solving'] },
  { category: 'Domain knowledge', label: 'Telecom domain', supportTerm: 'telecom domain', matches: ['telecom', 'telecommunications', 'telco'] },
];

function jdHasPhrase(text, phrase) {
  const escaped = phrase.trim().toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return new RegExp(`(^|[^a-z0-9])(${escaped})(?=$|[^a-z0-9])`, 'i').test(text);
}

function jdRequirementsFromText(text) {
  const lower = String(text || '').toLowerCase();
  const lines = String(text || '').split(/\r?\n/);
  const facts = {};
  ['role', 'experience', 'location'].forEach((key) => {
    const match = String(text || '').match(new RegExp(`^\\s*${key}\\s*:\\s*(.+)$`, 'im'));
    if (match) facts[key] = match[1].trim();
  });
  const occurrences = new Map();
  let section = 'general';
  lines.forEach((line) => {
    const heading = line.trim().replace(/:$/, '').toLowerCase();
    if (/^(required skills|requirements|qualifications|what you bring)$/.test(heading)) section = 'required';
    else if (/^(key responsibilities|responsibilities|what you will do)$/.test(heading)) section = 'responsibility';
    else if (/^(about the role|role overview|job description)$/.test(heading)) section = 'general';
    JD_CHECKLIST_RULES.forEach((rule) => {
      if (rule.matches.some((phrase) => jdHasPhrase(line.toLowerCase(), phrase))) {
        const ranks = { general: 1, responsibility: 2, required: 3 };
        occurrences.set(rule.label, Math.max(occurrences.get(rule.label) || 0, ranks[section]));
      }
    });
  });
  const requirements = JD_CHECKLIST_RULES.filter((rule) => rule.matches.some((phrase) => jdHasPhrase(lower, phrase)))
    .map((rule, index) => {
      let weight = occurrences.get(rule.label) || 1;
      if (rule.category === 'Domain knowledge' && weight < 2) weight = 2;
      const emphasis = weight === 3 ? 'Required skill' : rule.category === 'Domain knowledge' ? 'Core role requirement' : weight === 2 ? 'Key responsibility' : 'JD requirement';
      return { id: `jd-req-${index + 1}`, category: rule.category, label: rule.label, supportTerm: rule.supportTerm, emphasis, emphasisWeight: weight, checked: true, custom: false };
    });
  return { facts, requirements };
}

const JD_RELATED_TOPICS = {
  'business analysis': ['General BA', 'Systems analysis'],
  'requirements gathering & elicitation': ['Requirements & elicitation', 'Stakeholder management'],
  'brd / frs': ['Requirements & elicitation', 'Documentation'],
  'functional specifications': ['Documentation', 'Systems analysis'],
  'use cases': ['Requirements & elicitation', 'Systems analysis', 'Documentation'],
  'process workflows': ['Process mapping', 'Documentation'],
  'business documentation': ['Documentation'],
  'stakeholder management': ['Stakeholder management', 'Change management'],
  'meetings & workshops': ['Stakeholder management', 'Change management'],
  'cross-functional delivery': ['Agile & Scrum', 'Systems analysis', 'Change management'],
  'communication': ['Stakeholder management', 'Change management'],
  'excel': ['Data analysis'],
  'sql': ['Data analysis', 'Systems analysis'],
  'data analysis': ['Data analysis', 'Systems analysis'],
  'uat / sit': ['UAT & testing'],
  'test cases & issue tracking': ['UAT & testing', 'Traceability'],
  'agile / project delivery': ['Agile & Scrum', 'Change management'],
  'process improvement': ['Process mapping', 'Change management'],
  'analytical & problem solving': ['Data analysis', 'Systems analysis'],
  'telecom domain': [],
};

function jdPhraseIndex(text, phrase) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  const escaped = phrase.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  const match = normalized.match(new RegExp(`(^|[^a-z0-9])(${escaped})(?=$|[^a-z0-9])`, 'i'));
  return match ? match.index + match[1].length : -1;
}

function jdEvidenceExcerpt(text, index, phrase) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  const at = Math.max(0, index);
  const start = Math.max(0, at - 75);
  const end = Math.min(clean.length, at + Math.max(phrase.length, 1) + 115);
  return `${start ? '…' : ''}${clean.slice(start, end)}${end < clean.length ? '…' : ''}`;
}

const jdSupportCache = new Map();

function jdSupportFor(term) {
  const key = term.toLowerCase();
  if (jdSupportCache.has(key)) return jdSupportCache.get(key);
  const aliases = (JD_SYNONYMS[key] || [key]).map((s) => s.trim()).filter(Boolean);
  const relatedTopics = JD_RELATED_TOPICS[key] || [];
  const evidence = [];
  const add = (record, fields, meta) => {
    const text = fields.filter(Boolean).join(' ');
    const phrase = aliases.find((alias) => jdPhraseIndex(text, alias) >= 0);
    const direct = !!phrase;
    if (!direct && !relatedTopics.includes(meta.topic)) return;
    const evidenceText = direct ? text : (meta.preview || text);
    const matchAt = direct ? jdPhraseIndex(evidenceText, phrase) : 0;
    evidence.push({
      id: record.id || meta.path,
      kind: meta.kind,
      path: meta.path,
      name: meta.name,
      topic: meta.topic,
      relation: direct ? 'direct' : 'related',
      matchedText: direct ? phrase : meta.topic,
      excerpt: jdEvidenceExcerpt(evidenceText, matchAt, direct ? phrase : ''),
      record,
    });
  };
  STUDIO.items.forEach((x) => add(x, [x.question, x.answer], { kind: x.kind, path: x.path, name: x.name, topic: x.topic, preview: x.question }));
  STUDIO.cases.forEach((c) => add(c, [c.title, c.prompt], { kind: 'case', path: c.path, name: c.name, topic: c.topic, preview: c.title + ': ' + c.prompt }));
  STUDIO.framework.parts.flatMap((p) => p.items).forEach((it) => add(it, [it.question, it.testing, it.how, it.story], { kind: 'framework', path: STUDIO.frameworkSource, name: STUDIO.frameworkSource, topic: 'Framework', preview: it.question }));
  const directEvidence = evidence.filter((e) => e.relation === 'direct');
  const relatedEvidence = evidence.filter((e) => e.relation === 'related');
  const matching = evidence.filter((e) => e.relation === 'direct');
  const related = evidence.filter((e) => e.relation === 'related');
  const items = STUDIO.items.filter((x) => matching.some((e) => e.id === x.id) || related.some((e) => e.id === x.id));
  const cases = STUDIO.cases.filter((x) => matching.some((e) => e.id === x.id) || related.some((e) => e.id === x.id));
  const framework = STUDIO.framework.parts.flatMap((p) => p.items).filter((x) => matching.some((e) => e.id === x.id) || related.some((e) => e.id === x.id));
  const directTotal = directEvidence.length;
  const relatedTotal = relatedEvidence.length;
  const result = {
    items, cases, framework, evidence, directEvidence, relatedEvidence,
    directTotal, relatedTotal, total: directTotal + relatedTotal,
    level: directTotal ? 'direct' : relatedTotal ? 'related' : 'none',
  };
  jdSupportCache.set(key, result);
  return result;
}

function jdEvidenceHTML(records, relation) {
  if (!records.length) return '';
  const title = relation === 'direct' ? 'Direct phrase matches' : 'Related material by topic';
  return `<div class="jd-evidence"><b>${title} (${records.length})</b>${records.slice(0, 3).map((e) => `<div class="jd-evidence-item"><small>${studioEscape(e.name)}${e.topic ? ` · ${studioEscape(e.topic)}` : ''} · matched ${studioEscape(e.matchedText)}</small><p>${studioEscape(e.excerpt)}</p><a href="${studioUrl(e.path)}" target="_blank" rel="noopener">Open source ↗</a></div>`).join('')}${records.length > 3 ? `<small class="studio-note">Showing 3 of ${records.length} matching sources.</small>` : ''}</div>`;
}

function jdPriorityFor(result, support, confidence) {
  const confidenceWeight = { unrated: 2, 'needs-work': 3, 'some-practice': 2, ready: 1 }[confidence] || 2;
  const evidenceWeight = support.level === 'none' ? 1 : support.level === 'related' ? 0.5 : 0;
  const score = (result.emphasisWeight || 1) * confidenceWeight + evidenceWeight;
  const priority = score >= 6 ? 'High' : score >= 3 ? 'Medium' : 'Low';
  const confidenceLabel = { unrated: 'Confidence not rated', 'needs-work': 'You marked this as needing practice', 'some-practice': 'You marked this as needing more practice', ready: 'You marked this as ready' }[confidence] || 'Confidence not rated';
  const evidenceLabel = support.level === 'none' ? 'No indexed source matched' : support.level === 'related' ? 'Only related topic material was found' : 'Direct source material is available';
  const nextStep = support.level === 'direct'
    ? 'Practice a matching prompt, then prepare a real example.'
    : support.level === 'related'
      ? 'Review related sources, then prepare a role-specific example.'
      : 'Prepare a personal example and verify it against the JD.';
  return { score, priority, reasons: [result.emphasis || 'JD requirement', confidenceLabel, evidenceLabel], nextStep };
}

function jdPlanHTML(results) {
  const confidence = studioLS('baStudioJdConfidence', {});
  const notes = studioLS('baStudioJdNotes', {});
  const checklist = studioLS('baStudioJdChecklist', null);
  const checklistRequirements = checklist && Array.isArray(checklist.requirements) ? checklist.requirements : [];
  const ranked = results.map((r) => {
    // Older saved analyses may predate emphasis fields; restore them from the editable checklist.
    const meta = checklistRequirements.find((item) => item.id === r.id)
      || checklistRequirements.find((item) => item.label === r.term || item.supportTerm === r.supportTerm);
    const enriched = {
      ...r,
      emphasis: r.emphasis || (meta && meta.emphasis),
      emphasisWeight: r.emphasisWeight || (meta && meta.emphasisWeight) || 1,
    };
    const support = jdSupportFor(r.supportTerm || r.term);
    const key = r.id || r.term;
    return { r: enriched, support, key, ...jdPriorityFor(enriched, support, confidence[key] || 'unrated') };
  }).sort((a, b) => b.score - a.score);
  if (!ranked.length) return '';
  const readyCount = ranked.filter(({ key }) => confidence[key] === 'ready').length;
  const ratedCount = ranked.filter(({ key }) => ['needs-work', 'some-practice', 'ready'].includes(confidence[key])).length;
  const exampleCount = ranked.filter(({ r }) => String((notes[r.term] || {}).evidence || '').trim()).length;
  const readyPercent = Math.round((readyCount / ranked.length) * 100);
  const row = (item, index) => `<li class="jd-plan-item"><span class="jd-plan-rank">${index + 1}</span><div class="jd-plan-main"><div class="jd-plan-title"><b>${studioEscape(item.r.term)}</b><span class="jd-priority ${item.priority.toLowerCase()}">${item.priority} priority</span></div><p>${item.nextStep}</p><small>${item.reasons.map(studioEscape).join(' · ')}</small><a href="#jd-result-${String(item.r.id || item.r.term).replace(/[^a-z0-9]+/gi, '-')}">Open requirement details ↓</a></div></li>`;
  return `<section class="jd-plan" id="jdPrepPlan"><div class="jd-plan-head"><div><h3>Your preparation order</h3><p>Prioritized from JD emphasis, your confidence, and repository evidence. Change a confidence rating to update this order.</p><div class="studio-actions"><button class="smallbtn primary" type="button" onclick="studioStartJdPractice('questions')">Start JD-specific practice · 6 prompts</button><button class="smallbtn" type="button" onclick="studioStartJdPractice('case')">Run complete case exercise</button><button class="smallbtn" type="button" onclick="studioStartJdPractice('seniority-domain')">Senior BA & telecom drills</button></div></div></div><section class="jd-readiness" aria-label="Persistent readiness tracker"><div class="jd-readiness-top"><b>Readiness tracker</b><span>${readyCount} of ${ranked.length} marked ready</span></div><div class="jd-readiness-bar" role="progressbar" aria-label="Requirements self-rated ready" aria-valuemin="0" aria-valuemax="${ranked.length}" aria-valuenow="${readyCount}"><span style="width:${readyPercent}%"></span></div><div class="jd-readiness-stats"><span>${ratedCount} confidence ratings set</span><span>${exampleCount} personal work examples saved</span></div><small>Saved in this browser. Mark a requirement Ready only when you can support it with a real example.</small></section><ol class="jd-plan-list">${ranked.slice(0, 5).map(row).join('')}</ol>${ranked.length > 5 ? `<details class="jd-plan-more"><summary>Show remaining ${ranked.length - 5} requirements</summary><ol class="jd-plan-list" start="6">${ranked.slice(5).map((item, index) => row(item, index + 5)).join('')}</ol></details>` : ''}</section>`;
}

function jdPaneHTML() {
  // Practice launched from JD prep stores its session in the shared runner state.
  // Render that session here just as the other practice panes do.
  if (studioState.runner) return runnerHTML();
  const last = studioLS('baStudioJdText', '');
  const notes = studioLS('baStudioJdNotes', {});
  const results = studioLS('baStudioJdResult', null);
  const checklist = studioLS('baStudioJdChecklist', null);
  const facts = checklist && checklist.facts || {};
  return `<div class="studio-hero">
    <div>
      <div class="readlabel">Module F · powered by the PDF's Part 3 tool ladder</div>
      <h2>Job description preparation</h2>
      <p>Paste the job description, review the extracted requirements, then choose which ones to prepare. Role details stay separate from skill requirements.</p>
    </div>
  </div>
  <div class="panel">
    <label class="studio-answer-label" for="jdText">Job description</label>
    <textarea id="jdText" class="jd-input" placeholder="Paste the job description here…">${studioEscape(last)}</textarea>
    <div class="studio-actions">
      <button class="smallbtn primary" type="button" onclick="studioBuildJdChecklist()">Build editable checklist</button>
      <button class="smallbtn" type="button" onclick="studioClearJd()">Clear</button>
    </div>
    ${checklist ? `<section class="jd-checklist"><div class="jd-checklist-head"><div><h3>Review your JD checklist</h3><p class="studio-note">Edit a requirement, uncheck anything you do not want to prepare, or add your own.</p></div><button class="smallbtn" type="button" onclick="studioBuildJdChecklist()">Rebuild from JD</button></div>
      ${Object.keys(facts).length ? `<div class="jd-facts">${Object.entries(facts).map(([key, value]) => `<span><b>${studioEscape(key)}:</b> ${studioEscape(value)}</span>`).join('')}</div>` : ''}
      ${checklist.requirements.length ? `<div class="jd-checklist-groups">${[...new Set(checklist.requirements.map((r) => r.category))].map((category) => `<div class="jd-checklist-group"><h4>${studioEscape(category)}</h4>${checklist.requirements.map((r, index) => r.category === category ? `<label class="jd-check-row"><input type="checkbox" data-jd-selected="${index}" ${r.checked ? 'checked' : ''}><input class="jd-requirement-edit" aria-label="Edit ${studioEscape(r.label)}" data-jd-label="${index}" value="${studioEscape(r.label)}"><button class="smallbtn" type="button" onclick="studioRemoveJdRequirement(${index})" aria-label="Remove ${studioEscape(r.label)}">Remove</button></label>` : '').join('')}</div>`).join('')}</div>` : '<p class="studio-note">No checklist items detected. Add the requirements you want to prepare.</p>'}
      <div class="jd-add-row"><input id="jdCustomRequirement" placeholder="Add a requirement, e.g. Telecom billing"><button class="smallbtn" type="button" onclick="studioAddJdRequirement()">Add requirement</button></div>
      <div class="studio-actions"><button class="smallbtn primary" type="button" onclick="studioAnalyzeJd()">Analyze selected requirements</button></div>
    </section>` : `<p class="studio-note">Build a checklist to extract role details and the skills or responsibilities found in the JD. You can edit the checklist before analyzing it.</p>`}
    ${results ? jdResultsHTML(results, notes) : `<p class="studio-note">Nothing analyzed yet. The PDF's ladder for each matched term: (1) one-line definition, (2) where you used it for real, (3) one trade-off or limitation, (4) one thing that went wrong and how you handled it — fill the notes with your own experience.</p>`}
  </div>`;
}

function jdResultsHTML(results, notes) {
  const cols = [
    { key: 'direct', title: 'Direct source matches', note: 'The source text contains this requirement or a configured synonym.' },
    { key: 'related', title: 'Related by topic', note: 'The source is filed under a related BA topic, but the phrase was not found.' },
    { key: 'none', title: 'No indexed material found', note: 'No direct phrase or related topic matched. Prepare this using your own examples.' },
  ];
  const assessed = results.map((r) => ({ r, support: jdSupportFor(r.supportTerm || r.term) }));
  return `<p class="studio-count">${results.length} selected requirement${results.length === 1 ? '' : 's'} analyzed.</p>
  ${jdPlanHTML(results)}
  <div class="jd-coverage">${cols.map((col) => {
    const terms = assessed.filter(({ support }) => support.level === col.key);
    return `<div class="jd-col"><h3>${col.title} (${terms.length})</h3><p class="jd-col-note">${col.note}</p>
      ${terms.length ? terms.map(({ r, support }) => {
        const note = notes[r.term] || {};
        const confidence = studioLS('baStudioJdConfidence', {});
        const confidenceKey = r.id || r.term;
        return `<div class="jd-term" id="jd-result-${String(confidenceKey).replace(/[^a-z0-9]+/gi, '-')}">
          <b>${studioEscape(r.term)}</b> <small>${support.directTotal} direct matches · ${support.relatedTotal} related items by topic</small>
          <div class="item-actions">
            ${support.total ? `<button class="smallbtn primary" type="button" onclick="studioPracticeJdTerm('${studioEscape(r.supportTerm || r.term)}')">Practice matching material (${support.total})</button>` : ''}
            <a class="smallbtn" href="#studio" onclick="studioJdJump('${studioEscape(r.term)}')">Ladder notes ↓</a>
          </div>
          <label class="jd-confidence">Your confidence<select data-jd-confidence="${studioEscape(confidenceKey)}">
            <option value="unrated" ${(confidence[confidenceKey] || 'unrated') === 'unrated' ? 'selected' : ''}>Not rated</option>
            <option value="needs-work" ${confidence[confidenceKey] === 'needs-work' ? 'selected' : ''}>Needs practice</option>
            <option value="some-practice" ${confidence[confidenceKey] === 'some-practice' ? 'selected' : ''}>Some practice</option>
            <option value="ready" ${confidence[confidenceKey] === 'ready' ? 'selected' : ''}>Ready</option>
          </select></label>
          ${jdEvidenceHTML(support.directEvidence, 'direct')}
          ${jdEvidenceHTML(support.relatedEvidence, 'related')}
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
  studioSaveJdChecklist();
  const checklist = studioLS('baStudioJdChecklist', null);
  const requirements = checklist && checklist.requirements.filter((r) => r.checked && r.label.trim());
  if (!requirements || !requirements.length) { alert('Select at least one JD requirement to analyze.'); return; }
  const terms = requirements.map((r) => ({ id: r.id, term: r.label.trim(), supportTerm: r.supportTerm || r.label.trim(), category: r.category, emphasis: r.emphasis || 'JD requirement', emphasisWeight: r.emphasisWeight || 1, level: jdSupportFor(r.supportTerm || r.label.trim()).level }));
  studioSave('baStudioJdResult', terms);
  studioRenderPane();
}
function studioBuildJdChecklist() {
  const text = ($s('#jdText') || {}).value || '';
  if (!text.trim()) { alert('Paste a job description first.'); return; }
  studioSave('baStudioJdText', text);
  studioSave('baStudioJdChecklist', jdRequirementsFromText(text));
  studioSave('baStudioJdResult', null);
  // Confidence belongs to the current JD; don't carry ratings into a new preparation plan.
  studioSave('baStudioJdConfidence', {});
  studioRenderPane();
}
function studioSaveJdChecklist() {
  const checklist = studioLS('baStudioJdChecklist', null);
  if (!checklist) return;
  $$s('[data-jd-selected]').forEach((el) => { const item = checklist.requirements[Number(el.dataset.jdSelected)]; if (item) item.checked = el.checked; });
  $$s('[data-jd-label]').forEach((el) => { const item = checklist.requirements[Number(el.dataset.jdLabel)]; if (item) item.label = el.value.trim() || item.label; });
  studioSave('baStudioJdChecklist', checklist);
}
function bindJdChecklist() {
  $$s('[data-jd-selected], [data-jd-label]').forEach((el) => {
    el.addEventListener('change', studioSaveJdChecklist);
    if (el.matches('[data-jd-label]')) el.addEventListener('input', studioSaveJdChecklist);
  });
}
function bindJdPlanner() {
  $$s('[data-jd-confidence]').forEach((el) => el.addEventListener('change', () => {
    const ratings = studioLS('baStudioJdConfidence', {});
    ratings[el.dataset.jdConfidence] = el.value;
    studioSave('baStudioJdConfidence', ratings);
    const host = $s('#jdPrepPlan');
    if (host) host.outerHTML = jdPlanHTML(studioLS('baStudioJdResult', []));
  }));
}
function studioRemoveJdRequirement(index) {
  studioSaveJdChecklist();
  const checklist = studioLS('baStudioJdChecklist', null);
  if (!checklist) return;
  checklist.requirements.splice(index, 1);
  studioSave('baStudioJdChecklist', checklist);
  studioSave('baStudioJdResult', null);
  studioRenderPane();
}
function studioAddJdRequirement() {
  studioSaveJdChecklist();
  const field = $s('#jdCustomRequirement');
  const label = field && field.value.trim();
  if (!label) return;
  const checklist = studioLS('baStudioJdChecklist', null) || { facts: {}, requirements: [] };
  checklist.requirements.push({ id: `jd-custom-${Date.now()}`, category: 'Your added requirements', label, supportTerm: label, checked: true, custom: true });
  studioSave('baStudioJdChecklist', checklist);
  studioSave('baStudioJdResult', null);
  studioRenderPane();
}
function studioClearJd() {
  studioSave('baStudioJdText', '');
  studioSave('baStudioJdChecklist', null);
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
    followUps: it.followUps.map((q) => ({ question: q, answer: '' })), path: STUDIO.frameworkSource, name: STUDIO.frameworkSource, topic: 'Framework',
  })), ...support.items, ...support.cases.map((c) => ({ ...c, question: c.title, answer: c.tasks.filter((t) => t.answer).map((t) => t.question + '\n' + t.answer).join('\n\n') }))];
  if (!list.length) { alert('No indexed items matched this term.'); return; }
  startPractice(list, 'JD term: ' + term, 'jd');
}

function studioStartJdPractice(mode) {
  const results = studioLS('baStudioJdResult', []);
  if (!results.length) return;
  const jdText = studioLS('baStudioJdText', '');
  const jdHash = Array.from(String(jdText)).reduce((hash, ch) => ((hash * 31) + ch.charCodeAt(0)) | 0, 7).toString(36);
  const make = (id, question) => ({
    id: `jd-custom-${jdHash}-${id}`, kind: 'question', generated: true, question, answer: '',
    name: 'JD-specific practice', path: '', topic: 'Business Analyst · 10+ years',
  });
  if (mode === 'case') {
    const prompt = `Complete case exercise — Telecom service activation and billing\n\nA Pune telecom operator has seen a rise in complaints from new enterprise customers: some services activate late, and the first invoice sometimes includes charges the customer does not recognize. The operations lead says handoffs between sales, provisioning, and billing are unclear. Developers and the project manager need a scoped change proposal. You are the senior Business Analyst.\n\nWork through these deliverables in order:\n1. Stakeholder discovery: list who you would meet, the questions you would ask, and how you would resolve conflicting definitions of “activated” and “billable.”\n2. Current and future process: describe the as-is handoffs, identify failure points, and outline a to-be workflow with decision points and exception paths.\n3. Requirements: write a concise business requirement, three functional requirements, two use cases, and measurable acceptance criteria. State assumptions and what is out of scope.\n4. Data analysis: identify the fields and sample checks you would use in Excel and SQL to compare order, activation, and invoice events. Explain how you would validate data quality and protect customer data.\n5. Delivery and UAT: propose a small Agile delivery sequence, UAT scenarios including negative cases, defect triage, and sign-off criteria.\n6. Recommendation: prioritize one process improvement, explain the expected benefit, and name the measure you would track after release.\n\nAnswer as if presenting to stakeholders. Separate confirmed facts from assumptions; use examples from your own experience only when describing work you have personally done.`;
    startPractice([make('case', prompt)], 'JD complete case exercise', 'jd');
    return;
  }
  const questions = [
    ['discovery', 'You have 10+ years of BA experience. A telecom stakeholder asks for a “faster activation” solution but cannot agree on when activation is complete. How would you plan discovery, identify decision-makers, resolve the disagreement, and document an agreed measurable outcome?'],
    ['specification', 'Using a telecom service activation change you know (or a clearly labeled hypothetical), explain how you would turn stakeholder needs into a BRD/FRD, functional specifications, use cases, and a process workflow. How would you keep them consistent as scope changes?'],
    ['analysis', 'A telecom operations team reports a rise in delayed activations and first-invoice disputes. Describe the Excel checks and SQL analysis you would perform, the data you would request, and how you would validate that your findings are reliable.'],
    ['delivery', 'Developers say a requested requirement is ambiguous and the project manager says the release date cannot move. How would you clarify the requirement, present options and trade-offs, and keep stakeholders aligned in an Agile delivery?'],
    ['uat', 'How would you prepare and run UAT for a change spanning order capture, service provisioning, and billing? Give representative happy-path, exception, and regression scenarios, and explain how you would track defects through resolution and sign-off.'],
    ['improvement', 'After release, activation delays improve but invoice disputes remain. How would you investigate the remaining process gap, recommend an improvement, update user and process documentation, and measure whether the change worked?'],
  ];
  if (mode === 'seniority-domain') {
    const advanced = [
      ['senior-governance', 'As a 10+ year Business Analyst on a telecom transformation, how would you set up requirements governance across business, operations, technology, and vendors? Explain traceability, decision rights, change control, and how you keep delivery moving without weakening control.'],
      ['telecom-lifecycle', 'Walk through the customer and operational lifecycle for a new enterprise telecom service, from order capture through provisioning, activation, billing, and support. Where would you expect handoff or data risks, and how would you validate the actual process with subject matter experts?'],
      ['telecom-kpis', 'A telecom leadership team reports poor service activation performance but teams use different definitions and dashboards. How would you agree operational definitions, select meaningful measures such as order-to-activation time and first-bill accuracy, validate the data, and turn the findings into decisions?'],
      ['senior-tradeoffs', 'Two senior stakeholders disagree: one wants a broad platform change while operations needs a near-term fix for provisioning failures. How would you facilitate the decision, compare options by customer impact, risk, cost, and delivery dependency, and document the agreed trade-off?'],
      ['telecom-uat', 'A release changes provisioning and billing integrations. What end-to-end telecom scenarios, failure and recovery paths, reconciliation checks, and operational readiness steps would you include in UAT? How would you decide whether a defect blocks release?'],
      ['senior-coaching', 'How do you improve BA practice across a project team with uneven experience? Describe how you coach analysts on elicitation, specifications, stakeholder workshops, and documentation quality while remaining accountable for delivery outcomes.'],
    ];
    startPractice(advanced.map(([id, question]) => make(id, question)), 'Senior BA & telecom domain drills', 'jd');
    return;
  }
  startPractice(questions.map(([id, question]) => make(id, question)), 'JD-specific practice', 'jd');
}

function bindJdNotes() {
  $$s('[data-jd-note]').forEach((el) => {
    el.addEventListener('change', () => {
      const notes = studioLS('baStudioJdNotes', {});
      const term = el.dataset.jdNote;
      notes[term] = notes[term] || {};
      notes[term][el.dataset.step] = el.value;
      studioSave('baStudioJdNotes', notes);
      const host = $s('#jdPrepPlan');
      if (host) host.outerHTML = jdPlanHTML(studioLS('baStudioJdResult', []));
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
      <p>Assemble a timed session from the indexed content: universal framework questions, BA questions, technical questions, situational prompts and case studies. Answers sync when signed in.</p>
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
    path: STUDIO.frameworkSource, name: STUDIO.frameworkSource, topic: 'Universal core',
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
      <span class="studio-note">${(s.responses[s.index] || '').trim() ? 'Response saved locally; syncs when signed in.' : 'Your response saves automatically.'}</span>
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
    <p>You answered ${s.responses.filter((x) => x && x.trim()).length} of ${s.items.length} questions. Responses and ratings are saved locally; syncs when signed in.</p>
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
      <div class="readlabel">Built from ${STUDIO.stats.sourcesIndexed} indexed repository sources + ${studioEscape(STUDIO.frameworkSource)}</div>
      <h2>Interview Practice Studio</h2>
      <p>Structured practice across the PDF's interview framework, the BA question bank, technical sets, case studies and situational prompts. All question text and answers come from the repository's own extracted sources — nothing is invented. Progress is saved locally; syncs when signed in only and does not sync across devices.</p>
    </div>
    <div class="studio-hero-actions">
      ${next ? `<button class="smallbtn primary" type="button" onclick="studioContinue()">Continue practice →</button>` : ''}
      <a class="smallbtn" href="${studioUrl(STUDIO.frameworkSource)}" target="_blank" rel="noopener">Open ${studioEscape(STUDIO.frameworkSource)} ↗</a>
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
  bindJdChecklist();
  bindJdPlanner();
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
  studioBuildJdChecklist, studioRemoveJdRequirement, studioAddJdRequirement, studioStartJdPractice,
  studioBeginMock, studioMockMove, studioMockToggleReveal, studioMockRate, studioFinishMock, studioNewMock,
  studioContinue, studioOnShow,
});
