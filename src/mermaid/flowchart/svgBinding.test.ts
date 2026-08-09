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
