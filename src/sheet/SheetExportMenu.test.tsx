import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { SheetExportMenu } from './SheetExportMenu';
import { NotePathContext } from '@/editor/notePath';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import type { SheetComputed } from '@/engine/sheet/fence';
const xlsx = vi.hoisted(() => vi.fn());
const csv = vi.hoisted(() => vi.fn());
vi.mock('@/lib/ipc', () => ({ exportSheetXlsx: xlsx, exportCsv: csv }));
const computed: SheetComputed = {
  ok: true,
  name: 'Budget',
  rows: 1,
  cols: 1,
  cells: [{ row: 1, col: 1, kind: 'number', display: '-12' }],
};
beforeEach(() => {
  xlsx.mockReset().mockResolvedValue('budget.xlsx');
  csv.mockReset().mockResolvedValue('budget-budget.csv');
  useVaultStore.setState({ vaultPath: '/vault', entries: [] });
  vi.spyOn(useUiStore.getState(), 'toast').mockClear();
});
function setup(
  options: {
    computed?: SheetComputed;
    current?: () => boolean;
    getPage?: () => Promise<string>;
    beforeOpen?: () => boolean;
  } = {},
) {
  const getPage = options.getPage ?? vi.fn().mockResolvedValue('live unsaved page');
  const before = options.beforeOpen ?? vi.fn();
  const view = render(
    <NotePathContext.Provider value="budget.md">
      <SheetExportMenu
        sheet="Budget"
        computed={options.computed}
        getPage={getPage}
        beforeOpen={before}
        current={options.current ?? (() => true)}
      />
    </NotePathContext.Provider>,
  );
  fireEvent.click(screen.getByTestId('sheet-export-menu'));
  return { ...view, getPage, before };
}
it('serializes only after choosing Excel, then exports live bytes and names the saved file', async () => {
  const { getPage, before } = setup({ computed });
  expect(before).toHaveBeenCalledOnce();
  expect(getPage).not.toHaveBeenCalled();
  fireEvent.click(screen.getByTestId('sheet-export-xlsx'));
  await waitFor(() => expect(xlsx).toHaveBeenCalledWith('budget.xlsx', 'live unsaved page'));
  expect(useUiStore.getState().toast).toHaveBeenCalledWith('Exported budget.xlsx');
});
it('exports the current calculated CSV and disables absent or stale calculation', async () => {
  const view = setup({ computed });
  fireEvent.click(screen.getByTestId('sheet-export-csv'));
  await waitFor(() => expect(csv).toHaveBeenCalledWith('budget-budget.csv', '\uFEFF-12\r\n'));
  view.unmount();
  const missing = setup();
  expect((screen.getByTestId('sheet-export-csv') as HTMLButtonElement).disabled).toBe(true);
  missing.unmount();
  setup({ computed, current: () => false });
  expect((screen.getByTestId('sheet-export-csv') as HTMLButtonElement).disabled).toBe(true);
});
it('cancel is quiet and failures remain visible without throwing', async () => {
  xlsx.mockResolvedValueOnce(null);
  setup();
  fireEvent.click(screen.getByTestId('sheet-export-xlsx'));
  await waitFor(() => expect(xlsx).toHaveBeenCalledOnce());
  expect(useUiStore.getState().toast).not.toHaveBeenCalled();
  xlsx.mockRejectedValueOnce(new Error('disk full'));
  fireEvent.click(screen.getByTestId('sheet-export-menu'));
  fireEvent.click(screen.getByTestId('sheet-export-xlsx'));
  await waitFor(() =>
    expect(useUiStore.getState().toast).toHaveBeenCalledWith("Couldn't export: disk full"),
  );
});
it('a late serialization cannot open a save dialog after unmount or a vault round trip', async () => {
  let resolve!: (value: string) => void;
  const pending = () =>
    new Promise<string>((r) => {
      resolve = r;
    });
  const view = setup({ getPage: pending });
  fireEvent.click(screen.getByTestId('sheet-export-xlsx'));
  view.unmount();
  await act(async () => resolve('old'));
  expect(xlsx).not.toHaveBeenCalled();
  setup({ getPage: pending });
  fireEvent.click(screen.getByTestId('sheet-export-xlsx'));
  act(() => {
    useVaultStore.setState({ vaultPath: '/other' });
    useVaultStore.setState({ vaultPath: '/vault' });
  });
  await act(async () => resolve('old'));
  expect(xlsx).not.toHaveBeenCalled();
});

it('keeps export closed when the focused cell cannot enter the page source', () => {
  const { getPage } = setup({ computed, beforeOpen: () => false });
  expect(screen.queryByTestId('sheet-export-xlsx')).toBeNull();
  expect(screen.queryByTestId('sheet-export-csv')).toBeNull();
  expect(getPage).not.toHaveBeenCalled();
  expect(csv).not.toHaveBeenCalled();
  expect(xlsx).not.toHaveBeenCalled();
});
