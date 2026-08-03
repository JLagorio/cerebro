import {
  dateKindOf,
  rescheduleValue,
  resizeSpan,
  shiftSpan,
  spanOf,
  PX_PER_DAY,
  type Span,
  type Zoom,
} from '@/engine/schedule';
import type { RenderRow } from '@/engine/rows';
import type { Schema } from '@/engine/types';
import { useTimeDrag, type TimeDrag } from '@/views/useTimeDrag';

/**
 * Moving and resizing a bar on a horizontal axis (M16.24) — the half Timeline
 * and Gantt share, on top of the generic `useTimeDrag` gesture.
 *
 * Keyed on the ROW key, not the record path: the same record can appear under
 * two parents in a nested breakdown, and a drag belongs to the bar that was
 * grabbed rather than to every copy of the record.
 */
export interface ScheduleDrag {
  handle: TimeDrag;
  /**
   * The span to DRAW for a row: the stored one, or the gesture in flight.
   *
   * Previewing is what makes the gesture legible. Without it a drag is a blind
   * commit — you release and find out afterwards what you moved it to.
   */
  preview: (key: string, span: Span) => Span;
}

export function useScheduleDrag({
  rows,
  dateField,
  schema,
  zoom,
  patchFrontmatter,
}: {
  rows: RenderRow[];
  dateField: string | null;
  schema: Schema;
  zoom: Zoom;
  /** The store action. It never throws — it toasts and returns (M15 invariant). */
  patchFrontmatter: (path: string, patch: Record<string, unknown>) => Promise<void>;
}): ScheduleDrag {
  const handle = useTimeDrag({
    pxPerDay: PX_PER_DAY[zoom],
    disabled: dateField === null,
    onCommit: (key, edge, days) => {
      if (dateField === null) return;
      const row = rows.find((r) => r.kind === 'row' && r.key === key);
      if (row === undefined || row.kind !== 'row') return;
      const current = spanOf(row.entry, dateField);
      if (current === null) return;
      const kind = dateKindOf(row.entry, dateField, schema);
      // A `date` field holds one date, so there is no end to drag. Quietly
      // moving the whole record instead would be a resize that lies.
      if (edge !== 'move' && kind !== 'daterange') return;
      const next = edge === 'move' ? shiftSpan(current, days) : resizeSpan(current, edge, days);
      void patchFrontmatter(row.entry.path, {
        [dateField]: rescheduleValue(row.entry.properties[dateField], kind, next),
      });
    },
  });

  return {
    handle,
    preview: (key, span) => {
      const active = handle.drag;
      if (active === null || active.id !== key) return span;
      return active.edge === 'move'
        ? shiftSpan(span, active.days)
        : resizeSpan(span, active.edge, active.days);
    },
  };
}
