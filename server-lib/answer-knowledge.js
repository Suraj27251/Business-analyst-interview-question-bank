import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const evidencePath = fileURLToPath(new URL('../suraj_docs/GitHub-Evidence-Index.md', import.meta.url));
const stopWords = new Set('a an and answer are as at be by can candidate did do for from how i in is it me my of on or our the their this to was we what when where which with you your about describe example experience personal project role tell use used using work'.split(' '));
const tokenize = (value) => (String(value || '').toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || []).filter((word) => !stopWords.has(word));

function chunkText(text, path, kind, limit = 1000) {
  const flat = String(text || '').replace(/\r/g, '').trim();
  if (!flat) return [];
  const chunks = [];
  let start = 0;
  while (start < flat.length) {
    let end = Math.min(flat.length, start + limit);
    if (end < flat.length) {
      const boundary = Math.max(flat.lastIndexOf('\n\n', end), flat.lastIndexOf('. ', end));
      if (boundary > start + Math.floor(limit * 0.55)) end = boundary + 1;
    }
    const content = flat.slice(start, end).trim();
    if (content.length > 60) chunks.push({ content, path, kind, terms: tokenize(content) });
    if (end >= flat.length) break;
    start = Math.max(start + 1, end - 130);
  }
  return chunks;
}

let githubEvidence = '';
try { githubEvidence = fs.readFileSync(evidencePath, 'utf8'); }
catch { /* The optional, user-maintained evidence index may not be in a deployment checkout. */ }

// Interview guides and sample answers are study material, not evidence about
// the candidate. Only use the curated project index and explicit profile input.
const knowledge = chunkText(githubEvidence, 'suraj_docs/GitHub-Evidence-Index.md', 'project evidence');

export function retrieveEvidence(query, limit = 7) {
  const queryTerms = [...new Set(tokenize(query))];
  if (!queryTerms.length) return [];
  const profile = String(process.env.AI_PROFILE_EVIDENCE || '').slice(0, 12000);
  const searchable = [...knowledge, ...chunkText(profile, 'Private candidate profile configured in the deployment', 'profile evidence')];
  const documentFrequency = new Map();
  for (const chunk of searchable) {
    for (const term of new Set(chunk.terms)) documentFrequency.set(term, (documentFrequency.get(term) || 0) + 1);
  }
  const total = searchable.length;
  const ranked = searchable.map((chunk) => {
    const frequencies = new Map();
    for (const term of chunk.terms) frequencies.set(term, (frequencies.get(term) || 0) + 1);
    let score = 0;
    for (const term of queryTerms) {
      const tf = frequencies.get(term) || 0;
      if (tf) score += (1 + Math.log(tf)) * (Math.log(1 + (total - (documentFrequency.get(term) || 0) + 0.5) / ((documentFrequency.get(term) || 0) + 0.5)));
    }
    return { ...chunk, score };
  }).filter((chunk) => chunk.score > 0).sort((a, b) => b.score - a.score);
  const chosen = [];
  const seen = new Set();
  const sourceCounts = new Map();
  for (const item of ranked) {
    const signature = `${item.path}:${item.content.slice(0, 100)}`;
    if (seen.has(signature) || (sourceCounts.get(item.path) || 0) >= 2) continue;
    seen.add(signature);
    chosen.push({ source: item.path, kind: item.kind, excerpt: item.content.slice(0, 1100) });
    sourceCounts.set(item.path, (sourceCounts.get(item.path) || 0) + 1);
    if (chosen.length >= limit) break;
  }
  return chosen;
}
