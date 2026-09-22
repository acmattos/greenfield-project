import { S3Client } from '@aws-sdk/client-s3';
import type { Repository } from 'typeorm';
import type { ConfigType } from '@nestjs/config';
import type storageConfig from '../config/storage.config';
import {
  Video,
  VideoProcessingStatus,
  VideoPublicationStatus,
} from './entities/video.entity';
import { VideoDeliveryService } from './video-delivery.service';

function buildVideo(overrides: Partial<Video> = {}): Video {
  return {
    id: 'video-1',
    channelId: 'channel-1',
    title: 'Test video',
    processingStatus: VideoProcessingStatus.READY,
    publicationStatus: VideoPublicationStatus.DRAFT,
    sourceStorageKey: 'video-1',
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
});
