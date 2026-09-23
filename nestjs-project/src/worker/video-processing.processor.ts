import { Inject, Injectable, Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Job, UnrecoverableError } from 'bullmq';
import { Repository } from 'typeorm';
import storageConfig from '../config/storage.config';
import { VIDEO_PROCESSING_QUEUE } from '../queue/queue.constants';
import { INTERNAL_S3_CLIENT } from '../storage/storage.constants';
import { Video, VideoProcessingStatus } from '../videos/entities/video.entity';
import { FfmpegVideoProcessorAdapter } from './ffmpeg-video-processor.adapter';
import { isSupportedVideoFormat } from './video-format-validator';
import { WorkerTempStorageService } from './worker-temp-storage.service';

// Read directly from process.env — @Processor's worker options are resolved
// at class-decoration time (module import), before the Nest DI container
// (and therefore ConfigService) exists.
const WORKER_CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY || '1', 10);

@Injectable()
@Processor(VIDEO_PROCESSING_QUEUE, { concurrency: WORKER_CONCURRENCY })
export class VideoProcessingProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessingProcessor.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly tempStorage: WorkerTempStorageService,
    private readonly videoProcessor: FfmpegVideoProcessorAdapter,
    @Inject(INTERNAL_S3_CLIENT) private readonly s3Client: S3Client,
    @Inject(storageConfig.KEY)
    private readonly storage: ConfigType<typeof storageConfig>,
  ) {
    super();
  }

  async process(job: Job<{ videoId: string }>): Promise<void> {
    const { videoId } = job.data;

    const video = await this.videoRepository.findOneBy({ id: videoId });
    if (!video) {
      // Malformed/foreign job payload — a permanent condition no retry can
      // fix (per upload-processing/TD-10). Never reaches the write below.
      throw new UnrecoverableError(`Video not found: ${videoId}`);
    }

    if (
      video.processingStatus === VideoProcessingStatus.READY ||
      video.processingStatus === VideoProcessingStatus.FAILED
    ) {
      // Safe no-op — per TD-10's revision, FAILED is absolute-terminal in
      // this phase; a duplicate/delayed execution never resurrects it (or a
      // completed READY video) back into PROCESSING.
      this.logger.log(
        `Job ${job.id} for video ${videoId} is a safe no-op — processingStatus already ${video.processingStatus}`,
      );
      return;
    }

    // Written on every attempt, including BullMQ-initiated retries.
    await this.videoRepository.update(
      { id: videoId },
      { processingStatus: VideoProcessingStatus.PROCESSING },
    );

    const jobId = String(job.id);
    try {
      const sourcePath = await this.tempStorage.downloadToTempDir(
        jobId,
        video.sourceStorageKey,
      );

      const probeOutput = await this.videoProcessor.probe(sourcePath);
      if (!isSupportedVideoFormat(probeOutput)) {
        // Deliberately does NOT write processingStatus here — that write is
        // the exclusive responsibility of the @OnWorkerEvent('failed')
        // handler (SI-03.15), per upload-processing/TD-09, TD-10.
        await this.deleteSourceObject(video.sourceStorageKey);
        throw new UnrecoverableError(
          `Unsupported video format for video ${videoId}`,
        );
      }

      // Metadata/thumbnail extraction + READY transition: SI-03.14.
    } finally {
      // Runs regardless of outcome — never leaves a job's temp directory
      // behind, per upload-processing/TD-07.
      await this.tempStorage.cleanup(jobId);
    }
  }

  private async deleteSourceObject(sourceStorageKey: string): Promise<void> {
    await this.s3Client.send(
      new DeleteObjectCommand({
        Bucket: this.storage.bucket,
        Key: sourceStorageKey,
      }),
    );
  }
}
