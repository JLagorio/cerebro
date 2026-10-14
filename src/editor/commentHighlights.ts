import { createExtension, createStore } from '@blocknote/core';
import { Plugin, PluginKey, type EditorState, type Transaction } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import {
  anchorAt,
  resolveAnchor,
  type AnchorResolution,
  type AnchorResult,
  type CommentAnchor,
} from '@/engine/commentAnchor';
import { readerText } from './readerText';

/**
 * Comment highlights (M70.1): threads drawn over the page as ProseMirror
 * decorations, never as marks, so nothing of a comment enters the document,
 * its undo history or its saved bytes.
 *
 * BlockNote's own comments extension keeps threads in the document as marks:
 * creating one adds an undo step, resolving one is a doc change that saves,
 * and the mark rides the clipboard (commentSpike.test.ts measures each). Here
 * every dispatch is a transaction with no steps and only this plugin's meta,
 * which fires no onChange, schedules no save and adds no history entry.
 *
 * Anchors are quotes on the page's reader text (readerText.ts), resolved
 * again 200 ms after the page stops changing (RESOLVE_DELAY_MS). Between
 * resolves the decorations map through each edit like any decoration.
 */

/** How long after the last doc change the anchors resolve again. */
export const RESOLVE_DELAY_MS = 200;

export const commentHighlightsKey = new PluginKey<DecorationSet>('cerebroCommentHighlights');

export interface CommentThreadAnchor {
  id: string;
  anchor: CommentAnchor;
}

/** A selection as an anchor, or why it cannot be one. */
export type SelectionAnchor = AnchorResult | { ok: false; reason: 'outside_text' };

interface Spec {
  thread: string | null;
}

const CLASS = {
  base: 'cb-comment',
  active: 'cb-comment cb-comment-active',
  pending: 'cb-comment-pending',
} as const;

/** The browser-mode probe the e2e drives (M70.1), typed in e2e/boot.ts. */
export interface CommentProbe {
  anchor: () => SelectionAnchor;
  show: (threads: CommentThreadAnchor[]) => void;
  resolutions: () => Record<string, AnchorResolution>;
}

const inBrowserMode = (): boolean =>
  typeof window !== 'undefined' && !('__TAURI_INTERNALS__' in window);

export const CommentHighlights = createExtension(({ editor }) => {
  let threads: CommentThreadAnchor[] = [];
  let active: string | null = null;
  let pending: CommentAnchor | null = null;
  const listeners = new Set<(id: string) => void>();
  /** Resolutions by thread id. An id not in the map is unknown, never detached. */
  const store = createStore({ resolutions: new Map<string, AnchorResolution>() });

  const decorate = (from: number, to: number, thread: string | null): Decoration =>
    thread === null
      ? Decoration.inline(from, to, { class: CLASS.pending }, { thread } satisfies Spec)
      : Decoration.inline(
          from,
          to,
          { class: thread === active ? CLASS.active : CLASS.base, 'data-thread': thread },
          { thread } satisfies Spec,
        );

  /** Hand the plugin `set` in a transaction with no steps. */
  const show = (build: (tr: Transaction) => DecorationSet) => {
    editor.transact((tr) => {
      tr.setMeta(commentHighlightsKey, build(tr));
    });
  };

  /** Resolve every anchor against the page as it is now, and redraw. */
  const resolveNow = () => {
    const resolutions = new Map<string, AnchorResolution>();
    show((tr) => {
      const text = readerText(tr.doc);
      const decorations: Decoration[] = [];
      for (const { id, anchor } of threads) {
        const at = resolveAnchor(text.spans, anchor);
        resolutions.set(id, at);
        if (at.kind === 'attached') {
          decorations.push(decorate(text.posAt(at.start, 'start'), text.posAt(at.end, 'end'), id));
        }
      }
      if (pending !== null) {
        const at = resolveAnchor(text.spans, pending);
        if (at.kind === 'attached') {
          decorations.push(
            decorate(text.posAt(at.start, 'start'), text.posAt(at.end, 'end'), null),
          );
        }
      }
      return DecorationSet.create(tr.doc, decorations);
    });
    // After the transaction: a subscriber may read the editor's state, which
    // BlockNote refuses inside one.
    store.setState(() => ({ resolutions }));
  };

  /** The current decorations, restyled for the active thread. */
  const restyle = () => {
    // Read before the transaction: BlockNote refuses a state read inside one,
    // and a meta-only transaction moves nothing the set would need mapped.
    const set = commentHighlightsKey.getState(editor.prosemirrorState) ?? DecorationSet.empty;
    show((tr) => {
      return DecorationSet.create(
        tr.doc,
        set.find().map((d) => decorate(d.from, d.to, (d.spec as Spec).thread)),
      );
    });
  };

  /** The thread a position sits in: the narrowest when several hold it. */
  const threadAt = (state: EditorState, pos: number): string | null => {
    const set = commentHighlightsKey.getState(state) ?? DecorationSet.empty;
    let best: Decoration | null = null;
    for (const d of set.find(pos, pos)) {
      if ((d.spec as Spec).thread === null || pos < d.from || pos > d.to) continue;
      if (best === null || d.to - d.from < best.to - best.from) best = d;
    }
    return best === null ? null : (best.spec as Spec).thread;
  };

  const anchorSelection = (): SelectionAnchor => {
    const state = editor.prosemirrorState;
    const text = readerText(state.doc);
    const range = text.offsetsOf(state.selection.from, state.selection.to);
    if (!range.ok) return range;
    return anchorAt(text.spans, range.start, range.end);
  };

  const plugin = new Plugin<DecorationSet>({
    key: commentHighlightsKey,
    state: {
      init: () => DecorationSet.empty,
      apply: (tr, set) => {
        const next = tr.getMeta(commentHighlightsKey) as DecorationSet | undefined;
        if (next !== undefined) return next;
        return tr.docChanged ? set.map(tr.mapping, tr.doc) : set;
      },
    },
    props: {
      decorations: (state) => commentHighlightsKey.getState(state),
      handleClick: (view, pos) => {
        const id = threadAt(view.state, pos);
        if (id !== null) for (const listener of listeners) listener(id);
        return false;
      },
    },
    view: () => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const run = (view: { composing: boolean }) => {
        timer = null;
        if (view.composing) {
          timer = setTimeout(() => run(view), RESOLVE_DELAY_MS);
          return;
        }
        resolveNow();
      };
      return {
        update: (view, prev) => {
          // Identity, not `eq`: a doc is a new object exactly when it changed,
          // and a deep compare would walk the page on every transaction.
          if (view.state.doc === prev.doc) return;
          if (threads.length === 0 && pending === null) return;
          if (timer !== null) clearTimeout(timer);
          timer = setTimeout(() => run(view), RESOLVE_DELAY_MS);
        },
        destroy: () => {
          if (timer !== null) clearTimeout(timer);
          timer = null;
        },
      };
    },
  });

  const api = {
    /** Draw `next` (replacing every thread drawn before) and resolve them. */
    setThreads(next: readonly CommentThreadAnchor[]) {
      threads = [...next];
      resolveNow();
    },
    /** Mark one thread active, or none. */
    setActive(id: string | null) {
      if (id === active) return;
      active = id;
      restyle();
    },
    /** Draw the anchor a comment is being written on, or clear it. */
    setPending(anchor: CommentAnchor | null) {
      pending = anchor;
      resolveNow();
    },
    /** The current selection as an anchor. */
    anchorSelection,
    /** Scroll a thread's text into view; false when it is not drawn. */
    reveal(id: string): boolean {
      const view = editor.prosemirrorView;
      const set = commentHighlightsKey.getState(editor.prosemirrorState);
      const d = set?.find().find((x) => (x.spec as Spec).thread === id);
      if (view === undefined || d === undefined) return false;
      const { node } = view.domAtPos(d.from);
      const el = node instanceof Element ? node : node.parentElement;
      el?.scrollIntoView({ block: 'center' });
      return true;
    },
    /** Call `cb` with the thread a click lands in; returns the unsubscribe. */
    onSelect(cb: (id: string) => void): () => void {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    resolveNow,
  };

  return {
    key: 'cerebroCommentHighlights',
    store,
    prosemirrorPlugins: [plugin],
    mount: ({ signal }: { signal: AbortSignal }) => {
      if (!inBrowserMode()) return;
      const probe: CommentProbe = {
        anchor: anchorSelection,
        show: (next) => api.setThreads(next),
        resolutions: () => Object.fromEntries(store.state.resolutions),
      };
      const seam = window as { __cerebroCommentProbe?: CommentProbe };
      seam.__cerebroCommentProbe = probe;
      signal.addEventListener('abort', () => {
        if (seam.__cerebroCommentProbe === probe) delete seam.__cerebroCommentProbe;
      });
    },
    ...api,
  } as const;
});
