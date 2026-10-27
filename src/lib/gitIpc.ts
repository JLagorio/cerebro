import { guardMockLegacy, guardMockDestination } from './selectedMock';
/**
 * Git and read-only gh IPC facade. Same shape as `lib/ipc.ts`: inside Tauri these
 * invoke the Rust commands; in the browser (pnpm dev, vitest, Playwright)
 * they delegate to `mockGit.ts`. A browser branch may pass through `faulted`
 * (mockFaults.ts, M64.1), which fails it once when the state lab or a test
 * arms that command.
 *
 * The mock is not a convenience — without it every git-aware component would
 * throw the moment the vitest suite rendered it, and the whole surface would
 * be untestable outside a packaged build.
 */
import type {
  CommitQuery,
  CommitRun,
  ConflictMode,
  FileAt,
  FileCommit,
  FilePatch,
  GitAuthorIdentity,
  GitProviderStatus,
  GitRemoteStatus,
  GitWorkspaceInfo,
  LastCommitInfo,
  ModifiedFile,
  RemoteResult,
  Resolution,
  RestoreResult,
  VaultPulse,
} from '@/engine/git';
import type { ConversationChangesets } from '@/engine/changeset';
import { faulted } from './mockFaults';
import * as mock from './mockGit';

function inTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

async function invokeTauri<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
}

export function gitWorkspaceInfo(vault: string): Promise<GitWorkspaceInfo> {
  if (!inTauri()) {
    try {
      guardMockLegacy(vault, 'git_workspace_info');
    } catch (error) {
      return Promise.reject(error);
    }
  }

  return inTauri()
    ? invokeTauri('git_workspace_info', { vault })
    : faulted('git_workspace_info', () => mock.gitWorkspaceInfo(vault));
}

export function isGitRepo(vault: string): Promise<boolean> {
  if (!inTauri()) {
    try {
      guardMockLegacy(vault, 'is_git_repo');
    } catch (error) {
      return Promise.reject(error);
    }
  }

  return inTauri()
    ? invokeTauri('is_git_repo', { vault })
    : faulted('is_git_repo', () => mock.isGitRepo(vault));
}

export function initGitRepo(vault: string): Promise<void> {
  if (!inTauri()) {
    try {
      guardMockLegacy(vault, 'init_git_repo');
    } catch (error) {
      return Promise.reject(error);
    }
  }

  return inTauri() ? invokeTauri('init_git_repo', { vault }) : mock.initGitRepo(vault);
}

export function gitAuthorIdentity(vault: string): Promise<GitAuthorIdentity> {
  if (!inTauri()) {
    try {
      guardMockLegacy(vault, 'git_author_identity');
    } catch (error) {
      return Promise.reject(error);
    }
  }

  return inTauri() ? invokeTauri('git_author_identity', { vault }) : mock.gitAuthorIdentity(vault);
}

export function getModifiedFiles(vault: string): Promise<ModifiedFile[]> {
  if (!inTauri()) {
    try {
      guardMockLegacy(vault, 'get_modified_files');
    } catch (error) {
      return Promise.reject(error);
    }
  }

  return inTauri() ? invokeTauri('get_modified_files', { vault }) : mock.getModifiedFiles(vault);
}

export function gitDiscardFile(vault: string, path: string): Promise<void> {
  if (!inTauri()) {
    try {
      guardMockLegacy(vault, 'git_discard_file');
    } catch (error) {
      return Promise.reject(error);
    }
  }

  return inTauri()
    ? invokeTauri('git_discard_file', { vault, path })
    : mock.gitDiscardFile(vault, path);
}

/** One page's history, each commit with the path the page had in it (M58.4). */
export function getFileHistory(vault: string, path: string): Promise<FileCommit[]> {
  if (!inTauri()) {
    try {
      guardMockLegacy(vault, 'get_file_history');
    } catch (error) {
      return Promise.reject(error);
    }
  }

  return inTauri()
    ? invokeTauri('get_file_history', { vault, path })
    : mock.getFileHistory(vault, path);
}

/** One file as a commit held it, byte for byte (M58.4). */
export function getFileAtCommit(vault: string, path: string, commit: string): Promise<FileAt> {
  if (!inTauri()) {
    try {
      guardMockLegacy(vault, 'get_file_at_commit');
    } catch (error) {
      return Promise.reject(error);
    }
  }

  return inTauri()
    ? invokeTauri('get_file_at_commit', { vault, path, commit })
    : mock.getFileAtCommit(vault, path, commit);
}

/** Which recorded runs made these commits (M58.4, CV-35): a commit with no
 *  record is absent from the answer. */
export function commitRuns(vault: string, commits: CommitQuery[]): Promise<CommitRun[]> {
  if (!inTauri()) {
    try {
      guardMockLegacy(vault, 'commit_runs');
    } catch (error) {
      return Promise.reject(error);
    }
  }

  return inTauri()
    ? invokeTauri('commit_runs', { vault, commits })
    : mock.commitRuns(vault, commits);
}

/** What a conversation's runs changed, read back from Cerebro's records and
 *  git (M92.12): its session's ended runs in this vault, oldest first. */
export function conversationChanges(
  vault: string,
  sessionId: string,
): Promise<ConversationChangesets> {
  if (!inTauri()) {
    try {
      guardMockLegacy(vault, 'conversation_changes');
    } catch (error) {
      return Promise.reject(error);
    }
  }

  return inTauri()
    ? invokeTauri('conversation_changes', { vault, sessionId })
    : faulted('conversation_changes', () => mock.conversationChanges(vault, sessionId));
}

/** Restore a page to one version from its history, as the person (M58.4). */
export function restoreNoteVersion(
  vault: string,
  path: string,
  commit: string,
): Promise<RestoreResult> {
  if (!inTauri()) {
    try {
      guardMockLegacy(vault, 'restore_note_version');
    } catch (error) {
      return Promise.reject(error);
    }
  }

  return inTauri()
    ? invokeTauri('restore_note_version', { vault, path, commit })
    : mock.restoreNoteVersion(vault, path, commit);
}

export function getFileDiff(vault: string, path: string): Promise<string> {
  if (!inTauri()) {
    try {
      guardMockLegacy(vault, 'get_file_diff');
    } catch (error) {
      return Promise.reject(error);
    }
  }

  return inTauri() ? invokeTauri('get_file_diff', { vault, path }) : mock.getFileDiff(vault, path);
}

/** What one commit did to one file; `previousPath` reads a rename as one (M58.4). */
export function getFileDiffAtCommit(
  vault: string,
  path: string,
  commit: string,
  previousPath: string | null = null,
): Promise<string> {
  if (!inTauri()) {
    try {
      guardMockLegacy(vault, 'get_file_diff_at_commit');
    } catch (error) {
      return Promise.reject(error);
    }
  }

  return inTauri()
    ? invokeTauri('get_file_diff_at_commit', { vault, path, commit, previousPath })
    : mock.getFileDiffAtCommit(vault, path, commit, previousPath);
}

/** One file's patch in one commit, capped at 2 MiB (M58.3). */
export function getFilePatch(vault: string, path: string, commit: string): Promise<FilePatch> {
  if (!inTauri()) {
    try {
      guardMockLegacy(vault, 'get_file_patch');
    } catch (error) {
      return Promise.reject(error);
    }
  }

  return inTauri()
    ? invokeTauri('get_file_patch', { vault, path, commit })
    : mock.getFilePatch(vault, path, commit);
}

export function getCommitDiff(vault: string, commit: string): Promise<string> {
  if (!inTauri()) {
    try {
      guardMockLegacy(vault, 'get_commit_diff');
    } catch (error) {
      return Promise.reject(error);
    }
  }

  return inTauri()
    ? invokeTauri('get_commit_diff', { vault, commit })
    : mock.getCommitDiff(vault, commit);
}

export function getVaultPulse(vault: string): Promise<VaultPulse> {
  if (!inTauri()) {
    try {
      guardMockLegacy(vault, 'get_vault_pulse');
    } catch (error) {
      return Promise.reject(error);
    }
  }

  return inTauri() ? invokeTauri('get_vault_pulse', { vault }) : mock.getVaultPulse(vault);
}

export function getLastCommitInfo(vault: string): Promise<LastCommitInfo | null> {
  if (!inTauri()) {
    try {
      guardMockLegacy(vault, 'get_last_commit_info');
    } catch (error) {
      return Promise.reject(error);
    }
  }

  return inTauri() ? invokeTauri('get_last_commit_info', { vault }) : mock.getLastCommitInfo(vault);
}

export function gitCommit(vault: string, message: string): Promise<string | null> {
  if (!inTauri()) {
    try {
      guardMockLegacy(vault, 'git_commit');
    } catch (error) {
      return Promise.reject(error);
    }
  }

  return inTauri() ? invokeTauri('git_commit', { vault, message }) : mock.gitCommit(vault, message);
}

export function gitHasPendingChanges(vault: string): Promise<boolean> {
  if (!inTauri()) {
    try {
      guardMockLegacy(vault, 'git_has_pending_changes');
    } catch (error) {
      return Promise.reject(error);
    }
  }

  return inTauri()
    ? invokeTauri('git_has_pending_changes', { vault })
    : mock.gitHasPendingChanges(vault);
}

export function gitFileUrl(vault: string, path: string): Promise<string | null> {
  if (!inTauri()) {
    try {
      guardMockLegacy(vault, 'git_file_url');
    } catch (error) {
      return Promise.reject(error);
    }
  }

  return inTauri() ? invokeTauri('git_file_url', { vault, path }) : mock.gitFileUrl(vault, path);
}

export function gitRemoteStatus(vault: string): Promise<GitRemoteStatus> {
  if (!inTauri()) {
    try {
      guardMockLegacy(vault, 'git_remote_status');
    } catch (error) {
      return Promise.reject(error);
    }
  }

  return inTauri()
    ? invokeTauri('git_remote_status', { vault })
    : faulted('git_remote_status', () => mock.gitRemoteStatus(vault));
}

export function gitPull(vault: string): Promise<RemoteResult> {
  if (!inTauri()) {
    try {
      guardMockLegacy(vault, 'git_pull');
    } catch (error) {
      return Promise.reject(error);
    }
  }

  return inTauri() ? invokeTauri('git_pull', { vault }) : mock.gitPull(vault);
}

export function gitPush(vault: string): Promise<RemoteResult> {
  if (!inTauri()) {
    try {
      guardMockLegacy(vault, 'git_push');
    } catch (error) {
      return Promise.reject(error);
    }
  }

  return inTauri() ? invokeTauri('git_push', { vault }) : mock.gitPush(vault);
}

export function gitAddRemote(vault: string, url: string): Promise<RemoteResult> {
  if (!inTauri()) {
    try {
      guardMockLegacy(vault, 'git_add_remote');
    } catch (error) {
      return Promise.reject(error);
    }
  }

  return inTauri() ? invokeTauri('git_add_remote', { vault, url }) : mock.gitAddRemote(vault, url);
}

export function gitDisconnectRemote(vault: string): Promise<void> {
  if (!inTauri()) {
    try {
      guardMockLegacy(vault, 'git_disconnect_remote');
    } catch (error) {
      return Promise.reject(error);
    }
  }

  return inTauri()
    ? invokeTauri('git_disconnect_remote', { vault })
    : mock.gitDisconnectRemote(vault);
}

export function gitClone(url: string, destination: string): Promise<string> {
  if (!inTauri()) {
    try {
      guardMockDestination(destination);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  return inTauri()
    ? invokeTauri('git_clone', { url, destination })
    : mock.gitClone(url, destination);
}

export function getConflictFiles(vault: string): Promise<string[]> {
  if (!inTauri()) {
    try {
      guardMockLegacy(vault, 'get_conflict_files');
    } catch (error) {
      return Promise.reject(error);
    }
  }

  return inTauri() ? invokeTauri('get_conflict_files', { vault }) : mock.getConflictFiles(vault);
}

export function getConflictMode(vault: string): Promise<ConflictMode> {
  if (!inTauri()) {
    try {
      guardMockLegacy(vault, 'get_conflict_mode');
    } catch (error) {
      return Promise.reject(error);
    }
  }

  return inTauri() ? invokeTauri('get_conflict_mode', { vault }) : mock.getConflictMode(vault);
}

export function gitResolveConflict(vault: string, path: string, keep: Resolution): Promise<void> {
  if (!inTauri()) {
    try {
      guardMockLegacy(vault, 'git_resolve_conflict');
    } catch (error) {
      return Promise.reject(error);
    }
  }

  return inTauri()
    ? invokeTauri('git_resolve_conflict', { vault, path, keep })
    : mock.gitResolveConflict(vault, path, keep);
}

export function gitCommitConflictResolution(vault: string): Promise<string> {
  if (!inTauri()) {
    try {
      guardMockLegacy(vault, 'git_commit_conflict_resolution');
    } catch (error) {
      return Promise.reject(error);
    }
  }

  return inTauri()
    ? invokeTauri('git_commit_conflict_resolution', { vault })
    : mock.gitCommitConflictResolution(vault);
}

export function gitAbortConflict(vault: string): Promise<void> {
  if (!inTauri()) {
    try {
      guardMockLegacy(vault, 'git_abort_conflict');
    } catch (error) {
      return Promise.reject(error);
    }
  }

  return inTauri() ? invokeTauri('git_abort_conflict', { vault }) : mock.gitAbortConflict(vault);
}

export function gitProviderStatus(): Promise<GitProviderStatus> {
  return inTauri() ? invokeTauri('git_provider_status') : mock.gitProviderStatus();
}

/** Read-only GitHub state through the owner's gh login; never enters the vault. */
export function pullRequestState(
  url: string,
  refresh = false,
): Promise<import('@/engine/pullRequest').PrRead> {
  return inTauri()
    ? invokeTauri('pull_request_state', { url, refresh })
    : mock.pullRequestState(url, refresh);
}
