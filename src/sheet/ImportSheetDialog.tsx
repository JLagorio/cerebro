import { useState } from 'react';
import { useOpenPath } from '@/app/useOpenPath';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Input } from '@/components/ui/Input';
import { importReportLines, type SheetImportPreview } from '@/engine/sheet/import';
import { useVaultActionGuard } from '@/hooks/useVaultActionGuard';
import { useVaultStore } from '@/stores/vaultStore';
import { chooseSheetFile, importSheetPage } from './importActions';

export function ImportSheetDialog({ onClose }: { onClose: () => void }) {
  const vault = useVaultStore((state) => state.vaultPath);
  return <ImportRead key={vault ?? ''} onClose={onClose} />;
}
function ImportRead({ onClose }: { onClose: () => void }) {
  const [preview, setPreview] = useState<SheetImportPreview | null>(null);
  const [title, setTitle] = useState('');
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState<'reading' | 'importing' | null>(null);
  const capture = useVaultActionGuard('sheet-import');
  const open = useOpenPath();
  const choose = async () => {
    if (busy) return;
    const current = capture();
    setBusy('reading');
    setProblem('');
    const result = await chooseSheetFile(current);
    if (!current()) return;
    setBusy(null);
    if (!result) return;
    if (!result.ok) {
      setPreview(null);
      setProblem(result.reason);
      return;
    }
    setPreview(result.preview);
    setTitle(result.preview.title);
  };
  const submit = async () => {
    if (!preview || busy) return;
    const current = capture();
    setBusy('importing');
    const path = await importSheetPage(preview, title, current);
    if (!current()) return;
    setBusy(null);
    if (path) {
      onClose();
      open(path);
    }
  };
  const sheets = preview?.sheets.length ?? 0;
  const filled = preview?.sheets.reduce((n, sheet) => n + sheet.filled, 0) ?? 0;
  const formulas = preview?.sheets.reduce((n, sheet) => n + sheet.formulas, 0) ?? 0;
  return (
    <Dialog
      open
      title="Sheet from file"
      onClose={onClose}
      width={680}
      primaryAction={{
        label:
          busy === 'importing'
            ? 'Importing…'
            : `Import ${sheets} ${sheets === 1 ? 'sheet' : 'sheets'}`,
        testId: 'sheet-import-submit',
        disabled: !preview || !title.trim() || /[\r\n]/.test(title) || busy !== null,
        onClick: () => void submit(),
      }}
      secondaryAction={{ label: 'Cancel', onClick: onClose }}
    >
      <div data-testid="sheet-import-dialog" className="space-y-4">
        <p className="text-sm text-n-600">
          Brings an Excel workbook (.xlsx, .xlsm) or a CSV file in as a new page of sheets. Formulas
          stay formulas; values are computed here. To make database records from a CSV, use
          Databases → Import CSV.
        </p>
        <Button
          testId="sheet-import-choose"
          variant="secondary"
          disabled={busy !== null}
          onClick={() => void choose()}
        >
          {busy === 'reading' ? 'Reading the file…' : 'Choose a file…'}
        </Button>
        {problem && (
          <p role="alert" data-testid="sheet-import-problem" className="text-sm text-warn-600">
            {problem}
          </p>
        )}
        {preview && (
          <>
            <p data-testid="sheet-import-summary" className="text-sm font-medium text-n-800">
              {preview.file} · {sheets} {sheets === 1 ? 'sheet' : 'sheets'} · {filled} filled cells
              ·{' '}
              {formulas === 0
                ? 'no formulas'
                : `${formulas} ${formulas === 1 ? 'formula' : 'formulas'}`}
            </p>
            <ul
              data-testid="sheet-import-sheets"
              className="max-h-40 overflow-auto rounded-lg border border-n-200 p-3 text-sm text-n-700"
            >
              {preview.sheets.map((sheet) => (
                <li key={sheet.name}>
                  {sheet.name} · {sheet.rows} × {sheet.columns}
                  {sheet.hidden ? ' · hidden in Excel' : ''}
                </li>
              ))}
            </ul>
            <ul data-testid="sheet-import-report" className="space-y-1 text-xs text-n-600">
              {importReportLines(preview.report).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <label className="block space-y-1 text-xs text-n-600">
              <span>Name the page.</span>
              <Input
                testId="sheet-import-title"
                ariaLabel="Page name"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                width="100%"
              />
            </label>
          </>
        )}
      </div>
    </Dialog>
  );
}
