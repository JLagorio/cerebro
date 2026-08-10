import { describe, expect, it } from 'vitest';
import mermaid from 'mermaid';
import { parseFlowchart, serialize } from './model';
import { setNodeIcon } from './ops';
import { NODE_GROUP_SELECTOR } from './svgBinding';

/**
 * Conformance, not unit testing (M29.35) — the icon twin of
 * `shapes.mermaid.test.ts`, and it exists for the same reason: `setNodeIcon`
 * is not a design, it is a set of CLAIMS ABOUT MERMAID, and the last time a
 * claim drifted a version (`shape: person`, 11.16.1-only) it would have turned
 * every click into a blank diagram.
 *
 * The claims measured here, all against the bundled 11.16.0:
 *
 * - `form: rounded` and `pos: b` are real: `getTypeFromVertex` maps a vertex
 *   with an icon and `form: rounded` to the `iconRounded` shape, and that shape
 *   has to BE in the registry. (`icon`, `iconSquare`, `iconCircle`,
 *   `iconRounded` all are — proven by the render, not by reading a .d.ts.)
 * - An icon whose PACK IS NOT REGISTERED still renders. This is the safety
 *   claim the whole lazy-loader design rests on: registration happens in
 *   render.ts, this file imports mermaid raw with no packs at all, and the
 *   diagram must still come out as an svg rather than a thrown error.
 * - **Two meta lines for one node fold PER KEY with the LAST value winning.**
 *   This is the one `setNodeIcon` had to get right — three separate Stage E
 *   controls targeted the FIRST matching line where mermaid resolves the LAST,
 *   each a silent no-op. So a set goes to the last line already carrying
 *   `icon`, and a clear strips every line.
 * - An icon BEATS a shape: `getTypeFromVertex` checks `vertex.icon` before
 *   `vertex.type`, so `A@{ shape: cyl, icon: … }` draws the icon, not the
 *   cylinder. The UI says so instead of pretending both apply.
 */

const TIMEOUT = 60_000;

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
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', handDrawnSeed: 1 });
}

interface Vertex {
  icon?: string;
  form?: string;
  pos?: string;
  type?: string;
}

/** mermaid's own vertex ids for a document — the "did a node vanish" oracle. */
async function vertexIds(code: string): Promise<Set<string>> {
  const { mermaidAPI } = mermaid as unknown as {
    mermaidAPI: { getDiagramFromText: (t: string) => Promise<{ db: unknown }> };
  };
  const diagram = await mermaidAPI.getDiagramFromText(code);
  const db = diagram.db as { getVertices: () => Map<string, Vertex> };
  return new Set(db.getVertices().keys());
}

/** mermaid's own resolved vertex for `id` — the oracle for "which line won". */
async function vertex(code: string, id: string): Promise<Vertex | undefined> {
  const { mermaidAPI } = mermaid as unknown as {
    mermaidAPI: { getDiagramFromText: (t: string) => Promise<{ db: unknown }> };
  };
  const diagram = await mermaidAPI.getDiagramFromText(code);
  const db = diagram.db as { getVertices: () => Map<string, Vertex> };
  return db.getVertices().get(id);
}

let seq = 0;

async function renderOk(code: string): Promise<string> {
  seq += 1;
  const host = document.createElement('div');
  document.body.appendChild(host);
  try {
    const { svg } = await mermaid.render(`icon${seq}`, code, host);
    return svg;
  } finally {
    host.remove();
  }
}

/** The node forms `setNodeIcon` has to survive, one per structural hazard. */
const FORMS: [string, string][] = [
  ['inline-bracket', 'flowchart TD\n  A[Start] --> B'],
  ['bare-ref', 'flowchart TD\n  A --> B'],
  ['definition-line', 'flowchart TD\n  A[Start]\n  A --> B'],
  ['meta-with-shape', 'flowchart TD\n  A --> B\n  A@{ shape: cyl }'],
  ['meta-with-icon', 'flowchart TD\n  A --> B\n  A@{ icon: "lucide:zap", form: circle, pos: t }'],
  // A's ONLY line — mermaid's own documented icon-node form, and the one that
  // used to lose the node on a clear (M29.35 review).
  ['lone-icon-meta', 'flowchart TD\n  A@{ icon: "lucide:rocket", form: rounded, pos: b }'],
  ['two-meta-lines', 'flowchart TD\n  A --> B\n  A@{ icon: "lucide:zap" }\n  A@{ shape: hex }'],
  ['in-subgraph', 'flowchart TD\n  subgraph S\n    A --> B\n  end'],
  ['frontmatter', '---\nconfig:\n  layout: dagre\n---\nflowchart TD\n  A --> B'],
  ['bracket-plus-style', 'flowchart TD\n  A((Start)) --> B\n  style A fill:#f96'],
];

describe('icon conformance (M29.35)', () => {
  it(
    'the icon meta line we write renders — every form, no pack registered',
    async () => {
      init();
      for (const form of ['rounded', 'square', 'circle']) {
        const svg = await renderOk(
          `flowchart TD\n  A@{ icon: "lucide:rocket", form: ${form}, pos: b }\n  A --> B`,
        );
        expect(svg.startsWith('<svg'), form).toBe(true);
      }
      // No `form` at all is the bare `icon` shape, and `pos: t` is legal too.
      const bare = await renderOk('flowchart TD\n  A@{ icon: "lucide:rocket", pos: t }\n  A --> B');
      expect(bare.startsWith('<svg')).toBe(true);
      // An icon nobody has ever heard of degrades to mermaid's placeholder box
      // rather than taking the diagram down with it.
      const junk = await renderOk('flowchart TD\n  A@{ icon: "nosuch:nope" }\n  A --> B');
      expect(junk.startsWith('<svg')).toBe(true);
    },
    TIMEOUT,
  );

  it(
    'two meta lines fold per key, LAST value winning — the line setNodeIcon must write to',
    async () => {
      init();
      const v = await vertex(
        'flowchart TD\n  A --> B\n  A@{ icon: "lucide:zap", form: circle }\n  A@{ icon: "lucide:rocket" }',
        'A',
      );
      expect(v?.icon).toBe('lucide:rocket');
      // …and a key only the FIRST line carries survives, which is why a clear
      // has to strip every line rather than just the winner.
      expect(v?.form).toBe('circle');
    },
    TIMEOUT,
  );

  it(
    'an icon beats a shape on the same node',
    async () => {
      init();
      const v = await vertex(
        'flowchart TD\n  A --> B\n  A@{ shape: cyl, icon: "lucide:zap" }',
        'A',
      );
      expect(v?.icon).toBe('lucide:zap');
      expect(v?.type).toBe('cyl');
      // Both are recorded, but getTypeFromVertex checks `icon` first, so the
      // cylinder never draws. Proven by the shape a node WITHOUT the icon gets.
      const withIcon = await renderOk('flowchart TD\n  A@{ shape: cyl, icon: "lucide:zap" }');
      const withoutIcon = await renderOk('flowchart TD\n  A@{ shape: cyl }');
      expect(withIcon).not.toBe(withoutIcon);
    },
    TIMEOUT,
  );

  it(
    'setNodeIcon emits a document mermaid parses, over every node form',
    async () => {
      init();
      const broken: string[] = [];
      for (const [form, src] of FORMS) {
        const base = parseFlowchart(src);
        expect(base, form).not.toBeNull();
        for (const icon of ['lucide:rocket', null]) {
          const out = serialize(setNodeIcon(base!, 'A', icon));
          try {
            await mermaid.parse(out);
          } catch (err) {
            broken.push(`${form}/${icon}: ${(err as Error).message.split('\n')[0]} — ${out}`);
          }
        }
      }
      expect(broken).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    'clearing an icon never costs mermaid a vertex',
    async () => {
      init();
      const missing: string[] = [];
      for (const [form, src] of FORMS) {
        const before = await vertexIds(src);
        const after = await vertexIds(serialize(setNodeIcon(parseFlowchart(src)!, 'A', null)));
        for (const id of before) if (!after.has(id)) missing.push(`${form}: lost ${id}`);
      }
      expect(missing).toEqual([]);
    },
    TIMEOUT,
  );

  // The claim the whole feature rests on, asserted against the REAL pack
  // rather than a mock: render.test.ts stubs both mermaid and the pack, so a
  // wrong export or a wrong `name` would leave every icon in the app drawing
  // the placeholder box with a green suite. This registers the same pack
  // render.ts registers, the same way, and looks for the glyph's own bytes.
  it(
    'the pack render.ts registers really does draw the glyph it names',
    async () => {
      init();
      const CODE = 'flowchart TD\n  A@{ icon: "lucide:rocket", form: rounded }\n  A --> B';
      const unregistered = await renderOk(CODE);
      const { icons } = await import('@iconify-json/lucide');
      const paths = [...icons.icons.rocket.body.matchAll(/d="([^"]+)"/g)].map((m) => m[1]);
      expect(paths.length).toBeGreaterThan(0);
      // Nothing of the glyph is there before registration — the placeholder
      // box, exactly as the safety claim above says, and no error.
      for (const d of paths) expect(unregistered.includes(d), `unregistered drew ${d}`).toBe(false);

      // The registration render.ts performs, byte for byte.
      mermaid.registerIconPacks([
        { name: 'lucide', loader: () => import('@iconify-json/lucide').then((m) => m.icons) },
      ]);
      const registered = await renderOk(CODE);
      for (const d of paths) expect(registered.includes(d), `registered lost ${d}`).toBe(true);
    },
    TIMEOUT,
  );

  /**
   * The claim M29.35 never made and M29.39 had to pay for: an icon node is
   * still a node the EDITOR can reach.
   *
   * Mermaid draws it as `<g class="icon-shape default">`, never `g.node` — all
   * four icon handlers pass that literal to labelHelper (icon.ts:22,
   * iconSquare.ts:26, iconCircle.ts:22, iconRounded.ts:26). `svgBinding`
   * matched `g.node` alone, so putting an icon on a node deleted every canvas
   * affordance it had, the one that removes the icon included. The id scheme is
   * unchanged, which is why the fix is a selector and not a new contract; this
   * asserts the selector against real output so a version that renames the
   * class fails here rather than in the app.
   */
  it(
    'an icon node is still bindable — mermaid draws it as g.icon-shape, not g.node',
    async () => {
      init();
      for (const form of ['square', 'circle', 'rounded']) {
        const svg = await renderOk(
          `flowchart TD\n  A[Start] --> B\n  A@{ icon: "lucide:rocket", form: ${form} }`,
        );
        const host = document.createElement('div');
        // Test fixture: mermaid's own sanitized output, rendered above.
        host.innerHTML = svg;
        const group = [...host.querySelectorAll('g[id]')].find((g) =>
          (g.getAttribute('id') ?? '').includes('flowchart-A-'),
        );
        expect(group?.getAttribute('class'), form).toBe('icon-shape default');
        expect(host.querySelectorAll(NODE_GROUP_SELECTOR).length, form).toBe(2);
      }
    },
    TIMEOUT,
  );

  it('every output round-trips through our own parser byte-for-byte', () => {
    for (const [form, src] of FORMS) {
      const base = parseFlowchart(src)!;
      for (const icon of ['lucide:rocket', 'lucide:zap', null]) {
        const out = serialize(setNodeIcon(base, 'A', icon));
        const again = parseFlowchart(out);
        expect(again, `${form}/${icon}`).not.toBeNull();
        expect(serialize(again!), `${form}/${icon}`).toBe(out);
      }
    }
  });
});
