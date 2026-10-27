# AppFlowy delta: design system, components, UI composition (reference audit 2026-10-24)

> **Scope:** AppFlowy's design system (`appflowy_ui`, the legacy `flowy_infra`, `flowy_infra_ui` and `appflowy_popover`, and icons), the shell, sidebar, command palette and settings, the document and database chrome and the AI-writer UI. Also covers architecture that the [prior dossier](../../plans/2026-10-22-ai-expansion-review/appflowy.md) did not. That dossier's AF-01…AF-10 (context, chat persistence, sources, answer→page, attachments, model choice, MCP, actions, Rust ownership, storage authority) are not repeated here.
> **Read:** about 75 AppFlowy files, plus about 40 more grepped. Counts are grep counts over `lib/` and `packages/`. About 35 Cerebro files were read to back each "Cerebro today" cell.
> **Licence:** the root `LICENSE` is AGPL-3.0. Every `packages/*/LICENSE` is the placeholder "TODO: Add your license here.", so AGPL governs everything. **Ideas only: no code, tokens or assets are copied.** The code is Flutter, so nothing ports directly anyway.
> **Basis:** [read] = code was read · [names] = inferred from names · [docs] = README or docs. Path prefixes: `AF/` = `docs/examples/AppFlowy-main/frontend/appflowy_flutter/`, `AFUI/` = `AF/packages/appflowy_ui/`, `AFR/` = `docs/examples/AppFlowy-main/frontend/rust-lib/`.

## Top findings

1. **AppFlowy's biggest design-system lesson is how it failed.** A clean new layer (Figma token JSON → generated semantic roles → `AF*` primitives) shipped *beside* the legacy layer, with no lint and no ratchet. The new layer is adopted only where a surface gets rebuilt:
   - `AFPopover` 4 uses vs legacy `AppFlowyPopover` 136;
   - `AFModal` 4 vs `showDialog` 40;
   - the database plugin has 0 new-theme reads vs 282 legacy ones;
   - 558 raw `Color(0x…)` literals [read].

   Cerebro already has rails for colours, radii, sizes, icons and selects. It shows the same drift wherever no rail exists:
   - 44 hand-rolled `section-unavailable` elements in 35 files, vs 26 files that use `StateMessage`;
   - 10 different dialog widths;
   - 3 different hover steps.

   → **M94.2/M94.9: add a counted adoption ratchet before wider adoption.**
2. **Hover and selection are role tokens drawn as translucent ink, and the primitives bind them.**
   - `fill.content` is transparent; `content-hover` is 5% ink; `content-visible-hover` is 10%.
   - `theme-select` is the brand colour at 15%; `text-select` is 20% [read].
   - This works on any surface and in both themes.

   Cerebro picks a ramp step at each call site (`hover:bg-n-50` ×206, `n-100` ×46, `n-25` ×21), and ghost Button (n-50) and IconButton (n-100) disagree. Computed contrast: `hover:bg-n-50` over `--surface-sunken` (which is n-50) is 1.00:1, and over TabBar's n-25 it is 1.04:1. → **M94.2 amend (needs the owner's colour-token decision).**
3. **AppFlowy's settings kit is a utility composition at scale.** `SettingsBody` → `SettingsHeader` → `SettingsCategory`, plus a divider spacer, row primitives, a per-setting Reset and a danger action. 14 settings pages use it [read].

   Cerebro's utility role has no consumer yet. Settings, Mail, Trash and Other apps hand-roll `<section className="… rounded-xl border … p-5">` and `<h2 className="mb-1 text-md …">`. → **M94.8: build the kit first, then adopt it.**
4. **A trashed page stays open with a Restore banner** instead of ending in a dead end [read]. Cerebro drops to "This page no longer exists… Go home", even though `listTrash` and `restoreFromTrash` exist. → **M94.5/M93.2: offer Restore in place.**
5. **AppFlowy sends per-object change notifications** shaped `(source, id, type, payload | error)` and debounces them per subject. The UI can refresh one object and show one object's failure [read]. Cerebro's `vault-changed` event carries `()`. Its `comments-changed` event already names pages, or sends `null`. → **M93.7 "narrower subscriptions" and M99.1.**
6. **Closed size scales belong in the primitive.** Example: modal S/M/L = 400/560/720 with a header/body/footer anatomy. But AppFlowy's own button sizes carry `// why?` magic numbers, and its menu (12) and popover (8) radii disagree [read]. Tokens without role binding still drift. → **M94.2: confirm VS07; amend Dialog to take a `size` enum.**
7. **Do not cite AppFlowy as accessibility evidence** [read]:
   - only 4 `Semantics(` uses;
   - no reduced-motion path;
   - text scale clamped to ≤1.0, because a larger scale "will cause ui issues";
   - the one golden test is commented out;
   - the design system's only test is Flutter's counter template.

   → **Confirm M94.9's gates: real 200% zoom, IME and VoiceOver.**

## Map

| Area | Path | What it does |
| --- | --- | --- |
| Token source | `AF/packages/appflowy_ui/script/{Primitive.Mode 1,Semantic.Light Mode,Semantic.Dark Mode}.tokens.json` | Figma variable export. Primitives, plus semantic roles that alias them (`{Neutral.1000}`) |
| Token codegen | `AF/packages/appflowy_ui/script/generate_theme.dart` | Emits `primitive.dart` and `semantic.dart`. Spacing, Radius, Shadow and Badge are skipped and hand-coded |
| Theme API | `AF/packages/appflowy_ui/lib/src/theme/{appflowy_theme.dart,definition/theme_data.dart}` | InheritedTheme plus `lerp` for an animated light/dark switch. `AppFlowyThemeBuilder.light/dark({fontFamily})` |
| Shared scales | `AF/packages/appflowy_ui/lib/src/theme/data/shared.dart` | Spacing 4/6/8/12/16/20, radius 4/6/8/12/16/20, shadow small/medium per brightness |
| Type roles | `AF/packages/appflowy_ui/lib/src/theme/definition/text_style/base/default_text_style.dart` | 8 roles × standard/enhanced/prominent/underline |
| Primitives | `AF/packages/appflowy_ui/lib/src/component/{button,menu,modal,popover,textfield}` | State builders `(ctx, isHovering, disabled[, isFocused])`. Radius and shadow are bound to the role |
| Legacy theme | `AF/packages/flowy_infra/lib/{theme.dart,colorscheme/colorscheme.dart}` | 55 colours named after components, 4 built-in themes, JSON theme plugins (`fromJsonSoft`) |
| Legacy widgets | `AF/packages/flowy_infra_ui/`, `AF/packages/appflowy_popover/` | FlowyButton, FlowyText, FlowyOverlay. Popover plus `PopoverMutex` |
| Icons | `AF/packages/flowy_svg/bin/flowy_svg.dart`, `docs/examples/AppFlowy-main/frontend/resources/flowy_icons/{16x…40x}` | One SVG set per size → typed `FlowySvgs.<name>_<s\|m\|lg\|xl>` |
| Shell | `AF/lib/workspace/presentation/home/{home_layout.dart,home_sizes.dart,desktop_home_screen.dart}` | One computed `HomeLayout`: sidebar ≥268px, a drawer below tablet width, a 400px edit panel |
| Tabs and peek | `AF/lib/workspace/application/tabs/tabs_bloc.dart` | One tab per plugin id. A secondary (side) plugin opens and expands |
| Sidebar row | `AF/lib/workspace/presentation/home/menu/view/view_item.dart` | Tree row: indent = level × padding. Hover reveals … and +. Middle-click opens |
| Title bar | `AF/lib/workspace/presentation/widgets/view_title_bar.dart` | Breadcrumb collapse and lock status |
| Command palette | `AF/lib/workspace/presentation/command_palette/widgets/{search_results_list,page_preview}.dart` | Results, a hover preview (hidden below 884px) and an Ask AI entry |
| Settings kit | `AF/lib/workspace/presentation/settings/shared/*` | Body, Header, Category, Spacer, ListTile, Reset, ActionableInput, AlertDialog, SingleSettingAction |
| Page anatomy | `AF/lib/plugins/document/{document_page.dart,presentation/banner.dart,presentation/editor_style.dart}` | Loading, error and deleted states, the Trash banner, document geometry |
| AI writer | `AF/lib/plugins/document/presentation/editor_plugins/ai/{widgets/ai_writer_suggestion_actions.dart,operations/ai_writer_cubit.dart}` | Maps each command to its follow-up actions. Streams into the document with original/replacement marks |
| Cells | `AF/lib/plugins/database/widgets/cell/{editable_cell_builder.dart,editable_cell_skeleton/,desktop_grid/,desktop_row_detail/}` | Cell logic per field kind × skin per surface |
| Row page | `AF/lib/plugins/database/widgets/row/row_property.dart` | "Show/Hide N hidden properties" |
| Page lock | `AF/lib/features/page_access_level/`, `AFR/flowy-folder/src/manager.rs` (`view_is_locked`) | Editor goes read-only. Rust refuses to trash or move a locked view |
| Notifications | `AFR/flowy-notification/src/{lib.rs,debounce.rs,entities/subject.rs}` | Subject `(source,id,ty,payload\|error)` plus per-subject debounce |
| Flags | `AF/lib/shared/feature_flags.dart` | Typed flags, plus a hard-coded "always on" list for released flags |
| Tests and lint | `AF/integration_test/shared/ime.dart`, `AF/analysis_options.yaml` | IME "simulator". Lint excludes `packages/**` |

## Patterns that work

| ID | Pattern | Mechanism (how it actually works) | Why it works | Evidence [basis] | Cerebro today | Verdict | Phase |
| --- | --- | --- | --- | --- | --- | --- | --- |
| AFY-01 | Hover and selection are role tokens drawn as translucent ink | `Fill.content` is transparent. `content-hover` is Neutral-1000 ink at 5% (`#1f23290d`); in dark it is light ink at 5% (`#f9fafd0d`). `content-visible(-hover)` is 5%/10%. `theme-select` is Blue-500 at 15%, `text-select` at 20% | The same visible change on any ground (≈1.11:1 computed over #fff, #fafafa and #f5f5f6). Hover and selection differ by hue | `AFUI/script/Semantic.Light Mode.tokens.json` and `…Dark Mode…` (Fill); `AFUI/script/Primitive.Mode 1.tokens.json` (Neutral.alpha-*) [read] | No hover role: `hover:bg-n-50` ×206, `n-100` ×46, `n-25` ×21. `--surface-sunken: var(--n-50)` (`src/styles/tokens/colors.css:163`) gives a 1.00:1 hover on that ground. Ad hoc translucent ink already in `src/editor/outline.css:180` and `src/agent/chat.css:230,233`. Composition contrast is unguarded (`cerebro-baseline-ui.md` §1, "Not guarded") | adapt | M94.2 (owner decides colour tokens), M94.3 |
| AFY-02 | The primitive owns the state→token map | `AFBaseButton` takes builder functions `(ctx,isHovering,disabled[,isFocused])`. Variants are factories: `AFGhostTextButton.primary` uses content/contentHover; `AFMenuItem` uses themeSelect when selected and contentHover on hover. The focus ring is a 2px outside stroke in themeThick at 50% | Call sites choose a variant, never a colour | `AFUI/lib/src/component/button/base_button/base_button.dart`, `AFUI/lib/src/component/button/ghost_button/ghost_text_button.dart:42-48`, `AFUI/lib/src/component/menu/menu_item.dart` [read] | Variants exist, but the primitives disagree: ghost Button hovers `--n-50` (`src/components/ui/Button.tsx:24`), IconButton hovers `--n-100` (`src/components/ui/IconButton.tsx:12`), and Menu uses n-50 for both hover and focus (`src/components/ui/Menu.tsx:151`) | adapt | M94.2 |
| AFY-03 | Design-system adoption needs a rail (a lesson from failure) | New `appflowy_ui` sits beside the legacy layer. `AF/analysis_options.yaml` excludes `packages/**`; no lint covers raw colours or legacy widgets | It did not work: adoption stalled | Grep counts [read]: `AFPopover(` 4 vs `AppFlowyPopover(` 136; `AFModal(` 4 vs `showDialog(` 40; `AppFlowyTheme.of` in `plugins/database` 0 vs legacy 282; `Color(0x…)` 558; 31 distinct `fontSize:` literals | Rails exist: `src/styles/theme.test.ts`, `src/styles/contrast.test.ts`, the "every icon name … resolves" case in `src/components/ui/Icon.test.tsx`, and CV-63. Gaps: 44 hand-rolled `section-unavailable` elements in 35 files vs 26 `StateMessage` users; 10 Dialog widths; hover steps (AFY-01) | adapt | M94.2, M94.9 |
| AFY-04 | Closed modal scale plus fixed anatomy | `AFModalDimension` S/M/L = 400/560/720. `AFModalHeader` (heading4 prominent, trailing close), `AFModalBody`, `AFModalFooter` (leading · spacer · trailing). Radius xl, shadow medium | Dialogs read as one family. A width is a decision, not a free number | `AFUI/lib/src/component/modal/{dimension.dart,modal.dart}` [read] | `Dialog` takes `width?: number`, default 560 (`src/components/ui/Dialog.tsx:50,79`). Call sites use 420/440/480/580/640/680/720/760/960 | adapt | M94.2 |
| AFY-05 | Two token layers; a theme is a semantic map | One primitive palette. Light and dark are two semantic files that alias the primitives | Theme work edits roles, not components | `AFUI/script/generate_theme.dart` `processSemanticTokenData` (alias → `AppFlowyPrimitiveTokens.x`) [read] | Same idea in CSS: semantic vars point at `var(--n-*)`, and dark re-points the ramp (`src/styles/tokens/colors.css`, dark block) | already-have | — |
| AFY-06 | Dark elevation: lighter surface step plus heavier shadow | Dark `layer-01..04` = Neutral 900/850/850/830 (lighter as the layer rises); in light every layer is white. Shadow alpha is 12% in light vs 48% in dark | A shadow is invisible on a dark ground, so the step marks the layer | `AFUI/script/Semantic.Dark Mode.tokens.json` (Surface); `AFUI/lib/src/theme/data/shared.dart` `buildShadow` [read] | Dark `--surface-raised: var(--n-100)`; dark shadows at 0.4–0.6 alpha (`src/styles/tokens/colors.css:336,373-376`) | already-have | — |
| AFY-07 | Type roles × a closed set of emphasis weights | 8 roles: H1 36/40, H2 24/32, H3 20/28, H4 16/22, headline 24/36, title 20/28, body 14/20, caption 12/18. Each comes in standard 400, enhanced 600 or prominent 700 | Weight is chosen from three options, not set freely | `AFUI/lib/src/theme/definition/text_style/base/default_text_style.dart` [read] | Roles 40/48, 24/32, 16/28, 14/20, 12/18 plus `--w-*` (`src/styles/tokens/typography.css`). Size rail in `theme.test.ts`. 12 distinct CSS px sizes vs AppFlowy's 31 | already-have (confirms UX-03) | M94.2 |
| AFY-08 | The utility composition as a settings kit | `SettingsBody`: 24px padding, title + description header, categories separated automatically. `SettingsCategory`: 16/22 title, info tooltip, trailing actions, 12px description, rows 16px apart. Between categories, `SettingsCategorySpacer` draws a divider. Rows: ListTile, Dropdown, RadioSelect, InputField, `SettingsActionableInput` (an input with inline actions) and `SingleSettingAction` (a danger row with confirm) | One anatomy across 14 pages. A new setting costs a row, not a layout | `AF/lib/workspace/presentation/settings/shared/{settings_body,settings_category,settings_category_spacer,settings_actionable_input,setting_list_tile}.dart`. Usage: SettingsBody 14, SettingsCategory 28 [read] | `SettingRow` is local to `src/pages/SettingsPage.tsx:50`. Hand-rolled section/h2 in `src/app/MailSettings.tsx:130-131`, `src/app/TrashSettings.tsx:69` and `src/app/ClientAccessSettings.tsx:124`. `PageHeader composition="utility"` has 0 consumers (`src/components/PageHeader.tsx:25`) | adapt | M94.8 |
| AFY-09 | A per-setting Reset clears the override | `SettingsResetButton` calls `syncWidth(null)`, which deletes the stored key so the default applies | Reset means "absent", never a written default, so it still holds when the default changes | `AF/lib/workspace/presentation/settings/shared/setting_list_tile.dart:65`, `…/settings/pages/settings_workspace_view.dart` (`DocumentPaddingSetting`), `AF/lib/plugins/document/application/document_appearance_cubit.dart` (`syncWidth`) [read] | No per-setting reset in Settings (grep) | adapt | M94.8 |
| AFY-10 | A trashed page stays open, with a Restore banner | `DocumentBloc.moveToTrash` sets `isDeleted`, which shows `DocumentBanner`. Restore calls `TrashService.putback`. Delete permanently asks for confirmation, then calls `deleteViews`, then `forceClose` | The person keeps their place and context; no hunting through Trash | `AF/lib/plugins/document/document_page.dart` (`buildBanner`), `AF/lib/plugins/document/presentation/banner.dart`, `AF/lib/plugins/document/application/document_bloc.dart` (`moveToTrash`, `restorePage`) [read] | `src/pages/DocPage.tsx:334-352` shows `DeletedDraftRecovery` or the EmptyState "This page no longer exists… Go home". Restore exists only in Settings (`src/app/TrashSettings.tsx`), though `listTrash` and `restoreFromTrash(vault, stamp)` exist (`src/lib/ipc.ts:576-594`) | adapt | M94.5, M93.2 |
| AFY-11 | Breadcrumb collapse | Keeps the first ancestor, then "…", then the last two. A tooltip on each crumb. Only the last crumb is editable | Deep trees fit in narrow panes | `AF/lib/workspace/presentation/widgets/view_title_bar.dart` `_buildViewTitles` [read] | Every trail step is rendered, and each crumb truncates in CSS (`src/pages/DocPage.tsx:804`, `src/components/PageToolbar.tsx` `Crumb`) | adapt (make "…" a keyboard-reachable menu) | M94.3 |
| AFY-12 | The disclosure label carries the hidden count | "Show N hidden properties" / "Hide N…" (pluralised), shown only when N>0 | It says what you'll get | `AF/lib/plugins/database/widgets/row/row_property.dart:90,275-295` [read] | "Show all properties / Hide properties" (`src/detail/RecordPageProperties.tsx:131`, `src/detail/HeadingProperties.tsx:109`) | adapt (minor) | M94.5 |
| AFY-13 | Preview pane in the command palette | The hovered result shows a 280px preview: cover, icon, title, ancestor path, created and edited. Hidden when the list is narrower than 884px (`hidePreview`). Search also has an Ask AI entry | You confirm the target before opening it | `AF/lib/workspace/presentation/command_palette/widgets/{search_results_list,page_preview}.dart` [read] | QuickOpen has excerpts and Ask, but no preview (`src/app/QuickOpen.tsx`) | watch | M94.5, M97.2 |
| AFY-14 | Cell logic per kind × skin per surface | `EditableCellBuilder.buildStyled(cellContext, EditableCellStyle.{desktopGrid,desktopRowDetail,mobile…})`. Each kind's skeleton owns state, focus and copy; the skin only draws | One writer per kind, drawn on many surfaces | `AF/lib/plugins/database/widgets/cell/editable_cell_builder.dart`, `…/editable_cell_skeleton/text.dart` [read] | One `FieldEditor` with `FieldChrome = 'cell'\|'panel'\|'strip'` (`src/detail/FieldEditor.tsx:176`) | already-have | M94.6 |
| AFY-15 | Each AI-writer command has a fixed follow-up set | `SuggestionActionBar` offers: Accept/Discard/Insert below/Rewrite for transforms; Keep/Discard/Rewrite for continue and ask; Insert below/Try again/Close for explain | An answer that doesn't replace text never offers Replace | `AF/lib/plugins/document/presentation/editor_plugins/ai/widgets/ai_writer_suggestion_actions.dart` `_getSuggestedActions` [read] | `AskAiPopover` offers Retry, Apply hunks and Keep mine; no Insert below (`src/editor/AskAiPopover.tsx:413-424`) | adapt (the actions only, not the streaming) | M95.4 |
| AFY-16 | Change notifications keyed by subject | `SubscribeObject{source, ty, id, payload?, error?}`. `DebounceNotificationSender` keys on `source-id-ty`, cancels the earlier token and sends only the latest after N ms | Fine-grained refresh, and an object's error reaches that object's listener | `AFR/flowy-notification/src/{debounce.rs,entities/subject.rs,lib.rs}` [read] | `app.emit(VAULT_CHANGED_EVENT, ())` (`src-tauri/src/vault/watcher.rs:353`); `listenVaultChanged(handler: () => void)` (`src/lib/ipc.ts:528-531`). `comments-changed` already names pages, or sends `null` (`watcher.rs:23-26,337`) | adapt | M93.7, M99.1 |
| AFY-17 | Page lock | `view.isLocked` sets `editorState.editable=false`. The title bar shows a Locked pill; a temporary unlock is counted and the page relocks. Rust refuses to trash or move a locked view (`view_is_locked`) | Protects finished pages from slips | `AF/lib/features/page_access_level/logic/page_access_level_state.dart` (`isEditable`), `AF/lib/workspace/presentation/widgets/view_title_bar.dart` (`_buildLockPageStatus`), `AFR/flowy-folder/src/manager.rs:836` [read] | None. The nearest thing is derived agent reach, `src/detail/PageAccess.tsx` (CV-46) | watch (owner decides) | NEW:page-lock |
| AFY-18 | Typed icon catalog | Per-size SVG folders (16x has 495 … 40x has 21) generate `FlowySvgs.<name>_<s\|m\|lg\|xl>` | An unknown icon fails at compile time | `AF/packages/flowy_svg/bin/flowy_svg.dart` (`sizeMap`) [read] | Lucide icons named by string, with aliases. `src/components/ui/Icon.test.tsx`: "every icon name written in src/ resolves" | already-have | — |
| AFY-19 | One tab per document; side peek | `openPlugin` → `_selectPluginIfOpen` focuses the tab that already holds the id. `openSecondaryPlugin` / `expandSecondaryPlugin` handle the side peek | No duplicate editors | `AF/lib/workspace/application/tabs/tabs_bloc.dart` [read] | CV-52 `claimOf` (`src/engine/panes.ts`); record peek | already-have | — |
| AFY-20 | Chat scroll anchored on the question | On send, the last user message scrolls to the top (`scrollBottomPadding` 440). "Jump to latest" appears 250ms after leaving the bottom. Older messages load at the top | The reader is never chased down the page | `AF/lib/plugins/ai_chat/presentation/animated_chat_list.dart` (`_scrollLastUserMessageToTop`, `_handleToggleScrollToBottom`) [read] | `src/components/ai/MessageScroller.tsx`: anchor, release on wheel or keys, jump button | already-have | M94.7 |

### AFY-01/02: how translucent-ink states flow

```
Semantic.Light Mode.tokens.json   Fill.content-hover = {Neutral.alpha-grey-1000-05}   (#1f23290d)
Semantic.Dark Mode.tokens.json    Fill.content-hover = {Neutral.alpha-grey-100-05}    (#f9fafd0d)
→ generate_theme.dart processSemanticTokenData → AppFlowyFillColorScheme.contentHover
→ AFGhostTextButton.primary: backgroundColor(ctx, isHovering, _) = isHovering ? contentHover : content
→ AFMenuItem:                 selected ? themeSelect : (isHovering && onTap != null) ? contentHover : content
```

Cerebro shape (proposal):
- **Tokens.** In `src/styles/tokens/colors.css` add:
  - `--fill-hover: color-mix(in srgb, var(--text-primary) 5%, transparent)`;
  - `--fill-hover-strong` at 10%;
  - `--fill-selected: color-mix(in srgb, var(--cortex-500) 15%, transparent)`.

  Dark mode already re-points the ramp, so `--text-primary` is the strongest ink in both themes. One definition therefore serves both.
- **Utilities.** Map the tokens in `src/styles/index.css` `@theme`.
- **Bind order.** Button (ghost/secondary), IconButton, Menu, TabBar and PropertyRow come first.
- **Tests.** Extend `contrast.test.ts` with hover-over-ground pairs that need a minimum change (e.g. ≥1.08:1) on `--surface-{app,board,sunken,raised,navigation}`. Then add a `theme.test.ts` rail so no new `hover:bg-n-*` can appear.

### AFY-03: the ratchet AppFlowy lacked

- **New test.** `scripts/ds-adoption.test.ts` holds committed counts, and each count may only fall (CV-12 spirit):
  - `hover:bg-n-*` classes;
  - `data-testid="section-unavailable"` set anywhere outside `StateMessage`;
  - `<Dialog width={n}>` where n is not on the scale;
  - `z-[…]` literals (138 uses today; bands such as 1000, 1050 and 1100 are documented only in comments, e.g. `src/components/ui/Popover.tsx:435`).
- **Lowering a count** updates the baseline in the same commit.
- **Why not rely on adoption alone:** AppFlowy's counts are what adoption-by-rebuild produces. Its largest surface, the database plugin, never moved.

### AFY-08/09: utility kit proposal

- **`src/components/settings/SettingsSection.tsx`** takes `{title, description?, info?, actions?, state?: ReadState, children}`. A failed read renders `StateMessage` inside that section, and neighbouring sections stay usable (CV-05).
- **`SettingRow`** takes `{label, hint, control, status?: ReactNode, onReset?: () => void}`. `onReset` deletes the stored key.
- **`SettingsDanger`** takes `{label, consequence, onConfirm}`. Its confirm dialog names the target.
- **Page header:** `PageHeader composition="utility"`.
- **Adoption order:** `SettingsPage.tsx` → `TrashSettings.tsx` → `MailSettings.tsx` → `ClientAccessSettings.tsx` → `ConnectorSettings.tsx`.

### AFY-10: restore in place

```
DocPage: entry === null && !recoveryHeld
→ listTrash(vault) → newest item where item.path === selection.path (kind 'file')
                     or selection.path.startsWith(item.path + '/') (kind 'folder')
→ "In Recently deleted" + Restore → restoreFromTrash(vault, stamp)   // refuses overwrite
→ rescan → the same Selection reopens
listTrash rejects → "Could not check Recently deleted" (unavailable), never "not in Trash"
```

- **No "Delete permanently".** Nothing is hard-deleted (CV-37); the launch purge owns the OS Trash.
- **`DeletedDraftRecovery` keeps precedence** when a draft exists. Its "Reload restored page" then has a one-click producer.

### AFY-16: subject-keyed vault events

```
watcher flush: emit("vault-changed", { paths: [...] } | null)   // null = OS dropped events → full rescan
listenVaultChanged((p) => p ? vaultStore.refresh(p.paths) : vaultStore.rescan())
```

- **Per-path failure:** a failed read marks only that entry unavailable (CV-05).
- **Debounce:** stays at the watcher's 350ms. The payload has the same shape as `comments-changed`.
- **Measure first** under M93.6; no rewrite without numbers.
- **Contract:** the payload DTO goes through M99.1's schema exporter.

## Avoid / doesn't transfer

- **A second design system beside the first, with no rail or codemod.** It stalled at 4 vs 136 popovers (AFY-03). Converge in place; Cerebro's own precedent is M16.1, one `Popover` plus `layers.ts`.
- **Colours named after components.** `FlowyColorScheme` has `calendarWeekendBGColor`, `gridRowCountColor`, `questionBubbleBG`, `toolbarHoverColor` (`AF/packages/flowy_infra/lib/colorscheme/colorscheme.dart`) [read]. Use role names only.
- **User JSON themes merged softly over the defaults with no contrast check.** `FlowyColorScheme.fromJsonSoft` fills missing keys from the default [read]. This would break Cerebro's AA gate and the cortex/synapse identity rule. The new layer's `CustomTheme` simply throws `UnimplementedError` (`AFUI/lib/src/theme/data/custom/custom_theme.dart`) [read].
- **Streaming AI text into the live document.** AppFlowy uses `textRobot` nodes plus original/replacement marks, and styles them with raw `Color(0xFF007296)` (`ai_writer_cubit.dart`, `editor_style.dart` `_styleSuggestion`) [read]. `src/editor/AskAiPopover.tsx` refuses this on purpose: autosave would write half-finished text, and the rewrite must land as one edit. Keep that.
- **A chat as a folder page** (`ViewLayoutPB.Chat`, `AF/lib/plugins/ai_chat/chat.dart:44`, `AFR/flowy-folder/src/entities/view.rs:194`) [read]. This conflicts with M95.3: the archive is operational data, kept outside the vault and outside knowledge.
- **Capping text scale at 1.0 because layouts break** (`AF/lib/workspace/application/settings/appearance/appearance_cubit.dart` `setTextScaleFactor` clamp 0.7–1.0) [read]. Cerebro must pass real 200% zoom (M94.9).
- **A fake IME as evidence.** `AF/integration_test/shared/ime.dart` sets editing values one character at a time, with no composing range [read]. That is not IME behaviour.
- **Feature flags with a hard-coded "always on" list that duplicates the switch** (`AF/lib/shared/feature_flags.dart` `isOn`) [read]. That is two sources of truth, and released flags are never retired. If Cerebro ever needs gates as code: one data table plus a retirement test.
- **Spinner-only loading** (64 `CircularProgressIndicator`) and **badge colours identical in light and dark** (Badge maps to the same primitives in both files) [read]. Cerebro's typed `StateMessage` and its theme-tuned `--opt-*` triples are already stronger.
- **i18n catalog** (36 locales, 2,776 strings in `en-US.json`) and **mobile skin forks.** Out of scope for a single-user desktop app in English.

## Implications for M93-M99

- **M93**
  - **Amend M93.2:** where a deleted target is in the vault Trash, offer Restore in place (AFY-10).
  - **Amend M93.7:** the first "narrower subscriptions" step is a `vault-changed` event that carries paths (AFY-16), measured by M93.6.
  - **Confirm M93.11:** AppFlowy has no transferable native, accessibility or IME evidence.
- **M94**
  - **Amend M94.2:**
    - add translucent-ink hover/selected tokens, bound in primitives (AFY-01/02); this needs the owner's colour decision, since the composition sheet currently excludes colour tokens;
    - give Dialog a `size` enum (AFY-04);
    - bind radius and shadow roles inside primitives, not at call sites (confirms VS07; AppFlowy's menu-vs-popover drift shows why).
  - **Add to M94.2 + M94.9:** the adoption ratchet (AFY-03).
  - **Amend M94.3:** add TabBar and PropertyRow hover visibility to the four-surface captures; collapse breadcrumbs in narrow panes (AFY-11).
  - **Amend M94.5:** a hidden count in the disclosure label (AFY-12); Restore in place (AFY-10); watch the palette preview (AFY-13).
  - **Amend M94.8:**
    - build the settings kit and per-setting Reset before restyling utilities (AFY-08/09);
    - make Settings the first `composition="utility"` consumer;
    - route every unavailable state through `StateMessage`.
  - **Confirm M94.6** (cell skins exist), **M94.7** (scroll anchoring exists) and **M94.9** (real zoom, IME, VoiceOver).
- **M95**
  - **Amend M95.4:** follow-up actions depend on the ask. Insert below and Copy for explain or summarize; Apply only for transforms (AFY-15).
  - **Confirm M95.3:** keep conversations out of the vault.
- **M96:** no change from this slice. Connectors were covered by the prior AF-07. The kit's ActionableInput suits connector repair through M94.8.
- **M97:** watch for a palette preview that carries M97.2's source location once it exists (AFY-13).
- **M98:** no change.
- **M99:** **Amend M99.1:** subject-keyed change events belong to the typed service boundary, with the same DTO export and drift check (AFY-16).
- **NEW:page-lock:** only if the owner wants it (AFY-17). If so: the editor is read-only until Unlock, and Rust write doors refuse agent writes, rename and trash under a policy code declared in the policy table.

## Owner questions

1. **Page lock.** Should a page be lockable? Locked means the editor is read-only until you unlock it, and agents' writes, renames and Trash moves are refused with a policy code. If yes, where is the lock stored: as `locked: true` in frontmatter (visible and portable), or in runtime.db?
2. **Hover and selection tokens.** These change colours, and every list would look different. Approve adding translucent-ink hover/selected tokens and migrating the `hover:bg-n-*` classes, inside M94 or after the four-surface comparison?
3. **Restoring a trashed page in place.** When the page was deleted as part of a folder, should Restore put back the whole folder (Trash restores per stamp), or should the page offer no in-place Restore?
