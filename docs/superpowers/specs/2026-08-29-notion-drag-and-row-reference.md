# Notion's drag grammar and property-row anatomy — measured

**Measured** 2026-08-29 against the live Notion web app (`app.notion.com`) in the user's
logged-in Chrome, through the Chrome DevTools MCP bridge.

**Theme**: dark (`body.notion-body.dark.notion-dark-theme`). **Every colour below is a
dark-theme value.** Light-theme equivalents are *not measured*.
**Viewport**: 1728 × 936 CSS px, devicePixelRatio 2.

**Surfaces**

| # | Surface | What it gave |
| --- | --- | --- |
| S1 | A record page's **horizontal property strip** (label above value, under the title) | strip anatomy |
| S2 | The same record's **"Properties" details side panel** (vertical label ǀ value rows) | the canonical property-row anatomy, the grip, and drag lifecycle I |
| S3 | The record's **page body blocks** (text / heading / to-do) | the gutter drag handle and drag lifecycle II |
| S4 | A **database table view** (3 rows) | database-row handle; confirms lifecycle II |

**Method**

- Geometry and styling: `evaluate_script` reading `getBoundingClientRect()` and
  `getComputedStyle()` on live nodes, plus the literal declaration text walked out of
  `document.styleSheets` (Notion ships atomic single-declaration classes, so the rule text
  is the spec).
- `:hover` states: real CDP `hover` (Notion's DOM is opaque to the a11y tree in the editor,
  so the target was temporarily given `role`/`aria-label`, hovered, then untagged).
- Drags: synthetic `PointerEvent`/`MouseEvent` sequences (`pointerdown` → `pointermove`… )
  dispatched at the handle. These *do* drive Notion's drag machinery, which let me hold a
  drag open across tool calls and read computed styles at each stage. Every drag was ended
  with a real `Escape` keypress or a drop back at the origin.
- All numbers below were read off the DOM mid-gesture. Anything not read is written
  **not measured** — there are no plausible-looking guesses in this document.

**Privacy**: no record titles, people, dates or field values are reproduced. Screenshots
were taken with a temporary redaction stylesheet applied (all text `color: transparent`
plus a heavy `text-shadow` blur), removed afterwards.

> **⚠ Changes to the user's workspace — read this.** See
> [§F Disclosure](#f-disclosure--what-changed-in-the-workspace) at the end. Two changes I
> made were detected and restored; one difference I could not attribute is flagged for the
> user to check in Notion's version history.

---

## A. Property row anatomy

### A.1 The vertical property row (details side panel, S2) — the canonical form

Structure per row:

```
row wrapper  38px            cursor: grab
└─ row       34px  flex-row  margin: 0 0 4px
   ├─ label column   120px   flex-shrink: 0, align-items: center
   │  └─ [role=cell]         padding 0 6px, radius 6px
   │     └─ inner  flex, gap 6px
   │        ├─ icon slot 18×24  display:grid   ← icon and grip stack here
   │        └─ label text
   └─ value column   223px   margin-left: 4px, flex-grow: 1
      └─ [role=button]       padding 6px, radius 4px, min-height 34px
```

| Part | CSS property | Measured value |
| --- | --- | --- |
| Row wrapper | `height` | `38px` |
| Row wrapper | `display` / `flex-direction` | `flex` / `column` |
| Row wrapper | `cursor` | `grab` (inline, written by Notion) |
| Row content | `height` | `34px` |
| Row content | `margin` | `0px 0px 4px` |
| Row content | `position` | `relative` |
| Row pitch | — | **38px** (34 + 4). Rows measured at y = 84, 122, 160, 198, 236, 274, 312 |
| Label column | `width` | `120px`, `flex-shrink: 0` |
| Label column | `align-items` | `center` |
| Label cell | `role` | `cell` |
| Label cell | `height` | `34px` (fills the row) |
| Label cell | `padding` | `0px 6px` |
| Label cell | `border-radius` | `6px` |
| Label cell | `cursor` | `pointer` |
| Label cell | `transition` | `background 20ms ease-in` (`background 0.02s ease-in`) |
| Label cell | `user-select` | `none` |
| Label cell | `max-width` | `100%` |
| Label cell | `color` | `rgb(173, 169, 163)` = `--c-texSec` `#ada9a3` |
| **Label cell :hover** | `background-color` | **`rgba(255, 255, 255, 0.055)`** — read live under a real CDP hover as `color(srgb 1 1 1 / 0.054902)`. Rule: `.xdxgbl4:hover { background: var(--x-umghl) }` |
| **Label cell :active** | `background-color` | **`rgba(255, 255, 255, 0.11)`** — *derived*, not observed live. Rule `.xayv9eh:active { background: var(--x-ph3bdx) }` where the var is the same base colour with `calc(alpha * (1 + 0.5 * 1 * 2))`, i.e. ×2 |
| Label inner row | `display` / `gap` | `flex` / `6px` |
| Icon slot | `width` × `height` | `18px × 24px`, `display: grid`, `place-*: center` |
| Icon glyph | box | `16px × 16px`, `mask-image: url(…/icons/<type>_gray.svg?mode=dark)`, `background-color: rgb(173,169,163)`, `transform: scale(1.2)` → **painted 19.2 × 19.2** |
| Icon → label text gap | — | **6px** (slot right edge 1390 → text left 1396) |
| Label text | `font-size` / `font-weight` / `line-height` | `14px` / `400` / `20px` |
| Label text | `letter-spacing` | `normal` |
| Label text | `color` | `rgb(173, 169, 163)` |
| Label text | `white-space` / `overflow` / `text-overflow` | `nowrap` / `hidden` / `ellipsis` |
| Font family | `font-family` | `ui-sans-serif, -apple-system, "system-ui", "Segoe UI Variable Display", "Segoe UI", Helvetica, "Apple Color Emoji", …` |
| **Label → value gap** | `margin-left` on value column | **`4px`** (label column ends 1486, value column starts 1490) |
| Value column | `width` | `223px`, `flex-grow: 1` |
| Value cell | `min-height` / `height` | `34px` / `34px` |
| Value cell | `padding` | `6px` (some types `5px 6px`) |
| Value cell | `border-radius` | `4px` |
| Value cell | `cursor` | `pointer` |
| Value cell | `transition` | `background 20ms ease-in` |
| Value cell | `overflow` / `position` | `hidden` / `relative` |
| **Value cell :hover** | `background-color` | **`rgba(0, 0, 0, 0)` — there is none.** Verified with `:hover` true under a real hover. The value cell carries only `x87ps6o x1b7c0jy x1ypdohk`; the hover-background class `xdxgbl4` is on the **label cell only** |
| Value text, filled | `color` / `font` | `rgb(240, 239, 237)` (`--c-texPri` `#f0efed`) / `14px` `400`, `line-height 21px` |
| Value text, empty | `color` / `font` | `rgb(125, 122, 117)` / `14px` `400`, `line-height 20px`; literal string **"Empty"** |
| Empty vs filled | — | Only the string and its colour change. Padding, radius, min-height and hover behaviour are identical |
| Value cell focus ring | — | **not measured** — clicking a value opens its editor popover, which mutates. See the ring vocabulary below |

Notion's focus-ring vocabulary, read out of the stylesheets (not observed on a property
value cell):

| Selector | Declaration |
| --- | --- |
| `*, :focus` | `outline: 0px` — the global reset; Notion never uses the UA outline |
| `.notion-focusable-within:focus-within` | `box-shadow: rgb(35,131,226) 0 0 0 1px inset, rgb(35,131,226) 0 0 0 1px !important` — 1px inside + 1px outside, no offset |
| `.notion-focusable-token:focus-visible` | `border-radius: 3px; outline: none; box-shadow: 0 0 0 2px var(--c-bacPri), 0 0 0 4px #2383e2 !important` — a 2px page-coloured gap then a 2px blue ring |
| `.x1w79tpz:focus-visible` | `outline: 2px solid var(--c-bluBorAccPri)` |
| `.xmnxftk:focus-visible` | `outline: 1.5px solid var(--c-bluBorAccPri)` |
| `.xi3px66` | `box-shadow: 0 0 0 2px var(--c-bluBorAccPri)` |

### A.2 The horizontal property strip (record page, S1)

The same anatomy folded 90°: label row on top, value row beneath, columns side by side in a
horizontal scroller.

| Part | CSS property | Measured value |
| --- | --- | --- |
| Scroller | `overflow` | `auto hidden`, class `.notion-scroller.horizontal.hide-scrollbar`, `height: 54px` |
| Strip | `display` / `gap` / `min-width` | `flex` (row) / `8px` / `max-content` |
| Column | `flex-direction` | `column`, `min-width: 80px`, `max-width: 200px`, `height: 54px` |
| Label cell | `height` / `padding` / `border-radius` | `24px` / `0px 6px` / `6px` |
| Label inner | `gap` | **`2px`** (vs `6px` in the side panel) |
| Icon slot | — | `18 × 24`; glyph `14 × 14` with `transform: scale(1.2)` → painted **16.8 × 16.8** |
| Label text | `font-size` / `font-weight` / `line-height` | **`13px` / `500` / `18px`** (vs 14/400/20 in the panel) |
| Label text | `color` | `rgb(173, 169, 163)` |
| Value cell | `height` / `min-height` | `30px` / `30px` |
| Value cell | `padding` | `4px 6px` (`5px 6px` on some types) |
| Value cell | `border-radius` | `4px` |
| Label row → value row | — | 24px then 30px, no gap; 54px total |

### A.3 Theme tokens seen through these components

| Token | Dark value |
| --- | --- |
| `--c-texPri` | `#f0efed` |
| `--c-texSec` | `#ada9a3` |
| `--c-icoPri` | `#e6e5e3` |
| `--c-icoSec` | `#ada9a3` |
| `--c-bacPri` | `#191919` (light: `#fff`) |
| `--c-bacSec` | `#202020` |
| `--c-bluBorAccPri` | `#2783de` |
| `--c-bluBacAccPri` | `#2783de` |
| `--ca-bacSecTra` | `rgba(252,252,252,.03)` |
| `--ca-borSecTra` | `rgba(255,255,243,.082)` |
| `--ca-borStrTra` | `rgba(255,252,235,.306)` |

---

## B. The drag grip

### B.1 The property grip (S1, S2) — it *replaces the type icon*

This is the finding that matters most: **Notion does not put a grip in a gutter next to the
property row. The grip occupies the property-type icon's own slot.** The two are stacked in
one `display: grid` cell (`grid-area: 1 / 1`) and cross-fade.

| Property | CSS property | Measured value |
| --- | --- | --- |
| Slot | `width` × `height` | `18px × 24px`, `display: grid`, centred |
| Icon layer | `opacity` at rest / hovered | `1` → `0` |
| Grip layer | `opacity` at rest / hovered | `0` → `1` |
| Both layers | `transition` | **`opacity 0.15s`** (no timing function declared → `ease`) |
| Grip wrapper | `display` / `align-items` / `justify-content` | `flex` / `center` / `center` |
| Grip wrapper | `cursor` | **`grab`** — rule `.xq56vqb { cursor: -webkit-grab }` |
| Grip wrapper | `background-color` | `rgba(0,0,0,0)` at rest **and on hover** |
| Grip wrapper | `border-radius` | `0px` |
| Glyph | element | `<svg viewBox="0 0 16 16" class="dragHandleFillSmall">`, box `16 × 16` |
| Glyph | geometry | six dots, `r = 1.2`, at x = 6 / 10 and y = 3.2 / 8 / 12.8 → a 2 × 3 grid; **painted path bbox 6.4 × 12px** |
| Glyph | colour | `--x-fill: var(--c-icoSec)` → `rgb(173, 169, 163)` |
| Offset from row's left edge | — | **+6px** — grip x 1372, row x 1366. It sits *inside* the label cell's `padding-left: 6px`; there is no outer gutter |
| Hover highlight | — | belongs to the **label cell** (`border-radius: 6px`, `rgba(255,255,255,.055)`, `transition: background 20ms ease-in`), not to the grip |
| Hover **scope** | — | the whole **row**: the grip stayed at `opacity: 1` while the pointer was over the value cell 100px away |
| Cursor on press | — | still `grab`. There is **no `:active { cursor: grabbing }`** on the property grip |
| Cursor during drag | — | `grabbing`, written **inline** by JS onto the list rows — not via a class |

### B.2 The block / database-row handle (S3, S4) — a different, larger primitive

| Property | CSS property | Measured value |
| --- | --- | --- |
| `aria-label` | — | **`"Drag to move, click to open menu"`** |
| Size | `width` × `height` | `18px × 24px` |
| `border-radius` | | `4px` (the property grip has `0px`) |
| `transition` | | `background 20ms ease-in`; hover/active backgrounds via `.xdxgbl4:hover` / `.xayv9eh:active` (same tokens as A.1) |
| `cursor` | | `grab` |
| Glyph | element | `<svg class="dragHandle">`, box `20 × 20`; painted path bbox `7.5 × 14.5px` |
| Glyph | `color` | `rgb(125, 122, 117)` — **dimmer** than the property grip's `rgb(173,169,163)` |
| Position, page block | — | handle x `418.5`, block box left `447` → **28.5px left of the block**, 10.5px of clear space between handle and content |
| Position, database row | — | handle x `312`, row left `366` → **54px left of the row**, in the table's outer gutter |
| Sibling control | — | `.notion-block-add-button`, `24 × 24`, `border-radius: 4px`, immediately to its left, `aria-label` `"Click to add below. Option-click to add a block above"` |
| Gutter menu container | `transition` | **`opacity 0.2s ease-out`** (the whole handle+plus cluster fades in) |
| Reveal | — | requires a *real* pointer over the row; the fade is JS-driven |

---

## C. The drag lifecycle

**There are two different grammars in the same app.** Property rows reflow with transforms
and show no indicator at all; blocks and database rows use a translucent clone plus a blue
insertion line. Do not assume one from the other.

### C-I. Property rows (S2) — transform reflow, no ghost, no line

**1. On press (before movement)** — *nothing happens.* No new DOM nodes, no class change on
`body`, no opacity/scale/shadow change on the row, cursor stays `grab`. Measured 120ms after
`pointerdown`.

**2. On the first movement**

| What | Measured |
| --- | --- |
| `document.body` `class` | gains **`is-dragging`** at ≈154ms. **No CSS rule anywhere in the loaded stylesheets matches `.is-dragging`** — it is a pure JS/state hook |
| List container | frozen: `margin: 0; position: relative; z-index: 1; width: 347px; height: 266px` (= 7 rows × 38px) |
| Every row wrapper | `position: absolute; width: 347px; height: 38px; cursor: grabbing;` `transform: translateX(calc(var(--direction, 1) * 0px)) translateY(<slot>px)` |

**3. During drag — what follows the cursor is the REAL element**

| What | CSS property | Measured |
| --- | --- | --- |
| Dragged row | `transform` | `translateY(<px>)`, tracking the pointer **1:1** and preserving the grab offset. Grab offset 17px; pointer y 105 → row top 88, 118 → 101, 122 → 105, 126 → 109. Clamped to the list's top edge (pointer 95 and 101 both → row top 84) |
| Dragged row | `transition` | **none** (`all`, i.e. the initial value) — it does not lag the cursor |
| Dragged row | `z-index` / `left` | `1` / `0px` |
| Dragged row | `opacity` | **`1`** |
| Dragged row | `box-shadow` | **`none`** |
| Dragged row | `transform` scale/rotate | **none** |
| Dragged row | `background-color` / `border-radius` | unchanged (`rgba(0,0,0,0)`; the inner label cell keeps its `6px`) |
| Dragged row descendants | all of the above | unchanged — checked 8 descendants: no background, no shadow, no opacity, no transform |
| Source | — | there is no separate source: the real row *is* what moves. Nothing dims and nothing collapses |
| Sibling rows | `transform` | `translateY` in **38px** steps, opening the gap |
| Sibling rows | `transition` | **`width 200ms ease, height 200ms ease, transform 200ms ease`** |

**4. The drop indicator — there isn't one.** No line, no separate gap element. The gap *is*
the sibling that has already animated out of the way. Confirmed by a DOM diff: **zero nodes
were added** for the entire gesture.

**5. Reorder threshold** — the swap fires when the dragged row overlaps its neighbour by
**more than half the row's content height (17px of 34px)**; equivalently, when the dragged
row's vertical midpoint crosses the neighbour's leading edge.

| dragged `translateY` | dragged content top | its midpoint | neighbour slot top | swapped? |
| --- | --- | --- | --- | --- |
| 19 | 103 | 120 | 122 | no |
| 21 | 105 | 122 | 122 | no |
| **23** | **107** | **124** | **122** | **yes** |
| 25 | 109 | 126 | 122 | yes |

Flip lies at `translateY ≈ 22` (2px sampling granularity).

**6. On drop** — `mouseup`. `is-dragging` is removed from `body` and **all inline
positioning is stripped in the same frame**: rows return to static flow, already in the
committed order, with only `display: flex; flex-direction: column; cursor: grab` left
inline. **No settle/FLIP animation was observed** — no transition properties remained.
*Resolution caveat*: my first post-`mouseup` sample was at t = 92ms, so an animation shorter
than 92ms could have been missed.

**7. On Escape** — **cancels cleanly.** `is-dragging` removed, every inline transform and
`position: absolute` stripped, rows back in their **original** order, nothing committed.
Verified by reading the row order before and after.

### C-II. Blocks and database rows (S3, S4) — cloned ghost + blue insertion line

**1. On press** — nothing (same as C-I). `is-dragging` appears on `body` on the first move.

**2. During drag — a CLONE follows the cursor**

The clone is mounted in a drag layer appended at the end of `<body>`:

```
div  position: relative; width: 100vw; height: 0          ← layer
└─ div  display: contents
   └─ div  position: absolute; top: 0; inset-inline-start: 0;
           transform: translate3d(<dx>px, <dy>px, 0)      ← the pointer DELTA
      └─ div  position: absolute;
              top: <source y>px; inset-inline-start: <source x>px;
              width: <source w>px; height: <source h>px;
              opacity: 0.4; pointer-events: none          ← the clone
         └─ …a full copy of the block/row subtree…
```

| What | CSS property | Measured value |
| --- | --- | --- |
| What follows the cursor | — | **a clone**, not the real element |
| Ghost | `opacity` | **`0.4`** |
| Ghost | `transform` | **`none`** — no scale, no rotate. The *wrapper* carries `translate3d(dx, dy, 0)` |
| Ghost | `box-shadow` | **`none`** |
| Ghost | `background-color` | `rgba(0, 0, 0, 0)` |
| Ghost | `border-radius` | `0px` |
| Ghost | `z-index` | `auto` — it is simply the last thing in the DOM |
| Ghost | `pointer-events` | `none` |
| Offset from cursor | — | **none added.** The clone is laid out at the source's exact page coordinates and then translated by the pointer delta, so the grab point stays under the pointer for the whole gesture |
| Source element | `opacity` / `background` / `filter` / `visibility` | **`1` / unchanged / `none` / `visible`** — the source stays in place at full strength; it does **not** dim and does **not** collapse |
| Sizes measured | — | page block ghost `720 × 40`; database row ghost `2052 × 37` |

**3. The drop indicator — a LINE, not a gap**

It is a child of the *target* block/row, so it inherits that target's width and indent.

| What | CSS property | Measured value |
| --- | --- | --- |
| Thickness | `height` | **`4px`** (horizontal); the vertical variant is `width: 4px` |
| Width | `inset-inline` | `0px` → spans exactly the target's own box. Measured `720px` (page block), `682px` (an indented to-do — narrower *and* offset by the indent), `2052px` (table row) |
| Colour | `background` | **`rgba(35, 131, 226, 0.43)`** (= `#2383E2` at 43%) |
| `border-radius` | | **`0px`** |
| Insert **above** | `top` | **`-4px`** — the line sits 4px *above* the target's box |
| Insert **below** | `bottom` | **`-4px`** — the line sits at the target's bottom edge |
| Column / side drop | `top` + `bottom` + `width` | `top: 0; bottom: 0; width: 4px` on the block's leading edge, full block height |
| `z-index` | | **`88`** |
| `pointer-events` | | `none` |
| Animates in | `transition` | **`opacity 200ms ease`**, `0 → 1`. Caught mid-transition at `0.802865` |
| Animates out | — | the previous line is **not removed**; it fades to `opacity: 0` on the same 200ms while the new one fades in. Both were in the DOM simultaneously |
| End cap | — | a `2px × 4px` child with `inset-inline-start: -2px`, `background: var(--c-bacPri)` (= `#191919` dark / `#fff` light) and `transform: translateZ(100px)` — a page-coloured notch that insets the line's leading end by 2px |

**4. Threshold** — measured on a 58px heading block spanning y 573–631 (midpoint 602), with
the pointer held at x = 600:

| pointer y | position within block | indicator |
| --- | --- | --- |
| 580 | 12% | `top: -4px` (above) |
| 590 | 29% | `top: -4px` (above) |
| 600 | 47% | **vertical `width: 4px` column indicator** |
| 620 | 81% | `bottom: -4px` (below) |

So the above/below flip is around the block's vertical midpoint, but there is a **middle
band that converts the drop into a column split** instead. The exact band boundaries are
**not measured**.

For database rows the line was seen snapping between row boundaries with the same
cross-fade, but my sampling was too coarse to pin the flip point: **not measured**.

**5. On drop** — **not measured.** I never committed a block or database-row drop
(committing would have reordered the user's page). The settle behaviour for lifecycle II is
therefore unknown.

**6. On Escape** — **cancels cleanly.** Verified for both a block drag and a database-row
drag: `is-dragging` cleared from `body`, indicator element count `0`, ghost element count
`0`, and the block order (8 blocks) and row order (3 rows) read back **identical** to before
the gesture.

**Cursor during drag**: `document.body` and `document.documentElement` both computed
`cursor: auto`. The `grabbing` cursor comes from **inline styles written onto the dragged
subtree**, not from a body-level class.

---

## D. Reorder affordances beyond drag

**Block menu** (click the ⠿ handle — its own `aria-label` says "click to open menu"). Exact
labels, in order:

> Turn into · Color · Copy link to block `⌘⌃L` · Duplicate `⌘D` · Move to `⌘⇧P` ·
> Delete `Del` · Comment `⌘⇧M` · Suggest edits `⌘⇧⌥X` · Present from here (Beta) `⌘⌥P` ·
> Ask AI `⌘J` · Skills

**There is no "Move up" / "Move down".** "Move to" (`⌘⇧P`) relocates the block to a
*different page*, not within the list.

**Property label menu** (click a property label in the details panel). Exact labels, in
order:

> Rename · Edit property · Comment · Property visibility · Duplicate property ·
> Delete property · Customize layout

**Again no "Move up" / "Move down".** Property reordering is drag-only.

**Keyboard**

| Gesture | Result |
| --- | --- |
| `⌘⇧↓` (`Meta+Shift+ArrowDown`) with the caret in a block | **Moves the focused block down one position.** Verified: a text block moved past the following heading, confirmed by reading block y-positions before and after |
| `⌘⇧↑` immediately afterwards | produced **no change**. Whether an up-direction shortcut exists (and whether focus is simply lost after a move) is **not measured** — the re-test was blocked by the harness |
| `⌘Z` | undid the block move and restored the original order exactly |
| Keyboard reordering of **property rows** | **not measured** |

---

## E. Screenshots

All three are in `m46-notion-reference/`, taken with the redaction stylesheet applied and
cropped to the surface (no page title, no sidebar content).

| File | What it shows |
| --- | --- |
| [`01-property-rows-rest.png`](m46-notion-reference/01-property-rows-rest.png) | The details panel. Row 1 is hovered, so **its type icon has been replaced in place by the six-dot grip**; rows 2–7 are at rest showing their type icons. Reads the 38px row rhythm, the 120px label column, the 4px label→value gap, and that the value column is left-aligned at a fixed x |
| [`02-property-row-mid-drag.png`](m46-notion-reference/02-property-row-mid-drag.png) | Mid-drag on the same panel. The dragged row (grip visible) floats free *between* slots, overlapping its neighbour; the sibling has already translated up into slot 0. **There is no insertion line, no gap element, and no shadow on the dragged row** — this image is the evidence for §C-I.4 |
| [`03-block-drag-ghost-and-insertion-line.png`](m46-notion-reference/03-block-drag-ghost-and-insertion-line.png) | A page-block drag. The **4px blue insertion line** spanning the full block width, and the **40%-opacity clone** offset up-and-right of the still-full-strength source block |

---

## What our implementation would need

Each line is a checkable requirement. Numbers are dark-theme measurements; light-theme
values are **not measured** and must be derived from our own tokens.

### Property row (A)

- [ ] Row pitch is **38px**: 34px of content plus a 4px bottom margin — not a 38px box with
      internal padding, because the gap must not be part of the hover target.
- [ ] Label column is a **fixed 120px**, `flex-shrink: 0`; the value column takes the rest
      with `flex-grow: 1` and `margin-left: 4px`. The label→value gap is **4px**, not a
      column gap.
- [ ] Label cell: `padding: 0 6px`, `border-radius: 6px`, `cursor: pointer`,
      `user-select: none`, colour = secondary text (`#ada9a3`-equivalent).
- [ ] Label cell hover background is **`rgba(255,255,255,0.055)`** (dark) with
      `transition: background 20ms ease-in`. Twenty milliseconds — effectively instant, but
      declared, so it does not flicker on fast pointer travel.
- [ ] Value cell: `padding: 6px`, `border-radius: 4px` (**smaller than the label's 6px**),
      `min-height: 34px`, `overflow: hidden`, `cursor: pointer`.
- [ ] **The value cell has no hover background.** Only the label lights up. If we highlight
      both, the row reads as two buttons instead of one label with a value.
- [ ] Empty state is the literal word **"Empty"** in `rgb(125,122,117)`; geometry is
      unchanged from a filled cell. Never a zero, never a dash, never a collapsed row.
- [ ] Label typography **14px / 400 / 20px** in the vertical panel, **13px / 500 / 18px** in
      the horizontal strip — the strip label is smaller *and* heavier, because it is a
      column header rather than a row label.
- [ ] Label text is `nowrap` + `ellipsis`; it never wraps to a second line.
- [ ] Icon slot is **18 × 24** with the glyph at 16px scaled 1.2 (panel) or 14px scaled 1.2
      (strip); icon→text gap **6px** in the panel, **2px** in the strip.
- [ ] No focus ring is specified for the property value cell (**not measured**). If we add
      one, follow Notion's house style — `box-shadow` rings, never `outline`, at
      `0 0 0 1px inset + 0 0 0 1px` in accent blue, or an offset ring
      `0 0 0 2px <page bg>, 0 0 0 4px <accent>`.

### The grip (B)

- [ ] **The grip replaces the property's type icon in place.** Both live in one
      `display: grid` cell; icon `opacity: 1 → 0`, grip `opacity: 0 → 1`, both with
      `transition: opacity 0.15s`. Do not reserve a separate gutter column for a handle —
      the row width must not change on hover.
- [ ] Grip reveal is scoped to the **whole row**, not the label cell. Moving onto the value
      must not make the grip vanish.
- [ ] Grip slot **18 × 24**, glyph a **16px** six-dot mark (2 × 3, radius 1.2, painted bbox
      6.4 × 12), coloured with the secondary *icon* token.
- [ ] Grip has **no background and no border-radius of its own**. The hover highlight is the
      label cell's 6px-radius wash.
- [ ] Grip left edge sits at **row left + 6px** — inside the label cell's padding.
- [ ] `cursor: grab` on the grip; **`grabbing` only once the drag starts**, applied to the
      dragged subtree, not to `body`. There is no `:active { grabbing }` on press.
- [ ] For a *block-level* handle (our equivalent of a page block or table row), use the
      larger primitive: **18 × 24 with `border-radius: 4px`**, a **20px** glyph in the
      dimmer icon colour, sitting **~28px left** of a page block or **~54px left** of a
      table row, with a `+` add-button of **24 × 24** beside it, and the whole gutter cluster
      fading in on `opacity 0.2s ease-out`.
- [ ] Give the handle an accessible name that states both jobs, e.g.
      `"Drag to move, click to open menu"`.

### Drag lifecycle — list reorder, our property rows (C-I)

- [ ] **Press alone changes nothing.** No lift, no shadow, no scale, no cursor change. The
      drag begins on the first movement.
- [ ] Set a state hook on the document root (Notion uses `body.is-dragging`) so other
      surfaces can suppress hover affordances.
- [ ] Freeze the list: give the container an explicit pixel `height` and
      `position: relative`, then make every row `position: absolute` with
      `transform: translateY(slot × 38px)`.
- [ ] **The real row follows the cursor** at 1:1, preserving the grab offset, with **no
      transition** on the dragged row, **clamped to the list bounds**.
- [ ] The dragged row keeps **opacity 1, no shadow, no scale, no rotation, no background
      change** — it is lifted by `z-index: 1` alone.
- [ ] Siblings animate to their new slots with
      `transition: transform 200ms ease` (Notion also transitions `width` and `height` at
      200ms for resizing lists).
- [ ] **No insertion line for this interaction.** The opened gap is the indicator.
- [ ] Swap threshold: the dragged row's **midpoint crossing the neighbour's leading edge** —
      i.e. more than half the row height of overlap (17px of 34px). Not the pointer position,
      not the row's top edge.
- [ ] On drop, strip all inline positioning **in one frame**; the list lands in static flow
      already reordered, with no settle animation. (Anything under ~90ms would have been
      invisible to my sampling, so a very short settle is permissible, not required.)
- [ ] **`Escape` cancels the drag**, restoring the original order and stripping all drag
      state.

### Drag lifecycle — block / row reorder (C-II)

- [ ] The thing that follows the cursor is a **clone at `opacity: 0.4`**, `pointer-events:
      none`, with **no scale, no rotation, no shadow, no background, no rounded corners**.
- [ ] The clone is laid out at the source's own page coordinates inside a fixed drag layer
      and moved with `transform: translate3d(dx, dy, 0)` on its wrapper, where dx/dy is the
      raw pointer delta — so the grab point stays exactly under the pointer.
- [ ] **The source stays put at full opacity.** It does not dim, ghost, or collapse.
- [ ] Insertion line: **4px** tall, `background: rgba(35,131,226,0.43)` (accent blue at 43%),
      `border-radius: 0`, `z-index: 88`, `pointer-events: none`.
- [ ] The line is a **child of the target row**, with `inset-inline: 0` — so it inherits the
      target's width and indentation rather than a fixed list width. A nested item gets a
      narrower, indented line.
- [ ] Above = `top: -4px`; below = `bottom: -4px`.
- [ ] The line **fades in on `opacity 200ms ease`**, and the previous line **fades out over
      the same 200ms rather than being removed** — so movement between targets reads as a
      cross-fade, not a jump.
- [ ] Optional but characteristic: a **2px page-coloured cap** at the line's leading end
      (`inset-inline-start: -2px`) so the line does not butt into the gutter.
- [ ] Above/below flips around the target's vertical midpoint.
- [ ] `Escape` cancels: line and ghost removed, order untouched.

### Affordances (D)

- [ ] Do **not** add "Move up" / "Move down" to the row or block context menu — Notion has
      neither; menus carry Rename / Edit / Duplicate / Delete / visibility, and reordering is
      drag-only.
- [ ] Provide a keyboard move: Notion binds **`⌘⇧↓` to "move block down"**. The up-direction
      binding is **not measured**; if we ship `⌘⇧↑` as its inverse we are choosing it, not
      copying it.
- [ ] Reorder must be undoable with `⌘Z` (verified in Notion).

---

## What I could not measure, and why

| Item | Why |
| --- | --- |
| Focus ring on a property **value** cell | Clicking a value opens its editor popover, which mutates the user's record. The ring vocabulary in §A.1 is read from the stylesheets, not observed on this element |
| **Light-theme** colours | The workspace is in dark mode; switching the theme would change the user's setting |
| The `:active` background **observed live** | Derived from the `.xayv9eh:active` declaration and its `calc(alpha × 2)` var. Not seen on screen |
| **Drop settle** for blocks / database rows (C-II step 5) | I never committed one of those drops — committing would have reordered the user's page or database |
| Exact boundaries of the **column-split band** in the block drop zone | Sampled at four y positions only |
| The database-row above/below **flip point** | Sampling was too coarse and the hit-test lagged the synthetic pointer |
| Whether **`⌘⇧↑`** moves a block up | The re-test was blocked by the harness after the first attempt produced no change |
| Keyboard reordering of **property rows** | Not attempted — no safe way to test without committing a reorder |
| A settle animation shorter than **~92ms** after a property-row drop | My first post-`mouseup` sample landed at t = 92ms |
| `.is-dragging` styling | The class carries **no CSS rules at all** in the loaded stylesheets — it is a JS hook. (This is a measurement, not a gap) |

---

## F. Disclosure — what changed in the workspace

Three items. The first two I caused and repaired; the third I could not attribute and the
user should check it.

**1. A property was reordered, and restored.** An early probe used synthetic pointer events
to test whether Notion's drag machinery would respond. It did — silently, with no new DOM
nodes to signal it — and committed a reorder in the details panel: one property moved from
position 1 to position 3. I detected this by comparing against my first screenshots,
dragged it back to position 1, and verified the resulting order matches the original
exactly (7 properties, same sequence). **Restored.**

**2. A page block was moved by `⌘⇧↓`, and restored.** Testing the keyboard-reorder question
moved one text block down past the following heading. `⌘Z` restored it; I verified all 8
blocks are back at their original y-positions (573, 631, 671, 711, 769, 803, 809, 849).
**Restored.**

**3. Two property blocks are missing from the record's page body, and I cannot attribute
it.** My very first screenshot of the record (taken before I sent any input of any kind)
shows two property blocks rendered inline in the page body under the Content tab — a number
property with a progress bar, and a checkbox property. They are not there now, and they were
already gone by my third screenshot.

That third screenshot came after only: read-only `evaluate_script` calls, one screenshot,
one accessibility snapshot, and one `navigate_page` (which reported *"Accepted a
beforeunload dialog"* — meaning Notion had unsaved work pending at that moment). **I
dispatched no mouse, pointer or keyboard event before this difference appeared.** In the
same window the browser also navigated to a different page on its own and had a multi-select
property editor open, neither of which I did — so someone or something else was acting on
that window. I cannot rule out that the accepted `beforeunload` discarded a pending change.

**Action for the user**: check that record's version history around 2026-08-29 for the two
inline property blocks. Everything else I touched was verified back to its original state,
and all my temporary DOM (probe elements, `aria-label`/`role` tags, the redaction
stylesheet) was removed — verified at zero leftovers on both surfaces.
