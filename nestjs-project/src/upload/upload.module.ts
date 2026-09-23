import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { Channel } from '../channels/entities/channel.entity';
import { Video } from '../videos/entities/video.entity';
import { TusHooksService } from './tus-hooks.service';
import { TusMiddleware } from './tus.middleware';
import { TUS_UPLOAD_PATH } from './upload.constants';

@Module({
  imports: [AuthModule, TypeOrmModule.forFeature([Video, Channel])],
  providers: [TusHooksService],
})
export class UploadModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Two entries: the bare path covers POST (creation); the wildcard covers
    // subsequent PATCH/HEAD/DELETE against /videos/upload/{id}.
    const basePath = TUS_UPLOAD_PATH.slice(1);
    consumer
      .apply(TusMiddleware)
      .forRoutes(basePath, `${basePath}/{*splat}`);
  }
}
