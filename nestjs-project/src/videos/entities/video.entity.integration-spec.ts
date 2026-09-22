import { randomUUID } from 'crypto';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import {
  Video,
  VideoProcessingStatus,
  VideoPublicationStatus,
} from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

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

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    const user = await userRepository.save(
      userRepository.create({
        email: `video_test_${++counter}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: 'Test Channel',
        nickname: `chan_${counter}`,
        user_id: user.id,
      }),
    );
  }

  it('should default processingStatus to UPLOADING and publicationStatus to DRAFT', async () => {
    const channel = await createChannel();

    const video = await videoRepository.save(
      videoRepository.create({
        channelId: channel.id,
        title: 'My video',
        sourceStorageKey: randomUUID(),
      }),
    );

    expect(video.processingStatus).toBe(VideoProcessingStatus.UPLOADING);
    expect(video.publicationStatus).toBe(VideoPublicationStatus.DRAFT);
  });

  it('should reject a video without channelId (FK not-null)', async () => {
    await expect(
      videoRepository.save(
        videoRepository.create({
          title: 'My video',
          sourceStorageKey: randomUUID(),
        }),
      ),
    ).rejects.toThrow();
  });

  it('should reject a video without title (not-null)', async () => {
    const channel = await createChannel();

    await expect(
      videoRepository.save(
        videoRepository.create({
          channelId: channel.id,
          sourceStorageKey: randomUUID(),
        }),
      ),
    ).rejects.toThrow();
  });

  it('should default uploadCompletedAt to null', async () => {
    const channel = await createChannel();

    const video = await videoRepository.save(
      videoRepository.create({
        channelId: channel.id,
        title: 'My video',
        sourceStorageKey: randomUUID(),
      }),
    );

    expect(video.uploadCompletedAt).toBeNull();
  });
});
