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

  async function createValidVideo(durationSeconds: number): Promise<Video> {
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

    return videoRepository.save(
      videoRepository.create({
        channelId: channel.id,
        title: 'Valid video test',
        sourceStorageKey,
      }),
    );
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
