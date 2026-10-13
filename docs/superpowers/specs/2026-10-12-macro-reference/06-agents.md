# Macro reference — Agent runtime: sessions, harnesses, transcript folds, ACP, changes

**Scope**: Macro's agent runtime, read 2026-10-12 from `docs/examples/macro-main/` (vendored and gitignored). Every
Macro path below is relative to that root. Cerebro paths are relative to the repo root.
**Owner's rule (2026-10-12)**: Cerebro builds its own version, with Macro's code as the guide and never a 1:1 copy.
Modes are rebuild (fidelity mirror / adapt / inspire), adopt-upstream, reuse-permissive and skip.
**Licence**: Macro `crates/` and `services/` are AGPL-3.0 (`LICENSE.txt`). `apps/web/` reads "Copyright 2023 CoParse,
Inc. All rights reserved." Cerebro is Apache-2.0. **Design input only; copy no code, no prose.** Stage 1's "lift"
verdicts were technical only. Upstream ACP Rust SDK (rev 8769d16), `agent-client-protocol-schema` 1.6.0 and
`@agentclientprotocol/claude-agent-acp` are Apache-2.0 (verified); the Claude adapter depends on
`@anthropic-ai/claude-agent-sdk` ("SEE LICENSE IN README.md").
**Evidence**: stages 1–2 read code. Stage 3 checked claims against Cerebro's source, the claude-code 2.1.250 bundle,
argument-only CLI probes, one real Cerebro session JSONL, and code.claude.com (`agent-sdk/user-input`, `hooks`). No
model calls, no live spikes. Stage 3 overrides stages 1–2.
**Overlap**: `07-ai.md` AI-3/AI-10/AI-11/AI-12/AI-13, `09-mcp.md` MCP-3, `10-coding.md` CODING-2/CODING-7/CODING-9/
CODING-11 touch AGENTS-1/2, AGENTS-7/10, AGENTS-17, AGENTS-3, AGENTS-8, AGENTS-11, AGENTS-12. Plan them together.

---

## 1. What it is

- One contract for every agent: Macro's server is an ACP **client**; each runtime (own in-process LLM agent,
  Cursor/Codex/Claude cloud agents, sandboxed `opencode acp`, a user's local Claude Code/Codex via `macrod`) is an ACP
  **agent**.
- Every JSON-RPC frame, both directions, is wrapped in a tiny envelope and appended to Postgres `agent_session_log`
  **before** anything reacts. That log is the only history.
- Messages are re-derived on every read by one pure, total fold — natively on the server, as WASM in a browser
  worker — so streamed and reloaded sessions cannot disagree.
- "Agent changes" is **not** propose→review→apply: it is the linked GitHub PR diff captured per turn plus line-anchored
  review notes sent back as a prompt.

## 2. What users get

| Feature | UX details and shortcuts | Paths |
| --- | --- | --- |
| Agents as personas | Bot identity (name, @handle, avatar, owner user XOR team) + `agent_configs`: instructions, harness slug, `harness_id` (macrod), `default_model`, `channel_scope` all\|selected, `mcp_scope`, `auto_accept_permissions`, `is_coding`. @mention triggers; coding agent answers with a Magic Chip (live portal), chat agent with a pending reply patched at turn end. Instructions snapshot per new session. Roster shows runtime label + connected + `unavailableReason`. MCP tools ListAgents/ConfigureAgent. | `crates/bots/src/domain/models.rs`, `crates/macro_db_client/migrations/20260827174457_persist_agent_configs.sql`, `crates/agent_harness/src/domain/model.rs` (`AgentKind::from_harness`), `crates/agent_harness/src/outbound/channel_announcer.rs`, `apps/web/src/features/agents-view/core/roster.ts`, `apps/docs/product/agents.mdx` |
| Session page (live transcript) | User bubbles, streamed text, collapsible thoughts, tool cards (terminal w/ ANSI, edit diffs, read/search/fetch, subagents with nested children), plan/todo, failure cards. Consecutive tools + thoughts collapse to "Called N tools"; subagents, user tools, self-rendering tools break groups; trailing thought stays visible. One "working" line, decided once from fold `TurnState`. Status pill from `metadata.status`. | `apps/web/src/features/block-agent/component/Transcript.tsx`, `.../state/tool-groups.ts`, `.../state/live-turn.ts`, `.../state/session-status.ts`, `.../ui/FailureNoticeCard.tsx` |
| Composer, queue, steer | Markdown composer, @mentions, attachments (ACP `resource_link`), dictation, slash commands from advertised `available_commands`, model+effort picker. Mid-turn prompts go to a server queue (cap 50): edit, remove, **steer** (front + cancel current turn). UI reads REST once, then trusts full-queue `agent_session_queue` snapshots (last wins). Speculated prompt shows pending, promoted on log confirm. | `apps/web/src/features/block-agent/ui/AgentInput.tsx`, `.../ui/QueuedPrompts.tsx`, `.../context/create-queue-controller.ts`, `.../context/steer.ts`, `crates/agent_harness/src/domain/queue.rs` |
| Questions (ACP elicitation) | Form (text/number/integer/boolean/single-select + "Other"/multi-select) or URL consent (OAuth). Accept/Decline/Cancel in session or chip; owner/editor only; Stop cancels. Composer reads "Waiting for your answer". Client validates required/length/bounds/membership/counts, never agent regex. URL shown in full, host highlighted. 409 → "The agent is no longer waiting on that request". SendEmail/CreateCalendarEvent reviewed in-turn the same way. | `docs/ACP_ELICITATION.md`, `apps/web/src/features/block-agent/component/parts/ElicitationPart.tsx`, `.../parts/LiveElicitation.tsx`, `.../state/elicitation-form.ts`, `.../primitives/create-interaction-controller.ts`, `crates/folds/agent_fold/src/domain/fold/elicitation.rs` |
| Permissions + tool approvals | `session/request_permission` card with the agent's options (allow once/always, reject) under policy Prompt (macrod default); managed sandboxes auto-accept. Policy = harness `allow_permission_bypass` AND agent `auto_accept_permissions`. MCP calls in turns prompted by a non-owner held by egress until owner approves (optional "remember"). Runtime principals never answer their own requests. | `.../ui/PermissionCard.tsx`, `.../ui/ToolApprovalCard.tsx`, `crates/agent_harness/src/domain/model.rs` (`resolve_permission_policy`), `crates/agent_session/src/domain/control.rs`, `crates/agent_egress/src/domain/approval.rs` |
| Bring your own agent (macrod) | TUI daemon (macOS/Linux): Quickstart detects Claude Code/Codex/OpenCode/OpenClaw/Hermes/custom ACP; pick workspace, Private/Team, Full Access; "Create and pair" → `XXXX-XXXX` code approved in Settings → Agents → Runtimes. Dials out (no port-forward). `p` pair, `c` copy code. Docs tagged "Coming soon". | `apps/docs/AI/bring-your-own.mdx`, `crates/coding_agent_worker/src/main.rs`, `.../tui/quickstart.rs`, `.../tui/agent_catalog.rs`, `crates/harnesses/src/domain/service.rs` |
| Native TUI mode (herdr) | Real `claude`/`codex` TUI per tab; prompts typed in; native JSONL tailed back; TUI permission dialogs → ACP requests answered by key press; local turns forwarded. Advertises /compact /init /fast /effort. Worktree per session from fresh origin/main. | `crates/coding_agent_worker/README.md`, `.../src/herdr/acp_agent.rs`, `.../src/herdr/tail.rs`, `crates/folds/claude_fold/src/lib.rs`, `crates/folds/codex_fold/src/lib.rs` |
| Changes pane + review notes | Linked-PR file tree + unified/split diff; notes on line ranges; queued notes sent as one numbered prompt naming file and lines. Notes/layout in localStorage `agent-changes:review:<scope>` / `agent-changes:layout:<scope>`. Refresh after every turn and on demand. | `apps/web/src/features/changes/README.md`, `.../core/review-notes.ts`, `.../agent-session-changes.tsx`, `crates/agent_changes/src/domain/service.rs` |
| Live preview | `SharePreview({port})` → ssh script → `https://<id>.<preview-domain>/` with HMR. One per session, 1 h lease, 15-min idle; banner refetch 30 s. | `services/preview_gateway/README.md`, `crates/agent_preview/src/domain/service.rs`, `apps/web/src/features/block-agent/component/AgentPreviewBanner.tsx` |
| Model + effort | Per-session model picker with effort submenu from ACP `configOptions` (category `thought_level`), discovered per harness+model; confirmed before first prompt. "Default" = no override; unsupported → no control; model change resets incompatible effort. | `docs/AGENT_EFFORT.md`, `.../ui/AgentModelSelector.tsx`, `crates/agent_harness/src/domain/capability_discovery.rs` |
| Agents view | Chat/code modes, recent conversations (j/k), new-chat page with agent + repo/branch pickers, routines. `c a` new chat, `g a` go to Agents. Warm pre-initialized sessions (same owner/bot/model/instructions, ≤5 min). | `apps/web/src/features/agents-view/views/AgentsView.tsx`, `.../views/NewChatPage.tsx`, `apps/web/src/lib/queries/agent-session/warm.ts`, `crates/agent_session/README.md` |
| Notifications | `settled`, `waiting_for_input`, `mentioned`; idempotent ids from session+turn+kind; deduped against message notifications. | `crates/agent_harness/src/domain/notifications.rs` |
| Recording + replay | Stdio recorder between Zed and the Claude ACP adapter writes JSONL `{ts, direction, content}` (= log row); `fold_jsonl` CLI; web Gallery + Replay page. | `crates/agent_session/examples/agent_session_recorder.rs`, `crates/folds/agent_fold/src/bin/fold_jsonl.rs`, `apps/web/src/features/block-agent/debug/replay/Replay.tsx` |

## 3. How it's built

### Overview (bottom-up)

1. `agent_runtime_protocol` — wire vocabulary: `ToRuntimeMessage`/`ToServerMessage` envelopes (raw ACP JSON-RPC +
   lifecycle events `acp_ready`, `disconnected`, `reload_required`), `AgentAction`→ACP translation, `Transport` port,
   WebSocket carrier.
2. `agent_fold` (+ `claude_fold`/`codex_fold`) — owns the log vocabulary and the pure fold → `FoldedMessage` /
   `SessionMetadata` / `TurnSignal`; compiled to wasm32.
3. `agent_session` — sans-IO `SessionMachine` inside `SessionActor` (log-then-send), `RuntimeConnection` multiplexing
   sessions per transport, `AgentSessionService`, `LiveSessionLogWriter`, Postgres, replica leases + fencing.
4. `agent_harness` — orchestrator: Kafka trigger routing, per-session queue, prompt composition, announcements,
   permission policy, container managers per `AgentKind`, `/runtime/ws` gateway for macrod.
5. Side services: `agent_egress` (credential stamping + approval holds), `agent_changes`, `agent_preview`,
   `agent_session_realtime` (Kafka → GraphQL).
6. Composition roots: `services/agent_harness_service`, `services/preview_gateway`.
7. Web: `lib/core/agent-fold` (worker + WASM), `lib/core/agent-session` (log + socket + speculation),
   `lib/queries/*`, `features/block-agent`, `features/agents-view`, `features/changes`.
- Off-list but essential: `crates/coding_agent_worker` = macrod; `crates/bots` holds the Agent entity;
  `crates/claude_cloud_agents` speaks the Claude CLI's stdio control protocol (see AGENTS-14).

### Components

| Unit | Path | Role | LOC |
| --- | --- | --- | --- |
| agent_runtime_protocol | `crates/agent_runtime_protocol` | Envelope `agent-runtime.v0`; `AgentAction`/`AgentActionId`; ServerConnection/RuntimeConnection; WS carrier (2 s ping / 6 s silence); `_macro/tool_approval`; `_session/turn_complete`; `FailureNotice` | 4,485 |
| agent_session | `crates/agent_session` | `SessionMachine` Booting→Initializing→Opening(New\|Resume\|Load)→ConfiguringModel→Live{elicitation slot}→Dead, returns Effects; actor logs before send, 60 s handshake timeout; log writer batches 1.5 s (50 ms first output, cap 256); axum `/agent-sessions`, `/control`, `/queue`, `/log`, `/warm`, `/permissions` | 38,500 |
| agent_fold | `crates/folds/agent_fold` | `FoldMachineImpl.push(frame)` → `FoldEvent{NewMessage\|MessageUpdate\|MessagesReplaced\|MetadataUpdated}`; replay gate for `session/load`; `HarnessReader` per harness; `LifecycleFold` → `TurnSignal`; `SpeculativeFold`; wasm `FoldStream`; specta TS export; insta on real recordings | 18,452 |
| claude_fold / codex_fold | `crates/folds/claude_fold`, `crates/folds/codex_fold` | Native transcript → ACP updates. Claude: skip `isSidechain`, dedupe uuid, text/thinking/tool_use → chunks/tool_call, tool_result → update (output ≤4000 chars), `message.model` → ModelChanged (ignore `<synthetic>`), stop_reason → TurnEnded. Codex: rollout `item_completed` events | 794 (claude 190) |
| agent_harness | `crates/agent_harness` | `HarnessCommand` (Open, Deliver, EditQueued, RemoveQueued, SteerQueued, Turn, ToolApproval…); `AgentKind` capability flags; queue cap 50; `LexicalAgentPromptComposer`; announcer; runtime gateway (last dial wins); Daytona/Docker/Namespace/cloud managers; acp-sidecar; `FakeAgent` | 34,727 |
| agent_inmem | `crates/agent_inmem` | In-process ACP agent for Macro's own chat; `TurnEngine` port (scripted in tests); `/ask` rig drives elicitation; `replay_history` from frames; 5-min idle that re-arms while awaiting user | 11,177 |
| agent (LLM loop) | `crates/agent` | rig-core 0.41 loop, `ModelRouter`, `ReasoningEffort`, provider API keys | 14,988 |
| agent_egress | `crates/agent_egress` | Sandbox holds only a session token; routes `/mcp/*`, `/git/*`; holds non-owner tool calls (SSE keepalive 15 s; 30 min with progress, 4 min without; NOTIFY; standing approvals) | 8,764 |
| agent_changes | `crates/agent_changes` | `CaptureOnTurnEnd`, single-flight with rerun; summary in Postgres, patch in S3; GET `/changes`, `/changes/patch`, POST `/changes/refresh` | 2,972 |
| agent_preview / preview_gateway | `crates/agent_preview`, `services/preview_gateway` | SSH reverse forward to russh gateway; one-use tickets; access rechecked per request | 3,465 |
| agent_session_realtime | `crates/agent_session_realtime` | Ungrouped Kafka consumer → per-session broadcast; slow subscriber closed → client refetches | 458 |
| harnesses / harness_id / harness_token | `crates/harnesses`, `crates/harness_id`, `crates/harness_token` | Device-code pairing, `mhns_` tokens (SHA-256 only stored), 15-min TTL, 5 s poll | 3,520 |
| macrod | `crates/coding_agent_worker` | Pairing client; dials wss (backoff ≤30 s); one long-lived ACP child (`AcpProcess`: cwd, process-group kill, stderr tail); SSE trigger stream → Dispatcher; pinned npm adapters; herdr mode | 15,871 |
| agent_harness_service | `services/agent_harness_service` | Composition root (Postgres, sandboxes, egress, S3, gateway, Kafka, Redis, authorizers) | 6,015 |
| web block-agent | `apps/web/src/features/block-agent` | Session store, part renderers, `segmentParts`, interaction controller, composer, model selector, queue, debug | 25,150 |
| web agents-view | `apps/web/src/features/agents-view` | Agents surface; `core/roster.ts`, `core/recent-conversations.ts` pure | 9,531 |
| web changes | `apps/web/src/features/changes` | `ChangesPane` (@pierre/diffs), review notes, persisted scope state | 4,615 |
| web agent-fold | `apps/web/src/lib/core/agent-fold` | One worker per tab hosting WASM `FoldStream`; protocol = `FoldInput` snapshot/confirmed/speculated/retracted | 1,471 |
| web agent-session | `apps/web/src/lib/core/agent-session` | `AgentSession`: acquire/release, fold cached then fetched log, append socket rows, `issue()` with retract, error taxonomy | 4,727 |
| web queries | `apps/web/src/lib/queries/{agent-session,agents,harnesses,agent-repositories}` | GraphQL log watch, control POST, realtime event types, CRUD, pairing | 3,927 |
| infra | `infra/stacks/agent-harness-service` | Pulumi Fargate ×2, S3 (90-day orphan expiry) | 670 |

### Data model

| Entity | Storage | Key fields | Path |
| --- | --- | --- | --- |
| `agent_session` | Postgres | UUIDv7 (caller-mintable), owner, bot, model, harness, repo/branch/PR, workspace, instructions + MCP snapshot, `acp_session_id`, `status`, `turn_state` idle\|starting\|running\|stopping\|blocked\|disconnected, `manager_replica_id`+`manager_fence`, `egress_token_hash`, `turn_prompter` | `crates/macro_db_client/migrations/20260818220644_new_ai_agents.up.sql` |
| `agent_session_log` | Postgres, append-only, **source of truth** | session, `user_id` (who caused a to_runtime frame), direction, content JSONB `{type:acp,…}\|{type:event}`; history window starts at the init row before the latest successful `session/load` | same |
| `external_agent_session` | Postgres | provider, external id/url, `last_run_id` | `.../20260821212035_external_agent_session.up.sql` |
| bots + `agent_configs` + `agent_mcp_servers` | Postgres | see §2 personas | `.../20260827174457_persist_agent_configs.sql` |
| harnesses / tokens / pairings | Postgres | owner XOR team, `allow_permission_bypass`, token hash + prefix, code + device-secret hash | `.../20260831201832_create_harnesses.up.sql` |
| `agent_session_queue` | Postgres JSONB per session | `StoredQueuedAction[]` {actionId, raw text, actor, announce, context}; empty deletes row | `.../20260925001120_persist_agent_session_queue.sql` |
| `agent_session_changes` | Postgres + S3 | one row replaced per capture: refs/shas, files, +/−, patch key, truncated, attempt outcome | `.../20260918195318_agent_session_changes.sql` |
| tool approval / standing approval | Postgres + NOTIFY | status pending\|approved\|denied\|cancelled\|expired, remembered | `.../20261005203905_agent_session_tool_approval.sql` |
| macrod local | files | `macrod.toml`; `~/.macrod/herdr/<id>/sessions/<uuid>.json` (0600, temp+rename) | `crates/coding_agent_worker/config.example.toml` |
| recordings | `~/.agent_runtime_sessions/<id>.jsonl` | `{ts, direction, content}` | `crates/agent_session/examples/agent_session_recorder.rs` |

### Key flows

**Mention → session → turn**
1. @mention/composer → `agent_trigger` on Kafka → `route_agent_trigger` → `HarnessCommand::Open|Deliver`.
2. Open: session row (instructions/MCP snapshot), egress token (hash stored), runtime per `AgentKind`, attach.
3. Machine: `acp_ready` → `initialize` (advertises elicitation form+url) → `session/new|resume|load` (cwd, mcpServers,
   `_meta` agentSessionId) → optional `set_config_option` model → Live; queue flushes.
4. Dispatch pops one action, composes hidden context (owner, sender, instructions where no system prompt, trigger),
   announces, writes `turn_prompter`, sends `session/prompt` under `AgentActionId`.
5. Every inbound frame logged before reaction; permissions auto-answered or held; elicitation held.
6. Fold `TurnSignal::TurnEnded` → next queued action; reply patched; changes captured; notifications.
(`crates/agent_harness/src/domain/{trigger_router.rs,service/open.rs,service/queue.rs}`,
`crates/agent_session/src/domain/session/{session.rs,actors.rs}`)

**Realtime to UI**
1. Writer buffers ≤1.5 s (50 ms first output), one fenced insert, projects model + `turn_state`.
2. Publishes `agent_session_log` {entries = GET `/log` row shape} to the gateway and Kafka.
3. Browser `AgentSession` subscribes, fetches log, pushes Snapshot then Confirmed into the worker fold.
4. `issue()` → POST `/control` with client-minted actionId + Speculated input; promote by request id, rebase on foreign
   rows, Retracted on failure.
5. Fold events applied to a store keyed by (turn, author).
(`crates/agent_session/src/domain/service.rs`, `apps/web/src/lib/core/agent-session/AgentSession.ts`,
`crates/folds/agent_fold/src/domain/speculation.rs`)

**Elicitation round trip**
1. Agent sends `elicitation/create` (Claude: AskUserQuestion form, `question_N` + `question_N_custom`).
2. `hold_or_refuse_elicitation`: one session-scoped slot; unparsable/unknown mode/second request → −32602 (logged).
3. Fold adds `MessagePart::Elicitation` (absorbs the asking tool part), `TurnState::Blocked`, `ElicitationRaised`.
4. POST control `respondElicitation`; content closed to string/bool/int/number/string[].
5. Slot id mismatch → `ElicitationNotPending` → 409; else respond on the agent's id; fold → `Accepted{AnsweredField[]}`.
6. Stop sends cancel before `session/cancel`; turn end clears slot, part stays Pending.
(`docs/ACP_ELICITATION.md`, `crates/folds/agent_fold/src/domain/fold/elicitation.rs`,
`crates/folds/agent_fold/src/domain/harness/claude_code.rs`)

**macrod pair + serve**: POST `/harness-pairings` → code → user approves → daemon claims with device secret → `mhns_`
token → dial `/runtime/ws` → spawn ACP adapter in cwd, `acp_ready` → SSE triggers → sessions multiplexed by ACP
sessionId; permissions answered in the web UI. (`crates/coding_agent_worker/src/{runtime.rs,daemon.rs,dispatch.rs}`,
`crates/agent_harness/src/inbound/runtime_gateway.rs`)

**herdr tail**: open TUI tab → type prompt → poll 250 ms → locate transcript → read complete lines only (16 MiB cap) →
fold → `session/update`; TUI "blocked" → permission request → key press; `session/load` replays.
(`crates/coding_agent_worker/src/herdr/{acp_agent.rs,tail.rs,store.rs}`)

**Changes capture**: turn end → single-flight capture (rerun flag) → PR diff → `ChangedFile` facts with size budget →
patch to S3 → replace row → publish → pane refetches → notes → `formatNotesForAgent` → prompt, notes stamped sent.
(`crates/agent_changes/src/domain/service.rs`, `apps/web/src/features/changes/core/review-notes.ts`)

## 4. Ideas worth stealing (ranked)

1. **One pure, total fold for live and reload.** Reload cannot diverge from stream; vocabulary changes need no
   migration. Cerebro today has three readers of one stream (translate, meter Tally, TS handleEvent).
   `crates/folds/agent_fold/src/domain/fold.rs`, `crates/folds/agent_fold/src/lib.rs`
2. **Fold the CLI's own transcript.** `~/.claude/projects/<slug>/<session>.jsonl` already exists for `--resume`;
   rebuild history with no second copy. `crates/folds/claude_fold/src/lib.rs`
3. **Per-turn changeset, single-flight with rerun, attempt outcome recorded.** Fixes Cerebro's `add -A` sweep.
   `crates/agent_changes/src/domain/service.rs`
4. **Interactions are typed and attended**: one held slot, refusal codes, Stop answers Cancelled first, stale answer is
   a typed 409. `docs/ACP_ELICITATION.md`, `crates/agent_session/src/domain/session/session.rs`
5. **A principal cannot answer its own request** — enforce at the control boundary, not the UI.
   `crates/agent_session/src/domain/control.rs`
6. **Permission policy = operator ceiling × agent opt-in**; AutoAccept picks AllowAlways > AllowOnce > Cancelled.
   `crates/agent_harness/src/domain/model.rs`
7. **Sans-IO state machine (Input → ordered Effects) in an imperative actor.** Exhaustively testable, every death named.
   `crates/agent_session/src/domain/session/{session.rs,types.rs,actors.rs}`
8. **Typed failure notices end the turn instead of wedging it.** `crates/agent_runtime_protocol/src/domain/turn.rs`,
   `apps/web/src/features/block-agent/ui/FailureNoticeCard.tsx`
9. **Queue holds raw text; steer = front + cancel; snapshot events, last wins.** `crates/agent_harness/src/domain/queue.rs`,
   `apps/web/src/features/block-agent/context/steer.ts`
10. **Recorder → JSONL fixtures → snapshots; a test that real recordings fold with no warnings.**
    `crates/folds/agent_fold/src/domain/test/real_recordings.rs`, `crates/folds/agent_fold/scripts/sanitize_recording.py`
11. **Child in its own process group, continuous stderr tail, kill group on drop.** Read upstream SDK
    `acp_agent.rs` (Apache-2.0), not Macro's port. `crates/coding_agent_worker/src/outbound/acp_process.rs`
12. **Tool-group segmentation + one live-turn decision.** `apps/web/src/features/block-agent/state/tool-groups.ts`,
    `.../state/live-turn.ts`
13. **Review notes on line ranges → one prompt.** `apps/web/src/features/changes/core/review-notes.ts`

## 5. Cerebro today vs Macro

| Macro feature | Cerebro status | Value | Note |
| --- | --- | --- | --- |
| Frame log as only history | different-by-design | medium | M17 D4: transcripts stay out of the vault. Fold the CLI JSONL instead (AGENTS-1). |
| One fold for live + reload | partial | high | Three readers: `translate` (`src-tauri/src/agent/mod.rs`), meter Tally (`meter.rs`), `handleEvent` (`src/agent/useAgentChat.ts`). |
| Native transcript reader | absent | high | `-p --resume` appends to one JSONL (2.1.250, entrypoint `sdk-cli`); never read back. History is localStorage, cap 30, lossy. |
| Transcript of unattended runs | absent | high | Run log "not a transcript" by decision (`src/engine/runLog.ts`, M17.15). |
| Permission cards | absent | high | Permissions pre-decided (acceptEdits, allow/deny lists, Settings shell boolean). `mcp.rs` serves all runs on one thread. |
| Structured questions | absent | medium | No permission host in `-p` today → AskUserQuestion not even offered to the model. |
| Queue / edit / steer | absent | medium | Mid-turn send is dropped; one-slot `agentPendingPrompt` silently overwrites a second handoff (`uiStore.ts:972-975`). |
| Model + effort | absent | medium | Panel and job runner pass model null; `hand_to` sets None (`mcp.rs:2479-2492`). |
| Per-turn changes + diff | partial (broken) | high | `commit_all` → `git add -A` sweeps user edits; View diff blank after commit; auto-checkpoint commits in-flight agent writes; only the panel checkpoints. |
| Review notes | absent | medium | `parseDiff` has no line numbers. |
| Typed failure notices | partial | medium | Raw text in panel; quota feeds `RunOutcome::QuotaFailed` + health backoff; budget deferrals already typed. |
| Turn-state projection | partial | low | `streaming` boolean. |
| Tool grouping | absent | low | One `AiActionCard` per tool; three divergent write-tool lists. |
| Process group + stderr drain | absent | medium | Single-pid kill; stderr read after stdout EOF. |
| Recorder + real fixtures | partial | medium | 5 single-event fixtures; mock bypasses `translate`. |
| CLI workspace disclosure/purge | partial | medium | Misses `<id>/subagents`, `tool-results`, `workflows`; slug lacks the CLI's >200-char hash suffix. |
| Personas/configs | already-better | low | Vault records; scope/read-scope/tools on the bearer; pause is a run gate, memory is prompt content. |
| Accounting / concurrency | already-better | low | Meter, budget gate, N leases, unknown never zero. |
| Agent dispatches agent | already-better | low | `hand_to`: two hops, cycle refusal, root ceiling. |
| ACP multi-harness | different-by-design | low | One harness: the user's CLI. |
| macrod, sandboxes, egress, previews, Kafka, warm sessions | different-by-design | low | D3: app-lifetime only. |
| Notifications | different-by-design | low | M8 "nothing speaks first"; M33b D7. |
| Speculative fold | different-by-design | low | Local IPC; bubbles append synchronously. |

## 6. Port candidates

| id | title | mode | fidelity | effort | value | Macro guide (read first) | Cerebro target | depends |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| AGENTS-14 | Decision spike: per-turn `-p` + PreToolUse `defer` vs one long-lived stream-json process per attended conversation | rebuild | inspire | S | high | `crates/claude_cloud_agents/src/domain/service.rs:255-403` | `src-tauri/src/agent/mod.rs` (677-748, 876-884) | — |
| AGENTS-11 | Child hygiene: process group, TERM→grace→KILL, continuous stderr tail | rebuild | adapt | S | medium | upstream SDK `src/agent-client-protocol/src/acp_agent.rs:269-345` @8769d16; `crates/coding_agent_worker/src/outbound/acp_process.rs` (behaviour only) | `src-tauri/src/agent/mod.rs`, `src-tauri/Cargo.toml` | — |
| AGENTS-8 | Per-turn changeset: commit and show only what the run wrote | rebuild | adapt | L | high | `crates/agent_changes/src/domain/service.rs`, `apps/web/src/features/changes/core/changeset.ts` | `src-tauri/src/vault/write.rs`, `runtime/vault_writes.rs`, `runtime/schema.rs`, `git/commit.rs`, `src/git/useGit.ts`, `src/agent/AiActionCard.tsx` | AGENTS-1 |
| AGENTS-1 | One transcript fold: live stream-json and session JSONL → same events | rebuild | adapt | L | high | `crates/folds/claude_fold/src/lib.rs`, `crates/folds/agent_fold/src/domain/transcript.rs`, `.../test/real_recordings.rs` | `src-tauri/src/agent/{fold.rs,transcript.rs}` (new), `meter.rs`, `src/agent/transcript.ts` (new), `useAgentChat.ts`, `useConversations.ts` | — |
| AGENTS-10 | Typed failure notices | rebuild | adapt | S | medium | `crates/agent_runtime_protocol/src/domain/turn.rs`, `apps/web/src/features/block-agent/ui/FailureNoticeCard.tsx` | `src-tauri/src/agent/usage.rs`, `runtime/health.rs`, `src/agent/FailureNoticeCard.tsx` (new) | AGENTS-1 |
| AGENTS-17 | `alwaysLoad: true` on the cerebro MCP entry | rebuild | inspire | S | high | — (CLI-native) | `src-tauri/src/agent/mod.rs:751-768` | — |
| AGENTS-7 | Model + effort per agent and per conversation | rebuild | adapt | M | medium | `docs/AGENT_EFFORT.md`, `.../ui/AgentModelSelector.tsx`, `crates/folds/agent_fold/src/domain/model_selection.rs` | `src/engine/agents.ts`, `src/library/AgentEditor.tsx`, `src-tauri/src/agent/mod.rs`, `mcp.rs` (hand_to), `useJobRunner.ts`, `shared/` vocab | AGENTS-10 |
| AGENTS-2 | Transcripts for unattended runs in run detail + tool-group renderer | rebuild | adapt | M | high | `.../state/tool-groups.ts`, `.../state/live-turn.ts`, `.../component/Transcript.tsx` | `runtime/schema.rs`, `meter.rs`, `src/status/RunDetailPanel.tsx`, `src/agent/toolGroups.ts` (new) | AGENTS-1, owner sign-off |
| AGENTS-15 | CLI workspace: count + purge per-session dirs; locate by session-id glob | rebuild | inspire | S | medium | `crates/coding_agent_worker/src/herdr/tail.rs` | `src-tauri/src/agent/mod.rs:182-289`, `src/pages/CliWorkspaceRow.tsx` | — |
| AGENTS-16 | "Refused" list in run detail (operational) | rebuild | inspire | S | medium | `crates/agent_egress/src/domain/approval.rs` | `src-tauri/src/agent/usage.rs:99-133`, `runtime/dispatch.rs:965-990`, `RunDetailPanel.tsx` | — |
| AGENTS-6 | Per-conversation prompt queue: edit, remove, steer | rebuild | adapt | M | medium | `crates/agent_harness/src/domain/queue.rs`, `.../context/steer.ts`, `.../context/create-queue-controller.ts` | `src/agent/promptQueue.ts` (new), `useAgentChat.ts`, `AiPanel.tsx`, `uiStore.ts` | AGENTS-11, AGENTS-14 |
| AGENTS-18 | Prompt-cache stability under per-turn spawns (measure first) | rebuild | inspire | S–M | medium | — | `src/agent/AiPanel.tsx:431-442`, `src/agent/systemPrompt.ts`, `runtime/schema.rs:206-236` | feeds AGENTS-14 |
| AGENTS-3 | Wait on a person mid-turn (mechanism from AGENTS-14) | rebuild | adapt | M | medium | `crates/agent_session/src/domain/control.rs`, `docs/ACP_ELICITATION.md`, `.../primitives/create-interaction-controller.ts` | `src-tauri/src/agent/interaction.rs` (new), `mcp.rs`, `lib.rs` (answer command) | AGENTS-14, DOMAIN:mcp |
| AGENTS-4 | Ask before shell: attended permission prompts | rebuild | adapt | L | high | `crates/agent_harness/src/domain/model.rs`, `.../ui/PermissionCard.tsx` | `shared/policy/tool-approval.v1.json` (+goldens), `agent/mod.rs` build_args, `mcp.rs`, `src/agent/PermissionCard.tsx`, `uiStore.ts`, `SettingsPage.tsx` | AGENTS-3, AGENTS-14 |
| AGENTS-5 | AskUserQuestion answered in a card | rebuild | adapt | S | medium | `crates/folds/agent_fold/src/domain/harness/claude_code.rs`, `.../parts/LiveElicitation.tsx` | `src/engine/questionForm.ts`, `src/agent/QuestionCard.tsx` (new) | AGENTS-3, AGENTS-4, AGENTS-14 |
| AGENTS-9 | Review notes on a turn's diff, sent as one prompt | rebuild | adapt | M | medium | `apps/web/src/features/changes/core/review-notes.ts`, `.../primitives/create-review-state.ts` | `src/engine/reviewNotes.ts` (new), `src/engine/git.ts`, `src/git/DiffView.tsx` | AGENTS-8, AGENTS-6, DOMAIN:coding |
| AGENTS-12 | ACP transport | skip | — | XL | low | `crates/agent_runtime_protocol/src/domain/schema/v0.rs`, `.../agent_catalog/npm_adapter.rs` | — | revisit: second harness is a goal |
| AGENTS-13 | Remote runtime stack (macrod, sandboxes, egress, previews, realtime, warm, notifications) | skip | — | XL | low | `crates/harnesses/src/domain/service.rs` | — | revisit: owner reverses D3 |

### Candidate notes

- **AGENTS-1 (L)** — Fold rules from `claude_fold`: skip `isSidechain`, dedupe uuid, `message.model` → ModelChanged
  (ignore `<synthetic>`). Cerebro additions: group lines by `message.id` and end the turn **once** (2.1.250 repeats
  stop_reason on every block line); hide `isCompactSummary`/`isVisibleInTranscriptOnly`, render
  `system/compact_boundary` as a divider; `isApiErrorMessage` → Error; `isAbortedMidStream` or a file ending without a
  closing assistant line → interrupted; ignore `isMeta`, queue-operation, attachment, last-prompt, mode, atis-latch,
  unknown. Read `<session>/subagents` and `tool-results`, or say output is stored separately. Locate by session-id
  glob, not re-derived slug. Unavailable = `cleared | expired (30-day sweep) | not_recorded | unreadable`, never empty.
  Parity is content-only: JSONL has no `result`, but live bubble text is replaced by `result.result`
  (`useAgentChat.ts:246-257`), so restore derives final text. Live mode reads `system/init` (model, permissionMode,
  mcp_servers, claude_code_version). Mint `--session-id`. Unify the three write-tool lists; kill the false comment at
  `AiActionCard.tsx:54-57`. Parity via golden event files replayed by cargo test and vitest — no WASM.
- **AGENTS-8 (L)** — Thread run identity through every `vault::write` path (all 8 pass `shadow_write(..., None)`;
  actor always NULL). Paths = `vault_writes` rows for the run + fold Write/Edit paths; `create_note`/`write_concept`
  take the path from the result "Created {path}" (`mcp.rs:2653`). New `commit_paths`; flag `shared_with_user`; empty set
  → `Ok(None)`. Make commits single-flight and coordinate with `useAutoCheckpoint` (`useGit.ts:253-310`); checkpoint
  job-runner and `hand_to` runs too. Shell runs: git-status delta, labelled as possibly including the person's edits.
  Attribution is Cerebro-native — Macro diffs a PR without it.
- **AGENTS-4 (L)** — `ask` as a third ceiling value. Under `ask`, remove shell/file tools from `--allowedTools` (mode
  change alone leaves them pre-approved) and pass `--permission-prompt-tool` only on attended non-internal runs, gated
  on CLI version. Decision table in `shared/policy/` with goldens; default-deny rows for every built-in that can now
  reach the prompt (CronCreate, RemoteTrigger, PushNotification, WebFetch…). Host enables AskUserQuestion and
  ExitPlanMode: ship AGENTS-5 with it or deny them. Unattended → existing `capability_unavailable`/`agent.permission`
  routing (`dispatch.rs:971-990`). Migrate the boolean "Shell access" switch + storage (unknown → off) and update
  `e2e/agent.spec.ts:191-216`. Copy must not promise every command asks: user allow rules (201 on this machine) and
  hooks pre-empt it.
- **AGENTS-14** — Options: (a) PreToolUse `defer` → `tool_deferred` → `claude -p --resume` (no timeout; single-tool
  turns only, batched calls fall to the prompt tool and are denied); (b) `--input-format stream-json
  --permission-prompt-tool stdio`, which offers `can_use_tool` (pending indefinitely), `interrupt`, `set_model`,
  `set_permission_mode`, `initialize` (models + `supportedEffortLevels`) and a native mid-turn queue. Measure
  resumability, held slots, meter booking. Risk: the stdio wire is undocumented; the Agent SDK is the documented surface.
- **AGENTS-3** — If a held MCP call is kept: set per-server `timeout` (progress cannot extend the hard cap); retain the
  parked token against `RUN_TOKEN_WINDOW=16` eviction (`mcp.rs:186`, cf. `holds_open_question` 193-232); count the
  held run slot (`MAX_CONCURRENT_RUNS=4`). tiny_http `Request` is `Send` — moving it off-thread is supported. Answer path
  is a Tauri command, never an MCP tool. A typed `no_longer_waiting` from a human action needs a written reason at
  the call site.
- **AGENTS-5 (S)** — Model on AskUserQuestion's schema, not Macro's forms: 1–4 questions, 2–4 labelled options, header
  ≤12 chars, `multiSelect`; "Other" free text becomes the value. Validation = membership + selection count only. Answer
  via `updatedInput {questions, answers, response?}`; the CLI writes "The user answered…". Not available in subagents.
- **AGENTS-7 (M)** — Validate effort before spawn (CLI warns and ignores bad values, exit 0). Vocabulary is one shared
  artifact for TS and Rust `hand_to`. Effort support is per model (Haiku none); `-p` has no discovery. Show effective
  model from `system/init.model`/JSONL `message.model`, effective effort from JSONL `effort`; `runs.model_id` exists.
- **AGENTS-10** — Classify from typed fields first: assistant `error` enum (authentication_failed, rate_limit,
  billing_error, model_not_found, max_output_tokens…), `system/api_retry`, result subtype, `system/init`
  `mcp_servers[].status` for cerebro only. Unknown keeps raw text. No `budget_deferred`. Reuse `runtime/health.rs`
  three faces.
- **AGENTS-11** — TERM first (Bash-tool shells run `detached`, own groups; only the CLI reaps them), KILL group after
  grace. Injectable binary path (`find_binary`, `agent/mod.rs:374-382`). Fake `sh` CLI tests named outside the
  crash-wedge skip list; `cfg(unix)`.
- **AGENTS-6** — Entry freezes TurnContext at enqueue. Fixes the one-slot overwrite. If AGENTS-14 picks a long-lived
  process, use the CLI's queue + `interrupt`. Kill comments at `useAgentChat.ts:282-285`, `AiPanel.tsx:505-507`,
  `AiPanel.tsx:538-540`.
- **AGENTS-2** — Segment the tools list only (thinking dropped by decision, no ordered parts). Write
  `cli_session_id` from Tally/RunFacts at finish (`meter::begin` runs before the child). Sequence schema step with
  AGENTS-8 (current V18). Pre-row: "Transcript not recorded"; purged/expired: section-unavailable. Read-only, no composer.

## 7. Conflicts with Cerebro conventions

| Macro pattern | Cerebro rule | Resolution |
| --- | --- | --- |
| Postgres frame log shown as history | M17 D4 transcripts out of vault; two records, two destinies | Fold the CLI's JSONL on demand; localStorage stays as snapshot cache; any future Cerebro log goes in app-data under the M17.14 purge. |
| Run log extended to transcripts | M17.15 run log "not a transcript" | AGENTS-2 needs owner sign-off; distiller-loop rationale holds (nothing enters the vault). Note CLI's 30-day `cleanupPeriodDays` sweep. |
| `PermissionPolicy::Prompt` per runtime | M8.1 one ceiling, no per-chat modes | `ask` = third ceiling value; shared/policy table + goldens; argv denies stay; unattended never prompts. |
| Pending interactions pile up | M34 D6: one review queue; a second is a defect | In-turn prompts attended-only, die with the turn (Cancelled); anything outliving the turn uses the proposal queue. |
| Queue composes context at dispatch | M17.6 context frozen at send | Freeze at enqueue; compose only outgoing text at dispatch. |
| Fold shipped as WASM to the browser | shared/policy README: WASM deferred | Rust folds lines → events; TS reduces events → messages; shared goldens. |
| Notifications, chips | M8 nothing speaks first; M33b D7 | "Waiting for your answer" only in its own turn/composer. User Notification/Stop hooks riding `--setting-sources user` into unattended runs may speak first — decide in AGENTS-4. |
| Long-lived npm ACP adapter | M6 tiny_http, no Node, no async framework | Stay on CLI flags + loopback MCP (AGENTS-12 skip); stdio control protocol reachable without Node (AGENTS-14). |
| Mid-turn prompts queue | PR #5: Enter no-op so drafts never vanish | Real rule is "never silently drop"; visible queue honours it; delete the no-op and one-slot comments. |
| Human action returns typed `no_longer_waiting` | Store-layer invariant: human actions toast + null | Written reason at the call site, or toast it — pick per card. |
| Boolean "Shell access" e2e-asserted | e2e/agent.spec.ts:191-216 | Migrate value + test in the same commit. |

## 8. Verification notes (stage 3)

**Refuted**
- `healToolIds`/`healPlace` prove live/stored drift — no: they repair a pre-M15 duplicate-id bug and retired M12.5
  Place shapes (`conversations.ts:95-140`). The one-fold case rests on three readers.
- CLI workspace disclosure/purge "solid" — partial: per-session `subagents/`, `tool-results/`, `workflows/` uncounted
  and survive purge; slug drifts for >200-char paths (`agent/mod.rs:182-193, 227-289`).
- `vault_writes` records actor — no: every write passes `None` (`vault/write.rs:328…960`); actor column always NULL.
- One write-tool inventory — no: `WRITE_TOOLS` has NotebookEdit, `isWriteTool` doesn't, neither has MultiEdit,
  `runLog.ts` is a third list; MultiEdit-only turns skip rescan + checkpoint.
- AGENTS-4 keeps the e2e switch green — no: tri-state breaks the boolean control and storage.
- Watchdog counts human wait — no: attended runs have no watchdog (`meter.rs:326-328`).
- AGENTS-2 thought rules — no ordered parts; thinking dropped by decision.
- `budget_deferred` panel kind — attended chat is never gated; unattended deferrals already typed.

**Corrected / partial**
- `--permission-prompt-tool`: hidden, `{tool_name,input,tool_use_id}` → single text block JSON confirmed in bundle;
  auto-approved tools never reach it; it also enables AskUserQuestion/ExitPlanMode; MCP tools flagged
  `requiresUserInteraction` are denied; the prompt tool is removed from the model's list. No end-to-end run.
- Held-call timeouts: per-server `timeout` is a hard cap progress cannot extend; idle 300 s (http) / 1800 s (stdio);
  `timeout` raises both, so keepalive is unnecessary. `defer` and stdio `canUseTool` wait indefinitely.
- mcp.rs single thread confirmed (528-565); real costs are token eviction and a held run slot.
- Session JSONL (n=1): 79 lines, all 2.1.250/`sdk-cli`; `effort` + `message.model` on every assistant line; one block
  per line; final message's lines all carry `end_turn`; no `result`/usage/permission_denials. Kill-then-resume untested.
- AskUserQuestion: needs a permission host in `-p`; Cerebro has none, so it is unavailable, not "less urgent".
- Checkpoint sweep confirmed; worse: auto-checkpoint commits in-flight writes; only `AiPanel.tsx:265` calls
  `useAgentCheckpoint`.
- User hooks pre-empt prompts too (deny > defer > ask > allow).
- `--effort bogus` warns and exits 0 (ignored, not rejected); unknown flag exits 1. Oldest CLI untested.
- Stop/grandchildren: Bash-tool shells are detached in their own groups, so killpg alone misses them; TERM lets the CLI
  reap.
- Failures partially typed already (QuotaFailed, health backoff, GateReasons).
- "Pause and memory ride the token" overstated — `RunGrant` carries actor, run_id, scope, read_scope, tools, chain.
- ACP rationale: adapter wraps the Agent SDK which drives the same CLI; most wins reachable without Node; kill is
  weaker than `interrupt`.

**Confirmed**: runtime baseline (`agent/mod.rs:682-747`, cap 301/838-842); one-slot handoff overwrite; licences.

**Missed and added**: AGENTS-14 (control protocol spike), AGENTS-15 (purge gaps), AGENTS-16 (refused list), AGENTS-17
(all cerebro tools deferred behind ToolSearch, incl. `get_vault_context`; seen in an open-mode run, strict unverified),
AGENTS-18 (cache stability), user hooks + 201 allow rules (folded into AGENTS-4), `system/init` ignored (folded into
AGENTS-1). Quote-reply helper (`apps/web/src/features/block-agent/state/reply-selection.ts`): low value, no candidate.

**Still unverified**: kill-then-resume; hooks under `--settings` with `--setting-sources user`; HTTP first-byte budget
for a held response; strict-mode tool deferral; CLIs older than 2.1.250.

## 9. Where to read first

1. `crates/folds/claude_fold/src/lib.rs`
2. `crates/folds/agent_fold/src/domain/transcript.rs`
3. `crates/folds/agent_fold/src/domain/fold.rs` and `.../fold/state.rs`
4. `crates/folds/agent_fold/src/domain/model/metadata.rs`
5. `crates/folds/agent_fold/src/domain/test/real_recordings.rs`
6. `crates/claude_cloud_agents/src/domain/service.rs` (255-403)
7. `crates/agent_changes/src/domain/service.rs`
8. `docs/ACP_ELICITATION.md`
9. `crates/agent_session/src/domain/session/session.rs` and `.../control.rs`
10. `crates/agent_harness/src/domain/model.rs` (`resolve_permission_policy`)
11. `crates/agent_harness/src/domain/queue.rs`
12. `crates/agent_runtime_protocol/src/domain/turn.rs`
13. `apps/web/src/features/block-agent/state/tool-groups.ts`, `.../state/live-turn.ts`
14. `apps/web/src/features/changes/core/review-notes.ts`
15. `docs/AGENT_EFFORT.md`
16. `crates/coding_agent_worker/src/outbound/acp_process.rs` (then upstream SDK `acp_agent.rs`)
