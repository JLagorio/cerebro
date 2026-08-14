# M29 Stage C — Structural Visual Editor for Flowcharts (M29.14–M29.19)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Edit a flowchart by clicking it — rename (double-click), connect (drag), add, delete, reshape, redirect — while the file on disk stays an ordinary ` ```mermaid ` fence, edited surgically line-by-line, never regenerated.

**Architecture:** `src/mermaid/flowchart/` holds a line-oriented model (`model.ts`: every source line is *understood* or *opaque*), pure edit operations (`ops.ts`), a DOM binder that maps mermaid's rendered SVG back to model ids (`svgBinding.ts`), and the interactive surface (`StructuralEditor.tsx`). `MermaidBlockView` gains a visual/code mode toggle: flowcharts open visual-first, everything else keeps Stage B's side-by-side.

**Tech Stack:** No new dependencies. Rendering stays with real mermaid (dagre/ELK); interactions are an overlay on its SVG — no reactflow, no second layout engine. (The `innerHTML` sink here is the same strict-mode mermaid output every Stage A component injects — see Stage A's note.)

**Spec:** `docs/superpowers/specs/2026-08-08-cerebro-m29-mermaid-design.md`
**Prerequisites:** Stages A + B complete.

---

## The two invariants everything here serves

1. **Surgical edits only.** An operation touches exactly the lines it must. Opaque lines (`classDef`, `style`, `click`, comments, frontmatter, anything half-understood) are preserved byte-for-byte because serialization re-emits `raw` for every line that isn't `dirty`. Node **ids never change** — rename edits the *label token* — so style/class/click bindings cannot break.
2. **Editing degrades; rendering never does.** Rendering always goes through real mermaid. If the parser can't own a line, that line's nodes just aren't visually editable; if it can't own the header, the whole toolbar disables with an "edit as code" hint. No parse failure may ever block or alter rendering.

Verification of the DOM contract against vendored mermaid source (v11.16, `docs/examples/mermaid-develop/`): node groups carry `id="flowchart-<nodeId>-<counter>"` (`MERMAID_DOM_ID_PREFIX`, flowDb.ts:35) and class `node`; edge paths carry class `flowchart-link` (flowDb.ts:1259) and ids built by `getEdgeId` (utils.ts:933) as `L_<from>_<to>_<counter>`.

Repo traps: same as Stage A (mock mermaid in vitest; `pnpm test:run`; zero-warning lint; corpus edits only in the e2e task). The model/ops layers are pure string+data code — they need no mermaid and no DOM, which is what makes this stage testable at all.

---

### Task C1: The line-oriented flowchart model (M29.14)

**Files:**
- Create: `src/mermaid/flowchart/model.ts`
- Create: `src/mermaid/flowchart/model.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/mermaid/flowchart/model.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { edges, nodes, parseFlowchart, serialize } from './model';

const SIMPLE = ['flowchart TD', '  A[Start] --> B{Choice}', '  B -->|yes| C[Done]'].join('\n');

const EXOTIC = [
  '---',
  'config:',
  '  layout: elk',
  '---',
  'flowchart LR',
  '  %% a comment to preserve',
  '  A[Start] --> B',
  '  B --> C[End]',
  '  classDef hot fill:#f96',
  '  class A hot',
  '  click B "https://example.com"',
  '  subgraph Phase 1',
  '    D[Inside] --> E[Also inside]',
  '  end',
  '  A & D --> F((Fan-in))',
  '  G[One] --> H[Two] --> I[Three]',
].join('\n');

describe('parseFlowchart', () => {
  it('returns null for non-flowcharts', () => {
    expect(parseFlowchart('sequenceDiagram\n  A->>B: hi')).toBeNull();
    expect(parseFlowchart('')).toBeNull();
  });

  it('parses the header, nodes, and edges of a simple diagram', () => {
    const model = parseFlowchart(SIMPLE);
    expect(model).not.toBeNull();
    const n = nodes(model!);
    expect(n.get('A')).toEqual({ label: 'Start', shape: 'rect' });
    expect(n.get('B')).toEqual({ label: 'Choice', shape: 'diamond' });
    const e = edges(model!);
    expect(e).toHaveLength(2);
    expect(e[1]).toMatchObject({ from: 'B', to: 'C', label: 'yes' });
  });

  it('classifies styling, clicks, and comments as opaque', () => {
    const model = parseFlowchart(EXOTIC)!;
    const kinds = model.lines.map((l) => l.parsed.kind);
    // frontmatter (4 lines) + comment + classDef + class + click = 8 opaque
    expect(kinds.filter((k) => k === 'opaque').length).toBeGreaterThanOrEqual(8);
  });

  it('expands & groups and chains into individual edges', () => {
    const model = parseFlowchart(EXOTIC)!;
    const e = edges(model);
    expect(e).toContainEqual(expect.objectContaining({ from: 'A', to: 'F' }));
    expect(e).toContainEqual(expect.objectContaining({ from: 'D', to: 'F' }));
    expect(e).toContainEqual(expect.objectContaining({ from: 'G', to: 'H' }));
    expect(e).toContainEqual(expect.objectContaining({ from: 'H', to: 'I' }));
  });

  it('a half-understood line goes opaque, not wrong', () => {
    const model = parseFlowchart('flowchart TD\n  A --> B\n  A ==WEIRD==> C')!;
    expect(model.lines[2].parsed.kind).toBe('opaque');
    expect(edges(model)).toHaveLength(1);
  });
});

describe('serialize', () => {
  it('round-trips untouched sources byte-identically', () => {
    for (const src of [SIMPLE, EXOTIC]) {
      expect(serialize(parseFlowchart(src)!)).toBe(src);
    }
  });
});
```

- [ ] **Step 2: Run to make sure it fails**

Run: `pnpm test:run src/mermaid/flowchart/model.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/mermaid/flowchart/model.ts`**

```ts
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
  | 'rect'
  | 'rounded'
  | 'stadium'
  | 'circle'
  | 'diamond'
  | 'hexagon'
  | 'cylinder'
  | 'subroutine';
export type Arrow = '-->' | '---' | '-.->' | '==>';

export interface NodeRef {
  id: string;
  /** Label carried at this reference site (`A[Start]`), or null for a bare `A`. */
  label: string | null;
  shape: Shape | null;
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

const OPAQUE_KEYWORDS =
  /^(classDef|class|style|linkStyle|click|direction|accTitle|accDescr)\b/;

/** Bracket pairs, longest opener first — order is load-bearing. */
const SHAPES: [string, string, Shape][] = [
  ['((', '))', 'circle'],
  ['([', ')]', 'stadium'],
  ['[[', ']]', 'subroutine'],
  ['[(', ')]', 'cylinder'],
  ['{{', '}}', 'hexagon'],
  ['[', ']', 'rect'],
  ['(', ')', 'rounded'],
  ['{', '}', 'diamond'],
];

export const SHAPE_BRACKETS: Record<Shape, [string, string]> = {
  circle: ['((', '))'],
  stadium: ['([', ')]'],
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
    if (rest.startsWith(open) && rest.endsWith(close) && rest.length >= open.length + close.length) {
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

  if (ARROWS.some(([text]) => trimmed.includes(text))) {
    const segments = parseEdgeLine(trimmed);
    return segments === null ? { kind: 'opaque' } : { kind: 'edges', segments };
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

/** Resolved view: definition line wins, else first labeled inline site, else the id itself. */
export function nodes(model: FlowchartModel): Map<string, { label: string; shape: Shape }> {
  const out = new Map<string, { label: string; shape: Shape }>();
  const claim = (ref: NodeRef, defLine: boolean) => {
    const existing = out.get(ref.id);
    if (existing !== undefined && !defLine) return;
    if (ref.label !== null) {
      out.set(ref.id, { label: ref.label, shape: ref.shape ?? 'rect' });
    } else if (existing === undefined) {
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
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `pnpm test:run src/mermaid/flowchart/model.test.ts`
Expected: all pass. Pay attention to the byte-identical round-trip on `EXOTIC` — it proves opaque preservation without a single special case.

- [ ] **Step 5: Lint, typecheck, commit**

```bash
pnpm lint && pnpm typecheck
git add src/mermaid/flowchart/model.ts src/mermaid/flowchart/model.test.ts
git commit -m "feat(mermaid): a flowchart model that owns lines or leaves them alone (M29.14)"
```

---

### Task C2: Pure edit operations (M29.15)

**Files:**
- Create: `src/mermaid/flowchart/ops.ts`
- Create: `src/mermaid/flowchart/ops.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/mermaid/flowchart/ops.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { edges, parseFlowchart, serialize } from './model';
import {
  addEdge,
  addNode,
  deleteEdge,
  deleteNode,
  newNodeId,
  renameNode,
  setDirection,
  setEdgeLabel,
  setLayoutEngine,
  setNodeShape,
} from './ops';

const SRC = [
  'flowchart TD',
  '  A[Start] --> B{Choice}',
  '  B -->|yes| C[Done]',
  '  classDef hot fill:#f96',
  '  class A hot',
].join('\n');

const model = () => parseFlowchart(SRC)!;

describe('renameNode', () => {
  it('edits only the label token; ids and opaque lines are untouched', () => {
    const out = serialize(renameNode(model(), 'A', 'Kickoff'));
    expect(out).toContain('A[Kickoff] --> B{Choice}');
    expect(out).toContain('classDef hot fill:#f96');
    expect(out).toContain('class A hot');
  });

  it('creates a definition line for a node that has no label site', () => {
    const m = parseFlowchart('flowchart TD\n  A --> B')!;
    const out = serialize(renameNode(m, 'B', 'Named'));
    expect(out).toBe('flowchart TD\n  B[Named]\n  A --> B');
  });
});

describe('setNodeShape', () => {
  it('swaps brackets in place', () => {
    const out = serialize(setNodeShape(model(), 'A', 'circle'));
    expect(out).toContain('A((Start)) --> B{Choice}');
  });
});

describe('addNode / addEdge / newNodeId', () => {
  it('appends definition and edge lines', () => {
    const { model: m2, id } = addNode(model(), 'Fresh');
    expect(id).toBe('n1');
    const out = serialize(addEdge(m2, 'C', id));
    expect(out.endsWith('  n1[Fresh]\n  C --> n1')).toBe(true);
  });

  it('never reuses an existing id', () => {
    const m = parseFlowchart('flowchart TD\n  n1[X] --> n3[Y]')!;
    expect(newNodeId(m)).toBe('n2');
  });
});

describe('deleteEdge', () => {
  it('removes one edge from a group without touching the rest', () => {
    const m = parseFlowchart('flowchart TD\n  A & B --> C\n  C --> D')!;
    const target = edges(m).find((e) => e.from === 'A' && e.to === 'C')!;
    const out = serialize(deleteEdge(m, target));
    expect(out).toContain('B --> C');
    expect(out).not.toMatch(/A\s*&/);
    expect(out).toContain('C --> D');
  });
});

describe('deleteNode', () => {
  it('removes its definition and every edge that touches it', () => {
    const out = serialize(deleteNode(model(), 'B'));
    expect(out).not.toContain('{Choice}');
    expect(out).not.toContain('-->|yes|');
    expect(out).toContain('flowchart TD');
    expect(out).toContain('classDef hot fill:#f96'); // opaque survives
  });

  it('splits a chain and preserves surviving segments with their labels', () => {
    const m = parseFlowchart('flowchart TD\n  G[One] --> H[Two] --> I[Three]')!;
    const out = serialize(deleteNode(m, 'H'));
    expect(out).not.toContain('Two');
    // G and I keep their labels even though their only label sites were on the chain line.
    expect(out).toContain('G[One]');
    expect(out).toContain('I[Three]');
  });
});

describe('setEdgeLabel', () => {
  it('sets, changes, and clears a segment label', () => {
    const m = parseFlowchart('flowchart TD\n  A --> B')!;
    const out = serialize(setEdgeLabel(m, edges(m)[0], 'go'));
    expect(out).toContain('A -->|go| B');
    const m2 = parseFlowchart(out)!;
    const cleared = serialize(setEdgeLabel(m2, edges(m2)[0], null));
    expect(cleared).toContain('A --> B');
    expect(cleared).not.toContain('|');
  });
});

describe('setDirection', () => {
  it('rewrites only the header', () => {
    const out = serialize(setDirection(model(), 'LR'));
    expect(out.startsWith('flowchart LR\n')).toBe(true);
  });
});

describe('setLayoutEngine', () => {
  it('adds frontmatter when none exists', () => {
    const out = serialize(setLayoutEngine(model(), 'elk'));
    expect(out.startsWith('---\nconfig:\n  layout: elk\n---\nflowchart TD')).toBe(true);
  });

  it('updates an existing layout line and removes it for dagre', () => {
    const src = '---\nconfig:\n  layout: elk\n---\nflowchart TD\n  A --> B';
    const toDagre = serialize(setLayoutEngine(parseFlowchart(src)!, 'dagre'));
    expect(toDagre).not.toContain('layout:');
    const back = serialize(setLayoutEngine(parseFlowchart(toDagre)!, 'elk'));
    expect(back).toContain('  layout: elk');
  });
});

describe('surgical property', () => {
  it('after any op, untouched lines are byte-identical', () => {
    const before = SRC.split('\n');
    const after = serialize(renameNode(model(), 'C', 'Shipped')).split('\n');
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[1]);
    expect(after[3]).toBe(before[3]);
    expect(after[4]).toBe(before[4]);
  });
});
```

- [ ] **Step 2: Run to make sure it fails**

Run: `pnpm test:run src/mermaid/flowchart/ops.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/mermaid/flowchart/ops.ts`**

```ts
import type { EdgeEntry, FlowchartModel, ModelLine, NodeRef, Shape } from './model';
import { nodes } from './model';

/**
 * Pure flowchart operations (M29.15). Every function returns a new model and
 * marks exactly the lines it rewrote as dirty; serialize() re-emits those and
 * only those. Node ids are immutable here by design — rename touches labels,
 * never ids — so opaque style/class/click bindings stay valid forever.
 */

function clone(model: FlowchartModel): FlowchartModel {
  return structuredClone(model);
}

function headerIndex(model: FlowchartModel): number {
  return model.lines.findIndex((l) => l.parsed.kind === 'header');
}

function eachRef(line: ModelLine, visit: (ref: NodeRef) => void): void {
  if (line.parsed.kind === 'node') visit(line.parsed.node);
  if (line.parsed.kind === 'edges') {
    for (const seg of line.parsed.segments) {
      for (const ref of [...seg.from, ...seg.to]) visit(ref);
    }
  }
}

/** First labeled site wins: definition line, else inline ref. Null = no site. */
function findLabelSite(
  model: FlowchartModel,
  id: string,
): { line: number; ref: NodeRef } | null {
  for (let i = 0; i < model.lines.length; i += 1) {
    const parsed = model.lines[i].parsed;
    if (parsed.kind === 'node' && parsed.node.id === id) {
      return { line: i, ref: parsed.node };
    }
  }
  for (let i = 0; i < model.lines.length; i += 1) {
    let found: NodeRef | null = null;
    eachRef(model.lines[i], (ref) => {
      if (ref.id === id && ref.label !== null && found === null) found = ref;
    });
    if (found !== null) return { line: i, ref: found };
  }
  return null;
}

export function renameNode(model: FlowchartModel, id: string, label: string): FlowchartModel {
  const next = clone(model);
  const site = findLabelSite(next, id);
  if (site !== null) {
    site.ref.label = label;
    if (site.ref.shape === null) site.ref.shape = 'rect';
    next.lines[site.line].dirty = true;
    return next;
  }
  // No label site anywhere: give the node a definition line right after the
  // header so the rename has somewhere to live.
  const at = headerIndex(next) + 1;
  next.lines.splice(at, 0, {
    raw: '  ',
    parsed: { kind: 'node', node: { id, label, shape: 'rect' } },
    dirty: true,
  });
  return next;
}

export function setNodeShape(model: FlowchartModel, id: string, shape: Shape): FlowchartModel {
  const withLabel = findLabelSite(model, id) === null ? renameNode(model, id, id) : clone(model);
  const site = findLabelSite(withLabel, id);
  if (site === null) return withLabel; // unreachable: rename just created a site
  site.ref.shape = shape;
  if (site.ref.label === null) site.ref.label = id;
  withLabel.lines[site.line].dirty = true;
  return withLabel;
}

export function newNodeId(model: FlowchartModel): string {
  const used = new Set([...nodes(model).keys()].map((k) => k.toLowerCase()));
  let n = 1;
  while (used.has(`n${n}`)) n += 1;
  return `n${n}`;
}

export function addNode(
  model: FlowchartModel,
  label: string,
): { model: FlowchartModel; id: string } {
  const next = clone(model);
  const id = newNodeId(next);
  next.lines.push({
    raw: '  ',
    parsed: { kind: 'node', node: { id, label, shape: 'rect' } },
    dirty: true,
  });
  return { model: next, id };
}

export function addEdge(model: FlowchartModel, from: string, to: string): FlowchartModel {
  const next = clone(model);
  next.lines.push({
    raw: '  ',
    parsed: {
      kind: 'edges',
      segments: [
        {
          from: [{ id: from, label: null, shape: null }],
          to: [{ id: to, label: null, shape: null }],
          arrow: '-->',
          label: null,
        },
      ],
    },
    dirty: true,
  });
  return next;
}

/**
 * Rebuild an edges line minus everything `shouldDrop` claims. Chains that lose
 * their middle become several simple lines; inline labels of SURVIVING nodes
 * are re-homed to definition lines first so nothing readable is lost.
 */
function rebuildEdgeLines(
  next: FlowchartModel,
  lineIdx: number,
  shouldDrop: (from: NodeRef, to: NodeRef, seg: number) => boolean,
  dropNodeId: string | null,
): void {
  const line = next.lines[lineIdx];
  if (line.parsed.kind !== 'edges') return;
  const indent = line.raw.match(/^\s*/)?.[0] ?? '  ';

  interface Pair {
    from: NodeRef;
    to: NodeRef;
    seg: number;
  }
  const survivors: Pair[] = [];
  const orphanLabels: NodeRef[] = [];

  line.parsed.segments.forEach((segment, segIdx) => {
    for (const f of segment.from) {
      for (const t of segment.to) {
        if (shouldDrop(f, t, segIdx)) {
          for (const ref of [f, t]) {
            if (ref.id !== dropNodeId && ref.label !== null) orphanLabels.push(ref);
          }
        } else {
          survivors.push({ from: f, to: t, seg: segIdx });
        }
      }
    }
  });

  const replacements: ModelLine[] = [];

  // Re-home labels that only lived on dropped pairs.
  for (const ref of orphanLabels) {
    const stillLabeled = survivors.some(
      (p) =>
        (p.from.id === ref.id && p.from.label !== null) ||
        (p.to.id === ref.id && p.to.label !== null),
    );
    const definedElsewhere = next.lines.some(
      (l, i) => i !== lineIdx && l.parsed.kind === 'node' && l.parsed.node.id === ref.id,
    );
    if (!stillLabeled && !definedElsewhere) {
      replacements.push({ raw: indent, parsed: { kind: 'node', node: { ...ref } }, dirty: true });
    }
  }

  const original = line.parsed.segments;
  for (const pair of survivors) {
    replacements.push({
      raw: indent,
      parsed: {
        kind: 'edges',
        segments: [
          {
            from: [pair.from],
            to: [pair.to],
            arrow: original[pair.seg].arrow,
            label: original[pair.seg].label,
          },
        ],
      },
      dirty: true,
    });
  }

  next.lines.splice(lineIdx, 1, ...replacements);
}

export function deleteEdge(model: FlowchartModel, edge: EdgeEntry): FlowchartModel {
  const next = clone(model);
  rebuildEdgeLines(
    next,
    edge.line,
    (f, t, seg) => seg === edge.seg && f.id === edge.from && t.id === edge.to,
    null,
  );
  return next;
}

export function deleteNode(model: FlowchartModel, id: string): FlowchartModel {
  const next = clone(model);
  // Walk backwards: rebuilds splice the line list.
  for (let i = next.lines.length - 1; i >= 0; i -= 1) {
    const parsed = next.lines[i].parsed;
    if (parsed.kind === 'node' && parsed.node.id === id) {
      next.lines.splice(i, 1);
    } else if (parsed.kind === 'edges') {
      rebuildEdgeLines(next, i, (f, t) => f.id === id || t.id === id, id);
    }
  }
  return next;
}

/**
 * A label belongs to a SEGMENT syntactically, so on a chain or & group the
 * whole segment's label changes — which is exactly what the mermaid text can
 * express, no more. `null` clears it.
 */
export function setEdgeLabel(
  model: FlowchartModel,
  edge: EdgeEntry,
  label: string | null,
): FlowchartModel {
  const next = clone(model);
  const line = next.lines[edge.line];
  if (line.parsed.kind !== 'edges') return next;
  line.parsed.segments[edge.seg].label = label;
  line.dirty = true;
  return next;
}

export function setDirection(
  model: FlowchartModel,
  direction: 'TD' | 'TB' | 'LR' | 'RL' | 'BT',
): FlowchartModel {
  const next = clone(model);
  const idx = headerIndex(next);
  const parsed = next.lines[idx].parsed;
  if (parsed.kind === 'header') {
    parsed.direction = direction;
    next.lines[idx].dirty = true;
  }
  return next;
}

/**
 * Layout engine rides the diagram's YAML frontmatter (mermaid 11 reads
 * `config.layout`). Opaque lines are edited through their raws — the one
 * sanctioned exception, because frontmatter is structure the parser refuses
 * to own. `dagre` is the default and means "remove the override".
 */
export function setLayoutEngine(model: FlowchartModel, engine: 'dagre' | 'elk'): FlowchartModel {
  const next = clone(model);
  const hasFrontmatter = next.lines[0]?.raw.trim() === '---';

  if (!hasFrontmatter) {
    if (engine === 'dagre') return next;
    next.lines.unshift(
      { raw: '---', parsed: { kind: 'opaque' }, dirty: false },
      { raw: 'config:', parsed: { kind: 'opaque' }, dirty: false },
      { raw: `  layout: ${engine}`, parsed: { kind: 'opaque' }, dirty: false },
      { raw: '---', parsed: { kind: 'opaque' }, dirty: false },
    );
    return next;
  }

  let close = 1;
  while (close < next.lines.length && next.lines[close].raw.trim() !== '---') close += 1;
  const layoutIdx = next.lines.findIndex(
    (l, i) => i > 0 && i < close && l.raw.match(/^\s*layout:/) !== null,
  );

  if (engine === 'dagre') {
    if (layoutIdx !== -1) {
      next.lines.splice(layoutIdx, 1);
      // A now-empty `config:` is left as-is: harmless, and removing more than
      // asked would violate the surgical rule.
    }
    return next;
  }

  if (layoutIdx !== -1) {
    const indent = next.lines[layoutIdx].raw.match(/^\s*/)?.[0] ?? '  ';
    next.lines[layoutIdx].raw = `${indent}layout: ${engine}`;
    return next;
  }
  const configIdx = next.lines.findIndex(
    (l, i) => i > 0 && i < close && l.raw.match(/^\s*config:\s*$/) !== null,
  );
  if (configIdx !== -1) {
    next.lines.splice(configIdx + 1, 0, {
      raw: `  layout: ${engine}`,
      parsed: { kind: 'opaque' },
      dirty: false,
    });
  } else {
    next.lines.splice(close, 0, { raw: 'config:', parsed: { kind: 'opaque' }, dirty: false });
    next.lines.splice(close + 1, 0, {
      raw: `  layout: ${engine}`,
      parsed: { kind: 'opaque' },
      dirty: false,
    });
  }
  return next;
}
```

- [ ] **Step 4: Run the tests; iterate until green**

Run: `pnpm test:run src/mermaid/flowchart/`
Expected: all pass. The chain-split and label-re-homing tests are the ones that flush real bugs — do not weaken them to pass.

- [ ] **Step 5: Lint, typecheck, commit**

```bash
pnpm lint && pnpm typecheck
git add src/mermaid/flowchart/ops.ts src/mermaid/flowchart/ops.test.ts
git commit -m "feat(mermaid): structural ops are surgical text edits with proofs (M29.15)"
```

---

### Task C3: Binding mermaid's SVG back to the model (M29.16)

**Files:**
- Create: `src/mermaid/flowchart/svgBinding.ts`
- Create: `src/mermaid/flowchart/svgBinding.test.ts`

- [ ] **Step 1: Write the failing test**

jsdom parses SVG markup fine — only layout is missing, and binding needs structure, not geometry.

```ts
import { describe, expect, it } from 'vitest';
import { parseFlowchart } from './model';
import { bindFlowchartSvg } from './svgBinding';

const SVG = [
  '<svg viewBox="0 0 100 100">',
  '  <g class="node default" id="flowchart-A-0"><rect/></g>',
  '  <g class="node default" id="flowchart-B-1"><rect/></g>',
  '  <g class="node default" id="flowchart-my-node-2"><rect/></g>',
  '  <path class="edge-thickness-normal edge-pattern-solid flowchart-link" id="L_A_B_0"/>',
  '  <path class="flowchart-link" id="L_B_my-node_0"/>',
  '</svg>',
].join('\n');

describe('bindFlowchartSvg', () => {
  it('maps node groups and edge paths back to model ids — dashes included', () => {
    const model = parseFlowchart(
      'flowchart TD\n  A[One] --> B[Two]\n  B --> my-node[Three]',
    )!;
    const host = document.createElement('div');
    host.innerHTML = SVG;
    const binding = bindFlowchartSvg(host, model);
    expect([...binding.nodeEls.keys()].sort()).toEqual(['A', 'B', 'my-node']);
    expect(binding.edgeEls).toHaveLength(2);
    expect(binding.edgeEls[1]).toMatchObject({ from: 'B', to: 'my-node' });
  });

  it('ignores svg elements that match nothing in the model', () => {
    const model = parseFlowchart('flowchart TD\n  A[One] --> B[Two]')!;
    const host = document.createElement('div');
    host.innerHTML = SVG;
    const binding = bindFlowchartSvg(host, model);
    expect(binding.nodeEls.has('my-node')).toBe(false);
    expect(binding.edgeEls).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to make sure it fails**

Run: `pnpm test:run src/mermaid/flowchart/svgBinding.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/mermaid/flowchart/svgBinding.ts`**

```ts
import type { FlowchartModel } from './model';
import { edges, nodes } from './model';

/**
 * Maps mermaid's rendered flowchart SVG back to model ids (M29.16).
 *
 * Contract verified against vendored mermaid 11.16 source:
 * - node groups:  <g class="node …" id="flowchart-<nodeId>-<counter>">
 *   (MERMAID_DOM_ID_PREFIX, flowchart/flowDb.ts:35)
 * - edge paths:   <path class="… flowchart-link" id="L_<from>_<to>_<n>">
 *   (getEdgeId, utils.ts:933)
 *
 * Ids may contain dashes/underscores, so node ids are matched by prefix+suffix
 * against KNOWN model ids (longest first), never by a lone capture group; edge
 * ids are matched by testing known (from, to) pairs. Anything unmatched stays
 * unbound — an unbound element renders fine, it just isn't editable.
 */
export interface FlowchartSvgBinding {
  nodeEls: Map<string, SVGGElement>;
  edgeEls: { el: SVGPathElement; from: string; to: string }[];
}

export function bindFlowchartSvg(
  container: HTMLElement,
  model: FlowchartModel,
): FlowchartSvgBinding {
  const knownNodes = [...nodes(model).keys()].sort((a, b) => b.length - a.length);
  const nodeEls = new Map<string, SVGGElement>();

  for (const el of container.querySelectorAll<SVGGElement>('g.node[id^="flowchart-"]')) {
    const domId = el.id;
    const match = knownNodes.find(
      (id) =>
        domId.startsWith(`flowchart-${id}-`) &&
        /^\d+$/.test(domId.slice(`flowchart-${id}-`.length)),
    );
    if (match !== undefined && !nodeEls.has(match)) nodeEls.set(match, el);
  }

  const pairs = edges(model);
  const edgeEls: FlowchartSvgBinding['edgeEls'] = [];
  for (const el of container.querySelectorAll<SVGPathElement>('path.flowchart-link')) {
    const domId = el.id;
    const hit = pairs.find(
      (p) =>
        domId.startsWith(`L_${p.from}_${p.to}_`) &&
        /^\d+$/.test(domId.slice(`L_${p.from}_${p.to}_`.length)),
    );
    if (hit !== undefined) edgeEls.push({ el, from: hit.from, to: hit.to });
  }

  return { nodeEls, edgeEls };
}
```

- [ ] **Step 4: Run, lint, commit**

```bash
pnpm test:run src/mermaid/flowchart/ && pnpm lint && pnpm typecheck
git add src/mermaid/flowchart/svgBinding.ts src/mermaid/flowchart/svgBinding.test.ts
git commit -m "feat(mermaid): rendered svg maps back to the model, or safely to nothing (M29.16)"
```

---

### Task C4: `StructuralEditor` — select, rename, mini-toolbar (M29.17)

**Files:**
- Create: `src/mermaid/flowchart/StructuralEditor.tsx`
- Create: `src/mermaid/flowchart/StructuralEditor.test.tsx`

- [ ] **Step 1: Write the failing tests**

Mock `../render` to return a fixture svg whose ids match the fixture code, so jsdom can drive real DOM events end-to-end:

```tsx
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { StructuralEditor } from './StructuralEditor';

const FIXTURE_SVG = [
  '<svg viewBox="0 0 200 100">',
  '<g class="node" id="flowchart-A-0"><rect width="10" height="10"/></g>',
  '<g class="node" id="flowchart-B-1"><rect width="10" height="10"/></g>',
  '<g class="node" id="flowchart-C-2"><rect width="10" height="10"/></g>',
  '<path class="flowchart-link" id="L_A_B_0"/>',
  '</svg>',
].join('');

vi.mock('../render', () => ({
  renderMermaid: vi.fn().mockResolvedValue({ ok: true, svg: FIXTURE_SVG }),
}));

const CODE = 'flowchart TD\n  A[Start] --> B[End]';

describe('StructuralEditor', () => {
  it('renders the diagram and selects a node on click', async () => {
    render(<StructuralEditor code={CODE} onChangeCode={() => {}} />);
    await waitFor(() => expect(document.getElementById('flowchart-A-0')).not.toBeNull());
    await userEvent.click(document.getElementById('flowchart-A-0')!);
    expect(screen.getByTestId('mermaid-node-toolbar')).toBeInTheDocument();
  });

  it('double-click renames through a surgical text edit', async () => {
    const onChangeCode = vi.fn();
    render(<StructuralEditor code={CODE} onChangeCode={onChangeCode} />);
    await waitFor(() => expect(document.getElementById('flowchart-A-0')).not.toBeNull());
    await userEvent.dblClick(document.getElementById('flowchart-A-0')!);
    const input = screen.getByLabelText('Node label');
    await userEvent.clear(input);
    await userEvent.type(input, 'Kickoff{Enter}');
    expect(onChangeCode).toHaveBeenCalledWith('flowchart TD\n  A[Kickoff] --> B[End]');
  });

  it('delete removes the selected node and its edges', async () => {
    const onChangeCode = vi.fn();
    render(<StructuralEditor code={CODE} onChangeCode={onChangeCode} />);
    await waitFor(() => expect(document.getElementById('flowchart-B-1')).not.toBeNull());
    await userEvent.click(document.getElementById('flowchart-B-1')!);
    await userEvent.click(screen.getByRole('button', { name: 'Delete node' }));
    expect(onChangeCode).toHaveBeenCalledWith('flowchart TD\n  A[Start]');
  });

  it('add-connected appends a node and an edge', async () => {
    const onChangeCode = vi.fn();
    render(<StructuralEditor code={CODE} onChangeCode={onChangeCode} />);
    await waitFor(() => expect(document.getElementById('flowchart-A-0')).not.toBeNull());
    await userEvent.click(document.getElementById('flowchart-A-0')!);
    await userEvent.click(screen.getByRole('button', { name: 'Add connected node' }));
    const call = onChangeCode.mock.calls[0][0] as string;
    expect(call).toContain('n1[New step]');
    expect(call).toContain('A --> n1');
  });
});
```

- [ ] **Step 2: Run to make sure it fails**

Run: `pnpm test:run src/mermaid/flowchart/StructuralEditor.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/mermaid/flowchart/StructuralEditor.tsx`**

```tsx
import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { renderMermaid } from '../render';
import { nodes, parseFlowchart, serialize, type Shape } from './model';
import { addEdge, addNode, deleteNode, renameNode, setNodeShape } from './ops';
import { bindFlowchartSvg, type FlowchartSvgBinding } from './svgBinding';

const SHAPE_CHOICES: { shape: Shape; label: string; icon: string }[] = [
  { shape: 'rect', label: 'Rectangle', icon: 'square' },
  { shape: 'rounded', label: 'Rounded', icon: 'square-round-corner' },
  { shape: 'stadium', label: 'Stadium', icon: 'rectangle-horizontal' },
  { shape: 'diamond', label: 'Decision', icon: 'diamond' },
  { shape: 'circle', label: 'Circle', icon: 'circle' },
  { shape: 'cylinder', label: 'Database', icon: 'database' },
  { shape: 'hexagon', label: 'Hexagon', icon: 'hexagon' },
  { shape: 'subroutine', label: 'Subroutine', icon: 'square-stack' },
];

/**
 * The structural editor (M29.17): mermaid renders, we bind its SVG, and every
 * interaction becomes a surgical text edit flowing out through onChangeCode —
 * the same channel typing uses, so BlockNote history gives undo/redo for free.
 * The diagram re-lays-out after each edit; that is mermaid's auto-layout
 * nature, honestly embraced, not fought with hand positions.
 */
export function StructuralEditor({
  code,
  onChangeCode,
}: {
  code: string;
  onChangeCode: (code: string) => void;
}) {
  const model = useMemo(() => parseFlowchart(code), [code]);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const bindingRef = useRef<FlowchartSvgBinding | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  const [toolbarPos, setToolbarPos] = useState<{ x: number; y: number } | null>(null);

  const apply = (next: ReturnType<typeof parseFlowchart>) => {
    if (next !== null) onChangeCode(serialize(next));
  };

  // Render + bind. Selection survives re-renders by id, not by element.
  useEffect(() => {
    let stale = false;
    void renderMermaid(code).then((r) => {
      if (stale || hostRef.current === null) return;
      if (!r.ok) return; // the block view surfaces errors; here we hold the last svg
      // Safe: strict-mode mermaid output, the same sink every Stage A component uses.
      hostRef.current.innerHTML = r.svg;
      if (model === null) return;
      bindingRef.current = bindFlowchartSvg(hostRef.current, model);
      for (const [id, el] of bindingRef.current.nodeEls) {
        el.style.cursor = 'pointer';
        el.onclick = (e) => {
          e.stopPropagation();
          setSelected(id);
          const host = hostRef.current;
          if (host !== null) {
            const hostBox = host.getBoundingClientRect();
            const box = el.getBoundingClientRect();
            setToolbarPos({ x: box.left - hostBox.left, y: box.top - hostBox.top - 34 });
          }
        };
        el.ondblclick = (e) => {
          e.stopPropagation();
          const label = model !== null ? (nodes(model).get(id)?.label ?? id) : id;
          setRenaming({ id, value: label });
        };
      }
    });
    return () => {
      stale = true;
    };
  }, [code, model]);

  // Selection outline via inline stroke on the bound group's shapes.
  useEffect(() => {
    const binding = bindingRef.current;
    if (binding === null) return;
    for (const [id, el] of binding.nodeEls) {
      for (const shapeEl of el.querySelectorAll<SVGElement>('rect, circle, polygon, path')) {
        if (id === selected) {
          shapeEl.style.stroke = 'var(--cortex-500)';
          shapeEl.style.strokeWidth = '2.5px';
        } else {
          shapeEl.style.stroke = '';
          shapeEl.style.strokeWidth = '';
        }
      }
    }
  });

  if (model === null) {
    // Header unparseable: render-only + honest hint. Rendering never degrades.
    return (
      <div className="px-3 py-2">
        <div ref={hostRef} data-testid="structural-host" />
        <div className="mt-1 text-xs text-n-400">
          This diagram uses syntax the visual editor does not own — edit it as code.
        </div>
      </div>
    );
  }

  const commitRename = () => {
    if (renaming === null) return;
    apply(renameNode(model, renaming.id, renaming.value));
    setRenaming(null);
  };

  return (
    <div
      className="relative px-3 py-2"
      onClick={() => {
        setSelected(null);
        setToolbarPos(null);
      }}
      onKeyDown={(e) => {
        if (
          (e.key === 'Delete' || e.key === 'Backspace') &&
          selected !== null &&
          renaming === null
        ) {
          apply(deleteNode(model, selected));
          setSelected(null);
          setToolbarPos(null);
        }
      }}
      tabIndex={-1}
    >
      <div
        ref={hostRef}
        data-testid="structural-host"
        className="[&_svg]:h-auto [&_svg]:max-w-full"
      />

      {selected !== null && toolbarPos !== null && renaming === null && (
        <div
          data-testid="mermaid-node-toolbar"
          className="absolute z-10 flex items-center gap-0.5 rounded-md border border-n-200 bg-n-0 px-1 py-0.5 shadow-sm"
          style={{ left: toolbarPos.x, top: Math.max(0, toolbarPos.y) }}
          onClick={(e) => e.stopPropagation()}
        >
          {SHAPE_CHOICES.map((c) => (
            <button
              key={c.shape}
              type="button"
              title={c.label}
              aria-label={`Shape: ${c.label}`}
              onClick={() => apply(setNodeShape(model, selected, c.shape))}
              className="rounded border-0 bg-transparent p-1 hover:bg-n-50"
            >
              <Icon name={c.icon} size={13} color="var(--n-600)" />
            </button>
          ))}
          <span className="mx-0.5 h-4 w-px bg-n-100" />
          <button
            type="button"
            aria-label="Add connected node"
            onClick={() => {
              const added = addNode(model, 'New step');
              apply(addEdge(added.model, selected, added.id));
            }}
            className="rounded border-0 bg-transparent p-1 hover:bg-n-50"
          >
            <Icon name="plus" size={13} color="var(--n-600)" />
          </button>
          <button
            type="button"
            aria-label="Delete node"
            onClick={() => {
              apply(deleteNode(model, selected));
              setSelected(null);
              setToolbarPos(null);
            }}
            className="rounded border-0 bg-transparent p-1 hover:bg-danger-50"
          >
            <Icon name="trash-2" size={13} color="var(--danger-600)" />
          </button>
        </div>
      )}

      {renaming !== null && (
        <input
          autoFocus
          aria-label="Node label"
          value={renaming.value}
          onChange={(e) => setRenaming({ ...renaming, value: e.target.value })}
          onBlur={commitRename}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') commitRename();
            if (e.key === 'Escape') setRenaming(null);
          }}
          className="absolute left-1/2 top-2 z-10 -translate-x-1/2 rounded-md border border-cortex-500 bg-n-0 px-2 py-1 text-sm text-n-800 shadow-sm outline-none"
        />
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run the tests; iterate until green**

Run: `pnpm test:run src/mermaid/flowchart/StructuralEditor.test.tsx`
Expected: 4 passed. jsdom note: `getBoundingClientRect` returns zeros — the toolbar renders at 0,0, which the tests treat as fine; geometry is e2e's job.

- [ ] **Step 5: Lint, typecheck, commit**

```bash
pnpm lint && pnpm typecheck
git add src/mermaid/flowchart/StructuralEditor.tsx src/mermaid/flowchart/StructuralEditor.test.tsx
git commit -m "feat(mermaid): click the diagram — select, rename, reshape, add, delete (M29.17)"
```

---

### Task C5: Drag-to-connect, block toolbar, mode integration (M29.18)

**Files:**
- Modify: `src/mermaid/flowchart/StructuralEditor.tsx` (ghost-line connect + toolbar)
- Modify: `src/mermaid/MermaidBlockView.tsx` (visual/code modes)
- Modify: `src/mermaid/MermaidBlockView.test.tsx`, `src/mermaid/flowchart/StructuralEditor.test.tsx`

- [ ] **Step 1: Write the failing tests**

Add to `StructuralEditor.test.tsx` (the fixture already includes `flowchart-C-2`, ignored by two-node code per C3):

```tsx
import { fireEvent } from '@testing-library/react';

it('drag from node to node draws a new edge', async () => {
  const onChangeCode = vi.fn();
  render(
    <StructuralEditor
      code={'flowchart TD\n  A[Start] --> B[End]\n  C[Loose]'}
      onChangeCode={onChangeCode}
    />,
  );
  await waitFor(() => expect(document.getElementById('flowchart-A-0')).not.toBeNull());
  const a = document.getElementById('flowchart-A-0')!;
  fireEvent.pointerDown(a, { clientX: 10, clientY: 10, pointerId: 1 });
  fireEvent.pointerMove(window, { clientX: 60, clientY: 60, pointerId: 1 });
  // Drop target resolution uses elementFromPoint — stub it to the C node.
  const c = document.getElementById('flowchart-C-2');
  document.elementFromPoint = () => c;
  fireEvent.pointerUp(window, { clientX: 60, clientY: 60, pointerId: 1 });
  expect(onChangeCode).toHaveBeenCalledWith(
    'flowchart TD\n  A[Start] --> B[End]\n  C[Loose]\n  A --> C',
  );
});

it('clicking an edge opens its editor; saving sets the label, delete removes it', async () => {
  const onChangeCode = vi.fn();
  render(<StructuralEditor code={CODE} onChangeCode={onChangeCode} />);
  await waitFor(() => expect(document.getElementById('L_A_B_0')).not.toBeNull());
  await userEvent.click(document.getElementById('L_A_B_0')!);
  const label = screen.getByLabelText('Edge label');
  await userEvent.type(label, 'go{Enter}');
  expect(onChangeCode).toHaveBeenCalledWith('flowchart TD\n  A[Start] -->|go| B[End]');

  await userEvent.click(document.getElementById('L_A_B_0')!);
  await userEvent.click(screen.getByRole('button', { name: 'Delete edge' }));
  expect(onChangeCode).toHaveBeenLastCalledWith('flowchart TD\n  A[Start]\n  B[End]');
});

it('direction buttons rewrite the header only', async () => {
  const onChangeCode = vi.fn();
  render(<StructuralEditor code={CODE} onChangeCode={onChangeCode} />);
  await userEvent.click(screen.getByRole('button', { name: 'Direction LR' }));
  expect(onChangeCode).toHaveBeenCalledWith('flowchart LR\n  A[Start] --> B[End]');
});

it('layout toggle writes the elk frontmatter', async () => {
  const onChangeCode = vi.fn();
  render(<StructuralEditor code={CODE} onChangeCode={onChangeCode} />);
  await userEvent.click(screen.getByRole('button', { name: 'Layout: Dagre' }));
  expect(onChangeCode.mock.calls[0][0]).toContain('layout: elk');
});
```

Add to `MermaidBlockView.test.tsx`:

```tsx
it('flowcharts edit visually with a code toggle; other types go straight to code', async () => {
  renderMock.mockResolvedValue({ ok: true, svg: '<svg></svg>' });
  render(<MermaidBlockView code={'flowchart TD\n  A[X] --> B[Y]'} onChangeCode={() => {}} />);
  await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
  expect(screen.getByTestId('structural-host')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Show code' }));
  expect(screen.getByLabelText('Mermaid source')).toBeInTheDocument();
});

it('non-flowcharts have no visual mode', async () => {
  renderMock.mockResolvedValue({ ok: true, svg: '<svg></svg>' });
  render(<MermaidBlockView code={'sequenceDiagram\n  A->>B: hi'} onChangeCode={() => {}} />);
  await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
  expect(screen.getByLabelText('Mermaid source')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Show code' })).toBeNull();
});
```

- [ ] **Step 2: Run to make sure they fail**

Run: `pnpm test:run src/mermaid/`
Expected: new tests FAIL.

**Note on the delete-edge expectation:** deleting the only edge leaves `A[Start]` and `B[End]` as re-homed definition lines (C2's orphan-label rule) — the test's expected string encodes exactly that.

- [ ] **Step 3: Implement the edge editor in `StructuralEditor.tsx`**

State:

```tsx
import { edges, type EdgeEntry } from './model';
import { deleteEdge, setEdgeLabel } from './ops'; // extend the existing ops import

const [edgeEditor, setEdgeEditor] = useState<{ edge: EdgeEntry; value: string } | null>(null);
```

In the bind effect, wire the bound edge paths (after the node loop):

```tsx
const modelEdges = edges(model);
for (const bound of bindingRef.current.edgeEls) {
  bound.el.style.cursor = 'pointer';
  bound.el.onclick = (e) => {
    e.stopPropagation();
    const entry = modelEdges.find((me) => me.from === bound.from && me.to === bound.to);
    if (entry !== undefined) {
      setSelected(null);
      setToolbarPos(null);
      setEdgeEditor({ edge: entry, value: entry.label ?? '' });
    }
  };
}
```

Edge editor popover in the JSX (sibling of the rename input; jsdom geometry is zeros, so fixed top-center placement is fine — e2e sees the real thing):

```tsx
{edgeEditor !== null && (
  <div
    className="absolute left-1/2 top-2 z-10 flex -translate-x-1/2 items-center gap-1 rounded-md border border-n-200 bg-n-0 px-1.5 py-1 shadow-sm"
    onClick={(e) => e.stopPropagation()}
  >
    <input
      autoFocus
      aria-label="Edge label"
      value={edgeEditor.value}
      placeholder="label"
      onChange={(e) => setEdgeEditor({ ...edgeEditor, value: e.target.value })}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          apply(setEdgeLabel(model, edgeEditor.edge, edgeEditor.value.trim() === '' ? null : edgeEditor.value));
          setEdgeEditor(null);
        }
        if (e.key === 'Escape') setEdgeEditor(null);
      }}
      className="w-32 rounded border border-n-200 bg-n-0 px-1.5 py-0.5 text-xs text-n-800 outline-none"
    />
    <button
      type="button"
      aria-label="Delete edge"
      onClick={() => {
        apply(deleteEdge(model, edgeEditor.edge));
        setEdgeEditor(null);
      }}
      className="rounded border-0 bg-transparent p-1 hover:bg-danger-50"
    >
      <Icon name="trash-2" size={13} color="var(--danger-600)" />
    </button>
  </div>
)}
```

- [ ] **Step 4: Implement drag-to-connect + toolbar in `StructuralEditor.tsx`**

Extend the ops import to include `setDirection, setLayoutEngine`. Add state and a helper:

```tsx
const [ghost, setGhost] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
const dragFrom = useRef<string | null>(null);
```

```tsx
function isElk(code: string): boolean {
  return code.match(/^\s*layout:\s*elk\s*$/m) !== null;
}
```

In the bind effect, per node element add:

```tsx
el.onpointerdown = (e) => {
  e.stopPropagation();
  dragFrom.current = id;
  const hostBox = hostRef.current!.getBoundingClientRect();
  setGhost({
    x1: e.clientX - hostBox.left,
    y1: e.clientY - hostBox.top,
    x2: e.clientX - hostBox.left,
    y2: e.clientY - hostBox.top,
  });
};
```

Window-level listeners (one effect, cleaned up on unmount):

```tsx
useEffect(() => {
  const move = (e: PointerEvent) => {
    if (dragFrom.current === null || hostRef.current === null) return;
    const hostBox = hostRef.current.getBoundingClientRect();
    setGhost((g) =>
      g === null ? null : { ...g, x2: e.clientX - hostBox.left, y2: e.clientY - hostBox.top },
    );
  };
  const up = (e: PointerEvent) => {
    const from = dragFrom.current;
    dragFrom.current = null;
    setGhost(null);
    if (from === null || model === null) return;
    const target = document.elementFromPoint(e.clientX, e.clientY);
    const group = target?.closest('g.node[id^="flowchart-"]');
    if (group !== null && group !== undefined) {
      const binding = bindingRef.current;
      const hit =
        binding === null
          ? undefined
          : [...binding.nodeEls.entries()].find(([, el]) => el === group);
      if (hit !== undefined && hit[0] !== from) {
        apply(addEdge(model, from, hit[0]));
        return;
      }
    }
    // Dropped on empty canvas inside the host: new node + edge.
    if (hostRef.current !== null && target !== null && hostRef.current.contains(target)) {
      const added = addNode(model, 'New step');
      apply(addEdge(added.model, from, added.id));
    }
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  return () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
  };
}, [model]);
```

Block toolbar above the host:

```tsx
<div className="mb-1.5 flex items-center gap-1" data-testid="structural-toolbar">
  <button
    type="button"
    aria-label="Add node"
    onClick={() => apply(addNode(model, 'New step').model)}
    className="rounded-md border border-n-200 bg-n-0 px-1.5 py-0.5 text-xs text-n-600 hover:bg-n-50"
  >
    + Node
  </button>
  {(['TD', 'LR', 'BT', 'RL'] as const).map((d) => (
    <button
      key={d}
      type="button"
      aria-label={`Direction ${d}`}
      onClick={() => apply(setDirection(model, d))}
      className="rounded-md border border-n-200 bg-n-0 px-1.5 py-0.5 text-xs text-n-600 hover:bg-n-50"
    >
      {d}
    </button>
  ))}
  <button
    type="button"
    aria-label={isElk(code) ? 'Layout: ELK' : 'Layout: Dagre'}
    onClick={() => apply(setLayoutEngine(model, isElk(code) ? 'dagre' : 'elk'))}
    className="rounded-md border border-n-200 bg-n-0 px-1.5 py-0.5 text-xs text-n-600 hover:bg-n-50"
  >
    {isElk(code) ? 'Layout: ELK' : 'Layout: Dagre'}
  </button>
</div>
```

Ghost line (inside the relative container, after the host):

```tsx
{ghost !== null && (
  <svg className="pointer-events-none absolute inset-0 h-full w-full">
    <line
      x1={ghost.x1}
      y1={ghost.y1}
      x2={ghost.x2}
      y2={ghost.y2}
      stroke="var(--cortex-500)"
      strokeWidth="1.5"
      strokeDasharray="4 3"
    />
  </svg>
)}
```

- [ ] **Step 5: Integrate modes into `MermaidBlockView.tsx`**

```tsx
import { StructuralEditor } from './flowchart/StructuralEditor';
import { parseFlowchart } from './flowchart/model';
```

```tsx
const [editMode, setEditMode] = useState<'visual' | 'code'>('visual');
const isVisualCapable = parseFlowchart(editing ? draft : code) !== null;
```

Header gains the toggle while editing a visual-capable diagram:

```tsx
{editing && isVisualCapable && (
  <button
    type="button"
    onMouseDown={(e) => e.preventDefault()}
    onClick={() => setEditMode(editMode === 'visual' ? 'code' : 'visual')}
    className="rounded-md border-0 bg-transparent px-1.5 py-0.5 text-xs text-n-500 hover:bg-n-50 hover:text-n-800"
  >
    {editMode === 'visual' ? 'Show code' : 'Show diagram'}
  </button>
)}
```

Edit body routes:

```tsx
{editing && isVisualCapable && editMode === 'visual' && (
  <StructuralEditor
    code={draft}
    onChangeCode={(next) => {
      setDraft(next);
      onChangeCode(next); // each visual op commits — one BlockNote history step each
    }}
  />
)}
{editing && (!isVisualCapable || editMode === 'code') && (
  /* Stage B side-by-side: HighlightedTextarea + LivePreview, unchanged */
)}
```

Visual edits commit through `onChangeCode` per operation (not on Done) — that is what makes cmd+z undo one visual action at a time. Done still exits edit mode; Escape in visual mode just exits (nothing uncommitted exists there).

- [ ] **Step 6: Run everything, iterate**

Run: `pnpm test:run src/mermaid/ && pnpm lint && pnpm typecheck`
Expected: green.

- [ ] **Step 7: Commit**

```bash
git add src/mermaid/
git commit -m "feat(mermaid): edges edit and connect by touch — labels, deletes, drags, toolbar (M29.18)"
```

---

### Task C6: e2e — the whole loop against real mermaid (M29.19)

**Files:**
- Modify: `e2e/diagrams.spec.ts` (third test)

- [ ] **Step 1: Write the e2e**

```ts
test('structural editing round-trips to the file', async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem('cerebro.autoLearn', 'false');
    window.localStorage.setItem('cerebro.themeMode', 'light');
  });
  await page.goto('/');
  const demoButton = page.getByRole('button', { name: 'Open demo vault' });
  const sidebarTypes = page.getByTestId('sidebar-type');
  await expect(demoButton.or(sidebarTypes.first())).toBeVisible({ timeout: 10_000 });
  if (await demoButton.isVisible()) {
    await demoButton.click();
  }

  await page.keyboard.press('Meta+p');
  await page.keyboard.type('Systems map');
  await page.keyboard.press('Enter');
  await page.getByTestId('mermaid-diagram').first().waitFor();

  // Enter visual editing on the first (flowchart) block.
  await page.getByTestId('mermaid-block').first().getByRole('button', { name: 'Edit' }).click();
  await page.getByTestId('structural-host').locator('svg').waitFor({ timeout: 15_000 });

  // Rename "Idea" by double-clicking its node.
  await page.locator('[id^="flowchart-Idea-"]').dblclick();
  await page.getByLabel('Node label').fill('Spark');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('structural-host')).toContainText('Spark', { timeout: 15_000 });

  // The code view shows the surgical edit.
  await page.getByRole('button', { name: 'Show code' }).click();
  await expect(page.getByLabel('Mermaid source')).toHaveValue(/Idea\[Spark\]/);

  // And the mock fs eventually holds it (same helper smoke.spec.ts uses).
  await expect
    .poll(
      () => page.evaluate(() => window.__cerebroMockFs.get('strategy/systems-map.md')),
      { timeout: 15_000 },
    )
    .toContain('Idea[Spark]');

  // Undo restores the previous label in the visual view.
  await page.getByRole('button', { name: 'Show diagram' }).click();
  await page.keyboard.press('Meta+z');
  await expect(page.getByTestId('structural-host')).toContainText('Idea', { timeout: 15_000 });
});
```

Declare `__cerebroMockFs` at the top of the file the way `smoke.spec.ts` does (global interface). If the mock-fs key differs (absolute vs vault-relative), copy the exact path convention from `readMockFile` usages in `smoke.spec.ts`. If cmd+z through BlockNote does not restore a block-prop change (verify live!), replace the undo assertion with a second rename back — and record the undo gap in the PR description rather than faking a pass.

- [ ] **Step 2: Run e2e, then everything**

Run: `PORT=5273 pnpm e2e -- diagrams.spec.ts` — Expected: 3 passed.
Run: `pnpm lint && pnpm typecheck && pnpm test:run && pnpm test:coverage && PORT=5273 pnpm e2e && (cd src-tauri && cargo test && cargo fmt --check && cargo clippy --all-targets -- -D warnings)`
Expected: all green.

- [ ] **Step 3: Commit, then finish the branch**

```bash
git add e2e/diagrams.spec.ts
git commit -m "test(mermaid): structural edit round-trips through svg, code, and disk (M29.19)"
```

Then use the superpowers:finishing-a-development-branch skill (PR against `main`, milestone M29 complete).

---

## Stage C exit criteria

- A flowchart block edits visually: click selects (mini-toolbar: 8 shapes, add-connected, delete), double-click renames, drag connects, clicking an edge edits its label or deletes it, toolbar adds nodes and flips direction/layout; "Show code" flips to Stage B's side-by-side, in both directions.
- Every visual op is a minimal text edit; `classDef`/`class`/`style`/`click`/comments/frontmatter in a diagram survive byte-for-byte (unit-proven); ids never change.
- Non-flowchart diagrams and unparseable flowcharts render exactly as before, with the honest "edit as code" path.
- One visual op = one undo step through the normal history.
- Full gate green, coverage ratchet intact.
