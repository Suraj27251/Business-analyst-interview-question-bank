# Personalized AI answer drafts

Interview Practice Studio can generate a reviewable answer draft for the current practice question. It retrieves short, relevant excerpts from the checked-in source corpus and, when configured, private candidate profile evidence. It then sends those excerpts, the question, the saved job description (if any), and optional user context to Groq's chat completions API. Keep the API key and profile evidence server-side.

## Configuration

- Set `GROQ_API` to a Groq API key in the Vercel environments where this feature will run. `GROQ_API_KEY` is also accepted by the function.
- For Preview deployments, add the key to the Preview environment separately. The current project has `GROQ_API` configured for Production only.
- `GROQ_MODEL` is optional; the default is `openai/gpt-oss-120b`.
- `AI_PROFILE_EVIDENCE` is optional. Add a concise, sanitized work-history/project summary to the Vercel environment to personalize drafts from resume evidence. Do not put actual resume text in tracked source files.
- The existing GitHub sign-in and allowlist are required. The AI endpoint also validates the session's same-origin CSRF token.

## Use

Open a question in Interview Practice Studio and select **Generate personalized draft**. Review and edit the draft and evidence labels. **Use and save draft** stores it in the existing `baQuestionAnswers` map, which syncs through the existing Neon state route when signed in. This action does not mark the question practiced. The existing practice controls continue to handle that separately.

The prompt asks the model to avoid unsupported claims and to mark missing specifics with a bracketed reminder. Review every answer before using it in an interview. Do not put confidential employer or customer information in the optional context field.

## Provider details

The function calls `POST https://api.groq.com/openai/v1/chat/completions`. The key is read only by the server function and is never sent to the browser. Source excerpts are selected in the function and are not written to Neon or Vercel logs by this code.

## Verification

Run `npm test`. The personalized-answer route tests cover authentication/CSRF, missing configuration, validation, and a mocked Groq response. Live generation requires a deployment environment with `GROQ_API` and an authenticated session.
