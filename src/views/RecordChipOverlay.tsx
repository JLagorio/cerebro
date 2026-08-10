import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useOpenPath } from '@/app/useOpenPath';
import type { Entry, Schema } from '@/engine/types';
import { useCanvasTransformRef } from '@/mermaid/CanvasViewport';
import { parseFlowchart } from '@/mermaid/flowchart/model';
import { bindFlowchartSvg } from '@/mermaid/flowchart/svgBinding';
import { FieldChip } from '@/views/FieldChip';
import { recordBindings } from '@/views/whiteboardBindings';

/** A node's box in PLANE units — screen pixels with the origin and zoom taken out. */
interface NodeRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const NO_RECTS: ReadonlyMap<string, NodeRect> = new Map();

function sameRects(a: ReadonlyMap<string, NodeRect>, b: ReadonlyMap<string, NodeRect>): boolean {
  if (a.size !== b.size) return false;
  for (const [id, r] of a) {
    const other = b.get(id);
    if (other === undefined) return false;
    if (other.x !== r.x || other.y !== r.y || other.w !== r.w || other.h !== r.h) return false;
  }
  return true;
}

/**
 * The entry's own status field, whatever it is called on its type.
 *
 * Capability-gated, never type-routed (AGENTS.md): a record whose type
 * declares a `status`-kind field is task-like and gets the badge; one that
 * declares none simply has no badge, and no type name is ever consulted.
 */
function statusFieldName(schema: Schema, entry: Entry): string | null {
  const type = entry.type === null ? undefined : schema.types.get(entry.type);
  return type?.fields.find((f) => f.kind === 'status')?.name ?? null;
}

/**
 * Record chips over bound whiteboard nodes (M29.47, spec D8).
 *
 * Rendered INSIDE CanvasViewport's transformed plane, through the shared
 * editor's `overlay` slot — so pan and zoom carry the chips for free and the
 * only arithmetic here is turning each node's screen rect into plane-local
 * units: subtract this layer's own origin, divide by the live scale. Both
 * operands are measured under the SAME transform, so the result is invariant
 * under pan and zoom; that is why nothing re-measures when the viewport moves.
 *
 * The scale therefore comes from `useCanvasTransformRef`, not the value
 * context: subscribing to the live transform would re-run the measurement —
 * a full svg re-bind and a `getBoundingClientRect` per node — on every frame
 * of a pan, for numbers that cannot have changed. Same choice, same reason,
 * as the structural editor's own badge placement.
 *
 * MEASUREMENT MODEL: node positions come from the DOM, and that DOM changes
 * asynchronously and outside this component — mermaid renders off the main
 * path, the structural editor writes the svg imperatively, and manual layout
 * moves every stored node immediately afterwards. So measurement re-runs on
 * (a) a code change and (b) a MutationObserver on the plane catching the svg
 * swap. (b) is what makes the FIRST render of a canvas draw chips at all, and
 * because observer callbacks are microtasks it lands after the editor's
 * synchronous bind-and-place work rather than in the middle of it. Until the
 * svg for the CURRENT code exists, no rects are published: a chip floating
 * over yesterday's layout is worse than one that arrives a frame late.
 */
export function RecordChipOverlay({
  code,
  entries,
  schema,
}: {
  code: string;
  /**
   * The corpus a click target resolves against — the VAULT, not the tab's
   * filtered rows. A node keeps naming its record when a filter stops
   * matching it; a chip that vanished on a status change would be the canvas
   * lying about what is on it.
   */
  entries: Entry[];
  schema: Schema;
}) {
  // `in-place`, not `navigate`: this canvas IS the backdrop the user is
  // standing on, so the record opens over it (M9.3).
  const open = useOpenPath('in-place');
  const transformRef = useCanvasTransformRef();
  const rootRef = useRef<HTMLDivElement>(null);
  const [rects, setRects] = useState<ReadonlyMap<string, NodeRect>>(NO_RECTS);

  const bound = useMemo(() => recordBindings(code, entries), [code, entries]);

  const measure = useCallback(() => {
    const root = rootRef.current;
    const plane = root?.parentElement ?? null;
    const model = bound.size === 0 ? null : parseFlowchart(code);
    if (root === null || plane === null || model === null) {
      setRects((prev) => (prev.size === 0 ? prev : NO_RECTS));
      return;
    }
    const binding = bindFlowchartSvg(plane, model);
    const base = root.getBoundingClientRect();
    const scale = transformRef.current.scale;
    const next = new Map<string, NodeRect>();
    for (const [id, el] of binding.nodeEls) {
      if (!bound.has(id)) continue;
      const r = el.getBoundingClientRect();
      // A node the browser has not laid out yet measures 0×0, and every such
      // chip would stack on the plane's origin. Skipping is the same "arrive
      // late rather than land wrong" rule the missing-svg case follows.
      if (r.width === 0 && r.height === 0) continue;
      next.set(id, {
        x: (r.left - base.left) / scale,
        y: (r.top - base.top) / scale,
        w: r.width / scale,
        h: r.height / scale,
      });
    }
    // Compared, not replaced: this runs from a MutationObserver on the plane,
    // and the chips are IN the plane — publishing a fresh Map every pass would
    // re-render, mutate, and call the observer straight back.
    setRects((prev) => (sameRects(prev, next) ? prev : next));
  }, [code, bound, transformRef]);

  useEffect(() => {
    measure();
  }, [measure]);

  useEffect(() => {
    const plane = rootRef.current?.parentElement ?? null;
    if (plane === null) return;
    const observer = new MutationObserver(() => measure());
    observer.observe(plane, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [measure]);

  return (
    // pointer-events-none on the layer, auto on each chip: between chips this
    // must not eat the canvas's own pan and click surface.
    <div
      ref={rootRef}
      data-testid="whiteboard-chip-layer"
      className="pointer-events-none absolute inset-0"
    >
      {[...rects].map(([id, rect]) => {
        const binding = bound.get(id);
        if (binding === undefined) return null;
        const { entry, contested } = binding;
        const field = statusFieldName(schema, entry);
        const status = field === null ? null : schema.resolveField(entry, field);
        return (
          <button
            key={id}
            type="button"
            data-testid="whiteboard-record-chip"
            aria-label={`Open ${entry.title}`}
            // The same thing the link badge says about a shared slot, in the
            // one place a whiteboard user is actually looking (`nodeLinks`).
            title={
              contested
                ? `${entry.path} — another click line also links this node, so the canvas may open something else`
                : entry.path
            }
            onClick={(e) => {
              // The node underneath is the structural editor's selection
              // target; opening a record must not also select the node.
              e.stopPropagation();
              open(entry.path);
            }}
            onKeyDown={(e) => e.stopPropagation()}
            // Anchored to the node's lower edge, slightly overlapping it, so
            // the card reads as attached without covering the node's own
            // label — and clear of the link badge, which the shared editor
            // pins to the opposite (top-right) corner. Plane-local units; the
            // parent transform does the rest.
            style={{ left: rect.x + 4, top: rect.y + rect.h - 10, maxWidth: rect.w + 80 }}
            className="pointer-events-auto absolute flex items-center gap-1.5 rounded-md border border-n-200 bg-n-0 px-1.5 py-0.5 shadow-[var(--shadow-sm)] hover:border-cortex-500"
          >
            <span className="truncate text-xs font-medium text-n-800">{entry.title}</span>
            {/* Capability-gated: a record whose type declares no status field
                gets no badge, and `FieldChip` renders null for an empty
                display, so an unset status is silent rather than blank. */}
            {status !== null && <FieldChip resolved={status} />}
          </button>
        );
      })}
    </div>
  );
}
