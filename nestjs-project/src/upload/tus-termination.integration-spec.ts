import { randomBytes } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { AppModule } from '../app.module';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import { cleanAllTables } from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video } from '../videos/entities/video.entity';

async function waitUntil(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs = 100,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

describe('tus upload — termination (DELETE) scoped to in-progress uploads (integration)', () => {
  jest.setTimeout(30000);
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
  let jwtService: JwtService;
  let s3Client: S3Client;
  const config = storageConfig();

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
    await app.close();
    s3Client.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  async function createAuthenticatedChannel(): Promise<string> {
    const user = await userRepository.save(
      userRepository.create({
        email: `term_${randomBytes(4).toString('hex')}@example.com`,
        password: 'hashed',
      }),
    );
    await channelRepository.save(
      channelRepository.create({
        name: 'Chan',
        nickname: `chan_${randomBytes(4).toString('hex')}`,
        user_id: user.id,
      }),
    );
    return jwtService.signAsync({ sub: user.id, email: user.email });
  }

  async function createInProgressUpload(
    token: string,
  ): Promise<{ uploadPath: string; uploadId: string }> {
    const res = await request(app.getHttpServer())
      .post('/videos/upload')
      .set('Authorization', `Bearer ${token}`)
      .set('Tus-Resumable', '1.0.0')
      .set('Upload-Length', '1000')
      .expect(201);
    const location = res.headers.location as string;
    const uploadId = location.split('/').pop() as string;
    return { uploadPath: `/videos/upload/${uploadId}`, uploadId };
  }

  it('DELETE of an in-progress upload removes the Video draft from the DB and the object from storage', async () => {
    const token = await createAuthenticatedChannel();
    const { uploadPath, uploadId } = await createInProgressUpload(token);

    const existingBeforeDelete = await videoRepository.findOneBy({
      id: uploadId,
    });
    expect(existingBeforeDelete).not.toBeNull();

    await request(app.getHttpServer())
      .delete(uploadPath)
      .set('Authorization', `Bearer ${token}`)
      .set('Tus-Resumable', '1.0.0')
      .expect(204);

    // Storage cleanup (S3Store.remove) is awaited by DeleteHandler BEFORE
    // the 204 is written, so this is safe to assert immediately.
    await expect(
      s3Client.send(
        new HeadObjectCommand({ Bucket: config.bucket, Key: uploadId }),
      ),
    ).rejects.toThrow();

    // POST_TERMINATE (and therefore the Video row delete) fires AFTER the
    // 204 response is already written — fire-and-forget, per @tus/server's
    // DeleteHandler — so the DB write must be polled, not asserted
    // synchronously right after the HTTP response resolves.
    await waitUntil(
      async () => (await videoRepository.findOneBy({ id: uploadId })) === null,
      5000,
    );
    const afterDelete = await videoRepository.findOneBy({ id: uploadId });
    expect(afterDelete).toBeNull();
  });

  it('DELETE against an already-finished upload returns 400 INVALID_TERMINATION and leaves the Video draft intact', async () => {
    const token = await createAuthenticatedChannel();
    const content = randomBytes(10);

    const createRes = await request(app.getHttpServer())
      .post('/videos/upload')
      .set('Authorization', `Bearer ${token}`)
      .set('Tus-Resumable', '1.0.0')
      .set('Upload-Length', String(content.length))
      .set(
        'Upload-Metadata',
        `filetype ${Buffer.from('video/mp4').toString('base64')}`,
      )
      .expect(201);
    const location = createRes.headers.location as string;
    const uploadId = location.split('/').pop() as string;
    const uploadPath = `/videos/upload/${uploadId}`;

    await request(app.getHttpServer())
      .patch(uploadPath)
      .set('Authorization', `Bearer ${token}`)
      .set('Tus-Resumable', '1.0.0')
      .set('Upload-Offset', '0')
      .set('Content-Type', 'application/offset+octet-stream')
      .send(content)
      .expect(204);

    const res = await request(app.getHttpServer())
      .delete(uploadPath)
      .set('Authorization', `Bearer ${token}`)
      .set('Tus-Resumable', '1.0.0')
      .expect(400);

    // Native tus protocol response — plain text, outside the project's
    // custom JSON error envelope (per upload-processing/TD-13).
    expect(res.text).toBe('Cannot terminate an already completed upload');

    const stillExists = await videoRepository.findOneBy({ id: uploadId });
    expect(stillExists).not.toBeNull();
  });
});
