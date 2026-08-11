import { describe, expect, it } from 'vitest';
import mermaid from 'mermaid';
import { nodeLinks, nodes, parseFlowchart, serialize } from './model';
import { setNodeLink } from './ops';
import { bindFlowchartSvg } from './svgBinding';

/**
 * Conformance, not unit testing (M29.36) — the click-line twin of
 * `icons.mermaid.test.ts`, and it exists because the plan this task came from
 * asserted five things about `click` that turned out to be false. Everything
 * below is a CLAIM ABOUT THE BUNDLED MERMAID (11.16.0), measured rather than
 * read out of a grammar file, because the vendored source is 11.16.1 and this
 * wave has already been bitten once by that gap.
 *
 * The claims:
 *
 * - mermaid's whitespace rules for `click` are exact and unforgiving. The
 *   lexer pops its click state on ONE whitespace character
 *   (`<click>[\s\n]`, flow.jison:112) and the grammar has no rule for a SPACE
 *   after the target string, so `click A  "x"`, a single TRAILING space, and
 *   an empty `""` each kill the whole diagram. `CLICK_LINE` is that strict on
 *   purpose: owning a line the renderer rejects would make `nodeLinks` report
 *   a link on a document that cannot draw.
 * - the LAST `setLink` for an id wins, and the `href` form writes the SAME
 *   slot as the plain one — which is why `setNodeLink` places a new line below
 *   anything already claiming the id.
 * - a click line ABOVE its node's first declaration is DEAD: `setLink` only
 *   assigns to a vertex that already exists. `setNodeLink` never leaves one
 *   there.
 * - a click line MINTS NO NODE, for any id. This is the evidence behind the
 *   one refusal `setNodeLink` deliberately does not carry, and the mermaid
 *   half of the phantom-node invariant `model.test.ts` holds on our side.
 * - at `securityLevel: 'strict'` mermaid attaches no click HANDLER
 *   (`setClickFun` returns early unless the level is 'loose') but it still
 *   emits a real `<a href="…">`. The picture is NOT inert, whatever the plan
 *   said, and a relative target is live navigation inside the app.
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
  link?: string;
}

async function vertices(code: string): Promise<Map<string, Vertex>> {
  const { mermaidAPI } = mermaid as unknown as {
    mermaidAPI: { getDiagramFromText: (t: string) => Promise<{ db: unknown }> };
  };
  const diagram = await mermaidAPI.getDiagramFromText(code);
  return (diagram.db as { getVertices: () => Map<string, Vertex> }).getVertices();
}

/** True when mermaid accepts the document at all. */
async function parses(code: string): Promise<boolean> {
  try {
    await vertices(code);
    return true;
  } catch {
    return false;
  }
}

let seq = 0;

async function renderSvg(code: string): Promise<string> {
  seq += 1;
  const host = document.createElement('div');
  document.body.appendChild(host);
  try {
    const { svg } = await mermaid.render(`link${seq}`, code, host);
    return svg;
  } finally {
    host.remove();
  }
}

describe('click conformance (M29.36)', () => {
  it(
    'the whitespace rules our parser encodes are the ones mermaid enforces',
    async () => {
      init();
      const renderable = [
        'click A "u.md"',
        'click  A "u.md"', // greedy `"click"[\s]+` — several spaces are fine
        'click\tA "u.md"',
        'click A\t"u.md"',
        'click A "u.md"\r', // CRLF: normalized before the parse
        'click A " x.md"', // padding INSIDE the target is legal
      ];
      const fatal = [
        'click A  "u.md"', // two spaces before the string
        'click A "u.md" ', // ONE trailing space
        'click A "u.md"\t',
        'click A ""', // empty target
        'click A"u.md"', // no gap at all
        'click A "u.md" %% trailing comment',
        'click', // bare keyword
        'CLICK A "u.md"',
      ];
      for (const line of renderable) {
        expect([line, await parses(`flowchart TD\n  A --> B\n  ${line}`)]).toEqual([line, true]);
      }
      for (const line of fatal) {
        expect([line, await parses(`flowchart TD\n  A --> B\n  ${line}`)]).toEqual([line, false]);
      }
      // …and our parser owns exactly the renderable half, minus the one whose
      // target is blank after trimming (mermaid parses `" "` but attaches no
      // link, `utils.formatUrl` returning undefined for a blank url).
      for (const line of renderable) {
        const m = parseFlowchart(`flowchart TD\n  A --> B\n  ${line}`)!;
        expect([line, m.lines[2].parsed.kind]).toEqual([line, 'click']);
      }
      for (const line of [...fatal, 'click A "   "']) {
        const m = parseFlowchart(`flowchart TD\n  A --> B\n  ${line}`)!;
        expect([line, m.lines[2].parsed.kind]).toEqual([line, 'opaque']);
      }
    },
    TIMEOUT,
  );

  it(
    'the LAST link statement wins, and the href variant shares the slot',
    async () => {
      init();
      const link = async (code: string): Promise<string | undefined> =>
        (await vertices(code)).get('A')?.link;

      expect(
        await link('flowchart TD\n  A --> B\n  click A "a"\n  click A "b"\n  click A "c"'),
      ).toBe('c');
      // The divergence `nodeLinks` documents: mermaid resolves the href form,
      // the editor reads the plain one.
      const mixed = 'flowchart TD\n  A --> B\n  click A "plain.md"\n  click A href "href.md"';
      expect(await link(mixed)).toBe('href.md');
      expect(nodeLinks(parseFlowchart(mixed)!).get('A')?.target).toBe('plain.md');
      // Which is exactly why a NEW line goes below everything claiming the id:
      // after setNodeLink the two agree again.
      const fixed = serialize(setNodeLink(parseFlowchart(mixed)!, 'A', 'mine.md'));
      expect(await link(fixed)).toBe('mine.md');
      expect(nodeLinks(parseFlowchart(fixed)!).get('A')?.target).toBe('mine.md');
    },
    TIMEOUT,
  );

  it(
    'which statements write the link slot — the evidence behind linkWriterLines',
    async () => {
      init();
      const links = async (code: string): Promise<[unknown, unknown]> => {
        const v = await vertices(code);
        return [v.get('A')?.link, v.get('B')?.link];
      };
      const doc = (line: string): string =>
        `flowchart TD\n  A --> B\n  click B "old.md"\n  ${line}`;

      // A comma id-list writes EVERY slot in it — `setLink` does
      // `ids.split(',').forEach(…)` — so an id in the TAIL is overwritten just
      // as the head is. Reading only the head was the M29.36 review defect.
      expect(await links(doc('click A,B "both.md"'))).toEqual(['both.md', 'both.md']);
      expect(await links(doc('click B,A "both.md"'))).toEqual(['both.md', 'both.md']);
      expect(await links(doc('click A,B href "both.md"'))).toEqual(['both.md', 'both.md']);
      // …but a SPACE ends the id token, and the line reduces to a callback
      // that writes no link at all. B keeps the earlier target.
      expect(await links(doc('click A, B "x"'))).toEqual([undefined, 'old.md']);

      // `call` and a bare callback name reach `setClickEvent`, never
      // `setLink`, so they do NOT contest the slot and must not push a write
      // below them.
      const owned = 'flowchart TD\n  A --> B\n  click A "one.md"\n';
      expect((await vertices(`${owned}  click A call doThing()`)).get('A')?.link).toBe('one.md');
      expect((await vertices(`${owned}  click A doThing`)).get('A')?.link).toBe('one.md');
      // A tooltip or `_blank` variant DOES write it.
      expect((await vertices(`${owned}  click A "two.md" "tip"`)).get('A')?.link).toBe('two.md');
      expect((await vertices(`${owned}  click A href "two.md" _blank`)).get('A')?.link).toBe(
        'two.md',
      );
    },
    TIMEOUT,
  );

  it(
    'a click line above its node is dead, and setNodeLink never leaves one there',
    async () => {
      init();
      const src = 'flowchart TD\n  click A "above.md"\n  A --> B';
      expect((await vertices(src)).get('A')?.link).toBeUndefined();
      const out = serialize(setNodeLink(parseFlowchart(src)!, 'A', 'live.md'));
      expect(out).toBe('flowchart TD\n  A --> B\n  click A "live.md"');
      expect((await vertices(out)).get('A')?.link).toBe('live.md');
    },
    TIMEOUT,
  );

  it(
    'no click statement ever mints a node — the reason setNodeLink allows an unknown id',
    async () => {
      init();
      for (const line of [
        'click Z "z.md"',
        'click Z href "z.md"',
        'click Z call doThing()',
        'click A,Z "both.md"',
      ]) {
        const ids = [...(await vertices(`flowchart TD\n  A --> B\n  ${line}`)).keys()].sort();
        expect([line, ids]).toEqual([line, ['A', 'B']]);
      }
      // So writing one for an id the diagram has not declared is inert rather
      // than a phantom — no refusal needed, and Stage H can link a node it has
      // only just created.
      const out = serialize(setNodeLink(parseFlowchart('flowchart TD\n  A --> B')!, 'Z', 'z.md'));
      expect([...(await vertices(out)).keys()].sort()).toEqual(['A', 'B']);
      expect([...nodes(parseFlowchart(out)!).keys()].sort()).toEqual(['A', 'B']);
    },
    TIMEOUT,
  );

  it(
    'strict attaches no handler but the picture is NOT inert — it carries a real anchor',
    async () => {
      init();
      const url = await renderSvg(
        'flowchart TD\n  A[Start] --> B\n  click A "https://example.com"',
      );
      expect(/<a [^>]*href="https:\/\/example\.com\/?"/.test(url)).toBe(true);
      // A vault-relative target becomes live in-app navigation. Whoever binds
      // the svg owns neutralizing that; the model layer only records it.
      const rel = await renderSvg('flowchart TD\n  A[Start] --> B\n  click A "notes/a.md"');
      expect(rel.includes('href="notes/a.md"')).toBe(true);
      // sanitizeUrl does strip the obvious weapon, at least.
      const js = await renderSvg('flowchart TD\n  A[Start] --> B\n  click A "javascript:alert(1)"');
      expect(js.includes('javascript:')).toBe(false);

      // WHERE the anchor sits is what decided M29.38's fix: it WRAPS the node
      // `<g>` the binding layer resolves and hangs its onclick on. Following a
      // link is a DEFAULT ACTION, not propagation, so the node handler's
      // `stopPropagation()` never touched it — only `preventDefault()` or a
      // removed href does. Hence `bindFlowchartSvg` strips the attribute.
      const host = document.createElement('div');
      // Mermaid's own strict-mode output, the same sanitized sink the editor
      // injects into.
      host.innerHTML = rel;
      const anchor = host.querySelector('a[href]')!;
      expect(anchor.namespaceURI).toBe('http://www.w3.org/2000/svg');
      expect(anchor.querySelector('g.node')).not.toBeNull();
      const model = parseFlowchart('flowchart TD\n  A[Start] --> B\n  click A "notes/a.md"')!;
      const binding = bindFlowchartSvg(host, model);
      expect(binding.nodeEls.get('A')?.closest('a')).toBe(anchor);
      expect(host.querySelectorAll('a[href]')).toHaveLength(0);
    },
    TIMEOUT,
  );

  it(
    'every document setNodeLink writes is one mermaid still parses, and nothing appears or vanishes',
    async () => {
      init();
      // The renderable half of ops.test.ts's sweep corpus, crossed with the
      // targets most likely to break the grammar. A `setNodeLink` result that
      // mermaid rejects is the failure this whole file exists to catch.
      const DOCS: [string, string][] = [
        ['bare', 'flowchart TD\n  A --> B'],
        ['labeled', 'flowchart TD\n  A[Start] --> B{Choice}'],
        ['meta-shape', 'flowchart TD\n  A --> B\n  A@{ shape: cyl }'],
        ['lone-meta', 'flowchart TD\n  A@{ icon: "lucide:rocket", form: rounded, pos: b }'],
        ['in-subgraph', 'flowchart TD\n  subgraph S\n    A --> B\n  end'],
        ['frontmatter', '---\nconfig:\n  layout: elk\n---\nflowchart TD\n  A --> B'],
        ['crlf', 'flowchart TD\r\n  A --> B\r\n  C --> A'],
        ['existing-click', 'flowchart TD\n  A --> B\n  click A "old.md"'],
        ['two-clicks', 'flowchart TD\n  A --> B\n  click A "one.md"\n  click A "two.md"'],
        ['click-above-node', 'flowchart TD\n  click A "above.md"\n  A --> B'],
        ['href-variant', 'flowchart TD\n  A --> B\n  click A href "x.md"'],
        ['comma-variant', 'flowchart TD\n  A --> B\n  click A,B "both.md"'],
        ['styled', 'flowchart TD\n  A --> B\n  style A fill:#f96\n  classDef hot fill:#f96'],
        ['tab-indent', 'flowchart TD\n\tsubgraph S\n\t\tA --> B\n\tend'],
        // The M29.36 review's shapes: an owned line sandwiched by an unowned
        // same-slot writer, and an id in the TAIL of a comma list rather than
        // its head. Both were absent, and both hid live defects.
        [
          'owned-variant-owned',
          'flowchart TD\n  A --> B\n  click A "one.md"\n  click A href "mid.md"\n  click A "two.md"',
        ],
        ['comma-tail', 'flowchart TD\n  A --> B\n  click B,A "both.md"'],
        ['comma-tail-owned', 'flowchart TD\n  A --> B\n  click A "own.md"\n  click B,A "both.md"'],
        ['callback-variant', 'flowchart TD\n  A --> B\n  click A "own.md"\n  click A call f()'],
        ['noncanonical-owned', 'flowchart TD\n  A --> B\n  click  A\t"same.md"'],
      ];
      // Every character `clickTarget`'s doc calls "measured safe" is here, so
      // the claim is backed by a renderer rather than by a comment: `#`, `\`,
      // `;`, `,` and non-ASCII used to live only in the pure sweep, which
      // never starts mermaid.
      const TARGETS = [
        'projects/atlas/project.md',
        'my notes/a b.md',
        'weird"name.md',
        'a\nb.md',
        'a|b.md',
        'a#b.md',
        'a;b.md',
        'a,b.md',
        'a\\b.md',
        'notes/é中—.md',
        'a %% b.md',
        'a[b]{c}.md',
        '  padded.md  ',
        'click A "nested.md"',
        `${'x'.repeat(200)}.md`,
      ];

      let checked = 0;
      for (const [name, src] of DOCS) {
        const baseline = [...(await vertices(src)).keys()].sort();
        for (const target of TARGETS) {
          const where = `${name} + ${JSON.stringify(target).slice(0, 30)}`;
          const out = serialize(setNodeLink(parseFlowchart(src)!, 'A', target));
          expect([where, await parses(out)]).toEqual([where, true]);
          expect([where, [...(await vertices(out)).keys()].sort()]).toEqual([where, baseline]);
          // The strongest property this file can state, and the one that
          // cannot pass on a no-op: after the op, MERMAID RESOLVES WHAT OUR
          // MODEL SAYS. `utils.formatUrl` trims the url, and nothing else in
          // this corpus survives sanitizeUrl differently.
          const ours = nodeLinks(parseFlowchart(out)!).get('A');
          expect([where, ours?.target]).not.toEqual([where, undefined]);
          expect([where, (await vertices(out)).get('A')?.link]).toEqual([
            where,
            ours?.target.trim(),
          ]);
          checked += 1;
        }
      }
      expect(checked).toBe(DOCS.length * TARGETS.length);
    },
    TIMEOUT,
  );
});
