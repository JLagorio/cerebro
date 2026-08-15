/**
 * In-memory roots backend for browser dev, vitest and Playwright.
 *
 * PARITY IS THE POINT. AGENTS.md makes mock/Rust parity a hard rule for the
 * knowledge guards, and the same reasoning applies here: a mock that permits a
 * traversal the Rust side refuses would make the Playwright suite prove the
 * opposite of the invariant. Every guard in `roots/read.rs` is mirrored below.
 */
import type { GitRemoteStatus, GitWorkspaceInfo, ModifiedFile, PulseCommit } from '@/engine/git';
import type { DirEntry, FileText, MountRefusal, Root, RootGitRefusal } from '@/engine/roots';

export const MAX_BYTES = 2 * 1024 * 1024;

/**
 * The NUL that marks a file binary, matching `read.rs`'s sniff.
 *
 * Written as an escape, never as a raw byte — `.gitattributes` is pinned to
 * text precisely because embedded control characters have turned source files
 * binary here before.
 */
const NUL = '\u0000';

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
 * rootIds whose next git call fails.
 *
 * A mock that cannot FAIL cannot prove parity: `git_error` is reachable on the
 * Rust side whenever git itself exits non-zero, so the mock needs a way to
 * actually emit it rather than a test asserting two hand-written lists match.
 */
const gitFailing = new Set<string>();

export function resetMockRoots(): void {
  roots = [];
  counter = 0;
  files.clear();
  knowledgeDirs.clear();
  gitStatuses.clear();
  gitPulses.clear();
  gitModified.clear();
  gitFailing.clear();
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

function rootPathFor(rootId: string): string | null {
  return roots.find((r) => r.id === rootId)?.path ?? null;
}

/** Mirrors `tree::resolve_within` — any `..` segment escapes and is refused. */
function escapes(rel: string): boolean {
  return rel.split('/').includes('..');
}

/** Every seeded file belonging to a root, as [relativePath, content]. */
function filesIn(rootPath: string): [string, string][] {
  return [...(files.get(rootPath) ?? new Map<string, string>())];
}

export async function listDir(rootId: string, path: string): Promise<DirEntry[]> {
  const rootPath = rootPathFor(rootId);
  if (rootPath === null || escapes(path)) return [];

  const prefix = path === '' ? '' : `${path}/`;
  const dirs = new Set<string>();
  const out: DirEntry[] = [];

  for (const [rel, content] of filesIn(rootPath)) {
    if (!rel.startsWith(prefix)) continue;
    const remainder = rel.slice(prefix.length);
    const cut = remainder.indexOf('/');
    if (cut === -1) {
      out.push({ name: remainder, path: rel, isDir: false, size: content.length, ignored: false });
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
  const rootPath = rootPathFor(rootId);
  if (rootPath === null || escapes(path)) return { kind: 'notFound' };
  const content = files.get(rootPath)?.get(path);
  if (content === undefined) return { kind: 'notFound' };
  if (content.length > MAX_BYTES) {
    return { kind: 'tooLarge', size: content.length, limit: MAX_BYTES };
  }
  if (content.includes(NUL)) return { kind: 'binary' };
  return { kind: 'text', content };
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
 */
export function seedRootGit(rootPath: string, status: Partial<GitRemoteStatus>): void {
  for (const root of roots) {
    if (root.path === rootPath) root.caps = { ...root.caps, git: true };
  }
  gitStatuses.set(rootPath, {
    branch: 'main',
    ahead: 0,
    behind: 0,
    hasRemote: true,
    hasUpstream: true,
    upstream: 'origin/main',
    ...status,
  });
}

export function seedRootGitPulse(rootPath: string, commits: PulseCommit[]): void {
  gitPulses.set(rootPath, commits);
}

export function seedRootGitModified(rootPath: string, dirty: ModifiedFile[]): void {
  gitModified.set(rootPath, dirty);
}

/** Make this root's next git call fail, so `git_error` can be EMITTED. */
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
  // The gate only opens for a repo, and a mounted repo IS its git root — a
  // root nested inside a larger repository is M32.11's `parent_repo` case.
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
      ahead: 0,
      behind: 0,
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

export async function rootGitPulse(rootId: string): Promise<PulseCommit[] | RootGitRefusal> {
  const gate = gitGate(rootId);
  if (refused(gate)) return gate;
  return gitPulses.get(gate.path) ?? [];
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
  };
}
