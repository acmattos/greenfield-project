---
kind: phase
name: phase-03-upload-processing
sources_mtime:
  docs/project-plan.md: "2026-09-21T22:06:36-03:00"
  docs/decisions/technical-decisions-upload-processing.md: "2026-09-22T16:03:07-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-09-15T18:40:16-03:00"
  docs/phases/phase-01-configuracao-base/context.md: "2026-09-15T18:40:16-03:00"
  docs/phases/phase-02-auth/context.md: "2026-09-15T18:40:16-03:00"
  docs/phases/phase-02-auth-frontend/context.md: "2026-09-15T18:40:16-03:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-09-15T18:40:15-03:00"
---

# phase-03-upload-processing — Context

## Scope

**Phase name:** Upload e Processamento de Vídeos

**Capabilities** (literal, `docs/project-plan.md`):

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** _Not specified._

**Deliverables:** Upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:**

- `nestjs-project` — backend subproject covered by every decision in this phase's decisions doc: object storage integration, video delivery signing, background job queue + worker process, FFmpeg metadata/thumbnail extraction, large-file upload endpoint, tus termination semantics.

**Deferred subprojects:**

- `next-frontend` — no open decision for Phase 03; every capability bullet is backend-facing (no bullet names a screen or UI surface). An upload UI is anticipated but no Figma design exists yet — it will be researched as its own frontend slice once that design lands, mirroring `phase-02-auth` → `phase-02-auth-frontend` _(per `upload-processing` decisions doc's own "Subprojects in scope" note)_.

**Sequencing notes:** Depende de: Fase 01, Fase 02.

**Neighbors (for boundary detection only):**

- **Phase 02:** Fluxo completo de criação de conta, confirmação por e-mail, login, logout e recuperação de senha.
- **Phase 04:** Edição das informações do vídeo, fluxo de rascunho e publicação, painel de administração do canal e página pública.

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| upload-processing/TD-01 | phase | Backend | Object Storage Backend | decided | A | @aws-sdk/client-s3 |
| upload-processing/TD-02 | phase | Backend | Video Delivery — Signed URL Strategy | decided | A | @aws-sdk/s3-request-presigner |
| upload-processing/TD-03 | phase | Backend | Background Job Queue & Worker Process Model | decided | A | @nestjs/bullmq, bullmq, ioredis |
| upload-processing/TD-04 | phase | Backend | Video Processing & Thumbnail Extraction Toolchain | decided | C | — |
| upload-processing/TD-05 | phase | Backend | Large File Upload Ingestion Strategy | decided | A | @tus/server, @tus/s3-store |
| upload-processing/TD-06 | phase | Backend | Video Lifecycle / State Model | decided | B | — |
| upload-processing/TD-07 | phase | Backend | Worker Temporary Storage Strategy | decided | A | — |
| upload-processing/TD-08 | phase | Backend | Unique Video Identifier / URL Strategy | decided | A | — |
| upload-processing/TD-09 | phase | Backend | Accepted Video Format / Container / Codec Validation | decided | A | — |
| upload-processing/TD-10 | phase | Backend | Job Failure Classification, Final-FAILED Transition, and Worker Idempotency | decided | A | — |
| upload-processing/TD-11 | phase | Backend | tus Upload Correlation with Video Entity, and Enqueue-Failure Recovery | decided | A | — |
| upload-processing/TD-12 | phase | Backend | Video Metadata Persistence Schema | decided | A | — |
| upload-processing/TD-13 | phase | Backend | tus Termination (DELETE) Semantics | decided | A | — |

_Source files:_

- upload-processing — `docs/decisions/technical-decisions-upload-processing.md` (scope_type: phase, related_phases: [3])

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|-----------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | upload-processing/TD-01 |
| Serviço de processamento em segundo plano (filas) | upload-processing/TD-03 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | upload-processing/TD-05, upload-processing/TD-07, upload-processing/TD-09, upload-processing/TD-13 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | upload-processing/TD-06, upload-processing/TD-11, upload-processing/TD-13 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | upload-processing/TD-04, upload-processing/TD-06, upload-processing/TD-07, upload-processing/TD-09, upload-processing/TD-10, upload-processing/TD-11, upload-processing/TD-12 |
| Geração automática de thumbnail a partir de um frame do vídeo | upload-processing/TD-04, upload-processing/TD-10 |
| URL única por vídeo, sem conflito com outros vídeos | upload-processing/TD-08 |
| Reprodução via streaming (sem necessidade de download completo) | upload-processing/TD-02, upload-processing/TD-09 |
| Download do vídeo pelo usuário | upload-processing/TD-02 |

## Decisions Detail

### upload-processing/TD-01

**Recommendation:** The direct implementation of the deliverable's own S3-compatible, local/Docker requirement, satisfying the C4 diagram's storage container framing and its direct `Frontend → storage` streaming relationship (via presigned URLs, TD-02) without adding cloud dependencies to local development, using the standard `@aws-sdk/client-s3` client (confirmed against `nestjs-project`'s installed stack: NestJS 11, Node 25.6.0-slim, Express) against MinIO's S3-compatible API. Options B and C are retained below purely as the trade-off record for why a managed or filesystem-based alternative was not chosen, not as open contenders.
**Libraries:** @aws-sdk/client-s3

**Revisions:**
- 2026-09-22 — Added explicit requirement: the target bucket must exist before the API or worker can read/write any object, and its creation must be idempotent. Rationale: never stated *who* ensures the bucket exists; left for `/plan-build` to derive a concrete SI/AC.
- 2026-09-22 — Formalized `**Libraries:**` field.

### upload-processing/TD-02

**Recommendation:** The only option compatible with the already-documented architecture (client reads bytes directly from storage) while keeping temporary, revocable access control on objects that are not meant to be permanently public, at negligible extra cost. `Range` support comes for free from the object store itself once the client holds a presigned URL — no separate streaming decision needed.
**Libraries:** @aws-sdk/s3-request-presigner

**Revisions:**
- 2026-09-22 — Added explicit requirement: `Range`/`206` support against a presigned URL must be proven by a real integration test, not merely asserted architecturally.
- 2026-09-22 — Formalized `**Libraries:**` field.

### upload-processing/TD-03

**Recommendation:** Best fit for the actual shape of the problem (one producer, one consumer, job-shaped work needing retries/progress/concurrency), with first-class, currently-maintained NestJS support (`@nestjs/bullmq`) and the lightest operational footprint of the two queue-shaped options. The worker runs as a NestJS standalone application in its own Compose service/entrypoint inside `nestjs-project/`, isolating FFmpeg-heavy work from the HTTP server's process without a second codebase. Redis connections used by BullMQ must set `maxRetriesPerRequest: null` (confirmed via `ioredis` docs — BullMQ's blocking queue commands cannot tolerate the client's default retry-then-flush behavior).
**Libraries:** @nestjs/bullmq, bullmq, ioredis

**Revisions:**
- 2026-09-22 — Formalized `**Libraries:**` field.

### upload-processing/TD-04

**Recommendation:** Keeps the FFmpeg/FFprobe binary supply chain independent of both the npm registry and any wrapper package's release cadence, matching the same reproducibility bar the project already applies to its own dependencies via the lockfile. Provisioned in the **worker image only** — the API image has no processing responsibility (it only enqueues jobs and issues presigned URLs, TD-02) and must not carry the FFmpeg binaries unless a concrete API-side need emerges later. `fluent-ffmpeg` stays excluded under every option.
**Libraries:** —

### upload-processing/TD-05

**Recommendation:** The only option satisfying both explicit "Pontos de Atenção" NFRs without custom-built resume logic, whose lifecycle hooks map directly onto this phase's draft-pre-registration and processing-trigger capabilities, while preserving the documented API-mediated upload path. Note: `@tus/server` defaults to an in-memory `MemoryLocker`, safe only while the API runs as a single instance — acceptable for this phase since horizontal scaling of the API is not required here; a `RedisLocker` is the documented upgrade path if that changes later (Redis is already provisioned for TD-03).
**Libraries:** @tus/server, @tus/s3-store

**Revisions:**
- 2026-09-22 — Added explicit requirement: real, interrupted-then-resumed upload behavior must be proven by a real integration test, not merely asserted architecturally.
- 2026-09-22 — Formalized `**Libraries:**` field.

### upload-processing/TD-06

**Recommendation:** Cleanly separates the two independently-varying concerns without the schema/query overhead of a separate table, and is a natural stepping stone to a separate-entity model later if per-attempt processing history becomes a real requirement.
**Libraries:** —

### upload-processing/TD-07

**Recommendation:** Full download to a per-job temp directory, explicitly including two guard-rail practices — a `Content-Length` pre-flight check against known-free space before starting a download, and a startup orphan-sweep for crash safety. Lowest-complexity option that still turns disk exhaustion into a handled, observable failure rather than an incident. Worker `concurrency` should default to **1**, configurable via env var.
**Libraries:** —

### upload-processing/TD-08

**Recommendation:** Reuses the exact convention already established for every other entity in the project, needs no new dependency or secondary uniqueness mechanism, and satisfies "sem conflito com outros vídeos" by construction via the database's own primary-key constraint.
**Libraries:** —

### upload-processing/TD-09

**Recommendation:** The only option whose accepted set is validated, not merely inferred, against actual native browser playback support, which matters specifically because this phase has no transcoding step to correct a format that FFprobe can parse but a browser cannot play. Re-opening to a broader allowlist is a natural, low-cost follow-up once a transcoding phase normalizes everything to one deliverable format regardless of what was uploaded.
**Libraries:** —

### upload-processing/TD-10

**Recommendation:** Every primitive it needs (`UnrecoverableError`, `@OnWorkerEvent('failed')`, deterministic object keys) is already confirmed current BullMQ/`@nestjs/bullmq` API or an already-decided pattern from TD-01/TD-07/TD-08; it adds zero new schema or dependency, and it is the only option that avoids both the state-flicker risk of writing `FAILED` unconditionally and the reimplementation cost of a custom retry/idempotency layer.
**Libraries:** —

**Revisions:**
- 2026-09-22 — Clarified the "single writer" guarantee: `@OnWorkerEvent('failed')` remains the only normal-path writer of `processingStatus = FAILED`; a reconciliation mechanism may separately repair a terminally-confirmed divergence (a `Video` stuck at `PROCESSING` whose correlated BullMQ job has already reached Redis-confirmed `'failed'` state), invoking the same write function from two triggers — never two independently-decided writers.
- 2026-09-22 — Extended the duplicate-run safe no-op (previously defined only for `READY`) to also cover an already-`FAILED` video: `FAILED` is absolute-terminal within this phase, no reprocessing exists or is implied.

### upload-processing/TD-11

**Recommendation:** The bare-UUID `namingFunction` avoids the `generateUrl`/`getFileIdFromRequest` override complexity a slash-containing id would require, while still keeping one identifier flowing through tus, S3, and the DB. The durable `uploadCompletedAt` + reconciliation-sweep mechanism gives enqueue-failure recovery a real server-side guarantee instead of relying on tus-client retry behavior alone. `onIncomingRequest` closes the previously-unaddressed gap where only upload creation was authenticated, leaving PATCH/HEAD against an in-progress upload unprotected. The deterministic `jobId` shared by both producers reuses BullMQ's own native job-uniqueness guarantee to prevent duplicate concurrent jobs.
**Libraries:** —

**Revisions:**
- 2026-09-22 — Added a second, storage-anchored recovery branch to the reconciliation mechanism for when the *first* `uploadCompletedAt` write itself fails: for `Video` rows `UPLOADING` with `uploadCompletedAt IS NULL` beyond a grace period, a `HeadObjectCommand` against the deterministic key proves durable completion independently of tus/S3Store's own bookkeeping and of the client — on success, the sweep retroactively writes `uploadCompletedAt` and proceeds through the same enqueue path.

### upload-processing/TD-12

**Recommendation:** Reuses the already-decided, already-parsed FFprobe call with zero new tooling, and the specific field set (`width`, `height`, `videoCodec`, `audioCodec`, `bitRate`) is both minimal and concretely useful to this project's own stated near-term direction.
**Libraries:** —

### upload-processing/TD-13

**Recommendation:** `@tus/s3-store`'s confirmed `remove(id)` implementation and the confirmed `POST_TERMINATE` event mean full termination support costs one event-listener registration and one `DELETE`, not new infrastructure; `disableTerminationForFinishedUploads` draws exactly the scope line this deliverable needs (in-progress uploads only, never touching a video that has entered or completed processing) without inventing a new enum value or custom check.
**Libraries:** —

## Inherited Decisions Detail

### phase-01-configuracao-base/TD-01

**Recommendation:** Official, core-team-maintained, guaranteed NestJS 11 compatibility. The `registerAs()` factory pattern solves the TypeORM CLI sharing problem: the factory function can be imported as a plain function by `data-source.ts` while also serving as a DI injection token inside NestJS.
**Libraries:** @nestjs/config@^4.x

### phase-01-configuracao-base/TD-02

**Recommendation:** First-class integration with `@nestjs/config` via `validationSchema`, requiring zero custom wiring. Handles string-to-number coercion natively.
**Libraries:** joi@^17.x

### phase-01-configuracao-base/TD-03

**Recommendation:** The project roadmap explicitly calls for auth, email, and storage in upcoming phases. Namespaced configs provide clear file boundaries per domain, typed injection via `ConfigType<typeof databaseConfig>`, and natural scalability.
**Libraries:** —

### phase-01-configuracao-base/TD-04

**Recommendation:** Natural outcome of choosing `@nestjs/config` with `registerAs`. The factory is already callable by design.
**Libraries:** dotenv (transitive via @nestjs/config)

### phase-02-auth/TD-01

**Recommendation:** For a greenfield project in 2026, Argon2id is the OWASP-recommended choice. The native build dependency is a one-time Docker setup cost.
**Libraries:** argon2@^0.41.x

### phase-02-auth/TD-02

**Recommendation:** The project plan includes only email/password auth for now, but the plugin architecture costs little and future phases may add social login.
**Note:** Decision deliberately diverged — custom guards were preferred over `@nestjs/passport`.
**Libraries:** @nestjs/jwt@^11.0.0

### phase-02-auth/TD-03

**Recommendation:** Refresh Token Rotation provides the strongest security model with automatic theft detection.
**Libraries:** —

### phase-02-auth/TD-04

**Recommendation:** Random Opaque Tokens in DB — revocability is important; the tokens table can also serve future needs.
**Libraries:** —

### phase-02-auth/TD-05

**Recommendation:** Best NestJS integration with minimal boilerplate. Supports SMTP, works with Mailpit for local development.
**Libraries:** @nestjs-modules/mailer@^2.x, handlebars@^4.x

### phase-02-auth/TD-06

**Recommendation:** class-validator is the documented NestJS approach, and the project already uses decorators extensively.
**Libraries:** class-validator@^0.14.x, class-transformer@^0.5.x

### phase-02-auth/TD-07

**Recommendation:** Provides machine-readable error codes without RFC 9457's overhead. `{ statusCode, error, message }` format with domain codes.
**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** Native NestJS integration is decisive: the guard system allows scoping rate limiting to `AuthModule` only.
**Libraries:** @nestjs/throttler@^6.x

### phase-02-auth/TD-09

**Recommendation:** Since DB lookup is mandatory (TD-03), JWT signature adds no security value.
**Note:** Decision deliberately diverged — JWT was kept to reuse the access-token signing/verification infrastructure.
**Libraries:** @nestjs/jwt@^11.0.0

### phase-02-auth/TD-10

**Recommendation:** A strict `[a-z0-9_]` allowlist is the simplest and most portable choice for channel handles.
**Libraries:** —

### phase-02-auth-frontend/TD-01

**Recommendation:** The strict-BFF model already nominates the Route Handler as the only NestJS caller; cookie-based sessions are the natural match.
**Libraries:** —

### phase-02-auth-frontend/TD-02

**Recommendation:** Defense in depth on the cookie content — `httpOnly` blocks JS, encryption blocks accidental inspection.
**Libraries:** iron-session

### phase-02-auth-frontend/TD-03

**Recommendation:** The single-flight detail is non-trivial and goes in the helper from day one.
**Libraries:** —

### phase-02-auth-frontend/TD-04

**Recommendation:** Decoupled from the mutation-transport decision; aligned with shadcn's canonical form primitive.
**Libraries:** react-hook-form, @hookform/resolvers

### phase-02-auth-frontend/TD-05

**Recommendation:** Strict-BFF alignment keeps every mutation visible under `app/api/**`.
**Libraries:** —

### phase-02-auth-frontend/TD-06

**Recommendation:** No first-render flicker, no round-trip — the session is delivered in the same response as the page HTML.
**Libraries:** —

### phase-02-auth-frontend/TD-07

**Recommendation:** First-paint-correct — the user sees the right outcome on the first paint, no skeleton, no flicker.
**Libraries:** —

### openapi-docs-nestjs/TD-01

**Recommendation:** É a única opção que preserva as decisões anteriores (`class-validator` em phase-02-auth/TD-06) sem re-platform; o CLI plugin com `classValidatorShim: true` aproveita os decoradores `class-validator` existentes para inferir schemas, mantendo o boilerplate baixo.
**Libraries:** @nestjs/swagger

**Revisions:**
- 2026-05-12 — Esclarece que o CLI plugin cobre apenas inferência de schemas de DTOs; documentação de operações, respostas tipadas e contratos de erro exigem decoradores explícitos.

### openapi-docs-nestjs/TD-02

**Recommendation:** O custo marginal sobre runtime-only é apenas um npm script (~15 linhas) e o benefício é uma fundação correta para futura integração FE (codegen offline) sem perder a UI interativa que dev/QA usam.
**Libraries:** —

### openapi-docs-nestjs/TD-03

**Recommendation:** Alinha com a postura defensiva já estabelecida em phase 02 e não compromete consumidores legítimos.
**Libraries:** —

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 01)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema, validationOptions: { allowUnknown: true, abortEarly: false } })`. _(from phase 01)_
- Config is injected into modules via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`; the same factory is importable as a plain function for non-DI contexts (e.g., TypeORM CLI). _(from phase 01)_
- `data-source.ts` loads `.env` via `import 'dotenv/config'` at the top, then imports `databaseConfig` and calls it as a plain function. _(from phase 01)_
- Database connection parameters (host, port, etc.) are sourced from a single `databaseConfig` factory — never duplicated between `AppModule` and `data-source.ts`. _(from phase 01)_
- `TypeOrmModule.forRootAsync` is used (not `forRoot`), with `imports: [ConfigModule]`, `inject: [databaseConfig.KEY]`, `useFactory` returning options including `autoLoadEntities: true`, `synchronize: false`. _(from phase 01)_

## Inherited Deferred Capabilities

| Capability | Status | Origin phase | Rationale |
|-----------|--------|--------------|-----------|
| Telas de frontend | deferred | phase-01-configuracao-base | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| Telas de cadastro, login, confirmação de conta e recuperação de senha | deferred | phase-02-auth | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| Confirmação de conta via e-mail com link de ativação | deferred | phase-02-auth-frontend | deferred_to_next_phase — UI landing screen de-scoped 2026-05-14; FE confirmation flow (TD-07) picked up by a future phase. BE side unchanged in `phase-02-auth`. |
| Logout | deferred | phase-02-auth-frontend | deferred_to_next_phase — logout button lives inside authenticated chrome (typically Phase 04). Phase 02 still implements POST `/api/auth/logout`. |
| Recuperação de senha (destination screen / set-new-password) | deferred | phase-02-auth-frontend | deferred_to_next_phase — `/forgot-password` ships this phase sending the e-mail; the reset-password destination screen is absent from Figma. |
| Telas de cadastro, login, confirmação de conta e recuperação de senha | deferred | phase-02-auth-frontend | a tela de confirmação da conta não será implementada nesta fase corrente, será adiada. |

## Non-UI / Deferred Capabilities

_None._

## Testing Requirements

### nestjs-project

| Artifact type | Required layers |
|---|---|
| Entity (`*.entity.ts`) | Integration: constraints, defaults, `select: false` |
| Service with branching + DB | Unit: branch logic (mock repo) + Integration: DB contract |
| Service with DB only (no branching) | Integration: DB contract |
| Service with configured lib (JWT, cache, BullMQ) | Unit: real lib with test config |
| Service with side-effect dep (email, storage, queue) | Integration: real capture service (Mailpit) or local adapter |
| Module with configured imports | Unit: compilation test |
| Controller | E2E only — do NOT write unit tests |
| DTO | E2E: one validation wiring test per endpoint |
| Guard (delegates to service for business logic) | E2E + Unit if complex internal logic |
| Guard (simple, delegates to Passport) | E2E only |
| Strategy (Passport) | E2E via guard |
| Pipe (custom transformation/validation) | Unit |
| Interceptor (response transform, logging) | Unit and/or E2E |
| Exception Filter | Unit + E2E |
| Middleware | E2E |

### next-frontend (deferred)

_Deferred subproject — testing requirements will be defined when the testing-guide skill is created._
