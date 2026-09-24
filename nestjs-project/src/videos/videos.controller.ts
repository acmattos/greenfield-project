import { Controller, Get, Param, Redirect } from '@nestjs/common';
import type { HttpRedirectResponse } from '@nestjs/common';
import {
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { Public } from '../auth/decorators/public.decorator';
import { VideoProcessingStatus } from './entities/video.entity';
import { VideoDeliveryService } from './video-delivery.service';
import { VideoNotReadyException } from './exceptions/video-not-ready.exception';

@ApiTags('videos')
@Controller('videos')
export class VideosController {
  constructor(private readonly videoDeliveryService: VideoDeliveryService) {}

  @Public()
  @Get(':id/stream')
  @Redirect()
  @ApiOperation({
    summary: 'Stream a video',
    description:
      'Redirects (302) to a short-lived presigned GET URL against the object storage, letting the client issue real HTTP range requests (206 Partial Content) directly against it. Anonymous access allowed.',
  })
  @ApiResponse({
    status: 302,
    description: 'Redirect to a presigned streaming URL',
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not ready for playback yet',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async stream(@Param('id') id: string): Promise<HttpRedirectResponse> {
    await this.assertReady(id);
    const url = await this.videoDeliveryService.getStreamUrl(id);
    return { url, statusCode: 302 };
  }

  @Public()
  @Get(':id/download')
  @Redirect()
  @ApiOperation({
    summary: 'Download a video',
    description:
      'Redirects (302) to a short-lived presigned GET URL against the object storage, for a full-file download. Anonymous access allowed.',
  })
  @ApiResponse({
    status: 302,
    description: 'Redirect to a presigned download URL',
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not ready for download yet',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async download(@Param('id') id: string): Promise<HttpRedirectResponse> {
    await this.assertReady(id);
    const url = await this.videoDeliveryService.getDownloadUrl(id);
    return { url, statusCode: 302 };
  }

  private async assertReady(id: string): Promise<void> {
    const video = await this.videoDeliveryService.getVideoOrThrow(id);
    if (video.processingStatus !== VideoProcessingStatus.READY) {
      throw new VideoNotReadyException(id);
    }
  }
}
