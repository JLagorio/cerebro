// @vitest-environment node
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { initSync, Model, getTokens } from '@ironcalc/wasm';
import cases from '../../src-tauri/fixtures/sheet-calc-cases.json';
import gridCases from '../../src-tauri/fixtures/sheet-grid-ops.json';
import { restructureWith, fillWith, completeWith } from './mockSheet';
import type { FillAxis, GridChange } from '@/engine/sheet/gridEdit';
import functions from '@/engine/sheet/functions.json';
import type { SheetInput } from '@/engine/sheet/fence';
import { calculateWith, literalArraySize, SHEET_LIMITS, SHEET_WORDS } from './mockSheet';

const require = createRequire(import.meta.url);
initSync({ module: readFileSync(require.resolve('@ironcalc/wasm/wasm_bg.wasm')) });
const engine = { Model, getTokens };
const one = (source = '1', row = 1, col = 1): SheetInput[] => [
  { name: 'Sheet1', cells: [{ row, col, source }] },
];

describe('the pinned browser sheet engine', () => {
  it.each(cases.cases)('replays the shared sheet case: $name', ({ sheets, expect: expected }) => {
    expect(calculateWith(engine, sheets, 'UTC')).toEqual(expected);
  });
  it('holds the limits and words to the same fixture as Rust', () => {
    expect(SHEET_LIMITS).toEqual(cases.limits);
    expect(SHEET_WORDS).toEqual(cases.words);
  });
  it('refuses whole-workbook limits in order before constructing an engine', () => {
    const Model = vi.fn(() => {
      throw new Error('must not construct');
    }) as unknown as typeof engine.Model;
    const e = { Model, getTokens };
    expect(() =>
      calculateWith(
        e,
        Array.from({ length: 21 }, () => one()[0]),
        'UTC',
      ),
    ).toThrow('This page holds 21 sheets. A page computes at most 20.');
    expect(() => calculateWith(e, one('x', 0, 1), 'UTC')).toThrow(
      'A sheet cell sits outside the grid, at row 0, column 1.',
    );
    expect(() => calculateWith(e, one('x', 1, 0), 'UTC')).toThrow(
      'A sheet cell sits outside the grid, at row 1, column 0.',
    );
    expect(() =>
      calculateWith(
        e,
        [{ name: 'X', cells: Array.from({ length: 10001 }, () => one()[0].cells[0]) }],
        'UTC',
      ),
    ).toThrow("This page's sheets hold 10001 filled cells. A page computes at most 10000.");
    expect(() => calculateWith(e, one('x'.repeat(2000001)), 'UTC')).toThrow(
      "This page's sheets hold 2000001 characters. A page computes at most 2000000.",
    );
    expect(Model).not.toHaveBeenCalled();
  });
  it('refuses each sheet limit, counting characters rather than UTF-16 units', () => {
    expect(calculateWith(engine, one('1', 501, 1), 'UTC')[0]).toMatchObject({
      ok: false,
      problem: 'too_large',
      message: 'This sheet reaches row 501. A sheet holds at most 500 rows.',
    });
    expect(calculateWith(engine, one('1', 1, 27), 'UTC')[0]).toMatchObject({
      ok: false,
      problem: 'too_large',
      message: 'This sheet reaches column 27. A sheet holds at most 26 columns.',
    });
    expect(calculateWith(engine, one('😀'.repeat(10001)), 'UTC')[0]).toMatchObject({
      ok: false,
      problem: 'too_large',
      message: 'The cell at row 1, column 1 holds 10001 characters. A cell holds at most 10000.',
    });
    expect(calculateWith(engine, one('😀'.repeat(10000)), 'UTC')[0].ok).toBe(true);
  });
  it('turns engine throws into stopped words and always frees its model', () => {
    const free = vi.fn();
    class Broken {
      free = free;
      pauseEvaluation() {
        throw new Error('private cell text');
      }
    }
    expect(() =>
      calculateWith({ Model: Broken as unknown as typeof Model, getTokens }, one(), 'UTC'),
    ).toThrow(SHEET_WORDS.stopped);
    expect(free).toHaveBeenCalledOnce();
  });
  it('falls back to UTC when the supplied zone is unknown', () => {
    expect(calculateWith(engine, one(), 'not-a-zone')).toEqual(calculateWith(engine, one(), 'UTC'));
  });
  it('guards literal arrays including nested calls, but leaves strings and computed dimensions alone', () => {
    expect(literalArraySize('=SUM(SEQUENCE(501))')).toEqual([501, 1]);
    expect(literalArraySize('=randarray(1,27)')).toEqual([1, 27]);
    expect(literalArraySize('=MAKEARRAY(1e3,2,LAMBDA(r,c,r))')).toEqual([1000, 2]);
    expect(literalArraySize('="SEQUENCE(501)"')).toBeNull();
    expect(literalArraySize("'=SEQUENCE(501)")).toBeNull();
    expect(literalArraySize('=SEQUENCE(A1)')).toBeNull();
    expect(literalArraySize('=SEQUENCE(2*500)')).toBeNull();
  });
  it('keeps strings and external workbook references out of name normalization', () => {
    const sheet: SheetInput = { name: 'Budget', cells: [{ row: 1, col: 1, source: '7' }] };
    const other: SheetInput = {
      name: 'Read',
      cells: [
        { row: 1, col: 1, source: '="budget!A1"' },
        { row: 2, col: 1, source: "='[Book.xlsx]budget'!A1" },
      ],
    };
    const result = calculateWith(engine, [sheet, other], 'UTC')[1];
    expect(result).toMatchObject({
      ok: true,
      cells: [
        { display: 'budget!A1', kind: 'text' },
        { display: '#REF!', kind: 'error' },
      ],
    });
  });
  it('computes the 10000-cell chain within the page cap', () => {
    const cells: SheetInput['cells'] = [];
    for (let at = 0; at < 10000; at++) {
      const row = Math.floor(at / 20) + 1,
        col = (at % 20) + 1;
      const before = at - 1,
        oldRow = Math.floor(before / 20) + 1,
        oldCol = (before % 20) + 1;
      cells.push({
        row,
        col,
        source: at === 0 ? '1' : `=${String.fromCharCode(64 + oldCol)}${oldRow}+1`,
      });
    }
    const result = calculateWith(engine, [{ name: 'Chain', cells }], 'UTC')[0];
    expect(result).toMatchObject({ ok: true, rows: 500, cols: 20 });
    if (result.ok) expect(result.cells.at(-1)?.display).toBe('10000');
  });
});

describe('structural grid edits on the real upstream wasm', () => {
  it.each(gridCases.fill)('replays sheet-grid-ops fill: $name', (test) => {
    let result;
    try {
      result = fillWith(engine, test.sheets, test.sheet, test.area, test.axis as FillAxis, test.to);
    } catch (error) {
      result = { error: error instanceof Error ? error.message : String(error) };
    }
    expect(result).toEqual(test.expect);
  });
  it.each(gridCases.complete)('replays sheet-grid-ops complete: $name', (test) => {
    expect(
      completeWith(engine, test.names, test.sheet, test.row, test.column, test.text, test.cursor),
    ).toEqual(test.expect);
  });
  it('every catalog name is recognized by the pinned engine', () => {
    const names = Object.keys(functions);
    const results = calculateWith(
      engine,
      [
        {
          name: 'Catalog',
          cells: names.map((name, index) => ({ row: index + 1, col: 1, source: `=${name}()` })),
        },
      ],
      'UTC',
    );
    expect(results[0].ok).toBe(true);
    if (results[0].ok)
      expect(results[0].cells.filter((cell) => cell.display === '#NAME?')).toEqual([]);
  });
  it.each(gridCases.restructure)('replays sheet-grid-ops: $name', (test) => {
    let result;
    try {
      result = restructureWith(
        engine,
        test.sheets,
        test.sheet,
        test.change as GridChange,
        test.at,
        test.count,
      );
    } catch (error) {
      result = { error: error instanceof Error ? error.message : String(error) };
    }
    expect(result).toEqual(test.expect);
  });
});
