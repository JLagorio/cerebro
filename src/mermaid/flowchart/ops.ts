import type {
  Direction,
  EdgeEntry,
  EdgeHead,
  EdgeStroke,
  FlowchartModel,
  ModelLine,
  NodeMeta,
  NodeRef,
  PlanePoint,
  Shape,
  SubgraphEntry,
} from './model';
import {
  DEFAULT_ARROW,
  DIRECTION_SITE,
  OWNED_DIRECTION_LINE,
  bareSubgraphIdText,
  clickTarget,
  directionText,
  edgeMetaLinesFor,
  edges,
  emitArrow,
  linkWriterLines,
  nodeMeta,
  nodes,
  posToken,
  styleDecl,
  subgraphTitleText,
  subgraphs,
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

/** A line that opens or closes a subgraph block, owned or not. */
function isBlockMarker(line: ModelLine): boolean {
  return (
    line.parsed.kind === 'subgraph-start' ||
    line.parsed.kind === 'subgraph-end' ||
    (line.parsed.kind === 'opaque' && /^(subgraph|end)\b/.test(line.raw.trim()))
  );
}

/** Ids we can write back as an explicit `subgraph id[Title]` handle. */
const EXPLICIT_ID = /^[A-Za-z0-9_.-]+$/;

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
  // A stored position for an id no node claims is a loaded gun: hand that id
  // out and the new node teleports to a coordinate its author never chose.
  // `deleteNode` cannot close this one — the id was never a node — so the
  // allocator has to. EVERY pos line is read, not just the live one, because a
  // shadowed line becomes live the moment the line above it is emptied.
  for (const line of model.lines) {
    if (line.parsed.kind !== 'pos-comment') continue;
    for (const posId of line.parsed.positions.keys()) used.add(posId.toLowerCase());
  }
  let n = 1;
  while (used.has(`n${n}`)) n += 1;
  return `n${n}`;
}

/**
 * Where an appended line belongs (M29.53).
 *
 * A source that ends in a newline — every file this app writes — parses to a
 * trailing EMPTY line, because that is what splitting on '\n' produces. Pushing
 * past it inserted a blank line AND ate the terminator: MEASURED, one "Add
 * connected node" took `…C --> D[Publish]\n` to `…C --> D[Publish]\n\n
 * n1[New step]\n  A --> n1` with endsWith('\n') going true -> false, and every
 * later edit inherited the missing newline. In a files-first app with git in
 * the status bar that is a "\ No newline at end of file" on every diagram the
 * user touches.
 */
function appendAt(model: FlowchartModel): number {
  const last = model.lines[model.lines.length - 1];
  // `!dirty` matters: a line THIS session appended carries a stub raw of two
  // spaces and emits its real text later, so a raw-only test reads the node we
  // just added as the file's terminator and inserts the next one above it.
  const terminator = last !== undefined && !last.dirty && last.raw.trim() === '';
  return terminator ? model.lines.length - 1 : model.lines.length;
}

export function addNode(
  model: FlowchartModel,
  label: string,
): { model: FlowchartModel; id: string } {
  const next = clone(model);
  const id = newNodeId(next);
  next.lines.splice(appendAt(next), 0, {
    raw: '  ',
    parsed: { kind: 'node', node: { id, label, shape: 'rect' } },
    dirty: true,
  });
  return { model: next, id };
}

export function addEdge(model: FlowchartModel, from: string, to: string): FlowchartModel {
  const next = clone(model);
  next.lines.splice(appendAt(next), 0, {
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
      // node back as an unlabeled coloured box.
      next.lines.splice(i, 1);
    } else if (parsed.kind === 'click' && parsed.id === id) {
      // The arm the comment here used to promise Stage F would add (M29.36).
      // An orphan click line does NOT resurrect the node — measured, `setLink`
      // mints no vertex for an unknown id — so this is not the `style`
      // resurrection bug. The damage is quieter: the deleted node's target
      // stays in the user's file, `nodeLinks` keeps reporting a link for a
      // node that is gone, and `newNodeId` hands the very same id to the next
      // node created, which then inherits the link.
      //
      // `class A hot` and the opaque click VARIANTS still stay: we do not
      // rewrite lines we do not understand, at a delete no less than anywhere.
      next.lines.splice(i, 1);
    } else if (parsed.kind === 'pos-comment' && parsed.positions.has(id)) {
      // Node ids are REUSABLE — `newNodeId` hands out the lowest free one — so
      // a leftover `B 10,10` would silently teleport whatever node next takes
      // the id `B`. Positions are one more trace to sweep, alongside the meta,
      // style and click companions above. EVERY pos line is swept, not just
      // the one `storedPositions` reads: a coordinate hiding on a second line
      // becomes live the moment the first one is emptied.
      //
      // The splice condition is "nothing EMITTABLE survives", not "the map is
      // empty", and the difference is a real bug rather than tidiness. A line
      // is only ever handed to `emitLine` once it is DIRTY, so the emitter's
      // `nothing to say → keep the raw bytes` fallback can only ever fire on a
      // line an op just mutated — and here that fallback would hand back the
      // PRE-DELETE bytes and resurrect the coordinate we came to remove.
      // MEASURED: deleting B from `%% cerebro:pos A 99999…999,0 B 3,4` left
      // both entries in the file, because the sole survivor (A) is
      // unemittable. `[].every()` is true, so this subsumes the empty case.
      parsed.positions.delete(id);
      if ([...parsed.positions].every(([k, pt]) => posToken(k, pt) === null)) {
        next.lines.splice(i, 1);
      } else {
        next.lines[i].dirty = true;
      }
    } else if (parsed.kind === 'edges') {
      rebuildEdgeLines(next, i, (f, t) => f.id === id || t.id === id, id);
    }
  }
  return next;
}

/**
 * Stores a node's position (M29.41): absolute plane coordinates of the node
 * CENTRE — see `PlanePoint`. One `%% cerebro:pos` line holds every position; it
 * is patched in place (the FIRST one, which is the line `storedPositions`
 * reads) or created right after the header — after the layout-mode marker when
 * that sits on the header, so the cerebro block stays contiguous and the diff
 * stays one line.
 *
 * A position `posToken` could not read back is REFUSED outright rather than
 * written: the positions line is shared, and one unreadable token would cost
 * every other node on it its coordinates. The refusal is silent because the
 * only caller is a drag whose id came out of this very model — an id or a
 * coordinate that fails here is a bug upstream, not a user mistake to report.
 */
export function setNodePosition(
  model: FlowchartModel,
  id: string,
  pos: PlanePoint,
): FlowchartModel {
  const next = clone(model);
  if (posToken(id, pos) === null) return next;
  const rounded = { x: Math.round(pos.x), y: Math.round(pos.y) };
  for (const line of next.lines) {
    if (line.parsed.kind === 'pos-comment') {
      line.parsed.positions.set(id, rounded);
      line.dirty = true;
      return next;
    }
  }
  let at = headerIndex(next) + 1;
  if (next.lines[at]?.parsed.kind === 'layout-mode') at += 1;
  next.lines.splice(at, 0, {
    raw: `  ${lineEnding(next)}`,
    parsed: { kind: 'pos-comment', positions: new Map([[id, rounded]]) },
    dirty: true,
  });
  return next;
}

/** Removes every stored position — every pos line, not just the live one. */
export function clearPositions(model: FlowchartModel): FlowchartModel {
  const next = clone(model);
  for (let i = next.lines.length - 1; i >= 0; i -= 1) {
    if (next.lines[i].parsed.kind === 'pos-comment') next.lines.splice(i, 1);
  }
  return next;
}

/**
 * Toggles the manual-layout marker. OFF removes only the marker — stored
 * positions are deliberately RETAINED so toggling back on restores the hand
 * layout (spec D7). Idempotent both ways.
 */
export function setManualLayout(model: FlowchartModel, on: boolean): FlowchartModel {
  const next = clone(model);
  if (on) {
    if (next.lines.some((l) => l.parsed.kind === 'layout-mode')) return next;
    next.lines.splice(headerIndex(next) + 1, 0, {
      raw: `  ${lineEnding(next)}`,
      parsed: { kind: 'layout-mode', manual: true },
      dirty: true,
    });
    return next;
  }
  for (let i = next.lines.length - 1; i >= 0; i -= 1) {
    if (next.lines[i].parsed.kind === 'layout-mode') next.lines.splice(i, 1);
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
 * The last line — OWNED OR OPAQUE — writing `id`'s link slot, or -1. Mermaid
 * resolves the LAST `setLink`, so a line dropped above one of these would be
 * the silent no-op M29.30/.32/.33 each closed somewhere else. `model.ts` owns
 * the definition of "writes this slot" so this and `nodeLinks` cannot drift.
 */
function lastLinkLineFor(model: FlowchartModel, id: string): number {
  return linkWriterLines(model, id).at(-1) ?? -1;
}

/**
 * Bind a node to a URL or vault-relative record path via an owned click line
 * (M29.36). One target per node: the last owned line MERMAID WOULD APPLY is
 * patched, every other owned one is dropped.
 *
 * **`target` clears when it is `null` OR blank** — an empty or whitespace-only
 * string is not a link, so it removes rather than writes (see the refusals
 * below). The signature reads as though only `null` clears; it does not.
 *
 * Opaque click VARIANTS are never touched — if the user hand-wrote one it
 * survives byte-for-byte. Where it also writes this link slot (`href`, or a
 * comma id-list naming this id — `call`/callback forms do not), the two
 * directions differ and the asymmetry is deliberate:
 *
 * - a SET wins, because it relocates BELOW the variant and mermaid resolves
 *   the last writer;
 * - a CLEAR cannot. It removes our lines and stops, so the picture stays
 *   linked while the editor reports nothing. Not a bug to fix here — rewriting
 *   a line we do not understand is the one thing this layer must never do —
 *   but `nodeLinks(...).contested` announces it so a UI can.
 *
 * Why the LAST and not the first: mermaid resolves the last `setLink` for an
 * id (measured, `links.mermaid.test.ts`), so writing to the first would be the
 * silent no-op M29.30/.32/.33 each had to close in a different control. The
 * same fact places a NEW line below anything already writing the slot, and
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
  // - the LAST click statement WRITING THE LINK SLOT, owned or not, because
  //   the `href`, tooltip and comma-list variants write the very same slot and
  //   the last one wins. `linkWriterLines` draws that line: a `call` or
  //   callback statement names the id but writes a handler, not a link, so it
  //   is not a rival and nothing relocates around it.
  //
  // Fail either and patching in place would leave the picture pointing
  // somewhere else — the silent no-op three controls in this wave already
  // shipped. So every owned line is dropped and a fresh one written where it
  // resolves: the one case this op relocates a line rather than patching it.
  const declared = nodes(next).has(id);
  const anchor = declared ? anchorLineFor(next, id) : -1;
  const settled = lastLinkLineFor(next, id);
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
  // a position before the node exists. Below any statement already WRITING the
  // slot, though, since the last of those is what mermaid resolves.
  if (declared) {
    const at = Math.max(anchorLineFor(next, id), lastLinkLineFor(next, id));
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
      // …and the mapping it emptied, and the fences that then wrap nothing
      // (M29.53). Leaving `---\nconfig:\n---` behind was the surgical reading
      // of "remove the override", but a key with nothing under it is not a
      // line the user wrote either — it is debris from ours, and the honest
      // surgical result of removing the only child of a mapping is that the
      // mapping goes too.
      const closeNow = next.lines.findIndex((l, i) => i > 0 && l.raw.trim() === '---');
      const configIdx = next.lines.findIndex(
        (l, i) => i > 0 && i < closeNow && l.raw.match(/^\s*config:\s*$/) !== null,
      );
      const childless =
        configIdx !== -1 &&
        next.lines
          .slice(configIdx + 1, closeNow)
          .every((l) => l.raw.trim() === '' || l.raw.match(/^\s*\S/) === null);
      if (childless) next.lines.splice(configIdx, closeNow - configIdx);
      // An empty frontmatter block is two fences around nothing.
      const reclose = next.lines.findIndex((l, i) => i > 0 && l.raw.trim() === '---');
      if (reclose === 1) next.lines.splice(0, 2);
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

/**
 * Why a subgraph op declined. `canCreateSubgraph` and friends answer this
 * BEFORE the op runs, so a surface can disable a control and say why instead
 * of firing an op that silently returns the model unchanged — the dead-button
 * defect class this wave has already closed three times. Following
 * `canAnimateEdge`, the ops themselves still return a bare model: this is a
 * question you ask, not a result type every call site has to unwrap.
 */
export type SubgraphRefusal =
  | 'empty-selection'
  | 'unknown-node'
  | 'blank-title'
  | 'unbalanced-document'
  | 'already-grouped'
  | 'line-inside-subgraph'
  | 'no-such-block'
  | 'unpinnable-id'
  | 'foreign-direction-would-leak';

/**
 * What each refusal MEANS, in one sentence a canvas control can hand to a
 * user (M29.38). It lives beside the union rather than in the component that
 * shows it because a `Record<SubgraphRefusal, string>` is exhaustive-checked:
 * a tenth refusal cannot be added without deciding what it says, which is the
 * whole point of typing them in the first place. No JSX, no styling — the
 * surfaces own how it is shown, only the wording is settled here.
 */
export const SUBGRAPH_REFUSAL_TEXT: Record<SubgraphRefusal, string> = {
  'empty-selection': 'Select at least one node to group.',
  'unknown-node': 'One of the selected nodes is no longer in the diagram.',
  'blank-title': 'A subgraph needs a title — mermaid cannot draw a blank one.',
  'unbalanced-document':
    'The subgraph markers in this diagram do not pair up, so nothing here can be regrouped safely.',
  'already-grouped':
    'A selected node already belongs to another subgraph, and mermaid cannot put it in two.',
  'line-inside-subgraph':
    'A line this group would move lives inside another subgraph — move it out first.',
  'no-such-block': 'That subgraph is no longer in the diagram.',
  'unpinnable-id':
    'This title would change the block’s id, and the id cannot be written out explicitly — every style, class and link naming it would break.',
  'foreign-direction-would-leak':
    'A direction line in here is not ours to delete, and ungrouping would leave it re-directing the subgraph outside.',
};

/** The document's line ending, read off the lines themselves. */
function lineEnding(model: FlowchartModel): string {
  return model.lines.some((l) => l.raw.endsWith('\r')) ? '\r' : '';
}

/**
 * The body lines at a block's OWN depth — nested blocks skipped whole, the
 * two markers excluded. Every subgraph op needs it, and deriving it once here
 * is what keeps `dissolveSubgraph` from deleting a nested block's direction.
 */
function ownDepthLines(model: FlowchartModel, entry: SubgraphEntry): number[] {
  const nested = subgraphs(model).filter(
    (s) => s.startLine > entry.startLine && s.endLine < entry.endLine,
  );
  const out: number[] = [];
  for (let i = entry.startLine + 1; i < entry.endLine; i += 1) {
    if (!nested.some((s) => i >= s.startLine && i <= s.endLine)) out.push(i);
  }
  return out;
}

/**
 * Freeze a generated `subGraph<k>` id into the explicit form, so an edit that
 * shifts CLOSE-ORDER ordinals elsewhere in the document cannot re-key it.
 *
 * MEASURED both ways on 11.16.0, and both are silent: grouping nodes that sit
 * ABOVE a `subgraph Two Words` block moves that untouched block from
 * `subGraph0` to `subGraph1`, and dissolving a block that closes BEFORE it
 * moves it the other way. Any hand-written `style subGraph0 …` / `class
 * subGraph0 …` line then binds to the wrong block or to nothing, and M29.38's
 * cluster binding is an exact id match.
 *
 * Pinning touches a line the user did not name, which is the cost. It is the
 * lesser evil: a re-key is invisible in the diff and a pin is not, and it is
 * the same move `renameSubgraph` already makes to protect the same handle.
 * Measured safe — a pinned `subgraph subGraph0[Two Words]` keeps its id AND
 * still consumes its ordinal, so no later generated id collides with it.
 */
function pinGeneratedIds(
  next: FlowchartModel,
  closesAfter: (entry: SubgraphEntry) => boolean,
): void {
  for (const entry of subgraphs(next)) {
    if (entry.explicitId || !closesAfter(entry)) continue;
    const line = next.lines[entry.startLine];
    if (line.parsed.kind !== 'subgraph-start' || line.parsed.id !== null) continue;
    // Only GENERATED ids move with the ordinals: a whitespace-free bare title
    // is its own id and is unaffected by anything happening elsewhere.
    if (!/\s/.test(bareSubgraphIdText(line.raw) ?? '')) continue;
    if (!EXPLICIT_ID.test(entry.id)) continue; // unreachable: `subGraph<k>` always matches
    line.parsed.id = entry.id;
    line.dirty = true;
  }
}

/** Sanitize a title into an id, unique among node ids and subgraph ids. */
function subgraphIdFromTitle(model: FlowchartModel, title: string): string {
  // `sg` catches a title that sanitizes away entirely — `!!!`, an emoji, CJK —
  // because an empty id would emit `subgraph [Title]`, which does not parse.
  const base =
    title
      .trim()
      .replace(/\s+/g, '_')
      .replace(/[^A-Za-z0-9_-]/g, '') || 'sg';
  const taken = new Set([...nodes(model).keys()].map((k) => k.toLowerCase()));
  for (const s of subgraphs(model)) taken.add(s.id.toLowerCase());
  if (!taken.has(base.toLowerCase())) return base;
  let n = 2;
  while (taken.has(`${base}_${n}`.toLowerCase())) n += 1;
  return `${base}_${n}`;
}

/** The lines `createSubgraph` may relocate into the new block. */
function movableLines(model: FlowchartModel, ids: Set<string>): number[] {
  const out: number[] = [];
  model.lines.forEach((line, i) => {
    const p = line.parsed;
    const owned =
      (p.kind === 'node' && ids.has(p.node.id)) ||
      (p.kind === 'node-meta' && ids.has(p.id)) ||
      (p.kind === 'edges' &&
        p.segments.every((seg) => [...seg.from, ...seg.to].every((r) => ids.has(r.id))));
    if (owned) out.push(i);
  });
  return out;
}

/**
 * Why `createSubgraph` would decline, or null when it would act. Every branch
 * is a thing mermaid cannot express rather than a thing we chose not to do.
 */
export function canCreateSubgraph(
  model: FlowchartModel,
  nodeIds: string[],
  title: string,
): SubgraphRefusal | null {
  const ids = new Set(nodeIds);
  if (ids.size === 0) return 'empty-selection';
  if (subgraphTitleText(title) === null) return 'blank-title';
  const known = nodes(model);
  for (const id of ids) if (!known.has(id)) return 'unknown-node';
  const subs = subgraphs(model);
  // Zero blocks in a document that plainly has markers means `subgraphs()`
  // refused to read it: mermaid refuses it too, and we cannot tell what is
  // inside what.
  if (subs.length === 0 && model.lines.some(isBlockMarker)) return 'unbalanced-document';
  const spokenFor = new Set(subs.flatMap((s) => s.memberIds));
  for (const id of ids) if (spokenFor.has(id)) return 'already-grouped';
  const inside = (i: number): boolean => subs.some((s) => i > s.startLine && i < s.endLine);
  if (movableLines(model, ids).some(inside)) return 'line-inside-subgraph';
  return null;
}

/**
 * Group nodes into a new subgraph (M29.37). Minimal surgery, in order of
 * preference: wrap in place when the owned lines are contiguous; otherwise
 * RELOCATE them (raw bytes intact — moved lines stay non-dirty, so serialize
 * re-emits them verbatim) to the first owned line's position and wrap there.
 * A selected id no movable line claims gets a minted bare reference — a bare
 * `id` inside the body is exactly how mermaid claims membership.
 *
 * `click` lines are deliberately NOT movable. MEASURED on 11.16.0: a click
 * statement inside a block claims no membership at all (the block's node list
 * stays empty), so moving one buys nothing — while a relocated click can land
 * above its node's first declaration, where `setLink` never runs and the link
 * silently dies. `style` lines are out for the first half of the same reason.
 *
 * Refusals are `canCreateSubgraph`'s list; here they all mean `id: null` and
 * a model returned untouched.
 */
export function createSubgraph(
  model: FlowchartModel,
  nodeIds: string[],
  title: string,
): { model: FlowchartModel; id: string | null } {
  const next = clone(model);
  if (canCreateSubgraph(next, nodeIds, title) !== null) return { model: next, id: null };
  const ids = new Set(nodeIds);
  const movable = movableLines(next, ids);

  // Which ids do the movable lines already claim? The rest need minting —
  // and "claim" here means what MERMAID counts as membership, which is why a
  // click line's subject is not in this set even when its line moves.
  const claimedByMove = new Set<string>();
  for (const i of movable) {
    eachRef(next.lines[i], (ref) => claimedByMove.add(ref.id));
    const p = next.lines[i].parsed;
    if (p.kind === 'node-meta') claimedByMove.add(p.id);
  }
  const minted = [...ids].filter((id) => !claimedByMove.has(id));

  const id = subgraphIdFromTitle(next, title);
  const anchor = movable.length > 0 ? movable[0] : next.lines.length;
  // The new block's `end` lands at the anchor, so every block that closes
  // after it gains an ordinal. Freeze the generated ones first — while the
  // line indices still mean what `subgraphs()` said they meant.
  pinGeneratedIds(next, (s) => s.endLine >= anchor);

  // Pull the movable lines out (reverse order keeps indices valid), then
  // reinsert the whole block at the anchor.
  const moved: ModelLine[] = [];
  for (let k = movable.length - 1; k >= 0; k -= 1) {
    moved.unshift(next.lines.splice(movable[k], 1)[0]);
  }
  const eol = lineEnding(next);
  const block: ModelLine[] = [
    {
      raw: `  ${eol}`,
      // The DISPLAY title, as `types.ts` declares it: trimmed and defused, so
      // a caller reading `parsed.title` back before the round-trip sees what
      // it will see after one.
      parsed: { kind: 'subgraph-start', id, title: subgraphTitleText(title) ?? title },
      dirty: true,
    },
    ...minted.map((nid): ModelLine => ({
      raw: `  ${eol}`,
      parsed: { kind: 'node', node: { id: nid, label: null, shape: null } },
      dirty: true,
    })),
    ...moved,
    { raw: `  ${eol}`, parsed: { kind: 'subgraph-end' }, dirty: true },
  ];
  next.lines.splice(anchor, 0, ...block);
  return { model: next, id };
}

/** Why `renameSubgraph` would decline, or null when it would act. */
export function canRenameSubgraph(
  model: FlowchartModel,
  index: number,
  title: string,
): SubgraphRefusal | null {
  const entry = subgraphs(model)[index];
  if (entry === undefined) return 'no-such-block';
  const text = subgraphTitleText(title);
  if (text === null) return 'blank-title';
  const line = model.lines[entry.startLine];
  if (line.parsed.kind !== 'subgraph-start') return 'no-such-block';
  if (line.parsed.id !== null) return null;
  const generated = /\s/.test(bareSubgraphIdText(line.raw) ?? '');
  const keepsId = /\s/.test(text) ? generated : text === entry.id;
  return keepsId || EXPLICIT_ID.test(entry.id) ? null : 'unpinnable-id';
}

/**
 * Retitle a subgraph WITHOUT changing its effective id (M29.37). Both bare
 * forms make the id depend on the title, so a free-hand retitle re-keys the
 * block — and the id is what the cluster's DOM carries, what `class`/`style`
 * lines name, and what every control in the canvas resolves against:
 *
 * - a whitespace-free title IS the id, so `Alpha` → `Alpha Team` would turn
 *   `Alpha` into a generated `subGraph<k>`;
 * - a generated id only survives while the title still HAS whitespace, so
 *   `Two Words` → `Solo` would turn `subGraph0` into `Solo`. The plan's
 *   "a generated id never depended on the title" is half true: the ordinal
 *   does not, the fallback does.
 *
 * So the bare form is kept only when it re-derives the SAME id; otherwise the
 * explicit `id[Title]` form pins it. An id we cannot spell as an explicit one
 * (`subgraph a/b` — MEASURED, that really is the id `a/b`) cannot be pinned,
 * and a blank title cannot be emitted at all (`subgraph x[]` is a parse
 * error), so both refuse rather than corrupt.
 *
 * The kept bare form is emitted QUOTED by `bareSubgraphTitle`, which is what
 * makes keeping it safe at all — see that function for the eight titles that
 * killed the diagram and the three that silently changed it.
 */
export function renameSubgraph(
  model: FlowchartModel,
  index: number,
  title: string,
): FlowchartModel {
  const next = clone(model);
  if (canRenameSubgraph(next, index, title) !== null) return next;
  const entry = subgraphs(next)[index];
  const line = next.lines[entry.startLine];
  if (line.parsed.kind !== 'subgraph-start') return next; // unreachable; narrows the type
  const text = subgraphTitleText(title) ?? '';

  if (line.parsed.id === null) {
    // Asked of the id TEXT, not the display title: `subgraph Alpha ` reads as
    // `Alpha` but its one trailing space already generated the id, and a
    // block that is generated stays generated under any whitespaced title.
    const generated = /\s/.test(bareSubgraphIdText(line.raw) ?? '');
    const keepsId = /\s/.test(text) ? generated : text === entry.id;
    if (!keepsId) line.parsed.id = entry.id;
  }
  line.parsed.title = text;
  line.dirty = true;
  return next;
}

/** Why `dissolveSubgraph` would decline, or null when it would act. */
export function canDissolveSubgraph(model: FlowchartModel, index: number): SubgraphRefusal | null {
  const entry = subgraphs(model)[index];
  if (entry === undefined) return 'no-such-block';
  // A direction site we cannot rewrite (`direction LR %% note`, or a node
  // label carrying the phrase) survives the dissolve. At TOP level that is
  // harmless — measured, an orphaned direction statement is inert. One level
  // down it is not: the line lands at the PARENT's own depth and re-directs a
  // block this op was never asked to touch. Deleting it would destroy a
  // comment the user wrote, so the op declines instead.
  const nested = subgraphs(model).some(
    (s) => s.startLine < entry.startLine && s.endLine > entry.endLine,
  );
  if (!nested) return null;
  const leaks = ownDepthLines(model, entry).some(
    (i) =>
      DIRECTION_SITE.test(directionText(model.lines[i])) &&
      !OWNED_DIRECTION_LINE.test(model.lines[i].raw),
  );
  return leaks ? 'foreign-direction-would-leak' : null;
}

/**
 * Remove a subgraph's markers, keeping its body byte-identical — indentation
 * included, since mermaid never cared about it and cosmetic re-indentation
 * would violate the surgical rule. The block's own `direction` lines go with
 * the markers: they are subgraph metadata, and MEASURED on 11.16.0 a
 * top-level `direction` is inert — the header's own reduction runs last and
 * wins — so an orphan would be dead text that springs back to life the moment
 * those lines are wrapped in a new block. (The plan claimed the orphan would
 * override the header immediately; that is not true of the bundled build.)
 * Nested blocks' direction lines are theirs and are untouched.
 */
export function dissolveSubgraph(model: FlowchartModel, index: number): FlowchartModel {
  const next = clone(model);
  if (canDissolveSubgraph(next, index) !== null) return next;
  const entry = subgraphs(next)[index];
  // This block's `end` disappears, so every block that closed after it loses
  // an ordinal. Freeze the generated ones before the lines move.
  pinGeneratedIds(next, (s) => s.endLine > entry.endLine);

  const doomed = [entry.startLine, entry.endLine];
  for (const i of ownDepthLines(next, entry)) {
    if (OWNED_DIRECTION_LINE.test(next.lines[i].raw)) doomed.push(i);
  }
  doomed.sort((a, b) => b - a);
  for (const i of doomed) next.lines.splice(i, 1);
  return next;
}

/** Why `setSubgraphDirection` would decline, or null when it would act. */
export function canSetSubgraphDirection(
  model: FlowchartModel,
  index: number,
): SubgraphRefusal | null {
  return subgraphs(model)[index] === undefined ? 'no-such-block' : null;
}

/**
 * Set or clear a subgraph's own `direction` (M29.37). Direction lines are
 * opaque (spec D3 adds no kind for them), so this edits raws in place — the
 * second sanctioned raws-exception after setLayoutEngine, for the same
 * reason: real structure the parser refuses to own.
 *
 * The LAST own-depth direction site is the one that renders (MEASURED:
 * `direction LR` above `direction BT` renders BT), so a set leaves exactly
 * one line behind and puts it below every site — including sites we do not
 * own, such as `direction LR %% note`, which mermaid's
 * `.*direction\s+<DIR>[^\n]*` rule swallows whole. Only lines that are
 * NOTHING but the statement are rewritten or removed; a clear that leaves a
 * foreign site behind has not fully cleared, the same shape of honest
 * half-measure `nodeLinks.contested` reports — deleting a line the user wrote
 * for another reason is the worse trade.
 */
export function setSubgraphDirection(
  model: FlowchartModel,
  index: number,
  dir: Direction | null,
): FlowchartModel {
  const next = clone(model);
  if (canSetSubgraphDirection(next, index) !== null) return next;
  const entry = subgraphs(next)[index];
  const body = ownDepthLines(next, entry);
  const ours = body.filter((i) => OWNED_DIRECTION_LINE.test(next.lines[i].raw));
  const every = body.filter((i) => DIRECTION_SITE.test(directionText(next.lines[i])));
  const last = every.length > 0 ? every[every.length - 1] : -1;

  if (dir === null) {
    for (const i of [...ours].reverse()) next.lines.splice(i, 1);
    return next;
  }
  if (last !== -1 && ours.includes(last)) {
    const indent = next.lines[last].raw.match(/^\s*/)?.[0] ?? '    ';
    next.lines[last].raw = `${indent}direction ${dir}${lineEnding(next)}`;
    for (const i of [...ours].reverse()) if (i !== last) next.lines.splice(i, 1);
    return next;
  }
  // Nothing of ours wins the slot: drop our sites and write a fresh line
  // below the last foreign one (or right under the opener when there is none).
  const anchor = last !== -1 ? last : entry.startLine;
  const doomed = new Set(ours);
  const kept: ModelLine[] = [];
  let at = -1;
  next.lines.forEach((line, i) => {
    if (doomed.has(i)) return;
    kept.push(line);
    if (i === anchor) at = kept.length;
  });
  const indent = next.lines[entry.startLine].raw.match(/^\s*/)?.[0] ?? '  ';
  kept.splice(at, 0, {
    raw: `${indent}  direction ${dir}${lineEnding(next)}`,
    parsed: { kind: 'opaque' },
    dirty: false,
  });
  next.lines = kept;
  return next;
}
