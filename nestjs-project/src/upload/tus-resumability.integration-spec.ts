import { randomBytes } from 'crypto';
import * as http from 'http';
import { AddressInfo } from 'net';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { AppModule } from '../app.module';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import { cleanAllTables } from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';

// Writes `partialBody` to a real PATCH request, then destroys the underlying
// socket once the bytes have been flushed — simulating a mid-stream
// connection failure (not a clean request end).
function patchAndDestroyMidStream(
  baseUrl: string,
  path: string,
  token: string,
  partialBody: Buffer,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${baseUrl}${path}`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Tus-Resumable': '1.0.0',
          'Upload-Offset': '0',
          'Content-Type': 'application/offset+octet-stream',
        },
      },
      () => {
        // A response should never arrive — the connection is destroyed first.
      },
    );
    req.on('error', () => resolve());
    req.write(partialBody, (err) => {
      if (err) {
        reject(err);
        return;
      }
      setTimeout(() => {
        req.destroy();
        resolve();
      }, 200);
    });
  });
}

describe('tus upload — real resumability after connection failure (integration)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let jwtService: JwtService;
  let baseUrl: string;
  let s3Client: S3Client;
  const config = storageConfig();

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    await app.listen(0);

    const address = (
      app.getHttpServer() as http.Server
    ).address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;

    dataSource = moduleFixture.get(DataSource);
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
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
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  async function createAuthenticatedChannel(): Promise<string> {
    const user = await userRepository.save(
      userRepository.create({
        email: `resume_${randomBytes(4).toString('hex')}@example.com`,
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

  it('resumes exactly from the HEAD-confirmed offset after a mid-stream connection failure, producing a byte-identical object', async () => {
    const token = await createAuthenticatedChannel();
    const fileContent = randomBytes(200_000);

    const createRes = await request(app.getHttpServer())
      .post('/videos/upload')
      .set('Authorization', `Bearer ${token}`)
      .set('Tus-Resumable', '1.0.0')
      .set('Upload-Length', String(fileContent.length))
      .set(
        'Upload-Metadata',
        `filetype ${Buffer.from('video/mp4').toString('base64')}`,
      )
      .expect(201);

    const location = createRes.headers.location;
    const uploadPath = new URL(location, baseUrl).pathname;
    const uploadId = uploadPath.split('/').pop() as string;

    const halfway = Math.floor(fileContent.length / 2);
    await patchAndDestroyMidStream(
      baseUrl,
      uploadPath,
      token,
      fileContent.subarray(0, halfway),
    );

    const headRes = await request(app.getHttpServer())
      .head(uploadPath)
      .set('Authorization', `Bearer ${token}`)
      .set('Tus-Resumable', '1.0.0')
      .expect(200);
    const confirmedOffset = parseInt(headRes.headers['upload-offset'], 10);
    expect(confirmedOffset).toBeGreaterThan(0);
    expect(confirmedOffset).toBeLessThanOrEqual(halfway);

    await request(app.getHttpServer())
      .patch(uploadPath)
      .set('Authorization', `Bearer ${token}`)
      .set('Tus-Resumable', '1.0.0')
      .set('Upload-Offset', String(confirmedOffset))
      .set('Content-Type', 'application/offset+octet-stream')
      .send(fileContent.subarray(confirmedOffset))
      .expect(204);

    const getRes = await s3Client.send(
      new GetObjectCommand({ Bucket: config.bucket, Key: uploadId }),
    );
    const received = Buffer.from(await getRes.Body!.transformToByteArray());
    expect(received.equals(fileContent)).toBe(true);
  }, 30000);
});
