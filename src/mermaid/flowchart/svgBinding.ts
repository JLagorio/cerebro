import { neutralizeDiagramLinks } from '../svgLinks';
import type { EdgeEntry, FlowchartModel } from './model';
import { edges, nodes, subgraphs } from './model';

/**
 * Maps mermaid's rendered flowchart SVG back to model ids (M29.16).
 *
 * Contract verified against vendored mermaid 11.16 source
 * (docs/examples/mermaid-develop, package version 11.16.1):
 * - node groups:  <g class="node …" id="flowchart-<nodeId>-<counter>">
 *   (MERMAID_DOM_ID_PREFIX, flowchart/flowDb.ts:35)
 * - edge paths:   <path class="… flowchart-link" id="L_<from>_<to>_<n>">
 *   (getEdgeId, utils.ts:933)
 *
 * Ids may contain dashes/underscores, so node ids are matched by prefix+suffix
 * against KNOWN model ids (longest first), never by a lone capture group.
 *
 * Edge counter semantics (verified against source, not assumed):
 * the renderer's `getData()` (flowchart/flowDb.ts:1246) calls
 * `getEdgeId(start, end, { counter: index, prefix: 'L' }, rawEdge.id)` where
 * `index` is the edge's global position in the diagram — but `getEdgeId`
 * (utils.ts:946-951) returns its 4th argument unchanged whenever it is
 * truthy, and `rawEdge.id` has ALREADY been set by then, at parse time, in
 * `addSingleLink` (flowDb.ts:313-327). So the global `index` never actually
 * reaches the DOM; the id rendered is the one assigned during parsing, which
 * is scoped per (from, to) PAIR, not global:
 *   - a pair's 1st occurrence            → counter 0
 *   - a pair's (k+1)-th occurrence (k≥1) → counter k+1
 *   (so a pair's own counter sequence is 0, 2, 3, 4, … — 1 never appears,
 *   because `addSingleLink` computes it as `existingLinks.length + 1` where
 *   `existingLinks` already has length 1 by the second occurrence)
 * This per-pair counter disambiguates duplicate edges between the SAME two
 * nodes (`A --> B` declared twice: ids `L_A_B_0` and `L_A_B_2`, never a lone
 * `find()` on the flat edge list, which would silently prefer whichever
 * EdgeEntry happens to sort first regardless of which counter suffix the
 * path actually carries).
 *
 * It does NOT, however, disambiguate two DIFFERENT pairs whose id text
 * collides as strings purely from how the pieces concatenate — e.g. nodes
 * `A_B`/`C` and `A`/`B_C` both render ids starting `L_A_B_C_`. Both pairs'
 * *first* occurrence is unconditionally counter 0 (that's determined solely
 * by "has this exact pair been seen before", never by what other pairs
 * exist), so two unrelated edges can legitimately render the literal same
 * DOM id — an irreducible collision in mermaid's own id scheme, not
 * something any amount of cleverness recovers from the string alone. What
 * the counter DOES let us do is rule out impossible candidates: a pair that
 * only appears once in the model can never have produced a `_2` (or higher)
 * suffix, so a colliding id at that suffix belongs unambiguously to the
 * other pair. We resolve every case the counter can settle and, for the ones
 * it structurally can't (a shared first-occurrence id), leave the element
 * unbound rather than guess — consistent with this module's contract that
 * unmatched or undecidable elements render fine, they just aren't editable.
 */
export interface FlowchartSvgBinding {
  nodeEls: Map<string, SVGGElement>;
  edgeEls: (EdgeEntry & { el: SVGPathElement })[];
  /**
   * Cluster groups by EFFECTIVE subgraph id (M29.38). Unmatched clusters are
   * absent rather than guessed at — same contract as nodes and edges: an
   * element we cannot resolve renders fine, it just is not editable.
   */
  clusterEls: Map<string, SVGGElement>;
}

/**
 * Mirrors the per-pair id counter assigned at parse time by mermaid's
 * `addSingleLink` (flowDb.ts:313-327): the pair's 1st occurrence (index 0)
 * gets counter 0; occurrence k (k ≥ 1) gets counter k+1.
 */
function counterForOccurrence(occurrenceIndex: number): number {
  return occurrenceIndex === 0 ? 0 : occurrenceIndex + 1;
}

/**
 * Every group mermaid draws a NODE as. FOUR classes, because the class depends
 * on TWO independent axes and reading only one of them is how this went wrong
 * twice:
 *
 * - the SHAPE picks the handler. The four icon handlers pass
 *   `'icon-shape default'` to labelHelper and imageSquare passes
 *   `'image-shape default'`; every other shape in our registry says `node`.
 * - the LOOK picks the prefix, for everything that is not an icon or an image.
 *   `getNodeClasses` (rendering-elements/shapes/util.ts) is
 *   `(node.look === 'handDrawn' ? 'rough-node' : 'node') + ' ' + …`, so a
 *   document with `look: handDrawn` in its config frontmatter draws EVERY
 *   ordinary node as `rough-node default`. `rough-node` is the only `rough-*`
 *   class in the whole rendering-util tree.
 *
 * All four MEASURED on the bundled 11.16.0 (asserted in
 * `icons.mermaid.test.ts`), including the combination: in one handDrawn
 * document an icon node is `icon-shape default` while its neighbour is
 * `rough-node default`, so the axes really are independent and both arms have
 * to coexist. Two measured negatives worth keeping: `look: neo` is NOT rough
 * (`node default`), and handDrawn leaves `g.cluster` and `path.flowchart-link`
 * alone — only the node class moves.
 *
 * Why it matters, twice over. Matching `g.node` alone made an icon node
 * unreachable the moment M29.35's icon control was used on it — no toolbar, no
 * rename, no delete, no drag-to-connect, no link badge, and no way to take the
 * icon back off, because the only control that removes it lives behind the very
 * selection it had just destroyed (found by M29.39's e2e). And it lost EVERY
 * node of a hand-drawn document: `parseFlowchart` holds the frontmatter opaque
 * but still finds the header, so the editor mounts, binds nothing, and offers a
 * canvas where no gesture does anything. That one is not ours to have caused —
 * nothing in the app writes `look:`, so it arrives only in hand-authored or
 * pasted source — but it is ours to have missed.
 *
 * The id filter still does the real work: the id scheme is what this module
 * contracts on, and it is identical across all four. It is also what keeps an
 * icon's inner `g.icon-shape2` decoration out — that group carries no id.
 */
export const NODE_GROUP_SELECTOR = [
  'g.node[id*="flowchart-"]',
  'g.rough-node[id*="flowchart-"]',
  'g.icon-shape[id*="flowchart-"]',
  'g.image-shape[id*="flowchart-"]',
].join(', ');

/** Groups edges(model) by exact (from, to), preserving each pair's own encounter order. */
function groupByPair(pairs: EdgeEntry[]): Map<string, EdgeEntry[]> {
  const byPair = new Map<string, EdgeEntry[]>();
  for (const p of pairs) {
    const key = `${p.from}\u0000${p.to}`;
    const group = byPair.get(key);
    if (group === undefined) byPair.set(key, [p]);
    else group.push(p);
  }
  return byPair;
}

export function bindFlowchartSvg(
  container: HTMLElement,
  model: FlowchartModel,
): FlowchartSvgBinding {
  // In a real browser mermaid namespaces every internal DOM id with the id
  // the diagram was rendered under — our `cerebro-mermaid-<seq>` — so a node
  // group renders as `cerebro-mermaid-3-flowchart-Idea-0` and an edge path as
  // `cerebro-mermaid-3-L_Idea_Build_0` (observed live, M29.19; the vendored
  // flowDb builds the bare `flowchart-…`/`L_…` ids, the svg-emit layer adds
  // the diagram id on top). Strip that render-id prefix off before matching
  // so the contract below keeps reasoning about mermaid's own id scheme;
  // stripping is a no-op when the prefix isn't there (unit fixtures).
  const svgId = container.querySelector('svg')?.id ?? '';
  const stripRenderId = (domId: string): string =>
    svgId !== '' && domId.startsWith(`${svgId}-`) ? domId.slice(svgId.length + 1) : domId;

  const knownNodes = [...nodes(model).keys()].sort((a, b) => b.length - a.length);
  const nodeEls = new Map<string, SVGGElement>();

  for (const el of container.querySelectorAll<SVGGElement>(NODE_GROUP_SELECTOR)) {
    const domId = stripRenderId(el.id);
    if (!domId.startsWith('flowchart-')) continue;
    const match = knownNodes.find(
      (id) =>
        domId.startsWith(`flowchart-${id}-`) &&
        /^\d+$/.test(domId.slice(`flowchart-${id}-`.length)),
    );
    if (match !== undefined && !nodeEls.has(match)) nodeEls.set(match, el);
  }

  const allEdges = edges(model);
  const byPair = groupByPair(allEdges);
  const edgeEls: FlowchartSvgBinding['edgeEls'] = [];

  for (const el of container.querySelectorAll<SVGPathElement>('path.flowchart-link')) {
    const domId = stripRenderId(el.id);

    // A user-authored edge id (`A e1@--> B`, M29.31) renders VERBATIM —
    // `getEdgeId` (utils.ts:946) returns its 4th argument untouched when
    // truthy — so the path is `<renderId>-e1` and never matches the `L_…`
    // scheme below. Without this arm, setEdgeAnimate would be a ONE-WAY
    // control: minting the id unbinds the very edge whose toggle you just
    // used (measured — `B->C` disappeared from the binding). Ids are unique
    // per diagram (`addSingleLink` hands a duplicate an auto id instead,
    // flowDb.ts:315), so an exact match is unambiguous.
    const byId = allEdges.filter((e) => e.id !== null && e.id === domId);
    if (byId.length === 1) {
      edgeEls.push({ ...byId[0], el });
      continue;
    }

    // Every (from, to) pair whose "L_<from>_<to>_" text is a prefix of this
    // id, with a purely-numeric remainder — candidates before counter checks.
    const prefixMatches: { key: string; counter: number }[] = [];
    for (const key of byPair.keys()) {
      const [from, to] = key.split('\u0000');
      const prefix = `L_${from}_${to}_`;
      if (!domId.startsWith(prefix)) continue;
      const rest = domId.slice(prefix.length);
      if (!/^\d+$/.test(rest)) continue;
      prefixMatches.push({ key, counter: Number(rest) });
    }

    // Counter-consistent: could this pair, given how many times it actually
    // occurs in the model, have produced this exact counter value?
    const consistent = prefixMatches.filter(({ key, counter }) => {
      const group = byPair.get(key) ?? [];
      return group.some(
        (_entry, occurrenceIndex) => counterForOccurrence(occurrenceIndex) === counter,
      );
    });

    // Exactly one survivor → bind to that pair's matching occurrence. Zero
    // survivors (nothing in the model could have produced this id) or
    // several (a genuine collision on a shared first-occurrence id — see
    // the docstring) → leave unbound rather than risk editing the wrong edge.
    if (consistent.length !== 1) continue;
    const { key, counter } = consistent[0];
    const group = byPair.get(key) ?? [];
    const entry = group.find((_entry, i) => counterForOccurrence(i) === counter);
    if (entry !== undefined) edgeEls.push({ ...entry, el });
  }

  // Clusters (M29.38). DOM contract MEASURED on the BUNDLED 11.16.0, not read
  // off the vendored 11.16.1 source (see subgraphs.mermaid.test.ts): a
  // subgraph renders as `<g class="cluster" id="<renderId>-<subgraphId>">` —
  // the id is the effective subgraph id EXACTLY, with no `flowchart-` prefix
  // and no counter, unlike a node group. So after stripRenderId this is an
  // exact-equality lookup against the ids `subgraphs()` computes (which mirror
  // flowDb's close-order ordinals). Node groups are NOT descendants of the
  // cluster — they sit in a sibling `g.nodes` layer — so a cluster's own box
  // is the only thing a click on it can land on.
  //
  // …on DAGRE. The bundled ELK renderer writes the group's DOM id from an
  // object rather than from the subgraph id, so `el.id` is literally the string
  // "[object Object]" — MEASURED on demo-vault/diagrams/pipeline.mmd, which
  // ships `layout: elk`: the cluster's id was "[object Object]", its
  // `style.cursor` was never set, its `onclick` was null, and a 21x21 grid of
  // elementFromPoint probes found 217 of 441 points landing on its own rect, so
  // it was perfectly hittable with nothing listening. Every subgraph control —
  // rename, per-block direction, ungroup — was unreachable under that engine,
  // with no other route to any of them.
  //
  // The fallback is DOCUMENT ORDER. mermaid emits one `g.cluster` per subgraph,
  // and `subgraphs()` lists them in close order, which is the same order — so
  // when the id says nothing, the k-th cluster is the k-th block. It only ever
  // runs for clusters whose id resolved to nothing, so a diagram whose ids DO
  // resolve is bound exactly as before.
  const clusterEls = new Map<string, SVGGElement>();
  const knownSubs = subgraphs(model);
  const unresolved: SVGGElement[] = [];
  for (const el of container.querySelectorAll<SVGGElement>('g.cluster')) {
    const domId = stripRenderId(el.id);
    const hit = knownSubs.find((s) => s.id === domId);
    if (hit === undefined) {
      unresolved.push(el);
      continue;
    }
    if (!clusterEls.has(hit.id)) clusterEls.set(hit.id, el);
  }
  if (unresolved.length > 0) {
    const spare = knownSubs.filter((s) => !clusterEls.has(s.id));
    // Positional, and only when the counts agree: a partial match means the
    // rendered picture and the model disagree about how many blocks there are,
    // and binding a toolbar to the wrong block is worse than binding none.
    if (spare.length === unresolved.length) {
      spare.forEach((s, i) => clusterEls.set(s.id, unresolved[i]));
    }
  }

  // Neutralize mermaid's own anchors (M29.38). At `securityLevel: 'strict'`
  // mermaid attaches no click HANDLER, but a `click` line still emits a real
  // anchor that WRAPS the node `<g>` bound above. A default action is not
  // propagation, so the node handler's `stopPropagation()` never touched it —
  // clicking a linked node merely to SELECT it followed the link, and inside
  // the Tauri webview that takes the whole app off the SPA. The EDITOR owns
  // click semantics here (M29.36) and the badge is the hit target, so no link
  // in this subtree survives — including one around a node the model could
  // not resolve, which is just as navigable. Shared with the read-only
  // viewers, which have exactly the same problem and no binding pass to hang
  // it on; `../svgLinks` documents what was measured and why the attribute
  // goes rather than the click being intercepted.
  neutralizeDiagramLinks(container);

  return { nodeEls, edgeEls, clusterEls };
}
