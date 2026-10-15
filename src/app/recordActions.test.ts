import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('@/lib/ipc', { spy: true });
import * as ipc from '@/lib/ipc';
import { makeEntry } from '@/engine/testHelpers';
import { useUiStore } from '@/stores/uiStore';
import { copyPageLinks } from './recordActions';
beforeEach(() => {
  vi.restoreAllMocks();
  useUiStore.setState({ toasts: [] });
  vi.spyOn(ipc, 'writeClipboard');
});
it('copies one link per page using stems instead of display titles', async () => {
  vi.mocked(ipc.writeClipboard).mockResolvedValue();
  const a = makeEntry({ path: 'notes/file.md', title: 'Different title' }),
    b = makeEntry({ path: 'tasks/key.md', properties: { key: 'WORK-1' } });
  expect(await copyPageLinks([a, b, a])).toBe(true);
  expect(ipc.writeClipboard).toHaveBeenCalledWith('[[file]]\n[[key]]');
  expect(useUiStore.getState().toasts.at(-1)?.message).toBe('2 links copied');
});
it('reports clipboard denial and an empty selection never writes', async () => {
  vi.mocked(ipc.writeClipboard).mockRejectedValue(Error('denied'));
  expect(await copyPageLinks([makeEntry()])).toBe(false);
  expect(useUiStore.getState().toasts.at(-1)?.message).toBe("Couldn't copy to the clipboard");
  vi.mocked(ipc.writeClipboard).mockClear();
  expect(await copyPageLinks([])).toBe(false);
  expect(ipc.writeClipboard).not.toHaveBeenCalled();
});
