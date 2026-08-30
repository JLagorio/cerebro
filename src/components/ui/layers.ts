import { useId, useLayoutEffect, useRef } from 'react';

/**
 * The stack of dismissable surfaces, innermost last (M16.1).
 *
 * Before this there was no stack — each surface asked the DOM whether it was
 * on top, and each asked a different question. `Dialog` counted `.cb-dlg`
 * nodes and compared the last one to its own card; `DetailPanel` probed for
 * any `[role="dialog"]` and bailed if it found one. Both answers were wrong
 * for the same reason: a surface that renders no dialog role and no `.cb-dlg`
 * class — which is every popover in the app — was invisible to them. That is
 * why Escape inside the add-property surface tore down the entire record
 * panel instead of closing the popover.
 *
 * Registration is explicit, so a surface counts as a layer because it said so,
 * not because of what it happens to render.
 *
 * A layer carries two things beyond its id (M16.35), because the stack is the
 * single source of truth for who owns a dismissal and an id alone cannot
 * answer either question:
 *
 * - **The surface it owns.** An outside-press check written as
 *   `surfaceRef.contains(target)` is a question about one component's own DOM
 *   subtree, and `Popover` PORTALS to `document.body` — so a menu opened from
 *   inside another menu is not a descendant of it, and a press aimed squarely
 *   at the inner menu read as "outside" and closed the outer one mid-gesture.
 *   `FilterValueEditor` had already hit this and worked around it by refusing
 *   to portal at all. Asking the stack fixes every nesting at once.
 * - **Its kind.** A tooltip is dismissable but not modal. It has to take its
 *   own Escape — otherwise one keystroke dismisses the tooltip AND the record
 *   panel behind it — without passing for the innermost SURFACE, which would
 *   hand a focus-trapped popover's `Tab` to a bubble floating over it. And Tab
 *   inside a trapped popover is precisely what makes a tooltip appear.
 *
 * A drag in flight is the same shape as a tooltip and pushed for the same
 * reason (`'gesture'`, M46.2): Escape belongs to the gesture until it ends, and
 * the surfaces that would otherwise take it — the record panel, a dialog, the
 * popover the list is drawn inside — all ask this stack who owns the keystroke.
 * It must NOT pass for a surface: nothing opened, so a focus trap that thought
 * it had been superseded would hand the dialog's `Tab` to a drag, and a global
 * handler standing down for `hasLayers()` would go quiet for the length of a
 * drag it has nothing to do with.
 */

export type LayerKind = 'surface' | 'tooltip' | 'gesture';

export interface LayerOptions {
  /**
   * `'tooltip'` and `'gesture'` register for Escape only: both are skipped by
   * every question about the innermost surface. Default `'surface'`.
   */
  kind?: LayerKind;
  /**
   * The nodes this layer owns — normally its panel. Asked of the layers ABOVE
   * a surface to tell a press aimed at one of them from a press aimed past
   * everything.
   */
  contains?: (node: Node) => boolean;
}

interface Layer {
  id: string;
  kind: LayerKind;
  contains: (node: Node) => boolean;
}

const stack: Layer[] = [];

/** The default for a layer that registers no surface — including the bare
 * `pushLayer(id)` calls tests make. It claims nothing, so it never suppresses
 * a dismissal it cannot justify. */
const OWNS_NOTHING = (): boolean => false;

export function pushLayer(id: string, options: LayerOptions = {}): void {
  if (stack.some((l) => l.id === id)) return;
  stack.push({
    id,
    kind: options.kind ?? 'surface',
    contains: options.contains ?? OWNS_NOTHING,
  });
}

export function popLayer(id: string): void {
  const at = stack.findIndex((l) => l.id === id);
  if (at !== -1) stack.splice(at, 1);
}

/** Everything that blocks. A tooltip floats over a surface without owning it,
 * and a gesture opens no surface at all. */
function surfaces(): Layer[] {
  return stack.filter((l) => l.kind === 'surface');
}

/**
 * True when `id` is the innermost open SURFACE — the layer a focus trap or an
 * outside press belongs to. Tooltips and gestures are skipped: neither one
 * appearing over a menu may take the menu's Tab away from it.
 */
export function isTopLayer(id: string): boolean {
  return surfaces().at(-1)?.id === id;
}

/**
 * True when `id` is the layer a keystroke belongs to — the innermost of
 * everything, tooltips and gestures included, since a visible tooltip is the
 * thing an Escape is aimed at and a drag in flight is what it means to abandon.
 *
 * Asked instead of relying on listener order: every Escape handler in the app
 * sits on `window` in the capture phase, so which one runs first is only
 * whichever surface mounted first — the exact opposite of what precedence
 * needs.
 */
export function ownsEscape(id: string): boolean {
  return stack.at(-1)?.id === id;
}

/** True when anything dismissable is open. Global handlers use this to stand
 * down. Neither a tooltip nor a drag gesture is "open" in that sense — nothing
 * should stand down for either. */
export function hasLayers(): boolean {
  return surfaces().length > 0;
}

/**
 * True when `node` belongs to a layer stacked above `id`.
 *
 * This is what makes a portalled nested surface visible to the surface that
 * opened it: the child is not in the parent's DOM subtree, but it IS above the
 * parent on the stack, and it says which nodes are its own.
 */
export function isInsideLayerAbove(id: string, node: Node): boolean {
  const at = stack.findIndex((l) => l.id === id);
  if (at === -1) return false;
  return stack.slice(at + 1).some((l) => l.contains(node));
}

/** Test seam — the stack is module state and would otherwise leak between cases. */
export function resetLayers(): void {
  stack.length = 0;
}

/**
 * Register this component as a layer for as long as it is mounted, and return
 * its id so it can ask whether it is on top.
 *
 * The id comes from `useId`, so a component that mounts twice is two layers.
 */
export function useLayer(options?: LayerOptions): string {
  const id = useId();
  // Latest-ref: callers pass a fresh object literal every render, and
  // re-registering on identity change would move the layer to the top of the
  // stack on an unrelated re-render.
  const latest = useRef(options);
  latest.current = options;

  // Layout phase, not passive (M16.35). A passive effect runs after the
  // browser has painted, so on the first commit after a surface opened the
  // stack still answered "nothing is open" — and an Escape landing in that
  // window went straight past the visible surface to the record panel behind
  // it, closing the record while the add-property UI it belonged to was
  // already on screen. Layout effects run inside the commit, so a layer is
  // registered as soon as its surface exists.
  //
  // StrictMode's double invoke stays correct: `pushLayer` ignores an id
  // already on the stack, the cleanup removes it, and mount/cleanup/mount runs
  // in the same relative order for every layer, so nothing is re-ordered and
  // nothing leaks.
  useLayoutEffect(() => {
    pushLayer(id, {
      kind: latest.current?.kind,
      contains: (node) => latest.current?.contains?.(node) ?? false,
    });
    return () => popLayer(id);
  }, [id]);
  return id;
}
