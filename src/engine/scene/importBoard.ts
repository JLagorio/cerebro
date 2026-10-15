import { EMPTY_BOARD } from './board';
import { addCards, addEdges } from './commands';
import { facingSides } from './figure';
import type { Board, Box, CardShape, NewCard, NewEdge } from './model';

export interface SketchNode {
  id: string;
  label: string;
  shape: string;
  color?: string;
  position?: { x: number; y: number };
  file?: string;
  target?: string;
}
export interface SketchGroup {
  id: string;
  label: string;
  members: string[];
  parent?: string;
}
export interface SketchEdge {
  from: string;
  to: string;
  label?: string;
  fromEnd: 'none' | 'arrow';
  toEnd: 'none' | 'arrow';
  invisible: boolean;
  specialHeads: number;
  stroke: 'normal' | 'thick' | 'dotted' | 'invisible';
}
export interface ImportSketch {
  nodes: SketchNode[];
  groups: SketchGroup[];
  edges: SketchEdge[];
  icons: number;
  animations: number;
  alphaColors: number;
  styleKeys: string[];
  leftovers: string[];
  settings: boolean;
}
export interface ImportReport {
  nodes: number;
  links: number;
  groups: number;
  pageCards: number;
  defaultSizes: number;
  unpositioned: number;
  plainShapes: Record<string, number>;
  extraShapes: Record<string, number>;
  specialHeads: number;
  invisible: number;
  missingEndpoints: number;
  emptyGroups: number;
  thick: number;
  dotted: number;
  icons: number;
  animations: number;
  alphaColors: number;
  styleKeys: string[];
  leftovers: string[];
  settings: boolean;
}
export const SHAPE_TO_SCENE: Readonly<Record<string, CardShape>> = {
  rect: 'rectangle',
  rectangle: 'rectangle',
  rounded: 'rectangle',
  stadium: 'rectangle',
  subroutine: 'rectangle',
  circle: 'ellipse',
  ellipse: 'ellipse',
  diamond: 'diamond',
};
const count = (n: number, noun: string, plural = `${noun}s`) => `${n} ${n === 1 ? noun : plural}`;
function unique(base: string, used: Set<string>): string {
  let id = base;
  for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
  used.add(id);
  return id;
}
function around(boxes: readonly Box[]): Box {
  const x = Math.min(...boxes.map((b) => b.x)),
    y = Math.min(...boxes.map((b) => b.y));
  return {
    x: x - 24,
    y: y - 24,
    width: Math.max(...boxes.map((b) => b.x + b.width)) - x + 48,
    height: Math.max(...boxes.map((b) => b.y + b.height)) - y + 48,
  };
}
/** Same sketch and measured boxes produce the same ids, order and bytes.
 * Refused scene bounds/caps throw to the conversion dialog before any write. */
export function importBoard(
  sketch: ImportSketch,
  options: { measured?: ReadonlyMap<string, Box> | null; pageCard: Pick<Box, 'width' | 'height'> },
): { board: Board; report: ImportReport } {
  const report: ImportReport = {
    nodes: 0,
    links: 0,
    groups: 0,
    pageCards: 0,
    defaultSizes: 0,
    unpositioned: 0,
    plainShapes: Object.create(null) as Record<string, number>,
    extraShapes: Object.create(null) as Record<string, number>,
    specialHeads: 0,
    invisible: 0,
    missingEndpoints: 0,
    emptyGroups: 0,
    thick: 0,
    dotted: 0,
    icons: sketch.icons,
    animations: sketch.animations,
    alphaColors: sketch.alphaColors,
    styleKeys: sketch.styleKeys,
    leftovers: sketch.leftovers,
    settings: sketch.settings,
  };
  const cards = new Map<string, NewCard>();
  const boxes = new Map<string, Box>();
  const unplaced: SketchNode[] = [];
  const size = (node: SketchNode): Pick<Box, 'width' | 'height'> => {
    const measured = options.measured?.get(node.id);
    if (node.file) return options.pageCard;
    if (measured)
      return {
        width: Math.max(1, Math.round(measured.width)),
        height: Math.max(1, Math.round(measured.height)),
      };
    report.defaultSizes++;
    const lines = node.label.split('\n');
    return {
      width: Math.max(
        160,
        Math.min(400, Math.max(...lines.map((line) => [...line].length)) * 7 + 32),
      ),
      height: Math.max(80, Math.min(320, lines.length * 24 + 24)),
    };
  };
  const sizes = new Map(sketch.nodes.map((node) => [node.id, size(node)]));
  for (const node of sketch.nodes) {
    const measured = options.measured?.get(node.id),
      dimensions = sizes.get(node.id)!;
    // The stored centre remains authoritative when the live render is older.
    const centre =
      node.position ??
      (measured
        ? { x: measured.x + measured.width / 2, y: measured.y + measured.height / 2 }
        : null);
    if (centre)
      boxes.set(node.id, {
        x: Math.round(centre.x - dimensions.width / 2),
        y: Math.round(centre.y - dimensions.height / 2),
        ...dimensions,
      });
    else unplaced.push(node);
  }
  let rowX = 0;
  const rowY = boxes.size
    ? Math.max(...[...boxes.values()].map((box) => box.y + box.height)) + 64
    : 0;
  for (const node of unplaced) {
    const dimensions = sizes.get(node.id)!;
    boxes.set(node.id, { x: rowX, y: rowY, ...dimensions });
    rowX += dimensions.width + 32;
    report.unpositioned++;
  }
  for (const node of sketch.nodes) {
    const box = boxes.get(node.id)!,
      color = node.color === undefined ? {} : { color: node.color };
    if (node.file) {
      cards.set(node.id, { type: 'file', file: node.file, ...box, ...color });
      report.pageCards++;
    } else {
      const supported = Object.hasOwn(SHAPE_TO_SCENE, node.shape);
      const shape = supported ? SHAPE_TO_SCENE[node.shape] : 'rectangle';
      if (!supported) report.plainShapes[node.shape] = (report.plainShapes[node.shape] ?? 0) + 1;
      if (shape !== 'rectangle') report.extraShapes[shape] = (report.extraShapes[shape] ?? 0) + 1;
      cards.set(node.id, {
        type: 'text',
        text: node.target ? `[${node.label}](${node.target})` : node.label,
        shape,
        ...box,
        ...color,
      });
    }
  }
  const used = new Set(cards.keys()),
    groupIds = new Map(sketch.groups.map((group) => [group.id, unique(`group-${group.id}`, used)]));
  const groups = new Map<string, NewCard>();
  const building = new Set<string>();
  const build = (group: SketchGroup): NewCard | null => {
    const id = groupIds.get(group.id)!;
    const prior = groups.get(id);
    if (prior) return prior;
    if (building.has(id)) throw new Error('The diagram has a group cycle.');
    building.add(id);
    const members = group.members.flatMap((member) => boxes.get(member) ?? []);
    for (const child of sketch.groups.filter((child) => child.parent === group.id)) {
      const box = build(child);
      if (box) members.push(box);
    }
    building.delete(id);
    if (!members.length) return null;
    const card: NewCard = { type: 'group', label: group.label, ...around(members) };
    groups.set(id, card);
    boxes.set(group.id, card);
    return card;
  };
  for (const group of sketch.groups) build(group);
  const ordered: [string, NewCard][] = [];
  const listed = new Set<string>();
  const append = (group: SketchGroup) => {
    if (listed.has(group.id)) return;
    listed.add(group.id);
    const id = groupIds.get(group.id)!;
    const card = groups.get(id);
    if (card) ordered.push([id, card]);
    for (const child of sketch.groups.filter((child) => child.parent === group.id)) append(child);
  };
  for (const group of sketch.groups.filter((group) => !group.parent)) append(group);
  for (const group of sketch.groups) append(group);
  report.emptyGroups = sketch.groups.length - groups.size;
  ordered.push(...cards);
  let ids = ordered.map(([id]) => id);
  const nodes = addCards(
    EMPTY_BOARD,
    { cards: ordered.map(([, card]) => card) },
    { createId: () => ids.shift()! },
  );
  if (!nodes.ok) throw new Error(nodes.refusal.message);
  const edgeIds = new Set<string>(),
    connections: NewEdge[] = [],
    connectionIds: string[] = [];
  for (const edge of sketch.edges) {
    if (edge.invisible) {
      report.invisible++;
      continue;
    }
    const fromNode = groupIds.get(edge.from) ?? edge.from,
      toNode = groupIds.get(edge.to) ?? edge.to;
    const from = nodes.board.nodes.get(fromNode),
      to = nodes.board.nodes.get(toNode);
    if (!from || !to) {
      report.missingEndpoints++;
      continue;
    }
    const sides = facingSides(from, to);
    connections.push({
      fromNode,
      toNode,
      fromSide: sides.from,
      toSide: sides.to,
      fromEnd: edge.fromEnd,
      toEnd: edge.toEnd,
      ...(edge.label === undefined ? {} : { label: edge.label }),
    });
    connectionIds.push(unique(`e-${edge.from}-${edge.to}`, edgeIds));
    report.specialHeads += edge.specialHeads;
    if (edge.stroke === 'thick') report.thick++;
    if (edge.stroke === 'dotted') report.dotted++;
  }
  ids = connectionIds;
  const result = addEdges(nodes.board, { edges: connections }, { createId: () => ids.shift()! });
  if (!result.ok) throw new Error(result.refusal.message);
  report.nodes = cards.size;
  report.links = connections.length;
  report.groups = groups.size;
  return { board: result.board, report };
}
export function importReportLines(r: ImportReport): string[] {
  const lines = [
    `${count(r.nodes, 'node')}, ${count(r.links, 'link')} and ${count(r.groups, 'group')} become a new whiteboard.`,
  ];
  if (r.pageCards)
    lines.push(
      `${count(r.pageCards, 'node')} linked to pages ${r.pageCards === 1 ? 'becomes a card' : 'become cards'}.`,
    );
  if (r.defaultSizes) lines.push(`${count(r.defaultSizes, 'node')} took a default size.`);
  if (r.unpositioned)
    lines.push(
      `${count(r.unpositioned, 'node')} had no saved position and ${r.unpositioned === 1 ? 'sits' : 'sit'} in a row below.`,
    );
  const shapeNames = (shapes: Record<string, number>) =>
    Object.entries(shapes)
      .map(([shape, n]) => `${shape} ×${n}`)
      .join(', ');
  const plain = Object.values(r.plainShapes).reduce((a, b) => a + b, 0);
  if (plain)
    lines.push(`${count(plain, 'shape')} drew as plain boxes: ${shapeNames(r.plainShapes)}.`);
  if (Object.keys(r.extraShapes).length)
    lines.push(
      `These shapes stay in Cerebro; other apps may draw rectangles: ${shapeNames(r.extraShapes)}.`,
    );
  if (r.specialHeads)
    lines.push(`Circle and cross arrowheads became plain arrows (${r.specialHeads}).`);
  if (r.invisible)
    lines.push(
      `${count(r.invisible, 'invisible link')} ${r.invisible === 1 ? 'was a layout hint and was' : 'were layout hints and were'} left out.`,
    );
  if (r.missingEndpoints)
    lines.push(
      `${count(r.missingEndpoints, 'link')} had missing endpoints and ${r.missingEndpoints === 1 ? 'was' : 'were'} left out.`,
    );
  if (r.emptyGroups)
    lines.push(
      `${count(r.emptyGroups, 'empty group')} ${r.emptyGroups === 1 ? 'was' : 'were'} left out.`,
    );
  if (r.thick || r.dotted)
    lines.push(`Thick links (${r.thick}) and dotted links (${r.dotted}) become plain connections.`);
  if (r.alphaColors)
    lines.push(
      `${count(r.alphaColors, 'fill color')} ${r.alphaColors === 1 ? 'loses' : 'lose'} transparency.`,
    );
  if (r.icons || r.animations || r.styleKeys.length)
    lines.push(
      `Icons (${r.icons}), animations (${r.animations}) and style keys other than fill (${r.styleKeys.join(', ') || 'none'}) stay only in the .mmd.`,
    );
  if (r.leftovers.length)
    lines.push(
      `${count(r.leftovers.length, 'line')} the converter can't read ${r.leftovers.length === 1 ? 'stays' : 'stay'} only in the .mmd.`,
      ...r.leftovers.slice(0, 3).map((line) => `“${line}”`),
    );
  if (r.settings) lines.push("Diagram settings (theme, layout) don't apply to a whiteboard.");
  lines.push('The .mmd file stays where it is, unchanged.');
  return lines;
}
