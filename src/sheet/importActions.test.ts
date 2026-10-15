import { beforeEach, expect, it, vi } from 'vitest';
import { makeEntry } from '@/test/factories';
import { csvSheetBody } from '@/engine/sheet/import';
import { useVaultStore } from '@/stores/vaultStore';
import { useUiStore } from '@/stores/uiStore';
import { chooseSheetFile, importSheetPage } from './importActions';
const pick = vi.hoisted(() => vi.fn());
const scan = vi.hoisted(() => vi.fn());
vi.mock('@/lib/ipc', () => ({ pickSheetFile: pick, scanVault: scan }));
const apply = vi.fn();
const preview = { ...csvSheetBody([['1', '=A1*2']]), file: 'Book.csv', title: 'Book' };
beforeEach(() => {
  pick.mockReset();
  scan.mockReset().mockResolvedValue([]);
  apply.mockReset().mockResolvedValue({});
  useVaultStore.setState({
    vaultPath: '/vault',
    entriesVault: '/vault',
    status: 'ready',
    entries: [],
    applyBatch: apply,
  });
  useUiStore.setState({ toasts: [] });
});
it('cancel and native refusal never write; CSV uses the existing decoder and keeps blank rows', async () => {
  pick.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('Cannot read workbook'));
  expect(await chooseSheetFile()).toBeNull();
  expect(await chooseSheetFile()).toEqual({ ok: false, reason: 'Cannot read workbook' });
  pick.mockResolvedValue({
    kind: 'csv',
    name: 'Budget.csv',
    bytesBase64: btoa('a,b\r\n\r\n1,2\r\n'),
  });
  expect(await chooseSheetFile()).toMatchObject({
    ok: true,
    preview: { title: 'Budget', sheets: [{ rows: 3 }] },
  });
  expect(apply).not.toHaveBeenCalled();
});
it('refuses bad UTF-8 and malformed CSV before a preview is offered', async () => {
  pick.mockResolvedValue({
    kind: 'csv',
    name: 'bad.csv',
    bytesBase64: btoa(String.fromCharCode(0xc3, 0x28)),
  });
  expect(await chooseSheetFile()).toMatchObject({
    ok: false,
    reason: expect.stringContaining('UTF-8'),
  });
  pick.mockResolvedValue({ kind: 'csv', name: 'bad.csv', bytesBase64: btoa('"never closed') });
  expect(await chooseSheetFile()).toMatchObject({
    ok: false,
    reason: 'Row 1: a quote is never closed.',
  });
});
it('rechecks names then creates one root page in one labelled batch', async () => {
  scan.mockResolvedValue([makeEntry({ path: 'book.md' })]);
  expect(await importSheetPage(preview, ' Book ')).toBe('book-2.md');
  expect(apply).toHaveBeenCalledExactlyOnceWith(
    [{ op: 'create', path: 'book-2.md', content: `# Book\n\n${preview.body}` }],
    { undo: 'Imported “Book”' },
  );
});
it('never writes on scan failure, owner dismissal, or a vault round trip', async () => {
  scan.mockRejectedValueOnce(new Error('offline'));
  expect(await importSheetPage(preview, 'Book')).toBeNull();
  expect(await importSheetPage(preview, 'Book', () => false)).toBeNull();
  let resolve!: (entries: never[]) => void;
  scan.mockReturnValueOnce(
    new Promise((r) => {
      resolve = r;
    }),
  );
  const pending = importSheetPage(preview, 'Book');
  useVaultStore.setState({ vaultPath: '/other' });
  useVaultStore.setState({ vaultPath: '/vault' });
  resolve([]);
  expect(await pending).toBeNull();
  expect(apply).not.toHaveBeenCalled();
});
it('invalid title and batch refusal never throw or claim a created path', async () => {
  expect(await importSheetPage(preview, '')).toBeNull();
  expect(await importSheetPage(preview, 'bad\nname')).toBeNull();
  apply.mockResolvedValueOnce(null);
  expect(await importSheetPage(preview, 'Book')).toBeNull();
  apply.mockRejectedValueOnce(new Error('disk'));
  expect(await importSheetPage(preview, 'Book')).toBeNull();
});
