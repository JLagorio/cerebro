import type { RunOwner } from '@/agent/runs';

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
 * localStorage, beside the conversations and for the same reason: it is a
 * record of the tool, not of the work. Writing it into the vault would put it
 * in the corpus, in git, and in the user's backups — three places where a
 * machine log is noise. It is capped and it is disposable; nothing downstream
 * may depend on an entry still being there.
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
  status: 'ok' | 'failed' | 'stopped';
  /** Present when status is 'failed'. One line, never a stack. */
  error?: string;
  /**
   * When a schedule owed this run (M34.2), ISO. Present only for
   * schedule-fired jobs — an event run is due the moment its event lands and
   * a chat turn is due never. Optional like `durableId`, and for the same
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

const KEY = 'cerebro.runLog';
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

export function loadRunLog(): RunLogEntry[] {
  try {
    const raw = window.localStorage.getItem(KEY);
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    // Tolerant like every other load path: one malformed row must not take the
    // whole log with it.
    return Array.isArray(parsed) ? parsed.filter(isEntry) : [];
  } catch {
    return [];
  }
}

/** Newest first, capped. Returns what it stored so a caller can render it
 * without re-reading. */
export function appendRunLog(entry: RunLogEntry): RunLogEntry[] {
  const next = [entry, ...loadRunLog()].slice(0, MAX_KEPT);
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Storage unavailable (private mode): the log is session-only, which is
    // strictly better than failing the run that was trying to record itself.
  }
  return next;
}

export function clearRunLog(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // Nothing to do — see above.
  }
}

/** One line for a row. Separate from the component so the phrasing is testable
 * and so "wrote nothing" reads as an outcome rather than as a blank. */
export function describeRun(entry: RunLogEntry): string {
  if (entry.status === 'failed') return entry.error ?? 'Failed';
  if (entry.status === 'stopped') return 'Stopped';
  const wrote =
    entry.files.length === 0
      ? 'Wrote nothing'
      : entry.files.length === 1
        ? `Wrote ${entry.files[0]}`
        : `Wrote ${entry.files.length} files`;
  const late = lateBy(entry);
  return late === null ? wrote : `${wrote} · ran ${late} late`;
}

/**
 * A run fired well after its due moment says how late (M34.2) — the visible
 * consequence of app-lifetime scheduling, and deliberately NOT a failure: a
 * laptop closed over the weekend owes one honest catch-up, not an apology.
 * The threshold is the runner's own cadence (60s tick + settle) with margin;
 * a run landing inside it was simply the next tick, not a missed window.
 */
const LATE_AFTER_MS = 5 * 60_000;

function lateBy(entry: RunLogEntry): string | null {
  if (entry.dueAt === undefined) return null;
  const gap = Date.parse(entry.at) - Date.parse(entry.dueAt);
  if (Number.isNaN(gap) || gap < LATE_AFTER_MS) return null;
  const minutes = Math.round(gap / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/**
 * The vault path a tool call wrote, or null if it wrote nothing.
 *
 * Read from the tool's own input rather than from a response, because that is
 * what the event stream carries and because it is the same field the scope
 * check reads — one description of "what this call is aimed at", used twice.
 */
export function writtenPath(tool: string, input: string | null): string | null {
  if (input === null) return null;
  let args: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(input);
    if (typeof parsed !== 'object' || parsed === null) return null;
    args = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const str = (key: string): string | null =>
    typeof args[key] === 'string' && args[key].trim() !== '' ? (args[key] as string).trim() : null;
  const name = tool.replace(/^mcp__cerebro__/, '');
  switch (name) {
    case 'update_frontmatter':
    case 'append_to_note':
      return str('path');
    // A create names a folder and a title; the file is the two together, and
    // the folder alone is what the scope check sees. Reporting the folder is
    // honest and does not pretend to know the slug the writer chose.
    case 'create_note':
    case 'write_concept':
      return str('path') ?? str('folder');
    case 'cache_source':
      return str('path') ?? str('id');
    default:
      return null;
  }
}
