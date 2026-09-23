import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Channel } from '../channels/entities/channel.entity';
import databaseConfig from '../config/database.config';
import { envValidationSchema } from '../config/env.validation';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import uploadConfig from '../config/upload.config';
import workerConfig from '../config/worker.config';
import { VIDEO_PROCESSING_QUEUE } from '../queue/queue.constants';
import { StorageModule } from '../storage/storage.module';
import { User } from '../users/entities/user.entity';
import { Video } from '../videos/entities/video.entity';
import { FfmpegVideoProcessorAdapter } from './ffmpeg-video-processor.adapter';
import { OrphanSweepService } from './orphan-sweep.service';
import { ReconciliationSweepService } from './reconciliation-sweep.service';
import { VideoProcessingProcessor } from './video-processing.processor';
import { WorkerCapacityCheckService } from './worker-capacity-check.service';
import { WorkerTempStorageService } from './worker-temp-storage.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [
        databaseConfig,
        queueConfig,
        storageConfig,
        uploadConfig,
        workerConfig,
      ],
      validationSchema: envValidationSchema,
      validationOptions: { allowUnknown: true, abortEarly: false },
    }),
    TypeOrmModule.forRootAsync({
      inject: [databaseConfig.KEY],
      useFactory: (dbConfig: ConfigType<typeof databaseConfig>) => ({
        type: 'postgres',
        host: dbConfig.host,
        port: dbConfig.port,
        username: dbConfig.username,
        password: dbConfig.password,
        database: dbConfig.name,
        autoLoadEntities: true,
        synchronize: false,
      }),
    }),
    // Consumer connection: maxRetriesPerRequest: null — BullMQ's own hard
    // requirement for blocking consumer commands. Never the producer's
    // fail-fast connection used by the API side (SI-03.4/SI-03.9).
    BullModule.forRootAsync({
      inject: [queueConfig.KEY],
      useFactory: (config: ConfigType<typeof queueConfig>) => ({
        connection: {
          host: config.host,
          port: config.port,
          maxRetriesPerRequest: null,
        },
      }),
    }),
    BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
    TypeOrmModule.forFeature([Video, Channel, User]),
    StorageModule,
  ],
  providers: [
    VideoProcessingProcessor,
    WorkerCapacityCheckService,
    WorkerTempStorageService,
    OrphanSweepService,
    ReconciliationSweepService,
    FfmpegVideoProcessorAdapter,
  ],
})
export class WorkerModule {}
