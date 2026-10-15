import { expect, it } from 'vitest';
import { exportSheetXlsx, resetMockFs } from './mockIpc';
it('records workbook exports without changing vault bytes and clears them on reset', async () => {
  resetMockFs();
  const files = (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;
  const before = [...files];
  expect(await exportSheetXlsx('book.xlsx', 'two live fences')).toBe('book.xlsx');
  expect(
    (window as unknown as { __cerebroMockSheetExports: unknown[] }).__cerebroMockSheetExports,
  ).toEqual([{ defaultName: 'book.xlsx', page: 'two live fences' }]);
  expect([...files]).toEqual(before);
  resetMockFs();
  expect(
    (window as unknown as { __cerebroMockSheetExports: unknown[] }).__cerebroMockSheetExports,
  ).toEqual([]);
});
