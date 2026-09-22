import {
  DeleteBucketCommand,
  HeadBucketCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import storageConfig from '../config/storage.config';
import { StorageBucketBootstrapService } from './storage-bucket-bootstrap.service';

describe('StorageBucketBootstrapService — concurrent bootstrap (integration)', () => {
  const bucket = `test-bootstrap-concurrent-${Date.now()}`;
  const baseConfig = storageConfig();
  let s3Client: S3Client;

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
  });

  afterAll(async () => {
    await s3Client
      .send(new DeleteBucketCommand({ Bucket: bucket }))
      .catch(() => undefined);
    s3Client.destroy();
  });

  it('does not throw on either side when two bootstraps race against an empty bucket', async () => {
    const config = { ...baseConfig, bucket };
    const apiSideBootstrap = new StorageBucketBootstrapService(s3Client, config);
    const workerSideBootstrap = new StorageBucketBootstrapService(
      s3Client,
      config,
    );

    await expect(
      Promise.all([
        apiSideBootstrap.ensureBucketExists(),
        workerSideBootstrap.ensureBucketExists(),
      ]),
    ).resolves.toBeDefined();

    await expect(
      s3Client.send(new HeadBucketCommand({ Bucket: bucket })),
    ).resolves.toBeDefined();
  });
});
