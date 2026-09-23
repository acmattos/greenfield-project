import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import { readFile } from 'fs/promises';
import { promisify } from 'util';
import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
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
import { Video, VideoProcessingStatus } from '../videos/entities/video.entity';
import { VideoProcessingProcessor } from './video-processing.processor';
import { WorkerModule } from './worker.module';

const execFileAsync = promisify(execFile);
const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

// Generates a real MOV container (major_brand 'qt') — rejected per
// upload-processing/TD-09. Requires the worker image's real ffmpeg binary.
async function generateRejectedFormatFile(destPath: string): Promise<void> {
  await execFileAsync(process.env.FFMPEG_PATH || '/usr/local/bin/ffmpeg', [
    '-f',
    'lavfi',
    '-i',
    'testsrc=duration=1:size=64x64:rate=5',
    '-c:v',
    'libx264',
    '-y',
    destPath,
  ]);
}

describe('Video format rejection — worker integration', () => {
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

  async function createVideoWithRejectedFormat(): Promise<Video> {
    const user = await userRepository.save(
      userRepository.create({
        email: `fmt_${randomUUID()}@example.com`,
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
    const sourceStorageKey = randomUUID();

    const localPath = `/tmp/${sourceStorageKey}.mov`;
    await generateRejectedFormatFile(localPath);
    const fileBuffer = await readFile(localPath);

    await s3Client.send(
      new PutObjectCommand({
        Bucket: config.bucket,
        Key: sourceStorageKey,
        Body: fileBuffer,
      }),
    );

    return videoRepository.save(
      videoRepository.create({
        channelId: channel.id,
        title: 'Invalid format test',
        sourceStorageKey,
      }),
    );
  }

  it('rejects an invalid-format video: UnrecoverableError, source object deleted, processingStatus not written by this code', async () => {
    const video = await createVideoWithRejectedFormat();

    const moduleRef = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();
    const processor = moduleRef.get(VideoProcessingProcessor);

    const job = {
      id: `test-reject-${randomUUID()}`,
      data: { videoId: video.id },
    } as never;

    await expect(processor.process(job)).rejects.toThrow();

    // process() itself only wrote PROCESSING (before probing) — FAILED is
    // the exclusive responsibility of the SI-03.15 event handler, not yet
    // implemented at this SI.
    const updated = await videoRepository.findOneBy({ id: video.id });
    expect(updated!.processingStatus).toBe(VideoProcessingStatus.PROCESSING);

    await expect(
      s3Client.send(
        new GetObjectCommand({
          Bucket: config.bucket,
          Key: video.sourceStorageKey,
        }),
      ),
    ).rejects.toThrow();

    await moduleRef.close();
  }, 30000);

  it('UnrecoverableError really does not retry: process() runs exactly once despite attempts: 3', async () => {
    // Note: this queue is the same real 'video-processing' queue the
    // container's own long-running worker process (PID 1, `node
    // dist/worker/main.js`) also consumes — whichever worker instance wins
    // the race processes the job, so `attemptsMade` (observable from the
    // job itself, via Redis) is used instead of a spy on a specific
    // in-test provider instance, which would only capture the outcome if
    // this test's own instance happened to win that race.
    const video = await createVideoWithRejectedFormat();

    const moduleRef = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();

    const queue = moduleRef.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
    const jobId = `process-video-${video.id}`;
    const job = await queue.add(
      'video.processing',
      { videoId: video.id },
      { jobId, attempts: 3 },
    );

    let state = await job.getState();
    const deadline = Date.now() + 20000;
    while (
      state !== 'failed' &&
      state !== 'completed' &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      state = await job.getState();
    }

    expect(state).toBe('failed');

    const finalJob = await queue.getJob(jobId);
    expect(finalJob!.attemptsMade).toBe(1);

    await moduleRef.close();
  }, 30000);
});

describe('Video processing success — worker integration', () => {
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

  async function createPendingVideo(): Promise<Video> {
    const user = await userRepository.save(
      userRepository.create({
        email: `ok_${randomUUID()}@example.com`,
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
    const sourceStorageKey = randomUUID();

    return videoRepository.save(
      videoRepository.create({
        channelId: channel.id,
        title: 'Valid video test',
        sourceStorageKey,
      }),
    );
  }

  async function uploadValidVideoFile(
    sourceStorageKey: string,
    durationSeconds: number,
  ): Promise<void> {
    const localPath = `/tmp/${sourceStorageKey}.mp4`;
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
        Key: sourceStorageKey,
        Body: fileBuffer,
      }),
    );
  }

  async function createValidVideo(durationSeconds: number): Promise<Video> {
    const video = await createPendingVideo();
    await uploadValidVideoFile(video.sourceStorageKey, durationSeconds);
    return video;
  }

  it('a valid video ends READY with all metadata fields and thumbnailStorageKey persisted, thumbnail present in storage', async () => {
    const video = await createValidVideo(3);

    const moduleRef = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();
    const processor = moduleRef.get(VideoProcessingProcessor);

    const job = {
      id: `test-success-${randomUUID()}`,
      data: { videoId: video.id },
    } as never;
    await processor.process(job);

    const updated = await videoRepository.findOneBy({ id: video.id });
    expect(updated!.processingStatus).toBe(VideoProcessingStatus.READY);
    expect(updated!.durationSeconds).toBeGreaterThan(0);
    expect(updated!.width).toBe(64);
    expect(updated!.height).toBe(64);
    expect(updated!.videoCodec).toBe('h264');
    expect(updated!.audioCodec).toBe('aac');
    expect(updated!.bitRate).toBeGreaterThan(0);
    expect(updated!.thumbnailStorageKey).toBe(`videos/${video.id}/thumbnail`);

    const thumbnailObject = await s3Client.send(
      new GetObjectCommand({
        Bucket: config.bucket,
        Key: updated!.thumbnailStorageKey!,
      }),
    );
    const thumbnailBytes = await thumbnailObject.Body!.transformToByteArray();
    expect(thumbnailBytes.length).toBeGreaterThan(0);
    // JPEG magic bytes (0xFF 0xD8) confirm a real image was uploaded, not
    // an empty/garbage payload.
    expect(Buffer.from(thumbnailBytes.slice(0, 2))).toEqual(
      Buffer.from([0xff, 0xd8]),
    );

    await moduleRef.close();
  }, 30000);

  it('a very short (~1s) video generates a thumbnail successfully, respecting the real duration', async () => {
    const video = await createValidVideo(1);

    const moduleRef = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();
    const processor = moduleRef.get(VideoProcessingProcessor);

    const job = {
      id: `test-short-${randomUUID()}`,
      data: { videoId: video.id },
    } as never;
    await processor.process(job);

    const updated = await videoRepository.findOneBy({ id: video.id });
    expect(updated!.processingStatus).toBe(VideoProcessingStatus.READY);

    const thumbnailObject = await s3Client.send(
      new GetObjectCommand({
        Bucket: config.bucket,
        Key: updated!.thumbnailStorageKey!,
      }),
    );
    const thumbnailBytes = await thumbnailObject.Body!.transformToByteArray();
    expect(thumbnailBytes.length).toBeGreaterThan(0);

    await moduleRef.close();
  }, 30000);
});

describe("@OnWorkerEvent('failed') — worker integration", () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
  const config = storageConfig();

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  // sourceStorageKey deliberately never uploaded to MinIO — every download
  // attempt fails with a real, transient S3 "not found" error (not an
  // UnrecoverableError), letting BullMQ's real retry mechanism run.
  async function createVideoWithMissingSource(): Promise<Video> {
    const user = await userRepository.save(
      userRepository.create({
        email: `retry_${randomUUID()}@example.com`,
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

    return videoRepository.save(
      videoRepository.create({
        channelId: channel.id,
        title: 'Retry test',
        sourceStorageKey: randomUUID(),
      }),
    );
  }

  it('a transient failure on attempt 1 does not write FAILED, and the job succeeds fully once the source becomes available', async () => {
    const video = await createVideoWithMissingSource();

    const moduleRef = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();
    const queue = moduleRef.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
    const jobId = `process-video-${video.id}`;
    const job = await queue.add(
      'video.processing',
      { videoId: video.id },
      {
        jobId,
        attempts: 3,
        // Explicit — the WorkerModule's own queue registration (unlike
        // queue.module.ts, the producer side) has no defaultJobOptions, so
        // without this the retry would fire with zero delay, defeating the
        // point of this test (proving a genuine wait-then-retry window).
        backoff: { type: 'exponential', delay: 1000 },
      },
    );

    // Wait for attempt 1 to fail (attemptsMade becomes 1) before the source
    // object is made available — this is the window that proves the retry
    // is real, not a false positive from an already-successful first try.
    const attempt1Deadline = Date.now() + 10000;
    let attemptsMade = 0;
    while (attemptsMade < 1 && Date.now() < attempt1Deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const polled = await queue.getJob(jobId);
      attemptsMade = polled?.attemptsMade ?? 0;
    }
    expect(attemptsMade).toBeGreaterThanOrEqual(1);

    const midState = await videoRepository.findOneBy({ id: video.id });
    expect(midState!.processingStatus).toBe(VideoProcessingStatus.PROCESSING);

    // Make the source available before the exponential-backoff retry fires.
    const localPath = `/tmp/${video.sourceStorageKey}.mp4`;
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
    const s3Client = new S3Client({
      endpoint: config.endpoint,
      forcePathStyle: true,
      region: config.region,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
    await s3Client.send(
      new PutObjectCommand({
        Bucket: config.bucket,
        Key: video.sourceStorageKey,
        Body: fileBuffer,
      }),
    );

    let state = await job.getState();
    const finalDeadline = Date.now() + 20000;
    while (
      state !== 'completed' &&
      state !== 'failed' &&
      Date.now() < finalDeadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      state = await job.getState();
    }
    expect(state).toBe('completed');

    const finalVideo = await videoRepository.findOneBy({ id: video.id });
    expect(finalVideo!.processingStatus).toBe(VideoProcessingStatus.READY);

    s3Client.destroy();
    await moduleRef.close();
  }, 30000);

  it('all 3 attempts fail transiently: processingStatus only becomes FAILED after the last attempt is exhausted', async () => {
    const video = await createVideoWithMissingSource();

    const moduleRef = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();
    const queue = moduleRef.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
    const jobId = `process-video-${video.id}`;
    const job = await queue.add(
      'video.processing',
      { videoId: video.id },
      {
        jobId,
        attempts: 3,
        // See the sibling test above for why this must be explicit here.
        backoff: { type: 'exponential', delay: 1000 },
      },
    );

    // Wait until attempt 2 has failed but the job has not yet reached its
    // final (3rd) attempt — proves FAILED is not written prematurely.
    const midDeadline = Date.now() + 15000;
    let polled = await queue.getJob(jobId);
    while ((polled?.attemptsMade ?? 0) < 2 && Date.now() < midDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      polled = await queue.getJob(jobId);
    }
    expect(polled?.attemptsMade).toBeGreaterThanOrEqual(2);

    const midVideo = await videoRepository.findOneBy({ id: video.id });
    expect(midVideo!.processingStatus).not.toBe(VideoProcessingStatus.FAILED);

    let state = await job.getState();
    const finalDeadline = Date.now() + 20000;
    while (
      state !== 'completed' &&
      state !== 'failed' &&
      Date.now() < finalDeadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      state = await job.getState();
    }
    expect(state).toBe('failed');

    const finalJob = await queue.getJob(jobId);
    expect(finalJob!.attemptsMade).toBe(3);

    const finalVideo = await videoRepository.findOneBy({ id: video.id });
    expect(finalVideo!.processingStatus).toBe(VideoProcessingStatus.FAILED);

    await moduleRef.close();
  }, 30000);
});
