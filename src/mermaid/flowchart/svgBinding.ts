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

  for (const el of container.querySelectorAll<SVGGElement>('g.node[id*="flowchart-"]')) {
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
  const clusterEls = new Map<string, SVGGElement>();
  const knownSubs = subgraphs(model);
  for (const el of container.querySelectorAll<SVGGElement>('g.cluster')) {
    const domId = stripRenderId(el.id);
    const hit = knownSubs.find((s) => s.id === domId);
    if (hit !== undefined && !clusterEls.has(hit.id)) clusterEls.set(hit.id, el);
  }

  // Neutralize mermaid's own anchors (M29.38). MEASURED on 11.16.0: at
  // `securityLevel: 'strict'` mermaid attaches no click HANDLER, but a `click`
  // line still emits a real `<a href="…">` that WRAPS the node `<g>` bound
  // above. A default action is not propagation, so the node handler's
  // `stopPropagation()` never touched it — clicking a linked node merely to
  // SELECT it followed the link, and inside the Tauri webview that takes the
  // whole app off the SPA. `javascript:` targets are already dropped by
  // sanitizeUrl; a vault-relative or absolute one is live navigation. The
  // EDITOR owns click semantics here (M29.36) and the badge is the hit target,
  // so no href in this subtree survives — including one around a node the
  // model could not resolve, which is just as navigable. The anchor element
  // itself stays: it carries mermaid's own layout, and removing it would
  // reparent the very groups just bound.
  for (const a of container.querySelectorAll('a[href]')) a.removeAttribute('href');

  return { nodeEls, edgeEls, clusterEls };
}
