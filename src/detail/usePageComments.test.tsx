// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor, type RenderHookResult } from '@testing-library/react';
import { createStore } from '@blocknote/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SelectionAnchor } from '@/editor/commentHighlights';
import type { CerebroEditor } from '@/editor/MarkdownEditor';
import type { AnchorResolution, CommentAnchor } from '@/engine/commentAnchor';
import { serializeComments, sidecarPathOf, type CommentsFile } from '@/engine/comments';
import { resetMockFs } from '@/lib/mockIpc';
import { useCommentsStore } from '@/stores/commentsStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { MISSING_THREAD, REFUSALS, usePageComments } from './usePageComments';

/**
 * usePageComments against the mock backend and a fake CommentHighlights: the
 * fake records what the hook sends and lets a test play the editor's part
 * (a selection, a click on a highlight, a resolve).
 */

const PAGE = 'records/decisions/dec-offline-window-72h.md';
const fs = () => (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;

const anchor = (quote: string): CommentAnchor => ({ quote, occurrence: 1, before: '', after: '' });
const OPEN = '00000000000000a1';
const RESOLVED = '00000000000000a2';
const PAGE_WIDE = '00000000000000a3';
const DELETED = '00000000000000a4';
const stamp = { at: '2026-10-13T10:00:00Z', by: 'human:owner' };
const comment = (id: string) => ({
  id,
  author: 'human:owner',
  created: '2026-10-13T09:00:00Z',
  body: `body ${id}`,
});
const SEEDED: CommentsFile = {
  format: 1,
  threads: [
    { anchor: anchor('Guarantee 72 hours.'), comments: [comment(OPEN)] },
    { anchor: anchor('warns'), resolved: stamp, comments: [comment(RESOLVED)] },
    { comments: [comment(PAGE_WIDE)] },
    { anchor: anchor('human'), deleted: stamp, comments: [comment(DELETED)] },
  ],
};

function fakeHighlights(selection: SelectionAnchor = { ok: false, reason: 'empty' }) {
  const listeners = new Set<(id: string) => void>();
  return {
    store: createStore({ resolutions: new Map<string, AnchorResolution>() }),
    setThreads: vi.fn(),
    setActive: vi.fn(),
    setPending: vi.fn(),
    reveal: vi.fn(() => true),
    anchorSelection: vi.fn(() => selection),
    onSelect(cb: (id: string) => void) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    click(id: string) {
      for (const cb of listeners) cb(id);
    },
  };
}
type Fake = ReturnType<typeof fakeHighlights>;
const editorWith = (fake: Fake) => ({ getExtension: () => fake }) as unknown as CerebroEditor;

const toasts = () => useUiStore.getState().toasts.map((t) => t.message);

/** Render the hook, letting its first read land inside act. */
async function mount(
  editor: CerebroEditor | null,
  props: { deepLink?: string | null; path?: string | null } = {},
) {
  const openPanel = vi.fn();
  let hook!: RenderHookResult<
    ReturnType<typeof usePageComments>,
    { editor: CerebroEditor | null; deepLink: string | null; path: string | null }
  >;
  await act(async () => {
    hook = renderHook(
      ({ editor: e, deepLink, path }) => usePageComments(path, e, { openPanel, deepLink }),
      {
        initialProps: {
          editor,
          deepLink: props.deepLink ?? null,
          path: props.path === undefined ? PAGE : props.path,
        },
      },
    );
    await new Promise((done) => setTimeout(done, 0));
  });
  return { ...hook, openPanel };
}

const ready = async (result: { current: { slot: unknown } }) =>
  waitFor(() => expect(result.current.slot).toMatchObject({ kind: 'ready' }));

beforeEach(async () => {
  resetMockFs();
  await useVaultStore.getState().openVault('/demo-vault');
  useCommentsStore.getState().clear();
  useUiStore.setState({ toasts: [] });
});
afterEach(cleanup);

describe('usePageComments', () => {
  it('toasts a refused selection and opens nothing', async () => {
    for (const reason of ['spans_blocks', 'outside_text'] as const) {
      useUiStore.setState({ toasts: [] });
      const fake = fakeHighlights({ ok: false, reason });
      const { result, openPanel, unmount } = await mount(editorWith(fake));
      await ready(result);
      act(() => result.current.start());
      expect(toasts()).toEqual([REFUSALS[reason]]);
      expect(openPanel).not.toHaveBeenCalled();
      expect(fake.setPending).not.toHaveBeenCalled();
      expect(result.current.draft).toBeNull();
      unmount();
    }
    expect(REFUSALS.spans_blocks).toBe(
      'Select text inside one paragraph, heading, list item or table cell to comment.',
    );
    expect(REFUSALS.outside_text).toBe('Comments anchor to text, not to code or embedded blocks.');
  });

  it('starts a draft: pending drawn, panel opened', async () => {
    const quote = anchor('Guarantee 72 hours.');
    const fake = fakeHighlights({ ok: true, anchor: quote, start: 0, end: 19 });
    const { result, openPanel } = await mount(editorWith(fake));
    await ready(result);
    act(() => result.current.start());
    expect(result.current.draft).toEqual(quote);
    expect(fake.setPending).toHaveBeenCalledWith(quote);
    expect(openPanel).toHaveBeenCalledTimes(1);
    act(() => result.current.cancelDraft());
    expect(result.current.draft).toBeNull();
    expect(fake.setPending).toHaveBeenLastCalledWith(null);
  });

  it('a posted draft clears and focuses the new thread, and the page is untouched', async () => {
    const quote = anchor('Guarantee 72 hours.');
    const fake = fakeHighlights({ ok: true, anchor: quote, start: 0, end: 19 });
    const before = fs().get(PAGE);
    const { result } = await mount(editorWith(fake));
    await ready(result);
    act(() => result.current.start());
    let id: string | null = null;
    await act(async () => {
      id = await result.current.submitDraft('Is 72 enough for rural crews?');
    });
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(result.current.draft).toBeNull();
    expect(result.current.focused).toBe(id);
    expect(fake.setPending).toHaveBeenLastCalledWith(null);
    expect(fake.setActive).toHaveBeenLastCalledWith(id);
    expect(fs().get(sidecarPathOf(PAGE))).toContain('Is 72 enough for rural crews?');
    expect(fs().get(PAGE)).toBe(before);
    // The new thread is drawn.
    await waitFor(() => expect(fake.setThreads).toHaveBeenLastCalledWith([{ id, anchor: quote }]));
  });

  it('a failed post keeps the draft', async () => {
    const quote = anchor('Guarantee 72 hours.');
    const fake = fakeHighlights({ ok: true, anchor: quote, start: 0, end: 19 });
    const { result } = await mount(editorWith(fake));
    await ready(result);
    act(() => result.current.start());
    fs().set(sidecarPathOf(PAGE), '<<<<<<< HEAD\n{}\n=======\n{}\n>>>>>>> theirs\n');
    let id: string | null = 'unset';
    await act(async () => {
      id = await result.current.submitDraft('Lost?');
    });
    expect(id).toBeNull();
    expect(result.current.draft).toEqual(quote);
    expect(fake.setPending).not.toHaveBeenCalledWith(null);
    expect(toasts().some((t) => t.startsWith("Couldn't comment"))).toBe(true);
  });

  it('sends only open anchored threads, and never resends an unchanged set', async () => {
    fs().set(sidecarPathOf(PAGE), serializeComments(SEEDED));
    const fake = fakeHighlights();
    const { result } = await mount(editorWith(fake));
    await ready(result);
    await waitFor(() => expect(fake.setThreads).toHaveBeenCalledTimes(1));
    expect(fake.setThreads).toHaveBeenCalledWith([
      { id: OPEN, anchor: anchor('Guarantee 72 hours.') },
    ]);
    // A re-read answers an equal file, as a new object: nothing is resent.
    await act(async () => {
      await useCommentsStore.getState().load(PAGE);
    });
    expect(fake.setThreads).toHaveBeenCalledTimes(1);
    // A page-wide thread is not drawn, so starting one resends nothing.
    await act(async () => {
      await result.current.startDiscussion('About the whole page.');
    });
    expect(fake.setThreads).toHaveBeenCalledTimes(1);
  });

  it('resends the set to a new editor', async () => {
    fs().set(sidecarPathOf(PAGE), serializeComments(SEEDED));
    const first = fakeHighlights();
    const { result, rerender } = await mount(editorWith(first));
    await ready(result);
    await waitFor(() => expect(first.setThreads).toHaveBeenCalledTimes(1));
    const second = fakeHighlights();
    rerender({ editor: editorWith(second), deepLink: null, path: PAGE });
    expect(second.setThreads).toHaveBeenCalledWith([
      { id: OPEN, anchor: anchor('Guarantee 72 hours.') },
    ]);
    expect(first.setThreads).toHaveBeenCalledTimes(1);
  });

  it('reads resolutions as null with no editor, so a quoted thread is unplaced, not gone', async () => {
    fs().set(sidecarPathOf(PAGE), serializeComments(SEEDED));
    const { result } = await mount(null);
    await ready(result);
    expect(result.current.sections?.unplaced.map((t) => t.id)).toEqual([OPEN]);
    expect(result.current.sections?.discussion.map((t) => t.id)).toEqual([PAGE_WIDE]);
    expect(result.current.sections?.openCount).toBe(2);
  });

  it("reads the editor's resolutions as they change", async () => {
    fs().set(sidecarPathOf(PAGE), serializeComments(SEEDED));
    const fake = fakeHighlights();
    const { result } = await mount(editorWith(fake));
    await ready(result);
    act(() =>
      fake.store.setState(() => ({
        resolutions: new Map<string, AnchorResolution>([
          [OPEN, { kind: 'detached', reason: 'gone', count: 0 }],
        ]),
      })),
    );
    expect(result.current.sections?.discussion.map((t) => [t.id, t.note])).toEqual([
      [OPEN, { reason: 'gone' }],
      [PAGE_WIDE, null],
    ]);
  });

  it('a click on a highlight focuses its thread and opens the panel', async () => {
    fs().set(sidecarPathOf(PAGE), serializeComments(SEEDED));
    const fake = fakeHighlights();
    const { result, openPanel } = await mount(editorWith(fake));
    await ready(result);
    act(() => fake.click(OPEN));
    expect(result.current.focused).toBe(OPEN);
    expect(fake.setActive).toHaveBeenLastCalledWith(OPEN);
    expect(fake.reveal).toHaveBeenLastCalledWith(OPEN);
    expect(openPanel).toHaveBeenCalledTimes(1);
  });

  it('a deep link opens the panel and focuses its thread once the slot loads', async () => {
    fs().set(sidecarPathOf(PAGE), serializeComments(SEEDED));
    const fake = fakeHighlights();
    const { result, openPanel, rerender } = await mount(editorWith(fake), { deepLink: RESOLVED });
    await ready(result);
    await waitFor(() => expect(result.current.focused).toBe(RESOLVED));
    expect(openPanel).toHaveBeenCalledTimes(1);
    rerender({ editor: editorWith(fake), deepLink: RESOLVED, path: PAGE });
    expect(openPanel).toHaveBeenCalledTimes(1);
  });

  it('a deep link waits for the re-read before it calls a thread missing', async () => {
    // A slot kept from an earlier visit, from before the thread existed.
    await act(async () => {
      await useCommentsStore.getState().load(PAGE);
    });
    fs().set(sidecarPathOf(PAGE), serializeComments(SEEDED));
    const fake = fakeHighlights();
    const { result } = await mount(editorWith(fake), { deepLink: OPEN });
    await waitFor(() => expect(result.current.focused).toBe(OPEN));
    expect(toasts()).toEqual([]);
  });

  it('a deep link to a thread that is gone toasts once', async () => {
    fs().set(sidecarPathOf(PAGE), serializeComments(SEEDED));
    const fake = fakeHighlights();
    const { result, rerender } = await mount(editorWith(fake), { deepLink: DELETED });
    await ready(result);
    await waitFor(() => expect(toasts()).toEqual([MISSING_THREAD]));
    rerender({ editor: editorWith(fake), deepLink: DELETED, path: PAGE });
    await act(async () => {
      await useCommentsStore.getState().load(PAGE);
    });
    expect(toasts()).toEqual([MISSING_THREAD]);
    expect(result.current.focused).toBeNull();
    expect(MISSING_THREAD).toBe('That comment is no longer on this page.');
  });

  it('an unreadable sidecar refuses a comment in its own words and draws nothing', async () => {
    fs().set(sidecarPathOf(PAGE), '<<<<<<< HEAD\n{}\n=======\n{}\n>>>>>>> theirs\n');
    const fake = fakeHighlights({ ok: true, anchor: anchor('x'), start: 0, end: 1 });
    const { result, openPanel } = await mount(editorWith(fake));
    await waitFor(() => expect(result.current.slot).toMatchObject({ kind: 'unavailable' }));
    act(() => result.current.start());
    expect(toasts()[0]).toMatch(/merge conflict markers/);
    expect(openPanel).not.toHaveBeenCalled();
    expect(fake.setThreads).not.toHaveBeenCalled();
  });
});
