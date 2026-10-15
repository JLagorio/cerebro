/**
 * One version of a page against another, as prose (M58.4).
 *
 * A history row used to open a raw unified diff: `+`/`-` lines a person has
 * to decode, frontmatter keys and table pipes included. This reads both
 * versions as the page's own blocks (a heading, a paragraph, a list item, a
 * property) and says which blocks were added, removed or changed, with the
 * words that changed inside a changed block marked.
 *
 * Blocks pair by CONTENT, never by id: BlockNote's ids do not survive a save,
 * so a moved block reads as removed plus added. Pure: imports only the
 * frontmatter split and the LCS the hunks module already exports.
 */
import { splitFrontmatter } from './frontmatter';
import { lcsPairs, rewriteHunks } from './hunks';

export type ProseBlockKind =
  | 'property'
  | 'heading'
  | 'paragraph'
  | 'list'
  | 'task'
  | 'quote'
  | 'callout'
  | 'code'
  | 'fence'
  | 'container'
  | 'table'
  | 'rule'
  | 'media';

/** One block of a page. `raw` is its source lines, `text` what a reader
 *  reads: emphasis, code ticks, link syntax and `[[…|…]]` dropped. `name` is
 *  a property's key, a container's label, a fence's language or a callout's
 *  type. */
export interface ProseBlock {
  kind: ProseBlockKind;
  raw: string;
  text: string;
  name?: string;
  /** A heading's level. */
  level?: number;
  /** A list item's or task's nesting depth, from 0. */
  depth?: number;
}

/** A word run inside a changed block. */
export interface WordPart {
  op: 'same' | 'ins' | 'del';
  text: string;
}

/** One block of the diff. A `changed` block holds both sides, and its word
 *  runs unless the block was too long to mark (`parts: null`). */
export interface DiffBlock {
  op: 'same' | 'added' | 'removed' | 'changed';
  kind: ProseBlockKind;
  name?: string;
  before?: ProseBlock;
  after?: ProseBlock;
  parts?: WordPart[] | null;
}

export interface ProseCounts {
  added: number;
  changed: number;
  removed: number;
  /** Properties added, changed or removed. */
  properties: number;
}

export type ProseDiff =
  | { kind: 'too_large' }
  | {
      kind: 'diff';
      blocks: DiffBlock[];
      counts: ProseCounts;
      /** The two versions differ only in whitespace or line endings. */
      onlySpacing: boolean;
      created: boolean;
      removed: boolean;
    };

/** Past this many blocks on a side, the prose view gives way to Lines. */
export const MAX_BLOCKS = 2_000;
/** Past this many LCS cells in the changed middle, likewise. */
export const MAX_CELLS = 1_500_000;
/** Past this many word cells, a changed block shows before and after whole. */
export const MAX_WORD_CELLS = 4_000_000;
/** How much two blocks' words must share to read as one block changed. */
const PAIR_OVERLAP = 0.5;

/** A BOM stripped, and CRLF and CR turned into LF. */
function normalize(raw: string): string {
  const content = raw.startsWith('﻿') ? raw.slice(1) : raw;
  return content.replace(/\r\n?/g, '\n');
}

/** What a reader reads of a markdown line. */
export function plainText(raw: string): string {
  return raw
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, '$2')
    .replace(/\[\[([^\]]*)\]\]/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`+/g, '')
    .replace(/(\*\*|__|\*|_|~~)(?=\S)([^\n]*?\S)\1/g, '$2')
    .replace(/\s+/g, ' ')
    .trim();
}

const FENCE = /^\s*(`{3,}|~{3,})\s*([^\s`]*)/;
const CONTAINER = /^(:{3,})\s*(.*)$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const ITEM = /^(\s*)([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?(.*)$/;
const MEDIA = /^\s*!\[[^\]]*\]\([^)]*\)\s*$/;
const CALLOUT = /^>\s*\[!(\w+)\]/;

/** Does `line` start a block other than a paragraph? */
function startsBlock(line: string): boolean {
  return (
    FENCE.test(line) ||
    CONTAINER.test(line) ||
    HEADING.test(line) ||
    RULE.test(line) ||
    line.trimStart().startsWith('|') ||
    line.trimStart().startsWith('>') ||
    ITEM.test(line) ||
    MEDIA.test(line)
  );
}

/** A container's label, from the words after its colons. */
function containerLabel(rest: string): string {
  const match = /^([a-z][a-z-]*)\s*(.*)$/i.exec(rest.trim());
  const name = match?.[1].toLowerCase() ?? '';
  const after = (match?.[2] ?? '').replace(/^\{[^}]*\}\s*/, '').trim();
  if (name === 'ai') return 'AI block';
  if (name === 'columns' || name === 'column') return 'Columns';
  if (name === 'toggle' || name === 'toggle-heading') return `Toggle: ${plainText(after)}`;
  if (name === 'indent') return 'Indented';
  return 'Block';
}

/** Each frontmatter key as one property block, its continuation lines with it. */
function propertyBlocks(yaml: string): ProseBlock[] {
  const blocks: ProseBlock[] = [];
  for (const line of yaml.split('\n')) {
    if (line.trim() === '') continue;
    const key = /^([^\s#-][^:]*):(.*)$/.exec(line);
    if (key !== null) {
      blocks.push({ kind: 'property', raw: line, name: key[1].trim(), text: key[2].trim() });
      continue;
    }
    const last = blocks.at(-1);
    if (last === undefined) {
      blocks.push({ kind: 'property', raw: line, name: '', text: line.trim() });
    } else {
      last.raw += `\n${line}`;
      last.text = `${last.text} ${line.trim()}`.trim();
    }
  }
  return blocks;
}

/** The body's blocks. Every non-blank line lands in exactly one block. */
function bodyBlocks(body: string): ProseBlock[] {
  const lines = body.split('\n');
  const blocks: ProseBlock[] = [];
  let i = 0;
  const take = (from: number, to: number) => lines.slice(from, to).join('\n');
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') {
      i++;
      continue;
    }
    const start = i;
    const fence = FENCE.exec(line);
    if (fence !== null) {
      const mark = fence[1];
      const info = fence[2];
      i++;
      let closed = false;
      while (i < lines.length && !closed) {
        const close = lines[i].trim();
        i++;
        closed = close.startsWith(mark) && close.replace(/[`~]/g, '') === '';
      }
      const inner = lines.slice(start + 1, closed ? i - 1 : i);
      const fenced = info.startsWith('cerebro-') || info === 'mermaid';
      blocks.push({
        kind: fenced ? 'fence' : 'code',
        raw: take(start, i),
        name: info,
        text: inner.join('\n').trim(),
      });
      continue;
    }
    const container = CONTAINER.exec(line);
    if (container !== null && container[2].trim() !== '') {
      const colons = container[1].length;
      i++;
      while (i < lines.length && lines[i].trimEnd() !== ':'.repeat(colons)) i++;
      if (i < lines.length) i++;
      const inner = lines
        .slice(start + 1, i)
        .filter((l) => !/^:{3,}/.test(l.trim()))
        .map((l) => plainText(l))
        .filter((l) => l !== '');
      blocks.push({
        kind: 'container',
        raw: take(start, i),
        name: containerLabel(container[2]),
        text: inner.join(' '),
      });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading !== null) {
      i++;
      blocks.push({
        kind: 'heading',
        raw: line,
        level: heading[1].length,
        text: plainText(heading[2]),
      });
      continue;
    }
    if (RULE.test(line)) {
      i++;
      blocks.push({ kind: 'rule', raw: line, text: '' });
      continue;
    }
    if (line.trimStart().startsWith('|')) {
      while (i < lines.length && lines[i].trimStart().startsWith('|')) i++;
      const cells = lines
        .slice(start, i)
        .filter((l) => !/^\s*\|[\s|:-]*\|?\s*$/.test(l))
        .map((l) =>
          l
            .split('|')
            .map((c) => plainText(c))
            .filter((c) => c !== '')
            .join(' '),
        );
      blocks.push({ kind: 'table', raw: take(start, i), text: cells.join(' ') });
      continue;
    }
    if (line.trimStart().startsWith('>')) {
      while (i < lines.length && lines[i].trimStart().startsWith('>')) i++;
      const callout = CALLOUT.exec(line.trimStart());
      const text = lines
        .slice(start, i)
        .map((l) =>
          plainText(
            l
              .trimStart()
              .replace(/^>\s?/, '')
              .replace(/^\[!\w+\]/, ''),
          ),
        )
        .filter((l) => l !== '')
        .join(' ');
      blocks.push({
        kind: callout === null ? 'quote' : 'callout',
        raw: take(start, i),
        name: callout?.[1].toLowerCase(),
        text,
      });
      continue;
    }
    const item = ITEM.exec(line);
    if (item !== null) {
      const indent = item[1].replace(/\t/g, '  ').length;
      i++;
      const words = [item[4]];
      while (
        i < lines.length &&
        lines[i].trim() !== '' &&
        !ITEM.test(lines[i]) &&
        !FENCE.test(lines[i]) &&
        (lines[i].match(/^\s*/)?.[0].replace(/\t/g, '  ').length ?? 0) > indent
      ) {
        words.push(lines[i]);
        i++;
      }
      blocks.push({
        kind: item[3] === undefined ? 'list' : 'task',
        raw: take(start, i),
        depth: Math.floor(indent / 2),
        text: plainText(words.join(' ')),
      });
      continue;
    }
    if (MEDIA.test(line)) {
      i++;
      blocks.push({ kind: 'media', raw: line, text: plainText(line) });
      continue;
    }
    i++;
    while (i < lines.length && lines[i].trim() !== '' && !startsBlock(lines[i])) i++;
    blocks.push({ kind: 'paragraph', raw: take(start, i), text: plainText(take(start, i)) });
  }
  return blocks;
}

/**
 * A page's blocks: each frontmatter key as a `property` block, then the
 * body's, read in order: fences (`cerebro-*` and mermaid are `fence`, the
 * rest `code`; an unclosed one runs to the end), `:::` containers closed by
 * a line of exactly their colons, headings, rules, `|` tables, `>` quotes
 * and callouts, list items and tasks with their depth and continuation
 * lines, standalone media lines, and paragraphs.
 */
export function proseBlocks(raw: string): ProseBlock[] {
  const { yaml, body } = splitFrontmatter(normalize(raw));
  return [...(yaml === null ? [] : propertyBlocks(yaml)), ...bodyBlocks(body)];
}

const keyOf = (b: ProseBlock): string => `${b.kind}\u0000${b.raw}`;

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w !== '');
}

/** How much two blocks' words share, from 0 to 1 (Dice over the bags). */
function overlap(a: ProseBlock, b: ProseBlock): number {
  const x = words(a.text);
  const y = words(b.text);
  if (x.length === 0 && y.length === 0) return 1;
  const bag = new Map<string, number>();
  for (const w of x) bag.set(w, (bag.get(w) ?? 0) + 1);
  let common = 0;
  for (const w of y) {
    const n = bag.get(w) ?? 0;
    if (n > 0) {
      common++;
      bag.set(w, n - 1);
    }
  }
  return (2 * common) / (x.length + y.length);
}

/** The word runs between two versions of a block, or null past the cap. */
function wordParts(before: ProseBlock, after: ProseBlock): WordPart[] | null {
  if (words(before.text).length * words(after.text).length > MAX_WORD_CELLS) return null;
  const parts: WordPart[] = [];
  for (const part of rewriteHunks(before.text, after.text).parts) {
    if (typeof part === 'string') parts.push({ op: 'same', text: part });
    else {
      if (part.before !== '') parts.push({ op: 'del', text: part.before });
      if (part.after !== '') parts.push({ op: 'ins', text: part.after });
    }
  }
  return parts;
}

function changed(before: ProseBlock, after: ProseBlock): DiffBlock {
  return {
    op: 'changed',
    kind: after.kind,
    name: after.name,
    before,
    after,
    parts: wordParts(before, after),
  };
}

/** Pair the removed and added blocks of one gap, in order: a removed block
 *  takes the next added block of its kind and name whose words it shares,
 *  and a property the next one under its key. */
function pairGap(removed: ProseBlock[], added: ProseBlock[]): DiffBlock[] {
  const out: DiffBlock[] = [];
  let next = 0;
  for (const r of removed) {
    let match = -1;
    for (let k = next; k < added.length; k++) {
      const a = added[k];
      if (
        a.kind === r.kind &&
        a.name === r.name &&
        // A property is its key: a new value is the same property changed.
        (a.kind === 'property' || overlap(r, a) >= PAIR_OVERLAP)
      ) {
        match = k;
        break;
      }
    }
    if (match === -1) {
      out.push({ op: 'removed', kind: r.kind, name: r.name, before: r });
      continue;
    }
    for (const a of added.slice(next, match)) {
      out.push({ op: 'added', kind: a.kind, name: a.name, after: a });
    }
    out.push(changed(r, added[match]));
    next = match + 1;
  }
  for (const a of added.slice(next))
    out.push({ op: 'added', kind: a.kind, name: a.name, after: a });
  return out;
}

function countsOf(blocks: DiffBlock[]): ProseCounts {
  const counts: ProseCounts = { added: 0, changed: 0, removed: 0, properties: 0 };
  for (const b of blocks) {
    if (b.op === 'same') continue;
    if (b.kind === 'property') counts.properties++;
    else counts[b.op]++;
  }
  return counts;
}

/** Whitespace and line endings aside, the same text. */
const squeezed = (raw: string): string => normalize(raw).replace(/\s+/g, ' ').trim();

/**
 * `before` against `after`, block by block. `null` is a version with no file:
 * a page the version created, or one it removed. Blocks key on kind plus
 * source; the common ends are trimmed, the middle pairs by LCS, and inside
 * each gap a removed and an added block of one kind and name pair as one
 * change when their words overlap enough. Too many blocks, or too large a
 * middle, answers `too_large`, and the lens offers Lines.
 */
export function proseDiff(before: string | null, after: string | null): ProseDiff {
  const a = before === null ? [] : proseBlocks(before);
  const b = after === null ? [] : proseBlocks(after);
  if (a.length > MAX_BLOCKS || b.length > MAX_BLOCKS) return { kind: 'too_large' };
  let head = 0;
  while (head < a.length && head < b.length && keyOf(a[head]) === keyOf(b[head])) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    keyOf(a[a.length - 1 - tail]) === keyOf(b[b.length - 1 - tail])
  ) {
    tail++;
  }
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  if (midA.length * midB.length > MAX_CELLS) return { kind: 'too_large' };
  const same = (x: ProseBlock): DiffBlock => ({
    op: 'same',
    kind: x.kind,
    name: x.name,
    before: x,
    after: x,
  });
  const blocks: DiffBlock[] = a.slice(0, head).map(same);
  const pairs = lcsPairs(midA, midB, (x, y) => keyOf(x) === keyOf(y));
  let i = 0;
  let j = 0;
  for (const [pi, pj] of [...pairs, [midA.length, midB.length] as [number, number]]) {
    blocks.push(...pairGap(midA.slice(i, pi), midB.slice(j, pj)));
    if (pi < midA.length) blocks.push(same(midA[pi]));
    i = pi + 1;
    j = pj + 1;
  }
  blocks.push(...a.slice(a.length - tail).map(same));
  return {
    kind: 'diff',
    blocks,
    counts: countsOf(blocks),
    onlySpacing:
      before !== null && after !== null && before !== after && squeezed(before) === squeezed(after),
    created: before === null && after !== null,
    removed: before !== null && after === null,
  };
}

/** Sentences for a version's change, the first line the lens reads. */
export const TOO_LARGE_TO_READ = 'This change is too large to read as prose. Open Lines to see it.';
export const CREATED_PAGE = 'This version created the page.';
export const REMOVED_PAGE = 'This version removed the page.';
export const ONLY_SPACING = 'Only spacing or line endings changed.';
export const NOTHING_CHANGED = 'This version left the page’s text as it was.';

/**
 * One version's change in words: created, removed, only moved, only
 * spacing, or "Added N blocks, changed N and removed N." with the zero parts
 * left out, then how many properties changed. `previousPath` is where a
 * renamed version moved from.
 */
export function summarize(diff: ProseDiff, previousPath: string | null = null): string {
  if (diff.kind === 'too_large') return TOO_LARGE_TO_READ;
  if (diff.created) return CREATED_PAGE;
  if (diff.removed) return REMOVED_PAGE;
  const { added, changed: altered, removed, properties } = diff.counts;
  const none = added + altered + removed + properties === 0;
  if (none && previousPath !== null) return `Only the name changed: it moved from ${previousPath}.`;
  if (diff.onlySpacing) return ONLY_SPACING;
  if (none) return NOTHING_CHANGED;
  const said: string[] = [];
  const parts: [string, number][] = [
    ['added', added],
    ['changed', altered],
    ['removed', removed],
  ];
  const shown = parts.filter(([, n]) => n > 0);
  shown.forEach(([verb, n], k) => {
    said.push(
      k === 0
        ? `${verb[0].toUpperCase()}${verb.slice(1)} ${n} ${n === 1 ? 'block' : 'blocks'}`
        : `${verb} ${n}`,
    );
  });
  const sentences: string[] = [];
  if (said.length > 0) {
    const joined =
      said.length === 1 ? said[0] : `${said.slice(0, -1).join(', ')} and ${said.at(-1)}`;
    sentences.push(`${joined}.`);
  }
  if (properties > 0) {
    sentences.push(properties === 1 ? '1 property changed.' : `${properties} properties changed.`);
  }
  return sentences.join(' ');
}
