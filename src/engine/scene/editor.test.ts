import { describe, expect, it, vi } from 'vitest';
import { createBoard } from './board';
import { addCards, deleteItems, moveItems, updateCards } from './commands';
import { createSceneEditor, type EditorEvent } from './editor';
import type { Board, BoardNode, InkStroke, Item, ItemKey } from './model';

const text = (id: string, x = 0) =>
  ({
    id,
    type: 'text',
    text: id,
    shape: 'rectangle',
    x,
    y: 0,
    width: 100,
    height: 50,
  }) as BoardNode;

function board(): Board {
  return createBoard({
    nodes: [text('a'), text('b', 200), text('c', 400)],
    edges: [
      { id: 'ab', fromNode: 'a', toNode: 'b' },
      { id: 'bc', fromNode: 'b', toNode: 'c' },
    ],
    ink: [
      {
        id: 's',
        x: 0,
        y: 100,
        width: 10,
        height: 10,
        points: [0, 0, 500, 100, 100, 500],
        size: 2,
        simulated: true,
      },
    ],
  });
}

function editor(start = board()) {
  let n = 0;
  return createSceneEditor(start, { createId: () => `new${++n}` });
}

const node = (b: Board, id: string) => b.nodes.get(id) as BoardNode;
const overrides = (...entries: [ItemKey, Item | null][]) => new Map(entries);

describe('one drag is one undo step', () => {
  it('previews never touch the board, and commit makes exactly one step that one undo reverses', () => {
    const ed = editor();
    const start = ed.board;
    ed.begin('Move');
    for (let dx = 1; dx <= 30; dx += 1) {
      ed.preview(overrides(['n:a', { ...node(start, 'a'), x: dx + 0.4 }]));
      expect(ed.board).toBe(start);
    }
    expect(ed.gesture?.overrides.get('n:a')).toMatchObject({ x: 30.4 });
    const result = ed.commit();
    expect(result.ok).toBe(true);
    expect(node(ed.board, 'a').x).toBe(30);
    expect(ed.gesture).toBeNull();
    expect(ed.canUndo()).toBe(true);
    ed.undo();
    expect(ed.board.nodes.get('a')).toBe(start.nodes.get('a'));
    expect(ed.canUndo()).toBe(false);
  });

  it('rounds boxes and ink to whole numbers at commit', () => {
    const ed = editor();
    const s = ed.board.ink.get('s') as InkStroke;
    ed.begin('Draw');
    ed.preview(overrides(['i:s', { ...s, width: 10.6, points: [0.4, 0.6, 500, 99.5, 100, 500] }]));
    ed.commit();
    expect(ed.board.ink.get('s')).toMatchObject({ width: 11, points: [0, 1, 500, 100, 100, 500] });
  });

  it('cancel leaves no step', () => {
    const ed = editor();
    const start = ed.board;
    ed.begin('Move');
    ed.preview(overrides(['n:a', { ...node(start, 'a'), x: 99 }]));
    ed.cancel();
    expect(ed.board).toBe(start);
    expect(ed.gesture).toBeNull();
    expect(ed.canUndo()).toBe(false);
  });

  it('a commit that changes nothing records nothing', () => {
    const ed = editor();
    ed.begin('Move');
    ed.preview(overrides(['n:a', { ...node(ed.board, 'a'), x: 0.2 }]));
    expect(ed.commit().ok).toBe(true);
    expect(ed.canUndo()).toBe(false);
  });

  it('a commit checkSet refuses records nothing and ends the gesture', () => {
    const ed = editor();
    const start = ed.board;
    ed.begin('Recolour');
    ed.preview(overrides(['n:a', { ...node(start, 'a'), color: 'var(--x)' }]));
    const result = ed.commit();
    expect(result.ok ? null : result.refusal.code).toBe('color');
    expect(ed.board).toBe(start);
    expect(ed.gesture).toBeNull();
  });

  it('execute during a gesture cancels it', () => {
    const ed = editor();
    ed.begin('Move');
    ed.preview(overrides(['n:a', { ...node(ed.board, 'a'), x: 77 }]));
    ed.execute(moveItems, { keys: ['n:b'], dx: 1, dy: 0 });
    expect(ed.gesture).toBeNull();
    expect(node(ed.board, 'a').x).toBe(0);
    expect(node(ed.board, 'b').x).toBe(201);
    expect(ed.commit().ok).toBe(false);
  });
});

describe('deleting a card and its connections', () => {
  it('is one step, and one undo restores both', () => {
    const ed = editor();
    const start = ed.board;
    ed.execute(deleteItems, { keys: ['n:b'] });
    expect(ed.board.edges.size).toBe(0);
    ed.undo();
    expect(ed.board.nodes.get('b')).toBe(start.nodes.get('b'));
    expect(ed.board.edges.get('ab')).toBe(start.edges.get('ab'));
    expect(ed.board.edges.get('bc')).toBe(start.edges.get('bc'));
    expect(ed.canUndo()).toBe(false);
  });

  it('is one step when a gesture removes the card', () => {
    const ed = editor();
    const start = ed.board;
    ed.begin('Erase');
    ed.preview(overrides(['n:b', null]));
    expect(ed.commit().ok).toBe(true);
    expect(ed.board.nodes.has('b')).toBe(false);
    expect(ed.board.edges.size).toBe(0);
    ed.undo();
    expect(ed.board.edges.get('ab')).toBe(start.edges.get('ab'));
    expect(ed.board.edges.get('bc')).toBe(start.edges.get('bc'));
  });
});

describe('applyExternal', () => {
  it('is one undoable step and cancels a gesture', () => {
    const ed = editor();
    const start = ed.board;
    ed.begin('Move');
    const result = updateCards(
      start,
      { updates: [{ id: 'c', set: { text: 'outside' } }] },
      { createId: () => 'x' },
    );
    if (!result.ok) throw new Error('refused');
    ed.applyExternal(result.board, 'Changed on disk');
    expect(ed.gesture).toBeNull();
    expect(node(ed.board, 'c')).toMatchObject({ text: 'outside' });
    expect(ed.undo()?.label).toBe('Changed on disk');
    expect(ed.board).not.toBe(start);
    expect(ed.board.nodes.get('c')).toBe(start.nodes.get('c'));
  });
});

describe('selection', () => {
  it('drops deleted keys after delete and after undo', () => {
    const ed = editor();
    ed.select(['n:a', 'n:b', 'n:missing']);
    expect([...ed.selection]).toEqual(['n:a', 'n:b']);
    ed.execute(deleteItems, { keys: ['n:a'] });
    expect([...ed.selection]).toEqual([]);
    ed.undo();
    ed.select(['n:a']);
    const added = ed.execute(addCards, {
      cards: [{ type: 'link', url: 'https://x.test', x: 0, y: 0, width: 1, height: 1 }],
    });
    expect(added.ok).toBe(true);
    expect([...ed.selection]).toEqual(['n:new1']);
    ed.undo();
    expect([...ed.selection]).toEqual([]);
  });
});

describe('subscribers', () => {
  it('hear commits, undo, redo and external applies, and stop after dispose', () => {
    const ed = editor();
    const heard: EditorEvent['cause'][] = [];
    const listener = vi.fn((event: EditorEvent) => heard.push(event.cause));
    ed.subscribe(listener);
    ed.execute(moveItems, { keys: ['n:a'], dx: 1, dy: 0 });
    ed.begin('Move');
    ed.preview(overrides(['n:a', { ...node(ed.board, 'a'), x: 9 }]));
    ed.commit();
    ed.undo();
    ed.redo();
    ed.applyExternal(board(), 'Changed on disk');
    ed.begin('Move');
    ed.cancel();
    expect(heard).toEqual([
      'commit',
      'begin',
      'preview',
      'commit',
      'undo',
      'redo',
      'external',
      'begin',
      'cancel',
    ]);
    ed.dispose();
    ed.execute(moveItems, { keys: ['n:a'], dx: 1, dy: 0 });
    expect(listener).toHaveBeenCalledTimes(heard.length);
  });

  it('can unsubscribe', () => {
    const ed = editor();
    const listener = vi.fn();
    const off = ed.subscribe(listener);
    off();
    ed.execute(moveItems, { keys: ['n:a'], dx: 1, dy: 0 });
    expect(listener).not.toHaveBeenCalled();
  });
});
