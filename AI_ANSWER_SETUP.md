# Personalized AI answer drafts

Interview Practice Studio can generate a reviewable answer draft for the current practice question. It retrieves short, relevant excerpts only from the curated project index and private candidate profile evidence. Generic interview guides and sample answers are excluded because they are not evidence about the candidate. The question, matching evidence, saved job description (for tailoring only), and optional user context are sent to Groq's chat completions API. Keep the API key and profile evidence server-side.

## Configuration

- Set `GROQ_API` to a Groq API key in the Vercel environments where this feature will run. `GROQ_API_KEY` is also accepted by the function.
- For Preview deployments, add the key to the Preview environment separately. The current project has `GROQ_API` configured for Production only.
- `GROQ_MODEL` is optional; the default is `openai/gpt-oss-120b`.
- `AI_PROFILE_EVIDENCE` is optional. Add a concise, sanitized work-history/project summary to the Vercel environment to personalize drafts from resume evidence. Do not put actual resume text in tracked source files.
- The existing GitHub sign-in and allowlist are required. The AI endpoint also validates the session's same-origin CSRF token.

## Use

Open a question in Interview Practice Studio and select **Generate personalized draft**. Review and edit the draft and evidence labels. **Use and save draft** stores it in the existing `baQuestionAnswers` map, which syncs through the existing Neon state route when signed in. This action does not mark the question practiced. The existing practice controls continue to handle that separately.

The function uses a small, curated set of public project excerpts bundled in `server-lib/ai-project-evidence.js`, plus any matching private candidate details in `AI_PROFILE_EVIDENCE` and the optional context field. It does not read `suraj_docs/GitHub-Evidence-Index.md` at runtime because that folder is excluded from Vercel deployments. The model can draft even when matching evidence is unavailable; it should use a short placeholder for missing personal details. Available evidence is returned with the draft as optional support, and the server does not require citations or run a second evidence-audit request. The answer is one short paragraph of 2 to 3 concise sentences (about 40 to 60 words) in simple, memorable language. The job description is used only to tailor emphasis. Do not put confidential employer or customer information in the optional context field.

## Provider details

The function calls `POST https://api.groq.com/openai/v1/chat/completions`. The key is read only by the server function and is never sent to the browser. Source excerpts are selected in the function and are not written to Neon or Vercel logs by this code.

## Verification

Run `npm test`. The personalized-answer route tests cover authentication/CSRF, missing configuration, validation, generation with evidence, and generation with a placeholder when evidence is missing. Live generation requires `GROQ_API` and an authenticated session. For local key-based testing, put `GROQ_API=...` in the ignored `local.env` file; never commit or share that value.
