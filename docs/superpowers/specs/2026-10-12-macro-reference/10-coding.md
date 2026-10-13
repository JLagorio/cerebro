# Macro reference — Coding agents: Claude, Codex and Cursor cloud agents, GitHub PRs, reviews

**Scope**: Macro's coding-agent layer, read 2026-10-12 from `docs/examples/macro-main/` (vendored and gitignored).
Every Macro path below is relative to that root. Cerebro paths are relative to the repo root.
**Owner's rule (2026-10-12)**: Cerebro builds its own version, with Macro's code as the guide and never a 1:1 copy.
Modes are rebuild (fidelity mirror / adapt / inspire), adopt-upstream, reuse-permissive and skip.
**Licence**: Macro `crates/` and `services/` are AGPL-3.0 (`LICENSE.txt`). `apps/web/` is "Copyright 2023 CoParse,
Inc. All rights reserved." Cerebro is Apache-2.0. **Design input only; copy no Macro code.** Permissive sources in
reach: the upstream ACP Rust SDK (Apache-2.0, rev 8769d16) that `acp_process.rs` ports, the npm ACP adapters
(Apache-2.0), and `@pierre/diffs` 1.3.5 (Apache-2.0).
**Evidence**: stages 1–2 read the code. Stage 3 checked claims with `git merge-tree` in a scratch clone, `gh` 2.93.0
against PR #19, Claude CLI 2.1.250 `--help`, `npm view` plus one unpacked (not executed) adapter tarball, and
transcript key scans. Nothing compiled, real CLI not run. Stage 3 overrides stages 1–2.
**Overlap**: `06-agents.md` owns the same `src-tauri/src/agent/mod.rs` (CODING-2 needs one owner) and the Claude Code
control protocol; `08-automation.md` owns the trigger `to:` fix; `03-editor.md` owns blame.

---

## 1. What it is

- ACP (Agent Client Protocol) is the one seam. Claude Cloud, Codex Cloud and Cursor are each wrapped as an in-process
  ACP agent over provider HTTP+SSE; `macrod` (`crates/coding_agent_worker`) serves sessions from the user's machine via
  pinned npm ACP adapters around the user's own CLIs, one git worktree per session.
- GitHub side: a multi-tenant GitHub App (webhooks → PR rows, task status, notifications) plus a per-user OAuth link;
  PR ↔ task by `MACRO-<shortid>` / `TEAM-<n>` text; session ↔ PR by `set_pull_request` or provider facts.
- Frontend: Claude connection card, PR page (`block-pr`: merge, changes, origin, links), Reviews PR inbox.

## 2. What users get

| Feature | UX details and shortcuts | Paths |
| --- | --- | --- |
| Claude Cloud connection | Settings→Harness row. Connect → Claude consent → paste `code#state` (masked input) → grant stored server-side. Popup reserved synchronously before first await (Tauri: system browser); 10-min attempt with client timer; badge Connected / Not connected / Unavailable / Loading; disconnect confirm (does not revoke at Anthropic); "Didn't open? Open Claude sign-in" fallback; status query staleTime/gcTime 0; codes never cached; `Cache-Control: no-store`. Flag `claude-cloud`. | `docs/CLAUDE_CLOUD_DEMO.md`, `apps/web/src/features/claude-connection/`, `crates/claude_cloud_agents/src/inbound/auth.rs` |
| Codex connection | ChatGPT device-code login (URL + user code), then pick a Codex cloud environment. Poll at provider interval +3 s, stored `next_poll_at`; states pending/connected/expired/failed; preflight refuses `CodexNotConnected` / `CodexEnvironmentNotConfigured`. Flags `enableChatV3Agents` AND `enableCodexAgents`. | `crates/codex_connection/src/domain/service.rs`, `crates/codex_cloud_agents/src/outbound/openai.rs`, `apps/web/src/features/settings/Harness.tsx` |
| Cursor API key | Paste `crsr_` key; validated with `GET /v1/me` before storing; status returns only `{registered, updatedAt}`; rotating keeps `default_model_id`; delete does not revoke at Cursor. | `crates/cursor_api_key/src/`, `crates/cursor_cloud_agents/src/api.rs`, `docs/CURSOR_AGENT_TRANSPORT.md` |
| `@cursor` / `@claude` / Codex from channels | Mention opens a session; bot posts announcement chip; mention text is first prompt; follow-ups route to same session. Keyless mention → in-thread connect chip (`{appSlug:'cursor',target:'harness'}`). Header links "Open in Claude" / Cursor / `chatgpt.com/codex/tasks/<id>`. Stop = provider cancel; delete archives, never deletes, the provider conversation. | `crates/{cursor,claude,codex}_cloud_agents/src/inbound/acp.rs` |
| Per-session model picker | ACP config option `model`, switchable mid-session. Cursor: id + variant params. Claude: account Models API (≤10 pages × 1000, never silently truncated) + "Claude · subscription default". | `crates/cursor_cloud_agents/src/domain/model_options.rs`, `crates/claude_cloud_agents/src/domain/models.rs` |
| Mirror turns from provider web UIs | Turns started on cursor.com / claude.ai/code appear in Macro. Cursor polls ~1 s while pipe live, full-fidelity replay, idle pipes retire after 5 min; Claude polls history every 2 s, 30 s backoff, durable messages only. | `crates/cursor_cloud_agents/src/domain/service.rs`, `crates/claude_cloud_agents/src/domain/service.rs` |
| ListCodingAgents / DispatchCodingAgent | Any Macro agent lists the user's coding personas and dispatches a self-contained task; returns live session ref after first prompt accepted; told not to retry after an uncertain failure. | `crates/agent_session/src/inbound/toolset/coding_agents.rs`, `apps/docs/AI/mcp/tools/list-coding-agents.mdx` |
| Assign a task to an agent | Adding a bot to Assignees starts a session in the task's discussion with a task brief; only newly added bots trigger; agent updates the task, reports in the session. | `crates/agent_trigger/src/domain/task_assignment.rs`, `.../task_assignment/prompt.md` |
| Session ↔ PR ↔ task | PR from `set_pull_request` or provider (Cursor `pr_url`, Codex verified metadata). Canonical `https://github.com/o/r/pull/N` (no creds/query); unchanged URL no-op; agent-opened link cannot be unlinked, user links can. | `crates/agent_session/src/domain/pull_request.rs`, `crates/github/src/domain/service/pull_request_tasks.rs` |
| GitHub App | Install for user/team. Webhooks: opened/reopened/edited → In Review, merged → Completed, closed unmerged → Not Started; bot comment with task links; notifications for review requested, mentions, comments, reviews, finished checks. Copy task branch name **⇧⌘B**. | `apps/docs/integrations/github.mdx`, `crates/github/src/domain/service/sync/handle_pr.rs`, `apps/web/src/lib/core/util/branchName.ts` |
| GitHub account link | OAuth (FusionAuth IdP) → "me" in Reviews, merge as the user; merge rejections show GitHub's message (409/404/403/422). | `crates/github/src/domain/service/link.rs` |
| PR page (`block-pr`) | Title, labels, cleaned description, timeline merging GitHub comments/reviews with Macro threads (replies grouped under root, empty bodies hidden, optional bot hiding), checks, Changes pane, Merge, side panel (sessions, linked work, origin). Merge only when open, not draft, ≥1 check, all success/skipped/neutral; confirm dialog. Macro-side PR discussion is an in-memory prototype lost on reload. | `apps/web/src/features/block-pr/views/PrDetail.tsx`, `.../primitives/pull-request-ready-to-merge.ts`, `.../data/timeline.ts`, `.../data/prDiscussionSource.ts` |
| Reviews (PR inbox) | Scopes All / Authored / Assigned / Involves / Review requests; Open / Closed (closed+merged) tabs. Filters: status, repo, author, assignee, label, review state, priority (task Priority else label), linked (agent/ticket/customer/channel), origin incl. "unknown". Sorts priority / updated / created. Viewer filters inert until GitHub linked. Page 100 + load more. `g v`. | `apps/web/src/features/reviews-view/reviews-filter.ts`, `.../reviews-types.ts`, `.../queries/use-reviews-query.ts` |
| PR origin detection | Claude, Codex, Cursor, Devin, Copilot, Jules, Macro, by strongest signal (see §3 flows). | `apps/web/src/features/block-pr/data/pr-origin.ts` |
| macrod local daemon | ratatui panel; pair by code approved in web; serves Claude Code, Codex CLI, Hermes, OpenClaw, OpenCode via ACP or real TUIs in herdr tabs. Quickstart detects CLIs, installs pinned adapters; scope private/team; `allow_permission_bypass` needs web confirm; `/compact /init /fast /effort /model`; remote permission answers only for same dialog generation. | `crates/coding_agent_worker/README.md`, `src/main.rs`, `src/tui/agent_catalog.rs` |
| Cursor walkthrough artifacts | Agent screenshots/recordings re-hosted (provider URLs expire in 15 min), appended as markdown; streamed `<img>` withheld across chunks. | `crates/cursor_cloud_agents/src/domain/artifact.rs` |
| Bash / TextEditor code execution | Nested Anthropic call with `code_execution_20250825`, Macro's key, billing admission; collapsible render. | `crates/anthropic/src/toolset/bash_code_execution.rs` |
| Dispatch-to-agent deep links | From a doc/task: copy prompt or open `claude.ai/code?q=`, `codex://new?prompt=`, `cursor://anysphere.cursor-deeplink/prompt?text=`, `zed://agent?prompt=`; last action persisted; no length cap. | `apps/web/src/features/block-md/component/DispatchAgentMenu.tsx` |
| Node blame tooltip (adjacent) | Hover a Lexical node → last editor (Loro peer); fetch after 400 ms stillness, show at 500 ms. | `apps/web/src/lib/queries/blame.ts`, `.../plugins/blame-tooltip/BlameTooltip.tsx` |

## 3. How it's built

**Overview**: hexagonal Rust crates. `agent_harness`'s `RoutedContainerManager` routes each session (by bot/harness)
to a provider whose transport is an ACP JSON-RPC pipe. Cloud providers are in-process ACP agents (duplex pipe);
sandboxes and macrod speak ACP over websocket to a runtime gateway. Raw provider output is journaled
(`cursor_journal_input`, `codex_journal_input`) and reduced by one deterministic replay machine for live and
`session/load`; ACP frames land in `agent_session_log` and fold to messages in the browser (`crates/folds/agent_fold`,
also WASM). Per-user credentials are owner-bound KMS ciphertexts in Postgres, refresh serialized by advisory/row locks.
GitHub: App JWT → repo-scoped installation tokens, HMAC webhooks; PRs as `foreign_entity` + typed row. Frontend:
SolidJS over TanStack Query and the Soup AST query API.

### Components

| Unit | Path | Role | LOC |
| --- | --- | --- | --- |
| claude_cloud_agents | `crates/claude_cloud_agents` | Demo-only Claude Code cloud provider: manual-paste PKCE, durable refresh, code-sessions HTTP/SSE, delta/durable `Translator`, ACP adapter with permission delegation | 3,230 |
| codex_cloud_agents | `crates/codex_cloud_agents` | ChatGPT `wham` task API, device OAuth, `SessionService` with `uncertain_write`, journal + `ReplayMachine`, PR metadata | 4,190 |
| codex_connection | `crates/codex_connection` | Device-login attempts, environment pick, AES-GCM envelope w/ KMS data key, `FOR UPDATE` owner lock | 776 |
| cursor_api_key | `crates/cursor_api_key` | Key at rest (direct KMS, context `{purpose,user,version}`), redacting newtype, `default_model_id` | 581 |
| cursor_cloud_agents | `crates/cursor_cloud_agents` | Official Cursor API as ACP agent: lazy agent create, run per prompt, SSE→ACP `TranslateMachine`, reconnect + poll fallback, journal, foreign-run mirror, artifacts, PR/branch reporters; stdio binary | 9,869 |
| coding_agent_worker (macrod) | `crates/coding_agent_worker` | Pairing, gateway ws, SSE triggers, `AcpProcess` supervision, npm adapter catalog, repo find/clone/worktree, herdr TUI + transcript tail | 11,119 |
| github | `crates/github` | App sync, HMAC webhooks, task linking + status, PR comments, notifications, installation tokens, OAuth link + merge | 9,046 |
| github_pull_requests | `crates/github_pull_requests` | PR model/storage, Reviews facets, changeset service (patches in S3) | 5,002 |
| git_patch | `crates/git_patch` | Pure unified-diff reader: per-file kind/±/binary, 6 MiB / 1 MiB budget, `patch_omitted`; does not apply | 581 |
| coding-agent-worker (prototype) | `services/coding-agent-worker` | Bun/Hono → Daytona sandbox → Rust ws↔stdio `acp-sidecar` | 1,121 |
| claude-connection (web) | `apps/web/src/features/claude-connection` | Connect card + controller | 394 |
| block-pr (web) | `apps/web/src/features/block-pr` | PR page, merge, changes, timeline, origin, links | 3,516 |
| reviews-view (web) | `apps/web/src/features/reviews-view` | PR inbox over Soup AST | 2,258 |
| flags / queries (web) | `apps/web/src/lib/core/{codex,cursor}`, `lib/queries/{claude-auth,blame.ts,github-stars.ts}` | PostHog flags, Claude status, blame, star count | 127 |
| agent_harness (adjacent) | `crates/agent_harness` | Provider routing, preflight + decline, Haiku repo chooser, sandboxes | — |
| agent_session / agent_trigger / agent_egress / folds / agent_changes (adjacent) | `crates/agent_session` etc. | Session model, PR+task links, coding MCP tools, task assignment, egress token stamping, transcript folds, per-turn changesets | — |

### Data model

| Entity | Storage | Key fields | Path |
| --- | --- | --- | --- |
| Claude grant + PKCE attempt | PG `claude_oauth_grants` (KMS ciphertext) | user_id PK, ctx `claude-cloud-oauth`, grant {access, refresh, expires_at, org, environment} | `crates/macro_db_client/migrations/20260910144348_add_claude_oauth_grants.sql` |
| Codex connection | PG `codex_connections.encrypted_state` JSONB envelope | connection {id, credentials, environment_id}, attempt {status, next_poll_at, interval} | `.../20260915231628_codex_connections.sql` |
| Cursor config | PG `cursor_configs` | user_id PK, key_ciphertext, default_model_id | `.../20260826150909_cursor_configs_rename_and_default_model.sql` |
| External session map | PG `external_agent_session` | provider, external_id (UNIQUE pair), external_url, last_run_id | `.../20260821212035_external_agent_session.up.sql` |
| Native journals | PG `cursor_journal_input` / `codex_journal_input` | (session, sequence) PK; Prompt / Native / Poll / Terminal … | `.../20260906060601_cursor_session_replay.up.sql` |
| Session + log | PG `agent_session`, `agent_session_log` | harness, repo_url, status, pull_request_url; log = ACP frames | `.../20260818220644_new_ai_agents.up.sql` |
| Session ↔ PR | PG `agent_session_pull_request` | (session, github_key) PK, source agent\|user | `.../20260926183402_agent_session_pull_request.sql` |
| PR ↔ task | PG `github_pr_tasks` | github_key, task_id, UNIQUE pair (migration comment's key format ≠ code's) | `.../20260305182148_track_task_with_pr.sql` |
| Typed PR row | PG `github_pull_request` + `foreign_entity` | github_key PK, status open\|closed\|merged, draft, reviewer/participant arrays (GIN) | `.../20260926173005_github_pull_request.sql` |
| Changesets | PG `github_pull_request_changeset`, `agent_session_changes`; S3 patch | id = uuidv5(repo/pull/n/changes/base...head), files JSONB, truncated, attempt outcome captured\|not_ready\|failed | `.../20260927202507_github_pull_request_changeset.sql` |
| macrod harness | PG `harnesses`, `harness_tokens`, `harness_pairing_requests`; local `macrod.toml` bearer `mhns_…` | owner XOR team, allow_permission_bypass | `.../20260831201832_create_harnesses.up.sql` |
| macrod native sessions | `~/.macrod/herdr/<id>/sessions/<uuid>.json` (0600), `repos/`, `worktrees/<session>` | kind, cwd, model, native_id, transcript path | `crates/coding_agent_worker/src/herdr/store.rs` |
| Tool approvals | PG `agent_session_tool_approval` | status pending\|approved\|denied\|cancelled\|expired | `.../20261005203905_agent_session_tool_approval.sql` |

### Key flows

**Cursor @mention → run → PR → task** (`crates/cursor_cloud_agents/src/domain/service.rs`,
`crates/agent_harness/src/domain/repository_choice.rs`)
1. `@cursor` → trigger → preflight resolves key; missing → decline with connect chip, no session row.
2. Session row + announcement → decrypt key → duplex pipe → Cursor ACP serve.
3. First prompt → `RepositoryChooser`: reachable repos, recent session repo, Haiku only if ambiguous.
4. `POST /v1/agents` → `external_agent_session` row → SSE run stream (reconnect; poll fallback).
5. Raw records journaled → `TranslateMachine` → ACP updates → `agent_session_log` → realtime → browser fold.
6. Result `pr_url` → canonical URL → `agent_session_pull_request` → `github_pr_tasks`; artifacts re-hosted.

**GitHub webhook** (`crates/github/src/inbound/github_sync_router.rs`, `.../sync/handle_pr.rs`,
`crates/github/src/domain/models/sync.rs`)
1. HMAC-SHA256 (constant time) → `ValidatedGithubWebhookEvent` by `X-GitHub-Event`.
2. `pull_request`: upsert foreign entities + typed row; notify transitions, review requests, mentions.
3. opened/reopened: extract `MACRO-<id>` / `TEAM-<n>` from title, body, head branch (markdown code stripped) →
   validate against real tasks → skip existing links → PR comment → task status per action.
4. comments/reviews/check_run: upsert + notify; installation events upsert/delete sources.

**macrod local session** (`crates/coding_agent_worker/src/{daemon,runtime,harness}.rs`, `src/outbound/acp_process.rs`,
`src/herdr/{repositories,acp_agent,tail}.rs`)
1. Pair → bearer in `macrod.toml` → gateway ws; `AcpProcess` spawns adapter (cwd, `CLAUDE_CODE_EXECUTABLE`/`CODEX_PATH`,
   process group, stderr tail).
2. SSE trigger stream filtered by bound bot ids → `TriggerWork`.
3. Workspace only when Herdr workspaces configured, else other repos refused (`dispatch.rs:71-104`): find clone by
   origin ≤2 levels deep, or `clone --no-checkout` to temp + rename; fetch `main` only; `herdr worktree create --base
   origin/main` on branch `macro/<session>`, reused on redelivery.
4. Herdr mode: `claude --session-id <uuid>` / `--resume`, `--mcp-config <file>`; JSONL tailed by (inode, offset),
   complete lines only → `claude_fold` → ACP updates; Esc cancels.

**PR changes** (`crates/github_pull_requests/src/inbound/changes_router.rs`, `crates/git_patch/src/patch.rs`)
1. Repo-scoped installation token after ownership check → fetch diff.
2. `parse_git_patch` + `budget_patch` → S3 at deterministic key + changeset row (uuidv5 of base...head).
3. No diff from GitHub → `not_ready`, explained; agent sessions capture per turn via `agent_changes`.

**PR origin** (`apps/web/src/features/block-pr/data/pr-origin.ts`): Macro session that opened it > session link in
body (claude.ai/code, chatgpt.com/codex/tasks, cursor.com/agents, app.devin.ai, jules.google.com) > footer
("Generated with Claude Code", `Co-Authored-By: Claude`) > bot author login > branch prefix (`claude/`, `codex/`…).

## 4. Ideas worth stealing

1. **Child supervision** — own cwd, process-group leader, kill group, drain stderr continuously into a 64 KiB tail,
   report it with nonzero exit. Fixes live Cerebro defects. Read upstream Apache-2.0 `acp_agent.rs` (rev 8769d16),
   not the AGPL port. `crates/coding_agent_worker/src/outbound/acp_process.rs`
2. **Budgeted per-file changeset** — kind, ±, binary, previousPath, 6 MiB/1 MiB budget keeping diff order,
   `patch_omitted`, deterministic id. `crates/git_patch/src/patch.rs`, `crates/github_pull_requests/src/domain/models/changes.rs`
3. **Uncertain-write discipline** — persist pending before a non-idempotent external write, clear on durable receipt,
   never auto-retry. Matches typed proposal results. `crates/codex_cloud_agents/src/domain/acp_session.rs`
4. **Absent vs empty catalogs** — `Catalog::Unknown` ≠ `Reported(empty)`; listings never silently truncated. Same rule
   as Cerebro's. `crates/claude_cloud_agents/src/domain/models.rs`
5. **Secret hygiene** — redacting `Debug`, `Zeroizing`, `expose()` only at the boundary, status = booleans, no-store.
   Needed for Cerebro's plaintext `connectors.json`. `crates/cursor_api_key/src/cipher.rs`
6. **Transcript tail** — (inode, offset) cursor, complete lines, truncation/replacement = explicit reload, never
   implicit replay; pure fold crates. `crates/coding_agent_worker/src/herdr/tail.rs`, `crates/folds/README.md`
7. **Merge readiness as a rule** — open, not draft, every check success/skipped/neutral. Cerebro needs four states,
   not a boolean (§7). `apps/web/src/features/block-pr/primitives/pull-request-ready-to-merge.ts`
8. **Preflight-and-decline** — check the connection before creating resources; answer with an actionable chip.
   `docs/CURSOR_AGENT_TRANSPORT.md`, `crates/agent_harness/src/domain/codex.rs`
9. **Origin by strongest signal** — pure table. Re-derive from public facts (all-rights-reserved source).
   `apps/web/src/features/block-pr/data/pr-origin.ts`
10. **Delta/durable reconciliation** — durable text must start with streamed text or fail `Recovery`; dedupe by uuid.
    `crates/claude_cloud_agents/src/domain/translate.rs`
11. **Journal + one replay machine** — raw records incl. unknown fields; load never re-executes; partial history fails
    load. `crates/cursor_cloud_agents/REPLAY.md`
12. **Secret-free MCP config for child CLIs** — env-var refs + 0600 env file; Claude gets a `--mcp-config` file.
    `crates/coding_agent_worker/src/herdr/mcp.rs`
13. **Real-traffic replay fixtures** with insta snapshots. `crates/cursor_cloud_agents/fixtures/real/README.md`
14. **Task-assignment brief contract** — read task first, update status honestly, report in session.
    `crates/agent_trigger/src/domain/task_assignment/prompt.md`

## 5. Cerebro today vs Macro

| Macro feature | Cerebro status | Value | Note |
| --- | --- | --- | --- |
| Repo working-state (fetch, status, badges) | partial | high | M32.8–.12 built but orphaned off main (PR #15 merged into m31 11 s after #14 merged m31). Re-land is S. |
| Per-file changeset with budget | partial | high | `git/status.rs:10-86` has FileStatus incl. Renamed (old path discarded); `pages/ChangesPage.tsx` lists files + `DiffView`. No counts, binary flag, previousPath or budget. |
| Child supervision | partial (defective) | high | `agent/mod.rs:329-352` SIGKILLs pid only; no process group; no `wait()` (zombies); stderr read after stdout EOF, only w/o session id, 600 chars; `stop_all` has no production caller; `RunEvent::Exit` doesn't stop runs (`lib.rs:1690`); `McpState::ensure` retargets live runs (`mcp.rs:502-509`). |
| Stored provider credentials | **worse, not "already-better"** | high | `connectors.rs:104-124` writes `<vault>/.cerebro/connectors.json` 0644 with HTTP headers / env tokens; only gitignored. |
| Forge URL handling | defective | high | `git/mod.rs:102-115` `web_base` passes `user:token@` through into `file_url` links; ssh ports leak into https. |
| Local coding sessions in worktrees | absent | low | cwd is always the vault. Blocked by M30 D4, M32.12, M33b D1. CLI has native `-w`, `--bg`. |
| Task assigned → agent runs | partial | medium | `when:` triggers, but `triggers.ts:111-137` matches `to:` against the joined string: a member added to a multi-valued field matches only when sole. |
| ListCodingAgents / Dispatch | partial | low | `hand_to` analog; no coding callee. |
| Session ↔ PR ↔ task | absent | medium | url fields exist; nothing knows a PR. Claude Code already writes `pr-link` records (571 locally). |
| PR page / merge | absent | medium | Merge = work-repo write; stays out. |
| Reviews inbox | absent | low | Scape `list_github_prs` + GitHub UI cover it. |
| GitHub App webhooks | different-by-design | low | Loopback only; local analog = suggestion on view. |
| Cloud providers | different-by-design | low | No keys, no cloud (D3), ToS risk. |
| ACP multi-CLI seam | absent | low | Single-CLI premise. |
| Claude Code control protocol | partial | medium | One-shot `-p`, stop by kill. `06-agents.md`. |
| Transcript awareness | partial | low | `cli_workspace` counts/purges top-level `*.jsonl` + `memory/` only; leaves `<uuid>/tool-results`, `subagents/`. |
| Code-execution tools | different-by-design | low | Shell ceiling covers it. |
| Deep links | absent | low | External links use `window.open` (`LinkBadges.tsx:80`). |
| Node blame | absent | low | `03-editor.md`; value is human-vs-agent authorship. |

## 6. Port candidates

| id | title | mode | fidelity | effort | value | Macro guide (read first) | Cerebro target | depends |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| CODING-1a | Re-land M32 root git + CI hardening; fix web_base leak | rebuild | adapt | S | high | `crates/coding_agent_worker/src/outbound/git.rs` | cherry-pick M32.1–.7 then 490b38a 83bcf59 dd43120 8500007 de44e4b; `src-tauri/src/roots_git_commands.rs`, `git/command.rs`, `git/mod.rs`, `SECURITY.md`, `src/stores/rootsStore.ts` | — |
| CODING-1b | Per-file changeset on the existing Changes page | rebuild + adopt-upstream (`@pierre/diffs`, evaluate) | adapt | M | high | `crates/git_patch/src/patch.rs`, `crates/github_pull_requests/src/domain/models/changes.rs`, `crates/agent_changes/src/domain/model.rs` | `src-tauri/src/git/status.rs`, `src/pages/ChangesPage.tsx`, `src/git/DiffView.tsx`, `src/engine/git.ts` | 1a |
| CODING-2 | CLI child supervision + run lifecycle | rebuild (attributed upstream copy allowed) | adapt | M | high | upstream ACP rust-sdk `src/acp_agent.rs` @8769d16; `crates/coding_agent_worker/src/outbound/acp_process.rs` | `src-tauri/src/agent/mod.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/mcp.rs` | — (one owner with `06-agents.md`) |
| CODING-12 | Connector secrets at rest | rebuild | inspire | S | high | `crates/cursor_api_key/src/cipher.rs:53-90` | `src-tauri/src/connectors.rs`, `SECURITY.md` | — |
| CODING-3 | Work item ↔ PR chip, state read live via `gh` | rebuild | adapt | M | medium | `crates/agent_session/src/domain/pull_request.rs`, `apps/web/src/features/block-pr/primitives/pull-request-ready-to-merge.ts`, `.../data/pr-origin.ts` | `src-tauri/src/git/forge.rs` (new), `src-tauri/src/forge_commands.rs` (new), `src/lib/forgeIpc.ts`, `src/lib/mockForge.ts`, `src/detail/PullRequestChip.tsx`, `src/engine/pullRequest.ts` | owner gate A; 1a; 11 |
| CODING-11 | Read Claude Code `pr-link` records; resume via `--from-pr` | rebuild | inspire | S | medium | `crates/coding_agent_worker/src/herdr/tail.rs` (cursor pattern) | `src-tauri/src/agent/transcript.rs` (new), `src/detail/PullRequestChip.tsx` | — |
| CODING-5 | Hand a work item off to Claude Code (CLI `--bg -w`) | rebuild | inspire | M (handoff) / L (own worktrees) | low | `crates/agent_trigger/src/domain/task_assignment/prompt.md`, `crates/coding_agent_worker/src/herdr/repositories.rs` | `src-tauri/src/agent/mod.rs`, `src/engine/agents.ts`, `SECURITY.md`, `src/pages/CliWorkspaceRow.tsx` | owner gate B; 1a; 2; 11 |
| CODING-7 | Claude Code session metadata per root | rebuild | adapt | S | low | `crates/coding_agent_worker/src/herdr/tail.rs` | `src-tauri/src/roots_commands.rs`, `src/workspace/RootSessions.tsx` | 11 |
| CODING-8 | Deep-link handoff menu (+ Copy branch name) | rebuild | mirror | S | low | `apps/web/src/features/block-md/component/DispatchAgentMenu.tsx`, `apps/web/src/lib/core/util/branchName.ts` | `src/engine/dispatchPrompt.ts`, `src/pages/DocPage.tsx`, Rust `open` command or opener ≤2.5.x | — |
| CODING-6 | `request_push` card on the record page | rebuild | inspire | M | low | `crates/codex_cloud_agents/src/domain/acp_session.rs` | `src-tauri/src/git/remote.rs`, `src-tauri/src/runtime/schema.rs` (`work_repo_writes`), `src-tauri/src/mcp.rs` | 5 (own-worktree path only); 1b; 3 |
| CODING-4 | Reviews PR inbox | skip | — | — | low | `apps/web/src/features/reviews-view/reviews-filter.ts` | (optional: one "Review requested" lane in My work) | 3 |
| CODING-9 | ACP as the agent seam | skip | — | XL | low | `crates/coding_agent_worker/src/tui/agent_catalog/npm_adapter.rs` | — | — |
| CODING-10 | Cloud agents, App webhooks, server code exec | skip | — | S (docs) | low | `crates/claude_cloud_agents/src/outbound/credentials.rs` | `SECURITY.md` out-of-scope list (with 1a) | — |

### CODING-1a — re-land M32, fix the leak

- Merge-tree shows clean code merges. Land CI range first (conflicts: `.gitignore`, `AGENTS.md`), then root git
  (conflict: modify/delete `.github/SETUP.md`).
- Silent bug: merged `roots_git_commands.rs:23,71` call `.app_config_dir()`; switch to `crate::app_config::app_dir`
  (M49.2 dev isolation) or dev builds read the wrong `roots.json`.
- Kill falsified comments: `git/command.rs:68` ("whole of credentials.rs"); `SECURITY.md:16-18` modes M8.1 retired;
  M32.12's "read-only mode" wording. Merged e2e uses `boot` from `./boot`, retiring the private `boot()`.
- Also: strip creds/ports in `web_base`; make `rootsStore` loadRoots/unmount/toggle catch + toast; add CODING-10's
  out-of-scope list to SECURITY.md.

### CODING-2 — supervision and run lifecycle

- `process_group(0)`; stop = TERM group → grace → KILL group; reap with `wait()` in the reader thread, report status.
- Drain stderr on its own thread into a 64 KiB tail; attach to any nonzero exit; delete the `agent/mod.rs:933` comment.
- Call `stop_all` on vault switch and `RunEvent::Exit`; bind MCP run tokens to their vault or refuse after retarget.
- Limit: Bash-tool shells run as their own group leaders (observed), so a group kill reaches stdio connectors, not them.
  Test a child that leaves the group and state the limit. Keep process-tree tests bounded (crash-test wedge history).

### CODING-1b — changeset on the Changes page

- `git diff --numstat -z -M` (binaries as `-\t-`) extends `ModifiedFile`; keep previousPath; binary counts absent,
  rendered "binary"; totals say how many binaries went uncounted.
- Patches load lazily per file under a 2 MiB cap (matches `roots/read.rs:13`), not one 6 MiB blob over invoke.
- Missing base ref → typed refusal; git failure → `section-unavailable`, never "No changes". `diffStats` derives from
  Rust totals (no twin counter). No new ChangesView.
- Evaluate `@pierre/diffs` 1.3.5 (React 19 peer, shiki ^3||^4; Cerebro has shiki ^4.4.2) as renderer.

## 7. Conflicts with Cerebro conventions

| Macro pattern | Cerebro invariant | Resolution |
| --- | --- | --- |
| Readiness folds `checks=null` and `[]` into false | Absent is never zero | Four states: `checks_unknown`, `no_checks`, `not_ready`, `ready`; gh failure in words. `reviewDecision ''` = not recorded; `mergeStateStatus UNKNOWN` = unknown. |
| Binary files report 0/0 | Absent is never zero | Counts absent; render "binary"; totals name the skipped count. |
| Webhook sets fixed status names | No type special-casing; nothing speaks first | Suggest by status GROUP (merged → first done-group status) on the record page; a click applies it. |
| PRs mirrored to Postgres via webhooks | Vault is source of truth; loopback only | Only the URL lives in the vault; state read live via `gh`, ≤60 s memory cache. |
| Agent pushes / opens PRs | Root git stops at fetch + ff-only pull; work-repo writes need proposals | Coding argv denies push/PR; `request_push` card; Cerebro runs push, typed `RemoteOutcome`, pending/uncertain row. Decide on M32.10 `hooksPath=/var/empty` (skips pre-push hooks). |
| One approvals table; `propose_*` naming | `propose_` is the policy-generated namespace (`mcp.rs:929-985`); TargetClass closed (`proposal.rs:24-37`); Review = concept queue | Name it `request_push`; runtime.db store; card on the record page + My work count, not Knowledge Review. |
| macrod clones + owns worktrees | M30 D4: never own a checkout | Prefer CLI handoff (`claude --bg -w`): the CLI owns it. If Cerebro owns worktrees: cut from mounted roots only, never clone, disclose that `worktree add` writes refs + `.git/worktrees` into the user's repo, record the narrowed exception. |
| Haiku picks the repo | M32.12: ambiguity is an error | `repo:` (wikilink from `relationships`) or user pick; typed refusal on ambiguity. |
| OAuth grants / `crsr_` keys in KMS | No API key enters the app | Skip (CODING-10); `gh`, git, claude own their auth. |
| ACP adapters: default settingSources `['user','project','local']` | `--setting-sources user` (M17.1), argv narrowing | Keep direct stream-json; coding runs get an explicit argv variant; force `--strict-mcp-config` (conditional today, `mod.rs:728-735`); no bypass mode. |
| Deny rules as enforcement | The grant is the boundary | `Bash(git push:*)` deny is advisory under a shell grant (`git -C`, `sh -c`, `env` bypass); say so. |
| Transcripts journaled + replayed | Mounted repos emit no epistemic events; agent root exposure OFF | Display-only metadata; never ingested or served over MCP; extend the disclosure row. |
| Merge failure surfaces raw message | Typed results | `ForgeRefusal` / `RemoteOutcome` codes; message is display text. Decide whether ForgeRefusal follows MountRefusal (not in `policy.v3.json`) or gets declared destinies. |
| Fleet/run writes | `runtime/fleet.rs` is SELECT-only | Write `root_id`/branch through the Meter; coordinate `user_version` 19. |
| AGPL / all-rights-reserved code | M48 D2 refused GPL against Apache-2.0 | Behaviour guide only; copy from upstream Apache-2.0 sources with attribution. |

**Prior decisions these touch**: M30 D3 (no GitHub API) — CODING-3/4/6 reverse it; owner gate A. M30 D4 + M33b D1 +
M32.12 — CODING-5 own-worktree path reverses them; owner gate B. Draft roadmap D16
(`docs/superpowers/plans/2026-10-12-macro-port-roadmap.md:25`) recommends a read-only gh chip and argues against
Cerebro-owned worktrees; it is a draft (only D0 is owner-decided). Agent platform D3 (no daemon, no cloud) rules out
macrod and cloud providers. M40: transcripts render in AiPanel only.

## 8. Verification notes (stage 3)

- **Confirmed**: M32 absent from main/HEAD (gap 11 s, not 12). Stop kills pid only; stderr late. Transcripts at
  `~/.claude/projects/<slugify_path(cwd)>/`, worktrees included, with uuid/isSidechain/stop_reason. Upstream SDK is
  Apache-2.0 with 64 KiB tail, `process_group(0)`, group KILL. No HTTP crate in direct deps. M32 hook pin skips
  pre-push hooks on Cerebro pushes.
- **Refuted — re-land is M with many conflicts**: merge-tree shows one modify/delete (`.github/SETUP.md`) plus
  `.gitignore`/`AGENTS.md` in the CI range; real hazard is the silent `app_config_dir` bug. Re-land is S.
- **Refuted — adapters can't carry Cerebro's guards / licences unknown**: both Apache-2.0; `dist/acp-agent.js` passes
  settingSources, disallowedTools, extraArgs via `_meta` and emits full usage. Barriers are Node, the proprietary
  transitive `@anthropic-ai/claude-agent-sdk`, adapter-specific `_meta`, fail-open defaults. tokio already in tree.
- **Refuted — "already-better" on credentials**: `connectors.json` holds tokens at 0644 → CODING-12.
- **Refuted — canonical_url accepts `/files` "following Macro"**: Macro's regex rejects it and PR 0. Accepting
  `/files`, `/commits`, `/checks` is a named divergence; compare owner/repo case-insensitively.
- **Partial**: diff rendering is more than parseDiff (status.rs + ChangesPage exist → extend, don't build).
  `--strict-mcp-config` is conditional. `RootTree.tsx:116-120` reads `caps.git` (heuristic only). `when:` misses
  multi-valued adds. Macro's worktrees exist only via Herdr and fetch `main` only. Policy proposals are ledger events
  but Review is the concept queue. `web_base` is a live defect now, not a CODING-3 detail. opener ≥2.6 needs
  tauri ^2.12; Cerebro locks 2.11.5; Macro has no 8 KB cap (Cerebro addition).
- **gh casing**: `pr view` uppercase `MERGED`, `search` lowercase `merged`, CheckRun status/conclusion uppercase; handle
  `StatusContext.state`. `gh search prs --json` lacks headRefName, statusCheckRollup, reviewDecision, mergedAt →
  CODING-4 skipped.
- **Unverifiable**: owner gates A and B; CLAUDE.md/hook loading and deny enforcement in a worktree (CLI not run;
  `--bare` unusable: API-key-only auth); 6 MiB invoke latency (not measured → lazy 2 MiB per file).
- **Missed items folded**: CODING-11 (`pr-link`, `--from-pr`), CODING-12 (connector secrets), native CLI worktrees/
  `--bg`/`claude agents --json` (into 5 and 7), `@pierre/diffs` (1b), `agent_changes` (1b), run lifecycle (2),
  disclosure undercount (fix under `06-agents.md` before 5/7), trigger `to:` (`08-automation.md`), run-id trailer +
  blame (`03-editor.md`).
- **Open questions kept**: GitHub doc's "In Progress on branch create" has no handler; `github_pr_tasks` key-format
  drift; status of `services/coding-agent-worker`; whether `cursor_cloud_agents`' stdio bin builds without Macro crates.

## 9. Where to read first

1. `crates/coding_agent_worker/src/outbound/acp_process.rs` (then upstream rust-sdk `src/acp_agent.rs` @8769d16)
2. `crates/git_patch/src/patch.rs`, then `crates/git_patch/src/model.rs`
3. `crates/github_pull_requests/src/domain/models/changes.rs`, `crates/agent_changes/src/domain/model.rs`
4. `crates/cursor_api_key/src/cipher.rs`
5. `crates/agent_session/src/domain/pull_request.rs`
6. `apps/web/src/features/block-pr/primitives/pull-request-ready-to-merge.ts`, `.../data/pr-origin.ts`
7. `crates/github/src/domain/models/sync.rs`
8. `crates/codex_cloud_agents/src/domain/acp_session.rs` (uncertain write)
9. `crates/coding_agent_worker/src/herdr/tail.rs`, `crates/folds/README.md`
10. `crates/agent_trigger/src/domain/task_assignment/prompt.md`
11. `apps/web/src/features/block-md/component/DispatchAgentMenu.tsx`
12. `docs/CURSOR_AGENT_TRANSPORT.md`, `crates/cursor_cloud_agents/REPLAY.md` (architecture context)
