export const VIDEO_PROCESSING_QUEUE = 'video-processing';

// Shared by every producer of this job type (onUploadFinish's normal path
// AND the reconciliation sweep's recovery paths, per upload-processing/
// TD-11) — a job re-enqueued by the sweep must carry the same resilience
// contract as one enqueued on the normal path, never a silently weaker one.
export const VIDEO_PROCESSING_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 1000 },
  removeOnComplete: { age: 3600, count: 1000 },
  removeOnFail: { age: 604800, count: 5000 },
} as const;
