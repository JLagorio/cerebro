// @vitest-environment jsdom
import { BlockNoteEditor } from '@blocknote/core';
import { undoDepth } from 'prosemirror-history';
import type { EditorView } from 'prosemirror-view';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { anchorAt, type CommentAnchor } from '@/engine/commentAnchor';
import { CommentHighlights, commentHighlightsKey } from './commentHighlights';
import { blocksToMarkdownNow, markdownToBlocksNow } from './markdown';
import { cerebroSchema, type CerebroEditor } from './MarkdownEditor';
import { readerText } from './readerText';

/**
 * Comment highlights (M70.1) on an editor with the app's schema, mounted on a
 * bare element with no React: a headless BlockNote editor holds no plugins
 * until it mounts, so the highlights would have nowhere to live. The claim
 * that matters most: drawing, restyling and clearing them leaves the document
 * and its undo history exactly as they were.
 */

const PAGE = 'Owner: TBD.\n\nDeadline: TBD.\n\nWe ship on Thursdays, after the freeze.\n';

let editor: CerebroEditor;

const mounted: CerebroEditor[] = [];

function newEditor(): CerebroEditor {
  const created = BlockNoteEditor.create({
    schema: cerebroSchema,
    extensions: [CommentHighlights()],
  }) as unknown as CerebroEditor;
  const host = document.createElement('div');
  document.body.append(host);
  created.mount(host);
  created.replaceBlocks(created.document, markdownToBlocksNow(created, PAGE));
  mounted.push(created);
  return created;
}

beforeEach(() => {
  editor = newEditor();
});

afterEach(() => {
  for (const each of mounted.splice(0)) each.unmount();
  document.body.replaceChildren();
});

const highlights = () => editor.getExtension(CommentHighlights)!;

/** The anchor on the `n`th copy of `quote` in the page as it is now. */
function anchorOn(quote: string, n = 1): CommentAnchor {
  const { spans } = readerText(editor.prosemirrorState.doc);
  let at = -1;
  for (let k = 0; k < n; k++) at = spans.text.indexOf(quote, at + 1);
  const result = anchorAt(spans, at, at + quote.length);
  if (!result.ok) throw new Error(result.reason);
  return result.anchor;
}

/** What is drawn: each decoration's text, class and thread. */
function drawn() {
  const state = editor.prosemirrorState;
  const set = commentHighlightsKey.getState(state)!;
  return set
    .find()
    .map((d) => {
      const attrs = (d as unknown as { type: { attrs: Record<string, string> } }).type.attrs;
      return {
        text: state.doc.textBetween(d.from, d.to),
        from: d.from,
        to: d.to,
        class: attrs.class,
        thread: attrs['data-thread'],
      };
    })
    .sort((a, b) => a.from - b.from);
}

const textOf = (needle: string) => {
  let at = -1;
  editor.prosemirrorState.doc.descendants((node, pos) => {
    if (at < 0 && node.isText && (node.text ?? '').includes(needle)) {
      at = pos + (node.text ?? '').indexOf(needle);
    }
    return at < 0;
  });
  return at;
};

describe('CommentHighlights', () => {
  it('draws one decoration per attached thread, each carrying its thread', () => {
    highlights().setThreads([
      { id: 't1', anchor: anchorOn('after the freeze') },
      { id: 't2', anchor: anchorOn('TBD', 2) },
      { id: 't3', anchor: { quote: 'not on the page', occurrence: 1, before: '', after: '' } },
    ]);
    expect(drawn().map(({ text, class: c, thread }) => ({ text, c, thread }))).toEqual([
      { text: 'TBD', c: 'cb-comment', thread: 't2' },
      { text: 'after the freeze', c: 'cb-comment', thread: 't1' },
    ]);
    // The second TBD, not the first.
    expect(drawn()[0].from).toBe(textOf('Deadline: TBD') + 'Deadline: '.length);
  });

  it('keeps the document and its undo depth across set, active and pending', () => {
    const doc = editor.prosemirrorState.doc;
    const depth = undoDepth(editor.prosemirrorState);
    const onChange = vi.fn();
    editor.onChange(onChange);
    highlights().setThreads([{ id: 't1', anchor: anchorOn('after the freeze') }]);
    highlights().setActive('t1');
    expect(drawn()[0].class).toBe('cb-comment cb-comment-active');
    highlights().setPending(anchorOn('Owner'));
    expect(drawn().map((d) => d.class)).toContain('cb-comment-pending');
    highlights().setPending(null);
    highlights().setActive(null);
    highlights().setThreads([]);
    expect(editor.prosemirrorState.doc).toBe(doc);
    expect(undoDepth(editor.prosemirrorState)).toBe(depth);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('maps an anchor through typing before it', () => {
    highlights().setThreads([{ id: 't1', anchor: anchorOn('after the freeze') }]);
    const before = drawn()[0];
    const at = textOf('We ship');
    editor.transact((tr) => tr.insertText('Really, ', at));
    const after = drawn()[0];
    expect(after.from).toBe(before.from + 'Really, '.length);
    expect(after.text).toBe('after the freeze');
  });

  it('detaches a thread whose quote was deleted once it resolves again', () => {
    highlights().setThreads([{ id: 't1', anchor: anchorOn('after the freeze') }]);
    expect(highlights().store.state.resolutions.get('t1')).toMatchObject({ kind: 'attached' });
    const at = textOf('after the freeze');
    editor.transact((tr) => tr.delete(at - 2, at + 'after the freeze'.length));
    highlights().resolveNow();
    expect(highlights().store.state.resolutions.get('t1')).toEqual({
      kind: 'detached',
      reason: 'gone',
      count: 0,
    });
    expect(drawn()).toEqual([]);
  });

  it('holds no resolution for an id it was never given', () => {
    highlights().setThreads([{ id: 't1', anchor: anchorOn('TBD') }]);
    expect(highlights().store.state.resolutions.has('t9')).toBe(false);
    highlights().setThreads([]);
    expect(highlights().store.state.resolutions.has('t1')).toBe(false);
  });

  it('hands a click the narrowest thread under it, and lets the click through', () => {
    highlights().setThreads([
      { id: 'wide', anchor: anchorOn('after the freeze') },
      { id: 'narrow', anchor: anchorOn('freeze') },
    ]);
    const picked = vi.fn();
    const off = highlights().onSelect(picked);
    const plugin = commentHighlightsKey.get(editor.prosemirrorState)!;
    const view = { state: editor.prosemirrorState } as EditorView;
    const click = (pos: number) =>
      plugin.props.handleClick!.call(plugin, view, pos, new MouseEvent('click'));
    expect(click(textOf('freeze') + 2)).toBe(false);
    expect(click(textOf('after') + 1)).toBe(false);
    expect(click(textOf('Owner') + 1)).toBe(false);
    expect(picked.mock.calls).toEqual([['narrow'], ['wide']]);
    off();
    click(textOf('freeze') + 2);
    expect(picked).toHaveBeenCalledTimes(2);
  });

  it('leaves the markdown unchanged with highlights on', () => {
    const plain = blocksToMarkdownNow(editor);
    highlights().setThreads([{ id: 't1', anchor: anchorOn('after the freeze') }]);
    highlights().setActive('t1');
    expect(blocksToMarkdownNow(editor)).toBe(plain);
  });

  it('resolves the same span after the same markdown is parsed again', () => {
    const anchor = anchorOn('TBD', 2);
    highlights().setThreads([{ id: 't1', anchor }]);
    const first = drawn()[0];
    const again = newEditor();
    again.getExtension(CommentHighlights)!.setThreads([{ id: 't1', anchor }]);
    const set = commentHighlightsKey.getState(again.prosemirrorState)!.find();
    expect(set.map((d) => [d.from, d.to])).toEqual([[first.from, first.to]]);
  });

  /* The browser-mode seam the e2e drives (M55.6's precedent): the last
     mounted editor owns it, and it goes when that editor does. */
  it('installs the probe in browser mode and removes it on unmount', () => {
    const seam = window as { __cerebroCommentProbe?: { resolutions: () => unknown } };
    const first = seam.__cerebroCommentProbe;
    expect(first).toBeDefined();
    const second = newEditor();
    expect(seam.__cerebroCommentProbe).not.toBe(first);
    second.getExtension(CommentHighlights)!.setThreads([{ id: 't1', anchor: anchorOn('TBD') }]);
    expect(seam.__cerebroCommentProbe!.resolutions()).toEqual({
      t1: { kind: 'attached', start: 7, end: 10, moved: false },
    });
    second.unmount();
    expect(seam.__cerebroCommentProbe).toBeUndefined();
  });

  it('installs no probe inside the packaged app', () => {
    const tauri = window as { __TAURI_INTERNALS__?: unknown; __cerebroCommentProbe?: unknown };
    for (const each of mounted.splice(0)) each.unmount();
    tauri.__TAURI_INTERNALS__ = {};
    try {
      newEditor();
      expect(tauri.__cerebroCommentProbe).toBeUndefined();
    } finally {
      delete tauri.__TAURI_INTERNALS__;
    }
  });
});
