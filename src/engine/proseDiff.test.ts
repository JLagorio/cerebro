import { describe, expect, it } from 'vitest';
import {
  CREATED_PAGE,
  MAX_BLOCKS,
  ONLY_SPACING,
  REMOVED_PAGE,
  TOO_LARGE_TO_READ,
  plainText,
  proseBlocks,
  proseDiff,
  summarize,
  type ProseDiff,
} from '@/engine/proseDiff';

/** The body's non-blank lines, and the blocks' non-blank source lines, in
 *  order: equal exactly when every line lands in one block, once. */
function bodyLines(raw: string): { body: string[]; blocks: string[] } {
  const nonBlank = (text: string) => text.split('\n').filter((l) => l.trim() !== '');
  const body = raw.replace(/^---\n[\s\S]*?\n---\n/, '');
  return {
    body: nonBlank(body),
    blocks: proseBlocks(raw)
      .filter((b) => b.kind !== 'property')
      .flatMap((b) => nonBlank(b.raw)),
  };
}

const PAGE = [
  '---',
  'title: Plan',
  'tags:',
  '  - a',
  '  - b',
  '---',
  '',
  '# Plan',
  '',
  'Some **bold** and `code` with [a link](https://example.test) and [[target|Alias]].',
  'A second line of the same paragraph.',
  '',
  '- one',
  '  continued',
  '  - nested',
  '- [ ] a task',
  '- [x] done',
  '',
  '```js',
  'const a = 1;',
  '```',
  '',
  '```cerebro-database',
  'type: Risk',
  '```',
  '',
  ':::toggle The summary',
  'Hidden words.',
  '::::toggle',
  'Deeper.',
  '::::',
  ':::',
  '',
  ':::ai{prompt="x"}',
  'Generated.',
  ':::',
  '',
  '| a | b |',
  '| --- | --- |',
  '| 1 | 2 |',
  '',
  '> [!note]',
  '> A callout.',
  '',
  '> Just a quote.',
  '',
  '***',
  '',
  '![chart](attachments/chart.png)',
  '',
  '```',
  'never closed',
].join('\n');

describe('proseBlocks', () => {
  const blocks = proseBlocks(PAGE);

  it('reads each frontmatter key as one property block', () => {
    const props = blocks.filter((b) => b.kind === 'property');
    expect(props.map((p) => p.name)).toEqual(['title', 'tags']);
    expect(props[1].raw).toBe('tags:\n  - a\n  - b');
  });

  it('reads the body as the blocks a reader sees', () => {
    const body = blocks.filter((b) => b.kind !== 'property');
    expect(body.map((b) => b.kind)).toEqual([
      'heading',
      'paragraph',
      'list',
      'list',
      'task',
      'task',
      'code',
      'fence',
      'container',
      'container',
      'table',
      'callout',
      'quote',
      'rule',
      'media',
      'code',
    ]);
    expect(body[0]).toMatchObject({ level: 1, text: 'Plan' });
    expect(body[1].text).toBe(
      'Some bold and code with a link and Alias. A second line of the same paragraph.',
    );
    expect(body[2]).toMatchObject({ depth: 0, text: 'one continued' });
    expect(body[3]).toMatchObject({ depth: 1, text: 'nested' });
    expect(body[6]).toMatchObject({ name: 'js', text: 'const a = 1;' });
    expect(body[7]).toMatchObject({ name: 'cerebro-database' });
    expect(body[8].name).toBe('Toggle: The summary');
    expect(body[8].text).toBe('Hidden words. Deeper.');
    expect(body[9]).toMatchObject({ name: 'AI block', text: 'Generated.' });
    expect(body[10].text).toBe('a b 1 2');
    expect(body[11]).toMatchObject({ name: 'note', text: 'A callout.' });
    expect(body[15].text).toBe('never closed');
  });

  it('lands every non-blank line in exactly one block', () => {
    const { body, blocks: lines } = bodyLines(PAGE);
    expect(lines).toEqual(body);
    const unclosed = bodyLines(':::ai\nRuns.\n\n# To the end\n');
    expect(unclosed.blocks).toEqual(unclosed.body);
    expect(proseBlocks(':::ai\nRuns.\n\n# To the end\n').map((b) => b.kind)).toEqual(['container']);
  });

  it('closes a container only on a line of its own colon count', () => {
    const page = ':::columns\n::::column\nLeft.\n::::\n::::column\nRight.\n::::\n:::\n\nAfter.\n';
    const read = proseBlocks(page);
    expect(read.map((b) => b.kind)).toEqual(['container', 'paragraph']);
    expect(read[0]).toMatchObject({ name: 'Columns', text: 'Left. Right.' });
  });

  it('strips a BOM and reads CR and CRLF as LF', () => {
    expect(proseBlocks('﻿# A\r\n\r\nBody.\rMore.')).toEqual(proseBlocks('# A\n\nBody.\nMore.'));
  });

  it('drops markup from the text a reader reads', () => {
    expect(plainText('*em* __strong__ ~~gone~~ `tick` [[a]] ![alt](x.png)')).toBe(
      'em strong gone tick a alt',
    );
  });
});

function diffOf(before: string | null, after: string | null): Extract<ProseDiff, { kind: 'diff' }> {
  const diff = proseDiff(before, after);
  if (diff.kind !== 'diff') throw new Error('too large');
  return diff;
}

describe('proseDiff', () => {
  const base = '# Plan\n\nThe first paragraph says one thing.\n\nThe second paragraph.\n';

  it('finds nothing between identical versions', () => {
    const diff = diffOf(base, base);
    expect(diff.blocks.every((b) => b.op === 'same')).toBe(true);
    expect(diff.counts).toEqual({ added: 0, changed: 0, removed: 0, properties: 0 });
  });

  it('marks one changed word inside its block', () => {
    const diff = diffOf(base, base.replace('one thing', 'another thing'));
    const changed = diff.blocks.filter((b) => b.op === 'changed');
    expect(changed).toHaveLength(1);
    expect(changed[0].parts?.filter((p) => p.op === 'del').map((p) => p.text.trim())).toEqual([
      'one',
    ]);
    expect(changed[0].parts?.filter((p) => p.op === 'ins').map((p) => p.text.trim())).toEqual([
      'another',
    ]);
    expect(summarize(diff)).toBe('Changed 1 block.');
  });

  it('reads an insert and a delete', () => {
    const inserted = diffOf(base, `${base}\nA third paragraph.\n`);
    expect(inserted.counts).toMatchObject({ added: 1, changed: 0, removed: 0 });
    const deleted = diffOf(base, '# Plan\n\nThe second paragraph.\n');
    expect(deleted.counts).toMatchObject({ added: 0, changed: 0, removed: 1 });
    expect(summarize(deleted)).toBe('Removed 1 block.');
  });

  it('reads a moved block as removed plus added', () => {
    const moved = '# Plan\n\nThe second paragraph.\n\nThe first paragraph says one thing.\n';
    const diff = diffOf(base, moved);
    expect(diff.counts).toMatchObject({ added: 1, removed: 1, changed: 0 });
    expect(summarize(diff)).toBe('Added 1 block and removed 1.');
  });

  it('reads a heading level change as the heading changed', () => {
    const diff = diffOf(base, base.replace('# Plan', '## Plan'));
    const changed = diff.blocks.filter((b) => b.op === 'changed');
    expect(changed.map((b) => [b.kind, b.before?.level, b.after?.level])).toEqual([
      ['heading', 1, 2],
    ]);
  });

  it('reads a CRLF-only change as only spacing', () => {
    const diff = diffOf(base, base.replace(/\n/g, '\r\n'));
    expect(diff.onlySpacing).toBe(true);
    expect(summarize(diff)).toBe(ONLY_SPACING);
  });

  it('says a version created or removed the page', () => {
    const created = diffOf(null, base);
    expect(created.created).toBe(true);
    expect(created.blocks.every((b) => b.op === 'added')).toBe(true);
    expect(summarize(created)).toBe(CREATED_PAGE);
    const removed = diffOf(base, null);
    expect(removed.removed).toBe(true);
    expect(summarize(removed)).toBe(REMOVED_PAGE);
  });

  it('gives way to Lines past the block cap', () => {
    const many = Array.from({ length: MAX_BLOCKS + 1 }, (_, n) => `Paragraph ${n}.`).join('\n\n');
    const diff = proseDiff(base, many);
    expect(diff).toEqual({ kind: 'too_large' });
    expect(summarize(diff)).toBe(TOO_LARGE_TO_READ);
  });

  it('counts a property value change as a property', () => {
    const before = `---\nstatus: todo\nowner: ana\n---\n${base}`;
    const diff = diffOf(before, before.replace('status: todo', 'status: done'));
    expect(diff.counts).toEqual({ added: 0, changed: 0, removed: 0, properties: 1 });
    expect(summarize(diff)).toBe('1 property changed.');
    const two = diffOf(before, before.replace('todo', 'done').replace('ana', 'bo'));
    expect(summarize(two)).toBe('2 properties changed.');
  });

  it('shows a block too long to mark before and after whole', () => {
    const long = (word: string) => Array.from({ length: 2_100 }, () => word).join(' ');
    const diff = diffOf(`${long('alpha')} omega\n`, `${long('alpha')} sigma\n`);
    const changed = diff.blocks.find((b) => b.op === 'changed');
    expect(changed?.parts).toBeNull();
  });

  it('words a mixed change with every part, and the move of a renamed page', () => {
    const mixed = diffOf(
      `---\na: 1\n---\n${base}`,
      `---\na: 2\n---\n# Plan\n\nThe first paragraph says two things.\n\nNew.\n`,
    );
    expect(summarize(mixed)).toBe('Added 1 block, changed 1 and removed 1. 1 property changed.');
    expect(summarize(diffOf(base, base), 'old/plan.md')).toBe(
      'Only the name changed: it moved from old/plan.md.',
    );
  });
});
