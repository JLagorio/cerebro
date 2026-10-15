import { lateBy } from '@/engine/whenText';
import type { FleetRunCause } from '@/lib/ipc';

/**
 * Why a run started, in words (M56.7).
 *
 * The words are Rust's: `cause.why` comes from the one vocabulary in
 * `src-tauri/src/runtime/cause.rs`, so this side keeps no list of kinds and
 * names none. What it adds is the detail the run was started with and, for a
 * schedule's fire, how late it ran, by the same rule the run log uses
 * (`lateBy`).
 *
 * **Absent is never a guess.** A run with no cause — one from before causes
 * were recorded, or one that named none — reads "why not recorded". A cause
 * whose words came back empty, from a build that knows a kind this one does
 * not, says so and names the kind.
 */
export function runWhyText(cause: FleetRunCause | null | undefined, startedAt: string): string {
  if (cause == null) return 'why not recorded';
  const why =
    cause.why.trim() === ''
      ? `started for a reason this version does not name (${cause.kind})`
      : cause.why;
  const detail = cause.detail === null || cause.detail === '' ? '' : ` (${cause.detail})`;
  const late = cause.due_at === null ? null : lateBy(cause.due_at, startedAt);
  return `${why}${detail}${late === null ? '' : ` · ran ${late} late`}`;
}

export function RunWhy({
  cause,
  startedAt,
}: {
  cause: FleetRunCause | null | undefined;
  startedAt: string;
}) {
  const text = runWhyText(cause, startedAt);
  // The row truncates; the whole sentence, and the subject it was started
  // about, are a hover away. `flex-1` (a zero basis) splits the leftover
  // width evenly with the row's other `flex-1` column — who, or when — so a
  // long why can never squeeze that column to nothing.
  const subject = cause?.subject ?? null;
  return (
    <span
      data-testid="run-why"
      data-kind={cause?.kind}
      title={subject === null ? text : `${text} — ${subject}`}
      className="min-w-0 flex-1 truncate text-2xs text-n-500"
    >
      {text}
    </span>
  );
}
