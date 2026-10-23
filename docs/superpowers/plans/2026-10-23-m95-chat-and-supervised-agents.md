# M95 — Chat and supervised agents

**Milestone:** M95 · **Phases:** M95.1–M95.7 · **Requirements:** CHAT-01–CHAT-09.

[Master roadmap](2026-10-23-m93-m99-master-roadmap.md) · [Research and traceability](../specs/2026-10-23-m93-m99-research/README.md).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reconcile the M91→M92 acceptance handoff, then deliver recoverable conversations, useful artifacts and independently scoped child jobs behind demonstrated execution boundaries.

**Architecture:** Preserve the existing fold/reducer, CLI default and persistent React assistant. Rust adds a normalized operational conversation archive and supervised-job lifecycle; the shared action broker remains the sole effect/approval authority. CHAT implements archive/job migrations, transactions, leases and cleanup using existing runtime patterns. CORE supplies contract guidance, KNOW supplies evidence navigation and M93 supplies native/readiness acceptance.

**Tech Stack:** Tauri 2, Rust, rusqlite/runtime migrations, React 19, TypeScript, Vitest, Playwright, existing Claude Code CLI and recording kit.

**Spec:** [Conversations and supervised child jobs](../specs/2026-10-23-m95-chat-and-supervised-agents-design.md).

**Status:** DRAFT FOR OWNER REVIEW. Documentation only; none of the checks below was run. Proposed paths are labeled Create. Owner decisions and dependency gates must be resolved before implementing their dependent tasks.

## Global Constraints

- Keep the user's Claude Code CLI as the default backend and its existing sign-in. No API key enters Cerebro.
- Keep React, the one persistent assistant instance and files-first workspace authority.
- Reasoning text remains memory-only and is optionally healed from CLI files under existing policy; the archive adds no reasoning persistence.
- Only ACT computes retry/reconciliation authority and owns approval/effect state.
- Unknown foreign outcomes remain `outcome_unknown`; a cancelled parent never proves an outside mutation was prevented.
- Initial proposed limits reuse M91's one-level/two-concurrent/eight-per-session ceilings, plus a ten-minute child deadline and 256 KiB validated result cap.
- Recommended owner decision: keep completed normalized chat content for 90 days by default, with `off`, `30 days`, `90 days` and `forever` choices, explicit thread deletion and JSON/Markdown export.
- A proposed 256 MiB content budget stops archive body admission with a visible warning when full; never silently evict unexpired/forever content.
- Existing installations require an explicit retention choice before adding newly durable content; no retroactive whole-session copy.
- No suite runs, app runs, installations, staging or commits are authorized by this draft. Future commits use `type(scope): sentence (M95.<phase>)` under its M95 phase; never bypass hooks.

## Review Focus

1. Duplicate, late and orphan child events: parent answer and child identity remain stable; M95.1 tests the recorded projection and orphan labeling.
2. A crash between archive import and browser cleanup: reopening never loses or duplicates the thread; M95.2 tests every transactional boundary.
3. Off/expiry/delete with pending or unknown effects: content/search are removed while ACT recovery references survive; M95.3 tests both stores through their authority boundary.
4. Retry after an uncertain outside mutation: UI cannot replay it by resending a question or guessing `canRetry`; M95.5 tests unavailable broker reads and unknown effects.
5. Child scope escalation, account swap and cancellation races: no wider grant reaches dispatch and a completed effect survives Stop; M95.6/M95.7 test adversarial admission and settlement.

---

## File map and interfaces

Existing seams to extend: `src/agent/transcript.ts`, `types.ts`, `conversations.ts`,
`useConversations.ts`, `agentIpc.ts`, `AiPanel.tsx`, `ChatTurn.tsx`, `ChatInput.tsx`,
`attachments.ts`, `context.ts`, `toolRenderers.tsx`; `src/status/RunTranscript.tsx`;
`src-tauri/src/agent/{mod,transcript,meter,interaction}.rs`;
`src-tauri/src/runtime/{mod,schema}.rs`; `src/agent/useAgentChat.ts` and its attach/start owners; and command registration in
`src-tauri/src/lib.rs`. Use existing AI elements through adapters; preserve CV-64.

Proposed new units:

| Create                                                             | Responsibility                                                      |
| ------------------------------------------------------------------ | ------------------------------------------------------------------- |
| `src-tauri/src/conversations/{mod,types,commands}.rs`              | Conversation service, wire data and thin IPC                        |
| `src-tauri/src/runtime/conversations.rs`                           | Scoped archive transactions/import/search and pruning               |
| `src-tauri/src/conversations/{retention,export}.rs`                | Policy/expiry and streamed export                                   |
| `src/agent/conversationArchive.ts`                                 | Agent IPC adapter and legacy import conversion                      |
| `src/agent/ConversationRetention.tsx`                              | Existing Settings surface's archive choices/status                  |
| `src/agent/{contextReceipt,artifacts,recovery}.ts`                 | Surface adapters over evidence/artifact/effect contracts            |
| `src/agent/{ContextReceipt,ArtifactActions,RecoverySummary}.tsx`   | User inspection/actions with existing DS/AI elements                |
| `src-tauri/src/agent/child_jobs/{mod,types,admission,dispatch}.rs` | Job lifecycle, immutable spec, scoped admission and backend adapter |
| `src-tauri/src/runtime/child_jobs.rs`                              | Transactional claims and restart settlement                         |
| `src/agent/childJobs.ts`                                           | Typed job IPC adapter                                               |
| `e2e/{conversation-archive,agent-recovery,child-jobs}.spec.ts`     | Integrated journeys                                                 |
| `docs/superpowers/validation/chat-cli/README.md`                   | Real CLI case manifest and limitations                              |

Rust test modules live beside these units; TS tests use matching `.test.ts` or
`.test.tsx`. No parallel transcript reader, action ledger or scheduler is added.
CHAT allocates its next numbered archive/job migrations in runtime/schema.rs and registers them in runtime/mod.rs at implementation time; do not reserve a schema number in this draft. Follow existing writer transactions and CORE cross-cutting conventions. Shared wire names are camelCase. Rust opaque ID
newtypes serialize as strings; cursor contents are opaque and vault-bound.

## M95.1 — Reconcile M91 and M92 before expanding their promise

**Requirements:** CHAT-01/02; AX00 and CP09 trace foundation.

**Files:** Inspect/repair demonstrated gaps in existing `src/agent/transcript.ts`,
`conversations.ts`, `useContextUse.ts`, `elements/`, `src-tauri/src/agent/{fold,
transcript,meter,cli_agents,interaction,mod}.rs`, shared subagent policy/loaders.
Tests: existing corresponding Rust/TS tests, `e2e/m91-subagents.spec.ts`,
`e2e/agent-transcript.spec.ts`, `e2e/floating-assistant.spec.ts`.
Create validation README above and sanitized real fixtures through the existing
`scripts/cli-record/` kit. Do not overwrite synthetic fixtures without provenance.

**Interfaces:** Preserve `applyEvent`, `replayTranscript`, `healFromTranscript`,
`CliSession::Fork`/`check_fork`, `ContextBook` and existing attach cursors. Evidence
record: `{caseId, sourceRevision, buildId, toolchain, cliVersion, expected,
observed, result: pass|defect|environment_blocked, sanitizedArtifactRefs}`.
M93 consumes this record and supplies native acceptance status separately.

- [ ] Read the current M91 implementation record and reconcile every M91 phase and the accepted M92 rail/transport handoff, including already-present M91.15 lab/e2e files, into implemented/source-only, recorded-pass, defect or blocked evidence. Keep the older audit dated; do not rewrite history to claim today's absence.
- [ ] Add `reattach_keeps_each_text_block_once_before_done`, `busy_quota_trim_preserves_prior_turn_availability`, and `quota_retry_does_not_repeat_full_trim_per_delta` in existing useAgentChat/transcript/conversations tests. Hold the stream between deltas and assert text/order before Done and after healing; force quota failure with prior turns plus a live reply, missing CLI history and a repeated save. Keep the draft/live attach identity, expose loss/unavailability honestly and never treat a later healed answer as proof the intermediate UI was correct. Assign still-open original M91 defects to their existing owner; M95.1 holds regression evidence for its handoff.
- [ ] Add failing assertions for duplicate/late/orphan parent-tagged events, nested child errors, unreadable child transcript, resumed cumulative modelUsage and omitted child share. An orphan stays visibly partial and never appends to the parent answer; absent usage never becomes zero.
- [ ] Run `pnpm test:run src/agent/transcript.test.ts src/agent/conversations.test.ts src/agent/useContextUse.test.ts`; run `cargo test agent::` from `src-tauri`, respecting the M91 plan's documented crash-test procedure. Expect only new assertions to fail before any fixes; investigate baseline differences explicitly.
- [ ] Repair only demonstrated failures in current owners; keep live/replay equality on per-parent normalized projections, excluding documented live-only data. Do not create a second reducer.
- [ ] Read the repository `record-cli` dev skill, record researcher enabled/disabled, read-only scope escape, disallowed type, parent Stop, missing hooks, allow/deny/edited/invalid/stale/repeated decisions, fork identity, whole-tree/missing accounting, context availability and attachment send. Record restart-waiting and vault-switch outcomes. Classify unsupported or environment-blocked behavior explicitly.
- [ ] Sanitize and scan recordings using the kit; no auth/config/prompt-secret dumps. Run the focused tests and `pnpm e2e e2e/m91-subagents.spec.ts e2e/agent-transcript.spec.ts e2e/floating-assistant.spec.ts`. Expect parent/child attribution, stable draft and DOM identity to pass. For the baseline handoff, consume available packaged/native evidence and assign every open case; missing final M93 evidence does not block unrelated page/UI work. Final M93/M95 release acceptance requires the repaired packaged/native cases and live matrix; M91/M92 close through their own gates. Include M92 rail dock/drawer, Plan/Context and turn-state regressions from its owning test map.
- [ ] Commit this milestone's independently reviewed handoff/evidence record as M95.1; any outstanding M91/M92 repair keeps its original milestone/phase ownership. No archive/job promise proceeds on a blocked core capability.

## M95.2 — Durable normalized conversations and safe cache migration

**Requirements:** CHAT-02/03 and migration portion CHAT-09.

**Files:** Create conversation `types.rs`, `mod.rs`, `commands.rs`, `archive_codec.rs`, runtime
`conversations.rs`, `src/agent/conversationArchive.ts` and its test. Modify runtime
schema/registration, `src-tauri/src/lib.rs`, `src/agent/{agentIpc,types,
useConversations,conversations}.ts`. Tests: new inline Rust service/storage tests,
existing conversation hook/cache tests, new `e2e/conversation-archive.spec.ts`.

**Interfaces:** `ThreadRecord`/`AttemptRecord` and `ArchiveTurnV1` are the spec's fields; use existing `Place`, checked non-reasoning fold carriers and bounded child summaries. `begin_attempt(binding,requestKey,contentChoice)` binds the existing seated launch before spawning; its scoped key/digest makes lost-ack retries idempotent. The binding includes a bounded displayMessage snapshot of the human-visible question/addressed label/attachment references captured before prompt composition; it is not reconstructed from CLI UserPrompt or outgoing/system assembly. The internal Rust completion writer owns `append_completed(binding,turn:ArchiveTurnV1)`, including linked deferred/resumed runs. The frontend archive adapter feeds the existing transcript reducer rather than introducing a second renderer/projection.
`Page<T> = {items:T[], nextCursor:string|null}`. Service reads return
`Result<Page<T>, ConversationReadError>`; TS uses discriminated
`ready | unavailable` results, never failed-read-to-empty. Define `ContentState =
retained | metadata_only | expired`, separate from CLI session availability.
Commands named `conversation_list`, `conversation_messages`, `conversation_search`,
`conversation_import_legacy`; TS methods accept explicit `vaultId`. Rust clamps
limits to 50; query cursor scope is validated. `append_completed(binding, turn)` is keyed by stable attempt/message IDs and returns `inserted | duplicate | tombstoned | unavailable`; partial content is a recorded state, not successful full persistence.

- [ ] Add transaction tests for same-attempt redelivery, equal-time stable pagination, cross-vault cursor rejection, unavailable DB, duplicate legacy IDs and crash before/after import commit. A committed import repeats idempotently; uncommitted import leaves the browser copy usable.
- [ ] Run `cargo test conversations` and `pnpm test:run src/agent/conversationArchive.test.ts`; expect missing service/interface failures.
- [ ] Add `detached_turn_archives_without_webview_callback`, `display_question_survives_missing_cli_file_without_prompt_assembly`, `lost_launch_ack_returns_original_attempt`, `deferred_process_does_not_finalize_attempt`, `crash_before_archive_commit_recovers_without_resend`, `missing_recovery_file_is_unavailable`, `late_completion_cannot_resurrect_deleted_thread` and archive-codec live/replay parity cases. Feed real normalized fold fixtures, not a hand-built happy-path ChatMessage. Run Rust codec/runtime tests and TS archive-adapter/reducer cases before attaching consumers.
- [ ] Implement the checked ArchiveTurnV1 allowlist and bounded collector in the Rust conversation service, fed by the existing fold/settlement lifecycle. Keep the completion writer independent of panel mount. Recover incomplete collection only through the existing folded transcript reader and known anchors; record partial/unavailable if recovery is impossible. Persist content and search rows in one transaction, honor off/quotas/tombstones and return a typed persistence result. Shared fixtures pin intentional field loss, ordering, byte/event limits and no reasoning/raw payload retention.
- [ ] Implement scoped archive tables, indexes and the next numbered migration directly in runtime/schema.rs and runtime/mod.rs; CHAT owns rollback/readback tests and runtime/conversations.rs transactions. Store ArchiveTurnV1 completed content/child summaries and immutable ancestry; exclude reasoning, raw payloads and full child traces. Reuse live recovery journal rather than archiving active streams as completed.
- [ ] Adapt `useConversations` to load incremental archive pages and perform one-time validated cache import after an explicit retention choice. Preserve legacy IDs; leave unknown-vault records in the cache with explanation. Clear only successfully imported bodies after durable readback; preserve active attach references.
- [ ] Add browser assertions: navigate/reload/switch thread while reads race; stale archive response cannot replace the current thread. One assistant owns the thread through floating/docked/canvas and keeps draft, pending approval and scroll. Search unavailable renders unavailable.
- [ ] Re-run targeted Rust/TS tests and archive e2e; expect exact retained message order and unchanged branch/session guards. Commit the archive/migration phase after review.

## M95.3 — Retention, deletion and export with truthful storage limits

**Requirements:** CHAT-09 and CHAT-03 availability.

**Files:** Create `conversations/{retention,export}.rs`,
`src/agent/ConversationRetention.tsx` and tests. Modify conversation runtime/service,
`src/agent/{conversationArchive,useConversations}.ts`,
`src/pages/SettingsPage.tsx`, `src/status/RunTranscript.tsx`, archive e2e, and the CV-30 deletion clause/tests in `AGENTS.md` when the new behavior is enabled.

**Interfaces:** `RetentionChoice = off | days30 | days90 | forever`;
`set_retention(vaultId, choice)` returns explicit committed settings/version.
`prune_content(now) -> Result<PruneReport, ConversationWriteError>` uses completion timestamps; `PruneReport {removedMessages,removedSearchRows,logicalBytesReleased,cleanup:completed|deferred|failed,retryAfter?:string,safeReason?:string}` separates logical removal and best-effort physical cleanup. `delete_thread(vaultId, threadId)` returns `deleted | already_deleted | blocked_active`, with typed active owner references and non-secret retained-effect notice. `export_thread(vaultId, threadId, json|markdown)` writes through the native
save-dialog service to an outside-vault destination and returns a typed cancelled,
saved or failed answer. Export includes provenance/state words, not secrets.

- [ ] Resolve owner retention/default/budget decisions. Until approved, leave the archive gate off and preserve current behavior; migration opt-in is not inferred from continued app use.
- [ ] Add fake-clock tests at completion+30/90-day boundaries, active thread with old completed messages, off while a turn settles, forever at capacity, deletion during live generation, child execution and pending approval, busy-reader checkpoint deferral, cleanup failure/retry and export of expired content. Assert content/search/derived previews disappear together, unresolved ACT invocation references remain, and CLI-owned sessions/saved pages stay separately disclosed.
- [ ] Run `cargo test conversations::retention` and new retention component tests; expect new contract failures.
- [ ] Amend CV-30 and current delete-thread tests for explicit blocked-active archive deletion in the same reviewed phase; preserve legacy behavior until that gate ships. Implement transactional logical expiry/deletion, bounded export streaming and 256 MiB admission accounting if approved. On capacity failure show archive unavailable and retain existing content; do not report successful persistence. Deletion while a generation, child job or pending approval owns the thread returns blocked_active and changes no content or execution state. Offer separate explicit Stop/resolve controls and retry Delete only after settlement; never invoke ACT cancellation from deletion/expiry.
- [ ] Implement CHAT-owned logical content/search/preview deletion in one runtime transaction, then bounded best-effort SQLite cleanup/checkpoint retries in retention.rs. Return PruneReport for busy readers or failed cleanup and expose deferred status in settings. Document WAL/free-page/user-backup limits; do not promise secure erasure, silently remove backups or report physical bytes erased from logical row counts. Change old “keeps no copy” transcript copy only where the archive actually retains content.
- [ ] Run targeted Rust/TS tests and archive e2e. Expect export cancellation to preserve the draft, deleted titles absent from search, and surviving effect summaries accessible through scoped history. Commit retention/export phase.

## M95.4 — Context receipts, attachment readiness and answer artifacts

**Requirements:** CHAT-04/05.

**Files:** Create `contextReceipt.ts`, `ContextReceipt.tsx`, `artifacts.ts`,
`ArtifactActions.tsx` with tests. Modify `context.ts`, `attachments.ts`,
`ChatInput.tsx`, `AiPanel.tsx`, `ChatTurn.tsx`, conversation types/service and Rust guarded read
boundaries selected by KNOW. Modify existing src/editor/AskAiPopover.tsx, SelectionToolbar.tsx and heldSelection.ts only as needed to bind selection snapshot/version and existing replace transaction; extend their tests. Extend archive e2e and existing attachment tests.

**Interfaces:** `ContextReceipt {attemptId, selected:SourceSelection[],
initial:ReadObservation[], later:ReadObservation[]}`; `ReadObservation {evidenceId,
sourceVersion:string|null, observedAt, outcome, location:SourceLocator|null}` where
`outcome` is the exact spec union. KNOW supplies source identity/location types. Import SourceLocator/EvidenceRef from [KNOW's generated shared contract](../specs/2026-10-23-m97-knowledge-evidence-and-evaluation-design.md); store the inline locator, not a reference-store ID. Locator quote/prefix/suffix follow CHAT retention and current scope checks, including revoked-source hiding. `ArtifactRef {id,
attemptId, state:preview|workspace|external, mediaKind, sourceRefs, effectRefs,
version:string|null}`. `save_artifact_preview(vaultId, artifactId, target,
expectedVersion)` returns the existing typed guarded-write result/receipt.

- [ ] Confirm KNOW's inline source types and the existing human `applyBatch`/editor save owner. Local Save/Append does not depend on an undefined ACT guarded-save adapter; ACT owns only external action references here. New-page saves use the existing guarded create batch; append into an open page uses that page's owner/editor transaction after source/target version checks, never a second writer. Block only the dependent interface if unavailable. Keep URLs merely encountered in a different labeled section from read evidence.
- [ ] Add failing tests for navigation after enqueue, partially copied attachments, unsupported content, revoked-source archived quote hiding, stale source version, save conflict, regenerated answer after a saved artifact, selected-text Apply after page/version/range change, Cancel and concurrent edits in the same editor. Assert draft/chips survive, omitted material requires an explicit choice and saved page bytes change only on guarded save.
- [ ] Wire completed-message Copy and Save/Add actions through existing presentation-only MessageActions, preserving keyboard access and no hover-only operation. Edit question creates a separate draft and preserves the original attempt; sending passes through M95.5 recovery checks. Branch reuses the existing checked branch command, and unsupported/active states explain their disabled action. Test copy failure, empty/expired content, selected-message save, destination change, dirty target, canceled save and one undo.
- [ ] Implement receipt production at actual initial assembly/read boundaries with no prompt/credential/token-usage persistence; append later evidence references by attempt ID. Retain M91's copy-in doors and current-vault checks.
- [ ] Snapshot selected text, owning page/version and exact editor range before Ask AI. Preview proposed hunks through existing AskAiPopover; Apply verifies the original passage/range/version and uses its single existing editor transaction plus guarded save, with one undo step. Cancel writes nothing; stale selection/page produces a reselect/regenerate conflict. Preserve HeldSelection presentation without treating its paint mapping as write authority. Implement inspection and supported artifact actions using existing viewers/writers. Disable unsupported comparisons with words. Never execute generated HTML in an IPC-capable frame; do not offer a button without a valid action.
- [ ] Run new receipt/artifact tests, existing `attachments.test.ts`, and archive e2e. Expect changed-source fallback and export/open to preserve draft/selected turn. Commit receipt/artifact phase.

## M95.5 — Recovery decisions reference the shared action runtime

**Requirements:** CHAT-06; CP09 effect-aware recovery.

**Files:** Create `recovery.ts`, `RecoverySummary.tsx` and tests; modify
`AiPanel.tsx`, `ChatTurn.tsx`, `agentIpc.ts`, conversation attempts/service;
Create `e2e/agent-recovery.spec.ts`. Consume M93 scoped history/flush APIs and ACT's
[canonical effect contract](../specs/2026-10-23-m96-connectors-mcp-and-actions-design.md).

**Interfaces:** `RecoverySummary {attemptId, receipts, pendingDecisionRefs,
session:available|gone|unavailable, effects:ActionEffectRef[],
effectsRead:ready|unavailable, details:ActionEffectDetails|null}`. Exact broker read is
`ActionService::effect_ref(subject: ActionSubject, invocation_id: InvocationId)
-> Result<ActionEffectRef, ActionReadError>`; the spec defines its fields/states.
`ask_again(priorAttemptId)` creates a fresh linked attempt; `continue_session`
rechecks CLI availability; branch reuses existing checked fork. ACT alone exposes
mutation retry/reconcile operations. Inspect using canonical `effect_details(subject,id)`; use its safe account/target, redacted asked/approved preview and attempt receipts. `retry(subject,id,expected_revision,PersonRetryDecision)`, `reconcile(subject,id,expected_revision)` and `request_cancel(subject,id,expected_revision)` compare its revision; approval decisions carry expectedInvocationRevision and expectedApprovalRevision. Rust derives subject from trusted session/token/stored-run context, never client IDs. M93 supplies stable runId/origin vaultId and
flush report; assistant launch blocks on unresolved current-generation flushes.

- [ ] Add failing cases: recorded write then crash, `outcome_unknown` after parent Stop, unreadable broker, missing CLI session, repeated approval click, account change, stale invocation/approval revisions and refreshed details after a raced decision. Unknown effects remain visible; UI cannot create a retry merely because no response exists.
- [ ] Build summary from existing receipt/history/session readers and broker references. Preserve partial successes, identify unavailable sections and include new attempt's ancestry. Rename the current retry affordance to “Ask again” where it re-sends; do not manufacture continuation checkpoints.
- [ ] Route decisions to existing action authority and validated session APIs; Ask again carries no spent approval, preserves prior uncertain invocation references and cannot make the same uncertain effect eligible merely by creating a new attempt ID. Add a regression asserting this indirect retry is refused until the broker permits it. Await M93 flush report before launch. Preserve in-flight decision ownership through layout changes and reload.
- [ ] Run recovery adapter/component tests, `cargo test conversations`, existing question/ask tests and recovery e2e. Expect one approved dispatch, no retries on unavailable evidence, and explicit unavailable session copy. Commit recovery phase.

## M95.6 — Prove child isolation and freeze admission

**Requirements:** CHAT-07 and child decision gates.

**Files:** Create `agent/child_jobs/{types,admission,mod}.rs` and inline tests,
`runtime/child_jobs.rs`; modify agent/runtime registration and policy artifacts
only through the repository policy-artifact-edit runbook. Add sanitized capability
cases to M95.1 evidence directory; create `src/agent/childJobs.ts`.

**Interfaces:** `ChildJobSpec {parentRunId,parentAttemptId,objective,
instructionSourceVersion,inputEvidenceRefs,resultSchemaId,requestedGrant,
budget,deadlineAt}`. `ChildJobService::submit(subject:ActionSubject,
requestKey:string,spec:ChildJobSpec)->Result<ChildAdmission,ChildRefusal>`;
`ChildAdmission {jobId,effectiveGrantRef,state:queued}`. Rust validates all client
fields and resolves parent/Agent grants from authoritative records. CHAT durably maps trusted subject scope plus requestKey to allocated jobId/request digest before dispatch; same key/digest returns original admission after access checks, changed digest returns request_key_conflict. Chat persists parent run/attempt/delegation-slot key before submit; FLOW persists workflow run/step/attempt key before calling. Result schemas
are versioned allowlisted local definitions, not arbitrary model-supplied code.

- [ ] Owner approves limits and read-only first release; record desktop-awake scope. AX08 remains unavailable until a recorded backend proof passes independent scoped MCP credentials, parent-token noninheritance, raw connector denial, shell/filesystem bypass denial and required approval suspension support.
- [ ] Add table tests: child asks broader scope, revoked parent, Agent maximum broader than parent, unbound account, invalid schema/deadline/budget, depth two and ninth job, same-key replay, changed-digest conflict, crash after child admission before FLOW links it and crash before launch claim. Assert admission refusal or exact intersection; no greater Agent grant appears in child subject.
- [ ] Implement CHAT-owned next numbered child_jobs migration, immutable admission and unique scoped request-key/digest mapping in runtime/child_jobs.rs. Allocate jobId and store scoped run/session mint intent transactionally before launch; derive execution subject through ACT. Recovery returns the original job across the FLOW-link crash window. Reuse policy artifacts for common ceilings; never twin new numeric rules in Rust and TS.
- [ ] Run `cargo test child_jobs` and live capability cases through the sanitized kit. If CLI cannot meet the boundary, keep this mode disabled with a typed unsupported reason and finish foreground researcher acceptance independently. Do not substitute prompt-only isolation.
- [ ] Commit reviewed admission/capability proof, including negative result documentation where appropriate. Do not enable mutation jobs before ACT acceptance.

## M95.7 — Job settlement, cancellation and visible contributions

**Requirements:** CHAT-08 and CP09 child recovery.

**Files:** Create `agent/child_jobs/dispatch.rs`, extend runtime child jobs and
agent meter, modify `toolRenderers.tsx`/element adapters, child IPC and archive child
summaries; create `e2e/child-jobs.spec.ts`. Keep handoff paths unchanged.

**Interfaces:** `ChildJobState` is the exact spec union;
`claim(jobId,lease)->claimed|already_claimed|closed` is transactional.
`cancel(subject,jobId)->CancellationRequested`;
`read(subject,jobId)->Result<ChildJobView,ChildReadError>`.
`ChildResult {jobId,schemaId,status:valid|partial|invalid,payloadRef,
validationErrors,effectRefs,usageAvailability}` validates before parent consumption.
No new effect state is encoded in job result payloads.

- [ ] Add failing tests for parent Stop racing success, restart with a held claim, malformed/oversized output, deadline during approval, duplicate result delivery and missing usage. Parent totals count each child once; unknown share stays unknown. A child with uncertain dispatched effects does not claim proven effect-free cancellation.
- [ ] Implement CHAT-owned desktop-awake claim/lease transitions in runtime/child_jobs.rs using existing runtime writer/dispatch transaction patterns. A conditional queued-to-running claim binds owner/lease/run identity atomically; lease loss prevents dispatch and restart settles abandoned claims without launching replacements. Test the migration rollback and both sides of claim commit; crash recovery marks interrupted and never auto-replays effects. Queued cancellation prevents dispatch; running cancellation enters stopping until backend settlement. Use ACT's authoritative state to explain surviving effects.
- [ ] Adapt existing Subagent presentation to show task, lifecycle, available summary, partial trace and run link. Keep foreground researcher, supervised job and handoff visibly distinct. Child failure preserves sibling contributions and the parent answer.
- [ ] Run `cargo test child_jobs`, relevant meter/projection tests and child e2e; replay after restart must match settled job state without duplicate effects. Record CLI evidence for cancellation/deadline and M93 native smoke for visible states.
- [ ] Commit reviewed lifecycle/UI integration. Final gates: `pnpm lint`, `pnpm typecheck`, `pnpm test:run`, `pnpm e2e`, `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, and the repository-required Rust suite. Preserve documented crash-test constraints and report baseline failures explicitly.

## Coverage, self-review and handoff

| Requirement/research                                   | Owning tasks                   |
| ------------------------------------------------------ | ------------------------------ |
| CHAT-01; AX00; M91 reconciliation                      | M95.1                          |
| CHAT-02/03; AX05; AppFlowy AF-02, n8n message identity | M95.1/M95.2                    |
| CHAT-04; AF-01/03/05; chat journeys 2–3                | M95.4, KNOW passage dependency |
| CHAT-05; AF-04; n8n artifacts; PL05 selected-text AI   | M95.4                          |
| CHAT-06; CP09; distinct retry/branch/continuation      | M95.5                          |
| CHAT-07/08; AX08; n8n delegated task identity; AF-08   | M95.6/M95.7                    |
| CHAT-09; explicit retention decision                   | M95.2/M95.3                    |

Self-review completed for this draft: every numbered requirement has a task; all
five Review Focus classes map to named assertions; interfaces reuse the same IDs,
state words and authority boundaries; no new implementation is claimed. New units
are proposed, current implementation is recognized and live/native evidence is
separated. Retention decisions, KNOW evidence types, CHAT-owned purge/claims, M93 flush
report and ACT service availability are explicit dependency gates. Owner review
must settle those contracts and execution choice before implementation; this draft
makes no request to begin it.

Builder corrections incorporated: archive migrations/cleanup and child claims/leases are owned by M95.2/M95.3/M95.6/M95.7 rather than deferred to CORE. M95.3 blocks active deletion without implicit Stop or effect cancellation. M95.4 uses inline KNOW locators, scoped retention and checked selected-text application. M95.5 consumes revisioned ACT details. M95.6 submission deduplicates the crash before parent/FLOW linkage. These are draft corrections, not completed implementation or test results.

## M91–M92 integration boundary

[M92 — The conversation rail](2026-10-23-m92-conversation-rail.md) remains the owner of the canvas-only Conversation details rail, its read-only cards, shared Context pull, Plan/Subagents/Changes/Sources/Handed off adapters, reach/thread-status facts and canvas-safe navigation. Reconcile the accepted M91→M92 handoff at its recorded revision before this milestone changes those shared files; preserve the single assistant instance and live state. Unfinished or unverified M91/M92 work stays assigned to its existing milestone, with dependent work waiting on that gate.

M95 source-context receipts record source delivery and evidence provenance; they do not persist context-token readings or add a second context poll. The read-only rail may link to the owning inspection/settings surface. New managed account/action controls need M96 ownership and must not silently replace M92 rail behavior.
