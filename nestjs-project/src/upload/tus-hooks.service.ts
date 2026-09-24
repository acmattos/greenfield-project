import { IncomingMessage, ServerResponse } from 'http';
import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import type { Queue } from 'bullmq';
import { Repository } from 'typeorm';
import type { Upload } from '@tus/server';
import { Channel } from '../channels/entities/channel.entity';
import { isValidUuid } from '../common/utils/uuid.util';
import { VIDEO_PROCESSING_QUEUE } from '../queue/queue.constants';
import { Video } from '../videos/entities/video.entity';
import { extractAuthenticatedUserId } from './jwt-from-request.util';
import { resolveTitle } from './resolve-title.util';
import { TusProtocolError } from './tus-protocol.error';

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
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly videoProcessingQueue: Queue,
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

  async onUploadFinish(
    _req: IncomingMessage,
    res: ServerResponse,
    upload: Upload,
  ): Promise<{ res: ServerResponse }> {
    // uploadCompletedAt is written first — a plain, durable Postgres write,
    // independent of Redis/BullMQ availability (per upload-processing/TD-11).
    await this.videoRepository.update(
      { id: upload.id },
      { uploadCompletedAt: new Date() },
    );

    await this.videoProcessingQueue.add(
      'video.processing',
      { videoId: upload.id },
      { jobId: `process-video-${upload.id}` },
    );

    return { res };
  }

  // Registered on EVENTS.POST_TERMINATE (upload-processing/TD-13) — the
  // library only fires this after a successful DELETE, already scoped to
  // in-progress uploads via disableTerminationForFinishedUploads. Hard
  // deletes the draft row; no new processingStatus/publicationStatus value
  // for "cancelled" (per TD-06/TD-13 — a cancelled draft has no processing
  // history worth retaining).
  async onUploadTerminate(videoId: string): Promise<void> {
    await this.videoRepository.delete({ id: videoId });
  }

  async onIncomingRequest(
    req: IncomingMessage,
    _res: ServerResponse,
    uploadId: string,
  ): Promise<void> {
    if (req.method === 'OPTIONS') {
      return;
    }

    const userId = await this.authenticateOrThrow(req);

    if (req.method === 'POST') {
      // Creation request — PostHandler passes the namingFunction's
      // freshly-generated id here, not an id of an existing upload, so
      // there is no Video row to check ownership of yet (onUploadCreate
      // handles the rest of the creation flow).
      return;
    }

    await this.assertOwnership(uploadId, userId);
  }

  private async authenticateOrThrow(req: IncomingMessage): Promise<string> {
    try {
      return await extractAuthenticatedUserId(req, this.jwtService);
    } catch {
      throw new TusProtocolError(
        401,
        JSON.stringify({
          statusCode: 401,
          error: 'UNAUTHENTICATED',
          message: 'Authentication required',
        }),
      );
    }
  }

  private async assertOwnership(
    uploadId: string,
    userId: string,
  ): Promise<void> {
    if (!isValidUuid(uploadId)) {
      throw this.videoNotFoundError();
    }

    const video = await this.videoRepository.findOne({
      where: { id: uploadId },
      relations: ['channel'],
    });
    if (!video) {
      throw this.videoNotFoundError();
    }

    if (video.channel.user_id !== userId) {
      throw new TusProtocolError(
        403,
        JSON.stringify({
          statusCode: 403,
          error: 'FORBIDDEN',
          message: 'Not the owner of this upload',
        }),
      );
    }
  }

  private videoNotFoundError(): TusProtocolError {
    return new TusProtocolError(
      404,
      JSON.stringify({
        statusCode: 404,
        error: 'VIDEO_NOT_FOUND',
        message: 'Video not found',
      }),
    );
  }

  private assertSupportedFormat(
    metadata: Record<string, string | null> | undefined,
  ): void {
    const filetype = metadata?.filetype;
    if (filetype && filetype !== SUPPORTED_VIDEO_FORMAT) {
      throw new TusProtocolError(
        415,
        JSON.stringify({
          statusCode: 415,
          error: 'UNSUPPORTED_VIDEO_FORMAT',
          message: 'Unsupported video format',
        }),
      );
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
      throw new TusProtocolError(
        500,
        JSON.stringify({
          statusCode: 500,
          error: 'ACCOUNT_INCOMPLETE',
          message: 'Something went wrong',
        }),
      );
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
