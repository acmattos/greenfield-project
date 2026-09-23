import { randomUUID } from 'crypto';
import { IncomingMessage, ServerResponse } from 'http';
import { ConfigModule } from '@nestjs/config';
import { getQueueToken } from '@nestjs/bullmq';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import type { Upload } from '@tus/server';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import queueConfig from '../config/queue.config';
import { QueueModule } from '../queue/queue.module';
import { VIDEO_PROCESSING_QUEUE } from '../queue/queue.constants';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video } from '../videos/entities/video.entity';
import { TusHooksService } from './tus-hooks.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

function fakeUpload(id: string): Upload {
  return { id, metadata: {}, size: 100, offset: 0 } as unknown as Upload;
}

describe('TusHooksService.onUploadFinish (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
  const jwtService = {} as JwtService; // unused by onUploadFinish

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

  async function createVideo(): Promise<Video> {
    const user = await userRepository.save(
      userRepository.create({
        email: `finish_${randomUUID()}@example.com`,
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
        title: 'Finish test video',
        sourceStorageKey: randomUUID(),
      }),
    );
  }

  it('persists uploadCompletedAt and enqueues exactly one job with a deterministic jobId, inheriting defaultJobOptions from the real QueueModule', async () => {
    // Built via the real QueueModule (not a bare `new Queue(...)`) so the
    // resolved Queue instance actually carries the registered
    // defaultJobOptions (attempts/backoff/retention) — those live on the
    // Queue instance itself, not on anything a standalone Queue would infer
    // from the queue name alone.
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        QueueModule,
      ],
    }).compile();
    const queue = moduleRef.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));

    const service = new TusHooksService(
      jwtService,
      videoRepository,
      channelRepository,
      queue,
    );

    const video = await createVideo();
    await service.onUploadFinish(
      {} as IncomingMessage,
      {} as ServerResponse,
      fakeUpload(video.id),
    );

    const updated = await videoRepository.findOneBy({ id: video.id });
    expect(updated!.uploadCompletedAt).not.toBeNull();

    const job = await queue.getJob(`process-video-${video.id}`);
    expect(job).not.toBeNull();
    expect(job!.data).toEqual({ videoId: video.id });
    expect(job!.opts.attempts).toBe(3);
    expect(job!.opts.backoff).toEqual({ type: 'exponential', delay: 1000 });

    await moduleRef.close();
  });

  it('still persists uploadCompletedAt, and the enqueue call rejects quickly, when Redis is unreachable', async () => {
    const unreachableQueue = new Queue(VIDEO_PROCESSING_QUEUE, {
      connection: {
        host: '127.0.0.1',
        port: 1, // nothing listens here — connection refused immediately
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
        lazyConnect: true,
      },
    });
    const service = new TusHooksService(
      jwtService,
      videoRepository,
      channelRepository,
      unreachableQueue,
    );

    const video = await createVideo();
    const start = Date.now();

    await expect(
      service.onUploadFinish(
        {} as IncomingMessage,
        {} as ServerResponse,
        fakeUpload(video.id),
      ),
    ).rejects.toBeDefined();

    expect(Date.now() - start).toBeLessThan(5000);

    const updated = await videoRepository.findOneBy({ id: video.id });
    expect(updated!.uploadCompletedAt).not.toBeNull();

    await unreachableQueue.close();
  }, 15000);
});
