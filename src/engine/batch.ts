/**
 * The batch writer's shapes and words (M60.6): a database-wide change — a
 * property rename, kind change or copy, a bulk delete — lands whole or not
 * at all. Rust's `vault/batch.rs` applies it; the mock mirrors it; both
 * replay `src-tauri/fixtures/batch-cases.json`.
 *
 * Ops are tagged by `op`; fields are camelCase. An op whose new value came
 * from a read carries that read's hash as `expectHash` when known (D2 (c)):
 * a page that changed since refuses the whole change.
 *
 * `revert` is undo (M60.7), built from one `FileResult` of an earlier change
 * (`engine/undoPlan.ts` `revertOps`): a trashed page comes back, a created or
 * restored one goes to the Trash, and a rewritten one gets `before` back
 * while it still holds `afterHash`. A rewritten page changed since reverts
 * key by key when the change patched frontmatter alone, and names the keys
 * it kept in `FileResult.skipped`; anything else changed since refuses as
 * `stale_content`. batch.rs's module doc holds the whole rule.
 */

import type { ImportBatchOp, ImportResult } from './importPlan';
export type { ImportBatchOp, ImportResult } from './importPlan';

/** One step of a change. */
export type BatchOp =
  | ImportBatchOp
  | { op: 'patch'; path: string; set: Record<string, unknown>; expectHash?: string }
  | { op: 'create'; path: string; content: string }
  | { op: 'body'; path: string; body: string; expectHash?: string }
  | { op: 'delete'; path: string; expectHash?: string }
  | { op: 'restore'; path: string; stamp: string }
  | { op: 'rename'; from: string; to: string }
  | { op: 'replace_file'; path: string; content: string; expectHash: string }
  | {
      op: 'revert';
      path: string;
      afterHash: string | null;
      before: string | null;
      keys: KeyChange[];
      trashed: string | null;
      restored: string | null;
    };

/** One frontmatter key a patch changed. */
export interface KeyChange {
  key: string;
  before: unknown;
  after: unknown;
}

/** The keys a revert left as they were because they changed since, and
 * `reason: 'gone'` when the whole page was gone (M60.7). */
export interface Skipped {
  keys: string[];
  reason: 'gone' | null;
}

/** One page a change wrote, with what undo needs (M60.7). A page a revert
 * skipped whole is listed with nothing written. */
export interface FileResult {
  path: string;
  /** The old path of a batch rename; absent for ordinary page writes. */
  movedFrom?: string;
  /** Null for a page the change created or restored from the Trash. */
  beforeHash: string | null;
  /** Null for a page the change moved to the Trash. */
  afterHash: string | null;
  /** The bytes the page held before, null when it was absent. */
  before: string | null;
  keys: KeyChange[];
  /** The Trash stamp a delete moved the page into. */
  trashed: string | null;
  /** The Trash stamp a restore took the page from. */
  restored: string | null;
  /** What a revert left as it was; null on every other op. */
  skipped: Skipped | null;
}

/** A landed change: its id and one result per page, in first-appearance order. */
export interface BatchApplied {
  batchId: string;
  files: FileResult[];
  imports?: ImportResult[];
}

/** What opening a vault put back from a change an earlier run left unfinished. */
export interface OpenReport {
  unfinished: number;
  restored: number;
  kept: number;
}

/** The most steps one change may hold: batch.rs `MAX_BATCH_OPS`. */
export const MAX_BATCH_OPS = 2000;
/** The most bytes one change may hold, pre-images and new bytes together:
 * batch.rs `MAX_BATCH_BYTES`. */
export const MAX_BATCH_BYTES = 16 * 1024 * 1024;

/** The IPC's words for a stale `expectHash`: batch.rs `stale_words`. */
export const staleWords = (path: string): string =>
  `stale_content: ${path} changed since this change was prepared, so nothing was written.`;

const STALE =
  /^stale_content: (.+) changed since this change was prepared, so nothing was written\.$/;

/** The page a stale refusal names, or null for any other refusal. */
export function stalePath(message: string): string | null {
  return STALE.exec(message)?.[1] ?? null;
}

/**
 * What a person reads when a change wrote nothing: a stale page by its
 * title, anything else in the backend's own words.
 */
export function batchFailureWords(message: string, titleOf: (path: string) => string): string {
  const path = stalePath(message);
  if (path === null) return message;
  return `Nothing was changed: “${titleOf(path)}” changed while this was being prepared. Try again.`;
}

/** What a person reads after an open put a stopped change back, or null
 * when nothing was unfinished. */
export function openReportWords(report: OpenReport): string | null {
  if (report.unfinished <= 0) return null;
  const pages = report.unfinished === 1 ? 'page' : 'pages';
  const head = `Cerebro stopped partway through a change to ${report.unfinished} ${pages}, so it put them back as they were.`;
  return report.kept > 0 ? `${head} ${report.kept} had changed since and were left alone.` : head;
}

// --- Words both backends refuse with (batch.rs) -----------------------------

export const tooMany = (n: number): string =>
  `A change can hold at most ${MAX_BATCH_OPS} steps; this one has ${n}, so nothing was written.`;
export const TOO_LARGE = 'A change can hold at most 16 MiB of pages, so nothing was written.';
export const NO_JOURNAL =
  "Couldn't start the change: the runtime database isn't open, so nothing was written.";
export const notFirst = (path: string): string =>
  `${path}: a create or restore must be the first step on its page, so nothing was written.`;
export const notAlone = (path: string): string =>
  `${path}: a delete must be the only step on its page, so nothing was written.`;
export const revertNotAlone = (path: string): string =>
  `${path}: a revert must be the only step on its page, so nothing was written.`;
export const WRITES_BEFORE_RENAMES =
  'Every write must precede every rename, so nothing was written.';
export const replaceNotAlone = (path: string): string =>
  `${path}: a replace_file must be the only write step on its page, so nothing was written.`;
export const missingPage = (path: string): string =>
  `${path} doesn't exist, so nothing was written.`;
export const pageExists = (path: string): string =>
  `${path} already exists, so nothing was written.`;
export const wrongItem = (stamp: string, held: string, path: string): string =>
  `The Trash item at ${stamp} is ${held}, not ${path}, so nothing was written.`;
const unreadable = (n: number, what: string): string => `Step ${n} can't be read: ${what}.`;

/** The keys each op takes (batch.rs `keys_of`). */
const KEYS: Record<BatchOp['op'], readonly string[]> = {
  import: ['op', 'system', 'recordId', 'url', 'path', 'content'],
  patch: ['op', 'path', 'set', 'expectHash'],
  create: ['op', 'path', 'content'],
  body: ['op', 'path', 'body', 'expectHash'],
  delete: ['op', 'path', 'expectHash'],
  restore: ['op', 'path', 'stamp'],
  rename: ['op', 'from', 'to'],
  replace_file: ['op', 'path', 'content', 'expectHash'],
  revert: ['op', 'path', 'afterHash', 'before', 'keys', 'trashed', 'restored'],
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Read every op as batch.rs `parse_ops` does, word for word: the first that
 * can't be read throws, named by its place (from 1). A valid `expectHash` is
 * lowercased.
 */
export function parseBatchOps(values: readonly unknown[]): BatchOp[] {
  return values.map((value, i) => {
    const n = i + 1;
    if (!isObject(value)) throw new Error(unreadable(n, 'it is not an object'));
    const op = typeof value.op === 'string' ? value.op : '';
    if (!Object.hasOwn(KEYS, op)) {
      throw new Error(
        unreadable(
          n,
          'its op must be patch, create, body, delete, restore, revert, rename, replace_file or import',
        ),
      );
    }
    const kind = op as BatchOp['op'];
    const stray = Object.keys(value).find((key) => !KEYS[kind].includes(key));
    if (stray !== undefined) throw new Error(unreadable(n, `${stray} is not part of a ${op} step`));
    const text = (key: string): string => {
      const field = value[key];
      if (typeof field !== 'string') throw new Error(unreadable(n, `${key} must be text`));
      return field;
    };
    if (kind === 'rename') return { op: 'rename', from: text('from'), to: text('to') };
    const path = text('path');
    const hashAt = (key: string): string | null => {
      const hash = value[key];
      if (hash === undefined || hash === null) return null;
      if (typeof hash === 'string' && /^[0-9a-fA-F]{64}$/.test(hash)) return hash.toLowerCase();
      throw new Error(unreadable(n, `${key} must be a 64-character hash`));
    };
    const expect = (): { expectHash?: string } => {
      const hash = hashAt('expectHash');
      return hash === null ? {} : { expectHash: hash };
    };
    const maybeText = (key: string): string | null => {
      const field = value[key];
      if (field === undefined || field === null) return null;
      if (typeof field !== 'string') throw new Error(unreadable(n, `${key} must be text`));
      return field;
    };
    switch (kind) {
      case 'import': {
        const url = maybeText('url');
        return {
          op: 'import',
          system: text('system'),
          recordId: text('recordId'),
          path,
          content: text('content'),
          ...(url === null ? {} : { url }),
        };
      }
      case 'patch': {
        if (!isObject(value.set)) throw new Error(unreadable(n, 'set must be an object'));
        return { op: 'patch', path, set: value.set, ...expect() };
      }
      case 'create':
        return { op: 'create', path, content: text('content') };
      case 'replace_file': {
        const content = text('content');
        const expectHash = hashAt('expectHash');
        if (expectHash === null) {
          throw new Error(unreadable(n, 'expectHash must be a 64-character hash'));
        }
        return { op: 'replace_file', path, content, expectHash };
      }
      case 'body':
        return { op: 'body', path, body: text('body'), ...expect() };
      case 'delete':
        return { op: 'delete', path, ...expect() };
      case 'restore':
        return { op: 'restore', path, stamp: text('stamp') };
      case 'revert': {
        const afterHash = hashAt('afterHash');
        const before = maybeText('before');
        const trashed = maybeText('trashed');
        const restored = maybeText('restored');
        if (trashed === null && afterHash === null) {
          throw new Error(unreadable(n, 'afterHash must be a 64-character hash'));
        }
        const raw = value.keys;
        let keys: KeyChange[] = [];
        if (Array.isArray(raw)) {
          keys = raw.map((item: unknown) => {
            if (!isObject(item) || typeof item.key !== 'string') {
              throw new Error(unreadable(n, 'each of keys must name its key'));
            }
            return { key: item.key, before: item.before ?? null, after: item.after ?? null };
          });
        } else if (raw !== undefined && raw !== null) {
          throw new Error(unreadable(n, 'keys must be a list'));
        }
        return { op: 'revert', path, afterHash, before, keys, trashed, restored };
      }
    }
  });
}
