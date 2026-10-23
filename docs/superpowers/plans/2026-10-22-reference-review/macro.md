# Macro reference review against Cerebro

Review date: 2026-10-22. Scope: the local `docs/examples/macro-main` snapshot,
compared with Cerebro's current working tree, including staged M84–M90 work.
Reference files were read as evidence; no reference dependencies, services or tests
were run. Findings below distinguish observed code from proposed behavior. Existing
test source establishes intended contracts, not a fresh passing test result.

## Assessment

Cerebro does not need Macro's service architecture or another shell redesign. Its
most valuable adaptations are precise source navigation, visibility into delegated
CLI work, an empirical retrieval-quality program, and operational views that remain
truthful when reads are partial. The current table performance and native acceptance
gaps deserve priority over adding another large product surface.

Macro is a much larger, networked product: its snapshot contains separate agent,
search, document, email, collaboration and infrastructure packages. Relevant ideas
can be implemented inside Cerebro's existing Rust/React boundaries without a server
fleet, hosted model credentials, CRDT replacement, or a second knowledge store.

### Provenance and reuse

`docs/examples/macro-main/LICENSE.txt:1–6` identifies GNU AGPL version 3. Its
`VERSION:1` says `v2026.4.28.0`. There is no `.git` entry at the snapshot root, so
that version is a file label, not a verified upstream commit. No upstream commit is
claimed. This review recommends independently implementing behavioral patterns;
copying source or assets would require a separate license decision. Vendored
dependencies may have their own licenses; the root license does not establish the
license of every nested asset.

### Five-topic comparison

| Topic                   | Macro implementation worth studying                                                                                                                  | Cerebro already has                                                                                                    | Residual opportunity                                                                                                |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Engineering and testing | Labeled duplicate-detection corpora, recall at production cutoff, judge variance; browser tests preserve editor node identity through remote changes | Shared Rust/TS cases, adversarial knowledge evals, sanitized CLI recordings, IPC contracts, five-state lab, cargo-deny | Add empirical quality measurements and native/scale acceptance; do not replace the existing tests                   |
| Architecture            | Pure fold, explicit storage/transport ports, presentation-only component rules, worker failure recovery                                              | Pure engine, four IPC adapters, one fold/reducer, receipted Rust writers, read-only operational queries                | Enforce narrow new feature boundaries and reduce composition hotspots incrementally                                 |
| UX/UI                   | Content-location citations, exact conversation targets, run metadata unavailable states                                                              | New rail/sidebar, stable floating assistant, page titles in editor, held drafts, keyboard catalog, panes               | Complete search-to-evidence journeys; fix bounded history claims; measure scale and native use                      |
| Agentic workflows       | Nested delegated-agent activity, versioned session projections and controls                                                                          | Ask-first dispatch, durable wakes, budgets/chains, queued writes, turn detach/reattach, run changesets                 | Show child activity and recorded limits without widening grants or creating a second orchestrator                   |
| Knowledge/retrieval     | Keyword multi-source search, separate semantic task dedup, experimental personalization                                                              | BM25, explicit entity/alias/graph retrieval, evidence manifests, contradiction handling, human verification            | Evaluate practical recall and reach original attachments deliberately; keep memory epistemics stronger than Macro's |

## Ranked findings and implementation plan

Effort assumes one engineer familiar with Cerebro, includes targeted tests and
review, and excludes unrelated cleanup: **S** roughly 1–3 days, **M** 4–10 days,
**L** 2–4 weeks. These are planning ranges, not delivery commitments. P0 is an
observed correctness problem, P1 strengthens core journeys, and P2 is a later
extension or maintainability investment.

### 1. Make an agent's run history complete about its scope and explicit about failed details

**P0 · observed correctness gap · S for the immediate repair, M with pagination.**

**Evidence.** Cerebro's `src/status/AgentRunHistory.tsx:23–47` requests
`fleetRuns({ limit: 200 })`, then `:60–76` filters that global page by actor and
can say “No runs recorded for this agent.” If 200 newer runs belong to other
actors, an older real run is invisible. The API already supports actor and vault
filters: `src-tauri/src/runtime/fleet.rs:43–56,271–308`. Detail loading at
`AgentRunHistory.tsx:29–34` collapses a failed read to `setOpen(null)` and has no
request identity, so a late detail response can replace the user's newer choice.

Macro keeps each unavailable run visible, retains its recorded outcome, and
disables navigation when metadata cannot be resolved:
`docs/examples/macro-main/apps/web/src/features/routines/views/routine-history.tsx:85–148`.
Its test explicitly covers unavailable and independently loading rows in
`routine-history.test.tsx:171–210` in that same directory.

**Journey.** A user opens a rarely used agent's Runs tab after a busy week. They
should see its own history, open an older run, and receive an actionable detail
error instead of an apparently inert click.

**Implementation.** Apply the actor filter before the SQL limit. Decide whether an
agent page is explicitly vault-scoped; the global fleet's existing cross-vault
meaning must remain intact. Fetch parent/child context separately or add a bounded
tree-aware read so actor filtering does not discard cross-actor hops. Represent
detail reads as keyed loading/ready/unavailable state, discard superseded replies,
and offer retry. Add a cursor and `has_more` or honest bounded-history wording;
the current filter has a limit but no cursor. Never equate a bounded page with all
recorded history.

**Acceptance.** Seed 201 newer unrelated runs plus one target run; the target is
shown. Preserve a cross-actor child and its parent attribution. Click A then B and
resolve A last: B remains selected. Detail failure shows `section-unavailable` and
retry. Empty, unavailable and truncated histories have distinct lab presets.
Dependencies: none beyond existing IPC/mock parity and operational read boundaries.

### 2. Navigate from an answer or search excerpt to the exact supporting content

**P1 · depth gap · M for Markdown, L including typed file locations.**

**Evidence.** Macro's citation conversion carries PDF page/rectangle coordinates
and Markdown node IDs in
`docs/examples/macro-main/apps/web/src/lib/core/component/LexicalMarkdown/citationsUtils.ts:129–177`.
Search results retain `goto.node_id`, highlights and raw content in
`docs/examples/macro-main/crates/search_service/src/api/search/document.rs:96–129`.
Cerebro already derives a source line or frontmatter field in
`src-tauri/src/search.rs:160–187`, but Quick Open displays marked text and opens
the page by path (`src/app/QuickOpen.tsx:138–151,654–690`). Assistant Markdown
supports wikilinks and safe web links, rather than typed evidence references
(`src/agent/MessageMarkdown.tsx:31–48,175–185`).

**Journey.** “What did we decide about renewal?” returns a paragraph from a long
page. One click should open and highlight that paragraph; the user should not
have to repeat the search inside the page before deciding whether to trust it.

**Implementation.** Introduce a pure source-location value with path, source
version/hash and a kind-specific location: body quote/line, property key, later
Office block/slide or PDF page. Carry it from search and bounded read tools through
the existing IPC adapter and navigation machinery. Resolve a location against the
current editor, including projected first-H1 titles, without moving or rewriting
Markdown. Prefer a checked quote plus surrounding text over persisting unstable
editor-generated IDs. If content moved, try bounded text relocation; if ambiguous
or changed, open the page and say the exact passage could not be located.

Expose the same navigation in concept source details and assistant citations.
References must name content actually returned by the tool; model-supplied strings
must never manufacture a “verified source” badge. External links still pass the
existing navigation guard. A source location is a reading target, not a write door.

**Acceptance.** Test repeated identical paragraphs, moved headings, changed files,
Unicode offsets, metadata hits, title projection, rename, missing file, and a file
already held in another pane. Modifier-open must respect one live editor per file.
Opening/highlighting writes nothing. Test native focus and VoiceOver announcement
of the focused passage. Dependencies: location contract and source-version policy
before UI wiring; attachment search in finding 7 reuses this contract.

### 3. Show delegated CLI work without granting it new authority

**P1 · missing observability depth · L.**

**Evidence.** Macro folds delegated calls under an explicit parent, reports unknown
parents instead of losing calls, and keeps child results and measured statistics:
`docs/examples/macro-main/crates/folds/agent_fold/src/domain/fold/subagent.rs:10–62,77–141`.
The Claude recording test proves the child's Bash call is nested and keeps its
result in `domain/test/subagent.rs:43–137` under that crate. Its UI exposes the brief,
bounded activity region and result in
`apps/web/src/features/block-agent/component/parts/SubagentToolCall.tsx:86–170`.

Cerebro intentionally skips sidechain lines in
`src-tauri/src/agent/fold.rs:23–49,71–75`.
`src-tauri/src/agent/cli_writes.rs:12–21` explicitly records that Task subagent writes
stay unseen. Existing Cerebro chain/hop history covers its own dispatched agent
runs; that is a different mechanism from children the user's Claude CLI delegates.

**Journey.** The user asks for parallel research. The parent says “reviewing three
areas,” but one helper is stuck. An expandable delegation row should show the
recorded brief, progress, failure and final result, with unrecorded values labeled
as such.

**Implementation.** First record and sanitize a pinned CLI delegation scenario with
the existing recording skill. Extend the existing fold/event vocabulary and
transcript reducer, with parent/run/tool identities and strict depth, byte and
child-count caps. Use only demonstrated CLI fields; orphan records remain visibly
unattributed. Read additional child transcripts only on demand through the existing
contained session reader. Preserve the rule that a subagent cannot answer a person's
approval. Display the source of each activity and whether it is complete.

Do not automatically add child paths to changesets from arbitrary text. A separate
attribution proof must establish completed writer calls and their containing run
before changing commit behavior. This work can initially ship as read-only
observability with “child file changes not recorded.” It does not add hosted agents,
new model credentials or autonomous scheduling.

**Acceptance.** Live and replay agree; interleaved children do not mix; duplicate
delivery is idempotent; unknown parent remains visible; absent duration/tokens stay
unknown. Test child failure, parent Stop, missing child file, continuation after
panel detach, and a child approval attempt. Existing run commit and connector
capture isolation tests must remain intact. Dependencies: sanitized CLI evidence
and bounded identity contract before implementation.

### 4. Measure retrieval and duplicate advice at the cutoff users actually see

**P1 · evaluation depth gap · M.**

**Evidence.** Macro's task-dedup eval explains why a correct match at rank 40 is a
miss when production keeps 24:
`docs/examples/macro-main/crates/task_dedup/tests/eval/cases/eval_recall_at_k.rs:1–12,109–127`.
Its offline corpus guards require multiple examples per scenario and preserve
undefined metrics for empty denominators (`eval_corpus.rs:11–67` in the same
directory). `eval_judge_variance.rs:1–13,25–68` separates model failures from actual
negative judgments and measures repeated boundary decisions.

Cerebro has meaningful adversarial knowledge evals, not an evaluation vacuum
(`src-tauri/src/eval/mod.rs:1–65`). It also already suggests similar records
(`src/app/RecordComposer.tsx:56–57,216–237`) and agent-created note duplicates.
The latter uses title ranking, same type or folder, and at most three candidates
(`src-tauri/src/mcp.rs:6468–6528`). Graph retrieval explicitly documents the
zero-shared-name paraphrase limitation (`src-tauri/src/retrieval/mod.rs:1–33`).

**Journey.** “Rotate the signing credentials” and “Replace the expired key used to
sign releases” should be evaluated as a possible duplicate, while “Rotate the
database credentials” must remain distinct. A retrieval improvement that finds more
similar-looking records but hides genuine differences is not progress.

**Implementation.** Add a project-owned, synthetic or explicitly approved labeled
corpus covering rephrasing, terse/detail pairs, same project/different action,
same action/different integration, aliases, contradictions, stale/imported sources,
denied folders and long documents. Measure recall at actual UI/tool limits,
precision of duplicate advice, counterevidence recall, false empty answers, latency
and bytes. Report results per scenario rather than one opaque “quality” score.
Start with the existing BM25 and graph retrievers. Use the existing CLI only for
optional repeated synthesis evaluations, recording model/version, corpus hash,
prompt/grant hash, failures and cost.

Macro's general content search is explicitly keyword search
(`crates/ai_tools/src/search/search_service/content.rs:19–38`); its separate task
dedup uses OpenAI embeddings, pgvector and Cohere
(`crates/task_dedup/src/lib.rs:13–32`). Neither proves Cerebro needs a vector store.
Only a measured, important residual recall failure should motivate a separate
local-model or explicit connector experiment. Do not mutate the deterministic
knowledge receipt retriever behind its version contract.

**Acceptance.** Offline corpus validity and deterministic baselines run in CI;
live CLI evaluations remain separately invoked. Publish misses and uncertainty,
count unavailable judgments, and require a reviewed baseline before ratcheting.
Never auto-merge records or promote a concept on a similarity score. Dependencies:
none for corpus work; later retrieval changes depend on this evidence.

### 5. Close scale and native UX acceptance before extending heavy surfaces

**P1 · observed table limitation plus transcript/native validation gaps · M–L.**

**Evidence.** Cerebro's current implementation record is explicit:
`docs/superpowers/plans/2026-10-17-m84-m90-implementation-record.md:95–132` records
398.8 ms p95 at 1,000×12, 1,376.2 ms at 1,000×24, and a navigation timeout at
5,000×12. These are production headless Chromium diagnostics on a shared machine,
not native timings. Containment was removed after an offscreen record disappeared
from the accessibility tree. Native IME, VoiceOver, focus, clipboard/drop and quit
acceptance remain open. The new shell and typography have already shipped into the
working tree; their redesign is not this recommendation.

Macro isolates fold work in one lazy worker, serializes updates and recovers worker
startup failure (`docs/examples/macro-main/apps/web/src/lib/core/agent-fold/client.ts:55–115,132–175`;
`fold.worker.ts:24–36,79–96`). Tests cover lazy initialization and retry
(`client.test.ts:35–94`). Cerebro already folds raw CLI data in Rust; importing
Macro's WASM fold would duplicate a solved boundary. The remaining main-thread
work includes React message rendering (`src/agent/AiPanel.tsx:1559–1580`) and
per-stream Markdown parsing (`src/agent/MessageMarkdown.tsx:25–28`).

**Journey.** Typing in a large database while a long assistant thread streams must
remain responsive, and a person using VoiceOver must still reach the last record.

**Implementation.** Profile scan/read, row derivation, render, layout and transcript
parsing separately on the production build. Reuse the existing large-table
fixtures and add bounded long-conversation fixtures. Optimize the measured phase:
stable row props, cached pure derivations, batched streaming commits, incremental
Markdown work or lazy old-turn expansion before architectural migration. Consider
pagination/windowing only with explicit keyboard, find, accessibility, drafts and
scroll restoration behavior. Macro's inspected database table is not evidence that
it solved virtualization: it renders its row model and supplies grid semantics
(`apps/web/src/features/database/components/database-table.tsx:149–154,494–531,637–640`).

**Acceptance.** Close the recorded <100 ms input/<50 ms warmed-task targets where
specified, or explicitly report remaining failure. Require matching corpus/build/
machine-load conditions for comparisons. Combine 1,000/5,000-record cases with
streaming, source jumping and open editors. Keep offscreen accessibility and browser
find proofs; run actual WKWebView IME/VoiceOver and pending-save quit acceptance.
Dependencies: instrumented baseline first; findings 2, 3 and 6 add stress cases.

### 6. Search remembered conversations and open the matching turn

**P2 · missing user-facing capability with deliberate retention constraints · M.**

**Evidence.** Macro's search snapshot uses the same folded messages the transcript
renders and distinguishes missing sessions from storage failures
(`docs/examples/macro-main/crates/agent_session/src/domain/search/indexing.rs:22–42`).
Its database test proves searchable folded text and deletion behavior
(`src/outbound/postgres/test/search.rs:14–55` in that crate). Exact turn/author
navigation is encoded in
`apps/web/src/features/block-agent/core/search-location.ts:1–30`.

Cerebro's conversation switcher groups and renames threads but does not provide
message search (`src/agent/ConversationSwitcher.tsx:8–20,48–57,110–133`). Its
local cache deliberately keeps only 30 conversations, and transcripts remain the
CLI's source (`src/agent/conversations.ts:6–23,337–345`). Run transcripts are read
on demand and kept only in component memory
(`src/status/RunTranscript.tsx:10–25,38–44`).

**Journey.** “Where did the assistant explain the launch risk?” searches remembered
threads, shows a snippet and opens the exact exchange, without turning generated
answers into knowledge evidence.

**Implementation.** Begin with local cached thread titles/messages and a clear
“remembered conversations” scope. Extend the switcher/Assistant canvas with a
bounded search and stable message target; keep navigation through its existing
instance. If older sessions are offered later, search only on explicit request,
through the one Rust reader/fold, bounded by session/byte/time caps. Explain expired
or unreadable CLI sessions. Do not silently enlarge retention, persist another
transcript copy or add assistant output to vault search/ingestion.

**Acceptance.** Exact-turn focus survives reload, streaming append and presentation
changes; deleted threads disappear; searching an expired session reports that
limit; vault-scoped results do not leak another vault. Search leaves live turns and
drafts intact. Dependencies: current conversation identity/retention rules and the
performance baseline in finding 5.

### 7. Offer bounded search inside original attachments when the user asks for it

**P2 · conditional capability expansion · L.**

**Evidence.** Macro content search spans document bodies and returns per-content
locations (`crates/ai_tools/src/search/search_service/content.rs:19–38` and
`crates/search_service/src/api/search/document.rs:96–129`, under the Macro root).
Cerebro's corpus explicitly contains notes and their bounded bodies
(`src-tauri/src/vault/corpus.rs:1–18,29–55`); original Office attachments have a
separate scoped reader (`src-tauri/src/files/read.rs:1–17,703–740`). Existing imported
Markdown captures can already participate in note search. The gap is finding text
inside an original attachment whose filename is not already known.

**Journey.** “Find the slide with the migration deadline in this project's
attachments.” The result should name the source file and slide and distinguish an
unsupported/encrypted/unreadable file from a searched file with no match.

**Implementation.** Prototype an explicitly invoked “Search attachments” scope over
supported Office formats first, reusing contained file handles, package limits and
extractors. Add a disposable, bounded extraction cache keyed by file identity and
extractor version; file bytes remain authoritative. Apply read scope before
extraction and again before result delivery. Return searched/skipped/failed counts
and truncation reasons. Reuse finding 2's location contract. PDF search would need
its own reviewed extraction boundary; the existing viewer does not itself justify
an agent PDF reader. Do not ingest originals automatically, follow symlinks outside
roots, or expand mail's gate.

**Acceptance.** Changed/deleted files invalidate results; denied roots produce no
content or existence leak; malformed archives stay within existing limits; imports
and originals are clearly labeled without duplicated authority. Query cancellation
and vault switching bound the work. Dependencies: findings 2 and 4, plus a demonstrated
attachment-discovery demand before expanding the format set.

### 8. Extend architecture enforcement at new seams, not by rewriting the monolith

**P2 · maintainability depth gap · M, incremental.**

**Evidence.** Macro defines agent connector/directory ports
(`crates/agent_session/src/domain/ports.rs:20–29,80–98`) and AST rules that constrain
domain-to-adapter imports and presentation-to-data imports
(`rules/ast-grep/rust-domain-no-adapter-imports.yml:1–30`;
`tsx-feature-components-presentational.yml:5–14,46–81`, under the Macro root).
The rules are warnings and list exceptions; their presence alone does not prove
all legacy code obeys them.

Cerebro already has stronger targeted rails than a generic “add clean architecture”
recommendation implies (`eslint.config.js:6–51,72–92`). Its growing composition
hotspots are real: the inspected `AiPanel.tsx` is 1,866 lines, `TableView.tsx` 3,489,
and `mcp.rs` 20,889 including tests. File size is a navigation/ownership signal,
not evidence of broken behavior.

**Implementation.** Extract only seams exercised by the work above: run-history
query state, source-location resolution, child transcript projection, and long-turn
rendering. Keep pure decisions in engine/Rust domain modules, rendering in small
components, and side effects at the existing adapters/guards. Add enforceable rules
for these new modules using the current ESLint/rail test infrastructure before
adding another rule engine. Keep exceptions explicit and tested. Do not move
guards away from the lock or duplicate policy tables while making files smaller.

**Acceptance.** New modules reject store/IPC/DOM imports where inappropriate;
presentation tests require no live IPC; Rust adapters cannot mint new receipts;
existing IPC/manifest/parity tests pass unchanged in meaning. Each extraction lands
with a concrete feature or measured concern, not a broad directory migration.
Dependencies: use findings 1–3 as initial seam owners.

## Patterns to preserve and patterns to decline

Preserve Cerebro's stronger provenance and authority model. Macro's memory generator
researches personal workspace content, regenerates after one day, judges with a
second model and saves accepted text
(`docs/examples/macro-main/crates/memory/src/domain/service.rs:14–46,100–148,204–219`).
That is not human verification. Cerebro already separates human corrections, agent
notes and provenance-bearing concepts (`src/library/AgentMemoryTab.tsx:12–42,46–55`).
Do not introduce a silent personal profile, background Home synthesis, or model
judgments that become verified knowledge.

Do not copy failure-to-empty shortcuts. Macro citation lookup sometimes returns an
empty string/undefined on failure (`citationsUtils.ts:19–28,129–163`); document
enrichment falls back to empty properties (`search/document.rs:63–86`). Its duplicate
judge returns “not duplicate” on provider failure
(`crates/task_dedup/src/outbound/judge.rs:39–42,71–76,118–127`). Cerebro's explicit
unavailable states should survive every adaptation.

Retain existing editor/approval behavior. Macro's held-row and browser-node-identity
tests are useful acceptance examples, but Cerebro already freezes the input set
during active drafts (`src/views/TableView.tsx:2116–2137`). Approval cancellation,
new-conversation detachment and stale responses already have explicit coverage
(`src/agent/useAgentChat.test.tsx:1811–1897`). Likewise cargo-deny, one fold/reducer,
run changesets, typed tool policy, panes, side panels and a floating assistant are
existing capabilities, not proposed additions.

## Suggested execution order

1. **Truth and measurement:** repair finding 1; establish retrieval corpus and
   production/native acceptance baselines from findings 4–5. These can run in
   parallel and should not wait for a new feature architecture.
2. **Evidence journey:** implement Markdown locations from finding 2, then source
   details and exact-turn conversation search. Use these features to exercise the
   narrow module boundaries in finding 8.
3. **Agent transparency:** prove a real pinned CLI child trace, then implement
   finding 3 without changing authority. Separately review whether enough evidence
   exists to extend changeset attribution.
4. **Conditional discovery:** use measured misses to decide whether attachment
   search or additional retrieval methods justify their cost. Keep the first
   release bounded to existing extraction capabilities.

The release decision should be based on successful user journeys and explicit
remaining limits: find a source and verify it, recover an old answer, understand
what each helper did, inspect a run despite partial failures, and edit a large
workspace without losing responsiveness or accessibility.
