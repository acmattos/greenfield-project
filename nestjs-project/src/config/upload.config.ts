import { registerAs } from '@nestjs/config';

export default registerAs('upload', () => ({
  maxUploadBytes: parseInt(
    process.env.MAX_UPLOAD_BYTES || '10737418240',
    10,
  ),
}));
