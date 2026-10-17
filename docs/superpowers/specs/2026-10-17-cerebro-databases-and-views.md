# Cerebro databases and views — composed, readable, dependable

**Status: Draft for owner review, 2026-10-17.** This document proposes design and acceptance
contracts. It does not authorize implementation. Provisional allocation: **M87 — database
workspace and tables; M88 — alternate views and displays**. The [milestone plan](../plans/2026-10-17-m84-m90-product-polish.md) defines sequencing.

## 1. Outcome and boundary

A database should feel like one well-designed working surface: a clear title, a compact view
bar, readable data, and controls that reveal themselves when useful. Changing from a table to a
board, a calendar or a related-page tab must preserve the same records, field meanings and
editing rules. Narrow panes should remain useful presentations, rather than cropped desktop
layouts.

M71–83 improved the shell and page hierarchy. The
[M80–83 record](../plans/2026-10-16-m80-m83-ui-polish.md) explicitly left dense view controls
unchanged; the [M71–79 record](../plans/2026-10-16-m71-m74-visual-redesign.md) retained the
calculated-sheet grid. This proposal addresses that remaining data-surface layer.

Use Morrow's calm title/property/body/data relationship and Macro's editing continuity as
references. Keep Cerebro's fonts, colors, files-first model, ten view kinds, typed fields,
capability gates, guarded writes and one-editor-per-file rule. This is not a replacement of the
view engine or a new database architecture.

## 2. Findings and capabilities already present

The audit combines source inspection with the mock-browser captures in the [audit](2026-10-17-cerebro-polish-audit.md). Source
risks are labeled separately from browser observations. Capture names below refer to the audit
session; selected captures are retained under `2026-10-17-polish-audit/` beside this file.

| Evidence                                                                                                        | Finding                                                                                                                                   | Required response                                                         |
| --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| [tableAnatomy](../../../src/views/tableAnatomy.tsx), lines 18–55 and 117–125                                    | Shared Knowledge/table anatomy and 32/36/48px density already exist.                                                                      | Refine existing anatomy and defaults; preserve saved density.             |
| [TableView](../../../src/views/TableView.tsx), lines 391–395                                                    | Title editing clears its draft before awaiting the write result.                                                                          | Keep refused title text editable, as scalar fields already do.            |
| [FieldEditor](../../../src/detail/FieldEditor.tsx), lines 830–844                                               | Scalar inputs retain drafts after refused writes.                                                                                         | Make this the shared editing contract.                                    |
| [ListView](../../../src/views/ListView.tsx), lines 135–168 and 324                                              | Every list reserves a key slot and has a 720px minimum.                                                                                   | Reflow lists inside narrow containers.                                    |
| [GalleryView](../../../src/views/GalleryView.tsx), lines 50–54, 210 and 243; capture `21-gallery.png`           | Fixed card minima, always single-line titles; live review showed five columns of small, truncated cards.                                  | Fewer readable default cards, bounded responsive minima, two-line titles. |
| [BoardView](../../../src/views/BoardView.tsx), lines 343–362                                                    | Every card has a color stripe and a key row, even without a key.                                                                          | Remove empty key space and reduce repeated category decoration.           |
| [GanttView](../../../src/views/GanttView.tsx), lines 115–121; capture `25-gantt.png`                            | The table sums all inherited column widths. At a 1440px window, approximately 1050px of a 1146px canvas was table, leaving 96px for time. | Budget the table and time axis separately.                                |
| [CalendarView](../../../src/views/CalendarView.tsx), lines 497–548                                              | One non-wrapping header holds date navigation, full date text, span choices and undated count.                                            | Explicit narrow-container control layout.                                 |
| [ViewSettingsPanel](../../../src/views/ViewSettingsPanel.tsx), lines 479–496; capture `28-display-settings.png` | Delete database is inside view settings.                                                                                                  | Put entity destruction in the entity menu; retain its confirmation.       |
| [PropertyRow](../../../src/detail/PropertyRow.tsx), lines 143–158                                               | Recorded debt: labels are 14px, values 13px, and short label boxes clip real names.                                                       | Coordinate field typography with the page-foundation spec.                |

Preserve the substantial functionality already built: column resize/fit/freeze/wrap/reorder,
cell keyboard navigation, nested grouping, multiple sort keys, bulk actions with per-record
failures, computed-field display, view problems and limit disclosure. Cards already use saved
visible fields; calendars already handle timed records and recurrence; charts already have
legends, drilldown and export. Related tabs already create under their host and offer Add
existing. Sheets already calculate, edit, fill, import and export. None should be reintroduced
as a new feature.

## 3. M87 — database workspace and table anatomy

### 3.1 One header, three explicit scopes

Define shared visual primitives with full-page, linked-embed and related-tab variants. Do not
force all three through one mutation controller: their write ownership differs.

- **Full database/list:** title and entity menu above the saved-view row. Views on the left;
  Filter, Sort, Group, Search, Display and New on the right. One quiet divider separates data.
- **Linked embed:** source title, current view, Open full page and the actions its host can
  actually support. An edit to a shared saved view must identify that scope.
- **Related tab:** relationship scope remains evident; New and Add existing are peers with
  distinct meanings. A local search filters this presentation without changing membership.

Use the existing view controls and engine builders. Active filters and sorts show a readable
count or summary as well as color. The expanded rule bar appears on request; no permanent row
of idle pills. Do not silently hide an active search or filter. Search is navigation state,
not a write to the view file.

Separate **Display this view**, **Manage properties**, and **Database actions**. Rename/delete
database belong to the database menu. Delete view remains a view action. Property creation or
rename identifies that it affects the database, including the current record count when
relevant. Keep existing confirmation and batch semantics.

### 3.2 Proposed metrics

These are review targets, subject to the foundation's final tokens. Existing explicit saved
values take precedence; opening a legacy view does not rewrite it.

| Element                            | Proposed default                                                                                      |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Data-body type                     | 14px / 20px; Instrument Sans                                                                          |
| Headers and secondary metadata     | 12px / 18px; normal or medium weight                                                                  |
| Table row heights                  | Compact 32px, Default 36px, Tall 48px; retain stored values                                           |
| Table header                       | 36px, shared sticky offset with group bands                                                           |
| Horizontal cell inset              | 10px; one inset, not nested padding accumulation                                                      |
| Unconfigured title width           | 32% of content width, clamped to 320–480px in wide hosts; explicit user widths retain the 200px floor |
| View/control hit area              | At least 28px, 32px for primary creation                                                              |
| Full-page data inset               | One shared 24px baseline; narrow containers 16px                                                      |
| View bar below 560px content width | Tabs on the first row; actions on a second row or named overflow                                      |

Numeric columns align values consistently with tabular numerals; monospace is reserved for
keys, coordinates and values whose alignment benefits. Borders separate cells without making
the whole canvas a dark grid. Focus, cursor selection and checked bulk selection remain
visually distinct. Hover cannot shift columns or reveal controls by changing row dimensions.

Give unconfigured title columns a useful share of the canvas before distributing spare width to
short metadata. The current layout distributes slack among property columns while leaving the
title fixed ([TableView](../../../src/views/TableView.tsx), lines 2115–2145). New auto defaults
must account for nesting, icon and Open-control space; explicit saved widths remain exact.
In content hosts below 720px, cap the fallback title allocation at 60% of the host with the
existing 200px floor; the table owns horizontal scrolling. Table and Knowledge group bands
must derive sticky offsets from the same header metric, with a Knowledge regression specimen.

Keep blanks quiet in table cells while giving them accessible names and full-cell hit targets.
A missing measurement is never displayed as zero. Computed values remain visibly read-only on
interaction, without a repeated lock icon in every row. A mixed-type cell renders and edits
from that record's own field declaration, not merely the column header's kind.

### 3.3 Editing and keyboard contract

The grid retains its existing row/cell modes. Arrow keys navigate; Enter opens the focused
row or activates its cell; Tab traverses cells once cell mode is active; Escape backs out one
layer. An ordinary control inside the grid owns its own keys. The title remains editable,
with an independently reachable Open action. Modified open and Shift+Enter follow existing
pane routing.

All scalar and title editors use rest → editing → pending → success/refusal states. A refused
write keeps the exact draft and gives a nearby correction reason; the existing store toast
may supplement it. Enter and blur cannot submit twice. Escape writes nothing. Retry attempts
one write. Success shows committed data and restores the intended grid focus.

Unrelated rescans, sort changes and schema object replacement must not remount the active
editor or move a draft onto another record. If an editing row no longer matches the query,
keep its editing surface stable until commit/cancel, then explain its removal from the view.
If its target disappears, retain recoverable draft text and show a named failure. This is a
new acceptance requirement, not a claim that every such race has been reproduced.

Bulk selection stays keyed by file path, including duplicated appearances under nested
relations. Failures stay selected with reasons. No new rectangular paste or spreadsheet-like
clipboard semantics are included in this milestone.

### 3.4 Properties and persistence

Coordinate panel/strip typography with the page spec using `FieldEditor`'s existing `cell`,
`panel` and `strip` contexts. Do not solve the label/value mismatch by enlarging every compact
control globally. Long labels and values must be discoverable at 200% zoom without relying
solely on a hover tooltip.

Presentation changes remain explicit saved-view changes. Pure open, tab selection, layout
measurement, hover and focus write no vault bytes. Preserve width/order/visibility/wrap/freeze,
row density, fold state and navigation history. New persisted keys require parser/serializer,
field-reference and round-trip coverage; suggestions remain within the shared vocabulary.

## 4. M88 — alternate displays

### 4.1 List, board and gallery

**List** becomes a reading-first layout with no unconditional 720px floor. At 720px and wider,
selected metadata can follow the title; below 720px it wraps into a second aligned line. Every
selected field stays available. A long relation or URL cannot push the title offscreen.
Unkeyed records do not reserve 52px of blank item-key space. Existing inline field editing and
row actions remain keyboard reachable.

**Board** keeps meaningful columns and swimlanes. Proposed absent-setting column width is 288px;
retain Small/Medium/Large user choices. Cards use 12px inset, a two-line 14px title and at most
three preview lines. Key space appears only when a key exists. Category color lives first in
the heading/dot; default cards use a neutral border rather than repeating a strong stripe.
This proposed default requires owner visual review. Color-column settings remain meaningful.
Selected metadata wraps inside the card; extra content has an intentional expansion/open path.

**Gallery** defaults to a 260px minimum card, capped by actual container width, with 12px gaps.
A roughly 1146px canvas should ordinarily show four readable default cards, not five cramped
ones. Explicit saved Small/Medium/Large preferences retain their current 156/212/288px minima;
the 260px proposal applies only when the size setting is absent. Do not serialize defaults on
read or collapse an absent choice into an explicit enum before rendering. Changing the meaning
of saved enum values would require a separate reviewed migration.
Titles allow two lines, with complete accessible text. Covers use a consistent 16:9 area;
fit-versus-crop honors the saved choice. No cover property means no empty placeholder banner.

Cards share title/key/metadata/preview anatomy where behavior agrees. Board drag and gallery
open remain distinct controls. Do not introduce nested interactive elements inside a card
button. Multi-value grouping still places a record in every valid band; moving changes only
the source value, and ambiguous date-band drops remain refused honestly.

### 4.2 Calendar, timeline and Gantt

Date-navigation headers adapt to content width. Above 720px, use one row where it fits; below,
keep the current date and previous/next/Today together, with span and undated controls on a
second row or named menu. Never silently switch the saved calendar span. Empty dates remain
visible as calendar structure; records without a date remain reachable through their count.

**Time-axis allocation is a release gate.** Timeline and Gantt must not spend the whole viewport
on the associated record table. Proposed policy:

- At content widths of 720px or more, the table defaults to 35%, clamped to 240–420px, and can
  never consume more than half the viewport. The time axis receives at least 320px.
- The divider is keyboard and pointer resizable, with announced limits. Extra table columns
  scroll within their allotted region; they do not grow the region indefinitely.
- Vertical row positioning and scroll stay synchronized, including wrapped/grouped rows.
  The axis scrolls horizontally independently; zoom preserves the user's temporal anchor.
- Below 720px, offer a compact 160–220px title lane or explicit table-hide control. Keep the
  selected date position and record identity available. Narrow layouts do not overwrite a
  saved wide-layout proportion.

The existing stored columns remain intact even when the table viewport is smaller. Additional
persisted split preferences must have a declared home and migration; default clamping is a
render decision and causes no write on open. Review the six-column fixture from `25-gantt.png`
as the regression case.

Preserve floating versus exact-instant dates, repeat restrictions, point events, deadline
meaning, dependency edges and undated facts. Styling does not change calendar write/Undo
semantics established by M61. Keyboard alternatives remain available for move/resize, and
Escape cancels gestures without writing.

### 4.3 Charts, dashboards and sheets

Charts use readable captions, consistent numeric treatment and a quiet plot frame. Keep
measure, axis, active legend state and skipped/double-counted coverage visible. A zero-result
chart, an unchartable configuration and a failed read remain different states. Color is not
the sole way to identify a series. Drilldown and export stay available.

Dashboard widget title/actions align with the same data-header primitives, without stacking
multiple decorative frames around embedded views. Independent widget failures remain local.
Resizing and rearranging keep keyboard alternatives, saved positions and global/widget filter
semantics.

Sheets receive consistent live/read-only toolbar, header, gridline, selection and error
presentation. Preserve source formulas, pending-draft settlement and existing virtual rows.
The current grid uses fixed 120px columns and 32px rows
([SheetGrid](../../../src/sheet/SheetGrid.tsx), lines 78–79 and 779–851). Persistent widths,
formats, merges or rich cell styling require a separately approved carrier extension: M67
explicitly deferred those. No control may promise a visual setting that disappears on save.

The page/editor lane owns an embedded block's outer wrapper, caption, carrier and context
menu. M87 owns database source/view controls; M88 owns inner cards, plots, grids and time
displays. Compose those slots once so an embed does not acquire stacked duplicate headers.

## 5. State, performance and acceptance

Test the actual content container at 1200/720/480/360/320px where applicable, in both themes
and at 100%/200% zoom. Include the 360px peek inside a wide window. Use long and non-Latin
titles, unbroken values, many fields, nested/mixed-type groups, one record, large results,
filtered zero, malformed values, missing source/view, pending writes and refusals.

Acceptance requires:

1. No inaccessible primary action, clipped popover, card overflow or metadata-induced title
   disappearance. Tables can intentionally scroll horizontally; lists/cards reflow.
2. Every existing field kind, view kind and saved setting remains available. Saved legacy
   files reopen without automatic migration writes; new defaults affect absent settings only.
3. One failed title/scalar edit retains its draft and leaves disk unchanged; one successful
   commit produces one intended write. Focus and selection survive close, reopen and rescans.
4. Related creation, Add existing, option/person creation, schema edits and bulk actions use
   existing guards and batch contracts. Knowledge writes and agent grants retain their
   separate guarded editors.
5. Empty, filtered, missing, invalid, unavailable and loading are never conflated. Numerical
   footers retain skipped counts; truncated results retain truthful shown/total disclosure.
6. Gallery mounting makes no unapproved remote image request; exact-URL session permission
   remains honored. Bad images and parse failures are named.
   Chart/dashboard figures never fill missing measurements with invented values.
7. Gantt's six-column fixture leaves the required usable axis at 1440px and in a split pane.
   Divider/axis scrolling preserves row alignment and temporal position.
8. Sheets preserve formula sources through edit/Undo/reopen; selection does not recalculate,
   and export settles drafts. Error, not computed, unavailable and zero remain distinct.

Record baseline and final performance on a named machine/browser using 100/1,000/5,000-record
fixtures and 12/24 columns. Proposed target for review: p95 input/cursor response below 100ms
at 1,000 records; no avoidable main-thread task above 50ms during warmed scroll/selection.
These are proposed budgets, not existing measurements. Table/List/Gallery currently map all
supplied records; configured limits are disclosed. If virtualization becomes necessary,
retain the active editor, correct accessibility indices, full evaluated totals and scroll
restoration. Do not silently lower result limits to pass.

The implementation plan must name focused units, existing browser flows, new visual fixtures
and native checks. New meaningful sections participate in the state lab's five states. Actual
browser evidence must include save/reload/Undo and keyboard/drag/resize, not just static
screenshots. Packaged WebKit acceptance remains distinct from Chromium/WebKit browser checks.

## 6. Reference use and exclusions

[Morrow's database surface](../../examples/Morrow-main/src/app/components/database/DatabaseView.tsx),
lines 115–190, and [its styles](../../examples/Morrow-main/src/app/styles/features.css), lines
529–672 and 918–943, demonstrate calm controls, readable row rhythm and aligned properties.
Its smaller table does not provide Cerebro's full hierarchy/bulk/keyboard machinery.

[Macro's toolbar](../../examples/macro-main/apps/web/src/features/database/components/database-toolbar.tsx),
lines 144–154, uses container-responsive controls.
[Its held-row seam](../../examples/macro-main/apps/web/src/features/database/primitives/held-grid-rows.ts)
keeps an editing row stable as query membership changes. These are behavioral references;
copy neither their implementation nor collaboration/backend assumptions.

Excluded from this tranche: new field kinds, multiplayer presence, replacement editors/grids,
rectangular database paste, new recurrence grammar and full Excel formatting. Any extension
to shared field/view vocabulary follows CV-04 and its shared cases. Existing M60/M61/M67 and
M71–83 outstanding native acceptance carries forward; a polished screenshot does not close it.
