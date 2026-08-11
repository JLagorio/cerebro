/**
 * How a `click` line's target is READ (M29.38) — one source of truth for the
 * popover that offers targets and the badge that opens them, which drifted
 * apart the moment each spelled its own regex.
 *
 * Three readings, and the third is why this is a module rather than a boolean:
 *
 * - a WEB URL (`http(s)://…`) opens in a new window;
 * - a VAULT PATH — anything carrying no URI scheme at all — goes to the host's
 *   own router;
 * - anything else (`mailto:`, `tel:`, `file:`, `data:`) is neither. Only a
 *   hand-written line can produce one (`LinkPopover` offers the first two and
 *   nothing else), and routing it as a path asked the app to open a doc named
 *   `mailto:x@y.com`. Saying "the editor cannot open this" is the honest
 *   answer; guessing at a mail client from inside a webview is not.
 */

/**
 * Anchored and whitespace-free: the WHOLE target must be the URL. The badge and
 * the popover ask the same question of the same string — a looser prefix test
 * on one side classified targets the other side would never have offered.
 */
const WEB_URL = /^https?:\/\/\S+$/;

/** A URI scheme prefix (`mailto:`, `file:`, `data:`), by RFC 3986's shape. */
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** True when the target is an http(s) address — the only thing `window.open` sees. */
export function isWebUrl(target: string): boolean {
  return WEB_URL.test(target.trim());
}

/**
 * True when the target names something in the vault rather than somewhere else
 * entirely. A bare relative path carries no scheme; a Windows-style `C:\…` is
 * excluded with the rest, which is correct — it is not vault-relative either.
 */
export function isVaultPath(target: string): boolean {
  const t = target.trim();
  return t !== '' && !HAS_SCHEME.test(t);
}
