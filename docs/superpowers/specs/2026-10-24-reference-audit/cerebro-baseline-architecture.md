# CBAR — Cerebro baseline: architecture, features, M93–M99 status

> Cross-checked 2026-10-27; see codex-crosscheck/.

Slice CBAR of the 2026-10-24 reference audit. Use it to check any "Cerebro lacks X" claim.

**Basis tags:** [read] code read (module docs, DDL, registration lists, greps) · [docs] AGENTS.md, plans, records · [names] file or dir names only. "Absent" means a grep returned zero hits; the pattern is quoted.

**Source identity:** HEAD `6c92709` ("pre M93 rollback") plus a dirty shared tree: 472 status lines, 218 untracked paths, 254 tracked files changed (+19,339/−3,472). The untracked set holds ~40.1k Rust and ~22.2k TS/CSS lines. **No M93–M99 code is committed**, and part of M92 is uncommitted too, e.g. `src-tauri/src/agent/turn_input.rs` [read: `git status`, `git diff --stat`, `git log`]. Record line refs below are `plans/2026-10-23-m93-m99-implementation-record.md` as read on 2026-10-24 ("rec Lnn"). That file is untracked and still being edited, so line numbers may drift.

---

## 0. Facts that answer common "Cerebro lacks X" claims

| Claim to check | Baseline reality | Evidence |
| --- | --- | --- |
| "No version history" | Git per vault (commit, history, diff, restore, remote, clone, conflicts: 30 `git_commands::*`). Run commits carry trailers. Opt-in recovery journal of displaced bytes (M93.9). | `src-tauri/src/git/`, `git/changeset.rs`, `vault/recovery.rs`, `src/history/RecoveryVersions.tsx` [read] |
| "No search" / "needs an index" | Ranked BM25 with field weights over a stat-keyed corpus cache. No index, deliberately. Tokens are recomputed per query, unmeasured past the demo vault. | `src-tauri/src/search.rs` header, `vault/corpus.rs` [read] |
| "No semantic retrieval" | Graph expansion over the knowledge base, "Not a vector space". No embeddings. | `src-tauri/src/retrieval/mod.rs:3` [read] |
| "No backlinks / mentions" | `backlinksFor`. Raw-occurrence discovery plus explicit Link mention (M97.5). | `src/engine/links.ts:80`, `src-tauri/src/source_occurrences.rs`, `src/knowledge/MentionResults.tsx` [read] |
| "No trash / undo" | Vault Trash `.trash/<stamp>/` with a 30-day purge to the OS Trash. Session undo of the person's batches. | `vault/trash.rs`, `src/stores/undoStore.ts`, `vault/batch.rs` [read] |
| "No durable action/approval model" | It exists only as **test-gated** code. Production runtime.db v35 already has the V34/V35 tables. | `actions/mod.rs:1-36`, `runtime/schema.rs` V34–V35 [read] |

> **2026-10-27 (Codex cross-check, status-drift S11):** No longer only test-gated: `actions/catalog`, `schema`, `effect_kernel`, `native_authority`, `native_owner` and the GitHub adapter (`github_issues`) compile in production (`actions/mod.rs:1-40`); macOS native import is live (`CredentialWork::NativeImport`, `native_account_commands.rs:52`). Still cfg(test): `approval`, `admission`, `service`, `recovery`, `types`.

| Claim to check | Baseline reality | Evidence |
| --- | --- | --- |
| "No SQLite/structured metadata" | runtime.db (55 tables) and the ledger index (20 tables) are in use. The owner selected SQLite workspace metadata plus Markdown bodies for a future format. It is **inactive**. | `runtime/schema.rs`, `ledger/index.rs`, `specs/2026-10-23-m99-workspace-authority-decision.md` [read/docs] |
| "No callouts/toggles/columns" | Callout, mermaid, whiteboard, sheet, database, subPages, pageCard, columns, ai, toggle, toggle-heading and indent all exist, each with a Markdown carrier. | `src/editor/blocks.tsx:148-165`, `src/editor/markdown.ts` [read] |
| "No API-key backend" | Correct, and intentional. The user's Claude Code CLI is the only backend. M96.8's second backend is conditional and not started. | `src-tauri/src/agent/mod.rs` `build_args`, plans M96 [read/docs] |
| **Truly absent** (grep = 0) | React error boundaries (`ErrorBoundary\|componentDidCatch\|getDerivedStateFromError`). List virtualization (`react-window\|@tanstack/react-virtual\|useVirtualizer\|virtualiz`). Feature flags. CRDT libraries (no yjs/automerge/loro in `package.json`). Math/KaTeX. Graph view. PDF/print export. i18n. Peek "Open beside" (`app/commands/peek.commands.ts` has next/prev only). ~~Durable chat archive. Workflow engine.~~ | greps over `src/`, `package.json` [read] |

> **2026-10-27 (Codex cross-check, CX-XCUT-05):** Both now exist, built but not enabled or accepted: chat archive `src-tauri/src/conversations/{rows,export,transport}.rs`; workflow engine `src-tauri/src/workflows/` (21 files, `runner.rs`) plus `runtime/workflows.rs`. Still absent (grep 2026-10-27): error boundaries, list virtualization, KaTeX, page PDF/print, peek Open beside.

---

## 1. Architecture map

### 1.1 Process and authority

```
React 19 webview (src/) ──4 IPC adapters──► 229 Tauri commands (lib.rs generate_handler!) ──► Rust services
  └ localStorage cerebro.* (58 keys)            vault/ ─► <vault>/*.md|.canvas|.mmd, .cerebro/, .comments/, .trash/
                                                runtime/ ─► <app-data>/runtime.db (user_version 35)
                                                ledger/ ─► <vault>/.cerebro/ledger/*.ndjson + <app-data>/<store_id>.sqlite (cache)
Claude Code CLI ◄─argv/stdin── agent/ (spawn.rs)   CLI ──MCP 2025-06-18, loopback, per-run bearer──► mcp.rs (39 tools)
Other apps ──personal token, 2nd loopback port, off by default──► client_access/
```

Evidence: `mcp.rs:68` `PROTOCOL_VERSION = "2025-06-18"`. `ledger/index.rs` header ("SQLite in app-data… never authoritative"). `runtime/schema.rs` header ("runtime.db is shared by every vault"). `runtime/mod.rs:141` `USER_VERSION = 35` [read]. Bundle targets `["app","dmg"]` and a strict CSP with the `cerebro-file:` scheme (`src-tauri/tauri.conf.json`). Capabilities are `core:default`, `dialog:default` [read].

### 1.2 Rust modules (`src-tauri/src`, ~326k lines with inline tests)

Status: **P** production · **T** `#[cfg(test)]` only · **N** new, uncommitted (M92–M99).

| Module | Role | St. |
| --- | --- | --- |
| `vault/` (25 files) | scan/parse/write, path locks, `receipt.rs`, `batch.rs` journaled batches, `trash.rs`, `comments.rs` sidecars, `corpus.rs`, `schema.rs`/`dates.rs`/`query.rs`/`agenda.rs`/`views.rs` twins, `watcher.rs` (notify, 350 ms, own-write suppression) | P |
| `vault/recovery.rs` + `recovery/` | opt-in displaced-byte journal, `recovery.sqlite` outside the vault (M93.9) | P,N |
| `runtime/` (46 files) | runtime.db: runs/meter, wakes, followups, dispatch/leases, catchup, sessions, budget, governance, fleet (SELECT-only via `read_only.rs`), activity, client tokens, reminders, batch journal | P |
| `runtime/fleet/history.rs` | scoped keyset run history and lineage (M93.3) | P,N |
| `runtime/{action_authority,action_invocations,run_configuration}.rs` | M96.3 / M97.3 state | T,N |
| `agent/` (26 files) | CLI spawn/args, `fold.rs`, `transcript.rs`, `meter.rs` ContextBook, `interaction.rs` ask seam, `condition.rs`, `thread_turn.rs`, `cli_agents.rs`, `turn_input.rs` (CV-65) | P |
| `agent/{readiness,admission,publication}.rs` | M93.5 CLI discovery; M96 native admission/publication provenance | P,N |
| `agent/configuration.rs` | M97.3 projection | T,N |
| `mcp.rs` (21.6k lines) | loopback MCP server, 39 tools, all grants/guards | P |
| `client_access/listener.rs` | personal-token listener (M62.5b) | P |
| `knowledge.rs` | guards on the OKF bundle (`write_concept`/`recheck`/`verify`) | P |
| `ledger/` (44 files) | hash-chained NDJSON ledger, reducer, capture, reconcile, index | P |
| `ingest/`, `maintain/`, `monitor/`, `attention/`, `dynamics/`, `conflict/`, `convergence/`, `assembly/`, `retrieval/`, `trigger/` | knowledge pipeline: ambient ingest, maintenance pass, Source Monitor, lanes, belief dynamics, conflict, convergence, query-time assembly, graph expansion, deferral registry | P |
| `eval/` | older eval harness | T |
| `policy/` (22 files) | loaders for `shared/policy/*` (table, tools, tool_approval, subagents, mail…) | P |
| `git/`, `git_commands.rs`, `forge.rs` | vault git; read-only PR state via the user's `gh` | P |
| `sheet/` | IronCalc fences, grid, AI scratch, XLSX import/export | P |
| `canvas/` | JSON Canvas codecs, bounded agent read/edit | P |
| `files/` (+`extract/`) | kinds table, contained bytes, `cerebro-file:` scheme, thumbs, docx/pptx/xlsx extraction behind limits | P |
| `import/` | source identity/stamps, Notion capture and door | P |
| `mail/` | Gmail digests, attended-only reads | P |
| `roots/`, `roots_*commands.rs` | mounted extra directories ("Work") | P |
| `shell/` | links guard, open-with, file actions, notify, deep links, quit | P |
| `connectors.rs` | CLI-owned `.cerebro/connectors.json` | P |
| `actions/` (17 files) | M96 catalog/schema/approval/service/recovery are **T**; `native_owner.rs` plus `native_{db,lineage,rules}.rs` are **P** ("No action is enabled") | T/P,N |

> **2026-10-27 (Codex cross-check, status-drift S11):** `catalog` and `schema` now compile in production with `effect_kernel`, `native_authority`, `native_owner` and `github_issues`; `approval`, `service`, `recovery`, `admission`, `types` stay **T** (`actions/mod.rs:1-40`).

| Module | Role | St. |
| --- | --- | --- |
| `connections/` (10 files) | M96.2 accounts, gh import, Keychain (macOS), migration are **T**; `metadata.rs` is **P** | T/P,N |

> **2026-10-27 (Codex cross-check, status-drift S11):** `keychain`, `gh_credentials` and `secrets` compile on macOS; `accounts` and `migration` stay cfg(test) (`connections/mod.rs:1-18`); `GithubIdentityReader` is a production reader (`github_identity.rs:131`). Mark P on macOS; keep **T** for accounts and migration.

| Module | Role | St. |
| --- | --- | --- |
| `workspace_service/` (19 files) | M99 typed service, legacy read pilot, selected authority, native admission | P,N |
| `workspace_migration/` (14 files) | M99 inventory/identity, staging, semantic producer, paired journal/recovery; comparison/sidecar/sqlite adapters are **T** | P/T,N |
| `source_location.rs`, `source_occurrences.rs` | M97.1 / M97.5 | P,N |
| `draft_recovery_commands.rs`, `recovery_commands.rs` | M93.2 deleted-target recovery; M93.9 journal controls | P,N |

### 1.3 Webview layers

- **IPC (CV-18):** only `src/lib/ipc.ts` (1,934 lines), `gitIpc.ts` (483), `rootsIpc.ts` (213) and `src/agent/agentIpc.ts` (1,667) dynamically import `@tauri-apps/*`. The browser twin is `src/lib/mockIpc.ts` (8,476 lines) [read: grep].
- **Generated contracts (new):** Rust-owned JSON Schema in `shared/{actions,workspace}/contracts.v1.json`, through `scripts/contracts/generate.ts`, produces `src/lib/generated/{actions,workspace}.ts` ("Do not edit") [read].
- **Stores:** 17 Zustand stores in `src/stores/`. Also `agent/threadStatusStore.ts`, `history/vaultActivityStore.ts`, `git/useGit.ts` and whiteboard component stores. `stores/creationDraftStore.ts` is a plain memory module ("no vault, browser-storage or runtime.db writes") [read].
- **Engine:** 155 pure modules in `src/engine/`, plus `scene/` (26), `ai/` (10) and `sheet/` (8). Lint and `tsconfig.engine.json` keep them DOM-free [read/docs].
- **Design system:** tokens in `src/styles/tokens/*.css` (cortex/synapse ramps; `--rail-w:54px`, `--sidebar-w:240px`, `--control-h:32px`, `--surface-readable:880px`). Instrument Sans and IBM Plex Mono. 28 primitives in `src/components/ui/`, with `layers.ts` (Escape) and `motion.ts`. 31 AI elements in `src/components/ai/` (MIT shadcn port, CV-64). 33 five-state lab sections in `src/lab/sections/` [read].
- **Local webview state:** 58 `cerebro.*` localStorage keys. They include `conversations`, `composerDrafts`, `favorites`, `treeOrder`, `panes`, `lastPlace`, `stdioApprovals` and `issuePrefixes`. None is in the vault or runtime.db [read: grep].

### 1.4 `shared/` policy-as-data (CV-04)

| Folder | Artifacts |
| --- | --- |
| `policy/` | `policy.v3` (v1/v2 frozen controls), `tools.v1` (39 cerebro tools: 15 read-only/14 additive/10 destructive; 44 CLI built-in rows; `never_call` 11 mail-send names), `tool-approval.v1`, `subagents.v1`, `mail.v1`, `links.v1`, `agent-links.v1`, `run-options.v1`, `lanes`, `critical-attention`, `trigger-registry`, `freshness`, `coverage-fold`, `staleness`, `concept-types`, `authority-routes` (+ hashed snapshots), `independence-rules`, `cost-projection`; **new:** `actions.v1` (`registration: reserved_not_callable`), `recovery.v1`, `draft-export.v1` |
| `schema/`, `calendar/` | `field-kinds.v1` (19 kinds incl. relation, rollup, formula, repeat, status), `views.v1` (10 view types, 4 chart kinds), `dates.v1` |
| `canvas/`, `files/`, `import/`, `runtime/`, `prompt/`, `starter/` | JSON Canvas format/limits; file kinds/bytes; import sources; budget defaults; product brief, server instructions, retired terms, researcher prompt; starter vault |
| **new:** `actions/`, `workspace/`, `knowledge/`, `help/` | action contracts/cases/GitHub issue definitions; workspace values/authority/paired-change/staging; source-location/occurrence/mention cases; 5 help guides + catalog |

The twin registry in `shared/policy/README.md` lists ~71 Rust↔TS twins, each replayed from shared cases. The new ones are M93.8/.9/.2, M97.1/.5 and M99.6 [read].

### 1.5 Persistent stores

| Store | Location | Contents |
| --- | --- | --- |
| Vault files | `<vault>` | Markdown + YAML frontmatter (**current authority**), `.canvas`, `.mmd`, `.cerebro/{ledger/,connectors.json,starter.json}`, `.comments/<path>.json`, `.trash/` [read] |
| runtime.db v35 (55 tables) | app-data, global across vaults | **Ops/meter:** `runs`, `run_cost_components`, `operational_log`, `budget_*`, `runtime_health`, `app_sessions`, `settings`, `backoff`. **Dispatch:** `scheduler`, `ambient_*`, `catchup_outcomes`, `responsibility_contracts`, `resolver_outcomes`, `ingestion_failures`, `discovery_plan_runs`, `maintenance_findings`. **Sources:** `source_*`, `source_taint_assessments`. **Knowledge caches:** `coverage_*`, `convergence_runs`, `attention_signals`, `parked_promotions`, `working_memory_manifests`, `assembly_metrics`, `lane_registry`, `trigger_*`. **Agents:** `agent_wakes`, `agent_followups`, `job_ledger`, `done_marks`, `reminder_fires`, `pending_writes`, `vault_writes`, `run_commits`, `batch_journal`. **Other:** `client_tokens`, `connector_status`, `mail_dismissals`, `vault_registry`. **M96 V32–V35:** `managed_connections`, `managed_connection_attempts`, `managed_secret_cleanup`, `action_invocations` (+ unique `action_unresolved_fence` WHERE state IN dispatched/outcome_unknown), `action_approvals`, `action_attempts`, `action_native_runs` (`owner_person='human:me'`), `action_account_grants` [read] |
| Ledger index (20 tables) | app-data `<store_id>.sqlite` | events, beliefs, observations, relations, entities, lineage…; disposable cache [read] |
| `recovery.sqlite` | app-data | `settings`, `copies` (+`selected_join`, v2) [read] |
| `workspace.db` (selected, inactive) | `<app origin>/workspaces/<id>/workspace.db`, outside the vault | `workspace`, `records`, `metadata_receipts`; marker `.cerebro/workspace-format.json` (`workspace_service/authority.rs:525-535`) [read] |
| Conversations | localStorage `cerebro.conversations` + the CLI session file | `src/agent/conversations.ts:20-28` [read] |

### 1.6 Background runners

| Runner | Where | Behaviour |
| --- | --- | --- |
| Job queue (scheduled/agent/refresh/stale/schema) | `src/agent/useJobRunner.ts` (renderer) | 4 s settle, 60 s tick. One job at a time; yields to attended turns. This is the "background distiller" (M8.6) [read] |
| Ambient scheduler | `src-tauri/src/ingest/ambient.rs` (thread) | Spending half (ingest, maintenance) is **off by default**. Deterministic half (conflict, freshness, attention, convergence, Source Monitor) is always on. Pause governs both [read] |
| Dispatch/leases | `runtime/dispatch.rs` | N ambient leases under the budget gate [read] |
| Launch catch-up and heartbeat | `runtime/catchup.rs`, `runtime/sessions.rs` (60 s) | content-hash diff, not mtime [read] |
| Wakes / follow-ups / pre-run check | `runtime/wakes.rs`, `runtime/followups.rs`, `agent/condition.rs` | Admitted via IPC `admit_wakes` from the renderer's queue, claimed in the dispatch transaction. Follow-ups: ≤3 waiting, ≤30 days [read/docs] |
| Reminders | `runtime/reminders.rs` → `shell/notify.rs` | bundle-guarded Notification Center [read] |
| Sweeps | `recovery_commands.rs:43` (60 s), `client_access/listener.rs`, `files/thumbs.rs` | retention, sessions, thumbnail prune [read] |
| Quit | `shell/quit.rs:47` | 5 s deadline; flushes on ⌘Q and the close guard only [read] |

---

## 2. Feature inventory

| Area | What exists | Paths (basis) |
| --- | --- | --- |
| Editor | BlockNote 0.46.2 + ProseMirror; slash menu (carrier-checked), block drag, column gutter, find, outline, selection toolbar, Ask AI popover, citations, chips | `src/editor/{MarkdownEditor,LazyMarkdownEditor,BlockDragLayer,FindBar,DocOutline,SelectionToolbar,AskAiPopover}.tsx` [read/names] |
| Carriers (CV-24) | Custom blocks round-trip as plain Markdown fences or directives; `DROPPED_SLASH_KEYS` is empty; `UNCARRIED_ACTIONS` removes lossy toolbar actions | `editor/blocks.tsx:148-165`, `MarkdownEditor.tsx:182`, `SelectionToolbar.tsx:87` [read] |
| Save ownership (new) | `DocumentOwner` with `SaveOutcome` (clean/acknowledged/committed/failed/blocked) and `FlushReport`; save participants (diagram, canvas, sheet, fields); deleted-target recovery; source body mode through the same writer | `src/editor/{documentOwner,saveParticipants,fieldSaveParticipant,deletedDraftRecovery,SourceBodyEditor}.ts(x)` [read] |
| Page titles | First H1 projected above the body; filename fallback without writing | `editor/pageTitleProjection.ts`, `PageTitleFallback.tsx` [docs/names] |
| Databases/types/views | Type docs; 10 views (table, list, board, calendar, gantt, timeline, gallery, chart, dashboard, whiteboard); filters/sorts/groups; database block embed; CSV import/export; packs | `src/views/*`, `shared/schema/views.v1.json`, `engine/{typeCatalog,views,csvImport,packs}.ts`, `vault/query.rs` [read] |
| Fields/relations | 19 kinds incl. relation (target/limit), rollup, formula, status chain, repeat; item keys `PREFIX-N`; relation picker; rollup/formula editors | `shared/schema/field-kinds.v1.json`, `src/detail/{RelationPicker,RollupConfigEditor,FormulaConfigEditor}.tsx`, `engine/itemKeys.ts` [read/names] |
| Whiteboard | JSON Canvas; pure scene core (ink, order, history, snap, ports); agent read/edit caps | `src/whiteboard/`, `src/engine/scene/`, `src-tauri/src/canvas/` [read] |
| Sheets | `cerebro-sheet` CSV fences on IronCalc 0.8.3 (engine thread), formula bar and completion, XLSX/CSV import/export | `src-tauri/src/sheet/`, `src/sheet/` [read] |
| Mermaid | Diagram pages (`.mmd`), structural editor, code overlay, export PNG/SVG | `src/mermaid/`, `pages/DiagramPage.tsx`, cmds `export_png`/`export_svg` [read] |
| Files/viewers | Kinds table; image, media, PDF (pdf.js legacy, no eval), table, code, unknown viewers; Quick Look, Reveal, Save a copy, Open with | `src/workspace/viewers/`, `src-tauri/src/files/`, `shell/file_actions.rs` [read/names] |
| Attachments | Paste/drop/upload copy-in through human doors, NFC-aware reuse, no symlink follow | `vault/attachments.rs`, `src/editor/attachments.ts` [docs/names] |
| Knowledge | `knowledge/` OKF bundle; agent-written, human-Verified; tabs Concepts/Review/Activity; review bar; dossiers; hash-chained ledger; ambient ingest (opt-in) | `src/knowledge/`, `pages/KnowledgePage.tsx`, `src-tauri/src/{knowledge.rs,ledger/,ingest/}` [read] |
| Agents | Agent = page (instructions body), grant rows written on Done, Runs/Memory tabs, triggers (schedule; created/changed/moved/assigned) with a deterministic gate before the model gate, wakes as chain hops (2 hops), follow-ups, ask-first writes, `hand_to` | `src/library/{AgentPage,AgentProperties,AgentMemoryTab}.tsx`, `engine/triggers.ts`, `runtime/{wakes,followups}.rs` [read] |
| Runs | Fleet roster, run history (scoped pages), run detail/transcript/why, pending writes, attribution from `run_commits` | `src/status/`, `runtime/fleet.rs` [names/read] |
| Chat | One assistant instance: floating (48 px minimized), docked, canvas. Canvas rail with 9 cards (M92). Ordered parts, nested subagents (`cerebro-researcher` only), Branch from here (`CliSession::Fork`), Context pull, attachments, Worked-for. **New:** CLI readiness, completed-message Copy, Save answer, checked selected-text Apply | `src/agent/{AiPanel,ChatTurn,transcript,readiness,artifacts,ArtifactActions}.ts(x)`, `src/agent/rail/`, `components/ai/` [read] |
| Connectors/imports | CLI-owned MCP connectors per vault; Notion import from connector capture; Gmail digests (drafts-only); CSV/ICS/XLSX import; existing-vault adoption wizard (Obsidian) | `connectors.rs`, `import/notion_door.rs`, `mail/`, `app/{IcsImportDialog,CsvImportDialog,AdoptSchemaDialog}.tsx` [read] |
| History/git | History (heatmap and feed), page history, changes page, checkpoint, sync badge, remote push/pull, PR strip | `pages/{PulsePage,ChangesPage}.tsx`, `src/git/`, `src/history/` [read/names] |
| Trash/undo | Trash with restore and launch purge; batch undo/redo; rename link rewrite | `vault/trash.rs`, `stores/undoStore.ts`, `app/renameActions.ts` [read] |
| Search | BM25 `search_vault`; ⌘K Quick Open (uFuzzy names + content); **new:** source locators/reveal | `search.rs`, `app/QuickOpen.tsx`, `lib/nameRank.ts`, `source_location.rs` [read] |
| Comments | Sidecar threads; @agent thread turns; agent comment tools | `vault/comments.rs`, `detail/CommentsPanel.tsx`, `agent/thread_turn.rs`, `comment_tools.rs` [read] |
| Shell/nav | 54 px rail + context sidebar; 11 destination rows; up to 4 panes; keymap (one capture listener) + command rows; Quick Open; last place; Studio; Home lanes | `app/{AppRail,Sidebar,PaneRow,LastPlaceHost}.tsx`, `engine/{destinations,panes}.ts`, `lib/keys/`, `app/commands/` [read] |
| Deep links / client access / notifications | `cerebro:` navigates only; personal tokens (SHA-256 only, loopback, off by default); reminders → Notification Center | `shell/deep_link.rs`, `runtime/client_tokens.rs`, `client_access/listener.rs`, `shell/notify.rs` [read] |
| Help/recovery (new) | Settings → About → Product help (5 guides); opt-in recovery journal settings and versions | `shared/help/`, `app/ProductHelp.tsx`, `history/RecoverySettings.tsx` [read/docs] |

---

## 3. M93–M99 phase status

Legend: **Done-b** = bounded slice implemented and independently reviewed, not committed, native/live acceptance open · **Prog** in progress · **Gate-O** waits on an owner decision · **Gate-C** waits on a capability proof · **NS** not started (proposed paths absent).

| Phase | Title | Status | Evidence |
| --- | --- | --- | --- |
| M93.1 | Retain generations and acknowledgements | Done-b | rec L32-35; `src/editor/documentOwner.ts` |
| M93.2 | Every leave path inspects owners | Prog | rec L36-58, L216-221, L279, L346 (rename repair 2 + Source/Canvas browser); open: native quit deadline, full inventory (`docs/acceptance/2026-10-23-reliability/save-participants.md`) |
| M93.3 | Scope roots before LIMIT; lineage paging | Done-b | rec L59-66, L146; `runtime/fleet/history.rs`; cmds `fleet_runs_page`/`fleet_run_lineage`/`fleet_run_origin` |
| M93.4 | Detail selection; origin-aware links | Done-b | rec L146 (36 cases); `src/app/leaveGuard.ts`, `lab/sections/agentRunHistory.tsx` |
| M93.5 | Bounded retryable CLI discovery | Done-b | rec L262-264, L277; `agent/readiness.rs`, `src/agent/readiness.ts`; native login-shell open |
| M93.6 | Repeatable performance runner | Prog (tooling only) | rec L93-98: timings withheld, no budget; `scripts/performance/`, `perf:run` |
| M93.7 | Measured scale improvement | NS | `src/views/tableWindow.ts`, `e2e/scale.spec.ts` absent |
| M93.8 | Body source presentation | Done-b | rec L87-92, L146; `editor/SourceBodyEditor.tsx`, `fixtures/source-body-cases.json`; governed pages ineligible |
| M93.9 | Displaced-byte recovery | Done-b (owner-approved, opt-in per vault) | rec L154, L164; `vault/recovery.rs`, 9 `recovery_commands::*`; packaged acceptance open |
| M93.10 | Versioned product help | Done-b | rec L103-111; two guided journeys open |
| M93.11 | Native evidence and limits | NS | rec L18; no `docs/acceptance/2026-10-23-reliability/matrix.md` |
| M94.1 | Reconcile baseline/evidence | Prog | rec L75-79; `specs/2026-10-23-m94-ui-implementation/README.md` "in progress" |
| M94.2 | Composition and role sheet | Gate-O | `PageHeader.tsx:25` `composition?: 'collection'\|'utility'`, `lab/CompositionLab.tsx`, `e2e/m94-composition.spec.ts` |

> **2026-10-27 (Codex cross-check, status-drift S15):** Decided, not Gate-O: the owner accepted the refined composition on 2026-10-25 (`specs/2026-10-25-m94-refined-composition-decision.md:3`).

| Phase | Title | Status | Evidence |
| --- | --- | --- | --- |
| M94.3 | Four-surface first slice | Gate-O | rec L148, L156; ~~only consumer `pages/PagesPage.tsx:100`~~ |

> **2026-10-27 (Codex cross-check, status-drift S15; CX-AFY-07):** Gate cleared by the same decision. `composition` consumers now: `utility` in `src/pages/SettingsPage.tsx:374`; `collection` in Pages, Library, Workflow Library, Agents, My work and Knowledge (grep).

| Phase | Title | Status | Evidence |
| --- | --- | --- | --- |
| M94.4 | Destinations and session draft recovery | Done-b | rec L70-74; `stores/creationDraftStore.ts`, `app/creationSubmission.ts` |
| M94.5 | Properties, commands, return paths | Prog (disclosure copy only) | rec L80-82 |
| M94.6 | Data/embedded view adoption | NS | waits on M94.3 |
| M94.7 | Conversation/Agent adoption | NS | waits on the M91→M92 handoff (`validation/chat-cli/m91-m92-handoff.md`) |
| M94.8 | Utilities, states, repair journeys | Prog (connector inventory Done-b) | rec L28-31; `e2e/agent-connector-inventory.spec.ts` |
| M94.9 | Release evidence, owner disposition | NS | — |
| M95.1 | Reconcile M91/M92 | Prog; live CLI matrix blocked | rec L292-296 (unsigned isolated profile, login requested), L333; `validation/chat-cli/README.md` |
| M95.2 | Durable normalized conversations | Gate-O, NS | rec L258; ~~`src-tauri/src/conversations/` absent~~ |

> **2026-10-27 (Codex cross-check, CX-XCUT-05, CX-AFY-08):** Built, not enabled: `src-tauri/src/conversations/{rows,export,transport}.rs` (SELECT-only cursor rows); search rows written per turn (`runtime/conversations.rs:160`), no reader yet.

| Phase | Title | Status | Evidence |
| --- | --- | --- | --- |
| M95.3 | Retention/deletion/export | Gate-O, NS | `specs/2026-10-23-m95-conversation-retention-decision.md` |

> **2026-10-27 (Codex cross-check, status-drift S12):** Decided 2026-10-26: the opt-in archive (`specs/2026-10-23-m95-conversation-retention-decision.md:70-74`); a retention pass exists (`runtime/conversations/retention.rs`). Not Gate-O.

| Phase | Title | Status | Evidence |
| --- | --- | --- | --- |
| M95.4 | Context receipts, attachments, artifacts | Prog | Apply/Copy/Save Done-b: rec L374-383, L463-473, L506-514; receipts, Add selection, Edit question open |
| M95.5 | Recovery via the action runtime | NS | `src/agent/recovery.ts` absent; needs M96.3 |
| M95.6 | Child isolation and admission | Gate-C (limits owner-approved 2026-10-24) | rec L666-670; ~~`agent/child_jobs/` absent~~ |

> **2026-10-27 (Codex cross-check, status-drift S13):** `agent/child_jobs/` exists but is test- or `native-read-smoke`-gated (`child_jobs/mod.rs:1-16`); the native claim/freeze kernel is smoke-only (`actions/native_owner.rs:1484-1488`, "normal production has no caller or door"). Public jobs stay disabled.

| Phase | Title | Status | Evidence |
| --- | --- | --- | --- |
| M95.7 | Job settlement/cancellation | NS | ~~`runtime/child_jobs.rs` absent~~ |

> **2026-10-27 (Codex cross-check, CX-XCUT-05; CX-N8A-07):** `runtime/child_jobs.rs` and `runtime/child_claim_history.rs` exist (restart `recover`, `:327`); the two-process restart baseline was accepted 2026-10-25 (record). Prog.

| Phase | Title | Status | Evidence |
| --- | --- | --- | --- |
| M96.1 | Catalog, schemas, contracts | Done-b, **T** | rec L152; `actions/{catalog,schema,types}.rs` cfg(test); ~~broker tools not in `tools.v1.json`~~ |

> **2026-10-27 (Codex cross-check, status-drift S11):** `catalog` and `schema` now compile in production; `types` stays cfg(test) (`actions/mod.rs`). Broker tools `list_actions`/`prepare_action` are served (`shared/policy/tools.v1.json:2553,2640`).

| Phase | Title | Status | Evidence |
| --- | --- | --- | --- |
| M96.2 | Accounts, credential broker, migration | Done-b, **T** (Keychain chosen) | rec L182, L207-214, L283; ~~fake SecItem only~~; packaged acceptance open |

> **2026-10-27 (Codex cross-check, status-drift S11; CX-XCUT-05, CX-MAC-10):** macOS native import is live with a real platform store (`connections/secrets.rs:55` `platform_secret_store`, `connections/keychain.rs`; `actions/native_credential_bundle.rs:30-47`); `accounts`/`migration` stay cfg(test). Record: an earlier disposable Keychain put "remains uncertain and cleanup-pending".

| Phase | Title | Status | Evidence |
| --- | --- | --- | --- |
| M96.3 | Durable approval/claim state machine | Prog, mostly **T** | rec L307, L335, L350, L426-432, L618-644; V34/V35 live; `actions/native_owner.rs` production |
| M96.4 | Outbound adapters/routing | NS | `connections/mcp/` absent |

> **2026-10-27 (Codex cross-check, status-drift S11):** Still no `connections/mcp/`, but managed MCP `list_actions`/`prepare_action` are served (`tools.v1.json:2553,2640`; CV-62 names `prepare_action`). Prog.

| Phase | Title | Status | Evidence |
| --- | --- | --- | --- |
| M96.5 | First managed journey (GitHub) | NS | ~~data only: `shared/actions/github-issues.v1.json`~~ |

> **2026-10-27 (Codex cross-check, status-drift S11; CX-XCUT-05):** GitHub adapter built: `actions/github_issues.rs`, `github_issue_transport.rs`, `shared/actions/github-transport.v1.json`; record "Fixed GitHub adapter and shared effect kernel checks pass"; real provider acceptance open. Prog.

| Phase | Title | Status | Evidence |
| --- | --- | --- | --- |
| M96.6 | Shared effect inspection | NS | `src/connections/` absent |

> **2026-10-27 (Codex cross-check, status-drift S11; CX-PLN-09):** `src/connections/` is still absent, but account UI lives in `src/app/ManagedAccountSettings.tsx`, and credential and per-run access dialogs pass browser previews (implementation record:27). Prog.

| Phase | Title | Status | Evidence |
| --- | --- | --- | --- |
| M96.7 | Remote Tasks / MCP App | NS (conditional) | `src/agent/apps/` absent |
| M96.8 | Second backend, release gates | NS (conditional) | `agent/backends/` absent |
| M97.1 | Source locations | Done-b | rec L152, L160; `source_location.rs`, `engine/sourceLocation.ts`, cmd `resolve_source` |
| M97.2 | Reveal once; return paths | Prog | rec L168, L180, L374-383; native and conversation return open |
| M97.3 | Immutable config at dispatch | Prog, **T** scaffold | rec L650, L697-699 (11 expected failures) |
| M97.4 | Inspect config/evidence | Prog (resource classifier Done-b) | rec L605-616; `EvidenceInspector.tsx`, `RunConfiguration.tsx` absent |
| M97.5 | Backlinks and mention discovery | Done-b | rec L385-391, L588-600; `source_occurrences.rs`, `editor/mentionLink.ts` |
| M97.6 | Twelve outcome fixtures | Done-b (4 pass / 8 unavailable; synthetic provider) | rec L434-443; `conformance/outcomes/`, `scripts/outcomes/` |
| M97.7 | Retrieval labels, live baselines | NS | ~~`conformance/retrieval/` absent~~ |

> **2026-10-27 (Codex cross-check, CX-XCUT-05; status-drift B6):** Built: `conformance/retrieval/` (corpus, labels, queries, `native.rs`); labels agent-reviewed, not owner-approved (`specs/2026-10-26-m97-retrieval-label-review.md:6`); a twelve-query native baseline is accepted within local limits (record:28). Prog.

| Phase | Title | Status | Evidence |
| --- | --- | --- | --- |
| M97.8 | Justified retrieval extensions | NS (conditional) | — |

> **2026-10-27 (Codex cross-check, CX-MTD-11; status-drift B6):** Latin accent aliases shipped after a measured experiment (median +3.17% under a 25% limit; `specs/2026-10-26-m97-latin-accent-retrieval-experiment.md:52`; `search.rs:413`). Semantic retrieval is still not triggered.

| Phase | Title | Status | Evidence |
| --- | --- | --- | --- |
| M98.1 | Immutable definitions, checked publication | Gate-O, NS | `specs/2026-10-23-m98-workflow-platform-decision.md` "Owner answer: Pending"; ~~`src-tauri/src/workflows/`, `shared/workflows/`, `src/workflows/` absent~~ |

> **2026-10-27 (Codex cross-check, status-drift S6; CX-XCUT-05):** Built in part: `src-tauri/src/workflows/` (21 files) and `shared/workflows/` (6 files); only `src/workflows/` is absent (the UI is `src/library/Workflow*.tsx`). Owner answer still Pending (:41); work proceeds under a 2026-10-26 implementation ruling. Prog.

| Phase | Title | Status | Evidence |
| --- | --- | --- | --- |
| M98.2 | Sequential runner over the action service | NS | needs M96.3 service and M98.1 |

> **2026-10-27 (Codex cross-check, status-drift S6):** Built: `src-tauri/src/workflows/runner.rs`; record "sequential runner, retained worker … pass" (:29). Prog.

| Phase | Title | Status | Evidence |
| --- | --- | --- | --- |
| M98.3 | Durable waits, resume claims, cancel, retention | Gate-O, NS | retention in the same pending packet |

> **2026-10-27 (Codex cross-check, status-drift S6):** Built: waits and cancel in `runtime/workflows.rs` (`workflow_waits`, `:442`); completed-detail retention Off and undecided (`shared/workflows/runtime.v1.json:4`). Prog.

| Phase | Title | Status | Evidence |
| --- | --- | --- | --- |
| M98.4 | Desktop-awake schedules, bounded catch-up | Gate-O, NS | `skip_missed`/24 h `coalesce_latest` proposed |

> **2026-10-27 (Codex cross-check, status-drift S6; CX-WFC-11):** Built interval-only, elapsed-UTC schedules (`workflows/schedule.rs`, `shared/workflows/schedule.v1.json`); Enable/restart scheduling open (record:29). Prog.

| Phase | Title | Status | Evidence |
| --- | --- | --- | --- |
| M98.5 | Deterministic trigger preview | NS | today's matching lives in `engine/{triggers,wakes,jobs}.ts` + `agent/useJobRunner.ts` |

> **2026-10-27 (Codex cross-check, status-drift S6):** Prog, preview command only: `workflow_schedule_preview` (`src-tauri/src/lib.rs:4513-4538`). No rehearsal (M98.6), journeys (M98.7) or intake/overlay code (M98.8).

| Phase | Title | Status | Evidence |
| --- | --- | --- | --- |
| M98.6 | Rehearsal boundary proof | Gate-C, NS | — |
| M98.7 | Capture, connected-work, calendar journeys | NS | needs M96.5 (GitHub first) |
| M98.8 | Intake, overlays, record rules, publishing | NS (conditional) | — |
| M98.9 | Authoring, mapping, version UI | NS | — |

> **2026-10-27 (Codex cross-check, status-drift S6, S7):** Built in part: `src/library/WorkflowLibrary.tsx` (raw JSON fields, Move up/down), `WorkflowRunPanel.tsx`, `WorkflowSchedulePanel.tsx`; "Library draft authoring passes focused and display-browser checks" (record:29). Prog.

| Phase | Title | Status | Evidence |
| --- | --- | --- | --- |
| M99.1 | Typed Rust service boundary | Done-b | rec L112-118; `workspace_service/`, generated `workspace.ts` |
| M99.2 | Values and mutation semantics | Done-b (validation T) | rec L119-125 |
| M99.3 | Original bytes and identity | Done-b | rec L150 |
| M99.4 | Two-store comparison | Done | rec L166; `plans/2026-10-23-m99-store-comparison/5k-final.json` |
| M99.5 | Authority decision | Done (SQLite metadata + Markdown bodies) | rec L190; plan `[x]` L235 |
| M99.6 | Stage selected conversion | Prog (inactive; no binding writer/activation) | rec L252, L281, L313, L393-403 |
| M99.7 | Files+metadata crash recovery | Prog | rec L516-567, L652-664; `docs/acceptance/2026-10-24-storage/m99-paired-journal.md` |
| M99.8 | Backup, rollback, YAML carriers | NS | rec L24 |

> **2026-10-27 (Codex cross-check, status-drift S16):** Prog: native backup coordinator, portable backup/check/restore and backup UI built ("backup UI passes both-browser preview"); native chooser acceptance, migration/rollback/export and activation open (record:30).

Owner decisions on record: recovery journal, macOS Keychain, SQLite metadata, and M95.6 read-only limits. Pending: ~~M94 composition, M95 retention,~~ M98 platform, isolated CLI login (rec L369). Latest gate checkpoint: 942 frontend files with 17,767 tests pass; Rust 4,402 pass (41 ignored, 62 crash cases excluded). The tree was then deliberately put red with registered failing tests (rec L674-701).

> **2026-10-27 (Codex cross-check, status-drift S12, S15):** M94 composition accepted 2026-10-25; M95 retention decided 2026-10-26 (opt-in archive). Still pending: M98 platform (the 2026-10-26 implementation ruling is not an owner answer) and isolated CLI login.

---

## 4. Constraints every recommendation must respect

| Theme | Rule (enforcer) |
| --- | --- |
| Writers | One writer per file: path lock from read to rename (CV-21). One live editor per file (CV-52). One `DocumentOwner` per `{vaultId,path,ownerId}` (M93.1). Every write carries a door receipt plus a `vault_writes` row (CV-33). Editor saves are last-write-wins; agent writes compare `expect_hash` (CV-23). |
| Policy | Rules live in `shared/` JSON with a digest. No twin code; every twin is listed in the README (CV-04). Destinies are operational vs. ledger (CV-06). Prompts name only held tools; one product brief (CV-19/20). |
| Honesty | Absent ≠ zero; unavailable ≠ empty (CV-05). Human actions toast and return null; proposals return typed results (CV-03). Five lab presets per reading section (CV-44). `outcome_unknown` is never auto-retried and cannot be bypassed with a fresh ID (roadmap, V34 fence). |
| Agent | The user's Claude Code CLI only, no API key. Loopback MCP with a per-run bearer. One approval table decides CLI tools, fail-closed (CV-29). A run waits and only a person answers (CV-28). Ask-first writes need an Allow (CV-32). Agent reach is derived, not restated (CV-46). One fold and one reducer (CV-27). A turn outlives its panel (CV-30). Seated stdin carries only the prompt or the context ask (CV-65). |
| Knowledge | Writes go only through `write_concept`/`recheck_concept`/`verify_concept`; Verify is human-only (CV-07). Imported text is never the owner's word; bytes come from capture; provenance stamps are guarded (CV-22/58/60). |
| Data safety | Nothing is hard-deleted (CV-37). A database-wide rewrite is one batch (CV-38). Undo touches only what still stands (CV-39). Renames keep links and pointers (CV-40/41/53). Comments live in sidecars (CV-31). Run commits contain only the run's paths; attribution is recorded, never inferred (CV-34/35). Every editor block has a disk carrier (CV-24). |
| Boundaries | Only four IPC adapters (CV-18). The webview never leaves its entry document (CV-16). `cerebro:` links only navigate (CV-50). Other apps get a personal token only (CV-49). File bytes stay in their root; outside bytes are parsed behind limits; remote images wait for a click (CV-51/57/61). Mail stays out of git and is drafts-only (CV-59/62). |
| UI | Shortcuts go through the keymap; Escape belongs to `layers.ts` (CV-47). No native `<select>` (CV-63). AI elements are presentation only (CV-64). No type special-casing (CV-08). Keep the 54/240 px shell, one assistant instance, first-H1 titles, 900×600 minimum and both themes (M94 constraints). |
| Storage | Current authority is Markdown/YAML plus the ledger until M99 activation. The selected future is SQLite metadata outside the vault plus visible Markdown bodies. No live WAL DB inside a vault (`ledger/index.rs`). Single user `human:me` (V35 CHECK). macOS bundle only. |
| Process | Never `--no-verify` (CV-01). Coverage ratchets only tighten (CV-12). Suppressions carry reasons (CV-10). Sources stay text (CV-13). Use `e2e/boot.ts` (CV-15). Licence: Cerebro is Apache-2.0; MIT ports go through `THIRD_PARTY_NOTICES.md` (M91 precedent); Outline (BSL) and AFFiNE `packages/backend`/`packages/common/native` are ideas only. |

---

## 5. Implications for the reference audit

- Judge "adopt X" against the **dirty tree**, not HEAD. Most M93–M99 seams exist only uncommitted. Committing reviewed bounded slices is the program's largest unpriced risk.
- Two cheap, verified gaps are adoptable now. Error containment: zero boundaries in `src/`. A missing-page fallback that offers more than "Go home": `src/pages/DocPage.tsx:335-350`.
  > **2026-10-27 (Codex cross-check, CX-AFY-11):** The Go-home face is now `src/pages/DocPage.tsx:344-348`; zero error boundaries still holds (grep 2026-10-27).
- Do not count M96 as missing a model. Recommend patterns that plug into the existing `ActionService`, its V34 fence and V35 grants instead of a second ledger. The gap is routing, adapters and UI, not schema.
- Patterns that assume YAML forever, CRDT bodies or an always-on server conflict with the M99 decision or the single-user desktop model. They must be adapted or marked avoid.
- The 58 `cerebro.*` localStorage keys (favorites, treeOrder, panes, composerDrafts, stdioApprovals) are user-authored state outside every backup category in the M99 decision. Feed this to M99.8.
  > **2026-10-27 (Codex cross-check, CX-AFA-05):** Codex re-counted 56 literal keys. `shared/workspace/export.v1.json` now lists `omitted_scopes`, shown as "Not included"; there is still no webview tier.
- Any index or virtualization proposal must beat the stated principles: search is index-free (`search.rs` header) and M93.7 requires measured, access-preserving bounded rendering.
