import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createBoard } from '@/engine/scene/board';
import { createSceneEditor } from '@/engine/scene/editor';
import { pushLayer, popLayer } from '@/components/ui/layers';
import { useKeyRoot } from '@/lib/keys/useKeys';
import { BoardCanvas } from './BoardCanvas';
if (typeof window.PointerEvent === 'undefined')
  window.PointerEvent = MouseEvent as unknown as typeof window.PointerEvent;
const seed = () =>
  createBoard({
    nodes: [
      { id: 'g', type: 'group', label: 'Group', x: -30, y: -30, width: 400, height: 200 },
      {
        id: 'a',
        type: 'text',
        shape: 'rectangle',
        text: 'A',
        x: 20,
        y: 20,
        width: 100,
        height: 80,
      },
      {
        id: 'b',
        type: 'text',
        shape: 'rectangle',
        text: 'B',
        x: 180,
        y: 20,
        width: 100,
        height: 80,
      },
    ],
    edges: [{ id: 'e', fromNode: 'a', toNode: 'b' }],
  });
function Keys({ children }: { children: React.ReactNode }) {
  useKeyRoot();
  return children;
}
function setup() {
  let sequence = 0;
  const editor = createSceneEditor(seed(), { createId: () => `new${++sequence}` });
  const preview = vi.spyOn(editor, 'preview'),
    commit = vi.spyOn(editor, 'commit');
  render(
    <Keys>
      <BoardCanvas source={editor} name="Board" cameraKey="test" />
    </Keys>,
  );
  return { editor, preview, commit, input: screen.getByTestId('wb-input') };
}
const down = (el: Element, x: number, y: number, extra = {}) =>
  fireEvent.pointerDown(el, { button: 0, clientX: x, clientY: y, ...extra });
const move = (x: number, y: number, extra = {}) =>
  fireEvent.pointerMove(window, { clientX: x, clientY: y, ...extra });
const up = (x: number, y: number) => fireEvent.pointerUp(window, { clientX: x, clientY: y });
beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('cerebro.whiteboard.snap', JSON.stringify({ grid: false, objects: false }));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it('a sub3px gesture selects but never previews or commits; a real drag previews many times and commits once', () => {
  const { editor, preview, commit, input } = setup();
  down(input, 60, 40);
  move(62, 40);
  up(62, 40);
  expect(preview).not.toHaveBeenCalled();
  expect(commit).not.toHaveBeenCalled();
  expect(editor.selection.has('n:a')).toBe(true);
  down(input, 60, 40);
  move(70, 45);
  move(95, 65);
  up(95, 65);
  expect(preview).toHaveBeenCalledTimes(2);
  expect(commit).toHaveBeenCalledTimes(1);
  expect(editor.board.nodes.get('a')?.x).toBe(55);
  act(() => editor.undo());
  expect(editor.board.nodes.get('a')?.x).toBe(20);
});
it.each(['Escape', 'blur', 'pointercancel', 'hidden'] as const)(
  '%s cancels without a commit',
  (event) => {
    const { editor, commit, input } = setup();
    down(input, 60, 40);
    move(100, 80);
    if (event === 'Escape') fireEvent.keyDown(input, { key: 'Escape' });
    else if (event === 'blur') fireEvent(window, new Event('blur'));
    else if (event === 'hidden') {
      vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
      fireEvent(document, new Event('visibilitychange'));
    } else fireEvent.pointerCancel(window);
    up(100, 80);
    expect(commit).not.toHaveBeenCalled();
    expect(editor.board.nodes.get('a')?.x).toBe(20);
  },
);
it('Select All stays in the board scope, includes connections, and creates no edit', () => {
  const { editor, commit, input } = setup();
  input.focus();
  fireEvent.keyDown(input, { key: 'a', code: 'KeyA', ctrlKey: true });
  expect([...editor.selection]).toEqual(['n:g', 'n:a', 'n:b', 'e:e']);
  expect(commit).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: 'Escape' });
  expect(editor.selection.size).toBe(0);
});
it('object snapping shows a guide, while a modifier held at pointerdown bypasses it', () => {
  localStorage.setItem('cerebro.whiteboard.snap', JSON.stringify({ grid: false, objects: true }));
  const { editor, input } = setup();
  down(input, 60, 40);
  move(113, 47);
  move(117, 47);
  expect(screen.getAllByTestId('wb-guide').length).toBeGreaterThan(0);
  up(117, 47);
  expect(editor.board.nodes.get('a')?.x).toBe(80);
  act(() => editor.undo());
  down(input, 60, 40, { ctrlKey: true });
  move(113, 47);
  move(117, 47);
  expect(screen.queryAllByTestId('wb-guide')).toHaveLength(0);
  up(117, 47);
  expect(editor.board.nodes.get('a')?.x).toBe(77);
});
it('a group move carries its original members and one undo restores all3', () => {
  const { editor, commit, input } = setup();
  down(input, 0, -10);
  move(20, 10);
  move(40, 30);
  up(40, 30);
  expect(commit).toHaveBeenCalledTimes(1);
  expect(editor.board.nodes.get('g')?.x).toBe(10);
  expect(editor.board.nodes.get('a')?.x).toBe(60);
  expect(editor.board.nodes.get('b')?.x).toBe(220);
  act(() => editor.undo());
  expect(editor.board.nodes.get('g')?.x).toBe(-30);
  expect(editor.board.nodes.get('a')?.x).toBe(20);
});
it('Shift resize keeps ratio, Alt resizes from the centre, and each release is one commit', () => {
  const { editor, commit, input } = setup();
  down(input, 60, 40);
  up(60, 40);
  down(input, 120, 100);
  move(140, 110, { shiftKey: true });
  move(160, 120, { shiftKey: true });
  up(160, 120);
  const card = editor.board.nodes.get('a')!;
  expect(card.width / card.height).toBe(1.25);
  expect(commit).toHaveBeenCalledTimes(1);
  act(() => editor.undo());
  down(input, 120, 100);
  move(140, 120, { altKey: true });
  up(140, 120);
  expect(editor.board.nodes.get('a')).toMatchObject({ x: 0, y: 0, width: 140, height: 120 });
});
it('marquee intersects cards, not a partly enclosed group; Shift marquee adds', () => {
  const { editor, commit, input } = setup();
  down(input, 10, 10);
  move(40, 30);
  move(290, 110);
  up(290, 110);
  expect([...editor.selection]).toEqual(['n:a', 'n:b']);
  expect(screen.getByTestId('wb-selection-count').textContent).toBe('2 items selected');
  expect(commit).not.toHaveBeenCalled();
  down(input, 320, 120, { shiftKey: true });
  move(350, 150, { shiftKey: true });
  up(350, 150);
  expect(editor.selection.size).toBe(2);
});
it('an external apply during a drag ends the gesture and never commits its stale start', () => {
  const { editor, commit, input } = setup();
  down(input, 60, 40);
  move(100, 80);
  const external = createBoard({
    nodes: [...seed().nodes.values()].map((n) =>
      n.id === 'a' ? { ...n, text: 'Outside', x: 300 } : n,
    ),
    edges: [...seed().edges.values()],
  });
  act(() => editor.applyExternal(external, 'Outside'));
  up(100, 80);
  expect(commit).not.toHaveBeenCalled();
  expect(editor.board.nodes.get('a')?.x).toBe(300);
});
it('Delete takes connections in one step; held arrows are one step and separate presses are separate', () => {
  const { editor, commit, input } = setup();
  down(input, 60, 40);
  up(60, 40);
  fireEvent.keyDown(input, { key: 'ArrowRight' });
  fireEvent.keyDown(input, { key: 'ArrowRight', repeat: true });
  fireEvent.keyDown(input, { key: 'ArrowRight', repeat: true });
  expect(commit).not.toHaveBeenCalled();
  fireEvent.keyUp(window, { key: 'ArrowRight' });
  expect(commit).toHaveBeenCalledTimes(1);
  expect(editor.board.nodes.get('a')?.x).toBe(23);
  fireEvent.keyDown(input, { key: 'ArrowRight' });
  fireEvent.keyUp(window, { key: 'ArrowRight' });
  expect(commit).toHaveBeenCalledTimes(2);
  fireEvent.keyDown(input, { key: 'Delete' });
  expect(editor.board.nodes.has('a')).toBe(false);
  expect(editor.board.edges.size).toBe(0);
  fireEvent.keyDown(input, { key: 'z', code: 'KeyZ', ctrlKey: true });
  expect(editor.board.nodes.get('a')?.x).toBe(24);
  expect(editor.board.edges.size).toBe(1);
});
it('text inputs and modal layers keep their Undo key', () => {
  const { editor, input } = setup();
  down(input, 60, 40);
  move(100, 40);
  up(100, 40);
  pushLayer('test-popover');
  fireEvent.keyDown(input, { key: 'z', code: 'KeyZ', ctrlKey: true });
  expect(editor.board.nodes.get('a')?.x).toBe(60);
  popLayer('test-popover');
  const field = document.createElement('input');
  input.appendChild(field);
  field.focus();
  fireEvent.keyDown(field, { key: 'z', code: 'KeyZ', ctrlKey: true });
  expect(editor.board.nodes.get('a')?.x).toBe(60);
});
it('a nudge replaces a pointer press before its threshold and stale pointer events cannot change it', () => {
  const { editor, commit, input } = setup();
  down(input, 60, 40);
  fireEvent.keyDown(input, { key: 'ArrowRight' });
  move(100, 80);
  up(100, 80);
  expect(commit).not.toHaveBeenCalled();
  fireEvent.keyUp(window, { key: 'ArrowRight' });
  expect(commit).toHaveBeenCalledTimes(1);
  expect(editor.board.nodes.get('a')?.x).toBe(21);
  expect(editor.board.nodes.get('a')?.y).toBe(20);
});
it('Undo during a drag retires that pointer before a new held-key gesture starts', () => {
  const { editor, commit, input } = setup();
  down(input, 60, 40);
  move(80, 40);
  up(80, 40);
  expect(editor.board.nodes.get('a')?.x).toBe(40);
  commit.mockClear();
  down(input, 80, 40);
  move(110, 60);
  fireEvent.keyDown(input, { key: 'z', code: 'KeyZ', ctrlKey: true });
  fireEvent.keyDown(input, { key: 'ArrowRight' });
  move(200, 200);
  up(200, 200);
  expect(commit).not.toHaveBeenCalled();
  fireEvent.keyUp(window, { key: 'ArrowRight' });
  expect(commit).toHaveBeenCalledTimes(1);
  expect(editor.board.nodes.get('a')).toMatchObject({ x: 21, y: 20 });
});
it('a pointer press cancels a held nudge before it becomes a drag', () => {
  const { editor, commit, input } = setup();
  down(input, 60, 40);
  up(60, 40);
  fireEvent.keyDown(input, { key: 'ArrowRight' });
  down(input, 60, 40);
  fireEvent.keyUp(window, { key: 'ArrowRight' });
  expect(commit).not.toHaveBeenCalled();
  move(80, 50);
  move(100, 60);
  up(100, 60);
  expect(commit).toHaveBeenCalledTimes(1);
  expect(editor.board.nodes.get('a')).toMatchObject({ x: 60, y: 40 });
});
it('a control under the input gets its click with modifiers and changes no selection or file', () => {
  const { editor, commit, input } = setup();
  const button = document.createElement('button');
  button.dataset.boardControl = 'true';
  input.parentElement!.appendChild(button);
  const clicked = vi.fn();
  button.addEventListener('click', clicked);
  Object.defineProperty(document, 'elementsFromPoint', {
    value: () => [input, button],
    configurable: true,
  });
  const event = new MouseEvent('pointerdown', {
    button: 0,
    clientX: 20,
    clientY: 20,
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  fireEvent(input, event);
  fireEvent.click(input, { ctrlKey: true });
  expect(event.defaultPrevented).toBe(false);
  expect(clicked).toHaveBeenCalledTimes(1);
  expect(clicked.mock.calls[0][0].ctrlKey).toBe(true);
  expect(editor.selection.size).toBe(0);
  expect(commit).not.toHaveBeenCalled();
  delete (document as unknown as { elementsFromPoint?: unknown }).elementsFromPoint;
});
it.each(['Rectangle', 'Ellipse'] as const)(
  '%s draws one integer box and returns to select',
  (tool) => {
    const { editor, input, commit } = setup();
    fireEvent.click(screen.getByRole('button', { name: tool }));
    down(input, 400.2, 220.4);
    move(421.7, 230.8, { shiftKey: true, altKey: true });
    move(450.4, 250.7, { shiftKey: true, altKey: true });
    expect(editor.board.nodes.size).toBe(3);
    up(450.4, 250.7);
    const added = [...editor.board.nodes.values()].find((n) => !['a', 'b', 'g'].includes(n.id))!;
    expect(added).toMatchObject({
      type: 'text',
      shape: tool.toLowerCase(),
      width: 100,
      height: 100,
    });
    expect([added.x, added.y, added.width, added.height].every(Number.isInteger)).toBe(true);
    expect(commit).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Select' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    act(() => editor.undo());
    expect(editor.board.nodes.size).toBe(3);
    expect(editor.canUndo()).toBe(false);
  },
);
it('a shape tap uses the default size; Escape cancels a second shape completely', () => {
  const { editor, input, commit } = setup();
  fireEvent.click(screen.getByRole('button', { name: 'Rectangle' }));
  down(input, 450, 250);
  up(450, 250);
  expect([...editor.board.nodes.values()].at(-1)).toMatchObject({
    x: 370,
    y: 200,
    width: 160,
    height: 100,
  });
  fireEvent.click(screen.getByRole('button', { name: 'Ellipse' }));
  down(input, 700, 400);
  move(750, 450);
  fireEvent.keyDown(input, { key: 'Escape' });
  up(750, 450);
  expect(editor.board.nodes.size).toBe(4);
  expect(commit).toHaveBeenCalledOnce();
});
it('text creation waits for its raw draft and tool letters remain editor input', () => {
  const { editor, input } = setup();
  fireEvent.click(screen.getByRole('button', { name: 'Text' }));
  down(input, 450, 250);
  up(450, 250);
  expect(editor.canUndo()).toBe(false);
  const textbox = screen.getByTestId('wb-text-editor');
  expect(document.activeElement).toBe(textbox);
  fireEvent.keyDown(textbox, { key: 'v', code: 'KeyV' });
  fireEvent.change(textbox, { target: { value: 'v\n# Plan\n- one\n- two' } });
  expect(screen.getByTestId('wb-text-editor')).toBe(textbox);
  fireEvent.keyDown(textbox, { key: 'Enter', ctrlKey: true });
  expect(screen.queryByTestId('wb-text-editor')).toBeNull();
  expect(editor.board.nodes.get('new1')).toMatchObject({
    text: 'v\n# Plan\n- one\n- two',
    x: 450,
    y: 250,
  });
  act(() => editor.undo());
  expect(editor.board.nodes.size).toBe(3);
  expect(editor.canUndo()).toBe(false);
});
it('double-click and Enter edit an existing card, preserving one undo for each edit', () => {
  const { editor, input } = setup();
  fireEvent.doubleClick(input, { clientX: 60, clientY: 40 });
  fireEvent.change(screen.getByTestId('wb-text-editor'), { target: { value: 'Changed' } });
  fireEvent.keyDown(screen.getByTestId('wb-text-editor'), { key: 'Escape' });
  expect(editor.board.nodes.get('a')).toMatchObject({ text: 'Changed' });
  down(input, 60, 40);
  up(60, 40);
  fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
  fireEvent.change(screen.getByTestId('wb-text-editor'), { target: { value: '' } });
  fireEvent.keyDown(screen.getByTestId('wb-text-editor'), { key: 'Escape' });
  expect(editor.board.nodes.get('a')).toMatchObject({ text: '' });
  act(() => editor.undo());
  expect(editor.board.nodes.get('a')).toMatchObject({ text: 'Changed' });
  act(() => editor.undo());
  expect(editor.board.nodes.get('a')).toMatchObject({ text: 'A' });
});
it('pencil makes a dot and a stroke, each in one step, and stays active', () => {
  const { editor, input, commit } = setup();
  fireEvent.click(screen.getByRole('button', { name: 'Pencil' }));
  down(input, 450, 250);
  up(450, 250);
  expect(editor.board.ink.size).toBe(1);
  expect([...editor.board.ink.values()][0].points).toEqual([0, 0, 500]);
  down(input, 500, 250);
  move(520, 270);
  move(550, 280);
  up(550, 280);
  expect(editor.board.ink.size).toBe(2);
  expect([...editor.board.ink.values()][1].points).toHaveLength(9);
  expect(commit).toHaveBeenCalledTimes(2);
  expect(screen.getByRole('button', { name: 'Pencil' }).getAttribute('aria-pressed')).toBe('true');
  act(() => editor.undo());
  expect(editor.board.ink.size).toBe(1);
});
it('eraser fades its sweep and incident edges, Escape restores it, release is one deletion', () => {
  const { editor, input } = setup();
  const execute = vi.spyOn(editor, 'execute');
  fireEvent.click(screen.getByRole('button', { name: 'Eraser' }));
  down(input, 60, 40);
  move(70, 50);
  expect(screen.getByTestId('wb-eraser-trail')).toBeTruthy();
  expect(document.querySelector('[data-node-id="a"]')?.parentElement?.getAttribute('opacity')).toBe(
    '0.2',
  );
  expect(editor.board.nodes.has('a')).toBe(true);
  fireEvent.keyDown(input, { key: 'Escape' });
  up(70, 50);
  expect(editor.board.nodes.has('a')).toBe(true);
  expect(execute).not.toHaveBeenCalled();
  down(input, 60, 40);
  move(70, 50);
  up(70, 50);
  expect(editor.board.nodes.has('a')).toBe(false);
  expect(editor.board.edges.size).toBe(0);
  expect(execute).toHaveBeenCalledOnce();
  expect(screen.getByRole('button', { name: 'Eraser' }).getAttribute('aria-pressed')).toBe('true');
  act(() => editor.undo());
  expect(editor.board.nodes.has('a')).toBe(true);
  expect(editor.board.edges.size).toBe(1);
});
it('a pen keeps coalesced pressure samples through one commit', () => {
  const { editor, input } = setup();
  fireEvent.click(screen.getByRole('button', { name: 'Pencil' }));
  const pen = (kind: string, x: number, y: number, extras: Record<string, unknown> = {}) => {
    const event = new MouseEvent(kind, { bubbles: true, clientX: x, clientY: y, button: 0 });
    Object.defineProperties(
      event,
      Object.fromEntries(
        Object.entries({ pointerType: 'pen', pressure: 0.2, ...extras }).map(([key, value]) => [
          key,
          { value },
        ]),
      ),
    );
    return event;
  };
  fireEvent(input, pen('pointerdown', 450, 250));
  fireEvent(
    window,
    pen('pointermove', 500, 300, {
      getCoalescedEvents: () => [
        { clientX: 460, clientY: 260, pressure: 0.6 },
        { clientX: 480, clientY: 280, pressure: 0.9 },
      ],
    }),
  );
  up(500, 300);
  const stroke = [...editor.board.ink.values()][0];
  expect(stroke.simulated).toBe(false);
  expect(stroke.points.filter((_, i) => i % 3 === 2)).toEqual([200, 600, 900]);
  act(() => {
    expect(editor.undo()).not.toBeNull();
  });
});
it('a connector dragged port-to-port records both sides in one undo step', () => {
  const { editor, input } = setup();
  const execute = vi.spyOn(editor, 'execute');
  fireEvent.click(screen.getByRole('button', { name: 'Connector' }));
  down(input, 134, 60);
  move(145, 60);
  move(166, 60);
  expect(screen.getByTestId('wb-connection-preview')).toBeTruthy();
  expect(editor.board.edges.size).toBe(1);
  up(166, 60);
  expect(editor.board.edges.get('new1')).toMatchObject({
    fromNode: 'a',
    fromSide: 'right',
    toNode: 'b',
    toSide: 'left',
  });
  expect(editor.board.edges.get('new1')).not.toHaveProperty('toEnd');
  expect(execute).toHaveBeenCalledOnce();
  expect(screen.getByRole('button', { name: 'Select' }).getAttribute('aria-pressed')).toBe('true');
  act(() => editor.undo());
  expect(editor.board.edges.size).toBe(1);
  expect(editor.canUndo()).toBe(false);
});
it('line interiors omit sides and explicitly suppress the arrow', () => {
  const { editor, input } = setup();
  fireEvent.click(screen.getByRole('button', { name: 'Line' }));
  down(input, 60, 40);
  move(100, 40);
  move(220, 40);
  up(220, 40);
  const line = editor.board.edges.get('new1')!;
  expect(line).toMatchObject({ fromNode: 'a', toNode: 'b', toEnd: 'none' });
  expect(line).not.toHaveProperty('fromSide');
  expect(line).not.toHaveProperty('toSide');
});
it('empty-canvas release adds a text card and its edge in one step; source or Escape adds nothing', () => {
  const { editor, input } = setup();
  fireEvent.click(screen.getByRole('button', { name: 'Connector' }));
  down(input, 60, 40);
  move(100, 40);
  move(500, 300);
  up(500, 300);
  expect(editor.board.nodes.get('new1')).toMatchObject({
    type: 'text',
    text: '',
    x: 500,
    y: 300,
    width: 250,
    height: 60,
  });
  expect(editor.board.edges.get('new2')).toMatchObject({ fromNode: 'a', toNode: 'new1' });
  expect([...editor.selection]).toEqual(['n:new1']);
  act(() => editor.undo());
  expect(editor.board.nodes.size).toBe(3);
  expect(editor.board.edges.size).toBe(1);
  expect(editor.canUndo()).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Connector' }));
  down(input, 60, 40);
  move(80, 40);
  up(80, 40);
  expect(editor.canUndo()).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Connector' }));
  down(input, 60, 40);
  move(500, 300);
  fireEvent.keyDown(input, { key: 'Escape' });
  up(500, 300);
  expect(editor.board.nodes.size).toBe(3);
  expect(editor.board.edges.size).toBe(1);
  expect(editor.canUndo()).toBe(false);
});
it('a selected edge endpoint rebinds to a port once; empty space and its other node leave it unchanged', () => {
  const { editor, input } = setup();
  down(input, 150, 60);
  up(150, 60);
  expect([...editor.selection]).toEqual(['e:e']);
  expect(screen.getAllByTestId('wb-endpoint')).toHaveLength(2);
  down(input, 180, 60);
  move(200, 30);
  move(230, 6);
  up(230, 6);
  expect(editor.board.edges.get('e')).toMatchObject({ toNode: 'b', toSide: 'top' });
  act(() => editor.undo());
  expect(editor.board.edges.get('e')).not.toHaveProperty('toSide');
  down(input, 180, 60);
  move(500, 300);
  up(500, 300);
  expect(editor.canUndo()).toBe(false);
  down(input, 180, 60);
  move(60, 40);
  up(60, 40);
  expect(editor.board.edges.get('e')).toMatchObject({ fromNode: 'a', toNode: 'b' });
  expect(editor.canUndo()).toBe(false);
});
it('a connection label edits with Enter or double-click, and empty removes the label', () => {
  const { editor, input } = setup();
  fireEvent.doubleClick(input, { clientX: 150, clientY: 60 });
  const label = screen.getByTestId('wb-text-editor');
  expect(label.tagName).toBe('INPUT');
  fireEvent.change(label, { target: { value: 'Next step' } });
  fireEvent.keyDown(label, { key: 'Enter' });
  expect(editor.board.edges.get('e')).toHaveProperty('label', 'Next step');
  down(input, 150, 60);
  up(150, 60);
  fireEvent.keyDown(input, { key: 'Enter' });
  fireEvent.change(screen.getByTestId('wb-text-editor'), {
    target: { value: '' },
  });
  fireEvent.keyDown(screen.getByTestId('wb-text-editor'), { key: 'Escape' });
  expect(editor.board.edges.get('e')).not.toHaveProperty('label');
  act(() => editor.undo());
  expect(editor.board.edges.get('e')).toHaveProperty('label', 'Next step');
  act(() => editor.undo());
  expect(editor.board.edges.get('e')).not.toHaveProperty('label');
});
it('Duplicate and Alt-drag each add copies in one undo step; cancelled Alt-drag adds nothing', () => {
  const { editor, input } = setup();
  down(input, 60, 40);
  up(60, 40);
  fireEvent.keyDown(input, { key: 'd', code: 'KeyD', ctrlKey: true });
  expect(editor.board.nodes.get('new1')).toMatchObject({ x: 44, y: 44, text: 'A' });
  act(() => editor.undo());
  down(input, 60, 40, { altKey: true });
  move(85, 55);
  move(120, 80);
  up(120, 80);
  expect(editor.board.nodes.size).toBe(4);
  expect(editor.board.nodes.get('a')).toMatchObject({ x: 20, y: 20 });
  const copy = [...editor.board.nodes.values()].find((node) => !['a', 'b', 'g'].includes(node.id))!;
  expect(copy).toMatchObject({ x: 80, y: 60, text: 'A' });
  expect([...editor.selection]).toEqual([`n:${copy.id}`]);
  act(() => editor.undo());
  expect(editor.board.nodes.size).toBe(3);
  expect(editor.canUndo()).toBe(false);
  down(input, 60, 40, { altKey: true });
  move(100, 80);
  fireEvent.keyDown(input, { key: 'Escape' });
  up(100, 80);
  expect(editor.board.nodes.size).toBe(3);
  expect(editor.canUndo()).toBe(false);
});
it('pasting retires a connection pointer before it can commit against the changed board', () => {
  const { editor, input } = setup();
  fireEvent.click(screen.getByRole('button', { name: 'Connector' }));
  down(input, 60, 40);
  move(500, 300);
  expect(screen.getByTestId('wb-connection-preview')).toBeTruthy();
  fireEvent.paste(input, {
    clipboardData: {
      getData: (kind: string) => (kind === 'text/plain' ? 'Pasted' : ''),
      types: ['text/plain'],
      files: [],
    },
  });
  expect(screen.queryByTestId('wb-connection-preview')).toBeNull();
  up(500, 300);
  expect(editor.board.nodes.size).toBe(4);
  expect(editor.board.edges.size).toBe(1);
  act(() => editor.undo());
  expect(editor.board.nodes.size).toBe(3);
  expect(editor.canUndo()).toBe(false);
});
it('a shape colour seeds the next shape without changing the next text card family', () => {
  const { editor, input } = setup();
  fireEvent.click(screen.getByRole('button', { name: 'Rectangle' }));
  down(input, 450, 250);
  up(450, 250);
  fireEvent.click(screen.getByRole('button', { name: 'Green' }));
  fireEvent.click(screen.getByRole('button', { name: 'Rectangle' }));
  down(input, 650, 250);
  up(650, 250);
  const rectangles = [...editor.board.nodes.values()].filter(
    (node) => node.id !== 'a' && node.id !== 'b' && node.type === 'text',
  );
  expect(rectangles).toHaveLength(2);
  expect(rectangles.every((node) => node.color === '4')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Text' }));
  down(input, 850, 250);
  up(850, 250);
  fireEvent.change(screen.getByTestId('wb-text-editor'), { target: { value: 'Separate colour' } });
  fireEvent.keyDown(screen.getByTestId('wb-text-editor'), { key: 'Enter', ctrlKey: true });
  const card = [...editor.board.nodes.values()].find(
    (node) => node.type === 'text' && node.text === 'Separate colour',
  );
  expect(card).toBeDefined();
  expect(card).not.toHaveProperty('color');
});
