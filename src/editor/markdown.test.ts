// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';
import { BlockNoteEditor, defaultBlockSpecs } from '@blocknote/core';
import { getDefaultSlashMenuItems } from '@blocknote/core/extensions';
import { en } from '@blocknote/core/locales';
import { getFormattingToolbarItems } from '@blocknote/react';
import {
  blocksToMarkdown,
  blocksToMarkdownNow,
  escapeMarkerLines,
  formatAiMarker,
  isLossyImport,
  lossyImportCause,
  markdownToBlocks,
  markdownToBlocksNow,
  normalizeParsedBlocks,
  parseAiMarker,
  spliceTitleIntoBlocks,
  unwrapReplyFence,
} from './markdown';
import {
  cerebroSchema,
  DROPPED_SLASH_KEYS,
  slashMenuItems,
  type CerebroEditor,
} from './MarkdownEditor';
import { blockMenuItems, formattingToolbarItems, UNCARRIED_ACTIONS } from './SelectionToolbar';
import { splitFrontmatter } from '@/engine/frontmatter';

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
    // M55.8: a section link keeps its fragment on disk. Only the chip reads
    // it; the target is never rewritten, the alias form included, and a
    // `[[#…]]` opening a line is not a heading.
    name: 'section links',
    md: 'See [[systems-map#Rollback]], [[systems-map#Rollback|the rollback]] and [[#Rollback]].\n\n[[#Rollback]] opens this line.\n',
    out: 'See [[systems-map#Rollback]], [[systems-map#Rollback|the rollback]] and [[#Rollback]].\n\n[[#Rollback]] opens this line.\n',
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

/* M55.6 plans an outside write in one task, so it parses and serializes
   synchronously. The Now forms are the async ones, minus the promise. */
describe('the synchronous forms', () => {
  // Ids are fresh per parse; everything else must match.
  const withoutIds = (blocks: unknown): string =>
    JSON.stringify(blocks, (key, value: unknown) => (key === 'id' ? undefined : value));

  for (const { name, md } of CORPUS) {
    it(`${name}: parses and serializes as the async forms do`, async () => {
      const now = markdownToBlocksNow(editor, md);
      expect(withoutIds(now)).toBe(withoutIds(await markdownToBlocks(editor, md)));
      expect(blocksToMarkdownNow(editor, now)).toBe(await blocksToMarkdown(editor, now));
    });
  }
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

// M55.13 — the child-page list is an EMPTY fence: the list is derived, so the
// file holds nothing but the marker that says where it goes.
describe('the cerebro-subpages fence', () => {
  const EMPTY = 'Before.\n\n```cerebro-subpages\n```\n\nAfter.\n';

  it('promotes an empty fence into the list block', async () => {
    const blocks = await markdownToBlocks(editor, EMPTY);
    expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'subPages', 'paragraph']);
  });

  it('round-trips byte-stable', async () => {
    expect(await roundTrip(EMPTY)).toBe(EMPTY);
    expect(await roundTrip(await roundTrip(EMPTY))).toBe(EMPTY);
  });

  it('leaves a fence holding text as the code block it is', async () => {
    const held = '```cerebro-subpages\nkeep these words\n```\n';
    const blocks = await markdownToBlocks(editor, held);
    expect(blocks.map((b) => b.type)).toEqual(['codeBlock']);
    expect(await roundTrip(held)).toBe(held);
  });
});

// M55.14 — a page card is a POINTER: one wikilink in a ```cerebro-page fence,
// written back exactly as held, whether or not the page it names exists.
describe('the cerebro-page fence', () => {
  const fence = (body: string) =>
    body === '' ? '```cerebro-page\n```\n' : `\`\`\`cerebro-page\n${body}\n\`\`\`\n`;

  it('promotes one link into a page card, and the empty fence into an unset one', async () => {
    const set = await markdownToBlocks(editor, fence('[[how-we-schedule|Scheduling]]'));
    expect(set.map((b) => b.type)).toEqual(['pageCard']);
    expect(set[0].props).toMatchObject({ target: 'how-we-schedule', alias: 'Scheduling' });
    const unset = await markdownToBlocks(editor, fence(''));
    expect(unset.map((b) => b.type)).toEqual(['pageCard']);
    expect(unset[0].props).toMatchObject({ target: '', alias: '' });
  });

  it.each([
    ['set', '[[how-we-schedule]]'],
    ['aliased', '[[how-we-schedule|Scheduling]]'],
    ['a section', '[[how-we-schedule#Windows, not deadlines]]'],
    ['dangling', '[[no-such-page]]'],
    ['unset', ''],
  ])('round-trips byte-stable when %s', async (_name, body) => {
    const page = `Before.\n\n${fence(body)}\nAfter.\n`;
    expect(await roundTrip(page)).toBe(page);
    expect(await roundTrip(await roundTrip(page))).toBe(page);
  });

  it('leaves a fence holding more than one link as the code block it is', async () => {
    for (const body of ['[[a]] and more', '[[a]]\n[[b]]', 'plain words']) {
      const blocks = await markdownToBlocks(editor, fence(body));
      expect(blocks.map((b) => b.type)).toEqual(['codeBlock']);
      expect(await roundTrip(fence(body))).toBe(fence(body));
    }
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
  it.each([
    ':::',
    ':::columns',
    '::::column width=2',
    ':::ai',
    ':::ai{prompt="x"}',
    ':::toggle Not a toggle',
    ':::toggle-heading',
    ':::indent',
  ])('writes %s typed as a paragraph escaped, and reads it back as that text', async (text) => {
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
  });

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
 * Every block a `/` entry can insert, and whether a save keeps it (M53.9).
 *
 * The AI block came back from every save as a paragraph of its own chrome,
 * and nothing said so: the lossy-import check compares letters and digits,
 * and every word was still there. This holds every entry to the question
 * that would have caught it — does a block reopen as the block it was, and
 * does a second save write the bytes of the first? It walks the editor's own
 * `/` builder (`slashMenuItems`), so an entry the menu offers is an entry this
 * measures, and an entry that cannot pass leaves the menu (M55.4, AGENTS.md
 * "Every block the editor offers has a disk carrier").
 *
 * Not here: the `/` menu's Date entry inserts an inline chip (the chip tests
 * above hold those), and a template inserts the markdown it is made of.
 */
describe('every / item survives a save or is not offered', () => {
  /**
   * Entries the menu offers whose block a save does not keep. Empty since
   * M55.4 gave each one a carrier, and it can only stay empty: an entry that
   * loses something leaves the menu (DROPPED_SLASH_KEYS) instead.
   */
  const KNOWN_LOSSY: Record<string, string> = {};

  /** Emoji opens a picker that inserts a character, not a block. */
  const NOT_A_BLOCK = new Set(['emoji']);

  /** A media block needs a file to be anything at all; relative, as a vault's are. */
  const MEDIA_URL: Record<string, string> = {
    image: 'attachments/plan.png',
    video: 'attachments/walkthrough.mp4',
    audio: 'attachments/standup.m4a',
    file: 'attachments/contract.pdf',
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
    subPages: [{ type: 'subPages' }],
    // Set, then unset (the picker `/Page` inserts): each is its own fence.
    pageCard: [
      { type: 'pageCard', props: { target: 'how-we-schedule', alias: '' } },
      { type: 'pageCard', props: { target: '', alias: '' } },
    ],
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

  const para = (text: string) => ({ type: 'paragraph', content: text });

  /** Shapes a person makes with those entries: children, nesting, words in the props. */
  const SHAPES: [string, unknown[]][] = [
    [
      'a toggle with a rich summary and children',
      [
        {
          type: 'toggleListItem',
          content: [
            { type: 'text', text: 'Ask ', styles: {} },
            { type: 'wikilink', props: { target: 'maya-chen', alias: '' } },
            { type: 'text', text: ' about it', styles: { bold: true } },
          ],
          children: [para('Inside.'), { type: 'bulletListItem', content: 'A point' }],
        },
      ],
    ],
    [
      'a toggle inside a toggle',
      [
        {
          type: 'toggleListItem',
          content: 'Outer',
          children: [{ type: 'toggleListItem', content: 'Inner', children: [para('Deep.')] }],
        },
      ],
    ],
    ...[1, 2, 3].map(
      (level) =>
        [
          `a toggle heading ${level} with children`,
          [
            {
              type: 'heading',
              props: { level, isToggleable: true },
              content: 'Plans',
              children: [para('Under the heading.'), { type: 'checkListItem', content: 'Do it' }],
            },
          ],
        ] as [string, unknown[]],
    ),
    ...(
      [
        ['a paragraph', para('Parent')],
        ['a heading', { type: 'heading', props: { level: 2 }, content: 'Parent' }],
        ['a quote', { type: 'quote', content: 'Parent' }],
        ['a bullet', { type: 'bulletListItem', content: 'Parent' }],
        ['a check item', { type: 'checkListItem', props: { checked: true }, content: 'Parent' }],
        ['a code block', { type: 'codeBlock', props: { language: 'ts' }, content: 'x()' }],
        ['a callout', { type: 'callout', props: { kind: 'tip' }, content: 'Parent' }],
        [
          'an image',
          { type: 'image', props: { name: 'Plan', url: 'attachments/plan.png', caption: 'Cap' } },
        ],
      ] as [string, Record<string, unknown>][]
    ).map(
      ([name, parent]) =>
        [`a paragraph nested under ${name}`, [{ ...parent, children: [para('Child.')] }]] as [
          string,
          unknown[],
        ],
    ),
    [
      'a numbered item with a paragraph child, and the item after it',
      [
        { type: 'numberedListItem', content: 'One', children: [para('More about one.')] },
        { type: 'numberedListItem', content: 'Two' },
        { type: 'numberedListItem', content: 'Three' },
      ],
    ],
    [
      'a sub-item with a paragraph child',
      [
        {
          type: 'bulletListItem',
          content: 'Top',
          children: [{ type: 'bulletListItem', content: 'Sub', children: [para('Sub note.')] }],
        },
        { type: 'bulletListItem', content: 'Next' },
      ],
    ],
    [
      'media with a name, a caption and a width',
      [
        {
          type: 'image',
          props: {
            name: 'Plan',
            url: 'attachments/plan.png',
            caption: 'The plan',
            previewWidth: 320,
          },
        },
        {
          type: 'video',
          props: { name: 'Demo', url: 'clips/demo.mp4', caption: 'Day one', previewWidth: 640 },
        },
        { type: 'audio', props: { name: 'Standup', url: 'clips/standup.m4a', caption: 'Mon' } },
        { type: 'file', props: { name: 'Contract', url: 'docs/contract.pdf', caption: 'v2' } },
      ],
    ],
  ];

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

  /**
   * What the editor's own `/` entry inserts, run on a fresh page. What it
   * inserted is kept (a table's header row with it); only words and a file's
   * URL are filled in, as a person would.
   */
  function insertedBy(key: string): unknown[] {
    const live = BlockNoteEditor.create({ schema: cerebroSchema }) as CerebroEditor;
    live.replaceBlocks(live.document, [{ type: 'paragraph' }]);
    live.setTextCursorPosition(live.document[0]);
    slashMenuItems(live)
      .find((item) => item.key === key)
      ?.onItemClick();
    const block = JSON.parse(JSON.stringify(live.document[0])) as {
      type: string;
      props: Record<string, unknown>;
      content?: unknown;
    };
    const content = (cerebroSchema.blockSpecs as Record<string, { config: { content: string } }>)[
      block.type
    ].config.content;
    if (block.type in MEDIA_URL) block.props.url = MEDIA_URL[block.type];
    if (content === 'inline') block.content = 'Some words';
    if (content === 'table') {
      const table = block.content as { rows: { cells: { content: unknown[] }[] }[] };
      table.rows.forEach((row, r) =>
        row.cells.forEach((cell, c) => {
          cell.content = [{ type: 'text', text: `r${r}c${c}`, styles: {} }];
        }),
      );
    }
    return [block];
  }

  const page = BlockNoteEditor.create({ schema: cerebroSchema }) as CerebroEditor;
  const OFFERED = slashMenuItems(page)
    .map((item) => item.key)
    .filter((key): key is NonNullable<typeof key> => key !== undefined && !NOT_A_BLOCK.has(key));
  const CEREBRO_TYPES = Object.keys(cerebroSchema.blockSpecs).filter(
    (type) => !(type in defaultBlockSpecs),
  );

  it('names no lossy entry, and the menu leaves nothing out', () => {
    expect(KNOWN_LOSSY, 'give the entry a carrier, or take it off the menu').toEqual({});
    expect([...DROPPED_SLASH_KEYS]).toEqual([]);
    // Every entry BlockNote has is offered, in BlockNote's order.
    expect(slashMenuItems(page).map((item) => item.key)).toEqual(
      getDefaultSlashMenuItems(page).map((item) => item.key),
    );
  });

  it('inserts a table with the header row a markdown table must have', () => {
    const [table] = insertedBy('table') as { content: { headerRows?: number } }[];
    expect(table.content.headerRows).toBe(1);
  });

  it.each(OFFERED)("the editor's %s entry", async (key) => {
    expect(await survives(insertedBy(key)), `${key} lost something`).toBe(!(key in KNOWN_LOSSY));
  });

  it.each(CEREBRO_TYPES)("Cerebro's %s block", async (type) => {
    expect(OURS[type], `${type} has no fixture here`).toBeDefined();
    expect(await survives(OURS[type])).toBe(true);
  });

  it.each(SHAPES)('%s', async (_name, blocks) => {
    expect(await survives(blocks)).toBe(true);
  });
});

/*
 * The formatting toolbar and the block menu (M55.15): the `/` menu's rule, an
 * action keeps what it did through a save or it is not offered. Every
 * toolbar key BlockNote has is classed here, so a key a new BlockNote adds
 * fails until someone measures it; an action that is kept round-trips, and
 * one in UNCARRIED_ACTIONS is measured losing what it did, so the set cannot
 * hold an action a save would keep.
 */
describe('every toolbar and block-menu action survives a save or is not offered', () => {
  const text = (value: string, styles: Record<string, unknown> = {}) => ({
    type: 'text',
    text: value,
    styles,
  });
  const styled = (styles: Record<string, unknown>) => [
    { type: 'paragraph', content: [text('Some '), text('marked', styles), text(' words')] },
  ];
  const image = (props: Record<string, unknown>) => [
    { type: 'image', props: { url: 'attachments/plan.png', ...props } },
  ];
  const table = (content: Record<string, unknown>) => [
    {
      type: 'table',
      content: {
        type: 'tableContent',
        rows: [{ cells: ['a', 'b'] }, { cells: ['c', 'd'] }],
        ...content,
      },
    },
  ];

  /** The kept actions, toolbar and block menu: what each leaves on a page, or why nothing. */
  const KEPT: Record<string, unknown[] | string> = {
    blockTypeSelect: 'turns a block into one the `/` menu offers, each held above',
    fileCaptionButton: image({ caption: 'The plan' }),
    replaceFileButton: image({ url: 'attachments/other.png' }),
    fileRenameButton: image({ name: 'Plan' }),
    fileDeleteButton: 'removes the block',
    fileDownloadButton: 'saves a copy elsewhere and changes nothing',
    boldStyleButton: styled({ bold: true }),
    italicStyleButton: styled({ italic: true }),
    strikeStyleButton: styled({ strike: true }),
    nestBlockButton: [
      { type: 'paragraph', content: 'Parent', children: [{ type: 'paragraph', content: 'In' }] },
    ],
    unnestBlockButton: 'takes a nested block back out, to the page nest leaves',
    createLinkButton: [
      {
        type: 'paragraph',
        content: [
          text('See '),
          { type: 'link', href: 'https://example.com', content: [text('this')] },
        ],
      },
    ],
    addCommentButton: 'renders only with a comments extension, and the editor has none',
    addTiptapCommentButton: 'renders only with a comments extension, and the editor has none',
    removeBlockItem: 'removes the block',
  };

  /** What each action in UNCARRIED_ACTIONS does to a page, all of it lost by a save. */
  const LOST: Record<string, unknown[][]> = {
    filePreviewButton: [image({ showPreview: false })],
    underlineStyleButton: [styled({ underline: true })],
    colorStyleButton: [styled({ textColor: 'red' }), styled({ backgroundColor: 'yellow' })],
    // Left goes with its group: with centre and right gone, nothing on a page
    // is anything but left, and a button for it would say otherwise.
    textAlignLeftButton: [
      [{ type: 'paragraph', props: { textAlignment: 'center' }, content: 'x' }],
    ],
    textAlignCenterButton: [
      [{ type: 'paragraph', props: { textAlignment: 'center' }, content: 'x' }],
    ],
    textAlignRightButton: [
      [{ type: 'paragraph', props: { textAlignment: 'right' }, content: 'x' }],
    ],
    tableCellMergeButton: [
      [
        {
          type: 'table',
          content: {
            type: 'tableContent',
            headerRows: 1,
            rows: [
              { cells: [{ type: 'tableCell', props: { colspan: 2 }, content: [text('ab')] }] },
              { cells: ['c', 'd'] },
            ],
          },
        },
      ],
    ],
    blockColorsItem: [
      [{ type: 'paragraph', props: { textColor: 'blue' }, content: 'x' }],
      [{ type: 'paragraph', props: { backgroundColor: 'blue' }, content: 'x' }],
    ],
    // Off is what the toggle adds: on is where every markdown table starts.
    tableRowHeaderItem: [table({})],
    tableColumnHeaderItem: [table({ headerRows: 1, headerCols: 1 })],
  };

  const withoutIds = (blocks: unknown[]): unknown[] =>
    blocks.map((block) => {
      const { id: _id, children, ...rest } = block as { id: string; children: unknown[] };
      return { ...rest, children: withoutIds(children ?? []) };
    });

  /** One save and one reopen give back the same blocks, and a second save the same bytes. */
  async function survives(blocks: unknown[]): Promise<boolean> {
    const live = holding(blocks);
    const before = JSON.stringify(withoutIds(live.document));
    const saved = await blocksToMarkdown(live);
    live.replaceBlocks(live.document, await markdownToBlocks(live, saved));
    return (
      JSON.stringify(withoutIds(live.document)) === before &&
      (await blocksToMarkdown(live)) === saved
    );
  }

  const TOOLBAR = getFormattingToolbarItems().map((item) => String(item.key));
  const BLOCK_MENU = [
    'removeBlockItem',
    'blockColorsItem',
    'tableRowHeaderItem',
    'tableColumnHeaderItem',
  ];

  it("classes every action BlockNote's toolbar and block menu have", () => {
    const unclassed = [...TOOLBAR, ...BLOCK_MENU].filter(
      (key) => !(key in KEPT) && !(key in UNCARRIED_ACTIONS),
    );
    expect(unclassed, 'measure it: keep it here, or add it to UNCARRIED_ACTIONS').toEqual([]);
    expect(Object.keys(KEPT).filter((key) => key in UNCARRIED_ACTIONS)).toEqual([]);
    expect(Object.keys(LOST).sort()).toEqual(Object.keys(UNCARRIED_ACTIONS).sort());
  });

  it('offers none of the actions a save drops, in either menu', () => {
    const toolbar = formattingToolbarItems().map((item) => String(item.key));
    const menu = blockMenuItems(en).map((item) => String(item.key));
    expect(toolbar.filter((key) => key in UNCARRIED_ACTIONS)).toEqual([]);
    expect(menu).toEqual(['removeBlockItem']);
    expect(toolbar).toEqual(TOOLBAR.filter((key) => !(key in UNCARRIED_ACTIONS)));
  });

  it.each(
    Object.entries(KEPT).filter((entry): entry is [string, unknown[]] => Array.isArray(entry[1])),
  )('keeps what %s does', async (_key, blocks) => {
    expect(await survives(blocks)).toBe(true);
  });

  it.each(Object.entries(LOST))('a save drops what %s does', async (_key, pages) => {
    for (const blocks of pages) expect(await survives(blocks)).toBe(false);
  });
});

/*
 * A code fence with no language (M55.15). BlockNote's code block defaulted to
 * `javascript`, so a bare fence reopened as a JavaScript one: the save wrote
 * a word the file never had, and the lossy-import check opened the page
 * read-only for it.
 */
describe('a bare code fence', () => {
  it('round-trips bare, byte for byte', async () => {
    const md = 'Run:\n\n```\nnpm install\n```\n';
    const blocks = await markdownToBlocks(editor, md);
    expect(blocks[1]).toMatchObject({ type: 'codeBlock', props: { language: '' } });
    const once = await blocksToMarkdown(editor, blocks);
    expect(once).toBe(md);
    expect(await roundTrip(once)).toBe(md);
    expect(isLossyImport(md, once)).toBe(false);
  });

  it('stays bare inside a list, a toggle and an AI answer', async () => {
    for (const md of [
      '* Step\n\n  ```\n  make\n  ```\n',
      ':::toggle Details\n```\nmake\n```\n:::\n',
      ':::ai{prompt="How?"}\n```\nmake\n```\n:::\n',
    ]) {
      const once = await roundTrip(md);
      expect(once, md).not.toContain('javascript');
      expect(await roundTrip(once)).toBe(once);
      expect(isLossyImport(md, once), md).toBe(false);
    }
  });

  it('writes a tilde fence as a bare backtick one', async () => {
    const md = '~~~\nx = 1\n~~~\n';
    expect(await roundTrip(md)).toBe('```\nx = 1\n```\n');
    expect(isLossyImport(md, await roundTrip(md))).toBe(false);
  });

  it('keeps a named language, javascript included', async () => {
    for (const md of ['```javascript\nx\n```\n', '```ts\nx\n```\n', '```text\nx\n```\n']) {
      expect(await roundTrip(md)).toBe(md);
    }
  });

  it('is what the `/` menu inserts: a block with no language yet', () => {
    const live = holding([{ type: 'paragraph' }]);
    live.setTextCursorPosition(live.document[0]);
    slashMenuItems(live)
      .find((item) => item.key === 'code_block')
      ?.onItemClick();
    expect(live.document[0]).toMatchObject({ type: 'codeBlock', props: { language: '' } });
  });
});

/*
 * The toggle list item (M55.4). BlockNote saved it as a bullet, and it
 * reopened as one: the toggle, and with it what it folded, gone. On disk it is
 * a `:::toggle` directive container now, its summary on the opening line.
 */
describe('the :::toggle container', () => {
  const RICH = [
    'Before.',
    '',
    ':::toggle **Open** questions for [[kickoff]] by 📅 2026-08-01',
    'Who owns the migration?',
    '',
    '* One',
    '',
    '* Two',
    ':::',
    '',
    'After.',
    '',
  ].join('\n');

  it('reads a rich summary and its children as one toggle', async () => {
    const blocks = await markdownToBlocks(editor, RICH);
    expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'toggleListItem', 'paragraph']);
    const summary = JSON.stringify(blocks[1].content);
    expect(summary).toContain('"bold":true');
    expect(summary).toContain('"type":"wikilink"');
    expect(summary).toContain('"type":"due"');
    expect(blocks[1].children.map((c: { type: string }) => c.type)).toEqual([
      'paragraph',
      'bulletListItem',
      'bulletListItem',
    ]);
  });

  it('round-trips byte for byte, and the second save is the first', async () => {
    const once = await roundTrip(RICH);
    expect(once).toBe(RICH);
    expect(await roundTrip(once)).toBe(once);
    expect(isLossyImport(RICH, once)).toBe(false);
  });

  it('saves a live toggle with no summary, and reopens it as the same block', async () => {
    const live = holding([
      { type: 'toggleListItem', children: [{ type: 'paragraph', content: 'In.' }] },
    ]);
    const saved = await blocksToMarkdown(live);
    expect(saved).toBe(':::toggle\nIn.\n:::\n');
    const reopened = await markdownToBlocks(live, saved);
    expect(reopened.map((b) => b.type)).toEqual(['toggleListItem']);
    expect(reopened[0].content).toEqual([]);
    live.replaceBlocks(live.document, reopened);
    expect(await blocksToMarkdown(live)).toBe(saved);
  });

  it('nests inside a toggle, a column and an AI answer', async () => {
    const md = [
      ':::toggle Outer',
      'Text.',
      '',
      '::::toggle Inner',
      'Deep.',
      '::::',
      ':::',
      '',
      ':::columns',
      '::::column',
      ':::::toggle In a column',
      'Left.',
      ':::::',
      '::::',
      '::::column',
      'Right.',
      '::::',
      ':::',
      '',
      ':::ai{prompt="Q"}',
      '::::toggle In an answer',
      'A.',
      '::::',
      ':::',
      '',
    ].join('\n');
    const blocks = await markdownToBlocks(editor, md);
    expect(blocks.map((b) => b.type)).toEqual(['toggleListItem', 'columnList', 'ai']);
    expect(blocks[0].children[1].type).toBe('toggleListItem');
    expect(blocks[1].children[0].children[0].type).toBe('toggleListItem');
    expect(blocks[2].children[0].type).toBe('toggleListItem');
    const once = await roundTrip(md);
    expect(once).toBe(md);
    expect(await roundTrip(once)).toBe(once);
  });

  it('keeps a hard break in its summary', async () => {
    const live = holding([
      {
        type: 'toggleListItem',
        content: 'First line\nsecond line',
        children: [{ type: 'paragraph', content: 'Child.' }],
      },
    ]);
    const saved = await blocksToMarkdown(live);
    expect(saved).toBe(':::toggle First line\\\nsecond line\nChild.\n:::\n');
    const [reopened] = await markdownToBlocks(editor, saved);
    expect(reopened.type).toBe('toggleListItem');
    expect(reopened.content).toEqual([
      { type: 'text', text: 'First line\nsecond line', styles: {} },
    ]);
    expect(await roundTrip(saved)).toBe(saved);
  });

  it.each([
    ['# Q4', '\\# Q4'],
    ['1. First', '1\\. First'],
    ['> Quoted', '\\> Quoted'],
  ])('writes a summary starting %j escaped, and reads it back as text', async (text, written) => {
    const saved = await blocksToMarkdown(
      holding([
        { type: 'toggleListItem', content: text, children: [{ type: 'paragraph', content: 'C.' }] },
      ]),
    );
    expect(saved).toBe(`:::toggle ${written}\nC.\n:::\n`);
    const [reopened] = await markdownToBlocks(editor, saved);
    expect(reopened.type).toBe('toggleListItem');
    expect(reopened.content).toEqual([{ type: 'text', text, styles: {} }]);
    expect(await roundTrip(saved)).toBe(saved);
  });

  /* A summary that is not one paragraph is a line the toggle could not carry
     back out, so it stays the text it is, with what it held after it. */
  it('keeps a summary that is not one paragraph as its raw line', async () => {
    const md = ':::toggle # A heading\nChild.\n:::\n';
    const blocks = await markdownToBlocks(editor, md);
    expect(textsOf(blocks)).toEqual([':::toggle # A heading', 'Child.', ':::']);
    expect(JSON.stringify(blocks)).not.toContain('toggleListItem');
    expect(await roundTrip(md)).toBe(md);
  });

  it('abandons the fold when a toggle never closes, and writes the file back as it was', async () => {
    const md = ':::toggle What is *left*?\nNever closed.\n';
    const blocks = await markdownToBlocks(editor, md);
    expect(textsOf(blocks)).toEqual([':::toggle What is *left*?', 'Never closed.']);
    expect(await roundTrip(md)).toBe(md);
  });

  it('does not read a toggle inside a code fence', async () => {
    const sample = '```markdown\n:::toggle x\nAn example.\n:::\n```\n';
    const blocks = await markdownToBlocks(editor, sample);
    expect(blocks.map((b) => b.type)).toEqual(['codeBlock']);
    expect(await roundTrip(sample)).toBe(sample);
  });
});

/*
 * The toggle heading (M55.4). It saved as a plain heading. On disk the
 * heading keeps its own line, a real `#` line any editor shows as a heading,
 * inside a `:::toggle-heading` container that folds what follows it.
 */
describe('the :::toggle-heading container', () => {
  it.each([1, 2, 3])('round-trips an H%i toggle with its children', async (level) => {
    const md = `:::toggle-heading\n${'#'.repeat(level)} Plans\n\nUnder the heading.\n:::\n`;
    const blocks = await markdownToBlocks(editor, md);
    expect(blocks.map((b) => b.type)).toEqual(['heading']);
    expect(blocks[0].props).toMatchObject({ level, isToggleable: true });
    expect(textsOf(blocks[0].children)).toEqual(['Under the heading.']);
    const once = await roundTrip(md);
    expect(once).toBe(md);
    expect(once.split('\n')[1]).toBe(`${'#'.repeat(level)} Plans`);
    expect(await roundTrip(once)).toBe(once);
  });

  it('lets spliceTitleIntoBlocks rewrite a toggle H1', async () => {
    const live = holding(
      await markdownToBlocks(editor, ':::toggle-heading\n# Old\n\nBody.\n:::\n'),
    );
    spliceTitleIntoBlocks(live, 'New');
    expect(await blocksToMarkdown(live)).toBe(':::toggle-heading\n# New\n\nBody.\n:::\n');
  });

  it('leaves one whose first block is not a heading as the text it is', async () => {
    const md = ':::toggle-heading\nNot a heading.\n:::\n';
    const blocks = await markdownToBlocks(editor, md);
    expect(textsOf(blocks)).toEqual([':::toggle-heading', 'Not a heading.', ':::']);
    expect(await roundTrip(md)).toBe(md);
  });
});

/*
 * Nested children (M55.4). Tab nests any block under the one above it, and
 * the serializer flattened every child that was not a list item into its
 * parent's flow: the nesting gone on the first save. A list keeps its native
 * nesting; anything else goes in an `:::indent` right after its parent.
 */
describe('nested children (:::indent)', () => {
  it.each([
    ['a paragraph', { type: 'paragraph', content: 'Parent' }, 'Parent'],
    ['a heading', { type: 'heading', props: { level: 2 }, content: 'Parent' }, '## Parent'],
    ['a quote', { type: 'quote', content: 'Parent' }, '> Parent'],
    [
      'an image',
      { type: 'image', props: { name: 'Plan', url: 'attachments/plan.png' } },
      '![Plan](attachments/plan.png)',
    ],
  ])('keeps the children of %s', async (_name, parent, line) => {
    const live = holding([{ ...parent, children: [{ type: 'paragraph', content: 'Child.' }] }]);
    const saved = await blocksToMarkdown(live);
    expect(saved).toBe(`${line}\n\n:::indent\nChild.\n:::\n`);
    const [reopened] = await markdownToBlocks(editor, saved);
    expect(reopened.type).toBe(parent.type);
    expect(textsOf(reopened.children)).toEqual(['Child.']);
    expect(await roundTrip(saved)).toBe(saved);
  });

  it('keeps a list item’s paragraph child, and the next numbered item its place', async () => {
    const live = holding([
      {
        type: 'numberedListItem',
        content: 'One',
        children: [{ type: 'paragraph', content: 'More.' }],
      },
      { type: 'numberedListItem', content: 'Two' },
    ]);
    const saved = await blocksToMarkdown(live);
    expect(saved).toBe('1. One\n\n:::indent\nMore.\n:::\n\n2. Two\n');
    const reopened = await markdownToBlocks(editor, saved);
    expect(reopened.map((b) => b.type)).toEqual(['numberedListItem', 'numberedListItem']);
    expect(textsOf(reopened[0].children)).toEqual(['More.']);
    expect(reopened[1].props.start).toBeUndefined();
    expect(await roundTrip(saved)).toBe(saved);
  });

  it('leaves a pure list tree native', async () => {
    const md = '* top\n\n  * nested\n\n    * deeper\n\n* second\n';
    expect(await roundTrip(md)).toBe(md);
    expect(await roundTrip(md)).not.toContain(':::');
  });

  it('reopens a sub-item with a paragraph child nested where it was', async () => {
    const live = holding([
      {
        type: 'bulletListItem',
        content: 'Top',
        children: [
          {
            type: 'bulletListItem',
            content: 'Sub',
            children: [{ type: 'paragraph', content: 'Note.' }],
          },
        ],
      },
    ]);
    const saved = await blocksToMarkdown(live);
    expect(saved).toBe('* Top\n\n:::indent\n* Sub\n\n::::indent\nNote.\n::::\n:::\n');
    const [top] = await markdownToBlocks(editor, saved);
    expect(top.children[0].type).toBe('bulletListItem');
    expect(textsOf(top.children[0].children)).toEqual(['Note.']);
    expect(await roundTrip(saved)).toBe(saved);
  });

  /* An Obsidian-style continuation is a paragraph inside the item, which
     markdown nests natively and the serializer flattens. It saves in an
     `:::indent` (Q4), every word kept, so the page stays editable. */
  it.each([
    [
      '* Item\n\n  More about the item.\n* Next\n',
      '* Item\n\n:::indent\nMore about the item.\n:::\n\n* Next\n',
    ],
    [
      '1. One\n\n   More about one.\n2. Two\n',
      '1. One\n\n:::indent\nMore about one.\n:::\n\n2. Two\n',
    ],
  ])('saves the hand-written continuation in %j in an :::indent', async (md, saved) => {
    const blocks = await markdownToBlocks(editor, md);
    expect(textsOf(blocks[0].children)).toEqual([
      md.includes('*') ? 'More about the item.' : 'More about one.',
    ]);
    const once = await roundTrip(md);
    expect(once).toBe(saved);
    expect(isLossyImport(md, once)).toBe(false);
    expect(await roundTrip(once)).toBe(once);
  });

  it('moves an empty paragraph’s children up a level, every word kept', async () => {
    const saved = await blocksToMarkdown(
      holding([{ type: 'paragraph', children: [{ type: 'paragraph', content: 'Orphan.' }] }]),
    );
    expect(saved).toBe('Orphan.\n');
  });

  it('leaves an :::indent with nothing above it as the text it is', async () => {
    const md = ':::indent\nChild.\n:::\n';
    const blocks = await markdownToBlocks(editor, md);
    expect(textsOf(blocks)).toEqual([':::indent', 'Child.', ':::']);
    expect(await roundTrip(md)).toBe(md);
  });

  /* An unclosed container rebuilds the page from the blocks that arrived. An
     indent settled before it must not have left its children inside one of
     them, or they show twice: once nested, once flat. */
  it.each([
    '* Item\n\n:::indent\nMore about the item.\n:::\n\n:::ai{prompt="Q"}\nAn answer with no close.\n',
    'A parent.\n\n:::indent\nMore about the parent.\n:::\n\n::::columns\n:::column\nNo close.\n',
    ':::ai{prompt="Q"}\nAbove.\n\n:::indent\nMore about above.\n:::\n\nNo close.\n',
  ])('keeps an :::indent once when the page holds an unclosed container: %j', async (md) => {
    const once = await roundTrip(md);
    expect(once).toBe(md);
    expect(lossyImportCause(md, once)).toBeNull();
  });
});

/*
 * Media (M55.4). An image saved with the alt text BlockNote invents ("BlockNote
 * image"), which the lossy check counted as words the file never had, so a
 * page with an image opened read-only; audio and file saved as bare links;
 * captions and a relative video were dropped. Each is one `![…](…)` line now,
 * its kind read back from the extension.
 */
describe('media lines', () => {
  it('keeps ![](attachments/a.png) byte for byte, and the page editable', async () => {
    const md = '![](attachments/a.png)\n';
    const blocks = await markdownToBlocks(editor, md);
    expect(blocks.map((b) => b.type)).toEqual(['image']);
    expect(blocks[0].props).toMatchObject({ url: 'attachments/a.png', name: '', caption: '' });
    const once = await roundTrip(md);
    expect(once).toBe(md);
    expect(isLossyImport(md, once)).toBe(false);
  });

  it('keeps the name, and the title as the caption', async () => {
    const md = 'Before.\n\n![Plan|320](attachments/plan.png "The plan")\n\nAfter.\n';
    const blocks = await markdownToBlocks(editor, md);
    expect(blocks[1].props).toMatchObject({
      name: 'Plan',
      url: 'attachments/plan.png',
      caption: 'The plan',
      previewWidth: 320,
    });
    expect(await roundTrip(md)).toBe(md);
  });

  it.each([
    ['clips/demo.mp4', 'video'],
    ['clips/standup.m4a', 'audio'],
    ['docs/contract.pdf', 'file'],
  ])('reads a relative %s as %s and writes it back unchanged', async (url, type) => {
    const md = `![](${url} "Caption")\n`;
    const blocks = await markdownToBlocks(editor, md);
    expect(blocks.map((b) => b.type)).toEqual([type]);
    expect(blocks[0].props).toMatchObject({ url, caption: 'Caption' });
    expect(await roundTrip(md)).toBe(md);
  });

  it('never writes the text BlockNote invents for media', async () => {
    for (const type of ['image', 'video', 'audio', 'file']) {
      for (const url of [
        '',
        `attachments/x.${{ image: 'png', video: 'mp4', audio: 'mp3', file: 'pdf' }[type]}`,
      ]) {
        const saved = await blocksToMarkdown(holding([{ type, props: { url } }]));
        expect(saved).not.toMatch(/BlockNote image|Add (image|audio|video|file)/);
      }
    }
  });

  it('writes nothing for a media block with no file', async () => {
    const saved = await blocksToMarkdown(
      holding([{ type: 'image' }, { type: 'paragraph', content: 'After.' }]),
    );
    expect(saved).toBe('After.\n');
  });

  it('leaves a media line inside a code fence as code', async () => {
    const sample = '```markdown\n![](attachments/a.png)\n```\n';
    const blocks = await markdownToBlocks(editor, sample);
    expect(blocks.map((b) => b.type)).toEqual(['codeBlock']);
    expect(blocks[0].content[0].text).toBe('![](attachments/a.png)');
    expect(await roundTrip(sample)).toBe(sample);
  });

  /* An image the parser reads itself has its url resolved against the page:
     MEASURED, `* ![](attachments/a.png)` reopened as
     `http://localhost:3000/attachments/a.png`. */
  it.each([
    ['* ![Plan](attachments/plan.png "Cap")\n', 'image', 'attachments/plan.png'],
    ['* ![](clips/demo.mp4)\n', 'video', 'clips/demo.mp4'],
  ])('keeps the relative url and kind of a list-item embed in %j', async (md, type, url) => {
    const [item] = await markdownToBlocks(editor, md);
    expect(item.type).toBe('bulletListItem');
    expect(item.children[0].type).toBe(type);
    expect(item.children[0].props.url).toBe(url);
    const once = await roundTrip(md);
    expect(once).toContain(md.slice(2));
    expect(isLossyImport(md, once)).toBe(false);
    expect(await roundTrip(once)).toBe(once);
  });

  it('leaves an embed inside inline code as the code it is', async () => {
    const md = 'Write `![](a.png)` for an image.\n';
    expect(await roundTrip(md)).toBe(md);
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

  /* A save may add a container the file did not have (M55.4); its name is not
     a word anyone wrote. Every word inside one still counts. */
  it('ignores the container names a save adds', () => {
    expect(isLossyImport('* Item\n\n  More.\n', '* Item\n\n:::indent\nMore.\n:::\n')).toBe(false);
    expect(isLossyImport('Text.\n', '\\:::toggle-heading Text.\n')).toBe(false);
    expect(isLossyImport('```\n:::indent\n```\n', '```\n:::\n```\n')).toBe(true);
  });

  it('still flags a toggle whose summary lost words', () => {
    expect(isLossyImport(':::toggle Two words\nIn.\n:::\n', ':::toggle Two\nIn.\n:::\n')).toBe(
      true,
    );
  });
});

/* What the banner over a locked page names (M55.15). It blamed raw HTML
   whatever the check found. */
describe('lossyImportCause', () => {
  it('is null when the text survives', async () => {
    const md = '# Fine\n\n- [ ] task\n';
    expect(lossyImportCause(md, await roundTrip(md))).toBeNull();
  });

  it('names raw HTML, a tag or a comment, when text is dropped', async () => {
    for (const md of ['<div align="center">centered text</div>\n', 'Hi <!-- a note -->\n']) {
      expect(lossyImportCause(md, await roundTrip(md)), md).toBe('html');
    }
  });

  it('names other dropped text when the file holds no HTML', async () => {
    const md = 'See [the spec][spec].\n\n[spec]: https://example.com "The spec"\n';
    expect(lossyImportCause(md, await roundTrip(md))).toBe('dropped');
  });

  it('does not take an autolink, inline code or a fenced tag for HTML', () => {
    for (const md of [
      'Lost words <https://example.com>\n',
      'Lost words `<div>`\n',
      'Lost words\n\n```\n<div>\n```\n',
    ]) {
      expect(lossyImportCause(md, md.replace('Lost words', '')), md).toBe('dropped');
    }
  });

  it('names added text and reordered text', () => {
    expect(lossyImportCause('```\nx\n```\n', '```javascript\nx\n```\n')).toBe('added');
    expect(lossyImportCause('ab\n', 'ba\n')).toBe('rewritten');
  });
});
