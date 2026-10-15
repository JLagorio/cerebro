import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useVaultStore } from '@/stores/vaultStore';
import { useUiStore } from '@/stores/uiStore';
import { newBoardFile } from './newBoardFile';
import { NewBoardDialog } from './NewBoardDialog';

const { open } = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('@/app/useOpenPath', () => ({ useOpenPath: () => open }));
vi.mock('./newBoardFile', () => ({ newBoardFile: vi.fn() }));
beforeEach(() => {
  vi.mocked(newBoardFile).mockReset().mockResolvedValue('new-board-2.canvas');
  open.mockReset();
  useVaultStore.setState({ vaultPath: '/v' });
  useUiStore.setState({ toasts: [] });
});
afterEach(cleanup);
const fill = () =>
  fireEvent.change(screen.getByPlaceholderText('Whiteboard title'), {
    target: { value: ' New board ' },
  });
it('creates once with a slug and opens the actual deduped path', async () => {
  const close = vi.fn();
  render(<NewBoardDialog onClose={close} />);
  expect(screen.getByRole('button', { name: 'Create whiteboard' })).toHaveProperty(
    'disabled',
    true,
  );
  fill();
  fireEvent.click(screen.getByRole('button', { name: 'Create whiteboard' }));
  fireEvent.click(screen.getByRole('button', { name: 'Create whiteboard' }));
  await waitFor(() => expect(open).toHaveBeenCalledExactlyOnceWith('new-board-2.canvas'));
  expect(newBoardFile).toHaveBeenCalledExactlyOnceWith('/v', 'new-board.canvas');
  expect(close).toHaveBeenCalledTimes(1);
});
it('Cancel writes nothing and a refusal stays open with its reason', async () => {
  const close = vi.fn();
  render(<NewBoardDialog onClose={close} />);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(newBoardFile).not.toHaveBeenCalled();
  close.mockClear();
  vi.mocked(newBoardFile).mockRejectedValue(new Error('Disk is unavailable'));
  fill();
  fireEvent.click(screen.getByRole('button', { name: 'Create whiteboard' }));
  await waitFor(() =>
    expect(useUiStore.getState().toasts.at(-1)?.message).toContain('Disk is unavailable'),
  );
  expect(close).not.toHaveBeenCalled();
  expect(open).not.toHaveBeenCalled();
});
it.each(['switch', 'roundtrip', 'unmount'] as const)(
  'a late create cannot navigate after %s',
  async (end) => {
    let resolve!: (path: string) => void;
    vi.mocked(newBoardFile).mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const close = vi.fn();
    const view = render(<NewBoardDialog onClose={close} />);
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Create whiteboard' }));
    if (end === 'switch') useVaultStore.setState({ vaultPath: '/other' });
    else if (end === 'roundtrip')
      act(() => {
        useVaultStore.setState({ vaultPath: '/other' });
        useVaultStore.setState({ vaultPath: '/v' });
      });
    else view.unmount();
    await act(async () => resolve('old.canvas'));
    expect(open).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  },
);
