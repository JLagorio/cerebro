import { cellAddress, type SheetCellSource } from './fence';
import { SHEET_LIMITS } from './limits';

/** Grid coordinates are zero-based; engine source cells and A1 addresses are one-based. */
export interface Cell {
  row: number;
  column: number;
}
export interface Range {
  anchor: Cell;
  active: Cell;
}
export interface Area extends Cell {
  width: number;
  height: number;
}
export interface Extent {
  rows: number;
  columns: number;
}
export const GRID_EXTENT: Extent = { rows: SHEET_LIMITS.rows, columns: SHEET_LIMITS.columns };

export function bounds(range: Range): Area {
  const row = Math.min(range.anchor.row, range.active.row);
  const column = Math.min(range.anchor.column, range.active.column);
  return {
    row,
    column,
    height: Math.abs(range.anchor.row - range.active.row) + 1,
    width: Math.abs(range.anchor.column - range.active.column) + 1,
  };
}
const clamp = (value: number, count: number) => Math.max(0, Math.min(count - 1, value));
export function move(
  cell: Cell,
  rows: number,
  columns: number,
  extent: Extent = GRID_EXTENT,
): Cell {
  return {
    row: clamp(cell.row + rows, extent.rows),
    column: clamp(cell.column + columns, extent.columns),
  };
}
export function extend(range: Range, active: Cell): Range {
  return { anchor: range.anchor, active };
}
export const single = (cell: Cell): Range => ({ anchor: cell, active: cell });

/** Command-arrow stops at the end of an adjacent run, or at the next filled
 * cell across a gap. With no next value it reaches the grid boundary. */
export function edge(
  cell: Cell,
  axis: 'row' | 'column',
  direction: -1 | 1,
  filled: (cell: Cell) => boolean,
  extent: Extent = GRID_EXTENT,
): Cell {
  const limit = axis === 'row' ? extent.rows : extent.columns;
  const boundary = direction === 1 ? limit - 1 : 0;
  if (cell[axis] === boundary) return cell;
  const next = { ...cell, [axis]: cell[axis] + direction };
  const contiguous = filled(cell) && filled(next);
  let at = next;
  for (;;) {
    if (!contiguous && filled(at)) return at;
    if (at[axis] === boundary) return at;
    const following = { ...at, [axis]: at[axis] + direction };
    if (contiguous && !filled(following)) return at;
    at = following;
  }
}
export const pageStep = (cell: Cell, direction: -1 | 1, pageRows = 24): Cell =>
  move(cell, direction * pageRows, 0);
export const rowHome = (cell: Cell): Cell => ({ row: cell.row, column: 0 });
export const sheetStart = (): Cell => ({ row: 0, column: 0 });
export function lastUsed(cells: readonly SheetCellSource[]): Cell {
  const filled = cells.filter((cell) => cell.source !== '');
  return {
    row: Math.max(0, ...filled.map((cell) => cell.row - 1)),
    column: Math.max(0, ...filled.map((cell) => cell.col - 1)),
  };
}
export const a1 = (cell: Cell): string => cellAddress(cell.row + 1, cell.column + 1);
export function rangeA1(range: Range): string {
  const area = bounds(range);
  const start = a1(area);
  return area.width === 1 && area.height === 1
    ? start
    : `${start}:${a1({ row: area.row + area.height - 1, column: area.column + area.width - 1 })}`;
}
export function qualified(name: string, range: Range): string {
  const sheet = /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `'${name.replaceAll("'", "''")}'`;
  return `${sheet}!${rangeA1(range)}`;
}
/** The used area plus one spare row/column, with a useful empty grid. */
export function displayExtent(rows: number, columns: number): Extent {
  return {
    rows: Math.min(SHEET_LIMITS.rows, Math.max(10, rows + 1)),
    columns: Math.min(SHEET_LIMITS.columns, Math.max(6, columns + 1)),
  };
}
/** End is exclusive; callers render spacers around this bounded window. */
export function visibleRows(
  scrollTop: number,
  height: number,
  rows: number,
  rowHeight = 32,
  overscan = 2,
): { start: number; end: number } {
  const start = Math.max(
    0,
    Math.min(rows, Math.floor(Math.max(0, scrollTop) / rowHeight) - overscan),
  );
  const end = Math.max(
    start,
    Math.min(rows, Math.ceil((Math.max(0, scrollTop) + height) / rowHeight) + overscan),
  );
  return { start, end };
}
