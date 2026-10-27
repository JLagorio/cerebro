# Plane DS, components and UI composition - reference audit 2026-10-24

> **Scope:** slice PLN covers Plane's design-system layer, its components and how its UI is composed, plus architecture the earlier dossier missed. I did not repeat the [prior Plane dossier](../../plans/2026-10-22-ai-expansion-review/plane.md) (PL01–PL10: actions, webhooks, drafts/intake, YAML authority, selected-text AI, connections, relations, views, history, scope) or [VS01–VS13](../../plans/2026-10-22-ui-refresh-review/02-visual-system.md). That review saw only a Plane promo image, not the code.
> **Read:** about 75 Plane files, about 45 Cerebro files, 12 program docs (master roadmap, implementation record, M94 spec/plan/README/composition sheet, M93/M95–M99 phase lists, M98 spec §steps). Nothing was built, run or installed. Counts come from grep over TSX/TS/CSS.
> **Licence:** Plane is AGPL-3.0-only ([PL/LICENSE.txt](../../../examples/plane-preview/LICENSE.txt):1-2, `PL/COPYRIGHT.txt`:1-2). Cerebro is Apache-2.0 (`LICENSE`). So these are **ideas only, re-implemented**. No code port, and therefore no `adopt` verdicts.
> **Gap:** the primitives (`@makeplane/propel` 0.7.3: buttons, menus, dialogs, token *values*, icons, Storybook) are an **npm dependency that is not in this snapshot** (`PL/pnpm-workspace.yaml` catalog; `PL/AGENTS.md` "Components"). `PL/packages/ui` and `PL/packages/propel` do not exist. Statements about propel internals come from call sites and code comments only.
> **Prefix:** `PL/` = `docs/examples/plane-preview/`. **Basis:** [read] = I read the code (grep counts are [read]) · [names] = inferred from file or dir names · [docs] = from README/docs/doc-comments.

## Top findings

- **Call sites use roles, not ramps (M94.2, M94.9).** Plane's TSX is about 99% semantic: 3,317 role utilities (`bg-layer-1`, `text-secondary`, `border-subtle`) against 31 raw-palette ones. A written rule set backs this: canvas → surface → layer, plus matched `-hover/-active/-selected` suffixes ([read] `PL/packages/tailwind-config/AGENTS.md`:9-485). Cerebro is the reverse.
  - Cerebro TSX has about 3,260 raw-ramp refs and about 70 semantic ones. No ink or line role utility exists (`src/styles/index.css`:17-111).
  - The contrast test checks only role tokens (`src/styles/contrast.test.ts`:34).
  - Meanwhile `text-n-500` (4.35:1 on white, 3.99:1 on `n-50`) sits on about 297 sized-text lines, and `text-n-400` (3.49:1) on about 213. This includes new M94.4 code (`src/app/CreationDraftRecovery.tsx`:22) and an error line (`src/app/StarterOffer.tsx`:81).
- **Contain render faults (NEW, proposed M93.12).** Plane wraps every layout in a boundary keyed by layout. Retry remounts it through a key bump ([read] `PL/apps/web/components/common/layout-error-boundary.tsx`:36-56; `…/issue-layouts/issue-layout-HOC.tsx`:62).
  - Cerebro has **zero** boundaries (grep `getDerivedStateFromError|componentDidCatch|ErrorBoundary` in `src`), and `createRoot` takes no error callbacks (`src/main.tsx`:15).
  - React's documented behaviour is to unmount the root on an uncaught render error [docs]. So one bad record shape can blank all four panes.
- **Set the reading width per block, not per page (M94.3).** Plane centres each top-level block at one width variable. Wide blocks (tables) break out but stay aligned to the text edge. The toolbar and the loading skeleton use the same variable, and container queries set the margins ([read] `PL/packages/editor/src/styles/variables.css`:14-15, 198-300; `…/table/table/table-view.tsx`:61).
  - Cerebro caps the whole content box at 880px, or removes the cap entirely when the page is set to full width (`src/pages/pages.css`:171-180).
- **Loading keeps the layout's shape; a refresh keeps the content (M94.8).** Plane shows a skeleton shaped like the active layout only on the first load (`init-loader`). A `mutation` or `pagination` load keeps the rows on screen ([read] `issue-layout-HOC.tsx`:23-62; `PL/packages/types/src/issues/base.ts`:16).
  - Cerebro has no skeleton anywhere. Loading is one line of text (`src/components/ui/StateMessage.tsx`:4), and CV-44 has no "refreshing" state.
- **Blocked actions say why, at every entry point (M94.5).** Plane's menu rows are data that carry a reason line. The same arrays feed both the right-click menu and the dropdown ([read] `PL/packages/blocks/src/context-menu/types.ts`:17-65).
  - Cerebro's `when` returns only true/false (`src/lib/keys/registry.ts`:32). `ContextMenuItem` has no disabled flag and no reason field (`src/components/ui/ContextMenu.tsx`:6-11).
- **Side-panel state belongs to the place (M94.5).** Plane keeps the page pane's tab and the previewed version in the URL. That makes them deep-linkable, and Back closes the preview ([read] `PL/apps/web/components/pages/navigation-pane/root.tsx`:59-93).
  - In Cerebro, the Details/Comments/History choice and its open flag are single `uiStore` values that every `DocPage` reads (`src/stores/uiStore.ts`:197; `src/pages/DocPage.tsx`:201-224). They are not per pane, and Back does not restore them.
- **Contrast is a theme, and elevation is a role (M94.2, M94.9).** Plane ships light and dark high-contrast themes ([read] `PL/packages/constants/src/themes.ts`:7). Its shadows are named by role: `shadow-raised-*` and `shadow-overlay-*` (`PL/packages/blocks/src/select/menu-parts.tsx`:43-53).
  - Cerebro has light, dark and system only (`src/stores/uiStore.ts`:29). Its shadows are named by size, and its z-indexes are literal numbers.
  - Dark mode already re-points the colour ramps (`src/styles/tokens/colors.css`:207-227). That makes a `prefers-contrast: more` block cheap to add.

## Map

| Area | Path | What it does |
| --- | --- | --- |
| DS rules | `PL/packages/tailwind-config/AGENTS.md` | Canvas (once) → surfaces (siblings) → layer N on surface N; hover must match its base; decision tree; text/border roles |
| Token entry | `PL/packages/tailwind-config/index.css`:1-17 | Imports `@makeplane/propel/styles`; notes "token values are propel's… drift needs a visual pass" |
| Primitives (external) | `PL/pnpm-workspace.yaml` overrides; `PL/packages/blocks/src/select/menu-parts.tsx`:13-27 | `propel/components/*` = Base UI behaviour + style; `elements/*` = style-only chrome grafted on through `render`; one shared Base UI copy is required |
| Composite blocks | `PL/packages/blocks/package.json`, `src/*` | Select engine, property selects, toast, confirm dialog, context menu, empty state, layout, skeleton, virtual list |
| Theme runtime | `PL/apps/web/app/root.tsx`:76; `PL/packages/constants/src/themes.ts`:7 | next-themes with 5 themes: light, dark, light-contrast, dark-contrast, custom |
| Custom theme | `PL/packages/utils/src/theme/{theme-application,palette-generator,theme-inversion,constants}.ts` | Builds OKLCH ramps from 2 seed colours and writes only the base ramps on `<html>` |
| Shell | `PL/apps/web/components/workspace/content-wrapper.tsx`; `…/navigation/app-rail-root.tsx`; `PL/apps/web/lib/app-rail/*` | Canvas, then top nav, then an optional rail, then content inset 8px |
| Sidebar | `PL/apps/web/components/sidebar/resizable-sidebar.tsx` | Resizes 236–350px, collapses, shows a peek on hover |
| Tab overflow | `PL/apps/web/components/navigation/{use-responsive-tab-layout,use-tab-preferences}.ts`, `customize-navigation-dialog.tsx` | Measures tabs, pins the active one, moves user-hidden tabs to "More"; sets a default tab; pins and reorders nav items |
| Header/row | `PL/packages/blocks/src/layout/{header,row,content-wrapper}/*` | Three header variants; `px-page-x`/`py-page-y` page gutters |
| Layout gate | `…/issue-layouts/issue-layout-HOC.tsx`; `PL/apps/web/components/ui/loader/layouts/*` | Chooses skeleton, empty state, error boundary or content |
| Generic layouts | `PL/packages/types/src/base-layouts/base.ts`; `PL/apps/web/components/base-layouts/*` | list/kanban/gantt over one normalized contract |
| Spreadsheet | `…/issue-layouts/spreadsheet/*`; `…/core/render-if-visible-HOC.tsx`; `…/hooks/use-table-keyboard-navigation.tsx` | Sticky-column shadow set on the DOM directly, offscreen placeholders, arrow-key cell navigation |
| Page anatomy | `PL/apps/web/components/pages/editor/{page-root,editor-body}.tsx` | Version overlay, toolbar, page banner, body, right pane |
| Page pane | `…/pages/navigation-pane/*`; `…/pages/version/*` | Tab and version held in the URL; extension slot; version preview overlays the editor |
| Editor geometry | `PL/packages/editor/src/styles/variables.css` | Width, breakout, container queries; reading-preference token sets |
| Peek | `PL/apps/web/components/issues/peek-overview/view.tsx` | Three modes; Escape returns focus to the row; outside-click guarded by open layers |
| Rich filters | `PL/packages/types/src/rich-filters/{expression,adapter}.ts`; `PL/apps/web/components/rich-filters/*` | Filter tree with adapters to views and automations; "invalid filter" chip |
| Domain glyphs | `PL/packages/blocks/src/icons/state/*`, `priority-icon.tsx` | Status-group glyphs, with a progress pie for "started" |
| Tests | `PL/packages/blocks/src/**/*.test.tsx` | The only frontend tests in the snapshot: 21 files; `select.test.tsx` has 80 cases. web, editor and utils have none, and there are no stories |

## Patterns that work

| ID | Pattern | Mechanism | Why it works | Evidence | Cerebro today | Verdict | Phase |
| --- | --- | --- | --- | --- | --- | --- | --- |
| PLN-01 | Colour roles at call sites | Base ramps (`--neutral-*`, `--brand-*`, `--alpha-*`) → semantic tokens → role utilities; rules: canvas once, layer N on surface N, hover/active/selected matches its base | Themes and contrast checks reach every call site; review and agents can apply the rules | [read] `PL/…/tailwind-config/AGENTS.md`:55-260, 433-500; 3,317 vs 31 grep | Ramps are exported as utilities, with no ink/line roles (`src/styles/index.css`:37-111); about 3,260 raw vs about 70 semantic in TSX; the contrast test checks only roles (`src/styles/contrast.test.ts`:34) | adapt | M94.2, M94.9 |
| PLN-02 | Render-fault containment | A class boundary keeps `{hasError, retryKey}`; the fallback shows Retry; Retry bumps the key on `<Fragment key>`; the HOC keys the boundary by layout | One bad shape degrades one region, and switching layout resets it | [read] `PL/…/common/layout-error-boundary.tsx`:36-56; `issue-layout-HOC.tsx`:62; `PL/apps/web/app/root.tsx` `ErrorBoundary` | No boundary in `src`; `createRoot` without `onUncaughtError` (`src/main.tsx`:15) | adapt | NEW:fault-containment (M93), M94.8 |
| PLN-03 | Reading width per block, with breakout | `.ProseMirror > *:not(.editor-full-width-block)` gets `max-width: var(--editor-content-width); margin: auto`; a breakout block gets `padding-inline-start: calc((100% - W)/2)`; the toolbar uses the same formula; container queries set the margins | Text keeps its measure, data gets the pane, and all edges line up | [read] `PL/packages/editor/src/styles/variables.css`:198-300; `…/table-view.tsx`:61; `PL/…/editor-body.tsx` (loader shares the width) | Whole box capped at 880px, or none when `full_width` (`src/pages/pages.css`:171-180; `src/styles/tokens/spacing.css`:35) | adapt | M94.3 |
| PLN-04 | Skeleton on first load only | `ActiveLoader(layout)` on `init-loader`; empty state at count 0 (calendar exempt); `mutation`/`pagination` keep content | No layout jump; a refetch never blanks the view | [read] `issue-layout-HOC.tsx`:23-62; `PL/packages/types/src/issues/base.ts`:16; `PL/apps/web/components/ui/loader/layouts/*` [names] | Loading is a text `StateMessage` (`src/components/ui/StateMessage.tsx`:4); no skeleton; five-state CV-44 has no refreshing state | adapt | M94.8, M94.6 |
| PLN-05 | Menu rows as data, with a reason | `TContextMenuItem{key,title,description,icon,action,variant,shouldRender,closeOnClick,disabled,nestedMenuItems}`; factories; context menu and dropdown render the same arrays | Labels, availability and blocked reasons cannot drift between entry points | [read] `PL/packages/blocks/src/context-menu/types.ts`:17-65; `PL/apps/web/components/common/quick-actions-factory.tsx` | `when?: () => boolean` (`src/lib/keys/registry.ts`:32); `ContextMenuItem{icon,label,danger,onSelect}` (`src/components/ui/ContextMenu.tsx`:6); MenuItem's reason only via `title` (`src/components/ui/Menu.tsx`:100-121) | adapt | M94.5 |
| PLN-06 | Panel state in the location | `?paneTab=` and `?version=`; leaving Info drops the version param; an extension claims the pane by `triggerParam`; the overlay width is `100% - pane` | Deep links and Back work; the history list stays visible during preview | [read] `PL/…/navigation-pane/root.tsx`:59-93; `PL/…/version/root.tsx`:40 | Global `docPanel`/`docPanelOpen` (`src/stores/uiStore.ts`:197) read by every `DocPage` (`src/pages/DocPage.tsx`:201-224) | adapt | M94.5 |
| PLN-07 | Contrast themes | Two contrast themes as first-class options; a custom theme rewrites only the base ramps and on-colour ink, so the semantic layer follows | Accessibility without per-component rules | [read] `PL/packages/constants/src/themes.ts`:7; `PL/packages/utils/src/theme/theme-application.ts`:94-136 | `ThemeMode` light/dark/system (`src/stores/uiStore.ts`:29); no `prefers-contrast` in `src`; dark mode re-points ramps (`src/styles/tokens/colors.css`:207-227) | adapt | NEW:contrast-theme, M94.9 |
| PLN-08 | Elevation as roles | `raised` = layer-1 + overlay-100; overlay card = layer-2 + `shadow-overlay-200`; `elevation=` prop on popups | Shadows mean "floats above", not a size choice | [read] `PL/packages/blocks/src/select/menu-parts.tsx`:43-60; usage `shadow-raised-200`×23, `-100`×10 | Size-named `--shadow-xs…lg` (`src/styles/tokens/spacing.css`:25-30); z literals 1000/1050/1100 (`src/components/ui/Dialog.tsx`:9, `src/components/ui/Popover.tsx`:435, `src/app/ToastHost.tsx`) | adapt | M94.2 |
| PLN-09 | Status glyph from status group | Five fixed groups each get a glyph shape (dashed, empty, progress pie with `percentage`, check, x); colour comes from the option | State reads without relying on colour | [read] `PL/packages/blocks/src/icons/state/state-group-icon.tsx`:26-45 | Groups exist as data (`shared/schema/field-kinds.v1.json` `status_groups`); the chip draws a dot, with "hollow" as a per-option flag (`src/views/FieldChip.tsx`:6-10, 43-58) | adapt | M94.6 |
| PLN-10 | Tab overflow | ResizeObserver on the container; reserve space for the overflow button; swap the active tab into the last visible slot; merge user-hidden tabs into "More" (with Show) | Every tab stays reachable in a narrow pane, and the active one never hides | [read] `PL/apps/web/components/navigation/use-responsive-tab-layout.ts`:68-160; `use-tab-preferences.ts` | Scroll strip with hidden scrollbar and edge fade; no active-tab reveal (`src/views/ViewTabs.tsx`:115, 235-236) | adapt | M94.6 |
| PLN-11 | One Select engine | `variant` = chrome × size template literal (`pill-sm`, `table-cell`, `select-lg`…); id-first values keep unresolved ids ("Ruling 46"); keyboard skips disabled rows; header/footer slots reachable with Tab; `emptyMessage(query)`; infinite + virtualized | One picker behaves the same in cells, rows and forms | [read] `PL/packages/blocks/src/select/types.ts`:15-115; `root.tsx`:134; `use-skip-disabled-rows.ts`; 80 tests | Single value, sync, outline/ghost (`src/components/ui/Select.tsx`:34-79, 32 tests); RelationPicker already id-first (`src/detail/RelationPicker.tsx`:44-55) | adapt | M94.6, M96.2, M98.9 |
| PLN-12 | Consequential-confirm funnel | A typed union ties `isSubmitting` to a loading label; `onOpenChange` returns early while submitting (Escape and cancel vetoed); an outside press never closes | Double submit and mid-flight dismissal are impossible by construction; behaviour is tested | [read] `PL/packages/blocks/src/dialog/confirm-dialog.tsx`:72, 127-131; `confirm-dialog.test.tsx`:126-171 | `DialogAction{label,onClick,disabled}` with no busy state; a scrim press closes (`src/components/ui/Dialog.tsx`:36-41, 193); in-flight labels written per caller (`src/app/CreateMenu.tsx`:121, `src/app/RecordComposer.tsx`:123) | adapt | M96.3, M96.5 |
| PLN-13 | Migration by shim | Keep the call-site shape; map deprecated props (`className` containing `text-danger` → `danger`); drop unrenderable values with a dev warning; record call-site counts and numbered Rulings | Hundreds of call sites move with an import change | [read] `PL/packages/blocks/src/toast/toast-manager.ts` header ("~650 call sites"); `context-menu/types.ts`:13-16, 58-63; Ruling 25 (`PL/packages/blocks/src/empty-state/action-button.tsx`:12), 28/46 (`PL/packages/blocks/src/select/*`), 39 (`PL/packages/blocks/src/breadcrumb/*`) | CV-NN rules and lint rails exist (`AGENTS.md`; `scripts/lint-rails.test.ts`; `eslint.config.js`:67-75); no retirement ledger for M94 adoption | adapt | M94.6–M94.8 |
| PLN-14 | Filter-tree adapters | `IFilterAdapter{toInternal,toExternal}` lets one condition/group tree UI serve work-item views and automations; a deleted property renders an "Invalid filter" chip | One condition editor, and stale references show up instead of vanishing | [read] `PL/packages/types/src/rich-filters/{adapter,expression}.ts`; `PL/apps/web/components/rich-filters/filter-item/invalid.tsx` | FilterBuilder/FilterChips plus ViewProblems for views (`src/views/ViewProblems.tsx`); M98 defines its own predicate AST (`docs/superpowers/specs/2026-10-23-m98-workflows-and-automation-design.md`:186-199) | adapt | M98.9 |
| PLN-15 | Reading preferences per person | Class-scoped token sets on `.editor-container` (font size large/small, sans/serif/mono, line spacing); width stored in user config, not in the page | Taste stays out of documents | [read] `PL/packages/editor/src/styles/variables.css`:45-194; `PL/apps/web/hooks/use-page-filters.ts`:14-36 | `full_width` is written into page frontmatter (`src/stores/vaultStore.ts`:459-496); no font preferences | watch | NEW:reading-prefs |
| PLN-16 | Container queries for geometry | Page content and toolbar are named containers; margins and outline visibility depend on container width | Pane width, not window width, drives layout | [read] `PL/…/variables.css`:198-300; yet the app is mostly viewport-driven (`md:`×187 vs `@container`×10), with sidebar-state workarounds (`PL/apps/web/components/core/list/list-item.tsx`:73) | `.cb-composition` inline-size container (`src/styles/surface-system.css`:1-30); `@min-[560px]/viewtabs` (`src/views/ViewTabs.tsx`:235) | already-have | M94.2 |
| PLN-17 | Toast as a closed data surface | Actions are data (at most 2 + 1 primary); loading toasts persist; a promise toast settles in place | No markup escapes into the toast | [read] `toast-manager.ts`:37, 102-150, 205 | One live region that exists before any toast, hover/focus pause, 6s/10s timings, data action (`src/app/ToastHost.tsx`:9, 16, 77; `src/components/ui/Toast.tsx`) | already-have | — |
| PLN-18 | Shared layout data contract | `items` map + `groupedItemIds` + `groups` + render props + `onDrop(src,dst,srcGroup,dstGroup)` | Layouts swap without reshaping data | [read] `PL/packages/types/src/base-layouts/base.ts` | Pure engine: `groupEntries`, `groupTree`, `movedBandValue` (`src/engine/grouping.ts`:54, 340, 401), used by Board/Gallery/Chart | already-have | — |
| PLN-19 | Peek with focus return | Side/modal/full modes; Escape focuses `#issue-<id>`; outside-click ignored while modals/dropdowns are open | Keyboard users land back where they were | [read] `PL/apps/web/components/issues/peek-overview/view.tsx`:57, 86-129 | Docked peek with its own key scope and `peek.next/prev` (`src/detail/DetailPanel.tsx`:154, 240-261); the layer stack owns Escape and outside presses (`src/components/ui/layers.ts`:1-45) | already-have | — |
| PLN-20 | Resizable sidebar | Drag between bounds, double-click to collapse, hover peek with a 500ms leave timer | Collapsed navigation stays near the pointer | [read] `PL/apps/web/components/sidebar/resizable-sidebar.tsx`:37-45, 205-220 (the separator has no keyboard support) | Separator with arrow keys and `aria-valuenow` (`src/components/ui/ResizeHandle.tsx`:102-121); the rail reopens a collapsed sidebar (`src/app/Sidebar.tsx`:1075); no hover peek (watch) | already-have | — |
| PLN-21 | Version list + preview | Timeline list with the current version first; each row links `?version=`; the overlay keeps the list visible | Compare before restoring | [read] `PL/…/navigation-pane/tab-panels/info/version-history.tsx`; `PL/…/version/root.tsx` | `src/git/VersionPreview.tsx`; hash-guarded preview and restore (`src/history/RecoveryVersions.tsx`:40-172) | already-have | M94.5 (state only) |

### PLN-01 — role vocabulary for Cerebro

- **Plane flow:** base ramps, written by `applyCustomTheme` only for custom themes (`theme-application.ts`:115-136), feed semantic tokens (`--background-color-layer-2`, `--text-color-secondary`), which feed utilities. The rules live next to the tokens (`AGENTS.md`:151-260, decision tree :433).
- **Cerebro:** export ink/line roles beside the existing `--color-surface-*` (`src/styles/index.css`:89).
  - Proposed names: `text-ink-{primary,secondary,meta,disabled}` and `border-line-{subtle,strong}`. These avoid the `text-metadata` size name.
  - Keep ramps for swatches, options and avatars only.
- **Rail (CV-12 ratchet):** count raw-ramp ink inside `className` and fail if the count grows; new files must have zero. Implement it with the same machinery as the CV-63 rail (`eslint.config.js`:67-75, `scripts/lint-rails.test.ts`).
- **Contrast:** extend `src/styles/contrast.test.ts` to the role × surface pairs that are actually rendered.
- **Usage rules:** write them as a dev skill (CV-17 list). Most UI here is written by agents, and the new M94.4 code still reached for `text-n-500`.

### PLN-02 — fault containment

- **Plane:** `LayoutErrorBoundary` sets `getDerivedStateFromError → {hasError:true}`. Retry runs `setState(retryKey+1)`, which remounts `<Fragment key={retryKey}>`. Its parent is keyed by layout (`issue-layout-HOC.tsx`:62).
- **Cerebro (proposed `SectionBoundary`):**
  - The fallback is `StateMessage state="unavailable"` with Retry. That keeps CV-05: a crash never reads as empty.
  - Place one at each pane root (`data-pane-index`), each view canvas, each rail card and each lab section.
  - Root: `createRoot(el, {onUncaughtError, onCaughtError})` writes only to the diagnostic log. CV-06 already makes that log write-only.
  - Tests: a throwing view in pane 2 leaves pane 1 editable, and Retry after recovery keeps the retained draft. This depends on the M93.1 retained save owners.

### PLN-03 — document geometry

- **Plane:**
  - `--normal-content-width: 720px` and `--wide-content-width: 1152px` set `--editor-content-width` on `.frame-renderer`.
  - Ordinary blocks are capped at that width; tables carry `editor-full-width-block` and span the full width.
  - The toolbar's `padding-left: calc(((100% - var(--header-width))/2) - 10px)` aligns it to the text.
  - Container queries: below 760px margins are 20px, from 912px to 1344px wide pages get 96px, and below 930px the floating outline hides.
- **Cerebro:** make `.cb-document-content` full pane width.
  - Cap top-level `.bn-block-outer` at `var(--prose-measure)` and let database, table, sheet, diagram and columns blocks break out.
  - Reserve the side-menu gutter (VS02).
  - Use the same variable for the projected title, properties, tabs, toolbar and loading geometry.
  - `full_width` keeps meaning "wide measure". The measure value stays the M94.3 owner choice (700–760).

### PLN-05 — blocked reasons

- **Plane:** `description` renders as a muted second line, and the same arrays feed both the context menu and the dropdown (`context-menu/types.ts`:24-31). The factories set `shouldRender`, `disabled` and `description` (`quick-actions-factory.tsx`).
- **Cerebro:** allow `when` to return `{kind:'blocked', reason}` as well as a boolean. This stays compatible with today's callers (`src/lib/keys/registry.ts`:29-33).
  - Derive menu rows from `CommandDef` (label, keys hint) together with that availability.
  - `ContextMenuItem` gains `disabled?` and `reason?`.
  - Test: one blocked command shows the same reason in the palette, the page menu and the context menu. This is what M94.5 asks for ("disabled blockers at every entry point").

### PLN-06 — panel in the visit slot

- **Plane:** `handleTabChange` writes `paneTab` and drops `version` when leaving Info (`navigation-pane/root.tsx`:75-85); the version overlay is open when `!!searchParams.get(version)`.
- **Cerebro:** store `{panelOpen, panel, historySelection?}` in the pane's visit state (`src/app/useEntryState.ts`), keyed by entry path. The `uiStore` value becomes only the default for new visits.
  - Tests in `e2e/{panes,history-state}.spec.ts`: two panes keep different panels, and Back restores the panel and the preview.

## Missed by the prior dossier (architecture)

- **The primitives are a versioned external package with an adapter layer.** `@plane/blocks` wraps propel, and shims keep old call shapes compiling ([read] `PL/packages/blocks/package.json` description; `toast-manager.ts` header).
  - The cost is recorded in code: token values drift silently (`PL/packages/tailwind-config/index.css`:10-14; `PL/packages/utils/src/theme/constants.ts` `ALPHA_MAPPING` "must mirror… drift… silently").
  - The closed API needs workarounds (Ruling 28: propel's min-width floor and missing width axis; TabsPanel takes no className, so wrappers are added).
  - Lesson for M94.6–M94.8: count the variants being retired, and ratchet that count.
- **The migration is unfinished in the reference itself.** Five-plus empty-state implementations are live: blocks Compact (19 files) and Detailed (22), plus legacy Detailed (8), Simple (10), Section (2) and `common/empty-state` (8). Two type scales coexist: `text-13` (×504) and `text-body-xs-regular` (×49) ([read] grep).
- **Filter adapters** (PLN-14) are the one architecture addition that bears on M98. The prior PL08 covered saved views, not the adapter.
- **Collaboration stage maps to three UI statuses, and the fallback is spelled out.** Disconnected → error, synced → synced, anything else → syncing. The tooltip states the fallback: "saved every 10 seconds" ([read] `PL/apps/web/components/pages/editor/editor-body.tsx` `serverHandler`; `…/pages/header/syncing-badge.tsx`).
  - Cerebro's `SaveState` covers the same states, but its failed state carries no explanation (`src/components/PageToolbar.tsx`:141-160). M93.1 copy could name what happens next.

## Avoid / doesn't transfer

- **Custom 2-seed theme generator.** It conflicts with UX-01 (cortex/synapse identity), and it reloads the window after saving (`PL/apps/web/components/appearance/theme-switcher.tsx` `window.location.reload()`).
- **A closed primitive API (no `className`) as the main lever.** Plane still has 400 raw `<button>` against 231 `<Button>`. Cerebro rarely overrides `Button` (7 of 239). Spend the effort on PLN-01, not on re-closing primitives.
- **A positive `tabIndex` registry** (`PL/packages/constants/src/tab-indices.ts`:7; `PL/packages/utils/src/tab-indices.ts`:15 `baseTabIndex = 1`). This is a WCAG anti-pattern; Cerebro uses DOM order and layers.
- **Offscreen rows as empty placeholders** (`…/spreadsheet/issue-row.tsx`:91-100 `colSpan={100}`). Row text is absent from the DOM, which fails M93.7's find, End and VoiceOver tests.
- **A separate title editor on a Y.Doc field** (`PL/packages/editor/src/hooks/use-title-editor.ts`). It needs a CRDT and a second writer; Cerebro's first-H1 projection keeps CV-21.
- **Inset card-on-canvas shell and dockable rail with label modes** (`content-wrapper.tsx`, `app-rail-root.tsx`). The owner chose an edge-to-edge canvas and a 54px rail (M71–M79).
- **Viewport breakpoints switched by sidebar state** (`list-item.tsx`:73), and breadcrumbs that collapse at viewport ≤640px (`PL/packages/blocks/src/breadcrumb/breadcrumbs.tsx`:26). Neither works for panes.
- **Ad hoc motion and a large lint budget.** Plane uses `transition-all duration-300` ×35 with little `motion-reduce` handling, and `--max-warnings=11957` (`PL/apps/web/package.json`). Cerebro's motion tokens and zero-warning policy are stronger.
- **Hard-coded hex state colours** (`state/helper.tsx` `STATE_GROUP_COLORS`). They are not themed; take the shape idea only.
- **Lazy illustration registry for empty states** (`PL/packages/blocks/src/empty-state/assets/asset-registry.tsx`:28). It is good engineering but off Cerebro's quiet identity.
- **Stale-chunk recovery** (`PL/apps/web/app/root.tsx` `recoverFromStaleAsset`). This is a web-deploy problem; Tauri bundles its assets.

## Implications for M93-M99

- **M93:**
  - **Add M93.12 (proposed), contain render faults (PLN-02):** boundaries at pane, view, rail card and section level; root error callbacks write to the log; Retry uses the M93.1 retained owners.
  - **Confirm M93.7:** "no virtualizer by preference" is right. Plane's placeholder rows are exactly what its access tests reject.
- **M94:**
  - **Amend M94.2:** role ink/line utilities, the raw-ink ratchet rail and a DS dev skill (PLN-01); elevation roles and named z-layers mapped to `layers.ts` (PLN-08).
  - **Confirm M94.2:** container compositions (PLN-16).
  - **Amend M94.3:** block-level reading width with breakout, one width variable for toolbar, title, properties, tabs, body and loading (PLN-03).
  - **Amend M94.5:** blocked reasons at every entry point (PLN-05); panel and history selection in the visit slot (PLN-06).
  - **Amend M94.6:** status glyph from group (PLN-09); active-tab reveal plus a "More" menu in narrow panes (PLN-10); extend the single `Select` (description, disabled reason, async) only when a consumer needs it (PLN-11); retirement ledger (PLN-13).
  - **Amend M94.8:** layout-shaped first-load presets and a refresh that keeps the last good content (PLN-04).
  - **Amend M94.9:** measure contrast on the call sites actually rendered, not tokens only; add a `prefers-contrast` check (PLN-01, PLN-07).
  - **Confirm:** CV-44's five states and "no second EmptyState family".
- **M95:** **Confirm.** The M93.12 boundaries wrap rail cards and transcript turns, so a malformed tool result cannot blank the conversation.
- **M96:** **Amend M96.3/M96.5:** an approval confirm uses one primitive whose busy state vetoes Escape and scrim close while the dispatch claim is in flight (PLN-12). Creation keeps M94.4's store-owned pending state, which lets the dialog close. Account pickers use `Select` rows with disabled reasons.
- **M97:** **Confirm.** No DS dependency.
- **M98:** **Amend M98.9:** condition and trigger editors reuse FilterBuilder/FilterChips through an adapter to M98's predicate AST. Stale references show as named problems, as in ViewProblems (PLN-14).
- **M99:** **Confirm.** No DS dependency.

## Owner questions

1. Should role-named ink/line utilities, plus a rail that blocks new raw-ramp ink and ratchets down the about 3,260 existing references, become the M94.2 contract?
2. Should Details/Comments/History state follow the pane visit (panes independent, Back restores), or stay one global preference?
3. Should a contrast variant ship, applied automatically under macOS Increase Contrast (`prefers-contrast: more`), as an explicit theme, or both?
4. On normal-width pages, may data blocks (database, table, sheet, diagram) break out of the prose width?
5. Should CV-44 gain a sixth preset ("refreshing over last good"), and should collection surfaces show layout-shaped skeletons on first load?
