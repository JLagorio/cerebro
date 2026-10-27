# M93–M99 — Cerebro master roadmap

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the research as independently accepted reliability, AI, integration, knowledge, storage and UI capabilities.

**Architecture:** Seven subsystem plans share explicit contracts and retain current authority until a selected migration. This plan coordinates dependencies and release slices; implementation details live once in each owning plan.

**Tech Stack:** Existing Tauri 2/Rust, React 19/TypeScript, Markdown/YAML, SQLite operational stores, current CLI and shared conformance artifacts. New storage/backend choices are decision-gated.

**Spec:** [Integrated program design](../specs/2026-10-23-m93-m99-program-design.md).

**Status:** Implementation authorized by the owner on 2026-10-23, on the existing
branch alongside Claude's M92 work. See the [implementation record](2026-10-23-m93-m99-implementation-record.md)
for completed checks, open work and concrete decisions. Phase checklists remain
requirements, not evidence that checks passed. Conditional owner decisions and
native/live acceptance remain explicit gates; no milestone is complete.

**Final check:** [Source-backed final review](../specs/2026-10-23-m93-m99-research/final-review.md) · [Eight-repository cross-check](../specs/2026-10-23-m93-m99-research/reference-crosscheck.md).

**Review entry points:** [Program spec](../specs/2026-10-23-m93-m99-program-design.md) · [Research index](../specs/2026-10-23-m93-m99-research/README.md) · [Decision register](../specs/2026-10-23-m93-m99-research/decisions.md) · [Finding-to-phase coverage](../specs/2026-10-23-m93-m99-research/traceability.md).

**Current storage decision packet:** [M99 authority, consumer cutover and complete-workspace backup](../specs/2026-10-23-m99-workspace-authority-decision.md). Includes the completed disposable 5,000-record comparison. The owner selected SQLite metadata with visible Markdown bodies; implementation is underway. Production migration and conversion of the current vault remain separate and unperformed.

## Global Constraints

- Existing product rules remain until an explicitly reviewed amendment. M93–M99 and their numbered phases below identify this program; M91 and M92 keep their existing ownership.
- UI work and Rust service work proceed in parallel; neither requires a production metadata migration.
- Every shared contract has the single owner named in the program design.
- Current CLI remains default; no provider API key enters that existing path.
- Mail remains drafts-only; broader send/publish/delete classes need separate decisions.
- `outcome_unknown` never becomes an automatic retry; raw managed provider access cannot bypass ACT.
- Documentation claims, source checks, browser/native observations and live execution evidence stay distinct.
- Preserve all unrelated work. The owner explicitly authorized this implementation on the existing branch alongside Claude's M92 work; coordinate shared file ownership without resetting or moving that work.

## Review Focus

1. New policy data ahead of loaders/consumers prevents startup — PROG-T01 ties coherent source identity to the baseline.
2. A new attempt ID bypasses unknown-effect protection — PROG-T03 includes cross-surface recovery, ACT and CHAT regressions.
3. Two stores resume or submit the same creation draft — PROG-T04 requires UX/FLOW identity and persistence handoff tests.
4. Old-client access or rollback silently discards post-cutover edits — PROG-T05 requires compatibility limits and post-edit export proof.
5. A complete-looking UI hides failed reads, lost drafts or skipped native checks — PROG-T02/T06 require separate behavioral/evidence gates.

## Milestones and paired documents

Numbering identifies ownership, not a requirement to finish all of M93 before starting M94. The dependency column and release slices below determine execution order. All seven milestones are **in implementation**; conditional phases retain their explicit decision gates.

| Milestone                                | Spec / plan                                                                                                                               | Phases       | Scope                                                                                            | Dependencies                                                                                        |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| M93 — Reliable workspace                 | [Spec](../specs/2026-10-23-m93-reliable-workspace-design.md) · [Plan](2026-10-23-m93-reliable-workspace.md)                               | M93.1–M93.11 | Retained saves, honest history/readiness, source recovery and measured scale.                    | Current editor/runtime baseline; chat/native evidence coordinates with M95.1.                       |
| M94 — UI polish and journeys             | [Spec](../specs/2026-10-23-m94-ui-polish-and-journeys-design.md) · [Plan](2026-10-23-m94-ui-polish-and-journeys.md)                       | M94.1–M94.9  | Polished document, collection and utility surfaces; creation recovery and dependable navigation. | M93 save semantics for integrated journeys; accepted M91→M92 handoff before assistant changes.      |
| M95 — Chat and supervised agents         | [Spec](../specs/2026-10-23-m95-chat-and-supervised-agents-design.md) · [Plan](2026-10-23-m95-chat-and-supervised-agents.md)               | M95.1–M95.7  | Recoverable conversations, precise source/artifact use and supervised child jobs.                | M91→M92 handoff; M93 flush/history, M96 effects and M97 source contracts for their consumers.       |
| M96 — Connectors, MCP and actions        | [Spec](../specs/2026-10-23-m96-connectors-mcp-and-actions-design.md) · [Plan](2026-10-23-m96-connectors-mcp-and-actions.md)               | M96.1–M96.8  | Managed accounts, MCP boundaries, durable approvals and action recovery.                         | Current policy/runtime; self-contained beta, independent of metadata migration.                     |
| M97 — Knowledge, evidence and evaluation | [Spec](../specs/2026-10-23-m97-knowledge-evidence-and-evaluation-design.md) · [Plan](2026-10-23-m97-knowledge-evidence-and-evaluation.md) | M97.1–M97.8  | Precise source locations, scoped evidence/configuration and outcome evaluations.                 | M93 run/source identity; M95/M96/M98 adapters only for their integrated evidence cases.             |
| M98 — Workflows and automation           | [Spec](../specs/2026-10-23-m98-workflows-and-automation-design.md) · [Plan](2026-10-23-m98-workflows-and-automation.md)                   | M98.1–M98.9  | Versioned workflow authoring, durable steps/waits, preview and everyday automation.              | M96 durable effects; M94 creation ownership; M95 capability proof only for child-job steps.         |
| M99 — Rust services and storage          | [Spec](../specs/2026-10-23-m99-rust-services-and-storage-design.md) · [Plan](2026-10-23-m99-rust-services-and-storage.md)                 | M99.1–M99.8  | Typed Rust services, storage comparison and a separately chosen YAML/metadata migration.         | Current file authority and M93 save semantics; migration requires a storage/compatibility decision. |

Requirement prefixes (`REL`, `UX`, `CHAT`, `ACT`, `KNOW`, `FLOW`, `CORE`) remain stable for traceability. Milestone phases are the canonical task IDs; the research register maps the earlier `*-Tnn` aliases to them. `PROG-T01–06` below are roadmap coordination checklists, not additional product milestones.

## Shared source ownership

Assign one editor at a time to IPC adapters, `agent/mod.rs`, policy artifacts,
runtime schema, NoteBodyEditor, RecordComposer and RunDetailPanel. Parallelism
means independent owned files or sequential integration, not concurrent edits to
these central seams. Shared contract changes are reviewed by consuming workstreams.
Future commits use the owning phase from M93.1–M99.8, following `type(scope): sentence (M<number>.<phase>)`. The numbered milestones organize implementation and acceptance; phase completion requires the evidence in the implementation record.

## Existing M91 and M92 handoff

[M91 — AI elements and subagents](2026-10-22-m91-ai-elements-and-subagents.md) and
[M92 — The conversation rail](2026-10-23-m92-conversation-rail.md) keep their
existing milestone ownership and gates. M92's plan requires M91's final gate;
this roadmap neither marks that gate passed nor reassigns the rail work.

Before M94 or M95 changes assistant, transcript, context or rail seams, reconcile
the accepted M91→M92 handoff at its recorded revision. Preserve the canvas-only
Conversation details rail, shared Context pull, Plan/Subagents/Changes/Sources/
Handed off adapters, reach and thread-status facts, read-only cards and canvas-safe
navigation. Record unfinished and unverified parts explicitly; dependent phases
wait for the owning gate. Unrelated reliability, page polish, action contracts
and storage prototypes can proceed independently.

M95 source-context receipts record which source material reached a turn. They do
not persist M92's context-token readings or introduce another context poll.
Managed account/action controls in M96 remain outside the read-only conversation
rail unless a later reviewed amendment changes M92's contract.

## First build sequence after this review

This sequence delivers a usable application in increments. Milestone numbering
is not a seven-project waterfall. Read each paired spec/plan before its phase;
keep one writer for shared source files and preserve the existing M91/M92 work.

| Increment                                       | Exact phase order                                                                                                                                                                                      | Demonstrable exit                                                                                                                                                                                                                                  |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Dependable daily workspace                   | M95.1/M94.1 handoff and M93.6 baseline can run independently; M93.1 → M93.2 → M93.3/M93.4, with M93.5 independent; M94.2 → M94.3 → M94.4/M94.5 integrates those barriers                               | Write a page, diagram or cell; force a save failure; Retry; leave/return without a lost draft. Create/resume the right blank page or sheet. Read scoped run history. Review the same populated four surfaces in both themes and real narrow panes. |
| 2. Useful answers and precise sources           | M97.1 → M97.2; M95.4's local Copy/Save/selection actions use existing writers; M95.2 → M95.3 follows the archive choice, then durable receipt/artifact consumers in M95.4; M97.3/M97.4 supply evidence | Ask using selected material, open the exact source, return to results, copy/save a useful answer, and reopen retained conversation content with honest missing/expired states. Archive completion works while its thread is detached.              |
| 3. One complete connected action                | M96.1 → M96.2/M96.3 → M96.4 → M96.5/M96.6, then M95.5 recovery consumer                                                                                                                                | Select one github.com login through native gh import, read an issue, review account/target/arguments, create once, inspect the receipt, and recover a lost response without automatic repeat.                                                      |
| 4. Repeatable work                              | M98.1 → M98.2/M98.3; M98.9 authoring consumes those APIs; M98.4/M98.5 add explicit activation and preview; M98.7's first managed recipe uses GitHub                                                    | Save/publish while disabled, preview, explicitly enable a pinned version, pause future starts, survive approval/early completion/restart, and inspect one outcome. Managed Gmail is not part of this exit.                                         |
| 5. Parallel Rust investment and later decisions | M99.1 → M99.2/M99.3 → M99.4 → M99.5; M99.6 staging requires complete consumer adoption; M99.7/M99.8 prove recovery/backup before any production activation                                             | Compare selected-store behavior on copies and explain portability/restore costs. Retain guarded concept YAML in the first conversion. UI, chat and connected releases do not wait for format cutover.                                              |

M95.6/M95.7 independently scoped children, M96.7/M96.8 protocol/backend extensions,
M98.6 rehearsal and other conditional work remain separate capability decisions.
A narrow feature with a complete journey ships before optional infrastructure.
The current foreground researcher and M92 monitor retain value without these jobs.
M94.6–M94.9 finish cross-surface adoption after the four-surface comparison;
M93.7 follows measured scale evidence, not a guessed virtualization rewrite.

Local artifact actions do not acquire an ACT dependency: they consume the
existing human batch/editor writer and M93 acknowledgement. M95.4 may deliver
those controls with session-only inspection before an archive choice; durable
context receipts and archive storage remain disabled until M95.2/M95.3 land.
M98 reuses M94's complete creation recipe/variant, revision and submission identity
when its separately selected persistence adapter is introduced.

### Build acceptance and known baseline

The [M91 implementation record](2026-10-23-m91-implementation-record.md) reports
15,973 unit tests passed **with 11 failures**, and 769 E2E passed **with 42
failures**, plus qualified Rust/native/live evidence. These are historical reported
results, not this review's execution or a clean baseline. Before editing shared
seams, capture current source/tool/build identity and reproduce affected failures.
Record test name, expected behavior, baseline/regression classification, owner,
reproduction and repair/disposition in the handoff evidence. Preserve earlier
records; do not rewrite them into green status.

A focused increment needs its relevant regressions and full journey passing.
Unrelated baseline failures remain visible with owners; affected failures block
that slice. An overall release candidate is not green until its required suites
pass and packaged/native/live-provider acceptance is completed or its unsupported
feature is explicitly excluded. Do not lower coverage, remove an assertion, skip
a hook or accept a screenshot in place of behavior to close the gate.

The final source review corrected implementation holes, not running software.
Its [audit/evidence](../specs/2026-10-23-m93-m99-research/final-review.md) records
what was inspected, changed and left to actual implementation acceptance.

## Release sequence

| Slice                    | Content                                                                                                                             | Dependency / stop condition                                                    |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| A — coherent baseline    | Current M91/M92 reconciliation; REL save/history/readiness reproductions; UI baseline; initial outcome corpus                       | Known failures have owners; no stale inventory treated as current              |
| B — daily quality        | Four-surface UI comparison, session creation recovery, scoped history, source landing and measured performance work                 | Existing behavior/identity preserved; visual and native status explicit        |
| C — connected beta       | Rust action contract, selected-account native gh import, managed GitHub read/create, approval/effect recovery and shared inspection | Raw provider bypass absent; unknown response cannot repeat silently            |
| D — useful AI continuity | Chosen chat retention, source/context/artifact flow, configuration/evidence inspector and supported connector recipes               | Retention decision and real producer/read/cleanup contracts                    |
| E — repeatable work      | Workflow editor/versioning, waits/schedules, deterministic preview; scoped child jobs if supported                                  | ACT durability; child/rehearsal capability proof for their respective features |
| F — authority decision   | Two-store prototype, decision record, selected migration only after recovery/backup proof                                           | Owner chooses portability; compatibility and post-cutover rollback accepted    |
| G — optional extensions  | MCP Apps/Tasks, second backend, intake/rules/overlays, measured retrieval and other explicit experiments                            | Individual acceptance; no dependency on these for A–D                          |

These slices overlap where contracts allow. CORE's prototype and UX composition
can proceed beside C. FLOW deterministic preview does not require full rehearsal.
CHAT scoped jobs do not turn on merely because nested researcher rendering works.
Optional workspace migration must not hold the connected beta hostage.

### PROG-T01 — Approve bounded scope and reconcile current work

**Files:** Program decision/evidence records, existing M91/M92 plans, selected subsystem
specs/plans. No product edits in this coordination task.

**Interfaces:** Produces an accepted subset of requirements, milestone ownership,
current implementation/evidence matrix and source/build identity.

- [ ] Read the [decision register](../specs/2026-10-23-m93-m99-research/decisions.md) with the owner. Record accepted/proposed/deferred per decision; approval of one workstream never implies a format migration or external sending.
- [ ] Execute M95.1 and M94.1 reconciliation against the current M91→M92 handoff, without taking over those milestones. Preserve implemented reducer/context/branch/adapters; run applicable policy/IPC/stream checks on pinned tools and record actual startup behavior.
- [ ] Assign REL's known correctness repairs, initial scale baseline and KNOW's twelve outcome cases. Retain failed/skipped evidence as such.
- [ ] Assign isolated implementation ownership to the already numbered milestone phases. Review shared interfaces before any parallel consumer implementation.
- [ ] Commit only the accepted execution baseline/decision record; remaining proposal branches stay disabled.

### PROG-T02 — Deliver the first daily-work and visual slice

**Files:** Owned paths in M93.1–M93.7, M94.2–M94.5 and M97.1–M97.2; paired evidence
artifacts under their plans. No second save/creation/navigation owner.

**Interfaces:** REL acknowledgement/flush; UX context/revision/submission; KNOW
source locator and resolution. Consumers use these exact contracts.

- [ ] Add and reproduce failed-save, stale history/readiness and source-location regressions from the owning plans. Include leave/quit before and after a settled failure.
- [ ] Complete selected repairs and capture the four UI surfaces with identical populated content. Review compositions in light/dark at actual pane widths and real zoom.
- [ ] Run create→close→resume→acknowledge and search→source→Back journeys across panes/vaults; a pending submission cannot be repeated from a remounted composer.
- [ ] Reproduce scale workloads and record p50/p95/timeouts separately from screenshot acceptance. Do not close performance with a denser row style.
- [ ] Run relevant browser/native acceptance; record unresolved environment limits. Commit each reviewed behavior, then the accepted visual slice.

### PROG-T03 — Prove the managed connected-action beta

**Files:** M96.1–M96.5/M96.6 core paths, M95.5 recovery consumer, M97.6 fixtures;
M99.1 transport pilot only where useful, not the storage prototype.

**Interfaces:** Trusted `ActionSubject`, immutable definitions, idempotent prepare,
one dispatch claim, compact effect reference and scoped detail/revision reads.

- [ ] Run ACT's fake-provider cases first: changed account/arguments/grants, duplicate decisions, orphan prepare, request timeout after remote success and unknown-effect fence across new run IDs.
- [ ] Implement one GitHub connection, one read and one reviewed issue creation. Prove provider secrets/raw server are not also exposed to the CLI for that managed connection.
- [ ] Exercise approval from two surfaces, restart during the attempt and inspect the same action from chat and Runs. Preserve exact account/target and all confirmed/unknown results.
- [ ] Conduct explicitly authorized isolated provider trials and retain sanitized evidence; deterministic fake-provider success is not live-provider compatibility.
- [ ] Accept or reject the beta by its complete journey. Do not add providers until this outcome is reviewable and reliable.

### PROG-T04 — Add AI continuity and repeatable work

**Files:** M95.2–M95.7, M97.3–M97.7, M96.6, M98.1–M98.5/M98.7/M98.9 and M94.6–M94.8
as selected. M98.6 rehearsal remains an independent gate.

**Interfaces:** CHAT-owned archive/prune/child-claim service; KNOW inline locations
and manifests; ACT effects; FLOW immutable versions and durable step identity;
UX creation draft remains the single UI owner.

- [ ] Approve retention/quotas before durable content collection. Test off/expire/delete/export and active-run behavior without implicit effect cancellation or loss of ACT reconciliation receipts.
- [ ] Deliver context/evidence/artifact and selected-text review journeys, then re-open them with missing CLI transcripts and changed/revoked sources.
- [ ] Implement workflow authoring/publication and restart-safe runner/waits using the pinned definition and ACT preparation identity. Publication starts disabled; enabling pins a selected version and pausing stops new admission. Test crash between preparation and FLOW linkage, completion before wait parking, wait denial/expiry and malformed resume input. Use GitHub as the first managed recipe; a future managed Gmail adapter has its own owned authentication/privacy/action gates.
- [ ] Keep initial creation recovery session-only. Enable FLOW's persistence adapter only after its separate retention decision, with shared draft/submission identity, discard tombstone and duplicate-create reconciliation tests.
- [ ] Enable child jobs or rehearsal only after their respective process/config/tool capability proof. If unsupported, keep the feature unavailable and ship the useful proven preview/workflow subset.
- [ ] Record full offline outcomes, selected repeated live tasks and actual native interactions; commit reviewed slices rather than one cross-cutting rewrite.

### PROG-T05 — Decide Rust storage independently

**Files:** M99.1–M99.8, authority decision and prototype reports; selected product
brief/help/backup compatibility changes. Existing reference plans stay historical.

**Interfaces:** CORE value/identity/store APIs, explicit authority choice, migration
manifest and recoverable file-plus-metadata journal.

- [ ] Run both temporary stores on identical adversarial and scale corpora. Explain whole-workspace portability, external edits and restore costs before choosing a format.
- [ ] Keep production on current authority until the owner selects a store. If neither option wins, retain the Rust service improvements without a migration.
- [ ] For selected migration, test new-root conversion, supported-client format refusal, external body conflicts and unsupported legacy binary limits. A marker cannot constrain already-released unguarded clients.
- [ ] Before enabling cutover, prove backup/restore and interruption recovery plus legacy export after new post-cutover edits. Old snapshot restoration alone is not rollback.
- [ ] Inventory remaining YAML carriers: retain governed concept projection YAML/codec and old attestations in the first conversion; explicitly include or defer sheet-source conversion. Require the complete selected-authority consumer matrix and backup/restore categories before activation. Update user-facing promises only when the accepted format actually ships.

### PROG-T06 — Close release evidence and review optional extensions

**Files:** Per-workstream test/evidence records and program review register;
selected optional task/report files only.

**Interfaces:** One release decision lists implemented, accepted, defect,
environment-blocked and deferred outcomes with source/build identity.

- [ ] Confirm every accepted numbered requirement maps to an implemented task and evidence; trace deferred findings to a reason/re-entry condition.
- [ ] Run appropriate pinned-toolchain unit/Rust/type/lint/format gates; preserve coverage ratchets and hooks. Use real browser/native/live evidence where the contract requires it.
- [ ] Have the owner review same-content visual comparisons and complete interaction journeys. Record aesthetic acceptance separately from contrast, geometry and timing measurements.
- [ ] Reassess optional MCP Apps/backend/rehearsal/graph/import/recall work against its stated gate. Never count a disabled control or research prototype as delivered capability.
- [ ] Final review verifies no repeated approval, lost draft, scope leak, fabricated verification or automatic unknown-effect retry. Integrate only the accepted subset using the chosen execution workflow.

## Effort and execution handoff

Earlier research allowances remain hypotheses, not a delivery schedule. The UI's
four-surface slice was estimated at 4–7 engineer-days and cross-surface adoption
at 4–7 engineer-weeks; both require re-estimation after current baseline capture.
The earlier storage migration allowance of 16–28+ engineer-weeks is especially
uncertain until the two-store prototype and compatibility decision. Do not sum
CP/AX/UI estimates: many refer to the same work now owned once here.

At execution planning, estimate accepted tasks using actual repository velocity,
native/provider availability and shared-file ownership. An implementation method
has not been selected by this drafting request. Review the documents first; choose
execution method and accepted slices only when implementation is requested.

## Self-review

The seven design areas map to their owning plans and PROG-T01–06. Cross-package
failure classes in Review Focus have explicit owning regressions. The master does
not redefine implementation types, duplicate task estimates or convert historical
research into current test passes. Remaining owner choices are intentional gates,
not permission for an implementer to guess a new product promise.
