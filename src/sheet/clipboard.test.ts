import { expect, it } from 'vitest';
import { readClipboard, writeClipboard, SHEET_CLIPBOARD } from './clipboard';
function data() {
  const values = new Map<string, string>();
  return {
    getData: (type: string) => values.get(type) ?? '',
    setData: (type: string, value: string) => {
      values.set(type, value);
    },
    get types() {
      return [...values.keys()];
    },
  };
}
it('copies shown TSV and source MIME, and reads sources before any public type', () => {
  const clip = data();
  writeClipboard(clip, [['=1+1', 'a\tb']], [['2', 'a\tb']]);
  expect(clip.getData('text/plain')).toBe('2\t"a\tb"');
  expect(readClipboard(clip)).toEqual([['=1+1', 'a\tb']]);
});
it('refuses damaged or oversized own cells and prefers CSV to plain', () => {
  const clip = data();
  clip.setData('text/plain', 'ignored');
  clip.setData('text/csv', '"a,b",c');
  expect(readClipboard(clip)).toEqual([['a,b', 'c']]);
  clip.setData(SHEET_CLIPBOARD, '{"version":2,"rows":[]}');
  expect(() => readClipboard(clip)).toThrow('could not be read');
  clip.setData(SHEET_CLIPBOARD, 'x'.repeat(1024 * 1024 + 1));
  expect(() => readClipboard(clip)).toThrow('over 1 MB');
});
