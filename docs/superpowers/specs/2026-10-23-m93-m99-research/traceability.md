# M93–M99 — Research traceability

**Draft for owner review · 2026-10-23.** This register accounts for the research;
it does not approve implementation or claim future acceptance has passed. The
[program design](../2026-10-23-m93-m99-program-design.md) and
[program plan](../../plans/2026-10-23-m93-m99-master-roadmap.md) govern sequencing.
The [decision register](decisions.md) distinguishes proposed choices from current
contracts, and the [evidence record](evidence.md) records verification limits.

The ranked-finding denominator is **78**: 46 in the
[five-reference disposition table](../../plans/2026-10-22-reference-review/README.md), plus
10 AppFlowy, 12 n8n and 10 Plane findings in the
[AI expansion packet](../../plans/2026-10-22-ai-expansion-review/README.md). Each has its
own row below. Historical Macro/Tolaria/Thought Desk numbers are preserved;
`MR-01`, `AP-01` and `AF-01` retain their dossier spelling. These are the same
findings sometimes written MR01/AP01/AF01. No new findings are invented by
renumbering them.

There are also **34 prior work packages** (CP01–CP13, AX00–AX12, UI00–UI07),
**31 UI reviewer findings** (VS01–VS13, PJ01–PJ12, AC01–AC06), and **60 subsystem
implementation tasks**. These are different counting units, not 203 independent
features or an estimate of implementation duration. Program coordination tasks
PROG-T01–PROG-T06 sit above the 60 and are not counted twice.

## Reading the mapping

Every owner cell names one authoritative subsystem. A consumer uses that owner's
contract or acceptance record; it does not implement a competing service. A task
destination means proposed work, including a decision/report or disabled proof
where stated. **Conditional** means that task contains a gate, not that the
feature has been adopted. **Deferred** means no production implementation is in
this program; the re-entry column states what would justify a new proposal.
**Retain** credits an existing capability and carries only validation forward.

| Owner | Spec                                                                                       | Implementation plan and task inventory                                                                                                       |
| ----- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| REL   | [Reliability](../2026-10-23-m93-reliable-workspace-design.md)                              | [Plan](../../plans/2026-10-23-m93-reliable-workspace.md): M93.1, M93.2, M93.3, M93.4, M93.5, M93.6, M93.7, M93.8, M93.9, M93.10, M93.11 — 11 |
| CHAT  | [Conversations and jobs](../2026-10-23-m95-chat-and-supervised-agents-design.md)           | [Plan](../../plans/2026-10-23-m95-chat-and-supervised-agents.md): M95.1, M95.2, M95.3, M95.4, M95.5, M95.6, M95.7 — 7                        |
| ACT   | [Connected actions](../2026-10-23-m96-connectors-mcp-and-actions-design.md)                | [Plan](../../plans/2026-10-23-m96-connectors-mcp-and-actions.md): M96.1, M96.2, M96.3, M96.4, M96.5, M96.6, M96.7, M96.8 — 8                 |
| FLOW  | [Workflows](../2026-10-23-m98-workflows-and-automation-design.md)                          | [Plan](../../plans/2026-10-23-m98-workflows-and-automation.md): M98.1, M98.2, M98.3, M98.4, M98.5, M98.6, M98.7, M98.8, M98.9 — 9            |
| KNOW  | [Knowledge and evaluations](../2026-10-23-m97-knowledge-evidence-and-evaluation-design.md) | [Plan](../../plans/2026-10-23-m97-knowledge-evidence-and-evaluation.md): M97.1, M97.2, M97.3, M97.4, M97.5, M97.6, M97.7, M97.8 — 8          |
| CORE  | [Rust and storage](../2026-10-23-m99-rust-services-and-storage-design.md)                  | [Plan](../../plans/2026-10-23-m99-rust-services-and-storage.md): M99.1, M99.2, M99.3, M99.4, M99.5, M99.6, M99.7, M99.8 — 8                  |
| UX    | [UI and journeys](../2026-10-23-m94-ui-polish-and-journeys-design.md)                      | [Plan](../../plans/2026-10-23-m94-ui-polish-and-journeys.md): M94.1, M94.2, M94.3, M94.4, M94.5, M94.6, M94.7, M94.8, M94.9 — 9              |

## The 78 ranked repository findings

### Macro — 8

Source: [Macro dossier](../../plans/2026-10-22-reference-review/macro.md) and the original
46-finding disposition table.

| Finding                                        | Disposition and owner                | Concrete destination                                    | Consumers / limits / re-entry                                                                                                                                             |
| ---------------------------------------------- | ------------------------------------ | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Macro 1 — scoped run history and failed detail | Proposed core; REL                   | M93.3, M93.4                                            | CHAT/KNOW consume originating-vault identity. Child-hop detail mounting already exists; preserve it rather than reimplement it.                                           |
| Macro 2 — exact supporting content             | Proposed core; KNOW                  | M97.1, M97.2, M97.4                                     | M95.4 consumes the shared locator and evidence roles; encountered material is not automatically supporting evidence.                                                      |
| Macro 3 — delegated CLI trace                  | Reconcile existing M91; CHAT         | M95.1; independently scoped expansion only M95.6, M95.7 | Nested parts, child summaries and adapters already exist. Record live/replay attribution before stronger claims; never infer direct CLI write receipts.                   |
| Macro 4 — retrieval and duplicate evaluations  | Proposed core; KNOW                  | M97.6, M97.7                                            | Keep current retrieval/duplicate mechanisms; measure at the actual production cutoff before selecting M97.8 experiments.                                                  |
| Macro 5 — scale/native acceptance              | Proposed core; REL                   | M93.6, M93.7, M93.11                                    | UX consumes separately classified performance/native evidence; historical browser timings are not native acceptance.                                                      |
| Macro 6 — conversation search                  | Conditional archive extension; CHAT  | M95.2, M95.3                                            | Owner must choose content retention first. Search only retained normalized content in the originating vault; no invented lifetime CLI history.                            |
| Macro 7 — original-attachment search           | Conditional measured extension; KNOW | M97.7, M97.8                                            | Select an observed miss; first prove contained extraction, source locators, deletion/revocation and resource caps. CHAT attachment copy-in is not this search capability. |
| Macro 8 — architecture enforcement             | Targeted adoption; CORE              | M99.1                                                   | ACT/FLOW/CHAT own their service-specific contracts; enforce new seams through generated DTO/shared cases rather than broad module migration.                              |

### Morrow — 10

Source: [Morrow dossier](../../plans/2026-10-22-reference-review/morrow.md).

| Finding                                  | Disposition and owner                      | Concrete destination               | Consumers / limits / re-entry                                                                                                                                                                 |
| ---------------------------------------- | ------------------------------------------ | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MR-01 — failed autosave recovery         | Proposed core; REL                         | M93.1, M93.2                       | UX/CHAT consume acknowledgement and leave outcomes; retained editor text survives presentation teardown in memory.                                                                            |
| MR-02 — search-hit landing               | Proposed core; KNOW                        | M97.1, M97.2                       | UX search adopts the locator; changed/ambiguous content never guesses a first match.                                                                                                          |
| MR-03 — overwritten outside preimages    | Conditional; REL                           | M93.9                              | First characterize Git/checkpoint coverage, then owner decides opt-in retention, quotas, exclusions and protected-save failure policy. Human last-write-wins remains current.                 |
| MR-04 — backlink context and mentions    | Proposed bounded core; KNOW                | M97.5                              | Uses M97.1 locators; no automatic relation or knowledge verification from text matching.                                                                                                      |
| MR-05 — source editing escape hatch      | Proposed bounded core; REL                 | M93.8                              | One body owner/writer and precise untouched-prefix contract; whole-file metadata editing is deferred.                                                                                         |
| MR-06 — native acceptance                | Proposed core; REL                         | M93.11                             | M94.9 consumes packaged keyboard/IME/VoiceOver and recovery results with actual build identity.                                                                                               |
| MR-07 — accent-tolerant search           | Conditional measured experiment; KNOW      | M97.7, M97.8                       | Require labeled misses, preserve exact priority and original-position mapping, reject regressions.                                                                                            |
| MR-08 — capture from another application | Conditional native extension; FLOW         | M98.7                              | M94.4 owns the session draft; choose system shortcut explicitly and prove registration conflict, focus return and app-readiness behavior.                                                     |
| MR-09 — offline archive import           | Deferred; FLOW                             | No archive importer in M98.7/M98.8 | Re-enter after observed archive demand and a bounded source-format proposal using the existing import planner, provenance, duplicate/edited-copy outcomes and undo; no new parallel importer. |
| MR-10 — local relationship neighborhood  | List portion adopted, graph deferred; KNOW | M97.5 for contextual lists only    | Re-enter graph work after an accessible list journey and evidence that a bounded neighborhood resolves a real navigation problem; define cap, scope, keyboard and stale-link behavior.        |

### Tolaria — 10

Source: [Tolaria dossier](../../plans/2026-10-22-reference-review/tolaria.md).

| Finding                            | Disposition and owner                 | Concrete destination                        | Consumers / limits / re-entry                                                                                                                            |
| ---------------------------------- | ------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1 — performance budget tooling    | Proposed core; REL                    | M93.6                                       | Record stage timings, workload, build/hardware, p50/p95 and timeouts before budgets become gates.                                                        |
| T2 — bounded list rendering        | Proposed measured core; REL           | M93.7                                       | M94.6 consumes selected paging/windowing; preserve End/find, variable heights, focus and assistive access.                                               |
| T3 — warm editor caches            | Conditional optimization; REL         | M93.6, M93.7                                | Only after profiles justify bounded closed-clean-document caches keyed by vault/path/hash/parser version; failures evict.                                |
| T4 — progressive editor loading    | Conditional optimization; REL         | M93.6, M93.7                                | Complete carrier/round-trip readiness precedes edit/autosave/undo; do not present partially loaded content as a writable document.                       |
| T5 — startup snapshots             | Deferred; REL                         | No startup-snapshot implementation in M93.7 | Re-enter only if startup profiles justify it and a provisional-display contract proves fresh validation before grants, triggers, verification or writes. |
| T6 — CLI readiness                 | Proposed immediate repair; REL        | M93.5                                       | CHAT/UX consume checking/available/missing/unavailable; Rust bounds, kills and reaps the real discovery subprocess.                                      |
| T7 — human/agent product guidance  | Proposed core; REL                    | M93.10                                      | UX chooses placement; ACT reviews bounded read-only help entry. One versioned human source, never wholesale prompt injection.                            |
| T8 — IME and bidirectional writing | Proposed native validation; REL       | M93.11                                      | Reproduce issues before editor workarounds; M94.9 consumes actual language/selection evidence.                                                           |
| T9 — name normalization            | Conditional measured experiment; KNOW | M97.7, M97.8                                | Preserve existing stronger corpus search and explicit field semantics; select normalization only from labeled misses.                                    |
| T10 — file/knowledge boundaries    | Retain and validate; REL              | M93.11                                      | KNOW preserves human-only Verify; attachment/open/import boundaries already exist and are not replaced.                                                  |

### Thought Desk — 9

Source: [Thought Desk dossier](../../plans/2026-10-22-reference-review/thought-desk.md).

| Finding                                        | Disposition and owner              | Concrete destination                        | Consumers / limits / re-entry                                                                                                                                       |
| ---------------------------------------------- | ---------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Thought Desk 1 — mixed-workspace benchmark     | Proposed core; REL                 | M93.6                                       | KNOW uses the mixed corpus for labeled retrieval; UI appearance is not a performance result.                                                                        |
| Thought Desk 2 — bounded table work            | Proposed measured core; REL        | M93.7                                       | M94.6 consumes the mechanism; do not copy progressive rendering that removes keyboard/logical-result access.                                                        |
| Thought Desk 3 — native accessibility/save     | Proposed core; REL                 | M93.1, M93.2, M93.11                        | UX integrates acknowledged state and native focus/assistive evidence.                                                                                               |
| Thought Desk 4 — local-search projections      | Conditional optimization; REL      | M93.6, M93.7                                | Require measured derivation pressure and immutable snapshot/schema/scope invalidation; KNOW owns ranking semantics.                                                 |
| Thought Desk 5 — saved intake configurations   | Individually gated extension; FLOW | M98.8                                       | Preserve RecordComposer and M94.4 draft ownership; choose carrier, renamed/deleted fields and form-only required/default semantics before coding.                   |
| Thought Desk 6 — calendar overlays             | Individually gated extension; FLOW | M98.8                                       | Read-only explicit database/date-field sources first; prove DST, cross-midnight, duplicate and inaccessible-source outcomes. Not implied by calendar preparation.   |
| Thought Desk 7 — heterogeneous retrieval tests | Proposed core; KNOW                | M97.7                                       | REL supplies mixed corpus/scale observations; evaluate real cutoff, counterevidence, source coverage and unavailable states.                                        |
| Thought Desk 8 — deterministic record rules    | Individually gated extension; FLOW | M98.8                                       | Decide source-write admission, atomic same-record batch/undo, no-op/cycle bounds and provenance/knowledge denial; remain gated if atomicity cannot be met.          |
| Thought Desk 9 — personal recall               | Deferred; KNOW                     | No recall/flashcard implementation in M97.8 | Re-enter with observed learning/recall need, explicit retained material and deletion contract, quality evaluation and clear separation from knowledge verification. |

### Activepieces — 9

Source: [Activepieces dossier](../../plans/2026-10-22-reference-review/activepieces.md).

| Finding                               | Disposition and owner                                   | Concrete destination | Consumers / limits / re-entry                                                                                                                                   |
| ------------------------------------- | ------------------------------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AP-01 — old-agent history false empty | Proposed core; REL                                      | M93.3                | Reinforces Macro 1; actor/origin scope before LIMIT plus honest pagination, not a second history implementation.                                                |
| AP-02 — silent failed detail          | Proposed core; REL                                      | M93.4                | Keep selection with local Retry; generation and originating vault reject stale responses.                                                                       |
| AP-03 — task outcome evaluations      | Proposed core; KNOW                                     | M97.6, M97.7         | Actual receipts/refusals/uncertainty determine hard outcomes; fluent text cannot override forbidden effects.                                                    |
| AP-04 — agent rehearsal               | Preview adopted, live phase gated; FLOW                 | M98.5, M98.6         | Preview consumes the same admission evaluator without side effects. Live rehearsal requires enforced process/config/network/tool isolation; otherwise disabled. |
| AP-05 — historical run configuration  | Proposed core; KNOW                                     | M97.3, M97.4         | M98.1 pins workflow versions; distinguish recorded configuration, actual reads and present configuration without deterministic replay claims.                   |
| AP-06 — rerun and continuation        | Proposed core; CHAT                                     | M95.5                | ACT owns effect retry/reconciliation; M98.3 resumes pinned durable waits. Ask again, continue and branch remain distinct.                                       |
| AP-07 — live approval evidence        | Retain and validate, extend durability separately; CHAT | M95.1                | M93.11 provides native acceptance; M96.3 later owns durable approvals. Existing ask-seam UI is not proof of restart-safe remote effects.                        |
| AP-08 — bounded connector recheck     | Conditional managed journey; ACT                        | M96.2, M96.4, M96.5  | Safe supported handshake, observed freshness and account-specific repair; UX consumes configured/authenticated/transport/callable distinctions.                 |
| AP-09 — retrieval quality and scale   | Proposed evaluation; KNOW                               | M97.7, M97.8         | M93.6 supplies scale method. Embeddings require demonstrated misses and separate locality/retention/deletion approval.                                          |

### AppFlowy — 10

Source: [AppFlowy dossier](../../plans/2026-10-22-ai-expansion-review/appflowy.md).

| Finding                                             | Disposition and owner                | Concrete destination                                        | Consumers / limits / re-entry                                                                                                                                       |
| --------------------------------------------------- | ------------------------------------ | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AF-01 — inspectable context selection through use   | Proposed core; CHAT                  | M95.4                                                       | KNOW supplies source identity/roles; distinguish selected, included, later read, cited and supporting, without claiming model reliance.                             |
| AF-02 — Rust-owned durable conversations            | Conditional retention decision; CHAT | M95.2, M95.3                                                | Stable scoped identities, normalized content, safe cache import and honest CLI availability; no raw reasoning archive.                                              |
| AF-03 — verifiable source evidence                  | Proposed core; KNOW                  | M97.1, M97.2, M97.4                                         | M95.4 consumes shared locators/receipts; a source list alone does not establish supporting evidence.                                                                |
| AF-04 — use this answer                             | Proposed core; CHAT                  | M95.4                                                       | Save/compare/open/export use existing guarded viewers/writers and recorded versions; previews remain distinct from workspace artifacts.                             |
| AF-05 — attachment readiness                        | Extend existing copy-in; CHAT        | M95.4                                                       | M91 import-on-send exists. Add explicit failed/unsupported/truncated outcomes with exact draft/chip retention; no silent omission.                                  |
| AF-06 — execution interface and model choice        | Conditional bounded experiment; ACT  | M96.8                                                       | CLI stays default; one approved disabled backend proves normalized events, approvals, broker-only credentials and unknown usage before enablement.                  |
| AF-07 — MCP foundation rather than inactive module  | Proposed managed scope; ACT          | M96.4, M96.7                                                | Compatibility matrix, explicit resources/prompts and a separately gated Tasks/App experiment; do not treat AppFlowy's unexported local module as production parity. |
| AF-08 — separate actions/subagents from chat chrome | Proposed service boundary; CHAT      | M95.6, M95.7                                                | ACT owns effects; FLOW owns steps; M94.7 consumes existing adapters. Foreground researcher, Agent handoff and scoped child job are different execution modes.       |
| AF-09 — Rust by ownership                           | Proposed bounded service work; CORE  | M99.1, M99.2                                                | ACT/CHAT/FLOW own their durable services; no language-percentage goal or React replacement.                                                                         |
| AF-10 — authority before YAML replacement           | Decision/prototype first; CORE       | M99.3, M99.4, M99.5; selected migration M99.6, M99.7, M99.8 | Current Markdown/YAML stays authoritative until explicit selection, backup/rollback and recovery evidence close.                                                    |

### n8n — 12

Source: [n8n dossier](../../plans/2026-10-22-ai-expansion-review/n8n.md).

| Finding                                       | Disposition and owner                                     | Concrete destination                                               | Consumers / limits / re-entry                                                                                                                                |
| --------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| N1 — connection as product object             | Proposed core; ACT                                        | M96.1, M96.2, M96.5                                                | CHAT/FLOW/UX consume action/account availability and immutable definition versions; custom MCP compatibility remains labeled separately.                     |
| N2 — Rust credential/account lifecycle        | Proposed contract amendment; ACT                          | M96.2                                                              | Choose secret-store platform and explicit legacy migration; clone/export retains unresolved references, never secrets or fallback accounts.                  |
| N3 — broker outbound MCP                      | Proposed core; ACT                                        | M96.4                                                              | Scope discovery/tools/resources/prompts, cancellation and compatibility; managed route cannot also forward provider credentials raw to CLI.                  |
| N4 — invocation ledger and honest retry       | Proposed core; ACT                                        | M96.3, M96.6, M96.8                                                | CHAT/FLOW consume canonical `outcome_unknown`, revision checks and unresolved-effect fences, including across fresh attempt IDs.                             |
| N5 — durable approval continuation            | Proposed core; ACT                                        | M96.3, M96.6                                                       | M98.3 owns workflow wait cursor only. Exact account/input/grants are frozen; one person decision and local claim do not prove exactly-once remote execution. |
| N6 — versioned typed workflow engine          | Proposed bounded core; FLOW                               | M98.1, M98.2, M98.3, M98.4, M98.9                                  | Step list/inspector, sequential v1, immutable published version and desktop-awake schedules; no unrestricted code or distributed workers.                    |
| N7 — typed delegated child task               | Conditional capability proof; CHAT                        | M95.6, M95.7                                                       | Finish M95.1 foreground research first; independent scope/credential/bypass proof precedes jobs. Background detach remains a separate decision.              |
| N8 — recovery/revision/branch identity        | Existing branch retained; archive/recovery proposed; CHAT | M95.1, M95.2, M95.3, M95.5                                         | One projection; archive readability differs from CLI resumability, and conversation ancestry never rolls back files/effects.                                 |
| N9 — tools/accounts/context/artifacts in chat | Proposed integration; CHAT                                | M95.4                                                              | M96.6 supplies account/action picker and effect inspection; M94.7 adopts real producers across the one assistant instance.                                   |
| N10 — addressable evidence lifecycle          | Proposed core; KNOW                                       | M97.1, M97.2, M97.4, M97.8                                         | CHAT receipts consume inline locator; revoked/stale/unavailable/no-match states stay distinct. Semantic retrieval is conditional.                            |
| N11 — executable agent scenarios              | Proposed core; KNOW                                       | M97.6, M97.7                                                       | CHAT/ACT/FLOW contribute actual conformance seams and fault cases; live-provider evidence requires separate execution authorization.                         |
| N12 — Rust ownership versus YAML choice       | Decision/prototype first; CORE                            | M99.1, M99.2, M99.4, M99.5; selected migration M99.6, M99.7, M99.8 | Operational JSON workflow versions do not choose page-metadata authority. Native UI stays a separate experiment.                                             |

### Plane — 10

Source: [Plane dossier](../../plans/2026-10-22-ai-expansion-review/plane.md).

| Finding                                                        | Disposition and owner                                        | Concrete destination                                               | Consumers / limits / re-entry                                                                                                                                                                                                  |
| -------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| PL01 — versioned shared actions                                | Proposed core; ACT                                           | M96.1, M96.3, M96.6                                                | Existing commands remain the navigation/UI registry; CHAT/FLOW consume one execution contract rather than reimplementing actions.                                                                                              |
| PL02 — observable delivery/effect records                      | Proposed core; ACT                                           | M96.3, M96.6                                                       | One ledger for chat/workflow/history; lost-response mutations remain unknown without automatic repetition.                                                                                                                     |
| PL03 — unfinished capture and intake outcomes                  | Session recovery adopted; extension gated; UX                | M94.4                                                              | M98.7 consumes the same draft/submission owner for recipes and separately approved persistence. M98.8 gates saved intake, not a second composer.                                                                               |
| PL04 — stable identity/typed persistence before YAML removal   | Decision/prototype first; CORE                               | M99.2, M99.3, M99.4, M99.5; selected migration M99.6, M99.7, M99.8 | Preserve malformed/unknown originals, relation/provenance identity and post-cutover edits through rollback.                                                                                                                    |
| PL05 — selected-text AI journey                                | Proposed core; CHAT                                          | M95.4                                                              | Snapshot page/version/range, preview, guarded single-editor Apply/undo and stale-selection conflict; existing Ask AI controls are retained.                                                                                    |
| PL06 — connection/credential/capability/observation separation | Proposed core; ACT                                           | M96.1, M96.2, M96.4, M96.5                                         | UX repair and CHAT picker consume distinct states, safe labels and observed freshness.                                                                                                                                         |
| PL07 — semantic work relationships                             | Retain current relations; semantic extension deferred; KNOW  | M97.5 covers contextual links only                                 | Blocking/duplicate/hierarchy Type semantics require a separate schema proposal with inverse labels, rename/delete/cycle/unresolved cases and explicit reevaluation authority. Context snippets do not deliver these semantics. |
| PL08 — saved views as repeatable action inputs                 | Retain queries; general bulk action extension deferred; FLOW | M98.2, M98.9 cover bounded v1 inputs/authoring only                | Re-enter general saved-view actions after defining fixed versus re-evaluated membership, scope/schema snapshot, changed-membership approval, per-item effects and resumable paging through existing evaluator/batch guards.    |
| PL09 — history joined to effects, not versions                 | Proposed core; ACT                                           | M96.6                                                              | REL supplies scoped run history; FLOW/CHAT store references. Effect observations and document/workflow versions remain different records.                                                                                      |
| PL10 — scope through asynchronous work                         | Retain and extend; ACT                                       | M96.1, M96.3, M96.4                                                | M93.3/M93.4, M95.2/M95.6 and M98.2/M98.3 consume trusted originating subject identity; client-supplied IDs cannot grant authority.                                                                                             |

## Prior work packages — 34

These rows map earlier delivery buckets, not additional ranked findings. The
original [CP](../../plans/2026-10-22-reference-strengthening-plan.md),
[AX](../../plans/2026-10-22-ai-expansion-plan.md) and
[UI](../../plans/2026-10-22-ui-refresh-plan.md) plans remain dated evidence.

| Package | One integration owner | Task destination / cross-consumption and narrowed scope                                                                                        |
| ------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| CP01    | REL                   | M93.1, M93.2; UX/CHAT consume the same acknowledgement/leave report.                                                                           |
| CP02    | REL                   | M93.3, M93.4; preserve already-present child-hop detail.                                                                                       |
| CP03    | REL                   | M93.11 owns native evidence; M95.1 separately owns sanitized live CLI acceptance; M94.9 records both.                                          |
| CP04    | REL                   | M93.6, M93.7; KNOW consumes workload and UX adopts selected accessible mechanism.                                                              |
| CP05    | KNOW                  | M97.1, M97.2; CHAT/UX consume one locator.                                                                                                     |
| CP06    | KNOW                  | M97.6, M97.7, conditional M97.8; service owners supply outcome evidence.                                                                       |
| CP07    | KNOW                  | M97.3, M97.4; M95.4 supplies separate context receipt and M98.1 separate workflow identity.                                                    |
| CP08    | FLOW                  | M98.5 deterministic preview; M98.6 live rehearsal only after isolation proof.                                                                  |
| CP09    | CHAT                  | M95.1, M95.5, conditional M95.6/M95.7; ACT owns effects and M98.3 owns pinned waits.                                                           |
| CP10    | KNOW                  | M97.5 contextual lists/mentions; neighborhood/global graph and semantic relation expansion deferred.                                           |
| CP11    | REL                   | M93.8 body source mode; M93.9 separate displaced-byte journal decision.                                                                        |
| CP12    | FLOW                  | M98.7 core selected capture/recipe journeys; M98.8 independently gates intake/overlays/rules/publishing; ACT supplies account/recheck service. |
| CP13    | REL                   | M93.5 discovery repair; M93.10 one versioned help source.                                                                                      |
| AX00    | CHAT                  | M95.1 M91 reconciliation; REL retains CP01/02/13 correctness ownership rather than hiding those in an AI catch-all.                            |
| AX01    | CORE                  | M99.1 typed transport/service pilot; M96.1 owns action definitions/subjects, with CHAT/FLOW registering their own DTOs.                        |
| AX02    | ACT                   | M96.2 account lifecycle, secret references and explicit legacy migration.                                                                      |
| AX03    | ACT                   | M96.4 broker protocol/compatibility; M96.7 separately gated Tasks/App experiment.                                                              |
| AX04    | ACT                   | M96.3, M96.6, M96.8 invocation/approval/reconciliation authority and operational gates.                                                        |
| AX05    | CHAT                  | M95.2/M95.3 archive; M95.4 receipts/artifacts; M97.1/M97.2 owns passage resolution/reveal.                                                     |
| AX06    | ACT                   | M96.5 narrow managed beta, M96.6 shared consumers; M98.7 adds Gmail draft/calendar preparation journeys after prerequisites.                   |
| AX07    | FLOW                  | M98.1, M98.2, M98.3, M98.4, M98.5, M98.7, M98.9; no always-on delivery promise.                                                                |
| AX08    | CHAT                  | M95.6, M95.7 only after backend scope proof; M91 researchers remain distinct.                                                                  |
| AX09    | CORE                  | M99.3, M99.4, M99.5 read-only inventory/comparison/authority decision, no production conversion.                                               |
| AX10    | CORE                  | M99.6, M99.7, M99.8 only after explicit authority selection and verified backup/rollback.                                                      |
| AX11    | ACT                   | M96.7 one disabled MCP App/Tasks proof; M96.8 one separately approved backend prototype, CLI default retained.                                 |
| AX12    | KNOW                  | M97.6/M97.7 owns outcomes; M93.6/M93.11 owns scale/native evidence; each owner adds its actual fault/integration cases.                        |
| UI00    | UX                    | M94.1 fresh source/build baseline; M95.1 supplies current M91 evidence. Historical startup failure is not a current defect.                    |
| UI01    | UX                    | M94.2 composition/role sheet and owner comparisons.                                                                                            |
| UI02    | UX                    | M94.3 four-surface first slice before wider adoption.                                                                                          |
| UI03    | UX                    | M94.4 creation draft/submission owner; M94.5 properties/commands/return paths.                                                                 |
| UI04    | UX                    | M94.6 data/embed adoption; REL owns bounded rendering/performance mechanism.                                                                   |
| UI05    | UX                    | M94.7 real M91/chat/Agent adoption; CHAT/ACT own producers and decisions.                                                                      |
| UI06    | UX                    | M94.8 utility/state/repair adoption; KNOW/ACT supply source/account truth.                                                                     |
| UI07    | UX                    | M94.9 separate visual/browser/native/performance/dependency dispositions.                                                                      |

## UI reviewer findings — 31

The [UI spec's exact research table](../2026-10-23-m94-ui-polish-and-journeys-design.md#research-disposition)
is authoritative for grouped requirement coverage. Every individual ID is visible
here so a grouped reference cannot conceal an omitted finding. Source dossiers:
[VS](../../plans/2026-10-22-ui-refresh-review/02-visual-system.md),
[PJ](../../plans/2026-10-22-ui-refresh-review/03-product-journeys.md),
[AC](../../plans/2026-10-22-ui-refresh-review/04-acceptance-challenge.md).

| Finding | One owner | Task destination and consumption                                                               |
| ------- | --------- | ---------------------------------------------------------------------------------------------- |
| VS01    | UX        | M94.2, M94.3 — composition/resolved document geometry.                                         |
| VS02    | UX        | M94.2, M94.3 — composition/resolved document geometry.                                         |
| VS03    | UX        | M94.2, M94.3 — action/type/control role inventory.                                             |
| VS04    | UX        | M94.2, M94.3 — action/type/control role inventory.                                             |
| VS05    | UX        | M94.3 — preserve accepted shell, compare rhythm.                                               |
| VS06    | UX        | M94.3, M94.6 — content-dependent density/cards.                                                |
| VS07    | UX        | M94.2, M94.3 — corner/control role inventory.                                                  |
| VS08    | UX        | M94.3, M94.5 — existing full-height inspector refinement.                                      |
| VS09    | UX        | M94.7 — conversation adoption using CHAT contracts.                                            |
| VS10    | UX        | M94.2, M94.3, M94.8, M94.9 — theme/state/motion evidence.                                      |
| VS11    | UX        | M94.2, M94.3 — icon roles without losing identity/actions.                                     |
| VS12    | UX        | M94.2, M94.3, M94.8, M94.9 — theme/state/motion evidence.                                      |
| VS13    | UX        | M94.2, M94.3, M94.8, M94.9 — theme/state/motion evidence.                                      |
| PJ01    | REL       | M93.1, M93.2; M94.3/M94.9 consumes acknowledged save/quit status.                              |
| PJ02    | REL       | M93.6, M93.7; M94.6/M94.9 adopts and records performance evidence.                             |
| PJ03    | UX        | M94.4 session drafts/destination; restart persistence remains separately gated in M98.7.       |
| PJ04    | UX        | M94.5 — return-state and properties vocabulary.                                                |
| PJ05    | UX        | M94.5 — metadata/return behavior with one writer.                                              |
| PJ06    | UX        | M94.6 — existing embedded/related view clarity.                                                |
| PJ07    | KNOW      | M97.1, M97.2; M94.8 consumes passage delivery after contract review.                           |
| PJ08    | UX        | M94.5 — shared menu/command labels and availability.                                           |
| PJ09    | ACT       | M96.2, M96.5, M96.6; M94.8 repair journey consumes real readiness.                             |
| PJ10    | CHAT      | M95.4, M95.5; M94.7 adopts result/recovery producers.                                          |
| PJ11    | UX        | M94.8, M94.9 — Knowledge semantics and complete state journeys.                                |
| PJ12    | UX        | M94.8, M94.9 — quiet Home and complete state journeys.                                         |
| AC01    | UX        | M94.1, M94.9 — source reconciliation and separate completion gates.                            |
| AC02    | UX        | M94.1, M94.9 — honest evidence/completion classes.                                             |
| AC03    | REL       | M93.1, M93.2 editor ownership; M94.4 owns distinct creation drafts; M94.9 records integration. |
| AC04    | UX        | M94.3, M94.5, M94.7, M94.8, M94.9 — actual widths/zoom and interaction evidence.               |
| AC05    | UX        | M94.3, M94.5, M94.7, M94.8, M94.9 — owner/accessibility/focus/scroll evidence.                 |
| AC06    | UX        | M94.3, M94.5, M94.7, M94.8, M94.9 — focus/status/scroll evidence.                              |

## Deferred and gated directions

The owner column assigns the future proposal boundary. It does not allocate
implementation work for a deferred feature. A favorable experiment or an accepted
core workstream cannot implicitly approve one of these extensions.

| Direction / originating finding                                     | One owner | Why outside unconditional core                                                                       | Concrete re-entry                                                                                                                                                     |
| ------------------------------------------------------------------- | --------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Offline archive import — MR-09                                      | FLOW      | No observed source format or archive journey selected.                                               | Source-format/sample decision, provenance/dedup/edited-copy and guarded-batch/undo design using existing importer.                                                    |
| Startup snapshots — T5                                              | REL       | Stale provisional state cannot acquire authority.                                                    | Measured startup bottleneck plus explicit display-only lifecycle and fresh-scan gating for every grant/write/trigger/Verify.                                          |
| Neighborhood/global graph — MR-10, CP10, M97.8                      | KNOW      | Contextual lists are the bounded first journey; visual proximity is not evidence.                    | Measured list-navigation failure, bounded readable neighborhood, keyboard alternative, stale/revoked handling and a separate owner-reviewed proposal.                 |
| Personal recall/flashcards — Thought Desk 9                         | KNOW      | Recall is a different product contract from verified knowledge.                                      | Observed learning need, material/retention/deletion choice and outcome comparison without automatic Verify.                                                           |
| Blocking/duplicate/hierarchy semantics — PL07                       | KNOW      | Existing generic relations and contextual links do not establish work dependency semantics.          | Separate capability/schema semantics with inverse labels, cycles, rename/delete/unresolved targets and explicit workflow reevaluation.                                |
| General saved-view bulk actions — PL08                              | FLOW      | Sequential workflow inputs do not settle changing bulk membership/approval.                          | Fixed versus re-evaluated membership contract, scope/schema snapshot, changed-membership approval, per-item effects and resumable paging.                             |
| Saved intake, date overlays, same-record rules — Thought Desk 5/6/8 | FLOW      | M98.8 selects each independently; no universal forms/rules system.                                   | Observed repeated journey; carrier/field/date semantics; rules atomically join guarded source write/receipt/undo or stay unavailable.                                 |
| External send/publishing                                            | ACT       | Gmail core journey creates drafts; calendar preparation creates an artifact.                         | Separate target/account/effect-policy approval, approved ActionDefinition and unknown-outcome/retry proof. M98.8 consumes it only after that decision.                |
| Persistent creation drafts — PL03/PJ03                              | UX        | M94.4 is memory-only and M98.7 cannot invent a second owner.                                         | Owner retention/privacy decision, adapter sharing canonical revisions/claims/submissions, tombstones/mode transitions and durable receipt reconciliation.             |
| CRDT/database-authored bodies                                       | CORE      | Combines editor, external-edit, collaboration and authority changes without a demonstrated need.     | Separate collaboration requirement and editor/IME/accessibility/round-trip/recovery prototype; no implication from metadata-store selection.                          |
| Full Rust UI                                                        | CORE      | Language ownership does not establish rich-editor/native advantage.                                  | M99.5 separate bounded prototype plan: editor/IME/VoiceOver, large table, panes and chat; measured concrete benefit before any rewrite proposal.                      |
| General always-on hosting / detached children                       | FLOW      | Desktop-awake runtime cannot execute while app is closed/asleep; detach changes authority/lifecycle. | Separate owner-approved host deployment, credentials, operational costs, retention, revocation and cancellation/claim model; CHAT owns a later child-detach contract. |
| Arbitrary workflow code/distributed graph engine                    | FLOW      | V1 is bounded sequential typed steps with no arbitrary shell/script.                                 | Demonstrated expressiveness problem, a separately reviewed execution/isolation model and replay/recovery/resource proof.                                              |
| Semantic retrieval / embeddings                                     | KNOW      | Lexical failure has not yet been measured for this corpus.                                           | M97.7 labeled miss and M97.8 measured benefit, explicit locality/retention/deletion approval, revoked-source and exact-priority controls.                             |
| MCP Tasks/Apps and another backend                                  | ACT       | Compatibility, packaged isolation and approval support are unproven.                                 | M96.7/M96.8 disabled proof, protocol/backend capability decisions and owner enablement; structured fallback/CLI remain supported.                                     |
| Independently scoped supervised jobs                                | CHAT      | Existing foreground researchers do not prove child-specific credentials or bypass denial.            | M95.6 backend capability proof, grant intersection and ACT effect boundary before M95.7 lifecycle enablement.                                                         |

## Existing work and acceptance are not interchangeable

M95.1 reconciles current M91 before filing work. Parent/child ordered parts,
recursive projection, bounded child summary restoration, context usage pull,
checked fork/branch, attachment import-on-send and AI element adapters are present
in source. The old flat-reducer, absent-branch, absent-context and unused-elements
premises are stale. M93.4 similarly preserves already-present child-hop detail.
The former policy-loader startup failure is historical; a new startup claim needs
fresh source/build evidence through M94.1.

Recorded CLI conformance, live/replay/recovery equality, actual researcher policy
enforcement, accounting and packaged/native journeys remain acceptance work.
Neither an existing researcher preset nor a visual child trace establishes the
independently scoped job contract. Neither source inspection nor this register
reports a passing suite, benchmark, native interaction or live provider trial.

The rows intentionally leave owner choices visible: storage authority, archive
retention, managed-provider/secret-store scope, optional journal, visual comparison
values and individually gated extensions. PL07 and PL08 require future bounded
designs if selected; they are explicit deferrals rather than missing ownership or
claims that existing generic relations/queries already implement the proposal.

## Milestone allocation and historical task aliases

M91 and M92 keep their existing assignments. This program uses M93–M99 and the phase IDs below. Requirement prefixes stay unchanged; the earlier task aliases are retained here solely to resolve historical review references. All implementation headings and current coverage rows use milestone phases.

| Earlier workstream | Milestone                                | Earlier task alias → canonical phase                                                                                                                                                        |
| ------------------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1 / REL           | M93 — Reliable workspace                 | REL-T01 → M93.1; REL-T02 → M93.2; REL-T03 → M93.3; REL-T04 → M93.4; REL-T05 → M93.5; REL-T06 → M93.6; REL-T07 → M93.7; REL-T08 → M93.8; REL-T09 → M93.9; REL-T10 → M93.10; REL-T11 → M93.11 |
| R7 / UX            | M94 — UI polish and journeys             | UX-T01 → M94.1; UX-T02 → M94.2; UX-T03 → M94.3; UX-T04 → M94.4; UX-T05 → M94.5; UX-T06 → M94.6; UX-T07 → M94.7; UX-T08 → M94.8; UX-T09 → M94.9                                              |
| R2 / CHAT          | M95 — Chat and supervised agents         | CHAT-T01 → M95.1; CHAT-T02 → M95.2; CHAT-T03 → M95.3; CHAT-T04 → M95.4; CHAT-T05 → M95.5; CHAT-T06 → M95.6; CHAT-T07 → M95.7                                                                |
| R3 / ACT           | M96 — Connectors, MCP and actions        | ACT-T01 → M96.1; ACT-T02 → M96.2; ACT-T03 → M96.3; ACT-T04 → M96.4; ACT-T05 → M96.5; ACT-T06 → M96.6; ACT-T07 → M96.7; ACT-T08 → M96.8                                                      |
| R5 / KNOW          | M97 — Knowledge, evidence and evaluation | KNOW-T01 → M97.1; KNOW-T02 → M97.2; KNOW-T03 → M97.3; KNOW-T04 → M97.4; KNOW-T05 → M97.5; KNOW-T06 → M97.6; KNOW-T07 → M97.7; KNOW-T08 → M97.8                                              |
| R4 / FLOW          | M98 — Workflows and automation           | FLOW-T01 → M98.1; FLOW-T02 → M98.2; FLOW-T03 → M98.3; FLOW-T04 → M98.4; FLOW-T05 → M98.5; FLOW-T06 → M98.6; FLOW-T07 → M98.7; FLOW-T08 → M98.8; FLOW-T09 → M98.9                            |
| R6 / CORE          | M99 — Rust services and storage          | CORE-T01 → M99.1; CORE-T02 → M99.2; CORE-T03 → M99.3; CORE-T04 → M99.4; CORE-T05 → M99.5; CORE-T06 → M99.6; CORE-T07 → M99.7; CORE-T08 → M99.8                                              |

## Final implementation-readiness corrections

The [final review correction table](final-review.md#material-corrections-now-assigned-to-implementation)
maps every newly identified design gap to its existing milestone phases. It
strengthens contracts and regression coverage without adding duplicate milestones
or silently promoting deferred source features. Existing denominators remain 78
ranked findings, 34 prior packages, 31 UI review IDs and 75 numbered requirements.
