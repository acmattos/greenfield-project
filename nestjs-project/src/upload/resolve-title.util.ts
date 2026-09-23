const UNTITLED = 'Untitled video';
const TITLE_MAX_LENGTH = 255;

// Fallback chain: Upload-Metadata.title → Upload-Metadata.filename → literal
// 'Untitled video'. Resolved value is trimmed and hard-truncated to the
// Video.title column limit (per upload-processing/TD-06).
export function resolveTitle(
  metadata: Record<string, string | null> | undefined,
): string {
  const raw = metadata?.title || metadata?.filename || UNTITLED;
  const trimmed = raw.trim() || UNTITLED;
  return trimmed.slice(0, TITLE_MAX_LENGTH);
}
