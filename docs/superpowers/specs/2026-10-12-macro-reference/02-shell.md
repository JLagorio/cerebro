# Macro reference — App shell: navigation, split window manager, command palette, keyboard model, design system

**Scope**: Macro's app shell, read 2026-10-12 from `docs/examples/macro-main/` (vendored, gitignored). Every Macro path
is relative to that root; Cerebro paths are relative to the repo root.
**Owner's rule (2026-10-12)**: Cerebro builds its own version, with Macro's code as the guide and never a 1:1 copy.
Modes: rebuild (fidelity mirror / adapt / inspire), adopt-upstream, reuse-permissive, skip.
**Licence**: root `LICENSE.txt` is AGPL-3.0; `apps/web/LICENSE` reads "Copyright 2023 CoParse, Inc. All rights
reserved." and covers every `apps/web` unit here. `packages/machine` and `crates/favorites` declare no licence field
(root AGPL applies). Only upstream deps are adoptable: `@leeoniya/ufuzzy` 1.0.19 (MIT, verified), `@phosphor-icons/core`
(MIT), `colorjs.io` 0.5.2 (MIT, optional). Brand marks under `apps/web/src/components/icon` and `apps/web/src/lib/design`
are not portable.
**Evidence**: stages 1–2 read code; stage 3 re-read both trees and ran uFuzzy probes on a scratchpad copy of the MIT
library. No Cerebro app, vitest, e2e or Macro build was run. Stage 3 overrides 1–2.

---

## 1. What it is

- SolidJS SPA (web + Tauri 2) around a custom **split router**: tiling panes encoded in the URL, per-pane history,
  claims (one live view per entity), injected pane policy, and a navigation pipeline written as a pure transition table.
- Around it: a 56px icon rail, ViewShell workspace sidebars (aside/main/detail), a scope-tree hotkey engine with leader
  chords (`c`, `g`, `o`), ⌘K fusing fuzzy relevance with recency, a create launcher, OKLCH token themes.
- Highest value for Cerebro (single-pane `navStore`, React 19): the keymap/command registry, palette ranking, and claims.

## 2. What users get

| Feature | UX details and shortcuts | Paths |
| --- | --- | --- |
| Split window manager | URL `/app/home/~/drive`, per-pane `s0.drive.sort=…`. ⌘\\ or `\\` new Home split; Shift+click / Shift+Enter open in a new split; Shift+H/L focus; Shift+Esc spotlight over glass scrim; ⌘/⌥Esc close (or back to list when a detail is open); ⌥[ ⌥] split history. 400px min per split (`DEFAULT_SPLIT_MIN_WIDTH`), New Split disables when full; no hard cap. Last pane navigates Home. One entity per pane/preview: explicit opens toast "Content already open", mentions/notifications activate the owner silently; Back/Forward skip entries held elsewhere. Bento panels, 6px insets, inactive panes darker. | `apps/web/src/lib/split-router`, `apps/web/src/components/app/split-layout/layoutManager.ts`, `apps/web/src/components/app/split-layout/registerSplitHotkeys.ts`, `docs/AGENT_GUIDE/navigation.md` |
| Icon rail | 56px; 40px buttons, Phosphor 20px (fill when active); tooltips 400ms/300ms grace show the `g` chord. Home h, Drive f, Email e, Chat c, Tasks t, Calendar r, Agents a, Customers o, Calls l, Reviews v. Hide/reorder (drag or Up/Down), Home pinned first, `macro:sidebar:prefs`. Unread **dots**, never counts. Rail is hotkey-scope-neutral. | `apps/web/src/components/app/sidebar-next/sidebar-rail.tsx`, `apps/web/src/components/app/sidebar-next/nav-items.ts`, `apps/web/src/components/app/sidebar-next/use-sidebar-prefs.ts` |
| ViewShell sidebars | Aside 256px (224–360), overlay below 720px; detail inline/overlay/replace/hidden. ⌘. toggles nav per split (works while typing, 140ms, sticky per app type; narrow overlay never rewrites the wide pref). 48px title bars, 32px rows (44 touch), `--sidebar-*` geometry tokens. | `apps/web/src/components/view-shell/ViewShell.tsx`, `apps/web/src/components/view-shell/view-shell-layout.ts`, `apps/web/src/components/view-shell/README.md` |
| ⌘K palette | Chips All/Command/Agents/Files/Tasks/Projects/Channels/People; Tab cycles, `o`+l/m/a/f/t/c/p jumps. Enter opens, Shift+Enter new split, ↑↓ or Ctrl+K/J. Empty query = recency (viewedAt → updatedAt, stable tiebreak). Cached hits instantly, CRM ~250ms later; settled empty "No results found". Change theme previews on highlight, Esc restores. Entity-action mode; "Open favorite…" sub-view. | `apps/web/src/features/command/CommandMenu.tsx`, `apps/web/src/features/command/useCommandItems.ts`, `apps/web/src/features/command/rank-command-search-items.ts`, `apps/web/src/lib/core/util/freshSort.ts` |
| Create launcher (`c`) | ≤3 Recents by lastUsedAt, then groups Docs/Organization/Design/Data/Comms/Tasks/AI/Other with a details pane (tagline, examples). `c`+e/u/a/k/d/t/p/s/m/g/c/n/f/o. `/` toggles persisted search mode (no chords there). Hold Shift → "In new split". Carousel variant behind a PostHog flag. | `apps/web/src/features/command/Launcher.tsx`, `apps/web/src/features/command/core/create-menu-details.ts`, `apps/web/src/features/command/core/launcher-history.ts` |
| Keyboard model | `g`+key go (hint 200ms, reset 2s; `g g` list top); `c`+key create; `o`+key category. Lists: j/k, Shift+j/k extend, x, ⌘A, gg/Home, G/End, h/l, Enter, Shift+Enter, Esc. Views: 1–9 tabs, Tab cycles, ⌘F, f filter, s sort. Entity: e done, r rename, m move, ⌘D, ⇧⌘C. ⌘Z/⇧⌘Z mutation undo. Letters inert in editors unless `runWithInputFocused`. Shortcuts page is read-only (hard-coded, see §8); no rebinding. | `apps/web/src/lib/core/hotkey/hotkeys.ts`, `apps/web/src/lib/constants/hotkeys.ts`, `apps/web/src/components/app/GlobalHotkeys.tsx`, `apps/web/src/components/list/use-list-interactions.ts`, `apps/docs/keyboard-shortcuts.mdx` |
| Home / unified inbox | Server work feed merged with own work. Sections Last few minutes → Older; minute-quantized clock, rechecked 30s. `f` filter (Status + Type, per user). j/k drive inline preview; `e` done + Undo. AI composer start pane, ≤3 suggestions. Per-source retry notice. | `apps/web/src/features/home`, `apps/docs/product/inbox.mdx` |
| Hover cards | Choke groups keep one open branch; nested cards keep ancestors; portaled child holds parent open. 100ms open / 150ms close. User card: copy email/name, open contact, DM, assign; copy confirms after the clipboard write. | `apps/web/src/lib/core/component/HoverCard.tsx`, `apps/web/src/lib/core/component/ItemPreview.tsx` |
| Favorites | Context menu: open in new split (disabled when full) / fullscreen (>1 split) / current split / remove. Durable offline queue, re-add appends, server cap 500. | `apps/web/src/features/favorites/FavoriteContextMenu.tsx`, `apps/web/src/features/command/FavoritesCommands.tsx`, `crates/favorites` |
| Themes | 13 built-ins (Macro Dark, Gruvbox, Void, Ember, Spirit, Moon, Rain, Macro Light, Satsuma, Lapis, Flora, Paper, Decepticon); custom OKLCH themes, clipboard import, v0→v3 migrations; per-mode theme; contrast guard swaps to Macro Dark below 0.2 lightness delta; monochrome icons. | `apps/web/src/features/theme`, `apps/web/src/index.css`, `apps/web/src/features/settings/Appearance.tsx` |
| Settings | Split view `/settings/<tab>`; groups Blocks/Personal/Workspace/Developer; one-edit typo search ("singature"), parent page under result, scroll + highlight; ↓ focuses first result; Esc clears then closes. | `apps/web/src/features/settings/Settings.tsx`, `apps/web/src/features/settings/core/settings-search.ts`, `apps/web/src/lib/core/constant/settingsTabsConfig.tsx` |
| Tours / tutorial | Per-view tours with beacons, never navigate; per-user localStorage progress; flag-gated, desktop only. Sandbox lessons (command-k, create-entity, sidebar-nav, markdown-mentions). | `apps/web/src/features/tours/ViewTour.tsx`, `apps/web/src/components/ui/components/Tour/targets.ts`, `apps/web/src/features/tutorial` |
| Boot + warmup | `index.html` paints rail + content card in saved theme before JS; 180ms fade, 8s cap. Idle warmup of likely-next views from 2.5s, one at a time. Chunk-load failure → Reload on the rail. | `apps/web/index.html`, `apps/web/src/components/app/boot-shell.ts`, `apps/web/src/routes/shells.tsx` |
| Dev surfaces | `/debug/<id>`: UI gallery from `*.docs.tsx` (demo regions + @do/@dont JSDoc), hotkey debugger (scope chain, pressed keys, shadowed/eclipsed). | `apps/web/src/features/ui-gallery/registry.ts`, `apps/web/src/features/devtools/HotkeyDebugger.tsx` |
| macOS title bar | 40px overlay, `data-tauri-drag-region`, 88px traffic-light inset, New Split button. | `apps/web/src/components/app/DesktopTitleBar.tsx` |

## 3. How it's built

**Boot chain**: `index.html` boot shell → `src/index.tsx` → `routes/Root.tsx` (providers, theme + contrast guard,
`IsomorphicRouter`: hash on Tauri, `/app` base on web) → `AppRouterView` builds a SplitRouter (history adapter, memory
`PaneStore`, app pane policy, middleware) → shell (Auth/Focused/App) → `AppChrome` (rail, hotkeys, ⌘K, launcher) around
`SplitLayout` → per-pane `SplitPanel` in `Resize.Zone` → block or registered component. Router core is plain TS except
Solid signals in 9 files; the 744-LOC `solid/` layer is bindings. Navigation is a pure table on `packages/machine`.
Hotkeys are a module-global scope tree. Features follow FE-33 layering (core/queries/primitives/components/views/context,
ast-grep enforced).

| Unit | Path | Role | LOC |
| --- | --- | --- | --- |
| Boot shell | `apps/web/index.html` | Pre-JS paint of theme + chrome silhouette | 152 |
| Entry / Root | `apps/web/src/index.tsx`, `apps/web/src/routes/Root.tsx` | Platform datasets, Tauri fetch proxy, preloadError reload; providers, theme, router, 8s cap | 121 / 281 |
| Route tree + shells | `apps/web/src/routes/app-router-view.tsx`, `routes/routes.ts`, `routes/shells.tsx` | `defineRoute` with params/state schemas, claim, search namespaces, aliases; lazy views + idle warmup | 1,403 |
| Split router core | `apps/web/src/lib/split-router` | Manifest, URL codec, panes + history, claims, guards, middleware, run + URL-gate machines, history adapters | 7,358 (+744 bindings, ~3.5k tests) |
| App pane policy + middleware | `apps/web/src/components/app/split-layout/split-router` | Reuse entity views, stack on mobile, capacity via solver, last pane → Home, legacy URL upgrade | 861 |
| Layout manager | `apps/web/src/components/app/split-layout/layoutManager.ts` | Panes ↔ mounted content; openWithSplit, spotlight, `canAppendSplit`, entry-state captors, tab title | 1,755 |
| Split layout views | `apps/web/src/components/app/split-layout` | SplitLayout/Panel/Header, componentRegistry, focus tracker, priority-collapse header | 9,800 |
| Block runtime / orchestrator (legacy, FE-34) | `apps/web/src/lib/core/block.ts`, `lib/core/orchestrator.tsx` | `defineBlock` + glob discovery; one managed instance per type:id, typed method registry | 1,478 / 675 |
| App chrome | `apps/web/src/components/app/Layout.tsx` | RootFrame, AppChrome, AppProviders | 554 |
| Rail | `apps/web/src/components/app/sidebar-next` | Rail, nav items, prefs, unread dots, update button | 1,835 |
| Hotkey engine | `apps/web/src/lib/core/hotkey` | Scope tree, override/add eclipse, priorities, conditions, tokens, enumeration | 3,299 |
| Global hotkeys + leaders | `apps/web/src/components/app/GlobalHotkeys.tsx`, `app-sidebar/sidebar.tsx` | c/⌘K/o/⌘\\/theme/undo; `g` leader (GoToHotkeys) | 1,324 |
| Palette + launcher | `apps/web/src/features/command` | CommandMenu, state, item sources, ranking, recency, Launcher, favorites commands | 7,244 |
| QuickAccess | `apps/web/src/lib/core/context/quickAccess` | Bucketed entity index over local GraphQL cache; feeds ⌘K and @mentions | 2,039 |
| View shell | `apps/web/src/components/view-shell` | Aside/main/detail slots, breakpoints, nav toggle, view hotkeys | 4,508 |
| List controller | `apps/web/src/components/list` | Keyed focus/selection/anchor/range, disclosure, bindings | 2,183 |
| Kanban + drag-drop | `apps/web/src/components/kanban`, `components/drag-drop` | solid-dnd board, collision, FLIP via WAAPI, insertion geometry | 4,110 |
| Design system | `apps/web/src/components/ui`, `apps/web/src/index.css` | Kobalte/corvu primitives, Layer/Surface/Panel, Hotkey keycaps, Tour; 1,778-line token CSS | 16,244 |
| Theme engine | `apps/web/src/features/theme` | ThemeV3 tokens → semantic vars, built-ins, migrations, preview/commit, contrast | 4,899 |
| Home | `apps/web/src/features/home` | Work feed, admission, date buckets, done map, preview routes | 10,281 |
| Settings | `apps/web/src/features/settings` | Grouped nav, search, Appearance, Shortcuts, cloud pages | 22,500 |
| Tours + tutorial | `apps/web/src/features/tours`, `features/tutorial` | Target registry, beacons; sandbox lessons | 3,686 |
| Machine | `packages/machine` | Typed transition tables, `step`/`simulate`, cycle detection | 1,031 TS (273 core) |
| Favorites backend | `crates/favorites` | Hexagonal: cap 500, idempotent add, append order, replay-safe remove | 3,865 |
| Hover cards | `apps/web/src/lib/core/component/HoverCard.tsx` | Kobalte HoverCard wrapper + choke groups | 2,120 (with previews) |
| Resize solver | `apps/web/src/lib/core/component/Resize` | Panel shares, min/max, gutters, `canFitPanel` | 1,681 |
| freshSort | `apps/web/src/lib/core/util/freshSort.ts` | uFuzzy × exponential recency decay + boosts | 397 |

**Data model**

| Entity | Storage | Key fields | Path |
| --- | --- | --- | --- |
| Split layout | URL | panes split on `~`; `s{i}.{ns}.{field}` (≤16,384 chars); `externalSearch` raw keys; legacy `type/id` upgraded | `apps/web/src/lib/split-router/routes/codec.ts` |
| Split history state | `history.state` | `{panes:[{pane, entry, state?}]}`, validated, must match pane count | `apps/web/src/lib/split-router/routes/types.ts` |
| Pane entries | memory `PaneStore` | `PaneSnapshot{entries,index}`; `Entry{id, location, state, props, meta}`; **no cap, no persistence** | `apps/web/src/lib/split-router/panes/memory-store.ts` |
| Per-entry view state | memory | captor keys (`search.text`) captured pre-navigation; persistence TODO | `apps/web/src/components/app/split-layout/entry-state.ts` |
| Hotkey registry | module memory | `Map<scopeId, ScopeNode{commands, parent, children, type dom/command}>`, activeScope, pressedKeys | `apps/web/src/lib/core/hotkey/state.ts` |
| Themes | localStorage | `html-color-theme` (boot), `macro-user-themes`, per-mode selections; `ThemeV3{id,name,version:3,mode,colorTokens}` | `apps/web/src/features/theme/signals/themeSignals.ts` |
| Shell prefs | localStorage | `macro:sidebar:prefs`, `command-recency-v1`, `executedTokens` (no reader), `macro:tour:<id>:<user>`, `macro:home:filters:v1:<user>` | `apps/web/src/components/app/sidebar-next/use-sidebar-prefs.ts` |
| favorite | Postgres | PK(user, entity_type, entity_id); `sort_order` = MAX+1 | `crates/macro_db_client/migrations/20260702014623_create_favorites_table.sql` |

**Key flows**

1. *Open entity into a split* (`layoutManager.ts`, `router/claims.ts`, `app-pane-policy.ts`, `router/run.ts`, `routes/codec.ts`)
   1. Caller → `openWithSplit(content, {preferNewSplit, referredFrom})`; touch forces same split.
   2. Router computes the route's claim (`block:md:<id>`); if held, activate owner, return `reused` (caller toasts for explicit opens).
   3. Else `PanePolicy.placeNewPane`: reuse holder, stack on mobile, fall back to source pane when the solver can't fit 400px, or insert.
   4. Run machine: leave guards → middleware (loop detection) → preload (150ms budget) → commit (PaneStore push/replace, URL via `encodePanes` + history.state).
   5. SplitLayout renders the panel; focus tracker activates it.
2. *Keystroke to command* (`lib/core/hotkey/hotkeys.ts`, `utils.ts`, `state.ts`)
   1. Capture-phase keydown on `document` (`hotkeys.ts:676-677`); untrusted events ignored outside tests (`:609`).
   2. Normalize; update pressedKeys (defensively cleared on blur/modifier release).
   3. Interceptors first (armed `g` swallows non-destination keys).
   4. Walk activeScope → parents; `getEffectiveCommands` (later `override` eclipses, `add` coexists), sort by priority.
   5. Skip if editable focused (`:694,739`) without `runWithInputFocused`, or `condition()` false.
   6. Handler true → stop + preventDefault; a leader command moves activeScope into its command scope for one key.
   7. Scope activation via focusin on nearest `[data-hotkey-scope]`; `[data-hotkey-scope-neutral]` keeps the live scope.
3. *⌘K search* (`features/command/state.ts`, `CommandMenu.tsx`, `rank-command-search-items.ts`, `freshSort.ts`)
   1. Toggle; snapshot commands from the pre-open scope chain (reparented into the tree, `CommandMenu.tsx:335-341`).
   2. Categories read QuickAccess buckets; CRM search debounced server-side.
   3. Rank: `createFreshSearch` (fuzzy 0.7, time 0.7, 30d decay on viewedAt, DM ×1.8, min fuzzy 0.1) → server matches → "Search for…" / "Ask AI".
   4. Run → handler without KeyboardEvent; `trackCommandUsage` to `command-recency-v1`. Nested scopes use onHighlight/onHighlightEnd.
4. *Cold boot*: inline script reads `html-color-theme` → paint; Root applies theme + guard; shell mounts → `dismissBootShell`; `warmRouteViews` on idle after 2.5s, skipping hidden tabs and Save-Data.

## 4. Ideas worth stealing

1. **One command registry → shortcut, palette row, tooltip keycap, debugger.** Defined once, nothing drifts.
   `apps/web/src/lib/core/hotkey/types.ts`, `getCommands.ts`, `components/ui/components/Hotkey.tsx`. (Shortcuts page is
   *not* fed by it — Cerebro does that itself.)
2. **Scope tree + capture-phase root.** DOM scopes on focusin, command scopes for leaders, neutral chrome, override vs
   add eclipse, disposal tied to owner. Capture phase defeats React `stopPropagation` (Cerebro's M29.53 trap).
   `apps/web/src/lib/core/hotkey/hotkeys.ts`, `utils.ts`, `lib/core/dom-selectors.ts`.
3. **Claims.** Route declares `claim(params)`; opening held content activates the owner. Stops duplicate editors.
   `apps/web/src/lib/split-router/router/claims.ts`, `solid/use-claim.ts`.
4. **Fuzzy × recency ranking** with stable tiebreak and fallback row. `apps/web/src/lib/core/util/freshSort.ts`,
   `features/command/rank-command-search-items.ts`.
5. **Nested palette scopes with live preview** (theme: preview on highlight, Esc restores and steps back).
   `apps/web/src/components/app/GlobalHotkeys.tsx`, `features/command/CommandMenu.tsx:583-620`.
6. **Injected pane policy** (router asks, app decides; capacity from a solver; last pane → Home).
   `apps/web/src/lib/split-router/panes/types.ts`, `components/app/split-layout/split-router/app-pane-policy.ts`.
7. **History cursor survival**: `removeEntries` keeps the cursor on the nearest survivor; `findStep` skips held entries.
   `apps/web/src/lib/split-router/panes/history.ts:61-135`.
8. **Hover-card choke groups**. `apps/web/src/lib/core/component/HoverCard.tsx:105-110`.
9. **Admission scope**: rows that become read/done stay until the filter changes. `apps/web/src/features/home/queries/home-admission.ts`.
10. **Theme as data + contrast guard + pre-paint of resolved vars.** `apps/web/src/features/theme/types/themeTypes.ts`,
    `utils/themeValidation.ts`, `apps/web/index.html`.
11. **Idle warmup with setTimeout fallback** (WKWebView lacks rIC). `apps/web/src/routes/shells.tsx:85-133`.
12. **Keyed persistent toasts with actions.** `apps/web/src/lib/core/component/Toast/useKeyedPersistentToasts.ts`.
13. **Debug toggle forcing empty states.** `apps/web/src/lib/debugSettings.ts`.
14. **Glob-discovered UI gallery** with region-extracted demos and @do/@dont. `apps/web/src/features/ui-gallery/source.ts`.

## 5. Cerebro today vs Macro

| Macro feature | Cerebro status | Value | Note |
| --- | --- | --- | --- |
| Split panes for pages | partial | high | Editor groups only on Work (`src/engine/editorGroups.ts`, MAX_GROUPS 4, memory-only); pages single-canvas via `src/stores/navStore.ts` |
| Claims | absent | high | `save_note` LWW, no base version; M17.4 reconciler covers the common case (§8) |
| Scoped keymap + leader chords | absent | high | 21 `keydown` sites / 18 files, 91 `onKeyDown`, 93 `stopPropagation`; App.tsx listener (⌘K ⌘J ⌘⇧N ⌘⇧L ⌘[ ]); ⌘S global in NoteBodyEditor |
| Command registry → palette/keycaps/reference | absent | high | M9.6 acceptance #7 never built; 5 hard-coded hints |
| Fuzzy + recency ranking, Recent list | partial | high | `src/lib/quickOpenScore.ts` tiered substring + key-shape; no recents |
| Palette categories, nested choosers | absent | medium | |
| One destination table | absent (drift) | medium | QuickOpen: Pulse vs History, no My work/Studio/Agents/Work, `agents` → Library; `placeLabel` drifts; navigate `to:'view'` → Home |
| Keyed list cursor, j/k through peek | partial | medium | `useRowKeyboard` index cursor; TableView path-keyed `checkedPaths`; only ViewCanvas publishes `detailSiblings` |
| Per-entry view state, last-place restore | absent | medium | Macro has neither on desktop — Cerebro-original |
| Hover cards | absent | medium | Tooltip only; chips have native `title` |
| Create launcher | partial | low | New menu says "New doc"; collection door still writes retired `collection.yml` |
| ViewShell layout | already-better | low | `src/app/shellLayout.ts` CSS-first bands + pageAsides |
| Icon rail + customize | different-by-design | low | M37.3/M42 retired the rail; M52 44px derived rail |
| Home notification feed, tours | different-by-design | low | M43 no feed/bell; M8 nothing speaks first |
| Themes beyond light/dark | partial | low | Dark block overrides ~90 vars; contrast only commented, not tested |
| Settings nav + search | partial | low | One page, 7 sections |
| Boot silhouette + idle warmup | partial | low | Theme pre-paint only; App renders null until vault resolves |
| Window title follows place | absent | low | Static `<title>`; Tauri capability lacks `allow-set-title` |
| Toast actions / keyed dedupe | absent | low | Bare strings (`src/stores/uiStore.ts:404-405`) |
| Pointer hygiene on rename/delete | buggy | medium | Favorites drop on rename; history keeps deleted paths |
| isPlace accepts mywork/workspace | buggy | medium | Live: threads on My work/Work lose their anchor |
| App-level ⌘Z | undecided | low | No recorded decision; diagram undo stack exists |
| Raw-palette lint, presence over counts | already-better | low | `src/styles/theme.test.ts` (class regex); quiet counts |
| macOS overlay title bar | absent | low | DOMAIN:client-desktop |

## 6. Port candidates

| id | title | mode | fidelity | effort | value | Macro guide (read first) | Cerebro target | depends |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| SHELL-0 | isPlace/placeLabel fix (live bug) | rebuild | inspire | S | medium | — (Cerebro-original) | `src/engine/place.ts`, `src/agent/conversations.ts` | — |
| SHELL-1 | One destination table (nav, palette, chords, navigate tool, window title) | rebuild | inspire | S | medium | `apps/web/src/components/app/sidebar-next/nav-items.ts` (counter-example) | `src/app/destinations.ts` (new), `Sidebar.tsx`, `QuickOpen.tsx`, `src/engine/place.ts`, `src/agent/AgentActions.tsx`, `src-tauri/src/mcp.rs` | SHELL-0 |
| SHELL-2 | Scoped keymap + command registry | rebuild | adapt | L | high | `apps/web/src/lib/core/hotkey/hotkeys.ts`, `types.ts`, `utils.ts` | `src/lib/keys/keymap.ts`, `src/app/commands/*`, `src/App.tsx`, `src/components/ui/Tooltip.tsx`, `src/pages/SettingsPage.tsx` | SHELL-1 |
| SHELL-3 | Palette ranking: uFuzzy + recency, Recent list | adopt-upstream + rebuild | adapt | M | high | `apps/web/src/lib/core/util/freshSort.ts`, `features/command/rank-command-search-items.ts` | `src/lib/paletteRank.ts`, `src/lib/quickOpenScore.ts`, `src/stores/uiStore.ts`, `src/app/QuickOpen.tsx` | SHELL-14 |
| SHELL-4 | Palette commands, categories, nested choosers | rebuild | adapt | M | medium | `apps/web/src/features/command/CommandMenu.tsx`, `state.ts` | `src/app/palette/*`, `src/hooks/useTheme.ts` | SHELL-2, SHELL-3 |
| SHELL-5 | Keyed list cursor + j/k through the peek | rebuild | adapt | M | medium | `apps/web/src/components/list/create-list-controller.ts`, `create-selection-state.ts` | `src/engine/listCursor.ts`, `src/hooks/useListCursor.ts`, `MyWorkPage.tsx`, `ConceptTable.tsx`, `TableView.tsx` | SHELL-2 |
| SHELL-6 | History entry view state + per-vault last place | rebuild | inspire | M | medium | `apps/web/src/components/app/split-layout/entry-state.ts`, `lib/core/util/scrollAnchor.ts` | `src/stores/navStore.ts`, `src/app/useEntryState.ts`, pages | SHELL-0, SHELL-14 |
| SHELL-7 | Panes for pages with claims | rebuild | adapt | XL+ | high | `apps/web/src/lib/split-router/router/claims.ts`, `panes/history.ts`, `split-router/app-pane-policy.ts` | `src/engine/panes.ts`, `src/stores/navStore.ts`, `src/app/PaneRow.tsx`, `src/app/shellLayout.ts`, `src/app/useOpenPath.ts` | SHELL-2, SHELL-6, SHELL-14, DOMAIN:editor (expected-version save), DOMAIN:agents |
| SHELL-8 | Hover preview cards for links | rebuild | adapt | M | medium | `apps/web/src/lib/core/component/HoverCard.tsx` | `src/components/ui/HoverCard.tsx`, `src/app/PagePreview.tsx`, `src/editor/chips.tsx` | DOMAIN:editor |
| SHELL-9 | Create launcher | rebuild | adapt | S first cut / M full | low | `apps/web/src/features/command/Launcher.tsx`, `core/create-menu-details.ts` | `src/app/CreateMenu.tsx`, `src/app/createCatalog.ts` | SHELL-1, SHELL-2, DOMAIN:data (collection door off `collection.yml`) |
| SHELL-10 | Themes as data + WCAG test | rebuild | adapt | M | low | `apps/web/src/features/theme/types/themeTypes.ts`, `utils/themeValidation.ts` | `src/styles/themes.ts`, `colors.css`, `index.html`, `theme.test.ts` | SHELL-4 |
| SHELL-14 | Pointer hygiene: one rename/delete hook for every pointer store; favorites reorder | rebuild | inspire | S | medium | `apps/web/src/lib/split-router/panes/history.ts` (removeEntries), `crates/favorites` | `src/stores/uiStore.ts`, `navStore.ts`, `FileTree.tsx`, `MoveDialog.tsx` | — |
| SHELL-15 | Peek back-stack | rebuild | inspire | S–M | low | `apps/web/src/components/navigation-stack` | `src/detail/DetailPanel.tsx`, `uiStore.ts` | — |
| SHELL-16 | Home task-tick admission scope | rebuild | adapt | S | low–medium | `apps/web/src/features/home/queries/home-admission.ts` | `src/pages/HomePage.tsx` | — |
| SHELL-17 | Toast actions + keyed dedupe | rebuild | adapt | S | low | `apps/web/src/lib/core/component/Toast/useKeyedPersistentToasts.ts` | `uiStore.ts`, `src/app/ToastHost.tsx` | — |
| SHELL-18 | Idle prefetch of BlockNote chunk | rebuild | inspire | S | low | `apps/web/src/routes/shells.tsx:85-133` | `src/editor/LazyMarkdownEditor.tsx` | — |
| SHELL-11 | Icon rail + customize | skip | — | — | low | — | — | — |
| SHELL-12 | Notification feed, tours, tutorial | skip | — | — | low | — | — | — |
| SHELL-13 | Run machine, URL codec, preload budget | skip | — | — | low | — | — | — |

**Top three**

- **SHELL-2 keymap + registry (L, high).** Command = `{id, label, keys, scope, when, allowInInput, desktopOnly, run}`.
  Root the listener on `document` in capture phase. Match on event key + modifiers (do not port the pressed-key set). Never
  bind Escape (`layers.ts` owns it); stand down only for **modal** layers (Dialog, Popover, DrawerScrim), never the docked
  DetailPanel. Add an `isComposing` guard; exempt jsdom user-event from any `isTrusted` check. Leaders `g` (from SHELL-1)
  and `c`, 200ms hint / 2s reset — letter chords are a product call against the M16 Notion premise. Migrate App.tsx,
  `useWorkspaceKeys`, Inbox ⌘E first; sweep the 5 hard-coded hints and 4 raw Escape listeners; pick a sidebar-toggle key
  (⌘\\ is Work's split). Shortcuts reference derived from the registry is Cerebro-original.
- **SHELL-3 palette ranking (M, high).** Adopt `@leeoniya/ufuzzy` 1.0.19 (MIT); fuse with exp decay over
  `lastOpenedAt ?? modifiedAt` (30d); keep the key-shape boost (`fld7` → FLD-7 matches in no uFuzzy config). M1's
  `'ab'` vs "A Better World" = 0 stays green; gain is multi-term (`'a world'`). Non-Latin (`日本`, `работа`) must do no
  worse: `unicode:true` + `\p{L}` or fall back to `quickOpenScore`. Recents keyed by **file path**, per vault, written
  only on user opens (not agent `open_note`/`navigate`), ordered MRU/insertion seq (frozen e2e clock).
- **SHELL-7 panes + claims (XL+, high).** `navStore` → `panes[]` + `activePaneId` (façade over active pane; pane-aware
  `useNavigate` codemod over 45 `useNavStore` / 35 `useOpenPath` files). Claims keyed by **edited file path**. No
  destination duplicable until `uiStore`/`rootsStore` singletons go per pane. ⌘/Ctrl-click opens a new pane; Shift+Enter
  only in lists/palette. Capacity needs a new N-pane band formulation (bands are literal viewport classes,
  `shellLayout.ts:216-238`); park, never unmount. Sidebar is pane-neutral chrome. Typed outcome `opened|reused|refused`.
  e2e asserts claims + `__cerebroMockFs` bytes, never the reconciler banner.

## 7. Conflicts with Cerebro conventions

| Macro pattern | Cerebro invariant | Resolution |
| --- | --- | --- |
| Layout in URL; prefs/favorites server-side | Vault is source of truth; workspace state is per-vault localStorage (M43) | Panes, recents, last place, launcher history in `uiStore` keyed by vault; prune on load; write nothing to the vault |
| Home feed, unread dots, self-opening tours | Nothing speaks first; no feed/bell (M8, M43) | Skip (SHELL-12); recency only inside the palette |
| Settled "No results found" | Unavailable is never empty; absent is never zero | Failed IPC command source → unavailable row; missing open time falls back to `modifiedAt`, never "0d ago" |
| Pane policy/block registry keyed by type names | No type special-casing | Claim key = file path; duplication by Selection class, never `type:`; routing stays in `useOpenPath` |
| "Content already open" toast | Human-UI actions toast + return null/false, never throw | Typed `opened|reused|refused`; human paths toast; agent `open_note` activates silently |
| Hotkey scopes own Escape; per-command `runWithInputFocused` | Escape belongs to `layers.ts`; editor-owned keys per `src/mermaid/keys.ts` (M29.53) | Keymap never binds Escape; letters stand down for modal layers; reuse the mermaid rule; rewrite `mermaid/keys.ts:17-19` and `App.tsx:325-327` comments |
| Navigate vocabulary twice (Rust literal + TS switch) | Policy is data, no twins | Not policy; TS parity test scrapes `mcp.rs` (pattern: `src/engine/tools.test.ts:27`); TS mapping derives from SHELL-1 |
| Shift-click opens a split | Shift-click = range check (TableView), multi-select (StructuralEditor); Shift+Enter = newline/soft break | ⌘/Ctrl-click for new pane |
| AGPL / all-rights-reserved code | Apache-2.0; guided rebuild only | No lift of `packages/machine` or `freshSort.ts`; adopt only MIT upstream (uFuzzy) |
| M16.39 "one shortcut is cheaper than a command mode" (`src/App.tsx`) | Recorded decision | SHELL-2/4 reverse it explicitly; cite in review |
| M1 pinned `quickOpenScore('ab','A Better World')===0` | Recorded test | Survives under default uFuzzy config — no reversal needed |
| M45.2/M15 transient overlays session-only | Recorded decision | SHELL-6/7 restore places only, never peek/diff/layout editor/inbox selection |

## 8. Verification notes (stage 3)

- **LWW → partial.** `save_note` takes no base (`src-tauri/src/lib.rs:98-110`, `src-tauri/src/vault/write.rs:350-357`,
  `src/lib/mockIpc.ts:211-225`), but the M17.4 reconciler reloads or banners on `modifiedAt` change
  (`src/editor/NoteBodyEditor.tsx:146-159,183-201`). Holes: seconds-granular mtime (`scan.rs:31-34`), debounce flush
  between save and rescan, "Keep mine" overwrites. Frozen e2e clock makes the reconciler inert under mock. Non-view
  writers (agent MCP, `useDocTasks.ts:78`, `LibraryPage.tsx:270`) need expected-version `save_note` (pattern:
  `viewed_body_hash`, `write.rs:337-343`).
- **uFuzzy "subsequence" → refuted.** Default config is in-order multi-term substring (`uFuzzy.mjs:57,62,120-121,153`);
  Macro admits it (`rank-command-search-items.ts:49`). Probe: `'ab'` → [Abacus notes], `'abw'` → [], `'a world'` → hit;
  `日本`/`работа` → [] without `unicode:true`.
- **Claims keyed by `selectionKey` → refuted.** `placeOf` drops library/knowledge/workspace paths (`place.ts:49-92,135-137`).
- **Destinations duplicable → refuted.** Surface state is global (`uiStore.ts:65,142,154,165-167,268`, `rootsStore.layout`).
- **Shift-click for new pane → partial.** Collides (`TableView.tsx:512`, `StructuralEditor.tsx:720`, `ChatInput.tsx:431`).
- **hasLayers stand-down + j/k in peek → refuted (contradictory).** DetailPanel is a surface layer (`DetailPanel.tsx:140`, `layers.ts:78,122-124`).
- **Persisted layout / history cap "Macro-guided" → refuted.** PaneStore is memory, history uncapped, `last_path` cookie
  written but never read (`components/app/Layout.tsx:137-151`), captors TODO (`entry-persistence.ts:19`). Fidelity → inspire.
- **Macro has one destination table → refuted.** Two drift (`nav-items.ts:50-135` vs `app-sidebar/sidebar.tsx:67-150`). SHELL-1 → inspire.
- **Registry feeds Shortcuts page → partial.** `Shortcuts.tsx:880+` is hard-coded.
- **Panel-owned list model → partial.** "Not yet fully implemented" (`components/list/README.md:3-4`); only tasks/email views adopt it.
- **navigate `view` → `{kind:'list'}` → corrected.** M47 retired lists (`ListPage.tsx:141`); map to `{kind:'type',name,view}` or narrow the schema.
- **isPlace → live bug.** `healPlace` drops anchors for My work/Work threads (`conversations.ts:132-139`) → SHELL-0.
- **⌘Z "different by design" → refuted.** Undecided; coexist with `useDiagramFile.ts:182-205` and BlockNote history.
- **Dark-mode contrast "measured" → partial.** Comment only (`colors.css:215-220`); stale comment `colors.css:98-101`.
- **Escape owned by layers → partial.** Raw listeners: `InlineDiff.tsx:51-57`, `ViewTabs.tsx:557-563`, `RecordTabs.tsx:704-710,820-826`.
- **SHELL-3 e2e by timestamp → refuted.** Frozen clock (`e2e/boot.ts:33-36`); use MRU order.
- **SHELL-9 "existing flows" → partial.** Collection door writes `collection.yml` (`listActions.ts:172-189`).
- **Palette drift wider.** `placeLabel` Pulse/Workspace (`place.ts:171-179`); kind labels Note/List/Type; placeholder pinned
  (`QuickOpen.test.tsx:12`); Inbox ungated in palette (nav gates on `inboxEnabled`, `Sidebar.tsx:633`).
- **Confirmed**: editor groups Work-only + memory-only; 45/35 file counts; 1680px for two panes + sidebar + record +
  assistant (default window 1400); capture-phase hotkey root and override eclipse; hover delays 100/150 over Kobalte;
  `components/navigation` does not exist (nearest `components/navigation-stack`).
- **Unmeasured**: whether Tauri's default macOS menu ⌘W pre-empts `useWorkspaceKeys.ts:22-29` (route to
  DOMAIN:client-desktop before adding desktopOnly keys); reconciler race windows; N-pane band rework cost.
- **Folded chores**: version string drift (`SettingsPage.tsx:17` vs `StatusBar.tsx:27`) and window title → SHELL-1.

## 9. Where to read first

1. `apps/web/src/lib/core/hotkey/types.ts`
2. `apps/web/src/lib/core/hotkey/hotkeys.ts`
3. `apps/web/src/lib/core/hotkey/utils.ts`
4. `apps/web/src/lib/constants/hotkeys.ts`
5. `apps/web/src/components/app/GlobalHotkeys.tsx`
6. `apps/web/src/lib/core/util/freshSort.ts`
7. `apps/web/src/features/command/rank-command-search-items.ts`
8. `apps/web/src/features/command/state.ts`
9. `apps/web/src/features/command/CommandMenu.tsx`
10. `apps/web/src/lib/split-router/router/claims.ts`
11. `apps/web/src/lib/split-router/panes/history.ts`
12. `apps/web/src/components/app/split-layout/split-router/app-pane-policy.ts`
13. `docs/AGENT_GUIDE/navigation.md`
14. `apps/web/src/components/list/create-list-controller.ts`
15. `apps/web/src/lib/core/component/HoverCard.tsx`
16. `apps/web/src/features/theme/types/themeTypes.ts`
