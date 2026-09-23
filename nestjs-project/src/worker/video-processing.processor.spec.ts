import type { Job } from 'bullmq';
import { UnrecoverableError } from 'bullmq';
import { Repository } from 'typeorm';
import type { S3Client } from '@aws-sdk/client-s3';
import { Video, VideoProcessingStatus } from '../videos/entities/video.entity';
import type { FfmpegVideoProcessorAdapter } from './ffmpeg-video-processor.adapter';
import { VideoProcessingProcessor } from './video-processing.processor';
import { WorkerTempStorageService } from './worker-temp-storage.service';

function fakeJob(videoId: string, id = 'job-1'): Job<{ videoId: string }> {
  return {
    id,
    data: { videoId },
  } as unknown as Job<{ videoId: string }>;
}

const VALID_MP4_PROBE = {
  streams: [{ codec_type: 'video', codec_name: 'h264' }],
  format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', tags: { major_brand: 'isom' } },
};

describe('VideoProcessingProcessor', () => {
  let videoRepository: { findOneBy: jest.Mock; update: jest.Mock };
  let tempStorage: { downloadToTempDir: jest.Mock; cleanup: jest.Mock };
  let videoProcessor: { probe: jest.Mock };
  let s3Client: { send: jest.Mock };
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
    videoProcessor = {
      probe: jest.fn().mockResolvedValue(VALID_MP4_PROBE),
    };
    s3Client = { send: jest.fn().mockResolvedValue({}) };
    processor = new VideoProcessingProcessor(
      videoRepository as unknown as Repository<Video>,
      tempStorage as unknown as WorkerTempStorageService,
      videoProcessor as unknown as FfmpegVideoProcessorAdapter,
      s3Client as unknown as S3Client,
      { bucket: 'videos' } as never,
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

  describe('format validation', () => {
    beforeEach(() => {
      videoRepository.findOneBy.mockResolvedValue({
        id: 'video-1',
        sourceStorageKey: 'video-1',
        processingStatus: VideoProcessingStatus.UPLOADING,
      });
    });

    it('proceeds past probing for a valid MP4/H.264 video', async () => {
      videoProcessor.probe.mockResolvedValue(VALID_MP4_PROBE);

      await expect(processor.process(fakeJob('video-1'))).resolves.toBeUndefined();
      expect(s3Client.send).not.toHaveBeenCalled();
    });

    it('rejects an invalid format with UnrecoverableError, without writing processingStatus itself', async () => {
      videoProcessor.probe.mockResolvedValue({
        streams: [{ codec_type: 'video', codec_name: 'mpeg2video' }],
        format: {
          format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
          tags: { major_brand: 'isom' },
        },
      });

      await expect(
        processor.process(fakeJob('video-1')),
      ).rejects.toBeInstanceOf(UnrecoverableError);

      // Only the earlier PROCESSING write happened — never a second write
      // for FAILED; that belongs exclusively to the SI-03.15 event handler.
      expect(videoRepository.update).toHaveBeenCalledTimes(1);
      expect(videoRepository.update).toHaveBeenCalledWith(
        { id: 'video-1' },
        { processingStatus: VideoProcessingStatus.PROCESSING },
      );
    });

    it('deletes the source storage object when the format is rejected', async () => {
      videoProcessor.probe.mockResolvedValue({
        streams: [{ codec_type: 'video', codec_name: 'mpeg2video' }],
        format: {
          format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
          tags: { major_brand: 'isom' },
        },
      });

      await expect(
        processor.process(fakeJob('video-1')),
      ).rejects.toBeInstanceOf(UnrecoverableError);

      expect(s3Client.send).toHaveBeenCalledTimes(1);
    });

    it('still cleans up the job temp dir when the format is rejected', async () => {
      videoProcessor.probe.mockResolvedValue({
        streams: [{ codec_type: 'video', codec_name: 'mpeg2video' }],
        format: {
          format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
          tags: { major_brand: 'isom' },
        },
      });

      await expect(
        processor.process(fakeJob('video-1')),
      ).rejects.toBeInstanceOf(UnrecoverableError);

      expect(tempStorage.cleanup).toHaveBeenCalledWith('job-1');
    });
  });
});
