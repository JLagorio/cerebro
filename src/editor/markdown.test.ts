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
