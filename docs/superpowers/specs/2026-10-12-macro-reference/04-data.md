# Macro reference — Data model: entities, @link graph, properties, databases, views, forms

**Date:** 2026-10-12 · **Source:** `docs/examples/macro-main/` (all Macro paths below are relative to it)
**Rule (owner, 2026-10-12):** Cerebro builds its own version, Macro is the guide, never a 1:1 copy.
**Licenses:** `crates/*` AGPL-3.0 (`LICENSE.txt`); `apps/web/` all rights reserved (`apps/web/LICENSE`); Cerebro Apache-2.0. Every port is design-level.

---

## 1. What it is

- No single entity table. Identity = `(EntityType, id)` over 23 kinds (`crates/model-entity/src/lib.rs`). Owner rows exist for 5 kinds only (`crates/entity_registry`).
- One EAV store, `entity_properties`, serves every entity kind and also Macro Databases: column = property definition, row = `DATABASE_ROW` entity, cell = entity property (`crates/macro_db_client/migrations/20261001212549_add_databases.up.sql`).
- Database writes are typed `DatabaseOp` batches with CAS and an inverse-op journal. Reads, views and agents go through `database_sql`, a Rust SQL-subset engine that also runs as wasm. Forms are presentation over one table.
- The @link graph is a flat edge table (`comms_entity_mentions`) that the client maintains. It is not re-derived from content.

## 2. What users get

| Feature | UX details / shortcuts | Read |
| --- | --- | --- |
| Databases app (`/app/database/<uuid>`, PostHog `enable-databases`) | Create→Database `C→L` (first table + Name column). Table tabs: + New table, rename (double-click/F2), drag reorder, delete with confirm. Add column = "Unnamed" Text column with its name selected, no dialog. Header menu: rename, Change type (offers only the types the values fit; a lossy change becomes "Convert into a new column" e.g. `Amount (Number)`), Edit options, Delete (refused if a formula uses the column), Move. A new Text column infers its type from its first value. An empty editable row always comes last. Enter/Tab/Shift+Tab. Rectangle select + Delete = one undoable change. Record dialog with prev/next. Cmd/Ctrl+F searches all tables (20 hits/table). CSV import (16 MiB, 100 columns, 10,000 rows in code; values stay Text; retry-safe per request) and export of the current table. Cmd+Z / Cmd+Shift+Z undo only your own edits; deletes toast "Undo". Row history. | `docs/AGENT_GUIDE/databases.md`, `apps/web/src/features/database/views/database-records-view.tsx` |
| Cell editors | Option picker with search-or-create ("Create “…”"), Up/Down wrap around. Option delete confirms "Cells using “X” will be cleared." Relation chips open the record. A relation filter can only test emptiness. Number cells refuse bad input ("Enter a valid number"). Dates accept `tomorrow` and `3d`. Text cells take inline @mentions. | `apps/web/src/features/database/components/option-picker.tsx`, `database-relation-cell.tsx`, `apps/web/src/components/cell-text-editor/CellMentionEditor.tsx` |
| Formula columns | `{Unit price} * Quantity`, `Due + 7`, `Due - Started`; + − × ÷ ( ) buttons. A live line shows the result type or the parse error, and Save stays disabled until it parses. ƒ icon. Stored as an AST keyed by column id, so renames are safe. | `apps/web/src/features/database/components/formula-editor.tsx`, `crates/models_databases/src/formula.rs` |
| Stored views (Table/Board) | "All records" first; its filter and sort are local to the viewer. "+" → Table/Board creates a view that keeps the current filter and sort. Filters: Where/And/Or with nested groups and typed tests. Multi-level sort, drag to reorder. Board grouped by a single-select or person column, with card fields, hidden or empty lanes, and lane drag. "+ New" per lane (Enter chains, Shift+Enter opens the record). A sorted board asks "Remove sort to arrange cards manually?". Columns cannot be hidden. | `crates/models_databases/src/views.rs`, `apps/web/src/features/database/components/database-board.tsx` |
| Agent DB tools | ListDatabases, DescribeDatabase, QueryDatabase (SQL subset incl. DDL), SaveDatabaseQuery, SaveDatabaseView, DeleteDatabaseView; also served over MCP. Tool rows read as words ("Updated 3 rows in Guests") and never show SQL. Inline results as table, scalar, bar, line, area, scatter or pie. | `crates/databases/src/inbound/toolset.rs`, `crates/databases_sql/src/toolset/query_database.rs` |
| Live answers in docs | `/database` asks a question. The answer is a node pointing at an immutable saved query, run with each reader's own access. Source picker (Automatic or explicit). Regenerate replaces the answer only after a successful run. Resizable; refreshes when source tables change. | `apps/web/src/features/database-query/views/live-question.tsx`, `packages/lexical-core/nodes/databaseQueryData.ts` |
| Properties on any entity | Types STRING, NUMBER, BOOLEAN, DATE, SELECT_STRING, SELECT_NUMBER, ENTITY, LINK, TAG. System or custom (user/team scope). Inline, popover and modal editors. Pinned properties (tasks pin Status/Priority/Assignees). Required properties hide the "No <name>" clear. Read-only computed metadata properties sit alongside. | `apps/docs/concepts/properties.mdx`, `crates/properties/src/domain/metadata.rs` |
| System catalog | Fixed ids: Assignees, Status, Priority, Due, Parent/Subtasks (reciprocal), Depends On, Effort, Story Points, Project; CRM Stage/Owner/Revenue. Applicability is gated per kind. | `crates/system_properties/src/domain/model/constants/system_property_key.rs` |
| Tags | Personal set and team set, 12-colour palette. A personal tag can be promoted to the team set (keeps its id) or merged. | `apps/web/src/features/property/tags/TagPicker.tsx` |
| @mentions + References | `<m-document-mention>{json}</m-document-mention>` and siblings (user, contact, date, pr, agent-session, group, card, tag). Hover previews; Convert to embed. A References panel on each block. Mentions in documents do not grant access; channel mentions do. | `packages/lexical-core/transformers/mentions.ts`, `apps/docs/concepts/blocks.mdx` |
| Bulk entity actions | Rename, move, share, trash, restore, delete, duplicate across mixed kinds. Max 100 per batch, per-item results. | `crates/graphql_entity_mutation/src/mutations.rs` |
| Forms (`enable-forms`) | Create→Form `C→Q` makes a database with a "Responses" table. 17 question types. Sections, gates over earlier questions only, booking step. "Remove from form" keeps the column. Preview creates no rows. Settings: audience, open/closed, auto-close, confirmation. Respondents see one section per screen; the stop screen never reveals rules. Polls in channels. | `docs/AGENT_GUIDE/forms.md`, `apps/web/src/features/block-form/form-respond-page.tsx` |
| Form AI tools | CreateForm, ReadForm, EditForm (merges into Loro as CRDT ops), ListForms (≤50), SetFormAccess. New forms start closed and members-only. No retry dedupe. | `crates/forms/src/inbound/toolset/` |

## 3. How it's built

**Architecture.** Hexagonal Rust crates (domain + ports; sqlx/Postgres, Kafka and gateway outbound; Axum, async-graphql and ai_toolset inbound) composed in `services/document_storage_service`. Auth is a typed `EntityAccessReceipt<View|Edit>` minted from `entity_access` at the inbound edge. Rows are read through Soup GraphQL plus the `database_sql` engine (wasm in the browser, native for agents); writes go through `DatabasesService::apply_ops`. Events: `macro.properties`, `macro.databases` and `macro.forms` (at-most-once, after commit). Frontend: SolidJS, TanStack Solid Query and the urql normalized cache. `features/database` is a host-independent editor that `features/block-database` composes into the app.

| Unit | Path | Role | LOC |
| --- | --- | --- | --- |
| entity_registry | `crates/entity_registry` | Owner and lifecycle rows for 5 kinds | 2691 |
| entity_mutation | `crates/entity_mutation` | Capability traits for cross-kind lifecycle ops; ordered per-item effects | 455 |
| graphql_entity_mutation | `crates/graphql_entity_mutation` | GraphQL bulk lifecycle mutations (≤100) | 1124 |
| model-entity | `crates/model-entity` | `EntityType` (23), `Entity{type,id}` | 307 |
| properties | `crates/properties` | Definitions, options, values, tags, task relationships, metadata props, database cell writers, AI tools | 26530 |
| system_properties | `crates/system_properties` | Code-defined catalog, stable UUIDs, option enums | 2368 |
| models_properties | `crates/models_properties` | `PropertyValue` tagged union, `DataType`, `SetPropertyValue` validation | 2128 |
| graphql_properties | `crates/graphql_properties` | Property GraphQL edge + mutations | 2139 |
| databases | `crates/databases` | Op planner and apply, casts, inference, formulas, views, journal/undo, CSV, AI tools | 43880 |
| databases_sql | `crates/databases_sql` | Server runner for the engine: viewer catalog, DDL→ops, `ViewOnlyAccess` | 6631 |
| database_sql | `crates/database_sql` | SQL-subset parse → resolve → split → I/O-free engine → fold; view compile; board; formula | 18693 |
| models_databases | `crates/models_databases` | Wasm-safe vocabulary: ops, cells, views, cast rule, formula AST, `Position` | 6880 |
| saved_views | `crates/saved_views` | Per-user JSON view blobs | 235 |
| forms / models_forms | `crates/forms`, `crates/models_forms` | Create, Loro layout, submit with gates, ledger, tallies / wire types | 25542 / 1812 |
| complete_graph | `crates/complete_graph` | Merged GraphQL schema + Soup edges | 6945 |
| features/database | `apps/web/src/features/database` | Host-independent grid/board/record editor; `core/` mostly framework-free TS | 33421 |
| features/database-query | `apps/web/src/features/database-query` | Live question/answer UI, charts | 10269 |
| features/block-database | `apps/web/src/features/block-database` | App composition, rollout gate, table tabs, refresh | 11194 |
| features/property | `apps/web/src/features/property` | Property UI library, editors, tags | 18426 |
| features/block-form | `apps/web/src/features/block-form` | Builder, respond, responses grid, polls; pure `core/` | 28627 |
| lib/core/database-sql | `apps/web/src/lib/core/database-sql` | TS face of the wasm engine (driver, catalog) | 4819 |
| cell-text-editor | `apps/web/src/components/cell-text-editor` | Contenteditable cell editor with @menu | 422 |

LOC = `wc -l` over .rs/.ts/.tsx/.sql/.graphql, tests included.

**Data model.**

| Entity | Storage | Key fields | Path |
| --- | --- | --- | --- |
| Identity | Rust enum + TEXT ids | 23 kinds; a task is a document with subtype TASK | `crates/model-entity/src/lib.rs` |
| `entity` | Postgres | Owner (user/bot/team) + lifecycle stamps; 5 kinds | `crates/macro_db_client/migrations/20260910144347_add_entity_table.sql` |
| `entity_access` | Postgres | Grants per source; rows inherit from their database; form Edit implies database Edit | `crates/macro_db_client/migrations/20260331152752_add_entity_access_table.sql` |
| `property_definitions` | Postgres | `data_type`, `is_multi_select`, `specific_entity_type`; exactly one owner of system/team/user/database | `crates/macro_db_client/migrations/20261001212549_add_databases.up.sql` |
| `property_options` | Postgres | number XOR string value, colour, unique per definition | `crates/macro_db_client/migrations/20251030100000_init_properties_schema.sql` |
| `entity_properties` | Postgres JSONB | `UNIQUE(entity_id, entity_type, def)`; `{type,value}` where multi-capable kinds are always arrays (CHECK); NULL = attached without a value | same |
| Metadata properties | computed per request | sentinel id `ffff…`, `is_metadata` | `crates/properties/src/domain/metadata.rs` |
| `databases` / `database_entities` | Postgres | Storage identity separate from the optional app entity | `crates/macro_db_client/migrations/20261005183743_separate_database_entity.up.sql` |
| `database_tables` | Postgres | `position` (fractional, COLLATE C), `version` bumped per commit, CSV import key | `…20261001212549_add_databases.up.sql` |
| `database_columns` | Postgres | Placement of a definition; `config` Link (relation) or Derived (formula); `infer_type`; `nullable`; protections | `crates/databases/src/domain/models.rs` |
| `database_rows` + cells | Postgres + `entity_properties` | Triggers keep cells inside the schema; a relation is a one-way EntityReference | `…20261001212549_add_databases.up.sql` |
| `database_views` / `_positions` | Postgres JSONB | `ViewQuery{filter, sort}`, `ViewLayout` Table or Board; card positions per (view,row,lane) | `crates/models_databases/src/views.rs` |
| `database_queries` | Postgres | Immutable `{version, query}`; documents point at them by id | `…20261001212549_add_databases.up.sql` |
| `database_changes` | Postgres | One row per (table, version): ops, inverse, actor; no FKs, so history outlives rows | `crates/macro_db_client/migrations/20261001233202_database_changes.up.sql` |
| forms tables | Postgres + Loro | Sections (questions/gate/booking), `gate_rules` = FilterGroup, questions → column_id, response ledger | `crates/macro_db_client/migrations/20261005024926_add_forms.up.sql` |
| `comms_entity_mentions` | Postgres | source → target edge, no FKs, indexed by target | `crates/macro_db_client/migrations/20251104101012_comms_db_schema.sql` |

**Key flows.**

1. **Cell edit → commit.** (1) `features/database/core/cell-ops.ts` maps values to `CellWrite`; `row-write.ts` prepends `add_options` ops for unknown labels, using client-minted UUIDv7 ids. (2) `POST /databases/{id}/ops {ops, baseVersions?}` (`crates/databases/src/inbound/axum_router/ops.rs`) mints an Edit receipt. (3) `plan_and_apply` (`crates/databases/src/domain/service/ops.rs`) plans each op against the schema the earlier ops left: ≤10,000 rows per request, replanned up to 3× if the schema moved. (4) `PgCellStore::apply_writes` runs one transaction covering locks, schema, cells, required-cell checks, version bump and a journal row with inverse ops. (5) It returns `OpResult[]` paired by index and emits Kafka and gateway `table_changed`. (6) Other clients fetch `changes?since` and re-read only the changed rows (`apps/web/src/features/database/core/refresh-plan.ts`). (7) A stale base → 409; a retried committed batch → 400 "taken"; the UI separates a commit failure from a refresh failure (`core/write-failure.ts`).
2. **View read.** (1) `compile_view` turns a stored view into a query, never SQL text (`crates/database_sql/src/view/compile.rs`). (2) `split.rs` makes one GraphQL fetch per table with `=`/IN/HAS pushdown; the rest is folded in memory. (3) The I/O-free `Engine` steps Fetch → Done, with pages ≤500 and `ROW_CAP` 20,000 per table reported as truncated (`engine.rs`). (4) The wasm shell is driven by `apps/web/src/lib/core/database-sql/driver.ts`. (5) Boards merge rows with stored positions into lanes.
3. **Agent SQL.** (1) ListDatabases/DescribeDatabase, then QueryDatabase (statements ≤256 KiB). (2) The catalog holds only what the viewer can reach, plus `macro.people`; anything else does not exist (`crates/databases_sql/src/service.rs`). (3) DDL → `DatabaseOp` batch (`service/schema.rs`). (4) UPDATE/DELETE read matching rows, then apply ops with CAS (`ops_sink.rs`). (5) Read-only surfaces wrap access in `ViewOnlyAccess` (`view_only.rs`).
4. **Set a property.** (1) GraphQL `setEntityProperty` with an optimistic cache payload. (2) `set_entity_property` (`crates/properties/src/domain/service_impl.rs`) does a batched subtype lookup (DOCUMENT→TASK), validates the value against data type and single/multi, checks option membership and applicability, and dedupes multi values. (3) Parent/Subtasks are written reciprocally in the same transaction. (4) Upsert. (5) Assignee grants and notifications, then a Kafka event.
5. **Form submit.** (1) Create makes or binds a table and adds protected Submitted and Respondent columns (`crates/forms/src/domain/service/create.rs`). (2) The Loro draft is the only layout writer; a validated projection is written to the relational tables (`collaboration.rs`). (3) `POST /forms/{id}/responses` checks required answers and gates (`service/answers.rs`; client mirror `apps/web/src/features/block-form/core/gate-evaluation.ts`), then `apply_ops` inserts the row and a ledger entry is written.
6. **@mention edge.** (1) Inserting a mention calls `trackMention` → `POST /channels/mentions`, and the edge id is stored on the node (`apps/web/src/lib/core/signal/mention.ts`). (2) Destroying the node → DELETE. (3) Documents created from markdown are extracted once by lexical-service (`crates/documents/src/outbound/mention_tracker.rs`). (4) References = union of attachments, message mentions and generic mentions, newest first (`crates/comms_db_client/src/attachments/get_attachment_references.rs`). No reconciler runs after edits, so edges can drift.

## 4. Ideas worth stealing (ranked)

1. **Derived cells are filled before filter, sort and group.** The fold evaluates computed values first, so a view never tests a blank where a value exists. `crates/database_sql/src/fold.rs`
2. **Every field reference is checked against the schema, and views are rewritten when the schema changes.** `check.rs` returns the first problem (UnknownColumn, UnknownOption, TestDoesNotFit, BoardCannotGroupBy). Deleting a column prunes it from views (`views_without_column`); a retype strips the tests that no longer fit (`views_without_tests_of`); deleting an option prunes it (`views_without_option`). The change is refused while a board groups by the column. `crates/models_databases/src/views/check.rs:233-277`, `crates/databases/src/domain/service/views.rs:49-110`, `crates/databases/src/domain/service/ops/views.rs:423-450`
3. **Writes validated at the storage boundary**: value shape against data type and single/multi, option membership, label→id. `crates/models_properties/src/service/property_value.rs`, `crates/properties/src/domain/service_impl.rs`
4. **One cast rule (Safe | Checked | Never)** behind the type menu, the agent tool and ALTER. An empty column is Safe for any change. A lossy change becomes "Convert into a new column", so no value is ever emptied. `crates/models_databases/src/cast.rs:233-270`
5. **Typed op batch**: all-or-nothing, client-minted UUIDv7 ids (a taken id makes a retry idempotent), `baseVersions` CAS → 409, results paired by index. `crates/databases/README.md`, `crates/models_databases/src/ops.rs`
6. **Journal of inverse ops + guarded undo**: a cell reverts only while it still holds what the change wrote; others are skipped and reported. Undo refuses rather than partially restoring. `crates/databases/src/domain/journal/guard.rs`, `crates/databases/src/domain/journal/invert.rs`
7. **Option deltas** (`add_option_ids` / `remove_option_ids` under a row lock) instead of whole-list replace, so concurrent multi-select edits compose. `crates/properties/src/inbound/toolset/set_entity_property.rs:44,106-121`
8. **Views are typed data, never SQL text**: nested And/Or groups, typed tests per value kind, sort with empties last. The same type serves as form gates. `crates/models_databases/src/views.rs`
9. **Form gates are strict**: an absent answer fails every test except isEmpty, so a skipped question cannot pass an "is not" gate. `apps/web/src/features/block-form/core/gate-evaluation.ts:11-16`
10. **Immutable saved query + pointer node**: results are never persisted, and each reader runs the query with their own access. `packages/lexical-core/nodes/databaseQueryData.ts`, `crates/databases_sql/src/view_only.rs`
11. **Commit failure vs refresh failure are separate states**; an uncertain insert draft cannot submit again. `apps/web/src/features/database/core/write-failure.ts`
12. **Fractional positions** per (view, row, lane): one write per drag, no renumbering. `crates/models_databases/src/position.rs`, `crates/models_databases/src/views/lanes.rs`
13. **Required-cell semantics**: empty selections and empty reference/link lists are absent; empty text, zero and false are present. Checked on the final transaction state, undo included. `crates/databases/src/domain/models.rs`
14. **Capability-per-kind router** for lifecycle ops: adding a kind fails compilation until every capability decides. `crates/entity_mutation/src/capability.rs`
15. **First-value type inference** for a new Text column (`infer_type`, settled inside the write). `crates/databases/src/domain/service/infer_column_type.rs`

## 5. Cerebro today vs Macro

| Macro feature | Cerebro status | Value | Note |
| --- | --- | --- | --- |
| Multi-table database with tabs | different-by-design | low | One Type doc = one table; a page holding several database blocks stands in (M47) |
| Derived values in filter/sort/group | partial | high | Measured: `viewFilters.ts:324-330`, `surface.ts:46-54` and `grouping.ts:54` read raw frontmatter. Created/edited time, rollups and from-derived fields read empty, yet the filter UI offers them (`properties.ts:350-385`) |
| `created_time` is a real creation time | broken | high | Every app write (temp + rename, `write.rs:100-128`) resets the APFS birth time the scanner reads (`scan.rs:31-41`). Measured |
| Views checked; references survive renames | partial | high | Rename rewrites `fields:` and values only (`typeActions.ts:394-444`). The active view's columns follow (TableView, PropertyEditor), but not its filters, sort or group. The detail-panel rename (`PropertyMenu.tsx:77`) follows no view. There is no `checkView` |
| Cast rule + convert-to-new-column | partial | high | `coerceValueToKind` clears unconvertible values after a count-only confirm (M12.4b, `properties.ts:877-884`; `PropertyEditor.tsx:34-75`) |
| Formula columns | absent | medium | M16 deferred it as "its own milestone" |
| Footer totals that state skipped rows | absent | medium | `aggregate.ts:124-152` drops empties silently. A rollup sum over nothing returns `0` (`properties.ts:1049-1054`) |
| Stored views, nested filters, multi-sort | already-better | low | 10 view kinds, 19 ops, grouping chain with relation descent |
| Per-view lane order / hidden lanes; manual card order | absent | low | Only `hideEmpty`; lane order follows options (`BoardView.tsx:563-574`). M46.2 declined a per-card index |
| Op batch, all-or-nothing, CAS | absent | high | Atomic per file only (`write.rs:75-128`) |
| Undo/redo for records and schema; undoable delete | absent | high | Diagram undo exists (`useDiagramFile.ts:183-205`, mounted by WhiteboardView), and applied knowledge ops have Revert (`NeedsYouSection.tsx:176-182`). OS trash cannot be restored on macOS (trash 5.2.6) |
| Rectangle cell selection + clear | absent | low | Row selection and per-cell editing only |
| Agent schema description | partial | high | `get_note` returns a Type doc's raw `fields:` (`mcp.rs:2150-2185`). No resolved description: default statuses, option id↔label, computed flags, counts |
| Agent structured query | absent | high | Only `search_notes` |
| Agent writes validated | absent | high | `update_frontmatter`/`create_note` write any JSON shape (`mcp.rs:2636-2678`, `write.rs:220-243`). An unbracketed relation becomes a text property |
| Agent actor recorded on writes | absent | medium | Every `vault_writes` call passes actor `None` (`write.rs:328,354,…`) |
| Agent views / live answers | partial | medium | The block renders any view incl. chart/number; agents are refused on Type docs |
| @mentions + References | already-better | medium | Edges re-derived from content. Gaps: quadratic TS resolution (measured 1.45 s rebuild at 5k notes); a rename that changes the stem dangles links, including knowledge `about:` anchors |
| Properties on any entity, metadata | already-better | low | Any page has frontmatter; created/edited time kinds exist; no `created_by` |
| Shared definitions, system catalog | different-by-design | low | M47 D3; no type special-casing |
| Tags (team promote/merge) | different-by-design | low | Single user; options are per database |
| Bulk entity actions | partial | medium | Copy links, duplicate, delete; no set-property, no restore |
| CSV import/export | absent | medium | — |
| Forms | absent | medium | Local guided capture only is in scope |
| Host-independent editor | already-better | low | `ViewCanvas` + database block render any database on any page |
| SQL engine | skip (cost) | low | No recorded Cerebro decision; FilterGroup JSON serves as the query language today |
| Registry, access, sharing, realtime | different-by-design | low | Local, single user; the run grant is the only boundary |

## 6. Port candidates

| id | title | mode | fidelity | effort | value | Macro guide (read first) | Cerebro target | depends |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| DATA-17 | Preserve file birth time across writes | rebuild | inspire | S | high | — (Macro stores `created_at`) | `src-tauri/src/vault/write.rs` `write_via_temp` (`FileTimesExt::set_created`); optional `created:` stamp at create | — |
| DATA-3 | Computed values filterable, sortable, groupable | rebuild | adapt | S | high | `crates/database_sql/src/fold.rs` | `src/engine/viewFilters.ts`, `surface.ts`, `grouping.ts`, `schema.ts` | DATA-17 (created_time half) |
| DATA-7 | Indexed link graph in TS (a), then link-preserving rename (b) | rebuild | inspire | M (a: S) | high | `crates/comms_db_client/src/attachments/get_attachment_references.rs`; `apps/web/src/lib/core/signal/mention.ts` (anti-pattern) | `src/engine/wikilink.ts`, `relations.ts`, `links.ts`, `src/detail/DocSidePanel.tsx`; `src-tauri/src/vault/links_rewrite.rs` (new) | (b): DATA-5 |
| DATA-1 | Field references follow renames and retypes; dangling refs shown | rebuild | adapt | M | high | `crates/models_databases/src/views/check.rs`, `crates/databases/src/domain/service/views.rs` | `src/engine/fieldRefs.ts` (new), `src/app/typeActions.ts`, `src/views/FilterChips.tsx`, `ViewCanvas.tsx` | DATA-7a first (cost) |
| DATA-9 | Schema-checked agent writes + list deltas | rebuild | adapt | M | high | `crates/models_properties/src/service/property_value.rs`, `crates/properties/src/inbound/toolset/set_entity_property.rs` | `shared/schema/field-kinds.v1.json` (new), `src-tauri/src/vault/schema_check.rs` (new), `src-tauri/src/mcp.rs`, `src/engine/properties.ts` | owner call on options |
| DATA-2 | Safe kind change: cast verdicts, dry run, convert to new property | rebuild | mirror | M | high | `crates/models_databases/src/cast.rs` | `src/engine/castRules.ts` (new), `src/app/typeActions.ts`, `src/views/PropertyEditor.tsx`, `src/detail/PropertyMenu.tsx` | DATA-1 (`checkView`); DATA-5 soft; owner call |
| DATA-18 | Record the run's actor in `vault_writes` | rebuild | inspire | S | medium | `crates/macro_db_client/migrations/20261001233202_database_changes.up.sql` (actor column) | `src-tauri/src/mcp.rs` (thread `grant.actor`, run id), `src-tauri/src/vault/write.rs` | — |
| DATA-5 | Vault batch writer: validated, CAS, all-or-nothing | rebuild | adapt | L | high | `crates/databases/README.md`, `crates/databases/src/domain/service/ops.rs` | `src-tauri/src/vault/batch.rs` (new), `entry.rs` (hash), `src/stores/vaultStore.ts`, `src/lib/mockIpc.ts` | — |
| DATA-6 | Undo/redo for record and schema edits; undoable deletes | rebuild | adapt | L | high | `crates/databases/src/domain/journal/guard.rs`, `apps/web/src/features/database/core/undo-stack.ts` | `src/stores/undoStore.ts` (new), `src/stores/uiStore.ts` + `ToastHost.tsx` (action buttons) | DATA-5; DATA-18 (actor names) |
| DATA-8 | Agent `describe_database` + `query_records` | rebuild | adapt | M | high | `crates/databases/src/inbound/toolset/describe_database.rs`, `crates/databases_sql/src/toolset/query_database.rs` | `src-tauri/src/mcp.rs`, `src-tauri/src/vault/query.rs` (new), `shared/query/goldens/` | DATA-9 (Type-doc reader); reviewer ruling |
| DATA-10 | `propose_view` (agent views + live answers) | rebuild | adapt | L (M descoped) | medium | `crates/databases/src/inbound/toolset/save_database_view.rs` | `src-tauri/src/mcp.rs`, `src/agent/ProposalCard.tsx`, `src/app/typeActions.ts` | DATA-8, DATA-9, DATA-1 |
| DATA-4 | Formula kind (row arithmetic) | rebuild | adapt | M | medium | `crates/database_sql/src/formula.rs`, `crates/models_databases/src/formula.rs` | `src/engine/formula.ts` (new), `types.ts`, `properties.ts`, `aggregate.ts` | DATA-3, DATA-1 |
| DATA-11 | CSV import (new database) / export (view) | rebuild | adapt | M | medium | `crates/databases/src/domain/service/transfer.rs` | `src/engine/csv.ts` (new), `src/app/csvActions.ts` (new) | DATA-5 |
| DATA-12 | Form view: required questions, strictly gated sections | rebuild | adapt | L | medium | `apps/web/src/features/block-form/core/gate-evaluation.ts`, `crates/models_forms/src/lib.rs` | `src/engine/forms.ts` (new), `src/views/FormView.tsx` (new) | — |
| DATA-19 | Rectangle cell select + clear as one batch/undo step | rebuild | adapt | M | low–medium | `docs/AGENT_GUIDE/databases.md:241-244` | `src/views/TableView.tsx`, `src/views/useRowKeyboard.ts` | DATA-5, DATA-6 |
| DATA-13 | Manual order (fractional ranks per view) + lane order/hidden lanes | rebuild | adapt | M | low | `crates/models_databases/src/position.rs`, `crates/models_databases/src/views.rs:456-462` | `src/engine/rank.ts` (new) or permissive lib, `BoardView.tsx`, `TableView.tsx` | DATA-7b; owner sign-off |
| DATA-20 | Infer an inserted column's kind from its first value | rebuild | inspire | S | low | `crates/databases/src/domain/service/infer_column_type.rs` | `src/app/typeActions.ts:334-369` (reuse `adopt.inferKind`) | — |
| DATA-21 | Persisted "Recently deleted" with restore | rebuild | inspire | S–M | low | `crates/entity_mutation/src/capability.rs` (Trash/Restore) | `src-tauri/src/vault/write.rs:953-962`, DATA-6 pre-image store | DATA-6 |
| DATA-14 | Shared property catalog, system properties | skip | — | — | low | `crates/system_properties` | — | conflicts with M47 D3 |
| DATA-15 | SQL-subset engine | skip | — | — | low | `crates/database_sql` | — | cost (~9.0k non-test LOC) + AGPL |
| DATA-16 | Multi-user entity layer | skip | — | — | low | `crates/entity_registry` | — | local, single user |

**Recommended order:** DATA-7a → DATA-17 → DATA-3 → DATA-1 → DATA-9 → DATA-2 → DATA-18 → DATA-5 → DATA-6 → DATA-7b → DATA-8 → DATA-10 → DATA-4 → DATA-11 → DATA-12 → DATA-19 → DATA-20/21 → DATA-13 (owner sign-off).

**Per-candidate scope (stage 3 applied):**
- **DATA-17.** Preserve the destination's birth time in `write_via_temp`; `std::os::macos::fs::FileTimesExt::set_created` compiled and backdated a file under rustc 1.95. Optionally stamp `created:` at create.
- **DATA-3.** Route computed kinds through `schema.resolveField`, memoized per resolution. Mock `createdAt` is one `SEED_TIME` for every seeded file (`mockIpc.ts:117`), so test with vitest fixtures, not demo-vault e2e. An absent computed value stays empty, never 0. Release-note: saved views that filtered on computed fields will change results.
- **DATA-7.** (a) A TS `targetIndex` with parity fixtures against `src-tauri/src/vault/link.rs`, covering body links too (`backlinksFor` costs 1.9 s per render at 5k notes). (b) Rewrite inbound `[[old]]`/`[[old|alias]]` as one DATA-5 batch after a confirm. Exclude `knowledge/` concepts (`about:` anchors, `sources.resource`) or route them through the capture valve or the governed `add_entity_alias`/`edit_relation` ops (`policy.v3.json:260,593`). Skip or refuse pages that are open with unsaved edits. Title-pass links are left alone.
- **DATA-1.** (a) `checkView` flags only keys that nothing declares and no record holds; undeclared-but-present keys work as text (`viewFilters.ts:174-185`). (b) Retype half: flag misfit filters, and refuse while a board or chart groups by the field. (c) The ripple table covers columns, nested filters, sort, group levels incl. `GroupSpec.descend`, chart fields, `gallery.cover`, dashboard widget filter/global/group/value, layout heading/groups, view-tab scope, other types' rollup relation/property and `from.field`, and surviving `*.list.yml`. A `satisfies` table fails compilation when a key is missed. (d) Ship after DATA-7a: every ripple write triggers a full schema rebuild.
- **DATA-9.** (a) Refusing an unknown status or option is a NEW rule. TS checks shape only (`properties.ts:804-806`) and keeps ghost values (`schema.ts:446-449`), so either the owner rules or the asymmetry is documented as agent-only. (b) The artifact carries the status chain (project override → type → `DEFAULT_STATUSES`). (c) Normalize or refuse unbracketed relation values. (d) A refusal must not reveal options of a Type doc outside the run's read scope. (e) MCP `add`/`remove` deltas for multiselect, relation and person fields. (f) Reuse the operational `schema_invalid` code. Optional `base_hash` CAS. Refuse computed keys, the derived side and over-limit relations. Undeclared keys still pass.
- **DATA-2.** Owner must approve reversing M12.4b. A retype strips or flags filters on the field through `checkView` (Macro `views_without_tests_of`). "Convert into a new property" writes N files non-atomically until DATA-5 lands.
- **DATA-18.** Thread `grant.actor` and the run id into `update_frontmatter`, `create_note` and `append_to_note` (`mcp.rs:1595-1597`; `write.rs:265-268`).
- **DATA-5.** Keep L and require the recovery journal; model it on the projection-manifest pending-write protocol (`manifest.rs:1-16`, `reconcile.rs:44-50`). Five additions: (a) refuse `knowledge/` paths or route each through `capture_frontmatter_patch` (`lib.rs:98-131`); otherwise reconcile sees an OutOfBandEdit. (b) Every single-file write returns or refreshes `Entry.hash`, or CAS refuses the second optimistic edit (`vaultStore.ts:215-223`). (c) Keep staged temps safe from `clean_orphan_temps`' 60 s reap (`write.rs:134-158`). (d) Refusal codes get declared destinies: reuse operational `stale_view`/`schema_invalid`, or add to `policy.v3.json` and regenerate its digest. (e) Editor saves have no CAS, so an open page with unsaved edits can overwrite batch results. Crash tests: use the skip list.
- **DATA-6.** Effort L because of: new toast action buttons (`uiStore.ts:405,1051`); Cmd+Z arbitration against `useDiagramFile`'s window listener, BlockNote and CodeMirror; folder delete needs a whole-tree pre-image; and retiring every "no undo" comment and string (`useSortableList.ts:304`, `TableView.tsx:2500`, `PropertyEditor.tsx:39-41,72,82,118`, `RecordRowMenu.tsx:127`, `RecordTabs.tsx:138`). Undo says "unattributed" until DATA-18. The stack is session-only and stays out of the ledger.
- **DATA-8.** `describe_database` checks `may_read` on the Type doc itself (M34.4, `mcp.rs:1948-1953`). It reuses DATA-9's Rust Type-doc reader; without that it is L. Twin evaluator: get a reviewer ruling, or declare operator semantics as data (as `critical-attention.v1.json` does). Routing queries to the TS engine would give agents computed fields, but no Rust→webview request channel exists. Fix the `get_vault_context` text (`mcp.rs:1986`).
- **DATA-10.** A synchronous typed rejection `{code, rule, expected, actual}` needs a Rust view check (DATA-9's reader). An ephemeral uiStore card is not "queued". Inserting a block into the open BlockNote page needs a new channel, because every `insertBlocks` call is inside `MarkdownEditor.tsx`. Descoped M: Accept adds the view only, and the human inserts the block via `/database`.
- **DATA-4.** The "N skipped" footer is new for every numeric footer. Decide whether formulas may reference rollups (an empty rollup sum returns 0). DATA-9's artifact must learn `formula` as a computed kind.
- **DATA-11.** No "already imported" content dedupe; DATA-5 atomicity covers the lost-response case locally. Limits: 16 MiB, 100 columns, 10,000 rows. Alternative to `adopt.ts` inference: import as text, then convert through DATA-2.
- **DATA-12.** Strict gate mode: `evaluateFilters` passes absent values on not_equals/none_of/does_not_contain and skips half-built rules (`viewFilters.ts:452-506`).
- **DATA-13.** Ranks are keyed by stem, so DATA-7b must rewrite them. The Type doc grows one YAML key per ranked record. Use a permissive key generator: npm `fractional-indexing` 4.0.0 (CC0-1.0) or Rust `fractional_index` 2.0.2 (MIT). Per-view lane order and hidden lanes ship in the same change.

**Top three.**
- **DATA-3 + DATA-17 (S + S, high).** Measured: `made after 2026-07-01` returned false while `resolveField` gave 2026-08-01; is_empty matched a populated from-relation; sort by a rollup kept input order; group put everything in `__none__`. This is the correctness floor for formulas and charts. `created_time` must first stop resetting on every write, or DATA-3 makes a wrong value filterable.
- **DATA-1 (M, high).** Names stay as identity, so files stay readable. Port Macro's two halves: check (`checkView` → `unknown_field`, `unknown_option`, `op_does_not_fit`, shown as a "missing property" chip, never an empty table) and rewrite (rename ripple across every stored reference; retype flags misfit filters; refuse while grouped by). `checkView` is reused by DATA-2 and DATA-10. Land DATA-7a first so the N-file ripple is not N × 1.45 s.
- **DATA-9 (M, high).** In a CLI-driven app the agent is the main writer, and MCP writes are unchecked. Per-kind shape rules move into `shared/schema/field-kinds.v1.json`, read by TS `validateValue` and Rust `schema_check.rs`, with cases replayed by both suites (policy-as-data). It adds list deltas so agent and human edits compose. Its Rust Type-doc reader is the base for DATA-8 and DATA-10. Option-membership refusal is an owner call.

## 7. Conflicts with Cerebro conventions

- **Formula reads an empty number as 0** (`crates/database_sql/src/formula.rs:16-18,353`) vs *absent is never zero* → an absent input gives an absent result, and totals state "N skipped". This also fixes the existing silent footers and the `0` rollup sum.
- **Agent DDL / SaveDatabaseView write schema directly** vs TYPE_DOC_REFUSAL (`mcp.rs:2539-2633`) → agents read (DATA-8) and propose (DATA-10); the human Accept is the only writer.
- **Shared definitions + system catalog with per-type applicability** vs M47 D3 and no type special-casing → skipped (DATA-14).
- **Ids make renames safe** vs readable name/stem-keyed files → keep names; ripple + `checkView` (DATA-1) and link rewrite (DATA-7b).
- **Journal, positions, views and queries in Postgres** vs files are truth / two records → views, ranks and form config live in Type-doc frontmatter (M44 §5). The undo stack and the batch recovery journal are operational (memory or runtime.db), never the ledger.
- **One SQL engine for grids and agents** vs *policy is data, no twins* → value-shape rules go into a shared artifact (DATA-9). A Rust query evaluator twins `evaluateFilters`, and goldens only sample code-defined semantics (Number() coercion, UTF-16 `<`, toLowerCase). Needs a reviewer ruling; prefer declaring operator semantics in the artifact.
- **Option membership enforced** vs advisory schema with ghost values → DATA-9's refusal is a new, agent-only rule unless the owner rules otherwise.
- **Option delete clears cells** vs advisory schema → keep ghosts; never clear.
- **Undo refused as NotYours** vs single user with concurrent agent/external writers → undo reverts only the human's batches; keys changed since are skipped and reported as "unattributed" until DATA-18.
- **Typed op results surface to the UI** vs *human-UI actions never throw* → batch and undo store actions catch, toast and return `false`/`null`. `propose_view` returns typed `rejected {code, rule, expected, actual}` and is the first typed precedent (`propose_organize` returns prose).
- **Batch writes as plain storage writes** vs *knowledge is guarded* → DATA-5/DATA-7 refuse `knowledge/` paths or route them through the M23.7 capture valve, with a mock parity test.
- **Refusal codes** vs *two records, two destinies* → reuse operational `schema_invalid`/`stale_view`, or declare new codes in `policy.v3.json` (digest regenerated). `stale_target_version` is ledger-destined, so do not reuse it.
- **Public audiences, response ledger, Loro form layouts** vs local-only → form config in the Type doc; each submission is a page.
- **Reciprocal Parent/Subtasks dual writes** vs M12 derived `from:` relations → do not port.
- **Licenses**: AGPL crates and all-rights-reserved `apps/web` are read for behaviour only (as with the M48 GPL decision). Key generators come from permissive packages.

## 8. Verification notes

Stage 3 read the code and ran tsx/Python/Rust probes. It did not run cargo, vitest or e2e, and it did not build Macro.

- **Confirmed.** DATA-3 premise (tsx demo). DATA-1 premise, worse than stated: the active view keeps its old filters, sort and group, and `PropertyMenu` follows nothing. DATA-9 premise. TYPE_DOC_REFUSAL has no carve-out. Quadratic TS link resolution: `buildSchema` 64/232/1454 ms and `backlinksFor` 77/298/1895 ms at 1k/2k/5k notes; the demo vault has 137 notes, so dev never shows it. A file-tree rename rewrites no links. trash 5.2.6 has no macOS restore. All 61 cited Macro paths exist. Formula defer (M16) and per-card index decline (M46.2). Stale `get_vault_context` (`mcp.rs:1986`).
- **Refuted.**
  - *Undo names the actor* → every `vault_writes` call passes `None`. Added DATA-18.
  - *`created_time` is usable* → temp + rename resets the APFS birth time (measured). Added DATA-17.
  - *Footers already say "N skipped"* → `aggregate.ts` drops empties silently.
  - *CSV re-import is "already imported"* → Macro's `import_key` is per-request retry safety (`transfer.rs:66-80`), not content dedupe.
  - *`propose_view` returns typed queued/rejected like `propose_organize`* → that tool returns prose; its card is ephemeral.
  - *Batch writes are ordinary vault writes* → `knowledge/` writes go through the capture valve and `guard_human_move` (`lib.rs:98-131,1055-1057`).
- **Partial / corrected.**
  - Crash journal: required, so DATA-5 stays L, modelled on the projection manifest.
  - Twin evaluator: allowed only for non-policy rules, but goldens sample the semantics rather than define them.
  - TS validation: shape only, so option refusal is new.
  - Agents already get raw schema via `get_note`.
  - Undo exists for diagrams and knowledge revert, not for records.
  - DATA-15's skip rests on cost and license, not a prior decision.
- **Macro facts corrected.** Macro also rewrites views on column delete, retype and option delete (stage 2 kept only the check). CSV limit is 16 MiB in code (`transfer.rs:9-13`, `csv.ts:26-28`); the guide's 8 MB is stale (`docs/AGENT_GUIDE/databases.md:535`). `docs/PROPERTY_TARGET_ENTITY_TYPE_PLAN.md` says "no code changes", but the code implements it.
- **Effort changes.** DATA-6 M→L. DATA-10 M→L (or descope to M). DATA-8 stays M only by reusing DATA-9's reader.
- **Missed items folded in.** Birth time (DATA-17). Actor threading (DATA-18). Rectangle select (DATA-19). First-value inference (DATA-20). Recently deleted (DATA-21). List deltas (into DATA-9). Lane order/hidden lanes (into DATA-13). Knowledge-path handling (acceptance in DATA-5/7).
- **Macro open questions.** References do not filter generic mentions by viewer. Mention edges have no server reconciler. `entity_properties.entity_id` has no FK. Property events are missing from some compositions.
- **Still open.** Owner: DATA-2 (stop clearing), DATA-9 (refuse unknown options), DATA-13 (per-card rank). Reviewer: DATA-8 twin evaluator.

## 9. Where to read first

1. `crates/databases/README.md`
2. `docs/AGENT_GUIDE/databases.md`
3. `crates/database_sql/src/fold.rs`
4. `crates/models_databases/src/views.rs` and `crates/models_databases/src/views/check.rs`
5. `crates/databases/src/domain/service/views.rs` and `crates/databases/src/domain/service/ops/views.rs`
6. `crates/models_databases/src/cast.rs` and `crates/databases/src/domain/service/casts.rs`
7. `crates/models_properties/src/service/property_value.rs`, `crates/properties/src/domain/service_impl.rs` and `crates/properties/src/inbound/toolset/set_entity_property.rs`
8. `crates/models_databases/src/ops.rs` and `crates/databases/src/domain/service/ops.rs`
9. `crates/databases/src/domain/journal/guard.rs`, `crates/databases/src/domain/journal/invert.rs` and `apps/web/src/features/database/core/undo-stack.ts`
10. `crates/databases/src/inbound/toolset/describe_database.rs`, `crates/databases_sql/src/toolset/query_database.rs` and `crates/databases_sql/src/view_only.rs`
11. `crates/database_sql/src/formula.rs` and `crates/models_databases/src/formula.rs`
12. `apps/web/src/features/database/core/write-failure.ts`
13. `docs/AGENT_GUIDE/forms.md` and `apps/web/src/features/block-form/core/gate-evaluation.ts`
14. `crates/databases/src/domain/service/transfer.rs`
15. `crates/models_databases/src/position.rs` and `crates/models_databases/src/views/lanes.rs`
16. `crates/comms_db_client/src/attachments/get_attachment_references.rs` and `apps/web/src/lib/core/signal/mention.ts`
