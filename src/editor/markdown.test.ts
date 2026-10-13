// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';
import { BlockNoteEditor, defaultBlockSpecs } from '@blocknote/core';
import { getDefaultSlashMenuItems } from '@blocknote/core/extensions';
import {
  blocksToMarkdown,
  escapeMarkerLines,
  formatAiMarker,
  isLossyImport,
  markdownToBlocks,
  normalizeParsedBlocks,
  parseAiMarker,
  spliceTitleIntoBlocks,
  unwrapReplyFence,
} from './markdown';
import { cerebroSchema, type CerebroEditor } from './MarkdownEditor';
import { splitFrontmatter } from '@/lib/mockParse';

// The app schema, not the default one: markdownToBlocks promotes chip text
// (wikilinks, 📅 dates, [^citations]) into custom inline nodes that only exist
// there.
let editor: CerebroEditor;
beforeAll(() => {
  editor = BlockNoteEditor.create({ schema: cerebroSchema }) as CerebroEditor;
});

const roundTrip = async (md: string) =>
  blocksToMarkdown(editor, await markdownToBlocks(editor, md));

/** The demo vault's concepts, read the way the mock backend seeds them. */
const KNOWLEDGE = import.meta.glob('/demo-vault/knowledge/**/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/** A concept's body as the editor receives it: frontmatter off, like read_note. */
const knowledgeBody = (path: string): string =>
  splitFrontmatter(KNOWLEDGE[path] ?? '').body.replace(/^\n+/, '');

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
    for (const body of ['view: shelf', 'database:', 'not yaml: [', '- a list']) {
      const blocks = await markdownToBlocks(editor, fence(body));
      expect(blocks.map((b) => b.type)).toEqual(['codeBlock']);
    }
  });

  /**
   * `/database` inserts the picker before anything is chosen, and the page
   * saves on a debounce. That unset block reaches disk as an EMPTY fence and
   * must come back as the picker: written as `database: `, it came back a
   * code block the picker could never return from. An empty body holds no
   * text, so promoting it cannot replace anything anyone typed.
   */
  it('round-trips an unset block through the empty fence', async () => {
    const blocks = await markdownToBlocks(editor, fence(''));
    expect(blocks.map((b) => b.type)).toEqual(['database']);
    expect(blocks[0].props).toMatchObject({ database: '', view: '' });
    const saved = await roundTrip(fence(''));
    expect(await roundTrip(saved)).toBe(saved);
    const reloaded = await markdownToBlocks(editor, saved);
    expect(reloaded.map((b) => b.type)).toEqual(['database']);
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

  /* Only a hand-edited file puts text between two columns, and it lands in
     the row itself. It used to be written back as an EMPTY column — the row's
     marker, a column's, and the text nowhere (M53.9 found it). */
  it('keeps text a hand-edited row holds between its columns', async () => {
    const md = ':::columns\nStray words.\n\n::::column\nLeft.\n::::\n:::\n';
    const blocks = await markdownToBlocks(editor, md);
    expect(blocks[0].children.map((c: { type: string }) => c.type)).toEqual([
      'paragraph',
      'column',
    ]);
    expect(await roundTrip(md)).toBe(md);
  });
});

/** A headless editor holding `blocks`, the way the page holds them. */
const holding = (blocks: unknown[]): CerebroEditor => {
  const live = BlockNoteEditor.create({ schema: cerebroSchema }) as CerebroEditor;
  live.replaceBlocks(live.document, blocks as never);
  return live;
};

/*
 * The AI block (M53.9). It had no carrier: a save rendered it, so the file got
 * its chrome — MEASURED in Chromium, the question glued to the "Answer"
 * button's label in one paragraph, the block's type and props gone — and a
 * save inside the unmount flush wrote nothing of it at all. On disk it is a
 * `:::ai` directive container now, the column's spelling, with the answer
 * inside as ordinary markdown.
 */
describe('the :::ai container', () => {
  const ANSWERED = [
    'Before.',
    '',
    ':::ai{prompt="The open questions in this document" generated="2026-10-12"}',
    '* Who owns the migration?',
    '',
    '* When does the freeze start?',
    '',
    '```ts',
    "const freeze = '2026-11-02';",
    '```',
    ':::',
    '',
    'After.',
    '',
  ].join('\n');

  it('reads the container as an AI block holding its answer', async () => {
    const blocks = await markdownToBlocks(editor, ANSWERED);
    expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'ai', 'paragraph']);
    expect(blocks[1].props).toEqual({
      prompt: 'The open questions in this document',
      generated: '2026-10-12',
    });
    expect(blocks[1].children.map((c: { type: string }) => c.type)).toEqual([
      'bulletListItem',
      'bulletListItem',
      'codeBlock',
    ]);
  });

  it('round-trips byte for byte, and the second save is the first', async () => {
    const once = await roundTrip(ANSWERED);
    expect(once).toBe(ANSWERED);
    expect(await roundTrip(once)).toBe(once);
  });

  /* The order a person meets it in: a block on the page, saved, opened, and
     saved again. */
  it('saves a live block, opens it as the same block, and saves the same bytes', async () => {
    const live = holding([
      {
        type: 'ai',
        props: { prompt: 'Summarise "the plan"', generated: '2026-10-12' },
        children: [
          { type: 'bulletListItem', content: 'Ship the [[kickoff]] notes first' },
          { type: 'codeBlock', props: { language: 'ts' }, content: 'const x = 1;' },
        ],
      },
    ]);
    const saved = await blocksToMarkdown(live);
    expect(saved).toBe(
      [
        ':::ai{prompt="Summarise \\"the plan\\"" generated="2026-10-12"}',
        '* Ship the [[kickoff]] notes first',
        '',
        '```ts',
        'const x = 1;',
        '```',
        ':::',
        '',
      ].join('\n'),
    );
    const reopened = await markdownToBlocks(live, saved);
    expect(reopened).toHaveLength(1);
    expect(reopened[0].props).toEqual({ prompt: 'Summarise "the plan"', generated: '2026-10-12' });
    live.replaceBlocks(live.document, reopened);
    expect(await blocksToMarkdown(live)).toBe(saved);
  });

  it("never writes the block's chrome", async () => {
    for (const generated of ['', '2026-10-12']) {
      const saved = await blocksToMarkdown(
        holding([
          {
            type: 'ai',
            props: { prompt: 'What changed?', generated },
            children: [{ type: 'paragraph', content: 'The freeze moved.' }],
          },
        ]),
      );
      // The run button's two labels and the provenance line under it.
      expect(saved).not.toMatch(/Recompute|Answer|Working…/);
      expect(saved.split('\n')[0]).toBe(formatAiMarker(3, { prompt: 'What changed?', generated }));
    }
  });

  /* What `/` leaves before anything is asked is a block too, and a page that
     saves on a debounce writes it. */
  it('round-trips a block nobody has asked anything yet', async () => {
    const saved = await blocksToMarkdown(holding([{ type: 'ai' }]));
    expect(saved).toBe(':::ai\n:::\n');
    const blocks = await markdownToBlocks(editor, saved);
    expect(blocks.map((b) => b.type)).toEqual(['ai']);
    expect(await roundTrip(saved)).toBe(saved);
  });

  /* A question is free text, and both halves of the round trip read text as
     markdown: emphasis, inline code, HTML, escapes, chips, a run of spaces.
     The opening line goes round both, so every one of these comes back. */
  it('keeps a question the parser would read as markdown exactly as asked', async () => {
    const prompt =
      'Why *this*, _that_ and `code`? <b>bold</b> &amp; [[kickoff]] [^src] 📅 2026-08-01 ' +
      '"quoted" back\\slash  two  spaces';
    const saved = await blocksToMarkdown(holding([{ type: 'ai', props: { prompt } }]));
    const [reopened] = await markdownToBlocks(editor, saved);
    expect(reopened.type).toBe('ai');
    expect(reopened.props.prompt).toBe(prompt);
    expect(await roundTrip(saved)).toBe(saved);
  });

  /* `JSON.stringify` writes U+2028 and U+2029 as they are, and those end a line
     for the opening line's reader: the block reopened as paragraphs. They are
     written escaped, and JSON reads the escape back. */
  it('keeps a question holding a line or paragraph separator on its one line', async () => {
    const prompt = 'First part\u2028second part\u2029third part';
    const saved = await blocksToMarkdown(
      holding([
        { type: 'ai', props: { prompt }, children: [{ type: 'paragraph', content: 'A.' }] },
      ]),
    );
    expect(saved).toBe(':::ai{prompt="First part\\u2028second part\\u2029third part"}\nA.\n:::\n');
    const [reopened] = await markdownToBlocks(editor, saved);
    expect(reopened.type).toBe('ai');
    expect(reopened.props.prompt).toBe(prompt);
    expect(await roundTrip(saved)).toBe(saved);
  });

  it("is ordinary text in an answer that only mentions ':::'", async () => {
    const md =
      ':::ai{prompt="How do containers close?"}\nWith a line of ::: under the last block.\n:::\n';
    const [block] = await markdownToBlocks(editor, md);
    expect(block.children[0].content[0].text).toBe('With a line of ::: under the last block.');
    expect(await roundTrip(md)).toBe(md);
  });

  /* An answer may hold a line that is nothing but `:::` — an example, say. Read
     back bare, that line would close the block early and spill the rest of
     the answer below it. It is text, so it is written escaped. */
  it("escapes a line of ':::' in its answer, and keeps its own depth", async () => {
    const live = holding([
      {
        type: 'ai',
        props: { prompt: 'Show the syntax' },
        children: [
          { type: 'paragraph', content: 'A container closes with' },
          { type: 'paragraph', content: ':::' },
          { type: 'paragraph', content: 'on a line of its own.' },
        ],
      },
    ]);
    const saved = await blocksToMarkdown(live);
    expect(saved).toBe(
      ':::ai{prompt="Show the syntax"}\nA container closes with\n\n\\:::\n\non a line of its own.\n:::\n',
    );
    const reopened = await markdownToBlocks(editor, saved);
    expect(reopened.map((b) => b.type)).toEqual(['ai']);
    expect(
      reopened[0].children.map((c: { content: { text: string }[] }) => c.content[0].text),
    ).toEqual(['A container closes with', ':::', 'on a line of its own.']);
    expect(await roundTrip(saved)).toBe(saved);
  });

  /* A close the FILE holds inside an answer is a marker the fold could not
     use: it is kept, written back as the marker it is, and the block steps
     its own markers past it, the way a code fence lengthens past the
     backticks inside it. */
  it('steps its markers past a close the file holds in its answer', async () => {
    const md = '::::ai{prompt="Show the syntax"}\nBefore.\n:::\n\nAfter.\n::::\n';
    const [block] = await markdownToBlocks(editor, md);
    expect(block.type).toBe('ai');
    expect(block.children.map((c: { content: { text: string }[] }) => c.content[0].text)).toEqual([
      'Before.',
      ':::',
      'After.',
    ]);
    expect(await roundTrip(md)).toBe(md);
  });

  it('sits in a column as an AI block, one marker deeper than the column', async () => {
    const md = [
      ':::columns',
      '::::column',
      ':::::ai{prompt="Summarise the left" generated="2026-10-12"}',
      '* One point',
      ':::::',
      '::::',
      '::::column',
      'Right.',
      '::::',
      ':::',
      '',
    ].join('\n');
    const blocks = await markdownToBlocks(editor, md);
    const ai = blocks[0].children[0].children[0];
    expect(ai.type).toBe('ai');
    expect(ai.props).toEqual({ prompt: 'Summarise the left', generated: '2026-10-12' });
    expect(ai.children.map((c: { type: string }) => c.type)).toEqual(['bulletListItem']);
    const once = await roundTrip(md);
    expect(once).toBe(md);
    expect(await roundTrip(once)).toBe(once);
  });

  it('holds a column layout and another AI block in its answer', async () => {
    const md = [
      ':::ai{prompt="outer"}',
      'Intro.',
      '',
      '::::ai{prompt="inner"}',
      'Inner answer.',
      '::::',
      '',
      '::::columns',
      ':::::column',
      'Left.',
      ':::::',
      ':::::column',
      'Right.',
      ':::::',
      '::::',
      ':::',
      '',
    ].join('\n');
    const [outer] = await markdownToBlocks(editor, md);
    expect(outer.children.map((c: { type: string }) => c.type)).toEqual([
      'paragraph',
      'ai',
      'columnList',
    ]);
    expect(await roundTrip(md)).toBe(md);
  });

  /* Strict, like the column markers: anything the block could not carry back
     out is not a marker, and its lines stay the text they are. Written in
     the tight form a save gives a stray close, so the bytes are held too. */
  it.each([
    ':::ai{prompt="x" mood="y"}',
    ':::ai{prompt="x" prompt="y"}',
    ':::ai{prompt=x}',
    ':::ai{prompt="unterminated}',
    ':::ai{prompt="x"} and more',
    ':::aim{prompt="x"}',
    ':::assistant',
  ])('leaves %s and the lines after it as the text they are', async (line) => {
    const md = `${line}\n\nThe answer.\n:::\n`;
    const blocks = await markdownToBlocks(editor, md);
    expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'paragraph', 'paragraph']);
    expect(blocks.map((b) => (b.content as { text: string }[])[0].text)).toEqual([
      line,
      'The answer.',
      ':::',
    ]);
    expect(await roundTrip(md)).toBe(md);
  });

  /* Hand-written tight, a line that is not a marker is not lifted out, so the
     parser reads it into one paragraph with the line under it — and every
     word stays, the soft break becoming the hard one M2 writes for any
     paragraph. */
  it('keeps every word of a malformed marker written tight against its answer', async () => {
    const md = ':::ai{prompt="x" mood="y"}\nThe answer.\n:::\n';
    const blocks = await markdownToBlocks(editor, md);
    expect(JSON.stringify(blocks)).not.toContain('"type":"ai"');
    expect((blocks[0].content as { text: string }[])[0].text).toBe(
      ':::ai{prompt="x" mood="y"}\nThe answer.',
    );
    const once = await roundTrip(md);
    expect(once).toBe(':::ai{prompt="x" mood="y"}\\\nThe answer.\n:::\n');
    expect(await roundTrip(once)).toBe(once);
  });

  /* An opening line with no close is the asymmetric tolerance the columns
     keep: nothing is folded, and the line is the text it was — as written,
     not as the markdown parser would have read it. */
  it('leaves an AI block that never closes as the text it was', async () => {
    const md = ':::ai{prompt="What is *left*?"}\nNever closed.\n';
    const blocks = await markdownToBlocks(editor, md);
    expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'paragraph']);
    expect(blocks[0].content).toEqual([
      { type: 'text', text: ':::ai{prompt="What is *left*?"}', styles: {} },
    ]);
    expect(await roundTrip(md)).toBe(md);
  });

  it('does not read a marker inside a code fence', async () => {
    const sample = '```markdown\n:::ai{prompt="x"}\nAn example.\n:::\n```\n';
    const blocks = await markdownToBlocks(editor, sample);
    expect(blocks.map((b) => b.type)).toEqual(['codeBlock']);
    expect(await roundTrip(sample)).toBe(sample);
  });
});

const textsOf = (blocks: { content?: { text?: string }[] }[]): (string | undefined)[] =>
  blocks.map((b) => b.content?.[0]?.text);

/*
 * Where fenced code ends (M53.9). Every line pass here used to flip "in a
 * fence" on any line that started with ``` or ~~~, so a code block holding a
 * lone fence line — which the serializer wraps in a longer fence — left the
 * rest of the page read as code. MEASURED: every AI block below one came back
 * as three paragraphs, its question re-read as markdown, and the next save
 * wrote it as JSON that no longer parsed. The other way round, an example of
 * the carrier inside nested fences was lifted out of its code, and the code
 * block showed the placeholder instead.
 */
describe('fenced code and the containers below it', () => {
  it.each([
    ['markdown', 'Open a fence with\n```\nand forget to close it'],
    ['markdown', 'Close a fence with\n```'],
    ['bash', 'cat <<EOF\n~~~\nEOF'],
  ])(
    'keeps an AI block whole below a %s block holding a lone fence line',
    async (language, code) => {
      const live = holding([
        { type: 'codeBlock', props: { language }, content: code },
        {
          type: 'ai',
          props: { prompt: 'Summarise "the plan" for *Q4*', generated: '2026-10-12' },
          children: [{ type: 'paragraph', content: 'Because.' }],
        },
      ]);
      const saved = await blocksToMarkdown(live);
      expect(saved).toContain(
        '\n:::ai{prompt="Summarise \\"the plan\\" for *Q4*" generated="2026-10-12"}\nBecause.\n:::\n',
      );
      const reopened = await markdownToBlocks(editor, saved);
      expect(reopened.map((b) => b.type)).toEqual(['codeBlock', 'ai']);
      expect(reopened[0].content[0].text).toBe(code);
      expect(reopened[1].props.prompt).toBe('Summarise "the plan" for *Q4*');
      expect(await blocksToMarkdown(editor, reopened)).toBe(saved);
    },
  );

  it('reads an example of the carrier inside nested fences as the code it is', async () => {
    const md =
      'How the file looks:\n\n````markdown\n```markdown\n:::ai{prompt="Summarise"}\nThe answer.\n:::\n```\n````\n';
    const blocks = await markdownToBlocks(editor, md);
    expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'codeBlock']);
    expect(blocks[1].content[0].text).toBe(
      '```markdown\n:::ai{prompt="Summarise"}\nThe answer.\n:::\n```',
    );
    const saved = await roundTrip(md);
    expect(saved).toBe(md);
    expect(isLossyImport(md, saved)).toBe(false);
  });

  it('reads a backtick fence inside a tilde fence as code, whatever follows it', async () => {
    const md = '~~~markdown\n```\n:::ai{prompt="x"}\n~~~\n';
    const blocks = await markdownToBlocks(editor, md);
    expect(blocks.map((b) => b.type)).toEqual(['codeBlock']);
    expect(blocks[0].content[0].text).toBe('```\n:::ai{prompt="x"}');
    const saved = await roundTrip(md);
    expect(isLossyImport(md, saved)).toBe(false);
    expect(await roundTrip(saved)).toBe(saved);
  });

  /* The fence reader reads lines, not containers, so it can still disagree
     with the parser: four spaces at the top of a page are indented code to
     CommonMark and a fence to the reader, which then closes it on the bare
     fence below — the one the parser opens, and never closes. The AI line
     after it is lifted out of what the parser reads as code; it must go back
     into that code exactly, and no placeholder may reach the page or the
     disk. */
  it('puts a lifted line back into code the parser read it into', async () => {
    const md = '    ```\nx\n```\n:::ai{prompt="x"}\nanswer\n';
    const blocks = await markdownToBlocks(editor, md);
    expect(blocks.map((b) => b.type)).toEqual(['codeBlock', 'paragraph', 'codeBlock']);
    expect(blocks[2].content[0].text).toBe(':::ai{prompt="x"}\nanswer');
    expect(JSON.stringify(blocks)).not.toContain('cerebro-line-');
    expect(await blocksToMarkdown(editor, blocks)).not.toContain('cerebro-line-');
  });

  /* The route a model takes there: a reply that opens and closes with code
     blocks. The old cleanup stripped a fence line from each END of it and
     left the fence in between open. */
  it('keeps both code blocks of a reply that starts and ends with one', async () => {
    const reply = '```sql\nSELECT 1;\n```\n\nThen the totals:\n\n```sql\nSELECT 2;\n```';
    expect(unwrapReplyFence(reply)).toBe(reply);
    const answer = await markdownToBlocks(editor, escapeMarkerLines(unwrapReplyFence(reply)));
    expect(answer.map((b) => b.type)).toEqual(['codeBlock', 'paragraph', 'codeBlock']);
    const page = [
      { type: 'ai', props: { prompt: 'The queries' }, children: answer },
      {
        type: 'ai',
        props: { prompt: 'Who signs off on "the plan"?' },
        children: [{ type: 'paragraph', content: 'Maya.' }],
      },
    ];
    const saved = await blocksToMarkdown(editor, page as never);
    const reopened = await markdownToBlocks(editor, saved);
    expect(reopened.map((b) => b.type)).toEqual(['ai', 'ai']);
    expect(reopened[1].props.prompt).toBe('Who signs off on "the plan"?');
    expect(await blocksToMarkdown(editor, reopened)).toBe(saved);
  });
});

/*
 * Text that only looks like a marker (M53.9). It was written bare, and the
 * next open read it as one: MEASURED, an answer quoting a `:::columns` line
 * reopened as nothing but paragraphs, the AI block and the page's real layout
 * both gone, because an opening marker that never closes abandons the fold
 * for the whole page. It is written escaped now. The FILE's own markers are
 * not text, and a page whose fold was abandoned writes them back as it had
 * them.
 */
describe('text that only looks like a marker', () => {
  it.each([':::', ':::columns', '::::column width=2', ':::ai', ':::ai{prompt="x"}'])(
    'writes %s typed as a paragraph escaped, and reads it back as that text',
    async (text) => {
      const live = holding([
        { type: 'paragraph', content: text },
        { type: 'ai', props: { prompt: 'Q' }, children: [{ type: 'paragraph', content: 'A' }] },
      ]);
      const saved = await blocksToMarkdown(live);
      expect(saved).toBe(`\\${text}\n\n:::ai{prompt="Q"}\nA\n:::\n`);
      const reopened = await markdownToBlocks(editor, saved);
      expect(reopened.map((b) => b.type)).toEqual(['paragraph', 'ai']);
      expect(reopened[0].content[0].text).toBe(text);
      expect(await blocksToMarkdown(editor, reopened)).toBe(saved);
    },
  );

  it('escapes a marker line that follows a break inside a paragraph', async () => {
    const saved = await blocksToMarkdown(
      holding([{ type: 'paragraph', content: 'The layout:\n:::columns' }]),
    );
    expect(saved).toBe('The layout:\\\n\\:::columns\n');
    const reopened = await markdownToBlocks(editor, saved);
    expect(reopened.map((b) => b.type)).toEqual(['paragraph']);
    expect(reopened[0].content[0].text).toBe('The layout:\n:::columns');
    expect(await blocksToMarkdown(editor, reopened)).toBe(saved);
  });

  it('keeps the page whole when an answer quotes a marker', async () => {
    const reply = 'The page uses a layout:\n\n:::columns\n\nwith two columns.';
    const answer = await markdownToBlocks(editor, escapeMarkerLines(reply));
    expect(textsOf(answer)).toEqual(['The page uses a layout:', ':::columns', 'with two columns.']);
    const page = await markdownToBlocks(
      editor,
      ':::ai{prompt="Q"}\nOld.\n:::\n\n:::columns\n::::column\nL\n::::\n::::column\nR\n::::\n:::\n',
    );
    page[0].children = answer;
    const saved = await blocksToMarkdown(editor, page);
    expect(saved).toContain('\n\\:::columns\n');
    const reopened = await markdownToBlocks(editor, saved);
    expect(reopened.map((b) => b.type)).toEqual(['ai', 'columnList']);
    expect(textsOf(reopened[0].children)).toEqual(textsOf(answer));
    expect(await blocksToMarkdown(editor, reopened)).toBe(saved);
  });

  /* A stray `:::columns` abandons the fold, and every marker on the page is
     shown as the text it is. Written back escaped, one stray line would have
     turned every container on the page into text for good; written back
     through the serializer, the AI line lost a space from its question. */
  it('writes back the markers of a page whose fold was abandoned, as the file had them', async () => {
    const prompt = 'two  spaces, *stars* and "quotes"';
    const md = `:::ai{prompt=${JSON.stringify(prompt)}}\nAn answer.\n:::\n\n:::columns\nNever closed.\n`;
    const live = holding(await markdownToBlocks(editor, md));
    expect(live.document.every((b) => b.type === 'paragraph')).toBe(true);
    live.insertBlocks(
      [{ type: 'paragraph', content: 'An edit.' }],
      live.document[live.document.length - 1],
      'after',
    );
    const edited = await blocksToMarkdown(live);
    expect(edited).toBe(`${md}\nAn edit.\n`);

    // Once the stray line is gone, the page folds, and the question is as asked.
    const stray = live.document.find((b) => textsOf([b as never])[0] === ':::columns');
    live.removeBlocks([stray!]);
    const fixed = await markdownToBlocks(editor, await blocksToMarkdown(live));
    expect(fixed.map((b) => b.type)).toEqual(['ai', 'paragraph', 'paragraph']);
    expect(fixed[0].props.prompt).toBe(prompt);
  });

  it('keeps a stray close the file holds as the marker it is', async () => {
    const md = 'One.\n:::\n\nTwo.\n';
    const blocks = await markdownToBlocks(editor, md);
    expect(textsOf(blocks)).toEqual(['One.', ':::', 'Two.']);
    expect(await roundTrip(md)).toBe(md);
  });
});

/*
 * A paragraph that reads as a marker only once its link, chip or style is
 * dropped (M53.9). The fold read marker text with everything but plain text
 * dropped, so each of these was a marker: MEASURED, a code span of
 * `:::columns` opened a live layout and a code span of `:::` ended an AI
 * block early, and a paragraph the fold kept was saved as the bare marker,
 * its link or chip deleted. A marker is plain text and nothing else.
 */
describe('a paragraph that is more than plain marker text', () => {
  const LOOKALIKES = [
    ['a link after :::', '::: [a link](https://example.com)', '"type":"link"'],
    ['bold :::', '**:::**', '"bold":true'],
    ['a code span of :::columns', '`:::columns`', '"code":true'],
    ['a chip after :::', '::: [[kickoff]]', '"type":"wikilink"'],
  ] as const;

  it.each(LOOKALIKES)(
    'round-trips %s byte for byte, beside a layout and inside one',
    async (_name, line, carried) => {
      const md = [
        'Before.',
        '',
        line,
        '',
        ':::columns',
        '::::column',
        'Left.',
        '',
        line,
        '::::',
        ':::',
        '',
        'After.',
        '',
      ].join('\n');
      const blocks = await markdownToBlocks(editor, md);
      expect(blocks.map((b) => b.type)).toEqual([
        'paragraph',
        'paragraph',
        'columnList',
        'paragraph',
      ]);
      const column = blocks[2].children[0];
      expect(column.type).toBe('column');
      expect(column.children.map((c: { type: string }) => c.type)).toEqual([
        'paragraph',
        'paragraph',
      ]);
      expect(JSON.stringify(blocks[1].content)).toContain(carried);
      expect(JSON.stringify(column.children[1].content)).toContain(carried);
      const once = await roundTrip(md);
      expect(once).toBe(md);
      expect(await roundTrip(once)).toBe(once);
    },
  );

  it.each(LOOKALIKES)(
    'keeps %s in an answer, and the block whole',
    async (_name, line, carried) => {
      const md = `:::ai{prompt="Q"}\nBefore.\n\n${line}\n\nAfter.\n:::\n`;
      const blocks = await markdownToBlocks(editor, md);
      expect(blocks.map((b) => b.type)).toEqual(['ai']);
      expect(blocks[0].children.map((c: { type: string }) => c.type)).toEqual([
        'paragraph',
        'paragraph',
        'paragraph',
      ]);
      expect(JSON.stringify(blocks[0].children[1].content)).toContain(carried);
      expect(await roundTrip(md)).toBe(md);
    },
  );

  it('keeps a code span of :::columns a code span, with a close below it', async () => {
    const md = '`:::columns`\n\nWords.\n:::\n';
    const blocks = await markdownToBlocks(editor, md);
    expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'paragraph', 'paragraph']);
    expect(blocks[0].content).toEqual([
      { type: 'text', text: ':::columns', styles: { code: true } },
    ]);
    expect(await roundTrip(md)).toBe(md);
  });

  it('does not end an AI block at a code span of :::', async () => {
    const md =
      ':::ai{prompt="How do containers close?"}\nWith a line of\n\n`:::`\n\nunder the last block.\n:::\n';
    const blocks = await markdownToBlocks(editor, md);
    expect(blocks.map((b) => b.type)).toEqual(['ai']);
    expect(textsOf(blocks[0].children)).toEqual(['With a line of', ':::', 'under the last block.']);
    expect(blocks[0].children[1].content).toEqual([
      { type: 'text', text: ':::', styles: { code: true } },
    ]);
    expect(await roundTrip(md)).toBe(md);
  });

  /* A marker the file holds is kept, and written back as it was — until
     somebody makes it more than plain text. Then it is text, and its link,
     chip or style is written with it. */
  it.each([
    [
      [
        { type: 'text', text: '::: ', styles: {} },
        { type: 'link', href: 'https://example.com', content: 'a link' },
      ],
      '::: [a link](https://example.com)',
    ],
    [[{ type: 'text', text: ':::', styles: { bold: true } }], '**:::**'],
    [
      [
        { type: 'text', text: '::: ', styles: {} },
        { type: 'wikilink', props: { target: 'kickoff', alias: '' } },
      ],
      '::: [[kickoff]]',
    ],
  ])('writes a kept marker edited to %j as the text it now is', async (content, written) => {
    const live = holding(await markdownToBlocks(editor, 'One.\n:::\n\nTwo.\n'));
    const kept = live.document[1];
    live.updateBlock(kept, { content: content as never });
    expect(live.document[1].id).toBe(kept.id);
    const saved = await blocksToMarkdown(live);
    expect(saved).toBe(`One.\n\n${written}\n\nTwo.\n`);
    expect(await roundTrip(saved)).toBe(saved);
  });
});

describe('unwrapReplyFence / escapeMarkerLines', () => {
  it('takes off one fence wrapped round the whole reply', () => {
    expect(unwrapReplyFence('```markdown\n* one\n* two\n```')).toBe('* one\n* two');
    expect(unwrapReplyFence('\n~~~\nPlain.\n~~~\n')).toBe('Plain.');
    expect(unwrapReplyFence('````\n```js\nx\n```\n````')).toBe('```js\nx\n```');
  });

  /* A reply wrapped in a markdown fence holds code blocks of its own, and the
     first of them closes the wrapper as CommonMark reads it. The cleanup
     before M53.9 took the wrapper off anyway, and so does this. */
  it('takes off a markdown fence round a reply that holds code blocks of its own', async () => {
    const inner = 'Run this:\n\n```js\nconst x = 1;\n```\n\nThen check it.';
    expect(unwrapReplyFence(`\`\`\`markdown\n${inner}\n\`\`\``)).toBe(inner);
    expect(unwrapReplyFence(`\n\`\`\`MD\n${inner}\n\`\`\`\n`)).toBe(inner);
    expect(unwrapReplyFence(`~~~Markdown\n${inner}\n~~~`)).toBe(inner);
    const endsInCode = 'The totals:\n\n```sql\nSELECT 2;\n```';
    expect(unwrapReplyFence(`\`\`\`md\n${endsInCode}\n\`\`\``)).toBe(endsInCode);
    const answer = await markdownToBlocks(
      editor,
      escapeMarkerLines(unwrapReplyFence(`\`\`\`markdown\n${inner}\n\`\`\``)),
    );
    expect(answer.map((b) => b.type)).toEqual(['paragraph', 'codeBlock', 'paragraph']);
  });

  it('leaves every other reply as it came, trimmed', () => {
    for (const reply of [
      'No fence at all.',
      '```sql\nSELECT 1;\n```\n\nThen the totals:\n\n```sql\nSELECT 2;\n```',
      '```markdown\n# An example\n```\n\nThen the totals:\n\n```sql\nSELECT 2;\n```',
      '```\nnever closed',
      '```\ncode\n```\nand words after it',
      '```markdown\ncode\n```\nand words after it',
      '```markdown\nRun this:\n```js\nx\n```\n~~~',
      '````markdown\nRun this:\n```js\nx\n```',
      'Words, then\n```\ncode\n```',
    ]) {
      expect(unwrapReplyFence(` ${reply}\n`)).toBe(reply);
    }
  });

  it('escapes the marker lines outside fenced code, and nothing else', () => {
    const md = [
      'Text',
      ':::columns',
      '```markdown',
      ':::',
      '```',
      '  :::',
      '\\:::',
      ':::ai{prompt="x"}',
      ':::ai{prompt="x" mood="y"}',
    ].join('\n');
    expect(escapeMarkerLines(md).split('\n')).toEqual([
      'Text',
      '\\:::columns',
      '```markdown',
      ':::',
      '```',
      '  :::',
      '\\:::',
      '\\:::ai{prompt="x"}',
      ':::ai{prompt="x" mood="y"}',
    ]);
  });
});

describe('parseAiMarker / formatAiMarker', () => {
  it('writes only what is set, in one order', () => {
    expect(formatAiMarker(3, { prompt: '', generated: '' })).toBe(':::ai');
    expect(formatAiMarker(4, { prompt: 'Q', generated: '' })).toBe('::::ai{prompt="Q"}');
    expect(formatAiMarker(3, { prompt: '', generated: '2026-10-12' })).toBe(
      ':::ai{generated="2026-10-12"}',
    );
    expect(formatAiMarker(3, { prompt: 'Q', generated: '2026-10-12' })).toBe(
      ':::ai{prompt="Q" generated="2026-10-12"}',
    );
  });

  it('reads back exactly what it writes', () => {
    for (const prompt of [
      'plain',
      'a "quote"',
      'back\\slash',
      'two\nlines',
      'tab\there',
      '}{',
      'x"} trailing',
      'line\u2028separator',
      'paragraph\u2029separator',
      '',
    ]) {
      const line = formatAiMarker(5, { prompt, generated: '2026-10-12' });
      expect(line).not.toMatch(/[\n\u2028\u2029]/u);
      expect(parseAiMarker(line)).toEqual({ depth: 5, prompt, generated: '2026-10-12' });
    }
  });

  it('reads the attributes in either order, and an empty brace pair as none', () => {
    expect(parseAiMarker(':::ai{generated="2026-10-12" prompt="Q"}')).toEqual({
      depth: 3,
      prompt: 'Q',
      generated: '2026-10-12',
    });
    expect(parseAiMarker(':::ai{}')).toEqual({ depth: 3, prompt: '', generated: '' });
    expect(parseAiMarker('::ai{prompt="too shallow"}')).toBeNull();
    expect(parseAiMarker(' :::ai')).toBeNull();
  });
});

/*
 * Every block the `/` menu can insert, and whether a save keeps it (M53.9).
 *
 * The AI block came back from every save as a paragraph of its own chrome,
 * and nothing said so: the lossy-import check compares letters and digits,
 * and every word was still there. This holds the whole menu to the question
 * that would have caught it — does a block reopen as the block it was, and
 * does a second save write the bytes of the first?
 *
 * Not here: the `/` menu's Date entry inserts an inline chip (the chip tests
 * above hold those), and a template inserts the markdown it is made of.
 */
describe('every block the / menu inserts survives a save, or is named', () => {
  /**
   * The ones that do not, today. EDITOR-1
   * (docs/superpowers/specs/2026-10-12-macro-reference/03-editor.md) is the
   * work that gives each one a carrier. The list can only shrink: an entry
   * that starts surviving fails below until it is taken off.
   */
  const KNOWN_LOSSY: Record<string, string> = {
    toggle_list: 'saves as a bullet and reopens as one',
    toggle_heading: 'saves as a heading and reopens without its toggle',
    toggle_heading_2: 'saves as a heading and reopens without its toggle',
    toggle_heading_3: 'saves as a heading and reopens without its toggle',
    table: 'has no header row, which a markdown table must — the first save writes an empty one',
    image: 'reopens named "BlockNote image", the alt text the serializer invents',
    audio: 'saves as a bare link that reopens as an empty paragraph',
    file: 'saves as an autolink that reopens as a paragraph holding a link',
  };

  /** Emoji opens a picker that inserts a character, not a block. */
  const NOT_A_BLOCK = new Set(['emoji']);

  /** A file block needs a file to be anything at all. */
  const MEDIA_URL: Record<string, string> = {
    image: 'https://example.com/plan.png',
    video: 'https://example.com/walkthrough.mp4',
    audio: 'https://example.com/standup.mp3',
    file: 'https://example.com/contract.pdf',
  };

  /** Cerebro's own blocks, each the way the `/` menu leaves it once used. */
  const OURS: Record<string, unknown[]> = {
    ai: [
      {
        type: 'ai',
        props: { prompt: 'The open questions', generated: '2026-10-12' },
        children: [{ type: 'paragraph', content: 'Who owns the migration?' }],
      },
    ],
    callout: [{ type: 'callout', props: { kind: 'warning' }, content: 'Mind the gap' }],
    mermaid: [{ type: 'mermaid', props: { code: 'flowchart TD\n  A --> B' } }],
    database: [{ type: 'database', props: { database: 'Reading list', view: 'shelf' } }],
    // A column only exists in a row, so the row is the column's fixture too.
    columnList: [
      {
        type: 'columnList',
        children: [
          { type: 'column', props: { width: 1 }, children: [{ type: 'paragraph', content: 'L' }] },
          { type: 'column', props: { width: 2 }, children: [{ type: 'paragraph', content: 'R' }] },
        ],
      },
    ],
  };
  OURS.column = OURS.columnList;

  const withoutIds = (blocks: unknown[]): unknown[] =>
    blocks.map((block) => {
      const { id: _id, children, ...rest } = block as { id: string; children: unknown[] };
      return { ...rest, children: withoutIds(children ?? []) };
    });

  /** One save and one reopen give back the same blocks, and a second save the same bytes. */
  async function survives(blocks: unknown[]): Promise<boolean> {
    const live = BlockNoteEditor.create({ schema: cerebroSchema }) as CerebroEditor;
    live.replaceBlocks(live.document, blocks as never);
    const before = JSON.stringify(withoutIds(live.document));
    const saved = await blocksToMarkdown(live);
    live.replaceBlocks(live.document, await markdownToBlocks(live, saved));
    return (
      JSON.stringify(withoutIds(live.document)) === before &&
      (await blocksToMarkdown(live)) === saved
    );
  }

  /** What one of BlockNote's own entries inserts, run on a fresh page, with words in it. */
  function insertedBy(key: string): unknown[] {
    const live = BlockNoteEditor.create({ schema: cerebroSchema }) as CerebroEditor;
    live.replaceBlocks(live.document, [{ type: 'paragraph' }]);
    live.setTextCursorPosition(live.document[0]);
    getDefaultSlashMenuItems(live)
      .find((item) => item.key === key)
      ?.onItemClick();
    const { type, props } = live.document[0] as { type: string; props: Record<string, unknown> };
    const content = (cerebroSchema.blockSpecs as Record<string, { config: { content: string } }>)[
      type
    ].config.content;
    return [
      {
        type,
        props: type in MEDIA_URL ? { ...props, url: MEDIA_URL[type] } : props,
        ...(content === 'inline' ? { content: 'Some words' } : {}),
        ...(content === 'table'
          ? {
              content: {
                type: 'tableContent',
                rows: [{ cells: ['a', 'b'] }, { cells: ['c', 'd'] }],
              },
            }
          : {}),
      },
    ];
  }

  // The menu's own `getDefaultReactSlashMenuItems` is this list with an icon
  // put on each entry; the core list keeps each entry's key in its type.
  const MENU = getDefaultSlashMenuItems(
    BlockNoteEditor.create({ schema: cerebroSchema }) as CerebroEditor,
  )
    .map((item) => item.key)
    .filter((key) => !NOT_A_BLOCK.has(key));
  const CEREBRO_TYPES = Object.keys(cerebroSchema.blockSpecs).filter(
    (type) => !(type in defaultBlockSpecs),
  );

  it('names only entries the menu has', () => {
    for (const key of Object.keys(KNOWN_LOSSY)) expect(MENU).toContain(key);
  });

  it.each(MENU)("BlockNote's %s entry", async (key) => {
    const lossy = key in KNOWN_LOSSY;
    expect(
      await survives(insertedBy(key)),
      lossy ? `${key} survives a save now: take it off KNOWN_LOSSY` : `${key} lost something`,
    ).toBe(!lossy);
  });

  it.each(CEREBRO_TYPES)("Cerebro's %s block", async (type) => {
    expect(OURS[type], `${type} has no fixture here`).toBeDefined();
    expect(await survives(OURS[type])).toBe(true);
  });
});

// M50.1 — concepts open in this editor now, and OKF cites its sources with
// footnotes. The serializer escapes single brackets, so a saved concept used
// to come back as `\[^id]` — every citation broken, and the lossy-import
// check (letters and digits only) blind to it.
describe('footnote citations', () => {
  const concept =
    'A completed account finished every step.[^kr-onboarding]\n\n' +
    '[^kr-onboarding]: KR — Onboarding completion\n';

  it('round-trips a footnote reference and its definition unescaped', async () => {
    const out = await roundTrip(concept);
    expect(out).toContain('step.[^kr-onboarding]');
    expect(out).toContain('[^kr-onboarding]: KR — Onboarding completion');
    expect(out).not.toContain('\\[');
  });

  it('is stable across a second trip', async () => {
    const once = await roundTrip(concept);
    expect(await roundTrip(once)).toBe(once);
  });

  it('reads a run of definitions and a citation inside code as written', async () => {
    const md = 'Claim.[^a] See `[^not-a-cite]`.\n\n[^a]: First source\n\n[^b]: Second source\n';
    const out = await roundTrip(md);
    expect(out).toContain('Claim.[^a] See `[^not-a-cite]`.');
    expect(out).toContain('[^a]: First source');
    expect(out).toContain('[^b]: Second source');
    expect(isLossyImport(md, out)).toBe(false);
  });

  // M51.5 — the text above is a chip in the editor and the same text on disk.

  it('promotes a reference into a citation chip', async () => {
    const [block] = await markdownToBlocks(editor, 'A claim.[^kr-sync] More.\n');
    expect(block.content).toEqual([
      { type: 'text', text: 'A claim.', styles: {} },
      { type: 'citation', props: { id: 'kr-sync', def: '' } },
      { type: 'text', text: ' More.', styles: {} },
    ]);
  });

  /* OKF writes its definitions one per line with nothing between them, so the
     parser hands over ONE paragraph with a line break before each definition
     after the first — every line start is a place a definition begins. */
  it('promotes a definition on every line of a run, keeping the rest of each line as text', async () => {
    const [block] = await markdownToBlocks(editor, '[^a]: First source\n[^b]: Second source\n');
    expect(block.type).toBe('paragraph');
    expect(block.content).toEqual([
      { type: 'citation', props: { id: 'a', def: '1' } },
      { type: 'text', text: ' First source\n', styles: {} },
      { type: 'citation', props: { id: 'b', def: '1' } },
      { type: 'text', text: ' Second source', styles: {} },
    ]);
  });

  it('reads no citation out of code, styled text, or a wikilink', async () => {
    const md = 'See `[^code]`, *a claim[^styled]*, and [[^linked]].\n\n```text\n[^fenced]\n```\n';
    const blocks = await markdownToBlocks(editor, md);
    expect(JSON.stringify(blocks)).not.toContain('"citation"');
    expect(await roundTrip(md)).toBe(md);
  });

  /* Everything a concept body cites with, at once. The table is written in the
     padding the serializer normalizes every table to (M2), so the whole body
     can be held to byte identity: this is what a saved concept looks like. */
  const BODY = [
    '# Definition',
    '',
    '`failed_syncs / total_sync_attempts`, bucketed hourly.[^syn-project] Never `[^code]`.',
    '',
    '```text',
    'a fence keeps [^fenced] as written',
    '```',
    '',
    '| Window | Behaviour         |',
    '| ------ | ----------------- |',
    '| 0–72h  | Clean merge[^dec] |',
    '',
    'Two sources at once.[^syn-project][^dec] See [[offline-sync-hardening]].',
    '',
    '[^syn-project]: Offline sync hardening',
    '[^dec]: Decision — conflicts are resolved by a person',
    '',
  ].join('\n');

  it('round-trips a concept body byte for byte', async () => {
    const out = await roundTrip(BODY);
    expect(out).toBe(BODY);
    expect(isLossyImport(BODY, out)).toBe(false);
  });

  it('writes the same bytes on a second save', async () => {
    const once = await roundTrip(BODY);
    expect(await roundTrip(once)).toBe(once);
  });

  it('reads the body into chips — a table cell included — and leaves its code as text', async () => {
    const blocks = await markdownToBlocks(editor, BODY);
    const chips = JSON.stringify(blocks).match(/"type":"citation","props":\{[^}]*\}/g);
    expect(chips).toEqual([
      '"type":"citation","props":{"id":"syn-project","def":""}',
      '"type":"citation","props":{"id":"dec","def":""}',
      '"type":"citation","props":{"id":"syn-project","def":""}',
      '"type":"citation","props":{"id":"dec","def":""}',
      '"type":"citation","props":{"id":"syn-project","def":"1"}',
      '"type":"citation","props":{"id":"dec","def":"1"}',
    ]);
    expect(blocks[1].content).toContainEqual({
      type: 'text',
      text: '[^code]',
      styles: { code: true },
    });
    expect(blocks[2].content[0].text).toBe('a fence keeps [^fenced] as written');
  });

  /* The corpus the feature exists for. Several concepts hold a table or a
     numbered list, which the M2 fidelity policy normalizes on any page; the
     rest have nothing BUT prose and citations, and must come back untouched. */
  it.each([
    'metrics/sync-error-rate.md',
    'metrics/webinar-attendance.md',
    'systems/offline-window-pilot.md',
    'systems/pick-queue-drain.md',
  ])('round-trips the demo vault concept %s byte for byte', async (name) => {
    const body = knowledgeBody(`/demo-vault/knowledge/${name}`);
    expect(body).toContain('[^');
    const once = await roundTrip(body);
    expect(once).toBe(body);
    expect(await roundTrip(once)).toBe(once);
  });

  it('writes back every citation of every concept in the demo vault as written', async () => {
    const tokens = (md: string) => md.match(/\[\^[^\]\s]+\]:?/g) ?? [];
    const definitions = (md: string) => md.split('\n').filter((l) => /^\[\^[^\]\s]+\]:/.test(l));
    let cited = 0;
    for (const path of Object.keys(KNOWLEDGE)) {
      const body = knowledgeBody(path);
      if (!body.includes('[^')) continue;
      cited += 1;
      const out = await roundTrip(body);
      expect(tokens(out), path).toEqual(tokens(body));
      expect(definitions(out), path).toEqual(definitions(body));
      expect(out, path).not.toContain('\\[');
    }
    // Not a vacuous pass over a vault that stopped citing anything.
    expect(cited).toBeGreaterThanOrEqual(5);
  });
});

/*
 * M52.1 — a citation INSIDE emphasis. It stays the text it is on disk, and
 * that is a measured decision, not a gap: the tests below hold the bytes, and
 * the last one holds the reason.
 */
describe('citations inside emphasis', () => {
  const chipsIn = (blocks: unknown[]) =>
    JSON.stringify(blocks).match(/"type":"citation","props":\{"id":"[^"]*","def":""\}/g) ?? [];

  it.each([
    'Only *a claim[^id]* here.\n',
    'Some **bold [^id] more** words.\n',
    'A run *a[^x] b[^y]* and ***both[^z]***.\n',
    'Mixed *emphasis[^in]* and plain.[^out]\n\n[^in]: Inside\n[^out]: Outside\n',
  ])('keeps %j byte for byte across two saves', async (md) => {
    const once = await roundTrip(md);
    expect(once).toBe(md);
    expect(await roundTrip(once)).toBe(once);
  });

  /* The corpus with emphasis put round a cited word, as an author would: the
     first reference glued to a plain word is wrapped, in italic and in bold.
     Some concepts hold a table or a numbered list, which the M2 fidelity
     policy normalizes on any page — so what the emphasized body must come back
     as is the plain body's own saved form, wrapped the same way. */
  const CITED_WORD = /(?<![*\w])[A-Za-z][\w.,()-]*\[\^[^\]\s]+\](?![:*])/;
  const wrapCited = (body: string, mark: string): string =>
    body.replace(CITED_WORD, (word) => `${mark}${word}${mark}`);
  const EMPHASIZED = Object.keys(KNOWLEDGE)
    .filter((path) => CITED_WORD.test(knowledgeBody(path)))
    .flatMap((path) =>
      ['*', '**'].map((mark) => [path.replace('/demo-vault/knowledge/', ''), mark] as const),
    );

  it('has concepts to try it on', () => {
    expect(EMPHASIZED.length).toBeGreaterThanOrEqual(8);
  });

  it.each(EMPHASIZED)('round-trips %s with %s round a cited word, twice', async (name, mark) => {
    const plain = knowledgeBody(`/demo-vault/knowledge/${name}`);
    const body = wrapCited(plain, mark);
    const once = await roundTrip(body);
    expect(once).toBe(wrapCited(await roundTrip(plain), mark));
    expect(await roundTrip(once)).toBe(once);
    // The wrapped marker is text; every other reference is still a chip.
    const chips = chipsIn(await markdownToBlocks(editor, body));
    expect(chips).toHaveLength(chipsIn(await markdownToBlocks(editor, plain)).length - 1);
  });

  /* Why it is text (the measurement M52.1 made). A chip CAN carry a mark in
     ProseMirror — but BlockNote's block JSON, which is what the serializer
     reads, has no styles on custom inline content, so the mark is dropped on
     the way out and the marker is written outside the emphasis it was in.
     Keeping it inside would take a second copy of the chip's marks in a prop
     kept in step by hand. If this test ever fails, BlockNote has started
     carrying the mark, and the limit is worth revisiting. */
  it('would lose the emphasis if the marker were a chip', async () => {
    const live = BlockNoteEditor.create({ schema: cerebroSchema }) as CerebroEditor;
    live.replaceBlocks(live.document, [
      { type: 'paragraph', content: [{ type: 'text', text: 'a claim', styles: { italic: true } }] },
    ]);
    const view = live._tiptapEditor.view;
    const { schema } = view.state;
    let at = -1;
    view.state.doc.descendants((node, pos) => {
      if (node.isText && node.text === 'a claim') at = pos + node.nodeSize;
    });
    expect(at).toBeGreaterThan(0);
    const tr = view.state.tr.insert(at, schema.nodes.citation.create({ id: 'id', def: '' }));
    view.dispatch(tr.addMark(at, at + 1, schema.marks.italic.create()));
    let marks: string[] = [];
    view.state.doc.descendants((node) => {
      if (node.type.name === 'citation') marks = node.marks.map((m) => m.type.name);
    });
    expect(marks).toEqual(['italic']);
    const chip = (live.document[0].content as { type: string }[]).find(
      (item) => item.type === 'citation',
    );
    expect(chip).toEqual({ type: 'citation', props: { id: 'id', def: '' } });
    expect(await blocksToMarkdown(live)).toBe('*a claim*[^id]\n');
  });
});

/*
 * M52.4 — the rule is every chip's, not only a citation's. A wikilink, an
 * assignee or a date promoted out of emphasis came back from the serializer
 * outside it, exactly as a citation did, so each stays the text it is there.
 */
describe('chips inside emphasis', () => {
  it.each([
    'See **[[kickoff]]** here.\n',
    'See *the [[kickoff]] notes* here.\n',
    '* [ ] **Ship @[[jane]]** now\n',
    'Due *soon 📅 2026-08-01* ok.\n',
  ])('keeps %j byte for byte across two saves, as text', async (md) => {
    const once = await roundTrip(md);
    expect(once).toBe(md);
    expect(await roundTrip(once)).toBe(once);
    const blocks = JSON.stringify(await markdownToBlocks(editor, md));
    expect(blocks).not.toMatch(/"type":"(wikilink|assignee|due|citation)"/);
  });

  it('still reads the same chips out of the plain text beside it', async () => {
    const md = 'See **bold** then [[kickoff]], @[[jane]] and 📅 2026-08-01.\n';
    const blocks = JSON.stringify(await markdownToBlocks(editor, md));
    for (const type of ['wikilink', 'assignee', 'due'])
      expect(blocks).toContain(`"type":"${type}"`);
    expect(await roundTrip(md)).toBe(md);
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
