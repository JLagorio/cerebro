# M44 — charts, dashboards, database views, in-page tabs (scoping)

**Date:** 2026-08-25
**Status:** scoping spec, not yet approved for a plan doc
**Milestone:** M44 (proposed)
**Supersedes framing in:** none shipped — `docs/cerebro-ds/` (M37–M43's source) is
superseded as the design-of-record by `docs/cerebro/CerebroApp.dc.html`, a newer,
gitignored canvas export. Both are reference, not code.

---

## 1. What arrived, and the headline finding

Four mining agents each deep-dove one area of `docs/cerebro/` against the live
tree and cross-checked every feature named in the newer export. The docs
themselves are not new subject matter — Charts, Dashboards, Databases, and
per-record tabs all existed as ideas before — but the Aug 25 export changes
their shape materially enough that a straight diff against `docs/cerebro-ds/`
undersells what's different. This spec is the scoping pass before any M44.x
plan doc, per the same sequencing `agent-platform-design.md` used ahead of
`plans/2026-08-20-m34.1-make-agents-real.md`.

**The headline: this is not a greenfield milestone.** One whole mining area —
configurable database/record views — turns out to be **already built, mostly
as a superset** of what the design shows (§2). The other three areas
(chart enhancements, the dashboard drag-and-drop editor, in-page tabs) are
genuinely net-new, and one of them — Activity/comments — depends on
subsystems (a change-audit trail, comments) that do not exist anywhere in the
app, not even as stubs.

- **Databases/views**: saved views, the "New view" popover, the left-nav
  Databases section, filters/properties, and the record detail panel are all
  real and in most respects richer than the design (prev/next stepping,
  continuous resize, git history, knowledge dossier). The one real gap is
  **per-type persisted "Customize display"** config for the peek/detail panel.
- **Charts**: real code (`src/views/ChartView.tsx`, `src/engine/chart.ts`) is
  a solid 3-kind renderer, already ahead of the design on one axis (any
  numeric field + sum/avg, not just "sum of points"), but behind on chart
  kind count, styling, legend interactivity, tooltip, drilldown, and export.
- **Dashboards**: the single largest gap found. Real `DashboardView.tsx` is a
  read-only 2-block-kind auto-fit grid edited from a side panel; the design is
  a full row/cell drag-and-drop layout engine with 8 widget kinds, resize,
  per-widget filters, and a completely separate static "Portfolio dashboard"
  screen that has no backing domain model (OKRs/Key Results) anywhere.
- **In-page tabs**: entirely unbuilt. **Correction from the design owner
  (2026-08-25): Overview/Spec/Activity are illustrative examples, not a
  fixed schema — tabs are meant to be 100% user-configurable, Notion-style.**
  The design's own data model backs this: a sibling record-panel pattern
  (Objective/KeyResult/Initiative/Feature) already varies its tab SET per
  record kind (`tabIds`, `CerebroApp.dc.html:10429`) rather than sharing one
  fixed list with the work-item panel's Overview/Spec/Activity — the
  prototype just hardcodes each kind's set in JS rather than exposing an
  end-user add/rename/reorder/remove control, which is the gap the real
  build needs to close. The tab-bar shell and a generic free-text content
  type (already prototyped as an editable list of heading+paragraph
  sections) can ship without new subsystems; a tab a user configures to show
  real activity/comments is a separate, later content-type decision, not a
  blocker for the mechanism itself.

---

## 2. What already exists

Recorded here so no M44 phase rebuilds it.

| Piece | State | File |
| ----- | ----- | ---- |
| Per-type saved views (Table/List/Board/+7 more), New-view popover, rename/duplicate/delete | already-built, superset (10 layouts vs design's 3) | `src/pages/TypePage.tsx`, `src/views/ViewTabs.tsx` (`NewViewForm` ~L509-618) |
| Databases left-nav section (icon, color, count, per-type rows) | already-built, superset (real "New database" flow; design stubs it) | `src/app/Sidebar.tsx:719-762`, `src/app/TypeDialogs.tsx` |
| Add filter / add property / New record on the Databases surface | already-built, superset (arbitrary-field filters vs design's status-group-only) | `src/views/ViewToolbar.tsx`, `src/engine/viewFilters.ts`, `src/app/typeActions.ts` |
| Right-side record peek/detail panel | already-built, superset (prev/next stepping, continuous resize, git history, knowledge dossier — none in the design) | `src/detail/DetailPanel.tsx`, `src/detail/DetailHeaderActions.tsx`, `src/detail/RecordProperties.tsx` |
| Per-field table-column visibility toggle (prior art for "Customize display") | already-built, different surface (grid columns, not the detail panel) | `src/views/ViewSettingsPanel.tsx` `toggleColumn` (~L819) |
| Chart measure: any numeric field, sum or avg | already-built, superset (design hardcodes Count / Sum-of-estimate-points only) | `src/engine/chart.ts` `defFor`/`aggregateNumbers`, `src/engine/types.ts` `ChartAgg` |
| Chart typed empty states (no-group / no-rows / no-value-field / no-numbers) | already-built, superset (design has one generic "nothing to plot" message) | `src/views/ChartView.tsx` (`EmptyState` branches) |
| Ephemeral, all-fields-together empty-property fold in the detail panel | partial — real prior art, wrong shape | `src/detail/RecordProperties.tsx:60-64` (`revealed` useState, not persisted, not per-field) |
| Dashboard block reordering (flat list, grip handle, keyboard) | partial — real prior art, wrong shape (no rows, no fractional width, no drag) | `src/views/ViewSettingsPanel.tsx` BlocksPage (~L1293-1400), `useSortableList` hook |
| Dashboard block kinds: `view` (embeds another saved list) and `number` (agg over own rows) | partial — 2 of the design's 8 kinds, and `view` has no analog in the design at all | `src/engine/types.ts` `DashboardBlock` |
| Resize-gesture prior art (mousedown, cursor swap, clamped drag) | reusable pattern for widget resize | `src/components/ui/ResizeHandle.tsx`, `TableView.tsx` column resize |

---

## 3. Roadmap (proposed M44 sub-slices)

Ordering is dependency, not appetite — read left to right within a row before
sequencing across rows. **Nothing below is delivered.** Every "Not built"
line is drawn from a mining finding's `gap` field; this is the scoping list a
future M44.x plan doc will pick items from, not an execution plan.

| Milestone | Gist | Not built |
| --------- | ---- | --------- |
| **M44.1** | Customize display — per-type persisted detail-panel config. Smallest slice, no engine change, reuses the ViewSettingsPanel toggle-row pattern on a new surface. | Per-type display-config object (hidden-field keys, `showEmpty`/`showFile`/`showBody`, width preset); a settings sub-panel reachable from the detail panel's actions menu; wiring `RecordProperties`/`DetailPanel` to read/respect it; a reset-to-defaults action. Storage location (vault frontmatter vs local uiStore) is an open question (§4). |
| **M44.2** | Chart kind + styling pass — extend `ChartSpec`/`ChartView` without touching the X-axis/Group architecture question. Ships value even if M44.3's bigger fork stays undecided. | `column`/`bar` orientation split; a `number` chart kind (big-stat, no axes); `ChartSpec.xSort` (default/big-first/small-first/A→Z); `ChartSpec.cumulative` running-total pass; `ChartSpec.height` presets (S/M/L/XL); `ChartSpec.palette` + `colorByValue` color-mix shading; 7 style-toggle booleans (grid/axis/labels/smooth-line/area-fill/donut-center/legend) each gating an existing or new render branch; subtitle summary-line composition (depends on group-by/cumulative/legend landing first, so trails within this slice). |
| **M44.3** | Chart interaction pass — tooltip, legend, drilldown, export. Depends on M44.2's style/kind fields existing to hang state off of. Gated on the product call in §4 (X-axis-independent-of-Group + Group-by/stacking is an architectural reversal of M16.27, not a simple addition). | Interactive per-item legend (show/hide, struck-through when hidden, "nothing visible" recovery state) with `ChartSpec.hidden`/`hiddenG`; a positioned floating multi-row hover tooltip (title + per-series rows + synthetic Total/Share row); click-to-drilldown modal (up to 9 matching records, open one, "Save as view" that merges the view's filters with the clicked band's filter into a new saved List view); chart export menu (copy-as-PNG, download PNG, download SVG — needs real canvas rasterization + Tauri clipboard/dialog plumbing, not a toast). If the product call in §4 lands "yes, decouple": `ChartSpec.xField` + `ChartSpec.groupBy`, `computeChart` stops deriving its axis from `presentation.group`, stacked-bar/multi-series-line rendering, a series legend, and the X-axis/Group-by popovers in `ViewSettingsPanel`'s ChartPage. |
| **M44.4** | Dashboard drag-and-drop widget editor — the largest single slice. Depends on nothing above; can run in parallel with M44.2/.3 once its own product-call in §4 (does `view`-kind embedding survive as a 9th widget?) is answered. | A rows/cells data model (replacing or extending `DashboardSpec`'s flat `blocks[]`); cross-row drag-and-drop reorder with insertion-point indicators; two new resize gestures (seam-drag for widget width, row-edge-drag for row height) built on `ResizeHandle`/`TableView` prior art; a View/Edit mode toggle; row (4-widget) and dashboard (12-widget) caps with toast enforcement; 5 new widget kinds (metric-preset, table, board, timeline, horizontal-bar chart variant) computed from the dashboard's own scoped entries — a different data-flow than `DashboardBlock`'s `kind:'view'` reference; per-widget filter layered on the view's filters; a dashboard-wide "Global filter" layered under that; a widget options menu (edit/duplicate/move-left/move-right/move-to-own-row/delete) and a grouped add-widget popover (Charts/Views/Metrics) with capacity messaging. |
| **M44.5** | In-page tabs — a generic, **user-configurable** tab mechanism on the full-page record detail view, Notion-style. Overview/Spec/Activity and Details/Insights/Health/Resources (the design's two sample sets, one per record-kind family) are illustrations, not the deliverable — the deliverable is the mechanism that lets a person define either. Overview reuses M44.1-adjacent property/description rendering; any tab showing real activity/comments is a later content-type decision (§4) and should not block the tab-bar shell landing. | Tab management: add/rename/reorder/remove tabs, persisted per type (or per record — open, §4); a tab-bar component + local tab state + conditional content swap inside/beside `DetailPanel`; a first generic content type — free-form, individually-editable/deletable heading+paragraph sections (prototyped as an in-memory array of `{heading, paragraph}`, no persistence) — usable as the default body for any user-created tab; a content-type picker per tab (free-text sections now; properties/description and — later, matching M44.4's widget picker — a saved view/embed). Deliberately OUT of this slice: a real activity/audit-event capture layer or a comments subsystem — `PropertyMenu.tsx` already states comments have zero subsystem today, so an "Activity" or "Comments" content type is its own follow-on once the tab mechanism exists to host it. |
| **M44.6** (triage, not a build slice) | The static "Portfolio dashboard" org-rollup screen. Flagged for a scoping decision, not estimated as in-scope work — it's a different domain (OKRs/Key Results) than the dashboard widget editor. | An OKR/Key-Result domain concept (`health`, `key result`, `okr` fields — none exist in `src/engine/types.ts` today); new presentational components (`MetricTile` w/ sparkline, `ProgressBar`, `HealthChip`, standalone `DonutChart`/`BarChart` outside `ChartView.tsx`'s internal renderers); a fixed 12-column-span layout distinct from the M44.4 row/cell model. Likely belongs to a separate OKR/portfolio-rollup milestone rather than M44 — recorded here so it isn't silently dropped. |

---

## 4. Open questions

Pulled from all four mining agents' `openQuestions`, plus cross-area
questions spotted while assembling this roadmap.

**Charts (M44.2/M44.3)**

1. Should the chart's X axis stay tied to the view's Group control (today's
   deliberate M16.27 constraint, documented in `src/engine/chart.ts`'s own
   comment) or become an independent field picker as the design shows? This
   is the single biggest architectural fork in the Charts area — it also
   gates Group-by/stacking, since stacking needs two independent field slots.
2. Is client-side PNG/SVG chart export and clipboard-copy in scope for M44,
   given it needs real Tauri file-system/clipboard plumbing rather than a
   toast (the design's own prototype only toasts)?
3. Does "Save as view" from a chart drilldown reuse the same saved-view
   creation path other Notion-parity "Save as view" flows would use
   elsewhere (worth checking against M44.1's surface), or is it chart-specific?
4. Is the design's hardcoded Count/Sum-of-points measure pair an intentional
   simplification for this app's work-item schema, or should the richer
   existing any-field sum/avg model stay and the design's simpler two-chip UI
   just become an optional preset on top of it?

**Dashboards (M44.4)**

5. Should the new row/cell drag-and-drop widget model replace
   `DashboardSpec`'s flat `blocks[]` outright, or must the two coexist —
   i.e. does real `DashboardBlock`'s `kind:'view'` (embedding an entirely
   different saved view/list elsewhere in the vault) survive as a 9th widget
   kind alongside the design's 8, which only read the dashboard's own scope?
   This is the dashboard equivalent of question 1 and should probably be
   answered by the same conversation.
6. Is the static "Portfolio dashboard" screen (M44.6) actually in scope for
   M44, or does it belong to a separate OKR/Key-Results milestone that
   hasn't been scoped anywhere else in this diff?
7. The design's horizontal "bar" chart orientation has no equivalent in
   `ChartView.tsx` today — does the standalone Chart VIEW TYPE (M44.2) get
   this orientation too, or is it dashboard-widget-only?
8. Widget-level filter + dashboard-level "Global filter" + the view's own
   filters is a 3-layer stack — confirm intended precedence/AND-semantics
   against `wvPasses`/`match:'all'` before building the engine-layer filter
   composition.
9. `src/views/BoardView.tsx` already uses `@dnd-kit/core` for card
   drag-and-drop — does that give a reusable pattern (sensors, collision
   detection, drag overlay) for the M44.4 cross-row widget reorder, or is the
   row/cell/seam-resize interaction different enough to need its own
   primitives built on the simpler `ResizeHandle` prior art instead?

**Databases/views (M44.1)**

10. Should per-type display config live in the Type doc's frontmatter (like
    `views:`, for git-visibility/portability — the vault-first architecture's
    default answer) or in the app's local uiStore (device-local, like
    `detailWidth`)? The design doesn't distinguish.
11. Is the design's Board-view auto-generated-from-status-column-only
    limitation intentional for the Databases surface specifically, or should
    it inherit the full grouping flexibility `ViewToolbar` already offers
    elsewhere?

**In-page tabs (M44.5)**

12. Confirmed by the design owner: tabs are a generic, user-configurable
    mechanism, not fixed to Overview/Spec/Activity — so is the target
    Cerebro's real generic record `DetailPanel` (any type gets to configure
    its own tabs), or does it stay type-scoped the way the design shows two
    different sample sets for two different record-kind families (work
    items get Overview/Spec/Activity; Objective/KeyResult/Initiative/
    Feature get Details/Insights/Health/Resources, `tabIds` at
    `CerebroApp.dc.html:10429`)? Real Databases sample data
    (`cerebro-db-data.js`) shows no tab config anywhere yet, so this is
    genuinely open, not just unimplemented.
13. The design's per-kind tab sets are hardcoded in JS (`tabIds`/`panelLay`
    lookups), not exposed as a live add/rename/reorder/remove control
    anywhere in the prototype — the real build has no UI reference to
    clone for tab management itself, only for a tab's free-text content
    (the `secs2`/`wfSpecBlank` add/edit/delete pattern). Where does this
    management UI live — inline in the tab bar (a trailing "+"), or in a
    type/record settings surface alongside M44.1's "Customize display"?
14. Should a tab's free-form section content (the generic default content
    type, modeled on "Spec") be structured frontmatter/sidecar data, or
    literally markdown H2 headings parsed out of the existing note body
    (reusing the one real content store instead of adding a second one)?
15. If/when someone configures a tab to show real activity or comments —
    not required for M44.5 itself — should Activity become a real audit
    trail (new Rust-side event capture + storage) or stay a lightweight
    best-effort recent-changes summary computed from existing fields
    (cheaper, but then it can't show real comment/edit history)? And where
    do comments live under the "two records, two destinies" convention —
    `runtime.db` (operational) seems right since they're not epistemic
    facts, but this hasn't been decided anywhere in the codebase.

**Cross-area**

16. M44.1's per-type "Customize display", M44.4's per-widget dashboard
    config, and M44.5's per-type/per-record tab set are now THREE separate
    persisted UI-preference schemas proposed across this spec — should they
    share one storage mechanism/schema decision (question 10's frontmatter-
    vs-uiStore call, made once) rather than each slice answering it
    independently and risking three different answers?
