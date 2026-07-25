const KEY_SHAPE = /^[a-z]+-\d+$/i;

function hasWordBoundaryMatch(candidate: string, query: string): boolean {
  let idx = candidate.indexOf(query);
  while (idx !== -1) {
    if (idx === 0) return true;
    const prev = candidate[idx - 1];
    if (prev === ' ' || prev === '-' || prev === '_' || prev === '/' || prev === '.') return true;
    idx = candidate.indexOf(query, idx + 1);
  }
  return false;
}

/**
 * Fuzzy score for quick open (⌘K). 0 = no match; higher = better.
 * Tiers: exact prefix (3) > word-boundary (2) > substring (1), case-insensitive.
 * Key-shaped candidates ('FLD-7') also match hyphen-less queries ('fld7') at prefix tier.
 * Ties within a tier break deterministically toward the shorter candidate.
 */
export function quickOpenScore(query: string, candidate: string): number {
  const q = query.trim().toLowerCase();
  const c = candidate.toLowerCase();
  if (q === '' || c === '') return 0;

  let tier = 0;
  if (c.startsWith(q)) tier = 3;
  else if (hasWordBoundaryMatch(c, q)) tier = 2;
  else if (c.includes(q)) tier = 1;
  else if (KEY_SHAPE.test(candidate)) {
    const qKey = q.replace(/[^a-z0-9]/g, '');
    const cKey = c.replace(/-/g, '');
    if (qKey !== '' && cKey.startsWith(qKey)) tier = 3;
  }

  if (tier === 0) return 0;
  return tier * 1000 - Math.min(candidate.length, 999);
}
