// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Spy mode: every read still reaches the mock disk, and a case can count them.
vi.mock('@/lib/ipc', { spy: true });
import { makeEntry } from '@/engine/testHelpers';
import { readNote } from '@/lib/ipc';
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

  it('saves an edit made as soon as the editor reports ready', async () => {
    render(
      <NoteBodyEditor
        path={PAGE}
        debounceMs={20}
        onReady={({ editor }) => appendParagraph(editor, 'Edited when ready')}
      />,
    );
    await waitFor(() => expect(fs().get(PAGE)).toContain('Edited when ready'), DISK_ROUND_TRIP);
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
 * Outside writes land in the open page in place (M55.6).
 *
 * The agent writes straight to disk through its MCP tools while the file is
 * open. Its writes announce their path; any other change shows as a new
 * content hash. The page reads the body again and applies what changed as
 * edits: a clean page takes the write block by block, and a page with
 * unsaved typing merges three ways, leaving only overlaps as choices. One
 * onReady per test is one editor: nothing remounts.
 */
describe('NoteBodyEditor when the file changes underneath it', () => {
  const FILE = '---\ntype: Doc\n---\n\n# Test page\n\nFirst line.\n\nSecond line.\n';
  const withBody = (body: string) => `---\ntype: Doc\n---\n\n${body}`;
  const BODY = '# Test page\n\nFirst line.\n\nSecond line.\n';
  const AGENT = withBody(BODY.replace('First line.', 'First, by the agent.'));

  const hashed = (hash: string) =>
    useVaultStore.setState({
      entries: [makeEntry({ path: PAGE, filename: 'test-page.md', hash })],
    });

  beforeEach(() => {
    resetMockFs();
    fs().set(PAGE, FILE);
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
    hashed('h1');
  });
  afterEach(() => {
    cleanup();
    __resetOpenPages();
  });

  interface Tracked {
    seen: ReadyInfo[];
    loadedBodies: string[];
  }

  /** Every editor this component mounts, newest last, and every body it pins. */
  async function renderTracking(debounceMs: number): Promise<Tracked> {
    const seen: ReadyInfo[] = [];
    const loadedBodies: string[] = [];
    render(
      <NoteBodyEditor
        path={PAGE}
        debounceMs={debounceMs}
        onReady={(i) => void seen.push(i)}
        onBodyLoaded={(_p, raw) => void loadedBodies.push(raw)}
      />,
    );
    await waitFor(() => expect(seen.length).toBe(1), DISK_ROUND_TRIP);
    return { seen, loadedBodies };
  }

  const ids = (info: ReadyInfo) => info.editor.document.map((b) => b.id);
  /** Every block that was there is still there, by id (a trailing paragraph
   *  the view adds on its first change may join them). */
  const keptAll = (info: ReadyInfo, before: string[]) =>
    expect(ids(info)).toEqual(expect.arrayContaining(before));
  const textOf = (info: ReadyInfo) => info.serialize();
  const blockWith = (info: ReadyInfo, text: string) => {
    const block = info.editor.document.find((b) => JSON.stringify(b.content).includes(text));
    if (block === undefined) throw new Error(`no block holds ${text}`);
    return block;
  };
  /** Type over a block, as the person would. */
  const typeOver = (info: ReadyInfo, holding: string, text: string) =>
    act(() => {
      info.editor.updateBlock(blockWith(info, holding), { content: text });
    });

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

  /** The agent writes `file` to PAGE and announces it, caught up at once. */
  const agentWrites = (file: string) => {
    fs().set(PAGE, file);
    return act(() => announceExternalWrites([PAGE], async () => undefined));
  };

  /** Write, announce, and wait for the choice bar. */
  async function overlap(tracked: Tracked): Promise<void> {
    await typeOver(tracked.seen[0], 'First line.', 'First, typed by me.');
    await agentWrites(AGENT);
    await waitFor(() => expect(screen.getAllByTestId('merge-choice')).toHaveLength(1));
  }

  it('applies an announced write to a clean page in place, with no remount', async () => {
    const tracked = await renderTracking(20);
    const before = ids(tracked.seen[0]);
    const first = blockWith(tracked.seen[0], 'First line.').id;
    await agentWrites(AGENT);
    await waitFor(() => expect(textOf(tracked.seen[0])).toContain('First, by the agent.'));
    expect(tracked.seen).toHaveLength(1);
    keptAll(tracked.seen[0], before);
    expect(blockWith(tracked.seen[0], 'First, by the agent.').id).toBe(first);
    expect(tracked.loadedBodies.at(-1)).toContain('First, by the agent.');
    expect(screen.queryByTestId('merge-choices')).toBeNull();
  });

  it('applies a content-hash change nobody announced the same way', async () => {
    const tracked = await renderTracking(20);
    const before = ids(tracked.seen[0]);
    fs().set(PAGE, AGENT);
    act(() => hashed('h2'));
    await waitFor(() => expect(textOf(tracked.seen[0])).toContain('First, by the agent.'));
    expect(tracked.seen).toHaveLength(1);
    keptAll(tracked.seen[0], before);
  });

  it('reads a frontmatter-only change once and leaves the page alone', async () => {
    const tracked = await renderTracking(20);
    const before = ids(tracked.seen[0]);
    const reads = vi.mocked(readNote).mock.calls.length;
    fs().set(PAGE, FILE.replace('type: Doc', 'type: Doc\nstatus: done'));
    act(() => hashed('h2'));
    await waitFor(() => expect(vi.mocked(readNote).mock.calls.length).toBe(reads + 1));
    await settle();
    expect(vi.mocked(readNote).mock.calls.length).toBe(reads + 1);
    expect(ids(tracked.seen[0])).toEqual(before);
    expect(fs().get(PAGE)).toContain('status: done');
  });

  // M55 review: setTitle clears the hash before it rewrites the H1, so the
  // page hears h1 → null → h2. The hash after the null is a change, not a new
  // baseline, or the page keeps the old title and its next save reverts it.
  it('takes a rename that cleared the hash on its way, and a later save keeps it', async () => {
    const tracked = await renderTracking(20);
    const before = blockWith(tracked.seen[0], 'Test page').id;
    await act(async () => {
      expect(await useVaultStore.getState().setTitle(PAGE, 'Renamed page')).toBe(true);
    });
    expect(useVaultStore.getState().entries[0].hash).toBeNull();
    expect(fs().get(PAGE)).toContain('# Renamed page');
    // The rescan (stubbed here) brings the new bytes' hash.
    act(() => hashed('h2'));
    await waitFor(() => expect(textOf(tracked.seen[0])).toContain('# Renamed page'));
    expect(tracked.seen).toHaveLength(1);
    expect(blockWith(tracked.seen[0], 'Renamed page').id).toBe(before);
    await typeOver(tracked.seen[0], 'Second line.', 'Second, typed by me.');
    await waitFor(() => expect(fs().get(PAGE)).toContain('Second, typed by me.'), DISK_ROUND_TRIP);
    expect(fs().get(PAGE)).toContain('# Renamed page');
    expect(fs().get(PAGE)).not.toContain('# Test page');
  });

  it('never re-applies its own save', async () => {
    const tracked = await renderTracking(20);
    await typeOver(tracked.seen[0], 'Second line.', 'Second, typed by me.');
    await waitFor(() => expect(fs().get(PAGE)).toContain('Second, typed by me.'), DISK_ROUND_TRIP);
    const before = ids(tracked.seen[0]);
    // The save's rescan brings the new hash.
    act(() => hashed('h2'));
    await settle();
    expect(ids(tracked.seen[0])).toEqual(before);
    expect(tracked.seen).toHaveLength(1);
    expect(screen.queryByTestId('merge-choices')).toBeNull();
  });

  it('holds what is typed while a write lands, then merges it, and both reach disk', async () => {
    const tracked = await renderTracking(20);
    await typeOver(tracked.seen[0], 'Second line.', 'Second, typed by me.');
    fs().set(PAGE, AGENT);
    const { announced, caughtUp } = announcePending();
    // The debounce fires while the write is catching up: held, not written.
    await settle();
    expect(fs().get(PAGE)).toBe(AGENT);
    await act(async () => {
      caughtUp();
      await announced;
    });
    await waitFor(() => expect(fs().get(PAGE)).toContain('Second, typed by me.'), DISK_ROUND_TRIP);
    expect(fs().get(PAGE)).toContain('First, by the agent.');
    expect(textOf(tracked.seen[0])).toContain('First, by the agent.');
    expect(tracked.seen).toHaveLength(1);
    expect(screen.queryByTestId('merge-choices')).toBeNull();
  });

  it('shows one choice where both changed a block, and saves nothing while it is open', async () => {
    const tracked = await renderTracking(10_000);
    await overlap(tracked);
    expect(screen.getByRole('group', { name: 'Choose a version' }).textContent).toContain(
      'Nothing saves until you do.',
    );
    expect(screen.getByTestId('merge-choice').textContent).toContain('First, typed by me.');
    expect(screen.getByTestId('merge-choice').textContent).toContain('First, by the agent.');
    expect(textOf(tracked.seen[0])).toContain('First, typed by me.');
    // More typing, landed by a turn's flush: held, so the disk keeps the agent's text.
    await typeOver(tracked.seen[0], 'Second line.', 'Second, typed too.');
    await act(() => flushOpenPages());
    await settle();
    expect(fs().get(PAGE)).toBe(AGENT);
  });

  it('Keep yours writes yours', async () => {
    const tracked = await renderTracking(10_000);
    await overlap(tracked);
    fireEvent.click(screen.getByTestId('merge-keep-mine'));
    expect(screen.queryByTestId('merge-choices')).toBeNull();
    await waitFor(() => expect(fs().get(PAGE)).toContain('First, typed by me.'), DISK_ROUND_TRIP);
    expect(tracked.seen).toHaveLength(1);
  });

  it('Use new takes the agent’s block and writes nothing', async () => {
    const tracked = await renderTracking(10_000);
    await overlap(tracked);
    fireEvent.click(screen.getByTestId('merge-take-theirs'));
    expect(screen.queryByTestId('merge-choices')).toBeNull();
    expect(textOf(tracked.seen[0])).toContain('First, by the agent.');
    expect(textOf(tracked.seen[0])).not.toContain('typed by me');
    await settle();
    expect(fs().get(PAGE)).toBe(AGENT);
    expect(tracked.seen).toHaveLength(1);
  });

  it('leaving the page with a choice open writes yours', async () => {
    const tracked = await renderTracking(10_000);
    await overlap(tracked);
    cleanup();
    await waitFor(() => expect(fs().get(PAGE)).toContain('First, typed by me.'), DISK_ROUND_TRIP);
  });

  it('lands a second write elsewhere while a choice is open, and keeps the choice', async () => {
    const tracked = await renderTracking(10_000);
    await overlap(tracked);
    const again = AGENT.replace('Second line.', 'Second, by the agent.');
    await agentWrites(again);
    await waitFor(() => expect(textOf(tracked.seen[0])).toContain('Second, by the agent.'));
    expect(screen.getAllByTestId('merge-choice')).toHaveLength(1);
    expect(textOf(tracked.seen[0])).toContain('First, typed by me.');
    expect(fs().get(PAGE)).toBe(again);
  });

  it('remounts a clean page read-only for a write the editor cannot show', async () => {
    const tracked = await renderTracking(20);
    await agentWrites(withBody(`${BODY}\n<div align="center">raw html island</div>\n`));
    await waitFor(() => expect(tracked.seen).toHaveLength(2), DISK_ROUND_TRIP);
    await waitFor(() => expect(screen.getByTestId('lossy-import-banner')).toBeTruthy());
  });

  it('offers a dirty page the whole page for such a write, and Use new remounts', async () => {
    const tracked = await renderTracking(10_000);
    await typeOver(tracked.seen[0], 'Second line.', 'Second, typed by me.');
    const lossy = withBody(`${BODY}\n<div align="center">raw html island</div>\n`);
    await agentWrites(lossy);
    await waitFor(() => expect(screen.getAllByTestId('merge-choice')).toHaveLength(1));
    expect(tracked.seen).toHaveLength(1);
    fireEvent.click(screen.getByTestId('merge-take-theirs'));
    await waitFor(() => expect(tracked.seen).toHaveLength(2), DISK_ROUND_TRIP);
    await settle();
    expect(fs().get(PAGE)).toBe(lossy);
  });

  it('re-reads a locked lossy page', async () => {
    fs().set(PAGE, withBody(LOSSY_BODY));
    const tracked = await renderTracking(20);
    await waitFor(() => expect(screen.getByTestId('lossy-import-banner')).toBeTruthy());
    await agentWrites(withBody(LOSSY_BODY.replace('# Page', '# Page, renamed')));
    await waitFor(() => expect(tracked.seen).toHaveLength(2), DISK_ROUND_TRIP);
    expect(textOf(tracked.seen[1])).toContain('Page, renamed');
  });

  it('lands a pending edit when a turn flushes the open pages', async () => {
    const tracked = await renderTracking(10_000);
    appendParagraph(tracked.seen[0].editor, 'typed just before asking');
    await act(() => flushOpenPages());
    // Landed by the time the flush resolves, not ten seconds out.
    expect(fs().get(PAGE)).toContain('typed just before asking');
  });
});
