import { randomUUID } from 'crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { AppModule } from '../src/app.module';
import { Channel } from '../src/channels/entities/channel.entity';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { User } from '../src/users/entities/user.entity';
import {
  Video,
  VideoProcessingStatus,
} from '../src/videos/entities/video.entity';

const NON_READY_STATUSES: VideoProcessingStatus[] = [
  VideoProcessingStatus.UPLOADING,
  VideoProcessingStatus.PROCESSING,
  VideoProcessingStatus.FAILED,
];

describe('videos', () => {
  // Default 5000ms hook timeout is too tight for a full AppModule compile
  // (now includes upload/storage/queue module graphs) under load.
  jest.setTimeout(30000);

  let app: INestApplication<App>;
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  async function createVideo(
    processingStatus: VideoProcessingStatus,
  ): Promise<Video> {
    const user = await userRepository.save(
      userRepository.create({
        email: `videos_e2e_${randomUUID()}@example.com`,
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
        title: 'E2E video',
        sourceStorageKey: randomUUID(),
        processingStatus,
      }),
    );
  }

  // ### 1. GET /videos/:id/stream

  it('1.1 stream-video-ready-redirects-anonymously', async () => {
    const video = await createVideo(VideoProcessingStatus.READY);

    const res = await request(app.getHttpServer())
      .get(`/videos/${video.id}/stream`)
      .expect(302);

    expect(res.headers.location).toContain(video.sourceStorageKey);
  });

  it.each(NON_READY_STATUSES)(
    '1.2 stream-video-not-ready-returns-409 (processingStatus: %s)',
    async (processingStatus) => {
      const video = await createVideo(processingStatus);

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.id}/stream`)
        .expect(409);

      expect(res.body).toMatchObject({
        statusCode: 409,
        error: 'VIDEO_NOT_READY',
      });
    },
  );

  it('1.3 stream-video-not-found-returns-404', async () => {
    const nonExistentId = randomUUID();

    const res = await request(app.getHttpServer())
      .get(`/videos/${nonExistentId}/stream`)
      .expect(404);

    expect(res.body).toMatchObject({
      statusCode: 404,
      error: 'VIDEO_NOT_FOUND',
    });
  });

  // ### 2. GET /videos/:id/download

  it('2.1 download-video-ready-redirects-with-attachment-disposition', async () => {
    const video = await createVideo(VideoProcessingStatus.READY);

    const res = await request(app.getHttpServer())
      .get(`/videos/${video.id}/download`)
      .expect(302);

    expect(res.headers.location).toContain(
      'response-content-disposition=attachment',
    );
  });

  it.each(NON_READY_STATUSES)(
    '2.2 download-video-not-ready-returns-409 (processingStatus: %s)',
    async (processingStatus) => {
      const video = await createVideo(processingStatus);

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.id}/download`)
        .expect(409);

      expect(res.body).toMatchObject({
        statusCode: 409,
        error: 'VIDEO_NOT_READY',
      });
    },
  );

  it('2.3 download-video-not-found-returns-404', async () => {
    const nonExistentId = randomUUID();

    const res = await request(app.getHttpServer())
      .get(`/videos/${nonExistentId}/download`)
      .expect(404);

    expect(res.body).toMatchObject({
      statusCode: 404,
      error: 'VIDEO_NOT_FOUND',
    });
  });
});
