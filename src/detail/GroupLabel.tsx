/**
 * The quiet caps header over a property group — ONE anatomy for
 * RecordProperties, DocProperties, and the layout editor's canvas (M45.3).
 * Extracted because the className string had three character-identical
 * copies that could only drift apart.
 */
export function GroupLabel({ name }: { name: string }) {
  return (
    <div className="px-1 pt-1.5 text-2xs font-semibold uppercase tracking-[0.06em] text-n-500">
      {name}
    </div>
  );
}
