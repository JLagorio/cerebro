# Architecture recheck: retain the direction, refresh the handoff

Independent review for the requested four-pass check, 2026-10-22. This pass
examines the expansion plan's correctness, current M91 integration, execution
authority, recovery and sequencing. It does not judge appearance from source or
claim that the example applications, Cerebro's native build, CLI or providers
were exercised. No application code or tests were changed or executed.

The central recommendation survives: keep React's editor, move durable domain
and execution ownership toward Rust, and decide metadata authority independently.
The new UI work should begin alongside that effort. A visual refresh does not
need to wait for a credential broker or metadata migration; trustworthy agent
status and approval surfaces do need their producers and recovery contracts.

The most consequential correction is temporal. The old M91 audit describes an
earlier checkpoint. Compared with that audit, policy and runtime files have
advanced while the frontend transcript files retain their old hashes. Treat this as active
implementation, with a dated handoff, rather than duplicating completed work or
calling an intermediate tree a released regression.

## 1. M91 findings: what remains true and what has moved

At 16:18 PDT / 23:18 UTC, these seams were inspected directly:

| Earlier claim                                       | Current conclusion                   | Evidence and consequence                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frontend can flatten child events                   | **Still source-confirmed**           | [transcript.ts](../../../../src/agent/transcript.ts), lines 115–184, handles text, tools and errors without inspecting `parent`. New structured kinds reach the unchanged default branch. Finish the projection before presenting a reliable child journey.                                                           |
| Child and todo production renderers are generic     | **Still true**                       | [toolRenderers.tsx](../../../../src/agent/toolRenderers.tsx), lines 177–187, explicitly uses `StepRow` for both. A production import scan found no adoption of `components/ai` outside that directory.                                                                                                                |
| No delegation ceiling/preset exists                 | **Now stale**                        | [tool-approval.v1.json](../../../../shared/policy/tool-approval.v1.json), lines 180–195, now gives `delegate` an on/off axis; [subagents.v1.json](../../../../shared/policy/subagents.v1.json), lines 4–32, now declares the researcher, environment and settings. These declarations alone do not prove enforcement. |
| No request field or allowed-type plan exists        | **Partly stale**                     | [agent/mod.rs](../../../../src-tauri/src/agent/mod.rs), lines 505–512, now carries `delegate`; [tool_approval.rs](../../../../src-tauri/src/policy/tool_approval.rs), lines 1199–1204, carries allowed and denied agent types. Settings/IPC adoption was not found in the inspected frontend.                         |
| Whole-tree accounting is incomplete                 | **Still open at the inspected seam** | [meter.rs](../../../../src-tauri/src/agent/meter.rs), line 220, calls `usage::parse`; [usage.rs](../../../../src-tauri/src/agent/usage.rs), lines 277–280, reads ordinary `usage`. No `modelUsage` handling was found in those files. This is not a new measurement of actual CLI billing.                            |
| Context-use and branch production paths are missing | **Still not found**                  | Searches found no `agent_context_usage`/`ContextBook`; [CliSession](../../../../src-tauri/src/agent/transcript.rs), line 259, still has the existing new/resume model. A Checkpoint component does not establish fork execution.                                                                                      |
| Component count was 29                              | **Inventory has grown**              | The directory now contains 30 non-test TSX files, including Sources, Plan, Queue and Checkpoint. The count is evidence of implementation material, not completed user journeys.                                                                                                                                       |

The child-event finding is not an invented live reproduction. The producer's
parent tag can reach the ordinary reducer: [useAgentChat.ts](../../../../src/agent/useAgentChat.ts),
line 601, calls `applyEvent` on the received event. Child text can therefore update
the same `finalText` field used for the parent's final answer; child errors can
populate its error. A later parent message may replace some text, which does not
establish isolation. Acceptance must cover a failed child followed by a successful
parent, then restore, detach/re-attach and a journal gap.

### A transient artifact/loader mismatch needs closure at handoff

The new subagent JSON includes `seated_env`, `presets` and `settings`. At the
checkpoint, [policy/subagents.rs](../../../../src-tauri/src/policy/subagents.rs),
lines 35–45, still used `deny_unknown_fields` and only declared `format`,
`cli_version` and `env`; line 127 expected the compiled artifact to parse. Those
particular source versions do not form a loadable pair. The accompanying test
expectations at lines 184–199 still described the earlier four-variable policy.

This is an **in-flight consistency observation**, not a claim about a shipped
build. Do not run the agent to investigate it or patch around another developer's
work. Recheck the artifact, Rust/TS loaders, digest, policy goldens and consumers
together when Claude hands off. An apparently complete JSON policy is not a
completion signal while its loader is still changing.

The coordinating review separately reproduced a related startup failure twice
in an isolated browser mock on port 5317: the body was blank and the page error
was `shared/policy/tool-approval.v1.json: unknown field \`agent_types\``. This
matches the strict field check in [toolApproval.ts](../../../../src/lib/policy/toolApproval.ts),
lines 203–212. That is live browser evidence from the coordinating pass, not a
native or CLI result from this source review. It establishes that the observed
intermediate tree blocked visual inspection; it does not establish the quality
of the rendered interface or that the completed M91 handoff will still fail.

Preserve the historical M91 audit and add a dated current-status pointer. Replace
the main plan's missing-preset wording with: “Delegation policy and request fields
are landing; verify their loaders, runtime admission, Settings and real CLI
behavior as one completed slice.” Retain the separate frontend-integration gap.

## 2. Existing correctness work belongs inside the polished experience

Three older problems were re-observed. They should not become cosmetic variants
of the same misleading behavior.

**Saving must acknowledge durable success.** [MarkdownEditor.tsx](../../../../src/editor/MarkdownEditor.tsx),
lines 672–677, assigns `lastSaved` before the owner callback settles and combines
emissions with `allSettled`. [NoteBodyEditor.tsx](../../../../src/editor/NoteBodyEditor.tsx),
lines 303–331, announces failure and resolves the rejected write path. Thus the
existing “save failed” display is not evidence of a retained, retryable draft.
The implementation spec must retain the failed content under a durable owner,
define retry and navigation/quit behavior, and only clear dirty state after the
correct write is acknowledged. A more attractive Saved indicator cannot fix the
ownership problem.

**Run history must tell the truth about its scope.** [AgentRunHistory.tsx](../../../../src/status/AgentRunHistory.tsx),
line 40, requests 200 global runs before filtering at line 69. An actor can have
history yet receive “No runs recorded.” The detail read failure also closes the
selection at line 34. [RunDetailPanel.tsx](../../../../src/status/RunDetailPanel.tsx),
lines 72–97, reads knowledge changes using the active vault and converts rejection
to not-recorded. A polished activity view must keep actor/vault scope, unavailable,
not-recorded, empty, loading and selected detail as distinct states.

**Readiness failure is not missing installation.** [AiPanel.tsx](../../../../src/agent/AiPanel.tsx),
lines 1010–1013, still maps a rejected CLI check to `installed: false`. The refresh
should offer retry and a useful diagnostic state before telling a person to
install software they may already have.

These are still-open source findings, not newly executed regression tests. Scope
their repairs separately from typography and geometry so the UI refresh can be
reviewed honestly, while requiring their relevant journeys before declaring the
new assistant reliable.

## 3. The execution design is sound only if its routes stay explicit

The existing plan correctly separates the inbound MCP server, CLI-mediated
outbound connections, future Rust outbound dispatch and deterministic workflows.
It also correctly says that a recorded remote schema is not a pinned remote
implementation and that local dispatch claims do not establish exactly-once
remote effects. Preserve those qualifications in shorter implementation specs.

There is no existing universal guarded-write boundary. [cli_writes.rs](../../../../src-tauri/src/agent/cli_writes.rs),
lines 3–23, explicitly observes successful CLI writes that bypass Cerebro's
writers; child writes join the parent's change claim. This supplies attribution,
not authorization. A Rust metadata service cannot become the exclusive authority
while an unrestricted same-user process can edit its canonical stores.

For the first brokered action, make ownership testable: the CLI gets the scoped
broker tool, while the provider credential and raw server remain with the Rust
adapter. Keep legacy direct forwarding visibly distinct. This is already a
recommendation in the connector dossier; promote it into the beta's acceptance
criteria so the narrow beta cannot accidentally demonstrate the compatibility
path while claiming the stronger action contract.

Current approvals are not all durable. [interaction.rs](../../../../src-tauri/src/agent/interaction.rs),
lines 35–55, binds one-use write approvals to the operation; lines 67–75 state
that the live permission book is memory-only. [runtime/mod.rs](../../../../src-tauri/src/runtime/mod.rs),
lines 15–27, documents an app-global, vault-scoped, non-reconstructible operational
database. Durable pending writes and scheduler records do not turn every live
permission card into a restartable wait. The new UI must read one authoritative
approval/invocation record across chat, run details and the waiting queue.

Normalize the proposed uncertain-result vocabulary before implementation. The
main plan uses `outcome_unknown`, while the connector dossier's state machine uses
`unknown_effect`. Choose one canonical state, suggested `outcome_unknown`, with
plain UI wording such as “Outcome unknown.” It must retain account, exact target,
approved input fingerprint, attempts and reconciliation evidence. A transport
timeout is not proof of failure, and a retry button must not automatically submit
another external mutation.

The official protocol claim was independently checked. The
[2026-07-28 changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
does describe removal of initialization/transport sessions and a new request ID
after a broken stream. That confirms the need for adapters and stable business
invocation identity; it does not make the current CLI compatible with that
revision. Pin actual tested client/server versions at implementation time. No
wire or service behavior was exercised here.

## 4. Rust and storage: separate a product decision from a visual refresh

The storage proposal already avoids the largest category errors: app-owned
metadata is not a disposable search index; Markdown plus SQL changes files-alone
portability; and SQLite transactions do not atomically commit external files.
Preserve its separate authority table, new-workspace migration option, immutable
old evidence, original-byte retention and post-cutover rollback obligations.

YAML removal is broader than frontmatter styling. [vault/parse.rs](../../../../src-tauri/src/vault/parse.rs),
lines 80–93, reads declared type before guarded writes; [sheet/fence.rs](../../../../src-tauri/src/sheet/fence.rs),
line 162, also parses YAML inside sheet fences. A polished metadata form can hide
serialization without changing either authority. Conversely, choosing SQL does
not automatically replace sheet-source formats, make the body editor cheaper,
or preserve third-party file tooling.

Keep ordinary page titles projected from the same body editor. Do not introduce a
second database-owned title writer as a shortcut to a cleaner page header. Keep
React view state local where immediate interaction requires it; Rust should own
the durable decisions, queries and effects, with a typed boundary. No evidence in
this review justifies an all-Rust UI rewrite on the refresh's critical path.

## 5. Exact roadmap amendments and acceptance

| Main-plan location    | Required amendment                                                                                                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M91 status and AX00   | Link this dated handoff; replace “preset absent” with partially landed policy/runtime work. Re-estimate remaining work after a coherent handoff rather than treating 2–4 weeks as a measured remainder. |
| New UI refresh track  | Start design foundations, page/database/chat hierarchy and interaction prototypes in parallel. Depend on M91 for truthful agent projections, not for every spacing or layout improvement.               |
| Narrow beta           | Add proof that the managed provider is not also exposed through raw CLI forwarding. Keep one account, one read, one reviewed mutation and one lost-response recovery.                                   |
| Action state contract | Standardize the uncertain-result state across docs; distinguish before-dispatch cancellation, requested cancellation and established terminal outcome.                                                  |
| Approval surfaces     | Require one record across all presentations; no separate frontend “approved” state that can diverge from dispatch authority.                                                                            |
| Release criteria      | Include failed-save retention, scoped history and retryable readiness in the relevant polished journeys. Visual acceptance alone cannot close those packages.                                           |

Four demonstrations would make the next specifications concrete: recover a failed
save without retyping; restore an answer containing one failed child without
changing the parent's answer; approve one external create through two open
surfaces with one local claim; and reopen a lost-response action without silently
repeating it. The UI design pass should specify what each state looks like, its
next useful action, keyboard focus and how it survives presentation changes.

The large effort ranges remain planning hypotheses. They are not estimates derived
from measured velocity or a fully decomposed implementation. Keep the storage
prototype, visual refresh and connected-action beta independently reviewable so
one uncertain architectural choice does not stall all user-visible improvement.

## Checkpoint fingerprints and limits

Captured 2026-10-22 16:18 PDT / 23:18 UTC; SHA-256 prefixes identify exactly which
source versions support the observations. Files may advance after capture.

| File                                          | SHA-256 prefix     |
| --------------------------------------------- | ------------------ |
| `2026-10-22-ai-expansion-plan.md`             | `ccee8431050e3442` |
| `2026-10-22-m91-ai-elements-and-subagents.md` | `656175f604d3a2fc` |
| `src/agent/transcript.ts`                     | `f1b8bef86568e7ef` |
| `src/agent/types.ts`                          | `7e64095cec79438c` |
| `src/agent/AiPanel.tsx`                       | `2193d049e3a4e6f9` |
| `src/agent/toolRenderers.tsx`                 | `33f05c144b7126b4` |
| `src/agent/conversations.ts`                  | `1a905972e7548fcd` |
| `src-tauri/src/agent/mod.rs`                  | `449093a5e082d897` |
| `src-tauri/src/agent/meter.rs`                | `515a36d10761ce68` |
| `src-tauri/src/agent/interaction.rs`          | `a4bcc3bad4af8e93` |
| `shared/policy/subagents.v1.json`             | `a2c731302ce8f45a` |
| `src/editor/MarkdownEditor.tsx`               | `bc94b4874f86bd8c` |
| `src/editor/NoteBodyEditor.tsx`               | `b675d2cf5b5394ea` |
| `src/status/AgentRunHistory.tsx`              | `ebc9c8510ab43aa1` |

An additional 16:20 PDT / 23:20 UTC read recorded the mismatched
`src-tauri/src/policy/subagents.rs` as `b1fc022b9f1f2070`, its TS loader as
`fed039b383608b83`, and `shared/policy/tool-approval.v1.json` as
`ea299aa69fa0451a`.

This pass cannot certify builds, packaged accessibility, real delegation,
provider idempotency or visual quality. It establishes source-backed current
gaps, stale premises and the boundaries the refreshed product must preserve.
