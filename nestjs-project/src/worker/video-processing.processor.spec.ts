import type { Job } from 'bullmq';
import { UnrecoverableError } from 'bullmq';
import { Repository } from 'typeorm';
import type { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
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

function fakeFailedJob(
  videoId: string,
  attemptsMade: number,
  attempts = 3,
): Job<{ videoId: string }> {
  return {
    id: 'job-1',
    data: { videoId },
    attemptsMade,
    opts: { attempts },
  } as unknown as Job<{ videoId: string }>;
}

const VALID_MP4_PROBE = {
  streams: [{ codec_type: 'video', codec_name: 'h264' }],
  format: {
    format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
    tags: { major_brand: 'isom' },
  },
};

describe('VideoProcessingProcessor', () => {
  let videoRepository: { findOneBy: jest.Mock; update: jest.Mock };
  let tempStorage: { downloadToTempDir: jest.Mock; cleanup: jest.Mock };
  let videoProcessor: { probe: jest.Mock; extractThumbnail: jest.Mock };
  let s3Client: { send: jest.Mock };
  let processor: VideoProcessingProcessor;

  beforeEach(() => {
    videoRepository = {
      findOneBy: jest.fn(),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    tempStorage = {
      downloadToTempDir: jest
        .fn()
        .mockResolvedValue('/tmp/videos/job-1/source'),
      cleanup: jest.fn().mockResolvedValue(undefined),
    };
    videoProcessor = {
      probe: jest.fn().mockResolvedValue(VALID_MP4_PROBE),
      extractThumbnail: jest.fn().mockResolvedValue(Buffer.from('fake-jpeg')),
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

  it('writes processingStatus = PROCESSING for an UPLOADING video, as the first write, then downloads to the job temp dir', async () => {
    videoRepository.findOneBy.mockResolvedValue({
      id: 'video-1',
      sourceStorageKey: 'video-1',
      processingStatus: VideoProcessingStatus.UPLOADING,
    });

    await processor.process(fakeJob('video-1'));

    expect(videoRepository.update).toHaveBeenNthCalledWith(
      1,
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

    it('proceeds past probing for a valid MP4/H.264 video, all the way to READY', async () => {
      videoProcessor.probe.mockResolvedValue(VALID_MP4_PROBE);

      await expect(
        processor.process(fakeJob('video-1')),
      ).resolves.toBeUndefined();

      // Thumbnail upload — not the source-deletion path (format validation
      // passed), confirmed by the second write setting READY below.
      expect(s3Client.send).toHaveBeenCalledTimes(1);
      expect(videoRepository.update).toHaveBeenLastCalledWith(
        { id: 'video-1' },
        expect.objectContaining({
          processingStatus: VideoProcessingStatus.READY,
          thumbnailStorageKey: 'videos/video-1/thumbnail',
        }),
      );
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

  describe('metadata extraction, thumbnail, and READY transition', () => {
    beforeEach(() => {
      videoRepository.findOneBy.mockResolvedValue({
        id: 'video-1',
        sourceStorageKey: 'video-1',
        processingStatus: VideoProcessingStatus.UPLOADING,
      });
    });

    it('persists extracted metadata and thumbnailStorageKey, and sets READY', async () => {
      videoProcessor.probe.mockResolvedValue({
        streams: [
          {
            codec_type: 'video',
            codec_name: 'h264',
            width: 1920,
            height: 1080,
          },
          { codec_type: 'audio', codec_name: 'aac' },
        ],
        format: {
          format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
          duration: '12.500000',
          bit_rate: '1048576',
          tags: { major_brand: 'isom' },
        },
      });

      await processor.process(fakeJob('video-1'));

      expect(videoRepository.update).toHaveBeenLastCalledWith(
        { id: 'video-1' },
        {
          durationSeconds: 13, // Math.round(12.5)
          width: 1920,
          height: 1080,
          videoCodec: 'h264',
          audioCodec: 'aac',
          bitRate: 1048576,
          thumbnailStorageKey: 'videos/video-1/thumbnail',
          processingStatus: VideoProcessingStatus.READY,
        },
      );
    });

    it('persists audioCodec: null for a silent video', async () => {
      videoProcessor.probe.mockResolvedValue({
        streams: [
          { codec_type: 'video', codec_name: 'h264', width: 640, height: 480 },
        ],
        format: {
          format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
          duration: '5.000000',
          bit_rate: '512000',
          tags: { major_brand: 'isom' },
        },
      });

      await processor.process(fakeJob('video-1'));

      expect(videoRepository.update).toHaveBeenLastCalledWith(
        { id: 'video-1' },
        expect.objectContaining({ audioCodec: null }),
      );
    });

    it('derives the thumbnail timestamp from the raw probed duration, capped at 2s', async () => {
      videoProcessor.probe.mockResolvedValue({
        streams: [{ codec_type: 'video', codec_name: 'h264' }],
        format: {
          format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
          duration: '30.000000',
          tags: { major_brand: 'isom' },
        },
      });

      await processor.process(fakeJob('video-1'));

      expect(videoProcessor.extractThumbnail).toHaveBeenCalledWith(
        '/tmp/videos/job-1/source',
        2,
      );
    });

    it('derives a sub-2s thumbnail timestamp for a very short (~1s) video, never exceeding its duration', async () => {
      videoProcessor.probe.mockResolvedValue({
        streams: [{ codec_type: 'video', codec_name: 'h264' }],
        format: {
          format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
          duration: '1.000000',
          tags: { major_brand: 'isom' },
        },
      });

      await processor.process(fakeJob('video-1'));

      expect(videoProcessor.extractThumbnail).toHaveBeenCalledWith(
        '/tmp/videos/job-1/source',
        0.5,
      );
    });

    it('uploads the thumbnail buffer to the storage-derived key with image/jpeg content type', async () => {
      videoProcessor.probe.mockResolvedValue(VALID_MP4_PROBE);
      videoProcessor.extractThumbnail.mockResolvedValue(
        Buffer.from('jpeg-bytes'),
      );

      await processor.process(fakeJob('video-1'));

      expect(s3Client.send).toHaveBeenCalledTimes(1);
      const calls = s3Client.send.mock.calls as PutObjectCommand[][];
      const putCommand = calls[0][0];
      expect(putCommand.input).toMatchObject({
        Bucket: 'videos',
        Key: 'videos/video-1/thumbnail',
        ContentType: 'image/jpeg',
      });
    });
  });

  describe("@OnWorkerEvent('failed')", () => {
    it('persists FAILED when the error is an UnrecoverableError', async () => {
      const job = fakeFailedJob('video-1', 1, 3);

      await processor.onFailed(job, new UnrecoverableError('bad format'));

      expect(videoRepository.update).toHaveBeenCalledWith(
        { id: 'video-1' },
        { processingStatus: VideoProcessingStatus.FAILED },
      );
    });

    it('does not persist FAILED for a transient error that will still be retried (attemptsMade < attempts)', async () => {
      const job = fakeFailedJob('video-1', 2, 3);

      await processor.onFailed(job, new Error('transient network error'));

      expect(videoRepository.update).not.toHaveBeenCalled();
    });

    it('persists FAILED for a transient error whose attempts are exhausted (attemptsMade >= attempts)', async () => {
      const job = fakeFailedJob('video-1', 3, 3);

      await processor.onFailed(job, new Error('transient network error'));

      expect(videoRepository.update).toHaveBeenCalledWith(
        { id: 'video-1' },
        { processingStatus: VideoProcessingStatus.FAILED },
      );
    });

    it('persistTerminalFailure does not throw for a videoId with no matching row', async () => {
      videoRepository.update.mockResolvedValue({ affected: 0 });

      await expect(
        processor.persistTerminalFailure('missing-id', 'some reason'),
      ).resolves.toBeUndefined();
    });
  });
});
