import {
  cellAddress,
  columnLabel,
  type SheetCellSource,
  type SheetCellValue,
} from '@/engine/sheet/fence';
import type { SheetState } from './useSheetWorkbook';

export const SHEET_ERROR_TITLES: Record<string, string> = {
  '#DIV/0!': 'Divides by zero.',
  '#NAME?': "Uses a name or function the engine doesn't know.",
  '#REF!': "Points at a cell or sheet that isn't there.",
  '#VALUE!': 'Uses a value of the wrong kind.',
  '#NUM!': 'A number is out of range.',
  '#N/A': 'No value is available.',
  '#CIRC!': 'Depends on itself.',
  '#ERROR!': "The formula can't be read.",
  '#SPILL!': "Its results would cover cells that aren't empty.",
};

/** Shared paint for the Studio reader and the page's editable cells. */
export function sheetCellPresentation(value: SheetCellValue | undefined, input?: string) {
  return {
    title:
      value?.kind === 'error'
        ? SHEET_ERROR_TITLES[value.display]
        : input && /^[=+-]/.test(input)
          ? input
          : undefined,
    className: `${value?.kind === 'number' ? 'text-right' : value?.kind === 'boolean' ? 'text-center' : 'text-left'} ${value?.kind === 'error' ? 'text-danger-600' : 'text-n-800'}`,
    display: value?.display ?? '',
  };
}

export function SheetView({
  state,
  source,
  cells = [],
}: {
  state: SheetState;
  source: string;
  cells?: readonly SheetCellSource[];
}) {
  if (state.status !== 'ready')
    return (
      <section
        data-testid="sheet-block"
        className="my-3 min-w-0 rounded-lg border border-n-200 bg-n-25 p-3 text-sm"
      >
        {state.status === 'pending' ? (
          <div data-testid="sheet-pending" role="status" className="text-n-500">
            Calculating {state.name}…
          </div>
        ) : (
          <>
            <div data-testid="sheet-unavailable" data-reason={state.reason} className="text-n-700">
              {state.message}
            </div>
            <pre
              data-testid="sheet-source"
              className="mt-2 overflow-x-auto whitespace-pre text-xs text-n-600"
            >
              {source}
            </pre>
          </>
        )}
      </section>
    );
  const sheet = state.sheet;
  const values = new Map(sheet.cells.map((cell) => [cellAddress(cell.row, cell.col), cell]));
  const inputs = new Map(cells.map((cell) => [cellAddress(cell.row, cell.col), cell.source]));
  const rows = Math.max(3, sheet.rows);
  const cols = Math.max(3, sheet.cols);
  return (
    <section
      data-testid="sheet-block"
      className="my-3 min-w-0 max-w-full overflow-x-auto rounded-lg border border-n-200"
    >
      <table data-testid="sheet-grid" className="w-max min-w-full border-collapse text-sm">
        <caption
          data-testid="sheet-name"
          className="h-9 border-b border-n-100 bg-n-25 px-3 py-2 text-left text-metadata font-medium text-n-600"
        >
          {sheet.name}
        </caption>
        <thead>
          <tr>
            <th className="w-10 border border-n-100 bg-n-50" aria-label="Row" />
            {Array.from({ length: cols }, (_, col) => (
              <th
                key={col}
                scope="col"
                className="h-8 min-w-30 border border-n-100 bg-n-50 px-3 py-1 text-center text-metadata font-normal text-n-600"
              >
                {columnLabel(col + 1)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rows }, (_, row) => (
            <tr key={row}>
              <th
                scope="row"
                className="border border-n-200 bg-n-50 px-2 py-1 text-right text-xs font-normal text-n-500"
              >
                {row + 1}
              </th>
              {Array.from({ length: cols }, (_, col) => {
                const address = cellAddress(row + 1, col + 1);
                const value = values.get(address);
                const input = inputs.get(address);
                const paint = sheetCellPresentation(value, input);
                return (
                  <td
                    key={col}
                    data-testid="sheet-cell"
                    data-address={address}
                    data-kind={value?.kind ?? 'blank'}
                    title={paint.title}
                    className={`h-8 max-w-72 truncate border border-n-100 px-2.5 py-1 text-ui ${paint.className}`}
                  >
                    {paint.display}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
