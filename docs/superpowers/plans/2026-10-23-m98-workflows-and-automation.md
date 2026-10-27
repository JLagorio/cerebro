# M98 — Workflows and automation

**Milestone:** M98 · **Phases:** M98.1–M98.9 · **Requirements:** FLOW-01–FLOW-10.

[Master roadmap](2026-10-23-m93-m99-master-roadmap.md) · [Research and traceability](../specs/2026-10-23-m93-m99-research/README.md).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver versioned desktop workflows, truthful trigger preview, restart-safe waits and complete capture/recipe journeys through existing guarded writes and the shared action broker.

**Architecture:** Files hold workflow drafts and immutable published JSON versions; Rust interprets a bounded step definition and SQLite holds operational run/step/continuation state. ACT owns every action invocation, approval and uncertain effect. React adds a step list, inspector and preview to existing Agent, composer and run surfaces; isolated rehearsal remains gated by enforcement evidence.

**Tech Stack:** Existing Rust/Tauri 2, SQLite runtime, React 19/TypeScript, generated service DTOs, shared JSON fixtures/policy, existing capture/composer/editor and AI elements.

**Spec:** [Workflows and automation design](../specs/2026-10-23-m98-workflows-and-automation-design.md).

## Global Constraints

- **Implementation authorized by the owner on 2026-10-23**, on the existing branch alongside Claude's M92 work. See the [implementation record](2026-10-23-m93-m99-implementation-record.md) for actual evidence and dependency gates. New paths/test names below remain proposed until implemented and verified; M98 is not complete.
- The first engine is desktop-awake: local schedules and event dispatch execute only while the app, vault and runtime are ready.
- Keep files as the current workspace authority. Proposed workflow definitions live as typed JSON under an owned `.cerebro/workflows/` directory.
- Every run pins one version; edits, unpublishing or renaming cannot reinterpret an existing wait.
- There is no workflow-local approval or effect ledger. ACT's canonical state is `outcome_unknown`; workflows project blocked dependent steps.
- Preview reserves nothing and creates no wakes, budget reservation, lease, followup, connector call or enabled-state mutation.
- A copied vault and a read-only prompt are insufficient for live rehearsal. Ship deterministic preview if enforced isolation cannot be proven.
- UX owns session-only creation drafts/submission journal and its Resume/Discard surface; persistence requires a separate opt-in adapter/retention decision.
- Capture writes once and never implicitly starts an agent, connector or published flow. Gmail remains drafts-only; calendar preparation is not booking; publishing requires a separate approved action decision.
- Format v1 executes sequentially, admits no arbitrary script/shell step and keeps shared cases for any TS/Rust semantic twin.
- Proposed limits: 32 steps, 256 KiB definition bytes, 256 KiB normalized step output, 8 MiB normalized run output. Proposed catch-up default: `skip_missed`; optional `coalesce_latest` has a 24-hour lookback. Proposed completed detail retention: 90 days. Owner must approve these before implementation.
- Keep existing recovery holds, guarded write/undo/receipt paths, human-only knowledge verification and missing/unavailable states. Use `type(scope): sentence (M98.<phase>)` with the numbered phases below and never bypass hooks.

## Review Focus

- Editing/deleting a workflow during a wait must preserve its pinned execution and current revocation checks — M98.1/M98.3 persistence fixtures.
- Duplicate, early or out-of-order resume signals and multi-window claims must advance once — M98.3 transactional tests.
- A lost remote response or cancellation after submission must block downstream steps, even after a new chat/run request — M98.2/M98.3 ACT fence integration.
- Sleep, DST changes, app closure and runtime recovery holds must not cause an unbounded catch-up burst — M98.4 occurrence fixtures.
- Preview/rehearsal/capture convenience must not create production effects, lose drafts or bypass the shared writer — M98.5/M98.6/M98.7 adversarial and journey checks.

---

## File map and dependencies

All new modules are **proposed**. Existing matching resides partly in frontend
engine code; the plan explicitly migrates the authoritative decision seam while
preserving parity, rather than adding a competing Rust interpretation. Current
`runtime/triggers.rs` stores governance trigger evaluations and is not a new
workflow execution store; keep those meanings separate.

| Responsibility                 | Files                                                                                                                                                                                            |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Version carrier and validation | new `src-tauri/src/workflows/{mod,definition,files}.rs`; new `shared/workflows/{format.v1,cases.v1}.json`; existing `lib.rs`, policy README                                                      |
| Step runtime                   | new `workflows/{service,runner,mapping}.rs`, new `runtime/workflows.rs`; existing `runtime/{mod,schema}.rs`                                                                                      |
| Wait/recovery/scheduling       | new `workflows/{waits,recovery,schedule}.rs`; existing `runtime/{dispatch,wakes,followups,catchup}.rs` integration only                                                                          |
| Preview authority              | new `workflows/preview.rs`, new `runtime/admission.rs`; existing `engine/{triggers,wakes,jobs}.ts`, `agent/useJobRunner.ts` and shared trigger/wake cases                                        |
| Product surfaces               | new `src/workflows/{WorkflowEditor,StepInspector,WorkflowVersionPicker,WorkflowRun,TriggerPreview}.tsx` and service adapter; existing Agent properties/page, status/run surfaces and AI elements |
| Rehearsal and intake           | new `src-tauri/src/workflows/rehearsal.rs`, new `shared/workflows/rehearsal-tools.v1.json`; existing capture/composer/starter recipe and native shell surfaces                                   |

M96.1/M96.3/M96.4 provide typed catalog, durable invocations, credentials and protocol
ownership. CORE provides generated DTO registration and runtime schema facilities.
CHAT provides scoped child jobs only for the optional agent step. KNOW supplies
outcome-evaluation evidence before a rehearsal claims task quality. No gate below
changes page metadata authority or converts existing agents into workflows.

### M98.1 — Immutable workflow definitions and checked publication

**Files:** Create `workflows/{mod,definition,files}.rs`, shared format/cases JSON,
new `src/engine/workflows/workflowContract.test.ts`; modify
`src-tauri/src/lib.rs`, `shared/policy/README.md` and CORE contract registration.

**Interfaces:** Produces spec-exact `WorkflowVersion`, `StepDefinition`,
`WorkflowVersionRef`, `WorkflowDraft`, `WorkflowInput`, `ResumeSignal`, `DraftRef`, `PublicationRef`, `WorkflowActivation`, `TriggerDefinition`, `WorkflowError` and generated
DTOs. `DefinitionStore::save_draft(subject, draft, expected_revision)` and
`publish(subject, draft_ref)` implement WorkflowService's file-backed methods.
Carrier is `.cerebro/workflows/<id>/{draft.json,published.json,versions/<hash>.json}`.
Version includes immutable `inputSchema` bytes and `inputSchemaDigest`; publication/run admission verifies digest and input against the pinned schema. Definition identity is canonical hash; IDs are opaque strings, not display titles.

- [ ] Add `reject_cycle_duplicate_id_and_unreachable_step`, `reject_forward_mapping_and_script`, `publish_pointer_last`, `immutable_hash_rejects_changed_bytes` and `symlinked_workflow_path_is_refused`, `schema_digest_mismatch_is_rejected`, `publish_schema_change_creates_new_version` and `run_input_uses_pinned_schema` fixtures. Pin exact proposed byte/step limits and preserved old publication after each injected write failure.
- [ ] Run `cargo test workflows::definition` and `pnpm test:run src/engine/workflows/workflowContract.test.ts`; expect initial missing implementation failure, then shared fixture parity and generated nullability/union consistency.
- [ ] Implement checked owned-path reads, validated sequential definitions, atomic version installation and expected-revision publication. Keep drafts mutable and versions immutable; imported bytes validate but enable nothing.
- [ ] Add `deleted_workflow_tombstones_pinned_version` and `old_reader_reports_unsupported_format` cases. A format upgrade creates a new version; no automatic rewrite of an active version or current Agent record.
- [ ] Run `pnpm typecheck` and the contract drift gate; commit the carrier/validator with its numbered M98 phase after the owner approves format/limits.

### M98.2 — Bounded sequential runner over the action service

**Files:** Create `workflows/{service,runner,mapping}.rs`, `runtime/workflows.rs`,
new `src-tauri/fixtures/workflow-run-cases.json`; modify runtime schema/module
registration and `lib.rs`. Coordinate schema changes with CORE/ACT migrations.

**Interfaces:** Implements `WorkflowService::start(subject, version_ref, input,
occurrence_id) -> Result<WorkflowRunRef,WorkflowError>` and
`inspect(subject, run_id) -> Result<WorkflowRunView,WorkflowReadError>`.
Produces `WorkflowRun`/`StepRun` with states from the spec, frozen inputs, output
references, cursor and attempt identity. `Mapping::evaluate(expression, inputs,
limits) -> Result<BoundedValue,MappingError>` accepts only the spec's declarative
vocabulary (128 AST nodes/depth 16, proposals). An action step durably records its step attempt/requestKey from workflow run/step/attempt before ACT `prepare`; scoped idempotent prepare returns the original invocation/approval if FLOW crashes before saving its returned link. Internal ACT dispatch revalidates Rust-derived subject authority; it does not invoke a provider itself.

- [ ] Add `read_transform_condition_result`, `completed_step_is_not_reexecuted_to_render`, `output_limit_is_visible_failure`, `mapping_budget_terminates`, and `action_unknown_blocks_successor`, `crash_after_prepare_before_link_reuses_original_approval`, and `same_request_key_changed_payload_conflicts` fixtures. Assert no arbitrary eval/shell, no unknown-to-zero coercion and explicit skipped branch rows. Add `skipped_branch_output_is_missing`, `missing_required_action_input_never_prepares`, `exists_missing_is_false`, `missing_comparison_is_typed_error`, `manual_start_lost_response_returns_same_run` and `same_start_key_changed_version_or_input_conflicts`; consume path-available outputs only and persist start identity before returning a run.
- [ ] Run `cargo test workflows::runner` and `cargo test workflows::mapping`; fail before implementation and pass with bounded sequential execution and recorded outputs.
- [ ] Implement run/step admission in SQLite transactions and immutable references to version/configuration/grants. Initial steps are read, transform, condition, action, wait and result; keep optional agent step unavailable until CHAT capability gates include scoped start-once requestKey/digest linkage. Add `crash_after_child_start_before_link_returns_original_child`; link recovery must allocate no new child ID/attempt.
- [ ] Add integration case `fresh_workflow_run_cannot_bypass_unknown_fence` using ACT's real service/fake provider. Same semantic target under a new occurrence/run ID remains blocked; one accepted remote request and its unresolved evidence survive rerun attempts.
- [ ] Verify `cargo test workflows::` plus ACT recovery filters; commit the runner independently of workflow-editor polish.

### M98.3 — Durable waits, resume claims, cancellation and retention

**Files:** Create `workflows/{waits,recovery}.rs`; modify `runtime/workflows.rs`,
`runtime/schema.rs`, `workflows/service.rs`; add crash/race fixtures to
`src-tauri/fixtures/workflow-run-cases.json` and tests.

**Interfaces:** Implements `resume(subject, continuation_id, expected_revision,
signal)` and `cancel(subject, run_id)`. `WaitRecord` pins run/version/step/attempt,
kind, revision, due/expiry, subject and status. `claim_resume(...) -> Claimed |
AlreadyConsumed | NotDue | Stale | Denied` is conditional and transactional.
Approval wait references ACT approval ID; child-job wait references CHAT ID;
remote task handles remain ACT-owned. Cancellation intent persists separately
from confirmed action/job outcomes. Install wait/link before parking and observe
canonical ACT/CHAT state in the checked park transition. `reconcile_waits(now, limit)`
rechecks durable outcomes at startup and bounded ticks; notifications are hints,
never the sole delivery record. Unknown external continuation IDs are refused.

- [ ] Add `two_windows_resume_once`, `early_timer_does_not_advance`, `stale_external_signal_cannot_resume_new_attempt`, `bearer_cannot_answer_person_approval` and `draft_edit_does_not_change_waiting_version`, plus table-driven cases for approval denied/expired, malformed/expired external input, child failed/interrupted/unavailable/cancelled/invalid output, grant revoked and ACT unknown. Use separate real SQLite connections and an injected clock.
- [ ] Run `cargo test workflows::waits`; expect initial failures, then one continuation consumption and unchanged denied/not-due rows. Assert each case matches the spec wait-outcome table: malformed input preserves waiting revision, denial fails without successor, expiry/interruption blocks without reissue, cancellation retains unknown effects, and revoked scope blocks an otherwise valid old wait.
- [ ] Add `approval_completes_before_wait_commit`, `child_completes_before_parent_parks`, `crash_after_completion_before_resume_claim`, `completed_outcome_reconcile_advances_once` and `external_signal_cannot_create_wait`. Interleave independent connections at link/park/completion/claim boundaries; one continuation advances without a second action/child start.
- [ ] Implement restart recovery at input freeze, action preparation, dispatch claim, result commit and wait signal boundaries. Consult ACT for claimed effects; never infer no effect from missing step output. Keep existing scheduler/recovery-held items held.
- [ ] Add `cancel_after_submission_keeps_unknown`, `cancel_prevents_pending_successors`, `cleanup_keeps_pinned_versions`, `cleanup_removes_only_eligible_completed_details` and `full_store_refuses_new_work` cases. Retain minimal effect/wait/version identity independently of verbose outputs; historical unavailable bytes are not synthesized from current pages.
- [ ] Run `cargo test workflows::recovery` and `cargo test runtime::dispatch`; expect conservative recovery and no changed legacy hold semantics. Commit waits/recovery after owner approves retention/quotas.

### M98.4 — Desktop-awake schedules and bounded catch-up

**Files:** Create `workflows/schedule.rs`, new `shared/workflows/schedule-cases.v1.json`;
modify `workflows/service.rs`, `runtime/workflows.rs`, integration points in
`src/agent/useJobRunner.ts` and existing runtime startup/close wiring; add Rust
schedule tests and `src/engine/workflows/scheduleContract.test.ts` if a twin remains.

**Interfaces:** Owns spec-exact `WorkflowActivation` storage and
`WorkflowService::{enable,pause,unpublish}` with expected activation/publication
revisions. Reconcile file-pointer/operational activation changes under a recovery
hold; publish alone enables nothing. `plan_occurrences(version, previous_cursor, now, readiness,
catchup_policy) -> OccurrencePlan` returns due/skipped/coalesced occurrence IDs
and observed coverage without claiming execution. `claim_occurrence(id, expected_cursor) -> Started | AlreadyClaimed | Deferred | Held` owns dispatch. Identity
includes workflow/version/schedule/timezone/intended UTC instant. Policies are
`skip_missed` and `coalesce_latest {lookbackHours:24}` only in v1 (proposals).

- [ ] Add `closed_app_skips_missed_by_default`, `latest_only_within_24_hours`, `dst_gap_and_fold_have_explicit_instants`, `two_windows_claim_one_occurrence`, `clock_backwards_does_not_repeat`, and `recovery_held_never_auto_starts`. Assert no unbounded backlog replay.
- [ ] Run `cargo test workflows::schedule` and applicable shared TS fixtures; expect failing cases first, then exact agreement and unchanged content-hash catch-up tests.
- [ ] Add `publish_does_not_enable`, `paused_no_occurrence_claim`, `enable_pins_selected_version`, `publish_v2_keeps_active_v1`, `unpublish_disables_new_starts_preserves_wait`, `reenable_excludes_paused_backfill`, `activation_pointer_crash_holds_admission` and `activation_change_races_claim_once`. Manual Start is explicit and remains distinct from automatic enablement.
- [ ] Implement cursor/occurrence transactions and defer until app/vault/runtime readiness. Read existing session interval provenance; show unavailable bounds rather than inventing exact closed times. No background daemon, network relay or public webhook is created.
- [ ] Simulate sleep/wake, unclean close, timezone/schedule edit, deleted vault and budget refusal. Record skipped/coalesced counts and reasons; edited schedule starts a distinct identity and cannot resume an unrelated wait.
- [ ] Run packaged desktop sleep/reopen acceptance with recorded platform/build; commit the schedule slice only after copy clearly states “Runs while Cerebro is open and this vault is ready.”

### M98.5 — Production-equivalent deterministic trigger preview

**Files:** Create `workflows/preview.rs`, `runtime/admission.rs`,
`src/workflows/TriggerPreview.tsx` and tests; modify `src/engine/{triggers,wakes,
jobs}.ts`, `src/agent/useJobRunner.ts`, `src/library/AgentProperties.tsx`,
`src/library/AgentPage.tsx`, IPC adapters and existing shared trigger/wake fixtures.

**Interfaces:** Implements `TriggerPreview::evaluate(request: PreviewRequest,
snapshot: AdmissionSnapshot) -> PreviewReport`. Extract a pure
`AdmissionDecision::evaluate` consumed by both preview and production before
side-effectful wake/lease/reservation calls. Snapshot reads pause, budgets, scope,
capability and existing wake facts through read-only access; model conditions
return `condition_required`, never an invented match. CORE owns generated DTOs.

- [ ] Add `preview_and_production_share_match_and_refusal`, `unsaved_agent_draft_preview_does_not_enable`, `preview_creates_zero_runtime_rows`, and `model_condition_remains_unchecked`. Snapshot all writable tables/counters before and after preview; use a provider spy asserting zero calls.
- [ ] Run `cargo test admission` and `pnpm test:run src/engine/triggers.test.ts src/engine/wakes.test.ts src/workflows/TriggerPreview.test.tsx`; initial missing seam failures should become shared-case parity. Preserve Rust authoritative guard checks during migration.
- [ ] Implement Rust decision extraction with the exact existing TS trigger cases and current wake/cause validation. If TS matching remains, list its twin under CV-04 and replay shared artifacts in both suites until the TS authority is removed; do not quietly fork semantics.
- [ ] Show explicit clock, selected sample, match/non-match, effective scope, pause/budget reasons, pending model condition and “Preview reserves no capacity.” Unavailable samples/capabilities are distinct from non-match. Selecting Preview does not save Done, reserve a lease or book a followup.
- [ ] Test draft → preview → inspect → Done/enable → run → Runs, including changed capacity after preview; commit useful deterministic preview without waiting for rehearsal isolation.

### M98.6 — Rehearsal boundary proof with a disabled fallback

**Files:** Create `workflows/rehearsal.rs`,
`shared/workflows/rehearsal-tools.v1.json`, new adversarial fixtures and
`src/workflows/RehearsalReport.tsx`; modify execution-adapter selection only where
an enforceable isolated mode is available. Add an execution-time evidence report
under `docs/superpowers/evidence/workflows/rehearsal-boundary.md`.

**Interfaces:** `RehearsalService::admit(request, boundary: VerifiedBoundary) ->
Result<RehearsalRunRef,RehearsalUnavailable>` requires an enforced platform/backend
capability record. Tool disposition is exactly simulated/refused/unavailable;
there is no fallthrough to production. `RehearsalReport` includes configuration/
sample hashes, proposed diffs, approvals, refusals and measured/unknown usage.
The rehearsal sink cannot mint production receipts, wake rows or followups.

- [ ] Before adding a Run control, write escape cases for absolute paths, `..`, symlink, subprocess/shell, inherited MCP config, inherited credentials, loopback calls, outbound network and scheduler booking. Require zero real-vault/runtime/provider writes observed at the actual boundary.
- [ ] Run `cargo test workflows::rehearsal`; use the supported real CLI/platform for native adversarial acceptance. A mock refusal test alone cannot establish process isolation. If the platform cannot enforce the boundary, produce the report, return unavailable and keep the control disabled.
- [ ] Implement only the supported isolated mode with explicit per-tool dispositions, empty inherited provider configuration and no real credentials. A copied directory is a test fixture, not the security mechanism; document the enforceable process/network/filesystem mechanism actually used.
- [ ] Add `cancel_cleans_isolated_run`, `unknown_tool_is_refused`, `apply_rechecks_current_bytes` and `read_only_test_never_claims_write_rehearsal`. Applying a useful diff is a separate existing guarded human write; stale/guarded concept changes are rejected without losing the report.
- [ ] Review evidence with KNOW's evaluation requirements and owner; commit either a genuinely isolated disabled experiment or a bounded unavailable result. Deterministic preview remains shippable independently.

### M98.7 — Complete capture, connected-work and calendar-preparation journeys

**Files:** Modify `src/lib/capture.ts`, `src/app/{CreateLauncher,RecordComposer}.tsx`,
`src/library/RecipesOffer.tsx`, starter recipe documents if selected,
`src-tauri/src/shell/` native registration module if approved; create
`src/workflows/{RecipePreview,WorkflowRun}.tsx`, tests and consume M98.9 StepInspector; add
`e2e/workflow-journeys.spec.ts`. New native module name: `shell/capture.rs`. Consume UX-owned
`src/stores/creationDraftStore.ts`, `src/engine/creationDestination.ts`,
`src/app/creationSubmission.ts` and `src/app/CreationDraftRecovery.tsx`; no second store/service.

**Interfaces:** Reuse existing `captureNote` and guarded `createItem` without a
second writer. UX owns exact `CreationContext`/`CreationDraft`, canonical key,
revision checks, claim/release/move and one Resume/Discard surface. Consume
`CreationSubmission`/`CreationSubmitStart` and `submitCreationDraft(context,revision)`:
only `started` invokes the writer, `pending` returns the same submission, and
`stale` submits nothing. The service owns the async writer promise outside React;
close/unmount releases only the dialog claim, not pending submission identity.
Stage one remains session-only. A later owner-approved
`CreationDraftPersistenceAdapter` attaches to this same store/journal; no second
Resume surface or implicit retention. Enable/disable migration preserves canonical
keys/revisions/claims/tombstones and stable submission IDs; prove writer receipt
lookup by that ID before claiming restart safety. `RecipePreview` resolves selected version/account/actions before
`WorkflowService::start`; it grants nothing itself. `WorkflowRun` consumes
`inspect` and ACT effect references. The first managed workflow uses M96's GitHub adapter;
existing Gmail Draft reply remains labeled CLI-owned compatibility. A managed
Gmail workflow is gated until a separately selected `gmail.draft.create`/read-back
adapter owns auth/scope/privacy, preview, receipt and uncertain-effect recovery
within this phase; do not assume legacy MCP credentials transfer. Calendar preparation outputs a bounded ICS/
page artifact through existing export/save doors, not an external booking.

- [ ] Add `capture_cancel_creates_nothing`, `repeated_enter_creates_once`, `failed_create_keeps_all_values`, `capture_does_not_start_workflow`, `session_only_restart_does_not_claim_recovery`, `close_reopen_pending_submission_does_not_resubmit`, `completion_clears_only_submitted_revision`, `other_vault_cannot_read_draft`, `draft_reply_never_calls_send` and `calendar_prepare_never_books`. Assert explicit destination/Open action and existing host relation/key/agent inheritance in one write.
- [ ] Run targeted capture/composer/recipe component tests plus `cargo test workflows::`; implement journey controls using existing AI elements and one shared waiting/effect record. Missing account/grant is repairable without losing the draft.
- [ ] Add guided flows for issue source → pinned recipe/version preview → GitHub issue approval → recorded result, and explicit dated sources → calendar artifact → review/save. A no-events/unavailable agenda never asserts free time. Reuse ACT's GitHub workflow as the third broker consumer after M96.5. Add `managed_gmail_without_adapter_is_unavailable` and `legacy_gmail_recipe_keeps_cli_ownership`; only after separately selecting the managed Gmail adapter slice, add `gmail_draft_adapter_never_sends`, `gmail_account_mismatch_preserves_input` and ACT lost-response/recovery cases before enabling its workflow control.
- [ ] Before a persistence adapter, obtain a separate storage/privacy/retention and mode-transition decision. Add opt-in cases `enable_persistence_preserves_canonical_ids`, `disable_keeps_active_memory_claim`, `discard_tombstone_is_not_resurrected`, `newer_session_revision_wins_restore`, `crash_after_create_reconciles_same_submission`, and `resume_after_mode_change_has_one_owner`. If durable receipt lookup is unavailable, leave persistence/restart recovery gated and ship UX session-only behavior.
- [ ] If system-wide capture is owner-selected, test shortcut registration conflict, focus return, app closed/not ready and main-editor ownership in packaged native acceptance. If unsupported, keep the existing launcher functional and state the limitation; no hidden agent launch on capture.
- [ ] Run `pnpm e2e e2e/workflow-journeys.spec.ts` and native focus checks. Verify resume returns to the pinned run with draft/reading position preserved; commit one complete journey per reviewable phase rather than requiring every optional slice to ship together.

### M98.8 — Gate intake, date overlays, record rules and publishing

**Files:** Create proposed `src/workflows/intake.ts` and tests; modify existing
`RecordComposer.tsx`, `CalendarView.tsx`, `engine/viewVocabulary.ts` and shared view
artifact only for an approved slice. If rules are selected, create
`src-tauri/src/workflows/record_rules.rs`, shared rule cases and writer integration;
otherwise produce an execution-time decision report. Publishing uses ACT policy
artifacts/adapters and receives no new raw connector route.

**Interfaces:** `IntakeConfiguration` names database/host, ordered field IDs,
form-only required fields and typed defaults in a reviewed Markdown-compatible
carrier (proposed: a fenced JSON configuration in an ordinary page; reserved type
routing is forbidden). `CalendarOverlaySource` is `(databasePath,fieldId)`;
placements include record and field identity. `RecordRulePlan` is a bounded
same-record derived mutation appended to its source guarded batch and undo.
Publishing can only use an approved `external_publish` ActionDefinition.

- [ ] Review observed repeated tasks and select each slice separately. Before coding, record carrier semantics, field rename/delete behavior and whether editor/import/API/agent writes trigger any rule. Reject universal form/automation/public-webhook scope creep.
- [ ] For intake, add `required_for_form_is_not_schema_required`, `deleted_field_blocks_without_losing_draft`, `defaults_keep_host_key_and_agent_inheritance`, and `repeat_submit_one_batch`; run targeted composer tests before/after implementation. Keep unstructured Capture unchanged.
- [ ] For calendar overlays, add two-date-one-record, duplicate source, unreadable source, malformed date, cross-midnight, DST and recurring-exception cases. Start read-only; no drag unless one placement maps to one supported writable field. Run `pnpm test:run src/views/CalendarView.test.tsx` and shared date cases.
- [ ] For same-record rules, add atomic rollback, no-op non-retrigger, bounded cycle, missing-number-not-zero, denied knowledge/provenance mutation and source-attribution cases. Run `cargo test workflows::record_rules`; join source edit/effect in one guarded receipt/undo batch, never a deferred UI-only callback. If demanded semantics cannot be made atomic, leave rules gated.
- [ ] For publishing, require a separate owner-approved target/account/effect-policy decision and ACT unknown/retry tests before registering an action. Otherwise show a local draft/export, no automatic publish. Run `pnpm test:run`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and Rust test/fmt/clippy release gates after chosen implementations; commit only the selected tested slices with explicit disabled/deferred decisions for the others.

### M98.9 — Workflow authoring, mapping and published-version UI

**Files:** Create `src/workflows/WorkflowEditor.tsx`, `src/workflows/StepInspector.tsx`,
`src/workflows/WorkflowVersionPicker.tsx` and colocated tests; create
`e2e/workflow-authoring.spec.ts`; modify the existing library/Agent contextual
navigation entry selected during owner review, IPC adapters and AI element adapters.
Do not add a second global destination without that navigation decision.

**Interfaces:** Consumes M98.1 `WorkflowDraft`, `WorkflowVersion`, supported schema and
validation diagnostics; M98.2/M98.3 WorkflowService; M98.5 preview. M98.9 owns WorkflowEditor/StepInspector/WorkflowVersionPicker; M98.7 consumes the inspector rather than creating it. Editor holds a local
revisioned draft and calls `save_draft(subject,draft,expected_revision)`;
`publish(subject,draft_ref)` returns the immutable version; selecting Run passes
that explicit versionRef to start. Mappings use the spec AST, never embedded scripts.
The selected published version, active version/disabled status and current draft
are visibly distinct. Expose explicit Enable, Pause and Unpublish using M98.4's
revision-checked methods; Publish never arms a trigger. Keep manual Run available
under its own admission checks, and explain that Pause stops future automatic
starts while Cancel run concerns an existing run.

- [ ] Write `author_read_map_condition_action_wait_result`, `invalid_mapping_preserves_draft`, `stale_save_conflict_keeps_local_edits`, `publish_selects_immutable_version`, `edit_while_waiting_does_not_change_run` and `unsupported_step_cannot_publish` component tests. Assert field-level diagnostics name step/path and account/target/action versions are inspectable. Add `publish_retains_disabled_state`, `enable_selects_reviewed_version`, `pause_preserves_waiting_run`, `unpublish_preserves_pinned_inspection`, `stale_activation_keeps_selection` and `skipped_branch_mapping_names_missing_producer` component cases.
- [ ] Run `pnpm test:run src/workflows/WorkflowEditor.test.tsx src/workflows/WorkflowVersionPicker.test.tsx`; expect initial missing-component failure, then implement add/reorder/remove steps, mapping controls, validation, Save draft, Publish and explicit version selection. Reorder preserves step IDs and flags invalid references instead of silently rewriting input.
- [ ] Add keyboard/screen-reader interaction for the step list, condition successors, input schema editing, account selection, validation links, publication conflict and version picker. Preview uses the unsaved draft; Run requires a published version and displays its hash/version label.
- [ ] Run `pnpm e2e e2e/workflow-authoring.spec.ts`; author a complete workflow, save/reopen, preview, publish, start and wait, edit/publish v2, resume v1 and inspect its unchanged schema/mapping/effects. Assert no action executes during authoring/preview/publication and no lost edits after IO/CAS failure.
- [ ] Run `pnpm typecheck`, `pnpm lint` and targeted tests; record narrow/light/dark visual and packaged native keyboard acceptance. Commit this separately reviewable authoring UI with its numbered M98 phase, after M98.1–M98.5 APIs pass their owning gates.

## Self-review and handoff

Research traceability: AX07 → M98.1–M98.4/M98.7/M98.9; CP08 → M98.5/M98.6; CP12 → M98.7/M98.8; n8n
N6 → M98.1–M98.4; Activepieces AP-04/05/06 → M98.1/M98.3/M98.5/M98.6; Plane PL03 →
M98.7. PL08's general saved-view bulk execution remains deferred pending membership
snapshot, per-record approval and partial-result recovery design; it is not
implemented by the bounded v1 runner. Morrow MR-08 → M98.7; Thought Desk findings 5/6/8 → M98.8. Shared action
receipts consume ACT rather than duplicating PL02/09 implementation.

FLOW-01 maps to M98.1/M98.3/M98.9; FLOW-02/03 to M98.2/M98.3; FLOW-04 to M98.4; FLOW-05 to M98.5;
FLOW-06 to M98.6; FLOW-07 to M98.3/M98.7/M98.9; FLOW-08 to M98.7/M98.8; FLOW-09 to M98.1/M98.2/M98.5/M98.6;
FLOW-10 to M98.8. The five Review Focus classes have named tests in their owning
tasks. Versions/continuations use one schema, effects reference ACT, and no task
quietly promises a running closed app or an OS sandbox. CP08 can deliver preview
while rehearsal remains unavailable; CP12 selects useful journeys without blocking
core workflow correctness. Owner review is required before implementation; these
drafts do not authorize builds, live accounts, staging or commits.
