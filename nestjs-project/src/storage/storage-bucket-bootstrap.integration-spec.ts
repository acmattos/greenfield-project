import {
  DeleteBucketCommand,
  HeadBucketCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import storageConfig from '../config/storage.config';
import { StorageBucketBootstrapService } from './storage-bucket-bootstrap.service';

describe('StorageBucketBootstrapService (integration)', () => {
  const bucket = `test-bootstrap-${Date.now()}`;
  const baseConfig = storageConfig();
  let s3Client: S3Client;
  let service: StorageBucketBootstrapService;

  beforeAll(() => {
    s3Client = new S3Client({
      endpoint: baseConfig.endpoint,
      forcePathStyle: true,
      region: baseConfig.region,
      credentials: {
        accessKeyId: baseConfig.accessKeyId,
        secretAccessKey: baseConfig.secretAccessKey,
      },
    });
    service = new StorageBucketBootstrapService(s3Client, {
      ...baseConfig,
      bucket,
    });
  });

  afterAll(async () => {
    await s3Client
      .send(new DeleteBucketCommand({ Bucket: bucket }))
      .catch(() => undefined);
    s3Client.destroy();
  });

  it('creates the bucket when it does not exist yet', async () => {
    await service.ensureBucketExists();

    await expect(
      s3Client.send(new HeadBucketCommand({ Bucket: bucket })),
    ).resolves.toBeDefined();
  });

  it('does not throw when the bucket already exists', async () => {
    await expect(service.ensureBucketExists()).resolves.toBeUndefined();
  });
});
