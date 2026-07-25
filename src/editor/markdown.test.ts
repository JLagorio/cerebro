// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';
import { BlockNoteEditor } from '@blocknote/core';
import {
  blocksToMarkdown,
  isLossyImport,
  markdownToBlocks,
  normalizeParsedBlocks,
} from './markdown';

let editor: BlockNoteEditor;
beforeAll(() => {
  editor = BlockNoteEditor.create();
});

const roundTrip = async (md: string) => blocksToMarkdown(editor, await markdownToBlocks(editor, md));

/**
 * The M2 fixture corpus. `out` pins the normalized serialization; every
 * fixture must additionally be STABLE (serializing the normalized form again
 * is a no-op), or files would grow on each open/save cycle.
 */
const CORPUS: { name: string; md: string; out: string }[] = [
  {
    name: 'headings and inline styles',
    md: '# Title\n\nSome **bold** and *italic* and `code` and [a link](https://example.com).\n',
    out: '# Title\n\nSome **bold** and *italic* and `code` and [a link](https://example.com).\n',
  },
  {
    name: 'nested bullet and numbered lists (normalized to * and loose)',
    md: '- top\n  - nested\n    - deeper\n- second\n\n1. one\n2. two\n',
    out: '* top\n\n  * nested\n\n    * deeper\n\n* second\n\n1. one\n\n2. two\n',
  },
  {
    name: 'checkboxes with nesting and a due-date emoji',
    md: '- [ ] open task\n- [x] done task\n  - [ ] nested task 📅 2026-08-01\n',
    out: '* [ ] open task\n* [x] done task\n  * [ ] nested task 📅 2026-08-01\n',
  },
  {
    name: 'code fence (byte-identical)',
    md: '```ts\nconst x = 1;\nfunction f() {\n  return x;\n}\n```\n',
    out: '```ts\nconst x = 1;\nfunction f() {\n  return x;\n}\n```\n',
  },
  {
    name: 'code fence with a blank line (exempt from break halving)',
    md: '```ts\nconst a = 1;\n\nconst b = 2;\n```\n',
    out: '```ts\nconst a = 1;\n\nconst b = 2;\n```\n',
  },
  {
    name: 'table (padding normalized, content intact)',
    md: '| Name | Status |\n| --- | --- |\n| Alpha | Ready |\n| Beta | Blocked |\n',
    out: '| Name  | Status  |\n| ----- | ------- |\n| Alpha | Ready   |\n| Beta  | Blocked |\n',
  },
  {
    name: 'multi-line quote (break halving keeps it stable)',
    md: '> plain quote line\n> second line\n',
    out: '> plain quote line\\\n> second line\n',
  },
  {
    name: 'quote with a paragraph break',
    md: '> first para\n>\n> second para\n',
    out: '> first para\\\n> second para\n',
  },
  {
    name: 'callout (marker survives unescaped)',
    md: '> [!note]\n> Callout body text.\n',
    out: '> [!note]\\\n> Callout body text.\n',
  },
  {
    name: 'titled callout',
    md: '> [!warning] Watch out\n> Danger here.\n',
    out: '> [!warning] Watch out\\\n> Danger here.\n',
  },
  {
    name: 'hard break in a paragraph (not doubled)',
    md: 'line one  \nline two\n',
    out: 'line one\\\nline two\n',
  },
  {
    name: 'thematic break (divider block)',
    md: 'above\n\n---\n\nbelow\n',
    out: 'above\n\n***\n\nbelow\n',
  },
  {
    name: 'empty document',
    md: '',
    out: '',
  },
];

describe('markdown round trip', () => {
  for (const { name, md, out } of CORPUS) {
    it(`${name}: serializes to the pinned form`, async () => {
      expect(await roundTrip(md)).toBe(out);
    });
    it(`${name}: is stable`, async () => {
      const once = await roundTrip(md);
      expect(await roundTrip(once)).toBe(once);
    });
  }

  it('parses the corpus into the expected block types', async () => {
    const blocks = await markdownToBlocks(
      editor,
      '# H\n\n- [ ] task\n\n```ts\nx\n```\n\n| a |\n| - |\n| b |\n\n> q\n\n---\n',
    );
    expect(blocks.map((b) => b.type)).toEqual([
      'heading',
      'checkListItem',
      'codeBlock',
      'table',
      'quote',
      'divider',
    ]);
  });
});

describe('normalizeParsedBlocks', () => {
  it('halves doubled break runs in text nodes, including nested content', () => {
    const blocks = [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'a\n\nb', styles: {} },
          { type: 'link', href: 'x', content: [{ type: 'text', text: 'c\n\nd', styles: {} }] },
        ],
        children: [
          { type: 'paragraph', content: [{ type: 'text', text: 'e\n\n\n\nf', styles: {} }] },
        ],
      },
    ];
    normalizeParsedBlocks(blocks as never[]);
    const para = blocks[0] as unknown as {
      content: [{ text: string }, { content: [{ text: string }] }];
      children: [{ content: [{ text: string }] }];
    };
    expect(para.content[0].text).toBe('a\nb');
    expect(para.content[1].content[0].text).toBe('c\nd');
    expect(para.children[0].content[0].text).toBe('e\n\nf');
  });

  it('leaves code block text untouched', () => {
    const blocks = [
      { type: 'codeBlock', content: [{ type: 'text', text: 'a\n\nb', styles: {} }], children: [] },
    ];
    normalizeParsedBlocks(blocks as never[]);
    expect((blocks[0].content[0] as { text: string }).text).toBe('a\n\nb');
  });

  it('reaches table cell content', () => {
    const blocks = [
      {
        type: 'table',
        content: {
          type: 'tableContent',
          rows: [{ cells: [[{ type: 'text', text: 'a\n\nb', styles: {} }]] }],
        },
        children: [],
      },
    ];
    normalizeParsedBlocks(blocks as never[]);
    const table = blocks[0] as unknown as {
      content: { rows: { cells: { text: string }[][] }[] };
    };
    expect(table.content.rows[0].cells[0][0].text).toBe('a\nb');
  });
});

describe('isLossyImport', () => {
  it('flags dropped raw HTML blocks', async () => {
    const source = '<div align="center">centered text</div>\n';
    expect(isLossyImport(source, await roundTrip(source))).toBe(true);
  });

  it('accepts pure formatting normalization across the corpus', async () => {
    for (const { md } of CORPUS) {
      expect(isLossyImport(md, await roundTrip(md))).toBe(false);
    }
  });
});
