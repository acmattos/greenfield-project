---
subproject: backend
runner: jest+supertest
scope: phase-03-upload-processing
si: SI-03.6
target_file: nestjs-project/test/videos.e2e-spec.ts
---

# Video Delivery (Streaming & Download) Test Plan

Covers the two read-only delivery endpoints that redirect to a short-lived presigned URL for a video's source object: streaming (`GET /videos/:id/stream`) and download (`GET /videos/:id/download`, with `Content-Disposition: attachment`). Both gate on `processingStatus: READY` and are reachable anonymously once ready, per the project's "Anonymous users can watch freely" stance.

## Test Scenarios

### 1. GET /videos/:id/stream

**Setup:** `beforeEach` truncates the test DB and bootstraps the Nest test module (`Test.createTestingModule({ imports: [AppModule] }).compile()`), applying the same global `ValidationPipe` / exception filters `main.ts` configures (per testing-guide-nestjs-project § gotchas — `Test.createTestingModule()` does not run `main.ts`). Each scenario seeds its own `Video` row (and `Channel`/`User` when ownership matters) with the `processingStatus` the scenario needs.

#### 1.1. stream-video-ready-redirects-anonymously

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-09-22T12:14:55Z

**Steps:**
  1. Seed a `Video` with `processingStatus: 'READY'` and a real `sourceStorageKey`.
    - (setup, no request yet)
  2. API-caller sends `GET /videos/:id/stream` with no `Authorization` header (anonymous).
    - expect: response status `302`
    - expect: `Location` header is a presigned URL pointing at the video's `sourceStorageKey`

#### 1.2. stream-video-not-ready-returns-409

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-09-22T21:06:29Z

**Steps:**
  1. Parametrized over `processingStatus` ∈ {`UPLOADING`, `PROCESSING`, `FAILED`} — for each value, as a separate case:
    a. Seed a `Video` with that `processingStatus`.
      - (setup, no request yet)
    b. API-caller sends `GET /videos/:id/stream`.
      - expect: response status `409`
      - expect: response body `{ statusCode: 409, error: "VIDEO_NOT_READY", message: ... }`

#### 1.3. stream-video-not-found-returns-404

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-09-22T21:06:29Z

**Steps:**
  1. API-caller sends `GET /videos/:id/stream` with a syntactically valid UUID (e.g. freshly generated via `uuidv4()`) that does not correspond to any row in the `Video` table — isolates the `VIDEO_NOT_FOUND` rule specifically, as opposed to a malformed-id rejection (which is a separate DTO-validation concern, not covered by this scenario).
    - expect: response status `404`
    - expect: response body `{ statusCode: 404, error: "VIDEO_NOT_FOUND", message: ... }`

### 2. GET /videos/:id/download

**Setup:** same as Group 1.

#### 2.1. download-video-ready-redirects-with-attachment-disposition

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-09-22T12:14:55Z

**Steps:**
  1. Seed a `Video` with `processingStatus: 'READY'` and a real `sourceStorageKey`.
    - (setup, no request yet)
  2. API-caller sends `GET /videos/:id/download`.
    - expect: response status `302`
    - expect: `Location` header's querystring contains `response-content-disposition=attachment`

#### 2.2. download-video-not-ready-returns-409

**Covers AC:** #2 _(symmetric coverage — `VideosController.download` throws the same `VideoNotReadyException` as `stream`, per SI-03.6 Technical actions 3-4; AC #2's literal wording names only `stream`, but the check applies identically to `download`)_
**Source:** auto
**Last sync:** 2026-09-22T21:06:29Z

**Steps:**
  1. Parametrized over `processingStatus` ∈ {`UPLOADING`, `PROCESSING`, `FAILED`} — for each value, as a separate case:
    a. Seed a `Video` with that `processingStatus`.
      - (setup, no request yet)
    b. API-caller sends `GET /videos/:id/download`.
      - expect: response status `409`
      - expect: response body `{ statusCode: 409, error: "VIDEO_NOT_READY", message: ... }`

#### 2.3. download-video-not-found-returns-404

**Covers AC:** #3 _(symmetric coverage — same rationale as 2.2, for `VideoNotFoundException`)_
**Source:** auto
**Last sync:** 2026-09-22T21:06:29Z

**Steps:**
  1. API-caller sends `GET /videos/:id/download` with a syntactically valid UUID (e.g. freshly generated via `uuidv4()`) that does not correspond to any row in the `Video` table.
    - expect: response status `404`
    - expect: response body `{ statusCode: 404, error: "VIDEO_NOT_FOUND", message: ... }`
