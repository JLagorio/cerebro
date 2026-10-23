/** Fixed portals live under body. CSS zoom changes their coordinate space,
 * while bounding rectangles remain in viewport coordinates. Browser page
 * zoom already adjusts CSS viewport units and requires no extra conversion. */
export function readPortalViewport() {
  const zoom = [document.documentElement, document.body].reduce((scale, node) => {
    const value = Number.parseFloat(getComputedStyle(node).zoom);
    return scale * (Number.isFinite(value) && value > 0 ? value : 1);
  }, 1);
  return { zoom, width: window.innerWidth / zoom, height: window.innerHeight / zoom };
}

export function toPortalRect(rect: DOMRect, zoom: number) {
  return {
    left: rect.left / zoom,
    right: rect.right / zoom,
    top: rect.top / zoom,
    bottom: rect.bottom / zoom,
    width: rect.width / zoom,
    height: rect.height / zoom,
  };
}
