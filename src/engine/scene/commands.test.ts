import { describe, expect, it } from 'vitest';
import { checkSet, createBoard, orderedNodes } from './board';
import {
  addCards,
  addEdges,
  addInk,
  deleteItems,
  duplicateItems,
  moveItems,
  pasteItems,
  reorderItems,
  resizeItems,
  updateCards,
  updateEdges,
} from './commands';
import { copyFragment } from './fragments';
import type { Board, BoardNode, CommandResult, FileFacts, InkStroke } from './model';

function counter(prefix = 'id') {
  let n = 0;
  return { createId: () => `${prefix}${++n}` };
}

const facts: FileFacts = {
  extra: new Map([['custom', { deep: true }]]),
  keyOrder: ['id', 'custom'],
};

const text = (id: string, x: number, y: number, w = 100, h = 50) =>
  ({ id, type: 'text', text: id, shape: 'rectangle', x, y, width: w, height: h }) as BoardNode;

function base(): Board {
  return createBoard({
    nodes: [
      { ...text('a', 0, 0), facts, cardFacts: facts },
      text('b', 200, 0),
      { id: 'g', type: 'group', x: 500, y: 500, width: 300, height: 300 },
      text('inside', 550, 550),
      text('c', 400, 0),
    ],
    edges: [
      { id: 'ab', fromNode: 'a', toNode: 'b' },
      { id: 'bc', fromNode: 'b', toNode: 'c' },
    ],
    ink: [
      {
        id: 's',
        x: 600,
        y: 600,
        width: 20,
        height: 10,
        points: [0, 0, 500, 200, 100, 500],
        size: 4,
        simulated: true,
      },
    ],
  });
}

function ok(result: CommandResult): Extract<CommandResult, { ok: true }> {
  if (!result.ok) throw new Error(result.refusal.message);
  return result;
}

const refusal = (result: CommandResult) => (result.ok ? null : result.refusal);

describe('commands add with the caller’s ids', () => {
  it('adds cards on top with counter ids and selects them', () => {
    const board = base();
    const result = ok(
      addCards(
        board,
        {
          cards: [
            {
              type: 'text',
              text: 'hi',
              shape: 'ellipse',
              x: 0,
              y: 0,
              width: 10,
              height: 10,
              color: '#ABC',
            },
            { type: 'link', url: 'https://example.com', x: 0, y: 0, width: 10, height: 10 },
          ],
        },
        counter(),
      ),
    );
    expect(result.selection).toEqual(['n:id1', 'n:id2']);
    expect(
      orderedNodes(result.board)
        .map((n) => n.id)
        .slice(-2),
    ).toEqual(['id1', 'id2']);
    expect(result.board.nodes.get('id1')?.color).toBe('#aabbcc');
    expect(result.label).toBe('Add 2 cards');
    expect(checkSet(board, result.board)).toBeNull();
  });

  it('adds connections and ink', () => {
    const board = base();
    const edges = ok(
      addEdges(board, { edges: [{ fromNode: 'a', toNode: 'c', toEnd: 'arrow' }] }, counter('e')),
    );
    expect(edges.board.edges.get('e1')).toMatchObject({
      fromNode: 'a',
      toNode: 'c',
      toEnd: 'arrow',
    });
    const ink = ok(
      addInk(
        board,
        {
          strokes: [
            { x: 0, y: 0, width: 5, height: 5, points: [10, 10, 300], size: 2, simulated: false },
          ],
        },
        counter('s'),
      ),
    );
    expect(ink.board.ink.get('s1')?.points).toEqual([10, 10, 300]);
  });

  it('refuses in words', () => {
    const board = base();
    const card = {
      type: 'text',
      text: '',
      shape: 'rectangle',
      x: 0,
      y: 0,
      width: 10,
      height: 10,
    } as const;
    expect(refusal(addCards(board, { cards: [{ ...card, x: 0.5 }] }, counter()))?.message).toBe(
      'Card id1: x must be a whole number (got 0.5).',
    );
    expect(refusal(addCards(board, { cards: [{ ...card, width: 0 }] }, counter()))?.code).toBe(
      'box',
    );
    expect(
      refusal(addCards(board, { cards: [{ ...card, color: 'var(--accent)' }] }, counter()))?.code,
    ).toBe('color');
    expect(
      refusal(addCards(board, { cards: [{ ...card, shape: 'star' as never }] }, counter()))
        ?.message,
    ).toContain('shape "star" is unknown');
    expect(
      refusal(addEdges(board, { edges: [{ fromNode: 'a', toNode: 'nope' }] }, counter()))?.message,
    ).toBe('Connection id1 must join two cards, and there is no card nope.');
    expect(refusal(addCards(board, { cards: [card] }, { createId: () => 'a' }))?.message).toBe(
      'The id factory gave a card id a, which is already in use.',
    );
    expect(
      refusal(addCards(board, { cards: [card, card] }, { createId: () => 'same' }))?.code,
    ).toBe('id');
  });

  it('gives a new item no file facts', () => {
    const board = base();
    const card = {
      type: 'text',
      text: '',
      shape: 'rectangle',
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      facts,
    } as never;
    const result = ok(addCards(board, { cards: [card] }, counter()));
    expect(result.board.nodes.get('id1')?.facts).toBeUndefined();
  });
});

describe('no-ops return the same board', () => {
  it.each<[string, (b: Board) => CommandResult]>([
    ['an empty add', (b) => addCards(b, { cards: [] }, counter())],
    ['a zero move', (b) => moveItems(b, { keys: ['n:a'], dx: 0, dy: 0 }, counter())],
    ['a move of nothing', (b) => moveItems(b, { keys: ['n:nope'], dx: 5, dy: 5 }, counter())],
    [
      'an update to the same text',
      (b) => updateCards(b, { updates: [{ id: 'a', set: { text: 'a' } }] }, counter()),
    ],
    [
      'a resize to the same box',
      (b) =>
        resizeItems(
          b,
          { boxes: [{ key: 'n:a', box: { x: 0, y: 0, width: 100, height: 50 } }] },
          counter(),
        ),
    ],
    ['a delete of nothing', (b) => deleteItems(b, { keys: ['n:nope'] }, counter())],
    [
      'bringing the front card to the front',
      (b) => reorderItems(b, { keys: ['n:c'], to: 'front' }, counter()),
    ],
  ])('%s', (_label, run) => {
    const board = base();
    expect(ok(run(board)).board).toBe(board);
  });
});

describe('updates', () => {
  it('sets and clears fields, keeps facts, and refuses what a card lacks', () => {
    const board = base();
    const set = ok(
      updateCards(board, { updates: [{ id: 'a', set: { text: 'new', color: '3' } }] }, counter()),
    );
    expect(set.board.nodes.get('a')).toMatchObject({
      text: 'new',
      color: '3',
      facts,
      cardFacts: facts,
    });
    const cleared = ok(
      updateCards(set.board, { updates: [{ id: 'a', set: { color: null } }] }, counter()),
    );
    expect('color' in (cleared.board.nodes.get('a') as object)).toBe(false);
    expect(
      refusal(updateCards(board, { updates: [{ id: 'a', set: { text: null } }] }, counter()))?.code,
    ).toBe('value');
    expect(
      refusal(updateCards(board, { updates: [{ id: 'a', set: { url: 'x' } }] }, counter()))
        ?.message,
    ).toBe('A text card has no url an update can set.');
    expect(refusal(updateCards(board, { updates: [{ id: 'zz', set: {} }] }, counter()))?.code).toBe(
      'missing',
    );
    expect(
      refusal(updateCards(board, { updates: [{ id: 'a', set: { color: 'red' } }] }, counter()))
        ?.code,
    ).toBe('color');
  });

  it('re-points a connection only at a card that exists', () => {
    const board = base();
    const moved = ok(
      updateEdges(board, { updates: [{ id: 'ab', set: { toNode: 'c', label: 'x' } }] }, counter()),
    );
    expect(moved.board.edges.get('ab')).toMatchObject({ toNode: 'c', label: 'x' });
    expect(
      refusal(updateEdges(board, { updates: [{ id: 'ab', set: { toNode: 'gone' } }] }, counter()))
        ?.code,
    ).toBe('end');
    expect(
      refusal(
        updateEdges(board, { updates: [{ id: 'ab', set: { fromSide: 'middle' } }] }, counter()),
      )?.code,
    ).toBe('vocab');
  });
});

describe('move and resize', () => {
  it('moving a group carries its members and keeps facts', () => {
    const board = base();
    const result = ok(moveItems(board, { keys: ['n:g', 'n:a'], dx: 10, dy: -5 }, counter()));
    expect(result.board.nodes.get('g')).toMatchObject({ x: 510, y: 495 });
    expect(result.board.nodes.get('inside')).toMatchObject({ x: 560, y: 545 });
    expect(result.board.ink.get('s')).toMatchObject({ x: 610, y: 595 });
    expect(result.board.nodes.get('a')).toMatchObject({ x: 10, y: -5, facts, cardFacts: facts });
    expect(result.board.nodes.get('b')).toBe(board.nodes.get('b'));
    expect(result.label).toBe('Move 4 items');
  });

  it('refuses a fractional move', () => {
    expect(refusal(moveItems(base(), { keys: ['n:a'], dx: 0.5, dy: 0 }, counter()))?.code).toBe(
      'box',
    );
  });

  it('resizes a card, keeping facts, and scales a stroke’s points', () => {
    const board = base();
    const result = ok(
      resizeItems(
        board,
        {
          boxes: [
            { key: 'n:a', box: { x: 0, y: 0, width: 300, height: 60 } },
            { key: 'i:s', box: { x: 600, y: 600, width: 40, height: 20 } },
          ],
        },
        counter(),
      ),
    );
    expect(result.board.nodes.get('a')).toMatchObject({
      width: 300,
      height: 60,
      facts,
      cardFacts: facts,
    });
    expect((result.board.ink.get('s') as InkStroke).points).toEqual([0, 0, 500, 400, 200, 500]);
    expect(
      refusal(
        resizeItems(
          board,
          { boxes: [{ key: 'n:a', box: { x: 0, y: 0, width: 0, height: 1 } }] },
          counter(),
        ),
      )?.code,
    ).toBe('box');
    expect(
      refusal(
        resizeItems(
          board,
          { boxes: [{ key: 'e:ab', box: { x: 0, y: 0, width: 1, height: 1 } }] },
          counter(),
        ),
      )?.code,
    ).toBe('value');
  });
});

describe('delete', () => {
  it('removes every connection naming a deleted card in the same result', () => {
    const board = base();
    const result = ok(deleteItems(board, { keys: ['n:b'] }, counter()));
    expect(result.board.nodes.has('b')).toBe(false);
    expect([...result.board.edges.keys()]).toEqual([]);
    expect(result.report).toEqual({ removedEdges: 2 });
    expect(result.selection).toEqual([]);
  });

  it('deletes a group alone, leaving what sits inside it', () => {
    const result = ok(deleteItems(base(), { keys: ['n:g'] }, counter()));
    expect(result.board.nodes.has('inside')).toBe(true);
    expect(result.board.ink.has('s')).toBe(true);
  });
});

describe('reorder', () => {
  const zOf = (board: Board) => new Map([...board.nodes].map(([id, n]) => [id, n.z]));
  const order = (board: Board) => orderedNodes(board).map((n) => n.id);

  it.each([
    ['front', ['a'], ['b', 'g', 'inside', 'c', 'a']],
    ['back', ['c'], ['c', 'a', 'b', 'g', 'inside']],
    ['forward', ['a'], ['b', 'a', 'g', 'inside', 'c']],
    ['backward', ['c', 'inside'], ['a', 'b', 'inside', 'c', 'g']],
  ] as const)('%s gives new keys only to moved items', (to, ids, expected) => {
    const board = base();
    const result = ok(
      reorderItems(board, { keys: ids.map((id) => `n:${id}` as const), to }, counter()),
    );
    expect(order(result.board)).toEqual(expected);
    const before = zOf(board);
    for (const [id, z] of zOf(result.board)) {
      if ((ids as readonly string[]).includes(id)) expect(z).not.toBe(before.get(id));
      else expect(z).toBe(before.get(id));
    }
  });
});

describe('duplicate and paste', () => {
  it('duplicates through a fragment, remapping ids and offsetting by 24', () => {
    const board = base();
    const result = ok(duplicateItems(board, { keys: ['n:a', 'n:b', 'e:ab'] }, counter('d')));
    expect(result.board.nodes.get('d1')).toMatchObject({ x: 24, y: 24, facts });
    expect(result.board.edges.get('d3')).toMatchObject({ fromNode: 'd1', toNode: 'd2' });
    expect(result.report).toEqual({ droppedEdges: 1 });
    expect(result.label).toBe('Duplicate 3 items');
  });

  it('pastes a copied fragment at a given offset', () => {
    const board = base();
    const { fragment } = copyFragment(board, ['n:c']);
    const result = ok(pasteItems(board, { fragment, offset: 0 }, counter('p')));
    expect(result.board.nodes.get('p1')).toMatchObject({ x: 400, y: 0, text: 'c' });
  });
});
