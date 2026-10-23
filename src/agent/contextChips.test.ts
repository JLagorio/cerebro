import { describe, expect, it } from 'vitest';
import {
  chipId,
  fileChip,
  placeChip,
  recordChip,
  resolveChips,
  type ContextChip,
} from '@/agent/contextChips';
import { makeEntry } from '@/test/factories';

const entries = [
  makeEntry({ path: 'work/ship-beta.md', title: 'Ship the beta', type: 'Work item' }),
  makeEntry({ path: 'docs/spec.md', title: 'The spec' }),
];

describe('chipId', () => {
  it('keeps a doc-as-place and the same doc-as-record apart', () => {
    // They mean different things: one says "this is where we are", the other
    // "read this". Collapsing them would make removing one remove both.
    const asPlace = chipId(placeChip({ kind: 'doc', path: 'docs/spec.md' }, { entries }));
    const asRecord = chipId(recordChip('docs/spec.md', entries)!);
    expect(asPlace).not.toBe(asRecord);
  });

  it('is the same for the same place however its selection was reached', () => {
    const board = placeChip({ kind: 'list', id: 'roadmap', collection: null });
    const table = placeChip({ kind: 'list', id: 'roadmap', collection: null });
    expect(chipId(board)).toBe(chipId(table));
  });
});

describe('recordChip', () => {
  it('names the record and carries its type', () => {
    expect(recordChip('work/ship-beta.md', entries)).toEqual({
      kind: 'record',
      path: 'work/ship-beta.md',
      label: 'Ship the beta',
      type: 'Work item',
    });
  });

  it('refuses a path the vault does not hold', () => {
    // A chip for a deleted note would attach an empty note and claim it had.
    expect(recordChip('work/gone.md', entries)).toBeNull();
  });
});

describe('resolveChips', () => {
  const place = placeChip({ kind: 'inbox' });
  const record = recordChip('docs/spec.md', entries)!;
  const added = recordChip('work/ship-beta.md', entries)!;

  it('offers what the app knows and keeps what the user attached', () => {
    expect(resolveChips([place, record], [], [added])).toEqual([place, record, added]);
  });

  it('drops what the user removed', () => {
    expect(resolveChips([place, record], [chipId(record)], [])).toEqual([place]);
  });

  it('lets a deliberate re-add beat an earlier dismissal', () => {
    // Removing a chip and then attaching the same thing on purpose is a
    // request, not a contradiction — and the alternative is a chip the user
    // cannot get back without starting a new conversation.
    const chips = resolveChips([place, record], [chipId(record)], [record]);
    expect(chips).toEqual([place, record]);
  });

  it('draws the page you stand on once, not as a place and a record (M52.3)', () => {
    // Asking about the concept you are reading attaches it as the subject —
    // and the page is already the turn's active note.
    const page = placeChip({ kind: 'doc', path: 'docs/spec.md' }, { entries });
    expect(resolveChips([page], [], [record, added])).toEqual([page, added]);
    // Take the place away and the record is what is left to say "read this".
    expect(resolveChips([page], [chipId(page)], [record])).toEqual([record]);
  });

  it('never lists the same chip twice', () => {
    const chips: ContextChip[] = resolveChips([place, record], [], [record, place]);
    expect(chips.map(chipId)).toEqual([...new Set(chips.map(chipId))]);
  });

  it('keeps an attached file, which no place makes redundant (M91.17)', () => {
    const page = placeChip({ kind: 'doc', path: 'docs/spec.md' }, { entries });
    const report = fileChip('attachments/report.pdf');
    expect(resolveChips([page], [], [report])).toEqual([page, report]);
    expect(resolveChips([page], [chipId(report)], [])).toEqual([page]);
  });
});

/**
 * A file the person attached (M91.17): by its vault path, with its name and
 * its kind from the file-kinds table, under an identity of its own.
 */
describe('fileChip', () => {
  it('names the file and says its kind by the file-kinds table', () => {
    expect(fileChip('attachments/Q3 report.pdf')).toEqual({
      kind: 'file',
      path: 'attachments/Q3 report.pdf',
      label: 'Q3 report.pdf',
      fileKind: 'pdf',
    });
    expect(fileChip('attachments/brief.docx')).toMatchObject({ fileKind: 'document' });
    expect(fileChip('attachments/mystery')).toMatchObject({ fileKind: 'unknown' });
  });

  it('is `file:<path>`, apart from a record or a doc place at the same path', () => {
    const asFile = chipId(fileChip('docs/spec.md'));
    expect(asFile).toBe('file:docs/spec.md');
    expect(asFile).not.toBe(chipId(recordChip('docs/spec.md', entries)!));
    expect(asFile).not.toBe(chipId(placeChip({ kind: 'doc', path: 'docs/spec.md' }, { entries })));
  });

  it('leaves the other kinds’ identities as they were', () => {
    expect(chipId(recordChip('docs/spec.md', entries)!)).toBe('record:docs/spec.md');
    expect(chipId(placeChip({ kind: 'inbox' }))).toMatch(/^place:/);
  });
});
