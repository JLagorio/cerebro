/**
 * Names the diagram a fence contains (M29.12) — for the block header, and for
 * Stage C's "is this a flowchart?" gate. First meaningful token wins;
 * frontmatter (`--- … ---` at the top) and `%%` comments are skipped.
 */
const TYPE_LABELS: [RegExp, string][] = [
  [/^(flowchart|graph)\b/, 'Flowchart'],
  [/^sequenceDiagram\b/, 'Sequence'],
  [/^classDiagram/, 'Class'],
  [/^stateDiagram/, 'State'],
  [/^erDiagram\b/, 'ER'],
  [/^gantt\b/, 'Gantt'],
  [/^pie\b/, 'Pie'],
  [/^mindmap\b/, 'Mindmap'],
  [/^timeline\b/, 'Timeline'],
  [/^quadrantChart\b/, 'Quadrant'],
  [/^sankey/, 'Sankey'],
  [/^xychart/, 'XY chart'],
  [/^block-beta\b/, 'Block'],
  [/^packet/, 'Packet'],
  [/^kanban\b/, 'Kanban'],
  [/^architecture/, 'Architecture'],
  [/^radar/, 'Radar'],
  [/^C4/, 'C4'],
  [/^journey\b/, 'Journey'],
  [/^gitGraph\b/, 'Git graph'],
];

export function firstMeaningfulLine(code: string): string {
  const lines = code.split('\n');
  let i = 0;
  if (lines[0]?.trim() === '---') {
    i = 1;
    while (i < lines.length && lines[i].trim() !== '---') i += 1;
    i += 1;
  }
  for (; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line === '' || line.startsWith('%%')) continue;
    return line;
  }
  return '';
}

export function detectDiagramType(code: string): string {
  const line = firstMeaningfulLine(code);
  for (const [pattern, label] of TYPE_LABELS) {
    if (pattern.test(line)) return label;
  }
  return 'Mermaid';
}
