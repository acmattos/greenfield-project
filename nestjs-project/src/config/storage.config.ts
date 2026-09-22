import { registerAs } from '@nestjs/config';

export default registerAs('storage', () => ({
  endpoint: process.env.STORAGE_ENDPOINT || 'http://minio:9000',
  publicEndpoint: process.env.STORAGE_PUBLIC_ENDPOINT,
  region: process.env.STORAGE_REGION,
  bucket: process.env.STORAGE_BUCKET || 'videos',
  accessKeyId: process.env.STORAGE_ACCESS_KEY_ID,
  secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY,
  presignedUrlTtlSeconds: parseInt(
    process.env.STORAGE_PRESIGNED_URL_TTL_SECONDS || '3600',
    10,
  ),
}));
