import type { Job } from 'bullmq';
import { UnrecoverableError } from 'bullmq';
import { Repository } from 'typeorm';
import { Video, VideoProcessingStatus } from '../videos/entities/video.entity';
import { VideoProcessingProcessor } from './video-processing.processor';
import { WorkerTempStorageService } from './worker-temp-storage.service';

function fakeJob(videoId: string, id = 'job-1'): Job<{ videoId: string }> {
  return {
    id,
    data: { videoId },
  } as unknown as Job<{ videoId: string }>;
}

describe('VideoProcessingProcessor', () => {
  let videoRepository: { findOneBy: jest.Mock; update: jest.Mock };
  let tempStorage: { downloadToTempDir: jest.Mock; cleanup: jest.Mock };
  let processor: VideoProcessingProcessor;

  beforeEach(() => {
    videoRepository = {
      findOneBy: jest.fn(),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    tempStorage = {
      downloadToTempDir: jest.fn().mockResolvedValue('/tmp/videos/job-1/source'),
      cleanup: jest.fn().mockResolvedValue(undefined),
    };
    processor = new VideoProcessingProcessor(
      videoRepository as unknown as Repository<Video>,
      tempStorage as unknown as WorkerTempStorageService,
    );
  });

  it('throws UnrecoverableError immediately when the video does not exist', async () => {
    videoRepository.findOneBy.mockResolvedValue(null);

    await expect(
      processor.process(fakeJob('missing-id')),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(videoRepository.update).not.toHaveBeenCalled();
  });

  it('writes processingStatus = PROCESSING for an UPLOADING video, then downloads to the job temp dir', async () => {
    videoRepository.findOneBy.mockResolvedValue({
      id: 'video-1',
      sourceStorageKey: 'video-1',
      processingStatus: VideoProcessingStatus.UPLOADING,
    });

    await processor.process(fakeJob('video-1'));

    expect(videoRepository.update).toHaveBeenCalledWith(
      { id: 'video-1' },
      { processingStatus: VideoProcessingStatus.PROCESSING },
    );
    expect(tempStorage.downloadToTempDir).toHaveBeenCalledWith(
      'job-1',
      'video-1',
    );
  });

  it('is a safe no-op when the video is already READY', async () => {
    videoRepository.findOneBy.mockResolvedValue({
      id: 'video-1',
      processingStatus: VideoProcessingStatus.READY,
    });

    await processor.process(fakeJob('video-1'));

    expect(videoRepository.update).not.toHaveBeenCalled();
    expect(tempStorage.downloadToTempDir).not.toHaveBeenCalled();
  });

  it('is a safe no-op when the video is already FAILED, never rewriting PROCESSING', async () => {
    videoRepository.findOneBy.mockResolvedValue({
      id: 'video-1',
      processingStatus: VideoProcessingStatus.FAILED,
    });

    await processor.process(fakeJob('video-1'));

    expect(videoRepository.update).not.toHaveBeenCalled();
    expect(tempStorage.downloadToTempDir).not.toHaveBeenCalled();
  });

  it('cleans up the job temp dir in a finally block, even when the download fails', async () => {
    videoRepository.findOneBy.mockResolvedValue({
      id: 'video-1',
      sourceStorageKey: 'video-1',
      processingStatus: VideoProcessingStatus.UPLOADING,
    });
    tempStorage.downloadToTempDir.mockRejectedValue(
      new Error('insufficient disk space'),
    );

    await expect(processor.process(fakeJob('video-1'))).rejects.toThrow(
      'insufficient disk space',
    );

    expect(tempStorage.cleanup).toHaveBeenCalledWith('job-1');
  });
});
