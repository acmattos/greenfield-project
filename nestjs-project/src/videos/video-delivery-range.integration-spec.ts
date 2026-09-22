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

describe('Video streaming — real Range GET (integration)', () => {
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

    // Same rationale as video-delivery-download.integration-spec.ts: sign
    // against the internal, Compose-network-reachable endpoint so the real
    // GET below (issued from inside this test's own container) actually
    // reaches MinIO instead of resolving localhost to itself.
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

  it('a real Range GET returns 206 with correct Content-Range and exactly 100 bytes', async () => {
    const user = await userRepository.save(
      userRepository.create({
        email: `range_${randomUUID()}@example.com`,
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
        title: 'Range video',
        sourceStorageKey,
      }),
    );

    const body = Buffer.alloc(200, 'a');
    await internalClient.send(
      new PutObjectCommand({
        Bucket: config.bucket,
        Key: sourceStorageKey,
        Body: body,
      }),
    );

    const url = await service.getStreamUrl(video.id);
    const response = await fetch(url, {
      headers: { Range: 'bytes=0-99' },
    });
    const received = Buffer.from(await response.arrayBuffer());

    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 0-99/200');
    expect(received).toHaveLength(100);
  });
});
