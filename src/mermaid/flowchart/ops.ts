import type { EdgeEntry, FlowchartModel, ModelLine, NodeRef, Shape } from './model';
import { nodes, withMetaEntry } from './model';

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
    } else if (parsed.kind === 'node-meta' && parsed.id === id) {
      // A lone `A@{ shape: cyl }` DECLARES A (M29.29), so leaving it behind
      // would leave the node rendering after a delete that claimed to remove it.
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
  line.parsed.segments[edge.seg].label = label === null ? null : label.replaceAll('|', '/');
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
