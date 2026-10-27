// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Spy mode: the real serializer and disk run; a case counts their calls.
vi.mock('@/lib/ipc', { spy: true });
vi.mock('./markdown', { spy: true });
import { Contained } from '@/app/Contained';
import { saveNoteBody } from '@/lib/ipc';
import { resetMockFs } from '@/lib/mockIpc';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { blocksToMarkdownNow } from './markdown';
import type { EditorReadyInfo } from './MarkdownEditor';
import { NoteBodyEditor, type SaveState } from './NoteBodyEditor';
import { __resetOpenPages, flushOpenPages, unresolvedDocumentOwners } from './openPages';

const PAGE = 'inbox/long-page.md';
const DISK_ROUND_TRIP = { timeout: 10_000 };
const fs = () => (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;
const serializations = () => vi.mocked(blocksToMarkdownNow).mock.calls.length;

/** Exactly 256 KiB: a title and 4 KiB paragraphs. */
function longPage(): string {
  const head = '# Long page\n\n';
  const paragraph = (i: number) => `${`Paragraph ${i} carries words. `.repeat(140).trim()}\n\n`;
  let body = head;
  for (let i = 0; body.length < 256 * 1024 - 64; i++) body += paragraph(i);
  return body.slice(0, 256 * 1024 - 5) + '\nEnd\n';
}

/** After the last character of text on the page. */
function lastTextEnd(info: EditorReadyInfo): number {
  let at = 0;
  info.editor.prosemirrorView!.state.doc.descendants((node, pos) => {
    if (node.isText) at = pos + node.nodeSize;
  });
  return at;
}

/** Type after the page's last text, one transaction per key. */
function typeAtEnd(info: EditorReadyInfo, text: string): void {
  const view = info.editor.prosemirrorView!;
  for (const character of text)
    act(() => {
      view.dispatch(view.state.tr.insertText(character, lastTextEnd(info)));
    });
}

async function renderReady(
  props: { debounceMs?: number; onSaveState?: (state: SaveState) => void } = {},
): Promise<EditorReadyInfo> {
  const onReady = vi.fn<(info: EditorReadyInfo) => void>();
  render(
    <NoteBodyEditor path={PAGE} debounceMs={props.debounceMs ?? 40} onReady={onReady} {...props} />,
  );
  await waitFor(() => expect(onReady).toHaveBeenCalled(), DISK_ROUND_TRIP);
  return onReady.mock.calls[0][0];
}

beforeAll(async () => {
  await import('./MarkdownEditor');
});

describe('lazy rich drafts in the page editor (M93.1, BL-03)', () => {
  beforeEach(() => {
    resetMockFs();
    fs().set(PAGE, '---\ntype: Doc\n---\n\n# Long page\n\nBody line here.\n');
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
  afterEach(() => {
    cleanup();
    __resetOpenPages();
    vi.mocked(saveNoteBody).mockReset();
  });

  it('serializes a 256 KiB page once per debounce window, not once per keystroke', async () => {
    fs().set(PAGE, longPage());
    const info = await renderReady({ debounceMs: 80 });
    // Let the open settle: its own round trip and any first-frame work.
    await act(() => new Promise((resolve) => setTimeout(resolve, 200)));
    for (const [window, burst] of [' first burst', ' second burst'].entries()) {
      const before = serializations();
      typeAtEnd(info, burst);
      expect(serializations() - before).toBe(0);
      await waitFor(() => expect(fs().get(PAGE)).toContain(burst), DISK_ROUND_TRIP);
      await act(() => new Promise((resolve) => setTimeout(resolve, 160)));
      expect({ window, passes: serializations() - before }).toEqual({ window, passes: 1 });
    }
    expect(fs().get(PAGE)).toContain('End first burst second burst');
  });

  it('a window that nets out reports clean and writes nothing', async () => {
    const states: SaveState[] = [];
    const info = await renderReady({ onSaveState: (state) => states.push(state) });
    const writes = vi.mocked(saveNoteBody).mock.calls.length;
    const before = fs().get(PAGE);
    typeAtEnd(info, 'x');
    expect(states.at(-1)).toBe('dirty');
    act(() => {
      const view = info.editor.prosemirrorView!;
      const at = lastTextEnd(info);
      view.dispatch(view.state.tr.delete(at - 1, at));
    });
    await act(() => new Promise((resolve) => setTimeout(resolve, 200)));
    expect(info.serialize()).toBe(info.loadedAs);
    expect(vi.mocked(saveNoteBody).mock.calls.length).toBe(writes);
    expect(fs().get(PAGE)).toBe(before);
    await waitFor(() => expect(unresolvedDocumentOwners()).toHaveLength(0));
    expect(states.at(-1)).not.toBe('dirty');
  });

  it('keeps exact text, IME composition included, through unmount and quit with no further edit', async () => {
    const info = await renderReady({ debounceMs: 60_000 });
    vi.mocked(saveNoteBody).mockRejectedValue(new Error('offline'));
    typeAtEnd(info, ' typed');
    // A composition the IME has not ended: its text is already in the document.
    fireEvent.compositionStart(info.editor.prosemirrorView!.dom);
    typeAtEnd(info, ' 日本語');
    cleanup();
    const [owner] = unresolvedDocumentOwners();
    expect(owner.snapshot().latestDraft).toBe('# Long page\n\nBody line here. typed 日本語\n');
    vi.mocked(saveNoteBody).mockReset();
    const report = await flushOpenPages();
    expect(report.unresolvedOwnerIds).toEqual([]);
    expect(fs().get(PAGE)).toBe(
      '---\ntype: Doc\n---\n\n# Long page\n\nBody line here. typed 日本語\n',
    );
  });

  it('keeps exact text through a Retry remount and saves it from Retry save', async () => {
    const info = await renderReady({ debounceMs: 60_000 });
    vi.mocked(saveNoteBody).mockRejectedValue(new Error('offline'));
    typeAtEnd(info, ' before the fault');
    // A keyed remount is what a section's Retry does; the owner is retained.
    cleanup();
    await waitFor(() => expect(unresolvedDocumentOwners()[0]?.snapshot().failure).not.toBeNull());
    vi.mocked(saveNoteBody).mockReset();
    const again = await renderReady({ debounceMs: 60_000 });
    expect(again.serialize()).toBe('# Long page\n\nBody line here. before the fault\n');
    fireEvent.click(await screen.findByRole('button', { name: 'Retry save' }, DISK_ROUND_TRIP));
    await waitFor(
      () =>
        expect(fs().get(PAGE)).toBe(
          '---\ntype: Doc\n---\n\n# Long page\n\nBody line here. before the fault\n',
        ),
      DISK_ROUND_TRIP,
    );
  });

  it('a section fault keeps exact text: the editor settles it as the boundary flushes', async () => {
    let broken = false;
    function Fault() {
      if (broken) throw new Error('render fault');
      return null;
    }
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const onReady = vi.fn<(info: EditorReadyInfo) => void>();
    const page = () => (
      <Contained label="This page">
        <Fault />
        <NoteBodyEditor path={PAGE} debounceMs={60_000} onReady={onReady} />
      </Contained>
    );
    const view = render(page());
    await waitFor(() => expect(onReady).toHaveBeenCalled(), DISK_ROUND_TRIP);
    typeAtEnd(onReady.mock.calls[0][0], ' kept through the fault');
    broken = true;
    view.rerender(page());
    expect(screen.getByTestId('section-unavailable')).toBeTruthy();
    await waitFor(
      () =>
        expect(fs().get(PAGE)).toBe(
          '---\ntype: Doc\n---\n\n# Long page\n\nBody line here. kept through the fault\n',
        ),
      DISK_ROUND_TRIP,
    );
  });
});
