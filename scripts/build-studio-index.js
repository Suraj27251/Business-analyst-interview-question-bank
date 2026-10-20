/**
 * Build studio_index.js — the Interview Practice Studio content index.
 *
 * Sources (all authoritative, nothing invented):
 *   1. scripts/ba_interview_prep_extracted.txt  (derived text of BA_Interview_Prep.pdf)
 *   2. dashboard_data.js                        (existing repository extraction manifest:
 *      window.PREP_DATA.records with page-level extracted text for every repository file)
 *
 * The question-extraction pipeline below is a faithful port of parseQuestionSource()
 * in dashboard.html so that Studio question IDs (path::sourceIndex) are identical to
 * the IDs used by the existing practice/review/saved stores. This keeps progress
 * fully compatible with the current dashboard.
 *
 * Usage (from the repository root, Node 18+):
 *   node scripts/build-studio-index.js
 *
 * Output: studio_index.js  (window.STUDIO_INDEX = {...})
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA_FILE = path.join(ROOT, 'dashboard_data.js');
const FRAMEWORK_FILE = path.join(__dirname, 'ba_interview_prep_extracted.txt');
const OUT_FILE = path.join(ROOT, 'studio_index.js');

/* ------------------------------------------------------------------ *
 * Load inputs
 * ------------------------------------------------------------------ */

function loadPrepData() {
  const raw = fs
    .readFileSync(DATA_FILE, 'utf8')
    .trim()
    .replace(/^window\.PREP_DATA=/, '')
    .replace(/;$/, '');
  return JSON.parse(raw);
}

/* ------------------------------------------------------------------ *
 * Framework parsing (BA_Interview_Prep.pdf)
 * ------------------------------------------------------------------ */

function parseFramework(text) {
  const lines = text.split(/\r?\n/);
  const framework = {
    title: '',
    subtitle: '',
    proofPoints: [],
    doNotClaim: [],
    howBuilt: [],
    parts: [],
    jdLadder: null,
    questionsForInterviewer: [],
  };

  let i = 0;
  const next = () => (i < lines.length ? lines[i] : null);
  // pypdf renders bullet glyphs as DEL (U+007F); treat that like a bullet marker.
  const isBullet = (l) => /^[\s\u007f]*[\u007f•][\s\u007f]*\S/.test(l || '') || /^\s{1,3}\S/.test(l || '');
  const clean = (l) => (l || '').replace(/^[\s\u007f]*[\u007f•\-–]?[\s\u007f]*/, '').trim();
  const isContinuation = (l) => !!l && !/^[\s\u007f]/.test(l) && !isSection(l) && !isHeader(l) && !/^=====/.test(l);
  const isHeader = (l) => /^(They are testing|How to answer|Your story to use|Likely follow-ups)\s*:/i.test((l || '').trim());
  const isSection = (l) => /^(Part \d|Your proof points|Do not claim|How this file is built|Ladder for every tool|Terms this role|Questions to ask)/i.test((l || '').trim());
  const isPageMarker = (l) => /^===== PAGE/.test((l || '').trim());

  // Consumes bullet lines (optionally with wrapped continuation lines) into target.
  const readBullets = (target) => {
    while (i < lines.length) {
      const l = lines[i];
      if (!l || isPageMarker(l) || isSection(l)) break;
      if (isBullet(l)) {
        let c = clean(l);
        i++;
        while (i < lines.length && isContinuation(lines[i])) {
          c = (c + ' ' + lines[i].trim()).trim();
          i++;
        }
        if (c) target.push(c);
        continue;
      }
      break;
    }
  };

  while (i < lines.length) {
    const line = next();
    if (line == null) break;
    const t = line.trim();

    if (!t || isPageMarker(line)) { i++; continue; }

    if (/^Business Analyst Interview Prep$/i.test(t)) { framework.title = t; i++; continue; }
    if (!framework.subtitle && framework.title && /^Requirements, process mapping/.test(t)) { framework.subtitle = t; i++; continue; }

    if (/^Your proof points/i.test(t)) { i++; readBullets(framework.proofPoints); continue; }
    if (/^Do not claim/i.test(t)) { i++; readBullets(framework.doNotClaim); continue; }
    if (/^How this file is built/i.test(t)) { i++; readBullets(framework.howBuilt); continue; }

    const partMatch = t.match(/^Part (\d):\s*(.+)$/i);
    if (partMatch) {
      const partNum = partMatch[1];
      const part = { id: 'P' + partNum, title: 'Part ' + partNum + ': ' + partMatch[2].trim(), items: [] };
      i++;
      // Items: "1. Title" (part 1) or "R1. Title" (part 2)
      while (i < lines.length) {
        const l = next();
        const lt = (l || '').trim();
        if (!lt || isPageMarker(l)) { i++; continue; }
        if (/^Part \d:/i.test(lt)) break; // safety

        const itemMatch = lt.match(/^((?:R)?\d+)\.\s+(.+)$/);
        if (itemMatch && partNum === '1' && !/^R\d/.test(lt)) {
          // fall through to generic item parse below
        }
        if (itemMatch) {
          const item = {
            id: 'fw-P' + partNum + '-' + itemMatch[1],
            code: itemMatch[1],
            question: itemMatch[2].trim(),
            testing: '',
            how: '',
            story: '',
            followUps: [],
          };
          i++;
          let current = null;
          while (i < lines.length) {
            const bl = next();
            const bt = (bl || '').trim();
            if (!bt || isPageMarker(bl)) { i++; continue; }
            if (/^(They are testing|How to answer|Your story to use|Likely follow-ups)\s*:/i.test(bt)) {
              const label = bt.match(/^(They are testing|How to answer|Your story to use|Likely follow-ups)\s*:/i)[1].toLowerCase();
              let value = bt.slice(bt.indexOf(':') + 1).trim();
              i++;
              // Continuation lines until next label, item start, or section
              while (i < lines.length) {
                const cl = next();
                const ct = (cl || '').trim();
                if (!ct || isPageMarker(cl)) { i++; continue; }
                if (isHeader(cl) || /^(Part \d|Ladder for every tool)/i.test(ct) || /^(?:R)?\d+\.\s+/.test(ct)) break;
                value = (value + ' ' + ct).trim();
                i++;
              }
              if (label === 'they are testing') item.testing = value;
              else if (label === 'how to answer') item.how = value;
              else if (label === 'your story to use') item.story = value;
              else if (label === 'likely follow-ups') {
                // Split on " / " separators, then re-join fragments that do not
                // end a sentence (e.g. "Why are you leaving / looking?").
                const parts = value.split(/\s+\/\s+/);
                const merged = [];
                for (const part of parts) {
                  const last = merged[merged.length - 1];
                  if (last && !/[.?!]$/.test(last)) merged[merged.length - 1] = last + ' / ' + part;
                  else merged.push(part);
                }
                item.followUps = merged.map((s) => s.replace(/\s+/g, ' ').trim()).filter((s) => s.length > 0);
              }
              continue;
            }
            break;
          }
          part.items.push(item);
          continue;
        }
        // Part 3 prose / ladder / terms / interviewer questions
        if (/^Ladder for every tool/i.test(lt)) {
          let ladderText = lt.slice(lt.indexOf(':') + 1).trim();
          i++;
          while (i < lines.length) {
            const cl = next();
            const ct = (cl || '').trim();
            if (!ct || isPageMarker(cl)) { i++; continue; }
            if (/^Terms this role|^Questions to ask|^Part \d/i.test(ct)) break;
            ladderText = (ladderText + ' ' + ct).trim();
            i++;
          }
          framework.jdLadder = {
            text: ladderText,
            steps: [
              'One-line definition',
              'Where you used it for real',
              'One trade-off or limitation',
              'One thing that went wrong and how you handled it',
            ],
          };
          continue;
        }
        if (/^Terms this role/i.test(lt)) {
          let termsText = lt.slice(lt.indexOf(':') + 1).trim();
          i++;
          while (i < lines.length) {
            const cl = next();
            const ct = (cl || '').trim();
            if (!ct || isPageMarker(cl)) { i++; continue; }
            if (/^Questions to ask|^Part \d/i.test(ct)) break;
            termsText = (termsText + ' ' + ct).trim();
            i++;
          }
          framework.jdTerms = termsText.split(/\s*,\s*/).map((s) => s.trim()).filter(Boolean);
          continue;
        }
        if (/^Questions to ask/i.test(lt)) { i++; readBullets(framework.questionsForInterviewer); continue; }
        i++;
      }
      framework.parts.push(part);
      continue;
    }
    i++;
  }
  return framework;
}

/* ------------------------------------------------------------------ *
 * Question extraction — faithful port of parseQuestionSource() in dashboard.html
 * ------------------------------------------------------------------ */

function parseQuestionSource(r) {
  const text = (r.pageText || []).join('\n\n').replace(/\r/g, '');
  if (!text.trim()) return [];
  const marks = [];
  const addMarks = (re, kind) => {
    let m;
    while ((m = re.exec(text)) !== null) marks.push({ start: m.index, kind, marker: m[0] });
  };
  addMarks(/\bQuestion\s*[-#]?\s*\d+\s*[:.)-]?/gi, 'label');
  addMarks(/^[ \t]*Q[ \t]*(?:\d+[ \t]*[:.)-]|[.:])[ \t]*/gim, 'label');
  addMarks(/^[ \t]*\d{1,3}[.)][ \t]+(?=(?:Who|What|When|Where|Why|How|Can|Could|Would|Do|Does|Did|Is|Are|Tell|Describe|Explain|Define|Give|Share|List|Name|Which|Should|If|Suppose|Walk)\b)/gim, 'number');
  const paraRe = /\S[\s\S]*?(?=\n[ \t]*\n|$)/g;
  let pm;
  while ((pm = paraRe.exec(text)) !== null) {
    const raw = pm[0].trim();
    if (raw.length > 650) continue;
    if (!/^(?:Who|What|When|Where|Why|How|Can|Could|Would|Do|Does|Did|Is|Are|Tell|Describe|Explain|Define|Give|Share|List|Name|Which|Should|If|Suppose|Walk)\b/i.test(raw)) continue;
    if (!raw.includes('?') && !/^(?:Tell me|Explain|Describe|Define|Give me|List|Name|Share)/i.test(raw)) continue;
    const start = pm.index + pm[0].indexOf(raw);
    if (!marks.some((x) => x.start >= start && x.start < start + raw.length)) marks.push({ start, kind: 'plain', marker: '' });
  }
  marks.sort((a, b) => a.start - b.start);
  const uniq = [];
  for (const m of marks) {
    if (uniq.length && m.start < uniq[uniq.length - 1].start + 4) continue;
    uniq.push(m);
  }
  const cards = [];
  for (let i = 0; i < uniq.length; i++) {
    const m = uniq[i];
    const end = i + 1 < uniq.length ? uniq[i + 1].start : text.length;
    const block = text.slice(m.start, end).trim();
    if (!block) continue;
    let body = block;
    if (m.kind === 'label') body = body.replace(/^\s*(?:Question\s*[-#]?\s*\d+\s*[:.)-]?|Q\s*(?:\d+\s*[:.)-]|[.:]))\s*/i, '');
    else if (m.kind === 'number') body = body.replace(/^\s*\d{1,3}[.)]\s*/, '');
    const cue = body.search(/\b(?:Ans(?:wer)?\.?\s*[:.-]|Example\s+Response\s*:|Situation\s*:|TRAPS\s*:|BEST\s+ANSWER\s*:|Poor\s+Response\s*:|Good\s+Response\s*:)/i);
    let promptEnd = -1;
    if (cue >= 0) promptEnd = cue;
    else {
      const q = body.indexOf('?');
      if (q >= 0) {
        const last = body.lastIndexOf('?', Math.min(body.length - 1, 900));
        promptEnd = last + 1;
      } else {
        const dot = body.search(/[.!](?:\s|$)/);
        if (dot >= 0) promptEnd = dot + 1;
      }
    }
    if (promptEnd < 0) continue;
    const question = body.slice(0, promptEnd).trim().replace(/\s+/g, ' ');
    if (question.length < 8 || question.length > 500) continue;
    let answer = body.slice(promptEnd).trim().replace(/^(?:\n\s*)+/, '');
    if (answer.length < 40) answer = '';
    else if (answer.length > 1600) answer = answer.slice(0, 1600).trim() + ' …';
    cards.push({ question, answer, sourceIndex: i });
  }
  const dedup = new Map();
  for (const c of cards) {
    const key = c.question.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\b\d+\s*$/, '').trim();
    const prior = dedup.get(key);
    if (!prior || c.answer.length > prior.answer.length) dedup.set(key, c);
  }
  return [...dedup.values()];
}

function pageOf(r, snippet) {
  if (!snippet) return null;
  const flat = snippet.replace(/\s+/g, ' ').trim();
  if (flat.length < 12) return null;
  const needle = flat.slice(0, 80).toLowerCase();
  const pages = r.pageText || [];
  for (let p = 0; p < pages.length; p++) {
    if ((pages[p] || '').replace(/\s+/g, ' ').toLowerCase().includes(needle)) return p + 1;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Classification
 * ------------------------------------------------------------------ */

const TECHNICAL_SOURCE = /sql|tableau|power.?bi|\bapi\b|jira|interview\/sql|interview\/tableau/i;
const TOPIC_RULES = [
  [/requirement|elicitation|stakeholder interview|workshop|brd|frs|user stor|acceptance criter/i, 'Requirements & elicitation'],
  [/as-?is|to-?be|bpmn|process map|process model|workflow|gap analysis/i, 'Process mapping'],
  [/document|srs|sow|specification|template|brd\b/i, 'Documentation'],
  [/prioriti[sz]|moscow|kano|value.?effort/i, 'Prioritization'],
  [/change (request|control|management)|impact analysis/i, 'Change management'],
  [/\buat\b|\bsit\b|test (plan|case|scenario)|defect|regression|severity|test(ing)?\b/i, 'UAT & testing'],
  [/traceab|\brtm\b/i, 'Traceability'],
  [/sql|reconcil|data (valid|quality|analys)|report|dashboard|etl|query/i, 'Data analysis'],
  [/stakeholder|conflict|sponsor|client|communicat|expectation/i, 'Stakeholder management'],
  [/agile|scrum|sprint|kanban|backlog|product owner|waterfall|jira/i, 'Agile & Scrum'],
  [/api|rest|http|endpoint|integration|microservice/i, 'APIs & integrations'],
  [/system|architecture|sdlc|design|ux|ui\b/i, 'Systems analysis'],
];

function topicFor(text) {
  const t = (text || '').toLowerCase();
  for (const [re, label] of TOPIC_RULES) if (re.test(t)) return label;
  return 'General BA';
}

const SITUATIONAL_SOURCE = /scenario|tough|64|48 scenario|correct vs incorrect|interviewin guide/i;
const SITUATIONAL_QUESTION = /^(what if|how would you|what would you do|suppose|imagine|you are|you're )/i;

function classify(r, q) {
  const source = r.path + ' ' + r.name;
  const qtext = q.question;
  if (TECHNICAL_SOURCE.test(source) || /\b(sql|rest|api|http method|join|index|primary key|dashboard|dax|power query)\b/i.test(qtext)) {
    return { kind: 'technical', module: 'C', topic: topicFor(source + ' ' + qtext) };
  }
  if (SITUATIONAL_SOURCE.test(source) || SITUATIONAL_QUESTION.test(qtext) || /tell me about a time|give me an example|describe a (time|situation)/i.test(qtext)) {
    return { kind: 'situational', module: 'E', topic: topicFor(source + ' ' + qtext) };
  }
  return { kind: 'question', module: 'B', topic: topicFor(source + ' ' + qtext) };
}

/* ------------------------------------------------------------------ *
 * Question-source detection (same as dashboard questionSourcesForDay)
 * ------------------------------------------------------------------ */

const QUESTION_SOURCE_RE = /question|answer|interview.?guide|interviewin guide|correct vs incorrect/i;

function isQuestionSource(r) {
  const text = (r.pageText || []).join('\n\n');
  return text.trim() && QUESTION_SOURCE_RE.test(r.name);
}

function isCaseSource(r) {
  return /^BA INTERVIEW CASE STUDIES/i.test(r.category || '') || /case stud|assignment|exercise/i.test(r.name);
}

/* ------------------------------------------------------------------ *
 * Case study extraction (Module D)
 * ------------------------------------------------------------------ */

function parseCaseSource(r) {
  const text = (r.pageText || []).join('\n\n').replace(/\r/g, '');
  if (!text.trim() || text.trim().length < 200) return [];
  const cases = [];
  const headingRe = /^[ \t]*Case[ \t]*(\d+)[ \t]*[:.\-–][ \t]*(.*)$/gim;
  const heads = [];
  let hm;
  while ((hm = headingRe.exec(text)) !== null) {
    if (heads.length && hm.index < heads[heads.length - 1].start + 40) continue;
    heads.push({ start: hm.index, num: hm[1], title: (hm[2] || '').trim().replace(/\s+/g, ' ') });
  }
  const slices = [];
  if (heads.length >= 2) {
    for (let i = 0; i < heads.length && cases.length < 40; i++) {
      const end = i + 1 < heads.length ? heads[i + 1].start : text.length;
      slices.push({ title: heads[i].title || 'Case ' + heads[i].num, num: heads[i].num, body: text.slice(heads[i].start, end) });
    }
  } else {
    // Standalone assignment / exercise: treat the whole document as one case.
    const flat = text.trim();
    if (!/assignment|exercise|case study|practical task|written test|test\b/i.test(r.name)) return [];
    slices.push({ title: r.name.replace(/\.[^.]+$/, ''), num: '1', body: flat });
  }
  for (const slice of slices) {
    const body = slice.body;
    const tasks = parseQuestionSource({ pageText: [body], name: r.name, path: r.path });
    let promptEnd = body.length;
    if (tasks.length) {
      const firstQ = body.toLowerCase().indexOf(tasks[0].question.toLowerCase().slice(0, 60).toLowerCase());
      if (firstQ > 0) promptEnd = firstQ;
    }
    let prompt = body.slice(0, promptEnd).trim().replace(/\s+/g, ' ');
    // Drop the "Case N:" heading itself from the prompt
    prompt = prompt.replace(/^[ \t]*Case[ \t]*\d+[ \t]*[:.\-–][ \t]*/i, '').trim();
    if (prompt.length > 1800) prompt = prompt.slice(0, 1800).trim() + ' …';
    if (!tasks.length && prompt.length < 120) continue; // nothing usable
    cases.push({
      id: 'case::' + r.path + '::' + slice.num,
      kind: 'case',
      module: 'D',
      topic: topicFor(r.path + ' ' + r.name + ' ' + prompt.slice(0, 400)),
      title: (slice.title || 'Case ' + slice.num).slice(0, 220),
      prompt,
      tasks: tasks.slice(0, 20).map((t) => ({ question: t.question, answer: t.answer })),
      path: r.path,
      name: r.name,
      locator: { page: pageOf(r, body.slice(0, 80)) },
    });
  }
  return cases;
}

/* ------------------------------------------------------------------ *
 * Follow-up chaining (situationals preserve scenario → follow-up links)
 * ------------------------------------------------------------------ */

function chainFollowUps(items) {
  // Within one source, a follow-up style question directly after a question
  // that has no paired answer becomes a follow-up of that question.
  const bySource = new Map();
  for (const it of items) {
    if (!bySource.has(it.path)) bySource.set(it.path, []);
    bySource.get(it.path).push(it);
  }
  const consumed = new Set();
  for (const [, list] of bySource) {
    list.sort((a, b) => a.sourceIndex - b.sourceIndex);
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1];
      const cur = list[i];
      if (consumed.has(cur.id)) continue;
      if (prev.answer) continue;
      if (SITUATIONAL_QUESTION.test(cur.question) || /^what about /i.test(cur.question)) {
        prev.followUps = prev.followUps || [];
        prev.followUps.push({ question: cur.question, answer: cur.answer });
        consumed.add(cur.id);
      }
    }
  }
  return items.filter((it) => !consumed.has(it.id));
}

/* ------------------------------------------------------------------ *
 * Build
 * ------------------------------------------------------------------ */

function main() {
  const D = loadPrepData();
  const R = D.records;
  const framework = parseFramework(fs.readFileSync(FRAMEWORK_FILE, 'utf8'));

  const issues = [];
  const items = [];
  const cases = [];
  const seenQuestionIds = new Set();

  // --- Question-bank modules (B / C / E) from question-style sources
  for (const r of R) {
    if (!isQuestionSource(r)) continue;
    const weak = r.type === 'PDF' && r.textChars < 2000;
    const parsed = parseQuestionSource(r);
    if (!parsed.length) {
      issues.push({ path: r.path, reason: weak ? 'weak text extraction' : 'no question prompts detected' });
      continue;
    }
    const classified = [];
    for (const q of parsed) {
      const id = r.path + '::' + q.sourceIndex;
      if (seenQuestionIds.has(id)) continue;
      seenQuestionIds.add(id);
      const { kind, module, topic } = classify(r, q);
      classified.push({
        id,
        kind,
        module,
        topic,
        question: q.question,
        answer: q.answer,
        followUps: [],
        path: r.path,
        name: r.name,
        locator: { page: pageOf(r, q.question) },
      });
    }
    items.push(...chainFollowUps(classified));
  }

  // --- Case Study Lab (module D)
  for (const r of R) {
    if (!isCaseSource(r)) continue;
    if (/\.jpe?g$/i.test(r.name)) continue;
    const found = parseCaseSource(r);
    if (!found.length && (r.textChars || 0) > 0) {
      issues.push({ path: r.path, reason: 'no case blocks detected by the extractor' });
    }
    cases.push(...found);
  }

  // Deduplicate cases with identical prompts across sources (keep first, note source count)
  const caseDedup = new Map();
  for (const c of cases) {
    const key = (c.title + ' ' + c.prompt.slice(0, 200)).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const prior = caseDedup.get(key);
    if (!prior) caseDedup.set(key, c);
    else prior.duplicateSources = (prior.duplicateSources || 1) + 1;
  }
  const uniqueCases = [...caseDedup.values()];

  // --- Topic list & JD term vocabulary (PDF Part 3 + PDF proof-point tools)
  const topics = [...new Set([...items.map((x) => x.topic), ...uniqueCases.map((x) => x.topic)])].sort();
  const jdTerms = [
    ...new Set([
      ...(framework.jdTerms || []),
      'Visio', 'Power BI', 'Excel', 'Power Query', 'VBA', 'PivotTables',
      'Agile', 'Scrum', 'Waterfall', 'SDLC', 'wireframes', 'prioritization',
      'elicitation', 'stakeholder management', 'BPMN', 'AS-IS/TO-BE',
    ]),
  ];

  const stats = {
    items: items.length,
    withAnswer: items.filter((x) => x.answer).length,
    followUps:
      items.reduce((n, x) => n + (x.followUps ? x.followUps.length : 0), 0) +
      framework.parts.reduce((n, p) => n + p.items.reduce((m, it) => m + it.followUps.length, 0), 0),
    byKind: {
      question: items.filter((x) => x.kind === 'question').length,
      technical: items.filter((x) => x.kind === 'technical').length,
      situational: items.filter((x) => x.kind === 'situational').length,
      case: uniqueCases.length,
      framework: framework.parts.reduce((n, p) => n + p.items.length, 0),
    },
    caseWithTasks: uniqueCases.filter((c) => c.tasks.length).length,
    caseWithAnswers: uniqueCases.filter((c) => c.tasks.some((t) => t.answer)).length,
    sourcesIndexed: new Set([...items.map((x) => x.path), ...uniqueCases.map((x) => x.path)]).size,
    extractionIssues: issues.length,
  };

  const index = {
    generatedAt: new Date().toISOString(),
    frameworkSource: 'BA_Interview_Prep.pdf',
    framework,
    items,
    cases: uniqueCases,
    topics,
    jdTerms,
    issues,
    stats,
  };

  const banner =
    '// GENERATED FILE — do not edit by hand.\n' +
    '// Build with: node scripts/build-studio-index.js\n' +
    '// Sources: dashboard_data.js + scripts/ba_interview_prep_extracted.txt (from BA_Interview_Prep.pdf)\n';
  fs.writeFileSync(OUT_FILE, banner + 'window.STUDIO_INDEX=' + JSON.stringify(index) + ';\n', 'utf8');
  console.log('Wrote ' + OUT_FILE);
  console.log(JSON.stringify(stats, null, 2));
}

main();
