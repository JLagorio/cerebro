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
