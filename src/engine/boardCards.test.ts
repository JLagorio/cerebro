import { expect, it } from 'vitest';
import { makeEntry } from '@/test/factories';
import { createBoard } from './scene/board';
import { CARD_SIZES, placedPaths, placeCard, resolveCard } from './boardCards';
import type { FileCard } from './scene/model';
const node = (file: string): FileCard => ({
  id: 'a',
  type: 'file',
  file,
  subpath: '#Rollback',
  z: 'a0',
  x: 0,
  y: 0,
  width: 320,
  height: 120,
});
it('resolves exact indexed paths and keeps every raw pointer and section untouched', () => {
  const index = new Map(
    ['pages/note.md', 'flows/a.mmd', 'boards/a.canvas'].map((path) => [path, makeEntry({ path })]),
  );
  for (const [path, kind] of [
    ['pages/note.md', 'page'],
    ['flows/a.mmd', 'diagram'],
    ['boards/a.canvas', 'whiteboard'],
    ['gone.md', 'missing'],
    ['gone.mmd', 'missing'],
    ['gone.canvas', 'missing'],
    ['attachments/a.png', 'image'],
    ['report.pdf', 'file'],
    ['../pages/note.md', 'missing'],
    [' Pages/note.md', 'missing'],
  ] as const) {
    const input = Object.freeze(node(path));
    expect(resolveCard(input, index)).toMatchObject({ kind, pointer: path, section: '#Rollback' });
    expect(input.file).toBe(path);
  }
  expect(resolveCard({ ...node(''), type: 'link', url: 'javascript:alert(1)' }, index)).toEqual({
    kind: 'link',
    pointer: 'javascript:alert(1)',
  });
});
it('placement rounds, cascades exact occupied positions and tracks only file paths', () => {
  const board = createBoard({
    nodes: [
      node('note.md'),
      { ...node('other.md'), id: 'b', x: 24, y: 24 },
      { id: 'c', type: 'link', url: 'https://example.org', x: 48, y: 48, width: 320, height: 120 },
    ],
  });
  expect(placedPaths(board)).toEqual(new Set(['note.md', 'other.md']));
  expect(placeCard(board, { x: 160.1, y: 60.4 }, CARD_SIZES.page)).toEqual({
    x: 72,
    y: 72,
    width: 320,
    height: 120,
  });
  expect(board.nodes.get('a')?.x).toBe(0);
});
