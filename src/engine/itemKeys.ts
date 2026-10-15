import type { Entry } from './types';
import { itemKeyOf } from './wikilink';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A host's authored prefix, excluding a key already assigned to one item. */
export function keyPrefixOf(host: Entry): string | null {
  const raw = host.properties.key;
  if (typeof raw !== 'string' || itemKeyOf(host) !== null) return null;
  const prefix = raw.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, '');
  return /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(prefix) ? prefix : null;
}

/**
 * Next key for a host prefix: scans properties.key for ^PREFIX-(\d+)$ matches
 * case-insensitively across the loaded entries. Keeps the host's prefix
 * spelling and returns PREFIX-<max + 1> ('FLD-1' when none).
 */
export function nextItemKey(prefix: string, entries: Entry[]): string {
  const pattern = new RegExp(`^${escapeRegExp(prefix)}-(\\d+)$`, 'i');
  let max = 0;
  for (const entry of entries) {
    const key = entry.properties.key;
    if (typeof key !== 'string') continue;
    const match = pattern.exec(key);
    if (match === null) continue;
    const n = Number.parseInt(match[1], 10);
    if (n > max) max = n;
  }
  return `${prefix}-${max + 1}`;
}
