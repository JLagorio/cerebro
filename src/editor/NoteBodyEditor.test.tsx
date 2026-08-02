// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetMockFs } from '@/lib/mockIpc';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import type { EditorReadyInfo } from './MarkdownEditor';
import { NoteBodyEditor, type SaveState } from './NoteBodyEditor';

const PAGE = 'inbox/test-page.md';
const LOSSY_BODY = '# Page\n\n<div align="center">raw html island</div>\n';
const fs = () => (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;

type ReadyInfo = EditorReadyInfo;

async function renderReady(
  path: string,
  props: { onSaveState?: (s: SaveState) => void } = {},
): Promise<ReadyInfo> {
  const onReady = vi.fn<(info: ReadyInfo) => void>();
  render(<NoteBodyEditor path={path} debounceMs={20} onReady={onReady} {...props} />);
  await waitFor(() => expect(onReady).toHaveBeenCalled(), { timeout: 5_000 });
  return onReady.mock.calls[0][0];
}

const appendParagraph = (editor: ReadyInfo['editor'], text: string) => {
  const last = editor.document[editor.document.length - 1];
  editor.insertBlocks([{ type: 'paragraph', content: text }], last, 'after');
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 120));

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
    fs().set(PAGE, LOSSY_BODY);
    await renderReady(PAGE);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('raw HTML'));
  });

  // The banner used to be the ENTIRE mitigation: the editor stayed live and
  // the first keystroke autosaved the raw HTML out of the file 500 ms later.
  it('mounts a lossy import read-only so an edit cannot reach disk', async () => {
    fs().set(PAGE, LOSSY_BODY);
    const { editor } = await renderReady(PAGE);
    await waitFor(() => expect(screen.getByTestId('lossy-import-banner')).toBeTruthy());
    appendParagraph(editor, 'stray keystroke');
    await settle();
    expect(fs().get(PAGE)).toBe(LOSSY_BODY);
  });

  it('"Edit anyway" unlocks the editor and only then does a save land', async () => {
    fs().set(PAGE, LOSSY_BODY);
    const { editor } = await renderReady(PAGE);
    await waitFor(() => expect(screen.getByTestId('lossy-import-banner')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Edit anyway/ }));
    appendParagraph(editor, 'deliberate edit');
    await waitFor(() => expect(fs().get(PAGE)).toContain('deliberate edit'), { timeout: 5_000 });
  });

  // Autosave used to be entirely invisible — no dirty marker, no saved state.
  it('reports the save lifecycle so the host can show it', async () => {
    const states: SaveState[] = [];
    const { editor } = await renderReady(PAGE, { onSaveState: (s) => states.push(s) });
    appendParagraph(editor, 'Fresh words');
    await waitFor(() => expect(states).toContain('saved'), { timeout: 5_000 });
    expect(states).toContain('dirty');
    expect(states.indexOf('dirty')).toBeLessThan(states.indexOf('saved'));
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
    expect(useUiStore.getState().toasts.some((t) => t.message === "Couldn't load page")).toBe(true);
  });
});
