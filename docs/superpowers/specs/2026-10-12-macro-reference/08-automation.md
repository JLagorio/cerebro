# Macro reference — Automation: triggers, routines, scheduled actions, reminders, bots, webhooks, event backbone

**Date:** 2026-10-12 · **Source:** `docs/examples/macro-main/` (vendored, gitignored). All Macro paths below are relative to it; Cerebro paths start `src/`, `src-tauri/`, `shared/`, `e2e/` or `docs/`.
**Owner's rule (2026-10-12):** Cerebro builds its own version, with Macro's code as the guide, never a 1:1 copy. Modes: rebuild (fidelity mirror / adapt / inspire), adopt-upstream, reuse-permissive, skip.
**Licences:** root `LICENSE.txt` AGPL-3.0 covers every crate, service, `services/bots/*` (private packages) and `packages/lexical-core`. `apps/web/LICENSE` is "All rights reserved" (routines/reminders UI, query wrappers): even framework-free TS there (zod schemas, cron mapping, presets) is behaviour reference only, clean-room. `apps/docs/LICENSE` is Mintlify's MIT scaffold, not a grant over Macro's prose. Write new tool text and prompts; do not paraphrase.
**Evidence:** stages 1–2 read code; stage 3 re-read both trees and ran HEAD and working-tree copies of `src/engine/jobs.ts` under tsx. No `cargo test` (crash-test wedge). Macro was read, never run. Stage 3 overrides stages 1–2.
**Baseline:** branch `m49-knowledge-integrity`. Another session is editing the working tree (AUTOMATION-2/2b in flight); HEAD line numbers are stable, WT line numbers may drift.

---

## 1. What it is

- Six proactivity routes: **agent_trigger** (mention / follow-up / task assignment → agent session), **routines** (`services/scheduled_action`: cron | events | multiple, durable event-run queue, condition gate), **TriggerContext** (typed "why" on every invocation), **reminders** (email snooze only), **bots** (owned bots, hashed tokens, inbound channel webhooks), **outbound webhooks** (signed HTTPS + SSE).
- Backbone: 24 Kafka topics with a typed, versioned envelope; 29 SQS queues; SNS push; Lambda; EventBridge → ECS. Publish is at-most-once (6 s timeout, no outbox); consumers commit only after durable handling.
- For Cerebro the value is the **semantics** (dedup keys, fenced claims, terminal outcomes, activation boundary, condition gate, typed cause), not the transport.

## 2. What users get

| Feature | UX details / shortcuts | Read |
| --- | --- | --- |
| Routines (Agents → Routines) | Row status: Running (claim < 20 min, mirrors `MAX_ACTION_TIME` via `core/claim.ts`), Completed (schedule-only, no next run), else Active/Paused. Trigger search parses "every day at 9am", "weekdays", weekday names, "hourly". Presets Hourly/Daily/Weekly/Monthly/Once/Custom (cron); IANA tz per schedule. Activity events grouped Channels/Documents/Tasks/Email; scope "Any X I can access", specific items (≤100) or "Your inbox". Optional yes/no condition (≤500 chars), per-kind placeholder ("Is this email an invoice or a receipt?"). Target = model, or agent + optional model override. Detail autosaves (300 ms debounce, serialized, retryable; untouched trigger/cron left as stored). Run now split button (+ Disable/Enable, Copy prompt); Duplicate. History Running/Succeeded/Failed/Skipped + duration; a row opens the transcript in a split, shift-click = new split. Composer draft in localStorage 3 min. Hotkey focuses routine search. | `apps/web/src/features/routines/routines-page.tsx`, `apps/web/src/features/routines/core/schedule-language.ts`, `apps/web/src/features/routines/core/routine-triggers.ts`, `apps/web/src/features/routines/views/routine-history.tsx`, `apps/web/src/features/routines/components/routine-run-button.tsx`, `apps/web/src/features/routines/primitives/routine-autosave.ts`, `apps/docs/product/agents.mdx` |
| Agent self-scheduling (MCP) | `CreateRoutine{name, instructions, target model\|agent, schedule once(RFC3339 future)\|cron(6-field, IANA tz)}` → id + next firing. `ListRoutines` (≤50 + total, filtered client-side), `ReadRoutine` (+ ≤50 runs), `UpdateRoutine` = exactly one of `{enabled}` or full `{configuration}`. 409 → "running or changed, read again". Tool text forbids reminders-for-work and re-creating per run. MCP writes cron only; event triggers are UI-only. | `crates/routines/src/inbound.rs`, `crates/routines/src/domain.rs`, `crates/routines/src/outbound.rs`, `apps/docs/AI/mcp/tools/create-routine.mdx`, `services/bots/ROUTINES.md` |
| @mention agents | Channel, doc comment, project/CRM comment, call chat. Availability: system agents everywhere; all-channel agents for owner/team; selected-channel agents where they participate. Follow-up reaches the agent by mention, quote-reply, or a fast-model judge when exactly one session is live (radius 4, cap 40, images captioned). Bots never trigger implicitly; own messages dropped. | `crates/agent_trigger/src/domain/service.rs`, `crates/agent_trigger/src/domain/yield_event.rs`, `crates/agent_trigger/src/domain/thread_window.rs`, `crates/agent_trigger/src/outbound/fast_model_judge.rs` |
| Assign task to agent | Adding a bot to Assignees starts a session; silent "Working on this task…" root posted as the bot. Prompt: read the task (+ project via ReadInitiative), update description/status, report in the session. Project named only if the assigner can view it. Moving a task into a project **writes** the project's agents into Assignees. | `crates/agent_trigger/src/domain/task_assignment.rs`, `crates/agent_trigger/src/domain/task_assignment/prompt.md`, `crates/agent_trigger/src/domain/project_assignment.rs` |
| Email reminders (snooze) | Open with **H**, "Remind me" or the bell. Presets: In 30m (elapsed), Later today 17:00 (if future), Tomorrow 9:00, Next week Mon 9:00. Typed times via date search; past times and DST gaps rejected. If no reply (default) / Regardless. One active per user+thread. List advances only after server confirm; **Cmd/Ctrl+Z** undo guarded by `expectedRevision`. Push "Reminder: <subject>". Retry keeps the same operationId. Row clocks tick every 30 s; queries refetch every 30 s. | `docs/AGENT_GUIDE/reminders.md`, `apps/web/src/features/reminders/reminder-schedule.ts`, `apps/web/src/features/reminders/primitives/create-reminder-time-options.ts`, `crates/reminders/src/domain/email_followup.rs` |
| Custom bots + channel webhooks | Handle `[a-z0-9-_]` ≤64. `hasAgent` makes mentions open sessions. Tokens: label, expiry, secret shown once; `IssueBotCredential` only proposes, the user mints from the chat card. Webhook POST `{content}` or raw text with `x-macro-bot-token` (+`x-macro-bot-scope: user`) or legacy header; post attributed Unprompted. | `crates/bots/src/inbound/channel_webhook_router.rs`, `crates/bots/src/domain/tokens.rs`, `crates/bot_token/src/lib.rs`, `apps/docs/AI/mcp/tools/create-bot.mdx` |
| Example integration bots | Stripe (signature verified, broadcast to every bot channel, duplicates knowingly accepted) and Statuspage (secret in URL path). Unknown payload → 200 `{ignored:true}`; downstream failure → 502 so upstream retries. | `services/bots/stripe-payment-bot/src/worker.ts`, `services/bots/anthropic-status-bot/src/index.ts` |
| Outbound webhooks + SSE | `POST/PATCH/DELETE /webhooks`, `POST /webhooks/{id}/validate` (10/h). Filters `{events, ids?}` must match within one filter. Custom headers can't override `X-Macro-*`. HTTPS only, 5 s timeout, no redirects, private/loopback IPs blocked. `GET /events/stream` SSE, 20 s keep-alive, best-effort. | `crates/webhook/README.md`, `crates/webhook/src/outbound/http_validator.rs`, `crates/webhook/src/inbound/stream_router.rs` |
| Classic @macro reply | "Macro is thinking…" placeholder edited in place. Inferred triggers only in threads already holding a Macro message. Context: 8 prior messages, anchor text, time in the user's calendar tz. | `crates/channel_bots/src/domain/trigger_detector.rs`, `crates/channel_bots/src/outbound/agent_loop_responder.rs` |
| Live run status | WS `scheduled_action_update {started\|stopped, action_id, resource}`. Started → patch claimed + synthetic pending history row; stopped → drop it, refetch. Gateway failure never fails a run. | `services/scheduled_action/src/outbound/conn_gateway_live_updates.rs`, `apps/web/src/features/routines/queries/sync.ts` |

## 3. How it's built

**Architecture.** Hexagonal Rust (domain = models + ports; outbound = Postgres/Kafka/SQS/HTTP; inbound = axum, GraphQL, AI tools, Kafka consumers) composed by services; SolidJS front end over HTTP + connection-gateway websocket.

- **Producers:** `agent_trigger` (event → `agent_trigger.new/existing` on `macro.agent_sessions`, keyed by `bot_id`) and `scheduled_action` (cron poller + event intake → durable run queue → executor → agent_session routine HTTP port). Both attach `TriggerContext`; `packages/lexical-core/utils/agent-context.ts` renders it as an `<m-agent-context>` XML preamble.
- **Reminders:** sweep/deliver dispatcher in document_storage_service, EventBridge → SQS.
- **Bots/webhooks:** `crates/bots` (served by DSS); `crates/webhook` fans Kafka out via SQS FIFO to signed HTTPS.
- **Single-process shape already exists:** `TokioDispatcher` (per-action sleep futures, generation counters); `channel_bots` consumes an mpsc of committed posts.

| Unit | Path | Role | LOC |
| --- | --- | --- | --- |
| agent_trigger | `crates/agent_trigger` | Which agent a post/assignment calls; builds event + TriggerContext. `evaluate`, `yield_event`, `NoEventReason`, `thread_window`, `render_transcript`, `FastModelTriggerJudge`, `TaskAssignment::from_update`. | 4283 |
| agent_trigger_service | `services/agent_trigger_service` | Kafka group `agent-trigger-service` (Latest) on `macro.messages` + `macro.properties`; sync commit after processing; commit-and-drop undecodable; exit on error. | 442 |
| trigger_context | `crates/trigger_context` | Plain serde "why": `Mentioned \| FollowUp{addressed_by} \| TaskAssigned \| Requested \| Dispatched \| Routine{triggers, firing}`. Untrusted; grants nothing. | 519 |
| scheduled_action | `services/scheduled_action` | Routine CRUD, cron dispatch (`PgPollingDispatcher`, `TokioDispatcher`), event intake (`IncomingEvent::normalize`, `EventAdmissionService`), `ConditionGate`, `InProcessExecutor`, `TargetRunner`, `claim_action`, `ConfigurationRevision`, `ClaimToken`. Event-run core ≈1.7k (event_runs 455, admission 92, condition 153, dispatch 206, pg_event_run_repo 648, worker 122). | 8545 (8108 non-test) |
| routines | `crates/routines` | MCP tools over the HTTP API; Once → 7-field UTC cron with year. | 594 |
| graphql_scheduled_action | `crates/graphql_scheduled_action` | GraphQL read adapter. | 333 |
| reminders | `crates/reminders` | Email follow-up workflow; `ReminderDispatchService::sweep/deliver`, `claim_occurrence/release/complete`, `Clock` port, SQS adapter. | 2685 |
| bots / bot_id / bot_token | `crates/bots`, `crates/bot_id`, `crates/bot_token` | Registry, token mint/auth, channel membership, webhook ingress; compile-time `SYSTEM_BOTS`; SHA-256 + display prefix. | 6686 / 573 / 70 |
| channel_bots | `crates/channel_bots` | In-process @macro reply loop over an mpsc. | 1560 |
| webhook / webhook_signature | `crates/webhook`, `crates/webhook_signature` | Fan-out, delivery with retry table, SSE; `v1=HMAC-SHA256("{ts}.{body}")`, constant-time, empty secret fails closed. | 6020 / 61 |
| macro_event_broker / macro_event_topics | `crates/macro_event_broker`, `crates/macro_event_topics` | Envelope, `TopicEvent::SCHEMA_VERSION`, `declare_topics!`, ports, Noop broker; sealed `Topic` + 24-topic catalog. | 876 / 105 |
| transport | `crates/kafka_util`, `crates/macro_queues`, `crates/sqs_client`, `crates/sqs_worker`, `crates/sns_client`, `crates/lambda_client`, `services/worker_trigger`, `infra/stacks/agent-schedule-service` | rdkafka/MSK IAM, 29 queues, SQS/SNS/Lambda wrappers, EventBridge→ECS, Pulumi. | 534 / 659 / 1861 / 109 / 458 / 62 / 194 / 486 |
| example bots | `services/bots` | Cloudflare Workers via the Macro SDK. | 806 |
| routines UI / reminders UI | `apps/web/src/features/routines`, `apps/web/src/features/reminders` | SolidJS; `parseRecurringSchedule`, `serializeTriggers`, `onceFromCron`, `isClaimActive`, `reminderQuickPresets`, `formatReminderOccurrence`. | 5119 / 722 |
| agent-context renderer | `packages/lexical-core/utils/agent-context.ts` | TriggerContext + owner/prompter policy → `<m-agent-context>`; `escapeAgentContextTags`. | 1351 |

**Data model.**

| Entity | Store | Key fields | Path |
| --- | --- | --- | --- |
| `scheduled_action` | Postgres | owner; name; `trigger_type cron\|events\|multiple`; schedule + timezone; `event_filters` JSONB `[{events[], ids?, condition?}]` (1–32, GIN); `trigger_config` (1–16 groups); task JSONB `{model?, agent?, prompt}`; enabled; `configuration_revision` (config changes only); `event_activated_at`; `claimed` + `claim_token`; `next_run_at`. CHECKs enforce shape. | `crates/macro_db_client/migrations/20260416135258_scheduled_agent.up.sql`, `…/20260922181603_add_scheduled_action_event_triggers.sql`, `…/20261004052752_routine_trigger_configuration.sql`, `services/scheduled_action/src/domain/models.rs` |
| `action_execution_record` | Postgres | action_id FK; resource_id; start/end; is_success; `result` = `ExecutionResult{version:1, resource{chat\|agent,id}, error?, condition? not_met{probability}\|unavailable}`. | same + `models.rs` |
| `scheduled_action_event_run` | Postgres | **PK (action_id, event_id)**; configuration_revision; `event_context` (event_name, entity_id, message_id — never content); admission_order; state `pending\|started\|finished`; claim_token; deadline; outcome `succeeded\|failed\|cancelled{reason}\|interrupted`. One started per action (partial unique index). Finished rows = dedup tombstones. | `crates/macro_db_client/migrations/20260922182949_add_scheduled_action_event_runs.sql`, `services/scheduled_action/src/domain/event_runs.rs` |
| `reminder` / `reminder_occurrence` | Postgres | reminder: `remind_at` XOR (cron + tz); next_run_at; optional entity. occurrence: **UNIQUE (reminder_id, scheduled_for)** — the insert is the claim. | `crates/macro_db_client/migrations/20260729145833_create_reminders_tables.sql` |
| `reminder_email_followup` / `reminder_email_operation` | Postgres | state `archiving\|pending\|returning\|returned\|cancelled\|removed`; operation PK (user_id, operation_id), kept as tombstones. | `crates/macro_db_client/migrations/20261001151559_email_followups.sql` |
| `bots` / `bot_tokens` / `agent_configs` | Postgres | token_hash BYTEA UNIQUE (SHA-256), prefix, expires/revoked; agent instructions, harness, default_model, channel_scope. Channel access = participant row `bot\|<uuid>`. | `crates/macro_db_client/migrations/20260527160000_channel_bots.sql`, `…/20260822144719_hash_bot_tokens.sql`, `…/20260827174457_persist_agent_configs.sql` |
| `webhook` / `webhook_delivery` / `…_attempt` | Postgres | delivery UNIQUE (webhook_id, event_id); attempt UNIQUE (delivery_id, attempt_number); redacted headers, body preview ≤4096. Signing secret plaintext. | `crates/macro_db_client/migrations/20260629135403_webhooks_core_schema.sql` |
| Event envelope | Kafka | `{event_id UUIDv7, schema_version u8, event_type, metadata}`; key = partition (e.g. bot_id). | `crates/macro_event_broker/src/domain/models.rs` |
| Agent-session trigger events | Kafka | `agent_trigger.new{source, bot_id, message\|prompt, context?}`, `agent_trigger.existing{session_id, kind mention_thread\|explicit_reply\|inferred}`; v1, unknown variants skipped. | `crates/agent_trigger/src/domain/broker_events.rs` |

**Key flows.**

1. **Mention → session.** Post commits → `message.posted` → consumer re-mints the poster's write capability → per mentioned bot: availability → `yield_event` (own message → NoEvent; Open or Existing) → per-message session dedup → read thread (≤50, root kept) + 10 prior messages under poster's access → `TriggerContext::Mentioned/FollowUp` (read failure → publish without context) → send keyed by bot_id, awaited → sync commit.
2. **Implicit follow-up.** Unmentioned user thread reply → candidates = live sessions in thread → explicit reply target → `ExplicitReply` (no LLM); else exactly one candidate → windowed transcript → judge `{addressed_to_agent, reason}`. >1 candidate → `AmbiguousAgentSessions`. Errors = "no".
3. **Task assignment.** Assignees diff → per added bot authorize (assigner must be a user who can write, `task_assignment.rs:83-108`) → `discussion_id` = UUIDv7(event ts) + SHA-256(event_id, bot_id) bits (replay-stable) → skip if session exists → silent root → publish `AssignedToTask`. Project move → inherit agents atomically into Assignees → loops into this flow.
4. **Cron/once run.** Create validates flags + target → `next_run_at` (`NoFutureFirings`) → poller pulls 10 due rows (≤ once / 30 s) → `claim_action` UPDATE fenced on revision + expected `next_run_at` + stale claim, new token → prepare → Started → `TargetRunner` (`RoutineContext Scheduled\|Manual`, `SCHEDULED_GUIDANCE`) → poll status inside the 20-min deadline → record → `next_run_at` after now (missed firings coalesce) → release on token match → Stopped. **Never retried.** A manual run started once due **consumes that firing** (`execution.rs:236-245`); a live run → 409 AlreadyRunning (`axum_router.rs:561-563`).
5. **Event run.** Consumer → `normalize` (schema v1, verifiable UUIDv7, 13-name allowlist, human non-delegated actor) → keyset candidates via JSONPath + activation boundary → audience + owner access → `INSERT … ON CONFLICT DO NOTHING` under the action row lock → commit (or retry 5× at 1/2/4/8 s, then exit uncommitted; supervisor restarts after 5 s). Worker every 1 s: reconcile (expired started → interrupted; pending cancelled only on Disabled or Superseded revision/filters) → oldest pending per idle action (concurrency 2) → reload config → condition gate (one classifier call, p ≥ 0.5; transient retry until admitted_at + 10 min → skipped unavailable) → claim → execute with `RoutineFiring::Event` → finalize in one tx. **One run per (action, event); no batching; no time expiry.**
6. **Reminder.** `PUT` with operationId + expectedRevision → lock (user, thread) → idempotent replay → archive → pending. Minutely sweep → `Deliver{reminder_id, scheduled_for}` in batches of 10 + reconcile reply-cancel → deliver re-reads (Gone if changed) → `claim_occurrence` (ON CONFLICT DO UPDATE WHERE unsent and > 5 min old) → notify → complete; notify failure releases; DLQ after 5.
7. **Inbound webhook.** Worker verifies upstream → POST `/channels/{id}/webhook` → dual headers rejected → SHA-256 lookup, not revoked/expired → mark used → channel participant check → post Unprompted.
8. **Outbound webhook.** Access audience → workspaces → matching webhooks → SQS FIFO (group webhook_id, dedup `webhook_id:event_id`) → prepare delivery (UNIQUE) → reload (paused → cancel) → signed POST → 2xx delivered; 408/429/5xx/network retry at 30/60/120/300 s; other → permanent; 5 attempts → exhausted.

## 4. Ideas worth stealing (ranked)

1. **Typed cause on every invocation, rendered as a preamble, linked from history.** The agent knows mention vs follow-up (and how), assignment, manual, schedule (`scheduled_for`) or event + passed conditions. Only runtimes may supply it (`crates/agent_session/src/domain/control.rs:20-38`: a User with context → Forbidden). Read `crates/trigger_context/src/lib.rs`, `packages/lexical-core/utils/agent-context.ts`, `services/scheduled_action/src/domain/target_runner.rs`.
2. **Durable admission keyed by a natural pair; ack the source only after admission; tombstones.** At-least-once intake → effectively-once runs. Read `crates/macro_db_client/migrations/20260922182949_add_scheduled_action_event_runs.sql`, `services/scheduled_action/src/domain/event_runs/admission.rs`, `services/scheduled_action/src/outbound/pg_event_run_repo.rs`.
3. **Single flight per routine.** Partial unique index (one started run per action) + 409. Cerebro has no per-agent equivalent. Read the migration above (`:41-42`), `services/scheduled_action/src/outbound/pg_scheduled_action_repo.rs:392-413`.
4. **Never retry execution; closed terminal outcomes; expired started → interrupted, never pending.** Read `services/scheduled_action/src/domain/execution.rs`, `services/scheduled_action/src/outbound/pg_event_run_repo.rs:571-629`.
5. **Revision-fenced claims and Superseded.** `configuration_revision` ≠ `updated_at`; claim fenced on revision + expected `next_run_at`; release only on token match; 20-min lease; a config change cancels pending runs as Superseded. Read `services/scheduled_action/src/outbound/pg_scheduled_action_repo.rs`, `services/scheduled_action/src/domain/event_runs/dispatch.rs:115-127`.
6. **Loop prevention by attribution + activation boundary.** Bot/delegated actors never fire routines; only events after activation (UUIDv7 time). Note `document_actor` admits an actorless document event with a fallback user — not strictly fail-closed. Read `services/scheduled_action/src/domain/event_trigger.rs:569-588`.
7. **Manual run consumes the due firing and refuses while running.** Read `services/scheduled_action/src/domain/execution.rs:236-245`, `services/scheduled_action/src/inbound/axum_router.rs:561-563`.
8. **Cheap pre-run condition gate with the skip recorded.** Read `services/scheduled_action/src/domain/event_runs/condition.rs`, `services/scheduled_action/src/domain/event_runs/dispatch.rs`.
9. **Assignment as a trigger, replay-stable ids, project inheritance persisted into the field.** Read `crates/agent_trigger/src/domain/task_assignment.rs`, `crates/agent_trigger/src/domain/project_assignment.rs`.
10. **Occurrence claim for reminders** (claim → notify → complete; release on failure; 5-min crash net; re-read before firing). Read `crates/reminders/src/domain/service/dispatch.rs`, `crates/reminders/src/outbound/pg_reminders_repo.rs`.
11. **Self-scheduling with anti-replication text** ("already triggered; do not schedule it again", "ListRoutines before create"). Read `crates/routines/src/inbound.rs`, `services/scheduled_action/src/domain/target_runner.rs`.
12. **Schedule editor round-trip rule:** show a preset only if it re-serializes to the exact stored value; bounded phrase parser. Read `apps/web/src/features/routines/queries/routine-trigger-mapping.ts`, `apps/web/src/features/routines/core/schedule-language.ts` (behaviour only).
13. **Idempotent commands:** operationId stored with the request (same id + different data → conflict) + `expectedRevision` for undo. Read `crates/reminders/src/domain/email_followup.rs`.
14. **Versioned envelope; unknown variants skipped; UUIDv7 doubles as timestamp.** Read `crates/macro_event_broker/src/domain/models.rs`.
15. **Hash-only tokens shown once; HMAC `v1=ts.body`; ack unknown with 2xx; 502 to force upstream retry.** Read `crates/bot_token/src/lib.rs`, `crates/bots/src/domain/tokens.rs`, `crates/webhook_signature/src/lib.rs`, `services/bots/anthropic-status-bot/src/index.ts`.
16. **System agents as compile-time constants.** Read `crates/bot_id/src/lib.rs`.

## 5. Cerebro today vs Macro

| Macro feature | Cerebro status | Value | Note |
| --- | --- | --- | --- |
| Routines (schedule/event prompts, pause, history) | already-better | low | Agent records (`schedule:`, `when:`, `paused:`, scope, tools, connectors); born paused (M36.2); budget-gated (`dispatch::claim`); grants enforced in Rust; late runs say late. Gaps below. |
| Schedule shapes: once, monthly, cron, IANA tz, multi-group, derived Completed | partial | medium | 4 shapes (`src/engine/skills.ts`), machine clock, one schedule. No activation boundary: resume at 14:00 with `daily 09:00` runs at once; edit 09:00→10:00 re-fires (C8, tsx-confirmed). |
| Separate key space for cron vs event runs | **defect at HEAD** | high | Schedule and event runs share `skillRuns[recordIdentity]` → schedule re-fires; under a gate deferral the two jobs alternate every ~4 s (C1). Fix in flight (AUTOMATION-2). |
| Durable event admission, tombstones, terminal outcomes | partial | high | One-slot renderer list replaced by any non-empty diff (a run's own writes do it, so human edits during runs are lost); first match only; first scan eventless; deferred event run never retried though `runLog.ts:44-47` says it is (C2). |
| Human-attributed events only | absent | high | `vault_writes.actor` always NULL, no `run_id` (C3); shell-native writes leave no row (C10). Loops bounded only by 15-min cooldown + day budget. |
| TriggerContext + history links | partial | high | Prose "You were woken because…" (`src/lib/prompts.ts`); why lives only in the device-local run log; `runs` has no cause. |
| Single flight per routine | absent | medium | Only global AmbientBusy (`budget.rs:771-773`, default 1); attended @agent turns and `hand_to` children overlap ambient runs of the same agent. |
| Pause semantics | defect | medium | Runtime per-agent pause refused in `run_agent` before the claim (`lib.rs:1331`); runner keeps the fire key and logs "could not read <path>". Three unnamed pause axes (frontmatter, runtime `AgentRoster.tsx:366`, global). |
| Condition gate pre-run | partial | medium | `ask:` answered inside a full run (M17.12); a "no" costs a full run. |
| Run now | absent | medium | Only attended panel addressing. |
| Self-scheduling MCP tools | absent | medium | PR #17 refuses run writes to `type: Agent` records. |
| Assign task to agent | absent | high | `when:` field+to is equality; no UI path targets Agent in a field (C9); project inheritance **not** covered by `when: moved`. |
| Per-target model | absent | medium | Runner passes `model: null`; Agent records carry no `model:`. |
| Reminders with occurrence claims | partial | medium | Date-chip `remind:`; localStorage fired set (cap 500) keyed by line index; >24 h missed dropped silently; no notification plugin, yet `DatePicker.tsx:371` promises desktop notifications (C5 unverified). |
| Live run status push | partial | low | RunList live; FleetSection / AgentsPage load once per filter; handoff runs never enter the renderer registry. |
| Never-retry, fenced claims, lease | already-better (claims) / partial (concurrency) | low | One-tx claim, `abandoned_usage_unknown`, owner-only held states; see single flight. |
| Agent-to-agent Dispatched | already-better | low | `hand_to`: 2 hops, cycle, paused callee, root ceiling. Macro defines Dispatched; nothing produces it. |
| Agent memory (`recent`) | broken | high | Not Macro-derived. Every run is told to patch `recent` (`prompts.ts:489`); PR #17 refuses it (C4). |
| Bots, tokens, inbound/outbound webhooks, Kafka/SQS backbone | different-by-design | low | Single user, G8 loopback, no HTTP client, R14 empty. Token-hash pattern has a planned consumer (MCP-5/M62.5). |
| Always-on while app closed | different-by-design | low | D3 app-lifetime; R10 cannot fire (`catchup::declare` has no caller). |
| @mention in channels, follow-up judge, @macro, email snooze, completion notifications | different-by-design | low | One conversation surface (M33b.6); background runs must not speak (M8). |

## 6. Port candidates

| id | title | mode | fidelity | effort | value | Macro guide (read first) | Cerebro target | depends |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| AUTOMATION-2 | Hotfix: event runs stop sharing the schedule's ledger slot — **IN PROGRESS (WT, uncommitted)** | rebuild | inspire | S | high | `crates/macro_db_client/migrations/20260922182949_add_scheduled_action_event_runs.sql`, `services/scheduled_action/src/domain/event_runs.rs` | `src/engine/jobs.ts`, `src/agent/useJobRunner.ts`, `src/engine/runLog.ts` + tests | — |
| AUTOMATION-2b | Hotfix: cross-vault event storm on vault switch — **IN PROGRESS** | rebuild | inspire | S | high | — (Cerebro defect) | `src/engine/events.ts`, `src/stores/vaultStore.ts` | — |
| AUTOMATION-14 | Agent memory write path (`recent`) | rebuild | inspire | S | high | — (agents overlap) | `src-tauri/src/mcp.rs`, `src/lib/prompts.ts`, `src/engine/agents.ts` | owner call (D7/M56.10 is a recommendation) |
| AUTOMATION-17 | Runtime pause defers instead of eating the fire | rebuild | inspire | S | medium | `services/scheduled_action/src/domain/execution.rs` | `src-tauri/src/lib.rs`, `src/agent/useJobRunner.ts`, `src-tauri/src/runtime/settings.rs` | — |
| AUTOMATION-1 | Typed run cause on every run | rebuild | adapt | M | high | `crates/trigger_context/src/lib.rs`, `services/scheduled_action/src/domain/target_runner.rs`, `services/scheduled_action/src/domain/models.rs`, `packages/lexical-core/utils/agent-context.ts:1295-1351` | `src-tauri/src/runtime/{schema,dispatch,fleet}.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/agent/mod.rs`, `src/lib/prompts.ts`, `src/status/FleetSection.tsx`, `src/pages/AgentsPage.tsx`, `src/lib/mockIpc.ts`, `src/agent/mockAgent.ts` | DOMAIN:agents |
| AUTOMATION-16 | Content hash on Entry (kill phantom `changed`) | rebuild | inspire | S–M | medium | — (Cerebro defect) | `src/engine/events.ts`, `src/engine/types.ts`, scanner | — |
| AUTOMATION-3 | Durable wake queue for event triggers | rebuild | adapt | L | high | `services/scheduled_action/src/domain/event_runs.rs`, `…/event_runs/admission.rs`, `…/outbound/pg_event_run_repo.rs`, `…/inbound/event_run_worker.rs`, `…/event_runs/dispatch.rs`, `…/domain/event_trigger.rs` | `src-tauri/src/runtime/wakes.rs`, `src-tauri/src/runtime/{schema,recovery}.rs`, `src-tauri/src/lib.rs`, `src/lib/{ipc,mockIpc}.ts`, `src/engine/jobs.ts`, `src/agent/useJobRunner.ts`, `src/lib/prompts.ts`, `src/pages/AgentsPage.tsx` | AUTOMATION-1, -2, -16 |
| AUTOMATION-4 | Write attribution + agent-authored wakes as chain hops | rebuild | adapt | **L** | high | `services/scheduled_action/src/domain/event_trigger.rs`, `crates/agent_trigger/src/domain/yield_event.rs`, `crates/agent_trigger/src/domain/service.rs` | `src-tauri/src/vault/write.rs`, `src-tauri/src/runtime/{vault_writes,schema,wakes,dispatch}.rs`, `src-tauri/src/mcp.rs`, `src-tauri/src/lib.rs` | AUTOMATION-3 |
| AUTOMATION-6 | Run now (manual unattended run) | rebuild | adapt | **M** | medium | `services/scheduled_action/src/domain/execution.rs:236-245`, `services/scheduled_action/src/inbound/axum_router.rs:561-563`, `apps/web/src/features/routines/components/routine-run-button.tsx` (behaviour only) | `src/pages/AgentsPage.tsx`, `src/agent/startAgentJob.ts`, `src/agent/useJobRunner.ts`, `src/lib/prompts.ts` | AUTOMATION-1 |
| AUTOMATION-5 | Assignment trigger (`when: {event: assigned, field}`) | rebuild | adapt | M (hand-authored `target: Agent`) / L (with UI path) | high | `crates/agent_trigger/src/domain/task_assignment.rs`, `…/task_assignment/prompt.md`, `…/project_assignment.rs`, `crates/trigger_context/src/lib.rs` | `src/engine/triggers.ts`, `src/engine/jobs.ts`, `src/lib/prompts.ts`, `src/library/AgentEditor.tsx`, `e2e/agent.spec.ts` (+ `AddPropertyPanel.tsx` for L) | AUTOMATION-3, -4, DOMAIN:data |
| AUTOMATION-7 | Grow schedule grammar + activation boundary | rebuild | inspire | M | medium | `apps/web/src/features/routines/core/schedule-language.ts`, `…/core/routine-triggers.ts`, `…/queries/routine-trigger-mapping.ts`, `crates/routines/src/domain.rs`, `…/primitives/routines-list.ts` | `src/engine/skills.ts`, `src/library/ScheduleField.tsx`, `src/library/AgentDossier.tsx`, `src/engine/jobs.ts`, `src/pages/AgentsPage.tsx` | AUTOMATION-2 |
| AUTOMATION-15 | Per-agent `model:` | rebuild | adapt | S | medium | `crates/routines/src/domain.rs` (RoutineTarget) | `src/engine/agents.ts`, `src/agent/useJobRunner.ts`, `src-tauri/src/agent/mod.rs` | — |
| AUTOMATION-8 | Durable reminders (occurrence claims, stable identity, missed-while-closed said) | rebuild | adapt | M | medium | `crates/reminders/src/domain/service/dispatch.rs`, `crates/reminders/src/outbound/pg_reminders_repo.rs`, `crates/macro_db_client/migrations/20260729145833_create_reminders_tables.sql` | `src/engine/reminders.ts`, `src/hooks/useReminders.ts`, `src-tauri/src/runtime/{job_ledger,schema}.rs`, `src/lib/mockIpc.ts`, `src-tauri/Cargo.toml`, `src-tauri/capabilities/default.json`, `package.json` | DOMAIN:client-desktop (D12/M64.5 Tauri bump) |
| AUTOMATION-9 | Pre-run `ask:` condition gate with recorded skips | rebuild | adapt | M | medium | `services/scheduled_action/src/domain/event_runs/condition.rs`, `…/event_runs/dispatch.rs`, `…/domain/models.rs` | `src-tauri/src/agent/condition.rs`, `src-tauri/src/mcp.rs`, `src-tauri/src/ingest/spawn.rs`, `src-tauri/src/runtime/wakes.rs`, `src/engine/triggers.ts`, `src/pages/AgentsPage.tsx` | AUTOMATION-1, -3, DOMAIN:ai |
| AUTOMATION-10 | Agent self follow-ups (`schedule_followup`) | rebuild | adapt | M | medium | `crates/routines/src/inbound.rs`, `crates/routines/src/domain.rs`, `services/scheduled_action/src/domain/target_runner.rs` | `src-tauri/src/mcp.rs`, `src-tauri/src/runtime/{followups,schema}.rs`, `src/engine/tools.ts`, `src/agent/{mockAgent,useJobRunner}.ts`, `src/lib/mockIpc.ts`, `src/engine/jobs.ts`, `src/pages/AgentsPage.tsx` | AUTOMATION-1, DOMAIN:mcp |
| AUTOMATION-11 | Skip: webhooks, bots, integration bots, event-bus backbone | skip | — | S | low | `crates/bot_token/src/lib.rs`, `crates/bots/src/domain/tokens.rs` (for MCP-5/M62.5 personal tokens), `crates/webhook_signature/src/lib.rs` (future R14 only) | none | — |
| AUTOMATION-12 | Skip: always-on execution while app closed | skip | — | S | low | `services/scheduled_action/src/outbound/tokio_dispatcher.rs` | none (optional prereq: `src-tauri/src/runtime/catchup.rs` callers) | R10 firing |
| AUTOMATION-13 | Skip: channel @mention, follow-up judge, @macro, email snooze, completion notifications | skip | — | S | low | — | none | — |

**Suggested order:** AUTOMATION-2 + 2b (in flight) → AUTOMATION-17 → AUTOMATION-14 → AUTOMATION-1 → AUTOMATION-16 → AUTOMATION-3 → AUTOMATION-4 → AUTOMATION-6 → AUTOMATION-5 → AUTOMATION-7 → AUTOMATION-15 → AUTOMATION-8 → AUTOMATION-9 → AUTOMATION-10.

**Top three.**

- **AUTOMATION-2 — stop the re-fire loop (in progress).**
  - WT keys event runs `${identity}#event` (`jobs.ts:340/354`); `skillRuns[<identity>]` stays schedule-only (free-text key, no migration). Cooldown now stamped via `job.cooldownKey` (`useJobRunner.ts:601-602`); an intermediate state stamped under `job.key` and silently disabled the cooldown — fixed and tested.
  - Acceptance adds: a gate deferral of schedule + event lanes no longer alternates (HEAD ~4 s storm); `daily 06:00` + `when:` agent with 06:00 answered derives no second 06:00 job; stale events + no new diff → no re-run after cooldown.
  - Kill the stale retry comments (`useJobRunner.ts:566-567` WT, `runLog.ts:44-47`): false for event runs until AUTOMATION-3.
- **AUTOMATION-1 — typed run cause.**
  - `runs.cause` JSON at the **next schema step** (not a hard-coded v19); NULL = not recorded → "why not recorded", never blank. Variants: schedule, event, assigned, handoff, manual, attended, self-follow-up (renamed: Macro's FollowUp means a discussion reply).
  - Cover all three production writers: `dispatch.rs:280`, `:768`, `:884` (meter_attended fallback). Store the CLI session id as the transcript link (Macro `ExecutionResult.resource`).
  - One vocabulary authority (Rust CHECK; TS renders unknown kinds in words, or a `shared/policy` artifact) — never a TS closed-enum twin. Subject text framed and escaped as data in the preamble.
  - Fleet/AgentsPage refresh on a Rust-emitted run end (AGENT_EVENT Done, `agent/mod.rs:928-979`), since handoff and internal runs never reach uiStore.
- **AUTOMATION-3 — durable wake queue.**
  - `agent_wakes` in `runtime/wakes.rs`, PK (vault_id, agent_key, wake_key), INSERT OR IGNORE; pending|started|finished; outcomes succeeded|failed|stopped|skipped{reason}|cancelled{reason}|interrupted|coalesced{run_id}. Deferral returns the wake to pending; expired leases → interrupted (reconcile in `recovery.rs`).
  - From Macro: `cancelled{superseded}` on a `when:`/pause/identity change (revision fence); single flight per agent; keep un-admitted events in the renderer when the admit IPC fails (ack only after admission).
  - Cerebro additions, labelled as departures: coalescing K wakes into one run (Macro runs one per (action, event)); pending expiry after N days (Macro has no time expiry); `cancelled{agent_gone}` when `recordIdentity` no longer resolves (a slug-less rename orphans the key, `identity.ts:24-30`).
  - Needs AUTOMATION-16 for stable wake keys. Never admit closed-app changes. Say which pause axis cancels wakes.

**Other candidates — stage 3 deltas.**

- **AUTOMATION-4 (M → L):** stamp in-app human writes (renderer IPC) with a human actor so NULL means only external-editor/shell writes; admission must tell "no row" (shell-native) from "NULL actor". Thread actor + run_id through every `shadow_write`/rename/delete site. `dispatch::claim` gains `parent_run_id` (touches ingest callers and crash points `dispatch.rs:200/215/351`, scenario test `:2771-2773`). Hop/cycle checks become a `runs` walk. Kill `lib.rs:1446` "Root by construction".
- **AUTOMATION-5:** treat an agent-authored assignment as delegation — book it as a hop (AUTOMATION-4) or fail closed on unattributed writers (Macro requires a user actor). Diff `before.relationships` vs `entry.relationships`; fixtures use `entry.relationships`. Project inheritance is a separate write, not `when: moved`. A demo-vault Type-doc edit churns e2e.
- **AUTOMATION-6 (S → M, mirror → adapt):** decide whether Run now consumes a due fire key (Macro does); refuse while the agent has a live run; check frontmatter pause in TS (Rust sees only the runtime pause); extract the start path from the ~330-line effect (`useJobRunner.ts:310-642`). Booking (ambient vs attended; M26.8c treats on-demand as attended) is an owner call; keep `attended:false` so it can't inherit global MCP config.
- **AUTOMATION-7:** the activation boundary needs durable state — a pure derivation can't tell resume/edit from the catch-up D3 owes after a closed app. Stamp from UI actions (`AgentsPage.tsx:375-382`, ScheduleField save) or keep a schedule+pause digest in a new ledger (CHECK rebuild). Don't stamp first-seen schedules. Write Cerebro's own phrase parser (Macro's leans on `@core/util/dateSearch/parseTime`; `src/engine` has none). No cron, no IANA tz.
- **AUTOMATION-8:** a `reminders` ledger is a CHECK change → table rebuild (`schema.rs:1206`), or namespace keys in an existing ledger. Macro's release = `job_ledger::unclaim` on notify failure. `tauri-plugin-notification` may be blocked by D12/M64.5 (Tauri locked at 2.11.5; current plugins want ^2.12) unless an older compatible release is pinned. Kill `DatePicker.tsx:371` if banners stay unbuilt.
- **AUTOMATION-9:** internal run (`internal:true`) + `submit_condition` MCP tool — not "MCP-less": `build_args` always passes `--mcp-config` and no run uses `--max-turns`. May pass its own `--model` without AUTOMATION-15. Record no probability. Update the "three internal spawn sites" comment (`ingest/spawn.rs:172, :277`). Reversing M17.12 stays open (D8 is a recommendation).
- **AUTOMATION-10:** no AUTOMATION-7 dependency (absolute `at`). Hydrate behind the `ledgersReady` gate. Amend G8 wording ("Trigger inputs are only renderer-diffed VaultEvents", `agent-platform-design.md:116`). Refusals stay operational `error_result`. Cancel orphaned follow-ups when the agent identity is gone. Self-only; no target argument.
- **AUTOMATION-14:** Rust allows exactly `{recent}` on `grant.actor`'s own record with a size cap, or `recent` moves to runtime.db. Add a test that performs the write (the existing `mcp.rs:3871-3881` only checks `writes_preferences`).
- **AUTOMATION-17:** runtime pause returns a typed deferral, or the runner unclaims and logs "paused".
- **Process note (AUTOMATION-1/3/4):** they edit crash-tested `dispatch::claim`; plans and workflow prompts must carry the cargo skip list, with a full run only after a reboot.

## 7. Conflicts with Cerebro conventions

| Macro pattern | Cerebro invariant | Resolution |
| --- | --- | --- |
| Routine definitions are Postgres rows with `configuration_revision` | Files win (2026-09 Q1) | Definitions stay in frontmatter; runtime.db holds operational state only (claims, wakes, causes, follow-ups). |
| Server dispatchers evaluate schedules | M34.2: derivation in TS; Rust arbitrates state + accounting | No Rust cron/trigger evaluator. TS derives; Rust admits and claims conditionally. |
| `require_human`: bot/delegated events never fire | M17.12: human edits in an agent's scope must wake it; NULL actor ≠ human | AUTOMATION-4 bounds agent-authored wakes as chain hops; unknown author = root, labelled "author not recorded". Keep the cooldown. |
| External classifier API (TypeSafe key, calibrated probability) | No API key in the app; agent = user's Claude CLI; absent is never zero | AUTOMATION-9: internal CLI run + `submit_condition`, metered, budget-gated, read-scope applied; record reason + question, no fake probability. Flagged reversal of M17.12. |
| Agents create routines for any accessible agent | PR #17: runs can't write Agent records; delegation only via `hand_to` | AUTOMATION-10: self-only, runtime.db, no target argument. |
| Assignment by anyone with write access | `hand_to` 2-hop/cycle/root-ceiling rules | Agent-authored assignment books as a hop or fails closed (AUTOMATION-5). |
| Inbound/outbound webhooks, bot tokens, Kafka/SQS | G8 loopback; no HTTP client (M26.7d); R14 per-connector gate | Skip (AUTOMATION-11); acceptance is "no non-loopback listener" (M62.5 adds a second loopback one). |
| Routines run while user offline | D3 app-lifetime; R10 gate | Skip (AUTOMATION-12); catch-up on launch says it was late. |
| `ClaimToken`, `claim_action`, `core/claim.ts` | Protected-name tripwire (`trigger/mod.rs:103-123`, list from `trigger-registry.v1.json:8-16`): no struct/enum/trait/mod/class/interface named exactly `Claim` (also Skeptic, Scout, Curiosity, Discovery, Forecast, Narrative) | Use lease/wake/admit names. Functions, TS type aliases and compounds (`job_ledger::claim`, `ClaimedKey`) pass. |
| Event routing/admission tables | `src-tauri/src/trigger/` is the R1–R14 registry; write ban over a fixed list of 9 files (`mod.rs:43-51`); `runtime/triggers.rs` inserts only `trigger_*` | New `runtime/wakes.rs` / `agent_wakes`. Never under `trigger/` (convention, not just the scan), never `trigger_` prefix. |
| Cron + per-schedule IANA tz | M13.2/M18.4: deliberately small grammar, machine clock stated | AUTOMATION-7 adds closed shapes only. |
| Reminders as DB rows | Files win: a reminder is a date chip | Chip stays the definition; only fired occurrences move to `job_ledger`. |
| Trigger matching in service and UI | Policy is data; no twin Rust/TS rules | Matching stays TS-only; Rust validates shape. Rust matching ever → vocabulary to `shared/policy` + goldens. Cause vocabulary: one authority. |
| Completion notifications | M8 "nothing speaks first"; runner must not speak (`useJobRunner.ts:46-49`) | Rejected (AUTOMATION-13), though Macro `TODO.md` marks them done. |
| Shipped recipes (`services/bots/ROUTINES.md`) | M17: no fixed agent recipe catalogue | Do not ship as templates. |
| Copying Macro code/prompts | Owner rule + AGPL / all-rights-reserved | Design-level rebuild; own prompt text (e.g. assignment preamble vs `prompt.md`). |

## 8. Verification notes (stage 3)

- **Confirmed + worsened — C1 (shared slot).** HEAD `jobs.ts:282-283` and `:304-315` both key `skillRuns[recordIdentity]`; `job_ledger.rs:58-64` overwrites. Under a gate deferral HEAD claims + records before `runAgent`, unclaims on deferral without a cooldown, and `shouldYield` re-arms after SETTLE_MS → schedule and event jobs alternate ~every 4 s, each writing a decision row and a run-log row (evicts the 200-entry log). Precondition: agent has both `schedule:` and `when:` (no demo agent does). WT fix verified by probe.
- **Partial — C2.** Never-retried and first-match-only confirmed. Correction: cooldown/yield events wait in a one-slot list and are lost when a later non-empty diff replaces it — a run's own writes do exactly that, so human edits during any run are routinely lost.
- **Confirmed — C3, C4, C7, C8, C10.** C10 is stronger: shell-native writes leave no `vault_writes` row and skip MCP scope and Agent guards. C4: scoped agents are refused even earlier (`mcp.rs:1521-1535`).
- **Unverifiable — C5** (needs a packaged build). `useReminders.ts:46-60` returns silently with no `Notification`.
- **Partial — C6.** Exact-identifier match; fixed 9-file list, not a glob; Scout also protected.
- **Partial — C9.** `personCandidates` returns Agents if the field targets Agent; blocker is the UI (`AddPropertyPanel.tsx:122`, Agent reserved in `typeCatalog.ts:76-81`) and `inferTarget`'s majority-vote retype hazard.
- **Refuted — Macro coalesces event runs.** PK (action_id, event_id); `EventRunKey` (`event_runs.rs:126-133`). Coalescing is a Cerebro departure.
- **Refuted — Macro expires pending runs by age.** Reconcile cancels pending only on Disabled/Superseded; started past deadline → Interrupted. Expiry is a Cerebro addition; Superseded is the missing Macro piece.
- **Refuted — Run now mirrors Macro and consumes no fire key.** Macro consumes the due firing and 409s a live run.
- **Refuted — runtime pause behaves like a gate deferral.** It's refused before the claim; the gate's AgentPaused reason is unreachable; the period is eaten and mislabelled (→ AUTOMATION-17).
- **Refuted — project inheritance covered by `when: moved`.** That only wakes a folder watcher; Macro writes the agents into Assignees.
- **Partial — Macro `require_human` fails closed.** `document_actor` admits an actorless document event with a fallback user.
- **Partial — "already-better" on fenced claims.** Claims yes; no per-agent single flight.
- **Partial — AUTOMATION-1 writers/refresh.** Three INSERT sites; handoff runs start in Rust; refresh on a Rust signal.
- **Partial — AUTOMATION-9 feasibility.** No MCP-less or `--max-turns` path exists; use internal run + submit tool.
- **Partial — licences.** AGPL / all-rights-reserved confirmed; plugin licence (Apache-2.0 OR MIT) from known upstream terms, but compatibility with locked Tauri 2.11.5 unverified.
- **Confirmed:** Macro condition gate (one call, p ≥ 0.5, 10-min window, skip recorded); TriggerContext runtime-only; MCP `UpdateRoutine` always writes cron (`crates/routines/src/outbound.rs:196-209`, wipes event triggers — don't copy); LOC figures.
- **Missed by stages 1–2, now candidates:** deferral storm (→ AUTOMATION-2 acceptance), runtime pause (→ 17), no single flight (→ 3/6), dead agent memory (→ 14), phantom `changed` from modifiedAt-only diff (`events.ts:100`, → 16), no per-agent model (→ 15), vault-switch storm (→ 2b), crash-test coupling (process note), three pause axes (→ 3/6).
- **Effort/fidelity changes:** AUTOMATION-4 M → L; AUTOMATION-6 S → M and mirror → adapt; AUTOMATION-5 M or L. **Dependency changes:** AUTOMATION-10 drops -7; AUTOMATION-3 adds -16.
- **Owner calls open:** AUTOMATION-14 storage; AUTOMATION-4 chain semantics for write-triggered runs; AUTOMATION-6 booking and fire-key consumption; AUTOMATION-7 activation boundary (changes today's resume catch-up); AUTOMATION-9 reversal of M17.12. Only roadmap D0 is decided; D7, D8, D17 are recommendations.
- **Macro defects not to copy:** `UpdateRoutine` cron overwrite; Dispatched defined but never produced; completion notifications marked done with no producer; plaintext webhook signing secret; Stripe bot accepts duplicates.

## 9. Where to read first

1. `crates/trigger_context/src/lib.rs`
2. `packages/lexical-core/utils/agent-context.ts`
3. `crates/macro_db_client/migrations/20260922182949_add_scheduled_action_event_runs.sql`
4. `services/scheduled_action/src/domain/event_runs.rs`
5. `services/scheduled_action/src/domain/event_runs/admission.rs`
6. `services/scheduled_action/src/outbound/pg_event_run_repo.rs`
7. `services/scheduled_action/src/domain/event_runs/dispatch.rs`
8. `services/scheduled_action/src/domain/event_trigger.rs`
9. `services/scheduled_action/src/domain/execution.rs`
10. `services/scheduled_action/src/domain/target_runner.rs`
11. `services/scheduled_action/src/outbound/pg_scheduled_action_repo.rs`
12. `services/scheduled_action/src/domain/event_runs/condition.rs`
13. `crates/agent_trigger/src/domain/task_assignment.rs`
14. `crates/agent_trigger/src/domain/project_assignment.rs`
15. `crates/routines/src/inbound.rs`
16. `crates/routines/src/domain.rs`
17. `crates/reminders/src/domain/service/dispatch.rs`
18. `crates/reminders/src/outbound/pg_reminders_repo.rs`
19. `services/scheduled_action/src/outbound/tokio_dispatcher.rs`
20. `apps/web/src/features/routines/queries/routine-trigger-mapping.ts` (behaviour only)
21. `crates/bot_token/src/lib.rs` (for MCP-5/M62.5 tokens)
