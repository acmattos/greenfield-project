import { IncomingMessage, ServerResponse } from 'http';
import { JwtService } from '@nestjs/jwt';
import type { Queue } from 'bullmq';
import { Repository } from 'typeorm';
import type { Upload } from '@tus/server';
import { Channel } from '../channels/entities/channel.entity';
import { Video } from '../videos/entities/video.entity';
import { TusHooksService } from './tus-hooks.service';

function fakeRequest(
  authHeader?: string,
  method: string = 'PATCH',
): IncomingMessage {
  return {
    method,
    headers: authHeader ? { authorization: authHeader } : {},
  } as IncomingMessage;
}

function fakeUpload(overrides: {
  id?: string;
  metadata?: Record<string, string | null>;
}): Upload {
  return {
    id: overrides.id ?? 'upload-id-1',
    metadata: overrides.metadata,
    size: 100,
    offset: 0,
  } as unknown as Upload;
}

describe('TusHooksService', () => {
  let jwtService: { verifyAsync: jest.Mock };
  let videoRepository: {
    create: jest.Mock;
    save: jest.Mock;
    findOne: jest.Mock;
    update: jest.Mock;
  };
  let channelRepository: { findOneBy: jest.Mock };
  let videoProcessingQueue: { add: jest.Mock };
  let service: TusHooksService;
  const res = {} as ServerResponse;
  const AUTH_HEADER = 'Bearer valid-token';

  beforeEach(() => {
    jwtService = { verifyAsync: jest.fn() };
    videoRepository = {
      create: jest.fn((x) => x),
      save: jest.fn((x) => Promise.resolve(x)),
      findOne: jest.fn(),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    channelRepository = { findOneBy: jest.fn() };
    videoProcessingQueue = { add: jest.fn().mockResolvedValue({}) };

    service = new TusHooksService(
      jwtService as unknown as JwtService,
      videoRepository as unknown as Repository<Video>,
      channelRepository as unknown as Repository<Channel>,
      videoProcessingQueue as unknown as Queue,
    );
  });

  function mockAuthenticatedChannel(channel: Partial<Channel> | null): void {
    jwtService.verifyAsync.mockResolvedValue({
      sub: 'user-1',
      email: 'u@example.com',
    });
    channelRepository.findOneBy.mockResolvedValue(channel);
  }

  describe('format validation', () => {
    it('accepts a supported filetype (video/mp4)', async () => {
      mockAuthenticatedChannel({ id: 'channel-1' });
      const upload = fakeUpload({ metadata: { filetype: 'video/mp4' } });

      await expect(
        service.onUploadCreate(fakeRequest(AUTH_HEADER), res, upload),
      ).resolves.toMatchObject({ res });
    });

    it('accepts when filetype is absent', async () => {
      mockAuthenticatedChannel({ id: 'channel-1' });
      const upload = fakeUpload({ metadata: {} });

      await expect(
        service.onUploadCreate(fakeRequest(AUTH_HEADER), res, upload),
      ).resolves.toMatchObject({ res });
    });

    it('rejects an unsupported filetype with 415 UNSUPPORTED_VIDEO_FORMAT, before checking auth', async () => {
      const upload = fakeUpload({ metadata: { filetype: 'video/avi' } });

      await expect(
        service.onUploadCreate(fakeRequest(AUTH_HEADER), res, upload),
      ).rejects.toMatchObject({
        status_code: 415,
        body: JSON.stringify({
          statusCode: 415,
          error: 'UNSUPPORTED_VIDEO_FORMAT',
          message: 'Unsupported video format',
        }),
      });
      expect(jwtService.verifyAsync).not.toHaveBeenCalled();
      expect(videoRepository.save).not.toHaveBeenCalled();
    });
  });

  describe('account integrity', () => {
    it('rejects with 500 ACCOUNT_INCOMPLETE when the authenticated user has no Channel', async () => {
      mockAuthenticatedChannel(null);
      const upload = fakeUpload({ metadata: {} });

      await expect(
        service.onUploadCreate(fakeRequest(AUTH_HEADER), res, upload),
      ).rejects.toMatchObject({
        status_code: 500,
        body: JSON.stringify({
          statusCode: 500,
          error: 'ACCOUNT_INCOMPLETE',
          message: 'Something went wrong',
        }),
      });
      expect(videoRepository.save).not.toHaveBeenCalled();
    });
  });

  describe('title fallback chain', () => {
    beforeEach(() => mockAuthenticatedChannel({ id: 'channel-1' }));

    it('uses Upload-Metadata.title, trimmed, when present', async () => {
      const upload = fakeUpload({ metadata: { title: '  My Video  ' } });
      await service.onUploadCreate(fakeRequest(AUTH_HEADER), res, upload);
      expect(videoRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'My Video' }),
      );
    });

    it('falls back to filename when title is absent', async () => {
      const upload = fakeUpload({ metadata: { filename: 'clip.mp4' } });
      await service.onUploadCreate(fakeRequest(AUTH_HEADER), res, upload);
      expect(videoRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'clip.mp4' }),
      );
    });

    it("falls back to 'Untitled video' when neither title nor filename is present", async () => {
      const upload = fakeUpload({ metadata: {} });
      await service.onUploadCreate(fakeRequest(AUTH_HEADER), res, upload);
      expect(videoRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Untitled video' }),
      );
    });

    it('truncates a resolved title exceeding 255 characters', async () => {
      const longTitle = 'a'.repeat(300);
      const upload = fakeUpload({ metadata: { title: longTitle } });
      await service.onUploadCreate(fakeRequest(AUTH_HEADER), res, upload);
      const savedArg = videoRepository.create.mock.calls[0][0];
      expect(savedArg.title).toHaveLength(255);
    });
  });

  describe('draft creation', () => {
    it("uses the upload's id as both Video.id and sourceStorageKey, and the resolved channelId", async () => {
      mockAuthenticatedChannel({ id: 'channel-1' });
      const upload = fakeUpload({ id: 'the-upload-id', metadata: {} });
      await service.onUploadCreate(fakeRequest(AUTH_HEADER), res, upload);
      expect(videoRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'the-upload-id',
          sourceStorageKey: 'the-upload-id',
          channelId: 'channel-1',
        }),
      );
    });
  });

  describe('onUploadFinish', () => {
    it('persists uploadCompletedAt before enqueueing the job', async () => {
      const callOrder: string[] = [];
      videoRepository.update.mockImplementation(async () => {
        callOrder.push('update');
        return { affected: 1 };
      });
      videoProcessingQueue.add.mockImplementation(async () => {
        callOrder.push('enqueue');
        return {};
      });

      const upload = fakeUpload({ id: 'video-1' });
      await service.onUploadFinish(fakeRequest(AUTH_HEADER), res, upload);

      expect(callOrder).toEqual(['update', 'enqueue']);
      expect(videoRepository.update).toHaveBeenCalledWith(
        { id: 'video-1' },
        { uploadCompletedAt: expect.any(Date) },
      );
    });

    it('enqueues exactly one video.processing job with a deterministic jobId', async () => {
      const upload = fakeUpload({ id: 'video-1' });
      await service.onUploadFinish(fakeRequest(AUTH_HEADER), res, upload);

      expect(videoProcessingQueue.add).toHaveBeenCalledTimes(1);
      expect(videoProcessingQueue.add).toHaveBeenCalledWith(
        'video.processing',
        { videoId: 'video-1' },
        { jobId: 'process-video-video-1' },
      );
    });
  });

  describe('onIncomingRequest', () => {
    const VALID_UUID = '11111111-2222-4333-8444-555555555555';

    it('passes an OPTIONS request through without checking auth', async () => {
      await expect(
        service.onIncomingRequest(fakeRequest(undefined, 'OPTIONS'), res, ''),
      ).resolves.toBeUndefined();
      expect(jwtService.verifyAsync).not.toHaveBeenCalled();
    });

    it('passes an authenticated POST (creation) without checking ownership — PostHandler passes the freshly-generated id, not an existing upload id', async () => {
      jwtService.verifyAsync.mockResolvedValue({
        sub: 'user-1',
        email: 'u@example.com',
      });

      await expect(
        service.onIncomingRequest(
          fakeRequest(AUTH_HEADER, 'POST'),
          res,
          VALID_UUID,
        ),
      ).resolves.toBeUndefined();
      expect(videoRepository.findOne).not.toHaveBeenCalled();
    });

    it('rejects a non-OPTIONS request without a token with 401 UNAUTHENTICATED', async () => {
      await expect(
        service.onIncomingRequest(fakeRequest(undefined, 'PATCH'), res, VALID_UUID),
      ).rejects.toMatchObject({
        status_code: 401,
        body: JSON.stringify({
          statusCode: 401,
          error: 'UNAUTHENTICATED',
          message: 'Authentication required',
        }),
      });
    });

    it('treats a syntactically malformed uploadId as 404, without querying the database', async () => {
      jwtService.verifyAsync.mockResolvedValue({
        sub: 'user-1',
        email: 'u@example.com',
      });

      await expect(
        service.onIncomingRequest(
          fakeRequest(AUTH_HEADER, 'PATCH'),
          res,
          'not-a-uuid',
        ),
      ).rejects.toMatchObject({
        status_code: 404,
        body: JSON.stringify({
          statusCode: 404,
          error: 'VIDEO_NOT_FOUND',
          message: 'Video not found',
        }),
      });
      expect(videoRepository.findOne).not.toHaveBeenCalled();
    });

    it('rejects with 403 FORBIDDEN when the authenticated user does not own the upload', async () => {
      jwtService.verifyAsync.mockResolvedValue({
        sub: 'user-1',
        email: 'u@example.com',
      });
      videoRepository.findOne.mockResolvedValue({
        id: VALID_UUID,
        channel: { user_id: 'someone-else' },
      });

      await expect(
        service.onIncomingRequest(
          fakeRequest(AUTH_HEADER, 'PATCH'),
          res,
          VALID_UUID,
        ),
      ).rejects.toMatchObject({
        status_code: 403,
        body: JSON.stringify({
          statusCode: 403,
          error: 'FORBIDDEN',
          message: 'Not the owner of this upload',
        }),
      });
    });

    it('passes when the authenticated user owns the upload', async () => {
      jwtService.verifyAsync.mockResolvedValue({
        sub: 'user-1',
        email: 'u@example.com',
      });
      videoRepository.findOne.mockResolvedValue({
        id: VALID_UUID,
        channel: { user_id: 'user-1' },
      });

      await expect(
        service.onIncomingRequest(
          fakeRequest(AUTH_HEADER, 'PATCH'),
          res,
          VALID_UUID,
        ),
      ).resolves.toBeUndefined();
    });
  });
});
