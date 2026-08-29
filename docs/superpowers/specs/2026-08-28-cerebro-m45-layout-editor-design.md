# M45 — Customize layout: the Notion-style layout editor

Status: approved-in-intent 2026-08-28 — the user directed Notion parity for
these screens ("I want what I want"); screens specified from the user's four
Notion screenshots; mechanics grounded in three code recons of 2026-08-28.

## 1. What this is, and why now

Notion's **Customize layout** screen: a full-screen takeover that previews a
real record of a database, lets you arrange the page (heading strip, property
groups, content, tabs), toggle per-property visibility with eye icons, switch
the page between **Simple** and **Tabbed** structure, add view-backed tabs —
and commits nothing until **Apply to all pages**.

This was asked for in M16 and deliberately parked:
`docs/superpowers/plans/2026-08-02-cerebro-m16-notion-parity.md` scoped
"Customize layout (M16.11)" as *milestone-sized on its own*, and
`src/detail/PropertyMenu.tsx:28-31` still carries the flag
("Customize layout is M16.11's stretch"). M44 built the menu-driven half
(`display:`, `tabs:`, per-field `visibility`). M45 builds the screens.

**The user's directive is Notion parity for these four screenshots.** Where
Cerebro's model has no equivalent (comments), we omit honestly rather than
fake; everything else mirrors.

## 2. What exists that M45 stands on (recon, 2026-08-28)

- Per-field `visibility: show | hide_when_empty | hide` on Type docs, changed
  via `setFieldConfig` (typeActions.ts:467) — exactly Notion's three eye
  states, already persisted.
- `display:` (M44.1: showEmpty/showFile/showBody, deviations-only serializer)
  and `tabs:` (M44.5: TabDef list, two-pass id minting) on Type docs.
- The add-property catalog: `AddPropertyPanel` (existing-vs-create, kind
  tiles, relation config) — the screenshot's "Add to page" picker is this.
- `Dialog fullscreen` (Dialog.tsx:50-58, M29.27): full-viewport card that
  keeps layers/Escape/focus-trap semantics. Precedent host:
  FullScreenDiagramEditor.
- Staging idioms: ViewSettingsDialog's draft-state + "closes only on
  successful save" (M14.8); deviations-only patches; DashboardView's pure-edit
  + identity-guard commit door.
- dnd-kit core (the only drag lib) with droppable-slot idiom
  (DashboardView) for cross-container drags; `useSortableList` for
  single-axis reorders.
- Record enumeration for the preview picker:
  `entries.filter(e => e.type === name && !isTemplate(e))` (surface.ts:204).

## 3. The five screens → Cerebro surfaces

### 3.1 Entry points
- Record ⋯ menu (`DetailHeaderActions`) and the DocPage "Page options" menu
  gain **Customize layout** (icon `layout`, gated on `entry.type !== null`,
  sits where "Customize display" sits today — Customize display's three
  switches MOVE into the editor's Page settings rail and the drill-in
  retires; one door, not two).
- `PropertyMenu` gains the verbatim-order last item **Customize layout**
  (closing the M16.7 comment's open loop).

### 3.2 The editor screen (screenshot 2)
`Dialog fullscreen` hosting `LayoutEditor`, laid out as Notion does:
- **Header**: type icon + type name; `Preview: <record title>` dropdown
  (roster = the type's records, first record default; empty type previews a
  synthetic blank record); right side **Cancel** and **Apply to all pages**
  (primary).
- **Canvas** (center): a non-interactive PREVIEW of the record page rendered
  from the DRAFT — heading block, property strip, property-group panels,
  content block, tab strip when Tabbed. Blocks carry Notion's blue hover
  chrome (block name label + drag grip).
- **Page settings rail** (right): **Structure**: `Simple | Tabbed` tiles;
  **Options**: the M44.1 switches (Show empty properties / Show file path /
  Show body) — same storage, new home.
- **Staged draft**: `LayoutDraft = { display, layout, tabs, fields }` in
  component state, seeded from the TypeDef; every control edits the draft;
  the preview renders from the draft. **Cancel/Escape discards** (confirm
  dialog only when dirty). **Apply** calls ONE new atomic door
  `applyTypeLayout(listing, draft): Promise<boolean>` in typeActions —
  one `patchFrontmatter` carrying `fields`, `display`, `layout`, `tabs`
  (deviations-only; `null` deletes keys at defaults). Dialog closes only on
  `true` (M14.8 idiom).

### 3.3 The property-group editor (screenshot 5)
Clicking a property-group block opens its popover editor:
- Search box; one row per field: kind icon + name + **eye toggle** cycling
  visibility (eye = show, eye-off = hide_when_empty offered via the row's
  submenu as today's three-state vocabulary — the eye click toggles
  show ↔ hide; the row menu still offers all three).
- **Add a property** → `AddPropertyPanel` (existing property = un-hide /
  pull into this group; create new = the kind catalog).
- **+ Add section** → a named group. Groups are the new `layout.groups`
  vocabulary (§4). Rows drag between groups and into the heading strip
  (dnd-kit droppables per group).
- "Move to page" (screenshot 5) maps to moving a field between the heading
  strip and a group.

### 3.4 The heading block (screenshots 2, M16.11 wording)
`layout.heading` — an ordered list of field names rendered as the **key
property strip** under the title (Status/Assignee/Priority/End date in the
screenshot), with a **View details / Hide details** expander revealing the
full property stack. This renders on the REAL record surfaces (DocPage and
DetailPanel), not just the preview — the editor is only the way to arrange
it.

### 3.5 Tabbed structure + view tabs (screenshots 3–4)
- **Structure: Tabbed** shows the M44.5 tab strip in the preview. (AMENDED
  2026-08-28, M45.4 plan ruling: tabs are NOT edited inside the editor — the
  real record page's strip stays the ONE tab-editing surface; the editor's
  canvas renders the strip inert with a first-tab placeholder, and the
  Structure tiles keep their M45.2 seeding role. The original "editable
  against the draft" wording was reversed to avoid a second editing surface.)
  (RE-AMENDED 2026-08-29: user directive — the editor's strip is LIVE against
  the draft: add, rename, remove, reorder, and source changes all stage into
  `draft.tabs`. The record page's strip remains the vault's editing surface;
  the "one tab-editing surface" ruling is reversed by the product owner, and
  the placeholder follows the ACTIVE tab, not the first.)
- **Simple** collapses to one scroll (draft `tabs: []` → the synthesized
  Overview; the strip hides when only Overview exists).
- **View tabs**: "+" offers "Link existing data source" → name input +
  "View of: <database>" picker (roster = `listTypes` + collection lists) +
  **Add view**. Extends `TAB_CONTENTS` with `'view'` and `TabDef` with a
  source pointer; the record page renders the referenced view scoped by the
  tab's source, reusing the dashboard view-embed rendering path.
  (§7 pins the exact pointer shape after engine recon.)

### 3.6 Honest omissions
- **Page discussions / Comments block**: no comments system exists; the
  block is omitted (absent is never faked). Its own milestone if wanted.
- **AI Autofill, Suggest edits, Translate** etc. from Notion's ⋯: out of
  scope — this milestone is the layout screens.

## 4. New vocabulary: `layout:` on Type docs

```yaml
layout:
  heading: [status, assignee, priority, due]   # the key-property strip
  groups:
    - { id: group-1, name: Property group, fields: [start, progress, team] }
    - { id: group-2, name: Budget, fields: [budget, attach_file], tab: spec }
```

- New reserved key on Type docs (`RESERVED` grows; parse tolerant by value,
  serializer deviations-only, absent = today's flat rendering — zero
  migration).
- `tab:` on a group (added M45.6) names which of the type's `tabs:` the
  section belongs to; absent = the DEFAULT tab (the first property-bearing
  one), which is what every group written before M45.6 has, so no vault
  migrates. A `tab:` naming a tab the type no longer declares renders the
  section on the default tab, visible — the opposite of a dead FIELD
  pointer, because the section still holds real properties.
- Fields in no group and not in `heading` render in the DEFAULT group
  (declaration order), so a hand-edited vault never loses a property.
- A field named in `layout` that no longer exists is skipped on render and
  pruned on the next Apply (pointer hygiene, same as favorites).
- `visibility` stays per-field in `fields:` — `layout` places, `visibility`
  shows/hides; the eye toggles write visibility, drag writes layout.
- Structure (Simple/Tabbed) is NOT stored — it is derived from `tabs:`
  (empty/absent = Simple). One source of truth.

## 5. Slices

- **M45.1 — engine + door**: `LayoutConfig` parse/serialize (+ tests over
  garbage/partial/roundtrip, schema.ts pattern), `RESERVED` + lockedFields,
  `applyTypeLayout` atomic door (boolean, toast-not-throw), record-surface
  rendering of `layout` (heading strip + View details expander + grouped
  properties in DocPage/DetailPanel/RecordProperties — real pages first, so
  the editor previews something true).
- **M45.2 — the editor shell**: menu entries (⋯ ×2 + PropertyMenu),
  fullscreen Dialog + LayoutEditor scaffold, preview-record picker, draft
  state, Page settings rail (Structure tiles + Options switches),
  Cancel/dirty-confirm/Apply wiring, Customize-display drill-in retired
  (comment killed with it).
- **M45.3 — the canvas**: block chrome (hover label + grip), property-group
  popover editor (search, eye toggles, three-state row menu, Add a property
  via AddPropertyPanel, Add section, rename/delete group), drag fields
  between heading/groups (dnd-kit droppables), drag group blocks to reorder.
- **M45.4 — view tabs**: `TAB_CONTENTS + 'view'`, TabDef source pointer,
  add-view flow ("View of" picker), record-page rendering of a view tab,
  tab editing inside the editor's Tabbed preview.

## 6. Decisions (M45 gating calls, decided 2026-08-28)

- **Shell**: `Dialog fullscreen`, not a selection kind — an editing session
  is not a place the back button returns to; Escape/layer semantics come
  free. (Reversal path exists if it ever needs a URL.)
- **Apply is atomic**: one `patchFrontmatter` via `applyTypeLayout`; partial
  application of a layout is worse than none.
- **Customize display merges into the editor** — two doors to the same
  `display:` keys would drift.
- **Simple/Tabbed derived from `tabs:`** — no second structure flag.
- **Groups live in `layout:`, visibility stays in `fields:`** — placement
  vs. disclosure are different facts with different owners.

## 7. View-tab mechanics (pinned from engine recon, 2026-08-28)

**Pointer shape.** `TAB_CONTENTS` gains `'view'`; a view tab carries a
source pointer, mirroring the dashboard widget's reference-never-copy
doctrine (types.ts:542-547):

```yaml
tabs:
  - id: tasks
    name: Tasks
    icon: null
    content: view
    source: { type: Task }                      # a type IS a database (M39)
    # or: source: { list: tasks-tracker, collection: delivery }
    view: board          # optional view id; absent = the source's first view
    scope: related       # optional; absent = all
```

- **Rosters for "View of"**: `listTypes(entries, schema)` (the sidebar's
  Databases section) plus `useVaultStore(s => s.views)` (`ListFile[]`) —
  the exact pair the dashboard's "Saved view…" submenu and
  ViewSettingsDialog's source picker already enumerate. List ids are unique
  per FOLDER, so `collection` rides along (surface.ts:158-165 doctrine).
- **Resolution** reuses the dashboard ViewBlock path: list source →
  `resolveSurface({kind:'list', id, collection, view}, …)`; type source →
  `resolveSurface({kind:'type', name, view}, …)` (`typeViews` synthesizes a
  default). `hasBlocks` guard carries over — a record tab cannot show a
  dashboard.
- **`scope: related`** — the reason record-page views are worth having:
  when the source type declares a relation field targeting the host
  record's type (capability-gated — field existence, never type-name
  routing), the tab can scope rows to those related to THIS record via an
  injected `any_of` filter (the M44.3 drilldown filter family). The
  add-view form offers the toggle only when such a field exists, and
  defaults it ON then (Notion's project→tasks case); `scope` absent = all
  rows.
- **Tolerance**: parse keeps a `view` tab whose source no longer resolves
  (the tab id may be load-bearing); the RENDERER shows the honest broken
  state (dashboard's BrokenBlock copy: "points at a … no longer in the
  vault") — unavailable is never empty. Unrecognised `content` still falls
  back to `'sections'`.
- **DocPage** grows a fourth swap arm: `content === 'view'` renders the
  embedded `ViewCanvas` (shared extraction from DashboardView's ViewBlock);
  `showsEditor` stays false, so the M44.5 editor-reset key is untouched.
- **RecordTabs** `TAB_KINDS` gains the `view` tile; NewTabForm drills into
  the "View of" picker + scope toggle before Create.
