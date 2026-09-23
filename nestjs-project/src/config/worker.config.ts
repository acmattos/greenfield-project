import { registerAs } from '@nestjs/config';

export default registerAs('worker', () => ({
  concurrency: parseInt(process.env.WORKER_CONCURRENCY || '1', 10),
  tempMarginBytes: parseInt(
    process.env.WORKER_TEMP_MARGIN_BYTES || '536870912',
    10,
  ),
  orphanSweepThresholdMs: parseInt(
    process.env.WORKER_ORPHAN_SWEEP_THRESHOLD_MS || '3600000',
    10,
  ),
  reconciliationIntervalMs: parseInt(
    process.env.WORKER_RECONCILIATION_INTERVAL_MS || '300000',
    10,
  ),
  reconciliationGracePeriodMs: parseInt(
    process.env.WORKER_RECONCILIATION_GRACE_PERIOD_MS || '3600000',
    10,
  ),
}));
