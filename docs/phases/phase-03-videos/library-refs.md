---
libs:
  "@aws-sdk/client-s3":
    version: "^3.700.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-09-22T08:58:56-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.700.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-09-22T08:58:56-03:00"
  "@nestjs/bullmq":
    version: "^11.0.0"
    context7_id: "/nestjs/bull"
    fetched_at: "2026-09-22T08:58:56-03:00"
  "bullmq":
    version: "^5.0.0"
    context7_id: "/taskforcesh/bullmq"
    fetched_at: "2026-09-22T08:58:56-03:00"
  "ioredis":
    version: "^5.4.0"
    context7_id: "/redis/ioredis"
    fetched_at: "2026-09-22T08:58:56-03:00"
  "@tus/server":
    version: "^1.0.0"
    context7_id: "/tus/tus-node-server"
    fetched_at: "2026-09-22T08:58:56-03:00"
  "@tus/s3-store":
    version: "^1.0.0"
    context7_id: "/tus/tus-node-server"
    fetched_at: "2026-09-22T08:58:56-03:00"
sources_mtime:
  docs/decisions/technical-decisions-upload-processing.md: "2026-09-22T08:56:59-03:00"
---

# Library Reference — phase-03-upload-processing

Version constraints above are targets, not confirmed-installed — none of these packages exist in `nestjs-project/package.json` yet (Phase 03 has not been implemented). `npm install` at `/implement` time will resolve exact patch versions; re-run `/plan-resolve upload-processing` afterward if a materially different major/minor version lands, so this cache stays accurate.

### @aws-sdk/client-s3 (upload-processing/TD-01)

Used for the `S3Client` pointed at MinIO (S3-compatible), per TD-01's decision to run MinIO locally via Docker Compose.

**Custom endpoint for S3-compatible storage (MinIO)** — the decisive config for TD-01, since MinIO is not the default AWS endpoint:

```typescript
const client = new S3Client({
  endpoint: "http://minio:9000",   // Docker Compose service name, per root CLAUDE.md § Docker Networking — never localhost
  forcePathStyle: true,             // required for MinIO / most S3-compatible providers
  region: "us-east-1",              // MinIO ignores region but the SDK requires a value
  credentials: {
    accessKeyId: process.env.STORAGE_ACCESS_KEY_ID,
    secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY,
  },
});
```

**Tree-shaking-compatible usage** (import only the client + commands needed):

```typescript
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

const s3Client = new S3Client({ /* ...config above... */ });
await s3Client.send(new GetObjectCommand({ Bucket: "videos", Key: `videos/${id}/source` }));
```

Note (v2→v3 API rename, relevant since some blog posts/StackOverflow answers still use v2 naming): `s3ForcePathStyle` (v2) was renamed to `forcePathStyle` (v3, the installed major).

### @aws-sdk/s3-request-presigner (upload-processing/TD-02)

Used for `VideoDeliveryService.getStreamUrl` / `.getDownloadUrl`, per TD-02's presigned-GET-URL decision.

**Core pattern — presigned GET URL with expiry:**

```typescript
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";

const client = new S3Client(clientParams);
const command = new GetObjectCommand({ Bucket: "videos", Key: sourceStorageKey });
const url = await getSignedUrl(client, command, { expiresIn: 3600 }); // seconds; defaults to 900 if omitted
```

**Download variant — forces `Content-Disposition: attachment`**, exactly the field TD-02's Recommendation cites:

```typescript
const downloadCommand = new GetObjectCommand({
  Bucket: "videos",
  Key: sourceStorageKey,
  ResponseContentDisposition: "attachment",
});
const downloadUrl = await getSignedUrl(client, downloadCommand, { expiresIn: 3600 });
```

`ResponseContentDisposition` (along with `ResponseContentType`, `ResponseCacheControl`, `ResponseExpires`) is a first-class field on `GetObjectRequest` — confirmed present in the installed major, not a workaround.

### @nestjs/bullmq (upload-processing/TD-03)

NestJS's official BullMQ integration module — confirmed current API for queue registration and worker processors.

**Queue registration:**

```typescript
@Module({
  imports: [
    BullModule.forRootAsync({ /* connection config — see ioredis below for maxRetriesPerRequest */ }),
    BullModule.registerQueue({ name: 'video-processing' }),
  ],
})
export class QueueModule {}
```

**Worker processor — `@Processor` + `WorkerHost`, exactly the pattern TD-03's Recommendation cites:**

```typescript
import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Job } from 'bullmq';

@Processor('video-processing')
export class VideoProcessingProcessor extends WorkerHost {
  async process(job: Job<{ videoId: string }>) {
    // TD-07 → TD-09 → TD-04 sequence goes here
  }

  @OnWorkerEvent('error')
  onWorkerError(error: Error) {
    // observability hook
  }
}
```

The class **must** extend `WorkerHost` and implement `process()` — confirmed abstract-class contract, not an interface (TypeScript will refuse to compile a `@Processor`-decorated class that doesn't extend `WorkerHost`).

### bullmq (upload-processing/TD-03)

Underlying queue library `@nestjs/bullmq` wraps. Directly relevant: retry/backoff configuration cited in TD-03's Recommendation ("built-in retries/backoff/concurrency").

**Per-job retry + exponential backoff:**

```typescript
await queue.add(
  'video-processing',
  { videoId },
  { attempts: 3, backoff: { type: 'exponential', delay: 1000 } },
);
```

**Queue-level default (applies to every job added without its own override):**

```typescript
const myQueue = new Queue('video-processing', {
  defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 1000 } },
});
```

**Concurrency** (per TD-07's "concurrency default 1, configurable"): the `Worker`'s `concurrency` option/setter validates `concurrency >= 1` at runtime (throws for 0, negative, or non-finite values) — confirms `concurrency: 1` is a legal, supported floor value, not an edge case the library special-cases away.

### ioredis (upload-processing/TD-03)

Redis client BullMQ requires. TD-03's Recommendation explicitly flags one non-obvious setting.

**`maxRetriesPerRequest: null` — the exact setting TD-03's Recommendation cites as required:**

> "Set this option to `null` instead of a number to let commands wait forever until the connection is alive again (which is the default behavior before ioredis v4)." — default since v4 is `20` (commands are flushed with an error after 20 retry attempts); BullMQ's blocking queue commands cannot tolerate that flush, so this project's Redis connection config must override it to `null`.

```typescript
const connection = new Redis({
  host: 'redis', // Docker Compose service name
  maxRetriesPerRequest: null,
});
```

### @tus/server (upload-processing/TD-05, TD-09)

Confirmed current `ServerOptions` shape — this is the canonical field-name source for TD-09's hook-based validation design (`onUploadCreate` preliminary check, `onUploadFinish` enqueue-only).

**Express mount (project uses Express platform per NestJS default):**

```typescript
import { Server } from "@tus/server";

const server = new Server({ path: "/videos/upload", datastore: s3Store, maxSize: 10 * 1024 * 1024 * 1024 /* 10GB, TD-05 */ });
uploadApp.all("*", server.handle.bind(server));
```

**`onUploadCreate`** — confirmed signature `(req, upload) => Promise<{ metadata?: Record<string, string> }>`; throwing aborts the request with the thrown object's `status_code`/`body`. This is the exact mechanism TD-09 uses for the preliminary `filetype` rejection (415 UNSUPPORTED_VIDEO_FORMAT).

**`onUploadFinish`** — confirmed signature `(req, upload) => Promise<{ status_code?; headers?; body? }>`; fires after upload completion, before the response is sent back. This is the exact hook TD-05/TD-09's design uses to enqueue the `video.processing` job — it does **not** run any validation itself (per TD-09's decision that authoritative validation happens in the worker, not here).

**`maxSize`** — confirmed to accept a plain `number` (bytes) — the mechanism TD-05 uses for the 10GB ceiling, enforced at the protocol level before the server accepts bytes beyond the limit.

**Locker default** — confirmed current default is `new MemoryLocker()` when `options.locker` is omitted, matching TD-05's Recommendation note ("`@tus/server` defaults to an in-memory `MemoryLocker`... a `RedisLocker` is the documented upgrade path").

### @tus/s3-store (upload-processing/TD-05)

**S3Store constructor, targeting MinIO per TD-01:**

```typescript
import { S3Store } from "@tus/s3-store";

const s3Store = new S3Store({
  partSize: 8 * 1024 * 1024, // 8MiB per part; must be ≥5MiB per S3 multipart rules
  s3ClientConfig: {
    bucket: "videos",
    region: "us-east-1",
    endpoint: "http://minio:9000",       // per TD-01, Docker Compose service name
    forcePathStyle: true,                 // per TD-01, required for MinIO
    credentials: { accessKeyId: process.env.STORAGE_ACCESS_KEY_ID, secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY },
  },
});
```

`s3ClientConfig` is confirmed to accept the full `S3ClientConfig` shape (same type `@aws-sdk/client-s3` itself uses) plus a required `bucket` field — so the same `endpoint`/`forcePathStyle` pattern from TD-01's `S3Client` config applies here unchanged, no separate MinIO-specific option needed.

**`cache` option** — confirmed relevant for future horizontal-scaling: defaults to an in-memory `MemoryKvStore`; a shared `RedisKvStore` (exported from `@tus/server`) is documented as the multi-instance upgrade path — same upgrade shape as the `MemoryLocker`→`RedisLocker` note above. Not needed for this phase (API runs as a single instance per TD-05's Recommendation), documented here only for traceability if that assumption changes.
