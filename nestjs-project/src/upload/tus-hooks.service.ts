import { IncomingMessage, ServerResponse } from 'http';
import { Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { Upload } from '@tus/server';
import { Channel } from '../channels/entities/channel.entity';
import { Video } from '../videos/entities/video.entity';
import { extractAuthenticatedUserId } from './jwt-from-request.util';
import { resolveTitle } from './resolve-title.util';

const SUPPORTED_VIDEO_FORMAT = 'video/mp4';

@Injectable()
export class TusHooksService {
  private readonly logger = new Logger(TusHooksService.name);

  constructor(
    private readonly jwtService: JwtService,
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    @InjectRepository(Channel)
    private readonly channelRepository: Repository<Channel>,
  ) {}

  async onUploadCreate(
    req: IncomingMessage,
    res: ServerResponse,
    upload: Upload,
  ): Promise<{ res: ServerResponse; metadata?: Upload['metadata'] }> {
    this.assertSupportedFormat(upload.metadata);
    const channel = await this.resolveAuthenticatedChannel(req);
    await this.createDraftVideo(upload, channel);
    return { res };
  }

  private assertSupportedFormat(
    metadata: Record<string, string | null> | undefined,
  ): void {
    const filetype = metadata?.filetype;
    if (filetype && filetype !== SUPPORTED_VIDEO_FORMAT) {
      throw {
        status_code: 415,
        body: JSON.stringify({
          statusCode: 415,
          error: 'UNSUPPORTED_VIDEO_FORMAT',
          message: 'Unsupported video format',
        }),
      };
    }
  }

  private async resolveAuthenticatedChannel(
    req: IncomingMessage,
  ): Promise<Channel> {
    const userId = await extractAuthenticatedUserId(req, this.jwtService);
    const channel = await this.channelRepository.findOneBy({
      user_id: userId,
    });
    if (!channel) {
      this.logger.error(
        `Authenticated user ${userId} has no associated Channel — account-integrity invariant violated`,
      );
      throw {
        status_code: 500,
        body: JSON.stringify({
          statusCode: 500,
          error: 'ACCOUNT_INCOMPLETE',
          message: 'Something went wrong',
        }),
      };
    }
    return channel;
  }

  private async createDraftVideo(
    upload: Upload,
    channel: Channel,
  ): Promise<void> {
    await this.videoRepository.save(
      this.videoRepository.create({
        id: upload.id,
        channelId: channel.id,
        title: resolveTitle(upload.metadata),
        sourceStorageKey: upload.id,
      }),
    );
  }
}
