import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import type { ConfigType } from '@nestjs/config';
import queueConfig from '../config/queue.config';
import {
  VIDEO_PROCESSING_JOB_OPTIONS,
  VIDEO_PROCESSING_QUEUE,
} from './queue.constants';

@Module({
  imports: [
    // Producer connection (API side): fail-fast — never queue commands while
    // Redis is unreachable. The resilient consumer connection (worker side,
    // maxRetriesPerRequest: null) is instantiated separately in SI-03.11.
    BullModule.forRootAsync({
      inject: [queueConfig.KEY],
      useFactory: (config: ConfigType<typeof queueConfig>) => ({
        connection: {
          host: config.host,
          port: config.port,
          enableOfflineQueue: false,
          maxRetriesPerRequest: 1,
        },
      }),
    }),
    BullModule.registerQueue({
      name: VIDEO_PROCESSING_QUEUE,
      defaultJobOptions: VIDEO_PROCESSING_JOB_OPTIONS,
    }),
  ],
  exports: [BullModule],
})
export class QueueModule {}
