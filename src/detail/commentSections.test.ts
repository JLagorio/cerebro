import { describe, expect, it } from 'vitest';
import type { AnchorResolution, CommentAnchor } from '@/engine/commentAnchor';
import { openThreadCount, type CommentThread, type CommentsFile } from '@/engine/comments';
import { ambiguousNote, commentSections, GONE_NOTE, noteText } from './commentSections';

const anchor = (quote: string): CommentAnchor => ({ quote, occurrence: 1, before: '', after: '' });

let n = 0;
function thread(
  created: string,
  over: Partial<CommentThread> & { quote?: string } = {},
): CommentThread {
  n += 1;
  const { quote, ...rest } = over;
  return {
    ...(quote !== undefined ? { anchor: anchor(quote) } : {}),
    comments: [
      {
        id: n.toString(16).padStart(16, '0'),
        author: 'human:owner',
        created,
        body: `comment ${n}`,
      },
    ],
    ...rest,
  };
}

const idOf = (t: CommentThread) => t.comments[0].id;
const file = (...threads: CommentThread[]): CommentsFile => ({ format: 1, threads });
const at = (start: number): AnchorResolution => ({
  kind: 'attached',
  start,
  end: start + 3,
  moved: false,
});
const stamp = (at: string) => ({ at, by: 'human:owner' });

describe('commentSections', () => {
  it('groups threads and orders each section', () => {
    const late = thread('2026-10-01T10:00:00Z', { quote: 'late' });
    const early = thread('2026-10-01T09:00:00Z', { quote: 'early' });
    const pageB = thread('2026-10-03T00:00:00Z');
    const pageA = thread('2026-10-02T00:00:00Z');
    const gone = thread('2026-10-02T12:00:00Z', { quote: 'gone' });
    const waiting = thread('2026-10-04T00:00:00Z', { quote: 'waiting' });
    const resolvedLast = thread('2026-09-01T00:00:00Z', {
      resolved: stamp('2026-10-09T00:00:00Z'),
    });
    const resolvedFirst = thread('2026-09-02T00:00:00Z', {
      quote: 'x',
      resolved: stamp('2026-10-08T00:00:00Z'),
    });
    const resolutions = new Map<string, AnchorResolution>([
      // The later comment sits earlier on the page: position wins.
      [idOf(late), at(4)],
      [idOf(early), at(40)],
      [idOf(gone), { kind: 'detached', reason: 'gone', count: 0 }],
    ]);
    const sections = commentSections(
      file(late, early, pageB, pageA, gone, waiting, resolvedLast, resolvedFirst),
      resolutions,
    );
    expect(sections.onPage.map((s) => s.id)).toEqual([idOf(late), idOf(early)]);
    expect(sections.discussion.map((s) => s.id)).toEqual([idOf(pageA), idOf(gone), idOf(pageB)]);
    expect(sections.unplaced.map((s) => s.id)).toEqual([idOf(waiting)]);
    expect(sections.resolved.map((s) => s.id)).toEqual([idOf(resolvedFirst), idOf(resolvedLast)]);
  });

  it('gives a gone thread and an ambiguous one their notes, and a page thread none', () => {
    const gone = thread('2026-10-01T00:00:00Z', { quote: 'Guarantee 72 hours.' });
    const twice = thread('2026-10-02T00:00:00Z', { quote: 'TBD' });
    const page = thread('2026-10-03T00:00:00Z');
    const { discussion } = commentSections(
      file(gone, twice, page),
      new Map<string, AnchorResolution>([
        [idOf(gone), { kind: 'detached', reason: 'gone', count: 0 }],
        [idOf(twice), { kind: 'detached', reason: 'ambiguous', count: 3 }],
      ]),
    );
    expect(discussion.map((d) => d.note)).toEqual([
      { reason: 'gone' },
      { reason: 'ambiguous', count: 3 },
      null,
    ]);
    expect(noteText({ reason: 'gone' })).toBe(GONE_NOTE);
    expect(noteText({ reason: 'ambiguous', count: 3 })).toBe(ambiguousNote(3));
    expect(ambiguousNote(3)).toBe(
      "This text now appears 3 times on the page, so the comment can't tell which one it meant.",
    );
  });

  it('never reads a thread as gone when there are no resolutions', () => {
    const quoted = thread('2026-10-01T00:00:00Z', { quote: 'q' });
    const page = thread('2026-10-02T00:00:00Z');
    const sections = commentSections(file(quoted, page), null);
    expect(sections.unplaced.map((s) => s.id)).toEqual([idOf(quoted)]);
    expect(sections.discussion.map((s) => [s.id, s.note])).toEqual([[idOf(page), null]]);
    expect(sections.onPage).toEqual([]);
  });

  it('hides deleted threads everywhere, and counts only open ones', () => {
    const open = thread('2026-10-01T00:00:00Z');
    const quoted = thread('2026-10-01T01:00:00Z', { quote: 'q' });
    const deleted = thread('2026-10-01T02:00:00Z', { deleted: stamp('2026-10-05T00:00:00Z') });
    const deletedQuoted = thread('2026-10-01T03:00:00Z', {
      quote: 'q',
      deleted: stamp('2026-10-05T00:00:00Z'),
    });
    const resolved = thread('2026-10-01T04:00:00Z', { resolved: stamp('2026-10-06T00:00:00Z') });
    const all = file(open, quoted, deleted, deletedQuoted, resolved);
    const sections = commentSections(
      all,
      new Map([
        [idOf(quoted), at(0)],
        [idOf(deletedQuoted), at(0)],
      ]),
    );
    const shown = [
      ...sections.onPage,
      ...sections.discussion,
      ...sections.unplaced,
      ...sections.resolved,
    ].map((s) => s.id);
    expect(shown).not.toContain(idOf(deleted));
    expect(shown).not.toContain(idOf(deletedQuoted));
    expect(sections.openCount).toBe(2);
    expect(sections.openCount).toBe(openThreadCount(all));
  });
});
