/**
 * Git types (M9.4). Mirrors the serde shapes in `src-tauri/src/git/`.
 *
 * The vault directory is frequently not the repository root, so every call
 * goes through a resolved workspace on the Rust side. The frontend never
 * constructs a path relative to the git root — it always speaks
 * vault-relative paths and lets the workspace translate.
 */

export type GitRootRelation = 'vault' | 'parent' | 'none';

export interface GitWorkspaceInfo {
  vaultRoot: string;
  gitRoot: string | null;
  vaultPathspec: string | null;
  gitRootRelation: GitRootRelation;
  resolutionFailure: string | null;
}

export type FileStatus =
  | 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked' | 'conflicted';

export interface ModifiedFile {
  path: string;
  status: FileStatus;
  staged: boolean;
}

export interface GitCommit {
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  /** Unix seconds. */
  date: number;
}

export interface PulseFile {
  path: string;
  status: string;
  title: string;
}

export interface PulseCommit extends GitCommit {
  files: PulseFile[];
  added: number;
  modified: number;
  deleted: number;
}

export interface LastCommitInfo {
  shortHash: string;
  message: string;
  date: number;
}

export type IdentitySource =
  | 'repository' | 'global' | 'system' | 'environment' | 'fallback' | 'unknown';

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
  | 'ok' | 'up_to_date' | 'updated' | 'conflict'
  | 'rejected' | 'auth_error' | 'network_error' | 'no_remote' | 'error';

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

/** Sync state for the topbar badge, derived rather than stored. */
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

/** One hunk line, classified for rendering. */
export interface DiffLine {
  kind: 'add' | 'del' | 'context' | 'meta' | 'hunk';
  text: string;
}

/**
 * Parse a unified diff into classified lines.
 *
 * Order matters: `---` and `+++` are file headers, not deletions and
 * additions, so they must be matched before the single-character checks or
 * every diff opens with a phantom removed line.
 */
export function parseDiff(diff: string): DiffLine[] {
  return diff.split('\n').map((text): DiffLine => {
    if (text.startsWith('@@')) return { kind: 'hunk', text };
    if (
      text.startsWith('diff ') ||
      text.startsWith('index ') ||
      text.startsWith('--- ') ||
      text.startsWith('+++ ') ||
      text.startsWith('new file') ||
      text.startsWith('deleted file') ||
      text.startsWith('similarity index') ||
      text.startsWith('rename ')
    ) {
      return { kind: 'meta', text };
    }
    if (text.startsWith('+')) return { kind: 'add', text };
    if (text.startsWith('-')) return { kind: 'del', text };
    return { kind: 'context', text };
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
