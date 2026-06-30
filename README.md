# Essay Mistake → Practice Question Generator

A small full-stack tool: a student pastes an essay, an AI pipeline grades it and extracts specific mistakes (grammar/mechanics + structure/argument), and the tool generates personalized practice questions targeting those mistakes.

See [SPEC.md](./SPEC.md) for the full technical spec — data model, AI pipeline stages, UI pages, and edge case handling.

## Why this project

Built as a portfolio piece while applying for an engineering role at [Gradr](https://gradr.se), a Swedish startup building AI-assisted formative feedback tools for teachers. A few decisions here intentionally mirror choices I understand Gradr to have made in their own product and engineering practice:

- **Feedback, not grading.** The pipeline never produces a numeric grade — only qualitative feedback and flagged mistakes. Final grading stays a human decision. This matches Gradr's own stance on keeping grading human-only, partly for EU AI Act reasons around automated decisions affecting students (*myndighetsutövning*).
- **Strict typing and validated structured output.** Every Groq response is parsed through a Zod schema before use; no `any`, no unchecked casts. This reflects an engineering culture that prioritizes static analysis and reliable structured LLM output over loose prompting.
- **Multi-stage pipeline, not one big prompt.** Grading, mistake extraction, and question generation are separate calls with narrow jobs, rather than one prompt trying to do everything at once.
- **Closing a workflow gap.** The practice-question flow connects directly to the mistakes found during grading — addressing the kind of disconnect that can exist between a "graded feedback" feature and a separate, unconnected "practice" feature.

The app itself has no Gradr branding and is a standalone tool — this section just explains the reasoning behind a few design choices, in case it's useful context for anyone reviewing the code.

## Stack

SvelteKit (frontend + backend), PostgreSQL via Supabase, Groq API for LLM calls.

## Status

Spec complete, implementation not yet started.
