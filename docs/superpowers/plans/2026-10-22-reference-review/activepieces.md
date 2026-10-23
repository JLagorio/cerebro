# Activepieces reference review for Cerebro

Date: 2026-10-22. Scope: the local `docs/examples/activepieces-main` snapshot and the current Cerebro working tree, including staged changes. This is a source review, not a claim that either application's runtime was exercised.

## Conclusion

Activepieces is most useful as a reference for making automation inspectable: sample inputs, versioned definitions, explicit waiting states, actionable run history, and behavior evaluations. Cerebro already has much of the harder foundation: authoritative Rust writers, guarded knowledge, durable admission and leases, bounded agent chains, receipts, editable approvals, and honest unknown usage. The opportunity is to connect those foundations into a comprehensible **configure → rehearse → run → inspect → recover** journey.

The first work should fix two concrete history defects, establish the missing live approval evidence, and add outcome evaluations. Rehearsal and reproducible configuration manifests follow. A cloud workflow engine, arbitrary action marketplace, remote vector database, or another model credential layer would be a poor transplant.

## Provenance, scope, and reuse

The example's `package.json:1-4` identifies `activepieces` version `0.92.2`, with `bun@1.4.0`. There is no `.git` directory in this copied example; an upstream commit, download date, or exact release correspondence was not established. “0.92.2 snapshot” is the supported description. Cerebro's base HEAD was `23479518c2827d361c9c970abfac8245f9d84600`; this review reads working files over that base. In particular, `AgentRunHistory.tsx`, `AgentProperties.tsx`, and `agent/interaction.rs` already have staged changes, and the M84–M90 implementation record reports substantial completed UI work.

The local `docs/examples/activepieces-main/LICENSE:3-17` states MIT Expat for content outside listed exceptions and preserves third-party licenses. It assigns `packages/ee/` and `packages/server/api/src/app/ee/` to `packages/ee/LICENSE`; that file's lines 6-24 impose separate production and redistribution conditions. Agent approval and tool-pinning server files inspected below are in that exception. They provide behavioral reference, not proposed code to copy. No reference files were edited, installed, linted, or tested.

Evidence is implementation plus selected tests, with negative findings bounded to the inspected seams. No visual or accessibility superiority is inferred from JSX alone. No claim of whole-repository test success is made by this review.

## Five-topic assessment

| Topic                             | What the example demonstrates                                                                                                 | What Cerebro already has                                                                                               | Useful remaining work                                                                                   |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Engineering practices and testing | Race-specific waitpoint integration tests; live agent fixtures with hard assertions, repeated trials and calibrated judgments | Shared Rust/TS cases, mutation-resistant policy journeys, sanitized CLI recordings, extensive component/browser checks | Outcome-level regression corpus and closure of explicitly owed native/CLI evidence                      |
| Architecture                      | Versioned flow definitions, persisted step output, bounded waitpoints and explicit resume ownership                           | Files as authority; operational SQLite; leases, deduplication, path locks, batch journal, guarded receipts             | Bounded run configuration manifests and explicit recovery planning, without a second workflow authority |
| UX/UI                             | Sample input/output inspection; server-filtered run lists; a failed detail remains open with Retry                            | Agent pages, editable decision cards, run causes, transcripts, pages written, partial states, staged surface polish    | Correct history scope/pagination and read failures; one rehearsal-to-recovery journey                   |
| Agentic workflows                 | Inspect an individual step before enabling a flow; distinguish stale signals, completed pauses and consumed work              | Ask-first writes, human-only answers, unattended Review queue, schedules, event wakes, conditions, followups           | Safe rehearsal, clearer rerun semantics, durable configuration comparison and connector diagnostics     |
| Knowledge/retrieval               | Explicit per-agent file selection, chunk storage/readiness, bounded scoped vector search                                      | BM25, excerpt locations, graph expansion, evidence manifests, contradiction handling, human verification               | Measure answer-source relevance and scale before selecting any new retrieval technology                 |

## Findings and proposed work, in priority order

Effort assumes one engineer familiar with Cerebro, with review: **S** roughly 1-3 engineering days; **M** roughly 1-2 weeks; **L** roughly 3-5 weeks. These are sizing bands, not delivery commitments. Validation involving the user's CLI or macOS environment can add elapsed time. P1 is work to prioritize; P2 follows once the trust and test seams are reliable.

### AP-01 — Agent history can report a false empty result

**P1 · confirmed defect · S for scope correction, M with pagination.** Activepieces's run table sends project, filters, cursor and limit to its API (`docs/examples/activepieces-main/packages/web/src/features/flow-runs/components/runs-table/index.tsx:105-130`). Cerebro fetches the newest 200 runs without an actor filter, filters afterward, and reports “No runs recorded for this agent” if none survive (`src/status/AgentRunHistory.tsx:37-75`). An older agent can therefore appear never to have run after unrelated activity displaces its rows. The request is also not narrowed to the agent page's vault.

Rust already supports `actor` and `vault_id` before `LIMIT` (`src-tauri/src/runtime/fleet.rs:43-57,273-308`), but that filter has no cursor. Use those existing filters first; then add keyset pagination over `(started_at, run_id)` and an explicit continuation flag. Preserve cross-agent children by separately fetching the bounded lineage of displayed roots, rather than dropping the filter to obtain hops. Establish the intended cross-vault behavior explicitly for construct pages; ordinary agent pages should not conflate matching actor names in different vaults.

**Acceptance:** an agent with one old run remains discoverable behind 250 newer runs by other actors; same-named actors in two vaults remain correctly scoped; tied timestamps paginate without duplication; a child outside the initial page remains navigable; a truly empty filtered result alone gets the empty copy. Add focused Rust read-model and component tests, then one browser journey. Depends only on agreeing the scoping contract.

### AP-02 — A failed history detail should remain visible and retryable

**P1 · confirmed defect · S.** Activepieces's detail keeps the selected run open and renders `DataFetchErrorState` with Retry (`docs/examples/activepieces-main/packages/web/src/app/routes/agents/id/runs/run-detail-panel.tsx:54-85`). Cerebro's `openRun` maps a rejected detail read to `setOpen(null)` (`src/status/AgentRunHistory.tsx:29-35`). The user's click can produce no explanation. A second seam maps a failed knowledge-write read to `null`, then labels it “not recorded” (`src/status/RunDetailPanel.tsx:72-98`). That erases the distinction between missing records and inability to read them.

Retain selected run identity separately from loaded detail and use the existing loading/ready/unavailable vocabulary. Give the knowledge subsection its own unavailable result and Retry; preserve healthy sections. Guard late responses so selecting run B cannot reopen run A after A's slower request completes. Match existing `StateMessage`/surface roles rather than importing Activepieces's visual styling.

**Acceptance:** reject each read independently; the selected run stays selected, the correct failure is announced, Retry repairs it, healthy metadata remains, and out-of-order completion cannot replace the newer selection. Add the five state-lab presets where the section participates. No new backend storage is required.

### AP-03 — Evaluate whether the assistant accomplishes the user's task

**P1 · depth gap · M for an initial corpus.** The example distinguishes regression fixtures from aspirational capability fixtures, repeats live runs, retains run metadata, and measures agreement against human labels (`docs/examples/activepieces-main/packages/server/worker/test/lib/agent-eval/agent-eval.test.ts:9-58`; `core/eval-format.ts:16-31` in the same directory). Its injection fixture combines exact tool-argument prohibitions with a task-quality rubric (`fixtures/injection-untrusted-content-not-instruction.json:3-54`). This is more informative than testing prompt strings alone.

Cerebro does have evaluations: `src-tauri/src/eval/mod.rs:1-65` describes adversarial cross-module journeys, and `scripts/cli-record/sanitize.ts:1-29` preserves sanitized real protocol evidence. Those prove important machinery, but neither is a general benchmark of end-to-end model behavior for ordinary user tasks.

Add a Cerebro-owned corpus: capture and file a note; answer with accessible evidence; report contradictory sources; decline verification; obey a mid-turn correction; stop on stale content; queue an unattended ask-first write; resume after denial; decline injected external instructions; report an unavailable connector; produce only a mail draft. Each fixture declares starting files, user turns, allowed side effects, expected durable outputs, and deterministic assertions. Separate protocol replay from live execution using the user's authenticated Claude Code. Keep optional human or model judgment secondary to exact checks; do not introduce provider API keys or treat a skipped live suite as a pass.

**Acceptance:** every fixture has a meaningful negative control; results record CLI/model/prompt-policy identity, unknown cost honestly, and sanitized transcripts. The offline gate covers every hard invariant; a reviewed repeated live baseline reports variability and failed dimensions. Depends on the existing recording kit; AP-05 improves attribution of future regressions.

### AP-04 — Add an agent rehearsal that cannot mutate the vault

**P1 · missing product journey · L, staged into deterministic preview first.** Activepieces exposes sample input/output and last-test state directly beside an action (`docs/examples/activepieces-main/packages/web/src/app/builder/test-step/test-action-section.tsx:31-61,109-155`). Its engine can seed prior outputs from samples (`docs/examples/activepieces-main/packages/server/engine/src/lib/handler/context/test-execution-context.ts:18-98`). These tests may execute real actions; “test” is not itself a safety guarantee.

Cerebro's draft-on-Done behavior, derived permission consequences and schedule validation already exist (`src/library/AgentProperties.tsx:138-149,884-917`; `src/library/ScheduleField.tsx:224-233`). The missing experience is selecting an example page/event and seeing the specific admission, readable scope, likely decisions and proposed changes before activation.

First ship **Preview trigger**: deterministic, clock-injected evaluation using the actual wake/grant logic, with match/non-match, scope, pause, budget and condition prerequisites. Then add **Rehearse instructions** using an isolated disposable copy or a dedicated execution sink that cannot mint a production write receipt. Disable shell, outside connector mutations, real followups and wake production. Every tool must have an explicit rehearsal disposition; unsupported behavior is reported, never silently simulated as success. Return proposed diffs and decisions to the agent page; applying a useful result is a separate ordinary human write through existing guards.

**Acceptance:** filesystem and runtime checks demonstrate zero production writes, zero real followups and zero external mutations; a crafted tool call cannot escape the sink; simulated unknowns are visible; fixture input and configuration hash are retained; Cancel stops the rehearsal; the actual trigger and preview agree on shared cases. Depends on AP-03 and preferably AP-05. A read-only model run alone is an acceptable initial limited mode, provided it does not claim to have tested writes.

### AP-05 — Make the configuration used by each run inspectable

**P1 · architecture depth gap · M.** Activepieces models locked/draft versions and can use a previous definition as a draft, carrying sample data (`docs/examples/activepieces-main/packages/server/api/src/app/flows/flow-version/flow-version.service.ts:53-95,149-185`). Versioned pieces also receive explicit compatibility decisions, with concurrent-change protection (`piece-upgrade.service.ts:187-205,275-309` in the same directory).

Cerebro records causes, session IDs, costs, writes and assembly metrics; pending writes retain their own grant snapshot (`src-tauri/src/runtime/schema.rs:1282-1307,1324-1388`; `src-tauri/src/runtime/fleet.rs:59-127`). Attended approvals retain a request snapshot in memory. Those are not one durable explanation of the effective instructions, selected skills, grants and connector configuration used by every run. This makes “what changed since yesterday's successful run?” harder than it should be.

Create a bounded operational execution manifest at dispatch: agent/skill source identities and content hashes, policy artifact digests, effective grant, requested and observed model, CLI version when observed, connector names and approved spec digests, cause, and relevant context manifest IDs. Keep raw tokens, headers, environment values and bearers out. Vault Markdown remains the current source of truth; the manifest is historical evidence, not a shadow editable agent record. Show a compact **Configuration used** section and a comparison against current configuration, with missing historical bytes explicitly unavailable. Do not promise deterministic LLM replay.

**Acceptance:** editing an agent after dispatch cannot change the historical view; a resumed approval is tied to its originating grant; secrets never enter the manifest; old runs say not recorded; policies and content mismatches appear in comparisons; read APIs remain SELECT-only. AP-03 and AP-04 consume these manifests.

### AP-06 — Explain rerun versus continuation and reconcile uncertain effects

**P2 · depth gap · M, wider automatic continuation L.** Activepieces persists explicit waitpoints and handles stale, duplicate and early resume signals (`docs/examples/activepieces-main/packages/server/api/src/app/waitpoints/waitpoint-service.ts:19-84,87-159`). Its integration tests cover repeated stale signals and concurrent completions (`docs/examples/activepieces-main/packages/server/api/test/integration/ce/flows/flow-run/waitpoint.test.ts:410-503,655-713`).

Cerebro already reconciles expired leases as unknown usage and requeues appropriately (`src-tauri/src/runtime/dispatch.rs:1231-1274`), and interrupted pending writes explicitly tell the agent to check whether they landed (`src-tauri/src/runtime/pending_writes.rs:363-383,463`). The assistant Retry button re-sends the previous question (`src/agent/AiPanel.tsx:1142-1151`); it is not a persisted step checkpoint. The absent layer is a user-visible recovery plan that links receipts, changed pages, transcript and unresolved outside effects before re-execution.

Label the action according to actual behavior. For a run with effects, show what Cerebro recorded, what remains unknown, whether the original session is available, and whether the next action will continue a session or ask again. Start with assisted reconciliation; do not automatically replay a foreign connector mutation without a supported idempotency contract. Record the new run's relationship to the failed one.

**Acceptance:** crash after a vault write but before final output does not claim “nothing happened”; resumed runs retain lineage; changed target bytes require the existing stale-content handling; unknown external effects stay unknown; a read-only failure can still retry with low friction. Depends on AP-01/02 and AP-05. Preserve current conservative recovery holds.

### AP-07 — Close live approval evidence before expanding automation

**P1 · validation gap, not a missing approval system · M with environment dependency.** The example binds a decision to the previewed tool/input/run and consumes approvals once (`docs/examples/activepieces-main/packages/server/api/src/app/ee/agent/agent-approval-gate.ts:24-52`, restricted-license reference). Cerebro already implements stronger vault-specific input hashes, schema checks, scopes and authoritative dispatch. Its staged card supports editable drafts and retained errors (`src/agent/WriteApprovalCard.tsx:14-29,48-126`).

The live seam remains explicitly owed in `src-tauri/src/agent/interaction.rs:14-16,45-64`: CLI deferral/resume, edited input, and structured questions were derived from a particular CLI bundle. Lines 72-75 also deliberately discard the in-memory waiting book at quit. The M84–M90 implementation record's lines 125-132 confirms browser evidence did not close earlier native/live-service acceptance.

Run a disposable-vault acceptance matrix through the packaged app and the recorded CLI version: allow, deny, edit, invalid edit, stale target, stop during answer, repeated click, lost hook, restart while waiting, and switch vault. Persist sanitized observations via the recording skill/kit; label each proof as actual live evidence or simulation. Decide whether reopening a waiting question after restart is a desired later feature; current refusal-on-restart is a safe specified behavior, not proof of data loss.

**Acceptance:** a page changes exactly once only after the intended human answer; edited bytes match the preview; revoked or stale grants cannot execute; the next ask after restart is explained; transcripts and UI agree. Failure here blocks stronger resume promises, not unrelated UI fixes.

### AP-08 — Give connector health an explicit, bounded recheck

**P2 · depth gap · M; tool-schema drift detection remains a feasibility spike.** Activepieces offers a dedicated “Recheck connection” control (`docs/examples/activepieces-main/packages/web/src/features/connections/components/revalidate-connection-button.tsx:18-37`) and explicit piece-version compatibility decisions cited in AP-05.

Cerebro already approves exact connector specifications per machine, never silently trusts a cloned vault, and records observed health (`src-tauri/src/connectors.rs:27-37`; `src-tauri/src/runtime/schema.rs:1250-1279`). Settings shows last observed state and directs sign-in to Claude Code (`src/app/ConnectorSettings.tsx:326-350,409-450`). Its state is observational, so an old success is not a fresh connectivity proof.

Add **Check connection** using the user's CLI and only an approved server, with timeout/cancel and an explicit no-mutation contract. If the installed CLI cannot expose a safe handshake, say so and offer its existing sign-in instructions; do not fall back to arbitrary business tool calls. Record freshness, reachability, authentication need, and “tools not inspected” separately. In a later spike, determine whether a schema/version digest can be observed through supported CLI output. Only then define compatibility warnings and any necessary reapproval. A stable server URL does not establish stable tool semantics.

**Acceptance:** unapproved specs launch nothing; a failed check does not overwrite the last observation as success; cancellation cleans up; no credentials are duplicated; observed server identity stays bound to the checked spec; inherited connector limits and exact-name mail-send denials remain explicit. Depends on live CLI evidence and AP-03; AP-05 can retain observed compatibility identity.

### AP-09 — Benchmark retrieval quality and scale before adding embeddings

**P2 · validation/depth gap · M.** Activepieces chunks documents and CSV, batches embeddings, scopes queries to selected files and reports readiness (`docs/examples/activepieces-main/packages/server/api/src/app/knowledge-base/knowledge-base.service.ts:21-81,106-145,211-235,294-300`). Its score tests verify arithmetic and filtering (`docs/examples/activepieces-main/packages/server/api/test/unit/app/knowledge-base/knowledge-base-service.test.ts:131-165`); they do not establish that answers cite the right evidence. Fixed character chunks and vector similarity are not epistemic authority.

Cerebro already has weighted BM25 with phrase/excerpt support (`src-tauri/src/search.rs:38-56,141-176`), a stat-keyed corpus, bounded graph expansion, and immutable assembly evidence. `search.rs:23-26` explicitly says tokenization cost beyond the demo corpus is unmeasured. No missing-search claim is justified. What is missing from the inspected paths is a representative relevance-and-scale acceptance corpus tying human queries to sources and their freshness/access constraints.

Build queries for paraphrase, exact facts, conflicting evidence, aliases, long documents beyond the 100 KiB search cap, imported material, revoked scope and unanswerable questions. Measure top-k source recall, grounded answer support, counterevidence coverage, inaccessible-source leakage and p50/p95 latency over small, medium and large generated vaults. Reuse AP-03 for answer-level judgments. Compare token caching or bounded query expansion first; prototype disposable embeddings only if measured misses justify them and no-key/local operation is preserved.

**Acceptance:** declared relevant sources and negative controls; zero scope leaks; unavailable/truncated reads remain explicit; renamed/changed/deleted files update correctly; a recorded baseline with machine/build/corpus identity. Any future cache is deletable and rebuildable from files; human verification and guarded knowledge writing remain unchanged.

## Implementation sequence and journeys

1. **Truthful inspection:** AP-01/02. The owner opens an old agent run, sees the correct vault and lineage, and can recover from a failed detail read. Exit on the targeted regression tests and state proofs.
2. **Proven execution:** AP-03 plus AP-07. The team can distinguish policy correctness, actual CLI behavior and model task success. Use these as the evidence gate for new autonomy.
3. **Explainable configuration:** AP-05, then deterministic AP-04 preview. A person changes instructions or a trigger and can see the concrete scope and the difference from a prior run before activation.
4. **Safe rehearsal and recovery:** the isolated AP-04 model phase and AP-06. A failed partial run can be inspected and reconciled without implying exactly-once outside effects.
5. **Connector and knowledge quality:** AP-08/09. A person can check a connector deliberately and assess whether an answer rests on the relevant accessible sources.

Every new read surface gets ready, empty, not recorded, partial and unavailable states. Reuse the agent page, Runs tab and existing Review queue; do not introduce another global control center or noisy Home counters. Keep the current Instrument Sans/IBM Plex Mono typography, rail/sidebar shell and full-height page-panel contract. Rust alone decides admission, grants and writes. Rehearsal and diagnostics must not become alternate mutation doors.

## Reference limitations and ideas to reject

The example's durable-execution documentation says only the in-flight step can be lost (`docs/examples/activepieces-main/docs/install/architecture/durable-execution.mdx:21-38`), while its reporter uses periodic 15-second snapshots (`docs/examples/activepieces-main/packages/server/engine/src/lib/helper/flow-run-progress-reporter.ts:19,33-41,93-125`). That is insufficient evidence for exactly-once side effects; a completed action and its persisted checkpoint can be separated by a crash. Likewise, its `flow-rerun.test.ts:41-67` tests successful retry outcomes but does not by itself prove prior external effects cannot repeat. Copy the explicit state model and adversarial test style, not a stronger durability claim than the boundary proves.

Do not import Redis/Postgres orchestration, provider credentials, automatic email sending, multi-tenant administration, or the visual flow canvas simply because the reference has them. Do not replace Cerebro's knowledge provenance, contradiction handling or human verification with vector relevance. Do not describe current staged UI improvements, approvals, crash recovery, BM25 search, or deterministic evaluation as absent. The improvements here extend their usefulness and prove their limits.
