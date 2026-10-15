import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ListSelectionBar } from './ListSelectionBar';
afterEach(cleanup);
it('shows selected count, copy and clear hint only when there is a selection', () => {
  const copy = vi.fn();
  const { rerender } = render(<ListSelectionBar count={0} onCopy={copy} />);
  expect(screen.queryByRole('status')).toBeNull();
  rerender(<ListSelectionBar count={2} onCopy={copy} />);
  expect(screen.getByRole('status').textContent).toContain('2 selected');
  fireEvent.click(screen.getByRole('button', { name: 'Copy links' }));
  expect(copy).toHaveBeenCalledOnce();
  expect(screen.getByRole('status').textContent).toContain('Esc clears');
  rerender(<ListSelectionBar count={2} doneHint />);
  expect(screen.queryByRole('button')).toBeNull();
  expect(screen.getByRole('status').textContent).toContain('2 selected · e marks done');
});
