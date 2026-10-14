import type { CommentAnchor } from './commentAnchor';
import { hfsHeard } from './okf';

/**
 * Page comments (M70.2): a page's threads live beside it, never in it, in
 * `<vault>/.comments/<page path>.json`. The TS twin of
 * src-tauri/src/vault/comments.rs; both replay
 * src-tauri/fixtures/comment-cases.json, so the mock backend writes the same
 * bytes and refuses in the same words.
 *
 * Format v1: two-space JSON and a final newline. Keys in order: file
 * `{format, threads}`; thread `{anchor?, resolved?, deleted?, comments}`;
 * comment `{id, author, created, body, deleted?, run_id?, state?, answers?}`;
 * anchor `{quote, occurrence, before, after}`; stamp `{at, by}`. An optional
 * key is omitted when unset. A thread's id is its first comment's. Ids are 16
 * lowercase hex characters and times RFC 3339 UTC to the second. Characters
 * are counted as code points.
 */

export const COMMENTS_DIR = '.comments';
export const COMMENTS_FORMAT = 1;
export const COMMENT_LIMITS = {
  body: 10000,
  quote: 1000,
  context: 40,
  fileBytes: 1024 * 1024,
} as const;
/** The author every comment a person writes carries (D1: single user). */
export const OWNER = 'human:owner';
/** A plain panel turn's author (mcp.rs `DEFAULT_ACTOR`). */
const PANEL_ACTOR = 'claude-code';

export const UNREADABLE = {
  conflicted: 'it has unresolved merge conflict markers',
  notJson: 'it is not valid JSON',
  newer: 'it was written by a newer Cerebro',
  misshapen: 'it does not match the comments format',
} as const;
export type UnreadableReason = (typeof UNREADABLE)[keyof typeof UNREADABLE];

export interface CommentStamp {
  at: string;
  by: string;
}

export type CommentState = 'pending' | 'answered' | 'failed';

export interface PageComment {
  id: string;
  author: string;
  created: string;
  body: string;
  deleted?: CommentStamp;
  run_id?: string;
  state?: CommentState;
  answers?: string;
}

export interface CommentThread {
  anchor?: CommentAnchor;
  resolved?: CommentStamp;
  deleted?: CommentStamp;
  comments: PageComment[];
}

export interface CommentsFile {
  format: number;
  threads: CommentThread[];
}

export function emptyComments(): CommentsFile {
  return { format: COMMENTS_FORMAT, threads: [] };
}

/** A thread's id: its first comment's. */
export const threadId = (thread: CommentThread): string => thread.comments[0]?.id ?? '';

// --- Paths -------------------------------------------------------------------

const isHidden = (name: string): boolean => hfsHeard(name).startsWith('.');

/** A page a sidecar may belong to: names none empty or hidden, ending `.md`. */
export function isCommentPage(rel: string): boolean {
  return rel.split('/').every((n) => n !== '' && !isHidden(n)) && rel.endsWith('.md');
}

/** The sidecar of page `page`. */
export const sidecarPathOf = (page: string): string => `${COMMENTS_DIR}/${page}.json`;

/** The folder holding the sidecars of every page under `folder`. */
export const sidecarFolderOf = (folder: string): string => `${COMMENTS_DIR}/${folder}`;

/** What a rename or delete of `rel` carries: the sidecar of a page, the
 * mirrored folder of a folder (names none empty or hidden), or null. */
export function carriedRel(rel: string, isDir: boolean): string | null {
  if (isDir) {
    return rel.split('/').every((n) => n !== '' && !isHidden(n)) ? sidecarFolderOf(rel) : null;
  }
  return isCommentPage(rel) ? sidecarPathOf(rel) : null;
}

/** The page a sidecar belongs to, or null when `rel` is no page's sidecar. */
export function pageOfSidecar(rel: string): string | null {
  const prefix = `${COMMENTS_DIR}/`;
  if (!rel.startsWith(prefix) || !rel.endsWith('.json')) return null;
  const page = rel.slice(prefix.length, -'.json'.length);
  return isCommentPage(page) ? page : null;
}

// --- Text rules shared with Rust ----------------------------------------------

/** Rust's `char::is_whitespace` (Unicode White_Space): `String.trim` differs
 * on U+0085, which Rust trims, and U+FEFF, which it keeps. */
const WHITESPACE =
  '\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const EDGES = new RegExp(`^[${WHITESPACE}]+|[${WHITESPACE}]+$`, 'g');
export const rustTrim = (s: string): string => s.replace(EDGES, '');

/** Rust's `char::is_control` (Unicode Cc). */
// eslint-disable-next-line no-control-regex -- matching control characters is the point: Rust's char::is_control
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

const codePoints = (s: string): number => [...s].length;

/** UTF-8 length, counted without TextEncoder (the engine has no DOM). */
export function utf8Length(s: string): number {
  let n = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    n += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return n;
}

export const isCommentId = (s: string): boolean => /^[0-9a-f]{16}$/.test(s);

const isName = (s: string): boolean => rustTrim(s) !== '' && !CONTROL.test(s);

/** `human:owner`, `claude-code`, `process:<name>` or `agent:<id>`. */
export function isCommentAuthor(s: string): boolean {
  if (s === OWNER || s === PANEL_ACTOR) return true;
  for (const kind of ['process:', 'agent:']) {
    if (s.startsWith(kind)) return isName(s.slice(kind.length));
  }
  return false;
}

/** RFC 3339 UTC to the second, a real calendar day. */
export function isCommentTime(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/.exec(s);
  if (m === null) return false;
  const [year, month, day, hour, minute, second] = m.slice(1).map(Number);
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (days === undefined) return false;
  return day >= 1 && day <= days && hour < 24 && minute < 60 && second < 60;
}

// --- Parsing -----------------------------------------------------------------

export type ParsedComments =
  { ok: true; file: CommentsFile } | { ok: false; reason: UnreadableReason; pointer: string };

class Misshapen extends Error {
  constructor(readonly pointer: string) {
    super(pointer);
  }
}

const MARKERS = ['<<<<<<<', '|||||||', '=======', '>>>>>>>'];

/** Read a sidecar's text: conflict markers, then JSON, then the format, then
 * the shape. */
export function parseComments(text: string): ParsedComments {
  if (text.split('\n').some((line) => MARKERS.some((m) => line.startsWith(m)))) {
    return { ok: false, reason: UNREADABLE.conflicted, pointer: '' };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: UNREADABLE.notJson, pointer: '' };
  }
  return fileFromValue(value);
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);

function object(v: unknown, at: string, required: string[], optional: string[]): Obj {
  if (!isObj(v)) throw new Misshapen(at);
  for (const key of Object.keys(v)) {
    if (!required.includes(key) && !optional.includes(key)) throw new Misshapen(`${at}/${key}`);
  }
  for (const key of required) {
    if (!(key in v)) throw new Misshapen(`${at}/${key}`);
  }
  return v;
}

function str(o: Obj, key: string, at: string, check?: (s: string) => boolean): string {
  const v = o[key];
  if (typeof v !== 'string' || (check !== undefined && !check(v))) {
    throw new Misshapen(`${at}/${key}`);
  }
  return v;
}

function stampFrom(v: unknown, at: string): CommentStamp {
  const o = object(v, at, ['at', 'by'], []);
  return { at: str(o, 'at', at, isCommentTime), by: str(o, 'by', at, isCommentAuthor) };
}

function anchorFrom(v: unknown, at: string): CommentAnchor {
  const o = object(v, at, ['quote', 'occurrence', 'before', 'after'], []);
  const occurrence = o.occurrence;
  if (!isInt(occurrence) || occurrence < 1) throw new Misshapen(`${at}/occurrence`);
  return {
    quote: str(o, 'quote', at),
    occurrence,
    before: str(o, 'before', at),
    after: str(o, 'after', at),
  };
}

const STATES: readonly string[] = ['pending', 'answered', 'failed'];

function commentFrom(v: unknown, at: string): PageComment {
  const o = object(
    v,
    at,
    ['id', 'author', 'created', 'body'],
    ['deleted', 'run_id', 'state', 'answers'],
  );
  const out: PageComment = {
    id: str(o, 'id', at, isCommentId),
    author: str(o, 'author', at, isCommentAuthor),
    created: str(o, 'created', at, isCommentTime),
    body: str(o, 'body', at),
  };
  if ('deleted' in o) out.deleted = stampFrom(o.deleted, `${at}/deleted`);
  if ('run_id' in o) out.run_id = str(o, 'run_id', at, isName);
  if ('state' in o) {
    out.state = str(o, 'state', at, (s) => STATES.includes(s)) as CommentState;
  }
  if ('answers' in o) out.answers = str(o, 'answers', at, isCommentId);
  return out;
}

function threadFrom(v: unknown, at: string, seen: Set<string>): CommentThread {
  const o = object(v, at, ['comments'], ['anchor', 'resolved', 'deleted']);
  const out: CommentThread = { comments: [] };
  if ('anchor' in o) out.anchor = anchorFrom(o.anchor, `${at}/anchor`);
  if ('resolved' in o) out.resolved = stampFrom(o.resolved, `${at}/resolved`);
  if ('deleted' in o) out.deleted = stampFrom(o.deleted, `${at}/deleted`);
  const raw = o.comments;
  if (!Array.isArray(raw) || raw.length === 0) throw new Misshapen(`${at}/comments`);
  raw.forEach((c, i) => {
    const comment = commentFrom(c, `${at}/comments/${i}`);
    if (seen.has(comment.id)) throw new Misshapen(`${at}/comments/${i}/id`);
    seen.add(comment.id);
    out.comments.push(comment);
  });
  return out;
}

/** The format check and the shape check over a parsed value. */
export function fileFromValue(value: unknown): ParsedComments {
  if (isObj(value) && isInt(value.format) && value.format > COMMENTS_FORMAT) {
    return { ok: false, reason: UNREADABLE.newer, pointer: '/format' };
  }
  try {
    const root = object(value, '', ['format', 'threads'], []);
    if (root.format !== COMMENTS_FORMAT) throw new Misshapen('/format');
    if (!Array.isArray(root.threads)) throw new Misshapen('/threads');
    const seen = new Set<string>();
    const threads = root.threads.map((t, i) => threadFrom(t, `/threads/${i}`, seen));
    return { ok: true, file: { format: COMMENTS_FORMAT, threads } };
  } catch (err) {
    if (err instanceof Misshapen) {
      return { ok: false, reason: UNREADABLE.misshapen, pointer: err.pointer };
    }
    throw err;
  }
}

// --- Bytes -------------------------------------------------------------------

const stampOut = (s: CommentStamp): CommentStamp => ({ at: s.at, by: s.by });

/** The bytes written: each object rebuilt in key order, optional keys left
 * out when unset, two-space JSON, and a final newline. */
export function serializeComments(file: CommentsFile): string {
  const ordered = {
    format: file.format,
    threads: file.threads.map((t) => ({
      ...(t.anchor && {
        anchor: {
          quote: t.anchor.quote,
          occurrence: t.anchor.occurrence,
          before: t.anchor.before,
          after: t.anchor.after,
        },
      }),
      ...(t.resolved && { resolved: stampOut(t.resolved) }),
      ...(t.deleted && { deleted: stampOut(t.deleted) }),
      comments: t.comments.map((c) => ({
        id: c.id,
        author: c.author,
        created: c.created,
        body: c.body,
        ...(c.deleted && { deleted: stampOut(c.deleted) }),
        ...(c.run_id !== undefined && { run_id: c.run_id }),
        ...(c.state !== undefined && { state: c.state }),
        ...(c.answers !== undefined && { answers: c.answers }),
      })),
    })),
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/** The size cap, in the words both backends use, or null when it fits. */
export function sizeRefusal(page: string, text: string): string | null {
  return utf8Length(text) > COMMENT_LIMITS.fileBytes
    ? `Comments for ${page} would pass 1 MiB, so nothing was written.`
    : null;
}

// --- Ops ---------------------------------------------------------------------

/** One change to a page's threads (Rust's `CommentOp`). */
export type CommentOp =
  | { op: 'start'; anchor?: CommentAnchor | null; body: string }
  | { op: 'reply'; thread: string; body: string }
  | { op: 'set_resolved'; thread: string; resolved: boolean; closing?: string | null }
  | { op: 'delete_comment'; thread: string; comment: string }
  | { op: 'delete_thread'; thread: string };

/** Fresh ids (one per new comment), the time, the author, the run, and the
 * page, for messages. */
export interface CommentOpContext {
  ids: string[];
  now: string;
  by: string;
  run_id?: string | null;
  page: string;
}

export type CommentOpResult =
  { ok: true; file: CommentsFile | null } | { ok: false; error: string };

class Refusal extends Error {}

function bodyOf(raw: string): string {
  const body = rustTrim(raw);
  if (body === '') throw new Refusal('A comment needs some text.');
  const n = codePoints(body);
  if (n > COMMENT_LIMITS.body) {
    throw new Refusal(
      `A comment holds at most ${COMMENT_LIMITS.body} characters; this one has ${n}.`,
    );
  }
  return body;
}

function anchorOf(input: CommentAnchor): CommentAnchor {
  if (rustTrim(input.quote) === '') throw new Refusal("A comment's quote can't be empty.");
  const n = codePoints(input.quote);
  if (n > COMMENT_LIMITS.quote) {
    throw new Refusal(
      `A comment's quote holds at most ${COMMENT_LIMITS.quote} characters; this one has ${n}.`,
    );
  }
  if (!Number.isInteger(input.occurrence) || input.occurrence < 1) {
    throw new Refusal("A comment's occurrence counts from 1.");
  }
  if (
    codePoints(input.before) > COMMENT_LIMITS.context ||
    codePoints(input.after) > COMMENT_LIMITS.context
  ) {
    throw new Refusal(
      `A comment's context holds at most ${COMMENT_LIMITS.context} characters on each side.`,
    );
  }
  return {
    quote: input.quote,
    occurrence: input.occurrence,
    before: input.before,
    after: input.after,
  };
}

function newComment(ctx: CommentOpContext, body: string): PageComment {
  const id = ctx.ids[0];
  if (id === undefined) throw new Refusal('Cerebro had no fresh comment id to give.');
  const out: PageComment = { id, author: ctx.by, created: ctx.now, body };
  if (ctx.run_id !== undefined && ctx.run_id !== null) out.run_id = ctx.run_id;
  return out;
}

const stampOf = (ctx: CommentOpContext): CommentStamp => ({ at: ctx.now, by: ctx.by });

function findThread(file: CommentsFile, id: string, page: string): number {
  const i = file.threads.findIndex((t) => threadId(t) === id);
  if (i === -1) throw new Refusal(`No comment thread ${id} on ${page}.`);
  return i;
}

const DELETED_THREAD = 'That comment thread was deleted.';

/** A deep copy, so an op never changes the file it was handed. */
const cloneFile = (file: CommentsFile): CommentsFile => JSON.parse(JSON.stringify(file));

/**
 * Apply one op: the new file, `null` when nothing changes, or the refusal.
 * Pure: ids, time and author come in `ctx`. Mirrors Rust's `apply_op` rule
 * for rule and word for word.
 */
export function applyCommentOp(
  file: CommentsFile,
  op: CommentOp,
  ctx: CommentOpContext,
): CommentOpResult {
  try {
    return { ok: true, file: applyOrThrow(file, op, ctx) };
  } catch (err) {
    if (err instanceof Refusal) return { ok: false, error: err.message };
    throw err;
  }
}

function applyOrThrow(
  file: CommentsFile,
  op: CommentOp,
  ctx: CommentOpContext,
): CommentsFile | null {
  const next = cloneFile(file);
  switch (op.op) {
    case 'start': {
      const body = bodyOf(op.body);
      const anchor = op.anchor ? anchorOf(op.anchor) : undefined;
      const thread: CommentThread = { comments: [newComment(ctx, body)] };
      if (anchor) thread.anchor = anchor;
      next.threads.push(thread);
      return next;
    }
    case 'reply': {
      const t = next.threads[findThread(file, op.thread, ctx.page)];
      if (t.deleted) throw new Refusal(DELETED_THREAD);
      const body = bodyOf(op.body);
      t.comments.push(newComment(ctx, body));
      delete t.resolved;
      return next;
    }
    case 'set_resolved': {
      const t = next.threads[findThread(file, op.thread, ctx.page)];
      if (t.deleted) throw new Refusal(DELETED_THREAD);
      if ((t.resolved !== undefined) === op.resolved) return null;
      if (!op.resolved) {
        delete t.resolved;
      } else {
        if (op.closing !== undefined && op.closing !== null) {
          t.comments.push(newComment(ctx, bodyOf(op.closing)));
        }
        t.resolved = stampOf(ctx);
      }
      return next;
    }
    case 'delete_comment': {
      const t = next.threads[findThread(file, op.thread, ctx.page)];
      const c = t.comments.find((x) => x.id === op.comment);
      if (c === undefined) throw new Refusal(`No comment ${op.comment} in that thread.`);
      if (c.deleted) return null;
      if (t.deleted) throw new Refusal(DELETED_THREAD);
      c.body = '';
      c.deleted = stampOf(ctx);
      if (t.comments.every((x) => x.deleted)) t.deleted = stampOf(ctx);
      return next;
    }
    case 'delete_thread': {
      const t = next.threads[findThread(file, op.thread, ctx.page)];
      if (t.deleted) return null;
      for (const c of t.comments) {
        if (!c.deleted) {
          c.body = '';
          c.deleted = stampOf(ctx);
        }
      }
      t.deleted = stampOf(ctx);
      return next;
    }
  }
}

// --- Reading -------------------------------------------------------------------

export interface VisibleThread {
  id: string;
  thread: CommentThread;
}

/** The threads a page shows, in file order: every one not deleted. */
export function visibleThreads(file: CommentsFile): VisibleThread[] {
  return file.threads.filter((t) => !t.deleted).map((thread) => ({ id: threadId(thread), thread }));
}

/** How many threads are open: shown and not resolved. */
export function openThreadCount(file: CommentsFile): number {
  return visibleThreads(file).filter(({ thread }) => !thread.resolved).length;
}
