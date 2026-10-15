import type { SheetInput } from './fence';

/** Calculation and edit caps share the M67.1 case-file contract. */
export const SHEET_LIMITS = {
  sheets: 20,
  cells: 10_000,
  pageChars: 2_000_000,
  rows: 500,
  columns: 26,
  cellChars: 10_000,
} as const;
export const SHEET_WORDS = {
  sheets: 'This page holds {n} sheets. A page computes at most {max}.',
  outside: 'A sheet cell sits outside the grid, at row {row}, column {col}.',
  cells: "This page's sheets hold {n} filled cells. A page computes at most {max}.",
  pageChars: "This page's sheets hold {n} characters. A page computes at most {max}.",
  rows: 'This sheet reaches row {n}. A sheet holds at most {max} rows.',
  columns: 'This sheet reaches column {n}. A sheet holds at most {max} columns.',
  cellChars:
    'The cell at row {row}, column {col} holds {n} characters. A cell holds at most {max}.',
  arraySize:
    'The formula at row {row}, column {col} asks for {n} rows and {m} columns. A sheet holds at most {maxRows} rows and {maxCols} columns.',
  nameInvalid: '"{name}" can\'t name a sheet. Use 1 to 31 characters, none of \\ / * ? : [ ].',
  nameTaken: 'Another sheet on this page is already named "{name}".',
  stopped: "The sheet engine stopped on this page's sheets.",
} as const;
export const sheetWord = (
  key: keyof typeof SHEET_WORDS,
  values: Record<string, string | number> = {},
) => SHEET_WORDS[key].replace(/\{(\w+)\}/g, (_, key: string) => String(values[key]));
const chars = (text: string) => Array.from(text).length;

/** Upstream materializes literal arrays in full, before our result cap.
 * Quoted text is ignored; computed dimensions remain the engine's concern. */
export function literalArraySize(source: string): [number, number] | null {
  if (!/^[=+-]/.test(source)) return null;
  const text = source.replace(/"(?:[^"]|"")*"/g, '""');
  const number = '[+]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?';
  const calls = new RegExp(
    `\\b(?:SEQUENCE|RANDARRAY|MAKEARRAY)\\s*\\(\\s*(${number})\\s*(?:,\\s*(${number})\\s*)?(?=[,)])`,
    'gi',
  );
  for (const match of text.matchAll(calls)) {
    const rows = Number(match[1]);
    const cols = match[2] === undefined ? 1 : Number(match[2]);
    if (rows > SHEET_LIMITS.rows || cols > SHEET_LIMITS.columns) return [rows, cols];
  }
  return null;
}

export function sheetProblem(sheet: SheetInput): string | null {
  const rows = Math.max(0, ...sheet.cells.map((cell) => cell.row));
  const cols = Math.max(0, ...sheet.cells.map((cell) => cell.col));
  if (rows > SHEET_LIMITS.rows) return sheetWord('rows', { n: rows, max: SHEET_LIMITS.rows });
  if (cols > SHEET_LIMITS.columns)
    return sheetWord('columns', { n: cols, max: SHEET_LIMITS.columns });
  for (const cell of sheet.cells) {
    const n = chars(cell.source);
    if (n > SHEET_LIMITS.cellChars)
      return sheetWord('cellChars', { ...cell, n, max: SHEET_LIMITS.cellChars });
    const size = literalArraySize(cell.source);
    if (size)
      return sheetWord('arraySize', {
        ...cell,
        n: size[0],
        m: size[1],
        maxRows: SHEET_LIMITS.rows,
        maxCols: SHEET_LIMITS.columns,
      });
  }
  return null;
}

export function workbookProblem(sheets: SheetInput[]): string | null {
  if (sheets.length > SHEET_LIMITS.sheets)
    return sheetWord('sheets', { n: sheets.length, max: SHEET_LIMITS.sheets });
  const cells = sheets.flatMap((sheet) => sheet.cells);
  const outside = cells.find(
    (cell) =>
      !Number.isInteger(cell.row) || !Number.isInteger(cell.col) || cell.row <= 0 || cell.col <= 0,
  );
  if (outside) return sheetWord('outside', { row: outside.row, col: outside.col });
  if (cells.length > SHEET_LIMITS.cells)
    return sheetWord('cells', { n: cells.length, max: SHEET_LIMITS.cells });
  const n = cells.reduce((total, cell) => total + chars(cell.source), 0);
  return n > SHEET_LIMITS.pageChars
    ? sheetWord('pageChars', { n, max: SHEET_LIMITS.pageChars })
    : null;
}
