# AFFiNE: product surfaces, navigation and UX journeys - reference audit 2026-10-24

> **Scope:** The workbench (views, split, close, sidebar tabs), peek, the All docs explorer (group, sort, display, select, bulk), collections and collection-rules, tags, favorites, journals, templates, quick search/cmdk, the @-menu, import and the clipper, trash, settings IA, DnD, error/empty/onboarding states, and mobile. Judged against Cerebro's shell, Pages, Collections, Quick Open, creation, Trash, keymap and History, and against plans/specs M93–M99.
> **Files read:** about 95 AFFiNE files, about 45 Cerebro files, and 14 program documents. Nothing was run, built or installed.
> **Alias:** `AF/` = `docs/examples/AFFiNE-canary/packages/frontend/core/src/` · `BS/` = `docs/examples/AFFiNE-canary/blocksuite/`.
> **Licence:** every AFFiNE path cited here is under `packages/frontend/**` or `blocksuite/**`, which is **MIT** (`docs/examples/AFFiNE-canary/LICENSE`, `LICENSE-MIT`). None is under `packages/backend/**` or `packages/common/native/**`. Every positive verdict re-implements the idea. The small pure functions marked "portable" could be copied, with a `THIRD_PARTY_NOTICES.md` entry as M91 did.
> **Basis:** [read] = code/tests read · [names] = inferred from file names · [docs] = README/comments. Every claim that Cerebro lacks something was grepped first (the pattern is quoted). Nothing here has been checked at runtime.

## Top findings

- **Containment beats features. AFFiNE wraps every view, peek and detail page in an error boundary; Cerebro has none.** AFFiNE: `AF/modules/workbench/view/route-container.tsx:83`. Cerebro: grep for `ErrorBoundary|componentDidCatch|getDerivedStateFromError` in `src/` returns 0 hits. Under React's documented contract, an uncaught render error unmounts the whole root. That would blank all four panes and run `useQuitHost`'s cleanup (`src/app/quit.ts:248-266`), removing the ⌘Q flush that M93's retained drafts depend on. Not reproduced. The Outline slice found the same gap. → **Add M93.12, plus a consumer in M94.8.**
- **Idempotent creation after a crash is already solved, with tests.** The clipper writes an attempt-keyed `preparing` receipt *before* creating a document whose ID was allocated in advance. A per-key promise queue serializes retries. A pure five-way recovery table decides what to do. `committed` is written last. → **Amend M98.7**, whose persistence gate wants "receipt lookup by submission ID" but defines no table, and use the same table for in-session settles in **M94.4**.
- **One list engine for every doc list.** All docs, collection, tag, trash and the rules preview all render through one `DocsExplorer`. It takes a typed display preference: view, group, order, properties, quick actions. Cerebro's Pages has shelves, list/grid and two sorts. It has no grouping and no selection, and Collections and Trash each draw their own UI. → **Amend M94.3 and M94.6.**
- **Closing and returning need fixing.**
  - AFFiNE: ⌘W closes the peek, then the split view, then the tab, and only then the window. A peek offers Open, New tab, Split, Copy link and Info. A trashed doc opens read-only with Restore.
  - Cerebro: ⌘W reaches the native Close Window item (`src-tauri/src/shell/quit.rs:309`). The record peek has no Open beside. A missing page offers only "Go home" (`src/pages/DocPage.tsx:344`).
  - → **Amend M94.5**, with native proof in M94.9.
- **"Rules" in AFFiNE are read-only membership queries, not automation.** The grammar is closed and typed (`{type,key,method,value}`, providers that return ID sets). There is no automation or workflow module in the frontend (grep). In Cerebro this belongs in the existing view vocabulary as saved Pages filters. It does not belong on Collections, which by decision carry no query (M10/M47), or in M98. → **Owner question. Confirm M98.8's separation.**
- **Journals and default templates are just recipes that run at creation.** A journal is an ordinary page with a date key. It is created only on an explicit action, the redirect replaces the history entry, empty journals are hidden from lists, and the template falls back from the journal template to the page template. Cerebro has neither feature (grep `journal|daily note`). The fit is clean if each is a pinned M94.4 creation recipe. → **Owner question; NEW:journals.**
- **AFFiNE gives each piece of state a declared tier; Cerebro's 58 localStorage keys (two of them mock-only) have none.** AFFiNE separates the workspace DB, the per-user userdata DB, per-device workspace-local state and app-global state. Cerebro keeps favorites, tree order, conversation caches, review notes and approvals in `cerebro.*` localStorage. The M99 backup-category table names none of them. → **Amend M99.8.**

## Map

| Area | Path | What it does |
| --- | --- | --- |
| Workbench | `AF/modules/workbench/entities/workbench.ts` | `views$`, `open(to,{at})`, `close`, `resize`, `indexAt(active\|beside\|head\|tail\|n)` |
| View | `AF/modules/workbench/entities/view.ts`, `AF/utils/navigable-history.ts` | Each view has its own memory history (entries exposed), scroll per `Location` and its own sidebar tabs |
| Close cascade | `AF/modules/workbench/services/desktop-state-synchronizer.ts:60-80` | Peek → split view → tab → hide window |
| Open modes | `AF/utils/event.ts` (`inferOpenMode`), `AF/modules/workbench/view/workbench-link.tsx` | ⌘/middle-click opens a new tab; ⌘⌥-click opens a split; links are draggable |
| Containment | `AF/modules/workbench/view/route-container.tsx`, `AF/components/affine/affine-error-boundary/*` | A boundary per view; the fallback is chosen by error class |
| Peek | `AF/modules/peek-view/entities/peek-view.ts`, `.../view/peek-view-controls.tsx`, `BS/affine/components/src/peek/peekable.ts` | Typed peek targets, promotion controls, and the double-click / shift-click trigger |
| All docs | `AF/desktop/pages/workspace/all-page/all-page.tsx` | Pinned-collection chips, temporary filters that can be saved as a collection, display preference per mode |
| Explorer | `AF/components/explorer/{types,context}.ts`, `.../docs-view/{docs-list,doc-list-item}.tsx`, `.../display-menu/*` | Display-preference schema, virtualized list/grid, groups, range select |
| Rules engine | `AF/modules/collection-rules/{types.ts,provider/index.ts,index.ts,services/collection-rules.ts,impls/**}` | Filter, order and group providers by kind; AND of ID sets; system filters |
| Collection | `AF/modules/collection/{entities/collection.ts,stores/collection.ts}` | `{name, rules.filters, allowList}`; matches = rule matches ∪ manually added docs, minus trash and empty journals |
| Rules editor | `AF/desktop/dialogs/collection-editor/{edit-collection,rules-mode}.tsx` | Pages vs Rules mode, live preview, counts, empty-state reasons |
| Property kinds | `AF/components/workspace-property-types/index.ts`, `AF/modules/workspace-property/*`, `AF/modules/db/schema/schema.ts` | Per-kind operators, groupable/orderable flags, renderers; values live in a DB table beside the doc |
| Quick search | `AF/modules/quicksearch/{entities/quick-search.ts,services/cmdk.ts,impls/*,views/{cmdk,container}.tsx}` | Session-based picker; scored groups; Recent, Commands, Creation, Docs |
| @-menu | `AF/modules/at-menu-config/services/index.ts` | Link doc, members, journal dates, new doc / import |
| Journals | `AF/modules/journal/*`, `AF/desktop/pages/workspace/journals/index.tsx`, `AF/modules/collection-rules/impls/filters/empty-journal.ts` | Date-keyed pages, find-or-create, redirect, hiding empty journals |
| Templates | `AF/modules/template-doc/*`, `AF/modules/doc/services/docs.ts:321`, `AF/modules/app-sidebar/views/add-page-button/index.tsx`, `AF/blocksuite/block-suite-editor/starter-bar.tsx` | `isTemplate` flag, default page/journal template, New ▸ Template |
| Trash | `AF/desktop/pages/workspace/trash-page.tsx`, `AF/components/pure/trash-page-footer/index.tsx`, `.../detail-page/detail-page-wrapper.tsx` | Trash list = explorer config; a trashed doc is read-only with Restore |
| Import | `AF/desktop/dialogs/import/{index.tsx,commit-service.ts}` | Four-state dialog, progress, Cancel, per-doc warnings, landing rule |
| Clipper receipt | `AF/modules/import-clipper/services/{share-import-receipt.ts,import.ts,share-import.spec.ts}` | Attempt receipt, recovery table, per-key queue |
| DnD | `AF/types/dnd.ts`, `AF/modules/dnd/services/index.ts` | Typed `{entity, from.at}` drag contract with external resolvers |
| Sidebar | `AF/components/root-app-sidebar/index.tsx`, `AF/modules/navigation-panel/services/navigation-panel.ts`, `AF/modules/app-sidebar/entities/app-sidebar.ts` | Information architecture, fold state keyed by path, hover-floating sidebar |
| Commands | `AF/commands/registry/{command,registry}.ts` | Registry, precondition visibility, one tinykeys binding per command |
| Settings | `AF/desktop/dialogs/setting/{types.ts,navigation-constants.ts,general-setting/,workspace-setting/}` | Modal opened with `{activeTab, scrollAnchor}`; General vs Workspace sections |
| Onboarding | `AF/utils/first-app-data.ts` | Builds a showcase workspace automatically on first run |

## Patterns that work

| ID | Pattern | Mechanism | Why it works | Evidence [basis] | Cerebro today | Verdict | Phase |
| --- | --- | --- | --- | --- | --- | --- | --- |
| AFN4-01 | Render containment per view, peek and detail | `<AffineErrorBoundary><Suspense><Outlet/></Suspense></AffineErrorBoundary>` in each view. Also wraps the workspace layout, detail page, doc peek, history modal and members settings. The fallback is picked by error class (`PageNotFoundDetail`, `NoPageRootFallback`), otherwise `AnyErrorFallback` | One bad render leaves the other panes, the sidebar and the services alive | `AF/modules/workbench/view/route-container.tsx:83-87`; `AF/components/affine/affine-error-boundary/{index.tsx,affine-error-fallback.tsx}`; usage sites via grep [read] | None (grep in `src/` = 0). `src/main.tsx` calls `createRoot` with no error hooks. The quit listener is a React effect (`src/app/quit.ts:248`, mounted `src/App.tsx:153`) | adapt (own class boundary, no Sentry; Retry remounts, never reloads the document) | NEW: M93.12; M94.8 |
| AFN4-02 | Attempt-keyed creation receipt | Caller allocates `documentId` and `importAttemptId` in advance. `enqueueShareImport` serializes calls per `[flavour, ws, docId]`. `decideShareImportRecovery` picks one of 5 outcomes. The `preparing` receipt is persisted before the create. Block IDs are derived from the attempt. `committed` is written last. The result is a typed union | Retrying after a crash or lost response replays instead of duplicating; a different attempt can't overwrite the winner | `AF/modules/import-clipper/services/share-import-receipt.ts:54`; `import.ts:70,190,218,249,367`; spec tests "serializes concurrent retries…", "rejects a concurrent different attempt…", "releases the share import lock after a failed transaction" (`share-import.spec.ts:848,885,921`) [read] | M94.4's session store and submit module exist (`src/stores/creationDraftStore.ts`, `src/app/creationSubmission.ts`). M98.7 gates restart recovery on a receipt lookup it never specifies | adapt (MIT; pure table portable) | M94.4, M98.7 |
| AFN4-03 | One explorer engine, configured per surface | `createDocExplorerContext(pref)` holds `groups$`, `selectMode$`, `selectedDocIds$`, `prevCheckAnchorId$` and `displayPreference$`. `ExplorerDisplayPreference{view, groupBy, orderBy, displayProperties, show*, quick*}`. Lists render through a virtualized `Masonry` (42px list rows, ratio cards, 24px collapsible group headers). Trash is the same engine with `quickRestore`/`quickDeletePermanently` | Each new list surface is configuration rather than another UI | `AF/components/explorer/{types,context}.ts`; `docs-view/docs-list.tsx:263`; `AF/desktop/pages/workspace/trash-page.tsx` [read] | Pages: shelf all/recent/favorites, list/grid, sort modified/title (`src/pages/PagesPage.tsx:19-25`). No group, filter or select. Collections and Trash have separate UIs | adapt | M94.3, M94.6 (M93.7 before any virtualization) |
| AFN4-04 | ⌘W close cascade | `onCloseView`: if a peek is shown, close it; else if views > 1, close the active one; else if tabs > 1, close the tab; else hide the app | ⌘W always closes the foremost thing | `AF/modules/workbench/services/desktop-state-synchronizer.ts:60-80` [read] | Native predefined Close Window (`src-tauri/src/shell/quit.rs:309`). Webview `mod+w` is bound only to `work.closeTab` (`src/app/commands/work.commands.ts:39`). Panes close with ⌥⌘W (`panes.commands.ts`). No cascade in source | adapt (which of menu or webview wins ⌘W is unverified) | M94.5, M94.9 |
| AFN4-05 | Peek has the same exits as a link | Peek controls: Close · Open · New tab · Split (desktop) · Copy link (mode, blockIds, xywh) · Info. Triggers: `@Peekable` double-click/shift-click. ⌘-click opens a new tab; ⌘⌥ opens a split | Every promotion is one click and nothing is lost | `AF/modules/peek-view/view/peek-view-controls.tsx` (`DocPeekViewControls`); `BS/affine/components/src/peek/peekable.ts:36-130`; `AF/utils/event.ts` [read] | Peek header: Open in full page, width, Copy link/path, Duplicate, Customize (`src/detail/DetailHeaderActions.tsx:191`). No `openPane` or `newPane` in `src/detail` (grep). ⌘-click opens beside (`src/app/openIntent.ts`) | adapt (add Open beside) | M94.5 |
| AFN4-06 | A trashed target stays explainable | A trashed doc opens `readonly` with `TrashPageFooter` (Restore / Delete permanently + confirm). The Trash list offers select-all, restore and delete | A dead link says where the page went and offers the inverse | `AF/desktop/pages/workspace/detail-page/detail-page-wrapper.tsx:47-53`; `AF/components/pure/trash-page-footer/index.tsx` [read] | "This page no longer exists… may have been renamed or moved to the Trash" plus only Go home (`src/pages/DocPage.tsx:344`). Trash lives in Settings by D18 (`src/app/TrashSettings.tsx:41`) | adapt (look up the original path in the `.trash` manifest; offer Restore, which refuses to overwrite per CV-37, and Back; keep D18) | M94.5 |
| AFN4-07 | Closed, typed membership grammar with explained results | `watch({filters, groupBy, orderBy, extraAllowList, extraFilters})`. `FilterParams{type, key, method, value}`. Providers registered as `system:<key>` / `property:<kind>` return `Set<id>`. Filters combine with AND; manual picks are unioned in; then trash and empty-journal filters apply; grouping allows multiple memberships; zero filters match nothing; 300ms throttle; `filterErrors`. The editor previews live with "Selected N, filtered M" and separate no-rules / no-results copy | Each kind owns its operators, and the person sees why each item is listed | `AF/modules/collection-rules/services/collection-rules.ts:25-243`; `provider/index.ts`; `impls/filters/tags.ts`; `AF/modules/collection/entities/collection.ts:53-63`; `AF/desktop/dialogs/collection-editor/rules-mode.tsx:48-350` [read] | Collections deliberately carry no query (`src/engine/collections.ts`). Lists are saved views over one Type (`src/pages/ListPage.tsx`). The shared filter vocabulary and Rust twin exist (`shared/schema/views.v1.json`, `src-tauri/src/vault/query.rs`, `src-tauri/fixtures/filter-cases.json`). Untyped pages have no saved filter | adapt, only if approved (saved Pages filters in the views vocabulary; an errored filter renders as unavailable) | NEW: pages-saved-filters; M94.6 |
| AFN4-08 | Range multi-select and a floating bar | Shift-click enters select mode. Shift-click again toggles the range from `prevCheckAnchorId` over the flattened groups (`MixId` = group + doc, deduplicated). Esc clears. `ListFloatingToolbar` shows the count and Delete/Restore | Selection rules are the same in every list | `AF/components/explorer/docs-view/doc-list-item.tsx:77-148`; `docs-list.tsx:160-205` [read] | `ListSelectionBar` (count, Copy links, Esc clears) on Inbox, My work, Home and Concepts. Tables use `planBulkDelete`, which reads 8 files at a time and names failed reads (`src/app/bulkActions.ts`, `src/engine/bulkPlan.ts`). Pages has neither | adapt (Cerebro's batch planner, not `Promise.all`) | M94.6 |
| AFN4-09 | Display preference remembered per surface instance | Mode and per-mode preference are read once from WorkspaceLocalState at mount and written on change. Split views stay independent ("only read the stored state once during useState initialization") | Remembers the layout without panes fighting each other | `AF/desktop/pages/workspace/all-page/all-page.tsx:416-470` [read] | `useEntryState('pages.browser', DEFAULT_BROWSER)` lasts one visit (`src/pages/PagesPage.tsx:58`). A new visit resets to list/modified | adapt (a device-local default per vault; visit state still wins on Back) | M94.3 |
| AFN4-10 | Create from a failed search | cmdk sessions: Recent (empty query only), Collections, Commands (Fuse + context precondition), Creation ("New page '\<q>'" only when q is non-empty, group score 0), Docs, Links, Tags. Groups and items sort by score | A miss is one Enter away from a page titled with the query | `AF/modules/quicksearch/services/cmdk.ts`; `impls/creation.ts:24-50`; `views/container.tsx` [read] | Quick Open has Recent, Go to, commands, Ask, content search and choosers, but no create row (grep `creat\|startCreate` in `QuickOpen.tsx`/`palette/` = 0). The `[`/`@` menus already offer Create (`src/editor/linkMenu.ts`, `MarkdownEditor.tsx:1750-1768`) | adapt (the row seeds an M94.4 draft title and shows "In /"; Enter opens the composer) | M94.4, M94.5 |
| AFN4-11 | Journal = an ordinary page with a date key | `journal: YYYY-MM-DD`. `ensureJournalByDate` returns the first non-trashed journal for that date or creates one (title = date; journal template, else page template). `/journals?date=` redirects with `replaceHistory`, else shows a placeholder with an explicit Create (nothing is written on visit). The `empty-journal` filter hides journals never edited. Duplicates are flagged. The @-menu suggests dates | Daily notes with no clutter, and Back never lands on the redirect | `AF/modules/journal/services/journal.ts:46-90`; `suggest-journal-date.ts`; `AF/desktop/pages/workspace/journals/index.tsx:48,121`; `.../impls/filters/empty-journal.ts`; `AF/modules/at-menu-config/services/index.ts:217-300`; `AF/desktop/pages/workspace/detail-page/tabs/journal/index.tsx` (`journal-conflict-item`); `journal-store.spec.ts`, `suggest-date.spec.ts` [read] | None (grep `journal\|daily note` matches only run journals). The rule that redirect pages replace history already exists for agents (AGENTS.md) | adapt, only if approved (date words from `shared/calendar/dates.v1.json`, not AFFiNE's English-only fuzzy matcher) | NEW: journals (uses M94.4) |
| AFN4-12 | Default page/journal template | `{enablePageTemplate, pageTemplateId, journalTemplateId}` in the per-user DB. Any doc can be flagged `isTemplate`. New ▸ Page / Edgeless / Template ▸. An empty-page starter bar offers templates | Repeated structure with no automation runtime | `AF/modules/template-doc/{type.ts,store/setting.ts,store/list.ts}`; `add-page-button/index.tsx:29-57`; `AF/modules/doc/services/docs.ts:321-345` [read] | A `templates/` folder with `{{title}}`/`{{date}}`, and a blank-page bar that checks conservatively for a blank page (`src/lib/templates.ts`, `src/app/applyPageTemplate.ts`). No default template exists (grep). M94.4 requires the recipe's identity to be pinned | adapt (template bytes and hash pinned at opening; a missing template becomes a visible repair) | M94.4, NEW: default-template |
| AFN4-13 | Creation scoped to its context says where it lands | "New doc" in an empty tag view tags the new doc. New inside a rule-based collection confirms "added to include list" | Membership never surprises | `AF/components/affine/empty/docs.tsx`; `AF/desktop/pages/workspace/collection/list-header.tsx:45-66` [read] | `lands()` copy (`src/app/createCatalog.ts:30-67`); M94.4 "In …" and `createTarget` host/group | already-have | M94.4 (confirm) |
| AFN4-14 | Views keep their own history | Every view owns a `NavigableHistory`, scroll is stored per `Location` in a WeakMap, and the active view's URL is the app URL | Back stays local to the pane and restores scroll per entry | `AF/modules/workbench/entities/{workbench.ts:138-310,view.ts}` [read] | At most 4 panes, each with its own history and visit state (`src/stores/navStore.ts`, `src/app/useEntryState.ts`; CV-52/53) | already-have | M94.5 (confirm) |
| AFN4-15 | One typed drag contract for every surface | `AffineDNDData{entity:{type, id}, from:{at: 20-member union}}`. Drop targets: folder, favorites, trash, tag, tabs, split view. External `text/uri-list` / HTML drags resolve to entities | Any row drags to any target under one contract | `AF/types/dnd.ts`; `AF/modules/dnd/services/index.ts` [read] | FileTree drags a `text/plain` path. Drop targets: TabBar, EditorGroups, editor blocks, Inbox, OS drop (`src/components/FileTree.tsx:665`, `src/lib/osDrop.ts`). Pages and Collection rows don't drag | watch | NEW: dnd |
| AFN4-16 | Import state machine and landing rule | `idle → importing → success \| error`. Progress shows `{completed,total}`; Cancel uses AbortController; the dialog can't be dismissed while importing. Each skipped doc is reported as `skipped_doc` with its `sourcePath`. On close the caller opens the doc if one was imported, All docs if many, or the entry doc for a workspace import | Long imports can be cancelled, and partial success is explicit | `AF/desktop/dialogs/import/index.tsx:640-875`; `commit-service.ts:55-120`; `root-app-sidebar/index.tsx` (`handleOpenDocs`) [read] | CSV and ICS imports preview first and write one undoable batch; M69 gives every request an outcome (`src/app/CsvImportDialog.tsx`, `ImportInlet.tsx`) | already-have (copy the landing rule when multi-file import lands) | watch |
| AFN4-17 | Settings addressable by tab and anchor | `open('setting', {activeTab, scrollAnchor})` | A repair link lands on the exact control | `AF/desktop/dialogs/setting/{types.ts,navigation-constants.ts}` [read] | `setSettingsFocus(connectorFocus(name))` before navigating (`src/agent/rail/ConnectorsCard.tsx:157`) | already-have | M94.8 (confirm) |
| AFN4-18 | Command visibility vs availability | A command's precondition "only controls the visibility… shortcut keybinding still works". One tinykeys binding per command | Weak: visibility and availability diverge | `AF/commands/registry/command.ts:42`; `registry.ts` [read] | One capture listener, scopes and editor claims (CV-47, `src/lib/keys/root.ts`) | already-have (Cerebro stronger) | — |
| AFN4-19 | Every piece of state has a declared tier | Workspace DB (folders, docProperties, property catalog, pinned collections, icons). Per-user DB (favorites, template settings, integrations). WorkspaceLocalState (All docs display, recents). GlobalState/Cache (sidebar, folds, tabs) | Backup and sync behaviour follow from where a fact lives | `AF/modules/db/schema/schema.ts` (`AFFiNE_WORKSPACE_DB_SCHEMA` vs `…USERDATA_DB_SCHEMA`); `template-doc/store/setting.ts`; `quicksearch/services/recent-pages.ts`; `navigation-panel/services/navigation-panel.ts` [read] | 58 distinct `cerebro.*` localStorage keys in `src/` (2 mock-only; grep), including favorites, treeOrder, pageTreeMode, issuePrefixes, conversations, composerDrafts, reviewNotes and stdioApprovals (`src/stores/uiStore.ts:608-660`, `src/agent/conversations.ts:28`, `src/stores/reviewNotesStore.ts:12`). M99's backup table lists none (grep `localstorage` = 0) | adapt (tier each key) | M99.8; M95.2 |
| AFN4-20 | Sidebar: fixed actions, collapsible collections | Top: search, New, All docs, Journals, AI, Settings. Scrolling: Favorites, Organize, Tags, Collections, Others (Trash, Import, Templates). Folds keyed `navigation:{ws}:{path}` with defaults. A collapsed sidebar floats on hover | Navigation stays stable while sections grow | `AF/components/root-app-sidebar/index.tsx`; `navigation-panel.ts`; `app-sidebar/entities/app-sidebar.ts` [read] | Rail plus contextual sidebar with preserved folds and narrow drawers (`src/app/AppRail.tsx`, `src/app/sidebarChrome.ts`) | already-have (hover-reveal = watch) | — |
| AFN4-21 | Onboarding showcase | First run imports a bundled zip, opens "Getting Started" and creates "First Folder" | Weak: it writes without asking | `AF/utils/first-app-data.ts` [read] | The starter kit is offered explicitly and only creates files (`shared/starter/`, M64.8) | already-have (Cerebro's version is better) | — |
| AFN4-22 | Search hits grouped by doc, with the matched passage | The indexer aggregates block hits by doc (50 docs × 2 hits) and boosts title matches 1.5×. A body hit carries `blockId` and opens at that block | One row per page, with the matching passage | `AF/modules/docs-search/services/docs-search.ts:130-225` [read] | Content search shows unavailable as distinct from empty (`src/app/useContentSearch.ts`). Locators and Return to results exist (`src/app/sourceOpen.ts`, `src/editor/sourceReveal.ts`); AFFiNE has no return-to-results | already-have (Cerebro is ahead) | M97.2 (confirm) |

### AFN4-01 — containment flow (for M93.12)

- AFFiNE: each `RouteContainer` mounts `AffineErrorBoundary` → `getErrorFallbackComponent(error)` checks the registered fallbacks by `ERROR_REFLECT_KEY` and otherwise uses `AnyErrorFallback`. Its reset is `document.location.reload()` (`any-error-fallback.tsx:16`). **Do not copy the reset.** A reload discards Cerebro's in-memory save owners and M94.4's session drafts.
- Cerebro shape:
  - Boundaries around each `data-pane-index` body, the record peek, the side-panel slot, each assistant presentation body, each Home lane and each lab section, plus one at the root.
  - Fallback: the `section-unavailable` grammar (CV-05/CV-44), with **Retry** (bump the key → remount) and **Copy details**. Log through `logFrontend` (`src/lib/diagnostics.ts`).
  - Install the quit listener the same way as `installErrorReporting` (module-level, idempotent), so it survives a React unmount and the retained owners can still flush.
- Tests:
  - A throw in pane 2 leaves pane 1 editable.
  - A throw at the root still answers ⌘Q with unresolved owners.
  - Retry remounts without writing anything.
  - No document reload anywhere.

### AFN4-02 — receipt table (for M98.7, and M94.4 settles)

| Receipt state | Target exists | Decision |
| --- | --- | --- |
| none | no | write `preparing`, then create |
| none / unparseable | yes / any | conflict (keep the draft and show the existing page) |
| `preparing`, same attempt | no / yes | create from preparing / resume |
| `committed`, same attempt | yes | replay (open the existing page; never create again) |
| `committed`, same attempt | no | conflict |
| other attempt | any | conflict |

- Cerebro mapping:
  - Key = `(vaultId, submissionId)` plus the frozen path from `CreationContext`.
  - Store the receipt in runtime.db, not in frontmatter. Page bytes stay clean; CV-58 stamps are for import provenance only.
  - The human create door, already create-only and holding the path lock (CV-21), writes `preparing` → file → `committed{contentHash}`. Its `WriteReceipt<Human>` row carries the submission ID.
  - Serialize per key like `enqueueShareImport`.
  - On restart, the table alone decides between replay, conflict and resume. Elapsed time never decides.
- Tests to mirror: concurrent retries of one attempt give one create plus a replay; a different attempt never touches the winner; the lock is released after a failure.

### AFN4-03 — one explorer (for M94.3/M94.6)

- AFFiNE flow: page → `CollectionRulesService.watch(...)` → `explorerContext.groups$.next(groups)` → `DocsExplorer` maps the groups to Masonry groups (header 24px, row 42px) → `DocListItem` is a `WorkbenchLink`. Click opens; Shift selects. Trash, Collections and the rules preview pass a different `ExplorerDisplayPreference`, not different components.
- Cerebro shape: one `PageExplorer` over `isBrowserPage` entries.
  - Extend `BrowserState` to `{display, sort, group: 'edited' | 'folder' | 'type' | null}`, with edited-date bands from `src/engine/dateBuckets.ts` (already used by Home lanes).
  - Reuse it for the Collection page contents, Favorites and the Trash list in Settings (D18 stays).
  - Selection goes through `ListSelectionBar`, and actions through `bulkPlan` as one batch (CV-38/39).
  - Keep the 48 vs 56px row comparison open. Virtualize only after M93.6/M93.7 evidence; REL-08 keyboard End and find must survive. AFFiNE's fixed 42px rows are what make its virtualization cheap.

### AFN4-04 — close cascade (for M94.5)

- Order:
  1. the foremost `layers.ts` layer (already Escape's owner)
  2. the record peek
  3. the focused Work editor tab (existing `work.closeTab`)
  4. the focused pane, if it isn't the last (existing `pane.close`)
  5. the window, through the existing close guard
- Mechanism: replace the predefined Close Window accelerator with a custom menu item that asks the webview. If the webview doesn't answer, fall back to a native close after a bounded deadline, the same pattern as quit (`shell/quit.rs`).
- Packaged-only proof (M94.9). Browser e2e can't hold ⌘W (`work.commands.ts` comment).

### AFN4-07 — membership grammar (only if approved)

- Shape to borrow: kinds declare their operators (`filterMethod`), groupability, orderability and default filter (`AF/components/workspace-property-types/index.ts`). Cerebro already has the equivalent columns in `shared/schema/field-kinds.v1.json` (`groupable`, `orderable`, `filters`).
- Put the new "page" system fields (folder, edited, created, favorite, type, frontmatter tags) into `views.v1.json`. Replay them with shared `filter-cases.json` in TS and in `query.rs` (CV-04 twin).
- Fix AFFiNE's error semantics. In `collection-rules.ts:89-93`, an error in the first filter empties the result, and an error in a later filter is skipped, which silently widens the set. In Cerebro, any errored filter marks the shelf unavailable (CV-05).

## Avoid / doesn't transfer

- **Virtual "Organize" folders.** These are link nodes, a doc can sit in many folders, and the root holds only folders (`AF/modules/organize/entities/folder-node.ts`). In Cerebro, folders are on disk and Collections are folder containers. A second hierarchy would break "a container on screen is a container on disk" (`src/engine/collections.ts`) and CV-41.
- **A workspace-global property catalog with per-doc values in a DB table** (`docProperties` with `custom:{id}`, built-ins materialized on first edit, soft delete; `AF/modules/db/schema/schema.ts`, `workspace-property/stores/workspace-property.ts`). Values belong in frontmatter, and schemas belong to Type docs. It looks like M99's "metadata in SQLite", but AFFiNE has no files, so it offers no precedent for M99's external-edit and body-journal problems.
- **Tags as entities referenced by ID** (`AF/modules/tag/entities/tag.ts`). In a files-first vault a tag is a frontmatter string, and renaming one is a CV-38/CV-40 batch, not a one-row update.
- **Implicit navigation when peeking again.** If a doc peek is open when another peek opens, `PeekViewEntity.open` first navigates the active view to the peeked doc (`peek-view.ts:272`). That moves the person's main view without asking.
- **Template application that clears the target and skips silently.** `duplicateFromTemplate` deletes the target's blocks before copying, and a trashed template only `console.warn`s, leaving a blank page (`docs.ts:327,345`). Cerebro's conservative blank-page check (`applyPageTemplate.ts`) and M94.4's pinned recipe are better.
- **Error fallback by `location.reload()`** (AFN4-01).
- **Bulk delete/restore by `Promise.all` and one toast**, with no per-item failure (`docs-list.tsx:197`, `trash-page.tsx`). Cerebro's `bulkPlan` names each failed read, and the writes go out as one batch.
- **Precondition hides a command but its shortcut still fires** (`command.ts:42`). CV-47 already scopes both.
- **cmdk selection reducer bug** (`selectedExists: newFirstItem`, `cmdk.tsx:109`). Copy the behaviour (keep the selection, or follow the first item), not the code. Also weak: only 3 recent docs (`recent-pages.ts:6`).
- **Auto-seeded showcase workspace** (`first-app-data.ts`). It conflicts with M64.8's explicit offer.
- **Server-dependent features:** sharing and publishing, members, notifications, cloud comments, server indexer and "search locally" fallbacks, cloud backlink revalidation. They need multi-tenant auth and a server. Cerebro is single-user and drafts-only (D15).
- **Electron tabs holding split views** (`AF/modules/workbench/services/desktop-state-synchronizer.ts`, `docs/examples/AFFiNE-canary/packages/frontend/apps/electron/src/main/shared-state-schema.ts:39`). Cerebro chose up to 4 panes. Tabs would add a third navigation layer to CV-52's one-editor-per-file rule.
- **Persistent full-text indexer** (`AF/modules/docs-search/README.md`, [docs]). Cerebro decided against a persistent index (`corpus.rs`, M17.19; M93 spec scope).
- **Mobile shell.** It reuses the same services with different views. Cerebro is desktop-only at 900×600; its narrow panes keep the same components.

## Implications for M93–M99

- **M93**
  - **Add M93.12, render containment (AFN4-01).** Boundaries per pane, peek, side panel, assistant body and Home lane, plus the root. The fallback is unavailable + Retry (remount). Move the quit listener to module level. Depends on M93.1/M93.2's participant inventory, because a crashed participant must still report as unresolved.
  - **Confirm M93.7's measure-first order.** AFFiNE's virtualized lists rely on fixed row heights (`docs-list.tsx`), and AFFiNE shows no find or offscreen-a11y handling, so it gives no evidence against REL-08.
- **M94**
  - **Amend M94.3:** Pages gets edited-date grouping and a remembered device-local display default (AFN4-03/09).
  - **Amend M94.4:**
    - Add a Quick Open "New page '\<query>'" row that seeds a `CreationDraft` (AFN4-10).
    - The template recipe pins path, hash and bytes; a missing template is a repair (AFN4-12).
    - Submission settles use the AFN4-02 decision table.
  - **Amend M94.5:**
    - ⌘W close cascade (AFN4-04).
    - Peek "Open beside" via `openPane` (AFN4-05).
    - A missing target resolves against Trash and offers Restore + Back instead of Go home (AFN4-06), with tests for deleted, trashed and moved targets.
  - **Amend M94.6:** Pages, Collection and Trash lists share one explorer with range select and `bulkPlan` actions (AFN4-03/08).
  - **Amend M94.8:** a render-failed section uses the unavailable grammar (AFN4-01).
  - **Confirm** M94.4's "In …" (AFN4-13), M94.5's navigation API (AFN4-14) and M94.8's repair deep link (AFN4-17).
- **M95**
  - **Amend M95.2:** the retention decision must also classify `cerebro.conversations` and `cerebro.composerDrafts`, which already persist in localStorage (AFN4-19).
- **M97**
  - **Confirm M97.2.** AFFiNE opens a hit at its `blockId` but has no Return to results; Cerebro's snapshot design is ahead.
  - **Confirm M97.5's bounded backlinks.** AFFiNE caps backlink hits at 100 on desktop and 5 on web (`doc-backlinks.ts`).
- **M98**
  - **Confirm M98.8's scoping.** AFFiNE's "rules" are membership queries, and its frontend has no automation or workflow module (grep), so membership filters stay out of FLOW.
  - **Amend M98.7:** the persistence adapter uses the AFN4-02 receipt table and per-key queue, and its tests mirror the three clipper specs.
  - Journals and default templates are creation recipes (M94.4), not triggers.
- **M99**
  - **Amend M99.8:** add a backup-category row for webview-local state. Tier each `cerebro.*` key as portable, device-local or disposable (AFN4-19). Favorites, `treeOrder`, `pageTreeMode` and `issuePrefixes` are user-authored today and missing from the table.

## Owner questions

1. **Daily journals (AFN4-11):** add date-keyed daily pages? If yes, which folder and filename pattern, and should a journal be created only on an explicit Create (AFFiNE) or on open?
2. **Saved Pages filters (AFN4-07):** allow query-backed shelves on Pages next to All / Recent / Favorites, keeping Collections query-free? If yes, should they be stored in the vault (portable) or per device?
3. **Default new-page template (AFN4-12):** none (today), one global default, or one per folder?
4. **⌘W (AFN4-04):** adopt the cascade (layer → peek → tab → pane → window), or keep native Close Window?
5. **Webview-local state (AFN4-19):** which of favorites, tree order, page-tree mode, issue prefixes and review notes must travel with a workspace backup?
