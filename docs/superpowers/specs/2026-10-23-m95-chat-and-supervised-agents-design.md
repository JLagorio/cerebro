# M95 — Chat and supervised agents design

**Milestone:** M95 · **Phases:** M95.1–M95.7 · **Requirements:** CHAT-01–CHAT-09.

[Master roadmap](../plans/2026-10-23-m93-m99-master-roadmap.md) · [Research and traceability](2026-10-23-m93-m99-research/README.md).

**DRAFT FOR OWNER REVIEW — 2026-10-23.** This proposes M95, covering AX00,
AX05, AX08 and CP09. It authorizes no implementation. Source inspection is fresh
for this document; no application, CLI recording or test was run. Thresholds,
retention choices and new interfaces below are proposals, not existing guarantees.

## Intent and boundaries

A person should be able to choose material, ask, understand contributions and
decisions, save a useful result and recover the conversation later. Completing a
chat should not require understanding transport IDs. Recovering one must still
explain which writes happened and which outside effects remain uncertain.

Keep the user's Claude Code CLI as the default backend and its existing sign-in.
No API key enters Cerebro. Keep React, the one persistent assistant instance and
files-first workspace authority. A conversation archive is operational data outside
the vault: it must not become material the knowledge distiller learns from. This
work does not replace the action broker, workflow engine, knowledge ledger,
editor writer or history scope service. It does not promise unattended execution,
an OS sandbox, private reasoning access or exactly-once outside mutations.

Three forms of delegation remain distinct:

- A **foreground researcher** is M91's bounded worker inside a parent CLI run,
  using the parent's authority and attribution.
- An **Agent handoff** is the existing operation that starts a separately granted
  actor/run and returns a link. Returning that link does not mean completion.
- A **supervised child job** is the proposed Rust-owned child with an explicit
  scope, schema, accounting and lifecycle. Naming an Agent as its instruction
  source never imports that Agent's greater grants.

## Current evidence and reconciliation

The [M91 implementation record](../plans/2026-10-23-m91-implementation-record.md)
now reports all seven waves plus final fixes. It also records **11 unit-test
failures and 42 E2E failures**, baseline qualifications, remaining seated-run
recordings/native smoke and known gaps. These are the prior implementer's reported
results, not tests rerun for this review and not a zero-failure gate. The
[M92 plan](../plans/2026-10-23-m92-conversation-rail.md) and current source must be
reconciled at a fixed handoff revision; its plan header alone cannot describe all
concurrent implementation. M95.1 records existing work and assigns demonstrated
remaining gaps instead of rebuilding M91 or M92.

The previous [M91 audit](../plans/2026-10-22-ai-expansion-review/m91-current-state.md)
is dated evidence. These claims have changed in current source:

| Area             | Current observed implementation                                                                                                                                                                                                                             | Remaining acceptance boundary                                                                                  |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Policy/execution | [shared policy](../../../shared/policy/subagents.v1.json) contains researcher preset, seated environment, hardening, foreground-only/depth/concurrency/session caps; [CLI definitions](../../../src-tauri/src/agent/cli_agents.rs) and argv admission exist | Record actual pinned CLI behavior and fail-closed drift; do not call policy fields a proven isolation boundary |
| Projection       | [transcript reducer](../../../src/agent/transcript.ts) routes parent-tagged events recursively, preserves ordered parts and child errors; [types](../../../src/agent/types.ts) include children and anchors                                                 | Integrated live/replay/recovery equivalence with recorded child traces                                         |
| Cache            | [conversations](../../../src/agent/conversations.ts) keeps 30 threads, ordered non-reasoning parts and child summaries capped at 500 characters; quota fallback trims bodies                                                                                | This is a bounded browser cache, not the proposed durable searchable archive                                   |
| Context/branch   | [context pull](../../../src/agent/useContextUse.ts), memory-only Rust ContextBook and [checked fork](../../../src-tauri/src/agent/transcript.rs) exist                                                                                                      | Recorded availability, fork ancestry and unavailable-session journeys                                          |
| Presentation     | [AiPanel](../../../src/agent/AiPanel.tsx), [ChatTurn](../../../src/agent/ChatTurn.tsx), [RunTranscript](../../../src/status/RunTranscript.tsx), element adapters and import-on-send [attachments](../../../src/agent/attachments.ts) are present            | Actual supported surfaces and persistent identity need final interaction/native evidence                       |
| Accounting       | [meter](../../../src-tauri/src/agent/meter.rs) has modelUsage whole-tree handling, partial/unknown cases and child exclusion from parent facts                                                                                                              | Recorded CLI conformance, resumed cumulative accounting and no double charging                                 |

The old flat-reducer/absent-branch/absent-context/unused-elements premise must not
be copied into implementation tasks. M91 closure is a contract and evidence audit
with fixes only for demonstrated gaps. Conversely, existing Retry in AiPanel
still asks the prior question again; it is not a durable step checkpoint.
RunTranscript currently explains that CLI files are the source and Cerebro keeps
no transcript copy. A new archive must deliberately replace that copy and disclose
its different retention. Source-encounter helpers do not prove a supporting read.

## Approaches and recommendation

Keeping the browser cache alone is inexpensive, but loses searchable completed
content under quota pressure or CLI cleanup. Copying every CLI line would preserve
more detail while duplicating sensitive tool payloads, private-session details and
an unstable external format. The recommended approach is a **bounded Rust-owned
normalized archive** with explicit content retention, immutable identities and
incremental reads; native CLI files remain the source for optional detailed trace
healing while they exist. Archive readability and CLI resumability are separate.

For delegation, finish and prove foreground researchers first. A broader CLI
preset alone cannot establish independent scope. Introduce supervised child jobs
only after a capability proof demonstrates child-specific execution credentials,
blocked raw bypass paths and enforceable grants. Initially jobs run only while the
desktop app can dispatch. Persisting their state supports explanation after a
restart; it does not make the process continue while closed or asleep.

## Requirements

**CHAT-01 — Reconcile the M91/M92 handoff before expansion.** Reconcile each owned phase against current
source, recorded fixtures and acceptance artifacts. Keep existing implementations;
repair demonstrated contract gaps in their current fold/reducer/adapters. The baseline handoff classifies existing evidence and assigns open cases without requiring M93's final repair acceptance first. Final release completion
requires sanitized real-CLI evidence plus M93's packaged/native acceptance, with
blocked cases explicitly marked. Synthetic fixture success alone cannot close it. Explicitly exercise mid-stream reattachment before Done, not only the healed final reply; browser quota pressure with a live thread; and missing CLI history. A source-only or known-failure baseline cannot be labeled green.

**CHAT-02 — One identity and projection.** A thread, message and generation attempt
have stable opaque IDs and an originating vault ID. One normalized projection
owns live delivery, replay, reattachment and archive rendering. Parent text cannot
be overwritten by child text; narration, answer, tool state, reasoning summary,
child contribution and effect references retain their distinctions. Unknown counts
and unavailable reads use words under CV-05. Reasoning text remains memory-only
and is optionally healed from CLI files under existing policy; the archive adds no
reasoning persistence. The assistant retains its thread, draft, pending decisions,
selection and streaming ownership across floating, docked, canvas and minimization.

**CHAT-03 — Durable archive with honest availability.** Rust owns thread metadata,
branch ancestry, message/attempt references and retained normalized completed
content. Reads are scoped by vault and cursor, with stable order and incremental
pages. Metadata-only, content-expired, CLI-session-unavailable and read-failed are
separate states. Search covers only retained normalized content within the selected
vault. Opening an archive never starts generation or imports it into the corpus.
Archive persistence is produced by the Rust run lifecycle even when the person has switched threads or the webview is detached. An `append_completed` API without that producer is not a complete feature. Existing live journal cursors retain their sequence-gap semantics; archive sequence
numbers never substitute for live attach cursors.

**CHAT-04 — Context receipts.** Freeze a turn's selected scope before dispatch,
including queued turns and navigation changes. Record selected source references,
included-at-start outcomes and later read references separately. Each source has
an evidence ID, source identity/version, observation time, location reference where
available and outcome `included | not_read | unavailable | truncated | unsupported`.
An outcome describes delivery/read-boundary evidence, never proof that a model
understood or relied on it. Credentials, full confidential prompt assembly and
context token readings are excluded. Keep M91's memory-only pull for token use.
Passage resolution and evidence identity consume [KNOW's shared source contract](2026-10-23-m97-knowledge-evidence-and-evaluation-design.md): inline `SourceLocator {version:1,vaultId,path,sourceHash,kind:'body'|'property',bodyUtf8Range?,propertyKey?,quote,prefix,suffix}` and `EvidenceRef {runId,assemblyId?,sourceId?,locator?,role,recordedAt}`. Body ranges are UTF-8 over the body excluding frontmatter; roles distinguish selected, encountered, read, cited and supporting. Receipts store `location: SourceLocator | null`, not an opaque locator ID requiring a second lookup store. Quoted context follows chat retention and current source access checks; revoked scope hides it rather than leaking archived excerpts. KNOW resolves exact, relocated, changed, unavailable or unsupported without guessed first matches.

**CHAT-05 — Attachment readiness and useful artifacts.** Extend M91's existing
copy-in path with readable preparation outcomes. A failed copy or unsupported read
preserves the draft and chip; Send cannot silently omit selected material. An
explicit “Send ready material” choice, if offered, records omissions. Attachment
copies are actual vault objects with their existing undo; chat deletion does not
delete them. An artifact identifies `preview | workspace | external`, producing
attempt, media kind, source/effect references and version where recorded. Provide
Save answer, Add selection to page, Open, Compare and Export only when supported.
Copy is available on completed user/assistant text through the existing presentation element; Edit question creates a new draft and never rewrites an old attempt. Ask again and Branch use CHAT-06 semantics, including current capability and recovery checks. Actions are keyboard reachable and remain usable when hover is unavailable. Preview to saved is an explicit human guarded write with current version checks
and undo. Comparison requires comparable known versions. No raw generated HTML
runs with app privileges. Saved pages do not change automatically on regeneration.
For selected-text AI (PL05), reuse the current AskAiPopover/SelectionToolbar and one editor: freeze the selected passage, owning page/version and mapped editor range before generation; show the proposed change for review. Apply checks that the exact original passage/range still belongs to that page/version through the existing editor transaction and guarded save lifecycle, forming one undoable edit. Cancel changes no page bytes. A changed page or selection produces a visible conflict with reselect/regenerate actions, never replacement of today's arbitrary selection or a second editor/writer.

**CHAT-06 — Explain recovery before consequential repetition.** A read-only summary
combines recorded local receipts, existing pending decisions, CLI session
availability and broker effect references. Offer “Ask again”, “Continue session”,
“Branch from here” and broker-owned reconciliation/retry as separate operations.
Ask again creates a new attempt linked to the prior attempt, carries no spent approvals
and presents the recovery summary before it can propose another mutation. Its recovery
context retains the prior uncertain invocation references; changing a generation
attempt ID cannot bypass reconciliation or create retry authority. Continue is available
only after current session checks; Branch changes ancestry and says “Files stay as
they are”. Unknown foreign outcomes remain `outcome_unknown`; a cancelled parent
never proves an outside mutation was prevented. If effect evidence cannot be read,
show unavailable and block effect retry. Never infer broker `canRetry` from text.

**CHAT-07 — Supervised jobs require enforceable scope.** Admission freezes objective,
parent run/attempt, instruction source version, input evidence references, output
schema version, actor and grant intersection, budget and deadline. Effective grant
is the intersection of parent authority, proposed child scope, optional Agent-page
maximum and local policy. Recheck revocations at dispatch. Reject empty, invalid or
unsupported scope rather than widening it. Use a separate run/session and execution
subject; no inheritance of parent connector secrets or unbrokered provider route.
The existing CLI is used only if the capability proof passes; otherwise this mode
stays unavailable and foreground research remains supported.

**CHAT-08 — Bounded lifecycle and attribution.** Child jobs have states `queued`,
`running`, `waiting_approval`, `stopping`, `succeeded`, `failed`, `cancelled`,
`interrupted`. A unique local claim admits a job once; recovery marks abandoned
claims interrupted and does not automatically repeat effects. Parent cancellation
requests cancellation of queued/running children and preserves finished results.
A job whose dispatched actions remain uncertain cannot claim cancellation proved
no effect. Children cannot outlive the parent automatically: detach/background is
a separate owner decision. Validate bounded output against its frozen schema and
return explicit invalid/partial results. Attribute each action and usage fact to
one run; whole-tree aggregates include each child once, preserving unknown shares.
Initial proposed limits reuse M91's one-level/two-concurrent/eight-per-session
ceilings, plus a ten-minute child deadline and 256 KiB validated result cap. These
are new job proposals, not claims about current enforcement.

**CHAT-09 — Retention is a product contract.** Recommended owner decision: keep
completed normalized chat content for 90 days by default, with `off`, `30 days`,
`90 days` and `forever` choices, explicit thread deletion and JSON/Markdown export.
This improves recovery past the CLI's usual cleanup without archiving every raw
tool payload. Age starts at attempt completion, not last viewing; retained messages
in an active thread age independently. `off` stores live recovery essentials until
settlement but no completed message bodies. Existing installations require an
explicit retention choice before adding newly durable content; no retroactive
whole-session copy. Until the owner approves, the existing behavior remains.

Metadata needed to find expired conversations may remain, labeled content expired;
explicit deletion removes title, body, receipts, artifact previews and search
entries. The archive deletion behavior deliberately amends CV-30's existing delete-stops-run rule when enabled; M95.3 updates that convention and tests together. Until that phase ships, current deletion behavior remains. Explicit deletion returns `blocked_active` while a generation, child job or pending approval still owns the thread; the UI offers separate Stop and decision-resolution controls. Deletion itself invokes none of them. After those owners settle, retrying Delete removes archive content; terminal unknown effects may remain independently recorded. Expiry prunes only completed content and never the live recovery/approval material. Pending/unknown effect evidence stays in ACT's minimal independent store,
with an anonymized thread reference where necessary; deletion never cancels or
retries an effect. Full child traces and reasoning stay outside the archive.
A proposed 256 MiB content budget stops archive body admission with a visible
warning when full; never silently evict unexpired/forever content. Export allows
reclaiming space, and generation can continue with an explicit archive-unavailable
status. Expiry/deletion invalidates search and derived copies transactionally;
CHAT owns the numbered runtime schema migrations, content/index transactions and physical-cleanup attempts in its archive task. `PruneReport {removedMessages, removedSearchRows, logicalBytesReleased, cleanup:completed|deferred|failed, retryAfter?, safeReason?}` distinguishes logical deletion from best-effort WAL checkpoint/free-page cleanup. Busy readers defer cleanup visibly; never delete unknown backups or treat a checkpoint as secure erasure. Document surviving SQLite/WAL and user-managed backup/export copies. Do not promise secure erasure or deletion of CLI-owned sessions,
exported copies or saved vault artifacts.

## Data, API and authority contracts

All types here are **proposed**. IDs are opaque strings; timestamps are UTC.
`ThreadRecord` holds `id`, `vaultId`, `title`, `place`, `createdAt`, `updatedAt`,
`parentThreadId?`, `branchMessageId?` and content availability. `AttemptRecord`
holds `id`, `threadId`, `userMessageId`, `assistantMessageId`, `runId`,
`retryOfAttemptId?`, CLI session/anchor references, completion time and content
expiry. The completed ArchiveTurnV1 carrier stores normalized text/ordered non-reasoning blocks,
bounded child summaries and action/evidence references, not raw tool inputs/results.

### Archive producer and projection ownership

M95.2 introduces a versioned `ArchiveTurnV1` containing immutable attempt/message
identities, the frozen display-only user message, completed non-reasoning folded text blocks in recorded order, bounded
tool-state/child-summary rows, source/effect references, completion status and
`complete | partial | unavailable` content availability. It is **not** a serialized
React `ChatMessage`, raw CLI log or persisted live journal. The Rust allowlist
excludes reasoning, raw tool arguments/results, credential material and context
usage. Rust filters the existing `agent::fold` output into this carrier; it does
not parse the CLI again or create another full transcript reducer. The existing
TS transcript reducer receives a checked archive adapter, with shared fixtures
showing the same retained answer/ordering as live/replay after the documented
lossy fields are removed. Search text derives from the retained text blocks only.

Before launch, the existing seated start path binds `{vaultId, threadId,
attemptId, userMessageId, assistantMessageId, displayMessage}` to its durable run ID after
validating thread scope. `displayMessage:{text,addressedLabel?,attachmentRefs}` freezes exactly the human-visible question/chips before CLI prompt composition, under the shared carrier byte cap and retention choice. Do not reconstruct it from session `UserPrompt`, which may contain generated addressing/context material; do not persist outgoing/system prompt assembly. `begin_attempt(binding, requestKey, contentChoice)` is
idempotent on a scoped key/digest and cannot authorize a run by caller-supplied
IDs. A retry after a lost start acknowledgement returns the original attempt/run
status rather than spawning a second generation. The Rust run-completion path
calls `append_completed(binding, ArchiveTurnV1)` after its final fold; this is an
internal writer, not a client endpoint accepting a claimed completed transcript.
A deferred permission process ending is not a completed generation: linked resume
runs keep the same attempt until its actual terminal state. Terminal failure,
Stop and spawn failure also settle attempt state without inventing answer text.

Collection is bounded in memory while live, using the existing journal's per-run
byte/event ceilings as an initial shared policy value, but does not rely on the
journal retaining the whole answer. If that bounded collection is incomplete,
completion may recover through the existing folded session reader at the recorded
turn anchors; unavailable recovery records `partial` or `unavailable`, never a
complete answer. Persistence errors remain visible and never roll back a completed
external action. Crash before terminal archive commit recovers from the recorded
run/anchor through that same reader when available; otherwise it records an
interrupted/unavailable attempt. It never reruns the prompt to reconstruct content.
Deletion and expiry tombstones reject late completion/recovery writes so deleted
content cannot reappear. Retention-off does not retain completed bodies.

Rust conversation service exposes `list_threads(vault_id, cursor, limit)`,
`read_messages(vault_id, thread_id, before, limit)`, `search_threads(vault_id,
query, cursor, limit)`, `import_legacy(vault_id, records)`, `delete_thread(vault_id,
thread_id)` and `export_thread(vault_id, thread_id, format)`. Query limits are
clamped to 50 and exports stream rather than materializing the full archive. A
transactional append keyed by attempt/message IDs makes duplicate delivery
idempotent; live execution remains in its existing journal and scheduler.

CHAT consumes ACT's canonical `ActionEffectRef { invocationId, state, approvalId,
accountLabel, canReconcile, canRetry }`; nullable labels mean not recorded or
unavailable. ACT states are `prepared | awaiting_approval | ready | dispatched |
succeeded | failed | outcome_unknown | cancelled`. Rust read is
`ActionService::effect_ref(subject: ActionSubject, invocation_id: InvocationId)
-> Result<ActionEffectRef, ActionReadError>`, where `ActionSubject` carries
`vaultId`, `runId`, `actorId`, nullable `childJobId` and nullable `clientId`.
Only ACT computes retry/reconciliation authority and owns approval/effect state. `ActionSubject` is derived by Rust from authenticated session/token/stored-run context; client-supplied IDs never grant authority. For inspection, use scoped `effect_details(subject, invocation_id) -> Result<ActionEffectDetails, ActionReadError>` with canonical revision, safe account/target, redacted asked/approved previews and attempt receipts. Retry/reconcile/cancel compare the returned invocation revision; approval decisions also compare approval revision. A stale card refreshes without dispatch or lost draft. ACT's unresolved-effect fence applies across fresh attempt IDs. CHAT stores references and renders that answer; no second action ledger or semantic deduplication is created.

Proposed `ChildJobSpec` includes fields in CHAT-07 and `resultSchemaId`; the admitted record adds immutable `jobId`. `ChildJobService::submit(subject, requestKey, spec)` returns a recorded admission or typed refusal. The caller durably records `requestKey` before submission: for FLOW this binds workflow run/step/attempt, for chat parent run/attempt/delegation slot. CHAT atomically maps trusted subject scope plus requestKey to jobId and immutable request digest before launch. The same request after a crash returns the original job after scope revalidation; a changed digest returns `request_key_conflict`. Crash after job creation but before FLOW saves the link therefore cannot spawn another job. `cancel(subject, jobId)` records a distinct cancellation request; `read(subject, jobId)` returns scoped state/results. CHAT owns `runtime/conversations.rs` and `runtime/child_jobs.rs`, their numbered migrations, append/claim/lease/recovery transactions and CLI adapters using existing runtime writer patterns. CORE supplies cross-cutting conventions and generated-contract guidance, not an unplanned storage/purge service. FLOW consumes job IDs without another scheduler.

## Compatibility, acceptance and owner gates

Import valid browser-cache entries once per stable legacy ID, scoped to their
recorded vault. Leave unbound/other-vault entries outside the import with an
explanation. A crash during migration must safely repeat; never clear the browser
copy until durable commit and readback succeed. Restore live attach state through
its existing service instead of treating it as completed archive data. Preserve
CLI-owned configuration, sign-in and recorded session path rules.

Acceptance requires recorded parent/child live-replay equivalence; absent/malformed
usage; session swept vs unavailable; interrupted write plus uncertain external
effect; duplicate decisions; off/expiry/delete/export; migration interrupted at
commit; stale source links; child scope attacks; and one assistant instance through
all presentations. M93 supplies native IME/focus/flush/readiness/history acceptance;
KNOW supplies source navigation; ACT supplies action authority; CHAT implements archive/job transactions and cleanup, following existing runtime conventions and CORE contract guidance. Evidence must name build/CLI identity and distinguish
pass, defect and environment-blocked.

Owner decisions before implementation are the archive recommendation (90-day
versus opt-in-only), content budget/purge disclosure, exact child limits, whether
initial supervised children remain read-only, and accepting the backend capability
proof. Recommended first child release is read-only; mutations wait for ACT's
approval/recovery acceptance. Background work, alternative API backends and
full-trace archival require separate proposals. Research lineage is the
[chat journeys](../plans/2026-10-22-ai-expansion-review/chat-and-agent-experience.md),
[AppFlowy dossier](../plans/2026-10-22-ai-expansion-review/appflowy.md) and
[n8n dossier](../plans/2026-10-22-ai-expansion-review/n8n.md); their observed patterns
inform this design without claiming runtime parity.

Review corrections: CHAT owns archive/job storage, leases and cleanup; deletion while active is blocked rather than implicitly stopping generation or cancelling effects; inline KNOW locations and ACT revisioned details replace undefined lookup/review dependencies. Selected-text AI and durable child submission crash recovery now have explicit bounded acceptance.

## M91–M92 integration boundary

[M92 — The conversation rail](../plans/2026-10-23-m92-conversation-rail.md) remains the owner of the canvas-only Conversation details rail, its read-only cards, shared Context pull, Plan/Subagents/Changes/Sources/Handed off adapters, reach/thread-status facts and canvas-safe navigation. Reconcile the accepted M91→M92 handoff at its recorded revision before this milestone changes those shared files; preserve the single assistant instance and live state. Unfinished or unverified M91/M92 work stays assigned to its existing milestone, with dependent work waiting on that gate.

M95 source-context receipts record source delivery and evidence provenance; they do not persist context-token readings or add a second context poll. The read-only rail may link to the owning inspection/settings surface. New managed account/action controls need M96 ownership and must not silently replace M92 rail behavior.

## Final source cross-check

[AppFlowy message persistence](../../examples/AppFlowy-main/frontend/rust-lib/flowy-ai-pub/src/persistence/chat_message_sql.rs)
shows transactional message upsert and cursor reads, while its
[chat service](../../examples/AppFlowy-main/frontend/rust-lib/flowy-ai/src/chat.rs)
connects producers to local/remote loading. That supports a complete service and
producer contract, not just a proposed SQL table. Its
[message actions](../../examples/AppFlowy-main/frontend/appflowy_flutter/lib/plugins/ai_chat/presentation/message/ai_message_action_bar.dart)
and [save-to-page transaction](../../examples/AppFlowy-main/frontend/appflowy_flutter/lib/plugins/ai_chat/application/chat_edit_document_service.dart)
inform concrete Copy/Save/Append journeys. Cerebro keeps its existing single
editor writer rather than opening a second editor instance as a porting shortcut.
[Macro's transition/reconnect tests](../../examples/macro-main/crates/agent_session/src/domain/service/test/turn_projection.rs)
reinforce durable lifecycle identity and reconciliation before new delivery;
Cerebro retains its own CLI/fold model rather than importing Macro's hosted log.
