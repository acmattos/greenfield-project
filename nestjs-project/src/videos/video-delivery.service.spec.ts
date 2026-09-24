import { S3Client } from '@aws-sdk/client-s3';
import type { Repository } from 'typeorm';
import type { ConfigType } from '@nestjs/config';
import type storageConfig from '../config/storage.config';
import {
  Video,
  VideoProcessingStatus,
  VideoPublicationStatus,
} from './entities/video.entity';
import { VideoNotFoundException } from './exceptions/video-not-found.exception';
import { VideoDeliveryService } from './video-delivery.service';

const VIDEO_ID = '11111111-1111-4111-8111-111111111111';

function buildVideo(overrides: Partial<Video> = {}): Video {
  return {
    id: VIDEO_ID,
    channelId: 'channel-1',
    title: 'Test video',
    processingStatus: VideoProcessingStatus.READY,
    publicationStatus: VideoPublicationStatus.DRAFT,
    sourceStorageKey: VIDEO_ID,
    thumbnailStorageKey: null,
    uploadCompletedAt: null,
    durationSeconds: null,
    width: null,
    height: null,
    videoCodec: null,
    audioCodec: null,
    bitRate: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    channel: undefined as never,
    ...overrides,
  };
}

describe('VideoDeliveryService (unit)', () => {
  it('signs URLs against STORAGE_PUBLIC_ENDPOINT, never STORAGE_ENDPOINT', async () => {
    const internalEndpoint = 'http://minio:9000';
    const publicEndpoint = 'http://localhost:9000';

    const video = buildVideo();
    const videoRepository = {
      findOneBy: jest.fn().mockResolvedValue(video),
    } as unknown as Repository<Video>;

    const publicClient = new S3Client({
      endpoint: publicEndpoint,
      forcePathStyle: true,
      region: 'us-east-1',
      credentials: {
        accessKeyId: 'streamtube',
        secretAccessKey: 'streamtube',
      },
    });

    const config = {
      bucket: 'videos',
      presignedUrlTtlSeconds: 3600,
    } as ConfigType<typeof storageConfig>;

    const service = new VideoDeliveryService(
      videoRepository,
      publicClient,
      config,
    );

    const url = await service.getStreamUrl(video.id);

    expect(new URL(url).origin).toBe(publicEndpoint);
    expect(new URL(url).origin).not.toBe(internalEndpoint);
  });

  it('rejects a syntactically malformed video id with VideoNotFoundException, never querying the repository', async () => {
    const findOneByMock = jest.fn();
    const videoRepository = {
      findOneBy: findOneByMock,
    } as unknown as Repository<Video>;
    const s3Client = new S3Client({
      endpoint: 'http://localhost:9000',
      forcePathStyle: true,
      region: 'us-east-1',
      credentials: { accessKeyId: 'streamtube', secretAccessKey: 'streamtube' },
    });
    const config = {
      bucket: 'videos',
      presignedUrlTtlSeconds: 3600,
    } as ConfigType<typeof storageConfig>;
    const service = new VideoDeliveryService(videoRepository, s3Client, config);

    await expect(service.getStreamUrl('not-a-uuid')).rejects.toBeInstanceOf(
      VideoNotFoundException,
    );
    expect(findOneByMock).not.toHaveBeenCalled();
  });
});
