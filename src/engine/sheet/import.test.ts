import { describe, expect, it } from 'vitest';
import { readCsvRecords } from '@/engine/csv';
import { parseSheetFence, readSheetFences } from './fence';
import {
  csvSheetBody,
  defaultPageTitle,
  emptyImportReport,
  importReportLines,
  importUndoLabel,
  sheetPageContent,
} from './import';
describe('sheet import source and report', () => {
  it('keeps CSV blank and ragged rows, quoted CRLF, commas and doubled quotes', () => {
    const parsed = readCsvRecords('\uFEFFA,B\r\n"a\r\nb","He said ""yes"""\r\n\r\n00123\r\n\r\n');
    const result = csvSheetBody(parsed.records);
    expect(result.sheets[0]).toEqual({
      name: 'Sheet1',
      rows: 5,
      columns: 2,
      filled: 5,
      formulas: 0,
      hidden: false,
    });
    const source = readSheetFences(result.body)[0].source;
    expect(parseSheetFence(source)).toMatchObject({ ok: true, rows: 5, cols: 2 });
    expect(source).toContain('"a\nb","He said ""yes"""');
    expect(source).toContain('\n,\n00123,\n,');
  });
  it('uses the shared writer to protect a delimiter-looking row and input guards', () => {
    expect(csvSheetBody([['---']]).body).toContain('"---"');
    expect(() => csvSheetBody([['```']])).toThrow('end the sheet block');
    expect(() => csvSheetBody([['\u0001']])).toThrow('control character');
    expect(() => csvSheetBody(Array.from({ length: 501 }, () => ['']))).toThrow('at most 500');
    expect(() => csvSheetBody([Array(27).fill('')])).toThrow('at most 26');
    expect(() => csvSheetBody(Array.from({ length: 500 }, () => Array(26).fill('x')))).toThrow(
      '10000',
    );
  });
  it('keeps source typing and wraps one root page with a clear undo label', () => {
    const imported = csvSheetBody([['00123', "'00123", '=1+2', '25%']]);
    expect(imported.body).toContain("00123,'00123,=1+2,25%");
    expect(imported.sheets[0].formulas).toBe(1);
    expect(defaultPageTitle('/private/Example.xlsx')).toBe('Example');
    expect(defaultPageTitle('.csv')).toBe('Imported sheet');
    expect(sheetPageContent(' Budget ', imported.body)).toBe(`# Budget\n\n${imported.body}`);
    expect(importUndoLabel(' Budget ')).toBe('Imported “Budget”');
  });
  it('reports each lost feature and bounded comparisons in singular and plural', () => {
    const report = {
      ...emptyImportReport(),
      charts: 2,
      chartSheets: 1,
      pivots: 1,
      tables: 1,
      hidden: 1,
      namesInlined: 3,
      formatting: true,
      changed: { count: 4, first: [{ cell: 'Sheet1!A1', before: 'a', after: 'b' }] },
      saved: {
        compared: 5,
        differ: 1,
        first: [{ cell: 'Sheet1!A2', before: '2', after: '3' }],
        unsaved: 2,
        volatile: 1,
      },
    };
    expect(importReportLines(report)).toEqual([
      "2 charts aren't imported.",
      "1 chart sheet isn't imported.",
      "1 pivot table comes in as the values the file saved; it won't refresh.",
      '1 Excel table comes in as plain cells; formulas that used it name the cells instead.',
      '3 formulas used named ranges; the names were replaced by the cells they point to.',
      '1 hidden sheet is shown.',
      "Fonts, colours, borders and cell styles aren't kept.",
      '4 cells read differently here than in the file: Sheet1!A1 (a → b) and 3 more.',
      '1 formula shows a different value than the file saved: Sheet1!A2 (2 → 3).',
      '2 formulas had no saved value to compare.',
    ]);
    expect(importReportLines(emptyImportReport())).toEqual([]);
  });
});
