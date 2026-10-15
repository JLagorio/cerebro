import type { DiffLine } from './git';

/**
 * Review notes on a turn's diff (M58.5): a line range of one file in the
 * commit a turn made, and what the person wants changed there. Notes go back
 * to the agent through Up next as one numbered prompt in Cerebro's words.
 *
 * Pure: the store (`stores/reviewNotesStore.ts`) keeps them per viewer, and
 * never in the vault, git or runtime.db.
 */

export type NoteSide = 'old' | 'new';

export interface ReviewNote {
  id: string;
  vault: string;
  conversationId: string;
  /** The run whose commit the note is on, when the panel knew it. */
  runId: string | null;
  commit: string;
  /** The file's path at that commit. */
  path: string;
  /** The side the range ends on: `old` is before the change, `new` after. */
  side: NoteSide;
  /** Set only when the range starts on the other side. */
  startSide?: NoteSide;
  start: number;
  end: number;
  /** The first anchored line, without its marker, trimmed and cut at 80. */
  excerpt: string;
  text: string;
  /** Unix milliseconds. */
  createdAt: number;
  /** The Up next entry holding it; memory-only, since Up next is. */
  heldBy?: string;
  /** Unix milliseconds: when the prompt carrying it was dispatched. */
  sentAt?: number;
}

/** Queued (not sent) notes one conversation holds (Q16). */
export const MAX_QUEUED_NOTES = 30;
/** Characters in one note's text (Q16). */
export const MAX_NOTE_CHARS = 2000;
/** Sent notes kept per conversation, the oldest dropped first (Q16). */
export const MAX_SENT_NOTES = 100;
/** Characters an excerpt keeps. */
export const EXCERPT_CHARS = 80;

/** Where a range sits, as `anchorFrom` reads it from the diff. */
export interface NoteAnchor {
  side: NoteSide;
  startSide?: NoteSide;
  start: number;
  end: number;
  excerpt: string;
}

const lineSide = (line: DiffLine, other: DiffLine): NoteSide => {
  if (line.kind === 'del') return 'old';
  if (line.kind === 'add') return 'new';
  if (other.kind === 'del') return 'old';
  return 'new';
};

const numberOn = (line: DiffLine, side: NoteSide): number | null =>
  side === 'old' ? line.oldLine : line.newLine;

/**
 * The anchor for lines `first` to `last` of a parsed diff, in either order.
 * A removed line is on the old side, an added line on the new one, and a
 * context line takes the side of the range's other end (new when both ends
 * are context). Null when either end has no number on its side.
 */
export function anchorFrom(lines: DiffLine[], first: number, last: number): NoteAnchor | null {
  const lo = Math.min(first, last);
  const hi = Math.max(first, last);
  const a = lines[lo];
  const b = lines[hi];
  if (a === undefined || b === undefined) return null;
  const startSide = lineSide(a, b);
  const side = lineSide(b, a);
  const start = numberOn(a, startSide);
  const end = numberOn(b, side);
  if (start === null || end === null) return null;
  return {
    side,
    ...(startSide === side ? {} : { startSide }),
    start,
    end,
    excerpt: excerptOf(a),
  };
}

function excerptOf(line: DiffLine): string {
  return Array.from(line.text.slice(1).trim()).slice(0, EXCERPT_CHARS).join('').trimEnd();
}

/** Path in code-unit order, then the range's start, then when it was made. */
export function orderNotes(notes: readonly ReviewNote[]): ReviewNote[] {
  return [...notes].sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    if (a.start !== b.start) return a.start - b.start;
    return a.createdAt - b.createdAt;
  });
}

/** The notes a Send carries: not sent, not waiting in a live Up next entry,
 * and with something to say. */
export function sendable(
  notes: readonly ReviewNote[],
  isLive: (entryId: string) => boolean,
): ReviewNote[] {
  return notes.filter(
    (n) =>
      n.sentAt === undefined &&
      (n.heldBy === undefined || !isLive(n.heldBy)) &&
      n.text.trim() !== '',
  );
}

const whenOf = (side: NoteSide) => (side === 'new' ? 'after' : 'before');

/** A range in words, from the side of the change it sits on. */
export function describeLines(note: Pick<ReviewNote, 'side' | 'startSide' | 'start' | 'end'>) {
  const { side, startSide, start, end } = note;
  if (startSide !== undefined && startSide !== side) {
    return `from line ${start} ${whenOf(startSide)} your change to line ${end} ${whenOf(side)} it`;
  }
  return start === end
    ? `line ${start} ${whenOf(side)} your change`
    : `lines ${start}–${end} ${whenOf(side)} your change`;
}

/** `path` as inline code: a fence longer than any backtick run in it, padded
 * with a space when the path starts or ends with a backtick. */
export function codeSpan(path: string): string {
  const longest = Math.max(0, ...(path.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  const pad = path.startsWith('`') || path.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${path}${pad}${fence}`;
}

/** "<path>, <lines> (starting "<excerpt>")": the clause drops with no excerpt. */
function where(note: ReviewNote): string {
  const starting = note.excerpt === '' ? '' : ` (starting ${JSON.stringify(note.excerpt)})`;
  return `${codeSpan(note.path)}, ${describeLines(note)}${starting}`;
}

/**
 * The prompt `notes` go to the agent as, in order. The excerpt is vault
 * text, so it is JSON-quoted and reads as data. With one note: "I reviewed
 * your changes and left a note on <path>, <lines> (starting "…"):", a blank
 * line, then the note. With more: a numbered list, each note's later lines
 * indented to its item's width.
 */
export function notesPrompt(notes: readonly ReviewNote[]): string {
  const ordered = orderNotes(notes);
  if (ordered.length === 1) {
    const [note] = ordered;
    return `I reviewed your changes and left a note on ${where(note)}:\n\n${note.text.trim()}`;
  }
  const items = ordered.map((note, i) => {
    const label = `${i + 1}. `;
    const indent = ' '.repeat(label.length);
    const [first, ...rest] = note.text.trim().split('\n');
    const body = [first, ...rest.map((l) => (l === '' ? '' : `${indent}${l}`))].join('\n');
    return `${label}${where(note)}: ${body}`;
  });
  return [
    `I reviewed your changes and left ${ordered.length} notes. Work through them in order:`,
    '',
    ...items,
  ].join('\n');
}

const isSide = (v: unknown): v is NoteSide => v === 'old' || v === 'new';
const isLineNumber = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v > 0;
const isText = (v: unknown): v is string => typeof v === 'string';

/** One stored note, or null when it is malformed; `heldBy` never survives,
 * because Up next lives in memory only (M57 Q24). */
function parseNote(raw: unknown): ReviewNote | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (
    !isText(r.id) ||
    r.id === '' ||
    !isText(r.vault) ||
    !isText(r.conversationId) ||
    !(r.runId === null || isText(r.runId)) ||
    !isText(r.commit) ||
    !isText(r.path) ||
    r.path === '' ||
    !isSide(r.side) ||
    !(r.startSide === undefined || isSide(r.startSide)) ||
    !isLineNumber(r.start) ||
    !isLineNumber(r.end) ||
    !isText(r.excerpt) ||
    !isText(r.text) ||
    r.text.length > MAX_NOTE_CHARS ||
    typeof r.createdAt !== 'number' ||
    !(r.sentAt === undefined || typeof r.sentAt === 'number')
  ) {
    return null;
  }
  return {
    id: r.id,
    vault: r.vault,
    conversationId: r.conversationId,
    runId: r.runId,
    commit: r.commit,
    path: r.path,
    side: r.side,
    ...(r.startSide === undefined || r.startSide === r.side ? {} : { startSide: r.startSide }),
    start: r.start,
    end: r.end,
    excerpt: Array.from(r.excerpt).slice(0, EXCERPT_CHARS).join(''),
    text: r.text,
    createdAt: r.createdAt,
    ...(r.sentAt === undefined ? {} : { sentAt: r.sentAt }),
  };
}

/**
 * `notes` with each conversation held to the caps: the first 30 queued by
 * when they were made, and the last 100 sent by when they went. Order is
 * otherwise kept.
 */
export function capNotes(notes: readonly ReviewNote[]): ReviewNote[] {
  const keep = new Set<string>();
  const byConversation = new Map<string, ReviewNote[]>();
  for (const note of notes) {
    const key = `${note.vault}\u0000${note.conversationId}`;
    byConversation.set(key, [...(byConversation.get(key) ?? []), note]);
  }
  for (const group of byConversation.values()) {
    const queued = group
      .filter((n) => n.sentAt === undefined)
      .sort((a, b) => a.createdAt - b.createdAt);
    const sent = group
      .filter((n) => n.sentAt !== undefined)
      .sort((a, b) => (a.sentAt ?? 0) - (b.sentAt ?? 0));
    for (const n of queued.slice(0, MAX_QUEUED_NOTES)) keep.add(n.id);
    for (const n of sent.slice(-MAX_SENT_NOTES)) keep.add(n.id);
  }
  return notes.filter((n) => keep.has(n.id));
}

/** What `cerebro.reviewNotes` holds, `{v: 1, notes}`, read back: malformed
 * notes and duplicate ids dropped, `heldBy` stripped, the caps applied. */
export function parseStoredNotes(raw: unknown): ReviewNote[] {
  if (typeof raw !== 'object' || raw === null) return [];
  const r = raw as { v?: unknown; notes?: unknown };
  if (r.v !== 1 || !Array.isArray(r.notes)) return [];
  const seen = new Set<string>();
  const notes: ReviewNote[] = [];
  for (const item of r.notes) {
    const note = parseNote(item);
    if (note === null || seen.has(note.id)) continue;
    seen.add(note.id);
    notes.push(note);
  }
  return capNotes(notes);
}
