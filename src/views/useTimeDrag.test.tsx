import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { resetLayers } from '@/components/ui/layers';
import { useTimeDrag, type TimeDragOptions } from './useTimeDrag';

afterEach(() => {
  cleanup();
  resetLayers();
  vi.restoreAllMocks();
});
function Harness(props: TimeDragOptions) {
  const drag = useTimeDrag(props);
  return (
    <>
      <button data-testid="item" {...drag.handleProps('a')}>
        Record
      </button>
      <div data-testid="day" {...drag.slotProps('2026-07-28')} />
      <button data-testid="next" onPointerEnter={() => drag.hover(1)}>
        Next
      </button>
      <output>{JSON.stringify(drag.selection)}</output>
    </>
  );
}
const pointer = (type: string, x: number, y: number) =>
  new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y });
function move(y: number, end = true) {
  fireEvent(screen.getByTestId('item'), pointer('pointerdown', 0, 100));
  fireEvent(window, pointer('pointermove', 0, 100 + y));
  if (end) fireEvent(window, pointer('pointerup', 0, 100 + y));
}

describe('minute-axis dragging', () => {
  it('commits a 20px move as 30 minutes and ignores a 10px move', () => {
    const onCommit = vi.fn();
    render(<Harness pxPerMinute={0.8} onCommit={onCommit} />);
    move(10);
    expect(onCommit).not.toHaveBeenCalled();
    move(20);
    expect(onCommit).toHaveBeenCalledWith('a', 'move', 0, 30);
  });
  it('combines the hovered day and minutes, unless Day locks the day', () => {
    const onCommit = vi.fn();
    const rendered = render(<Harness pxPerMinute={0.8} onCommit={onCommit} />);
    move(24, false);
    fireEvent.pointerEnter(screen.getByTestId('next'));
    fireEvent(window, pointer('pointerup', 0, 124));
    expect(onCommit).toHaveBeenLastCalledWith('a', 'move', 1, 30);
    rendered.rerender(<Harness pxPerMinute={0.8} dayLocked onCommit={onCommit} />);
    move(24, false);
    fireEvent.pointerEnter(screen.getByTestId('next'));
    fireEvent(window, pointer('pointerup', 0, 124));
    expect(onCommit).toHaveBeenLastCalledWith('a', 'move', 0, 30);
  });
  it('moves and resizes with arrows while whole-day callers keep their axis', () => {
    const onCommit = vi.fn();
    const rendered = render(<Harness pxPerMinute={0.8} onCommit={onCommit} />);
    const item = screen.getByTestId('item');
    fireEvent.keyDown(item, { key: 'ArrowUp' });
    expect(onCommit).toHaveBeenLastCalledWith('a', 'move', 0, -30);
    fireEvent.keyDown(item, { key: 'ArrowDown', shiftKey: true });
    expect(onCommit).toHaveBeenLastCalledWith('a', 'end', 0, 30);
    fireEvent.keyDown(item, { key: 'ArrowRight' });
    expect(onCommit).toHaveBeenLastCalledWith('a', 'move', 1, 0);
    rendered.rerender(<Harness pxPerMinute={0.8} dayLocked onCommit={onCommit} />);
    onCommit.mockClear();
    fireEvent.keyDown(item, { key: 'ArrowLeft' });
    expect(onCommit).not.toHaveBeenCalled();
    rendered.rerender(<Harness rowDays={7} onCommit={onCommit} />);
    fireEvent.keyDown(item, { key: 'ArrowDown' });
    expect(onCommit).toHaveBeenLastCalledWith('a', 'move', 7, 0);
  });
  it.each(['Escape', 'blur', 'hidden'])('abandons on %s without writing on release', (reason) => {
    const onCommit = vi.fn();
    render(<Harness pxPerMinute={0.8} onCommit={onCommit} />);
    move(48, false);
    if (reason === 'Escape') fireEvent.keyDown(window, { key: 'Escape' });
    else if (reason === 'blur') fireEvent(window, new Event('blur'));
    else {
      vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
      fireEvent(document, new Event('visibilitychange'));
    }
    fireEvent(window, pointer('pointerup', 0, 148));
    expect(onCommit).not.toHaveBeenCalled();
  });
});

describe('empty-hour selection', () => {
  it('selects 600–720 from480–560px, and a click selects one half hour', () => {
    const onSelect = vi.fn();
    render(<Harness pxPerMinute={0.8} onCommit={vi.fn()} onSelect={onSelect} />);
    const day = screen.getByTestId('day');
    fireEvent(day, pointer('pointerdown', 0, 480));
    fireEvent(window, pointer('pointermove', 0, 560));
    fireEvent(window, pointer('pointerup', 0, 560));
    expect(onSelect).toHaveBeenLastCalledWith('2026-07-28', { start: 600, end: 720 });
    fireEvent(day, pointer('pointerdown', 0, 480));
    fireEvent(window, pointer('pointerup', 0, 480));
    expect(onSelect).toHaveBeenLastCalledWith('2026-07-28', { start: 600, end: 630 });
  });
  it('orders a reverse selection, clamps at midnight, and abandons Escape', () => {
    const onSelect = vi.fn();
    render(<Harness pxPerMinute={0.8} onCommit={vi.fn()} onSelect={onSelect} />);
    const day = screen.getByTestId('day');
    fireEvent(day, pointer('pointerdown', 0, 2000));
    fireEvent(window, pointer('pointermove', 0, 1100));
    fireEvent(window, pointer('pointerup', 0, 1100));
    expect(onSelect).toHaveBeenLastCalledWith('2026-07-28', { start: 1350, end: 1440 });
    onSelect.mockClear();
    fireEvent(day, pointer('pointerdown', 0, 480));
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent(window, pointer('pointerup', 0, 480));
    expect(onSelect).not.toHaveBeenCalled();
  });
});
