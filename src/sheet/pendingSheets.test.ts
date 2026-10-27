import { describe, expect, it, vi } from 'vitest';
import { DocumentOwner } from '@/editor/documentOwner';
import type { SheetSource } from '@/engine/sheet/gridEdit';
import {
  bindSheetDrafts,
  canPrepareSheetDraft,
  detachSheetDrafts,
  notifySheetDraftChanged,
  pendingSheetDrafts,
  registerSheetDraft,
  settleSheetDrafts,
  type SheetDraftSnapshot,
} from './pendingSheets';

const exact: SheetDraftSnapshot = {
  cell: { row: 0, column: 0 },
  text: '  original draft  ',
  origin: 'bar',
};
function document() {
  const write = vi.fn().mockResolvedValue({ kind: 'file', contentHash: 'accepted' });
  const owner = new DocumentOwner(
    { vaultId: '/vault', path: 'page.md', ownerId: 'p1' },
    'body',
    write,
  );
  return { owner, write };
}
function editor(sources: SheetSource[]) {
  const host = { sources };
  const cells = new Map<string, SheetDraftSnapshot | null>();
  const prepares = new Map<string, ReturnType<typeof vi.fn>>();
  for (const sheet of sources) {
    cells.set(sheet.id, null);
    const prepare = vi.fn(() => {
      cells.set(sheet.id, null);
      return true;
    });
    prepares.set(sheet.id, prepare);
    registerSheetDraft(host, sheet.id, prepare, () => cells.get(sheet.id) ?? null, {
      sources: () => host.sources,
      restore: (draft) => cells.set(sheet.id, draft),
    });
  }
  return {
    host,
    cells,
    prepares,
    edit(id: string, draft: SheetDraftSnapshot = exact) {
      cells.set(id, draft);
      notifySheetDraftChanged(host);
    },
  };
}
describe('document-owned sheet draft transfer', () => {
  it('keeps detached draft bytes and blocks a clean document without invoking an old writer', async () => {
    const { owner, write } = document();
    const old = editor([{ id: 'old', source: '1' }]);
    bindSheetDrafts(old.host, owner, () => old.host.sources, null);
    old.edit('old');
    detachSheetDrafts(old.host);
    expect(() => settleSheetDrafts(old.host)).toThrow();
    expect(old.prepares.get('old')).not.toHaveBeenCalled();
    owner.acceptExternal('outside body');
    expect(await owner.flush()).toMatchObject({ kind: 'blocked', reason: 'choice' });
    expect(write).not.toHaveBeenCalled();
    expect(owner.snapshot().childDrafts?.sheets).toContain('  original draft  ');
  });
  it('matches unique source after reordered regenerated ids and ignores late old cleanup', () => {
    const { owner } = document();
    const old = editor([
      { id: 'a', source: '1' },
      { id: 'b', source: '2' },
    ]);
    bindSheetDrafts(old.host, owner, () => old.host.sources, null);
    old.edit('b');
    detachSheetDrafts(old.host);
    const next = editor([
      { id: 'new-b', source: '2' },
      { id: 'new-a', source: '1' },
    ]);
    bindSheetDrafts(next.host, owner, () => next.host.sources, next.host.sources);
    expect(next.cells.get('new-b')).toEqual(exact);
    expect(next.cells.get('new-a')).toBeNull();
    old.cells.set('b', null);
    notifySheetDraftChanged(old.host);
    expect(owner.snapshot().childDrafts?.sheets).toContain('  original draft  ');
    settleSheetDrafts(next.host);
    expect(next.prepares.get('new-b')).toHaveBeenCalledOnce();
    expect(owner.snapshot().childDrafts).toEqual({});
  });
  it('does not infer the original of identical sheets after one disappears', () => {
    const { owner } = document();
    const old = editor([
      { id: 'a', source: '1' },
      { id: 'b', source: '1' },
    ]);
    bindSheetDrafts(old.host, owner, () => old.host.sources, null);
    old.edit('b');
    detachSheetDrafts(old.host);
    const next = editor([{ id: 'new', source: '1' }]);
    bindSheetDrafts(next.host, owner, () => next.host.sources, next.host.sources);
    expect(next.cells.get('new')).toBeNull();
    expect(pendingSheetDrafts(next.host)).toEqual([{ id: 'b', draft: exact }]);
    expect(() => settleSheetDrafts(next.host)).toThrow();
  });
  it('holds a mounted cell changed outside while allowing unrelated peer-cell changes', () => {
    const { owner } = document();
    const live = editor([{ id: 'same', source: '1,2' }]);
    bindSheetDrafts(live.host, owner, () => live.host.sources, null);
    live.edit('same');
    live.host.sources = [{ id: 'same', source: '99,2' }];
    expect(canPrepareSheetDraft(live.host, 'same')).toBe(false);
    expect(() => settleSheetDrafts(live.host)).toThrow();
    expect(live.prepares.get('same')).not.toHaveBeenCalled();
    live.host.sources = [{ id: 'same', source: '1,3' }];
    expect(canPrepareSheetDraft(live.host, 'same')).toBe(true);
    settleSheetDrafts(live.host);
    expect(owner.snapshot().childDrafts).toEqual({});
  });
});

it('restores a replaced node view by exact source without a document binding, never by reused id', () => {
  const host = {};
  let sources = [{ id: 'same-id', source: '1' }];
  let draft: SheetDraftSnapshot | null = exact;
  const release = registerSheetDraft(
    host,
    'same-id',
    () => false,
    () => draft,
    {
      sources: () => sources,
      restore: (value) => {
        draft = value;
      },
    },
  );
  notifySheetDraftChanged(host);
  release();
  let nextDraft: SheetDraftSnapshot | null = null;
  sources = [{ id: 'same-id', source: '99' }];
  const releaseWrong = registerSheetDraft(
    host,
    'same-id',
    () => true,
    () => nextDraft,
    {
      sources: () => sources,
      restore: (value) => {
        nextDraft = value;
      },
    },
  );
  expect(nextDraft).toBeNull();
  expect(() => settleSheetDrafts(host)).toThrow();
  releaseWrong();
  sources = [{ id: 'new-id', source: '1' }];
  registerSheetDraft(
    host,
    'new-id',
    () => true,
    () => nextDraft,
    {
      sources: () => sources,
      restore: (value) => {
        nextDraft = value;
      },
    },
  );
  expect(nextDraft).toEqual(exact);
});
