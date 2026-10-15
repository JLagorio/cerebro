import type { Entry } from './types';
import { targetIndexFor } from './wikilink';

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
export function outgoingFor(entry: Entry, entries: readonly Entry[]): DocLink[] {
  const index = targetIndexFor(entries);
  const links: DocLink[] = [];
  for (const target of entry.outgoingLinks) {
    const resolved = index.resolveLink(target)?.entry ?? null;
    if (resolved !== null && resolved.path !== entry.path) {
      links.push({ entry: resolved, via: 'body' });
    }
  }
  for (const [field, targets] of Object.entries(entry.relationships)) {
    for (const target of targets) {
      const resolved = index.resolveLink(target)?.entry ?? null;
      if (resolved !== null && resolved.path !== entry.path) {
        links.push({ entry: resolved, via: field });
      }
    }
  }
  return dedupe(links);
}

/** targetPath → the links INTO it, in source order. */
type BacklinkIndex = Map<string, DocLink[]>;

/** One index per entries array, with the length it was built at. */
const backlinkIndexes = new WeakMap<readonly Entry[], { length: number; index: BacklinkIndex }>();

/**
 * Every backlink in the vault, built in one pass (M60.9) and memoized per
 * entries array exactly as `targetIndexFor` is (a snapshot; a length change
 * rebuilds). Per source in entry order: its body links first, one per target
 * however often the body names it, then each relationship field, one per
 * field and target. A source never backlinks itself.
 */
export function backlinkIndexFor(entries: readonly Entry[]): BacklinkIndex {
  const memo = backlinkIndexes.get(entries);
  if (memo !== undefined && memo.length === entries.length) return memo.index;
  const targets = targetIndexFor(entries);
  const index: BacklinkIndex = new Map();
  const add = (source: Entry, via: string, raws: readonly string[]) => {
    const seen = new Set<string>();
    for (const raw of raws) {
      const target = targets.resolveLink(raw)?.entry;
      if (target === undefined || target.path === source.path || seen.has(target.path)) continue;
      seen.add(target.path);
      const bucket = index.get(target.path);
      if (bucket === undefined) index.set(target.path, [{ entry: source, via }]);
      else bucket.push({ entry: source, via });
    }
  };
  for (const source of entries) {
    add(source, 'body', source.outgoingLinks);
    for (const [field, raws] of Object.entries(source.relationships)) add(source, field, raws);
  }
  backlinkIndexes.set(entries, { length: entries.length, index });
  return index;
}

/** Notes that link TO this entry (backlinks), with how they link. */
export function backlinksFor(entry: Entry, entries: readonly Entry[]): DocLink[] {
  return dedupe(backlinkIndexFor(entries).get(entry.path) ?? []);
}
