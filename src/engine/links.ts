import type { Entry } from './types';
import { resolveTarget } from './wikilink';

/** One resolved connection between two notes. `via` is 'body' for inline
 * wikilinks, otherwise the frontmatter field name that holds the link. */
export interface DocLink {
  entry: Entry;
  via: string;
}

const dedupe = (links: DocLink[]): DocLink[] => {
  const seen = new Set<string>();
  return links.filter((l) => {
    const key = `${l.entry.path}\0${l.via}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

/** Notes this entry links to — body wikilinks plus relationship fields. */
export function outgoingFor(entry: Entry, entries: Entry[]): DocLink[] {
  const links: DocLink[] = [];
  for (const target of entry.outgoingLinks) {
    const resolved = resolveTarget(target, entries);
    if (resolved !== null && resolved.path !== entry.path) {
      links.push({ entry: resolved, via: 'body' });
    }
  }
  for (const [field, targets] of Object.entries(entry.relationships)) {
    for (const target of targets) {
      const resolved = resolveTarget(target, entries);
      if (resolved !== null && resolved.path !== entry.path) {
        links.push({ entry: resolved, via: field });
      }
    }
  }
  return dedupe(links);
}

/** Notes that link TO this entry (backlinks), with how they link. */
export function backlinksFor(entry: Entry, entries: Entry[]): DocLink[] {
  const links: DocLink[] = [];
  for (const other of entries) {
    if (other.path === entry.path) continue;
    for (const target of other.outgoingLinks) {
      if (resolveTarget(target, entries)?.path === entry.path) {
        links.push({ entry: other, via: 'body' });
        break; // one body backlink per note is enough
      }
    }
    for (const [field, targets] of Object.entries(other.relationships)) {
      if (targets.some((t) => resolveTarget(t, entries)?.path === entry.path)) {
        links.push({ entry: other, via: field });
      }
    }
  }
  return dedupe(links);
}
