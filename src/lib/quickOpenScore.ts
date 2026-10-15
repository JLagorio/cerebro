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
 * How well the whole query names one candidate: the tier step of
 * `src/lib/nameRank.ts` (M59.3), which ranks every name picker. It is not
 * fuzzy: 0 = no match, then substring (1) < word boundary (2) < exact prefix
 * (3), case-insensitive. Key-shaped candidates ('FLD-7') also match
 * hyphen-less queries ('fld7') at the prefix tier.
 */
export function quickOpenTier(query: string, candidate: string): 0 | 1 | 2 | 3 {
  const q = query.trim().toLowerCase();
  const c = candidate.toLowerCase();
  if (q === '' || c === '') return 0;

  if (c.startsWith(q)) return 3;
  if (hasWordBoundaryMatch(c, q)) return 2;
  if (c.includes(q)) return 1;
  if (KEY_SHAPE.test(candidate)) {
    const qKey = q.replace(/[^a-z0-9]/g, '');
    const cKey = c.replace(/-/g, '');
    if (qKey !== '' && cKey.startsWith(qKey)) return 3;
  }
  return 0;
}

/**
 * The tier as one number, ties broken toward the shorter candidate (M1).
 * 0 = no match; higher = better.
 */
export function quickOpenScore(query: string, candidate: string): number {
  const tier = quickOpenTier(query, candidate);
  if (tier === 0) return 0;
  return tier * 1000 - Math.min(candidate.length, 999);
}
