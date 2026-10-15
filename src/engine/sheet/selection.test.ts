import { describe, expect, it } from 'vitest';
import {
  a1,
  bounds,
  displayExtent,
  edge,
  extend,
  lastUsed,
  move,
  pageStep,
  qualified,
  rangeA1,
  rowHome,
  sheetStart,
  single,
  visibleRows,
  type Cell,
} from './selection';

describe('sheet selection and navigation', () => {
  it('keeps the anchor while extending in either direction', () => {
    const range = extend(single({ row: 4, column: 3 }), { row: 1, column: 0 });
    expect(range.anchor).toEqual({ row: 4, column: 3 });
    expect(bounds(range)).toEqual({ row: 1, column: 0, width: 4, height: 4 });
    expect(rangeA1(range)).toBe('A2:D5');
  });
  it('moves, pages and homes without leaving the supported grid', () => {
    expect(move({ row: 0, column: 0 }, -1, -1)).toEqual(sheetStart());
    expect(move({ row: 499, column: 25 }, 1, 1)).toEqual({ row: 499, column: 25 });
    expect(pageStep({ row: 490, column: 3 }, 1)).toEqual({ row: 499, column: 3 });
    expect(pageStep({ row: 30, column: 3 }, -1)).toEqual({ row: 6, column: 3 });
    expect(rowHome({ row: 30, column: 3 })).toEqual({ row: 30, column: 0 });
  });
  const cells = [1, 2, 3, 7, 8];
  it.each([
    [1, 1, 3],
    [2, 1, 3],
    [3, 1, 7],
    [4, 1, 7],
    [8, 1, 11],
    [0, 1, 1],
    [8, -1, 7],
    [7, -1, 3],
    [6, -1, 3],
    [2, -1, 1],
    [1, -1, 0],
    [11, 1, 11],
  ] as const)(
    'command-arrow from %s toward %s lands at %s across data/gaps',
    (start, direction, end) => {
      for (const axis of ['row', 'column'] as const) {
        const at: Cell = { row: 0, column: 0, [axis]: start };
        expect(
          edge(at, axis, direction, (cell) => cells.includes(cell[axis]), {
            rows: 12,
            columns: 12,
          }),
        ).toEqual({ ...at, [axis]: end });
      }
    },
  );
  it('uses source cells for the last used corner, including formulas with blank results', () => {
    expect(lastUsed([])).toEqual(sheetStart());
    expect(
      lastUsed([
        { row: 5, col: 2, source: '=IF(TRUE,"",0)' },
        { row: 9, col: 8, source: '' },
      ]),
    ).toEqual({ row: 4, column: 1 });
  });
  it('formats a single address and safely quotes sheet names', () => {
    const range = { anchor: { row: 0, column: 0 }, active: { row: 1, column: 1 } };
    expect(a1({ row: 499, column: 25 })).toBe('Z500');
    expect(rangeA1(single(sheetStart()))).toBe('A1');
    expect(qualified('Budget', range)).toBe('Budget!A1:B2');
    expect(qualified('My Sheet', range)).toBe("'My Sheet'!A1:B2");
    expect(qualified("O'Brien", single(sheetStart()))).toBe("'O''Brien'!A1");
  });
  it('adds one spare row and column within the caps, with a usable empty grid', () => {
    expect(displayExtent(0, 0)).toEqual({ rows: 10, columns: 6 });
    expect(displayExtent(20, 8)).toEqual({ rows: 21, columns: 9 });
    expect(displayExtent(500, 26)).toEqual({ rows: 500, columns: 26 });
  });
  it('windows at most the viewport and overscan even at the end of a long sheet', () => {
    expect(visibleRows(0, 24 * 32, 500)).toEqual({ start: 0, end: 26 });
    expect(visibleRows(100 * 32, 24 * 32, 500)).toEqual({ start: 98, end: 126 });
    expect(visibleRows(490 * 32, 24 * 32, 500)).toEqual({ start: 488, end: 500 });
    expect(visibleRows(0, 24 * 32, 10)).toEqual({ start: 0, end: 10 });
  });
});
