/**
 * Source text → `ParsedLine`. Every refusal here means the line goes OPAQUE and
 * its bytes survive; see `./model` for the invariant that rests on it.
 */

import type {
  Direction,
  EdgeArrow,
  EdgeHead,
  EdgeSegment,
  EdgeStroke,
  FlowchartModel,
  ModelLine,
  NodeMeta,
  NodeRef,
  ParsedLine,
  PlanePoint,
  Shape,
} from './types';
import { buildMeta } from './types';

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

// `classDef` must stay ahead of `class`: the engine tries alternatives left to
// right, and while `\b` would anyway reject the `class` branch against
// `classDef…` (the following `D` is a word character), the explicit order makes
// the intent unmissable and costs nothing. `click` left this list in M29.36
// WITHOUT becoming free-form: the guard in `parseLine` sends every click shape
// that is not the plain-link form straight to opaque before any fallback runs.
const OPAQUE_KEYWORDS = /^(classDef|class|style|linkStyle|direction|accTitle|accDescr)\b/;

/**
 * The plain-link click line, and only that (M29.36, spec D3). Matched against
 * the RAW line rather than a trimmed one, because mermaid's whitespace rules
 * here are exact and unforgiving — every one of these MEASURED on the bundled
 * 11.16.0 (`links.mermaid.test.ts`):
 *
 * - `click  A "x"` renders — the lexer's `"click"[\s]+` is greedy;
 * - `click A  "x"` is a PARSE ERROR — `<click>[\s\n]` pops the click state on
 *   exactly ONE whitespace character (flow.jison:112) and no grammar rule
 *   accepts a SPACE between CLICK and STR (flow.jison:551);
 * - `click A "x" ` — one trailing space — is a PARSE ERROR for the same
 *   reason, so `$` may not be reached through `.trim()`;
 * - `click A ""` is a PARSE ERROR, hence `[^"]+` and not `[^"]*`;
 * - a trailing `\r` is fine: mermaid normalizes CRLF before it parses.
 *
 * Being this strict is the same boundary `parseMetaBody` holds when it refuses
 * a duplicate key: a line the renderer rejects is a line about which we have
 * no facts, and `nodeLinks` reporting one would be the model claiming a link
 * on a document that cannot draw at all.
 */
const CLICK_LINE = /^[^\S\r\n]*click[^\S\r\n]+([A-Za-z0-9_.-]+)[^\S\r\n]"([^"]+)"\r?$/;

/**
 * A subgraph opener, matched against the RAW line because the whitespace is
 * load-bearing. `addSubGraph` (11.16.0) decides the id in four lines, and
 * every one of them is MEASURED in `subgraphs.mermaid.test.ts`: it trims
 * `_id.text` for the id, keeps `_title.text` untrimmed, throws the id away
 * when the BARE form's untrimmed title matches `/\s/`, falls back to
 * `'subGraph' + subCount`, and only THEN trims the title for display.
 *
 * The lexer rule is `subgraph\b` — it consumes NO whitespace — so exactly one
 * whitespace character separates the keyword from the id text and everything
 * after it, padding included, IS that text. Hence `subgraph  Padded` and
 * `subgraph Alpha ` are both `subGraph<k>` while `subgraph Alpha` is `Alpha`.
 * A trailing `\r` is not whitespace here: mermaid normalizes CRLF first.
 */
const SUBGRAPH_START_LINE = /^[^\S\r\n]*subgraph[^\S\r\n]([^\r\n]*)\r?$/;

/**
 * The explicit `id[Title]` form, read off the id text. Padding around the id
 * is fine upstream (the id is trimmed), and the id charset is far wider than
 * a node's — MEASURED, `subgraph Two Words[T]` really is the id `Two Words`.
 * A leading `"` is excluded so the quoted BARE form (`subgraph "a[b]"`, whose
 * id is `a[b]`) cannot be misread as an explicit one.
 */
const SUBGRAPH_EXPLICIT = /^\s*([^\s"[\]][^"[\]]*?)\s*\[(.+)\]$/;

/**
 * `end`, plus the separators mermaid's `end\b\s*` rule and its `;` token
 * allow. MEASURED: `end;`, `end ;` and `end;;` all close a block on a
 * document that renders — reading them as opaque would leave our block stack
 * unbalanced while mermaid's is fine.
 */
const SUBGRAPH_END_LINE = /^end[\s;]*$/;

/** One surrounding pair of double quotes off, exactly as the lexer takes them. */
function stripQuotes(text: string): string {
  return text.length >= 2 && text.startsWith('"') && text.endsWith('"') ? text.slice(1, -1) : text;
}

/**
 * The bare-form id text as `addSubGraph` receives it — quotes off, `\r` off,
 * padding INTACT — or null when the line is not a bare-form opener. The
 * whitespace test that zeroes an id into `subGraph<k>` runs on this string,
 * so `subgraphs()` reads it here rather than off the parsed display title.
 */
export function bareSubgraphIdText(raw: string): string | null {
  const m = raw.match(SUBGRAPH_START_LINE);
  if (m === null || m[1].trim() === '') return null;
  return SUBGRAPH_EXPLICIT.test(m[1]) ? null : stripQuotes(m[1]);
}

/** `subgraph id[Title]` / `subgraph Title`, or null for a form we do not own. */
function parseSubgraphStart(raw: string): ParsedLine | null {
  const m = raw.match(SUBGRAPH_START_LINE);
  if (m === null || m[1].trim() === '') return null;
  const explicit = m[1].match(SUBGRAPH_EXPLICIT);
  if (explicit !== null) {
    return { kind: 'subgraph-start', id: explicit[1], title: stripQuotes(explicit[2]).trim() };
  }
  return { kind: 'subgraph-start', id: null, title: stripQuotes(m[1]).trim() };
}

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

const POS_LINE = /^%%\s*cerebro:pos\s+(\S.*)$/;
const LAYOUT_LINE = /^%%\s*cerebro:layout\s+manual\s*$/;
const POS_COORD = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/;

/** An id `ID_PATTERN` consumes WHOLE — the node-token charset, both ends anchored. */
function isOwnedId(id: string): boolean {
  const m = id.match(ID_PATTERN);
  return m !== null && m[0] === id;
}

/**
 * Our two marker comments (M29.41). Anything that is not a byte-perfect match
 * for the grammar returns null and the caller keeps the line opaque — a
 * half-written `%% cerebro:pos A 12` must never be "repaired" into data, and a
 * line we disown keeps its bytes, which is never wrong.
 *
 * Both are plain `%%` comments, never the `%%{ … }%%` directive form. That is
 * the load-bearing claim of the whole format and it is MEASURED rather than
 * reasoned (`positions.mermaid.test.ts`): a marker inserted at EVERY line index
 * of a dagre flowchart, a frontmatter+ELK one, a `subgraph`-with-`direction`
 * one and a CRLF one leaves mermaid's vertices, edges, subgraph membership,
 * directions AND rendered svg bytes untouched — keyword ids (`end`,
 * `subgraph`, `direction`, `click`) inside a subgraph block included. The
 * measurement was not optional: the same wave found a `%%`-commented
 * `direction` line behaving the OPPOSITE way round from the obvious reading
 * (mermaid ignores it, our own reader did not), so "it's a comment" is exactly
 * the class of claim that has been wrong here.
 *
 * Ids are space-separated and cannot contain whitespace or commas, so the
 * token stream is unambiguous; an odd token count means we misread something
 * and refuse the WHOLE line rather than half of it.
 */
function parseCerebroComment(trimmed: string): ParsedLine | null {
  if (LAYOUT_LINE.test(trimmed)) return { kind: 'layout-mode', manual: true };
  const m = trimmed.match(POS_LINE);
  if (m === null) return null;
  const tokens = m[1].trim().split(/\s+/);
  if (tokens.length % 2 !== 0) return null;
  const positions = new Map<string, PlanePoint>();
  for (let i = 0; i < tokens.length; i += 2) {
    const id = tokens[i];
    const coord = tokens[i + 1].match(POS_COORD);
    if (!isOwnedId(id) || coord === null) return null;
    // A repeated id keeps its LAST value — the reading `storedPositions`
    // hands the pipeline, and the one a rewrite collapses the line onto.
    positions.set(id, { x: Number(coord[1]), y: Number(coord[2]) });
  }
  return { kind: 'pos-comment', positions };
}

/**
 * One `<id> <x>,<y>` token pair, or null when we could not read it back — the
 * last boundary before a positions line reaches the file, the counterpart to
 * `styleDecl` and `clickTarget`, and it validates by ASKING THE PARSER rather
 * than by mirroring its rules.
 *
 * The stakes are higher here than for a style value: a positions line is
 * SHARED. One unreadable token takes the whole line opaque on the next parse
 * and every OTHER node's coordinates with it, so a hostile id (`A B`, a
 * newline, `A+B`) or an unrepresentable number must be refused rather than
 * written. `1e21` is the reachable one — it is a perfectly finite integer whose
 * decimal spelling is `1e+21`, which `POS_COORD` rightly refuses; a finiteness
 * check alone would have let it through.
 *
 * Rounding lives here so the op and the emitter can never round differently.
 */
export function posToken(id: string, pos: PlanePoint): string | null {
  const x = Math.round(pos.x);
  const y = Math.round(pos.y);
  const token = `${id} ${x},${y}`;
  const probe = parseCerebroComment(`%% cerebro:pos ${token}`);
  if (probe === null || probe.kind !== 'pos-comment' || probe.positions.size !== 1) return null;
  const read = probe.positions.get(id);
  return read !== undefined && read.x === x && read.y === y ? token : null;
}

function parseLine(rawLine: string): ParsedLine {
  const trimmed = rawLine.trim();
  if (trimmed === '') return { kind: 'opaque' };
  // Our own markers are the ONLY comments we ever own; every other `%%` line
  // stays opaque exactly as it always has.
  if (trimmed.startsWith('%%')) return parseCerebroComment(trimmed) ?? { kind: 'opaque' };

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

  // The plain-link click form is ours (M29.36, spec D3): `click <id> "<target>"`.
  // Everything else the grammar allows — call/callback forms, `href`, a second
  // tooltip string, `_blank`-style targets, comma id-lists (flow.jison:541-555)
  // — stays opaque: renders fine, not editable.
  //
  // A blank target is dropped too, one step below CLICK_LINE's own `[^"]+`:
  // `click A "   "` parses, but `utils.formatUrl` returns undefined for a
  // whitespace-only url, so mermaid attaches no link and neither may we.
  //
  // The trailing guard is load-bearing: without it a bare or half-typed
  // `click` line would fall to the node-token parser and mint a phantom node
  // with id "click" — a node the user never wrote, which rename and delete
  // would then happily act on.
  const click = rawLine.match(CLICK_LINE);
  if (click !== null && click[2].trim() !== '') {
    return { kind: 'click', id: click[1], target: click[2] };
  }
  if (/^click\b/.test(trimmed)) return { kind: 'opaque' };

  const header = trimmed.match(/^(flowchart|graph)\s+(TD|TB|LR|RL|BT)\s*$/);
  if (header !== null) {
    return {
      kind: 'header',
      keyword: header[1] as 'flowchart' | 'graph',
      direction: header[2] as Direction,
    };
  }

  const sub = parseSubgraphStart(rawLine);
  if (sub !== null) return sub;
  if (SUBGRAPH_END_LINE.test(trimmed)) return { kind: 'subgraph-end' };
  // A `subgraph` line we could not read (anonymous, or a shape outside
  // `parseSubgraphStart`): opaque rather than falling into the node-token
  // fallback below, which would otherwise mint a phantom node with id
  // "subgraph". `subgraphs()` still pairs it with an `end` — an opener we
  // cannot EDIT is still an opener, and miscounting would shift every
  // generated id after it.
  if (/^subgraph\b/.test(trimmed)) return { kind: 'opaque' };

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
