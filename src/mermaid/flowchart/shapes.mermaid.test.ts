import { describe, expect, it } from 'vitest';
import mermaid from 'mermaid';
import { nodes, parseFlowchart, serialize } from './model';
import { setNodeShape } from './ops';
import { PALETTE_SHAPES, SHAPE_ALIASES, VALID_SHAPES } from './shapes';

/**
 * Conformance, not unit testing (M29.32). Every other test in this directory
 * is pure string code; this one drives the mermaid the app actually bundles,
 * because `shapes.ts` is not a design — it is a set of CLAIMS ABOUT MERMAID,
 * and a claim that drifts is a claim that kills the render: `addVertex` throws
 * on an unknown shape name (flowDb.ts:236-241) and takes the whole diagram
 * with it.
 *
 * This file exists because the stage plan's registry was mermaid 11.16.1's —
 * 49 short names — while the app resolves **11.16.0**, whose registry is 48.
 * The odd one out is `person`, and a palette button writing it would have
 * turned every click into a blank diagram. Nothing but a measurement catches
 * that, so here is the measurement, wired to fail on the next version skew in
 * EITHER direction.
 *
 * Render-level geometry is asserted too, not just parseability: "mermaid
 * accepts the name" and "mermaid draws the shape we promised" are different
 * facts, and an alias table can be wrong about the second while right about
 * the first. `handDrawnSeed` is pinned because mermaid builds even
 * classic-look shapes through rough.js, which otherwise randomizes its control
 * points on every call.
 */

/**
 * Generous per-test budgets (the suite default is 15s). Nothing here is slow
 * on an idle machine — the whole file runs in ~4s — but it is the only
 * CPU-bound file in the suite, and this repo has already been bitten by
 * load-induced `waitFor` flakes on shared runners (see src/test/setup.ts). A
 * timeout only bounds a HANGING test; a passing one still finishes the moment
 * it is done, so there is no cost to being generous and a real cost to a
 * conformance failure that turns out to have been a busy CPU.
 */
const TIMEOUT = 300_000;

const SHORT_NAMES = PALETTE_SHAPES.map((s) => s.name);

function polyfill(): void {
  // jsdom implements no SVG layout, and every mermaid shape handler sizes
  // itself from the label's bbox. Fixed values make geometry comparable.
  const proto = (globalThis as unknown as { SVGElement: { prototype: Record<string, unknown> } })
    .SVGElement.prototype;
  proto.getBBox = () => ({ x: 0, y: 0, width: 60, height: 20 });
  proto.getComputedTextLength = () => 60;
}

function init(): void {
  polyfill();
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', handDrawnSeed: 1 });
}

async function throwsOn(shape: string): Promise<boolean> {
  try {
    await mermaid.parse(`flowchart TD\n  A@{ shape: ${shape} }\n  A --> B`);
    return false;
  } catch {
    return true;
  }
}

interface Vertex {
  id: string;
}

/** mermaid's own vertex map for a document — the phantom-node oracle. */
async function vertexIds(code: string): Promise<Set<string>> {
  const { mermaidAPI } = mermaid as unknown as {
    mermaidAPI: { getDiagramFromText: (t: string) => Promise<{ db: unknown }> };
  };
  const diagram = await mermaidAPI.getDiagramFromText(code);
  const db = diagram.db as { getVertices: () => Map<string, Vertex> };
  return new Set(db.getVertices().keys());
}

let seq = 0;

/** The drawn geometry of node `A`, independent of layout position. */
async function geometry(code: string): Promise<string> {
  seq += 1;
  const host = document.createElement('div');
  document.body.appendChild(host);
  const { svg } = await mermaid.render(`conf${seq}`, code, host);
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const group = [...doc.querySelectorAll('g.node')].find((n) =>
    (n.getAttribute('id') ?? '').includes('-A-'),
  );
  if (group === undefined) return 'NO-NODE';
  const parts: string[] = [];
  for (const child of group.querySelectorAll('*')) {
    if (!['path', 'rect', 'circle', 'polygon', 'ellipse', 'line'].includes(child.tagName)) continue;
    const attrs = ['d', 'points', 'r', 'width', 'height', 'x1', 'y1', 'x2', 'y2', 'rx']
      .concat('stroke-dasharray')
      .map((a) => child.getAttribute(a))
      .filter((v) => v !== null)
      .join('|');
    if (attrs !== '') parts.push(`${child.tagName}:${attrs}`);
  }
  return parts.join(' ~ ') || 'EMPTY';
}

/** The node forms `setNodeShape` has to survive, one per structural hazard. */
const FORMS: [string, string][] = [
  ['inline-bracket', 'flowchart TD\n  A[Start] --> B'],
  ['bare-ref', 'flowchart TD\n  A --> B'],
  ['definition-line', 'flowchart TD\n  A[Start]\n  A --> B'],
  ['meta-with-shape', 'flowchart TD\n  A --> B\n  A@{ shape: cyl }'],
  ['meta-unknown-keys', 'flowchart TD\n  A --> B\n  A@{ label: "X, Y", pos: t, w: 40 }'],
  ['bracket-plus-style', 'flowchart TD\n  A((Start)) --> B\n  style A fill:#f96'],
  ['in-subgraph', 'flowchart TD\n  subgraph S\n    A --> B\n  end'],
  ['two-meta-lines', 'flowchart TD\n  A --> B\n  A@{ shape: cloud }\n  A@{ shape: hex }'],
  ['frontmatter', '---\nconfig:\n  layout: dagre\n---\nflowchart TD\n  A --> B'],
  ['edge-id', 'flowchart TD\n  A e1@--> B\n  e1@{ animate: true }'],
  [
    'comment-and-class',
    'flowchart TD\n  %% keep\n  A --> B\n  classDef hot fill:#f96\n  class A hot',
  ],
  ['chain-and-group', 'flowchart TD\n  A & Z --> B --> C'],
];

describe('shape registry conformance (M29.32)', () => {
  it(
    'every name setNodeShape may write is one the bundled mermaid accepts',
    async () => {
      init();
      const rejected: string[] = [];
      for (const name of VALID_SHAPES) {
        if (await throwsOn(name)) rejected.push(name);
      }
      expect(rejected).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    'the deliberate exclusions really do throw',
    async () => {
      init();
      // `person` is the version tripwire: it is valid in 11.16.1 and invalid in
      // the 11.16.0 we bundle. When this line starts failing, mermaid moved —
      // re-measure the registry and grow SHAPE_ALIASES/PALETTE_SHAPES to match.
      for (const bad of ['person', 'ellipse', 'blob', 'Circle', 'lean_right', 'squareRect']) {
        expect(await throwsOn(bad), bad).toBe(true);
        expect(VALID_SHAPES.has(bad), bad).toBe(false);
      }
    },
    TIMEOUT,
  );

  it(
    'the palette is 48 genuinely different shapes, not aliases of each other',
    async () => {
      init();
      const seen = new Map<string, string>();
      for (const name of SHORT_NAMES) {
        const g = await geometry(`flowchart TD\n  A@{ shape: ${name}, label: "A" }`);
        expect(g, name).not.toBe('NO-NODE');
        expect(g, name).not.toBe('EMPTY');
        const twin = seen.get(g);
        expect(twin === undefined ? name : `${name} draws exactly like ${twin}`).toBe(name);
        seen.set(g, name);
      }
      expect(seen.size).toBe(SHORT_NAMES.length);
    },
    TIMEOUT,
  );

  it(
    'every alias draws the shape its short name draws',
    async () => {
      init();
      const wrong: string[] = [];
      for (const [short, aliases] of Object.entries(SHAPE_ALIASES)) {
        if (aliases.length === 0) continue;
        const want = await geometry(`flowchart TD\n  A@{ shape: ${short}, label: "A" }`);
        for (const alias of aliases) {
          const got = await geometry(`flowchart TD\n  A@{ shape: ${alias}, label: "A" }`);
          if (got !== want) wrong.push(`${alias} != ${short}`);
        }
      }
      expect(wrong).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    'setNodeShape emits a document mermaid parses, over every node form',
    async () => {
      init();
      const broken: string[] = [];
      for (const [form, src] of FORMS) {
        const base = parseFlowchart(src);
        expect(base, form).not.toBeNull();
        for (const name of SHORT_NAMES) {
          const out = serialize(setNodeShape(base!, 'A', name));
          try {
            await mermaid.parse(out);
          } catch (err) {
            broken.push(`${form}/${name}: ${(err as Error).message.split('\n')[0]} — ${out}`);
          }
        }
      }
      expect(broken).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    'setNodeShape never invents a node and never hides one',
    async () => {
      init();
      const wrong: string[] = [];
      for (const [form, src] of FORMS) {
        const base = parseFlowchart(src)!;
        for (const name of SHORT_NAMES) {
          const out = serialize(setNodeShape(base, 'A', name));
          const reparsed = parseFlowchart(out);
          if (reparsed === null) {
            wrong.push(`${form}/${name}: our own parser refuses the output`);
            continue;
          }
          const ours = new Set(nodes(reparsed).keys());
          const theirs = await vertexIds(out);
          for (const id of ours) if (!theirs.has(id)) wrong.push(`${form}/${name}: phantom ${id}`);
          for (const id of theirs) if (!ours.has(id)) wrong.push(`${form}/${name}: unseen ${id}`);
        }
      }
      expect(wrong).toEqual([]);
    },
    TIMEOUT,
  );

  it('an illegal name leaves every form byte-identical', () => {
    for (const [form, src] of FORMS) {
      const base = parseFlowchart(src)!;
      for (const bad of [
        'person',
        'ellipse',
        'blob',
        'Circle',
        'DIAM',
        'lean_right',
        '',
        'toString',
        'constructor',
      ]) {
        expect(serialize(setNodeShape(base, 'A', bad)), `${form}/${bad}`).toBe(src);
      }
    }
  });

  it('every output round-trips through our own parser byte-for-byte', () => {
    for (const [form, src] of FORMS) {
      const base = parseFlowchart(src)!;
      for (const name of SHORT_NAMES) {
        const out = serialize(setNodeShape(base, 'A', name));
        const again = parseFlowchart(out);
        expect(again, `${form}/${name}`).not.toBeNull();
        expect(serialize(again!), `${form}/${name}`).toBe(out);
      }
    }
  });

  it('the edit stays surgical: one line changed, at most one added', () => {
    for (const [form, src] of FORMS) {
      const base = parseFlowchart(src)!;
      for (const name of SHORT_NAMES) {
        const before = src.split('\n');
        const after = serialize(setNodeShape(base, 'A', name)).split('\n');
        expect(after.length - before.length, `${form}/${name} added lines`).toBeLessThanOrEqual(1);
        expect(after.length - before.length, `${form}/${name} lost lines`).toBeGreaterThanOrEqual(
          0,
        );
        // Besides the (at most one) inserted line, at most ONE line may differ.
        const cuts = after.length === before.length ? [-1] : [...before.keys(), before.length];
        const best = Math.min(
          ...cuts.map((k) => {
            const trial = k === -1 ? after : [...after.slice(0, k), ...after.slice(k + 1)];
            return before.filter((l, i) => l !== trial[i]).length;
          }),
        );
        expect(best, `${form}/${name} rewrote ${best} lines`).toBeLessThanOrEqual(1);
      }
    }
  });
});
