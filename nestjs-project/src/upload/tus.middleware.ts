import { randomUUID } from 'crypto';
import { Injectable, NestMiddleware } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import type { Request, Response, NextFunction } from 'express';
import { Server } from '@tus/server';
import { S3Store } from '@tus/s3-store';
import storageConfig from '../config/storage.config';
import uploadConfig from '../config/upload.config';
import {
  S3_MAX_MULTIPART_PARTS,
  S3_PART_SIZE_BYTES,
  TUS_UPLOAD_PATH,
} from './upload.constants';
import { TusHooksService } from './tus-hooks.service';

@Injectable()
export class TusMiddleware implements NestMiddleware {
  private readonly server: Server;

  constructor(
    @Inject(storageConfig.KEY)
    storage: ConfigType<typeof storageConfig>,
    @Inject(uploadConfig.KEY)
    upload: ConfigType<typeof uploadConfig>,
    tusHooks: TusHooksService,
  ) {
    const s3Store = new S3Store({
      partSize: S3_PART_SIZE_BYTES,
      maxMultipartParts: S3_MAX_MULTIPART_PARTS,
      s3ClientConfig: {
        bucket: storage.bucket,
        region: storage.region,
        endpoint: storage.endpoint,
        forcePathStyle: true,
        credentials: {
          accessKeyId: storage.accessKeyId,
          secretAccessKey: storage.secretAccessKey,
        },
      },
    });

    this.server = new Server({
      path: TUS_UPLOAD_PATH,
      datastore: s3Store,
      namingFunction: () => randomUUID(),
      maxSize: upload.maxUploadBytes,
      disableTerminationForFinishedUploads: true,
      onIncomingRequest: (req, res, uploadId) =>
        tusHooks.onIncomingRequest(req, res, uploadId),
      onUploadCreate: (req, res, uploadObj) =>
        tusHooks.onUploadCreate(req, res, uploadObj),
    });
  }

  use(req: Request, res: Response, next: NextFunction): void {
    // @tus/server always resolves the response itself — never calls next().
    // Only forward unexpected rejections so Express's error pipeline sees them.
    this.server.handle(req, res).catch(next);
  }
}
