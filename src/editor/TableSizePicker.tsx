import { useMemo, useState } from 'react';
import { Popover } from '@/components/ui/Popover';
import { Button } from '@/components/ui/Button';

/** The chosen size includes the Markdown header row. No unsupported table
 * metadata is introduced by the picker. */
export function TableSizePicker({
  anchor,
  onInsert,
  onClose,
  onContinueTyping,
}: {
  anchor: HTMLElement;
  onInsert: (rows: number, columns: number) => void;
  onClose: () => void;
  onContinueTyping: (text: string) => void;
}) {
  const anchorRef = useMemo(() => ({ current: anchor }), [anchor]);
  const [rows, setRows] = useState(3);
  const [columns, setColumns] = useState(3);
  return (
    <Popover
      anchorRef={anchorRef}
      onClose={onClose}
      role="dialog"
      ariaLabel="Insert Markdown table"
      trapFocus
      className="rounded-lg border border-n-200 bg-n-0 p-3 shadow-[var(--shadow-lg)]"
    >
      <div
        data-testid="table-size-picker"
        className="flex flex-col gap-2"
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          // Space on the focused action is native button activation, not
          // continuation text for the document behind this dialog.
          if (event.key === ' ' && event.target instanceof HTMLButtonElement) return;
          if (event.key === 'ArrowDown') setRows((value) => Math.min(12, value + 1));
          else if (event.key === 'ArrowUp') setRows((value) => Math.max(1, value - 1));
          else if (event.key === 'ArrowRight') setColumns((value) => Math.min(12, value + 1));
          else if (event.key === 'ArrowLeft') setColumns((value) => Math.max(1, value - 1));
          else if (event.key === 'Enter') onInsert(rows, columns);
          else if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey)
            onContinueTyping(event.key);
          else return;
          event.preventDefault();
        }}
      >
        <span className="text-sm font-medium text-n-900">Markdown table</span>
        <div
          className="grid gap-1"
          style={{ gridTemplateColumns: 'repeat(8, 20px)' }}
          aria-hidden="true"
        >
          {Array.from({ length: 48 }, (_, index) => {
            const row = Math.floor(index / 8) + 1;
            const column = (index % 8) + 1;
            return (
              <span
                key={index}
                className="h-5 rounded-sm border border-n-300"
                style={{
                  background: row <= rows && column <= columns ? 'var(--cortex-100)' : 'var(--n-0)',
                }}
                onMouseMove={() => {
                  setRows(row);
                  setColumns(column);
                }}
                onClick={() => onInsert(row, column)}
              />
            );
          })}
        </div>
        <span aria-live="polite" className="text-xs text-n-500">
          {rows} rows × {columns} columns · includes header
        </span>
        <Button size="sm" onClick={() => onInsert(rows, columns)}>
          Insert table
        </Button>
        <span className="text-xs text-n-500">
          Arrow keys choose size · Enter inserts · Escape cancels
        </span>
      </div>
    </Popover>
  );
}
