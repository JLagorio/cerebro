/**
 * Turning a markdown href into somewhere to go.
 *
 * Relative links resolving in-app is the feature that makes a pile of markdown
 * into browsable documentation, and it is the reason this spec built a viewer
 * instead of rendering rows.
 */

export type HrefKind = 'external' | 'anchor' | 'internal';

export function classifyHref(href: string): HrefKind {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return 'external';
  if (href.startsWith('#')) return 'anchor';
  return 'internal';
}

/**
 * Resolve `href` against the file it appeared in, yielding a root-relative
 * path. Never leaves a `..` in the result — the backend refuses those anyway,
 * and resolving here keeps the tree selection agreeing with the link.
 */
export function resolveRelative(fromPath: string, href: string): string {
  const withoutFragment = href.split('#')[0].split('?')[0];
  const base = withoutFragment.startsWith('/') ? [] : fromPath.split('/').slice(0, -1);
  const segments = withoutFragment.replace(/^\//, '').split('/');

  const out = [...base];
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') out.pop();
    else out.push(segment);
  }
  return out.join('/');
}

/** Decode a markdown image reference before resolving it, refusing an escape. */
export function resolveImagePath(fromPath: string, href: string): string | null {
  if (href.startsWith('<') && href.endsWith('>')) href = href.slice(1, -1);
  if (classifyHref(href) !== 'internal' || href.startsWith('//')) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(href.split('#')[0].split('?')[0]);
  } catch {
    return null;
  }
  if (
    decoded.includes('\\') ||
    decoded.startsWith('//') ||
    /^[a-z][a-z0-9+.-]*:/i.test(decoded) ||
    [...decoded].some(
      (char) =>
        char.charCodeAt(0) < 0x20 || (char.charCodeAt(0) >= 0x7f && char.charCodeAt(0) <= 0x9f),
    )
  )
    return null;
  const base = decoded.startsWith('/') ? [] : fromPath.split('/').slice(0, -1);
  for (const part of decoded.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (base.length === 0) return null;
      base.pop();
    } else base.push(part);
  }
  return base.length === 0 ? null : base.join('/');
}
