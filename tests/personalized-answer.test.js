import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/ai/personalized-answer.js';
import { COOKIE_NAMES, seal } from '../server-lib/session.js';

const original = {
  secret: process.env.SESSION_SECRET,
  allowlist: process.env.GITHUB_ALLOWED_SUBJECT,
  appUrl: process.env.APP_URL,
  groq: process.env.GROQ_API,
  groqKey: process.env.GROQ_API_KEY,
  profile: process.env.AI_PROFILE_EVIDENCE,
  fetch: globalThis.fetch,
};
process.env.SESSION_SECRET = 'personalized-answer-test-secret-with-32-bytes';
process.env.GITHUB_ALLOWED_SUBJECT = '1234567';
process.env.APP_URL = 'https://prep.example';
delete process.env.GROQ_API;
delete process.env.GROQ_API_KEY;

function responseCapture() {
  return {
    statusCode: 200, headers: {}, body: null,
    setHeader(name, value) { this.headers[name] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    end(body) { this.body = body; return this; },
  };
}
function request(body, { authenticated = true, csrf = true, method = 'POST' } = {}) {
  const headers = { host: 'prep.example', 'x-forwarded-proto': 'https', origin: 'https://prep.example' };
  if (authenticated) {
    const token = seal({ subject: '1234567', csrf: 'csrf-test', exp: Date.now() + 60000 });
    headers.cookie = `${COOKIE_NAMES.SESSION}=${token}`;
  }
  if (csrf) headers['x-csrf-token'] = 'csrf-test';
  return { method, headers, body };
}

test('AI route requires an authenticated, same-origin CSRF-protected request', async () => {
  const unauthenticated = responseCapture();
  await handler(request({ question: 'How do you gather requirements?', }, { authenticated: false }), unauthenticated);
  assert.equal(unauthenticated.statusCode, 401);

  const csrfRejected = responseCapture();
  await handler(request({ question: 'How do you gather requirements?' }, { csrf: false }), csrfRejected);
  assert.equal(csrfRejected.statusCode, 403);
});

test('AI route validates question and reports missing server key without calling Groq', async () => {
  const missing = responseCapture();
  await handler(request({ question: 'How do you gather requirements?' }), missing);
  assert.equal(missing.statusCode, 503);
  assert.equal(JSON.parse(missing.body).error, 'ai_not_configured');

  process.env.GROQ_API = 'test-key';
  const invalid = responseCapture();
  await handler(request({ question: 'short' }), invalid);
  assert.equal(invalid.statusCode, 400);
  delete process.env.GROQ_API;
});

test('successful response sends optional profile evidence to Groq and returns source labels', async () => {
  process.env.GROQ_API = 'test-key-never-returned';
  process.env.AI_PROFILE_EVIDENCE = 'Candidate experience: mapped process improvement workflows and measured a reduction in support response time.';
  const providerRequests = [];
  globalThis.fetch = async (url, options) => {
    const providerRequest = { url, options, body: JSON.parse(options.body) };
    providerRequests.push(providerRequest);
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'In my process improvement project, I mapped the workflow and measured a reduction in support response time.' } }] }) };
  };
  const res = responseCapture();
  await handler(request({ question: 'Tell me about a process improvement experience', jobDescription: 'Business Analyst role' }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(providerRequests.length, 1);
  assert.equal(providerRequests[0].url, 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(providerRequests[0].options.headers.Authorization, 'Bearer test-key-never-returned');
  assert.equal(providerRequests[0].body.model, 'openai/gpt-oss-120b');
  assert.match(providerRequests[0].body.messages[0].content, /2 to 3 concise sentences/);
  assert.match(providerRequests[0].body.messages[0].content, /Do not refuse just because evidence is incomplete/);
  const evidence = providerRequests[0].body.messages[1].content;
  assert.match(evidence, /Private candidate profile configured in the deployment/);
  assert.match(evidence, /process improvement/i);
  const result = JSON.parse(res.body);
  assert.match(result.draft, /mapped the workflow/);
  assert.ok(result.sources.some((source) => source.kind === 'profile evidence'));
  assert.equal(result.sources[0].id, 'E1');
  assert.equal(res.headers['Cache-Control'], 'no-store');
});

test('deployed evidence bundle supports SQL project answers without a second audit call', async () => {
  process.env.GROQ_API = 'test-key';
  delete process.env.AI_PROFILE_EVIDENCE;
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls += 1;
    const requestBody = JSON.parse(options.body);
    assert.match(requestBody.messages[1].content, /telecom-sql-analytics/);
    assert.match(requestBody.messages[1].content, /194 SQL queries\/objects/);
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'In my telecom churn analytics project, I used PostgreSQL and SQL to analyze the dataset. The project includes SQL analysis and a dashboard for its findings.' } }] }) };
  };
  const res = responseCapture();
  await handler(request({ question: 'Explain how you use SQL in your role as a Business Analyst.' }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(calls, 1);
  assert.equal(JSON.parse(res.body).sources[0].source, 'GitHub: telecom-sql-analytics (public repository)');
});

test('AI route generates an adaptable answer when matching evidence is unavailable', async () => {
  process.env.GROQ_API = 'test-key';
  delete process.env.AI_PROFILE_EVIDENCE;
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls += 1;
    const requestBody = JSON.parse(options.body);
    assert.match(requestBody.messages[1].content, /No matching candidate evidence was found/);
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'I would start by clarifying the business need, then document requirements and validate them with stakeholders. [Add a real example and outcome from your experience.]' } }] }) };
  };
  const res = responseCapture();
  await handler(request({ question: 'How do you gather requirements for a project?' }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(calls, 1);
  assert.equal(JSON.parse(res.body).sources.length, 0);
  assert.match(JSON.parse(res.body).draft, /real example and outcome/);
});

after(() => {
  for (const [name, value] of [['SESSION_SECRET', original.secret], ['GITHUB_ALLOWED_SUBJECT', original.allowlist], ['APP_URL', original.appUrl], ['GROQ_API', original.groq], ['GROQ_API_KEY', original.groqKey], ['AI_PROFILE_EVIDENCE', original.profile]]) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  globalThis.fetch = original.fetch;
});
