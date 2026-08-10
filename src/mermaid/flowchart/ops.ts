import type {
  EdgeEntry,
  EdgeHead,
  EdgeStroke,
  FlowchartModel,
  ModelLine,
  NodeMeta,
  NodeRef,
  Shape,
} from './model';
import {
  DEFAULT_ARROW,
  clickTarget,
  edgeMetaLinesFor,
  edges,
  emitArrow,
  nodeMeta,
  nodes,
  styleDecl,
  withEntry,
  withMetaEntry,
} from './model';
import { REGISTRY_TO_BRACKET, SHORT_NAME_FOR } from './shapes';

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
function findLabelSite(model: FlowchartModel, id: string): { line: number; ref: NodeRef } | null {
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
  // A meta `label:` wins over any bracket label at render time, so when one
  // exists the rename must land THERE — editing brackets would leave the
  // visible text unchanged and the "rename" silently ineffective.
  for (let i = next.lines.length - 1; i >= 0; i -= 1) {
    const parsed = next.lines[i].parsed;
    if (parsed.kind === 'node-meta' && parsed.id === id && parsed.meta.label !== undefined) {
      parsed.meta = withMetaEntry(parsed.meta, 'label', label);
      next.lines[i].dirty = true;
      return next;
    }
  }
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

/** `id`'s `@{ … }` lines that annotate the NODE, in source order (edge meta excluded). */
function nodeMetaLinesFor(model: FlowchartModel, id: string): number[] {
  const edgeLines = new Set(edgeMetaLinesFor(model, id));
  const out: number[] = [];
  model.lines.forEach((line, i) => {
    if (line.parsed.kind === 'node-meta' && line.parsed.id === id && !edgeLines.has(i)) out.push(i);
  });
  return out;
}

/**
 * True when an OPAQUE line opens a multi-line `id@{` block.
 *
 * The block form is real mermaid and carries a real shape, but the parser
 * declines it (M29.29) — so `nodeMeta()` cannot see it while `nodes()` still
 * reports the node, and `setNodeShape` would take the brackets-first path,
 * invent a definition line, and change nothing on screen because the block's
 * `shape:` still wins at render. That is the exact "inert on a meta-shaped
 * node" defect M29.32 closed, surviving in the form the plan declared opaque —
 * plus a spurious line. The meta path is no better: its new line lands ABOVE
 * the block, which then out-votes it.
 *
 * `startsWith` rather than an exact match, because any opaque line opening
 * `id@{` is meta for `id` that we cannot read, however it continues. The `@`
 * makes prefix collision impossible (`AB@{` never starts with `A@{`).
 */
function hasOpaqueMetaBlock(model: FlowchartModel, id: string): boolean {
  return model.lines.some((l) => l.parsed.kind === 'opaque' && l.raw.trim().startsWith(`${id}@{`));
}

/** True when some edge line carries `id` as ITS id (`A e1@--> B`). */
function declaresEdgeId(model: FlowchartModel, id: string): boolean {
  return model.lines.some(
    (l) => l.parsed.kind === 'edges' && l.parsed.segments.some((seg) => seg.id === id),
  );
}

/**
 * Where a write of `key` belongs among `id`'s meta lines, creating an empty one
 * after the node's anchor when there is none.
 *
 * The LAST line already declaring `key` wins, then the last line at all.
 * Several `id@{ … }` lines may name one node and mermaid folds them PER KEY
 * with the last value winning (`mergeMeta`, flowDb.ts:236-262 — re-measured for
 * `icon` in icons.mermaid.test.ts), so writing to the first would leave a later
 * `shape:`/`icon:` still rendering — the silent no-op M29.30 found for `style`
 * lines, in its meta twin.
 */
function ensureMetaLine(next: FlowchartModel, id: string, key: string): number {
  const owners = nodeMetaLinesFor(next, id);
  const declares = (i: number): boolean => {
    const parsed = next.lines[i].parsed;
    return parsed.kind === 'node-meta' && parsed.meta.entries.some(([k]) => k === key);
  };
  const target = owners.filter(declares).at(-1) ?? owners.at(-1);
  if (target !== undefined) return target;
  const at = anchorLineFor(next, id);
  const indent = next.lines[at]?.raw.match(/^\s*/)?.[0] ?? '  ';
  next.lines.splice(at + 1, 0, {
    raw: indent,
    parsed: { kind: 'node-meta', id, meta: { entries: [] } },
    dirty: true,
  });
  return at + 1;
}

/**
 * D4 shape strategy (M29.32). A classic-8 target on a node with NO meta line
 * rewrites brackets — exactly the Stage-C behavior, byte for byte. Everything
 * else patches (or creates) the node's `@{ shape }` meta line and leaves the
 * brackets alone: shape data WINS at render, so a node carrying
 * `A@{ shape: cloud }` used to swallow every shape click silently (the gap the
 * M29.29 and M29.30 reviews both logged), and rewriting a bracket pair nobody
 * asked about violates the surgical rule besides.
 *
 * `shape` is whatever a caller hands us — a `Shape` literal, a registry short
 * name, or a registry alias — and what we WRITE is always the canonical short
 * name `SHORT_NAME_FOR` maps it to. Any spelling that table does not know is
 * refused outright, because `flowDb.addVertex` THROWS on an unknown name, on
 * any capital, and on any underscore (flowDb.ts:236-241), and a throw there
 * takes the whole diagram down. Both lookup tables are null-prototype, so
 * `toString` and friends are refused too rather than answered by Object.
 */
export function setNodeShape(
  model: FlowchartModel,
  id: string,
  shape: Shape | string,
): FlowchartModel {
  // An id the diagram does not declare is a no-op, exactly as in setNodeStyle.
  // Both paths below would otherwise CREATE the node — a definition line, or a
  // lone `A@{ shape: … }`, which is a declaration in its own right (M29.29) —
  // and "reshape a node that isn't there" has no honest reading. It also means
  // `id` is always a token our own parser produced, so every line emitted here
  // is one we can read straight back.
  if (!nodes(model).has(id)) return clone(model);
  // Meta we cannot read is meta we cannot beat: the block's shape wins at
  // render whatever we write, so every path here would be a visible no-op
  // paid for with changed bytes and an undo step.
  if (hasOpaqueMetaBlock(model, id)) return clone(model);

  const bracket = REGISTRY_TO_BRACKET[shape];
  if (bracket !== undefined && !nodeMeta(model).has(id)) {
    const withLabel = findLabelSite(model, id) === null ? renameNode(model, id, id) : clone(model);
    const site = findLabelSite(withLabel, id);
    if (site === null) return withLabel; // unreachable: rename just created a site
    site.ref.shape = bracket;
    if (site.ref.label === null) site.ref.label = id;
    withLabel.lines[site.line].dirty = true;
    return withLabel;
  }

  // Canonicalize on the way out: an alias renders the same shape but leaves a
  // second spelling in the file for the same thing, and `undefined` here is
  // every rejection at once — unknown name, wrong case, underscore, or an
  // Object.prototype member (the table is null-prototype).
  const registryName = SHORT_NAME_FOR[shape];
  if (registryName === undefined) return clone(model);
  // Already this shape: do nothing at all. Canonicalizing would otherwise
  // rewrite a user's `shape: database` to `shape: cyl` on a click that picked
  // the button already showing as pressed — changed bytes and an undo entry
  // for an edit that moved nothing. Compared through SHORT_NAME_FOR so an
  // alias counts as the shape it denotes, exactly as the palette reads it.
  const currentMeta = nodes(model).get(id)?.metaShape;
  if (currentMeta !== undefined && SHORT_NAME_FOR[currentMeta] === registryName) {
    return clone(model);
  }
  // An id some edge also claims makes POSITION decide what an `@{ … }` line
  // means (flowDb.ts:163, and `edgeMetaLines` in model.ts): below that edge the
  // shape we wrote would be read as edge meta and silently dropped. We cannot
  // reproduce that, so we decline — the bytes survive, which is never wrong.
  if (declaresEdgeId(model, id)) return clone(model);
  const next = clone(model);
  const idx = ensureMetaLine(next, id, 'shape');
  const line = next.lines[idx];
  if (line.parsed.kind !== 'node-meta') return next; // unreachable; narrows the type
  line.parsed.meta = withMetaEntry(line.parsed.meta, 'shape', registryName);
  line.dirty = true;
  return next;
}

/*
 * WHAT A PICKER SHOWS AND WHAT MERMAID DRAWS — the one rule, stated once
 * (M29.35 review), so no control has to re-decide it.
 *
 * A node can carry `img`, `icon` and `shape` at the same time, and mermaid
 * resolves them in that order: `getTypeFromVertex` (flowDb.ts:972-988) returns
 * the image shape if there is an image, else an icon shape if there is an
 * icon, else the `shape`/bracket type. Measured on the bundled 11.16.0.
 *
 * So a pick that is currently out-ranked — a shape chosen on a node that also
 * has an icon, an icon chosen on a node that also has an image — is written
 * and KEPT, and it takes effect the moment the out-ranking key is removed. It
 * is LATENT, not dead, which is exactly what separates it from the silent
 * no-ops M29.30/.32/.33 each had to close: those could never render, however
 * the document changed, which is why THEY are refusals and this is not.
 *
 * The pickers therefore reflect the MODEL — what the node carries — and not
 * the resolved drawing. Surfacing "this is set but out-ranked" on the canvas
 * is a UI affordance nothing here provides yet; it belongs to Stage F4, which
 * owns canvas affordances, and is recorded as open rather than pretended.
 */

/** The keys that exist only to present an icon — meaningless without one. */
const ICON_PRESENTATION = ['form', 'pos'];

/**
 * Icon metadata rides the node's `@{ … }` meta line (M29.35, spec D6).
 *
 * Setting writes `icon` (always quoted on the way out — the value carries the
 * pack's `:`) and defaults `form: rounded` / `pos: b` ONLY when the node has
 * neither, so an explicit choice survives an icon swap. Clearing (`null`)
 * removes icon/form/pos as a unit and deletes any line that empties.
 *
 * MEASURED on the bundled 11.16.0 (icons.mermaid.test.ts), because all three
 * of these are claims about mermaid and not preferences:
 *
 * - An icon BEATS a shape, and an image beats both — the precedence stated
 *   above. A shape already on the node is kept, not cleared: it is latent, and
 *   draws again as soon as the icon goes. `form` picks between the
 *   `icon`/`iconSquare`/`iconCircle`/`iconRounded` shapes; all four are in
 *   11.16.0's registry.
 * - Several meta lines for one node fold PER KEY, LAST value winning — so a
 *   set goes to the last line already carrying `icon` and a clear strips EVERY
 *   line. Writing to the first would be the silent no-op M29.30/.32/.33 each
 *   had to close in a different control.
 * - An unregistered pack or an unknown name renders mermaid's placeholder box,
 *   never an error, so no value here can take the diagram down.
 *
 * The refusals mirror `setNodeShape`'s exactly, for the same reasons: an
 * undeclared id would be CREATED by either path; an opaque multi-line `id@{`
 * block out-votes anything we write, making every edit a visible no-op paid
 * for in bytes and an undo step; and an id some edge also claims makes POSITION
 * decide what an `@{ … }` line means, which we cannot reproduce.
 */
export function setNodeIcon(
  model: FlowchartModel,
  id: string,
  icon: string | null,
): FlowchartModel {
  if (!nodes(model).has(id)) return clone(model);
  if (hasOpaqueMetaBlock(model, id)) return clone(model);
  if (declaresEdgeId(model, id)) return clone(model);

  const next = clone(model);
  const owners = nodeMetaLinesFor(next, id);
  const metaAt = (i: number): NodeMeta | null => {
    const parsed = next.lines[i].parsed;
    return parsed.kind === 'node-meta' ? parsed.meta : null;
  };

  if (icon === null) {
    // Nothing to clear is nothing to do. `form`/`pos` are inert without an
    // icon, but they are still the user's bytes and "remove icon" must not
    // quietly become "tidy up" — the same surgical rule setEdgeAnimate's OFF
    // path keeps when it leaves an edge id behind.
    //
    // This is why the two paths look asymmetric: with an icon present, the
    // clear DOES take an explicitly authored `form: circle` with it, while
    // with no icon it leaves the very same key alone. The asymmetry is the
    // point. `form`/`pos` describe how an icon is presented, so while there is
    // an icon they are part of the thing being removed and leaving them would
    // strand settings for a decoration that no longer exists; with no icon
    // they were never ours to touch, and this op would just be tidying up
    // after a user who did not ask. Only the setting a REMOVAL implies is
    // removed — never a neighbouring one that merely looks unused.
    if (nodeMeta(next).get(id)?.icon === undefined) return next;
    // `pos` is icon AND image presentation, and `img` wins over `icon` at
    // render (flowDb.ts:972-974), so on a node carrying both, stripping the
    // presentation keys would silently re-place the image's label. Removing
    // more than asked is exactly what the surgical rule forbids.
    const hasImage = owners.some((i) => metaAt(i)?.entries.some(([k]) => k === 'img') === true);
    const drop = hasImage ? ['icon'] : ['icon', ...ICON_PRESENTATION];
    let emptied: { at: number; indent: string } | null = null;
    // Back to front: splicing an emptied line shifts every later index. The
    // last assignment to `emptied` is therefore the LOWEST index touched, and
    // every index below it is still valid.
    for (let n = owners.length - 1; n >= 0; n -= 1) {
      const i = owners[n];
      const meta = metaAt(i);
      if (meta === null || !meta.entries.some(([k]) => drop.includes(k))) continue;
      let stripped = meta;
      for (const key of drop) stripped = withMetaEntry(stripped, key, null);
      if (stripped.entries.length === 0) {
        emptied = { at: i, indent: next.lines[i].raw.match(/^\s*/)?.[0] ?? '  ' };
        next.lines.splice(i, 1);
      } else {
        const parsed = next.lines[i].parsed;
        if (parsed.kind === 'node-meta') parsed.meta = stripped;
        next.lines[i].dirty = true;
      }
    }
    // Deleting an emptied companion line is safe for `style` and for edge
    // `animate`, whose lines never declare their subject — but a `node-meta`
    // line DOES declare a node (`nodes()` in model.ts: "a lone
    // `A@{ shape: cyl }` is a real declaration"). On mermaid's own documented
    // icon-node form — `A@{ icon: "lucide:rocket", form: rounded, pos: b }` as
    // the node's ONLY line — the splice therefore took the node with it, and
    // "Remove icon" deleted the node. Ask the model whether it survived, and
    // if not, leave the declaration behind as a bare token.
    //
    // MEASURED on the bundled 11.16.0, because the obvious alternative is a
    // trap: mermaid keeps the vertex for BOTH `A` and an empty `A@{ }` body,
    // but `parseMetaBody` refuses an empty body, so `A@{ }` goes OPAQUE here
    // and the node would vanish from `nodes()` — still drawn, no longer
    // editable. The bare token is the only form both readers agree on.
    if (emptied !== null && !nodes(next).has(id)) {
      next.lines.splice(emptied.at, 0, {
        raw: emptied.indent,
        parsed: { kind: 'node', node: { id, label: null, shape: null } },
        dirty: true,
      });
    }
    return next;
  }

  // Already showing this icon: do nothing at all, the same call setNodeShape
  // makes. Rewriting would cost an undo step for a click that moved nothing —
  // and worse here, it would ADD `form: rounded` to a node that had chosen the
  // bare `icon` shape, silently redrawing it.
  const resolved = nodeMeta(next).get(id);
  if (resolved?.icon === icon) return clone(model);

  const idx = ensureMetaLine(next, id, 'icon');
  const line = next.lines[idx];
  if (line.parsed.kind !== 'node-meta') return next; // unreachable; narrows the type
  let meta = withMetaEntry(line.parsed.meta, 'icon', icon);
  // Asked of the FOLDED view, not this line: a `form:` sitting on a sibling
  // meta line is just as much the user's explicit choice, and writing our
  // default onto the winning line would override it.
  if (resolved?.form === undefined) meta = withMetaEntry(meta, 'form', 'rounded');
  if (resolved?.pos === undefined) meta = withMetaEntry(meta, 'pos', 'b');
  line.parsed.meta = meta;
  line.dirty = true;
  return next;
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
          arrow: { ...DEFAULT_ARROW },
          label: null,
          id: null,
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
  let totalPairs = 0;

  line.parsed.segments.forEach((segment, segIdx) => {
    for (const f of segment.from) {
      for (const t of segment.to) {
        totalPairs += 1;
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

  // Nothing on this line matched shouldDrop: leave it completely untouched
  // rather than re-emitting it through the normalizing splice below, which
  // would flatten chains/&-groups, drop quoting, and rewrite whitespace on
  // lines the caller never asked to change.
  if (survivors.length === totalPairs) return;

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
  // A segment's id names ONE edge, so a split may only give it to one
  // survivor — duplicating `e1@` across lines would silently drop all but the
  // first upstream (`addSingleLink` refuses an id already taken,
  // flowDb.ts:315). The first survivor gets it rather than nobody: an id left
  // unwritten orphans its `e1@{ … }` companion, which then names no edge and
  // renders as a stray box (measured).
  const idUsed = new Set<number>();
  for (const pair of survivors) {
    const keepId = original[pair.seg].id !== null && !idUsed.has(pair.seg);
    idUsed.add(pair.seg);
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
            id: keepId ? original[pair.seg].id : null,
          },
        ],
      },
      dirty: true,
    });
  }

  // An id this rebuild does not re-emit leaves its `e1@{ … }` companion naming
  // no edge — and an unclaimed meta id is not inert, it DECLARES A NODE
  // (flowDb.ts:163-176 falls through to addVertex; measured: deleting the
  // animated edge of `B e1@--> C` leaves `V[A, B, e1]`, a stray box where the
  // edge used to be). This is the edge-side twin of the sweep deleteNode
  // already does for a node's own meta and style companions.
  const kept = new Set(
    replacements.flatMap((l) =>
      l.parsed.kind === 'edges'
        ? l.parsed.segments.map((sg) => sg.id).filter((x) => x !== null)
        : [],
    ),
  );
  // An id another edge line also declares stays live: mermaid gives it to the
  // first `e1@` it parses, so deleting ours just promotes that one.
  const elsewhere = new Set<string>();
  next.lines.forEach((l, i) => {
    if (i === lineIdx || l.parsed.kind !== 'edges') return;
    for (const sg of l.parsed.segments) {
      if (sg.id !== null) elsewhere.add(sg.id);
    }
  });
  const lost = new Set(
    line.parsed.segments
      .map((sg) => sg.id)
      .filter((x): x is string => x !== null && !kept.has(x) && !elsewhere.has(x)),
  );
  // Companions sit BELOW lineIdx, so drop them first (back to front) and
  // splice the edge line last, while every index still holds.
  for (const i of [...lost].flatMap((id) => edgeMetaLinesFor(next, id)).sort((a, b) => b - a)) {
    next.lines.splice(i, 1);
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
    } else if (parsed.kind === 'node-meta' && parsed.id === id) {
      // A lone `A@{ shape: cyl }` DECLARES A (M29.29), so leaving it behind
      // would leave the node rendering after a delete that claimed to remove it.
      next.lines.splice(i, 1);
    } else if (parsed.kind === 'style' && parsed.id === id) {
      // `style A …` declares A the same way (flowDb.addVertex mints a vertex
      // for an unknown styled id), so left behind it brings the just-deleted
      // node back as an unlabeled coloured box. `class A hot` and `click A …`
      // have the same shape but stay opaque, so they cannot be swept here yet;
      // `click` becomes understood in Stage F, which can extend this arm.
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
  // Unlike node labels, edge labels have no quoting escape for `|` — the
  // pipe is the delimiter mermaid uses to close the label itself, so a
  // literal one would emit `-->|a|b|` and get misread as an unlabeled arrow
  // followed by garbage. This is the last boundary before the file, so
  // substitute `|` → `/` here rather than propagate corrupt text.
  //
  // An empty label is "no label", never `-->||`: that emits a line mermaid
  // refuses outright (`arrowText` needs a token, flow.jison:501 — measured)
  // and one this module's own parser now sends opaque.
  const cleaned = label === null ? null : label.replaceAll('|', '/');
  line.parsed.segments[edge.seg].label = cleaned === '' ? null : cleaned;
  line.dirty = true;
  return next;
}

/**
 * Rewrite one segment's arrow (M29.31). Only that token changes: the rest of
 * the line re-emits from its own raws/labels, and a rewritten arrow
 * normalizes to minimum length (length is authorable in code, not here).
 * `~~~` can carry neither head nor label, so entering invisible drops the
 * label, and picking a head while invisible lands back on a normal stroke.
 */
export function setEdgeArrow(
  model: FlowchartModel,
  edge: EdgeEntry,
  patch: { stroke?: EdgeStroke; head?: EdgeHead },
): FlowchartModel {
  const next = clone(model);
  const line = next.lines[edge.line];
  if (line.parsed.kind !== 'edges') return next;
  const seg = line.parsed.segments[edge.seg];
  let stroke = patch.stroke ?? seg.arrow.stroke;
  const head = patch.head ?? seg.arrow.head;
  if (patch.head !== undefined && patch.stroke === undefined && stroke === 'invisible') {
    stroke = 'normal';
  }
  const raw = emitArrow(stroke, head, seg.arrow.raw);
  seg.arrow = { stroke, head: stroke === 'invisible' ? 'open' : head, raw };
  if (stroke === 'invisible') seg.label = null;
  line.dirty = true;
  return next;
}

/** `e1`-style id no existing node, edge, or meta id claims (case-insensitive, like newNodeId). */
export function newEdgeId(model: FlowchartModel): string {
  const used = new Set<string>();
  for (const id of nodes(model).keys()) used.add(id.toLowerCase());
  for (const entry of edges(model)) {
    if (entry.id !== null) used.add(entry.id.toLowerCase());
  }
  for (const id of nodeMeta(model).keys()) used.add(id.toLowerCase());
  let n = 1;
  while (used.has(`e${n}`)) n += 1;
  return `e${n}`;
}

/**
 * True when this expansion is the one that can carry the segment's id — and so
 * the only one `setEdgeAnimate` will act on.
 *
 * An `&` group expands to several edges but its segment can spell exactly ONE
 * id, and `addLink` hands it to the LAST start crossed with the FIRST end
 * (flowDb.ts:356-371); the same rule `edges()` uses to decide which expansion
 * gets `id`. Every other expansion has nowhere to hang a meta line.
 *
 * Exported because the UI has to ask the question BEFORE the click: the op's
 * refusal is correct but silent, and a button that swallows a press and closes
 * is indistinguishable from a broken one (M29.33 review). One predicate, so the
 * control and the op can never disagree about which edges are live.
 */
export function canAnimateEdge(model: FlowchartModel, edge: EdgeEntry): boolean {
  const line = model.lines[edge.line];
  if (line === undefined || line.parsed.kind !== 'edges') return false;
  const seg = line.parsed.segments[edge.seg];
  if (seg === undefined) return false;
  return edge.from === seg.from[seg.from.length - 1].id && edge.to === seg.to[0].id;
}

/**
 * Toggle edge animation (M29.31). ON ensures the edge has an id (minting an
 * `eN` and writing it into the edge line when needed) and an
 * `id@{ animate: true }` meta line BELOW the edge — below, because mermaid
 * resolves the id against the edges parsed so far, so the same line above the
 * edge silently becomes a node declaration instead (measured, see
 * `edgeMetaLinesFor`). OFF removes only the `animate` entry — the line too
 * when that empties it — and leaves the id in place: ids are cheap, other
 * meta keys may depend on them, and removing more than asked violates the
 * surgical rule.
 *
 * Like `setNodeStyle`, a set lands on the LAST meta line that already
 * declares `animate` and a removal strips it from EVERY one, because several
 * `id@{ … }` lines may name one edge and mermaid lets the last value for a
 * key win (`edge.animate = edgeDoc.animate` per line, flowDb.ts:167-169 —
 * measured: `animate: true` then `animate: false` renders unanimated).
 * Writing to the first would be a silent no-op.
 */
export function setEdgeAnimate(
  model: FlowchartModel,
  edge: EdgeEntry,
  on: boolean,
): FlowchartModel {
  const next = clone(model);
  const line = next.lines[edge.line];
  if (line.parsed.kind !== 'edges') return next;
  const seg = line.parsed.segments[edge.seg];
  // An & group expands to several edges but its segment can carry only ONE
  // id. For any other expansion there is no id to write and no line to hang
  // meta on, so this is a no-op rather than an edit that animates a sibling
  // edge the caller never named. (Same shape as setNodeStyle refusing an id
  // the diagram does not declare.) `canAnimateEdge` is the same question the
  // UI asks to disable the control, so the two cannot drift apart.
  if (!canAnimateEdge(next, edge)) return next;
  const declares = (i: number): boolean => {
    const parsed = next.lines[i].parsed;
    return parsed.kind === 'node-meta' && parsed.meta.entries.some(([k]) => k === 'animate');
  };

  if (!on) {
    if (seg.id === null) return next;
    const owners = edgeMetaLinesFor(next, seg.id);
    // Back to front: splicing an emptied line shifts every later index.
    for (let n = owners.length - 1; n >= 0; n -= 1) {
      const i = owners[n];
      const parsed = next.lines[i].parsed;
      if (parsed.kind !== 'node-meta' || !declares(i)) continue;
      const stripped = withMetaEntry(parsed.meta, 'animate', null);
      if (stripped.entries.length === 0) {
        next.lines.splice(i, 1);
      } else {
        parsed.meta = stripped;
        next.lines[i].dirty = true;
      }
    }
    return next;
  }

  let id = seg.id;
  if (id === null) {
    id = newEdgeId(next);
    seg.id = id;
    line.dirty = true;
  }
  const owners = edgeMetaLinesFor(next, id);
  const target = owners.filter(declares).at(-1) ?? owners.at(-1);
  if (target !== undefined) {
    const parsed = next.lines[target].parsed;
    if (parsed.kind === 'node-meta') {
      parsed.meta = withMetaEntry(parsed.meta, 'animate', 'true');
      next.lines[target].dirty = true;
      return next;
    }
  }
  const indent = line.raw.match(/^\s*/)?.[0] ?? '  ';
  const at = next.lines.indexOf(line);
  next.lines.splice(at + 1, 0, {
    raw: indent,
    parsed: { kind: 'node-meta', id, meta: { entries: [['animate', 'true']] } },
    dirty: true,
  });
  return next;
}

/**
 * Where a new companion line (style, meta) belongs: after the node's
 * definition line, else after the first line that references it, else the
 * header. Never BEFORE the node exists — a style statement ahead of its node
 * would auto-create one upstream (flowDb.ts addVertex mints the vertex and
 * only logs a warning).
 */
function anchorLineFor(model: FlowchartModel, id: string): number {
  for (let i = 0; i < model.lines.length; i += 1) {
    const parsed = model.lines[i].parsed;
    if (parsed.kind === 'node' && parsed.node.id === id) return i;
  }
  for (let i = 0; i < model.lines.length; i += 1) {
    const parsed = model.lines[i].parsed;
    if (parsed.kind === 'node-meta' && parsed.id === id) return i;
    let hit = false;
    eachRef(model.lines[i], (ref) => {
      if (ref.id === id) hit = true;
    });
    if (hit) return i;
  }
  return headerIndex(model);
}

/**
 * Patch a node's `style` declarations surgically (M29.30): change/add/remove
 * exactly the named ones, keep unknown ones in order, delete a line when it
 * empties, create one (after the node) when there is none. Unknown ids are a
 * no-op — upstream auto-creates a node for a styled undeclared id, which is
 * exactly the kind of surprise this layer exists to prevent.
 *
 * Every write lands on the declaration that ACTUALLY RENDERS, because several
 * `style` lines may name one id and mermaid lets the last value for a key win
 * (see `nodeStyle`). So a set goes to the last line already declaring the key,
 * and a removal strips the key from EVERY line — stripping one would leave an
 * earlier duplicate rendering, and writing to the first would be a silent
 * no-op. Still surgical: only lines carrying the key being changed are dirtied.
 *
 * Values are validated through `styleDecl` on the way out, so an emitted line
 * is always one this module can read back and mermaid can parse.
 */
export function setNodeStyle(
  model: FlowchartModel,
  id: string,
  patch: Record<string, string | null>,
): FlowchartModel {
  const next = clone(model);
  if (!nodes(next).has(id)) return next;

  const styleLines = (): number[] =>
    next.lines.reduce<number[]>((acc, line, i) => {
      if (line.parsed.kind === 'style' && line.parsed.id === id) acc.push(i);
      return acc;
    }, []);
  const declsAt = (i: number): [string, string][] => {
    const parsed = next.lines[i].parsed;
    return parsed.kind === 'style' ? parsed.decls : [];
  };
  const writeAt = (i: number, decls: [string, string][]): void => {
    const parsed = next.lines[i].parsed;
    if (parsed.kind !== 'style') return; // unreachable; narrows the type
    parsed.decls = decls;
    next.lines[i].dirty = true;
  };

  for (const [rawKey, rawValue] of Object.entries(patch)) {
    // One validation path for sets and removals alike, so the key we look up
    // is always the key we would have written.
    const decl = styleDecl(rawKey, rawValue);
    if (decl === null) continue;
    const [key, value] = decl;
    const lines = styleLines();

    if (value === null) {
      // Back to front: splicing an emptied line shifts every later index.
      for (let n = lines.length - 1; n >= 0; n -= 1) {
        const i = lines[n];
        if (!declsAt(i).some(([k]) => k === key)) continue;
        const decls = withEntry(declsAt(i), key, null);
        if (decls.length === 0) next.lines.splice(i, 1);
        else writeAt(i, decls);
      }
      continue;
    }

    const owner = [...lines].reverse().find((i) => declsAt(i).some(([k]) => k === key));
    const target = owner ?? lines.at(-1);
    if (target !== undefined) {
      writeAt(target, withEntry(declsAt(target), key, value));
      continue;
    }
    const at = anchorLineFor(next, id);
    const indent = next.lines[at]?.raw.match(/^\s*/)?.[0] ?? '  ';
    next.lines.splice(at + 1, 0, {
      raw: indent,
      parsed: { kind: 'style', id, decls: [[key, value]] },
      dirty: true,
    });
  }
  return next;
}

/** Exactly the ids `CLICK_LINE` can read back — see the refusal below. */
const OWNED_CLICK_ID = /^[A-Za-z0-9_.-]+$/;

/**
 * The last line — OWNED OR OPAQUE — whose `click` statement names `id`, or -1.
 *
 * Peeking at an opaque line's raw text without owning it is the same move
 * `hasOpaqueMetaBlock` makes, and for the same reason: mermaid resolves the
 * LAST `setLink` for an id, and the variants we leave opaque (`href`, and a
 * comma id-list that happens to include `id`) write the very same slot —
 * measured. A new click line dropped ABOVE one of them would be a silent
 * no-op in the picture, which is the defect M29.30/.32/.33 each closed
 * somewhere else.
 *
 * `\b` is NOT the right terminator here — `.` and `-` are id characters, so it
 * would read `click A.x "y"` as naming `A`. The lookahead is the id charset
 * itself, which still lets a comma id-list (`click A,B "…"`) match, as it must.
 * Those same two characters are the only regex-special ones in the charset.
 */
function lastClickLineFor(model: FlowchartModel, id: string): number {
  const named = new RegExp(`^click\\s+${id.replace(/[.-]/g, '\\$&')}(?![A-Za-z0-9_.-])`);
  let out = -1;
  model.lines.forEach((line, i) => {
    if (named.test(line.raw.trim())) out = i;
  });
  return out;
}

/**
 * Bind a node to a URL or vault-relative record path via an owned click line
 * (M29.36). One target per node: the last owned line MERMAID WOULD APPLY is
 * patched, every other owned one is dropped, and `null` clears them all.
 * Opaque click VARIANTS (`href`/`call`/tooltip/comma-list forms) are never
 * touched — if the user hand-wrote one it survives byte-for-byte and simply is
 * not what the editor reads (`nodeLinks` documents the divergence that
 * follows).
 *
 * Why the LAST and not the first: mermaid resolves the last `setLink` for an
 * id (measured, `links.mermaid.test.ts`), so writing to the first would be the
 * silent no-op M29.30/.32/.33 each had to close in a different control. The
 * same fact places a NEW line below anything already claiming the id, and
 * disqualifies an owned line sitting above the node's first declaration, where
 * `setLink` finds no vertex at all.
 *
 * Two refusals:
 *
 * - a blank target is not a link — `clickTarget` refuses it and the op clears
 *   instead, because `click A ""` is a parse error that kills the diagram;
 * - an id outside the owned charset is refused, because `click A B "x"` is a
 *   CALLBACK statement upstream and opaque to us: emitting one would be this
 *   layer writing a line it immediately disowns.
 *
 * And one refusal deliberately NOT carried:
 *
 * - an UNDECLARED id is allowed, unlike `setNodeShape`/`setNodeIcon`. Those
 *   refuse because an `id@{ … }` line for an unknown id CREATES a node; a
 *   click line provably does not (measured: `setLink` and `setClass` both skip
 *   an id with no vertex), so there is no phantom to prevent — and refusing
 *   would make "create a node, then link it" a silent no-op.
 */
export function setNodeLink(
  model: FlowchartModel,
  id: string,
  target: string | null,
): FlowchartModel {
  const next = clone(model);
  if (!OWNED_CLICK_ID.test(id)) return next;

  const owned: number[] = [];
  next.lines.forEach((l, i) => {
    if (l.parsed.kind === 'click' && l.parsed.id === id) owned.push(i);
  });
  const safe = target === null ? null : clickTarget(target);

  if (safe === null) {
    // Back to front: splicing shifts every later index.
    for (let n = owned.length - 1; n >= 0; n -= 1) next.lines.splice(owned[n], 1);
    return next;
  }

  // The survivor must be the line mermaid actually APPLIES — two conditions,
  // both measured:
  //
  // - below the node's first declaration, because `setLink` only assigns to a
  //   vertex that already exists and a click line above it is simply dead;
  // - the LAST click statement claiming the id, owned or not, because the
  //   `href`, tooltip and comma-list variants write the very same slot and the
  //   last one wins.
  //
  // Fail either and patching in place would leave the picture pointing
  // somewhere else — the silent no-op three controls in this wave already
  // shipped. So every owned line is dropped and a fresh one written where it
  // resolves: the one case this op relocates a line rather than patching it.
  const declared = nodes(next).has(id);
  const anchor = declared ? anchorLineFor(next, id) : -1;
  const settled = lastClickLineFor(next, id);
  const keep = owned.find((i) => i > anchor && i === settled);
  if (keep !== undefined) {
    const parsed = next.lines[keep].parsed;
    if (parsed.kind === 'click') {
      parsed.target = safe;
      next.lines[keep].dirty = true;
    }
    for (let n = owned.length - 1; n >= 0; n -= 1) {
      if (owned[n] !== keep) next.lines.splice(owned[n], 1);
    }
    return next;
  }
  for (let n = owned.length - 1; n >= 0; n -= 1) next.lines.splice(owned[n], 1);

  // Next to the node, matching its indent — the same anchor rule `setNodeStyle`
  // uses, and for a sharper reason here: a click line ABOVE its node's first
  // declaration is DEAD upstream (measured), and `anchorLineFor` never returns
  // a position before the node exists. Below any click statement already
  // naming this id, though, since the last one is what mermaid resolves.
  if (declared) {
    const at = Math.max(anchorLineFor(next, id), lastClickLineFor(next, id));
    const indent = next.lines[at]?.raw.match(/^\s*/)?.[0] ?? '  ';
    next.lines.splice(at + 1, 0, {
      raw: indent,
      parsed: { kind: 'click', id, target: safe },
      dirty: true,
    });
    return next;
  }
  // Nothing to sit next to. `anchorLineFor` would fall back to the header and
  // borrow its (empty) indent, so an undeclared id gets the end of the
  // document instead — inert either way, but not wedged above the diagram.
  next.lines.push({ raw: '  ', parsed: { kind: 'click', id, target: safe }, dirty: true });
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
