import { describe, expect, it } from 'vitest';
import {
  clearArea,
  clipboardTable,
  matrixOf,
  cellsOf,
  setInput,
  pasteBlock,
  shiftMatrix,
  preOpCell,
  mergeRestructure,
  nextSheetName,
  newSheetSource,
  changedSheets,
  sameSources,
  trimBlankEdges,
  fillTarget,
  mergeFill,
} from './gridEdit';
import { parseSheetFence } from './fence';
import { single } from './selection';
it('picks the greater fill overshoot and cancels inside the source', () => {
  const area = { row: 2, column: 2, width: 2, height: 2 };
  expect(fillTarget(area, { row: 3, column: 3 })).toBeNull();
  expect(fillTarget(area, { row: 6, column: 4 })).toEqual({
    axis: 'rows',
    to: 6,
    area: { row: 2, column: 2, width: 2, height: 5 },
  });
  expect(fillTarget(area, { row: 3, column: 0 })).toEqual({
    axis: 'columns',
    to: 0,
    area: { row: 2, column: 0, width: 4, height: 2 },
  });
});
it('preserves original spelling on copies, uses engine series and translated formulas', () => {
  const area = { row: 0, column: 0, width: 1, height: 1 };
  expect(
    mergeFill([['10%']], area, 'rows', 2, { source: [['0.1']], target: [['0.1'], ['0.1']] }),
  ).toEqual([['10%'], ['10%'], ['10%']]);
  expect(
    mergeFill([['=sum(a1)']], area, 'rows', 1, { source: [['=SUM(A1)']], target: [['=SUM(A2)']] }),
  ).toEqual([['=sum(a1)'], ['=SUM(A2)']]);
  expect(
    mergeFill([['1'], ['2']], { ...area, height: 2 }, 'rows', 3, {
      source: [['1'], ['2']],
      target: [['3'], ['4']],
    }),
  ).toEqual([['1'], ['2'], ['3'], ['4']]);
});
it('maps an upward height-two cycle from the last source row', () => {
  const before = [[], [], [], ['10%'], ['20%']];
  expect(
    mergeFill(before, { row: 3, column: 0, width: 1, height: 2 }, 'rows', 0, {
      source: [['0.1'], ['0.2']],
      target: [['0.2'], ['0.1'], ['0.2']],
    }),
  ).toEqual([['20%'], ['10%'], ['20%'], ['10%'], ['20%']]);
});

describe('grid source edits', () => {
  it('sets, normalizes and clears source without touching an input matrix', () => {
    const old = [['1', '=sum(A1:A2)'], ['2']];
    expect(setInput(old, { row: 2, column: 1 }, 'a\r\nb')).toEqual([old[0], old[1], ['', 'a\nb']]);
    expect(old).toEqual([['1', '=sum(A1:A2)'], ['2']]);
    expect(clearArea(old, { row: 0, column: 1, width: 1, height: 2 })).toEqual([['1'], ['2']]);
    expect(trimBlankEdges([['', ''], ['x', ''], [], ['']])).toEqual([[], ['x']]);
  });
  it.each(['\0', '```markdown', 'a\n ~~~', 'x'.repeat(10001)])(
    'refuses uncarried input %j',
    (value) => {
      expect(() => setInput([], { row: 0, column: 0 }, value)).toThrow();
    },
  );
  it('pastes a 3×3 block at B2 and pads ragged rows', () => {
    const result = pasteBlock([['keep']], single({ row: 1, column: 1 }), [
      ['1', '2', '3'],
      ['4'],
      ['7', '8', '9'],
    ]);
    expect(result).toEqual({
      rows: [['keep'], ['', '1', '2', '3'], ['', '4'], ['', '7', '8', '9']],
      area: { row: 1, column: 1, width: 3, height: 3 },
    });
  });
  it('one value fills a reversed selection and an invalid value refuses the whole paste', () => {
    const range = { anchor: { row: 1, column: 1 }, active: { row: 0, column: 0 } };
    expect(pasteBlock([], range, [['x']]).rows).toEqual([
      ['x', 'x'],
      ['x', 'x'],
    ]);
    const source = [['original']];
    expect(() => pasteBlock(source, range, [['x', '\0']])).toThrow();
    expect(source).toEqual([['original']]);
  });
  it('refuses past row and column caps', () => {
    expect(() => pasteBlock([], single({ row: 499, column: 0 }), [['a'], ['b']])).toThrow('501');
    expect(() => pasteBlock([], single({ row: 0, column: 25 }), [['a', 'b']])).toThrow('27');
  });
  it.each([
    [
      'a\tb\nc\td',
      'text/plain',
      [
        ['a', 'b'],
        ['c', 'd'],
      ],
    ],
    ['"a\tb"\tc', 'text/plain', [['a\tb', 'c']]],
    [
      '\uFEFFa,b\n1,2',
      'text/csv',
      [
        ['a', 'b'],
        ['1', '2'],
      ],
    ],
    [
      'one, phrase\ntwo, phrases',
      'text/plain',
      [
        ['one', ' phrase'],
        ['two', ' phrases'],
      ],
    ],
    ['one, phrase', 'text/plain', [['one, phrase']]],
    ['one, phrase\nplain', 'text/plain', [['one, phrase'], ['plain']]],
    ['first\r\nsecond\r\n', 'text/plain', [['first'], ['second']]],
    ['"one\ntwo",3', 'text/csv', [['one\ntwo', '3']]],
  ])('reads clipboard %j', (text, mime, expected) =>
    expect(clipboardTable(text as string, mime as string)).toEqual(expected),
  );
  it('refuses malformed explicit CSV and counts paste bytes', () => {
    expect(() => clipboardTable('"unclosed', 'text/csv')).toThrow('never closed');
    expect(() => clipboardTable('😀'.repeat(262145))).toThrow('over 1 MB');
  });
  it.each([
    [
      'insert_rows',
      0,
      [
        ['', ''],
        ['a', 'b'],
        ['c', 'd'],
      ].map((r) => (r.every((x) => !x) ? [] : r)),
    ],
    ['delete_rows', 0, [['c', 'd']]],
    [
      'insert_columns',
      0,
      [
        ['', 'a', 'b'],
        ['', 'c', 'd'],
      ],
    ],
    ['delete_columns', 0, [['b'], ['d']]],
  ] as const)('shifts %s at zero', (change, at, expected) =>
    expect(
      shiftMatrix(
        [
          ['a', 'b'],
          ['c', 'd'],
        ],
        change,
        at,
        1,
      ),
    ).toEqual(expected),
  );
  it('maps an after-cell to its pre-operation source', () => {
    expect(preOpCell({ row: 2, column: 4 }, 'insert_rows', 2, 1)).toBeNull();
    expect(preOpCell({ row: 3, column: 4 }, 'insert_rows', 2, 1)).toEqual({ row: 2, column: 4 });
    expect(preOpCell({ row: 0, column: 2 }, 'delete_columns', 1, 2)).toEqual({ row: 0, column: 4 });
  });
  it('takes rewritten formulas in every sheet and preserves untouched spelling', () => {
    const rows = mergeRestructure(
      [[['1', '=sum(a1:a2)'], ['2']], [['=Budget!A2', '=1+1']]],
      0,
      'insert_rows',
      0,
      1,
      {
        before: [
          { sheet: 0, row: 0, column: 1, source: '=SUM(A1:A2)' },
          { sheet: 1, row: 0, column: 0, source: '=Budget!A2' },
          { sheet: 1, row: 0, column: 1, source: '=1+1' },
        ],
        after: [
          { sheet: 0, row: 1, column: 1, source: '=SUM(A2:A3)' },
          { sheet: 1, row: 0, column: 0, source: '=Budget!A3' },
          { sheet: 1, row: 0, column: 1, source: '=1+1' },
        ],
      },
    );
    expect(rows).toEqual([[[], ['1', '=SUM(A2:A3)'], ['2']], [['=Budget!A3', '=1+1']]]);
    expect(
      mergeRestructure([[['=sum(a2:a3)']]], 0, 'insert_rows', 3, 1, {
        before: [{ sheet: 0, row: 0, column: 0, source: '=SUM(A2:A3)' }],
        after: [{ sheet: 0, row: 0, column: 0, source: '=SUM(A2:A3)' }],
      }),
    ).toEqual([[['=sum(a2:a3)']]]);
    expect(
      mergeRestructure([[['=1'], ['keep']]], 0, 'delete_rows', 0, 1, {
        before: [{ sheet: 0, row: 0, column: 0, source: '=1' }],
        after: [],
      }),
    ).toEqual([[['keep']]]);
  });
  it('round-trips cell matrices and names new sheets without positional renaming', () => {
    const cells = [{ row: 2, col: 3, source: '=1' }];
    expect(cellsOf(matrixOf(cells))).toEqual(cells);
    expect(nextSheetName(['sheet1', 'Sheet3'])).toBe('Sheet2');
    expect(parseSheetFence(newSheetSource('Sheet2'))).toMatchObject({ ok: true, name: 'Sheet2' });
  });
  it('does not canonicalize an untouched ragged or quoted source and refuses workbook caps', () => {
    const source = { id: 'one', source: '"same",,\n' };
    expect(changedSheets([source], [[['same']]])).toEqual([]);
    expect(() => changedSheets([source], [[['=SEQUENCE(501)']]])).toThrow('501');
    const rows = Array.from({ length: 500 }, () => Array<string>(26).fill('x'));
    expect(() => changedSheets([source], [rows])).toThrow('13000 filled cells');
  });
  it('only returns changed sources and detects source/order/id changes', () => {
    const source = { id: 'one', source: newSheetSource('Sheet1') };
    expect(changedSheets([source], [[]])).toEqual([]);
    expect(changedSheets([source], [[['x']]])).toEqual([
      { id: 'one', source: source.source + 'x\n' },
    ]);
    expect(sameSources([source], [{ ...source }])).toBe(true);
    expect(sameSources([source], [{ ...source, id: 'two' }])).toBe(false);
  });
});
