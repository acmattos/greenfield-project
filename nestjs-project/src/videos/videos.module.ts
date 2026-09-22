import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StorageModule } from '../storage/storage.module';
import { Video } from './entities/video.entity';
import { VideoDeliveryService } from './video-delivery.service';

@Module({
  imports: [TypeOrmModule.forFeature([Video]), StorageModule],
  providers: [VideoDeliveryService],
  exports: [TypeOrmModule, VideoDeliveryService],
})
export class VideosModule {}
