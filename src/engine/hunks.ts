/**
 * Per-hunk accept/reject for a rewrite (M17.16).
 *
 * The most-validated pattern in this space, and the one both Cursor and
 * Windsurf regressed and had to restore: a person asked for a rewrite wants
 * three of the five changes, and a single Accept/Reject makes them take the
 * two they did not want or lose the three they did.
 *
 * ## Why word-level and not character-level
 *
 * Character diffs on prose produce hunks nobody can act on — half a word
 * replaced by half another word, with the shared letters in the middle
 * presented as agreement. A hunk has to be a thing a reader can say yes or no
 * to, so the unit is the word, and adjacent changed words collapse into one
 * hunk. That is also why whitespace rides with the token that precedes it:
 * accepting "delete this word" must not leave two spaces behind.
 */

export interface Hunk {
  id: number;
  /** '' when this hunk is a pure insertion. */
  before: string;
  /** '' when this hunk is a pure deletion. */
  after: string;
}

/** A rewrite, split into the parts that agree and the parts that do not. */
export interface Rewrite {
  /** Unchanged runs and changed hunks, in document order. A string is text
   * both versions share; a Hunk is a decision. */
  parts: (string | Hunk)[];
  hunks: Hunk[];
}

/** Split into words, keeping each word's trailing whitespace attached so that
 * rejoining is exact and deleting a word does not leave a double space. */
function tokenize(text: string): string[] {
  return text.match(/\s*\S+\s*|\s+/g) ?? [];
}

/**
 * Longest common subsequence over tokens, as a table of back-pointers.
 *
 * O(n·m), which is fine at the scale this runs on: the input is a selection a
 * person made, not a file. A selection large enough for this to matter is one
 * that should have gone to the panel instead, which is what M17.16's
 * escalation rule is for.
 */
function lcs(a: string[], b: string[]): number[][] {
  const table: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i][j] =
        a[i].trim() === b[j].trim()
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  return table;
}

/** Diff two versions of a passage into shared runs and decidable hunks. */
export function rewriteHunks(before: string, after: string): Rewrite {
  const a = tokenize(before);
  const b = tokenize(after);
  const table = lcs(a, b);
  const parts: (string | Hunk)[] = [];
  const hunks: Hunk[] = [];
  let i = 0;
  let j = 0;
  let shared = '';
  let removed = '';
  let added = '';

  const flushHunk = () => {
    if (removed === '' && added === '') return;
    const hunk: Hunk = { id: hunks.length, before: removed, after: added };
    hunks.push(hunk);
    parts.push(hunk);
    removed = '';
    added = '';
  };
  const flushShared = () => {
    if (shared === '') return;
    parts.push(shared);
    shared = '';
  };

  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i].trim() === b[j].trim()) {
      flushHunk();
      // The AFTER side's spacing wins on a shared token: the rewrite may have
      // re-wrapped the paragraph, and keeping the old whitespace would make an
      // accepted rewrite differ from what was shown.
      shared += b[j];
      i++;
      j++;
      continue;
    }
    flushShared();
    // Adjacent changes collapse into ONE hunk. Two consecutive replaced words
    // are one edit to a reader, and offering them separately produces
    // half-accepted sentences that read as neither version.
    if (j < b.length && (i >= a.length || table[i][j + 1] >= table[i + 1][j])) {
      added += b[j];
      j++;
    } else {
      removed += a[i];
      i++;
    }
  }
  flushHunk();
  flushShared();
  return { parts, hunks };
}

/**
 * The text you get by accepting some hunks and rejecting the rest.
 *
 * `accepted` is the set of hunk ids to take. Everything not named is rejected,
 * so the default of an empty set is the original passage — a decision surface
 * whose default silently changed the document would be a trap.
 */
export function applyHunks(rewrite: Rewrite, accepted: ReadonlySet<number>): string {
  return rewrite.parts
    .map((part) =>
      typeof part === 'string' ? part : accepted.has(part.id) ? part.after : part.before,
    )
    .join('');
}

/** True when the rewrite changed nothing — worth saying out loud rather than
 * showing an empty decision list and letting the user wonder. */
export function isUnchanged(rewrite: Rewrite): boolean {
  return rewrite.hunks.length === 0;
}

/** A short label for a hunk, for a screen reader and for a compact list. */
export function describeHunk(hunk: Hunk): string {
  if (hunk.before.trim() === '') return `Add "${hunk.after.trim()}"`;
  if (hunk.after.trim() === '') return `Delete "${hunk.before.trim()}"`;
  return `Replace "${hunk.before.trim()}" with "${hunk.after.trim()}"`;
}
