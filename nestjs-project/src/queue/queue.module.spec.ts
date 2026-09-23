import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import queueConfig from '../config/queue.config';
import { QueueModule } from './queue.module';
import { VIDEO_PROCESSING_QUEUE } from './queue.constants';

describe('QueueModule', () => {
  it('should compile and resolve the video-processing queue via DI', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        QueueModule,
      ],
    }).compile();

    expect(module).toBeDefined();

    const queue = module.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
    expect(queue).toBeDefined();
    expect(queue.opts.defaultJobOptions).toMatchObject({
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: { age: 3600, count: 1000 },
      removeOnFail: { age: 604800, count: 5000 },
    });

    await module.close();
  }, 15000);
});
