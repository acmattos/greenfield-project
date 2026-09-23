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

describe('tus upload — auth boundary on every request (integration)', () => {
  jest.setTimeout(30000);
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
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
    jwtService = moduleFixture.get(JwtService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  async function createAuthenticatedUser(): Promise<string> {
    const user = await userRepository.save(
      userRepository.create({
        email: `authb_${randomBytes(4).toString('hex')}@example.com`,
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

  async function createExistingUpload(ownerToken: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/videos/upload')
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Tus-Resumable', '1.0.0')
      .set('Upload-Length', '1000')
      .expect(201);
    const location = res.headers.location;
    return `/videos/upload/${location.split('/').pop()}`;
  }

  it('rejects POST creation without an Authorization header with 401', async () => {
    const res = await request(app.getHttpServer())
      .post('/videos/upload')
      .set('Tus-Resumable', '1.0.0')
      .set('Upload-Length', '1000')
      .expect(401);

    const body = JSON.parse(res.text) as Record<string, unknown>;
    expect(body).toMatchObject({
      statusCode: 401,
      error: 'UNAUTHENTICATED',
    });
  });

  it('does not block a real OPTIONS request without a token', async () => {
    await request(app.getHttpServer())
      .options('/videos/upload')
      .set('Tus-Resumable', '1.0.0')
      .expect((res) => {
        expect(res.status).not.toBe(401);
      });
  });

  describe('against an existing upload', () => {
    it('PATCH without Authorization returns 401 UNAUTHENTICATED', async () => {
      const ownerToken = await createAuthenticatedUser();
      const uploadPath = await createExistingUpload(ownerToken);

      const res = await request(app.getHttpServer())
        .patch(uploadPath)
        .set('Tus-Resumable', '1.0.0')
        .set('Upload-Offset', '0')
        .set('Content-Type', 'application/offset+octet-stream')
        .expect(401);

      const body = JSON.parse(res.text) as Record<string, unknown>;
      expect(body).toMatchObject({ statusCode: 401, error: 'UNAUTHENTICATED' });
    });

    it('PATCH from a non-owner authenticated user returns 403 FORBIDDEN', async () => {
      const ownerToken = await createAuthenticatedUser();
      const uploadPath = await createExistingUpload(ownerToken);
      const otherToken = await createAuthenticatedUser();

      const res = await request(app.getHttpServer())
        .patch(uploadPath)
        .set('Authorization', `Bearer ${otherToken}`)
        .set('Tus-Resumable', '1.0.0')
        .set('Upload-Offset', '0')
        .set('Content-Type', 'application/offset+octet-stream')
        .expect(403);

      const body = JSON.parse(res.text) as Record<string, unknown>;
      expect(body).toMatchObject({ statusCode: 403, error: 'FORBIDDEN' });
    });

    it('DELETE without Authorization returns 401; DELETE from a non-owner returns 403', async () => {
      const ownerToken = await createAuthenticatedUser();
      const uploadPath = await createExistingUpload(ownerToken);

      const unauthRes = await request(app.getHttpServer())
        .delete(uploadPath)
        .set('Tus-Resumable', '1.0.0')
        .expect(401);
      expect(JSON.parse(unauthRes.text)).toMatchObject({
        statusCode: 401,
        error: 'UNAUTHENTICATED',
      });

      const otherToken = await createAuthenticatedUser();
      const forbiddenRes = await request(app.getHttpServer())
        .delete(uploadPath)
        .set('Authorization', `Bearer ${otherToken}`)
        .set('Tus-Resumable', '1.0.0')
        .expect(403);
      expect(JSON.parse(forbiddenRes.text)).toMatchObject({
        statusCode: 403,
        error: 'FORBIDDEN',
      });
    });

    it('HEAD/PATCH/DELETE with a syntactically malformed uploadId return 404, never 500', async () => {
      const ownerToken = await createAuthenticatedUser();

      await request(app.getHttpServer())
        .head('/videos/upload/not-a-uuid')
        .set('Authorization', `Bearer ${ownerToken}`)
        .set('Tus-Resumable', '1.0.0')
        .expect(404);

      await request(app.getHttpServer())
        .patch('/videos/upload/not-a-uuid')
        .set('Authorization', `Bearer ${ownerToken}`)
        .set('Tus-Resumable', '1.0.0')
        .set('Upload-Offset', '0')
        .set('Content-Type', 'application/offset+octet-stream')
        .expect(404);

      await request(app.getHttpServer())
        .delete('/videos/upload/not-a-uuid')
        .set('Authorization', `Bearer ${ownerToken}`)
        .set('Tus-Resumable', '1.0.0')
        .expect(404);
    });

    it('HEAD from the owner returns 200 with the correct offset', async () => {
      const ownerToken = await createAuthenticatedUser();
      const uploadPath = await createExistingUpload(ownerToken);

      const res = await request(app.getHttpServer())
        .head(uploadPath)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set('Tus-Resumable', '1.0.0')
        .expect(200);

      expect(res.headers['upload-offset']).toBe('0');
    });

    it('does not block a real OPTIONS request against an existing upload without a token', async () => {
      const ownerToken = await createAuthenticatedUser();
      const uploadPath = await createExistingUpload(ownerToken);

      await request(app.getHttpServer())
        .options(uploadPath)
        .set('Tus-Resumable', '1.0.0')
        .expect((res) => {
          expect(res.status).not.toBe(401);
        });
    });
  });
});
