import type { AnchorResolution } from '@/engine/commentAnchor';
import { visibleThreads, type CommentThread, type CommentsFile } from '@/engine/comments';

/**
 * A page's threads, sorted into the Comments panel's sections (M70.2b). Pure:
 * the panel draws what this returns, and the tests read it without an editor.
 *
 * - **On the page**: open threads whose quote the editor found, by where they
 *   sit on the page.
 * - **Discussion**: open threads about the whole page, plus open anchored
 *   threads whose quote is gone or now reads more than once, by when each
 *   began. Each detached one carries its note.
 * - **Unplaced**: open anchored threads the editor has not placed yet, or
 *   cannot, because no editor is open. Unknown, never gone: a missing
 *   resolution says nothing about the quote.
 * - **Resolved**: by when each was resolved.
 *
 * Deleted threads appear nowhere.
 */

export interface SectionThread {
  id: string;
  thread: CommentThread;
}

/** Why an anchored thread sits in Discussion. */
export type DetachedNote = { reason: 'gone' } | { reason: 'ambiguous'; count: number };

export interface DiscussionThread extends SectionThread {
  /** Null for a thread about the whole page. */
  note: DetachedNote | null;
}

export interface CommentSections {
  onPage: SectionThread[];
  discussion: DiscussionThread[];
  unplaced: SectionThread[];
  resolved: SectionThread[];
  /** Open threads: shown and not resolved. */
  openCount: number;
}

export const GONE_NOTE = 'The text this comment was about is no longer on the page.';

export const ambiguousNote = (count: number): string =>
  `This text now appears ${count} times on the page, so the comment can't tell which one it meant.`;

export const noteText = (note: DetachedNote): string =>
  note.reason === 'gone' ? GONE_NOTE : ambiguousNote(note.count);

const createdOf = (thread: CommentThread): string => thread.comments[0]?.created ?? '';

/** A stable order by `key`, file order breaking ties (RFC 3339 UTC sorts as text). */
function byKey<T extends SectionThread>(rows: T[], key: (row: T) => string | number): T[] {
  return rows
    .map((row, i) => ({ row, i, k: key(row) }))
    .sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : a.i - b.i))
    .map(({ row }) => row);
}

export function commentSections(
  file: CommentsFile,
  resolutions: ReadonlyMap<string, AnchorResolution> | null,
): CommentSections {
  const onPage: (SectionThread & { start: number })[] = [];
  const discussion: DiscussionThread[] = [];
  const unplaced: SectionThread[] = [];
  const resolved: SectionThread[] = [];
  for (const { id, thread } of visibleThreads(file)) {
    if (thread.resolved !== undefined) {
      resolved.push({ id, thread });
      continue;
    }
    if (thread.anchor === undefined) {
      discussion.push({ id, thread, note: null });
      continue;
    }
    const at = resolutions?.get(id);
    if (at === undefined) unplaced.push({ id, thread });
    else if (at.kind === 'attached') onPage.push({ id, thread, start: at.start });
    else
      discussion.push({
        id,
        thread,
        note: at.reason === 'gone' ? { reason: 'gone' } : { reason: 'ambiguous', count: at.count },
      });
  }
  return {
    onPage: byKey(onPage, (row) => row.start).map(({ id, thread }) => ({ id, thread })),
    discussion: byKey(discussion, (row) => createdOf(row.thread)),
    unplaced,
    resolved: byKey(resolved, (row) => row.thread.resolved?.at ?? ''),
    openCount: onPage.length + discussion.length + unplaced.length,
  };
}
