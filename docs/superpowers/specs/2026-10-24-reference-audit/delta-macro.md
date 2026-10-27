# Macro: design system and UI composition - reference audit 2026-10-24

> **Scope.** `docs/examples/macro-main/apps/web` (SolidJS, Kobalte, Tailwind 4): tokens and theme engine, `components/ui`, the UI gallery, view shell, split chrome, lists, boards, skeletons and settings. This is the delta against the prior dossier `plans/2026-10-22-reference-review/macro.md` (reliability, AI, retrieval) and the 2026-10-12 study `specs/2026-10-12-macro-reference/02-shell.md`. That study already covers the keymap, palette, panes and claims, ViewShell, themes as data (SHELL-10), the boot silhouette, tours and rail customisation, so those are cited here, not repeated.
> **Read.** About 75 Macro files, 40 Cerebro files and 15 plans or specs. Nothing was built, run or modified. Counts are grep counts over non-test source.
> **Licence.** Macro's root `LICENSE.txt` is AGPL-3.0 and `apps/web/LICENSE` reads "Copyright 2023 CoParse, Inc. All rights reserved." Every Macro item below is therefore **ideas only**, to be re-implemented. Pieces Macro derived from shadcn are ported from upstream shadcn/ui (MIT), as M91 did. Cerebro already holds an MIT `Item` port (`THIRD_PARTY_NOTICES.md:470+`).
> **Basis.** [read] = code read · [names] = inferred from file or directory names · [docs] = README or comments only.

## Top findings

1. **Macro's surfaces and state washes are relative roles. Cerebro's are absolute ramp steps.**
   - Macro: components paint only `bg-surface`/`bg-inset`, resolved by `Layer` depth. Hover, active and selected are translucent ink or accent overlays.
   - Cerebro: about 420 absolute ramp fills and 273 `hover:bg-n-*` washes, against 105 semantic `surface-*` uses. It already hand-patches washes that their container swallows (`src/app/shell.css:57-64,330-336`).
   - Phase: add M94.10 before M94.6–M94.8 propagate the compositions.
2. **Narrow chrome should give way by declared priority, not by squeezing.**
   - Macro: a headless collapser folds the lowest-priority items first, truncates the title last and does not thrash.
   - Cerebro: the page toolbar only tightens its gaps at 600px (`src/components/pageToolbar.css:113`), and it deliberately lets the save state ellipsize, including "Couldn't save" (`src/components/pageToolbar.css:34`).
   - Phase: M94.3, M94.5 and M94.7 (Review Focus 3).
3. **Stacking order belongs in one banded token table.**
   - Cerebro: 16 raw z values across 23 files, plus 96 `z-10…50` classes. Tooltip, hover card and toast all tie at `z-[1100]`, and the order between them is recorded only in comments.
   - Phase: M94.10, plus the layer tests in M94.5.
4. **Macro makes design-system docs and adoption executable.**
   - Macro: `*.docs.tsx` pages are discovered by glob. Guidance is read from `@do`/`@dont` JSDoc. A test renders every demo, a coverage page lists undocumented components, and an AST audit measures adoption.
   - Cerebro: none of these. Outside tests and the design-system layer there are 567 raw `<button>` elements against 312 `Button`/`IconButton`.
   - Phase: M94.9 evidence, plus a new M94.11.
5. **Loading should keep the page's geometry.**
   - Macro: skeletons are built from the same row tokens, stay invisible for 150 ms, and announce a single `role=status`.
   - Cerebro: the loading state is a line with an icon (`StateMessage`), and there is no Skeleton primitive.
   - Phase: M94.6 and M94.8 (UX-10's loading state).
6. **Use one size vocabulary and one row anatomy.**
   - Macro: `md` is 32px for every button-like control, and a single `Item` serves both rows and cards.
   - Cerebro: `md` is 32px on Button but 28px on IconButton and SegmentedControl. Its MIT `Item` port has only two importers (one app card and one AI element), and there are 11 separate row families.
   - Phase: M94.2 and M94.3.
7. **Macro's code supports M93.7.** It virtualizes simple lists, which carry no `aria-setsize`/`aria-posinset`, but renders its editable database table in full with `aria-rowcount` and `aria-rowindex`. Keep M93.7's accessibility gate.

## Map

| Area | Path (under `docs/examples/macro-main/apps/web/`) | What it does |
| --- | --- | --- |
| Token sheet | `src/index.css` (1,778 lines) | Input colours, the derived semantic graph, the layer map, the z-index scale, glass and elevation utilities, `overlay-*`, hairline borders |
| Theme engine | `src/features/theme/{types/themeTypes.ts,utils/themeColorTokens.ts,utils/themeUtils.ts,signals/themeSignals.ts}` | ThemeV3 as data, migrations from v0 to v3, preview and commit, light/dark/system, first-paint colours |
| Depth | `src/components/ui/components/{Layer,Surface,Panel}.tsx` | A depth context; layer-relative backgrounds; a panel with slots |
| Variants and sizes | `src/components/ui/utils/{variants,controlSizes}.ts`, `components/{Button,Badge}.tsx` | `createVariants`; one size map shared by every button-like control |
| Row anatomy | `src/components/ui/components/{Item,NavRow}.tsx` | One row and card anatomy for lists and cards |
| Gallery | `src/features/ui-gallery/{registry.ts,source.ts,types.ts,registry.test.tsx,components/CoveragePage.tsx,components/DemoPreview.tsx}` | Executable component documentation and coverage |
| Foundations | `src/components/ui/foundations/{colors,surfaces,typography}.docs.tsx` | Token usage rules as pages |
| Adoption audit | `scripts/ui-audit.ts` | AST report of usage, reskinning and hand-rolled controls |
| Convention rails | repo root: `rules/ast-grep/tsx-*.yml`, `docs/STYLE_GUIDE.md` (FE-22…34) | Style-guide IDs enforced as errors (no existing violations) or warnings (being burned down) |
| Priority collapse | `src/components/app/split-layout/{utils/createPriorityCollapser.ts,components/PriorityCollapseOverflowSensor.tsx,components/CollapsibleItem.tsx}` | Toolbars and headers give way under width pressure |
| View shell | `src/components/view-shell/{ViewShell.tsx,view-shell-layout.ts,README.md}` | An aside/main/detail solver; sidebar geometry tokens |
| States | `src/components/view-shell/{ListSkeleton,ViewSkeleton}.tsx`, `src/features/database/components/{database-load-state,database-table-notices}.tsx`, `src/components/ui/components/{EmptyStatePanel,FilteredHiddenBanner}.tsx` | Loading, empty, failed and unknown-save surfaces |
| Lists | `src/components/list/{README.md,use-list-interactions.ts}` | A list controller and keyboard reveal inside virtualized lists |
| Boards | `src/components/kanban/kanban-{wheel-scroll,pointer-intent,virtualizer}.ts` | Board gesture modules with unit tests |
| Settings | `src/features/settings/{primitives.tsx,core/settings-search.ts,core/settings-target.ts}` | Utility-page primitives and a per-setting search catalogue |
| Panes | `src/components/app/split-layout/components/SplitPanel.tsx:276`, `src/index.css:358-366` | Tint for an inactive pane |
| Document column | `src/features/block-md/component/Notebook.tsx:290-292,449` | A 768px column, plus a WebKit flex-basis note |

## Patterns that work

Short Macro file names resolve through the Map, under `docs/examples/macro-main/apps/web/`. Cerebro paths are repo-relative.

| ID | Pattern | Mechanism | Why it works | Evidence [basis] | Cerebro today | Verdict | Phase |
| --- | --- | --- | --- | --- | --- | --- | --- |
| MAC-01 | Depth-relative surfaces | `Layer({depth?, offset?})` puts a clamped 0–4 depth in context. It renders a `display:contents` div with `data-layer data-depth`. CSS maps each depth to `--color-surface`/`--color-inset` (depth n gives surface-n and surface-n-1). Components paint only `bg-surface`/`bg-inset`. | One component is right at any nesting. Nesting reads without borders. A theme authors only 5 surface steps. | `Layer.tsx`; `index.css:146-175`; `foundations/surfaces.docs.tsx`, which says never use `bg-surface-2` directly and stop at about 3 steps. 105 files use `<Layer>` [read] | Absolute ramps: 326 `bg-n-*` classes and 96 CSS `var(--n-*)` backgrounds, against 105 semantic surface uses. The dark theme re-points the ramps (`src/styles/tokens/colors.css:209-231`). | adapt (ideas only) | NEW:ds-roles (M94.2, VS07, VS10) |
| MAC-02 | State washes as overlays | Hover is ink at 3% and active ink at 6%. Selected is accent at 8%, and selected plus highlighted is accent at 16%, each mixed with `transparent`. `@utility overlay-*` paints the wash as a `background-image` over the element's own fill, and Button hovers use `hover:overlay-hover`. | The wash shows on any surface, depth or theme. Hover, highlight, selected and selected-highlighted stay distinct. | `index.css:266-276,447-449,523-525,1364-1368`; `Button.tsx` `buttonVariants` [read] | 273 `hover:bg-n-*` washes. `src/app/shell.css:57-64` and `:330-336` patch washes "swallowed" by their container with ad hoc `color-mix`. | adapt | NEW:ds-roles (M94.2) |
| MAC-03 | Elevation as named role bundles | `menu-surface` bundles rounded-xl, the menu fill, a rim and inset and cast shadows. `elevated-surface` bundles a 24px radius and the dialog fill. `scrim-glass` covers the backdrop, with `--shadow-menu` alongside. A consumer applies one utility. | Every menu, dialog and composer draws the same corner, fill, edge and shadow. VS07's roles become one token each. | `index.css:847-925,662` [read] | A size scale `--shadow-xs…lg` (`src/styles/tokens/spacing.css`), 54 uses of `var(--shadow-lg)`, and literal 7, 9, 12, 14 and 24px radii in CSS | adapt (the bundling, not the glass look) | M94.2 (VS07) |
| MAC-04 | Banded z-index tokens | `--z-index-*` in `@theme` generates `z-*` classes. Bands: 0–99 in-page, 100–199 modal, drag and menus, 200–299 for tooltip (200), nested menu (205) and toast (250). Raw `z-[n]` is allowed only inside a local stacking context, and a component family sits in one token wrapper. | Overlay order is decided once and nothing ties. | `index.css:584-660`; about 150 token uses, with 29 raw `z-[n]` left [read] | 16 raw values, 37 uses in 23 files, plus 96 `z-10…50`. Tooltip, hover card and toast tie at 1100 (`src/components/ui/Tooltip.tsx:234`, `src/components/ui/HoverCard.tsx:397`, `src/app/ToastHost.tsx:83`). Popover 1050 and scrim 1000 are ordered only in comments (`src/components/ui/Popover.tsx:435`, `src/components/ui/Dialog.tsx:9`). | adapt | NEW:ds-roles (M94.5) |
| MAC-05 | Priority-collapse chrome | `createPriorityCollapser(probe)`: each item registers `{id, priority, collapsed, setCollapsed}`. The probe compares content `scrollWidth` with viewport `clientWidth`. The lowest priority collapses first until the content fits within 2px. Items expand in reverse through silent trials before paint, with a 12px retry hysteresis. The title truncates as the last resort (`MAX_SAFE_INTEGER`). Each item renders `children(isCollapsed)`, for example a label that becomes an icon with a tooltip. | Degradation is deterministic, critical controls never vanish, and nothing thrashes. | `createPriorityCollapser.ts`; `PriorityCollapseOverflowSensor.tsx`; `CollapsibleItem.tsx`; `tests/createPriorityCollapser.test.ts:209-279`; `next-soup/soup-view/soup-view-create-button.tsx:241-249` [read] | One 600px container query only (`src/components/pageToolbar.css:113`). `src/components/pageToolbar.css:34` overrides the save state's `flex-none` (`src/components/PageToolbar.tsx:170`) so that it ellipsizes. | adapt | M94.3, M94.5, M94.7 |
| MAC-06 | Executable component gallery | `import.meta.glob('**/*.docs.tsx')` builds the registry from `defineDoc({name, category, demos, exports, propTypes})` pages. Demo code is shown from `// #region demo:<id>`. Guidance comes from the component's `@do`/`@dont` JSDoc, and prop types are extracted from source. `CoveragePage` lists undocumented files. `registry.test` renders every demo and checks regions, guidance and props. | Docs cannot drift from code, missing docs are visible, and each primitive is shown at a chosen depth. | the `ui-gallery/*` files in the Map; 23 pages cover 52 component files (about 44%) [read] | No primitive docs. The state lab covers only reading sections (CV-44), and `src/lab/CompositionLab.tsx` covers only the M94 compositions. | adapt (dev-only; component evidence, not journey acceptance) | NEW:ds-gallery (M94.2) |
| MAC-07 | Design-system adoption audit | A TypeScript-compiler scan of JSX. It counts usage per `@ui` component, flags a "reskin" when a className carries appearance or size prefixes rather than layout prefixes, and counts hand-rolled `<button>` and `<select>`. | Turns "adopt across surfaces" into a ratchet with numbers. | `scripts/ui-audit.ts:1-120` [read]. Macro itself still has 684 raw `<button>` against 1,168 `<Button>` (count) | 567 raw `<button>` in 221 files against 312 `Button`/`IconButton`, outside tests and the design-system layer. No audit script exists in `scripts/`. | adapt | M94.6–M94.9 |
| MAC-08 | One control-size vocabulary | `CONTROL_SIZE_VARIANTS` (sm h-6, md h-8, lg h-9) is shared by Button and Badge. Icon sizes are squares at the same heights (`icon-sm` 24, `icon-md` 32). | Mixed rows line up by name. | `utils/controlSizes.ts`; `Button.tsx` size map; `Badge.tsx:19-32` [read] | Button sm/md/lg = 28/32/36 (`src/components/ui/Button.tsx:40`). IconButton = 24/28/32 (`src/components/ui/IconButton.tsx:33,67`), SegmentedControl 24/28, Tag 22. | adapt (keep the heights; align names on `--control-h-*`) | M94.2 |
| MAC-09 | Loading that keeps geometry | `ListSkeleton.Root` carries `role=status`, `aria-label` and sr-only text. Its rows stay `invisible` for 150 ms and are built from `--sidebar-row-height`. `ViewSkeleton` mounts the real ViewShell with the same aside preference key. `TableSkeleton` and `BoardSkeleton` cover individual layouts. | Fast loads don't flash, the layout doesn't jump, and assistive tech hears one status. | `view-shell/ListSkeleton.tsx`, `ViewSkeleton.tsx`; `database/components/database-load-state.tsx` [read] | `StateMessage` loading is an icon and one line (`src/components/ui/StateMessage.tsx:4-36`). No Skeleton exists (grep; matches `cerebro-baseline-ui.md`). | adapt | M94.6, M94.8 |
| MAC-10 | One row and card anatomy | `Item` has Media, Icon, Content, Title, Description, Metadata and Actions slots; sm/md sizes; ghost, outlined and filled variants. Lists and cards share it. | Density decisions follow a single hierarchy. | `ui/components/Item.tsx:1-154` [read] | A shadcn `Item` port (MIT) exists only in the AI layer (`src/components/ai/Item.tsx`). Its only importers are `agent/rail/ConnectorsCard.tsx` and the AI `Confirmation`. There are 11 bespoke `.cb-*-row` CSS families. | adapt (reuse the MIT port) | M94.3, M94.6, M94.8 |
| MAC-11 | Themes as data | A theme authors 25 input tokens: 5 surface, 5 content, 2 edge, accent and 12 hues. `getDefaultSemanticColorTokens` derives the semantic layer. ThemeV3 is versioned, migrated and validated. `themeCssVars(theme)` renders any theme on a subtree, which is how previews are built. | Few authored values; previews match the tokens exactly. | `themeTypes.ts`; `themeColorTokens.ts`; `settings/components/appearance-mode-picker.tsx` [read] | Two hand-authored palettes; SHELL-10 rated this low | watch (take only the derivation, via MAC-01/02) | — |
| MAC-12 | Inactive-pane tint | `.split-panel-inactive` lowers the panel's oklch lightness by 0.025 rather than mixing with ink, which would invert in dark mode. The class is scoped to the pane, so nested `bg-panel` follows it. | Which pane has focus reads across the whole pane, in both themes. | `index.css:358-366`; `SplitPanel.tsx:276` [read] | Only the 32px pane header tints (`src/app/PaneRow.tsx:79`) | adapt (low) | M94.3 |
| MAC-13 | Settings search catalogue | Each setting has a static entry `{tab, title, target, keywords}`. One slug from `settingsTarget(label)` is shared by the catalogue and by the `data-settings-target` on SettingsSection and SettingsRow, which also carry `tabIndex -1` and `scroll-mt`. | Finds a control without knowing its page. | `settings/core/settings-search.ts`, `settings-target.ts`, `primitives.tsx:113-140,204-230` [read] | 11 sections (`src/pages/SettingsNavigation.tsx`) and no per-setting search; the 02-shell study rated this partial | adapt (low) | M94.8, M93.10 |
| MAC-14 | Virtualize lists but not the editable grid | Simple lists (Tasks, Home, Email, Drive, ⌘K) use `virtua`/tanstack virtual, with keyboard reveal through `scrollToIndex(i,{align:'nearest'})`. The database table renders its full row model with `aria-rowcount`/`rowindex`. Virtualized lists set no `aria-setsize`/`posinset`. | Supports M93.7's constraint; the lists show the accessibility cost. | `components/list/use-list-interactions.ts:101-106`. grep: `aria-rowcount` appears only in `database-table.tsx:494` and `SpreadsheetGrid.tsx:1172` [read] | TableView renders every row with `aria-rowcount` (`src/views/TableView.tsx:2797-2801`) | avoid (virtualization without set size); confirm M93.7 | M93.7 |
| MAC-15 | Board gesture modules | Wheel ownership is held for 180 ms per gesture. A pointer-intent gate blocks drop previews above a speed and settles after 100 ms. The virtualizer keeps the drag source mounted. | Drags stay stable on long boards. | `kanban/kanban-{wheel-scroll,pointer-intent,virtualizer}.ts` and their tests [read] | None of these in `src/views/BoardView.tsx` (711 lines; grep) | watch | M94.6 |
| MAC-16 | Convention rails tied to style IDs | ast-grep rules cite FE ids. Severity error means zero existing violations; warning means the violations are being burned down. Rules cover the raw palette, class-string constants and cursor-pointer. | — | `rules/ast-grep/tsx-no-raw-tailwind-palette.yml`, `tsx-no-class-string-consts.yml`; `sgconfig.yml` [read] | Stronger: CV ids with `enforced:` pointers. `src/styles/theme.test.ts` guards colour, radius and size classes. | already-have (extend `theme.test.ts` with the ratchets) | NEW:ds-roles |
| MAC-17 | Container-measured shell solver | ViewShell places the detail inline, overlay, replace or hidden by comparing measured width with the summed minimums. A narrow layout never rewrites the wide preference. | — | `view-shell/ViewShell.tsx:200-330`, `view-shell-layout.ts` [read] | `src/app/shellLayout.ts` `shellPlan`/`pageAsides` (02-shell rated Cerebro's version better) | already-have | — |
| MAC-18 | Motion and contrast | Each utility carries its own `prefers-reduced-motion` block, with 120 ms hovers. The theme guard falls back when the lightness gap between content and surface is under 0.2. | — | `index.css` keyframe utilities; `themeUtils.ts` `ensureMinimalThemeContrast` [read] | Better: motion-by-kind tokens collapse under reduced motion (`src/styles/tokens/spacing.css`), and `src/styles/contrast.test.ts` tests AA pairs in both themes | already-have | — |
| MAC-19 | WebKit text-column basis | The document column uses `basis-0`. The code comment says this keeps WebKit from sizing it by max-content, which "recomputes slowly for long unbroken runs". The column is 768px with a 48px top. | A layout cost specific to WebKit | `block-md/component/Notebook.tsx:290-292,449` [read]. The perf claim is a code comment and unmeasured [docs]. | Not measured. M93.6 has a document64KiB case. | watch | M93.6 |

### A. Surface, wash, elevation and stacking roles (MAC-01 to MAC-04)

**Macro's flow:**
1. A theme stores only `inputColorTokens` (`themeTypes.ts`).
2. `getDefaultSemanticColorTokens(mode)` fills every semantic token with a `var()` or `color-mix()` expression (`themeColorTokens.ts`).
3. `setLiveThemeColorTokens` writes those as CSS variables on `<html>`.
4. `[data-layer][data-depth=n]` sets `--layer-surface` and `--layer-inset`, and `--color-surface` resolves to `var(--theme-surface, var(--layer-surface))` (`index.css:146-175`).

**Cerebro sketch:**
- **Depth surfaces.** In `colors.css`, declare `--surface-0…4` per theme, mapped from today's frame, navigation, app and raised values. Add `[data-depth='n'] { --surface: …-n; --inset: …-(n-1) }`. Add `src/components/ui/Layer.tsx` with `Layer({depth?, offset?})`, built from context and a `<div data-depth style={{display:'contents'}}>`.
- **Washes.** Add `--wash-hover` (ink at about 4%), `--wash-press` (about 8%), `--wash-selected` (accent at about 10%) and `--wash-selected-press` (about 16%). A `wash-*` utility paints `background-image: linear-gradient(var(--wash), var(--wash))`.
- **Elevation.** Define `elev-menu`, `elev-dialog`, `elev-float` and `elev-toast` as bundles of radius, fill, border and shadow, plus one scrim token.
- **Stacking.** Define `--z-index-*` bands covering in-page chrome (1–40), drag (88), scrim (1000), dialog (1001), popover (1050) and then hover card, tooltip and toast. Split the 1100 tie so that hover card sits below tooltip, and tooltip below toast.
- **Ratchets.**
  - `theme.test.ts` refuses new raw page-scope z values and caps the `bg-n-*` and `hover:bg-n-*` counts. The caps only go down (CV-12 style).
  - `contrast.test.ts` composites each wash over each surface and requires the result to stay visibly distinct (proposed: 3:1 against its ground for selection). Today the test resolves hex and `var` only.
  - Adopt the roles in new or changed surfaces only. Existing call sites keep working, and there is no repo-wide CSS replacement.

### B. Priority collapse (MAC-05)

**The headless contract, from Macro:**
- `OverflowProbe{measure():{requiredWidth, availableWidth, retryWidth}, observe(cb)}`.
- `CollapsibleRegistration{id, priority, collapsed(), setCollapsed(v,{silent})}`.
- Collapse runs in ascending priority; expansion runs in descending priority through silent trials between layout and paint. Evaluation is scheduled with rAF behind a ResizeObserver.

**Cerebro wiring:**
- Add a `usePriorityCollapse()` hook built on `useLayoutEffect` and ResizeObserver.
- Wrap PageToolbar's actions as `<Collapsible id priority>{(collapsed) => …}</Collapsible>`. A collapsed label becomes an icon, keeping its tooltip and keycap; low-priority actions fold into a "More" menu.
- These are never registered, so they never collapse: a failed SaveState, Stop, approval and Retry controls.
- The breadcrumbs take the last-resort truncation cap.

**Tests.** Mirror Macro's four cases: lowest-priority first, reverse expansion, last-resort cap, no thrash. Add "a failed save is never ellipsized", measured at 900px with the panel and the assistant open.

### C. Gallery and adoption audit (MAC-06, MAC-07)

**Gallery layout:**
- A `src/components/{ui,ai}/<Name>.docs.tsx` page beside each primitive. A dev-only registry in `src/lab/gallery/registry.ts` collects them through `import.meta.glob` (eager), plus `?raw` sources.
- It is served at `state-lab.html?gallery=<slug>&theme=dark&depth=2`, behind the same "never built" boundary as `CompositionLab`.

**`gallery.test.tsx` checks:**
- every demo renders in both themes;
- every demo id has its `#region` marker;
- every component has `@do`/`@dont` guidance;
- the coverage list of undocumented `components/ui/*.tsx` only shrinks.

**Audit.** Add `scripts/ui-audit.ts` on the TypeScript compiler. It reports raw `<button>` against `Button`/`IconButton`, className overrides on DS components, raw `bg-n-*` washes, raw z values and literal radii. `scripts/ui-audit.test.ts` holds down-only ceilings.

**Evidence class.** Record the results as "component" evidence, separate from journey acceptance (AC04: "An attractive component gallery … different evidence").

### D. Geometry-true loading (MAC-09)

- Add `Skeleton.Root({label})`: `role="status"` and a visually hidden label, with children `aria-hidden` and `visibility:hidden` for 150 ms. Reduced motion turns off the shimmer.
- Add `Skeleton.Row` sized from the existing tokens: `--nav-row-h`, and table rows of 32/44/56 by density.
- Build per-layout Table, Board and Pages skeletons from those rows.
- This is UX-10's transient loading state. It does not replace CV-44's five presets.

## Avoid / doesn't transfer

- **Glass chrome** (backdrop blur, specular rims, `island`, the press shimmer; `index.css:72-110,742-930`). It is a touch and marketing look, blur is costly in WKWebView, and it conflicts with Cerebro's quiet identity. Take only the role bundling (MAC-03).
- **Custom scrollbars** (`Scroll.tsx`, 429 lines, with global `scrollbar-width: none` at `index.css:1126`). macOS overlay scrollbars are native; a custom one costs native feel and accessibility.
- **Global `user-select: none`** (`index.css:1107-1109`, which its own comment calls "scuffed … for mobile usage"). A desktop app must keep error text, ids and paths copyable.
- **The `cursor-pointer` ban** (FE-27; `index.css:1346`). It is taste, not evidence, and Cerebro's rows rely on the pointer affordance.
- **The lightness-delta "contrast guard"** (`themeUtils.ts` `ensureMinimalThemeContrast`). It is weaker than Cerebro's AA tests and must never replace them.
- **A theme catalogue and editor** (13 built-in themes plus user themes). The product identity is cortex/synapse in light and dark; only the derivation transfers (MAC-11).
- **Virtualizing a list without `aria-setsize`/`aria-posinset`, or with offscreen editing.** It breaks find and VoiceOver, which M93.7 forbids (MAC-14).
- **The section-registration accordion side panel** (`components/app/side-panel/SidePanel.tsx`) **and the hide-and-reorder rail** (`sidebar-next/use-sidebar-prefs.ts`). They conflict with the owner's single Details/Comments/History slot and with the destinations table (02-shell skipped SHELL-11).
- **Feature tours, monochrome entity icons and filled-glyph swaps** (`nav-glyph.tsx`). They break "nothing speaks first", and lucide has no fill weights.
- **Native e2e through tauri-driver** (`tests/native/README.md`). It runs only on Linux WebKitGTK and never reaches WKWebView IME or VoiceOver, so the 20-practices skip stands.
- **Lifting any Macro source or asset.** It is AGPL or all-rights-reserved code; re-implement the ideas, and port shadcn pieces from upstream (MIT).

## Implications for M93-M99

**M94**
- **Confirm M94.2.** Composition measured on containers rather than the viewport is right: Macro uses `@container/view-shell` and `createSizeBreakpoints`, and SettingsRow stacks at 460px.
- **Confirm M94.3.** Comparing a 700–760px prose measure is right: Macro's document column is `max-w-3xl` (768px) at a 15px base (`Notebook.tsx:292`).
- **Amend M94.2.**
  - Add size-name alignment to the role sheet (MAC-08): keep the heights, and put IconButton, SegmentedControl and Tag on `--control-h-*` with a new 24px step.
  - Add elevation role bundles (MAC-03).
  - These are roles for new and changed surfaces, not a migration; the sheet's "no radius or color-token migration" stands.
- **Amend M94.3.**
  - Move Pages rows onto the existing MIT `Item` anatomy (MAC-10) rather than another bespoke row.
  - Add a toolbar priority policy (MAC-05) and assert that a failed save is never ellipsized.
  - Add the inactive-pane tint (MAC-12) to the four-pane parking check.
- **Amend M94.5 and M94.7.** Use the same collapser for the peek header and the assistant header. Stop, approval, `outcome_unknown` and Retry are never-collapse items, and layer tests assert distinct z bands.
- **Amend M94.6 and M94.8.** Add per-layout skeletons (MAC-09) as the journey's loading state. Settings search (MAC-13) is optional and low priority.
- **Amend M94.9.** Record the ui-audit numbers and gallery coverage as evidence, held by down-only ratchets.
- **Add M94.10 "Surface, wash and stacking roles"** (MAC-01, 02 and 04, plus the `theme.test.ts`/`contrast.test.ts` ratchets). It is owner-gated because it changes tokens, and it lands before M94.6–M94.8 adoption.
- **Add M94.11 "Primitive gallery and adoption audit"** (MAC-06 and 07). It is dev-only, its findings are component evidence, and new primitive families need a docs page.

**M93**
- **Confirm M93.7.** Macro virtualizes simple lists only; its editable grid is fully rendered with row semantics (MAC-14).
- **Amend M93.6 (watch).** Add a long-unbroken-run document case (MAC-19) to the document matrix.

**M95, M96 and M98**
- **Confirm.** Build on the M91 elements and primitives that already exist.
- **Amend.** M95.4 controls, M96's connection settings and M98.9's WorkflowEditor and StepInspector use the documented primitives and roles. Their decision controls register as never-collapse.

**M97 and M99.** No change from this slice.

## Owner questions

1. **Token roles.** Approve depth-relative surfaces, translucent state washes and banded z tokens as a new phase (M94.10), adopted only in new or changed surfaces under down-only ratchets? This goes past M94.2's "no color-token migration" scope.
2. **Narrow-width collapse order.** Which page, peek and assistant actions may fold to an icon or into a "More" menu at 900px with a panel open, and which must stay labelled? Proposal: failed save, Stop, approvals and Retry never fold; the crumbs truncate last.
3. **Primitive gallery.** Approve a dev-only primitive gallery in the state lab as a separately recorded "component evidence" class? It is never treated as journey or aesthetic acceptance.
