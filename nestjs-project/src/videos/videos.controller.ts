import { Controller, Get, Param, Redirect } from '@nestjs/common';
import type { HttpRedirectResponse } from '@nestjs/common';
import { Public } from '../auth/decorators/public.decorator';
import { VideoProcessingStatus } from './entities/video.entity';
import { VideoDeliveryService } from './video-delivery.service';
import { VideoNotReadyException } from './exceptions/video-not-ready.exception';

@Controller('videos')
export class VideosController {
  constructor(private readonly videoDeliveryService: VideoDeliveryService) {}

  @Public()
  @Get(':id/stream')
  @Redirect()
  async stream(@Param('id') id: string): Promise<HttpRedirectResponse> {
    await this.assertReady(id);
    const url = await this.videoDeliveryService.getStreamUrl(id);
    return { url, statusCode: 302 };
  }

  @Public()
  @Get(':id/download')
  @Redirect()
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
