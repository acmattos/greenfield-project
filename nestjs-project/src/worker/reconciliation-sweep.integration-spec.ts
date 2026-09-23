import { execFile } from 'child_process';
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
import {
  VIDEO_PROCESSING_JOB_OPTIONS,
  VIDEO_PROCESSING_QUEUE,
} from '../queue/queue.constants';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video, VideoProcessingStatus } from '../videos/entities/video.entity';
import { ReconciliationSweepService } from './reconciliation-sweep.service';
import { WorkerModule } from './worker.module';

const execFileAsync = promisify(execFile);
const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

async function waitUntil(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs = 200,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

describe('ReconciliationSweepService — worker integration', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
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

  async function createChannelForNewUser(): Promise<Channel> {
    const user = await userRepository.save(
      userRepository.create({
        email: `sweep_${randomUUID()}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: 'Chan',
        nickname: `chan_${randomUUID().slice(0, 8)}`,
        user_id: user.id,
      }),
    );
  }

  // sourceStorageKey must literally equal Video.id, per upload-processing/
  // TD-11's bare-UUID identifier correlation — the reconciliation sweep's
  // own Branch 2 HeadObjectCommand check probes `Key: video.id` directly,
  // and the real processor downloads from `video.sourceStorageKey`; a test
  // row whose id and sourceStorageKey differ silently breaks both.
  async function createUploadableVideo(
    channel: Channel,
    title: string,
  ): Promise<Video> {
    const id = randomUUID();
    return videoRepository.save(
      videoRepository.create({
        id,
        channelId: channel.id,
        title,
        sourceStorageKey: id,
      }),
    );
  }

  async function backdateUpdatedAt(
    videoId: string,
    hoursAgo: number,
  ): Promise<void> {
    await dataSource.query(
      `UPDATE videos SET updated_at = NOW() - ($1 || ' hours')::interval WHERE id = $2`,
      [hoursAgo, videoId],
    );
  }

  async function uploadRealVideoFile(
    key: string,
    durationSeconds: number,
  ): Promise<void> {
    const localPath = `/tmp/${key}.mp4`;
    await execFileAsync(process.env.FFMPEG_PATH || '/usr/local/bin/ffmpeg', [
      '-f',
      'lavfi',
      '-i',
      `testsrc=duration=${durationSeconds}:size=64x64:rate=10`,
      '-f',
      'lavfi',
      '-i',
      `sine=duration=${durationSeconds}`,
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
        Key: key,
        Body: fileBuffer,
      }),
    );
  }

  it('Branch 1: re-enqueues a Video stuck at UPLOADING with uploadCompletedAt already set; leaves a Video without uploadCompletedAt untouched; a second sweep does not duplicate the job', async () => {
    const channel = await createChannelForNewUser();
    const completed = await videoRepository.save(
      videoRepository.create({
        channelId: channel.id,
        title: 'branch1 completed',
        sourceStorageKey: randomUUID(),
        uploadCompletedAt: new Date(),
      }),
    );
    const stillUploading = await videoRepository.save(
      videoRepository.create({
        channelId: channel.id,
        title: 'branch1 still uploading',
        sourceStorageKey: randomUUID(),
      }),
    );

    const moduleRef = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();
    const sweepService = moduleRef.get(ReconciliationSweepService);
    const queue = moduleRef.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));

    await sweepService.sweep();

    const job = await queue.getJob(`process-video-${completed.id}`);
    expect(job).toBeDefined();

    const untouchedJob = await queue.getJob(
      `process-video-${stillUploading.id}`,
    );
    expect(untouchedJob).toBeUndefined();
    const untouchedRow = await videoRepository.findOneBy({
      id: stillUploading.id,
    });
    expect(untouchedRow!.processingStatus).toBe(
      VideoProcessingStatus.UPLOADING,
    );
    expect(untouchedRow!.uploadCompletedAt).toBeNull();

    // Second sweep: BullMQ's own jobId uniqueness silently no-ops the
    // duplicate add() while the original job is still in the queue.
    await sweepService.sweep();
    const jobsById = await queue.getJobs([
      'waiting',
      'active',
      'delayed',
      'completed',
      'failed',
    ]);
    const matching = jobsById.filter(
      (j) => j.id === `process-video-${completed.id}`,
    );
    expect(matching.length).toBe(1);

    await moduleRef.close();
  }, 30000);

  it('Branch 2: recovers a Video past the grace period whose object is complete in storage; leaves a Video with a missing object untouched', async () => {
    const channel = await createChannelForNewUser();

    const recoverable = await createUploadableVideo(
      channel,
      'branch2 recoverable',
    );
    await uploadRealVideoFile(recoverable.id, 2);
    await backdateUpdatedAt(recoverable.id, 2);

    const missing = await videoRepository.save(
      videoRepository.create({
        channelId: channel.id,
        title: 'branch2 missing object',
        sourceStorageKey: randomUUID(),
      }),
    );
    await backdateUpdatedAt(missing.id, 2);

    const moduleRef = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();
    const sweepService = moduleRef.get(ReconciliationSweepService);
    const queue = moduleRef.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));

    await sweepService.sweep();

    const recoveredRow = await videoRepository.findOneBy({
      id: recoverable.id,
    });
    expect(recoveredRow!.uploadCompletedAt).not.toBeNull();
    const job = await queue.getJob(`process-video-${recoverable.id}`);
    expect(job).toBeDefined();

    const missingRow = await videoRepository.findOneBy({ id: missing.id });
    expect(missingRow!.processingStatus).toBe(VideoProcessingStatus.UPLOADING);
    expect(missingRow!.uploadCompletedAt).toBeNull();
    const missingJob = await queue.getJob(`process-video-${missing.id}`);
    expect(missingJob).toBeUndefined();

    await moduleRef.close();
  }, 30000);

  it("Branch 3: repairs a Video stuck at PROCESSING whose correlated job is already 'failed' in BullMQ, via persistTerminalFailure", async () => {
    const channel = await createChannelForNewUser();
    const stuck = await videoRepository.save(
      videoRepository.create({
        channelId: channel.id,
        title: 'branch3 stuck',
        sourceStorageKey: randomUUID(),
      }),
    );
    // Simulates "the worker started processing but the live @OnWorkerEvent
    // handler never landed its write" without depending on real ffmpeg
    // timing: the job's OWN payload points at a nonexistent videoId, so
    // whichever real worker processes it throws UnrecoverableError fast
    // (no download/ffprobe involved) and its live handler's write targets
    // that nonexistent id — 0 affected rows, never touching `stuck`.
    await videoRepository.update(
      { id: stuck.id },
      { processingStatus: VideoProcessingStatus.PROCESSING },
    );

    const moduleRef = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();
    const sweepService = moduleRef.get(ReconciliationSweepService);
    const queue = moduleRef.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));

    const jobId = `process-video-${stuck.id}`;
    await queue.add(
      'video.processing',
      { videoId: randomUUID() },
      { jobId, attempts: 1 },
    );

    await waitUntil(
      async () => (await queue.getJob(jobId))?.isFailed() ?? false,
      15000,
      200,
    );
    const job = await queue.getJob(jobId);
    expect(await job!.getState()).toBe('failed');

    // Sanity check: the live listener's write (if any fired) targeted the
    // nonexistent videoId, never `stuck` — this row must still read
    // PROCESSING right before the sweep runs.
    const preSweep = await videoRepository.findOneBy({ id: stuck.id });
    expect(preSweep!.processingStatus).toBe(VideoProcessingStatus.PROCESSING);

    await sweepService.sweep();

    const repaired = await videoRepository.findOneBy({ id: stuck.id });
    expect(repaired!.processingStatus).toBe(VideoProcessingStatus.FAILED);

    await moduleRef.close();
  }, 30000);

  it('Full cycle: an enqueue failure after a durable uploadCompletedAt write is recovered by the sweep and processing completes without reupload', async () => {
    const channel = await createChannelForNewUser();
    const video = await createUploadableVideo(channel, 'full cycle');
    await uploadRealVideoFile(video.id, 2);

    // Mimics onUploadFinish's own first action (durable, Redis-independent)
    // succeeding while the immediately-following enqueue call is simulated
    // to have failed — deliberately NOT calling queue.add() here.
    await videoRepository.update(
      { id: video.id },
      { uploadCompletedAt: new Date() },
    );

    const moduleRef = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();
    const sweepService = moduleRef.get(ReconciliationSweepService);
    const queue = moduleRef.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));

    await sweepService.sweep();

    const jobId = `process-video-${video.id}`;
    await waitUntil(
      async () => {
        const state = await (await queue.getJob(jobId))?.getState();
        return state === 'completed' || state === 'failed';
      },
      20000,
      300,
    );
    const job = await queue.getJob(jobId);
    expect(await job!.getState()).toBe('completed');

    const finalVideo = await videoRepository.findOneBy({ id: video.id });
    expect(finalVideo!.processingStatus).toBe(VideoProcessingStatus.READY);
    expect(finalVideo!.durationSeconds).toBeGreaterThan(0);

    await moduleRef.close();
  }, 30000);

  it('Real race: onUploadFinish-style enqueue and the sweep firing concurrently for the same Video result in exactly one effective job', async () => {
    const channel = await createChannelForNewUser();
    const video = await createUploadableVideo(channel, 'race test');
    await uploadRealVideoFile(video.id, 2);

    const moduleRef = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();
    const sweepService = moduleRef.get(ReconciliationSweepService);
    const queue = moduleRef.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));

    const jobId = `process-video-${video.id}`;
    const normalPathEnqueue = async (): Promise<void> => {
      await videoRepository.update(
        { id: video.id },
        { uploadCompletedAt: new Date() },
      );
      await queue.add(
        'video.processing',
        { videoId: video.id },
        { jobId, ...VIDEO_PROCESSING_JOB_OPTIONS },
      );
    };

    await Promise.all([normalPathEnqueue(), sweepService.sweep()]);

    await waitUntil(
      async () => {
        const state = await (await queue.getJob(jobId))?.getState();
        return state === 'completed' || state === 'failed';
      },
      20000,
      300,
    );
    const job = await queue.getJob(jobId);
    expect(await job!.getState()).toBe('completed');

    const finalVideo = await videoRepository.findOneBy({ id: video.id });
    expect(finalVideo!.processingStatus).toBe(VideoProcessingStatus.READY);

    await moduleRef.close();
  }, 30000);
});
