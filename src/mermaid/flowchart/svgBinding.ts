import type { FlowchartModel } from './model';
import { edges, nodes } from './model';

/**
 * Maps mermaid's rendered flowchart SVG back to model ids (M29.16).
 *
 * Contract verified against vendored mermaid 11.16 source:
 * - node groups:  <g class="node …" id="flowchart-<nodeId>-<counter>">
 *   (MERMAID_DOM_ID_PREFIX, flowchart/flowDb.ts:35)
 * - edge paths:   <path class="… flowchart-link" id="L_<from>_<to>_<n>">
 *   (getEdgeId, utils.ts:933)
 *
 * Ids may contain dashes/underscores, so node ids are matched by prefix+suffix
 * against KNOWN model ids (longest first), never by a lone capture group; edge
 * ids are matched by testing known (from, to) pairs. Anything unmatched stays
 * unbound — an unbound element renders fine, it just isn't editable.
 */
export interface FlowchartSvgBinding {
  nodeEls: Map<string, SVGGElement>;
  edgeEls: { el: SVGPathElement; from: string; to: string }[];
}

export function bindFlowchartSvg(
  container: HTMLElement,
  model: FlowchartModel,
): FlowchartSvgBinding {
  const knownNodes = [...nodes(model).keys()].sort((a, b) => b.length - a.length);
  const nodeEls = new Map<string, SVGGElement>();

  for (const el of container.querySelectorAll<SVGGElement>('g.node[id^="flowchart-"]')) {
    const domId = el.id;
    const match = knownNodes.find(
      (id) =>
        domId.startsWith(`flowchart-${id}-`) &&
        /^\d+$/.test(domId.slice(`flowchart-${id}-`.length)),
    );
    if (match !== undefined && !nodeEls.has(match)) nodeEls.set(match, el);
  }

  const pairs = edges(model);
  const edgeEls: FlowchartSvgBinding['edgeEls'] = [];
  for (const el of container.querySelectorAll<SVGPathElement>('path.flowchart-link')) {
    const domId = el.id;
    const hit = pairs.find(
      (p) =>
        domId.startsWith(`L_${p.from}_${p.to}_`) &&
        /^\d+$/.test(domId.slice(`L_${p.from}_${p.to}_`.length)),
    );
    if (hit !== undefined) edgeEls.push({ el, from: hit.from, to: hit.to });
  }

  return { nodeEls, edgeEls };
}
