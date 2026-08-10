import { describe, expect, it } from 'vitest';
import {
  edgeAnimated,
  edges,
  nodeLinks,
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
  setNodeIcon,
  setNodeLink,
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

  // The M29.32 review measured this: the block form is opaque, so
  // nodeMeta() cannot see it while nodes() still reports A — and the
  // brackets-first path invented `A((A))` while mermaid went on rendering the
  // cloud the block declares. The inert-shape defect, in the one shape the
  // parser declines.
  it('an opaque multi-line @{ block is refused, not silently out-voted', () => {
    const src = 'flowchart TD\n  A --> B\n  A@{\n    shape: cloud\n  }';
    const m = parseFlowchart(src)!;
    expect(m.lines.map((l) => l.parsed.kind)).toEqual([
      'header',
      'edges',
      'opaque',
      'opaque',
      'opaque',
    ]);
    for (const shape of ['circle', 'hexagon', 'cloud', 'cyl', 'rect']) {
      // No invented definition line, no second meta line, no bytes at all.
      expect([shape, serialize(setNodeShape(m, 'A', shape))]).toEqual([shape, src]);
    }
  });

  it('a node with no opaque block of its OWN still edits normally', () => {
    // The refusal keys on the id, not on "some block exists somewhere".
    const m = parseFlowchart('flowchart TD\n  A --> B\n  B@{\n    shape: cloud\n  }')!;
    expect(serialize(setNodeShape(m, 'A', 'cloud'))).toBe(
      'flowchart TD\n  A --> B\n  A@{ shape: cloud }\n  B@{\n    shape: cloud\n  }',
    );
  });

  it('picking the shape a node already has is a true no-op', () => {
    // An alias spelling reads as pressed in the palette, so re-picking it must
    // not rewrite `database` to `cyl` — changed bytes, an undo entry, and
    // nothing moved on screen.
    for (const [src, pick] of [
      ['flowchart TD\n  A --> B\n  A@{ shape: database }', 'cyl'],
      ['flowchart TD\n  A --> B\n  A@{ shape: database }', 'database'],
      ['flowchart TD\n  A --> B\n  A@{ shape: cyl }', 'cyl'],
      ['flowchart TD\n  A --> B\n  A@{ shape: doublecircle }', 'dbl-circ'],
    ]) {
      expect([src, pick, serialize(setNodeShape(parseFlowchart(src)!, 'A', pick))]).toEqual([
        src,
        pick,
        src,
      ]);
    }
  });

  it('a DIFFERENT shape still rewrites the alias-spelled meta', () => {
    const m = parseFlowchart('flowchart TD\n  A --> B\n  A@{ shape: database }')!;
    expect(serialize(setNodeShape(m, 'A', 'hex'))).toBe(
      'flowchart TD\n  A --> B\n  A@{ shape: hex }',
    );
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

describe('setNodeIcon', () => {
  it('writes a full meta line for a node that has none', () => {
    const m = parseFlowchart('flowchart TD\n  A[Start] --> B')!;
    const out = serialize(setNodeIcon(m, 'A', 'lucide:rocket'));
    expect(out).toContain('A@{ icon: "lucide:rocket", form: rounded, pos: b }');
    // Untouched lines stay byte-identical.
    expect(out.split('\n')[0]).toBe('flowchart TD');
    expect(out).toContain('  A[Start] --> B');
  });

  it('patches an existing meta line, preserving other keys and their order', () => {
    const m = parseFlowchart('flowchart TD\n  A[Start]\n  A@{ shape: hexagon }')!;
    const out = serialize(setNodeIcon(m, 'A', 'lucide:zap'));
    // shape came first in the source, so shape still comes first.
    expect(out).toContain('A@{ shape: hexagon, icon: "lucide:zap", form: rounded, pos: b }');
  });

  it('does not clobber an explicit form/pos the user already chose', () => {
    const m = parseFlowchart('flowchart TD\n  A@{ icon: "lucide:zap", form: circle, pos: t }')!;
    const out = serialize(setNodeIcon(m, 'A', 'lucide:rocket'));
    expect(out).toContain('form: circle');
    expect(out).toContain('pos: t');
    expect(out).toContain('icon: "lucide:rocket"');
  });

  it('null removes icon, form, and pos — and deletes the line when that empties it', () => {
    const m = parseFlowchart(
      'flowchart TD\n  A[Start]\n  A@{ icon: "lucide:zap", form: rounded, pos: b }',
    )!;
    const out = serialize(setNodeIcon(m, 'A', null));
    expect(out).toBe('flowchart TD\n  A[Start]');
  });

  it('null keeps a meta line that still carries other keys', () => {
    const m = parseFlowchart('flowchart TD\n  A@{ shape: hexagon, icon: "lucide:zap" }')!;
    const out = serialize(setNodeIcon(m, 'A', null));
    expect(out).toContain('A@{ shape: hexagon }');
    expect(out).not.toContain('icon');
  });

  // REGRESSION (M29.35 review): a `node-meta` line DECLARES its node, unlike
  // the `style`/`animate` companions this splice rule was borrowed from — so
  // clearing the icon off mermaid's own documented icon-node form deleted the
  // node. The exact input below is what a user pastes in from mermaid's docs.
  it('clearing the icon off a node whose ONLY line is that meta line keeps the node', () => {
    const src = 'flowchart TD\n  A@{ icon: "lucide:rocket", form: rounded, pos: b }';
    const out = serialize(setNodeIcon(parseFlowchart(src)!, 'A', null));
    expect(out).toBe('flowchart TD\n  A');
    expect([...nodes(parseFlowchart(out)!).keys()]).toEqual(['A']);
  });

  it('the rescued declaration keeps its indent, inside a subgraph too', () => {
    const src = 'flowchart TD\n  subgraph S\n    A@{ icon: "lucide:zap" }\n  end';
    expect(serialize(setNodeIcon(parseFlowchart(src)!, 'A', null))).toBe(
      'flowchart TD\n  subgraph S\n    A\n  end',
    );
  });

  it('two emptied lines still leave exactly one declaration', () => {
    const src = 'flowchart TD\n  A@{ icon: "lucide:zap" }\n  A@{ icon: "lucide:star" }';
    const out = serialize(setNodeIcon(parseFlowchart(src)!, 'A', null));
    expect(out).toBe('flowchart TD\n  A');
  });

  it('but a node declared elsewhere gains no redundant line', () => {
    // The rescue fires only when the node would otherwise be gone — every
    // other shape of declaration (brackets, a bare edge ref, a surviving meta
    // line) already keeps it, so the emptied line just goes.
    for (const [src, want] of [
      ['flowchart TD\n  A[Start]\n  A@{ icon: "lucide:zap" }', 'flowchart TD\n  A[Start]'],
      ['flowchart TD\n  A --> B\n  A@{ icon: "lucide:zap" }', 'flowchart TD\n  A --> B'],
      [
        'flowchart TD\n  A@{ shape: hex }\n  A@{ icon: "lucide:zap" }',
        'flowchart TD\n  A@{ shape: hex }',
      ],
    ]) {
      expect(serialize(setNodeIcon(parseFlowchart(src)!, 'A', null)), src).toBe(want);
    }
  });

  it('null on a node with no meta line is a no-op', () => {
    const src = 'flowchart TD\n  A[Start] --> B';
    expect(serialize(setNodeIcon(parseFlowchart(src)!, 'A', null))).toBe(src);
  });

  it('null on a node with no ICON leaves even inert form/pos alone', () => {
    // form/pos mean nothing without an icon, but they are still the author's
    // bytes: "remove icon" must not become "tidy up".
    const src = 'flowchart TD\n  A --> B\n  A@{ shape: hex, form: circle, pos: t }';
    expect(serialize(setNodeIcon(parseFlowchart(src)!, 'A', null))).toBe(src);
  });

  // MEASURED on the bundled 11.16.0 (icons.mermaid.test.ts): several
  // `A@{ … }` lines fold PER KEY with the LAST value winning, so a set that
  // landed on the first line would be a silent no-op — the defect three Stage E
  // controls shipped and M29.30/.32/.33 each had to close again.
  it('a set lands on the LAST line already carrying icon — the one that renders', () => {
    const m = parseFlowchart(
      'flowchart TD\n  A --> B\n  A@{ icon: "lucide:zap" }\n  A@{ shape: hex }\n  A@{ icon: "lucide:star" }',
    )!;
    expect(serialize(setNodeIcon(m, 'A', 'lucide:rocket'))).toBe(
      'flowchart TD\n  A --> B\n  A@{ icon: "lucide:zap" }\n  A@{ shape: hex }\n  A@{ icon: "lucide:rocket", form: rounded, pos: b }',
    );
  });

  it('with no icon anywhere, a set lands on the LAST meta line', () => {
    const m = parseFlowchart('flowchart TD\n  A --> B\n  A@{ shape: hex }\n  A@{ label: X }')!;
    expect(serialize(setNodeIcon(m, 'A', 'lucide:rocket'))).toBe(
      'flowchart TD\n  A --> B\n  A@{ shape: hex }\n  A@{ label: X, icon: "lucide:rocket", form: rounded, pos: b }',
    );
  });

  // A clear has to reach EVERY site: stripping only the winner leaves an
  // earlier `icon:` still rendering.
  it('null strips icon/form/pos from every line, deleting the ones it empties', () => {
    const m = parseFlowchart(
      'flowchart TD\n  A --> B\n  A@{ icon: "lucide:zap", form: circle }\n  A@{ shape: hex, pos: t }\n  A@{ icon: "lucide:star" }',
    )!;
    expect(serialize(setNodeIcon(m, 'A', null))).toBe(
      'flowchart TD\n  A --> B\n  A@{ shape: hex }',
    );
  });

  it('leaves EDGE meta alone — an id can name both a node and an edge', () => {
    // `e1@{ … }` BELOW the edge is edge meta, never node meta (model.ts's
    // edgeMetaLines). Here `e1` is not even a node, so there is nothing to
    // icon; the animation line survives untouched.
    const src = 'flowchart TD\n  A e1@--> B\n  e1@{ animate: true }';
    expect(serialize(setNodeIcon(parseFlowchart(src)!, 'e1', 'lucide:zap'))).toBe(src);
    expect(serialize(setNodeIcon(parseFlowchart(src)!, 'e1', null))).toBe(src);

    // And when the SAME id names a real node too, position decides what an
    // `@{ … }` line means — a distinction we cannot reproduce, so the op
    // declines wholesale rather than write a line that reads as edge meta.
    const both = 'flowchart TD\n  A --> e1\n  A e1@--> B\n  e1@{ animate: true }';
    const parsed = parseFlowchart(both)!;
    expect(nodes(parsed).has('e1')).toBe(true);
    expect(serialize(setNodeIcon(parsed, 'e1', 'lucide:zap'))).toBe(both);
  });

  it('an id the diagram does not declare is a no-op, not a new node', () => {
    const src = 'flowchart TD\n  A[Start] --> B';
    expect(serialize(setNodeIcon(parseFlowchart(src)!, 'ZZZ', 'lucide:zap'))).toBe(src);
  });

  it('an opaque multi-line meta block wins at render, so we decline rather than lie', () => {
    const src = 'flowchart TD\n  A[Start] --> B\n  A@{\n    icon: "lucide:zap"\n  }';
    expect(serialize(setNodeIcon(parseFlowchart(src)!, 'A', 'lucide:rocket'))).toBe(src);
    expect(serialize(setNodeIcon(parseFlowchart(src)!, 'A', null))).toBe(src);
  });

  // Same reasoning as setNodeShape's: re-picking what the node already shows
  // must not cost an undo step. Here it would also silently ADD form/pos and
  // change the drawn shape from `icon` to `iconRounded`.
  it('re-picking the icon the node already has changes nothing at all', () => {
    const src = 'flowchart TD\n  A --> B\n  A@{ icon: "lucide:zap" }';
    expect(serialize(setNodeIcon(parseFlowchart(src)!, 'A', 'lucide:zap'))).toBe(src);
  });

  // `pos` is icon AND image presentation (flowDb getTypeFromVertex reads
  // `img` before `icon`), so a node carrying both keeps its image's position
  // when the icon goes — removing more than asked is the surgical rule's whole
  // point.
  it('an image on the same node keeps its form/pos when the icon is cleared', () => {
    const m = parseFlowchart(
      'flowchart TD\n  A@{ img: "a.png", icon: "lucide:zap", form: circle, pos: t }',
    )!;
    // (`a.png` needs no quotes, and a dirtied line re-emits every value through
    // emitMetaValue — Stage E's canonical spacing/quoting, unchanged here.)
    expect(serialize(setNodeIcon(m, 'A', null))).toBe(
      'flowchart TD\n  A@{ img: a.png, form: circle, pos: t }',
    );
  });

  // A newline is the one input quoting cannot rescue: `parseFlowchart` splits
  // on it, so an emitted one turns a single ModelLine into two. Measured on
  // 11.16.0 — through a meta `label:` it is a PARSE ERROR that kills the whole
  // diagram; through brackets mermaid accepts it and OUR model loses the edge.
  it('a newline in any emitted value is flattened, never allowed to split a line', () => {
    const meta = serialize(
      renameNode(parseFlowchart('flowchart TD\n  A@{ label: hi }')!, 'A', 'a\nb'),
    );
    expect(meta).toBe('flowchart TD\n  A@{ label: a b }');

    const bracket = serialize(
      renameNode(parseFlowchart('flowchart TD\n  A[Start] --> B')!, 'A', 'a\nb'),
    );
    expect(bracket).toBe('flowchart TD\n  A[a b] --> B');
    // The edge is still an edge, which is the part a split line silently cost.
    expect(edges(parseFlowchart(bracket)!)).toHaveLength(1);

    const icon = serialize(
      setNodeIcon(parseFlowchart('flowchart TD\n  A --> B')!, 'A', 'lucide:a\nb'),
    );
    expect(icon.split('\n')).toHaveLength(3);
    expect(nodeMeta(parseFlowchart(icon)!).get('A')?.icon).toBe('lucide:a b');

    // CRLF collapses to ONE space, not two.
    const crlf = serialize(renameNode(parseFlowchart('flowchart TD\n  A[Start]')!, 'A', 'a\r\nb'));
    expect(crlf).toBe('flowchart TD\n  A[a b]');

    // An edge label answers to the same boundary.
    const em = parseFlowchart('flowchart TD\n  A --> B')!;
    expect(serialize(setEdgeLabel(em, edges(em)[0], 'a\nb'))).toBe('flowchart TD\n  A -->|a b| B');
  });

  it('an icon value carrying a quote is substituted, never emitted raw', () => {
    // emitMetaValue's last boundary: `"` has no escape inside mermaid's
    // quoted-string lexer state, so it becomes `'` rather than breaking the line.
    const m = parseFlowchart('flowchart TD\n  A --> B')!;
    const out = serialize(setNodeIcon(m, 'A', 'lucide:a"b'));
    expect(out).toContain(`icon: "lucide:a'b"`);
    // The line is still one our own parser owns — the substitution cost the
    // node no editability.
    expect(nodeMeta(parseFlowchart(out)!).get('A')?.icon).toBe("lucide:a'b");
  });
});

describe('setNodeLink', () => {
  it('appends a click line for an unlinked node', () => {
    const m = parseFlowchart('flowchart TD\n  A[Start] --> B')!;
    const out = serialize(setNodeLink(m, 'A', 'projects/atlas/project.md'));
    expect(out).toBe('flowchart TD\n  A[Start] --> B\n  click A "projects/atlas/project.md"');
  });

  it('patches an existing click line in place', () => {
    const m = parseFlowchart(
      'flowchart TD\n  A --> B\n  click A "old.md"\n  classDef hot fill:#f96',
    )!;
    const out = serialize(setNodeLink(m, 'A', 'https://example.com'));
    expect(out.split('\n')[2]).toBe('  click A "https://example.com"');
    expect(out.split('\n')[3]).toBe('  classDef hot fill:#f96'); // untouched, byte-identical
  });

  it('null removes every owned click line for the node', () => {
    const m = parseFlowchart('flowchart TD\n  A --> B\n  click A "one.md"\n  click A "two.md"')!;
    expect(serialize(setNodeLink(m, 'A', null))).toBe('flowchart TD\n  A --> B');
  });

  it('a double quote in the target is substituted, never emitted raw', () => {
    // Same boundary rule as setEdgeLabel's pipe: `"` closes the target string
    // in mermaid's grammar, so a literal one would truncate the line into
    // garbage. Substitute at the last boundary before the file.
    const m = parseFlowchart('flowchart TD\n  A')!;
    const out = serialize(setNodeLink(m, 'A', 'weird"name.md'));
    expect(out).toContain('click A "weird\'name.md"');
    // …and the line we wrote is still one our own parser owns.
    expect(nodeLinks(parseFlowchart(out)!).get('A')?.target).toBe("weird'name.md");
  });

  it('a newline in the target is flattened, never allowed to split the line', () => {
    // The exposure `flattenForLine` exists for (M29.35), reached through a new
    // door: Stage H feeds user-controlled vault paths into this op. Emitted
    // raw, the LF would turn one click line into two lines our own parser
    // reads as opaque junk — the link would vanish from the model while the
    // bytes stayed in the file.
    const m = parseFlowchart('flowchart TD\n  A')!;
    const out = serialize(setNodeLink(m, 'A', 'notes/a\nb.md'));
    expect(out.split('\n')).toHaveLength(3);
    expect(nodeLinks(parseFlowchart(out)!).get('A')?.target).toBe('notes/a b.md');
    // CRLF collapses to ONE space, as everywhere else.
    const crlf = serialize(setNodeLink(parseFlowchart('flowchart TD\n  A')!, 'A', 'a\r\nb.md'));
    expect(crlf).toBe('flowchart TD\n  A\n  click A "a b.md"');
  });

  it('an empty or blank target clears the link instead of emitting one', () => {
    // MEASURED on 11.16.0: `click A ""` is a PARSE ERROR that kills the whole
    // diagram, and `click A "   "` renders but attaches nothing
    // (`utils.formatUrl` returns undefined for a blank url). Neither is a
    // link, so neither may be written — the same call `emitEdgeLabel` makes
    // when it treats an empty label as "no label".
    const m = parseFlowchart('flowchart TD\n  A --> B\n  click A "old.md"')!;
    // A lone `"` is NOT blank — it substitutes to `'`, a legal if odd target —
    // so it is deliberately absent from this list.
    for (const blank of ['', '   ', '\n', '\r\n', '\t']) {
      expect([blank, serialize(setNodeLink(m, 'A', blank))]).toEqual([
        blank,
        'flowchart TD\n  A --> B',
      ]);
    }
  });

  it('writes to the LAST owned line, the one mermaid resolves', () => {
    // Three plain click lines for one id resolve to the third upstream
    // (measured). Patching the first and deleting the rest would still leave
    // one winner, but it loses to an opaque `href` variant sitting between
    // them and to a node declared later — so the survivor is the last.
    const src = [
      'flowchart TD',
      '  click A "dead-above-the-node.md"',
      '  A --> B',
      '  click A href "opaque-variant.md"',
      '  click A "live.md"',
    ].join('\n');
    const out = serialize(setNodeLink(parseFlowchart(src)!, 'A', 'new.md'));
    expect(out).toBe(
      [
        'flowchart TD',
        '  A --> B',
        '  click A href "opaque-variant.md"',
        '  click A "new.md"',
      ].join('\n'),
    );
  });

  it('never touches a click VARIANT it does not own', () => {
    const src = [
      'flowchart TD',
      '  A --> B',
      '  click A href "https://example.com" _blank',
      '  click A,B "both.md"',
      '  click A call doThing()',
    ].join('\n');
    // Neither a set nor a clear may rewrite a line we do not understand.
    expect(serialize(setNodeLink(parseFlowchart(src)!, 'A', null))).toBe(src);
    expect(serialize(setNodeLink(parseFlowchart(src)!, 'A', 'mine.md'))).toBe(
      `${src}\n  click A "mine.md"`,
    );
  });

  it('does not refuse an undeclared id — a click line mints no node', () => {
    // The refusals `setNodeShape`/`setNodeIcon` carry exist because an
    // `id@{ … }` line for an unknown id CREATES a node. MEASURED on 11.16.0, a
    // click line does not: `setLink` and `setClass` both skip an id with no
    // vertex, so `click Z "…"` is inert, not a phantom. Refusing here would
    // instead make Stage H's "create a node, then link it" a silent no-op.
    const out = serialize(setNodeLink(parseFlowchart('flowchart TD\n  A --> B')!, 'Z', 'z.md'));
    expect(out).toBe('flowchart TD\n  A --> B\n  click Z "z.md"');
    expect([...nodes(parseFlowchart(out)!).keys()].sort()).toEqual(['A', 'B']);
  });

  it('refuses an id it could not read back', () => {
    // Output validation, not input taste: `click A B "x"` is a CALLBACK line
    // upstream (flow.jison:549) and opaque to us, so emitting one would be
    // this layer writing a line it immediately disowns.
    for (const id of ['A B', 'A,B', '', 'A"B']) {
      const before = parseFlowchart('flowchart TD\n  A --> B')!;
      expect([id, serialize(setNodeLink(before, id, 'x.md'))]).toEqual([
        id,
        'flowchart TD\n  A --> B',
      ]);
    }
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
      '  style A fill: #f96 , stroke:#333',
      '  click A "old.md"',
      '  click B call doThing()',
    ].join('\n');
    const after = serialize(setNodeLink(parseFlowchart(src)!, 'A', 'new.md')).split('\n');
    const before = src.split('\n');
    expect(after.length).toBe(before.length);
    after.forEach((line, i) => {
      if (i === 9) return;
      expect([i, line]).toEqual([i, before[i]]);
    });
    expect(after[9]).toBe('  click A "new.md"');
  });

  it('places a new line next to its node, matching indent, never above it', () => {
    // A click line ABOVE its node's first declaration is DEAD upstream
    // (measured: `setLink` only assigns to a vertex that already exists), so
    // the anchor rule `setNodeStyle` uses applies here for the same reason.
    const src = 'flowchart TD\n  subgraph S\n      A[Start] --> B\n  end\n  C --> D';
    const out = serialize(setNodeLink(parseFlowchart(src)!, 'A', 'a.md'));
    expect(out.split('\n')[3]).toBe('      click A "a.md"');
  });

  it('does not mistake a longer id for the one being linked', () => {
    // `.` and `-` are id characters, so a `\b` terminator would read
    // `click A.x-y "…"` as a statement about `A` and place the new line below
    // an unrelated node's link.
    const src = 'flowchart TD\n  A --> B\n  click A.x-y "other.md"';
    const out = serialize(setNodeLink(parseFlowchart(src)!, 'A', 'a.md'));
    expect(out).toBe('flowchart TD\n  A --> B\n  click A "a.md"\n  click A.x-y "other.md"');
    // …but a comma id-list genuinely names A, and must still push us below it.
    const list = 'flowchart TD\n  A --> B\n  click A,B "both.md"';
    expect(serialize(setNodeLink(parseFlowchart(list)!, 'A', 'a.md'))).toBe(
      `${list}\n  click A "a.md"`,
    );
  });
});

/**
 * Adversarial round-trip sweep for `setNodeLink` (M29.36). DOCUMENTS, not
 * tokens — the `Foo--oBar` scar is that a 107-input token sweep passed while a
 * whole-document one would have caught a silent rename. Real mermaid renders
 * the same corpus in `links.mermaid.test.ts`; this half is the byte contract.
 */
describe('setNodeLink sweep', () => {
  const DOCS: [string, string][] = [
    ['bare', 'flowchart TD\n  A --> B'],
    ['labeled', 'flowchart TD\n  A[Start] --> B{Choice}'],
    ['definition-line', 'flowchart TD\n  A[Start]\n  A --> B'],
    ['meta-shape', 'flowchart TD\n  A --> B\n  A@{ shape: cyl }'],
    ['lone-meta', 'flowchart TD\n  A@{ icon: "lucide:rocket", form: rounded, pos: b }'],
    ['in-subgraph', 'flowchart TD\n  subgraph S\n    A --> B\n  end'],
    ['frontmatter', '---\nconfig:\n  layout: elk\n---\nflowchart TD\n  A --> B'],
    ['crlf', 'flowchart TD\r\n  A --> B\r\n  C --> A'],
    ['chain', 'flowchart TD\n  A --> B --> C'],
    ['group', 'flowchart TD\n  A & B --> C'],
    ['existing-click', 'flowchart TD\n  A --> B\n  click A "old.md"'],
    ['two-clicks', 'flowchart TD\n  A --> B\n  click A "one.md"\n  click A "two.md"'],
    ['click-above-node', 'flowchart TD\n  click A "above.md"\n  A --> B'],
    ['href-variant', 'flowchart TD\n  A --> B\n  click A href "x.md"'],
    ['comma-variant', 'flowchart TD\n  A --> B\n  click A,B "both.md"'],
    ['call-variant', 'flowchart TD\n  A --> B\n  click A call doThing()'],
    ['tooltip-variant', 'flowchart TD\n  A --> B\n  click A "x.md" "a tip"'],
    // Lines mermaid itself rejects (measured): the model must not own them,
    // and the op must not disturb them.
    ['unrenderable-click', 'flowchart TD\n  A --> B\n  click A  "two-spaces.md"'],
    ['bare-click', 'flowchart TD\n  A --> B\n  click'],
    ['trailing-blank', 'flowchart TD\n  A --> B\n'],
    ['comments', 'flowchart TD\n  %% note\n  A --> B\n  %% tail'],
    [
      'styled',
      'flowchart TD\n  A --> B\n  style A fill:#f96\n  classDef hot fill:#f96\n  class A hot',
    ],
    ['edge-id', 'flowchart TD\n  A e1@--> B\n  e1@{ animate: true }'],
    ['tab-indent', 'flowchart TD\n\tsubgraph S\n\t\tA --> B\n\tend'],
    ['id-with-dot-dash', 'flowchart TD\n  A --> B\n  click A.x-y "other.md"'],
  ];

  const TARGETS: [string, string][] = [
    ['projects/atlas/project.md', 'projects/atlas/project.md'],
    ['https://example.com/a?b=c#d', 'https://example.com/a?b=c#d'],
    ['my notes/a b.md', 'my notes/a b.md'],
    ['weird"name.md', "weird'name.md"],
    ['a\nb.md', 'a b.md'],
    ['a\r\nb.md', 'a b.md'],
    ['a|b.md', 'a|b.md'],
    ['a#b.md', 'a#b.md'],
    ['a %% b.md', 'a %% b.md'],
    ['a[b]{c}.md', 'a[b]{c}.md'],
    ['a,b.md', 'a,b.md'],
    ['a;b.md', 'a;b.md'],
    ['a\\b.md', 'a\\b.md'],
    ['notes/é中—.md', 'notes/é中—.md'],
    ['javascript:alert(1)', 'javascript:alert(1)'],
    [`${'x'.repeat(400)}.md`, `${'x'.repeat(400)}.md`],
    ['  padded.md  ', '  padded.md  '],
    ["'single'.md", "'single'.md"],
    ['A --> B', 'A --> B'],
    // A target that is itself a click line: the quotes substitute, so it can
    // never close the string early and mint a second statement.
    ['click A "nested.md"', "click A 'nested.md'"],
  ];

  /** Every line except the ones this op is allowed to add, move, or delete. */
  const untouched = (code: string): string[] => {
    const model = parseFlowchart(code)!;
    return model.lines
      .filter((l) => !(l.parsed.kind === 'click' && l.parsed.id === 'A'))
      .map((l) => l.raw);
  };

  const ownedTargets = (code: string): string[] => {
    const model = parseFlowchart(code)!;
    return model.lines.flatMap((l) =>
      l.parsed.kind === 'click' && l.parsed.id === 'A' ? [l.parsed.target] : [],
    );
  };

  it('every document round-trips byte-identically before anything touches it', () => {
    for (const [name, src] of DOCS) {
      expect([name, serialize(parseFlowchart(src)!)]).toEqual([name, src]);
    }
  });

  it('sets, re-reads, and clears across the whole cross product', () => {
    let checked = 0;
    for (const [docName, src] of DOCS) {
      const before = untouched(src);
      const beforeNodes = [...nodes(parseFlowchart(src)!).keys()].sort();
      for (const [input, expected] of TARGETS) {
        const where = `${docName} + ${JSON.stringify(input).slice(0, 40)}`;
        const out = serialize(setNodeLink(parseFlowchart(src)!, 'A', input));

        // 1. Every line the op had no business touching is byte-identical,
        //    opaque click VARIANTS and unrenderable click lines included.
        expect([where, untouched(out)]).toEqual([where, before]);
        // 2. Exactly one owned line survives, carrying exactly what we asked
        //    for. This is the anti-vacuity check: it cannot pass on a no-op.
        expect([where, ownedTargets(out)]).toEqual([where, [expected]]);
        // 3. The written line is one our own parser reads back, and reading it
        //    back and re-emitting it changes nothing.
        expect([where, serialize(parseFlowchart(out)!)]).toEqual([where, out]);
        expect([where, nodeLinks(parseFlowchart(out)!).get('A')?.target]).toEqual([
          where,
          expected,
        ]);
        // 4. No node is invented and none goes missing — the invariant the
        //    `Foo--oBar` rename bug would have failed.
        expect([where, [...nodes(parseFlowchart(out)!).keys()].sort()]).toEqual([
          where,
          beforeNodes,
        ]);
        // 5. Setting the same target twice is a fixed point.
        expect([where, serialize(setNodeLink(parseFlowchart(out)!, 'A', input))]).toEqual([
          where,
          out,
        ]);
        // 6. Clearing lands exactly on the document minus its owned lines.
        expect([
          where,
          serialize(setNodeLink(parseFlowchart(out)!, 'A', null)).split('\n'),
        ]).toEqual([where, before]);
        checked += 1;
      }
    }
    expect(checked).toBe(DOCS.length * TARGETS.length);
    expect(checked).toBeGreaterThan(400);
  });

  it('a blank target clears every document without ever writing a line', () => {
    for (const [name, src] of DOCS) {
      for (const blank of ['', '  ', '\n', '\t']) {
        const out = serialize(setNodeLink(parseFlowchart(src)!, 'A', blank));
        expect([name, blank, out.split('\n')]).toEqual([name, blank, untouched(src)]);
      }
    }
  });
});
