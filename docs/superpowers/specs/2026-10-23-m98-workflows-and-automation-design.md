# M98 — Workflows and automation design

**Milestone:** M98 · **Phases:** M98.1–M98.9 · **Requirements:** FLOW-01–FLOW-10.

[Master roadmap](../plans/2026-10-23-m93-m99-master-roadmap.md) · [Research and traceability](2026-10-23-m93-m99-research/README.md).

Status: **DRAFT FOR OWNER REVIEW — 2026-10-23.** This proposes implementation
boundaries for AX07, CP08 and CP12. It authorizes no execution, provider call,
configuration change or production automation. No application or test was run.

## Intent, choices and scope

Turn a repeated useful task into a saved, inspectable sequence with explicit
accounts, permissions, waiting decisions and results. A person can preview a
trigger without consuming work, run a published version, close Cerebro while it
waits, reopen and understand what can resume. A workflow is a Rust-interpreted
versioned definition, not a recovered interpretation of a chat transcript.

Recommend a step list with an inspector before a graph editor. The first engine
is desktop-awake: local schedules and event dispatch execute only while the app,
vault and runtime are ready. Durable state survives closure; execution does not
continue secretly while closed. A hosted worker/relay, public webhook delivery,
parallel distributed jobs and always-on guarantees require a separate decision.
A canvas can later render the same definition, never create a second execution
model. Reusing an external server workflow engine would front-load deployment and
credential complexity; adding a sequence of model prompts would leave waits and
effects unowned. The small Rust interpreter is the recommended middle course.

Keep files as the current workspace authority. Proposed workflow definitions live
as typed JSON under an owned `.cerebro/workflows/` directory; this is a local
serialization decision, not approval to replace Markdown/YAML metadata. Runtime
step state is operational SQLite data. Owner review must approve the carrier,
limits and schedule defaults before implementation.

## Evidence and source corrections

The [expansion plan](../plans/2026-10-22-ai-expansion-plan.md),
[connector/workflow review](../plans/2026-10-22-ai-expansion-review/connectors-and-workflows.md),
[n8n N6](../plans/2026-10-22-ai-expansion-review/n8n.md),
[Activepieces AP-04/05/06](../plans/2026-10-22-reference-review/activepieces.md) and
[Plane PL03/08](../plans/2026-10-22-ai-expansion-review/plane.md),
[Morrow MR-08](../plans/2026-10-22-reference-review/morrow.md) and
[Thought Desk findings 5/6/8](../plans/2026-10-22-reference-review/thought-desk.md)
supply the design evidence. Reference Test buttons can invoke real services; they
do not establish a rehearsal boundary for Cerebro.

Current inspection found stronger foundations than “no durable automation”:

- [engine/triggers.ts](../../../src/engine/triggers.ts),
  [engine/wakes.ts](../../../src/engine/wakes.ts) and
  [useJobRunner.ts](../../../src/agent/useJobRunner.ts) supply frontend event
  matching/offers; [runtime/wakes.rs](../../../src-tauri/src/runtime/wakes.rs)
  admits checked offers and records claimable wakes. Production matching is not
  already one pure Rust preview API. Move the shared decision boundary deliberately,
  replaying existing cases while both evaluators exist.
- [runtime/dispatch.rs](../../../src-tauri/src/runtime/dispatch.rs) claims work,
  leases runs and conservatively recovers them. [followups.rs](../../../src-tauri/src/runtime/followups.rs)
  already books bounded self-followups, conditionally claims them and binds firing
  to the claimed actor/run. A workflow wait is a new continuation, not a replacement
  for these existing semantics.
- [runtime/catchup.rs](../../../src-tauri/src/runtime/catchup.rs) compares content
  hashes, respects held/in-flight work, and records closed intervals as exact or
  heartbeat lower bounds. Do not reintroduce mtime-driven replay or claim a new
  workflow schedule solves every existing catch-up contract.
- [AgentProperties.tsx](../../../src/library/AgentProperties.tsx) already uses
  draft-on-Done editing. [RecordComposer.tsx](../../../src/app/RecordComposer.tsx)
  already has schema defaults, destination logic and duplicate-submit prevention.
  [capture.ts](../../../src/lib/capture.ts) intentionally creates untyped Inbox
  notes. [starter recipes](../../../shared/starter/README.md) already offer useful
  tasks, including Gmail Draft reply which never sends. Extend these journeys.

No current live CLI isolation or durable external approval claim is asserted. The
[connected-actions spec](2026-10-23-m96-connectors-mcp-and-actions-design.md) owns the
canonical action/approval/effect state and must land before external workflow
steps promise restart-safe continuation.

## Requirements

1. **FLOW-01 — Immutable versions.** Keep one mutable draft and immutable published
   versions with stable step IDs and definition hashes. Every run pins one version;
   edits, unpublishing or renaming cannot reinterpret an existing wait. Provide
   step-list authoring, mapping/validation, Save draft, Publish and explicit
   published-version selection without executing actions during editing.
2. **FLOW-02 — Durable step ownership.** Record frozen inputs, attempts, outputs,
   wait reasons, lease/cursor and receipts transactionally. Resume claims one
   continuation, not the current workflow draft or a repeated chat instruction.
3. **FLOW-03 — Shared effects.** Invoke the ACT ActionService for every brokered
   action and reference its invocation/approval IDs. Unknown effects block dependent
   steps and unsafe retry. There is no workflow-local approval or effect ledger.
4. **FLOW-04 — Desktop-awake schedules.** Explain app/vault readiness, missed
   occurrences, explicit catch-up policy and cancellations. Reopening cannot create
   an unbounded burst or release existing recovery holds.
5. **FLOW-05 — Deterministic preview.** Preview selected sample page/event and clock
   through the same matching/admission decision path as production, without wake,
   budget reservation, lease, followup, connector call or enabled-state mutation.
6. **FLOW-06 — Rehearsal gate.** Live rehearsal is unavailable until filesystem,
   process configuration, network, credentials and every tool have proven enforced
   isolation or refusal. A copied vault and a read-only prompt are insufficient.
7. **FLOW-07 — Inspect and recover.** Show version/configuration used, input/output,
   proposed/confirmed effects, waits, skipped work and recovery options. Distinguish
   continue, retry step, reconcile effect and start new run; retain failed drafts.
8. **FLOW-08 — Useful capture and recipes.** Extend existing Capture/composer/recipe
   mechanisms with explicit destination, validation and reviewed execution. Capture
   writes once and never implicitly starts an agent, connector or published flow.
9. **FLOW-09 — No hidden authority widening.** Trigger input, sample fixtures,
   imported definitions and templates grant nothing. Scope/account/grant resolution
   occurs at run admission and again before consequential action dispatch.
10. **FLOW-10 — Bounded evolution.** Saved intake, calendar overlays, deterministic
    record rules and publishing remain individually gated slices. A universal
    automation builder is not an implied dependency of the first useful journey.

## Definition and execution contracts

Proposed Rust modules `workflows/{definition,service,runner,preview}.rs` own this
subsystem. CORE generates the transport DTOs. ACT owns effects. CHAT owns optional
supervised model jobs, not workflow state. The proposed files-first carrier is:

```text
.cerebro/workflows/<workflow-id>/draft.json
.cerebro/workflows/<workflow-id>/versions/<definition-hash>.json
.cerebro/workflows/<workflow-id>/published.json
```

All owned path components refuse symlinks and traversal. `published.json` selects
a validated immutable version with expected-revision publication; publishing writes
version bytes first and pointer last. A failed publish leaves the previous pointer
valid. External edits use checked read/hash semantics and cannot rewrite a version
under its old digest. Config files are not knowledge ingest material.

```typescript
type WorkflowVersion = {
  workflowId: string;
  definitionHash: string;
  formatVersion: 1;
  entryStepId: string;
  inputSchema: SupportedSchema;
  inputSchemaDigest: string;
  steps: StepDefinition[];
  trigger: TriggerDefinition;
  declaredActionDigests: string[];
  authoredBy: string;
};
type WorkflowRunState =
  'queued' | 'running' | 'waiting' | 'blocked' | 'succeeded' | 'failed' | 'cancelled';
type StepRunState =
  'pending' | 'running' | 'waiting' | 'blocked' | 'succeeded' | 'failed' | 'skipped' | 'cancelled';
```

`WorkflowActivation` is a separate mutable, revisioned operational binding:
workflow/vault ID, selected immutable version hash, enabled flag, activation
revision, trigger identity and schedule/event cursor. New workflows are disabled.
Publish validates/installs a version without enabling it or moving the active
binding. `enable(versionRef, expectedActivationRevision)` explicitly binds the
reviewed version and current scoped authority; `pause` disables new automatic
starts, and `unpublish(expectedPublicationRevision)` clears the publication pointer
and disables future automatic admission in one checked transition. Keep a recovery
journal for file-pointer/SQLite transitions: after interruption admission remains
held until reconciled, never briefly enabled with a mismatched version. A fresh
publication cannot silently replace an enabled version. Switching versions requires
explicit enable/replace and starts a distinct trigger/cursor identity.

Pause/unpublish do not cancel existing runs, consume waits or erase pinned versions;
Cancel run remains separate. New event/schedule claims recheck activation revision,
selected version, grants, readiness and recovery holds transactionally. Resume of
an existing wait checks its current authority and run cancellation, rather than
reinterpreting pause as cancellation. Initial enable starts its cursor at the
explicit enable instant, with no pre-enable backfill; paused time is excluded
from catch-up, and re-enable starts a new cursor epoch. Show skipped intervals
and preserve existing runs' occurrence identity. This adopts Activepieces'
[separate publication/status transition](../../examples/activepieces-main/packages/server/api/src/app/flows/flow/flow.service.ts#L506)
without importing its server/queue hosting assumptions.

`inputSchema` is immutable supported-schema bytes, included with its
`inputSchemaDigest` in the definition hash. Draft validation checks the digest;
publish/run admission rejects mismatch or unsupported schema and validates sample/
run input before writing a runnable step. A later schema change creates a new
workflow version; waiting runs keep their original schema.

`StepDefinition` is a discriminated union: scoped `read`, bounded `transform`,
`condition`, catalog `action`, `wait`, and `result`. Trigger configuration is on
the version, not an executable effect step. An action may enter an approval wait
using ACT's approval record; an explicit visual Approval row is that same wait.
An optional `agent` step requires CHAT's scoped ChildJobService, a frozen objective,
input references, output schema, grant intersection, budget and deadline; hide it
until that capability passes its own gate. No arbitrary script or shell step.

Every step has `stepId` and `label`. Read names an existing scoped vault query
and output schema; transform names a mapping and output schema; condition names a
predicate and `ifTrue`/`ifFalse` successors; action names action/definition/connection/
account IDs plus input mapping; wait names an absolute UTC timer or authenticated
external-input schema/expiry; result names an output mapping. Nonterminal steps
otherwise name `nextStepId`. Approval/child waits are engine-created references,
not caller-authored person decisions. Mappings are literal, field selection from
run input/prior output, object or array construction; predicates are equality,
numeric comparison, exists, all/any/not over those values. Proposed AST limits are
128 nodes and depth 16, evaluated by a counted interpreter. Missing selections
return typed missing, never zero/null invention. A step listed earlier but skipped
on this control-flow path has no output. Validate references against control-flow
availability; publication rejects a required mapping unless its producer executes
on every path reaching the consumer. `exists` and schema-optional selections may
inspect absent output without fabricating it. At runtime missing stays tagged, `exists(missing)` is false and comparisons
requiring a value return a typed mapping error. Missing required transform/action/
result input fails the consuming step with `missing_step_output` before ACT
prepare; optional fields may only be omitted under their declared schema. Never
substitute null, zero, a sample or another branch's output. See n8n's explicit
[unexecuted-node refusal](../../examples/n8n-master/packages/workflow/src/workflow-data-proxy.ts#L492).
Sequential v1 has no implicit merge/coalesce operator.

Initial limits are proposals: at most 32 steps, 256 KiB definition bytes, 256 KiB
normalized output per step and 8 MiB retained normalized output per run. Mappings
use a bounded declarative field-reference/literal/array/object expression vocabulary,
not JavaScript evaluation. Reject unsupported expressions, cycles, duplicate IDs,
unreachable steps and references to nonpreceding outputs. Execution is sequential;
conditions select explicit successors, with no parallel joins in format v1. Bounded
transforms enforce instruction/node/byte limits, rather than a promised timer around
uninterruptible evaluation. Large artifacts use separately capped references.

`WorkflowRun` stores run/vault/workflow/version IDs, trigger occurrence identity,
configuration/grant digests, state, cancellation intent and step cursor. `StepRun`
stores run/step IDs, attempt ordinal, immutable input/output references and digests,
lease revision, timestamps, action invocation ID or child job ID, and terminal/wait
reason. A provider outcome remains ACT's canonical `outcome_unknown`; the workflow
and dependent step project `blocked` with `reason: effect_outcome_unknown`.
A completed local read is not repeated merely to redraw an output card.
Before ACT prepare, persist a step attempt and deterministic requestKey derived
from `(workflowRunId, stepId, attemptOrdinal)`. ACT's unique scoped request mapping
returns the original invocation/approval after a crash before FLOW saves the link;
changed payload under that key conflicts. Persisting only the returned invocation
ID is insufficient. Recover by the stored requestKey, never allocating a new one.
The optional agent step has the same start-once requirement at CHAT's child-job
service: scoped key plus frozen request digest returns one child job after a
lost response. Keep that step unavailable until CHAT proves this linkage gate.

`WaitRecord` contains opaque continuation ID, run/version/step/attempt identity,
kind (`person_approval`, `timer`, `external_input`, `child_job`), expected revision,
due/expiry timestamps where applicable, scoped subject and status. Resume uses a
conditional transaction and authenticated signal identity. Duplicate/early/stale
signals cannot advance twice. A run bearer cannot answer a person approval.
External input is local authenticated IPC/inbound capability, not a new public
webhook listener. Timer waits persist due times; they fire only when dispatch is
ready. A remote Tasks handle belongs to ACT's action attempt, never a second
workflow-owned remote request.

Wait installation must not depend on an ephemeral completion notification. Persist
the action/child link and wait identity before parking; within the park transaction
observe the canonical ACT/CHAT outcome and either park or advance under the same
expected step revision. If the outcome arrives concurrently, preserve it in its
own durable owner and reconcile again after commit. Startup and bounded periodic
reconciliation inspect waiting/parking records against that canonical outcome,
including completion before wait creation, between link and park, and after
completion but before continuation claim. Consume the same continuation at most
once; never launch another action or child to recover a lost signal. External
input targets an already-issued continuation; unknown IDs are refused rather than
creating waits from caller input. Activepieces'
[pre-completed waits](../../examples/activepieces-main/packages/server/api/src/app/waitpoints/waitpoint-service.ts#L19)
and [completion during running](../../examples/activepieces-main/packages/server/api/src/app/waitpoints/waitpoint-service.ts#L148),
plus n8n's [parked-child sweep](../../examples/n8n-master/packages/cli/src/wait-tracker.ts#L318),
show why duplicate-signal rejection alone is insufficient.

Wait dispositions are fixed; normal step successors run only on validated success:

| Observed wait outcome                | Step/run disposition and recovery                                                                         |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Person approved                      | Claim once, revalidate ACT/current grants, then resume the same action invocation                         |
| Person denied                        | Step/run failed with `approval_denied`; no successor or automatic new approval                            |
| Approval or external-input expiry    | Blocked with `approval_expired`/`input_expired`; require explicit reviewed renewal, never replay          |
| Timer due while desktop ready        | Claim once and advance; not-due/not-ready remains waiting with lateness visible                           |
| Malformed external input             | Preserve waiting revision and append bounded rejection; return validation error, no advancement           |
| Duplicate/stale/wrong-subject signal | Refuse/no state change; never consume a newer wait                                                        |
| Child succeeded                      | Validate frozen output schema before advancing; invalid output fails with `invalid_child_output`          |
| Child failed                         | Step/run failed with `child_failed`; preserved output/receipt allows reviewed new attempt                 |
| Child interrupted/unavailable        | Blocked with `child_interrupted`/`child_unavailable`; reconcile the original child before any new attempt |
| Child/action confirmed cancelled     | Cancelled only if no uncertain effect remains; otherwise blocked and cancellation intent retained         |
| Grant revoked or target changed      | Blocked for review; a valid old continuation cannot restore revoked authority                             |
| ACT effect outcome unknown           | Blocked with `effect_outcome_unknown`; ACT reconciliation/retry owns recovery                             |

Workflow cancellation consumes pending waits and prevents successors, while active
child/action cancellation remains a request until its observed disposition meets
the table. Expired waits retain their version/input identities and reject late
signals. No outcome silently maps to a successful empty result.

```rust
WorkflowService::save_draft(subject: ActionSubject, draft: WorkflowDraft, expected_revision: u64) -> Result<DraftRef, WorkflowError>
WorkflowService::publish(subject: ActionSubject, draft_ref: DraftRef) -> Result<WorkflowVersionRef, WorkflowError>
WorkflowService::enable(subject: ActionSubject, version_ref: WorkflowVersionRef, expected_activation_revision: u64) -> Result<WorkflowActivation, WorkflowError>
WorkflowService::pause(subject: ActionSubject, workflow_id: WorkflowId, expected_activation_revision: u64) -> Result<WorkflowActivation, WorkflowError>
WorkflowService::unpublish(subject: ActionSubject, workflow_id: WorkflowId, expected_publication_revision: u64) -> Result<PublicationRef, WorkflowError>
WorkflowService::start(subject: ActionSubject, version_ref: WorkflowVersionRef, input: WorkflowInput, occurrence_id: OccurrenceId) -> Result<WorkflowRunRef, WorkflowError>
WorkflowService::resume(subject: ActionSubject, continuation_id: ContinuationId, expected_revision: u64, signal: ResumeSignal) -> Result<WorkflowRunRef, WorkflowError>
WorkflowService::cancel(subject: ActionSubject, run_id: WorkflowRunId) -> Result<WorkflowRunRef, WorkflowError>
WorkflowService::inspect(subject: ActionSubject, run_id: WorkflowRunId) -> Result<WorkflowRunView, WorkflowReadError>
TriggerPreview::evaluate(request: PreviewRequest, snapshot: AdmissionSnapshot) -> PreviewReport
```

`WorkflowDraft` is the version shape without `definitionHash`, plus draft revision;
`WorkflowInput` is JSON validated against `inputSchema`. `ResumeSignal` is a tagged
timer tick, authenticated external value, ACT approval outcome reference or CHAT
child outcome reference, checked against the stored wait kind. ID types are opaque
strings. `subject` uses ACT's scoped `ActionSubject`. The service creates/binds run identity
as required before actions. `PreviewRequest` names draft/version, sample identities
and explicit clock. `AdmissionSnapshot` is read-only current pause/scope/budget/
capability facts. `PreviewReport` records definition/sample/policy hashes, clock,
match/non-match, effective scope, refusal/defer reasons and `condition_required`
when a model condition has not run. Concurrent capacity changes may make later
admission differ; preview explicitly reserves nothing.

## Scheduling, recovery and retention

For new workflows, proposed default catch-up policy is `skip_missed`. Owners may
select `coalesce_latest` within a proposed 24-hour lookback; occurrence IDs include
workflow, version, schedule identity, timezone and intended UTC instant. A published
schedule change starts a new identity. No unlimited replay setting in v1. UI shows
missed/skipped/coalesced counts and first/last occurrence, plus unavailable coverage
if prior session bounds are incomplete. DST cases define one intended instant per
resolved occurrence; ambiguous/nonexistent local times require explicit schedule
semantics shared with production. Never infer missed execution from mtime alone.

Manual/event starts have their own dedup identities and bounded admission, not a
new schedule occurrence each UI click. Persist the manual start request identity
before submission; atomically bind scoped occurrence/request ID to frozen version,
input digest and one workflow run. Repeating the identical start returns that run;
changed input/version under the same key conflicts. Losing the response cannot
allocate a new run. An explicit Start new run gets a new identity after review;
workflow-start dedup does not replace ACT's unresolved-effect fence. Recover expired leases conservatively.
Completed steps stay complete; pending pure steps may resume after validation;
claimed consequential work consults ACT before any continuation. Changed account,
permissions or target bytes revalidate or return to review. A wait pins its original
version while current grants can still revoke authority. Cancel prevents pending
steps and requests cancellation of active actions/jobs; a run cannot claim full
cancellation while an effect remains unknown. The UI may say “Stopped; outcome
unknown” with a blocked run and persistent cancellation intent.

Retain every version and minimal input/output identity needed by nonterminal runs,
waits and unresolved effects. Tombstone a deleted workflow; do not destroy its
pinned version. Proposed completed-run detail retention is 90 days, subject to
owner policy/quotas; optional verbose outputs can follow stricter source privacy.
Historical bytes absent after approved cleanup are unavailable, not reconstructed
from current pages. Full storage refuses new durable work visibly. Ordinary chat
cleanup cannot erase ACT reconciliation records. Secrets and access tokens never
enter definitions, samples or operational snapshots. Sensitive samples require
explicit selection and support deletion; deleting required sample bytes makes a
future rehearsal unavailable rather than substituting new content silently.

## Preview, rehearsal and everyday journeys

Preview trigger appears beside Agent draft controls and workflow trigger editing.
It evaluates the unsaved draft without enabling it. Production event matching and
admission must consume the same authoritative decision function; while a TS twin
remains, shared cases/digests and parity gates are mandatory. Preview is useful even
if no model can run: show match, scope, pause/budget and model-condition prerequisite.

A limited instruction test can be labeled “Read-only instruction test” only when
all admitted tools enforce that boundary. Full rehearsal requires an explicit
per-tool disposition (`simulated`, `refused`, `unavailable`) and isolated runtime
sink incapable of minting production receipts, wakes or followups. Disable shell,
raw filesystem escape, inherited servers, actual credentials and external mutations.
Adversarial absolute paths, symlinks, subprocess/network and inherited config must
fail. If supported CLI/platform cannot enforce this, ship deterministic preview and
record the blocker; do not ship a reassuring Rehearse button. Results contain
proposed diffs, expected approvals, refused capabilities, measured/unknown usage
and limits. Apply is a new checked human write against current bytes.

Complete these explicit journeys incrementally, with GitHub as the first managed workflow:

- Capture an untyped thought to Inbox, show its destination and Open action; save
  an optional named intake configuration that reuses RecordComposer defaults,
  required-for-form fields and existing host/key/agent inheritance in one write.
  A creation draft remains separate from a page, using UX's session-only
  Resume/Discard and claim/revision model; restart persistence is a later opt-in
  adapter gate, never an additional recovery surface.
- First run the GitHub read/reviewed-issue workflow through ACT's implemented
  provider slice, inspect its pinned recipe/workflow version and same effect from
  Runs. Missing account or grant is repairable without losing input. Existing
  Gmail Draft reply remains explicitly CLI-owned compatibility behavior. A managed
  Gmail workflow stays unavailable until a separately selected drafts-only
  `gmail.draft.create`/read-back adapter, account scopes, source privacy, preview
  and ACT unknown/recovery tests have an owning implementation task; M96's GitHub
  adapter does not supply those capabilities. It never sends.
- Prepare a calendar event/ICS artifact from explicit dated sources and review it.
  Existing agenda does not infer free time. External event creation, publishing or
  notifications are separate action decisions; an artifact export is not proof of
  a booked event. A GitHub issue workflow can reuse ACT's first provider slice.

Creation drafts belong to [UX's canonical contract](2026-10-23-m94-ui-polish-and-journeys-design.md):
`CreationContext`, `CreationDraft`, `creationDraftKey`, revision-checked snapshots,
claim/release/move and `creationDraftStore`. Reuse its one Resume/Discard surface
and pending submission journal; do not add CaptureDraftService, another store or
another draft owner. Stage one is session-only, with zero draft disk persistence
and no restart promise. Consume UX's exact `CreationSubmission`, `CreationSubmitStart`,
`readCreationSubmission`, `beginCreationSubmission`, `settleCreationSubmission` and
`submitCreationDraft(context,revision)` exports; only `started` invokes the writer,
while `pending` returns the same submission and `stale` submits nothing.
A pending submission keeps UX's stable submissionId,
frozen context and draft revision/snapshot until terminal acknowledgement
or reconciliation. This pending-operation ownership is independent of the dialog
claim, which is released on close/unmount; dialog close/reopen cannot resubmit it. Completion is owned
outside the dialog and clears only its submitted revision.

A later FLOW persistence adapter is an explicit opt-in owner gate for that same
canonical store, including its pending submission journal. No implicit seven-day
retention or archive is approved. The gate must select storage/privacy/retention,
explicit enable/disable/export/removal semantics and migration of canonical keys,
revisions, claims and tombstones. Restoring must not resurrect discarded revisions,
replace newer session edits or allocate new submission IDs. Reconcile the existing
guarded writer's receipt by stable submissionId after a crash before clearing;
never create a second page. If the writer cannot support this receipt lookup,
persisted submission/restart recovery stays unavailable. Vault switching never
reveals another vault's draft or navigates there on late completion. Intake event
disposition reuses existing import outcomes; a suggestion becomes a duplicate only
after a deliberate recorded choice. This adapter is not REL's page-editor save
queue or CHAT's composer draft storage.

System-wide capture requires a separately proven native shortcut/focus lifecycle;
registration conflicts retain the normal launcher. Opening/cancelling creates
nothing. Publishing recipes or remote updates stay disabled until an approved
`external_publish` definition, target preview and ACT receipt exist. Saved intake,
read-only calendar overlays and bounded same-record rules each need observed need
and an approved carrier/semantics task; never route on business type names or make
Capture unexpectedly structured. Deterministic record rules, if admitted, must
join their source edit's guarded atomic batch and undo, handle no-ops/cycles and
explicitly define editor/import/API/agent trigger sources.

## Acceptance and decisions

Acceptance includes version edits during waits, duplicate/out-of-order resumes,
restarts at every step boundary, lost remote responses, revocation, cancelled child
jobs, DST/missed schedules, unavailable sample bytes, preview/production parity,
adversarial rehearsal escape and duplicate capture submission. The user can inspect
what ran and choose recovery without replaying already completed effects.

Dependencies are ACT durability, CORE generated contracts/runtime facilities,
CHAT child jobs for optional agent steps, and KNOW outcome evaluation before
claiming model rehearsal quality. Owner decisions: JSON carrier and limits;
desktop-awake/catch-up defaults; retention/quotas; which intake/calendar/rule slice
has demonstrated value; supported isolated platform; and whether publishing or an
always-on service receives a separate future design. These remain proposals.
