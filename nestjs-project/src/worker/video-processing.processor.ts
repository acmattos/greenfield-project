import { Injectable, Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Job, UnrecoverableError } from 'bullmq';
import { Repository } from 'typeorm';
import { VIDEO_PROCESSING_QUEUE } from '../queue/queue.constants';
import { Video, VideoProcessingStatus } from '../videos/entities/video.entity';

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

    // Free-space preflight + download + FFprobe + thumbnail + READY
    // transition: SI-03.12 through SI-03.14.
  }
}
