import type { RefObject } from 'react';
import { FormulaInput, type FormulaCursor } from './FormulaInput';
export function FormulaBar({
  address,
  value,
  readOnly,
  onChange,
  onFocus,
  onBlur,
  inputRef,
  names,
  sheet,
  row,
  column,
  onContext,
}: {
  address: string;
  value: string;
  readOnly: boolean;
  onChange: (value: string) => void;
  onFocus: () => void;
  onBlur: () => void;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  names: string[];
  sheet: number;
  row: number;
  column: number;
  onContext?: (cursor: FormulaCursor | null) => void;
}) {
  return (
    <div className="flex min-w-0 border-b border-n-200 bg-n-25 text-xs">
      <output
        data-testid="sheet-address"
        className="w-24 shrink-0 border-r border-n-200 px-3 py-2 font-mono text-n-600"
      >
        {address}
      </output>
      <FormulaInput
        inputRef={inputRef}
        testId="sheet-formula-input"
        label="Cell source"
        names={names}
        sheet={sheet}
        row={row}
        column={column}
        onContext={onContext}
        className="min-w-0 flex-1 resize-none bg-transparent px-3 py-2 font-mono text-n-800 outline-none"
        value={value}
        readOnly={readOnly}
        onChange={onChange}
        onFocus={onFocus}
        onBlur={onBlur}
      />
    </div>
  );
}
