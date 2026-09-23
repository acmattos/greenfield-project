export interface FfprobeStream {
  codec_name?: string;
  codec_type: 'video' | 'audio' | string;
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
