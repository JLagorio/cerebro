# Outline: product surfaces and UX journeys - reference audit 2026-10-24

> **Scope:** document page anatomy (header, meta line, TOC, insights, references, notices), drafts→publish, templates, collections, archive/trash/restore, revisions/history, search, notifications, comments, sharing, import/export (FileOperations, OKF), task progress, states, shortcut help, onboarding, mobile. Judged against DocPage + side panel, Pages, Collections, Home lanes, Quick Open, Trash (CV-37), History (M64.2), comments (CV-31), starter kit (M64.8), imports (M69); M93, M94, M97 (M99 consumer note).
> **Files read:** ~95 Outline (`app/scenes/{Document/**,Search/**,Collection/**,Trash,Home,Drafts,Archive,DocumentNew,DocumentPublish,DocumentDelete,Errors,Settings/Import}`, `app/components/{DocumentMeta,DocumentListItem,DocumentTasks,DocumentExplorer,ConfirmMoveDialog,DocumentArchiveDialog,DeprecatedReason,TemplatizeDialog,KeyboardShortcuts,Export,ScrollToTop}`, `app/stores/{UiStore,SearchesStore,NotificationsStore}`, `app/models/{Document,Revision}`, `app/actions/definitions/{documents,revisions}`, `server/models/helpers/OKFHelper.ts`, `server/onboarding/*`) and ~50 Cerebro files.
> **Licence:** Outline is BSL 1.1 (`O/LICENSE`, changes to Apache 2.0 on 2030-10-23). Ideas only, no code copied. **No verdict here is adopt**: every positive verdict is **adapt**, meaning re-implement the idea in Cerebro's model. OKF is an open spec (Google knowledge-catalog), not Outline's code.
> **Alias:** `O/` = `docs/examples/outline-main/`. **Basis:** [read] code read · [names] file or dir names only · [docs] markdown content. Cerebro claims are [read] or grep-checked. Nothing was run. The companion dossier `outline-3-design-system.md` covers actions, menus, toasts, error boundaries and loading, which are not repeated here.

## Top findings

- **Outline puts a document's lifecycle in one sentence where you read it.** It builds one meta sentence per doc by precedence: revision > deleted > archived > imported-unchanged > created > published > updated. "Updated" is highlighted when the doc changed since *your* last view, and a view only counts after 3 s. The sentence sits under the title *and* on every list row, and clicking it opens History (`O/app/components/DocumentMeta.tsx:93-201`, `O/app/scenes/Document/components/DocumentMeta.tsx:71-90`, `O/app/scenes/Document/components/MarkAsViewed.ts:4`) [read].
  - Cerebro already produces every input: attribution sentences (`src/engine/attribution.ts:72`), a timed open log (`src/engine/openLog.ts:15-27`), import provenance and the trash manifest.
  - It shows them only in Details (`src/detail/LastChange.tsx`, mounted at `src/detail/DocSidePanel.tsx:206`). Pages rows show only an mtime date (`src/pages/PagesPage.tsx:32`).
  - Agents edit in the background and nothing tells you, so this is the largest legibility gap. → **M94.3, M94.6** (+ a batch last-writer read for M99.6).
- **A deleted page is a dead end in Cerebro.**
  - Outline: a trashed doc still opens read-only, with "Deleted by X · permanently deleted in N days unless restored" and a Restore action. If the original location is gone, Restore offers another location. A 404 offers Home and Search, and after a delete Outline lands on the parent doc (`O/app/scenes/Document/components/Notices.tsx:35-92`, `O/app/actions/definitions/documents.tsx:1490-1560`, `O/app/scenes/Errors/Error404.tsx`, `O/app/scenes/DocumentDelete.tsx:31-55`) [read].
  - Cerebro: the missing-page state offers only "Go home" (`src/pages/DocPage.tsx:334-352`). Every delete navigates Home (`:480`). Restore refuses an occupied path and offers nothing else (`src/engine/trash.ts:48`, `src-tauri/src/vault/trash.rs:572`).
  - That contradicts UX-06: "Missing targets explain availability and allow return; they do not reset the origin." → **M94.5, M94.8**.
- **Cerebro moves pages without saying who gains or loses access.** Outline's move confirmation names the permission change, "from X to Y" (`O/app/components/ConfirmMoveDialog.tsx:27-80`) [read]. In Cerebro a folder move silently changes which agents can read, write or wake on a page, because grants are folder-scoped (`src/engine/agentAccess.ts:506`). The move prompt lists link changes only (`src/stores/renamePromptStore.ts:3-13`). → **M94.5**.
- **Cerebro has two flat destination pickers where Outline has one tree.** Outline uses one searchable keyboard tree (`DocumentExplorer`) for publish, move, copy and template move, with a "Publish in <location>" footer (`O/app/components/DocumentExplorer/DocumentExplorer.tsx:71-146`, `O/app/scenes/DocumentPublish.tsx:63-90`) [read]. Cerebro's two pickers are a button list for Move (`src/components/MoveDialog.tsx`) and a `Select` for the "In …" create field (`src/app/CreationDestinationField.tsx:50-70`). → **M94.4/M94.5**.
- **Cerebro's History can only diff against the previous version.**
  - Outline: History merges revisions and lifecycle events using an offset per stream, and adds a synthetic "Current version". Its "Highlight changes" toggle is persisted, "Compare to" accepts any revision, and you can step through "n of m changes" (`O/app/scenes/Document/components/History/History.tsx:133-238`, `HighlightChangesControl.tsx:43-99`, `ChangesNavigation.tsx`) [read].
  - Cerebro: its timeline is richer, folding in runs, sessions and the ledger, with CV-05 per lane (`src/history/PageHistory.tsx`). Its diff is only against the previous version (`src/git/ProseDiffView.tsx:116`).
  - The need agents create is "what changed since I last opened this". → **NEW:history** (consumer in M94.8).
- **Outline's side panels keep their state; Cerebro's don't.** Outline keeps Comments and History mounted under `React.Activity` while they are hidden (`O/app/scenes/Document/hooks/useDocumentSidebar.tsx:68-77`) [read]. Cerebro unmounts the panel on every switch between Details, Comments and History (`src/detail/DocSidePanel.tsx:416-434`), so scroll and folds are lost and the reads run again. React 19.2.8 is installed. → **M94.3**.
- **Where Cerebro is already ahead, don't port Outline's version:**
  - Search→source→Back: Cerebro has an exact locator plus Return to results with scroll. Outline re-runs the URL query and scrolls to the top (`O/app/components/ScrollToTop.ts:21-36`).
  - Comment anchors: Cerebro keeps them outside the file (CV-31). Outline uses marks inside the document.
  - Onboarding: Cerebro offers the starter kit. Outline seeds a Welcome collection silently.
  - Shortcut help: Cerebro renders it from the keymap catalog. Outline's list is hand-typed.
  - Home: Cerebro's is pull-only. Outline has unread-count notifications.
  - Page creation: Cerebro asks for a title first. Outline creates a doc and auto-deletes it if it is left empty.

## Map

| Area | Path | What it does |
| --- | --- | --- |
| Doc scene | `O/app/scenes/Document/components/Document.tsx` | Header, notices, TOC column, editor, References footer. On sync, a `?q=` param runs editor find. Restore-from-revision is driven by location state |
| Doc header | `.../Header.tsx` | Left: breadcrumb, TOC toggle, star. Title: icon and Draft/Archived badges. Actions: templates (only while new), share, Done/Save draft, Restore, Publish, menu. Compacts below a measured 700px |
| Meta sentence | `O/app/components/DocumentMeta.tsx`; `.../components/DocumentMeta.tsx` | Lifecycle sentence by precedence plus collection, nested count, Viewed/Never viewed and task progress. On the page it links to History |
| Personal read state | `O/app/models/Document.ts:324-334`; `.../MarkAsViewed.ts` | `modifiedSinceViewed`, `isBadgedNew` (never viewed and under 14 days old); a view counts after 3 s dwell |
| Notices | `.../Notices.tsx`; `O/app/components/DeprecatedReason.tsx` | Archived/deleted banner, permanent-delete countdown, editable reason |
| TOC | `.../Contents.tsx` | Active heading tracked by scroll; a clicked heading stays active until the reader scrolls; left or right; H1–H4 |
| References | `.../References.tsx`, `ReferenceListItem.tsx` | Page-foot tabs for child docs and backlinks, a "New doc" row, `#d-<id>` hash on backlinks |
| Insights / stats | `.../Insights.tsx`, `DocumentStats.tsx` | Created, updated, imported-from, contributors; word, character and reading-time counts that switch to the selection when there is one |
| History | `.../History/{History,HighlightChangesControl,RevisionListItem,utils}.tsx`, `ChangesNavigation.tsx` | Merged paging, synthetic current version, compare-to, change stepping, "via MCP/API" suffix |
| Revision actions | `O/app/actions/definitions/revisions.tsx:63-146` | Restore navigates with `{restore,revisionId}`; Copy link; Export |
| Comments | `.../Comments/{Comments,CommentThread,CommentSortMenu}.tsx` | Most recent, Order in doc or Resolved; long threads collapse; "New comments" jump; per-thread drafts |
| Side panel | `.../hooks/useDocumentSidebar.tsx`; `O/app/stores/UiStore.ts:35,378-399` | One right slot per split pane; panels stay mounted under Activity |
| Search | `O/app/scenes/Search/Search.tsx`; `O/app/stores/SearchesStore.ts`; `O/app/components/DocumentListItem.tsx:47-245`; `.../SearchHighlightChip.tsx`; `O/app/hooks/useClearSearchHighlight.ts` | Filters held in the URL, error separate from empty, recent queries, snippet marks, find-on-landing |
| Create / publish | `O/app/scenes/{DocumentNew,DocumentPublish}.tsx`; `.../hooks/useDocumentSave.ts:54-82,337-379` | Create immediately and `replace` into the doc; empty drafts auto-delete on unmount; publish asks for a location |
| Move / destination | `O/app/components/DocumentExplorer/*`; `ConfirmMoveDialog.tsx` | Shared searchable tree; access-change confirmation |
| Delete / archive / trash | `O/app/scenes/{DocumentDelete,Archive}.tsx`, `Trash/index.tsx`; `O/app/components/DocumentArchiveDialog.tsx` | Delete dialog offers Archive; deleted-by and date filters; restore in place or elsewhere |
| Templates | `O/app/components/TemplatizeDialog/*`; `Header.tsx:94-97,206-214`; `O/shared/utils/TextHelper.ts:21-31` | Template menu while the doc is new; non-destructive templatize; `{date}`, `{time}`, `{datetime}`, `{author}` |
| Collection | `O/app/scenes/Collection/index.tsx`; `components/{MembershipPreview,DropToImport,Empty}.tsx` | Overview description, pins, tabs (Recent/Updated/Published/Old/A–Z), access preview, drop-to-import |
| Import / export | `O/app/scenes/Settings/Import.tsx`; `components/{FileOperationListItem,ImportOKFDialog}.tsx`; `O/app/components/Export/ExportDialog.tsx`; `O/server/models/helpers/OKFHelper.ts` | Durable job list with states; deleting an import removes what it created; OKF zip round-trip |
| Onboarding | `O/server/onboarding/*.md`; `O/server/commands/accountProvisioner.ts:254-300` | "Welcome" collection of 4 ordinary docs, one a Getting Started checklist |
| Shortcut help | `O/app/components/KeyboardShortcuts.tsx:28-455` | Hand-typed categories including Markdown and Triggers, with a search filter |
| Notifications | `O/app/stores/NotificationsStore.ts` | Viewed and archived states, mark-all, unread count |
| Task progress | `O/app/components/DocumentTasks.tsx`; `O/shared/utils/ProsemirrorHelper.ts:434` | `{completed,total}` derived from checkboxes on save; ring plus "n of m tasks" |

## Patterns that work

| ID | Pattern | Mechanism (how it actually works) | Why it works | Evidence [basis] | Cerebro today | Verdict | Phase |
| --- | --- | --- | --- | --- | --- | --- | --- |
| OUT4-01 | Lifecycle meta sentence with changed-since-viewed | `DocumentMeta` picks one sentence by precedence (revision, deleted, archived, imported-unchanged when `importedAt>=updatedAt`, created when `createdAt===updatedAt`, published, updated). `Modified highlight={modifiedSinceViewed && !mine}` marks changes; "Never viewed"/"Viewed 2d" follows and is dropped after 1 yr; the title copy links to History. `lastViewedAt` is set after 3 s dwell | Answers "who touched this, and is it new to me" with no panel open; one derivation serves the page and every row | `O/app/components/DocumentMeta.tsx:93-201`; `O/app/scenes/Document/components/DocumentMeta.tsx:71-90`; `O/app/models/Document.ts:324-334`; `.../MarkAsViewed.ts:4` [read] | `attributionLine` exists (`src/engine/attribution.ts:72`) but renders only in Details (`src/detail/DocSidePanel.tsx:206`). Rows show an mtime date (`src/pages/PagesPage.tsx:32`). The open log keeps 10 times per path (`src/engine/openLog.ts:27`) | adapt (BSL: idea only) | M94.3, M94.6, M99.6 |
| OUT4-02 | A missing target resolves against Trash | A trashed doc still loads read-only (`canEdit` false). The notice shows "Deleted by X · time" and "permanently deleted in N days unless restored", clamping past dates. 404 offers Home and Search | You recover from the place you landed, not from Settings | `.../Notices.tsx:35-92`; `.../DataLoader.tsx:306`; `O/app/scenes/Errors/Error404.tsx` [read] | "This page no longer exists… may have been renamed or moved to the Trash" plus Go home only (`src/pages/DocPage.tsx:334-352`). `listTrash` already returns path, title, deletedAt (`src/engine/trash.ts`) | adapt | M94.5 |
| OUT4-03 | Land on parent after delete | `DocumentDelete` redirects to the parent doc, else the collection, else home, and only if you were viewing the deleted doc | Keeps you in context; Home is a reset | `O/app/scenes/DocumentDelete.tsx:31-55` [read] | Always `navigate({kind:'home'})` (`src/pages/DocPage.tsx:480`), though `placeResolves` already prunes dead Back entries (AGENTS.md M65.4) | adapt | M94.5 |
| OUT4-04 | Restore elsewhere when the origin is unavailable | `restoreDocument` shows when the original collection is active. Otherwise `restoreDocumentToCollection` lists writable collections as a submenu. Trash has deleted-by and date filters with per-filter empty copy | Restore never dead-ends | `O/app/actions/definitions/documents.tsx:1490-1560`; `O/app/scenes/Trash/index.tsx:30-77` [read] | Restore goes to `manifest.path` only (`src-tauri/src/vault/trash.rs:572`) and refuses an occupied path (`trash.rs:990`, `src/engine/trash.ts:48`). No preview of a trashed item | adapt | M94.8 |
| OUT4-05 | One destination tree for every "where" | `DocumentExplorer` is a fuzzy-searchable tree (`useDeferredValue`) with arrow keys, alt-click deep expand and auto-expand to the current location. It serves publish, move, copy and template move. The footer reads "Publish in <title>" | One learned control; the destination is named before commit (UX-05) | `O/app/components/DocumentExplorer/DocumentExplorer.tsx:71-146,371+`; `O/app/scenes/DocumentPublish.tsx:36-90` [read] | Flat folder buttons with no filter (`src/components/MoveDialog.tsx`). "In …" is a `Select` (`src/app/CreationDestinationField.tsx:50-70`) | adapt | M94.4, M94.5 |
| OUT4-06 | Move states its access consequence | `ConfirmMoveDialog` maps previous and next collection permission to words: "will change permission … from view only to edit" | Consequences are shown before the act, not discovered later | `O/app/components/ConfirmMoveDialog.tsx:27-80`; `O/app/scenes/Collection/components/MembershipPreview.tsx` [read] | Agent reach is derived per path (`pageAccess`, `src/engine/agentAccess.ts:506`; shown in `src/detail/PageAccess.tsx`). `RenamePrompt` carries only pages, anchors, refused and sources (`src/stores/renamePromptStore.ts:3-13`) | adapt | M94.5 |
| OUT4-07 | Compare to any version; step through changes | Compare-to options are Previous or each revision (named label else date, grouped by year). The toggle is persisted (`history-show-changes`) and mirrored in the URL (`?changes`, `?compareTo`). Changes are stepped "n of m" with prev/next. A synthetic "Current version" appears when the doc differs from its latest revision | Review of someone else's edits is a first-class task | `.../History/History.tsx:54-131,200-238`; `HighlightChangesControl.tsx:43-99`; `ChangesNavigation.tsx:13-62` [read] | Prose diff against the previous version only (`src/git/ProseDiffView.tsx:116`). Restore via `InlineDiff` (`src/git/InlineDiff.tsx:148,259`). `UncommittedRow` exists | adapt | NEW:history (M94.8) |
| OUT4-08 | Merged revision and event timeline | Revisions and lifecycle events are fetched with separate offsets, merged descending and cut to `limit`; each offset advances by what it contributed. Revisions identical to the previous one are skipped | Correct k-way paging; no duplicate empty rows | `.../History/History.tsx:133-165`; `O/server/queues/processors/RevisionsProcessor.ts:41-52` [read] | `PageHistory` folds commits, sessions, runs and ledger, each read failing alone (`src/history/PageHistory.tsx`), bounded in Rust (`src-tauri/src/runtime/activity.rs:204-228`) | already-have | none |
| OUT4-09 | Restore is an ordinary write | Restore navigates with `{restore,revisionId}`. `onSynced` fetches the revision, runs `replaceSelection(data, AllSelection)` and toasts. Normal save and revisioning follow | No privileged overwrite path | `O/app/actions/definitions/revisions.tsx:63-87`; `.../Document.tsx:119-160` [read] | `restoreVersion`: save-first, receipted `restore_note_version`, replaced version kept in History (`src/git/useGit.ts:441-468`). Journal restore exists (`src/history/RecoveryVersions.tsx`) | already-have | M93.9 |
| OUT4-10 | Panels stay mounted while hidden | `React.Activity mode` per panel. `lastPanel` stays visible through the close animation. Lazy chunks preload on click intent | Switching keeps scroll, folds and loaded data; effects are disposed while hidden | `O/app/scenes/Document/hooks/useDocumentSidebar.tsx:45-77`; `O/app/stores/UiStore.ts:378-399` [read] | One slot, conditionally mounted (`src/detail/DocSidePanel.tsx:416-434`). Comment drafts already survive (`src/detail/usePageComments.ts:58,205`) | adapt | M94.3 |
| OUT4-11 | Search landing reuses editor Find | Result links carry `?q=`. `onSynced` runs `editor.commands.find`. `SearchHighlightChip` shows the term and Esc clears it via `history.replace` without `q`. Find & Replace shares the clear | One highlighter, not a second one | `O/app/components/DocumentListItem.tsx:171`; `.../Document.tsx:128-133`; `.../SearchHighlightChip.tsx`; `O/app/hooks/useClearSearchHighlight.ts` [read] | Exact passage reveal plus Return to results (`src/editor/NoteBodyEditor.tsx:1215-1245`, `src/app/sourceOpen.ts`). `FindBar` seeds from the selection only (`src/editor/FindBar.tsx:295-317`) | adapt | M97.2, M94.5 |
| OUT4-12 | Search page: URL filters, error separate from empty, recent queries | Filters are collection, author, status, updated-since, titles-only and sort, all in the query string. Errors and empty results get different copy. The last 8 queries are deduped and deletable (`source==='app'`). The snippet's `<b>` marks become React `<mark>`; the snippet hides when the query is in the title | Bookmarkable, honest result states | `O/app/scenes/Search/Search.tsx:66-205,235-261,400-420`; `O/app/stores/SearchesStore.ts:14-19`; `DocumentListItem.tsx:47-51,86-87,240-245` [read] | Palette categories, excerpt parts drawn as text, unavailable separate from no matches, "N more not shown" (`src/app/QuickOpen.tsx:676-725`). Session-only resume snapshot (M97.2) | already-have (watch scope filters) | M97.2 |
| OUT4-13 | Checklist progress on meta and rows | `getTasksSummary(doc)` runs on save; `updateTasks` keeps it current while editing. `DocumentTasks` shows a ring, "n of m tasks" and a bounce at done | Progress without opening the page | `O/app/models/Document.ts:458-501`; `O/shared/utils/ProsemirrorHelper.ts:434`; `O/app/components/DocumentTasks.tsx` [read] | `parseTasks` plus a hash-keyed cache feed only the Home and My work rollups (`src/engine/tasks.ts`, `src/hooks/useDocTasks.ts:44-80`) | adapt | M94.6, M99.6 |
| OUT4-14 | Comment panel ergonomics | Sort by Most recent or Order in doc (from editor marks), Resolved view, collapse threads of 5 or more replies to the last 3 with a facepile, "New comments" jump when not at the bottom | Long threads stay scannable | `.../Comments/Comments.tsx:63-139`; `CommentThread.tsx:86-96`; `CommentSortMenu.tsx` [read] | Sections On the page, Discussion, Unplaced and Resolved, with quote anchors outside the file (`src/detail/commentSections.ts:5-19`, `src/engine/commentAnchor.ts`). No thread collapse | already-have (watch collapse for @agent threads) | none |
| OUT4-15 | Template on a new page; templatize as a copy | The header shows TemplatesMenu while `wasNew` (cached at mount). Applying to an empty doc replaces everything; otherwise it inserts at the selection. Templatize is a non-destructive copy with a location | Structure is offered when it is needed | `.../Header.tsx:94-97,206-214`; `useDocumentSave.ts:~280-293`; `O/app/components/TemplatizeDialog/index.tsx` [read] | `BlankPageBar` "Start from a template", Save as template, `{{title}}`, `{{date}}`, `fill:` (`src/pages/DocPage.tsx:131-165`, `src/lib/templates.ts`) | already-have | none |
| OUT4-16 | Page-first create, auto-delete of empty drafts | `DocumentNew` creates an empty doc and `history.replace`s into it. On unmount, an untitled, empty, never-edited own draft is deleted (`shouldAutoDeleteDraftOnUnmount`) | Zero-friction start | `O/app/scenes/DocumentNew.tsx:28-86`; `.../useDocumentSave.ts:54-82,337-379` [read] | Title-first dialog plus session draft and pending submission (`src/app/CreateMenu.tsx`, M94.4) | avoid | M94.4 (keep) |
| OUT4-17 | Archive distinct from Trash | Archive takes a doc out of navigation and default search (`statusFilter` defaults to Published and Draft), makes it read-only and restorable, with an optional reason. The delete dialog offers Archive | A softer state than delete | `O/app/components/DocumentArchiveDialog.tsx`; `O/app/scenes/DocumentDelete.tsx:121-150`; `Search.tsx:76-83` [read] | Pages have no archive. Concepts have Replaced and Deprecated flags (`src/knowledge/ConceptReviewBar.tsx:153,174`) | watch | owner Q |
| OUT4-18 | Imports as durable, removable jobs | FileOperation states: Processing, Completed, Failed (with error), Expired. Each shows requester, time, format and size. Deleting an import deletes everything it created, behind a confirm | Import is one undoable unit after the session ends | `O/app/scenes/Settings/components/FileOperationListItem.tsx`; `Import.tsx` (merged paging) [read] | Imports are one undoable batch within the session (CV-39, M69). Stamped identity exists (`shared/import/sources.v1.json`). No import history | watch | NEW:import |
| OUT4-19 | OKF bundle round-trip | Export writes `type: Document`, `title`, `description`, `resource`, `status` (draft, stable or deprecated) and `generated.by: human:<email>`, plus a root `index.md` with `okf_version: 0.2`. Import maps folders to collections and reads titles from frontmatter | An open interchange format | `O/server/models/helpers/OKFHelper.ts:54-104`; `O/app/scenes/Settings/components/ImportOKFDialog.tsx`; `ExportDialog.tsx` [read] | `knowledge/` is an OKF v0.2 bundle (`src/engine/okf.ts:5-23`). No OKF import source | adapt (owner-gated) | NEW:import |
| OUT4-20 | Onboarding as ordinary content | A seeded "Welcome" collection of markdown docs, including a Getting Started checklist | Teaches with the product's own features | `O/server/onboarding/*.md` [docs]; `accountProvisioner.ts:254-300` [read] | Offered create-only kit with `getting-started.md` and starter tasks, accept or decline recorded (`shared/starter/vault/*`, `.cerebro/starter.json`) | already-have (Cerebro better: offered, not silent) | none |
| OUT4-21 | Shortcut help with filter and syntax | Categories include Markdown and Triggers; a sticky search filters them and Esc clears | Covers how to write, not only chords | `O/app/components/KeyboardShortcuts.tsx:278-455` [read] | Rendered from the catalog, grouped, no filter, no editor syntax (`src/pages/KeyboardShortcutsSettings.tsx`) | adapt (render from editor builders, never hand-type) | M94.8 |
| OUT4-22 | Responsive hiding never rewrites preferences | The TOC hides on mobile "at render time so the stored preference is kept intact". The header compacts by measured width | No silent preference loss | `.../Document.tsx:318-322`; `Header.tsx:91-92` [read] | Drawers never write stored flags (`src/detail/DocPagesPanel.tsx` onHide; M92 rail) | already-have | M94.3 (confirm) |
| OUT4-23 | Notification inbox | `viewedAt`/`archivedAt`, mark-all-read or archive, unread count, subscriptions | Team awareness | `O/app/stores/NotificationsStore.ts` [read] | Pull-only Home with done marks and "since you looked" (`src/engine/homeLanes.ts:89-145`) | avoid | none |
| OUT4-24 | Share and publish, plus local export | Public share links need the server. Locally Outline offers copy as Markdown or plain text, print, and download as PDF or HTML | Getting a page out of the app | `O/app/actions/definitions/documents.tsx:733-907,1164` [read] | Sheet and CSV export, Save a copy for files. No page print, PDF or copy-as | avoid (sharing), watch (local export) | NEW:export |

### F1 — Lifecycle meta sentence (OUT4-01)

**Outline.** `DocumentMeta` (`O/app/components/DocumentMeta.tsx:93-166`) picks `content` by precedence and wraps "updated" in `<Modified highlight={modifiedSinceViewed && !lastUpdatedByCurrentUser}>`. `timeSinceNow()` (`:173-201`) adds "Never viewed" (highlighted) or "Viewed 2d", and hides it after a year. `TitleDocumentMeta` (`O/app/scenes/Document/components/DocumentMeta.tsx:71-90`) makes the sentence a link to History, preloading the chunk on intent, and appends a Comment count that toggles the comments panel. `MarkAsViewed` records a view after `3*1000` ms of dwell (`MarkAsViewed.ts:4-21`).

**Cerebro sketch.** A pure `src/engine/pageMeta.ts` (proposed) computes the line, which renders in the stable metadata portal under the projected title (M85–M86) and never remounts the editor:

```ts
pageMetaLine({ attribution: PageAttribution | 'unavailable', lastOpenedAt: number | 'unknown',
  imported: { system: string; unchangedSinceImport: boolean } | null, now: Date })
  -> { text: string; tone: 'quiet' | 'changed'; opens: 'history' }
```

Precedence:

1. A failed read: "Last change couldn't be read" (CV-05).
2. `knowledge`: skip, because the review bar owns concepts.
3. Imported and unchanged: "Imported from Notion · 3 d".
4. Recorded, with actor ≠ `human:me` and `at > lastOpenedAt`: changed tone, "Research agent changed this · 2 h · since you last opened". Append "· you allowed it" when it applies.
5. `unattributed`: "Changed outside Cerebro".
6. `not_recorded`: "Edited 3 d · writer not recorded".

Rules:

- Name an agent only from `page_attribution` (CV-35).
- A path past the open log's 200-page cap is "unknown", never "never opened".
- Count a page as seen only after a dwell (Outline uses 3 s), so arrow-keying through pages doesn't clear "changed".
- Clicking calls `openSideRef.current('history')`.
- Pages rows need one batch last-writer read (a `SELECT` over `vault_writes` per vault), not N `page_attribution` calls. The M99 metadata store should expose it.

### F2 — Deleted-target journey (OUT4-02/03/04)

**Outline.**

- A deleted doc still loads read-only (`DataLoader.tsx:306`), and `Notices` renders who deleted it, when, and the clamped countdown (`Notices.tsx:38-57`).
- `restoreDocument` shows when the original collection is active. Otherwise `restoreDocumentToCollection` builds a submenu of writable collections (`documents.tsx:1517-1560`).
- `DocumentDelete` lands on the parent, then the collection, then home (`DocumentDelete.tsx:31-55`).

**Cerebro sketch.**

- In DocPage's missing branch (`src/pages/DocPage.tsx:334`), call `listTrash(vault)` and keep items where `item.path === selection.path`, newest stamp first.
- **Found:** show "Moved to Trash <date> · leaves after <purgeWhen>" with Restore (`restoreItem`), Back, and Search "<title>". Search seeds `quickOpenResume`. Keep Go home as secondary.
- **Trash read failed:** say unavailable. Never say "not in Trash" (CV-05).
- **Restore collides** (`alreadyExists`): offer **Restore as…**. This needs an optional `to` on `restore_from_trash`, under the same path locks, receipt, comment-sidecar carry and knowledge/hidden refusals. Links keep pointing at the page that now holds the old name, so no rewrite is needed.
- Settings → Recently deleted gets a read-only, human-only preview. Trash stays outside scan, search and agent tools (CV-37).
- **After a delete:** land on the surviving Back destination, then the parent folder note, then Home.

### F3 — Move reach delta (OUT4-06)

**Outline.** `ConfirmMoveDialog` resolves the previous and next collection permission into words and requires a confirm.

**Cerebro.** In `renameKeepingLinks` (`src/app/renameActions.ts`), after `planRename`:

- For each moved page, compute `pageAccess({entries, path: from, …})` and `pageAccess({entries: afterMove, path: to, …})`.
- Diff the rows into `prompt.reach: {agent, before: Reach, after: Reach}[]` and count them in `needsPrompt` (`renameActions.ts:176-180`).
- Derive reach through `agentAccess` only (CV-46).
- List agents whose `changed` triggers start or stop covering the page. Flag them, never rewrite (as CV-40 does for references).
- A folder-level summary using `summaryShort` gives Collection headers an analogue of `MembershipPreview`.

### F4 — History compare base (OUT4-07)

**Outline.** `HighlightChangesControl` builds compare options as Previous plus each revision (`:43-99`). The choice is persisted and mirrored in the URL. `ChangesNavigation` reads the diff extension's index for "n of m".

**Cerebro.** `ProseDiffView` already diffs two bodies. Add a base selector with these options:

- Previous (the default).
- Any listed commit.
- **When you last opened**: the newest commit at or before the open-log time. Hidden, with a reason, when git is off or the log lacks the page.
- The working copy (`UncommittedRow`).

Add prev/next stepping over the changed `proseDiff` blocks. The base is session state and is never written. Restore stays `restoreVersion`.

### F5 — Panels under Activity (OUT4-10)

**Outline.** `DocumentSidebarContent` keeps `lastPanel` through the close animation and wraps each lazy panel in `<React.Activity mode>` (`useDocumentSidebar.tsx:45-77`).

**Cerebro.** In `DocSidePanel`, mount each panel on first visit, then toggle `mode` instead of unmounting. Effects dispose while hidden, so keyed reads re-run when the panel shows again; `useKeyedRead` already drops late answers. Then verify:

- A hidden panel holds no layer, Escape or key claim (CV-47).
- Focus moves to the shown panel's heading.
- The CV-44 presets still render.

## Avoid / doesn't transfer

- **Comment marks inside the document** violate CV-31. Cerebro's quote anchors already handle moved or ambiguous text (`src/engine/commentAnchor.ts`).
- **Create-then-auto-delete** writes an empty file, then hard-deletes it. CV-37 forbids hard deletes, the Trash would fill with blanks, and git and receipts churn. Keep title-first creation with session drafts (M94.4).
- **Notifications inbox with unread counts, subscriptions, "mark all read"** conflicts with Home being pull-only with no counts (M64.4).
- **Public share links, publish to web, "Viewed by", popularity, presence, facepiles, reactions** all need a server and multiple users.
- **Draft vs published** doesn't apply to a single user: every file is real. The Inbox is already the unfiled lane.
- **Persisted recent queries** (Outline keeps a server table) cut against M97's session-only Quick Open snapshot, which persists no queries or excerpts. The open log already covers recent pages.
- **A search route as the primary UX** is weak in Outline itself: Back loses scroll and the active row (`ScrollToTop.ts`). Add scope filters (folder, type, edited-by, date) only if labeled misses justify them (KNOW-10 style).
- **Named versions** exist in Outline only as an API (`revisions.update` sets `name`; there is no UI action in `app/actions/definitions/revisions.tsx`). That is weak evidence for the feature.
- **OKF `generated.by: human:<email>`** must never become Cerebro human authority (CV-22).
- **Header fading while typing** (`O/app/hooks/useEditingFocus.ts`: 3 s idle) is an aesthetic choice for the owner. Watch only.

## Implications for M93-M99

- **M93**
  - Confirm M93.9/REL-03 restore through the guarded owner. Outline restores as an ordinary editor edit (`Document.tsx:139-159`), which matches Cerebro's receipted restore that keeps the replaced version in History.
  - Confirm the M93.2 leave barrier. Outline's `Prompt` only blocks for in-flight uploads; unsynced changes are only logged (with `hasLocalPersistence`), because it relies on its multiplayer layer (`Document.tsx:331-367`). Files-first Cerebro has no such layer, so its blocking barrier is the right design, not over-engineering.
- **M94**
  - Amend M94.3: add the meta line in the metadata portal (OUT4-01) and keep panels mounted under Activity (OUT4-10).
  - Amend M94.4: use one shared searchable destination tree for "In …" (OUT4-05).
  - Amend M94.5:
    - a missing target looks up the Trash and offers Restore, Back and Search (OUT4-02);
    - after a delete, land on Back or the parent, not Home (OUT4-03);
    - add the reach delta to the move/rename prompt (OUT4-06);
    - Move uses the shared tree;
    - seed Find from the query (OUT4-11).
  - Amend M94.6: Pages rows show the recorded last writer, changed-since-opened and checklist progress (OUT4-01, OUT4-13).
  - Amend M94.8: Trash gets a read-only preview and Restore as… (OUT4-04). Shortcut help gains a filter, plus editor syntax (Markdown input rules, slash keys) rendered from the editor's own builders (OUT4-21).
  - Add **M94.10, "Review a page's changes"** (NEW:history): compare to any version, the version at your last open, or the working copy, and step through changes (OUT4-07). It has no storage change.
- **M97**
  - Confirm M97.2: Return to results restores query and scroll, which beats Outline.
  - Confirm M97.5: bounded excerpts that open the recorded occurrence beat Outline's title-only backlinks with a `#d-<id>` hash.
  - Amend M97.2: after the exact reveal, offer FindBar seeded with the query ("n matches for '…'") through `openBar`, with no new highlighter (OUT4-11).
  - Add, behind the owner's decision, **OKF bundle import** as an M69 source: imported pages with `source_system`, never `human:me`, never written into `knowledge/` (OUT4-19).
- **M99**
  - Amend M99.6's consumer matrix: list-row lifecycle facts (last recorded writer per path, checklist counts) become metadata consumers.
  - If Rust counts checklists, the task-line grammar becomes a D3 twin of `parseTasks` and needs a shared case file (CV-04).
- **M95, M96, M98:** no change from this slice.

## Owner questions

1. **Archive:** should pages get an Archive state (hidden from Pages and Quick Open defaults, read-only, restorable, links intact), or are folders enough? Outline keeps it separate from Trash and offers it inside the delete dialog.
2. **"Changed since you last opened":** are quiet marks on the page meta line and Pages rows acceptable under "nothing speaks first"? They are pull-only annotations, never counts.
3. **OKF import:** should Cerebro import OKF bundles (such as an Outline export) as imported pages (CV-22)? Is any part ever eligible for `knowledge/`?
4. **Creation:** keep title-first creation, or move to page-first creation where the file is only written on first content (avoiding empty-file churn)?
