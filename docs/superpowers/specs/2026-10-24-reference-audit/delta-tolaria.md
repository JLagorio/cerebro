# Tolaria: design system, UI composition and missed architecture - reference audit 2026-10-24

> **Scope:** `docs/examples/tolaria-main` design system, primitives, shell/page composition, startup and native input layer. This is a delta over the [prior dossier](../../plans/2026-10-22-reference-review/tolaria.md) (T1–T10: perf budgets, virtualization, editor caches, progressive mount, startup snapshot, CLI readiness, agent docs, IME/RTL, name search, file journeys; not repeated) and [02-visual-system](../../plans/2026-10-22-ui-refresh-review/02-visual-system.md).
> **Read:** about 75 Tolaria files (plus all 51 `.pen` files parsed), about 40 Cerebro files, the roadmap, the implementation record, and the M93/M94 specs and plans. Nothing was built or run.
> **Paths:** `T/` = `docs/examples/tolaria-main/`. Unprefixed paths are Cerebro (repo root).
> **Licence:** Tolaria is `AGPL-3.0-or-later` (`T/LICENSE`, `T/package.json:4`). **Every verdict is ideas-only:** re-implement it in Cerebro's model. Copy no code, CSS, patch file or design file. Tauri's `set_zoom` (TOL-08) belongs to Cerebro's own dependency.
> **Basis:** [read] = code or tests read · [docs] = ADR, README or AGENTS text · [names] = inferred from file names only.

## Top findings

1. **Do not import Tolaria's design system. Cerebro's is already stronger.** Tolaria tokenizes colour only. Radius is a single shadcn `--radius`. Spacing, type, elevation and z-index are Tailwind defaults or literals (167 `text-[10–13px]` hits; z-index literals up to 13000 with no scale). It has no contrast gate and no reduced-motion handling. Its UI rules are prose only. Its design files drift from the code. **Confirm M94.2:** lab-based compositions on Cerebro's tokens.
2. **The biggest miss is render-fault containment.**
   - Tolaria runs the same `@blocknote/*` 0.46.2 as Cerebro. It classifies 9 render and 15 transform failure reasons, remounts the editor at most once, and routes everything else through React 19 root error hooks.
   - Cerebro has **zero** error boundaries and a bare `createRoot` (`src/main.tsx:15`). One render throw unmounts the whole shell.
   - **Add M93.12.** Cerebro's `DocumentOwner` (`src/editor/documentOwner.ts:40`) makes a remount safe without Tolaria's lossy repair.
3. **WKWebView input differs from browser input.** Tolaria routes ⌘O, ⌘F and ⌘⇧L around WKWebView; per ADR 0053, ⌘⇧L failed in its native QA. Cerebro binds ⌘F (`find.open`) and ⌘⇧L (`theme.toggle`). In native fullscreen, Escape also exits fullscreen as well as closing the overlay. **Amend M93.11/M94.9** to add native rows for both. **Add M94.10** (Rust routing).
4. **One command manifest feeds the shortcuts, the macOS menu bar, menu enablement and the QA proof mode.** Cerebro's native menu is Tauri's default: no app commands, and no Settings… ⌘, (Settings is reached only by `g ,`). **Amend M94.5; Add M94.10.**
5. **M94.9's native "actual 200% zoom" gate cannot run today.** Cerebro has no app zoom and does not enable `zoom_hotkeys_enabled`. Tolaria's CSS-`zoom` approach needed three compensations, so use Tauri's native `set_zoom` instead. **Amend M94.9.**
6. **Keep one geometry from launch to ready.**
   - Tolaria paints a static boot shell from `index.html` and reuses the same DOM as the Suspense fallback. A one-shot watchdog reloads a webview that paints but never becomes interactive.
   - Its skeletons keep real section headers and create buttons live while content loads.
   - Cerebro renders `null` until boot (`src/App.tsx:316`), and its loading state is an icon line.
   - **Add M93.12; Amend M94.8.**
7. **Two small, concrete techniques:** a content-sized property label column (`fit-content(50%)` plus `subgrid`) for M94.3's twenty-property scene, and sampled status-stability tests that catch flicker, for M94.9.

## Map

| Area | Path | What it does |
| --- | --- | --- |
| Colour tokens | `T/src/index.css:32-383` | Semantic roles (surface/text/border/state/accent/feedback/syntax/diff) in light and dark, then a shadcn alias layer, then compat aliases, then Tailwind `@theme inline` |
| Editor theme | `T/src/theme.json`, `T/src/hooks/useTheme.ts` | Editor typography as JSON, flattened to CSS variables |
| Theme runtime | `T/src/lib/themeMode.ts`, `T/index.html` prepaint | light/dark/system; `data-theme` only ever holds the resolved value |
| Primitives | `T/components.json`, `T/src/components/ui/*.tsx` | shadcn new-york on `radix-ui`, cva variants, `data-slot`/`data-variant` hooks, Phosphor icons |
| Escape surfaces | `T/src/utils/macosDismissableEscapeSurface.ts`, `T/src-tauri/src/macos_fullscreen_escape.rs` | Renderer reports "overlay open"; an AppKit monitor reroutes Escape in fullscreen |
| Reserved chords | `T/src-tauri/src/lib.rs:180-205` | `tauri-plugin-prevent-default` for ⌘O, ⌘F, ⌘⇧L only |
| Command manifest | `T/src/shared/appCommandManifest.json`, `T/src/hooks/appCommandCatalog.ts`, `T/src/hooks/appCommandDispatcher.ts`, `T/src-tauri/src/menu.rs` | One JSON: ids, shortcuts, menus, enablement groups, QA mode |
| Root errors | `T/src/main.tsx:200-275` | React 19 root hooks, fatal overlay, one-shot reload |
| Editor recovery | `T/src/components/SingleEditorView.tsx:126-190,1333`, `T/src/components/richEditorRecoveryClassifier.ts`, `T/src/components/richEditorTransformErrorRecoveryExtension.ts` | Classify, remount once, wrap `dispatch` |
| Upstream pins | `T/pnpm-workspace.yaml:7-12`, `T/patches/`, `T/src/lib/blockNote*.regression.test.ts` | Patched BlockNote 0.46.2, tiptap and prosemirror-tables, each pinned by a test |
| Startup shell | `T/index.html:263-340`, `T/src/components/StartupShellFallback.tsx`, `T/src/components/FrontendReadyMarker.tsx`, `T/src/utils/frontendReady.ts` | Static shell, ready flag, 10 s watchdog |
| Skeletons | `T/src/components/sidebar/SidebarLoadingSections.tsx`, `T/tests/smoke/vault-loading-skeleton.spec.ts` | Live headers over pulse rows; single-shell assertion |
| Zoom | `T/src/hooks/useZoom.ts`, `T/src/extensions/zoomCursorFix.ts` | Root CSS `zoom` 80–150% plus overlay counter-zoom |
| Shell | `T/src/App.tsx:1724-1830`, `T/src/App.css`, `T/src/hooks/useLayoutPanels.ts`, `T/src/hooks/useMainWindowSizeConstraints.ts` | Sidebar, note list, editor and inspector, plus a status bar; window minimum grows to fit |
| Title bar | `T/src-tauri/tauri.conf.json`, `T/src/hooks/useDragRegion.ts`, `T/src/components/Editor.css:34` | Overlay title bar with traffic-light inset |
| Property grid | `T/src/components/propertyPanelLayout.ts` | `fit-content(50%) minmax(0,1fr)` plus `subgrid` rows |
| Toolbar overflow | `T/src/components/BreadcrumbBar.tsx:540-662` | Measured collapse with hysteresis |
| Rows | `T/src/components/NoteItem.tsx:41-63` | Save/git status dots |
| Mode switch | `T/src/components/editorModePosition.ts`, `T/docs/adr/0116-*.md` | Rich↔raw cursor and scroll transfer |
| Design files | `T/ui-design.pen`, `T/design/*.pen` | Pencil JSON: foundations, then atoms/molecules/organisms, then layouts; per-task before/after frames |
| Decisions | `T/docs/adr/` (174 files), `T/docs/ABSTRACTIONS.md` | One ADR per decision; superseded, never edited |

## Patterns that work

| ID | Pattern | Mechanism (how it actually works) | Why it works | Evidence [basis] | Cerebro today | Verdict | Phase |
| --- | --- | --- | --- | --- | --- | --- | --- |
| TOL-01 | Render-fault containment | `createRoot(root,{onCaughtError,onUncaughtError,onRecoverableError})`. `BlockNoteRenderRecoveryBoundary` catches **classified** errors only (`block_missing_id`, `table_row_index_out_of_range`, `dom_not_found`, …), bumps the view `key` once (`MAX_…_RETRIES = 1`) and rethrows anything else. The root draws a fatal overlay. | A known library failure costs one remount, not the app. The closed taxonomy keeps unknown errors loud. | `T/src/main.tsx:200-275`, `T/src/components/SingleEditorView.tsx:126-190,1333-1363`, `T/src/components/richEditorRecoveryClassifier.ts` [read]; `T/docs/ABSTRACTIONS.md` "Formatting Surface Policy" [docs] | No boundary anywhere (grep for `getDerivedStateFromError`, `componentDidCatch` and `onUncaughtError` finds none); bare `createRoot` (`src/main.tsx:15`); same BlockNote 0.46.2 (`package.json`) | **adapt** (AGPL: re-implement) | NEW M93.12 |
| TOL-02 | Every upstream patch is pinned by a test | `patchedDependencies` patches `@blocknote/{core,react,code-block}`, tiptap link and prosemirror-tables: SideMenu stale block id, TableHandles, SuggestionMenu, checklist. `*.regression.test.ts` imports upstream source (`node_modules/@blocknote/core/src/...`) and asserts the patched behaviour. | An upgrade that drops a patch fails CI, not the user. | `T/pnpm-workspace.yaml:7-12`, `T/patches/*.patch` diff headers, `T/src/lib/blockNoteSideMenu.regression.test.ts` [read]; 8 sibling pins [names] | `patches/` holds ironcalc only; no test reaches SideMenu or TableHandles (grep) | **adapt**: reproduce first, then patch and pin (Tolaria's patches are AGPL diffs) | NEW M93.12; evidence M93.11 |
| TOL-03 | One startup geometry plus readiness watchdog | `index.html` paints a theme-correct 3-column `#tolaria-boot-shell` and stashes a clone. `StartupShellFallback` clones that node as the Suspense fallback. `FrontendReadyMarker` sets `__tolariaFrontendReady`. A Tauri-only 10 s timer reloads once, guarded by sessionStorage. | No blank or inert window. HTML and React show identical pixels. Self-heal is bounded. | `T/index.html:263-340`, `T/src/components/StartupShellFallback.tsx`, `T/src/utils/frontendReady.ts` [read]; `T/tests/smoke/vault-loading-skeleton.spec.ts` [read]; ADR 0104 [docs] | Theme prepaint only (`index.html`); `App` returns `null` until boot (`src/App.tsx:316`); its own comment records a past permanent blank screen (`App.tsx:292-296`) | **adapt** the shell and ready mark; **watch** auto-reload (owner Q4) | NEW M93.12; ready milestone in M93.6 |
| TOL-04 | Narrow WKWebView reserved-chord list | `tauri_plugin_prevent_default` with `Flags::empty()` registers only ⌘O, ⌘F and ⌘⇧L, so the physical key reaches the renderer listener. The code comment requires native QA for each addition. | WKWebView consumes some chords before page JS. A narrow list avoids global capture. | `T/src-tauri/src/lib.rs:180-205` [read]; ADR 0053 [docs] | ⌘F `find.open` (`src/app/commands/page.commands.ts:14-16`) and ⌘⇧L `theme.toggle` (`app.commands.ts:52-55`); no prevent-default layer; no native key evidence (`docs/superpowers/specs/2026-10-23-m94-ui-implementation/native-results.md`) | **adapt**: test natively first; add only failing chords | M93.11, M94.9, then NEW M94.10 |
| TOL-05 | Fullscreen Escape belongs to the open overlay | Dialog and Popover refs register through a counter, sent as `set_macos_dismissable_escape_surface_open(open)`. An AppKit local monitor consumes Escape (key code 53) only when an overlay is open **and** the window is fullscreen, then dispatches a synthetic Escape to `document.activeElement`. | Without it, AppKit exits fullscreen after the overlay closes; DOM `preventDefault` cannot stop that. | `T/src/utils/macosDismissableEscapeSurface.ts`, `T/src-tauri/src/macos_fullscreen_escape.rs` (with unit test) [read]; ADR 0169 [docs] | Escape is owned by the `src/components/ui/layers.ts` stack; View → Fullscreen exists (`src-tauri/src/shell/quit.rs:316`); no native routing | **adapt**: drive the flag from `layers.ts` (a non-tooltip layer is open), not a DOM query | M94.9, then NEW M94.10 |
| TOL-06 | One command manifest for renderer, menu bar and enablement | `appCommandManifest.json` holds `commands{id,route,shortcut{combo,key,code,display,accelerator}}`, `menus[]`, `appMenu[]` and `menuStateGroups`. Rust `include_str!`s it to build items and accelerators and toggles groups (`set_note_items_enabled`). TS derives the shortcut maps. The renderer executes first and a dispatcher drops the native echo within 150 ms. | Menu bar, palette and keys cannot drift, and the menu bar makes commands discoverable (ADR 0020). | `T/src/shared/appCommandManifest.json`, `T/src-tauri/src/menu.rs:22,470-520`, `T/src/hooks/appCommandCatalog.ts`, `T/src/hooks/appCommandDispatcher.ts:184-330` [read]; ADR 0020/0052/0106 [docs] | TS command rows (`src/app/commands/*.commands.ts`, CV-47); the native menu is Tauri's default (`src-tauri/src/shell/quit.rs` `MENU`); Settings only by `g ,` (`src/engine/destinations.ts:213-216`), no ⌘, | **adapt**: emit a menu table from the command rows as a shared artifact Rust reads (CV-04 shape); avoid the 150 ms heuristic | M94.5, then NEW M94.10 |
| TOL-07 | Shortcut proof-mode matrix | Each shortcut declares `preferredShortcutQaMode` (`renderer-shortcut-event` or `native-menu-command`) and `requiresManualNativeAcceleratorQa`. `window.__laputaTest.triggerShortcutCommand/triggerMenuCommand` synthesizes events from the manifest. ADR 0054 forbids calling browser runs "native QA". | Automation states what it proved, and physical-key gaps stay listed. | `T/src/hooks/appCommandCatalog.ts:330-440`, `T/src/main.tsx:141-176` [read]; ADR 0054 [docs] | The program separates browser and native evidence (M93.11 `AcceptanceEvidence`) but has no per-chord row | **adapt**: add a `proof` column per keymap row | M93.11, M94.9 |
| TOL-08 | App zoom with persisted level | `useZoom` sets root CSS `zoom` 80–150% in steps of 10, persists the level per vault and publishes `--tolaria-overlay-zoom-{factor,inverse}`. CSS counter-zooms the Radix popper wrappers. Costs Tolaria paid: a CodeMirror coordinate fix, a block-handle zoom spec and an overlay test. | People can scale the UI, and anchored overlays stay put. | `T/src/hooks/useZoom.ts`, `T/src/index.css:21-30`, `T/src/components/ui/overlayPresence.test.tsx`, `T/src/extensions/zoomCursorFix.ts`, `T/tests/smoke/editor-block-handle-zoom.spec.ts` [read] | No app zoom; window builder sets no `zoom_hotkeys_enabled` (`src-tauri/src/shell/mod.rs:80`); ⌘=/⌘- exist only in the `pdf-viewer` scope (`pdf.commands.ts:14-21`); native 200% zoom recorded as unverified | **adapt** via native `set_zoom` (`~/.cargo/registry/.../tauri-2.12.4/src/webview/webview_window.rs:2688`; Cerebro pins `~2.12`), up to 200%; not CSS zoom | M94.9, then NEW M94.10 |
| TOL-09 | Skeletons keep real headers and actions | Loading sidebar sections render the real `SidebarGroupHeader` and create buttons over pulse bars of fixed label widths. The list, breadcrumb title and editor have named skeletons. A spec asserts that exactly one shell shows, never stacked skeletons. | Geometry is stable at ready, and fold/create work while loading. | `T/src/components/sidebar/SidebarLoadingSections.tsx`, `T/tests/smoke/vault-loading-skeleton.spec.ts:101-140` [read] | `StateMessage state="loading"` is an icon and a title (`src/components/ui/StateMessage.tsx`); grep finds no `skeleton` or `animate-pulse` | **adapt**: a skeleton variant of "loading" for sidebar, Pages and tables; failed reads stay `unavailable` | M94.8 (VS13) |
| TOL-10 | Content-sized label column on one edge | Grid `fit-content(50%) minmax(0,1fr)`; every row is `grid-column:1/-1; grid-template-columns:subgrid`; 12px labels; rows `min-h-7`. | Long labels fit up to half the panel, and every row aligns to the longest label. | `T/src/components/propertyPanelLayout.ts` [read] | Fixed `--property-label-w: 100px` (`src/detail/inspector.css:23,303`) | **adapt**: compare in the twenty-property scene | M94.3 (VS08) |
| TOL-11 | Sampled status-stability tests | A 100 ms DOM sampler records the status dot's class and test id while typing through autosave, then asserts there was no churn. | Catches flicker that end-state asserts and screenshots miss. | `T/tests/smoke/note-status-indicator-stability.spec.ts` [read]; `editor-save-tooltip-stability.spec.ts` [names] | Save state in the toolbar `status` slot (`src/components/PageToolbar.tsx`); no sampler test found (grep) | **adapt** on the held clock (`e2e/boot.ts` `holdClock`/`stepUntil`), not wall-clock intervals | M94.9; M93.1 status |
| TOL-12 | Row-level save state | Rows show green dots for `pendingSave`/`unsaved` ("Saving to disk…"), a green dot for git `new` and an orange dot for git `modified`, each with a title. | You can find an unsaved or uncommitted page from any list. | `T/src/components/NoteItem.tsx:41-63` [read] | M93.2 plans `unresolvedOpenPages()`; no row marker in Pages, sidebar or panes | **adapt**: mark unresolved or failed owners on rows with text plus icon, not colour alone | M93.2 consumer, then M94.5 |
| TOL-13 | Measured toolbar overflow with hysteresis | Measures the title's natural width with a hidden clone and probes the actions' **expanded** width before collapsing them to an overflow menu (avoids oscillation); ResizeObserver plus rAF. | The title is never squeezed. | `T/src/components/BreadcrumbBar.tsx:540-662` [read] | Container query at 600px (`src/components/pageToolbar.css:113`) plus panel floor (`PANEL_HEAD_CHROME`) | **watch**: only if M94.3 narrow captures clip actions; CSS-first avoids a measured frame (`src/app/shellLayout.ts`) | M94.3 |
| TOL-14 | Overlay (unified) title bar | `titleBarStyle: Overlay`, `trafficLightPosition`, `hiddenTitle`. The leftmost visible header gets `--tolaria-macos-traffic-light-padding` (90px; 16px in fullscreen via a resize-tracked class). Dragging uses `startDragging()` with a no-drag selector; double-click triggers the native title-bar action. | Content reaches the top edge. | `T/src-tauri/tauri.conf.json`, `T/src/hooks/useDragRegion.ts`, `T/src/main.tsx:57-75`, `T/src/components/Editor.css:34` [read] | Standard title bar (`src-tauri/tauri.conf.json`); window title follows the page (`src-tauri/src/shell/mod.rs:90`) | **watch** (owner Q1) | NEW:shell (M94.2) |
| TOL-15 | Lazy, off-thread derived panel indexes | The table of contents builds only while open, in a Web Worker, from Markdown after a debounce; block ids are resolved at click time. | Typing and note-open never pay for side indexes. | ADR 0109 [docs]; `T/src/components/tableOfContents.worker.ts` [names] | DocOutline walks `editor.document` on the main thread, debounced (`src/editor/DocOutline.tsx:127-149`); the M92 rail already reads nothing while folded | **watch**: measure outline cost in M93.6's large-document slice first | M93.6/M93.7 |
| TOL-16 | Rich↔source position transfer | Serializes each block to Markdown to build block→line ranges, maps the cursor or selection both ways (line-ratio fallback) and restores scroll, through one transition owner. | Switching modes keeps the place. | `T/src/components/editorModePosition.ts` [read: signatures]; ADR 0116 [docs] | The mode switch sets the draft only; no selection or scroll mapping found (`src/editor/NoteBodyEditor.tsx:423-428`) | **adapt**: keep M93.8's byte-exact writer and add the transfer | M93.8 |
| TOL-17 | Neighborhood list instead of a graph | Pinned source row; outgoing groups, then inverse groups; empty groups shown with 0; a note may appear in several groups; Enter opens, ⌘Enter pivots. | Shows graph structure without a canvas, with keyboard parity. | ADR 0069 [docs]; `T/src/components/note-list/RelationshipGroupSection.tsx` [names] | M97.5 builds occurrence lists; a graph is a separate extension | **watch** | M97.5 extension |
| TOL-18 | App-owned theme runtime | light/dark/system, prepainted from a localStorage mirror; `data-theme` only ever holds the resolved value. Vault-authored themes were removed for WKWebView reflow and CSS-variable sync cost. | No flash, and one contract for every consumer. | `T/src/lib/themeMode.ts`, `T/index.html` [read]; ADR 0013/0081/0112 [docs] | Same: `index.html` prepaint; `src/hooks/useTheme.ts` never writes `system` | **already-have**; avoid custom themes | none |
| TOL-19 | Semantic colour roles behind alias layers | Roles, then shadcn aliases, then compat aliases, then `@theme inline`. Radius comes from one `--radius`. Spacing, type, z-index and elevation are literals. | Fast to theme both shadcn and BlockNote. | `T/src/index.css` [read]; z-index tally (grep) [read] | Stronger: ramps, cortex/synapse, `--opt-*` ink triples, spacing/type/motion tokens and AA gates (`src/styles/contrast.test.ts`). Tolaria's `muted-foreground` #787774 is 4.48:1 on white and 4.14:1 on the sidebar; `--text-muted` is 2.07:1 | **already-have** | M94.2 (confirm) |
| TOL-20 | Design files as spec | Pencil `.pen` JSON. The master `ui-design.pen` (v2.9, 80 variables) runs Foundations → atoms/molecules/organisms → full layouts; 50 per-task files hold before/after/state frames; about 73% of colour references are CSS-variable names (`$--background`) rather than hex. | States are argued before code. | `T/ui-design.pen`, `T/design/*.pen` [read: parsed] | CompositionLab and the state lab render real primitives (`src/lab/CompositionLab.tsx`, CV-44) | **avoid** as a source of truth: nothing syncs it; the `.pen` dark `--background` is #0f0f1a while the shipped one is #1F1E1B; 15 of 50 task files are empty; no script references `.pen` | M94.2 (confirm lab) |

### A. Render-fault containment (TOL-01/02): how the flow works

- **Root.** `createRoot(el,{onCaughtError, onUncaughtError, onRecoverableError})` (`T/src/main.tsx:264`):
  - Drops `ResizeObserver loop` noise.
  - Skips errors already marked recovered (`isRecoveredBlockNoteRenderError`, `isRecoveredActionTooltipError`).
  - Otherwise calls `showFatalRenderError` (a fixed `<pre>` with the stack) and `reloadFrontendOnceIfStartupFailed()`.
- **Editor boundary** (`SingleEditorView.tsx:146-190`):
  - `getDerivedStateFromError` stores the error.
  - `componentDidCatch` asks `blockNoteRenderRecoveryReason(error)` and, if a reason exists and `retries < 1`, marks the error, calls `onRecover`, and sets `{recoveryKey+1, retries+1}`.
  - `render` rethrows unrecoverable or exhausted errors; the children are `(recoveryKey) => <BlockNoteView key={recoveryKey} …/>`.
- **Transform path.** `richEditorTransformErrorRecoveryExtension.ts` wraps `view.dispatch` and the `handleKeyDown/handlePaste/handleDrop/…` props. It drops stale transactions (`!view.state.doc.eq(tr.before)`) and repairs malformed blocks.
- **Cerebro shape.**
  - `FaultBoundary(section)` renders `StateMessage state="unavailable"` with Retry; section boundaries go on panes, the side panel, the assistant presentation and the rail.
  - The editor boundary remounts the **presentation only** and re-reads `DocumentOwner.snapshot().latestDraft`.
  - Never `replaceBlocks`, never `blocksToHTMLLossy` (`T/src/components/blockNoteRenderRecoveryDocument.ts:26-45`), and never autosave a repaired tree.
  - The error goes to the existing `installErrorReporting` and is **not** shown as a raw stack.
  - The reason taxonomy is a shared table (CV-04 style) with tests per reason, reproduced first against Cerebro's own editor.

### B. Startup shell (TOL-03/09)

`index.html` <script> (theme) → `#root > #tolaria-boot-shell` (static CSS, own `--startup-*` colours) → stash `window.__tolariaStartupShellFallbackNode = clone` → `<Suspense fallback={<StartupShellFallback/>}>` clones that node (`StartupShellFallback.tsx`) → `<FrontendReadyMarker/>` effect → `markFrontendReady()` (flag + event + clears reload marker). The watchdog (`index.html:263-305`) reloads only if `!ready && !attempted && sessionStorage writable`. `T/src/indexBootDiagnostics.test.ts` holds the markup contract. For Cerebro the shell would draw rail 54px, sidebar 240px and the canvas corner, from token values held by a test (Tolaria duplicates colours by hand).

### C. Native input routing (TOL-04/05/08)

- **Reserved chords:** a narrow `prevent-default` registration in setup, macOS only, with each key justified by a failing native check.
- **Escape:** surface open/close → one boolean `AtomicBool` → AppKit `addLocalMonitorForEventsMatchingMask(KeyDown)` → if `keyCode == 53 && open && fullscreen`, `window.eval(dispatch Escape)` and return null; otherwise pass through. Test `should_suppress_escape` as a pure fn. In Cerebro, `layers.ts` already knows the innermost non-tooltip layer, so report `stack.some(kind !== 'tooltip')`.
- **Zoom:** a keymap row at app scope calls Rust `set_zoom`. Persist the level as an installation-local UI preference, not in the vault. The PDF viewer's `pdf-viewer` scope keeps ⌘=/⌘-.

### D. Command manifest (TOL-06/07)

- **Manifest row:** `fileQuickOpen {id, route:{kind:'handler',handler}, menuOwned, shortcut{combo:'command-or-ctrl', key, code, display, accelerator}}`. Menu items can alias a command with their own id and label (`file-quick-open-alias`). `menuStateGroups.noteDependent: [...]` drives `set_enabled`.
- **Renderer:** `executeAppCommand(id, handlers, source)` records `{id, source, timestamp}` and suppresses the opposite-source echo within 150 ms.
- **Cerebro adaptation:**
  - Command rows gain `menu: {section, label, group?}`.
  - A generated `shared/commands/menu.v1.json` plus a digest test (the policy-artifact pattern) is read by `quit.rs`.
  - Native accelerators go only on menu-owned chords, and those chords are excluded from the capture listener, so execution has one owner per chord instead of a time window.
  - Add Settings… ⌘, to the app menu.

## Avoid / doesn't transfer

- **Props-down god component:** `T/src/App.tsx` (1,926 lines) passes 40+ props to Sidebar, NoteList and StatusBar (ADR 0026, narrowed by 0115). Cerebro's stores are the better shape.
- **Routing on type names:** `TYPE_ICON_MAP` and `TYPE_COLOR_MAP` key on Project/Person/Event… (`T/src/components/NoteItem.tsx:22-36`, `T/src/utils/typeColors.ts:24`). This violates CV-08.
- **Prose-only UI rules:** `T/AGENTS.md` says "Always use shadcn/ui" but `T/eslint.config.js` has no element rule, and about 85 raw `<button>` and 11 `<input>` lines sit in components. One-off inline-styled banners (`ConflictNoteBanner.tsx`, `ArchivedNoteBanner.tsx`) follow from that. Cerebro's lint-held CV-63 is the right model.
- **Lossy editor repair** (`blocksToHTMLLossy` fallback): conflicts with CV-24 and with files being the truth.
- **Error copy through the empty component:** `resolveEmptyText` sends `changesError` through `EmptyMessage` (`T/src/components/note-list/NoteListViews.tsx:9-30`). This violates CV-05.
- **CSS `zoom` for app zoom:** it needs counter-zoom for overlays, a CodeMirror coordinate fix and a block-handle fix, and it caps at 150%.
- **Weak primitives elsewhere:**
  - Toast auto-dismisses after 2 s with no live region and no action (`T/src/components/Toast.tsx`); Cerebro's `ToastHost` owns a `role="status"` region.
  - The mouse-only `ResizeHandle` has no separator role or keys; Cerebro's `src/components/ui/ResizeHandle.tsx` is a keyboard separator with Escape abort.
  - No `prefers-reduced-motion` anywhere in `T/src`.
- **Unbundled fonts:** Inter and IBM Plex Mono are named but there is no `@font-face`, so typography depends on the machine. Cerebro bundles its fonts (`src/styles/tokens/fonts.css`).
- **Separate windows:** extra note windows and the AI workspace native window (ADR 0031/0127/0128) conflict with one assistant instance (M92) and one live editor per file (CV-52).
- **Growing the user's window:** `useMainWindowSizeConstraints` resizes the window's minimum to fit panes. Cerebro parks panes instead (`src/app/shellLayout.ts`).
- **Out of model:** a PostHog/Sentry telemetry mandate per feature, machine-translated catalogs for 21 locales, and `navigator.onLine` as readiness (ADR 0060 admits captive portals).
- **Spellcheck:** Tolaria disables it inside the rich editor (`observeNativeTextAssistanceDisabled` in `T/src/components/SingleEditorView.tsx:1255`). That is a product choice, not a fix.
- **Dead tests:** `T/e2e/` is orphaned, because no Playwright config points at it (`T/playwright.config.ts` uses `testDir: './tests/smoke'`). It also uses `waitForTimeout` and a hard-coded `:5173`.

## Implications for M93-M99

- **M93**
  - **Add M93.12, render-fault containment and startup shell (TOL-01/02/03).** Files: `src/main.tsx`, `src/App.tsx`, `index.html`, new `src/app/FaultBoundary.tsx`, `src/editor/NoteBodyEditor.tsx` and a shared reason table. Tests:
    - `section_throw_renders_unavailable_and_neighbours_survive`
    - `editor_remount_restores_owner_draft_exactly`
    - `unknown_error_stays_fatal_and_logged`
    - `recovery_writes_nothing`
    - `boot_shell_is_the_only_shell`
    - one case per reproduced BlockNote 0.46.2 failure, with a patch pin
  - **Amend M93.11:** add the REL-13 rows for physical-key delivery per bound chord (⌘F, ⌘⇧L, ⌥⌘R, …, TOL-04/07), fullscreen Escape with a dialog open (stays fullscreen) followed by a bare Escape (exits) (TOL-05), and zoom at 200% (TOL-08).
  - **Amend M93.6:** add a `frontend_ready` milestone distinct from vault ready (TOL-03), and the outline cost on large documents (TOL-15).
  - **Amend M93.8:** add the selection/scroll transfer (TOL-16). The byte-exact writer stays.
  - **Confirm M93.1:** an owner that lives above presentation is what lets Cerebro skip Tolaria's lossy repair.
- **M94**
  - **Confirm M94.2:** keep the lab and Cerebro's tokens. Tolaria's DS and `.pen` files are weaker (TOL-19/20).
  - **Amend M94.3:** compare the TOL-10 label grid in the twenty-property scene. Use TOL-13 only if captures clip.
  - **Amend M94.5:** derive menu-bar entries and Settings… ⌘, from the command rows; add row-level unresolved-save markers (TOL-06/12).
  - **Amend M94.8:** add a skeleton variant of loading (TOL-09).
  - **Amend M94.9:** the native 200% zoom gate depends on app zoom; add sampled stability tests (TOL-08/11).
  - **Add M94.10, native command surface and input routing (Rust shell):** a generated menu table and enablement, `set_zoom`, a narrow prevent-default list and the AppKit Escape monitor. It depends on M94.5 vocabulary and is proven in M94.9.
  - **Confirm** first-H1 title projection: Tolaria appears to have converged on the same rule (ADR 0044/0055/0068 file names [names]; not read).
- **M95:** **Confirm** one assistant instance across presentations (avoid Tolaria's AI window). **Watch** ⌘K "leading space asks the agent" (`T/src/components/CommandPaletteAiMode.tsx`), only if routed into that single instance.
- **M96/M99:** **Confirm** policy-as-data. Tolaria independently moved cross-runtime facts into shared JSON after drift: `appCommandManifest.json` via `include_str!`, and `T/mcp-server/app-config-policy.json` read by Rust and Node (ADR 0106/0149). There is no other change; prior T5 holds for M99.
- **M97:** **Watch** the neighbourhood list (TOL-17) as a cheaper M97.5 extension than a graph.
- **M98:** no change.

## Owner questions

1. **Title bar:** switch to an overlay title bar (rail and sidebar to the top edge, traffic-light inset)? It costs drag regions and fullscreen inset handling (TOL-14).
2. **App zoom:** offer app zoom (range up to 200%, ⌘=/⌘-/⌘0 at app scope, the PDF viewer keeping its own)? Without it the M94.9 native zoom gate cannot run.
3. **Menu bar:** populate the macOS menu bar with app commands and Settings… ⌘,? Today only Tauri's default menu ships.
4. **Startup failure:** when the webview paints but never becomes ready, do one automatic reload, or show a recovery screen with Reload?
