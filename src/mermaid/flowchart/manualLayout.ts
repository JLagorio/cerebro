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
 * TWO FRAMES, AND THEY ARE NOT THE SAME FRAME. `growViewBox` rewrites the
 * viewBox, which changes where a plane point lands on screen — i.e. it changes
 * the svg's screen CTM. That splits the client<->plane map into two jobs with
 * opposite requirements, and an earlier version of this module used one map for
 * both, which was a shipping defect:
 *
 * - WRITES (plane -> an element's own space) must use a LIVE map, re-read in
 *   the same batch as the element CTMs it is composed with. `session.frame` is
 *   refreshed at the top of every write batch for exactly this reason. Mixing a
 *   pinned svg CTM with live element CTMs displaces every point-mapped write —
 *   each re-routed edge `d` and every edge-label transform — by the viewBox
 *   origin shift, so edges detach from their nodes and slide further away with
 *   each frame. (Node transforms survived it: they use only the linear part.)
 * - A GESTURE (cursor -> plane) must PIN its map at pointerdown and never
 *   re-read it, because a frame that re-derives an absolute plane point against
 *   a freshly-grown box feeds its own growth: grow left, the cursor's plane x
 *   drops, the node moves further left, grow again. Callers pin one with
 *   `measurePlaneFrame` and drag deltas through it (`clientDeltaToPlane`).
 *
 * Pinning at BIND time serves neither job: a `CanvasViewport` fit or wheel-zoom
 * lands after the bind effect, so the first drag would be off by the fit ratio.
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

/**
 * The client<->plane mapping as of one measurement. Re-read for every write
 * batch; PINNED for the duration of one pointer gesture. See the module
 * docstring for why those are different requirements.
 */
export interface PlaneFrame {
  clientFromPlane: Mat;
  planeFromClient: Mat;
  /** Client pixels per plane unit (includes any ancestor CSS zoom). */
  scale: number;
}

export interface ManualLayoutSession {
  svg: SVGSVGElement;
  /** True when writes go through real screen CTMs rather than the fallback. */
  exact: boolean;
  /** The map used by the CURRENT write batch. Refreshed, never pinned. */
  frame: PlaneFrame;
  /** Mermaid's OWN viewBox: the floor `growViewBox` never shrinks below. */
  vb: ViewBox;
  /** The size attributes exactly as mermaid wrote them, for growth ratios. */
  sizes: { viewBox: string; width: string | null; height: string | null; maxWidth: string };
  /** Live node boxes in plane units — mutated as nodes move. */
  boxes: Map<string, Box>;
  /** Mermaid's auto centres, measured once on the pristine render. */
  auto: Map<string, Pt>;
  /** Each group's transform attribute exactly as mermaid rendered it. */
  base: Map<string, string>;
}

/** Plane units of breathing room between the outermost node and the viewBox. */
const PAD = 8;

/**
 * How far past mermaid's own box each SIDE may grow, as a multiple of that
 * box's extent — so an axis can never exceed 4x what mermaid drew.
 */
const GROWTH_BUDGET = 1.5;

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

function parseViewBox(raw: string | null): ViewBox | null {
  if (raw === null) return null;
  const parts = raw
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  return { x: parts[0], y: parts[1], w: parts[2], h: parts[3] };
}

function viewBoxOf(svg: SVGSVGElement): ViewBox | null {
  // The attribute, not svg.viewBox.baseVal: jsdom implements only the former.
  return parseViewBox(svg.getAttribute('viewBox'));
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

const TRANSLATE_TERM = new RegExp(String.raw`translate\(\s*(${NUM})(?:[\s,]+(${NUM}))?\s*\)`, 'g');

/**
 * A transform attribute's text as ONE translation — a CHAIN of them sums,
 * because translations compose additively and because our own writes make
 * chains: after one application a node group reads
 * `translate(30, 20) translate(250, 0)`. Reading only a lone translate here is
 * how a session begun over an ALREADY-TRANSFORMED DOM froze every node it
 * touched (the `applyStoredManualLayout`-twice case: asked for x=50, stayed at
 * 250). Null for anything that is not exclusively translates.
 *
 * `chain` is how many terms were found, so a caller can tell "mermaid's own
 * lone translate" from "ours appended to it" and normalise.
 */
function parseTranslateChain(text: string | null): (Pt & { chain: number }) | null {
  if (text === null || text.trim() === '') return { x: 0, y: 0, chain: 0 };
  let x = 0;
  let y = 0;
  let chain = 0;
  let consumed = 0;
  TRANSLATE_TERM.lastIndex = 0;
  for (let m = TRANSLATE_TERM.exec(text); m !== null; m = TRANSLATE_TERM.exec(text)) {
    // Anything BETWEEN the terms that is not whitespace or a comma is another
    // kind of transform, and this whole element is then out of our reach.
    if (text.slice(consumed, m.index).trim() !== '') return null;
    x += Number(m[1]);
    y += Number(m[2] ?? '0');
    chain += 1;
    consumed = m.index + m[0].length;
  }
  if (chain === 0 || text.slice(consumed).trim() !== '') return null;
  return { x, y, chain };
}

/** A transform attribute's text as a translation, or null if it is anything else. */
function parseTranslate(text: string | null): Pt | null {
  const t = parseTranslateChain(text);
  return t === null ? null : { x: t.x, y: t.y };
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
    return inv === null ? null : mul(inv, session.frame.clientFromPlane);
  }
  const anc = accumulatedTranslate(el, session.svg);
  return anc === null ? null : translation(-anc.x, -anc.y);
}

/** plane -> `el`'s own user space, i.e. what its `d`/children coordinates mean. */
function planeToLocal(session: ManualLayoutSession, el: Element): Mat | null {
  if (session.exact) {
    const ctm = screenCtmOf(el);
    const inv = ctm === null ? null : invert(ctm);
    return inv === null ? null : mul(inv, session.frame.clientFromPlane);
  }
  const anc = accumulatedTranslate(el, session.svg);
  const own = ownTranslate(el);
  if (anc === null || own === null) return null;
  return translation(-(anc.x + own.x), -(anc.y + own.y));
}

/**
 * The pristine size record, stashed on the svg the first time we measure it.
 *
 * `growViewBox` REWRITES the viewBox, so "mermaid's own box" cannot be read
 * back off the element once we have touched it — a second session over the same
 * DOM would take the grown box as its floor and ratchet: measured 298 -> 440.1
 * -> 646.15 across three applications of the same positions. The record makes
 * the whole pipeline idempotent across sessions on one DOM, and it disappears
 * by itself whenever mermaid replaces the svg, which is exactly when it should.
 */
const AUTO_BOX_ATTR = 'data-cerebro-auto-box';

interface AutoBox {
  viewBox: string;
  width: string | null;
  height: string | null;
  maxWidth: string;
}

function pristineBox(svg: SVGSVGElement): AutoBox {
  const saved = svg.getAttribute(AUTO_BOX_ATTR);
  if (saved !== null) {
    try {
      const parsed: unknown = JSON.parse(saved);
      if (typeof parsed === 'object' && parsed !== null && 'viewBox' in parsed) {
        return parsed as AutoBox;
      }
    } catch {
      // Someone else's attribute, or ours mangled: re-record from what is
      // there now. Worse than the truth, better than throwing in a render.
    }
  }
  const fresh: AutoBox = {
    viewBox: svg.getAttribute('viewBox') ?? '',
    width: svg.getAttribute('width'),
    height: svg.getAttribute('height'),
    maxWidth: svg.style.maxWidth,
  };
  svg.setAttribute(AUTO_BOX_ATTR, JSON.stringify(fresh));
  return fresh;
}

/**
 * The client<->plane map as the DOM has it RIGHT NOW.
 *
 * Callers that write geometry re-read this every batch (a pinned copy composed
 * with live element CTMs is the frame-mixing defect the module docstring
 * describes). Callers driving a POINTER gesture call this once at pointerdown
 * and pin the result for the whole drag.
 */
export function measurePlaneFrame(svg: SVGSVGElement): PlaneFrame | null {
  const ctm = screenCtmOf(svg);
  const ctmInv = ctm === null ? null : invert(ctm);
  if (ctm !== null && ctmInv !== null) {
    const scale = Math.hypot(ctm.a, ctm.b);
    return scale > 0 ? { clientFromPlane: ctm, planeFromClient: ctmInv, scale } : null;
  }
  // The LIVE viewBox, not the pristine one: this describes what the browser is
  // painting now, which is what a client coordinate has to be read against.
  const vb = viewBoxOf(svg);
  if (vb === null || vb.w <= 0) return null;
  const r = svg.getBoundingClientRect();
  if (r.width <= 0) return null;
  // Uniform scale: mermaid never writes preserveAspectRatio="none", and a
  // CanvasViewport zoom is uniform too.
  const s = r.width / vb.w;
  const clientFromPlane = { a: s, b: 0, c: 0, d: s, e: r.left - vb.x * s, f: r.top - vb.y * s };
  const planeFromClient = invert(clientFromPlane);
  if (planeFromClient === null || !(s > 0)) return null;
  return { clientFromPlane, planeFromClient, scale: s };
}

/**
 * Measures the render into a session, or refuses (null) when there is nothing
 * measurable — no svg, no usable viewBox, or (fallback path) a zero-size client
 * box, which is what a hidden host and an unstubbed jsdom both look like.
 */
export function beginManualLayout(
  host: HTMLElement,
  binding: FlowchartSvgBinding,
): ManualLayoutSession | null {
  const svg = host.querySelector('svg');
  if (svg === null) return null;
  const auto = pristineBox(svg);
  const vb = parseViewBox(auto.viewBox);
  if (vb === null || vb.w <= 0 || vb.h <= 0) return null;
  const exact = screenCtmOf(svg) !== null;
  const frame = measurePlaneFrame(svg);
  if (frame === null) return null;
  const { planeFromClient, scale } = frame;

  const boxes = new Map<string, Box>();
  const centres = new Map<string, Pt>();
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
    centres.set(id, { x: centre.x, y: centre.y });
    base.set(id, normaliseBase(el.getAttribute('transform')));
  }

  return {
    svg,
    exact,
    frame,
    vb,
    sizes: {
      viewBox: auto.viewBox,
      width: auto.width,
      height: auto.height,
      maxWidth: auto.maxWidth,
    },
    boxes,
    auto: centres,
    base,
  };
}

/**
 * Mermaid's transform kept VERBATIM, except that a chain of translates — which
 * is what our own previous application leaves behind — collapses to one. Two
 * reasons, both measured: the fallback arm can only reason about a base it can
 * parse, and without the collapse the attribute grows by one `translate()` per
 * session forever.
 */
function normaliseBase(raw: string | null): string {
  const t = parseTranslateChain(raw);
  if (t === null || t.chain <= 1) return raw ?? '';
  return `translate(${t.x}, ${t.y})`;
}

/**
 * Client (viewport) coordinates -> plane coordinates, through a frame the
 * caller chose. Pass a frame PINNED at pointerdown for anything driven by a
 * pointer; `session.frame` is refreshed per write batch and is not a stable
 * reference for a gesture.
 */
export function clientToPlane(frame: PlaneFrame, client: Pt): Pt {
  return applyPoint(frame.planeFromClient, client);
}

/**
 * A client-pixel DELTA -> a plane delta. Origin-free, so it survives a viewBox
 * growth that moved the plane origin under the cursor — which is exactly why
 * drag frames must use this rather than differencing two `clientToPlane` calls
 * taken either side of a growth.
 */
export function clientDeltaToPlane(frame: PlaneFrame, delta: Pt): Pt {
  return applyVector(frame.planeFromClient, delta);
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
    return inv === null ? null : mul(inv, session.frame.clientFromPlane);
  }
  if (accumulatedTranslate(el, session.svg) === null) return null;
  // Pure-translate ancestry AND a pure-translate base mean local units ARE
  // plane units, so a delta transfers 1:1.
  return parseTranslateChain(session.base.get(id) ?? '') === null ? null : IDENTITY;
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
  // Two nodes dropped on the same spot: every border anchor collapses onto the
  // shared centre, so the segment would be `M x,y L x,y` — an invisible edge
  // whose marker has no direction to orient to. Mermaid's own path is a worse
  // fit but a visible one, so it stays until the nodes part again.
  if (from.cx === to.cx && from.cy === to.cy) return;
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
  // The CAP, and why one is needed at all. `%% cerebro:pos A 100000,0` is a
  // legal position line (hand-edited, a bad merge, some future op), and growing
  // to hold it writes a ~100000-unit viewBox: the svg fits to its container and
  // every real node renders sub-pixel — the diagram goes BLANK. Without growth
  // that same input clips ONE node and leaves the rest legible, so uncapped
  // growth is the one place manual mode can destroy the render of a diagram it
  // should mostly have left alone. Past the budget the outlier is simply
  // clipped, which is precisely the no-growth behaviour.
  minX = Math.max(minX, vb.x - GROWTH_BUDGET * vb.w);
  maxX = Math.min(maxX, vb.x + vb.w + GROWTH_BUDGET * vb.w);
  minY = Math.max(minY, vb.y - GROWTH_BUDGET * vb.h);
  maxY = Math.min(maxY, vb.y + vb.h + GROWTH_BUDGET * vb.h);
  const next = {
    x: round2(minX),
    y: round2(minY),
    w: round2(maxX - minX),
    h: round2(maxY - minY),
  };
  // Byte-for-byte back to mermaid's own string when nothing needs the room:
  // rounding a real `0 0 108.625 445.3125` to two decimals would leave the
  // "restored exactly" claim below a rounding error short of true.
  const grew =
    next.x !== round2(vb.x) ||
    next.y !== round2(vb.y) ||
    next.w !== round2(vb.w) ||
    next.h !== round2(vb.h);
  const text = grew ? `${next.x} ${next.y} ${next.w} ${next.h}` : session.sizes.viewBox;
  if (session.svg.getAttribute('viewBox') === text) return false;
  session.svg.setAttribute('viewBox', text);
  if (!grew) {
    // Nothing needs the room any more: hand mermaid's own strings back exactly
    // as it wrote them, rather than a re-multiplied approximation of them.
    setOrRemove(session.svg, 'width', session.sizes.width);
    setOrRemove(session.svg, 'height', session.sizes.height);
    session.svg.style.maxWidth = session.sizes.maxWidth;
    return true;
  }
  // Same plane-units-per-pixel as mermaid chose: the canvas gets bigger, the
  // diagram does not silently zoom. (A CSS max-width on the host then decides
  // whether the wider box is shown at size or fitted — either way, visible.)
  scaleLength(session.svg, 'width', session.sizes.width, next.w / vb.w);
  scaleLength(session.svg, 'height', session.sizes.height, next.h / vb.h);
  const maxWidth = session.sizes.maxWidth.match(new RegExp(String.raw`^\s*(${NUM})px\s*$`));
  if (maxWidth !== null) {
    session.svg.style.maxWidth = `${round2(Number(maxWidth[1]) * (next.w / vb.w))}px`;
  }
  return true;
}

function setOrRemove(svg: SVGSVGElement, name: string, value: string | null): void {
  if (value === null) svg.removeAttribute(name);
  else svg.setAttribute(name, value);
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

/**
 * Re-reads the client<->plane map so the batch about to run composes it with
 * element CTMs measured in the SAME frame. False when the svg has become
 * unmeasurable (detached, hidden) — in which case the batch writes nothing at
 * all rather than writing through a stale map.
 */
function refreshFrame(session: ManualLayoutSession): boolean {
  const frame = measurePlaneFrame(session.svg);
  if (frame === null) return false;
  session.frame = frame;
  return true;
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
  if (!refreshFrame(session)) return;
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
  if (!refreshFrame(session)) return;
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
