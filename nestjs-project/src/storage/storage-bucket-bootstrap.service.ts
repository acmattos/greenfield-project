import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import {
  BucketAlreadyExists,
  BucketAlreadyOwnedByYou,
  CreateBucketCommand,
  HeadBucketCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import storageConfig from '../config/storage.config';
import { INTERNAL_S3_CLIENT } from './storage.constants';

@Injectable()
export class StorageBucketBootstrapService implements OnModuleInit {
  constructor(
    @Inject(INTERNAL_S3_CLIENT) private readonly s3Client: S3Client,
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.ensureBucketExists();
  }

  async ensureBucketExists(): Promise<void> {
    const bucket = this.config.bucket;

    try {
      await this.s3Client.send(new HeadBucketCommand({ Bucket: bucket }));
      return;
    } catch {
      // Bucket not found (or otherwise unreachable) — attempt creation below.
    }

    try {
      await this.s3Client.send(new CreateBucketCommand({ Bucket: bucket }));
    } catch (error) {
      const name = (error as { name?: string })?.name;
      if (
        name === BucketAlreadyOwnedByYou.name ||
        name === BucketAlreadyExists.name
      ) {
        // Lost the create race to a concurrent API/worker bootstrap — not an error.
        return;
      }
      throw error;
    }
  }
}
