import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import storageConfig from '../config/storage.config';
import { PUBLIC_S3_CLIENT } from '../storage/storage.constants';
import { Video } from './entities/video.entity';
import { VideoNotFoundException } from './exceptions/video-not-found.exception';

@Injectable()
export class VideoDeliveryService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    @Inject(PUBLIC_S3_CLIENT) private readonly s3Client: S3Client,
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {}

  async getStreamUrl(videoId: string): Promise<string> {
    const video = await this.findVideoOrThrow(videoId);
    return this.buildSignedUrl(video.sourceStorageKey, {});
  }

  async getDownloadUrl(videoId: string): Promise<string> {
    const video = await this.findVideoOrThrow(videoId);
    return this.buildSignedUrl(video.sourceStorageKey, {
      ResponseContentDisposition: 'attachment',
    });
  }

  private async findVideoOrThrow(videoId: string): Promise<Video> {
    const video = await this.videoRepository.findOneBy({ id: videoId });
    if (!video) {
      throw new VideoNotFoundException(videoId);
    }
    return video;
  }

  private async buildSignedUrl(
    sourceStorageKey: string,
    extra: { ResponseContentDisposition?: string },
  ): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.config.bucket,
      Key: sourceStorageKey,
      ResponseContentType: 'video/mp4',
      ...extra,
    });

    return getSignedUrl(this.s3Client, command, {
      expiresIn: this.config.presignedUrlTtlSeconds,
    });
  }
}
