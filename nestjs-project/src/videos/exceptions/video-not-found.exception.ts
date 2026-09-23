import { DomainException } from '../../common/exceptions/domain.exception';

export class VideoNotFoundException extends DomainException {
  constructor(public readonly videoId: string) {
    super('VIDEO_NOT_FOUND', 404, 'Video not found');
  }
}
