import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SheetGrid } from './SheetGrid';
import type { SheetSource } from '@/engine/sheet/gridEdit';
import { useUiStore } from '@/stores/uiStore';
import { SHEET_CLIPBOARD } from './clipboard';
import { parseSheetFence } from '@/engine/sheet/fence';
const restructure = vi.hoisted(() => vi.fn());
const fill = vi.hoisted(() => vi.fn());
const complete = vi.hoisted(() => vi.fn());
vi.mock('@/lib/ipc', () => ({
  sheetRestructure: restructure,
  sheetFill: fill,
  sheetComplete: complete,
}));
const base: SheetSource[] = [
  { id: 'one', source: '---\nformat: 1\nname: Budget\n---\n0,=1+1\n3,4\n' },
];
const computed = {
  ok: true as const,
  name: 'Budget',
  rows: 2,
  cols: 2,
  cells: [
    { row: 1, col: 1, kind: 'number' as const, display: '0' },
    { row: 1, col: 2, kind: 'number' as const, display: '2' },
    { row: 2, col: 1, kind: 'number' as const, display: '3' },
    { row: 2, col: 2, kind: 'number' as const, display: '4' },
  ],
};
function setup(
  options: { readOnly?: boolean; sources?: SheetSource[]; getSources?: () => SheetSource[] } = {},
) {
  const commit = vi.fn();
  const undo = vi.fn();
  const redo = vi.fn();
  const exit = vi.fn();
  function Harness() {
    const [sources, setSources] = useState(options.sources ?? base);
    return (
      <SheetGrid
        id="one"
        sources={sources}
        computed={computed}
        getSources={options.getSources}
        onCommit={
          options.readOnly
            ? undefined
            : (edits) => {
                commit(edits);
                setSources((old) => old.map((s) => edits.find((e) => e.id === s.id) ?? s));
              }
        }
        onUndo={undo}
        onRedo={redo}
        onExit={exit}
      />
    );
  }
  const view = render(<Harness />);
  const grid = screen.getByTestId('sheet-grid');
  grid.focus();
  return { ...view, grid, commit, undo, redo, exit };
}
const pointerDown = (target: Element | Window, init: MouseEventInit = {}) =>
  fireEvent(target, new MouseEvent('pointerdown', { bubbles: true, cancelable: true, ...init }));
const pointerUp = (target: Element | Window) =>
  fireEvent(target, new MouseEvent('pointerup', { bubbles: true }));
const pointerMove = (target: Element | Window, init: MouseEventInit = {}) =>
  fireEvent(target, new MouseEvent('pointermove', { bubbles: true, ...init }));
const key = (grid: Element, key: string, rest: Record<string, unknown> = {}) =>
  fireEvent.keyDown(grid, { key, ...rest });
function clipboard(
  grid: Element,
  type: 'copy' | 'cut' | 'paste',
  values: Record<string, string> = {},
) {
  const data = {
    types: Object.keys(values),
    getData: (kind: string) => values[kind] ?? '',
    setData: (kind: string, value: string) => {
      values[kind] = value;
    },
  };
  fireEvent(grid, new Event(type, { bubbles: true, cancelable: true }));
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: data });
  fireEvent(grid, event);
  return values;
}
beforeEach(() => {
  restructure.mockReset();
  fill.mockReset();
  complete.mockResolvedValue({ expecting: [], replace_from: 0 });
  useUiStore.setState({ toasts: [] });
});
describe('the editable sheet grid', () => {
  it('rejects a fill computed from an older source snapshot', async () => {
    let resolve!: (value: unknown) => void;
    fill.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    let current = base;
    const { grid, commit } = setup({ getSources: () => current });
    key(grid, 'ArrowDown', { shiftKey: true });
    key(grid, 'd', { metaKey: true });
    current = [{ ...base[0], source: base[0].source + 'changed\n' }];
    await act(async () => resolve({ source: [['0']], target: [['0']] }));
    expect(commit).not.toHaveBeenCalled();
    expect(useUiStore.getState().toasts.at(-1)?.message).toContain('changed while that ran');
  });
  it('fills down or right through one source commit and keeps read-only grids unchanged', async () => {
    fill.mockResolvedValue({ source: [['0']], target: [['0'], ['0']] });
    const { grid, commit, unmount } = setup();
    key(grid, 'ArrowDown', { shiftKey: true });
    key(grid, 'ArrowDown', { shiftKey: true });
    key(grid, 'd', { metaKey: true });
    await waitFor(() => expect(commit).toHaveBeenCalledOnce());
    expect(fill).toHaveBeenCalledWith(
      expect.any(Array),
      0,
      { row: 0, column: 0, width: 1, height: 1 },
      'rows',
      2,
    );
    expect(parseSheetFence(commit.mock.calls[0][0][0].source)).toMatchObject({
      ok: true,
      cells: expect.arrayContaining([{ row: 3, col: 1, source: '0' }]),
    });
    unmount();
    fill.mockClear();
    const readonly = setup({ readOnly: true });
    key(readonly.grid, 'ArrowRight', { shiftKey: true });
    key(readonly.grid, 'r', { metaKey: true });
    expect(fill).not.toHaveBeenCalled();
  });
  it('point-selects a cell and extends its reference while keeping the formula draft', async () => {
    complete.mockImplementation((_names, _sheet, _row, _col, text: string) =>
      Promise.resolve({
        expecting: text.endsWith('(') ? ['Range'] : ['Other'],
        replace_from: text.length - 1,
      }),
    );
    const { container, commit } = setup();
    pointerDown(container.querySelector('[data-cell=B3]')!, { button: 0 });
    pointerUp(window);
    fireEvent.doubleClick(container.querySelector('[data-cell=B3]')!);
    const input = screen.getByTestId('sheet-cell-editor') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '=SUM(', selectionStart: 5 } });
    await waitFor(() => expect(complete).toHaveBeenCalledWith(['Budget'], 0, 2, 1, '=SUM(', 5));
    await act(async () => {});
    pointerDown(container.querySelector('[data-cell=A1]')!, { button: 0 });
    pointerUp(window);
    expect(input.value).toBe('=SUM(A1');
    pointerDown(container.querySelector('[data-cell=A3]')!, {
      button: 0,
      shiftKey: true,
    });
    pointerUp(window);
    expect(input.value).toBe('=SUM(A1:A3');
    expect(commit).not.toHaveBeenCalled();
  });
  it('cancels a fill drag with Escape, and a later release commits one fill', async () => {
    fill.mockResolvedValue({ source: [['0']], target: [['0'], ['0']] });
    const { grid, container, commit } = setup();
    const hit = container.querySelector('[data-cell=A3]')!;
    const previous = document.elementFromPoint;
    document.elementFromPoint = () => hit;
    pointerDown(screen.getByTestId('sheet-fill-handle'), { button: 0 });
    pointerMove(window, { clientX: 1, clientY: 1 });
    key(grid, 'Escape');
    pointerUp(window);
    expect(fill).not.toHaveBeenCalled();
    pointerDown(screen.getByTestId('sheet-fill-handle'), { button: 0 });
    pointerMove(window, { clientX: 1, clientY: 1 });
    pointerUp(window);
    await waitFor(() => expect(commit).toHaveBeenCalledOnce());
    document.elementFromPoint = previous;
  });
  it('windows a 500-row sheet and scrolls its own viewport', () => {
    const source = {
      id: 'one',
      source: Array.from({ length: 500 }, (_, r) => String(r + 1)).join('\n'),
    };
    const { container } = setup({ sources: [source] });
    expect(container.querySelectorAll('[role=row]').length).toBeLessThanOrEqual(28);
    const viewport = screen.getByTestId('sheet-viewport');
    fireEvent.scroll(viewport, { target: { scrollTop: 3200 } });
    expect(container.querySelector('[data-cell=A1]')).toBeNull();
    expect(container.querySelector('[data-cell=A101]')).toBeTruthy();
  });
  it('shows recorded zero and blank cells, navigates and extends a range', () => {
    const { grid, container } = setup();
    expect(container.querySelector('[data-cell=A1]')?.textContent).toBe('0');
    expect(container.querySelector('[data-cell=C1]')?.textContent).toBe('');
    key(grid, 'ArrowRight');
    key(grid, 'ArrowDown', { shiftKey: true });
    expect(screen.getByTestId('sheet-address').textContent).toBe('B1:B2');
    key(grid, 'Escape');
    expect(screen.getByTestId('sheet-address').textContent).toBe('B2');
    key(grid, 'Home');
    expect(screen.getByTestId('sheet-address').textContent).toBe('A2');
  });
  it('types a replacement, commits once on Enter and lets Escape cancel a draft', () => {
    const { grid, commit } = setup();
    key(grid, 'g');
    const input = screen.getByTestId('sheet-cell-editor');
    fireEvent.change(input, { target: { value: 'gh' } });
    key(input, 'Enter');
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit.mock.calls[0][0][0].source).toContain('gh,=1+1');
    expect(screen.getByTestId('sheet-address').textContent).toBe('A2');
    key(grid, 'F2');
    fireEvent.change(screen.getByTestId('sheet-cell-editor'), { target: { value: 'discard' } });
    key(screen.getByTestId('sheet-cell-editor'), 'Escape');
    expect(screen.queryByTestId('sheet-cell-editor')).toBeNull();
    expect(commit).toHaveBeenCalledTimes(1);
  });
  it('keeps input composition, native undo and Alt Enter in the draft', () => {
    const { grid, commit, undo } = setup();
    key(grid, 'Enter');
    const input = screen.getByTestId('sheet-cell-editor') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'first' } });
    input.setSelectionRange(5, 5);
    key(input, 'Enter', { altKey: true });
    expect(input.value).toBe('first\n');
    key(input, 'Enter', { isComposing: true });
    expect(commit).not.toHaveBeenCalled();
    key(input, 'z', { metaKey: true });
    expect(undo).not.toHaveBeenCalled();
  });
  it('forwards grid Undo/Redo and keeps app shortcuts while stopping grid keys', () => {
    const { grid, undo, redo } = setup();
    const listener = vi.fn();
    window.addEventListener('keydown', listener);
    key(grid, 'ArrowRight');
    expect(listener).not.toHaveBeenCalled();
    key(grid, 'k', { metaKey: true });
    expect(listener).toHaveBeenCalledOnce();
    key(grid, 'z', { metaKey: true });
    key(grid, 'z', { metaKey: true, shiftKey: true });
    key(grid, 'y', { ctrlKey: true });
    expect(undo).toHaveBeenCalledOnce();
    expect(redo).toHaveBeenCalledTimes(2);
    window.removeEventListener('keydown', listener);
  });
  it('pastes nine cells in one commit and selects the area', () => {
    const { grid, commit } = setup();
    key(grid, 'ArrowRight');
    key(grid, 'ArrowDown');
    clipboard(grid, 'paste', { 'text/plain': '1\t2\t3\n4\t5\t6\n7\t8\t9' });
    expect(commit).toHaveBeenCalledOnce();
    expect(commit.mock.calls[0][0][0].source).toContain('3,1,2,3\n,4,5,6\n,7,8,9');
    expect(screen.getByTestId('sheet-address').textContent).toBe('B2:D4');
  });
  it('copies values and sources, then clears a cut once', () => {
    const { grid, commit } = setup();
    key(grid, 'ArrowRight');
    const data = clipboard(grid, 'copy');
    expect(data['text/plain']).toBe('2');
    expect(JSON.parse(data[SHEET_CLIPBOARD])).toEqual({ version: 1, rows: [['=1+1']] });
    clipboard(grid, 'cut');
    expect(commit).toHaveBeenCalledOnce();
    expect(commit.mock.calls[0][0][0].source).not.toContain('=1+1');
  });
  it('a read-only grid selects and copies but refuses editing, clearing and pasting', () => {
    const { grid, commit } = setup({ readOnly: true });
    key(grid, 'x');
    key(grid, 'Delete');
    clipboard(grid, 'paste', { 'text/plain': 'changed' });
    clipboard(grid, 'cut');
    expect(commit).not.toHaveBeenCalled();
    expect(screen.queryByTestId('sheet-cell-editor')).toBeNull();
    expect(clipboard(grid, 'copy')['text/plain']).toBe('0');
  });
  it('commits an open draft on real unmount', async () => {
    const { grid, commit, unmount } = setup();
    key(grid, 'x');
    fireEvent.change(screen.getByTestId('sheet-cell-editor'), { target: { value: 'kept' } });
    unmount();
    await act(async () => {
      await Promise.resolve();
    });
    expect(commit).toHaveBeenCalledOnce();
    expect(commit.mock.calls[0][0][0].source).toContain('kept');
  });
  it('flushes the draft over a newer peer snapshot and keeps its other cells', () => {
    let sources = base;
    const { grid, commit } = setup({ getSources: () => sources });
    key(grid, 'x');
    sources = [{ ...base[0], source: base[0].source.replace('3,4', '3,outside') }];
    key(screen.getByTestId('sheet-cell-editor'), 'Enter');
    expect(commit.mock.calls[0][0][0].source).toContain('3,outside');
  });
  it('inserts a row once and rejects a stale engine result', async () => {
    let resolve!: (value: { before: []; after: [] }) => void;
    restructure.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    let sources = base;
    const { commit } = setup({ getSources: () => sources });
    fireEvent.click(screen.getByTestId('sheet-structure'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Insert row above' }));
    sources = [{ ...base[0], source: base[0].source + 'new\n' }];
    await act(async () => resolve({ before: [], after: [] }));
    expect(commit).not.toHaveBeenCalled();
    expect(useUiStore.getState().toasts.at(-1)?.message).toContain('changed while that ran');
  });
  it('commits all changed fences from one structural result once', async () => {
    restructure.mockResolvedValue({
      before: [{ sheet: 0, row: 0, column: 1, source: '=1+1' }],
      after: [{ sheet: 0, row: 1, column: 1, source: '=1+1' }],
    });
    const { commit } = setup();
    fireEvent.click(screen.getByTestId('sheet-structure'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Insert row above' }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(commit).toHaveBeenCalledOnce();
    expect(commit.mock.calls[0][0][0].source).toContain('---\n\n0,=1+1\n3,4');
  });
  it('surfaces engine refusal without committing', async () => {
    restructure.mockRejectedValue(new Error('engine refusal'));
    const { commit } = setup();
    fireEvent.click(screen.getByTestId('sheet-structure'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete rows' }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(commit).not.toHaveBeenCalled();
    expect(useUiStore.getState().toasts.at(-1)?.message).toBe(
      "Couldn't change the sheet: engine refusal",
    );
  });
  it('uses tokens for paint and returns to the page after collapsing a selection', () => {
    const { grid, exit, container } = setup();
    key(grid, 'a', { metaKey: true });
    key(grid, 'Escape');
    expect(exit).not.toHaveBeenCalled();
    key(grid, 'Escape');
    expect(exit).toHaveBeenCalledOnce();
    for (const node of container.querySelectorAll<HTMLElement>('[style]'))
      for (const key of ['color', 'backgroundColor', 'borderColor'] as const) {
        const value = node.style[key];
        expect(value === '' || value.startsWith('var(--')).toBe(true);
      }
  });
});
