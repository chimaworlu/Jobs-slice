# Jobs Slice — DOCUMENTATION.md

A background job system for reliable email delivery.

**Tech stack:** Next.js 16 (App Router), TypeScript, Prisma 6, PostgreSQL 16, Redis 7, Nodemailer, NextAuth v5, Zod.

**Auth:** reused from Assessment 1 — [github.com/chimaworlu/Auth-Slice](https://github.com/chimaworlu/Auth-Slice).

> **A note on BullMQ.** BullMQ was on the original list of candidate technologies, but this slice does **not** use it. The queue is built directly on PostgreSQL (a `Job` table plus a worker that claims rows atomically). Redis is used only by the reused auth code, for rate limiting. Why I chose Postgres over BullMQ is explained under [Atomic job claiming](#atomic-job-claiming) in Section 5.

---

## Section 1: What This Is

Jobs Slice takes the slowest, least reliable part of a web request — talking to an external email server — and moves it out of the request entirely. A signed-in user fills in a To / Subject / Message form on the dashboard. The API does not send the email; it validates the input, writes a `Job` row to PostgreSQL with status `PENDING`, and immediately answers `202 Accepted` with a job id. A separate worker process polls the database, atomically claims due jobs, sends them through Gmail with Nodemailer, and records the outcome. If a send fails, the job is rescheduled with exponential backoff and jitter; after a configurable number of attempts it is moved to `DEAD`, where it shows up in a dead letter view and can be retried by hand. Every attempt is recorded in a `JobLog` table, jobs are protected against double-submission by an idempotency key, and a periodic sweep rescues jobs left stuck in `PROCESSING` by a crashed or hung worker.

What is deliberately **not** included: there is no third-party queue (no BullMQ, SQS or RabbitMQ) — the queue lives in Postgres. There is only one job type, `SEND_EMAIL`. There is no priority ordering, no cron-style scheduling, no completion webhooks, no per-user job history screen and no admin console beyond the dead letter view. The job API routes are not behind authentication (see Section 7). The authentication layer — sign-up, email verification, sign-in, password reset — is reused from Assessment 1 and is not re-documented here beyond what this slice changed.

---

## Section 2: How To Run It

### Prerequisites

- **Node.js 22.18 or newer** (built and tested on Node 24). The worker is TypeScript run directly by Node's built-in type stripping — there is no build step and no `tsx`/`ts-node`.
- **Docker**, for PostgreSQL and Redis.
- A **Gmail account with 2-Step Verification** and an **App Password**.

### Steps

1. **Install dependencies.** `--legacy-peer-deps` is required because `next-auth@5` is still in beta and its peer ranges do not yet include Next 16.
   ```bash
   npm install --legacy-peer-deps
   ```

2. **Start PostgreSQL and Redis.** Any Postgres 16 and Redis 7 will do. These are the ports this project was developed against:
   ```bash
   docker run -d --name auth-slice-db    -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16
   docker run -d --name auth-slice-redis -p 6380:6379 redis:7
   ```

3. **Create the database.**
   ```bash
   docker exec auth-slice-db psql -U postgres -c "CREATE DATABASE jobs_slice"
   ```

4. **Create `.env`** by copying `.env.example` and filling in the values (full list below).

5. **Apply the migrations.** This creates the auth tables and the `Job`, `JobLog` and `JobStatus` objects.
   ```bash
   npx prisma migrate deploy
   ```

6. **Terminal 1 — start the Next.js app.**
   ```bash
   npm run dev
   ```

7. **Terminal 2 — start the worker.** It must run alongside the app; without it, jobs are accepted but stay `PENDING` forever.
   ```bash
   npm run worker
   ```
   This runs `node --env-file=.env worker/index.ts`. You should see `[worker] Starting { concurrency: 5, ... }`.

8. Open `http://localhost:3000`, sign up, verify your email, sign in, and use **Send Email** on the dashboard.

### Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `DATABASE_URL` | Yes | — | PostgreSQL connection string, e.g. `postgresql://postgres:postgres@localhost:5432/jobs_slice?schema=public`. Used by both the app and the worker. |
| `NEXTAUTH_SECRET` | Yes | — | Secret used to sign and encrypt session JWTs. Generate with `openssl rand -base64 32`. |
| `NEXTAUTH_URL` | Yes | — | Base URL of the app, e.g. `http://localhost:3000`. |
| `GMAIL_USER` | Yes | — | Gmail address that emails are sent from. |
| `GMAIL_PASS` | Yes | — | Gmail App Password for `GMAIL_USER` (not the account password). |
| `REDIS_URL` | Yes | — | Redis connection string for the auth rate limiter, e.g. `redis://localhost:6380`. |
| `JOB_MAX_ATTEMPTS` | No | `3` | Attempts a job gets before it is moved to `DEAD`. Stamped onto each job when it is created. |
| `JOB_CONCURRENCY` | No | `5` | Maximum jobs one worker process runs at the same time. |
| `JOB_STUCK_TIMEOUT_MS` | No | `300000` | How long (ms) a job can sit in `PROCESSING` before the sweep treats it as stuck. |
| `JOB_BACKOFF_BASE_MS` | No | `5000` | Base delay (ms) for exponential retry backoff. |
| `JOB_SWEEP_INTERVAL_MS` | No | `60000` | How often (ms) the worker runs the stuck-job sweep. |
| `JOB_POLL_INTERVAL_MS` | No | `1000` | How long (ms) the worker waits before polling again when no job is due. |

The job variables are parsed in `lib/job-config.ts`. A missing, empty, non-integer or non-positive value falls back to the default and logs a warning.

---

## Section 3: The Flow Step By Step

### The success path

**Step 1 — The user submits the email form.**
The dashboard (`app/dashboard/page.tsx`) is a server component that checks the session with `auth()` and renders `SendEmailView` for `?view=send` (the default). When the view mounts it generates an idempotency key with `crypto.randomUUID()` and holds it in a hidden field. On submit it validates `to`, `subject` and `message` with the same Zod schema the server uses (`lib/validations/jobs.ts`), then sends `POST /api/jobs` with `{ to, subject, html, idempotencyKey }`.
*Files:* `app/_components/SendEmailView.tsx`, `lib/validations/jobs.ts`

**Step 2 — The API creates the job and returns 202.**
The route validates the body again on the server. It looks up the idempotency key; if a job already has it, it returns `200` with that job and creates nothing. Otherwise it inserts a `Job` with `type: "SEND_EMAIL"`, `payload: { to, subject, html }`, `status: PENDING`, `attempts: 0`, `maxAttempts` from `JOB_MAX_ATTEMPTS`, and `runAt: now`, and returns `202 { jobId, status: "PENDING" }`. No email is sent here. If two identical requests race, the unique constraint rejects the second insert (Prisma error `P2002`), and the route returns the winner's job with `200` instead of a `500`.
*Files:* `app/api/jobs/route.ts`, `lib/job-config.ts`, `lib/db.ts`

**Step 3 — The worker claims the job.**
The worker (`worker/index.ts`) loops: wait for a free concurrency slot, then run one SQL statement that picks the oldest `PENDING` job whose `runAt` has passed, locks it with `FOR UPDATE SKIP LOCKED`, and flips it to `PROCESSING` while setting `startedAt = now` and `attempts = attempts + 1`, all in one step. If no job is due it sleeps for `JOB_POLL_INTERVAL_MS`.
*File:* `worker/index.ts` (`claimJob`)

**Step 4 — The worker processes the job.**
It writes a `JobLog` row for this attempt (`status: PROCESSING`, `startedAt`), validates the stored payload against `sendEmailPayloadSchema`, and calls `sendEmail`.
*Files:* `worker/index.ts` (`processJob`, `runJob`), `lib/validations/jobs.ts`

**Step 5 — The email is sent.**
`sendEmail` is the only place in the project that talks to Nodemailer. It connects to `smtp.gmail.com` on port 587 with STARTTLS and authenticates with `GMAIL_USER` / `GMAIL_PASS`. On failure it logs the error with the recipient and subject, then rethrows it so the worker sees the failure.
*File:* `lib/email.ts`

**Step 6 — The status updates to SUCCEEDED.**
The worker sets the job to `SUCCEEDED` with `finishedAt`, and closes the `JobLog` row as `SUCCEEDED`. That write is guarded: it only applies if the job is still `PROCESSING` with the same attempt number, so a result can never overwrite a job the sweep has already taken back. On the dashboard, **Check Status** calls `GET /api/jobs/[jobId]` and then refreshes every 3 seconds until the status is `SUCCEEDED`, `FAILED` or `DEAD`.
*Files:* `worker/index.ts`, `app/api/jobs/[jobId]/route.ts`, `app/_components/SendEmailView.tsx`

**Evidence — the worker claiming a job and completing it on attempt 1:**

![Worker log: job claimed on attempt 1 and marked SUCCEEDED](Screenshot/SUCCEEDED%20terminal.png)

### The failure path

To demonstrate this path, `lib/email.ts` was temporarily pointed at an environment variable that does not exist, so Nodemailer had no password and every send failed with `Missing credentials for "PLAIN"`.

**Step 1 — The job fails.**
`sendEmail` throws. The worker catches it, stores the message in `Job.lastError`, and closes the attempt's `JobLog` row as `FAILED` with the error and `finishedAt`.
*Files:* `lib/email.ts`, `worker/index.ts`

**Step 2 — Backoff is applied.**
If `attempts < maxAttempts`, the job goes back to `PENDING` with `runAt = now + 2^attempts × JOB_BACKOFF_BASE_MS + random(0–1000 ms)`. With the defaults that is about 10 seconds after attempt 1 and about 20 seconds after attempt 2.
*Files:* `worker/index.ts`, `lib/job-config.ts` (`getBackoffDelayMs`)

**Step 3 — Retries happen.**
The claim query ignores the job until its `runAt` has passed, then claims it again exactly as in the success path: `attempts` increments and a new `JobLog` row is written.
*File:* `worker/index.ts`

**Step 4 — The job goes to DEAD.**
When the attempt that just failed brings `attempts` up to `maxAttempts` (3 by default), the job is set to `DEAD` with `finishedAt`, and the final `JobLog` row is closed as `DEAD`. The worker stops touching it.
*File:* `worker/index.ts`

**Evidence — `JobLog` in Prisma Studio.** The first row is the successful job's single `SUCCEEDED` attempt. The other nine are three jobs that each went `FAILED` (attempt 1), `FAILED` (attempt 2), `DEAD` (attempt 3), all with `Missing credentials for "PLAIN"`:

![Prisma Studio JobLog table: one SUCCEEDED attempt, then three jobs failing twice and going DEAD on attempt 3](Screenshot/Database%20screenshot.png)

**Step 5 — The user retries from the dead letter view.**
**Dead Letter** in the dashboard nav (`?view=dead`) renders `DeadLetterView`, which calls `GET /api/jobs/dead` and lists every `DEAD` job with its id, recipient, subject, last error and creation time. **Retry** calls `POST /api/jobs/[jobId]/retry`, which returns `400 "Only dead jobs can be retried"` for anything not `DEAD`, and otherwise resets the job to `PENDING` with `runAt = now` and `lastError = null`. The reset is guarded on `status = DEAD`, so two quick clicks cannot both succeed. The UI shows "Job requeued" and removes the job from the list. `attempts` is not reset, so a manual retry buys exactly one more attempt: if it succeeds the job becomes `SUCCEEDED`; if it fails, it goes straight back to `DEAD`.
*Files:* `app/_components/DeadLetterView.tsx`, `app/api/jobs/dead/route.ts`, `app/api/jobs/[jobId]/retry/route.ts`

**Evidence — the dead letter view with three dead jobs, each ready to retry:**

![Dead letter view listing three DEAD jobs with Missing credentials for PLAIN and a Retry button on each](Screenshot/job%20as%20DEAD.png)

---

## Section 4: The Data Model

Both models live in `prisma/schema.prisma` and were added by the migration `20260929131851_add_job_schema`. The auth models from Assessment 1 (`User`, `Session`, `VerificationCode`, `PasswordResetToken`) are unchanged.

### Job

One row per logical unit of work: one email to send.

| Field | Type | Why |
|---|---|---|
| `id` | `String @id @default(cuid())` | Collision-resistant id that is safe to expose in URLs (`/api/jobs/[jobId]`) and does not reveal how many jobs exist, unlike an auto-increment integer. |
| `type` | `String` | What kind of work this is. Always `"SEND_EMAIL"` today. It is a string rather than an enum so a new job type does not need a database migration. The worker rejects unknown types. |
| `payload` | `Json` (Postgres `JSONB`) | The input the job needs: `{ to, subject, html }`. See [Payload as JSON](#why-the-job-payload-is-stored-as-json-in-the-database) in Section 5. |
| `status` | `JobStatus` enum, default `PENDING` | `PENDING`, `PROCESSING`, `SUCCEEDED`, `FAILED` or `DEAD`. A Postgres enum means a typo like `'SUCEEDED'` is rejected by the database itself, not just by TypeScript. |
| `attempts` | `Int @default(0)` | How many attempts have been started. It increments when the job is claimed, not when it fails, so a crash mid-send still counts as an attempt. |
| `maxAttempts` | `Int @default(3)` | Set per job from `JOB_MAX_ATTEMPTS` when the job is created. Stored on the row so that changing the config later does not change the rules for jobs already in flight. The schema default is only a fallback, because Prisma defaults cannot read environment variables. |
| `lastError` | `String?` | The most recent failure message. Cleared on success and on manual retry. |
| `idempotencyKey` | `String @unique` | The client-supplied key that makes the same logical job impossible to create twice. See below. |
| `runAt` | `DateTime @default(now())` | The earliest time the job may next be attempted. See below. |
| `startedAt` | `DateTime?` | When the current or last attempt was claimed. The stuck-job sweep compares it against `JOB_STUCK_TIMEOUT_MS`. |
| `finishedAt` | `DateTime?` | When the job reached a final state (`SUCCEEDED` or `DEAD`). Null while the job is still live. |
| `createdAt` / `updatedAt` | `DateTime` | Audit timestamps. The dead letter view sorts by `createdAt desc`. |

**Indexes:**
- `@@index([status, runAt])` serves the worker's hottest query, `WHERE status = 'PENDING' AND runAt <= now() ORDER BY runAt`, so Postgres can jump straight to the due pending jobs in order.
- `@@index([status])` serves the dead letter query, `WHERE status = 'DEAD'`.
- `@@index([idempotencyKey])` was requested for idempotency checks. In practice the `@unique` constraint already creates a unique index on that column, so this second index is redundant: it adds a little write cost and no read benefit. I would remove it in a follow-up.

**Why `idempotencyKey` exists and is unique.** Networks retry. A user double-clicks, a mobile connection drops after the request arrived but before the response came back, or a client library retries on timeout. Without a key, each of those creates another job and the recipient gets the same email two or three times. The client generates the key once per logical email, and the server treats it as that email's identity: the first request creates the job, and every later request with the same key gets the existing job back. The key is **unique at the database level**, not just checked in code, because a check-then-insert in application code has a race: two requests can both see "no job yet" and both insert. The unique constraint makes the second insert fail, and the route turns that failure into "return the existing job".

**Why `runAt` exists.** Retrying a failed send immediately usually fails again: the SMTP server is still down, still rate-limiting, or DNS is still broken. `runAt` lets a job say "not before this time", which is how backoff is stored. When an attempt fails, the worker sets `runAt` into the future and puts the job back to `PENDING`, and the claim query simply skips it until then. Because the delay lives in the row rather than in a `setTimeout` inside the worker, it survives worker restarts and works across any number of workers. New jobs get `runAt = now`, so they are eligible immediately.

### JobLog

One row per **attempt**: a job that fails twice and then succeeds has three `JobLog` rows.

| Field | Type | Why |
|---|---|---|
| `id` | `String @id @default(cuid())` | Row identity. |
| `jobId` | `String`, FK → `Job.id`, `onDelete: Cascade` | Which job this attempt belongs to. Cascade delete means removing a job cannot leave orphaned logs behind. |
| `attempt` | `Int` | The attempt number (1, 2, 3…), copied from `Job.attempts` at claim time. |
| `status` | `String` | What happened on this attempt: `PROCESSING` while running, then `SUCCEEDED`, `FAILED` (will be retried), `DEAD` (last attempt, gave up) or `TIMED_OUT` (closed by the stuck-job sweep). It is a plain string rather than the `JobStatus` enum because it describes an attempt outcome, which has values the job lifecycle does not have (`TIMED_OUT`). |
| `error` | `String?` | The error for this specific attempt. |
| `startedAt` / `finishedAt` | `DateTime` / `DateTime?` | Duration of the attempt. A null `finishedAt` means the attempt is still running, or its worker died. |
| `createdAt` | `DateTime @default(now())` | Audit timestamp. |

It has one index, `@@index([jobId])`, because every query for logs is "the logs for this job".

**Why `JobLog` exists separately from `Job`.** A `Job` row is the **current state**, and it gets overwritten: `status`, `attempts`, `runAt` and `lastError` all change on every attempt. If that were the only record, attempt 1's error would be gone the moment attempt 2 wrote its own. `JobLog` is an **append-only history**. It answers questions `Job` cannot: did all three attempts fail the same way? How long did each attempt take? Did the sweep have to rescue this job? Keeping the two apart also keeps the hot table narrow: the worker's claim query touches `Job` on every poll and never needs to read history.

**Why `lastError` is on `Job`, not only on `JobLog`.** Because the most common question, "why is this job failing?", should be answerable by reading one row. The dead letter view lists dozens of jobs with their errors, and the status endpoint returns `lastError` on every poll. If the error lived only in `JobLog`, each of those reads would need a join or a sub-query for the newest log per job. So `lastError` is a deliberate denormalisation: a copy of the latest attempt's error, kept on the row that is read constantly. `JobLog.error` keeps the full history, and `Job.lastError` keeps the answer that matters right now.

---

## Section 5: The Concepts

### Why the API returns 202, not 200

**What it is.** `202 Accepted` is the HTTP status for "your request has been received and will be processed, but it has not been completed yet". `200 OK` means "done, here is the result".

**Why it is needed.** When `POST /api/jobs` responds, the email has not been sent; it may not be sent for seconds, or at all. Returning `200` would tell the client the work is complete when it is not. `202` is honest about that, and it tells the client to look elsewhere for the outcome, which here is the job id and the status endpoint. It also lets the API answer in milliseconds regardless of how slow or broken Gmail is.

**How I implemented it.** `app/api/jobs/route.ts` returns `202 { jobId, status: "PENDING" }` after inserting the row and before any email work happens. The client then polls `GET /api/jobs/[jobId]` (`SendEmailView` refreshes every 3 seconds) until a final status. A duplicate idempotency key returns `200` with the existing job, because in that case nothing new was accepted: the client is being handed a job that already exists.

**What I chose against.** Sending the email inside the request and returning `200`: that ties the response time to SMTP (the Assessment 1 port-465 problem made sign-up hang for 21 seconds), and a failed send becomes a failed request with no retry. I also chose against `201 Created`. A row was created, but `201` suggests the resource is complete, and I wanted the status to say "accepted for processing". I also chose against a push channel (WebSocket or server-sent events) for completion; polling is simpler and enough at this scale.

### Idempotency in job systems

**What it is.** An operation is idempotent if doing it twice has the same effect as doing it once. For job creation, that means submitting the same logical email twice creates one job, not two.

**Why it is needed.** Without it, every client retry, double-click or proxy retry creates another job, and because each job really sends, the recipient gets duplicate emails. That is user-visible and embarrassing for a notification, and harmful for anything like "your payment was received". Queues make this worse, not better: the API returns quickly, so a user who sees no immediate result is more likely to click again.

**How I implemented it.** The client generates a UUID when the form mounts (`crypto.randomUUID()` in `SendEmailView`) and sends it with every submit of that form. **Send another email** generates a fresh one. On the server there are two layers. First, a lookup: if a job with this key exists, return it with `200`. Second, `idempotencyKey` is `@unique` in Postgres, so if two requests race past the lookup, the second insert fails with `P2002`, and the route catches it and returns the existing job. The UI shows "This email was already queued" with the original job id.

**What I chose against.** Deriving the key on the server from a hash of `to + subject + html`: that would wrongly block a user who legitimately wants to send the same message twice. The client knows the difference between "retrying this send" and "sending again"; the server does not. I also chose against relying on the lookup alone without the unique constraint (it races), and against storing keys in Redis with a TTL. That would put job identity in a different system from the job itself, and a Redis flush would silently disable duplicate protection.

### Exponential backoff with jitter

**What it is.** When an attempt fails, wait before retrying, and make each wait longer than the last (exponential), with a small random amount added (jitter).

**Why it is needed.** Most send failures are temporary: an SMTP hiccup, a rate limit, a DNS failure. Retrying immediately usually hits the same problem and adds load to a service that is already struggling. Growing delays give the problem time to clear. Jitter matters when many jobs fail at once, for example during a Gmail outage: without it they would all retry at exactly the same moment, fail together again, and keep hitting the server in synchronised waves (the "thundering herd" problem). Jitter spreads those retries out.

**How I implemented it.** In `lib/job-config.ts`:

```ts
delay = Math.pow(2, attempts) * JOB_BACKOFF_BASE_MS + Math.random() * 1000
```

`attempts` is the attempt that just failed (1, 2, …). With the default base of 5000 ms:

| After attempt | Delay |
|---|---|
| 1 | 10 s + 0–1 s jitter |
| 2 | 20 s + 0–1 s jitter |
| 3 (with `JOB_MAX_ATTEMPTS=3`) | none: the job goes to `DEAD` |

The worker writes `runAt = now + delay` and sets the job back to `PENDING`. The claim query's `runAt <= now()` condition enforces the wait. The same formula is used when the sweep resets a stuck job.

**What I chose against.** A fixed delay (it does not back off from a service that is struggling). Immediate retry (it wastes attempts on the same failure). Full jitter (`random(0, 2^n × base)`), which spreads retries more widely but makes delays unpredictable and hard to demonstrate. A fixed 0–1 s jitter on top of an exponential base is predictable and still breaks up synchronised retries. I also chose against `setTimeout` in the worker to hold the delay, because the delay would be lost if the worker restarted.

### Dead letter queues, and why DEAD is different from FAILED

**What it is.** A dead letter queue is where messages go when the system has given up on them. They are kept for a human to inspect and act on, rather than retried forever or silently dropped.

**Why it is needed.** Some failures are permanent: a wrong password, a malformed payload, a rejected address. Without a limit, those jobs would retry forever, wasting work and hiding real problems among the noise. Without a dead letter state, they would just disappear. `DEAD` is an explicit "this needs a person" state. The difference from `FAILED` is intent. In this system, **`FAILED` describes one attempt**: that attempt failed and the job will be retried. You see it on `JobLog` rows, and while it is retrying the job itself goes back to `PENDING`. **`DEAD` describes the job**: every allowed attempt has been used up, the worker will never pick it up again, and only a human action can bring it back. The `JobStatus` enum includes `FAILED`, and the UI treats it as terminal, but the worker never leaves a job in `FAILED`; a job moves from `PENDING` to `SUCCEEDED` or to `DEAD`.

**How I implemented it.** When an attempt fails and `attempts >= maxAttempts`, the worker sets `status = DEAD`, `finishedAt` and `lastError`. `GET /api/jobs/dead` lists dead jobs, newest first, with their payload and error. `DeadLetterView` renders them. `POST /api/jobs/[jobId]/retry` is the only way out of `DEAD`. It refuses anything that is not `DEAD` (`400`), and resets `status = PENDING`, `runAt = now` and `lastError = null` with a guarded update so two quick clicks cannot both succeed. The dead letter screenshot in Section 3 shows three jobs in this state.

**What I chose against.** A separate `DeadJob` table (moving rows between tables complicates retry and loses the link to `JobLog`; a status value does the same job). Deleting jobs after the last failure (it loses the evidence). Automatic re-queueing of dead jobs after a delay (it just repeats the failure if the cause is permanent). I also chose against resetting `attempts` on manual retry. A retried dead job gets exactly one more attempt, so retrying a job whose cause has not been fixed returns it to `DEAD` in seconds instead of starting three more rounds of backoff.

### Atomic job claiming

**What it is.** Claiming means a worker marking a job as "mine, in progress". Atomic means the check ("is it still pending?") and the change ("set it to processing") happen as one indivisible operation that nothing else can interleave with.

**Why it is needed.** The naive version is two steps: `SELECT` a pending job, then `UPDATE` it to `PROCESSING`. Between those steps, a second worker (or a second concurrency slot in the same worker) can `SELECT` the same row. Both then send the email: a duplicate that idempotency on the API cannot prevent, because it happens after the job exists.

**How I implemented it.** One statement in `worker/index.ts` (`claimJob`):

```sql
UPDATE "Job"
SET "status" = 'PROCESSING', "startedAt" = now(), "attempts" = "attempts" + 1, ...
WHERE "id" = (
  SELECT "id" FROM "Job"
  WHERE "status" = 'PENDING' AND "runAt" <= now()
  ORDER BY "runAt" ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED
)
RETURNING ...
```

`FOR UPDATE` locks the chosen row until the statement finishes. `SKIP LOCKED` makes any other worker running the same query skip that row and take the next one, rather than wait for it or take it too. The claim itself increments `attempts`, so an attempt is counted even if the worker then crashes. After sending, the worker only writes the result if the job is still `PROCESSING` with the same `attempts` value; otherwise the sweep has already taken the job back, and the late result is discarded rather than overwriting the newer state.

**What I chose against.** **BullMQ on Redis**, the other obvious design. It handles claiming, retries and backoff for you. I chose Postgres because the job and the data it depends on then live in the same database with the same backups, idempotency is a plain unique constraint, the dead letter view and job history are ordinary SQL queries, and there is one fewer system that can be down. The cost is polling rather than push, and a ceiling on throughput that this slice will never reach. I also chose against a Prisma `findFirst` + `update` pair (it races as described above) and against an application-level lock in Redis (a second system to keep consistent with the first).

### Stuck job detection

**What it is.** A periodic sweep that finds jobs which have been in `PROCESSING` for too long and hands them back to the queue.

**Why it is needed.** A job moves to `PROCESSING` when it is claimed, and only the worker that claimed it can move it on. If that worker crashes, is killed, loses power, or hangs on a network call that never returns, the job stays in `PROCESSING` forever. It is not `PENDING`, so no worker will claim it, and it is not finished, so nobody sees it fail. Without a sweep, those jobs vanish silently.

**How I implemented it.** Every `JOB_SWEEP_INTERVAL_MS` (60 s by default), and once at startup, `sweepStuckJobs` in `worker/index.ts` finds jobs with `status = PROCESSING` and `startedAt` older than `JOB_STUCK_TIMEOUT_MS` (5 minutes). For each one:
- If it still has attempts left, the job goes back to `PENDING` with a backoff `runAt` and `lastError = "Timed out after …ms in PROCESSING"`.
- If it has none left, it goes to `DEAD`.
- The open `JobLog` row for that attempt is closed as `TIMED_OUT`.

The reset is guarded on `status = PROCESSING` and the same `startedAt`, so if the job finished in the meantime, the sweep leaves it alone. `attempts` is **not** incremented again, because the claim already counted that attempt; incrementing here would make a stuck job lose two attempts for one try.

**What I chose against.** Heartbeats (a worker updating `lastHeartbeatAt` every few seconds while it works). They detect a dead worker faster, but add writes and complexity that a 5-minute email timeout does not need. I also chose against resetting stuck jobs straight to `PENDING` without checking attempts, which would let a job that keeps hanging exceed `maxAttempts` indefinitely.

### Separation of concerns between the Next.js app and the worker process

**What it is.** The web app and the worker are two separate programs. The app accepts requests and reads and writes rows; the worker sends email. They share code (`lib/`) and a database, but not a process.

**Why it is needed.** Next.js route handlers exist to serve a request and finish. Work started after the response has been sent is not guaranteed to run: on serverless hosting the function can be frozen, and in development the server can hot-reload. A long-running polling loop and a periodic sweep need a process that stays alive. Separation also isolates failure: a hung SMTP connection ties up a worker slot, not a web request, and the two can be restarted, scaled and deployed independently.

**How I implemented it.** `worker/index.ts` is a standalone Node process started with `npm run worker` (`node --env-file=.env worker/index.ts`). It imports the same Prisma client (`lib/db.ts`), config (`lib/job-config.ts`), payload schema (`lib/validations/jobs.ts`) and email service (`lib/email.ts`) as the app, so there is one definition of each. The only thing that connects the two processes is the `Job` table: the app writes `PENDING` rows and the worker moves them on. The worker handles `SIGINT`/`SIGTERM` by no longer claiming new jobs, waiting for in-flight jobs to finish, and then disconnecting.

**What I chose against.** Running the worker loop inside the Next.js server (see Section 8 for that tradeoff). I also chose against Next.js `after()` / fire-and-forget work in the route: it does not survive a crash, and retries would have nowhere to live. And I chose against a separate build step (`tsx`, `ts-node` or a compile to `dist/`), because Node runs the TypeScript directly with type stripping.

### Why the job payload is stored as JSON in the database

**What it is.** The job's input (`{ to, subject, html }`) is stored in a single `payload` column of type `Json`, which is `JSONB` in Postgres, rather than in dedicated columns.

**Why it is needed.** The `Job` table is generic: `type` says what kind of work a row is, and different types need different inputs. An email needs `to`/`subject`/`html`; a future "generate report" job would need entirely different fields. A JSON payload lets one table and one worker loop carry any job type without a schema change per type. Storing the payload also makes each job self-contained: it holds everything needed to run it, so a retry hours later sends exactly what was originally requested, even if related records have changed since.

**How I implemented it.** The enqueue route writes `payload: { to, subject, html }` after validating it. Because JSON is untyped at the database level, the worker does not trust it: `runJob` parses it again with `sendEmailPayloadSchema` before sending. A malformed payload becomes a normal failed attempt with a clear error instead of crashing the worker. The dead letter view reads `to` and `subject` out of the payload defensively.

**What I chose against.** Dedicated `to`/`subject`/`html` columns. They would be typed and queryable, but they tie the `Job` table to one job type, and every new type would need a migration. I also chose against storing only a reference (for example a `userId`) and looking the data up at send time: the result would depend on when the job ran, which makes retries unpredictable.

### The poll interval and why it is configurable

**What it is.** When the worker asks for a job and none is due, it sleeps for `JOB_POLL_INTERVAL_MS` (default 1000 ms) before asking again.

**Why it is needed.** A polling worker needs some delay; without one, an idle worker would query Postgres continuously. The right value depends on the setting, which is why it is configurable. A shorter interval means lower latency between enqueue and send, at the cost of more idle queries. In development or a demo, 1 second makes the system feel instant. In production with many workers, a longer interval cuts idle load. In tests, a very short one makes tests fast. Because the value is read from the environment, it can be tuned without a code change.

**How I implemented it.** `JOB_POLL_INTERVAL_MS` is read in `lib/job-config.ts` like every other job setting. The worker sleeps only when a claim comes back empty; when jobs are waiting, it claims them one after another with no sleep until the concurrency limit is reached. It also waits on a semaphore rather than polling while all `JOB_CONCURRENCY` slots are busy, so a full worker makes no idle queries at all.

**What I chose against.** Postgres `LISTEN/NOTIFY`, which would have the API wake the worker the moment a job is inserted. It gives near-zero latency, but it still needs a polling fallback for delayed retries (`runAt` in the future) and for notifications missed while the worker was down, so it adds a second mechanism rather than replacing the first. I also chose against a hard-coded interval, and against adaptive backoff of the poll interval when idle (more moving parts than one configurable number).

---

## Section 6: What Went Wrong

### Problem 1 — Database port mismatch: the sweep failed and nothing could be queued

**Symptom.** The worker claimed and completed a job, then logged `[worker] Stuck job sweep failed` with a `PrismaClientKnownRequestError` from `prisma.job.findMany()`. Around the same time, submitting the Send Email form showed "Something went wrong. Please try again later." every time.

![Worker log showing a successful job followed by Stuck job sweep failed](Screenshot/SUCCEEDED%20terminal.png)

**Investigation.** I reproduced the form's request with `curl` against `POST /api/jobs` and got an empty `500`. The route catches database errors and returns a generic message, so I ran the same `prisma.job.create()` directly from Node with the project's `.env`. It failed with `Can't reach database server at localhost:5433`. `docker ps` showed that nothing was listening on 5433: the Postgres container on that port (from another project) had been stopped hours earlier. The database that actually held the migrated `Job` tables and my user account was `auth-slice-db` on port **5432**.

**Cause.** `DATABASE_URL` in `.env` had been changed to point at `localhost:5433/jobs_slice`. Earlier in the build the project had used a Postgres container on 5433 before moving to 5432, and the old value had come back into `.env`. Every query from both processes — the enqueue route, the worker's claim loop and its periodic sweep — depends on that one variable.

**Fix.** I set `DATABASE_URL` back to `postgresql://postgres:postgres@localhost:5432/jobs_slice?schema=public`, then restarted **both** the dev server and the worker. The restart matters: `lib/db.ts` caches the Prisma client on `globalThis`, so the running dev server kept using the old connection string even after `.env` changed. Lesson: when a job system has two processes, both have to be restarted after a config change, and "the API works" does not prove "the worker works".

### Problem 2 — Redis port mismatch: the rate limiter could not connect

**Symptom.** The dev server log filled with repeated `[ioredis] Unhandled error event: AggregateError` lines. Sign-in and sign-up both call the Redis rate limiter before doing anything else, so they could not complete.

**Investigation.** `REDIS_URL` pointed at `redis://localhost:6379`. `docker ps` showed that the Redis container on 6379 belonged to another project and had been stopped; this project's Redis, `auth-slice-redis`, was running on **6380** (mapped `6380 → 6379` inside the container, as in Assessment 1). When I then corrected the port by hand, the line became `REDIS_URL=REDIS_URL=redis://localhost:6380`: the variable name had been pasted into its own value.

**Cause.** A port copied from a different project's Redis, and then a copy-paste typo in the fix.

**Fix.** `REDIS_URL=redis://localhost:6380`, followed by a dev server restart. This is the same class of bug as Problem 1 and as Assessment 1's Problem 1. With several Docker projects on one machine, the port is the only thing distinguishing "my database" from "someone else's database", so I now check `docker ps` against `.env` before debugging any "can't connect" error.

### Problem 3 — Rate limiter library upgrade broke sign-up with a generic 500

**Symptom.** With Redis now reachable, sign-up still failed with "Something went wrong. Please try again." No user row was created. `curl` against `/api/auth/signup` returned an empty `500`, even for an email that already existed (a path that sends no email).

**Investigation.** Because no user was created, the failure had to happen before the insert, which left the validation, the rate limiter or the user lookup. I called `checkRateLimit()` and `prisma.user.findUnique()` directly from Node. The database lookup worked. The rate limiter threw `ReplyError: ERR Unexpected flag in script shebang: allow-key-locking`. The previous project used `@upstash/ratelimit` **2.0.8**; this one had **2.2.0** installed, and that string only appears in the newer version's code.

**Cause.** `package.json` said `"@upstash/ratelimit": "^2.0.8"`. The copied project had no lockfile, so a fresh `npm install` resolved the caret to 2.2.0. That version sends Lua scripts with an `allow-key-locking` flag that self-hosted Redis 7.4 does not recognise (the library is built for Upstash's hosted Redis), so every rate-limit check threw, and the auth routes did not catch the error.

**Fix.** I pinned the exact version: `npm install @upstash/ratelimit@2.0.8 --save-exact`. The rate limiter check then passed and sign-up returned `200` without a server restart. Lesson: a caret range plus no lockfile means "whatever is newest today". A lockfile would have prevented this.

### Problem 4 — Email transport port (carried over from Assessment 1)

**Symptom.** In Assessment 1, every sign-up hung for about 21 seconds and then failed with a generic 500.

**Investigation.** I checked the Gmail credentials, 2-Step Verification, the App Password and the Nodemailer configuration. None of these were the problem.

**Cause.** `service: 'gmail'` makes Nodemailer connect on port **465** (implicit TLS), and the network was blocking outbound 465. Each send waited for a TCP timeout.

**Fix.** Connect explicitly with `host: 'smtp.gmail.com'`, `port: 587`, `secure: false`, which uses STARTTLS on port 587. This slice kept that configuration and made `lib/email.ts` the only place that creates the transport, so the fix cannot be undone by a second, differently configured transporter elsewhere. Moving sends into the worker also means a slow SMTP server can no longer hold a web request open for 21 seconds. At worst it now delays a background job.

### Problem 5 — Intermittent DNS failure for smtp.gmail.com

**Symptom.** A new user was created but never received their verification code. Sending the same email by hand a few minutes later failed with `getaddrinfo ENOTFOUND smtp.gmail.com`, and a minute after that, it worked.

**Investigation.** `google.com` and `registry.npmjs.org` resolved fine, but the router's DNS (`192.168.1.1`) answered `DNS operation refused` for `smtp.gmail.com` only, and only sometimes. The same name resolved normally through `8.8.8.8`, and port 587 on Gmail's IP was reachable.

**Cause.** An unreliable local DNS resolver, not the application. Because the auth routes from Assessment 1 send email directly inside the request, a single failed DNS lookup at that moment meant the verification email was lost for good. The user was told something went wrong, and a later sign-up attempt with the same email returned "already registered".

**Fix.** Switching the machine's DNS to `8.8.8.8` / `1.1.1.1` removes the cause. The real lesson is architectural, and it is the point of this slice: a job sent through the queue would have retried after about 10 seconds and succeeded. Moving the auth emails (verification, resend, password reset) onto the queue is listed in Section 7 as unfinished.

---

## Section 7: What This Slice Does Not Handle

- **No priority queue.** Jobs are claimed strictly in `runAt` order. A password-reset email waits behind a bulk send queued earlier. Priority would need a `priority` column and an `ORDER BY priority DESC, runAt`.
- **No scheduling for future times beyond `runAt`.** `runAt` can technically be set in the future, but the API always sets it to `now`, and there is no way to say "send this at 9am tomorrow" or "every Monday". There is no cron, recurrence or time-zone handling.
- **No webhook on completion.** Clients find out a job's result only by polling `GET /api/jobs/[jobId]`. Nothing notifies a caller when a job succeeds or dies.
- **No admin UI beyond the dead letter view.** You cannot list all jobs, filter by status or recipient, view a job's `JobLog` history, cancel a pending job, or delete jobs from the UI. That needs Prisma Studio or SQL.
- **The worker must be started manually.** Nothing supervises it. If it is not running, or it crashes, jobs are accepted with `202` and sit in `PENDING` with no alert. There is no process manager, health check or restart policy, and no "queue depth" or "oldest pending job" metric.
- **Scaling beyond one worker process is untested and uncoordinated.** Claiming is safe for several workers, because it uses a Postgres row lock (`FOR UPDATE SKIP LOCKED`) rather than an in-memory lock; no shared Redis lock is needed for that. What is missing is **coordination**: `JOB_CONCURRENCY` limits each process, not the fleet, so N workers send up to 5×N emails at once with no global cap to stay under Gmail's sending limits. Every worker also runs its own stuck-job sweep. The sweeps are safe to overlap, because the reset is guarded, but they do duplicate work. A global rate limit — for example the existing Redis rate limiter, shared across workers — would be the next step.
- **The job API routes are not authenticated.** `POST /api/jobs`, `GET /api/jobs/[jobId]`, `GET /api/jobs/dead` and `POST /api/jobs/[jobId]/retry` are open, as the brief specified. Only the dashboard page is behind sign-in. Anyone who can reach the server can send email from the configured Gmail account and read other users' payloads. This is fine on localhost, but it must be fixed before any deployment.
- **Jobs are not tied to users.** `Job` has no `userId`, so there is no "my emails" view, and no per-user quota or rate limit on enqueueing.
- **The auth emails still bypass the queue.** Verification, resend and password-reset emails are still sent directly inside the request, as in Assessment 1, so they get no retries (see Problem 5).
- **No cleanup or retention.** `SUCCEEDED` jobs and their `JobLog` rows are kept forever.
- **One job type, one provider.** Only `SEND_EMAIL`, only through Gmail SMTP. There is no provider failover and no bounce handling: "SUCCEEDED" means Gmail accepted the message, not that it reached the inbox.

---

## Section 8: If I Built This Again

The one thing I would reconsider is running the worker as a second process. Two terminals — `npm run dev` and `npm run worker` — caused real friction during this build: jobs sat in `PENDING` whenever I forgot to start the worker; changing `.env` or `lib/email.ts` meant restarting two processes, and forgetting one left them running different config (Problem 1, and the dead-job demo, which only took effect once the worker restarted); and a reviewer cloning the project gets a working API that silently never sends anything. Starting the worker loop inside the Next.js process (for example from `instrumentation.ts`'s `register()` hook) would make that disappear: one command, one config, one set of logs, and every server that runs the app automatically runs the worker too. The price is the reason the separation exists. The worker would share the web server's memory and event loop, so a burst of slow SMTP sends could slow page responses. A dev-server hot reload would kill in-flight jobs, which then have to wait for the stuck-job sweep to be rescued. On serverless hosting there is no long-lived process to run the loop at all. And you can no longer scale "more workers" without also scaling "more web servers". Knowing what I know now, I would keep them as two processes in production, but give the project a single `npm run dev:all` that starts both with prefixed, coloured logs (for example with `concurrently`). That keeps the separation where it matters, and removes the "forgot the worker" and "restarted only one" mistakes that cost the most time here.
