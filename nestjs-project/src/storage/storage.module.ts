import { Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { S3Client } from '@aws-sdk/client-s3';
import storageConfig from '../config/storage.config';
import { StorageBucketBootstrapService } from './storage-bucket-bootstrap.service';
import { INTERNAL_S3_CLIENT, PUBLIC_S3_CLIENT } from './storage.constants';

@Module({
  providers: [
    {
      provide: INTERNAL_S3_CLIENT,
      inject: [storageConfig.KEY],
      useFactory: (config: ConfigType<typeof storageConfig>) =>
        new S3Client({
          endpoint: config.endpoint,
          forcePathStyle: true,
          region: config.region,
          credentials: {
            accessKeyId: config.accessKeyId,
            secretAccessKey: config.secretAccessKey,
          },
        }),
    },
    {
      // Distinct client, distinct token — never shared with INTERNAL_S3_CLIENT.
      // Points at the public endpoint so presigned URLs are reachable by the browser.
      provide: PUBLIC_S3_CLIENT,
      inject: [storageConfig.KEY],
      useFactory: (config: ConfigType<typeof storageConfig>) =>
        new S3Client({
          endpoint: config.publicEndpoint,
          forcePathStyle: true,
          region: config.region,
          credentials: {
            accessKeyId: config.accessKeyId,
            secretAccessKey: config.secretAccessKey,
          },
        }),
    },
    StorageBucketBootstrapService,
  ],
  exports: [INTERNAL_S3_CLIENT, PUBLIC_S3_CLIENT],
})
export class StorageModule {}
