# Thought Desk: design system, UI composition, missed architecture - reference audit 2026-10-24

> **Scope:** slice TDK. Design system, components, UI composition, and what the 2026-10-22 dossier missed. `TD/` = `docs/examples/thought-desk-main/`.
> **Read:** about 60 TD files, whole or in part (all of `src/app.css` and `src/App.svelte`, the `src/lib/*.ts` helpers, `ui/`, the overlay components, `PageView`/`TitleBar`, the `db/` views, `src-tauri` entry, config, memory, pdf, files and sync). About 50 Cerebro files, plus the pinned `tauri-2.12.4` and `tauri-plugin-window-state-2.5.0` crate sources. Nothing was built or run.
> **Licence:** `TD/LICENSE:1-4` and `TD/package.json:6` say AGPL-3.0-or-later, so this slice takes **ideas only and copies no code**. The one "adopt" names a third-party dependency, `tauri-plugin-window-state` ("Apache-2.0 OR MIT" in its Cargo.toml), not TD source.
> **Basis:** [read] means I read the code. [names] means I inferred from a file or directory name. [docs] means README, plan or spec text.
> **Not repeated:** `plans/2026-10-22-reference-review/thought-desk.md` already covers the perf corpus and bench, progressive tables, a11y gaps, search projection, intake forms, date overlays, record rules and recall. `plans/2026-10-22-ui-refresh-review/02-visual-system.md` already notes the 708px measure and concentric corners.
> **Platform caveat:** TD ships only on Windows. It builds an NSIS bundle only (`TD/src-tauri/tauri.conf.json` `"targets": ["nsis"]`), calls WebView2 COM in `memory.rs` and `pdf.rs`, and falls back to Segoe fonts (`app.css:58`). Its CSS was tuned on Chromium. Cerebro ships on WKWebView, so any feature Cerebro adopts needs a WebKit check.

## Top findings

- **In Cerebro, "New" in a filtered view can lose the record from sight.**
  - TD writes the view's simple filters and its group into the new row (`#defaults`), inserts it at the top, and keeps it pinned there (`pinFirst`) until the person leaves the view.
  - Cerebro's `createTarget` sets only the item key, the band value and the host. I found no notice for when the new record does not match the view.
  - Changes **M94.6** and the destination honesty of **M94.4**.
- **A webview reload is a leave path nobody guards.**
  - TD allows the native context menu only in editable fields and blocks the reload keys in production builds.
  - Cerebro has no global `contextmenu` policy and no `beforeunload` or `pagehide` handler, and the **M94.4** creation drafts live only in memory.
  - Add reload to the **M93.2** leave inventory and a native case to **M93.11**.
- **The native window does not follow the app.**
  - TD keeps the window hidden until two frames have painted. It then sets the native theme and the window background to the resolved theme and restores size and position with the official plugin.
  - Cerebro opens a visible window, never syncs the native appearance and forgets the window frame.
  - Tauri 2.12.4 supports `Window::set_theme` (app-wide) and `Window::set_background_color` on macOS. It does not implement `Webview::set_background_color` there.
  - **NEW:shell**, evidence in **M94.9**.
- **The collection composition needs a defined edge.**
  - In TD, tables and boards scroll out to the pane edge. Their content starts at the page inset, and the 40px hover gutter hangs in the margin, so the first column sits under the title.
  - Cerebro pads outside the scroller and counts its gutter as content.
  - Decide what the **M94.2** 2px edge test measures. In **M94.6**, frozen columns would need a mask over the margin.
- **Boards should be bounded per column, not per view.**
  - TD shows 50 cards per column, then "Show more (N left)".
  - Cerebro applies one `limitEntries` first-N to every layout, and the **M93.6** matrix has no board, gallery or list workload.
  - Amend **M93.6**, **M93.7** and **M94.6**.
- **Cerebro already took TD's motion layer. Keep Cerebro's stricter a11y bar.**
  - Tooltip warm-up, the theme reveal, button press scale, switch spring and toast pop already cite thought-desk in Cerebro.
  - TD's `content-visibility` rows are the exact change Cerebro removed after Chromium dropped an offscreen record from its accessibility tree (REL-08).
  - TD has no frontend tests, no IME guard and no focus trap.
- **Several small composition rules belong in the M94.2 sheet:**
  - fixed 24px section-heading rows, with actions that overhang the row;
  - grouped-list rows of 48/40/72px with hairlines inset from the leading edge;
  - concentric radii (inner radius = outer radius minus padding);
  - a named z-index scale;
  - a toolbar hairline that appears only once content scrolls under it;
  - `text-wrap: balance` on titles;
  - a lighter font weight in dark mode.

## Map

| Area | Path | What it does |
| --- | --- | --- |
| Tokens and themes | `TD/src/app.css:49-459` | Type scale, control heights, weights (lighter in dark), grayscale roles, 6 palettes, OKLCH custom theme, accents, radii rule, motion, reduced motion |
| Primitive CSS | `TD/src/app.css:582-1024` | Frosted `.popover`, `.icon-btn`, `.btn`, sheet head/body/foot, grouped lists, fields, chips, `.view` anatomy |
| Prose and print | `TD/src/app.css:1026-1838` | Editor typography, optical alignment of markers, tables, print stylesheet |
| Theme runtime | `TD/src/lib/prefs.svelte.ts:148-286` | Resolves the theme, writes `data-*` attributes and custom hue/tint variables, picks a legible mark colour for the accent, debounced localStorage |
| Colour math | `TD/src/lib/color-math.ts` | OKLCH↔sRGB, gamut clamp, WCAG contrast, `textOn`, `cssToRgb` |
| Look change | `TD/src/lib/look-transition.ts` | View-Transition circle reveal for light/dark, cross-fade otherwise |
| Motion | `TD/src/lib/motion.ts` | `pop`, `fadeOut`, `sheet`, `sheetOut`, `sidebarSlide`; reduced-motion aware |
| Pane sizing | `TD/src/lib/pane-size.ts` | `--pane-w` and `data-below-N` attributes from a ResizeObserver, instead of container queries |
| Overlay state | `TD/src/lib/ui.svelte.ts` | Single global stores for menu, confirm, prompt and toasts; imperative `openMenuAt` |
| Overlays | `TD/src/lib/components/{Menu,Tooltip,Toasts,Modal,ConfirmDialog}.svelte`, `TD/src/lib/db/Popover.svelte` | Menu that flips above its anchor and takes arrow keys; one global `data-tip` tooltip with warm-up; dark pill toasts; sheets; nested popover stack |
| Primitives | `TD/src/lib/ui/*.svelte` | EmptyState (full and compact), Segmented, Switch, SearchField, Swatches, ColorWheel, StatusCheck, TagRow, FileTile |
| Shell | `TD/src/App.svelte` | Shows the window after paint, syncs native theme, global key/contextmenu/drop policy, split panes, route motion |
| Title bar | `TD/src/lib/components/TitleBar.svelte` | Back/forward, collapsing breadcrumbs, save and created status, scroll hairline |
| Split view | `TD/src/lib/split.svelte.ts`, `TD/src/lib/components/SplitDrop.svelte` | Second pane, swap and drop rules, live "make room" preview |
| Page anatomy | `TD/src/lib/components/PageView.svelte` | Head tools revealed on hover, 40px title, tags, row properties, starters, backlinks, click area under the content |
| Database anatomy | `TD/src/lib/db/DatabaseView.svelte` | Header, view tabs (clicking the active tab opens its settings), tools, filter chips, CSV drop, `--edge` |
| Table | `TD/src/lib/db/TableView.svelte` | Grid aligned to the edge, sticky header strip, `content-visibility` rows, bulk bar, new rows pinned |
| Board, gallery, list | `TD/src/lib/db/{BoardView,GalleryView,ListView}.svelte` | Per-column paging; gallery and list mount as you scroll; new rows pinned |
| Creation seeding | `TD/src/lib/databases.svelte.ts:824-913`, `TD/src/lib/db/query.ts:321-326` | Defaults from status, template, filters and group; `pinFirst` |
| Properties | `TD/src/lib/db/{RowProperties,Value}.svelte` | A row's properties on its page; "Empty" vs "—"; hide empty; one shared value renderer |
| Search | `TD/src/lib/components/SearchPalette.svelte` | Only one search in flight, latest query wins; go-to rows |
| Export | `TD/src/lib/page-actions.ts`, `TD/src-tauri/src/pdf.rs`, `TD/src/lib/docx.ts` | Markdown, PDF and Word export; print mode |
| Native | `TD/src-tauri/src/main.rs`, `TD/src-tauri/tauri.conf.json`, `TD/src-tauri/src/memory.rs` | Single-instance, global-shortcut and window-state plugins; hidden window; WebView2 memory trim |

## Patterns that work

| ID | Pattern | Mechanism (how it actually works) | Why it works | Evidence [basis] | Cerebro today | Verdict | Phase |
| --- | --- | --- | --- | --- | --- | --- | --- |
| TDK-01 | Create where the view shows it | `#defaults` fills, in order: the first "to do" status, the template's cells, simple filters (is/hasAny/hasAll, checked, a number eq, text is/contains, a date is) and the group key. `newRow` inserts at the top and selects the new title. `fresh` ids stay pinned first (`pinFirst`) until the person leaves the view | A new record never vanishes behind the view that created it, and nothing renders down to the end of a long table | `TD/src/lib/databases.svelte.ts:824-861,873-913`; `TD/src/lib/db/query.ts:321-326`; `TD/src/lib/db/TableView.svelte:83-86,534-552`; `TD/src/lib/db/BoardView.svelte:35-45` [read] | `createTarget` sets key, band and host only (`src/engine/createRecord.ts:18-67`). Quick add passes the band only (`src/views/QuickAdd.tsx:12-48`, `src/pages/ListPage.tsx:136`). Views receive the filtered `shownEntries` (`src/pages/TypePage.tsx:238,414-425`). I found no notice for a created-but-hidden record | adapt | M94.6, M94.4 |
| TDK-02 | Data runs to the pane edge, aligned to the title | A full-page database sets `--edge: var(--page-pad)` and removes the body's padding. The table pads its scroll content `0 edge 0 max(0, edge−48)`, so the 40px gutter hangs in the margin. Group and empty rows stick at `left: var(--edge-l)`. Board columns are padded by `--edge` | Wide data scrolls to the pane edge without a clip line inside the page, while the first column sits under the title | `TD/src/lib/db/DatabaseView.svelte:412,661-674`; `TD/src/lib/db/TableView.svelte:818-834,1093-1094,1140-1141,1198-1203`; `TD/src/lib/db/BoardView.svelte:210` [read] | `.cb-data-page` pads outside the scroller (`src/styles/surface-system.css:53-57`). The 40px gutter counts as content width (`src/views/tableAnatomy.tsx:71-80`). Frozen cells use `sticky left-0` (`src/views/TableView.tsx:437,576`). The edge contract does not say what to measure when a gutter is present (`specs/2026-10-23-m94-ui-implementation/composition-sheet.md`) | adapt | M94.2, M94.6 |
| TDK-03 | Bound each board column | `PAGE = 50` per group key. "Show more (N left)" adds 200 more. Gallery and list mount progressively | Every column shows its own first cards, and the rest are counted, never silently missing | `TD/src/lib/db/BoardView.svelte:29-40,174-177`; `TD/src/lib/db/GalleryView.svelte:15-24` [read] | One view limit for every layout: `limitEntries` takes the first N (`src/engine/viewFilters.ts:562-565`) and shows "Showing N of total" (`src/views/ViewLimitNotice.tsx:1-40`). BoardView has no per-column cap (grep). The M93.6 smoke cases are table, document, transcript and search only (`plans/2026-10-23-m93-m99-implementation-record.md:93-98`) | adapt | M93.6, M93.7, M94.6 |
| TDK-04 | Treat reload and stray input as leave paths | The native context menu appears only on input, textarea and contenteditable. Production builds swallow F5, Ctrl+R and Ctrl+O/J. Ctrl+S flushes. The app flushes on `visibilitychange` hidden and on `onCloseRequested`. Mouse buttons 3 and 4 go Back and Forward | A reload would silently drop unsaved state; one policy closes the hole | `TD/src/App.svelte:212-223,231-262,273-282,302-307` [read] | No global `contextmenu` handler (only `src/sheet/SheetGrid.tsx:695`). No `beforeunload` or `pagehide` (grep). The app menu has no Reload (`src-tauri/src/shell/quit.rs:203-221`). The M93.2 leave inventory does not list reload (`plans/2026-10-23-m93-reliable-workspace.md:70-84`). No mouse Back/Forward (grep) | adapt | M93.2, M93.11, M94.5 |
| TDK-05 | The native window follows the app | Config `visible:false`. The window shows after two `requestAnimationFrame`s, with a 500ms fallback. An effect calls `win.setTheme` and sets the background colour to the resolved body colour. The window-state plugin restores size, position and maximized state, but not visibility | No white flash on launch or resize; native chrome matches the chosen theme; the window reopens where it was | `TD/src-tauri/tauri.conf.json:24`; `TD/src/App.svelte:67-82,202-211`; `TD/src-tauri/src/main.rs:70-77` [read]; plugin licence "Apache-2.0 OR MIT" (`tauri-plugin-window-state-2.5.0/Cargo.toml`) [read] | The window is visible from config and built in setup (`src-tauri/tauri.conf.json:14-23`, `src-tauri/src/shell/mod.rs:65-90`). The theme reaches only the document (`src/hooks/useTheme.ts:33-37`, `index.html` pre-paint script). In `tauri-2.12.4`, `Window::set_background_color` works on macOS and `set_theme` is app-wide (`src/window/mod.rs:1902-1906,1992-1996`); `Webview::set_background_color` is not implemented on macOS (`src/webview/mod.rs:2364-2370`) [read] | adapt (the plugin itself: adopt) | NEW:shell, M94.9 |
| TDK-06 | Spell out the utility layout in numbers | `.group-title` is a fixed 24px; 28px buttons overhang it by −2px. Grouped background with radius 10. Rows are 48px (40 compact, 72 tall, or stacked), with hairlines inset 16px from the leading edge. Secondary text in `small`, footnotes in `.group-note`. Sheets: 56px head, 24px side padding, 56px foot under a hairline, body fading under the edge | Headings and lists line up across columns, and dense settings stay scannable | `TD/src/app.css:675-805`; `TD/src/lib/components/SettingsModal.svelte:143-422` [read] | The utility role gives an order, not numbers (`composition-sheet.md`, utility row). Settings sections are bordered cards with `py-2` rows (`src/pages/KeyboardShortcutsSettings.tsx:8-29`). The compact StateMessage row already exists (`src/styles/surface-system.css:101-105`) | adapt | M94.2, M94.8 |
| TDK-07 | Concentric corners | A token rule: inner radius = outer radius − padding. Menus 12px with 4px padding give 8px rows; segmented 8px with 2px gives 6px; a 24px tag pill with 2px inset holds a 20px button with 10px corners | Nested shapes read as one object | `TD/src/app.css:151-160`; `TD/src/lib/components/Menu.svelte:122-124`; `TD/src/lib/ui/Segmented.svelte:49-50`; `TD/src/lib/ui/TagRow.svelte:66-72` [read] | Already true in practice: `MenuSurface` is `rounded-lg p-1` with `rounded-sm` items (`src/components/ui/Menu.tsx:21,91`), and the segmented control is r-md with 2px padding around r-sm segments (`src/components/ui/SegmentedControl.tsx:13-19`). VS07 asks for it, but it is not written as a rule | already-have (write it down) | M94.2 |
| TDK-08 | Lighter weights in dark mode | `--fw-*` are re-set in dark: 450→400, 500→470, 600→570, 700→670 | Light text on dark renders heavier, so this keeps perceived weight equal across themes | `TD/src/app.css:77-85,180-186` [read] | Instrument Sans is variable, 400–700 (`src/styles/tokens/fonts.css:1-16`). Weights come from about 330 Tailwind `font-*` classes, 41 literal `font-weight`s and the `--w-*` tokens (`src/styles/tokens/typography.css:62-66`). Nothing changes in dark | adapt (compare in dark captures; 400 is the floor) | M94.2, M94.3 |
| TDK-09 | Balanced titles, pretty prose | `text-wrap: balance` on the title, headings, empty states and alert copy; `pretty` on prose | Long titles wrap evenly, with no orphan words | `TD/src/app.css:1046,1076`; `TD/src/lib/components/PageView.svelte:242`; `TD/src/lib/ui/EmptyState.svelte:58,96`; `TD/src/lib/components/ConfirmDialog.svelte:140` [read] | Only chat uses balance (`src/agent/chat.css:368,376`) | adapt (check WebKit and caret stability in the editable H1) | M94.3 |
| TDK-10 | Chrome that separates only when needed | The title bar's hairline shows only once the scroller is more than 2px down. Paths deeper than 4 collapse to first › … › parent › page | Quiet chrome at rest, separation when content is under it; long paths fit | `TD/src/lib/components/TitleBar.svelte:44-50,219-235`; `TD/src/App.svelte:323` [read] | The 64px toolbar has no scroll state (`src/components/PageToolbar.tsx`). DocPage renders the full trail (`src/pages/DocPage.tsx:804-836`) | adapt | M94.3 |
| TDK-11 | Fluid insets for spacing, steps for structure | `--page-pad: clamp(48px, 9vw, 112px)`, and per pane `clamp(28px, 9% of --pane-w, 112px)`. Layout changes use `data-below-820/720/640/560` | Margins never jump at a breakpoint, while structure still snaps | `TD/src/app.css:55,175-178`; `TD/src/lib/pane-size.ts:10-20` [read] | Stepped insets of 16/24/32px at 600/960px (`src/styles/surface-system.css:9-31`). `.cb-data-page` is already fluid at `clamp(16px,3cqw,48px)` (`:53-57`) | adapt (offer as an M94.2 variant) | M94.2 |
| TDK-12 | Panes as tiled cards | In split view each pane becomes a rounded card on the sidebar colour. The 10px gap is the divider: it has `role=separator`, moves with arrow keys and resets on double-click. The active pane gets a firmer edge and a soft lift ("not a bright line"). Dragging a page over the panes makes room, labelled "Open here / Open beside", and the drop layer keeps drops out of the editor | The active pane is clear without a coloured bar; panes can be managed by drag | `TD/src/App.svelte:359-381,502-584`; `TD/src/lib/split.svelte.ts:11-99`; `TD/src/lib/components/SplitDrop.svelte:1-40` [read] | Panes are separated by `border-r`, and the active one has a tinted 32px bar (`src/app/PaneRow.tsx:63-100`). No resizing between panes and no drag-to-open (grep) | watch (visual comparison only) | M94.3, NEW:panes |
| TDK-13 | Pane-relative layout without containing-block traps | TD avoids container queries because `container-type` would make each pane the containing block for fixed-position menus inside it. It uses ResizeObserver attributes instead | Fixed-position menus stay in viewport space | `TD/src/lib/pane-size.ts:1-9` [read] | Container queries are used throughout, including on each pane (`src/app/PaneRow.tsx:74`, `src/styles/surface-system.css:3-6`). Cerebro's own overlays portal under body (`src/components/ui/portalGeometry.ts:1-3`), and floating-ui counts `containerType` as a containing block (`node_modules/.pnpm/@floating-ui+utils@0.2.10/node_modules/@floating-ui/utils/dist/floating-ui.utils.dom.mjs`) [read] | already-have (add a check that menus land correctly with several panes) | M94.3 |
| TDK-14 | `content-visibility` table rows | `.tr { content-visibility:auto; contain-intrinsic-block-size:auto 35px }` | Cheap skipping of layout and paint for offscreen rows | `TD/src/lib/db/TableView.svelte:925-926`; `TD/README.md` ("rows out of sight skip layout") [read/docs] | Tried and removed: Chromium's accessibility tree dropped an offscreen record (`plans/2026-10-17-m84-m90-implementation-record.md:95-98`). REL-08 bars its return without proof that offscreen rows stay accessible (`specs/2026-10-23-m93-reliable-workspace-design.md:92`) | avoid | M93.7 |
| TDK-15 | One search in flight | `run(q)`: while a search is busy, keep only the latest query in `next`; when it settles, run that one. 60ms debounce and a sequence guard | Fast typing never queues stale IPC calls | `TD/src/lib/components/SearchPalette.svelte:58-90` [read] | A 250ms debounce plus a sequence check that drops stale answers, but each pause sends a new IPC call even if one is still in flight (`src/app/useContentSearch.ts:44-66`) | watch (only if the M93.6 search10000 run shows overlapping calls) | M93.7 |
| TDK-16 | Page export and print | An `html.printing` print stylesheet hides chrome and placeholders, forces the light theme and keeps blocks whole. PDF uses WebView2's PrintToPdf; there is also a DOCX writer and Copy/Export as Markdown | Gives people outside the app a format they can open | `TD/src/app.css:1781-1838`; `TD/src/lib/page-actions.ts:47-89,181-205`; `TD/src-tauri/src/pdf.rs:1-40` [read] | No print CSS and no page PDF (grep; `specs/2026-10-24-reference-audit/cerebro-baseline-ui.md` §5.1). In `tauri-2.12.4`, `Webview::print()` opens the print panel on macOS (`src/webview/mod.rs:1623-1626`) [read] | adapt (print CSS plus the native panel; Word is a separate decision) | NEW:export |
| TDK-17 | System-wide Quick Capture | The global-shortcut plugin is registered on demand. Its handler shows and focuses the window and emits `td-quick-capture`. The shortcut can be changed, and a failure switches it off | Capture without switching apps | `TD/src-tauri/src/main.rs:52-69`; `TD/src/App.svelte:84-93,216-219`; `TD/src/lib/shortcuts.svelte.ts:44` [read] | No global-shortcut plugin (`src-tauri/Cargo.toml:23-24`). In-app capture exists (prior dossier) | watch (owner decision) | M98.7 |
| TDK-18 | Motion details | Tooltip warm-up (550ms delay, then instant for 700ms); circle reveal on theme change; press `scale(.98)`; switch knob spring; toast pop | — | `TD/src/lib/components/Tooltip.svelte:15-16,55`; `TD/src/lib/look-transition.ts:25-51`; `TD/src/app.css:639-641`; `TD/src/lib/ui/Switch.svelte:31-33` [read] | Already ported, each citing thought-desk: `src/components/ui/tooltipWarmth.ts:1-13`, `src/app/shellMotion.ts:52-60`, `src/components/ui/Button.tsx:4-8`, `src/components/ui/Switch.tsx:3-5`, `src/styles/index.css:305-306` [read] | already-have | M94 (VS12) |
| TDK-19 | Database view chrome | Filter chips written as sentences, plus "N of total" and Clear. "No rows match this view" vs "No rows yet". Cards show the chosen properties or the first 4 filled ones. A bulk-action bar | — | `TD/src/lib/db/DatabaseView.svelte:132-141,390-410`; `TD/src/lib/db/TableView.svelte:669,758-760`; `TD/src/lib/db/Card.svelte:33-44` [read] | Filter chips in words, with problems marked (`src/views/FilterChips.tsx:12-27`). ViewLimitNotice. Copy for an empty filtered view (`src/views/TableView.tsx:3016`). `FieldChip` skips empty values (`src/views/FieldChip.tsx:13-14`) [read] | already-have | M94.6 |
| TDK-20 | z-index roles | A ladder of literal values: content 1–5, drop layer 20, editor menus 35–60, modal 70, cell editor 84, popover 85, menu 90, pickers 95–96, confirm 100, toast 110, tooltip 200, welcome 300 | Not named, but consistent | z-index grep across `TD/src` (e.g. `components/Modal.svelte:51`, `Menu.svelte:117`, `Tooltip.svelte:98`) [read] | Not named either: Dialog 1000, Popover 1050/1100, Toast, Tooltip and HoverCard 1100, ChordHint 100, RelationPicker 1000/1001. No `--z-*` token (`src/components/ui/Dialog.tsx:9`, `Popover.tsx:435-436`, `Tooltip.tsx:234`, `src/app/ToastHost.tsx:68`, `src/app/ChordHint.tsx:18`) [read] | adapt (name the roles as tokens) | M94.2 |
| TDK-21 | Say where the data lives | Settings → Storage lists the data folder, database/WAL bytes, file bytes, counts and version, with "Back up the folder above" | Backup becomes understandable | `TD/src/lib/components/SettingsModal.svelte:399-422`; `TD/src-tauri/src/commands.rs:522-547` [read] | Already planned: M99.8 shows in the backup UI how complete the backup is (`plans/2026-10-23-m99-rust-services-and-storage.md:301-325`). TD shows a missing size as 0 (`unwrap_or(0)`), which CV-05 forbids | adapt (confirms M99.8) | M99.8 |
| TDK-22 | Starters on an empty page, and a click area below the content | An empty body offers "Start with" template chips plus Database. A page with no title takes the starter's title. Clicking a 35vh area under the content puts the caret at the end | A blank page has an obvious next step, and the click target is large | `TD/src/lib/components/PageView.svelte:26-34,136-149,260-263`; `TD/src/lib/editor/starters.ts` [read] | Templates exist (`cerebro-baseline-ui.md` §7). Add icon/cover on hover exists (`src/detail/PageChrome.tsx:26-35`). I found no starters on an empty body and no click area below the content (grep) | watch | M94.3 |
| TDK-23 | Many themes | 6 palettes, each light and dark. A custom theme is one hue plus a tint amount, at fixed OKLCH lightness per role. 10 accents, with the mark colour on the accent picked by contrast. Sans, serif or mono for page text | People get their own look without losing contrast | `TD/src/app.css:238-436`; `TD/src/lib/prefs.svelte.ts:249-273`; `TD/src/lib/color-math.ts:87-96` [read] | One identity palette, dark made by inverting the ramps, AA contrast tests (`src/styles/tokens/colors.css`, `src/styles/contrast.test.ts`). UX-01 keeps the identity | avoid for now (watch the fixed-lightness method) | NEW:theming |

### TDK-01 flow: create where the view shows it

- **TD:**
  - `TableView.newRow(group?, template?, below?)` computes `placed`: the view has a manual order, no groups and no sub-items.
  - It calls `databases.addRow(dbId, {view, template, before: listRows[0].id | after: last.id, group})`.
  - `#defaults` builds the cells in order: first "to do" status, then the template's cells, then the view's filters, then the group.
  - Then `#create`, `#linkNew`, an undo entry and the automations hook run.
  - `fresh = [made.id, ...fresh]`, then `select` and `startEdit` the new title.
  - `pinFirst(rows, fresh)` (`query.ts:321-326`) keeps the row on top until the view is left. Board and gallery do the same with their own `fresh`.
- **Cerebro shape:**
  - Give `createTarget(typeName, {…, filters?})` a pure `filterSeeds(filters, schema)`. It returns a seed only for top-level AND rules that one value satisfies: select/status is, checkbox checked, a relation to one target, a date on one day.
  - It never seeds from OR, negation, ranges or "contains". Band and host still win over a seed on the same field, matching UX-05's host-over-group rule.
  - After creating, evaluate the entry against the view with the existing `viewFilters` engine. If it is still hidden, show a toast "Created '…' (hidden by this view's filters)" with Open. It is never hidden silently.
  - Hold `fresh` in the view's visit state (`useEntryState`); it is not persisted.
  - **Tests:** a property test that a record built from seeds passes every seeded rule; OR and negation seed nothing; the hidden notice appears.

### TDK-02 flow: data to the edge, aligned to the title

- **TD CSS chain:**
  - `DatabaseView .view-body.pad.edge { padding: 0; --edge: var(--page-pad) }`.
  - `TableView`: `--edge-l: max(0px, calc(var(--edge, 48px) - 48px))` and `--edge-r: var(--edge)`.
  - `.head-inner` and `.grid` get `{ width: max-content; min-width: 100%; padding: 0 var(--edge-r) 0 var(--edge-l) }`.
  - Sticky `.group-row`, `.empty-row` and `.bulk` sit at `left` or `margin-left: var(--edge-l)`.
  - `BoardView .columns { padding: 0 var(--edge) 16px }`.
- **Cerebro shape:**
  - Move the `.cb-data-page` inset from the container's padding into the scroll content.
  - The 40px `GUTTER` hangs in the margin when the inset is at least 40px; below that it overlaps the content, as TD's `max(0, …)` does.
  - Frozen columns stick at `left: var(--inset-l)` and need an opaque mask over the margin, so cells that scroll past them do not show beside them. TD has no frozen columns and does not pay this cost.
  - The M94.2 edge test measures where the title cell's text starts, not where the gutter starts.

### TDK-03 flow: per-column bounds

- **TD:** `limits[g.key] ?? 50`. `cardsOf(g) = pinFirst(g.rows, fresh).slice(0, limit)`. The column foot shows "Show more ({rows − limit} left)", which adds 200.
- **Cerebro shape:**
  - Apply the bound inside BoardView, per band, after sorting. Keep `ViewLimitNotice` for table and list.
  - Add M93.6 workloads: `board5000` (one column and a grouped variant), `gallery5000` and `list5000`.
  - Assert mounted card counts per column, that "Show more" is reachable by keyboard, and that the remaining count is shown.

### TDK-04 flow: close the reload hole

- **TD:**
  - `onContextMenu`: if the target is not inside `input, textarea, [contenteditable=true|plaintext-only]`, call `preventDefault`.
  - `onKeydown` in production: F5 and mod+R call `preventDefault`.
  - `visibilitychange` hidden runs `flushAll`. `onCloseRequested` dispatches `td:flush` and then runs `flushAll`.
- **Cerebro shape:**
  - Add one document-level `contextmenu` listener in the shell. It lets editable fields and components with their own menus through. It is not a keydown listener, so it sits outside the CV-47 rail.
  - `pagehide` cannot wait for a flush, so preventing the reload is the fix, not handling it afterwards.
  - Add a native case to M93.11: right-clicking the page background in the packaged app offers no Reload. This needs verifying in WKWebView.
  - Map mouse buttons 3 and 4 to the existing `navStore` Back and Forward.

### TDK-05 flow: window lifecycle

- **TD:**
  - Config `visible:false`.
  - The window-state plugin restores the frame.
  - The page loads.
  - An effect calls `win.setTheme(dark ? 'dark' : 'light')`.
  - On `requestAnimationFrame`: `cssToRgb(getComputedStyle(body).backgroundColor)`, then `setBackgroundColor`.
  - Two frames later, or after 500ms, `show()` and `setFocus()`.
- **Cerebro shape on macOS:**
  - Set `visible:false` in `tauri.conf.json`.
  - After the first `applyTheme`, one IPC call through `lib/ipc.ts` (CV-18) reaches a Rust command. It calls `Window::set_theme` (app-wide on macOS), `Window::set_background_color`, then `show()`.
  - A Rust-side fallback timer shows the window anyway, so a failed webview never leaves the app invisible.
  - Use the window-state plugin with SIZE, POSITION and MAXIMIZED.
  - **M94.9 native cases:** dark theme on a light OS, launch and resize, no white flash; the window reopens at its last frame.

## Avoid / doesn't transfer

- **`content-visibility` rows (TDK-14):** Cerebro measured the accessibility regression; TD never tested accessibility.
- **Many themes (TDK-23):** the identity rule (UX-01) holds, and each palette would need its own contrast tests. Revisit only with an owner request.
- **Frosted materials:** TD uses `backdrop-filter: blur(28–40px) saturate(.2)` (`app.css:584-593`, `Modal.svelte:80-84`), with a scrim that fades its colour rather than its opacity (`Modal.svelte:56-58`). It costs GPU time and hurts legibility over busy content. Cerebro's opaque, bordered surfaces read better.
- **`corner-shape: superellipse(1.6)` on `*`** (`app.css:160,463-474`) is Chromium-only and does nothing in WKWebView, so do not tune radii around it.
- **Counts that speak first:** sidebar counts for due, today and cards (`Sidebar.svelte:86-97`), a Trash badge (`TitleBar.svelte:69-74,198`), Home empty-lane copy such as "A free day" (`HomeView.svelte:118,134`), and the semester setup checklist (`ui/SetupCard.svelte`). These break Home's pull-only rule, its silent empty lanes and its no-sidebar-count rule (AGENTS.md, M64.4).
- **Global overlay stores with weak a11y:**
  - The menu leaves focus on its trigger and drives a virtual selection from window keydown (`Menu.svelte:36-68`).
  - The tooltip has no `aria-describedby` (`Tooltip.svelte:81-92`).
  - The segmented control has no arrow keys (`Segmented.svelte:20-34`).
  - There is no `isComposing` check anywhere (grep) and no frontend tests (`package.json:12-19`).
  - Cerebro's `layers.ts`, keymap and Dialog are the better model.
- **Physical-key shortcuts:** `e.code`, with Mod labelled Ctrl (`shortcuts.svelte.ts:115-127`), is a Windows convention; macOS shortcuts follow the typed character. Rebinding, with reserved editor keys and taking a combo from another command, is a later "watch".
- **WebView2-only code:** memory trimming and suspend while minimized (`memory.rs`) and PrintToPdf (`pdf.rs`) have no macOS equivalent through Tauri. Cerebro already sets `backgroundThrottling: disabled`.
- **File garbage collection:** TD deletes unreferenced files older than 24h (`files.rs:98-118`), which breaks CV-37 (nothing is hard-deleted).
- **HLC sync outbox (`sync.rs`):** groundwork for multiple devices. Cerebro is single-user, and the earlier decision was no HLC.
- **Absent shown as zero, and toast-only errors:** `data_info` uses `unwrap_or(0)` (`commands.rs:523-527`), and `ui.error` only toasts and logs (`ui.svelte.ts:223-226`). Cerebro's CV-05 and CV-03 are stronger.
- **"Only one editor alive at a time" (README):** this conflicts with Cerebro's four panes and their parked editing state (M65.9). Measure memory instead (prior dossier, rank 1).

## Implications for M93–M99

- **M93**
  - **Amend M93.2:** add webview reload through the context menu to the leave inventory, and fix it by preventing it (TDK-04).
  - **Amend M93.6:** add board (one 5,000-card column, plus a grouped variant), gallery and list workloads, with DOM counts per layout (TDK-03).
  - **Amend M93.7:** paging each board column is the board's "explicit paging" candidate. **Confirm** REL-08's ban on `content-visibility` (TDK-14). Make search single-flight only if measurement shows overlapping calls (TDK-15).
  - **Amend M93.11:** add native cases for right-click with no Reload, launch and resize in dark theme on a light OS with no white flash, and the window frame restored (TDK-04, TDK-05).
- **M94**
  - **Amend M94.2:** the composition sheet gains:
    1. the measured edge is the first readable text, and hover-only gutters hang in the inset (TDK-02);
    2. 24px section-heading rows, grouped-row heights and inset separators, and the sheet head and foot (TDK-06);
    3. the concentric radius rule (TDK-07);
    4. z-index role tokens (TDK-20);
    5. a fluid-inset variant beside the 16/24/32px steps (TDK-11);
    6. a dark weight-trim comparison (TDK-08).
  - **Amend M94.3:**
    - balanced title and headings, checked for caret stability (TDK-09);
    - the scroll hairline and breadcrumb collapse (TDK-10);
    - a four-pane test that menus and popovers land at their anchors inside `@container/canvas` panes (TDK-13);
    - tiled pane cards as an optional owner comparison (TDK-12).
  - **Amend M94.5:** map mouse Back/Forward to the existing navigation (TDK-04).
  - **Amend M94.6:** creation seeded from filters, with the created-but-hidden notice and pinning (TDK-01); data that runs to the pane edge, with a frozen-column mask (TDK-02); a bound per board column (TDK-03).
  - **Add NEW:shell:** proven in M94.9. The window stays hidden until painted, the native theme and background follow the app, and it uses the window-state plugin (TDK-05).
  - **Add NEW:export:** a print stylesheet plus `Webview::print()`, which lets the person save a PDF (TDK-16).
- **M95–M97:** no change. TD has no model, agent, MCP or evidence features; the prior dossier's ranks 7 and 9 still hold.
- **M98:** **confirm** M98.8 (intake, date overlays and record rules, from prior dossier ranks 5, 6 and 8). M98.7 depends on the owner's answer on a system-wide Quick Capture (TDK-17).
- **M99:** **confirm** M99.8's storage and backup disclosure, and show a size that could not be read as "not recorded", never 0 (TDK-21).

## Owner questions

1. When someone clicks New in a filtered view, should the record take the filter's values so it appears there, or be created without them and show "hidden by this view's filters"? Taking the values writes things the person did not type.
2. Should wide tables scroll out to the pane edge with the first column under the title, as in TD, or keep the current scroller that stops at the inset?
3. Do you want a system-wide Quick Capture hotkey (opt-in, using the official global-shortcut plugin)?
4. Do you want page Export as PDF through the native print panel, given that the Markdown file is the canonical export?
