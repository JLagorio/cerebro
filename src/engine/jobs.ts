import { learnQueue, type LearnQueueInput } from './learn';
import { isSkillEntry, lastFireKey, parseSchedule } from './skills';
import type { Concept } from './okf';
import type { Entry } from './types';

/**
 * The background agent's work list (M13.2) — one queue, four reasons.
 *
 * M8.6 built this for learning; M13 recognizes that a scheduled skill run is
 * the same shape of thing: derived from vault state rather than stored,
 * drained one at a time by a single runner, and stopped from spinning by a
 * ledger recorded before the run. The learn reasons keep their exact
 * semantics (engine/learn.ts is untouched); this module composes them with
 * the scheduled runs the vault's skills declare.
 *
 * Ranking: answering a deliberate filing still comes first; a scheduled run
 * is a standing appointment and goes next; catching up on edits and
 * rechecking stale concepts remain maintenance.
 */

export type JobKind = 'filed' | 'scheduled' | 'behind' | 'stale';

export interface AgentJob {
  kind: JobKind;
  path: string;
  title: string;
  /** What the ledger records at start: the note's modifiedAt for learn jobs,
   * the schedule's fire key for scheduled runs. */
  runKey: string;
}

export interface JobQueueInput extends LearnQueueInput {
  /** Skill path → fire key last run (uiStore.skillRuns). */
  skillRuns: Readonly<Record<string, string>>;
  /** The wall clock — passed in so the queue stays a pure derivation. */
  now: Date;
}

export function jobQueue(
  entries: readonly Entry[],
  concepts: readonly Concept[],
  { filed, attempts, skillRuns, now }: JobQueueInput,
): AgentJob[] {
  // Skills are excluded from learning for the same reason types/ is: a
  // skill's body is schema for behavior, not material. Distilling a playbook
  // yields concepts about the playbook, and then every edit to it re-queues
  // a re-read forever. The filter lives here rather than in isLearnable so
  // engine/learn.ts stays untouched by M13.
  const material = entries.filter((e) => !isSkillEntry(e));
  const learn: AgentJob[] = learnQueue(material, concepts, { filed, attempts }).map((j) => ({
    kind: j.reason,
    path: j.path,
    title: j.title,
    runKey: j.modifiedAt,
  }));

  const scheduled: AgentJob[] = [];
  for (const entry of entries) {
    if (!isSkillEntry(entry)) continue;
    const schedule = parseSchedule(entry.properties.schedule);
    if (schedule === null) continue;
    const key = lastFireKey(schedule, now);
    if (skillRuns[entry.path] === key) continue;
    scheduled.push({ kind: 'scheduled', path: entry.path, title: entry.title, runKey: key });
  }

  // Every kind has a DISTINCT rank, and that is load-bearing for the tie-
  // break below: learn runKeys are ISO timestamps, scheduled runKeys are
  // fire keys, and the two formats only ever compare within their own kind.
  // Give two kinds one rank and the sort silently orders by format.
  const RANK: Record<JobKind, number> = { filed: 0, scheduled: 1, behind: 2, stale: 3 };
  return [...learn, ...scheduled].sort(
    (a, b) =>
      RANK[a.kind] - RANK[b.kind] ||
      b.runKey.localeCompare(a.runKey) ||
      a.path.localeCompare(b.path),
  );
}
