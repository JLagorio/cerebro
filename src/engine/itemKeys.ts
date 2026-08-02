import type { Entry } from './types';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Next key for a project prefix: scans properties.key for ^PREFIX-(\d+)$ matches
 * across the loaded entry set and returns PREFIX-<max + 1> ('FLD-1' when none).
 */
export function nextItemKey(prefix: string, entries: Entry[]): string {
  const pattern = new RegExp(`^${escapeRegExp(prefix)}-(\\d+)$`);
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
