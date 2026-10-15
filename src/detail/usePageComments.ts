import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { askAgentInThread } from '@/agent/threadTurn';
import { CommentHighlights, type CommentThreadAnchor } from '@/editor/commentHighlights';
import type { CerebroEditor } from '@/editor/MarkdownEditor';
import type { AnchorResolution, CommentAnchor } from '@/engine/commentAnchor';
import { visibleThreads, type CommentsFile } from '@/engine/comments';
import { useCommentsSlot, useCommentsStore, type CommentsSlot } from '@/stores/commentsStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { commentSections, type CommentSections } from './commentSections';

/**
 * A page's comments, wired to its editor (M70.2b): M70.2's slot for the
 * threads, M70.1's CommentHighlights for where they sit.
 *
 * The open anchored threads go to the highlights whenever that set (by id and
 * anchor) or the editor changes, and at no other time: a re-send re-resolves
 * and redraws, and the M70.1 probe draws threads of its own. Resolutions are
 * null with no editor, so no thread reads as gone just because the page's
 * text is not open. A click on a highlight focuses its thread and opens the
 * panel on Comments.
 *
 * `submitDraft`, `startDiscussion` and `reply` are the only ways a comment is
 * posted, and each answers the new comment's id (null on failure, which the
 * store has already toasted, CV-03). No action here writes the page. Each
 * successful post asks the agent its text names with `@handle`, once
 * (M70.4, `askAgentInThread`); nothing else here asks anyone, so loading
 * threads or hearing they changed never starts a turn.
 */

export const REFUSALS = {
  empty: 'Select text to comment on.',
  spans_blocks: 'Select text inside one paragraph, heading, list item or table cell to comment.',
  outside_text: 'Comments anchor to text, not to code or embedded blocks.',
} as const;

export const MISSING_THREAD = 'That comment is no longer on this page.';

export interface PageCommentsController {
  /** The page, or null when the page takes no comments. */
  path: string | null;
  slot: CommentsSlot | null;
  /** The tab's sections, when the slot is ready. */
  sections: CommentSections | null;
  /** The thread in focus. */
  focused: string | null;
  /** The anchor a new comment is being written on. */
  draft: CommentAnchor | null;
  start(): void;
  cancelDraft(): void;
  submitDraft(body: string): Promise<string | null>;
  startDiscussion(body: string): Promise<string | null>;
  reply(thread: string, body: string): Promise<string | null>;
  setResolved(thread: string, resolved: boolean): Promise<boolean>;
  deleteComment(thread: string, comment: string): Promise<boolean>;
  deleteThread(thread: string): Promise<boolean>;
  focus(id: string): void;
}

const highlightsOf = (editor: CerebroEditor) => editor.getExtension(CommentHighlights) ?? null;
type Highlights = NonNullable<ReturnType<typeof highlightsOf>>;

/** The open threads that have somewhere to sit. */
function anchoredOpen(file: CommentsFile): CommentThreadAnchor[] {
  const out: CommentThreadAnchor[] = [];
  for (const { id, thread } of visibleThreads(file)) {
    if (thread.resolved === undefined && thread.anchor !== undefined) {
      out.push({ id, anchor: thread.anchor });
    }
  }
  return out;
}

const NO_SUBSCRIPTION = () => () => undefined;

export function usePageComments(
  path: string | null,
  editor: CerebroEditor | null,
  options: { openPanel: () => void; deepLink: string | null },
): PageCommentsController {
  const slot = useCommentsSlot(path);
  const toast = useUiStore((s) => s.toast);
  const openPanel = useRef(options.openPanel);
  openPanel.current = options.openPanel;

  const highlights = useMemo(() => (editor === null ? null : highlightsOf(editor)), [editor]);

  // Held with the path they belong to, so neither follows you to the next page.
  const [draftOf, setDraftOf] = useState<{ path: string; anchor: CommentAnchor } | null>(null);
  const [focusOf, setFocusOf] = useState<{ path: string; id: string } | null>(null);
  const draft = draftOf !== null && draftOf.path === path ? draftOf.anchor : null;
  const focused = focusOf !== null && focusOf.path === path ? focusOf.id : null;

  const resolutions = useSyncExternalStore<ReadonlyMap<string, AnchorResolution> | null>(
    highlights === null ? NO_SUBSCRIPTION : (listener) => highlights.store.subscribe(listener),
    () => highlights?.store.state.resolutions ?? null,
  );

  // Send the open anchored threads, only when they or the editor change. A
  // fresh editor draws nothing, so an empty set is not sent to one.
  const sent = useRef<{ to: Highlights | null; key: string }>({ to: null, key: '[]' });
  useEffect(() => {
    if (highlights === null || slot === null || slot.kind === 'loading') return;
    // An unreadable sidecar has no threads anyone can trust: draw none.
    const threads = slot.kind === 'ready' ? anchoredOpen(slot.file) : [];
    const key = JSON.stringify(threads);
    const previous = sent.current;
    if (previous.to === highlights && previous.key === key) return;
    sent.current = { to: highlights, key };
    if (previous.to !== highlights && threads.length === 0) return;
    highlights.setThreads(threads);
  }, [highlights, slot]);

  const focus = useCallback(
    (id: string) => {
      if (path === null) return;
      setFocusOf({ path, id });
      highlights?.setActive(id);
      highlights?.reveal(id);
    },
    [path, highlights],
  );

  // A new editor learns which thread is in focus.
  const focusedNow = useRef(focused);
  focusedNow.current = focused;
  useEffect(() => {
    if (highlights !== null && focusedNow.current !== null) {
      highlights.setActive(focusedNow.current);
    }
  }, [highlights]);

  // A click on a highlight focuses its thread, in the panel.
  useEffect(() => {
    if (highlights === null) return;
    const off = highlights.onSelect((id) => {
      focus(id);
      openPanel.current();
    });
    return () => {
      off();
    };
  }, [highlights, focus]);

  // The slot as it stood when this page opened. A ready slot kept from an
  // earlier visit is shown while the page re-reads, and it may predate the
  // thread a link names, so only an answer that landed since can say a
  // thread is missing.
  const openedWith = useRef<{ path: string | null; slot: CommentsSlot | null }>({
    path: null,
    slot: null,
  });
  if (openedWith.current.path !== path) openedWith.current = { path, slot };

  // A deep link: once per (page, thread), when the slot has loaded.
  const linked = useRef<string | null>(null);
  const deepLink = options.deepLink;
  useEffect(() => {
    if (path === null || deepLink === null) {
      linked.current = null;
      return;
    }
    const key = `${path}\n${deepLink}`;
    if (linked.current === key || slot === null || slot.kind === 'loading') return;
    const found = slot.kind === 'ready' && visibleThreads(slot.file).some((t) => t.id === deepLink);
    if (!found && slot === openedWith.current.slot) return;
    linked.current = key;
    openPanel.current();
    if (found) focus(deepLink);
    else if (slot.kind === 'ready') toast(MISSING_THREAD);
  }, [path, deepLink, slot, focus, toast]);

  const sections = useMemo(
    () => (slot?.kind === 'ready' ? commentSections(slot.file, resolutions) : null),
    [slot, resolutions],
  );

  const store = useCommentsStore.getState;

  const clearDraft = () => {
    setDraftOf(null);
    highlights?.setPending(null);
  };

  // A person's posted comment, and the agent it names, if any (M70.4).
  const ask = (thread: string, message: string, text: string) => {
    const { vaultPath, entries } = useVaultStore.getState();
    if (path === null || vaultPath === null) return;
    void askAgentInThread({ vault: vaultPath, page: path, thread, message, text, entries });
  };

  return {
    path,
    slot,
    sections,
    focused,
    draft,
    focus,
    start() {
      if (path === null || highlights === null) return;
      if (slot?.kind === 'unavailable') {
        toast(slot.reason);
        return;
      }
      const at = highlights.anchorSelection();
      if (!at.ok) {
        toast(REFUSALS[at.reason]);
        return;
      }
      setDraftOf({ path, anchor: at.anchor });
      highlights.setPending(at.anchor);
      openPanel.current();
    },
    cancelDraft: clearDraft,
    async submitDraft(body) {
      if (path === null || draft === null) return null;
      const id = await store().startThread(path, draft, body);
      if (id !== null) {
        clearDraft();
        focus(id);
        ask(id, id, body);
      }
      return id;
    },
    async startDiscussion(body) {
      if (path === null) return null;
      const id = await store().startThread(path, null, body);
      if (id !== null) {
        focus(id);
        ask(id, id, body);
      }
      return id;
    },
    async reply(thread, body) {
      if (path === null) return null;
      const id = await store().reply(path, thread, body);
      if (id !== null) ask(thread, id, body);
      return id;
    },
    setResolved: async (thread, resolved) =>
      path === null ? false : store().setResolved(path, thread, resolved),
    deleteComment: async (thread, comment) =>
      path === null ? false : store().deleteComment(path, thread, comment),
    deleteThread: async (thread) => (path === null ? false : store().deleteThread(path, thread)),
  };
}
