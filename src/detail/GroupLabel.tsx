/**
 * The quiet caps header over a property group in RecordProperties (M45.3).
 * The page inspector's DocProperties labels its groups with the inspector's
 * own `InspectorSubhead` (2026-10-18), and the layout editor's canvas has no
 * inner label at all (M45.5).
 */
export function GroupLabel({ name }: { name: string }) {
  return (
    <div className="px-1 pt-1.5 text-2xs font-semibold uppercase tracking-[0.06em] text-n-500">
      {name}
    </div>
  );
}
