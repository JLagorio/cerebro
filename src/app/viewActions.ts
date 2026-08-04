import { newView } from '@/engine/views';
import { carryOver } from '@/views/viewKinds';
import type { FilterGroup, Presentation, ViewDefinition, ViewType } from '@/engine/types';

/**
 * "Add a view" — one seeding rule for every surface that offers it (M16.29).
 *
 * A List and a Type each grew their own `createView`, and both called
 * `newView(name, type, taken, presentation)` — which copied the presentation
 * whole and swapped only `type`. So a Table created while standing on the
 * Gallery inherited `colorColumns`, and one created off the Gantt inherited
 * `dateField`, `zoom` and `dependencyField`: keys the new layout never reads,
 * that no control in it can clear, written to the user's YAML on first save.
 *
 * Seeding from the open tab is still right — "the same columns, drawn as a
 * board" is what people mean by adding a view, and a blank slate would throw
 * away the configuration they just did. What travels is now decided by
 * `carryOver`, which asks the target kind what it can read.
 *
 * The FILTERS travel too, and unlike the presentation they travel whole
 * (M16.34). `newView` hardcodes `filters: null`, and nothing overrode it, so
 * adding a Board to a List called "At risk" produced a board of all 45 work
 * items with a header confidently reading 45 — the list's entire meaning
 * discarded, with no error and no hint. A filter is a statement about WHICH
 * RECORDS the list is, not about how one layout draws them, so no layout can
 * fail to read it and there is nothing for `carryOver` to gate.
 *
 * Deep-cloned: a `FilterGroup` is a nested tree, and two tabs sharing one
 * object means editing either rewrites both.
 *
 * This lives in `app/` because it is where the two halves legitimately meet:
 * `newView` is engine, the capability catalog is the view layer, and the
 * engine does not import the view layer.
 */
export function seedView(
  name: string,
  type: ViewType,
  taken: Iterable<string>,
  base: Presentation,
  filters: FilterGroup | null = null,
): ViewDefinition {
  const seeded = newView(name, type, taken, carryOver(base, type));
  return filters === null
    ? seeded
    : { ...seeded, filters: JSON.parse(JSON.stringify(filters)) as FilterGroup };
}
