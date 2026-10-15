import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { csvSheetBody } from '@/engine/sheet/import';
import { useVaultStore } from '@/stores/vaultStore';
import { ImportSheetDialog } from './ImportSheetDialog';
const choose = vi.hoisted(() => vi.fn());
const importPage = vi.hoisted(() => vi.fn());
const open = vi.hoisted(() => vi.fn());
vi.mock('./importActions', () => ({ chooseSheetFile: choose, importSheetPage: importPage }));
vi.mock('@/app/useOpenPath', () => ({ useOpenPath: () => open }));
const preview = { ...csvSheetBody([['1', '=A1+2']]), file: 'Book.csv', title: 'Book' };
beforeEach(() => {
  choose.mockReset().mockResolvedValue({ ok: true, preview });
  importPage.mockReset().mockResolvedValue('book.md');
  open.mockReset();
  useVaultStore.setState({ vaultPath: '/vault' });
});
it('previews without a write, reports the source, and opens only after Import succeeds', async () => {
  const close = vi.fn();
  render(<ImportSheetDialog onClose={close} />);
  expect((screen.getByTestId('sheet-import-submit') as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByTestId('sheet-import-choose'));
  expect((await screen.findByTestId('sheet-import-summary')).textContent).toBe(
    'Book.csv · 1 sheet · 2 filled cells · 1 formula',
  );
  expect(importPage).not.toHaveBeenCalled();
  fireEvent.change(screen.getByTestId('sheet-import-title'), { target: { value: 'Budget' } });
  fireEvent.click(screen.getByTestId('sheet-import-submit'));
  await waitFor(() =>
    expect(importPage).toHaveBeenCalledWith(preview, 'Budget', expect.any(Function)),
  );
  await waitFor(() => expect(open).toHaveBeenCalledWith('book.md'));
  expect(close).toHaveBeenCalledOnce();
});
it('a refused file clears the previous preview and explains why', async () => {
  render(<ImportSheetDialog onClose={vi.fn()} />);
  fireEvent.click(screen.getByTestId('sheet-import-choose'));
  await screen.findByTestId('sheet-import-summary');
  choose.mockResolvedValueOnce({ ok: false, reason: 'A quote is never closed.' });
  fireEvent.click(screen.getByTestId('sheet-import-choose'));
  expect((await screen.findByTestId('sheet-import-problem')).textContent).toBe(
    'A quote is never closed.',
  );
  expect(screen.queryByTestId('sheet-import-summary')).toBeNull();
  expect(importPage).not.toHaveBeenCalled();
});
it('dismissal and a vault change retire pending reads and writes', async () => {
  let resolve!: (result: unknown) => void;
  choose.mockReturnValueOnce(
    new Promise((r) => {
      resolve = r;
    }),
  );
  const view = render(<ImportSheetDialog onClose={vi.fn()} />);
  fireEvent.click(screen.getByTestId('sheet-import-choose'));
  act(() => useVaultStore.setState({ vaultPath: '/other' }));
  await act(async () => resolve({ ok: true, preview }));
  expect(screen.queryByTestId('sheet-import-summary')).toBeNull();
  fireEvent.click(screen.getByTestId('sheet-import-choose'));
  await screen.findByTestId('sheet-import-summary');
  let finish!: (path: string) => void;
  importPage.mockReturnValueOnce(
    new Promise((r) => {
      finish = r;
    }),
  );
  fireEvent.click(screen.getByTestId('sheet-import-submit'));
  const guard = importPage.mock.calls[0][2] as () => boolean;
  view.unmount();
  expect(guard()).toBe(false);
  await act(async () => finish('book.md'));
  expect(open).not.toHaveBeenCalled();
});
