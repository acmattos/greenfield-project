const UNTITLED = 'Untitled video';
const TITLE_MAX_LENGTH = 255;

// Fallback chain: Upload-Metadata.title → Upload-Metadata.filename → literal
// 'Untitled video'. Each candidate is trimmed BEFORE its truthiness is
// checked — a whitespace-only title must fall through to filename, not
// win the chain and only get discarded afterward (which would silently
// throw away a real filename that was available). The final resolved
// value is hard-truncated to the Video.title column limit (per
// upload-processing/TD-06).
export function resolveTitle(
  metadata: Record<string, string | null> | undefined,
): string {
  const title = metadata?.title?.trim();
  const filename = metadata?.filename?.trim();
  const resolved = title || filename || UNTITLED;
  return resolved.slice(0, TITLE_MAX_LENGTH);
}
