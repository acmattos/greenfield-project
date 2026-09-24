import { isSupportedVideoFormat } from './video-format-validator';
import type { FfprobeOutput } from './ffprobe-output.types';

const MOV_MP4_DEMUXER = 'mov,mp4,m4a,3gp,3g2,mj2';

function probe(overrides: Partial<FfprobeOutput> = {}): FfprobeOutput {
  return {
    streams: [{ codec_type: 'video', codec_name: 'h264' }],
    format: { format_name: MOV_MP4_DEMUXER, tags: { major_brand: 'isom' } },
    ...overrides,
  };
}

describe('isSupportedVideoFormat', () => {
  it('accepts a valid MP4/H.264/AAC video', () => {
    expect(
      isSupportedVideoFormat(
        probe({
          streams: [
            { codec_type: 'video', codec_name: 'h264' },
            { codec_type: 'audio', codec_name: 'aac' },
          ],
        }),
      ),
    ).toBe(true);
  });

  it('accepts a valid MP4/H.264 video with no audio stream (silent)', () => {
    expect(isSupportedVideoFormat(probe())).toBe(true);
  });

  it('rejects a QuickTime MOV container (major_brand "qt"), even though format_name is byte-identical to MP4', () => {
    expect(
      isSupportedVideoFormat(
        probe({
          format: { format_name: MOV_MP4_DEMUXER, tags: { major_brand: 'qt' } },
        }),
      ),
    ).toBe(false);
  });

  it('rejects a real 3GP container (major_brand "3gp6") with H.264/AAC, even though format_name is byte-identical to MP4', () => {
    // Empirically confirmed: a genuine 3GP file muxed with H.264 video and
    // AAC audio reports format_name identical to MP4 ("mov,mp4,m4a,3gp,3g2,
    // mj2") and major_brand "3gp6" — a validator that only excludes
    // major_brand === 'qt' would wrongly ACCEPT this as MP4.
    expect(
      isSupportedVideoFormat(
        probe({
          streams: [
            { codec_type: 'video', codec_name: 'h264' },
            { codec_type: 'audio', codec_name: 'aac' },
          ],
          format: {
            format_name: MOV_MP4_DEMUXER,
            tags: { major_brand: '3gp6' },
          },
        }),
      ),
    ).toBe(false);
  });

  it('rejects a real 3G2 container (major_brand "3g2a") with H.264/AAC', () => {
    expect(
      isSupportedVideoFormat(
        probe({
          streams: [
            { codec_type: 'video', codec_name: 'h264' },
            { codec_type: 'audio', codec_name: 'aac' },
          ],
          format: {
            format_name: MOV_MP4_DEMUXER,
            tags: { major_brand: '3g2a' },
          },
        }),
      ),
    ).toBe(false);
  });

  it('rejects a Motion JPEG 2000 container (major_brand "mjp2")', () => {
    expect(
      isSupportedVideoFormat(
        probe({
          format: {
            format_name: MOV_MP4_DEMUXER,
            tags: { major_brand: 'mjp2' },
          },
        }),
      ),
    ).toBe(false);
  });

  it('rejects a non-MP4-family container reported by ffprobe under a different format_name, even with accepted codecs and no major_brand tag', () => {
    // The bug this test guards against: a validator that only excludes
    // major_brand === 'qt' (never checking format_name at all) would wrongly
    // ACCEPT this — major_brand is an ISO-BMFF-only concept and is simply
    // absent (undefined) on a container ffprobe reports under a completely
    // different demuxer name, e.g. a Matroska (MKV) file carrying H.264
    // video and AAC audio.
    expect(
      isSupportedVideoFormat(
        probe({
          streams: [
            { codec_type: 'video', codec_name: 'h264' },
            { codec_type: 'audio', codec_name: 'aac' },
          ],
          format: { format_name: 'matroska,webm' },
        }),
      ),
    ).toBe(false);
  });

  it('rejects a non-MP4-family container even if it happens to carry a major_brand tag that is not "qt"', () => {
    expect(
      isSupportedVideoFormat(
        probe({
          format: {
            format_name: 'avi',
            tags: { major_brand: 'not-a-real-brand' },
          },
        }),
      ),
    ).toBe(false);
  });

  it('rejects when the video codec is not h264', () => {
    expect(
      isSupportedVideoFormat(
        probe({ streams: [{ codec_type: 'video', codec_name: 'mpeg2video' }] }),
      ),
    ).toBe(false);
  });

  it('rejects when there is more than one video stream', () => {
    expect(
      isSupportedVideoFormat(
        probe({
          streams: [
            { codec_type: 'video', codec_name: 'h264' },
            { codec_type: 'video', codec_name: 'h264' },
          ],
        }),
      ),
    ).toBe(false);
  });

  it('rejects when there is more than one audio stream', () => {
    expect(
      isSupportedVideoFormat(
        probe({
          streams: [
            { codec_type: 'video', codec_name: 'h264' },
            { codec_type: 'audio', codec_name: 'aac' },
            { codec_type: 'audio', codec_name: 'aac' },
          ],
        }),
      ),
    ).toBe(false);
  });

  it('rejects when the single audio stream is not aac', () => {
    expect(
      isSupportedVideoFormat(
        probe({
          streams: [
            { codec_type: 'video', codec_name: 'h264' },
            { codec_type: 'audio', codec_name: 'mp3' },
          ],
        }),
      ),
    ).toBe(false);
  });
});
