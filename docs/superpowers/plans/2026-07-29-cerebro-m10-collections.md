# M10 — Collections

One container concept, one row model, six views. Replaces the "Views" sidebar
section and retires the Hierarchy view type.

## Why

M9 shipped a unified grouping chain — a level bands by a property or descends a
relation ([`GroupSpec`](../../../src/engine/types.ts)) — but only `TreeView`
rendered the descents. That left a `tree` layout in the union whose entire job
was "the view that can nest", which is backwards: **nesting is a property of the
grouping chain, not a kind of view.** A Table with `group: [status, ↳ key_results]`
is the hierarchy; there is nothing left for a Hierarchy view to be.

Separately, `views/*.yml` were both the container and the query. The model we
want is Notion's databases inside ClickUp's containers:

> Collections contain things defined by their types, and then you apply views,
> filters, sorts, and hierarchies.

## Concepts

| Concept | On disk | What it is |
|---|---|---|
| **Type** | `types/<name>.md` | The schema — what an item *is* (Work item, Risk, Meeting, Objective). Unchanged by M10. |
| **Collection** | a folder holding `collection.yml` | A container. Holds Lists, Folders, and Docs. Has no query of its own. |
| **Folder** | a plain subdirectory | Organization inside a Collection. |
| **List** | `<name>.list.yml` | A database: a source type + filters + one active view. This is what `views/*.yml` was. |
| **Doc** | `*.md` | A page. |

A Collection is a folder for the same reason a project is: this is a markdown
app, and containers on screen should be containers on disk.

### Views

Six, mutually exclusive, one selected at a time:

```ts
type ViewType = 'table' | 'list' | 'board' | 'calendar' | 'gantt' | 'timeline';
```

- `tree` is **removed**. Saved files migrate to `table`, keeping their grouping
  chain — which is where the nesting already lived.
- `split` is **removed**. M9.3's open-in-place detail panel made a dedicated
  master-detail layout redundant. Saved files migrate to `table`.
- `gantt` and `timeline` are distinct: Timeline places records on a date axis;
  Gantt is scheduling — nested WBS rows, dependency arrows, a today line.

### Nesting belongs to grouping

`engine/rows.ts` becomes the single row model every record view consumes:

```ts
type RenderRow =
  | { kind: 'band'; node: GroupNode }
  | { kind: 'row'; entry: Entry; depth: number; childCount: number; key: string };
```

Bands come from `groupTree` (property levels); nested rows come from walking
`childrenAt` over the relation levels *inside* each band leaf. Table, List, and
Gantt all render from this one list, so "group by status, then nest under the
objective" means the same thing in all three.

## Migration

Read-tolerant, write-forward — the rule `parseViewYaml` already follows:

- `presentation.type: tree | split` → `table` on read; the next write persists
  `table`.
- Legacy `views/*.yml` and `<project>/views/*.yml` keep loading, surfacing as
  Lists with `collection: null` (top-level, like Notion's Private section).
  Nothing on disk has to move.
- New Lists are written as `<collection>/<name>.list.yml`.

## Scope note

Projects (`project.md` + folder) are **unchanged** this milestone. A Project and
a Collection are now two container concepts, which is a real duplication — but
folding Projects into Collections is a separate migration with its own data
risk, and the ask here was to rename Views, not to retire Projects.

## Commits

1. **M10.1** — one view union; `engine/rows.ts`; Table and List nest; delete
   `TreeView`/`SplitView`; toolbar segments.
2. **M10.2** — Collections disk format; Rust `list_collections`/`list_lists`;
   store, sidebar tree, create/rename/delete; legacy compat.
3. **M10.3** — `engine/schedule.ts` (date spans) + `CalendarView`.
4. **M10.4** — shared date axis + `TimelineView` + `GanttView` (dependencies).
5. **M10.5** — dedupe the `CollectionPage`/`ProjectPage` canvas into one
   component; e2e; docs.
