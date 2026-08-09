import { describe, expect, it } from 'vitest';
import { edges, parseFlowchart, serialize } from './model';
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
