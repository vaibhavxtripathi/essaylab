# Essay Mistake → Practice Question Generator — Spec

## 0. Context & Motivation

This is a portfolio project built while applying for an engineering role at Gradr (gradr.se), a Swedish startup doing AI-assisted formative feedback for teachers. Gradr deliberately keeps final grading human-only (citing EU AI Act rules around *myndighetsutövning*) and uses AI for feedback, not grading decisions — this project mirrors that distinction: the pipeline produces feedback and flagged mistakes, never a numeric grade.

Gradr's stack is SvelteKit + TypeScript + PostgreSQL. Their engineering culture favors static analysis, strict typing, and reliable structured LLM output over loose prompting. This project is built accordingly: explicit types end-to-end, validated structured output at every AI boundary, and a multi-stage pipeline with one narrow job per call rather than one large prompt doing everything.

The practice-question flow is also designed to mirror a known gap at Gradr — their existing "Playground" practice feature is disconnected from the graded-feedback side. This project demonstrates one way to close that gap: mistakes identified during grading flow directly into generated practice questions, without a manual hand-off step.

This context explains *why* certain decisions were made (e.g. feedback-not-grade language, strict validation, stage separation) but the app itself carries no Gradr branding — it's a standalone tool.

## 1. Overview

A single-user web tool. A student pastes an essay. The system:

1. Grades the essay and extracts specific mistakes (grammar/mechanics + structure/argument), as feedback — not a final numeric grade.
2. Groups mistakes by category and generates personalized practice questions targeting those categories.
3. Lets the student answer the practice questions and get immediate feedback.

No auth, no multi-tenancy. Single browser session, identified by a generated UUID stored in a cookie/localStorage, used only to scope "my submissions" in the DB (not real auth/security).

**Stack:** SvelteKit (frontend + backend via server routes/form actions), Postgres via Supabase, Groq API for all LLM calls.

---

## 2. Data Model (Postgres)

```sql
-- A single essay submission
create table submissions (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null,              -- anonymous client identifier, not auth
  essay_text text not null,
  overall_feedback text,                 -- holistic AI feedback, NOT a grade
  status text not null default 'pending', -- pending | graded | failed
  error_message text,                    -- populated if status = 'failed'
  created_at timestamptz not null default now()
);

-- A single flagged mistake within an essay
create table mistakes (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references submissions(id) on delete cascade,
  category text not null check (category in (
    'subject_verb_agreement',
    'comma_splice',
    'run_on_sentence',
    'tense_consistency',
    'thesis_clarity',
    'weak_evidence',
    'paragraph_structure',
    'logical_flow'
  )),
  quote text not null,        -- the exact excerpt from the essay
  explanation text not null,  -- why this is a mistake
  created_at timestamptz not null default now()
);

-- A practice question generated for a mistake *category* within a submission
-- (grouped — not one row per mistake instance)
create table practice_questions (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references submissions(id) on delete cascade,
  category text not null,
  question_type text not null check (question_type in ('multiple_choice', 'short_response')),
  prompt text not null,
  -- for multiple_choice:
  choices jsonb,              -- array of strings, null for short_response
  correct_choice_index int,   -- null for short_response
  -- for short_response:
  model_answer_notes text,    -- what a correct answer should contain; used by grading pass; null for multiple_choice
  created_at timestamptz not null default now()
);

-- A student's attempt at a practice question
create table practice_answers (
  id uuid primary key default gen_random_uuid(),
  practice_question_id uuid not null references practice_questions(id) on delete cascade,
  session_id uuid not null,
  answer_text text not null,       -- selected choice text OR free-form response
  is_correct boolean,              -- null until graded
  feedback text,                   -- short explanation, populated after grading
  created_at timestamptz not null default now()
);
```

Notes:
- `mistakes` stores individual instances (for transparency/display on the results page), but `practice_questions` are generated per **category**, not per mistake instance — so 3 comma splices produce 1–2 questions, not 3.
- `practice_questions.choices`/`correct_choice_index` are used only for `multiple_choice`; `model_answer_notes` only for `short_response`. Enforce this pairing in application code (a DB check constraint on type-conditional nullability is optional, not required for v1).
- No `users` table. `session_id` is just an opaque UUID issued client-side on first visit, stored in a cookie, sent with requests to scope queries to "this browser's submissions." It provides continuity, not security — anyone with the UUID can read that data.

---

## 3. AI Pipeline (Groq calls)

Three sequential stages, each a separate Groq call with a narrow, focused prompt and a strict JSON schema for output (use Groq's JSON mode / response_format where supported; validate with a schema validator server-side — e.g. Zod — and treat a failed parse as a pipeline failure, not a crash).

**Typing & validation approach** (deliberate, not incidental — see §0):
- Define a Zod schema per stage's expected output (`Stage1ResultSchema`, `Stage2ResultSchema`, `Stage3ResultSchema`). Infer TypeScript types from each schema with `z.infer<...>` rather than hand-writing parallel types, so the runtime check and the compile-time type can never drift apart.
- Every Groq response is parsed through its schema with `.safeParse()` before any downstream code touches it. A failed parse is handled explicitly (see Edge Cases) — never passed through with `as` casts or optional chaining to paper over missing fields.
- The mistake `category` field is typed as a literal union (`type MistakeCategory = 'subject_verb_agreement' | 'comma_splice' | ...`), matching the Postgres `check` constraint, so invalid categories are a type error in code and a constraint violation in the DB — not just a runtime hope.
- No `any` in the pipeline code; Groq's raw response is treated as `unknown` until validated.

### Stage 1 — Grade & extract mistakes
**Input:** essay text.
**Output (JSON):**
```json
{
  "overall_feedback": "string, 2-4 sentences of holistic feedback",
  "mistakes": [
    { "category": "comma_splice", "quote": "exact excerpt", "explanation": "why this is wrong" }
  ]
}
```
- Category must be one of the 8 fixed enum values — instruct the model explicitly and reject/drop any mistake with an invalid category rather than failing the whole pipeline.
- If `mistakes` is empty, that's a valid result (well-written essay) — show a "no major issues found" state, not an error.

### Stage 2 — Group & generate practice questions
**Input:** the mistakes list from Stage 1, grouped by category in application code first (pure logic, no AI needed for grouping itself).
**Per category present, one Groq call (or one batched call covering all categories — batching preferred to reduce latency/cost):**
**Output (JSON) per category:**
```json
{
  "category": "comma_splice",
  "questions": [
    {
      "question_type": "multiple_choice",
      "prompt": "string",
      "choices": ["A", "B", "C", "D"],
      "correct_choice_index": 2
    }
  ]
}
```
- Routing rule (deterministic, in application code, not left to the model): grammar/mechanics categories (`subject_verb_agreement`, `comma_splice`, `run_on_sentence`, `tense_consistency`) → `multiple_choice`. Structure/argument categories (`thesis_clarity`, `weak_evidence`, `paragraph_structure`, `logical_flow`) → `short_response`.
- Generate 1–2 questions per category present (not per mistake instance).
- Questions should reference the student's actual essay content where natural (e.g. quote their own sentence in a "fix this" MCQ) to keep them personalized rather than generic drill questions.

### Stage 3 — Grade short-response answers (on-demand, when student submits)
**Input:** the question's `prompt` + `model_answer_notes`, and the student's `answer_text`.
**Output (JSON):**
```json
{ "is_correct": true, "feedback": "1-2 sentence explanation" }
```
- Multiple-choice answers are graded purely in application code (compare index), no AI call needed.
- Only short-response answers trigger a Stage 3 call, made when the student submits that specific answer.

### Pipeline orchestration notes
- Stages 1 and 2 run synchronously as part of essay submission (server route does: call Stage 1 → on success, call Stage 2 → persist submission + mistakes + questions in one DB transaction → return). If either call fails or returns invalid JSON, mark `submissions.status = 'failed'`, store `error_message`, and show the student a retry option — do not partially persist.
- Consider a reasonable timeout (e.g. 30s per call) and surface a clear "AI service timed out, try again" message rather than hanging.

---

## 4. UI Pages

### Page 1 — Submit (`/`)
- Textarea for essay paste (client + server validation: non-empty, reasonable min length e.g. 50 words, reasonable max length to bound token cost e.g. 5,000 words).
- Submit button → POST to a server action that runs Stages 1+2, then redirects to the results page for the new submission.
- Loading state while pipeline runs (this will take several seconds across two sequential Groq calls — show progress, e.g. "Grading..." → "Generating practice questions...").
- On pipeline failure: show error inline, let them retry without re-typing the essay (keep text in the textarea).

### Page 2 — Results (`/submissions/[id]`)
- Show `overall_feedback`.
- List mistakes, grouped by category, each showing the quoted excerpt + explanation.
- If no mistakes found, show a positive empty state.
- Link/button to "Practice" page for this submission.

### Page 3 — Practice (`/submissions/[id]/practice`)
- List practice questions, grouped by category.
- Multiple-choice: radio buttons, immediate client-side-confirmed feedback on submit (since grading is just an index comparison, can be instant — server still records the attempt).
- Short-response: textarea, submit triggers Stage 3 Groq call, shows spinner, then displays `is_correct` + `feedback` once returned.
- Persist each answer attempt; if the student reloads, show their previously submitted answers/feedback (read from `practice_answers` by `session_id` + `practice_question_id`) rather than a blank form — this is the "it remembers" behavior enabled by persisting everything.

No dashboard/history page in v1 (noted as a natural v2 addition below).

---

## 5. Edge Cases & Error Handling

- **Empty/too-short essay:** reject before calling Groq (saves cost, fast feedback).
- **Essay far exceeds reasonable length:** reject or truncate with a clear message — protects against runaway token cost.
- **Groq returns malformed/non-JSON output:** catch JSON parse errors, treat as pipeline failure, don't crash the request. Log the raw response server-side for debugging.
- **Groq returns a mistake with an invalid/hallucinated category:** drop that mistake (or coerce to closest valid category) rather than failing the whole batch.
- **Zero mistakes found:** valid, well-written-essay state — no practice questions generated, results page shows a positive message, practice page shows "nothing to practice."
- **Groq call times out or Groq API is down:** surface a clear, distinct error message; allow retry; don't lose the student's pasted essay text.
- **Quote in a mistake doesn't actually appear verbatim in the essay** (model paraphrased instead of quoting exactly): not fatal — display as-is; optionally do a substring check server-side and flag/log mismatches for prompt tuning, but don't block the pipeline on it.
- **Student submits a short-response answer that's empty or gibberish:** still send to Stage 3 grading (the model will mark it incorrect with feedback) — no special-case client validation needed beyond non-empty.
- **Duplicate/rapid resubmission of the same essay:** no dedup logic in v1 — each submission is independent; acceptable for single-user use.
- **Session id missing/cleared (cookies cleared mid-session):** a new UUID is generated; old submissions become inaccessible (expected, acceptable — no auth means no recovery mechanism, this is a known v1 limitation).

---

## 6. Configuration

- `GROQ_API_KEY` — required env var.
- `GROQ_MODEL` — env var, defaults to a current Groq-hosted model well-suited to structured JSON output (e.g. a Llama 3.x variant available on Groq at build time); kept configurable rather than hardcoded so it can be swapped without code changes.
- `SUPABASE_URL` / `SUPABASE_ANON_KEY` (or service role key, server-side only) for Postgres access.

---

## 7. Explicit Non-Goals for v1

- No authentication or multi-user roles.
- No file upload (essay must be pasted as plain text).
- No history/dashboard page showing trends across submissions over time.
- No rich short-response feedback (score + suggested rewrite) — pass/fail + short explanation only.
- No rate limiting / abuse protection beyond basic length validation (acceptable for a single-user tool).

These are reasonable next steps if the tool grows beyond a single-user prototype, but are intentionally excluded to keep v1 finishable and demoable end-to-end.
