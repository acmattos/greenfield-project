import { Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { S3Client } from '@aws-sdk/client-s3';
import storageConfig from '../config/storage.config';
import { INTERNAL_S3_CLIENT } from './storage.constants';

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
  ],
  exports: [INTERNAL_S3_CLIENT],
})
export class StorageModule {}
