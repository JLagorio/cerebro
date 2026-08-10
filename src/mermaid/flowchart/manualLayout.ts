import { parseFlowchart } from './parse';
import type { PlanePoint } from './types';
import { isManualLayout, storedPositions } from './views';
import type { FlowchartSvgBinding } from './svgBinding';
import { bindFlowchartSvg } from './svgBinding';

/**
 * Manual layout (M29.42) — the React-free geometry layer that runs AFTER
 * mermaid renders and the binding resolves.
 *
 * Positions are ABSOLUTE plane coordinates of node centres ("plane" = the root
 * svg's user coordinate system, the space its viewBox describes — the same
 * space `PlanePoint` and `%% cerebro:pos` are defined in). Each application
 * measures where mermaid put a node, then appends a second translate after
 * mermaid's own (`nodes.ts:97` writes the first) so the group lands on the
 * stored centre. Bound edges are re-routed as straight segments between the two
 * nodes' bbox-border anchors; `marker-start`/`marker-end` are attributes on the
 * same `<path>` (`edgeMarker.ts:133/136`) so replacing `d` leaves the arrowheads
 * alone and `orient="auto"` re-aims them for free — both MEASURED on the
 * bundled 11.16.0 by the M29.40 spike, not reasoned. Labels move to the segment
 * midpoint by translating the outer `g.edgeLabel`, which is mermaid's own move
 * (`positionEdgeLabel`, `edges.js:292`).
 *
 * HOW GEOMETRY IS MEASURED, and why not the way the plan first said. The spike
 * measured that the plan's "client rect + viewBox arithmetic" silently assumes
 * the node's plane IS the svg's viewBox plane. That happens to hold for every
 * diagram it measured, and is guaranteed by nothing — so the primary path is
 * the one it recommended instead: compose screen CTMs
 * (`inverse(el.getScreenCTM()) x svg.getScreenCTM()`), which is exact under
 * nested group transforms, viewport scaling and CanvasViewport CSS zoom alike.
 * jsdom 26 implements neither `getScreenCTM` nor `DOMMatrix`, so there is a
 * second, honest path: derive the same affine map from the svg's client rect
 * and its viewBox ATTRIBUTE, and require pure-translate ancestry
 * (`accumulatedTranslate`) before writing anything. `session.exact` says which
 * one is live. All the arithmetic in between is our own `Mat`, so both paths
 * are one code path from `beginManualLayout` onwards and both are tested.
 *
 * Degradation is always "mermaid's original geometry stays", never garbage:
 * a self-loop, an edge with an endpoint we could not measure, an element whose
 * space we cannot map — each is left exactly as rendered.
 *
 * THE FRAME IS PINNED (read this before writing drag code). `growViewBox`
 * rewrites the svg's viewBox, which CHANGES where a plane point lands on
 * screen. The session's client<->plane map is deliberately NOT refreshed when
 * that happens, because a drag that re-derives an ABSOLUTE plane point from the
 * cursor against a freshly-grown box feeds its own growth: grow left, the
 * cursor's plane x drops, the node moves further left, grow again. Drag with
 * DELTAS against the pinned scale (`clientDeltaToPlane`) and the gesture is
 * stable by construction.
 */

/** A 2D point. Plane points are `PlanePoint`-shaped; client points are px. */
export interface Pt {
  x: number;
  y: number;
}

export interface Box {
  cx: number;
  cy: number;
  halfW: number;
  halfH: number;
}

interface ViewBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** An SVG affine matrix: [a c e; b d f; 0 0 1]. */
interface Mat {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export interface ManualLayoutSession {
  svg: SVGSVGElement;
  /** True when writes go through real screen CTMs rather than the fallback. */
  exact: boolean;
  /** Client pixels per plane unit (includes any ancestor CSS zoom). */
  scale: number;
  /** plane -> client and back. PINNED at begin — see the module docstring. */
  clientFromPlane: Mat;
  planeFromClient: Mat;
  /** Mermaid's OWN viewBox: the floor `growViewBox` never shrinks below. */
  vb: ViewBox;
  /** The size attributes exactly as mermaid wrote them, for growth ratios. */
  sizes: { width: string | null; height: string | null; maxWidth: string };
  /** Live node boxes in plane units — mutated as nodes move. */
  boxes: Map<string, Box>;
  /** Mermaid's auto centres, measured once on the pristine render. */
  auto: Map<string, Pt>;
  /** Each group's transform attribute exactly as mermaid rendered it. */
  base: Map<string, string>;
}

/** Plane units of breathing room between the outermost node and the viewBox. */
const PAD = 8;

const round2 = (n: number): number => Math.round(n * 100) / 100;

const IDENTITY: Mat = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

const translation = (x: number, y: number): Mat => ({ ...IDENTITY, e: x, f: y });

function mul(m: Mat, n: Mat): Mat {
  return {
    a: m.a * n.a + m.c * n.b,
    b: m.b * n.a + m.d * n.b,
    c: m.a * n.c + m.c * n.d,
    d: m.b * n.c + m.d * n.d,
    e: m.a * n.e + m.c * n.f + m.e,
    f: m.b * n.e + m.d * n.f + m.f,
  };
}

function invert(m: Mat): Mat | null {
  const det = m.a * m.d - m.b * m.c;
  if (!Number.isFinite(det) || det === 0) return null;
  return {
    a: m.d / det,
    b: -m.b / det,
    c: -m.c / det,
    d: m.a / det,
    e: (m.c * m.f - m.d * m.e) / det,
    f: (m.b * m.e - m.a * m.f) / det,
  };
}

/** A POINT through `m` — translation included. */
function applyPoint(m: Mat, p: Pt): Pt {
  return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f };
}

/** A VECTOR through `m` — linear part only, so translation cannot leak in. */
function applyVector(m: Mat, v: Pt): Pt {
  return { x: m.a * v.x + m.c * v.y, y: m.b * v.x + m.d * v.y };
}

/**
 * `el.getScreenCTM()` as plain numbers, or null where the method does not
 * exist (jsdom) or the element is not rendered (`display: none` returns null).
 * Only a/b/c/d/e/f are ever read, which is what lets a test plant one.
 */
function screenCtmOf(el: Element): Mat | null {
  const fn = (el as Partial<SVGGraphicsElement>).getScreenCTM;
  if (typeof fn !== 'function') return null;
  const m = fn.call(el as SVGGraphicsElement);
  if (m === null) return null;
  const out = { a: m.a, b: m.b, c: m.c, d: m.d, e: m.e, f: m.f };
  return Object.values(out).every((n) => Number.isFinite(n)) ? out : null;
}

function viewBoxOf(svg: SVGSVGElement): ViewBox | null {
  // The attribute, not svg.viewBox.baseVal: jsdom implements only the former.
  const raw = svg.getAttribute('viewBox');
  if (raw === null) return null;
  const parts = raw
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  return { x: parts[0], y: parts[1], w: parts[2], h: parts[3] };
}

/** Border point of `box` on the ray from its centre toward `target`. */
export function rectBorderPoint(box: Box, target: Pt): Pt {
  const dx = target.x - box.cx;
  const dy = target.y - box.cy;
  if (dx === 0 && dy === 0) return { x: box.cx, y: box.cy };
  // Scale the direction vector until its larger normalized component reaches
  // the box border: s = min over axes of halfExtent / |component|.
  const sx = dx !== 0 ? box.halfW / Math.abs(dx) : Infinity;
  const sy = dy !== 0 ? box.halfH / Math.abs(dy) : Infinity;
  const s = Math.min(sx, sy);
  return { x: box.cx + dx * s, y: box.cy + dy * s };
}

const NUM = String.raw`[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?`;
const TRANSLATE_ONLY = new RegExp(String.raw`^translate\(\s*(${NUM})(?:[\s,]+(${NUM}))?\s*\)$`);

/** A transform attribute's text as a translation, or null if it is anything else. */
function parseTranslate(text: string | null): Pt | null {
  if (text === null || text.trim() === '') return { x: 0, y: 0 };
  const m = text.trim().match(TRANSLATE_ONLY);
  return m === null ? null : { x: Number(m[1]), y: Number(m[2] ?? '0') };
}

/** The element's OWN transform as a translation, or null if it is anything else. */
function ownTranslate(el: Element): Pt | null {
  return parseTranslate(el.getAttribute('transform'));
}

/**
 * Sum of translate(x[,y]) transforms on ancestors strictly between `el` and the
 * svg root. Null when any ancestor carries anything other than a single pure
 * translate — the caller must then leave the element untouched.
 *
 * The M29.40 spike measured that this has nothing to accumulate in the common
 * case (no group in any diagram it rendered carried a transform at all, and
 * ELK does not even emit the `g.root` wrapper the plan's DOM contract
 * described), so this is the fallback path's safety net, never its mechanism.
 */
export function accumulatedTranslate(el: Element, svg: SVGSVGElement): Pt | null {
  let x = 0;
  let y = 0;
  for (
    let cur = el.parentElement;
    cur !== null && cur !== (svg as Element);
    cur = cur.parentElement
  ) {
    const t = ownTranslate(cur);
    if (t === null) return null;
    x += t.x;
    y += t.y;
  }
  return { x, y };
}

/** plane -> the coordinate system `el`'s OWN transform attribute is written in. */
function planeToParent(session: ManualLayoutSession, el: Element): Mat | null {
  if (session.exact) {
    const parent = el.parentElement;
    const ctm = parent === null ? null : screenCtmOf(parent);
    const inv = ctm === null ? null : invert(ctm);
    return inv === null ? null : mul(inv, session.clientFromPlane);
  }
  const anc = accumulatedTranslate(el, session.svg);
  return anc === null ? null : translation(-anc.x, -anc.y);
}

/** plane -> `el`'s own user space, i.e. what its `d`/children coordinates mean. */
function planeToLocal(session: ManualLayoutSession, el: Element): Mat | null {
  if (session.exact) {
    const ctm = screenCtmOf(el);
    const inv = ctm === null ? null : invert(ctm);
    return inv === null ? null : mul(inv, session.clientFromPlane);
  }
  const anc = accumulatedTranslate(el, session.svg);
  const own = ownTranslate(el);
  if (anc === null || own === null) return null;
  return translation(-(anc.x + own.x), -(anc.y + own.y));
}

/**
 * Measures the pristine render into a session, or refuses (null) when there is
 * nothing measurable — no svg, no usable viewBox, or (fallback path) a
 * zero-size client box, which is what a hidden host and an unstubbed jsdom
 * both look like.
 */
export function beginManualLayout(
  host: HTMLElement,
  binding: FlowchartSvgBinding,
): ManualLayoutSession | null {
  const svg = host.querySelector('svg');
  if (svg === null) return null;
  const vb = viewBoxOf(svg);
  if (vb === null || vb.w <= 0 || vb.h <= 0) return null;

  const ctm = screenCtmOf(svg);
  const ctmInv = ctm === null ? null : invert(ctm);
  let exact = true;
  let clientFromPlane: Mat;
  let planeFromClient: Mat;
  if (ctm !== null && ctmInv !== null) {
    clientFromPlane = ctm;
    planeFromClient = ctmInv;
  } else {
    exact = false;
    const r = svg.getBoundingClientRect();
    if (r.width <= 0) return null;
    // Uniform scale: mermaid never writes preserveAspectRatio="none", and a
    // CanvasViewport zoom is uniform too.
    const s = r.width / vb.w;
    clientFromPlane = { a: s, b: 0, c: 0, d: s, e: r.left - vb.x * s, f: r.top - vb.y * s };
    const inv = invert(clientFromPlane);
    if (inv === null) return null;
    planeFromClient = inv;
  }
  const scale = Math.hypot(clientFromPlane.a, clientFromPlane.b);
  if (!(scale > 0)) return null;

  const boxes = new Map<string, Box>();
  const auto = new Map<string, Pt>();
  const base = new Map<string, string>();
  for (const [id, el] of binding.nodeEls) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue; // unmeasurable node: stays auto
    // Node shapes are drawn centred on the group's local origin (nodes.ts:97),
    // so the origin through the CTM chain IS the centre. The client-rect centre
    // is the fallback's best answer for the same thing.
    const elCtm = exact ? screenCtmOf(el) : null;
    const centre =
      elCtm !== null
        ? applyPoint(planeFromClient, { x: elCtm.e, y: elCtm.f })
        : applyPoint(planeFromClient, { x: r.left + r.width / 2, y: r.top + r.height / 2 });
    boxes.set(id, {
      cx: centre.x,
      cy: centre.y,
      halfW: r.width / 2 / scale,
      halfH: r.height / 2 / scale,
    });
    auto.set(id, { x: centre.x, y: centre.y });
    base.set(id, el.getAttribute('transform') ?? '');
  }

  return {
    svg,
    exact,
    scale,
    clientFromPlane,
    planeFromClient,
    vb,
    sizes: {
      width: svg.getAttribute('width'),
      height: svg.getAttribute('height'),
      maxWidth: svg.style.maxWidth,
    },
    boxes,
    auto,
    base,
  };
}

/** Client (viewport) coordinates -> plane coordinates. */
export function clientToPlane(session: ManualLayoutSession, client: Pt): Pt {
  return applyPoint(session.planeFromClient, client);
}

/**
 * A client-pixel DELTA -> a plane delta. Origin-free, so it survives a viewBox
 * growth that moved the plane origin under the cursor — which is exactly why
 * drag frames must use this rather than differencing two `clientToPlane` calls
 * taken either side of a growth.
 */
export function clientDeltaToPlane(session: ManualLayoutSession, delta: Pt): Pt {
  return applyVector(session.planeFromClient, delta);
}

/**
 * plane -> the space the translate we APPEND to a node group lives in, i.e. the
 * one mermaid's own transform establishes. Only the linear part is ever used.
 *
 * Both arms have to read the BASE transform rather than the live attribute,
 * because after one application that attribute is `translate(a, b)
 * translate(dx, dy)` — two of them. The exact arm gets this for free (appending
 * a translate cannot change a matrix's linear part); the fallback arm has to be
 * told, and a version of this that re-read the attribute silently refused every
 * move after the first, leaving the node stuck at its first drop point.
 */
function nodeLocalFromPlane(session: ManualLayoutSession, el: SVGGElement, id: string): Mat | null {
  if (session.exact) {
    const ctm = screenCtmOf(el);
    const inv = ctm === null ? null : invert(ctm);
    return inv === null ? null : mul(inv, session.clientFromPlane);
  }
  if (accumulatedTranslate(el, session.svg) === null) return null;
  // Pure-translate ancestry AND a pure-translate base mean local units ARE
  // plane units, so a delta transfers 1:1.
  return parseTranslate(session.base.get(id) ?? '') === null ? null : IDENTITY;
}

/** Sets one node's transform for a target centre. False = left untouched. */
function setNodeTransform(
  session: ManualLayoutSession,
  el: SVGGElement,
  id: string,
  centre: Pt,
): boolean {
  const box = session.boxes.get(id);
  const autoCentre = session.auto.get(id);
  if (box === undefined || autoCentre === undefined) return false;
  const linear = nodeLocalFromPlane(session, el, id);
  if (linear === null) return false;
  const delta = applyVector(linear, { x: centre.x - autoCentre.x, y: centre.y - autoCentre.y });
  if (!Number.isFinite(delta.x) || !Number.isFinite(delta.y)) return false;
  box.cx = centre.x;
  box.cy = centre.y;
  const base = session.base.get(id) ?? '';
  el.setAttribute('transform', `${base} translate(${round2(delta.x)}, ${round2(delta.y)})`.trim());
  return true;
}

/** Straightens one bound edge between its endpoints' current borders. */
export function rerouteEdge(
  session: ManualLayoutSession,
  bound: FlowchartSvgBinding['edgeEls'][number],
): void {
  if (bound.from === bound.to) return; // self-loop: mermaid's path or nothing
  const from = session.boxes.get(bound.from);
  const to = session.boxes.get(bound.to);
  if (from === undefined || to === undefined) return; // unbound endpoint: untouched
  const local = planeToLocal(session, bound.el);
  if (local === null) return; // a space we cannot map: untouched
  const a = rectBorderPoint(from, { x: to.cx, y: to.cy });
  const b = rectBorderPoint(to, { x: from.cx, y: from.cy });
  const la = applyPoint(local, a);
  const lb = applyPoint(local, b);
  bound.el.setAttribute('d', `M${round2(la.x)},${round2(la.y)}L${round2(lb.x)},${round2(lb.y)}`);
  // marker-start/marker-end are separate attributes on this same element —
  // untouched by the d write above (edgeMarker.ts:133/136), spike-verified.
  moveEdgeLabel(session, bound, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
}

function moveEdgeLabel(
  session: ManualLayoutSession,
  bound: FlowchartSvgBinding['edgeEls'][number],
  mid: Pt,
): void {
  // The path carries the bare edge id in data-id (edges.js:859); the label's
  // inner g.label carries the same (edges.js:84) — both re-measured on 11.16.0
  // by the M29.40 spike. Quote/backslash are impossible in a mermaid id, but a
  // selector built from DOM text checks rather than trusts.
  const edgeId = bound.el.getAttribute('data-id');
  if (edgeId === null || /["\\]/.test(edgeId)) return;
  const inner = session.svg.querySelector(`g.edgeLabels g.label[data-id="${edgeId}"]`);
  const outer = inner?.parentElement ?? null; // g.edgeLabel — what mermaid translates
  if (outer === null) return;
  const toParent = planeToParent(session, outer);
  if (toParent === null) return;
  const p = applyPoint(toParent, mid);
  outer.setAttribute('transform', `translate(${round2(p.x)}, ${round2(p.y)})`);
}

/**
 * Grows the svg's viewBox — and the size attributes that go with it — so that
 * every node box plus `PAD` is inside it. Returns true when anything changed.
 *
 * This is not a nicety. MEASURED by the M29.40 spike on a demo-corpus diagram:
 * viewBox `0 0 108.625 445.3125` with `max-width: 108.625px` and the UA's
 * `overflow: hidden` means a node dragged +120px right does not clip — it
 * VANISHES, entirely. Growth is the whole fix, and it is three attribute
 * writes with no re-render.
 *
 * Recomputed from mermaid's OWN viewBox every call, never from the box it last
 * wrote, so repeated drag frames cannot compound and dragging back inside
 * restores mermaid's box exactly. Mermaid's box is also the FLOOR: shrinking
 * below it would crop the clusters, labels and markers this function does not
 * track.
 */
export function growViewBox(session: ManualLayoutSession): boolean {
  const { vb } = session;
  let minX = vb.x;
  let minY = vb.y;
  let maxX = vb.x + vb.w;
  let maxY = vb.y + vb.h;
  for (const box of session.boxes.values()) {
    minX = Math.min(minX, box.cx - box.halfW - PAD);
    minY = Math.min(minY, box.cy - box.halfH - PAD);
    maxX = Math.max(maxX, box.cx + box.halfW + PAD);
    maxY = Math.max(maxY, box.cy + box.halfH + PAD);
  }
  const next = {
    x: round2(minX),
    y: round2(minY),
    w: round2(maxX - minX),
    h: round2(maxY - minY),
  };
  const text = `${next.x} ${next.y} ${next.w} ${next.h}`;
  if (session.svg.getAttribute('viewBox') === text) return false;
  session.svg.setAttribute('viewBox', text);
  // Same plane-units-per-pixel as mermaid chose: the canvas gets bigger, the
  // diagram does not silently zoom. (A CSS max-width on the host then decides
  // whether the wider box is shown at size or fitted — either way, visible.)
  const rx = next.w / vb.w;
  const ry = next.h / vb.h;
  scaleLength(session.svg, 'width', session.sizes.width, rx);
  scaleLength(session.svg, 'height', session.sizes.height, ry);
  const maxWidth = session.sizes.maxWidth.match(new RegExp(String.raw`^\s*(${NUM})px\s*$`));
  if (maxWidth !== null) session.svg.style.maxWidth = `${round2(Number(maxWidth[1]) * rx)}px`;
  return true;
}

/**
 * Scales a pixel-valued size attribute. `configureSvgSize` writes either
 * width="100%" + a max-width style (useMaxWidth, our case) or numeric
 * width/height — a percentage is already relative and is left alone.
 */
function scaleLength(svg: SVGSVGElement, name: string, base: string | null, ratio: number): void {
  if (base === null) return;
  const m = base.match(new RegExp(String.raw`^\s*(${NUM})(px)?\s*$`));
  if (m === null) return;
  svg.setAttribute(name, `${round2(Number(m[1]) * ratio)}${m[2] ?? ''}`);
}

/** Moves one node and re-routes its incident bound edges (drag frames). */
export function moveNode(
  session: ManualLayoutSession,
  binding: FlowchartSvgBinding,
  id: string,
  centre: Pt,
): void {
  const el = binding.nodeEls.get(id);
  if (el === undefined) return;
  if (!setNodeTransform(session, el, id, centre)) return;
  for (const bound of binding.edgeEls) {
    if (bound.from === id || bound.to === id) rerouteEdge(session, bound);
  }
  growViewBox(session);
}

/**
 * Full application after a render: place every stored node, then straighten
 * EVERY bound edge — moved or not — so manual mode has one consistent look
 * instead of a patchwork of curves and lines. Finally grow the box to fit.
 */
export function applyManualLayout(
  session: ManualLayoutSession,
  binding: FlowchartSvgBinding,
  positions: ReadonlyMap<string, Pt>,
): void {
  for (const [id, pt] of positions) {
    const el = binding.nodeEls.get(id);
    if (el !== undefined) setNodeTransform(session, el, id, pt);
  }
  for (const bound of binding.edgeEls) rerouteEdge(session, bound);
  growViewBox(session);
}

/**
 * The one-call read-only pipeline for view surfaces: parse, check the marker,
 * bind, measure, apply. Silently a no-op for non-flowcharts, auto-mode
 * diagrams, and unmeasurable hosts — a diagram always renders, whatever this
 * does or does not manage to do to it.
 */
export function applyStoredManualLayout(host: HTMLElement, code: string): void {
  const model = parseFlowchart(code);
  if (model === null || !isManualLayout(model)) return;
  const binding = bindFlowchartSvg(host, model);
  const session = beginManualLayout(host, binding);
  if (session === null) return;
  const positions: ReadonlyMap<string, PlanePoint> = storedPositions(model);
  applyManualLayout(session, binding, positions);
}
