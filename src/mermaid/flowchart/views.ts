/**
 * Derived read-views over a parsed model — resolved nodes, expanded edges,
 * merged meta, folded styles, link ownership. Nothing here emits or mutates.
 */

import type { EdgeArrow, FlowchartModel, NodeMeta, NodeRef, Shape } from './types';
import { withEntry, withMetaEntry } from './types';

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

/**
 * Any click statement at all: the id-list token, then everything after it.
 * Deliberately looser than `CLICK_LINE` — this reads lines we do NOT own, so
 * it answers mermaid's lexing, not our ownership rules.
 */
const CLICK_STATEMENT = /^click[^\S\r\n]+(\S+)[^\S\r\n]+(.*)$/;

/**
 * Every line — OWNED OR OPAQUE — whose `click` statement writes `id`'s LINK
 * slot, in source order. The one place that answers "who else is writing
 * here", so `nodeLinks` and `setNodeLink` can never disagree about it.
 *
 * Reading an opaque line's raw text without OWNING it is the same move
 * `hasOpaqueMetaBlock` makes. Two measured facts shape it:
 *
 * - `setLink` does `ids.split(',').forEach(…)` (flowDb.ts:551-559), so
 *   `click A,B "both.md"` writes BOTH slots and an id in the TAIL of the list
 *   counts exactly as much as the head. Matching only the head was the M29.36
 *   review defect. `click A, B "x"` is NOT a list — the space ends the id
 *   token and mermaid reduces the line to a callback, writing no link at all.
 * - only the `STR` and `HREF STR` arms reach `setLink`; `call fn()` and a bare
 *   callback name go to `setClickEvent` (flow.jison:541-555) and leave the
 *   link untouched — measured, `click A "one.md"` + `click A call doThing()`
 *   still resolves to `one.md`. Treating those as writers would relocate an
 *   owned line for nothing.
 *
 * Whitespace is read loosely on purpose: a line mermaid rejects outright
 * (`click A  "x"`) renders nothing at all, so mistaking it for a writer costs
 * only a line's position in a document that already cannot draw.
 */
export function linkWriterLines(model: FlowchartModel, id: string): number[] {
  const out: number[] = [];
  model.lines.forEach((line, i) => {
    const statement = line.raw.trim().match(CLICK_STATEMENT);
    if (statement === null || !statement[1].split(',').includes(id)) return;
    const rest = statement[2];
    // `"href"[\s]` is upstream's own lexer rule, so `hrefx "y"` is not it.
    if (rest.startsWith('"') || /^href[^\S\r\n]/.test(rest)) out.push(i);
  });
  return out;
}

export interface NodeLink {
  /** The owned line carrying the target — the one an edit would rewrite. */
  line: number;
  target: string;
  /**
   * True when a click statement we do NOT own also writes this slot: an
   * `href` form, or a comma id-list naming this id. It means two things a UI
   * has to say out loud, both measured:
   *
   * - the render may disagree with `target` (the last writer wins, and that
   *   writer might not be ours — until `setNodeLink` runs, which relocates
   *   below it and takes the slot back);
   * - **a CLEAR cannot fully clear.** `setNodeLink(…, null)` removes our
   *   lines and must not touch an opaque one, so `click A "plain"` +
   *   `click A href "href.md"` clears to a node the editor reports as
   *   unlinked and mermaid still draws linked. The behaviour is right — we do
   *   not rewrite lines we do not understand — but a control that offers
   *   "remove link" without saying so would be lying.
   */
  contested: boolean;
}

/**
 * Every node with an OWNED click line → its target and the line carrying it.
 * Later lines win, which is what mermaid itself does: `setLink` assigns
 * `vertex.link` outright (flowDb.ts:551-559) — measured on 11.16.0, three
 * plain click lines for one id resolve to the third.
 *
 * A node linked ONLY by a variant we do not own has NO ENTRY here at all, so
 * "absent from this map" means "no link we can edit", never "no link".
 * `contested` covers the other half: an entry that exists but is shared.
 *
 * One more measured divergence, not worth a flag: a click line ABOVE its
 * node's first declaration is DEAD upstream (`setLink` only assigns to a
 * vertex that already exists) while this map still reports it. `setNodeLink`
 * never leaves one there, and `deleteNode` sweeps them.
 *
 * The editor is the thing that ACTS on these: render.ts pins `securityLevel:
 * 'strict'`, where mermaid attaches no click handlers (`setClickFun` returns
 * early unless the level is 'loose', flowDb.ts:498). It does still emit a real
 * `<a href="…">` around the node label even at strict — measured — so the
 * picture is not inert and a relative target is a live navigation inside the
 * app. Neutralizing that belongs to whoever binds the svg.
 */
export function nodeLinks(model: FlowchartModel): Map<string, NodeLink> {
  const owned = new Map<string, Set<number>>();
  const out = new Map<string, NodeLink>();
  model.lines.forEach((line, i) => {
    if (line.parsed.kind !== 'click') return;
    const { id, target } = line.parsed;
    out.set(id, { line: i, target, contested: false });
    const mine = owned.get(id) ?? new Set<number>();
    mine.add(i);
    owned.set(id, mine);
  });
  for (const [id, entry] of out) {
    const mine = owned.get(id) ?? new Set<number>();
    entry.contested = linkWriterLines(model, id).some((i) => !mine.has(i));
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
