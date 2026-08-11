/**
 * In-memory roots backend for browser dev, vitest and Playwright.
 *
 * PARITY IS THE POINT. AGENTS.md makes mock/Rust parity a hard rule for the
 * knowledge guards, and the same reasoning applies here: a mock that permits a
 * traversal the Rust side refuses would make the Playwright suite prove the
 * opposite of the invariant. Every guard in `roots/read.rs` is mirrored below.
 */
import type { DirEntry, FileText, MountRefusal, Root } from '@/engine/roots';

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

export function resetMockRoots(): void {
  roots = [];
  counter = 0;
  files.clear();
  knowledgeDirs.clear();
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

// Exposed so Playwright can seed roots and files, mirroring how mockIpc.ts
// exposes __cerebroMockFs.
if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__cerebroMockRoots = {
    resetMockRoots,
    seedRoot,
    seedFile,
    seedKnowledgeDir,
  };
}
