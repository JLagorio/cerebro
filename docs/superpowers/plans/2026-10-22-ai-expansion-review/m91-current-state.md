# M91 current-state audit: foundations ahead of the chat experience

Reviewed 2026-10-22 at approximately 13:56 America/Los_Angeles. This is a
source audit of the working tree, not a claim about a shipped build. The tree
contains staged and unstaged work; additional AI component files appeared during
inspection. Treat the findings as a checkpoint to reconcile with Claude's next
handoff. No application code, reference repository or test was changed, and no
test suite, live CLI probe or native acceptance was executed for this review.

The [M91 plan](../2026-10-22-m91-ai-elements-and-subagents.md) is still marked
**PLANNED**. Its code is substantially underway: built-in admission, structured
events, child transcript folding, pure parsers and presentation components exist.
However, the production chat has not adopted the new components, and its reducer
has not adopted the new child-event contract. M91 is therefore an implementation
dependency for the expansion roadmap, not a completed baseline to build past.

## Implementation inventory

“Present” means source and, where named, test source were inspected. It does not
mean the tests passed or the behavior was verified against the installed CLI.

| M91 area                            | Observed state                         | Evidence and remaining completion boundary                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M91.1 built-in admission            | Substantially present                  | [build_args](../../../../src-tauri/src/agent/mod.rs), around line 1883, supplies `--tools` from the approval plan and retains denials. `InitGate`, around line 3075, refuses an unknown built-in reported by init. Manifest aliases/families and policy goldens exist. This is a significant strengthening; it is not proof of all later subagent restrictions.                                                         |
| M91.2a delegation policy            | Partial                                | [tool-approval.v1.json](../../../../shared/policy/tool-approval.v1.json) has `delegate` with `needs_gate: true`, but its ceiling is still `none`. [subagents.v1.json](../../../../shared/policy/subagents.v1.json) contains four environment caps: foreground, depth, concurrent count and session count. It does not yet contain the planned preset, seated environment, built-in-agent disable or settings overrides. |
| M91.2b subagent execution           | Not complete                           | The inspected argv has no `--agents`, `--append-subagent-system-prompt`, `--forward-subagent-text` or summarized-thinking option. `InitGate` checks built-in tools, not the planned allowed/denied agent types. [interaction.rs](../../../../src-tauri/src/agent/interaction.rs), line 1337, still refuses any gated call with an `agent_id`; it has not gained the planned allowed-type exception.                     |
| M91.2c accounting                   | Partial prerequisite only              | [usage.rs](../../../../src-tauri/src/agent/usage.rs), line 182, now excludes parented/sidechain assistant lines from the main run's model facts. [Tally](../../../../src-tauri/src/agent/meter.rs), line 220, still reads ordinary result usage; the whole-tree `modelUsage` parser and explicit missing-child-share state are absent.                                                                                  |
| M91.2d Settings and IPC             | Not found                              | The inspected Settings, UI store, `RunOptions`, `AgentRequest` and agent adapter contain no delegation setting/wire field. The plan's “Subagents” user control cannot yet be treated as available.                                                                                                                                                                                                                      |
| M91.3a structured fold              | Substantially present                  | [fold.rs](../../../../src-tauri/src/agent/fold.rs) and [event types](../../../../src/agent/types.ts) carry parent/time fields, complete thinking blocks, structured tool results, tool denials and terminal UUIDs. Tests cover empty reasoning, parsed results and stripping the agent usage trailer.                                                                                                                   |
| M91.3b child replay and attribution | Substantially present                  | Child folds have their own identity/state; [transcript.rs](../../../../src-tauri/src/agent/transcript.rs), around line 500, reads sidecar transcripts and merges them into the existing fold. Tests cover unreadable children, chunked reading, per-parent live/replay projections, journal bounds, capture exclusion and child writes committed with the parent run.                                                   |
| M91.4 reducer and persistence       | Not implemented in inspected consumers | [transcript.ts](../../../../src/agent/transcript.ts) still models a flat list and last-message answer. `ChatMessage` has no ordered parts or checkpoint anchor; `ToolCall` has no nested subagent. [conversations.ts](../../../../src/agent/conversations.ts), line 326, has no new summary persistence or quota-recovery contract.                                                                                     |
| M91.5 context-use pull              | Not found                              | The `Context` component exists, but no `agent_context_usage` command/adapter or `ContextBook` producer was found. A ring component is not a measured context feature.                                                                                                                                                                                                                                                   |
| M91.6 branches                      | Not found beyond event preparation     | `last_uuid` exists on the event; [CliSession](../../../../src-tauri/src/agent/transcript.rs), line 259, still has only `New` and `Resume`. There is no fork session variant, anchor validator or production branch action.                                                                                                                                                                                              |
| M91.7–.10 components and parsers    | Broadly present; active work continues | The AI directory held 29 non-test TSX files at the checkpoint, with foundation/conversation/trace tests and a boundary test. The pure engine contains sources, test report, terminal, steps, todos, stack-frame and file-tree helpers. This is reusable implementation material.                                                                                                                                        |
| M91.12–.14 production adoption      | Not found                              | A source import scan found no production imports from `components/ai` outside that directory. [toolRenderers.tsx](../../../../src/agent/toolRenderers.tsx), lines 177–187, explicitly maps `subagent` and `todo` to ordinary `StepRow` pending their own rows. No `ChatTurn.tsx` extraction was present.                                                                                                                |
| M91.15–.17 closure and attachments  | Outstanding in inspected tree          | No new `assistant-transcript`/`context-use` lab journeys or M91 end-to-end adoption were found. The composer has no new file-chip/import-on-send flow. AGENTS still ends at CV-63. These should be rechecked after the active component work lands.                                                                                                                                                                     |

## Findings that affect the next roadmap

### 1. The producer and consumer currently disagree about child events

This is a concrete incomplete-integration defect, not just missing polish. Rust
can emit parent-tagged `Text`, `ToolStart`, `ToolDone` and `Error` events.
[applyEvent](../../../../src/agent/transcript.ts), lines 113–194, does not inspect
`parent`: a child tool becomes a top-level tool; a child's complete text changes
the main message's `finalText`; a child's error populates the main reply's error.
`Thinking`, `ToolResult` and `Subagent*` fall through the default branch and are
discarded. The frontend also ignores `last_uuid` when ending a turn.

Thus a backend test proving that a child does not end the main turn does not prove
that the visible answer stays correct. The existing main-chain answer rule may
later replace some child text, but that is not parent isolation. This review did
not reproduce the mismatch through a live app. Complete M91.4 before describing
child traces, reasoning, plans or source cards as functioning product features.
Acceptance must compare the visible live and restored turn, including a failed
child followed by a successful parent answer, detach/re-attach, and a journal gap.

### 2. The proposed researcher boundary is not the current execution contract

The plan makes a deliberate first product choice: a single read-only researcher
working under its parent's identity, only when a person can answer. Current code
has the gate requirement and process environment caps, but not the preset's tool
list, agent-type enumeration/denials, delegation ceiling or settings-file override.
The policy's attended `delegate` decision remains `cli`; no user-facing off
switch was found. Existing `MAIN_ONLY` handling means calls that reach that hook
are refused, rather than routed through the future researcher exception.

This does not establish a demonstrated authority bypass. It establishes that the
plan's promised worker model has not been assembled. Keep these concepts separate
in the expansion docs: a **worker of one run**, a **handoff to an Agent record**,
and a **workflow action** have different identity, approval and lifecycle needs.
M91 Q2 explicitly defers independent-bearer Agent-record subagents. Removing the
current restrictions to expose more names would not implement that architecture.

### 3. Whole-tree metering is still a prerequisite for larger delegation

The plan's own probe record says `result.modelUsage` includes children and
ordinary `result.usage` does not. The inspected meter/parser still reads the
latter through `usage_object`, around [usage.rs line
277](../../../../src-tauri/src/agent/usage.rs). Parent exclusion from model facts is
correct but solves a different problem. With the measured wire shape, the current
usage count cannot establish the full delegated cost. Implement and validate
M91.2c, including empty/malformed model usage and “child share not recorded,”
before budgets or UI imply a measured total for the complete tree. Do not derive
cost by summing repeated assistant-prefix usage.

### 4. Rich chat components have not yet changed the chat journey

The component layer is a useful foundation, particularly its prop-only boundary,
explicit status words, reduced-motion behavior and reuse of existing primitives.
Its existence currently answers “can we render this pattern?” Production must
also answer: where does its data come from, how does it survive a reload, what
happens when its source cannot be read, and what action can the person take next?

The current renderer's intentional `StepRow` fallback makes that distinction
visible in source. Prioritize one integrated turn—attachment/context, worker
progress, approval, answer, cited source and recorded effects—over increasing the
number of isolated patterns. Keep waiting approvals and changes visible after
completion; avoid collapsing the most consequential result into decorative trace
chrome. A source list assembled from observed URLs/tools is useful navigation;
it does not itself prove which assertion a source supports or disclose the
knowledge assembly's recorded selection and counterevidence.

### 5. Branching and retry must retain their different meanings

M91 Q8 correctly defines branching as new conversation lineage while files stay
as they are. It is not a vault rollback or an external-action checkpoint. The
existing [AiPanel retry](../../../../src/agent/AiPanel.tsx), around line 1142,
re-sends a prior question. Neither operation should become a workflow “resume
from failure” promise without an effect record and action-specific retry rules.

For future connectors, a timed-out tool may already have changed its remote
system. A branch can explore a new answer without erasing that effect. Show the
recorded effect, the uncertainty and the intended next action before another
consequential call. Preserve M91's plain “Files stay as they are” wording and keep
per-file restore in the existing guarded write flow.

### 6. Existing history and readiness problems remain visible

[AgentRunHistory](../../../../src/status/AgentRunHistory.tsx), lines 37–75, still
fetches the latest 200 global runs and only then filters the actor. A busy system
can hide an older agent's runs behind unrelated activity. Its failed detail read
still closes the selection. [RunDetailPanel](../../../../src/status/RunDetailPanel.tsx),
lines 72–98, still uses the active vault and maps a rejected knowledge read to
not-recorded. [AiPanel](../../../../src/agent/AiPanel.tsx), line 1013, still maps a
failed CLI check to `installed: false`.

These are source-confirmed carryovers from CP02/CP13, not new allegations arising
from the component port. More workers, workflows and external actions amplify
their user impact. Repair them as part of the integration baseline, rather than
allowing a redesigned transcript to conceal unreliable history and setup states.

## Reclassifying the previous strengthening plan

The [previous plan](../2026-10-22-reference-strengthening-plan.md) remains useful,
but its description of child handling must change. It is no longer accurate to
say that Cerebro simply drops all sidechain events or cannot capture child
Write/Edit paths. The new Rust implementation directly addresses those premises.

| Previous package                 | Classification after this audit                           | Remaining work                                                                                                                               |
| -------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| CP01 failed-save recovery        | Not addressed by M91                                      | Preserve its existing priority; this audit did not re-test the editor.                                                                       |
| CP02 run history                 | Still open; key defects re-observed                       | Server-side scope/pagination, originating-vault links, child detail mounting and truthful read states.                                       |
| CP03 native/live acceptance      | Still open, with additional M91 cases                     | Real delegation, approval interaction, fork identity, context and attachment acceptance.                                                     |
| CP04 scale                       | Not addressed                                             | Existing performance and large-view acceptance remain independent.                                                                           |
| CP05 exact passage navigation    | Not closed by citation primitives                         | Source identity/location, stale-location fallback and actual search/answer consumers.                                                        |
| CP06 outcome evaluations         | New lower-level fixtures help; task evaluation still open | Judge evidence, plan quality, effects, limits and recovery on repeatable tasks. A parsed test report is not an agent outcome evaluation.     |
| CP07 configuration/evidence      | Partially prepared, no user journey                       | Structured events/source helpers are inputs; historical execution manifests and assembly inspection remain separate work.                    |
| CP08 trigger preview/rehearsal   | Not addressed                                             | Branching a production conversation supplies neither deterministic trigger preview nor isolated rehearsal.                                   |
| CP09 delegated traces/recovery   | Backend portion materially advanced                       | Remove stale “all sidechains dropped” assumption; finish reducer/UI/persistence and recorded live proof. Effect-aware recovery remains open. |
| CP10 knowledge discovery         | Not addressed by these changes                            | Backlink context, evidence locations and bounded mention discovery.                                                                          |
| CP11 source editing/recovery     | Not addressed                                             | Storage-format decisions should explicitly revisit its byte-preservation and single-writer requirements.                                     |
| CP12 workflow/connector journeys | Attachment foundation planned; broader work open          | Safe health checks, discoverability, action selection, useful completed tasks and receipt-aware recovery.                                    |
| CP13 readiness/help              | Readiness defect persists                                 | Retryable unavailable state, CLI-owned setup recovery and versioned task guides.                                                             |

No complete CP package is closed merely by the inspected M91 additions.

## Completion sequence and acceptance journeys

1. **Close the runtime contract.** Finish policy/preset/ceiling/settings handling,
   preserve no-gate denials, and prove unknown-agent and version-drift behavior.
   Complete whole-tree accounting before expanding concurrency or capabilities.
2. **Close the transcript contract.** Route parented events recursively, retain
   ordered narration, represent unavailable child steps, preserve anchors and
   bounded summaries, and implement storage-quota recovery. Compare live, replay,
   detach and gap recovery through the same visible view model.
3. **Adopt the components in actual surfaces.** Start with the assistant's one
   persistent instance, then run detail, agent pages, comment turns and review
   cards. Integrate context pull and file import with their failure states.
   Complete M91.6's server-validated fork before enabling the branch button.
4. **Prove useful workflows.** A person can ask two researchers to inspect sources,
   understand each contribution, review a proposed write, follow a citation,
   reopen the answer and distinguish child failure from parent success. An
   attached file either enters one undoable human import or stays visibly unsent.
5. **Close evidence before widening promises.** Run the proposed lab/browser
   matrix, then native and installed-CLI acceptance. Only then expand to independent
   Agent-record workers, connector mutations or durable workflow recovery.

A minimum acceptance set includes cancellation during child work; one child
failing; unreadable child transcript; unknown agent definition; denied tool;
missing hook; unavailable context read; exhausted local storage; attachment import
failure; branching while another thread waits for approval; and returning from a
source link without losing draft or reading position. Record what happened, not
only that the component mounted.

## Evidence limits and audit fingerprint

M91 §1 explicitly labels its CLI observations as probes, not sanitized recordings;
M91.R and the owner smoke test remain listed. Existing test source gives valuable
coverage intent: `a_subagents_write_is_committed_with_its_run`,
`a_subagents_result_cannot_supply_the_parent_page`,
`a_subagent_replays_from_its_own_transcript_as_it_streamed`, and
`a_run_of_subagents_fits_its_journal`. None was executed for this docs-only audit.
The new synthetic fixtures must not be described as proof against every CLI pin
or as proof of the still-unwired UI.

SHA-256 prefixes captured at the checkpoint let later reviewers recognize stale
claims without pretending the moving tree was an immutable release:

| File                                  | SHA-256 prefix     |
| ------------------------------------- | ------------------ |
| M91 plan                              | `656175f604d3a2fc` |
| `src/agent/transcript.ts`             | `f1b8bef86568e7ef` |
| `src/agent/types.ts`                  | `7e64095cec79438c` |
| `src/agent/AiPanel.tsx`               | `2193d049e3a4e6f9` |
| `src/agent/toolRenderers.tsx`         | `33f05c144b7126b4` |
| `src-tauri/src/agent/fold.rs`         | `34d297f4190ff9b8` |
| `src-tauri/src/agent/transcript.rs`   | `cc0be6efac5e70bb` |
| `src-tauri/src/agent/mod.rs`          | `0e2f247fd1219060` |
| `src-tauri/src/agent/meter.rs`        | `023d5daf57a5283a` |
| `shared/policy/subagents.v1.json`     | `071375b0c8c84432` |
| `shared/policy/tool-approval.v1.json` | `ea47d962c0d9fbb9` |
