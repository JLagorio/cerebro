# Macro reference — Work management: tasks, projects, initiatives, the Soup query layer, work feed

**Date:** 2026-10-12 · **Source:** `docs/examples/macro-main/` (all Macro paths below are relative to it; Cerebro paths are relative to the repo root)
**Rule (owner, 2026-10-12):** Cerebro builds its own version, Macro is the guide, never a 1:1 copy.
**Licenses:** `crates/*` AGPL-3.0 (`LICENSE.txt`); `apps/web/` all rights reserved (`apps/web/LICENSE`); `filter_ast`, `predicate_index` are `publish=false`; Cerebro Apache-2.0. Every port is design-level. `crates/task_dedup/fixtures/eval/prod_*` hold real employee identities: never copy, synthetic only.

---

## 1. What it is

- A task is a markdown Document with `document_sub_type = 'task'`. Every task field is a system property in `entity_properties`, keyed by well-known UUIDs `00000001-…-01..14`.
- User-facing "Projects" are the backend **initiative** entity. A task joins one through the single-valued Project property (`0x14`). The legacy `projects` crate is folders.
- **Soup** is the one cross-entity list engine. One filter AST compiles to Postgres SQL on the server (fan-out legs, merged by a keyset paginator) and to a predicate IR over a client SQLite fact index (wasm/Tauri), reconciled all-or-network.
- The **work feed** (Home) merges attention (live notifications) with own work (activity) in one exactly-once keyset query, with stacking and revision-bound done/undo.

## 2. What users get

| Feature | UX details / shortcuts | Read |
| --- | --- | --- |
| Task composer | `c t`, the Tasks sidebar New button, or Create → Task. Title, description, Status (default Not Started), Priority, Assignees (default self; people and agents), Due, Project, Tags, attachments. Create More, "Continue editing in split", "Share with <team>" (localStorage). Ctrl+Enter submits. If Project fails, the task is still created and a toast says so. Touch = bottom sheet. One backend call: doc + properties + team share + team number. | `docs/AGENT_GUIDE/tasks.md`, `apps/docs/product/tasks.mdx`, `crates/documents/src/inbound/axum_router/create_task.rs` |
| Other creation paths | `/task` slash action. Checklist → task (item replaced by a task mention; Parent Task set inside a task; >97 graphemes truncated, full text to body). Channel message / email thread "Create task" (body = a mention of the source; no origin FK). Channel Task Mode. Linear import. Project "New task" (Project preset). Agents via `CreateDocument isTask=true`. | `apps/web/src/lib/core/component/LexicalMarkdown/plugins/checkbox-to-task/checkboxToTaskPlugin.ts`, `apps/web/src/lib/core/util/taskCreation.ts`, `apps/web/src/lib/core/util/taskExtraction.ts`, `apps/web/src/features/channel/Channel/Channel.tsx`, `apps/web/src/features/block-email/EmailThreadHostView.tsx`, `crates/documents/src/inbound/toolset/create_document.rs` |
| Task properties | Status: Not Started / In Progress / In Review / Completed / Canceled. Priority: Urgent / High / Medium / Low. Assignees (users + agents), Due, Project, Tags (personal/team, shared across entity kinds), Parent Task, Subtasks, Depends On, Effort, Story Points, Relevant Documents. Team numbers → `PREFIX-N`. GitHub PR events move status. Pills under the title and in hover cards, edited in place; optimistic, rolled back on failure. | `crates/system_properties/src/domain/model/constants/system_property_key.rs`, `crates/system_properties/src/domain/model/constants/options/status.rs`, `crates/macro_db_client/migrations/20251128000001_seed_system_properties.sql`, `crates/macro_db_client/migrations/20260305182148_track_task_with_pr.sql` |
| Tasks view | Tabs My tasks / Created by me / Team tasks / Projects. List or Board. Group none/status/priority/assignee/project/date; sort updated/created/viewed. Facets Status, Priority, Assignee, Created by, Tags (any/all). Defaults: my-tasks, group priority, active statuses. State in `tasks.*` URL params + per-split persistence. Board drag (10px threshold) rewrites the group property; columns virtualized at 336px; hidden-lanes summary; H/← collapses a group. Bulk delete handles partial failure. | `apps/web/src/features/tasks-view/tasks-view.tsx`, `.../queries/task-query.ts`, `.../filters/task-facets.ts`, `.../components/task-board.tsx`, `.../persistence.ts` |
| Filter with AI | Plain-English box atop the Filter menu → facet selection (status, priority, assignees, createdBy, tags, search). Exclusions → complements. Unmappable parts in a muted "unresolved" note; no mapping → red error. gpt-4o-mini, strict JSON schema. | `apps/web/src/features/tasks-view/filters/ai-task-filter.ts`, `.../queries/ai-task-filter-plan.ts` |
| Duplicate detection | Draft-time similar tasks (max 2 shown, 300ms debounce, nothing persisted). After `POST create_task`, an async judged pipeline; ≤10 active matches per task; dismiss or "delete this duplicate"; live `task_duplicate_matches_updated`. Agent creates are not deduped. | `crates/task_dedup/src/domain/service.rs`, `crates/task_dedup/src/outbound/judge.rs`, `crates/documents/src/inbound/axum_router/task_duplicates.rs`, `apps/web/src/features/block-md/component/TaskDuplicateList.tsx` |
| Projects collection | Projects tab (PostHog `enable-projects`). Rows from Soup `initiativeFilter`. Group status/priority/assignee/none; facets incl. absolute due range; context menu rename/status/priority/delete/share; bulk. Create `C P`, all-or-nothing with properties; toast Open / Open (New Split). | `apps/web/src/features/projects/views/projects-collection.tsx`, `.../queries/project-soup.ts` |
| Project detail | Overview: title, pills, collaborative description, discussion (oldest first). Tasks: scoped list/board, search, Add existing (multi-pick), New task (preset). Route `initiative-view~<id>~overview\|tasks`. Group cursors auto-drain (no Load More). Partial failures keep only failed tasks selected. Owner delete leaves tasks. | `apps/web/src/features/projects/project-detail.tsx`, `.../views/project-workspace.tsx`, `.../views/add-project-tasks.tsx`, `.../queries/project-tasks.ts` |
| Agent assignment | Assigning an agent starts its task session; the session link posts to the task Discussion. Project-level agent assignees take tasks created in or moved into the project. Unchanged re-save does not restart; remove + re-add does. No status gating. | `crates/agent_trigger/src/domain/task_assignment.rs`, `crates/agent_trigger/src/domain/broker_events.rs`, `crates/macro_db_client/migrations/20261009161100_agent_session_task_id.up.sql` |
| Home work feed | Attention + own work, stacked per thread. Done `e` / Undo, live across sessions, filters by type and Unread/Read/All. Sections Last few minutes / Last hour / This morning … / Yesterday / older. Done acknowledges only observed notifications and archives inbox email; own work stays, marked seen. j/k + preview pane; retry per failed source. | `crates/work_feed/src/lib.rs`, `crates/graphql_work_feed/src/lib.rs`, `apps/web/src/features/home/work-feed/primitives/work-feed.ts`, `docs/AGENT_GUIDE/surfaces.md` |
| Agent `ListEntities` | Agents write the compact AST directly (`df/pf/cf/ef/propf`, `&,|,!,l`). The tool text teaches `{'l':{'dst':'task'}}` and Status/Assignees UUIDs. No cursor: `has_more` prose only. | `crates/soup/src/inbound/toolset/list_entities.rs`, `apps/docs/AI/mcp/tools/list-entities.mdx` |
| Project MCP tools | Create/List/Read/Update/Delete Initiative, UpdateInitiativeSharing, ReadInitiativeActivity (≤100 events scanned per page; follow `nextCursor` past empty pages). Membership via SetEntityProperty on Project. | `crates/initiative/src/inbound/toolset.rs`, `apps/docs/AI/mcp/tools/read-initiative-activity.mdx` |
| Team task slugs | `/<PREFIX-N>` (GitHub autolinks) → `/task/<documentId>`; pre-login redirect kept; NOT_FOUND and FORBIDDEN both read "Task not found". | `apps/web/src/routes/TaskRoute.tsx`, `crates/macro_db_client/migrations/20260520130000_create_team_task.sql` |
| Folders (legacy "project") | Containers for docs/chats/emails, folder upload, soft-delete trees + restore; MCP CreateProject/ReadProject/MoveToProject. | `crates/projects/src/domain/models.rs`, `apps/web/src/features/block-project/definition.ts` |

## 3. How it's built

**Architecture.** Hexagonal Rust crates behind GraphQL/REST, composed in `services/document_storage_service/src/server.rs` (SoupImpl, SoupRealtimeServiceImpl, WorkFeedServiceImpl, TaskDedupService). Soup fans out with `tokio::join!` to ~8 legs (pg dynamic SQL for documents/chats/projects/initiatives/database rows; email; channels; threads; calls; CRM; foreign/GitHub), each returning ≤`limit` past a shared keyset, merge-sorted by a typed Paginator. The same AST feeds client evaluation: `graphql_soup_filter_input` (wasm) → `item_filter_index` → `predicate_index` IR → `crates/client/cache-turso` SQL, linked into the browser worker and the Tauri plugin (`apps/web/tauri/graphql_cache_plugin/src/engine/soup.rs`). Realtime: Kafka → `soup_realtime` → per-user broadcast → `soupUpdates` hydrated through Soup. Initiatives are a separate domain reusing properties, messages, activity and collab_surface. Frontend (SolidJS): `features/tasks-view` and `features/projects` build ASTs through `features/soup` facets; `lib/queries/soup` owns transport, authority, reconciliation, optimism.

| Unit | Path | Role | LOC |
| --- | --- | --- | --- |
| soup | `crates/soup` | Fan-out query service; pg dynamic SQL (TopItems keyset `(sort_ts,id)`, `entity_access` semi-join); grouped (10/group via window fns); touched/notified/work-feed candidate SQL; REST; ListEntities | 33102 |
| filter_ast | `crates/filter_ast` | `Expr<B>{And,Or,Not,Literal}`, serde tags `&,|,!,l`, recursion-scheme folds | 142 |
| item_filters | `crates/item_filters` | `EntityFilters` (typed) and `EntityFilterAst` (one tree per partition: df, pf, cf, ef, … propf); opt-in partitions | 4775 |
| graphql_soup_filter_input | `crates/graphql_soup_filter_input` | GraphQL/serde filter input → AST; wasm without `server`; bounds depth 64, 4096 nodes, 16KiB/string, 256KiB | 1762 |
| predicate_index | `crates/predicate_index` | Storage-neutral IR (`All/None/Exact/I64Range/ExactExists/And/Or/Not/After`), bounds (depth 64, 2048 nodes, limit 500), optimistic shadow types, `evaluate_reference` oracle | 1450 |
| item_filter_index | `crates/item_filter_index` | Versioned profile compiler (`soup-flat-v1..v6`); `check_*` → Supported/Unsupported reason; `proves_none` (NIL id = empty partition) | 2293 |
| soup_filter_projection | `crates/soup_filter_projection` | Item → facts; server-minted `cacheProjection` capsules (postcard, ≤1024B) | 2214 |
| soup_filter_cache_adapter | `crates/soup_filter_cache_adapter` | Filter JSON → `ValidatedIndexQuery`; authoritative/optimistic mutations; reconciliation baselines | 8989 |
| soup_realtime | `crates/soup_realtime` | Kafka → `Patch::Updated\|Deleted(Entity)`, access-expanded, recipient-keyed, at-least-once | 3408 |
| models_soup | `crates/models_soup` | `SoupItem` enum (14 kinds); `SoupDocumentSubType::Task{is_completed}` | 2572 |
| graphql_soup | `crates/graphql_soup` | `user.soup`, `groupSoup`, `soupUpdates` (drain 10, dedupe, hydrate via `SoupItemLoader`, ≤500 keys) | 4781 |
| models_pagination | `crates/models_pagination` | Typed keyset paginator; Base64 JSON cursor `{id, limit, val, filter}` (full filter, stateless) | 995 |
| models_grouping | `crates/models_grouping` | `GroupByField{Date,EntityType,Project,Property}`; backward-looking date buckets (UTC `CURRENT_DATE`) | 288 |
| work_feed | `crates/work_feed` | Feed domain: identity, policy, scoping, stacking, Unseen/Seen, page/recompute/mark_done/undo_done; 5 ports | 3208 |
| graphql_work_feed | `crates/graphql_work_feed` | Page (50, max 100), done (≤200)/undo mutations, `workFeedUpdates` (300ms coalesce) | 1100 |
| initiative | `crates/initiative` | Projects domain: UUIDv7, grapheme limits 100/2000, compensating create, sharing, in-memory keyset pages, history | 8968 |
| initiative_description | `crates/initiative_description` | Description = collab surface keyed by initiative id | 225 |
| graphql_initiative | `crates/graphql_initiative` | Typed mutations/queries, DataLoaders; NOT_FOUND/FORBIDDEN/BAD_USER_INPUT/CONFLICT | 1724 |
| projects | `crates/projects` | Legacy folders (S3/DynamoDB/SQS) | 12684 |
| task_dedup | `crates/task_dedup` | embed → pgvector → Cohere rerank → LLM judge → closure; draft `similarity_search`; eval harness | 7355 |
| tasks-view | `apps/web/src/features/tasks-view` | `buildTaskQuery`, facets, board grouping/optimism, auto-drain, AI filter | 9826 |
| projects (web) | `apps/web/src/features/projects` | Collection, detail, scoped task source, `assignProjectTasks` (25 concurrent) | 9745 |
| soup (web) | `apps/web/src/features/soup` | Facets → server AST + client predicate (`compileFacets`, `testFacets`, `confine`); rows | 4135 |
| next-soup | `apps/web/src/features/next-soup` | Generic list shell, presets, mark done/undo, hotkeys | 36929 |
| lib/queries/soup | `apps/web/src/lib/queries/soup` | REST vs GraphQL, live query, predicate view, reconciliation (≤5000 baseline keys), optimistic overlays | 22913 |
| block-project / block-initiative | `apps/web/src/features/block-project`, `.../block-initiative` | Folder block / flag-gated ProjectDetail wrapper | 1155 / 184 |
| lib/queries/initiative, history | `apps/web/src/lib/queries/initiative`, `.../history` | Share wrappers / recently viewed | 15 / 1163 |
| TaskRoute | `apps/web/src/routes/TaskRoute.tsx` | `PREFIX-N` → canonical redirect | 98 |

**Data model.**

| Entity | Storage | Key fields | Path |
| --- | --- | --- | --- |
| Task | `Document` + `document_sub_type(task)` + markdown; props in `entity_properties` | id, owner, projectId (folder), timestamps | `crates/macro_db_client/migrations/20251204165917_create_document_task_table.sql` |
| Properties | `property_definitions`, `property_options`, `entity_properties` (JSONB union; UNIQUE entity+type+def) | System UUIDs `…01` Assignees, `02` Status, `03` Priority, `04` Due, `05` Parent, `06` Subtasks, `07` Depends On, `08` Effort, `09` Story Points, `0a` Relevant Docs, `0b` Source, `0c` Companies, `14` Project | `crates/macro_db_client/migrations/20251030100000_init_properties_schema.sql` |
| Task → Project | `entity_properties` row, prop `0x14` (ENTITY, single, INITIATIVE) + partial GIN | legacy `task_initiative` backfilled, not dropped | `crates/macro_db_client/migrations/20261003040141_task_project_property.up.sql` |
| Initiative | `initiative` + `initiative_member` + SharePermission; description in collab surface | id UUIDv7, name, owner | `crates/macro_db_client/migrations/20260910144344_create_initiative.sql` |
| Team task number | `team_task` + `team_task_counter` | per-team monotonic → `PREFIX-N` | `crates/macro_db_client/migrations/20260520130000_create_team_task.sql` |
| Duplicates | `task_duplicate_embedding` (vector 1536, ivfflat) + `task_duplicate_match` | `task_id < duplicate_task_id`, active/dismissed, judge_reason | `crates/macro_db_client/migrations/20260528120000_task_duplicate_detection.sql` |
| Notifications | `notification` + `user_notification` (unseen/seen/done) | event + secondary event item | `crates/macro_db_client/migrations/20260909141557_user_notification_state.up.sql` |
| Activity | `activity_events`, append-only, uuidv5 ids | actor, subject, action, entity, occurred_at | `crates/macro_db_client/migrations/20260805180315_create_activity_events.sql` |
| Agent session ↔ task | `agent_session.task_id` FK, ON DELETE SET NULL | one task per session | `crates/macro_db_client/migrations/20261009161100_agent_session_task_id.up.sql` |
| Client fact index | Turso/SQLite: `index_documents`, exact/integer/sort facts + optimistic shadows | record_key, profile, partition, attribute, value | `crates/client/cache-turso/src/storage.rs` |

**Key flows.**

1. **Server Soup page.** `user.soup({filters, sort, limit})` → materialize AST → `get_user_soup_internal` clamps limit 1..500, builds leg requests → `tokio::join!` of pg dynamic SQL (`keyset (sort_ts,id) < ($4,$5)`) and legs → `paginate_on().filter_on().sort().into_page()` → cursor = Base64 JSON. (`crates/graphql_soup/src/resolvers.rs`, `crates/soup/src/domain/service.rs`, `crates/soup/src/outbound/pg_soup_repo/expanded/dynamic.rs`, `crates/models_pagination/src/cursor.rs`)
2. **Client local evaluation.** `buildTaskQuery` (non-task partitions confined by NIL ids) → live query fills cache → `cacheHost.entityFilter` → adapter compiles → eligibility check → SQL over authority ∪ complete shadows; uncertain → unsupported → result `reconciled {keys, retainedKeys, revision}`; a fresh network page retakes authority. (`apps/web/src/lib/queries/soup/graphql/create-predicate-query.ts`, `.../reconciliation.ts`, `apps/web/docs/optimistic-predicate-fact-index-plan.md`, `apps/web/docs/local-predicate-pagination-plan.md`)
3. **Optimistic edit.** Pill/drag → SetEntityProperty → durable queue + shadow facts in one txn → revision bump → live queries recompute membership; rollback restores value, group and counts. (`apps/web/src/lib/queries/soup/grouped/graphql-optimistic.ts`, `apps/web/src/features/tasks-view/core/task-board-optimism.ts`)
4. **Realtime.** Domain event → `SoupRealtimePatch` → recipient-keyed publish → broadcast → `soupUpdates` hydrates via Soup itself; missing after hydration = omitted, not deleted. (`crates/soup_realtime/src/domain/service.rs`, `crates/graphql_soup/src/loaders.rs`)
5. **Work feed.** `workFeed(scope, limit, after)` → `query.sql`: attention stream ∪ own-work stream, each keyset-ordered, a candidate emitted only by the stream holding `sort_at = max(...)` → per-type gates → hydrate, refill rounds → assemble (scope, stack, reason). `workFeedUpdates`: triggers name keys → 300ms batch → recompute → Upserted/Removed/Invalidated. Done(targets, `attention_through`) → receipt; undo reverses exactly the receipt. (`crates/soup/src/outbound/pg_soup_repo/work_feed/query.sql`, `crates/work_feed/src/domain/service.rs`, `crates/work_feed/src/domain/stacking.rs`, `crates/graphql_work_feed/src/subscriptions.rs`)
6. **Create + dedup.** `POST create_task` → doc + properties + share → spawn detection: embed → pgvector (owner/team, 24 candidates) → rerank → top 10 → judge (4 concurrent, fail-closed) → component closure → upsert pairs → trim 10 → notify. (`crates/documents/src/inbound/axum_router/create_task.rs`, `crates/task_dedup/src/domain/service.rs`)
7. **Agent assignment.** Property-update event → set difference of bot assignees → replay-stable discussion id + `assignment_has_session` check → session with a prompt telling the agent to update status. (`crates/agent_trigger/src/domain/task_assignment.rs`, `crates/agent_trigger/src/domain/task_assignment/prompt.md`)

## 4. Ideas worth stealing (ranked)

1. **Multi-value bands with delta moves.** A card sits in every band of its values; a move changes only the source value. Why: Cerebro silently drops co-assignees today. `apps/web/src/features/tasks-view/core/task-board.ts`
2. **Unknown is never absence (all-or-network).** Evaluate only when every literal/partition is supported; else Unsupported with a reason. Why: same ethic as "unavailable is never empty"; a model for `query_records` refusals. `crates/item_filter_index/src/lib.rs`
3. **One filter grammar for UI and agents.** Agents query with the AST the views use. Why: Cerebro agents have full-text search only. `crates/soup/src/inbound/toolset/list_entities.rs`, `apps/docs/AI/mcp/tools/list-entities.mdx`
4. **Reference evaluator as conformance oracle.** Why: fits Cerebro's goldens practice if a Rust twin is ruled in. `crates/predicate_index/src/lib.rs`
5. **Exactly-once two-stream feed.** `sort_at = max(attention_at, touched_at)`, newer stream owns the row. `crates/soup/src/outbound/pg_soup_repo/work_feed/query.sql`
6. **Revision-bound done with exact undo receipts.** `crates/work_feed/src/domain/models.rs`, `crates/work_feed/src/domain/service.rs`
7. **Trigger-and-recompute live updates.** Triggers name keys only; recompute from storage; 300ms coalesce; Invalidated → refetch. Why: matches watcher + rescan. `crates/graphql_work_feed/src/subscriptions.rs`, `crates/work_feed/src/outbound/triggers.rs`
8. **Membership as a property.** Task → project is a single-valued ref, so every list, board and tool works unchanged. Why: matches relations + "no type special-casing". `crates/macro_db_client/migrations/20261003040141_task_project_property.up.sql`, `apps/web/src/features/projects/queries/project-tasks.ts`
9. **Closed-vocabulary AI filter.** LLM returns option ids under a strict schema; exclusions as complements; unmappable → "unresolved"; never fall back to free text. `apps/web/src/features/tasks-view/filters/ai-task-filter.ts`
10. **Checkbox → task promotion with backlink.** `apps/web/src/lib/core/component/LexicalMarkdown/plugins/checkbox-to-task/checkboxToTaskPlugin.ts`
11. **Per-record bulk results; failures stay selected.** `apps/web/src/features/projects/core/assignment.ts`
12. **Notification stacking** (per thread; mentions shadow their message; shadowed items stay in done scope). `crates/work_feed/src/domain/stacking.rs`
13. **Ingress bounds on filters** (depth, nodes, string and total size). `crates/graphql_soup_filter_input/src/lib.rs`
14. **Honest history paging** (scan ≤N, may return fewer, cursor advances past empty pages). `crates/initiative/src/domain/history.rs`
15. **Compensating create** (seed description, create, properties all-or-nothing, else delete + retire). `crates/initiative/src/domain/service.rs`
16. **Fail-closed dedup judge + labeled eval corpora** (recall@k, threshold sweeps). `crates/task_dedup/src/outbound/judge.rs`, `crates/task_dedup/tests/eval/main.rs`
17. **Name-sort cursor anchors** that fail with "restart pagination" on rename. `crates/initiative/src/domain/service/reads.rs`
18. **Auto-drain independent cursor chains.** `apps/web/src/features/tasks-view/queries/automatic-task-pagination.ts`

## 5. Cerebro today vs Macro

| Macro feature | Cerebro status | value | note |
| --- | --- | --- | --- |
| Soup cross-entity engine | different-by-design | low | `resolveSurface` + `evaluateFilters` over the in-memory corpus is the one engine (`src/engine/surface.ts:151`, `viewFilters.ts:491`) |
| Client fact index, shadows, reconciliation | different-by-design | low | No server authority; files are truth |
| Realtime patches | different-by-design | low | fs watcher → rescan (`src-tauri/src/vault/watcher.rs`) |
| ListEntities (agents query with the view grammar) | absent | high | MCP has `search_notes` (query required) only (`src-tauri/src/mcp.rs:748-922`). WORK-2 |
| SetEntityProperty, typed | partial | medium | `update_frontmatter` runs only governed/knowledge guards (`mcp.rs:2656-2678`); a label status drops the record from My work. WORK-3 |
| Agent assignment starts work | partial | high | `changed`+`to` triggers: one event per agent per scan, 15-min cooldown, `created`+`field` never fires, `to:` compares the joined list. WORK-4 |
| Board multi-value bands + delta moves | partial | high | First-value banding; a move overwrites the list; multiselect refused (`grouping.ts:19-23,164-167`; `BoardView.tsx:228-261`). WORK-1 |
| Date grouping / buckets | absent (by choice, M20.5) | medium | date/daterange `groupable:false` (`properties.ts:252,264`); `dueBucket` exists for doc tasks (`tasks.ts:87-95`). WORK-5 |
| Due dates on Home / My work | partial | high | Home = doc checklists only; My work shows title + status; FLD-4 (due 2026-07-24) never reaches Home. WORK-5 |
| Relative date filters | absent (Macro too) | medium | Absolute dates only (`dates.ts:251-255`). WORK-14 |
| My / Created by me / Team tabs | different-by-design | low | M43: single user, no assignee concept |
| Task composer | partial | medium | Title + type only; stale dialog copy. WORK-8 |
| Checkbox → task | absent | medium | WORK-6 |
| Channel/email/Linear → task | absent | low | Other domains (comms, email, integrations) |
| Duplicate detection | absent | medium | Agents DO create records (`demo-vault/.../release-scout.md:21-22`); `create_note` silently writes `-2` (`vault/write.rs:735-748`). WORK-12 |
| Filter with AI | absent | low | WORK-10 |
| Projects collection + detail | partial | medium | Only Epic → Work items is real. Work item has no project relation; Project has no tabs; `project.md:19` prose is stale. WORK-16 |
| Add existing; bulk set with partial failure | partial | medium | Bulk bar = Copy links / Duplicate / Delete; Delete/Duplicate clear all selection on partial failure (`TableView.tsx:2280-2311`). WORK-7 |
| Home work feed | absent (scoped out, M43) | medium | LearnedCard is "the one thing Home is allowed to volunteer" (`LearnedCard.tsx:13-20`). WORK-9 |
| `PREFIX-N` keys + slug resolution | partial (dead) | low | Minting unreachable: every `createTarget` caller passes `project:null`; `resolveTarget` has no key pass (`wikilink.ts:58-71`). WORK-15 |
| GitHub PR → status | absent | low | Coding / integrations domains |
| Parent / Subtasks / Depends on | different-by-design | low | Relations, `blocked_by`, relation nesting, gantt `dependencyField` |
| Tags across every entity kind | different-by-design | low | Per-database multiselect; M47 D3 |
| Recently viewed / frecency | absent | low | History = git pulse; fold into SEARCH-4 (`12-search.md`) |

## 6. Port candidates

| id | title | mode | fidelity | effort | value | Macro guide (read first) | Cerebro target | depends |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| WORK-1 | Multi-value bands and delta moves on boards/lists/charts | rebuild | adapt | M | high | `apps/web/src/features/tasks-view/core/task-board.ts`, `.../core/task-board-optimism.ts`, `.../queries/task-board.ts` | `src/engine/grouping.ts`, `src/views/BoardView.tsx`, `ListView.tsx`, `GalleryView.tsx`, `ChartView.tsx`, `src/engine/chart.ts`, `createRecord.ts`, `rows.ts` | — |
| WORK-5 | Declared `deadline:` + relative date buckets on My work / Home | rebuild | inspire | L | high | `crates/models_grouping/src/date_buckets.rs`, `apps/web/src/features/home/queries/home-date-buckets.ts`, `apps/web/src/features/soup/collection/date-buckets.ts` | `src/engine/types.ts`, `schema.ts`, `grouping.ts`, `views.ts`, `tasks.ts`, `myWork.ts`, `src/pages/MyWorkPage.tsx`, `HomePage.tsx`, `src/hooks/useDocTasks.ts`, `src-tauri/src/mcp.rs` (context key list) | — |
| WORK-2 | `query_records`: the saved-view grammar as an agent tool (= DATA-8) | rebuild | adapt | XL (twin) / L (bridge) | high | `crates/soup/src/inbound/toolset/list_entities.rs`, `crates/item_filter_index/src/lib.rs`, `crates/predicate_index/src/lib.rs`, `crates/graphql_soup_filter_input/src/lib.rs` | `src-tauri/src/mcp.rs`, `src-tauri/src/vault/query.rs` (new), `shared/views/filter-goldens.v1.json` (new), `shared/schema/default-statuses.v1.json` (new), `src/engine/viewFilters.ts`, `surface.ts`, `tools.ts` | owner ruling (twin/bridge/WASM); DOMAIN:mcp |
| WORK-4 | Assign a record to an agent: state-derived lane (= AUTOMATION-5) | rebuild | adapt | L | high | `crates/agent_trigger/src/domain/task_assignment.rs`, `crates/agent_trigger/src/domain/project_assignment.rs`, `crates/agent_trigger/src/domain/broker_events.rs` | `src/engine/jobs.ts`, `triggers.ts`, `src/agent/useJobRunner.ts`, `src/engine/runLog.ts`, `src/detail/RelationPicker.tsx`, `src/library/AgentEditor.tsx` | WORK-3; uncommitted AUTOMATION-2/2b edits |
| WORK-3 | `set_fields`: schema-checked agent writes + list deltas (= DATA-9) | rebuild | adapt | M (L without WORK-2's reader) | medium | `crates/properties/src/inbound/toolset/set_entity_property.rs`, `apps/docs/AI/mcp/tools/set-entity-property.mdx` | `src-tauri/src/mcp.rs` (`write_target`, `guard_agent_write`), `src-tauri/src/vault/query.rs`, `vault/write.rs`, `src/engine/properties.ts` | WORK-2; owner call on unknown options (M1) |
| WORK-12 | Agent `create_note` duplicate guard: `if_exists` + advisory similar records (= DATA-21) | rebuild | inspire | S | medium | `crates/task_dedup/src/domain/service.rs` (`similarity_search`), `crates/task_dedup/src/outbound/judge.rs` (rubric) | `src-tauri/src/mcp.rs`, `src-tauri/src/vault/write.rs`, `src-tauri/src/search.rs` | — |
| WORK-7 | Bulk Set… and "Add existing" on related tabs | rebuild | mirror | M | medium | `apps/web/src/features/projects/core/assignment.ts`, `.../views/add-project-tasks.tsx` | `src/views/TableView.tsx`, `src/app/recordActions.ts`, `src/views/ViewTabEmbed.tsx`, `src/detail/RelationPicker.tsx`, `src/detail/FieldEditor.tsx` (lift reciprocal writes), `src/stores/vaultStore.ts` | WORK-1 |
| WORK-6 | Promote a checklist item to a record | rebuild | mirror | M | medium | `.../plugins/checkbox-to-task/checkboxToTaskPlugin.ts`, `.../checkbox-to-task/checkboxParsing.ts`, `apps/web/src/lib/core/util/taskExtraction.ts`, `.../taskCreation.ts` | `src/engine/tasks.ts`, `createRecord.ts`, `src/hooks/useDocTasks.ts`, `src/pages/HomePage.tsx`, `src/editor/SelectionToolbar.tsx` | WORK-5; WORK-15 (keys); DOMAIN:editor |
| WORK-16 | Project ↔ Work item membership in schema + demo vault | rebuild | inspire | S | medium | `crates/macro_db_client/migrations/20261003040141_task_project_property.up.sql` | `demo-vault/types/work-item.md`, `demo-vault/types/project.md`, demo records (e2e churn = test change) | — |
| WORK-15 | Reachable `PREFIX-N` keys, resolvable as link targets | rebuild | inspire | S/M | low | `crates/macro_db_client/migrations/20260520130000_create_team_task.sql`, `apps/web/src/routes/TaskRoute.tsx` | `src/engine/createRecord.ts`, `src/views/QuickAdd.tsx`, `ViewCanvas.tsx`, `src/engine/wikilink.ts`, `src-tauri/src/vault/link.rs` (shared golden) | WORK-16 |
| WORK-14 | Relative date filter values (today, ±N days, this week, overdue) | rebuild | inspire | M | medium | `apps/web/src/features/projects/views/projects-collection.tsx` (absolute only; anti-example) | `src/engine/viewFilters.ts`, `src/engine/dates.ts`, `src/views/FilterBuilder.tsx` | fold into WORK-5 if convenient |
| WORK-8 | Record composer: fields, Create more, ⌘Enter, similar hints | rebuild | adapt | L | medium | `apps/web/src/features/block-md/component/ComposeTask.tsx`, `.../TaskDuplicateList.tsx`, `crates/documents/src/inbound/axum_router/create_task.rs` | `src/app/CreateMenu.tsx`, `src/engine/createRecord.ts`, `src/engine/similar.ts` (new, BM25 via new IPC), `src/views/ListView.tsx` (drop `'Work item'` default), `src/stores/uiStore.ts` | — |
| WORK-9 | Home feed: what needs you + what changed | rebuild | adapt | L | medium | `crates/work_feed/src/domain/models.rs`, `.../policy.rs`, `.../stacking.rs`, `.../service.rs`, `crates/soup/src/outbound/pg_soup_repo/work_feed/query.sql` | `src/engine/workFeed.ts` (new), `src/pages/HomePage.tsx`, `src/status/NeedsYouSection.tsx`, `src/knowledge/BaseItself.tsx` (export `Feed<T>`), `src/git/useGit.ts`, `src-tauri/src/runtime/vault_writes.rs` (reader) | owner ruling (M43/M8.3); DATA-18 (actor) |
| WORK-10 | Filter with AI through the user's CLI | rebuild | adapt | M | low | `apps/web/src/features/tasks-view/filters/ai-task-filter.ts`, `.../queries/ai-task-filter-plan.ts` | `src-tauri/src/mcp.rs` (UI tool, not `propose_*`), `src/engine/viewFilters.ts`, `src/views/FilterBuilder.tsx`, `src/lib/prompts.ts` | WORK-2; naming with DATA-10 |
| WORK-11 | Soup engine, fact index, reconciliation, realtime | skip | — | — | low | `crates/soup/src/domain/service.rs`, `crates/predicate_index/src/lib.rs`, `apps/web/src/lib/queries/soup/graphql/reconciliation.ts` | — (input bounds folded into WORK-2) | reopen only on a measured frame-budget miss |

**WORK-1 — multi-value bands (first: silent data loss, no deps).**
- A record sits in every band of its values; band counts stop summing to the record count, so chart totals (`chart.ts:223-236,365`) and drilldown (`ChartView.tsx:1101-1115`) must count distinct records.
- Move replaces only the source value. Macro *appends* `[...remaining, to]` and clears ALL on a drop on "unassigned" (`task-board.ts:64-76`); in-place vs append is Cerebro's stated choice. `limit:1` stays scalar; create-in-band seeds `[value]`.
- dnd id and React key = band path + entry path (`BoardView.tsx:228,231`), so a card in two bands moves from where it was grabbed.
- Kill falsified comments: `grouping.ts:85-86,164-167`, `createRecord.ts:53-54`, `ChartView.tsx:1109-1115`, `BoardView.test.tsx:529`. Fixture: `Decision.deciders` (2–3 people); multiselect via unit fixture only.

**WORK-5 — deadlines (unblocks WORK-6, WORK-9).**
- Type-doc key `deadline: <date field>` is the cross-database role: declared data, never a field name. Add it to the `get_vault_context` key list (`mcp.rs:1986`) and adopt/doctor.
- GroupSpec `dateBucket`; future-facing deadline buckets (Overdue/Today/Tomorrow/This week/Next week/Later/No date) are Cerebro-native: Macro buckets look backward only. Extend `dueBucket`, inject the clock.
- Must answer M20.5's create-in-band concern (why date grouping was removed): a drop on Today writes today; a drop on a multi-day bucket refuses with a toast.
- Fix `MyWorkPage` ordering (type statuses, `:33`) vs membership (`statusSetFor`, `myWork.ts:31`). Retire `useDocTasks` catch→[] (`useDocTasks.ts:52-54`): it thins the list and miscounts "N open".

**WORK-2 — `query_records` (foundation for agent work).**
- Route ruling first. Rust twin = XL (must match `viewFilters` 552 + surface sort 293 + schema 504 + parts of views/dates, incl. `localeCompare` collation). Renderer bridge = L (new MCP→renderer RPC; today `tool_ui` is emit-only, `mcp.rs:3085-3102`). WASM single evaluator = the README escape hatch (`shared/policy/README.md:9-13`); Cerebro has no wasm tooling.
- Takes the exact `filters:` shape saved views store; virtual fields `status_group/path/folder/createdAt/modifiedAt` also land in TS `fieldValue`. Refuse unknown type/view/field/op/option by name with the vocabulary; never approximate or empty. Ingress bounds per Macro.
- Read scope applied before evaluation; withheld count stated. v1: no cursor (Macro ListEntities has none); exact total + withheld counts. `DEFAULT_STATUSES` moves to shared data. Merge with DATA-8.

## 7. Conflicts with Cerebro conventions

| Macro pattern | Cerebro rule | Resolution |
| --- | --- | --- |
| Global system properties with well-known UUIDs | M47 D3 no shared catalog; no type special-casing | Capabilities: status kind + per-database declared `deadline:` (WORK-5). Never route on field names; drop ListView's `'Work item'` default (WORK-8) |
| My tasks / Created by me / Team tasks | M43 §3: no assignee concept, single user | No "me"; assignee is an ordinary person-field filter |
| AI filter calls gpt-4o-mini directly | No API key in the app; CLI over loopback MCP | CLI turn + a UI tool; renderer vets against the schema. Name it off `propose_*` (policy-op namespace, `mcp.rs:930-936,977-985`) (WORK-10) |
| Dedup via OpenAI, pgvector, Cohere, hosted judge | Local only, no keys | Lexical (BM25) advisory hints + `if_exists` on agent create; no judge pipeline (WORK-12, WORK-8) |
| Server authority + reconciliation | Vault on disk is truth | Skip; keep "name what is unsupported, never approximate" (WORK-2) |
| Feed with unread/done state, live counts | Nothing speaks first; M43 "there is no feed"; LearnedCard is Home's only volunteer (M8.3) | Owner ruling first. Pull-only, no badge; done only on event-like rows; proposals stay in the one queue (WORK-9) |
| Agent session on a property-update EVENT | App-lifetime execution; first scan eventless; jobs are pure derivations with durable ledgers | Derive from vault STATE + claim; baseline on unpause. Run as kind `agent` under a `skillRuns` key prefix: a new ledger name AND a new lane are two migrations (`job_ledger.rs:21-23`, `schema.rs:521-529,1207`, `lib.rs:1355-1361`) (WORK-4) |
| Agents assignable through person fields | `personCandidates` resolves one people type; Agent is a reserved library type with no Type doc | Explicit relation `target: Agent`; disable RelationPicker Create for library types (it would mint `type: Agent` without `paused:true`, `RelationPicker.tsx:115-128`) (WORK-4) |
| Assigned agent updates the task's status | Run write scope (`mcp.rs:1521-1535`) may not cover the record | The brief states the agent's write scope; refusal is visible (WORK-4) |
| One Rust filter crate compiled to wasm for both sides | Twin Rust/TS rule code is review-blocking; parity = shared artifact + goldens | Filter ops are code, not data: twin + goldens, renderer bridge, or WASM. Owner/reviewer ruling before planning (WORK-2) |
| Multi-select replace vs option-id deltas; entity refs replace whole, per-option calls non-atomic | Files-first patches; human actions toast/return false; agent writes return typed results | Deltas against a fresh read in one file write (atomic, unlike Macro). Person/relation deltas are a Cerebro extension (WORK-1, WORK-3) |
| Refuse unknown option ids | Locked M1: unknown options stay as ghosts (`properties.ts:10-12`) | Keep ghosts and name them in the result, or get an owner ruling. Shape errors use existing operational `schema_invalid` (policy.v3), no new code (WORK-3) |
| `catch → []` in feeds | Unavailable is never empty | Fix `useDocTasks` (WORK-5), `useVaultPulse` (`useGit.ts:238-240`) and `useFileHistory` (`useGit.ts:209-211`) (WORK-9) |
| Copying AGPL / all-rights-reserved code | Cerebro Apache-2.0; owner rule | Behavior reference only; prompts and rubrics written fresh |

## 8. Verification notes

Stage 3 read code only (no cargo, vitest, e2e, or Macro build); citations are path:line in the working tree, which holds uncommitted AUTOMATION-2/2b edits to `jobs.ts`, `events.ts`, `useJobRunner.ts`, `vaultStore.ts`.

- **Confirmed.** First-value banding + list overwrite + multiselect refusal (WORK-1). No agent record query; no Rust filter evaluator or status chain (WORK-2). Trigger losses (WORK-4). `update_frontmatter` unvalidated (WORK-3). No record deadline on Home/My work (WORK-5). Macro: newly assigned agent starts work (set difference, replay-stable). Fourth ledger name = migration. List engine + live updates already exist.
- **Refuted.**
  - *PREFIX-N keys are minted from the project `key:`* → unreachable: every `createTarget` caller passes `project:null` (`CreateMenu.tsx:168`, `QuickAdd.tsx:72`, `TypePage.tsx:62`, …); the branch assumes legacy `<dir>/project.md`. Added WORK-15.
  - *Projects are solid / already-better* → Work item has no project relation, Project has no tabs; only Epic → Work items is real. Rated partial; added WORK-16.
  - *WORK-12 skip: M33a D1 means agents never create records* → D1 binds the knowledge agent; scoped M34 agents create records and `create_note` writes `-2` copies. Skip → rebuild/inspire/S/medium.
  - *WORK-8 ranks similar records by `quickOpenScore`* → contiguous-substring tiers miss reordered words; use BM25 (`search.rs:110`, MCP-only today) via a new IPC. Macro shows 2, not 3.
  - *WORK-2 cursor carries a filter fingerprint, per Macro* → ListEntities has no cursor; `models_pagination` embeds the full filter. v1 drops the cursor.
- **Partial / corrected.**
  - Two interpreters + goldens: unverifiable without a ruling; 19 op semantics are code, far beyond the critical-attention/staleness precedents. Third route added: WASM escape hatch.
  - Renderer bridge liveness during runs: unmeasured; no MCP→renderer request path exists.
  - Events are replaced by the next scan that *yields* events, not every scan.
  - `useDocTasks` collapse usually thins the list (wrong count) rather than saying "No open tasks". Third collapse found: `useFileHistory`.
  - Home feed: unverifiable owner call; LearnedCard rule is the stronger prior constraint.
  - Agent assignment: no Agent database exists; relation `target: Agent` works but its Create button mints an unpaused Agent.
  - Date grouping is off on purpose (M20.5), not raw-value banding; only hand/agent-written YAML reaches it.
  - WORK-1 is adapt, not mirror (Macro appends; no multiselect lane). WORK-3 deltas: Macro deltas cover option ids only, per-option non-atomic calls.
  - WORK-5 buckets are inspire (Macro is backward-only; Home sections live in `home/queries/home-date-buckets.ts`, not `work-feed.ts`; tasks-view "date" groups by `sort_ts`).
  - WORK-4 latency: 4s settle after entries change, not the 60s tick.
  - Demo fixture: `Decision.deciders` / `Meeting.attendees` are multi-person; no multiselect type.
  - Agent history: `runtime.db vault_writes` is durable, but every write passes actor `None` and nothing reads it (→ DATA-18, WORK-9 prerequisite).
- **Effort changes.** WORK-2 L→XL (twin) / L (bridge). WORK-7 S→M. WORK-8 M→L (FieldEditor needs a draft adapter; or reframe as create-then-edit). WORK-10 stays M with a rename. WORK-12 now S.
- **Missed items folded in.** WORK-14 relative date filters. WORK-15 keys. WORK-16 project membership. ListView `'Work item'` default → WORK-8. Frecency → SEARCH-4. `vault_writes` actor → WORK-9 prerequisite / DATA-18.
- **Cross-domain duplicates (dedupe in planning).** WORK-2 = DATA-8, WORK-3 = DATA-9, WORK-4 = AUTOMATION-5, WORK-10 ≈ DATA-10, WORK-12 = DATA-21.
- **Still open.** Owner: twin/bridge/WASM (WORK-2), Home feed (WORK-9), M1 ghosts vs refusal (WORK-3). Macro: who still reads `task_initiative`; canonical filter UI (`features/soup` vs `features/next-soup`); grouped-Soup timezone handling; whether Cerebro scale ever needs a fact index (unmeasured).

## 9. Where to read first

1. `docs/AGENT_GUIDE/tasks.md`
2. `apps/web/src/features/tasks-view/core/task-board.ts` and `.../core/task-board-optimism.ts`
3. `crates/soup/src/inbound/toolset/list_entities.rs` and `apps/docs/AI/mcp/tools/list-entities.mdx`
4. `crates/item_filter_index/src/lib.rs` and `crates/predicate_index/src/lib.rs`
5. `crates/graphql_soup_filter_input/src/lib.rs` (ingress bounds)
6. `crates/properties/src/inbound/toolset/set_entity_property.rs`
7. `crates/agent_trigger/src/domain/task_assignment.rs` and `.../task_assignment/prompt.md`
8. `crates/models_grouping/src/date_buckets.rs` and `apps/web/src/features/home/queries/home-date-buckets.ts`
9. `apps/web/src/lib/core/component/LexicalMarkdown/plugins/checkbox-to-task/checkboxToTaskPlugin.ts`
10. `apps/web/src/features/projects/core/assignment.ts` and `.../views/add-project-tasks.tsx`
11. `crates/work_feed/src/domain/` (`models.rs`, `policy.rs`, `stacking.rs`, `service.rs`) and `crates/soup/src/outbound/pg_soup_repo/work_feed/query.sql`
12. `crates/graphql_work_feed/src/subscriptions.rs`
13. `apps/web/src/features/tasks-view/filters/ai-task-filter.ts`
14. `crates/task_dedup/src/domain/service.rs` and `crates/task_dedup/src/outbound/judge.rs`
15. `apps/web/docs/optimistic-predicate-fact-index-plan.md` and `apps/web/docs/local-predicate-pagination-plan.md` (only if WORK-11 reopens)
