# Feature audit - Cerebro vs 10 reference apps (2026-10-24)

> Cross-checked 2026-10-27; see codex-crosscheck/.

> **Stage 2, dimension: Features.** Inputs: the 20 stage-1 dossiers, both Cerebro baselines, `stage1-findings-index.md`, and the earlier research (`plans/2026-10-22-*`, `specs/2026-10-23-m93-m99-research/`). About 45 reference files were reopened (r), and about 40 Cerebro reads and greps were run on the dirty tree (HEAD `6c92709` plus the staged M93–M99 work). Nothing was built, run or installed.
> **Codes:** Y shipped · Y† shipped only in the staged, uncommitted M93–M99 tree · ~ partial · P planned (phase) · - absent (grep 0, dossier or baseline) · ? not assessed. **Basis:** (r) read · (n) names · (d) docs · G0 = grep returned 0. A dossier ID means that stage-1 row supports the cell.
> **Paths:** `AF` AFFiNE-canary/ · `OL` outline-main/ · `TO` tolaria-main/ · `PL` plane-preview/ · `AY` AppFlowy-main/frontend/ · `N8` n8n-master/packages/ · `AP` activepieces-main/packages/ · `MA` macro-main/ · `MO` Morrow-main/ · `TD` thought-desk-main/, all under `docs/examples/`. `CE` paths are repo-relative. Short paths are unique suffixes under those roots (checked 2026-10-24): AF `modules/`, `components/`, `hooks/` = `packages/frontend/core/src/…`, AF `electron/` = `packages/frontend/apps/electron/`; OL `Document/`, `History/` = `app/scenes/Document/…`; TO `components/`, `hooks/`, `inspector/` = `src/…`; PL `components/` = `apps/web/components/`; AY Dart = `appflowy_flutter/lib/…`, Rust = `rust-lib/…`; MA `features/` = `apps/web/src/features/`, `nodes/` = `packages/lexical-core/nodes/`; MO `core/` = `src/core/`, `components/`, `editor/`, `database/` = `src/app/…`; TD `lib/` = `src/lib/`.
> **Licences:** ideas only (re-implement) for Outline (BSL), Plane, AppFlowy, Macro, Thought Desk and Tolaria (AGPL), and n8n (SUL). AFFiNE is MIT outside `packages/backend/**` and `packages/common/native/**`; Activepieces is MIT outside EE; Morrow is Apache-2.0. Two dependencies are adopted as-is: `tauri-plugin-single-instance` 2.5.3 and `tauri-plugin-window-state` 2.5.0, both "Apache-2.0 OR MIT" (r: `~/.cargo/registry/.../Cargo.toml`).

## Bottom line

- **Breadth is not Cerebro's gap.** Of the 120 features assessed, Cerebro ships 65 (5 of them only in the staged M93–M99 tree), has 16 partially and plans 7. It leads all ten references on typed records over Markdown (10 view kinds, relation/rollup/formula fields, item keys; closest are Morrow, Markdown frontmatter with 5 views, relation and formula but no rollup, and Thought Desk, on SQLite), on supervised agents, and on guarded knowledge and evidence.
- **12 of the 32 absences are deliberate:** multi-user features, hosted models, a public API and webhooks, theme editors, i18n, mobile, iframes and auto-update. Keep them out ("Gaps to skip").
- **The convergent misses are small, local and files-first:**
  - render-fault containment: 7 of 10 references, plus 2 partial;
  - math: 7 of 10;
  - page PDF/print export: 6 of 10;
  - Restore in place for trashed pages, and single-instance launch: 4 of 10 each;
  - app zoom, native menu and window restore: 3–4 of 10.
- **Background agents make "what changed since I looked" a top feature.** Cerebro records its own writers (`vault_writes`) and your recent opens (a per-Mac open log: 200 pages, 10 opens each), but shows this only in Details, and its version lens compares a commit only with its parent. Outline's meta line and compare-to-any-version are the model (FEAT-05/06).
- **Creation and data-view journeys have cheap convergent fixes:** create a page from a search miss or a dangling link (M94.4/M94.5), seed new records from the view's filters (M94.6), measure and then page board columns (M93.6/M93.7), and add bulk actions to Pages (a new phase after M94.3's accepted composition).
- **One latent defect:** search tokens are lowercased but not Unicode-normalized, so precomposed and decomposed "café" are indexed differently (`src-tauri/src/search.rs:217-222` (r); the effect is inferred, not run).
- **Two P0s, both unguarded leave paths in current M93/M94 work.** A render throw unmounts the root, and that removes the ⌘Q flush: `useQuitHost` is a React effect (`src/app/quit.ts:248-249` (r)), and `createRoot` takes no error hooks (`src/main.tsx:15` (r)). A right-click Reload discards M93.1's retained drafts and M94.4's session drafts (FEAT-14). 13 of the 32 recommendations wait on owner calls.

## Feature matrix

### Editor and blocks

| # | Feature | Cerebro | AFFiNE | Outline | Tolaria | Plane | AppFlowy | n8n | Activepieces | Macro | Morrow | Thought Desk | Key evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| E1 | Callout + toggle blocks | Y | ~ | Y | ~ | ~ | Y | - | - | ? | Y | Y | AF toggle list deprecated `blocks/list/.../list-model.ts:11` (r); OL `shared/editor/nodes/{Notice,ToggleBlock}` (n); PL callout, toggle G0; MO callout and toggle, `editor/SlashCommand.ts:165-177` (r); TD `lib/editor/callout.ts` (n) |
| E2 | Markdown source mode on the same writer | Y† | - | - | Y | - | - | - | - | - | Y | - | CE `src/editor/SourceBodyEditor.tsx` (r, M93.8); TO `components/RawEditorView.tsx` (n); MO `components/SourceEditor.tsx` (n); others G0 |
| E3 | Multi-column layout | Y | - | - | - | - | Y | - | - | - | Y | - | CE `:::columns`; AY `editor_plugins/columns` (n); MO 2 and 3 columns, `editor/SlashCommand.ts:276-281` (r); others G0 |
| E4 | Footnote citations | Y | Y | - | - | - | - | - | - | - | - | ? | CE `src/editor/citations.ts`; AF `blocksuite/affine/inlines/footnote` (n) |
| E5 | Read-only embed of another page | - | ~ | - | - | - | ? | - | - | - | Y | ? | ~~AF synced doc is editable (AFN2 avoid, CV-52)~~; MO `src/app/editor/PageLink.ts:23,103`, `SlashCommand.ts:324-330` "Embed a page", read only (r) |

> **2026-10-27 (Codex cross-check, CX-AFE-10):** AFFiNE's synced doc opens a `readonly: true` store (`AF/blocksuite/affine/blocks/embed-doc/src/embed-synced-doc-block/embed-synced-doc-block.ts:415-419`), stops at ancestor cycles (`_checkCycle`, `:422`) and shows trash, missing and load-error faces (`:452-465`). It is a positive precedent for FEAT-21, not an avoid; dimension-editor (`:189,234`) had already corrected this.

| # | Feature | Cerebro | AFFiNE | Outline | Tolaria | Plane | AppFlowy | n8n | Activepieces | Macro | Morrow | Thought Desk | Key evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| E6 | Web iframes (YouTube, Figma…) | - | Y | Y | - | - | ~ | - | - | ? | - | - | CE CSP `default-src 'self'` (OUT2-23); AF `blocks/embed/src/embed-{youtube,figma,loom,iframe}-block` (n); OL `shared/editor/embeds/` (n) |
| E7 | Markdown is the truth; every offered block survives a save | Y | - | - | ~ | - | - | - | - | - | ~ | - | CE CV-24 walk `src/editor/markdown.test.ts`; TO per-feature "markdown-durable" ADRs (d); AF/OL treat Markdown as a lossy export (AFN2-03, OUT2-05) |

### Pages, titles, icons, properties

| # | Feature | Cerebro | AFFiNE | Outline | Tolaria | Plane | AppFlowy | n8n | Activepieces | Macro | Morrow | Thought Desk | Key evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| P1 | Page icon + cover | Y | ~ | ~ | ~ | ~ | Y | - | - | ? | Y | ~ | CE `src/detail/PageChrome.tsx`; cover G0 in AF/OL/TO/TD; AY `editor_plugins/cover` (n); MO `components/Cover.tsx` (n) |
| P2 | Word count / reading time | - | ? | Y | Y | ? | Y | - | - | ? | - | Y | OL `app/hooks/useTextStats.ts`, `ReadingTime.tsx` (n); TO `inspector/NoteInfoPanel.tsx:44` (r); TD `lib/editor/Editor.svelte` `characterCount.words()` (r); CE G0 |
| P3 | Lifecycle meta line ("changed since you viewed") | ~ | ? | Y | ~ | ? | ~ | - | - | ? | ~ | ? | OL `app/components/DocumentMeta.tsx:68,159,185` (r); CE attribution shown only in Details (OUT4-01); TO/AY/MO show last-edited time only |
| P4 | Page lock (read-only) | - | - | - | - | Y | Y | - | - | - | - | - | PL `components/pages/header/lock-control.tsx` (n); AY `features/page_access_level`, Rust `view_is_locked` (AFY-17) |
| P5 | Archive, distinct from Trash | - | - | Y | Y | Y | - | Y | ? | ? | - | - | OL `app/scenes/Archive.tsx` (n); TO `components/ArchivedNoteBanner.tsx` (r); PL `components/archives` (n); N8 archived workflows (n) |

### Databases and views

| # | Feature | Cerebro | AFFiNE | Outline | Tolaria | Plane | AppFlowy | n8n | Activepieces | Macro | Morrow | Thought Desk | Key evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| D1 | Typed record databases | Y | Y | - | ~ | Y | Y | ~ | ~ | Y | Y | Y | TO "types as lenses, not schemas" (README, d); AY `flowy-database2/.../field_entities.rs:427-443` (r); N8 `cli/src/modules/data-table` (n); AP `web/src/features/tables` (n) |
| D2 | Board + calendar views | Y | Y | - | - | Y | Y | - | - | ~ | Y | Y | AF `data-view/src/view-presets/{kanban,calendar}` (n); MA board only (n); MO `database/DatabaseView.tsx:166-181` (r) |
| D3 | Gantt / timeline | Y | - | - | - | Y | - | - | - | - | - | Y | PL `components/gantt-chart` (n); TD `lib/db/TimelineView.svelte` (n) |
| D4 | Gallery | Y | - | - | - | - | - | - | - | - | Y | Y | G0 elsewhere |
| D5 | Chart / dashboard views | Y | - | - | - | ~ | - | ~ | - | - | - | Y | TD `lib/db/ChartView.svelte` (n); PL analytics and N8 insights are not data views (n) |
| D6 | Formula + rollup fields | Y | - | - | - | - | - | - | ? | ? | ~ | Y | AY field types have neither (r); MO `core/formula.ts`, rollup G0; TD `lib/db/FormulaEditor.svelte`, rollup in `lib/db/query.ts` (n) |
| D7 | Relation fields | Y | - | - | ~ | ~ | Y | - | - | Y | Y | Y | AY `FieldType::Relation` (r); MA `database-relation-cell.tsx` (n); MO `core/database.ts:36` (r); TO wikilink relationships; PL issue relations |
| D8 | Record side peek | Y | Y | - | - | Y | Y | - | - | ? | - | - | AFN4-05, PLN-19, AFY-19 |
| D9 | Bulk select + actions | Y | Y | Y | Y | ? | ? | ? | ? | ? | ? | Y | AFN4-08, OUT3-09, TO `components/BulkActionBar.tsx` (n), TDK-19; CE has tables, plus `ListSelectionBar` (Copy links only) on lists |
| D10 | New record takes the view's filter values | ~ | Y | - | - | ? | ? | - | - | ? | ? | Y | AF `data-view/src/core/filter/generate-default-values.ts` (r); TD `lib/databases.svelte.ts` `#defaults` (r); CE band/host only, `src/engine/createRecord.ts:18` (AFN2-08) |
| D11 | Per-column board paging | - | ? | - | - | ? | ? | - | - | ? | ? | Y | TD `lib/db/BoardView.svelte:31,176` (r); CE one view-wide `limitEntries` (`src/engine/viewFilters.ts:562`, r) |
| D12 | Forms for intake | P M98.8 | - | - | - | - | - | Y | Y | Y | - | Y | N8 Form trigger (n); AP `web/src/features/forms` (n); MA `crates/forms` (n); TD `lib/db/FormView.svelte` (n) |

### Whiteboard and canvas

| # | Feature | Cerebro | AFFiNE | Outline | Tolaria | Plane | AppFlowy | n8n | Activepieces | Macro | Morrow | Thought Desk | Key evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| W1 | Infinite canvas (ink, shapes, connectors, embedded in a page) | Y | Y | - | Y | - | - | - | - | Y | Y | - | AF `blocksuite/affine/gfx/{brush,connector,shape}` (n); TO `TldrawWhiteboard.tsx` (n); MA `features/block-canvas` (n); MO `CanvasView.tsx`, `EmbeddedCanvas.tsx` (n) |
| W2 | Open canvas file format (JSON Canvas) | Y | - | - | - | - | - | - | - | - | Y | - | MO `src/core/canvas.ts:1` "open json canvas format", with ink as its own extension (r) |
| W3 | Present as slides | - | Y | Y | - | - | - | - | - | ? | - | - | OL `Document/components/PresentationMode.tsx:70-81`, slides from H1/H2/HR (r); AF frame presentation (n) |

### Sheets, code, diagrams, math

| # | Feature | Cerebro | AFFiNE | Outline | Tolaria | Plane | AppFlowy | n8n | Activepieces | Macro | Morrow | Thought Desk | Key evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| S1 | Formula spreadsheets (+XLSX) | Y | - | - | Y | - | - | - | - | Y | - | - | TO `SheetEditor.tsx`, ADR "sheet nodes with plain-text workbook storage" (d); MA `features/block-spreadsheet` (n) |
| S2 | Mermaid diagrams | Y | Y | Y | Y | - | - | - | ~ | - | Y | - | MO `editor/SlashCommand.ts:302-309` (r); AP previews in chat only (n) |
| S3 | Structural diagram editor | Y | - | ~ | - | - | - | - | - | - | - | - | CE `src/mermaid/flowchart/StructuralEditor.tsx` (r); OL edits draw.io diagrams in the hosted diagrams.net editor, web only, `app/editor/menus/block.tsx:280-290` (r); the others render Mermaid fences (AFN2-21, OUT2) |
| S4 | Math (KaTeX inline and display) | - | Y | Y | Y | - | Y | ~ | - | Y | Y | Y | TO ADR markdown-durable-math-notes: placeholder round trip on the same BlockNote (r); AF dollar-currency tests `markdown.unit.spec.ts:5045-5054` (r); MO `editor/Extras.ts:13,214` (r); CE G0 |

### Files and media

| # | Feature | Cerebro | AFFiNE | Outline | Tolaria | Plane | AppFlowy | n8n | Activepieces | Macro | Morrow | Thought Desk | Key evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| F1 | PDF viewer | Y | Y | ~ | Y | - | - | - | - | Y | - | ? | AF `core/src/modules/pdf` (n); OL inline `shared/editor/components/PDF.tsx` (n); TO ADR in-app PDF previews (d); MA `features/block-pdf` (n) |
| F2 | Office text extraction (docx/pptx/xlsx) | Y | ~ | ~ | - | - | - | Y | ~ | Y | - | - | CE `src-tauri/src/files/extract/{docx,pptx,xlsx}.rs` (r); OL/AF import converters only (n); N8 `@n8n/instance-ai/src/parsers/docx-parser.ts` (n) |
| F3 | Audio / video playback | Y | Y | Y | Y | - | Y | - | - | Y | ? | ? | CE `src/workspace/viewers/MediaViewer.tsx`; OL `nodes/Video.tsx` (n); MA `nodes/VideoNode.ts` (n) |

### Organization (folders, collections, tags, favorites, journals, templates, recents)

| # | Feature | Cerebro | AFFiNE | Outline | Tolaria | Plane | AppFlowy | n8n | Activepieces | Macro | Morrow | Thought Desk | Key evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| O1 | Folders on disk | Y | - | - | Y | - | - | - | - | - | ~ | - | AF uses virtual folders (AFN4 avoid); TO `FolderTree.tsx` (n); MO import keeps the folder tree, `core/importer.ts:49` (r) |
| O2 | Tags | ~ | Y | - | Y | Y | - | Y | ? | Y | Y | Y | CE has multi-select fields but no tag UI (G0); AF `modules/tag`; TO `TagsDropdown.tsx`; MO `TagsView.tsx`; TD `TagView.svelte`; N8 workflow tags (n) |
| O3 | Favorites + recents | Y | Y | Y | ~ | Y | Y | ~ | ? | Y | ~ | ? | CE Pages shelves; MA `crates/{favorites,frecency}` (n); N8 `modules/favorites` (n) |
| O4 | Daily notes / journal | - | Y | - | - | - | - | - | - | ? | Y | - | AF `modules/journal` (AFN4-11); MO `src/core/daily.ts:4-25` (r); TO removed its daily note, `hooks/useCommandRegistry.test.ts:734-737` (r) |
| O5 | Default template per type / database | - | ~ | ~ | Y | ? | ? | - | - | ? | ? | Y | TO the type entry's `template`, `hooks/useNoteCreation.ts:109-117` (r); TD `lib/db/TemplatesPanel.svelte:4-5` "made the default" (r); AF one workspace-wide page template and one journal template, not per database, `modules/template-doc/type.ts:2-4` (r); CE picks a template per page, from the blank-page bar (`src/app/applyPageTemplate.ts`) or the Folders New page dialog (`src/components/FileTree.tsx:901-909`) (r); no per-Type default |
| O6 | Inbox / capture queue | Y | - | - | Y | Y | - | ~ | - | Y | Y | Y | TO `site/concepts/inbox.md` (d); PL intake (n); MA `features/inbox` (n); MO `CaptureDialog.tsx` (n); TD `lib/sheets/CaptureSheet.svelte` (n) |
| O7 | Saved filters / rule-based collections | ~ | Y | - | Y | Y | - | - | - | Y | ? | ? | AF collection rules (AFN4-07); TO views.yml ADR (d); MA `crates/saved_views` (n); CE Lists over one Type, Collections query-free (M10/M47) |

### Navigation and search (quick open, full text, filters, backlinks, graph, peek)

| # | Feature | Cerebro | AFFiNE | Outline | Tolaria | Plane | AppFlowy | n8n | Activepieces | Macro | Morrow | Thought Desk | Key evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| N1 | Full-text search (+ ⌘K quick open) | Y | Y | Y | Y | Y | Y | ~ | ~ | Y | Y | Y | CE BM25, index-free, `src-tauri/src/search.rs`; N8/AP search names only |
| N2 | Accent- / normalization-insensitive matching | - | ? | ~ | ~ | ? | ? | ? | ? | ? | Y | ? | CE lowercases only, `search.rs:217-222` (r); MO folds its full-text search, `src/core/search.ts:26-28` (r); OL folds in-page find (`app/editor/extensions/deburrWithMap.ts`) and name filters, but document search is `to_tsquery('english')` with no `unaccent`, `plugins/search-postgres/server/PostgresSearchProvider.ts:650-651` (r); TO folds name search, `src/hooks/useNoteSearch.ts:78`, while body search only lowercases, `src-tauri/src/search.rs:177,189` (r) |
| N3 | Semantic / vector search | P M97.8 (cond.) | Y | - | - | - | Y | Y | Y | Y | - | - | AY `rust-lib/flowy-sqlite-vec` (n); AP `server/api/src/app/knowledge-base` (n); MA `crates/embedding` (n) |
| N4 | Exact-passage landing + Return to results | Y† | ~ | ~ | ? | ? | ? | - | - | ~ | ? | ? | CE `src/app/sourceOpen.ts`, `src/editor/sourceReveal.ts` (r, M97.2 in progress); AF/OL land on the passage with no Return (AFN4-22, OUT4-11) |
| N5 | Backlinks | Y | Y | Y | Y | - | - | - | - | ? | Y | Y | TO `inspector/BacklinksPanel.tsx` (n); MO `core/links.ts` (n) |
| N6 | Unlinked mention discovery | Y† | - | - | ? | - | - | - | - | ? | Y | - | CE `src-tauri/src/source_occurrences.rs` (r, M97.5); MO `core/links.ts:86` `unlinkedMentions` (r) |
| N7 | Graph view / neighbourhood | ~ | - | - | ~ | - | - | - | - | - | Y | - | MO `components/GraphView.tsx` (n); TO neighbourhood list (TOL-17); CE contextual lists, graph deferred (MR-10) |
| N8 | Side-by-side panes | Y | Y | Y | - | - | - | - | - | Y | - | Y | CE up to 4 panes, one editor per file (CV-52); OL `app/utils/splitView.ts` primary/secondary (r); TO uses separate windows; TD `SplitPane.svelte` (n) |
| N9 | Create a page from a search miss / dangling link | ~ | Y | ? | ? | ? | ? | - | - | ? | Y | ? | AF `quicksearch/impls/creation.ts:20-50` (r); MO `editor/PageLink.ts:135-141` (r); CE creates only from the `[[`/`@` menu's Create row, `src/editor/MarkdownEditor.tsx:1141-1150`, and `src/editor/chips.tsx:106` returns on a null target (r) |
| N10 | Mouse Back/Forward buttons | - | ? | ? | ? | ? | ? | ? | ? | ? | ? | Y | TD `src/App.svelte`, mouse buttons 3/4 (r); CE G0 |

### History, versions, trash, undo

| # | Feature | Cerebro | AFFiNE | Outline | Tolaria | Plane | AppFlowy | n8n | Activepieces | Macro | Morrow | Thought Desk | Key evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| H1 | Per-page versions + restore | Y | Y | Y | Y | Y | - | Y | Y | ? | Y | - | AF `components/affine/page-history-modal` (n); PL page versions (PLN-21); MO `HistoryDialog.tsx` (n); N8/AP workflow versions (N8N-09, APC-13) |
| H2 | Compare to any version / since last opened | ~ | ? | Y | ? | ? | - | Y | ? | ? | ? | - | CE's version lens reads a commit and its parent only (`src/git/useGit.ts:411-426`), though `ProseDiffView` diffs any before/after (`src/git/ProseDiffView.tsx:116-130`) (r); OL `History/HighlightChangesControl.tsx:18-43` (r); N8 `workflow/src/workflow-diff.ts` (N8N-09) |
| H3 | Git commits + remotes | Y | - | - | Y | - | - | ~ | ~ | - | - | - | TO git-first (README, d); N8 `source-control.ee` and AP git-sync are EE (n) |
| H4 | Trash with restore | Y | Y | Y | - | ~ | Y | ~ | ? | ? | Y | Y | TO deletes permanently, ADR 0045 (r); AY `plugins/trash` (n); TD `TrashModal.svelte` (n) |
| H5 | Trashed page opens with Restore in place | - | Y | Y | - | ? | Y | - | - | ? | Y | ? | CE: M93's `DeletedDraftRecovery` shows a retained draft, else "Go home" only, with no Trash lookup, `src/pages/DocPage.tsx:335-352` (r); AF read-only while in Trash, `detail-page-wrapper.tsx:48-53` (r); OL `Document/components/Notices.tsx` (r); AY `document/presentation/banner.dart:14-70` (r); MO `components/PageView.tsx:127-143` (r) |

> **2026-10-27 (Codex cross-check, CX-AFY-11):** DocPage's Go-home face is now `src/pages/DocPage.tsx:344-348`. The claim stands.

| # | Feature | Cerebro | AFFiNE | Outline | Tolaria | Plane | AppFlowy | n8n | Activepieces | Macro | Morrow | Thought Desk | Key evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| H6 | Undo of database-wide batches | Y | ? | ? | ? | ? | ? | - | - | Y | ? | ? | CE `src-tauri/src/vault/batch.rs` (CV-38/39); MA journals each batch with its inverse and guards undo against later edits, `crates/databases/src/domain/journal.rs:1-4`, `service/undo.rs:1-2` (r) |
| H7 | Outside-edit reconciliation | Y | ~ | - | Y | - | - | - | - | - | ~ | - | TO `ConflictResolverModal.tsx` (n); AF canary disk peer (AFN1-09); MO keeps conflict copies, `src/core/sync.ts` (r) |
| H8 | Automatic snapshots / displaced-byte journal | Y† | ~ | - | - | - | - | - | - | - | Y | - | CE opt-in journal (M93.9); MO rolling backups (MOR-05); AF workspace export (AFN1-02) |

### Comments, mentions, reactions

| # | Feature | Cerebro | AFFiNE | Outline | Tolaria | Plane | AppFlowy | n8n | Activepieces | Macro | Morrow | Thought Desk | Key evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| C1 | Anchored comment threads | Y | Y | Y | - | Y | - | - | - | Y | - | - | CE sidecar (CV-31); AF `modules/comment` (n, cloud); MA `nodes/CommentNode.ts` (n) |
| C2 | Comments on images / blocks | - | ? | Y | - | ? | - | - | - | Y | - | - | OL `CommentedImagePlugin.ts` (OUT2-11); MA `ThreadAnchor` covers PDF highlights and points, sheet ranges and design-layer pins, `crates/messages/src/domain/models.rs:126-179` (r); CE anchors to text only |
| C3 | @mention people | Y | Y | Y | - | Y | ? | - | - | Y | - | - | MA `nodes/UserMentionNode.ts` (n) |
| C4 | Reactions + notification inbox | - | ~ | Y | - | Y | ~ | - | - | Y | - | - | CE Home is pull-only by design (M64.4); OL `app/stores/NotificationsStore.ts` (n) |
| C5 | @agent in a thread starts an agent turn | Y | - | - | - | - | - | - | - | Y | - | - | CE `src-tauri/src/agent/thread_turn.rs` (CV-36); MA channel bots: an @-mention triggers that bot, bot posts never trigger, and a classifier may infer a follow-up, `crates/channel_bots/src/domain/trigger_detector.rs:14-25` (r) |

### Import, export, backup, interchange (OKF)

| # | Feature | Cerebro | AFFiNE | Outline | Tolaria | Plane | AppFlowy | n8n | Activepieces | Macro | Morrow | Thought Desk | Key evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| I1 | Markdown / Obsidian vault adoption | Y | Y | ~ | Y | - | ~ | - | - | ? | Y | - | AF `linked-doc/src/transformers/obsidian.ts` (n); MO `core/importer.ts:49` (r) |
| I2 | Notion import | ~ | Y | Y | - | - | ? | - | - | Y | Y | - | CE one page at a time from a connector capture (CV-60); OL `plugins/notion` flattens databases (OUT5-18); MO export zip, `core/importer.ts:22,124`, nested zips `src/app/operations.ts:475` (r); MA `crates/import` (n) |
| I3 | CSV / XLSX / ICS import–export | Y | ? | - | ~ | ~ | ~ | ~ | ~ | ? | ~ | Y | TD `lib/ics-import.svelte.ts`, CSV drop (n); PL exporter (n) |
| I4 | Page export: PDF / print / HTML | - | Y | Y | Y | Y | ? | - | - | ~ | Y | Y | AF `hooks/affine/use-export-page.ts:37-42` (r); OL `actions/definitions/documents.tsx:800,1171` (r); TO ADR macos-webview-pdf-export (r); MO `electron/main.cts:378` and static site `core/site.ts:1` (r); TD `src-tauri/src/pdf.rs` (TDK-16); CE has no page export, only PNG/SVG/CSV/XLSX doors through a save dialog, `src-tauri/src/lib.rs:2684-2768` (r) |

> **2026-10-27 (Codex cross-check, CX-XCUT-07):** Outline "Y" overstates: community Outline throws `IncorrectEditionError` for PDF ("PDF export is not available in the community edition", `OL/server/routes/api/documents/documents.ts:995-998`; `revisions.ts:169-172`), and the menu shows it only with `env.PDF_EXPORT_ENABLED` (`OL/app/actions/definitions/documents.tsx:808-813`). Print and HTML/Markdown downloads are real. Read OL as "~ print + HTML/MD; PDF is EE".

| # | Feature | Cerebro | AFFiNE | Outline | Tolaria | Plane | AppFlowy | n8n | Activepieces | Macro | Morrow | Thought Desk | Key evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| I5 | Workspace backup / restore | ~ P M99.8 | Y | Y | ~ | ~ | ? | ~ | ? | ? | Y | ~ | CE git today, M99.8 planned; AF `.affine` export (AFN1-02); MO `core/portability.ts:14` (r) |

> **2026-10-27 (Codex cross-check, status-drift S19; CX-XCUT-05):** "P M99.8" is stale: a portable backup/check/restore bundle is built, unaccepted (`src-tauri/src/workspace_migration/{backup,restore}.rs`; `src/workspace/WorkspaceBackupSettings.tsx`). Keep `~`; read the note as "git + portable bundle (unaccepted)".

| # | Feature | Cerebro | AFFiNE | Outline | Tolaria | Plane | AppFlowy | n8n | Activepieces | Macro | Morrow | Thought Desk | Key evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| I6 | OKF bundle interchange | ~ | - | Y | - | - | - | - | - | - | - | - | OL `server/models/helpers/OKFHelper.ts` (OUT5-19); CE `knowledge/` is an OKF v0.2 bundle with no exporter |
| I7 | Web clipper / page capture | ~ | Y | - | ? | - | - | - | - | ? | - | - | AF `modules/import-clipper` (n); CE agent `cache_source` (`shared/policy/tools.v1.json:2162`, r) |

### AI chat

| # | Feature | Cerebro | AFFiNE | Outline | Tolaria | Plane | AppFlowy | n8n | Activepieces | Macro | Morrow | Thought Desk | Key evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A1 | In-app AI chat | Y | Y | - | Y | - | Y | Y | Y | Y | - | - | OL has no in-app model (OUT5-01); PL has editor tasks only, `web/services/ai.service.ts` (r) |
| A2 | Runs the user's own CLI agent, no API key | Y | - | - | Y | - | - | - | - | ~ | - | - | TO CLI adapters, `src-tauri/src/{claude_cli,codex_cli}.rs` (n); MA cloud agent connections (n) |
| A3 | Hosted / BYOK / local model | - | Y | - | Y | ~ | Y | Y | Y | Y | - | - | PL server OpenAI key, `api/plane/app/views/external/base.py:10,148` (r); TO `src-tauri/src/ai_models.rs` (n) |
| A4 | Durable chat history + search / export | P M95.2–3 | Y | - | ~ | - | Y | Y | ? | Y | - | - | CE plans `conversation_search` and `export_thread` (d) |

> **2026-10-27 (Codex cross-check, CX-XCUT-05; status-drift S12):** Built, not enabled: the opt-in archive (`src-tauri/src/conversations/{rows,export,transport}.rs`; `rows.rs` is SELECT-only with cursor pages), approved 2026-10-26 (`specs/2026-10-23-m95-conversation-retention-decision.md:70-74`); current vault Off. Search rows are written per turn (`runtime/conversations.rs:160`) but have no reader or UI yet (grep).

| # | Feature | Cerebro | AFFiNE | Outline | Tolaria | Plane | AppFlowy | n8n | Activepieces | Macro | Morrow | Thought Desk | Key evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A5 | Citations from tool results | Y | Y | - | ? | - | Y | ? | ? | Y | - | - | AFN5-08; prior Macro 2 and AF-03 (d) |
| A6 | Tool-call approval cards | Y | - | - | ~ | - | ? | Y | Y | ? | - | - | N8 ApprovalCard (N8N-15); TO permission-mode ADR (d) |
| A7 | Subagent / delegated-task visibility | Y | - | - | ? | - | - | Y | Y | Y | - | - | MA subagent fold (prior Macro 3, d); AP agent tasks, EE (APC-18) |
| A8 | Save or insert an answer into a page | Y† | Y | - | ? | - | Y | - | - | ? | - | - | CE `src/agent/artifacts.ts` (r); AF landings (AFN5-03) |

### AI actions on content

| # | Feature | Cerebro | AFFiNE | Outline | Tolaria | Plane | AppFlowy | n8n | Activepieces | Macro | Morrow | Thought Desk | Key evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| X1 | Ask AI on a selection (reviewed rewrite) | Y | Y | - | ? | ~ | Y | - | - | ? | - | - | PL rephrase/grammar endpoint, `ai.service.ts:42` (r); AY AI writer (AFY-15) |
| X2 | AI inside a page / DB / sheet | Y | ~ | - | - | ~ | Y | - | - | ? | - | - | CE `:::ai` block, SheetAsk, view suggestions; AY Summary/Translate field types, `field_entities.rs:440-441` (r) |
| X3 | AI on canvas (mindmap, slides) | - | Y | - | - | - | - | - | - | ? | - | - | AFN5-23 |
| X4 | Transcription / meeting notes | - | Y | - | - | - | ? | - | - | Y | - | - | AFN5-18; MA `features/{dictation,meetings}` (n) |
| X5 | Agent-written, human-verified knowledge | Y | - | - | - | - | - | - | - | - | - | - | CE CV-07; N8/AP knowledge is unverified RAG files (n) |

### Agents, schedules and automation

| # | Feature | Cerebro | AFFiNE | Outline | Tolaria | Plane | AppFlowy | n8n | Activepieces | Macro | Morrow | Thought Desk | Key evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| G1 | Agent as an editable page / record | Y | - | - | - | - | - | Y | Y | Y | - | - | N8 `cli/src/modules/agents`, drafts + publish (n); MA `crates/bots` (n) |
| G2 | Agent memory + skills | Y | - | ~ | - | - | - | Y | ~ | Y | - | - | OL serves skills over MCP to outside agents (OUT5-07); MA `crates/{memory,skills}` (n) |
| G3 | Scheduled runs | Y | - | - | - | ~ | - | Y | Y | Y | - | - | PL monthly auto-archive/close (n); MA `crates/routines` (n) |
| G4 | Record-change triggers | Y | - | - | - | ~ | - | Y | Y | Y | - | Y | TD `lib/db/AutomationsPanel.svelte:20-27` (r) |
| G5 | Deterministic record rules (no model) | P M98.8 | - | - | - | ~ | - | Y | Y | ? | - | Y | TD "when Status becomes Done, set …" (r) |
| G6 | Workflow builder | P M98.9 | - | - | - | - | - | Y | Y | ~ | - | - | N8/AP canvas builders; CE plans a step list |

> **2026-10-27 (Codex cross-check, status-drift S7; CX-XCUT-05):** A step-list editor exists, unaccepted: `src/library/WorkflowLibrary.tsx` (raw JSON fields, Move up/down), `WorkflowRunPanel.tsx`, `WorkflowSchedulePanel.tsx`. Read Cerebro as `~`, not "P M98.9".

| # | Feature | Cerebro | AFFiNE | Outline | Tolaria | Plane | AppFlowy | n8n | Activepieces | Macro | Morrow | Thought Desk | Key evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| G7 | Run history with transcripts | Y | - | - | ~ | - | - | Y | Y | Y | - | - | MA routine history (prior Macro 1, d) |
| G8 | Human approval gates in runs | Y | - | - | ~ | - | - | Y | Y | ? | - | - | CE ask-first (CV-32); N8 HITL (N8N-20) |
| G9 | Durable waits / resume | P M98.3 | - | - | - | - | - | Y | Y | ? | - | - | AP `server/api/src/app/waitpoints` (n) |

> **2026-10-27 (Codex cross-check, CX-XCUT-05):** Built, not enabled: Timer and ExternalInput waits (`src-tauri/src/workflows/definition.rs:73-74,334-337`) and `workflow_waits` incl. `person_approval` (`runtime/workflows.rs:424-442`); record: "active cancellation, timer ownership … pass" (implementation record:29). Read as built, not enabled or accepted.

| # | Feature | Cerebro | AFFiNE | Outline | Tolaria | Plane | AppFlowy | n8n | Activepieces | Macro | Morrow | Thought Desk | Key evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| G10 | System-wide quick-capture hotkey | P M98.7 (owner) | - | - | - | - | - | - | - | ? | - | Y | TD `src-tauri/src/main.rs:52-69` (TDK-17) |

### Connectors, MCP, API, webhooks

| # | Feature | Cerebro | AFFiNE | Outline | Tolaria | Plane | AppFlowy | n8n | Activepieces | Macro | Morrow | Thought Desk | Key evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| K1 | Built-in MCP server | Y | Y | Y | Y | - | - | Y | Y | Y | - | - | AF `copilot/mcp`, EE (n); TO `mcp-server/index.js` (n); MA `crates/mcp_toolset` (n) |
| K2 | MCP client (external tool servers) | Y | - | - | ~ | - | Y | Y | Y | Y | - | - | CE CLI-owned `.cerebro/connectors.json`; AY `flowy-ai/src/mcp/manager.rs` (n) |
| K3 | Personal API tokens | Y | Y | Y | - | Y | - | Y | Y | Y | - | - | CE `src-tauri/src/runtime/client_tokens.rs`; MA `crates/user_api_key` (n) |
| K4 | Public REST/GraphQL API + OAuth apps | - | Y | Y | - | Y | - | Y | Y | Y | - | - | CE offers MCP over personal tokens only (CV-49); OL OAuth AS (OUT5-05) |
| K5 | Outbound webhooks | - | - | Y | - | Y | - | Y | Y | Y | - | - | OL `plugins/webhooks` (OUT5-16); MA `crates/webhook` (n) |
| K6 | Integration catalog + managed accounts | ~ P M96.2/5 | ~ | Y | - | Y | - | Y | Y | Y | - | - | AF calendar + Readwise, `modules/integration/entities` (r); CE CLI connectors, `forge.rs`, Gmail |

> **2026-10-27 (Codex cross-check, CX-XCUT-05; status-drift S11):** Built in part, macOS only, unaccepted: managed GitHub accounts (`src/app/ManagedAccountSettings.tsx`), native gh import with a platform store (`actions/native_account_commands.rs:52`, `connections/secrets.rs:55`, `connections/keychain.rs`), GitHub issue adapter (`actions/github_issues.rs`). `connections/{accounts,migration}` stay cfg(test) (`connections/mod.rs:2-11`).

| # | Feature | Cerebro | AFFiNE | Outline | Tolaria | Plane | AppFlowy | n8n | Activepieces | Macro | Morrow | Thought Desk | Key evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| K7 | Link unfurl / rich link cards | ~ | Y | Y | - | ~ | Y | - | - | Y | - | - | OL `routes/api/urls/urls.ts` (OUT5-13); MA `crates/unfurl` (n); CE GitHub PR state only, `forge.rs` |
| K8 | Mail (read, draft) | Y | - | - | - | - | - | ~ | ~ | Y | - | - | CE drafts only (CV-62); MA full email client (n) |

### Settings, themes, accessibility, i18n

| # | Feature | Cerebro | AFFiNE | Outline | Tolaria | Plane | AppFlowy | n8n | Activepieces | Macro | Morrow | Thought Desk | Key evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| T1 | Custom themes / accents | - | Y | Y | - | Y | Y | ? | ~ | Y | Y | Y | AFN3-16, OUT3-13, PLN-07, MAC-11, TDK-23; TO keeps an app-owned light/dark only (TOL-18) |
| T2 | High-contrast theme | - | - | - | - | Y | - | - | - | - | - | - | PL `constants/src/themes.ts` (PLN-07) |
| T3 | Reading preferences (font, size) | - | Y | ? | ? | Y | Y | - | - | ? | Y | Y | AF `modules/editor-setting/schema.ts` (AFN3); PLN-15 |
| T4 | Shortcut rebinding | - | ? | - | - | ? | Y | - | - | ? | - | Y | AY `settings/shortcuts/settings_shortcuts_cubit.dart` (n); TD `ShortcutsEditor.svelte` (n); CE read-only catalog |
| T5 | i18n / RTL | - | Y | Y | Y | Y | Y | Y | Y | - | - | - | TO `src/lib/locales/*.json` and RTL test (r, prior T8) |
| T6 | Reduced motion honoured | Y | ~ | ~ | - | ~ | - | Y | ~ | Y | Y | Y | CE motion tokens collapse; AF honours it in 2 files (AFN3); TO none (TOL) |
| T7 | In-app help + starter content | Y | Y | Y | Y | ? | ? | ~ | ~ | Y | Y | ~ | CE offered kit, plus Product help† (M93.10); AF/OL/MO seed content without asking (AFN4-21, OUT4-20) |

### Platform (desktop shell, native menu, zoom, mobile, offline, deep links)

| # | Feature | Cerebro | AFFiNE | Outline | Tolaria | Plane | AppFlowy | n8n | Activepieces | Macro | Morrow | Thought Desk | Key evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| L1 | Desktop app (+ deep links) | Y | Y | - | Y | - | Y | - | - | Y | Y | Y | MA `apps/web/tauri` (n); TD Windows only; CE `src-tauri/src/shell/deep_link.rs` |
| L2 | Mobile app | - | Y | ~ | ~ | ? | Y | - | - | ~ | - | - | TO iPad ADR, active (d) |
| L3 | Local-first / offline | Y | Y | - | Y | - | Y | ~ | ~ | - | Y | Y | n8n and Activepieces self-host only |
| L4 | Real-time multi-user collaboration | - | Y | Y | - | Y | Y | ~ | ? | Y | - | - | CE is single-user by design |
| L5 | Multi-device sync | ~ | Y | Y | Y | Y | Y | Y | Y | Y | Y | ~ | CE git remotes; MO manifest sync, `core/sync.ts:1` (r) |
| L6 | Native menu bar with app commands | ~ | Y | - | Y | - | ? | - | - | ? | Y | - | CE system items only, `src-tauri/src/shell/quit.rs:240-318` (r); TOL-06, MOR-09 |
| L7 | App zoom | - | Y | - | Y | - | ? | - | - | ? | Y | ? | AF `application-menu/create.ts:170-175` (r); MO `electron/main.cts:253-258` (r); pinned Tauri 2.12.4 has `set_zoom`, `webview/mod.rs:2354` (r) |
| L8 | Window frame + theme restore | - | Y | - | Y | - | ? | - | - | ? | Y | Y | TD `src-tauri/Cargo.toml:16` window-state (r); MOR-10 |
| L9 | Single instance per vault | ~ | Y | - | Y | - | ? | - | - | ? | Y | Y | CE only store flocks: the ledger's, `src-tauri/src/ledger/writer.rs:993-1008`, and (staged) the app-wide recovery journal's `owner.lock`, `src-tauri/src/vault/recovery.rs:145-165`, plus per-operation M96/M99 locks (`runtime/action_invocations.rs:258`, `workspace_service/selected_store.rs:185`); vault path locks are one in-process table, `src-tauri/src/vault/write.rs:401-404` (r); none focuses the window; AF `electron/src/main/index.ts:81`, TO `src-tauri/src/lib.rs:103-110`, MO `electron/main.cts:98`, TD `main.rs:39` (r) |

> **2026-10-27 (Codex cross-check, CX-TOL-08):** Tolaria's `lib.rs:103-110` shows both halves: the default launch takes the single-instance plugin, but `--tolaria-vault-instance` skips it for a designed per-vault second process (`TO src-tauri/src/vault_instance.rs:5,60`). Cerebro rejects a per-vault bypass (runtime.db, ledger and app data are per installation).

| # | Feature | Cerebro | AFFiNE | Outline | Tolaria | Plane | AppFlowy | n8n | Activepieces | Macro | Morrow | Thought Desk | Key evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| L10 | Auto-update | - | Y | - | Y | - | Y | - | - | Y | - | - | TO `tauri-plugin-updater`, `Cargo.toml:37` (r); CE has only `tauri-plugin-dialog` (r) |
| L11 | Render-fault containment | - | Y | Y | Y | Y | ~ | ~ | Y | Y | Y | ? | CE G0 for boundary names, `src/main.tsx:15` (r); AFN4-01, OUT3-06, TOL-01, PLN-02, APC-14, MOR-04; MA `features/home/home-section-boundary.tsx` (n) |

**Cerebro tally:** Y 60 · Y† 5 · ~ 16 · P 7 · - 32 (of the 32, 12 by design).

## Gaps worth closing, ranked by user value x fit (files-first, single user, local, CLI agent)

| # | Feature | Proven by | Fit | Proposed phase | Effort | Priority |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Render-fault containment | AF, OL, TO, PL, AP, MA, MO (+AY, N8 partial) | High: save owners outlive views (M93.1); fallback `unavailable` + Retry; no reload | M93.new-render-containment | M | P0 |
| 2 | Trashed page opens with Restore + Back | AF, OL, AY, MO | High: `listTrash`/`restoreFromTrash` exist (`src/app/trashActions.ts`); CV-37 refuses an overwrite, so Restore as… is a new human door (CV-33) whose new stem needs CV-41 re-pointing; Back without an origin reset is already UX-06 | M94.5 (amend) | S–M | P1 |
| 3 | Single instance per vault | AF, TO, MO, TD | High: CV-21 path locks work in-process only; the ledger flock covers only the ledger | M93.new-single-instance | S | P1 |
| 4 | Page export: PDF / print / HTML | AF, OL, TO, PL, MO, TD | High: output leaves through a save dialog and the vault is untouched; Tolaria uses the same Tauri/WebKit | M94.new-page-export | S–M | P1 (owner) |
| 5 | Compare to any version / since last opened | OL, N8 (AF, TO, PL, MO, AP have version history) | High: agents edit in the background; git and ProseDiffView exist; the base is session state | M94.new-history-compare | M | P1 |
| 6 | "Changed since you last opened" meta line | OL | High: attribution and the open log exist; quiet marks, no counts (M64.4) | M94.new-changed-since (after M94.3 acceptance) | M | P1 (owner) |
| 7 | App zoom + menu bar generated from command rows | AF, TO, MO | High: M94.9 requires real 200% zoom, which the packaged app cannot apply today; the pinned Tauri has `set_zoom`; the menu is built from the CV-47 command catalog, not a second typed list | M94.new-native-shell | M | P1 |
| 8 | Create a page from a search miss / dangling link | AF, MO | High: M94.4 drafts write nothing until Create | M94.4, M94.5 (amend) | S | P1 |
| 9 | Records seeded from view filters; per-column board paging | AF, TD / TD | High: a pure seed function; band and host still win; paging is M93.7's "explicit paging" candidate, held to REL-08 find and access | M94.6; M93.6/M93.7 (amend) | S | P1 |
| 10 | Bulk select + actions on Pages | AF, OL, TO, TD | High: `src/engine/bulkPlan.ts` plans one batch (CV-38/39); moves go through `renameActions` (CV-41) | M94.new-pages-bulk (after M94.3 acceptance) | M | P1 |
| 11 | Automatic rolling snapshots of app-private stores | MO (+AF export) | High: the git-ignored `.cerebro/ledger` is outside git's safety net today, and `workspace.db` (app config `workspaces/<id>/`) will be once M99 activates | M99.8 (amend) | M | P1 |
| 12 | Reload / context-menu hardening | TD | High: a reload drops M93.1 retained drafts and M94.4 session drafts | M93.2, M93.11 (amend) | S | P0 |
| 13 | Math | AF, OL, TO, AY, MA, MO, TD | Medium: native Markdown syntax; Tolaria round-trips it through placeholders on the same BlockNote; needs CV-24 cases | M94.new-math-carrier | M | P2 (owner) |
| 14 | Window frame + theme restore, hidden until painted | AF, TO, MO, TD | High: an official plugin, no vault state | M94.new-native-shell | S | P2 |
| 15 | Default template per Type | TO, TD (AF: one workspace-wide default) | High: the Type doc names a template, and the M94.4 recipe pins its bytes | M94.new-default-template | S | P2 (owner) |
| 16 | Tags + saved Pages filters | tags: AF, TO, PL, N8, MA, MO, TD; filters: AF, TO, PL, MA | Medium: tags as a field kind (CV-08); renames as batches; Collections stay query-free, and M47 D9 declined database-less saved queries on disk | M94.new-tags-filters | M | P2 (owner) |
| 17 | Word count / reading time | OL, TO, AY, TD | High fit, low value | M94.5 (amend) | S | P2 |
| 18 | Read-only page embed | MO (AF's is editable) | Medium: read-only keeps CV-52; needs a carrier | M94.new-page-embed | M | P2 (owner) |
| 19 | Daily journal recipe | AF, MO (TO removed it) | Medium: a creation recipe, not a trigger | M94.new-journal | S | P2 (owner) |
| 20 | Archive state / page lock | OL, PL, TO, N8 / PL, AY | Medium: Rust doors refuse writes to a locked page under a policy code | M94.new-archive-lock | M | P2 (owner) |

## Gaps to skip, and why

| Feature | Who has it | Why skip (re-entry condition) |
| --- | --- | --- |
| Multiplayer, presence, reactions, notification inbox, public share links | AF, OL, PL, AY, MA | Single user; one writer per file (CV-21); Home is pull-only (M64.4); needs a server |
| Hosted models, BYOK, plan quotas | AF, TO, PL, AY, N8, AP, MA | No API key in the app; the CLI owns the model (M96). Re-enter only through M96.8's conditional backend |
| Public REST/GraphQL API, OAuth apps, outbound webhooks | AF, OL, PL, N8, AP, MA | No server; MCP over personal tokens is the API (CV-49); M98 refuses public webhooks. Watch OAuth only for a client that cannot send a bearer (OUT5-05) |
| Semantic / vector search now | AF, AY, N8, AP, MA | Search is index-free and lexical by decision; M97.8 is conditional on labelled misses and a local model |
| Theme and accent editors | AF, OL, PL, AY, MA, MO, TD | Cortex/synapse identity (UX-01) plus AA gates; Tolaria removed vault themes (TOL-18). Keep only FEAT-27's contrast variant |
| i18n catalogs, RTL | AF, OL, TO, PL, AY, N8, AP | Single-user, English; RTL editor correctness stays a watch (prior T8) |
| Web iframes / embeds | AF, OL, AY | CSP `default-src 'self'`; CV-16 and CV-61; page cards cover internal embeds |
| Graph view | MO (TO chose a list) | Deferred (MR-10): contextual lists come first, and visual proximity is not evidence |
| Flashcards / spaced repetition | MO, TD | Deferred (TD 9): recall is a different contract from verified knowledge |
| AI on canvas (mindmap, slides); transcription | AF, MA | The CLI has no audio path; canvas AI waits on M68 edit caps (watch AFN5-23) |
| Node-canvas workflow editor | N8, AP | M98 chose a step list plus an inspector (M98.9) |
| Mobile and web apps | AF, AY, MA, OL, PL, N8, AP | macOS desktop only, 900×600 minimum |
| Auto-update | AF, TO, AY, MA | The owner builds and installs locally (`scripts/mac-build.sh`); revisit when distributing builds |
| Multiple windows / tabs | AF, TO, MO, AY | Four panes with one live editor per file (CV-52); one assistant instance (M92) |
| Editable synced blocks; database rows inside docs | AF | A second live editor (CV-52) or a second writer (CV-21) |

> **2026-10-27 (Codex cross-check, CX-AFE-10):** AFFiNE is not an example of editable synced blocks: its synced doc is read-only (`embed-synced-doc-block.ts:415-419`). Drop AF from the synced-blocks half; database rows inside docs stay.

| Feature | Who has it | Why skip (re-entry condition) |
| --- | --- | --- |
| Permanent delete; GC that deletes unused files | TO (ADR 0045), TD | CV-37: nothing is hard-deleted |
| Auto-seeded showcase content | AF, OL, MO | Cerebro's offered, create-only starter kit (M64.8) is better |
| Password-protected (encrypted) pages | MO (`src/core/crypto.ts:1`, `components/EncryptDialog.tsx`) | FileVault covers the disk; agents need plaintext reads; key recovery is a burden |
| Custom CSS loaded from the vault | MO | It could restyle approval cards (CV-28/32): never |
| HTML blocks with scripts | TO | CV-16 and CV-61 risk; Studio already previews prototypes |

## Cerebro-only strengths

| Strength | Mechanism (enforcer) | Nearest reference |
| --- | --- | --- |
| Agent-written, human-verified knowledge | `write_concept`/`verify_concept` doors; Verify is human-only (CV-07) | n8n/Activepieces knowledge is unverified RAG files |
| An @agent mention in a page's comment thread starts a supervised turn | `start_thread_turn`, only from a person's comment (CV-36) | Macro channel bots: an @-mention triggers that bot and bot posts never trigger, but a classifier may infer follow-ups (`crates/channel_bots/src/domain/trigger_detector.rs:14-25`); CV-36 infers nothing |
| Ask-first writes wait for a person's Allow; one approval table decides CLI tools | CV-28/29/32 | n8n pre-highlights a session-wide allow (N8N-15, avoid) |
| Every write carries a receipt; attribution comes only from records; a run commit holds only the run's paths | CV-33/34/35 | AFFiNE back-fills authorship from the current editor (AFN2-17, avoid) |
| Every offered block survives a Markdown save | CV-24 walk; `KNOWN_LOSSY` empty | Tolaria has per-feature durable carriers; AFFiNE and Outline export lossily |
| Absent ≠ zero, unavailable ≠ empty, five lab states | CV-05/44 | Outline and Activepieces lists fall back to "empty" on error (OUT3, APC-05) |
| Journaled database-wide batches; undo restores only what still stands | CV-38/39 | Macro journals each database batch with its inverse and guards undo against later edits (`crates/databases/src/domain/journal.rs:1-4`, `service/undo.rs:1-2`); Cerebro adds multi-file staging with rollback on the next start |
| 10 view kinds plus relation/rollup/formula/item keys over Markdown records | `views.v1.json`, `field-kinds.v1.json` | Morrow (Markdown frontmatter; 5 views; relation and formula, no rollup: `src/core/vault/pageFile.ts:9-10,100-106`, `src/core/model.ts:77`), Thought Desk (SQLite), Plane (fixed schema) |
| Structural Mermaid editor | `src/mermaid/flowchart/StructuralEditor.tsx` | the others render code fences |
| Exact-passage reveal plus Return to results | M97.1/M97.2 locators | AFFiNE and Outline land with no way back |
| Conversation rail (Plan, Subagents, Changes, Handoffs, Context, Sources, Connectors, Environment) with a context meter | `src/agent/rail/`, ContextBook (M91–M92) | Macro's subagent fold |
| Remote content waits for a click; mail is drafts only | CV-61, CV-62 | Outline and AFFiNE load iframes; Macro sends mail |
| Mounted repositories workspace (code, PDF and Office viewers) | `src/workspace/` | none |
| Displaced-byte recovery journal | M93.9 (opt-in) | Morrow snapshots only app data |

Already convergent with the field: JSON Canvas (MO), first-H1 title (TO), git-first history with a day-grouped commit feed (TO `PulseView.tsx`, which has no heatmap), CLI agents (TO), Inbox capture (TO, PL, MA, MO, TD), offered starter vault (TO), formula sheets in Markdown (TO; Macro's sheets are native Loro documents, `features/block-spreadsheet/README.md:3,27`), split panes with one live view per entity (MA `apps/web/src/lib/split-router/solid/use-claim.ts:5-9`, "Content already open" `features/next-soup/utils.ts:664-665`: the model CV-52 adapted; Cerebro caps at four panes, Macro by a 400 px minimum).

## Recommendations

| ID | Change | Phase | Priority | Effort | Evidence | From |
| --- | --- | --- | --- | --- | --- | --- |
| FEAT-01 | Re-implement containment. Boundaries go around each pane, the record peek, the side-panel slot, the assistant body, each rail card, each Home lane and each lab section, plus a root `createRoot({onUncaughtError, onCaughtError})`. A boundary runs `prepareOpenPages()`/`flushOpenPages()`, then shows `StateMessage unavailable` with Retry (key remount) and Copy details. It never reloads. At catch time the thrown subtree has already unmounted, so the flush reaches only M93.1's retained owners, and Retry must remount under the same owner key so `retainDocumentOwner` returns the retained draft (`src/editor/openPages.ts:401-421`). Flushing boundaries live in the app layer, so `components/ai/` stays presentation-only (CV-64). Move the quit listener out of React | M93.new-render-containment | P0 | M | CE G0, `src/main.tsx:15`, `src/app/quit.ts:248-249`, the only quit listener `src/lib/ipc.ts:1719-1724` (r); L11 row | AFN4-01, OUT3-06, TOL-01, PLN-02, APC-14, MOR-04 |
| FEAT-02 | Re-implement. Inside M93's `DeletedDraftRecovery` fallback (a retained draft still shows first), look up `listTrash` by path, including a trashed ancestor folder. Show the deleted and purge dates (`deletedAt` plus `KEEP_DAYS`; the purge runs at a later launch), with Restore, Back and Search. An occupied path offers Restore as…, a new human door (CV-33) that carries the comment sidecar (CV-31) and re-points inbound links (CV-41). A failed Trash read shows `unavailable`. After a delete, land on Back or the parent, not Home (`src/pages/DocPage.tsx:480` (r)). Back without an origin reset is already UX-06 (M94.5) | M94.5 | P1 | S–M | H5 row (5 files, r) | AFN4-06, OUT4-02/03/04, AFY-10, MOR-11 |
| FEAT-03 | Adopt `tauri-plugin-single-instance` 2.5.3 (Apache-2.0 OR MIT; a dependency) to focus the existing window; its callback only focuses and ignores the second process's argv (CV-50). On macOS it guards a bundle identifier, not a vault (`/tmp/<identifier>_si.sock`, plugin `src/platform_impl/macos.rs:61-72` (r)), and launches normally on other socket errors (`:39`, `:128`), so `tauri dev` needs its own identifier and the ledger flock stays the backstop. Or have a second process open read-only while the ledger flock is held. Add `open -n` and a second app copy to M93.11 | M93.new-single-instance | P1 | S | L9 row; CE `Cargo.toml` has no plugin; vault path locks are in-process, `src-tauri/src/vault/write.rs:401-404` (r) | this audit (MOR architecture note) |
| FEAT-04 | Re-implement page export: a print stylesheet plus `Webview::print()` (the macOS panel saves PDF), and HTML export through a native save dialog, as one more door beside `export_svg` (`src-tauri/src/lib.rs:2717`), serialized by the editor's `toExternalHTML`, whose images are already lazy and no-referrer (`src/editor/blocks.tsx:118-131`). Nothing is written to the vault, and only remote images already loaded print (CV-61). Owner call | M94.new-page-export | P1 | S–M | Tauri 2.12.4 `webview/mod.rs:1626` (r); I4 row | TDK-16, OUT4-24 |
| FEAT-05 | Re-implement history compare. The base can be Previous, any listed commit (`getFileAtCommit` exists), "When you last opened" or the working copy; add n-of-m change stepping. "Last opened" means the last commit before your previous open (the log's second time, `src/engine/openLog.ts:34-42`), labelled as that commit: edits not yet committed then were never recorded. The base is session state and is never written | M94.new-history-compare | P1 | M | H2 row | OUT4-07, OUT2-14 |
| FEAT-06 | Re-implement a quiet meta line under the title and on Pages rows, e.g. "Research agent changed this · 2 h · since you last opened". It is built from `attributionLine` (`src/engine/attribution.ts:72`, r) and the open log, names agents only from recorded writes (CV-33/35) and shows no counts. The log records at navigation for ⌘K ranking (`src/engine/openLog.ts:34-42`), so a 3 s dwell needs its own seen-mark; a page beyond the log's 200 pages reads "not recorded" (CV-05); Pages rows need a batched read, since `pageAttribution` reads one page (`src/lib/ipc.ts:1294`). Owner call: "nothing speaks first" | M94.new-changed-since (after M94.3 acceptance) | P1 | M | P3 row | OUT4-01 |
| FEAT-07 | Re-implement the native shell. App zoom through Tauri `set_zoom`, as ⌘=/⌘-/⌘0 keymap rows at app scope; the PDF and image viewers keep theirs (`src/app/commands/pdf.commands.ts:16-21`, `viewer.commands.ts:13`), so those chords get no menu accelerator. Build the menu bar from the CV-47 command catalog through an IPC adapter (CV-18), not a Rust-typed copy (a CV-04 twin), including Settings… ⌘,. Only menu-owned chords carry accelerators | M94.new-native-shell (proof in M94.9) | P1 | M | L6/L7 rows | TOL-06/08, MOR-09 |
| FEAT-08 | Adopt `tauri-plugin-window-state` 2.5.0 (Apache-2.0 OR MIT) to restore the frame, and re-implement the rest: keep the window hidden until it paints, and set the native theme and background from the resolved theme | M94.new-native-shell | P2 | S | L8 row | TDK-05, MOR-10 |
| FEAT-09 | Re-implement creation entry points. Quick Open gains a "New page '<query>'" row that seeds an M94.4 draft. Clicking an unresolved `[[link]]` opens creation, using the exact target (before any `#`) as the stem, or offers Restore if the target is trashed. Do not reuse `createLinkedPage` there: its slug stem (`src/app/listActions.ts:340-354`) leaves the link resolving by title, which an H1 edit breaks; a target that is no legal filename falls back to title resolution (CV-09). Nothing is written until Create | M94.4, M94.5 | P1 | S | N9 row; QuickOpen has no create row (G0) | AFN4-10, MOR-02 |
| FEAT-10 | Re-implement (AFFiNE's pure function is MIT and portable with notice, but port its shape, not its op table: it seeds every single-condition top-level property, ranges included, e.g. number `>` → +1 and date "before" → a day earlier, and never checks AND/OR, `data-view/src/core/filter/generate-default-values.ts:17-41`, `filter-fn/{number.ts:44,date.ts:21}`). A new record takes the view's single top-level AND equals/one-of filter values, close to the op set of Thought Desk's `#defaults` (`src/lib/databases.svelte.ts:838-847`); ranges, negation and OR seed nothing; band and host win. If the record is still hidden, toast "Created, hidden by this view's filters · Open". Seeds fill only a new draft's initial values: they never enter `creationDraftKey` (`src/engine/creationDestination.ts`) or overwrite a resumed M94.4 draft, and half-built rules seed nothing (`filterRuleIsReady`) | M94.6 | P1 | S | D10 row | AFN2-08, TDK-01 |
| FEAT-11 | Add board, gallery and list workloads to M93.6. If they miss the reviewed budget, extend M93.7's explicit-paging candidate to boards: 50 cards per column, then "Show more (N left)", reachable by keyboard, with REL-08's explicit find over every logical card | M93.6, M93.7 | P1 | S | D11 row | TDK-03 |
| FEAT-12 | Re-implement range select and a bulk bar on Pages/Collections that run human catalog actions as one batch: Move through `renameActions` (CV-41), Trash (CV-37), Favorite, Copy links; knowledge/ is refused (CV-07). It starts no agent or workflow run over the selection (M98 defers PL08) | M94.new-pages-bulk (after M94.3 acceptance) | P1 | M | D9 row | AFN4-08, OUT3-09 |
| FEAT-13 | Re-implement (Apache idea) automatic rolling snapshots of `workspace.db` plus ledger segments: changed-only, every N minutes and at quit, the newest N kept under a byte cap, stored outside the vault under M93.9's precedent (bounded, no mail bytes). The git-ignored ledger gains from this before activation. Make this an M99 activation gate | M99.8 | P1 | M | MO changed-only, `src/app/operations.ts:623-636`; every 10 min and at close, `src/app/App.tsx:25,96-98,126-127`; temp file then rename, newest 20 kept, no byte cap, `electron/main.cts:66,453-465`; format `src/core/portability.ts:14` (r) | MOR-05, AFN1-02 |
| FEAT-14 | Re-implement one document-level `contextmenu` policy: the native menu appears only in editable fields and in components with their own menu. Add reload to the M93.2 leave inventory, and add an M93.11 native case "right-click offers no Reload". P0: the M93.2 inventory is open now, and a Reload silently drops M93.1 retained drafts and M94.4 session drafts | M93.2, M93.11 | P0 | S | CE: no document-level policy; only `src/sheet/SheetGrid.tsx:695` adds a listener, and component menus use `onContextMenu` (Sidebar, FileTree, ContextMenu, RecordTabs, ViewTabs, TabBar, CollectionTree); no `beforeunload`/`pagehide` (r) | TDK-04 |
| FEAT-15 | Re-implement a math carrier: `$…$` and `$$` through the existing placeholder promote/demote, rendered with KaTeX, plus CV-24 cases. Port AFFiNE's dollar-currency test cases (MIT, with notice). Owner call | M94.new-math-carrier | P2 | M | S4 row | AFN2-22, OUT2-07 |
| FEAT-16 | Re-implement a default template per Type. The Type doc names a template path, the M94.4 recipe pins path, hash and bytes, and a missing template shows as a repair. A template rename re-points the Type doc's key in the same batch (`renameActions`, CV-41). This meets UX-05's precondition for template recipes (pinned identity, version and seed). Owner call | M94.new-default-template | P2 | S | O5 row | AFN4-12 |
| FEAT-17 | Re-implement: NFC-normalize the text before `tokenize` and `token_spans` split it, not each token after. A decomposed combining mark (U+0301) is not alphanumeric, so the split cuts decomposed "café" to `cafe` and "résumé" to `re`, `sume`. `token_spans` maps spans back to the original byte offsets. `unicode-normalization` 0.1 is already a dependency (`src-tauri/Cargo.toml:65`). Candidate expansion also tokenizes before its NFKC (`src-tauri/src/retrieval/mod.rs:105-129`), and its receipts are re-run and compared as sets, so bump `RETRIEVER_VERSION` ("a change to what expansion REACHES bumps this", `src-tauri/src/retrieval/mod.rs:40-46`). ~~Land it before M97.7's accent baseline.~~ Accent folding stays the measured M97.7 experiment | M97.7 | P1 | S | `src-tauri/src/search.rs:217-242` (r); Unicode Alphabetic skips U+0300–U+0344, `~/.cargo/registry/.../regex-syntax-0.8.11/src/unicode_tables/property_bool.rs:92-93` (r); N2 row | OUT2-15, prior MR-07/T9 |

> **2026-10-27 (Codex cross-check, CX-MTD-11):** Retarget: M97.8 shipped Latin accent aliases on 2026-10-26 (`src-tauri/src/search.rs:413` `latin_alias`; `specs/2026-10-26-m97-latin-accent-retrieval-experiment.md`), which keeps "a combining mark inside a decomposed word" as a documented limitation (:13-18). Make this the M97.8 follow-up for decomposed input only.

| ID | Change | Phase | Priority | Effort | Evidence | From |
| --- | --- | --- | --- | --- | --- | --- |
| FEAT-18 | Re-implement word count and reading time in Details (`src/detail/DocSidePanel.tsx`), derived and never stored; M94.3 stays the owner-compared composition | M94.5 | P2 | S | P2 row | this audit |
| FEAT-19 | Re-implement tags: a frontmatter `tags:` list as a field kind (no name routing, CV-08), a tag shelf/filter in Pages, and renames as one batch (CV-38/40). A new kind edits `shared/schema/field-kinds.v1.json` (CV-04 byte anchor). Untyped pages declare no fields, so a shelf keyed on the literal `tags:` name is name routing; the tag field must be declared. Owner call | M94.new-tags-filters | P2 | M | O2 row | this audit; AFN4 avoid (tag entities) |
| FEAT-20 | Re-implement saved Pages filters over `views.v1.json`, next to All/Recent/Favorites. Collections stay query-free, and an errored filter shows `unavailable`. M47 D9 declined database-less queries on disk ("a permanent cost in the on-disk contract"), so saved Pages filters stay per-device navigation state unless the owner reverses D9. Owner call | M94.new-tags-filters | P2 | M | O7 row | AFN4-07 |
| FEAT-21 | Re-implement (Apache idea) a read-only `![[page]]` embed from a body read of its target (the scan holds only a 160-char `snippet`, `src/engine/types.ts:21`), refreshed on vault change, with a depth and cycle cap, no second editor (CV-52) and the carrier held by CV-24. Owner call | M94.new-page-embed | P2 | M | E5 row | AFN2 owner Q5 |

> **2026-10-27 (Codex cross-check, CX-AFE-10):** AFFiNE is a second proof, not an avoid: read-only store (`embed-synced-doc-block.ts:415-419`), ancestor-cycle stop (`:422`), trash, missing and load-error faces (`:452-465`). Add those faces to the acceptance (BL-154).

| ID | Change | Phase | Priority | Effort | Evidence | From |
| --- | --- | --- | --- | --- | --- | --- |
| FEAT-22 | Re-implement a daily journal as a creation recipe: date key, explicit Create, a redirect that replaces history, empty journals hidden. Note that Tolaria removed its version. Owner call | M94.new-journal | P2 | S | O4 row | AFN4-11 |
| FEAT-23 | Re-implement "present a page as slides", split at H1/H2/HR, derived and read-only | M94.new-present | P2 | M | W3 row | this audit |
| FEAT-24 | Keep (planned). M98.8 already specifies `IntakeConfiguration`: ordered field IDs, form-only required fields and typed defaults in a Markdown-compatible carrier. Which slice goes first is the owner's choice (M98.8 selects slices separately) | M98.8 | P2 | M | D12 row | this audit |
| FEAT-25 | Re-implement link cards only for connected-account URLs, through M96.5 read actions, extending `forge.rs`'s PR card and cache (`src-tauri/src/forge.rs:22-25`), with TTLs as data and no catch-all unfurler. Mail URLs stay behind the mail gate (CV-59), and card images wait for a click (CV-61) | M96.new-link-cards (after M96.5) | P2 | M | K7 row | OUT5-13/14 |
| FEAT-26 | Re-implement an archive state (hidden by default, read-only, links intact) and/or a page lock (Rust doors refuse agent writes, rename and Trash under a policy code). The new refusal code declares its destiny (CV-06), and no agent door may add or remove the lock key (as CV-58 guards stamps). Owner call | M94.new-archive-lock | P2 | M | P4/P5 rows | OUT4-17, AFY-17 |
| FEAT-27 | Re-implement a `prefers-contrast: more` variant that re-points the ramps, plus a per-device prose size/font preference, never stored in the file. Font choice is an owner call: UX-01 keeps Instrument Sans/IBM Plex Mono | M94.new-reading-prefs | P2 | M | T2/T3 rows | PLN-07, PLN-15 |
| FEAT-28 | Re-implement shortcut rebinding over the existing catalog, with conflict detection. Overrides are per-device; none may take Escape (CV-47), letters still stand down in editors, and FEAT-07's accelerators follow | M94.new-rebinding | P2 | M | T4 row | this audit |
| FEAT-29 | Re-implement mouse buttons 3 and 4 as pane Back/Forward: one listener runs the existing `nav.back`/`nav.forward` rows (`src/app/commands/app.commands.ts:64-71`). M94.9 checks that WKWebView delivers those buttons | M94.5 | P2 | S | N10 row | TDK-04 |
| FEAT-30 | Re-implement comment anchors on images, diagrams, sheets and boards (comment sidecar format 2). A v1 reader refuses a newer format (`src-tauri/src/vault/comments.rs:256-266`), so older builds show those comments as unavailable and never overwrite them (CV-31); extend the shared comment cases. Owner call | M94.new-block-comments | P2 | M | C2 row; MA `ThreadAnchor` (Markdown mark, PDF highlight or point, sheet range, design-layer pin), `crates/messages/src/domain/models.rs:126-179` (r) | OUT2-11; MA (verification) |
| FEAT-31 | Re-implement an OKF v0.2 export profile beside `export_legacy`: `index.md` with `okf_version`, lifecycle mapped to status, losses listed. Import lands only as stamped imported pages (CV-22). Owner call | M99.8 | P2 | S | I6 row | OUT5-19, OUT4-19 |
| FEAT-32 | Keep (planned). M98.7 already gates an owner-selected system-wide capture (`shell/capture.rs`) with registration-conflict, focus-return and app-not-ready cases; it feeds the existing launcher. Owner call | M98.7 | P2 | S | G10 row | TDK-17 |

## Verification - reference fidelity (2026-10-24)

Checked 188 of 215 rows; confirmed 165, corrected 22, removed 1.

- Population: 120 matrix rows, 20 gaps worth closing, 20 gaps to skip, 15 strengths, the convergent line, 32 recommendations, 7 bottom-line bullets.
- Checked: every gap worth closing (P0/P1 included), every recommendation, every bottom-line bullet, 104 matrix rows, 14 skip rows, 10 strengths. Each check opened the cited `docs/examples/` file or listed its path, and grepped `src/`/`src-tauri/src` for the Cerebro side.

| Row ID | Verdict | What was wrong / what the code shows (path [read]) |
| --- | --- | --- |
| E1 | corrected | Morrow has both blocks: Callout and Toggle in its slash menu (MO `src/app/editor/SlashCommand.ts:165-177`), `callout` and `details` node types (`src/core/model.ts:175-178`) [read]. MO `~` → `Y` |
| E3 | corrected | Morrow has 2- and 3-column layouts (MO `src/app/editor/SlashCommand.ts:276-281`, `columns`/`column` nodes `src/core/model.ts:182-183`) [read]. MO `-` → `Y`; "others G0" was wrong for Morrow |
| S3 | corrected | Outline offers "Diagrams.net diagram", edited in the hosted draw.io editor and filtered out of its desktop app (OL `app/editor/menus/block.tsx:280-290`) [read]. OL `-` → `~` |
| F2 | corrected | Path: `@n8n/instance-ai/src/parsers/docx-parser.ts` (under N8) [read] |
| O5 | corrected | AFFiNE stores one workspace `pageTemplateId` and one `journalTemplateId`, not a template per database (AF `packages/frontend/core/src/modules/template-doc/type.ts:2-4`) [read]. AF `Y` → `~` |
| N2 | corrected | Outline folds accents only in in-page find (`app/editor/extensions/deburrWithMap.ts`, used by `FindAndReplace.tsx`) and name filters; document search is `to_tsquery('english')` with no `unaccent` (`plugins/search-postgres/server/PostgresSearchProvider.ts:650-651`) [read]. Tolaria folds name search (`src/hooks/useNoteSearch.ts:78`), but body search only lowercases (`src-tauri/src/search.rs:177,189`) [read]. OL and TO `Y` → `~`. The path also lacked `app/` |
| H6 | corrected | Macro has a change journal: every batch with its ops and inverse, and undo guarded against later edits (MA `crates/databases/src/domain/journal.rs:1-4`, `service/undo.rs:1-30`) [read]. MA `~` → `Y` |
| C2 | corrected | Macro anchors threads to Markdown marks, PDF highlights and points, sheet ranges and design-layer pins (MA `crates/messages/src/domain/models.rs:126-179`) [read]. MA `?` → `Y`. This backs FEAT-30 |
| C5 | corrected | Macro channel bots: "a message that mentions bots triggers exactly those bots", bot-authored messages never trigger, and a classifier may infer a follow-up in a thread (MA `crates/channel_bots/src/domain/trigger_detector.rs:14-25`) [read]. MA `-` → `Y` |
| I2 | corrected | Path: `importer.ts` has 302 lines. Notion handling is at `src/core/importer.ts:22,124`, and line 475 is nested-zip unpacking in `src/app/operations.ts:475` [read] |
| L9 | corrected | Cerebro side: the staged tree adds a second store flock, the app-wide recovery journal's `owner.lock` (`src-tauri/src/vault/recovery.rs:145-165`, opened at `src-tauri/src/recovery_commands.rs:28`) [read]. Still no single-instance or window focus, so `~` stands. The ledger lock is `ledger/writer.rs:993-1008` |
| Gap 15 | corrected | "Proven by AF" overstated it: AFFiNE has only a workspace-wide default (see O5) |
| Skip: encryption | corrected | Morrow encrypts individual pages behind a password (MO `src/core/crypto.ts:1`, `src/app/components/EncryptDialog.tsx:11-14`) [read]. It is not app-level encryption at rest. Relabelled; the skip reason stands |
| Strength: @agent in a thread | corrected | Not unique: Macro channel bots do this (see C5) [read]. Cerebro's difference: a person's explicit mention on a page thread, with no inferred follow-ups (CV-36) |
| Strength: journaled batches | corrected | "Macro … no journal" was wrong (see H6) [read]. Cerebro's difference is multi-file staging with rollback on the next start (CV-38) |
| Strength: 10 view kinds | corrected | Morrow also keeps typed records in Markdown: database definitions and row properties in frontmatter (MO `src/core/vault/pageFile.ts:9-10,100-106`), 5 views (`src/core/model.ts:77`), relation and formula fields, no rollup (`src/core/database.ts:30-38`) [read]. Added as nearest reference |
| Strength: four panes, one live editor per file | removed | Not Cerebro-only. Macro tiles splits with claims, so opening held content activates its owner and shows "Content already open" (MA `apps/web/src/lib/split-router/solid/use-claim.ts:5-9`, `apps/web/src/features/next-soup/utils.ts:664-665`, 400 px minimum in `apps/web/src/components/app/split-layout/splitContentSizing.ts:2`) [read]. AFFiNE's split views have no cap (`modules/workbench/entities/workbench.ts:95-111`) [read]. Moved to the convergent line |
| Convergent line | corrected | Tolaria's Pulse groups commits by day and has no heatmap: no `heatmap` in TO `src/`, `site/` or `docs/` (TO `src/components/PulseView.tsx:41,220`) [read]. Macro sheets are native Loro documents, not Markdown (MA `apps/web/src/features/block-spreadsheet/README.md:3,27`) [read]. Added Macro's pane claims |
| FEAT-10 | corrected | AFFiNE's `generateDefaultValues` seeds every single-condition top-level property, ranges included (number `>` → +1, date before → a day earlier). It never reads the group's AND/OR (AF `blocksuite/affine/data-view/src/core/filter/generate-default-values.ts:17-41`, `filter-fn/number.ts:44`, `filter-fn/date.ts:21`, caller `view-presets/table/table-view-manager.ts:295-298`) [read]. The narrower equals/one-of rule matches TD `#defaults` (`src/lib/databases.svelte.ts:838-847`) [read] |
| FEAT-13 | corrected | Evidence pointed at the backup format, not the mechanism. Morrow backs up changed pages only, every 10 min and at close; it writes a temp file then renames, keeps the newest 20 and has no byte cap (MO `src/app/operations.ts:623-636`, `src/app/App.tsx:25,96-98,126-127`, `electron/main.cts:66,453-465`) [read] |
| FEAT-17 | corrected | The fix must normalize before the split. `tokenize` and `token_spans` split on `!is_alphanumeric()` (`src-tauri/src/search.rs:217-242`) [read], and U+0301 is not Alphabetic (regex-syntax 0.8.11 `property_bool.rs:92-93`) [read]. NFC applied per token would not rejoin "cafe" + U+0301. The dependency already exists (`src-tauri/Cargo.toml:63`) [read] |
| FEAT-30 | corrected | Evidence now includes Macro's `ThreadAnchor`, which converges with Outline (see C2) |
| Bottom line: breadth | corrected | "Thought Desk is the only one close" missed Morrow, which keeps typed database records in Markdown frontmatter (see the 10 view kinds strength). Thought Desk uses SQLite, and Tolaria's types are lenses, not schemas |
| Paths legend (header; not counted) | corrected | Many short paths are suffixes, not root-relative (MA `nodes/` = `packages/lexical-core/nodes/`, TD `lib/` = `src/lib/`, …). Added a legend; every sampled suffix resolved to one file |

Confirmed with a note (no edit):
- FEAT-04: Tolaria's direct-PDF command is a stub in this snapshot. `can_export_current_webview_pdf` returns false (TO `src-tauri/src/commands/pdf_export.rs:1-12`), so the shipped path is `window.print()` (`src-tauri/src/commands/runtime.rs:122-123`), as FEAT-04 assumes. ADR-0136 records that the print panel was the wrong UX for "Export as PDF" [read].
- FEAT-01, FEAT-02, FEAT-03, FEAT-07 and FEAT-14: every cited line matched (AF, OL, TO, PL, AP, MO, TD boundaries; trash banners; single-instance locks; zoom; context-menu policy) [read]. Plugin versions and licences were confirmed in `~/.cargo/registry` [read].

## Verification - Cerebro fit (2026-10-24)

Checked 62 rows; confirmed 17, corrected 43, reclassified 2, removed 0.

- Population: 20 gaps, 32 recommendations, the Cerebro cells of 6 matrix rows they cite, 4 bottom-line bullets. Each check grepped or read `src/` and `src-tauri/src` on the dirty tree and read the cited M93–M99 phase text (plan and spec). Nothing was built or run.
- Net changes: one new P0 (FEAT-14), one P2 → P1 (FEAT-17), two rows already planned (FEAT-24, FEAT-32), six phase moves (FEAT-05/06/11/12/18/25), no cell values changed (tally stands).

| Row ID | Verdict | Reason (Cerebro path or plan section) |
| --- | --- | --- |
| Bottom line: what changed | corrected | "Every writer and every open" overstated it: writes are Cerebro's `vault_writes`, and the open log keeps 200 pages × 10 opens per Mac (`src/engine/openLog.ts:26-27`) [read] |
| Bottom line: creation journeys | corrected | Phases now follow FEAT-11 and FEAT-12 |
| Bottom line: latent defect | confirmed | `tokenize`/`token_spans` only lowercase (`src-tauri/src/search.rs:217-242`); no `.nfc()` on the search path (grep) [read] |
| Bottom line: P0 | corrected | FEAT-14 is a second P0; owner calls 12 → 13 (FEAT-27) |
| H2 | corrected | `ProseDiffView` diffs any before/after; the parent pairing is `useFileVersions` (`src/git/useGit.ts:411-426`) [read] |
| H5 | corrected | Staged M93 wraps the missing page in `DeletedDraftRecovery` (`src/pages/DocPage.tsx:335-352`, `src/editor/DeletedDraftRecoveryFace.tsx`); still no Trash lookup, so `-` stands [read] |
| L9 | corrected | Staged per-operation flocks too (`runtime/action_invocations.rs:258`, `workspace_service/selected_store.rs:185`); path locks are a process-static table (`vault/write.rs:401-404`); `~` stands [read] |
| N9 | corrected | Both `[[` and `@` menus have the Create row (`src/editor/MarkdownEditor.tsx:1141-1150`) [read] |
| O5 | corrected | Templates are also offered in the Folders New page dialog (`src/components/FileTree.tsx:901-909`); no per-Type default, so `-` stands [read] |
| I4 | corrected | PNG/SVG/CSV/XLSX export doors exist (`src-tauri/src/lib.rs:2684-2768`), none for a page [read] |
| Gap 1 | confirmed | No boundary or root error hook in `src/` (grep 0); the one quit listener is an effect (`src/app/quit.ts:248-249`); Rust exits after 5 s unanswered (M93 spec, REL-03); no plan names containment (grep) |
| Gap 2 | corrected | Restore as… is a new door, not an existing one; Back without origin reset is already UX-06 (M94 spec) and M94.5's deleted-target tests |
| Gap 3 | confirmed | In-process path locks (`vault/write.rs:401-404`); no plugin in `src-tauri/Cargo.toml`; no plan names single instance (grep) [read] |
| Gap 4 | confirmed | No print, `@media print` or HTML export (grep 0); not planned (grep) |
| Gap 5 | confirmed | `getFileAtCommit` exists (`src/lib/gitIpc.ts:138`); no plan picks a compare base (grep) [read] |
| Gap 6 | corrected | M94.6's file map is view files, not Pages; M94.3 is the owner-compared slice, so a new phase follows its acceptance |
| Gap 7 | corrected | "A CV-04 table" mislabelled it: command rows are TS (CV-47), and a Rust copy would be a twin |
| Gap 8 | confirmed | `src/editor/chips.tsx:106` returns on null; Quick Open has no create row (grep); M94.4 writes nothing until Create (UX-05) [read] |
| Gap 9 | corrected | M93.7 adopts one measured candidate, explicit paging among them; REL-08 keeps find over every logical row (M93 plan, spec) |
| Gap 10 | corrected | `PagesPage` is M94.3's first-slice surface; M94.6 lists view files only (M94 plan) |
| Gap 11 | corrected | The ledger is git-ignored today (M99 plan, M99.8); `workspace.db` is under app config `workspaces/` (`src-tauri/src/workspace_service/native_admission.rs:215`) [read] |
| Gap 12 | corrected | P1 → P0: the M93.2 inventory is open (implementation record), and both draft stores are memory-only (M93.1; M94.4 "zero browser/disk persistence") |
| Gap 13 | confirmed | Promote/demote carriers exist (`src/editor/markdown.ts:92-94`); math G0; not planned (grep) [read] |
| Gap 14 | confirmed | The window is built with no saved frame, hidden start or theme (`src-tauri/src/shell/mod.rs:65-112`); not planned (grep) [read] |
| Gap 15 | confirmed | UX-05: a later template recipe must pin identity, version and seed first (M94 spec) |
| Gap 16 | corrected | M47 D9 declined database-less on-disk queries (`specs/2026-08-30-cerebro-m47-everything-is-a-page-design.md`, D9 and R1) [read] |
| Gap 17 | corrected | Details is `src/detail/DocSidePanel.tsx`; M94.5 owns Details vocabulary, and M94.3 is the comparison slice [read] |
| Gap 18 | confirmed | No page embed (grep); the carrier answers to CV-24 |
| Gap 19 | confirmed | No daily note (grep); a recipe fits M94.4's recipe lifecycle |
| Gap 20 | confirmed | No archive or lock (grep); rule notes are in FEAT-26 |
| FEAT-01 | corrected | `componentDidCatch` runs after the subtree unmounts, so the flush reaches only retained owners (`src/editor/openPages.ts:401-421`); the flushing boundary stays out of `components/ai/` (CV-64) [read] |
| FEAT-02 | corrected | Restore sits inside M93's `DeletedDraftRecovery`; Restore as… needs CV-33/31/41; Home after delete is `DocPage.tsx:480`; Back is UX-06 [read] |
| FEAT-03 | corrected | The plugin socket is keyed by identifier (`macos.rs:61-72`) and fails open (`:39`, `:128`); argv must not act (CV-50); `tauri dev` shares the identifier [read] |
| FEAT-04 | corrected | Reuse `export_svg`'s dialog door (`src-tauri/src/lib.rs:2717`) and `toExternalHTML` (`src/editor/blocks.tsx:118-131`); not planned (grep) [read] |
| FEAT-05 | corrected | "Last opened" must name a commit, since uncommitted bytes were never recorded; M94.8's file map has no History surface, so that consumer was dropped |
| FEAT-06 | corrected | The open log records at navigation (`src/engine/openLog.ts:34-42`) and caps at 200 pages; `pageAttribution` reads one page (`src/lib/ipc.ts:1294`); phase moved [read] |
| FEAT-07 | corrected | CV-04 → CV-47 wording; ⌘=/⌘-/⌘0 are bound in the PDF and image viewer scopes (`pdf.commands.ts:16-21`, `viewer.commands.ts:13`); a menu set from the webview goes through an adapter (CV-18) [read] |
| FEAT-08 | confirmed | No window-state or hidden start (`src-tauri/src/shell/mod.rs:65-112`); Apache-2.0 OR MIT passes `deny.toml` [read] |
| FEAT-09 | corrected | `createLinkedPage` slugs (`src/app/listActions.ts:340-354`), and a slug leaves title-only resolution (CV-09), so the exact target stays the stem [read] |
| FEAT-10 | corrected | M94.4 shipped `creationDraftKey` (`src/engine/creationDestination.ts`); seeds must stay out of it; half-built rules skip (`src/engine/viewFilters.ts:234`) [read] |
| FEAT-11 | corrected | No board or gallery workload in `scripts/performance/` (grep); M93.7 is measured-first; REL-08 find |
| FEAT-12 | corrected | Phase moved; moves through `renameActions` (CV-41); PL08 bulk runs stay deferred (M98 plan, self-review) |
| FEAT-13 | corrected | The ledger is already outside git; follows M93.9's bounded, mail-free retention |
| FEAT-14 | corrected | P1 → P0; component menus already use `onContextMenu`; no document-level policy (grep) [read] |
| FEAT-15 | confirmed | Promote/demote carriers exist; KaTeX is MIT; not planned (grep) |
| FEAT-16 | corrected | A Type doc's template path must follow renames (CV-41); meets UX-05's template precondition |
| FEAT-17 | corrected | The dependency is `src-tauri/Cargo.toml:65` in the dirty tree; candidate expansion uses the same tokenizer (`src-tauri/src/retrieval/mod.rs:105-129`), so bump `RETRIEVER_VERSION`; P2 → P1: an S-sized defect that should precede M97.7's accent labels [read] |
| FEAT-18 | corrected | Phase M94.3 → M94.5 (see Gap 17) |
| FEAT-19 | corrected | A new kind edits a shared artifact (CV-04); a shelf on the literal `tags:` key is name routing |
| FEAT-20 | corrected | M47 D9 (see Gap 16) |
| FEAT-21 | corrected | The scan holds a 160-char `snippet` only (`src/engine/types.ts:21`); `PagePreview` reads no file [read] |
| FEAT-22 | confirmed | No journal (grep); explicit Create matches M94.4 |
| FEAT-23 | confirmed | No presentation mode in the command rows (grep); not planned (grep) |
| FEAT-24 | reclassified | M98.8 already names ordered field IDs, form-only required fields and typed defaults (`IntakeConfiguration`, M98 plan) |
| FEAT-25 | corrected | M96.6 is effect inspection; link cards extend `forge.rs` after M96.5; CV-59, CV-61 [read] |
| FEAT-26 | corrected | A new refusal code needs a declared destiny (CV-06); the lock key needs a CV-58-style guard |
| FEAT-27 | corrected | A font preference meets UX-01's retained fonts: owner call |
| FEAT-28 | corrected | CV-47 limits: no Escape (`src/app/commands/index.test.ts`), editor stand-down |
| FEAT-29 | corrected | Dispatch the existing `nav.back`/`nav.forward` rows (`src/app/commands/app.commands.ts:64-71`); WKWebView button delivery is unverified [read] |
| FEAT-30 | corrected | v1 readers refuse format 2 (`src-tauri/src/vault/comments.rs:256-266`); they do not read it read-only [read] |
| FEAT-31 | confirmed | `knowledge/` is OKF v0.2 (`src/engine/okf.ts:8`); `export_legacy` is M99.8's planned interface, with no code yet (grep) [read] |
| FEAT-32 | reclassified | M98.7 already gates an owner-selected system-wide capture (`shell/capture.rs`, M98 plan) |
