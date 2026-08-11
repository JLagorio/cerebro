import { useLayoutEffect, useRef, type RefObject } from 'react';

/**
 * Make a rendered mermaid diagram unable to navigate the app away (M29.38).
 *
 * At `securityLevel: 'strict'` mermaid attaches no click HANDLER, but a
 * `click`/`link` statement still emits a REAL ANCHOR into the svg — measured
 * on the bundled 11.16.0 in `svgLinks.mermaid.test.ts`, not read off the
 * vendored source:
 *
 * - flowchart and classDiagram wrap the node `<g>` in `<a href="…">`
 * - stateDiagram-v2 spells the same thing `<a xlink:href="…">` — a DIFFERENT
 *   ATTRIBUTE, in the XLink namespace, which an `a[href]` selector does not
 *   match at all
 * - sequenceDiagram puts `<a href="…">` in its `g.actorPopupMenu`
 *
 * `sanitizeUrl` drops `javascript:`, so the danger is not script — it is
 * plain navigation. A vault-relative or absolute target followed inside the
 * Tauri webview takes the WHOLE APP off the SPA, and there is no browser
 * chrome to come back with and no navigation guard on the Rust side: unsaved
 * editor state is simply gone. An `https://` target is no gentler; opening it
 * in the system browser instead would be a feature this app does not have.
 *
 * So a READ-ONLY viewer strips the target rather than intercepting the click.
 * `preventDefault` on a click handler would leave keyboard activation,
 * middle-click and link-drag all live; an anchor with no href is not even
 * focusable, which is the whole point. The ANCHOR ELEMENT STAYS — it carries
 * mermaid's own layout transform, and removing it would reparent the node
 * groups the structural editor binds handlers to.
 *
 * Attributes are matched by LOCAL NAME on `<a>` elements only, so both the
 * plain and the XLink spelling go regardless of prefix, and `<use href>` /
 * `<image href>` — internal references and embedded icons, not navigation —
 * are left exactly alone.
 */
export function neutralizeDiagramLinks(root: ParentNode | null | undefined): void {
  if (root === null || root === undefined) return;
  for (const anchor of root.querySelectorAll<Element>('a')) {
    for (const attr of Array.from(anchor.attributes)) {
      if (attr.localName === 'href') anchor.removeAttributeNode(attr);
    }
  }
}

/**
 * The read-only sinks' one-liner: hold this ref on the element mermaid's svg
 * is injected into, and pass whatever makes that DOM NEW.
 *
 * `useLayoutEffect`, not `useEffect`: it runs in the same commit that wrote
 * the markup, before the browser paints, so a live href never exists in a
 * frame the user could click. And the dependency matters as much as the
 * effect — React rewrites the subtree every time the svg changes, throwing
 * away the last strip, so a fix that only ran on mount would come undone the
 * first time a diagram re-rendered. Callers that keep the component mounted
 * while the sink itself comes and goes (a closed dialog) fold that into the
 * argument, e.g. `open ? svg : null`. The argument is COMPARED, never read:
 * `null` means "nothing new here", not "skip the strip this time".
 */
export function useInertDiagramLinks<T extends HTMLElement>(
  svg: string | null,
): RefObject<T | null> {
  const ref = useRef<T>(null);
  useLayoutEffect(() => {
    neutralizeDiagramLinks(ref.current);
  }, [svg]);
  return ref;
}
