# M25 — Metering, budgets, and the deterministic pipeline services

**Brief for the agent picking this up cold.** Written 2026-08-07. Read the
master roadmap D5 (the two-destinies split), D6 (the LLM/Rust boundary), D10
and matrix rows §17, §22, §29, §35, §46, §52, §53, §61, §62, §63, §75, §85,
§86, §90, §97 first. M25 exists because the spec
assumed an org-scale runtime and this product runs on **the owner's personal
Claude CLI subscription** — no API key, quota shared with the owner's own
usage. Nothing ambient may be on-by-default (M26) until spend is measured,
bounded, and visible. M25 builds the meter, the budget, the durable
scheduler, and the first real UI of the overhaul.

**The honesty rule: quota death becomes visible runtime-health, never
silence.** Today a failed run is recorded 'failed' and forgotten
(useJobRunner.ts:405-409). After M25, every failure mode has a face.

---

## Where things stand (verify at start — refs drift)

- M24 landed: policy table, submitProposal, typed rejections, the runtime DB
  file (`runtime.db`, one `operational_log` table). Agents still OFF for
  ambient work; the distiller/jobs.ts lanes still run on the pre-overhaul
  path with split transient/legacy state.
- Usage fields in the CLI's stream-json result events are **discarded on the
  wire** (agent.rs:33/768) — the app cannot measure spend today.
- The distiller's `behind` heuristic keys on mtime (okf.ts:407): a git
  checkout bumps every mtime and floods the queue. M23 made knowledge/
  hash-diff-driven; the *scheduler* is still mtime-era.
- Current scheduling state is split, not durable-shaped: scan/pending sets
  live in hook memory; attempts/triggers/skills live in localStorage. The plan
  must migrate that actual split and cannot recover volatile pending memory.
- Background LLM concurrency: MAX_CONCURRENT_RUNS=4 with chat sharing the
  pool.

## Non-goals (defend these)

- No new LLM behavior, no prompt changes, no new agent constructs — M26
  consumes this milestone; it does not ship in it. The three passes stay
  OFF.
- No always-on service (D10: continuous = while-app-open + launch catch-up).
- No numeric confidence, no product metrics dashboards — the budget meter
  and activity ledger are operational surfaces, not epistemics.
- No semantic materiality judgments — Rust filters the obvious; the LLM
  residual is an M26 deliverable. M25's prefilter is deterministic only —
  no LLM.
- Attended chat is NEVER budget-blocked; ambient always is.

## Five rules that must survive contact with implementation

**Operational ≠ epistemic — two durable stores (amendment 7).** The vault
ledger holds portable epistemic history; the runtime DB holds scheduler
queues, rate limits, token accounting, retries, transient health. An
operational event is *reflected into* the epistemic ledger only when it
materially affects knowledge coverage ("connector unavailable for three
days" → coverage event; "retry scheduled in 37 seconds" → never). Every new
event type declares its home at design time; when in doubt, operational —
promotion into the ledger requires a coverage-materiality argument.

**The prefilter gates LLM spend, never epistemic recording.** Materiality
has four dimensions — world-state, belief-state, evidence-state, attention
(§17). Independent corroboration is material even when the believed value is
unchanged (single-source → corroborated), so "no field changed → discard" is
forbidden. The prefilter may only decide *whether an LLM run is warranted*,
not whether an observation is recorded.

**Reasoning-runtime health and source health are distinct categories
(§86).** A dead CLI quota means evidence exists but cannot currently be
processed. A dead connector means reality may be changing unobserved.
Different semantics, different banners, different tables. Collapsing them is
a review-blocking defect.

**The app-global DB never erases vault identity.** Scheduler, run, source,
coverage-cache, and ingestion rows carry `vault_id` and/or `store_uuid` as
appropriate. Only subscription budget/runtime settings aggregate globally.

**Coverage stays uncollapsed (§46).** Source connection, source health, known
scope, accessible scope, known retention, current index, and attempted
retrieval are separate fields. “Partial” is a UI projection, not the stored
model. Attended chat is always metered but never budget-gated; ambient is.

---

## Runtime DB schema growth (fixed here)

`runtime.db` is app-global and gains (additive to M24's `operational_log`):

    runs            (run_id, vault_id NULL, store_uuid NULL, mode, lane,
                     started_at, ended_at, outcome, usage_state,
                     input_tokens, output_tokens, cache_read, cache_write,
                     reserved_total_tokens, reserved_output_tokens, lease_expires_at,
                     proposals_submitted, applied, rejected)
    budget_days     (window_start_utc, window_end_utc, timezone_id,
                     settings_version, settings_digest,
                     max_daily_runs, max_daily_tokens, max_daily_output_tokens,
                     max_ambient_run_tokens, max_ambient_run_output_tokens,
                     max_consecutive_failures, max_run_elapsed_seconds, warning_ppm,
                     accounting_state, ambient_tokens_used, ambient_output_tokens,
                     reserved_total_tokens, reserved_output_tokens,
                     ambient_runs_started, ceiling_state, ceiling_reasons)
    budget_settings_versions (settings_version, settings_digest, recorded_at,
                              effective_window_start_utc, timezone_id,
                              max_daily_runs, max_daily_tokens,
                              max_daily_output_tokens, max_ambient_run_tokens,
                              max_ambient_run_output_tokens,
                              max_consecutive_failures, max_run_elapsed_seconds,
                              warning_ppm)
    ambient_gate_decisions (decision_id, attempted_at, vault_id, store_uuid,
                            lane, window_start_utc, settings_version,
                            settings_digest, total_reservation, output_reservation,
                            used_total_tokens, used_output_tokens, runs_started,
                            reserved_total_tokens, reserved_output_tokens,
                            decision, reasons)
    ambient_dispatch (singleton_key, run_id, vault_id, store_uuid, lane,
                      acquired_at, lease_expires_at)
    app_sessions    (session_id, vault_id, store_uuid, opened_at,
                     last_heartbeat_at, clean_closed_at, close_precision)
    lane_registry   (lane, priority, enabled_by_default, introduced_version)
    ambient_gate_state (vault_id, store_uuid, lane,
                        consecutive_failures, active_run_started_at, last_outcome)
    scheduler       (vault_id, store_uuid, item_key, source_id, content_hash,
                     normalized_prior_snapshot, normalizer_version,
                     processing_epoch, event_cursor, route, state,
                     claimed_by_run_id, claim_expires_at,
                     first_seen, updated_at)
    backoff         (vault_id NULL, lane, until, reason, quota_window_key)
    source_registration (store_uuid, source_id, registration_event_id, kind,
                         source_key, actor_id, connector_instance_id,
                         logical_scope_id, service_id, legacy_resource_hash,
                         authority_capability,
                         independence_domain_id)
    source_connection (store_uuid, source_id, state, since, detail)
    source_health   (store_uuid, source_id, state, since, detail)
    runtime_health  (component, state, since, detail)
    coverage_cache  (store_uuid, assessment_id, source_id, subject_id,
                     predicate_class, scope_digest, event_id)
    coverage_dimension_cache (store_uuid, assessment_id, dimension, state,
                              basis_event_ids_json, as_of)
    ingestion_failures (vault_id, store_uuid, item_key, stage, detail,
                        first_seen, last_seen, resolved_at)
    responsibility_contracts (store_uuid, responsibility_id, contract_version,
                              contract_digest, source_id, subject_id,
                              predicate_class, scope_digest, retention_seconds,
                              deadline_seconds, active_from, active_to)
    catchup_outcomes (vault_id, store_uuid, episode_id, responsibility_id,
                      contract_version, contract_digest, app_closed_at,
                      close_precision, reopened_at, resolved_at,
                      coverage_gap_id, outcome, detail)
    settings        (key, vault_id NULL, value)

`vault_id` is the app registration for a vault path; `store_uuid` is the
portable ledger identity. Keys and referential validation include the
appropriate scope, and source rows use M22's `(store_uuid, source_id)`
identity. `source_id` is the opaque
lowercase 128-bit hex ID, not provider/location/record/revision. `budget_days`
is intentionally global: every vault debits the same personal CLI
subscription. `runtime_health` is app-global and never substitutes for
source connection or source health, which are themselves separate live
signals. `coverage_cache` is disposable and rebuilds from ledger events.

This is an executable relational contract. Numeric values are non-negative,
hashes are lowercase SHA-256, and stored times are RFC3339 UTC. Primary/unique
keys are exactly those in the design: `runs(run_id)`, the UTC budget-window
start, immutable budget-setting versions, gate decisions, singleton ambient
lease, scoped session/gate/scheduler/failure keys,
`lane_registry(lane)`, source rows on `(store_uuid, source_id)`, assessment and
dimension cache keys, append-only responsibility versions, and version-pinned
catch-up outcomes. Global nullable settings/backoff uniqueness uses partial
indexes; SQLite NULL equality is never used as an identity trick. A run's
vault/store columns are both null or both present, and every ambient run is
scoped.

The closed enum/constraint migration includes attended/ambient mode, exact run
outcomes and usage/accounting states, session precision, scheduler states,
ceiling states/reasons, and gate reasons from the design. Lanes are foreign-
keyed to a registry seeded in priority order `filed, scheduled, agent, behind,
refresh, stale, schema`; adding a future lane requires a migration. The
`behind` row survives repurposed as the hash-diff launch catch-up lane — only
its mtime feeder dies (M25.3). Budget
settings and responsibility contracts are append-only versions. Every budget
edit records a fresh version immediately (even a content revert), takes effect
at the next local-day window, and is copied in full into that immutable day's
row with its digest. Every gate decision pins that row/version and its observed
counters. A responsibility edit closes the old half-open active interval and
inserts a new version, while every outcome pins the selected version and
digest.

`source_registration` is a disposable byte-faithful cache of M22's portable
`source.registered` union (`human_actor | connector | builtin |
cerebro_runtime | legacy_reference`), including actor/connector/service/legacy-
resource binding, exact authority capability, and independence domain. Legacy
rows remain content-only/domain-null, produce no connector health or authority/
independence upgrade, and start with unknown coverage. Registration event IDs
are unique and all source health/coverage/ingest rows foreign-key this same-
store identity. Cache loss rebuilds from the ledger; an unregistered source is
held/refused, never reconstructed from provider/location. M28 R7 filters
exactly `kind=connector`.

Every change is a numbered `PRAGMA user_version` migration inside one SQLite
transaction; set `user_version` only after DDL/data copy/validation. Failure
rolls back to the prior schema, pauses ambient work, and surfaces the version.
Startup quick/integrity checks preserve a corrupt DB as timestamped
`runtime.db.corrupt-*`, create a clean DB, and enter conservative recovery —
never silently overwrite the diagnostic copy.

The pre-M25 import is one-shot and transactional: import mappable localStorage
attempts/triggers/skills, compute/store each current normalized snapshot, mark
only legacy-backed entries consumed, and park all unprovable volatile work as
`baseline_held`. Show the held count with explicit **Use current state as
baseline** and **Process these items** choices. Preserve localStorage read
compatibility for the background-disable e2e kill switch.

Deleting/corrupting the DB destroys token telemetry, so “no re-spend” is not
an honest guarantee. Startup pauses ambient before dispatch, reconstructs
exact item/hash and consumed-or-pending state from portable `ingest.assessed`
receipts plus referenced terminal outcomes, and puts changed/ambiguous items in `recovery_held` until the owner explicitly
rebaselines or reprocesses. Global budget is `unknown` and stays paused until
the next daily window or an explicit owner-set baseline. Attended chat remains
available. The enforceable promise is **no automatic duplicate spend**.

## Portable coverage and processing event contract

M25 adds complete M22 event bodies, reducers, and conformance vectors for five
kinds:

- `coverage.fact_recorded`: server-only, telemetry-free trusted fact —
  `fact_id`, stable source/registration binding, scoped subject, one of the
  seven dimensions with a `yes | no` state and `as_of`, producer kind/version,
  and a one-to-one fact variant (connection/health probe, scope/access/
  retention discovery, index checkpoint, retrieval execution, or
  retrieval-window-closed-without-attempt);
- `coverage.assessed`: `assessment_id`, scoped subject, stable `source_id`,
  optional canonical retrieval receipt, limitations, supersession, and seven
  required independent dimensions — `source_connected`, `source_healthy`,
  `scope_known`, `scope_accessible`, `retention_known`, `index_current`, and
  `retrieval_attempted` — each storing its own `{ state, basis_event_ids,
  as_of }`, where state is `yes | no | unknown | not_applicable`;
- `coverage.gap`: `gap_id`, scoped subject, nullable source/responsibility ID,
  nullable `contract_version`/contract digest, typed cause (`source |
  reasoning_runtime`), open time, assessment ref, affected dimensions,
  pending count at open, and reason;
- `coverage.restored`: gap ID, restore time, assessment ref, restored
  dimensions, and reason; and
- `ingest.assessed`: stable source-item/source/record IDs, artifact and normalized-snapshot
  hashes, normalizer version, assessed chain head, prefilter verdict/dimensions,
  independence using M22's exact tri-state names, terminal route,
  observation/proposal refs, M26 batch key/outcome event ID, and superseded
  receipt. It contains no token/model/quota/retry telemetry and is
  excluded from evidence lineage/Support.

The exact JSON shapes and validation rules are frozen in the companion design.
M24 coverage refs address `assessment_id`. Connection never implies health;
health never implies known/accessible scope; indexing never implies retrieval.
A `yes` or `no` dimension's basis is a non-empty sorted/unique list of
committed `coverage.fact_recorded` IDs — no assessment can bootstrap itself;
`unknown` or `not_applicable` requires its own limitation. Per-dimension `as_of` drives age
checks. A retrieval-attempt `yes` requires the exact receipt fields
`strategy_version`, canonical `query_strategy`, SHA-256 `query_fingerprint`,
`attempted_at`, canonical `searched_domain`, `search_scope`,
`observation_window`, searched aliases, and searched scopes. M24 formal-
absence validation compares those four canonical strings byte-for-byte and
also validates structured subject/scope compatibility. M24 shipped that join
against fixture-backed typed assessment records and refuses coverage
references until these M25 bodies land — M24's spec owns that interim; this
is the successor, not a change.
A runtime-caused gap can affect processing/index/retrieval currency but never
rewrites source connection/health. Conformance vectors cover every kind,
refusal, supersession, partial/final restoration, stable append-once retry,
route consistency, and rebuild.

## Phases

One commit per phase, `type(scope): sentence (M25.n)`.

### M25.1 — Scoped DB foundation, migrations, and recovery
Create the app-global schema with explicit vault/store scoping and global-only
budget/runtime rows. Implement the design's exact keys, foreign keys, checks,
closed enums, partial unique indexes, seeded lane registry, session heartbeat,
and append-only budget-setting and responsibility/outcome versioning. Each `user_version`
migration is one `BEGIN IMMEDIATE` transaction with validation before the
version change; implement rollback/failure surfacing, corruption quarantine,
and automatic ambient pause. Build the one-shot legacy importer against the
actual state split: localStorage attempts/triggers/skills are imported when
mappable, normalized snapshots are baselined, and unprovable work is
`baseline_held`; volatile hook pending state is not invented. Preserve the e2e
kill switch.

Implement missing/corrupt-DB recovery before any ambient dispatcher can open:
rebuild exact consumed state from portable receipts, mark ambiguity
`recovery_held`, set budget unknown, and require explicit owner rebaseline/
reprocess or next-window reset. Kill-point tests cover each migration and
recovery boundary.

### M25.2 — Parse usage; build the global daily budget
agent.rs stops discarding usage fields: every stream-json result event's token
counts land on scoped `runs` (attended and ambient alike — attended is metered,
only ambient is budgeted). Recorded sanitized CLI fixtures exercise defensive
parsing; unknown wire fields are noted in `operational_log`.

Ship one versioned defaults artifact: 20 daily ambient runs, 200,000 total
tokens, 40,000 output tokens, 20,000 total/4,000 output tokens per ambient
run, 3 consecutive failures, 600 elapsed seconds, and `warning_ppm` 800,000.
Every edit appends an immutable settings version immediately, even for a
change-and-revert, and becomes effective only in the next local-day window.
That day's row copies every daily/per-run/failure/elapsed/warning value and
pins its settings digest/version; neither current settings nor shipped v1
defaults may reinterpret history. The first window captures the system IANA
timezone. Windows are half-open between consecutive local midnights converted
to UTC (including honest 23/25-hour DST days); a timezone edit begins with the
next window. This history makes an M28 R2 window invalidatable by any edit and
keeps ordinary gate decisions reproducible.
`ceiling_state ∈ {under_budget, warning, exhausted}` and closed reason codes
identify which limits fired. Every ambient run from every vault atomically
debits the same `budget_days` row. One `budget_gate(vault_id, lane,
total_reservation, output_reservation) → proceed | deferred(GateReason)` API
checks exact used-plus-reserved limits, pause/recovery state, quota backoff,
lane state, and singleton concurrency. Reservations must fit the active day's
copied per-run caps (typed `reservation_exceeds_run_cap`, distinct from
`reservation_exceeds_remaining` for daily headroom), and every decision pins
the day/settings snapshot plus the counters it observed.

Gate, token/output reservation, scheduler claim, run insertion, and ambient-
lease acquisition are one `BEGIN IMMEDIATE` transaction; spawn happens only
after commit. One finalization transaction records exact usage, releases the
reservation/lease, and consumes or requeues claims. Lease expiry or missing
terminal usage records `abandoned_usage_unknown`, requeues work, marks
accounting unknown, and pauses ambient; provider overrun keeps actual counts
and blocks further launches. The elapsed watchdog aborts/requeues an already-
started run rather than pretending it never dispatched. Success resets the
lane failure counter. Degradation follows reverse registry priority; attended
chat is metered and context-bounded later, never gated or leased here.

### M25.3 — Durable scheduler + portable ingest receipts
Persist vault-scoped item/hash, event cursor, pending state, route, backoff,
and the full normalized prior snapshot. Launch catch-up diffs that snapshot
through the budget gate, fixing first-scan blindness; delete the mtime-based
`behind` heuristic — the `behind` registry row survives, repurposed as this
hash-diff launch catch-up lane; only the mtime feeder dies. Enforce only `pending → claimed(run_id, lease) → consumed |
pending_review | failed_visible`; a claim is conditional on pending state, and
crash recovery always finds either unclaimed work or one recoverable lease.

Emit validated, telemetry-free `ingest.assessed` receipts under the design's
closed route matrix. Every route has one allowed verdict, reducer/scheduler
state, required/forbidden ref shape, and recovery destiny: deterministic
queued work restores pending review, M26 queued work restores pending, and
`failed_visible` restores `recovery_held`. Receipts never enter
lineage/Support, but exact source+artifact receipts rebuild scheduler state
after runtime loss.

Every changed item's new Observation(s) and first receipt are trusted members
of one M22 logical batch, including non-material close and M26 queue. A no-
change receipt may repeat an existing Observation ref. Deterministic proposal
apply/queue/reject batches Observations, lifecycle/mutations, and receipt;
reserve `m26_outcome_event_id`, and M26 completion batches its semantic outcome
and successor receipt. Kill-point tests prove there is no changed Observation,
queued work, or applied proposal without its portable source-item association.

Persist append-only responsibility versions and typed launch
`catchup_outcomes` with `caught_up | retention_lost |
declared_deadline_missed | not_applicable`. Heartbeat each open vault session
every 60 seconds; a clean close yields exact closure, otherwise the last
heartbeat is a persisted lower bound. That same timestamp selects the
contract's half-open active interval and computes duration. Each outcome pins
version/digest/precision; link material misses to a `coverage.gap` carrying
the same responsibility fields. These rows make M28 R10 exactly queryable
after later contract edits, while ordinary delay, quota backoff, and source
outage remain non-qualifying.

### M25.4 — Complete coverage model
Implement `coverage.fact_recorded`, `coverage.assessed`, `coverage.gap`, and
`coverage.restored` bodies, validation, reducer/index state, M24 assessment
lookup, runtime cache rebuild, and shared Rust/TS conformance vectors. Build
the fact producers the design assigns: index facts stamped only by
`system:vault-indexer`, retrieval facts (execution receipt or window-closed-
without-attempt) only by `system:retrieval-engine`; the core stamps actor,
source/registration binding, producer kind/version, time, and receipt fields —
no proposal, agent DTO, connector response body, or prior assessment authors
one. All seven dimensions remain required and separately cache
`{ state, basis_event_ids, as_of }`; yes/no needs a non-empty basis of
committed `coverage.fact_recorded` IDs, unknown/not-applicable needs a
dimension-specific limitation.
Freeze the canonical retrieval-receipt fields M22/M24 use for formal absence.
Reducer currentness uses sequence, while policy may enforce each dimension's
age. Gap restoration is subset-checked and may be partial until the final
remaining dimension closes the episode; assessment/gap/restoration IDs have
stable append-once keys. Source and reasoning-runtime causes use different
health tables and gap semantics; a runtime gap never mutates source
connection/health.

### M25.5 — Materiality prefilter + exhaustive routing
Build Rust content-hash/per-field diff over before/after normalized snapshots.
Verdicts are exactly `no_change | non_material_change |
material_candidate(dimensions) | needs_semantic_judgment`. World/belief
dimensions come from field diff; evidence from hash/lineage; residual attention
ambiguity is semantic. Independence is
`known_same_lineage | known_independent | independence_unknown`; only positive
recorded independence can yield corroboration, while
`independence_unknown` routes semantic.

M25.5 also builds the two deterministic positive-independence producers (the
design's "The materiality prefilter (Rust)" section): ship
`shared/policy/independence-rules.v1.json` (`format: 1, rule_version: 1`,
`distinct_firsthand_origin`, `independent_system_artifact`), loaded
byte-identically by Rust and reducer validation, `rule_version` bumped by any
predicate change and pinned by every event. When a changed item introduces an
eligible endpoint, the trusted prefilter emits M22
`observation.independence_recorded` members in canonical unordered
endpoint-pair order inside the defined batch order — new Observation(s),
independence facts, deterministic proposal/M26 queue members, first receipt —
with each fact advancing both endpoint Observation versions exactly once under
M22 CAS and the receipt's operation digest covering the facts. A crash exposes
neither a positive edge without its source-item receipt nor a corroboration
claim without the edge; failed positive conditions emit nothing and leave
`independence_unknown`.

Every verdict is consumed: no-change and non-material close deterministically
(without deleting epistemic observations) as `closed_no_change` and
`closed_non_material`; a deterministic material candidate terminates as
`deterministic_proposal_applied | deterministic_proposal_queued |
deterministic_proposal_rejected`, otherwise it becomes `m26_queued`.
Needs-semantic always becomes `m26_queued`. M26 may supersede only that queued
receipt with `m26_completed` or `failed_visible`; completed proposal refs must
match the semantic outcome, while failed-visible requires a `blocked_visible`
outcome and no proposal refs. Validate sorted/unique required arrays and null/
empty forbidden refs. Stable append-once keys prevent identical rescans from
appending or charging again. Agents remain off, so M26 queues are visible but
undispatched. Git/projection operations enqueue no LLM-warranted work.

### M25.6 — Quota exhaustion, health, and failure surfacing
On quota/ratelimit failure with exact usage, one finalization transaction
requeues claims, reconciles/releases reservations and lease, sets vault/lane
backoff keyed to the 5-hour window, updates `runtime_health`, and shows N
unprocessed. Missing usage takes the accounting-unknown lease-recovery path;
it never assumes zero. Connector failure updates `(store_uuid, source_id)`
connection and/or source-health state according to what failed, with distinct
copy. Those adapter probes are the connection/health/scope/access/retention
`coverage.fact_recorded` producers — emitted only by the connector/builtin
adapter bound to the pinned M22 registration — so the threshold assessments
below cite committed fact IDs, never bare states.
After the default 24-hour materiality threshold with pending work, create the
complete assessment/gap events; recovery produces `coverage.restored` with its
new assessment. Scan/parse/extraction failures use per-item rows and separate
“N items failed ingestion” copy.

### M25.7 — The control surface
Titlebar: subscription-wide global pause. Panel: vault-scoped lane toggles,
global cross-vault budget meter, vault-filterable Activity log (run → tokens →
proposals → applied/rejected), distinct health/failure banners, and visible
baseline/recovery-held choices. These banners and the meter are the §35
contribution: feeders for the Epistemic Status surface that lands across
M25–M27. Human UI actions keep store-layer never-throw.
Playwright uses fixed mock shapes, not a second budget engine.

### M25.8 — Checkpoint collapse + soak
Git checkpoints collapse to one commit per applied M22 logical batch (the
M21.7 trailer already carries the head). The simulated-day soak covers two
vaults, file churn, git checkout, quota failures, app restarts, DB deletion,
and corruption. Assert ≤20 global ambient runs, exact global arithmetic,
vault scheduler/source isolation, zero mtime spend, all routes exercised, no
automatic recovery spend, and every failure visible.

## Acceptance matrix

| Scenario | Must hold |
| --- | --- |
| CLI result event with usage | tokens on vault/store-scoped run; global budget debited for ambient only |
| first/default or edited budget window | exact daily/per-run/failure/elapsed/warning snapshot plus settings version/digest is immutable; edits begin next window |
| budget change then revert inside M28 R2 window | both immutable versions remain detectable; observation window is not silently accepted from the repeated digest |
| historical gate decision | joins its immutable day/settings snapshot and reproduces observed counters, reservation, verdict, and typed reasons |
| two vaults run ambient work | scheduler/source rows isolated; one shared subscription ceiling |
| each prior `user_version` / injected migration failure | migrates atomically or rolls back intact; ambient pauses visibly |
| corrupt runtime DB | original quarantined; fresh DB starts in conservative recovery |
| runtime.db deleted mid-day | ambient does not dispatch; exact receipts rebuild; ambiguity held for explicit rebaseline/reprocess; spend remains unknown |
| first upgrade from legacy state | mappable state imported, normalized baseline stored, volatile ambiguity held, no automatic stampede |
| git checkout over soak vault | zero LLM-warranted queue entries |
| corroborating duplicate content arrives | material_candidate(evidence-state) despite zero field diff |
| two sources in registered-independent domains (or distinct firsthand actors) assert one value | deterministic `observation.independence_recorded` (`known_independent`) emitted in batch order with pinned rule version — the positive fact the corroborating-duplicate row above depends on |
| independence is unknown | `independence_unknown`; never corroboration; routes needs_semantic_judgment |
| every ingest route | allowed verdict, required/forbidden refs, scheduler state, and recovery destiny match the closed matrix; `failed_visible` restores held |
| no/non-material verdict | deterministic close; changed Observation and receipt atomic; no LLM |
| material-candidate without deterministic mapper | Observation + durable next-M26 queue receipt atomic |
| needs-semantic verdict | Observation + durable next-M26 queue receipt atomic, never dropped |
| identical artifact retry | stable append-once keys add no receipt/gap/restoration and incur no charge twice |
| coverage assessment | all seven `{state,basis_event_ids,as_of}` values persist independently; M24 can resolve its ID |
| committed `coverage.fact_recorded` | a yes/no assessment naming it in its basis validates; per-dimension `as_of` equals the greatest basis fact's |
| yes/no assessment with an empty basis or uncommitted fact IDs | refused |
| formal absence coverage | canonical query strategy/domain/scope/window match byte-for-byte; global timestamp/basis substitution refused |
| partial then final coverage restoration | only named remaining dimensions close; gap stays open until the final one |
| runtime quota gap | runtime health/gap only; source health fields unchanged |
| quota death with exact usage | one finalization transaction requeues claims, reconciles reservations/lease, sets window backoff, and names N |
| crash, expired lease, or missing usage | claims requeue; run/accounting become unknown; ambient pauses and never charges zero |
| scan/parse/extraction failure | per-item record; "N items failed ingestion" banner, distinct from quota copy |
| ambient budget exhausted | ambient halts by lane priority; attended chat unaffected |
| each preflight ambient gate exhausts independently | typed run/token/output/failure/backoff/busy/reservation reason; subprocess never starts |
| elapsed limit fires | already-started run aborts/requeues and retains exact-or-unknown usage; not represented as no dispatch |
| dispatch kill point | item is pending or owned by one recoverable lease; global ambient concurrency never exceeds one |
| global pause | persisted across restart; nothing ambient runs |
| app closed a week, reopened | catch-up via hash-diff through budget gate; no stampede |
| declared catch-up contract misses retention/deadline | selected contract version/digest + clean/heartbeat precision + linked gap use one timestamp; M28 R10 remains reproducible after edits |
| crash around proposal/outcome receipt | prior queued state or complete terminal batch, never an unassociated apply |
| e2e suite | boots and passes with distiller disabled exactly as before |

## Traps

- **Telemetry leakage is the native failure mode of this milestone** — the
  D5/amendment-7 split is the review checklist item on every commit.
- **demo-vault mtimes remain sacred** during soak tests — copy first.
- The CLI stream format is external: parser tests use recorded fixtures;
  never assert against live CLI output in CI.
- **Migration must match reality:** only attempts/triggers/skills are imported
  from localStorage; scan/pending was volatile. Never fabricate a prior
  snapshot or silently consume ambiguity.
- **Portable receipts are not telemetry or evidence:** no token/model/quota
  fields and no lineage/Support effect. Their materiality is observability and
  safe scheduler reconstruction.
- **Coverage summaries are projections:** do not store a single “partial”
  value in place of the seven dimensions, or infer source health from CLI
  health.
- Concurrency: background stays 1 inside MAX_CONCURRENT_RUNS=4 so chat
  always has headroom (D6) — M25 encodes it as a runtime-DB-enforced cap,
  not a comment.
- Gates: `pnpm test:run`, full Rust gate, `PORT=5273 pnpm e2e`, never
  `--no-verify`.

## Exit criteria

The two-vault simulated day produces ≤20 ambient runs globally with exact
accounting · every failure mode is visible, none silent · git operations cost
zero tokens · every prefilter verdict has a tested destination · coverage is
uncollapsed and M24-addressable · the control surface ships (pause, lanes,
meter, Activity log, recovery choices) · scheduler state is scoped/durable ·
upgrade and runtime-DB recovery never auto-spend ambiguous work · full gates
and new e2e specs green.
