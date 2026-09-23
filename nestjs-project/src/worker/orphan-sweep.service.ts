import { readdir, rm, stat } from 'fs/promises';
import { join } from 'path';
import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import workerConfig from '../config/worker.config';
import { WORKER_TEMP_DIR } from './worker.constants';

@Injectable()
export class OrphanSweepService implements OnApplicationBootstrap {
  private readonly logger = new Logger(OrphanSweepService.name);

  constructor(
    @Inject(workerConfig.KEY)
    private readonly worker: ConfigType<typeof workerConfig>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.sweep();
  }

  async sweep(): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(WORKER_TEMP_DIR);
    } catch {
      // Temp dir doesn't exist yet — nothing to sweep.
      return;
    }

    const now = Date.now();
    for (const entry of entries) {
      const entryPath = join(WORKER_TEMP_DIR, entry);
      const stats = await stat(entryPath);
      const ageMs = now - stats.mtimeMs;

      if (ageMs > this.worker.orphanSweepThresholdMs) {
        await rm(entryPath, { recursive: true, force: true });
        this.logger.warn(
          `Removed orphaned job temp directory: ${entryPath} (age: ${ageMs}ms, threshold: ${this.worker.orphanSweepThresholdMs}ms)`,
        );
      }
    }
  }
}
