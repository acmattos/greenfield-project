import { randomUUID } from 'crypto';
import { DataSource, Repository } from 'typeorm';
import { S3Client } from '@aws-sdk/client-s3';
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

describe('VideoDeliveryService (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
  let service: VideoDeliveryService;
  const config = storageConfig();

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);

    const publicClient = new S3Client({
      endpoint: config.publicEndpoint,
      forcePathStyle: true,
      region: config.region,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });

    service = new VideoDeliveryService(videoRepository, publicClient, config);
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
        email: `delivery_${randomUUID()}@example.com`,
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
        title: 'Delivery test video',
        sourceStorageKey: randomUUID(),
      }),
    );
  }

  it('returns a presigned URL on the public host that expires in STORAGE_PRESIGNED_URL_TTL_SECONDS', async () => {
    const video = await createVideo();

    const url = await service.getStreamUrl(video.id);
    const parsed = new URL(url);

    expect(parsed.origin).toBe(config.publicEndpoint);
    expect(parsed.searchParams.get('X-Amz-Expires')).toBe(
      String(config.presignedUrlTtlSeconds),
    );
  });
});
