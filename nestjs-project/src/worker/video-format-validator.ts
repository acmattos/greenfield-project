import type { FfprobeOutput } from './ffprobe-output.types';

const ACCEPTED_VIDEO_CODEC = 'h264';
const ACCEPTED_AUDIO_CODEC = 'aac';
const QUICKTIME_MAJOR_BRAND = 'qt';

// Authoritative container/codec validation (per upload-processing/TD-09).
export function isSupportedVideoFormat(probeOutput: FfprobeOutput): boolean {
  if (!isMp4Container(probeOutput.format.tags)) {
    return false;
  }

  const videoStreams = probeOutput.streams.filter(
    (stream) => stream.codec_type === 'video',
  );
  const audioStreams = probeOutput.streams.filter(
    (stream) => stream.codec_type === 'audio',
  );

  if (videoStreams.length !== 1) {
    return false;
  }
  if (videoStreams[0].codec_name !== ACCEPTED_VIDEO_CODEC) {
    return false;
  }

  if (audioStreams.length > 1) {
    return false;
  }
  if (
    audioStreams.length === 1 &&
    audioStreams[0].codec_name !== ACCEPTED_AUDIO_CODEC
  ) {
    return false;
  }

  return true;
}

// FFmpeg's mov/mp4 demuxer is shared by MP4 and QuickTime MOV alike —
// format_name/format_long_name are byte-identical for both ("mov,mp4,m4a,
// 3gp,3g2,mj2" / "QuickTime / MOV"), confirmed empirically via real ffprobe
// output against both container types, so neither field can discriminate.
// 'qt' is QuickTime's own fixed major_brand (stable since the original
// ISO/Apple spec), unlike MP4 brands (isom, mp41, mp42, M4V , avc1, ...)
// which vary by encoder and would require an ever-growing, staleness-prone
// allowlist (the exact failure mode this predicate must avoid, per
// upload-processing's Events/Messages spec). Excluding the one stable
// non-MP4 brand is far more robust than allowlisting every MP4 brand.
function isMp4Container(tags: Record<string, string> | undefined): boolean {
  const majorBrand = tags?.major_brand?.trim();
  return majorBrand !== QUICKTIME_MAJOR_BRAND;
}
