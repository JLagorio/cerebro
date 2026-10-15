import { utf8Length } from '@/engine/comments';
import { csvProblemText, readCsvRecords } from '@/engine/csv';
import { encodeSheetSource, normalizeSheetInput } from './edit';
import { columnLabel, parseSheetFence, type SheetCellSource, type SheetInput } from './fence';
import { SHEET_LIMITS, sheetWord, sheetProblem, workbookProblem } from './limits';
import { a1, bounds, type Area, type Cell, type Range } from './selection';

export type Matrix = readonly (readonly string[])[];
export type GridChange = 'insert_rows' | 'delete_rows' | 'insert_columns' | 'delete_columns';
/** Engine structure results use zero-based coordinates, like the grid. */
export interface FormulaCell extends Cell {
  sheet: number;
  source: string;
}
export interface RestructureResult {
  before: FormulaCell[];
  after: FormulaCell[];
}
export type FillAxis = 'rows' | 'columns';
export interface FillResult {
  source: string[][];
  target: string[][];
}
export interface FillTarget {
  axis: FillAxis;
  to: number;
  area: Area;
}
/** The larger overshoot chooses the axis. A release inside is a cancellation. */
export function fillTarget(source: Area, cell: Cell): FillTarget | null {
  const bottom = source.row + source.height - 1;
  const right = source.column + source.width - 1;
  const dy = Math.max(source.row - cell.row, cell.row - bottom, 0);
  const dx = Math.max(source.column - cell.column, cell.column - right, 0);
  if (!dx && !dy) return null;
  if (dy >= dx) {
    const row = Math.min(source.row, cell.row);
    return {
      axis: 'rows',
      to: cell.row,
      area: { ...source, row, height: Math.max(bottom, cell.row) - row + 1 },
    };
  }
  const column = Math.min(source.column, cell.column);
  return {
    axis: 'columns',
    to: cell.column,
    area: { ...source, column, width: Math.max(right, cell.column) - column + 1 },
  };
}
/** Only new cells are returned by the engine. Equal engine text preserves the
 * source's spelling, including quoted literals, percentages and formula case. */
export function mergeFill(
  matrix: Matrix,
  area: Area,
  axis: FillAxis,
  to: number,
  result: FillResult,
): string[][] {
  const rows = matrix.map((row) => [...row]);
  const start = axis === 'rows' ? area.row : area.column;
  const length = axis === 'rows' ? area.height : area.width;
  const end = start + length - 1;
  const targetStart = to < start ? to : end + 1;
  for (let r = 0; r < result.target.length; r++)
    for (let c = 0; c < result.target[r].length; c++) {
      const position = targetStart + (axis === 'rows' ? r : c);
      const sourceOffset =
        to < start ? length - 1 - ((start - 1 - position) % length) : (position - end - 1) % length;
      const sr = axis === 'rows' ? sourceOffset : r;
      const sc = axis === 'columns' ? sourceOffset : c;
      const value = result.target[r][c];
      const original = matrix[area.row + sr]?.[area.column + sc] ?? '';
      const exact = value === result.source[sr]?.[sc] ? original : value;
      put(
        rows,
        {
          row: axis === 'rows' ? position : area.row + r,
          column: axis === 'columns' ? position : area.column + c,
        },
        exact,
      );
    }
  return trimBlankEdges(rows);
}
export function fillProblem(
  sheets: readonly SheetInput[],
  sheet: number,
  area: Area,
  axis: FillAxis,
  to: number,
): string | null {
  if (!sheets[sheet]) return "That sheet isn't on this page.";
  if (
    !Number.isInteger(to) ||
    ![area.row, area.column, area.width, area.height].every(Number.isInteger) ||
    area.width < 1 ||
    area.height < 1
  )
    return 'Choose at least one cell to fill from.';
  try {
    checkArea(area);
  } catch (error) {
    return (error as Error).message;
  }
  const start = axis === 'rows' ? area.row : area.column;
  const end = start + (axis === 'rows' ? area.height : area.width) - 1;
  if (to >= start && to <= end) return 'Fill to a cell outside the selected cells.';
  if (to < 0) return 'Choose cells inside the sheet.';
  if (axis === 'rows' && to >= SHEET_LIMITS.rows)
    return sheetWord('rows', { n: to + 1, max: SHEET_LIMITS.rows });
  if (axis === 'columns' && to >= SHEET_LIMITS.columns)
    return sheetWord('columns', { n: to + 1, max: SHEET_LIMITS.columns });
  return null;
}
export interface SheetSource {
  id: string;
  source: string;
}
export const CLIPBOARD_BYTES = 1024 * 1024;

export function matrixOf(cells: readonly SheetCellSource[]): string[][] {
  const matrix: string[][] = [];
  for (const cell of cells) {
    while (matrix.length < cell.row) matrix.push([]);
    const row = matrix[cell.row - 1];
    while (row.length < cell.col) row.push('');
    row[cell.col - 1] = cell.source;
  }
  return matrix;
}
export function cellsOf(matrix: Matrix): SheetCellSource[] {
  return matrix.flatMap((row, r) =>
    row.flatMap((source, c) => (source === '' ? [] : [{ row: r + 1, col: c + 1, source }])),
  );
}
function checkArea(area: Area): void {
  if (
    area.row < 0 ||
    area.column < 0 ||
    area.width < 1 ||
    area.height < 1 ||
    ![area.row, area.column, area.width, area.height].every(Number.isInteger)
  )
    throw new Error('Choose cells inside the sheet.');
  if (area.row + area.height > SHEET_LIMITS.rows)
    throw new Error(sheetWord('rows', { n: area.row + area.height, max: SHEET_LIMITS.rows }));
  if (area.column + area.width > SHEET_LIMITS.columns)
    throw new Error(
      sheetWord('columns', { n: area.column + area.width, max: SHEET_LIMITS.columns }),
    );
}
function put(matrix: string[][], cell: Cell, value: string): void {
  while (matrix.length <= cell.row) matrix.push([]);
  const row = matrix[cell.row];
  while (row.length <= cell.column) row.push('');
  row[cell.column] = value;
}
export function trimBlankEdges(matrix: Matrix): string[][] {
  const rows = matrix.map((row) => {
    const copy = [...row];
    while (copy.at(-1) === '') copy.pop();
    return copy;
  });
  while (rows.at(-1)?.length === 0) rows.pop();
  return rows;
}
export function setInput(matrix: Matrix, cell: Cell, input: string): string[][] {
  checkArea({ ...cell, width: 1, height: 1 });
  const rows = matrix.map((row) => [...row]);
  put(rows, cell, normalizeSheetInput(input, a1(cell)));
  return trimBlankEdges(rows);
}
export function clearArea(matrix: Matrix, area: Area): string[][] {
  checkArea(area);
  return trimBlankEdges(
    matrix.map((row, r) =>
      row.map((source, c) =>
        r >= area.row &&
        r < area.row + area.height &&
        c >= area.column &&
        c < area.column + area.width
          ? ''
          : source,
      ),
    ),
  );
}
export function pasteBlock(
  matrix: Matrix,
  range: Range,
  block: Matrix,
): { rows: string[][]; area: Area } {
  const width = Math.max(1, ...block.map((row) => row.length));
  const height = Math.max(1, block.length);
  const fill = width === 1 && height === 1;
  const area = fill ? bounds(range) : { ...range.active, width, height };
  checkArea(area);
  const rows = matrix.map((row) => [...row]);
  for (let r = 0; r < area.height; r++)
    for (let c = 0; c < area.width; c++) {
      const cell = { row: area.row + r, column: area.column + c };
      put(rows, cell, normalizeSheetInput(block[fill ? 0 : r]?.[fill ? 0 : c] ?? '', a1(cell)));
    }
  return { rows: trimBlankEdges(rows), area };
}
/** Q16: two equally wide comma records count as CSV; otherwise plain lines
 * stay whole. An explicit CSV MIME or a tab is unambiguous. */
export function clipboardTable(raw: string, mime = 'text/plain'): string[][] {
  if (utf8Length(raw) > CLIPBOARD_BYTES)
    throw new Error('That paste is over 1 MB. Paste less at a time.');
  const text = raw.replace(/^\uFEFF/, '');
  const explicit = mime === 'text/csv' || text.includes('\t');
  const parsed = readCsvRecords(text, text.includes('\t') && mime !== 'text/csv' ? '\t' : ',');
  if (explicit) {
    if (parsed.problems.length) throw new Error(csvProblemText(parsed.problems[0]));
    return parsed.records.length ? parsed.records : [['']];
  }
  if (
    !parsed.problems.length &&
    parsed.records.length >= 2 &&
    parsed.records[0].length >= 2 &&
    parsed.records.every((row) => row.length === parsed.records[0].length)
  )
    return parsed.records;
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  return lines.map((line) => [line]);
}
export function preOpCell(cell: Cell, change: GridChange, at: number, count: number): Cell | null {
  const axis = change.endsWith('rows') ? 'row' : 'column';
  if (cell[axis] < at) return cell;
  if (change.startsWith('insert')) {
    if (cell[axis] < at + count) return null;
    return { ...cell, [axis]: cell[axis] - count };
  }
  return { ...cell, [axis]: cell[axis] + count };
}
export function shiftMatrix(
  matrix: Matrix,
  change: GridChange,
  at: number,
  count: number,
): string[][] {
  const rows = matrix.map((row) => [...row]);
  const insert = change.startsWith('insert');
  if (change.endsWith('rows')) {
    if (at <= rows.length)
      rows.splice(at, insert ? 0 : count, ...Array.from({ length: insert ? count : 0 }, () => []));
  } else
    for (const row of rows) {
      if (at <= row.length)
        row.splice(at, insert ? 0 : count, ...Array<string>(insert ? count : 0).fill(''));
    }
  return trimBlankEdges(rows);
}
/** Engine spelling wins only for a rewritten formula. A byte-for-byte
 * unchanged engine formula retains the person's original case and spacing. */
export function mergeRestructure(
  matrices: readonly Matrix[],
  sheet: number,
  change: GridChange,
  at: number,
  count: number,
  result: RestructureResult,
): string[][][] {
  const rows = matrices.map((matrix, index) =>
    index === sheet ? shiftMatrix(matrix, change, at, count) : matrix.map((row) => [...row]),
  );
  const before = new Map(
    result.before.map((cell) => [`${cell.sheet}:${cell.row}:${cell.column}`, cell.source]),
  );
  for (const cell of result.after) {
    const original = cell.sheet === sheet ? preOpCell(cell, change, at, count) : cell;
    if (!original || before.get(`${cell.sheet}:${original.row}:${original.column}`) !== cell.source)
      put(rows[cell.sheet], cell, cell.source);
  }
  return rows.map(trimBlankEdges);
}
export function nextSheetName(names: readonly string[]): string {
  const taken = new Set(names.map((name) => name.toUpperCase()));
  let n = 1;
  while (taken.has(`SHEET${n}`)) n++;
  return `Sheet${n}`;
}
export function newSheetSource(name: string): string {
  return encodeSheetSource(`---\nformat: 1\nname: ${JSON.stringify(name)}\n---\n`, []);
}
export function changedSheets(
  sources: readonly SheetSource[],
  matrices: readonly Matrix[],
): SheetSource[] {
  const inputs = matrices.map((matrix, index) => ({ name: String(index), cells: cellsOf(matrix) }));
  const problem =
    workbookProblem(inputs) ?? inputs.map(sheetProblem).find((value) => value !== null);
  if (problem) throw new Error(problem);
  return sources.flatMap((sheet, index) => {
    const parsed = parseSheetFence(sheet.source);
    if (
      parsed.ok &&
      JSON.stringify(trimBlankEdges(matrixOf(parsed.cells))) ===
        JSON.stringify(trimBlankEdges(matrices[index]))
    )
      return [];
    const source = encodeSheetSource(sheet.source, cellsOf(matrices[index]));
    return source === sheet.source ? [] : [{ ...sheet, source }];
  });
}
export function sameSources(a: readonly SheetSource[], b: readonly SheetSource[]): boolean {
  return (
    a.length === b.length &&
    a.every((sheet, index) => sheet.id === b[index].id && sheet.source === b[index].source)
  );
}

/** Replayed with the native structural door by sheet-grid-ops.json. */
export function gridChangeProblem(
  sheets: readonly SheetInput[],
  sheet: number,
  change: GridChange,
  at: number,
  count: number,
): string | null {
  const input = sheets[sheet];
  if (!Number.isInteger(sheet) || !input) return "That sheet isn't on this page.";
  if (!Number.isInteger(count) || count < 1) return 'Choose at least one row or column.';
  const rows = change.endsWith('rows');
  const cap = rows ? SHEET_LIMITS.rows : SHEET_LIMITS.columns;
  if (!Number.isInteger(at) || at < 0 || at >= cap)
    return rows
      ? `Row ${at + 1} is outside this sheet.`
      : `Column ${at < 0 ? at + 1 : columnLabel(at + 1)} is outside this sheet.`;
  const used = Math.max(
    0,
    ...input.cells.filter((cell) => cell.source !== '').map((cell) => (rows ? cell.row : cell.col)),
  );
  const end = Math.max(at + count, change.startsWith('insert') && at < used ? used + count : 0);
  return end > cap ? sheetWord(rows ? 'rows' : 'columns', { n: end, max: cap }) : null;
}
