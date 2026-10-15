// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useOsDropZone } from './useOsDropZone';
import { emitOsDrop } from '@/lib/mockDropped';
afterEach(cleanup);
function Zone({ drop }: { drop: (paths: readonly string[]) => void }) {
  const { zoneProps, over } = useOsDropZone('files-field', drop);
  return (
    <span {...zoneProps} data-testid="zone">
      {over ? 'over' : 'idle'}
    </span>
  );
}
it('registers its element, keeps its latest callback and clears hover', async () => {
  const first = vi.fn();
  const second = vi.fn();
  const view = render(<Zone drop={first} />);
  Object.defineProperty(document, 'elementFromPoint', {
    configurable: true,
    value: () => screen.getByTestId('zone'),
  });
  const position = { x: 4, y: 5 };
  act(() => emitOsDrop({ type: 'enter', paths: ['/file.pdf'], position }));
  expect(screen.getByText('over')).toBeTruthy();
  view.rerender(<Zone drop={second} />);
  await act(async () => emitOsDrop({ type: 'drop', paths: ['/file.pdf'], position }));
  expect(screen.getByText('idle')).toBeTruthy();
  expect(first).not.toHaveBeenCalled();
  expect(second).toHaveBeenCalledWith(['/file.pdf'], { x: 4, y: 5 });
  view.unmount();
});
