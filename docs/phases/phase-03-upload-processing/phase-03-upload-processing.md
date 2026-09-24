---
kind: phase
name: phase-03-upload-processing
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-upload-processing/context.md: "2026-09-22T16:55:58-03:00"
  docs/phases/phase-03-upload-processing/library-refs.md: "2026-09-22T09:05:05-03:00"
  docs/decisions/technical-decisions-upload-processing.md: "2026-09-22T16:03:07-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-09-15T18:40:16-03:00"
  docs/phases/phase-01-configuracao-base/context.md: "2026-09-15T18:40:16-03:00"
  docs/phases/phase-02-auth/context.md: "2026-09-15T18:40:16-03:00"
  docs/phases/phase-02-auth-frontend/context.md: "2026-09-15T18:40:16-03:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-09-15T18:40:15-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Deliver the backend foundation for video upload and processing in `nestjs-project/`: resumable large-file upload ingestion (up to 10GB) with automatic draft pre-registration on the uploader's channel, a background job queue and worker that extracts video metadata and generates a thumbnail via FFmpeg after upload completes — with an explicit `PROCESSING` transition, idempotent-by-construction retries, a single reliable `FAILED` transition (durably repaired by reconciliation when the live write is lost to a crash), scoped upload termination, and durable server-side recovery from enqueue failures — format/codec validation so only browser-playable content is accepted, and signed-URL delivery for streaming and download — yielding a functional 10GB upload, automatic processing, working streaming, and unique per-video URLs.

---

## Step Implementations

### SI-03.1 — Infra: configurar object storage (MinIO) e cliente S3 (endpoint interno + público)

**Description:** Provisiona o serviço MinIO no Docker Compose e configura os clientes S3 usados por toda a fase — endpoint interno (Compose) para I/O de API/worker, endpoint público para URLs presigned entregues ao navegador.

**Technical actions:**

1. Adicionar serviço `minio` ao `compose.yaml`, com volume persistente e healthcheck (per `upload-processing/TD-01`)
2. Instalar `@aws-sdk/client-s3` no `nestjs-project/` (per `upload-processing/TD-01`; ver `library-refs.md` para o pattern de endpoint custom + `forcePathStyle`)
3. Criar `src/config/storage.config.ts` via `registerAs('storage', ...)` seguindo o padrão herdado de config namespaced (`@nestjs/config`)
4. Adicionar ao `env.validation.ts` (Joi schema herdado, per `phase-01-configuracao-base/TD-02`): `STORAGE_ENDPOINT` (interno, ex. `http://minio:9000`), `STORAGE_PUBLIC_ENDPOINT` (obrigatório, **sem default** — nunca cai silenciosamente em `localhost`), `STORAGE_REGION` (obrigatório — o AWS SDK v3/`S3Store` exigem `region` mesmo contra MinIO, confirmado em `library-refs.md § @aws-sdk/client-s3`), `STORAGE_PRESIGNED_URL_TTL_SECONDS` (inteiro positivo), bucket e credenciais
5. Prover o `S3Client` **interno** via um provider token explícito (`INTERNAL_S3_CLIENT`) no `StorageModule` — endpoint = `STORAGE_ENDPOINT`, `forcePathStyle: true`, `region: STORAGE_REGION` — usado exclusivamente por bootstrap/tus/worker; nunca injetado onde o client público (SI-03.5) é esperado

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageModule` | Unit: compilation test (DI wiring) | `storage.module.spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- `docker compose up -d minio` sobe o serviço e o healthcheck reporta saudável
- `StorageModule` compila e resolve `INTERNAL_S3_CLIENT` via DI sem erros de wiring
- `env.validation.ts` valida `STORAGE_ENDPOINT` e `STORAGE_PUBLIC_ENDPOINT` como duas chaves distintas e obrigatórias

---

### SI-03.2 — Infra: bootstrap idempotente do bucket MinIO (seguro contra concorrência)

**Description:** Garante que o bucket alvo exista antes de qualquer leitura/escrita, de forma segura tanto num ambiente novo quanto num já inicializado, e tolerante a inicializações concorrentes de API e worker (per `upload-processing/TD-01`, Revisão 2026-09-22).

**Technical actions:**

1. Implementar bootstrap idempotente do bucket — checar existência via `HeadBucketCommand`; se ausente, criar via `CreateBucketCommand` (per `upload-processing/TD-01`)
2. Tratar a corrida entre `HeadBucketCommand` e `CreateBucketCommand`: como API e worker podem inicializar simultaneamente, ambos podem observar ausência e tentar criar — capturar o erro de `CreateBucketCommand` indicando que o bucket já existe/já é seu (`BucketAlreadyOwnedByYou` ou equivalente do provedor S3-compatible) e tratá-lo como sucesso, nunca relançar (per `upload-processing/TD-01`)
3. Rodar o bootstrap no `OnModuleInit` do `StorageModule`, antes de qualquer outra rotina desta fase ler/escrever no bucket (per `upload-processing/TD-01`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| Bucket bootstrap | Integration: roda contra MinIO real — cria o bucket quando ausente e não falha quando já existe | `storage-bucket-bootstrap.integration-spec.ts` |
| Bootstrap concorrente | Integration: duas inicializações do bootstrap disparadas simultaneamente contra o mesmo MinIO vazio — nenhuma das duas lança erro, e o bucket existe ao final | `storage-bucket-bootstrap-concurrent.integration-spec.ts` |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- Rodar o bootstrap contra um MinIO recém-provisionado (sem o bucket) cria o bucket com sucesso
- Rodar o bootstrap uma segunda vez contra o mesmo MinIO (bucket já existe) não lança erro
- Disparar o bootstrap simultaneamente a partir de dois processos (ex.: API e worker) contra o mesmo MinIO vazio não lança erro em nenhum dos dois, e o bucket existe ao final
- Nenhuma outra rotina desta fase lê ou escreve no bucket antes do bootstrap rodar

---

### SI-03.3 — Entidade Video + migration

**Description:** Cria a entidade `Video` vinculada ao `Channel` proprietário, com os campos de lifecycle (TD-06), a PK UUID (TD-08), a correlação bare-UUID de `sourceStorageKey` (TD-11) e os campos de metadata (TD-12).

**Technical actions:**

1. Criar `src/videos/entities/video.entity.ts` com os campos `id`, `channelId`, `title`, `processingStatus`, `publicationStatus`, `sourceStorageKey`, `thumbnailStorageKey`, `uploadCompletedAt`, `durationSeconds`, `width`, `height`, `videoCodec`, `audioCodec`, `bitRate`, `createdAt`, `updatedAt` (per `### Data Model`) — `channelId` referencia `Channel.id` (`nestjs-project/src/channels/entities/channel.entity.ts`), não `User` diretamente
2. Gerar migration via `npm run migration:generate` (per Inherited Conventions — `synchronize: false`)
3. Registrar `Video` em `TypeOrmModule.forFeature([Video])` dentro do `VideosModule`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: constraints, defaults (`processingStatus` default `UPLOADING`, `publicationStatus` default `DRAFT`, FK `channelId` obrigatória, `title` NOT NULL, `uploadCompletedAt`/metadata fields nullable) | `video.entity.integration-spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- Inserir um `Video` sem especificar `processingStatus`/`publicationStatus` persiste com os defaults `UPLOADING`/`DRAFT`
- Inserir um `Video` sem `channelId` viola a constraint FK not-null
- Inserir um `Video` sem `title` viola a constraint not-null
- Inserir um `Video` sem especificar `uploadCompletedAt` persiste com o valor `null`
- A migration roda limpo (`npm run migration:run`) contra o banco vazio

---

### SI-03.4 — Infra: Redis + módulo de fila BullMQ (producer com fail-fast, consumer resiliente, retenção)

**Description:** Provisiona Redis no Compose e configura o módulo BullMQ **do lado da API** — apenas produtor (`Queue`), com conexão fail-fast — deixando o consumidor (`Worker`) para SI-03.11, com sua própria conexão resiliente.

**Technical actions:**

1. Adicionar serviço `redis` ao `compose.yaml` com `command: redis-server --maxmemory-policy noeviction` (requisito operacional documentado do BullMQ) e healthcheck (per `upload-processing/TD-03`)
2. Instalar `@nestjs/bullmq`, `bullmq`, `ioredis` no `nestjs-project/` (per `upload-processing/TD-03`; ver `library-refs.md` para os três)
3. Criar `src/config/queue.config.ts` via `registerAs('queue', ...)` — validar `REDIS_HOST`/`REDIS_PORT` via Joi; expor **duas** configs de conexão distintas: a do **producer** (API, usada aqui) com `enableOfflineQueue: false` + `maxRetriesPerRequest` baixo (ex. `1`) para falhar rápido quando o Redis estiver indisponível; a do **consumer** (worker, `maxRetriesPerRequest: null`) fica documentada aqui mas só é instanciada em SI-03.11
4. Registrar `BullModule.forRootAsync` (conexão producer) + `BullModule.registerQueue({ name: 'video-processing', defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 1000 }, removeOnComplete: { age: 3600, count: 1000 }, removeOnFail: { age: 604800, count: 5000 } } })` no `QueueModule` da API — **sem** instanciar nenhum `Worker` aqui (per `upload-processing/TD-03`, `TD-10`, `TD-11`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `QueueModule` | Unit: compilation test (DI wiring) | `queue.module.spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- `docker compose up -d redis` sobe o serviço com `maxmemory-policy` reportado como `noeviction` e o healthcheck reporta saudável
- `QueueModule` compila e resolve a fila `video-processing` via DI sem erros de wiring, usando a conexão producer (fail-fast)
- A fila `video-processing` é registrada com `defaultJobOptions.attempts: 3`, backoff exponencial, e políticas de retenção `removeOnComplete`/`removeOnFail` explícitas
- Um `queue.add()` disparado com o Redis indisponível rejeita rapidamente (não fica pendurado aguardando reconexão)

---

### SI-03.5 — Serviço de entrega: URLs assinadas para streaming/download (endpoint público, Content-Type correto)

**Description:** Serviço que emite URLs presigned de leitura para o objeto de vídeo contra o endpoint **público** do storage — via um client S3 distinto do interno, com token de DI próprio — com TTL explícito, `Content-Type: video/mp4` garantido, `ResponseContentDisposition` para download, e cobertura real via GET.

**Technical actions:**

1. Instalar `@aws-sdk/s3-request-presigner` (per `upload-processing/TD-02`; ver `library-refs.md` para o pattern `getSignedUrl` + `expiresIn`)
2. Prover um segundo `S3Client`, sob o provider token explícito `PUBLIC_S3_CLIENT` (endpoint = `STORAGE_PUBLIC_ENDPOINT`, `region: STORAGE_REGION`) — nunca o mesmo client de SI-03.1 — injetado exclusivamente em `VideoDeliveryService`
3. Criar `VideoDeliveryService.getStreamUrl(videoId)` e `.getDownloadUrl(videoId)` usando `getSignedUrl` sobre `GetObjectCommand` com `ResponseContentType: 'video/mp4'` e `expiresIn: STORAGE_PRESIGNED_URL_TTL_SECONDS`, lendo `sourceStorageKey` do `Video` correspondente (per `upload-processing/TD-02`, `TD-01`, `TD-08`)
4. `getDownloadUrl` adicionalmente seta `ResponseContentDisposition: 'attachment'` no `GetObjectCommand` (per `upload-processing/TD-02`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoDeliveryService` — forma/config da URL | Integration: real `PUBLIC_S3_CLIENT` contra MinIO de teste — asserta forma e expiração da URL presigned | `video-delivery.service.integration-spec.ts` |
| Endpoint público vs. interno — separação de config | Unit: com `STORAGE_PUBLIC_ENDPOINT` configurado para um valor distinto de `STORAGE_ENDPOINT`, a URL presigned resultante usa o hostname público — sem rede real | `video-delivery.service.spec.ts` |
| Download real via GET | Integration: `GET` real pela URL presigned de download, confirma `Content-Disposition: attachment` e `Content-Type: video/mp4` nos headers da resposta real | `video-delivery-download.integration-spec.ts` |
| Suporte real a `Range`/`206` | Integration: objeto de teste com mais de 100 bytes; `GET` real com header `Range: bytes=0-99`, asserta `206`, `Content-Range` correto e exatamente 100 bytes retornados | `video-delivery-range.integration-spec.ts` |

**Dependencies:** SI-03.1 — precisa do endpoint/região configurados; SI-03.2 — precisa do bucket já existir; SI-03.3 — precisa do campo `sourceStorageKey`

**Acceptance criteria:**

- `getStreamUrl`/`getDownloadUrl` retornam uma URL presigned válida que expira em `STORAGE_PRESIGNED_URL_TTL_SECONDS`
- A URL presigned usa o host configurado em `STORAGE_PUBLIC_ENDPOINT`, nunca o endpoint interno
- Um `GET` real pela URL de download retorna `Content-Disposition: attachment` e `Content-Type: video/mp4` nos headers reais da resposta
- Um `GET` real com `Range: bytes=0-99` contra um objeto de teste com mais de 100 bytes retorna `206` com `Content-Range` correto e exatamente 100 bytes

---

### SI-03.6 — Endpoints de streaming e download

**Description:** Controller que expõe os endpoints de streaming e download, redirecionando para a URL presigned, com o gate de prontidão.

**Route:** GET /videos/:id/stream, GET /videos/:id/download

**Test Specs:** see `nestjs-project/specs/video-delivery.plan.md`

**Technical actions:**

1. Criar `VideosController.stream(id)` → `GET /videos/:id/stream` → `302` para a URL do `VideoDeliveryService` (per `### API Contracts`)
2. Criar `VideosController.download(id)` → `GET /videos/:id/download` → `302` para a URL de download (per `### API Contracts`)
3. Lançar `VideoNotFoundException` (404 `VIDEO_NOT_FOUND`) quando o `id` não existe (per `### Error Catalog`)
4. Lançar `VideoNotReadyException` (409 `VIDEO_NOT_READY`) quando `processingStatus !== 'READY'` (per `upload-processing/TD-06`, `### Error Catalog`)

**Tests:** _(empty — controller wiring; E2E authored externally via /plan-test-specs per **Test Specs:** above; controllers receive no inline Unit tests per testing-guide-nestjs-project § Controllers)_

**Dependencies:** SI-03.3 (entidade Video) + SI-03.5 (serviço de entrega)

**Acceptance criteria:**

- `GET /videos/:id/stream` com vídeo `READY` retorna `302` para a URL presigned (per `### Authorization Matrix` — acesso anônimo permitido)
- `GET /videos/:id/stream` com vídeo em qualquer outro `processingStatus` retorna `409` com `error: "VIDEO_NOT_READY"`
- `GET /videos/:id/stream` com `id` inexistente retorna `404` com `error: "VIDEO_NOT_FOUND"`
- `GET /videos/:id/download` com vídeo `READY` retorna `302` para uma URL com disposição de anexo

---

### SI-03.7 — Módulo de upload: mount tus + criação de rascunho (bare UUID) + resumabilidade real após falha

**Description:** Monta o servidor tus (`partSize` explícito), cria o rascunho do `Video` no canal do usuário autenticado ao iniciar o upload, com `namingFunction` gerando um UUID v4 puro reutilizado como tus id / S3 key / `Video.id`, aplica a checagem preliminar de formato com o envelope de erro textual do projeto, garante `title` sempre válido, valida a existência do `Channel` do usuário, e comprova resumabilidade real após uma falha de conexão simulada e o boundary exato de 10GB.

**Technical actions:**

1. Instalar `@tus/server` + `@tus/s3-store` (per `upload-processing/TD-05`; ver `library-refs.md` para `ServerOptions` e `S3Store` confirmados)
2. Montar `Server({ path: '/videos/upload', datastore: new S3Store({ s3ClientConfig: {...}, bucket, partSize: 8 * 1024 * 1024, maxMultipartParts: 10_000 }), namingFunction, maxSize: MAX_UPLOAD_BYTES, disableTerminationForFinishedUploads: true })` como sub-app Express dentro do `nestjs-project/`; `namingFunction` gera um UUID v4 e retorna-o **puro** (sem prefixo/sufixo de path) — per `upload-processing/TD-11`, esse mesmo valor vira o tus id, a S3 key e o `Video.id`; `disableTerminationForFinishedUploads: true` é a configuração base para a termination scope-guard implementada em SI-03.19 (per `upload-processing/TD-13`); `partSize` explícito em 8MiB evita depender do cálculo implícito do servidor
3. Implementar `onUploadCreate`: (a) ler `upload.metadata.filetype`; se presente e diferente de `video/mp4`, `throw { status_code: 415, body: JSON.stringify({ statusCode: 415, error: 'UNSUPPORTED_VIDEO_FORMAT', message: 'Unsupported video format' }) }` — `body` é sempre uma **string** JSON, nunca um objeto aninhado; (b) verificar que o usuário autenticado possui `Channel` — se não, logar o erro e `throw { status_code: 500, body: JSON.stringify({ statusCode: 500, error: 'ACCOUNT_INCOMPLETE', message: 'Something went wrong' }) }` sem detalhar a causa ao cliente (per `upload-processing/TD-09`, `TD-11`)
4. `onUploadCreate` também cria o rascunho `Video` — lê de volta o UUID gerado por `namingFunction` (não regenera) e usa como `id`/`sourceStorageKey`; `channelId` do canal do usuário autenticado; `title` via fallback determinístico `Upload-Metadata.title` → `Upload-Metadata.filename` → literal `'Untitled video'` — o valor resolvido é `trim()`-ado e truncado para 255 caracteres se ainda exceder o limite da coluna; `processingStatus: 'UPLOADING'`, `publicationStatus: 'DRAFT'` (per `upload-processing/TD-06`, `TD-11`)
5. Configurar `maxSize` do servidor tus para `MAX_UPLOAD_BYTES` (Joi-validado, default lógico `10737418240` = 10GB exatos) (per `upload-processing/TD-05`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `onUploadCreate` handler | Unit: branch logic (`filetype` presente/ausente/inválido → throw com envelope correto ou não; usuário sem `Channel` → 500 `ACCOUNT_INCOMPLETE`; `title` fallback + trim + truncagem) | `tus-hooks.spec.ts` |
| tus mount + criação de rascunho | Integration: cria `Video` real no banco, com `sourceStorageKey` idêntico ao `id`, vinculado ao `channelId` correto | `tus-upload.integration-spec.ts` |
| Resumabilidade real após falha de conexão | Integration: `POST` (cria upload) → `PATCH` é iniciado e a conexão é destruída no meio do stream → `HEAD` retorna o `Upload-Offset` real persistido, usado como **única fonte de verdade** para onde retomar → `PATCH` retoma exatamente a partir desse `Upload-Offset` → objeto final completo e byte-idêntico ao arquivo original | `tus-resumability.integration-spec.ts` |
| Boundary exato de `maxSize` (10GB) | Integration: `POST` com `Upload-Length: 10737418240` retorna `201` sem transferir bytes; `POST` com `10737418241` retorna `413` | `tus-upload.integration-spec.ts` |

**Dependencies:** SI-03.1 (storage/S3Store) + SI-03.2 (bucket já existe) + SI-03.3 (entidade Video)

**Acceptance criteria:**

- Iniciar upload com `Upload-Metadata.filetype=video/mp4` retorna `201` e cria um `Video` com `processingStatus: 'UPLOADING'` vinculado ao `channelId` do usuário autenticado
- O `Video` criado tem `sourceStorageKey` idêntico, byte a byte, ao seu próprio `id`
- Iniciar upload com `filetype` presente e diferente de `video/mp4` retorna `415` com corpo `{ statusCode: 415, error: "UNSUPPORTED_VIDEO_FORMAT", message: ... }` e nenhum `Video` é criado
- Iniciar upload sem `filetype` declarado prossegue
- Iniciar upload sem `Upload-Metadata.title` nem `Upload-Metadata.filename` ainda cria um `Video` com `title` não-nulo (fallback `'Untitled video'`)
- Um `POST` de criação com `Upload-Length` exatamente igual a `10737418240` (10GB) é aceito com `201`, sem necessidade de transferir nenhum byte
- Um `POST` de criação com `Upload-Length` de `10737418241` é rejeitado pelo protocolo tus
- Uma sequência `POST` → `PATCH` com a conexão destruída no meio do envio → `HEAD` → `PATCH` retomando exatamente do offset confirmado pelo `HEAD` resulta em um objeto no storage idêntico byte a byte ao arquivo original

---

### SI-03.8 — Boundary de autenticação em todos os requests tus (onIncomingRequest)

**Description:** Autentica e autoriza todo request tus não-`OPTIONS` (create, chunks, offset probe, cancelamento) — não apenas a criação — fechando o gap em que só `onUploadCreate` era protegido, com o mesmo envelope de erro consistente do projeto.

**Technical actions:**

1. Implementar `onIncomingRequest` reutilizando a mesma lógica de verificação de JWT do resto da API, adaptada para rodar fora do pipeline de guards do Nest; **pular a checagem inteiramente quando `req.method === 'OPTIONS'`**; caso contrário, se ausente/inválido, `throw { status_code: 401, body: JSON.stringify({ statusCode: 401, error: 'UNAUTHENTICATED', message: 'Authentication required' }) }` (per `upload-processing/TD-11`)
2. Para requests cujo `uploadId` já é conhecido (`PATCH`/`HEAD`/`DELETE`): primeiro validar que `uploadId` é um UUID sintaticamente válido — se não for, tratar como não encontrado (`404`) sem consultar o banco; caso seja válido, buscar o `Video` correlacionado por `id === uploadId` e verificar que `channelId` pertence ao usuário autenticado; caso contrário, `throw { status_code: 403, body: JSON.stringify({ statusCode: 403, error: 'FORBIDDEN', message: 'Not the owner of this upload' }) }` (per `upload-processing/TD-11`)
3. Registrar `onIncomingRequest` em `ServerOptions` junto de `namingFunction`/`onUploadCreate` (per `upload-processing/TD-11`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `onIncomingRequest` handler | Unit: branch logic (`OPTIONS` sem token → passa; sem token em método não-`OPTIONS` → 401; `uploadId` malformado → 404 sem query; token de outro dono → 403; token válido do dono → passa) | `tus-hooks.spec.ts` |
| Boundary de auth tus | Integration: `PATCH`/`HEAD`/`DELETE` reais contra um upload existente com token ausente/inválido/de outro usuário; `JSON.parse(body)` confirma `{ statusCode, error, message }`; `OPTIONS` real sem token não é bloqueado | `tus-auth-boundary.integration-spec.ts` |

**Dependencies:** SI-03.7 (mount tus)

**Acceptance criteria:**

- `PATCH` em um upload existente sem header `Authorization` retorna `401` com corpo `{ statusCode: 401, error: "UNAUTHENTICATED", message: ... }`
- `PATCH` em um upload existente feito por um usuário autenticado que não é o dono do canal retorna `403` com corpo `{ statusCode: 403, error: "FORBIDDEN", message: ... }`
- `DELETE` em um upload existente sem header `Authorization` retorna `401`; `DELETE` feito por um usuário que não é o dono retorna `403`
- `HEAD`/`PATCH`/`DELETE` com um `uploadId` sintaticamente malformado (não-UUID) retorna `404`, nunca `500`
- `HEAD` em um upload existente com o token do dono retorna `200` com o offset correto
- `OPTIONS` sem header `Authorization` não é bloqueado
- `POST` de criação sem header `Authorization` também retorna `401`

---

### SI-03.9 — Enfileiramento do job de processamento ao concluir o upload

**Description:** `onUploadFinish` grava `uploadCompletedAt` de forma durável antes de enfileirar o job `video.processing` na fila BullMQ, usando um `jobId` determinístico compartilhado com a sweep de reconciliação e a política de retry já centralizada em SI-03.4.

**Technical actions:**

1. Implementar `onUploadFinish`: gravar `Video.uploadCompletedAt = now()` como primeira ação — escrita simples no Postgres, independente da disponibilidade do Redis/BullMQ (per `upload-processing/TD-11`)
2. Só então publicar o job `video.processing` com payload `{ videoId }` e `jobId: `process-video-${videoId}`` na fila `video-processing`, via a conexão **producer** fail-fast de SI-03.4 (per `upload-processing/TD-05`, `TD-03`, `TD-11`, `### Events/Messages`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `onUploadFinish` handler | Integration: real `Queue` (BullMQ, conexão producer) + Redis de teste — asserta `uploadCompletedAt` persistido antes do enfileiramento e job com `jobId` determinístico | `tus-hooks.integration-spec.ts` |
| Enfileiramento com Redis indisponível | Integration: Redis derrubado antes de `onUploadFinish`; `uploadCompletedAt` ainda é persistido; a chamada de enfileiramento rejeita rapidamente | `tus-hooks.integration-spec.ts` |

**Dependencies:** SI-03.7 (mount tus) + SI-03.4 (fila, conexão producer)

**Acceptance criteria:**

- Concluir um upload tus grava `uploadCompletedAt` com um timestamp não-nulo antes de qualquer tentativa de enfileiramento
- Concluir um upload tus enfileira exatamente um job `video.processing` com `jobId` igual a `process-video-${videoId}`
- O job enfileirado herda `attempts: 3`, backoff exponencial e retenção de `defaultJobOptions` (SI-03.4)
- Com o Redis indisponível no momento do enfileiramento, `uploadCompletedAt` ainda é persistido e a chamada de `queue.add()` falha rapidamente

---

### SI-03.10 — Infra: binários FFmpeg/FFprobe vendorizados na imagem do worker

**Description:** Provisiona FFmpeg/FFprobe estáticos, pinados por digest imutável (nunca tag flutuante), para a arquitetura alvo, exclusivamente na imagem Docker do worker, com smoke test.

**Technical actions:**

1. Adicionar estágio multi-stage no `Dockerfile` do worker que copia binários FFmpeg/FFprobe estáticos a partir de uma fonte pinada por **digest/checksum concreto** (nunca uma tag flutuante), para `linux/amd64` (consistente com `node:25.6.0-slim`; `arm64` fica como follow-up documentado se necessário) (per `upload-processing/TD-04`)
2. Confirmar que a imagem da API não recebe esses binários (per `upload-processing/TD-04`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| Smoke test dos binários | Integration (executada na imagem do **worker**): `ffmpeg -version` e `ffprobe -version` retornam saída válida (exit 0) | `ffmpeg-smoke.integration-spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- A imagem do worker contém `ffmpeg`/`ffprobe` executáveis no path esperado, pinados por digest/checksum concreto
- `ffmpeg -version` e `ffprobe -version` executam com sucesso dentro da imagem do worker
- A imagem da API não contém os binários FFmpeg/FFprobe

---

### SI-03.11 — Bootstrap do worker: entrypoint, processor, transição PROCESSING/no-op, capacidade do volume temporário

**Description:** Cria o entrypoint do worker como aplicação NestJS standalone (compilado para `dist/`) com o `@Processor` que consome a fila `video-processing`; `process()` grava `processingStatus = PROCESSING` ao assumir o job, com no-op seguro se o vídeo já estiver `READY` ou `FAILED` (per `upload-processing/TD-10` e sua revisão); o serviço `worker` recebe um volume dedicado com checagem de capacidade explícita no startup.

**Technical actions:**

1. Criar `src/worker/main.ts` — `NestFactory.createApplicationContext()`, sem HTTP listener; garantir que `nest-cli.json`/config de build compile **ambos** os entrypoints (`src/main.ts` da API e `src/worker/main.ts`) para `dist/` (per `upload-processing/TD-03`)
2. Criar `VideoProcessingProcessor` (`@Processor('video-processing') extends WorkerHost`) com método `process(job)`, usando a conexão **consumer** (`maxRetriesPerRequest: null`) — nunca a conexão producer fail-fast da API (per `upload-processing/TD-03`)
3. `process()`: primeiro confirmar que o `Video` correlacionado a `job.data.videoId` existe — se não, `throw UnrecoverableError` imediatamente; em seguida gravar `processingStatus = 'PROCESSING'` como primeira ação de negócio, em toda tentativa; antes disso, checar se `processingStatus` já é `READY` **ou `FAILED`** — per `upload-processing/TD-10`'s revisão, `FAILED` é absoluto-terminal nesta fase — se sim, retornar imediatamente como no-op seguro, sem download/ffprobe/upload, e sem nunca ressuscitar um vídeo `FAILED` de volta para `PROCESSING` (per `upload-processing/TD-10`)
4. Adicionar serviço `worker` ao `compose.yaml`: comando aponta para o artefato compilado (`node dist/worker/main.js`); `concurrency` default `1` via env var `WORKER_CONCURRENCY` (Joi: inteiro `>= 1`); healthcheck de liveness por processo; `depends_on` com `condition: service_healthy` em `redis`, `minio` e `db` (per `upload-processing/TD-07`)
5. Implementar a checagem de capacidade de startup do volume temporário dedicado (`/tmp/videos`): `requiredFreeBytes >= WORKER_CONCURRENCY * MAX_UPLOAD_BYTES + WORKER_TEMP_MARGIN_BYTES`; se insuficiente, o worker **falha o startup explicitamente**; `WORKER_TEMP_MARGIN_BYTES` (Joi: inteiro `>= 0`) e `MAX_UPLOAD_BYTES` (Joi, mesmo valor de SI-03.7) validados junto com `WORKER_CONCURRENCY` (per `upload-processing/TD-07`, `### Events/Messages`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `WorkerModule` | Unit: compilation test (DI wiring) | `worker.module.spec.ts` |
| `process()` — vídeo inexistente, transição PROCESSING e no-op | Unit: branch logic (`videoId` sem row correspondente → `UnrecoverableError` imediato; vídeo `UPLOADING` → grava `PROCESSING`; vídeo já `READY` → no-op; vídeo já `FAILED` → no-op, nunca reescreve `PROCESSING`) | `video-processing.processor.spec.ts` |
| Checagem de capacidade no startup | Unit: branch logic (`requiredFreeBytes` suficiente → startup prossegue; insuficiente → startup falha explicitamente) | `worker-capacity-check.spec.ts` |

**Dependencies:** SI-03.4 (fila) + SI-03.3 (entidade Video)

**Acceptance criteria:**

- `npm run build` gera artefatos compilados tanto para a API (`dist/main.js`) quanto para o worker (`dist/worker/main.js`)
- `docker compose up -d worker` sobe o processo standalone a partir do artefato compilado, sem expor porta HTTP, e só depois de `redis`/`minio`/`db` reportarem `service_healthy`
- Um job publicado na fila `video-processing` é recebido por `VideoProcessingProcessor.process()`, que grava `processingStatus: 'PROCESSING'` antes de qualquer download
- Um job cujo `Video` já está `READY` **ou `FAILED`** (execução duplicada) termina como no-op — nenhum download, chamada a ffprobe, ou upload de thumbnail ocorre, e um vídeo `FAILED` nunca volta a `PROCESSING`
- Um job cujo `videoId` não corresponde a nenhum `Video` lança `UnrecoverableError` na primeira tentativa, sem consumir retries
- `concurrency` do worker é `1` por padrão, configurável via `WORKER_CONCURRENCY`
- Se a capacidade livre do volume dedicado for menor que `WORKER_CONCURRENCY * MAX_UPLOAD_BYTES + WORKER_TEMP_MARGIN_BYTES`, o processo do worker falha ao iniciar com um erro explícito

---

### SI-03.12 — Worker: download para temp dir com preflight de espaço e limpeza

**Description:** Segunda etapa do processamento — baixa o objeto para um diretório temporário por job (no volume dedicado de SI-03.11), com checagem de espaço livre dinâmica e limpeza garantida, sem apagar diretórios ativos por engano.

**Technical actions:**

1. Antes do download, checar `Content-Length` do objeto contra o espaço livre conhecido no volume dedicado; se insuficiente, falhar o job de forma explícita e observável (candidato a retry) (per `upload-processing/TD-07`)
2. Fazer streaming do objeto do storage para `/tmp/videos/{jobId}/source` (nunca bufferizado por completo) (per `upload-processing/TD-07`, `TD-01`)
3. Envolver o processamento em `try/finally`, deletando o diretório temporário do job ao final, sucesso ou falha (per `upload-processing/TD-07`)
4. Adicionar rotina de startup que varre e remove diretórios de job órfãos mais antigos que um limiar, preservando diretórios ativos/recentes (per `upload-processing/TD-07`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `WorkerTempStorageService` | Integration: download real contra MinIO de teste + limpeza do diretório temp | `worker-temp-storage.integration-spec.ts` |
| Orphan sweep na inicialização | Unit: branch logic — diretórios mais antigos que o limiar são removidos; um diretório ativo/recente explicitamente **não** é removido | `orphan-sweep.spec.ts` |

**Dependencies:** SI-03.11 (bootstrap do worker + volume dedicado) + SI-03.1 (storage) + SI-03.2 (bucket já existe)

**Acceptance criteria:**

- Um job cujo objeto excede o espaço livre conhecido falha antes de iniciar o download, sem preencher o disco
- Após processar um job (sucesso ou falha), o diretório temporário do job não existe mais no disco
- Diretórios de job órfãos mais antigos que o limiar são removidos na inicialização do worker
- Um diretório de job ativo/recente não é removido pela sweep

---

### SI-03.13 — Worker: validação autoritativa de formato via FFprobe (UnrecoverableError, sem retry real)

**Description:** Terceira etapa de processamento — valida container/codecs pelos bytes reais e, em caso de mismatch, lança `UnrecoverableError` em vez de gravar `FAILED` diretamente. Cobertura explícita de silêncio, codec de áudio errado e múltiplos streams; discriminador de container não depende de allowlist frágil.

**Technical actions:**

1. Criar `VideoProcessorPort.probe(path)` implementado por `FfmpegVideoProcessorAdapter`, chamando `ffprobe -show_format -show_streams -of json` via `spawn` com array de argumentos e `shell: false` (per `upload-processing/TD-04`)
2. Validar: container real é MP4 (não QuickTime/MOV) — o discriminador não deve depender de um allowlist frágil de `major_brand`/`compatible_brands`; exatamente um video stream com `codec_name: 'h264'` — múltiplos video streams são rejeitados; zero ou um audio stream e, se presente, `codec_name: 'aac'` — um codec de áudio diferente de AAC é rejeitado, e múltiplos audio streams são rejeitados (per `upload-processing/TD-09`)
3. Em caso de mismatch: deletar o objeto de origem no storage e então lançar `UnrecoverableError`, sem prosseguir para metadata/thumbnail e **sem gravar `processingStatus` diretamente** — a escrita de `FAILED` é responsabilidade exclusiva do handler de SI-03.15 (per `upload-processing/TD-09`, `TD-10`, `TD-01`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `FfmpegVideoProcessorAdapter` — predicado MP4/H.264/AAC | Unit: branch logic mockando a saída do ffprobe (mp4 válido com áudio AAC, mp4 válido silencioso, mov, codec de vídeo errado, codec de áudio não-AAC, múltiplos video streams, múltiplos audio streams) | `ffmpeg-video-processor.spec.ts` |
| Fluxo de rejeição no processor | Integration: vídeo com formato inválido lança `UnrecoverableError`, o objeto é removido do storage de teste, e `processingStatus` não é escrito por este código | `video-processing.integration-spec.ts` |
| `UnrecoverableError` realmente não retrya | Integration: instrumenta um contador de execuções de `process()` para um job com vídeo de formato inválido, com `attempts: 3` configurado — confirma que `process()` executa **exatamente uma vez**; confirma objeto de origem deletado; confirma nenhum metadata/thumbnail gerado; confirma `processingStatus: 'FAILED'` ao final | `video-processing.integration-spec.ts` |

**Dependencies:** SI-03.12 (download + temp) + SI-03.10 (binários FFmpeg/FFprobe)

**Acceptance criteria:**

- Um vídeo MP4/H.264/AAC válido passa na validação e o job prossegue
- Um vídeo MP4/H.264 silencioso passa na validação
- Um vídeo com container MOV é rejeitado
- Um vídeo com codec de vídeo diferente de H.264 é rejeitado
- Um vídeo com áudio em codec diferente de AAC é rejeitado
- Um vídeo com múltiplos video streams é rejeitado
- Um vídeo com múltiplos audio streams é rejeitado
- Um vídeo com formato inválido executa `process()` exatamente uma vez, apesar de `attempts: 3` configurado
- Um vídeo rejeitado faz o job lançar `UnrecoverableError`, o objeto de origem deixa de existir no storage, nenhum metadata/thumbnail é gerado, e o vídeo termina `FAILED`
- Nenhum argumento controlado pelo cliente é passado para o `spawn` do `ffprobe`

---

### SI-03.14 — Worker: extração de metadados, thumbnail e transição para READY

**Description:** Para vídeos que passam na validação, extrai duração e metadados, gera a thumbnail a partir de um frame seguro derivado da duração real, e promove o vídeo a `READY`.

**Technical actions:**

1. Extrair `durationSeconds`, `width`, `height`, `videoCodec`, `audioCodec`, `bitRate` da mesma saída do `ffprobe` já obtida em SI-03.13 (per `upload-processing/TD-04`, `TD-12`)
2. Gerar thumbnail a partir de um frame do vídeo via FFmpeg — o timestamp de captura é derivado de `durationSeconds` (ex. `min(2s, duration / 2)`), nunca um offset fixo; upload do thumbnail para o storage sob a chave `thumbnailStorageKey` derivada do `id` (per `upload-processing/TD-04`, `TD-01`, `TD-11`)
3. Persistir os campos extraídos no passo 1 e `thumbnailStorageKey`, e setar `processingStatus = 'READY'` (per `upload-processing/TD-06`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| Fluxo de sucesso do processor | Integration: vídeo válido termina `READY` com todos os campos de metadata e `thumbnailStorageKey` persistidos e thumbnail no storage de teste | `video-processing.integration-spec.ts` |
| Thumbnail em vídeo muito curto | Integration: vídeo de ~1 segundo gera thumbnail com sucesso, respeitando a duração real | `video-processing.integration-spec.ts` |

**Dependencies:** SI-03.13 (validação autoritativa)

**Acceptance criteria:**

- Um vídeo válido termina com `processingStatus: 'READY'`, `durationSeconds`, `width`, `height` e `videoCodec` preenchidos
- Um vídeo silencioso termina com `audioCodec` `null`
- Um objeto de thumbnail existe no storage sob a chave `thumbnailStorageKey` do vídeo
- Um vídeo muito curto (~1s) gera thumbnail com sucesso, sem erro de timestamp além da duração

---

### SI-03.15 — Worker: handler `@OnWorkerEvent('failed')` — transição final para FAILED, sem flicker

**Description:** Implementa `persistTerminalFailure(videoId, reason)` — a única função do worker que escreve `processingStatus = 'FAILED'`, distinguindo uma tentativa que ainda será retryada da falha realmente terminal, invocada tanto pelo evento ao vivo quanto (per `upload-processing/TD-10`'s revisão) pela sweep de reconciliação de SI-03.16.

**Technical actions:**

1. Implementar `persistTerminalFailure(videoId, reason)` — `UPDATE` de `processingStatus = 'FAILED'`, tolerante a "0 rows afetadas" (per `upload-processing/TD-10`)
2. Implementar `@OnWorkerEvent('failed')` em `VideoProcessingProcessor`: computar `isFinal = error instanceof UnrecoverableError || job.attemptsMade >= job.opts.attempts`; se `isFinal`, chamar `persistTerminalFailure(job.data.videoId, error.message)`; caso contrário, no-op (per `upload-processing/TD-10`)
3. Expor `persistTerminalFailure` para ser chamada também pela sweep de reconciliação (SI-03.16) quando ela detectar um job já `'failed'` no BullMQ cujo `Video` ainda está `PROCESSING` — mesma função, dois triggers, nunca dois writers descoordenados (per `upload-processing/TD-10`'s revisão)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `@OnWorkerEvent('failed')` handler — checagem `isFinal` | Unit: branch logic (mock `Job` com `UnrecoverableError`; mock `Job` com `Error` comum e `attemptsMade < 3`; mock `Job` com `Error` comum e `attemptsMade >= 3`; `persistTerminalFailure` sobre `videoId` inexistente não lança) | `video-processing.processor.spec.ts` |
| Retry transitório sem flicker | Integration real: primeira tentativa de um job lança um `Error` transitório → `processingStatus` permanece `PROCESSING` → segunda tentativa sucede → estado final `READY` | `video-processing.integration-spec.ts` |
| Exaustão real das tentativas | Integration real: todas as `attempts: 3` tentativas lançam o mesmo `Error` transitório → `processingStatus` só se torna `FAILED` **depois** da terceira tentativa | `video-processing.integration-spec.ts` |

**Dependencies:** SI-03.11 (bootstrap do worker/processor) + SI-03.4 (fila — define `attempts: 3`)

**Acceptance criteria:**

- Uma falha por `UnrecoverableError` resulta em `processingStatus: 'FAILED'` após o handler `failed`
- Uma falha transitória cuja tentativa ainda será retryada (`attemptsMade < 3`) não altera `processingStatus`
- Uma falha transitória cuja última tentativa se esgota (`attemptsMade >= 3`) resulta em `processingStatus: 'FAILED'`
- `persistTerminalFailure` sobre um `videoId` sem row correspondente não lança exceção

---

### SI-03.16 — Reconciliation sweep: recuperação de uploads presos e reparo de FAILED perdido (três branches)

**Description:** Rotina de startup + periódica com três checagens independentes por passada (per `upload-processing/TD-11` e suas revisões, e `TD-10`'s revisão): reenfileiramento de upload concluído com enqueue falho; recuperação ancorada em storage quando o próprio write de `uploadCompletedAt` falhou; e reparo de uma divergência terminal `FAILED` (BullMQ já confirmou, Postgres ainda não).

**Technical actions:**

1. **Branch 1 (reenfileiramento):** `Video` com `processingStatus = 'UPLOADING' AND uploadCompletedAt IS NOT NULL` → reenfileirar `video.processing` com o mesmo `jobId` determinístico de SI-03.9 (per `upload-processing/TD-11`)
2. **Branch 2 (recuperação ancorada em storage):** `Video` com `processingStatus = 'UPLOADING' AND uploadCompletedAt IS NULL AND updatedAt < {grace period}` (ex. ~1h) → `HeadObjectCommand` contra a key determinística (`video.id`); sucesso prova conclusão durável independente do cliente/tus — grava `uploadCompletedAt` (usando o `LastModified` real) e segue o mesmo caminho de enfileiramento do branch 1; `404` deixa a linha intocada (per `upload-processing/TD-11`'s revisão)
3. **Branch 3 (reparo de FAILED perdido):** `Video` ainda `PROCESSING` cujo job correlacionado (`jobId = process-video-${videoId}`) já está `'failed'` no BullMQ (`await job.getState() === 'failed'`) → chamar `persistTerminalFailure(videoId, job.failedReason)` de SI-03.15 — mesma função do listener ao vivo, nunca um segundo writer (per `upload-processing/TD-10`'s revisão)
4. Rodar as três checagens via `setInterval` nativo (nenhuma dependência nova — `@nestjs/schedule` não está em `library-refs.md`), registrado num lifecycle hook do worker e limpo explicitamente no shutdown (SI-03.18); mais uma execução na inicialização do worker

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| Branch 1 — reenfileiramento | Integration: `Video` com `uploadCompletedAt` preenchido e `UPLOADING` é reenfileirado; `Video` com `uploadCompletedAt` `null` não é tocado por este branch; segunda execução não duplica o job | `reconciliation-sweep.integration-spec.ts` |
| Branch 2 — recuperação via storage | Integration: `Video` com `uploadCompletedAt` `null`, `UPLOADING`, além do grace period, e objeto real completo no storage de teste → sweep grava `uploadCompletedAt` e enfileira; objeto ausente (`404`) → linha intocada | `reconciliation-sweep.integration-spec.ts` |
| Branch 3 — reparo de FAILED perdido | Integration: job real levado a estado `'failed'` no BullMQ enquanto o `Video` correlacionado permanece `PROCESSING` (simulando o listener não ter rodado) → sweep detecta e chama `persistTerminalFailure`, `Video` termina `FAILED` | `reconciliation-sweep.integration-spec.ts` |
| Ciclo completo de enqueue failure | Integration: upload termina → `uploadCompletedAt` persiste → enqueue falha (Redis indisponível) → Redis volta → branch 1 reenfileira → processamento completa sem reupload | `reconciliation-sweep.integration-spec.ts` |
| Corrida real entre `onUploadFinish` e a sweep | Integration: dispara `onUploadFinish` e a sweep simultaneamente para o mesmo `Video` (mesmo `jobId`) — confirma que apenas **um** job efetivo existe | `reconciliation-sweep.integration-spec.ts` |

**Dependencies:** SI-03.9 (uploadCompletedAt + jobId determinístico) + SI-03.11 (fila — conexão consumer do worker) + SI-03.15 (`persistTerminalFailure`)

**Acceptance criteria:**

- Um `Video` `UPLOADING` com `uploadCompletedAt` preenchido é reenfileirado pela sweep
- Um `Video` `UPLOADING` com `uploadCompletedAt` `null` além do grace period, cujo objeto existe completo no storage, tem `uploadCompletedAt` gravado retroativamente e é enfileirado
- Um `Video` `PROCESSING` cujo job já está `'failed'` no BullMQ é reparado para `FAILED` pela sweep, via `persistTerminalFailure`
- A sweep reenfileira usando o mesmo `jobId` determinístico — execução repetida não duplica o job
- Um ciclo completo (upload → falha de enqueue → Redis volta → reconciliation reenfileira → processamento completa) funciona sem reupload
- Uma corrida real entre `onUploadFinish` e a sweep para o mesmo vídeo resulta em exatamente um job efetivo na fila

---

### SI-03.17 — Documentação: atualizar nestjs-project/CLAUDE.md e CLAUDE.md raiz

**Description:** Documenta os novos serviços, variáveis de ambiente e comandos introduzidos por esta fase, mantendo `nestjs-project/CLAUDE.md` como fonte-de-verdade de comandos, e adicionando uma nota de arquitetura equivalente no `CLAUDE.md` raiz do projeto.

**Technical actions:**

1. Documentar os novos serviços Compose (`minio`, `redis`, `worker`) na seção de Development Environment/Services de `nestjs-project/CLAUDE.md`, incluindo portas, healthchecks/`depends_on`, comando de verificação de prontidão, e a capacidade reservada do volume dedicado do worker
2. Documentar todas as novas variáveis de ambiente (`STORAGE_ENDPOINT`, `STORAGE_PUBLIC_ENDPOINT`, `STORAGE_REGION`, `STORAGE_PRESIGNED_URL_TTL_SECONDS`, `MAX_UPLOAD_BYTES`, `WORKER_CONCURRENCY`, `WORKER_TEMP_MARGIN_BYTES`, config de fila/Redis) introduzidas pelas SIs desta fase, e sincronizar `.env.example` com todas elas
3. Documentar os comandos de execução do worker standalone e do mount do endpoint de upload tus
4. Documentar o toolchain FFmpeg/FFprobe vendorizado e o comando de suite de testes que precisa rodar na imagem do worker
5. Adicionar uma nota breve no `CLAUDE.md` raiz do projeto confirmando que os containers Object Storage, Message Queue (BullMQ/Redis) e Video Worker da arquitetura C4 agora estão implementados

**Tests:** _(empty — Documentação)_

**Dependencies:** SI-03.1, SI-03.2, SI-03.4, SI-03.7, SI-03.10, SI-03.11

**Acceptance criteria:**

- `nestjs-project/CLAUDE.md` lista os serviços `minio`, `redis` e `worker`, com portas, `depends_on`/healthchecks, e a capacidade do worker
- `nestjs-project/CLAUDE.md` documenta todas as novas variáveis de ambiente, e `.env.example` está sincronizado
- `nestjs-project/CLAUDE.md` documenta como buildar/rodar/verificar o worker standalone, e qual comando roda os testes que exigem FFmpeg real
- `CLAUDE.md` raiz confirma a implementação dos containers de storage, fila e worker

---

### SI-03.18 — Worker: graceful shutdown

**Description:** Encerra o worker BullMQ, o timer da reconciliation sweep, e as conexões Redis de forma limpa em `SIGINT`/`SIGTERM`, evitando jobs interrompidos sem necessidade durante `docker compose down`.

**Technical actions:**

1. Registrar handlers de `SIGINT`/`SIGTERM` no entrypoint do worker — ou via `app.enableShutdownHooks()` na aplicação standalone — que disparam o encerramento gracioso
2. No handler de shutdown: `await worker.close()`, limpar o `setInterval` da reconciliation sweep (SI-03.16), e encerrar a conexão Redis do consumer
3. Confirmar que `docker compose down`/`stop` no serviço `worker` aciona esse fluxo (Docker envia `SIGTERM` por padrão)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| Graceful shutdown | Integration: dispara `SIGTERM` no processo do worker com um job ativo em andamento — confirma `worker.close()`, timer da sweep limpo, e conexão Redis encerrada, sem exceções não tratadas | `worker-shutdown.integration-spec.ts` |

**Dependencies:** SI-03.11 (worker/processor) + SI-03.16 (timer da reconciliation sweep)

**Acceptance criteria:**

- Um `SIGTERM` enviado ao processo do worker aciona `worker.close()`, limpa o timer da sweep, e encerra a conexão Redis, sem exceções não tratadas
- `docker compose down` no serviço `worker` não deixa um job interrompido de forma desnecessária quando o encerramento gracioso tem tempo de completar

---

### SI-03.19 — tus termination (DELETE): escopo restrito a uploads em andamento

**Description:** Implementa a semântica de terminação decidida em `upload-processing/TD-13` — escopo restrito a uploads em andamento via `disableTerminationForFinishedUploads`, limpeza de storage via `S3Store` padrão, e remoção do draft `Video` via evento `POST_TERMINATE`.

**Technical actions:**

1. Confirmar `disableTerminationForFinishedUploads: true` já configurado em `ServerOptions` (SI-03.7, action 2) — uma tentativa de `DELETE` contra um upload já `offset === size` retorna `400 INVALID_TERMINATION` (resposta nativa do protocolo tus, `body` texto puro, fora do envelope custom do projeto) antes de alcançar qualquer código do projeto (per `upload-processing/TD-13`)
2. Confiar no `S3Store.remove(id)` padrão (nenhum override necessário, per `upload-processing/TD-13` — aborta o multipart upload e deleta o objeto + `.info` num único call)
3. Registrar `server.on(EVENTS.POST_TERMINATE, async (req, res, id) => { await videoRepository.delete({ id }); })` — hard-delete da linha `Video` draft (`id === Video.id`, per `upload-processing/TD-11`); nenhum novo valor de enum em `processingStatus`/`publicationStatus` (per `upload-processing/TD-06`, `TD-13`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `POST_TERMINATE` handler | Integration: `DELETE` de um upload em andamento remove o `Video` draft do banco e o objeto/multipart do storage de teste | `tus-termination.integration-spec.ts` |
| Terminação de upload já finalizado | Integration: `DELETE` contra um upload com `offset === size` retorna `400 INVALID_TERMINATION`, e o `Video` NÃO é removido | `tus-termination.integration-spec.ts` |

**Dependencies:** SI-03.7 (mount tus, `disableTerminationForFinishedUploads`) + SI-03.8 (auth boundary já cobre `DELETE`)

**Acceptance criteria:**

- `DELETE` de um upload em andamento remove o `Video` draft correspondente do banco
- `DELETE` de um upload em andamento aborta o multipart upload e remove o objeto do storage
- `DELETE` contra um upload já finalizado (`offset === size`) retorna `400 INVALID_TERMINATION` e o `Video` permanece intacto
- `DELETE` de um upload que não existe (uploadId malformado ou inexistente) retorna `404` (per SI-03.8)

---

## Technical Specifications

### Data Model

#### Video

| Field | Type | Constraints |
|-------|------|-------------|
| id | uuid | PK, generated (per upload-processing/TD-08) |
| channelId | uuid | FK → Channel.id, not null — the video's owning channel (per `Channel` `@OneToOne(() => User, ...)` in `nestjs-project/src/channels/entities/channel.entity.ts`; every video belongs to the uploader's channel, not to the `User` directly) |
| title | varchar(255) | not null — populated by `onUploadCreate`'s deterministic fallback chain (`Upload-Metadata.title` → `Upload-Metadata.filename` → literal `'Untitled video'`), trimmed of surrounding whitespace and hard-truncated to 255 chars if the resolved value exceeds the column limit; never left undefined even when the client declares no metadata at all (upload-processing/TD-06) |
| processingStatus | enum('UPLOADING','PROCESSING','READY','FAILED') | not null, default 'UPLOADING' (per upload-processing/TD-06) |
| publicationStatus | enum('DRAFT','PUBLISHED') | not null, default 'DRAFT' — this deliverable initializes it only; no transition logic for it is implemented in Phase 03 (per upload-processing/TD-06) |
| sourceStorageKey | varchar(255) | not null — the literal bare UUID v4 generated by the tus `namingFunction`; identical to `id` as a string, not a derived path (per upload-processing/TD-11 — the tus upload id, the S3 object key, and `Video.id` are the same value) |
| thumbnailStorageKey | varchar(255) | nullable — object key of the generated thumbnail in storage, uploaded via the API's own `@aws-sdk/client-s3` calls (not through tus/S3Store), so it keeps a readable derived path (per upload-processing/TD-01, TD-04, TD-11) |
| uploadCompletedAt | timestamptz | nullable — written by `onUploadFinish` as its first action, before attempting to enqueue the processing job; durably marks "bytes are 100% received" independent of Redis/BullMQ availability (per upload-processing/TD-11) |
| durationSeconds | integer | nullable — populated by the worker after FFprobe metadata extraction (per upload-processing/TD-04) |
| width | integer | nullable — populated by the worker from the FFprobe video stream (per upload-processing/TD-12) |
| height | integer | nullable — populated by the worker from the FFprobe video stream (per upload-processing/TD-12) |
| videoCodec | varchar(50) | nullable — the video stream's `codec_name` (e.g. `h264`) from the same FFprobe parse (per upload-processing/TD-12) |
| audioCodec | varchar(50) | nullable — the audio stream's `codec_name` (e.g. `aac`); `null` when the video is silent (per upload-processing/TD-09, TD-12) |
| bitRate | integer | nullable — bits/second, from FFprobe's `format.bit_rate` (per upload-processing/TD-12) |
| createdAt | timestamptz | default now() |
| updatedAt | timestamptz | auto-updated |

**Relations:** `Channel` has many `Video` (one-to-many, `channelId`)
**Indexes:** unique on `id` (PK); index on `channelId`
**Object storage keys:** `sourceStorageKey` is literally equal to `id` (both are the same bare UUID v4 string — the tus `namingFunction` generates it once and it is reused as the tus upload id, the S3 object key, and `Video.id`; per upload-processing/TD-11). `thumbnailStorageKey` is separately, readably derived as `videos/{id}/thumbnail` since the thumbnail upload goes through the API's own S3 client, not tus/S3Store, and carries no id-shape constraint (per upload-processing/TD-01, TD-04, TD-11).

### API Contracts

#### POST /videos/upload (SI-NN.X) — tus resumable upload mount

**Request headers:**
- Authorization: Bearer {jwt} — required on every tus request that is not `OPTIONS` (POST/PATCH/HEAD/DELETE), enforced by `onIncomingRequest` before any handler runs; `OPTIONS` (CORS preflight / capability discovery) is explicitly exempted — browsers never attach `Authorization` to a preflight request, and `@tus/server` handles `OPTIONS` outside the normal per-request validation pipeline (confirmed current API) (per upload-processing/TD-11)
- Tus-Resumable: 1.0.0 (protocol header, per upload-processing/TD-05)
- Upload-Metadata: base64-encoded key-value pairs, including `filename`, `filetype`, and `title` (per upload-processing/TD-09 — `filetype` is read by the `onUploadCreate` hook for the preliminary format check; `title` and `filename` populate the `Video` draft's `title` field, `filename` as fallback when `title` is absent — see Validation Rules for the full fallback chain)
- Upload-Length: integer, required — total upload size in bytes; the tus protocol's `maxSize` (`MAX_UPLOAD_BYTES`, default 10GB = `10737418240` bytes) is enforced at creation time against this declared header, before any byte is accepted (upload-processing/TD-05)

**Request body:** none at creation (tus creation-only request); subsequent chunks are sent via `PATCH` to the returned `Location`, and `HEAD`/`DELETE` are also valid subsequent requests against the same resource — all gated by the same `onIncomingRequest` check (per upload-processing/TD-11). `@tus/server` handles the full protocol verb set (POST/PATCH/HEAD/OPTIONS/DELETE) per upload-processing/TD-05 — this contract documents only the domain-specific hook behavior layered on top, not the tus wire protocol itself. `DELETE` is authenticated/authorized identically to `PATCH`/`HEAD`; per `upload-processing/TD-13`, termination is supported **only for in-progress uploads** (`disableTerminationForFinishedUploads: true` — a request against an already-finished upload returns `400 INVALID_TERMINATION`, tus's own native plain-text response, outside this project's JSON error envelope). On success, `S3Store.remove(id)` cleans up the storage side (aborts the multipart upload, deletes the object + `.info`), and the `EVENTS.POST_TERMINATE` handler hard-deletes the corresponding `Video` draft row — no new `processingStatus`/`publicationStatus` value is introduced for a cancelled upload (per upload-processing/TD-06, TD-13).

**Response 201:**
- Location header: the URL to `PATCH` subsequent chunks to — the path segment is the bare UUID v4 the `namingFunction` generated (per upload-processing/TD-11; no nested path, so no `generateUrl`/`getFileIdFromRequest` overrides are needed)

**Error responses:**
- 401 UNAUTHENTICATED: `onIncomingRequest` rejects a non-`OPTIONS` tus request (create, `PATCH`, `HEAD`, or `DELETE`) that carries no valid JWT (per upload-processing/TD-11)
- 403 FORBIDDEN: `onIncomingRequest` rejects a `PATCH`/`HEAD`/`DELETE` against an upload id whose correlated `Video.channelId` does not belong to the authenticated user (per upload-processing/TD-11)
- 404: `onIncomingRequest`/the lookup treats a syntactically malformed `uploadId` (not a well-formed UUID) as not-found — rejected before any database query, so a malformed id never reaches TypeORM as a raw driver error (which would otherwise surface as an uncontrolled `500`)
- 400 INVALID_TERMINATION (tus native, plain-text `body`, NOT the project's JSON envelope): `DELETE` attempted against an upload that has already finished (`offset === size`), per `disableTerminationForFinishedUploads: true` (upload-processing/TD-13)
- 415 UNSUPPORTED_VIDEO_FORMAT: `onUploadCreate` rejects when the client-declared `Upload-Metadata.filetype` is present and is not `video/mp4` (upload-processing/TD-09 — preliminary, non-authoritative check)
- 500 ACCOUNT_INCOMPLETE: `onUploadCreate` rejects (logged server-side, generic message to the client) when the authenticated user has no associated `Channel` — an account-integrity invariant that should never be false in practice (every registered user gets a `Channel`, per phase-02-auth), guarded defensively rather than left to surface as an unhandled exception or a foreign-key violation
- 413 (tus protocol): when `Upload-Length` exceeds the server's configured `maxSize` (the `MAX_UPLOAD_BYTES` ceiling, upload-processing/TD-05) — `Upload-Length` exactly equal to `maxSize` is accepted; only strictly greater is rejected

---

#### Validation Rules — Video Upload

- `Upload-Metadata.filetype`, when present, must equal `video/mp4` to pass the preliminary check (upload-processing/TD-09) — absence does not block creation; only an explicit mismatch does.
- Authoritative container/codec validation happens after upload completion, inside the worker (see `### Events/Messages`), not at this endpoint (upload-processing/TD-09).
- Every non-`OPTIONS` tus request (create, chunk, offset probe, delete) requires a valid JWT and, for non-creation requests, ownership of the correlated `Video` row (upload-processing/TD-11). `OPTIONS` bypasses this check entirely — CORS preflight/capability-discovery requests carry no `Authorization` header by browser design.
- **Every tus-hook-thrown error follows the same two-layer shape, and `body` is always a string, never an object:** `@tus/server`'s own confirmed error catalog uses `{status_code: number, body: string}` (e.g. `{status_code: 404, body: 'The file for this url was not found\n'}`) — `body` is documented and consumed as plain text, not JSON. Every domain error this contract throws follows the identical shape: `throw { status_code: number, body: JSON.stringify({ statusCode: number, error: string, message: string }) }` — the project's standard envelope (`{statusCode, error, message}`, per phase-02-auth/TD-07) is serialized into that string, never passed as a nested object. Clients (and tests) must `JSON.parse(response.body)` to recover the structured envelope. Applies uniformly to 401, 403, and 415 above. **Exception:** `400 INVALID_TERMINATION` is thrown internally by `@tus/server`'s own `DeleteHandler` (not by a project hook) and carries `@tus/server`'s own native plain-text `body` — never wrapped in the project's JSON envelope.
- `title` fallback chain (guards the `not null` constraint on `Video.title`, per `### Data Model`): `Upload-Metadata.title` → `Upload-Metadata.filename` → literal `'Untitled video'`. The client is never required to declare either field; the draft always receives a non-null `title` (upload-processing/TD-06).
- `Upload-Length` boundary: exactly `MAX_UPLOAD_BYTES` (`10737418240`, 10GB) is accepted at creation — the check is purely header-based (`Upload-Length` vs. configured `maxSize`), so proving the boundary requires only a `POST` with that header, never an actual 10GB transfer (upload-processing/TD-05).

---

#### GET /videos/{id}/stream (SI-NN.X)

**Request headers:** none required — `Range` support is handled transparently by the object store once redirected (upload-processing/TD-02).

**Response 302:** redirects to a short-lived presigned GET URL for the video object, generated against the storage's **public** endpoint (`STORAGE_PUBLIC_ENDPOINT`, no default value — must be explicitly configured per environment; `http://localhost:9000` is only an illustrative example for local host-machine access, never a fallback) — never the internal Docker Compose endpoint (`STORAGE_ENDPOINT`) the API/worker use for their own object I/O, since the browser following this redirect runs outside the Compose network and cannot resolve internal service names like `minio` (upload-processing/TD-01, TD-02). The presigned URL sets `ResponseContentType: 'video/mp4'` on the underlying `GetObjectCommand` so the browser always receives `Content-Type: video/mp4` regardless of what content-type metadata (if any) the tus/S3Store upload path stored on the object. Expiry is `STORAGE_PRESIGNED_URL_TTL_SECONDS` (explicit, Joi-validated positive integer — no implicit/magic window).

**Error responses:**
- 404 VIDEO_NOT_FOUND: when no video exists with the given `id`
- 409 VIDEO_NOT_READY: when `processingStatus != READY` (upload-processing/TD-06)

---

#### GET /videos/{id}/download (SI-NN.X)

**Request headers:** none required.

**Response 302:** redirects to a short-lived presigned GET URL for the video object with `ResponseContentDisposition: attachment` **and** `ResponseContentType: 'video/mp4'` set, generated against the storage's **public** endpoint (`STORAGE_PUBLIC_ENDPOINT`) — same internal/public split and TTL as the streaming endpoint above (upload-processing/TD-01, TD-02).

**Error responses:**
- 404 VIDEO_NOT_FOUND: when no video exists with the given `id`
- 409 VIDEO_NOT_READY: when `processingStatus != READY` (upload-processing/TD-06)

---

### Authorization Matrix

| Endpoint | Anonymous | Authenticated | Owner |
|----------|-----------|---------------|-------|
| OPTIONS /videos/upload (CORS preflight / capability discovery) | ✓ | ✓ | n/a — `onIncomingRequest` explicitly bypasses auth for `OPTIONS` |
| POST /videos/upload (create) | ✗ | ✓ | n/a (creates own channel's video) |
| PATCH, HEAD /videos/upload/{id} (chunks, resume) | ✗ | ✓ | ✓ (per `onIncomingRequest`, upload-processing/TD-11) |
| DELETE /videos/upload/{id} (cancel, in-progress uploads only) | ✗ | ✓ | ✓ (per `onIncomingRequest`, upload-processing/TD-11; scoped to in-progress uploads only, per `disableTerminationForFinishedUploads`, upload-processing/TD-13) |
| GET /videos/{id}/stream | ✓ (once READY) | ✓ | ✓ |
| GET /videos/{id}/download | ✓ (once READY) | ✓ | ✓ |

Anonymous playback/download is allowed once a video is `READY`, consistent with the project's "Anonymous users can watch freely" stance (root `CLAUDE.md` § Project Overview); upload requires authentication on every non-`OPTIONS` tus request — not only creation — enforced by `onIncomingRequest` (upload-processing/TD-11), inherited from the JWT verification convention established in phase-02-auth. The created `Video` is attached to the authenticated user's own `Channel`, and non-creation requests additionally verify that ownership. Editorial visibility gating via `publicationStatus` is not enforced by this deliverable — upload-processing/TD-06 explicitly implements no publish functionality, and no correction in this revision expands that scope — and this phase exposes no browsing/listing surface, so an unpublished video is reachable only by a party who already has its direct URL. **CORS origin allowlist** (`allowedOrigins`) is deferred — `next-frontend/` is not initialized in this phase (per `## Scope`), so there is no concrete origin to allowlist yet; `@tus/server`'s own default `ALLOWED_HEADERS`/`EXPOSED_HEADERS` already include every header this contract needs (`Authorization`, `Content-Type`, `Location`, `Upload-*`, `Tus-Resumable`, confirmed current API), so no custom CORS header configuration is needed beyond setting the origin allowlist once a consuming frontend exists.

### Error Catalog

**Error response format:** inherited from phase-02-auth/TD-07 — `{ statusCode: number, error: string, message: string }`. The `error` field carries the domain code below. `onIncomingRequest`/`onUploadCreate` construct this envelope manually and serialize it into the tus throw-object contract's `body` field as a **JSON string** — `throw { status_code, body: JSON.stringify({ statusCode, error, message }) }` — matching `@tus/server`'s own confirmed convention of plain-text `body` values (per upload-processing/TD-11; see `### API Contracts` → Validation Rules for the full shape). The single exception is `INVALID_TERMINATION` (400), which is `@tus/server`'s own native response (per `disableTerminationForFinishedUploads`) and is never wrapped in this envelope.

| Code | HTTP | Message | Trigger |
|------|------|---------|---------|
| UNAUTHENTICATED | 401 | Authentication required | `onIncomingRequest` rejects a tus request that carries no valid JWT (upload-processing/TD-11) |
| FORBIDDEN | 403 | Not the owner of this upload | `onIncomingRequest` rejects a non-creation tus request (PATCH/HEAD/DELETE) whose authenticated user does not own the correlated `Video` (upload-processing/TD-11) |
| ACCOUNT_INCOMPLETE | 500 | Something went wrong | Authenticated user has no `Channel` at upload-creation time — an account-integrity invariant violation, logged server-side with detail, generic message to the client |
| UNSUPPORTED_VIDEO_FORMAT | 415 | Unsupported video format | `Upload-Metadata.filetype` declared on tus upload creation is present and is not `video/mp4` (upload-processing/TD-09, preliminary check) |
| _(tus native)_ INVALID_TERMINATION | 400 | `Cannot terminate an already completed upload` (tus's own literal text, not this project's envelope) | `DELETE` against an upload that already finished (`offset === size`), per `disableTerminationForFinishedUploads: true` (upload-processing/TD-13) |
| VIDEO_NOT_FOUND | 404 | Video not found | GET /videos/{id}/stream or /download with an `id` that does not exist, or a tus request against a malformed/non-existent `uploadId` |
| VIDEO_NOT_READY | 409 | Video is not ready for playback | GET /videos/{id}/stream or /download while `processingStatus != READY` (upload-processing/TD-06) |

### Events/Messages

#### video.processing

**Payload:**

```json
{ "videoId": "uuid" }
```

**Producer:** two producers, both using the same deterministic `jobId` = `` `process-video-${videoId}` `` (no `:`, per upload-processing/TD-11), **each with its own Redis connection profile, never a single shared "wait forever" config**:
- `onUploadFinish` tus hook (runs in the **API process**, on the HTTP request path) — writes `Video.uploadCompletedAt` first (a plain, durable Postgres write independent of Redis/BullMQ), then calls `queue.add('video.processing', { videoId }, { jobId })` against a `Queue`-only connection configured to **fail fast** (`enableOfflineQueue: false` plus a small bounded `maxRetriesPerRequest`, confirmed real `ioredis` options) — if Redis is down, the `queue.add()` call rejects quickly instead of hanging the HTTP response indefinitely, which is what makes the `uploadCompletedAt` + reconciliation recovery path (below) actually reachable rather than merely theoretical (per upload-processing/TD-05, TD-11).
- The reconciliation sweep (below), running in the **worker process**, off the request path, against the worker's own Redis connection.

**Worker's own Redis connection** (the `Worker` consumer, and the reconciliation sweep's `Queue` instance, both in the worker process) keeps `maxRetriesPerRequest: null` — BullMQ's own hard requirement for its blocking consumer commands (confirmed via `library-refs.md § ioredis`) — since a consumer legitimately waiting for jobs is a different concern from a producer sitting inside a live HTTP request.

**Consumer:** `VideoProcessingProcessor` — NestJS standalone application, `@Processor('video-processing')` / `WorkerHost` (per upload-processing/TD-03).

**Trigger:** fires when the resumable tus upload completes (all bytes received, upload-processing/TD-05), OR when the reconciliation sweep re-enqueues a recovered upload (below).

**Delivery semantics:** at-least-once, with a concrete, single-source-of-truth retry + retention policy registered once as the queue's `defaultJobOptions` — `attempts: 3`, `backoff: { type: 'exponential', delay: 1000 }`, `removeOnComplete: { age: 3600, count: 1000 }`, `removeOnFail: { age: 604800, count: 5000 }` (confirmed real `bullmq` options, per `library-refs.md § bullmq`, upload-processing/TD-03) — inherited automatically by every `queue.add()` call from either producer. Retention (`removeOnComplete`/`removeOnFail`) only evicts jobs **after** they reach a terminal state; it has no effect on the live jobId-uniqueness guarantee for an **incomplete** job, so it does not weaken TD-11's dedup contract. Duplicate `queue.add()` calls with the same `jobId` from either producer, while the job is still incomplete, are silently ignored by BullMQ — no duplicate concurrent jobs for the same video (upload-processing/TD-11, relying on BullMQ's native job-id uniqueness).

**Reconciliation scheduling mechanism:** a native `setInterval` (no new dependency — `@nestjs/schedule` is **not** in `library-refs.md` and is not introduced by this revision), registered in the worker's own lifecycle hook (`OnModuleInit`/`OnApplicationBootstrap`) and explicitly cleared on shutdown (see the graceful-shutdown SI below) — plus one run at worker startup, extending the TD-07 orphan-sweep entrypoint.

**Worker temp disk capacity** (per upload-processing/TD-07): the worker's `/tmp/videos` directory lives on a dedicated Docker volume — not the container's default writable layer. Docker Compose volumes have **no enforced size ceiling** on their own; a bind/named volume does not "reserve" capacity by existing. The binding guarantee instead comes from an **explicit startup check** in the worker process: `requiredFreeBytes >= WORKER_CONCURRENCY * MAX_UPLOAD_BYTES + WORKER_TEMP_MARGIN_BYTES` against the volume's actual available disk space — if insufficient, the worker **fails startup explicitly** (does not silently start into an under-provisioned state). This is a static, one-time gate; the existing **per-job** free-space preflight (processing sequence step 2 below) remains the dynamic, per-download check and is unaffected.

**Worker health/readiness:** the `worker` service has no HTTP listener (upload-processing/TD-03), so Compose verifies liveness via a process-level healthcheck (confirms the worker's Node process is running) rather than an HTTP probe — a minimum liveness bar, not deep application-level readiness (e.g. it does not itself verify Redis/MinIO connectivity beyond what the worker's own startup already requires to boot at all).

**Compose startup ordering:** the API and worker both declare `depends_on` with health conditions on their required services (`db`, `minio`, `redis` as applicable) — neither attempts its own bootstrap routine (bucket check, queue registration) against a dependency that Compose has not yet reported healthy.

**Worker processing sequence** (per upload-processing/TD-07, TD-04, TD-09, TD-10, TD-12):
1. On job pickup, first confirm the correlated `Video` row exists — if `{videoId}` does not correspond to any row (a malformed/foreign job payload), throw `UnrecoverableError` immediately; this is a permanent condition no retry can fix, and never reaches the DB-write step below (so a missing row is never mistaken for one to update). Otherwise, write `processingStatus = PROCESSING` — on every attempt, including BullMQ-initiated retries. If `processingStatus` is already `READY` **or already `FAILED`** — per `upload-processing/TD-10`'s revision, `FAILED` is absolute-terminal within this phase, no reprocessing exists or is implied — exit immediately as a safe no-op: no download, no FFprobe call, no re-upload, no further write; a duplicate/delayed execution never resurrects a terminal `FAILED` video back into `PROCESSING`.
2. Free-space preflight check against the object's known `Content-Length`, then stream the source object from storage to a per-job temp directory (upload-processing/TD-07).
3. Run FFprobe as the first real processing step — authoritative container/codec validation (upload-processing/TD-09; the container discriminator MUST NOT rely on a fragile `major_brand`/`compatible_brands` allowlist — those vary by encoder and go stale — the exact predicate is an implementation detail derived from the real FFprobe output, not fixed by the TD). On mismatch (wrong container, wrong/absent video codec, more than one video stream, an audio stream with a codec other than AAC, or more than one audio stream): delete the source storage object inline, then throw `UnrecoverableError` (upload-processing/TD-09, TD-10) — skip steps 4–5. This code path does **not** write `processingStatus` itself. A silent, single audio stream is accepted (audio is optional).
4. On match: extract `durationSeconds`, `width`, `height`, `videoCodec`, `audioCodec`, `bitRate` from the same FFprobe JSON output already parsed in step 3 (upload-processing/TD-04, TD-12); generate a thumbnail from a frame of the video (the extraction timestamp is derived from `durationSeconds`, e.g. `min(2s, duration / 2)` — never a fixed offset that could exceed a very short clip's actual length) and upload it to `thumbnailStorageKey` (upload-processing/TD-04).
5. Persist the extracted fields from step 4 and set `processingStatus = READY`.
6. Delete the per-job temp directory in a `finally` block regardless of outcome (upload-processing/TD-07).

Any other exception (a plain `Error` — a transient storage/network failure, or the free-space preflight rejection) re-throws without writing `processingStatus`, letting BullMQ's retry/backoff (TD-03; `attempts: 3`) run its course.

**Observability:** every step above logs structured entries carrying `videoId`, `jobId`, `attemptsMade`, and the error (when applicable) — specifically at: enqueue failure (`onUploadFinish` and the reconciliation re-enqueue), invalid-format rejection (step 3 mismatch), storage/disk-preflight failure (step 2), and the terminal `FAILED` write (below). **Never logged, in full or in part:** JWTs, complete presigned URLs (they carry a temporary signature and must be treated as credentials), or MinIO access/secret keys. Metrics beyond structured logs are out of scope for this deliverable.

---

#### video.processing — final-FAILED transition

**Payload:** the native BullMQ `'failed'` event signature — the `Job` object, the thrown `Error`/`UnrecoverableError`, and the `prev` state string.

**Producer:** the BullMQ Worker itself — it calls `Job.moveToFailed()` first (which resolves retry-vs-terminal internally via `shouldRetryJob()` and updates the job's own bookkeeping, including incrementing `attemptsMade`), and only **after** that call resolves does it emit the `'failed'` event. The event fires on **every** failed attempt — retryable or not — never only on the final one (per upload-processing/TD-10).

**Consumer:** `@OnWorkerEvent('failed')` handler on `VideoProcessingProcessor` (per upload-processing/TD-03, TD-10).

**Trigger:** any exception thrown from `process()` — both a plain `Error` (which BullMQ may still retry, up to `attempts: 3`) and an `UnrecoverableError` (which BullMQ never retries) fire this event; the handler cannot assume the mere firing means "no more retries will happen".

**Delivery semantics:** the handler explicitly computes `isFinal = error instanceof UnrecoverableError || job.attemptsMade >= job.opts.attempts` before writing anything — `job.opts.attempts` resolves to the concrete `3` registered on the queue's `defaultJobOptions`. Only when `isFinal` is true does it write `processingStatus = FAILED` via a single named function, `persistTerminalFailure(videoId, reason)`, whose write is a no-op tolerant of "0 rows affected" (covers the missing-`Video`-row case from step 1 above). On a non-final emission it is a no-op (`processingStatus` stays `PROCESSING`). This is the **single** place in the entire worker's normal path where `processingStatus` is ever written to `FAILED` (upload-processing/TD-10) — no other code path, including the FFprobe mismatch case, writes it directly.

**Durable repair for a lost live-write (per upload-processing/TD-10's revision).** If the worker process crashes, or Postgres is briefly unavailable, in the exact window between BullMQ recording the job as terminally `failed` and this handler's write landing, `processingStatus` could otherwise remain `PROCESSING` permanently. The reconciliation sweep closes this: for `Video` rows still `PROCESSING`, it checks the correlated job's own Redis-confirmed state via `await job.getState()` (confirmed current `bullmq` API, returns `'failed'` for a job BullMQ has already moved there) — if that state is already `'failed'`, the sweep invokes the **same** `persistTerminalFailure(videoId, reason)` function the live listener uses, sourcing `reason` from the job's own `failedReason` field. This is architecturally one write function invoked from two triggers — never a second, independently-decided writer — and the reconciliation branch only ever acts on jobs BullMQ has *already* moved to `failed`, never on `active`/`delayed`/`waiting`, so it introduces no flicker risk.

---

#### Reconciliation sweep — three recovery branches

The reconciliation sweep (per upload-processing/TD-11, extended by its own revision and by TD-10's revision) runs on the schedule described above and performs three independent checks per pass, none of which interferes with the others:

1. **Enqueue-failure re-enqueue** (original TD-11 mechanism): `Video` rows where `processingStatus = 'UPLOADING' AND uploadCompletedAt IS NOT NULL` — the upload completed and `onUploadFinish` recorded that fact, but the enqueue call itself failed. Re-enqueues `video.processing` with the same deterministic `jobId`.
2. **Storage-anchored recovery for a lost `uploadCompletedAt` write** (TD-11 revision): `Video` rows where `processingStatus = 'UPLOADING' AND uploadCompletedAt IS NULL AND updatedAt < {grace period}` (a conservative threshold, on the order of an hour, so rows still legitimately uploading are never probed). For each candidate, issues a `HeadObjectCommand` against the deterministic key (`Bucket: <storage bucket>, Key: video.id`). A successful response is durable, storage-side proof of a **complete** object (an incomplete multipart upload is not visible to `HeadObject`, only to `ListMultipartUploads`/`ListParts`) — independent of tus/S3Store's own bookkeeping and of the client. On success, retroactively writes `uploadCompletedAt` (using the `HeadObjectCommand` response's `LastModified`, not "now") and proceeds through the same enqueue path as branch 1. On `404`, the row is left untouched (covered by the documented abandoned-upload limitation below).
3. **Terminal-`FAILED` divergence repair** (TD-10 revision): `Video` rows still `PROCESSING` whose correlated job (`jobId = process-video-${videoId}`) has already reached BullMQ-confirmed `'failed'` state (`await job.getState() === 'failed'`) — see the final-FAILED transition subsection above for the full mechanism.

All three branches share the same deterministic `jobId` derivation and the same underlying storage/queue infrastructure — no new library, no new persisted table.

---

#### tus termination (`DELETE`)

**Trigger:** an authenticated, owning `DELETE` request against an in-progress upload (per upload-processing/TD-11's `onIncomingRequest`; per upload-processing/TD-13 for what happens next).

**Scope guard:** `disableTerminationForFinishedUploads: true` (confirmed current `ServerOptions` field) — a `DELETE` against an upload that has already reached `offset === size` is rejected by `@tus/server` itself with `400 INVALID_TERMINATION`, before reaching any project code. Termination is therefore only ever possible against an upload that has not yet finished — this phase never terminates a video that has entered or completed processing (upload-processing/TD-13).

**Storage cleanup:** `@tus/s3-store`'s default `S3Store.remove(id)` implementation (confirmed: no override needed) aborts the in-progress multipart upload and deletes the object plus its `.info` object in a single call.

**Draft cleanup:** `server.on(EVENTS.POST_TERMINATE, async (req, res, id) => { ... })` (confirmed current event, fired after a successful `DELETE`, carrying the same `id` that TD-11 established as `Video.id`) hard-deletes the corresponding `Video` draft row. Chosen over introducing a cancelled/terminated `processingStatus` or `publicationStatus` value because TD-06 defines exactly four `processingStatus` values and this deliverable does not extend that enum; a cancelled in-progress upload has no processing history worth retaining.

**Known limitations of this delivery (documented, not resolved as blockers by this plan):**
- **Redis persistence:** no AOF/RDB durability requirement is adopted in this delivery; a Redis crash/restart can lose an in-flight job already marked `PROCESSING` in Postgres, with no automatic recovery beyond BullMQ's own stalled-job detection. Classified as hardening for this academic delivery, not a blocker.
- **`S3Store`'s upload-progress cache** defaults to an in-memory `MemoryKvStore` (confirmed current default) — lost on an **API process restart** (not on a mere dropped connection, which is what "retomar em caso de falha de conexão" tests). Resuming across an actual API restart is out of scope; only resuming across a connection failure while the API process keeps running is the tested requirement.
- **`MemoryLocker`** (TD-05's decided default) is correct **only** under the single-API-instance premise this Compose setup already enforces; it must never be read as supporting horizontal scaling of the API.
- **Abandoned uploads** (started, never completed and never explicitly terminated via `DELETE` — including the case where `onUploadCreate`'s DB insert succeeds but the datastore's own multipart-upload creation subsequently fails) leave an orphaned `Video` row at `UPLOADING` and, potentially, incomplete multipart data in storage. No automatic expiration/cleanup job is implemented in this delivery.
- **Request timeout for large `PATCH` chunks / FFmpeg process timeout on stuck or malformed media:** neither is addressed — no reverse proxy sits in front of the API in this delivery, and FFmpeg child-process timeout/kill handling is not implemented. Both are hardening concerns for a later phase, not blockers for this academic delivery.

---

<!-- phase-a-complete -->

## Dependency Map

```
SI-03.1 (root) — Infra: object storage (endpoint interno + público)
SI-03.3 (root) — Entidade Video
SI-03.4 (root) — Infra: Redis + fila BullMQ (attempts=3)
SI-03.10 (root) — Infra: binários FFmpeg/FFprobe

SI-03.1
└── SI-03.2 — depends on SI-03.1 (bootstrap do bucket, seguro contra concorrência)

SI-03.5 — depends on SI-03.1, SI-03.2, SI-03.3
└── SI-03.6 — depends on SI-03.5, SI-03.3

SI-03.7 — depends on SI-03.1, SI-03.2, SI-03.3
├── SI-03.8 — depends on SI-03.7
│   └── SI-03.19 — depends on SI-03.7, SI-03.8 (tus termination)
└── SI-03.9 — depends on SI-03.7, SI-03.4

SI-03.11 — depends on SI-03.4, SI-03.3
├── SI-03.12 — depends on SI-03.11, SI-03.1, SI-03.2
│   └── SI-03.13 — depends on SI-03.12, SI-03.10
│       └── SI-03.14 — depends on SI-03.13
└── SI-03.15 — depends on SI-03.11, SI-03.4
    └── SI-03.16 — depends on SI-03.9, SI-03.11, SI-03.15 (persistTerminalFailure)
        └── SI-03.18 — depends on SI-03.11, SI-03.16

SI-03.17 — depends on SI-03.1, SI-03.2, SI-03.4, SI-03.7, SI-03.10, SI-03.11
```

---

## Deliverables

- [x] SI-03.1 — Infra: configurar object storage (MinIO) e cliente S3 (endpoint interno + público)
- [x] SI-03.2 — Infra: bootstrap idempotente do bucket MinIO (seguro contra concorrência)
- [x] SI-03.3 — Entidade Video + migration
- [x] SI-03.4 — Infra: Redis + módulo de fila BullMQ
- [x] SI-03.5 — Serviço de entrega: URLs assinadas para streaming/download
- [x] SI-03.6 — Endpoints de streaming e download
- [x] SI-03.7 — Módulo de upload: mount tus + criação de rascunho (bare UUID) + resumabilidade real após falha
- [x] SI-03.8 — Boundary de autenticação em todos os requests tus (onIncomingRequest)
- [x] SI-03.9 — Enfileiramento do job de processamento ao concluir o upload
- [x] SI-03.10 — Infra: binários FFmpeg/FFprobe vendorizados na imagem do worker
- [x] SI-03.11 — Bootstrap do worker: entrypoint, processor, transição PROCESSING/no-op, capacidade do volume temporário
- [x] SI-03.12 — Worker: download para temp dir com preflight de espaço e limpeza
- [x] SI-03.13 — Worker: validação autoritativa de formato via FFprobe (UnrecoverableError, sem retry real)
- [x] SI-03.14 — Worker: extração de metadados, thumbnail e transição para READY
- [x] SI-03.15 — Worker: handler `@OnWorkerEvent('failed')` — transição final para FAILED, sem flicker
- [x] SI-03.16 — Reconciliation sweep: recuperação de uploads presos e reparo de FAILED perdido (três branches)
- [x] SI-03.17 — Documentação: atualizar nestjs-project/CLAUDE.md e CLAUDE.md raiz
- [x] SI-03.18 — Worker: graceful shutdown
- [x] SI-03.19 — tus termination (DELETE): escopo restrito a uploads em andamento

**Submission-structure compatibility** _(risco de submissão — não renomear os artefatos usados pela pipeline)_:

- [x] Antes da entrega final, **copiar** (nunca mover/renomear) `docs/phases/phase-03-upload-processing/phase-03-upload-processing.md` para `docs/phases/phase-03-videos/phase-03-videos.md`, e `docs/decisions/technical-decisions-upload-processing.md` para `docs/decisions/technical-decisions-phase-03-videos.md`, preservando os originais intactos para a pipeline

**Processo:**

- [x] Trabalho realizado em branch `feature/*` criada a partir de `dev`; integração final via merge para `dev`; nenhum commit direto em `main` (per root `CLAUDE.md` § Git Conventions) — merge `--no-ff` de `feature/upload-processing` em `dev` (commit `90ea32b`), sem conflitos, sem nenhum commit direto em `main`
- [x] `progress.md` (gerado/atualizado por `/implement`) reflete status e testes de cada SI ao longo da execução

**Full test suites:**

- [x] Unit tests pass (`docker compose exec nestjs-api npm test`)
- [x] Integration tests pass — regras/mocks, container da API (`docker compose exec nestjs-api npm run test:integration`)
- [x] Integration tests pass — FFmpeg real, container do **worker** (comando definido em SI-03.17 — nunca coberto por `docker compose exec nestjs-api ...`, já que a imagem da API não contém os binários FFmpeg/FFprobe por decisão de TD-04)
- [x] E2E tests pass (`docker compose exec nestjs-api npm run test:e2e`)
- [x] Type-check passes (`docker compose exec nestjs-api npx tsc --noEmit`)
- [x] Lint passes (`docker compose exec nestjs-api npm run lint`)
- [x] Project builds successfully — ambos os entrypoints (`docker compose exec nestjs-api npm run build`, gerando `dist/main.js` **e** `dist/worker/main.js`)
- [x] `docker compose up -d` sobe `db` + `minio` + `redis` + `nestjs-api` + `worker` com todos os healthchecks reportando saudável

**Pipeline (antes de `/implement`):**

- [x] `nestjs-project/specs/video-delivery.plan.md` pode estar desatualizado após estas revisões — rodar `/plan-test-specs upload-processing` para resincronizar com os endpoints/edge cases atuais antes de implementar
- [x] Nenhuma nova decisão estratégica pendente — os 4 gaps antes marcados `NEEDS_DECISION` foram formalizados via `/research` (TD-10/TD-11 revisions, TD-13 nova) e incorporados a este plano; não é necessário reabrir `/research` antes de `/implement`
