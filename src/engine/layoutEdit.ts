import type { LayoutConfig } from './types';

/**
 * Pure structural editors over `LayoutConfig` (M45.3) — dashboard.ts's
 * pure-editor discipline, so the layout editor's drag and menu handlers stay
 * thin routers. Every edit rebuilds only the containers it touched (every
 * other group keeps its identity), and every no-op returns the SAME
 * reference, so a caller can `!==`-gate a draft commit.
 *
 * The editors are roster-blind — a field name is just a string. `rest` is
 * DERIVED — the names no container claims (layout.ts computes it against the
 * live roster) — so moving a name to `rest` means deleting it from every
 * container, and a name nobody placed is already there. Dead pointers are
 * not this module's concern: a dead FIELD pointer renders as nothing and
 * prunes on the editor's Apply (spec §4), the same contract favorites keep.
 */

/** Where a field can be addressed: the heading strip, the derived rest
 * stack, or a group by id. (The literals are documentation — the type is
 * `string` — because a group id is an open vocabulary.) parseLayoutConfig
 * guarantees the sentinels never name a group: a declared `id: heading` or
 * `id: rest` re-mints at the parse door, exactly like a duplicate. */
export type LayoutContainer = 'heading' | 'rest' | string;

/**
 * The next free `group-${n}` id, walking n upward past every taken id —
 * `['group-1', 'group-3']` mints `group-2`, the hole-filling walk schema.ts's
 * parse-time mint established (that one stays module-private by design: it
 * repairs `layout:` YAML on the way in; this one serves DRAFT edits and is
 * the ONE exported mint). `taken` must hold every id any draft group
 * declares, so a fresh id can never steal a declared one.
 */
export function mintGroupId(taken: string[]): string {
  const set = new Set(taken);
  let n = 1;
  while (set.has(`group-${n}`)) n += 1;
  return `group-${n}`;
}

/**
 * Removes `name` from wherever it lives and inserts it at `to.index`
 * (clamped) in the target container — remove-then-insert, so a
 * within-container slot is counted with the moving name already out
 * (dashboard.ts's moveWidget shape). Targeting `rest` is deletion alone; its
 * index is ignored because rest orders by roster declaration, not by the
 * config. A group id that names nothing, a name already at the landing
 * position, and a to-rest move of an unplaced name are all no-ops. `to.index`
 * counts CONFIG slots — a drag caller translating a visual drop slot owns the
 * decrement, DashboardView's moveToSlot precedent (M44.4).
 */
export function moveField(
  layout: LayoutConfig,
  name: string,
  to: { container: LayoutContainer; index: number },
): LayoutConfig {
  const inHeading = layout.heading.includes(name);
  const sourceIdx = layout.groups.findIndex((g) => g.fields.includes(name));

  if (to.container === 'rest') {
    if (!inHeading && sourceIdx === -1) return layout;
    return {
      heading: inHeading ? layout.heading.filter((n) => n !== name) : layout.heading,
      groups:
        sourceIdx === -1
          ? layout.groups
          : layout.groups.map((g, i) =>
              i === sourceIdx ? { ...g, fields: g.fields.filter((n) => n !== name) } : g,
            ),
    };
  }

  const targetIdx =
    to.container === 'heading' ? -1 : layout.groups.findIndex((g) => g.id === to.container);
  if (to.container !== 'heading' && targetIdx === -1) return layout;

  const targetFields =
    to.container === 'heading' ? layout.heading : layout.groups[targetIdx].fields;
  const current = targetFields.indexOf(name);
  const without = current === -1 ? targetFields : targetFields.filter((n) => n !== name);
  const at = Math.max(0, Math.min(to.index, without.length));
  if (current !== -1 && at === current) return layout;
  const inserted = [...without.slice(0, at), name, ...without.slice(at)];

  const heading =
    to.container === 'heading'
      ? inserted
      : inHeading
        ? layout.heading.filter((n) => n !== name)
        : layout.heading;
  const groups =
    targetIdx === -1 && sourceIdx === -1
      ? layout.groups
      : layout.groups.map((g, i) => {
          if (i === targetIdx) return { ...g, fields: inserted };
          if (i === sourceIdx) return { ...g, fields: g.fields.filter((n) => n !== name) };
          return g;
        });
  return { heading, groups };
}

/** Appends an empty group named "New group" under a freshly minted id and
 * reports that id, so the caller can open its editor on the new section.
 * `taken` must carry ALL draft group ids (mintGroupId's contract). A section
 * has no home to choose (M46.1): it renders above the tab strip, on every
 * tab, so there is nothing for the caller to say about where it lands. */
export function addGroup(
  layout: LayoutConfig,
  taken: string[],
): { layout: LayoutConfig; id: string } {
  const id = mintGroupId(taken);
  return {
    layout: {
      heading: layout.heading,
      groups: [...layout.groups, { id, name: 'New group', fields: [] }],
    },
    id,
  };
}

/** Renames a group with the trimmed name. An empty trim, an unchanged name,
 * and an unknown id are all no-ops — blur-commit fires on every blur, so the
 * common nothing-changed blur must not dirty the draft. */
export function renameGroup(layout: LayoutConfig, id: string, name: string): LayoutConfig {
  const trimmed = name.trim();
  const idx = layout.groups.findIndex((g) => g.id === id);
  if (idx === -1 || trimmed === '' || trimmed === layout.groups[idx].name) return layout;
  return {
    heading: layout.heading,
    groups: layout.groups.map((g, i) => (i === idx ? { ...g, name: trimmed } : g)),
  };
}

/** Deletes the group. Its fields are re-homed NOWHERE — rest is derived, so
 * falling out of every container IS landing in rest. Unknown id → no-op. */
export function removeGroup(layout: LayoutConfig, id: string): LayoutConfig {
  if (!layout.groups.some((g) => g.id === id)) return layout;
  return { heading: layout.heading, groups: layout.groups.filter((g) => g.id !== id) };
}

/** Reorders one group to `toIndex` — a clamped splice against the list's own
 * ends (moveWithinRow's clamp idiom). Landing where it already sits, clamped
 * or not, and an unknown id are no-ops. */
export function moveGroup(layout: LayoutConfig, id: string, toIndex: number): LayoutConfig {
  const from = layout.groups.findIndex((g) => g.id === id);
  if (from === -1) return layout;
  const to = Math.max(0, Math.min(toIndex, layout.groups.length - 1));
  if (to === from) return layout;
  const groups = [...layout.groups];
  const [moved] = groups.splice(from, 1);
  groups.splice(to, 0, moved);
  return { heading: layout.heading, groups };
}
