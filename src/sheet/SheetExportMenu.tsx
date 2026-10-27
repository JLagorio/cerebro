import { useContext, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Popover } from '@/components/ui/Popover';
import { MenuSurface } from '@/components/ui/Menu';
import { NotePathContext } from '@/editor/notePath';
import { sheetCsv, csvFileName, xlsxFileName } from '@/engine/sheet/export';
import type { SheetComputed } from '@/engine/sheet/fence';
import { useVaultActionGuard } from '@/hooks/useVaultActionGuard';
import { exportCsv, exportSheetXlsx } from '@/lib/ipc';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

export function SheetExportMenu({
  sheet,
  computed,
  getPage,
  beforeOpen,
  current,
}: {
  sheet: string;
  computed?: SheetComputed;
  getPage: () => Promise<string>;
  beforeOpen: () => boolean | void;
  current: () => boolean;
}) {
  const path = useContext(NotePathContext);
  const title =
    useVaultStore((s) => s.entries.find((e) => e.path === path)?.title) ??
    path?.split('/').pop()?.replace(/\.md$/i, '') ??
    'Workbook';
  const capture = useVaultActionGuard(`${path}:${sheet}`);
  const anchor = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const save = async (kind: 'xlsx' | 'csv') => {
    if (busy || (kind === 'csv' && (!computed || !current()))) return;
    const owned = capture();
    setOpen(false);
    setBusy(true);
    try {
      const name = kind === 'xlsx' ? xlsxFileName(title) : csvFileName(title, sheet);
      const data = kind === 'xlsx' ? await getPage() : sheetCsv(computed!.cells);
      if (!owned()) return;
      const result =
        kind === 'xlsx' ? await exportSheetXlsx(name, data) : await exportCsv(name, data);
      if (owned() && result) useUiStore.getState().toast(`Exported ${result.split(/[\\/]/).pop()}`);
    } catch (error) {
      if (owned())
        useUiStore
          .getState()
          .toast(`Couldn't export: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (owned()) setBusy(false);
    }
  };
  return (
    <div ref={anchor}>
      <Button
        size="sm"
        variant="ghost"
        testId="sheet-export-menu"
        disabled={busy}
        onClick={() => {
          if (beforeOpen() === false) return;
          setOpen(!open);
        }}
      >
        <span aria-hidden="true">⋯</span>
        <span className="sr-only">Export sheet</span>
      </Button>
      {open && (
        <Popover anchorRef={anchor} onClose={() => setOpen(false)} role="menu">
          <MenuSurface className="min-w-60">
            <button
              type="button"
              role="menuitem"
              data-testid="sheet-export-xlsx"
              className="block w-full rounded-sm px-3 py-2 text-left text-xs text-n-700 hover:bg-n-50"
              onClick={() => void save('xlsx')}
            >
              Export workbook as Excel…
            </button>
            <button
              type="button"
              role="menuitem"
              data-testid="sheet-export-csv"
              className="block w-full rounded-sm px-3 py-2 text-left text-xs text-n-700 hover:bg-n-50 disabled:opacity-40"
              disabled={!computed || !current()}
              onClick={() => void save('csv')}
            >
              Export this sheet as CSV…
            </button>
          </MenuSurface>
        </Popover>
      )}
    </div>
  );
}
