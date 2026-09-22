import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import type { ConfigType } from '@nestjs/config';
import queueConfig from '../config/queue.config';
import { VIDEO_PROCESSING_QUEUE } from './queue.constants';

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
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: { age: 3600, count: 1000 },
        removeOnFail: { age: 604800, count: 5000 },
      },
    }),
  ],
  exports: [BullModule],
})
export class QueueModule {}
