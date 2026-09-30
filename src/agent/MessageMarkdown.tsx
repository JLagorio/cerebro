import { Fragment, useMemo, type CSSProperties, type ReactNode } from 'react';
import type { Entry } from '@/engine/types';
import { resolveTarget } from '@/engine/wikilink';
import { useVaultStore } from '@/stores/vaultStore';

/**
 * Markdown for assistant replies (M51.5).
 *
 * The panel used to split a reply on two regexes, `[[wikilinks]]` and
 * `**bold**`, and the bold one swallowed any link inside it:
 * `**New — [[conflict-model-ships-whole]]**` came out with its brackets
 * showing, and every list, heading and backticked `progress: 5` arrived as the
 * raw characters. The agent writes markdown; the panel has to read it.
 *
 * Not ConceptBody's renderer, although the block set is close: that one is
 * sized for a page, and its inline pass is one flat regex, so nothing in it
 * nests. Here emphasis is resolved the CommonMark way — delimiter runs and
 * their flanking rules — which is what lets a link or a code span sit inside
 * bold, and what keeps the underscores in `stale_after` from turning a field
 * name italic.
 *
 * A reply is parsed on every streamed token, so half-written syntax is the
 * normal case rather than an error: an unclosed `**` or `[[` renders as the
 * characters typed so far, an unclosed fence is code to the end, and nothing
 * here throws on partial input. Nothing reaches the DOM as HTML.
 */

type Inline =
  | string
  | { kind: 'code'; text: string }
  | { kind: 'wikilink'; target: string; alias: string | undefined }
  /** `href` is null when the scheme is not one we will open. */
  | { kind: 'link'; href: string | null; children: Inline[] }
  | { kind: 'em' | 'strong' | 'del'; children: Inline[] };

type Align = 'left' | 'center' | 'right' | null;

type Block =
  | { kind: 'paragraph'; inline: Inline[] }
  | { kind: 'heading'; level: 1 | 2 | 3; inline: Inline[] }
  | { kind: 'code'; text: string }
  | { kind: 'rule' }
  | { kind: 'quote'; blocks: Block[] }
  | { kind: 'list'; ordered: boolean; start: number; items: Block[][] }
  | { kind: 'table'; align: Align[]; head: Inline[][]; rows: Inline[][][] };

// --- Inline ---------------------------------------------------------------

/** A run of `*`, `_` or `~~` that may yet open or close emphasis. */
interface Delimiter {
  kind: 'delimiter';
  char: '*' | '_' | '~';
  /** Characters not yet used by a match. */
  count: number;
  /** The run as written — the rule of 3 reads this, not what is left. */
  length: number;
  open: boolean;
  close: boolean;
}

type Token = Inline | Delimiter;

const SPACE = /\s/u;
const PUNCTUATION = /[\p{P}\p{S}]/u;
/** ASCII punctuation: what a backslash escapes. */
const ESCAPABLE = /[!-/:-@[-`{-~]/;
/** The schemes a reply may link to; any other link renders as its label. */
const SAFE_HREF = /^(?:https?:\/\/|mailto:)/i;

const isDelimiter = (token: Token): token is Delimiter =>
  typeof token !== 'string' && token.kind === 'delimiter';

function runOf(text: string, at: number, char: string): number {
  let end = at;
  while (text[end] === char) end += 1;
  return end - at;
}

/** CommonMark's flanking rules: whether a delimiter run can open, close, or both. */
function delimiter(text: string, at: number, length: number, char: Delimiter['char']): Delimiter {
  const before = text[at - 1] ?? ' ';
  const after = text[at + length] ?? ' ';
  const punctBefore = PUNCTUATION.test(before);
  const punctAfter = PUNCTUATION.test(after);
  const left = !SPACE.test(after) && (!punctAfter || SPACE.test(before) || punctBefore);
  const right = !SPACE.test(before) && (!punctBefore || SPACE.test(after) || punctAfter);
  // `_` may not open or close inside a word, so `stale_after` stays a name.
  const open = char === '_' ? left && (!right || punctBefore) : left;
  const close = char === '_' ? right && (!left || punctAfter) : right;
  return { kind: 'delimiter', char, count: length, length, open, close };
}

/** Where the next run of exactly `length` backticks starts, or -1. */
function closingTicks(text: string, from: number, length: number): number {
  let at = text.indexOf('`', from);
  while (at !== -1) {
    const run = runOf(text, at, '`');
    if (run === length) return at;
    at = text.indexOf('`', at + run);
  }
  return -1;
}

/** A code span's content: line endings become spaces, and one space of padding each side goes. */
function codeSpan(raw: string): string {
  const text = raw.replace(/\n/g, ' ');
  return /^ .*\S.* $/.test(text) ? text.slice(1, -1) : text;
}

/** `[label](destination "title")` starting at `at`, or null if it is not one (yet). */
function linkAt(text: string, at: number): { node: Inline; end: number } | null {
  let depth = 0;
  let close = -1;
  for (let j = at; j < text.length && close === -1; j += 1) {
    if (text[j] === '\\') j += 1;
    else if (text[j] === '[') depth += 1;
    else if (text[j] === ']') {
      depth -= 1;
      if (depth === 0) close = j;
    }
  }
  if (close === -1 || text[close + 1] !== '(') return null;
  let parens = 0;
  let end = -1;
  for (let j = close + 2; j < text.length && end === -1; j += 1) {
    if (text[j] === '\\') j += 1;
    else if (text[j] === '(') parens += 1;
    else if (text[j] === ')') {
      if (parens === 0) end = j;
      parens -= 1;
    }
  }
  if (end === -1) return null;
  const target = text.slice(close + 2, end).trim();
  const angled = /^<([^>]*)>/.exec(target);
  const destination = angled !== null ? angled[1] : target.split(/\s+/)[0];
  return {
    node: {
      kind: 'link',
      href: SAFE_HREF.test(destination) ? destination : null,
      // A link cannot hold another link.
      children: parseInline(text.slice(at + 1, close), false),
    },
    end: end + 1,
  };
}

/** Text to tokens: the atoms (code, wikilinks, links) whole, emphasis as runs to be paired. */
function tokenize(text: string, links: boolean): Token[] {
  const tokens: Token[] = [];
  let plain = '';
  const push = (token: Token) => {
    if (plain !== '') tokens.push(plain);
    plain = '';
    tokens.push(token);
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1] ?? '';
    if (ch === '\\' && (next === '\n' || ESCAPABLE.test(next))) {
      plain += next;
      i += 2;
      continue;
    }
    if (ch === '`') {
      const run = runOf(text, i, '`');
      const end = closingTicks(text, i + run, run);
      if (end === -1) plain += text.slice(i, i + run);
      else push({ kind: 'code', text: codeSpan(text.slice(i + run, end)) });
      i = end === -1 ? i + run : end + run;
      continue;
    }
    if (ch === '[' && next === '[') {
      const end = text.indexOf(']', i + 2);
      if (end > i + 2 && text[end + 1] === ']') {
        // Split exactly as the panel always has: the target is what `onOpen`
        // receives, and the alias only relabels it.
        const [target, alias] = text.slice(i + 2, end).split('|');
        push({ kind: 'wikilink', target, alias });
        i = end + 2;
        continue;
      }
    }
    if (ch === '[' && links) {
      const link = linkAt(text, i);
      if (link !== null) {
        push(link.node);
        i = link.end;
        continue;
      }
    }
    if (ch === '*' || ch === '_' || ch === '~') {
      const run = runOf(text, i, ch);
      // Strikethrough is exactly two tildes — one is "approximately" — and an
      // underscore only ever italicises: `__init__` is a name, not bold.
      if ((ch === '~' && run !== 2) || (ch === '_' && run !== 1)) plain += text.slice(i, i + run);
      else push(delimiter(text, i, run, ch));
      i += run;
      continue;
    }
    plain += ch;
    i += 1;
  }
  if (plain !== '') tokens.push(plain);
  return tokens;
}

function opens(token: Token, closer: Delimiter): boolean {
  if (!isDelimiter(token) || !token.open || token.char !== closer.char) return false;
  if (closer.char === '~') return true;
  // The rule of 3: `*foo**bar*` is one em, not an em beside a stray strong.
  const either = token.close || closer.open;
  const sum = token.length + closer.length;
  return !(either && sum % 3 === 0 && (token.length % 3 !== 0 || closer.length % 3 !== 0));
}

/** Tokens back to nodes; a run nothing matched is the characters it was. */
function flatten(tokens: Token[]): Inline[] {
  const out: Inline[] = [];
  for (const token of tokens) {
    const node = isDelimiter(token) ? token.char.repeat(token.count) : token;
    const last = out[out.length - 1];
    if (typeof node === 'string' && typeof last === 'string') out[out.length - 1] = last + node;
    else if (node !== '') out.push(node);
  }
  return out;
}

/**
 * CommonMark's "process emphasis", without the bookkeeping that only buys
 * speed: each closer takes the nearest opener of its kind, and whatever lies
 * between them — links, code, other emphasis — becomes its children.
 */
function resolveEmphasis(tokens: Token[]): Inline[] {
  let c = 0;
  while (c < tokens.length) {
    const closer = tokens[c];
    if (!isDelimiter(closer) || !closer.close) {
      c += 1;
      continue;
    }
    let o = c - 1;
    while (o >= 0 && !opens(tokens[o], closer)) o -= 1;
    if (o < 0) {
      c += 1;
      continue;
    }
    const opener = tokens[o] as Delimiter;
    const width = closer.char === '~' || (opener.count >= 2 && closer.count >= 2) ? 2 : 1;
    const kind = closer.char === '~' ? 'del' : width === 2 ? 'strong' : 'em';
    tokens.splice(o + 1, c - o - 1, { kind, children: flatten(tokens.slice(o + 1, c)) });
    opener.count -= width;
    closer.count -= width;
    c = o + 2;
    if (opener.count === 0) {
      tokens.splice(o, 1);
      c -= 1;
    }
    // A closer with characters left over is tried again against what precedes it.
    if (closer.count === 0) tokens.splice(c, 1);
  }
  return flatten(tokens);
}

function parseInline(text: string, links = true): Inline[] {
  return resolveEmphasis(tokenize(text, links));
}

// --- Blocks ---------------------------------------------------------------

const FENCE = /^( {0,3})(`{3,}|~{3,})[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}> ?/;
const ITEM = /^( *)([-*+]|\d{1,9}[.)])(?:[ \t]+(.*))?$/;
const DIVIDER = /^:?-+:?$/;

/** Past this, quotes and lists stop nesting and the rest is plain text. */
const MAX_DEPTH = 12;

const indentOf = (line: string): number => line.length - line.trimStart().length;
const isBlank = (line: string): boolean => line.trim() === '';
const isOrdered = (marker: string): boolean => /\d/.test(marker);

function closesFence(line: string, fence: string): boolean {
  const run = line.trim();
  return (
    indentOf(line) <= 3 && run.length >= fence.length && runOf(run, 0, fence[0]) === run.length
  );
}

/** A row's cells. A pipe inside a code span or a `[[target|alias]]` is content, not a border. */
function splitRow(line: string): string[] {
  const row = line
    .trim()
    .replace(/^\|/, '')
    .replace(/(?<!\\)\|$/, '');
  const cells: string[] = [];
  let cell = '';
  for (let i = 0; i < row.length; i += 1) {
    const ch = row[i];
    if (ch === '\\' && row[i + 1] === '|') {
      cell += '|';
      i += 1;
      continue;
    }
    // Where a code span or a wikilink that starts here ends, if it does.
    let end = -1;
    if (ch === '`') end = row.indexOf('`', i + 1);
    else if (row.startsWith('[[', i)) end = row.indexOf(']]', i + 2) + 1;
    if (end > i) {
      cell += row.slice(i, end + 1).replace(/\\\|/g, '|');
      i = end;
    } else if (ch === '|') {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += ch;
    }
  }
  cells.push(cell.trim());
  return cells;
}

function alignOf(divider: string): Align {
  if (divider.startsWith(':')) return divider.endsWith(':') ? 'center' : 'left';
  return divider.endsWith(':') ? 'right' : null;
}

/** A GFM table starts here: a header row, then a divider with as many cells. */
function tableAt(lines: string[], i: number): { head: string[]; align: Align[] } | null {
  const next = lines[i + 1];
  if (next === undefined || !lines[i].includes('|') || !next.includes('|')) return null;
  const divider = splitRow(next);
  if (!divider.every((cell) => DIVIDER.test(cell))) return null;
  const head = splitRow(lines[i]);
  return head.length === divider.length ? { head, align: divider.map(alignOf) } : null;
}

/**
 * Whether line `i` ends the paragraph above it. A list item only does when it
 * has content and, if numbered, counts from 1 — so a sentence that wraps onto
 * "2024. We shipped" stays prose (CommonMark's rule).
 */
function interrupts(lines: string[], i: number): boolean {
  const line = lines[i];
  if ([FENCE, HEADING, RULE, QUOTE].some((re) => re.test(line))) return true;
  if (tableAt(lines, i) !== null) return true;
  const item = ITEM.exec(line);
  if (item === null || (item[3] ?? '').trim() === '') return false;
  return !isOrdered(item[2]) || Number(item[2].slice(0, -1)) === 1;
}

/**
 * A list, and the index after it. An item owns every line indented past its
 * marker — nested lists, continuation text, a fence — dedented and parsed as
 * blocks of its own. Deliberately looser than CommonMark, because models
 * are: two spaces nest under `1.` here, where the spec would start a new list.
 */
function listAt(lines: string[], start: number, depth: number): [Block, number] {
  const first = ITEM.exec(lines[start]) as RegExpExecArray;
  const indent = first[1].length;
  const ordered = isOrdered(first[2]);
  const sibling = (line: string | undefined): RegExpExecArray | null => {
    const item = line === undefined ? null : ITEM.exec(line);
    return item !== null && item[1].length <= indent && isOrdered(item[2]) === ordered
      ? item
      : null;
  };
  const items: Block[][] = [];
  let i = start;
  for (let item = sibling(lines[i]); item !== null; item = sibling(lines[i])) {
    const content = item[1].length + item[2].length + 1;
    const body = [item[3] ?? ''];
    i += 1;
    while (i < lines.length) {
      if (isBlank(lines[i])) {
        let next = i;
        while (next < lines.length && isBlank(lines[next])) next += 1;
        if (next === lines.length || indentOf(lines[next]) <= indent) break;
        body.push(...lines.slice(i, next).map(() => ''));
        i = next;
      } else if (indentOf(lines[i]) > indent) {
        body.push(lines[i].slice(Math.min(indentOf(lines[i]), content)));
        i += 1;
      } else {
        break;
      }
    }
    items.push(blocksOf(body, depth + 1));
    // Items a blank line apart are still one list: a loose list reads the
    // same in a chat column, and a numbered one keeps counting.
    let next = i;
    while (next < lines.length && isBlank(lines[next])) next += 1;
    if (sibling(lines[next]) === null) break;
    i = next;
  }
  return [{ kind: 'list', ordered, start: ordered ? parseInt(first[2], 10) : 1, items }, i];
}

function blocksOf(lines: string[], depth: number): Block[] {
  if (depth > MAX_DEPTH) return [{ kind: 'paragraph', inline: [lines.join('\n').trim()] }];
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      i += 1;
      continue;
    }

    // Fenced code first, so nothing inside it is read as markdown.
    const fence = FENCE.exec(line);
    if (fence !== null) {
      const pad = fence[1].length;
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !closesFence(lines[i], fence[2])) {
        code.push(lines[i].slice(Math.min(indentOf(lines[i]), pad)));
        i += 1;
      }
      i += 1; // the closing fence — or the end of a reply still streaming
      blocks.push({ kind: 'code', text: code.join('\n') });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading !== null) {
      const level = Math.min(heading[1].length, 3) as 1 | 2 | 3;
      blocks.push({ kind: 'heading', level, inline: parseInline(heading[2] ?? '') });
      i += 1;
      continue;
    }

    if (RULE.test(line)) {
      blocks.push({ kind: 'rule' });
      i += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) {
        quoted.push(lines[i].replace(QUOTE, ''));
        i += 1;
      }
      blocks.push({ kind: 'quote', blocks: blocksOf(quoted, depth + 1) });
      continue;
    }

    const table = tableAt(lines, i);
    if (table !== null) {
      const rows: Inline[][][] = [];
      i += 2;
      while (i < lines.length && !isBlank(lines[i]) && lines[i].includes('|')) {
        const cells = splitRow(lines[i]);
        rows.push(table.head.map((_, c) => parseInline(cells[c] ?? '')));
        i += 1;
      }
      const head = table.head.map((cell) => parseInline(cell));
      blocks.push({ kind: 'table', align: table.align, head, rows });
      continue;
    }

    if (ITEM.test(line)) {
      const [list, next] = listAt(lines, i, depth);
      blocks.push(list);
      i = next;
      continue;
    }

    const paragraph = [line.trim()];
    i += 1;
    while (i < lines.length && !isBlank(lines[i]) && !interrupts(lines, i)) {
      paragraph.push(lines[i].trim());
      i += 1;
    }
    blocks.push({ kind: 'paragraph', inline: parseInline(paragraph.join('\n')) });
  }
  return blocks;
}

function parseBlocks(text: string): Block[] {
  // Leading tabs count as four columns, so a tab-indented sublist still nests.
  const lines = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/^[ \t]+/, (pad) => pad.replace(/\t/g, '    ')));
  return blocksOf(lines, 0);
}

// --- Rendering --------------------------------------------------------------

interface RenderContext {
  entries: Entry[];
  onOpen: (target: string) => void;
}

const WIKILINK =
  'cursor-pointer border-0 bg-transparent p-0 text-cortex-600 underline decoration-cortex-200 underline-offset-2 hover:decoration-cortex-500';

const HEADING_CLASS = {
  1: 'mt-3 text-lg leading-[22px] font-semibold text-n-900 first:mt-0',
  2: 'mt-3 text-md font-semibold text-n-900 first:mt-0',
  3: 'mt-2.5 text-sm font-semibold text-n-900 first:mt-0',
} as const;

const alignment = (align: Align): CSSProperties | undefined =>
  align === null ? undefined : { textAlign: align };

/** `inLink`: a wikilink inside a link's label is its label — a button cannot sit in an anchor. */
function renderInline(nodes: Inline[], ctx: RenderContext, inLink = false): ReactNode[] {
  return nodes.map((node, i) => {
    if (typeof node === 'string') {
      // Every newline the agent wrote is a line break, as it was when replies
      // rendered pre-wrapped.
      if (!node.includes('\n')) return node;
      return (
        <Fragment key={i}>
          {node.split('\n').flatMap((line, n) => (n === 0 ? [line] : [<br key={n} />, line]))}
        </Fragment>
      );
    }
    switch (node.kind) {
      case 'code':
        return (
          <code
            key={i}
            className="rounded-xs bg-n-100 px-1 py-px text-xs text-n-800 [font-family:var(--font-mono)]"
          >
            {node.text}
          </code>
        );
      case 'wikilink': {
        const label = node.alias ?? resolveTarget(node.target, ctx.entries)?.title ?? node.target;
        if (inLink) return <Fragment key={i}>{label}</Fragment>;
        return (
          <button
            key={i}
            type="button"
            onClick={() => ctx.onOpen(node.target)}
            className={WIKILINK}
          >
            {label}
          </button>
        );
      }
      case 'link': {
        const label = renderInline(node.children, ctx, true);
        if (node.href === null) return <Fragment key={i}>{label}</Fragment>;
        return (
          <a
            key={i}
            href={node.href}
            title={node.href}
            target="_blank"
            rel="noreferrer noopener"
            className="text-cortex-600 underline decoration-cortex-200 underline-offset-2 hover:decoration-cortex-500"
          >
            {label}
          </a>
        );
      }
      default: {
        const Tag = node.kind;
        return <Tag key={i}>{renderInline(node.children, ctx, inLink)}</Tag>;
      }
    }
  });
}

function renderBlocks(blocks: Block[], ctx: RenderContext): ReactNode[] {
  return blocks.map((block, i) => {
    switch (block.kind) {
      case 'paragraph':
        return <p key={i}>{renderInline(block.inline, ctx)}</p>;
      case 'heading': {
        const Tag = `h${block.level}` as const;
        return (
          <Tag key={i} className={HEADING_CLASS[block.level]}>
            {renderInline(block.inline, ctx)}
          </Tag>
        );
      }
      case 'code':
        return (
          <pre
            key={i}
            className="overflow-x-auto rounded-md border border-n-200 bg-n-25 px-2.5 py-2 text-xs leading-[17px] text-n-800 [font-family:var(--font-mono)]"
          >
            <code>{block.text}</code>
          </pre>
        );
      case 'rule':
        return <hr key={i} className="border-0 border-t border-solid border-n-200" />;
      case 'quote':
        return (
          <blockquote
            key={i}
            className="space-y-2 border-0 border-l-2 border-solid border-n-200 pl-2.5 text-n-600"
          >
            {renderBlocks(block.blocks, ctx)}
          </blockquote>
        );
      case 'list': {
        const items = block.items.map((item, n) => (
          <li key={n} className="space-y-1">
            {renderBlocks(item, ctx)}
          </li>
        ));
        const marks = 'space-y-1 pl-5 marker:text-n-500';
        return block.ordered ? (
          <ol key={i} start={block.start} className={`${marks} list-decimal`}>
            {items}
          </ol>
        ) : (
          <ul key={i} className={`${marks} list-disc`}>
            {items}
          </ul>
        );
      }
      case 'table':
        return (
          <div key={i} className="overflow-x-auto">
            <table className="w-full border-collapse text-xs leading-[17px]">
              <thead>
                <tr>
                  {block.head.map((cell, c) => (
                    <th
                      key={c}
                      style={alignment(block.align[c])}
                      className="border-0 border-b border-solid border-n-200 px-1.5 py-1 text-left font-semibold text-n-900"
                    >
                      {renderInline(cell, ctx)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, r) => (
                  <tr key={r}>
                    {row.map((cell, c) => (
                      <td
                        key={c}
                        style={alignment(block.align[c])}
                        className="border-0 border-b border-solid border-n-100 px-1.5 py-1 align-top"
                      >
                        {renderInline(cell, ctx)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
    }
  });
}

/** An assistant reply, rendered: blocks, inline marks, and `[[wikilinks]]` made real. */
export function MessageText({ text, onOpen }: { text: string; onOpen: (target: string) => void }) {
  const entries = useVaultStore((s) => s.entries);
  const blocks = useMemo(() => parseBlocks(text), [text]);
  return <div className="space-y-2">{renderBlocks(blocks, { entries, onOpen })}</div>;
}
