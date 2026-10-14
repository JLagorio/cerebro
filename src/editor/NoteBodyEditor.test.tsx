// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeEntry } from '@/engine/testHelpers';
import { resetMockFs } from '@/lib/mockIpc';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import type { EditorReadyInfo } from './MarkdownEditor';
import { NoteBodyEditor, type SaveState } from './NoteBodyEditor';
import { __resetOpenPages, announceExternalWrites, flushOpenPages } from './openPages';

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
  await waitFor(() => expect(onReady).toHaveBeenCalled(), DISK_ROUND_TRIP);
  return onReady.mock.calls[0][0];
}

const appendParagraph = (editor: ReadyInfo['editor'], text: string) => {
  const last = editor.document[editor.document.length - 1];
  editor.insertBlocks([{ type: 'paragraph', content: text }], last, 'after');
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 120));

/**
 * The budget for any assertion waiting on the debounce → save → rescan chain.
 *
 * `waitFor`'s 1s default has no margin for it: a 20ms debounce, an async
 * mock-fs write, and (where the store's `rescan` is not stubbed) a scan of the
 * whole mock disk all have to land, on a worker the full suite is running wide
 * enough to starve. It flaked at roughly one full-suite run in seven once M29's
 * mermaid modules joined MarkdownEditor's block graph (MarkdownEditor.tsx
 * registers a `mermaid` block) — but the thin budget was always the defect, and
 * the added load only found it.
 *
 * Named rather than spelled `{ timeout: 5_000 }` per site because it was
 * spelled per site once and two sites were missed — the title-sync assertion,
 * which then failed in CI (the worst case: it needs the rescan too, not just
 * the write), and the save-failure toast, which has the same shape and had not
 * been reached yet. If an assertion here waits on disk, it takes this.
 */
const DISK_ROUND_TRIP = { timeout: 5_000 };

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
    await waitFor(() => expect(fs().get(PAGE)).toContain('Fresh words'), DISK_ROUND_TRIP);
    expect(fs().get(PAGE)!.startsWith('---\ntype: Doc\n---\n')).toBe(true);
  });

  it('an H1 edit syncs the entry title through the rescan', async () => {
    const { editor } = await renderReady(PAGE);
    editor.updateBlock(editor.document[0], { content: 'Renamed page' });
    await waitFor(() => {
      const entry = useVaultStore.getState().entries.find((e) => e.path === PAGE);
      expect(entry?.title).toBe('Renamed page');
    }, DISK_ROUND_TRIP);
  });

  it('warns when the file holds content the editor would drop', async () => {
    fs().set(PAGE, LOSSY_BODY);
    await renderReady(PAGE);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('raw HTML'));
  });

  /* The banner blamed raw HTML whatever the check found (M55.15). A link
     reference definition is markdown the editor drops, and holds no HTML. */
  it('names the cause when the file loses text that is not raw HTML', async () => {
    fs().set(PAGE, '# Page\n\nSee [the spec][spec].\n\n[spec]: https://example.com "The spec"\n');
    await renderReady(PAGE);
    const banner = await screen.findByTestId('lossy-import-banner');
    expect(banner.textContent).toContain("Parts of this file can't be shown in the rich editor.");
    expect(banner.textContent).not.toContain('HTML');
    expect(screen.getByRole('button', { name: /Edit anyway/ }).textContent).not.toContain('HTML');
  });

  /* A bare fence reopened as `javascript`, a word the file never had, and
     the page opened locked for it (M55.15). */
  it('opens a page with a bare code fence editable', async () => {
    fs().set(PAGE, '# Page\n\n```\nnpm install\n```\n');
    const { editor } = await renderReady(PAGE);
    await settle();
    expect(screen.queryByTestId('lossy-import-banner')).toBeNull();
    expect(editor.isEditable).toBe(true);
    expect(editor.document[1]).toMatchObject({ type: 'codeBlock', props: { language: '' } });
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
    await waitFor(() => expect(fs().get(PAGE)).toContain('deliberate edit'), DISK_ROUND_TRIP);
  });

  // Autosave used to be entirely invisible — no dirty marker, no saved state.
  it('reports the save lifecycle so the host can show it', async () => {
    const states: SaveState[] = [];
    const { editor } = await renderReady(PAGE, { onSaveState: (s) => states.push(s) });
    appendParagraph(editor, 'Fresh words');
    await waitFor(() => expect(states).toContain('saved'), DISK_ROUND_TRIP);
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
      const messages = useUiStore.getState().toasts.map((t) => t.message);
      // M49.6: the toast carries WHY, not just that.
      expect(messages.some((m) => m.startsWith("Couldn't save page: ") && m.length > 20)).toBe(
        true,
      );
    }, DISK_ROUND_TRIP);
  });

  it('surfaces a load failure instead of an empty editor', async () => {
    render(<NoteBodyEditor path="nope/missing.md" debounceMs={20} />);
    await waitFor(() => expect(screen.getByText("This page couldn't be loaded.")).toBeTruthy());
    expect(useUiStore.getState().toasts.some((t) => t.message === "Couldn't load page")).toBe(true);
  });
});

/**
 * Reconciling with the disk (M17.4, M53.6).
 *
 * The agent writes straight to disk through its MCP tools while you have the
 * file open. Nothing reloaded the editor, the watcher drops the echo of every
 * write the app makes (the agent's included), and the next keystroke's
 * debounce saved the stale buffer back over the agent's work — the guaranteed
 * outcome of asking the assistant to revise a note you are looking at, not a
 * narrow race. A write announced for the page's path is handled by that
 * announcement; anything else still has the modifiedAt stamp.
 */
describe('NoteBodyEditor when the file changes underneath it', () => {
  const at = (iso: string) =>
    useVaultStore.setState({
      entries: [makeEntry({ path: PAGE, filename: 'test-page.md', modifiedAt: iso })],
    });

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
      // Stubbed so a save's rescan does not replace the seeded entries with a
      // scan of the mock disk mid-assertion.
      rescan: vi.fn(async () => undefined),
    });
    useUiStore.setState({ toasts: [] });
    at('2026-08-03T10:00:00Z');
  });
  afterEach(() => {
    cleanup();
    __resetOpenPages();
  });

  /** Every editor instance this component mounts, newest last — a reload is a
   *  remount, so the new body arrives as a new onReady. */
  async function renderTracking(debounceMs: number): Promise<ReadyInfo[]> {
    const seen: ReadyInfo[] = [];
    render(
      <NoteBodyEditor path={PAGE} debounceMs={debounceMs} onReady={(i) => void seen.push(i)} />,
    );
    await waitFor(() => expect(seen.length).toBe(1), DISK_ROUND_TRIP);
    return seen;
  }

  const bodyOf = (info: ReadyInfo) => JSON.stringify(info.editor.document);

  it('reloads a clean buffer instead of letting it overwrite the new version', async () => {
    const seen = await renderTracking(20);
    expect(bodyOf(seen[0])).toContain('Body line here');

    // The agent rewrites the file and the rescan lands.
    fs().set(PAGE, '---\ntype: Doc\n---\n\n# Test page\n\nRewritten by the agent.\n');
    at('2026-08-03T10:05:00Z');

    await waitFor(() => expect(seen.length).toBe(2), DISK_ROUND_TRIP);
    expect(bodyOf(seen[1])).toContain('Rewritten by the agent');
    // Silently — a dialog on every agent write would be its own bug.
    expect(screen.queryByTestId('external-change-banner')).toBeNull();
  });

  it('asks before discarding edits the user has typed', async () => {
    // A debounce long enough that the edit is still UNSAVED when the agent's
    // write lands. That is the whole conflict: settle it first and the buffer
    // is clean, and a clean buffer has nothing to protect.
    const seen = await renderTracking(10_000);
    appendParagraph(seen[0].editor, 'my unsaved sentence');

    fs().set(PAGE, '---\ntype: Doc\n---\n\n# Test page\n\nRewritten by the agent.\n');
    at('2026-08-03T10:05:00Z');

    await waitFor(() => expect(screen.getByTestId('external-change-banner')).toBeTruthy());
    // Nothing was taken away while the question was open.
    expect(seen.length).toBe(1);
    expect(bodyOf(seen[0])).toContain('my unsaved sentence');

    fireEvent.click(screen.getByTestId('external-change-reload'));
    await waitFor(() => expect(seen.length).toBe(2), DISK_ROUND_TRIP);
    expect(bodyOf(seen[1])).toContain('Rewritten by the agent');
  });

  it('lets the user keep theirs, and stops asking once they have answered', async () => {
    const seen = await renderTracking(10_000);
    appendParagraph(seen[0].editor, 'my unsaved sentence');
    fs().set(PAGE, '---\ntype: Doc\n---\n\n# Test page\n\nRewritten by the agent.\n');
    at('2026-08-03T10:05:00Z');
    await waitFor(() => expect(screen.getByTestId('external-change-banner')).toBeTruthy());

    fireEvent.click(screen.getByTestId('external-change-keep'));
    expect(screen.queryByTestId('external-change-banner')).toBeNull();
    // A later rescan reporting the SAME mtime must not re-ask a question the
    // user has already answered.
    at('2026-08-03T10:05:00Z');
    await settle();
    expect(screen.queryByTestId('external-change-banner')).toBeNull();
    expect(seen.length).toBe(1);
  });

  it('does not mistake the user’s own save for someone else’s write', async () => {
    const info = await renderReady(PAGE);
    appendParagraph(info.editor, 'typed by me');
    await settle();
    // The save landed and the rescan moved the file's mtime.
    at('2026-08-03T10:05:00Z');
    await settle();
    expect(screen.queryByTestId('external-change-banner')).toBeNull();
  });

  // --- An agent write announced for this path (M53.6) ---------------------
  //
  // Rust stamps modifiedAt to the second, so the stamp cannot carry a write
  // in the same second as the last one. None of these move it: the
  // announcement alone has to do the work.

  const AGENT = '---\ntype: Doc\n---\n\n# Test page\n\nRewritten by the agent.\n';

  /** Announce a write to PAGE whose catch-up waits until `caughtUp()`. */
  function announcePending(): { announced: Promise<void>; caughtUp: () => void } {
    let caughtUp = () => {};
    const done = new Promise<void>((resolve) => {
      caughtUp = resolve;
    });
    let announced: Promise<void> = Promise.resolve();
    act(() => {
      announced = announceExternalWrites([PAGE], () => done);
    });
    return { announced, caughtUp };
  }

  /** The agent writes PAGE; the announcement holds until the test lets it land. */
  async function agentWritesWhileTyped(seen: ReadyInfo[]): Promise<void> {
    appendParagraph(seen[0].editor, 'my unsaved sentence');
    fs().set(PAGE, AGENT);
    const { announced, caughtUp } = announcePending();
    // The debounce fires while the write is catching up: held, not written.
    await settle();
    expect(fs().get(PAGE)).toBe(AGENT);
    await act(async () => {
      caughtUp();
      await announced;
    });
    await waitFor(() => expect(screen.getByTestId('external-change-banner')).toBeTruthy());
  }

  it('reloads a clean buffer when a write to its file is announced, with modifiedAt unchanged', async () => {
    const seen = await renderTracking(20);
    fs().set(PAGE, AGENT);
    await act(() => announceExternalWrites([PAGE], async () => undefined));
    await waitFor(() => expect(seen.length).toBe(2), DISK_ROUND_TRIP);
    expect(bodyOf(seen[1])).toContain('Rewritten by the agent');
    expect(screen.queryByTestId('external-change-banner')).toBeNull();
  });

  it('holds what was typed while an announced write lands, then asks', async () => {
    const seen = await renderTracking(20);
    await agentWritesWhileTyped(seen);
    // Nothing was taken away, and nothing was written over the agent's text.
    expect(seen.length).toBe(1);
    expect(bodyOf(seen[0])).toContain('my unsaved sentence');
    appendParagraph(seen[0].editor, 'and one more');
    await settle();
    expect(fs().get(PAGE)).toBe(AGENT);
  });

  it('Keep writes what was held', async () => {
    const seen = await renderTracking(20);
    await agentWritesWhileTyped(seen);
    appendParagraph(seen[0].editor, 'and one more');
    await settle();
    fireEvent.click(screen.getByTestId('external-change-keep'));
    expect(screen.queryByTestId('external-change-banner')).toBeNull();
    await waitFor(() => expect(fs().get(PAGE)).toContain('and one more'), DISK_ROUND_TRIP);
    expect(fs().get(PAGE)).toContain('my unsaved sentence');
    expect(fs().get(PAGE)).not.toContain('Rewritten by the agent');
  });

  it('Load drops what was held and writes nothing back, then or on leaving', async () => {
    const seen = await renderTracking(20);
    await agentWritesWhileTyped(seen);
    fireEvent.click(screen.getByTestId('external-change-reload'));
    await waitFor(() => expect(seen.length).toBe(2), DISK_ROUND_TRIP);
    expect(bodyOf(seen[1])).toContain('Rewritten by the agent');
    await settle();
    expect(fs().get(PAGE)).toBe(AGENT);
    cleanup();
    await settle();
    expect(fs().get(PAGE)).toBe(AGENT);
  });

  // The remount Load causes used to run the unmount flush, which wrote the
  // discarded buffer straight back over the version being loaded.
  it('Load cancels a save still waiting on its debounce', async () => {
    const seen = await renderTracking(10_000);
    appendParagraph(seen[0].editor, 'my unsaved sentence');
    fs().set(PAGE, AGENT);
    await act(() => announceExternalWrites([PAGE], async () => undefined));
    await waitFor(() => expect(screen.getByTestId('external-change-banner')).toBeTruthy());
    fireEvent.click(screen.getByTestId('external-change-reload'));
    await waitFor(() => expect(seen.length).toBe(2), DISK_ROUND_TRIP);
    await settle();
    expect(fs().get(PAGE)).toBe(AGENT);
  });

  it('leaving the page writes what was held: theirs wins', async () => {
    const seen = await renderTracking(20);
    await agentWritesWhileTyped(seen);
    cleanup();
    await waitFor(() => expect(fs().get(PAGE)).toContain('my unsaved sentence'), DISK_ROUND_TRIP);
  });

  it('lands a pending edit when a turn flushes the open pages', async () => {
    const seen = await renderTracking(10_000);
    appendParagraph(seen[0].editor, 'typed just before asking');
    await act(() => flushOpenPages());
    // Landed by the time the flush resolves, not ten seconds out.
    expect(fs().get(PAGE)).toContain('typed just before asking');
  });
});
