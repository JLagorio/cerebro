import { utf8Length } from '@/engine/comments';
import { CLIPBOARD_BYTES, clipboardTable, type Matrix } from '@/engine/sheet/gridEdit';
export const SHEET_CLIPBOARD = 'application/x-cerebro-sheet';
const quoted = (text: string) =>
  /[\t\r\n"]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
export function writeClipboard(
  data: Pick<DataTransfer, 'setData'>,
  sources: Matrix,
  shown: Matrix,
): void {
  data.setData('text/plain', shown.map((row) => row.map(quoted).join('\t')).join('\n'));
  data.setData(SHEET_CLIPBOARD, JSON.stringify({ version: 1, rows: sources }));
}
export function readClipboard(data: Pick<DataTransfer, 'getData' | 'types'>): string[][] {
  const own = data.getData(SHEET_CLIPBOARD);
  if (own) {
    if (utf8Length(own) > CLIPBOARD_BYTES)
      throw new Error('That paste is over 1 MB. Paste less at a time.');
    let value: unknown;
    try {
      value = JSON.parse(own);
    } catch {
      throw new Error('The copied sheet cells could not be read.');
    }
    if (
      typeof value !== 'object' ||
      value === null ||
      !('version' in value) ||
      value.version !== 1 ||
      !('rows' in value) ||
      !Array.isArray(value.rows) ||
      !value.rows.every(
        (row: unknown) =>
          Array.isArray(row) && row.every((cell: unknown) => typeof cell === 'string'),
      )
    )
      throw new Error('The copied sheet cells could not be read.');
    return value.rows;
  }
  const csv = data.getData('text/csv');
  return clipboardTable(csv || data.getData('text/plain'), csv ? 'text/csv' : 'text/plain');
}
