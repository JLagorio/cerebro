/**
 * A run's changeset, in words (M58.3).
 *
 * Rust commits what each run wrote when it ends (`src-tauri/src/git/
 * changeset.rs`, CV-34) and says so in one `Changeset` event; this is the
 * shape of that event, of what `conversation_changes` reads back later
 * (M92.12, `git/conversation.rs`), and the one place its words live. Pure:
 * no DOM, no store, no IPC.
 *
 * CV-05 holds throughout. A binary file's counts are absent, never 0, and its
 * row reads "binary"; a total with only binaries to count is absent, and the
 * headline leaves it out rather than print "+0 −0". A run whose writes nobody
 * recorded says so, which is a different sentence from "changed nothing". A
 * changeset read back from history cannot know what only its run's reader
 * knew, so `also_by`, `kept_out_of_git` and `shell_unrecorded` are null
 * there: not recorded, never an empty list, 0 or false.
 */

export type ChangeKind = 'added' | 'modified' | 'deleted' | 'renamed';

/** One file of a run's commit. A binary file's counts are null. */
export interface ChangedFile {
  path: string;
  previous_path: string | null;
  kind: ChangeKind;
  additions: number | null;
  deletions: number | null;
  /** Other actors who wrote this path since its last commit: their edits
   * ride in this commit too. Null where that was not recorded: a commit
   * read back from history (M92.12). */
  also_by: string[] | null;
}

/** What a run changed, as Rust's `RunChangeset` serializes it. */
export type RunChangeset = {
  /** Absent on older persisted events, and null on one read back from
   * history (M92.12); never inferred from their file list. */
  kept_out_of_git?: number | null;
} & (
  | {
      state: 'committed';
      run_id: string;
      /** The full hash; the panel shows seven. */
      commit: string;
      files: ChangedFile[];
      additions: number | null;
      deletions: number | null;
      /** How many of the files are binary. */
      binary: number;
      /** Null on a changeset read back from history (M92.12). */
      shell_unrecorded: boolean | null;
    }
  | { state: 'nothing'; run_id: string; shell_unrecorded: boolean | null }
  | { state: 'not_recorded'; run_id: string | null; reason: string; files: string[] }
  | { state: 'not_a_repo'; run_id: string; files: string[]; shell_unrecorded: boolean | null }
  | {
      state: 'unavailable';
      run_id: string;
      reason: string;
      files: string[];
      shell_unrecorded: boolean | null;
    }
);

/**
 * What `conversation_changes` reads back (M92.12): the changesets of the
 * runs that ran as a conversation's session in this vault, oldest first, the
 * newest 100 of them; `truncated` when older ones were left out. Never
 * stored: the rail folds it in for the runs no reply holds.
 */
export interface ConversationChangesets {
  changesets: RunChangeset[];
  truncated: boolean;
}

export function keptOutOfGitWords(changeset: RunChangeset): string | null {
  const count = changeset.kept_out_of_git;
  return typeof count === 'number' && count > 0
    ? `Kept ${count} mail ${count === 1 ? 'file' : 'files'} out of git.`
    : null;
}

export const CHANGESET_WORDS = {
  notRecorded: 'Changes not recorded for this turn.',
  notARepo: 'Line counts and diffs need History for this vault.',
  shell: "Shell commands this run ran may have changed other files; those aren't recorded here.",
  truncated: 'Showing the first 2 MB.',
  binary: 'binary',
  viewDiff: 'View diff',
  patchUnavailable: "This file's changes could not be read.",
  alsoByNotRecorded: 'who else edited it: not recorded',
} as const;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The seven characters a commit is shown by. */
export const shortHash = (commit: string): string => commit.slice(0, 7);

/** How many files a changeset names, whatever its state. */
export function changesetFileCount(changeset: RunChangeset): number {
  switch (changeset.state) {
    case 'committed':
    case 'not_a_repo':
    case 'unavailable':
    case 'not_recorded':
      return changeset.files.length;
    case 'nothing':
      return 0;
  }
}

/**
 * The footer's one line, or null when there is nothing to say: "Changed N
 * files · +a −b · k binary" for a commit, the counts left out where they are
 * absent; "Changed N files" for a vault with no history; the sentence for a
 * turn whose changes were not recorded or could not be committed.
 */
export function changesetHeadline(changeset: RunChangeset): string | null {
  switch (changeset.state) {
    case 'committed': {
      const parts = [`Changed ${plural(changeset.files.length, 'file', 'files')}`];
      if (changeset.additions !== null && changeset.deletions !== null) {
        parts.push(`+${changeset.additions} −${changeset.deletions}`);
      }
      if (changeset.binary > 0) parts.push(`${changeset.binary} binary`);
      return parts.join(' · ');
    }
    case 'not_a_repo':
      return `Changed ${plural(changeset.files.length, 'file', 'files')}`;
    case 'not_recorded':
      return CHANGESET_WORDS.notRecorded;
    case 'unavailable':
      return `Couldn't commit this turn's changes: ${changeset.reason}.`;
    case 'nothing':
      return null;
  }
}

/** A file row's counts: "+a −b", or "binary" when git counted none. */
export function fileCounts(file: ChangedFile): string {
  if (file.additions === null || file.deletions === null) return CHANGESET_WORDS.binary;
  return `+${file.additions} −${file.deletions}`;
}

/**
 * Who else wrote a file this commit carries: "also edited by you" for the
 * person (D1, single user: every `human:` stamp is you), else "also edited by
 * <label>", the names joined with "and". Null when nobody else did; a commit
 * that did not record it (M92.12) says so, never that nobody did (CV-05).
 */
export function alsoByWords(
  actors: readonly string[] | null,
  label: (actor: string) => string,
): string | null {
  if (actors === null) return CHANGESET_WORDS.alsoByNotRecorded;
  if (actors.length === 0) return null;
  const names = actors.map((actor) => (actor.startsWith('human:') ? 'you' : label(actor)));
  const unique = [...new Set(names)];
  const joined =
    unique.length === 1
      ? unique[0]
      : `${unique.slice(0, -1).join(', ')} and ${unique[unique.length - 1]}`;
  return `also edited by ${joined}`;
}

/** The changeset list with `changeset` in place of the one for its run, or
 * added after the rest: a deferral's resume is a second run, so a second
 * entry. */
export function upsertChangeset(
  list: readonly RunChangeset[] | undefined,
  changeset: RunChangeset,
): RunChangeset[] {
  const current = list ?? [];
  const at = current.findIndex((c) => c.run_id === changeset.run_id);
  if (at === -1) return [...current, changeset];
  const next = current.slice();
  next[at] = changeset;
  return next;
}

const isString = (v: unknown): v is string => typeof v === 'string';
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every(isString);
const isCount = (v: unknown): v is number | null =>
  v === null || (Number.isSafeInteger(v) && (v as number) >= 0);
const KINDS: readonly string[] = ['added', 'modified', 'deleted', 'renamed'];

function isChangedFile(raw: unknown): raw is ChangedFile {
  if (typeof raw !== 'object' || raw === null) return false;
  const f = raw as Record<string, unknown>;
  return (
    isString(f.path) &&
    (f.previous_path === null || isString(f.previous_path)) &&
    isString(f.kind) &&
    KINDS.includes(f.kind) &&
    isCount(f.additions) &&
    isCount(f.deletions) &&
    isStrings(f.also_by)
  );
}

/** A stored changeset this build can render, in every field it reads. Only a
 *  run's own event is stored, which records every field: one with a field
 *  read back as not recorded (M92.12) is never stored, and is refused. */
export function isChangeset(raw: unknown): raw is RunChangeset {
  if (typeof raw !== 'object' || raw === null) return false;
  const c = raw as Record<string, unknown>;
  if (
    c.kept_out_of_git !== undefined &&
    (!Number.isSafeInteger(c.kept_out_of_git) || (c.kept_out_of_git as number) < 0)
  )
    return false;
  const shell = typeof c.shell_unrecorded === 'boolean';
  switch (c.state) {
    case 'committed':
      return (
        isString(c.run_id) &&
        isString(c.commit) &&
        /^[0-9a-f]{7,64}$/.test(c.commit) &&
        Array.isArray(c.files) &&
        c.files.every(isChangedFile) &&
        isCount(c.additions) &&
        isCount(c.deletions) &&
        Number.isSafeInteger(c.binary) &&
        shell
      );
    case 'nothing':
      return isString(c.run_id) && shell;
    case 'not_recorded':
      return (c.run_id === null || isString(c.run_id)) && isString(c.reason) && isStrings(c.files);
    case 'not_a_repo':
      return isString(c.run_id) && isStrings(c.files) && shell;
    case 'unavailable':
      return isString(c.run_id) && isString(c.reason) && isStrings(c.files) && shell;
    default:
      return false;
  }
}
