import { expect, it } from 'vitest';
import { parseWhiteboardRef, serializeWhiteboardRef, WHITEBOARD_FENCE } from './whiteboardRef';
it('reads a pointer and optional bounded integer height, ignoring unknown keys', () => {
  expect(WHITEBOARD_FENCE).toBe('cerebro-whiteboard');
  expect(parseWhiteboardRef('board: maps/flow.canvas\nextra: true')).toEqual({
    board: 'maps/flow.canvas',
  });
  for (const height of [160, 360, 1200]) {
    expect(parseWhiteboardRef(`board: maps/flow.canvas\nheight: ${height}`)).toEqual({
      board: 'maps/flow.canvas',
      height,
    });
  }
});
it.each([
  '',
  '[]',
  'true',
  'board: [a.canvas]',
  'board: [broken',
  'board: /a.canvas',
  'board: ../a.canvas',
  'board: maps/../a.canvas',
  'board: a.md',
  'board: maps\\a.canvas',
  'board: a.canvas\nheight: 159',
  'board: a.canvas\nheight: 1201',
  'board: a.canvas\nheight: 160.5',
  'board: a.canvas\nheight: "360"',
  'board: a.canvas\nheight: null',
  'board: "maps/\\u0000a.canvas"',
  'board: ./a.canvas',
  'board: maps//a.canvas',
])('leaves an unusable fence as code: %s', (body) => expect(parseWhiteboardRef(body)).toBeNull());
it('round trips paths needing YAML quotes and writes board before height', () => {
  const ref = { board: 'maps/Plan: #1.canvas', height: 520 };
  const text = serializeWhiteboardRef(ref);
  expect(text.startsWith('board:')).toBe(true);
  expect(text.indexOf('height:')).toBeGreaterThan(text.indexOf('board:'));
  expect(parseWhiteboardRef(text)).toEqual(ref);
  expect(serializeWhiteboardRef({ board: 'maps/flow.canvas' })).toBe('board: maps/flow.canvas');
});
