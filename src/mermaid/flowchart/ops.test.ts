import { describe, expect, it } from 'vitest';
import {
  edgeAnimated,
  edges,
  nodeMeta,
  nodeStyle,
  nodes,
  parseFlowchart,
  serialize,
} from './model';
import {
  addEdge,
  addNode,
  deleteEdge,
  deleteNode,
  newEdgeId,
  newNodeId,
  renameNode,
  setDirection,
  setEdgeAnimate,
  setEdgeArrow,
  setEdgeLabel,
  setLayoutEngine,
  setNodeShape,
  setNodeStyle,
} from './ops';

const SRC = [
  'flowchart TD',
  '  A[Start] --> B{Choice}',
  '  B -->|yes| C[Done]',
  '  classDef hot fill:#f96',
  '  class A hot',
].join('\n');

const model = () => parseFlowchart(SRC)!;

describe('renameNode', () => {
  it('edits only the label token; ids and opaque lines are untouched', () => {
    const out = serialize(renameNode(model(), 'A', 'Kickoff'));
    expect(out).toContain('A[Kickoff] --> B{Choice}');
    expect(out).toContain('classDef hot fill:#f96');
    expect(out).toContain('class A hot');
  });

  it('creates a definition line for a node that has no label site', () => {
    const m = parseFlowchart('flowchart TD\n  A --> B')!;
    const out = serialize(renameNode(m, 'B', 'Named'));
    expect(out).toBe('flowchart TD\n  B[Named]\n  A --> B');
  });
});

describe('setNodeShape', () => {
  it('swaps brackets in place', () => {
    const out = serialize(setNodeShape(model(), 'A', 'circle'));
    expect(out).toContain('A((Start)) --> B{Choice}');
  });
});

describe('addNode / addEdge / newNodeId', () => {
  it('appends definition and edge lines', () => {
    const { model: m2, id } = addNode(model(), 'Fresh');
    expect(id).toBe('n1');
    const out = serialize(addEdge(m2, 'C', id));
    expect(out.endsWith('  n1[Fresh]\n  C --> n1')).toBe(true);
  });

  it('never reuses an existing id', () => {
    const m = parseFlowchart('flowchart TD\n  n1[X] --> n3[Y]')!;
    expect(newNodeId(m)).toBe('n2');
  });
});

describe('deleteEdge', () => {
  it('removes one edge from a group without touching the rest', () => {
    const m = parseFlowchart('flowchart TD\n  A & B --> C\n  C --> D')!;
    const target = edges(m).find((e) => e.from === 'A' && e.to === 'C')!;
    const out = serialize(deleteEdge(m, target));
    expect(out).toContain('B --> C');
    expect(out).not.toMatch(/A\s*&/);
    expect(out).toContain('C --> D');
  });
});

describe('deleteNode', () => {
  it('removes its definition and every edge that touches it', () => {
    const out = serialize(deleteNode(model(), 'B'));
    expect(out).not.toContain('{Choice}');
    expect(out).not.toContain('-->|yes|');
    expect(out).toContain('flowchart TD');
    expect(out).toContain('classDef hot fill:#f96'); // opaque survives
  });

  it('splits a chain and preserves surviving segments with their labels', () => {
    const m = parseFlowchart('flowchart TD\n  G[One] --> H[Two] --> I[Three]')!;
    const out = serialize(deleteNode(m, 'H'));
    expect(out).not.toContain('Two');
    // G and I keep their labels even though their only label sites were on the chain line.
    expect(out).toContain('G[One]');
    expect(out).toContain('I[Three]');
  });

  it('never touches lines the deleted node does not appear on', () => {
    const chain = '  G[One] --> H[Two] --> I[Three]';
    const group = '  A & B --> C';
    const spaced = '  X   -->   Y';
    const src = ['flowchart TD', '  Q[Iso]', chain, group, spaced].join('\n');
    const out = serialize(deleteNode(parseFlowchart(src)!, 'Q'));
    const outLines = out.split('\n');
    expect(outLines).toEqual(['flowchart TD', chain, group, spaced]);
  });
});

describe('setEdgeLabel', () => {
  it('sets, changes, and clears a segment label', () => {
    const m = parseFlowchart('flowchart TD\n  A --> B')!;
    const out = serialize(setEdgeLabel(m, edges(m)[0], 'go'));
    expect(out).toContain('A -->|go| B');
    const m2 = parseFlowchart(out)!;
    const cleared = serialize(setEdgeLabel(m2, edges(m2)[0], null));
    expect(cleared).toContain('A --> B');
    expect(cleared).not.toContain('|');
  });

  it('sanitizes a literal pipe so the edge stays parseable', () => {
    const m = parseFlowchart('flowchart TD\n  A --> B')!;
    const out = serialize(setEdgeLabel(m, edges(m)[0], 'a|b'));
    const reparsed = parseFlowchart(out)!;
    const es = edges(reparsed);
    expect(es).toHaveLength(1);
    expect(es[0].label).toBe('a/b');
    expect(reparsed.lines.every((l) => l.parsed.kind !== 'opaque')).toBe(true);
  });
});

describe('setDirection', () => {
  it('rewrites only the header', () => {
    const out = serialize(setDirection(model(), 'LR'));
    expect(out.startsWith('flowchart LR\n')).toBe(true);
  });
});

describe('setLayoutEngine', () => {
  it('adds frontmatter when none exists', () => {
    const out = serialize(setLayoutEngine(model(), 'elk'));
    expect(out.startsWith('---\nconfig:\n  layout: elk\n---\nflowchart TD')).toBe(true);
  });

  it('updates an existing layout line and removes it for dagre', () => {
    const src = '---\nconfig:\n  layout: elk\n---\nflowchart TD\n  A --> B';
    const toDagre = serialize(setLayoutEngine(parseFlowchart(src)!, 'dagre'));
    expect(toDagre).not.toContain('layout:');
    const back = serialize(setLayoutEngine(parseFlowchart(toDagre)!, 'elk'));
    expect(back).toContain('  layout: elk');
  });
});

describe('surgical property', () => {
  it('after any op, untouched lines are byte-identical', () => {
    const before = SRC.split('\n');
    const after = serialize(renameNode(model(), 'C', 'Shipped')).split('\n');
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[1]);
    expect(after[3]).toBe(before[3]);
    expect(after[4]).toBe(before[4]);
  });
});

describe('renameNode and node-meta (M29.29)', () => {
  it('renames through the meta label when one exists — a bracket edit would render stale', () => {
    const m = parseFlowchart('flowchart TD\n  A[Old] --> B\n  A@{ shape: cloud, label: Older }')!;
    const out = serialize(renameNode(m, 'A', 'New'));
    expect(out).toContain('A@{ shape: cloud, label: New }');
    expect(out).toContain('A[Old] --> B'); // the bracket site is untouched
  });

  it('a meta line without a label key still renames through brackets', () => {
    const m = parseFlowchart('flowchart TD\n  A[Old] --> B\n  A@{ shape: cloud }')!;
    const out = serialize(renameNode(m, 'A', 'New'));
    expect(out).toContain('A[New] --> B');
    expect(out).toContain('A@{ shape: cloud }');
  });

  it('a rename introducing } or ^ writes a line our own parser still owns', () => {
    for (const [label, expected] of [
      ['a}b', 'A@{ shape: cloud, label: "a}b" }'],
      ['a^b', 'A@{ shape: cloud, label: "a^b" }'],
    ]) {
      const m = parseFlowchart('flowchart TD\n  A[Old] --> B\n  A@{ shape: cloud, label: Older }')!;
      const out = serialize(renameNode(m, 'A', label));
      expect(out).toContain(expected);
      // The character survives AND the line stays structurally editable.
      const again = parseFlowchart(out)!;
      expect(again.lines[2].parsed.kind).toBe('node-meta');
      expect(nodeMeta(again).get('A')?.label).toBe(label);
    }
  });

  it('deleteNode removes the meta line that declares the node', () => {
    const m = parseFlowchart('flowchart TD\n  A[Start] --> B\n  A@{ shape: cloud, label: Older }')!;
    const out = deleteNode(m, 'A');
    // Left behind, the meta line would keep declaring — and rendering — A.
    expect(serialize(out)).not.toContain('A@{');
    expect(nodes(out).has('A')).toBe(false);
  });

  it('deleteNode removes the style line that would resurrect the node', () => {
    // Measured: `flowchart TD\n  style A fill:#f96` renders ONE node, A, in
    // orange — the node the user just deleted, back as an unlabeled box.
    const src = 'flowchart TD\n  A[Start] --> B\n  style A fill:#f96\n  style B fill:#0f0';
    // B's own style line is left strictly alone — only A's is swept.
    expect(serialize(deleteNode(parseFlowchart(src)!, 'A'))).toBe(
      'flowchart TD\n  style B fill:#0f0',
    );
  });
});

describe('setNodeStyle (M29.30)', () => {
  const STYLED = [
    'flowchart TD',
    '  A[Start] --> B{Choice}',
    '  style A fill:#f96,stroke:#333,stroke-width:2px',
  ].join('\n');

  it('patches named declarations surgically, unknown ones kept in order', () => {
    const m = parseFlowchart(STYLED)!;
    const out = serialize(setNodeStyle(m, 'A', { fill: '#eef1fe', color: '#3d5bde' }));
    expect(out).toContain('style A fill:#eef1fe,stroke:#333,stroke-width:2px,color:#3d5bde');
    expect(out).toContain('A[Start] --> B{Choice}'); // nothing else moved
  });

  it('creates the line right after the node when absent', () => {
    const m = parseFlowchart('flowchart TD\n  A[Start] --> B\n  B --> C')!;
    const out = serialize(setNodeStyle(m, 'A', { fill: '#f96' }));
    expect(out).toBe('flowchart TD\n  A[Start] --> B\n  style A fill:#f96\n  B --> C');
  });

  it('removing the last declaration deletes the line', () => {
    const m = parseFlowchart('flowchart TD\n  A --> B\n  style A fill:#f96')!;
    expect(serialize(setNodeStyle(m, 'A', { fill: null }))).toBe('flowchart TD\n  A --> B');
  });

  it('never styles an id the diagram does not declare — upstream would auto-create it', () => {
    const m = parseFlowchart('flowchart TD\n  A --> B')!;
    expect(serialize(setNodeStyle(m, 'Ghost', { fill: '#f96' }))).toBe('flowchart TD\n  A --> B');
  });

  it('a patch of only-nulls on a styleless node changes nothing', () => {
    const m = parseFlowchart('flowchart TD\n  A --> B')!;
    expect(serialize(setNodeStyle(m, 'A', { fill: null }))).toBe('flowchart TD\n  A --> B');
  });

  it('leaves every other line byte-identical, opaque ones included', () => {
    const src = [
      '---',
      'config:',
      '  layout: elk',
      '---',
      'flowchart TD',
      '  %% keep me',
      '  A[Start] --> B{Choice}',
      '  classDef hot fill:#f96',
      '  linkStyle 0 stroke:#f00',
      '  style A fill: #f96 , stroke:#333',
      '  click A "https://x"',
    ].join('\n');
    const out = serialize(setNodeStyle(parseFlowchart(src)!, 'A', { fill: '#eee' }));
    const before = src.split('\n');
    const after = out.split('\n');
    expect(after.length).toBe(before.length);
    after.forEach((line, i) => {
      if (i === 9) return;
      expect([i, line]).toEqual([i, before[i]]);
    });
    expect(after[9]).toBe('  style A fill:#eee,stroke:#333');
  });

  it('a written style line is one our own parser reads back', () => {
    const m = parseFlowchart('flowchart TD\n  A --> B')!;
    const once = serialize(setNodeStyle(m, 'A', { fill: '#f96', 'stroke-width': '2px' }));
    const again = parseFlowchart(once)!;
    expect(again.lines[2].parsed.kind).toBe('style');
    expect(nodeStyle(again, 'A')).toEqual({ fill: '#f96', 'stroke-width': '2px' });
    again.lines[2].dirty = true;
    expect(serialize(again)).toBe(once);
  });

  // Several style lines for one id: mermaid lets the LAST value for a key win
  // (measured — see nodeStyle). Writing to the first line renders nothing.
  describe('lands on the declaration that actually renders', () => {
    const TWO = [
      'flowchart TD',
      '  A --> B',
      '  style A fill:#f96,stroke:red',
      '  style A fill:#000',
    ].join('\n');

    it('sets on the LAST line that already declares the key', () => {
      const out = serialize(setNodeStyle(parseFlowchart(TWO)!, 'A', { fill: '#abcdef' }));
      expect(out.split('\n')).toEqual([
        'flowchart TD',
        '  A --> B',
        '  style A fill:#f96,stroke:red', // untouched — shadowed anyway
        '  style A fill:#abcdef',
      ]);
      expect(nodeStyle(parseFlowchart(out)!, 'A')).toEqual({ fill: '#abcdef', stroke: 'red' });
    });

    it('appends a brand-new key to the LAST style line', () => {
      const out = serialize(setNodeStyle(parseFlowchart(TWO)!, 'A', { color: '#111' }));
      expect(out.split('\n')[2]).toBe('  style A fill:#f96,stroke:red');
      expect(out.split('\n')[3]).toBe('  style A fill:#000,color:#111');
    });

    it('removes the key from EVERY line, deleting the ones that empty', () => {
      const out = serialize(setNodeStyle(parseFlowchart(TWO)!, 'A', { fill: null }));
      expect(out).toBe('flowchart TD\n  A --> B\n  style A stroke:red');
      expect(nodeStyle(parseFlowchart(out)!, 'A')).toEqual({ stroke: 'red' });
    });

    it('leaves lines that do not carry the key completely alone', () => {
      const src = [
        'flowchart TD',
        '  A --> B',
        '  style A stroke:  red',
        '  style A fill:#000',
        '  style B fill:#0f0',
      ].join('\n');
      const out = serialize(setNodeStyle(parseFlowchart(src)!, 'A', { fill: '#abcdef' }));
      const lines = out.split('\n');
      expect(lines[2]).toBe('  style A stroke:  red'); // quirky spacing survives
      expect(lines[3]).toBe('  style A fill:#abcdef');
      expect(lines[4]).toBe('  style B fill:#0f0');
    });
  });

  // The last boundary before the file: nothing a caller passes may emit a line
  // this module cannot read back, or that mermaid cannot parse.
  it('refuses patch entries it could not read back', () => {
    const m = parseFlowchart('flowchart TD\n  A --> B')!;
    const patches: Record<string, string | null>[] = [
      { fill: 'rgb(1,2,3)' }, // `(` pushes the text lexer state — parse error
      { fill: 'var(--brand)' },
      { fill: '#f96,stroke:#000' }, // declaration injection out of one key
      { 'fill;x': '#f96' },
      { fill: '' },
      { fill: 'a"b' },
    ];
    for (const patch of patches) {
      expect([patch, serialize(setNodeStyle(m, 'A', patch))]).toEqual([
        patch,
        'flowchart TD\n  A --> B',
      ]);
    }
  });

  it('normalizes what it does accept, and keeps the good half of a mixed patch', () => {
    const m = parseFlowchart('flowchart TD\n  A --> B')!;
    const out = serialize(setNodeStyle(m, 'A', { ' fill ': ' #f96 ', stroke: 'rgb(0,0,0)' }));
    expect(out).toBe('flowchart TD\n  A --> B\n  style A fill:#f96');
  });
});

describe('setEdgeArrow (M29.31)', () => {
  it('rewrites only its segment; line-mates stay byte-true', () => {
    const m = parseFlowchart('flowchart TD\n  A -->|go| B o==o C')!;
    const target = edges(m).find((e) => e.from === 'A')!;
    expect(serialize(setEdgeArrow(m, target, { head: 'circle' }))).toBe(
      'flowchart TD\n  A --o|go| B o==o C',
    );
  });

  it('normalizes length on rewrite and keeps the o/x family on stroke-only changes', () => {
    const m = parseFlowchart('flowchart TD\n  A ----> B\n  C o--o D')!;
    const e = edges(m);
    expect(serialize(setEdgeArrow(m, e[0], { head: 'cross' }))).toContain('A --x B');
    expect(serialize(setEdgeArrow(m, e[1], { stroke: 'thick' }))).toContain('C o==o D');
  });

  it('double from a single-ended edge writes <…>; invisible drops the label', () => {
    const m = parseFlowchart('flowchart TD\n  C -->|go| D')!;
    const e = edges(m);
    expect(serialize(setEdgeArrow(m, e[0], { head: 'double' }))).toContain('C <-->|go| D');
    expect(serialize(setEdgeArrow(m, e[0], { stroke: 'invisible' }))).toContain('C ~~~ D');
  });

  it('picking a head on an invisible edge lands back on a normal stroke', () => {
    const m = parseFlowchart('flowchart TD\n  A ~~~ B')!;
    expect(serialize(setEdgeArrow(m, edges(m)[0], { head: 'arrow' }))).toContain('A --> B');
  });
});

describe('setEdgeAnimate (M29.31)', () => {
  it('mints an id, writes it into the edge line, and appends the meta line', () => {
    const m = parseFlowchart('flowchart TD\n  A[Start] --> B')!;
    expect(serialize(setEdgeAnimate(m, edges(m)[0], true))).toBe(
      'flowchart TD\n  A[Start] e1@--> B\n  e1@{ animate: true }',
    );
  });

  it('reuses an existing id and patches an existing meta line', () => {
    const m = parseFlowchart('flowchart TD\n  A e7@--> B\n  e7@{ curve: linear }')!;
    const out = serialize(setEdgeAnimate(m, edges(m)[0], true));
    expect(out).toContain('A e7@--> B');
    expect(out).toContain('e7@{ curve: linear, animate: true }');
  });

  it('off removes the entry, deletes an emptied line, and keeps the id', () => {
    const m = parseFlowchart('flowchart TD\n  A e1@--> B\n  e1@{ animate: true }')!;
    expect(serialize(setEdgeAnimate(m, edges(m)[0], false))).toBe('flowchart TD\n  A e1@--> B');
  });

  it('off leaves a meta line with other keys in place', () => {
    const m = parseFlowchart('flowchart TD\n  A e1@--> B\n  e1@{ animate: true, curve: basis }')!;
    const out = serialize(setEdgeAnimate(m, edges(m)[0], false));
    expect(out).toContain('e1@{ curve: basis }');
  });

  it('newEdgeId skips node and edge ids alike', () => {
    const m = parseFlowchart('flowchart TD\n  e1[X] e2@--> Y')!;
    expect(newEdgeId(m)).toBe('e3');
  });
});

describe('the last boundary on edge lines (M29.31)', () => {
  it('an empty label is no label, never `-->||`', () => {
    // Measured: `A -->|| B` is a parse error upstream (`arrowText` needs a
    // token), so emitting one would kill the whole diagram from a caller that
    // merely cleared the box.
    const m = parseFlowchart('flowchart TD\n  A -->|go| B')!;
    const out = serialize(setEdgeLabel(m, edges(m)[0], ''));
    expect(out).toBe('flowchart TD\n  A --> B');
    expect(parseFlowchart(out)!.lines[1].parsed.kind).toBe('edges');
  });

  it('a rename to a label carrying @ writes a line mermaid still parses', () => {
    // `A[a@b]` is a parse error (measured, char by char against 11.16.0);
    // `A["a@b"]` is fine. `@` was the one hole in quoteLabel's set.
    const m = parseFlowchart('flowchart TD\n  A[Old] --> B')!;
    const out = serialize(renameNode(m, 'A', 'ops@example.com'));
    expect(out).toBe('flowchart TD\n  A["ops@example.com"] --> B');
    expect(nodes(parseFlowchart(out)!).get('A')?.label).toBe('ops@example.com');
  });

  it('setEdgeArrow leaves the segment id and every line-mate alone', () => {
    const m = parseFlowchart('flowchart TD\n  A e1@-->|go| B e2@--> C\n  X ----> Y')!;
    const out = serialize(setEdgeArrow(m, edges(m)[0], { stroke: 'dotted' }));
    expect(out).toBe('flowchart TD\n  A e1@-.->|go| B e2@--> C\n  X ----> Y');
  });

  it('every arrow the picker can produce reads back as itself', () => {
    const m = parseFlowchart('flowchart TD\n  A o--o B')!;
    for (const stroke of ['normal', 'thick', 'dotted', 'invisible'] as const) {
      for (const head of ['arrow', 'open', 'circle', 'cross', 'double'] as const) {
        const out = serialize(setEdgeArrow(m, edges(m)[0], { stroke, head }));
        const again = parseFlowchart(out)!;
        expect([stroke, head, again.lines[1].parsed.kind]).toEqual([stroke, head, 'edges']);
        const got = edges(again)[0].arrow;
        expect([stroke, head, got.stroke]).toEqual([stroke, head, stroke]);
        expect([stroke, head, got.head]).toEqual([
          stroke,
          head,
          stroke === 'invisible' ? 'open' : head,
        ]);
      }
    }
  });
});

describe('setEdgeAnimate placement and targeting (M29.31)', () => {
  it('writes the meta line BELOW the edge, where mermaid can find it', () => {
    // Above the edge the id resolves against no edge at all and mermaid mints
    // a vertex instead (measured) — the toggle would silently do nothing and
    // add a stray box.
    const m = parseFlowchart('flowchart TD\n  A --> B\n  B --> C')!;
    const out = serialize(setEdgeAnimate(m, edges(m)[1], true));
    expect(out).toBe('flowchart TD\n  A --> B\n  B e1@--> C\n  e1@{ animate: true }');
    const again = parseFlowchart(out)!;
    expect(edgeAnimated(again, edges(again)[1])).toBe(true);
  });

  it('sets on the LAST meta line that declares animate, like setNodeStyle', () => {
    // Several `e1@{ … }` lines may name one edge and the last value for a key
    // wins (measured: `animate: true` then `animate: false` renders
    // unanimated), so patching the first would be a silent no-op.
    const src = [
      'flowchart TD',
      '  A e1@--> B',
      '  e1@{ animate: true }',
      '  e1@{ curve: basis }',
      '  e1@{ animate: false }',
    ].join('\n');
    const m = parseFlowchart(src)!;
    const out = serialize(setEdgeAnimate(m, edges(m)[0], true));
    expect(out.split('\n')[2]).toBe('  e1@{ animate: true }'); // shadowed, untouched
    expect(out.split('\n')[4]).toBe('  e1@{ animate: true }');
    const again = parseFlowchart(out)!;
    expect(edgeAnimated(again, edges(again)[0])).toBe(true);
  });

  it('off strips animate from EVERY line, deleting the ones it empties', () => {
    const src = [
      'flowchart TD',
      '  A e1@--> B',
      '  e1@{ animate: true }',
      '  e1@{ curve: basis, animate: true }',
    ].join('\n');
    const out = serialize(
      setEdgeAnimate(parseFlowchart(src)!, edges(parseFlowchart(src)!)[0], false),
    );
    expect(out).toBe('flowchart TD\n  A e1@--> B\n  e1@{ curve: basis }');
  });

  it('an indented edge keeps its indentation on the meta line it grows', () => {
    const m = parseFlowchart('flowchart TD\n  subgraph S\n    A --> B\n  end')!;
    const out = serialize(setEdgeAnimate(m, edges(m)[0], true));
    expect(out).toBe('flowchart TD\n  subgraph S\n    A e1@--> B\n    e1@{ animate: true }\n  end');
  });

  it('a fan-out edge that cannot own the segment id is a no-op, not a sibling edit', () => {
    // `A e1@--> B & C`: upstream gives e1 to A→B only, so animating A→C has
    // nowhere to be written. Writing anyway would animate A→B — an edit the
    // caller never asked for, on an edge it never named.
    const src = 'flowchart TD\n  A e1@--> B & C\n  e1@{ animate: true }';
    const m = parseFlowchart(src)!;
    const other = edges(m).find((e) => e.to === 'C')!;
    expect(other.id).toBeNull();
    expect(serialize(setEdgeAnimate(m, other, true))).toBe(src);
    expect(serialize(setEdgeAnimate(m, other, false))).toBe(src);
    expect(edgeAnimated(m, other)).toBe(false);

    // The edge that DOES own it still toggles.
    const owner = edges(m).find((e) => e.to === 'B')!;
    expect(serialize(setEdgeAnimate(m, owner, false))).toBe('flowchart TD\n  A e1@--> B & C');

    // And an id-less group behaves the same way.
    const bare = parseFlowchart('flowchart TD\n  A --> B & C')!;
    const bareOther = edges(bare).find((e) => e.to === 'C')!;
    expect(serialize(setEdgeAnimate(bare, bareOther, true))).toBe('flowchart TD\n  A --> B & C');
  });

  it('newEdgeId walks past node ids, edge ids, and meta ids alike', () => {
    const m = parseFlowchart('flowchart TD\n  e1[X] e2@--> Y\n  e3@{ shape: cyl }')!;
    expect(newEdgeId(m)).toBe('e4');
  });

  it('deleteNode splits a chain and keeps the surviving segment editable', () => {
    const m = parseFlowchart('flowchart TD\n  A e1@--> B e2@--o C\n  e2@{ animate: true }')!;
    const out = serialize(deleteNode(m, 'A'));
    expect(out).toBe('flowchart TD\n  B e2@--o C\n  e2@{ animate: true }');
    const again = parseFlowchart(out)!;
    expect(edgeAnimated(again, edges(again)[0])).toBe(true);
  });
});

describe('deleting an edge sweeps the meta it orphans (M29.31)', () => {
  // An unclaimed `e1@{ … }` is not inert: with no edge to name, mermaid falls
  // through to addVertex (flowDb.ts:163-176) and DRAWS A NODE. Measured —
  // deleting B→C below left `V[A, B, e1]`, a stray box where the edge was.
  const SRC = 'flowchart TD\n  A --> B\n  B e1@--> C\n  e1@{ animate: true }';

  it('deleteEdge removes the companion with the edge', () => {
    const m = parseFlowchart(SRC)!;
    const target = edges(m).find((e) => e.to === 'C')!;
    expect(serialize(deleteEdge(m, target))).toBe('flowchart TD\n  A --> B');
  });

  it('deleteNode removes it too, from either end of the edge', () => {
    expect(serialize(deleteNode(parseFlowchart(SRC)!, 'C'))).toBe('flowchart TD\n  A --> B');
    expect(serialize(deleteNode(parseFlowchart(SRC)!, 'B'))).toBe('flowchart TD');
  });

  it('a companion whose id survives on a rebuilt line is left alone', () => {
    // The id rides the first survivor, so the meta still names a real edge.
    const grp = 'flowchart TD\n  A e1@--> B & C\n  e1@{ animate: true }';
    const m = parseFlowchart(grp)!;
    const out = serialize(
      deleteEdge(
        m,
        edges(m).find((e) => e.to === 'B')!,
      ),
    );
    expect(out).toBe('flowchart TD\n  A e1@--> C\n  e1@{ animate: true }');
    const again = parseFlowchart(out)!;
    expect(edgeAnimated(again, edges(again)[0])).toBe(true);
  });

  it('a companion another edge line still declares is left alone', () => {
    // Mermaid gives a duplicate id to the FIRST edge that claims it, so
    // deleting ours just promotes the other one — the meta stays live.
    const dup = ['flowchart TD', '  A e1@--> B', '  X e1@--> Y', '  e1@{ animate: true }'].join(
      '\n',
    );
    const m = parseFlowchart(dup)!;
    const out = serialize(
      deleteEdge(
        m,
        edges(m).find((e) => e.to === 'B')!,
      ),
    );
    expect(out).toBe('flowchart TD\n  X e1@--> Y\n  e1@{ animate: true }');
  });

  it('an unrelated node meta line is never swept', () => {
    const src = 'flowchart TD\n  A --> B\n  B e1@--> C\n  A@{ shape: cyl }';
    const m = parseFlowchart(src)!;
    const out = serialize(
      deleteEdge(
        m,
        edges(m).find((e) => e.to === 'C')!,
      ),
    );
    expect(out).toBe('flowchart TD\n  A --> B\n  A@{ shape: cyl }');
  });
});

describe('setEdgeLabel writes a label mermaid can lex (M29.31)', () => {
  it('quotes the characters that would otherwise kill the diagram', () => {
    // Measured: bare `(`, `@`, `[`, `{`, `"` in an edge label are all parse
    // errors — a user typing "Deploy (prod)" blanked the whole render.
    for (const [label, expected] of [
      ['Deploy (prod)', '  B --x|"Deploy (prod)"| C'],
      ['a@b', '  B --x|"a@b"| C'],
      ['a[b]', '  B --x|"a[b]"| C'],
      ['ok', '  B --x|ok| C'],
      ['a"b', `  B --x|"a'b"| C`],
    ]) {
      const m = parseFlowchart('flowchart TD\n  B --x C')!;
      const out = serialize(setEdgeLabel(m, edges(m)[0], label));
      expect([label, out.split('\n')[1]]).toEqual([label, expected]);
      // And the line stays ours, with the value intact.
      const again = parseFlowchart(out)!;
      expect([label, again.lines[1].parsed.kind]).toEqual([label, 'edges']);
      expect([label, edges(again)[0].label]).toEqual([label, label.replaceAll('"', "'")]);
    }
  });

  it('the pipe is still substituted, not quoted — the Stage-C scar stands', () => {
    const m = parseFlowchart('flowchart TD\n  A --> B')!;
    const out = serialize(setEdgeLabel(m, edges(m)[0], 'a|b'));
    expect(out).toBe('flowchart TD\n  A -->|a/b| B');
  });
});

describe('setNodeShape — registry shapes (M29.32, D4)', () => {
  it('classic 8 without a meta line still rewrites brackets (Stage C behavior)', () => {
    const out = serialize(setNodeShape(model(), 'A', 'circle'));
    expect(out).toContain('A((Start)) --> B{Choice}');
  });

  it('an exotic shape writes a meta line after the node, brackets untouched', () => {
    const out = serialize(setNodeShape(model(), 'A', 'cloud'));
    expect(out).toContain('A[Start] --> B{Choice}');
    expect(out.split('\n')[2]).toBe('  A@{ shape: cloud }');
  });

  it('a classic-8 pick PATCHES the meta when a meta line exists', () => {
    const m = parseFlowchart('flowchart TD\n  A[Start] --> B\n  A@{ shape: cloud }')!;
    const out = serialize(setNodeShape(m, 'A', 'diamond'));
    expect(out).toContain('A@{ shape: diam }');
    expect(out).toContain('A[Start] --> B');
  });

  it('registry aliases resolve to brackets where possible', () => {
    const out = serialize(setNodeShape(model(), 'A', 'database'));
    expect(out).toContain('A[(Start)] --> B{Choice}');
  });

  it('a name outside the registry is refused — mermaid would throw at render', () => {
    expect(serialize(setNodeShape(model(), 'A', 'blob'))).toBe(SRC);
  });

  // The E1/E2 reviews found this and scheduled the fix here: with a meta shape
  // in play, rewriting brackets was a SILENT NO-OP, because meta wins at
  // render. `A@{ shape: cloud }` + "make it a circle" used to emit
  // `A((Start))` and go on rendering a cloud.
  it('is no longer inert on a meta-shaped node — the M29.29/.30 gap', () => {
    const m = parseFlowchart('flowchart TD\n  A[Start] --> B\n  A@{ shape: cloud }')!;
    const out = serialize(setNodeShape(m, 'A', 'circle'));
    expect(out).toBe('flowchart TD\n  A[Start] --> B\n  A@{ shape: circle }');
    expect(nodes(parseFlowchart(out)!).get('A')?.metaShape).toBe('circle');
  });

  it('unknown meta keys survive, in order, around the shape it patches', () => {
    const m = parseFlowchart('flowchart TD\n  A --> B\n  A@{ pos: t, shape: cyl, w: 40 }')!;
    const out = serialize(setNodeShape(m, 'A', 'hex'));
    expect(out.split('\n')[2]).toBe('  A@{ pos: t, shape: hex, w: 40 }');
  });

  it('a wrong-case name is refused — mermaid throws "should be lowercase"', () => {
    expect(serialize(setNodeShape(model(), 'A', 'Circle'))).toBe(SRC);
    expect(serialize(setNodeShape(model(), 'A', 'DIAM'))).toBe(SRC);
  });

  it('ellipse is refused — broken upstream, and not in the registry at all', () => {
    expect(serialize(setNodeShape(model(), 'A', 'ellipse'))).toBe(SRC);
  });

  it('an Object.prototype key is refused, not treated as a shape', () => {
    for (const odd of ['toString', 'constructor', 'hasOwnProperty']) {
      expect(serialize(setNodeShape(model(), 'A', odd))).toBe(SRC);
    }
  });

  it('an id the diagram does not declare is a no-op — never a phantom node', () => {
    expect(serialize(setNodeShape(model(), 'ZZZ', 'cloud'))).toBe(SRC);
    expect(serialize(setNodeShape(model(), 'ZZZ', 'circle'))).toBe(SRC);
  });

  it('the shape lands on the LAST meta line declaring it, the one that renders', () => {
    const m = parseFlowchart('flowchart TD\n  A --> B\n  A@{ shape: cloud }\n  A@{ shape: hex }')!;
    const out = serialize(setNodeShape(m, 'A', 'cyl'));
    // Writing to the FIRST line would leave `shape: hex` still winning — the
    // silent no-op M29.30 found for `style` lines, in its meta twin.
    expect(out).toBe('flowchart TD\n  A --> B\n  A@{ shape: cloud }\n  A@{ shape: cyl }');
    expect(nodes(parseFlowchart(out)!).get('A')?.metaShape).toBe('cyl');
  });

  it('with no shape key anywhere, the LAST meta line takes it', () => {
    const m = parseFlowchart('flowchart TD\n  A --> B\n  A@{ label: X }\n  A@{ pos: t }')!;
    const out = serialize(setNodeShape(m, 'A', 'cloud'));
    expect(out).toBe('flowchart TD\n  A --> B\n  A@{ label: X }\n  A@{ pos: t, shape: cloud }');
  });

  it('an id an edge also declares is refused on the meta path — position would decide', () => {
    // The meta line would land BELOW the edge that declares id `A`, and
    // mermaid resolves an `@{ }` id against the edges parsed so far
    // (flowDb.ts:163) — so the shape would be read as EDGE meta and silently
    // dropped. Refusing keeps the write honest; the bytes survive.
    const src = 'flowchart TD\n  X A@--> B\n  A --> C';
    const m = parseFlowchart(src)!;
    expect(serialize(setNodeShape(m, 'A', 'cloud'))).toBe(src);
  });

  it('writes the canonical short name, never the alias it was handed', () => {
    const m = parseFlowchart('flowchart TD\n  A --> B\n  A@{ shape: cloud }')!;
    for (const [alias, canonical] of [
      ['database', 'cyl'],
      ['cylinder', 'cyl'],
      ['doublecircle', 'dbl-circ'],
      ['paper-tape', 'flag'],
      ['question', 'diam'],
    ]) {
      expect([alias, serialize(setNodeShape(m, 'A', alias)).split('\n')[2]]).toEqual([
        alias,
        `  A@{ shape: ${canonical} }`,
      ]);
    }
  });

  it('a bare node gains brackets for a classic 8, a meta line for the rest', () => {
    const bare = parseFlowchart('flowchart TD\n  A --> B')!;
    const withBrackets = serialize(setNodeShape(bare, 'A', 'hexagon'));
    expect(withBrackets).toContain('A{{A}}');
    expect(withBrackets).toContain('A --> B');
    expect(serialize(setNodeShape(bare, 'A', 'cloud'))).toBe(
      'flowchart TD\n  A --> B\n  A@{ shape: cloud }',
    );
  });
});
