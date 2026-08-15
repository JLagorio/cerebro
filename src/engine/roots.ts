/**
 * Types and pure helpers for mounted roots (M30).
 *
 * Nothing here is an `Entry`. Repository files must never reach `vaultStore` —
 * that store drives collections, types and dossiers and is seeded from
 * `scan_vault`. Keeping mounted roots a separate shape is what makes mounting
 * a repo a zero-blast-radius change to the vault surfaces.
 */

export interface RootCaps {
  /** Carries a `knowledge/` bundle. Exactly one mounted root may, in v1. */
  knowledge: boolean;
  git: boolean;
  writable: boolean;
}

export interface Root {
  id: string;
  path: string;
  label: string;
  /** Reserved for `alias:relative/path.md`; nothing reads it yet. */
  alias: string;
  color: string | null;
  caps: RootCaps;
}

export interface DirEntry {
  name: string;
  /** Root-relative, forward-slashed. */
  path: string;
  isDir: boolean;
  size: number;
  ignored: boolean;
}

/** A refusal the caller is expected to READ, not toast away. */
export interface MountRefusal {
  code: 'already_mounted' | 'knowledge_root_exists' | 'not_a_directory' | string;
  message: string;
}

/**
 * A git-surface refusal (M32.8). Same contract as `MountRefusal`, deliberately
 * its own type: sharing one would let a match arm silently accept codes it
 * never handles. The code list mirrors `roots/mod.rs`'s `RootGitRefusal` —
 * `config_unavailable` is Rust-transport-only and unreachable in the browser.
 */
export interface RootGitRefusal {
  code: 'no_such_root' | 'no_git_capability' | 'config_unavailable' | 'git_error' | string;
  message: string;
}

/**
 * Narrow a root-git result to its refusal arm.
 *
 * Takes `unknown` because not every result is an object: `root_git_file_url`
 * resolves to `string | null`, and a `'code' in result` test would throw on
 * both.
 */
export function isRootGitRefusal(result: unknown): result is RootGitRefusal {
  return typeof result === 'object' && result !== null && 'code' in result && 'message' in result;
}

/** The counts a root's git badge summarises. */
export interface RootGitBadge {
  branch: string;
  ahead: number;
  behind: number;
  dirty: number;
}

/**
 * The badge line for a mounted repo, or `null` when it should stay silent.
 *
 * Nothing speaks first (M8): a clean repository in sync with its upstream has
 * nothing to disambiguate, so it renders no badge at all rather than a
 * permanent "main 0 0 0". The branch name rides along only when there is
 * already a reason to speak — a row that is always decorated stops being read.
 */
export function gitBadgeText(badge: RootGitBadge): string | null {
  const parts: string[] = [];
  if (badge.ahead > 0) parts.push(`↑${badge.ahead}`);
  if (badge.behind > 0) parts.push(`↓${badge.behind}`);
  if (badge.dirty > 0) parts.push(`●${badge.dirty}`);
  if (parts.length === 0) return null;
  return [badge.branch, ...parts].join(' ');
}

export type FileText =
  | { kind: 'text'; content: string }
  | { kind: 'tooLarge'; size: number; limit: number }
  | { kind: 'binary' }
  | { kind: 'notFound' };

export function isMarkdownPath(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith('.md') || lower.endsWith('.markdown');
}

/**
 * Which viewer renders this file. Unknown extensions go to the code viewer
 * rather than a refusal — a `Dockerfile.dev` or a `.env.example` is still
 * readable text, and refusing it would be a worse answer than monospace.
 */
export function viewerKindFor(path: string): 'doc' | 'code' {
  return isMarkdownPath(path) ? 'doc' : 'code';
}

/** The containing directory, or `''` at the root. */
export function parentPath(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut === -1 ? '' : path.slice(0, cut);
}
