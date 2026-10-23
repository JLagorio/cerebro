# Reference review evidence and finding disposition

This packet supports the [Cerebro strengthening plan](../2026-10-22-reference-strengthening-plan.md), dated 2026-10-22. It compares the five requested local example repositories with Cerebro's current working tree, including the staged M84–M90 implementation. The main plan is the implementation sequence; the dossiers retain the detailed reasoning and source evidence behind it.

Five independent repository specialists reviewed all five topics for their assigned reference. Three additional reviewers challenged the combined plan by architecture/practices, agent/knowledge behavior, and UX. The lead review checked important code paths independently and consolidated **46 ranked repository findings into 13 work packages**, with optional product directions explicitly deferred. These are 25 topic comparisons, not 25 separately spawned agents.

## Coverage across the five topics

| Reference                       | Engineering practices                                                      | Architecture                                                                      | UX/UI                                                                    | Agentic workflows                                                            | Knowledge and retrieval                                                                         |
| ------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| [Macro](macro.md)               | Retrieval and duplicate evaluations; selective architecture rails          | Ports, transcript folding and query/read boundaries                               | Exact source/turn navigation; run inspection; heavy transcript rendering | Nested delegated activity and trace completeness                             | Keyword search and separate dedup stack; evaluation methods; risks of automatic memory          |
| [Morrow](morrow.md)             | Failed-save fault tests; storage recovery tests                            | Save queue/repository boundaries and external-version retention                   | Source escape hatch, passage landing, capture and contextual links       | No AI implementation to borrow; deterministic workflow patterns only         | Lexical search, mentions, local neighborhoods and archive import                                |
| [Tolaria](tolaria.md)           | Stage timings, benchmarks, IME/RTL and real-file test limits               | Bounded content/parsed caches, progressive editor load, provisional startup state | Responsive lists, retryable readiness, keyboard writing                  | External CLI onboarding and generated human/agent help                       | Name normalization and portable sources; Cerebro's richer search and guarded knowledge retained |
| [Thought Desk](thought-desk.md) | Mixed-workspace stress fixtures and browser performance diagnostics        | Data/render bounds, normalized search projections and storage differences         | Large tables, saved intake, explicit calendar overlays                   | Deterministic rules only; no model agent runtime found in reviewed paths     | Heterogeneous search and personal recall, explicitly distinct from verification                 |
| [Activepieces](activepieces.md) | Agent task fixtures, live repeated trials and race-specific recovery tests | Versioned definitions, waitpoints, manifests and checkpoint limits                | Sample input/output, scoped history and retryable detail failures        | Rehearsal, partial-run recovery, approval evidence and connector diagnostics | Scoped knowledge selection, relevance/scale evaluation; vectors do not establish authority      |

Every repository received all five topic lenses. “No corresponding agent implementation found” is a meaningful result for Morrow and Thought Desk, not a missing review cell. No reference is designated an overall architecture winner; each has different ownership, deployment and product assumptions.

## Independent validation

| Review                                                                | Main corrections incorporated                                                                                                                                                                                                                                                         |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Architecture and engineering validation](architecture-validation.md) | Retain drafts through teardown; scope every run-detail read/link by originating vault; render child-hop details; distinguish scoped BM25 statistics from per-file caches; reuse existing recovery and manifests                                                                       |
| [Agent and knowledge validation](knowledge-agent-validation.md)       | Direct CLI writes are not all receipted Cerebro writes; copied vaults do not prove rehearsal isolation; assembly manifests describe ledger evidence rather than all chat context; export source locations over IPC; respect actual transcript retention and partial child attribution |
| [UX validation](ux-validation.md)                                     | Fix failed CLI detection before new onboarding; preserve existing record forms, capture and source-panel entry points; make source editing a precise body/serialization contract; require complete keyboard/native task journeys                                                      |

The validators attempted to disprove priority claims, not merely restate the repository reports. The main plan incorporates their constraints. Some dossiers describe an earlier, broader candidate; the main plan's narrowed scope and the disposition below govern implementation.

## Disposition of the 46 ranked findings

“Core” means included in a proposed main-plan work package. “Conditional” means a scoped experiment with prerequisites, not a committed feature. “Retain” credits an existing strength and carries only relevant validation forward. Priorities in the main plan govern combined work; individual dossiers used slightly different effort bands.

| Reference finding                              | Disposition                           | Main-plan destination                                              |
| ---------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------ |
| Macro 1 — scoped run history and failed detail | Core, P0                              | CP02, including child detail and originating-vault corrections     |
| Macro 2 — exact supporting content             | Core                                  | CP05, then CP07 answer/evidence continuity                         |
| Macro 3 — delegated CLI trace                  | Core, after recorded CLI evidence     | CP09; read-only visibility first, no inferred write attribution    |
| Macro 4 — retrieval and duplicate evaluations  | Core                                  | CP06; retain current retrievers and production cutoff              |
| Macro 5 — scale/native acceptance              | Core                                  | CP03/CP04; existing measurements remain qualified                  |
| Macro 6 — conversation search                  | Conditional                           | Optional-extension table; current cache/CLI retention only         |
| Macro 7 — original-attachment search           | Conditional                           | Optional-extension table; CP05/CP06 and contained extraction first |
| Macro 8 — architecture enforcement             | Core where a new seam needs it        | Architecture delivery rules; no broad module migration             |
| MR-01 — failed autosave recovery               | Core, P0                              | CP01, including teardown-surviving draft ownership                 |
| MR-02 — search-hit landing                     | Core                                  | CP05                                                               |
| MR-03 — overwritten outside preimages          | Conditional                           | CP11 separate recovery-journal decision; preserve D2               |
| MR-04 — backlink context and mentions          | Core, bounded                         | CP10 after CP05; no automatic knowledge relations                  |
| MR-05 — source editing escape hatch            | Core with precise byte contract       | CP11; existing raw reader and guarded body mutation                |
| MR-06 — native acceptance                      | Core                                  | CP03                                                               |
| MR-07 — accent-tolerant search                 | Conditional measured experiment       | CP06 fixtures then exact-priority normalization                    |
| MR-08 — capture from another application       | Conditional                           | CP12; native shortcut/focus proof                                  |
| MR-09 — offline archive import                 | Conditional                           | Optional-extension table; existing import planner and provenance   |
| MR-10 — local relationship neighborhood        | Conditional                           | CP10 after an accessible contextual-list journey                   |
| T1 — performance budget tooling                | Core                                  | CP04                                                               |
| T2 — bounded list rendering                    | Core, measured design                 | CP04, preserving AX/find/navigation contracts                      |
| T3 — warm editor caches                        | Conditional measured optimization     | CP04 editor slice, closed clean documents only                     |
| T4 — progressive editor loading                | Conditional measured optimization     | CP04 editor slice, complete-document readiness before editing      |
| T5 — startup snapshots                         | Conditional, deferred                 | Optional-extension table; never grant/write/trigger authority      |
| T6 — CLI readiness                             | Core, immediate error-state repair    | CP13 and Wave 1                                                    |
| T7 — human/agent product guidance              | Core                                  | CP13, one versioned help source with bounded access                |
| T8 — IME and bidirectional writing             | Core validation                       | CP03; reproduce before adding editor workarounds                   |
| T9 — name normalization                        | Conditional measured experiment       | CP06; retain stronger corpus search                                |
| T10 — file/knowledge boundaries                | Retain plus native journey validation | CP03; no new generic attachment or knowledge system                |
| Thought Desk 1 — mixed-workspace benchmark     | Core                                  | CP04                                                               |
| Thought Desk 2 — bounded table work            | Core, measured design                 | CP04; do not copy progressive keyboard limits                      |
| Thought Desk 3 — native accessibility/save     | Core                                  | CP01/CP03                                                          |
| Thought Desk 4 — local-search projections      | Conditional measured optimization     | CP04, immutable snapshot/schema invalidation                       |
| Thought Desk 5 — saved intake configurations   | Conditional                           | CP12 and optional-extension table, existing RecordComposer         |
| Thought Desk 6 — calendar overlays             | Conditional, deferred                 | Optional-extension table, explicit date-field sources              |
| Thought Desk 7 — heterogeneous retrieval tests | Core                                  | CP06 over CP04's corpus                                            |
| Thought Desk 8 — deterministic record rules    | Conditional, deferred                 | Optional-extension table; authority/trigger semantics first        |
| Thought Desk 9 — personal recall               | Conditional, deferred                 | Optional-extension table; never equivalent to Verify               |
| AP-01 — old-agent history false empty          | Core, P0                              | CP02; duplicate evidence reinforces Macro 1                        |
| AP-02 — silent failed detail                   | Core, P0                              | CP02; explicit unavailable and request identity                    |
| AP-03 — task outcome evaluations               | Core                                  | CP06                                                               |
| AP-04 — agent rehearsal                        | Core preview; live phase conditional  | CP08 with proven process/config/network/tool isolation             |
| AP-05 — historical run configuration           | Core                                  | CP07; observed identity, no deterministic replay claim             |
| AP-06 — rerun and continuation                 | Core                                  | CP09; retain conservative unknown-effect handling                  |
| AP-07 — live approval evidence                 | Core validation                       | CP03 before stronger live execution promises                       |
| AP-08 — bounded connector recheck              | Conditional                           | CP12; supported safe handshake and observed freshness              |
| AP-09 — retrieval quality and scale            | Core evaluation                       | CP06/CP04; embeddings remain an evidence-driven separate decision  |

## Evidence and provenance

The baseline HEAD is `23479518c2827d361c9c970abfac8245f9d84600`. At review start, 618 tracked paths differed from HEAD. The review included those bytes, not just committed source. The earlier implementation record describes its own original staging state; the 2026-10-22 inspection found the owner's changes staged. This review did not restage, unstage, commit, or modify them.

A separate untracked M91 AI-elements/subagents plan appeared during the review. It was read to identify overlap and left unchanged; the main plan records the coordination boundary. Its presence is not counted as this review's output or as shipped functionality.

The [source manifest](source-manifest.json) fingerprints locally resolvable evidence references and the review documents. It records file sizes and SHA-256 values, reference version/license-file identities, and the final preservation check for the 618 preexisting paths. It is a reproducibility aid, not a claim that every referenced file was fully audited or that a local copied version establishes an upstream commit. References in the dossiers use exact local paths and line ranges; later edits may move those lines.

The five example roots have no recorded upstream checkout revision in this review. Macro's root license is AGPL v3, Morrow's is Apache 2.0, Tolaria and Thought Desk declare AGPL-3.0-or-later, and Activepieces declares MIT with listed separately licensed areas. The individual dossiers identify the inspected declarations and important exceptions. The existing guided-rebuild decision remains the reuse model; no source copying or new license approval gate is proposed.

The lead also inspected Tolaria's bundled landing screenshot and an existing Cerebro M84–M90 page capture. These are static composition references, not live-state or accessibility evidence; the Cerebro capture may predate later staged adjustments. They support no claim that either application's current native behavior was exercised.

## Review checks and limits

Checks for this documentation change are targeted formatting, local-link/reference resolution, source fingerprinting, and preservation of preexisting changed files. The source review did not run the reference applications, install their dependencies, or run their test suites. Existing Cerebro test and performance records are cited with their recorded limits, not presented as fresh results.

The plan's implementation acceptance remains future work: focused regressions for confirmed defects, production workloads for performance, native input/assistive-technology journeys, and sanitized live CLI evidence. The failed-save path is source-confirmed; runtime data loss was not reproduced during this review. Component code establishes UI behavior contracts but cannot establish aesthetic preference or native usability on its own.

No application, policy, fixture or reference source was changed. The deliverable is the plan and this evidence packet.
