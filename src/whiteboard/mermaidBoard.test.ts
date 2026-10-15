import { expect, it } from 'vitest';
import { makeEntry } from '@/test/factories';
import { readMermaidBoard } from './mermaidBoard';
const manual = (body: string) => `flowchart LR\n%% cerebro:layout manual\n${body}`;
const entries = [makeEntry({ path: 'work/ship.md', title: 'Ship' })];
const read = (code: string) => {
  const result = readMermaidBoard(code, entries);
  if (!result.ok) throw new Error(result.reason);
  return result.sketch;
};
it.each([
  ['sequenceDiagram\nA->>B: hi', 'not-flowchart'],
  ['flowchart LR\nA[Hi]', 'not-manual'],
  [manual(''), 'empty'],
])('refuses %s', (code, reason) =>
  expect(readMermaidBoard(code, entries)).toEqual({ ok: false, reason }),
);
it('reads model labels, positions, page bindings, URLs and unresolved targets', () => {
  const sketch = read(
    manual(
      'A[First<br/>second]\nB{Choice}\nC[Missing]\nD[Exact]\n%% cerebro:pos A 12,34 B 250,40\nclick A "ship"\nclick B "https://example.com"\nclick C "missing.md"\nclick D "work/ship.md"',
    ),
  );
  expect(sketch.nodes).toEqual([
    {
      id: 'A',
      label: 'First\nsecond',
      shape: 'rect',
      position: { x: 12, y: 34 },
      file: 'work/ship.md',
    },
    {
      id: 'B',
      label: 'Choice',
      shape: 'diamond',
      position: { x: 250, y: 40 },
      target: 'https://example.com',
    },
    { id: 'C', label: 'Missing', shape: 'rect', target: 'missing.md' },
    { id: 'D', label: 'Exact', shape: 'rect', file: 'work/ship.md' },
  ]);
});
it('expands hex fills, drops alpha, and reports nonhex and nonfill styles', () => {
  const sketch = read(
    manual(
      'A\nB\nC\nD\nE\nstyle A fill:#AbC,stroke:#000\nstyle B fill:#1234\nstyle C fill:#12345678\nstyle D fill:var(--accent)\nstyle E fill:2',
    ),
  );
  expect(sketch.nodes.map((n) => n.color)).toEqual([
    '#aabbcc',
    '#112233',
    '#123456',
    undefined,
    undefined,
  ]);
  expect(sketch.alphaColors).toBe(2);
  expect(sketch.styleKeys).toEqual(['fill (not a hex color)', 'stroke']);
});
it('reads nested groups, heads, invisible hints, labels and unsupported source lines', () => {
  const sketch = read(
    '---\nconfig:\n  theme: neutral\n---\n' +
      manual(
        'subgraph outer[Outer]\nsubgraph inner[Inner]\nA[One]\nend\nB[Two]\nend\nA o--o|go<br>now| B\nA ~~~ B\nA ==> B\nB -.-> A\nclassDef hot fill:#f96\nclass A hot',
      ),
  );
  expect(sketch.groups).toMatchObject([
    { id: 'outer', label: 'Outer' },
    { id: 'inner', label: 'Inner', parent: 'outer' },
  ]);
  expect(sketch.edges).toMatchObject([
    { from: 'A', to: 'B', fromEnd: 'arrow', toEnd: 'arrow', specialHeads: 2, label: 'go\nnow' },
    { invisible: true, stroke: 'invisible' },
    { stroke: 'thick' },
    { stroke: 'dotted' },
  ]);
  expect(sketch.leftovers).toEqual(['classDef hot fill:#f96', 'class A hot']);
  expect(sketch.settings).toBe(true);
});
it('does not silently turn a contested href into a page card', () => {
  const sketch = read(manual('A\nclick A "ship"\nclick A href "https://example.com"'));
  expect(sketch.nodes[0].file).toBeUndefined();
  expect(sketch.leftovers).toContain('click A href "https://example.com"');
});

it('counts icons and animated links and keeps an unsupported shape name in the sketch', () => {
  const sketch = read(
    manual(
      'A@{ shape: icon, icon: "fa:home", label: Home }\nB@{ shape: cloud, label: Cloud }\nA e1@--> B\ne1@{ animate: true }',
    ),
  );
  expect(sketch.icons).toBe(1);
  expect(sketch.animations).toBe(1);
  expect(sketch.nodes.map((n) => n.shape)).toEqual(['icon', 'cloud']);
});
