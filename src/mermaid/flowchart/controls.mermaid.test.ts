import { describe, expect, it } from 'vitest';
import mermaid from 'mermaid';
import {
  edges,
  nodeStyle,
  nodes,
  parseFlowchart,
  serialize,
  type EdgeHead,
  type EdgeStroke,
} from './model';
import { setEdgeAnimate, setEdgeArrow, setNodeStyle } from './ops';
import { STYLE_SWATCHES } from './NodeStyleMenu';

/**
 * Conformance for what the M29.33 controls can EMIT, against the mermaid the
 * app actually bundles — the sibling of `shapes.mermaid.test.ts`, and here for
 * the same reason: the colour menu and the edge controls are a closed set of
 * claims about mermaid (twelve hexes are legal `style` values; five heads ×
 * three strokes are legal arrows; an animated edge keeps a clickable path),
 * and a claim that drifts is a claim that kills the render or silently strands
 * a control.
 *
 * Every check is over the FULL cross product a user can reach by clicking, on
 * every structural form of node/edge line the model owns — because a value
 * that parses on `A[Start] --> B` can still be wrong inside a subgraph, under
 * frontmatter, or against a second `style` line.
 *
 * The one thing asserted at RENDER level rather than parse level is that the
 * colour we wrote is the colour painted. Parsing proves mermaid accepted the
 * line; only the svg proves the declaration that renders is ours — which is
 * the whole point of `setNodeStyle` targeting the last line for a key.
 */

/** Same budget and reasoning as shapes.mermaid.test.ts: CPU-bound, shared runners. */
const TIMEOUT = 60_000;

function init(): void {
  // jsdom implements no SVG layout, and every mermaid shape sizes itself from
  // the label's bbox.
  const proto = (globalThis as unknown as { SVGElement: { prototype: Record<string, unknown> } })
    .SVGElement.prototype;
  proto.getBBox = () => ({ x: 0, y: 0, width: 60, height: 20 });
  proto.getComputedTextLength = () => 60;
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', handDrawnSeed: 1 });
}

/** The parse error message, or null when mermaid accepts the document. */
async function parseError(code: string): Promise<string | null> {
  try {
    await mermaid.parse(code);
    return null;
  } catch (err) {
    return (err as Error).message.split('\n')[0];
  }
}

/** mermaid's own vertex map for a document — the phantom-node oracle. */
async function vertexIds(code: string): Promise<Set<string>> {
  const { mermaidAPI } = mermaid as unknown as {
    mermaidAPI: { getDiagramFromText: (t: string) => Promise<{ db: unknown }> };
  };
  const diagram = await mermaidAPI.getDiagramFromText(code);
  const db = diagram.db as { getVertices: () => Map<string, { id: string }> };
  return new Set(db.getVertices().keys());
}

let seq = 0;

async function renderSvg(code: string): Promise<string> {
  seq += 1;
  const host = document.createElement('div');
  document.body.appendChild(host);
  try {
    const { svg } = await mermaid.render(`ctl${seq}`, code, host);
    return svg;
  } finally {
    host.remove();
  }
}

/** Everything painted onto node A's own elements, as one string. */
function paintedStyles(svg: string): string {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const group = [...doc.querySelectorAll('g.node')].find((g) =>
    (g.getAttribute('id') ?? '').includes('-A-'),
  );
  return [...(group?.querySelectorAll('*') ?? [])]
    .map((el) => el.getAttribute('style') ?? '')
    .join(' ');
}

/** How many source lines an edit rewrote, ignoring at most one inserted line. */
function linesRewritten(before: string[], after: string[]): number {
  const cuts = after.length === before.length ? [-1] : [...before.keys(), before.length];
  return Math.min(
    ...cuts.map((k) => {
      const trial = k === -1 ? after : [...after.slice(0, k), ...after.slice(k + 1)];
      return before.filter((l, i) => l !== trial[i]).length;
    }),
  );
}

/** Node forms a colour write has to survive, one per structural hazard. */
const STYLE_FORMS: [string, string][] = [
  ['inline-bracket', 'flowchart TD\n  A[Start] --> B'],
  ['bare-ref', 'flowchart TD\n  A --> B'],
  ['definition-line', 'flowchart TD\n  A[Start]\n  A --> B'],
  ['meta-shape', 'flowchart TD\n  A --> B\n  A@{ shape: cyl }'],
  ['existing-style', 'flowchart TD\n  A[Start] --> B\n  style A fill:#f96'],
  ['two-style-lines', 'flowchart TD\n  A --> B\n  style A fill:#f96\n  style A fill:#0a0'],
  ['unknown-keys', 'flowchart TD\n  A --> B\n  style A stroke-width:2px,rx:4,fill:#f96'],
  ['odd-spacing', 'flowchart TD\n  A --> B\n  style A  fill: #f96 , color: #000'],
  ['in-subgraph', 'flowchart TD\n  subgraph S\n    A --> B\n  end'],
  ['frontmatter', '---\nconfig:\n  layout: dagre\n---\nflowchart TD\n  A --> B'],
  [
    'comment-and-class',
    'flowchart TD\n  %% keep\n  A --> B\n  classDef hot fill:#f96\n  class A hot',
  ],
  ['chain-and-group', 'flowchart TD\n  A & Z --> B --> C'],
  ['edge-id', 'flowchart TD\n  A e1@--> B\n  e1@{ animate: true }'],
];

/** The three declarations the menu writes. mermaid's text-colour key is `color`. */
const KEYS = ['fill', 'stroke', 'color'];

/**
 * The forms where "which declaration renders" could differ from "which
 * declaration we wrote": a second style line for the same id, a style line
 * that has to live inside a subgraph block, and a node whose colour also comes
 * from a classDef.
 */
const PAINT_FORMS = ['inline-bracket', 'two-style-lines', 'in-subgraph', 'comment-and-class'];

describe('node colour conformance (M29.33)', () => {
  it(
    'every swatch on every node form parses, round-trips, invents nothing, and repeats',
    async () => {
      init();
      const bad: string[] = [];
      for (const [form, src] of STYLE_FORMS) {
        const base = parseFlowchart(src);
        expect(base, form).not.toBeNull();
        const baseVertices = await vertexIds(src);
        for (const key of KEYS) {
          for (const hex of STYLE_SWATCHES) {
            const tag = `${form}/${key}:${hex}`;
            const out = serialize(setNodeStyle(base!, 'A', { [key]: hex }));
            const err = await parseError(out);
            if (err !== null) {
              bad.push(`${tag}: PARSE ${err} — ${out}`);
              continue;
            }
            const again = parseFlowchart(out);
            if (again === null || serialize(again) !== out) {
              bad.push(`${tag}: ROUND-TRIP — ${out}`);
              continue;
            }
            if (serialize(setNodeStyle(again, 'A', { [key]: hex })) !== out) {
              bad.push(`${tag}: NOT IDEMPOTENT`);
            }
            if (nodeStyle(again, 'A')[key] !== hex) bad.push(`${tag}: reads back wrong`);
            const after = await vertexIds(out);
            const ours = new Set(nodes(again).keys());
            for (const id of after) {
              if (!baseVertices.has(id)) bad.push(`${tag}: phantom ${id}`);
              if (!ours.has(id)) bad.push(`${tag}: we miss ${id}`);
            }
            for (const id of baseVertices) if (!after.has(id)) bad.push(`${tag}: lost ${id}`);
            const rewritten = linesRewritten(src.split('\n'), out.split('\n'));
            if (rewritten > 1) bad.push(`${tag}: rewrote ${rewritten} lines`);
          }
        }
      }
      expect(bad).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    'the colour we wrote is the colour mermaid paints',
    async () => {
      init();
      const bad: string[] = [];
      for (const [form, src] of STYLE_FORMS) {
        if (!PAINT_FORMS.includes(form)) continue;
        const base = parseFlowchart(src)!;
        // The full swatch list on one form (a bad hex is form-independent),
        // and both ends of the ramp on the hazardous ones.
        const swatches =
          form === 'inline-bracket' ? STYLE_SWATCHES : [STYLE_SWATCHES[0], STYLE_SWATCHES.at(-1)!];
        for (const key of KEYS) {
          for (const hex of swatches) {
            const out = serialize(setNodeStyle(base, 'A', { [key]: hex }));
            const painted = paintedStyles(await renderSvg(out));
            if (!painted.includes(`${key}:${hex}`) && !painted.includes(`${key}: ${hex}`)) {
              bad.push(`${form} ${key}:${hex} not painted — ${painted.slice(0, 200)}`);
            }
          }
        }
      }
      expect(bad).toEqual([]);
    },
    TIMEOUT,
  );

  it('declarations we do not own survive, in order', () => {
    const base = parseFlowchart(
      'flowchart TD\n  A --> B\n  style A stroke-width:2px,rx:4,fill:#f96',
    )!;
    // A key already there is replaced IN PLACE; a new one is appended.
    expect(serialize(setNodeStyle(base, 'A', { fill: '#eef1fe' }))).toBe(
      'flowchart TD\n  A --> B\n  style A stroke-width:2px,rx:4,fill:#eef1fe',
    );
    expect(serialize(setNodeStyle(base, 'A', { color: '#de3b4e' }))).toBe(
      'flowchart TD\n  A --> B\n  style A stroke-width:2px,rx:4,fill:#f96,color:#de3b4e',
    );
    // And a clear takes only its own key with it.
    expect(serialize(setNodeStyle(base, 'A', { fill: null }))).toBe(
      'flowchart TD\n  A --> B\n  style A stroke-width:2px,rx:4',
    );
  });

  it(
    'a clear leaves a document mermaid still parses, with the key gone everywhere',
    async () => {
      init();
      const bad: string[] = [];
      for (const [form, src] of STYLE_FORMS) {
        const base = parseFlowchart(src)!;
        for (const key of KEYS) {
          const out = serialize(setNodeStyle(base, 'A', { [key]: null }));
          const err = await parseError(out);
          if (err !== null) bad.push(`${form}/clear ${key}: PARSE ${err} — ${out}`);
          const again = parseFlowchart(out);
          if (again === null || serialize(again) !== out) {
            bad.push(`${form}/clear ${key}: ROUND-TRIP — ${out}`);
          } else if (Object.keys(nodeStyle(again, 'A')).includes(key)) {
            bad.push(`${form}/clear ${key}: still declared — ${out}`);
          }
        }
      }
      expect(bad).toEqual([]);
    },
    TIMEOUT,
  );
});

/** Edge forms an arrow rewrite has to survive, one per structural hazard. */
const EDGE_FORMS: [string, string][] = [
  ['plain', 'flowchart TD\n  A[Start] --> B[End]'],
  ['labeled', 'flowchart TD\n  A -->|go| B'],
  ['thick-double', 'flowchart TD\n  A <==> B'],
  ['dotted', 'flowchart TD\n  A -.-> B'],
  ['circle-double', 'flowchart TD\n  A o--o B'],
  ['cross-double', 'flowchart TD\n  A x--x B'],
  ['long', 'flowchart TD\n  A ----> B'],
  ['open', 'flowchart TD\n  A --- B'],
  ['chain', 'flowchart TD\n  A --> B --> C'],
  ['group', 'flowchart TD\n  A & Z --> B'],
  ['with-id', 'flowchart TD\n  A e1@--> B\n  e1@{ animate: true }'],
  ['in-subgraph', 'flowchart TD\n  subgraph S\n    A --> B\n  end'],
  ['invisible', 'flowchart TD\n  A ~~~ B'],
  ['frontmatter', '---\nconfig:\n  layout: dagre\n---\nflowchart TD\n  A --> B'],
];

/** Exactly what the controls can reach: `invisible` is deliberately not offered. */
const HEADS: EdgeHead[] = ['arrow', 'open', 'circle', 'cross', 'double'];
const STROKES: EdgeStroke[] = ['normal', 'thick', 'dotted'];

describe('edge control conformance (M29.33)', () => {
  it(
    'every head and stroke on every edge form parses, renders, and reads back',
    async () => {
      init();
      const bad: string[] = [];
      for (const [form, src] of EDGE_FORMS) {
        const base = parseFlowchart(src)!;
        const edge = edges(base)[0];
        expect(edge, form).toBeDefined();
        const baseVertices = await vertexIds(src);
        const patches: [string, { head?: EdgeHead; stroke?: EdgeStroke }][] = [
          ...HEADS.map((h): [string, { head: EdgeHead }] => [`head:${h}`, { head: h }]),
          ...STROKES.map((s): [string, { stroke: EdgeStroke }] => [`stroke:${s}`, { stroke: s }]),
        ];
        for (const [what, patch] of patches) {
          const tag = `${form}/${what}`;
          const out = serialize(setEdgeArrow(base, edge, patch));
          const err = await parseError(out);
          if (err !== null) {
            bad.push(`${tag}: PARSE ${err} — ${JSON.stringify(out)}`);
            continue;
          }
          const again = parseFlowchart(out);
          if (again === null || serialize(again) !== out) {
            bad.push(`${tag}: ROUND-TRIP — ${JSON.stringify(out)}`);
            continue;
          }
          // The control's own promise: what it set is what the model reads.
          const back = edges(again)[0];
          if (patch.head !== undefined && back.arrow.head !== patch.head) {
            bad.push(`${tag}: head reads back as ${back.arrow.head} — ${out}`);
          }
          if (patch.stroke !== undefined && back.arrow.stroke !== patch.stroke) {
            bad.push(`${tag}: stroke reads back as ${back.arrow.stroke} — ${out}`);
          }
          if (serialize(setEdgeArrow(again, back, patch)) !== out) {
            bad.push(`${tag}: NOT IDEMPOTENT`);
          }
          const after = await vertexIds(out);
          for (const id of after) if (!baseVertices.has(id)) bad.push(`${tag}: phantom ${id}`);
          for (const id of baseVertices) if (!after.has(id)) bad.push(`${tag}: lost ${id}`);
          try {
            const svg = await renderSvg(out);
            if (!svg.includes('flowchart-link')) bad.push(`${tag}: no link path rendered`);
          } catch (e) {
            bad.push(`${tag}: RENDER ${(e as Error).message.split('\n')[0]}`);
          }
        }
      }
      expect(bad).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    'animate is two-way: the animated edge still renders a path the binding can find',
    async () => {
      init();
      const bad: string[] = [];
      for (const [form, src] of EDGE_FORMS) {
        const base = parseFlowchart(src)!;
        const edge = edges(base)[0];
        const baseVertices = await vertexIds(src);

        const on = serialize(setEdgeAnimate(base, edge, true));
        const errOn = await parseError(on);
        if (errOn !== null) {
          bad.push(`${form}/on: PARSE ${errOn} — ${JSON.stringify(on)}`);
          continue;
        }
        const onModel = parseFlowchart(on);
        if (onModel === null || serialize(onModel) !== on) {
          bad.push(`${form}/on: ROUND-TRIP — ${JSON.stringify(on)}`);
          continue;
        }
        const after = await vertexIds(on);
        for (const id of after) if (!baseVertices.has(id)) bad.push(`${form}/on: phantom ${id}`);
        for (const id of baseVertices) if (!after.has(id)) bad.push(`${form}/on: lost ${id}`);
        const onEdge = edges(onModel)[0];
        if (serialize(setEdgeAnimate(onModel, onEdge, true)) !== on) {
          bad.push(`${form}/on: NOT IDEMPOTENT`);
        }

        // The two-way proof. Minting an id RENAMES the rendered path from
        // `L_<from>_<to>_<n>` to the id verbatim (getEdgeId, utils.ts:946), so
        // without svgBinding's by-id arm (M29.31) the edge you just animated
        // would stop being clickable and the toggle would be one-way.
        const links = [
          ...new DOMParser()
            .parseFromString(await renderSvg(on), 'image/svg+xml')
            .querySelectorAll('path.flowchart-link'),
        ].map((p) => p.id);
        if (form === 'invisible') {
          // Measured on 11.16.0: an invisible link's path carries
          // `edge-thickness-invisible`, NOT `flowchart-link` — so it is
          // unreachable from the canvas, which is why the UI offers no
          // invisible stroke to get back out of.
          if (links.length !== 0) bad.push(`${form}: clickable after all — ${links.join(',')}`);
        } else if (onEdge.id !== null && !links.some((i) => i.endsWith(`-${onEdge.id}`))) {
          bad.push(`${form}/on: no path for id ${onEdge.id} — ${links.join(',')}`);
        }

        const off = serialize(setEdgeAnimate(onModel, onEdge, false));
        const errOff = await parseError(off);
        if (errOff !== null) bad.push(`${form}/off: PARSE ${errOff} — ${JSON.stringify(off)}`);
        const offModel = parseFlowchart(off);
        if (offModel === null || serialize(offModel) !== off) {
          bad.push(`${form}/off: ROUND-TRIP — ${JSON.stringify(off)}`);
        } else if (edges(offModel)[0].id !== null && edgeStillAnimated(off)) {
          bad.push(`${form}/off: still animated — ${off}`);
        }
      }
      expect(bad).toEqual([]);
    },
    TIMEOUT,
  );
});

/** Cheap textual check that no `animate: true` survived a toggle off. */
function edgeStillAnimated(code: string): boolean {
  return /animate:\s*true/.test(code);
}
