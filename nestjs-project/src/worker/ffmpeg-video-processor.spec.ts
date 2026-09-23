import type { FfprobeOutput } from './ffprobe-output.types';
import { isSupportedVideoFormat } from './video-format-validator';

// Base fixtures mirror real `ffprobe -show_format -show_streams -of json`
// output captured against real MP4/H.264/AAC and MOV/H.264 files generated
// via ffmpeg inside the worker image — format_name/format_long_name are
// byte-identical between MP4 and MOV (shared demuxer), confirming why the
// discriminator lives in format.tags.major_brand, not format_name.
function mp4Video(codecName = 'h264'): FfprobeOutput['streams'][number] {
  return { index: 0, codec_type: 'video', codec_name: codecName } as never;
}

function mp4Audio(codecName = 'aac'): FfprobeOutput['streams'][number] {
  return { index: 1, codec_type: 'audio', codec_name: codecName } as never;
}

function probeWith(
  streams: FfprobeOutput['streams'],
  majorBrand: string,
): FfprobeOutput {
  return {
    streams,
    format: {
      format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
      format_long_name: 'QuickTime / MOV',
      tags: { major_brand: majorBrand },
    } as never,
  };
}

describe('isSupportedVideoFormat', () => {
  it('accepts a valid MP4/H.264/AAC video', () => {
    const probe = probeWith([mp4Video(), mp4Audio()], 'isom');
    expect(isSupportedVideoFormat(probe)).toBe(true);
  });

  it('accepts a valid MP4/H.264 silent video (no audio stream)', () => {
    const probe = probeWith([mp4Video()], 'isom');
    expect(isSupportedVideoFormat(probe)).toBe(true);
  });

  it('rejects a MOV container (major_brand = qt)', () => {
    const probe = probeWith([mp4Video()], 'qt');
    expect(isSupportedVideoFormat(probe)).toBe(false);
  });

  it('rejects a video codec other than H.264', () => {
    const probe = probeWith([mp4Video('mpeg2video')], 'isom');
    expect(isSupportedVideoFormat(probe)).toBe(false);
  });

  it('rejects an audio codec other than AAC', () => {
    const probe = probeWith([mp4Video(), mp4Audio('mp3')], 'isom');
    expect(isSupportedVideoFormat(probe)).toBe(false);
  });

  it('rejects multiple video streams', () => {
    const probe = probeWith([mp4Video(), mp4Video()], 'isom');
    expect(isSupportedVideoFormat(probe)).toBe(false);
  });

  it('rejects multiple audio streams', () => {
    const probe = probeWith([mp4Video(), mp4Audio(), mp4Audio()], 'isom');
    expect(isSupportedVideoFormat(probe)).toBe(false);
  });

  it('rejects a video with zero video streams', () => {
    const probe = probeWith([mp4Audio()], 'isom');
    expect(isSupportedVideoFormat(probe)).toBe(false);
  });
});
