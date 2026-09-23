import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { ConfigType } from '@nestjs/config';
import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { Queue } from 'bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, LessThan, Not, Repository } from 'typeorm';
import storageConfig from '../config/storage.config';
import workerConfig from '../config/worker.config';
import {
  VIDEO_PROCESSING_JOB_OPTIONS,
  VIDEO_PROCESSING_QUEUE,
} from '../queue/queue.constants';
import { INTERNAL_S3_CLIENT } from '../storage/storage.constants';
import { Video, VideoProcessingStatus } from '../videos/entities/video.entity';
import { VideoProcessingProcessor } from './video-processing.processor';

// Registered via a lifecycle hook (this SI); the interval handle is cleared
// on graceful shutdown by SI-03.18, not here.
@Injectable()
export class ReconciliationSweepService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ReconciliationSweepService.name);
  private intervalHandle?: NodeJS.Timeout;

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly queue: Queue,
    @Inject(INTERNAL_S3_CLIENT) private readonly s3Client: S3Client,
    @Inject(storageConfig.KEY)
    private readonly storage: ConfigType<typeof storageConfig>,
    @Inject(workerConfig.KEY)
    private readonly worker: ConfigType<typeof workerConfig>,
    private readonly processor: VideoProcessingProcessor,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.sweep();
    this.intervalHandle = setInterval(() => {
      this.sweep().catch((error: Error) => {
        this.logger.error(`Reconciliation sweep failed: ${error.message}`);
      });
    }, this.worker.reconciliationIntervalMs);
  }

  async sweep(): Promise<void> {
    await this.reenqueueCompletedUploads();
    await this.recoverStorageAnchoredUploads();
    await this.repairLostFailures();
  }

  // Branch 1 (per upload-processing/TD-11): the durable uploadCompletedAt
  // write succeeded but the enqueue call itself failed — re-enqueue with the
  // same deterministic jobId (BullMQ's own job-id uniqueness silently
  // no-ops a duplicate add() while the original job is still in the queue).
  private async reenqueueCompletedUploads(): Promise<void> {
    const videos = await this.videoRepository.find({
      where: {
        processingStatus: VideoProcessingStatus.UPLOADING,
        uploadCompletedAt: Not(IsNull()),
      },
    });

    for (const video of videos) {
      try {
        await this.enqueueProcessing(video.id);
      } catch (error) {
        this.logger.error(
          `Reconciliation branch 1 failed to re-enqueue video ${video.id}: ${(error as Error).message}`,
        );
      }
    }
  }

  // Branch 2 (per upload-processing/TD-11's revision): the uploadCompletedAt
  // write itself never happened (e.g. Postgres briefly unavailable), but the
  // object may already be durably complete in storage — proven only by a
  // successful HeadObjectCommand against the deterministic key (video.id).
  private async recoverStorageAnchoredUploads(): Promise<void> {
    const cutoff = new Date(Date.now() - this.worker.reconciliationGracePeriodMs);
    const videos = await this.videoRepository.find({
      where: {
        processingStatus: VideoProcessingStatus.UPLOADING,
        uploadCompletedAt: IsNull(),
        updatedAt: LessThan(cutoff),
      },
    });

    for (const video of videos) {
      try {
        const head = await this.s3Client.send(
          new HeadObjectCommand({
            Bucket: this.storage.bucket,
            Key: video.id,
          }),
        );

        await this.videoRepository.update(
          { id: video.id },
          { uploadCompletedAt: head.LastModified ?? new Date() },
        );
        await this.enqueueProcessing(video.id);
      } catch (error) {
        const httpStatus = (
          error as { $metadata?: { httpStatusCode?: number } }
        ).$metadata?.httpStatusCode;
        if (httpStatus === 404) {
          // Object genuinely does not exist yet — upload still in progress
          // or abandoned. Leave the row untouched, per TD-11's revision.
          continue;
        }
        this.logger.error(
          `Reconciliation branch 2 failed to probe/recover video ${video.id}: ${(error as Error).message}`,
        );
      }
    }
  }

  // Branch 3 (per upload-processing/TD-10's revision): repairs the
  // durability gap where BullMQ already confirmed a job 'failed' but the
  // live @OnWorkerEvent('failed') handler's write never landed (crash,
  // brief Postgres unavailability). Reuses the SAME persistTerminalFailure
  // writer as the live event — never a second, independently-decided one.
  private async repairLostFailures(): Promise<void> {
    const videos = await this.videoRepository.find({
      where: { processingStatus: VideoProcessingStatus.PROCESSING },
    });

    for (const video of videos) {
      try {
        const job = await this.queue.getJob(`process-video-${video.id}`);
        if (!job) {
          continue;
        }
        const state = await job.getState();
        if (state === 'failed') {
          await this.processor.persistTerminalFailure(
            video.id,
            job.failedReason ?? 'Unknown failure',
          );
        }
      } catch (error) {
        this.logger.error(
          `Reconciliation branch 3 failed to inspect job for video ${video.id}: ${(error as Error).message}`,
        );
      }
    }
  }

  private async enqueueProcessing(videoId: string): Promise<void> {
    await this.queue.add(
      'video.processing',
      { videoId },
      { jobId: `process-video-${videoId}`, ...VIDEO_PROCESSING_JOB_OPTIONS },
    );
  }
}
