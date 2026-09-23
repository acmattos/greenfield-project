import { randomBytes } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { AppModule } from '../app.module';
import { Channel } from '../channels/entities/channel.entity';
import { cleanAllTables } from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video } from '../videos/entities/video.entity';

const MAX_UPLOAD_BYTES = 10737418240; // 10GB, per upload-processing/TD-05

function encodeUploadMetadata(pairs: Record<string, string>): string {
  return Object.entries(pairs)
    .map(([key, value]) => `${key} ${Buffer.from(value).toString('base64')}`)
    .join(',');
}

describe('tus upload — mount + draft creation (integration)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
  let jwtService: JwtService;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
    jwtService = moduleFixture.get(JwtService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  async function createAuthenticatedChannel(): Promise<{
    token: string;
    channel: Channel;
  }> {
    const user = await userRepository.save(
      userRepository.create({
        email: `tus_${randomBytes(4).toString('hex')}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channelRepository.save(
      channelRepository.create({
        name: 'Chan',
        nickname: `chan_${randomBytes(4).toString('hex')}`,
        user_id: user.id,
      }),
    );
    const token = await jwtService.signAsync({
      sub: user.id,
      email: user.email,
    });
    return { token, channel };
  }

  it('creates a Video draft with sourceStorageKey identical to id, on a supported filetype', async () => {
    const { token, channel } = await createAuthenticatedChannel();

    const res = await request(app.getHttpServer())
      .post('/videos/upload')
      .set('Authorization', `Bearer ${token}`)
      .set('Tus-Resumable', '1.0.0')
      .set('Upload-Length', '1000')
      .set(
        'Upload-Metadata',
        encodeUploadMetadata({ filetype: 'video/mp4', title: 'My video' }),
      )
      .expect(201);

    const location = res.headers.location;
    const uploadId = location.split('/').pop() as string;

    const video = await videoRepository.findOneBy({ id: uploadId });
    expect(video).not.toBeNull();
    expect(video!.sourceStorageKey).toBe(uploadId);
    expect(video!.channelId).toBe(channel.id);
    expect(video!.processingStatus).toBe('UPLOADING');
  });

  it('rejects an unsupported filetype with 415 and creates no Video', async () => {
    const { token } = await createAuthenticatedChannel();

    const res = await request(app.getHttpServer())
      .post('/videos/upload')
      .set('Authorization', `Bearer ${token}`)
      .set('Tus-Resumable', '1.0.0')
      .set('Upload-Length', '1000')
      .set('Upload-Metadata', encodeUploadMetadata({ filetype: 'video/avi' }))
      .expect(415);

    const body = JSON.parse(res.text) as Record<string, unknown>;
    expect(body).toMatchObject({
      statusCode: 415,
      error: 'UNSUPPORTED_VIDEO_FORMAT',
    });

    const count = await videoRepository.count();
    expect(count).toBe(0);
  });

  it('proceeds when filetype is not declared', async () => {
    const { token } = await createAuthenticatedChannel();

    await request(app.getHttpServer())
      .post('/videos/upload')
      .set('Authorization', `Bearer ${token}`)
      .set('Tus-Resumable', '1.0.0')
      .set('Upload-Length', '1000')
      .expect(201);
  });

  it("creates a Video with the 'Untitled video' fallback when neither title nor filename is declared", async () => {
    const { token } = await createAuthenticatedChannel();

    const res = await request(app.getHttpServer())
      .post('/videos/upload')
      .set('Authorization', `Bearer ${token}`)
      .set('Tus-Resumable', '1.0.0')
      .set('Upload-Length', '1000')
      .expect(201);

    const uploadId = res.headers.location.split('/').pop();
    const video = await videoRepository.findOneBy({ id: uploadId });
    expect(video!.title).toBe('Untitled video');
  });

  describe('Upload-Length boundary (MAX_UPLOAD_BYTES = 10GB)', () => {
    it('accepts exactly 10737418240 bytes with 201, without transferring any bytes', async () => {
      const { token } = await createAuthenticatedChannel();

      await request(app.getHttpServer())
        .post('/videos/upload')
        .set('Authorization', `Bearer ${token}`)
        .set('Tus-Resumable', '1.0.0')
        .set('Upload-Length', String(MAX_UPLOAD_BYTES))
        .expect(201);
    });

    it('rejects 10737418241 bytes', async () => {
      const { token } = await createAuthenticatedChannel();

      await request(app.getHttpServer())
        .post('/videos/upload')
        .set('Authorization', `Bearer ${token}`)
        .set('Tus-Resumable', '1.0.0')
        .set('Upload-Length', String(MAX_UPLOAD_BYTES + 1))
        .expect(413);
    });
  });
});
