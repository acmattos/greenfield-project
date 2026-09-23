import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const FFMPEG_PATH = process.env.FFMPEG_PATH || '/usr/local/bin/ffmpeg';
const FFPROBE_PATH = process.env.FFPROBE_PATH || '/usr/local/bin/ffprobe';

// Runs only inside the worker image (per upload-processing/TD-04) — the API
// image deliberately does not vendor these binaries.
describe('FFmpeg/FFprobe binaries — smoke test (integration, worker image)', () => {
  it('ffmpeg -version exits 0 with valid output', async () => {
    const { stdout } = await execFileAsync(FFMPEG_PATH, ['-version']);
    expect(stdout).toContain('ffmpeg version');
  });

  it('ffprobe -version exits 0 with valid output', async () => {
    const { stdout } = await execFileAsync(FFPROBE_PATH, ['-version']);
    expect(stdout).toContain('ffprobe version');
  });
});
