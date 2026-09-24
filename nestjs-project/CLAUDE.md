# CLAUDE.md

## Environment Startup Verification

**Default behavior:** starting the environment means starting **only infrastructure services** (database, mail, etc.) — **never** start the NestJS application server unless the user explicitly asks to run/serve the project (e.g., "rode o projeto", "suba o servidor", "run the app").

After starting infrastructure, always confirm the containers are up before proceeding:

```bash
docker compose ps   # all services must show status "running"
```

Then verify each infrastructure service is actually ready to accept connections — not just running:

- **PostgreSQL:** `docker compose exec db pg_isready -U streamtube` — expect `accepting connections`

Only start the NestJS dev server (`npm run start:dev`) when the user **explicitly** asks to run the application — never as part of "start the environment".

## Development Environment

This project runs inside Docker. Always use the container for development:

```bash
# Start containers
docker compose up -d

# Install dependencies (first time only)
docker compose exec nestjs-api npm install

# Run the dev server (watch mode)
docker compose exec nestjs-api npm run start:dev
```

Services:
- `nestjs-api` — NestJS API, port `3000`
- `db` — PostgreSQL 17, port `5432`, database `streamtube`, user/password `streamtube`
- `mailpit` — SMTP test server, port `1025` (SMTP), web UI on `8025`
- `minio` — S3-compatible object storage (video files + thumbnails, `upload-processing/TD-01`), S3 API on port `9000`, console on `9001`, healthcheck `mc ready local`
- `redis` — Background job queue backend for BullMQ (`upload-processing/TD-03`), no host port exposed (internal Compose network only), healthcheck `redis-cli ping`
- `worker` — Standalone video processing worker (FFmpeg/FFprobe, `upload-processing/TD-03`/`TD-04`), no host port, healthcheck via `pgrep -f 'dist/worker/main.js'`, dedicated `worker-temp` named volume for per-job downloads (reserved capacity checked at startup — fails fast if `WORKER_CONCURRENCY × MAX_UPLOAD_BYTES + WORKER_TEMP_MARGIN_BYTES` exceeds free space)

All verification and teardown commands run on the **host machine**:

```bash
# Verify NestJS is running (expect 200 + "Hello World!")
curl http://localhost:3000

# Verify PostgreSQL is ready (runs inside the db container)
docker compose exec db pg_isready -U streamtube

# Verify MinIO is ready
docker compose exec minio mc ready local

# Verify Redis is ready (expect PONG)
docker compose exec redis redis-cli ping

# Check container logs
docker compose logs nestjs-api
docker compose logs db
docker compose logs worker

# Tear down the entire environment
docker compose down
```

## Commands

**Strict rule:** every `npm`, `npx`, `node`, `tsc`, and test command runs **inside the container**, never on the host. Running on the host causes env-var divergence (`DB_HOST` resolves to `localhost` instead of the Compose service), uses a different Node version, and produces results that do not reflect what runs in CI/prod.

### Container-only commands (always prefix with `docker compose exec nestjs-api`)

```bash
npm run start:dev                        # Dev server with hot-reload
npm run build                            # Compile to dist/
npm run start:prod                       # Run compiled build

npm test                                 # Unit tests
npm run test:watch                       # Unit tests in watch mode
npm run test:cov                         # Coverage report
npm run test:e2e                         # End-to-end tests (always with --runInBand)

npx tsc --noEmit                         # Type-check (required before declaring a task done)
npm run lint                             # ESLint with auto-fix
npm run format                           # Prettier formatting
```

### Host-only commands (Docker / connectivity probes)

```bash
docker compose ps
docker compose logs nestjs-api
docker compose exec db pg_isready -U streamtube
curl http://localhost:3000
```

### Test execution

Integration and e2e suites share a single test database. They **must** be run with `--runInBand`:

```bash
docker compose exec nestjs-api npm test -- --runInBand
docker compose exec nestjs-api npm run test:e2e   # already configured
docker compose exec worker npm run test:worker    # FFmpeg-dependent worker integration suites — see "Worker" below
```

Parallel execution causes FK violations, deadlocks, and cross-suite contamination because suites truncate or seed shared tables concurrently.

`npm test` and `npm run test:integration` run in the `nestjs-api` container and deliberately exclude the four FFmpeg-dependent `src/worker/*.integration-spec.ts` suites (`testPathIgnorePatterns` in `package.json`'s jest config) — `nestjs-api` has no FFmpeg binaries. `npm run test:worker` is their dedicated official command, with its own `test/jest-worker.json` config, and must run inside the `worker` container. All three commands must exit 0 independently; none of them alone constitutes "the full suite passed."

During active development, run only the tests related to the file being changed (`npm test -- path/to/file.spec.ts`). Before declaring a task done, run the full suite — see the global `CLAUDE.md` → "Definition of Done (Technical)".

## Videos

The `videos` module (`src/videos/`) owns the `Video` entity and its delivery endpoints; upload ingestion lives in `src/upload/` (tus mount), and asynchronous processing lives in `src/worker/` (see below) — three modules cooperating over one entity, not one monolithic "video" module.

**Lifecycle** (`processingStatus` on `Video`, orthogonal to `publicationStatus`): `UPLOADING` → `PROCESSING` → `READY` or `FAILED`. Set by, respectively: `Video` creation (`upload-processing/TD-06`/`TD-11`), the worker's `VideoProcessingProcessor.process()` on job pickup, the same method on successful completion, and `persistTerminalFailure` (the single writer of `FAILED` — invoked by both the live `@OnWorkerEvent('failed')` handler and the reconciliation sweep, never two independent writers).

**Delivery endpoints** (`src/videos/videos.controller.ts`, both `@Public()` — anonymous viewing is allowed per the project's auth model):
- `GET /videos/:id/stream` — `302` redirect to a short-lived presigned GET URL against the internal storage endpoint, letting the client issue real HTTP range requests (`206 Partial Content`) directly against MinIO/S3, without proxying bytes through the API.
- `GET /videos/:id/download` — same redirect mechanism, for a full-file download.
- Both throw `VideoNotFoundException` (404-mapped) if the id doesn't correlate to a `Video`, or `VideoNotReadyException` (409-mapped) if `processingStatus !== READY` — a video only becomes fetchable once the worker has finished processing it.

**Upload → processing → delivery, end to end:** a client creates a tus upload (`POST /videos/upload`) which creates the `Video` draft (`UPLOADING`) with `sourceStorageKey` literally equal to `Video.id` (per `upload-processing/TD-08`/`TD-11`); the client then `PATCH`es the file directly to `@tus/s3-store`, which streams it straight to MinIO/S3 without ever buffering the full body in the API process — verified empirically with a real ~8.9GB file (204 on completion, API memory stayed flat throughout the transfer). On `onUploadFinish`, `uploadCompletedAt` is written durably, then the `video.processing` job is enqueued; the worker downloads the object to a per-job temp dir, validates the format via FFprobe, extracts metadata (duration/dimensions/codecs/bitrate) and a thumbnail via FFmpeg, uploads the thumbnail, and writes `READY` with all fields populated.

## Worker (Video Processing)

The `worker` service is a **standalone** NestJS application context (`NestFactory.createApplicationContext`, own `WorkerModule` — not `AppModule`), consuming the `video-processing` BullMQ queue. It runs `node dist/worker/main.js` as its container's PID 1 — a long-running process that does **not** hot-reload.

**Any change under `src/worker/**` (or anything it depends on) requires an explicit rebuild + restart before it takes effect:**

```bash
docker compose exec nestjs-api npm run build   # compiles both dist/main.js and dist/worker/main.js
docker compose restart worker
docker compose ps worker                       # wait for "healthy" before running worker tests
```

Skipping this step leaves the container running stale code — worker integration tests would then silently exercise old logic instead of the change just made, since the container's own worker process competes for jobs on the same real Redis queue as any test-instantiated worker.

**FFmpeg/FFprobe** are vendored (static binaries, `upload-processing/TD-04`) only in the `worker` image, at `FFMPEG_PATH`/`FFPROBE_PATH` (default `/usr/local/bin/ffmpeg` / `/usr/local/bin/ffprobe`) — not present in `nestjs-api`. The four `src/worker/*.integration-spec.ts` suites that spawn a real FFmpeg/FFprobe process or exercise the real `video-processing` queue end-to-end (`worker-shutdown`, `video-processing`, `reconciliation-sweep`, `ffmpeg-smoke`) are excluded from the official `npm test` / `npm run test:integration` commands (via `testPathIgnorePatterns`) precisely because those run in the `nestjs-api` container, which has no FFmpeg. They have their own official command, run inside the `worker` container instead:

```bash
docker compose exec worker npm run test:worker
```

**Resumable upload (tus)** is mounted on the `nestjs-api` service at `/videos/upload` (`upload-processing/TD-05`/`TD-11`), handling `POST`/`PATCH`/`HEAD`/`DELETE` against `/videos/upload` and `/videos/upload/{id}` — `{id}` is the same UUID used as `Video.id` and the object's S3 key. It runs outside Nest's own guard pipeline (mounted as a plain sub-app via `@tus/server`), so authentication/ownership is enforced by the `onIncomingRequest` hook, not a Nest guard.

## Long-running Processes

Commands that never exit (dev server, watch modes) must be run in background in the Bash tool — otherwise the agent blocks indefinitely waiting for the process to return.

This applies to: `start:dev`, `start:prod`, `test:watch`, and any other persistent process.

## Test Type Selection

Choose the suffix by what the test really does, not by where the code under test lives. The suffix is a contract that drives Jest config (`testRegex`, parallelism), CI steps, and reader expectations.

| Suffix                  | Purpose                                                              | DB / external I/O | Location                     |
|-------------------------|----------------------------------------------------------------------|-------------------|------------------------------|
| `*.spec.ts`             | **Unit** — pure logic, all collaborators mocked                      | Forbidden         | Next to the source file      |
| `*.integration-spec.ts` | **Integration** — exercises real DB, real repositories, real modules | Required          | Next to the source file      |
| `*.e2e-spec.ts`         | **End-to-end** — full HTTP cycle via `supertest`                     | Required          | `nestjs-project/test/`       |

A test that constructs a `TypeOrmModule.forRoot`, opens a connection, or hits the `db` service **must** be `*.integration-spec.ts`, never `*.spec.ts`. A test that boots the full Nest application and makes HTTP calls **must** be `*.e2e-spec.ts`.

Conventions for **how to write** each kind of test (mocking patterns, AAA structure, override strategies for global guards, etc.) live in `.claude/rules/nestjs-testing.md` and load when you edit a test file.

## Jest Configuration

These settings are required in `package.json` (jest config) and `test/jest-e2e.json` for the project's tests to work correctly:

- `setupFiles: ["dotenv/config"]` — without this, `.env` is not loaded inside the Jest process. `DB_HOST`, `JWT_SECRET`, etc. fall back to undefined or to the host's `localhost`, breaking container-to-container DNS.
- `testRegex: '.*\\.(spec|integration-spec)\\.ts$'` — covers both unit (`*.spec.ts`) and integration (`*.integration-spec.ts`) suffixes.

Do not add new test-file suffixes; if a new test type is needed, update the regex deliberately.

## Environment Variables

All variables are validated at startup via Joi (`src/config/env.validation.ts`); `.env.example` is kept in sync and is the reference for every default value.

- **Object storage (MinIO — `upload-processing/TD-01`/`TD-02`):** `STORAGE_ENDPOINT` (internal Compose URL, e.g. `http://minio:9000`), `STORAGE_PUBLIC_ENDPOINT` (browser-reachable URL used for signed URLs), `STORAGE_REGION`, `STORAGE_BUCKET`, `STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY`, `STORAGE_PRESIGNED_URL_TTL_SECONDS`.
- **Background job queue (Redis/BullMQ — `upload-processing/TD-03`):** `REDIS_HOST`, `REDIS_PORT`.
- **Upload limits (`upload-processing/TD-05`):** `MAX_UPLOAD_BYTES` — hard ceiling for a single upload, also used to size the worker's reserved temp-disk capacity.
- **Worker (`upload-processing/TD-03`/`TD-04`/`TD-07`/`TD-11`):**
  - `WORKER_CONCURRENCY` — jobs processed in parallel per worker instance.
  - `WORKER_TEMP_MARGIN_BYTES` — safety margin added on top of `WORKER_CONCURRENCY × MAX_UPLOAD_BYTES` for the startup capacity check.
  - `WORKER_ORPHAN_SWEEP_THRESHOLD_MS` — age after which a leftover job temp directory (crashed/killed worker) is removed at startup.
  - `WORKER_RECONCILIATION_INTERVAL_MS` — how often the reconciliation sweep re-runs (stuck-upload recovery + lost-FAILED repair).
  - `WORKER_RECONCILIATION_GRACE_PERIOD_MS` — how long an `UPLOADING` video with no `uploadCompletedAt` must be untouched before the sweep probes storage directly for it.
  - `FFMPEG_PATH` / `FFPROBE_PATH` — vendored binary paths inside the `worker` image only.

## Environment File Conventions

`.env` is parsed by both Docker Compose and `dotenv` — values containing shell-special characters (`<`, `>`, `|`, `&`, spaces) **must be quoted** or rewritten:

```dotenv
# Wrong — the unquoted angle brackets are shell redirection syntax and break parsing
MAIL_FROM=StreamTube <noreply@streamtube.local>

# Right — quote the value
MAIL_FROM="StreamTube <noreply@streamtube.local>"
```

Whenever possible, prefer storing only the bare address in `.env` and composing display names in code (e.g., in `mail.config.ts`) so the file stays shell-safe.

## Build Assets

`tsc` (and therefore `nest build`) only emits compiled `.ts` files to `dist/`. Any non-TypeScript runtime asset — Handlebars templates (`.hbs`), JSON fixtures, static config files, etc. — must be declared in `nest-cli.json` under `compilerOptions.assets` (with `watchAssets: true` for dev). Without that, the file exists in `src/` but is missing in `dist/` and runtime fails only after build.

## Architecture

NestJS with standard module structure. Source lives in `src/`, compiled output in `dist/`.

- Each domain feature gets its own module (e.g., `UsersModule`, `VideosModule`) registered in `AppModule`
- Controllers handle HTTP routing; Services hold business logic; both are scoped to their module

## Code Conventions

- **TypeScript:** `nodenext` module resolution, `ES2023` target, `strictNullChecks` on, `noImplicitAny` off
- **Decorators:** `emitDecoratorMetadata` + `experimentalDecorators` enabled — required for NestJS DI
- **Prettier:** single quotes, trailing commas everywhere
- **ESLint:** `no-explicit-any` allowed; `no-floating-promises` and `no-unsafe-argument` are warnings

## REST Conventions

This is a RESTful API. All endpoints must follow standard REST conventions — correct HTTP methods, proper status codes, plural resource nouns, and consistent URL structure. Details are enforced via rules on controller files.
