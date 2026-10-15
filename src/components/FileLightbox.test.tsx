import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { resetLayers } from '@/components/ui/layers';
import { seedBytes, reset as resetBytes } from '@/lib/mockBytes';
import { FileLightbox } from './FileLightbox';

beforeEach(() => {
  resetLayers();
  resetBytes();
});
it('fits images, steps locally without wrapping, and closes through the dialog Escape layer', async () => {
  for (const path of ['a.png', 'b.png']) seedBytes('0', path, { bytes: [1, 2] });
  const close = vi.fn();
  render(<FileLightbox paths={['a.png', 'b.png']} onClose={close} />);
  expect(await screen.findByRole('img', { name: 'a.png' })).toBeTruthy();
  expect(screen.getByText('1 of 2')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Previous image' }).hasAttribute('disabled')).toBe(
    true,
  );
  fireEvent.keyDown(screen.getByRole('button', { name: 'Close' }), { key: 'ArrowRight' });
  expect(await screen.findByRole('img', { name: 'b.png' })).toBeTruthy();
  expect(screen.getByText('2 of 2')).toBeTruthy();
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowRight' });
  expect(screen.getByText('2 of 2')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Previous image' }));
  await waitFor(() => expect(screen.getByText('1 of 2')).toBeTruthy());
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  expect(close).toHaveBeenCalledOnce();
});
it('names a missing image instead of leaving an empty preview', async () => {
  render(<FileLightbox paths={['missing.png']} onClose={() => {}} />);
  await waitFor(() => expect(screen.getByRole('status').textContent).not.toBe(''));
  expect(screen.queryByRole('img')).toBeNull();
});
