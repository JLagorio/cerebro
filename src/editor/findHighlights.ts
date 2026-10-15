import { createExtension } from '@blocknote/core';
import { Plugin, PluginKey, type Transaction } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import type { FindHit } from './findMatches';

/**
 * Find highlights (M59.6): the find bar's hits drawn over the page as
 * ProseMirror decorations, built the way comment highlights are
 * (commentHighlights.ts, M70.1). Nothing of a search enters the document, its
 * undo history or its saved bytes, and nothing is written onto ProseMirror's
 * own DOM, which it would wipe.
 *
 * Every dispatch is a transaction with no steps, carrying this plugin's meta
 * and `addToHistory: false`: it fires no onChange, schedules no save and adds
 * no undo entry. Between dispatches the set maps through each edit.
 */

export const findHighlightsKey = new PluginKey<DecorationSet>('cerebro-find');

/** What a hit is drawn with; the current one also carries `current`. */
export const FIND_CLASS = { hit: 'cb-find-hit', current: 'cb-find-current' } as const;

/** A ProseMirror node, named through the plugin state's doc. */
type PMNode = Parameters<typeof DecorationSet.create>[0];

/** The structural slice of a BlockNote editor these helpers dispatch through. */
interface Transacting {
  transact: (fn: (tr: Transaction) => void) => void;
}

/**
 * One decoration per hit: inline over a text hit, on the node for a link
 * hit (a chip is one atom). Each carries `data-find`, its 1-based index, so
 * the bar can scroll the current one into view.
 */
export function buildFindDecorations(
  doc: PMNode,
  hits: readonly FindHit[],
  current: number,
): DecorationSet {
  const decorations = hits.map((hit) => {
    const attrs = {
      class: hit.index === current ? `${FIND_CLASS.hit} ${FIND_CLASS.current}` : FIND_CLASS.hit,
      'data-find': String(hit.index),
    };
    return hit.inLink
      ? Decoration.node(hit.from, hit.to, attrs)
      : Decoration.inline(hit.from, hit.to, attrs);
  });
  return DecorationSet.create(doc, decorations);
}

const plugin = new Plugin<DecorationSet>({
  key: findHighlightsKey,
  state: {
    init: () => DecorationSet.empty,
    apply: (tr, set) => {
      const next = tr.getMeta(findHighlightsKey) as DecorationSet | undefined;
      if (next !== undefined) return next;
      return tr.docChanged ? set.map(tr.mapping, tr.doc) : set;
    },
  },
  props: {
    decorations: (state) => findHighlightsKey.getState(state),
  },
});

export const FindHighlights = createExtension(() => ({
  key: 'findHighlights',
  prosemirrorPlugins: [plugin],
}));

/** Draw `hits`, `current` marked, replacing whatever was drawn. */
export function showFindHits(editor: Transacting, hits: readonly FindHit[], current: number): void {
  editor.transact((tr) => {
    tr.setMeta(findHighlightsKey, buildFindDecorations(tr.doc, hits, current));
    tr.setMeta('addToHistory', false);
  });
}

/** Take every find highlight off the page. */
export function clearFindHits(editor: Transacting): void {
  editor.transact((tr) => {
    tr.setMeta(findHighlightsKey, DecorationSet.empty);
    tr.setMeta('addToHistory', false);
  });
}
