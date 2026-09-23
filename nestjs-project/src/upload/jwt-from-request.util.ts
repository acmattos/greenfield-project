import { IncomingMessage } from 'http';
import { JwtService } from '@nestjs/jwt';
import { BEARER_PREFIX } from '../auth/auth.constants';
import { JwtPayload } from '../auth/auth.types';

// Reused by both the SI-03.7 onUploadCreate hook and the SI-03.8
// onIncomingRequest hook — a single source of truth for verifying the same
// access token the rest of the API accepts, adapted to run outside the
// Nest guard pipeline (tus hooks receive a raw IncomingMessage).
export async function extractAuthenticatedUserId(
  req: IncomingMessage,
  jwtService: JwtService,
): Promise<string> {
  const authHeader = req.headers['authorization'];
  if (
    typeof authHeader !== 'string' ||
    !authHeader.startsWith(BEARER_PREFIX)
  ) {
    throw new Error('Missing or malformed Authorization header');
  }
  const token = authHeader.slice(BEARER_PREFIX.length);
  const payload = await jwtService.verifyAsync<JwtPayload>(token);
  return payload.sub;
}
