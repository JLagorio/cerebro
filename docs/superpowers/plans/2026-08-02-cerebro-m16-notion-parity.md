# M16 — Notion-level parity and polish

**Branch:** `m16-notion-parity` (worktree `.claude/worktrees/m16-notion-parity`)
**Base:** `main` @ `8d4be33` (PR #7 / M15 merged). Line citations were taken at
`afbcc47` and re-checked against `8d4be33`; the only drift is in
`Dialog.tsx`/`AiPanel.tsx`, corrected in place below.
**Date:** 2026-08-02

M15 fixed defects. M16 closes the **capability** gap with Notion, and adds the
two layouts we don't have at all.

Two research passes back this plan:

1. A live walkthrough of Notion (logged-in Chrome, the `Product Roadmap` and
   `Meetings` databases) capturing every menu, popover and settings panel
   verbatim.
2. A seven-area audit of our own source, cited to `file:line`, merged and
   re-verified.

Everything below states **what Notion does** and **what we do**, so a phase can
be picked up without re-deriving either.

---

## The headline numbers

| | Notion | Cerebro |
|---|---|---|
| View layouts | **10** — Table, Board, Timeline, Calendar, List, Gallery, Chart, Feed, Map, Dashboard | **6** — table, list, board, calendar, gantt, timeline |
| Field types | **22** | **15** (one of them legacy and uncreatable) |
| Per-property menu in the detail panel | 7 items | **0 items — no menu at all** |
| Menu/popover primitives | 1 | **19** |
| Shared outside-click hook | yes | **none** — a scrim `<button>` copy-pasted 17× |
| Drag-and-drop systems | 1 | **3**, only one keyboard-accessible |

Notion has no Gantt. We have both Gantt and Timeline, and they share an icon
(`chart-gantt`, `viewKinds.ts:20-25`), so they're visually indistinguishable in
every picker.

---

## Phase 0 — Foundations

Nothing else in M16 is safe until these land. Each one is a prerequisite for
several later phases, and two of them fix live bugs on their own.

### M16.1 — One popover primitive

**Notion:** every menu, submenu and property popover shares one behaviour —
click-outside dismisses, Escape dismisses, focus returns to the trigger, the
panel flips when it would overflow the viewport, and submenus open on hover
with a chevron.

**Us:** 19 separate implementations
(`Dialog.tsx:48`, `Dropdown.tsx:29`, `ContextMenu.tsx:17`,
`DatePicker.tsx:33`, `FieldPopover.tsx:96`, `RelationPicker.tsx:136`,
`AddPropertyPanel.tsx:41`, `CreateMenu.tsx:101`, `ViewToolbar.tsx:362`,
`ViewControlIcons.tsx:129` and `:158`, `ViewTabs.tsx:263` and `:323`,
`TableView.tsx:679` and `:918`, `ChainBuilder.tsx:61`,
`ViewSettingsPanel.tsx:161`, `SyncBadge.tsx:91`, `ConversationSwitcher.tsx:38`,
`ChatInput.tsx:128` and `:153`, `MarkdownEditor.tsx:548`).

`createPortal` appears **zero times in `src/`**. There is no
`useOutsideClick`. Dismissal is a `fixed inset-0` scrim `<button>` pasted at 17
sites, 14 of which are focusable and sit in the tab order.

**Two live bugs this fixes:**

- **The add-property surface cannot be dismissed by clicking away.**
  `AddPropertyPanel.tsx` has no scrim, no `role="dialog"`, and no document
  listener — the only exits are the Cancel button and Escape-while-focus-is-in-
  the-name-input (`:216-224`). This is exactly the complaint that opened M16.
- **Escape on a kind button kills the whole detail panel.** With focus on a
  kind tile or a relation-target row, Escape is unstopped, bubbles to
  `DetailPanel.tsx:108-120`, and closes the panel. The `[role="dialog"]` guard
  at `:115` can't fire because `AddPropertyPanel` declares no dialog role.

**Work:**

- Promote `src/detail/FieldPopover.tsx` to `src/components/ui/Popover.tsx`. It
  already exports `useEscapeToClose`, `FixedBelowAnchor` and `EscapeToClose`,
  and is already imported by six unrelated modules — it is a shared kit hiding
  in a feature folder. This is a rename plus six import updates.
- Give it: portal, outside-click (pointerdown, capture), Escape, focus trap,
  focus return, collision flip (today `FixedBelowAnchor` is below-only and
  measures once with `deps: []`), `role="menu"`/`menuitem`, roving arrow keys,
  typeahead, and a `submenu` mode.
- **Focus return already has a shared hook — use it, don't re-derive it.**
  The PR #7 review round added `src/hooks/useFocusRestore.ts`
  (`Dialog.tsx:74`, `AiPanel.tsx:317`). Its docblock records the non-obvious
  part: the opener must be captured in a `useState` **initializer**, during the
  first render. Read it from an effect instead and you get a provably wrong
  answer, because `autoFocus` fires during commit and child effects run before
  their parent's — so any surface holding a focused field reads back **its own
  input** as the opener, that node is gone by cleanup time, and focus lands on
  `<body>`. Every popover M16 builds inherits this. `CreateMenu.tsx:61` is
  still bespoke and Escape-only; fold it in.
- Add a module-level **layer stack** and retire the two DOM probes that stand
  in for one today: `Dialog.tsx:101-102` counting `.cb-dlg`, and
  `DetailPanel.tsx:115` probing `[role="dialog"]`.
- Migrate all 19 call sites. Delete the 17 scrims.
- One shared test asserting the dismissal contract per surface. No such test
  exists today, which is why a 100-file suite never noticed the add-property
  gap.

### M16.2 — One drag-and-drop primitive

**Us:** three unrelated systems.
`@dnd-kit/core@^6.3.1` is installed and imported by exactly one component
(`BoardView.tsx:9-10`); `@dnd-kit/sortable` is **not** installed.
HTML5 `dataTransfer` at two sites (`FileTree.tsx`, `InboxPage.tsx`).
Hand-rolled window `pointermove` at three (`ResizeHandle.tsx`,
`TableView.tsx:330-360` + `:1180-1225`, `ViewSettingsPanel.tsx:610-636` —
whose comment says it is a copy of the table's).

Only `ResizeHandle` is keyboard-accessible.

**Work:** one `useSortableList` hook, keyboard-operable, built on the
`ViewSettingsPanel` pointer implementation (already proven) or on
`@dnd-kit/sortable`. Consumers across M16: detail-panel property reorder
(M16.7), view tab reorder (M16.29), select-option reorder (M16.11), board
within-column reorder (M16.21), table row reorder (M16.16), sort-rule reorder
(M16.28).

Note the two recorded gotchas for dnd-kit, if that route is taken: its
`attributes` stamp `role="button"`/`tabIndex=0` and swallow Enter
(`BoardView.tsx:101-115` re-adds it by hand), and Playwright's `dragTo`
synthesises HTML5 events dnd-kit ignores (`e2e/smoke.spec.ts:76-88` drives raw
pointer steps).

### M16.3 — Make a 7th view kind safe to add

Adding a `ViewType` member today compiles clean and **renders nothing**:
`ViewCanvas.tsx:51` has no return-type annotation, its switch has no `default`,
and `tsconfig.json` sets `strict: true` without `noImplicitReturns`.

Three more silent traps:

- `LAYOUTS: Set<ViewType>` (`views.ts:98`) — omit an entry and `parseViewType`
  (`:164-168`) silently downgrades every saved file to `list`.
- `DATED_LAYOUTS` (`ViewSettingsPanel.tsx:56`) and `CHIP_LAYOUTS` (`:58`) are
  plain `Set<string>`, plus a hardcoded `p.type !== 'calendar'` at `:230` and
  raw string compares at `:806`/`:828`.
- Five test files hardcode "exactly six" (`ViewToolbar.test.tsx:77`,
  `TypePage.test.tsx:55,60`, `views.test.ts:534`, `collections.spec.ts:173`,
  `smoke.spec.ts:41-46`).

**Work:** annotate `ViewCanvas`'s return type so the switch is
exhaustiveness-checked; derive `LAYOUTS` from `VIEW_KINDS`; replace the three
string sets and the hardcoded compares with **capability flags on `ViewKind`**
(the precedent already exists — `requires?: 'date'` and `axesFor`); make the
tests iterate `VIEW_KINDS` instead of literals. Update the four stale "the six"
comments (`viewKinds.ts:5`, `ViewCanvas.tsx:12`, `ViewTabs.tsx:262`,
`types.ts:200`).

### M16.4 — Single-source the field-kind list

`FieldKind` (`types.ts:24-38`), `FIELD_KINDS` (`schema.ts:25-40`) and
`PROPERTY_KINDS` (`properties.ts:128-178`) are three hand-maintained copies of
the same 15 entries. Only the first is compiler-enforced — omit the `schema.ts`
entry and `asFieldKind` (`:56-58`) **silently downgrades the kind to `text`**.
Same trap shape as `LAYOUTS`. Prerequisite for M16.12.

### M16.5 — Tooltip primitive

Notion tooltips everywhere; we have native `title=` at **109 sites**, including
`IconButton.tsx:55` and disabled buttons where the browser never renders it.

---

## Phase 1 — The detail panel

This is the phase the user asked for first, and it is where we are furthest
behind. Today a property row in `RecordProperties.tsx:47-54` is a 96px `<span>`
label and a value. No icon, no click target, no menu, no grip, no testid.

Every schema operation Notion offers from this menu **already exists as an
action** in `src/app/typeActions.ts` — it is only reachable from the table
column-header menu and the view settings panel. M16 is mostly wiring.

### M16.6 — Property row anatomy

**Notion:** `[kind icon] [name, truncated] · · · [value | "Empty"]`. On hover
the kind icon is **replaced by a 6-dot drag grip** and the row gets a hover
background. Label gutter ≈160px.

**Us:** no icon (the map exists — `kindMeta(kind).icon`, `properties.ts:184` —
and is used at `ViewSettingsPanel.tsx:661`, `AddPropertyPanel.tsx:248`,
`TableView.tsx:768`, just never in the detail panel). Declared rows have no
hover state and the label lacks `truncate`, while undeclared rows have both
(`:61-62`).

Do it in `RecordProperties.tsx` and its doc twin `DocProperties.tsx:203,214`.

### M16.7 — The per-property menu

**Notion, verbatim:** Rename · Edit property › · Comment · ─ · Property
visibility › · Duplicate property · Delete property · ─ · Customize layout.

Trigger: clicking the property **name**.

`Property visibility` submenu, verbatim: **Always show / Hide when empty /
Always hide**.

`Edit property` submenu, verbatim, for a select field:
name input + info · Type → Select › · AI Autofill › · Sort → Manual › ·
`Options` with a `+` · one row per option (grip + coloured chip + chevron) ·
Generate with AI · Duplicate property · Delete property.
The option chevron opens: rename input · Delete · `Colors` — **Default, Gray,
Brown, Orange, Yellow, Green, Blue, Purple, Pink, Red** (10, with a check on
the current one).

**Us:** none of it in the detail panel. The pieces:
`renameFieldOnType` (`typeActions.ts:350`) surfaced only at
`TableView.tsx:719-733`; `PropertyEditor` (`views/PropertyEditor.tsx:77`)
mounted only by `TableView.tsx:706` and `ViewSettingsPanel.tsx:449`;
`duplicateFieldOnType` (`:232`) called only from `TableView.tsx:641-648`.

**Ship:** Rename, Edit property (mount the existing `PropertyEditor`),
Duplicate, Delete, Property visibility (needs M16.9). **Skip Comment** — there
is no comment subsystem anywhere in the app: no type, no store, no IPC, no Rust
command. That is its own milestone.

### M16.8 — Drag to reorder properties

`moveFieldOnType` (`typeActions.ts:602-634`) is **already written, toast-wired,
and has zero call sites.** This is a UI-only job on top of M16.2.

State plainly in the UI: reordering here changes the **type's schema for every
record of that type**, not just the open one.

### M16.9 — Rebuild the add-property surface

**Notion:** a popover anchored to `+ Add a property`, with an autofocused
`Property name` input, an `AI Autofill` section, then a **searchable** `Type`
section listing all 22 kinds with icons. No OK/Cancel — picking a type commits.
Dismisses on outside click (verified: overlay count 4 → 2) and on Escape.

**Us:** an inline bordered `<div>` that pushes the layout
(`AddPropertyPanel.tsx:206-209`), 14 kinds in a `max-h-[220px]` scroller with
no search and no sections, a Cancel button, and the two dismissal bugs in
M16.1. `RecordProperties.tsx:84-88` also **lacks the duplicate-name guard** that
`DocProperties.tsx:151-154` has.

Keep what's ours and better: kind-first naming via `uniqueName`
(`:73-82`), the relation config step (`:101-202`), and untyped-doc kind gating
(`supportedOnOwner`, `:70-71`).

### M16.10 — Property visibility model

New. Notion's three states are per-property, not per-view. Ours has no model at
all: `ColumnSpec.hidden` is per-view and `hideEmpty` (`types.ts:167`) is about
groups. Add to `FieldDef`, honour it in `RecordProperties`, and add the
"N hidden properties" expander Notion shows.

### M16.11 — Panel header and layout

**Notion's peek header:** close · open-in-full-page · switch peek mode
(Side peek / Center peek / Full page) · previous/next page · Share · page info ·
favourite · overflow.
Plus **Customize layout**, which splits properties between an inline top strip
and a right-hand `Properties` column, with a `View details` / `Hide details`
expander.

**Ours** (`DetailPanel.tsx:196-232`): type icon, key, collection crumb, close.
Section order is hard-coded at `:233-279`.

Ship the header actions. `Customize layout` is a stretch goal — flag it and
decide.

---

## Phase 2 — Field and type system

### M16.12 — Select/status option handling

Inline creation **works** for select and multiselect
(`FieldEditor.tsx:100-118` → `optionId` → round-robin `TYPE_COLORS` →
`setFieldOptions`), with the "Create *query*" row at `FieldPopover.tsx:181-196`.
Four gaps:

- **Status is explicitly excluded** (`FieldEditor.tsx:103`) and dead-ends with
  "No statuses yet — add them on the type screen."
- **Duplicate slugs collide silently.** `canCreate` compares *labels*,
  `optionId` slugs — "In-Progress" and "In Progress" both slug to
  `in-progress` and the second overwrites. `OptionListEditor.tsx:144-148`
  gets this right and toasts.
- Untyped docs can't create (`ownerType !== null`).
- Options can't be reordered (`OptionListEditor.tsx:155-187`,
  `StatusListEditor.tsx:141-201` — rename/recolour/remove only). Persistence is
  free; both setters already take the whole list.

**Colours:** ours are 8 raw unnamed hexes (`TypeDialogs.tsx:15-24`) with no dark
variants, and `${color}22` alpha concatenation (`FieldEditor.tsx:47`) breaks on
any non-6-digit hex. Notion has 10 named colours. Replace with named tokens.

### M16.13 — Missing field kinds

Notion's 22, captured verbatim from the type picker: Text, Number, Select,
Multi-select, Status, Date, Person, Files & media, Checkbox, URL, Email, Phone,
Formula, Relation, Rollup, Created time, Created by, Last edited time,
Last edited by, Button, Place, ID (+ AI Autofill: Summarize, Translate).

| Kind | Us |
|---|---|
| Email, Phone | absent — `URL_SHAPE` accepting `mailto:` is the nearest thing |
| Created by, Last edited by | absent — `Entry` (`types.ts:5-21`) has no author field and the scanner emits none |
| Formula | absent — no parser, no evaluator, no function library |
| Button, ID, Place | absent |
| Person | ◐ candidates hardcoded to `e.type === 'Person'` (`FieldEditor.tsx:171`) — **violates our own "no type special-casing" rule** |
| Files | ◐ a text input labelled "Path or URL"; no `<input type="file">`, no upload, no preview |

Ship Email, Phone, Created by, Last edited by. De-special-case Person. Make
Files real. **Formula is its own milestone** — scope it out of M16 explicitly.

### M16.14 — Date parity

- **No time of day** — `showTime={false}` (`FieldEditor.tsx:356`) and the
  storage regex forbids it (`properties.ts:187,211-213`).
- **No new date field can ever hold a range.** `showEndToggle` is gated on
  `def.kind === 'daterange'` (`:355`), and `daterange` is `legacy: true`
  (`properties.ts:148`) so it's excluded from `CREATABLE_PROPERTY_KINDS`.
  Retire the split: one `date` kind with a range flag.
- **Per-property format silently reverts.** The picker offers 6 formats;
  `patch()` writes only `v.start` (`:348-350`) and the read hardcodes
  `format:'short'` (`:330`).
- Reminders are `showRemind={false}` (`:357`) though the machinery exists in
  `engine/reminders.ts`.

**Ahead of Notion, keep:** `inferKind` (`adopt.ts:66-95`) infers a kind from
data. Notion has nothing like it.

---

## Phase 3 — Table

Most of the parity gap lands in one 1473-line file. Two hazards to plan around:

- The display-index arithmetic is **index-based, not key-based**. Adding a
  leading checkbox/grip gutter shifts `titlePosition`, `displayKeys`
  (`:1129-1133`), `dropStyle` (`:1235-1242`) and `startHeaderDrag`'s midpoint
  measurement (`:1186`) simultaneously.
- The QuickAdd row is `width: var(--cb-cw-title)` (`:1401-1405`), so anything
  inserted left of the name column misaligns it.

The 15-item header menu has **zero UI coverage** in any unit or e2e test.

### M16.15 — Calculation footer

**Notion:** every column gets a footer cell, per group and per table. For a
select: `None / Count › / Percent ›`. For a number, also Sum, Average, Median,
Min, Max, Range. The group footer renders as e.g. `COMPLETE 2/3`.

**Us:** no footer element at all (`:1276-1460` is header → rows → empty state),
and **no aggregate module exists in `src/engine/`**. New `engine/aggregate.ts`.

### M16.16 — Row gutter and bulk actions

**Notion, on row hover:** `+` (insert row) · `⠿` (drag grip) · checkbox, and an
`OPEN` button inside the title cell. Selecting rows raises a bulk action bar.

**Us:** `TableRow` (`:154-301`) has none of it. The `maximize-2` icon at
`:281-286` is `aria-hidden` decoration; the real opener is the title button.
There is no `onContextMenu`. Bulk selection doesn't exist anywhere in the app —
`useRowKeyboard.ts:46` holds a scalar index, not a Set.

### M16.17 — Cell cursor

**Notion:** click a cell to select, Enter/type to edit, Escape to deselect,
Tab/arrows to move, and range copy-paste.

**Us:** every cell is an always-live `FieldEditor` (`:144`) — there is no inert
state to escape from, nothing binds Tab, there are no cell ids and no
`aria-colindex`. `useRowKeyboard` is a **row** cursor that bails on
INPUT/TEXTAREA (`:73-76`).

`FieldEditor` is the highest-blast-radius file in the app: it is also the value
control in the detail panel, the doc Info panel and every list-row chip slot.
**Any grid semantics must be opt-in via a prop** so the detail panel doesn't
inherit them. It has no test file.

### M16.18 — Header and column settings

| | Notion | Us |
|---|---|---|
| Freeze up to column | ✅ | only the name column (`TitleHeaderMenu:874-881`) |
| Numeric width / fit-to-content | ✅ | no width menu item, no double-click on `ColumnResizer` (`:353-388`) |
| Inline `+` to add a column | ✅ | header closes at `:1384`; `hiddenColumns` (`columns.ts:94`) is exported for this and has no call site |
| Row height | ✅ | `rowHeight` is parsed (`views.ts:130-133`) and serialized (`:548`) and **consumed by nothing** |
| Show vertical lines · Show page icon · Wrap all content | ✅ | absent |
| Sort indicator | ✅ all keys | only `presentation.sort[0]` (`:1114`, `:1366-1372`) |
| Header hover affordance | ✅ chevron | none — a 15-item menu behind text that looks static (`:662-669`) |

**Ahead of Notion, keep:** column reorder by drag (`:1179-1225`), keyboard
column resize (`role="separator"`, `:315-389`), and 3-level grouping
(`MAX_GROUP_DEPTH`, `views.ts:113`).

---

## Phase 4 — Board, List, Gallery

### M16.19 — Board correctness (before any board feature work)

Four structural bugs, all in `BoardView.tsx`:

- It calls `groupEntries` directly (`:285`) instead of `groupTree`, so
  `hideEmpty` and `dir` — both honoured by the engine
  (`grouping.ts:135,140`) — **structurally cannot take effect**.
- It reads `presentation.group[0].field` blindly with a `?? 'status'` fallback
  (`:281`), so a relation `descend` level silently becomes the column axis.
- It derives `groupKind` from the **first parseable entry only** (`:288-289`),
  so a heterogeneous board mis-types drag and create writes.
- It never reads `presentation.columns`, hardcoding `priority` + `assignee`
  (`:90-91`) — which makes the shared Properties page a **visible no-op**.
  (Same is true of Calendar, Timeline and Gantt: the eye toggle does nothing on
  4 of 6 layouts.)
- `ViewCanvas` never passes `filtered` to Board (`:91-100`), so a filtered-empty
  board says "No items yet".

Routing it through `groupTree` is a small change that unlocks two settings the
engine already implements.

### M16.20 — Board settings parity

**Notion's board layout panel, verbatim:** Show page icon · Wrap all content ·
Group by › · **Color columns** · Open pages in › · Card preview › · Card size ›
· **Card layout: Compact | List**.
Plus a per-column header menu, collapse, and within-column reorder.

**Us:** header is three inert spans (`:173-186`); only swimlanes collapse; no
card size, cover or preview keys on `Presentation`; `Entry.snippet`
(`types.ts:18`) is rendered by nothing. Within-column reorder is impossible
until `@dnd-kit/sortable` is installed — `handleDragEnd` early-returns on
same-column (`:58`).

**Ahead of Notion, keep:** keyboard-operable card drag (`KeyboardSensor`,
`:276-278`).

### M16.21 — List polish

No hover Open affordance (`:126-141` is a bare div), no row menu, no drag
reorder, and **collapse state is never persisted** (`uiStore.ts:448` sets
`collapsed: {}` and unlike its neighbours never writes it back).

**Ahead of Notion, keep:** multi-level nesting with expand/collapse
(`:189-239`). Notion's list has no nesting.

### M16.22 — Gallery (new view kind #7)

**Notion's gallery panel, verbatim:** Show page icon · Wrap all content ·
Open pages in › · Load limit › · **Card preview › (None / Page cover / Page
properties / Page content — "Uses first block on the page")** · **Card size ›
(Small / Medium / Large)** · **Fit media** · **Card layout: Compact | List**.

Cards are a preview block with the title beneath; grouping still applies.

Depends on M16.3. Needs per-record cover/icon, which `Entry` doesn't have
(only *type* icons via `typeStyle`) — decide whether that's frontmatter or
a body-derived preview.

---

## Phase 5 — Time views

### M16.23 — Calendar

| | Notion | Us |
|---|---|---|
| Drag an event to another date | ✅ | **zero drag handlers in all three time views**; every bar/chip is a click-only `<button>` |
| Resize a bar to change the range | ✅ | no edge handles |
| Week view | ✅ `Show calendar as: Month / Week` | `monthGrid` (`schedule.ts:154`) is the only grid builder |
| Show weekends toggle | ✅ | absent |
| Week start | ✅ | `monthGrid(iso, weekStart=0)` accepts it and is called with no argument (`:119`, `:213`) |
| Which date property | ✅ `Show calendar by ›` | `dateField` exists; surfaced only in the settings Axis page |
| Click a day to create | ✅ | ◐ hover `+` only (`DayAdd:400-453`); the day `<div>` (`:248-257`) has no onClick |
| `No date (N)` bucket | ✅ toolbar chip | absent |
| Chip shows properties | ✅ | type icon + title only (`:290-291`); `presentation.columns` unread |
| Keyboard nav | ✅ | plain divs, no roving tabindex, no grid roles |

One correctness bug: quick-add from a day writes
`quickAdd(title, {}, {[dateField]: day})` — a **bare string even for a
`daterange` field**, which is off-kind on disk.

**Ahead of Notion, keep:** multi-day span bars with lane packing and `+N more`
overflow (`:319-360`, `:295-312`).

### M16.24 — Timeline and Gantt

**Notion's timeline panel, verbatim:** Show page icon · **Show timeline by ›** ·
**Show table** (toggle) · **Table properties › (N shown)** · Open pages in ›.
Zoom: **Hours, Day, Week, Bi-week, Month, Quarter, Year, 5 Years** (8).
Chrome: `No date (N)` chip, `Manage in Calendar`, `‹ Today ›`, a red today line
and a red dot on the date, shaded weekends.

**Us:** 4 zoom levels (`schedule.ts:204-216`), no sub-day unit, and quarter
still ticks monthly (`:288-289`). Timeline has no table half by design
(`:37-45`); Gantt's is a private module constant `NAME_W = 300`
(`GanttView.tsx:30`) — not state, not a prop, not persisted, so it can't be
shown, hidden or resized. Timeline defaults `week` (`:57`) and Gantt `month`
(`:77`) while the settings panel shows `?? 'week'` for both
(`ViewSettingsPanel.tsx:811`).

**Decision to make:** Notion has no Gantt. Ours has real Gantt features Notion
lacks — WBS gutter, dependency arrows, slip stepper, parent spines, "Set dates"
ghost (`:206-267`, `:373-409`, `:168-184`). Recommendation: **keep both, but
give them distinct icons and make Timeline = Gantt with the table half and
dependencies off**, so they stop being two implementations of one thing.

Gantt is missing rolled-up parent dates (the parent uses its own `spanOf`,
`:292`, with no min/max over children), critical path, baseline and
progress-in-bar.

---

## Phase 6 — View chrome

### M16.25 — Filters

**Notion:** field picker with type icons → `Where [field] [operator] [value]` ·
`+ Add filter rule ▾` → **Add filter rule / Add filter group ("A group to nest
more filters")** · `Delete filter`. A chip bar shows `[≡ 1 rule ▾] + Filter`.
Text operators, verbatim: **Is, Is not, Contains, Does not contain, Starts
with, Ends with, Is empty, Is not empty.**

**Us:** exactly 9 operators, **flat and kind-blind**, rendered unconditionally
(`FilterBuilder.tsx:9-19`, `:82`). Missing `does_not_contain`, `starts_with`,
`ends_with`, `>`, `<`, `>=`, `<=`, `is_between` and relative dates. The value
editor is **always a bare text `Input`** (`:91-100`) even for select, date,
checkbox and relation. The chip bar is per-axis, not per-rule
(`ViewToolbar.tsx:246-339`) — you cannot see or remove one condition without
opening the popover.

**Ahead of Notion, keep:** nested AND/OR groups two levels deep
(`FilterBuilder.tsx:235`). Notion allows one.

### M16.26 — Sort, tabs, toolbar

- Sort rules have no drag grip (`ChainBuilder.tsx:110-141`), and the two
  surfaces disagree on the cap: the chip bar says `max={4}`
  (`ViewToolbar.tsx:320`), the settings SortPage has none.
- **No view tab reorder** — no draggable handler, no Move left/right item, and
  **no `moveView` action exists**.
- `ViewDefinition.icon` is parsed, serialized and read, but `newView` hardcodes
  `null` (`views.ts:409`) and no UI ever writes it. Notion lets you pick any
  emoji per view — visible on every tab in the screenshots.
- No search-within-view. Notion's is in the toolbar.
- The `New` button is a bare `Button` (`:143-149`); Notion's is a split button
  with a template dropdown.
- `hideEmpty` is honoured by the engine (`grouping.ts:140`) and **no UI ever
  sets it**.
- No load limit — Notion defaults to 25 and every view of ours renders
  `entries` in full.

**Ahead of Notion, keep:** Group on the toolbar (Notion buries it in settings),
and auto-persist with no Save button.

---

## Phase 7 — Chart and Dashboard

### M16.27 — Chart (new view kind #8)

**Notion's chart panel, verbatim:**

- **Chart type:** vertical bar · horizontal bar · line · donut · number
- **X axis:** What to show · Sort by · Omit zero values
- **Y axis:** What to show (Count) · Group by · Range (Auto) · Reference line
- **Style:** Color (Auto) · More style options
- Source · Filter · Save chart as… · Copy link to view

Depends on M16.3 and reuses M16.15's aggregate module.

### M16.28 — Dashboard (new view kind #9)

Notion exposes Dashboard as a **10th layout tile**, below the 3×3 grid: a grid
of widgets (charts, tables, lists, number tiles) with filters spanning multiple
data sources. This is the largest single item in the plan and should be its own
milestone if M16 runs long.

**Not recommended:** Feed and Map. Neither fits a files-first markdown vault.

---

## Sequencing

Phase 0 is a hard gate. After that:

```
0 ─┬─ 1 (detail panel)      ← start here, it is the stated priority
   ├─ 2 (fields)            ← 2 partly depends on 1's menu
   ├─ 3 (table)             ← 3.15 aggregate unblocks 7
   ├─ 4 (board/list/gallery)← 4.19 correctness before 4.20
   ├─ 5 (time views)
   └─ 6 (view chrome)
                7 (chart/dashboard) ← needs 0.3 + 3.15
```

**Scope honestly:** this is 28 phases. Formula (M16.13), Customize layout
(M16.11), comments (M16.7) and Dashboard (M16.28) are each milestone-sized on
their own and are flagged as such above. A defensible M16 is **Phase 0 + Phase 1
+ Phase 2 + Phase 3**, with 4–7 as M17.

## Test debt this milestone must not inherit

- `FieldEditor.tsx` — **no test file**; the date, url, files, checkbox and
  person branches are untested at component level. It is the single
  highest-blast-radius file in the app.
- `ViewSettingsPanel.tsx` (1056 lines) — **no test file**; reached only
  incidentally through two `TypePage.test.tsx` assertions.
- The table's 15-item header menu — **zero UI coverage**.
- No test anywhere asserts a popover dismissal contract.

## Conventions

Commits: `type(scope): sentence (M16.<n>)`. One phase per commit where possible.
Coverage thresholds in `vite.config.ts` ratchet **up** only. Never
`--no-verify`. Plans are force-added (`git add -f`) because `docs/` is
gitignored.

---

# Shipped — 2026-08-03

All 28 phases are on `m16-notion-parity` (PR #8). **1830 vitest / 178 cargo /
27 e2e**, lint + typecheck + prettier + rustfmt + clippy clean. Nine view
kinds: table, list, board, calendar, gantt, timeline, **gallery, chart,
dashboard**.

Phases 3–7 were built by five agents in parallel git worktrees, then merged in
four passes and re-verified in a live browser twice. Two rounds of fixes
followed the verification (M16.29–M16.34).

## What the plan got wrong

- **M16.15's aggregate module did not exist when M16.27 needed it.** The chart
  extracted `aggregateNumbers` out of `computeRollup` instead. Both now share it.
- **A record has no cover.** The plan listed Notion's "Card preview › Page
  cover" as parity for the board. `Entry` carries a per-TYPE icon and nothing
  per record, so the option would have been an inert menu row. The parser
  rejects `cover` if a file states it.
- **`Entry.snippet` is not "rendered by nothing"** — `InboxPage` has shown it
  since M4.
- **The board's filtered empty state was not a `ViewCanvas` fix**; the prop had
  to be added to `BoardView` and threaded.
- **`newView` needed no `moveView` action** — both pages already had a persist
  path.

## Deliberately not built, with reasons

- **Image previews / Gallery covers.** Needs `assetProtocol` enabled AND the
  CSP widened. That is a deliberate change to what the webview may load and
  deserves its own commit; a cover names its file instead of showing a broken
  image, and says so in the settings panel.
- **Date reminders on properties.** `DatePicker` has the UI and `remindAt`
  computes the time, but nothing schedules or delivers a notification.
  Shipping the toggle would promise what the app cannot do.
- **Collapsing `date` and `daterange` into one kind.** Notion's model and the
  honest end state, but `resolveDateField`, CalendarView, the timeline and the
  settings pickers all key on the distinction.
- **Created by / Last edited by.** No author exists in `Entry` or the Rust
  scanner, and git yields a constant because of auto-checkpoint. The only
  honest build is stamp-on-write from `uiStore.actorId`, whose real value is
  **me vs the assistant** — something git cannot tell you. Awaiting a decision.
- **Within-column card reorder and list row drag.** Needs `@dnd-kit/sortable`
  (not installed) plus a manual-order key on the view — a model decision.
- **Stacked/series charts.** A chart uses the first band level; a second would
  have to become a stacked series, which is a different renderer.

## Known open, all reported rather than dropped

1. **A load limit changes a board's AXIS shape.** `groupEntries` derives ghost
   and no-value buckets from the VISIBLE entries, so those columns vanish under
   a limit while declared options survive at 0. Real design question: should the
   axis follow all records or the loaded ones? Fixing it touches `groupTree` /
   `buildRows` and four layouts.
2. **`hideEmpty` wants a per-layout default** — a board needs empty columns as
   drop targets, a table does not. Blocked on the capability catalog living in
   `src/views/` while `engine/` must not import it.
3. **Five `FixedBelowAnchor` surfaces** now register a layer but still have no
   Escape of their own. Migrating them to `Popover` is the M16.1 backlog item.
4. **Option COLOUR swatches** are missing in filter checklists — needs a swatch
   prop on the shared `MenuItem`/`Dropdown`.
5. **`ViewSettingsPanel` / `ViewSettingsDialog`** embed `FilterBuilder` with
   unenriched fields, so a Status rule there is still a text box.
6. **The title column can never wrap**, because `wrapAllColumns` only touches
   `presentation.columns`, which excludes the implicit title column. Pre-dates
   M16 but is more visible now the setting reads "Wrap all columns".
7. **Filter and view-settings popovers carry no `role`** — invisible to the
   accessibility tree.
8. **`e2e/collections.spec.ts` "views: all six are reachable"** passes but is
   stale; there are nine, and the three new kinds have no e2e coverage.
9. **No demo-vault fixture** for gallery / chart / dashboard, deliberately —
   editing it churns e2e assertions.

## The incident worth remembering

Three times during this milestone a commit titled **"old state"** deleted every
tracked file. The cause is `GIT_DIR` inheritance, documented in full in
`src-tauri/src/git/command.rs`: git exports `GIT_DIR` to its hooks, it outranks
`Command::current_dir()`, and `git_command()` scrubbed nothing — so a test
building a throwaway repo under `temp_dir()` staged and committed into this
checkout instead, but only ever under `.husky/pre-push`.

The dead end cost the most: a containment guard that asks git where it is
CANNOT catch this, because `rev-parse --show-toplevel` reports the work tree
(which follows cwd) while the commit goes where `GIT_DIR` says. One guard was
shipped, and the wipe happened again with it in place.
