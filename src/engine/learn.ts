import { commitOf, isKnowledgePath, type Concept } from './okf';
import type { Entry } from './types';

/**
 * What the knowledge base still has to read (M8.6).
 *
 * The base used to grow only when someone pressed "Learn from this", which
 * makes it a folder with a button on it: anything you forgot to feed it, it
 * never knew. This module is the answer to "what is outstanding" — and it is
 * DERIVED, like everything else in the knowledge layer, rather than a list of
 * jobs someone has to remember to write down.
 *
 * Two reasons a note is outstanding, and they are different in kind:
 *
 * - `filed` — you just organized a capture. New material, never read.
 * - `behind` — the base already read this note and you have edited it since,
 *   so what it holds is an older version of what you wrote. This one needs no
 *   event at all: it falls out of comparing the note's mtime against the stamp
 *   on the concepts that cite it, which means editing anything the base knows
 *   about automatically puts it back in line to be re-read.
 *
 * Nothing here notifies. The queue drains in the background and the only
 * places it is visible are the note's own panel and Settings — the hard rule
 * against badges that count up is what stops "your base is growing" from
 * turning into "you have 47 unread."
 */

export type LearnReason = 'filed' | 'behind' | 'stale';

export interface LearnJob {
  path: string;
  title: string;
  reason: LearnReason;
  /** The note version this job is for — what gets recorded as attempted. */
  modifiedAt: string;
}

/**
 * Notes the distiller should never be pointed at.
 *
 * The bundle is excluded so knowledge never distils itself into more
 * knowledge — that loop has no fixed point and every pass would cite the
 * previous one. Type notes are schema rather than material. An empty note is
 * excluded because asking a model to extract durable facts from nothing wastes
 * a turn and, worse, tends to produce one anyway.
 */
export function isLearnable(entry: Entry): boolean {
  if (isKnowledgePath(entry.path)) return false;
  if (entry.path === 'types' || entry.path.startsWith('types/')) return false;
  if (entry.parseError !== null) return false;
  return entry.snippet.trim() !== '';
}

export interface LearnQueueInput {
  /** Paths explicitly handed over — captures filed out of the Inbox. */
  filed: readonly string[];
  /**
   * path → the `modifiedAt` last attempted. The loop-stopper: a distillation
   * that decided there was nothing durable in a note writes no concept, which
   * leaves the note exactly as outstanding as it was before. Without this the
   * runner would pick it up again on the next tick, forever.
   */
  attempts: Readonly<Record<string, string>>;
}

export function learnQueue(
  entries: readonly Entry[],
  concepts: readonly Concept[],
  { filed, attempts }: LearnQueueInput,
): LearnJob[] {
  const filedSet = new Set(filed);
  const jobs: LearnJob[] = [];

  // M8.8 — the retirement loop. `stale_after` used to be a flag and nothing
  // more: the date passed, a warning icon appeared, and the concept sat there
  // being wrong. A date the producer chose is a statement that the claim needs
  // rechecking THEN, so it becomes work. The recheck reads the concept's own
  // sources and revises, supersedes, or deprecates it — which is what stops
  // the bundle being append-only.
  for (const concept of concepts) {
    if (!concept.stale || concept.supersededBy !== null) continue;
    if (concept.lifecycle === 'deprecated') continue;
    if (attempts[concept.entry.path] === concept.entry.modifiedAt) continue;
    jobs.push({
      path: concept.entry.path,
      title: concept.title,
      reason: 'stale',
      modifiedAt: concept.entry.modifiedAt,
    });
  }

  for (const entry of entries) {
    if (!isLearnable(entry)) continue;
    if (attempts[entry.path] === entry.modifiedAt) continue;

    // M25.3 — the mtime era ends here. `commitOf`'s `behind` compares a
    // FILESYSTEM timestamp against a frontmatter stamp, which is why a
    // `git checkout` (every mtime rewritten, not one byte changed) used to
    // flood this queue. Catch-up now decides "behind" by content hash, in
    // `runtime/catchup.rs`, against a durable prior snapshot.
    //
    // `commitOf` itself SURVIVES: it still answers "is what the base learned
    // current with this note", which is the question KnowledgeCommit.tsx
    // renders. It just no longer manufactures work.
    const { state } = commitOf(entry, concepts);
    const reason: LearnReason | null =
      filedSet.has(entry.path) && state !== 'committed' ? 'filed' : null;
    if (reason === null) continue;

    jobs.push({ path: entry.path, title: entry.title, reason, modifiedAt: entry.modifiedAt });
  }

  // Filing is a deliberate act and answering it promptly is what makes the
  // base feel responsive; catching up on edits is maintenance and can wait.
  // Rechecking a stale concept waits longest — it is the only job about
  // something the base already holds rather than something it is missing.
  const RANK: Record<LearnReason, number> = { filed: 0, behind: 1, stale: 2 };
  const rank = (j: LearnJob) => RANK[j.reason];
  return jobs.sort(
    (a, b) =>
      rank(a) - rank(b) || b.modifiedAt.localeCompare(a.modifiedAt) || a.path.localeCompare(b.path),
  );
}
