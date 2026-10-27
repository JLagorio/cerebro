// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { BlockNoteEditor } from '@blocknote/core';
import { cerebroSchema, type CerebroEditor } from './MarkdownEditor';
import { markdownToBlocksNow } from './markdown';
import { mapSourceRange } from './sourceReveal';
import { sourceUtf8Length } from '@/engine/sourceLocation';

function setup(body: string) {
  const editor = BlockNoteEditor.create({ schema: cerebroSchema }) as CerebroEditor;
  editor.replaceBlocks(editor.document, markdownToBlocksNow(editor, body));
  return editor;
}
function range(body: string, quote: string, at = body.indexOf(quote)) {
  const start = sourceUtf8Length(body.slice(0, at));
  return { start, end: start + sourceUtf8Length(quote) };
}
describe('source span mapping through the installed editor', () => {
  it('selects the second repeated occurrence by raw byte position', () => {
    const body = 'repeat\n\nrepeat';
    const editor = setup(body);
    const mapped = mapSourceRange(body, range(body, 'repeat', body.lastIndexOf('repeat')), editor);
    expect(mapped).not.toBeNull();
    expect(mapped!.from).toBeGreaterThan(9);
    expect(editor.prosemirrorState.doc.textBetween(mapped!.from, mapped!.to)).toBe('repeat');
  });
  it('maps source UTF-8 to editor UTF-16 without shifting a projected H1', () => {
    const body = '\n# Café 😀\n\nSecond 😀 passage';
    const editor = setup(body);
    const mapped = mapSourceRange(body, range(body, '😀 passage'), editor);
    expect(mapped).not.toBeNull();
    expect(editor.prosemirrorState.doc.textBetween(mapped!.from, mapped!.to)).toBe('😀 passage');
    const title = mapSourceRange(body, range(body, 'Café 😀'), editor);
    expect(title).toEqual({ from: 3, to: 10 });
  });
  it('maps flat lists and literal fenced code by structure', () => {
    const body = '- First\n- Second\n\n```js\nconst café = 1;\n```';
    const editor = setup(body);
    for (const quote of ['Second', 'café']) {
      const mapped = mapSourceRange(body, range(body, quote), editor);
      expect(mapped).not.toBeNull();
      expect(editor.prosemirrorState.doc.textBetween(mapped!.from, mapped!.to)).toBe(quote);
    }
  });
  it('rejects changed content and UTF-8 offsets inside a scalar', () => {
    expect(mapSourceRange('before', range('before', 'before'), setup('after'))).toBeNull();
    expect(mapSourceRange('😀', { start: 1, end: 4 }, setup('😀'))).toBeNull();
  });
  it.each(['[[target|alias]]', '**bold**', '```mermaid\ngraph TD\n```', ':::columns\ntext\n:::'])(
    'retains unsupported syntax honestly: %s',
    (body) => {
      expect(mapSourceRange(body, range(body, body), setup(body))).toBeNull();
    },
  );
});

import { revealSource, revealProperty } from './sourceReveal';
import type { SourceLocator } from '@/engine/sourceLocation';
it('delayed readiness after typing elsewhere never steals selection', async () => {
  const body = 'passage';
  const editor = setup(body);
  const selection = editor.prosemirrorState.selection;
  const locator: SourceLocator = {
    version: 1,
    vaultId: 'demo',
    path: 'a.md',
    sourceHash: 'a'.repeat(64),
    kind: 'body',
    bodyUtf8Range: range(body, body),
    quote: body,
    prefix: '',
    suffix: '',
  };
  expect(
    await revealSource(
      { requestId: 'late', locator },
      {
        editor,
        body,
        sourceHash: locator.sourceHash,
        isCurrent: () => true,
        mayFocus: () => false,
      },
    ),
  ).toBe('cancelled');
  expect(editor.prosemirrorState.selection).toBe(selection);
});
it('stale source version cannot select even identical displayed words', async () => {
  const body = 'passage';
  const locator: SourceLocator = {
    version: 1,
    vaultId: 'demo',
    path: 'a.md',
    sourceHash: 'a'.repeat(64),
    kind: 'body',
    bodyUtf8Range: range(body, body),
    quote: body,
    prefix: '',
    suffix: '',
  };
  expect(
    await revealSource(
      { requestId: 'r', locator },
      {
        editor: setup(body),
        body,
        sourceHash: 'b'.repeat(64),
        isCurrent: () => true,
        mayFocus: () => true,
      },
    ),
  ).toBe('changed');
});
it('property arrays and relations focus only the exact read-only row anchor', () => {
  const root = document.createElement('div');
  root.innerHTML =
    '<div data-property="relations"><button>One, Two</button></div><div data-property="tags"><input value="One, Two"></div>';
  document.body.append(root);
  for (const key of ['relations', 'tags']) {
    expect(revealProperty(key, 'r', { root, isCurrent: () => true, mayFocus: () => true })).toBe(
      'revealed',
    );
    expect((document.activeElement as HTMLElement).dataset.property).toBe(key);
  }
  expect(
    revealProperty('renamed', 'r', { root, isCurrent: () => true, mayFocus: () => true }),
  ).toBe('unsupported');
  root.remove();
});

it('waits for BlockNote mounted initialization before reporting a visible reveal', async () => {
  const body = 'passage';
  const editor = setup(body);
  const host = document.createElement('div');
  document.body.append(host);
  editor.mount(host);
  const locator: SourceLocator = {
    version: 1,
    vaultId: 'demo',
    path: 'a.md',
    sourceHash: 'a'.repeat(64),
    kind: 'body',
    bodyUtf8Range: range(body, body),
    quote: body,
    prefix: '',
    suffix: '',
  };
  // Tiptap 3.29 initializes on a later timer even though its DOM is connected.
  expect(editor.headless).toBe(true);
  const result = await revealSource(
    { requestId: 'r', locator },
    { editor, body, sourceHash: locator.sourceHash, isCurrent: () => true, mayFocus: () => true },
  );
  expect(result).toBe('revealed');
  expect(editor.headless).toBe(false);
  expect(document.activeElement).toBe(editor.prosemirrorView.dom);
  editor.unmount();
  host.remove();
});

it('a row hidden by an ancestor never reports a reveal', () => {
  const root = document.createElement('div');
  root.innerHTML = '<div hidden><div data-property="tags">One, Two</div></div>';
  document.body.append(root);
  expect(revealProperty('tags', 'r', { root, isCurrent: () => true, mayFocus: () => true })).toBe(
    'unsupported',
  );
  root.remove();
});
