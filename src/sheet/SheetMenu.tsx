import { useRef, useState } from 'react';
import { Popover } from '@/components/ui/Popover';
import { MenuSurface } from '@/components/ui/Menu';
import { Button } from '@/components/ui/Button';
import { gridChangeProblem, type GridChange } from '@/engine/sheet/gridEdit';
import type { SheetInput } from '@/engine/sheet/fence';
import type { Area } from '@/engine/sheet/selection';
const choices = [
  ['Insert row above', 'insert_rows', 'row', false],
  ['Insert row below', 'insert_rows', 'row', true],
  ['Delete rows', 'delete_rows', 'row', false],
  ['Insert column left', 'insert_columns', 'column', false],
  ['Insert column right', 'insert_columns', 'column', true],
  ['Delete columns', 'delete_columns', 'column', false],
] as const;
export function SheetMenu({
  sheets,
  sheet,
  area,
  disabled,
  onChange,
  onAsk,
}: {
  sheets: SheetInput[];
  sheet: number;
  area: Area;
  disabled: boolean;
  onChange: (change: GridChange, at: number, count: number) => void;
  onAsk?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  return (
    <div ref={anchor}>
      <Button
        size="sm"
        variant="ghost"
        testId="sheet-structure"
        disabled={disabled && !onAsk}
        onClick={() => setOpen(!open)}
      >
        Rows and columns
      </Button>
      {open && (
        <Popover anchorRef={anchor} onClose={() => setOpen(false)} role="menu">
          <MenuSurface className="min-w-44">
            {onAsk && (
              <button
                type="button"
                role="menuitem"
                className="block w-full rounded-sm px-3 py-2 text-left text-xs text-synapse-600 hover:bg-synapse-50"
                onClick={() => {
                  setOpen(false);
                  onAsk();
                }}
              >
                Ask about selection
              </button>
            )}
            {choices.map(([label, change, axis, after]) => {
              const count = axis === 'row' ? area.height : area.width;
              const at = area[axis] + (after ? count : 0);
              return (
                <button
                  key={label}
                  type="button"
                  role="menuitem"
                  className="block w-full rounded-sm px-3 py-2 text-left text-xs text-n-700 hover:bg-n-50 disabled:opacity-40"
                  disabled={
                    disabled || gridChangeProblem(sheets, sheet, change, at, count) !== null
                  }
                  onClick={() => {
                    setOpen(false);
                    onChange(change, at, count);
                  }}
                >
                  {label}
                </button>
              );
            })}
          </MenuSurface>
        </Popover>
      )}
    </div>
  );
}
