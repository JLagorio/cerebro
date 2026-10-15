import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as ipc from '@/lib/ipc';
import { resetMockFs } from '@/lib/mockIpc';
import { makeEntry } from '@/test/factories';
import { useVaultStore } from '@/stores/vaultStore';
import { WhiteboardEmbed } from './WhiteboardEmbed';
import { resetFileTextCache } from './cards/useFileText';
import { WhiteboardAncestry } from './ancestry';
const open = vi.fn();
vi.mock('@/app/useOpenPath', () => ({ useOpenPath: () => open }));
const path = 'boards/plan.canvas';
const source = (text: string) =>
  JSON.stringify({ nodes: [{ id: 'a', type: 'text', text, x: 0, y: 0, width: 200, height: 100 }] });
const fs = () => (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;
beforeEach(() => {
  resetFileTextCache();
  resetMockFs();
  open.mockClear();
  fs().set(path, source('First'));
  useVaultStore.setState({
    vaultPath: '/demo-vault',
    entries: [makeEntry({ path, title: 'Plan', hash: 'one' })],
  });
  vi.spyOn(ipc, 'readCanvasFile');
  vi.spyOn(ipc, 'saveCanvasFile');
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it('renders only a scene, opens the pointed page, and never saves', async () => {
  const { unmount } = render(<WhiteboardEmbed board={path} height={520} />);
  expect(await screen.findByText('First')).toBeTruthy();
  expect(screen.getByTestId('whiteboard-embed').getAttribute('data-state')).toBe('ready');
  expect(screen.getByTestId('wb-board').style.height).toBe('520px');
  expect(screen.queryByTestId('wb-input')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Open' }));
  expect(open).toHaveBeenCalledWith(path);
  unmount();
  expect(ipc.saveCanvasFile).not.toHaveBeenCalled();
  expect(fs().get(path)).toBe(source('First'));
});
it('a new scanned hash reads again and a removed pointer stays visibly missing', async () => {
  render(<WhiteboardEmbed board={path} />);
  await screen.findByText('First');
  fs().set(path, source('Second'));
  act(() => useVaultStore.setState({ entries: [makeEntry({ path, hash: 'two' })] }));
  expect(await screen.findByText('Second')).toBeTruthy();
  expect(ipc.readCanvasFile).toHaveBeenCalledTimes(2);
  fs().delete(path);
  act(() => useVaultStore.setState({ entries: [] }));
  expect(await screen.findByText(`No whiteboard at ${path}`)).toBeTruthy();
  expect(screen.queryByTestId('wb-scene')).toBeNull();
});
it('an unreadable board and failed read are unavailable with their path, never empty', async () => {
  fs().set(path, 'broken');
  render(<WhiteboardEmbed board={path} />);
  expect(await screen.findByText("This whiteboard isn't valid JSON.")).toBeTruthy();
  expect(screen.getByText(path)).toBeTruthy();
  expect(screen.queryByTestId('wb-scene')).toBeNull();
  vi.mocked(ipc.readCanvasFile).mockRejectedValueOnce(new Error('offline'));
  act(() => useVaultStore.setState({ entries: [makeEntry({ path, hash: 'two' })] }));
  await screen.findByText('This whiteboard could not be read. Try opening it again.');
  expect(screen.getByTestId('whiteboard-embed').getAttribute('data-state')).toBe('unavailable');
});
it('a late old-vault read cannot paint after switching vaults', async () => {
  let release!: (value: Awaited<ReturnType<typeof ipc.readCanvasFile>>) => void;
  vi.mocked(ipc.readCanvasFile).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  render(<WhiteboardEmbed board={path} />);
  expect(screen.getByText('Opening whiteboard…')).toBeTruthy();
  vi.mocked(ipc.readCanvasFile).mockResolvedValueOnce({
    ok: true,
    content: source('New vault'),
    hash: 'new',
  });
  act(() => useVaultStore.setState({ vaultPath: '/new-vault' }));
  await screen.findByText('New vault');
  await act(async () => release({ ok: true, content: source('Old vault'), hash: 'old' }));
  await waitFor(() => expect(screen.queryByText('Old vault')).toBeNull());
  expect(screen.getByText('New vault')).toBeTruthy();
});
it('self references do not read and two embeds share their successful bytes', async () => {
  const { rerender } = render(
    <WhiteboardAncestry.Provider value={[path]}>
      <WhiteboardEmbed board={path} />
    </WhiteboardAncestry.Provider>,
  );
  expect(screen.getByTestId('whiteboard-embed').getAttribute('data-state')).toBe('guard');
  expect(ipc.readCanvasFile).not.toHaveBeenCalled();
  rerender(
    <>
      <WhiteboardEmbed board={path} />
      <WhiteboardEmbed board={path} />
    </>,
  );
  await waitFor(() => expect(screen.getAllByText('First')).toHaveLength(2));
  expect(ipc.readCanvasFile).toHaveBeenCalledTimes(1);
});
it('a nine-board chain stops before reading the ninth board', async () => {
  const paths = Array.from({ length: 9 }, (_, i) => `chain/${i}.canvas`);
  for (let i = 0; i < paths.length; i++)
    fs().set(
      paths[i],
      JSON.stringify({
        nodes:
          i === 8
            ? []
            : [
                {
                  id: 'next',
                  type: 'file',
                  file: paths[i + 1],
                  x: 0,
                  y: 0,
                  width: 320,
                  height: 240,
                },
              ],
      }),
    );
  useVaultStore.setState({ entries: paths.map((path) => makeEntry({ path, hash: 'chain' })) });
  render(<WhiteboardEmbed board={paths[0]} />);
  expect(await screen.findByText('Open this whiteboard to see more nested boards.')).toBeTruthy();
  expect(ipc.readCanvasFile).toHaveBeenCalledTimes(8);
  expect(vi.mocked(ipc.readCanvasFile).mock.calls.some(([, path]) => path === paths[8])).toBe(
    false,
  );
});
