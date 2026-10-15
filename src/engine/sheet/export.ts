import { encodeCsv } from '@/engine/csv';
import { guardCsvText } from '@/engine/csvExport';
import { slugify } from '@/lib/slug';
import type { SheetCellValue } from './fence';

/** Export shown values, including spills, with absent cells left empty. */
export function sheetCsv(cells: readonly SheetCellValue[]): string {
  const present = cells.filter((cell) => cell.display !== '');
  const rows = Math.max(0, ...present.map((cell) => cell.row));
  const columns = Math.max(0, ...present.map((cell) => cell.col));
  const values = Array.from({ length: rows }, () => Array<string>(columns).fill(''));
  for (const cell of present)
    values[cell.row - 1][cell.col - 1] =
      cell.kind === 'number' || cell.kind === 'boolean' ? cell.display : guardCsvText(cell.display);
  return '\uFEFF' + encodeCsv(values);
}
export const xlsxFileName = (title: string): string => `${slugify(title) || 'workbook'}.xlsx`;
export const csvFileName = (title: string, sheet: string): string =>
  `${slugify(title) || 'workbook'}-${slugify(sheet) || 'sheet'}.csv`;
