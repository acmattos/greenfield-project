# phase-03-upload-processing — Progress

**Status:** completed
**SIs:** 19/19 completed

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
- **Status:** completed
- **Tests:** 23 passing (15 unit + 8 integração) + 7 de regressão (SI-03.7) confirmados sem quebra
- **Observations:**
  - Bug real encontrado e corrigido durante esta SI: `onIncomingRequest(req, res, uploadId)` — para uma requisição `POST` de criação, o `PostHandler` do `@tus/server` passa como `uploadId` o UUID **recém-gerado** pelo `namingFunction` (não uma string vazia, como eu havia presumido ao ler só o `.d.ts`). Minha checagem original `if (!uploadId) return` nunca detectava o caso de criação corretamente, e caía na checagem de ownership contra um `Video` que ainda não existe → 404 espúrio em todo `POST` autenticado. Corrigido para checar `req.method === 'POST'` explicitamente. Diagnosticado lendo o código-fonte real instalado (`node_modules/@tus/server/dist/handlers/PostHandler.js`), não a documentação — a chamada `onIncomingRequest(req, res, id)` acontece **depois** de `id = await namingFunction(...)` no código real.
  - Um subagent despachado para rodar os testes tentou "consertar" o bug por conta própria (mudou `upload.module.ts` para uma sintaxe de rota alternativa, sem resolver a causa real) — revertido; a correção real foi feita por mim após diagnosticar com um script ad-hoc (`ts-node` + `fetch` direto contra a app de teste) que expôs o body/status HTTP reais.
  - `Server.handle(req,res)` real (código-fonte lido) não implementa `onIncomingRequest` no nível do `Server` — cada `Handler` (Post/Patch/Head/Delete/Get) o invoca individualmente, cada um resolvendo `id` à sua própria maneira; confirmado empiricamente, não presumido a partir do `.d.ts`.

### SI-03.9 — Enfileiramento do job ao concluir upload
- **Status:** completed
- **Tests:** 17 unit (arquivo compartilhado com SI-03.7/03.8) + 2 integração
- **Observations:**
  - Achado e limpo `nestjs-project/dist/` — build output obsoleto (gitignored, nunca commitado) da implementação anterior descartada (via git reflog, achada na SI-03.1), com arquivos como `dist/videos/videos-upload.controller.js` que não têm nenhuma correspondência no `src/` atual (estrutura antiga, ex. `src/modules/channels/...`, diferente da atual `src/channels/...`). Um subagent de teste caiu nesse `dist/` obsoleto ao resolver módulos, causando um `TypeError` enganoso; `rm -rf dist/` resolveu (100% regenerável via `npm run build`).
  - Erro de teste próprio (não de produção): meu primeiro rascunho do teste de integração criava uma `Queue` "solta" via `new Queue(name, {connection})`, sem as `defaultJobOptions` que só existem na instância registrada pelo `QueueModule` real — por isso `job.opts.attempts` vinha `0` em vez de `3`. Corrigido usando `Test.createTestingModule({imports:[QueueModule]})` + `getQueueToken()` para obter a Queue real via DI, em vez de duplicar a config manualmente no teste.

### SI-03.10 — Infra: binários FFmpeg/FFprobe na imagem do worker
- **Status:** completed
- **Tests:** 2 passing (rodados dentro da imagem do worker)
- **Observations:**
  - Fonte escolhida para o Option C (TD-04): imagem `mwader/static-ffmpeg` (binários estáticos multi-arch), pinada por digest real resolvido via `docker pull`+`docker images --digests` (não um valor inventado) — `sha256:028fb402231d4f5f2223c67fca5d0abc04f5a38cffcbadf9844f06985e2259b8`. Binários copiados via multi-stage `COPY --from=` para `/usr/local/bin/ffmpeg`/`/usr/local/bin/ffprobe` (paths já presentes em `.env` como `FFMPEG_PATH`/`FFPROBE_PATH`, ainda não validados no Joi schema — isso é escopo da SI que efetivamente consome essas envs).
  - Criado `Dockerfile.worker` (novo) + serviço `worker` no `compose.yaml` (`depends_on` db/minio/redis saudáveis) — infraestrutura mínima necessária para o smoke test rodar; o bootstrap real do processo (entrypoint Node, processor) é escopo da SI-03.11.
  - Confirmado ativamente (não só por construção) que a imagem da API não tem os binários: `docker compose exec nestjs-api which ffmpeg` retorna exit 1.

### SI-03.11 — Bootstrap do worker: entrypoint, processor, PROCESSING/no-op
- **Status:** completed
- **Tests:** 8 passing
- **Observations:**
  - `nest build` compila TODO o `src/` (não é baseado em um único entry point tipo Webpack), então `dist/worker/main.js` foi gerado automaticamente ao lado de `dist/main.js` sem precisar editar `nest-cli.json` — confirmado empiricamente após `npm run build`.
  - Erro real encontrado ao subir o worker pela primeira vez: `TypeORMError: Entity metadata for Video#channel was not found`. `autoLoadEntities: true` só resolve metadados de uma entidade se ALGUM módulo a registra via `TypeOrmModule.forFeature([...])` — o `WorkerModule` registrava só `Video`, mas a relação `@ManyToOne(() => Channel)` exige que `Channel` (e, por cascata, `User`, via `Channel`'s `@OneToOne`) também estejam registradas, mesmo sem uso direto de `Repository<Channel>`/`Repository<User>` no worker. Corrigido: `TypeOrmModule.forFeature([Video, Channel, User])`.
  - `WorkerModule` é standalone (bootstrap próprio via `NestFactory.createApplicationContext`, não reusa `AppModule`) — tem seu próprio `ConfigModule.forRoot` (mesmo `envValidationSchema` compartilhado) e `BullModule.forRootAsync` com a conexão **consumer** (`maxRetriesPerRequest: null`), nunca a conexão producer fail-fast da API.
  - `@Processor(name, {concurrency})`'s `workerOptions` é resolvido em tempo de decoração de classe (import do módulo), antes do container de DI existir — `WORKER_CONCURRENCY` é lido diretamente de `process.env` no nível do módulo, não via `ConfigService` injetado.
  - Capacity check confirmada rodando de verdade no container: log real "Worker temp volume capacity check passed: 608319909888 bytes available (>= 11274289152 required)" — valor bate com `1 × 10737418240 (MAX_UPLOAD_BYTES) + 536870912 (WORKER_TEMP_MARGIN_BYTES)`.
  - Serviço `worker` adicionado ao `compose.yaml` com `command: node dist/worker/main.js` (diferente do padrão `tail -f /dev/null` da API — o worker roda o processo real, não fica ocioso para exec manual), volume dedicado `worker-temp:/tmp/videos`, healthcheck de processo (`pgrep`), `depends_on` com `service_healthy` em db/minio/redis.

### SI-03.12 — Worker: download para temp dir com preflight e limpeza
- **Status:** completed
- **Tests:** 8 unit + 2 integração
- **Observations:**
  - Achado retroativo da SI-03.11: `.env` tinha `WORKER_TEMP_OVERHEAD_BYTES` (nome antigo, herdado da tentativa descartada), mas o plano e meu código sempre usaram `WORKER_TEMP_MARGIN_BYTES` — o valor default (536870912) coincidia, mascarando a divergência de nome (a var errada nunca era lida; o fallback hardcoded sempre "salvava"). Corrigido `.env`; `.env.example` também recebeu as vars `WORKER_*`/`FFMPEG_PATH`/`FFPROBE_PATH` que faltavam desde a SI-03.10/03.11.
  - Bug real: `WorkerTempStorageService.downloadToTempDir` chamava `statfs(WORKER_TEMP_DIR)` sem garantir que o diretório existisse primeiro — funcionava no container `worker` real só porque `WorkerCapacityCheckService` (SI-03.11) já tinha criado o diretório durante o bootstrap; nos testes (que instanciam o serviço isoladamente) isso quebrava com `ENOENT`. Corrigido tornando o serviço autocontido (`mkdir` do diretório pai antes do `statfs`, não dependente de outro serviço ter rodado antes).
  - `jest.spyOn` não funciona em named exports de módulos nativos do Node (`fs/promises`'s `statfs` é não-configurável) — `TypeError: Cannot redefine property`. Corrigido com `jest.mock('fs/promises', () => ({...jest.requireActual(...), statfs: jest.fn(...)}))`, mantendo `mkdir`/`rm`/`readFile` reais e só `statfs` mockável.
  - Teste de integração da checagem de espaço insuficiente usa `HeadObjectCommand` real contra MinIO (ContentLength real) mas `statfs` mockado com baixo espaço — simular exaustão real de disco num test run não é prático.

### SI-03.13 — Worker: validação autoritativa de formato via FFprobe
- **Status:** completed
- **Tests:** 17 unit + 4 integração (2 desta SI + 2 de regressão confirmadas)
- **Observations:**
  - Discriminador de container investigado empiricamente (não adivinhado): gerei MP4 e MOV reais via `ffmpeg` dentro do container worker e comparei a saída real do `ffprobe`. Confirmado: `format.format_name`/`format_long_name` são **byte-idênticos** para MP4 e MOV (mesmo demuxer `mov,mp4,m4a,3gp,3g2,mj2`) — não servem de discriminador. Único campo que diferencia é `format.tags.major_brand` ("isom" para MP4 real, "qt  " para MOV real). Como o texto do plano proíbe uma ALLOWLIST de brands MP4 (variam por encoder, ficam obsoletas), usei um DENYLIST de um único valor estável (`major_brand !== 'qt'`) — QuickTime nativo tem exatamente essa marca fixa desde a spec original, ao contrário dos brands MP4 que variam.
  - Bug real (não de teste): container `worker` roda `node dist/worker/main.js` como processo principal (PID 1) desde a SI-03.11, e esse processo **nunca foi reiniciado** após mudanças subsequentes no código — ficou rodando uma versão desatualizada, competindo pela mesma fila Redis com os workers instanciados dentro dos testes de integração. Isso mascarou completamente a primeira rodada de testes (job "completava" usando lógica antiga). Lição: a partir de agora, sempre `npm run build` + `docker compose restart worker` após qualquer mudança em `src/worker/**` antes de rodar testes de integração que dependem da fila real.
  - Segundo bug real: `EACCES: permission denied` ao criar subdiretórios em `/tmp/videos` — o volume Docker nomeado (`worker-temp`) foi criado como `root:root` na primeira montagem (SI-03.11), mas o processo roda como usuário `node` (não-root). Corrigido no `Dockerfile.worker` (`chown node:node /tmp/videos` antes do `USER node` — Docker propaga essa permissão ao popular um volume nomeado vazio pela primeira vez); volume recriado do zero para aplicar a correção.
  - Teste "UnrecoverableError realmente não retry" não pode usar `jest.spyOn` numa instância de processor obtida via DI de teste, já que o worker real (PID 1) compete pela mesma fila e pode processar o job com sua própria instância — usei `job.attemptsMade` (observável via Redis, independente de qual processo pegou o job) em vez de contar chamadas de spy.
  - Diagnóstico de ambos os bugs feito via scripts `ts-node` ad-hoc executados diretamente no container (mais rápido e preciso que iterar via subagents de teste).

### SI-03.14 — Worker: metadados, thumbnail e transição para READY
- **Status:** completed
- **Tests:** 14 unit + 4 integração (2 novos desta SI + 2 de regressão confirmadas)
- **Observations:**
  - `extractVideoMetadata`/`resolveThumbnailTimestampSeconds` (novo `video-metadata-extractor.ts`) reutilizam o MESMO `FfprobeOutput` já obtido pela validação de formato da SI-03.13 — nenhuma segunda chamada a `ffprobe`. `durationSeconds`/`bitRate` persistidos como inteiros arredondados (`format.duration`/`format.bit_rate`, ambos strings no output do ffprobe), mas o timestamp da thumbnail usa a duração bruta (não arredondada) — evita risco de estourar o fim do vídeo em clipes muito curtos (ex.: duração real 1.0s arredondaria para 1, mas `min(2, 1.0/2) = 0.5` usa o valor exato).
  - Geração de thumbnail via `ffmpeg -ss <ts> -i <path> -frames:v 1 -f image2pipe -vcodec mjpeg -` com output direto no stdout (sem arquivo intermediário) — comando validado empiricamente no container (bytes retornados começam com o magic number JPEG `ff d8`, confirmado também no teste de integração).
  - Discriminador de container (SI-03.13) mantido reaproveitado sem alteração; `VideoProcessorPort`/`FfmpegVideoProcessorAdapter` ganharam só o método novo `extractThumbnail`, ambos via `spawn` array-form + `shell: false` (mesmo padrão de segurança do `probe`).
  - Nenhum bug de produção novo encontrado nesta SI — código e testes (unit + integração) passaram de primeira depois do rebuild+restart do worker (lição da SI-03.13 aplicada preventivamente desta vez).

### SI-03.15 — Worker: handler @OnWorkerEvent('failed') → FAILED
- **Status:** completed
- **Tests:** 18 unit + 6 integração (2 novos desta SI + 4 de regressão confirmadas)
- **Observations:**
  - `persistTerminalFailure` é o único ponto do worker que escreve `processingStatus: 'FAILED'` — chamado tanto pelo handler `@OnWorkerEvent('failed')` (evento ao vivo) quanto, futuramente, pela sweep de reconciliação (SI-03.16), per a revisão de `upload-processing/TD-10`. `isFinal` computado como `error instanceof UnrecoverableError || job.attemptsMade >= job.opts.attempts` — confirmado empiricamente via script ad-hoc que `job.opts.attempts` e `job.attemptsMade` chegam corretamente populados no callback do evento `failed` do BullMQ (`attemptsMade` já pós-incrementado no momento do evento).
  - Bug de construção de teste (não de produção), achado e corrigido via investigação empírica: meus dois testes de integração novos usavam `queue.add(..., { jobId, attempts: 3 })` sem `backoff` explícito. A fila registrada pelo `WorkerModule` (`BullModule.registerQueue({name: VIDEO_PROCESSING_QUEUE})`, sem `defaultJobOptions`) não define backoff — diferente da fila do lado producer (`queue.module.ts`, que define `backoff: {type:'exponential', delay:1000}`). Sem backoff explícito na chamada do teste, os 3 attempts se esgotavam em ~267ms (sem esperar entre tentativas), fazendo `processingStatus` virar `FAILED` quase instantaneamente e quebrando as duas asserções de "estado intermediário ainda é PROCESSING". Diagnosticado com 2 scripts `ts-node` ad-hoc (um isolado com `Queue`/`Worker` crus, outro reproduzindo o cenário real via `WorkerModule` + timestamps) — confirmou que `job.opts.attempts`/`attemptsMade` estavam corretos, isolando a causa ao backoff ausente. Corrigido passando `backoff: {type:'exponential', delay:1000}` explicitamente nos dois `queue.add()` dos testes novos (mesmo valor real de produção).
  - Handler assíncrono registrado via `@OnWorkerEvent` roda fire-and-forget (a lib não aguarda a Promise) — confirmado via Context7 (`nestjs/bull` `bull.explorer.ts`); os testes de integração compensam isso fazendo polling do estado real (Redis `job.getState()`/`attemptsMade` e a linha do `Video` no Postgres) em vez de assumir sincronicidade.

### SI-03.16 — Reconciliation sweep (3 branches)
- **Status:** completed
- **Tests:** 5 integração (branches 1/2/3 + ciclo completo + corrida real) + 22 de regressão confirmadas (queue.module, orphan-sweep, video-processing.processor)
- **Observations:**
  - Achado real: os jobs reenfileirados pela sweep usavam `queue.add()` sem `attempts`/`backoff` explícitos. A fila do `WorkerModule` (onde o `ReconciliationSweepService` vive) não tem `defaultJobOptions` — diferente da fila producer em `queue.module.ts` — então um job reenfileirado pela sweep silenciosamente perderia a resiliência de retry (attempts:3 + backoff exponencial) que o enqueue original tem. Corrigido extraindo `VIDEO_PROCESSING_JOB_OPTIONS` (attempts, backoff, removeOnComplete, removeOnFail) como constante compartilhada em `queue.constants.ts`, usada tanto por `queue.module.ts` quanto pelo `enqueueProcessing` da sweep — mesmo contrato de resiliência para os dois producers, per `upload-processing/TD-11`.
  - Branch 3 (reparo de FAILED perdido) testado sem depender de timing real do `@OnWorkerEvent('failed')` ao vivo: o `Video` de teste é marcado `PROCESSING` diretamente via repository, e o job real que falha em BullMQ tem `job.data.videoId` apontando para um UUID **inexistente** (não o vídeo de teste) — assim o listener ao vivo (que roda de verdade, competindo com o processo PID-1 do container) escreve `FAILED` no id inexistente (0 linhas afetadas, tolerado por design), nunca tocando o vídeo real sendo testado. Isso isola deterministicamente "o listener não rodou para este vídeo" sem qualquer race artificial.
  - Env var solta encontrada em `.env` (`TUS_RECONCILIATION_INTERVAL_MS`, sem validação no Joi schema, sob o comentário errado de "tus protocol" — a sweep roda no processo **worker**, não no tus/API) — renomeada para `WORKER_RECONCILIATION_INTERVAL_MS` e movida para a seção Worker; adicionado também `WORKER_RECONCILIATION_GRACE_PERIOD_MS` (default 3600000 = 1h, per TD-11's revision "on the order of an hour"). Ambas agora validadas em `env.validation.ts` e lidas via `worker.config.ts`.
  - Bug de teste (não de produção), achado após rodar os testes: dois dos cinco testes ("ciclo completo" e "corrida real") criavam o `Video` com `sourceStorageKey: randomUUID()` mas faziam upload do arquivo real na chave `video.id` — chaves diferentes, então o processor real baixava da chave errada e falhava nas 3 tentativas (~3.4s até `FAILED`). Corrigido com um helper `createUploadableVideo` que pré-gera o UUID e usa o mesmo valor como `id` E `sourceStorageKey`, replicando a correlação real de produção (`upload-processing/TD-11`: `sourceStorageKey` É `Video.id`, não um valor derivado). O branch 2's HeadObjectCommand (que sonda `Key: video.id` diretamente, não `sourceStorageKey`) mascarou esse mesmo bug de setup no primeiro teste daquele branch, sem quebrar o teste.
  - Registrado via `OnApplicationBootstrap` (mesmo padrão do `OrphanSweepService` de TD-07), com `setInterval` para reexecução periódica; o handle do interval é armazenado mas sua limpeza no shutdown fica para a SI-03.18, conforme o próprio plano já determina.

### SI-03.17 — Documentação: CLAUDE.md (nestjs-project + raiz)
- **Status:** completed
- **Tests:** no tests (SI de documentação)
- **Observations:**
  - `nestjs-project/CLAUDE.md`: serviços `minio`/`redis`/`worker` documentados na lista de Services (portas, healthchecks); novo comando de verificação de prontidão para MinIO/Redis; nova seção "Worker (Video Processing)" documentando a exigência de rebuild+restart antes de qualquer teste de integração (lição da SI-03.13) e o toolchain FFmpeg/FFprobe vendorizado (só existe na imagem do worker); nova seção "Environment Variables" cobrindo todos os grupos introduzidos pela fase (Storage, Queue, Upload limits, Worker).
  - `CLAUDE.md` raiz: `Message Queue (TBD)` atualizado para `Message Queue (Redis/BullMQ)`; nota adicionada confirmando que Object Storage, Message Queue e Video Worker estão implementados a partir da fase `upload-processing`.
  - Achado fora de escopo (não corrigido nesta SI, apenas observado): `.env` tem uma variável `TUS_UPLOAD_EXPIRATION_MS=86400000` que não é lida por nenhum código (`grep` não encontrou nenhum consumidor), não está validada em `env.validation.ts`, e não está em `.env.example` — provável resíduo não utilizado. Não documentada aqui por não corresponder a nenhum comportamento real; recomenda-se remover numa limpeza futura fora do escopo desta SI.

### SI-03.18 — Worker: graceful shutdown
- **Status:** completed
- **Tests:** 1 integração (novo) + 33 de regressão confirmadas (22 unit + 11 integração)
- **Observations:**
  - `app.enableShutdownHooks()` adicionado em `src/worker/main.ts` — o `@nestjs/bullmq`'s `BullExplorer.onApplicationShutdown` já fecha automaticamente todo `Worker`/conexão Redis registrado (confirmado lendo `node_modules/@nestjs/bullmq/dist/bull.explorer.js`); nenhum código manual foi necessário para essa parte, per Context7/leitura do código-fonte instalado.
  - `ReconciliationSweepService` ganhou `onModuleDestroy()` limpando o `setInterval` da sweep. Achado via leitura do código-fonte do NestJS (`node_modules/@nestjs/core/nest-application-context.js`): o comportamento default de `enableShutdownHooks()` (sem `useProcessExit`) roda todos os hooks e depois **reenvia o próprio sinal** ao processo (não chama `process.exit()`) — então tecnicamente o processo termina de qualquer forma mesmo sem limpar o interval. A limpeza continua necessária pelo motivo real: sem ela, a sweep poderia disparar uma nova tentativa **durante** a janela assíncrona em que os hooks de shutdown ainda estão rodando (fila/DB sendo fechados), lançando uma exceção não tratada contra uma conexão já meio-fechada — exatamente o que o AC "sem exceções não tratadas" proíbe.
  - Teste de integração (`worker-shutdown.integration-spec.ts`) spawna um **segundo** processo `node dist/worker/main.js` real (não o PID-1 do container) dentro do mesmo container `worker`, aguarda seu bootstrap completo (log da `WorkerCapacityCheckService`), envia `SIGTERM`, e confirma saída limpa sem exceções — nunca mexe no processo PID-1 real do container.
  - Achado empírico (via debug manual: `docker compose exec -d worker ...` + inspeção de `ps aux`): bootstrapar um SEGUNDO contexto Nest completo, concorrente com o processo PID-1 já rodando no mesmo container, é medidamente mais lento que uma instância isolada (~60-70s observados sob contenção de recursos deste ambiente, vs. poucas centenas de ms para uma instância solitária) — não é um travamento, apenas contenção real de CPU/IO. Timeout de leitura de stdout do teste ajustado de 15s para 90s, e o timeout do teste em si para 150s, para acomodar isso de forma realista.
  - Bug de teste (não de produção), 2 iterações: (1) minha primeira asserção verificava `exit.code === 0`, mas o comportamento *default* documentado do NestJS (confirmado lendo o código-fonte) é reenviar o sinal original em vez de chamar `process.exit()` — resultando em `code: null, signal: 'SIGTERM'`, não `code: 0`. Corrigido a asserção para o shape real e correto. (2) minha segunda tentativa adicionou um "piso" de tempo decorrido (`> 50ms`) como prova indireta de que os hooks realmente rodaram antes da saída — falhou com 23ms reais, porque o job de teste já tinha terminado de processar antes do `SIGTERM` chegar, então `worker.close()` não teve nada para esperar (comportamento correto, não um bug). Removida essa asserção frágil; a prova real e direta já estava nas duas asserções anteriores (`exit.signal === 'SIGTERM'` + nenhuma exceção não tratada nos logs) — se qualquer hook tivesse travado, o teste teria estourado o timeout de 150s em vez de produzir esse exit event limpo.
  - Um processo `node dist/worker/main.js` órfão (de uma execução anterior do teste que falhou antes de eu adicionar o bloco `try/finally`) ficou rodando no container durante a investigação — limpo manualmente via `kill`; o teste final já inclui `try/finally` garantindo que o processo filho spawnado é sempre encerrado, mesmo em caso de falha de asserção.

### SI-03.19 — tus termination (DELETE) escopo restrito
- **Status:** completed
- **Tests:** 2 integração (novos) + 34 de regressão confirmadas (todo o módulo `src/upload`)
- **Observations:**
  - `disableTerminationForFinishedUploads: true` já estava configurado desde a SI-03.7 — nenhuma mudança necessária ali. `S3Store.remove(id)` padrão reutilizado sem override (confirmado: aborta multipart + deleta objeto/`.info` num único call).
  - `EVENTS.POST_TERMINATE` fires **depois** do response 204 já ter sido escrito (confirmado lendo `node_modules/@tus/server/dist/handlers/DeleteHandler.js`: `this.write(res, 204, {})` roda antes de `this.emit(EVENTS.POST_TERMINATE, ...)`), e o EventEmitter não aguarda a Promise do listener — fire-and-forget, mesmo padrão do `@OnWorkerEvent` do BullMQ (SI-03.15). O teste de integração precisou fazer *polling* na remoção do `Video` (não pode assumir sincronicidade logo após o `.expect(204)`), mas a limpeza do **storage** É síncrona (`await this.store.remove(id)` roda antes do `write`), então essa parte pôde ser verificada imediatamente.
  - Resposta de `400 INVALID_TERMINATION` é texto puro do protocolo tus nativo (`'Cannot terminate an already completed upload'`, confirmado em `node_modules/@tus/utils/dist/constants.js`), fora do envelope JSON customizado do projeto — comportamento esperado per o texto do plano, teste assertado contra o texto exato, não um JSON parseado.
  - Nenhum bug de produção novo — implementação e testes passaram de primeira.

## Verificação final de fase (após SI-03.19)

Executada per o checklist de Deliverables do plano (`tsc`, lint, build, suítes completas, `docker compose up -d`). Achados e correções, todos fora do escopo estrito de uma SI individual mas necessários para o gate "suíte completa passa":

- **Lint:** corrigidos todos os erros presentes em arquivos tocados por esta fase (confirmado via `git diff` contra o ponto de branch — `queue`, `storage`, `test`, `upload`, `worker`, `videos`, `config`, `channels`). 189 problemas remanescentes no projeto são 100% débito pré-existente de fases anteriores (auth/mail/users/domain-exception-filter), confirmado não tocado por esta branch — fora de escopo, não corrigidos.
- **Regressão real (produção):** `Channel.videos` (relação `@OneToMany` adicionada na SI-03.3) quebrava 11 arquivos de teste de fases anteriores (auth/users/channels/database) que construíam seu próprio `DataSource` de teste com uma lista de entidades fixa sem `Video` — TypeORM exige que toda entidade referenciada por uma relação esteja no mesmo array de entidades para resolver metadados, mesmo sem `synchronize`. Corrigido adicionando `Video` à lista de entidades desses 11 arquivos.
- **Regressão real (teste pré-existente):** `env.validation.integration-spec.ts` (fase anterior, não tocado por upload-processing) tinha um baseline `requiredEnv` que não incluía os campos `STORAGE_*` que se tornaram `.required()` no Joi schema desde a SI-03.1 — toda chamada de validação passou a falhar. Corrigido adicionando os 4 campos STORAGE_* obrigatórios ao baseline.
- **Regressão real (teste pré-existente):** `migrations.integration-spec.ts` derrubava e recriava `channels`/`users`/etc. sem (a) derrubar o enum type `verification_tokens_type_enum` (que `DROP TABLE ... CASCADE` não remove) e (b) limpar a tabela `videos` antes de recriar `channels` — deixando o type órfão de uma execução anterior falha (causando `type already exists` na migration seguinte) e linhas de vídeo órfãs com `channel_id` apontando para channels já recriados com UUIDs novos (causando falha de FK constraint em qualquer suíte subsequente com `synchronize: true`). Corrigido com `DROP TYPE IF EXISTS ... CASCADE` e `DELETE FROM videos` explícitos no `beforeAll`.
- **Flakiness pré-existente (timeout):** `auth.service.integration-spec.ts`, `app.e2e-spec.ts`, `swagger.e2e-spec.ts`, `videos.e2e-spec.ts` usavam o timeout default do Jest (5000ms) para hooks que compilam um `AppModule`/`TestingModule` completo com DB real — insuficiente sob carga, especialmente porque o grafo de módulos do `AppModule` cresceu com os módulos desta fase (upload/storage/queue). Corrigido com `jest.setTimeout(30000)` nesses 4 arquivos.
- **Gap pré-existente no script (`package.json`):** `test:e2e` não tinha `--runInBand`, diferente de `test:integration` — como todas as suítes e2e compartilham o mesmo banco de teste real (mesma regra já documentada em `nestjs-project/CLAUDE.md`), rodá-las em paralelo causava falhas não-determinísticas (times diferentes falhando a cada execução). Corrigido adicionando `--runInBand` ao script.
- **Processos órfãos:** múltiplas execuções de teste anteriores nesta sessão (via subagents) deixaram processos `jest`/`npm test` zumbis rodando dentro do container `nestjs-api`, competindo pelo mesmo banco de teste e causando aparência de travamento em execuções posteriores. Identificados via `ps aux` + `pg_stat_activity` e encerrados manualmente; `--forceExit` passou a ser usado nas execuções finais para evitar recorrência.

**Resultado final:**
- `tsc --noEmit`: limpo.
- Build: `dist/main.js` + `dist/worker/main.js` gerados.
- Suíte unit+integration (`nestjs-api`, `--runInBand --forceExit`): 44/48 suítes, 231/242 testes — as 4 suítes/11 testes restantes são os que exigem FFmpeg real (por design, TD-04, só existe na imagem do worker).
- Suíte de integração com FFmpeg real (`worker`): 4/4 suítes, 14/14 testes.
- E2E (`nestjs-api`, `--runInBand --forceExit`): 4/4 suítes, 62/62 testes.
- `docker compose up -d`: todos os 6 serviços `Up`; os 4 com healthcheck definido (`db`, `minio`, `redis`, `worker`) reportam `healthy`; `nestjs-api` não tem healthcheck configurado por design (container fica pronto para `exec`, servidor dev só sobe quando pedido explicitamente).
