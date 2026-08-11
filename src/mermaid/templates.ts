/**
 * Starter sources for the empty-block template grid (M29.11). One entry per
 * commonly-reached diagram type; each renders clean under mermaid 11 defaults.
 * The grid beats ten slash-menu entries: /mermaid stays one item, and the
 * choice appears exactly when it is needed — inside an empty block.
 */
export interface DiagramTemplate {
  id: string;
  label: string;
  /** lucide icon name (Icon resolves it; unresolvable names render visibly, M15.7). */
  icon: string;
  code: string;
}

export const TEMPLATES: DiagramTemplate[] = [
  {
    id: 'flowchart',
    label: 'Flowchart',
    icon: 'waypoints',
    code: 'flowchart TD\n  A[Start] --> B{Decision}\n  B -->|yes| C[Do it]\n  B -->|no| D[Skip it]',
  },
  {
    id: 'sequence',
    label: 'Sequence',
    icon: 'arrow-right-left',
    code: 'sequenceDiagram\n  participant A as Client\n  participant B as Server\n  A->>B: request\n  B-->>A: response',
  },
  {
    id: 'gantt',
    label: 'Gantt',
    icon: 'calendar-range',
    code: 'gantt\n  title Plan\n  dateFormat YYYY-MM-DD\n  section Phase 1\n    Task A :a1, 2026-01-01, 7d\n    Task B :after a1, 5d',
  },
  {
    id: 'state',
    label: 'State',
    icon: 'circle-dot',
    code: 'stateDiagram-v2\n  [*] --> Draft\n  Draft --> Review\n  Review --> Done\n  Done --> [*]',
  },
  {
    id: 'er',
    label: 'Entity-Relation',
    icon: 'database',
    code: 'erDiagram\n  CUSTOMER ||--o{ ORDER : places\n  ORDER ||--|{ LINE_ITEM : contains',
  },
  {
    id: 'class',
    label: 'Class',
    icon: 'boxes',
    code: 'classDiagram\n  class Animal {\n    +name: string\n    +speak() void\n  }\n  Animal <|-- Dog',
  },
  {
    id: 'mindmap',
    label: 'Mindmap',
    icon: 'brain',
    code: 'mindmap\n  root((Idea))\n    Branch A\n      Leaf 1\n    Branch B',
  },
  {
    id: 'timeline',
    label: 'Timeline',
    icon: 'clock',
    code: 'timeline\n  title History\n  2024 : Founded\n  2025 : First release\n  2026 : Growth',
  },
  {
    id: 'pie',
    label: 'Pie',
    icon: 'chart-pie',
    code: 'pie title Share\n  "A" : 45\n  "B" : 35\n  "C" : 20',
  },
  {
    id: 'architecture',
    label: 'Architecture',
    icon: 'server',
    code: 'architecture-beta\n  group api(cloud)[API]\n  service db(database)[Database] in api\n  service web(server)[Web] in api\n  web:R -- L:db',
  },
];
