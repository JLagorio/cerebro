import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createBoard } from '@/engine/scene/board';
import { createSceneEditor } from '@/engine/scene/editor';
import type { TextCard } from '@/engine/scene/model';
import { SceneSvg } from './SceneSvg';
import { useScene } from './useScene';
const renders = vi.hoisted(() => new Map<string, number>());
vi.mock('./CanvasText', () => ({
  CanvasText: ({ text }: { text: string }) => {
    renders.set(text, (renders.get(text) ?? 0) + 1);
    return <span>{text}</span>;
  },
}));
const text = (id: string): TextCard => ({
  id,
  type: 'text',
  text: id,
  shape: 'rectangle',
  x: 0,
  y: 0,
  width: 120,
  height: 80,
  z: '',
});
afterEach(() => {
  cleanup();
  renders.clear();
});
it('draws all cards, shapes, visible connections and ink without paint classes or links', () => {
  const board = createBoard({
    nodes: [
      { id: 'g', type: 'group', x: -20, y: -20, width: 600, height: 200, label: 'Group' },
      text('plain'),
      { ...text('ellipse'), shape: 'ellipse', color: '2' },
      { ...text('diamond'), shape: 'diamond', color: '#112233' },
      { id: 'f', type: 'file', x: 0, y: 0, width: 100, height: 80, file: 'notes/a.md' },
      { id: 'l', type: 'link', x: 0, y: 0, width: 100, height: 80, url: 'https://example.com' },
    ],
    edges: [
      { id: 'e', fromNode: 'plain', toNode: 'ellipse', label: 'Flow', fromEnd: 'arrow' },
      { id: 'lost', fromNode: 'gone', toNode: 'plain' },
    ],
    ink: [
      {
        id: 'ink',
        x: 0,
        y: 0,
        width: 20,
        height: 20,
        points: [0, 0, 500, 200, 200, 500],
        size: 4,
        simulated: false,
      },
    ],
  });
  const { container } = render(<SceneSvg board={board} />);
  expect(screen.getAllByTestId('wb-node')).toHaveLength(6);
  expect(screen.getAllByTestId('wb-edge')).toHaveLength(1);
  expect(screen.getByTestId('wb-ink').getAttribute('d')).toBeTruthy();
  expect(container.querySelector('[data-node-id="ellipse"] ellipse')).toBeTruthy();
  expect(container.querySelector('[data-node-id="diamond"] polygon')).toBeTruthy();
  expect(container.querySelector('[data-node-id="ellipse"] g')?.getAttribute('stroke')).toBe(
    'var(--canvas-2)',
  );
  expect(container.querySelector('[data-node-id="diamond"] g')?.getAttribute('stroke')).toBe(
    '#112233',
  );
  expect(container.querySelectorAll('[data-edge-id="e"] polygon')).toHaveLength(2);
  expect(container.querySelector('[class],a,[href]')).toBeNull();
  expect(screen.getByTestId('wb-scene').getAttribute('data-canvas-content')).toBe('true');
});
it('clip ids remain distinct for escaped-looking and arbitrary Unicode item ids', () => {
  const { container } = render(
    <SceneSvg board={createBoard({ nodes: [text('a b'), text('a_20_b'), text('😀')] })} />,
  );
  const ids = [...container.querySelectorAll('clipPath')].map((el) => el.id);
  expect(new Set(ids).size).toBe(3);
});
it('previewing one of500 cards re-renders one card and never changes the committed scene', () => {
  const editor = createSceneEditor(
    createBoard({ nodes: Array.from({ length: 500 }, (_, i) => text(String(i))) }),
    { createId: () => '' },
  );
  function Host() {
    return <SceneSvg board={useScene(editor)} />;
  }
  render(<Host />);
  expect([...renders.values()].reduce((a, b) => a + b, 0)).toBe(500);
  const first = editor.board.nodes.get('0')!;
  act(() => {
    editor.begin('Move');
    editor.preview(new Map([['n:0', { ...first, x: 100 }]]));
  });
  expect([...renders.values()].reduce((a, b) => a + b, 0)).toBe(501);
  expect(editor.board.nodes.get('0')?.x).toBe(0);
  expect(screen.getAllByTestId('wb-node')).toHaveLength(500);
  act(() => editor.select(['n:1']));
  expect([...renders.values()].reduce((a, b) => a + b, 0)).toBe(501);
  act(() => editor.cancel());
  expect(renders.get('0')).toBe(3);
});

it('exported bounds include outward connections and group labels are clipped', () => {
  const board = createBoard({
    nodes: [
      { ...text('a'), width: 800, height: 800 },
      {
        id: 'group',
        type: 'group',
        x: 0,
        y: 0,
        width: 100,
        height: 50,
        label: 'A long group label beyond the frame',
      },
    ],
    edges: [{ id: 'loop', fromNode: 'a', toNode: 'a', label: 'W'.repeat(200) }],
  });
  const { container } = render(<SceneSvg board={board} />);
  const svg = screen.getByTestId('wb-scene');
  const [x, y, width, height] = svg.getAttribute('viewBox')!.split(' ').map(Number);
  const path = container.querySelector('[data-edge-id="loop"] path')!.getAttribute('d')!;
  const numbers = path.match(/-?[\d.]+/g)!.map(Number);
  for (let i = 0; i < numbers.length; i += 2) {
    expect(numbers[i]).toBeGreaterThanOrEqual(x);
    expect(numbers[i]).toBeLessThanOrEqual(x + width);
    expect(numbers[i + 1]).toBeGreaterThanOrEqual(y);
    expect(numbers[i + 1]).toBeLessThanOrEqual(y + height);
  }
  expect(container.querySelector('[data-node-id="group"] text')?.getAttribute('clip-path')).toMatch(
    /^url\(#.+\)$/,
  );
});
