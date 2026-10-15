import { describe, expect, it } from 'vitest';
import { utf8Length } from '@/engine/comments';
import cases from '../../../src-tauri/fixtures/sheet-fence-cases.json';
import {
  cellAddress,
  columnLabel,
  fenceCloses,
  fenceOpening,
  parseSheetFence,
  readSheetFences,
  sheetNames,
  sheetRequest,
  sheetSourcesOf,
} from './fence';

describe('sheet fences', () => {
  it('walks sheets inside columns, toggles and AI answers in document order', () => {
    const sheet = (id: string, source: string) => ({ id, type: 'sheet', props: { source } });
    expect(
      sheetSourcesOf([
        sheet('first', '1'),
        { type: 'columnList', children: [{ type: 'column', children: [sheet('column', '2')] }] },
        { type: 'toggleListItem', children: [sheet('toggle', '3')] },
        { type: 'ai', children: [sheet('answer', '4')] },
        { id: 'empty', type: 'sheet' },
      ]),
    ).toEqual([
      { id: 'first', source: '1' },
      { id: 'column', source: '2' },
      { id: 'toggle', source: '3' },
      { id: 'answer', source: '4' },
      { id: 'empty', source: '' },
    ]);
  });
  it('makes excessive YAML aliases unavailable instead of throwing from a page render', () => {
    const yaml =
      'a: &a [1,2,3,4,5,6,7,8,9,10]\nb: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a,*a]\nc: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b,*b]\nname: [*c,*c,*c]';
    expect(parseSheetFence(`---\n${yaml}\n---\n1`)).toMatchObject({ ok: false, reason: 'header' });
  });
  it.each(cases.fences)('replays the shared fence case: $name', ({ source, expect: expected }) => {
    expect(parseSheetFence(source)).toEqual(expected);
  });
  it.each(cases.bodies)('replays shared body spans: $name', ({ body, expect: expected }) => {
    const byteSpan = (span: [number, number]) => span.map((at) => utf8Length(body.slice(0, at)));
    expect(
      readSheetFences(body).map((fence) => ({
        ...fence,
        span: byteSpan(fence.span),
        contentSpan: byteSpan(fence.contentSpan),
      })),
    ).toEqual(expected);
  });
  it.each(cases.pages)('keeps page ordinals: $name', ({ sources, names, slots }) => {
    const parsed = sources.map(parseSheetFence);
    expect(sheetNames(parsed)).toEqual(names);
    expect(sheetRequest(parsed).slots).toEqual(slots);
    expect(sheetRequest(parsed).sheets.map((sheet) => sheet.name)).toEqual(
      slots.map((slot) => names[slot]),
    );
  });
  it.each([
    [1, 'A'],
    [26, 'Z'],
    [27, 'AA'],
    [52, 'AZ'],
    [53, 'BA'],
    [702, 'ZZ'],
    [703, 'AAA'],
  ] as const)('labels column %s as %s', (column, label) => {
    expect(columnLabel(column)).toBe(label);
    expect(cellAddress(12, column)).toBe(`${label}12`);
  });
  it('uses the CommonMark marker and length, without opening fences inside a code info string', () => {
    expect(fenceOpening('  ~~~~cerebro-sheet')).toEqual({
      marker: '~~~~',
      language: 'cerebro-sheet',
    });
    expect(fenceOpening('```cerebro-sheet extra')).toEqual({
      marker: '```',
      language: 'cerebro-sheet',
    });
    expect(fenceOpening('    ```cerebro-sheet')).toBeNull();
    expect(fenceOpening('```a`b')).toBeNull();
    expect(fenceCloses('```', '````')).toBe(false);
    expect(fenceCloses('~~~~', '````')).toBe(false);
    expect(fenceCloses('  `````  ', '````')).toBe(true);
    expect(fenceCloses('``` nope', '```')).toBe(false);
  });
});
