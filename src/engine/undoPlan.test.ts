import { describe, expect, it } from 'vitest';
import type { PageAttribution } from './attribution';
import type { FileResult } from './batch';
import { makeEntry } from './testHelpers';
import {
  addedFromLabel,
  convertedLabel,
  copiedLabel,
  deletedPropertyLabel,
  entryBytes,
  keptItem,
  keptWords,
  kindChangedLabel,
  refusedWords,
  renamedLabel,
  revertOps,
  undidWords,
  undoableFiles,
  whoChanged,
} from './undoPlan';

const H1 = '1'.repeat(64);
const H2 = '2'.repeat(64);

const file = (partial: Partial<FileResult>): FileResult => ({
  path: 'records/a.md',
  beforeHash: H1,
  afterHash: H2,
  before: '---\nstatus: todo\n---\n',
  keys: [],
  trashed: null,
  restored: null,
  skipped: null,
  ...partial,
});

describe('revertOps (M60.7)', () => {
  it('builds one revert per result kind, carrying everything batch.rs reads', () => {
    const patched = file({ keys: [{ key: 'status', before: 'todo', after: 'done' }] });
    const created = file({ path: 'records/new.md', beforeHash: null, before: null });
    const trashed = file({
      path: 'records/b.md',
      afterHash: null,
      trashed: '20261014T093000Z-a1b2',
    });
    const restored = file({
      path: 'records/c.md',
      beforeHash: H2,
      before: '# C\n',
      restored: '20261014T093000Z-c3d4',
    });
    expect(revertOps([patched, created, trashed, restored])).toEqual([
      {
        op: 'revert',
        path: 'records/a.md',
        afterHash: H2,
        before: patched.before,
        keys: patched.keys,
        trashed: null,
        restored: null,
      },
      {
        op: 'revert',
        path: 'records/new.md',
        afterHash: H2,
        before: null,
        keys: [],
        trashed: null,
        restored: null,
      },
      {
        op: 'revert',
        path: 'records/b.md',
        afterHash: null,
        before: trashed.before,
        keys: [],
        trashed: '20261014T093000Z-a1b2',
        restored: null,
      },
      {
        op: 'revert',
        path: 'records/c.md',
        afterHash: H2,
        before: '# C\n',
        keys: [],
        trashed: null,
        restored: '20261014T093000Z-c3d4',
      },
    ]);
  });

  it('leaves out pages nothing changed and anything under knowledge/', () => {
    const skippedWhole = file({ beforeHash: null, afterHash: null, before: null });
    const kept = file({ beforeHash: H2, skipped: { keys: ['status'], reason: null } });
    const bundle = file({ path: 'knowledge/concepts/x.md' });
    expect(undoableFiles([skippedWhole, kept, bundle])).toEqual([]);
    expect(revertOps([skippedWhole, kept, bundle])).toEqual([]);
  });

  it('builds redo from undo’s result the same way: the revert of a revert', () => {
    // Undo of a patch: its result holds the bytes it overwrote and the keys
    // the other way round, so redo reverts those.
    const undone = file({
      beforeHash: H2,
      afterHash: H1,
      before: '---\nstatus: done\n---\n',
      keys: [{ key: 'status', before: 'done', after: 'todo' }],
    });
    expect(revertOps([undone])).toEqual([
      {
        op: 'revert',
        path: 'records/a.md',
        afterHash: H1,
        before: '---\nstatus: done\n---\n',
        keys: [{ key: 'status', before: 'done', after: 'todo' }],
        trashed: null,
        restored: null,
      },
    ]);
  });

  it('counts the pre-images an entry holds', () => {
    expect(entryBytes([file({ before: 'abc' }), file({ before: null })])).toBe(3);
  });
});

describe('undo words (M60.7, Appendix B)', () => {
  const scout = makeEntry({
    path: 'records/agents/release-scout.md',
    title: 'Release scout',
    type: 'Agent',
  });
  const since = Date.parse('2026-10-14T09:00:00Z');
  const recorded = (actor: string | null, at: string): PageAttribution => ({
    state: 'recorded',
    kind: 'vault.write',
    actor,
    run_id: null,
    approved_by: null,
    at,
  });

  it('names who changed a page since only from a recorded write', () => {
    const after = '2026-10-14T09:05:00Z';
    expect(whoChanged(recorded('human:me', after), since, [scout])).toBe('you');
    expect(whoChanged(recorded('process:release-scout', after), since, [scout])).toBe(
      'Release scout',
    );
    const outside: PageAttribution = {
      state: 'unattributed',
      kind: 'vault.write',
      actor: 'human:me',
      run_id: null,
      approved_by: null,
      at: after,
    };
    expect(whoChanged(outside, since, [])).toBe('changed outside Cerebro');
    expect(whoChanged({ state: 'not_recorded' }, since, [])).toBeNull();
    expect(whoChanged({ state: 'knowledge' }, since, [])).toBeNull();
    expect(whoChanged(null, since, []), 'a failed read').toBeNull();
    expect(whoChanged(recorded(null, after), since, []), 'no actor stamped').toBeNull();
    expect(
      whoChanged(recorded('human:me', '2026-10-14T08:00:00Z'), since, []),
      'a write before the change',
    ).toBeNull();
  });

  it('names at most three kept changes, then how many more', () => {
    const items = ['a', 'b', 'c', 'd', 'e'].map((t) => keptItem('status', t, null));
    expect(keptWords('Deleted property “Size”', items)).toBe(
      'Undid: Deleted property “Size”. Kept 5 changes made since: ' +
        'Status on “a”, Status on “b”, Status on “c” and 2 more',
    );
    expect(keptWords('X', [keptItem('due_date', 'Plan', 'changed outside Cerebro')])).toBe(
      'Undid: X. Kept 1 change made since: Due date on “Plan” (changed outside Cerebro)',
    );
  });

  it('says what a refused undo kept, and who changed it when recorded', () => {
    expect(refusedWords('Plan', 'you')).toBe('Nothing was undone: “Plan” changed since (you).');
    expect(refusedWords('Plan', null)).toBe('Nothing was undone: “Plan” changed since.');
  });

  it('labels each change as Appendix B words it', () => {
    expect(renamedLabel('Assignee', 'Assigned to', 12)).toBe(
      'Renamed “Assignee” to “Assigned to” on 12 pages',
    );
    expect(kindChangedLabel('Stake', 'Number', 1)).toBe('Changed “Stake” to Number on 1 page');
    expect(addedFromLabel('Stake number', 'Stake', 3)).toBe(
      'Added “Stake number” from “Stake” on 3 pages',
    );
    expect(copiedLabel('Size', 4)).toBe('Copied “Size” on 4 pages');
    expect(deletedPropertyLabel('Size')).toBe('Deleted property “Size”');
    expect(convertedLabel('Work item')).toBe('Converted to Work item');
    expect(undidWords('Converted to Work item')).toBe('Undid: Converted to Work item');
  });
});
