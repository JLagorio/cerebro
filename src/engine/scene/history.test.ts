import { describe, expect, it } from 'vitest';
import { createBoard } from './board';
import { deleteItems, moveItems, updateCards } from './commands';
import { createSceneEditor } from './editor';
import { applyStep, stepBetween } from './history';
import { HISTORY_LIMIT } from './limits';
import type { Board, BoardNode, CommandResult, FileFacts } from './model';

const text = (id: string, x = 0) =>
  ({ id, type: 'text', text: id, shape: 'rectangle', x, y: 0, width: 10, height: 10 }) as BoardNode;

function board(): Board {
  return createBoard({
    nodes: [text('a'), text('b', 50), text('c', 100)],
    edges: [{ id: 'ab', fromNode: 'a', toNode: 'b' }],
  });
}

const ctx = { createId: () => 'never' };
const after = (result: CommandResult) => {
  if (!result.ok) throw new Error(result.refusal.message);
  return result.board;
};

describe('stepBetween', () => {
  it('holds only the changed items', () => {
    const before = board();
    const moved = after(moveItems(before, { keys: ['n:a'], dx: 5, dy: 0 }, ctx));
    const step = stepBetween(before, moved, 'Move');
    expect(step?.items.map((i) => i.key)).toEqual(['n:a']);
    expect(step?.items[0].before).toBe(before.nodes.get('a'));
    expect(step?.items[0].after).toBe(moved.nodes.get('a'));
    expect(stepBetween(before, before, 'nothing')).toBeNull();
  });

  it('records added and removed items, and board facts', () => {
    const before = board();
    const gone = after(deleteItems(before, { keys: ['n:a'] }, ctx));
    const step = stepBetween(before, gone, 'Delete');
    expect(step?.items.map((i) => [i.key, 'before' in i, 'after' in i])).toEqual([
      ['n:a', true, false],
      ['e:ab', true, false],
    ]);
    const facts: FileFacts = { extra: new Map(), keyOrder: ['nodes'] };
    expect(stepBetween(before, { ...before, facts }, 'Facts')?.board).toEqual({
      before: {},
      after: { facts },
    });
  });
});

describe('applyStep', () => {
  it('undoes and redoes a step', () => {
    const before = board();
    const gone = after(deleteItems(before, { keys: ['n:a'] }, ctx));
    const step = stepBetween(before, gone, 'Delete')!;
    const undone = applyStep(gone, step, 'undo');
    expect(undone.skipped).toEqual([]);
    expect(undone.board.nodes.get('a')).toBe(before.nodes.get('a'));
    expect(undone.board.edges.get('ab')).toBe(before.edges.get('ab'));
    const redone = applyStep(undone.board, step, 'redo');
    expect(redone.board.nodes.has('a')).toBe(false);
    expect(redone.board.edges.has('ab')).toBe(false);
  });

  it('skips an item changed since and names it, applying the rest', () => {
    const before = board();
    const moved = after(moveItems(before, { keys: ['n:a', 'n:c'], dx: 5, dy: 0 }, ctx));
    const step = stepBetween(before, moved, 'Move')!;
    const later = after(
      updateCards(moved, { updates: [{ id: 'a', set: { text: 'later' } }] }, ctx),
    );
    const undone = applyStep(later, step, 'undo');
    expect(undone.skipped).toEqual(['n:a']);
    expect(undone.board.nodes.get('a')).toMatchObject({ x: 5, text: 'later' });
    expect(undone.board.nodes.get('c')).toBe(before.nodes.get('c'));
  });

  it('never strands a connection: a restored connection waits for its card', () => {
    const before = board();
    const gone = after(deleteItems(before, { keys: ['n:a'] }, ctx));
    const step = stepBetween(before, gone, 'Delete')!;
    const nodes = new Map(gone.nodes);
    nodes.delete('b');
    const undone = applyStep({ ...gone, nodes }, step, 'undo');
    expect(undone.board.nodes.has('a')).toBe(true);
    expect(undone.board.edges.has('ab')).toBe(false);
    expect(undone.skipped).toEqual(['e:ab']);
  });
});

describe('applyStep keeps a card a later connection names', () => {
  it('skips removing it, and names it', () => {
    const before = board();
    const added = {
      ...before,
      nodes: new Map(before.nodes).set('d', { ...text('d', 200), z: 'a9' }),
    };
    const step = stepBetween(before, added, 'Add')!;
    const edges = new Map(added.edges).set('cd', { id: 'cd', z: 'a5', fromNode: 'c', toNode: 'd' });
    const undone = applyStep({ ...added, edges }, step, 'undo');
    expect(undone.board.nodes.has('d')).toBe(true);
    expect(undone.skipped).toEqual(['n:d']);
  });
});

describe('the editor’s history', () => {
  it('keeps 100 steps', () => {
    let n = 0;
    const editor = createSceneEditor(board(), { createId: () => `x${++n}` });
    for (let i = 0; i < HISTORY_LIMIT + 5; i += 1) {
      editor.execute(moveItems, { keys: ['n:a'], dx: 1, dy: 0 });
    }
    let undone = 0;
    while (editor.undo() !== null) undone += 1;
    expect(undone).toBe(HISTORY_LIMIT);
    expect(editor.board.nodes.get('a')?.x).toBe(5);
  });

  it('clears redo on a new step', () => {
    const editor = createSceneEditor(board(), ctx);
    editor.execute(moveItems, { keys: ['n:a'], dx: 1, dy: 0 });
    editor.undo();
    expect(editor.canRedo()).toBe(true);
    editor.execute(moveItems, { keys: ['n:b'], dx: 1, dy: 0 });
    expect(editor.canRedo()).toBe(false);
    expect(editor.redo()).toBeNull();
  });
});
