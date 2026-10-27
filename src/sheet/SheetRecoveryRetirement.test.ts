import { expect, it, vi } from 'vitest';
import { DocumentOwner } from '@/editor/documentOwner';
import {
  bindSheetDrafts,
  canPrepareSheetDraft,
  notifySheetDraftChanged,
  registerSheetDraft,
  settleSheetDrafts,
} from './pendingSheets';
it('retiring a document prevents stale sheet preparation from submitting or restoring its held payload', () => {
  const owner = new DocumentOwner(
    { vaultId: '/vault', path: 'gone.md', ownerId: 'pane' },
    'body',
    vi.fn(),
  );
  const editor = {};
  const prepare = vi.fn(() => true);
  registerSheetDraft(editor, 'sheet-a', prepare, () => ({
    cell: { row: 0, column: 0 },
    text: '  =INVALID(😀\r\n',
    origin: 'bar',
  }));
  bindSheetDrafts(editor, owner, () => [], null);
  notifySheetDraftChanged(editor);
  expect(owner.snapshot().childDrafts?.sheets).toContain('=INVALID');
  expect(owner.retireRecovery()).toBe(true);
  expect(canPrepareSheetDraft(editor, 'sheet-a')).toBe(false);
  settleSheetDrafts(editor);
  notifySheetDraftChanged(editor);
  expect(prepare).not.toHaveBeenCalled();
  expect(owner.snapshot().childDrafts).toEqual({});
});
