import { encodeSheetMatrix, normalizeSheetInput } from './edit';
import { cellAddress, type SheetCellSource, type SheetInput } from './fence';
import { SHEET_LIMITS, sheetProblem, workbookProblem, sheetWord } from './limits';

export interface SheetSummary {
  name: string;
  rows: number;
  columns: number;
  filled: number;
  formulas: number;
  hidden: boolean;
}
export interface ImportDifference {
  cell: string;
  before: string;
  after: string;
}
export interface ImportReport {
  charts: number;
  chartSheets: number;
  images: number;
  pivots: number;
  macros: boolean;
  externalLinks: number;
  notes: number;
  tables: number;
  merged: number;
  hidden: number;
  frozen: number;
  conditionalFormats: number;
  formatting: boolean;
  namesInlined: number;
  namesLeft: string[];
  formatsLost: number;
  changed: { count: number; first: ImportDifference[] };
  saved: {
    compared: number;
    differ: number;
    first: ImportDifference[];
    unsaved: number;
    volatile: number;
  };
}
export interface XlsxImport {
  body: string;
  sheets: SheetSummary[];
  report: ImportReport;
}
export type PickedSheet =
  | { kind: 'csv'; name: string; bytesBase64: string }
  | { kind: 'xlsx'; name: string; workbook: XlsxImport };
export interface SheetImportPreview extends XlsxImport {
  file: string;
  title: string;
}
export const emptyImportReport = (): ImportReport => ({
  charts: 0,
  chartSheets: 0,
  images: 0,
  pivots: 0,
  macros: false,
  externalLinks: 0,
  notes: 0,
  tables: 0,
  merged: 0,
  hidden: 0,
  frozen: 0,
  conditionalFormats: 0,
  formatting: false,
  namesInlined: 0,
  namesLeft: [],
  formatsLost: 0,
  changed: { count: 0, first: [] },
  saved: { compared: 0, differ: 0, first: [], unsaved: 0, volatile: 0 },
});
export function defaultPageTitle(filename: string): string {
  return (
    filename
      .replace(/^.*[/\\]/, '')
      .replace(/\.(xlsx|xlsm|csv)$/i, '')
      .trim() || 'Imported sheet'
  );
}
/** CSV follows the grid's input semantics: source text is kept, and IronCalc
 * decides its type. A leading quote keeps literal text, including 00123. */
export function csvSheetBody(
  records: readonly (readonly string[])[],
  toSources: (value: string, address: string) => string = normalizeSheetInput,
): XlsxImport {
  const columns = Math.max(0, ...records.map((row) => row.length));
  if (records.length > SHEET_LIMITS.rows)
    throw new Error(sheetWord('rows', { n: records.length, max: SHEET_LIMITS.rows }));
  if (columns > SHEET_LIMITS.columns)
    throw new Error(sheetWord('columns', { n: columns, max: SHEET_LIMITS.columns }));
  const cells: SheetCellSource[] = [];
  const rows = records.map((record, row) =>
    Array.from({ length: columns }, (_, col) => {
      const source = toSources(record[col] ?? '', cellAddress(row + 1, col + 1));
      if (source !== '') cells.push({ row: row + 1, col: col + 1, source });
      return source;
    }),
  );
  const sheet: SheetInput = { name: 'Sheet1', cells };
  const problem = workbookProblem([sheet]) ?? sheetProblem(sheet);
  if (problem) throw new Error(problem);
  return {
    body: `\`\`\`cerebro-sheet\n${encodeSheetMatrix(rows)}\`\`\`\n`,
    sheets: [
      {
        name: 'Sheet1',
        rows: rows.length,
        columns,
        filled: cells.length,
        formulas: cells.filter((cell) => /^[=+-]/.test(cell.source)).length,
        hidden: false,
      },
    ],
    report: emptyImportReport(),
  };
}
export function sheetPageContent(title: string, body: string): string {
  return `# ${title.trim()}\n\n${body}`;
}
export const importUndoLabel = (title: string) => `Imported “${title.trim()}”`;
const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
function differences(n: number, first: ImportDifference[]): string {
  const examples = first.map((item) => `${item.cell} (${item.before} → ${item.after})`).join(', ');
  return examples + (n > first.length ? ` and ${n - first.length} more` : '');
}
export function importReportLines(r: ImportReport): string[] {
  const lines: string[] = [];
  if (r.charts)
    lines.push(`${count(r.charts, 'chart')} ${r.charts === 1 ? "isn't" : "aren't"} imported.`);
  if (r.chartSheets)
    lines.push(
      `${count(r.chartSheets, 'chart sheet')} ${r.chartSheets === 1 ? "isn't" : "aren't"} imported.`,
    );
  if (r.images)
    lines.push(`${count(r.images, 'image')} ${r.images === 1 ? "isn't" : "aren't"} imported.`);
  if (r.pivots)
    lines.push(
      `${count(r.pivots, 'pivot table')} ${r.pivots === 1 ? 'comes' : 'come'} in as the values the file saved; ${r.pivots === 1 ? "it won't" : "they won't"} refresh.`,
    );
  if (r.macros) lines.push("Macros aren't imported.");
  if (r.externalLinks)
    lines.push(
      `Links to ${count(r.externalLinks, 'other workbook')} aren't kept; formulas that use them show errors.`,
    );
  if (r.tables)
    lines.push(
      `${count(r.tables, 'Excel table')} ${r.tables === 1 ? 'comes' : 'come'} in as plain cells; formulas that used ${r.tables === 1 ? 'it' : 'them'} name the cells instead.`,
    );
  if (r.namesInlined)
    lines.push(
      `${count(r.namesInlined, 'formula')} used named ranges; the names were replaced by the cells they point to.`,
    );
  if (r.namesLeft.length)
    lines.push(
      `These names couldn't be written into formulas, so formulas using them show #NAME?: ${r.namesLeft.join(', ')}.`,
    );
  if (r.hidden)
    lines.push(`${count(r.hidden, 'hidden sheet')} ${r.hidden === 1 ? 'is' : 'are'} shown.`);
  if (r.notes)
    lines.push(`${count(r.notes, 'cell note')} ${r.notes === 1 ? "isn't" : "aren't"} kept.`);
  if (r.merged)
    lines.push(
      `${count(r.merged, 'merged range')} ${r.merged === 1 ? 'comes' : 'come'} in as separate cells.`,
    );
  if (r.frozen)
    lines.push(
      `${count(r.frozen, 'sheet')} ${r.frozen === 1 ? 'loses its' : 'lose their'} frozen panes.`,
    );
  if (r.formatsLost)
    lines.push(
      `${count(r.formatsLost, 'number')} lost ${r.formatsLost === 1 ? 'its' : 'their'} date, currency or other format and ${r.formatsLost === 1 ? 'shows' : 'show'} as plain ${r.formatsLost === 1 ? 'a number' : 'numbers'}.`,
    );
  if (r.formatting) lines.push("Fonts, colours, borders and cell styles aren't kept.");
  if (r.conditionalFormats)
    lines.push(
      `${count(r.conditionalFormats, 'conditional format')} ${r.conditionalFormats === 1 ? "isn't" : "aren't"} kept.`,
    );
  if (r.changed.count)
    lines.push(
      `${count(r.changed.count, 'cell')} ${r.changed.count === 1 ? 'reads' : 'read'} differently here than in the file: ${differences(r.changed.count, r.changed.first)}.`,
    );
  if (r.saved.differ)
    lines.push(
      `${count(r.saved.differ, 'formula')} ${r.saved.differ === 1 ? 'shows' : 'show'} a different value than the file saved: ${differences(r.saved.differ, r.saved.first)}.`,
    );
  if (r.saved.unsaved)
    lines.push(`${count(r.saved.unsaved, 'formula')} had no saved value to compare.`);
  return lines;
}
