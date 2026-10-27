// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import * as ipc from '@/lib/ipc';
import * as mock from '@/lib/mockIpc';
import { useVaultStore } from '@/stores/vaultStore';
import { useUiStore } from '@/stores/uiStore';
import { splitFrontmatter } from '@/engine/frontmatter';
import { NoteBodyEditor } from './NoteBodyEditor';
import type { EditorReadyInfo } from './MarkdownEditor';
import { __resetOpenPages, flushOpenPages } from './openPages';

vi.mock('@/lib/ipc', { spy: true });
const PATH = 'inbox/batch-owner.md';
const VAULT = '/demo-vault';
const fs = () => (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;

beforeAll(async () => {
  await import('./MarkdownEditor');
});
beforeEach(async () => {
  __resetOpenPages();
  vi.resetAllMocks();
  mock.resetMockFs();
  fs().set(PATH, '# Batch page\n\nFirst line.\n\nSecond line.\n');
  await useVaultStore.getState().openVault(VAULT);
  useUiStore.setState({ toasts: [] });
  vi.clearAllMocks();
});
afterEach(() => {
  cleanup();
  __resetOpenPages();
  vi.resetAllMocks();
});

it.each(['applied', 'refused', 'imported'] as const)(
  'holds new editor writes through an in-flight batch (%s) and preserves the draft in place',
  async (outcome) => {
    const imported = {
      op: 'import' as const,
      system: 'notion',
      recordId: '0123456789abcdef0123456789abcdef',
      path: PATH,
      content: `---\n---\n${fs().get(PATH)!}`,
    };
    if (outcome === 'imported') {
      fs().delete(PATH);
      await mock.applyBatch(VAULT, [imported]);
      await useVaultStore.getState().rescan();
      vi.clearAllMocks();
    }
    const ready = vi.fn<(value: EditorReadyInfo) => void>();
    render(<NoteBodyEditor path={PATH} debounceMs={60_000} onReady={ready} />);
    await waitFor(() => expect(ready).toHaveBeenCalled(), { timeout: 5_000 });
    const info = ready.mock.calls[0][0];
    const originalIds = info.editor.document.map((block) => block.id);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(ipc.applyBatch).mockImplementationOnce(async (vault, ops) => {
      await gate;
      if (outcome === 'refused') throw new Error('batch refused');
      return mock.applyBatch(vault, ops);
    });
    let pending!: ReturnType<ReturnType<typeof useVaultStore.getState>['applyBatch']>;
    await act(async () => {
      const body = '# Batch page\n\nFirst line from batch.\n\nSecond line.\n';
      pending = useVaultStore
        .getState()
        .applyBatch(
          outcome === 'imported'
            ? [{ ...imported, path: 'imports/preferred-location.md', content: `---\n---\n${body}` }]
            : [{ op: 'body', path: PATH, body }],
        );
    });
    await waitFor(() => expect(ipc.applyBatch).toHaveBeenCalled());
    const second = info.editor.document.find((block) =>
      JSON.stringify(block.content).includes('Second line.'),
    )!;
    act(() => {
      info.editor.updateBlock(second, { content: 'Second line typed while waiting.' });
    });
    try {
      await act(async () => {
        const report = await flushOpenPages();
        expect(report.unresolvedOwnerIds.length).toBeGreaterThan(0);
      });
      expect(ipc.saveNoteBody).not.toHaveBeenCalled();
      expect(fs().get(PATH)).not.toContain('typed while waiting');
    } finally {
      await act(async () => {
        release();
        await pending;
      });
    }
    const first = outcome === 'refused' ? 'First line.' : 'First line from batch.';
    await waitFor(() => expect(info.serialize()).toContain(first));
    expect(info.serialize()).toContain('Second line typed while waiting.');
    await act(() => flushOpenPages());
    const body = splitFrontmatter(fs().get(PATH)!).body;
    expect(body).toContain(first);
    expect(body).toContain('Second line typed while waiting.');
    expect(ready).toHaveBeenCalledTimes(1);
    if (outcome === 'imported') expect(fs().has('imports/preferred-location.md')).toBe(false);
    expect(info.editor.document.map((block) => block.id)).toEqual(
      expect.arrayContaining(originalIds),
    );
  },
);
