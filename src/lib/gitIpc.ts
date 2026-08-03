/**
 * Git IPC facade (M9.4). Same shape as `lib/ipc.ts`: inside Tauri these
 * invoke the Rust commands; in the browser (pnpm dev, vitest, Playwright)
 * they delegate to `mockGit.ts`.
 *
 * The mock is not a convenience — without it every git-aware component would
 * throw the moment the vitest suite rendered it, and the whole surface would
 * be untestable outside a packaged build.
 */
import type {
  ConflictMode,
  GitAuthorIdentity,
  GitCommit,
  GitProviderStatus,
  GitRemoteStatus,
  GitWorkspaceInfo,
  LastCommitInfo,
  ModifiedFile,
  PulseCommit,
  RemoteResult,
  Resolution,
} from '@/engine/git';
import * as mock from './mockGit';

function inTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

async function invokeTauri<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
}

export function gitWorkspaceInfo(vault: string): Promise<GitWorkspaceInfo> {
  return inTauri() ? invokeTauri('git_workspace_info', { vault }) : mock.gitWorkspaceInfo(vault);
}

export function isGitRepo(vault: string): Promise<boolean> {
  return inTauri() ? invokeTauri('is_git_repo', { vault }) : mock.isGitRepo(vault);
}

export function initGitRepo(vault: string): Promise<void> {
  return inTauri() ? invokeTauri('init_git_repo', { vault }) : mock.initGitRepo(vault);
}

export function gitAuthorIdentity(vault: string): Promise<GitAuthorIdentity> {
  return inTauri() ? invokeTauri('git_author_identity', { vault }) : mock.gitAuthorIdentity(vault);
}

export function getModifiedFiles(vault: string): Promise<ModifiedFile[]> {
  return inTauri() ? invokeTauri('get_modified_files', { vault }) : mock.getModifiedFiles(vault);
}

export function gitDiscardFile(vault: string, path: string): Promise<void> {
  return inTauri()
    ? invokeTauri('git_discard_file', { vault, path })
    : mock.gitDiscardFile(vault, path);
}

export function getFileHistory(vault: string, path: string): Promise<GitCommit[]> {
  return inTauri()
    ? invokeTauri('get_file_history', { vault, path })
    : mock.getFileHistory(vault, path);
}

export function getFileDiff(vault: string, path: string): Promise<string> {
  return inTauri() ? invokeTauri('get_file_diff', { vault, path }) : mock.getFileDiff(vault, path);
}

export function getFileDiffAtCommit(vault: string, path: string, commit: string): Promise<string> {
  return inTauri()
    ? invokeTauri('get_file_diff_at_commit', { vault, path, commit })
    : mock.getFileDiffAtCommit(vault, path, commit);
}

export function getCommitDiff(vault: string, commit: string): Promise<string> {
  return inTauri()
    ? invokeTauri('get_commit_diff', { vault, commit })
    : mock.getCommitDiff(vault, commit);
}

export function getVaultPulse(vault: string): Promise<PulseCommit[]> {
  return inTauri() ? invokeTauri('get_vault_pulse', { vault }) : mock.getVaultPulse(vault);
}

export function getLastCommitInfo(vault: string): Promise<LastCommitInfo | null> {
  return inTauri() ? invokeTauri('get_last_commit_info', { vault }) : mock.getLastCommitInfo(vault);
}

export function gitCommit(vault: string, message: string): Promise<string | null> {
  return inTauri() ? invokeTauri('git_commit', { vault, message }) : mock.gitCommit(vault, message);
}

export function gitHasPendingChanges(vault: string): Promise<boolean> {
  return inTauri()
    ? invokeTauri('git_has_pending_changes', { vault })
    : mock.gitHasPendingChanges(vault);
}

export function gitFileUrl(vault: string, path: string): Promise<string | null> {
  return inTauri() ? invokeTauri('git_file_url', { vault, path }) : mock.gitFileUrl(vault, path);
}

export function gitRemoteStatus(vault: string): Promise<GitRemoteStatus> {
  return inTauri() ? invokeTauri('git_remote_status', { vault }) : mock.gitRemoteStatus(vault);
}

export function gitPull(vault: string): Promise<RemoteResult> {
  return inTauri() ? invokeTauri('git_pull', { vault }) : mock.gitPull(vault);
}

export function gitPush(vault: string): Promise<RemoteResult> {
  return inTauri() ? invokeTauri('git_push', { vault }) : mock.gitPush(vault);
}

export function gitAddRemote(vault: string, url: string): Promise<RemoteResult> {
  return inTauri() ? invokeTauri('git_add_remote', { vault, url }) : mock.gitAddRemote(vault, url);
}

export function gitDisconnectRemote(vault: string): Promise<void> {
  return inTauri()
    ? invokeTauri('git_disconnect_remote', { vault })
    : mock.gitDisconnectRemote(vault);
}

export function gitClone(url: string, destination: string): Promise<string> {
  return inTauri()
    ? invokeTauri('git_clone', { url, destination })
    : mock.gitClone(url, destination);
}

export function getConflictFiles(vault: string): Promise<string[]> {
  return inTauri() ? invokeTauri('get_conflict_files', { vault }) : mock.getConflictFiles(vault);
}

export function getConflictMode(vault: string): Promise<ConflictMode> {
  return inTauri() ? invokeTauri('get_conflict_mode', { vault }) : mock.getConflictMode(vault);
}

export function gitResolveConflict(vault: string, path: string, keep: Resolution): Promise<void> {
  return inTauri()
    ? invokeTauri('git_resolve_conflict', { vault, path, keep })
    : mock.gitResolveConflict(vault, path, keep);
}

export function gitCommitConflictResolution(vault: string): Promise<string> {
  return inTauri()
    ? invokeTauri('git_commit_conflict_resolution', { vault })
    : mock.gitCommitConflictResolution(vault);
}

export function gitAbortConflict(vault: string): Promise<void> {
  return inTauri() ? invokeTauri('git_abort_conflict', { vault }) : mock.gitAbortConflict(vault);
}

export function gitProviderStatus(): Promise<GitProviderStatus> {
  return inTauri() ? invokeTauri('git_provider_status') : mock.gitProviderStatus();
}
