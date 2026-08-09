# Convergent Intelligence Overhaul — Master Roadmap (M21–M28+)

Source: `Cerebro_Final_Comprehensive_Spec.pdf` ("Convergent Project Intelligence System"),
stress-tested against the actual codebase by a 9-agent recon (5 subsystem maps, 4
adversarial critiques) on 2026-08-07. This doc is the synthesis: what the spec gets
right, where it breaks against this product, the architecture decisions that resolve
the collisions, and the milestone sequence. Each milestone gets its own detailed plan
doc when it starts, per house convention.

**Rev 2 (2026-08-07)** — amended per owner review verdict. The eight accepted
amendments: (1) drop the pseudo-HLC — v1 canonical ordering is the monotonic
sequence alone (D3); (2) preserve observation subtypes from day one even inside one
persisted object (D7); (3) split human input into review-attestation vs
firsthand-assertion channels (D8); (4) model actor authority early, defer only
cross-source policy (D11); (5) semantic materiality is not fully deterministic —
Rust filters the obvious, the LLM judges residual ambiguity (D6); (6) the
deterministic fetcher is the Source Monitor; Pattern Scout is a separate deferred
capability (D6, M28+); (7) operational state never pollutes the epistemic ledger
(D5, M25); (8) scope/stage resolution precedes contradiction reasoning — intended
vs observed reality is an explicit model (D12, M27). Plus refinements: a precise
segment-commit invariant and machine-specific segment identity (D2), honest
git-anchoring language (D2), full atomic-write discipline (M21),
Support/Coverage/Validity naming (D9), structured retrieval adequacy (its own
section), and multi-dimensional budgets beyond run counts (M25/M26).

**Rev 3 (2026-08-08)** — freeze-blocker correction pass across M22–M28. The
review found several places where a requirement was named but its primitive was
not actually representable. This revision adds: discriminated Observation
bodies with portable trusted source registration, non-forgeable authority
provenance, and unresolved subjects; explicit Observation→Belief support and
produced positive-independence records; a crash-safe
logical-batch commit shared by capture and proposals; restart-idempotent
migration and canonical identity rules; a complete structured Proposal contract
with atomic lifecycle transitions and mutable-precondition revalidation;
vault-scoped runtime state with crash-safe leases/reservations and uncollapsed
coverage; total receipt-backed routing for every materiality verdict; preventive
self-ancestry enforcement before the M26 default-on flip; closed synthesis,
resolver, cost, and discovery-plan contracts; orthogonal, replay-stable belief
dynamics; and reproducible measurable or explicitly discretionary M28 triggers.
These are corrections to the accepted architecture, not an ontology expansion.

**Full requirement traceability** lives in the companion doc
`2026-08-07-cerebro-spec-coverage.md` — every numbered section of the source
spec (§1–§98) mapped to a disposition (milestone / deferred-with-trigger /
principle / cut-with-rationale). This roadmap is the architecture; that matrix
is the proof nothing was silently dropped. **Matrix Rev 2** pulled ten
foundational primitives forward from M28+ into M22–M27; **Matrix Rev 3** made
their representations and handoffs executable without adding product surfaces.
Both follow the rule *persist the primitive early when retrofitting would be
painful; defer the rich consumer until it earns itself*. The milestone sections
below reflect those pulls and corrections; the matrix records each one.

## Verdict

The spec's epistemics are sound and much of it is *already this codebase's doctrine
generalized* — `write_concept` server-stamping `generated:{by,at}` and refusing
`verified` (mcp.rs:917) is the seed of the whole Policy layer; `verify_concept`'s
append-only stamp (okf.ts:767) is the seed of human-assertion capture; the jobs.ts
ranked lanes are the seed of the scheduler. But four of its assumptions are false for
this product and must be re-founded, not implemented:

1. **It assumes a transaction substrate that does not exist.** Every write is a bare
   `std::fs::write` (write.rs:63) — no temp+rename, no fsync, no version token
   anywhere (grep: zero `expected_version` in the repo). A crash mid-write truncates a
   note. knowledge/log.md, the closest thing to a ledger, is rewritten whole per
   insert (knowledge.rs:244-294). "Stamped inside the transaction" is meaningless
   until a transaction exists.
2. **It assumes an org-scale runtime.** Ten LLM roles × 9 phases per source event,
   on-by-default, against the user's *personal Claude CLI subscription* (the app has
   no API key by design) is 10–30M tokens/day naive — quota death by mid-morning.
   And the app can't even measure spend today: usage fields in the CLI's stream-json
   result events are discarded on the wire (agent.rs:33/768).
3. **It assumes canonical-DB-with-projections wholesale.** Applied naively that
   converts the whole vault and kills the product's identity ("the vault on disk is
   the source of truth"), blinds the working agent (the CLI reads files from
   cwd=vault, agent.rs:747), and breaks the shipped trust ritual (git review of agent
   writes — the stated reason git exists here, commit.rs:9-21).
4. **It promises immutability no local-first single-user app can deliver.** The user
   owns the disk. rm -rf, sqlite3, vim, Time Machine restores, and history rewrites
   (the 2026-08-01 wipe-commit was real) are one command away. Sold as "immutable,"
   the first restore that diverges the ledger makes the product's core claim false.

None of these are fatal to the spec's *intent*. They dictate the shape below.

## Architecture decisions (settled, not options)

### D1. Two-plane split — files-first survives for the human plane only
- **Vault plane** (records/, docs/, types/, views, lists): canonical markdown
  forever. External editors stay first-class. Whole-vault DB conversion is
  *rejected*, not deferred.
- **Epistemic plane** (knowledge/, sources/, and all new evidence/belief state):
  event-sourced. The existing knowledge/*.md files become deterministic generated
  **projections** — the exact subtree that is already machine-written and
  human-read-only (guard_human_write already refuses knowledge/ at IPC). The
  inversion lands where the product already ceded authorship to the machine.

### D2. Ledger in the vault, index in app-data
- Canonical record: **hash-chained, append-only NDJSON segments** at
  `<vault>/.cerebro/ledger/` — write-once sealed segments. Travels with the vault
  so a Time Machine restore rewinds files *and* history coherently; sealed
  segments make cloud-sync conflicts detectable and *diagnosable* (not
  auto-mergeable — see segment identity below).
- **The segment commit protocol is specified, not hand-waved** — crash-safe
  append-only logs are deceptively nasty. M21 defines: open vs sealed segment
  states; per-record framing (length + payload + record hash chaining to the
  predecessor); segment naming encoding store UUID + writer UUID + sequence
  range; a segment-level checksum at seal; directory fsync on segment
  create/seal/rename; and recovery rules for a half-written tail. The commit
  invariant: **only complete, hash-valid records before the first malformed
  trailing record are committed** — never "whatever made it into the file." An
  event is acknowledged (and visible to anything downstream) only after its frame
  is fully written and fsync'd.
- **Multi-event logical batches are explicit.** M22 adds an optional `batch_id`
  to v1 bodies plus a core-stamped `batch.committed` marker. Frames in an
  uncommitted batch remain durable but reducer-invisible; `append_batch`
  acknowledges only after the marker is fsync'd. A torn batch is ignored on
  replay and may be retried idempotently. This is the atomicity primitive used
  by M23 assertion+revision capture and M24 proposal commits; neither milestone
  may pretend a series of individually committed frames is transactional.
- **CAS versions are reducer-owned across target classes.** M22 materializes a
  stable `(target_class, target_id)` version registry for Observations, Beliefs,
  Entities, relations, and sources; M24 adds proposals and M26 adds
  comparisons. Producers never stamp version truth. An accepted batch checks
  one pre-batch snapshot and then folds its named targets in order.
- **Segment identity is machine-specific from day one** (store UUID + writer UUID
  + seq range + segment hash), even though v1 is single-writer — so an accidental
  foreign fork ("segment-000010 conflicted copy.ndjson" from a second Mac) is
  diagnosable rather than ambiguous, even though it is never auto-merged.
- Query engine: **disposable SQLite (WAL) materialized index in app-data** —
  rebuildable from segments, never synced, never authoritative. SQLite never lives
  inside a possibly-cloud-synced vault (WAL + sync = corruption).
- **Not git-tracked.** The `.cerebro/` blanket ignore and its `rm --cached`
  self-heal (commit.rs:21,47-50 — exists because connectors.json holds credentials)
  stand unchanged. Every checkpoint commit message embeds the ledger chain-head
  hash so git cross-attests the ledger — stated honestly: **git provides periodic
  independent anchoring, not continuous rollback detection.** A restore landing
  between anchors (head 125 restored, last anchor at 100) is not provable from
  git alone. The app-data index also remembers the latest-seen head as a
  secondary anchor — with the caveat that Time Machine / machine migration can
  rewind app-data too. Anchoring is layered best-effort corroboration, never a
  guarantee.

### D3. "Immutable system times" — the honest, enforceable definition
- **No HLC in v1** — a hybrid logical clock for a single-writer store is
  architecture cosplay. Canonical ordering = the **persisted monotonic sequence**
  assigned by the Rust core inside the append; that is the whole ordering story.
  Each event also stores `ingested_at` (wall clock — display/temporal context
  only; today's sole stamping site is `chrono::Utc::now()` at *seconds*
  precision, mcp.rs:984) and a `wall_clock_anomaly` flag set on regression vs the
  previous event (recorded, never smoothed over). Event time = what the source
  says occurred (agent-supplied, labeled). Valid time = when the claim applies.
  A true HLC arrives if and when a second writer ever exists — not before.
- **Enforced against all in-app actors by construction**: exactly one Rust module
  can append; no code path exists that updates or deletes an event; agents cannot
  supply system times (extends the generated.by house rule — "an agent that could
  choose its own generated.by could disclaim its own output").
- **Tamper-EVIDENT against the disk's owner**: hash chain + git-anchored head +
  fork detection on open + single-writer lockfile. Product language says
  "tamper-evident ledger," never "immutable." v1 is per-machine authoritative;
  a foreign ledger (different store UUID) requires explicit adopt-and-reingest;
  multi-master merge is declared out of scope.
- Launch reconciliation has a **circuit breaker**: chain-head regression vs the
  last git-anchored head, or a mass projection mismatch (restore signature),
  records ONE divergence event and enters explicit reconciliation mode — never a
  storm of false human_assertions into an append-only record.

### D4. Projection sync is manifest-driven; human edits become assertions
- A projection manifest (path → content hash → projection head + dependency
  digest) is the *sole*
  self-write recognition mechanism. The watcher's 4-second time-window own-write
  suppression (watcher.rs:14) is unsound for capture (regeneration bursts >4s and
  FSEvents overflow both misclassify) — it survives only as a UI-refresh
  optimization. Suppression decisions are made by hash comparison, ever.
- Two capture paths, strict priority: **in-app edits emit typed human assertions,
  the resulting Belief revision, and any exact relation/alias effects in one
  committed logical batch at the IPC boundary** (the app knows
  target/actor/field/effect/before/after — no inference);
  the watcher/hash-diff path covers only out-of-band editors.
  Catch-up on launch is always scan+hash-diff against the manifest — **mtime is
  never evidence** (fs timestamps are destroyed by git checkout, sync, restore;
  scan.rs:36-41).
- guard_human_write's successor is a **capture valve**, not a wall: in-app edits to
  projections transform into atomic assertion+revision capture batches
  (`verify_concept` is the separate attestation channel); refusal survives only
  for edits that cannot be represented safely, such as forged provenance stamps.
- **Not every human edit is an assertion.** Changing `AMD` to `NVIDIA` in a
  projected belief is epistemic; reordering the words or fixing "Manufactring" is
  editorial. Capture classifies: **structured epistemic edits** (a value in a
  structured field, a status, a relation) become human assertions;
  **presentation/body rewrites** become projection overrides / annotations / a
  proposed-rewrite card — recorded, but never entering epistemic history as
  claims. This matters most on the out-of-band path where intent must be
  inferred: field-level diffs classify mechanically; prose diffs default to
  editorial unless they alter extracted claim text. Otherwise the ledger fills
  with "the user asserted that the comma moves three characters to the left."
- Reconciliation compares **three states**, never only file vs manifest:
  current file bytes, manifest revision/hash, and reducer-current belief
  revision. Ledger-ahead regenerates even when file and stale manifest still
  match. `accept-current-files` first translates every accepted diff into a
  committed assertion+revision or projection-override batch; it never merely
  re-baselines bytes that canonical ledger state cannot reproduce.
- Projections are byte-stable deterministic functions of ledger state, so the git
  diff of a projection IS the human review artifact — the trust ritual survives.

### D5. Proposals, policy, and versions
- expected_version is a **ledger-entity concept, never a file concept**. File mtime
  is never a version token. Vault-plane files stay last-write-wins.
- Proposals travel **exclusively as serde-validated MCP tool calls** — never stdout
  JSON (agent.rs:768 silently skips unparseable lines; an invalid proposal must be
  a typed in-session tool error the model can retry against, bounded). Proposals
  accumulate server-side and apply through D2's logical-batch protocol on a
  terminal commit call: a run that dies mid-stream (quota death) applies
  nothing reducer-visible.
- The proposal contract is structured enough for policy to be mechanical:
  `proposal_id`, `run_id`, `targets[]` with per-target `expected_version`, a
  discriminated op payload, `declared_risk`, `intended_use`, structured `basis`
  (transition cause + evidence/coverage references), and human-readable
  `reason`. Create/update payloads also carry M22's complete BeliefBasis so
  evidence roles and unsupported state survive policy; a basis-only revision is
  the canonical zero-field corroboration mutation. Create ops additionally
  carry a candidate-search receipt. Silence,
  absence, authority, and high-stakes checks never parse free-form prose.
- The op inventory maps to exact mutation event plans—qualification, lifecycle,
  contest, alias/relation, split/merge, tombstone, and forward inverse—not an
  unnamed JSON escape hatch. A mixed-risk terminal set is all-or-nothing: if
  one member needs human review, every member is queued under one commit-set ID
  until all required approvals and a fresh whole-set CAS check succeed.
- A **separate submitProposal channel** returns typed
  `applied {proposal_id, resulting_versions} | queued {proposal_id} | rejected
  {proposal_id, code, rule, expected, actual}` results. The
  store-layer never-throw invariant is re-scoped in AGENTS.md to human-UI actions
  only.
- **Two records, two destinies.** The epistemic ledger receives: valid proposals,
  applied mutations, *meaningful* policy rejections ("agent attempted to
  supersede a human-reviewed belief without sufficient verification" — that is
  epistemic history, and Skeptic food), and human decisions. The **operational
  log** (app-data runtime DB — instantiated in M24 for rejection routing, full
  schema owned by M25) receives: schema mistakes
  (`confidence: "banana"`), malformed MCP arguments, CAS races during internal
  retries, timeouts, quota failures. Otherwise the append-only epistemic ledger
  becomes "Claude forgot a required field 92,000 times" — server logs,
  reinvented.
- **Policy is data, not code**: one declarative table (op, target class, max
  auto-apply risk, allowed transitions, qualification profiles) loaded by Rust and
  imported verbatim by the TS mock; parity = byte-identical table + shared golden
  proposal→verdict fixtures. Hand-mirrored policy code will drift — the project
  already parses mcp.rs from a TS test to hold a 12-tool parity; that does not
  scale. CAS/transaction semantics are explicitly out of mock scope (Rust-tested
  only). Escape hatch if interpreter drift appears: compile the Rust policy crate
  to WASM for the mock.
- Queued HIGH/CRITICAL proposals, human decisions, stale-version refusals, and
  reverts are durable reducer state. A revert is a new forward mutation with
  current expected versions, never deletion of history. The minimal review
  queue and one-click revert ship with the policy skeleton, before agents are
  enabled.
- **Risk ladder** (the shared versioned policy artifact; agent-declared risk can
  only RAISE): LOW auto-apply+journal; MEDIUM auto+journal with a one-click
  forward inverse only where the op's closed inverse mapping exists; HIGH queues
  a human card; CRITICAL queues a diff review. The artifact owns each op's exact
  base risk, legal transitions, rejection destiny, reversibility, and target
  classes. A write-target-style tripwire (mcp.rs:1362) ensures no constructible
  op, nested payload, or canonical event expansion ships unmapped.

### D6. The ten roles collapse into three runtime constructs + two Rust services
- **Ingest pass** — Observer+Extractor+Resolver+Proposer as ONE batched CLI run per
  settled change-window (not per file, not per role).
- **Maintenance pass** — Reconciler+Temporal as ONE scheduled run extending
  the existing jobs.ts lanes (which already are this scheduler). Curiosity and
  the independently retrieving Skeptic are deferred additions behind M28
  triggers; they are not hidden inside the M26 pass.
- **Query-time assembly** — Context Assembler + Synthesizer + the
  retrieval-adequacy and evidence-sufficiency assessments (two outputs, never
  merged), attended-only, pay-per-use.
- **Attention and the Source Monitor are deterministic Rust services**, not LLM
  roles. The Source Monitor — refetch stale cached sources on launch/timer,
  hash-compare, only changed hashes create ingest work — is deliberately NOT
  named Scout: the spec's Scout means "detect a genuinely novel pattern the
  existing model does not explain," which is a deferred LLM capability
  (**Pattern Scout**, M28+). Names must not lie about responsibilities.
- The LLM/Rust boundary is a principle, not an enumerated constitution: **never
  spend an LLM token where deterministic logic can answer correctly — and never
  pretend Rust can answer a semantic question.** Rust owns obvious-no-change
  filtering, hash dedup, schema comparison, known deterministic transitions,
  policy, stamping, staleness/decay timers, lineage bookkeeping, independence
  quorums, lane ranking. The LLM owns assertion extraction, genuinely ambiguous
  resolution, synthesis prose — and **semantic materiality where ambiguity
  remains**: "Factory C passed qualification but Factory D failed and global
  production requires both" is a qualification_status change Rust can diff, but
  whether it reshapes rollout risk is semantic judgment.
- Source content receives **no instructional or direct mutation authority**, but
  this is containment, not
  a claim that prompt injection is perfectly detectable. Source-derived
  proposals are source-tainted, must cite their Observation basis, cannot lower
  table risk, and can mutate only through policy. Detection remains heuristic
  telemetry; adversarial tests include syntactically valid LOW-risk proposals,
  because schema validity alone does not prove instructional provenance.
- Ambient spend capped **by construction at ~10–20 CLI runs/day**; background LLM
  concurrency stays 1 inside MAX_CONCURRENT_RUNS=4 so chat always has headroom.
  Quota exhaustion is modeled as reasoning-runtime health (distinct from source
  health, per the §86 split M25 enforces): un-consume the job ledger, backoff
  keyed to the 5-hour window, visible blindness banner — never silence
  (today a failed run is recorded 'failed' and forgotten, useJobRunner.ts:405-409).

### D7. Phase-1 ontology is FOUR objects — the rest wait for named consumers
**Event, Observation, Belief** (absorbing today's Concept, gaining revision chain +
attestation events), **Proposal**. Observation stays ONE persisted,
content-addressed, immutable object, but uses a **discriminated body per
`observation_kind`** from day one: `source_snapshot | extracted_assertion |
human_assertion | system_event | derived_content`. `assertion_kind` exists only
on assertion variants; snapshots and system events never fabricate assertions.
Every Observation has a stable `source_id` and pins a portable
`source.registered` event whose closed origin/capability/actor binding lets the
core derive `trusted_human_capture | registered_direct_artifact |
agent_inferred`; callers cannot promote their own authority. Its subject is
explicitly `resolved | unresolved | none` so M26 can park ambiguity without
inventing an entity. Assertion variants carry a typed predicate/value/scope
comparison unit; human field edits additionally carry target belief, field
path, and typed before/after values. This preserves `source_artifact_hash`, `extractor_version`,
`extracted_text`, and `raw_pointer` — because "Alice posted
exactly: 'Looks like Falcon C finally went AMD'" (what the source contained) and
"Falcon Rev C may have migrated to AMD" (what the model took it to mean) must
never blur, and retrofitting that provenance later is the painful kind of
migration. Separate *tables* for SourceArtifact/Observation/ExtractedAssertion
wait for the **claim-granularity Resolver** — M26's basic entity resolver is
NOT it; the *distinction* does not wait. Deferred behind explicit triggers:
Claims-as-objects (when the claim-granularity Resolver ships — a trigger the
M26 entity resolver does not satisfy), Issues/Risks/Actions/Decisions as
epistemic objects (they stay
vault records; qualification gates bind as capability profiles via Type-doc field
role annotations — never type names), Assumptions/Discovery/Causal-hypotheses/
Forecasts (each when an agent exists to consume it). Building all thirteen up front
recreates the garbage-drawer failure the spec itself decries — nine concept files
of corpus do not need per-assertion granularity.

`source.registered` is Event vocabulary and an identity/capability primitive,
not a fifth mutable product object. Its migration-only `legacy_reference`
variant is always content-only: it preserves a canonical imported resource
without claiming connector health, authority, or independence.

Belief revisions explicitly name their basis Observations and current support
set; an unsupported draft is representable rather than mislabeled
"single-source." The reducer materializes per-revision support edges. A separate
positive independence record is the only path to `known_independent`. M25's
trusted deterministic firsthand/direct-artifact rules and M24's HIGH
human-confirmed path emit that same auditable record; lack of a
lineage edge always remains `independence_unknown`.

### D8. Concept mapping (fixed)
A verified concept becomes a **Belief** (its markdown file becomes the projection)
PLUS a **human attestation event pinned to the reviewed revision event ID and
matching content hash**.
Attestation feeds review status (and only predicate-policy-authorized freshness),
never Support, and is structurally excluded from
evidence lineage (else the system's own synthesis gets reinforced by a human
reviewing that synthesis — the self-ancestry violation). Projection renders
"verified at r3; current is r5 — attestation predates revision" instead of today's
silent destruction (write_concept never copies `verified`; a human-reviewed concept
reverts to unverified on any agent revision with no record). Parseable
`sources[]` entries migrate as content-only `legacy_reference` registrations plus
**unsnapshotted-reference events** keyed by their canonical resource — no git
archaeology to fabricate provenance, and the complete legacy source object stays
in Belief fields for byte-stable projection;
only post-migration ingests get true content-addressed Observations.
supersedes/refines/contradicts become belief-relation events. Migrated events
carry typed migrator provenance through `actor: system:migrator`, deterministic
`migrate-v1:` idempotency keys, original event time, and migration-time
`ingested_at`, so temporal reasoning never mistakes migration day for a burst of
learning.

**Human input has TWO channels, modeled explicitly.**
`belief.attested` (the human-review-attestation channel) — "I reviewed Cerebro's
synthesis and approve it" —
feeds a separate review-status signal and may inform freshness only where a
predicate policy explicitly permits it; it never feeds Support and is
structurally excluded from evidence lineage
(prevents the loop: AI writes belief → human clicks Verify → verification becomes
evidence for the belief). `human_assertion` with `assertion_basis: firsthand` — "I'm the hardware lead; I
physically reviewed the shipping BOM this morning; Rev C is AMD" — is **new
evidence**: it enters lineage as a human-origin root observation
(observation_kind: human_assertion) carrying the D11 authority metadata
(relationship_to_subject, assertion_basis: firsthand). Review never reinforces
lineage; firsthand knowledge does.

### D9. Support / Coverage / Validity — the split survives; "confidence" does not
Three primary headings rendered as chips — and only the first resembles
confidence. The model underneath is deliberately orthogonal:
- **Support**: unsupported / single-source / corroborated /
  authoritative-for-predicate-and-stage — derived from explicit support edges,
  positive independence records, and D11 policy rather than agent assertion.
- **Coverage**: observed / partial / blind.
- **Validity** is a structured bundle, not one enum: freshness
  (`fresh | stale | unknown`), conflict (`clear | contested`), and lifecycle
  (`active | superseded | archived | tombstoned`). A belief may therefore be
  stale **and** contested; supersession never erases its prior freshness or
  conflict history. Human-review attestation derives a separate
  `unreviewed | current | predates_current` ReviewStatus and renders separately
  from Support.
Surfaces may compose a human-readable conclusion ("moderately supported, partial
coverage, fresh"). Floats and calibration curves are **cut, not deferred** —
"signals, never a score" (okf.ts:14-18) stands; one user can never generate
calibration volume.

### D10. Cuts and hard deferrals (explicit)
ACL propagation through derived beliefs (one human; actor stamps on events ARE the
access record; RunGrant is already the complete model) · **cross-source**
verification policies (deferred until ≥2 live connectors — actor authority is NOT
deferred; see D11) · numeric confidence + product metrics *dashboards* (the
engineering epistemic eval suite — golden scenarios regression-testing false
creation/merge, missed contradictions, stale truth, ancestry reinforcement,
critical-attention misses — is NOT cut, and ordinal calibration of future
Forecast labels is never constitutionally banned; only fake numeric precision
is) ·
git-as-system-time-ledger (idle-heuristic cadence, silent failures, app-closed gaps,
user-clock timestamps — corroboration only) · whole-vault DB conversion · ten
schedulable LLM roles · stdout-JSON proposals · always-on companion service (v1
defines continuous = while-app-open + launch catch-up).

### D11. Authority is modeled early — minimal, actor-level, predicate-specific
Deferring ALL authority until multiple connectors exist was wrong: authority
asymmetry exists *within one source*. The Xavier project lead posting "Rev C moved
to AMD this week — I'm coordinating the rollout" and an adjacent engineer posting
"pretty sure Xavier still runs NVIDIA" are not symmetric, and a system that
treats them as symmetric because both arrived via Slack is broken on day one.
Observations carry minimal authority metadata from M22:

    actor: { id: person_x }
    relationship_to_subject: { role: project_owner | team_member | adjacent | unknown }
    assertion_basis: firsthand | responsible_owner | reported | inferred | unknown

Those labels are usable for authority only when M22's core-derived provenance
agrees with the pinned source registration: actor-bound trusted human capture
for human routes, or a registered direct-system-artifact capability for machine
routes. Agent-inferred labels remain claims and cannot satisfy a high-stakes
route. M24's versioned authority-route artifact supplies the predicate/stage
match and route ID; M27 derives the chip from that exact proof.

Sophisticated cross-connector *policy* (preferred verification routes per
predicate) stays deferred (M28+), but it will consume this metadata — which
cannot be retrofitted onto old observations. Authority is **predicate-specific**,
never a universal rank: for intent/rationale ("why AMD?") the responsible human
is near-top authority; for committed organizational state ("what did we
approve?") the decision owner; for observable machine state, the direct system
artifact; for production reality ("which SoC is on unit #923857 that shipped
yesterday?") the manifest or physical measurement outranks the project lead.
Ownership raises authority; it never confers infallibility.

### D12. Intended vs observed reality — state-stage, not contradiction
The project lead says Rev C is AMD; main has the AMD config committed; the
manufacturing BOM says NVIDIA. All three can be simultaneously correct, because
they describe different **stages of reality**: planned → approved → implemented →
validated → deployed → shipping. Apparent source disagreement is often
state-transition lag, not conflict. Claims therefore carry a stage qualifier in
their scope (M22 schema), and contradiction detection (M27) resolves stage before
crying contradiction — the lead can be exactly right about the architecture being
moved *to* while the BOM is exactly right about what customers receive *today*.
Authority (D11) is evaluated per stage. This is the biggest single differentiator
over generic enterprise search, and it directly encodes the spec's "distinguish a
change in reality from a change in our understanding."

## Epistemic invariants — the spec's 15, classified, plus three added in review

**(a) Mechanically enforceable in Rust policy/schema code** (each with its
precondition): core-stamped system times (needs the transaction boundary +
in-core monotonic seq stamping, per D3);
agents never write canonical state (proposal-only surface + tripwire); no
self-ancestry reinforcement (preventive reachability check lands in M26 before
default-on; M27 adds independence weighting and retrospective hygiene);
contradictions may not be compressed away (refuse merge/supersede over open
contradiction edges unless the proposal addresses them); high-impact-needs-stronger-
verification (risk table keyed on deterministic signals: fan-in, human-reviewed
status — not the agent's own estimate); material-change *prefilter* (pure-Rust
field diff before any LLM spawn; residual semantic materiality stays with the
LLM, per D6); qualification gates as presence checks at promotion;
**silence-never-resolves** (elapsed time or absence of new observations may
alter freshness/coverage/attention but may never by itself transition an
unresolved object or belief to resolved/false/superseded — a mechanical M24
policy rule, because "quiet for 30 days → probably resolved" is the easiest
regression a maintenance pass can introduce); **context integrity** (no
belief-affecting semantic inference may rely solely on a context set selected
to support the candidate conclusion when accessible counterevidence retrieval
is feasible — enforced at the M26 assembler contract; the M28+ Skeptic adds
independence on top, it does not substitute for this).

**(b) Enforceable only by construction of the data model**: evidence immutability +
tombstones-not-rewrites (append-only table; no update path exists); the
four-timestamp bitemporal split (columns enforceable; *correctness* of extracted
event time is not); reinforcement-vs-repetition (deterministic once lineage edges
exist); preference-changes-attention-never-truth (attention tables schema-disjoint
from belief tables); availability-is-not-completeness (per-source coverage records;
the underlying M25 record keeps connection, health, scope-known,
scope-accessible, retention, indexing, and retrieval-attempt dimensions
separate; semantic completeness remains unknowable); Support/Coverage/Validity
separation (Validity itself is the orthogonal freshness/conflict/lifecycle
bundle); replay-stable freshness (the reducer folds explicit system transition
events with `effective_at` + `rule_version`, never reads the current clock);
**no hidden adaptation** (spec §81, added in
review): learned artifacts — aliases, attention preferences, verification
routes — are inspectable, editable records/settings; no self-improvement
mechanism may silently mutate agent prompts or policies from observed user
behavior.

**(c) Prompt-level aspiration — must NEVER be sold as guarantee, and the UI must
not imply otherwise**: absence-is-not-evidence in agent *reasoning* (the core can
refuse formal absence-assertions lacking a coverage record; it cannot police prose
conclusions); retrieval adequacy — and evidence sufficiency per intended use —
as honest self-assessments; convergence-over-
accumulation as behavioral tendency (near_duplicates stays a queue-not-refuse
backstop); and all epistemic CONTENT (extracted event times, impact estimates,
confidence values, paraphrase-copy judgments) — ships labeled agent-supplied.

## Retrieval adequacy — a structured assessment, never a proof or a score

"Have we searched enough?" is unanswerable in principle; the honest product move
is to structure the assessment and make incompleteness visible. Query-time
assembly (M26) and the Skeptic (M28+) evaluate retrieval adequacy across ten
dimensions:
1. **Source availability** — can the system access the relevant systems at all?
2. **Source health** — is ingestion current and functioning?
3. **Scope coverage** — could relevant information exist somewhere inaccessible?
4. **Temporal suitability** — is what was retrieved current enough for this
   predicate?
5. **Authority coverage** — did we consult a source/person capable of knowing
   the answer (D11)?
6. **Firsthandness** — directly observed, responsibly reported, or hearsay?
7. **Retrieval breadth** — aliases, related entities, revisions, threads?
8. **Contradiction search** — did we actively look for disconfirming evidence?
9. **Lineage independence** — are apparently-multiple sources actually one?
10. **Stakes** — how much adequacy does the decision being supported require?

The first six dimensions read M25's vault-scoped, uncollapsed coverage records;
the remaining four read the M26 retrieval manifest and D11/lineage state. Each
dimension records `state`, `basis`, and `as_of`, never only prose. For a known
fixture with accessible counterevidence, context integrity requires the evidence
to appear in the assembled context; recording that an intent was merely
"attempted" is not sufficient. A blocked or exhausted intent is explicit.

The output is never "search adequacy: 82%." It is: *"Partial — recent engineering
evidence and the accountable project owner support AMD, but current manufacturing
state has not been observed."*

**Retrieval adequacy is not evidence sufficiency** (spec §67) — they are two
outputs, never merged: adequacy asks *did we look sufficiently?*; sufficiency
asks *given what we found, is it enough for this intended use?* Excellent
retrieval can yield weak evidence; poor retrieval can yield one authoritative
direct observation. The M26 answer contract reports both, and the M24
high-stakes stopping rule binds on their conjunction.

## Milestone roadmap

Ordering rule proven by all four critiques independently: **substrate → parity →
migration → capture → policy → metering → agents → dynamics**. Every epistemic
transition that happens before the ledger exists is unrecorded forever — history
cannot be retrofitted. And "on by default" is only defensible once meaningful
rejections are ledgered and visible, writes are gated, lineage prevents
self-reinforcement, and spend is metered and bounded.

### M21 — Write safety + tamper-evident ledger (shadow mode)
1. Atomic writes in write.rs::write_file — the full discipline, not just "we now
   use rename": fsync the temp file, atomic rename over the destination, fsync
   the parent directory, preserve permissions and cloud-sync-relevant metadata,
   clean up abandoned temp files. Standalone crash-truncation bug fix today; hard
   prerequisite for every capture decision later. Rename alone is NOT "impossible
   to lose a committed update," and the M21 plan doc must not equate them.
2. Content-hash own-write suppression in the watcher (replaces the 4s window as
   capture logic; window survives as UI optimization).
3. The ledger per the D2 protocol: framed, hash-chained records in write-once
   NDJSON segments (open/sealed states, segment checksums at seal, directory
   fsync on create/seal/rename, store+writer UUIDs, seq-range naming), monotonic
   seq stamped in-core, single-writer lockfile, recovery honoring the commit
   invariant — only complete hash-valid records before the first malformed
   trailing record are committed.
4. SQLite materialized index in app-data; fork/head-regression detection on open;
   divergence circuit breaker (reconciliation mode, one event, no storms).
5. Git checkpoint messages embed the chain head (frontend, useGit.ts — cheap).
Shadow mode: existing write paths unchanged; the ledger records what the app
already does. Zero behavior change. Exit: chain verifies on launch over demo-vault;
kill -9 mid-write leaves no truncated files; replay after a simulated torn tail
recovers exactly the committed prefix; full e2e suite green untouched.

### M22 — Event schema, reducer, conformance-vector parity, OKF migration
1. Event schema v1: the four objects with discriminated observation-kind bodies
   from day one (D7); portable `source.registered` identity/capability plus a
   pinned stable `source_id` and core-derived authority provenance; explicit `resolved | unresolved | none`
   subjects; assertion-only predicate/value/scope bodies; four timestamps
   (ingestion = core-stamped seq + advisory wall clock with
   anomaly flag, per D3; event/valid-time = agent-supplied fields labeled as
   such); claim-scope qualifiers including the D12 stage field; D11 authority
   metadata (actor, relationship_to_subject, assertion_basis); the two human
   channels (review attestation vs firsthand assertion, D8); a closed
   `field_change | relation_change | alias_add | standalone` human-assertion
   union with exact effect pairing (alias removal is refused); an append-only
   `attach | correct` subject-resolution union that preserves attachment
   history; typed lineage edges
   (reported_by/derived_from/copied_from/summarized_from) as mandatory schema —
   a derived artifact without parents is schema-rejected. Also from day one
   (matrix Rev 2 pulls): **stable entity/subject IDs + explicit aliases** when
   known (spec §84 — the M26 resolver runs on these); **structural absence
   assertions** (`assertion_kind: absence` + searched_domain/scope/
   coverage_basis/observation_window/query_strategy/limitations, spec §53 —
   "no evidence of X" ≠ "X is false" by construction); **reserved nullable
   source-provenance fields** (source_system/location/record_id/revision/
   author/workflow_state, spec §61 — future connectors are data, not schema
   surgery); and optional **`corrects:`/`reason:` on human assertions** (spec
   §64 — a correction is evidence AND a pointer to the mistaken extraction).
   Belief revisions name basis Observations and a complete support set; positive
   independence is a recorded primitive with exact trusted-firsthand,
   direct-artifact, or human-decision proof, never inferred from missing edges. A
   `belief.revised` patch may be empty only when that basis changes, so
   corroboration without a value diff is representable; relation events have a
   stable ID plus explicit add/remove action. The reducer-owned version registry
   covers every stable M22 target class.
   `batch_id` + `batch.committed` define reducer-visible logical atomicity while
   the M21 frame envelope remains `v: 0` and body `schema: 1`.
2. Rust reducer + index; **parity by conformance vectors**: Rust tests generate
   JSON fixtures (event sequence → expected state + expected refusals), the single
   TS mock reducer replays them in CI; vector regeneration in the Rust suite so
   drift fails the build. Replaces line-by-line guard mirroring for the new plane.
   Coverage includes source/authority forgery refusals, support edges,
   producible independence records, uncommitted-batch invisibility, and anomaly
   rows.
3. Deterministic migrator (zero LLM calls): concepts → Beliefs + attestation
   events per D8. Every emitted item has a deterministic migration key and uses
   append-once semantics, so a committed prefix can be retried without duplicate
   events; `migration.completed` is only the fast whole-run guard. Acceptance:
   **byte-identical re-projection of every demo-vault
   knowledge file, preserved mtimes, pre-seeded learnAttempts, job queue empty
   after a migrated-vault scan** — no distiller stampede, no e2e churn
   (knowledge.spec.ts asserts literal content: '42,000 uses', trust chips, log days).

### M23 — knowledge/ flips to projection-first; the capture valve
0. Arm M22's migrator (M23.0): built and verified in M22, it runs only now,
   when knowledge/ flips to projection-first — arming at the flip closes the
   window in which a regeneration could race the still-live distiller path.
1. `write_concept` uses one hard-coded, narrowly scoped ledger-mutation
   compatibility adapter — **not a proto policy engine and not yet a Proposal
   object**. M24 deletes it when the shared table lands. The MCP tool surface is
   unchanged, so the CLI agent notices nothing. `verify_concept` emits
   attestation events pinned to the reviewed Belief revision event ID and
   matching content hash.
2. IPC-boundary human-assertion capture for in-app edits (the app is the dominant
   editor; this path needs no heuristics): assertions + resulting Belief revision
   + exact relation/alias effects commit as one M22 logical batch — before any
   watcher capture. The batch pins (or first stages) the actor-bound human source
   registration; the core, never the request/file, stamps trusted-human
   authority provenance.
3. Projection manifest + launch three-way reconciliation (file vs manifest vs
   reducer-current revision, including ledger-ahead) with the circuit breaker —
   then, and only then, live out-of-band watcher capture. Accepting current files
   first records reproducible assertion/revision or override batches; it never
   merely re-baselines the manifest.
4. guard_human_write's successor: capture-valve semantics for projections.
Exit: a structured epistemic edit becomes one assertion+revision/effect batch; an
editorial edit becomes a non-evidence projection override; projection
regeneration produces zero phantom events; attestation survives agent revision.

### M24 — Policy layer: declarative table, risk classes, versions, typed rejections
1. The policy table as a shared repo artifact FIRST (settles mock parity as a
   table-load assertion before a second engine can exist), then the Rust
   interpreter. Golden proposal→verdict fixtures run by both suites. Tripwire: no
   unmapped op.
2. submitProposal channel with typed results; *meaningful policy* rejections
   ledgered per the D5 split (schema/transport/CAS-retry noise goes to the
   runtime DB); AGENTS.md re-scope of never-throw to human-UI actions.
3. Complete structured proposal envelope: stable proposal/run IDs, closed
   discriminated op and nested payload types, intended use, structured
   transition/evidence/coverage basis, and per-target expected versions.
   Create/update payloads include the full BeliefBasis; target classes, legal
   transitions/rejections, and every op's canonical event expansion are closed.
   Every commit-set transition—queue, set refusal/rejection, or final apply—is
   one reducer-atomic logical batch. Immediately before append, the whole set
   rechecks CAS plus mutable policy inputs such as candidate-search head and
   current coverage; conflict → structured rejection → re-proposal, never silent
   overwrite.
4. Qualification gates as Type-doc capability profiles (field role annotations:
   role: failure_condition, role: completion_condition), enforced at promotion,
   type-name-blind; unqualified items park visibly (epistemic-debt lane feed),
   never block a human sketching a rough note.
5. **Creation qualification** (spec §15, enforceable not aspirational): a
   create_belief proposal requires a candidate-search receipt +
   `distinctness_reason`. M24 validates and runs the deterministic exact/alias/
   scoped path; M26 adds the semantic-retrieval receipt before agent proposal
   tools register. The unchanged `write_concept` adapter is server-enriched and
   stays draft-only during this bridge. The full path is exact identity → alias
   → semantic candidate → scoped/temporal candidate lookup → update/qualify
   existing if defensible → create only if meaningfully distinct. Similarity
   alone never forces a merge; near_duplicates is a backstop, not the mechanism.
6. **Minimal high-stakes stopping rule** (spec §52/§71): intended use
   HIGH/CRITICAL AND (Coverage ≠ observed OR the predicate's required authority
   class is missing) → the answer/mutation remains provisional or requires
   human verification. Simple deterministic verification requirements per
   evidence class + authority (e.g. `shipping_soc` high-stakes needs a
   production artifact OR responsible-owner firsthand) — single-connector-
   compatible; learned cross-source routes stay M28+. The model cannot
   self-certify critical sufficiency, from day one.
7. The **silence-never-resolves** invariant lands here as a policy rule (see
   the invariants section): time-based transitions to resolved/superseded are
   schema-rejected from the structured transition cause, never prose parsing.
8. Closed op inventory includes alias addition, belief split, exact-equivalence
   belief merge, semantic conflict classification, entity merge, and forward
   revert. Human approval/rejection is a durable decision event and UI action,
   not an agent proposal op. The durable minimal review queue can approve/reject
   HIGH/CRITICAL work and revert MEDIUM applications before agents turn on.
Exit: synthetic proposals exercise the full transactional skeleton with agents OFF;
queued human decisions and reverts work end to end.

### M25 — Metering, budgets, deterministic pipeline services
0. **Operational ≠ epistemic — two durable stores.** The vault ledger holds
   portable epistemic history; an **app-data runtime DB** holds scheduler queues,
   rate limits, token accounting, retries, and transient connector health.
   Operational events are *reflected into* the epistemic ledger only when they
   materially affect knowledge coverage ("connector unavailable for three days" →
   coverage event; "retry scheduled in 37 seconds" → never). Same rule as D5's
   rejection split: telemetry stays out of project epistemology.
   The runtime DB is app-global: scheduler, run, source, and coverage rows carry
   `store_uuid`; subscription budget rows remain deliberately global. SQLite
   `user_version` migrations are transactional and a failed/corrupt migration
   enters named recovery mode.
1. Parse usage from every stream-json result event (currently discarded);
   per-run/per-lane accounting in the runtime DB. Ambient gates are
   multi-dimensional: daily runs, total tokens, output tokens, consecutive
   failures, quota backoff, and elapsed time, with lane-priority degradation.
   The versioned local-day contract snapshots its timezone and ceilings; a
   dispatch atomically reserves a run plus its bounded input/output allowance,
   then reconciles actual usage conservatively (missing usage never becomes
   zero). Attended chat is metered but never daily-budget-blocked.
2. Scheduler state currently split between hook memory (seen snapshot/events/
   pending work) and localStorage (attempt/trigger/skill ledgers) moves into the
   runtime DB, including the prior normalized snapshot needed for restart-time
   field diffs. One `BEGIN IMMEDIATE` claim transaction combines queue lease,
   global ambient-concurrency lease, budget reservation, and run creation;
   expiring lease recovery makes every crash boundary retry-safe. Launch
   catch-up = hash-diff through the budget gate. Runtime-DB
   loss automatically pauses ambient work, reconstructs portable epistemic
   processing receipts where possible, and holds ambiguous items for explicit
   re-baseline or reprocess — **no automatic duplicate spend**, not the
   impossible claim that deleted operational history can be recovered perfectly.
   A closed receipt-route matrix defines pending/terminal/retry destiny and
   required references. Initial Observation/capture plus receipt and every later
   terminal `ingest.assessed` transition are trusted members of the same M22
   batch as the state they describe, eliminating both untracked-source and
   applied-without-source-association crash windows. Declared responsibility
   contracts are append-only versioned intervals; typed launch catch-up outcomes
   pin the active contract version and linked gap, preserving exact R10 inputs.
3. Content-hash + per-field materiality prefilter in Rust: git operations and
   projection regeneration cost **zero tokens** (today a git checkout bumps every
   mtime and floods the queue via okf.ts:407 'behind'). Materiality has **four
   dimensions — world-state, belief-state, evidence-state, attention** (spec
   §17): independent corroboration is material even when the believed value is
   unchanged (single-source → corroborated), so "no field changed → discard"
   is forbidden; the prefilter gates LLM spend, never epistemic recording. Every
   verdict has a consumer: no/non-material closes deterministically;
   `material_candidate` becomes a deterministic proposal when fully structured
   or joins M26's next batch; `needs_semantic_judgment` always joins that batch.
   Only a positive M22 independence record can take the corroboration path.
4. Quota-exhaustion handling — with **reasoning-runtime health and source
   health as distinct categories** (spec §86): a dead CLI quota means evidence
   exists but cannot currently be processed (un-consumed ledgers, window-aware
   backoff, "N items unprocessed" banner); a dead connector means reality may
   be changing unobserved. Different semantics, different blindness messages.
   M25 also persists the uncollapsed coverage record keyed by M22 `source_id`:
   source_connected, source_healthy, scope_known, scope_accessible,
   retention_known, index_current, and retrieval_attempted, each with basis and
   as-of time. Coverage gap/restoration events have full schemas and conformance
   vectors; M24 high-stakes proposals reference these records.
5. Control surface ships WITH the pipeline: global pause (persisted, titlebar),
   per-lane toggles, budget meter, activity ledger (run → tokens → proposals →
   applied/rejected). Git checkpoints collapse to one commit per applied batch.
Exit: a simulated day of churn produces bounded run counts; every failure mode is
visible, none silent.

### M26 — Platform agents by default: the three constructs
1. Batched ingest pass replacing per-note distill jobs; proposals via
   serde-validated MCP tools, server-side accumulation, terminal commit call,
   bounded in-session retry on typed rejection. M26 explicitly registers the
   M24 proposal tools only after semantic retrieval and preventive graph guards
   pass their fixtures. Settled windows consume **both** `material_candidate`
   and `needs_semantic_judgment`; fully structured deterministic candidates may
   bypass the LLM, and every other candidate joins the single batch. The pass
   includes the **basic
   entity resolver** (spec §84, on M22's IDs+aliases): exact ID → known alias →
   explicit relation → high-confidence existing-entity match → otherwise
   *unresolved*, never guessed — without this, observations cannot attach to
   the right beliefs and lineage/contradiction detection is fiction. Learned
   alias models stay M28+. Resolver telemetry uses closed eligibility/reason/
   outcome enums and count-distinct attempt/item protocols, so the R3/R6
   denominators are executable rather than prose.
   The M24 creation receipt is upgraded to semantic v2—with server-derived
   query/index/version fields and disposition of every candidate—before those
   tools register. Semantic materiality produces a closed
   `ingest.semantic_assessed` event; outcome, proposal mutations/lifecycle, and
   terminal source-item receipts commit atomically.
1b. **Source content has no instructional or direct mutation authority** (spec
   §92): ingest prompts quote source material as data; source-derived proposals
   are tainted, evidence-linked, and policy-gated. Predicate/stage-specific
   epistemic authority still comes from D11/M27 policy-qualified evidence routes.
   This is containment, not a perfect-detection guarantee: a
   syntactically valid LOW-risk malicious instruction is an explicit adversarial
   fixture. The prompt discipline and logging are deliverables here.
   Detection telemetry is recorded in vault-scoped runtime assessments keyed to
   immutable Observation event IDs as `suspected_instructional_content` (+
   classifier/reason codes) — never by mutating M22's closed Observation and
   never as factual `prompt_injection: true`.
2. Maintenance pass extending jobs.ts lanes on durable state.
3. Query-time assembly (attended-only), with the full contract (matrix Rev 2
   pulls):
   - **Contradiction-aware assembly** (context-integrity invariant): positive,
     contradiction, historical, authority, and scope-neighbor retrieval intents
     — the Skeptic can wait; counterevidence retrieval cannot. A known accessible
     counterexample must be included; otherwise the manifest records the intent
     as blocked or exhausted with basis. "Attempted" alone fails acceptance.
   - **Basic semantic retrieval** (spec §93): query expansion and/or embeddings
     in app-data — BM25 alone cannot find aliases, paraphrases, or
     contradiction candidates, and adequacy must not assess a crippled
     retriever. Golden alias, paraphrase, and counterevidence recall fixtures are
     the acceptance boundary, independent of implementation choice.
   - **Two distinct outputs** (spec §47/§67): retrieval adequacy ("did we look
     enough?") AND evidence sufficiency ("is what we found enough for THIS
     use?") — "Retrieval: partial · Sufficiency: adequate for a reversible
     prototype, insufficient for production release."
   - **Structured synthesis fields** (spec §98/§36): closed tagged citation and
     labeled-statement unions plus basis,
     missing_expected_evidence, authoritative_next_sources,
     invalidation_conditions (agent-generated, labeled) — required for
     high-stakes conclusions, optional otherwise.
   - **Structured ephemeral discovery plans** (spec §68): goal/steps/stop_when/
     stakes as schema, not prose. A versioned hash construction gives each plan
     stable identity, while a closed operational lifecycle records pending,
     started, completed, failed, or dismissed; epistemic Discovery persistence
     still waits for its object trigger.
   - **Causal-hypothesis guard** (spec §76): shared root causes are labeled
     hypothesis unless directly supported, from the first synthesis.
   - The M24 high-stakes stopping rule binds the answer contract: HIGH/CRITICAL
     use + coverage/authority gaps → the answer says "provisional" and says why.
   - The serde contract names all ten adequacy dimension states, bases, and
     per-dimension `as_of` values; a tagged working-memory item must resolve to a
     valid assertion or unsupported Belief revision and retains all source refs.
     The distinct sufficiency result and every nested member of §65's nine-part
     answer are closed types; prose is rendering, never the only representation.
3b. **Convergence synthesis** (spec §30, pulled forward): on-demand and
   scheduled "how did our model change?" over ledger diffs — believed-then vs
   believed-now, material changes, certainty shifts, new blindness/staleness/
   contestation. Cheap consumer of ledger + revision chains + materiality
   (Support/Validity-framed certainty shifts activate once M27's chips land);
   scheduled output is a bounded runtime run artifact keyed by seq endpoints,
   not a Narrative object; persistent narrative identity stays M28+ behind its
   earned-persistence trigger.
4. Source Monitor + Attention as deterministic Rust services (D6 — Pattern Scout
   is NOT this and stays deferred). Deterministic
   `conflict.candidate_detected` events pin assertion/belief-revision endpoints
   and register comparison CAS state for M27; they assert a need to classify,
   not a contradiction.
4b. **Preventive self-ancestry reachability** wires M22 support edges, Observation
    lineage, and explicit `derived_content` source-Belief-revision references
    into M24 proposal apply before default-on. A candidate Observation that
    reaches any revision of the target Belief cannot become its new BeliefBasis
    support; review attestations are already structurally excluded from Support
    by M22. M27 retains full independence weighting and retrospective graph-
    hygiene checks.
5. **Budgets are multi-dimensional — run count alone is not a budget** (ten runs
   can be 80k tokens each; twenty can be 2k each). The Context Assembler enforces
   deterministic context caps per pass — max_sources_per_run,
   max_context_bytes, max_evidence_items. `max_daily_runs`, output-token, and
   failure budgets gate **ambient** work only; attended assembly is metered and
   context-bounded but never daily-budget-blocked. Resolver outcomes, retrieval/
   synthesis cost components, and ephemeral discovery-plan lifecycle metadata
   are persisted operationally so M28 triggers are measurable. Cost component
   and unit enums, required-row completeness, and the versioned independent-pass
   projection formula are closed contracts rather than dashboard interpretation.
Exit: on-by-default is live, bounded at ~10–20 ambient runs/day AND within
context/token caps by construction, with M25's visibility. 'On by default' =
deterministic phases always on, LLM phases on within budget.

### M27 — Belief dynamics + attention lanes
1. Support/Coverage/Validity presentation (D9) over an orthogonal model:
   Support includes `unsupported` and predicate/stage-specific authority from
   policy-qualified human or direct-artifact routes; mixed/unknown predicate and
   stage inputs resolve by a closed conservative rule. Coverage summarizes M25's
   uncollapsed record through a versioned truth table (never connector-specific
   intuition); Validity is the tuple
   freshness (`fresh | stale | unknown`) + conflict (`clear | contested`) +
   lifecycle (`active | superseded | archived | tombstoned`), so
   stale+contested is representable. Attestation renders as separate ReviewStatus.
   **Default predicate-class freshness rules** make freshness meaningful (spec
   §45: charter rationale — durable · CI status — hours · shipping BOM —
   days/revision-bound). A deterministic Rust timer/launch catch-up emits
   replay-stable transition events with `effective_at` + `rule_version`; the
   reducer never reads the current clock. Learned per-predicate policies M28+.
2. Lineage-independence corroboration (four copies of one Slack message = one
   lineage, deterministically, at the prefilter) with a **tri-state** (spec
   §85): known_same_lineage / known_independent / independence_unknown — "no
   lineage edge detected" never silently counts as independence (the lineage
   analogue of availability ≠ completeness). `known_independent` requires M22's
   positive record. The preventive self-ancestry check already runs from M26;
   M27 adds weighting and retrospective cycle/descendant-only detection.
3. **Scope resolution BEFORE contradiction.** A committed M26 comparison
   candidate must
   first fail resolution on: same subject? same revision? same environment /
   geography? same valid time? same D12 stage? same meaning? "Rev A uses NVIDIA"
   vs "Rev C uses AMD" is not a contradiction; intended-vs-shipping is stage
   lag, not conflict. Comparison endpoints pin typed assertion event, belief,
   and belief-revision event IDs. A tagged legacy endpoint preserves migrated
   unsupported `contradicts` relations with explicit migration-uncertainty
   reasons until classification; no synthetic assertion is fabricated. Without
   this step, contradiction preservation screams at
   normal temporal evolution. Resolution produces a typed **outcome** (spec
   §50): resolved_temporally / resolved_by_scope / resolved_by_stage /
   resolved_by_granularity / same_meaning / genuine_direct / partial /
   conditional — several
   spec "contradiction types" are resolution outcomes meaning "not a
   contradiction after all," and **only the unresolved classes become
   contradiction edges**. An unresolved classification and its opened edge are
   one M22 logical batch, so neither half can become visible alone.
   Deterministic scope/time/stage outcomes are core-stamped; genuinely semantic
   same-meaning decisions arrive as evidence-linked, agent-supplied
   `classify_conflict` proposals through M24 policy.
   Migrated `contradicts` relations are reclassified through this pipeline
   before the preservation gate or lanes activate; until classified they remain
   visible protected legacy conflicts.
4. Contradiction-preservation gate on merge/supersede (fires only after 3 fails
   to resolve the claims apart).
5. Lanes: contradiction + blindness first (the spec's non-negotiables), then
   staleness + **epistemic debt with an operational definition** (spec §89: a
   materially relied-upon belief/dependency with stale evidence, partial/blind
   coverage, unresolved contradiction, missing authority, missing verification
   route, or known unsupported inference — deterministic reasons, never an LLM
   vibe) — all under nothing-speaks-first default silence.
6. **Generic `critical_attention` bypass** (spec §8, pulled forward):
   extremely conservative deterministic signals, human-confirmable, no scalar
   score, no Risk model — "production signing certificate expires tomorrow"
   must not wait for M28+ Risk objects. Specialized lanes later refine it.
   The v1 trigger artifact enumerates its initial deterministic classes and
   required capability fields; every class has a positive and near-miss fixture.
7. **Protected lanes** (spec §33): user preference may tune verbosity,
   ordering within normal lanes, phrasing, and cadence — it may never suppress
   blindness, material contradiction, critical_attention, or high-impact
   human-review requirements. The preference firewall is schema-disjointness
   PLUS this rule.
8. **Epistemic Status surface** (spec §35, skeleton): one coherent home for
   what-changed, coverage gaps, contradictions, stale understanding, needs
   review, and system/budget health — consolidating what M25–M27 would
   otherwise ship as scattered banners; grows into §35's full project view
   later.
Exit: a contradicted belief cannot be silently merged; repetition does not
strengthen anything; stage-lagged truths coexist without alarms; a
catastrophic-if-omitted belief can surface without a Risk object existing.

### M28+ — deferred, each behind a named trigger
The trigger registry distinguishes **metric triggers** from **explicit owner
discretion backed by a written evidence packet**; it never labels discretion as
measurement. Every metric trigger names its sample, window, threshold, and M26
telemetry source. Every evaluation is an idempotent, versioned
`not_ready | not_fired | fired` record with its exact input snapshot/window and
owner/evidence-pack fields where applicable. In particular: Skeptic cost uses component-accounted M26
retrieval/synthesis runs plus a stated independent-pass projection; the
claim-granularity Resolver and Claims-as-objects share a demand trigger rather
than waiting circularly for one another; learned resolution uses a stated
unresolved-rate threshold; Curiosity uses counted discovery-plan lifecycle
metadata; Pattern Scout headroom uses each day's immutable ceiling snapshot;
cross-source policy requires qualifying connectors in the same store and
overlapping subject/scope; and the always-on service joins M25 responsibility contracts, typed
catch-up outcomes, and linked coverage gaps. Persistent Narrative is explicitly
discretionary and needs two independently shipped surfaces with a demonstrated
shared-history failure; it is not circularly measured by an ID that does not yet
exist. Connector scheduling is explicitly discretionary.

Risk-gated Skeptic pass (after that cost trigger fires; MEDIUM amortized
into maintenance, HIGH/CRITICAL stays the human card) — **with independent
retrieval authority**: the same context assembly must never produce both the
conclusion and its critique; a system cannot challenge an omitted contradiction ·
**Pattern Scout** (LLM detection of genuinely novel patterns the existing model
does not explain — the spec's actual Scout, distinct from M26's Source Monitor) ·
**Learned entity resolution** (spec §84: learned alias models, temporal alias
validity, ambiguity improvements — the *basic* resolver moved forward: IDs +
explicit aliases M22, deterministic resolution M26) · Claims-as-objects (with
the claim-granularity Resolver — the M26 basic entity resolver does NOT satisfy
this trigger; D7's observation_kind
distinction makes this a promotion, not a migration) · Issues/multidim lifecycle
as epistemic objects · Discovery objects, causal hypotheses, forecasts (each
with its consuming agent; the *behavior* — discovery plans surfaced in synthesis
output — precedes the object) · the spec §35 primary project view (Current
Story / What Changed / Needs Attention) as a dedicated UI milestone — its
Epistemic Status skeleton ships M27 · the persistent project narrative +
richer executive convergence storytelling (spec §30/§31 — on-demand AND
scheduled convergence synthesis itself ships at M26 item 3b; only persistence
and executive framing wait here, behind §31's earned-persistence trigger) ·
cross-source verification policies consuming D11 metadata
(≥2 qualifying live connectors in the same store with overlapping subject/scope)
· always-on service · multi-master ledger merge (explicitly
out of scope until then).

## Standing risks to carry into every milestone plan
- **e2e/demo-vault coupling**: any projection-format change is a test change;
  format v1 is current OKF v0.2 frontmatter byte-for-byte.
- **Distiller stampede**: any migration/regeneration that bumps mtimes or rewrites
  knowledge/ files without pre-seeding ledgers burns real quota silently.
- **Parity drift**: every new guard must arrive as table/vector, never as twin
  hand-written logic.
- **Ledger vocabulary creep**: event schema changes are migrations of an
  append-only store — additive-only discipline from day one. Every new kind in
  M23–M27 defines its body, validation/refusal rules, reducer behavior, storage
  destiny, and conformance vectors in the milestone that introduces it.
- **Runtime scoping/recovery**: app-data stores are multi-vault. Every
  vault-derived row carries store identity; global subscription budgets say why
  they are global. Operational loss enters explicit recovery and never silently
  resets spend or processed state.
- **Language discipline**: "tamper-evident," "agent-supplied," "while-app-open,"
  "periodic anchoring" — the honest words are part of the spec compliance, not
  marketing polish.
- **Telemetry leakage**: every new event type declares its home (epistemic ledger
  vs operational runtime DB) at design time; when in doubt, operational —
  promotion into the ledger requires a coverage-materiality argument.
- **The epistemic eval suite ships WITH the mechanisms, not after** (spec §37):
  as each lands — M24 policy, M26 resolver/assembly, M27 dynamics — its
  golden-scenario regression fixtures land in the same milestone: false
  creation, false merge, missed contradiction, stale truth, ancestry
  reinforcement, critical-attention misses. Not user analytics; engineering
  regression tests over synthetic epistemic scenarios.
