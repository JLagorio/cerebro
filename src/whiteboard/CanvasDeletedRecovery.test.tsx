// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { useCanvasFile, type CanvasFile } from './useCanvasFile';
import { BoardCanvas } from './BoardCanvas';
import { useVaultStore } from '@/stores/vaultStore';
import { resetMockFs } from '@/lib/mockIpc';
import { __resetOpenPages, announceExternalWrites, flushOpenPages } from '@/editor/openPages';
import { recoveryDrafts, discardRecovery, recoveryBundle } from '@/editor/deletedDraftRecovery';
const path = 'boards/deleted-recovery.canvas',
  vault = '/demo-vault';
const fs = () => (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;
let current: CanvasFile = { state: 'loading' };
const tick = () =>
  act(async () => {
    await Promise.resolve();
  });
beforeEach(() => {
  vi.useFakeTimers();
  resetMockFs();
  __resetOpenPages();
  useVaultStore.setState({ vaultPath: vault, entries: [] });
  fs().set(
    path,
    JSON.stringify({
      nodes: [{ id: 'a', type: 'text', text: 'Before', x: 0, y: 0, width: 100, height: 60 }],
      edges: [],
      unknown: { keep: true },
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  __resetOpenPages();
});
it('exports raw scene and invalid inspector separately, then tombstones old scene callbacks without recreating deleted target', async () => {
  function Open() {
    current = useCanvasFile(path);
    return current.state === 'ready' ? (
      <BoardCanvas source={current.editor} name="Recovery" cameraKey="recovery" />
    ) : null;
  }
  const view = render(<Open />);
  await tick();
  if (current.state !== 'ready') throw Error(current.state);
  const editor = current.editor;
  act(() => editor.select(['n:a']));
  fireEvent.change(screen.getByRole('textbox', { name: 'W' }), {
    target: { value: '  invalid width 😀  ' },
  });
  fs().delete(path);
  await act(() => announceExternalWrites([path], async () => {}));
  await tick();
  const draft = recoveryDrafts({ vaultId: vault, path })[0];
  expect(draft).toBeDefined();
  expect(JSON.parse(draft.payload.body!.text).unknown).toEqual({ keep: true });
  expect(JSON.parse(draft.payload.children['canvas-fields'])).toEqual(
    expect.arrayContaining([expect.objectContaining({ text: '  invalid width 😀  ' })]),
  );
  expect(JSON.parse(recoveryBundle(draft)).children).toEqual(draft.payload.children);
  act(() => {
    expect(discardRecovery(draft.ref)).toEqual({ kind: 'discarded' });
  });
  view.unmount();
  await tick();
  await act(() => flushOpenPages());
  expect(recoveryDrafts({ vaultId: vault, path })).toEqual([]);
  expect(fs().has(path)).toBe(false);
});
