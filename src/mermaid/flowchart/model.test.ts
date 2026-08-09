import { describe, expect, it } from 'vitest';
import {
  edges,
  emitNodeRef,
  nodeMeta,
  nodeStyle,
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

  it('nodeMeta merges per KEY, last value winning — not per line', () => {
    // mermaid applies each key independently onto the accumulated vertex
    // (flowDb.ts:236-262 — `if (doc.shape) …`, `if (doc?.label) …`), so a
    // later line REFINES the earlier one instead of replacing it. Asserting
    // per-line "last wins" here would encode a model mermaid does not use.
    const m = parseFlowchart(
      'flowchart TD\n  A\n  A@{ shape: hex, label: Keep }\n  A@{ shape: cloud }',
    )!;
    const meta = nodeMeta(m).get('A');
    expect(meta?.shape).toBe('cloud');
    expect(meta?.label).toBe('Keep');
  });

  it('nodes() reports the per-key merge, so the rename box is prefilled truthfully', () => {
    const m = parseFlowchart(
      'flowchart TD\n  A[Old] --> B\n  A@{ label: Meta }\n  A@{ shape: hex }',
    )!;
    expect(nodes(m).get('A')).toEqual({ label: 'Meta', shape: 'rect', metaShape: 'hex' });
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

  it('dirty meta lines re-quote values that need it, substituting only the quote', () => {
    const m = parseFlowchart('flowchart TD\n  A@{ shape: hex }')!;
    const line = m.lines[1];
    if (line.parsed.kind !== 'node-meta') throw new Error('expected node-meta');
    line.parsed.meta = withMetaEntry(line.parsed.meta, 'label', 'a, b: "c" ^d');
    line.dirty = true;
    // `^` is only illegal BARE (flow.jison:57 `[^}^"]+`); inside a quoted
    // string flow.jison:52 is `[^\"]+`, so quoting preserves it. Only `"`
    // itself has no escape and must be substituted.
    expect(serialize(m)).toBe(`flowchart TD\n  A@{ shape: hex, label: "a, b: 'c' ^d" }`);
  });

  it('keys we do not understand survive a dirty re-emit in their original positions', () => {
    // `foo, shape, abc` is deliberately NOT alphabetical: a sorting emitter
    // would reorder it and fail here, which an already-sorted fixture cannot
    // detect.
    const m = parseFlowchart('flowchart TD\n  A@{ foo: bar, shape: hex, abc: 1 }')!;
    const line = m.lines[1];
    if (line.parsed.kind !== 'node-meta') throw new Error('expected node-meta');
    line.parsed.meta = withMetaEntry(line.parsed.meta, 'shape', 'cloud');
    line.dirty = true;
    // `shape` is replaced where it stood — not appended — and `foo`/`abc`
    // bracket it exactly as the source did.
    expect(serialize(m)).toBe('flowchart TD\n  A@{ foo: bar, shape: cloud, abc: 1 }');
  });

  it('bodies whose text is not their YAML value go opaque — re-emitting would break the render', () => {
    // mermaid runs the body through yaml.load (flowDb.ts:146-151), so for each
    // of these the value it gets differs from the text we can see. Owning them
    // would mean a rename re-emits our misreading — and for `shape` that
    // throws `No such shape` at flowDb.ts:239, killing the whole diagram.
    for (const bad of [
      'A@{ shape: cyl # note }', // comment: mermaid sees `cyl`
      "A@{ shape: 'cyl' }", // single-quoted scalar: mermaid sees `cyl`
      'A@{ note: #fff }', // comment: mermaid sees null
      'A@{ shape: &anc cyl }', // anchor
      'A@{ shape: *ali }', // alias
      'A@{ shape: !!str cyl }', // tag
    ]) {
      const m = parseFlowchart(`flowchart TD\n  ${bad}`)!;
      expect(m.lines[1].parsed.kind).toBe('opaque');
      expect(serialize(m)).toBe(`flowchart TD\n  ${bad}`);
    }
  });

  it('a `#` that opens no comment is ordinary text and stays understood', () => {
    const m = parseFlowchart('flowchart TD\n  A@{ label: a#b }')!;
    expect(nodeMeta(m).get('A')?.label).toBe('a#b');
    expect(serialize(m)).toBe('flowchart TD\n  A@{ label: a#b }');
  });

  it('emit → re-parse → emit is a fixed point, and quoting never loses the value', () => {
    // Each value drives a different emitMetaValue branch. Whatever it writes,
    // our OWN parser must read back — otherwise an edit silently costs the
    // line its structural editability, even though the bytes stay valid.
    for (const value of [
      'plain',
      'a, b',
      'a: b',
      'a}b',
      'a^b',
      'a # b',
      'a#b',
      ' padded ',
      "'single'",
    ]) {
      const m = parseFlowchart('flowchart TD\n  A@{ shape: hex }')!;
      const line = m.lines[1];
      if (line.parsed.kind !== 'node-meta') throw new Error('expected node-meta');
      line.parsed.meta = withMetaEntry(line.parsed.meta, 'label', value);
      line.dirty = true;
      const once = serialize(m);

      const again = parseFlowchart(once)!;
      expect(again.lines[1].parsed.kind).toBe('node-meta');
      expect(nodeMeta(again).get('A')?.label).toBe(value);
      again.lines[1].dirty = true;
      expect(serialize(again)).toBe(once);
    }
  });
});

describe('style lines (M29.30)', () => {
  const STYLED = [
    'flowchart TD',
    '  A[Start] --> B{Choice}',
    '  style A fill:#f96,stroke:#333,stroke-width:2px',
  ].join('\n');

  it('parses declarations in order', () => {
    const m = parseFlowchart(STYLED)!;
    const line = m.lines[2].parsed;
    expect(line.kind).toBe('style');
    if (line.kind !== 'style') return;
    expect(line.id).toBe('A');
    expect(line.decls).toEqual([
      ['fill', '#f96'],
      ['stroke', '#333'],
      ['stroke-width', '2px'],
    ]);
  });

  it('round-trips untouched style lines byte-identically, spacing quirks included', () => {
    const quirky = 'flowchart TD\n  A --> B\n  style A fill: #f96 , stroke:#333';
    expect(serialize(parseFlowchart(quirky)!)).toBe(quirky);
  });

  it('linkStyle and classDef stay opaque; an unowned style body goes opaque', () => {
    const m = parseFlowchart(
      [
        'flowchart TD',
        '  A --> B',
        '  linkStyle 0 stroke:#f00',
        '  style A fill',
        '  classDef hot fill:#f96',
      ].join('\n'),
    )!;
    expect(m.lines[2].parsed.kind).toBe('opaque');
    expect(m.lines[3].parsed.kind).toBe('opaque');
    expect(m.lines[4].parsed.kind).toBe('opaque');
  });

  it('nodeStyle reads the first style line as a record', () => {
    const m = parseFlowchart(STYLED)!;
    expect(nodeStyle(m, 'A')).toEqual({ fill: '#f96', stroke: '#333', 'stroke-width': '2px' });
    expect(nodeStyle(m, 'B')).toEqual({});
  });

  it('refuses bodies whose characters mermaid does not lex as style components', () => {
    // Verified against mermaid 11.16: `;` ENDS the style statement, so our
    // canonical re-emission of a `;`-bearing value would smuggle the rest of
    // the line into a brand-new vertex statement (`,color:#000` is a legal
    // idString) — a phantom node appearing out of an unrelated colour edit.
    // The rest are outright parse/lex errors upstream.
    for (const body of [
      'fill:#f96;',
      'fill:"#f96"',
      'fill:a=b',
      'fill:a^b',
      'fill:a@b',
      'fill:a<b',
      'fill:a{b',
      'fill:a~b',
      'fill:#f96\\,stroke:#333',
      'fill:rgb(255,0,0)',
      'fill:#f96,',
      ',fill:#f96',
      '"fill":#f96',
    ]) {
      const m = parseFlowchart(`flowchart TD\n  A --> B\n  style A ${body}`)!;
      expect([body, m.lines[2].parsed.kind]).toEqual([body, 'opaque']);
      expect(serialize(m)).toBe(`flowchart TD\n  A --> B\n  style A ${body}`);
    }
  });

  it('a `style` line we cannot own never becomes a phantom node named style', () => {
    for (const line of ['style', 'style[X]', 'style.a', 'STYLE A fill:#f96', 'style A']) {
      const m = parseFlowchart(`flowchart TD\n  A --> B\n  ${line}`)!;
      expect([line, m.lines[2].parsed.kind]).toEqual([line, 'opaque']);
      expect([line, [...nodes(m).keys()]]).toEqual([line, ['A', 'B']]);
    }
  });
});
