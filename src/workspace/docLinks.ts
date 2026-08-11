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
