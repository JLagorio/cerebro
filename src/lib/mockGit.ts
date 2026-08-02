/**
 * In-memory git backend for the browser, vitest, and Playwright (M9.4).
 *
 * Mirrors the Rust command surface closely enough that every git-aware
 * component renders and behaves outside a packaged build. It models a small
 * repository: a commit log, a working tree of pending changes, and a remote
 * whose behaviour tests can steer through `__cerebroMockGit`.
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

interface MockState {
  isRepo: boolean;
  commits: PulseCommit[];
  modified: ModifiedFile[];
  conflicts: string[];
  conflictMode: ConflictMode;
  remoteUrl: string | null;
  ahead: number;
  behind: number;
  branch: string;
  /** Force the next remote call to fail a particular way. */
  nextRemoteFailure: RemoteResult | null;
  diffs: Record<string, string>;
}

function seed(): MockState {
  return {
    isRepo: true,
    commits: [
      {
        hash: 'c2c2c2c2',
        shortHash: 'c2c2c2c',
        message: 'Distil onboarding drop-off from the support thread',
        author: 'Cerebro',
        date: 1_753_800_000,
        files: [
          {
            path: 'knowledge/onboarding-drop-off.md',
            status: 'modified',
            title: 'Onboarding Drop Off',
          },
        ],
        added: 0,
        modified: 1,
        deleted: 0,
      },
      {
        hash: 'c1c1c1c1',
        shortHash: 'c1c1c1c',
        message: 'Start tracking this vault with cerebro',
        author: 'Ana Rios',
        date: 1_753_700_000,
        files: [{ path: 'projects/atlas/project.md', status: 'added', title: 'Project' }],
        added: 1,
        modified: 0,
        deleted: 0,
      },
    ],
    modified: [],
    conflicts: [],
    conflictMode: 'none',
    remoteUrl: null,
    ahead: 0,
    behind: 0,
    branch: 'main',
    nextRemoteFailure: null,
    diffs: {},
  };
}

declare global {
  interface Window {
    __cerebroMockGit?: MockState;
  }
}

// Hung off `window` when there is one (so Playwright can steer it from the
// page) and off a module local otherwise — node-side vitest has no window.
let nodeState: MockState | null = null;

function state(): MockState {
  if (typeof window === 'undefined') {
    nodeState ??= seed();
    return nodeState;
  }
  window.__cerebroMockGit ??= seed();
  return window.__cerebroMockGit;
}

/** Test hook: reset to the seeded repository. */
export function resetMockGit(patch: Partial<MockState> = {}): MockState {
  const next = { ...seed(), ...patch };
  if (typeof window === 'undefined') {
    nodeState = next;
  } else {
    window.__cerebroMockGit = next;
  }
  return next;
}

const DEFAULT_DIFF = [
  'diff --git a/note.md b/note.md',
  'index 1111111..2222222 100644',
  '--- a/note.md',
  '+++ b/note.md',
  '@@ -1,4 +1,5 @@',
  ' # Onboarding drop-off',
  ' ',
  '-Completion sits at 51%.',
  '+Completion sits at 73%, up from 51% at baseline.',
  '+Support contacts fell alongside it.',
].join('\n');

export async function gitWorkspaceInfo(vault: string): Promise<GitWorkspaceInfo> {
  const s = state();
  return {
    vaultRoot: vault,
    gitRoot: s.isRepo ? vault : null,
    vaultPathspec: null,
    gitRootRelation: s.isRepo ? 'vault' : 'none',
    resolutionFailure: null,
  };
}

export async function isGitRepo(_vault: string): Promise<boolean> {
  return state().isRepo;
}

export async function initGitRepo(_vault: string): Promise<void> {
  const s = state();
  s.isRepo = true;
  if (s.commits.length === 0) {
    s.commits = seed().commits.slice(1);
  }
}

export async function gitAuthorIdentity(_vault: string): Promise<GitAuthorIdentity> {
  return { name: 'Ana Rios', email: 'ana@example.com', source: 'global', warning: null };
}

export async function getModifiedFiles(_vault: string): Promise<ModifiedFile[]> {
  return [...state().modified];
}

export async function gitDiscardFile(_vault: string, path: string): Promise<void> {
  const s = state();
  s.modified = s.modified.filter((f) => f.path !== path);
}

export async function getFileHistory(_vault: string, path: string): Promise<GitCommit[]> {
  return state()
    .commits.filter((c) => c.files.some((f) => f.path === path))
    .map(({ files: _f, added: _a, modified: _m, deleted: _d, ...commit }) => commit);
}

export async function getFileDiff(_vault: string, path: string): Promise<string> {
  return state().diffs[path] ?? DEFAULT_DIFF;
}

export async function getFileDiffAtCommit(
  _vault: string,
  _path: string,
  _commit: string,
): Promise<string> {
  return DEFAULT_DIFF;
}

export async function getCommitDiff(_vault: string, _commit: string): Promise<string> {
  return DEFAULT_DIFF;
}

export async function getVaultPulse(_vault: string): Promise<PulseCommit[]> {
  return [...state().commits];
}

export async function getLastCommitInfo(_vault: string): Promise<LastCommitInfo | null> {
  const [head] = state().commits;
  if (head === undefined) return null;
  return { shortHash: head.shortHash, message: head.message, date: head.date };
}

export async function gitCommit(_vault: string, message: string): Promise<string | null> {
  const s = state();
  if (s.modified.length === 0) return null;
  const hash = `m${s.commits.length + 1}`.padEnd(7, '0');
  s.commits = [
    {
      hash,
      shortHash: hash,
      message,
      author: 'Ana Rios',
      date: Math.floor(Date.now() / 1000),
      files: s.modified.map((f) => ({
        path: f.path,
        status: f.status,
        title: f.path.split('/').pop() ?? f.path,
      })),
      added: s.modified.filter((f) => f.status === 'added' || f.status === 'untracked').length,
      modified: s.modified.filter((f) => f.status === 'modified').length,
      deleted: s.modified.filter((f) => f.status === 'deleted').length,
    },
    ...s.commits,
  ];
  s.modified = [];
  s.ahead += 1;
  return hash;
}

export async function gitHasPendingChanges(_vault: string): Promise<boolean> {
  return state().modified.length > 0;
}

export async function gitFileUrl(_vault: string, path: string): Promise<string | null> {
  const s = state();
  if (s.remoteUrl === null) return null;
  return `https://github.com/acme/notes/blob/${s.branch}/${path}`;
}

export async function gitRemoteStatus(_vault: string): Promise<GitRemoteStatus> {
  const s = state();
  return {
    branch: s.branch,
    ahead: s.ahead,
    behind: s.behind,
    hasRemote: s.remoteUrl !== null,
    hasUpstream: s.remoteUrl !== null,
    upstream: s.remoteUrl === null ? null : `origin/${s.branch}`,
  };
}

function takeFailure(): RemoteResult | null {
  const s = state();
  const failure = s.nextRemoteFailure;
  s.nextRemoteFailure = null;
  return failure;
}

export async function gitPull(_vault: string): Promise<RemoteResult> {
  const forced = takeFailure();
  if (forced !== null) return forced;
  const s = state();
  if (s.remoteUrl === null) {
    return {
      status: 'no_remote',
      message: 'No remote is configured.',
      updatedFiles: [],
      conflictFiles: [],
    };
  }
  if (s.behind === 0) {
    return {
      status: 'up_to_date',
      message: 'Already up to date.',
      updatedFiles: [],
      conflictFiles: [],
    };
  }
  s.behind = 0;
  return {
    status: 'updated',
    message: 'Updated from origin.',
    updatedFiles: ['projects/atlas/project.md'],
    conflictFiles: [],
  };
}

export async function gitPush(_vault: string): Promise<RemoteResult> {
  const forced = takeFailure();
  if (forced !== null) return forced;
  const s = state();
  if (s.remoteUrl === null) {
    return {
      status: 'no_remote',
      message: 'No remote is configured.',
      updatedFiles: [],
      conflictFiles: [],
    };
  }
  if (s.behind > 0) {
    return {
      status: 'rejected',
      message: "The remote has commits you don't. Pull before pushing.",
      updatedFiles: [],
      conflictFiles: [],
    };
  }
  s.ahead = 0;
  return { status: 'ok', message: 'Pushed.', updatedFiles: [], conflictFiles: [] };
}

export async function gitAddRemote(_vault: string, url: string): Promise<RemoteResult> {
  const s = state();
  if (s.remoteUrl !== null) {
    return {
      status: 'error',
      message: 'A remote is already configured. Disconnect it first.',
      updatedFiles: [],
      conflictFiles: [],
    };
  }
  const allowed = /^(https?:\/\/|ssh:\/\/|git@)/.test(url.trim());
  if (!allowed) {
    return {
      status: 'error',
      message: 'Use an https:// or ssh remote URL.',
      updatedFiles: [],
      conflictFiles: [],
    };
  }
  s.remoteUrl = url.trim();
  return { status: 'ok', message: 'Remote connected.', updatedFiles: [], conflictFiles: [] };
}

export async function gitDisconnectRemote(_vault: string): Promise<void> {
  state().remoteUrl = null;
}

export async function gitClone(_url: string, destination: string): Promise<string> {
  return destination;
}

export async function getConflictFiles(_vault: string): Promise<string[]> {
  return [...state().conflicts];
}

export async function getConflictMode(_vault: string): Promise<ConflictMode> {
  return state().conflictMode;
}

export async function gitResolveConflict(
  _vault: string,
  path: string,
  _keep: Resolution,
): Promise<void> {
  const s = state();
  s.conflicts = s.conflicts.filter((p) => p !== path);
}

export async function gitCommitConflictResolution(_vault: string): Promise<string> {
  const s = state();
  if (s.conflicts.length > 0) {
    throw new Error(`${s.conflicts.length} files still conflicted`);
  }
  s.conflictMode = 'none';
  return 'resolved';
}

export async function gitAbortConflict(_vault: string): Promise<void> {
  const s = state();
  s.conflicts = [];
  s.conflictMode = 'none';
}

export async function gitProviderStatus(): Promise<GitProviderStatus> {
  return {
    selectedProvider: 'native',
    native: {
      provider: 'native',
      label: 'System git',
      available: true,
      version: 'git version 2.39.5',
      path: '/usr/bin/git',
      message: 'Ready.',
    },
    distributions: [],
  };
}
