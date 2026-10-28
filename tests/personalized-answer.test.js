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

test('successful response sends retrieved profile evidence to Groq and returns source labels', async () => {
  process.env.GROQ_API = 'test-key-never-returned';
  process.env.AI_PROFILE_EVIDENCE = 'Candidate experience: mapped process improvement workflows and measured a reduction in support response time.';
  let providerRequest;
  globalThis.fetch = async (url, options) => {
    providerRequest = { url, options, body: JSON.parse(options.body) };
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'I mapped the workflow and validated it with users.' } }] }) };
  };
  const res = responseCapture();
  await handler(request({ question: 'Tell me about a process improvement experience', jobDescription: 'Business Analyst role' }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(providerRequest.url, 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(providerRequest.options.headers.Authorization, 'Bearer test-key-never-returned');
  assert.equal(providerRequest.body.model, 'openai/gpt-oss-120b');
  const evidence = providerRequest.body.messages[1].content;
  assert.match(evidence, /Private candidate profile configured in the deployment/);
  assert.match(evidence, /process improvement/i);
  const result = JSON.parse(res.body);
  assert.match(result.draft, /mapped the workflow/);
  assert.ok(result.sources.some((source) => source.kind === 'profile'));
  assert.equal(res.headers['Cache-Control'], 'no-store');
});

after(() => {
  for (const [name, value] of [['SESSION_SECRET', original.secret], ['GITHUB_ALLOWED_SUBJECT', original.allowlist], ['APP_URL', original.appUrl], ['GROQ_API', original.groq], ['GROQ_API_KEY', original.groqKey], ['AI_PROFILE_EVIDENCE', original.profile]]) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  globalThis.fetch = original.fetch;
});
