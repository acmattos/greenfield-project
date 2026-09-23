import { IncomingMessage, ServerResponse } from 'http';
import { JwtService } from '@nestjs/jwt';
import { Repository } from 'typeorm';
import type { Upload } from '@tus/server';
import { Channel } from '../channels/entities/channel.entity';
import { Video } from '../videos/entities/video.entity';
import { TusHooksService } from './tus-hooks.service';

function fakeRequest(authHeader?: string): IncomingMessage {
  return {
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
  let videoRepository: { create: jest.Mock; save: jest.Mock };
  let channelRepository: { findOneBy: jest.Mock };
  let service: TusHooksService;
  const res = {} as ServerResponse;
  const AUTH_HEADER = 'Bearer valid-token';

  beforeEach(() => {
    jwtService = { verifyAsync: jest.fn() };
    videoRepository = {
      create: jest.fn((x) => x),
      save: jest.fn((x) => Promise.resolve(x)),
    };
    channelRepository = { findOneBy: jest.fn() };

    service = new TusHooksService(
      jwtService as unknown as JwtService,
      videoRepository as unknown as Repository<Video>,
      channelRepository as unknown as Repository<Channel>,
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
});
