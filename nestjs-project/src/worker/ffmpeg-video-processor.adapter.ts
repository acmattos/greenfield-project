import { spawn } from 'child_process';
import { Injectable } from '@nestjs/common';
import type { FfprobeOutput } from './ffprobe-output.types';
import type { VideoProcessorPort } from './video-processor.port';

const FFPROBE_PATH = process.env.FFPROBE_PATH || '/usr/local/bin/ffprobe';

@Injectable()
export class FfmpegVideoProcessorAdapter implements VideoProcessorPort {
  probe(path: string): Promise<FfprobeOutput> {
    return new Promise((resolve, reject) => {
      // Array-form arguments only, shell: false — avoids shell-injection
      // risk from any path/argument built from user-controlled data (per
      // upload-processing/TD-04). No client-controlled argument reaches
      // spawn: only the local temp file path (server-generated, SI-03.12)
      // is passed here.
      const child = spawn(
        FFPROBE_PATH,
        ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', path],
        { shell: false },
      );

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      child.on('error', reject);
      child.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`ffprobe exited with code ${code}: ${stderr}`));
          return;
        }
        try {
          resolve(JSON.parse(stdout) as FfprobeOutput);
        } catch (err) {
          reject(err);
        }
      });
    });
  }
}
