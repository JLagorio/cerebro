import { BlockNoteEditor } from '@blocknote/core';
import { describe, expect, it } from 'vitest';
import { DEFAULT_COLUMN_WIDTH } from '@/engine/pageColumns';
import { cerebroSchema } from './MarkdownEditor';

/**
 * What leaves the app when a selection crosses a custom block (M29.53).
 *
 * BlockNote builds `blocknote/html`, `text/html` and `text/plain` from ONE
 * serializer pass, so a block with no `toExternalHTML` contributes its rendered
 * chrome to all three. MEASURED on demo-vault/strategy/systems-map.md: a
 * drag-select across the first diagram put
 * "FlowchartOpen full screenSave as file…Edit" on the OS clipboard — read back
 * through navigator.clipboard.readText() — with the diagram source nowhere in
 * it, while an in-app paste round-tripped losslessly off the other two
 * flavours. Only what left the app was wrong.
 */
describe('the mermaid block as it leaves the app', () => {
  const code = 'flowchart TD\n  Idea[Idea] --> Build[Build]';

  async function externalHtml(): Promise<string> {
    const editor = BlockNoteEditor.create({ schema: cerebroSchema });
    return editor.blocksToHTMLLossy([{ type: 'mermaid', props: { code } }] as never);
  }

  it('exports the fence, not the block chrome', async () => {
    const html = await externalHtml();
    expect(html).toContain('```mermaid');
    expect(html).toContain('Idea[Idea] --&gt; Build[Build]');
    for (const chrome of ['Open full screen', 'Save as file', 'Edit']) {
      expect(html).not.toContain(chrome);
    }
  });

  it('is the same fence markdown.ts writes to disk, so a paste elsewhere is the source', async () => {
    const html = await externalHtml();
    // The plain-text flavour is derived from this markup, so what a text
    // editor receives is the fence verbatim. Read through a parser rather than
    // a regex: the markup carries the source in an attribute too.
    const text = new DOMParser().parseFromString(html, 'text/html').body.textContent;
    expect(text).toBe(`\`\`\`mermaid\n${code}\n\`\`\``);
  });
});

/**
 * The observation the whole column feature rests on (M48.1).
 *
 * `@blocknote/xl-multi-column` is licensed `GPL-3.0 OR PROPRIETARY` and this
 * project is Apache-2.0, so columns had to be built from the public custom
 * block API. That is only possible because a `content: 'none'` block accepts
 * CHILDREN — which is observed behaviour of `@blocknote/core@0.46.2` rather
 * than a documented guarantee.
 *
 * These tests exist to make an upgrade that withdraws it fail loudly. The
 * silent failure they are guarding against is a version bump that flattens
 * every column on every page the next time somebody opens one.
 */
describe('a column list is nesting BlockNote already does', () => {
  const nest = [
    { type: 'paragraph', content: 'before' },
    {
      type: 'columnList',
      children: [
        { type: 'column', props: { width: 2 }, children: [{ type: 'paragraph', content: 'left' }] },
        { type: 'column', children: [{ type: 'paragraph', content: 'right' }] },
      ],
    },
  ];

  const editorWithNest = () =>
    BlockNoteEditor.create({ schema: cerebroSchema, initialContent: nest as never });

  it('round-trips two levels of children with their content intact', () => {
    const doc = editorWithNest().document as unknown as Record<string, any>[];
    const list = doc.find((b) => b.type === 'columnList');
    expect(list).toBeDefined();
    expect(list?.children.map((c: any) => c.type)).toEqual(['column', 'column']);
    expect(list?.children.map((c: any) => c.children[0].content[0].text)).toEqual([
      'left',
      'right',
    ]);
  });

  it('keeps a declared width and defaults the one that declared none', () => {
    const doc = editorWithNest().document as unknown as Record<string, any>[];
    const widths = doc
      .find((b) => b.type === 'columnList')
      ?.children.map((c: any) => c.props.width);
    expect(widths).toEqual([2, DEFAULT_COLUMN_WIDTH]);
  });

  /* The DOM shape the CSS depends on. A column is laid out by turning the
     SIBLING block group into a flex row, so if BlockNote ever renders children
     somewhere else the layout silently stops happening — with no error, and
     with the page still showing every word in one long stack.

     Read this test knowing what it CANNOT see: in a real browser BlockNote
     wraps a custom React block in an extra `.react-renderer` element that
     jsdom never creates. MEASURED, after a first version of the CSS matched
     here and matched nothing in the app. The selectors in editor.css allow for
     both, and only a browser can prove they do — e2e/columns.spec.ts. */
  it('renders each column as a block outer inside the list\u2019s sibling group', () => {
    const editor = editorWithNest();
    const host = document.createElement('div');
    document.body.appendChild(host);
    editor.mount(host);
    const list = host.querySelector('[data-content-type="columnList"]');
    expect(list).not.toBeNull();
    const group = list?.parentElement?.querySelector(':scope > .bn-block-group');
    expect(group).not.toBeNull();
    const columns = group?.querySelectorAll(
      ':scope > .bn-block-outer > .bn-block > [data-content-type="column"]',
    );
    expect(columns?.length).toBe(2);
    editor.mount(undefined as unknown as HTMLElement);
    host.remove();
  });

  /* This block renders a STYLESHEET — the only way a descendant can size the
     ancestor the browser lays out. Without `toExternalHTML`, BlockNote derives
     text/plain from the rendered text, so copying a column would put a CSS
     selector on somebody's clipboard. */
  it('puts the marker line on the clipboard, never the rule that sizes it', async () => {
    const editor = BlockNoteEditor.create({ schema: cerebroSchema });
    const html = await editor.blocksToHTMLLossy([
      { type: 'column', props: { width: 2 }, children: [{ type: 'paragraph', content: 'x' }] },
    ] as never);
    expect(html).toContain('::::column width=2');
    expect(html).not.toContain('flex-grow');
    expect(html).not.toContain('.cerebro-editor');
  });
});
