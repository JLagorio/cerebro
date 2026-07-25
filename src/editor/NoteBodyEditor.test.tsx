// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BlockNoteEditor } from '@blocknote/core';
import { resetMockFs } from '@/lib/mockIpc';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { NoteBodyEditor } from './NoteBodyEditor';

const PAGE = 'inbox/test-page.md';
const fs = () => (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;

type ReadyInfo = { editor: BlockNoteEditor; lossyImport: boolean };

async function renderReady(path: string): Promise<ReadyInfo> {
  const onReady = vi.fn<(info: ReadyInfo) => void>();
  render(<NoteBodyEditor path={path} debounceMs={20} onReady={onReady} />);
  await waitFor(() => expect(onReady).toHaveBeenCalled(), { timeout: 5_000 });
  return onReady.mock.calls[0][0];
}

describe('NoteBodyEditor', () => {
  beforeEach(() => {
    resetMockFs();
    fs().set(PAGE, '---\ntype: Doc\n---\n\n# Test page\n\nBody line here.\n');
    useVaultStore.setState({
      vaultPath: '/demo-vault',
      entries: [],
      views: [],
      folders: [],
      status: 'ready',
      error: null,
    });
    useUiStore.setState({ toasts: [] });
  });
  afterEach(cleanup);

  it('loads the note body into the rich editor', async () => {
    await renderReady(PAGE);
    await waitFor(() => expect(screen.getByText('Body line here.')).toBeTruthy());
  });

  it('persists a debounced edit and preserves the frontmatter', async () => {
    const { editor } = await renderReady(PAGE);
    const last = editor.document[editor.document.length - 1];
    editor.insertBlocks([{ type: 'paragraph', content: 'Fresh words' }], last, 'after');
    await waitFor(() => expect(fs().get(PAGE)).toContain('Fresh words'));
    expect(fs().get(PAGE)!.startsWith('---\ntype: Doc\n---\n')).toBe(true);
  });

  it('an H1 edit syncs the entry title through the rescan', async () => {
    const { editor } = await renderReady(PAGE);
    editor.updateBlock(editor.document[0], { content: 'Renamed page' });
    await waitFor(() => {
      const entry = useVaultStore.getState().entries.find((e) => e.path === PAGE);
      expect(entry?.title).toBe('Renamed page');
    });
  });

  it('warns when the file holds content the editor would drop', async () => {
    fs().set(PAGE, '# Page\n\n<div align="center">raw html island</div>\n');
    await renderReady(PAGE);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('raw HTML'));
  });

  it('toasts when a save fails instead of rejecting silently', async () => {
    const { editor } = await renderReady(PAGE);
    // Force the write to fail: a read-only file map stand-in — drop the
    // path so mock saveNote's mustGet throws.
    fs().delete(PAGE);
    const last = editor.document[editor.document.length - 1];
    editor.insertBlocks([{ type: 'paragraph', content: 'doomed edit' }], last, 'after');
    await waitFor(() => {
      expect(useUiStore.getState().toasts.map((t) => t.message)).toContain("Couldn't save page");
    });
  });

  it('surfaces a load failure instead of an empty editor', async () => {
    render(<NoteBodyEditor path="nope/missing.md" debounceMs={20} />);
    await waitFor(() => expect(screen.getByText("This page couldn't be loaded.")).toBeTruthy());
    expect(useUiStore.getState().toasts.some((t) => t.message === "Couldn't load page")).toBe(
      true,
    );
  });
});
