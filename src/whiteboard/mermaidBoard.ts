import type { Entry } from '@/engine/types';
import type { ImportSketch, SketchEdge } from '@/engine/scene/importBoard';
import { normalizeColor } from '@/engine/scene/colors';
import {
  parseFlowchart,
  nodes,
  subgraphs,
  edges,
  storedPositions,
  isManualLayout,
  nodeStyle,
  nodeMeta,
  nodeLinks,
  edgeMeta,
} from '@/mermaid/flowchart/model';
import { resolveBinding } from '@/views/whiteboardBindings';

export type MermaidBoardRead =
  | { ok: true; sketch: ImportSketch }
  | { ok: false; reason: 'not-flowchart' | 'not-manual' | 'empty' };
const label = (value: string) => value.replace(/<br\s*\/?\s*>/gi, '\n');
/** Read only through the flowchart model's views; no Mermaid renderer internals. */
export function readMermaidBoard(code: string, entries: Entry[]): MermaidBoardRead {
  const model = parseFlowchart(code);
  if (!model) return { ok: false, reason: 'not-flowchart' };
  if (!isManualLayout(model)) return { ok: false, reason: 'not-manual' };
  const groups = subgraphs(model),
    groupIds = new Set(groups.map((group) => group.id));
  const found = [...nodes(model)].filter(([id]) => !groupIds.has(id));
  if (!found.length) return { ok: false, reason: 'empty' };
  const positions = storedPositions(model),
    metadata = nodeMeta(model),
    links = nodeLinks(model),
    edgeMetadata = edgeMeta(model);
  const sketch: ImportSketch = {
    nodes: [],
    groups: [],
    edges: [],
    icons: 0,
    animations: 0,
    alphaColors: 0,
    styleKeys: [],
    leftovers: [],
    settings: false,
  };
  const styleKeys = new Set<string>();
  for (const [id, node] of found) {
    const style = nodeStyle(model, id),
      meta = metadata.get(id),
      link = links.get(id);
    if (meta?.icon) sketch.icons++;
    for (const key of Object.keys(style)) if (key !== 'fill') styleKeys.add(key);
    let fill = style.fill;
    if (/^#(?:[\da-f]{4}|[\da-f]{8})$/i.test(fill ?? '')) {
      fill = fill.slice(0, fill.length === 5 ? 4 : 7);
      sketch.alphaColors++;
    }
    const color = /^#[\da-f]{3}(?:[\da-f]{3})?$/i.test(fill ?? '') ? normalizeColor(fill) : null;
    if (fill && color === null) styleKeys.add('fill (not a hex color)');
    const bound = link && !link.contested ? resolveBinding(link.target, entries) : null;
    sketch.nodes.push({
      id,
      label: label(node.label),
      shape: node.metaShape ?? node.shape,
      ...(positions.has(id) ? { position: positions.get(id)! } : {}),
      ...(color === null ? {} : { color }),
      ...(bound ? { file: bound.path } : link && !link.contested ? { target: link.target } : {}),
    });
  }
  for (const group of groups) {
    const parent = groups
      .filter(
        (candidate) => candidate.startLine < group.startLine && candidate.endLine > group.endLine,
      )
      .sort((a, b) => b.startLine - a.startLine)[0];
    sketch.groups.push({
      id: group.id,
      label: label(group.title),
      members: group.memberIds,
      ...(parent ? { parent: parent.id } : {}),
    });
  }
  for (const edge of edges(model)) {
    const raw = edge.arrow.raw;
    const fromEnd: SketchEdge['fromEnd'] = /^[<ox]/.test(raw) ? 'arrow' : 'none';
    const toEnd: SketchEdge['toEnd'] = /[>ox]$/.test(raw) ? 'arrow' : 'none';
    const meta = edge.id ? edgeMetadata.get(edge.id) : undefined;
    if (
      meta?.entries.some(
        ([key, value]) =>
          (key === 'animate' && value === 'true') ||
          (key === 'animation' && ['fast', 'slow'].includes(value)),
      )
    )
      sketch.animations++;
    sketch.edges.push({
      from: edge.from,
      to: edge.to,
      ...(edge.label === null ? {} : { label: label(edge.label) }),
      fromEnd,
      toEnd,
      invisible: edge.arrow.stroke === 'invisible',
      stroke: edge.arrow.stroke,
      specialHeads: Number(/^[ox]/.test(raw)) + Number(/[ox]$/.test(raw)),
    });
  }
  let frontmatter = false;
  for (let index = 0; index < model.lines.length; index++) {
    const line = model.lines[index],
      raw = line.raw.trim();
    if (index === 0 && raw === '---') {
      frontmatter = true;
      sketch.settings = true;
      continue;
    }
    if (frontmatter) {
      if (raw === '---') frontmatter = false;
      continue;
    }
    if (raw.startsWith('%%{')) {
      sketch.settings = true;
      continue;
    }
    if (line.parsed.kind === 'opaque' && raw && !raw.startsWith('%%')) sketch.leftovers.push(raw);
  }
  sketch.styleKeys = [...styleKeys].sort();
  return { ok: true, sketch };
}
