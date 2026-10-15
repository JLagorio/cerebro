import { beforeEach, expect, it } from 'vitest';
import { csvSheetBody } from '@/engine/sheet/import';
import { pickSheetFile, stageSheetFile } from './mockIpc';
beforeEach(() => stageSheetFile(null));
it('serves staged bytes or a recorded decode exactly once without deciding imports', async () => {
  expect(await pickSheetFile()).toBeNull();
  const text = '\uFEFFa,"b\r\nc"\r\n';
  stageSheetFile({ kind: 'csv', name: 'book.csv', text });
  const csv = await pickSheetFile();
  expect(csv).toMatchObject({ kind: 'csv', name: 'book.csv' });
  if (csv?.kind !== 'csv') throw new Error('CSV');
  expect(
    new TextDecoder().decode(Uint8Array.from(atob(csv.bytesBase64), (c) => c.charCodeAt(0))),
  ).toBe(text.slice(1));
  expect(await pickSheetFile()).toBeNull();
  const workbook = csvSheetBody([['1']]);
  stageSheetFile({ kind: 'xlsx', name: 'book.xlsx', workbook });
  expect(await pickSheetFile()).toEqual({ kind: 'xlsx', name: 'book.xlsx', workbook });
  expect(await pickSheetFile()).toBeNull();
});
it('a staged refusal throws once and never becomes an empty workbook', async () => {
  stageSheetFile({ refusal: 'Cannot read this workbook.' });
  await expect(pickSheetFile()).rejects.toThrow('Cannot read this workbook.');
  expect(await pickSheetFile()).toBeNull();
});
