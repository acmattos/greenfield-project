import { randomUUID } from 'crypto';
import { DataSource, Repository } from 'typeorm';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video } from './entities/video.entity';
import { VideoDeliveryService } from './video-delivery.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('Video download — real GET (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
  let internalClient: S3Client;
  let service: VideoDeliveryService;
  const config = storageConfig();

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);

    // STORAGE_PUBLIC_ENDPOINT (http://localhost:9000) targets the browser,
    // not this test's own container — localhost there resolves to nestjs-api
    // itself, not MinIO. Sign against the internal (Compose-network-reachable)
    // endpoint instead, so the real GET below actually hits MinIO. Reused for
    // both seeding the object and signing the URL under test.
    internalClient = new S3Client({
      endpoint: config.endpoint,
      forcePathStyle: true,
      region: config.region,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });

    service = new VideoDeliveryService(videoRepository, internalClient, config);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  it('a real GET on the download URL returns Content-Disposition: attachment and Content-Type: video/mp4', async () => {
    const user = await userRepository.save(
      userRepository.create({
        email: `dl_${randomUUID()}@example.com`,
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
    const video = await videoRepository.save(
      videoRepository.create({
        channelId: channel.id,
        title: 'DL video',
        sourceStorageKey,
      }),
    );

    await internalClient.send(
      new PutObjectCommand({
        Bucket: config.bucket,
        Key: sourceStorageKey,
        Body: Buffer.from('fake mp4 bytes'),
      }),
    );

    const url = await service.getDownloadUrl(video.id);
    const response = await fetch(url);
    await response.arrayBuffer(); // drain body

    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toBe('attachment');
    expect(response.headers.get('content-type')).toBe('video/mp4');
  });
});
