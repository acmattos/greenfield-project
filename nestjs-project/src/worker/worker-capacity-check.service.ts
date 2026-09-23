import { mkdir, statfs } from 'fs/promises';
import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import uploadConfig from '../config/upload.config';
import workerConfig from '../config/worker.config';
import { WORKER_TEMP_DIR } from './worker.constants';

@Injectable()
export class WorkerCapacityCheckService implements OnApplicationBootstrap {
  private readonly logger = new Logger(WorkerCapacityCheckService.name);

  constructor(
    @Inject(uploadConfig.KEY)
    private readonly upload: ConfigType<typeof uploadConfig>,
    @Inject(workerConfig.KEY)
    private readonly worker: ConfigType<typeof workerConfig>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const requiredFreeBytes =
      this.worker.concurrency * this.upload.maxUploadBytes +
      this.worker.tempMarginBytes;

    await mkdir(WORKER_TEMP_DIR, { recursive: true });
    const stats = await statfs(WORKER_TEMP_DIR);
    const availableBytes = stats.bavail * stats.bsize;

    if (availableBytes < requiredFreeBytes) {
      const message = `Insufficient free disk space at ${WORKER_TEMP_DIR}: required ${requiredFreeBytes} bytes, available ${availableBytes} bytes`;
      this.logger.error(message);
      throw new Error(message);
    }

    this.logger.log(
      `Worker temp volume capacity check passed: ${availableBytes} bytes available (>= ${requiredFreeBytes} required)`,
    );
  }
}
