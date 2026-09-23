import { DomainException } from '../../common/exceptions/domain.exception';

export class VideoNotReadyException extends DomainException {
  constructor(public readonly videoId: string) {
    super('VIDEO_NOT_READY', 409, 'Video is not ready for playback');
  }
}
