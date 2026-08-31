// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';
import { BlockNoteEditor } from '@blocknote/core';
import {
  blocksToMarkdown,
  isLossyImport,
  markdownToBlocks,
  normalizeParsedBlocks,
  spliceTitleIntoBlocks,
} from './markdown';
import { cerebroSchema, type CerebroEditor } from './MarkdownEditor';

// The app schema, not the default one: markdownToBlocks promotes chip text
// (wikilinks, 📅 dates) into custom inline nodes that only exist there.
let editor: CerebroEditor;
beforeAll(() => {
  editor = BlockNoteEditor.create({ schema: cerebroSchema }) as CerebroEditor;
});

const roundTrip = async (md: string) =>
  blocksToMarkdown(editor, await markdownToBlocks(editor, md));

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
    // M2.x chips: wikilinks / assignees / due dates become inline nodes in
    // the editor but must land on disk as the exact plain-text form.
    name: 'wikilinks and task chips',
    md: 'See [[kickoff]] and [[kickoff|the kickoff]].\n\n- [ ] follow up @[[maya-chen]] 📅 2026-08-01\n',
    out: 'See [[kickoff]] and [[kickoff|the kickoff]].\n\n* [ ] follow up @[[maya-chen]] 📅 2026-08-01\n',
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
    // M2.x callout block: the bare marker line merges into the first content
    // line on the promote/demote round trip — still a valid Obsidian callout.
    name: 'callout (marker survives unescaped)',
    md: '> [!note]\n> Callout body text.\n',
    out: '> [!note] Callout body text.\n',
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

/**
 * The database fence (M47.2).
 *
 * A page holds a POINTER to a database, never the database — so what has to
 * be right is that the pointer survives a trip to disk and back unchanged,
 * through the real editor rather than through the promote/demote helpers in
 * isolation. A block whose fence is not a usable pointer must come back as
 * the ordinary code block it was, because that is the only behaviour that
 * cannot destroy what somebody typed.
 */
describe('the cerebro-database fence', () => {
  const fence = (body: string) => `\`\`\`cerebro-database\n${body}\n\`\`\`\n`;

  it('promotes a fence naming a database into a database block', async () => {
    const blocks = await markdownToBlocks(editor, fence('database: Reading list\nview: shelf'));
    expect(blocks.map((b) => b.type)).toEqual(['database']);
    expect(blocks[0].props).toMatchObject({ database: 'Reading list', view: 'shelf' });
  });

  it('carries an unnamed view as the empty string, not as a missing prop', async () => {
    const blocks = await markdownToBlocks(editor, fence('database: Reading list'));
    expect(blocks[0].props).toMatchObject({ database: 'Reading list', view: '' });
  });

  it('round-trips back to the same fence', async () => {
    for (const body of ['database: Reading list\nview: shelf', 'database: Reading list']) {
      expect(await roundTrip(fence(body))).toBe(fence(body));
    }
  });

  /**
   * The failure that would be silent and unrecoverable: a half-typed fence
   * becoming a database block means the user's text is replaced by a message
   * about their text, and saving then writes the replacement to disk. It stays
   * a code block, holding exactly what they wrote.
   */
  it('leaves a fence that names no database as an ordinary code block', async () => {
    for (const body of ['', 'view: shelf', 'database:', 'not yaml: [', '- a list']) {
      const blocks = await markdownToBlocks(editor, fence(body));
      expect(blocks.map((b) => b.type)).toEqual(['codeBlock']);
    }
  });

  it('does not claim a fence in another language', async () => {
    const blocks = await markdownToBlocks(editor, '```yaml\ndatabase: Reading list\n```\n');
    expect(blocks.map((b) => b.type)).toEqual(['codeBlock']);
  });
});

describe('the ::: column containers', () => {
  const TWO = [
    'Before.',
    '',
    ':::columns',
    '::::column',
    'Left.',
    '::::',
    '::::column',
    'Right.',
    '::::',
    ':::',
    '',
    'After.',
    '',
  ].join('\n');

  it('folds a flat run of markers into a nest of columnList and column', async () => {
    const blocks = await markdownToBlocks(editor, TWO);
    expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'columnList', 'paragraph']);
    const list = blocks[1];
    expect(list.children.map((c: { type: string }) => c.type)).toEqual(['column', 'column']);
    expect(
      list.children.map((c: { children: { content: { text: string }[] }[] }) =>
        c.children[0].content[0].text.trim(),
      ),
    ).toEqual(['Left.', 'Right.']);
  });

  it('round-trips back to the same markdown, tight form and all', async () => {
    expect(await roundTrip(TWO)).toBe(TWO);
  });

  /* The fidelity policy this module has held since M2, applied to the one
     construct whose serialization is entirely ours. A round trip that is
     stable ONCE but not twice grows the file on every open/save cycle. */
  it('is stable across a second trip', async () => {
    const once = await roundTrip(TWO);
    expect(await roundTrip(once)).toBe(once);
  });

  it('carries a declared width and writes it back only when it deviates', async () => {
    const wide = TWO.replace('::::column\nRight.', '::::column width=3\nRight.');
    const blocks = await markdownToBlocks(editor, wide);
    expect(blocks[1].children.map((c: { props: { width: number } }) => c.props.width)).toEqual([
      1, 3,
    ]);
    expect(await roundTrip(wide)).toBe(wide);
  });

  /* A column is only worth having if you can put things in it. The database
     fence is the sharpest case: it proves a column's contents stay real
     markdown blocks rather than becoming inert text, which is the whole
     reason the on-disk form is a directive and not a fence of our own. */
  it('keeps a database fence inside a column a database block', async () => {
    const withFence = [
      ':::columns',
      '::::column',
      '```cerebro-database',
      'database: Reading list',
      'view: shelf',
      '```',
      '::::',
      '::::column',
      'Notes.',
      '::::',
      ':::',
      '',
    ].join('\n');
    const blocks = await markdownToBlocks(editor, withFence);
    const first = blocks[0].children[0].children[0];
    expect(first.type).toBe('database');
    expect(first.props).toMatchObject({ database: 'Reading list', view: 'shelf' });
    expect(await roundTrip(withFence)).toBe(withFence);
  });

  /* Tolerance, and it is asymmetric on purpose. A stray marker is TEXT — the
     reader sees it and can fix the file. An unclosed container abandons the
     fold entirely, because a half-built nest would swallow every block after
     the opening marker into a column with no visible end. */
  it('leaves a stray close as the paragraph it is', async () => {
    const blocks = await markdownToBlocks(editor, 'One.\n\n:::\n\nTwo.\n');
    expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'paragraph', 'paragraph']);
  });

  it('leaves a column outside any list as the paragraph it is', async () => {
    const blocks = await markdownToBlocks(editor, '::::column\n\nOne.\n');
    expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'paragraph']);
  });

  it('abandons the fold entirely when a container is never closed', async () => {
    const blocks = await markdownToBlocks(
      editor,
      ':::columns\n::::column\nLeft.\n::::\n\nAnd then nothing closes the list.\n',
    );
    expect(blocks.every((b) => b.type === 'paragraph')).toBe(true);
    expect(blocks.map((b) => (b.content as { text: string }[])[0]?.text)).toContain('Left.');
  });

  /* `:::` inside a fence is somebody's example of this very syntax. Promoting
     it would silently delete lines from a code sample. */
  it('does not read markers inside a code fence', async () => {
    const sample = '```markdown\n:::columns\n::::column\n::::\n:::\n```\n';
    const blocks = await markdownToBlocks(editor, sample);
    expect(blocks.map((b) => b.type)).toEqual(['codeBlock']);
    expect(await roundTrip(sample)).toBe(sample);
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

describe('spliceTitleIntoBlocks', () => {
  const load = async (ed: BlockNoteEditor, md: string) => {
    ed.replaceBlocks(ed.document, await markdownToBlocks(ed, md));
  };

  it('rewrites the first H1 block in place, keeping the rest', async () => {
    const ed = BlockNoteEditor.create();
    await load(ed, '# Old title\n\nBody stays.\n');
    spliceTitleIntoBlocks(ed, 'New title');
    expect(await blocksToMarkdown(ed)).toBe('# New title\n\nBody stays.\n');
  });

  it('ignores pseudo-H1s inside code fences (parity with replace_h1)', async () => {
    const ed = BlockNoteEditor.create();
    await load(ed, '```\n# not a heading\n```\n\n# Real title\n');
    spliceTitleIntoBlocks(ed, 'Renamed');
    // Bare fences pick up BlockNote's default `text` language tag — the same
    // accepted formatting normalization as bullets and table padding.
    expect(await blocksToMarkdown(ed)).toBe('```text\n# not a heading\n```\n\n# Renamed\n');
  });

  it('inserts an H1 at the top when the document has none', async () => {
    const ed = BlockNoteEditor.create();
    await load(ed, 'Just a paragraph.\n');
    spliceTitleIntoBlocks(ed, 'Added title');
    expect(await blocksToMarkdown(ed)).toBe('# Added title\n\nJust a paragraph.\n');
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
