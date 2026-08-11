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
