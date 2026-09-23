import { mkdir, statfs } from 'fs/promises';
import type { ConfigType } from '@nestjs/config';
import type uploadConfig from '../config/upload.config';
import type workerConfig from '../config/worker.config';
import { WorkerCapacityCheckService } from './worker-capacity-check.service';

jest.mock('fs/promises');

const mockMkdir = mkdir as jest.MockedFunction<typeof mkdir>;
const mockStatfs = statfs as jest.MockedFunction<typeof statfs>;

function buildService(
  concurrency: number,
  maxUploadBytes: number,
  tempMarginBytes: number,
): WorkerCapacityCheckService {
  return new WorkerCapacityCheckService(
    { maxUploadBytes } as ConfigType<typeof uploadConfig>,
    { concurrency, tempMarginBytes } as ConfigType<typeof workerConfig>,
  );
}

describe('WorkerCapacityCheckService', () => {
  beforeEach(() => {
    mockMkdir.mockResolvedValue(undefined);
  });

  it('proceeds when available space meets the required threshold', async () => {
    mockStatfs.mockResolvedValue({ bavail: 1000, bsize: 1 } as never);
    const service = buildService(1, 500, 100); // required = 600

    await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
  });

  it('fails startup explicitly when available space is below the required threshold', async () => {
    mockStatfs.mockResolvedValue({ bavail: 100, bsize: 1 } as never);
    const service = buildService(1, 500, 100); // required = 600, available = 100

    await expect(service.onApplicationBootstrap()).rejects.toThrow(
      /Insufficient free disk space/,
    );
  });

  it('computes the required threshold as concurrency * maxUploadBytes + tempMarginBytes', async () => {
    mockStatfs.mockResolvedValue({ bavail: 2099, bsize: 1 } as never);
    // required = 2 * 1000 + 100 = 2100 — one byte short of available (2099)
    const service = buildService(2, 1000, 100);

    await expect(service.onApplicationBootstrap()).rejects.toThrow(
      /required 2100 bytes, available 2099 bytes/,
    );
  });
});
