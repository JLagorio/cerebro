# M95.1 — Current M91/M92 handoff

Status: evidence reconciliation, not milestone or release acceptance. Checked on 2026-10-23 against shared branch `m53-macro-port`, base `6c92709187ee0f1c54a049be23b7717eeb3dfcae` plus concurrent uncommitted M92–M99 changes. Existing records remain historical; this document does not revise their observations.

Sources: [M91 implementation record](../../plans/2026-10-23-m91-implementation-record.md), [M91 plan](../../plans/2026-10-22-m91-ai-elements-and-subagents.md), [M92 implementation record](../../plans/2026-10-23-m92-implementation-record.md), [current chat validation](README.md), and [M93–M99 implementation record](../../plans/2026-10-23-m93-m99-implementation-record.md). M92's current record explicitly says its final gate is pending final review; M95 does not close that gate on its behalf.

## Classification

**Implemented/source-only** means the existing implementation is present, with no new release claim from this handoff. **Recorded-pass** identifies a dated, scoped observation, not a claim that the whole application currently passes. **Defect** means a demonstrated mismatch still needs repair. **Blocked** identifies the missing prerequisite. Historical M91 native and browser results are recorded-pass for that original source; they are not reruns of this shared checkout.

## Every M91 part

| Part | Existing owner / handoff | Current classification and remaining evidence |
| --- | --- | --- |
| M91.1 | Tool manifest, built-in allowlist and init tripwire | Implemented/source-only. Preserve named SendMessage/ListAgents denial. Current signed-in scope-escape/init matrix remains blocked on isolated login. |
| M91.2a | Shared subagent policy and delegate ceiling | Implemented/source-only. Shared artifact remains the authority; no new job isolation is inferred. M95.6 admission must prove independent scope. |
| M91.2b | `agent/cli_agents.rs`, settings/argv, type gate and foreground controls | Implemented/source-only, with historical CLI probes recorded-pass. Missing/managed agent definitions and withdrawn subagent explanations retain M91 ownership. |
| M91.2c | `agent/meter.rs` whole-tree usage | Implemented/source-only. Existing tests explicitly refuse booking potentially cumulative resumed modelUsage and report unknown delegated share. Current live metering recordings remain open; no absent share is zero. |
| M91.2d | Assistant Subagents setting and wire option | Implemented/source-only. Foreground researcher setting is distinct from future independently scoped child jobs. |
| M91.3a | Rust event fold, structured results, denials and turn anchors | Implemented/source-only. Existing normalized vocabulary remains sole reducer input. Live unknown shapes and sanitized fixtures remain open. |
| M91.3b | Parent-tagged sub-folds and child transcript readback | Bounded TS availability/attribution slice independently accepted: rejected child evidence remains outside the parent answer and creates a visible unavailable fact. The native unreadable-child fallback retains the main session; current signed-in missing-trace capability acceptance remains open. |
| M91.4 | `transcript.ts`, cache and hook reattachment | Recorded-pass for multi-block reattach, quota repair (113 cases), and child projection/partial healing (241 affected cases plus 14 rail checks). Independent healing review repaired identity/parent grafting. Current native/live whole-tree delivery and accounting matrix remains open. |
| M91.5 | Memory-only ContextBook and context pull | Implemented/source-only, with historical context probes. Preserve unavailable versus not recorded and avoid persisting memory-file paths or raw prompt material. |
| M91.6 | Checked fork session anchor and Branch | Implemented/source-only, historical fork probe recorded-pass. Current fork identity, copied session-file details and pending-source decision behavior need signed-in recording. |
| M91.7 | Presentation-only AI element foundation | Implemented/source-only. CV-64 still forbids authority/IPC ownership in components. The historical boundary repair is recorded; no new element replacement is needed. |
| M91.8 | Chat/message scroller primitives | Implemented/source-only; current quota browser checks additionally pass docked/minimized/canvas draft-node preservation. They do not prove native IME or VoiceOver. |
| M91.9a–b | Trace, code, source, confirmation and related element sets | Implemented/source-only with historical visual evidence. Adapters retain domain authority and supported action handlers. |
| M91.10 | Pure AI parsers under `src/engine/ai/` | Implemented/source-only. Retrieval/source labels and availability still need M97 evidence work; URLs encountered are not evidence that a source was read. |
| M91.12a | Composer, queue, model and context controls | Implemented/source-only. Current quota browser passes retain an unsent draft through a live turn and presentation changes. Full attachment/queue/native keyboard matrix remains open. |
| M91.12b | Permission, question and write-approval cards | Implemented/source-only. M95.5 consumes broker decisions; UI cannot manufacture authority or replay unknown effects. Live allow/deny/edit/stale/repeated cases remain blocked on isolated login. |
| M91.12c | Persistent panel, Chat and plan placement | Implemented/source-only; narrow current draft/notice browser evidence recorded-pass. M92 owns rail/drawer and Plan placement acceptance. |
| M91.13 | `ChatTurn.tsx` and tool/child presentation | Implemented/source-only. Completed-message actions and explicit missing-child visibility require their named M95 phases; component existence is not a wired action. |
| M91.14a–d | Run, comment, Ask AI, AI block, review, Inbox and knowledge surfaces | Implemented/source-only, with historical visual/test results. Remaining M95 artifacts and M97 evidence/source-return journeys keep separate acceptance. |
| M91.15 | Existing state-lab presets and M91 E2E files | Present/source-only for current handoff, historical runs recorded-pass. These files already exist and must not be recreated as absent work. Current comprehensive rerun remains open. |
| M91.16 | AGENTS, security, notices and policy documentation | Present/source-only. Preserve CV-27/29/34/64 and M92's newer CV-65. New claims must name their real boundary. |
| M91.17 | Copy-in attachments and import-on-send | Implemented/source-only. M93's dependent Send barrier is reviewed; actual CLI attachment acceptance and exact partial-copy handling remain separate. |
| M91.18 | Historical final-review repairs recorded by M91 | Historical recorded-pass; current quota/reattach followups are scoped above. No rewrite of the original record's known gaps. |
| M91.R | Recording kit and sanitized live fixtures | Blocked for the new signed-in matrix: CLI 2.1.250 is installed, isolated profile is unsigned. A private fixture and explicit login request are ready. Existing synthetic/derived fixtures retain their provenance. |

The source plan has no M91.11 implementation part; this handoff does not invent one.

## M92 dependency ownership

| Parts | Existing implementation consumed | M95 disposition |
| --- | --- | --- |
| M92.0 | Prompt after `--`, answer-resume argv and lifecycle classification | Preserve; historical P10/P17 probes recorded by M92. Current signed-in recording remains open. |
| M92.1, M92.4–6, M92.17 and closing steps | Persistent rail/drawer, Waiting/Subagents/Changes/Sources/Plan, primary jump and float-before-secondary open | Source present. M92 owns rail keyboard/layout acceptance. M97 conversation return must reuse its origin and scroller rather than remounting the assistant. |
| M92.2–3 | Run duration, thread-status and net-change folds | Source present. Unknown counts remain unknown; current source absence is not alleged. |
| M92.7 | Working/Needs you switcher status | Source present. Restart cannot infer running state from stale browser flags. |
| M92.8–10 | Reach, connector/environment cards and optional sync counts | Source present. Focused current railConnectors replay passes 13 cases. A mixed aggregate's older connector wording failure is not evidence to revert current M92 wording. Environment's focused checks pass; source-snapshot limitation remains. |
| M92.11–12 | Handed-off runs and read-only conversation changes healing | Source present. Failure/partial states and bounded readback remain separate from new archive/effect persistence. |
| M92.13–14 | Seated stdin transport, memory-only context breakdown and Context card | Source present; retain CV-65 exit-path closure. M95 recording must sanitize newly recorded context names/paths rather than blindly copying raw stdin. |
| M92.15–16 | Lab/E2E coverage and ownership documentation | Present. Final M92 review/gate is still pending in its owning record; no M95 sign-off substitutes for it. |

## Open work that remains real

1. Extend the accepted deterministic child-attribution/partial-healing evidence with current sanitized native delivery and missing-trace recordings. Keep modelUsage and absent-child accounting tied to their actual Rust producer. The visible availability marker and guarded partial restoration now have scoped review/test/browser evidence; they do not close the native whole-tree matrix.
2. Run the current signed-in matrix after the isolated profile is authenticated: researcher on/off; scope/type refusals; parent Stop; missing hooks; every decision outcome; fork; whole-tree/missing usage; context; attachment; restart waiting; vault switch. Sanitize and scan before adding fixtures.
3. Complete M92's own final review and current rail/turn-state tests without overwriting concurrent source. Native CLI and packaged keyboard/IME/VoiceOver cases remain distinct from browser mocks.
4. Resolve owner archive retention before new durable conversation content is enabled. Keep archive/jobs, context receipts/artifacts, broker recovery and scoped child execution as separately reviewable M95 phases. Current cache recovery does not satisfy those phases.

The shared frontend aggregate (17,383 pass / nine fail / 15 skipped) was collected during source changes. Focused repaired suites provide scoped evidence; there is no stable whole-tree green claim. No M91, M92 or M95 release acceptance is implied.
