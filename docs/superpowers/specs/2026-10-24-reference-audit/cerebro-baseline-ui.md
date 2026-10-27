# CBUI — Cerebro baseline: design system, components and UI surfaces

> Cross-checked 2026-10-27; see codex-crosscheck/.

2026-10-24 · Reference-audit slice CBUI · Source read on `m53-macro-port`
(dirty shared tree, HEAD `6c92709`). Nothing was built, run or tested.

Basis tags: **[read]** code read · **[names]** inferred from file or dir names ·
**[docs]** AGENTS.md or a plan/spec. An "absent" row quotes the grep that found
nothing. Other slices should check every "Cerebro lacks X" claim against §7.

**Headline:** Cerebro already has a deep, test-enforced design system: AA-tested
token ramps, 28 primitives, 31 AI Elements, an explicit layer stack, one keymap,
motion as data and a five-state lab. It also has a Notion-class surface set. The
real gaps are containment (no React error boundary), scale (no table
virtualization) and primitive coverage/adoption (no Tabs, Checkbox or Skeleton;
588 raw `<button>`s; editor menus on BlockNote/Mantine). Owner and native
acceptance is also still open. Missing features are not the main gap.

## 0. Counts

| Item | Count | Source |
| --- | --- | --- |
| Source modules | 448 `.tsx` + 564 `.ts`; 915 test files | `find src` [read] |
| CSS | 53 files, 11,419 lines (largest `src/editor/editor.css` 1,215) | [read] |
| `src/components/ui` | 28 components + `layers.ts`, `motion.ts`, `portalGeometry.ts`, `tooltipWarmth.ts` + `select.css`; **22/28 components have their own test** | [read] |
| `src/components/ai` | 31 elements (29 ported from shadcn AI Elements, MIT; `StepLine`, `Rail` native); 31/31 tested + 5 cross-cutting tests; 8 CSS files | `THIRD_PARTY_NOTICES.md` §shadcn/ui [read] |
| `src/agent/elements` adapters | 31, each with a test | [read] |
| Other shared `src/components/*.tsx` | 12; 10 tested (not `PageHeader`, `MoveDialog`) | [read] |
| Commands | 55 rows in 14 `*.commands.ts` + 12 generated `go.*` = **67** | `src/app/commands/` [read] |
| Destinations | 12, each with a `g` chord | `src/engine/destinations.ts` [read] |
| View kinds / field kinds | 10 / 19 | `src/engine/types.ts` `VIEW_TYPES`; `shared/schema/field-kinds.v1.json` [read] |
| Editor schema | BlockNote 0.46.2 defaults + 10 custom blocks + 2 replaced (image, codeBlock) + 4 inline chips | `src/editor/MarkdownEditor.tsx` `cerebroSchema` [read] |
| State lab | 33 section modules × 5 states | `src/lab/sections/`, `src/lab/presets.ts` [read] |
| E2E | 207 specs (Chromium), 37 also on WebKit; 10 golden images in 3 specs; no axe-core | `playwright.config.ts`, `e2e/*-snapshots/` [read] |
| Raw keydown listeners outside the keymap | 14 files, each listed with its reason | `src/lib/keys/keydownRail.test.ts` `ALLOWED` [read] |
| Coverage floor | lines/statements 82.87, functions 77.39, branches 84.91 | `vite.config.ts` [read] |

## 1. Tokens and styles

### 1.1 Token files

| File | Holds | Mechanism worth knowing |
| --- | --- | --- |
| `src/styles/tokens/colors.css` (379) | Neutral `--n-0…900`; cortex (primary) 50–900; synapse (AI only) 50–700; success/warn/danger steps; `--ent-*`; 8 `--swatch-*`; Notion's ten option triples `--opt-<hue>`, `-bg`, `-ink` (ink ≥4.5:1 on its pill); paired fills `--action-{primary,danger}{,-hover,-press}` + `--on-action-*`; 8 `--avatar-*`; status/health; semantic `--surface-{frame,navigation,app,board,sunken,raised,selected,ai}`, `--text-{primary,secondary,muted,meta,disabled,placeholder,inverse,link,ai}`, `--border-{subtle,strong,focus}`, `--accent*`, `--scrim`, `--canvas-1…6`, `--canvas-dot`, `--diagram-selection-ring` | Dark theme is one `:root[data-theme='dark']` block that **re-points the ramps** (n-0 becomes the darkest), with no per-component dark CSS. No `prefers-color-scheme` query by design, because `useTheme` is the sole decider. A pre-paint script in `index.html` writes `data-theme` + `color-scheme` before boot. Dark shadows and scrim are heavier [read] |
| `tokens/typography.css` (71) | `--font-ui` Instrument Sans, `--font-mono` IBM Plex Mono; numeric `--fs/--lh` 2xs 11/16 … 4xl 42/63; product roles (§1.2); weights 400–700; tracking | Named `--fs-*`/`--lh-*` so they never collide with Tailwind's `--text-*` (M16.36) [read] |
| `tokens/spacing.css` (130) | 4px grid `--sp-05…16`; radii xs 4 · sm 6 · md 8 · lg 10 · xl 14 · full; shadows xs–lg + `--ring`; layout `--rail-w` 54, `--sidebar-w` 240, `--surface-inset` 32, `--surface-readable` 880, `--surface-broad` 1120, `--nav-row-h` 36, `--control-h` 32 / sm 28 / lg 36; motion (§1.3) | [read] |
| `tokens/fonts.css` (37) | Bundled variable Instrument Sans (roman + italic, wght 400–700, wdth 75–100) and Plex Mono 400/500/600, `font-display: swap` | Local files, no font CDN [read] |
| `tokens/base.css` (69) | box-sizing, `overscroll-behavior: none`, body ink/ground, links, `::selection`, `kbd`, `code`, scrollbars | [read] |
| `src/styles/index.css` (434) | Tailwind v4 `@theme inline`: **resets `--color-*`, `--radius-*`, `--text-*`, `--leading-*` to `initial`** so only DS tokens produce utilities; keyframes; shared surface classes | An off-DS class compiles to nothing, so `theme.test.ts` fails on it (§1.5) [read] |

### 1.2 Type roles (Tailwind utilities from `index.css`)

| Utility | Size/leading | Role |
| --- | --- | --- |
| `text-page-title` | 40/48 | Document title (the first top-level H1 shown above the body) |
| `text-workspace-title` | 24/32 | Peek, workspace and utility headings |
| `text-section-title` | 16/24 | `.cb-section-heading` |
| `text-prose` | 16/28 | Authored and assistant prose |
| `text-ui` = `text-base` | 14/20 | Operational text |
| `text-metadata` | 12/18 | Metadata |
| `text-2xs…4xl` | size only, leading deliberately unpaired | Compact chrome (pairs are opt-in via `leading-*`) |

Documented exceptions: inspector 13/18 (`src/detail/inspector.css` re-declares
`--fs-ui`), data-page heading 28/36 (`.cb-data-page` in
`src/styles/surface-system.css`), Pages rows 15/13 and AI 11–14px [docs VS04] [read].

### 1.3 Motion (by kind, never by number)

| Token pair | Value | Used for |
| --- | --- | --- |
| `--motion-hover` | 20ms ease-in | Anti-strobe wash on row sweeps (Notion measurement), **kept under reduced motion** |
| `--motion-move` | 200ms ease | Reflow, slide, resize |
| `--motion-enter` / `-pop` / `-exit` | 240 / 160 / 140ms, ease-out curve `cubic-bezier(.16,1,.3,1)`, exit ease-in | Panels/drawers / menus, tooltips / leaving |
| `--motion-turn`, `--motion-spring`, `--dur-stagger` | 200ms with the enter curve; 240ms overshoot; 24ms | Pill/chevron turns; marks landing; sibling stagger |

Reduced motion zeroes move, enter, pop, exit and stagger, plus Tailwind's
`--default-transition-duration`. It leaves hover alone. Keyframes `cb-fade-*`,
`cb-rise-in`, `cb-pop-*`, `cb-mark-in`, `cb-shimmer` and `cb-ai-shimmer` animate
the individual `translate`/`scale` properties, never `transform`. `motion.css`
adds `@utility motion-hover` (colour properties only) and `motion-move`
(transform family, opacity, box-shadow). Named classes: `.cb-working-text`,
`.cb-ai-shimmer`, `.cb-card-lift`, `.cb-toast`, `.cb-tooltip`, `.cb-hover-card`,
`.cb-popover-leave`, and the drag cursors `.cb-resizing` and `.cb-col-dragging`
[read].

### 1.4 Shared composition and chrome sheets

- `src/styles/surface-system.css` (163) [read]:
  - `.cb-composition` (a named inline-size container) and `.cb-composition-content`. Insets are 16/24/32px below 600, at 600–959 and from 960 (M94.2, opt-in).
  - `.cb-nav-row` 36px; `.cb-data-page` (clamp 16–48px inline, 28/36 heading); `.cb-surface-content` (max 1120px, 32px inset).
  - `.cb-section-heading`; `.cb-state-message` (`--compact`, and `[data-state=unavailable]` with a danger border); agent roster rows 72px; diagram toolbar 52px.
- `src/styles/table-chrome.css` (138): cell chrome (chevron, calendar and pencil glyphs, `.cb-row-chrome`) uses `visibility` and stays hidden until the row is live. A row is live on `:hover`, on `:focus-within` **or** under the roving `[data-focused]` cursor. The Open pill uses opacity, so it stays focusable. Cells get no hover pill [read].
- `src/app/shell.css` (474): m71 rail, sidebar, drawer, fold/reveal; the canvas's single 16px top-left corner [read].
- `src/components/pageFrame.css` (209), `pageToolbar.css` (toolbar `min-height: 64px`), `pageHeader.css` [read].

### 1.5 What the style tests guard

| Test | Guards |
| --- | --- |
| `src/styles/contrast.test.ts` | AA (≥4.5:1) in **both themes** for: `--on-action-{primary,danger}` on rest/hover/press; `--{warn,danger,success}-700` on `-50`; `--text-{primary,secondary,meta,placeholder}` on `--surface-{app,board,sunken,raised}` [read] |
| `src/styles/theme.test.ts` | Every colour, radius and size utility in `src/**/*.ts(x)` names a mapped token, with negative controls. This catches off-DS classes that would otherwise ship as nothing [read] |
| `src/styles/motion.test.ts` | Reads the shipped CSS and checks: the 20/200ms values and their pairs; reduced motion collapses movement and arrival but not hover; keyframes never set `transform`; utilities never use `all`; the CSS that Button, IconButton and SegmentedControl inject spends the hover pair [read] |
| `src/components/ai/styles.test.ts` | The AI shimmer moves only its band, takes its period from the motion token, stills under reduced motion and paints with DS tokens [read] |

**Not guarded:** rendered contrast of real compositions (selection, hover, focus,
translucent overlays) and target sizes. Both are explicitly open [docs
`plans/2026-10-22-ui-refresh-review/04-acceptance-challenge.md` AC05].

## 2. Component layer

### 2.1 `src/components/ui` — every file

| File | Purpose / mechanism | Own test | Importers |
| --- | --- | --- | --- |
| `Avatar.tsx` | Initials avatar; name hash picks one of 8 `--avatar-*` (white ≥4.5:1); `AvatarGroup` +N | ✓ | 3 |
| `BlockDrag.tsx` | Block drag grammar (Notion §C-II): `DragGhostLayer` clone at 0.4 follows the pointer while the source stays put; `InsertionLine` is 4px and a child of its target | ✓ | — |
| `Button.tsx` | primary/secondary/ghost/danger × sm 28 / md 32 / lg 36; press `scale .98`; `testId`; **no loading prop** | ✓ | many (239 uses) |
| `Calendar.tsx` | Month grid with range endpoints | ✓ | 1 |
| `ContextMenu.tsx` | Placed at the pointer, clamped to the viewport; arrows/Home/End; `useFocusRestore` | ✓ | 10 |
| `DatePicker.tsx` | 6 date formats, 3 time formats, reminders, timezone; side flyouts | ✓ | 3 |
| `Dialog.tsx` | Scrim (z 1000), radius-14 card, Tab trap, focus restore, Escape layer, primary/secondary actions, footer note, `fullscreen` variant, exit ghost | ✓ | 41 |
| `DrawerScrim.tsx` | Drawer exits as a layer. In a typed field, the first Escape only blurs it to the drawer; the next closes the drawer and returns focus to the opener. A press on the covered area closes without moving focus. `useDrawerFocus` | ✓ | — |
| `Dropdown.tsx` | Legacy name that renders `Select` | ✓ | 7 |
| `EmptyState.tsx` | Centred icon well, title, one line, one action | ✗ | 25 |
| `Grip.tsx` | Handle kinds `row`/`block`/`tab`, tied to the drag grammar | ✓ | — |
| `HoverCard.tsx` | 300ms open / 150ms close; one open per group; ancestors held; native listeners (ProseMirror chips); opens only on real pointer movement; tooltip-kind layer | ✓ | 4 |
| `Icon.tsx` | lucide, 16px, 1.75 stroke; `ICON_ALIASES` maps renamed lucide names | ✓ | many |
| `IconButton.tsx` | Mandatory label (tooltip + aria-label); 24/28/32px; active/outline | ✗ (motion.test checks its CSS only) | 39 |
| `IconPicker.tsx` | Searchable lucide grid, capped at 96 | ✓ | — |
| `Input.tsx` | Leading icon, suffix, sm/md, focus ring | ✓ | 59 uses |
| `Keycaps.tsx` | Draws catalog keys (Mac glyphs, digit ranges) | ✓ | — |
| `Menu.tsx` | `MenuSurface`/`MenuItem`/`Separator`/`Label`/`Back`: chrome plus roving keys, **no placement** (that is Popover's job) | ✓ | 21 |
| `Popover.tsx` | The one anchored surface: portal, flip, `useDismiss`/`useEscapeLayer`, optional `trapFocus`, `closeOnScroll` (default true), `matchAnchorWidth`, `keyClaim`, `activeDescendant`; `ANCHOR_MOVED_EVENT` re-measures over transformed canvases | ✓ | 52 |
| `ResizeHandle.tsx` | `separator` with arrow keys; window listeners; width measured from drag start; Escape abandons; drawn vs preferred width | ✓ | — |
| `SegmentedControl.tsx` | 2–5 options; a measured pill slides on the turn pair | ✓ | 7 |
| `Select.tsx` (+`select.css`) | The only select (CV-63). Listbox button; the open list holds focus with `aria-activedescendant`; native-select keys; typing on a closed trigger opens without changing the value; `searchable` makes it a combobox | ✓ | 26 |
| `StateMessage.tsx` | `loading`/`empty`/`not-recorded`/`partial`/`unavailable`; unavailable adds `data-testid=section-unavailable` | ✓ | 26 |
| `StatusFlag.tsx` | Fixed six-status chip | ✗ | **0 (dead)** |
| `Switch.tsx` | 32×18, spring thumb | ✗ | 17 |
| `Tag.tsx` | Removable chip | ✗ | **0 (dead)** |
| `Toast.tsx` | 5 tones (neutral/success/warn/danger/ai), action, dismiss, floating exit ghost | ✗ (`app/ToastHost.test.tsx` covers the host) | 1 |
| `Tooltip.tsx` (+`tooltipWarmth.ts`) | 400ms delay; `aria-describedby`, not the name; works on disabled controls; tooltip-kind layer; pointer-only warm toolbar for 700ms | ✓ | 27 |

Not present as primitives in `src/components/ui` [read `ls`]: Tabs, Checkbox,
Radio, Textarea, Slider, Progress, Skeleton, Card, Badge (AI layer only), Table,
Breadcrumb (`src/components/PageToolbar.tsx` `Crumb`), Command (QuickOpen).
`role="tablist"` is hand-built in 7 places: QuickOpen, AddCardPopover, TabBar,
SegmentedControl, RecordTabs, ViewTabs, InlineDiff [read].

### 2.2 Infrastructure semantics

- **`layers.ts`** [read]: one module-level stack, innermost last, with explicit registration (`useLayer` in the layout phase, so the first commit already owns Escape).
  - Kinds are `surface`, `tooltip` and `gesture`. Tooltips and gestures take Escape (`ownsEscape`) but never count as the innermost surface (`isTopLayer`) or as "open" (`hasLayers`).
  - `modal` (default true) is what the keymap stands down for (`hasModalLayers`). The docked record peek registers `modal: false`.
  - `contains(node)` lets a portalled child claim its nodes. `isInsideLayerAbove` keeps an outside press on a nested menu from closing its parent.
  - `subscribeLayers` cancels an armed chord.
- **`motion.ts`** [read]: two ways to leave and two arrival marks.
  - `Presence` keeps a layout-taking panel mounted at `data-state=closed` until its exit plays.
  - `leaveGhost`/`useGhostOnUnmount` lets the real surface (and its layer, focus and Escape) go at once. An inert copy (no id, role, aria or tabindex; `inert`, `aria-hidden`) plays the exit; it keeps scroll positions and typed values.
  - `useArrival`/`Arrival` and `usePageTurn` are marks that come off after one play, so a pane that shows again replays nothing.
  - `motionAllowed()` is false in jsdom and under reduced motion. `LEAVE_CAP_MS` (1000) means no exit can strand a surface.
- **`portalGeometry.ts`** [read]: converts DOMRect to body-portal coordinates under CSS `zoom` (`readPortalViewport`, `toPortalRect`). Used by Popover, Tooltip, HoverCard, FieldPopover and AnchoredFieldStatus. No test.

### 2.3 `src/components/ai` (AI Elements, presentation only, CV-64)

| Group (stylesheet) | Elements |
| --- | --- |
| Foundation (`foundation.css`) | Collapsible, Badge, Item |
| Conversation (`conversation.css`) | Chat, Message (+Bubble, actions), MessageScroller (1,138-line port of `@shadcn/react` headless scroller), PromptInput, Suggestion, Attachment, ModelSelector ("Model and effort"), Questionnaire, Context (+`context-categories.css`) |
| Steps (`trace.css`, `trace-steps.css`) | Trace, **StepLine** (native: 8 transcript states + refused, said in words), Tool, Task, Reasoning, ChainOfThought, Subagent (+SubagentHandoff), Terminal, StackTrace, TestResults |
| Results/decisions (`trace-results.css`) | Plan, Queue, Checkpoint, Confirmation, InlineCitation, Sources, FileTree |
| Code (`code-block.css`) | CodeBlock (shiki) |
| Rail (`rail.css`) | **Rail**, RailSection (native) |

`boundary.test.ts` walks the AST of every module the layer reaches, and fails
on any store, IPC, Tauri or `@/agent/*` import [read]. Adapters live in
`src/agent/elements/` (31 files, including `railSubagents`, `railWaiting`,
`conversationChanges`, `railSources`, `railConnectors`, `railEnvironment`,
`railHandoffs`, `contextCard`, `railPlan`, `turn`, `cards`, `decisions*`,
`composer*`, `writing*`) [read].

### 2.4 Other shared components (`src/components/`)

`FileImage` (the one root-file image; no transient URL is exposed) · `FileThumb`
(derived image only) · `FileLightbox` · `RemoteImage` (CV-61 click-to-load, no
referrer) · `FileTree` (958 lines: create, rename, move, trash, templates) ·
`ListSelectionBar` · `MoveDialog` · `PageCard` (live page card: unset, resolved
and missing faces) · `PageIcon` (emoji, file, lucide or fallback, one glyph
everywhere) · `PagePreview` (hover-card body from the scan; reads no file) ·
`PageHeader` (`variant` workspace/compact/tool, plus opt-in `composition`
collection/utility, which only `src/pages/PagesPage.tsx` uses so far) ·
`PageToolbar` (crumbs, save status Unsaved/Saving…/Saved, actions, panel Close)
[read].

### 2.5 Interaction hooks (`src/hooks/`)

`useDragGesture` (shared pointer-event drag, 15 consumer files, Escape abandons) ·
`useSortableList` (list grammar §C-I: the real row follows the cursor and
siblings slide; 13 consumer files) · `useListCursor` (j/k) · `useFocusRestore`
(opener captured during render; 8 consumer files) · `useOsDropZone` · `useMeasuredWidth` ·
`useTheme` · `useVaultActionGuard` · `useReminders` · `useFeed` · `useInboxQueue`
· `useDocTasks` · `dropPartition` · `sortableGeometry`. `@dnd-kit/core` remains
in 5 files (BlockDrag, LayoutCanvas, useSortableList, BoardView, DashboardView)
[read].

### 2.6 Adoption indicators (drift risk, non-test `.tsx`)

| Metric | Count | Read as |
| --- | --- | --- |
| raw `<button` vs `<Button` / `<IconButton` | 588 vs 239 / 79 | Many raw buttons are legitimate rows and chips, but DS buttons cover a minority of clickables |
| raw `<input` vs `<Input` | 88 vs 59 | |
| arbitrary `-[Npx]` classes / `text-[Npx]` | 328 / 10 | Geometry escapes tokens (only colour, radius and size utilities are test-guarded) |
| `style={{` objects | 253 | |
| Primitives injecting CSS strings into `<head>` at import | 7: Button, IconButton, Input, Dialog, SegmentedControl, Switch, Tag | Two styling mechanisms beside 53 CSS files |
| `PageHeader` consumers | 12, of which 1 uses `composition` | M94.2 roles not yet adopted |

## 3. Surfaces and shell

### 3.1 Shell

- **Rail** (`src/app/AppRail.tsx`, 54px, `inert` when hidden) [read]:
  - Top: brand (→ Home), Search (`palette.open`), New (`create.launcher`), Assistant (`assistant.toggle`).
  - Areas: Home, Pages, Databases, Knowledge, Agents, Work (`NAV_AREAS`, `src/app/shellNavigation.ts`).
  - Bottom: Show sidebar (when collapsed), Theme cycle system→light→dark with a View-Transition reveal (`shellMotion.revealTheme`), Settings.
- **Contextual sidebar** (`src/app/Sidebar.tsx`, 1,092 lines): 240px default, resizable and collapsible, with `SectionHeader` folds and `data-section` ids. The Pages tree shows Collections **or** Folders (`pageTreeMode`). Drawer below the width thresholds. `PageNavigation.tsx` lets Inbox, Settings, Work and Studio lend their navigation; the assistant canvas takes priority [read Sidebar; docs PageNavigation].
- **Width budget** (`src/app/shellLayout.ts`): an explicit give-way order [read]:
  1. canvas;
  2. record;
  3. sidebar;
  4. park panes;
  5. assistant;
  6. sidebar to rail;
  7. park assistant;
  8. tab off-edge.

  Thresholds are literal CSS classes held equal to the arithmetic by `shellLayout.test.ts`, so a window drag settles in one layout pass.
- **Panes**: up to 4 (`MAX_PANES`, `src/engine/panes.ts`), each with its own history and editor. `data-pane-index`/`data-active`/`data-parked`. Parked panes keep editing state. One live editor per file (`claimOf`, CV-52) [read/docs].
- **Hosts mounted once** (`src/App.tsx`): StatusBar, QuickOpen, CreateLauncher (14 create kinds in `createCatalog.ts`: page, sub-page, template, collection, record, sheet, sheet from file, database, database from CSV, whiteboard, prototype, agent, skill, capture), LayoutEditorDialog, ToastHost, ChordHint, RenameLinksHost, RemindersHost, CheckpointHost, JobRunnerHost, AgentActions, PaneLayoutHost, WindowTitle, ChatTurnsHost, plus Recording and Reconciliation banners. `DeepLinkHost` mounts beside `App` in `src/main.tsx`. First run: a VaultChooser with Open demo vault / Choose folder… [read].

### 3.2 Page frame and DocPage

- `src/components/pageFrame.css` + `src/pages/DocPage.tsx` (1,111 lines) [read]:
  - 64px toolbar: crumbs, status, actions.
  - One side-panel slot, `PagePanel = 'details'|'comments'|'history'` (`src/stores/uiStore.ts:19`). It runs the frame's full height, docked or as an `[data-overlay]` drawer, with Close under the toolbar end.
  - `usePageTurn` fades the content on each new page.
- Page menu: Show in Knowledge, Customize layout…, Rename…, Add sub-page, Save as template, Move to folder…, Full width (per page `full_width:` frontmatter), Move to Trash [read].
- `src/detail/PageChrome.tsx`: icon (about 40 emoji, lucide, upload; macOS emoji-picker hint) and cover band. Opening a picker writes nothing [read].
- Title projection: the first top-level H1, drawn as the title inside the one body editor; `PageTitleFallback` uses the filename without writing (M85–86) [docs].
- Inspector (`src/detail/inspector.css`): 13/18 text, 100px label column, 30px rows, folding `InspectorSection`s. `AnchoredFieldStatus` gives each field a persistent `role=status` plus a passive portalled bubble [read].
- Record peek (`src/detail/DetailPanel.tsx` + `DetailHeaderActions.tsx`), non-modal layer:
  - Prev/next record and position in view; Open in full page; width toggle.
  - Record actions: Copy link, Copy path, Duplicate, Customize layout, Delete. **No Open beside** [read].
- `RecordTabs` gives related tabs; `LayoutCanvas`/`LayoutEditorDialog` let a person customize a record's layout [names].

### 3.3 Editor chrome (`src/editor/`)

| Piece | What exists | Basis |
| --- | --- | --- |
| Engine | BlockNote 0.46.2 through `@blocknote/mantine` `BlockNoteView`. Built-in slash, side and formatting menus are off; Cerebro supplies its own. Menus still render BlockNote/Mantine components restyled by `editor.css` (140 lines match `bn-\|mantine`) | [read] |
| Custom blocks | ai, callout, column, columnList, database, mermaid, pageCard, sheet, whiteboard, subPages; gated image; empty-language codeBlock | `cerebroSchema` [read] |
| Inline chips | wikilink, assignee, due, citation | [read] |
| Triggers | `/` (BlockNote entries + Date, Whiteboard, Sheet, AI block, Callout, Mermaid, Database, Sub-pages, Page, N columns); `@` (people, pages, due presets); `[` (`[[` pages, `[^` citations), ranked by personal opens (`menuRank.ts`) | [read] |
| Formatting toolbar | `AiFormattingToolbar`: BlockNote items minus `UNCARRIED_ACTIONS` (10: underline, colour, three alignments, merged cells, block colour, header toggles, file preview), plus Ask AI | `SelectionToolbar.tsx` [read] |
| Block menu | `CarriedBlockMenu` (grip) + `KeyboardBlockMenu` (context-menu key, same operations) | [read] |
| Block drag | `BlockDragLayer.tsx`: pointer events (not HTML5 DnD, which no test could drive), insertion line, drop into columns | [read] |
| Columns | `:::columns`, `ColumnGutter.tsx` resize (Escape restores ratios) | [read] |
| Code block | shiki, full language list, picker is the DS `Select` (CV-63) | `codeBlock.tsx` [read] |
| Find/replace | `FindBar.tsx`: ⌘F, ⌥⌘F, ⌘G/⇧⌘G; acts on the focused page; Replace is an ordinary edit | [read] |
| Ask AI | `AskAiPopover.tsx`: selection → rewrite shown per hunk with Accept/Reject; never streams into the buffer; skills on selection | [read] |
| Outline | `DocOutline.tsx` on the page (current-section tracking) | [read] |
| Recovery | `NoteBodyEditor.tsx` "Retry save"; `RecoverySaveStatus.tsx`; `MergeChoices.tsx` + `reconcile.ts` for outside edits; `DeletedDraftRecoveryFace.tsx` | [read] |
| Also | `SubPageList`, `TableSizePicker`, `MentionLinkAction`, `SectionFlash` (section-link landing), comment highlights, attachments (CV-56) | [names] |

### 3.4 Views (`src/views/`, 47 modules)

- **Kinds:** table, list, board, calendar, gantt, timeline, gallery, chart, dashboard, whiteboard [read].
- **Capability flags:** `viewKinds.ts` declares them per kind, one list instead of three: dated, groupable, chips, zoomable, dependencies, cards, preview, covers, groupColumns, dayGrid, tabular, nameColumn, charted, blocks [read].
- **Table** (`TableView.tsx`, 3,346 lines):
  - Header 36px; rows compact/default/tall = 32/44/56px (`tableAnatomy.tsx`); frozen columns.
  - Roving cursor with `aria-activedescendant` (`useRowKeyboard`); hidden chrome (§1.4).
  - Column resize and reorder; groups; footer calculations.
  - **Not windowed.** A load limit applies, and `ViewLimitNotice` says "Showing N of M" with Show all [read].
- **Other views:** board (dnd), calendar + `CalendarTimeGrid`, gantt/timeline (`TimeAxis`, `TimeViewport`, `useTimeDrag`, `useScheduleDrag`), gallery, chart (copy/save PNG/SVG, `chartExport.ts`), dashboard (blocks), whiteboard tab [read/names].
- **Shared controls:** `ViewTabs` (incl. Export as CSV…), `ViewSettingsPanel` (2,026 lines), `FilterBuilder`/`FilterChips`/`FilterValueEditor`, `QuickAdd`, `BulkSetMenu`, `RecordRowMenu`, `DatabaseBlockView` (inline database with missing-source repair), `ViewProblems` [read/names].

### 3.5 Destinations and surfaces

| Surface | Entry | What exists | Basis |
| --- | --- | --- | --- |
| Home | `src/pages/HomePage.tsx`, `pages/home/` | Pull-only lanes in `engine/homeLanes.ts` order: My work, Waiting on you, Agents, Captures, Reminders, Knowledge changed, Your recent edits, Coming up; empty lanes silent; failures local | [read] |
| Pages | `PagesPage.tsx`, `pagesBrowser.css` | All pages / Recently opened / Favorites shelves; list + grid; search; visit state; first M94 collection composition (48px rows) | [read/docs] |
| Collections | `CollectionPage.tsx`, `app/CollectionTree.tsx`, `CollectionDialog.tsx` | Container home page; sidebar tree | [names] |
| Databases | `TypePage.tsx` (records + Properties tab), `ListPage.tsx` (saved views as tabs) | Schema editing through batches | [read headers] |
| Knowledge | `KnowledgePage.tsx`, `src/knowledge/` (24) | Concepts/Review/Activity; `ConceptReviewBar` (human-only Verify); ReviewQueue; EntityDossier; KnowledgeStrip on pages | [read/docs] |
| Inbox | `InboxPage.tsx` (1,373) | Capture queue, reader, organize, selection bar, auto-advance, `inbox.file` | [read imports] |
| Agents | `AgentsPage.tsx` + `src/status/` | Roster, run history, fleet, wakes, follow-ups; `RunDetailPanel`, `RunTranscript`, `RunWhy`, `NeedsYouSection`, `PendingWriteCard` | [read imports] |
| Agent page / Library | `src/library/` | `AgentPage` (Instructions/Runs/Memory), `AgentProperties` (grant rows write on Done, CV-25; connector read has an Unavailable state with Retry), `LibraryIndex`, `SkillEditor`, `TemplateEditor`, `ScheduleField`, `RecipesOffer` | [read/docs] |
| History | `PulsePage.tsx`, `src/history/`, `src/git/` | Year heatmap + feed; per-page History panel; RecoveryVersions; VersionPreview, DiffView, ProseDiffView, InlineDiff; "unattributed" vs "attribution unknown" (`git/CommitAuthor.tsx`) | [read] |
| Settings | `SettingsPage.tsx`, `SettingsNavigation.tsx` | 11 sections: General, Reminders, Keyboard shortcuts, Vault, Knowledge, History, Recently deleted, Assistant, Mail, Other apps, About (Product help). Appearance = Theme only | [read] |
| Work | `WorkspacePage.tsx`, `src/workspace/` | Mounted repositories: RootTree, TabBar, EditorGroups, Breadcrumb; viewers Code (shiki), Doc, Image, Media, PDF (pdf.js find/zoom/outline), Table (CSV), Unknown; FileActions | [read/names] |
| Studio / Changes / My work | `StudioPage.tsx`, `ChangesPage.tsx`, `MyWorkPage.tsx` | Prototype preview + assistant; git changes with guarded Discard; open records across databases | [read headers] |
| Whiteboard | `src/whiteboard/` (32) + `engine/scene/` | JSON Canvas; tools select, hand, text, rectangle, ellipse, connector, line, pencil, eraser; cards, ports, inspector, clipboard, mermaid conversion; serial saves (CV-55) | [read] |
| Sheets | `src/sheet/` | IronCalc in Rust; **windowed** `SheetGrid`; FormulaBar/FormulaInput completion; xlsx/CSV import and export; SheetAsk | [read] |
| Diagrams | `src/mermaid/`, `DiagramPage.tsx` | Mermaid block, lightbox, full-screen structural flowchart editor (shapes, edges, subgraphs, links) | [names] |

### 3.6 Assistant and rail (`src/agent/`)

- Presentations are `floating` (default; minimized to a 48px button), `panel` and `canvas` (`uiStore.aiPanelPresentation`). One instance keeps thread, draft, stream and approvals across all of them (`AiPanel.tsx`, 2,289 lines) [read/docs].
- Turn: `ChatTurn.tsx` → `toolRenderers.tsx` `StepItem`. Cards: Permission, WriteApproval, Question, Interaction, Proposal, ViewSuggestion, AiAction, FailureNotice; plus TurnChangeset, TurnError, UpNext, ReviewNotesDock, ConversationSwitcher, RunOptionsPicker, MessageMarkdown (react-markdown + GFM) [names].
- Canvas rail (`agent/rail/ConversationRail.tsx`) shows cards in a fixed order: Waiting, Plan, Subagents, Changes, Handoffs, Context, Sources, Connectors, Environment. It docks at `CHAT_RAIL_DOCK_MIN` (`shellLayout.ts:443`), becomes a drawer below that, and toggles with ⌥⌘R [read].

## 4. Interaction infrastructure

| Piece | Mechanism | Basis |
| --- | --- | --- |
| Keymap | `src/lib/keys/root.ts` is one capture-phase `window` listener. Scopes are DOM regions (`data-key-scope`), resolved by focus, then the last pointerdown (WKWebView never focuses clicked buttons), then the page. `data-key-neutral` chrome. **Escape is refused in every spec** (`combo.ts`) | [read] |
| Claims | `claims.ts`: `typing` keeps unmodified keys; `editor` adds ⌘Z/⇧⌘Z/⌘Y, ⌘B/I/U, ⌘A, ⌘Enter. Editables claim `editor` implicitly, so new app shortcuts work inside editors | [read] |
| Registry | `registry.ts`: newest binding eclipses older ones per scope; innermost-first walk; `useCommand` binds in layout effects with handlers in refs | [read] |
| Chords | `g` + key for 12 destinations; hint after 200ms (`HINT_MS`), reset at 2s; `ChordHint.tsx` | [read] |
| Catalog | 67 commands, 14 files, groups General · Go to · Create · Pages · Panes · Lists · Record peek · Home · Inbox · Work. Flags `inEditor`, `inModal`, `desktopOnly`, `palette`, `aliases`, `shadows`. Feeds ⌘K, Keycaps and Settings → Keyboard shortcuts (**read-only, no rebinding**) | [read] |
| Guard | `keydownRail.test.ts` lists 14 non-keymap listeners with reasons; `commands/index.test.ts` refuses an Escape binding | [read] |
| Quick Open | `src/app/QuickOpen.tsx` (840): categories All/Pages/Databases/Places/Commands; nested choosers (theme, favorites, agents); Ask rows; page-text search (`useContentSearch`: 250ms debounce, ≥3 chars, 50 hits, `unavailable` ≠ empty); uFuzzy ranking (`lib/nameRank.ts`) | [read] |
| Focus/Escape | `layers.ts` (§2.2); `useFocusRestore`; Dialog and Popover Tab traps; DrawerScrim; ResizeHandle and drag gestures register `gesture` layers | [read] |
| Toasts | `uiStore.toast(message, {action})` → `ToastHost`: `aria-live=polite` region always mounted, z 1100 above dialogs, auto-dismiss 6s (10s with an action), hover/focus pauses. **Every toast is the neutral tone; `ToastItem` has no tone; no history** | [read] |
| State lab | `state-lab.html?section=&state=`: 33 modules with all 5 states or `collectSections` throws; seeds plus `failNext` faults; clock pinned; replayed by `presets.test.tsx` and `e2e/state-lab.spec.ts`. `CompositionLab.tsx` gives dev-only exact-width specimens (`?composition=`) | [read] |
| E2E conventions | `e2e/boot.ts` (CV-15: clock `VAULT_TODAY`, theme pinned, distiller off); UTC; `reducedMotion: 'reduce'` for every spec except `motion.spec.ts`; held-clock assistant stepping (`holdClock`/`stepUntil`); mock drop hooks; 37 specs also run in WebKit (the shipped engine); goldens in `polish-integration` (6), `surface-states` (2), `surface-system` (2) | [read] |
| Test setup | `src/test/setup.ts` resets keymap, key root and tooltip warmth; guards keep mermaid, pdf.js and IronCalc out of ordinary tests | [read] |

## 5. Gaps and open work

### 5.1 Grepped absences

| Absent | Evidence (pattern → result) |
| --- | --- |
| React error boundary | `componentDidCatch\|getDerivedStateFromError\|ErrorBoundary\|onUncaughtError` → 0 in `src/`. `src/main.tsx` `createRoot` takes no options; only `lib/diagnostics.ts:63-64` window `error`/`unhandledrejection` to the log [read] |
| Table/list row virtualization | `virtualiz\|useVirtual\|overscan` → only `sheet/SheetGrid.tsx` (windowed) and `workspace/treeRows.ts` ("windowing is deferred", M30.14). `TableView` relies on the load limit [read] |
| Skeleton loaders | `skeleton` → 0. Loading is `StateMessage` `loading` or `.cb-working-text` [read] |
| Tabs, Checkbox, Radio, Textarea, Progress, Card primitives | not in `src/components/ui`. 15 raw checkboxes, 20 raw textareas, 0 `role=progressbar` [read] |
| Button loading state | `ButtonProps` has none [read] |
| Shortcut rebinding | `KeyboardShortcutsSettings.tsx` renders `keyedCommands()` read-only [read] |
| i18n / RTL | no i18n dependency in `package.json`; `dir="rtl"\|direction: rtl` → 0 [read] |
| Math/LaTeX | `katex\|latex\|mathjax` → 0 [read] |
| Graph view, slides/presentation, web-bookmark/unfurl block, daily notes | `GraphView\|knowledge graph`, `slideshow\|presentation mode`, `unfurl\|linkPreview`, `dailyNote` → 0 product hits [read] |
| Page export to PDF/HTML | `window.print\|exportPdf` → 0. The Markdown file is the export (plus Save a copy, CSV/xlsx/chart exports) [read] |
| Automated accessibility | no axe-core in `package.json`/`e2e` [read] |
| Open beside from the record peek | `DetailHeaderActions.tsx` labels exclude it [read] |
| Missing-page recovery | `DocPage.tsx:335-350` (`DeletedDraftRecovery` holds an unsaved draft first). Its fallback `EmptyState` offers only "Go home", with no Restore-from-Trash and no Back [read] |

> **2026-10-27 (Codex cross-check, CX-AFY-11):** The Go-home face is now `src/pages/DocPage.tsx:344-348`. The claim stands.

| Absent | Evidence (pattern → result) |
| --- | --- |
| Toast severity/history | `ToastItem = {id, message, action?}`; `ToastHost` comment: "there is no history to recover it from" [read] |

### 5.2 Drift and partial adoption

- **Two menu systems.** DS `Menu`/`Popover` everywhere, but BlockNote/Mantine suggestion menus, toolbar and side menu in the editor (`src/editor/MarkdownEditor.tsx`, `SelectionToolbar.tsx`, `editor.css`) [read].
- **Context menus are hand-written lists.** 9 of 10 `ContextMenu` consumers never reference the command catalog, so labels and availability can diverge from ⌘K [read] (PJ08 [docs]).
- **Dead primitives.** `StatusFlag` and `Tag` have 0 importers. `EmptyState` (untyped) sits beside `StateMessage` (state-typed); an `EmptyState` used for a failed read would break CV-05 and nothing lints it [read].
- **Header geometry drift.** `pageHeader.css` uses 24/32 with a 32px top; Pages 28/36 with 36px top; database pages 28/36 with 40px top; Library 48px top [docs VS01]. Radii drift: tokens are 4–14, but live styles use 12, 16, 18 and 24 [docs VS07].
- **Six primitives without their own test** (EmptyState, IconButton, StatusFlag, Switch, Tag, Toast), plus `portalGeometry`, `PageHeader` and `MoveDialog` [read].

### 5.3 Program work still open (M94 and neighbours)

| Phase | State (2026-10-24) | Source |
| --- | --- | --- |
| M94.1 baseline | Evidence README + manifests; no native/live capture | `specs/2026-10-23-m94-ui-implementation/README.md` [docs] |
| M94.2 roles | Opt-in `PageHeader.composition` + `.cb-composition`; 4 geometry tests at 360–960px; ~~**owner choice pending**~~ | `composition-sheet.md`, `interaction-results.md` [docs] |

> **2026-10-27 (Codex cross-check, status-drift S15, N1):** The owner accepted the refined composition on 2026-10-25 (16/24/32px pane-relative insets at 600/960px; wider adoption authorized; `specs/2026-10-25-m94-refined-composition-decision.md:3,7`). Consumers now: `utility` in `src/pages/SettingsPage.tsx:374`; `collection` in Pages, Library, Workflow Library, Agents, My work and Knowledge (grep).

| Phase | State (2026-10-24) | Source |
| --- | --- | --- |
| M94.3 four surfaces | Pages candidate 2 passes 14 Chromium/WebKit cases. Document measure already **708px** inside 880 (no width change). Record, inspector and table remain the baseline | `interaction-results.md` [docs] |
| M94.4 creation recovery | Implemented and independently reviewed (58 tests): `stores/creationDraftStore.ts`, `app/creationSubmission.ts`, `CreationDestinationField`, `CreationDraftRecovery`, `CreationTransferChoice` | record [docs] + `ls` [read] |
| M94.5 return/vocabulary | Show all properties / Hide properties copy done (48 checks); return journeys open | record [docs] |
| M94.6 data views, M94.7 conversation (gated on the M91→M92 handoff), M94.9 native/owner | Open. `native-results.md`: **no native acceptance performed** (WKWebView 900×600, IME, VoiceOver, 200% zoom) | [docs] |
| M94.8 utilities | Connector-inventory Unavailable/Retry done (242 checks); rest open | record [docs] |
| Failing existing checks | Library light golden: expected 872px, got 862px; dark case times out locating the sidebar New (the launcher moved to the rail) | `interaction-results.md` [docs] |
| Scale | Historical p95 key-to-frame 398.8ms (1,000×12) and 1,376.2ms (1,000×24); 5,000×12 timed out (headless). M93.6 smoke is correctness-only with timings withheld | PJ02, record [docs] |
| Harness noise | React act warnings, Node localStorage config, Playwright colour env | `interaction-results.md` [docs] |

## 6. Distinctive strengths (unlikely in references)

| Strength | Mechanism | Enforced by |
| --- | --- | --- |
| Every offered block survives a save (CV-24) | `DROPPED_SLASH_KEYS` (empty), `UNCARRIED_ACTIONS`, `TABLE_SETTINGS`; carriers `:::toggle`, `:::columns`, `:::ai`… | `src/editor/markdown.test.ts:1279,1534` walk the real builders; WebKit `editor-carriers.spec.ts` [read] |
| Five read states, never collapsed (CV-05, CV-44) | `StateMessage` `data-state`; lab presets per section; `ContentSearch` `unavailable`; "unattributed" vs "attribution unknown" | `lab/presets.ts` refusal, `presets.test.tsx`, `e2e/state-lab.spec.ts` [read] |
| Explicit layer stack | kinds + `modal` + `contains()` for portalled nesting; one Escape per layer | `layers.test.ts`, keydown rail [read] |
| One keymap, one catalog | capture root, claims, scopes, chords → palette, keycaps and Settings from the same rows | `keydownRail.test.ts`, `commands/index.test.ts` [read] |
| Motion as data | kind pairs; reduced motion collapses tokens but keeps hover; `Presence` vs inert `leaveGhost`; one-play marks | `styles/motion.test.ts` (shipped bytes), `e2e/motion.spec.ts` [read] |
| Theme by ramp inversion, a single decider and token tests | one dark block; `data-theme` only; pre-paint script | `contrast.test.ts` (AA both themes), `theme.test.ts` (unmapped classes) [read] |
| No native select; remote images wait for a click | `Select` keyboard model; image components only | `eslint.config.js` rules + `scripts/lint-rails.test.ts` (CV-61, CV-63) [read] |
| AI layer presentation-only | 31 elements; 31 adapters | AST `boundary.test.ts` (CV-64) [read] |
| Writes carry receipts; attribution is never inferred | History wording from records only | CV-33/CV-35 tests [docs] |
| One live editor per file across 4 panes | `claimOf`, parked panes keep state | `panes.test.ts` property test (CV-52) [docs] |
| Frame-perfect shell budget | thresholds as CSS classes, held to the arithmetic | `shellLayout.test.ts` [read] |
| Refusals stay attached to their field | `AnchoredFieldStatus` persistent status + passive bubble; no raised cells over frozen columns | [read/docs AC06] |
| Testable, measured drags | pointer `useDragGesture`; Notion-measured grips and ghosts | `BlockDrag.test.tsx`, e2e [read] |
| Deterministic, packaged-engine e2e | pinned clock/theme/UTC/reduced motion; 37 specs on WebKit | `playwright.config.ts`, CV-15 [read] |

## 7. Claim check: what exists

| Feature | Status | Where |
| --- | --- | --- |
| Command palette, full-text search, choosers | exists | `app/QuickOpen.tsx`, `useContentSearch.ts` [read] |
| Shortcut catalog, chords, Settings list | exists (no rebinding) | `app/commands/`, `pages/KeyboardShortcutsSettings.tsx` [read] |
| Slash menu, @-mentions, `[[` links, footnote citations | exists | `editor/MarkdownEditor.tsx` [read] |
| Callout, toggle, columns, code (shiki), table, image/file/audio/video, mermaid, inline database, page card, sub-pages, sheet, whiteboard, AI block | exists | `cerebroSchema` [read] |
| Block drag, insertion line, drop into columns | exists | `editor/BlockDragLayer.tsx` [read] |
| Formatting toolbar, block menu, keyboard block menu | exists | `editor/SelectionToolbar.tsx`, `KeyboardBlockMenu.tsx` [read] |
| Find and replace | exists | `editor/FindBar.tsx` [read] |
| On-page outline / TOC | exists | `editor/DocOutline.tsx` [read] |
| Link hover preview | exists | `ui/HoverCard.tsx`, `components/PagePreview.tsx` [read] |
| Backlinks and outgoing links | exists (Details panel) | `detail/DocSidePanel.tsx` `backlinksFor` [read] |
| Comments with threads and @agent turns | exists | `detail/CommentsPanel.tsx`, CV-31/36 [read/docs] |
| Page history, diffs, version preview, recovery versions | exists | `history/`, `git/` [read] |
| Trash with restore | exists | `app/TrashSettings.tsx` (Settings → Recently deleted) [read] |
| Undo/redo of batches + Undo toast | exists | `stores/undoStore.ts`, `app/ToastHost.tsx` [read] |
| Templates | exists | `library/TemplateEditor.tsx`, `app/applyPageTemplate.ts`, DocPage "Save as template" [read] |
| Page icon (emoji, lucide, upload) and cover | exists | `detail/PageChrome.tsx` [read] |
| Full-width page | exists (frontmatter) | `pages/DocPage.tsx:402` [read] |
| Favorites, recents | exists | `app/FavoriteStar.tsx`, Pages shelves [read] |
| Split view | exists (≤4 panes) | `engine/panes.ts` [read] |
| Breadcrumbs, window title, status bar | exists | `components/PageToolbar.tsx`, `app/WindowTitle.tsx`, `app/StatusBar.tsx` [read] |
| Save status with Retry | exists | `PageToolbar.tsx`, `NoteBodyEditor.tsx` "Retry save" [read] |
| 10 database layouts, filters/sorts/groups, saved view tabs, bulk edit | exists | `src/views/` [read] |
| CSV/xlsx/ICS import; CSV/xlsx/PNG/SVG export | exists | `app/CsvImportDialog.tsx`, `IcsImportDialog.tsx`, `sheet/`, `views/chartExport.ts` [read/names] |
| Whiteboard, spreadsheet, PDF viewer, image lightbox | exists | `whiteboard/`, `sheet/`, `workspace/viewers/`, `components/FileLightbox.tsx` [read] |
| Dark/system theme with animated switch | exists | `hooks/useTheme.ts`, `app/shellMotion.ts` [read] |
| AI chat (3 presentations), inline rewrite with per-hunk accept, AI block, conversation rail | exists | `agent/`, `editor/AskAiPopover.tsx` [read] |
| Onboarding: demo vault, starter kit, product help | exists | `App.tsx` VaultChooser, `app/StarterOffer.tsx`, `app/ProductHelp.tsx` [read] |
| Deep links, native notifications | exists | `app/DeepLinkHost.tsx`, `src-tauri/src/shell/notify.rs` [docs] |
| Error boundary, row virtualization, skeletons, Tabs/Checkbox primitives, rebinding, i18n/RTL, math, graph, slides, PDF export, axe, peek Open beside | **absent** | §5.1 |

## 8. What the baseline means for M93–M99

- **Treat feature-presence claims from other slices as adoption or consistency gaps** unless §5.1 lists the feature as absent. Most reference "features" already exist (§7).
- **Real containment gap: no error boundaries.** This is absent, and it fits M93 (reliability) or M94.1 better than any visual phase.
- **Scale stays measurement-first** (M93.7). Only the sheet grid is windowed. `TableView` virtualization must keep keyboard End, find, refused drafts and the accessibility tree (PJ02 rejected `content-visibility`).
- **Primitive gaps M94.2–M94.8 will hit:** Tabs (7 hand-built tablists), Checkbox, Textarea, Skeleton, toast tone/history, Button loading, and the BlockNote/Mantine editor-menu boundary. Decide them before propagating composition roles.
- **Keep the guards above as non-negotiable acceptance tooling.** A reference pattern that cannot pass CV-24, CV-44, CV-63/CV-61 or the layer/keymap rails needs adapting, not adopting.
