# Outline: architecture (server, client state, actions, plugins, collaboration) - reference audit 2026-10-24

> **Scope:** Outline 1.12.0 snapshot. Server: command layer, model hooks/event log, Bull queues (event → processor → task), cancan policies and their serialization, presenters, RPC routes/validation/errors, cron/janitors, health watchdog, Hocuspocus collaboration, MCP tools, plugins. Client: MobX stores/models, policy cache, websocket invalidation, the actions system and WebMCP. Judged against Cerebro doors/receipts (CV-33), the four IPC adapters (CV-18), policy-as-data (CV-04/06), runtime.db (wakes, dispatch, followups), Zustand stores, the command catalog/keymap (CV-47), and the M93, M94.5, M96, M98 and M99 docs.
> **Files read:** ~60 Outline, ~40 Cerebro source, 15 program docs (master roadmap, implementation record, M93/M96/M98/M99 specs and plans, M96 action contract, M98 platform decision, M99 consumer matrix and authority decision).
> **Licence:** Outline is BSL 1.1 (`O/LICENSE`, change date 2030-10-23). **Ideas only, no code.** So no verdict below is adopt: every positive verdict is adapt (a clean rebuild in Cerebro's model) or already-have. `O/server/policies/cancan.ts` carries an MIT notice for upstream cancan, but the file ships inside the BSL work, so it is ideas only too.
> **Alias:** `O/` = `docs/examples/outline-main/`. **Basis:** [read] I read the code · [names] inferred from file/dir names · [docs] README/docs · [grep] a search count. No runtime behaviour was observed. Sibling dossier `outline-3-design-system.md` covers the menu/command-bar primitives; this one covers the architecture underneath them.

## Top findings

- **Ship the door's verdict with the data instead of re-deriving it.** For every entity it returns, Outline also returns `abilities` (`serialize(user, model)` gives `{action: bool or membershipIds}`). The UI gates actions only on these, and the server still authorizes every request. Cerebro's doors enforce correctly, but the UI rebuilds the rules in TS: `isKnowledgePath` has 96 non-test call sites in 56 files, and `agentAccess.ts` admits it "overclaims until the tripwire is followed". → **Add NEW:abilities: Rust-computed `EntryAbilities` in the scan DTO via M99.1, consumed by M94.5.**
- **M94.5 promises "menus and commands share labels and availability" but has no mechanism for it.** In Outline, one action definition (`visible`/`disabled`/`dangerous`/`perform`), resolved against an `ActionContext` of active models and policies, feeds menus, the command bar, buttons and agent tools. Cerebro's `CommandDef` covers keys, ⌘K, keycaps and Settings. Its menus are hand-built. → **Amend M94.5.**
- **Selected-store metadata writes are invisible to History and to CV-48 wake admission.** Outline writes its event row inside the mutation's transaction and fans out after commit. Cerebro's selected store already writes `metadata_receipts` in-transaction. But no `workspace_service` code records `vault_writes` [grep], and History, page attribution and CV-48 admission all read `vault_writes`. When agent doors adopt the store, hop and cycle limits would lapse (an unrecorded writer wakes a root). → **Amend the M99.6 consumer matrix and M99.7: relay receipts by `epoch` cursor.**
- **Fix the gap Outline leaves open: re-drive after commit.** Outline enqueues with `void globalEventQueue().add(model)` after commit, and I found no sweeper. A crash between commit and enqueue loses every reaction to that change. Cerebro's relay needs a durable cursor that is replayed at startup. → **M99.7, M98.5.**
- **A loop can be alive but not working.** Outline's `HealthMonitor` catches a queue that has stopped processing. Cerebro's ambient tick failures reach only `log::warn!`, and the diagnostic log has no reader (CV-06). So a wedged scheduler or dispatch loop is silent. → **Amend M98.4: record loop liveness and surface it in System.**
- **Push invalidations, not data, and keep object identity.** Outline sends `{id, updatedAt}` descriptors, skips its own echoes, and merges results into existing instances. Cerebro emits a unit `vault-changed` and replaces `entries` wholesale on every scan. → **Two candidate experiments for M93.7, gated by the M93.6 profiles.**
- **Don't import Outline's weaker forms.** At-least-once whole-job retries can duplicate notifications. The collab save loop gives up after 5 failures with only a log line. The lock and event helpers merely warn or skip when there is no transaction. Wire types are hand-mirrored. The batch API is not atomic. Cerebro's receipts, ACT fence, M93 save owner, generated DTOs and `applyBatch` are already stronger. → **Confirm M93.1, M96.3, M98.2 and M99.1.**

## Map

| Area | Path | What it does |
| --- | --- | --- |
| Command | `O/server/commands/documentUpdater.ts` | One function per mutation: apply fields, take a row lock (with optional `lastRevision` predicate, else 409), `saveWithCtx` |
| Model base | `O/server/models/base/Model.ts` | `*WithCtx` injects `{auth, transaction, ip, event.publish}`; hooks cache the changeset and insert the Event row in the tx; `findAllInBatches` keyset |
| Event log | `O/server/models/Event.ts`, `O/server/storage/transaction.ts` | `events` (actorId, authType, ip, changes, data); `AfterSave` enqueues via `afterCommit` on the root tx; `schedule()` = unpersisted |
| Queues | `O/server/queues/{index,queue}.ts` | globalEvents / processorEvents / websockets / tasks; attempts 5, exponential backoff, metrics |
| Fan-out | `O/server/services/worker.ts` | Event → one job per applicable processor; `perform`; `onFailed` after the last attempt |
| Processors | `O/server/queues/processors/{BaseProcessor,DebounceProcessor,RevisionsProcessor,BacklinksProcessor,SearchIndexProcessor,WebsocketsProcessor}.ts` | Derived state, debounce, push invalidation |
| Tasks/cron | `O/server/queues/tasks/base/{BaseTask,CronTask}.ts`, `O/server/services/cron.ts`, `O/server/routes/api/cron/cron.ts` | jobId single-flight, retries, stagger/partition, retention janitors |
| Watchdog | `O/server/queues/HealthMonitor.ts` | Wedged-queue detection → exit for supervisor restart |
| Authz | `O/server/policies/{cancan,utils,document}.ts` | `allow`/`can`/`authorize`/`serialize`; membership-ID grants; AsyncLocalStorage memo |
| Wire | `O/server/presenters/{document,policy,event}.ts` | Allow-list projections, public/private variants, `policies` payload |
| RPC | `O/server/routes/api/index.ts`, `.../documents/{documents,schema}.ts`, `O/server/middlewares/{validate,transaction,apiContext}.ts`, `.../api/middlewares/{apiResponse,apiErrorHandler,pagination}.ts` | `POST resource.verb` pipeline |
| Errors | `O/server/errors.ts`, `O/server/onerror.ts`, `O/app/utils/ApiClient.ts` | `id`/status/`isReportable`; unknown → internal; client mapping |
| Client state | `O/app/stores/base/Store.ts`, `O/app/stores/PoliciesStore.ts`, `O/app/models/{base/Model,Policy}.ts`, `O/app/models/decorators/Relation.ts` | Identity map, dedupe, cascade, policy cache |
| Push | `O/app/components/WebsocketProvider.tsx` | `entities` invalidation handling |
| Actions | `O/app/actions/{index,sections}.ts`, `O/app/actions/definitions/documents.tsx`, `O/app/types.ts`, `O/app/hooks/{useActionContext.tsx,useCommandBarActions.ts,useWebMCPActions.ts}` | One definition → menus / kbar / buttons / WebMCP |
| Plugins | `O/server/utils/PluginManager.ts`, `O/app/utils/PluginManager.ts`, `O/plugins/*/plugin.json`, `O/plugins/github/server/index.ts` | Typed hook registry |
| Collab | `O/server/collaboration/{PersistenceExtension,AuthenticationExtension,APIUpdateExtension,EditorVersionExtension}.ts`, `O/server/commands/documentCollaborativeUpdater.ts` | Y.js persistence, auth, API→live doc, version gate |
| MCP | `O/server/mcp/index.ts`, `O/server/mcp/tools/documents.ts` | Tools reuse commands + `authorize`, filtered by scope |
| Tests | `O/server/test/factories.ts`, `O/server/policies/document.test.ts`, `O/server/routes/api/*/*.test.ts` | Real-DB factories, ability matrices, auth-negative cases |

## Patterns that work

| ID | Pattern | Mechanism (how it actually works) | Why it works | Evidence [basis] | Cerebro today | Verdict | Phase |
| --- | --- | --- | --- | --- | --- | --- | --- |
| OUT1-01 | Ship the verdict with the data | `allow(User, action, Model, cond)` predicates run over preloaded memberships. `serialize(user, model)` checks every action registered for that class pair. Routes return `{data, policies:[{id, abilities}]}`. Client reads `policies.abilities(id)`; when absent it gets `{}` (all false) and refetches. Push `invalidatedPolicies` and `removeForMembership` revoke precisely. The server still `authorize`s every request | The UI never re-derives authority; one rule source; precise revocation | `O/server/policies/cancan.ts:140-186,277-324`; `O/server/presenters/policy.ts:11-19`; `O/server/routes/api/documents/documents.ts:1490,1524-1527`; `O/app/stores/PoliciesStore.ts:24-67`; `O/app/hooks/usePolicy.ts:13-39` [read] | Doors enforce (`src-tauri/src/knowledge.rs:373` `guard_human_write`). UI rebuilds the rule: `isKnowledgePath` 96 call sites / 56 files [grep]; `src/engine/okf.ts:60` "Mirrors canonical_path"; `src/engine/agentAccess.ts` header: "overclaims until the tripwire is followed" [read] | adapt (BSL idea) | NEW:abilities (DTO via M99.1; consumers M94.5, M94.8) |
| OUT1-02 | One action definition feeds every surface | `createAction({name, section, icon, shortcut, keywords, visible(ctx), disabled(ctx), dangerous, perform(ctx)})`. `ActionContext` carries active models (nested by `ActionContextProvider`), policies and location getters. Adapters: `actionToMenuItem`, `actionToKBar`, `useWebMCPActions`. One `performAction` path (analytics; error → toast) | Labels and availability can't drift; multi-select comes free (`getActiveModels`) | `O/app/actions/index.ts:42-52,145-238,240-317,319-357`; `O/app/types.ts:103-174`; `O/app/actions/definitions/documents.tsx:473-500` [read] | `CommandDef` feeds the keymap, ⌘K, keycaps and Settings (`src/app/commands/index.ts:17-38`, `src/lib/keys/registry.ts` `availableCommands`). Menus are hand-built: `src/views/RecordRowMenu.tsx`, whose own comment says "one of the two copies should eventually be the only one" [read] | adapt | M94.5 |
| OUT1-03 | Uniform mutation pipeline | `auth() → rateLimiter() → validate(zod) → transaction() → load scoped by userId → authorize → command(ctx) → present {data, policies}`; the `ctx.context` getter carries auth, tx and ip into `*WithCtx` | Each route is ~40 lines; one choke point | `O/server/routes/api/documents/documents.ts:1463-1528`; `O/server/middlewares/{transaction,validate}.ts`, `apiContext.ts:11-26` [read] | Stronger: IPC door → guard mints `WriteReceipt` → writer under `PathLock` → `NoteWriteAck` (`src-tauri/src/lib.rs:374-418`; `vault/receipt.rs` compile_fail tests). Outline only *warns* on a missing tx or ip (`Model.ts:305-315`) [read] | already-have | M99.1 (confirm) |
| OUT1-04 | Mutation record in the same transaction | `@BeforeSave cacheChangeset` keeps `{attributes, previous}`, skipping virtual, blob and `@SkipChangeset` fields. `@AfterUpdate insertEvent` writes the `events` row (name, actorId, authType, ip, changes, data) in `context.transaction` | Reactions never see an uncommitted change; the actor travels with the change | `O/server/models/base/Model.ts:241-396,494-556`; `O/server/models/Event.ts:81-90`; `O/server/storage/transaction.ts:18-36` [read] | Selected store writes `metadata_receipts` (epoch, actor, run, approver, before/after hashes) in the tx (`src-tauri/src/workspace_service/selected.rs:664-666`, `selected_schema_v3.sql`). No `workspace_service` file calls `vault_writes::record` [grep], so `runtime/write_log.rs`, History and CV-48 admission can't see it | adapt | M99.6 (matrix row), M99.7 |
| OUT1-05 | Typed fan-out to isolated consumers | The worker reads each event once and enqueues one job per processor whose `applicableEvents` names it (or `*`) and whose `shouldQueue` agrees. Each processor retries alone (5×, exponential backoff) and gets `onFailed` after its last attempt. Websockets run on their own queue | One broken consumer can't block the others; a cheap pre-filter avoids empty jobs | `O/server/services/worker.ts:53-153`; `O/server/queues/processors/BaseProcessor.ts:9-40`; `O/server/queues/index.ts:5-54` [read]. Gap: `void globalEventQueue().add(model)` (`Event.ts:88`), no re-drive found [read+grep] | Wakes: INSERT OR IGNORE on a content key, claimed with a lease, closed outcomes (`src-tauri/src/runtime/wakes.rs` header). Matching runs in the webview from scan diffs (`src/engine/events.ts`) [read] | adapt (a cursor per consumer) | M99.7, M98.5 |
| OUT1-06 | Idempotent derivations that re-read state, plus a version-check debounce | Processors refetch current rows. Revisions skips when content and title are identical; Backlinks checks `findOne` before create. Debounce requeues `documents.update.delayed` at +5 min and drops it if `updatedAt > event.createdAt` | At-least-once delivery is safe for derived data; bursts collapse without locks | `O/server/queues/processors/RevisionsProcessor.ts:41-54`, `BacklinksProcessor.ts`, `DebounceProcessor.ts:13-49` [read] | `SETTLE_MS` 4 s (`src/agent/useJobRunner.ts:54`); 5-min `vault_writes` coalescing (`runtime/vault_writes.rs`); catch-up compares hashes [read] | already-have | M98.2 (derivation steps) |
| OUT1-07 | Bounded retries with single-flight | `BaseTask.schedule` dedupes on `jobId(props)` while a job is queued or active. 5 attempts with exponential backoff. `scheduleOptional` logs instead of failing the caller | Bounds duplicate and stampede load | `O/server/queues/tasks/base/BaseTask.ts:21-97` [read] | Transactional claim, lease, `recover_expired_leases`, BUSY/BUDGET retry consts (`src-tauri/src/runtime/dispatch.rs` header, `wakes.rs`) [read] | already-have | M98.2 (confirm) |
| OUT1-08 | Liveness watchdog | Each queue records activity on active/completed/failed. Every 30 s, if the queue has been idle for 30 s, a dedicated client counts waiting+paused jobs (10 s timeout). More than 50 waiting, or a failed check, twice in a row → `fatal` + exit for restart | Catches "running but not working", which error logs miss | `O/server/queues/HealthMonitor.ts:17-187`; `O/server/services/worker.ts:203-205` [read] | Ambient tick `Err` → `log::warn!` only (`src-tauri/src/ingest/ambient.rs:150-156`); the log has no reader (CV-06). `runtime/status.rs` and `health.rs` cover DB recovery, quota, sources and ingestion, not loop liveness [read+grep] | adapt (record and surface; no auto-exit) | M98.4 |
| OUT1-09 | Janitors per retention class | `CronTask` with `limit`, a partition window, deterministic stagger and Background priority (e.g. purge documents deleted >30 days ago, in batches). In-process `setInterval` plus a secret-checked `cron.:period`. No persisted last run, so a missed run is skipped | Retention is bounded, scheduled code | `O/server/queues/tasks/base/CronTask.ts`; `.../tasks/CleanupDeletedDocumentsTask.ts:12-53`; `O/server/services/cron.ts` [read] | Closed `SystemWriter` janitors (`src-tauri/src/vault/receipt.rs`); M95.3 `prune_content`; M98.3 `reconcile_waits(now, limit)`; M98 `skip_missed` [read/docs] | already-have | M95.3, M98.3, M98.4 (confirm) |
| OUT1-10 | Presenters as an explicit wire projection | Each presenter copies named fields. `isPublic` strips private fields. `x-api-version` switches the shape. The event presenter hides `changes` and IP from non-admins | A new column never leaks | `O/server/presenters/document.ts:29-120`, `event.ts` [read] | Rust-declared DTOs + schemars → generated TS with drift checks (M99.1). Outline's client models hand-mirror their fields (`O/app/models/decorators/Field.ts`) [read/docs] | already-have (stronger) | M99.1 |
| OUT1-11 | Edge validation | `validate(Schema)` zod-parses `ctx.request` into `ctx.input`; the first issue becomes `"field: msg"`; `refine` rules (no self-parent) | Handlers see only typed input | `O/server/middlewares/validate.ts:8-30`; `O/server/routes/api/documents/schema.ts:392-509` [read] | serde-typed commands; M96.1 bounded canonical parser; M99.2 tagged values [docs] | already-have | M96.1, M99.2 |
| OUT1-12 | Error taxonomy with an edge normalizer | Factories take `(status, message, {id, isReportable})`. One edge maps driver errors (validation, empty result, ENOENT, date range) to typed errors. Unknown errors become `InternalError` with no message leak. The client maps status/id to error classes | Stable codes without every call site cooperating | `O/server/errors.ts`; `O/server/routes/api/middlewares/apiErrorHandler.ts:30-75`; `O/server/onerror.ts`; `O/app/utils/ApiClient.ts:327-389` [read] | policy.v3 codes + destinies (CV-06); typed proposal refusals (CV-03). IPC doors return `String`, and `set_page_full_width` reports a knowledge read-only refusal as `CapabilityUnavailable` (`src-tauri/src/lib.rs:197-202`) [read] | adapt (one Rust edge mapper → registered codes) | M99.1 |
| OUT1-13 | Client identity map | `Store.data: Map<id, Model>`. `add()` merges into the existing instance (`updateData`, per-key `isEqual`), so untouched objects keep their identity. `requests` dedupes in-flight fetches. 403/404 evicts. `@Relation onDelete/onArchive` cascades | Stable identities make memoized rows cheap | `O/app/stores/base/Store.ts:79-123,247-334,476-527`; `O/app/models/base/Model.ts:221-260` [read] | `entries: Entry[]` replaced wholesale per scan (`src/stores/vaultStore.ts:50,298`); 56 `entries.find(` in non-test .tsx [grep]. Cerebro's scan-order guards (`scanTicket`/`landedScan`/`writes.moved`, `:274-298`) are stronger than Outline's (its `add` merges late responses) | adapt (hash-keyed reuse + `byPath`) | M93.7 (profile-gated) |
| OUT1-14 | Push invalidations, not data | The `entities` message is `{documentIds:[{id, updatedAt}], collectionIds, invalidatedPolicies}`. The client skips matching versions (its own write); otherwise it drops policies and refetches through the authorized read. 403/404 → permanent remove | Small payloads; no echo; no auth leak | `O/server/queues/processors/WebsocketsProcessor.ts:57-121,187`; `O/app/components/WebsocketProvider.tsx:182-262` [read] | Unit `vault-changed` after a 350 ms debounce (`src-tauri/src/vault/watcher.rs:27,185,269`); own writes suppressed by hash (`:62`, 4 s window); frontend full rescan [read] | adapt (paths + hashes, `lost` flag) | M93.7 (profile-gated) |
| OUT1-15 | Save loop that keeps the newest edit | Clear the dirty flag before the write and restore it on failure. Snapshot the Y.Doc synchronously before I/O. Canonicalize via a schema round-trip and skip unchanged content. Attribute the last editor | No spurious revisions; edits made during I/O go to the next save | `O/server/collaboration/PersistenceExtension.ts:165-256`; `O/server/commands/documentCollaborativeUpdater.ts:49-107` [read] | M93 REL-01..03 owner/generation/ack, retained exact draft, Retry [docs]; Outline gives up after 5 failures, log only (`:234-252`) | already-have (stronger) | M93.1 |
| OUT1-16 | Re-admit on access change | `invalidate(scope)` closes matching live connections; clients reconnect into `onAuthenticate`, the one place authority is decided. An empty scope is refused. A connection is read-only when `!can(update)` | No stale grant outlives a change | `O/server/collaboration/AuthenticationExtension.ts:62-110` [read] | The agent record is re-read at dispatch (`effective_ask_first`, `admit_before_dispatch`, per the M99 decision packet). M96 revoke disables dispatch and invalidates approvals first [docs] | already-have | M96.2, M96.3 (confirm) |
| OUT1-17 | Same commands behind every transport | MCP `update_document` loads the scoped doc, calls `authorize` and then `documentUpdater`, exactly like HTTP. Tools are filtered by OAuth scope; a no-op update returns an error | One door, one set of guards | `O/server/mcp/index.ts:24-104`; `O/server/mcp/tools/documents.ts:631-745` [read] | `vault::write` behind Human/Agent/ConceptDoor/System receipts; token clients use the normal guards (CV-49); `expect_hash` (CV-23) beats Outline's tool, which has no `lastRevision` [read] | already-have | M96.4 (confirm) |
| OUT1-18 | Typed in-tree plugin registry | `Hook` enum → value-type map (API, AuthProvider, IssueProvider, Processor, Task, Unfurl, Mention, Uninstall). `plugin.json` holds {id, priority, after, deployments}. Plugins are glob-loaded with try/catch per plugin and enabled by env. Client hooks: Settings (`enabled(team,user)`), Imports, Icon | Providers plug in without core switch statements; a broken plugin doesn't block boot | `O/server/utils/PluginManager.ts:35-183`; `O/app/utils/PluginManager.ts:14-160`; `O/plugins/github/server/index.ts` [read] | Planned `OutboundAdapter::{discover,invoke,reconcile,cancel}` (M96.4) and `connections/providers/{mod,github}.rs` (M96.5) [docs] | adapt (a closed Rust provider row) | M96.5 |
| OUT1-19 | Version gate at every entry | The editor middleware and collab `onConnect` both refuse clients with an older editor major version; each doc keeps the highest editor version that wrote it | An old writer can't damage newer content | `O/server/routes/api/middlewares/editor.ts`; `O/server/collaboration/EditorVersionExtension.ts` [read] | `format_gate::guard_legacy_access` (`src-tauri/src/workspace_service/authority.rs:546`); the watcher watches `FORMAT_MARKER` (`vault/watcher.rs:297`) [read] | already-have (in progress) | M99.6 (confirm every entry) |
| OUT1-20 | Keyset paging with a tie-break | `findAllInBatches` appends the PK to the order and builds an OR cursor from the last row. Client requests fetch `limit+1` to detect a next page without a COUNT | Pages stay stable under writes | `O/server/models/base/Model.ts:405-487`; `O/server/routes/api/middlewares/pagination.ts:22-60` [read] | M93.3 `(started_at, run_id)` strict less-than + one extra row; M99.4 cursor binds query/snapshot [docs] | already-have | M93.3, M99.4 |
| OUT1-21 | Ability-matrix tests | Per role × state, the test asserts the whole `serialize()` set. 37 route test files carry "should require authentication" cases | A refactor can't silently widen access | `O/server/policies/document.test.ts:20-45`; `O/server/routes/api/documents/documents.test.ts` [read+grep] | Shared goldens replayed by Rust+TS (CV-04, CV-29); receipt compile_fail tests (CV-33) [read] | adapt (golden for OUT1-01) | NEW:abilities |
| OUT1-22 | UI actions exposed as agent tools (WebMCP) | Visible, non-`dangerous` actions that have an `analyticsName` register as `document.modelContext` tools while mounted; errors go back to the agent | Zero extra tool code | `O/app/hooks/useWebMCPActions.ts:30-147`; `O/app/utils/ModelContext.ts` [read] | The agent surface is `tools.v1.json` through Rust doors (CV-04/29/32/33) [read] | avoid | M96.1 (no change) |

### OUT1-01: serialized abilities. Key path

- **Outline.** `allow(User, "update", Document, (actor, d) => and(...))` (`O/server/policies/document.ts`). Conditions are pure over preloaded data, and `invariant` fails loudly if a relation wasn't loaded (`O/server/policies/utils.ts:198-201`).
  - `serialize(performer, target)` finds the action set once per class pair (the `actionsByClass` cache), evaluates `can` inside an AsyncLocalStorage memo scope, and turns any throw into false (`cancan.ts:140-186`).
  - `presentPolicies` produces `[{id, abilities}]`, and every write or read route returns it beside `data` (24 route files [grep]).
  - On the client, `Store.addPolicies` runs on every response. `abilities(id)` returns `flattenedAbilities`, or a frozen `{}` when the policy is missing, which `usePolicy` then refetches.
  - Invalidation: push messages carry `invalidatedPolicies`; `removeForMembership(id)` drops only the abilities that membership granted; a changed collection policy removes its child documents' policies (`O/app/models/Policy.ts:40-66`).
- **Cerebro shape (proposed).** Declare it in Rust with schemars, so the TS is generated (M99.1 mechanism):

  ```rust
  pub enum Ability { Allowed, Refused { code: String } } // code ∈ policy.v3 codes
  pub struct EntryAbilities { edit_body, edit_fields, rename, delete, duplicate, comment, verify: Ability }
  ```

  - Compute it during the scan from the **same pure guards the doors call** (`guard_human_write`, `guard_human_move`, `guard_verify`, mail/Trash/reserved-name rules), with no I/O per entry.
  - Attach it to `Entry` (`src-tauri/src/vault/entry.rs`, next to `authority`).
  - `mockIpc` computes it from the existing shared target cases (CV-07 parity).
  - The UI reads `entry.abilities.*` wherever `isKnowledgePath` currently means *permission*. Keep it where it means navigation or display.
  - Doors still mint receipts and refuse (CV-33). Abilities are hints, recomputed on every scan and **never persisted** (see Avoid).
  - Optional second step: move `agentAccess.ts`'s explanation behind a Rust `explain_access(agent, path)` read, to retire the tripwire twins (CV-46).

### OUT1-02: one action row, many surfaces. Key path

- **Outline.** Each definition is resolved per surface: `actionToMenuItem` (visible, disabled, dangerous, shortcut, submenus, groups), `actionToKBar` (sections carry a priority), and `useWebMCPActions`. Visibility usually reads `context.stores.policies.abilities(doc.id).<action>` over `getActiveModels(Document)`, so the same row serves single and multi-select.
- **Cerebro shape.** Extend each `CommandDef` row in `src/app/commands/index.ts` with `icon?`, `danger?` and `available?(ctx) → {ok:true} or {ok:false, code}`, where `ctx = {selection: Entry[], pane, abilities}`.
  - Add one adapter, `menuItemsFor(ids, ctx)`, that renders `components/ui/Menu.tsx` items. `RecordRowMenu`, `DetailHeaderActions` and the sidebar context menus render from rows, and their `run` still goes through `useCommand`/`runCommand` (CV-47 unchanged).
  - Add a test like `keydownRail.test.ts`: every menu item id is a catalog row. Disabled items show the refusal code's sentence (UX-06), not a silent omission (owner Q1).

### OUT1-04/05: transactional record plus after-commit fan-out. Key path and the gap

- **Outline.**
  1. `doc.saveWithCtx(ctx)` → `beforeSaveEvent` caches the changeset → `afterUpdateEvent` → `insertEvent` writes the `events` row in `context.transaction` (`Model.ts:241-396`).
  2. `Event.@AfterSave` → `afterCommit(root, () => void globalEventQueue().add(model))`.
  3. The worker fans each event out to `processorEventQueue`, one job per applicable processor (`worker.ts:53-88`).
  4. Each job runs `perform`, retries 5×, and calls `onFailed` after the final attempt.
  5. **Gap:** if the process dies after commit but before `add`, the row exists and nothing replays it. I found no sweeper under `O/server/queues/` [grep].
- **Cerebro shape (M99.7).** The selected store's transaction already inserts `metadata_receipts(epoch, record_id, revisions, before/after hashes, actor, run_id, approved_by)`. Add a relay:

  ```text
  relay_receipts(workspace_id) -- after commit, and at startup
    for r in workspace.db metadata_receipts WHERE epoch > runtime.db receipt_cursor(workspace_id)
      INSERT OR IGNORE vault_writes(kind='vault.meta', path, actor, run_id, approved_by, at, key=(workspace_id, epoch))
    advance receipt_cursor in the same runtime.db transaction
  ```

  - **Best-effort, like `vault_writes` today:** the relay never fails the write, and it catches up from the cursor.
  - **Consumers don't change:** `write_log::page_attribution`, `activity.rs` History and CV-48 admission keep reading `vault_writes`.
  - Outside body edits still arrive through the watcher/scan diff (`src/engine/events.ts`) and stay "unattributed".
  - Optional `changes_json` (key → prev/next) for field-level History is a retention decision (owner Q2).
- **Why now:** `metadata_receipts.operation` already allows `page.body`. Once agent doors adopt the store, an agent write with no `vault_writes` row wakes a *root* under CV-48, bypassing the hop and cycle accounting.

### OUT1-08: liveness watchdog. Key path

- **Outline.** `HealthMonitor.start(queue)` per queue (`worker.ts:203-205`):
  - listeners update `lastActivityTime`;
  - a 30 s interval checks idle > 30 s, then counts waiting+paused jobs over a separate Redis client with a 10 s timeout;
  - unhealthy means more than 50 waiting or a failed check;
  - 2 consecutive failures → `Logger.fatal`, then `process.exit(1)` after 5 s (`HealthMonitor.ts:55-187`).
- **Cerebro shape.** Keep `LoopHealth {loop_id, last_ok_at, failing_since, consecutive_failures, last_code}` in process memory, as `runtime/status.rs` does (state re-derived at open, not a DB row), for each of: the ambient tick, wake dispatch and the M98 scheduler.
  - `ingest/ambient.rs` updates it next to its existing `log::warn!`.
  - From 2 consecutive failures, SystemSection shows a fourth face: "Background checks have failed since 14:02 (code)". M98.4's "Runs while Cerebro is open and this vault is ready" gains a "but the scheduler is not running" state.
  - Never auto-restart, and never map a failure to zero work (CV-05).

### OUT1-14 (+13): invalidation descriptors and identity reuse. Key path

- **Outline.** `WebsocketsProcessor` finds the channels from memberships and emits `{id, updatedAt}`, never bodies. The client compares versions, skips its own echo, and calls `fetch(id, {force:true})` through the authorized read; 403/404 → `remove(id, {permanent:true})`. `Store.add` merges into the existing instance.
- **Cerebro shape (only if M93.6 attributes cost to rescans/re-renders).**
  - Emit `vault-changed {changes: [{path, hash}] or null}`, where `null` means the OS dropped events (`is_forced_rescan`) and forces a full rescan. This changes the listener adapter in `src/lib/ipc.ts:523-531` (CV-18 contract test).
  - `vaultStore` re-reads only the listed entries.
  - When a scan lands, reuse the previous `Entry` object if `path`, `hash` and the parse inputs are equal, and keep a `byPath` map for per-row lookups. Memoized rows and derivations then key on identity (M93.7's "invalidate by vault/entry/schema").

## Avoid / doesn't transfer

- **At-least-once whole-job retries for consequential effects.** Tasks retry 5× (`BaseTask.ts:88-97`). `DocumentPublishedNotificationsTask` calls `Notification.create` three times with no dedupe key (`:56,109,134`), and the notifications indexes are non-unique (`O/server/migrations/baseline/schema.sql:1539-1563`), so a partial failure can duplicate notifications [read]. → Keep ACT's `requestKey` and unknown-effect fence (M96.3). M98's "retry step" applies to read/transform/condition only.
- **Giving up on a save after N failures.** `PersistenceExtension.ts:234-252` stops after 5 failures with only a log line. M93 retains the draft and surfaces the failure. Don't add a cap.
- **WebMCP (UI handlers as agent tools)** bypasses doors, receipts, grants and ask-first (CV-28/29/32/33). Cerebro's single agent surface stays `tools.v1.json`.
- **A persisted policy cache.** `StorePersistence` hydrates `PoliciesStore` (`persistable = true`, `PoliciesStore.ts:10`) as stale data. Abilities must be recomputed per scan (M93: no stale snapshot participates in grants or writes).
- **Runtime-optional safety.** `LockHelper.acquire` silently skips without a transaction (`O/server/storage/LockHelper.ts:30-32`), and `insertEvent` only warns (`Model.ts:305-315`). Cerebro's compile-time `PathLock`/receipt is the right shape; don't relax it.
- **A non-atomic batch API.** Sub-requests each run in their own transaction, two at a time (`O/server/routes/api/batch/batch.ts:49,221-222`). Database-wide rewrites stay one `applyBatch` (CV-38).
- **Hand-mirrored wire types** (presenters plus client `@Field` models, no generated link). Keep M99.1 generation.
- **MCP instructions that name tools** (`"Use the "list_users" tool"`, `O/server/mcp/index.ts:107`) would violate CV-19.
- **Silent optimistic revert.** `Comment.addReaction` reverts in a bare `catch` with no message (`O/app/models/Comment.ts:150-166`). That breaks CV-03 (catch and toast).
- **Server/multi-user machinery:** Redis/Bull, Hocuspocus/Y.js CRDT, teams, memberships, JWT, CSRF, rate limits. A single-user files-first vault with one writer per file (CV-21) has no peer to merge with. Take the ideas (in-tx records, invalidation descriptors, re-admit-on-change), not the infrastructure.

## Implications for M93-M99

- **M93**
  - Confirm M93.1/M93.2 (OUT1-15). Outline's snapshot-before-I/O and dirty-flag restore match REL-01, and its give-up cap is the failure REL-03 forbids.
  - Confirm M93.3 (OUT1-20).
  - **Amend M93.7:** add two profile-gated candidates, OUT1-13 (hash-keyed `Entry` reuse + `byPath`) and OUT1-14 (`vault-changed` paths + hashes with an overflow flag). Both are measured by M93.6 and neither replaces the access/find tests.
- **M94**
  - **Amend M94.5:** implement "menus and commands share labels and availability" as rows with `icon`/`danger`/`available(ctx)` rendered by one Menu adapter (OUT1-02; primitive side in `outline-3-design-system.md`), plus a test that every menu item id is a catalog row.
  - **Add NEW:abilities**, consumed in M94.5 and M94.8: Rust `EntryAbilities` in the scan DTO, with refusal codes driving disabled-with-reason (OUT1-01). The ability-matrix golden (OUT1-21) is replayed by Rust and the mock.
- **M95:** Confirm M95.3's bounded prune (OUT1-09). No other change.
- **M96**
  - Confirm M96.3 / ACT-04/05 (Outline's retries show the duplicate risk), M96.2 revoke-first (OUT1-16) and M96.4 one-door transports (OUT1-17).
  - **Amend M96.5:** each provider is one closed registry row {definitions, safe check, disconnect cleanup, settings panel id}; a provider whose init fails is `unavailable` and the others are unaffected (OUT1-18, ACT-07).
  - Confirm M96.1: no UI-action tool path (OUT1-22).
  - Watch: an MCP skills resource extension (`O/server/mcp/skills/index.ts`) if product Skills are ever served to token clients.
- **M97:** No change from this slice.
- **M98**
  - **Amend M98.4:** loop liveness (OUT1-08) in the readiness copy and in System; add the test `scheduler_failure_is_visible_after_two_ticks`. Confirm the `skip_missed` default (Outline's cron never catches up).
  - **Amend M98.2/M98.5:** Rust trigger matching consumes relayed receipts by cursor for Cerebro-made metadata changes, with scan diffs only for outside edits. Step retry is limited to derivation steps (OUT1-05/06/07).
- **M99**
  - **Amend M99.6 consumer matrix:** add rows for the `vault_writes` readers (`runtime/write_log.rs::page_attribution`, `runtime/activity.rs`, wake admission per CV-48) and for `src/engine/events.ts`. Today selected writes record only `metadata_receipts` [grep].
  - **Amend M99.7:** an epoch-cursor relay into runtime.db, idempotent and replayed at startup, plus crash tests between metadata commit and relay (OUT1-04/05).
  - **Amend M99.1:** one edge error mapper to registered codes, so a knowledge read-only refusal is not `capability_unavailable` (OUT1-12). `EntryAbilities` joins the generated DTOs.
  - Confirm M99.6's gate at every entry point (OUT1-19).

## Owner questions

1. **Unavailable actions:** should menus and the palette *hide* them (Outline's `visible`), or *show them disabled with the door's reason* (fits CV-05/UX-06 honesty, but makes menus longer)?
2. **Field-level history:** may Cerebro keep each metadata change's previous values (e.g. `status: todo → done, by agent X`) in app-data for History and per-key undo beyond the session? If so, for how long, and should mail-derived fields be excluded?
