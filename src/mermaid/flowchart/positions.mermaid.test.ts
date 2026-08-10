import { describe, expect, it } from 'vitest';
import mermaid from 'mermaid';
import { parseFlowchart, serialize, storedPositions, isManualLayout } from './model';
import { clearPositions, setManualLayout, setNodePosition } from './ops';
import { NODE_GROUP_SELECTOR } from './svgBinding';

/**
 * Conformance, not unit testing (M29.41). The `%% cerebro:pos` /
 * `%% cerebro:layout manual` grammar rests on ONE claim about mermaid: that
 * these lines are INERT wherever they sit. The plan asserts it ("both are
 * ordinary mermaid comments, so mermaid ignores them unconditionally"); this
 * file measures it, because the last time this wave took a comment claim on
 * faith the answer was the opposite of the obvious one — a `%%`-commented
 * `direction` line IS ignored by mermaid (the comment rule outranks the
 * direction rule) while our own reader was honouring it.
 *
 * What is measured, all against the BUNDLED 11.16.0:
 *
 * - a marker line inserted at EVERY line index of four structurally different
 *   documents (dagre, ELK-with-frontmatter, subgraph+direction, CRLF) changes
 *   NOTHING mermaid sees: same vertices, same edges, same subgraph membership,
 *   same directions — and the same rendered svg bytes;
 * - the dangerous positions specifically: line 0 (above the header), directly
 *   under a frontmatter block, the first line inside a `subgraph`, the line
 *   directly above an `end`, and end-of-file;
 * - ids that are mermaid KEYWORDS (`end`, `subgraph`, `direction`, `click`,
 *   `style`, `graph`) inside a subgraph block — the `end` case is the one that
 *   would silently close a block early if the comment rule did not win;
 * - malformed variants (the ones we deliberately keep opaque) still render;
 * - the lines our OWN ops write survive a real render.
 */

const TIMEOUT = 120_000;

function polyfill(): void {
  // jsdom implements no SVG layout; every shape handler sizes itself from the
  // label's bbox. Fixed values keep renders comparable and finite.
  const proto = (globalThis as unknown as { SVGElement: { prototype: Record<string, unknown> } })
    .SVGElement.prototype;
  proto.getBBox = () => ({ x: 0, y: 0, width: 60, height: 20 });
  proto.getComputedTextLength = () => 60;
}

function init(): void {
  polyfill();
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' });
}

interface FlowDb {
  getVertices: () => Map<string, { text?: string; type?: string }>;
  getEdges: () => { start: string; end: string; text?: string; type?: string }[];
  getSubGraphs: () => { id: string; title: string; nodes: string[]; dir?: string }[];
  getDirection: () => string;
}

/** Everything mermaid itself understood about a document, as comparable text. */
async function reading(code: string): Promise<string> {
  const { mermaidAPI } = mermaid as unknown as {
    mermaidAPI: { getDiagramFromText: (t: string) => Promise<{ db: unknown }> };
  };
  const diagram = await mermaidAPI.getDiagramFromText(code);
  const db = diagram.db as FlowDb;
  return JSON.stringify({
    direction: db.getDirection(),
    vertices: [...db.getVertices().entries()].map(([id, v]) => [
      id,
      v.text ?? null,
      v.type ?? null,
    ]),
    edges: db.getEdges().map((e) => [e.start, e.end, e.text ?? null, e.type ?? null]),
    subgraphs: db.getSubGraphs().map((s) => [s.id, s.title, s.nodes, s.dir ?? null]),
  });
}

let seq = 0;

/** The rendered svg with the render id normalized away, or the thrown error. */
async function rendering(code: string): Promise<string> {
  seq += 1;
  const id = `pos${seq}`;
  const host = document.createElement('div');
  document.body.appendChild(host);
  try {
    const { svg } = await mermaid.render(id, code, host);
    return svg.replaceAll(id, 'RID');
  } finally {
    host.remove();
  }
}

const MARKERS = [
  '%% cerebro:layout manual',
  '%% cerebro:pos A 120,40 B 300,200',
  '  %% cerebro:pos A -12,-40',
  '%%cerebro:pos A 1,2',
  '%%  cerebro:layout   manual',
];

/** Documents whose STRUCTURE differs, not just their spelling. */
const DOCS: [string, string, number][] = [
  // [name, code, first index a marker may be inserted at]
  ['dagre', 'flowchart TD\n  A[Start] --> B{Choice}\n  B -->|yes| C[Done]', 0],
  [
    'frontmatter-elk',
    '---\nconfig:\n  layout: elk\n---\nflowchart LR\n  A --> B\n  B --> C[End]',
    4,
  ],
  [
    'subgraph',
    'flowchart TD\n  subgraph S1[Phase]\n    direction LR\n    A --> B\n  end\n  B --> C\n  style A fill:#f96',
    0,
  ],
  ['crlf', 'flowchart TD\r\n  A[Start] --> B\r\n  B --> C\r', 0],
];

describe('cerebro marker comments are inert to mermaid (M29.41)', () => {
  it(
    'a marker at EVERY line index changes nothing mermaid reads',
    async () => {
      init();
      for (const [name, code, firstIndex] of DOCS) {
        const eol = code.includes('\r\n') ? '\r\n' : '\n';
        const lines = code.split(eol);
        const base = await reading(code);
        for (const marker of MARKERS) {
          for (let at = firstIndex; at <= lines.length; at += 1) {
            const next = [...lines];
            next.splice(at, 0, marker);
            const variant = next.join(eol);
            expect(await reading(variant), `${name} @${at} ${marker}`).toBe(base);
          }
        }
      }
    },
    TIMEOUT,
  );

  it(
    'a marker at every line index renders byte-identical svg',
    async () => {
      init();
      for (const [name, code, firstIndex] of DOCS) {
        const eol = code.includes('\r\n') ? '\r\n' : '\n';
        const lines = code.split(eol);
        const base = await rendering(code);
        for (const at of [firstIndex, firstIndex + 1, lines.length - 1, lines.length]) {
          for (const marker of ['%% cerebro:layout manual', '%% cerebro:pos A 120,40 B 300,200']) {
            const next = [...lines];
            next.splice(at, 0, marker);
            expect(await rendering(next.join(eol)), `${name} @${at} ${marker}`).toBe(base);
          }
        }
      }
    },
    TIMEOUT,
  );

  it(
    'keyword ids inside a subgraph do not leak into the grammar',
    async () => {
      init();
      const base = await reading(
        'flowchart TD\n  subgraph S1[Phase]\n    A --> B\n  end\n  B --> C',
      );
      for (const id of ['end', 'subgraph', 'direction', 'click', 'style', 'graph', 'class']) {
        const variant = `flowchart TD\n  subgraph S1[Phase]\n    %% cerebro:pos ${id} 1,2 A 3,4\n    A --> B\n  end\n  B --> C`;
        expect(await reading(variant), id).toBe(base);
      }
      // The one that would be catastrophic if the comment rule lost: a
      // `direction`-shaped tail inside the marker. Our grammar cannot emit it
      // (every id is followed by a coordinate), but a hand-written line can.
      const dir = await reading(
        'flowchart TD\n  subgraph S1[Phase]\n    %% cerebro:pos direction LR\n    A --> B\n  end',
      );
      const plain = await reading('flowchart TD\n  subgraph S1[Phase]\n    A --> B\n  end');
      expect(dir).toBe(plain);
    },
    TIMEOUT,
  );

  it(
    'malformed markers — the ones we keep opaque — still render',
    async () => {
      init();
      for (const bad of [
        '%% cerebro:pos A 12',
        '%% cerebro:pos A twelve,40',
        '%% cerebro:pos A 12,40 B',
        '%% cerebro:layout automatic',
        '%% cerebro:pos',
        '%% cerebro:pos A 1,2 A 3,4',
      ]) {
        const svg = await rendering(`flowchart TD\n  ${bad}\n  A --> B`);
        expect(svg.startsWith('<svg'), bad).toBe(true);
      }
    },
    TIMEOUT,
  );

  it(
    'the lines our own ops write render, and read back as what we wrote',
    async () => {
      init();
      let model = parseFlowchart('flowchart TD\n  A[Start] --> B{Choice}\n  B --> C')!;
      model = setManualLayout(model, true);
      model = setNodePosition(model, 'B', { x: 300.4, y: 199.6 });
      model = setNodePosition(model, 'A', { x: -12, y: 0 });
      const code = serialize(model);
      expect(await rendering(code)).toBe(
        await rendering('flowchart TD\n  A[Start] --> B{Choice}\n  B --> C'),
      );
      const reread = parseFlowchart(code)!;
      expect(isManualLayout(reread)).toBe(true);
      expect(storedPositions(reread).get('B')).toEqual({ x: 300, y: 200 });
      expect(storedPositions(reread).get('A')).toEqual({ x: -12, y: 0 });
      expect(serialize(clearPositions(reread))).toBe(
        'flowchart TD\n  %% cerebro:layout manual\n  A[Start] --> B{Choice}\n  B --> C',
      );
    },
    TIMEOUT,
  );
});

/**
 * The other half of the manual-layout contract (M29.42): not what mermaid
 * IGNORES, but what it EMITS. `manualLayout.ts` writes into this DOM, and every
 * claim below is one it would silently misbehave on if 11.16.0 disagreed — so
 * each is measured here rather than read off the vendored 11.16.1 source or
 * inherited from the plan, which has already been wrong about this subtree
 * (`g.root` is absent entirely under ELK; hand-drawn nodes are `g.rough-node`).
 */
describe('the svg DOM manual layout writes into (M29.42)', () => {
  const FLOW = 'flowchart TD\n  A[Start] --> B{Choice}\n  B -->|yes| C[Done]';

  async function renderedDom(code: string): Promise<SVGSVGElement> {
    seq += 1;
    const host = document.createElement('div');
    document.body.appendChild(host);
    try {
      const { svg } = await mermaid.render(`dom${seq}`, code, host);
      const holder = document.createElement('div');
      holder.innerHTML = svg;
      return holder.querySelector('svg')!;
    } finally {
      host.remove();
    }
  }

  it(
    'sizes the svg the way growViewBox assumes: width=100%, a px max-width, no height',
    async () => {
      init();
      const svg = await renderedDom(FLOW);
      expect(svg.getAttribute('width')).toBe('100%');
      expect(svg.getAttribute('style')).toMatch(/max-width:\s*[\d.]+px/);
      // No height attribute at all: the box is the viewBox's aspect ratio, so
      // growing the viewBox is what makes room, and nothing else has to move.
      expect(svg.getAttribute('height')).toBeNull();
      const vb = svg
        .getAttribute('viewBox')!
        .trim()
        .split(/[\s,]+/)
        .map(Number);
      expect(vb).toHaveLength(4);
      expect(vb.every((n) => Number.isFinite(n))).toBe(true);
    },
    TIMEOUT,
  );

  it(
    'positions every node group with a LONE translate, under ancestors carrying none',
    async () => {
      init();
      const svg = await renderedDom(FLOW);
      const groups = [...svg.querySelectorAll(NODE_GROUP_SELECTOR)];
      expect(groups).toHaveLength(3);
      for (const el of groups) {
        // The base transform the manual pipeline appends to (nodes.ts:97).
        expect(el.getAttribute('transform')).toMatch(/^translate\(-?[\d.]+,\s*-?[\d.]+\)$/);
        // And nothing between it and the root scales or rotates the plane — the
        // reason the no-CTM fallback is allowed to treat plane units as local.
        for (
          let cur = el.parentElement;
          cur !== null && cur !== (svg as Element);
          cur = cur.parentElement
        ) {
          expect(cur.getAttribute('transform')).toBeNull();
        }
      }
    },
    TIMEOUT,
  );

  it(
    'keeps both markers, and stays childless, when d is replaced',
    async () => {
      init();
      const svg = await renderedDom('flowchart TD\n  A <--> B');
      const path = svg.querySelector('path.flowchart-link')!;
      const before = [path.getAttribute('marker-start'), path.getAttribute('marker-end')];
      expect(before[0]).toMatch(/^url\(#/);
      expect(before[1]).toMatch(/^url\(#/);
      path.setAttribute('d', 'M0,0L10,10');
      expect([path.getAttribute('marker-start'), path.getAttribute('marker-end')]).toEqual(before);
      // One path per edge, no overlay and no hit-target child: replacing `d`
      // leaves no fragment of mermaid's curve behind.
      expect(path.children).toHaveLength(0);
      expect(svg.querySelectorAll('path.flowchart-link')).toHaveLength(1);
    },
    TIMEOUT,
  );

  it(
    'keys the edge label off the same data-id the path carries',
    async () => {
      init();
      const svg = await renderedDom('flowchart TD\n  A -->|go| B');
      const path = svg.querySelector('path.flowchart-link')!;
      const dataId = path.getAttribute('data-id');
      expect(dataId).toBe('L_A_B_0');
      const inner = svg.querySelector(`g.edgeLabels g.label[data-id="${dataId}"]`);
      expect(inner).not.toBeNull();
      // The OUTER group is the one mermaid itself translates (edges.js:292),
      // and the one moveEdgeLabel writes.
      expect(inner!.parentElement!.getAttribute('class')).toContain('edgeLabel');
    },
    TIMEOUT,
  );
});
