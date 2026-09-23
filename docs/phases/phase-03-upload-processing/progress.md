# phase-03-upload-processing — Progress

**Status:** in_progress
**SIs:** 7/19 completed

### SI-03.1 — Infra: object storage (MinIO) + cliente S3
- **Status:** completed
- **Tests:** 1 passing
- **Observations:**
  - Ambiente já tinha containers órfãos (minio/redis/worker) e 10 commits de uma tentativa anterior de implementação (numeração de SI diferente, pré-revisões TD-10/TD-11/TD-13), descobertos via `git reflog` — preservados em branch `recovered-upload-processing-attempt` (não mesclada, não usada) a pedido do usuário; containers órfãos removidos, volume `nestjs-project_minio-data` reaproveitado (bucket `videos` pré-existente preservado).
  - `.env`/`.env.example` já tinham um bloco `STORAGE_*` pré-populado com nomes/formato divergentes do contrato desta SI (`STORAGE_ENDPOINT` como hostname nu + `STORAGE_PORT`/`STORAGE_USE_SSL` separados, sem `STORAGE_PUBLIC_ENDPOINT`, credenciais como `STORAGE_ACCESS_KEY`/`STORAGE_SECRET_KEY`) — corrigido para bater com a decisão da TD-01/SI-03.1 (endpoint interno como URL completa, `STORAGE_PUBLIC_ENDPOINT` obrigatório sem default, credenciais renomeadas para `STORAGE_ACCESS_KEY_ID`/`STORAGE_SECRET_ACCESS_KEY` per o exemplo do `library-refs.md`); var solta `PRESIGNED_URL_TTL_SECONDS` (fora do namespace `STORAGE_`) consolidada em `STORAGE_PRESIGNED_URL_TTL_SECONDS`, conforme a própria SI-03.1 já decidia esse nome.
  - Healthcheck do `minio` usa `mc ready local` (binário `mc` já embutido na imagem oficial `minio/minio`) em vez de `curl`, que não existe na imagem.

### SI-03.2 — Infra: bootstrap idempotente do bucket MinIO
- **Status:** completed
- **Tests:** 3 passing
- **Observations:**
  - `BucketAlreadyOwnedByYou`/`BucketAlreadyExists` comparados por `.name` (string), não `instanceof` — mais robusto contra MinIO (provedor S3-compatible) não reproduzir exatamente o mesmo protótipo de exceção que a AWS real; padrão confirmado via Context7 (ERROR_HANDLING.md do aws-sdk-js-v3).
  - Testes de integração usam nomes de bucket únicos por execução (`test-bootstrap-${Date.now()}`) para exercitar genuinamente o caminho "bucket ausente", já que o MinIO de dev já tinha um bucket `videos` pré-existente.

### SI-03.3 — Entidade Video + migration
- **Status:** completed
- **Tests:** 4 passing
- **Observations:**
  - Banco dev já tinha uma tabela `videos` órfã (schema antigo, com `source_extension`/CHECK constraint, sem `title`) e uma linha correspondente na tabela `migrations` (`CreateVideos1789666232485`) sem arquivo de migration no disco — residual da implementação anterior descartada (mesma achada na SI-03.1). Seguido o procedimento documentado em `.claude/rules/typeorm-migrations.md` § "Recovering from synchronize Residue": drop da tabela órfã (continha 1 linha de teste manual, `READY`/`mp4`, 2026-09-18 — não é dado real), remoção da linha órfã em `migrations`, regeneração limpa da migration (`CREATE TABLE` em vez de `ALTER`).
  - Campos do TS em camelCase (conforme literal do plano, ex. `channelId`, `uploadCompletedAt`) mapeados para colunas snake_case via `@Column({ name: '...' })`, para manter a convenção de nomes de coluna já estabelecida em `users`/`channels` (que usam propriedades TS já em snake_case, sem naming strategy global configurada).
  - Adicionado `@OneToMany(() => Video, ...)` em `Channel` (lado inverso da relação, per regra "always define both sides").
  - `cleanAllTables` (helper compartilhado de testes) atualizado para truncar `videos` também.

### SI-03.4 — Infra: Redis + módulo de fila BullMQ
- **Status:** completed
- **Tests:** 1 passing
- **Observations:**
  - `.env`/`.env.example` já tinham `QUEUE_REDIS_HOST`/`QUEUE_REDIS_PORT` (nomes divergentes) e `VIDEO_PROCESSING_MAX_ATTEMPTS`/`VIDEO_PROCESSING_BACKOFF_DELAY_MS` (não fazem parte do contrato desta SI — o plano fixa `attempts:3`/backoff exponencial `delay:1000` hardcoded, não configurável por env) — renomeado para `REDIS_HOST`/`REDIS_PORT` (nomes literais do texto do plano) e removidas as duas vars não usadas.
  - Porta 6379 já estava ocupada no host por um container `redis` de outro projeto — removido o bind de porta do serviço `redis` deste compose (não é necessário: acesso é só via rede interna do Compose, diferente do MinIO que precisa ser alcançável pelo browser).
  - AC "queue.add() com Redis indisponível rejeita rápido" não tem teste dedicado na Tests table da SI (só o compilation test) — garantida arquiteturalmente por `enableOfflineQueue: false` + `maxRetriesPerRequest: 1`, comportamento confirmado via Context7 (ioredis README/RedisOptions.ts) nesta sessão.

### SI-03.5 — Serviço de entrega: URLs assinadas streaming/download
- **Status:** completed
- **Tests:** 4 passing
- **Observations:**
  - Criada `VideoNotFoundException` (exceção de domínio, não HTTP) já nesta SI — necessária para o próprio `VideoDeliveryService` funcionar (busca por id pode falhar); SI-03.6 vai reutilizá-la no controller, não recriar.
  - Testes de GET real (download/range) assinam a URL contra o endpoint **interno** (`STORAGE_ENDPOINT`, alcançável via rede do Compose), não o público (`STORAGE_PUBLIC_ENDPOINT=http://localhost:9000`, que dentro do próprio container de teste resolveria para o container `nestjs-api`, não o MinIO) — mesmo padrão documentado nas decisões da fase (TD-02) para testes de rede real.
  - `PUBLIC_S3_CLIENT` adicionado ao `StorageModule` (token de DI distinto de `INTERNAL_S3_CLIENT`, per TD-01/TD-02).

### SI-03.6 — Endpoints de streaming e download
- **Status:** completed
- **Tests:** 10 passing (E2E, via /plan-test-specs spec `nestjs-project/specs/video-delivery.plan.md`)
- **Observations:**
  - Achado (via `tsc --noEmit`, rodado pela primeira vez nesta fase): `storage.config.ts` tinha 4 campos obrigatórios (`publicEndpoint`, `region`, `accessKeyId`, `secretAccessKey`) tipados implicitamente como `string | undefined` (sem fallback), quebrando a construção do `S3Client` (`AwsCredentialIdentity.accessKeyId` exige `string`). Corrigido com cast `as string` documentado (garantia real vem do Joi `.required()` em `env.validation.ts`) — dívida oculta desde SI-03.1, só capturada agora porque `tsc --noEmit` nunca tinha sido rodado explicitamente nesta fase (os testes `ts-jest` não pegaram, aparentemente não fazem type-check completo). A partir de agora vou rodar `tsc --noEmit` a cada SI, não só ao final.
  - `VideoNotFoundException` (criada na SI-03.5) não seguia o padrão de exceção de domínio do projeto (`DomainException extends Error` com `errorCode`/`httpStatus`, capturada pelo `DomainExceptionFilter` global) — era um `Error` puro, nunca seria mapeada para HTTP e resultaria em 500. Corrigido para estender `DomainException`; `VideoNotReadyException` (nova) já nasce seguindo o padrão correto.
  - `VideoDeliveryService.findVideoOrThrow` (privado) tornado público (`getVideoOrThrow`) para o controller reusar a mesma busca antes de decidir o gate de prontidão — sem duplicar a exceção de domínio em dois lugares.
  - Teste E2E autorado via Step 3a (JIT spec read) do `/implement`, a partir de `nestjs-project/specs/video-delivery.plan.md` — 1 `describe('videos')` com 10 `test()`/`it.each()` (não describes aninhados por grupo, per convenção do pipeline spec-driven).

### SI-03.7 — Módulo de upload: tus mount + criação de rascunho
- **Status:** completed
- **Tests:** 16 passing (9 unit + 7 integration, incluindo teste real de resumabilidade com destruição de socket no meio do PATCH)
- **Observations:**
  - Assinatura real de `onUploadCreate`/`onIncomingRequest` na versão instalada (`@tus/server@1.x`) diverge da doc do Context7: recebe `(req, res, upload)` e retorna `{ res, metadata? }` (não `(req, upload) => { metadata? }` como a doc mostrava) — confirmado direto no `.d.ts` instalado, já que o `tsc --noEmit` pegou o erro imediatamente.
  - `Server.handle(req, res)` aceita só 2 argumentos (nunca chama `next()` — sempre resolve a resposta ele mesmo); o `TusMiddleware` só repassa `next` em caso de rejeição inesperada da Promise (`.catch(next)`).
  - Rotas do middleware exigem 2 entradas no `forRoutes` (Express 5 é mais estrito com wildcards): `'videos/upload'` (POST de criação) + `'videos/upload/{*splat}'` (PATCH/HEAD/DELETE subsequentes) — sintaxe `{*splat}` confirmada via doc oficial NestJS 11.
  - Criado `extractAuthenticatedUserId` (`src/upload/jwt-from-request.util.ts`) como helper standalone reutilizável — usado por `onUploadCreate` (esta SI) e será reaproveitado por `onIncomingRequest` na SI-03.8, evitando duplicar a lógica de verificação JWT fora do pipeline de guards do Nest.
  - Nesta SI isoladamente, `onUploadCreate` extrai/verifica o JWT mas não trata formalmente "token ausente/inválido" com um 401 dedicado (isso é responsabilidade exclusiva de `onIncomingRequest`, per Error Catalog do plano, que roda ANTES na cadeia de hooks tus a partir da SI-03.8) — comportamento transitório aceitável já que SI-03.8 é a próxima SI desta mesma sessão.
  - `Upload-Metadata` decodificado usa `Buffer.from(...).toString('base64')` por par chave/valor nos testes — formato confirmado do protocolo tus.

### SI-03.8 — Auth boundary em todos os requests tus
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-03.9 — Enfileiramento do job ao concluir upload
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-03.10 — Infra: binários FFmpeg/FFprobe na imagem do worker
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-03.11 — Bootstrap do worker: entrypoint, processor, PROCESSING/no-op
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-03.12 — Worker: download para temp dir com preflight e limpeza
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-03.13 — Worker: validação autoritativa de formato via FFprobe
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-03.14 — Worker: metadados, thumbnail e transição para READY
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-03.15 — Worker: handler @OnWorkerEvent('failed') → FAILED
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-03.16 — Reconciliation sweep (3 branches)
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-03.17 — Documentação: CLAUDE.md (nestjs-project + raiz)
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-03.18 — Worker: graceful shutdown
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-03.19 — tus termination (DELETE) escopo restrito
- **Status:** pending
- **Tests:** no tests
- **Observations:** none
