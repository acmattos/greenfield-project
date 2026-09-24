import type { FfprobeFormat, FfprobeOutput } from './ffprobe-output.types';

const ACCEPTED_VIDEO_CODEC = 'h264';
const ACCEPTED_AUDIO_CODEC = 'aac';
const QUICKTIME_MAJOR_BRAND = 'qt';
// The shared "mov,mp4,m4a,3gp,3g2,mj2" demuxer family has exactly these
// non-MP4 siblings (per ffmpeg's own family name): 3GP/3G2 (3GPP/3GPP2,
// confirmed empirically — a real 3GP H.264/AAC file reports major_brand
// e.g. "3gp6", which format_name alone cannot distinguish from MP4) and
// Motion JPEG 2000 ("mjp2"/"mj2s"). QuickTime MOV ("qt") is excluded above.
// Prefix match, not equality — 3GP/3G2/MJ2000 major_brand values are
// versioned (3gp4, 3gp5, 3gp6, 3g2a, 3g2b, mjp2, mj2s, ...); "mj" (not
// "mj2") is the safe prefix since "mjp2" itself doesn't start with "mj2".
const NON_MP4_MAJOR_BRAND_PREFIXES = ['3gp', '3g2', 'mj'];
// FFmpeg's shared demuxer name for the whole ISO-BMFF mov/mp4 family
// (confirmed empirically — see isMp4Container's own comment below). Any
// container ffprobe recognizes as something else entirely (Matroska, AVI,
// WebM, ...) reports a different format_name here and must be rejected
// before major_brand is even consulted — major_brand is an ISO-BMFF-only
// concept and is simply absent (undefined) on those containers, which
// would otherwise slip past a major_brand-only check.
const MOV_MP4_DEMUXER_FORMAT_NAME = 'mov,mp4,m4a,3gp,3g2,mj2';

// Authoritative container/codec validation (per upload-processing/TD-09).
export function isSupportedVideoFormat(probeOutput: FfprobeOutput): boolean {
  if (!isMp4Container(probeOutput.format)) {
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

// FFmpeg's mov/mp4 demuxer is shared by several ISO-BMFF container variants
// alike — format_name/format_long_name are byte-identical across all of
// them ("mov,mp4,m4a,3gp,3g2,mj2" / "QuickTime / MOV"), confirmed
// empirically via real ffprobe output, so neither field can discriminate
// MP4 from its siblings on its own. MP4 brands (isom, mp41, mp42, M4V ,
// avc1, ...) vary by encoder and would require an ever-growing,
// staleness-prone allowlist (the exact failure mode this predicate must
// avoid, per upload-processing's Events/Messages spec) — but the family's
// non-MP4 siblings are a small, fixed set (QuickTime MOV, 3GP/3G2, Motion
// JPEG 2000), so denylisting those is robust without staleness risk.
function isMp4Container(format: FfprobeFormat): boolean {
  if (format.format_name !== MOV_MP4_DEMUXER_FORMAT_NAME) {
    return false;
  }
  const majorBrand = format.tags?.major_brand?.trim().toLowerCase();
  if (!majorBrand) {
    return true;
  }
  if (majorBrand === QUICKTIME_MAJOR_BRAND) {
    return false;
  }
  return !NON_MP4_MAJOR_BRAND_PREFIXES.some((prefix) =>
    majorBrand.startsWith(prefix),
  );
}
