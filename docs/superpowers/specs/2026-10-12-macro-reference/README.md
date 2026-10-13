# Macro reference (2026-10-12)

Entry point to a 20-domain study of Macro, read from `docs/examples/macro-main/` (vendored, gitignored). Macro
paths are relative to that root; Cerebro paths are relative to this repo. Directory listed 2026-10-12: all 20
domain files present, none missing. Roadmap built on this study:
`docs/superpowers/plans/2026-10-12-macro-port-roadmap.md`.

## 1. What Macro is

- **Pitch**: "the all-in-one workspace for you and your team". Email, messages, docs, tasks, agents and CRM in
  one interface, with shared team-level memory (`README.md`; `apps/docs/index.mdx`: "one bidirectional database").
- **Everything is @linked**: each block is purpose-built but shares one backend. Cross-references (doc to task,
  message to email) are a bidirectional graph that people and agents can search.
- **Blocks**: Email (Gmail, unified inbox), Messages (channels, DMs), Tasks (Linear-style), Docs (markdown on
  CRDTs), Canvas, Agents, Calls (recorded, transcribed), File storage, Pull requests, CRM (`README.md` table;
  `apps/docs/product/*`). Newer surfaces (Databases, Forms, Routines, Reviews, IronCalc sheets) sit behind PostHog
  flags and postdate `apps/docs` (a June 2026 snapshot).
- **Agents three ways**: in-app agent sessions; a remote MCP server (117 tools documented, 109 served); bring-your-own
  runtimes over ACP (Cursor/Claude/Codex cloud, sandboxed opencode, the user-run `macrod` daemon).
- **Hosted SaaS, self-hostable under AGPLv3** (`README.md:242`): SolidJS + Rust on AWS and Cloudflare; web, Tauri
  desktop, iOS, Android.

| Scale | Value |
| --- | --- |
| `apps/web` | ~1.40M LOC, ~90 features (`apps/web/src/features`) |
| `crates/` | ~1.45M LOC, 243 crates (83 hexagonal, with `src/domain`) |
| `services/` | ~197K LOC, 50 services |
| `packages/` | ~169K LOC |
| `infra/` | ~36K LOC |
| Version | `v2026.4.28.0` (`VERSION`) |

## 2. Architecture at a glance

```
 Clients   web SPA (SolidJS) | Tauri 2 desktop (patched fork) | Tauri iOS / Android (OTA bundles)
           client cache: Rust normalized GraphQL cache (native in Tauri, WASM + OPFS in browser)
              |  HTTPS (REST, GraphQL "soup")                |  WebSocket
              v                                              v
 API /     document_storage_service (composition root,       connection_gateway (realtime push,
 realtime  ~40 routers) + 49 other services                  presence, Redis relay)
           sync-service: one Cloudflare Durable Object per doc (Loro CRDT, bebop WS)
              |
              v
 Domain    243 crates: entity_access, entity_mutation, documents, databases, soup, messages,
           calendar_events, email, agent_session, scheduled_action, ai_toolset / ai_tools ...
              |
              v
 Storage   Postgres (entities, EAV properties, frame logs) | OpenSearch (8 aliases) |
           S3 (blobs, snapshots) | Redis (streams, caches) | DynamoDB (connections) | D1
              |
              v
 Queues /  Kafka (24 topics, versioned envelope) | SQS (29 queues) | SNS push | EventBridge
 workers   -> search_processing, agent_trigger, scheduled_action, webhooks, reminders, imports
              |
              v
 AI and    DCS chat turns (rig-core agent loop) | agent_session (ACP client, frame log + fold)
 agents    harnesses: in-process Macro agent, Cursor / Claude / Codex cloud, sandboxed opencode,
           user-run macrod daemon (dials out, spawns ACP adapters around the user's own CLI)
              |
              v
 MCP       server: services/mcp_service (rmcp, stateless HTTP) + mcp_auth_proxy (OAuth 2.1 broker)
           client: crates/mcp_client (native OAuth) | crates/pipedream_mcp (hosted connectors)
```

## 3. Macro vs Cerebro stack

| Layer | Macro | Cerebro |
| --- | --- | --- |
| Model | Multi-tenant SaaS, team workspace | Single user, local, files-first vault |
| Source of truth | Postgres + Loro CRDT docs | Markdown files on disk (+ git) |
| Frontend | SolidJS, bun, Tailwind | React 19, Zustand, Vite, Tailwind 4 |
| Editor | Lexical 0.45 mirrored into Loro | BlockNote |
| Shells | Tauri 2 fork; iOS/Android with OTA | Tauri 2, macOS |
| Backend | ~50 axum services + Cloudflare workers | One Rust process (`src-tauri`) |
| Search | OpenSearch, chunk hits, recency order | Scan-based BM25 (`src-tauri/src/search.rs`) |
| Derived state | Postgres, Redis, client Turso cache | `runtime.db` (SQLite) + vault NDJSON ledger |
| Events | Kafka, SQS, EventBridge | File watcher, in-process scheduler |
| AI | Own agent loop (rig-core) on Macro's keys | User's own Claude Code CLI; no API key in app |
| Agent transport | ACP client over every harness | `claude -p --output-format stream-json` per turn |
| MCP | Remote server (109 tools) + client + Pipedream | Loopback `tiny_http` server, hand-written tool JSON |
| Policy | Rust code, 89 style rules, 27 ast-grep rules | Data in `shared/policy/`, Rust/TS parity goldens |
| License | AGPL-3.0; `apps/web` all rights reserved | Apache-2.0 |

## 4. License and how we use Macro

- **Root**: AGPL-3.0 (`LICENSE.txt`). No owned crate or service carries its own license, so AGPL covers
  `crates/`, `services/`, `packages/`.
- **`apps/web/LICENSE`**: "Copyright 2023 CoParse, Inc. All rights reserved." Conflicts with the root AGPL. Treat
  every frontend file, pure-TS helpers included, as design-only.
- **Permissive islands**:
  - `packages/loro-mirror`: MIT (`package.json`).
  - `vendor/ironcalc`: MIT / Apache-2.0 upstream (`LICENSE-MIT`, `LICENSE-Apache-2.0`). Holds 59 `MACRO:` patches;
    prefer upstream `ironcalc_base`.
  - `crates/opensearch_query_builder`: MIT (`LICENSE`).
  - `apps/web/src/lib/filesystem`: MIT (`LICENSE`).
- **Contributions / relicensing**: CLA enforced by a required `cla` check (`CONTRIBUTING.md:64-71`). Other-license
  use: `licensing@macro.com` (`README.md:242`).
- **Owner's rule (2026-10-12)**: build our own, guided by Macro's code, never a 1:1 copy. "Lift" verdicts in domain
  files mean technical fit only; ports are clean-room. Macro prompt text is AGPL too: write our own.
- Not legal advice.

## 5. Domain index

| # | Domain | One line | Top idea | File |
| --- | --- | --- | --- | --- |
| 01 | Product | Feature catalog, user view; docs lag code by months | PRODUCT-1 Home: one deterministic attention list | [01-product.md](01-product.md) |
| 02 | Shell | Split router in the URL, scoped hotkeys, Cmd+K, OKLCH themes | SHELL-2 Scoped keymap + command registry | [02-shell.md](02-shell.md) |
| 03 | Editor | Lexical mirrored to Loro; two markdown dialects; comments as marks | EDITOR-2 `edit_note`: quote-anchored edits, hash precondition | [03-editor.md](03-editor.md) |
| 04 | Data | One EAV property store for entities and Databases; typed op batches | DATA-5 Vault batch writer: validated, CAS, all or nothing | [04-data.md](04-data.md) |
| 05 | Work | Tasks are docs; Soup filter AST compiles to SQL and WASM; work feed | WORK-2 `query_records`: view filter grammar as agent tool | [05-work.md](05-work.md) |
| 06 | Agents | ACP everywhere; append-only frame log; one fold in Rust and WASM | AGENTS-1 One transcript fold: live stream = CLI JSONL | [06-agents.md](06-agents.md) |
| 07 | AI | Typed tools per host, composable prompts, skills, judged memory | AI-1 Tool manifest as shared data | [07-ai.md](07-ai.md) |
| 08 | Automation | Routines (cron/events), TriggerContext, fenced claims, webhooks | AUTOMATION-1 Typed run cause on every run | [08-automation.md](08-automation.md) |
| 09 | MCP | rmcp server (109 tools), OAuth broker, native + Pipedream client | MCP-1 Tool annotations as one shared artifact | [09-mcp.md](09-mcp.md) |
| 10 | Coding | Cloud and local coding agents via ACP; PR-to-task linking | CODING-2 CLI child supervision: group kill, stderr tail | [10-coding.md](10-coding.md) |
| 11 | Integrations | Realtime gateway, OAuth grants, import ledger, Slack archive, unfurl | INTEGRATIONS-1 Connector status from the CLI's init report | [11-integrations.md](11-integrations.md) |
| 12 | Search | OpenSearch chunk hits, recency order, client fuzzy + freshness | SEARCH-1 `search_notes` tells the truth | [12-search.md](12-search.md) |
| 13 | Email | Gmail mirror, label outbox, undo-send, CRM from correspondence | EMAIL-1 Mail threads as cached Sources | [13-email.md](13-email.md) |
| 14 | Comms | Parent-agnostic message store; 3-state notifications; activity log | COMMS-9 History: unavailable / untracked / empty kept apart | [14-comms.md](14-comms.md) |
| 15 | Calendar | Google projection, coverage-aware availability, booking links | CALENDAR-3 `list_agenda` read tool | [15-calendar.md](15-calendar.md) |
| 16 | Canvas | Framework-free scene core; IronCalc sheets with 3 agent tools | CANVAS-2 Scene core: pure commands, delta history | [16-canvas.md](16-canvas.md) |
| 17 | Files | Pure-Rust DOCX/PPTX/PSD/FIG engines with lossless save; AWS pipeline | FILES-1 Vault bytes in the webview | [17-files.md](17-files.md) |
| 18 | Client/desktop | Rust GraphQL cache (native + WASM); Tauri shell patterns | CLIENT-DESKTOP-1 External links open in the system browser | [18-client-desktop.md](18-client-desktop.md) |
| 19 | Platform/API | Typed access receipts, sealed principals, trash, teams, billing | PLATFORM-API-1 Corpus-bound write doors (security) | [19-platform-api.md](19-platform-api.md) |
| 20 | Practices | Stable-ID style rules, ast-grep, generated CI, real-recording goldens | PRACTICES-5 Sweep over real, sanitized CLI recordings | [20-practices.md](20-practices.md) |

## 6. Twenty ideas worth stealing (ranked)

Ranked by value to Cerebro over cost. Effort in brackets. All are rebuilds unless noted.

1. **PLATFORM-API-1 Corpus-bound write doors** [S, security]: note-write tools refuse files outside the note
   corpus. Built but uncommitted in the working tree; still needs the gates and a commit (M53.4). Supersedes CANVAS-1.
   [19](19-platform-api.md)
2. **AUTOMATION-2 / -2b Event-run hotfixes** [S]: event runs get their own ledger slot; no cross-vault event storm
   on vault switch. In progress. [08](08-automation.md)
3. **MCP-14 Read scope enforced at the CLI** [S, security]: the grant's read scope binds the CLI's built-in tools,
   not just the loopback. [09](09-mcp.md)
4. **AGENTS-1 One transcript fold** [L]: frames logged append-only; messages come from one pure fold. The live stream
   and Claude Code's own `~/.claude/projects/<cwd>/<session>.jsonl` fold to the same events. [06](06-agents.md)
5. **AI-1 / MCP-1 Tool manifest + annotations as shared data** [M]: one table (schema, ReadOnly / Additive /
   Destructive) feeds `tools/list`, prompts and docs. Replaces hand-written JSON in `src-tauri/src/mcp.rs`.
   [07](07-ai.md), [09](09-mcp.md)
6. **EDITOR-2 `edit_note`** [M]: anchor on quote + occurrence, refuse when ambiguous, content-hash compare-and-set.
   [03](03-editor.md)
7. **AUTOMATION-1 Typed run cause** [M]: a TriggerContext on every run, supplied only by the runtime and rendered as
   a preamble. [08](08-automation.md)
8. **CODING-2 / AGENTS-11 CLI child supervision** [M]: process group, TERM → grace → KILL, bounded stderr tail.
   Relevant to the crash-test wedge history. [10](10-coding.md), [06](06-agents.md)
9. **PRACTICES-5 Real CLI recordings as goldens** [M]: sanitized stream-json fixtures; the parser must not warn on
   any of them. [20](20-practices.md)
10. **PLATFORM-API-9 Vault-bound run grants with a lifecycle** [M]: grants are hashed, revocable, last-use stamped
    and bound to one vault. [19](19-platform-api.md)
11. **DATA-5 Vault batch writer** [L]: many files, validated first, base-version CAS, all or nothing, retry-safe ids.
    [04](04-data.md)
12. **AGENTS-4 / AI-4 Attended approvals** [L]: permission prompts through the CLI's prompt tool; any tool input
    projected into a review form; maps onto applied/queued/rejected. AGENTS-14 spike decides the transport first.
    [06](06-agents.md), [07](07-ai.md)
13. **SEARCH-1 `search_notes` tells the truth** [M]: frontmatter in the corpus, windowed excerpts, "N more matched",
    caps, trust labels. [12](12-search.md)
14. **DATA-8 / WORK-2 `query_records`** [L–XL]: the saved-view filter grammar as an agent read tool, truncation
    named. [04](04-data.md), [05](05-work.md)
15. **SHELL-2 Scoped keymap + command registry** [L]: one registration feeds shortcut, palette, keycap tooltip and
    reference page. [02](02-shell.md)
16. **SEARCH-4 / SHELL-3 One name ranker with local frecency** [M]: 0.7 fuzzy + 0.3 recency decay for ⌘K and every
    picker. [12](12-search.md), [02](02-shell.md)
17. **COMMS-9 then COMMS-1 Honest, attributed History** [S → L]: unavailable, untracked and empty never collapse into
    each other; then one append-only activity table, per-page timeline, `read_activity`. [14](14-comms.md)
18. **INTEGRATIONS-1 / MCP-4 Connector status with the fix** [L]: read the CLI's own init report; show "not
    connected, here's how", never absence. [11](11-integrations.md), [09](09-mcp.md)
19. **CLIENT-DESKTOP-1 External links leave the webview** [S]: a navigation guard opens the system browser.
    [18](18-client-desktop.md)
20. **PRODUCT-1 Home: one deterministic attention list** [L]: exactly-once two-stream feed (attention + own work)
    with revision-bound done/undo. [01](01-product.md), [05](05-work.md)

## 7. Coverage

**Examined**
- 20 domains mapped, 0 failed, 0 unassigned; ~6.4K lines across the 20 files. Each file covers: what it is, user
  view, build, data model, flows, ranked ideas, Cerebro vs Macro, port candidates (id, mode, fidelity, effort,
  value, Macro guide, Cerebro target, depends), convention conflicts, verification notes, where to read first.
- Mapping left three named units unexamined (paths cut at a hyphen). All three were then swept:

| Asked path | Real path | Relevance | Outcome |
| --- | --- | --- | --- |
| `apps/web/src/lib/core/database` | `lib/core/database-sql` (wasm driver for `crates/database_sql`) | medium | Feeds DATA-8: read-only `query_records` that reports truncation. Candidate: compile a pure Rust core (parse.rs + knowledge guards) to wasm and retire `mockParse.ts`'s hand copy; Specta for IPC types. Engine skipped. |
| `apps/web/src/components/navigation` | `components/navigation-stack` | low | Folds into SHELL-15 (peek back-stack). Macro's cross-pane dedupe goes against Cerebro's same-file-in-two-groups choice; skip it. |
| `apps/web/src/features/billing` | `features/billing-lab` (dev-only) | medium | Dev-only `lab.html` "State Lab": presets over the existing `__cerebroSeed*` hooks, fail-next-read toggle, pinned `VAULT_TODAY`, `?scenario=` links; reused as component-test fixtures. Pairs with PRACTICES-19 `failNext`. Billing skipped. |

**Not examined**
- Macro itself was not built or run. LOC and tool counts come from static reads. One read-only query ran on
  Cerebro's dev `runtime.db` (comms). Each domain file's verification notes say what was re-checked.
- `infra/` and AWS/Cloudflare deployment beyond each domain's skip verdict.
- `apps/marketing` beyond the pitch; mobile native plugins beyond their inventory.
- The ~90 frontend features were read by domain; features outside the 20 domains got no pass of their own.
- Vendored third-party code (`vendor/`, `node_modules/`, `target/`), apart from IronCalc's license and patch markers.
- Cerebro line refs come from the `m49-knowledge-integrity` working tree, which holds uncommitted PLATFORM-API-1 and
  AUTOMATION-2/2b changes. They will drift.
