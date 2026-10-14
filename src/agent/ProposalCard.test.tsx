// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Spy mode: every ipc call still reaches the mock disk, so the cases on the
// real store write real files, and one of them can fail a single write.
vi.mock('@/lib/ipc', { spy: true });

import type { OrganizeProposal } from '@/agent/types';
import type { EditorReadyInfo } from '@/editor/MarkdownEditor';
import { NoteBodyEditor, type SaveState } from '@/editor/NoteBodyEditor';
import {
  __resetOpenPages,
  flushOpenPages,
  onExternalWrite,
  registerFlush,
} from '@/editor/openPages';
import * as ipc from '@/lib/ipc';
import { resetMockFs } from '@/lib/mockIpc';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore, type VaultState } from '@/stores/vaultStore';
import { makeEntry } from '@/test/factories';
import { ProposalCard } from './ProposalCard';

/**
 * The organize card applies the whole filing (M53.18): the frontmatter, then
 * the proposed title as the H1, and it closes only once both writes landed.
 * A write that did not land leaves the card up, and the store's toast is the
 * only message. The editor beside it lands its pending save before the writes
 * and hears them by path after, so it cannot write the old H1 back.
 */

// The real store actions, captured before any case stubs them.
const real = {
  patchFrontmatter: useVaultStore.getState().patchFrontmatter,
  setTitle: useVaultStore.getState().setTitle,
  rescan: useVaultStore.getState().rescan,
};

const PATH = 'inbox/capture.md';

const held = (path = PATH) => useUiStore.getState().proposals[path];

/** The card as the Inbox hosts it: mounted only while its proposal is held. */
function Host({ path }: { path: string }) {
  const proposal = useUiStore((s) => s.proposals[path]);
  return proposal === undefined ? null : <ProposalCard proposal={proposal} />;
}

/** Hold a proposal, mount its card, and hand back the Apply button. */
function propose(partial: Partial<OrganizeProposal> = {}): HTMLButtonElement {
  const proposal: OrganizeProposal = { path: PATH, reasoning: 'It names an action.', ...partial };
  useUiStore.getState().addProposal(proposal);
  render(<Host path={proposal.path} />);
  return screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement;
}

/** Store writes that answer as told and do nothing else, not even toast. */
function stubWrites(patched = true, titled = true) {
  const patchFrontmatter = vi.fn<VaultState['patchFrontmatter']>().mockResolvedValue(patched);
  const setTitle = vi.fn<VaultState['setTitle']>().mockResolvedValue(titled);
  const rescan = vi.fn<VaultState['rescan']>().mockResolvedValue(undefined);
  useVaultStore.setState({ patchFrontmatter, setTitle, rescan });
  return { patchFrontmatter, setTitle, rescan };
}

/** What a page showing `path` hears of the writes announced for it (M53.6). */
function hear(path = PATH): string[] {
  const heard: string[] = [];
  onExternalWrite(path, {
    pending: () => void heard.push('pending'),
    settled: () => void heard.push('settled'),
  });
  return heard;
}

beforeEach(() => {
  vi.clearAllMocks();
  useVaultStore.setState({
    ...real,
    vaultPath: '/vault',
    entries: [makeEntry({ path: PATH, title: 'Old title' })],
  });
  useUiStore.setState({ proposals: {}, toasts: [] });
});

afterEach(() => {
  cleanup();
  __resetOpenPages();
  vi.useRealTimers();
});

describe('ProposalCard (M53.18)', () => {
  it('Apply writes the frontmatter, then the title, and the proposal is gone', async () => {
    const { patchFrontmatter, setTitle } = stubWrites();
    const apply = propose({
      type: 'Work item',
      title: 'New title',
      properties: { status: 'todo' },
    });
    fireEvent.click(apply);
    await waitFor(() => expect(held()).toBeUndefined());
    expect(patchFrontmatter).toHaveBeenCalledTimes(1);
    expect(patchFrontmatter).toHaveBeenCalledWith(PATH, { status: 'todo', type: 'Work item' });
    expect(setTitle).toHaveBeenCalledTimes(1);
    expect(setTitle).toHaveBeenCalledWith(PATH, 'New title');
    expect(patchFrontmatter.mock.invocationCallOrder[0]).toBeLessThan(
      setTitle.mock.invocationCallOrder[0],
    );
    expect(screen.queryByTestId('proposal-card')).toBeNull();
  });

  it('lands the open pages’ pending saves before it writes anything', async () => {
    const { patchFrontmatter, setTitle } = stubWrites();
    let land = () => {};
    const flush = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          land = resolve;
        }),
    );
    registerFlush(flush);
    fireEvent.click(propose({ type: 'Work item', title: 'New title' }));
    await waitFor(() => expect(flush).toHaveBeenCalledTimes(1));
    // Nothing is written under a save still landing.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(patchFrontmatter).not.toHaveBeenCalled();
    land();
    await waitFor(() => expect(held()).toBeUndefined());
    expect(patchFrontmatter).toHaveBeenCalledTimes(1);
    expect(setTitle).toHaveBeenCalledTimes(1);
  });

  it('announces a landed rename on the capture’s path, caught up by the store’s rescan', async () => {
    const { setTitle, rescan } = stubWrites();
    const heard = hear();
    setTitle.mockImplementation(async () => {
      heard.push('renamed');
      return true;
    });
    fireEvent.click(propose({ type: 'Work item', title: 'New title' }));
    await waitFor(() => expect(heard).toEqual(['renamed', 'pending', 'settled']));
    // The catch-up is the store's rescan, run once, after the H1 is on disk.
    expect(rescan).toHaveBeenCalledTimes(1);
    expect(setTitle.mock.invocationCallOrder[0]).toBeLessThan(rescan.mock.invocationCallOrder[0]);
    expect(held()).toBeUndefined();
  });

  it('catches the vault up after a frontmatter-only filing, and names no page', async () => {
    const { patchFrontmatter, setTitle, rescan } = stubWrites();
    const heard = hear();
    fireEvent.click(propose({ type: 'Work item' }));
    await waitFor(() => expect(rescan).toHaveBeenCalledTimes(1));
    expect(patchFrontmatter.mock.invocationCallOrder[0]).toBeLessThan(
      rescan.mock.invocationCallOrder[0],
    );
    expect(setTitle).not.toHaveBeenCalled();
    // The body did not change, and a page's save keeps the frontmatter from
    // disk, so the page showing the capture has nothing to reload.
    expect(heard).toEqual([]);
    expect(held()).toBeUndefined();
  });

  it('a refused frontmatter write keeps the card, skips the title, and adds no toast', async () => {
    const { patchFrontmatter, setTitle, rescan } = stubWrites(false);
    const heard = hear();
    const apply = propose({ type: 'Work item', title: 'New title' });
    fireEvent.click(apply);
    expect(apply.disabled).toBe(true);
    // Settled, and open to a retry.
    await waitFor(() => expect(apply.disabled).toBe(false));
    expect(patchFrontmatter).toHaveBeenCalledTimes(1);
    expect(setTitle).not.toHaveBeenCalled();
    expect(held()).toBeDefined();
    expect(screen.getByTestId('proposal-card')).toBeTruthy();
    // The store toasts its own refusals and this stub made none, so a toast
    // here could only be the card's.
    expect(useUiStore.getState().toasts).toEqual([]);
    // Nothing landed, so nothing is announced.
    expect(heard).toEqual([]);
    expect(rescan).not.toHaveBeenCalled();
  });

  it('a failed rename keeps the card, with no toast of its own', async () => {
    const { setTitle, rescan } = stubWrites(true, false);
    const heard = hear();
    const apply = propose({ type: 'Work item', title: 'New title' });
    fireEvent.click(apply);
    await waitFor(() => expect(apply.disabled).toBe(false));
    expect(setTitle).toHaveBeenCalledTimes(1);
    expect(held()).toBeDefined();
    expect(useUiStore.getState().toasts).toEqual([]);
    // The store's failed rename rescans by itself; the card announces nothing.
    expect(heard).toEqual([]);
    expect(rescan).not.toHaveBeenCalled();
  });

  it('a title the capture already has is not written, and the card closes', async () => {
    const { patchFrontmatter, setTitle } = stubWrites();
    const heard = hear();
    // The same title once its whitespace is folded the way the card shows it.
    const apply = propose({ type: 'Work item', title: '  Old \n title ' });
    fireEvent.click(apply);
    await waitFor(() => expect(held()).toBeUndefined());
    expect(patchFrontmatter).toHaveBeenCalledTimes(1);
    expect(setTitle).not.toHaveBeenCalled();
    expect(heard).toEqual([]);
  });

  it.each([undefined, '', '   ', '\n\t'])(
    'a blank title (%j) is neither listed nor written, and the card closes',
    async (title) => {
      const { patchFrontmatter, setTitle } = stubWrites();
      const apply = propose({ type: 'Work item', title });
      expect(screen.queryByText('Title')).toBeNull();
      fireEvent.click(apply);
      await waitFor(() => expect(held()).toBeUndefined());
      expect(patchFrontmatter).toHaveBeenCalledTimes(1);
      expect(setTitle).not.toHaveBeenCalled();
    },
  );

  it('a title that is not a string is skipped rather than crashing the card', async () => {
    const { patchFrontmatter, setTitle } = stubWrites();
    // The title arrives as the agent's JSON, whatever the declared type says.
    const apply = propose({ type: 'Work item', title: 42 as unknown as string });
    expect(screen.queryByText('Title')).toBeNull();
    fireEvent.click(apply);
    await waitFor(() => expect(held()).toBeUndefined());
    expect(patchFrontmatter).toHaveBeenCalledTimes(1);
    expect(setTitle).not.toHaveBeenCalled();
  });

  it('a title-only proposal makes no frontmatter write', async () => {
    const { patchFrontmatter, setTitle } = stubWrites();
    const heard = hear();
    const apply = propose({ title: 'New title' });
    fireEvent.click(apply);
    await waitFor(() => expect(held()).toBeUndefined());
    expect(patchFrontmatter).not.toHaveBeenCalled();
    expect(setTitle).toHaveBeenCalledWith(PATH, 'New title');
    await waitFor(() => expect(heard).toEqual(['pending', 'settled']));
  });

  it('writes a multi-line title as the one line the card shows', async () => {
    const { setTitle } = stubWrites();
    const apply = propose({ title: 'Rehearse the rollback\n\n## Injected section' });
    expect(screen.getByText('Rehearse the rollback ## Injected section')).toBeTruthy();
    fireEvent.click(apply);
    await waitFor(() => expect(held()).toBeUndefined());
    expect(setTitle).toHaveBeenCalledWith(PATH, 'Rehearse the rollback ## Injected section');
  });

  it('holds Apply while a write is in flight, so a second click writes nothing more', async () => {
    const { setTitle } = stubWrites();
    let finish: ((landed: boolean) => void) | undefined;
    const patchFrontmatter = vi.fn<VaultState['patchFrontmatter']>(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    useVaultStore.setState({ patchFrontmatter });
    const apply = propose({ type: 'Work item', title: 'New title' });
    fireEvent.click(apply);
    expect(apply.disabled).toBe(true);
    // Once while the open pages flush, and once while the patch is in flight.
    fireEvent.click(apply);
    await waitFor(() => expect(patchFrontmatter).toHaveBeenCalledTimes(1));
    fireEvent.click(apply);
    finish?.(true);
    await waitFor(() => expect(held()).toBeUndefined());
    expect(patchFrontmatter).toHaveBeenCalledTimes(1);
    expect(setTitle).toHaveBeenCalledTimes(1);
  });
});

describe('ProposalCard on the real store over the mock disk (M53.18)', () => {
  const CAPTURE = 'inbox/warehouse-cutover-thought.md';
  const OLD_H1 = '# Warehouse cutover needs a rollback rehearsal';
  const NEW_TITLE = 'Rehearse the warehouse rollback';
  const FILING: OrganizeProposal = {
    path: CAPTURE,
    type: 'Work item',
    title: NEW_TITLE,
    properties: { status: 'todo', priority: 'high' },
    reasoning: 'It names an action and an owner.',
  };
  const disk = () =>
    (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;

  beforeEach(async () => {
    resetMockFs();
    await useVaultStore.getState().openVault('/demo-vault');
  });

  it('Apply writes the type and the new H1, and the old H1 is gone', async () => {
    expect(disk().get(CAPTURE)).toContain(OLD_H1);
    fireEvent.click(propose(FILING));
    await waitFor(() => expect(held(CAPTURE)).toBeUndefined());
    const raw = disk().get(CAPTURE) ?? '';
    expect(raw).toContain('type: Work item');
    expect(raw).toContain(`# ${NEW_TITLE}`);
    expect(raw).not.toContain(OLD_H1);
    expect(useVaultStore.getState().entries.find((e) => e.path === CAPTURE)?.title).toBe(NEW_TITLE);
    expect(useUiStore.getState().toasts).toEqual([]);
  });

  it('a failed rename keeps the card with the store toast alone, and a retry lands', async () => {
    vi.mocked(ipc.setNoteTitle).mockRejectedValueOnce(new Error('disk full'));
    const apply = propose(FILING);
    fireEvent.click(apply);
    await waitFor(() => expect(ipc.setNoteTitle).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(apply.disabled).toBe(false));
    expect(held(CAPTURE)).toBeDefined();
    expect(useUiStore.getState().toasts.map((t) => t.message)).toEqual(["Couldn't rename record"]);
    // A partial apply: the frontmatter landed and the H1 did not.
    expect(disk().get(CAPTURE)).toContain('type: Work item');
    expect(disk().get(CAPTURE)).toContain(OLD_H1);

    // The retry writes the same frontmatter again, then the H1.
    fireEvent.click(apply);
    await waitFor(() => expect(held(CAPTURE)).toBeUndefined());
    const raw = disk().get(CAPTURE) ?? '';
    expect(raw).toContain(`# ${NEW_TITLE}`);
    expect(raw).not.toContain(OLD_H1);
    expect(useUiStore.getState().toasts).toHaveLength(1);
  });

  /**
   * The capture is open in the editor beside the card (InboxPage). Rust stamps
   * modifiedAt to the second, so the editor cannot learn of a write in the
   * same second as its own last save from the stamp. Holding the clock still
   * puts every write here in one second, as the mock otherwise stamps in
   * milliseconds.
   */
  it('the editor beside the card lands its edit first, then reloads to the new H1', async () => {
    // Waits on a debounce, a mock-disk write, a scan of the mock disk and a
    // lazy editor mount; `waitFor`'s 1s default has no margin for that.
    const DISK_ROUND_TRIP = { timeout: 5_000 };
    const SECOND = '2026-10-13T09:00:00.000Z';
    const stamp = () =>
      useVaultStore.getState().entries.find((e) => e.path === CAPTURE)?.modifiedAt;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(SECOND));
    // Every mount, newest last: a reload is a remount.
    const seen: EditorReadyInfo[] = [];
    const states: SaveState[] = [];
    // A debounce long enough that only a flush lands an edit.
    const { container } = render(
      <NoteBodyEditor
        path={CAPTURE}
        debounceMs={10_000}
        onReady={(info) => void seen.push(info)}
        onSaveState={(state) => void states.push(state)}
      />,
    );
    /** Mount `n`, once its view is up: it hears edits a render after onReady. */
    const mounted = async (n: number): Promise<EditorReadyInfo> => {
      await waitFor(() => expect(seen).toHaveLength(n), DISK_ROUND_TRIP);
      await waitFor(() => expect(container.querySelector('[contenteditable="true"]')).toBeTruthy());
      await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
      return seen[n - 1];
    };
    /** An edit, still on its debounce. */
    const edit = (info: EditorReadyInfo, text: string) => {
      const last = info.editor.document[info.editor.document.length - 1];
      info.editor.insertBlocks([{ type: 'paragraph', content: text }], last, 'after');
      expect(states.at(-1)).toBe('dirty');
    };

    // An autosave lands in this second, and the editor takes its stamp...
    edit(await mounted(1), 'saved a moment ago');
    await act(() => flushOpenPages());
    await waitFor(() => expect(stamp()).toBe(SECOND));
    await act(() => new Promise((resolve) => setTimeout(resolve, 120)));
    expect(seen).toHaveLength(1);
    // ...and the next edit is still on its debounce when Apply is clicked.
    edit(seen[0], 'typed just before Apply');
    fireEvent.click(propose(FILING));
    await waitFor(() => expect(held(CAPTURE)).toBeUndefined(), DISK_ROUND_TRIP);

    // Reloaded by the announcement, since the stamp never moved.
    const reloaded = await mounted(2);
    expect(stamp()).toBe(SECOND);
    const body = JSON.stringify(reloaded.editor.document);
    expect(body).toContain(NEW_TITLE);
    expect(body).toContain('typed just before Apply');
    expect(screen.queryByTestId('external-change-banner')).toBeNull();

    // The editor's next save carries the new H1 rather than the old one back.
    edit(reloaded, 'and after');
    await act(() => flushOpenPages());
    const raw = disk().get(CAPTURE) ?? '';
    expect(raw).toContain('type: Work item');
    expect(raw).toContain(`# ${NEW_TITLE}`);
    expect(raw).not.toContain(OLD_H1);
    for (const line of ['saved a moment ago', 'typed just before Apply', 'and after']) {
      expect(raw).toContain(line);
    }
  });
});
