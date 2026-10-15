/**
 * Types and pure helpers for mounted roots (M30).
 *
 * Nothing here is an `Entry`. Repository files must never reach `vaultStore` —
 * that store drives collections, types and dossiers and is seeded from
 * `scan_vault`. Keeping mounted roots a separate shape is what makes mounting
 * a repo a zero-blast-radius change to the vault surfaces.
 */
import { kindFor } from './fileKinds';
import type { RemoteOutcome, RemoteResult } from './git';

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
 * never handles. The code list mirrors `roots/mod.rs`'s `RootGitRefusal`,
 * `parent_repo` (M32.11's sync gate) included. `config_unavailable` is
 * Rust-transport-only and unreachable in the browser.
 */
export interface RootGitRefusal {
  code:
    | 'no_such_root'
    | 'no_git_capability'
    | 'config_unavailable'
    | 'git_error'
    | 'parent_repo'
    | string;
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

/** What one sync of a mounted root ended in: git's answer, or the gate's refusal. */
export type RootSyncOutcome = RemoteResult | RootGitRefusal;

/**
 * What a fast-forward-only pull says when local and remote have diverged:
 * `remote::pull_ff`'s message, word for word. The mock gives it for the pull
 * it refuses, and the store gives it for the pull it declines to ask for.
 */
export const DIVERGED_MESSAGE = 'Local and remote have diverged; resolve outside Cerebro';

/**
 * The sync control's word for each outcome git can answer, and `null` for the
 * three that LANDED (fetched, fast-forwarded, nothing to do). One table, so
 * what counts as landing and what the row says can never disagree, and a new
 * outcome is a compile error here until it has a word.
 */
const SYNC_WORD: Record<RemoteOutcome, string | null> = {
  ok: null,
  up_to_date: null,
  updated: null,
  auth_error: 'auth failed',
  network_error: 'offline',
  rejected: 'diverged',
  conflict: 'conflict',
  no_remote: 'no remote',
  error: 'failed',
};

/** Did this sync step land? A refusal never does. */
export function syncLanded(outcome: RootSyncOutcome): boolean {
  return !isRootGitRefusal(outcome) && SYNC_WORD[outcome.status] === null;
}

/** What a root's sync control says in place of ↻. */
export interface RootSyncNotice {
  /** The control's own text: a word or two, read at a glance. */
  text: string;
  /** The whole answer, for the control's title. */
  title: string;
}

/**
 * The notice a root's last sync leaves on its row, or `null` for none.
 *
 * Nothing speaks first (M8): a sync that landed leaves the control as it was.
 * Every other outcome is named on the row and never toasted (M32.11). The
 * title carries the outcome's own message, so `auth_error` shows the
 * credential hint `remote::classify` writes and a diverged root shows
 * `DIVERGED_MESSAGE`.
 */
export function syncNotice(outcome: RootSyncOutcome | undefined): RootSyncNotice | null {
  if (outcome === undefined) return null;
  if (isRootGitRefusal(outcome)) {
    return outcome.code === 'parent_repo'
      ? { text: 'nested', title: 'Nested in a larger repository — sync it there' }
      : { text: 'failed', title: outcome.message };
  }
  const word = SYNC_WORD[outcome.status];
  return word === null ? null : { text: word, title: outcome.message };
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

/** A markdown file, by the file-kind table's `kind` column (M66.1). */
export function isMarkdownPath(path: string): boolean {
  return kindFor(path).kind === 'markdown';
}

/** The containing directory, or `''` at the root. */
export function parentPath(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut === -1 ? '' : path.slice(0, cut);
}
