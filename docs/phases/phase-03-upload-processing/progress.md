# phase-03-upload-processing — Progress

**Status:** in_progress
**SIs:** 2/19 completed

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
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-03.4 — Infra: Redis + módulo de fila BullMQ
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-03.5 — Serviço de entrega: URLs assinadas streaming/download
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-03.6 — Endpoints de streaming e download
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-03.7 — Módulo de upload: tus mount + criação de rascunho
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

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
