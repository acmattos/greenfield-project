import { registerAs } from '@nestjs/config';

export default registerAs('storage', () => ({
  endpoint: process.env.STORAGE_ENDPOINT || 'http://minio:9000',
  // Required, no fallback — env.validation.ts's Joi schema guarantees these
  // are present at boot (never silently falls back to localhost).
  publicEndpoint: process.env.STORAGE_PUBLIC_ENDPOINT as string,
  region: process.env.STORAGE_REGION as string,
  bucket: process.env.STORAGE_BUCKET || 'videos',
  accessKeyId: process.env.STORAGE_ACCESS_KEY_ID as string,
  secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY as string,
  presignedUrlTtlSeconds: parseInt(
    process.env.STORAGE_PRESIGNED_URL_TTL_SECONDS || '3600',
    10,
  ),
}));
