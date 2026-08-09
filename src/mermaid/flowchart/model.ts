/**
 * The line-oriented flowchart model (M29.14).
 *
 * Every source line is either UNDERSTOOD (header, node definition, edge line —
 * chains and & groups included — subgraph markers, `@{ … }` metadata, `style`)
 * or OPAQUE (frontmatter, comments, classDef/class/linkStyle/click, and
 * anything the parser is not 100% sure about, a half-owned `style` body
 * included). Serialization re-emits `raw` for every non-dirty line,
 * so opaque content survives byte-for-byte BY CONSTRUCTION — the invariant the
 * whole structural editor stands on.
 */

export type Direction = 'TD' | 'TB' | 'LR' | 'RL' | 'BT';
export type Shape =
  'rect' | 'rounded' | 'stadium' | 'circle' | 'diamond' | 'hexagon' | 'cylinder' | 'subroutine';

export type EdgeStroke = 'normal' | 'thick' | 'dotted' | 'invisible';
export type EdgeHead = 'arrow' | 'open' | 'circle' | 'cross' | 'double';

/**
 * One edge's arrow (M29.31). `raw` is the verbatim source token and the
 * emission truth — an untouched segment re-emits its exact bytes even when a
 * line-mate goes dirty, and author-chosen lengths (`----->`) survive until
 * the segment itself is rewritten. `stroke`/`head` are the parsed reading;
 * `head: 'double'` covers <-->, o--o, and x--x, whose marker family lives in
 * `raw` (and is preserved by emitArrow on stroke-only rewrites).
 */
export interface EdgeArrow {
  stroke: EdgeStroke;
  head: EdgeHead;
  raw: string;
}

export const DEFAULT_ARROW: EdgeArrow = { stroke: 'normal', head: 'arrow', raw: '-->' };

export interface NodeRef {
  id: string;
  /** Label carried at this reference site (`A[Start]`), or null for a bare `A`. */
  label: string | null;
  shape: Shape | null;
}

/**
 * Metadata carried by an `id@{ … }` line (M29.29) — mermaid v11.3+'s door to
 * the full shape registry, icons, and (for edge ids) animation.
 *
 * `entries` is the emission source of truth: EVERY key in source order,
 * unknown ones included, values stored unquoted. The typed fields are
 * derived views over `entries` for the keys we understand — always rebuilt
 * through `buildMeta`/`withMetaEntry`, never written directly, so they can
 * never drift from the entries they mirror.
 */
export interface NodeMeta {
  entries: [string, string][];
  shape?: string;
  icon?: string;
  form?: string;
  pos?: string;
  label?: string;
}

const TYPED_META_KEYS = ['shape', 'icon', 'form', 'pos', 'label'] as const;

function buildMeta(entries: [string, string][]): NodeMeta {
  const meta: NodeMeta = { entries };
  for (const [key, value] of entries) {
    if ((TYPED_META_KEYS as readonly string[]).includes(key)) {
      meta[key as (typeof TYPED_META_KEYS)[number]] = value;
    }
  }
  return meta;
}

/**
 * Ordered entries with `key` set (replacing in place, order kept) or removed
 * (`null`) — the one implementation behind both meta bodies and style
 * declarations, so the two can never disagree about ordering or about what a
 * duplicate key means.
 */
export function withEntry(
  entries: [string, string][],
  key: string,
  value: string | null,
): [string, string][] {
  const out: [string, string][] = [];
  let replaced = false;
  for (const [k, v] of entries) {
    if (k === key) {
      if (value !== null && !replaced) {
        out.push([k, value]);
        replaced = true;
      }
      // value === null → drop; a duplicate key collapses onto its first site
    } else {
      out.push([k, v]);
    }
  }
  if (value !== null && !replaced) out.push([key, value]);
  return out;
}

/** New meta with `key` set (replacing in place, order kept) or removed (`null`). */
export function withMetaEntry(meta: NodeMeta, key: string, value: string | null): NodeMeta {
  return buildMeta(withEntry(meta.entries, key, value));
}

/**
 * A bare value starting with one of these is YAML syntax, not text: a
 * single-quoted scalar, an anchor, an alias, a tag, or a comment. Mermaid
 * runs the body through `yaml.load` (flowDb.ts:146-151), so for these the
 * text we can see is NOT the value mermaid gets — and re-emitting our reading
 * of it would change what renders. We refuse to own the line instead.
 */
const YAML_SIGIL_PREFIX = /^['&*!#]/;

/**
 * Parse a single-line `@{ … }` body — a YAML flow mapping that mermaid feeds
 * to `yaml.load` (flowDb.ts:146-151), lexed by `flow.jison`. We own a body
 * only when its text and its YAML value are the same thing:
 *
 * - Bare `{` `}` `^` are outside the lexer's `[^}^"]+` class; INSIDE quotes
 *   `flow.jison:52` is `[^\"]+`, so both are perfectly legal there.
 * - A whitespace-preceded `#` opens a YAML comment, so the value mermaid sees
 *   is shorter than the text — `shape: cyl # note` means `cyl`.
 * - A bare value opening with a YAML sigil means something other than itself.
 *
 * Any violation → null → the line goes opaque, which is never wrong.
 */
function parseMetaBody(body: string): NodeMeta | null {
  // ONE quote-aware scan does the splitting and the structural guard together,
  // so the two can never disagree about what "inside a quoted string" means —
  // the bug that let us emit `label: "a}b"` and then disown it.
  const parts: string[] = [];
  let quote = false;
  let cur = '';
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === '"') {
      quote = !quote;
      cur += ch;
      continue;
    }
    if (!quote) {
      if (ch === '{' || ch === '}' || ch === '^') return null;
      if (ch === '#' && (i === 0 || /\s/.test(body[i - 1]))) return null;
      if (ch === ',') {
        parts.push(cur);
        cur = '';
        continue;
      }
    }
    cur += ch;
  }
  if (quote) return null;
  parts.push(cur);

  const entries: [string, string][] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    const item = part.trim();
    if (item === '') return null;
    const colon = item.indexOf(':');
    if (colon === -1) return null;
    const key = item.slice(0, colon).trim();
    let value = item.slice(colon + 1).trim();
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(key)) return null;
    // A repeated key is a YAML error, not a last-wins merge: `yaml.load`
    // refuses the whole document (measured on 11.16.0 — `A@{ shape: cyl,
    // shape: hex }` → `duplicated mapping key (2:14)`), so a body we read
    // happily here is one mermaid will not render at all. Owning a line the
    // renderer rejects breaks the boundary this parser exists to hold.
    if (seen.has(key)) return null;
    seen.add(key);
    if (value.startsWith('"')) {
      if (value.length < 2 || !value.endsWith('"')) return null;
      value = value.slice(1, -1);
      if (value.includes('"')) return null;
    } else if (value === '' || /[:"]/.test(value) || YAML_SIGIL_PREFIX.test(value)) {
      return null;
    }
    entries.push([key, value]);
  }
  return buildMeta(entries);
}

export interface EdgeSegment {
  from: NodeRef[];
  to: NodeRef[];
  arrow: EdgeArrow;
  label: string | null;
  /** `A e1@--> B` — the id riding this segment's arrow, or null. */
  id: string | null;
}

export type ParsedLine =
  | { kind: 'header'; keyword: 'flowchart' | 'graph'; direction: Direction }
  | { kind: 'node'; node: NodeRef }
  | { kind: 'node-meta'; id: string; meta: NodeMeta }
  | { kind: 'style'; id: string; decls: [string, string][] }
  | { kind: 'edges'; segments: EdgeSegment[] }
  | { kind: 'subgraph-start'; title: string }
  | { kind: 'subgraph-end' }
  | { kind: 'opaque' };

export interface ModelLine {
  raw: string;
  parsed: ParsedLine;
  dirty: boolean;
}

export interface FlowchartModel {
  lines: ModelLine[];
}

const OPAQUE_KEYWORDS = /^(classDef|class|style|linkStyle|click|direction|accTitle|accDescr)\b/;

/** Bracket pairs, longest opener first — order is load-bearing. */
const SHAPES: [string, string, Shape][] = [
  ['((', '))', 'circle'],
  ['([', '])', 'stadium'],
  ['[[', ']]', 'subroutine'],
  ['[(', ')]', 'cylinder'],
  ['{{', '}}', 'hexagon'],
  ['[', ']', 'rect'],
  ['(', ')', 'rounded'],
  ['{', '}', 'diamond'],
];

export const SHAPE_BRACKETS: Record<Shape, [string, string]> = {
  circle: ['((', '))'],
  stadium: ['([', '])'],
  subroutine: ['[[', ']]'],
  cylinder: ['[(', ')]'],
  hexagon: ['{{', '}}'],
  rect: ['[', ']'],
  rounded: ['(', ')'],
  diamond: ['{', '}'],
};

const ID_PATTERN = /^[A-Za-z0-9_.-]+/;

/** `A[Start]` → ref; `A` → bare ref; anything not fully consumed → null. */
export function parseNodeToken(token: string): NodeRef | null {
  const t = token.trim();
  const idMatch = t.match(ID_PATTERN);
  if (idMatch === null) return null;
  const id = idMatch[0];
  const rest = t.slice(id.length);
  if (rest === '') return { id, label: null, shape: null };
  for (const [open, close, shape] of SHAPES) {
    if (
      rest.startsWith(open) &&
      rest.endsWith(close) &&
      rest.length >= open.length + close.length
    ) {
      let label = rest.slice(open.length, rest.length - close.length);
      if (label.startsWith('"') && label.endsWith('"') && label.length >= 2) {
        label = label.slice(1, -1);
      }
      if (label.includes('[') || label.includes(']')) return null; // nested brackets → not ours
      return { id, label, shape };
    }
  }
  return null;
}

/** Top-level `&` split — respects brackets and quotes. */
function splitGroup(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = false;
  let cur = '';
  for (const ch of text) {
    if (ch === '"') quote = !quote;
    if (!quote) {
      if ('[({'.includes(ch)) depth += 1;
      if ('])}'.includes(ch)) depth -= 1;
      if (ch === '&' && depth === 0) {
        parts.push(cur);
        cur = '';
        continue;
      }
    }
    cur += ch;
  }
  parts.push(cur);
  return parts;
}

const HEAD_BY_MARKER: Record<string, EdgeHead> = { '>': 'arrow', o: 'circle', x: 'cross' };
const DOUBLE_PAIR: Record<string, string> = { '<': '>', o: 'o', x: 'x' };

/**
 * Read one already-matched arrow token, or refuse it.
 *
 * MEASURED on mermaid 11.16.0, because the obvious reading is wrong: a
 * mismatched pair like `o--x` is NOT a parse error. `destructEndLink`
 * (flowDb.ts:865-912) looks only at the LAST character to pick the head, and
 * then treats everything before it — the leading `o` included — as line
 * material whose length becomes the edge's minlen. So `A o--x B` renders as a
 * plain cross arrow one rank longer than `A --x B`, with the circle silently
 * gone. (`INVALID` does exist, at flowDb.ts:920-931, but only for the
 * two-token `A x-- text --o B` form, which we never own.)
 *
 * We cannot represent "start marker swallowed into the length", so we refuse:
 * the line goes opaque and its bytes survive, which is never wrong.
 */
function classifyArrow(
  token: string,
  stroke: EdgeStroke,
  start: string | undefined,
  end: string | undefined,
  bodyLen: number,
): { token: string; stroke: EdgeStroke; head: EdgeHead } | null {
  if (start !== undefined && end !== undefined) {
    if (DOUBLE_PAIR[start] !== end) return null; // o--x, <--o … we cannot reproduce
    return { token, stroke, head: 'double' };
  }
  if (start !== undefined) return null; // a lone `<--` is START_LINK, not a link
  if (end !== undefined) return { token, stroke, head: HEAD_BY_MARKER[end] };
  // No markers → open, which needs one body char beyond the minimum
  // (`---`, `===`; dotted's shortest form `-.-` is already open).
  if (stroke === 'dotted') return { token, stroke, head: 'open' };
  return bodyLen >= 3 ? { token, stroke, head: 'open' } : null;
}

/**
 * Match one arrow token anchored at `i`, or null. Mirrors the v11.16.1 lexer
 * rules (flow.jison:156-169) — `[xo<]?--+[-xo>]`, `[xo<]?==+[=xo>]`,
 * `[xo<]?-?\.+-[xo>]?`, `~~~+` — with two deliberate narrowings, both of
 * which only ever cost editability:
 *
 * - the two-dash `--`/`==`/`-.` forms are START_LINK (they open the
 *   `A -- text --> B` state), never a link on their own, so we require the
 *   closing character mermaid does;
 * - the dotted rule's leading `-` is optional upstream (`A .-> B` is a real
 *   dotted arrow) but required here, so that form goes opaque.
 *
 * The LEFT BOUNDARY is load-bearing and was missing at first. `o` and `x` are
 * ordinary `NODE_STRING` characters (flow.jison:207), so a marker only starts
 * a link where an id could not have continued: measured, `Foo--oBar` is
 * `Foo --o Bar`, NOT `Fo o--o Bar`, and reading it the second way both
 * invented a node `Fo` and lost `Foo` — after which any edit that dirtied the
 * line silently renamed the node. `<` is exempt: it is not an id character,
 * so `A<-->B` was never ambiguous.
 */
function matchArrow(
  text: string,
  i: number,
): { token: string; stroke: EdgeStroke; head: EdgeHead } | null {
  const slice = text.slice(i);
  const startOk = i === 0 || !/[A-Za-z0-9_.-]/.test(text[i - 1]);
  let m = slice.match(/^([<ox])?(-{2,}|={2,})([>ox])?/);
  if (m !== null) {
    if (m[1] !== undefined && m[1] !== '<' && !startOk) return null;
    const stroke: EdgeStroke = m[2][0] === '=' ? 'thick' : 'normal';
    return classifyArrow(m[0], stroke, m[1], m[3], m[2].length);
  }
  m = slice.match(/^([<ox])?-(\.+)-([>ox])?/);
  if (m !== null) {
    if (m[1] !== undefined && m[1] !== '<' && !startOk) return null;
    return classifyArrow(m[0], 'dotted', m[1], m[3], m[2].length + 2);
  }
  m = slice.match(/^~{3,}/);
  if (m !== null) {
    return { token: m[0], stroke: 'invisible', head: 'open' };
  }
  return null;
}

/**
 * The minimum-length token for a stroke × head. `prevRaw` keeps an existing
 * o/x double family alive across rewrites; heads have no meaning on `~~~`.
 *
 * Every string this can produce is a token `matchArrow` reads back to the same
 * stroke and head — the last-boundary discipline, proven exhaustively in
 * model.test.ts rather than asserted here.
 */
export function emitArrow(stroke: EdgeStroke, head: EdgeHead, prevRaw: string): string {
  if (stroke === 'invisible') return '~~~';
  const core = stroke === 'thick' ? '==' : stroke === 'dotted' ? '-.-' : '--';
  if (head === 'double') {
    const start = prevRaw.startsWith('o') || prevRaw.startsWith('x') ? prevRaw[0] : '<';
    return `${start}${core}${start === '<' ? '>' : start}`;
  }
  if (head === 'open') return stroke === 'dotted' ? core : `${core}${core[0]}`;
  const marker = head === 'arrow' ? '>' : head === 'circle' ? 'o' : 'x';
  return `${core}${marker}`;
}

/** `A & B -->|go| C --> D` → segments, or null when any piece is not ours. */
export function parseEdgeLine(trimmed: string): EdgeSegment[] | null {
  interface Piece {
    text?: string;
    arrow?: EdgeArrow;
    label?: string | null;
    id?: string | null;
  }
  const pieces: Piece[] = [];
  let depth = 0;
  let quote = false;
  let cur = '';
  let i = 0;
  while (i < trimmed.length) {
    const ch = trimmed[i];
    if (ch === '"') quote = !quote;
    if (!quote && depth === 0) {
      const hit = matchArrow(trimmed, i);
      if (hit !== null) {
        // `A e1@--> B`: an edge id rides the arrow token (lexer
        // flow.jison:146, `[^\s"]+@(?=[^{"])`).
        let text = cur;
        let id: string | null = null;
        const idMatch = text.match(/(?:^|\s)([^\s"]+)@$/);
        if (idMatch !== null) {
          // `A a@b@--> B` is legal but does not mean what it looks like:
          // `addLink` strips the FIRST `@` from the token (flowDb.ts:353,
          // `linkData.id.replace('@', '')`), so mermaid's id is `ab@` while
          // the text says `a@b` — and `ab@@{ … }`, the only line that could
          // then address it, is itself a parse error (measured). An id we
          // cannot name correctly is one we refuse to own.
          if (idMatch[1].includes('@')) return null;
          id = idMatch[1];
          text = text.slice(0, text.length - id.length - 1);
        }
        pieces.push({ text });
        cur = '';
        i += hit.token.length;
        let label: string | null = null;
        if (trimmed[i] === '|') {
          const close = trimmed.indexOf('|', i + 1);
          if (close === -1) return null;
          label = trimmed.slice(i + 1, close);
          i = close + 1;
          // A quoted edge label means its CONTENTS, not the quotes: mermaid
          // strips a surrounding pair before storing (flowDb.ts:304-306),
          // exactly as parseNodeToken does for brackets. Storing the stripped
          // text is what lets emitEdgeLabel quote back only when it must —
          // without this the two would fight and `|"a(b)"|` would re-emit as
          // `|"'a(b)'"|`, quietly changing the label.
          if (label.length >= 2 && label.startsWith('"') && label.endsWith('"')) {
            label = label.slice(1, -1);
          }
          // `A -->|| B` and `A -->|""| B` are both PARSE ERRORS upstream —
          // `arrowText: PIPE text PIPE` (flow.jison:501) needs at least one
          // token, and `| |` is the shortest thing that satisfies it
          // (measured: it yields the empty label). A line mermaid cannot
          // parse is not one we may claim to own, so it goes opaque with its
          // bytes intact.
          if (label === '') return null;
        }
        // `A ~~~|no| B` IS valid mermaid (measured: an invisible link labeled
        // "no"), but setEdgeArrow drops the label on the way into invisible,
        // so owning this form would give the model a state our own ops can
        // never produce. Refusing keeps "invisible ⇒ no label" true of every
        // line we own, and costs only editability.
        if (label !== null && hit.stroke === 'invisible') return null;
        pieces.push({ arrow: { stroke: hit.stroke, head: hit.head, raw: hit.token }, label, id });
        continue;
      }
    }
    if (!quote) {
      if ('[({'.includes(ch)) depth += 1;
      if ('])}'.includes(ch)) depth -= 1;
    }
    cur += ch;
    i += 1;
  }
  pieces.push({ text: cur });

  if (pieces.length < 3 || pieces.length % 2 === 0) return null;
  const groups: NodeRef[][] = [];
  const arrows: { arrow: EdgeArrow; label: string | null; id: string | null }[] = [];
  for (let p = 0; p < pieces.length; p += 1) {
    if (p % 2 === 0) {
      const tokens = splitGroup(pieces[p].text ?? '');
      const refs: NodeRef[] = [];
      for (const token of tokens) {
        if (token.trim() === '') return null;
        const ref = parseNodeToken(token);
        if (ref === null) return null;
        refs.push(ref);
      }
      groups.push(refs);
    } else {
      const piece = pieces[p];
      if (piece.arrow === undefined) return null;
      arrows.push({ arrow: piece.arrow, label: piece.label ?? null, id: piece.id ?? null });
    }
  }
  const segments: EdgeSegment[] = [];
  for (let s = 0; s < arrows.length; s += 1) {
    segments.push({
      from: groups[s],
      to: groups[s + 1],
      arrow: arrows[s].arrow,
      label: arrows[s].label,
      id: arrows[s].id,
    });
  }
  return segments;
}

/**
 * Characters a `style` declaration's value may carry. mermaid builds one
 * declaration by concatenating `styleComponent`s — `NUM | NODE_STRING | COLON
 * | SPACE | BRKT | STYLE` (flow.jison:594; the rule also lists `UNIT` and
 * `PCT`, which no lexer rule ever returns — `%` reaches values through
 * `NODE_STRING`, flow.jison:208). Characters outside that set are the reason
 * to refuse:
 *
 * - `(` pushes the `text` lexer state (flow.jison), so `rgb(0,0,0)`,
 *   `var(--x)` and `calc(…)` are genuine parse errors that kill the diagram.
 * - `"`, `=`, `^`, `~`, `@`, `<`, `{` either fail to lex or mean something
 *   structural.
 * - `,` is the separator itself, handled by the split above this.
 * - `\` is a `classDef` escape (flowDb.ts:415-421), NOT a `style` one; in a
 *   style line mermaid accepts `fill:#f96\,stroke:red` and renders TWO
 *   declarations, the first ending in a literal backslash.
 *
 * The set is deliberately tighter than mermaid's: `;`, `!`, `'`, `/` and `\`
 * all render fine, and refusing them costs only editability (the line goes
 * opaque and its bytes survive), never correctness. Loosening it is a
 * recorded, deliberate future call rather than an oversight.
 *
 * Note `;` in particular is NOT a phantom-node hazard: `encodeEntities`
 * (utils.ts:895-903) deletes the trailing `;` from any `style … : … # … ;`
 * line before parsing, so `style A fill:#f96;,color:#000` reaches the lexer as
 * `style A fill:#f96,color:#000` and renders identically to it.
 */
const STYLE_VALUE_SAFE = /^[A-Za-z0-9#%._ \t-]+$/;

/** `fill:#f96,stroke:#333` → declarations, or null when any part is not ours. */
function parseStyleDecls(text: string): [string, string][] | null {
  const decls: [string, string][] = [];
  for (const part of text.split(',')) {
    const item = part.trim();
    if (item === '') return null;
    const colon = item.indexOf(':');
    if (colon === -1) return null;
    const key = item.slice(0, colon).trim();
    const value = item.slice(colon + 1).trim();
    if (!/^[A-Za-z-]+$/.test(key)) return null;
    if (!STYLE_VALUE_SAFE.test(value)) return null;
    decls.push([key, value]);
  }
  return decls;
}

/**
 * `key: value` normalized exactly as `parseStyleDecls` would read it back, or
 * null when it would not — the last boundary before a style line reaches the
 * file, the counterpart to `emitMetaValue`. Without it a caller can hand
 * `setNodeStyle` a value like `rgb(1,2,3)` or `var(--brand)` and emit a line
 * that kills the whole diagram, or `#f96,stroke:#000` and inject a second
 * declaration out of one key.
 *
 * `value` may be null to validate a removal, whose key still has to be one we
 * could have written.
 */
export function styleDecl(key: string, value: string | null): [string, string | null] | null {
  const probe = parseStyleDecls(`${key}:${value ?? 'x'}`);
  if (probe === null || probe.length !== 1) return null;
  return [probe[0][0], value === null ? null : probe[0][1]];
}

function parseLine(rawLine: string): ParsedLine {
  const trimmed = rawLine.trim();
  if (trimmed === '' || trimmed.startsWith('%%')) return { kind: 'opaque' };

  // `style <id> k:v,…`, tested BEFORE the keyword blocklist so that every
  // other shape of `style` line — a bare `style`, `style[X]`, an uppercase
  // `STYLE` — keeps falling through to the blocklist and staying opaque
  // instead of minting a phantom node called `style`. A body we cannot own
  // 100% (a declaration with no colon, a value outside STYLE_VALUE_SAFE)
  // sends the WHOLE line opaque, never a guess.
  const styleMatch = trimmed.match(/^style\s+([A-Za-z0-9_.-]+)\s+(\S.*)$/);
  if (styleMatch !== null) {
    const decls = parseStyleDecls(styleMatch[2]);
    return decls === null ? { kind: 'opaque' } : { kind: 'style', id: styleMatch[1], decls };
  }
  if (OPAQUE_KEYWORDS.test(trimmed)) return { kind: 'opaque' };

  const header = trimmed.match(/^(flowchart|graph)\s+(TD|TB|LR|RL|BT)\s*$/);
  if (header !== null) {
    return {
      kind: 'header',
      keyword: header[1] as 'flowchart' | 'graph',
      direction: header[2] as Direction,
    };
  }

  const sub = trimmed.match(/^subgraph\s+(.+)$/);
  if (sub !== null) return { kind: 'subgraph-start', title: sub[1] };
  if (trimmed === 'end') return { kind: 'subgraph-end' };
  // Anonymous subgraph (valid mermaid, no title): not structurally editable,
  // so it goes opaque rather than falling into the node-token fallback below
  // (which would otherwise mint a phantom node with id "subgraph").
  if (trimmed === 'subgraph') return { kind: 'opaque' };

  // `id@{ … }` on one line — node metadata, or edge metadata for an edge id
  // (identical syntax; nodes()/ops tell them apart by what the id names).
  // Failure to own the body means opaque, never a guess. The bracket+meta
  // hybrid `A[Label]@{ … }` does not match this pattern (the id charset has
  // no `[`), falls through, fails the node-token attempt, and lands opaque —
  // decided and proven in M29.29's tests.
  const metaMatch = trimmed.match(/^([A-Za-z0-9_.-]+)@\{(.*)\}$/);
  if (metaMatch !== null) {
    const meta = parseMetaBody(metaMatch[2]);
    return meta === null ? { kind: 'opaque' } : { kind: 'node-meta', id: metaMatch[1], meta };
  }

  // parseEdgeLine is its own arbiter: no arrow, or any piece not fully ours,
  // → null, and the line falls through to the node-token attempt below. (An
  // arrow substring inside a node's own label — `A[Contains --> text]` — is
  // exactly why a substring pre-gate would be the wrong signal: the scanner's
  // bracket depth is what settles it.)
  const segments = parseEdgeLine(trimmed);
  if (segments !== null) return { kind: 'edges', segments };

  const node = parseNodeToken(trimmed);
  if (node !== null) return { kind: 'node', node };

  return { kind: 'opaque' };
}

/**
 * Parse, or refuse. Refusal (`null`) means "not a flowchart we can edit at
 * all": no recognizable `flowchart|graph <DIR>` header outside frontmatter.
 * Individual weird lines never cause refusal — they go opaque.
 */
export function parseFlowchart(code: string): FlowchartModel | null {
  const rawLines = code.split('\n');
  const lines: ModelLine[] = [];
  let i = 0;

  // Top frontmatter block is opaque wholesale (setLayoutEngine edits its raws).
  if (rawLines[0]?.trim() === '---') {
    lines.push({ raw: rawLines[0], parsed: { kind: 'opaque' }, dirty: false });
    i = 1;
    while (i < rawLines.length && rawLines[i].trim() !== '---') {
      lines.push({ raw: rawLines[i], parsed: { kind: 'opaque' }, dirty: false });
      i += 1;
    }
    if (i < rawLines.length) {
      lines.push({ raw: rawLines[i], parsed: { kind: 'opaque' }, dirty: false });
      i += 1;
    }
  }

  let sawHeader = false;
  for (; i < rawLines.length; i += 1) {
    const parsed = parseLine(rawLines[i]);
    if (parsed.kind === 'header') sawHeader = true;
    lines.push({ raw: rawLines[i], parsed, dirty: false });
  }
  return sawHeader ? { lines } : null;
}

/**
 * Bracket labels: quote whatever mermaid's `text` lexer state cannot take
 * bare. Measured char by char against 11.16.0 — `"()@[]{|}` are parse errors
 * unquoted and every one of them but `"` itself is fine inside quotes, so
 * quoting is lossless and `parseNodeToken` strips the quotes back off.
 *
 * `@` was the gap: `A[a@b]` kills the whole diagram, which made a rename to
 * any label carrying an `@` (an email, a handle) a render-stopper.
 */
function quoteLabel(label: string): string {
  return /[|()[\]{}&"@]/.test(label) ? `"${label.replaceAll('"', "'")}"` : label;
}

/**
 * Edge labels answer to the same lexer state as bracket labels, so the same
 * characters are fatal bare — measured: `-->|Deploy (prod)|` is a PARSE
 * ERROR, and so are `@ [ ] { } "`. Every one of them is legal quoted, and
 * mermaid strips the quotes again (flowDb.ts:304-306), so quoting is
 * lossless and parseEdgeLine reads it straight back.
 *
 * `|` is the one character quoting cannot rescue HERE: a quoted pipe is legal
 * upstream but our own scanner closes the label at the first `|` it sees, so
 * `setEdgeLabel` substitutes `|` → `/` before this ever runs — the Stage-C
 * scar, kept on purpose. Everything else is preserved, never dropped.
 */
function quoteEdgeLabel(label: string): string {
  return /[()[\]{}"@]/.test(label) ? `"${label.replaceAll('"', "'")}"` : label;
}

/** `|label|`, or nothing. Empty is "no label": `-->||` is a parse error. */
function emitEdgeLabel(label: string | null): string {
  return label === null || label === '' ? '' : `|${quoteEdgeLabel(label)}|`;
}

/**
 * Quote a meta value whenever bare text would not mean itself: the flow
 * mapping's own structural characters (`,` `:` `{` `}`), a `^` (illegal bare
 * per `flow.jison:57`, fine quoted per `flow.jison:52`), a comment-opening
 * ` #`, a leading YAML sigil, or edge whitespace/emptiness.
 *
 * Only `"` is substituted (→ `'`), because it is the quote character itself
 * and has no escape inside `[^\"]+` — the same last-boundary discipline as
 * setEdgeLabel's pipe. Everything else is PRESERVED by quoting rather than
 * dropped: quoting is lossless, dropping silently loses what the user typed.
 *
 * Every branch here emits something `parseMetaBody` can read back, so an edit
 * never costs a line its structural editability.
 */
function emitMetaValue(value: string): string {
  const cleaned = value.replaceAll('"', "'");
  return /[,:{}^]|\s#|^[#'&*!]|^\s|\s$|^$/.test(cleaned) ? `"${cleaned}"` : cleaned;
}

export function emitNodeRef(ref: NodeRef): string {
  if (ref.label === null) return ref.id;
  const [open, close] = SHAPE_BRACKETS[ref.shape ?? 'rect'];
  return `${ref.id}${open}${quoteLabel(ref.label)}${close}`;
}

function emitLine(line: ModelLine): string {
  const indent = line.raw.match(/^\s*/)?.[0] ?? '';
  const p = line.parsed;
  switch (p.kind) {
    case 'header':
      return `${indent}${p.keyword} ${p.direction}`;
    case 'node':
      return `${indent}${emitNodeRef(p.node)}`;
    case 'node-meta':
      return `${indent}${p.id}@{ ${p.meta.entries
        .map(([k, v]) => `${k}: ${emitMetaValue(v)}`)
        .join(', ')} }`;
    // Dirty style lines emit canonical `k:v,` spacing; untouched ones keep
    // their quirks through `raw`, which the round-trip tests prove.
    case 'style':
      return `${indent}style ${p.id} ${p.decls.map(([k, v]) => `${k}:${v}`).join(',')}`;
    case 'edges': {
      // Contiguous chains re-emit as chains; ops splits non-contiguous lines.
      let out = `${indent}${p.segments[0].from.map(emitNodeRef).join(' & ')}`;
      for (const seg of p.segments) {
        out += ` ${seg.id !== null ? `${seg.id}@` : ''}${seg.arrow.raw}${emitEdgeLabel(
          seg.label,
        )} ${seg.to.map(emitNodeRef).join(' & ')}`;
      }
      return out;
    }
    case 'subgraph-start':
      return `${indent}subgraph ${p.title}`;
    case 'subgraph-end':
      return `${indent}end`;
    case 'opaque':
      return line.raw;
  }
}

export function serialize(model: FlowchartModel): string {
  return model.lines.map((l) => (l.dirty ? emitLine(l) : l.raw)).join('\n');
}

/**
 * Which `id@{ … }` lines annotate an EDGE rather than declaring a node
 * (M29.31) — the exclusion M29.29 promised, and the reason `A e1@--> B` no
 * longer costs A and B their place in `nodes()`.
 *
 * POSITION decides, not the id alone. Mermaid resolves the id against the
 * edges recorded SO FAR (`this.edges.find(e => e.id === id)`,
 * flowDb.ts:163-176), so the same line means two different things depending
 * on where it sits: below `A e1@--> B` it sets that edge's animate/animation/
 * curve, while ABOVE it — measured on 11.16.0 — it finds no edge, falls
 * through to `addVertex`, and renders a stray box labeled `e1`. Keying on the
 * id alone would hide a node that genuinely draws.
 *
 * (Upstream checks subgraph ids ahead of edges. That branch is 11.16.1-only —
 * the 11.16.0 we bundle has no `subGraphLookup` lookup in `addVertex`, and
 * `s1@{ label: X }` after a subgraph really does mint a vertex there — so a
 * subgraph-id meta line stays node meta for us, which is what 11.16.0 does.)
 */
function edgeMetaLines(model: FlowchartModel): Set<number> {
  const declared = new Set<string>();
  const out = new Set<number>();
  model.lines.forEach((line, i) => {
    if (line.parsed.kind === 'edges') {
      for (const seg of line.parsed.segments) {
        if (seg.id !== null) declared.add(seg.id);
      }
    } else if (line.parsed.kind === 'node-meta' && declared.has(line.parsed.id)) {
      out.add(i);
    }
  });
  return out;
}

/**
 * Meta per id, merged PER KEY with the last value winning — not per line.
 * Mermaid applies each key independently onto the accumulated vertex
 * (flowDb.ts:236-262 is a run of `if (doc.shape) …`, `if (doc?.label) …`), so
 * `A@{ label: X }` followed by `A@{ shape: hex }` renders as BOTH. Replacing
 * the whole meta per line would make this resolved view lie. Edge meta
 * (flowDb.ts:163-176) folds by exactly the same rule, one `if` per key.
 *
 * The merged result is a read-only view: emission always goes through the
 * individual line's own `meta`, never through this.
 */
function mergeMeta(
  model: FlowchartModel,
  wanted: (index: number) => boolean,
): Map<string, NodeMeta> {
  const out = new Map<string, NodeMeta>();
  model.lines.forEach((line, i) => {
    if (line.parsed.kind !== 'node-meta' || !wanted(i)) return;
    const { id, meta } = line.parsed;
    const prior = out.get(id);
    if (prior === undefined) {
      out.set(id, meta);
      return;
    }
    let merged = prior;
    for (const [k, v] of meta.entries) merged = withMetaEntry(merged, k, v);
    out.set(id, merged);
  });
  return out;
}

/** Meta for ids that name NODES — every `id@{ … }` line that is not edge meta. */
export function nodeMeta(model: FlowchartModel): Map<string, NodeMeta> {
  const edgeLines = edgeMetaLines(model);
  return mergeMeta(model, (i) => !edgeLines.has(i));
}

/** Meta for ids that name EDGES: `animate`, `animation`, `curve` (flowDb.ts:163-176). */
export function edgeMeta(model: FlowchartModel): Map<string, NodeMeta> {
  const edgeLines = edgeMetaLines(model);
  return mergeMeta(model, (i) => edgeLines.has(i));
}

/** Line indices carrying `id`'s edge meta, in source order. Empty when there are none. */
export function edgeMetaLinesFor(model: FlowchartModel, id: string): number[] {
  const edgeLines = edgeMetaLines(model);
  return [...edgeLines].filter((i) => {
    const parsed = model.lines[i].parsed;
    return parsed.kind === 'node-meta' && parsed.id === id;
  });
}

/**
 * What `id` is actually styled as: EVERY style line for the id, folded in
 * source order, exactly as mermaid resolves them. `flowDb.addVertex` pushes
 * each line's declarations onto the same `vertex.styles` array, so duplicates
 * settle per key with the LAST value winning and the FIRST position kept —
 * which is `withEntry`'s semantics, and the same shape as `nodeMeta` above.
 * Verified against mermaid 11.16: `fill:#f96,stroke:red` + `fill:#000`
 * renders `fill:#000 !important;stroke:red !important`.
 *
 * Reading only the first line here would make the colour UI show a value the
 * diagram does not render, and `setNodeStyle` writes to match this view.
 *
 * KNOWN GAP: a node coloured through `classDef` + `class`/`:::` reads as {}.
 * mermaid applies class styles alongside these, but `classDef` authoring is
 * out of scope this wave (spec D5) and those lines stay opaque, so the swatch
 * UI will show such a node as unstyled.
 */
export function nodeStyle(model: FlowchartModel, id: string): Record<string, string> {
  let decls: [string, string][] = [];
  for (const line of model.lines) {
    if (line.parsed.kind !== 'style' || line.parsed.id !== id) continue;
    for (const [k, v] of line.parsed.decls) decls = withEntry(decls, k, v);
  }
  return Object.fromEntries(decls);
}

export interface ResolvedNode {
  label: string;
  shape: Shape;
  /** Registry shape from a meta line, when one overrides the brackets. */
  metaShape?: string;
}

/**
 * Resolved view: definition line wins, else first labeled inline site, else
 * the id; meta overrides both.
 */
export function nodes(model: FlowchartModel): Map<string, ResolvedNode> {
  const out = new Map<string, ResolvedNode>();
  // A label claim is "locked" once a definition line or a labeled inline site
  // has set it — a later bare reference (`A --> B`) must not clobber that
  // label with a placeholder, but a later definition line still wins outright,
  // and among labeled inline sites the first one wins.
  const locked = new Set<string>();
  const claim = (ref: NodeRef, defLine: boolean) => {
    if (ref.label !== null) {
      if (defLine || !locked.has(ref.id)) {
        out.set(ref.id, { label: ref.label, shape: ref.shape ?? 'rect' });
        locked.add(ref.id);
      }
    } else if (!out.has(ref.id)) {
      out.set(ref.id, { label: ref.id, shape: 'rect' });
    }
  };
  for (const line of model.lines) {
    if (line.parsed.kind === 'node') claim(line.parsed.node, true);
    if (line.parsed.kind === 'edges') {
      for (const seg of line.parsed.segments) {
        for (const ref of [...seg.from, ...seg.to]) claim(ref, false);
      }
    }
  }
  // Meta lines both declare nodes (a lone `A@{ shape: cyl }` is a real
  // declaration) and refine already-declared ones: meta label and shape win
  // at render time, so the resolved view must say so.
  for (const [id, meta] of nodeMeta(model)) {
    const existing = out.get(id);
    if (existing === undefined) {
      const fresh: ResolvedNode = { label: meta.label ?? id, shape: 'rect' };
      if (meta.shape !== undefined) fresh.metaShape = meta.shape;
      out.set(id, fresh);
    } else {
      if (meta.label !== undefined) existing.label = meta.label;
      if (meta.shape !== undefined) existing.metaShape = meta.shape;
    }
  }
  return out;
}

export interface EdgeEntry {
  line: number;
  seg: number;
  from: string;
  to: string;
  arrow: EdgeArrow;
  label: string | null;
  /** The `e1` of `A e1@--> B`, on the ONE expanded edge that upstream gives it to. */
  id: string | null;
}

/** Every logical edge, groups and chains expanded. */
export function edges(model: FlowchartModel): EdgeEntry[] {
  const out: EdgeEntry[] = [];
  model.lines.forEach((line, lineIdx) => {
    if (line.parsed.kind !== 'edges') return;
    line.parsed.segments.forEach((segment, segIdx) => {
      segment.from.forEach((f, fi) => {
        segment.to.forEach((t, ti) => {
          // An & group expands to several edges but the segment's id names
          // exactly ONE of them: `addLink` (flowDb.ts:356-371) hands the
          // user id to the LAST start crossed with the FIRST end and
          // auto-generates ids for the rest — so `A e1@--> B & C` animates
          // A→B only. Copying the id onto every expansion would make
          // edgeAnimated lie and point setEdgeAnimate at the wrong edge.
          const owns = fi === segment.from.length - 1 && ti === 0;
          out.push({
            line: lineIdx,
            seg: segIdx,
            from: f.id,
            to: t.id,
            arrow: segment.arrow,
            label: segment.label,
            id: owns ? segment.id : null,
          });
        });
      });
    });
  });
  return out;
}

/**
 * True when this edge's id carries `animate: true`. `animation: fast|slow`
 * animates too (flowDb.ts:170-172) but is a separate key with its own values,
 * so it is not folded in here — a toggle that reported `animation: slow` as
 * "on" and then wrote `animate: true` would leave both keys fighting.
 */
export function edgeAnimated(model: FlowchartModel, edge: EdgeEntry): boolean {
  if (edge.id === null) return false;
  const meta = edgeMeta(model).get(edge.id);
  return meta?.entries.some(([k, v]) => k === 'animate' && v === 'true') ?? false;
}
