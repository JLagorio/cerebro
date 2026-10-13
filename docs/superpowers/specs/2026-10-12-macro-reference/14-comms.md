# Macro reference — Messaging and calls: channels, threads, realtime, notifications, activity, transcription

**Scope**: Macro's comms domain, read 2026-10-12 from `docs/examples/macro-main/` (vendored and gitignored). Every Macro
path below is relative to that root. Cerebro paths are relative to the repo root.
**Owner's rule (2026-10-12)**: Cerebro builds its own version, with Macro's code as the guide and never a 1:1 copy.
Modes are rebuild (fidelity mirror / adapt / inspire), adopt-upstream, reuse-permissive and skip.
**Licence**: root `LICENSE.txt` is AGPL-3.0; no owned crate or service has its own licence, so AGPL covers all of them,
`packages/lexical-core` included. `apps/web/LICENSE` is "All rights reserved": every frontend unit (`features/channel`,
`notifications`, `activity`, `block-call`, `lib/core/messages`, `lib/queries/*`) is design-only, pure-TS helpers
included. `infra/stacks/*` MIT claims are moot (skipped). Never reuse
`crates/call/src/outbound/s3_recording_storage/test_private_key.pem`. Macro prompt text is AGPL: write our own.
**Evidence**: stages 1–2 read code and docs; stage 3 re-read both trees statically and ran one read-only query on the
dev `runtime.db`. No cargo, vitest, e2e, packaged app or BlockNote spike. Stage 3 overrides 1–2. Cerebro line numbers
come from a working tree carrying uncommitted PLATFORM-API-1 and AUTOMATION-2b changes.
**Cerebro baseline**: M49–M52 (`vault_writes`, the `app_sessions` writer, Knowledge's three tabs) exist only on
`m49-knowledge-integrity`.

---

## 1. What it is

- Team chat plus entity comments on **one parent-agnostic message store** (`crates/messages`). Channels, documents,
  initiatives, CRM records and call chat all post to `comms_messages`; a thread's identity is its root message id.
- Each committed write fans out to three failure-isolated sinks: broker `macro.messages`, the local @Macro agent queue,
  and parent delivery (notifications + realtime). Notifications run a cloud ingress/egress pipeline on an
  unseen/seen/done lifecycle. Activity is one append-only fact table. Calls: LiveKit → Deepgram → Sonnet summary.
- For Cerebro (single user, files-first, no cloud, no tokio, no TanStack): the designs transfer, the infrastructure
  does not.

## 2. What users get

| Feature | UX details and shortcuts | Paths |
| --- | --- | --- |
| Channels and DMs | Types public/private/direct_message/team. Create dialog has 3 steps: name; visibility (Team by default); optional invite of people/agents/emails. Team channels always discoverable, auto-join. DM = 2-user channel; `c m` sends to an existing channel with those recipients or creates one. Join codes/links; roles owner/admin/member; invite email to unregistered users; teammate DMs auto-created on team join. | `crates/channels/src/domain/models.rs`, `crates/channels/src/domain/dm.rs`, `crates/channels/src/inbound/teammate_dms_consumer.rs`, `apps/docs/product/channels.mdx`, `docs/AGENT_GUIDE/channels.md` |
| Threads: inline preview, then collapse | Root carries `reply_count`, `latest_reply_at` and the oldest 3 live replies. Client shows 3 avatar groups (same sender within 5 min = one group), then "N more replies". Replies arriving while collapsed only grow the hidden count. Expanding keeps the preview until full replies load. Threads tab lists every thread you are in, filterable by conversation. | `crates/messages/src/domain/models.rs`, `apps/web/src/features/channel/Thread/utils/thread-reply-indicator-helpers.ts`, `apps/web/src/features/channels-view/components/ChannelThreadsView.tsx` |
| Edit / delete / react / typing / attachments | Edit sets `edited_at` + "edited" and never re-notifies. Delete = tombstone; deleting a root keeps the discussion. Reactions notify the author (not self, not removal). Typing: start on first keystroke, refresh every 4 s, stop after 2 s idle; receivers expire at 8 s. ≤10 attachments, stored with dimensions. Actions: Reply, React, Copy link, Copy text, Edit, Delete, Create task, Chat. | `crates/messages/src/domain/service.rs`, `apps/web/src/features/channel/Input/create-typing-tracker.ts`, `apps/web/src/lib/queries/messages/typing.ts`, `apps/web/src/lib/core/messages/types.ts` |
| @links, mentions, embeds | Macro Markdown with `<m-user-mention>`, `<m-document-mention>`, `<m-group-mention>`, `<m-agent-session-mention>`, `<m-document-card>`, `<m-reply-target>`, `<m-date-mention>`. One `@` menu that also lists Recent agent sessions; a session chip is a reference, not an invocation. Mentions become backlinks. Referenced items are auto-shared at a capped level. An image mentioned twice unfurls once; inaccessible images render nothing. A message link renders as a read-only thread card. | `packages/lexical-core/utils/mentions.ts`, `crates/messages/src/domain/mentions.rs`, `crates/channels/src/domain/reference_sharing.rs`, `apps/web/src/lib/core/component/LexicalMarkdown/component/decorator/ChannelMessageThreadCard.tsx` |
| Entity discussions (comments) | Same store. Anchors: Markdown mark, PDF highlight/placeable, sheet range, fig layer. Resolve, reopen, detach. ≤1 live discussion per Markdown mark. Deleting a discussion tombstones every message but keeps the anchor so open editors reconcile. `marked_text_snapshot` keeps an elided quote. Reason precedence: mention > reply > assignee > owner. | `docs/design/entity-messages.md`, `crates/messages/src/domain/models.rs`, `crates/messages/src/domain/notification.rs`, `apps/web/src/lib/core/messages/EntityDiscussion.tsx` |
| Realtime and presence | One `message_update` frame per change (posted, edited, message_deleted, reaction_changed, thread_updated, typing), sent only to verified viewers/participants. Opening an entity tracks presence (viewer avatars). Last-online recorded on connect, ping, disconnect. Catch-up on reopen: `?selection=<newest cached root>, newer, 50`; full reload on overflow, cache miss or link targets, logged `catch_up|full` plus a reason. | `crates/messages/src/outbound/connection_gateway.rs`, `apps/web/src/lib/queries/messages/sync.ts`, `crates/last_online_tracker/src/inbound.rs`, `docs/AGENT_GUIDE/channels.md` |
| Notifications inbox | Typed catalog: channel_mention, reply, reaction, invite, document comments, call_started, task_assigned, reminders, GitHub PR, agent_session_settled / waiting_for_input / mentioned, new_email. unseen/seen/done: open = seen; `e` = done; Ctrl+Z restores as seen; a late mark-seen never reopens done. Stacked by thread. Per-item mute/snooze, per-type opt-out, global mute. Push and email digest for offline users. Channel unread chip counts distinct offscreen unread threads, not notifications. | `crates/model_notifications/src/lib.rs`, `crates/notification_state/src/lib.rs`, `apps/web/src/features/notifications/notification-stacking.ts`, `docs/notification-state-migration.md` |
| Activity feed | "My activity" newest first; consecutive events with the same actor, entity and action within a day fold into one line ("5 times", "3 changes"). 365-local-day heatmap plus top entities. Per-entity timeline. System rows in channels (renames, membership, call ended with duration). Property changes show labels, never ids. ReadActivity includes agent actions taken on the user's behalf. | `crates/activity/src/lib.rs`, `crates/activity/src/domain/timeline.rs`, `apps/web/src/features/activity/core/collapse-runs.ts`, `apps/web/src/features/activity/core/group-events.ts`, `apps/docs/AI/mcp/tools/read-activity.mdx` |
| Calls, recording, transcription, team memory | One active call per channel, quick calls, share-link meetings with guests. Ring on every device (CallKit/PushKit), cross-tab single ringer, 30 s timeout. Persistent in-call chat thread. Egress recording plus midpoint JPEG preview. Live diarized transcript, voice enrollment, AI summary + name, custom speaker names, transcript↔video sync. Shared to team memory by default; opt-out checkbox bottom-left of the call; a call with no channel goes to personal memory only. | `crates/call/src/domain/service.rs`, `crates/call/src/outbound/ai_call_summarizer.rs`, `services/transcription/transcriber.py`, `apps/web/src/features/channel/Call/ring-coordination.ts`, `apps/docs/product/calls.mdx` |
| Agents as channel members | @Macro posts a thinking placeholder, runs tools, patches the answer; a failed or empty reply becomes fallback text in the placeholder. Unmentioned follow-ups only in threads already holding a Macro message and only if a classifier agrees. @claude/@codex/@cursor open sessions shown as Magic Chips (88 px, 2 rows, status, model, Open session, PR row + Merge). Drafts emails/events and acts only on a "yes" in the same thread. Bots never trigger bots. | `crates/channel_bots/src/domain/trigger_detector.rs`, `crates/channel_bots/src/domain/service.rs`, `docs/AGENT_GUIDE/channels.md` |
| Agent/MCP comms tools | ReadChannelMessages (windows latest/timeRange/aroundMessage/page/messages; ≤100; ≤16000 chars per message; thread previews; ≤8 images inline), ReadChannelThread, ReadChannelMessageContext, SendChannelMessage, CreateChannel, ManageChannelParticipants, RenameChannel, ShareWithChannel, ListNotifications, MarkNotificationsSeen/Done, ReadActivity (≤100, truncation flagged), ReadCallRecord (`diarizedSpeakerId`). | `crates/channels/src/inbound/toolset.rs`, `crates/notification/src/inbound/ai_tool.rs`, `crates/activity/src/inbound/toolset/read_activity.rs`, `crates/call/src/inbound/toolset/read_call_record.rs`, `apps/docs/AI/mcp/tools/read-channel-messages.mdx` |
| Labels, composer, Slack import | Labels group channels (smart rule "name contains"; names unique case-insensitively; empty labels stay; deleting keeps channels). One composer lifecycle: per-surface drafts, mentions, attachments, typing, send errors, Whisper dictation (send blocked while dictating), compact row that expands; Escape cancels an edit. Silent Slack import keeps dates, fires no notifications or bots, dedupes on re-import, skips attachments. | `crates/channel_labels/src/lib.rs`, `apps/web/src/lib/core/messages/create-message-composer.ts`, `crates/messages/src/domain/historical.rs`, `docs/AGENT_GUIDE/channels.md` |

## 3. How it's built

**Architecture**: hexagonal Rust crates (domain + ports; sqlx/Kafka/AWS outbound; axum, GraphQL, AI-tool inbound).
REST `/dss/messages/{parent_type}/{parent_id}` → `MessageService` (authorize via `entity_access` receipts, validate,
persist) → after commit, `MessageEffects` fans out to broker, local agent queue and `ParentMessagePublisher`
(→ `ChannelMessageDelivery` or `DiscussionDelivery`) → `NotificationIngress` → SQS → egress (Kafka → per-user
`BroadcastManager` → websocket/GraphQL; SNS APNs/FCM/VoIP; SES or Redis digest). Realtime frames go through
`services/connection_gateway` (DynamoDB connections, Redis entity tracking). Activity: Kafka → per-domain mapping →
`ActivityMaterializer`. Calls: LiveKit room + webhooks → Python transcriber → archive → Sonnet. Frontend: SolidJS,
TanStack Solid Query/Virtual (patched), Lexical with `<m-*>` tags.

| unit | path | role | LOC |
| --- | --- | --- | --- |
| MessageService | `crates/messages/src/domain/service.rs` | Parent-agnostic post/patch/delete/react/typing. Live-root, no reply-to-reply, tombstone immutability, anchors only on document roots, client UUIDv7 drift check, reference view-access, @here expansion | 13352 (crate) |
| MessageEffects / DiscussionDelivery | `crates/messages/src/domain/effects.rs` | Isolated fan-out; typing skips agents; call chat gets realtime only | 305 |
| Broker facts | `crates/messages/src/outbound/broker.rs` | `message.posted/patched/deleted/mentioned/attachment_*`, keyed by root; no reactions or typing | 254 |
| Channel side effects | `crates/channels/src/domain/side_effects.rs` | Recipient policy: mentions, doc mentions, thread participants, first-post invites, members minus sender | 1100 |
| ChannelMessageDelivery | `crates/channels/src/domain/message_delivery.rs` | Auto-share refs, read markers, `updated_at`, realtime to participants | 239 |
| Reference sharing | `crates/channels/src/domain/reference_sharing.rs` | `grant_level` caps (PDF ≤ Comment, sessions only by owner at View, events only by holders, forms View) | 92 |
| Notification ingress/egress | `crates/notification/src/domain/service/ingress.rs` | Filter sender/mute/snooze/type; idempotent persist; per-channel queue messages; 15 s egress timeout | 22937 (crate) |
| Digest state machine | `crates/notification/src/domain/models/email_notification_digest.rs` | Push on → email only if push failed; push off → only if offline > 60 min | 640 |
| NotificationState | `crates/notification_state/src/lib.rs` | Pure 3-state intent table (logic ≈10 lines, `:49-56`) | 472 |
| Notification catalog | `crates/model_notifications/src/lib.rs` | `define_notif_event!` compile-time tag guard; hashed collapse keys | 3962 |
| WS notification consumer | `crates/notification/src/domain/service/realtime.rs` | Topic → per-user New/Updated/Deleted via BroadcastManager, backoff retry | 178 |
| BroadcastManager | `crates/broadcast/src/lib.rs` | Keyed tokio broadcast; bounded per-subscriber buffers (64/key, 16/sub); slow consumers dropped with `ExitReason` | 365 |
| LastOnlineService | `crates/last_online_tracker/src/domain/services.rs` | Redis last-online, 30-day TTL; record on connect/drop/ping | 403 |
| Activity protocol | `crates/activity/src/lib.rs` | Action vocab, actor vs subject, uuidv5 ids, materializer, announcements (5 s, 16 concurrent), timeline selections, overview | 6168 (crate) |
| Timeline merge | `crates/messages/src/domain/service/timeline.rs` | Messages + activity rows under one cursor, per-source has-more (`:27-56`) | 221 |
| CallServiceImpl | `crates/call/src/domain/service.rs` | Rooms, webhooks, transcript ingest, summary/name/speakers, team share, `call.*` events | 24132 (crate) |
| Transcriber | `services/transcription/transcriber.py` | Deepgram nova-3 per participant (endpointing 400 ms, diarize); Resemblyzer clustering; uuid5 segment ids | 652 |
| Agent trigger (referenced) | `crates/channel_bots/src/domain/trigger_detector.rs` | Explicit mention or inferred follow-up; bot authors never trigger | 2713 (crate) |
| Connection gateway (referenced) | `services/connection_gateway/src/model/tracking.rs` | Websocket fan-out, entity presence, 60 s staleness | 3619 |
| Channel UI | `apps/web/src/features/channel/Channel/ThreadList.tsx` | Virtualized timeline, threads, composer, calls | 42967 (feature) |
| Message caches | `apps/web/src/lib/queries/messages/sync.ts` | Apply `message_update`, nonce reconcile, delete rollback, typing store | 7282 (dir) |
| Notifications UI | `apps/web/src/features/notifications/notification-stacking.ts` | Thread stacking, optimistic overlays, snooze | 9331 (feature) |
| Activity UI | `apps/web/src/features/activity/core/collapse-runs.ts` | Run collapse, heatmap geometry, phrasing | 6550 (feature) |

**Data model** (Postgres unless noted; migrations under `crates/macro_db_client/migrations/`):

| entity | key fields | path |
| --- | --- | --- |
| Channel / participant | type public/private/dm/team; `owner_id`, `team_id`, `auto_join_team`, `join_code`, `label_id` · participant `user_id` (`macro\|email` or `bot\|uuid`), role, soft `left_at` | `20251104101012_comms_db_schema.sql` |
| Message | client UUIDv7 id; `parent_entity_type` channel/document/initiative/crm_company/crm_contact/call; `thread_id` = root or null; `sender_id`; `triggered_by`; content; `edited_at`; `deleted_at` tombstone; `imported_author`, `import_metadata` | `20260917175816_messages_parent_aware_schema.sql` |
| Thread state | PK `root_id`; `resolved`; `anchor` jsonb (markdown/pdf_highlight/pdf_placeable, document-only CHECK); `deleted_at`; unique live mark per document | same |
| Reactions / attachments / mentions / read markers | `comms_reactions`, `comms_attachments` (w, h), `comms_entity_mentions` (backlinks), `comms_activity` (viewed_at, interacted_at) | `20251104101012_comms_db_schema.sql` |
| Notification | `notification` (UUIDv7, type, event item + thread item, metadata, collapse key) + `user_notification` (state unseen/seen/done; `seen_at` history only; `deleted_at`) | `20260126170641_create_notification_tables.sql` |
| Preferences | item unsubscribe + `snoozed_until` (null = permanent), global mute, per-type opt-out, devices, push receipts, email-sent bookkeeping | `20260926043014_entity_notification_snooze.sql` |
| Call / call record | live `calls`, transcripts (`segment_id` unique per call, `speaker_id`, `diarized_speaker_id`, `voice_id`, `sequence_num`); archived `call_records` + `summary`, `custom_name`, `share_with_team` | `20260331170640_add_call_tables.sql`, `20260424120100_call_record_summary.sql` |
| Meeting | `share_token` (room-only bearer), schedule, optional channel link, `cancelled_at` | `20260918183729_shareable_calls.sql` |
| Voice | pgvector `embedding vector(256)`, HNSW cosine; `macro_user_voice` enrollment | `20260511131822_add_voice_tables.sql` |
| Activity event | id uuidv5(source id, ordinal); `actor_id`; `subject_id` = on_behalf_of ?? actor; action + payload; entity; `occurred_at`; keyset indexes | `20260805180315_create_activity_events.sql` |
| Bot | kind owned/system; handle; token hash/prefix/expiry; membership = participant row `bot\|uuid` | `20260527160000_channel_bots.sql` |
| Last online | Redis `last_online:{user}`, 30-day TTL | `crates/last_online_tracker/src/outbound/redis.rs` |

**Key flows**

Post a message:
1. Composer mints UUIDv7 + nonce and inserts optimistically (`apps/web/src/lib/core/messages/create-message-composer.ts`).
2. POST `/dss/messages/channel/{id}`; the `MessageWrite` receipt requires membership.
3. `post_validated`: refs (≤10 attachments, ≤100 mentions, author view access per entity; display-only chips stored
   verbatim); live-root check for replies; @here expanded from current members.
4. Message + thread row in one transaction.
5. `MessageEvent{Posted, notification_policy}` → broker (+ `message.mentioned` per entity), local agent queue, parent.
6. Channel delivery: auto-share (`grant_level`), read marker, `updated_at`, `message_update` to participants.
7. Side effects pick recipients → `NotificationIngress`.
8. `sync.ts applyMessage` reconciles the nonce. Post-commit failures are logged, never returned.

@Macro in a thread:
1. Every human post enters the local queue; the detector fires on an explicit mention, or on an inferred follow-up in
   a thread already holding a Macro message when the classifier agrees.
2. Recheck the invoker's write access; load ≤8 prior messages plus the thread.
3. Post a silent placeholder as the bot (`triggered_by` = user); run tools; patch with `NotifyAsPostedMessage`.
   A deleted placeholder drops the answer; a failed/empty reply writes fallback text (`service.rs:604-672`).
4. Hosted agents: capability bound to (parent, root); resume only from the same pair. Bot posts never re-enter.

Notification lifecycle:
1. Ingress: filter sender, global mute, item mute/snooze, type opt-out; persist idempotently; digest decision.
2. Egress: Kafka → `BroadcastManager` → websocket; SNS push with collapse keys; SES or 30-min Redis digest.
3. Client bulk PATCH seen/done/undone; SQL CASE applies the transition atomically; push cleared on seen/done.
4. Deleting a message cascades to its notifications (`20260423120000_cascade_comms_message_delete_to_notifications.sql`).

Call → memory:
1. Room + token; `call_started` + VoIP push; cross-tab ringer (1 s heartbeat, 3.5 s TTL); ringing stops at 30 s.
2. Webhooks reconcile participants; the stale sweeper repairs missed leaves.
3. Transcriber posts final segments only (uuid5 ids); ingest attaches `voice_id`.
4. `room_finished` → `archive_call`; team-share intent → team View grant (channel calls only); `call.record_archived`.
5. Spawned: custom speakers, Sonnet summary (NULL sentinel skips), AI name unless custom-named; voice enrollment.
6. Recording → S3 → Lambda ffmpeg midpoint JPEG; the channel shows a CallEnded row.

Activity:
1. Kafka event → owning domain mapping → `Ingest::Insert` with a uuidv5 id.
2. Materializer writes durably, then announces (5 s budget, 16 concurrent) to audiences under current access.
3. Reads: subject feed (keyset), entity timeline (refuses Messaged/Opened/Edited/Sent, `timeline.rs:48-73`),
   365-day overview, ReadActivity tool. Edits are sessionized at write time with a 5-min debounce
   (`crates/documents/src/domain/activity.rs:181`), dropped silently on cache failure (`:195`).

## 4. Ideas worth stealing (ranked)

1. **Activity = one append-only fact table, actor vs subject, deterministic ids** — agent actions count as the user's;
   replay is idempotent; no derived tables. Cerebro's fact table (`vault_writes`) already exists.
   `crates/activity/src/lib.rs`.
2. **Merge independent sources under one cursor with per-source has-more** — git + `vault_writes` + ledger in one
   History without mislabeling rows outside a source's window. `crates/messages/src/domain/service/timeline.rs:27-56`.
3. **Entity timelines exclude edits; the feed folds consecutive same actor/entity/action runs per day** — no time gap
   in the fold. `crates/activity/src/domain/timeline.rs:48-73`, `apps/web/src/features/activity/core/collapse-runs.ts:18-51`.
4. **Intent-driven 3-state lifecycle** — MarkSeen never reopens Done; Reopen → Seen; one atomic SQL CASE; timestamps
   are history, not state. `crates/notification_state/src/lib.rs:49-56`, `docs/notification-state-migration.md:13-17`.
5. **Agent-in-thread protocol** — explicit mention, placeholder → patch, fallback text on failure, deleted placeholder
   drops the answer, bots never trigger bots, session bound to (parent, root).
   `crates/channel_bots/src/domain/service.rs:604-672`, `crates/channel_bots/src/domain/trigger_detector.rs:14-25`.
6. **Commit first, then isolated fan-out** — a failed sink never turns a committed write into an error.
   `crates/messages/src/domain/effects.rs`.
7. **Notification policy travels with the change** (Default / MentionsOnly / Silent / NotifyAsPostedMessage) — imports
   and placeholders wake nothing. Cerebro's batch ingest wakes triggers per file. `crates/messages/src/domain/models.rs:498-517`.
8. **Parent-agnostic discussions; thread = root id; separate thread-state row; two-level tombstones keep the quote**.
   `docs/design/entity-messages.md`, `crates/messages/src/domain/models.rs`.
9. **Transcript pipeline** — final-only segments, uuid5 ids, summary prompt with a NULL sentinel, generated name unless
   custom, agent-suggested attendees checked against a closed candidate set.
   `crates/call/src/outbound/ai_call_summarizer.rs:91-104,309-336`, `services/transcription/transcriber.py`.
10. **Bounded agent read windows** — latest/timeRange/aroundMessage/page/ids, per-message char cap, truncation flag.
    `apps/docs/AI/mcp/tools/read-channel-messages.mdx`.
11. **Compile-time tag guard** (`define_notif_event!`) — same failure class as Cerebro's Rust/TS parity.
    `crates/model_notifications/src/lib.rs`.
12. **Small helpers**: speaker clustering (cosine ≤ 0.30, ≥ 1 s speech, running centroid; `transcriber.py`);
    pending navigation intent applied after layout is ready
    (`apps/web/src/features/notifications/PendingNotificationNavigationEffect.tsx:23-60`); per-surface composer drafts
    (`create-message-composer.ts:16-39`); sticky-scroll spec (`apps/web/src/features/channel/docs/sticky-scrolling.md`);
    cross-tab single ringer (`apps/web/src/features/channel/Call/ring-coordination.ts`).

## 5. Cerebro today vs Macro

| Macro feature | Cerebro status | value | note |
| --- | --- | --- | --- |
| Channels, DMs, teams, invites, labels | different-by-design | low | Single user (roadmap D1); teammates become agents; sidebar sections + Favorites cover labels |
| Thread previews / Threads tab | different-by-design | low | AI panel switcher groups conversations by place (M17.5) |
| Edit/delete/react/typing/attachments | different-by-design | low | No human-to-human messages |
| @mentions as backlinks, auto-share | already-better | low | Wikilinks are backlinks on disk; `@handle` addresses agents; no sharing |
| Anchored discussions (comments) | absent | medium | No store (`PropertyMenu.tsx:28-33`); M47 §9 non-goal; BlockNote 0.46.2 ships unused `CommentsExtension` → EDITOR-4a/4b |
| Agents as thread members | partial | medium | Panel `@handle` per turn (M33b.6), `hand_to` 2 hops, no cycles; event triggers ignore authorship (AUTOMATION-4) → COMMS-3 |
| Classifier-inferred follow-ups | different-by-design | low | Nothing speaks first |
| Realtime frames, presence, BroadcastManager | different-by-design | low | One window, Tauri emit, no tokio |
| Last-online / session history | **already built** (stages 1–2 missed) | — | `app_sessions` durable heartbeats, `clean_exact` vs `heartbeat_lower_bound` (`runtime/schema.rs:267-283`, writer since M49.9) |
| Notification feed / bell / push / digest | different-by-design | low | M8, M27, M43, M33b D7; D9 recommends pull-only Home lanes |
| unseen/seen/done, snooze | partial | medium | §33 per-item dismissal exists but `attention_lanes` passes `Preferences::default()` (`lib.rs:640-651`); insight dismissals + fired reminders in global localStorage → COMMS-5 |
| "Since you looked" | absent | medium | No storage for when the user looked → COMMS-11 |
| Activity fact log with actor | partial | high | `vault_writes` actor NULL on all 69 dev rows; `write_text_file` / `import_attachment` record nothing; only the validator reads it → COMMS-1 |
| History page | partial (defect) | high | Git only, 50 commits; failures read "No history yet"; non-repo `Ok([])`; unborn HEAD errors → COMMS-9 |
| Per-entity timeline | partial | high | `GitHistoryPanel` (`--follow`) with no agent attribution; renders nothing on failure → COMMS-1/9 |
| ReadActivity tool | absent | medium | 17 base tools, none for activity/runs → COMMS-1 |
| Durable toast history | absent | medium | Toasts vanish after 6 s (176 call sites, 55 files) → COMMS-10 (folds into SHELL-17) |
| OS notifications | partial | medium | Web `Notification` only; silent if absent; inertness in WKWebView unmeasured → COMMS-6 |
| Calls, ringing, guests, VoIP | different-by-design | low | — |
| Transcript → summary/title/speakers | partial | high | VTT/SRT ingest exists; speakers plain strings; not idempotent; title from filename → COMMS-4 |
| Recording, local STT, diarization | absent | low | No mic code, no media-src, no `NSMicrophoneUsageDescription` → COMMS-7 (next wave) |
| Transcript↔playback | absent | low | Needs kept audio → COMMS-7c |
| Composer drafts | partial (defect) | low | One `useState` draft shared across conversations (`AiPanel.tsx:247`) → COMMS-12 |
| Dictation, Slack import | absent | low | Dictation needs STT; Slack = INTEGRATIONS-6 |

## 6. Port candidates

Order: COMMS-9 → COMMS-9b → COMMS-10 (with SHELL-17) → COMMS-12 → COMMS-4 (after M53.18) → COMMS-1 (after M58.1) →
COMMS-5 (one schema step with AUTOMATION-8 / CALENDAR-4) → COMMS-11 (with PRODUCT-1 / M64.4) → COMMS-6 → owner D10 →
EDITOR-4a/4b → COMMS-3 → owner STT choice → COMMS-7a/b/c. COMMS-8 stays skipped. COMMS-2 is dropped (merged).

| id | title | mode | fidelity | effort | value | Macro guide (read first) | Cerebro target | depends |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| COMMS-9 | History reads: unavailable, untracked and empty are three different sentences | rebuild | inspire | S | high | `docs/notification-state-migration.md` (state not inferred), `docs/AGENT_GUIDE/surfaces.md` | `src/git/useGit.ts:209-211,238-240`, `src/pages/PulsePage.tsx:31-47`, `src/git/GitHistoryPanel.tsx`, `src-tauri/src/git/pulse.rs:84-87,98,112`, `src-tauri/src/git/history.rs:54-66`, `src/lib/mockGit.ts` | — (= M53.15; land with PRODUCT-11) |
| COMMS-9b | Git probe tri-state: a failed probe is never "Not tracked" | rebuild | inspire | S–M | high | — (Cerebro-native) | `src/git/useGit.ts:93-96`, `src/git/GitSettings.tsx:89-103`, `src/git/CheckpointHost.tsx:22`, `src/agent/AiPanel.tsx:286`, `src/app/StatusBar.tsx:207-215`, `src-tauri/src/git/commit.rs:55-68` | COMMS-9 |
| COMMS-1 | Attributed History: vault feed, page History, `read_activity` | rebuild | adapt | L | high | `crates/activity/src/lib.rs`, `crates/activity/src/domain/timeline.rs:48-73`, `crates/messages/src/domain/service/timeline.rs:27-56`, `apps/web/src/features/activity/core/collapse-runs.ts:18-51`, `apps/web/src/features/activity/core/group-events.ts:16-35`, `apps/docs/AI/mcp/tools/read-activity.mdx` | `src-tauri/src/runtime/activity.rs` (new, read-only connection), `src-tauri/src/runtime/schema.rs`, `src-tauri/src/vault/write.rs`, `src-tauri/src/lib.rs`, `shared/.../tools.v1.json` entry, `src/engine/activity.ts` (new), `src/lib/ipc.ts`, `src/lib/mockIpc.ts`, `src/pages/PulsePage.tsx`, `src/git/GitHistoryPanel.tsx`, `e2e/history.spec.ts` (new) | COMMS-9, PLATFORM-API-2/3 (M58.1), M54.1 manifest; = PRODUCT-3 / M64.2 |
| COMMS-4 | Transcripts become meeting records: people links, idempotent ingest, summary as a proposal | rebuild | adapt | M | high | `crates/call/src/outbound/ai_call_summarizer.rs:91-104,309-336`, `crates/call/src/inbound/toolset/read_call_record.rs`, `apps/docs/product/calls.mdx` | `src/engine/ingest.ts`, `src/lib/ingest.ts`, `src/agent/ProposalCard.tsx`, `src/lib/prompts.ts:267-269`, `src/pages/InboxPage.tsx`, `src/agent/mockAgent.ts`, `src-tauri/src/mcp.rs` (`propose_organize` description only) | M53.18 ProposalCard fix, DOMAIN:agents, DOMAIN:ai (= M64.7) |
| COMMS-5 | Persist per-item dismissals and fired claims, vault-scoped | rebuild | adapt | M (L as stage 2 specified) | medium | `crates/notification_state/src/lib.rs:49-56`, `docs/notification-state-migration.md`, `crates/notification/src/domain/item_preferences.rs` (do not port `None` = permanent) | `src-tauri/src/attention/preferences.rs:90-92`, `src-tauri/src/lib.rs:640-651`, `src-tauri/src/runtime/schema.rs`, `src-tauri/src/runtime/job_ledger.rs:46-69`, `src/stores/uiStore.ts:433,1034-1040`, `src/hooks/useReminders.ts`, `src/knowledge/LearnedCard.tsx`, `src/lib/mockIpc.ts` | AUTOMATION-8, CALENDAR-4 (one schema step, M64.3) |
| COMMS-11 | Per-lane "last looked" marker | rebuild | adapt | S | medium | `crates/notification_state/src/lib.rs:49-56` | runtime.db (new column/table), Home lanes, `src/lib/ipc.ts`, `src/lib/mockIpc.ts` | PRODUCT-1 / M64.4, D9 |
| COMMS-6 | Reminders reach Notification Center: honest permission + upstream delivery | rebuild (adapt) permission + adopt-upstream delivery | adapt | M | medium | `apps/web/tauri/src-tauri/src/macos_notification_permission.rs:43-75` (proprietary, design only), `apps/web/src/features/notifications/PendingNotificationNavigationEffect.tsx:23-60` (design only), `crates/model_notifications/src/lib.rs` | `src-tauri/Cargo.toml` (`objc2-user-notifications` 0.3.2 + plugin), `src-tauri/src/lib.rs`, `src-tauri/capabilities/default.json`, `package.json`, `src/hooks/useReminders.ts`, `src/pages/SettingsPage.tsx`, `scripts/mac-build.sh` | COMMS-5 (soft), DOMAIN:client-desktop; click-to-open needs M64.5 (Tauri 2.12) or UN delegate (= CLIENT-DESKTOP-6 / M64.6) |
| COMMS-10 | Recent messages: toasts stay readable after they fade | rebuild · Cerebro-native | — | S | medium | none (Macro has no toast log) | `src/stores/uiStore.ts`, `src/app/ToastHost.tsx`, `src/app/StatusBar.tsx`, `src/app/MessageLog.tsx` (new) | moves to DOMAIN:shell, fold into SHELL-17 |
| COMMS-12 | Per-conversation AI panel drafts | rebuild | inspire | S | low | `apps/web/src/lib/core/messages/create-message-composer.ts:16-39`, `apps/web/src/features/channel/Input/types.ts:29` (design only) | `src/agent/AiPanel.tsx:247,552`, `src/agent/conversations.ts` | moves to DOMAIN:ai |
| COMMS-3 | @agent in a discussion: one attended turn, placeholder then answer (gated) | rebuild | adapt | M | medium | `crates/channel_bots/src/domain/service.rs:604-672`, `crates/channel_bots/src/domain/trigger_detector.rs:14-25`, `docs/design/entity-messages.md` | `src/engine/agents.ts`, `src/agent/useDiscussionTurn.ts` (new), `src-tauri/src/mcp.rs`, tools.v1.json entry, `shared/policy/policy.v3.json`, `src-tauri/src/runtime/budget.rs`, `src/agent/mockAgent.ts`, `src/engine/tools.test.ts` | EDITOR-4a, M57 attended turns, DOMAIN:mcp; amends M33b D8 (= M70.4) |
| COMMS-7a | Spike: STT engine, model download, mic TCC on a packaged build | rebuild | inspire | S | low | `services/transcription/transcriber.py` | `src-tauri/Info.plist`, `src-tauri/tauri.conf.json` | owner STT choice; next wave |
| COMMS-7b | Local capture + on-device transcription → transcript inbox note | rebuild | inspire | L | low | `services/transcription/transcriber.py` (`VoiceClusterResolver`, final-only, uuid5), `crates/call/src/domain/service.rs` | `src-tauri/src/capture/mod.rs` (new), `src-tauri/Cargo.toml`, `src/lib/ingest.ts` | COMMS-7a, COMMS-4, DOMAIN:client-desktop |
| COMMS-7c | Transcript ↔ playback sync | rebuild | inspire | S | low | `apps/web/src/features/block-call/component/transcript-playback.ts:24,37-40` (design only) | `src/engine/transcriptPlayback.ts` (new), `src/workspace/FileViewer.tsx`, CSP `media-src` | COMMS-7b |
| COMMS-8 | Skip: channels, DMs, presence/typing, push/email digests, feed/bell, LiveKit calls, BroadcastManager, last_online_tracker code | skip | — | — | low | `crates/channels/src/domain/models.rs`, `crates/notification/src/domain/models/email_notification_digest.rs`, `crates/broadcast/src/lib.rs`, `crates/last_online_tracker/src/domain/services.rs` | — | Revisit only on owner decision (M33b §5 unresolved; D1, D9 pending) |
| ~~COMMS-2~~ | Page discussions — **dropped, merged into EDITOR-4a (L) + 4b (M)** (§8) | — | — | — | — | `docs/design/entity-messages.md`, `services/ai-editing-worker/src/comment-mark/anchor.ts:1-6,29-34` | see `03-editor.md` | D10 |

**COMMS-1 — attributed History** (read side only; stamps are M58.1)
- SELECT-only read model over `vault_writes`, `runs`, git and ledger verifications for `knowledge/` pages; proved by a
  `SQLITE_OPEN_READ_ONLY` connection (`ledger/index.rs:276` precedent), not a "test like fleet's" (none exists).
- One cursor, per-source has-more. Compare git with writes only inside the window both cover; anything older than the
  first `vault_writes` row reads "before recording"; `git log -50` (`git_commands.rs:20`) is a separate window.
- NULL actor → "unattributed"; days with no `app_sessions` row → "not recorded"; changes made while closed say so.
  Follow `vault.rename` chains for page History. Human label = `human:<actorId>` (`SettingsPage.tsx:254`), not
  `human:me` (M58.1 must match). Each source fails alone with its own section-unavailable line.
- `read_activity {from,to,path?}`: ≤100 rows newest-first, `truncated`, field names not ids, out-of-scope paths
  counted as withheld; a read_only `tools.v1.json` entry (M54.1), not a hand-written base tool.
- Changed-keys column: amend M58.1 or take its own `user_version` step. One fold rule shared with M58.1 coalescing;
  record that it departs from Macro's edit-free entity timelines. Keep the label History (Knowledge owns Activity).
  Kill the "invisible" comment at `write.rs:411-414`.

**COMMS-9 / 9b — honest history reads**
- 9: `Feed<T>` (`knowledge/BaseItself.tsx:49`) for `useFileHistory`, `useVaultPulse`, commit diff. Rust classifies an
  unborn HEAD as empty **before** the TS catch is removed (`pulse.rs:98`, `history.rs:62-66`; only `last_commit`
  tolerates it at `pulse.rs:157-162`) — else every new vault reads "unavailable". Non-repo → "History is off".
  A commit whose file list fails → files-unknown, not zero (`pulse.rs:112`).
- 9b: a failed probe never shows "Not tracked", never offers Enable history, never turns off auto or pre-turn agent
  checkpoints; Enable history refuses on an existing repo (today it runs `add -A` + commit, `commit.rs:55-68`).

**COMMS-4 — transcript → meeting record**
- Prerequisite M53.18: ProposalCard applies the Title, keeps the card and toasts when `patchFrontmatter` returns false.
- Speaker match: case-insensitive title, or slugified label vs stem/slug; exactly one match; exclude `knowledge/`;
  candidates only pages a person-kind field can target (`types.ts:47`, `schema.ts:399-422`). Not `authors.ts` as-is
  (stem/slug only, so "Tom Keller" never resolves). Fixtures use `entry.relationships`.
- Same bytes twice → "already filed as <title>" (`source_sha256`). Gate on `ingest_format` + `speakers`, no type
  literal. `organizePrompt` takes the entry; leave `systemPrompt.ts:25` untouched (M54.7). Agent attendees are checked
  against existing pages. Empty → "Nothing to summarize". Nothing written before Apply. Own prompt text.

## 7. Conflicts with Cerebro conventions

| Macro pattern | Cerebro rule | resolution |
| --- | --- | --- |
| Pushed notifications, bell, unread counts, digests | M8 nothing speaks first; M9 no idle chrome; M33b D7; M43 no bell | Pull-only. COMMS-10's control has no count (owner may prefer ⌘K-only). COMMS-6 = reminders the user set. Agent runs never notify (test lands after D9). Digests skipped |
| Lifecycle as Rust const fn mirrored in TS | Policy is data; twin rules are review-blocking | Any 3-state table ships as a `shared/policy` artifact with cases replayed by cargo + vitest — only once "seen" has a consumer (COMMS-11) |
| `snoozed_until` None = permanent mute | `Option`/null = not recorded | Do not port; permanence is an explicit state |
| One store read by search, agents, triggers | M9.5 / M17.15 agent text out of the corpus; knowledge writes only via `write_concept`/`verify_concept` | Discussion sidecar outside scan, search, distiller, backlinks (EDITOR-4); agent replies carry an actor; a thread on a concept can't write or verify it |
| Activity from Kafka into a fact table | Two records, two destinies; read models SELECT-only | COMMS-1 reads runtime.db + git + ledger; never appends to the ledger |
| Edit activity dropped on cache failure; digest never-tracked = `Duration::MAX`; NULL summary stores nothing | Absent is never zero; unavailable is never empty | Words: "unattributed", "not recorded", "before recording", "nothing to summarize", "summary unavailable"; sources fail alone |
| Calls as a typed entity with own tab | No type special-casing | COMMS-4 gates on fields + person-kind targets; no "Meeting" literal |
| Classifier-inferred follow-ups | Nothing speaks first; M33b D8 | Explicit `@handle` only; agent posts never start turns; COMMS-3 cites its D8 amendment |
| Comment mark serialized in the document | Files win; BlockNote mark is `blocknoteIgnore` (`nodeToBlock.ts:205-207`) | Sidecar anchors re-applied on every load — Cerebro's own work; spike proves byte stability, dirty state, undo |
| Per-type opt-out, global mute, bulk done | §33 preference firewall | Per-item only, read through `present()`; protected items refuse Done |
| Wrong-thread / anchor refusals | Every refusal names a policy code | COMMS-3 refusal + EDITOR-4 anchor refusals (`not_found`, `spans_blocks`, `ambiguous`, `occurrence_out_of_range`) need `policy.v3.json` codes |
| Optimistic overlays; failures as toasts | Store-layer invariant; proposal channels typed | Done/Undo catch, toast, return false; COMMS-4's summary stays a proposal card |
| "Record" button | "Not recording" banner = ledger writer (`RecordingBanner.tsx:7-20`) | COMMS-7 avoids the word "Record" |
| Name collisions | "Inbox" = capture queue; "Activity" = Knowledge tab; `receipts` = policy receipts / `WriteReceipt` | Feed stays History; no notification list called Inbox; rename COMMS-5's table |
| AGPL crates, proprietary web, prompt text | Apache-2.0; owner D0 | Behaviour only. Adopt upstream `tauri-plugin-notification` (Apache-2.0 OR MIT), `objc2-user-notifications` (Zlib/Apache/MIT), BlockNote comments (MPL-2.0). whisper licences unverified |
| A change falsifies comments | Comment-kill rule | `write.rs:411-414` (COMMS-1); `useReminders.ts:34,65` (COMMS-5); `useReminders.ts:46-59` web branch (COMMS-6); `ToastHost.tsx:5-8` (COMMS-10); `PropertyMenu.tsx:30-31` (EDITOR-4) |

## 8. Verification notes

- **Confirmed**: `vault_writes.actor` NULL everywhere (8 `shadow_write` callers + rename/delete pass None; dev DB 69
  rows, `count(actor)=0`); `write_text_file` / `import_attachment` record nothing; only `validate_v17` reads it.
  History catch-to-empty in Rust and TS. Ingest not idempotent, speakers plain strings. Reminders and insight
  dismissals in global localStorage. Duplicates with PRODUCT-3, AUTOMATION-8 + CALENDAR-4, CLIENT-DESKTOP-6,
  PRODUCT-11, EDITOR-4 (M53.15 row names only COMMS-9). Macro lifecycle and @Macro placeholder behaviour as described.
  Tauri 2.11.5, no media-src, no mic usage string. AI draft shared across conversations.
- **Refuted — COMMS-9 kept empty vs unavailable distinct**: an unborn HEAD errors in `git log`; without a Rust rule a
  new empty vault reads "unavailable".
- **Refuted — refreshGit failure only touches StatusBar/SyncBadge**: it also disables checkpoints and offers Enable
  history on an existing repo → split as COMMS-9b.
- **Refuted — y-prosemirror/yjs adds bundle weight**: `@blocknote/core` already ships both in Cerebro's chunk.
- **Refuted — COMMS-6 adopt-upstream gives honest permission**: plugin returns Granted on every desktop
  (`desktop.rs:184-199`), posts as Terminal in dev, can't remove delivered notifications on macOS → permission is a
  rebuild via `objc2-user-notifications`.
- **Refuted — COMMS-10's Macro guide is a toast log**: `useKeyedPersistentToasts.ts` is keyed dedupe (SHELL-17).
- **Refuted — playback uses a 250 ms lead**: `transcript-playback.ts:37-40` also requires `t >= start`, so the lead is
  inert; COMMS-7c chooses "latest start ≤ t" explicitly.
- **Refuted — speaker match via `authors.ts`**: stem/slug only; new matching rule in COMMS-4.
- **Refuted — "a test like fleet's"**: `fleet.rs` has no never-writes test; use a read-only connection.
- **Refuted — COMMS-5 is M as specified**: schema step + artifact = L (`roadmap.md:93`); rescoped to M on existing
  `preferences.rs` dismissals and `job_ledger` claims.
- **Refuted — no last-online analog in Cerebro**: `app_sessions` exists (COMMS-8 rationale corrected; skip covers
  Macro's code, not the need).
- **Refuted — "invisible" comment at `write.rs:261-264`**: now `write.rs:411-414`.
- **Partial**: BlockNote comments without Yjs set marks directly, but marks never persist → re-anchor on load; dirty
  state/undo unproven. Plugin 2.5.0+ needs Tauri ^2.12; 2.4.0 fits 2.11.5; desktop `onAction` only in 2.6.0, so D12 is
  needed only for click-to-open. COMMS-1 needs a changed-keys column M58.1 lacks. Macro folds runs with no time gap;
  the 5-min rule is a write-time debounce. Toast sites 176 lines in 55 files (not 184/57). COMMS-5 comment targets are
  `useReminders.ts:34,65`; `uiStore.ts:396-399` stays true.
- **Unverifiable**: WKWebView `Notification` inertness (measure on the installed app before sizing COMMS-6); owner
  acceptance of D9/D10 (only D0 is decided).
- **Adjustments applied**: COMMS-2 dropped into EDITOR-4a/4b (XL breaks the L cap); COMMS-7 split S + L + S;
  COMMS-6 mode changed, "missed while closed" moved to AUTOMATION-8 via `app_sessions`; COMMS-10 moved to shell;
  COMMS-3 depends on EDITOR-4a and gains placeholder recovery (`budget.rs:853-854`), policy code, manifest entry,
  idempotent placeholder id.
- **Missed, folded in**: `app_sessions` (COMMS-1/6, AUTOMATION-8); COMMS-11 last-looked; COMMS-9b probe; unborn HEAD;
  COMMS-12 drafts; reminder click intent (COMMS-6); source windows + rename chains + `human:<actorId>` (COMMS-1);
  placeholder after failure/quit (COMMS-3); batch ingest waking triggers per file → note for AUTOMATION-4.

## 9. Where to read first

1. `crates/activity/src/lib.rs`
2. `crates/messages/src/domain/service/timeline.rs`
3. `crates/activity/src/domain/timeline.rs`
4. `apps/web/src/features/activity/core/collapse-runs.ts` + `group-events.ts`
5. `apps/docs/AI/mcp/tools/read-activity.mdx`
6. `crates/call/src/outbound/ai_call_summarizer.rs` and `crates/call/src/inbound/toolset/read_call_record.rs`
7. `crates/notification_state/src/lib.rs` + `docs/notification-state-migration.md`
8. `docs/design/entity-messages.md`
9. `crates/channel_bots/src/domain/service.rs:604-672` and `crates/channel_bots/src/domain/trigger_detector.rs`
10. `crates/messages/src/domain/models.rs` and `crates/messages/src/domain/effects.rs`
11. `crates/notification/src/domain/item_preferences.rs`
12. `docs/AGENT_GUIDE/channels.md`
13. `services/transcription/transcriber.py` (constants, `VoiceClusterResolver`)
14. `apps/web/src/features/block-call/component/transcript-playback.ts`
