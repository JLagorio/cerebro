import { describe, expect, it } from 'vitest';
import { detectDiagramType } from './detect';

describe('detectDiagramType', () => {
  it.each([
    ['flowchart TD\n A-->B', 'Flowchart'],
    ['graph LR\n A-->B', 'Flowchart'],
    ['sequenceDiagram\n A->>B: hi', 'Sequence'],
    ['classDiagram\n class A', 'Class'],
    ['stateDiagram-v2\n [*] --> A', 'State'],
    ['erDiagram\n A ||--o{ B : x', 'ER'],
    ['gantt\n title X', 'Gantt'],
    ['pie title X\n "A": 1', 'Pie'],
    ['mindmap\n root((x))', 'Mindmap'],
    ['timeline\n title X', 'Timeline'],
    ['quadrantChart\n title X', 'Quadrant'],
    ['xychart-beta\n title X', 'XY chart'],
    ['architecture-beta\n group a(cloud)[A]', 'Architecture'],
    ['gitGraph\n commit', 'Git graph'],
    ['journey\n title X', 'Journey'],
    ['kanban\n Todo', 'Kanban'],
    ['unknownthing\n x', 'Mermaid'],
    ['', 'Mermaid'],
  ])('detects %s → %s', (code, label) => {
    expect(detectDiagramType(code)).toBe(label);
  });

  it('skips frontmatter and comments', () => {
    expect(detectDiagramType('---\nconfig:\n  layout: elk\n---\n%% note\nflowchart TD\n A')).toBe(
      'Flowchart',
    );
  });
});
