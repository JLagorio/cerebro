import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as roots from '@/lib/rootsIpc';
import { useVaultStore } from '@/stores/vaultStore';
import { makeEntry } from '@/test/factories';
import { AddCardPopover } from './AddCardPopover';
import { WhiteboardAncestry } from './ancestry';
beforeEach(() =>
  useVaultStore.setState({
    vaultPath: '/vault',
    entries: [
      makeEntry({ path: 'board.canvas' }),
      makeEntry({ path: 'other.canvas' }),
      makeEntry({ path: 'note.md', title: 'Note' }),
      makeEntry({ path: 'flow.mmd' }),
      makeEntry({ path: 'types/type.md', type: 'Type' }),
      makeEntry({ path: 'templates/start.md' }),
    ],
  }),
);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it('pages exclude schema, templates and this board and a pick fires once', () => {
  const pick = vi.fn();
  render(
    <WhiteboardAncestry.Provider value={['board.canvas']}>
      <AddCardPopover onPick={pick} />
    </WhiteboardAncestry.Provider>,
  );
  expect(screen.getAllByTestId('whiteboard-card-option')).toHaveLength(3);
  fireEvent.click(screen.getByRole('button', { name: 'Note note.md' }));
  expect(pick).toHaveBeenCalledExactlyOnceWith({ kind: 'file', file: 'note.md' });
});
it('only http(s) links can be picked and image errors never say empty', async () => {
  const pick = vi.fn();
  vi.spyOn(roots, 'listDir').mockRejectedValue(new Error('offline'));
  render(<AddCardPopover onPick={pick} />);
  fireEvent.click(screen.getByRole('tab', { name: 'Link' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Web link' }), {
    target: { value: 'javascript:alert(1)' },
  });
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Add link' }).disabled).toBe(true);
  fireEvent.change(screen.getByRole('textbox', { name: 'Web link' }), {
    target: { value: 'https://example.com/docs' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Add link' }));
  expect(pick).toHaveBeenCalledExactlyOnceWith({ kind: 'link', url: 'https://example.com/docs' });
  fireEvent.click(screen.getByRole('tab', { name: 'Images' }));
  await screen.findByText('Images could not be read. Try again.');
  expect(screen.queryByText('No images in attachments.')).toBeNull();
});
it('images use the vault attachments listing and omit folders and other file kinds', async () => {
  const pick = vi.fn();
  vi.spyOn(roots, 'listDir').mockResolvedValue([
    { name: 'poster.png', path: 'attachments/poster.png', isDir: false, size: 10, ignored: false },
    { name: 'deck.pdf', path: 'attachments/deck.pdf', isDir: false, size: 10, ignored: false },
    { name: 'folder.jpg', path: 'attachments/folder.jpg', isDir: true, size: 0, ignored: false },
  ]);
  render(<AddCardPopover onPick={pick} />);
  fireEvent.click(screen.getByRole('tab', { name: 'Images' }));
  fireEvent.click(await screen.findByRole('button', { name: 'poster.png' }));
  expect(pick).toHaveBeenCalledExactlyOnceWith({ kind: 'file', file: 'attachments/poster.png' });
  await waitFor(() => expect(screen.queryByText('deck.pdf')).toBeNull());
});
it('page results are bounded at fifty and name the remaining count', () => {
  useVaultStore.setState({
    entries: Array.from({ length: 53 }, (_, i) => makeEntry({ path: `notes/${i}.md` })),
  });
  render(<AddCardPopover onPick={vi.fn()} />);
  expect(screen.getAllByTestId('whiteboard-card-option')).toHaveLength(50);
  expect(screen.getByText('3 more — keep typing')).toBeTruthy();
});
