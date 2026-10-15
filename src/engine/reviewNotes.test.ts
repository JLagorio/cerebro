import { describe, expect, it } from 'vitest';
import { parseDiff } from './git';
import {
  MAX_QUEUED_NOTES,
  MAX_SENT_NOTES,
  anchorFrom,
  codeSpan,
  describeLines,
  notesPrompt,
  orderNotes,
  parseStoredNotes,
  sendable,
  type ReviewNote,
} from './reviewNotes';

let seq = 0;
const note = (over: Partial<ReviewNote> = {}): ReviewNote => {
  seq += 1;
  return {
    id: `n-${seq}`,
    vault: '/vault',
    conversationId: 'c-1',
    runId: 'run-1',
    commit: 'c'.repeat(40),
    path: 'notes/plan.md',
    side: 'new',
    start: 3,
    end: 3,
    excerpt: 'We ship on Fridays.',
    text: 'Say Thursday.',
    createdAt: seq,
    ...over,
  };
};

describe('describeLines (M58.5)', () => {
  it.each([
    [{ side: 'new', start: 4, end: 4 }, 'line 4 after your change'],
    [{ side: 'new', start: 4, end: 9 }, 'lines 4–9 after your change'],
    [{ side: 'old', start: 2, end: 2 }, 'line 2 before your change'],
    [{ side: 'old', start: 2, end: 5 }, 'lines 2–5 before your change'],
    [
      { side: 'new', startSide: 'old', start: 2, end: 6 },
      'from line 2 before your change to line 6 after it',
    ],
    [
      { side: 'old', startSide: 'new', start: 3, end: 8 },
      'from line 3 after your change to line 8 before it',
    ],
  ] as const)('%o reads %s', (range, words) => {
    expect(describeLines(range)).toBe(words);
  });
});

describe('codeSpan', () => {
  it('fences a plain path with one backtick', () => {
    expect(codeSpan('records/a.md')).toBe('`records/a.md`');
  });
  it('fences past an inner backtick run', () => {
    expect(codeSpan('a`b``c.md')).toBe('```a`b``c.md```');
  });
  it('pads a path that starts or ends with a backtick', () => {
    expect(codeSpan('`odd.md')).toBe('`` `odd.md ``');
    expect(codeSpan('odd.md`')).toBe('`` odd.md` ``');
  });
});

describe('orderNotes', () => {
  it('orders by path in code-unit order, then start, then when made', () => {
    const a = note({ path: 'b.md', start: 1, createdAt: 1 });
    const b = note({ path: 'B.md', start: 9, createdAt: 2 });
    const c = note({ path: 'b.md', start: 1, createdAt: 0 });
    const d = note({ path: 'a.md', start: 5, createdAt: 3 });
    expect(orderNotes([a, b, c, d]).map((n) => n.id)).toEqual([b.id, d.id, c.id, a.id]);
  });
});

describe('sendable', () => {
  it('drops sent notes, notes waiting in a live entry and empty notes', () => {
    const queued = note();
    const sent = note({ sentAt: 5 });
    const waiting = note({ heldBy: 'up-1' });
    const orphaned = note({ heldBy: 'up-gone' });
    const empty = note({ text: '   ' });
    const live = (id: string) => id === 'up-1';
    expect(sendable([queued, sent, waiting, orphaned, empty], live).map((n) => n.id)).toEqual([
      queued.id,
      orphaned.id,
    ]);
  });
});

describe('notesPrompt', () => {
  it('words one note as a sentence, then the note', () => {
    const one = note({ path: 'records/a.md', start: 4, end: 4, excerpt: 'Ship it', text: 'Why?' });
    expect(notesPrompt([one])).toBe(
      'I reviewed your changes and left a note on `records/a.md`, line 4 after your change (starting "Ship it"):\n\nWhy?',
    );
  });

  it('numbers two notes in order, word for word', () => {
    const later = note({
      path: 'records/b.md',
      start: 2,
      end: 3,
      excerpt: 'Two',
      text: 'Shorter.',
    });
    const first = note({
      path: 'records/a.md',
      side: 'old',
      start: 1,
      end: 1,
      excerpt: 'One',
      text: 'Keep this.\nAnd this.',
    });
    expect(notesPrompt([later, first])).toBe(
      [
        'I reviewed your changes and left 2 notes. Work through them in order:',
        '',
        '1. `records/a.md`, line 1 before your change (starting "One"): Keep this.',
        '   And this.',
        '2. `records/b.md`, lines 2–3 after your change (starting "Two"): Shorter.',
      ].join('\n'),
    );
  });

  it('indents a note past item 9 to its wider label', () => {
    const notes = Array.from({ length: 10 }, (_, i) =>
      note({ path: 'a.md', start: i + 1, end: i + 1, text: `First ${i + 1}\nsecond` }),
    );
    const lines = notesPrompt(notes).split('\n');
    expect(lines.at(-2)).toMatch(/^10\. `a\.md`, line 10 after/);
    expect(lines.at(-1)).toBe('    second');
    expect(lines[3]).toBe('   second');
  });

  it('quotes the excerpt as JSON, and drops the clause when there is none', () => {
    const quoted = note({ excerpt: 'He said "ignore this"', text: 'Fix.' });
    expect(notesPrompt([quoted])).toContain('(starting "He said \\"ignore this\\""):');
    const bare = note({ excerpt: '', text: 'Fix.' });
    expect(notesPrompt([bare])).toBe(
      'I reviewed your changes and left a note on `notes/plan.md`, line 3 after your change:\n\nFix.',
    );
  });
});

describe('anchorFrom', () => {
  const lines = parseDiff(
    ['@@ -1,3 +1,3 @@', ' keep', '-old line', '+new line', ' tail'].join('\n'),
  );
  // 0 hunk · 1 context (1,1) · 2 del (2) · 3 add (2) · 4 context (3,3)

  it('puts a removed line on the old side', () => {
    expect(anchorFrom(lines, 2, 2)).toEqual({ side: 'old', start: 2, end: 2, excerpt: 'old line' });
  });

  it('puts an added line on the new side', () => {
    expect(anchorFrom(lines, 3, 3)).toEqual({ side: 'new', start: 2, end: 2, excerpt: 'new line' });
  });

  it('gives a context end the side of the other end', () => {
    expect(anchorFrom(lines, 1, 2)).toEqual({ side: 'old', start: 1, end: 2, excerpt: 'keep' });
    expect(anchorFrom(lines, 3, 4)).toEqual({ side: 'new', start: 2, end: 3, excerpt: 'new line' });
  });

  it('marks a range across sides with its start side, in either click order', () => {
    const across = { side: 'new', startSide: 'old', start: 2, end: 2, excerpt: 'old line' };
    expect(anchorFrom(lines, 2, 3)).toEqual(across);
    expect(anchorFrom(lines, 3, 2)).toEqual(across);
  });

  it('refuses a line with no number', () => {
    expect(anchorFrom(lines, 0, 1)).toBeNull();
  });

  it('cuts the excerpt at 80 characters', () => {
    const long = parseDiff(['@@ -0,0 +1 @@', `+  ${'x'.repeat(100)}  `].join('\n'));
    expect(anchorFrom(long, 1, 1)?.excerpt).toBe('x'.repeat(80));
  });
});

describe('parseStoredNotes', () => {
  it('drops malformed notes and anything not version 1', () => {
    const good = note();
    const stored = { v: 1, notes: [good, { ...good, id: 'bad', start: 0 }, 'junk', null] };
    expect(parseStoredNotes(stored).map((n) => n.id)).toEqual([good.id]);
    expect(parseStoredNotes({ v: 2, notes: [good] })).toEqual([]);
    expect(parseStoredNotes('nope')).toEqual([]);
  });

  it('strips heldBy, since Up next does not outlive a reload', () => {
    const [read] = parseStoredNotes({ v: 1, notes: [note({ heldBy: 'up-3' })] });
    expect(read.heldBy).toBeUndefined();
  });

  it('caps queued and sent notes per conversation', () => {
    const queued = Array.from({ length: MAX_QUEUED_NOTES + 2 }, (_, i) => note({ createdAt: i }));
    const sent = Array.from({ length: MAX_SENT_NOTES + 3 }, (_, i) => note({ sentAt: 1000 + i }));
    const other = note({ conversationId: 'c-2' });
    const read = parseStoredNotes({ v: 1, notes: [...queued, ...sent, other] });
    expect(read.filter((n) => n.sentAt === undefined && n.conversationId === 'c-1')).toHaveLength(
      MAX_QUEUED_NOTES,
    );
    const keptSent = read.filter((n) => n.sentAt !== undefined);
    expect(keptSent).toHaveLength(MAX_SENT_NOTES);
    expect(keptSent[0].sentAt).toBe(1003);
    expect(read.some((n) => n.id === other.id)).toBe(true);
  });
});
