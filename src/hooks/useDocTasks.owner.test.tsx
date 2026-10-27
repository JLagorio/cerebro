// @vitest-environment jsdom
import { act, cleanup, render, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import * as ipc from '@/lib/ipc';
import * as mock from '@/lib/mockIpc';
import { useVaultStore } from '@/stores/vaultStore';
import { useUiStore } from '@/stores/uiStore';
import { parseTasks } from '@/engine/tasks';
import { NoteBodyEditor } from '@/editor/NoteBodyEditor';
import type { EditorReadyInfo } from '@/editor/MarkdownEditor';
import { __resetOpenPages, flushOpenPages } from '@/editor/openPages';
import { useDocTasks } from './useDocTasks';

vi.mock('@/lib/ipc', { spy: true });
const PATH = 'inbox/checklist-owner.md';
const VAULT = '/demo-vault';
const fs = () => (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;

beforeAll(async () => {
  await import('@/editor/MarkdownEditor');
});
beforeEach(async () => {
  __resetOpenPages();
  vi.resetAllMocks();
  mock.resetMockFs();
  fs().set(PATH, '# Checklist page\n\n- [ ] Call vendor\n\nSecond line.\n');
  await useVaultStore.getState().openVault(VAULT);
  useUiStore.setState({ toasts: [] });
  vi.clearAllMocks();
});
afterEach(() => {
  cleanup();
  __resetOpenPages();
  vi.resetAllMocks();
});

it.each(['applied', 'refused'] as const)(
  'reconciles a checklist tick with typing in the real open editor (%s)',
  async (outcome) => {
    const ready = vi.fn<(value: EditorReadyInfo) => void>();
    render(<NoteBodyEditor path={PATH} debounceMs={60_000} onReady={ready} />);
    const { result } = renderHook(useDocTasks);
    await waitFor(() => expect(ready).toHaveBeenCalled(), { timeout: 5_000 });
    await waitFor(() =>
      expect(result.current.tasks.some((task) => task.sourcePath === PATH)).toBe(true),
    );
    const info = ready.mock.calls[0][0];
    const originalIds = info.editor.document.map((block) => block.id);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(ipc.saveNote).mockImplementationOnce(async (vault, path, body, expected) => {
      await gate;
      if (outcome === 'refused') throw Error('disk refused');
      const ack = await mock.saveNoteBody({ vault, path, body, expectHash: expected });
      return ack.kind === 'file' ? ack.contentHash : null;
    });
    let toggle!: Promise<void>;
    await act(async () => {
      const task = result.current.tasks.find((task) => task.sourcePath === PATH)!;
      toggle = result.current.toggle(task, true);
    });
    await waitFor(() => expect(ipc.saveNote).toHaveBeenCalledOnce());
    const second = info.editor.document.find((block) =>
      JSON.stringify(block.content).includes('Second line.'),
    )!;
    act(() => info.editor.updateBlock(second, { content: 'Second line typed while ticking.' }));
    try {
      await act(async () => {
        expect((await flushOpenPages()).unresolvedOwnerIds.length).toBeGreaterThan(0);
      });
      expect(ipc.saveNoteBody).not.toHaveBeenCalled();
      expect(fs().get(PATH)).not.toContain('typed while ticking');
    } finally {
      await act(async () => {
        release();
        await toggle;
      });
    }
    const expectedTask = { text: 'Call vendor', done: outcome === 'applied' };
    await waitFor(() =>
      expect(parseTasks(PATH, info.serialize())).toEqual([expect.objectContaining(expectedTask)]),
    );
    expect(info.serialize()).toContain('Second line typed while ticking.');
    await act(() => flushOpenPages());
    expect(parseTasks(PATH, fs().get(PATH)!)).toEqual([expect.objectContaining(expectedTask)]);
    expect(fs().get(PATH)).toContain('Second line typed while ticking.');
    expect(ready).toHaveBeenCalledTimes(1);
    expect(info.editor.document.map((block) => block.id)).toEqual(
      expect.arrayContaining(originalIds),
    );
  },
);
