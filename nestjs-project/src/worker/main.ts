import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  // On SIGTERM/SIGINT: runs onModuleDestroy → beforeApplicationShutdown →
  // onApplicationShutdown across every provider — @nestjs/bullmq's own
  // BullExplorer.onApplicationShutdown closes every registered Worker and
  // its Redis connection (per upload-processing/TD-03); the reconciliation
  // sweep's own setInterval (SI-03.16) is cleared explicitly in its
  // onModuleDestroy, since app.close() alone never clears timers.
  app.enableShutdownHooks();
}
void bootstrap();
