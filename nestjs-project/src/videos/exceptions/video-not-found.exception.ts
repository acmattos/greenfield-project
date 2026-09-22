export class VideoNotFoundException extends Error {
  constructor(public readonly videoId: string) {
    super(`Video not found: ${videoId}`);
    this.name = 'VideoNotFoundException';
  }
}
