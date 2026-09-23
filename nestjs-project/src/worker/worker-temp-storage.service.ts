import { createWriteStream } from 'fs';
import { mkdir, rm, statfs } from 'fs/promises';
import { join } from 'path';
import { pipeline } from 'stream/promises';
import type { Readable } from 'stream';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import {
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import storageConfig from '../config/storage.config';
import { INTERNAL_S3_CLIENT } from '../storage/storage.constants';
import { WORKER_TEMP_DIR } from './worker.constants';

@Injectable()
export class WorkerTempStorageService {
  private readonly logger = new Logger(WorkerTempStorageService.name);

  constructor(
    @Inject(INTERNAL_S3_CLIENT) private readonly s3Client: S3Client,
    @Inject(storageConfig.KEY)
    private readonly storage: ConfigType<typeof storageConfig>,
  ) {}

  private jobDir(jobId: string): string {
    return join(WORKER_TEMP_DIR, jobId);
  }

  sourceFilePath(jobId: string): string {
    return join(this.jobDir(jobId), 'source');
  }

  async downloadToTempDir(
    jobId: string,
    sourceStorageKey: string,
  ): Promise<string> {
    const head = await this.s3Client.send(
      new HeadObjectCommand({
        Bucket: this.storage.bucket,
        Key: sourceStorageKey,
      }),
    );
    const contentLength = head.ContentLength ?? 0;

    // Self-contained: does not depend on another service (e.g. the startup
    // capacity check) having already created this directory.
    await mkdir(WORKER_TEMP_DIR, { recursive: true });
    const stats = await statfs(WORKER_TEMP_DIR);
    const availableBytes = stats.bavail * stats.bsize;
    if (contentLength > availableBytes) {
      throw new Error(
        `Insufficient free disk space to download job ${jobId}: object is ${contentLength} bytes, only ${availableBytes} bytes available`,
      );
    }

    const destPath = this.sourceFilePath(jobId);
    await mkdir(this.jobDir(jobId), { recursive: true });

    const { Body } = await this.s3Client.send(
      new GetObjectCommand({
        Bucket: this.storage.bucket,
        Key: sourceStorageKey,
      }),
    );
    await pipeline(Body as Readable, createWriteStream(destPath));

    this.logger.log(
      `Downloaded ${contentLength} bytes for job ${jobId} to ${destPath}`,
    );
    return destPath;
  }

  async cleanup(jobId: string): Promise<void> {
    await rm(this.jobDir(jobId), { recursive: true, force: true });
  }
}
