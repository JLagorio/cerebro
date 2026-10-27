import CASES from '../../src-tauri/fixtures/source-body-cases.json';
import { describe, expect, it } from 'vitest';
import {
  applySourceBodyEdit,
  sourceBodyDisplay,
  sourceBodyInput,
  replaceSourceBody,
} from './sourceBodyEdits';

describe('source body edits preserve untouched raw text', () => {
  it('maps textarea LF offsets to CRLF bytes without normalizing other lines', () => {
    const raw = 'first\r\nsecond\nthird\r\n';
    expect(sourceBodyDisplay(raw)).toBe('first\nsecond\nthird\n');
    expect(applySourceBodyEdit(raw, { from: 6, to: 12 }, 'replacement\nline')).toBe(
      'first\r\nreplacement\r\nline\nthird\r\n',
    );
  });
  it('does not write or normalize an unchanged textarea value', () => {
    const raw = '\n<div>unsupported</div>\r\n```odd\r\nraw\r\n```\n';
    expect(sourceBodyInput(raw, sourceBodyDisplay(raw))).toBe(raw);
  });
  it('retains raw HTML, unsupported fences, leading newlines and Unicode outside an edit', () => {
    const raw = '\r\n<div>文字😀</div>\r\n```unfamiliar\r\nkeep\r\n```\r\n';
    const display = sourceBodyDisplay(raw);
    const at = display.indexOf('keep');
    expect(applySourceBodyEdit(raw, { from: at, to: at + 4 }, 'changed')).toBe(
      raw.replace('keep', 'changed'),
    );
  });
  it('uses UTF-16 offsets and refuses a range that splits a surrogate pair', () => {
    const raw = 'a😀b\r\nc';
    expect(applySourceBodyEdit(raw, { from: 1, to: 3 }, '界')).toBe('a界b\r\nc');
    expect(() => applySourceBodyEdit(raw, { from: 2, to: 3 }, '')).toThrow();
    expect(() => applySourceBodyEdit(raw, { from: 1, to: 2 }, '')).toThrow();
  });
  it('derives a safe replacement when emoji share their first UTF-16 unit', () => {
    expect(sourceBodyInput('😀\r\nkeep', '😁\nkeep')).toBe('😁\r\nkeep');
    expect(sourceBodyInput('a😀\r\nkeep', 'a\nkeep')).toBe('a\r\nkeep');
  });
  it('rejects invalid offsets instead of repairing the wrong span', () => {
    for (const range of [
      { from: -1, to: 0 },
      { from: 2, to: 1 },
      { from: 0, to: 20 },
      { from: 0.5, to: 1 },
    ])
      expect(() => applySourceBodyEdit('abc', range, 'x')).toThrow();
  });
});

for (const fixture of CASES)
  it(`source byte replacement: ${fixture.name}`, () => {
    if (fixture.refused) expect(() => replaceSourceBody(fixture.before, fixture.body)).toThrow();
    else expect(replaceSourceBody(fixture.before, fixture.body)).toBe(fixture.after);
  });
