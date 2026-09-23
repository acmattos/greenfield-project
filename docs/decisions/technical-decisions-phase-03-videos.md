---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-09-21
scope_description: "Backend foundation for video upload and processing: object storage, resumable large-file upload ingestion, background job queue + worker, FFmpeg-based metadata/thumbnail extraction, and signed-URL video delivery for streaming and download."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — the backend subproject covered by every decision in this document. Owns the object storage integration, video delivery signing, background job queue + worker process, FFmpeg metadata/thumbnail extraction, and the large-file upload endpoint.
- `next-frontend/` — no open decision in this document. Every capability bullet for Phase 03 in `docs/project-plan.md` is backend-facing (storage service, background queue, upload endpoint, processing, delivery) — no bullet names a screen or UI surface. An upload UI is anticipated but no Figma design exists yet for it; it will be researched as its own frontend slice once that design lands (mirroring `phase-02-auth` → `phase-02-auth-frontend`).

---

## TD-01: Object Storage Backend

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** Video files and generated thumbnails need a persistence layer distinct from PostgreSQL. The deliverable's own architecture already fixes the technology family: the C4 diagram (`docs/diagrams/software-arch.mermaid`) names this container `ContainerDb(storage, "Object Storage", "S3 or MinIO", ...)`, and the project's local/Docker convention (root `CLAUDE.md` § Docker Networking — every service reached by its Compose name, never `localhost`) already implies a self-hosted, S3-compatible service running as a Compose container for this environment. This is not an open field among unrelated storage technologies — it is a choice of *which* S3-compatible setup to run locally, with the managed-cloud and local-filesystem alternatives kept below only as the documented record of why they were not selected. This decision also constrains TD-02 (delivery/signing), TD-05 (upload ingestion), and TD-07 (worker source downloads) — all three read from or write to whatever this TD decides.

**Options:**

### Option A: MinIO (self-hosted, S3-compatible, via Docker Compose)
- Runs as a Compose service exposing an S3-compatible API (e.g. `minio:9000`), accessed via the standard `@aws-sdk/client-s3` client with a custom `endpoint` + `forcePathStyle: true`.
- **Pros:** No cloud account/credentials needed for local dev — mirrors the project's "everything runs in Docker" convention already established for `db` and `mailpit` (per root `CLAUDE.md` § Docker Networking). Uses the standard, actively-maintained `@aws-sdk/client-s3` client (v3, modular) against an S3-compatible API — no bespoke integration. Directly matches the C4 diagram's own "S3 or MinIO" framing.
- **Cons:** If MinIO is also used in production rather than only dev, it must be operated (backup, scaling, TLS) — a deployment-environment concern, not this phase's.

### Option B: AWS S3 (managed)
- Cloud-hosted object storage, `@aws-sdk/client-s3` with default AWS endpoint resolution.
- **Pros:** Zero storage-ops burden, virtually unlimited durability/scale.
- **Cons:** Requires AWS credentials in every developer's environment or a shared dev bucket — breaks the "no external dependencies for local dev" pattern set by Postgres/Mailpit. Real cost during development of a pre-revenue greenfield project.

### Option C: Local filesystem (Node `fs`, volume-mounted directory)
- Files written directly to a mounted volume, served via custom routes.
- **Pros:** Simplest possible setup — zero new service, zero new dependency.
- **Cons:** No native presigned-URL mechanism — the C4 diagram's `Rel(frontend, storage, "Streams", "HTTPS")` relationship (TD-02) would need a hand-built signing scheme or routing all playback through the API, contradicting the documented architecture. Nothing here validates the production storage integration (S3) — the whole layer needs rebuilding, not re-pointing, before shipping.

**Recommendation:** **Option A (MinIO)** — the direct implementation of the deliverable's own S3-compatible, local/Docker requirement, satisfying the C4 diagram's storage container framing and its direct `Frontend → storage` streaming relationship (via presigned URLs, TD-02) without adding cloud dependencies to local development, using the standard `@aws-sdk/client-s3` client (confirmed against `nestjs-project`'s installed stack: NestJS 11, Node 25.6.0-slim, Express) against MinIO's S3-compatible API. Options B and C are retained below purely as the trade-off record for why a managed or filesystem-based alternative was not chosen, not as open contenders.

**Decision:** A (MinIO / S3-compatible)
**Libraries:** @aws-sdk/client-s3

**Revisions:**
- 2026-09-22 — Added explicit requirement: the target bucket must exist before the API or worker can read/write any object, and its creation must be **idempotent** — safe to run on every environment bring-up, not only the first (`docker compose up` on a fresh volume must not fail with "bucket does not exist", and re-running it against an already-provisioned bucket must not error either). Rationale: this Recommendation decided the storage backend family (MinIO/S3-compatible) and its client config, but never stated *who* ensures the bucket exists — left unstated, this is exactly the kind of requirement `/plan-build` needs to see in context.md to derive a concrete SI/AC. This is deliberately **not** promoted to a new TD: the "who/where" (a Compose init step via the MinIO client CLI, e.g. `mc mb --ignore-existing`, vs. an `OnModuleInit` check-and-create in `StorageModule` via `HeadBucketCommand`/`CreateBucketCommand`) is an implementation choice with no strategic trade-off worth a TD — only the binding requirement (idempotent bucket bootstrap must exist) belongs here.

**Revisions:**
- 2026-09-22 — Formalized `**Libraries:**` field (library name was already cited in the Recommendation prose but never structured as its own field). Rationale: `Decision:` was filled directly by the user, bypassing `/plan-resolve`'s normal pending→decided flow that would have added this field automatically; retroactively formalizing it unlocks `/plan-resolve`'s library-cache carve-out.

---

## TD-02: Video Delivery — Signed URL Strategy

**Scope:** Backend

**Capability:** Transversal — covers: "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** The C4 diagram declares `Rel(frontend, storage, "Streams", "HTTPS")` — the frontend reads video bytes directly from storage, bypassing the API; bytes never pass through the API process for either streaming or download. The open question is not *whether* the frontend reads from storage directly, but *how it is authorized to*: objects in the storage backend do not need to be permanently public to satisfy this phase's own capabilities, and a mechanism that grants only temporary, per-request access control is preferable to one that grants none. Depends on TD-01.

**Options:**

### Option A: Presigned GET URLs (per-request, short expiry)
- On each watch/download request, the API mints a temporary signed URL (`@aws-sdk/s3-request-presigner`'s `getSignedUrl`, e.g. 1h expiry) to the video/thumbnail object; the frontend streams or downloads directly against that URL. Download reuses the same mechanism with `ResponseContentDisposition: 'attachment'` on the underlying `GetObjectCommand`.
- **Pros:** Matches the documented architecture exactly — bytes flow client → storage directly, never through the API. Objects are never permanently public; access is granted per request, for a short window, and expires on its own. One mechanism serves both streaming and download — `getSignedUrl(client, command, {expiresIn})` against a `GetObjectCommand`, with or without `ResponseContentDisposition` set, per the real `@aws-sdk/s3-request-presigner` API (confirmed via current docs). S3-compatible object stores (MinIO included) natively support HTTP `Range` requests on the resulting URL — no extra work needed for seek/scrub.
- **Cons:** Adds one lightweight signing round-trip before playback starts (no data transfer, negligible latency). Expiry must be tuned so long-buffering sessions aren't cut mid-stream.

### Option B: Public bucket / objects (no signing)
- Objects are world-readable at a stable URL.
- **Pros:** Simplest possible implementation — no signing code. Trivial CDN edge-caching later.
- **Cons:** Any object URL becomes permanently guessable/crawlable, with no revocation path once a URL leaks — no mechanism to ever stop granting access to an object once its URL is known.

### Option C: API-proxied streaming (NestJS reads from storage, forwards bytes with HTTP Range support)
- The API becomes the read path for every video byte, implementing `Range` handling itself.
- **Pros:** Centralizes access control in one place.
- **Cons:** Deviates from the documented C4 relationship (`frontend --Streams--> storage`), reintroducing the API as a bandwidth bottleneck for exactly the large-file case this phase exists to avoid.

**Recommendation:** **Option A (Presigned URLs)** — the only option compatible with the already-documented architecture (client reads bytes directly from storage) while keeping temporary, revocable access control on objects that are not meant to be permanently public, at negligible extra cost. `Range` support comes for free from the object store itself once the client holds a presigned URL — no separate streaming decision needed.

**Decision:** A (Presigned GET URLs, short-lived)
**Libraries:** @aws-sdk/s3-request-presigner

**Revisions:**
- 2026-09-22 — Added explicit requirement: `Range`/`206 Partial Content` support against a presigned URL is asserted by this Recommendation ("comes for free from the object store itself") but has never been **proven** — it must be verified by a real integration test that issues an HTTP `Range` request against a real presigned URL (real MinIO, not a mock) and asserts a real `206` response with a correct `Content-Range` header. Rationale: "Reprodução via streaming (sem necessidade de download completo)" is an explicit acceptance criterion for this deliverable — an architectural claim that Range support is "free" is not the same as a passing test proving it, and no current SI's Tests table exercises this behavior (the existing `VideoDeliveryService` test only asserts the presigned URL's *shape*, not what the object store does when that URL receives a ranged request). This is a testing/acceptance requirement to carry into `/plan-build`'s Tests table for the relevant SI — not a new strategic decision (the mechanism, presigned URLs, is already decided above).

**Revisions:**
- 2026-09-22 — Formalized `**Libraries:**` field (library name was already cited in the Recommendation prose but never structured as its own field). Rationale: `Decision:` was filled directly by the user, bypassing `/plan-resolve`'s normal pending→decided flow that would have added this field automatically; retroactively formalizing it unlocks `/plan-resolve`'s library-cache carve-out.

---

## TD-03: Background Job Queue & Worker Process Model

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** Video metadata extraction and thumbnail generation are CPU-bound and must not block the API. The C4 diagram models this as two containers — `ContainerQueue(queue, "Message Queue", "TBD", ...)` and a separate `Container(worker, "Video Worker", "FFmpeg", ...)` — explicitly leaving the queue technology open ("TBD"). This is the one genuinely open stack decision of the phase. Also covers how the worker process is realized in the current single-project (`nestjs-project/`) monorepo, which has no existing multi-app split.

**Options:**

### Option A: BullMQ (Redis) via `@nestjs/bullmq`
- The API enqueues a job when an upload finishes (TD-05); a NestJS **standalone application** (`NestFactory.createApplicationContext()`, no HTTP listener) hosts a `@Processor`/`WorkerHost` class (confirmed current API: `@Processor('queueName') class X extends WorkerHost { async process(job: Job) {...} }`, registered via `BullModule.registerQueue({name, connection})`) and runs as its own entrypoint + Compose service — sharing entities/config with the API without a second `package.json`.
- **Pros:** First-class, actively-maintained NestJS integration (`@Processor`, `@OnWorkerEvent`, built-in retries/backoff/concurrency — confirmed via current BullMQ docs, e.g. `attempts` + `backoff: {type: 'exponential', delay}`). Matches the C4 diagram's dedicated Message Queue container. Redis is a lightweight Compose addition. Mature ecosystem.
- **Cons:** New infra dependency (Redis) unused by anything else in the project yet. In-memory queue state isn't the source of truth — the DB-persisted `Video` status remains authoritative, adding minor reconciliation complexity. A separate worker entrypoint duplicates a slice of app bootstrap.

### Option B: pg-boss (PostgreSQL-backed)
- Jobs are rows in Postgres, claimed via `SELECT ... FOR UPDATE SKIP LOCKED`. The worker is a plain Node process calling `boss.work('video-processing', handler)`, deployable the same standalone-entrypoint way as Option A.
- **Pros:** Zero new infrastructure — reuses the already-healthchecked `db` service. Job creation can share the same DB transaction that writes the draft `Video` row.
- **Cons:** Blurs the C4 diagram's distinct "Message Queue" container into the "Database" container. Lower throughput/feature ceiling than BullMQ (no built-in rate limiting or job flows) — a real constraint if processing later grows into a multi-step pipeline (transcode → thumbnail → captions).

### Option C: RabbitMQ via `@nestjs/microservices`
- The API becomes a `ClientProxy` publishing to an exchange; the worker is a full NestJS microservice consuming from a queue.
- **Pros:** Purpose-built message broker — the closest literal match to a generic "Message Queue" container. Supports complex routing if the platform later needs fan-out.
- **Cons:** Heaviest new infrastructure of the three (a full broker, not an in-memory-store add-on). The microservices `@MessagePattern`/`@EventPattern` model has no built-in job retries/progress/backoff — hand-rolled. Overkill for a single-producer/single-consumer job pipeline.

**Recommendation:** **Option A (BullMQ)** — best fit for the actual shape of the problem (one producer, one consumer, job-shaped work needing retries/progress/concurrency), with first-class, currently-maintained NestJS support (`@nestjs/bullmq`) and the lightest operational footprint of the two queue-shaped options. The worker runs as a NestJS standalone application in its own Compose service/entrypoint inside `nestjs-project/`, isolating FFmpeg-heavy work from the HTTP server's process without a second codebase. Redis connections used by BullMQ must set `maxRetriesPerRequest: null` (confirmed via `ioredis` docs — BullMQ's blocking queue commands cannot tolerate the client's default retry-then-flush behavior).

**Decision:** A (BullMQ + Redis; worker as a separate NestJS standalone process/container from the API)
**Libraries:** @nestjs/bullmq, bullmq, ioredis

**Revisions:**
- 2026-09-22 — Formalized `**Libraries:**` field (library names were already cited in the Recommendation prose but never structured as their own field). Rationale: `Decision:` was filled directly by the user, bypassing `/plan-resolve`'s normal pending→decided flow that would have added this field automatically; retroactively formalizing it unlocks `/plan-resolve`'s library-cache carve-out.

---

## TD-04: Video Processing & Thumbnail Extraction Toolchain

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** Both capabilities are satisfied by the same underlying tool (FFmpeg/FFprobe), so they share one toolchain decision. The worker process (TD-03) runs this code after a job is dequeued. `fluent-ffmpeg` is explicitly excluded from consideration — the package is unmaintained/archived and not an acceptable dependency for a greenfield 2026 project. The execution wrapper itself is a fixed project convention, not an open option here: a `VideoProcessorPort` interface (e.g. `probe(path)`, `extractThumbnail(path, timestamp)`) implemented by an `FfmpegVideoProcessorAdapter` that calls `child_process.spawn('ffmpeg'|'ffprobe', argsArray)` — **array-form arguments only, never `shell: true`** (avoids shell-injection risk from any path/argument built from user-controlled data, e.g. the original filename) — and parses `ffprobe -of json` stdout for metadata. What genuinely needs deciding is **how the FFmpeg/FFprobe binaries the adapter spawns are provisioned**, since that determines reproducibility across dev/CI/prod.

**Options:**

### Option A: `@ffmpeg-installer/ffmpeg` + `@ffprobe-installer/ffprobe` (npm-pinned static binaries)
- The adapter resolves absolute binary paths from these packages' exported path constants and spawns them directly — used purely as a binary distribution mechanism, not as an execution API.
- **Pros:** Version-pinned via `package.json`/lockfile like any other dependency — reproducible across dev/CI/prod automatically, no Dockerfile changes as the base image evolves.
- **Cons:** Bundles static binaries (tens of MB) into `node_modules`/the image. Still a third-party npm wrapper for binary distribution (supply-chain surface), though thinner than `fluent-ffmpeg`'s execution API.

### Option B: System-installed FFmpeg/FFprobe pinned via `apt` in `Dockerfile.dev`
- `RUN apt install -y ffmpeg=<pinned-version>`, pinned to a Debian package version available on the `node:25.6.0-slim` base (confirmed the project's actual Node image).
- **Pros:** No npm dependency for binaries; benefits from Debian's own security patching.
- **Cons:** Pinned `apt` versions can become unavailable once the base image's package index moves on — rolling `-slim` images don't guarantee old package versions stay installable, tying FFmpeg's lifecycle to the base image rather than the app's own dependency graph.

### Option C: Vendored static build via Docker multi-stage `COPY`, pinned by digest
- A multi-stage Dockerfile step copies exact FFmpeg/FFprobe binaries from a pinned, digest-referenced source (e.g. a static-build image layer, or an official static-build tarball pinned by checksum) into the final image at a fixed path.
- **Pros:** Maximal reproducibility — pinned by content hash, decoupled from both the npm registry and the OS package repo's mutable state.
- **Cons:** Most Dockerfile complexity of the three. The pin must be bumped manually (or via a scheduled job) instead of a routine `npm update`.

**Recommendation:** **Option C (vendored, digest-pinned build)** — keeps the FFmpeg/FFprobe binary supply chain independent of both the npm registry and any wrapper package's release cadence, matching the same reproducibility bar the project already applies to its own dependencies via the lockfile. Provisioned in the **worker image only** — the API image has no processing responsibility (it only enqueues jobs and issues presigned URLs, TD-02) and must not carry the FFmpeg binaries unless a concrete API-side need emerges later. `fluent-ffmpeg` stays excluded under every option.

**Decision:** C (Vendored static FFmpeg/FFprobe build, pinned by digest/checksum, provisioned in the worker image only)

---

## TD-05: Large File Upload Ingestion Strategy

**Scope:** Backend

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** `docs/project-plan.md` § "Pontos de Atenção" states the 10GB upload "precisa ser feito de forma que não trave o sistema e permita retomar em caso de falha de conexão" — two explicit, testable NFRs: no system-blocking buffering, and resumability across connection failures. This decision also determines how "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload" is triggered — whichever mechanism is chosen must expose a point in time before the file finishes uploading. Depends on TD-01 (storage) and TD-03 (queue, for triggering processing on completion).

**Options:**

### Option A: tus protocol via `@tus/server` + `@tus/s3-store`
- The API mounts a tus endpoint backed by `@tus/server`'s framework-agnostic `Server.handle()` (confirmed current API: `new Server({path, datastore})`, `server.handle.bind(server)` mounted on an Express sub-app — matches the project's Express platform), configured with `S3Store` (`@tus/s3-store`) pointed at MinIO (TD-01). `onUploadCreate` creates the draft `Video` row; `onUploadFinish` enqueues the TD-03 processing job. The client uploads in chunks across multiple requests; the protocol tracks the received offset server-side, so a dropped connection resumes from the last acknowledged byte instead of restarting.
- **Pros:** The only option that natively satisfies both explicit NFRs at once — resumability on connection failure, and no full-file buffering (`S3Store` streams each chunk into storage's own multipart upload). `onUploadCreate`/`onUploadFinish` map directly onto "draft on start" and "trigger processing on finish". Keeps the API as the upload ingress, matching `Rel(api, storage, "Uploads")`. `ServerOptions.maxSize` rejects uploads over the 10GB ceiling at the protocol level (confirmed current API), before bytes beyond the limit are ever accepted.
- **Cons:** Introduces a protocol the (future) frontend upload client must speak (`tus-js-client` or equivalent) — a new integration surface once the upload screen is built. `S3Store`'s part size (S3 multipart's 5MB minimum) needs tuning against expected chunk sizes.

### Option B: Plain streamed multipart upload (`busboy` stream piped into `@aws-sdk/lib-storage`'s `Upload`)
- The API parses the incoming `multipart/form-data` request as a stream — never buffered fully in memory — piped directly into the S3 `Upload` helper, which performs its own multipart upload to storage.
- **Pros:** No new protocol — a conventional single HTTP POST with a file field. Fewer moving parts than tus.
- **Cons:** No resumability — a dropped connection at byte 9GB of 10GB means restarting the whole upload, directly violating the "permita retomar" requirement. No equivalent to tus's `onUploadCreate` hook firing before bytes arrive, so draft pre-registration needs a separate mechanism.

### Option C: Client-side direct-to-storage multipart upload (API only issues presigned part URLs)
- The API creates the draft `Video` row and a multipart upload session, returning presigned URLs per part; the browser uploads parts directly to storage and reports completion back to the API to finalize and enqueue processing.
- **Pros:** Removes the API entirely from the upload data path — no bandwidth bottleneck on the NestJS process regardless of file size or concurrent uploads.
- **Cons:** Deviates from the documented `Rel(api, storage, "Uploads")` relationship. Resume/retry orchestration across parts becomes frontend responsibility with no established protocol — effectively reimplementing tus's client logic by hand. Splits upload logic across two layers instead of one.

**Recommendation:** **Option A (tus)** — the only option satisfying both explicit "Pontos de Atenção" NFRs without custom-built resume logic, whose lifecycle hooks map directly onto this phase's draft-pre-registration and processing-trigger capabilities, while preserving the documented API-mediated upload path (unlike Option C). Note: `@tus/server` defaults to an in-memory `MemoryLocker` (confirmed current default), safe only while the API runs as a single instance — acceptable for this phase since horizontal scaling of the API is not required here; a `RedisLocker` is the documented upgrade path if that changes later (Redis is already provisioned for TD-03).

**Decision:** A (tus via `@tus/server` + `@tus/s3-store`, targeting MinIO per TD-01)
**Libraries:** @tus/server, @tus/s3-store

**Revisions:**
- 2026-09-22 — Added explicit requirement: real, interrupted-then-resumed upload behavior against the actual tus/S3Store/MinIO stack has never been **proven** — it must be verified by a real integration test (upload N bytes via `PATCH`, terminate the connection, query the offset via `HEAD`, resume the `PATCH` from that offset, assert the completed object is byte-identical/complete). Rationale: "permita retomar em caso de falha de conexão" (`docs/project-plan.md` § Pontos de Atenção) is an explicit NFR/acceptance criterion for this deliverable — that tus *supports* resumability architecturally is not the same as a passing test proving this project's specific wiring (S3Store, MinIO, multipart part-size config) actually resumes correctly end-to-end. No current SI's Tests table exercises an actual interrupt-and-resume cycle (the existing tus-mount Integration test only asserts draft creation on a single, uninterrupted upload start). This is a testing/acceptance requirement to carry into `/plan-build`'s Tests table for the relevant SI — not a new strategic decision (the mechanism, tus, is already decided above).

**Revisions:**
- 2026-09-22 — Formalized `**Libraries:**` field (library names were already cited in the Recommendation prose but never structured as their own field). Rationale: `Decision:` was filled directly by the user, bypassing `/plan-resolve`'s normal pending→decided flow that would have added this field automatically; retroactively formalizing it unlocks `/plan-resolve`'s library-cache carve-out.

---

## TD-06: Video Lifecycle / State Model

**Scope:** Backend

**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** The `Video` entity needs to represent two independently-varying concerns: a **technical processing state** (did the file finish uploading, get processed, succeed or fail?) and a minimal **editorial flag** (is the video a draft, or published?). This deliverable owns and writes the technical processing state end-to-end, and only *initializes* the editorial flag to a default value when the row is created — it implements no transition logic for that flag and no publication-related functionality. A video can legitimately be "processing finished, streamable" while still flagged as a draft — the model must represent that combination without contradiction. This decision is a prerequisite for TD-03's worker status writes and TD-05's draft-creation write.

**Options:**

### Option A: Single flat `status` enum column
- One `status` column on `Video` holding both the processing state and the editorial flag in one enum (e.g. `UPLOADING | PROCESSING | READY | FAILED | DRAFT | PUBLISHED`).
- **Pros:** Simplest possible schema — one column.
- **Cons:** Cannot represent the two concerns' legitimate combinations (e.g. "processing finished but still a draft") without an exploding, semantically confusing set of composite values. Mixes an end-to-end-owned concern (processing) with a merely-initialized one (the editorial flag) in a single column, with no structural separation between what this deliverable fully implements and what it only sets a default for.

### Option B: Two orthogonal enum columns on the same `Video` entity
- `processingStatus: UPLOADING | PROCESSING | READY | FAILED` (written end-to-end by this deliverable's upload endpoint and worker) and `publicationStatus: DRAFT | PUBLISHED` (this deliverable only initializes it to `DRAFT` when the `Video` row is created; no transition logic for it is implemented here), both columns on `Video`.
- **Pros:** The two states vary independently and combine naturally. Clean ownership boundary at the column level — this deliverable's code never performs an editorial publication transition, and nothing that writes `publicationStatus` writes `processingStatus`. Standard enum-column pattern, no new entity/migration complexity beyond one extra column.
- **Cons:** `Video` carries two concerns in one table — a mild coupling, though both genuinely describe the state of the same row.

### Option C: Separate `VideoProcessingJob`/`ProcessingStatus` entity, `Video` holds only the editorial flag
- `Video` carries only the editorial flag; a separate table tracks every processing attempt (one-to-many by `videoId`), giving a full history/audit trail of retries and failures.
- **Pros:** Full audit trail of every processing attempt — valuable if a video can be reprocessed multiple times and each attempt needs individual inspection. Fully decouples the processing lifecycle from the `Video` aggregate.
- **Cons:** Extra join for the common case ("what's this video's current status?" — the everyday query need). Extra entity/migration for a need (attempt history) not stated in this deliverable's NFRs; Option B is a strict subset that can be upgraded into this later without disruption.

**Recommendation:** **Option B (two orthogonal enum columns)** — cleanly separates the two independently-varying concerns without the schema/query overhead of a separate table, and is a natural stepping stone to Option C later if per-attempt processing history becomes a real requirement.

**Decision:** B (Two orthogonal enum columns) — `processingStatus: UPLOADING | PROCESSING | READY | FAILED`; `publicationStatus: DRAFT | PUBLISHED`.

**Ownership boundary (this deliverable):**
- This deliverable controls `processingStatus` end-to-end (all four values, written by the upload endpoint and the worker).
- This deliverable initializes `publicationStatus = DRAFT` when the `Video` row is created — a row-creation default, not an editorial action.
- Any subsequent editorial transition of `publicationStatus` is out of scope for this deliverable.
- No publish/publication functionality is implemented as part of this deliverable — `publicationStatus` exists on the entity solely so the processing lifecycle has a place to initialize it correctly, without this deliverable building or planning the logic that later changes it.

---

## TD-07: Worker Temporary Storage Strategy

**Scope:** Backend

**Capability:** Transversal — covers: "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** FFmpeg (via TD-04's `FfmpegVideoProcessorAdapter`) needs local filesystem access — it cannot reliably operate directly on a remote object-storage stream for arbitrary input files (see Option B's cons below). Up to 10GB per job, run on a worker container (TD-03) separate from the API, raises real operational constraints: how much local disk the worker needs, how it's freed on both success and failure, and what happens when a retry (TD-03's idempotency concern) re-runs a job whose temp files may already partially exist. Depends on TD-01 (source object location), TD-03 (the worker owns this disk budget and its job concurrency setting), TD-04 (the adapter consumes local file paths).

**Options:**

### Option A: Full download to a per-job temp directory, streamed to disk, cleaned up in `finally`
- The worker streams the source object from storage into `/tmp/videos/{jobId}/source.<ext>` — never buffered fully in memory — runs the TD-04 adapter against that local path for both metadata and thumbnail extraction, uploads results, then deletes the job's temp directory in a `try/finally` regardless of outcome. The worker's Docker volume is sized for `concurrency × max upload size`, and a startup routine sweeps/deletes any orphaned job directories older than a threshold (a crash-safety net, since `finally` cannot run across a killed process).
- **Pros:** Simplest mental model — FFmpeg operates on an ordinary local file, full compatibility with every FFmpeg/FFprobe feature (seeking, format probing) with no streaming edge cases. Cleanup is one well-tested code path plus one safety-net sweep.
- **Cons:** Requires explicit capacity planning — the worker's volume and its BullMQ `concurrency` setting must be sized together so `concurrency × 10GB` fits the provisioned disk, and that ceiling must be monitored/adjusted as usage grows.

### Option B: Streamed/piped processing, no full local materialization
- The worker pipes a storage read-stream directly into FFmpeg (stdin or a named pipe), avoiding writing the full file to disk.
- **Pros:** No per-job disk footprint, no capacity planning for the source file.
- **Cons:** Many real-world MP4s are not "faststart"-optimized — their metadata atom sits at the *end* of the file, so extracting duration/metadata or a thumbnail can require seeking near the end before the start of the stream is even meaningful. A pure forward-only stream breaks or becomes unreliable for exactly these files, making this option fragile for a first version of the pipeline.

### Option C: Bounded shared temp pool with reservation/backpressure
- A fixed-size Docker volume shared across all concurrent worker jobs; each job reserves its expected size (from the object's known `Content-Length`) via an in-process semaphore before downloading, and **waits** rather than starting a download that can't fit if the pool is near capacity.
- **Pros:** Bounds worst-case disk usage independent of concurrent job count; turns "not enough disk space" into a handled backpressure case instead of an operational incident.
- **Cons:** More implementation complexity than Option A (reservation bookkeeping reconciling with what's actually on disk after a worker restart); still needs the same crash-safety sweep as Option A.

**Recommendation:** **Option A**, explicitly including two guard-rail practices — a `Content-Length` pre-flight check against known-free space before starting a download (rejecting/retrying-later a job that clearly can't fit, rather than filling the disk mid-download), and the startup orphan-sweep for crash safety. Lowest-complexity option that still turns disk exhaustion into a handled, observable failure rather than an incident. Option C is the natural upgrade path if static `concurrency × max-size` sizing later proves insufficient; Option B is not recommended given real-world MP4 seek requirements. Worker `concurrency` should default to **1** (the safe initial configuration, collapsing the capacity formula to a single 10GB budget), configurable via env var.

**Decision:** A (Streamed download to per-job temp directory; FFmpeg processes the local file; deterministic `finally` cleanup; startup orphan sweep; free-space preflight before download; `concurrency` default 1, configurable)

---

## TD-08: Unique Video Identifier / URL Strategy

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Each video needs a unique, URL-usable identifier for its object keys (TD-01) and its public watch/download endpoints. The project's own entity convention (`.claude/rules/nestjs-entities.md`: "Use UUID as primary key: `@PrimaryGeneratedColumn('uuid')`") already applies to every other entity (`User`, `Channel`).

**Options:**

### Option A: UUID v4 as the `Video` entity's primary key
- Reuse the project's existing entity convention. The PK itself IS the video's unique identifier, used directly in URLs and in TD-01's object key scheme.
- **Pros:** Zero new code or dependency — the same pattern every other entity in the project already uses. Collision is a database-enforced primary-key constraint, not an application-level concern to maintain separately (UUID v4 offers extremely high practical uniqueness, and a duplicate PK simply cannot be persisted regardless). One identifier serves both the DB row and the public URL.
- **Cons:** UUIDv4 strings are longer (36 chars) than purpose-built short-ID generators, making URLs slightly less compact.

### Option B: `nanoid` as a separate public-facing ID column (PK stays UUID)
- Generate a short, URL-friendly random string via `nanoid`, stored in a dedicated `publicId` column with a unique index; the row's PK remains the standard UUID.
- **Pros:** Shorter, more compact URLs than raw UUIDs.
- **Cons:** Introduces a second identifier concept per video (PK vs public ID) and a new dependency for a cosmetic gain only. Uniqueness now needs an explicit DB unique constraint plus (extremely rare) collision-retry logic on insert — work the UUID PK gets for free.

### Option C: Auto-increment integer PK + separate slug column
- Sequential integer PK for internal use; a separate `slug` column (e.g. derived from title, or a short random token) used in public URLs.
- **Pros:** Smallest possible PK for internal joins/indexes.
- **Cons:** Sequential integer PKs leak information (total video count, creation order) if ever exposed accidentally; requires the same secondary-uniqueness machinery as Option B for the slug; diverges from the project's established UUID-PK convention for no stated benefit in this phase (title-based slugs are a Phase 04 concern, not needed for the raw upload/processing pipeline).

**Recommendation:** **Option A (UUID v4 as PK)** — reuses the exact convention already established for every other entity in the project, needs no new dependency or secondary uniqueness mechanism, and satisfies "sem conflito com outros vídeos" by construction via the database's own primary-key constraint.

**Decision:** A (UUID v4 as PK)

---

## TD-09: Accepted Video Format / Container / Codec Validation

**Scope:** Backend

**Capability:** Transversal — covers: "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance", "Processamento automático do vídeo após upload (extração de duração e metadados)", "Reprodução via streaming (sem necessidade de download completo)"

**Context:** This deliverable performs no transcoding (TD-04 extracts metadata/thumbnails; it does not re-encode). The original uploaded bytes are the exact file TD-02's presigned URLs later serve for both streaming and download — whatever format is accepted at upload time is exactly what browsers must play directly, with nothing to normalize it later. "FFprobe can decode/inspect it" is a materially weaker guarantee than "a browser can play it natively": FFmpeg's demuxer/decoder support is far broader than any browser's native `<video>` playback support, so accepting anything FFprobe can parse would let files through that process successfully (duration extracted, thumbnail generated, `processingStatus` reaches `READY`) yet fail to play client-side — a silent contract violation between this deliverable's "ready" signal and the "reprodução via streaming" capability. Depends on TD-01 (storage, for deleting a rejected object), TD-02 (the object being validated is the exact object later served, unmodified), TD-04 (the FFprobe toolchain reused here — no new tool introduced), TD-05 (the tus `onUploadCreate`/`onUploadFinish` hooks that anchor the two validation stages), TD-06 (`processingStatus: FAILED` is the existing terminal state for a rejected file — no new lifecycle state).

**Options:**

### Option A: Narrow allowlist — MP4 container, H.264 video, AAC audio or silent
- Accept only `video/mp4` at declaration time; authoritatively require the real, ffprobe-inspected container to be MP4 — not QuickTime/MOV, even though both share ffprobe's `format.format_name` demuxer family string `"mov,mp4,m4a,3gp,3g2,mj2"`; exactly one video stream with `codec_name: "h264"`; zero or one audio stream, and if present, `codec_name: "aac"`. The precise predicate that distinguishes MP4 from MOV within that shared demuxer family is an implementation detail for `/plan-build`/`/implement` to define from FFprobe's actual output/documentation — this TD fixes the binding contract (MP4 in, MOV out, exactly one H.264 video stream, optional AAC-only audio), not a specific field/value predicate.
- **Pros:** MP4 + H.264 + AAC is broadly supported across current major browsers and platforms without plugins or fallback — the safest available baseline when there is no transcoding step to correct a mismatch. Some player implementations depend on the operating system's own codec/media stack rather than the browser alone, which is a reason to keep the allowlist narrow rather than broaden it further. Fully verifiable from the single `ffprobe -show_format -show_streams -of json` call already produced by TD-04's adapter for metadata extraction — no second tool, no extra process. Smallest test/edge-case surface.
- **Cons:** Rejects common non-malicious sources — WebM screen recordings, HEVC-encoded phone exports, MP3-in-MP4 audio — forcing the uploader to re-encode client-side before trying again, with no server-side path to accept them until a future transcoding phase exists.

### Option B: Broader native-playback allowlist — MP4 (H.264/AAC) or WebM (VP8/VP9, Opus/Vorbis or silent)
- Same authoritative mechanism as Option A, plus a second accepted branch: `format.format_name` containing `webm`, video `codec_name` ∈ `{vp8, vp9}`, audio `codec_name` ∈ `{opus, vorbis}` or silent.
- **Pros:** Both branches are genuinely playable natively in a `<video>` element in most browsers without transcoding, widening acceptance to a second common export format (e.g., browser-based screen recorders default to WebM).
- **Cons:** WebM/VP9 support is not actually universal at the browser layer the way MP4/H.264 is — Safari's WebM support has historically been partial/inconsistent depending on OS version and codec pack availability. Since this deliverable has no transcoding step, accepting a WebM file commits the platform to serving it unmodified to every visitor's browser, including ones where it will not play — directly working against the "reprodução via streaming" capability for a real, non-hypothetical slice of users, for a format-acceptance gain the phase does not need yet.

### Option C: Broad, ffprobe-decodability-only allowlist (any container/codec ffprobe can parse)
- Accept any file where ffprobe reports ≥1 video stream, with no container or codec allowlist beyond "ffprobe could read it."
- **Pros:** Maximum upload acceptance, least user friction, no allowlist to maintain or extend later.
- **Cons:** This is exactly the trap the deliverable must avoid: ffprobe/FFmpeg's decoder coverage is far wider than any browser's native playback support (HEVC, MPEG-2, arbitrary MKV codec combinations, etc. all parse fine in ffprobe but do not play in a plain `<video>` tag). Without a transcoding step, "ffprobe accepted it" and "the browser can play it" are different claims, and this option conflates them — a video could reach `processingStatus: READY` with duration and thumbnail successfully extracted, yet be unplayable for every visitor, which is a worse failure mode than a rejected upload because it surfaces only at playback time, for every viewer, long after the uploader believes the job succeeded.

**Recommendation:** **Option A (MP4 / H.264 / AAC-or-silent)** — the only option whose accepted set is validated, not merely inferred, against actual native browser playback support, which matters specifically because this phase has no transcoding step to correct a format that FFprobe can parse but a browser cannot play. Option B's WebM branch trades a real, current cross-browser playback gap (Safari) for upload convenience the phase does not require. Option C conflates "FFprobe can decode it" with "a browser can play it," which is precisely the failure mode this decision exists to prevent. Re-opening to Option B (or reintroducing rejected formats generally) is a natural, low-cost follow-up once a transcoding phase normalizes everything to one deliverable format regardless of what was uploaded.

**Decision:** A (MP4 / H.264 / AAC-or-silent narrow allowlist)

**Validation stages & failure behavior:**
- **Preliminary (upload creation, non-authoritative):** `onUploadCreate` reads the client-declared `filetype` from the tus `Upload-Metadata` header (confirmed current `@tus/server` behavior — the hook receives `upload.metadata` and may `throw` to abort creation with a custom status/body before any bytes are accepted). If `filetype` is present and is not `video/mp4`, the upload is rejected immediately. Absence of this metadata does NOT amount to authoritative acceptance — it only means the preliminary check has nothing to reject on, and creation proceeds to the authoritative stage below regardless. Filename, extension, and client-declared MIME are all untrusted signals here, used only to short-circuit obviously-wrong uploads before any storage cost is incurred.
- **Authoritative (after upload completion):** `onUploadFinish` only enqueues the job, unchanged from TD-05 — it performs no format validation itself. The worker downloads the object from storage to the per-job temp directory (TD-07), and FFprobe runs as the worker's first real processing step, before duration/thumbnail extraction — reusing the same `ffprobe -show_format -show_streams -of json` invocation TD-04 already performs for metadata, so no second tool call or new process is introduced. This runs in the worker, not in the API's `onUploadFinish` hook, because TD-04 already restricts the FFprobe binaries to the worker image only. It validates container/streams/codecs against the completed file's real bytes; no client-supplied signal (filename, extension, declared MIME) is trusted at this stage. Only content that passes this check continues on to metadata and thumbnail extraction.
- **On mismatch:** the worker throws `UnrecoverableError` (per `upload-processing/TD-10` — a format mismatch is the canonical non-retryable case, since re-running the same file can never pass this check) immediately after the FFprobe check fails, and deletes the uploaded object from storage (TD-01) inline, before throwing — this extends TD-07's existing `finally` cleanup (which already covers the *local* temp copy on every outcome) to the *stored* source object specifically for this format-mismatch case, and is done here (rather than in a generic failure handler) because only this code path knows the object can never become servable. Thumbnail/metadata extraction does not run; the video is never promoted to `READY`. **This code path does not write `processingStatus` itself** — TD-10 is the single place in the entire worker where `processingStatus` is ever written to `FAILED`, inside `@OnWorkerEvent('failed')`, once it confirms (via `UnrecoverableError` or attempts exhaustion) that this is genuinely the final outcome.

**Security:** client-declared filename, extension, and MIME are used only for the preliminary, non-authoritative rejection above — never for the final accept/reject decision, and never passed into any command executed by the server. The authoritative check reuses TD-04's existing `spawn` invocation with array-form arguments and `shell: false`; this decision introduces no new code path that places user-controlled data into a shell. A rejected upload never reaches `processingStatus: READY`, and `publicationStatus` is never transitioned by this deliverable regardless of processing outcome (TD-06) — so an incompatible upload cannot become servable or "published" through this decision.

---

## TD-10: Job Failure Classification, Final-FAILED Transition, and Worker Idempotency

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** TD-03 decided BullMQ + Redis with "built-in retries/backoff", TD-06 defined `processingStatus: FAILED` as a lifecycle value, and TD-09 decided that a format mismatch is a non-retryable failure (throws `UnrecoverableError`, per this TD's own contract below). None of the three, individually or together, specify four load-bearing reliability contracts that the worker's actual code must honor: (1) **when** exactly `processingStatus` transitions to `PROCESSING` — no existing TD states this explicitly; without it, an implementer might leave the row at `UPLOADING` through the entire processing run, and nothing currently defines what a *duplicate* execution against an already-`READY` video (a stale retry racing a completed run, or TD-11's reconciliation sweep re-enqueueing a job whose original attempt already succeeded) should do; (2) **when** exactly `processingStatus` is written as `FAILED` relative to BullMQ's retry loop — BullMQ's Worker calls `Job.moveToFailed()` first (which resolves retry-vs-terminal internally and updates the job's own bookkeeping), and only *after* that call resolves does the Worker emit its `'failed'` event — but the event still fires on **every** failed attempt, not only the final one, so a handler that writes `FAILED` on every emission would incorrectly mark a video `FAILED` while a transient retry is still about to succeed; (3) **which** failures should consume a retry attempt (transient: disk-space preflight per TD-07, transient storage/network errors) versus which should **skip retry entirely** (permanent: TD-09's format mismatch — retrying an unfixable mismatch wastes worker time and delays the user's feedback for no benefit); (4) whether re-running the **same** job (via BullMQ retry after a transient failure, or via BullMQ's stalled-job re-queue after a worker crash) is **safe to execute from scratch** — i.e., idempotent — given every processing step (temp download, FFprobe, thumbnail upload, final DB write) may partially execute before the failure/crash occurs. Without an explicit, binding answer to these four questions, the actual worker implementation is left to guess, and "vídeo inválido chega a `FAILED`" / "job assíncrono... lifecycle persistido" (both explicit acceptance criteria for this deliverable) are not verifiably guaranteed by any existing TD.

**Options:**

### Option A: Native BullMQ primitives (`UnrecoverableError` + `@OnWorkerEvent('failed')` with an explicit in-handler finality check) + idempotent-by-construction via already-decided deterministic keys, plus an explicit `PROCESSING` transition and duplicate-run safe no-op
- **`PROCESSING` transition:** the processor writes `processingStatus = PROCESSING` as its first action upon actually picking up the job — before any download, FFprobe, or processing work begins — on **every** attempt, including BullMQ-initiated retries (a retry re-enters at `PROCESSING`, not some separate "retrying" state; TD-06 defines no such value). Before doing so, the processor checks the row's current `processingStatus`: if it is already `READY`, the run is a duplicate of one that already completed (e.g., a stale retry that raced a successful attempt, or TD-11's reconciliation sweep re-enqueueing a job whose original attempt succeeded before the enqueue-failure was even detected) — the processor exits immediately as a **safe no-op**, performing no download, no FFprobe call, no re-upload, and no further write. This is a stronger guarantee than TD-10's general idempotency stance (every step is *safe* to repeat) — for the already-`READY` case specifically, repeating is not merely safe, it is skipped entirely.
- **Final-FAILED transition:** the Worker calls `Job.moveToFailed()` first — which internally runs `shouldRetryJob()` (checking `this.attemptsMade + 1 < this.opts.attempts` and whether the error is an `UnrecoverableError`, per the confirmed current `job.ts` source), performs the corresponding state transition (`moveToDelayed` for a backoff-retry, `retryJob` for an immediate retry, or `backend.moveToFailed` for the terminal case), and only then increments `job.attemptsMade` — and only **after** `moveToFailed()` resolves does the Worker emit the `'failed'` event. The event still fires on **every** failed attempt, retryable or not — it does not by itself mean "no further retry will happen." But because it fires *after* `moveToFailed()` has already run its course, the `job` object the listener receives already reflects the post-attempt state, including the already-incremented `attemptsMade` — so the listener's finality check is a read of already-resolved bookkeeping, not a race against a decision BullMQ hasn't made yet. `@OnWorkerEvent('failed')` on `VideoProcessingProcessor` performs this check explicitly before writing anything: `const isFinal = error instanceof UnrecoverableError || job.attemptsMade >= job.opts.attempts;` (both `attemptsMade` and `opts.attempts` are the real, confirmed `Job` field names in the currently-adopted BullMQ version — see `library-refs.md`). Only when `isFinal` is true does the handler write `processingStatus = FAILED`. On a non-final emission (a retryable attempt that will still be retried), the handler is a no-op — `processingStatus` stays `PROCESSING` (per the transition decided above); the next attempt either succeeds (the processor writes `READY` at the end of its own run, unrelated to this event) or eventually reaches a final emission that satisfies `isFinal`. This is the **single** place in the entire worker where `processingStatus` is ever written to `FAILED` — no other code path (including TD-09's mismatch case) writes it directly; every failure signals via `UnrecoverableError` or a plain `Error` and lets this handler decide. The processor's `process()` method itself never writes `FAILED` directly on a caught exception — only re-throws (or lets an already-thrown `UnrecoverableError`/`Error` propagate).
- **Retryable vs non-retryable classification:** TD-09's format-mismatch case throws `UnrecoverableError` (confirmed current BullMQ class — thrown from the processor, it moves the job directly to the failed set, bypassing the configured `attempts` entirely, per the BullMQ source's own `shouldRetryJob` check: `!(err instanceof UnrecoverableError)`). Every other failure path (TD-07's free-space preflight rejection, transient storage/network errors during download or thumbnail upload) throws a plain `Error`, so BullMQ's existing retry/backoff (TD-03) runs its normal course before eventually reaching `@OnWorkerEvent('failed')` if all attempts are exhausted.
- **Idempotency:** no new mechanism is introduced. Every side-effecting step in the worker sequence is already safe to re-run from scratch given decisions already made elsewhere: the temp download target is a per-job directory cleaned in `finally` with a startup orphan sweep (TD-07) — re-downloading on retry is a plain overwrite of a fresh directory; FFprobe validation is read-only; the thumbnail is uploaded to a **deterministic** object key derived from the video `id` (TD-01, TD-08) — re-uploading on retry overwrites the same key, not a new one, so a retry never leaks an orphan object; the final DB write (`durationSeconds`, `thumbnailStorageKey`, `processingStatus`) is a plain field update, safe to repeat with the same values. A retry (BullMQ attempts) or a stalled-job re-queue (worker crash mid-processing) can therefore always restart the job from step 1 with no separate dedup table or idempotency-key column.
- **Pros:** Zero new dependencies or schema — reuses exactly the queue infrastructure already decided in TD-03 and the deterministic-key pattern already decided in TD-01/TD-08. `UnrecoverableError` and `@OnWorkerEvent('failed')` are both confirmed, current, first-class BullMQ/`@nestjs/bullmq` APIs (per `library-refs.md`), not workarounds. Directly satisfies "vídeo inválido chega a `FAILED`" without wasting retry attempts on a mismatch that can never succeed.
- **Cons:** Requires every current and future failure path in the worker to make a deliberate retryable/non-retryable choice (i.e., which exception class to throw) — a discipline that must be documented for implementers, not enforced by the type system. The `@OnWorkerEvent('failed')` handler itself must also implement the `isFinal` check correctly (it is not automatic) — a second, equally-documented discipline point.

### Option B: Custom retry/idempotency layer (manual attempt tracking table, manual error-code-based retry classification, explicit dedup checks before each side effect)
- A separate DB table tracks per-job attempt count and outcome; the worker inspects a custom error-code field (not BullMQ's exception hierarchy) to decide retry eligibility; each side-effecting step (thumbnail upload, DB write) is preceded by an explicit "was this already done for this job attempt?" check against that table.
- **Pros:** Fully explicit and inspectable without needing to know BullMQ's internal retry semantics.
- **Cons:** Reimplements functionality BullMQ already provides natively and that TD-03 already committed to (`attemptsMade`, `UnrecoverableError`, the `failed` event) — a new table, new write paths, and new tests for behavior the underlying library already guarantees correctly. No stated requirement justifies this duplication.

### Option C: No distinction — every failure retries the full configured `attempts`, `processingStatus` written to `FAILED` inside the processor's own `catch` block on every failed attempt
- The processor catches any exception, immediately sets `processingStatus = FAILED`, and re-throws to let BullMQ retry anyway.
- **Pros:** Simplest code — one `catch` block, no event-listener indirection.
- **Cons:** A video that fails once due to a transient storage hiccup and succeeds on attempt 2 would flicker to `FAILED` and back to `PROCESSING`/`READY` — a state a client polling `processingStatus` could observe and incorrectly surface to the user as a permanent failure. Also wastes 2 full retry cycles (with exponential backoff, per TD-03) retrying a TD-09 format mismatch that can never succeed, delaying the user's FAILED feedback for no benefit.

**Recommendation:** **Option A** — every primitive it needs (`UnrecoverableError`, `@OnWorkerEvent('failed')`, deterministic object keys) is already confirmed current BullMQ/`@nestjs/bullmq` API or an already-decided pattern from TD-01/TD-07/TD-08; it adds zero new schema or dependency, and it is the only option that avoids both the state-flicker risk of Option C and the reimplementation cost of Option B.

**Decision:** A (Explicit `processingStatus = PROCESSING` write on job pickup, every attempt, with a safe no-op when the video is already `READY`; native BullMQ primitives — `UnrecoverableError` for non-retryable failures + `@OnWorkerEvent('failed')`, firing after `moveToFailed()` has already resolved retry-vs-terminal, with an explicit in-handler finality check (`UnrecoverableError` or `attemptsMade >= attempts`) before writing `FAILED`; idempotent-by-construction via deterministic keys)

**Revisions:**
- 2026-09-22 — Clarified the "single writer" guarantee for the durability gap where the worker process crashes, or Postgres is briefly unavailable, in the window between BullMQ recording a job as terminally `failed` and the `@OnWorkerEvent('failed')` handler's write landing: `@OnWorkerEvent('failed')` remains the only **normal-path** writer of `processingStatus = FAILED`, but a reconciliation mechanism (extending the same periodic/startup sweep `upload-processing/TD-11` already runs) may separately repair a **terminally-confirmed** divergence — a `Video` stuck at `PROCESSING` whose correlated BullMQ job (`jobId = process-video-${videoId}`, per TD-11) has already reached Redis-confirmed `'failed'` state (`await job.getState() === 'failed'`, confirmed current `bullmq` API), read directly rather than recomputed, since BullMQ's own terminal decision is more authoritative at reconciliation time than re-deriving `isFinal`. This is architecturally **one write function** (e.g. `persistTerminalFailure(videoId, reason)`), invoked from two triggers — the live event (gated by the existing `isFinal` check) and the reconciliation sweep (gated by the job's own already-confirmed `'failed'` state) — never two independently-decided writers. The reconciliation branch only ever acts on jobs BullMQ has *already* moved to `failed`, never on `active`/`delayed`/`waiting` jobs, so it cannot reintroduce the flicker Option C was rejected for. Rationale: closes a real durability gap with a durable, eventually-consistent repair, without adding a second, uncoordinated code path.
- 2026-09-22 — Extended the duplicate-run safe no-op (previously defined only for an already-`READY` video) to also cover an already-`FAILED` video: `processingStatus: 'FAILED'` is **absolute-terminal** within this phase — no reprocessing, manual retry, or reprocessing endpoint exists or is implied by this deliverable's scope. A job (live execution or the reconciliation mechanism from the revision above) targeting a `Video` already `FAILED` is always a safe no-op — it never re-enters the processing sequence, and it never gets re-written to `FAILED` a second time. Rationale: no capability bullet in `docs/project-plan.md` § Fase 03 implies a manual-reprocessing capability, so treating `FAILED` as terminal — mirroring the already-decided `READY` case — is the only option consistent with the existing scope; this had been left undecided, letting `/plan-build` infer the behavior without TD backing, which this revision now formalizes.

---

## TD-11: tus Upload Correlation with `Video` Entity, and Enqueue-Failure Recovery

**Scope:** Backend

**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** `@tus/server`'s default `namingFunction` generates a random 32-character hex string (confirmed current default: `crypto.randomBytes(16).toString('hex')`) that becomes **both** the tus resource id in the upload URL **and**, per `@tus/s3-store`'s confirmed behavior, the literal S3 object key the bytes are stored under (`S3Store.create()` sets `upload.storage = {type: 's3', path: Key, ...}` where `Key` is that same id) — "In `@tus/server`, the upload ID in the URL is the same as the file name." This default naming has **no relationship** to `Video.id` (UUID v4, TD-08) — left unresolved, an implementer must invent the correlation between the tus upload id, the S3 object key the bytes land under, and the `Video.id` the DB tracks, and TD-08's own already-decided premise ("the PK itself IS the video's unique identifier, used directly in... TD-01's object key scheme") becomes unverifiable without knowing which value actually reaches the S3 key. (Note: `@tus/server` requires everything after the last `/` in the upload URL to be treated as the id — an id containing `/` additionally requires overriding `generateUrl` and `getFileIdFromRequest`, with custom encode/decode logic, per the server's own documented `ServerOptions`; any correlation design that produces a slash-containing id must account for this, not just for `namingFunction` in isolation.)

Separately: `onUploadFinish`'s only job (TD-05, TD-09) is to enqueue the `video.processing` job — but no TD says what happens if that enqueue call itself throws (e.g., a transient Redis connectivity blip). By the time `onUploadFinish` fires, every byte of a potentially 10GB file is already durably stored (TD-05's tus/S3Store flow only calls this hook after the upload is complete) — silently losing that already-durable upload over a queue-infrastructure hiccup unrelated to the video's own validity would be a real, avoidable data-loss/UX regression. Throwing from `onUploadFinish` only aborts the HTTP response for that specific finish-request (confirmed current behavior) — it is **not** a durable, server-side guarantee that the job will ever actually be enqueued; a client that does not retry, crashes, or never gets the chance to resend the finish-request would leave the `Video` row stuck in `UPLOADING` forever with no recovery path, silently violating the "job assíncrono disparado após conclusão" acceptance criterion.

A third, previously-unaddressed gap: `onUploadCreate` is currently the only tus hook any TD (TD-06/TD-09) gates with authentication. Tokens/ownership matter on every subsequent request to an in-progress upload too — `PATCH` (chunk upload) and `HEAD` (offset probe) reach the same resource without going through `onUploadCreate` again, so as currently specified nothing stops a different authenticated user (or an anonymous request) from writing bytes into, or probing the state of, someone else's in-progress upload, even though the Authorization Matrix requires authentication for both "create" and "chunks".

A fourth gap: both `onUploadFinish` and the reconciliation sweep decided above call `queue.add('video.processing', ...)` for the same video — `onUploadFinish` on the normal path, the sweep on the recovery path. Nothing before this TD says these two producers must agree on a single job identity; without that, a duplicate `onUploadFinish` retry racing the sweep (or vice versa) could enqueue two concurrent jobs against the same `Video` row, contradicting TD-10's idempotency stance (which assumes one job runs at a time, not two racing each other).

**Options:**

### Option A: Custom `namingFunction` returns a bare UUID v4 (no path prefix) — the single value shared, unmodified, as the tus id, the S3 key, and `Video.id`; a durable `uploadCompletedAt` timestamp + reconciliation sweep recovers from enqueue failures; `onIncomingRequest` authenticates and authorizes every tus request, not only creation; a deterministic `jobId` derived from `videoId` is shared by every producer to prevent duplicate concurrent jobs

- **Identifier correlation.** `namingFunction` (confirmed current `ServerOptions` field, `(req, metadata) => string | Promise<string>`) generates a UUID v4 and returns it **bare** — no `videos/{id}/...` path, no slashes. Because `@tus/server` requires everything after the last `/` in the upload URL to be the id (confirmed — a slash-containing id needs `generateUrl` + `getFileIdFromRequest` overrides with custom encode/decode, real documented complexity), a bare UUID needs neither override. `@tus/s3-store`'s `S3Store.create()` then stores the bytes under that exact bare UUID as the literal S3 key (confirmed: `Key` = the id `namingFunction` returned). `onUploadCreate` (per TD-06/TD-09, already the hook that creates the `Video` draft row) reads back that same generated id and uses it, unmodified, as `Video.id`. The result: `Video.id`, the tus upload id, and `sourceStorageKey` are the literal same UUID string in all three places — not merely "derived from" one another via a template, but one value generated once and reused three times. (The thumbnail object, uploaded separately by the worker's own `@aws-sdk/client-s3` calls — not through tus/`S3Store` — carries no such id-shape constraint and keeps a readable `videos/{id}/thumbnail` key.)
- **Durable enqueue-failure recovery.** A new `Video.uploadCompletedAt: timestamptz | null` column is written by `onUploadFinish` as its **first** action, via a plain Postgres write independent of Redis/BullMQ availability — this durably records "the bytes are 100% complete" before the enqueue is even attempted. Only after that write succeeds does `onUploadFinish` call `queue.add('video.processing', { videoId }, ...)`. If the enqueue call throws, the exception still propagates (aborting that finish-request's HTTP response, per confirmed current `@tus/server` behavior) — but the durable `uploadCompletedAt` timestamp already persisted means the upload is never silently lost even if no client ever retries. A reconciliation routine — extending TD-07's existing worker-startup orphan sweep with a second check, plus a periodic re-run (e.g. every few minutes) so recovery does not wait for the next worker restart — queries for `Video` rows where `processingStatus = 'UPLOADING' AND uploadCompletedAt IS NOT NULL`, and re-enqueues the processing job for each. This is a real server-side durability guarantee, not a hope that the tus client retries: a 10GB upload can be fully received, have its enqueue call fail, and still be picked up and processed with no further client action.
- **Auth boundary on subsequent requests.** `onIncomingRequest` (confirmed current `ServerOptions` field, `(req: Request, uploadId: string) => Promise<void>`, described as middleware invoked "before all handlers" — POST/PATCH/HEAD/DELETE alike, not only creation) performs the same JWT-authentication check TD-09's `onUploadCreate` gate already requires, on **every** tus request. For any request where `uploadId` is already known (PATCH/HEAD/DELETE against an existing resource), it additionally verifies the authenticated user's channel owns the `Video` row correlated to that `uploadId` — per the identifier correlation above, `uploadId` IS `Video.id`, so this is a direct lookup, no join table needed — rejecting cross-user chunk writes or offset probes against someone else's in-progress upload. Throwing aborts the request (confirmed current behavior) before it reaches any other handler.
- **Deterministic `jobId` across producers.** Every `queue.add('video.processing', { videoId }, { jobId })` call — from `onUploadFinish` **and** from the reconciliation sweep — uses the same deterministic `jobId`, derived from `videoId`: `` `process-video-${videoId}` `` (no `:` — BullMQ's own documented job-id constraint: custom ids must not contain the colon separator, which collides with BullMQ's internal Redis key-naming convention). BullMQ's own confirmed behavior for custom job ids — "any attempt to add a job with an existing ID will be ignored... this uniqueness check only applies to jobs currently in the queue; once a job is removed, its ID can be reused" — is the entire dedup mechanism: if `onUploadFinish` enqueues successfully and the reconciliation sweep later runs before that job completes or is removed, its `queue.add()` call with the same `jobId` is silently ignored, not a second concurrent job. Symmetrically, if the sweep enqueues first (because `onUploadFinish`'s own enqueue call failed) and a retried `onUploadFinish` finish-request calls `queue.add()` again afterward, that call is also silently ignored. No coordination table or lock is needed beyond both producers agreeing on the same `jobId` derivation.
- **Pros:** No `generateUrl`/`getFileIdFromRequest` override, no encode/decode scheme, no second identifier column — the bare-UUID design sidesteps the nested-id complexity entirely while still achieving a single value threaded through tus, S3, and the DB. Enqueue-failure recovery is a real, durable, server-side mechanism (a timestamp + a sweep), not a hope that a client retries a specific HTTP request. The auth gap on PATCH/HEAD is closed with the same mechanism (`onIncomingRequest`) the tus library already exposes for exactly this purpose — no bespoke middleware. The deterministic `jobId` reuses BullMQ's own native job-uniqueness guarantee to prevent duplicate concurrent jobs across both producers, with zero new coordination infrastructure.
- **Cons:** Adds one new persisted column (`uploadCompletedAt`) and a small periodic/startup sweep job beyond what TD-07 already runs — modest, bounded scope. `onIncomingRequest` needs access to the same JWT-verification logic the rest of the API uses, adapted to tus's raw Express-level hook (it runs outside Nest's own guard pipeline, since `@tus/server`'s `Server.handle()` is mounted as a plain sub-app) — a small amount of duplicated wiring, not new logic. Every current and future producer of this job type must consistently derive the same `jobId` format — a discipline point, not enforced by the type system, mirroring TD-10's equivalent discipline requirement for exception-class choice.

### Option B: Keep tus's default random-hex naming; add a separate `Video.tusUploadId` column to correlate the two identifiers
- `Video.id` is generated independently (e.g., a plain `uuidv4()` call in `onUploadCreate`); the tus-assigned random hex is persisted verbatim in a new `tusUploadId` column; `sourceStorageKey` is set to the tus-assigned flat key (where the bytes actually are), not a `videos/{id}/...`-derived one.
- **Pros:** No override of tus's internal naming machinery required.
- **Cons:** Directly contradicts TD-08's already-decided premise that the PK alone drives the object-key scheme — reintroduces exactly the "second identifier concept per video" problem TD-08's own Option B analysis rejected (there, for a cosmetic public-ID gain; here, for no gain at all — just to avoid a `namingFunction` override).

### Option C: `onUploadFinish` enqueue failures delete the uploaded object and mark the `Video` row `FAILED` immediately (fail closed)
- Treat an enqueue failure identically to TD-09's authoritative-validation failure: delete the storage object, set `processingStatus = FAILED`.
- **Pros:** Never leaves a video in an unprocessed limbo state.
- **Cons:** Discards a fully, durably uploaded file (potentially most of 10GB) over a transient, unrelated queue-infrastructure hiccup, forcing a full re-upload — directly working against the "upload... não trave o sistema" resumability spirit this whole deliverable exists to serve, for a failure mode that is often momentary.

**Recommendation:** **Option A** — the bare-UUID `namingFunction` avoids the `generateUrl`/`getFileIdFromRequest` override complexity a slash-containing id would require, while still keeping one identifier flowing through tus, S3, and the DB (Option B reintroduces the exact "second identifier concept" anti-pattern TD-08's own Option B analysis already rejected). The durable `uploadCompletedAt` + reconciliation-sweep mechanism gives enqueue-failure recovery a real server-side guarantee instead of relying on tus-client retry behavior alone — which is not a protocol guarantee, and would otherwise leave the video stuck in `UPLOADING` forever if the client never retries — while still not discarding a successfully-durable upload the way Option C's fail-closed approach does. `onIncomingRequest` closes the previously-unaddressed gap where only upload creation was authenticated, leaving PATCH/HEAD against an in-progress upload unprotected — using the same library-native hook `@tus/server` documents for exactly this purpose. The deterministic `jobId` shared by both producers (`onUploadFinish` and the reconciliation sweep) reuses BullMQ's own native job-uniqueness guarantee to prevent duplicate concurrent jobs, with no new coordination mechanism to build or test.

**Decision:** A (Custom `namingFunction` returns a bare UUID v4 — the single value shared, unmodified, as the tus id, the S3 key, and `Video.id`; durable `uploadCompletedAt` timestamp + reconciliation sweep recovers from enqueue failures; `onIncomingRequest` authenticates and authorizes every tus request, not only creation; deterministic `jobId` = `` `process-video-${videoId}` `` shared by every producer)

**Revisions:**
- 2026-09-22 — Added a second, storage-anchored recovery branch to the reconciliation mechanism, for the case where the *first* `uploadCompletedAt` write itself fails (e.g., Postgres briefly unavailable at the exact moment `onUploadFinish` runs, after the bytes are already durably complete in storage). The existing `processingStatus = 'UPLOADING' AND uploadCompletedAt IS NOT NULL` query cannot discover this case (there is no `uploadCompletedAt` to find). The reconciliation sweep additionally queries `Video` rows where `processingStatus = 'UPLOADING' AND uploadCompletedAt IS NULL AND updatedAt < {grace period}` (a conservative threshold — on the order of an hour — so rows that are still legitimately, actively uploading are never probed) and, for each candidate, issues a `HeadObjectCommand` against the deterministic key (`Bucket: <storage bucket>, Key: video.id`, per this TD's own identifier correlation). A successful `HeadObjectCommand` response is durable, storage-side proof of a **complete** object — an incomplete multipart upload is not visible to `HeadObject`/`GetObject`, only to `ListMultipartUploads`/`ListParts` — so this is proof of completion independent of tus/S3Store's own internal bookkeeping and independent of the client. On success, the sweep retroactively writes `uploadCompletedAt` (using the `HeadObjectCommand` response's `LastModified` as the timestamp, not "now") and proceeds through the exact same enqueue path already decided above (same deterministic `jobId`, same producer logic) — no new mechanism, no new library. On a `404` (object genuinely does not exist — an upload still in progress, or one abandoned before completing), the row is left untouched, remaining covered by this phase's documented abandoned-upload limitation. The normal-path write in `onUploadFinish` is unchanged; this branch only ever finds rows where that normal write is already known to have not happened. Rationale: closes a real gap the original mechanism could not observe — bytes fully durable in storage with no server-side record of that fact — without inventing a new provenance system or depending on the client to retry.

---

## TD-12: Video Metadata Persistence Schema

**Scope:** Backend

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** This capability bullet names two distinct things — "duração **e** metadados" — but only the first half is currently backed by a persisted field (`durationSeconds`, added via TD-06's Data Model). "Metadados" was never given a concrete schema by TD-04 (which decided the *toolchain*, not what to keep from its output) or by any other TD, so the already-written Data Model has no way to derive which fields satisfy that half of the bullet — exactly the gap flagged: the current plan cannot derive this requirement because no TD says what "metadados" means as persisted columns.

**Options:**

### Option A: Persist a small, named set of columns already present in the same FFprobe output TD-04/TD-09 already parse: `width`, `height`, `videoCodec`, `audioCodec`, `bitRate`
- The `ffprobe -show_format -show_streams -of json` call TD-04 decided (and TD-09's authoritative validation already runs, per `upload-processing/TD-09`) exposes `width`, `height`, `codec_name` per stream, and `bit_rate` (both per-stream and in `format`) — no second tool invocation or extra parsing pass is needed; these are read from the same JSON already in memory when the worker extracts `durationSeconds`. Persist as: `width: integer` (nullable), `height: integer` (nullable), `videoCodec: varchar(50)` (nullable — the actual `codec_name`, e.g. `"h264"`; redundant with TD-09's allowlist check but avoids re-probing a stored file just to know what it contains), `audioCodec: varchar(50)` (nullable — `null` when the video is silent, matching TD-09's "zero or one audio stream" contract), `bitRate: integer` (nullable, bits/second, from `format.bit_rate`).
- **Pros:** Zero new tooling or extra I/O — same parse pass already happening for TD-04/TD-09/TD-06. `width`/`height` are directly useful to this project's own near-term roadmap (Fase 05's "Player de vídeo" needs aspect-ratio data); codec fields aid debugging/observability without re-probing storage.
- **Cons:** A fixed column set — a future need for a field outside this list (e.g., frame rate) requires a migration.

### Option B: Persist the full raw FFprobe JSON output verbatim in one `metadata: jsonb` column
- `JSON.stringify()` the entire `ffprobe` result into a single flexible column.
- **Pros:** No schema decisions now; every FFprobe field is available later without a migration.
- **Cons:** Opaque to SQL — filtering/sorting by resolution needs JSON operators instead of plain columns; the capability's own wording ("metadados") reads as a small set of named, useful facts, not an unstructured dump, and the one currently-known future consumer (a player screen) wants specific named fields, not JSON traversal.

### Option C: Persist nothing beyond `durationSeconds` — treat the bullet as already satisfied by duration alone
- **Pros:** Zero additional work.
- **Cons:** Contradicts the capability bullet's own wording — "duração **e** metadados" lists two things, not one; this is precisely the gap this TD exists to close, not a valid way to close it.

**Recommendation:** **Option A** — reuses the already-decided, already-parsed FFprobe call with zero new tooling, and the specific field set (`width`, `height`, `videoCodec`, `audioCodec`, `bitRate`) is both minimal and concretely useful to this project's own stated near-term direction, unlike Option B's unstructured dump or Option C's non-answer to the bullet's explicit wording.

**Decision:** A (Persist `width`, `height`, `videoCodec`, `audioCodec`, `bitRate` from the existing FFprobe parse)

---

## TD-13: tus Termination (`DELETE`) Semantics

**Scope:** Backend

**Capability:** Transversal — covers: "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance", "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload"

**Context:** `upload-processing/TD-11`'s `onIncomingRequest` already authenticates and authorizes every tus request, including `DELETE` — but no TD decides what `DELETE` (the tus termination extension) actually *does*. `@tus/server`'s confirmed default `DataStore.remove(id)` is a no-op unless the concrete datastore implements it; `@tus/s3-store`'s `S3Store.remove(id)` **does** implement it (confirmed: aborts the multipart upload and deletes the object plus its `.info` object in one call). Left undecided, `DELETE` is reachable and authenticated with no defined effect on the `Video` draft row — a supported-looking endpoint with an undefined lifecycle outcome, worse than not exposing it at all.

**Options:**

### Option A: Support termination, scoped strictly to in-progress uploads — hard-delete the `Video` draft row on successful termination
- Set `disableTerminationForFinishedUploads: true` in `ServerOptions` (confirmed current field) — once an upload reaches `offset === size`, `DELETE` returns `400 INVALID_TERMINATION` (native tus protocol response) instead of terminating it; this keeps termination scoped entirely to *upload ingestion*, never reaching into post-upload video lifecycle (editorial/publication territory, out of this phase's scope).
- Rely on `S3Store`'s default `remove(id)` (no override needed, confirmed to abort the multipart upload and delete the object + `.info`) for storage cleanup.
- Register `server.on(EVENTS.POST_TERMINATE, async (req, res, id) => { await videoRepository.delete({ id }); })` (confirmed current event, fired after a successful `DELETE`, carrying the same `id` `upload-processing/TD-11` already established as `Video.id`) to hard-delete the `Video` draft row — chosen over introducing a new `processingStatus`/`publicationStatus` value because `upload-processing/TD-06` defines exactly four `processingStatus` values and no cancelled/terminated state; a cancelled in-progress upload has no processing history worth retaining, so removing the row entirely avoids expanding TD-06's enum for a state with no other use.
- **Pros:** Every primitive needed is already confirmed, current, first-class `@tus/server`/`@tus/s3-store` API — no bespoke cleanup code for the storage side. Gives a real, working cancel capability instead of an artificial restriction. `disableTerminationForFinishedUploads` cleanly draws the scope boundary at "still uploading" vs. "already a video" without a custom check.
- **Cons:** Adds one new event-listener registration and a `DELETE FROM video WHERE id = ...` — small, bounded new surface.

### Option B: Do not support termination — `onIncomingRequest` explicitly rejects `DELETE`
- `onIncomingRequest` throws the project's standard error envelope (`{ status_code: 501, body: JSON.stringify({ statusCode: 501, error: 'UPLOAD_TERMINATION_NOT_SUPPORTED', message: '...' }) }`, per the tus throw-string convention `upload-processing/TD-11` already established) whenever `req.method === 'DELETE'`, before the request reaches `DeleteHandler`.
- **Pros:** Zero storage/DB cleanup code to write or test; the smallest possible surface for a capability no bullet in `docs/project-plan.md` explicitly asks for.
- **Cons:** Actively removes a cheap, well-supported capability the library already provides almost for free (per Option A's confirmed one-call cleanup) — the client's normal "cancel upload" affordance now does nothing useful, forcing the uploader to let a 10GB transfer keep running or simply close the tab (leaving an abandoned draft either way — no better than Option A's failure mode, just without the successful-cancel path Option A also offers).

**Recommendation:** **Option A** — `@tus/s3-store`'s confirmed `remove(id)` implementation and the confirmed `POST_TERMINATE` event mean full support costs one event-listener registration and one `DELETE`, not new infrastructure; `disableTerminationForFinishedUploads` (also confirmed, current) draws exactly the scope line this deliverable needs (in-progress uploads only, never touching a video that has entered or completed processing) without inventing a new enum value or custom check. Option B pays a real cost (a client-visible capability regression) for no corresponding savings, since the library already does the hard part.

**Decision:** A (Support termination for in-progress uploads only via `disableTerminationForFinishedUploads: true`; `S3Store`'s default `remove(id)` for storage cleanup; `POST_TERMINATE` event hard-deletes the `Video` draft row)

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Object Storage Backend | MinIO | A (MinIO / S3-compatible) |
| TD-02 | Backend | Video Delivery — Signed URL Strategy | Presigned URLs | A (Presigned GET URLs, short-lived) |
| TD-03 | Backend | Background Job Queue & Worker Process Model | BullMQ + Redis | A (BullMQ + Redis, worker NestJS standalone) |
| TD-04 | Backend | Video Processing & Thumbnail Extraction Toolchain | Vendored, digest-pinned FFmpeg/FFprobe build | C (Vendored, digest/checksum-pinned build; worker image only) |
| TD-05 | Backend | Large File Upload Ingestion Strategy | tus (`@tus/server` + `@tus/s3-store`) | A (tus via `@tus/server` + `@tus/s3-store`) |
| TD-06 | Backend | Video Lifecycle / State Model | Two orthogonal enum columns | B (`processingStatus` / `publicationStatus` orthogonal lifecycles) |
| TD-07 | Backend | Worker Temporary Storage Strategy | Full download + guard-rails | A (Full download; `finally` cleanup; orphan sweep; free-space preflight; concurrency=1 default) |
| TD-08 | Backend | Unique Video Identifier / URL Strategy | UUID v4 as PK | A (UUID v4 as PK) |
| TD-09 | Backend | Accepted Video Format / Container / Codec Validation | MP4 / H.264 / AAC-or-silent narrow allowlist | A (MP4 / H.264 / AAC-or-silent narrow allowlist) |
| TD-10 | Backend | Job Failure Classification, Final-FAILED Transition, and Worker Idempotency | Explicit `PROCESSING` write on pickup + safe no-op if already `READY` (extended by revision to also cover `FAILED`, terminal); native BullMQ primitives (`UnrecoverableError` + `@OnWorkerEvent('failed')` with explicit in-handler finality check, fired after `moveToFailed()` resolves) + idempotent-by-construction; reconciliation may repair a terminally-confirmed `PROCESSING`/BullMQ-`failed` divergence via the same write function (revision) | A (Explicit `PROCESSING`/no-op (READY + FAILED) + native BullMQ primitives, explicit `isFinal` check + idempotent-by-construction + terminal-divergence reconciliation) |
| TD-11 | Backend | tus Upload Correlation with Video Entity, and Enqueue-Failure Recovery | Bare-UUID `namingFunction` (tus id = S3 key = `Video.id`); durable `uploadCompletedAt` + reconciliation sweep (extended by revision with a storage-anchored `HeadObjectCommand` branch for when the `uploadCompletedAt` write itself fails); `onIncomingRequest` auth on every tus request; deterministic `jobId` shared by every producer | A (Bare-UUID correlation; durable recovery sweep + storage-anchored fallback; `onIncomingRequest` auth boundary; deterministic `jobId`) |
| TD-12 | Backend | Video Metadata Persistence Schema | `width`, `height`, `videoCodec`, `audioCodec`, `bitRate` columns from existing FFprobe parse | A (`width`, `height`, `videoCodec`, `audioCodec`, `bitRate`) |
| TD-13 | Backend | tus Termination (`DELETE`) Semantics | Support termination for in-progress uploads only (`disableTerminationForFinishedUploads: true`); `S3Store.remove(id)` for storage cleanup; `POST_TERMINATE` hard-deletes the `Video` draft row | A (Support termination, in-progress only; storage cleanup via `S3Store`; hard-delete draft on `POST_TERMINATE`) |
