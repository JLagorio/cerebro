import type { Box } from '@/engine/scene/model';
import { parseFlowchart } from '@/mermaid/flowchart/model';
import { bindFlowchartSvg, NODE_GROUP_SELECTOR } from '@/mermaid/flowchart/svgBinding';
import { beginManualLayout } from '@/mermaid/flowchart/manualLayout';

/** Current boxes in SVG plane units, including manual placement and CSS zoom.
 * A missing/unmeasurable render returns null so conversion names its defaults. */
export function measureMermaidBoard(
  container: HTMLElement | null,
  code: string,
): Map<string, Box> | null {
  if (!container) return null;
  const model = parseFlowchart(code);
  if (!model) return null;
  // A page also holds toolbar SVG icons. Bind against the diagram's own host
  // so its render id and plane are read from the same SVG as the node boxes.
  const diagramHost =
    container.querySelector<SVGGElement>(NODE_GROUP_SELECTOR)?.ownerSVGElement?.parentElement;
  const host = diagramHost instanceof HTMLElement ? diagramHost : container;
  const measured = beginManualLayout(host, bindFlowchartSvg(host, model));
  if (!measured || measured.boxes.size === 0) return null;
  return new Map(
    [...measured.boxes].map(([id, box]) => [
      id,
      {
        x: box.cx - box.halfW,
        y: box.cy - box.halfH,
        width: box.halfW * 2,
        height: box.halfH * 2,
      },
    ]),
  );
}
