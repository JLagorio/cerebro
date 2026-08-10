import { describe, expect, it } from 'vitest';
import {
  edgeAnimated,
  edgeMeta,
  edges,
  emitArrow,
  emitNodeRef,
  nodeLinks,
  nodeMeta,
  nodeStyle,
  nodes,
  parseFlowchart,
  parseNodeToken,
  serialize,
  withMetaEntry,
  type EdgeHead,
  type EdgeStroke,
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

  it('classifies styling and comments as opaque', () => {
    const model = parseFlowchart(EXOTIC)!;
    const kinds = model.lines.map((l) => l.parsed.kind);
    // frontmatter (4 lines) + comment + classDef + class = 7 opaque. Was 8
    // until M29.36 made the plain-link `click B "…"` an understood kind —
    // the floor drops by exactly that one line, the fixture is unchanged.
    expect(kinds.filter((k) => k === 'opaque').length).toBeGreaterThanOrEqual(7);
    expect(kinds.filter((k) => k === 'click').length).toBe(1);
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

  it('nodeStyle reads a style line as a record', () => {
    const m = parseFlowchart(STYLED)!;
    expect(nodeStyle(m, 'A')).toEqual({ fill: '#f96', stroke: '#333', 'stroke-width': '2px' });
    expect(nodeStyle(m, 'B')).toEqual({});
  });

  it('nodeStyle folds every style line for an id the way mermaid resolves them', () => {
    // Measured on mermaid 11.16: this pair renders
    // `fill:#000 !important;stroke:red !important` — last value per key wins,
    // first position kept. Reporting the first line's `#f96` would show the
    // colour UI a value the diagram does not render.
    const two = 'flowchart TD\n  A --> B\n  style A fill:#f96,stroke:red\n  style A fill:#000';
    expect(nodeStyle(parseFlowchart(two)!, 'A')).toEqual({ fill: '#000', stroke: 'red' });

    const split = 'flowchart TD\n  A --> B\n  style A fill:#f96\n  style A stroke:blue,fill:#000';
    expect(nodeStyle(parseFlowchart(split)!, 'A')).toEqual({ fill: '#000', stroke: 'blue' });

    // Duplicates inside ONE line settle the same way.
    const inline = 'flowchart TD\n  A --> B\n  style A fill:#f96,fill:#000';
    expect(nodeStyle(parseFlowchart(inline)!, 'A')).toEqual({ fill: '#000' });
  });

  it('refuses bodies whose characters mermaid does not lex as style components', () => {
    // Verified by rendering mermaid 11.16: `(` pushes the `text` lexer state,
    // so `rgb(…)`/`var(…)` are parse errors that kill the whole diagram;
    // `"`, `=`, `^`, `@`, `<`, `{`, `~` fail to lex or mean something
    // structural; `,` is the separator itself.
    //
    // Two of these mermaid ACCEPTS — `fill:#f96;` renders `fill:#f96`
    // (`encodeEntities`, utils.ts:895-903, deletes the trailing `;`) and
    // `fill:#f96\,stroke:#333` renders two declarations, the first ending in a
    // backslash. We still refuse them: the value set is deliberately tighter
    // than mermaid's, and opacity costs only editability, never correctness.
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

describe('extended edge grammar (M29.31)', () => {
  it('parses every stroke × head combination, raw tokens intact', () => {
    const src = [
      'flowchart TD',
      '  A --o B',
      '  B --x C',
      '  C <--> D',
      '  D o--o E',
      '  E x==x F',
      '  F ==> G',
      '  G === H',
      '  H -..-> I',
      '  I ~~~ J',
      '  J ----> K',
    ].join('\n');
    const m = parseFlowchart(src)!;
    expect(m.lines.slice(1).every((l) => l.parsed.kind === 'edges')).toBe(true);
    const e = edges(m);
    expect(e[0].arrow).toEqual({ stroke: 'normal', head: 'circle', raw: '--o' });
    expect(e[1].arrow).toEqual({ stroke: 'normal', head: 'cross', raw: '--x' });
    expect(e[2].arrow).toEqual({ stroke: 'normal', head: 'double', raw: '<-->' });
    expect(e[3].arrow).toEqual({ stroke: 'normal', head: 'double', raw: 'o--o' });
    expect(e[4].arrow).toEqual({ stroke: 'thick', head: 'double', raw: 'x==x' });
    expect(e[5].arrow).toEqual({ stroke: 'thick', head: 'arrow', raw: '==>' });
    expect(e[6].arrow).toEqual({ stroke: 'thick', head: 'open', raw: '===' });
    expect(e[7].arrow).toEqual({ stroke: 'dotted', head: 'arrow', raw: '-..->' });
    expect(e[8].arrow).toEqual({ stroke: 'invisible', head: 'open', raw: '~~~' });
    expect(e[9].arrow).toEqual({ stroke: 'normal', head: 'arrow', raw: '---->' });
    expect(serialize(m)).toBe(src);
  });

  it('mismatched markers, lone starts, and labeled invisibles are not ours', () => {
    for (const bad of ['A o--x B', 'A <--o B', 'A <-- B', 'A ~~~|no| B']) {
      const m = parseFlowchart(`flowchart TD\n  ${bad}`)!;
      expect(m.lines[1].parsed.kind).toBe('opaque');
      expect(serialize(m)).toBe(`flowchart TD\n  ${bad}`);
    }
  });

  it('edge ids ride their segment and round-trip', () => {
    const src = 'flowchart TD\n  A e1@-->|go| B e2@--> C';
    const m = parseFlowchart(src)!;
    const e = edges(m);
    expect(e[0]).toMatchObject({ from: 'A', to: 'B', id: 'e1', label: 'go' });
    expect(e[1]).toMatchObject({ from: 'B', to: 'C', id: 'e2' });
    expect(serialize(m)).toBe(src);
  });

  it('an edge-meta id is meta, not a node', () => {
    const m = parseFlowchart('flowchart TD\n  A e1@--> B\n  e1@{ animate: true }')!;
    expect(m.lines[2].parsed.kind).toBe('node-meta');
    expect(nodes(m).has('e1')).toBe(false);
    expect(nodes(m).has('A')).toBe(true);
    expect(edgeAnimated(m, edges(m)[0])).toBe(true);
  });
});

describe('extended edge grammar — adversarial sweep (M29.31)', () => {
  // Every one of these was cross-checked against real mermaid 11.16.0 while
  // this task was built: for each line we OWN, mermaid's parsed endpoints,
  // arrow type, stroke, label, and edge id match ours, and every dirty
  // re-emit is a line mermaid still accepts. The cross-check needs a mermaid
  // import, so it lived in a throwaway harness; what survives here is the
  // pure half — ownership and byte fidelity — which is what can regress.
  const OWNED = [
    // every stroke × head that is a single-token link
    'A --> B',
    'A --o B',
    'A --x B',
    'A --- B',
    'A ==> B',
    'A ==o B',
    'A ==x B',
    'A === B',
    'A -.-> B',
    'A -.-o B',
    'A -.-x B',
    'A -.- B',
    'A <--> B',
    'A o--o B',
    'A x--x B',
    'A <==> B',
    'A o==o B',
    'A x==x B',
    'A <-.-> B',
    'A o-.-o B',
    'A x-.-x B',
    'A ~~~ B',
    // lengths, at and past the upstream minlen cap of 10
    'A ---> B',
    'A -----------> B',
    'A ---------------------> B',
    'A ====> B',
    'A -...........-> B',
    'A ~~~~~~~~~~~~ B',
    // labels
    'A -->|a-->b| B',
    'A -->|a==>b| B',
    'A -->|über 中文 🎉| B',
    'A --o|circle label| B',
    // ids
    'A e1@--> B',
    'A e1@-->|go| B',
    'A e1@~~~ B',
    'A e1@<--> B',
    'A e-1.x@--> B',
    'A é1@--> B',
    'A e1@--> B e2@--o C e3@~~~ D',
    'A e1@--> B & C',
    'A & B e1@--> C & D',
    // chains, groups, inline brackets, no-space forms
    'A --> B --> C --> D --> E',
    'A[x] e1@--> B([y]) e2@--x C{{z}}',
    'A[Start] e1@-->|go| B{Choice} --x C[(Store)]',
    'A["a|b"] --> B',
    'A-->B',
    'A--oB',
    'A~~~B',
    'A-.-B',
    'A===B',
  ];

  // Not ours — and each for a measured reason, listed beside it.
  const OPAQUE = [
    // A start marker that does not pair with the end one is NOT a parse
    // error upstream: destructEndLink (flowDb.ts:865-912) reads only the last
    // character for the head and counts the rest — the stray `o`/`x`/`<`
    // included — as length. `A o--x B` renders as `A --x B` one rank longer,
    // circle gone. We cannot reproduce that, so we refuse it.
    'A <--o B',
    'A <--x B',
    'A o--> B',
    'A o--x B',
    'A x--> B',
    'A x--o B',
    'A <==o B',
    'A o==> B',
    'A x==o B',
    'A <-.-o B',
    'A o-.-> B',
    'A x-.-o B',
    // START_LINK forms: `--`/`==`/`-.` open the `A -- text --> B` state and
    // are never links on their own (measured: both are parse errors alone).
    'A <-- B',
    'A -- B',
    'A -- text --> B',
    // valid mermaid we deliberately decline (see parseEdgeLine)
    'A ~~~|no| B',
    'A .-> B',
    'A e1@ --> B',
    // genuinely broken, or unnameable
    'A -->|| B',
    'A -->|a|b| B',
    'A -->|unclosed B',
    'A a@b@--> B',
    'A @--> B',
    'Ae1@--> B',
    'e1@--> B',
    'A ==WEIRD==> C',
    'A --> B extra text',
  ];

  it('owns what it can reproduce, and every owned line survives a dirty re-emit', () => {
    for (const body of OWNED) {
      const src = `flowchart TD\n  ${body}`;
      const m = parseFlowchart(src)!;
      expect([body, m.lines[1].parsed.kind]).toEqual([body, 'edges']);
      expect([body, serialize(m)]).toEqual([body, src]);

      // Emit → re-parse → emit is a fixed point: an edit may normalize the
      // line, but never costs it its structural editability.
      m.lines[1].dirty = true;
      const once = serialize(m);
      const again = parseFlowchart(once)!;
      expect([body, again.lines[1].parsed.kind]).toEqual([body, 'edges']);
      again.lines[1].dirty = true;
      expect([body, serialize(again)]).toEqual([body, once]);
      expect([body, edges(again)]).toEqual([body, edges(m)]);
    }
  });

  it('refuses what it cannot reproduce, byte-for-byte', () => {
    for (const body of OPAQUE) {
      const src = `flowchart TD\n  ${body}`;
      const m = parseFlowchart(src)!;
      expect([body, m.lines[1].parsed.kind]).not.toEqual([body, 'edges']);
      expect([body, serialize(m)]).toEqual([body, src]);
    }
  });

  it('emitArrow only ever writes tokens the parser reads back unchanged', () => {
    // The last boundary before the file, for the one emitter this task adds:
    // every (stroke, head) the ops layer can ask for, from every marker
    // family it can start from.
    const strokes: EdgeStroke[] = ['normal', 'thick', 'dotted', 'invisible'];
    const heads: EdgeHead[] = ['arrow', 'open', 'circle', 'cross', 'double'];
    for (const stroke of strokes) {
      for (const head of heads) {
        for (const prev of ['-->', 'o--o', 'x==x', '<-->', '~~~', '-.-']) {
          const raw = emitArrow(stroke, head, prev);
          const m = parseFlowchart(`flowchart TD\n  A ${raw} B`)!;
          const line = m.lines[1].parsed;
          expect([stroke, head, prev, line.kind]).toEqual([stroke, head, prev, 'edges']);
          if (line.kind !== 'edges') continue;
          const got = line.segments[0].arrow;
          // `~~~` has no head of its own; everything else survives intact.
          expect([stroke, head, prev, got]).toEqual([
            stroke,
            head,
            prev,
            { stroke, head: stroke === 'invisible' ? 'open' : head, raw },
          ]);
        }
      }
    }
  });

  it('round-trips CRLF, tabs, and odd indentation untouched', () => {
    for (const src of [
      'flowchart TD\r\n  A e1@--> B\r\n  e1@{ animate: true }\r\n',
      'flowchart TD\n\tA --o B\n\t\tB ~~~ C',
      'flowchart TD\n   A   -->   B',
      '---\nconfig:\n  layout: elk\n---\nflowchart LR\n  A e1@--> B\n  e1@{ animate: true }',
    ]) {
      expect(serialize(parseFlowchart(src)!)).toBe(src);
    }
  });
});

describe('edge ids and the meta they own (M29.31)', () => {
  it('an edge-id line no longer costs its endpoints their place in nodes()', () => {
    // M29.29 shipped this backwards: `A e1@--> B` failed parseEdgeLine, went
    // opaque, and the only "node" the model could see was the phantom `e1`
    // minted by the meta line — A and B vanished outright.
    const m = parseFlowchart('flowchart TD\n  A e1@--> B\n  e1@{ animate: true }')!;
    expect([...nodes(m).keys()]).toEqual(['A', 'B']);
    expect(nodeMeta(m).has('e1')).toBe(false);
    expect(edgeMeta(m).get('e1')?.entries).toEqual([['animate', 'true']]);
  });

  it('position decides: the same meta line above the edge really is a node', () => {
    // Measured on 11.16.0 — `addVertex` resolves the id against the edges
    // parsed SO FAR (flowDb.ts:163), so this source renders a stray box
    // labeled `e1` and the edge is NOT animated. Hiding it would be a lie.
    const m = parseFlowchart('flowchart TD\n  e1@{ animate: true }\n  A e1@--> B')!;
    expect([...nodes(m).keys()].sort()).toEqual(['A', 'B', 'e1']);
    expect(edgeAnimated(m, edges(m)[0])).toBe(false);
  });

  it('an id no edge claims stays node meta, exactly as mermaid renders it', () => {
    const m = parseFlowchart('flowchart TD\n  A --> B\n  e1@{ shape: cyl }')!;
    expect(nodes(m).get('e1')).toEqual({ label: 'e1', shape: 'rect', metaShape: 'cyl' });
  });

  it('an & group gives its id to the one edge upstream gives it to', () => {
    // addLink (flowDb.ts:356-371) hands the user id to the LAST start crossed
    // with the FIRST end and auto-generates the rest, so `A e1@--> B & C`
    // animates A→B only.
    const fanOut = parseFlowchart('flowchart TD\n  A e1@--> B & C')!;
    expect(edges(fanOut).map((e) => [e.from, e.to, e.id])).toEqual([
      ['A', 'B', 'e1'],
      ['A', 'C', null],
    ]);
    const fanIn = parseFlowchart('flowchart TD\n  A & B e1@--> C')!;
    expect(edges(fanIn).map((e) => [e.from, e.to, e.id])).toEqual([
      ['A', 'C', null],
      ['B', 'C', 'e1'],
    ]);
  });

  it('edgeAnimated follows the last value per key, and ignores animation:', () => {
    const off = parseFlowchart(
      'flowchart TD\n  A e1@--> B\n  e1@{ animate: true }\n  e1@{ animate: false }',
    )!;
    expect(edgeAnimated(off, edges(off)[0])).toBe(false);
    const keyed = parseFlowchart('flowchart TD\n  A e1@--> B\n  e1@{ animation: fast }')!;
    expect(edgeAnimated(keyed, edges(keyed)[0])).toBe(false);
    const idless = parseFlowchart('flowchart TD\n  A --> B')!;
    expect(edgeAnimated(idless, edges(idless)[0])).toBe(false);
  });
});

describe('an o/x marker only starts a link at a boundary (M29.31)', () => {
  // `o` and `x` are ordinary NODE_STRING characters (flow.jison:207), so a
  // start marker only begins a link where an id could not have continued.
  // Anchoring the marker anywhere ate the last character of the preceding id:
  // measured against 11.16.0, `Foo--oBar` is `Foo --o Bar`, and reading it as
  // `Fo o--o Bar` invented a node `Fo`, hid `Foo`, and made any edit that
  // dirtied the line a silent rename.
  const AT_BOUNDARY: [string, string, string, string][] = [
    // source, from, to, expected head
    ['Foo--oBar', 'Foo', 'Bar', 'circle'],
    ['Repo--oDB', 'Repo', 'DB', 'circle'],
    ['Ax--xB', 'Ax', 'B', 'cross'],
    ['A1o--oB', 'A1o', 'B', 'circle'],
    ['A.o--oB', 'A.o', 'B', 'circle'],
    ['A-o--oB', 'A-o', 'B', 'circle'],
    ['A_o--oB', 'A_o', 'B', 'circle'],
    ['Ao==oB', 'Ao', 'B', 'circle'],
    ['Ax==xB', 'Ax', 'B', 'cross'],
    ['Ao-.-oB', 'Ao', 'B', 'circle'],
    ['Ao--o B', 'Ao', 'B', 'circle'],
  ];

  it('an id ending in o/x keeps its last character, across every stroke', () => {
    for (const [body, from, to, head] of AT_BOUNDARY) {
      const m = parseFlowchart(`flowchart TD\n  ${body}`)!;
      const e = edges(m);
      expect([body, e.length]).toEqual([body, 1]);
      expect([body, e[0].from, e[0].to, e[0].arrow.head]).toEqual([body, from, to, head]);
      expect([body, [...nodes(m).keys()]]).toEqual([body, [from, to]]);
      expect([body, serialize(m)]).toEqual([body, `flowchart TD\n  ${body}`]);
    }
  });

  it('a dirtied line no longer renames the node it starts from', () => {
    // The failure this closes: `Foo--oBar` re-emitted as `Fo --o Bar`.
    const m = parseFlowchart('flowchart TD\n  Foo--oBar')!;
    m.lines[1].dirty = true;
    expect(serialize(m)).toBe('flowchart TD\n  Foo --o Bar');
  });

  it('non-id characters are still boundaries, so real double links survive', () => {
    // `]`, `)`, `}`, `@` and whitespace all end an id, and `<` is not an id
    // character at all — every one of these agreed with mermaid before and
    // must keep agreeing.
    const doubles = [
      'A o--o B',
      'A x--x B',
      'A o==o B',
      'A x-.-x B',
      'A[x]o--oB',
      'A(x)o--oB',
      'A{x}x--xB',
      'A e1@o--o B',
      'A<-->B',
      'A <--> B',
    ];
    for (const body of doubles) {
      const m = parseFlowchart(`flowchart TD\n  ${body}`)!;
      expect([body, m.lines[1].parsed.kind]).toEqual([body, 'edges']);
      expect([body, edges(m)[0].arrow.head]).toEqual([body, 'double']);
      expect([body, serialize(m)]).toEqual([body, `flowchart TD\n  ${body}`]);
    }
  });
});

describe('edge labels quote what mermaid cannot lex bare (M29.31)', () => {
  // Edge labels answer to the same lexer state as bracket labels: measured
  // char by char against 11.16.0, `( ) [ ] { } @ "` are parse errors bare and
  // all of them are fine quoted, and mermaid strips a surrounding pair
  // (flowDb.ts:304-306) so quoting is lossless.
  it('strips a surrounding quote pair on parse, exactly as mermaid does', () => {
    const m = parseFlowchart('flowchart TD\n  A -->|"Deploy (prod)"| B')!;
    expect(edges(m)[0].label).toBe('Deploy (prod)');
    expect(serialize(m)).toBe('flowchart TD\n  A -->|"Deploy (prod)"| B');
  });

  it('re-quotes only what needs it, and is a fixed point either way', () => {
    for (const [label, emitted] of [
      ['Deploy (prod)', '|"Deploy (prod)"|'],
      ['a@b', '|"a@b"|'],
      ['a[b]', '|"a[b]"|'],
      ['a{b}', '|"a{b}"|'],
      ['plain words', '|plain words|'],
      ['a-->b', '|a-->b|'],
      ['über 中文', '|über 中文|'],
    ]) {
      const m = parseFlowchart('flowchart TD\n  A --> B')!;
      const line = m.lines[1].parsed;
      if (line.kind !== 'edges') throw new Error('expected edges');
      line.segments[0].label = label;
      m.lines[1].dirty = true;
      const once = serialize(m);
      expect([label, once]).toEqual([label, `flowchart TD\n  A -->${emitted} B`]);

      // Our own parser reads the value straight back, quotes and all.
      const again = parseFlowchart(once)!;
      expect([label, again.lines[1].parsed.kind]).toEqual([label, 'edges']);
      expect([label, edges(again)[0].label]).toEqual([label, label]);
      again.lines[1].dirty = true;
      expect([label, serialize(again)]).toEqual([label, once]);
    }
  });

  it('an empty label, quoted or not, is not ours — both are parse errors', () => {
    for (const body of ['A -->|| B', 'A -->|""| B']) {
      const m = parseFlowchart(`flowchart TD\n  ${body}`)!;
      expect([body, m.lines[1].parsed.kind]).toEqual([body, 'opaque']);
      expect([body, serialize(m)]).toEqual([body, `flowchart TD\n  ${body}`]);
    }
  });
});

describe('meta bodies with duplicate keys (M29.32 review)', () => {
  it('goes opaque — mermaid refuses the whole document', () => {
    // Measured on 11.16.0: `A@{ shape: cyl, shape: hex }` throws
    // `duplicated mapping key (2:14)` out of yaml.load, so a body we read
    // happily would be a line the renderer rejects outright.
    for (const body of ['shape: cyl, shape: hex', 'label: a, label: b', 'w: 1, w: 2']) {
      const m = parseFlowchart(`flowchart TD\n  A --> B\n  A@{ ${body} }`)!;
      expect([body, m.lines[2].parsed.kind]).toEqual([body, 'opaque']);
    }
  });

  it('and its bytes survive untouched, as every refusal does', () => {
    const src = 'flowchart TD\n  A --> B\n  A@{ shape: cyl, shape: hex }';
    expect(serialize(parseFlowchart(src)!)).toBe(src);
  });

  it('distinct keys are unaffected', () => {
    const m = parseFlowchart('flowchart TD\n  A --> B\n  A@{ shape: cyl, label: x }')!;
    expect(m.lines[2].parsed.kind).toBe('node-meta');
  });
});

/**
 * The plain-link `click` form (M29.36). Every claim below was MEASURED against
 * the bundled mermaid 11.16.0 and is pinned in `links.mermaid.test.ts`; the
 * whitespace rules in particular are far tighter than they look, and the plan
 * this task came from had them wrong.
 */
describe('click lines', () => {
  const SRC = [
    'flowchart TD',
    '  A[Start] --> B',
    '  click A "https://example.com"',
    '  click B "projects/atlas/project.md"',
    '  click B call doThing()',
    '  click A href "https://example.com"',
    '  click A "https://example.com" "a tooltip"',
    '  click A,B "https://example.com"',
    '  click A  "two-spaces.md"',
    '  click A "trailing-space.md" ', // the trailing space is load-bearing
    '  click A ""',
    '  click',
  ].join('\n');

  it('owns exactly the plain `click <id> "<target>"` form; every variant stays opaque', () => {
    const model = parseFlowchart(SRC)!;
    const kinds = model.lines.map((l) => l.parsed.kind);
    expect(kinds[2]).toBe('click');
    expect(kinds[3]).toBe('click');
    // call / href / tooltip / comma-list: legal mermaid, not ours.
    //
    // The last four are the ones the plan got wrong, all MEASURED as PARSE
    // ERRORS on 11.16.0 — mermaid's lexer pops the `click` state on exactly
    // ONE whitespace character (`<click>[\s\n]`, flow.jison:112) and the
    // grammar has no rule for a SPACE after the string, so `click A  "x"`,
    // a trailing space, and an empty target each kill the whole diagram.
    // Owning a line the renderer rejects is the boundary violation
    // `parseMetaBody` already refuses duplicate keys over.
    //
    // The bare `click` matters most: without an explicit guard the node-token
    // fallback would mint a phantom node with id "click" (the same trap the
    // anonymous `subgraph` line already documents).
    expect(kinds.slice(4)).toEqual(Array(8).fill('opaque'));
  });

  it('parses id and target', () => {
    const model = parseFlowchart(SRC)!;
    expect(model.lines[2].parsed).toEqual({
      kind: 'click',
      id: 'A',
      target: 'https://example.com',
    });
    expect(model.lines[3].parsed).toEqual({
      kind: 'click',
      id: 'B',
      target: 'projects/atlas/project.md',
    });
  });

  it('no click-shaped line ever mints a node — owned or opaque', () => {
    // The `Foo--oBar` scar, applied to a new construct: a parser that reports
    // nodes mermaid does not have is a parser that will rename or delete
    // something the user never wrote. Measured: mermaid's vertices for this
    // document's rendering subset are exactly A and B.
    expect([...nodes(parseFlowchart(SRC)!).keys()].sort()).toEqual(['A', 'B']);
    // …and the id charset can never smuggle one in either.
    for (const line of ['click', 'click A,B "x.md"', 'CLICK A "x.md"', 'clickety A "x.md"']) {
      const m = parseFlowchart(`flowchart TD\n  A --> B\n  ${line}`)!;
      expect([line, [...nodes(m).keys()].sort()]).toEqual([line, ['A', 'B']]);
    }
  });

  it('tolerates a trailing CR, because mermaid normalizes CRLF before parsing', () => {
    const m = parseFlowchart('flowchart TD\r\n  A --> B\r\n  click A "u.md"\r')!;
    expect(m.lines[2].parsed).toMatchObject({ kind: 'click', target: 'u.md' });
  });

  it('a whitespace-only target is not a link', () => {
    // `click A " "` parses, but `utils.formatUrl` returns undefined for a
    // blank url so mermaid attaches nothing. Reporting a link there would be
    // the model claiming a fact the render does not have.
    const m = parseFlowchart('flowchart TD\n  A --> B\n  click A "   "')!;
    expect(m.lines[2].parsed.kind).toBe('opaque');
  });

  it('classDef and class stay opaque — the keyword regex still matches longest-first', () => {
    const model = parseFlowchart('flowchart TD\n  A\n  classDef hot fill:#f96\n  class A hot')!;
    expect(model.lines[2].parsed.kind).toBe('opaque');
    expect(model.lines[3].parsed.kind).toBe('opaque');
  });

  it('nodeLinks maps each linked node to its target (last click line wins, like mermaid)', () => {
    const model = parseFlowchart(
      'flowchart TD\n  A --> B\n  click A "one.md"\n  click A "two.md"',
    )!;
    expect(nodeLinks(model).get('A')).toEqual({ line: 3, target: 'two.md' });
    expect(nodeLinks(model).has('B')).toBe(false);
  });

  it('nodeLinks reports only OWNED lines, and says so', () => {
    // MEASURED: the `href` form writes the same vertex slot as the plain one
    // and the LAST of all of them wins, so on this document mermaid's picture
    // anchors to href.md while the editor's reading says plain.md. Pinned as a
    // known divergence rather than left to be discovered.
    const model = parseFlowchart(
      'flowchart TD\n  A --> B\n  click A "plain.md"\n  click A href "href.md"',
    )!;
    expect(nodeLinks(model).get('A')).toEqual({ line: 2, target: 'plain.md' });
  });

  it('round-trips click lines byte-identically when untouched', () => {
    expect(serialize(parseFlowchart(SRC)!)).toBe(SRC);
  });
});
