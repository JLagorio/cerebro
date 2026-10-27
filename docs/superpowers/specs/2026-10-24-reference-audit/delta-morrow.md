# Morrow: design system, UI composition and missed architecture - reference audit 2026-10-24

> **Scope:** delta over the [prior dossier](../../plans/2026-10-22-reference-review/morrow.md) (MR-01–10: save retry, search landing, outside-version recovery, backlink context and mentions, source mode, native journeys, accent folding, global capture, archive import, local graph; not repeated) and [02-visual-system](../../plans/2026-10-22-ui-refresh-review/02-visual-system.md) (VS01–13). Sibling dossiers in this folder were checked so nothing is restated as new.
> **Read:** about 42 Morrow files (all 6 stylesheets, 20 components, editor host/menus/links, preferences, Electron main, boot, CI) and about 35 Cerebro files; roadmap, implementation record, M94 spec/plan/evidence, M93 and M99 plans, M99 authority decision. Nothing was built, installed or run.
> **Paths:** `M/` = `docs/examples/Morrow-main/`. Unprefixed = Cerebro. `R/` = `~/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/` (Cerebro's resolved Rust deps, read only).
> **Licence:** Apache-2.0 (`M/LICENSE`; `M/package.json` `"license"`). Copyright appendix is unfilled; no NOTICE file. Porting is allowed with the licence text, attribution in `THIRD_PARTY_NOTICES.md` and changes marked. Only MOR-06 is **adopt**; every other verdict re-implements the idea.
> **Basis:** [read] code or tests read · [docs] README, plan, spec or sibling dossier · [names] file or dir names only.

## Top findings

1. **Do not import Morrow's design system.** Cerebro is ahead on every axis. Morrow has 22 flat colour roles, 4 half-pixel UI sizes (11.5–14.5px), 3 radii, literal spacing and z-index (39/40/50/60/70), a blanket `*` reduced-motion rule and no contrast, theme, component or e2e tests (10 test files, all core/storage). Take three small mechanisms: the native-checkbox skin (MOR-06), the two-step translucent state layer (MOR-08, supports AFN3-01) and editor suggestion menus drawn by the app menu (MOR-07). **Confirm M94.2.**
2. **The sidebar trees are keyboard-hostile.** Folders (`FileTree`) and Collections are lists of buttons, and each row adds 1–5 Tab stops; the row actions were made focusable on purpose. Cerebro's own `RootTree` already implements the ARIA tree. Morrow supplies the rest of the grammar: F2, Delete, the menu key, actions at `tabIndex=-1`, and the active page's ancestors revealed. **Amend M94.3, M94.9.**
3. **A dangling link is a dead end.** Morrow creates the target page on click. Cerebro's unresolved chip does nothing, and its preview says only `No page named "…"`. Route the click through M94.4's creation draft: show the destination, write nothing until Create. **Amend M94.4, M94.5.**
4. **Failure copy should say what is safe.** Every Morrow failure says what it did not touch: "Nothing in the folder has been changed", "left untouched on disk", "kept in memory and will be retried". Cerebro's copy says what it cannot claim (CV-05) but not what it kept ("Couldn't save"). Add a three-part failure grammar to the role sheet and to `StateMessage`. **Amend M94.2, M94.8; M93.2 copy.**
5. **Moving metadata out of git removes an implicit backup.** Morrow protects its app-private data with automatic snapshots: changed-only, every 10 minutes and on close, atomic, rotated to the newest 20. M99.8 has only a manual backup, yet the selected store lives in `<app-data>`, outside git. **Amend M99.8 (an activation gate).**
6. **Render containment must save before it hides.** Morrow's view boundary flushes every open editor in `componentDidCatch` and resets when the route changes. This refines the proposed M93.12 (TOL-01, AFN4-01, OUT3-06): call `prepareOpenPages()` and `flushOpenPages()` from the boundary, reset per pane visit, and never reload.
7. **Native shell.** Morrow's menu clicks dispatch command ids into its one action table, including Settings… ⌘, and Edit ▸ Undo routed to the app's undo. It also restores the window frame safely and sets the window background from the theme. muda 0.20 cannot show a display-only accelerator, so items for keymap-owned chords must carry none. This feeds the proposed NEW M94.10 (TOL-06). **Amend M94.5, M94.9.**

## Map

| Area | Path | What it does |
| --- | --- | --- |
| Tokens | `M/src/app/styles/tokens.css` | 22 colour roles for light and dark, 4 UI sizes, 3 radii, 2 shadows, 1 ease |
| Colour systems | `M/src/app/styles/color.css`, `features.css:1-55` | 8 accents per theme; a 9-hue tint/text/solid palette; colourful mode; cover gradients |
| Base and controls | `M/src/app/styles/app.css` | Reset, `:focus-visible`, button, icon-button, input, segmented, menu, dialog, palette, toast, checkbox skin, drag regions, ≤800px rules |
| Prose | `M/src/app/styles/editor.css:13-80` | One base size per writing font; rhythm in `em`; page-link and missing-link styles |
| Primitives | `M/src/app/components/primitives.tsx`, `Menu.tsx`, `Popover.tsx` | Dialog (trap, restore), Toasts, Kbd; floating-ui placement, roles, focus return |
| UI state | `M/src/app/ui.ts` | One typed dialog slot, toned toasts, palette, focus and source modes |
| Shell | `M/src/app/App.tsx` | Theme apply, global shortcuts, lifecycle flush and backup, per-view ErrorBoundary |
| Sidebar tree | `M/src/app/components/Sidebar.tsx:373-680` | ARIA tree, drop zones, inline rename, vault switcher |
| Top bar | `M/src/app/components/TopBar.tsx` | Breadcrumbs, global SaveIndicator, edited time, favourite, page menu |
| Page anatomy | `M/src/app/components/PageView.tsx` | State banners, cover/icon/title, tags, row properties, body, subpages, backlinks, outline |
| Containment | `M/src/app/components/ErrorBoundary.tsx`, `editor/commits.ts` | `resetKey` route; commits editors on catch |
| Collections | `M/src/app/components/Views.tsx`, `database/DatabaseView.tsx` | Tasks/Trash with cause-specific empty copy; 5 view kinds, `N of M rows` |
| Editor menus | `M/src/app/editor/SuggestionMenu.tsx`, `PageLink.ts` | Editor menus on app menu styles; unresolved vs missing links; create on follow |
| Preferences | `M/src/app/platform/preferences.ts`, `customCss.ts` | Validated per-viewer prefs; vault CSS injection |
| Native | `M/electron/main.cts` | Hidden titlebar, themed window background, frame restore, mac menu, single instance, backups, close protocol |
| Boot | `M/src/main.tsx` | Boot state machine, pre-render theme, safety copy |

## Patterns that work

| ID | Pattern | Mechanism (how it actually works) | Why it works | Evidence [basis] | Cerebro today | Verdict | Phase |
| --- | --- | --- | --- | --- | --- | --- | --- |
| MOR-01 | The page tree is one ARIA tree | `ul[role=tree]`; rows are `role=treeitem` with `aria-level`, `aria-expanded` and `aria-selected`. Roving tabindex sits on the active page, else the first root. ↑↓ move; → opens or enters; ← closes or goes to the parent; Enter opens; F2 renames; Delete trashes; the menu key or ⇧F10 opens the menu. The chevron and row actions are `tabIndex=-1`. Ancestors of the active page join the expanded set at render and are never persisted. | One Tab stop, and every row action stays reachable by key | `M/src/app/components/Sidebar.tsx:373-470` (`PageTree`, `onKeyDown`), `:380-386` (reveal), `:551-650` (`TreeRow`, `tabIndex={-1}` at 606/624/636) [read] | `src/components/FileTree.tsx:700-790` nests `<button>`s with no tree roles; row actions are kept focusable (`:622-628`). `src/app/CollectionTree.tsx:127` sets only `aria-expanded`. The pattern already lives in `src/workspace/RootTree.tsx:12-20,75-121,196-228` (arrows, Home/End; no F2, Delete or menu key) [read] | adapt (reuse RootTree + `workspace/treeRows.ts`; Apache idea) | M94.3, M94.9 |
| MOR-02 | Following a dangling link creates its page | An unresolved link keeps its `target` text. The view separates `is-unresolved` (no page yet: "click to create it") from `is-missing` (deleted or trashed). A click calls `createFromTarget` (vault top, as Obsidian does), re-points the node and opens the page. | Links written before their page (imports, agents, outside edits) become the quickest way to create it | `M/src/app/editor/PageLink.ts:120-188`; `M/src/app/editor/PageEditor.tsx:166-167` [read] | `src/editor/chips.tsx:106` `go()` returns when `dest === null`; dashed style `:138`. `src/components/PagePreview.tsx:64-69` says "No page named…" and offers no action. Create exists only while typing `[[` (`src/editor/MarkdownEditor.tsx:1141-1151` → `src/app/listActions.ts:329,340-354`: vault root, slug stem) [read] | adapt | M94.4, M94.5 |
| MOR-03 | Failure copy names what is safe | Each failure follows one grammar: what failed, then what is untouched or kept, then one next action | It reassures without hiding the failure, and says whether to act | `M/src/main.tsx:116-128,71-80`; `M/src/app/components/PageView.tsx:110-113,208-212`; `ErrorBoundary.tsx:39-46`; `TopBar.tsx:60-71` [read] | Unavailable copy is epistemic only: `src/pages/home/Lane.tsx:71-72` "Nothing here is a statement about this vault." Save failure reads "Couldn't save" (`src/components/PageToolbar.tsx:147`); `src/app/leaveGuard.ts:65` [read] | adapt | M94.2, M94.8, M93.2 |
| MOR-04 | A view boundary that saves first | `<ErrorBoundary resetKey={location.hash}>` wraps the routed view; `getDerivedStateFromProps` clears the error when the key changes. `componentDidCatch` calls `commitEditors()`, and every registered editor pushes its buffer to the save queue. | A render fault costs one view, not the typing in it | `M/src/app/components/ErrorBoundary.tsx:16-34`; `M/src/app/App.tsx:191-193`; `M/src/app/editor/commits.ts:3-14` [read] | No boundary (grep = 0; `src/main.tsx:15`); NEW M93.12 is proposed by TOL-01/AFN4-01/OUT3-06 [docs]. Owners outlive views (`src/editor/documentOwner.ts:40-42`); `prepareOpenPages` and `unresolvedOpenPages` exist (`src/editor/openPages.ts:199,205`) [read] | adapt | NEW M93.12 |
| MOR-05 | Automatic rolling snapshots of app-private data | 30s after launch, every 10 min, and on close. Skips unless content changed (`max(updatedAt) > last`). Writes JSON to `userData/Backups` via tmp then rename, prunes to the newest 20, refuses over 512MB. Restore is additive: attachments first, never an overwrite. | App-private state gets the safety net git gives files | `M/src/app/App.tsx:25,94-99,126-127`; `M/src/app/operations.ts:548-575,623-636`; `M/electron/main.cts:66-67,390-398,453-465` [read] | M99.8 is a manual `backup_workspace` with restore to a new root (`plans/2026-10-23-m99-rust-services-and-storage.md:301-323`). The store is `<app-data>/workspaces/<id>/workspace.db`, which git and cloud sync do not carry (`specs/2026-10-23-m99-workspace-authority-decision.md:131-136,167-170`) [docs] | adapt | M99.8 |
| MOR-06 | One skin for native checkboxes | Global `input[type=checkbox]{appearance:none}`: 16px, 1.5px strong border, radius 4, accent fill with a CSS check, 100ms transition. Native semantics and keyboard are untouched. | One look with no component and no call-site migration | `M/src/app/styles/app.css:1079-1113` [read] | 15 raw checkboxes, styled three ways: unstyled `src/app/CreateMenu.tsx:174`, `accent-cortex-500` `src/views/TableView.tsx:447`, `accent-[var(--cortex-500)]` `src/library/chrome.tsx:160` [read]. AFN3-12 proposes a primitive [docs] | adopt (Apache-2.0; re-implement in `src/styles/tokens/base.css` with tokens; exclude `Switch`'s input; add `:indeterminate` and `:focus-visible`) | M94.2 |
| MOR-07 | Editor suggestion menus use the app menu | A Tiptap suggestion mounts `ReactRenderer(SuggestionMenu)` with the app's `.popover` and `.menu-section` styles and floating-ui flip/shift. Roles are listbox/option; ↑↓ or Ctrl-N/P move; Enter or Tab picks. | One menu family inside and outside the editor | `M/src/app/editor/SuggestionMenu.tsx:28-104,107-168` [read] | The `@`, `[` and `/` menus use BlockNote's `SuggestionMenuController` with its default Mantine list (`src/editor/MarkdownEditor.tsx:1750-1830`). The controller accepts `suggestionMenuComponent` (`node_modules/@blocknote/react/types/src/components/SuggestionMenu/SuggestionMenuController.d.ts:12`) [read]. Drift noted in `cerebro-baseline-ui.md` §5.2 [docs] | adapt (render DS `MenuSurface`/`MenuItem` as that component) | M94.3 |
| MOR-08 | A two-step translucent state layer | `--hover` is ink at .05 and `--active` ink at .085 (dark: white at .055/.09). Both apply on every ground: sidebar, popover, page. | One token reads on any ground in both themes | `M/src/app/styles/tokens.css:30-31,59-60`; used in `app.css` `.nav-item`, `.tree-row` [read] | 276 opaque `hover:bg-n-*`; `src/app/shell.css:57-63` patches the rail because "n-100 all but vanished" [read]. Morrow paints selection with `--active`; keep `--surface-selected` distinct | adapt (supports AFN3-01) | M94.2 |
| MOR-09 | The native menu is a view of the action table | Mac menu items carry an `accelerator` with `registerAccelerator:false`, so the renderer keeps the key. A click runs `send(id)` → `onCommand` → `runAction(id)`. Edit ▸ Undo/Redo goes to `undoRedo()`: the focused editor, else the text field. | Commands are discoverable without a second key owner | `M/electron/main.cts:467-517` (479, 493-494); `M/src/app/App.tsx:94-106`; `M/src/app/editor/commits.ts:20-30` [read] | System-only menu with predefined Undo/Redo (`src-tauri/src/shell/quit.rs:240-318`) [read]. muda 0.20 `set_accelerator` always sets the NSMenuItem key equivalent (`R/muda-0.20.0/src/platform_impl/macos/mod.rs:320-343`) [read], so there is no display-only accelerator. Whether a menu Undo click reaches the batch undo (M60.7) is unverified natively | adapt (with TOL-06): items for keymap-owned chords carry no accelerator; menu-owned chords leave the capture listener | M94.5, NEW M94.10 |
| MOR-10 | The window follows the theme and keeps its frame | `backgroundColor` comes from `nativeTheme` at creation, and `setBackgroundColor` runs on every theme switch. Bounds and maximized state are saved on close, then restored only if they fall on a visible display and are at least 400×300. | No light flash in dark mode; the window comes back where it was, even after a monitor change | `M/electron/main.cts:74-77,182-201,203-221,311-316,343-348` [read] | `src-tauri/tauri.conf.json:13-23` fixes 1400×900 with no background or theme; the builder adds neither (`src-tauri/src/shell/mod.rs:80-96`); the only plugin is dialog (`src-tauri/Cargo.toml:24`) [read]. Tauri 2.12.4 has `theme` and `background_color` (`R/tauri-2.12.4/src/webview/webview_window.rs:945,1248`) [read] | adapt (background and theme now; frame via the official window-state plugin or a small `shell/` module) | M94.9, NEW M94.10 |
| MOR-11 | A trashed target explains itself | A trashed page opens with "This page is in the trash" plus Restore and Delete forever. A missing page shows "does not exist" plus Go home. | A dead end becomes a one-click recovery | `M/src/app/components/PageView.tsx:63-77,127-145` [read] | `src/pages/DocPage.tsx:344-348` says "may have been … moved to the Trash" but offers only Go home. `listTrash`/`restoreFromTrash` exist (`src/lib/ipc.ts:583,591`) and `TrashedItem` carries `path` and `title` (`src/engine/trash.ts:22-32`) [read]. AFN4-06 [docs] | adapt (supports AFN4-06): offer Restore (CV-37 refuses overwrite) and Back | M94.5 |
| MOR-12 | Error toasts are assertive | `tone: 'info' \| 'error'`. Errors get `role=alert` and 8s; info gets 5s. At most 4 are kept, each with one action. | A failure interrupts a screen reader; info stays polite | `M/src/app/ui.ts:33-38,98-117`; `M/src/app/components/primitives.tsx:113-147` [read] | One neutral tone, `role=status aria-live=polite`, 6s (`src/app/ToastHost.tsx:9,76-77`; `src/stores/uiStore.ts:592,602-606`) [read]. OUT3-07 adds keys and tones [docs] | adapt (supports OUT3-07; add the assertive error lane) | M94.8 |
| MOR-13 | One menu definition per subject | `pageMenuEntries(pageId)` feeds both the sidebar row menu and the page ⋯ menu. The palette filters `ACTIONS` by `enabled(context)`. | Labels and availability cannot diverge | `M/src/app/components/pageMenu.ts:41-90`; `CommandPalette.tsx:43-60` [read] | 9 of 10 `ContextMenu` consumers are hand-written (`cerebro-baseline-ui.md` §5.2; PJ08) [docs] | adapt (confirms M94.5) | M94.5 |
| MOR-14 | Responsive by viewport | `@media (max-width: 800px)` turns the sidebar into a drawer, keeps only the last crumb and hides hints. The outline shows only at ≥1360px. | Simple when a window holds one view | `M/src/app/styles/app.css:1635-1700`; `features.css:1245-1258` [read] | Container queries per pane (`src/styles/surface-system.css:3-13`, M94.2) [read] | already-have (Cerebro's choice is right for 4 panes; viewport rules would misfire in a narrow pane) | M94.2 (confirm) |
| MOR-15 | Focus mode | `.app.focus-mode` hides the sidebar, the outline and the end sections. The top bar fades to 0 and returns on `:hover`/`:focus-within`. Escape exits. | Writing with nothing else on screen, undone by one key | `M/src/app/styles/features.css:1293-1305`; `M/src/app/App.tsx:50-56`; `ui.ts:48-49` [read] | None (grep `focusMode\|zenMode` = 0) [read]. AGENTS: global navigation stays when the context sidebar closes [docs] | watch (owner Q1) | NEW:composition (M94.2) |
| MOR-16 | Decoration behind one switch | `data-colorful` gates heading tint, the h2 bar, list markers, kind-coloured icons and solid tags. Default is on. | "Quiet" becomes the person's choice, not a global reduction | `M/src/app/styles/color.css:315-397`; `M/src/app/platform/preferences.ts:34-35,51` [read] | Type colours and icons are always on (`typeStyle`); VS11 proposes quieter icons for everyone [docs] | watch (owner Q2) | M94.2 |
| MOR-17 | Prefs validated on read; view geometry per viewer | Every field is allow-listed or clamped: width 208–420, up to 2,000 expanded ids, up to 500 canvas sizes. Inline canvas size and the chosen view live in prefs or localStorage, never in the file. | Corrupt prefs cannot break boot, and appearance never writes content | `M/src/app/platform/preferences.ts:56-95`; `EmbeddedCanvas.tsx:19-56`; `database/DatabaseView.tsx:74-105` [read] | Same discipline (`src/stores/uiStore.ts:730-830`); UX-01: opening writes nothing [read/docs] | already-have | — |
| MOR-18 | Unknown content opens read-only | `findUnknownTypes(doc)` shows a banner plus plain text and blocks writes | An older editor cannot destroy newer or foreign content | `M/src/app/components/PageView.tsx:261-281` [read] | CV-24 carriers and the loss warning (`src/editor/NoteBodyEditor.tsx`, per prior MR-05); M93.8 source mode (`src/editor/SourceBodyEditor.tsx`) [docs/names] | already-have | M93.8 |

### MOR-01: tree flow

- **Morrow:**
  - `expandedSet = prefs.expanded ∪ ancestorsOf(activeId)`, so the open page is revealed without a write.
  - `TreeRow` is `div[role=treeitem]` with `tabIndex={active ? 0 : -1}` (the first root when nothing is active) and `data-page-id`.
  - One `onKeyDown` on the tree reads `querySelectorAll('[role=treeitem]')` in DOM order. ← collapses an open row; otherwise it focuses the parent row by its `data-page-id`.
  - Rename runs in place: Enter saves, Escape cancels, blur saves, and focus returns to the row.
- **Cerebro:**
  - Flatten `FileTree`'s `TreeNode[]` plus its expanded state into rows the way `flattenTree` does (`src/workspace/treeRows.ts`), and keep RootTree's `rowRefs` and `focusKey`.
  - Each row gets one focusable `role=treeitem`. The doc chevron and `rowActions` drop to `tabIndex=-1`; this reverses `FileTree.tsx:622-628`, because keys now reach those actions.
  - Arrows, Home/End and Enter live in the tree's own `onKeyDown`. The keydown rail lists only window and document listeners (`src/lib/keys/keydownRail.test.ts:6-15`).
  - F2 Rename, ⌫ Move to Trash and the menu key become command rows scoped to the tree (CV-47), so ⌘K and the keycaps list them. ⌫ keeps `trashPath` and its confirm (CV-37). The editor already honours the menu key (`src/editor/KeyboardBlockMenu.tsx` [names]).
- **Tests:**
  - One Tab enters the tree and the next leaves it.
  - ← goes to the parent.
  - F2 renames, then focus returns to the row.
  - A fold write happens only on an explicit toggle.
  - M94.9 adds a VoiceOver row.

### MOR-02: dangling-link flow

- **Morrow:**
  - Node attrs are `{id, target, anchor, alias, embed}`. `refresh()` sets `id ?? resolveTarget(target)` and toggles the class and `title`.
  - On click, if nothing resolves and the link has a target: `createFromTarget(target)` runs `createPage({title: last path segment, open: false})`. Then `setNodeMarkup(pos, {...attrs, id, target: null})` re-points the node, and the page opens.
- **Cerebro:**
  - When `dest === null` in `WikilinkRender.go()` or the missing face of `PagePreview`:
    1. If `listTrash` has an item whose stem or title matches, offer Restore (MOR-11).
    2. Otherwise open M94.4 page creation with `CreationDestination{kind: 'page', folder: '', recipe: {kind: 'blank'}}`, shown as "In vault root". The title is the target's page part: before `#`, alias ignored.
  - **Filename:** keep the exact target as the stem, so CV-09's stem rule resolves the existing link and the linking file needs no edit. If the text cannot be a filename, `freshStem` plus one listed link rewrite (CV-41) runs before Create (owner Q4).
  - Draft and submission identity come from `creationDraftStore`: no write before Create, and Escape keeps the draft.
- **Tests:**
  - Click, Create, then the link resolves with the linking file untouched.
  - `[[A#B]]` creates A.
  - `[[A|x]]` titles the page A.
  - A trashed target offers Restore.
  - IME Enter never creates.

### MOR-03: failure grammar

| Morrow case | What failed | What is safe | Next action |
| --- | --- | --- | --- |
| Boot (`M/src/main.tsx:116-128`) | "could not open your workspace" + message | "Nothing in the folder has been changed." | Try again · Open another folder |
| Unreadable page (`PageView.tsx:208-212`) | "could not be read" | "left untouched in storage and is protected from changes" | (Backup caveat stated) |
| Save (`TopBar.tsx:60-71`) | "Not saved, retrying" | "Your changes are kept in memory" | "Click to retry now" |
| View crash (`ErrorBoundary.tsx:39-46`) | "Something went wrong showing this view" | "Your saved pages are safe." | Reload |

- **For Cerebro:**
  - `StateMessage` gains optional `kept` and `action` slots on `unavailable` and `partial`. The role sheet fixes the order, and lab presets show it.
  - Save failure reads "Not saved — your text is kept here · Retry".
  - **Rule:** claim safety only where code guarantees it, such as a retained `DocumentOwner` draft or a refusal that wrote nothing. Otherwise drop the clause; CV-05 still governs.
  - Do not copy "Reload". A reload discards M94.4's session drafts.

### MOR-04 and MOR-05: save-first containment and snapshots

- **MOR-04:**
  - Use a `FaultBoundary` per pane and per rail card, keyed by the pane's visit id.
  - `componentDidCatch` calls `prepareOpenPages()` and then `void flushOpenPages()`. Owners hold their drafts outside React (`documentOwner.ts:40-42`).
  - The fallback is `StateMessage unavailable` with Retry (bump the key to remount) and Back.
  - **Test:** type, throw in a sibling, then assert the flush started before the fallback and the exact text was saved.
- **MOR-05:**
  - A Rust timer in the M99 workspace service fires on a metadata-revision change, at most every N minutes, and at quit.
  - It takes a SQLite online backup (`VACUUM INTO` or the backup API) of `workspace.db` plus the ledger segments into `<app-data>/workspaces/<id>/snapshots/<stamp>/`. It writes to a tmp path, renames, records a hash manifest, keeps the newest N under a byte cap, and never writes inside the vault.
  - Restore stays M99.8's `restore_workspace(archive, new_root)` and never runs in place.

## Architecture and features the prior dossier missed

- **Snapshots and containment.** These are MOR-05 and MOR-04 above. Neither appears in MR-01–10.
- **Single instance.** Morrow takes `app.requestSingleInstanceLock()` and focuses the existing window (`M/electron/main.cts:98-105`) [read]. Cerebro has no single-instance plugin (`src-tauri/Cargo.toml`) and relies on LaunchServices. Its ledger writer refuses a second process (`src-tauri/src/ledger/writer.rs:1006`) [read], but the CV-21 path locks are in-process. **Watch:** check `open -n` natively before M99.7/M99.8 activation.
- **Close protocol.** The renderer flushes and writes a backup, with a 5s main-process fallback (`M/electron/main.cts:293-307`) [read]. Cerebro's `quit.rs` plus M93.2 already go further. Confirm.
- **Portability promise.** Morrow promises that "deleting .morrow never touches a page" (`M/README.md` "Where your data lives") [docs]. M99's SQLite authority knowingly drops that promise. Keep M99's honest label for Markdown-only copies (`specs/2026-10-23-m99-workspace-authority-decision.md:107`) as visible as Morrow's promise.

## Avoid / doesn't transfer

- **Accent themes** (`M/src/app/styles/color.css:1-185`; `preferences.ts:7-18`). The 8 accents re-point focus and selection too. That collides with cortex and synapse (synapse means AI only, and a "Violet" accent would read as AI) and with UX-01.
- **Writing-font choice with an 18px serif default** (`editor.css:13-37`; `app.css` title variants, mono drops to 32px). It costs Cerebro's identity, and every font needs its own title and size compensation.
- **Custom CSS from the vault** (`M/src/app/customCss.ts:1-49`). A synced, imported or agent-written file could restyle the whole UI, including approval and permission cards (CV-28/32), and it bypasses the contrast and theme tests. Never.
- **Blanket reduced motion** (`app.css:113-120`). It kills the 20ms hover guard that Cerebro keeps on purpose (`src/styles/tokens/spacing.css:109-120`).
- **Half-pixel UI sizes and literal z-indexes** (`tokens.css:10-13`; `app.css:1117,1202,1552,1649,1666`). Cerebro's integer size/leading pairs and AFN3-05's named z roles are better.
- **Destructive confirm autofocused** (`M/src/app/components/Dialogs.tsx:84-87`). Enter deletes forever. Cerebro uses Trash plus Undo (CV-37/39).
- **Empty values shown only on hover** (`features.css:699-707`). The placeholder stays transparent until `:hover`, so keyboard and VoiceOver users never see it. VS08 keeps useful empty values.
- **Writing on open.** "A database always has at least one view" is an effect that writes (`DatabaseView.tsx:106-110`), and the welcome guide is seeded into the person's folder on first run (`M/src/main.tsx:64-68`). Both break UX-01; Cerebro's starter kit is offered, not imposed (M64.8).
- **One global save flag** (`TopBar.tsx:52-92` over one queue). It fits a single live editor. Cerebro's per-owner state and leave barrier (M93.1/.2) are stronger; do not regress.
- **Hash tabs, a pointer-only resizer** (`tabs.ts`; `Sidebar.tsx:357-358`, `role=separator` with no tabindex). Cerebro's 4 panes (CV-52) and keyboard `ResizeHandle` are better.
- **Thin UI evidence.** There are no component or e2e tests; CI runs typecheck, lint, unit and build (`M/.github/workflows/ci.yml`). The 720px measure and 30px rows are one coherent choice, not proof (VS02/VS05).

## Implications for M93-M99

- **M93:**
  - **Confirm** M93.1/M93.2: owners that outlive their views beat Morrow's single queue.
  - **Amend** the proposed NEW M93.12: the boundary flushes owners in `componentDidCatch`, resets per pane visit, remounts on Retry and never reloads (MOR-04).
  - **Amend** M93.2: save-failure copy says the draft is kept (MOR-03).
- **M94:**
  - **Confirm** M94.2's tokens and container compositions (MOR-14).
  - **Amend** M94.2: the role sheet adds the failure grammar (MOR-03), the checkbox skin (MOR-06) and the state-layer values (MOR-08).
  - **Amend** M94.3: Folders and Collections become ARIA trees (MOR-01), and `/`, `@` and `[` render on the DS Menu (MOR-07).
  - **Amend** M94.4: add an unresolved-link entry into page creation (MOR-02).
  - **Amend** M94.5: Trash-aware missing targets (MOR-11), one menu definition per subject (MOR-13), and the menu bar as a consumer of the command rows (MOR-09).
  - **Amend** M94.8: assertive error toasts (MOR-12).
  - **Amend** M94.9: native rows for VoiceOver tree navigation, dark launch without a flash, a menu Undo click and frame restore.
  - **Add** to the proposed NEW M94.10: window background and theme sync, and frame restore (MOR-10).
- **M95/M96:**
  - **Confirm**: approval and permission cards stay app-owned and cannot be restyled by vault content (see the custom-CSS avoid).
- **M97, M98:** nothing new. Backlink context and mentions are already implemented per the record (prior MR-04).
- **M99:**
  - **Amend** M99.8: automatic rolling snapshots of the selected store and ledger become an activation gate (MOR-05). Restore keeps additive ordering, attachments before records.
  - **Watch** M99.7: second-process access to one workspace.

## Owner questions

1. **Focus mode:** may it hide the 54px rail, as an exception to "global navigation stays available"? Or should it fold only the sidebar, the panel and the assistant?
2. **Decoration:** one Quiet/Colourful switch for type colours and icon tints, or one fixed look quietened for everyone (VS11)?
3. **Title bar:** keep the native bar, or overlay it with the traffic lights in the rail band, about 28px of height back and drag regions? Tauri 2.12.4 has `title_bar_style` and `traffic_light_position` (`R/tauri-2.12.4/src/webview/webview_window.rs:789,799`).
4. **Dangling-link create:** name the file exactly as the link text (Obsidian-compatible, no edit to the linking page), or use Cerebro's slug stem plus a link rewrite?
5. **Snapshots:** what cadence, retention and size cap for automatic selected-store snapshots? Morrow uses 10 min, changed-only, the newest 20, at most 512MB.
