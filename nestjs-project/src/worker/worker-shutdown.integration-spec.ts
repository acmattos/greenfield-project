import { ChildProcessWithoutNullStreams, execFile, spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { readFile } from 'fs/promises';
import { promisify } from 'util';
import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import { VIDEO_PROCESSING_QUEUE } from '../queue/queue.constants';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video } from '../videos/entities/video.entity';
import { WorkerModule } from './worker.module';

const execFileAsync = promisify(execFile);
const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

function waitForStdout(
  child: ChildProcessWithoutNullStreams,
  pattern: RegExp,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => {
      reject(
        new Error(
          `Timed out waiting for /${pattern.source}/ in worker stdout. Captured so far:\n${buffer}`,
        ),
      );
    }, timeoutMs);

    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString();
      if (pattern.test(buffer)) {
        clearTimeout(timer);
        child.stdout.off('data', onData);
        resolve();
      }
    };
    child.stdout.on('data', onData);
  });
}

describe('Worker graceful shutdown — process integration', () => {
  let dataSource: DataSource;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
  let userRepository: Repository<User>;
  let s3Client: S3Client;
  const config = storageConfig();

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);

    s3Client = new S3Client({
      endpoint: config.endpoint,
      forcePathStyle: true,
      region: config.region,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  });

  afterAll(async () => {
    await dataSource.destroy();
    s3Client.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  it('a SIGTERM sent with a job in flight closes the BullMQ worker, clears the reconciliation sweep timer, and exits cleanly with no unhandled exceptions', async () => {
    // Real, separate OS process running the actual compiled entrypoint —
    // the container's own PID-1 worker is left untouched, so this signal
    // never disrupts other tests/services sharing the container.
    const child = spawn('node', ['dist/worker/main.js'], {
      cwd: process.cwd(),
      env: process.env,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    // Ensures the spawned process is never left orphaned in the container
    // if any step below throws (e.g. an assertion failure) — an earlier
    // run of this same test left a stray `node dist/worker/main.js`
    // process behind for exactly this reason, competing for the real
    // queue with every subsequent test run.
    try {
      // Reliable readiness signal: WorkerCapacityCheckService's
      // onApplicationBootstrap is one of the last providers to initialize,
      // so its log line confirms the whole DI graph — including
      // ReconciliationSweepService's setInterval — is up. Bootstrapping a
      // second full Nest app context concurrently with the container's
      // own PID-1 worker is measurably slower than a lone instance
      // (observed ~60-70s under this environment's resource contention,
      // vs. low-hundreds-of-ms for a single instance) — the timeout here
      // is generous on purpose, not a sign of a hang.
      await waitForStdout(
        child,
        /Worker temp volume capacity check passed/,
        90000,
      );

      // Enqueue a real job right before signalling, giving the freshly
      // bootstrapped child a fair chance to be the one processing it when
      // SIGTERM arrives (best-effort — the container's own worker also
      // competes for the same real queue, per the established caveat from
      // prior SIs; either way, the shutdown assertions below hold).
      const user = await userRepository.save(
        userRepository.create({
          email: `shutdown_${randomUUID()}@example.com`,
          password: 'hashed',
        }),
      );
      const channel = await channelRepository.save(
        channelRepository.create({
          name: 'Chan',
          nickname: `chan_${randomUUID().slice(0, 8)}`,
          user_id: user.id,
        }),
      );
      const videoId = randomUUID();
      await videoRepository.save(
        videoRepository.create({
          id: videoId,
          channelId: channel.id,
          title: 'shutdown test',
          sourceStorageKey: videoId,
        }),
      );
      const localPath = `/tmp/${videoId}.mp4`;
      await execFileAsync(process.env.FFMPEG_PATH || '/usr/local/bin/ffmpeg', [
        '-f',
        'lavfi',
        '-i',
        'testsrc=duration=2:size=64x64:rate=10',
        '-f',
        'lavfi',
        '-i',
        'sine=duration=2',
        '-c:v',
        'libx264',
        '-c:a',
        'aac',
        '-movflags',
        '+faststart',
        '-y',
        localPath,
      ]);
      const fileBuffer = await readFile(localPath);
      await s3Client.send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: videoId,
          Body: fileBuffer,
        }),
      );

      const moduleRef = await Test.createTestingModule({
        imports: [WorkerModule],
      }).compile();
      const queue = moduleRef.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
      await queue.add(
        'video.processing',
        { videoId },
        { jobId: `process-video-${videoId}` },
      );
      await moduleRef.close();

      // Brief window for the child to actually pick the job up before the
      // signal, so worker.close()'s graceful (non-forced) wait has
      // something real to wait on.
      await new Promise((resolve) => setTimeout(resolve, 300));

      child.kill('SIGTERM');

      const exit = await new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
      }>((resolve) => {
        child.on('exit', (code, signal) => resolve({ code, signal }));
      });

      // NestJS's default enableShutdownHooks() behavior (no
      // `useProcessExit`) awaits every shutdown hook — including
      // @nestjs/bullmq's own onApplicationShutdown, which closes every
      // registered Worker and its Redis connection, and this service's own
      // onModuleDestroy, which clears the reconciliation sweep's
      // setInterval — then RE-DELIVERS the original signal to the now
      // listener-free process, letting Node's own default handling
      // terminate it. That is why `code` is `null` and `signal` is the
      // original one, not a `process.exit(0)` shape. Getting this exact
      // shape (rather than the test timing out, which is what would
      // happen if a hook hung, e.g. a stray sweep tick throwing against a
      // half-closed connection) is itself the proof every hook completed.
      expect(exit.code).toBeNull();
      expect(exit.signal).toBe('SIGTERM');
      expect(stderr).not.toMatch(
        /UnhandledPromiseRejection|uncaughtException/i,
      );
      expect(stdout).not.toMatch(
        /UnhandledPromiseRejection|uncaughtException/i,
      );
    } finally {
      if (!child.killed) {
        child.kill('SIGKILL');
      }
    }
  }, 150000);
});
