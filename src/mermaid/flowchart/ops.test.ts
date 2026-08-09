import { describe, expect, it } from 'vitest';
import { edges, nodeMeta, nodeStyle, nodes, parseFlowchart, serialize } from './model';
import {
  addEdge,
  addNode,
  deleteEdge,
  deleteNode,
  newNodeId,
  renameNode,
  setDirection,
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
