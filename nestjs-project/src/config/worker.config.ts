import { registerAs } from '@nestjs/config';

export default registerAs('worker', () => ({
  concurrency: parseInt(process.env.WORKER_CONCURRENCY || '1', 10),
  tempMarginBytes: parseInt(
    process.env.WORKER_TEMP_MARGIN_BYTES || '536870912',
    10,
  ),
}));
