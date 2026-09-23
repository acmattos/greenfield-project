import type { FfprobeOutput } from './ffprobe-output.types';

export interface ExtractedVideoMetadata {
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  bitRate: number | null;
}

// Reuses the same ffprobe output already parsed for format validation
// (SI-03.13) — no second probe call (per upload-processing/TD-04, TD-12).
export function extractVideoMetadata(
  probeOutput: FfprobeOutput,
): ExtractedVideoMetadata {
  const videoStream = probeOutput.streams.find(
    (stream) => stream.codec_type === 'video',
  );
  const audioStream = probeOutput.streams.find(
    (stream) => stream.codec_type === 'audio',
  );

  const rawDuration = parseRawDurationSeconds(probeOutput);

  return {
    durationSeconds: rawDuration === null ? null : Math.round(rawDuration),
    width: videoStream?.width ?? null,
    height: videoStream?.height ?? null,
    videoCodec: videoStream?.codec_name ?? null,
    audioCodec: audioStream?.codec_name ?? null,
    bitRate: parseIntegerOrNull(probeOutput.format.bit_rate),
  };
}

function parseRawDurationSeconds(probeOutput: FfprobeOutput): number | null {
  const value = probeOutput.format.duration;
  if (value === undefined) {
    return null;
  }
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseIntegerOrNull(value: string | undefined): number | null {
  if (value === undefined) {
    return null;
  }
  const parsed = Math.round(parseFloat(value));
  return Number.isFinite(parsed) ? parsed : null;
}

// Capture timestamp for the thumbnail frame — derived from the *raw*
// (unrounded) probed duration, never a fixed offset, so it can never exceed
// a very short clip's actual length even when the rounded durationSeconds
// persisted to the DB would put it right at the boundary (per
// upload-processing's Events/Messages spec, step 4).
export function resolveThumbnailTimestampSeconds(
  probeOutput: FfprobeOutput,
): number {
  const rawDuration = parseRawDurationSeconds(probeOutput);
  if (!rawDuration || rawDuration <= 0) {
    return 0;
  }
  return Math.min(2, rawDuration / 2);
}
