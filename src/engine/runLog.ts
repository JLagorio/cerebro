import { toolFacts } from '@/lib/policy/tools';
import { lateBy } from './whenText';

/** Who a run was for (M17.7). It lives beside the log that records it, so the
 * engine needs nothing from agent/; agent/runs.ts reads it from here. */
export type RunOwner =
  /** A turn someone typed and is watching. */
  | 'chat'
  /** A background job: distilling, a scheduled skill, an agent record. */
  | 'job';

/**
 * What the assistant did, and when (M17.15).
 *
 * Every researcher called this non-negotiable and there was nothing to extend:
 * no table, no file, no event. An unattended agent could write into your vault
 * for a month and leave no record that it had run at all — only the diffs, and
 * only if the vault happened to be a git repo.
 *
 * ## Not a transcript
 *
 * `{ agent, trigger, scope, files, status }` and deliberately nothing more.
 * The reasoning is that a transcript is prose ABOUT the vault, and this app has
 * a background distiller that reads the vault: store the agent's own words
 * where the distiller can see them and the base starts learning from its own
 * output, which is the exact loop M8's "nothing speaks first" model exists to
 * avoid. What the agent CONCLUDED already has a home — the knowledge bundle,
 * with provenance. What is missing is the fact that a run happened.
 *
 * ## Where it lives
 *
 * In localStorage, beside the conversations and for the same reason: it is a
 * record of the tool, not of the work. Writing it into the vault would put it
 * in the corpus, in git, and in the user's backups — three places where a
 * machine log is noise. It is capped and it is disposable; nothing downstream
 * may depend on an entry still being there.
 *
 * stores/runLogStore.ts keeps it there. This module holds the shape, the
 * parse, the cap and the wording, and touches no storage itself.
 */
export interface RunLogEntry {
  id: string;
  /** ISO. Sorting key and the only thing the UI formats. */
  at: string;
  owner: RunOwner;
  /** The agent or conversation this run belonged to, by title. */
  label: string;
  /** Record path for an agent run; null for a chat turn. */
  source: string | null;
  /** Why it ran: a schedule, an event, or a person. */
  trigger: string;
  /** What it was allowed to write to, as declared. Null = unrestricted. */
  scope: string[] | null;
  /** Vault paths it wrote, in call order. Empty is a real and common result —
   * an agent that correctly decides to do nothing has run successfully. */
  files: string[];
  /** `deferred` (M34.2.4) is the budget gate saying "not now" — the run
   * never started and its fire key was surrendered. A schedule's fire
   * retries on a later launch; a woken run's wake stays pending in
   * `runtime.db` and runs once the gate lets it (M63.1), logged deferred
   * once. Deliberately not `failed`: nothing went wrong. */
  status: 'ok' | 'failed' | 'stopped' | 'deferred';
  /** Present when status is 'failed' or 'deferred'. One line, never a
   * stack — for a deferral, the gate's reasons. */
  error?: string;
  /**
   * When a schedule owed this run (M34.2), ISO. Present only for
   * schedule-fired jobs — a woken run is due the moment its wake is admitted
   * and a chat turn is due never. Optional like `durableId`, and for the same
   * reason: old entries parse unchanged.
   */
  dueAt?: string;
  /**
   * The durable run id (M33.7) — the key of this run's row in `runs`.
   *
   * OPTIONAL, and old entries parse unchanged: this log has always been keyed
   * by the process-local tag, which restarts at zero every launch and so
   * cannot address a database row. Entries written before this, and entries
   * written where no runtime database exists, have none — they are the run
   * log's honest "this device only" state, and nothing backfills them.
   *
   * This log stays what its header says it is: a disposable, device-local
   * record. M33 LINKS it to the durable one; it does not migrate it.
   */
  durableId?: string;
}

/**
 * Enough to answer "what has it been doing this week"; not enough to become
 * storage. A log that grows without bound in localStorage eventually competes
 * with the conversations for the same quota, and the conversations are the
 * thing a person would actually miss.
 */
const MAX_KEPT = 200;

function isEntry(raw: unknown): raw is RunLogEntry {
  if (typeof raw !== 'object' || raw === null) return false;
  const e = raw as Record<string, unknown>;
  return typeof e.id === 'string' && typeof e.at === 'string' && Array.isArray(e.files);
}

/** The stored log, read back: null (nothing stored) and anything that is not
 * a JSON list read as an empty log. */
export function parseRunLog(raw: string | null): RunLogEntry[] {
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    // Tolerant like every other load path: one malformed row must not take the
    // whole log with it.
    return Array.isArray(parsed) ? parsed.filter(isEntry) : [];
  } catch {
    return [];
  }
}

/** The log with `entry` recorded: newest first, capped. */
export function capRunLog(entry: RunLogEntry, prior: readonly RunLogEntry[]): RunLogEntry[] {
  return [entry, ...prior].slice(0, MAX_KEPT);
}

/** One line for a row. Separate from the component so the phrasing is testable
 * and so "wrote nothing" reads as an outcome rather than as a blank. */
export function describeRun(entry: RunLogEntry): string {
  if (entry.status === 'failed') return entry.error ?? 'Failed';
  if (entry.status === 'stopped') return 'Stopped';
  if (entry.status === 'deferred') return entry.error ?? 'Deferred by the budget gate';
  const wrote =
    entry.files.length === 0
      ? 'Wrote nothing'
      : entry.files.length === 1
        ? `Wrote ${entry.files[0]}`
        : `Wrote ${entry.files.length} files`;
  // Late is not failed: see whenText's lateBy, the rule the fleet shares.
  const late = entry.dueAt === undefined ? null : lateBy(entry.dueAt, entry.at);
  return late === null ? wrote : `${wrote} · ran ${late} late`;
}

/**
 * The vault path a tool call wrote, or null if it wrote nothing.
 *
 * Read from the tool's own input rather than from a response, because that is
 * what the event stream carries. The field is the tool's target argument in
 * the manifest (`shared/policy/tools.v1.json`), the one the server aims its
 * scope checks by — one description of "what this call is aimed at", used
 * twice. For a create that is the folder: the scope check sees the folder
 * alone, and the slug is the writer's to choose. A tool that writes nothing,
 * or writes with no target argument (a proposal, a CLI edit), reports null.
 */
export function writtenPath(tool: string, input: string | null): string | null {
  const facts = toolFacts(tool);
  const arg = facts?.writes === true ? (facts.target?.arg ?? null) : null;
  if (arg === null || input === null) return null;
  let args: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(input);
    if (typeof parsed !== 'object' || parsed === null) return null;
    args = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const value = args[arg];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}
