import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MIXED } from '@/engine/scene/inspect';
import { NumberField } from './NumberField';
if (typeof window.PointerEvent === 'undefined')
  window.PointerEvent = MouseEvent as unknown as typeof window.PointerEvent;
afterEach(cleanup);
it('Enter commits once, blur does not repeat it, invalid input reverts and arrows use whole steps', () => {
  const commit = vi.fn();
  render(<NumberField label="X" value={10} onCommit={commit} />);
  const input = screen.getByRole('textbox', { name: 'X' });
  fireEvent.change(input, { target: { value: '24' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  fireEvent.blur(input);
  expect(commit).toHaveBeenCalledTimes(1);
  expect(commit).toHaveBeenLastCalledWith(24);
  fireEvent.change(input, { target: { value: '3.4' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(input).toHaveProperty('value', '10');
  fireEvent.keyDown(input, { key: 'ArrowUp', shiftKey: true });
  expect(commit).toHaveBeenLastCalledWith(20);
});
it('Mixed stays words and a refused number restores the existing value', () => {
  const commit = vi.fn(() => false);
  const { rerender } = render(<NumberField label="W" value={MIXED} onCommit={commit} />);
  const input = screen.getByRole('textbox', { name: 'W' });
  expect(input).toHaveProperty('placeholder', 'Mixed');
  fireEvent.blur(input);
  fireEvent.keyDown(input, { key: 'ArrowUp' });
  expect(commit).not.toHaveBeenCalled();
  rerender(<NumberField label="W" value={30} onCommit={commit} />);
  fireEvent.change(input, { target: { value: '-1' } });
  fireEvent.blur(input);
  expect(input).toHaveProperty('value', '30');
});
it('a scrub previews many times, release commits once, and Escape cancels', () => {
  const start = vi.fn(),
    preview = vi.fn(),
    end = vi.fn();
  render(
    <NumberField
      label="X"
      value={10}
      onCommit={vi.fn()}
      onScrubStart={start}
      onScrub={preview}
      onScrubEnd={end}
    />,
  );
  const label = screen.getByRole('button', { name: 'Adjust X' });
  fireEvent.pointerDown(label, { button: 0, clientX: 10 });
  fireEvent.pointerMove(window, { clientX: 20 });
  fireEvent.pointerMove(window, { clientX: 30 });
  fireEvent.pointerUp(window);
  expect(preview.mock.calls).toEqual([[10], [20]]);
  expect(start).toHaveBeenCalledOnce();
  expect(end.mock.calls).toEqual([[true]]);
  fireEvent.pointerDown(label, { button: 0, clientX: 10 });
  fireEvent.pointerMove(window, { clientX: 40 });
  fireEvent.keyDown(window, { key: 'Escape' });
  fireEvent.pointerUp(window);
  expect(end.mock.calls).toEqual([[true], [false]]);
});
