// @vitest-environment node
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { initSync, Model, getTokens } from '@ironcalc/wasm';
import cases from '../../src-tauri/fixtures/sheet-edit-cases.json';
import { parseSheetEdit, planSheetEdit } from '@/engine/sheet/edit';
import { cachedValueReader, editReportWith } from './mockSheet';
const require = createRequire(import.meta.url);
initSync({ module: readFileSync(require.resolve('@ironcalc/wasm/wasm_bg.wasm')) });
const engine = {
  Model,
  getTokens,
  readValues: cachedValueReader(
    readFileSync(new URL('./sheetValues/values.wasm', import.meta.url)),
  ),
};
describe('the real browser sheet edit report', () => {
  it.each(cases.reports)('replays the shared report: $name', ({ page, args, report }) => {
    const planned = planSheetEdit(page, parseSheetEdit(args));
    expect(editReportWith(engine, planned.before, planned.after, planned.written)).toEqual(report);
  });
  it('caps changed cells at 200 and errors at 50 while counting every cell', () => {
    const after = [
      {
        name: 'Budget',
        cells: Array.from({ length: 250 }, (_, i) => ({ row: i + 1, col: 1, source: '=1/0' })),
      },
    ];
    const report = editReportWith(engine, [], after, []);
    expect(report.changed).toHaveLength(200);
    expect(report.changed_total).toBe(250);
    expect(report.errors).toHaveLength(50);
    expect(report.errors_total).toBe(250);
    expect(report.errors.every((e) => e.new)).toBe(true);
  });
  it('reads malformed snapshots as unavailable', () => {
    expect(() => engine.readValues(new Uint8Array([1, 2, 3]))).toThrow('could not be read');
  });
  it('never resolves a missing reference by introducing its private value sheet', () => {
    const after = [{ name: 'Budget', cells: [{ row: 1, col: 1, source: '=__cerebro_values!A1' }] }];
    expect(editReportWith(engine, [], after, []).errors[0].error).toBe('#REF!');
  });
});
