import { mkdir, rm, stat, utimes } from 'fs/promises';
import { join } from 'path';
import { OrphanSweepService } from './orphan-sweep.service';
import { WORKER_TEMP_DIR } from './worker.constants';

function buildService(thresholdMs: number): OrphanSweepService {
  return new OrphanSweepService({
    orphanSweepThresholdMs: thresholdMs,
  } as never);
}

describe('OrphanSweepService', () => {
  const oldDir = join(WORKER_TEMP_DIR, 'old-orphan-job');
  const recentDir = join(WORKER_TEMP_DIR, 'recent-active-job');

  beforeEach(async () => {
    await mkdir(oldDir, { recursive: true });
    await mkdir(recentDir, { recursive: true });

    const now = Date.now();
    const oldTime = (now - 2 * 60 * 60 * 1000) / 1000; // 2h ago
    const recentTime = now / 1000;
    await utimes(oldDir, oldTime, oldTime);
    await utimes(recentDir, recentTime, recentTime);
  });

  afterEach(async () => {
    await rm(oldDir, { recursive: true, force: true });
    await rm(recentDir, { recursive: true, force: true });
  });

  it('removes job directories older than the threshold', async () => {
    const service = buildService(60 * 60 * 1000); // 1h threshold

    await service.sweep();

    await expect(stat(oldDir)).rejects.toThrow();
  });

  it('does not remove an active/recent job directory', async () => {
    const service = buildService(60 * 60 * 1000); // 1h threshold

    await service.sweep();

    await expect(stat(recentDir)).resolves.toBeDefined();
  });

  it('does not throw when the temp dir does not exist yet', async () => {
    await rm(oldDir, { recursive: true, force: true });
    await rm(recentDir, { recursive: true, force: true });
    await rm(WORKER_TEMP_DIR, { recursive: true, force: true });

    const service = buildService(60 * 60 * 1000);

    await expect(service.sweep()).resolves.toBeUndefined();
  });
});
