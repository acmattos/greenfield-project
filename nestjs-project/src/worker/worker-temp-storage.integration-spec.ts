import { randomUUID } from 'crypto';
import { existsSync } from 'fs';
import { readFile, statfs } from 'fs/promises';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import storageConfig from '../config/storage.config';
import { WorkerTempStorageService } from './worker-temp-storage.service';

jest.mock('fs/promises', () => ({
  ...jest.requireActual('fs/promises'),
  statfs: jest.fn(jest.requireActual('fs/promises').statfs),
}));

const mockStatfs = statfs as jest.MockedFunction<typeof statfs>;

describe('WorkerTempStorageService (integration)', () => {
  const config = storageConfig();
  let s3Client: S3Client;
  let service: WorkerTempStorageService;

  beforeAll(() => {
    s3Client = new S3Client({
      endpoint: config.endpoint,
      forcePathStyle: true,
      region: config.region,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
    service = new WorkerTempStorageService(s3Client, config);
  });

  afterAll(() => {
    s3Client.destroy();
  });

  afterEach(() => {
    mockStatfs.mockImplementation(
      jest.requireActual('fs/promises').statfs,
    );
  });

  it('downloads a real object to the job temp dir, then removes it on cleanup', async () => {
    const jobId = `test-job-${randomUUID()}`;
    const sourceStorageKey = randomUUID();
    const fileContent = Buffer.from('fake video bytes for temp storage test');

    await s3Client.send(
      new PutObjectCommand({
        Bucket: config.bucket,
        Key: sourceStorageKey,
        Body: fileContent,
      }),
    );

    const destPath = await service.downloadToTempDir(jobId, sourceStorageKey);

    expect(existsSync(destPath)).toBe(true);
    const downloaded = await readFile(destPath);
    expect(downloaded.equals(fileContent)).toBe(true);

    await service.cleanup(jobId);

    expect(existsSync(destPath)).toBe(false);
  });

  it('fails before creating the job dir when the real object exceeds known free space', async () => {
    const jobId = `test-job-${randomUUID()}`;
    const sourceStorageKey = randomUUID();
    const fileContent = Buffer.from('a real object with a real ContentLength');

    await s3Client.send(
      new PutObjectCommand({
        Bucket: config.bucket,
        Key: sourceStorageKey,
        Body: fileContent,
      }),
    );

    // HeadObjectCommand hits real MinIO and returns the real ContentLength;
    // only the free-space side is stubbed to a value smaller than it, since
    // artificially exhausting real disk space in a test run isn't practical.
    mockStatfs.mockResolvedValue({ bavail: 1, bsize: 1 } as never);

    await expect(
      service.downloadToTempDir(jobId, sourceStorageKey),
    ).rejects.toThrow(/Insufficient free disk space/);

    expect(existsSync(service.sourceFilePath(jobId))).toBe(false);
  });
});
