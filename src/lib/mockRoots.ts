/**
 * In-memory roots backend for browser dev, vitest and Playwright.
 *
 * PARITY IS THE POINT. AGENTS.md makes mock/Rust parity a hard rule for the
 * knowledge guards, and the same reasoning applies here: a mock that permits a
 * traversal the Rust side refuses would make the Playwright suite prove the
 * opposite of the invariant. Every guard in `roots/read.rs` is mirrored below.
 */
import type {
  GitRemoteStatus,
  GitWorkspaceInfo,
  ModifiedFile,
  PulseCommit,
  RemoteResult,
  VaultPulse,
} from '@/engine/git';
import type { DirEntry, FileText, MountRefusal, Root, RootGitRefusal } from '@/engine/roots';
import { DIVERGED_MESSAGE } from '@/engine/roots';
import { VAULT_ROOT } from '@/engine/fileBytes';
import { mockVaultFiles } from './mockIpc';
import { byteEntries, readText } from './mockBytes';
import { probeFile } from './mockBytes';
import { isFileRefusal } from '@/engine/fileBytes';
import { DESKTOP_ONLY, type FileActionResult } from '@/engine/fileActions';
import type { Thumbnail } from '@/engine/thumbs';
import { resolveBytes } from './mockBytes';

/** A browser can prove containment/refusals, but never pretends to open the desktop. */
export async function fileAction(rootId: string, path: string): Promise<FileActionResult> {
  const probe = await probeFile(rootId, path);
  return isFileRefusal(probe) ? probe : { ...DESKTOP_ONLY };
}

export const MAX_BYTES = 2 * 1024 * 1024;

interface MockRootSeed {
  path: string;
  label: string;
  knowledge?: boolean;
  git?: boolean;
}

let roots: Root[] = [];
let counter = 0;
/**
 * rootPath → (relativePath → content).
 *
 * Nested rather than one flat map under a joined key: any separator character
 * is one a real path could contain, and splitting it back apart is a bug
 * waiting to happen.
 */
const files = new Map<string, Map<string, string>>();
const knowledgeDirs = new Set<string>();

/** rootPath → its canned remote status. */
const gitStatuses = new Map<string, GitRemoteStatus>();
/** rootPath → its canned recent commits. */
const gitPulses = new Map<string, PulseCommit[]>();
/** rootPath → its canned dirty files. */
const gitModified = new Map<string, ModifiedFile[]>();
/**
 * rootIds whose every git call fails, until `resetMockRoots`.
 *
 * A mock that cannot FAIL cannot prove parity: `git_error` is reachable on the
 * Rust side whenever git itself exits non-zero, so the mock needs a way to
 * actually emit it rather than a test asserting two hand-written lists match.
 */
const gitFailing = new Set<string>();
/**
 * rootPaths mounted INSIDE a larger repository.
 *
 * Mirrors `GitRootRelation::Parent`: reads resolve (status is pathspec-scoped)
 * but sync refuses, because fetch/pull would act on the enclosing repo the
 * user never mounted.
 */
const gitNested = new Set<string>();

/** The outcomes a network git call can fail with, short of a refusal. */
export type RemoteFailure = 'auth_error' | 'network_error' | 'error';

/**
 * What `remote::classify` says for each failure, word for word, so a seeded
 * failure reads on the row the way a real one does. `error` is git's own
 * stderr there; an empty one reads "git failed".
 */
const CLASSIFIED: Record<RemoteFailure, string> = {
  auth_error:
    'Git could not authenticate with the remote. Check your credential helper or SSH key.',
  network_error: 'Could not reach the remote. Check your connection.',
  error: 'git failed',
};

/**
 * rootPath → how its remote fails fetch and pull.
 *
 * Fetch and pull are where `auth_error` and `network_error` come from on the
 * Rust side. They are RemoteResult outcomes, not refusals, so `gitFailing`'s
 * `git_error` refusal cannot stand in for them.
 */
const gitRemoteFailing = new Map<string, RemoteFailure>();

export function resetMockRoots(): void {
  roots = [];
  counter = 0;
  files.clear();
  knowledgeDirs.clear();
  gitStatuses.clear();
  gitPulses.clear();
  gitModified.clear();
  gitFailing.clear();
  gitNested.clear();
  gitRemoteFailing.clear();
}

export function seedKnowledgeDir(path: string): void {
  knowledgeDirs.add(path);
}

export function seedFile(rootPath: string, rel: string, content: string): void {
  const owned = files.get(rootPath) ?? new Map<string, string>();
  owned.set(rel, content);
  files.set(rootPath, owned);
}

export function seedRoot(seed: MockRootSeed): Root {
  counter += 1;
  const root: Root = {
    id: `root-${counter}`,
    path: seed.path,
    label: seed.label,
    alias: seed.label.toLowerCase(),
    color: null,
    caps: {
      knowledge: seed.knowledge ?? false,
      git: seed.git ?? true,
      writable: true,
    },
  };
  roots.push(root);
  return root;
}

export async function listRoots(): Promise<Root[]> {
  return [...roots];
}

export async function mountRoot(path: string): Promise<Root | MountRefusal> {
  const existing = roots.find((r) => r.path === path);
  if (existing !== undefined) {
    return {
      code: 'already_mounted',
      message: `${path} is already mounted as "${existing.label}"`,
    };
  }
  const knowledge = knowledgeDirs.has(path);
  if (knowledge) {
    const incumbent = roots.find((r) => r.caps.knowledge);
    if (incumbent !== undefined) {
      return {
        code: 'knowledge_root_exists',
        message: `"${incumbent.label}" already holds this workspace's knowledge base. Cerebro supports one knowledge root; unmount it first.`,
      };
    }
  }
  const label = path.split('/').filter(Boolean).pop() ?? path;
  return seedRoot({ path, label, knowledge });
}

export async function unmountRoot(rootId: string): Promise<void> {
  roots = roots.filter((r) => r.id !== rootId);
}

export function rootPathFor(rootId: string): string | null {
  if (rootId === VAULT_ROOT) return VAULT_ROOT;
  return roots.find((r) => r.id === rootId)?.path ?? null;
}

/** Mirrors `tree::resolve_within` — any `..` segment escapes and is refused. */
function escapes(rel: string): boolean {
  return rel.split('/').includes('..');
}

/** Every seeded file belonging to a root, as [relativePath, content]. */
export function filesIn(rootPath: string): readonly (readonly [string, string])[] {
  if (rootPath === VAULT_ROOT) return mockVaultFiles();
  return [...(files.get(rootPath) ?? new Map<string, string>())];
}

export async function listDir(rootId: string, path: string): Promise<DirEntry[]> {
  const rootPath = rootPathFor(rootId);
  if (rootPath === null || escapes(path)) return [];

  const prefix = path === '' ? '' : `${path}/`;
  const dirs = new Set<string>();
  const out: DirEntry[] = [];

  const entries = new Map(
    filesIn(rootPath).map(([rel, content]) => [rel, new TextEncoder().encode(content).length]),
  );
  for (const [rel, size] of byteEntries(rootId)) entries.set(rel, size);
  for (const [rel, size] of entries) {
    if (!rel.startsWith(prefix)) continue;
    const remainder = rel.slice(prefix.length);
    const cut = remainder.indexOf('/');
    if (cut === -1) {
      out.push({ name: remainder, path: rel, isDir: false, size, ignored: false });
    } else {
      dirs.add(remainder.slice(0, cut));
    }
  }

  for (const name of dirs) {
    out.push({ name, path: `${prefix}${name}`, isDir: true, size: 0, ignored: false });
  }

  out.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });
  return out;
}

export async function readFileText(rootId: string, path: string): Promise<FileText> {
  return readText(rootId, path);
}

// ---------------------------------------------------------------------------
// Root git surface (M32.9). Mirrors `roots_git_commands.rs`, which puts every
// command behind one gate so none can forget to apply it — the mock does the
// same, for the same reason.

/**
 * Give a path a git status — which also makes it a repository.
 *
 * Seeding a status for a directory that is not git-capable would be a state
 * the real backend cannot produce (`caps.git` is probed from the same `.git`
 * that answers `git status`). Flipping the capability here is what lets a test
 * model a directory that BECOMES a repo after mount, which is the case the
 * Rust gate re-probes for.
 *
 * A null count models one git could not take (M92.10). A branch seeded with
 * no upstream has no counts at all, as `remote::remote_status` gives none.
 */
export function seedRootGit(rootPath: string, status: Partial<GitRemoteStatus>): void {
  for (const root of roots) {
    if (root.path === rootPath) root.caps = { ...root.caps, git: true };
  }
  const seeded: GitRemoteStatus = {
    branch: 'main',
    ahead: 0,
    behind: 0,
    hasRemote: true,
    hasUpstream: true,
    upstream: 'origin/main',
    ...status,
  };
  gitStatuses.set(
    rootPath,
    seeded.hasUpstream ? seeded : { ...seeded, ahead: null, behind: null, upstream: null },
  );
}

export function seedRootGitPulse(rootPath: string, commits: PulseCommit[]): void {
  gitPulses.set(rootPath, commits);
}

export function seedRootGitModified(rootPath: string, dirty: ModifiedFile[]): void {
  gitModified.set(rootPath, dirty);
}

/** Make every git call on this root fail, so `git_error` can be EMITTED. */
export function seedRootGitFailure(rootId: string): void {
  gitFailing.add(rootId);
}

/**
 * Mirrors `roots::git_workspace` plus the command-level git failure. Order
 * matters and matches Rust: unknown id, then capability, then git itself.
 * `config_unavailable` has no browser analogue — there is no app config dir —
 * and is documented as Rust-transport-only rather than faked.
 */
function gitGate(rootId: string): Root | RootGitRefusal {
  const root = roots.find((r) => r.id === rootId);
  if (root === undefined) {
    return { code: 'no_such_root', message: `no mounted root with id ${rootId}` };
  }
  if (!root.caps.git) {
    return { code: 'no_git_capability', message: `${root.label} is not a git repository` };
  }
  if (gitFailing.has(rootId)) {
    return { code: 'git_error', message: 'git exited non-zero' };
  }
  return root;
}

function refused(gate: Root | RootGitRefusal): gate is RootGitRefusal {
  return 'code' in gate;
}

export async function rootGitWorkspaceInfo(
  rootId: string,
): Promise<GitWorkspaceInfo | RootGitRefusal> {
  const gate = gitGate(rootId);
  if (refused(gate)) return gate;
  // The gate only opens for a repo. A seeded repo is its own git root; a
  // nested one (`seedRootNested`) resolves as Rust's `resolve` walks up: to
  // the enclosing repository, with the root as its pathspec.
  if (gitNested.has(gate.path)) {
    const cut = gate.path.lastIndexOf('/');
    return {
      vaultRoot: gate.path,
      gitRoot: gate.path.slice(0, cut) || '/',
      vaultPathspec: gate.path.slice(cut + 1),
      gitRootRelation: 'parent',
      resolutionFailure: null,
    };
  }
  return {
    vaultRoot: gate.path,
    gitRoot: gate.path,
    vaultPathspec: null,
    gitRootRelation: 'vault',
    resolutionFailure: null,
  };
}

export async function rootGitRemoteStatus(
  rootId: string,
): Promise<GitRemoteStatus | RootGitRefusal> {
  const gate = gitGate(rootId);
  if (refused(gate)) return gate;
  return (
    gitStatuses.get(gate.path) ?? {
      branch: 'main',
      ahead: null,
      behind: null,
      hasRemote: false,
      hasUpstream: false,
      upstream: null,
    }
  );
}

export async function rootGitModifiedFiles(
  rootId: string,
): Promise<ModifiedFile[] | RootGitRefusal> {
  const gate = gitGate(rootId);
  if (refused(gate)) return gate;
  return gitModified.get(gate.path) ?? [];
}

/**
 * Rust's `VaultPulse`. The gate opens only for a repository, so it is always
 * `tracked: true` here; a log that failed is the gate's `git_error`.
 */
export async function rootGitPulse(rootId: string): Promise<VaultPulse | RootGitRefusal> {
  const gate = gitGate(rootId);
  if (refused(gate)) return gate;
  return { tracked: true, commits: gitPulses.get(gate.path) ?? [] };
}

export async function rootGitFileUrl(
  rootId: string,
  path: string,
): Promise<string | null | RootGitRefusal> {
  const gate = gitGate(rootId);
  if (refused(gate)) return gate;
  // Rust returns `Option<String>`, so this is a bare `string | null` — NOT a
  // wrapper object. Parity is the point of this file; a friendlier shape here
  // would be a shape the real backend never sends.
  const status = gitStatuses.get(gate.path);
  if (status === undefined || !status.hasRemote) return null;
  return `https://example.test/repo/blob/${status.branch}/${path}`;
}

/**
 * Mark a root as sitting inside a larger repository (`parent_repo`), the one
 * at its parent directory.
 */
export function seedRootNested(rootPath: string): void {
  gitNested.add(rootPath);
}

/** Make this root's remote fail fetch and pull the way `remote::classify` reports it. */
export function seedRootGitRemoteFailure(rootPath: string, failure: RemoteFailure): void {
  gitRemoteFailing.set(rootPath, failure);
}

/**
 * The seeded failure as `remote::fetch` and `remote::pull_ff` return it, or
 * null. Both check for a remote first and fail only once git runs, so a
 * remoteless root still answers `no_remote`.
 */
function remoteFailure(rootPath: string): RemoteResult | null {
  const failure = gitRemoteFailing.get(rootPath);
  if (failure === undefined) return null;
  return { status: failure, message: CLASSIFIED[failure], updatedFiles: [], conflictFiles: [] };
}

/**
 * Mirrors `roots::git_workspace_for_sync` — the read gate PLUS the
 * nested-mount refusal. Reads deliberately do not go through this.
 */
function syncGate(rootId: string): Root | RootGitRefusal {
  const gate = gitGate(rootId);
  if (refused(gate)) return gate;
  if (gitNested.has(gate.path)) {
    return {
      code: 'parent_repo',
      message:
        'this root sits inside a larger repository; syncing would act on the whole repo — run git there yourself',
    };
  }
  return gate;
}

export async function rootGitFetch(rootId: string): Promise<RemoteResult | RootGitRefusal> {
  const gate = syncGate(rootId);
  if (refused(gate)) return gate;
  const status = gitStatuses.get(gate.path);
  if (status === undefined || !status.hasRemote) {
    return {
      status: 'no_remote',
      message: 'No remote configured',
      updatedFiles: [],
      conflictFiles: [],
    };
  }
  return (
    remoteFailure(gate.path) ?? {
      status: 'updated',
      message: 'Fetched',
      updatedFiles: [],
      conflictFiles: [],
    }
  );
}

/**
 * Fast-forward only. A root seeded BOTH ahead and behind has diverged, so the
 * pull is refused and nothing moves — the same answer `--ff-only` gives, for
 * the same reason: Cerebro never creates a conflict in a repo it doesn't own.
 * A root seeded with a count git could not take (M92.10) has no history the
 * mock can fast-forward through, so its pull fails as git's own failure
 * reads, and nothing moves.
 */
export async function rootGitPullFf(rootId: string): Promise<RemoteResult | RootGitRefusal> {
  const gate = syncGate(rootId);
  if (refused(gate)) return gate;
  const status = gitStatuses.get(gate.path);
  if (status === undefined || !status.hasRemote) {
    return {
      status: 'no_remote',
      message: 'No remote configured',
      updatedFiles: [],
      conflictFiles: [],
    };
  }
  const failed = remoteFailure(gate.path);
  if (failed !== null) return failed;
  if (status.ahead === null || status.behind === null) {
    return { status: 'error', message: CLASSIFIED.error, updatedFiles: [], conflictFiles: [] };
  }
  if (status.ahead > 0 && status.behind > 0) {
    return {
      status: 'rejected',
      message: DIVERGED_MESSAGE,
      updatedFiles: [],
      conflictFiles: [],
    };
  }
  if (status.behind === 0) {
    return {
      status: 'up_to_date',
      message: 'Already up to date',
      updatedFiles: [],
      conflictFiles: [],
    };
  }
  // The fast-forward lands: nothing behind any more.
  gitStatuses.set(gate.path, { ...status, behind: 0 });
  return { status: 'updated', message: 'Fast-forwarded', updatedFiles: [], conflictFiles: [] };
}

// Exposed so Playwright can seed roots and files, mirroring how mockIpc.ts
// exposes __cerebroMockFs.
if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__cerebroMockRoots = {
    resetMockRoots,
    seedRoot,
    seedFile,
    seedKnowledgeDir,
    seedRootGit,
    seedRootGitPulse,
    seedRootGitModified,
    seedRootGitFailure,
    seedRootGitRemoteFailure,
    seedRootNested,
  };
}
/** Browser previews keep real byte fixtures but do not invent decoded dimensions. */
export async function fileThumbnail(root: string, path: string, _size: number): Promise<Thumbnail> {
  const found = resolveBytes(root, path);
  if (isFileRefusal(found)) return { state: 'none', reason: 'notFound' };
  if (found.size > 64 * 1024 * 1024) return { state: 'none', reason: 'tooLarge' };
  const b = found.bytes;
  const starts = (magic: readonly number[]) => magic.every((v, i) => b[i] === v);
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  const mime = starts([137, 80, 78, 71, 13, 10, 26, 10])
    ? 'image/png'
    : starts([255, 216, 255])
      ? 'image/jpeg'
      : ['GIF87a', 'GIF89a'].includes(ascii(0, 6))
        ? 'image/gif'
        : ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP'
          ? 'image/webp'
          : ascii(0, 2) === 'BM'
            ? 'image/bmp'
            : null;
  if (mime === null) return { state: 'none', reason: 'unsupported' };
  let binary = '';
  for (let i = 0; i < b.length; i += 8192)
    binary += String.fromCharCode(...b.subarray(i, i + 8192));
  return {
    state: 'ready',
    dataUrl: `data:${mime};base64,${btoa(binary)}`,
    width: null,
    height: null,
    source: 'image',
  };
}
