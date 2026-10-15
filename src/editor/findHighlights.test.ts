// @vitest-environment jsdom
import { BlockNoteEditor } from '@blocknote/core';
import { undoDepth } from 'prosemirror-history';
import type { EditorView } from 'prosemirror-view';
import { afterEach, describe, expect, it } from 'vitest';
import type { Entry } from '@/engine/types';
import { wikilinkLabel } from './chipLabels';
import {
  buildFindDecorations,
  clearFindHits,
  FindHighlights,
  findHighlightsKey,
  showFindHits,
} from './findHighlights';
import { findHits, type LabelOf } from './findMatches';
import { blocksToMarkdownNow, markdownToBlocksNow } from './markdown';
import { cerebroSchema, type CerebroEditor } from './MarkdownEditor';

/**
 * Find highlights (M59.6) on a mounted editor with the app's schema: one
 * decoration per hit, and drawing them leaves the document and its history
 * exactly as they were.
 */

const ENTRIES = [
  {
    path: 'knowledge/sync-error-rate.md',
    title: 'Sync error rate',
    type: null,
    filename: 'sync-error-rate.md',
    folder: 'knowledge',
    properties: {},
    relationships: {},
  },
] as unknown as Entry[];

const labelOf: LabelOf = (type, attrs) =>
  type === 'wikilink'
    ? wikilinkLabel({ target: String(attrs.target), alias: String(attrs.alias ?? '') }, ENTRIES)
    : null;

const PAGE = 'Sync **sy**nc and [[sync-error-rate]], then sync.\n';

const mounted: CerebroEditor[] = [];

function newEditor(): CerebroEditor {
  const created = BlockNoteEditor.create({
    schema: cerebroSchema,
    extensions: [FindHighlights()],
  }) as unknown as CerebroEditor;
  const host = document.createElement('div');
  document.body.append(host);
  created.mount(host);
  created.replaceBlocks(created.document, markdownToBlocksNow(created, PAGE));
  mounted.push(created);
  return created;
}

afterEach(() => {
  for (const each of mounted.splice(0)) each.unmount();
  document.body.replaceChildren();
});

const attrsOf = (d: unknown) => (d as { type: { attrs: Record<string, string> } }).type.attrs;

describe('buildFindDecorations', () => {
  it('draws one inline decoration per text hit and a node decoration per link hit', () => {
    const editor = newEditor();
    const doc = editor.prosemirrorState.doc;
    const hits = findHits(doc, 'sync', labelOf);
    expect(hits.map((h) => h.inLink)).toEqual([false, false, true, false]);
    const set = buildFindDecorations(doc, hits, 2);
    const drawn = set.find().sort((a, b) => a.from - b.from);
    expect(drawn).toHaveLength(4);
    expect(drawn.map((d) => attrsOf(d)['data-find'])).toEqual(['1', '2', '3', '4']);
    // A node decoration covers exactly its chip; inline ones cover their text.
    expect(drawn.map((d) => [d.from, d.to])).toEqual(hits.map((h) => [h.from, h.to]));
    const inline = (d: unknown) =>
      (d as { type: { constructor: { name: string } } }).type.constructor.name;
    expect(inline(drawn[2])).not.toBe(inline(drawn[0]));
    expect(drawn.map((d) => attrsOf(d).class)).toEqual([
      'cb-find-hit',
      'cb-find-hit cb-find-current',
      'cb-find-hit',
      'cb-find-hit',
    ]);
  });
});

describe('showFindHits and clearFindHits', () => {
  it('draw on the page without touching the document or its history', () => {
    const editor = newEditor();
    const before = blocksToMarkdownNow(editor);
    const view = editor.prosemirrorView as unknown as EditorView;
    const depth = undoDepth(view.state);
    const hits = findHits(editor.prosemirrorState.doc, 'sync', labelOf);

    showFindHits(editor, hits, 1);
    const host = view.dom;
    const marks = new Set(
      [...host.querySelectorAll('[data-find]')].map((el) => el.getAttribute('data-find')),
    );
    expect(marks).toEqual(new Set(['1', '2', '3', '4']));
    expect(host.querySelectorAll('.cb-find-current')).toHaveLength(1);
    // The link hit's mark sits on the chip's own node, not on text around it.
    expect(host.querySelector('[data-find="3"]')?.getAttribute('data-inline-content-type')).toBe(
      'wikilink',
    );

    clearFindHits(editor);
    expect(host.querySelectorAll('[data-find]')).toHaveLength(0);
    expect(findHighlightsKey.getState(editor.prosemirrorState)?.find()).toEqual([]);
    expect(blocksToMarkdownNow(editor)).toBe(before);
    expect(undoDepth(view.state)).toBe(depth);
  });

  it('map through an edit', () => {
    const editor = newEditor();
    const hits = findHits(editor.prosemirrorState.doc, 'sync', labelOf);
    showFindHits(editor, hits, 1);
    editor.transact((tr) => {
      tr.insertText('New. ', hits[0].from);
    });
    const state = editor.prosemirrorState;
    const first = findHighlightsKey
      .getState(state)!
      .find()
      .sort((a, b) => a.from - b.from)[0];
    expect(state.doc.textBetween(first.from, first.to)).toBe('Sync');
  });
});
