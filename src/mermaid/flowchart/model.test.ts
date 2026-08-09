import { describe, expect, it } from 'vitest';
import { edges, emitNodeRef, nodes, parseFlowchart, parseNodeToken, serialize } from './model';

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

  it('an anonymous subgraph is opaque, not a phantom node', () => {
    const model = parseFlowchart('flowchart TD\n  subgraph\n    A --> B\n  end')!;
    expect(model.lines[1].parsed.kind).toBe('opaque');
    expect(nodes(model).has('subgraph')).toBe(false);
    expect(edges(model)).toContainEqual(expect.objectContaining({ from: 'A', to: 'B' }));
  });

  it('parses stadium shape with the correct close bracket', () => {
    expect(parseNodeToken('A([Start])')).toEqual({ id: 'A', label: 'Start', shape: 'stadium' });
  });

  it('a later labeled inline site wins over an earlier bare reference', () => {
    const model = parseFlowchart('flowchart TD\n  A --> B\n  D --> B[Loop back]')!;
    expect(nodes(model).get('B')).toEqual({ label: 'Loop back', shape: 'rect' });
  });

  it('an earlier labeled inline site still wins when the bare reference comes later', () => {
    const model = parseFlowchart('flowchart TD\n  D --> B[Loop back]\n  A --> B')!;
    expect(nodes(model).get('B')).toEqual({ label: 'Loop back', shape: 'rect' });
  });

  it('a node label containing an arrow substring still parses as a node', () => {
    const model1 = parseFlowchart('flowchart TD\n  A[Contains --> text]')!;
    expect(model1.lines[1].parsed).toMatchObject({
      kind: 'node',
      node: { id: 'A', label: 'Contains --> text' },
    });

    const model2 = parseFlowchart('flowchart TD\n  A[Section ---]')!;
    expect(model2.lines[1].parsed).toMatchObject({
      kind: 'node',
      node: { id: 'A', label: 'Section ---' },
    });
  });

  it('a genuinely broken edge line still goes opaque', () => {
    const model = parseFlowchart('flowchart TD\n  A --> B extra text')!;
    expect(model.lines[1].parsed.kind).toBe('opaque');
  });
});

describe('serialize', () => {
  it('round-trips untouched sources byte-identically', () => {
    for (const src of [SIMPLE, EXOTIC]) {
      expect(serialize(parseFlowchart(src)!)).toBe(src);
    }
  });

  it('round-trips an anonymous subgraph byte-identically', () => {
    const src = 'flowchart TD\n  subgraph\n    A --> B\n  end';
    expect(serialize(parseFlowchart(src)!)).toBe(src);
  });

  it('emits stadium nodes with valid mermaid syntax', () => {
    expect(emitNodeRef({ id: 'A', label: 'Start', shape: 'stadium' })).toBe('A([Start])');
  });
});
