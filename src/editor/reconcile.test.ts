// @vitest-environment jsdom
import { BlockNoteEditor } from '@blocknote/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { blocksToMarkdownNow, markdownToBlocksNow } from './markdown';
import { cerebroSchema, type CerebroEditor } from './MarkdownEditor';
import {
  applySteps,
  inPlace,
  planExternal,
  settleChoice,
  type AnyBlock,
  type OpenChoice,
} from './reconcile';

/**
 * An outside write applied to the page in place (M55.6), on a headless
 * editor with the app's schema. What matters is which block ids survive: a
 * block that keeps its id keeps its node view, its caret and its undo past.
 */

let editor: CerebroEditor;

beforeEach(() => {
  editor = BlockNoteEditor.create({ schema: cerebroSchema }) as CerebroEditor;
});

/** Open `md` and hand back its canonical text, the base an apply plans from. */
function load(md: string): string {
  editor.replaceBlocks(editor.document, markdownToBlocksNow(editor, md));
  return blocksToMarkdownNow(editor);
}

const ids = (blocks: readonly AnyBlock[] = editor.document as AnyBlock[]): string[] =>
  blocks.flatMap((block) => [block.id as string, ...ids(block.children ?? [])]);

const idOfText = (text: string): string => {
  const found = (blocks: readonly AnyBlock[]): AnyBlock | undefined => {
    for (const block of blocks) {
      if (JSON.stringify(block.content ?? '').includes(text)) return block;
      const inner = found(block.children ?? []);
      if (inner !== undefined) return inner;
    }
    return undefined;
  };
  const block = found(editor.document as AnyBlock[]);
  if (block === undefined) throw new Error(`no block holds ${text}`);
  return block.id as string;
};

/** Plan `next` against `base` and apply it; the plan, for its choices. */
function apply(next: string, base: string, open: OpenChoice[] = []) {
  const plan = planExternal(editor, { next, base, open });
  if (plan.kind === 'plan') inPlace(editor, () => applySteps(editor, plan.steps));
  return plan;
}

const typeInto = (id: string, text: string) => editor.updateBlock(id, { content: text });

const PAGE = '# Plan\n\nFirst paragraph.\n\nSecond paragraph.\n\nThird paragraph.\n';

describe('a clean page', () => {
  it('changes only the block the write changed, and every other id stays', () => {
    const base = load(PAGE);
    const before = ids();
    const second = idOfText('Second');
    apply(PAGE.replace('Second paragraph.', 'Second, revised.'), base);
    expect(ids()).toEqual(before);
    expect(idOfText('Second, revised.')).toBe(second);
    expect(blocksToMarkdownNow(editor)).toBe(
      '# Plan\n\nFirst paragraph.\n\nSecond, revised.\n\nThird paragraph.\n',
    );
  });

  it('keeps the id of a block whose type stays, and replaces one whose type changes', () => {
    const base = load(PAGE);
    const first = idOfText('First');
    apply(PAGE.replace('First paragraph.', 'First, reworded.'), base);
    expect(idOfText('First, reworded.')).toBe(first);
    const base2 = blocksToMarkdownNow(editor);
    apply(base2.replace('First, reworded.', '## First, reworded.'), base2);
    expect(idOfText('First, reworded.')).not.toBe(first);
    expect(editor.document[1].type).toBe('heading');
  });

  it('inserts and deletes around the blocks it keeps', () => {
    const base = load(PAGE);
    const [title, , second, third] = [
      idOfText('Plan'),
      idOfText('First'),
      idOfText('Second'),
      idOfText('Third'),
    ];
    apply('# Plan\n\nA new opening.\n\nSecond paragraph.\n\nThird paragraph.\n\nThe end.\n', base);
    expect(blocksToMarkdownNow(editor)).toBe(
      '# Plan\n\nA new opening.\n\nSecond paragraph.\n\nThird paragraph.\n\nThe end.\n',
    );
    for (const id of [title, second, third]) expect(ids()).toContain(id);
  });

  it('edits inside one column and keeps the other column and the layout', () => {
    const md = [
      ':::columns',
      '::::column',
      'Left side.',
      '::::',
      '::::column',
      'Right side.',
      '::::',
      ':::',
      '',
    ].join('\n');
    const base = load(md);
    const layout = editor.document[0].id;
    const [leftColumn, rightColumn] = editor.document[0].children.map((c) => c.id);
    const left = idOfText('Left side.');
    apply(md.replace('Right side.', 'Right, revised.'), base);
    expect(editor.document[0].id).toBe(layout);
    expect(editor.document[0].children.map((c) => c.id)).toEqual([leftColumn, rightColumn]);
    expect(idOfText('Left side.')).toBe(left);
    expect(blocksToMarkdownNow(editor)).toBe(md.replace('Right side.', 'Right, revised.'));
  });

  it('keeps the trailing blank paragraph, last', () => {
    const base = load(PAGE);
    const last = editor.document[editor.document.length - 1];
    editor.insertBlocks([{ type: 'paragraph' }], last, 'after');
    const blank = editor.document[editor.document.length - 1].id;
    apply(`${PAGE}\nAppended by the agent.\n`, base);
    expect(editor.document[editor.document.length - 1].id).toBe(blank);
    expect(blocksToMarkdownNow(editor)).toContain('Appended by the agent.');
  });

  it('keeps the ids of an AI block, a database block and a toggle the write did not touch', () => {
    const md = [
      'Intro.',
      '',
      ':::ai{prompt="The open questions" generated="2026-10-12"}',
      '* Who owns it?',
      ':::',
      '',
      '```cerebro-database',
      'database: Reading list',
      '```',
      '',
      ':::toggle Details',
      'Hidden inside.',
      ':::',
      '',
      'Outro.',
      '',
    ].join('\n');
    const base = load(md);
    const kept = editor.document.filter((b) =>
      ['ai', 'database', 'toggleListItem'].includes(b.type),
    );
    expect(kept.map((b) => b.type)).toEqual(['ai', 'database', 'toggleListItem']);
    const before = ids(kept as AnyBlock[]);
    apply(base.replace('Outro.', 'Outro, revised.'), base);
    const after = editor.document.filter((b) =>
      ['ai', 'database', 'toggleListItem'].includes(b.type),
    );
    expect(ids(after as AnyBlock[])).toEqual(before);
    expect(blocksToMarkdownNow(editor)).toBe(base.replace('Outro.', 'Outro, revised.'));
  });

  // M55.13 — the child-page list holds nothing to compare, so a write that
  // misses it must leave the block, and its live list, where they were.
  it('keeps the id of a child-page list the write did not touch', () => {
    const base = load('Intro.\n\n```cerebro-subpages\n```\n\nOutro.\n');
    const [list] = editor.document.filter((b) => b.type === 'subPages');
    expect(list).toBeDefined();
    apply(base.replace('Outro.', 'Outro, revised.'), base);
    expect(editor.document.find((b) => b.type === 'subPages')?.id).toBe(list.id);
    expect(blocksToMarkdownNow(editor)).toBe(base.replace('Outro.', 'Outro, revised.'));
  });

  // M55.14 — a page card pairs by its pointer, so a write that misses it
  // keeps the block, its id and its live face where they were.
  it('keeps the id and the pointer of a page card the write did not touch', () => {
    const base = load('Intro.\n\n```cerebro-page\n[[how-we-schedule|Scheduling]]\n```\n\nOutro.\n');
    const [card] = editor.document.filter((b) => b.type === 'pageCard');
    expect(card.props).toMatchObject({ target: 'how-we-schedule', alias: 'Scheduling' });
    apply(base.replace('Outro.', 'Outro, revised.'), base);
    const after = editor.document.find((b) => b.type === 'pageCard');
    expect(after?.id).toBe(card.id);
    expect(after?.props).toMatchObject({ target: 'how-we-schedule', alias: 'Scheduling' });
    expect(blocksToMarkdownNow(editor)).toBe(base.replace('Outro.', 'Outro, revised.'));
  });

  it('serializes, after an apply, to the write’s canonical text', () => {
    const base = load(PAGE);
    const next = '# Plan\n\n- one\n- two\n\nSecond paragraph.\n';
    const plan = apply(next, base);
    expect(plan.kind).toBe('plan');
    if (plan.kind !== 'plan') return;
    expect(blocksToMarkdownNow(editor)).toBe(plan.next);
  });

  it('answers same for a write that reads as the base, and changes nothing', () => {
    const base = load(PAGE);
    const before = ids();
    expect(apply(PAGE, base).kind).toBe('same');
    expect(ids()).toEqual(before);
  });

  it('calls a lossy write unrepresentable and changes nothing', () => {
    const base = load(PAGE);
    const before = blocksToMarkdownNow(editor);
    const plan = apply(`${PAGE}\n<div align="center">raw html</div>\n`, base);
    expect(plan).toEqual({ kind: 'unrepresentable', dirty: false });
    expect(blocksToMarkdownNow(editor)).toBe(before);
  });
});

describe('a page with unsaved typing', () => {
  it('keeps both edits when they touch different blocks', () => {
    const base = load(PAGE);
    typeInto(idOfText('Third'), 'Third, typed by me.');
    const plan = apply(PAGE.replace('First paragraph.', 'First, by the agent.'), base);
    expect(plan.kind === 'plan' && plan.choices).toEqual([]);
    expect(blocksToMarkdownNow(editor)).toBe(
      '# Plan\n\nFirst, by the agent.\n\nSecond paragraph.\n\nThird, typed by me.\n',
    );
  });

  it('makes one choice where both changed a block, with both previews, and keeps mine', () => {
    const base = load(PAGE);
    const second = idOfText('Second');
    typeInto(second, 'Second, typed by me.');
    const plan = apply(PAGE.replace('Second paragraph.', 'Second, by the agent.'), base);
    if (plan.kind !== 'plan') throw new Error(plan.kind);
    expect(plan.choices).toHaveLength(1);
    expect(plan.choices[0]).toMatchObject({
      mine: [second],
      minePreview: 'Second, typed by me.',
      theirsPreview: 'Second, by the agent.',
    });
    expect(blocksToMarkdownNow(editor)).toContain('Second, typed by me.');
  });

  it('settles a choice for theirs, and for mine', () => {
    const base = load(PAGE);
    typeInto(idOfText('Second'), 'Second, typed by me.');
    const plan = apply(PAGE.replace('Second paragraph.', 'Second, by the agent.'), base);
    if (plan.kind !== 'plan') throw new Error(plan.kind);
    settleChoice(editor, plan.choices[0], 'mine');
    expect(blocksToMarkdownNow(editor)).toContain('Second, typed by me.');
    settleChoice(editor, plan.choices[0], 'theirs');
    expect(blocksToMarkdownNow(editor)).toBe(
      PAGE.replace('Second paragraph.', 'Second, by the agent.'),
    );
  });

  it('puts theirs back after `after` when mine had deleted the block', () => {
    const base = load(PAGE);
    editor.removeBlocks([idOfText('Second')]);
    const plan = apply(PAGE.replace('Second paragraph.', 'Second, by the agent.'), base);
    if (plan.kind !== 'plan') throw new Error(plan.kind);
    expect(plan.choices[0]).toMatchObject({ mine: [], after: idOfText('First') });
    settleChoice(editor, plan.choices[0], 'theirs');
    expect(blocksToMarkdownNow(editor)).toBe(
      PAGE.replace('Second paragraph.', 'Second, by the agent.'),
    );
  });

  it('keeps an open choice a second write does not touch, and replaces one it does', () => {
    const base = load(PAGE);
    typeInto(idOfText('Second'), 'Second, typed by me.');
    const first = apply(PAGE.replace('Second paragraph.', 'Second, by the agent.'), base);
    if (first.kind !== 'plan') throw new Error(first.kind);
    const base2 = first.next;

    // A write elsewhere: the open choice stays.
    const elsewhere = apply(
      base2.replace('Third paragraph.', 'Third, by the agent.'),
      base2,
      first.choices,
    );
    if (elsewhere.kind !== 'plan') throw new Error(elsewhere.kind);
    expect(elsewhere.choices.map((c) => c.id)).toEqual([first.choices[0].id]);
    expect(blocksToMarkdownNow(editor)).toContain('Third, by the agent.');

    // A write to the contested block again: a new choice in its place.
    const base3 = elsewhere.next;
    const again = apply(
      base3.replace('Second, by the agent.', 'Second, again.'),
      base3,
      elsewhere.choices,
    );
    if (again.kind !== 'plan') throw new Error(again.kind);
    expect(again.choices).toHaveLength(1);
    expect(again.choices[0].id).not.toBe(first.choices[0].id);
    expect(again.choices[0].theirsPreview).toBe('Second, again.');
  });
});

/**
 * A level the write empties out (M55 review): `updateBlock` ignores an empty
 * `children`, so the apply has to remove such a level block by block, or the
 * page keeps what the write deleted and the next save writes it back.
 */
describe('a write that empties a level', () => {
  /** `md` as the page would serialize it, through an editor of its own. */
  const canon = (md: string): string => {
    const other = BlockNoteEditor.create({ schema: cerebroSchema }) as CerebroEditor;
    other.replaceBlocks(other.document, markdownToBlocksNow(other, md));
    return blocksToMarkdownNow(other);
  };

  const COLUMNS = (right: string[]) =>
    [
      ':::columns',
      '::::column',
      'Left side.',
      '::::',
      '::::column',
      ...right,
      '::::',
      ':::',
      '',
    ].join('\n');

  const cases: { name: string; from: string; to: string }[] = [
    { name: 'deletes a lone sub-item', from: '- a\n  - b\n- c\n', to: '- a\n- c\n' },
    { name: 'flattens a list level', from: '- a\n  - b\n    - c\n', to: '- a\n  - c\n' },
    {
      name: 'empties a toggle',
      from: ':::toggle Details\nHidden inside.\n:::\n\nOutro.\n',
      to: ':::toggle Details\n:::\n\nOutro.\n',
    },
    {
      name: 'empties a column',
      from: COLUMNS(['Right one.', '', 'Right two.']),
      to: COLUMNS([]),
    },
  ];

  for (const { name, from, to } of cases) {
    it(`${name} on a clean page`, () => {
      const base = load(from);
      const plan = apply(to, base);
      expect(plan.kind).toBe('plan');
      expect(blocksToMarkdownNow(editor)).toBe(canon(to));
    });

    it(`${name} on a page with typing elsewhere`, () => {
      const base = load(`Typed here.\n\n${from}`);
      typeInto(idOfText('Typed here.'), 'Typed by me.');
      const plan = apply(`Typed here.\n\n${to}`, base);
      expect(plan.kind === 'plan' && plan.choices).toEqual([]);
      expect(blocksToMarkdownNow(editor)).toBe(canon(`Typed by me.\n\n${to}`));
    });
  }
});
