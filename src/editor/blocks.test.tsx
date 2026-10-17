import { BlockNoteEditor } from '@blocknote/core';
import { describe, expect, it } from 'vitest';
import { DEFAULT_COLUMN_WIDTH } from '@/engine/pageColumns';
import { GatedImageBlock, leaveAiAnswer } from './blocks';
import { clearRemoteImages } from '@/lib/remoteImages';
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

describe('the sheet block as it leaves the app', () => {
  it.each(['', '---\nformat: 1\nname: Budget\n---\nTotal,=SUM(B1:B2)', '"a\n```\nb",3'])(
    'copies source with a safe fence, never computed cells or captions: %s',
    async (source) => {
      const editor = BlockNoteEditor.create({ schema: cerebroSchema });
      const html = await editor.blocksToHTMLLossy([{ type: 'sheet', props: { source } }] as never);
      const text = new DOMParser().parseFromString(html, 'text/html').body.textContent;
      const marker = source.includes('```') ? '````' : '```';
      expect(text).toBe(`${marker}cerebro-sheet\n${source}${source ? '\n' : ''}${marker}`);
      expect(html).not.toContain('sheet-grid');
      expect(html).not.toContain('Calculating');
    },
  );
});

/**
 * The child-page list (M55.13) leaves the app as the empty fence the disk
 * holds, never the titles it renders: those are derived, and pasting them
 * elsewhere would paste a list that no longer follows its pages.
 */
describe('the child-page list as it leaves the app', () => {
  it('exports the empty fence, not the rendered list', async () => {
    const editor = BlockNoteEditor.create({ schema: cerebroSchema });
    const html = await editor.blocksToHTMLLossy([{ type: 'subPages' }] as never);
    const text = new DOMParser().parseFromString(html, 'text/html').body.textContent;
    expect(text).toBe('```cerebro-subpages\n```');
    for (const chrome of ['Sub-pages show', 'No sub-pages yet']) {
      expect(html).not.toContain(chrome);
    }
  });
});

/**
 * The page card (M55.14) leaves the app as the fence the disk holds — its
 * pointer — never the face it renders ("How we schedule", "Open").
 */
describe('the page card as it leaves the app', () => {
  const copied = async (props: { target: string; alias: string }) => {
    const editor = BlockNoteEditor.create({ schema: cerebroSchema });
    const html = await editor.blocksToHTMLLossy([{ type: 'pageCard', props }] as never);
    return { html, text: new DOMParser().parseFromString(html, 'text/html').body.textContent };
  };

  it('exports the fence with its one link, not the card', async () => {
    const { html, text } = await copied({ target: 'how-we-schedule', alias: 'Scheduling' });
    expect(text).toBe('```cerebro-page\n[[how-we-schedule|Scheduling]]\n```');
    for (const chrome of ['Open', 'No page named', 'Find a page']) {
      expect(html).not.toContain(chrome);
    }
  });

  it('exports an unset card as the empty fence', async () => {
    expect((await copied({ target: '', alias: '' })).text).toBe('```cerebro-page\n```');
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

/**
 * The AI block holds its answer the way a column holds its contents (M53.9):
 * `content: 'none'`, the answer as children. The same observation the column
 * rests on, held for this block too.
 */
describe('the AI block', () => {
  const answered = {
    type: 'ai',
    props: { prompt: 'The open questions', generated: '2026-10-12' },
    children: [{ type: 'paragraph', content: 'Who owns the migration?' }],
  };

  it('keeps its question, its date and its answer through the editor', () => {
    const editor = BlockNoteEditor.create({
      schema: cerebroSchema,
      initialContent: [answered] as never,
    });
    const [block] = editor.document as unknown as Record<string, any>[];
    expect(block.type).toBe('ai');
    expect(block.props).toEqual({ prompt: 'The open questions', generated: '2026-10-12' });
    expect(block.children.map((c: any) => c.content[0].text)).toEqual(['Who owns the migration?']);
  });

  /* Without `toExternalHTML` BlockNote copies the RENDERED text, and the
     rendered text is the chrome: the question run into "Recompute", then the
     provenance line — what a save used to write to disk, too. */
  it('puts its opening line and its answer on the clipboard, never its chrome', async () => {
    const editor = BlockNoteEditor.create({ schema: cerebroSchema });
    const html = await editor.blocksToHTMLLossy([answered] as never);
    expect(html).toContain(':::ai{prompt="The open questions" generated="2026-10-12"}');
    expect(html).toContain('Who owns the migration?');
    for (const chrome of ['Recompute', 'Answer', 'Answered', 'edit the answer below']) {
      expect(html).not.toContain(chrome);
    }
  });
});

/**
 * Enter at the end of an AI block's answer leaves the block (M53.9);
 * MarkdownEditor.test.tsx holds the key reaching it through the editor. Here,
 * the places it must leave alone.
 */
describe('leaveAiAnswer', () => {
  const enter = {
    key: 'Enter',
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    isComposing: false,
  };

  type Nest = { id: string; type: string; children: Nest[] };

  /**
   * A headless editor holding one AI block over `answer`, the caret at the end
   * of the answer's last block — the deepest one, when the answer ends nested.
   */
  function atEndOfAnswer(answer: unknown[]) {
    const editor = BlockNoteEditor.create({
      schema: cerebroSchema,
      initialContent: [{ type: 'ai', props: { prompt: 'Q' }, children: answer }] as never,
    });
    let last = (editor.document as unknown as Nest[])[0];
    while (last.children.length > 0) last = last.children[last.children.length - 1];
    editor.setTextCursorPosition(last.id, 'end');
    return editor;
  }

  /* An answer that ends in a sub-bullet, which is how a model often ends one.
     Enter there made a sibling INSIDE the answer, and the next Recompute took
     it with the old answer. */
  const NESTED = [
    { type: 'bulletListItem', content: 'First point' },
    {
      type: 'bulletListItem',
      content: 'Second point',
      children: [
        {
          type: 'bulletListItem',
          content: 'A sub-point',
          children: [{ type: 'bulletListItem', content: 'A deeper one' }],
        },
      ],
    },
  ];

  it('starts a paragraph after the block, and puts the caret in it', () => {
    const editor = atEndOfAnswer([{ type: 'bulletListItem', content: 'Last point' }]);
    expect(leaveAiAnswer(editor, enter)).toBe(true);
    const [ai, after] = editor.document as unknown as {
      id: string;
      type: string;
      children: unknown[];
    }[];
    expect(ai.children).toHaveLength(1);
    expect(after.type).toBe('paragraph');
    expect(editor.getTextCursorPosition().block.id).toBe(after.id);
  });

  it('leaves a modified Enter, a code block and an empty last line to BlockNote', () => {
    const paragraph = [{ type: 'paragraph', content: 'Words' }];
    expect(leaveAiAnswer(atEndOfAnswer(paragraph), { ...enter, shiftKey: true })).toBe(false);
    expect(leaveAiAnswer(atEndOfAnswer(paragraph), { ...enter, isComposing: true })).toBe(false);
    expect(leaveAiAnswer(atEndOfAnswer(paragraph), { ...enter, key: 'a' })).toBe(false);
    const code = [{ type: 'codeBlock', props: { language: 'ts' }, content: 'const x = 1;' }];
    expect(leaveAiAnswer(atEndOfAnswer(code), enter)).toBe(false);
    expect(leaveAiAnswer(atEndOfAnswer([...paragraph, { type: 'paragraph' }]), enter)).toBe(false);
  });

  it('leaves the caret anywhere but the end of the last block to BlockNote', () => {
    const editor = atEndOfAnswer([
      { type: 'paragraph', content: 'First' },
      { type: 'paragraph', content: 'Second' },
    ]);
    const [ai] = editor.document as unknown as { children: { id: string }[] }[];
    editor.setTextCursorPosition(ai.children[0].id, 'end');
    expect(leaveAiAnswer(editor, enter)).toBe(false);
    editor.setTextCursorPosition(ai.children[1].id, 'start');
    expect(leaveAiAnswer(editor, enter)).toBe(false);
  });

  it('leaves from the end of an answer that ends in a nested block', () => {
    const editor = atEndOfAnswer(NESTED);
    const answer = JSON.stringify((editor.document as unknown as Nest[])[0].children);
    expect(leaveAiAnswer(editor, enter)).toBe(true);
    const [ai, after] = editor.document as unknown as Nest[];
    expect(JSON.stringify(ai.children)).toBe(answer);
    expect(after.type).toBe('paragraph');
    expect(editor.getTextCursorPosition().block.id).toBe(after.id);
  });

  it('leaves the blocks above the deepest last one, and its exceptions, to BlockNote', () => {
    const editor = atEndOfAnswer(NESTED);
    const second = (editor.document as unknown as Nest[])[0].children[1];
    for (const block of [second, second.children[0]]) {
      editor.setTextCursorPosition(block.id, 'end');
      expect(leaveAiAnswer(editor, enter)).toBe(false);
    }
    const under = (children: unknown[]) => [
      { type: 'bulletListItem', content: 'A point', children },
    ];
    const code = { type: 'codeBlock', props: { language: 'ts' }, content: 'const x = 1;' };
    expect(leaveAiAnswer(atEndOfAnswer(under([code])), enter)).toBe(false);
    expect(leaveAiAnswer(atEndOfAnswer(under([{ type: 'bulletListItem' }])), enter)).toBe(false);
    expect(leaveAiAnswer(atEndOfAnswer(NESTED), { ...enter, shiftKey: true })).toBe(false);
  });
});

describe('the whiteboard block as it leaves the app', () => {
  it.each(['', 'board: boards/plan.canvas', 'board: boards/plan.canvas\nextra: "```"'])(
    'copies a raw pointer with a safe fence: %s',
    async (source) => {
      const editor = BlockNoteEditor.create({ schema: cerebroSchema });
      const html = await editor.blocksToHTMLLossy([
        { type: 'whiteboard', props: { source } },
      ] as never);
      const text = new DOMParser().parseFromString(html, 'text/html').body.textContent;
      const marker = source.includes('```') ? '````' : '```';
      expect(text).toBe(`${marker}cerebro-whiteboard\n${source}${source ? '\n' : ''}${marker}`);
      expect(html).not.toContain('Open');
      expect(html).not.toContain('whiteboard-embed');
    },
  );
});

describe('the gated image block', () => {
  it('a remote image waits for a native DOM click', async () => {
    clearRemoteImages();
    const editor = BlockNoteEditor.create({
      schema: cerebroSchema,
      initialContent: [{ type: 'image', props: { url: 'https://images.example/click.png' } }],
    });
    const node = GatedImageBlock().implementation.render.call(
      {},
      editor.document[0] as never,
      editor as never,
    );
    expect(node.dom.querySelector('img')).toBeNull();
    expect(node.dom.textContent).toContain('images.example');
    node.dom.querySelector('button')!.click();
    await Promise.resolve();
    const image = node.dom.querySelector('img');
    expect(image?.getAttribute('src')).toBe('https://images.example/click.png');
    expect(image?.referrerPolicy).toBe('no-referrer');
    node.destroy?.();
  });
  it('a relative image renders through BlockNote and export images are lazy', async () => {
    const editor = BlockNoteEditor.create({
      schema: cerebroSchema,
      initialContent: [{ type: 'image', props: { url: 'attachments/a.png' } }],
    });
    const node = GatedImageBlock().implementation.render.call(
      {},
      editor.document[0] as never,
      editor as never,
    );
    expect(node.dom.querySelector('img')).toBeTruthy();
    node.destroy?.();
    const html = await editor.blocksToHTMLLossy([
      { type: 'image', props: { url: 'https://images.example/export.png' } },
    ]);
    const image = new DOMParser().parseFromString(html, 'text/html').querySelector('img');
    expect(image?.getAttribute('loading')).toBe('lazy');
    expect(image?.getAttribute('src')).toBe('https://images.example/export.png');
  });
});
