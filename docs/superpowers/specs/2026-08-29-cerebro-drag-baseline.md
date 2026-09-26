# Our drag grammar and property-row anatomy — measured, against Notion's

Every table here reads **before → after → Notion**.

**Before** measured 2026-08-29 against **our own app** at `0f88358`, the tip
M46.2 started from. **After** measured 2026-08-30 the same way, at `285fec6`
plus the three Task 8 fixes below, once every implementation task had landed.
Both runs: `PORT=5373 pnpm dev` (Vite 7.3.6) on branch `m45-layout-editor`, in
Chrome through the Chrome DevTools MCP bridge.

**Theme**: dark — `document.documentElement[data-theme="dark"]`, `body`
background `rgb(21, 24, 31)`. This matches the theme the Notion reference was
taken in, so the colour columns are comparable. **Light-theme values are not
measured** on either side.
**Viewport**: 1728 × 936 CSS px, devicePixelRatio 2, for both runs (the after
run also swept 1400 / 900 / 760 / 620 / 520px for the narrow-width questions).
Backend: the browser mock IPC over `demo-vault` (`window.__cerebroMockFs`), so
every write below landed in memory and nothing on disk changed (`git status`
clean before and after).

**Companion document**: `2026-08-29-notion-drag-and-row-reference.md`. Its
"What our implementation would need" checklist is the row set of every table
here, in its order, so the two documents line up one-to-one.

## The result, in one table

48 requirement rows across the six tables below.

| Outcome | Rows | Which |
| --- | --- | --- |
| **Met** | 38 | A1–A10; the strip's label row, value row and total; B1–B5 and the grip-consistency row; C1–C10; D1–D7, D9, D10 |
| **Met, with a deviation recorded inside the row** | 4 | B6 (`grabbing` scoped to the dragging list, not the single held row) · B7 (no `+` beside the block handle) · strip Container (Notion's 8px gap, our wrap instead of their scroller) · strip Column (54px height, no 80–200px clamp) |
| **Deliberately not met** | 3 | D8 the 2px page-coloured end cap · B8 the two-job accessible name · the absence of "Move up"/"Move down" |
| **No target** — unmeasured on Notion's side too, so still labelled rather than filled in | 2 | A11 the value-cell focus ring · whether `⌘Z` undoes a reorder |
| **Ahead of the reference** | 1 | keyboard reorder, which Notion's property rows do not have. Measured live this time, and deliberately not spent |

Two more deviations live in prose rather than in a row, and both are the same
answer to the same question — *what would we write to?*

- **Table rows still have no drag reorder at all.** Row order IS the view's
  sort chain and there is no stored per-row index; the grip glyph opens the
  row menu instead. Re-verified: `[data-testid="table-row"]` carries neither
  `data-sortable-grip` nor `data-drag-id`, and the control there is labelled
  `Actions for …`.
- **A board card's line marks the COLUMN, not a position between cards** —
  measured as `data-line="backlog" data-side="start"`, a 4px line down the
  column's own 1009px height. Rank inside a column is the same sort chain, so
  there is no index a between-cards drop could write. Moving a card BETWEEN
  columns writes a real field, and that is the move the line describes.

**No row is left unexamined.** Where a value could not be read, the reason is
in the table and in "What I could not measure" at the foot.

## Surfaces measured

| # | Ours | Component | What it gave |
| --- | --- | --- | --- |
| O1 | Record detail panel, vertical property rows (Project record — a flat type, so the rows carry grips) | `RecordProperties` → `PropertyRow` | property-row anatomy, the grip, drag lifecycle C-I |
| O2 | Record detail panel, horizontal heading strip (Work item record) | `RecordProperties` heading strip | the A.2 strip anatomy |
| O3 | Layout editor → Planning group editor, panel rows | `GroupEditorPopover` + `useSortableList` | a second C-I list, and a second grip geometry |
| O4 | The view tab strip on a type screen | `ViewTabs` + `useSortableList` (`axis: 'x'`) | horizontal C-I, and the decisive Escape test |
| O5 | Layout editor canvas — field rows and group shells | `LayoutCanvas`, dnd-kit + `DropSlot` | our C-II equivalent |
| O6 | Board cards | `BoardView`, dnd-kit | a **third** grammar the reference did not anticipate |

The after run drove all six again, and added the one the baseline could only
read from source:

| # | Ours | Component | Why it was added |
| --- | --- | --- | --- |
| O7 | A dashboard's widget grid, in edit mode with three widgets | `DashboardView` + `BlockDrag` | The baseline listed it under "could not measure". It is the third C-II caller, and a claim about a shared primitive is worth more when all of its callers have been driven |

The components under O5 and O6 changed with the slice: `DropSlot` and the
whole-column wash are gone, and all three block surfaces now draw through
`components/ui/BlockDrag.tsx` — `DragGhostLayer` plus `InsertionLine`. So the
C-II numbers in the after column are one primitive measured at three call
sites, not three coincidences.

**Method** — the same one the Notion pass used, and the same one both runs
used:

- Geometry and styling read live with `evaluate_script` over
  `getBoundingClientRect()` and `getComputedStyle()`; Tailwind's generated
  declaration text walked out of `document.styleSheets` where the class name
  was the clearer statement of intent.
- `:hover` states read under a **real CDP hover**, not a synthetic event.
- Drags driven by synthetic `PointerEvent` sequences dispatched at the grip,
  held open across tool calls, with a double-`requestAnimationFrame` wait
  after every move so React had actually committed before each read.
- `Escape` sent as a **real** keypress.
- Anything not read live is written **not measured** or explicitly labelled
  **source-derived**. There are no plausible-looking guesses in this document.
  A source-derived line is a fact about our code, not about the rendered
  result, and is never mixed into a "measured" cell.

**Tokens seen through these components** (dark): `--n-25 #191d25`,
`--n-50 #1e222b`, `--n-100 #252a35`, `--n-200 #2e3440`, `--n-400 #6e7688`,
`--n-500 #8b93a5`, `--n-700 #c5cbd7`, `--n-800 #e0e4ec`, `--n-900 #f4f6fa`,
`--cortex-50 #1b2547`, `--cortex-500 #3d5bde`; radii `--r-xs 4px`,
`--r-sm 6px`, `--r-md 8px`; sizes `--fs-2xs 11px`, `--fs-xs 12px`,
`--fs-sm 13px`, `--fs-md 14px`.

---

## A. Property row anatomy

Ours measured on **O1** (vertical panel rows) unless the row says strip.

| Requirement | Notion (measured) | Ours — **before** (`0f88358`) | Ours — **after** (re-measured 2026-08-30) | Verdict |
| --- | --- | --- | --- | --- |
| **A1** Row pitch **38px** = 34px content + 4px bottom margin; the gap is NOT part of the hover target | 38px pitch, rows at y 84/122/160/198/236/274/312; row content 34px, `margin 0 0 4px` | **33px pitch** — rows at y 202/235/268/301/334/367. Row content box **26px**; the 7px is the container's `gap-[7px]` flex gap, so it is genuinely outside the hover box | **−5px pitch, −8px content height.** The *structure* is right (gap outside the target); only the numbers differ | Rows at y **109 / 147 / 185** — a **38px pitch**. Content box **34px** (`min-h-[34px]`); the 4px is the container's `gap-1`, still outside every hover target | **met** |
| **A2** Label column fixed **120px** `flex-shrink: 0`; value `flex-grow: 1` + `margin-left: 4px`; the label→value gap is a **4px margin**, not a column gap | 120px / 223px, gap from `margin-left: 4px` | Label column **116px**, `flex: 0 0 auto` (`PROPERTY_LABEL_W = 116`). Value `min-w-0 flex-1`, `margin-left: 0`. Gap is the ROW's `column-gap: 6px` | **−4px label column; gap is 6px and is a flex gap, not a margin** | Label cell **120px**, `flex: 0 0 auto`; value `flex: 1 1 0%` with **`margin-left: 4px`**. The gap belongs to the value column, not to the row | **met** |
| **A3** Label cell `padding: 0 6px`, `radius 6px`, `cursor: pointer`, `user-select: none`, secondary text colour | as stated; colour `rgb(173,169,163)` | Label is a `<button>`: `padding: 3px 0 0` (**no horizontal padding**), `border-radius: 6px`, `cursor: default`, `user-select: auto`, colour `rgb(139,147,165)` = `--n-500` | **No horizontal padding, wrong cursor, no `user-select: none`.** Radius and the secondary-colour role match | `padding: 0px 6px`, `border-radius: 6px`, `user-select: none`, colour `rgb(139,147,165)` = `--n-500`. `cursor: pointer` **only where the label opens a menu** | **met** — the conditional cursor is ours: Notion has no label that opens nothing, we do |
| **A4** Label-cell hover background `rgba(255,255,255,0.055)` with `transition: background 20ms ease-in` | as stated | Label hover `rgb(37,42,53)` = `--n-100`, **opaque**, `transition: all` (i.e. the initial value — **no transition at all**) | **No declared transition anywhere on the row.** Ours is an opaque token, not a translucent wash — see "Where copying Notion would be wrong" | Label cell hover `rgb(30,34,43)` = `--n-50`, `transition: color .02s ease-in, background-color .02s ease-in, border-color .02s ease-in, fill .02s ease-in` | **met** — Notion's relationship and its 20ms, spent in our own token |
| **A5** Value cell `padding: 6px`, `radius 4px` (smaller than the label's 6px), `min-height: 34px`, `overflow: hidden`, `cursor: pointer` | as stated | The value column div has **no padding, no radius, no min-height**. The real control is a nested `<button>`: `padding: 3px 8px`, **`border-radius: 8px`**, `min-height: auto`, measured height 26px, `cursor: default` | **Value radius is 8px — LARGER than the label's 6px, the inverse of Notion.** No min-height | `padding: 6px`, `border-radius: 4px`, `min-height: 34px`, `overflow: hidden`, `cursor: pointer`; measured height 34px. The label's 6px radius is now LARGER than the value's 4px | **met** — the inversion is corrected |
| **A6** **The value cell has NO hover background** — only the label lights up | verified live: value cell `rgba(0,0,0,0)` under hover | **Three things light up at once.** Under one real hover: the row → `rgb(25,29,37)` (`--n-25`), the value button → `rgb(30,34,43)` (`--n-50`), and (when the pointer is on the label) the label button → `rgb(37,42,53)` (`--n-100`) | **Worst single anatomy delta.** Notion lights one region; we light two stacked regions plus a row wash | Under a real hover on the value: row `rgba(0,0,0,0)`, label cell `rgba(0,0,0,0)`, control `rgba(0,0,0,0)` — **nothing lights**. Under a real hover on the label: the 120px cell alone, at `--n-50` | **met** — the worst single anatomy delta, closed |
| **A7** Empty state is the literal word **"Empty"** in `rgb(125,122,117)`; geometry identical to filled | as stated | Literal **"Empty"** in `rgb(110,118,136)` = `--n-400`, 13px/20px, inside a `<span class="text-n-400">`, preceded by a 12px kind glyph. Button height 26px empty **and** 26px filled — geometry identical | **Match** (different token value, same idea). We add a leading glyph Notion does not | Unchanged | **met** |
| **A8** Label typography **14 / 400 / 20** in the panel, **13 / 500 / 18** in the strip — the strip label is smaller *and* heavier | as stated | Panel **12 / 400 / 20**; strip **12 / 400 / 20** | **−2px in the panel; the strip is not differentiated at all** — same size, same weight as the panel | Panel **14 / 400 / 20**; strip **13 / 500 / 18** — smaller *and* heavier, as measured | **met**, with a recorded consequence: our values stay at 13, so a panel label is one step ABOVE the thing it names. Ruled on live at Task 8 — see § The 14px ruling |
| **A9** Label text `nowrap` + `ellipsis`; never wraps | as stated | `white-space: nowrap`, `overflow: hidden`, `text-overflow: ellipsis` (`truncate`) | **Match** | Unchanged | **met** |
| **A10** Icon slot **18 × 24**; glyph 16px ×1.2 (panel) / 14px ×1.2 (strip); icon→text gap **6px** panel, **2px** strip | as stated; painted glyph 19.2 × 19.2 | Slot **13 × 13** (`relative flex h-[13px] w-[13px]`), glyph a 13 × 13 lucide SVG at `--n-400`, no scale. Icon→text gap **6px** in the panel and **6px** in the strip | **Slot is 13 × 13 against 18 × 24; strip gap is 6px, not 2px.** Panel gap matches | Slot **18 × 24**; glyph **16px** in the panel, **14px** in the strip; icon→text gap **6px** panel, **2px** strip | **met** |
| **A11** No focus ring specified for the value cell (**not measured** in Notion); house style is `box-shadow` rings, never `outline` | not measured | **not measured** — I did not focus a value control | — | Still **not measured** | **no target** — nothing was measured on Notion's side either, so there is nothing to match. Unchanged, and still labelled rather than filled in |

### A.2 The horizontal property strip (O2 vs Notion S1)

| Requirement | Notion (measured) | Ours — **before** (`0f88358`) | Ours — **after** (re-measured 2026-08-30) | Verdict |
| --- | --- | --- | --- | --- |
| Container | horizontal **scroller**, `overflow: auto hidden`, `min-width: max-content`, `height: 54px`, gap `8px` | `flex` with **`flex-wrap: wrap`**, `row-gap 8px / column-gap 20px`, no scroller, no fixed height | **We wrap onto more lines; Notion scrolls one line.** Column gap 20px vs 8px | `flex` with **`flex-wrap: wrap`**, `row-gap 8px / column-gap 8px`, no scroller and no fixed height — measured height 54px from its content. From 1728px down to 520px it never forced a page-level horizontal scroll | **gap met; the scroller deliberately not.** Notion's strip sits at a fixed page width; ours sits in a panel the user can narrow to its minimum, and a horizontal scroller nested inside an already-scrolling panel hides properties behind a gesture nobody would think to make. The **20px column gap was simply wrong** and is now Notion's 8 |
| Column | `flex-direction: column`, `min-width: 80px`, `max-width: 200px`, `height: 54px` | `flex-direction: column`, `gap: 2px`, **no min/max width** (measured 91.7px and 93.8px, content-driven), height **48px** | −6px column height; no width clamp, so columns are ragged | `flex-direction: column`, height **54px**; still no `min-width`/`max-width` clamp — measured 87.7px and 89.8px, content-driven | **height met; the 80–200px clamp deliberately not.** The clamp is what makes a scroller's columns line up; a wrapping strip wants its columns at content width, or a two-character value pads out to 80px for nothing |
| Label row | height 24px, `padding 0 6px`, `radius 6px`, inner gap **2px**, glyph 14px ×1.2 | height 20px, **no padding, no radius**, inner gap **6px**, glyph 13px | Label is not a cell here — it has no box at all | height **24px**, `padding: 0px 6px`, `border-radius: 6px`, inner gap **2px**, glyph **14px** | **met** — the label is a cell here now |
| Value row | height/min-height **30px**, `padding 4px 6px`, `radius 4px` | height 26px, control `padding 3px 8px`, `radius 8px` | Same inversion as A5 | min-height **30px**, control `padding: 4px 6px`, `border-radius: 4px`, and its hover wash now carries the 20ms token | **met.** The wash itself is the **recorded deviation**: it stays because no hover was measured on Notion's strip either way and the value is the only thing in the column you can click — the strip's own version of one-region-lights |
| Total | 24 + 30 = **54px**, no gap | 20 + 2 + 26 = **48px** | −6px | 24 + 30 = **54px** | **met** |

---

## B. The drag grip

**Headline finding, and it contradicts the plan's premise:** our property rows
**already do the thing the plan says we do not** — the grip is absolutely
positioned `inset-0` inside the *same* 13 × 13 cell as the type icon and
cross-fades with it. The `-left-5` gutter grip the plan calls out is real, but
it lives on the **layout canvas**, not on property rows. We have **four**
distinct grip geometries where Notion has two.

| Requirement | Notion (measured) | Ours — **before** (`0f88358`) | Ours — **after** (re-measured 2026-08-30) | Verdict |
| --- | --- | --- | --- | --- |
| **B1** Grip **replaces the type icon in place**; one grid cell; icon `1→0`, grip `0→1`; both `transition: opacity 0.15s`; no gutter column; **row width must not change on hover** | as stated | **O1 property row: architecture matches.** Icon carries `group-hover:opacity-0`, grip `opacity-0 → group-hover:opacity-100`, both inside one 13 × 13 `position: relative` cell with the grip at `absolute inset-0`. Row width measured 535px hovered and unhovered. **But `transition` computes to `all` — the initial value — so there is NO transition: the swap is a hard cut.** | **The cross-fade is missing.** Geometry and no-shift are already right on this surface | One `Grip` primitive. Property row: the 18 × 24 cell holds icon and grip, both carrying `motion-move`, and both read `transition: transform .2s, opacity .2s, box-shadow .2s` — a real cross-fade. Row width **539px hovered and unhovered** | **met**, at 0.2s not 0.15s: our movement token spent once, rather than a third number for a difference nobody can see |
| — same, other surfaces | — | **O5 canvas:** grip is `absolute -left-5`, a **gutter** outside the row — a separate primitive. **O3 popover rows:** grip is an **in-flow flex child** (12 × 16) that holds its slot at `opacity: 0`, so no shift, but it is neither an icon swap nor a gutter. **O4 tabs:** grip is `absolute inset-y-1 left-0`, a 10 × 28 overlay sitting on the tab's own 10px left padding | **Four grammars for one affordance.** None of them shift layout on hover, which is the good news | **Three kinds, one primitive** (`components/ui/Grip.tsx`): `row` (18 × 24 — property rows, popover rows), `block` (18 × 24 gutter — canvas, dashboard) and `tab` (the 10px a tab's own left padding gives). Four hand-rolled geometries became one class plus one declared exception | **met** — and the exception is recorded at the call site, not hidden |
| **B2** Reveal scoped to the **whole row**, not the label cell | grip stayed at opacity 1 with the pointer 100px away over the value | **Match, measured**: with a real hover on the *value* control, the grip read `opacity: 1` and the icon `opacity: 0` on that row, and 0/1 on the others | **Match** | Re-measured: with a real hover on the *value*, that row's grip read `opacity: 1` and its icon `0`, and the other rows 1/0 the other way | **met** |
| **B3** Slot **18 × 24**; glyph a **16px** six-dot mark (2 × 3, r 1.2, painted bbox 6.4 × 12) in the secondary *icon* token | as stated; colour `rgb(173,169,163)` | Property row: slot **13 × 13**, glyph a 13 × 13 lucide `grip-vertical`, `viewBox 0 0 24 24`, six circles `r=1` at cx 9/15, cy 5/12/19 — a 2 × 3 grid; `getBBox` 8 × 16 user units → **painted path bbox 4.33 × 8.67px**, `fill: none`, `stroke-width: 1.75` user units, colour `rgb(110,118,136)` = `--n-400`. Canvas grips 16 × 24 box with a 12px glyph; tab grip 10 × 28 with an 11px glyph; popover grip 12 × 16 | **Slot and glyph are roughly ⅔ scale**, and ours is a *stroked outline* mark where Notion's is *filled* dots — ours reads thinner at the same size | Slot **18 × 24**; glyph a **16px** lucide `grip-vertical`, `getBBox` 8 × 16 user units, `fill: none`, `stroke-width: 1.75`, colour `rgb(110,118,136)` = `--n-400` | **met** on the slot — 169px² became 432px². The glyph stays our **stroked** mark against Notion's filled dots: deliberate, it is the one grip glyph the whole app draws and swapping it here would split the family to match a hairline |
| **B4** Grip has **no background and no border-radius of its own**; the highlight belongs to the label cell | as stated | Property grip has `border-radius: 4px` (`rounded-xs`) **and its own hover background** `hover:bg-n-100`. Canvas, tab and popover grips likewise carry `rounded-xs`; the canvas grips also carry `hover:bg-n-100` | **We paint a second, smaller highlight inside the row's highlight** | `border-radius: 0px`, `background-color: rgba(0,0,0,0)` — no box of its own, on every kind | **met** — the second, smaller highlight inside the first is gone |
| **B5** Grip left edge at **row left + 6px**, inside the label cell's padding | as stated | Property grip x 1185, row x 1181 → **row left + 4px** (the row's own `px-1`) | −2px; same idea | Grip box x 1185 against row x 1179 → **row left + 6px** | **met** |
| **B6** `cursor: grab`; **`grabbing` only once the drag starts**, on the dragged subtree, not on `body`; no `:active { grabbing }` | as stated | `cursor: grab` on the grip ✅. No `:active` rule ✅. **But `grabbing` is never applied at all** — measured mid-drag on O1 and O5, the grip still computed `grab` and `body` computed `auto`. The single exception is `TableView`'s column-header drag, which adds `body.cb-col-dragging` → `cursor: grabbing !important` on **every element on the page** (*source-derived*: `src/views/TableView.tsx:2573`, `src/styles/index.css:190`) | **No grabbing cursor on any of the six surfaces measured**, and the one place we do it is the global-`!important` opposite of what Notion does | `cursor: grab` at rest. Mid-drag on the tab strip, exactly **6 elements** compute `grabbing` — the six rows of the list being dragged — with `body` and `<html>` at `auto`, and **0** after the release | **met in shape** (inline on the gesture, never on `body`), widened from “the dragged subtree” to “the dragging list”: every row of a frozen list is under the gesture, and a cursor that changed only on the held row would flicker as it passes the others. `cb-col-dragging`'s global `!important` survives on the table's column drag for its own stated reason — but it can no longer be STRANDED, which was the actual defect |
| **B7** Block-level handle: **18 × 24, `radius 4px`**, a **20px** glyph in the dimmer icon colour, **~28px left** of a page block / **~54px left** of a table row, with a **24 × 24 `+`** beside it, the cluster fading on `opacity 0.2s ease-out` | as stated | Canvas field grip **16 × 24** at `-left-5` = **20px left** of the row's content box; canvas group grip 16 × 24, **20px left** of the block's padding box. Glyph 12px, colour `--n-400` — the **same** token as the property grip, not a dimmer one. **No `+` add-button anywhere beside a grip.** Reveal is `opacity-0 → group-hover/row:opacity-100` with `transition: all`, i.e. **no fade** | **8px too close, glyph 8px too small, no dimmer colour, no `+`, no fade** | Canvas grip **18 × 24**, `border-radius: 4px`, glyph **20px**, colour `rgb(60,67,80)` — a dimmer token than the row grip's `--n-400`; reveal `transition: opacity .2s` | **met but for the `+`**, which is **deliberately not met**: our add affordance is `layout-add-section`, a block-level control, and a per-row `+` would offer an insert the canvas has no model for |
| **B8** Accessible name states **both** jobs (`"Drag to move, click to open menu"`) | as stated | Property/tab/popover grips: `"Reorder <Name>, position N of M"`; canvas grips: `"Drag <Name>"`. Our grips do not open a menu, so there is no second job to name | **Different by design.** Ours names position, which Notion's does not; theirs names a menu we do not have here | Unchanged | **deliberately different** — ours names the position, which a keyboard user needs and Notion's does not provide; theirs names a menu we do not have here |

---

## C-I. Drag lifecycle — list reorder (our `useSortableList`)

Measured on **O1** (property rows), **O3** (popover rows) and **O4** (tab
strip). All three behaved identically apart from the axis, which is what you
would expect from one hook — the consistency is real and worth keeping.

| Requirement | Notion (measured) | Ours — **before** (`0f88358`) | Ours — **after** (re-measured 2026-08-30) | Verdict |
| --- | --- | --- | --- | --- |
| **C1** **Press alone changes nothing** — no lift, shadow, scale or cursor change; the drag begins on the first movement | verified at t+120ms | **Match.** After `pointerdown` with no move: identical `position`, `transform: none`, `opacity: 1`, `box-shadow: none`, no added nodes (1022 before and after), no class change | **Match** | Re-measured: after `pointerdown` with no move, identical `position`, `transform: none`, `opacity: 1`, `box-shadow: none`, no class change, node count **1040 → 1040** | **met** |
| **C2** A state hook on the document root (`body.is-dragging`) so other surfaces can suppress hover affordances | present, carries no CSS — a pure JS hook | **Absent.** `body.className` measured `""` for the entire gesture on all three surfaces | **Absent** | **`body.cb-dragging`**, added on the first move and removed by the release, by Escape and by an unmount alike. Carries no CSS rules — a state hook, exactly as Notion's is | **met** |
| **C3** Freeze the list: explicit pixel `height` + `position: relative` on the container; every row `position: absolute` + `transform: translateY(slot × pitch)` | as stated (347 × 266 = 7 × 38) | **Absent.** Container stayed `position: static` at its natural height (59px / 84px measured); every row stayed `position: static` with `transform: none` for the whole gesture | **Absent** | Container `position: relative` with an explicit size — `72px` on a two-row property list, `968.04px × 36px` on the tab strip — and every row `position: absolute; top: 0; left: 0` plus a transform | **met** |
| **C4** **The real row follows the cursor** 1:1, grab offset preserved, **no transition**, clamped to the list bounds | as stated | **Absent. Nothing follows the cursor.** Every row's `transform` read `none` at every sample; row `y` never changed | **Absent — this is the single biggest lifecycle gap** | 1:1 with the grab offset kept: pointer +3 / +12 / +20 gives `translate(-6px, 3px)` / `(…12)` / `(…20)`, `transition: none`, and +40 **clamps to 38** on a 72px list. On the tab strip 240px of travel gives `translate(313.36px, 0)` = its 73.36px resting offset plus 240, exactly | **met**, clamp included — the single biggest gap in the baseline |
| **C5** The dragged row keeps **opacity 1**, no shadow, no scale, no rotation, no background change; lifted by `z-index: 1` alone | as stated | **Inverted.** The source row **dims to `opacity: 0.4`** in place (`PropertyRow`'s `dragging` prop) and is never lifted — `z-index: auto`, `box-shadow: none` | **We dim what Notion moves** | `opacity: 1`, `box-shadow: none`, no scale, no rotation, `z-index: 1` | **met** — we no longer dim what Notion moves |
| **C6** Siblings animate to their new slots with `transition: transform 200ms ease` | as stated (plus width/height at 200ms) | **Absent.** Siblings do not move at all, and every row's `transition` computes to `all` — the initial value, i.e. none | **Absent** | Siblings carry `transition: transform 0.2s` and slide to their slots — measured mid-flight at 473.3 → 472.1 → … → 446 on a 28px pitch. **The freeze frame itself declares `none`** | **met**, after Task 8 fixed the freeze animating itself in — see § What the re-measure found |
| **C7** **No insertion line for this interaction.** The opened gap is the indicator; zero nodes added for the whole gesture | verified by DOM diff | **We draw a line — and it is the wrong grammar for this family.** `useSortableList.dropIndicator` writes an inline `box-shadow: inset 0 2px 0 var(--cortex-500)` (measured `rgb(61,91,222) 0px 2px 0px 0px inset`) on the target row's **top edge**, or `inset 0 -2px 0` on the last row for a past-the-end drop; the horizontal axis writes `inset 2px 0 0` / `inset -2px 0 0`. **2px**, full row width, opacity 1, radius 0, **no transition**. Node count unchanged (1022) — the line is a shadow, not an element | **Present where Notion has none.** Also *inset*, so it eats the target's own first 2px rather than sitting in the gap | Node count unchanged for the whole gesture (**1040 → 1040** property rows, **1929** tab strip) and `box-shadow: none` on every row. `dropIndicator` is gone from the hook, not restyled | **met** |
| **C8** Swap threshold: the **dragged row's midpoint** crossing the neighbour's leading edge (17px of 34px overlap) — not the pointer | flip at `translateY ≈ 22` | **Pointer-based, midpoint of the neighbour.** Midpoints are measured once at grab time; the slot is `mids.filter(m => pointerY > m).length`. Measured on a row spanning y 109–135 (mid **122**): pointer 121 → line on row 0, **122 → row 0**, **123 → row 1**. Past-the-end flip at pointer y > 155 for the row spanning 142–168 (mid 155). Strictly greater than, 1px resolution | **Different rule.** With nothing following the cursor there is no dragged-row midpoint to use, so this cannot be fixed without C4 | The **dragged row's own midpoint** against the neighbour's leading edge — the rule the moving row makes possible. On a 72px two-row list the swap lands at +38 and reverses coming back to +10 | **met** |
| **C9** On drop, strip all inline positioning **in one frame**; land in static flow already reordered; no settle animation | as stated (≤92ms unobservable) | Order commits with **no animation**: six frames sampled from t+200ms to t+283ms after `pointerup` all read the final order with `transform: none` and `transition: all`. My first sample landed at **t+200ms**, so a settle shorter than 200ms would have been missed | **Match in outcome** — but ours is a jump from a list that never moved, not a landing | The gesture ends BEFORE the commit, so the teardown strips every inline transform in the same frame the new order renders in | **met** |
| **C10** **`Escape` cancels the drag**, restoring order and stripping all drag state | verified | **Absent, and worse than absent.** Measured on O4 (a tab strip with nothing above it to unmount): after a real `Escape` mid-drag the indicator was still painted, the gesture **still tracked** the pointer (the line moved from `inset 2px 0` to `inset -2px 0` on a further move), and the release **committed the reorder** (`Board, Board copy` → `Board copy, Board`). On O1 the same keypress **closed the record detail panel** while the gesture stayed live on `window` | **Escape does not cancel; it fires the surrounding surface's own Escape handler and leaves a live drag behind** | **Escape cancels.** Tab strip: `body.cb-dragging` cleared, every row back to `position: static` / `transform: none`, the original order restored, a further `pointermove` ignored, and **the release committed nothing**. Record panel: the same key, and the panel stayed open | **met** — the correctness defect the slice exists for |

---

## C-II. Drag lifecycle — block / row reorder

Measured on **O5** (layout canvas field rows and group shells, dnd-kit +
`DropSlot`) and **O6** (board cards, dnd-kit). Table **rows** have no reorder
at all — see the note under the table.

| Requirement | Notion (measured) | Ours — **before** (`0f88358`) | Ours — **after** (re-measured 2026-08-30) | Verdict |
| --- | --- | --- | --- | --- |
| **D1** A **clone at `opacity: 0.4`**, `pointer-events: none`, no scale/rotation/shadow/background/radius follows the cursor | as stated | **Absent — there is no clone.** DOM node count measured 4477 before, 4477 after `pointerdown`, 4477 mid-drag on O5; 1345/1345/1345 on O6. `DragOverlay` is used nowhere (`grep`: zero call sites) | **Absent on both surfaces** | A `drag-ghost` clone at `opacity: 0.4`, `pointer-events: none`, `box-shadow: none`, `border-radius: 0px`, transparent background. Node counts: canvas **4505 → 4535**, board **1453 → 1467**, dashboard **932 → 964** | **met**, on all three block surfaces |
| **D2** The clone is laid out at the source's page coordinates in a drag layer and moved by `transform: translate3d(dx, dy, 0)` on its wrapper — the raw pointer delta, so the grab point stays under the pointer | as stated | **O5: nothing moves at all.** Source `transform: none`, grip `transform: none` for the whole gesture. **O6: the REAL card moves** — inline `transform: translate3d(300px, 60px, 0)` measured against a 300/60 pointer delta, exact 1:1, `transition: all` (none) | O5 absent; **O6 uses Notion's *C-I* mechanism on a C-II-shaped surface** | Laid out at the source's page coordinates (`top: 242px; inset-inline-start: 397px; width: 646px; height: 34px`) inside a `position: fixed` `drag-layer` at `z-index: 1050`, moved by `translate3d` on its wrapper: 30 / 60 / 90 of pointer travel gives `matrix(1,0,0,1,0, 30 / 60 / 90)` | **met** |
| **D3** **The source stays put at full opacity** — it does not dim, ghost or collapse | verified | **Inverted on both.** O5 source `opacity: 0.6` (inline). O6 card `opacity: 0.6` + `z-index: 20`, and it is the same element that is moving — so the thing under the cursor is a 60%-opaque original with an empty hole left behind it | **We dim the source instead of cloning it** | Every source measured `opacity: 1`, `transform: none`, `z-index: auto` mid-drag — canvas, board and dashboard alike | **met** — the board card is no longer both the ghost and the source |
| **D4** Insertion line **4px**, `rgba(35,131,226,0.43)`, `radius 0`, `z-index: 88`, `pointer-events: none` | as stated | **O5: a slot BAR, not a line.** `DropSlot` is a real element that exists at rest and paints when hovered: `height: 6px` (row slots) or **12px** (block slots), full container width, `background: var(--cortex-500)` = `rgb(61,91,222)` at **opacity 1**, `border-radius: 0px` measured, `z-index: auto`, no `pointer-events` override, **no transition**. **O6: no line at all** — the drop indicator is a whole-column background wash `var(--cortex-50)` = `rgb(27,37,71)` over a measured 280 × 2040 area, `radius 10px`, no transition | **1.5–3× too thick, fully opaque instead of 43%, and on the board there is no line at all** | 4px, `oklab(0.528925 -0.00497451 -0.202081 / 0.43)` = `--cortex-500` at **43%**, `border-radius: 0px`, `z-index: 88`, `pointer-events: none` | **met** — the shape and the alpha, in our accent |
| **D5** The line is a **child of the target**, `inset-inline: 0`, so it inherits the target's width and indent | as stated (720 / 682 / 2052px measured for three different targets) | **Sibling, not child.** The `DropSlot` is a flex sibling *between* rows inside the group container: measured x 397 w 646 for every row slot, against the block's own 384/672 — one fixed width per container, blind to the target row's own box. `AreaDrop` targets instead wear a whole-container `ring-1 ring-cortex-500` | **Absent.** A nested or indented target gets the same full-width bar | A **child of the target** with `inset-inline-start/end: 0px`: 670px inside a 672px block, 646px inside a 646px row, and 4 × **1009px** down a board column's own height | **met** |
| **D6** Above = `top: -4px`; below = `bottom: -4px` | as stated | **N/A** — there is no above/below on a slot that *is* the gap. The slot occupies real layout space, which is why the rows sit 6px apart whether or not anything is being dragged | Different model | `top: -4px` above and `bottom: -4px` below on the vertical surfaces; transposed to `start`/`end` on the board and on a dashboard row | **met** |
| **D7** The line **fades in over `opacity 200ms ease`** while the previous line fades out over the same 200ms — movement between targets reads as a cross-fade | as stated, both in the DOM simultaneously | **Absent.** `transition` computes to `all` on every slot; the bar snaps on and off. Worse: sweeping the pointer at 1px resolution found **dead bands where no target is lit at all** — y 248, 249, 250 between `slot:planning:0` and `slot:planning:1`, and the same at y ≈ 280. The indicator blinks out mid-travel | **Absent, plus a 3px blind spot between every pair of slots** | `transition: transform .2s, opacity .2s, box-shadow .2s`; every line stays mounted and only `data-lit` changes, so leaving one and arriving at another IS a cross-fade. **The dead band is gone**: 151 samples at 1px across a 150px sweep lit exactly **one** line at every position — `dark: 0`, `multi: 0` | **met** |
| **D8** Optional: a 2px page-coloured cap at the line's leading end | present | **Absent** | Absent (optional) | Still absent | **deliberately not met.** Notion's cap works because its gutter is the page background. Ours would have to be three colours at once: the canvas sits in a dialog, a board line runs down a transparent column over the view ground, and a dashboard line runs inside a grid cell. A cap in any one of those is a visible notch in the other two. Marked optional in the reference; skipped with the reason |
| **D9** Above/below flips around the target's vertical midpoint | as stated | **No midpoint rule.** The target is whatever 6px slot dnd-kit's collision detection intersects. Measured hit bands at 5px resolution: 225–247 → slot 0, **248–250 → nothing**, 251–279 → slot 1, 280–284 → nothing, 285–~312 → slot 2. So a ~29px band per slot separated by a ~3px void, rather than a continuous flip | **Different rule, and it is not continuous** | Continuous, and the flip is the target's midpoint: bands −19→4, 5→44, 45→84, 85→130 on a 40px pitch, edge to edge with no gap | **met** |
| **D10** `Escape` cancels: line and ghost removed, order untouched | verified for both a block and a database row | **Half.** dnd-kit cancels correctly — measured on O6: `transform` cleared, `opacity` back to 1, no lit column, and the a11y live region announced *"Dragging was cancelled."* **But the keypress is not swallowed**: the same real `Escape` on O5 cancelled the drag **and closed the whole layout editor dialog** | Cancel works; **it takes the surrounding surface down with it** | Escape cancels and takes nothing with it. Canvas: ghost and layer removed, nodes back to **4505**, order untouched, **the layout editor still open**. Board: the live region announces “Dragging was cancelled”, the card stays in Backlog, the board still mounted. Dashboard: ghost gone, edit mode still on, widget order untouched | **met** — cancel already worked; not swallowing the surrounding surface's Escape is the new part |

**Table rows have no drag reorder** — *source-derived*, and deliberate:
`src/views/TableView.tsx:451` states that row order is the view's sort chain
and there is no stored per-row index to write to, so the row grip opens the row
menu instead. Notion's database-row handle has no counterpart here. What
`TableView` *does* drag is **column headers**, a fourth hand-rolled system with
its own pointer loop, a 5px activation threshold, and the only body-level drag
state hook we ship (`cb-col-dragging`).

---

## D. Reorder affordances beyond drag (for completeness)

| Requirement | Notion (measured) | Ours — **before** | Ours — **after** (re-measured 2026-08-30) | Verdict |
| --- | --- | --- | --- | --- |
| **No "Move up"/"Move down"** in row or block menus — reordering is drag-only | neither menu has one | **We ship them** — "Move left"/"Move right" in `RecordTabs.tsx:233`, `TableView.tsx:1679/1958`, `DashboardView.tsx:335` (*source-derived*, grep; not clicked) | Present where Notion has none. The plan already rules these stay where they are the only keyboard path | Unchanged — they stay where they are the only keyboard path, as the plan ruled | **deliberately not met**, with the reason recorded in the plan |
| A keyboard move (`⌘⇧↓` in Notion; the up binding **not measured**) | move-down verified | **`useSortableList` grips are real `role="button" tabIndex=0` controls and Arrow keys move the item one slot per press**, with focus following the row (*source-derived*: `useSortableList.ts` `onKeyDown`; not exercised live). This is **better than Notion**, which has no keyboard property reorder at all | Ours wins; do not regress it in Task 1 | **Measured live** this time rather than read from source: on a Project record, `ArrowDown` on the grip labelled “Reorder Key, position 1 of 2” moved `key` to slot 1 (`[key, state]` → `[state, key]`), focus rode the row (`document.activeElement` still the `key` grip), and `ArrowUp` restored it. `role="button"`, `tabIndex=0` | **ahead of the reference, and not regressed** — the thing the plan forbade any task from spending |
| Reorder undoable with `⌘Z` | verified in Notion | **not measured** | — | Still **not measured** | **no target** |

---

## What the re-measure found

Three things the implementation tasks could not have seen, because each one is
invisible without a browser and a frame clock. All three are fixed in this
pass; all three carry a test that fails on the shape they replace.

### 1. The C-I freeze frame animated itself in

The freeze takes every row out of flow and places it at the slot it already
occupies — the source comment says outright that "the rows land exactly where
they already were and nothing twitches". They did not. A row's computed
transform before the freeze is `none`, so declaring `transition: transform
200ms` in the SAME commit interpolates from the identity: every sibling flew
in from the container's origin over 200ms the instant a drag began.

Measured on the three-row Planning group editor. Rest: y 446 / 474 / 502.
First frame of the drag: **446 / 446 / 446** — the third row 56px above its
slot — then 446 / 446.7 / 447.4, 448 / 449.9, … reaching 468 by frame 8. On a
seven-row property panel the last row would have started 228px out of place.

The freeze frame now declares `transition: none` and the movement token
arrives on the frame after the one that painted it. That takes **two**
`requestAnimationFrame`s, not one: a callback registered during the commit
runs before that frame's paint, so priming from it would land the transition
in the very paint it exists to keep still. Re-measured: frames 1–2 read `none`
with every row at rest, frame 3 onward carries the token, and the neighbours
slide exactly as before once the held row crosses one.

### 2. The clipped-name tooltip turned itself off

Task 7 narrowed the property name box from 96px to 84px and named the
clipped-name tooltip (M16.6) as what keeps that readable. It was silent on
both of the demo vault's newly clipped labels.

`Tooltip` renders its child bare while disabled and inside a fragment once
enabled, so the name element is UNMOUNTED by the state that enables it. The
effect that measured it was keyed on the label and never re-ran across that
swap: its `ResizeObserver` went on reporting the DETACHED node, which measures
`0/0`, and the next callback set `clipped` straight back to false — for good,
because nothing would ever measure the live node again. Instrumented in the
page, the probe read `key_result_count: 103/84`, `103/84`, then `0/0`, and
`0/0` is the one that stuck.

A callback ref re-attaches per node instead.

### 3. The strip's one lit region had no timing

The strip keeps its value wash by design (see its row above), and the region
is right: label transparent, column transparent, value at `--n-50`. Its
transition computed to `all` — the initial value — while the panel's label
cell already carried the 20ms guard. A wash that exists has to be timed or it
strobes under a pointer crossing the strip.

## The 14px ruling

Task 7 set panel labels to the measured **14 / 400 / 20** while our value text
stays at 13. Notion sets both at 14 and separates them by colour; ours ends up
with the label one step ABOVE the thing it names. The reference's own "Where
copying Notion would be wrong" section predicted exactly this before the
implementation started. Task 8 owed it a look, so here is what was actually
seen.

**At 1× it does not read wrong.** `--n-500` against `--n-800` is a far
stronger cue than 1px of size, and the value still leads the row: the eye goes
to "Dana Fox", not to "Assignee". **At 2.2× the inversion is plainly
visible** — the label is the biggest text in the row and the least important
— but nobody reads a property panel at 2.2×. A/B'd in the browser by
forcing the labels to 13px and back, at both zooms.

**Ruling: it stays, as recorded debt.** Closing it properly means 14px
*values*, and that reaches every `FieldEditor` control including the grid's —
a type-ramp decision with its own measurement, not something to slip into the
tail of a drag slice. Dropping the label back to 13 is the other option and it
is worse: it would also flatten the strip's measured 13/500 against the
panel's 14/400 down to a weight difference alone.

**What the ruling did surface is the real cost of the 84px name box**, and it
is measurable rather than aesthetic. Across 30 realistic property names,
12px-in-96px clipped 2; 14px-in-84px clips 6. Across the demo vault's ten
record types and 52 live panel rows, it clips **2**: "Current value" (87 in
84) and "Key result count" (103 in 84). Both were relying on a tooltip that
did not work — finding 2 above.

## The narrow-width answers

Two questions jsdom cannot answer, both from the same change: the tab strips'
container went from `display: contents` to a real flex box, because a drag
freezes that element and positions the tabs against it and `display: contents`
has no box to do either with.

**Many tabs, narrow window.** Six views on a Work item type screen (natural
width 968px), driven at 1728 / 1400 / 900 / 620px:

| Viewport | Strip clientWidth | scrollWidth | Behaviour |
| --- | --- | --- | --- |
| 1728 | 1195 | 1195 | all six fit |
| 900 | 451 | 1030 | scrolls; tabs keep full width; trailing controls stay put outside the scroller |
| 620 | 171 | 1030 | still scrolls to the end — `scrollLeft` reached 859.5 and the last tab was reachable |

`flex-shrink: 0` on the new box is what makes that work: the group keeps its
natural width and overflows into the strip's own scroller exactly as the loose
tabs did. **At no width did the page itself scroll horizontally**
(`documentElement.scrollWidth === clientWidth` at every step), and no tab was
squashed. A drag at 1400px behaved identically to one at 1728: freeze frame at
rest with `transition: none`, 240px of travel giving `translate(313.36px, 0)`,
and Escape restoring the order.

**The 84px name box.** Answered above: acceptable in practice at 2 rows in 52,
now that the tooltip covering them works.

---

## Biggest gaps, ranked by how much they change the feel

**This section is the BEFORE state, kept as written.** It is what the baseline
ranked on 2026-08-29 and the order the plan built in; every numbered item
below is now met, and the "after" column of each table says how. It stays
because the ranking was the argument for the build order, and an argument that
gets deleted once it works cannot be checked.

1. **Nothing follows the cursor in a list reorder (C4/C5).** The dragged row
   dims in place and stays in the flow while a hairline appears somewhere else.
   There is no object in the gesture — the user is not moving a thing, they are
   nudging a cursor at a list and reading a 2px hint. Every other C-I delta is
   downstream of this one: with no moving row there is no grab offset to
   preserve, no midpoint to threshold on, and nothing for the gap to open for.
   Fixing this alone would change the feel more than the other nine combined.
2. **Escape does not cancel a `useSortableList` drag — it fires the surrounding
   surface's Escape handler and leaves the gesture live (C10).** Measured: the
   release after Escape still committed. This is not polish, it is a
   correctness bug, and it is the one that will actually lose a user's work.
   It also explains a class of "the app did something I didn't ask for".
3. **The drop indicator blinks out between targets on the canvas (D7/D9).** A
   measured 3px band where nothing is lit, twice in a 90px sweep. An indicator
   that flickers during ordinary travel reads as brokenness, not as a hint —
   and unlike the rest of C-II it costs nothing to fix (continuous
   midpoint-based resolution instead of discrete 6px hit targets).
4. **Nothing has a transition — anywhere.** Every `transition` I measured, on
   every surface, computed to `all` (the initial value): the icon↔grip swap,
   the row hover wash, the slot bar, the column wash, the sibling reflow that
   does not exist. Notion declares `20ms` on hover and `200ms` on movement.
   Twenty milliseconds is not a fade, it is an anti-flicker guard; 200ms is
   what makes reflow read as motion instead of teleportation. This is the
   cheapest large win in the slice.
5. **We light two or three regions per row hover (A6).** The row wash plus the
   value control's own wash plus the label's own wash. Notion lights exactly
   one small region. Ours reads as "three buttons here" on every pointer pass
   down a property list, which is a constant low-grade noise the user feels
   without being able to name.
6. **Board cards use a third grammar (D2/D3).** The real card translates at 1:1
   *and* dims to 0.6 *and* leaves a hole, and the drop target is a
   2040px-tall column wash with no position in it. Two of Notion's grammars
   got crossed here. Whatever we pick, the card should stop being both the
   ghost and the source.
7. **Four grip geometries for one affordance (B1/B3).** 13 × 13 in-place,
   16 × 24 gutter, 12 × 16 in-flow, 10 × 28 overlay — all with the same glyph
   and the same colour token at four sizes. None of them shift layout, which is
   the important part, so this is a consistency and hit-target problem rather
   than a jank problem: the 13 × 13 property grip is a **169px²** target
   against Notion's **432px²**.
8. **Row anatomy numbers (A1/A2/A5/A8).** 33px vs 38px pitch, 116 vs 120,
   12px vs 14px labels, and the value's 8px radius against the label's 6px —
   the inverse of Notion's hierarchy. Real, and worth doing, but a user feels
   these as "a bit tight", not as "bad to use". Do them last.

**The good news, so Task 1 does not throw it away:** press-alone-changes-nothing
already matches (C1); the property grip already replaces the icon in place with
no layout shift (B1) — the plan's premise that a `-left-5` gutter grip is why
rows shift is **false for property rows** and true only for the canvas;
grip reveal is already row-scoped (B2); the hover gap is already outside the
hover target (A1); the empty state is already the literal word "Empty" with
identical geometry (A7); and our grips are keyboard-operable, which Notion's
property rows are not.

---

## Where copying Notion's numbers would be wrong for us

**Every bullet here was honoured, and the one it got wrong is the 14px label —
which this document warned about before a line was written and which Task 8
then had to rule on live.** That is the strongest argument in either document
for writing the "would be wrong" list BEFORE building: it was right, in
advance, about the one number that came out inverted.

- **The hover wash `rgba(255,255,255,0.055)` is a translucency, ours is a
  token.** Notion composites white over whatever is behind; our `--n-25`
  through `--n-100` are opaque steps in a designed neutral ramp. Porting the
  rgba literal would put an undesigned colour on our surfaces and would break
  the moment a row sits on a non-default background. Take the *relationship*
  (label lights, value does not; one region, not three) and the *timing*
  (20ms), and spend our own tokens for the colour.
- **`rgba(35,131,226,0.43)` is Notion blue.** Our accent is `--cortex-500`
  `#3d5bde`. Take the **4px / radius 0 / 43% alpha / z-index 88 /
  pointer-events none** shape and the child-of-target positioning; do not take
  the hex. The 43% matters — our slot bar is currently 100% and reads as a
  painted block rather than a hint.
- **The 2px page-coloured end cap** (`--c-bacPri`) only works because Notion's
  gutter is the page background. Ours is a bordered shell inside a dialog on
  the canvas; a cap in `--n-0` would be a visible notch of the wrong colour.
  It is marked optional in the reference — skip it unless the gutter case
  actually arises.
- **14 / 400 / 20 labels are Notion's type scale.** Our DS ramp is
  `--fs-xs 12px` / `--fs-sm 13px` / `--fs-md 14px` with its own line heights,
  and 14px labels next to 13px values would invert *our* hierarchy while
  matching theirs. The portable claim is **the strip label is smaller and
  heavier than the panel label** (13/500 vs 14/400) — we currently make them
  identical, and that is the real defect. Fix the differentiation, choose the
  sizes from our ramp.
- **38px pitch / 120px label column** are sized for 14px text and a 34px
  control. Our controls are 26px. Adopting 38px without adopting the type
  scale would just add 12px of air per row. Pitch should follow whatever
  control height Task 4 lands on, and the *rule* to keep is 34 + 4 in shape:
  content box plus an outside gap, never a padded box.
- **`body.is-dragging` carries no CSS in Notion** — it is a state hook others
  read. Do not add rules to it and then claim parity; and do not follow
  `cb-col-dragging`'s `cursor: grabbing !important` on every element, which is
  the loud version of the thing Notion deliberately does quietly on the
  dragged subtree only.
- **Notion's grip has no keyboard path.** Ours does, and it is better. "Match
  Notion" must not be read as licence to drop `role="button"`, `tabIndex=0`,
  the Arrow-key handler or the position-announcing label.

---

## What I could not measure, and why

| Item | Before | After |
| --- | --- | --- |
| Focus ring on our property **value** control | Not attempted; focusing a value opens its editor popover, and the ring was not on the checklist's measured side either | **Still not measured, and deliberately.** Notion's side was never measured either, so there is no target to match — inventing one here would put a number in a parity document that parity did not ask for |
| **Light-theme** values for anything above | The app was in dark mode, matching the Notion pass; switching would have made the two documents incomparable | Unchanged, for the same reason. Both runs are dark |
| Whether `⌘Z` undoes a reorder | Not attempted | Still not attempted — out of the slice |
| Our **keyboard** reorder actually working end to end | Read from `useSortableList.ts`; labelled source-derived, not exercised in the browser | **Now measured.** `ArrowDown` on a Project record's "Reorder Key, position 1 of 2" moved `key` to slot 1, focus rode the row, `ArrowUp` restored it |
| A settle animation shorter than **200ms** after a C-I drop | My first post-`pointerup` sample landed at t+200ms | **Answered by construction, not by sampling**: the gesture ends before the commit, so the teardown strips every inline transform in the frame the new order renders in. There is nothing left to settle |
| `DashboardView`'s widget drag | Not driven. Source shows the same `DropSlot`/dim-the-source idiom as O5 (*source-derived*), but no number here is measured from it | **Now driven** (O7): ghost at 0.4, source at `opacity: 1`, a 4px 43%-accent line at `z-index: 88` inside the target, and Escape cancelling with the widget order untouched |
| `TableView`'s **column-header** drag lifecycle | Out of the slice's scope; only its `body.cb-col-dragging` hook is reported, and that is source-derived | Still not driven as a lifecycle. What DID change is source-verified and named in the B6 row: the hook can no longer be stranded on `<body>` by an unmount or by Escape |
| The exact width of the canvas dead band beyond 1px | Swept at 1px; the band read as exactly y 248–250, but the collision test runs against a translated 16 × 24 rect, so the number is specific to that grab point | **Moot.** The discrete 6px slots are gone; a 1px sweep of 151 positions across 150px found no dark sample at all |

## Disclosure — what these measurements changed

Both runs went against the **browser mock backend** over an in-memory copy of
`demo-vault`; `git status` was clean before and after each, and no file on disk
was written.

The 2026-08-29 run committed one property-row reorder on a Project record
(Key ↔ State), one tab reorder on a duplicated view, and created one duplicate
view ("Board copy").

The 2026-08-30 run created six views on the Work item type (five named views
plus "Ops dashboard") and three dashboard widgets, and staged one field
reorder in the layout editor — which was **discarded** through the editor's own
"Discard layout changes?" dialog rather than applied. Everything else was a
drag that was cancelled or released where it started. All of it was needed to
measure a strip with many tabs, a third C-II caller, and Escape on three
surfaces; all of it lived in memory and left with the page.
