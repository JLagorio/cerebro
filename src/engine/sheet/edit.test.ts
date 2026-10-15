import { describe, expect, it } from 'vitest';
import CASES from '../../../src-tauri/fixtures/sheet-edit-cases.json';
import {
  parseSheetEdit,
  planSheetEdit,
  SHEET_EDIT_LIMITS,
  encodeSheetSource,
  sheetAddress,
} from './edit';

describe('checked sheet source edits', () => {
  it('limits are the cases limits', () => expect(SHEET_EDIT_LIMITS).toEqual(CASES.limits));
  for (const row of CASES.cases)
    it(`replays the shared sheet edit case: ${row.name}`, () => {
      const run = () => planSheetEdit(row.page, parseSheetEdit(row.args));
      if ('refusal' in row) expect(run).toThrow(row.refusal);
      else {
        const plan = run();
        expect(plan.body).toBe(row.after);
        expect(plan.body !== row.page).toBe(row.written);
      }
    });
  it('keeps written cells in request order once and source snapshots independent', () => {
    const page = '```cerebro-sheet\n1,2\n```\n';
    const plan = planSheetEdit(
      page,
      parseSheetEdit({
        path: 'a.md',
        ops: [
          {
            op: 'set_cells',
            sheet: 'Sheet1',
            cells: [
              { address: 'B1', value: '3' },
              { address: 'A1', value: '4' },
            ],
          },
          { op: 'set_cells', sheet: 'sheet1', cells: [{ address: 'B1', value: '5' }] },
        ],
      }),
    );
    expect(plan.written).toEqual([
      { sheet: 'Sheet1', row: 1, col: 2 },
      { sheet: 'Sheet1', row: 1, col: 1 },
    ]);
    expect(plan.before[0].cells.map((cell) => cell.source)).toEqual(['1', '2']);
    expect(plan.after[0].cells.map((cell) => cell.source)).toEqual(['4', '5']);
    expect(plan.ops).toEqual(['Set 2 cells on Sheet1.', 'Set 1 cell on Sheet1.']);
  });
  it('keeps header comments and closing whitespace while replacing records', () => {
    expect(
      encodeSheetSource('---\n# saved\nname: Budget\n---  \n1', [{ row: 1, col: 1, source: '2' }]),
    ).toBe('---\n# saved\nname: Budget\n---  \n2\n');
  });
  it('counts Unicode scalar characters and does not refuse ordinary backticks', () => {
    const value = '😀'.repeat(10_000);
    const plan = planSheetEdit(
      '```cerebro-sheet\n1\n```\n',
      parseSheetEdit({
        path: 'a.md',
        ops: [{ op: 'set_cells', sheet: 'Sheet1', cells: [{ address: 'A1', value }] }],
      }),
    );
    expect(plan.after[0].cells[0].source).toBe(value);
    expect(sheetAddress('XFD1048576')).toEqual({ row: 1048576, col: 16384 });
    expect(sheetAddress('XFE1')).toBeNull();
  });
});
