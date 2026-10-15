import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import {
  CanvasHeldFace,
  CanvasLoading,
  CanvasMissing,
  CanvasReadOnly,
  CanvasUnavailable,
} from './CanvasFaces';
afterEach(cleanup);
it('an unavailable file names the failure and shows source without claiming it is empty', () => {
  render(<CanvasUnavailable reason="This file isn't valid JSON." preview="{broken" />);
  expect(screen.getByTestId('canvas-unavailable').textContent).toContain(
    "This whiteboard can't be opened",
  );
  expect(screen.getByText("Cerebro won't change this file.")).toBeTruthy();
  expect(screen.getByText('{broken')).toBeTruthy();
  expect(screen.queryByTestId('canvas-empty')).toBeNull();
});
it('loading, missing and read-only are distinct faces', () => {
  const home = vi.fn();
  render(
    <>
      <CanvasLoading />
      <CanvasMissing onHome={home} />
      <CanvasReadOnly />
    </>,
  );
  expect(screen.getByTestId('canvas-loading')).toBeTruthy();
  expect(screen.getByTestId('canvas-read-only').textContent).toBe(
    'Knowledge boards are read-only here.',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Go home' }));
  expect(home).toHaveBeenCalledOnce();
});
it.each(['missing', 'unreadable'] as const)(
  'a %s hold explains why the open changes are not saved',
  (held) => {
    const reload = vi.fn(async () => {});
    render(<CanvasHeldFace held={held} reload={reload} />);
    expect(screen.getByTestId('canvas-held').textContent).toContain(
      'Your unsaved changes stay on this page',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(reload).toHaveBeenCalledOnce();
  },
);
