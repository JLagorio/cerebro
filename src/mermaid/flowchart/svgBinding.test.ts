import { describe, expect, it } from 'vitest';
import { edges, parseFlowchart } from './model';
import { bindFlowchartSvg } from './svgBinding';

const SVG = [
  '<svg viewBox="0 0 100 100">',
  '  <g class="node default" id="flowchart-A-0"><rect/></g>',
  '  <g class="node default" id="flowchart-B-1"><rect/></g>',
  '  <g class="node default" id="flowchart-my-node-2"><rect/></g>',
  '  <path class="edge-thickness-normal edge-pattern-solid flowchart-link" id="L_A_B_0"/>',
  '  <path class="flowchart-link" id="L_B_my-node_0"/>',
  '</svg>',
].join('\n');

describe('bindFlowchartSvg', () => {
  it('maps node groups and edge paths back to model ids — dashes included', () => {
    const model = parseFlowchart('flowchart TD\n  A[One] --> B[Two]\n  B --> my-node[Three]')!;
    const host = document.createElement('div');
    // Test fixture: fixed literal SVG markup, not user-supplied content.
    host.innerHTML = SVG;
    const binding = bindFlowchartSvg(host, model);
    expect([...binding.nodeEls.keys()].sort()).toEqual(['A', 'B', 'my-node']);
    expect(binding.edgeEls).toHaveLength(2);
    expect(binding.edgeEls[1]).toMatchObject({ from: 'B', to: 'my-node' });
  });

  // MEASURED on the bundled 11.16.0 (and cited: rendering-elements/shapes/
  // icon.ts:22, iconSquare.ts:26, iconCircle.ts:22, iconRounded.ts:26 pass
  // 'icon-shape default' to labelHelper; imageSquare.ts:46 passes
  // 'image-shape default'). Those five handlers are the ONLY ones that do not
  // produce `class="node"` — every shape in our own registry was rendered and
  // checked, and every one of them still does. The id scheme is untouched,
  // which is what this binding actually contracts on, so the class list is the
  // only thing that had to widen.
  //
  // Found by M29.39's e2e: setting an icon made the node unreachable from the
  // canvas — no toolbar, no rename, no delete, no link badge, and no way to
  // take the icon back off. A one-way trapdoor for the control M29.35 shipped.
  it('binds every class mermaid draws a node as, not just g.node', () => {
    const model = parseFlowchart(
      'flowchart TD\n  A[One] --> B[Two]\n  B --> C[Three]\n  C --> D[Four]',
    )!;
    const host = document.createElement('div');
    // Test fixture: fixed literal SVG markup, not user-supplied content.
    host.innerHTML = [
      '<svg viewBox="0 0 100 100">',
      '  <g class="icon-shape default" id="flowchart-A-0"><rect/></g>',
      '  <g class="icon-shape2"><path/></g>',
      '  <g class="image-shape default" id="flowchart-B-1"><rect/></g>',
      '  <g class="rough-node default" id="flowchart-C-2"><rect/></g>',
      '  <g class="node default" id="flowchart-D-3"><rect/></g>',
      '</svg>',
    ].join('\n');
    const binding = bindFlowchartSvg(host, model);
    expect([...binding.nodeEls.keys()].sort()).toEqual(['A', 'B', 'C', 'D']);
    // The icon's inner `icon-shape2` group carries no id at all, so the id
    // filter keeps it out rather than binding a node to its own decoration.
    expect(binding.nodeEls.get('A')?.getAttribute('class')).toBe('icon-shape default');
  });

  // `rough-node` on its own line because it is the one that takes a WHOLE
  // document: `look: handDrawn` re-prefixes every ordinary node at once, and
  // `parseFlowchart` holds the config frontmatter opaque while still finding
  // the header — so the editor mounts over a diagram it has bound nothing in.
  it('binds a hand-drawn document, where EVERY node is a rough-node', () => {
    const model = parseFlowchart(
      '---\nconfig:\n  look: handDrawn\n---\nflowchart TD\n  A[One] --> B[Two]',
    );
    expect(model, 'the editor mounts on this, so the binding has to work').not.toBeNull();
    const host = document.createElement('div');
    // Test fixture: fixed literal SVG markup, not user-supplied content.
    host.innerHTML = [
      '<svg viewBox="0 0 100 100">',
      '  <g class="rough-node default" id="flowchart-A-0"><rect/></g>',
      '  <g class="rough-node default" id="flowchart-B-1"><rect/></g>',
      '</svg>',
    ].join('\n');
    expect([...bindFlowchartSvg(host, model!).nodeEls.keys()].sort()).toEqual(['A', 'B']);
  });

  it('ignores svg elements that match nothing in the model', () => {
    const model = parseFlowchart('flowchart TD\n  A[One] --> B[Two]')!;
    const host = document.createElement('div');
    // Test fixture: fixed literal SVG markup, not user-supplied content.
    host.innerHTML = SVG;
    const binding = bindFlowchartSvg(host, model);
    expect(binding.nodeEls.has('my-node')).toBe(false);
    expect(binding.edgeEls).toHaveLength(1);
  });

  // Verified against vendored mermaid 11.16 source (flowDb.ts:313-327,
  // addSingleLink): the id assigned to an edge is scoped per (from, to)
  // pair — the pair's 1st occurrence gets counter 0, its 2nd occurrence
  // gets counter 2 (never 1: `existingLinks.length + 1` is already 2 by
  // the second time round). A duplicate declaration of the same pair
  // therefore renders ids "L_A_B_0" then "L_A_B_2".
  it('binds duplicate A-->B edges by counter, not by find()-order — path 0 is the first EdgeEntry, path 1 the second', () => {
    const src = 'flowchart TD\n  A[One] --> B[Two]\n  A --> B';
    const model = parseFlowchart(src)!;
    const [firstAB, secondAB] = edges(model);
    expect(firstAB).toMatchObject({ from: 'A', to: 'B' });
    expect(secondAB).toMatchObject({ from: 'A', to: 'B' });
    expect(firstAB.line).not.toBe(secondAB.line);

    const dupSvg = [
      '<svg viewBox="0 0 100 100">',
      '  <g class="node default" id="flowchart-A-0"><rect/></g>',
      '  <g class="node default" id="flowchart-B-1"><rect/></g>',
      '  <path class="flowchart-link" id="L_A_B_0"/>',
      '  <path class="flowchart-link" id="L_A_B_2"/>',
      '</svg>',
    ].join('\n');
    const host = document.createElement('div');
    // Test fixture: fixed literal SVG markup, not user-supplied content.
    host.innerHTML = dupSvg;

    const binding = bindFlowchartSvg(host, model);
    expect(binding.edgeEls).toHaveLength(2);
    expect(binding.edgeEls[0]).toMatchObject({ from: 'A', to: 'B', line: firstAB.line });
    expect(binding.edgeEls[1]).toMatchObject({ from: 'A', to: 'B', line: secondAB.line });
  });

  // Verified against vendored mermaid 11.16 source: two DIFFERENT (from, to)
  // pairs can render the textually identical id when the pieces concatenate
  // the same way — nodes A_B/C and A/B_C both produce ids starting
  // "L_A_B_C_". Each pair's *first* occurrence is unconditionally counter 0
  // (flowDb.ts:313-327 keys only on "have I seen this exact pair before",
  // never on what other pairs exist), so that id is genuinely ambiguous and
  // must stay unbound. A pair's *further* occurrences are not: a pair with
  // only one declared edge can never produce a "_2" suffix, so an id ending
  // "_2" can only belong to the pair that has a second occurrence — that one
  // resolves correctly, unlike the old prefix-only find() which would have
  // bound it to whichever pair happened to sort first.
  it('resolves the A_B/C vs A/B_C prefix collision via the counter, and leaves the genuinely tied first-occurrence ids unbound', () => {
    const src = 'flowchart TD\n  A_B --> C\n  A --> B_C\n  A --> B_C';
    const model = parseFlowchart(src)!;
    const allEdges = edges(model);
    const abcOnce = allEdges.find((e) => e.from === 'A_B' && e.to === 'C');
    const aToBc = allEdges.filter((e) => e.from === 'A' && e.to === 'B_C');
    expect(abcOnce).toBeDefined();
    expect(aToBc).toHaveLength(2);

    const collidingSvg = [
      '<svg viewBox="0 0 100 100">',
      '  <g class="node default" id="flowchart-A-0"><rect/></g>',
      '  <g class="node default" id="flowchart-B_C-1"><rect/></g>',
      '  <g class="node default" id="flowchart-A_B-2"><rect/></g>',
      '  <g class="node default" id="flowchart-C-3"><rect/></g>',
      // A_B-->C's only edge and A-->B_C's first edge are both first-of-pair —
      // both legitimately render "L_A_B_C_0". Genuinely tied, stays unbound.
      '  <path class="flowchart-link" id="L_A_B_C_0"/>',
      '  <path class="flowchart-link" id="L_A_B_C_0"/>',
      // A-->B_C's second edge is the only candidate that could ever produce
      // a "_2" suffix (A_B-->C has just one occurrence) — resolves cleanly.
      '  <path class="flowchart-link" id="L_A_B_C_2"/>',
      '</svg>',
    ].join('\n');
    const host = document.createElement('div');
    // Test fixture: fixed literal SVG markup, not user-supplied content.
    host.innerHTML = collidingSvg;

    const binding = bindFlowchartSvg(host, model);
    expect(binding.edgeEls).toHaveLength(1);
    expect(binding.edgeEls[0]).toMatchObject({ from: 'A', to: 'B_C', line: aToBc[1].line });
  });

  // Observed live (M29.19 e2e): in a real browser mermaid namespaces every
  // internal DOM id with the id the diagram was rendered under — our
  // `cerebro-mermaid-<seq>` — so groups render as
  // `cerebro-mermaid-3-flowchart-Idea-0` and paths as
  // `cerebro-mermaid-3-L_Idea_Build_0`. The bare-`flowchart-…` fixtures
  // above still bind (the strip is a no-op without the prefix); this one
  // pins the browser-shaped form, which the original prefix-match missed
  // entirely — leaving the structural editor inert in production.
  it('binds ids namespaced under the svg render id, as the browser build emits them', () => {
    const model = parseFlowchart('flowchart TD\n  A[One] --> B[Two]\n  B --> my-node[Three]')!;
    const prefixedSvg = [
      '<svg id="cerebro-mermaid-3" viewBox="0 0 100 100">',
      '  <g class="node default" id="cerebro-mermaid-3-flowchart-A-0"><rect/></g>',
      '  <g class="node default" id="cerebro-mermaid-3-flowchart-B-1"><rect/></g>',
      '  <g class="node default" id="cerebro-mermaid-3-flowchart-my-node-2"><rect/></g>',
      '  <path class="flowchart-link" id="cerebro-mermaid-3-L_A_B_0"/>',
      '  <path class="flowchart-link" id="cerebro-mermaid-3-L_B_my-node_0"/>',
      '</svg>',
    ].join('\n');
    const host = document.createElement('div');
    // Test fixture: fixed literal SVG markup, not user-supplied content.
    host.innerHTML = prefixedSvg;

    const binding = bindFlowchartSvg(host, model);
    expect([...binding.nodeEls.keys()].sort()).toEqual(['A', 'B', 'my-node']);
    expect(binding.edgeEls).toHaveLength(2);
    expect(binding.edgeEls[1]).toMatchObject({ from: 'B', to: 'my-node' });
  });
});

// A user-authored edge id renders VERBATIM as the path id (getEdgeId,
// utils.ts:946, returns its 4th argument untouched when truthy), so
// `A e1@--> B` draws `<path id="e1">` and never an `L_…` id. Measured live:
// before this arm, setEdgeAnimate minting an id UNBOUND the very edge whose
// toggle produced it — a one-way control.
describe('bindFlowchartSvg and user-authored edge ids (M29.31)', () => {
  const idSvg = [
    '<svg viewBox="0 0 100 100">',
    '  <g class="node default" id="flowchart-A-0"><rect/></g>',
    '  <g class="node default" id="flowchart-B-1"><rect/></g>',
    '  <g class="node default" id="flowchart-C-2"><rect/></g>',
    '  <path class="flowchart-link" id="L_A_B_0"/>',
    '  <path class="flowchart-link" id="e1"/>',
    '</svg>',
  ].join('\n');

  it('binds an edge whose id the author wrote', () => {
    const model = parseFlowchart('flowchart TD\n  A --> B\n  B e1@--> C\n  e1@{ animate: true }')!;
    const host = document.createElement('div');
    // Test fixture: fixed literal SVG markup, not user-supplied content.
    host.innerHTML = idSvg;
    const binding = bindFlowchartSvg(host, model);
    expect(binding.edgeEls).toHaveLength(2);
    expect(binding.edgeEls[0]).toMatchObject({ from: 'A', to: 'B' });
    expect(binding.edgeEls[1]).toMatchObject({ from: 'B', to: 'C', id: 'e1' });
  });

  it('leaves an id path unbound when the model has no such edge', () => {
    const model = parseFlowchart('flowchart TD\n  A --> B')!;
    const host = document.createElement('div');
    // Test fixture: fixed literal SVG markup, not user-supplied content.
    host.innerHTML = idSvg;
    const binding = bindFlowchartSvg(host, model);
    expect(binding.edgeEls).toHaveLength(1);
    expect(binding.edgeEls[0]).toMatchObject({ from: 'A', to: 'B' });
  });

  it('still strips the render-id prefix a real browser adds', () => {
    const model = parseFlowchart('flowchart TD\n  B e1@--> C')!;
    const host = document.createElement('div');
    // Test fixture: fixed literal SVG markup, not user-supplied content.
    host.innerHTML = [
      '<svg id="cerebro-mermaid-3" viewBox="0 0 100 100">',
      '  <path class="flowchart-link" id="cerebro-mermaid-3-e1"/>',
      '</svg>',
    ].join('\n');
    const binding = bindFlowchartSvg(host, model);
    expect(binding.edgeEls).toHaveLength(1);
    expect(binding.edgeEls[0]).toMatchObject({ from: 'B', to: 'C', id: 'e1' });
  });
});

// MEASURED on the BUNDLED 11.16.0 (see subgraphs.mermaid.test.ts, "the cluster
// DOM contract"): a subgraph renders as `<g class="cluster" id="<renderId>-<id>">`
// — no `flowchart-` prefix and no counter, unlike a node group — and node
// groups are NOT descendants of it; they live in a sibling `g.nodes` layer.
describe('cluster binding (M29.38)', () => {
  const CLUSTER_SVG = [
    '<svg id="cerebro-mermaid-7" viewBox="0 0 100 100">',
    '  <g class="cluster" id="cerebro-mermaid-7-ops"><rect/></g>',
    // The trailing space the vendored source writes when cssClasses is empty
    // (`'cluster ' + node.cssClasses`) — the bundled build trims it away, so
    // both spellings are in the fixture and both must bind.
    '  <g class="cluster " id="cerebro-mermaid-7-subGraph1"><rect/></g>',
    '  <g class="cluster" id="cerebro-mermaid-7-mystery"><rect/></g>',
    '  <g class="node default" id="cerebro-mermaid-7-flowchart-A-0"><rect/></g>',
    '</svg>',
  ].join('\n');

  it('maps cluster groups to effective subgraph ids — explicit AND generated', () => {
    const model = parseFlowchart(
      [
        'flowchart TD',
        '  subgraph ops[Operations]',
        '    A[Start]',
        '  end',
        '  subgraph Two Words',
        '    B',
        '  end',
      ].join('\n'),
    )!;
    const host = document.createElement('div');
    // Test fixture: fixed literal SVG markup, not user-supplied content.
    host.innerHTML = CLUSTER_SVG;
    const binding = bindFlowchartSvg(host, model);
    expect([...binding.clusterEls.keys()].sort()).toEqual(['ops', 'subGraph1']);
    expect(binding.clusterEls.has('mystery')).toBe(false); // unmatched → unbound, renders fine
    expect(binding.nodeEls.has('A')).toBe(true); // node binding untouched
  });

  it('binds nothing when the document has no readable blocks', () => {
    const model = parseFlowchart('flowchart TD\n  A[Start]')!;
    const host = document.createElement('div');
    // Test fixture: fixed literal SVG markup, not user-supplied content.
    host.innerHTML = CLUSTER_SVG;
    expect(bindFlowchartSvg(host, model).clusterEls.size).toBe(0);
  });
});

// A LIVE navigation bug, measured on the bundled 11.16.0 (links.mermaid.test.ts):
// at securityLevel 'strict' mermaid attaches no click HANDLER but still wraps
// every clickable node group in a real `<a href="…">`. A default action is not
// propagation, so the node handler's stopPropagation() never touched it, and
// clicking a linked node merely to SELECT it navigated the whole Tauri webview
// off the SPA. Live today for hand-authored click lines.
describe('bindFlowchartSvg neutralizes mermaid anchors (M29.38)', () => {
  const LINKED_SVG = [
    '<svg id="cerebro-mermaid-9" viewBox="0 0 100 100">',
    '  <g class="nodes">',
    '    <a href="notes/a.md" data-look="classic">',
    '      <g class="node default clickable" id="cerebro-mermaid-9-flowchart-A-0"><rect/></g>',
    '    </a>',
    '    <a href="https://example.com/">',
    '      <g class="node default clickable" id="cerebro-mermaid-9-flowchart-B-1"><rect/></g>',
    '    </a>',
    '  </g>',
    '</svg>',
  ].join('\n');

  it('strips every href so no click can navigate the app away', () => {
    const model = parseFlowchart(
      'flowchart TD\n  A --> B\n  click A "notes/a.md"\n  click B "https://example.com/"',
    )!;
    const host = document.createElement('div');
    // Test fixture: fixed literal SVG markup, not user-supplied content.
    host.innerHTML = LINKED_SVG;
    expect(host.querySelectorAll('a[href]')).toHaveLength(2);
    const binding = bindFlowchartSvg(host, model);
    expect(host.querySelectorAll('a[href]')).toHaveLength(0);
    // The anchors themselves stay — they carry mermaid's own layout — and the
    // node groups inside them are still bound and still clickable.
    expect(host.querySelectorAll('a')).toHaveLength(2);
    expect([...binding.nodeEls.keys()].sort()).toEqual(['A', 'B']);
  });

  it('strips an anchor the model knows nothing about too', () => {
    // An unbound node is still a node mermaid drew an anchor around, and an
    // href we leave behind is an href a click follows.
    const model = parseFlowchart('flowchart TD\n  Z[Zed]')!;
    const host = document.createElement('div');
    // Test fixture: fixed literal SVG markup, not user-supplied content.
    host.innerHTML = LINKED_SVG;
    bindFlowchartSvg(host, model);
    expect(host.querySelectorAll('a[href]')).toHaveLength(0);
  });
});

/**
 * The ELK renderer names its cluster groups from an object (M29.53).
 *
 * MEASURED on demo-vault/diagrams/pipeline.mmd, which ships `layout: elk`: the
 * `g.cluster` id was the string "[object Object]", so the exact-equality lookup
 * never hit, no handler was attached, and every subgraph control — rename,
 * per-block direction, ungroup — was unreachable under that engine. The same
 * document under Dagre bound and worked.
 */
describe('cluster binding when the DOM id says nothing', () => {
  const CODE = 'flowchart TD\n  subgraph Front_half\n    A --> B\n  end\n  B --> C';

  it('falls back to document order', () => {
    const host = document.createElement('div');
    host.innerHTML =
      '<svg><g class="cluster" id="[object Object]"><rect/></g>' +
      '<g class="node" id="flowchart-A-0"/><g class="node" id="flowchart-B-1"/>' +
      '<g class="node" id="flowchart-C-2"/></svg>';
    const binding = bindFlowchartSvg(host, parseFlowchart(CODE)!);
    expect(binding.clusterEls.get('Front_half')).toBe(host.querySelector('g.cluster'));
  });

  it('refuses when the picture and the model disagree about how many blocks there are', () => {
    const host = document.createElement('div');
    host.innerHTML =
      '<svg><g class="cluster" id="[object Object]"><rect/></g>' +
      '<g class="cluster" id="[object Object]"><rect/></g>' +
      '<g class="node" id="flowchart-A-0"/></svg>';
    // One subgraph in the model, two unresolved clusters on screen: binding a
    // toolbar to the wrong block is worse than binding none.
    expect(bindFlowchartSvg(host, parseFlowchart(CODE)!).clusterEls.size).toBe(0);
  });
});
