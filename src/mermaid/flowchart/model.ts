/**
 * The line-oriented flowchart model (M29.14).
 *
 * Every source line is either UNDERSTOOD (header, node definition, edge line —
 * chains and & groups included — subgraph markers) or OPAQUE (frontmatter,
 * comments, classDef/class/style/linkStyle/click, and anything the parser is
 * not 100% sure about). Serialization re-emits `raw` for every non-dirty line,
 * so opaque content survives byte-for-byte BY CONSTRUCTION — the invariant the
 * whole structural editor stands on.
 */

export type Direction = 'TD' | 'TB' | 'LR' | 'RL' | 'BT';
export type Shape =
  'rect' | 'rounded' | 'stadium' | 'circle' | 'diamond' | 'hexagon' | 'cylinder' | 'subroutine';
export type Arrow = '-->' | '---' | '-.->' | '==>';

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

/** New meta with `key` set (replacing in place, order kept) or removed (`null`). */
export function withMetaEntry(meta: NodeMeta, key: string, value: string | null): NodeMeta {
  const entries: [string, string][] = [];
  let replaced = false;
  for (const [k, v] of meta.entries) {
    if (k === key) {
      if (value !== null && !replaced) {
        entries.push([k, value]);
        replaced = true;
      }
      // value === null → drop; a duplicate key collapses onto its first site
    } else {
      entries.push([k, v]);
    }
  }
  if (value !== null && !replaced) entries.push([key, value]);
  return buildMeta(entries);
}

/**
 * Parse a single-line `@{ … }` body — a YAML flow mapping per the v11.16.1
 * lexer. Bare values may not contain `,` `:` `"` `^` (quote them instead);
 * `^` is illegal even quoted (lexer class `[^}^"]+`), and nested braces mean
 * a body we don't own. Any violation → null → the line goes opaque.
 */
function parseMetaBody(body: string): NodeMeta | null {
  if (/[{}^]/.test(body)) return null;
  const parts: string[] = [];
  let quote = false;
  let cur = '';
  for (const ch of body) {
    if (ch === '"') quote = !quote;
    if (ch === ',' && !quote) {
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (quote) return null;
  parts.push(cur);

  const entries: [string, string][] = [];
  for (const part of parts) {
    const item = part.trim();
    if (item === '') return null;
    const colon = item.indexOf(':');
    if (colon === -1) return null;
    const key = item.slice(0, colon).trim();
    let value = item.slice(colon + 1).trim();
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(key)) return null;
    if (value.startsWith('"')) {
      if (value.length < 2 || !value.endsWith('"')) return null;
      value = value.slice(1, -1);
      if (value.includes('"')) return null;
    } else if (value === '' || /[:"]/.test(value)) {
      return null;
    }
    entries.push([key, value]);
  }
  return buildMeta(entries);
}

export interface EdgeSegment {
  from: NodeRef[];
  to: NodeRef[];
  arrow: Arrow;
  label: string | null;
}

export type ParsedLine =
  | { kind: 'header'; keyword: 'flowchart' | 'graph'; direction: Direction }
  | { kind: 'node'; node: NodeRef }
  | { kind: 'node-meta'; id: string; meta: NodeMeta }
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

const ARROWS: [string, Arrow][] = [
  ['-.->', '-.->'],
  ['-->', '-->'],
  ['==>', '==>'],
  ['---', '---'],
];

/** `A & B -->|go| C --> D` → segments, or null when any piece is not ours. */
export function parseEdgeLine(trimmed: string): EdgeSegment[] | null {
  interface Piece {
    text?: string;
    arrow?: Arrow;
    label?: string | null;
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
      const hit = ARROWS.find(([text]) => trimmed.startsWith(text, i));
      if (hit !== undefined) {
        pieces.push({ text: cur });
        cur = '';
        i += hit[0].length;
        let label: string | null = null;
        if (trimmed[i] === '|') {
          const close = trimmed.indexOf('|', i + 1);
          if (close === -1) return null;
          label = trimmed.slice(i + 1, close);
          i = close + 1;
        }
        pieces.push({ arrow: hit[1], label });
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
  const arrows: { arrow: Arrow; label: string | null }[] = [];
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
      arrows.push({ arrow: pieces[p].arrow as Arrow, label: pieces[p].label ?? null });
    }
  }
  const segments: EdgeSegment[] = [];
  for (let s = 0; s < arrows.length; s += 1) {
    segments.push({
      from: groups[s],
      to: groups[s + 1],
      arrow: arrows[s].arrow,
      label: arrows[s].label,
    });
  }
  return segments;
}

function parseLine(rawLine: string): ParsedLine {
  const trimmed = rawLine.trim();
  if (trimmed === '' || trimmed.startsWith('%%')) return { kind: 'opaque' };
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

  // An arrow substring inside a node's own label (`A[Contains --> text]`)
  // makes this an unreliable signal on its own — parseEdgeLine is the real
  // arbiter, and when it fails (arrow was inside brackets, not a real edge)
  // we fall through to the node-token attempt below rather than going opaque.
  if (ARROWS.some(([text]) => trimmed.includes(text))) {
    const segments = parseEdgeLine(trimmed);
    if (segments !== null) return { kind: 'edges', segments };
  }

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

function quoteLabel(label: string): string {
  return /[|()[\]{}&"]/.test(label) ? `"${label.replaceAll('"', "'")}"` : label;
}

/**
 * Quote a meta value when the flow mapping demands it (`,` `:` braces, `#`,
 * or edge whitespace/emptiness). `"` and `^` are illegal in `@{ … }` bodies
 * altogether, so — same last-boundary discipline as setEdgeLabel's pipe —
 * they are substituted here rather than corrupting the file.
 */
function emitMetaValue(value: string): string {
  const cleaned = value.replaceAll('"', "'").replaceAll('^', '');
  return /[,:{}#]|^\s|\s$|^$/.test(cleaned) ? `"${cleaned}"` : cleaned;
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
    case 'edges': {
      // Contiguous chains re-emit as chains; ops splits non-contiguous lines.
      let out = `${indent}${p.segments[0].from.map(emitNodeRef).join(' & ')}`;
      for (const seg of p.segments) {
        out += ` ${seg.arrow}${seg.label !== null ? `|${seg.label}|` : ''} ${seg.to
          .map(emitNodeRef)
          .join(' & ')}`;
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

/** Meta per id — the LAST meta line for an id wins, mirroring mermaid's sequential apply. */
export function nodeMeta(model: FlowchartModel): Map<string, NodeMeta> {
  const out = new Map<string, NodeMeta>();
  for (const line of model.lines) {
    if (line.parsed.kind === 'node-meta') out.set(line.parsed.id, line.parsed.meta);
  }
  return out;
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
  arrow: Arrow;
  label: string | null;
}

/** Every logical edge, groups and chains expanded. */
export function edges(model: FlowchartModel): EdgeEntry[] {
  const out: EdgeEntry[] = [];
  model.lines.forEach((line, lineIdx) => {
    if (line.parsed.kind !== 'edges') return;
    line.parsed.segments.forEach((segment, segIdx) => {
      for (const f of segment.from) {
        for (const t of segment.to) {
          out.push({
            line: lineIdx,
            seg: segIdx,
            from: f.id,
            to: t.id,
            arrow: segment.arrow,
            label: segment.label,
          });
        }
      }
    });
  });
  return out;
}
