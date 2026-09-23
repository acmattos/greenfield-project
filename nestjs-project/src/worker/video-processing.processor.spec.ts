import type { Job } from 'bullmq';
import { UnrecoverableError } from 'bullmq';
import { Repository } from 'typeorm';
import { Video, VideoProcessingStatus } from '../videos/entities/video.entity';
import { VideoProcessingProcessor } from './video-processing.processor';

function fakeJob(videoId: string): Job<{ videoId: string }> {
  return {
    id: 'job-1',
    data: { videoId },
  } as unknown as Job<{ videoId: string }>;
}

describe('VideoProcessingProcessor', () => {
  let videoRepository: { findOneBy: jest.Mock; update: jest.Mock };
  let processor: VideoProcessingProcessor;

  beforeEach(() => {
    videoRepository = {
      findOneBy: jest.fn(),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    processor = new VideoProcessingProcessor(
      videoRepository as unknown as Repository<Video>,
    );
  });

  it('throws UnrecoverableError immediately when the video does not exist', async () => {
    videoRepository.findOneBy.mockResolvedValue(null);

    await expect(
      processor.process(fakeJob('missing-id')),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(videoRepository.update).not.toHaveBeenCalled();
  });

  it('writes processingStatus = PROCESSING for an UPLOADING video', async () => {
    videoRepository.findOneBy.mockResolvedValue({
      id: 'video-1',
      processingStatus: VideoProcessingStatus.UPLOADING,
    });

    await processor.process(fakeJob('video-1'));

    expect(videoRepository.update).toHaveBeenCalledWith(
      { id: 'video-1' },
      { processingStatus: VideoProcessingStatus.PROCESSING },
    );
  });

  it('is a safe no-op when the video is already READY', async () => {
    videoRepository.findOneBy.mockResolvedValue({
      id: 'video-1',
      processingStatus: VideoProcessingStatus.READY,
    });

    await processor.process(fakeJob('video-1'));

    expect(videoRepository.update).not.toHaveBeenCalled();
  });

  it('is a safe no-op when the video is already FAILED, never rewriting PROCESSING', async () => {
    videoRepository.findOneBy.mockResolvedValue({
      id: 'video-1',
      processingStatus: VideoProcessingStatus.FAILED,
    });

    await processor.process(fakeJob('video-1'));

    expect(videoRepository.update).not.toHaveBeenCalled();
  });
});
