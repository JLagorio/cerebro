# M46 — Notion parity: the model correction, then polish across the board

Status: directed 2026-08-29 by the user after live-testing M45.6.

## 1. The two directives, verbatim

> "sorry tabs are only for related data sources. fields shwo above. just like notion."

> "our UI is clunky, drag and drop isnt polsihed etc. like it feels bad to use and it
> doesnt feel as polished as notion even in the editable UI. I want polish on
> everything acros sthe board. seroiously 1:1 for notion, inteteraciton patterns and
> UI polish. if you need to use chrome MCP and do 1 edit at a time between notion and
> our app do it."

Both are product-owner rulings. The first REVERSES M45.6's central model. The second
sets the standard for everything after: measured parity, not approximate parity.

## 2. The model correction (M46.1)

**Notion's record page, confirmed against the live app:** the property strip renders
ABOVE the tab strip and shows on every tab. The tabs themselves hold the page body
("Content") and linked data sources ("Tasks Tracker", "Product Roadmap"). A property
section never belongs to a tab.

**What Cerebro built in M45.6:** `LayoutGroup.tab` — a section belongs to a tab — with
per-tab scoping threaded through `resolveLayout` and both record surfaces, a "Move to
tab…" affordance, and a tab-scoped customizer canvas.

**What lands in M46.1:**

- Property sections are GLOBAL again: heading strip, groups, and rest all render above
  the tab strip, on every tab. `LayoutGroup.tab` and its scoping retire.
- Tabs carry only: the body (`overview`), free text (`sections`), and a data-source
  view (`view`). The `properties` tab kind retires with the model — a tab that shows
  the property stack is the thing the correction forbids.
- The customizer canvas shows the property zones ABOVE the tab strip, always, matching
  the record page. The tab strip in the canvas edits tabs; it does not scope sections.
- M45.6's engine work is not all waste: the `layoutTabScope`/`canHoldSections` seam and
  the reachability rules retire with the model, but the peek's tab strip (M45.6 Task 2)
  is CORRECT and stays.

**Migration:** a vault that already carries `tab:` on a group — only reachable by
someone who ran M45.6 locally — parses tolerantly and ignores the key. It is dropped on
the next Apply. No user of a shipped build can have one.

## 3. The polish program (M46.2+)

The standard is measured 1:1: for each surface, capture Notion's computed values and
interaction behavior through the Chrome bridge, capture ours the same way, and close
every gap that is not a deliberate, recorded difference.

**Method (per surface):**
1. Open the equivalent Notion surface and ours side by side in the bridged browser.
2. Capture, don't eyeball: computed styles (font size/weight/line-height/letter-spacing,
   color, padding, margin, radius, border, shadow), hover/active/focus states, cursor,
   transition timing and easing, and the drag lifecycle (what the pointer picks up,
   what follows it, what the drop target looks like, what animates on drop).
3. Write the deltas as a table in the surface's plan doc.
4. Fix, then re-measure to confirm the delta closed.

**Surfaces, in priority order** (the user named drag-and-drop first):
1. **Drag and drop everywhere** — record property rows, layout-editor sections and
   fields, table rows and columns, board cards, tab strips. Notion's grammar: a grip
   that appears on hover in the gutter, a lifted ghost that follows the cursor with a
   shadow, a thin insertion line at the target, the source dimmed in place, and a
   settle animation on drop.
2. **The layout editor** — block chrome, hover affordances, the panel, spacing.
3. **The record page and peek** — property row rhythm, empty states, the strip.
4. **Tables and boards** — row hover, cell focus ring, column resize, header menus.
5. **Menus, popovers, dialogs** — open/close transitions, shadow, radius, item rhythm.
6. **The shell** — sidebar rows, section headers, counts.

**Non-goals:** copying Notion's brand colors or typefaces (Cerebro keeps its own design
tokens); features Notion has that Cerebro does not (comments, AI autofill).

## 4. Why the Chrome bridge changes the method

Every previous parity pass in this repo worked from screenshots, which carry layout but
not computed values, and carry no interaction at all. The bridge reaches the live app,
so a claim like "our rows are tighter" becomes a measurement, and a claim like "the drag
feels bad" becomes a named list of missing behaviors. Findings must be captured as
values in the plan docs, so a later reader can re-measure rather than re-argue.

## 5. Slices

- **M46.1** — the model correction (§2). Reverses M45.6's per-tab sections.
- **M46.2** — drag and drop, measured and rebuilt to Notion's grammar.
- **M46.3** — the layout editor's chrome and interactions.
- **M46.4** — record surfaces.
- **M46.5** — tables and boards.
- **M46.6** — menus, popovers, dialogs.
- **M46.7** — the shell.

Each slice: measure → plan with a delta table → implement → re-measure → gate.
