# Macro reference — Docs editor: Lexical markdown, CRDT collaboration, comments, mentions

**Scope**: Macro's document editor, read 2026-10-12 from `docs/examples/macro-main/` (vendored and gitignored). Every
Macro path below is relative to that root. Cerebro paths are relative to the repo root.
**Owner's rule (2026-10-12)**: Cerebro builds its own version, with Macro's code as the guide and never a 1:1 copy.
Modes are rebuild (fidelity mirror / adapt / inspire), adopt-upstream, reuse-permissive and skip.
**Licence**: root `LICENSE.txt` is AGPL-3.0. `apps/web/LICENSE` reads "Copyright 2023 CoParse, Inc. All rights
reserved." and covers every `apps/web` path here, so treat that code as unlicensed for reuse. `packages/loro-mirror` is
MIT. `packages/lexical-core`, `packages/collaboration` and `services/lexical-service` declare no licence field (AGPL
applies). Cerebro is Apache-2.0. **Design input only; copy no code** except rows marked reuse-permissive.
**Evidence**: stages 1–2 read the code. Stage 3 re-read both trees at HEAD `fb6822a` and ran four jsdom spikes (vitest
3.2.7, the real `cerebroSchema`, `markdown.ts` and `setup.ts`). It did not run WKWebView/Tauri, Playwright, cargo test
or mac-build, so verdicts that need those are marked partial. Stage 3 overrides stages 1–2.

---

## 1. What it is

- A Lexical 0.45 block editor (SolidJS) whose state mirrors 1:1 into a **Loro CRDT**. The CRDT is the store; markdown
  is a projection. The shared node set (54 classes) lives in `packages/lexical-core`.
- Sync runs through one Cloudflare Durable Object per doc (`services/sync-service`: Rust worker-rs, bebop WS). Headless
  Lexical (`services/lexical-service`) does conversions. `crates/documents` (DSS) holds metadata, JWTs and AI tools.
- Comments are marks inside the CRDT; threads are messages outside it. Mentions are live decorator pills with a
  backlink table.

## 2. What users get

| Feature | UX details and shortcuts | Paths |
| --- | --- | --- |
| Markdown-native block editor | Paragraphs, H1–H3, bullet/number/check lists, quotes, Prism code with copy, tables, dividers, resizable image/video, links, KaTeX inline/block, highlight/sub/sup. Autoformat while typing, drag reorder, Tab indent. Placeholder advertises `/`, `@`, `;`. Title is a separate editor (400 ms debounced rename). Touch: swipe to indent/outdent. One editor serves the task/snippet/skill aliases. | `packages/lexical-core/node-list.ts`, `apps/web/src/features/block-md/component/MarkdownEditor.tsx`, `apps/web/src/features/block-md/component/TitleEditor.tsx`, `apps/web/src/features/block-md/definition.ts` |
| Slash menu | `/` paragraph, h1–3, quote, code, lists, task, document, image, video, link, latex, table, hr, db-query (flagged). An item shows only if the editor registers its node deps. `/task` and `/document` open a composer (Cmd+Enter creates). An `AwaitNode` "Creating <title>" holds the caret spot; success swaps in a `DocumentMentionNode`, failure removes it and reopens the composer with the draft. | `apps/web/src/lib/core/component/LexicalMarkdown/plugins/actions/actions.ts`, `.../actions/available-actions.ts`, `.../actions/types.ts` |
| `@` mentions | Bucketed picker: people, docs/tasks/projects, channels, agent sessions, PRs, contacts/companies, dates. Pills carry live metadata, hover preview, convert-to-embed (`DocumentCardNode`), collapse. `@` inside a word stays literal. Pasted app URLs become mentions. Body mention = silent; comment mention = notifies. Insert/delete track/untrack a backlink row via `mentionUuid` on the node. | `.../plugins/mentions/mentionsPlugin.ts`, `packages/lexical-core/nodes/DocumentMentionNode.ts`, `packages/lexical-core/nodes/DocumentCardNode.ts`, `apps/docs/concepts/mentions.mdx` |
| Checkbox → task | Selected checklist items become Task docs: user mentions → assignees, first date → due. Created in parallel, then one discrete update swaps each item for a task-mention paragraph. Checklists show a progress meter plus status/priority/assignee/due filters (saved in `$.taskListView`); filtering dims non-matches. | `.../plugins/checkbox-to-task/checkboxToTaskPlugin.ts`, `.../checkbox-to-task/checkboxParsing.ts`, `packages/lexical-core/nodes/TaskListNode.ts`, `.../plugins/checklist-controls` |
| Inline comments + Discussion | Select → thread (margin card desktop, drawer touch). Reply, resolve/reopen, edit/delete, attachments, reactions, notifying @mentions. Draft mark is local until posted. Deleting the root removes thread and mark. All marked text removed → thread moves to Discussion; partial removal keeps the anchor. `?comment_id=` deep-links even before load. Commenters may change only marks. | `.../plugins/comments/commentPlugin.ts`, `apps/web/src/features/block-md/comments/MessageCommentsProvider.tsx`, `.../comments/CommentMargin.tsx`, `apps/web/src/lib/core/comments/Thread.tsx`, `apps/web/src/lib/core/comments/discussion/Discussion.tsx`, `docs/AGENT_GUIDE/documents.md` |
| Realtime collab, presence, offline | Named remote cursors (Loro Cursors keyed by node id), 5 s awareness timeout, connection indicator. Loro UndoManager with Lexical merge semantics. Offline edits queue in an IndexedDB WAL, replay on reconnect. Native offline reopen is per-user and never persists tokens. | `.../LexicalMarkdown/collaboration/CollabProvider.tsx`, `.../collaboration/remote-cursor.tsx`, `.../collaboration/undo.ts`, `packages/collaboration/src/collab/wal.ts` |
| AI edit | Supervised edit streams in with a live "<Agent> (AI)" cursor and Stop; **no accept/reject**. Selection popup uses fast mode: ops return and apply into the user's undo stack. Usage limit → upsell dialog; else toast "AI edit failed". AI can insert the same chips a person can. | `apps/web/src/features/block-md/queries/ai-edit.ts`, `apps/web/src/features/block-md/ai-edit/applyAiOps.ts`, `services/ai-editing-worker/AI_EDITING.md` |
| History, session diff, fork | Desktop only, title "…" menu. Read-only preview, timeline graph, per-user sessions (10 min gap). AI peers collapse to the Macro bot; golden seed hidden. Author-coloured session diff. Fork any past version into a new doc. | `apps/web/src/features/block-md/history/HistoryContext.tsx`, `.../history/sessionize.ts`, `.../history/timestampIndex.ts`, `.../history/HistoryOverlay.tsx` |
| Blame tooltip | Hover → last editor of the nearest id-bearing block (`GET /document/{id}/blame/{nodeId}`). | `.../plugins/blame-tooltip/blameTooltipPlugin.ts`, `services/sync-service/database/user-peer-mapping/migrations/0002_add_blame.sql` |
| Outline rail | Left-margin tick per heading, visible sections highlighted. Hover expands nearby ticks, previews heading + ≤3 lines (pointer events pass through); click jumps. Only with ≥3 headings and when it fits the gutter (`outlineFitsGutter`). Hidden on mobile and in history. | `apps/web/src/components/DocumentOutline.tsx`, `apps/web/src/features/block-md/component/MarkdownOutline.tsx` |
| Find and replace | Cmd+F, replace one / all. **Literal, case-insensitive; no regex, no case toggle.** Document chips match by title (replace skips them); user mentions, hr and equations ignored. Highlights are DOM-Range overlay rects (`SearchMatchNode`). | `.../plugins/find-and-replace/findAndReplacePlugin.ts`, `.../find-and-replace/searchHighlightTarget.ts`, `.../find-and-replace/getFloatingSearchHighlightStyle.ts`, `apps/web/src/features/block-md/component/FindAndReplace.tsx` |
| Snippets, tags, pinned props | `;` inserts a snippet doc, flattened into the caret paragraph; Esc/space keeps the `;`. `#` inserts coloured `TagMentionNode` pills (title or body). Pinned properties live in root node state. | `apps/docs/product/snippets.mdx`, `.../plugins/snippets/snippetInsertion.ts`, `.../plugins/tags`, `.../plugins/pinned-properties` |
| Continue writing | Generate plugin sends a 500-char window around a `[[SELECTION]]` marker; Tab or Space accepts. | `.../plugins/generate/context.ts:12-43`, `.../plugins/generate/generatePlugin.ts` |
| Section / node deep links | `?node_id=` / `GO_TO_NODE_ID` scrolls to and flashes a node. | `.../plugins/location/locationPlugin.ts:189-291` |
| Export and copy | Download .md (external dialect, client-side), copy markdown, download JSON, "Copy as prompt" (`<document>` wrap). Backend: lexical-service `GET /markdown/{id}?target=internal\|external\|embedding`. | `apps/web/src/features/block-md/component/useMarkdownDocumentDownload.ts`, `services/lexical-service/src/endpoints/markdown.ts` |
| Version-mismatch guard | Root state stamps `MARKDOWN_VERSION_COUNTER` (7.0); an older client opening a newer doc gets `VERSION_MISMATCH_ERROR` instead of dropping nodes. Stamp upgrades on first mutation. | `apps/web/src/lib/core/component/LexicalMarkdown/version.ts`, `.../plugins/document-metadata/documentMetadataPlugin.ts` |
| Collab surfaces | Any entity can host a collaborative markdown field (channel input, initiative description, form) with its own CRDT session. Load-or-create on mount; optimistic, IDB+WAL and remote seeds race. | `apps/web/src/lib/core/collab-surface/CollabMdSurface.tsx`, `.../collab-surface/createCollabSurface.ts`, `.agents/skills/collab-surface-core/SKILL.md` |
| DOCX editor (flag) | Paginated canvas over a wasm Rust docx engine; peers, tracked changes, Word comments read-only, Macro comments. Unopened file shows the original read-only. | `apps/web/src/features/block-write/DocxBlock.tsx`, `.../block-write/core/docx-loro.ts`, `.../block-write/queries/docx-session.ts` |
| PR diff viewer | `@pierre/diffs` file diffs: split/unified, collapse-all, sticky headers, lazy reveal, GitHub-style line-range comments. Code only, not doc versions. | `apps/web/src/components/diff-view/DiffView.tsx`, `.../diff-view/pierre/PierreFileDiff.tsx`, `.../diff-view/comments/create-diff-comments.tsx` |

## 3. How it's built

**Overview**: Lexical editor ⇄ `CollabProvider` (reconcile by stable node id) ⇄ `LoroManager` (loro-mirror diffs JSON
into Loro) ⇄ `SyncEngine` (IDB WAL + snapshots) ⇄ bebop WS ⇄ sync-service DO (in-memory LoroDoc, op log, snapshot; acks
only once durable; broadcasts). Server side: lexical-service (headless Lexical) for conversions and comment-only
validation; DSS for metadata, JWTs, seeding, cached S3 snapshots, AI tools; ai-editing-worker joins docs as a Loro peer.

### Components

| Unit | Path | Role | LOC |
| --- | --- | --- | --- |
| lexical-core node set | `packages/lexical-core/node-list.ts` | 54 node classes shared by web, lexical-service, ai-worker; replacements CodeNode→CustomCodeNode, ListNode→TaskListNode; per-editor sets | 17,284 (pkg) |
| Markdown transformers | `packages/lexical-core/transformers/index.ts` | INTERNAL = GFM + `<m-tag>{json}</m-tag>`, `UNKNOWN_MENTION` last; EXTERNAL = lossy GFM (doc mention → link, user → id, marks dropped) | ~3,500 |
| Node ids + peer ownership | `packages/lexical-core/plugins/nodeIdPlugin.ts`, `peerIdPlugin.ts` | nanoid(11) id in node state ↔ NodeKey; backbone for reconcile, AI ops, blame, diff, deep links, search chunks | ~600 |
| Golden snapshot | `packages/lexical-core/markdown-loro-snapshot.ts`, `static_assets/markdown-golden.1.bin` | 784 B shared ancestor; markdown → Loro via Mirror onto it; Rust `include_bytes!` | ~150 |
| CommentNode | `packages/lexical-core/nodes/CommentNode.ts` | `comment-mark` {ids[], threadId?, isDraft}; rejoin text; context windows (1000 / 2000 chars); strip/lift/restore drafts | 381 |
| diffStates / buildWhoMap | `packages/lexical-core/utils/diffStates.ts`, `utils/buildWhoMap.ts` | Pair blocks by `$.id`; INSERT_AFTER/DELETE/MODIFY with jsdiff char runs; last-writer attribution | ~450 |
| XML AI view | `packages/lexical-core/transformers/xml/index.ts` | id-attributed XML of the doc for AI and `GET /xml/{id}` | ~700 |
| LexicalMarkdown runtime | `apps/web/src/lib/core/component/LexicalMarkdown` | SolidJS shell, 56 plugin dirs, 49 decorators, builder, markdown import/export | 44,875 |
| CollabProvider | `.../LexicalMarkdown/collaboration/CollabProvider.tsx`, `reconcile.ts`, `undo.ts` | Loro → `$reconcileLexicalState` by id; local → `loroSyncState`; cursors; Loro UndoManager | 2,323 (reconcile 299, undo 454) |
| Collaboration runtime | `packages/collaboration/src` | LoroManager (4-way seed race), SyncEngine (5 s IDB tick, 3 retries), WAL (1-week TTL), awareness, BroadcastChannel, bebop transport, Tauri WS | 11,111 |
| loro-mirror | `packages/loro-mirror/src/core/mirror.ts`, `diff.ts` | Schema-driven JSON ⇄ Loro; list diff by idSelector (LIS moves); `LoroText.update` | 3,433 |
| sync-service DO | `services/sync-service/src/durable_object.rs` | WS connect (JWT), CAS state/update, snapshot, raw, initialize, blame, copy; op log in KV, snapshot in SQLite (1.5 MB chunks); 5 s alarm | 6,408 |
| Wire protocol | `services/sync-service/bebop/schema.bop`, `src/socket/framing.rs` | FromPeer/FromRemote; `[is_final u8][≤900KB]` frames; ping/pong | 66 |
| lexical-service | `services/lexical-service/src/index.ts` | Hono worker (Bun :8096): plaintext, search, cognition, markdown, xml, comment-mark, comment-only-change, snapshot/markdown, mentions | 2,599 |
| ai-editing-worker | `services/ai-editing-worker/AI_EDITING.md`, `src/comment-mark/anchor.ts` | Joins as AI peer; interpreter → supervisor → coders in QuickJS emit `DocumentOp[]`; quote anchoring | ~6,200 non-test |
| md block UI | `apps/web/src/features/block-md` | Definition, seed race, editor composition, comments, history, outline, find, title, export | 15,405 |
| Comment thread UI | `apps/web/src/lib/core/comments` | Root/Reply view model over Message, `DRAFT_THREAD_ID=-1`, Discussion | 1,776 |
| Collab surface | `apps/web/src/lib/core/collab-surface/createCollabSurface.ts`, `crates/collab_surface/src/domain/ports.rs` | Stable-id markdown field owned by a parent entity; ensure/token/retire | 778 + 2,064 |
| documents crate | `crates/documents/src` | CRUD, content lifecycle, markdown init, AI toolset (EditDocument, CommentOnDocument, ResolveDocumentComment, ReadContent), mention tracker | 22,009 |
| mention_utils | `crates/mention_utils/src/parse.rs` | nom parser for `<m-*-mention>{json}`; safe external links (http/https/mailto) | 658 |
| Sync JWT | `crates/macro_sync_service_jwt/src/lib.rs` | HS256, 1 h TTL, Document\|Surface session kinds | 326 |
| DOCX block | `apps/web/src/features/block-write` | wasm docx engine + Loro; out-of-band comment anchors (`core/comment-marks.ts`) | 8,044 |
| diff-view | `apps/web/src/components/diff-view/DiffView.tsx` | SolidJS shell over `@pierre/diffs` in a shadow root | 1,918 |
| DocumentOutline | `apps/web/src/components/DocumentOutline.tsx` | Presentational tick rail with HoverCard previews | 106 |

### Data model

| Entity | Storage | Key fields | Path |
| --- | --- | --- | --- |
| Markdown Loro doc | DO SQLite (chunked) + op log; client IDB `macro-document-snapshots`, WAL `macro-document-wal` | node = LoroMap {`$`: {id, peerId, documentMetadata{version}, pinnedPropertyIds, taskListView, searchText}, `text`: LoroText, `ids`: LoroList<markId>, `children`: LoroMovableList keyed by `$.id`}; deep JSON = Lexical state | `packages/lexical-core/markdown-loro-schema.ts` |
| Golden snapshot | checked-in asset | root + one empty paragraph; fixed timestamp 1780516229000 (history hides it) | `static_assets/markdown-golden.1.bin` |
| Document | Postgres `Document` | name, owner, fileType, branchedFrom*, contentState (unknown\|pending\|ready), contentLocation, sub type | `crates/macro_db_client/migrations/20260511223000_document_content_lifecycle.sql` |
| Cached snapshot | S3 `SYNC_SERVICE_SNAPSHOT_PREFIX/{id}` | shallow Loro snapshot pushed by the alarm | `crates/documents/src/outbound/s3_upload_url.rs` |
| Comment threads | Postgres `comms_messages` + `comms_message_threads` | thread root, resolved, `anchor` jsonb {type: markdown\|pdf_*, mark_id, marked_text}; unique (parent_entity_id, anchor→mark_id) | `crates/macro_db_client/migrations/20260917175816_messages_parent_aware_schema.sql` |
| Legacy comment maps | Postgres | old numeric ids → uuid; Thread/Comment tables dropped | `crates/macro_db_client/migrations/20261002150422_drop_legacy_comment_schema.sql` |
| Comment mark | in the doc | `comment-mark`, ids[] (uuid v7), threadId (legacy), isDraft (never synced) | `packages/lexical-core/nodes/CommentNode.ts` |
| DocumentMentionNode | in the doc; internal `<m-document-mention>{json}` | documentId, documentName, blockName, blockParams, mentionUuid, collapsed | `packages/lexical-core/nodes/DocumentMentionNode.ts` |
| Entity mentions | Postgres `comms_entity_mentions` | source → target, user_id | `crates/macro_db_client/migrations/20251104101012_comms_db_schema.sql` |
| Peer map + blame | D1 | peer_user_map(document_id, peer_id, user_id); blame(document_id, node_id, peer_id, ts) last writer | `services/sync-service/database/user-peer-mapping/migrations/0001_add_users.sql` |
| WS session | DO storage | user_id, access_level, peer_ids, session_kind; WriteAccess None\|CommentMarks\|Full | `services/sync-service/src/durable_object.rs` |
| collab_surfaces | Postgres | uuid v7 (also `surface:<id>` key), polymorphic parent, pending\|ready, soft delete | `crates/macro_db_client/migrations/20260814140856_create_collab_surfaces.sql` |

### Key flows

**Open and edit**
1. `definition.load` → `fetchSyncDocumentOpenContext` (token, access, metadata) → WS `/document/{id}/connect?token`.
2. `MarkdownDocument` races 4 seeds into `LoroManager.ingest`: optimistic, IDB + WAL replay, S3 cached, remote initial
   sync. First wins.
3. `CollabProvider` reconciles Loro → Lexical by node id, restores the cursor from its Loro Cursor.
4. Local edit → `loroSyncState` (strip drafts) → Mirror diff → Loro update → WAL append → `PeerUpdate`.
5. DO: write-access check → import + op log → blame events → `RemoteUpdateAck` only once durable → broadcast.
6. ~5 s alarm: snapshot, clear ops, PUT shallow snapshot to DSS, post `sync-content-updated`, flush blame to D1.
7. Client tick saves IDB snapshot and prunes delivered WAL entries.

**Seed / import**: empty → golden bytes; else lexical-service `POST /snapshot/markdown` (headless import, nanoid ids,
Mirror onto golden) → sync-service `/initialize` (one-shot, `SnapshotAlreadyExists` = success, 3 retries) →
`contentLocation=sync_service`. Pre-init sockets are held and get the initial sync when it lands.

**Inline comment**
1. Select → `CREATE_DRAFT_COMMENT_COMMAND` wraps it in `CommentNode{isDraft, uuid v7}` (local only).
2. Post → `messages.post({content, anchor:{type:'markdown', mark_id, marked_text}})`.
3. `COMMIT_COMMENT_MARK_COMMAND` clears isDraft; the mark syncs.
4. Resolve/reopen patches `resolved`. Root delete removes thread + mark. Last marked text removed → Discussion.
5. Commenter WS updates pass only if lexical-service `/comment-only-change` finds before/after equal with marks and
   identity state stripped (`services/lexical-service/src/lib/comment-only-change.ts`, `services/sync-service/src/auth.rs`).
6. Agent: `CommentOnDocument(quote, occurrence?)` → worker `POST /comment-mark` joins as peer, wraps the exact span, or
   422 for missing / cross-block / ambiguous → post thread → remove mark if the post fails. `ReadContent` reports
   current vs original `marked_text` and `removed`.

**AI edit**
1. `EditDocument{document_id, instructions, fast}` → edit access + `ensure_markdown` → mint token → worker `/edit`.
2. Worker opens a WS from the reserved AI peer range; interpreter → supervisor → coders write JS against
   `DocumentEditor` in QuickJS → `DocumentOp[]` (setText, replaceText, insertNode, setBlockType, markText, setChecked,
   setCell, mentions).
3. Animated steps with an "(AI)" awareness cursor → headless Lexical → Mirror → Loro → peers.
4. Returns `{ops, usage[], clarification?}`. Inline popup uses `fast` + `propagate:false`, then `applyAiOps` locally.

**History / fork**: full snapshot + peer map → sessionize (10 min gap, AI → bot, golden filtered) → frontier at a
timestamp → `doc.checkout` preview. Session diff: checkout(start−1) vs checkout(end) → `diffStates` + `buildWhoMap` →
`DiffTextNode` render. Fork: `versionIdAt` → DSS copy → sync-service `/copy` → `/initialize` new doc.

**Checkbox → task**: `$getSelectedCheckboxes` → `$parseCheckboxNodes` renders internal markdown, pulls
`<m-user-mention>` ids and first `<m-date-mention>` → `createTaskFromData` in parallel → one discrete update swaps items.

## 4. Ideas worth stealing

1. **Refuse, don't guess, on quote anchors** — exact quote + 1-based occurrence; 422 lists occurrences on
   missing/cross-block/ambiguous. Deterministic MCP contract. `services/ai-editing-worker/src/comment-mark/anchor.ts`,
   `apps/docs/AI/mcp/tools/comment-on-document.mdx`, `crates/documents/src/inbound/toolset/comment_on_document.rs`.
2. **Comments = mark + out-of-doc thread** — snapshot `marked_text`, report current vs original + `removed`, orphans to
   Discussion, drafts never persisted. `packages/lexical-core/nodes/CommentNode.ts`, `crates/documents/src/domain/comments.rs`.
3. **Files-first comment anchor (DOCX)** — `{block, start, length, text}` out of band, relocated: same spot → nearest
   in block → closest other block → gone; "the file itself is never modified by commenting". Closest guide for a
   sidecar. `apps/web/src/features/block-write/core/comment-marks.ts`, `.../primitives/create-docx-comments.ts`.
4. **Agent edits land inside the user's undo stack** — fast mode returns ops; client applies them as one step.
   `apps/web/src/features/block-md/ai-edit/applyAiOps.ts`.
5. **Reconcile remote state onto a live editor** instead of remounting. `.../collaboration/reconcile.ts`.
6. **CAS update** — read {snapshot, revision}, write {expectedRevision}; 409 when stale; retried applied write →
   `applied:false`. `services/sync-service/README.md:124-138`, `services/sync-service/src/domain/document.rs`.
7. **Ack only after durable** — WAL with delivered flag, pruned only after a snapshot captures it.
   `services/sync-service/src/socket/protocol.rs`, `packages/collaboration/src/collab/wal.ts`.
8. **Comment-only by structural equality** — strip marks + identity, deep-compare. `services/lexical-service/src/lib/comment-only-change.ts`.
9. **Slash registry with dependency filtering + Await placeholder** for async create.
   `.../plugins/actions/types.ts`, `.../actions/available-actions.ts`.
10. **Checkbox → record rules** — mentions → assignees, first date → due, item → reference chip. `.../checkbox-to-task/checkboxParsing.ts`.
11. **Block diff by id with word runs + per-block author**. `packages/lexical-core/utils/diffStates.ts`, `utils/buildWhoMap.ts`.
12. **Outline rail gating** (≥3 headings, fits gutter, pass-through preview). `apps/web/src/features/block-md/component/MarkdownOutline.tsx`.
13. **Version stamp guard** — refuse editable open of a newer doc. `.../LexicalMarkdown/version.ts`. (Cerebro's fences
    already cover this; see §8.)

## 5. Cerebro today vs Macro

| Macro feature | Cerebro status | Value | Note |
| --- | --- | --- | --- |
| Every node round-trips through markdown | **partial — silent loss** | high | AI block saves chrome, loses type/props (prompt survives glued to "Recompute"). BlockNote defaults offered by `/` lose structure on save: toggle list, toggleable heading, nested children, file, audio, image caption, `$$` math, `[!note]-`. Bare ``` → ```javascript, falsely locks. `src/editor/markdown.ts`, `src/editor/blocks.tsx`. EDITOR-1. |
| Agent edits page body in place | partial | high | MCP has create/append/frontmatter/write_concept only; CLI writers denied unless shell (off by default). EDITOR-2. |
| Agent writes reach the open editor | **absent — data loss** | high | MCP writes never notify the open page; a user save overwrites them silently. EDITOR-11. |
| Remote/AI edits reconciled into live editor, in undo | partial | high | Clean buffer remounts (caret + undo lost); dirty → Load/Keep banner; no merge. Dirty flag sticks after no-op changes. EDITOR-3. |
| Inline comments, Discussion, resolve | none | high | BlockNote `CommentsExtension`/`ThreadStore`/UI (MPL-2.0) installed, unused. EDITOR-4a. |
| Agent comment tools | none | high | EDITOR-4b. |
| Find and replace | none | medium | No ⌘F handler; WebView has no find bar. EDITOR-5. |
| History: rendered diff, attribution, restore | partial | medium | Git log + raw diff; no restore/preview; `assistant:` commits may hold user edits (`add -A`); scheduled runs never checkpoint. EDITOR-6. |
| Create-and-link from menu | partial | medium | `[[`/`@` link existing pages only. EDITOR-7. |
| Section / node links | **broken** | medium | `[[page#Heading]]` dangles; backlink lost. EDITOR-13. |
| `@` buckets, live pills, hover, embed | partial | medium | Live chips; no hover card or page embed. |
| Persisted block ids | none | medium | BlockNote UUIDs regenerate per parse. Anchor by quote instead; Obsidian `^id` if block links are wanted. |
| Checkbox → task | partial | low | Doc tasks roll up to Home / My work; no promotion. EDITOR-8. |
| Continue writing | none | low | EDITOR-12. |
| Outline | different-by-design | low | Side-panel tab, not a rail; misses headings inside columns (`src/editor/DocOutline.tsx:31-41`). |
| Blame tooltip | none | low | Would need git blame → blocks. |
| Inline AI fast mode | already-better | low | Ask AI has per-hunk accept/reject (M17.16). |
| Export / copy | already-better | low | The file is the markdown. |
| Backlink tracking table | already-better | low | Derived per scan; no second store. |
| Snippets / `#` tags | partial | low | Slash templates; tags in frontmatter. |
| Realtime CRDT, presence, WAL | different-by-design | low | Single-user, disk canonical. EDITOR-9 skip. |
| Two dialects + version guard | different-by-design | low | One legible dialect; unknown tagged fences byte-stable. EDITOR-10 skip. |
| Collab surfaces | different-by-design | low | Every record is a page with a body. |
| Comment-only permission | different-by-design | low | Agents narrowed by tool grants. |
| DOCX editor | absent | low | Out of scope. |
| PR diff viewer | partial | low | Belongs to `10-coding.md`. |

## 6. Port candidates

| id | title | mode | fidelity | effort | value | Macro guide (read first) | Cerebro target | depends |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| EDITOR-11 | Agent writes reach the open page; flush before a turn | rebuild | inspire | S | high | `services/sync-service/src/socket/protocol.rs` (ack-after-durable) | `src-tauri/src/mcp.rs` (call_tool, `notify_vault_changed`), `src-tauri/src/vault/write.rs`, `src/agent/useAgentChat.ts`, `src/editor/NoteBodyEditor.tsx` | — |
| EDITOR-1 | Every `/`-insertable block round-trips; fix the AI block | rebuild | inspire | M | high | `packages/lexical-core/transformers/index.ts`, `.../transformers/unknownMention.ts`, `.../LexicalMarkdown/version.ts` | `src/editor/markdown.ts`, `src/editor/blocks.tsx`, `src/editor/MarkdownEditor.tsx`, `src/editor/markdown.test.ts`, `src/editor/NoteBodyEditor.tsx` | — |
| EDITOR-2 | `edit_note` MCP tool: quote-anchored body edits | rebuild | inspire | M | high | `services/ai-editing-worker/src/comment-mark/anchor.ts`, `services/sync-service/README.md:124-138`, `apps/docs/AI/mcp/tools/edit-document.mdx` | `src-tauri/src/mcp.rs`, `src-tauri/src/vault/write.rs`, `src/engine/tools.ts`, `src/agent/useAgentChat.ts`, `src/engine/runLog.ts`, `src/agent/systemPrompt.ts` | EDITOR-11, `09-mcp.md` |
| EDITOR-3 | Apply external writes in place, 3-way merge when dirty, per-hunk revert | rebuild | inspire | L | high | `.../collaboration/reconcile.ts`, `apps/web/src/features/block-md/ai-edit/applyAiOps.ts`, `.../collaboration/undo.ts`, `packages/lexical-core/utils/diffStates.ts` | `src/editor/NoteBodyEditor.tsx`, `src/editor/MarkdownEditor.tsx`, `src/editor/reconcile.ts` (new), `src/engine/hunks.ts`, `src/lib/mockIpc.ts`, `e2e/agent-edit.spec.ts` (new) | EDITOR-11 |
| EDITOR-5 | Find and replace (⌘F) | rebuild | mirror | M | medium | `.../find-and-replace/findAndReplacePlugin.ts`, `.../findAndReplacePlugin.test.ts`, `.../searchHighlightTarget.ts`, `.../getFloatingSearchHighlightStyle.ts`, `apps/web/src/features/block-md/component/FindAndReplace.tsx` | `src/editor/findMatches.ts` (new), `src/editor/FindBar.tsx` (new), `src/editor/MarkdownEditor.tsx`, `src/editor/editor.css` | — |
| EDITOR-7 | Create and link a page from `[[` / `@` | rebuild | adapt | S | medium | `.../plugins/actions/actions.ts`, `.../actions/types.ts`, `docs/AGENT_GUIDE/documents.md` | `src/editor/MarkdownEditor.tsx`, `src/stores/vaultStore.ts`, `src/lib/slug.ts` | — |
| EDITOR-13 | Section/block links resolve, scroll and flash | rebuild | inspire | S–M | medium | `.../plugins/location/locationPlugin.ts:189-291` | `src-tauri/src/vault/parse.rs`, `src-tauri/src/vault/link.rs`, `src/engine/wikilink.ts`, `src/editor/chips.tsx`, `src/editor/DocOutline.tsx` | — |
| EDITOR-4a | Human inline comments + Discussion (sidecar threads) | rebuild | adapt | L | high | `apps/web/src/features/block-write/core/comment-marks.ts`, `.../primitives/create-docx-comments.ts`, `packages/lexical-core/nodes/CommentNode.ts`, `crates/documents/src/domain/comments.rs`, `apps/web/src/features/block-md/comments/messageCommentsResource.ts`, `.../comments/CommentMargin.tsx` | `src-tauri/src/vault/comments.rs` (new), `src-tauri/src/vault/write.rs`, `src-tauri/src/lib.rs`, `src/lib/ipc.ts`, `src/lib/mockIpc.ts`, `src/editor/comments/` (new), `src/editor/SelectionToolbar.tsx`, `src/detail/DocSidePanel.tsx` | EDITOR-3 (dirty fix), owner sign-off |
| EDITOR-4b | Agent comment tools: `comment_on_note`, `resolve_comment` | rebuild | adapt | M | high | `services/ai-editing-worker/src/comment-mark/anchor.ts`, `crates/documents/src/inbound/toolset/comment_on_document.rs`, `.../resolve_document_comment.rs`, `.../read_content.rs` | `src-tauri/src/mcp.rs`, `src/engine/tools.ts` | EDITOR-4a, EDITOR-2 |
| EDITOR-6 | Page history: rendered diff, honest attribution, preview, restore | rebuild | adapt | M | medium | `packages/lexical-core/utils/diffStates.ts`, `utils/buildWhoMap.ts`, `apps/web/src/features/block-md/history/HistoryContext.tsx`, `.../history/HistoryOverlay.tsx` | `src-tauri/src/git/history.rs`, `src-tauri/src/git_commands.rs`, `src/lib/gitIpc.ts`, `src/lib/mockGit.ts`, `src/git/proseDiff.ts` (new), `src/git/InlineDiff.tsx`, `src/git/GitHistoryPanel.tsx`, `src/agent/useJobRunner.ts` | EDITOR-3 |
| EDITOR-8 | Promote a checklist item to a record (capability-gated) | rebuild | adapt | M | low | `.../checkbox-to-task/checkboxParsing.ts`, `.../checkboxToTaskPlugin.ts`, `.../checkboxDetection.ts` | `src/editor/MarkdownEditor.tsx`, `src/engine/tasks.ts`, `src/engine/properties.ts`, `src/stores/vaultStore.ts` | — |
| EDITOR-12 | Continue writing at the caret | rebuild | inspire | S | low | `.../plugins/generate/context.ts:12-43`, `.../plugins/generate/generatePlugin.ts` | `src/editor/MarkdownEditor.tsx`, `src/editor/AskAiPopover.tsx` | — |
| EDITOR-9 | Realtime CRDT collaboration | skip | — | XL | low | `packages/collaboration/src/collab/engine.ts`, `services/sync-service/src/durable_object.rs` | — | — |
| EDITOR-10 | Lexical engine, `<m-*>{json}` dialect, version stamp | skip | — | XL | low | `packages/lexical-core/transformers/index.ts` | — | — |

`.../` = `apps/web/src/lib/core/component/LexicalMarkdown/plugins/` (or `.../LexicalMarkdown/` where noted).
**Sequence (stage 3)**: EDITOR-11 → 1 → 2 → 3 → 5 → 7 → 13 → 4a → 4b → 6 → 8 → 12.

### EDITOR-11 — agent writes reach the open page
- `notify_vault_changed` (`src-tauri/src/mcp.rs:1941-1945`) has had no caller since M6; `write_file` registers MCP
  writes as the app's own (`src-tauri/src/vault/write.rs:116-120`), so the watcher drops them; panel rescans only at
  Done (`src/agent/useAgentChat.ts:261-266`).
- `save_note` has no precondition (`src-tauri/src/lib.rs:98-110`); a user save mid-turn overwrites the agent's write and
  re-baselines (`src/editor/NoteBodyEditor.tsx:191-201`). Silent loss today.
- Fix: emit `vault_changed` (or per-path) after each successful write tool in `call_tool`; flush the open page's pending
  save before a turn. Acceptance: `append_to_note` on the open page mid-turn reloads a clean buffer or raises the banner
  before the user's next save. Kill the falsified comment at `mcp.rs:1941-1942`.

### EDITOR-1 — every block round-trips
- Scope = every block `/` can insert (`src/editor/MarkdownEditor.tsx:933-947`), BlockNote defaults included. Each gets a
  byte-identical, idempotent fixture in `markdown.test.ts` that enumerates the schema, or leaves the menu.
- AI block: demotion pass before serialization (not `toExternalHTML` — the unmount flush cannot render,
  `markdown.ts:282-291`). Pick the carrier (`:::ai` directive per M48 D1, or a `cerebro-ai` fence). Parse the answer into
  markdown blocks instead of one inline string (`MarkdownEditor.tsx:789-796`). Blocks saved since `677e49e` are lost.
- Bare fence: stop defaulting to `javascript` (`node_modules/@blocknote/code-block/src/index.ts:5`, `MarkdownEditor.tsx:62`).
- Add a structural check (block types + count) beside `isLossyImport` (`markdown.ts:717-728`, letters only); fix the
  "raw HTML" banner text (`NoteBodyEditor.tsx:279`). Kill falsified claims: M48 spec §2/D5 (toggles ship),
  `blocks.tsx:185-191`, `markdown.test.ts:646-647`. Confirm in Playwright (DOM trap #1).

### EDITOR-2 — `edit_note`
- `{path, edits:[{old_text,new_text,occurrence?}], expected_sha256?}`: all-or-nothing; frontmatter bytes unchanged;
  missing or ambiguous `old_text` → `isError` listing occurrences by line + context, file untouched.
- Gate on **both** `may_write` and `may_read` (`read_target`, `mcp.rs:1556-1572`): a refusal that lists occurrences is a
  read oracle. Refuse `knowledge/` via `guard_agent_write`; Type/Agent docs via `governed_note_refusal` +
  `governed_append_refusal` on result bytes. `get_note` prints `Body-SHA256`.
- Plain `isError` text, no typed code (no policy bump). `expected_sha256` is advisory unless the owner amends convergent D5.
- Register in `isWriteTool` (`useAgentChat.ts:509-513`) and `writtenPath` (`runLog.ts:165`) — better, derive both from
  `tools.ts` writes flags — or turns never rescan, checkpoint or log.

## 7. Conflicts with Cerebro conventions

| Macro pattern | Cerebro rule | Resolution |
| --- | --- | --- |
| Loro CRDT is the store; markdown a projection | Vault on disk is canonical (convergent D1) | No persisted CRDT (EDITOR-9 skip). Concurrency via notify + in-place merge (EDITOR-11, -3). |
| CAS `expectedRevision` on every write | Convergent D5: `expected_version` is ledger-only; vault files last-write-wins | `expected_sha256` advisory until the owner amends D5. |
| Threads in Postgres, marks in the CRDT | Files-first; two records, two destinies | Threads in a vault sidecar, never ledger or `runtime.db`. Marks never written to markdown; re-resolved by quote. Sidecar location is an owner call: `.cerebro/` is git-ignored (`src-tauri/src/git/commit.rs:21,49`); dot-dirs are skipped by scanner and watcher. |
| Comments as a feature | M47 §9 lists comments as a non-goal; M33b D8 (no new chat surface) | EDITOR-4 needs owner sign-off amending both. |
| AI edits stream in, no accept/reject | M17 D3: per-hunk accept/reject, no streaming | One transaction + per-hunk revert (EDITOR-3); continue-writing lands as explicit accept (EDITOR-12). |
| `<m-*>{json}` internal dialect | Legible files (M2, M48 D1) | Text carriers, fences, directives only; enforced by EDITOR-1. |
| Routing on `blockName` / sub type | No type special-casing | Gate on capability (status field, `peopleTypes`). |
| Typed HTTP 422/409 refusals | Every refusal code has a declared destiny | Plain `isError` text as base write tools do (`mcp.rs:1536-1544`); `stale_view` means verified-body drift, don't reuse it loosely. |
| Comment mentions notify | Nothing speaks first | No notifications or unread badges. |
| Comment UI on a failed read | Unavailable is never empty | Failed sidecar read → `section-unavailable`. |
| Comment ops enter undo, fire onChange | Saves are byte-stable; dirty means changed | `ThreadStore.addThreadToDocument` applies marks with `addToHistory:false`; dirty = serialization ≠ lastSaved. |
| Rust + TS anchoring twins | Policy is data; twins need shared artifacts | Shared golden fixtures for the markdown → visible-text projection. |
| apps/web "All rights reserved" | Apache-2.0 | Behaviour guide only; reuse BlockNote's MPL-2.0 comment UI; export `hunks.ts` LCS rather than lift loro-mirror. |

## 8. Verification notes (stage 3)

- **Refuted** — "lossy imports lock read-only, so the dialect is already-better": `isLossyImport` counts letters and
  digits only (`src/editor/markdown.ts:717-728`); toggle/heading-toggle/nesting/file/caption/math/fold losses pass
  silently. Row downgraded to partial; EDITOR-1 widened to M.
- **Refuted** — M48 "toggle lists already ship": they do not survive a save.
- **Refuted** — EDITOR-2 risk "agent edit remounts or raises the banner": nothing calls `notify_vault_changed`; the
  user's next save silently overwrites. New EDITOR-11.
- **Refuted** — Macro find has regex: `findAndReplacePlugin.ts:121` escapes input, `'gi'`. EDITOR-5 mirror drops regex and
  case toggle. Guide is 1,344 LOC (899 plugin + 445 UI), not ~900.
- **Refuted** — EDITOR-3 e2e via `__cerebroMockFs` alone: `modifiedAt` moves only through `touch()`
  (`src/lib/mockIpc.ts:76,150-157`); needs a write seam.
- **Refuted** — `write_target` scoping suffices for `edit_note`: read and write scopes are independent (`mcp.rs:88-95,141-150`).
- **Refuted** — AI block answer "is ordinary markdown": it is one inline string (`MarkdownEditor.tsx:789-796`).
- **Corrected** — AI block loss: prompt text survives glued to "Recompute"; reload gives 3 paragraphs, not 5; no lock.
- **Corrected** — `CommentMark` keeps bytes stable and needs no Yjs, but comment ops enter undo and fire `onChange`,
  leaving the page sticky-dirty (`MarkdownEditor.tsx:356-361,404-413`).
- **Corrected** — programmatic `replaceBlocks` keeps caret and stays its own undo group (jsdom only); applies still fire
  `scheduleEmit`/`onDirty`. The prior pass's "within 500 ms PM history merges" is wrong.
- **Corrected** — tagged fences byte-stable; bare fences become `javascript` and falsely lock.
- **Corrected** — highlights: overlay rects work; `CSS.highlights` needs Safari 17.2+, floor is macOS 10.15
  (`src-tauri/tauri.conf.json:47`).
- **Corrected** — loro-mirror `diffMovableList` needs an idSelector and emits Loro ops; only LIS is generic. Use
  `src/engine/hunks.ts:49` LCS.
- **Corrected** — Macro's "every node ships a transformer" is convention, untested; `MARK_XML` export returns null,
  `UNKNOWN_MENTION` drops payload.
- **Corrected** — EDITOR-2's guide is Claude Code's Edit; Macro's `EditDocument` is a natural-language worker
  (fidelity → inspire). Macro supplies refuse-don't-guess and CAS.
- **Corrected** — "assistant turns get their own commits": scheduled runs only rescan (`src/agent/useJobRunner.ts:270-295`),
  and `git add -A` (`commit.rs:65,72,105`) can fold user edits into `assistant:` commits.
- **Corrected** — stage 2 cited D2 for "mtime is never evidence"; that is D4, and it missed D5.
- **Confirmed** — no in-place body edit tool; CLI writers off by default (`uiStore.ts:936`). BlockNote comments
  (MPL-2.0) installed, unused. No ⌘F handler (`src/App.tsx:296-354`; shipped app not built).
- **Unverifiable** — whether the owner wants threads synced via git; whether agents quote raw markdown (`get_note` is
  raw; Macro anchors in rendered text). Both are design gates for EDITOR-4.
- **Owner gates** — D5 amendment; M47 §9 + M33b D8 amendment; sidecar location; anchor text space.

## 9. Where to read first

1. `services/ai-editing-worker/AI_EDITING.md`
2. `services/ai-editing-worker/src/comment-mark/anchor.ts`
3. `apps/docs/AI/mcp/tools/comment-on-document.mdx`
4. `packages/lexical-core/nodes/CommentNode.ts`
5. `crates/documents/src/domain/comments.rs`
6. `apps/web/src/features/block-write/core/comment-marks.ts`
7. `apps/web/src/lib/core/component/LexicalMarkdown/collaboration/reconcile.ts`
8. `apps/web/src/features/block-md/ai-edit/applyAiOps.ts`
9. `services/sync-service/README.md` (CAS, §124-138)
10. `packages/lexical-core/transformers/index.ts`
11. `apps/web/src/lib/core/component/LexicalMarkdown/plugins/find-and-replace/findAndReplacePlugin.ts`
12. `packages/lexical-core/utils/diffStates.ts`
13. `apps/web/src/lib/core/component/LexicalMarkdown/plugins/actions/actions.ts`
14. `apps/web/src/lib/core/component/LexicalMarkdown/plugins/checkbox-to-task/checkboxParsing.ts`
15. `docs/AGENT_GUIDE/documents.md`
