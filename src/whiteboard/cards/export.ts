import { inlineForeignObjects } from '@/mermaid/export';
/** Export the durable pointer and text, never a live image URL, nested board,
 * link control or another embedded HTML surface. The on-screen SVG stays live. */
export function boardExportElement(svg: SVGSVGElement): SVGSVGElement {
  if (!svg.querySelector('foreignObject')) return svg;
  const clone = svg.cloneNode(true) as SVGSVGElement;
  // XMLSerializer supplies namespace declarations for these namespace-aware
  // elements; React's plain xmlns attribute would otherwise duplicate one.
  clone.removeAttribute('xmlns');
  for (const nested of clone.querySelectorAll('svg')) nested.removeAttribute('xmlns');
  for (const foreign of clone.querySelectorAll('foreignObject')) {
    const text = foreign.getAttribute('data-board-export-text');
    if (text !== null) {
      const label = document.createElementNS('http://www.w3.org/1999/xhtml', 'div');
      label.style.color = 'var(--n-700)';
      label.style.fontSize = '13px';
      label.textContent = text;
      foreign.replaceChildren(label);
    }
  }
  const serialized = inlineForeignObjects(new XMLSerializer().serializeToString(clone));
  return new DOMParser().parseFromString(serialized, 'image/svg+xml')
    .documentElement as unknown as SVGSVGElement;
}
