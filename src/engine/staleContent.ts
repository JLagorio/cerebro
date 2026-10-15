export const STALE_PREFIX = 'stale_content:';

/** IPC errors may arrive as strings; ordinary JavaScript errors carry a message. */
export function isStaleContent(error: unknown): boolean {
  const message = error instanceof Error ? error.message : error;
  return typeof message === 'string' && message.startsWith(STALE_PREFIX);
}
