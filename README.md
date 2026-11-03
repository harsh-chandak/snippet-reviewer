# Snippet Reviewer

Paste a code snippet, get an AI review, and work through the findings the way you would on a pull request: each finding sits under the line it refers to, and you accept or dismiss it.

## Run it

**With an API key (one command):**

```bash
cp .env.example .env    # set LLM_PROVIDER=anthropic, LLM_MODEL=claude-sonnet-5-5 and ANTHROPIC_API_KEY
docker compose up --build
```

- Web: http://localhost:3000
- API: http://localhost:4000/api/v1/health
- Postgres: localhost:5433 (user, password and database are all `snippets`)

The API runs its migrations when it starts, so a fresh database gets its tables automatically.

**With a Claude Code login instead of a key** (how I developed it): the default provider, `claude-headless`, runs the local `claude -p` CLI, so the API has to run on your machine rather than in Docker.

```bash
cp .env.example .env
docker compose up -d db
npm --prefix api install && npm --prefix api run dev
npm --prefix web install && npm --prefix web run dev
```

**Tests** (need the compose database running):

```bash
npm --prefix api test
```

## Architecture

```
Next.js (React, client components)
   │  every call goes through web/src/lib/api.ts
   ▼
Express API   routes → controllers → services → DAOs → Sequelize models
   │                                     │
   ▼                                     ▼
Postgres (migrations via Umzug)      llmService → provider: claude-headless | anthropic | fake
```

**One review, end to end**

1. `POST /snippets/:id/reviews` inserts a `reviews` row as `pending` and marks the snippet `in_progress`, in one transaction, then answers **202** straight away.
2. In the background the review becomes `running` and `llmService` asks the model for findings that match a JSON schema. The snippet is sent with line numbers, and the system prompt treats it as data, not instructions.
3. Every finding is checked again on our side. Ones with bad fields, or that point past the last line, are dropped and counted in `rejectedCount`.
4. The findings, the review (`done`) and the snippet (`reviewed`) are written in one transaction. Any failure marks the review `failed` with a message the user can read.
5. The snippet page polls `GET /reviews/:id` every 2 seconds while the review is pending or running, then shows the findings under their lines.
6. `PATCH /findings/:id` saves accept, dismiss or reopen, so the choice survives a reload.

**API** (all under `/api/v1`; every response is `{ message, data, success }`)

| Method | Path | |
|---|---|---|
| POST | `/snippets` | create (201); 400 with per-field messages |
| GET | `/snippets?language=&status=&limit=&cursor=` | dashboard list, newest first, cursor paging |
| GET | `/snippets/:id` | snippet with its latest review and findings |
| POST | `/snippets/:id/reviews` | start a review (202); 409 if one is already running |
| GET | `/reviews/:id` | review status, error and findings |
| PATCH | `/findings/:id` | `{ status: accepted \| dismissed \| open }` |
| GET | `/languages` | languages the API accepts |

## Key decisions and trade-offs

- **Reviews are asynchronous, with a status the user can see.** A model call takes seconds and can fail, so the request returns at once and the page follows the review's status. I chose polling over server push: it's simpler, and for one review at a time a 2-second poll is plenty. Server-Sent Events would be the next step.
- **The database stops a double review.** A partial unique index allows only one `pending` or `running` review per snippet. Two clicks at the same moment both try to insert; Postgres lets one through and the other gets a 409. Checking first in code and then inserting would leave a gap between the two.
- **Every review is kept.** A snippet can be reviewed again; each run is its own row with its own findings, and the page shows the latest. The snippet also stores the latest review's status, so the dashboard can filter on it without a join.
- **Nothing is left "in progress" forever.** Every path ends with the review `done` or `failed`, and at startup any review still `pending` or `running` (cut off by a restart) is marked failed with "run it again".
- **The model's output is not trusted.** It is asked for a schema, then validated again on our side, and findings on lines that don't exist are dropped and counted.
- **The database enforces its own rules.** CHECK constraints refuse an unknown status or a finding whose lines run backwards, on top of the API's validation.
- **Schema changes only through migrations.** The tables come from Umzug migrations run at startup, never from `sync()`, which can't change a table that already exists.
- **One place for the model.** `llmService` is the only code that talks to a model; `LLM_PROVIDER` picks claude-headless, anthropic, or fake (tests).
- **Findings look like PR review comments.** Shiki highlights the code line by line, so each finding can sit directly under its line.

## What I'd do differently

**With more time**

- Push review progress with Server-Sent Events instead of polling.
- Carry decisions across re-reviews: fingerprint findings so a finding dismissed once isn't raised again on the next run.
- Let users discuss a finding (the brief mentions it): a thread per finding, with the model able to reply.
- An end-to-end browser test for the create → review → accept flow.

**If this were a production system**

- Run reviews in a real job queue with leases (or a Postgres table read with `FOR UPDATE SKIP LOCKED`), so several API servers can share the work and a crashed worker's job is retried instead of failed.
- Cost and abuse limits: rate limits per user, a size and token budget per review, and caching reviews by a hash of the code.
- Measure review quality, not just errors: a saved set of snippets with known issues, run before every prompt or model change, and track the accept/dismiss rate by category.
- Logs and metrics for each review: provider, model, duration, rejected findings. A rising rejected count means the prompt or the model changed.
- Authentication, and snippets owned by users.

## AI usage log

_TODO (Harsh): tools used, 3–5 specific examples where AI helped or where you overrode it and why, and your overall impression. Raw notes are in AI-NOTES.md._
