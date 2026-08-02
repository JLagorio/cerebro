import { useEffect, useId } from 'react';

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
 */
const stack: string[] = [];

export function pushLayer(id: string): void {
  if (!stack.includes(id)) stack.push(id);
}

export function popLayer(id: string): void {
  const at = stack.indexOf(id);
  if (at !== -1) stack.splice(at, 1);
}

/** True when `id` is the innermost open layer — the one a keystroke belongs to. */
export function isTopLayer(id: string): boolean {
  return stack.length > 0 && stack[stack.length - 1] === id;
}

/** True when anything dismissable is open. Global handlers use this to stand down. */
export function hasLayers(): boolean {
  return stack.length > 0;
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
export function useLayer(): string {
  const id = useId();
  useEffect(() => {
    pushLayer(id);
    return () => popLayer(id);
  }, [id]);
  return id;
}
