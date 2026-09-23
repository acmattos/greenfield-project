export interface FfprobeStream {
  codec_name?: string;
  // ffprobe emits other values too (e.g. 'subtitle', 'data') — only
  // 'video'/'audio' are meaningful to this worker's own logic.
  codec_type: string;
  width?: number;
  height?: number;
}

export interface FfprobeFormat {
  format_name: string;
  duration?: string;
  bit_rate?: string;
  tags?: Record<string, string>;
}

export interface FfprobeOutput {
  streams: FfprobeStream[];
  format: FfprobeFormat;
}
