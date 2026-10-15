/**
 * Git types (M9.4). Mirrors the serde shapes in `src-tauri/src/git/`.
 *
 * The vault directory is frequently not the repository root, so every call
 * goes through a resolved workspace on the Rust side. The frontend never
 * constructs a path relative to the git root — it always speaks
 * vault-relative paths and lets the workspace translate.
 */
import { isKnowledgePath } from './okf';

export type GitRootRelation = 'vault' | 'parent' | 'none';

export interface GitWorkspaceInfo {
  vaultRoot: string;
  gitRoot: string | null;
  vaultPathspec: string | null;
  gitRootRelation: GitRootRelation;
  resolutionFailure: string | null;
}

export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked' | 'conflicted';

/** The live run a changed path waits for (M58.3): a checkpoint leaves the
 * path alone, and the run's own commit takes it when the run ends. */
export interface PathOwner {
  runId: string;
  actor: string;
}

export interface ModifiedFile {
  path: string;
  status: FileStatus;
  staged: boolean;
  /** Null, or absent from a reader that does not know runs, for a path no
   * live run wrote. */
  owner?: PathOwner | null;
}

/** One file's patch in one commit (M58.3): at most 2 MiB of it, `truncated`
 * when the cap cut it; a binary file carries no text. */
export interface FilePatch {
  text: string;
  truncated: boolean;
  binary: boolean;
}

export interface GitCommit {
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  /** Unix seconds. */
  date: number;
}

/** What one commit did to one file (M58.4): git's name-status letter. */
export type FileChange = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'type_changed';

/**
 * One commit in one page's history (M58.4, history.rs `FileCommit`). `pathAt`
 * is the path the page had in that commit, null when it lay outside the
 * vault; `previousPath` the path before a rename; `previousAt` when the page
 * was committed before, as runtime.db spells a time, null when this commit
 * created it; `change` null for a merge.
 */
export interface FileCommit extends GitCommit {
  parent: string | null;
  previousAt: string | null;
  pathAt: string | null;
  previousPath: string | null;
  change: FileChange | null;
}

/** One file as a commit held it (M58.4, history.rs `FileAt`). */
export type FileAt =
  | { kind: 'text'; text: string }
  | { kind: 'absent' }
  | { kind: 'binary' }
  | { kind: 'too_large'; bytes: number };

/** One commit an attribution read asks about (fleet.rs `CommitQuery`). */
export interface CommitQuery {
  hash: string;
  path: string | null;
  since: string | null;
}

/**
 * The run that made one commit, as runtime.db's commit record says (M58.4,
 * fleet.rs `CommitRun`, CV-35). A commit with no record is absent from the
 * answer. `with_person` is null when no path was asked.
 */
export interface CommitRun {
  hash: string;
  run_id: string;
  actor: string | null;
  with_person: boolean | null;
  also_by: string[];
}

/** What a Restore did (restore.rs `Restored`). */
export interface RestoreResult {
  unchanged: boolean;
  /** The "Before restoring" commit, when the page held changes not in history. */
  before: string | null;
  /** The "Restore …" commit. */
  restored: string | null;
  /** Why the Restore commit failed; the page is restored all the same. */
  commitError: string | null;
}

export const RESTORE_KNOWLEDGE =
  'Concepts change only through Knowledge, so a version of one is not restored here.';
export const RESTORE_OUTSIDE = 'That version of the page is outside this vault.';
export const RESTORE_REMOVED = 'That version removed the page, so there is nothing to restore.';
export const RESTORE_NOT_TEXT = "That version is not text, so it can't be restored here.";
export const RESTORE_TOO_LARGE = 'That version is too large to restore here.';

/**
 * Why Restore is not offered for `commit` of `path`, or null when it may be
 * (M58.4): a concept under knowledge/, a version outside the vault, one that
 * removed the page, or one that is not text. `after` is the version as read,
 * null while unread. The words are restore.rs's own, where it has them.
 */
export function restoreBlock(
  path: string,
  commit: FileCommit,
  after: FileAt | null,
): string | null {
  if (isKnowledgePath(path)) return RESTORE_KNOWLEDGE;
  if (commit.pathAt === null) return RESTORE_OUTSIDE;
  if (commit.change === 'deleted' || after?.kind === 'absent') return RESTORE_REMOVED;
  if (after?.kind === 'binary') return RESTORE_NOT_TEXT;
  if (after?.kind === 'too_large') return RESTORE_TOO_LARGE;
  return null;
}

export interface PulseFile {
  path: string;
  status: string;
  title: string;
}

/** What one commit did inside the vault. */
export interface PulseChanges {
  files: PulseFile[];
  added: number;
  modified: number;
  deleted: number;
}

export interface PulseCommit extends GitCommit {
  /** `null` when the file list could not be read. Never an empty list: that
   * would say the commit touched nothing, which nobody measured. */
  changes: PulseChanges | null;
}

/**
 * The vault's history (M53.15). `tracked: false` is a vault that is not a
 * repository; `tracked: true` with no commits is one nobody has committed to
 * yet. A log that failed is a rejected read, never either of these.
 */
export interface VaultPulse {
  tracked: boolean;
  commits: PulseCommit[];
}

export interface LastCommitInfo {
  shortHash: string;
  message: string;
  date: number;
}

export type IdentitySource =
  'repository' | 'global' | 'system' | 'environment' | 'fallback' | 'unknown';

export interface GitAuthorIdentity {
  name: string;
  email: string;
  source: IdentitySource;
  warning: string | null;
}

export interface GitRemoteStatus {
  branch: string;
  ahead: number;
  behind: number;
  hasRemote: boolean;
  hasUpstream: boolean;
  upstream: string | null;
}

/**
 * Why a network operation ended. The distinction is the point: auth means
 * "fix your credentials", network means "try again", rejected means "pull
 * first". Collapsing them makes all three unfixable.
 */
export type RemoteOutcome =
  | 'ok'
  | 'up_to_date'
  | 'updated'
  | 'conflict'
  | 'rejected'
  | 'auth_error'
  | 'network_error'
  | 'no_remote'
  | 'error';

export interface RemoteResult {
  status: RemoteOutcome;
  message: string;
  updatedFiles: string[];
  conflictFiles: string[];
}

export type ConflictMode = 'merge' | 'rebase' | 'none';
export type Resolution = 'ours' | 'theirs';

export interface GitProviderProbe {
  provider: string;
  label: string;
  available: boolean;
  version: string | null;
  path: string | null;
  message: string;
}

export interface GitProviderStatus {
  selectedProvider: string;
  native: GitProviderProbe;
  distributions: GitProviderProbe[];
}

/** Did the operation change anything the user should be told about? */
export function isFailure(result: RemoteResult): boolean {
  return (
    result.status === 'error' ||
    result.status === 'auth_error' ||
    result.status === 'network_error' ||
    result.status === 'rejected'
  );
}

/** Sync state for the shell SyncBadge, derived rather than stored. */
export type SyncState = 'clean' | 'local-changes' | 'ahead' | 'behind' | 'diverged' | 'conflict';

export function syncState(
  remote: GitRemoteStatus | null,
  modifiedCount: number,
  conflictCount: number,
): SyncState {
  if (conflictCount > 0) return 'conflict';
  if (modifiedCount > 0) return 'local-changes';
  if (remote === null) return 'clean';
  if (remote.ahead > 0 && remote.behind > 0) return 'diverged';
  if (remote.ahead > 0) return 'ahead';
  if (remote.behind > 0) return 'behind';
  return 'clean';
}

/**
 * One diff line, classified for rendering, with the line numbers it has in
 * the file before and after the change (M58.5): a context line has both, a
 * removed line only `oldLine`, an added line only `newLine`, and a header,
 * a hunk line or a line outside any hunk neither.
 */
export interface DiffLine {
  kind: 'add' | 'del' | 'context' | 'meta' | 'hunk';
  text: string;
  oldLine: number | null;
  newLine: number | null;
}

/** `@@ -a[,b] +c[,d] @@`: a count left out is one line. */
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

const META_PREFIXES = [
  'diff ',
  'index ',
  '--- ',
  '+++ ',
  'new file',
  'deleted file',
  'similarity index',
  'rename ',
];

/**
 * Parse a unified diff into classified, numbered lines.
 *
 * Order matters: `---` and `+++` are file headers, not deletions and
 * additions, so they must be matched before the single-character checks or
 * every diff opens with a phantom removed line. Inside a hunk, while its
 * counts last, the first character decides instead, so a removed line that
 * reads `-- x` is still a removed line.
 *
 * Numbers come from each `@@ -a,b +c,d @@` header: a context line takes the
 * next old and new numbers, a removed line the next old one, an added line
 * the next new one, and only while the hunk's counts last. Git's
 * `\ No newline at end of file` is meta, never a numbered line. A line
 * outside a hunk, the trailing empty line included, gets no number, and
 * `diff --git` starts a new file's count.
 */
export function parseDiff(diff: string): DiffLine[] {
  let nextOld = 0;
  let nextNew = 0;
  let oldLeft = 0;
  let newLeft = 0;
  const line = (
    kind: DiffLine['kind'],
    text: string,
    oldLine = null as number | null,
    newLine = null as number | null,
  ): DiffLine => ({
    kind,
    text,
    oldLine,
    newLine,
  });
  return diff.split('\n').map((text): DiffLine => {
    if (text.startsWith('@@')) {
      const header = HUNK_HEADER.exec(text);
      nextOld = header === null ? 0 : Number(header[1]);
      oldLeft = header === null ? 0 : header[2] === undefined ? 1 : Number(header[2]);
      nextNew = header === null ? 0 : Number(header[3]);
      newLeft = header === null ? 0 : header[4] === undefined ? 1 : Number(header[4]);
      return line('hunk', text);
    }
    if (text.startsWith('\\')) return line('meta', text);
    const inHunk = oldLeft > 0 || newLeft > 0;
    if (inHunk && text.startsWith('-') && oldLeft > 0) {
      oldLeft -= 1;
      return line('del', text, nextOld++);
    }
    if (inHunk && text.startsWith('+') && newLeft > 0) {
      newLeft -= 1;
      return line('add', text, null, nextNew++);
    }
    if (inHunk && (text.startsWith(' ') || text === '') && oldLeft > 0 && newLeft > 0) {
      oldLeft -= 1;
      newLeft -= 1;
      return line('context', text, nextOld++, nextNew++);
    }
    if (text.startsWith('diff ')) {
      oldLeft = 0;
      newLeft = 0;
    }
    if (META_PREFIXES.some((prefix) => text.startsWith(prefix))) return line('meta', text);
    if (text.startsWith('+')) return line('add', text);
    if (text.startsWith('-')) return line('del', text);
    return line('context', text);
  });
}

/** Added/removed counts for a diff summary. */
export function diffStats(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of parseDiff(diff)) {
    if (line.kind === 'add') added += 1;
    if (line.kind === 'del') removed += 1;
  }
  return { added, removed };
}
