import { describe, expect, it } from 'vitest';
import { parseFlowchart } from './parse';
import { bindFlowchartSvg } from './svgBinding';
import {
  accumulatedTranslate,
  applyManualLayout,
  applyStoredManualLayout,
  beginManualLayout,
  clientDeltaToPlane,
  clientToPlane,
  growViewBox,
  moveNode,
  rectBorderPoint,
} from './manualLayout';

/** Flat dagre-shaped fixture: one g.root, nodes and edges in sibling layers. */
const SVG = [
  '<svg viewBox="0 0 200 100" width="100%" style="max-width: 200px;">',
  '<g class="root">',
  '<g class="edgePaths">',
  '<path class="flowchart-link" id="L_A_B_0" data-id="L_A_B_0"',
  ' d="M30,25C60,30 90,50 120,65" marker-end="url(#m-end)" marker-start="url(#m-start)"/>',
  '<path class="flowchart-link" id="L_B_C_0" data-id="L_B_C_0" d="M1,1L2,2"/>',
  '</g>',
  '<g class="edgeLabels">',
  '<g class="edgeLabel"><g class="label" data-id="L_A_B_0"><text>go</text></g></g>',
  '</g>',
  '<g class="nodes">',
  '<g class="node" id="flowchart-A-0" transform="translate(30, 20)"><rect/></g>',
  '<g class="node" id="flowchart-B-1" transform="translate(130, 70)"><rect/></g>',
  '</g>',
  '</g>',
  '</svg>',
].join('');

// C exists in the model but not in the svg: its edge binds by id, its node
// does not — the exact "bound edge, unbound endpoint" degradation case.
const CODE = 'flowchart TD\n  A[Start] --> B[End]\n  B --> C[Ghost]';

/**
 * The same two nodes and the same edge, nested inside a SCALED group. The
 * fallback arithmetic (rect + viewBox) cannot express this: its writes would
 * land in the wrong space, so `accumulatedTranslate` refuses and everything is
 * left untouched. With screen CTMs available the whole thing is exact — which
 * is what the M29.40 spike measured and recommended over the plan's snippet.
 */
const NESTED_SVG = [
  '<svg viewBox="0 0 200 100" width="100%" style="max-width: 200px;">',
  '<g class="root" transform="scale(2)">',
  '<g class="edgePaths">',
  '<path class="flowchart-link" id="L_A_B_0" data-id="L_A_B_0" d="M1,1C2,2 3,3 4,4"',
  ' marker-end="url(#m-end)"/>',
  '</g>',
  '<g class="edgeLabels">',
  '<g class="edgeLabel"><g class="label" data-id="L_A_B_0"><text>go</text></g></g>',
  '</g>',
  '<g class="nodes">',
  '<g class="node" id="flowchart-A-0" transform="translate(15, 10)"><rect/></g>',
  '<g class="node" id="flowchart-B-1" transform="translate(65, 35)"><rect/></g>',
  '</g>',
  '</g>',
  '</svg>',
].join('');

const NESTED_CODE = 'flowchart TD\n  A[Start] --> B[End]';

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

function stubRect(el: Element, r: Rect): void {
  (el as HTMLElement).getBoundingClientRect = () =>
    ({
      ...r,
      right: r.left + r.width,
      bottom: r.top + r.height,
      x: r.left,
      y: r.top,
      toJSON: () => ({}),
    }) as DOMRect;
}

interface Ctm {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

/**
 * jsdom 26 has no `getScreenCTM` (and no `DOMMatrix`), so the exact path is
 * driven by planting the method. The module only ever reads a/b/c/d/e/f, which
 * is the whole point of it doing its own matrix arithmetic.
 */
function stubCtm(el: Element, m: Ctm): void {
  Object.assign(el, { getScreenCTM: () => m });
}

function mount(markup: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = markup;
  return host;
}

/** Fixture at scale 1: svg client box 200x100 over viewBox 0 0 200 100. */
function setup() {
  const host = mount(SVG);
  const svg = host.querySelector('svg')!;
  stubRect(svg, { left: 0, top: 0, width: 200, height: 100 });
  stubRect(host.querySelector('#flowchart-A-0')!, { left: 20, top: 10, width: 20, height: 20 });
  stubRect(host.querySelector('#flowchart-B-1')!, { left: 120, top: 60, width: 20, height: 20 });
  const model = parseFlowchart(CODE)!;
  const binding = bindFlowchartSvg(host, model);
  const session = beginManualLayout(host, binding)!;
  return { host, svg, binding, session };
}

/** The nested fixture with screen CTMs planted — the exact path. */
function setupNested() {
  const host = mount(NESTED_SVG);
  const svg = host.querySelector('svg')!;
  const a = host.querySelector('#flowchart-A-0')!;
  const b = host.querySelector('#flowchart-B-1')!;
  const path = host.querySelector('#L_A_B_0')!;
  const labels = host.querySelector('g.edgeLabels')!;
  stubRect(a, { left: 20, top: 10, width: 20, height: 20 });
  stubRect(b, { left: 120, top: 60, width: 20, height: 20 });
  stubCtm(svg, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
  stubCtm(a, { a: 2, b: 0, c: 0, d: 2, e: 30, f: 20 });
  stubCtm(b, { a: 2, b: 0, c: 0, d: 2, e: 130, f: 70 });
  stubCtm(path, { a: 2, b: 0, c: 0, d: 2, e: 0, f: 0 });
  stubCtm(labels, { a: 2, b: 0, c: 0, d: 2, e: 0, f: 0 });
  const model = parseFlowchart(NESTED_CODE)!;
  const binding = bindFlowchartSvg(host, model);
  const session = beginManualLayout(host, binding)!;
  return { host, binding, session };
}

describe('rectBorderPoint', () => {
  it('projects the center-to-target ray onto the box border', () => {
    const box = { cx: 0, cy: 0, halfW: 10, halfH: 5 };
    expect(rectBorderPoint(box, { x: 20, y: 0 })).toEqual({ x: 10, y: 0 });
    expect(rectBorderPoint(box, { x: 0, y: 20 })).toEqual({ x: 0, y: 5 });
    expect(rectBorderPoint(box, { x: 20, y: 10 })).toEqual({ x: 10, y: 5 });
    expect(rectBorderPoint(box, { x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
  });
});

describe('accumulatedTranslate', () => {
  it('sums pure translates and refuses anything else', () => {
    const host = mount(
      '<svg><g transform="translate(10, 5)"><g transform="translate(2,3)"><g id="x"/></g></g></svg>',
    );
    const svg = host.querySelector('svg')!;
    expect(accumulatedTranslate(host.querySelector('#x')!, svg)).toEqual({ x: 12, y: 8 });

    const one = mount('<svg><g transform="translate(7)"><g id="y"/></g></svg>');
    expect(accumulatedTranslate(one.querySelector('#y')!, one.querySelector('svg')!)).toEqual({
      x: 7,
      y: 0,
    });

    const scaled = mount('<svg><g transform="scale(2)"><g id="z"/></g></svg>');
    expect(
      accumulatedTranslate(scaled.querySelector('#z')!, scaled.querySelector('svg')!),
    ).toBeNull();
  });

  it('accepts the number spellings mermaid actually emits', () => {
    const host = mount('<svg><g transform="translate(-1.5e2, .5)"><g id="x"/></g></svg>');
    expect(accumulatedTranslate(host.querySelector('#x')!, host.querySelector('svg')!)).toEqual({
      x: -150,
      y: 0.5,
    });
  });
});

describe('beginManualLayout', () => {
  it('measures node boxes in plane units and captures base transforms', () => {
    const { session } = setup();
    expect(session.boxes.get('A')).toEqual({ cx: 30, cy: 20, halfW: 10, halfH: 10 });
    expect(session.auto.get('B')).toEqual({ x: 130, y: 70 });
    expect(session.base.get('A')).toBe('translate(30, 20)');
    expect(session.exact).toBe(false);
  });

  it('returns null when the svg has no measurable size (jsdom default, display:none)', () => {
    const host = mount(SVG); // rects unstubbed -> zeros
    const model = parseFlowchart(CODE)!;
    expect(beginManualLayout(host, bindFlowchartSvg(host, model))).toBeNull();
  });

  it('prefers screen CTMs when the host has them, and says so', () => {
    const { session } = setupNested();
    expect(session.exact).toBe(true);
    // Same plane centres as the flat fixture, read off the group origins.
    expect(session.boxes.get('A')).toEqual({ cx: 30, cy: 20, halfW: 10, halfH: 10 });
    expect(session.boxes.get('B')).toEqual({ cx: 130, cy: 70, halfW: 10, halfH: 10 });
  });

  it('takes a hand-drawn (g.rough-node) diagram through the binding, not a g.node selector', () => {
    const host = mount(
      [
        '<svg viewBox="0 0 200 100">',
        '<g class="rough-node default" id="flowchart-A-0" transform="translate(30, 20)"><rect/></g>',
        '</svg>',
      ].join(''),
    );
    stubRect(host.querySelector('svg')!, { left: 0, top: 0, width: 200, height: 100 });
    stubRect(host.querySelector('#flowchart-A-0')!, { left: 20, top: 10, width: 20, height: 20 });
    const model = parseFlowchart('flowchart TD\n  A[Start]')!;
    const binding = bindFlowchartSvg(host, model);
    const session = beginManualLayout(host, binding)!;
    expect(session.boxes.get('A')).toEqual({ cx: 30, cy: 20, halfW: 10, halfH: 10 });
    moveNode(session, binding, 'A', { x: 50, y: 20 });
    expect(host.querySelector('#flowchart-A-0')!.getAttribute('transform')).toBe(
      'translate(30, 20) translate(20, 0)',
    );
  });
});

describe('clientToPlane', () => {
  it('maps through origin and scale', () => {
    const host = mount(SVG);
    const svg = host.querySelector('svg')!;
    stubRect(svg, { left: 40, top: 10, width: 400, height: 200 }); // scale 2
    stubRect(host.querySelector('#flowchart-A-0')!, { left: 40, top: 10, width: 40, height: 40 });
    stubRect(host.querySelector('#flowchart-B-1')!, { left: 240, top: 130, width: 40, height: 40 });
    const model = parseFlowchart(CODE)!;
    const session = beginManualLayout(host, bindFlowchartSvg(host, model))!;
    expect(clientToPlane(session, { x: 140, y: 110 })).toEqual({ x: 50, y: 50 });
    // A DELTA is origin-free, which is what makes it survive a viewBox growth.
    expect(clientDeltaToPlane(session, { x: 20, y: 10 })).toEqual({ x: 10, y: 5 });
  });
});

describe('applyManualLayout', () => {
  it('translates stored nodes, straightens bound edges, moves labels, preserves markers', () => {
    const { host, binding, session } = setup();
    applyManualLayout(session, binding, new Map([['A', { x: 50, y: 20 }]]));

    const a = host.querySelector('#flowchart-A-0')!;
    expect(a.getAttribute('transform')).toBe('translate(30, 20) translate(20, 0)');
    // B has no stored position: untouched.
    expect(host.querySelector('#flowchart-B-1')!.getAttribute('transform')).toBe(
      'translate(130, 70)',
    );

    const edge = host.querySelector('#L_A_B_0')!;
    // A now at (50,20) hw10 hh10; B at (130,70): dx=80 dy=50 -> s=0.125 ->
    // anchors (60, 26.25) and (120, 63.75).
    expect(edge.getAttribute('d')).toBe('M60,26.25L120,63.75');
    expect(edge.getAttribute('marker-end')).toBe('url(#m-end)');
    expect(edge.getAttribute('marker-start')).toBe('url(#m-start)');

    const labelOuter = host.querySelector('g.label[data-id="L_A_B_0"]')!.parentElement!;
    expect(labelOuter.getAttribute('transform')).toBe('translate(90, 45)');

    // B->C: C has no svg group, so no box — the path is left untouched.
    expect(host.querySelector('#L_B_C_0')!.getAttribute('d')).toBe('M1,1L2,2');
  });

  it('re-applying is idempotent — base transforms are remembered, not compounded', () => {
    const { host, binding, session } = setup();
    applyManualLayout(session, binding, new Map([['A', { x: 50, y: 20 }]]));
    applyManualLayout(session, binding, new Map([['A', { x: 50, y: 20 }]]));
    expect(host.querySelector('#flowchart-A-0')!.getAttribute('transform')).toBe(
      'translate(30, 20) translate(20, 0)',
    );
    // And the second application is real work, not a silent refusal: the very
    // first version of this module read the LIVE transform to decide whether it
    // could map the node's space, so once it had appended its own translate
    // every later move was declined and the node froze at its first drop point.
    applyManualLayout(session, binding, new Map([['A', { x: 70, y: 20 }]]));
    expect(host.querySelector('#flowchart-A-0')!.getAttribute('transform')).toBe(
      'translate(30, 20) translate(40, 0)',
    );
    // dx=60 dy=50 -> s=min(10/60, 10/50)=1/6 -> (80, 20+50/6) and (120, 70-50/6).
    expect(host.querySelector('#L_A_B_0')!.getAttribute('d')).toBe('M80,28.33L120,61.67');
  });

  it('writes through the CTM chain, in each element OWN space, when CTMs exist', () => {
    const { host, binding, session } = setupNested();
    // The fallback would refuse this whole diagram: the ancestry is a scale.
    expect(
      accumulatedTranslate(host.querySelector('#flowchart-A-0')!, host.querySelector('svg')!),
    ).toBeNull();

    applyManualLayout(session, binding, new Map([['A', { x: 50, y: 20 }]]));

    // Plane delta (20,0) inside a 2x group is a LOCAL delta of (10,0) — the
    // plan's plane-equals-parent arithmetic would have written (20,0) and put
    // the node at plane x=70.
    expect(host.querySelector('#flowchart-A-0')!.getAttribute('transform')).toBe(
      'translate(15, 10) translate(10, 0)',
    );
    // Same anchors as the flat fixture, expressed in the path's own space.
    expect(host.querySelector('#L_A_B_0')!.getAttribute('d')).toBe('M30,13.13L60,31.88');
    expect(host.querySelector('#L_A_B_0')!.getAttribute('marker-end')).toBe('url(#m-end)');
    expect(
      host.querySelector('g.label[data-id="L_A_B_0"]')!.parentElement!.getAttribute('transform'),
    ).toBe('translate(45, 22.5)');
  });
});

describe('honest degradation', () => {
  it('leaves everything mermaid drew alone when the ancestry is not a pure translate', () => {
    // Same nested fixture, but with NO CTMs: nothing can be mapped, so nothing
    // is written — mermaid's geometry survives byte for byte.
    const host = mount(NESTED_SVG);
    stubRect(host.querySelector('svg')!, { left: 0, top: 0, width: 200, height: 100 });
    stubRect(host.querySelector('#flowchart-A-0')!, { left: 20, top: 10, width: 20, height: 20 });
    stubRect(host.querySelector('#flowchart-B-1')!, { left: 120, top: 60, width: 20, height: 20 });
    const model = parseFlowchart(NESTED_CODE)!;
    const binding = bindFlowchartSvg(host, model);
    const session = beginManualLayout(host, binding)!;
    applyManualLayout(session, binding, new Map([['A', { x: 50, y: 20 }]]));
    expect(host.querySelector('#flowchart-A-0')!.getAttribute('transform')).toBe(
      'translate(15, 10)',
    );
    expect(host.querySelector('#L_A_B_0')!.getAttribute('d')).toBe('M1,1C2,2 3,3 4,4');
    expect(
      host.querySelector('g.label[data-id="L_A_B_0"]')!.parentElement!.getAttribute('transform'),
    ).toBeNull();
  });

  it('leaves an edge alone when an endpoint node could not be measured', () => {
    const host = mount(SVG);
    stubRect(host.querySelector('svg')!, { left: 0, top: 0, width: 200, height: 100 });
    stubRect(host.querySelector('#flowchart-A-0')!, { left: 20, top: 10, width: 20, height: 20 });
    // B is left at jsdom's zero rect: unmeasurable, so it never gets a box.
    const model = parseFlowchart(CODE)!;
    const binding = bindFlowchartSvg(host, model);
    const session = beginManualLayout(host, binding)!;
    expect(session.boxes.has('B')).toBe(false);
    applyManualLayout(session, binding, new Map([['A', { x: 50, y: 20 }]]));
    expect(host.querySelector('#L_A_B_0')!.getAttribute('d')).toBe('M30,25C60,30 90,50 120,65');
    expect(host.querySelector('#flowchart-B-1')!.getAttribute('transform')).toBe(
      'translate(130, 70)',
    );
  });
});

describe('moveNode', () => {
  it('moves one node and re-routes only its incident bound edges', () => {
    const { host, binding, session } = setup();
    moveNode(session, binding, 'A', { x: 50, y: 20 });
    expect(host.querySelector('#flowchart-A-0')!.getAttribute('transform')).toBe(
      'translate(30, 20) translate(20, 0)',
    );
    expect(host.querySelector('#L_A_B_0')!.getAttribute('d')).toBe('M60,26.25L120,63.75');
    expect(host.querySelector('#L_B_C_0')!.getAttribute('d')).toBe('M1,1L2,2');
  });

  it('never re-routes a self-loop', () => {
    const host = mount(
      [
        '<svg viewBox="0 0 200 100">',
        '<g class="node" id="flowchart-A-0" transform="translate(30, 20)"><rect/></g>',
        '<path class="flowchart-link" id="L_A_A_0" data-id="L_A_A_0" d="M9,9C1,1 2,2 9,9"/>',
        '</svg>',
      ].join(''),
    );
    stubRect(host.querySelector('svg')!, { left: 0, top: 0, width: 200, height: 100 });
    stubRect(host.querySelector('#flowchart-A-0')!, { left: 20, top: 10, width: 20, height: 20 });
    const model = parseFlowchart('flowchart TD\n  A[Loop] --> A')!;
    const binding = bindFlowchartSvg(host, model);
    const session = beginManualLayout(host, binding)!;
    moveNode(session, binding, 'A', { x: 90, y: 50 });
    expect(host.querySelector('#L_A_A_0')!.getAttribute('d')).toBe('M9,9C1,1 2,2 9,9');
  });
});

describe('growViewBox (M29.40 spike exit criterion: clipping is TOTAL, not partial)', () => {
  it('grows the viewBox and max-width together so a moved node cannot vanish', () => {
    const { host, binding, session } = setup();
    const svg = host.querySelector('svg')!;
    moveNode(session, binding, 'A', { x: 280, y: 20 });
    // A's right edge is 290; +8 of padding.
    expect(svg.getAttribute('viewBox')).toBe('0 0 298 100');
    // Same plane-units-per-pixel as before: the box grew, the diagram did not
    // silently zoom.
    expect(svg.style.maxWidth).toBe('298px');
    expect(svg.getAttribute('width')).toBe('100%');
  });

  it('grows LEFT and UP too, moving the viewBox origin', () => {
    const { host, binding, session } = setup();
    moveNode(session, binding, 'A', { x: -50, y: 20 });
    expect(host.querySelector('svg')!.getAttribute('viewBox')).toBe('-68 0 268 100');
    expect(host.querySelector('svg')!.style.maxWidth).toBe('268px');
  });

  it('recomputes from mermaid own box every time — it never compounds, and never shrinks below it', () => {
    const { host, binding, session } = setup();
    const svg = host.querySelector('svg')!;
    moveNode(session, binding, 'A', { x: 280, y: 20 });
    moveNode(session, binding, 'A', { x: 280, y: 20 });
    expect(svg.getAttribute('viewBox')).toBe('0 0 298 100');
    expect(svg.style.maxWidth).toBe('298px');
    // Dragged back inside: mermaid's own box is the floor, restored exactly.
    moveNode(session, binding, 'A', { x: 50, y: 20 });
    expect(svg.getAttribute('viewBox')).toBe('0 0 200 100');
    expect(svg.style.maxWidth).toBe('200px');
    expect(growViewBox(session)).toBe(false);
  });

  it('scales width and height attributes when mermaid wrote pixel sizes instead', () => {
    const host = mount(
      [
        '<svg viewBox="0 0 200 100" width="200" height="100">',
        '<g class="node" id="flowchart-A-0" transform="translate(30, 20)"><rect/></g>',
        '</svg>',
      ].join(''),
    );
    stubRect(host.querySelector('svg')!, { left: 0, top: 0, width: 200, height: 100 });
    stubRect(host.querySelector('#flowchart-A-0')!, { left: 20, top: 10, width: 20, height: 20 });
    const model = parseFlowchart('flowchart TD\n  A[Start]')!;
    const binding = bindFlowchartSvg(host, model);
    const session = beginManualLayout(host, binding)!;
    moveNode(session, binding, 'A', { x: 30, y: 180 });
    const svg = host.querySelector('svg')!;
    expect(svg.getAttribute('viewBox')).toBe('0 0 200 198');
    expect(svg.getAttribute('width')).toBe('200');
    expect(svg.getAttribute('height')).toBe('198');
  });
});

describe('applyStoredManualLayout', () => {
  const MANUAL_CODE = [
    'flowchart TD',
    '  %% cerebro:layout manual',
    '  %% cerebro:pos A 50,20',
    '  A[Start] --> B[End]',
  ].join('\n');

  function viewHost() {
    const host = mount(SVG);
    stubRect(host.querySelector('svg')!, { left: 0, top: 0, width: 200, height: 100 });
    stubRect(host.querySelector('#flowchart-A-0')!, { left: 20, top: 10, width: 20, height: 20 });
    stubRect(host.querySelector('#flowchart-B-1')!, { left: 120, top: 60, width: 20, height: 20 });
    return host;
  }

  it('places stored positions and straightens the bound edges', () => {
    const host = viewHost();
    applyStoredManualLayout(host, MANUAL_CODE);
    expect(host.querySelector('#flowchart-A-0')!.getAttribute('transform')).toBe(
      'translate(30, 20) translate(20, 0)',
    );
    expect(host.querySelector('#L_A_B_0')!.getAttribute('d')).toBe('M60,26.25L120,63.75');
  });

  it('does nothing at all without the manual marker', () => {
    const host = viewHost();
    applyStoredManualLayout(host, 'flowchart TD\n  %% cerebro:pos A 50,20\n  A[Start] --> B[End]');
    expect(host.querySelector('#flowchart-A-0')!.getAttribute('transform')).toBe(
      'translate(30, 20)',
    );
    expect(host.querySelector('#L_A_B_0')!.getAttribute('d')).toBe('M30,25C60,30 90,50 120,65');
  });

  it('does nothing at all for a diagram that is not a flowchart', () => {
    const host = viewHost();
    expect(() => applyStoredManualLayout(host, 'sequenceDiagram\n  Alice->>Bob: hi')).not.toThrow();
    expect(host.querySelector('#flowchart-A-0')!.getAttribute('transform')).toBe(
      'translate(30, 20)',
    );
  });
});
