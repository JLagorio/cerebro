import { describe, expect, it } from 'vitest';
import {
  chipId,
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

  it('never lists the same chip twice', () => {
    const chips: ContextChip[] = resolveChips([place, record], [], [record, place]);
    expect(chips.map(chipId)).toEqual([...new Set(chips.map(chipId))]);
  });
});
