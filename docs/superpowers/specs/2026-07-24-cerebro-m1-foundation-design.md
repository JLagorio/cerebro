# Cerebro M1 — Foundation Slice Design

**Date:** 2026-07-24
**Status:** Approved
**Scope:** Milestone 1 of the Cerebro app — app shell, vault + schema engine, spaces/projects, work items in List and Board views with grouping.

## Context

Cerebro is a work-management desktop app (spaces → projects → work items, plus docs and a strategy layer in later milestones) that replicates the *architecture* of [Tolaria](../../../tolaria-main/) — files-first markdown vault, advisory type system, saved views, collections layer — while using the Cerebro design language defined in [docs/Cerebro Design System/](../../Cerebro%20Design%20System/) and prototyped in [docs/cerebro-with-teams/CerebroApp.dc.html](../../cerebro-with-teams/CerebroApp.dc.html).

Decisions made during brainstorming:

1. **Foundation:** Greenfield Tauri desktop app, files-first (not a Tolaria fork, not a database-backed web app). Single-user in M1.
2. **First milestone:** Foundation slice — shell, engine, spaces/projects, work items with List + Board + grouping. Timeline/table/calendar, doc editor, and strategy layer are later milestones.
3. **Schema model:** "Typed lenses" — Tolaria's everything-is-a-markdown-note model, extended with typed field definitions on type notes and per-space status workflows. Schema informs the UI; it never rejects a file.

## Shape of the system

- **Stack:** Tauri v2, React 19, TypeScript, Vite, pnpm. Tailwind CSS v4 with Cerebro DS tokens bridged via `@theme`. Lucide icons (stroke 1.75). Light mode only.
- **Location:** app lives at the repo root (`src/`, `src-tauri/`, `package.json`); `docs/` remains design reference; `tolaria-main/` stays git-ignored as an architecture reference.
- **Data:** the app opens a **vault** — a folder of markdown files that is the entire database. Every entity (space, project, work item, person, type definition) is a `.md` file with YAML frontmatter, editable in any editor. No database, no cache in M1 (full rescan is acceptable).
- **State:** zustand stores — `vaultStore` (entries, scan status), `navStore` (typed selection + history stack), `uiStore` (panel widths, open panels). No router; navigation is a typed selection state, mirroring Tolaria's `SidebarSelection` and the prototype's `state.view`.
- **Deliberately excluded from M1:** git sync, AI subsystem, i18n, Sentry, caching, search backend, comments, presence, dark mode, multi-user.

## Vault layout

```
<vault>/
  type/          # type notes (work-item.md, space.md, project.md, person.md)
  spaces/        # space notes
  projects/      # project notes
  items/         # work item notes
  people/        # person notes
  views/         # saved views (*.yml)
  attachments/   # reserved for binaries (unused in M1)
```

Folders are **organizational only, never semantic** (Tolaria rule): an entity's type comes solely from its `type:` frontmatter, and hierarchy comes from relations. New notes are created in the conventional folder for their type, but a file moved elsewhere keeps working.

## Schema engine

### Entries

The Rust scanner produces an `Entry` per markdown file:

`path, filename, title, type, properties (scalars), relationships (wikilink-valued fields), outgoingLinks, snippet, createdAt, modifiedAt, parseError?`

- **Title:** first H1 in the body; fallback to humanized filename stem.
- **Relationships:** any frontmatter value containing `[[wikilink]]` syntax becomes `relationships[key] = [targets]` (Tolaria ADR-0010). Scalars and scalar arrays go to `properties`.
- **Wikilink resolution** (in TS, against the entry set): filename stem match, then exact title match, case-insensitive. Unresolved targets render as unresolved chips, never errors.
- **Parse failures:** a file with malformed YAML still yields an entry (`parseError` set, frontmatter empty). It renders as a warning row; the scan never fails.

### Type notes

Any note with `type: Type` defines an entity type. Recognized frontmatter, all optional:

```yaml
type: Type
icon: check-square        # Lucide name
color: '#3D8BE8'          # or DS swatch name
fields:
  status:   { kind: status }
  priority: { kind: select, options: [ {id: urgent, color: '#DE3B4E'}, {id: high, color: '#DE8F0A'}, {id: medium, color: '#3D8BE8'}, {id: low, color: '#A8AFC2'}, {id: none, color: '#7E8699'} ] }
  assignee: { kind: person }
  due:      { kind: date }
  estimate: { kind: select, options: [ {id: XS}, {id: S}, {id: M}, {id: L}, {id: XL} ] }
  project:  { kind: relation, target: Project }
```

**Field kinds (M1):** `text`, `number`, `checkbox`, `date` (ISO `YYYY-MM-DD`), `daterange` (`start`/`end` ISO dates), `select`, `multiselect`, `status`, `person` (relation restricted to Person entries), `relation` (with `target:` type name). Select options carry `id`, optional `label` (defaults to humanized id), optional `color` (hex or DS swatch name), and take their display order from list order.

**Advisory semantics:** fields not declared on the type are still shown (as untyped text) in the detail panel; declared-but-missing fields render as gray placeholders; a select value not in the options list is kept and rendered as a ghost option. Editing through the UI always writes valid values; hand-edited files are never rejected.

### Space status workflows

Space notes (`type: Space`) declare the status set used by items in that space:

```yaml
type: Space
color: '#3D8BE8'          # tile swatch (same key as on type notes)
statuses:
  - { id: backlog,     group: active, color: '#A8AFC2' }
  - { id: todo,        group: active, color: '#3D8BE8' }
  - { id: in-progress, group: active, color: '#EFB428' }
  - { id: done,        group: done,   color: '#34B764' }
  - { id: cancelled,   group: closed, color: '#A8AFC2', hollow: true }
```

Groups are `active | done | closed` (prototype's model). A field of kind `status` on an item resolves against the status set of the space the item belongs to (via its project). Items with no resolvable space fall back to a built-in default status set (the prototype's "simple" template). Space creation seeds `statuses:` from one of the prototype's status templates (`cerebro`, `marketing`, `simple`).

### Hierarchy and item keys

- Work item → `project: [[project-slug]]`; project → `space: [[space-slug]]`; assignee → `[[person-slug]]`.
- Project notes carry `key: FLD` (uppercase prefix). Item creation assigns `key: FLD-<n>` where `<n>` = max existing number for that prefix + 1, computed from the loaded entry set at creation time. The key is stored in the item's frontmatter and displayed in mono.

### SchemaRegistry

A TS module deriving reactively from `vaultStore`: map of type name → parsed type definition; map of space → resolved status set; field resolver `(entry, fieldName) → {definition, value, displayValue, color}`. All view rendering and all field editors go through it. Pure functions, unit-tested.

## Collections and views

- **Selection** (navStore): `{kind: 'space', id}` · `{kind: 'project', id}` · `{kind: 'view', id}` · `{kind: 'home'}` · `{kind: 'settings'}`.
- A selection resolves to a **Collection**: `{entries, presentation}`. Presentation: `{type: 'list' | 'board', groupBy?: fieldName, orderBy: {field, dir}, visibleFields: fieldName[]}`. Defaults: project → list grouped by `status`, ordered by modified desc, showing `key, status, priority, assignee, due, estimate`.
- **Grouping engine** (shared by List and Board): partitions entries by a field's resolved value; group order and color come from the SchemaRegistry (status sets / select options); ungrouped entries go to a trailing "No <field>" group. Group-by is switchable in the toolbar: `status`, `priority`, `assignee`, `estimate`.
- **List view:** grouped sections with 40px rows and 36px group headers, field chips per `visibleFields`, inline quick-add row per group (creates an item with that group's field value pre-set), click opens the detail panel.
- **Board view:** one 280px column per group, KanbanCard-style cards (title, key, assignee avatar, priority flag, colored left edge), dnd-kit drag between columns — dropping writes the new field value to the item's frontmatter on disk.
- **Saved views:** YAML files in `views/`, extending Tolaria's `ViewDefinition`: `{name, icon, color, order, filters, presentation}`. `filters` is Tolaria's recursive `{all|any}` group tree with ops `equals, not_equals, contains, any_of, none_of, is_empty, is_not_empty, before, after`. M1 ships the **evaluator** (unit-tested, applied when a saved view is selected) but not the filter-builder UI (M2). Saving the current presentation as a view is in scope (Save view button writes the YAML).

## Vault engine (Rust)

Tauri commands: `pick_vault` (dialog + persist last vault path in app config), `scan_vault → Entry[]`, `read_note(path) → body`, `save_note(path, content)`, `update_frontmatter(path, patch)` (preserves body and unknown keys, canonical YAML output), `create_note(folder, slug, frontmatter, body)`, `list_views → ViewFile[]`, `save_view(name, yaml)`. Watcher: `notify`-based, 350ms debounce, 4s own-write suppression (Tolaria's tuning), emits `vault-changed` → frontend rescans. All writes are disk-first; the store updates optimistically and reconciles on the next scan.

## App shell and UI

Prototype chrome, DS tokens exactly:

- **Icon rail** (56px): Home active; Docs, Agent, Library rendered but disabled with "coming soon" tooltips; Settings at bottom.
- **Sidebar** (264px, `--surface-sunken`): Spaces section (collapsible tree: space → projects), Views section (saved views), per-space "+ New project".
- **Topbar** (64px): wordmark "cerebro." with Synapse-violet period, centered quick-open input (⌘K: fuzzy match over entry titles + keys, opens item/project/space), "+ New" menu (item / project / space), avatar placeholder.
- **Canvas:** Home (spaces grid with letter swatches + active projects grid, per prototype) · Space page (header, description, projects) · Project page (toolbar: view switcher list/board, group-by select, order select, Save view; then the view) · Settings (vault picker, vault path display).
- **Detail panel** (420px right aside, translateX+fade in): title (inline rename edits the first H1 — the display title; filenames/slugs are stable in M1, so wikilinks never break; filename rename with vault-wide rewrite is M2), schema-driven field editors as anchored popovers (status, priority, select, person, date, estimate, relation), description as plain markdown textarea saved to the note body, created/modified in mono.
- **DS integration:** port the 26 primitives from `docs/Cerebro Design System/components/` (`.jsx` sources) to TSX in `src/components/ui/` — M1 needs approximately: Button, IconButton, Icon, Input, Select, Avatar, Badge, Tag, FilterChip, SegmentedControl, Dialog, Tooltip, Toast, EmptyState, KanbanCard, StatusFlag, ProgressBar. Tokens from `docs/Cerebro Design System/tokens/*.css` copied into `src/styles/` and bridged in Tailwind `@theme`. Fonts (Instrument Sans, IBM Plex Mono) bundled from DS assets.

## Demo vault

A build script (`scripts/build-demo-vault.ts`) converts the prototype seed (`docs/cerebro-with-teams/cerebro-work-data.js` SPACES/PROJECTS/WORK_ITEMS + USERS from `cerebro-data.js`) into `demo-vault/` (committed): type notes, space notes with status sets, project notes with keys, ~40 work items, person notes. Seed items attached to work lists (`listId`) are skipped — work lists are not an M1 concept. First app launch with no configured vault offers "Open demo vault".

## Error handling

| Failure | Behavior |
|---|---|
| Malformed YAML | Entry with `parseError`, warning row in lists, excluded from boards, never crashes scan |
| Unknown status value | Ghost column (board) / ghost group (list), rendered with muted color |
| Unresolved wikilink | Muted "unresolved" chip; clicking offers to create the target note |
| Concurrent external edit | Watcher rescan wins (last-write-wins); toast "Vault refreshed" on external change |
| Write failure (IO) | Toast with error, store reverts optimistic update on next scan |

## Testing

- **Vitest:** frontmatter normalization, SchemaRegistry (type parsing, status resolution, field resolver), grouping engine, view-filter evaluator, item-key assignment, wikilink resolution. These are the logic core and get thorough coverage.
- **Rust `#[cfg(test)]`:** frontmatter parse/serialize round-trip (unknown keys preserved), scanner on a fixture vault, `update_frontmatter` patch semantics.
- **Playwright:** one smoke test — boot against demo vault, sidebar shows spaces, open a project, switch list↔board, drag a card, verify frontmatter changed on disk.

## Milestones after M1

- **M2:** timeline, table, calendar views; filter-builder UI; transactional rename with vault-wide wikilink rewrite; scan cache.
- **M3:** doc editor (BlockNote, block schema ported selectively from Tolaria), doc folders, templates, Docs rail.
- **M4:** cycles, workstreams, My Work, strategy layer (OKRs, roadmap, delivery board).
- **M5:** AI surfaces (Synapse), collaboration/sync exploration.
