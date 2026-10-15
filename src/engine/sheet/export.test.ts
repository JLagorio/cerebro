import { expect, it } from 'vitest';
import { csvFileName, sheetCsv, xlsxFileName } from './export';
import type { SheetCellValue } from './fence';
const cell = (
  row: number,
  col: number,
  display: string,
  kind: SheetCellValue['kind'] = 'text',
): SheetCellValue => ({ row, col, display, kind });
it('exports shown values across blanks and spills with BOM and CRLF', () => {
  expect(
    sheetCsv([
      cell(1, 1, 'Item'),
      cell(1, 2, 'Cost'),
      cell(2, 1, 'Rent'),
      cell(2, 2, '1200', 'number'),
      cell(3, 1, 'Food'),
      cell(3, 2, '300', 'number'),
      cell(4, 2, '1500', 'number'),
      cell(5, 1, '=not a formula'),
    ]),
  ).toBe("\uFEFFItem,Cost\r\nRent,1200\r\nFood,300\r\n,1500\r\n'=not a formula,\r\n");
  expect(sheetCsv([cell(2, 3, '3', 'number'), cell(500, 26, '')])).toBe('\uFEFF,,\r\n,,3\r\n');
});
it('guards every text/error prefix, never number or boolean formatting', () => {
  const values = ['=SUM(A1)', '+1', '-text', '@name', '\ttext', '\rtext'];
  const text = sheetCsv(values.map((value, i) => cell(1, i + 1, value)));
  for (const value of values) expect(text).toContain(`'${value}`);
  expect(
    sheetCsv([
      cell(1, 1, '-42', 'number'),
      cell(1, 2, 'TRUE', 'boolean'),
      cell(1, 3, '#REF!', 'error'),
      cell(1, 4, '=oops', 'error'),
    ]),
  ).toBe("\uFEFF-42,TRUE,#REF!,'=oops\r\n");
});
it('quotes CSV syntax, preserves displayed percents and has no invented empty cell', () => {
  expect(sheetCsv([cell(1, 1, 'a,"b"\nc'), cell(1, 2, '25%', 'number')])).toBe(
    '\uFEFF"a,""b""\nc",25%\r\n',
  );
  expect(sheetCsv([])).toBe('\uFEFF\r\n');
});
it('uses safe filenames with readable fallbacks', () => {
  expect(xlsxFileName('Q4 / Café')).toBe('q4-cafe.xlsx');
  expect(csvFileName('Q4 / Café', 'Budget (USD)')).toBe('q4-cafe-budget-usd.csv');
  expect(xlsxFileName('✨')).toBe('workbook.xlsx');
  expect(csvFileName('', '')).toBe('workbook-sheet.csv');
});
