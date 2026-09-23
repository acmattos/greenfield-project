import type { FfprobeOutput } from './ffprobe-output.types';

export interface VideoProcessorPort {
  probe(path: string): Promise<FfprobeOutput>;
  extractThumbnail(path: string, timestampSeconds: number): Promise<Buffer>;
}
