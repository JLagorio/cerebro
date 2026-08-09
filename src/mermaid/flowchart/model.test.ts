import { describe, expect, it } from 'vitest';
import {
  edges,
  emitNodeRef,
  nodeMeta,
  nodes,
  parseFlowchart,
  parseNodeToken,
  serialize,
  withMetaEntry,
  type NodeMeta,
} from './model';

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

describe('node-meta lines (M29.29)', () => {
  const META = [
    'flowchart TD',
    '  A[Start] --> B',
    '  A@{ shape: cloud }',
    '  B@{ shape: cyl, label: "Orders, archived", w: 120, foo: bar }',
  ].join('\n');

  it('parses a single-line meta into ordered entries plus typed keys', () => {
    const model = parseFlowchart(META)!;
    const line = model.lines[3].parsed;
    expect(line.kind).toBe('node-meta');
    if (line.kind !== 'node-meta') return;
    expect(line.id).toBe('B');
    expect(line.meta.entries).toEqual([
      ['shape', 'cyl'],
      ['label', 'Orders, archived'],
      ['w', '120'],
      ['foo', 'bar'],
    ]);
    expect(line.meta.shape).toBe('cyl');
    expect(line.meta.label).toBe('Orders, archived');
  });

  it('round-trips meta-rich sources byte-identically', () => {
    expect(serialize(parseFlowchart(META)!)).toBe(META);
  });

  it('nodeMeta maps ids to their meta, last line winning', () => {
    const m = parseFlowchart('flowchart TD\n  A\n  A@{ shape: hex }\n  A@{ shape: cloud }')!;
    expect(nodeMeta(m).get('A')?.shape).toBe('cloud');
  });

  it('nodes() merges meta shape and label so the resolved view is truthful', () => {
    const n = nodes(parseFlowchart(META)!);
    expect(n.get('A')).toEqual({ label: 'Start', shape: 'rect', metaShape: 'cloud' });
    expect(n.get('B')).toEqual({ label: 'Orders, archived', shape: 'rect', metaShape: 'cyl' });
  });

  it('a meta-only line declares its node', () => {
    const m = parseFlowchart('flowchart TD\n  Cache@{ shape: cyl, label: Store }')!;
    expect(nodes(m).get('Cache')).toEqual({ label: 'Store', shape: 'rect', metaShape: 'cyl' });
  });

  it('multi-line meta blocks and bracket+meta hybrids go opaque, not wrong', () => {
    const src = [
      'flowchart TD',
      '  A[Start] --> B',
      '  B@{',
      '    shape: circle',
      '  }',
      '  A[Start]@{ shape: circle }',
    ].join('\n');
    const model = parseFlowchart(src)!;
    for (const idx of [2, 3, 4, 5]) expect(model.lines[idx].parsed.kind).toBe('opaque');
    expect(serialize(model)).toBe(src);
    // The hybrid line is opaque, but A itself stays resolvable via the edge line.
    expect(nodes(model).get('A')).toEqual({ label: 'Start', shape: 'rect' });
  });

  it('illegal single-line bodies go opaque: bare commas, colons, carets, quotes', () => {
    for (const bad of [
      'A@{ shape: big circle: yes }',
      'A@{ label: has, comma }',
      'A@{ shape: a^b }',
      'A@{ shape: "un"closed }',
    ]) {
      const m = parseFlowchart(`flowchart TD\n  ${bad}`)!;
      expect(m.lines[1].parsed.kind).toBe('opaque');
      expect(serialize(m)).toBe(`flowchart TD\n  ${bad}`);
    }
  });

  it('withMetaEntry adds, replaces, and removes while preserving order', () => {
    const base: NodeMeta = {
      entries: [
        ['shape', 'hex'],
        ['w', '120'],
      ],
      shape: 'hex',
    };
    expect(withMetaEntry(base, 'shape', 'cloud').entries).toEqual([
      ['shape', 'cloud'],
      ['w', '120'],
    ]);
    expect(withMetaEntry(base, 'shape', 'cloud').shape).toBe('cloud');
    expect(withMetaEntry(base, 'pos', 't').entries).toEqual([
      ['shape', 'hex'],
      ['w', '120'],
      ['pos', 't'],
    ]);
    expect(withMetaEntry(base, 'w', null).entries).toEqual([['shape', 'hex']]);
  });

  it('dirty meta lines re-quote values that need it and sanitize illegal characters', () => {
    const m = parseFlowchart('flowchart TD\n  A@{ shape: hex }')!;
    const line = m.lines[1];
    if (line.parsed.kind !== 'node-meta') throw new Error('expected node-meta');
    line.parsed.meta = withMetaEntry(line.parsed.meta, 'label', 'a, b: "c" ^d');
    line.dirty = true;
    expect(serialize(m)).toBe(`flowchart TD\n  A@{ shape: hex, label: "a, b: 'c' d" }`);
  });

  it('keys we do not understand survive a dirty re-emit in their original positions', () => {
    const m = parseFlowchart('flowchart TD\n  A@{ foo: bar, shape: hex, zed: 1 }')!;
    const line = m.lines[1];
    if (line.parsed.kind !== 'node-meta') throw new Error('expected node-meta');
    line.parsed.meta = withMetaEntry(line.parsed.meta, 'shape', 'cloud');
    line.dirty = true;
    // `shape` is replaced where it stood — not appended — and `foo`/`zed`
    // bracket it exactly as the source did.
    expect(serialize(m)).toBe('flowchart TD\n  A@{ foo: bar, shape: cloud, zed: 1 }');
  });
});
