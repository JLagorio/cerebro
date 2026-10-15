import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NotePathContext } from '@/editor/notePath';
import { makeEntry } from '@/test/factories';
import { resetMockFs } from '@/lib/mockIpc';
import { useVaultStore } from '@/stores/vaultStore';
import { useUiStore } from '@/stores/uiStore';
import { resetFileTextCache } from './cards/useFileText';
import { newBoardFile } from './newBoardFile';
import { WhiteboardBlock } from './WhiteboardBlock';
vi.mock('./newBoardFile', () => ({ newBoardFile: vi.fn() }));
const fs = () => (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;
beforeEach(() => {
  resetMockFs();
  resetFileTextCache();
  useVaultStore.setState({
    vaultPath: '/demo-vault',
    entries: [
      makeEntry({ path: 'boards/plan.canvas', title: 'Plan' }),
      makeEntry({ path: 'diagrams/plan.mmd', title: 'Diagram' }),
      makeEntry({ path: 'plan.md', title: 'Page' }),
    ],
  });
  useUiStore.setState({ toasts: [] });
  vi.mocked(newBoardFile)
    .mockReset()
    .mockResolvedValue('delivery/whiteboards/how-we-schedule-2.canvas');
});
afterEach(cleanup);
it('offers only canvas paths and writes a pointer only on a pick', () => {
  const change = vi.fn();
  render(<WhiteboardBlock source="" onChange={change} />);
  expect(screen.getByTestId('whiteboard-block').dataset.state).toBe('unset');
  expect(screen.getAllByTestId('whiteboard-block-option')).toHaveLength(1);
  expect(change).not.toHaveBeenCalled();
  fireEvent.click(screen.getByTestId('whiteboard-block-option'));
  expect(change).toHaveBeenCalledExactlyOnceWith('board: boards/plan.canvas');
});
it('limits the picker to50 with words for the remainder', () => {
  useVaultStore.setState({
    entries: Array.from({ length: 53 }, (_, n) =>
      makeEntry({ path: `${n}.canvas`, title: `Board ${n}` }),
    ),
  });
  render(<WhiteboardBlock source="" onChange={vi.fn()} />);
  expect(screen.getAllByTestId('whiteboard-block-option')).toHaveLength(50);
  expect(screen.getByText('3 more — keep typing')).toBeTruthy();
});
it('creates beside its page once and points to the actual deduped path', async () => {
  const change = vi.fn();
  render(
    <NotePathContext.Provider value="delivery/how-we-schedule.md">
      <WhiteboardBlock source="" onChange={change} />
    </NotePathContext.Provider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'New whiteboard' }));
  fireEvent.click(screen.getByRole('button', { name: 'New whiteboard' }));
  await waitFor(() =>
    expect(change).toHaveBeenCalledExactlyOnceWith(
      'board: delivery/whiteboards/how-we-schedule-2.canvas',
    ),
  );
  expect(newBoardFile).toHaveBeenCalledExactlyOnceWith(
    '/demo-vault',
    'delivery/whiteboards/how-we-schedule.canvas',
  );
});
it('a missing pointer is unchanged until another board is chosen', async () => {
  const change = vi.fn();
  render(<WhiteboardBlock source={'board: boards/gone.canvas\nextra: kept'} onChange={change} />);
  await screen.findByText('No whiteboard at boards/gone.canvas');
  expect(screen.getByTestId('whiteboard-block').dataset.state).toBe('missing');
  expect(change).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Choose a whiteboard' }));
  expect(change).not.toHaveBeenCalled();
  fireEvent.click(screen.getByTestId('whiteboard-block-option'));
  expect(change).toHaveBeenCalledExactlyOnceWith('board: boards/plan.canvas');
});
it('a set block is a reader with Open and never an editable board', async () => {
  fs().set('boards/plan.canvas', '{"nodes":[],"edges":[]}');
  render(<WhiteboardBlock source="board: boards/plan.canvas" onChange={vi.fn()} />);
  await screen.findByTestId('wb-board');
  expect(screen.getByRole('button', { name: 'Open' })).toBeTruthy();
  expect(screen.queryByTestId('wb-input')).toBeNull();
  expect(screen.queryByTestId('whiteboard-add-card')).toBeNull();
  expect(screen.queryByRole('button', { name: 'New whiteboard' })).toBeNull();
});
it('a late creation cannot overwrite a replacement pointer or another vault', async () => {
  let resolve!: (path: string) => void;
  vi.mocked(newBoardFile).mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const change = vi.fn();
  const view = render(
    <NotePathContext.Provider value="page.md">
      <WhiteboardBlock source="" onChange={change} />
    </NotePathContext.Provider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'New whiteboard' }));
  view.rerender(
    <NotePathContext.Provider value="page.md">
      <WhiteboardBlock source="board: chosen.canvas" onChange={change} />
    </NotePathContext.Provider>,
  );
  await act(async () => resolve('old.canvas'));
  expect(change).not.toHaveBeenCalled();
});
it('read-only unset blocks offer no picker or creation', () => {
  render(
    <NotePathContext.Provider value="page.md">
      <WhiteboardBlock source="" />
    </NotePathContext.Provider>,
  );
  expect(screen.getByText('No whiteboard chosen.')).toBeTruthy();
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(screen.queryByRole('button')).toBeNull();
});

it('a batched vault round trip retires an outstanding creation', async () => {
  let resolve!: (path: string) => void;
  vi.mocked(newBoardFile).mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const change = vi.fn();
  render(
    <NotePathContext.Provider value="page.md">
      <WhiteboardBlock source="" onChange={change} />
    </NotePathContext.Provider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'New whiteboard' }));
  act(() => {
    useVaultStore.setState({ vaultPath: '/other' });
    useVaultStore.setState({ vaultPath: '/demo-vault' });
  });
  await act(async () => resolve('old.canvas'));
  expect(change).not.toHaveBeenCalled();
});
