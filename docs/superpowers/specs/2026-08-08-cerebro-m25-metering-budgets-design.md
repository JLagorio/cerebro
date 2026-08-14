# Cerebro M25 — Metering, Budgets, and the Deterministic Pipeline Services — Design

**Date:** 2026-08-08
**Status:** Derived from the accepted Rev 3 roadmap (D5/D6/D10, amendment 7) and the frozen coverage matrix (rows §17, §22, §29, §35, §46, §52, §53, §61, §62, §63, §75, §85, §86, §90, §97). For owner review.
**Scope:** The meter, global subscription budget, vault-scoped durable
scheduler, uncollapsed coverage model, four-dimension materiality prefilter,
quota-honest failure and database-recovery handling, and the control surface —
everything M26's "on by default" is only defensible on top of.
**Companion plan:** `../plans/2026-08-07-cerebro-m25-metering-budgets.md` sequences the implementation. Where the two disagree, this spec wins.

## Context

The source spec assumed an org-scale runtime; this product runs on **the
owner's personal Claude CLI subscription** — no API key, quota shared with
the owner's own chat usage. Today the app cannot even measure spend: usage
fields in the CLI's stream-json result events are discarded on the wire
(agent.rs), the distiller's `behind` heuristic keys on mtime (okf.ts:407 — a
git checkout floods the queue), scan and pending sets live only in hook
memory, while attempts/triggers/skills live in localStorage, and a failed run
is recorded 'failed' and forgotten (useJobRunner.ts:405-409). There is no
durable scheduler yet; M25 must migrate the pieces that exist without
describing localStorage as more complete than it is.

**The honesty rule: quota death becomes visible runtime-health, never
silence.** After M25, every failure mode has a face.

## Governing invariants

1. **Operational ≠ epistemic — two durable stores (amendment 7).** The vault
   ledger holds portable epistemic history; the runtime DB holds scheduler
   queues, rate limits, token accounting, retries, transient health. An
   operational event is *reflected into* the epistemic ledger only when it
   materially affects knowledge coverage ("connector unavailable for three
   days" → coverage event; "retry scheduled in 37 seconds" → never). Every
   new event type declares its home at design time; when in doubt,
   operational — promotion into the ledger requires a coverage-materiality
   argument.
2. **The prefilter gates LLM spend, never epistemic recording.** Materiality
   has four dimensions — world-state, belief-state, evidence-state, attention
   (§17). Independent corroboration is material even when the believed value
   is unchanged (single-source → corroborated), so "no field changed →
   discard" is forbidden. The prefilter decides only whether an LLM run is
   warranted.
3. **Reasoning-runtime health ≠ source health (§86).** A dead CLI quota means
   evidence exists but cannot currently be processed. A dead connector means
   reality may be changing unobserved. Different semantics, different tables,
   different banners. Collapsing them is a review-blocking defect.
4. **Attended chat is never budget-blocked; ambient always is.** Attended
   runs are metered (counted); only ambient is budgeted (gated).
5. **App-global storage never means cross-vault identity.** `runtime.db` is
   shared by every open vault, so scheduler, run, source, coverage-cache, and
   failure rows carry `vault_id` and/or the ledger's stable `store_uuid`.
   Subscription spend is the exception: one CLI account means one global
   daily ambient budget summed across vaults.
6. **Coverage dimensions never collapse (§46).** Connection, source health,
   known scope, accessible scope, retention knowledge, index currency, and
   attempted retrieval are separate fields. A UI summary such as “partial”
   is a projection, never stored source truth. Runtime health remains a
   different record and cannot write `source_healthy` by implication.

## Runtime DB schema (growth owned here, additive to M24's `operational_log`)

```
runs            (run_id PK, vault_id NULL, store_uuid NULL, mode, lane,
                 started_at, ended_at NULL, outcome, usage_state,
                 input_tokens, output_tokens, cache_read, cache_write,
                 reserved_total_tokens, reserved_output_tokens, lease_expires_at NULL,
                 proposals_submitted, applied, rejected)
budget_days     (window_start_utc PK, window_end_utc, timezone_id,
                 settings_version, settings_digest,
                 max_daily_runs, max_daily_tokens, max_daily_output_tokens,
                 max_ambient_run_tokens, max_ambient_run_output_tokens,
                 max_consecutive_failures, max_run_elapsed_seconds, warning_ppm,
                 accounting_state, ambient_tokens_used, ambient_output_tokens,
                 reserved_total_tokens, reserved_output_tokens,
                 ambient_runs_started, ceiling_state, ceiling_reasons)
budget_settings_versions (settings_version PK, settings_digest, recorded_at,
                          effective_window_start_utc, timezone_id,
                          max_daily_runs, max_daily_tokens, max_daily_output_tokens,
                          max_ambient_run_tokens, max_ambient_run_output_tokens,
                          max_consecutive_failures, max_run_elapsed_seconds, warning_ppm)
ambient_gate_decisions (decision_id PK, attempted_at, vault_id, store_uuid, lane,
                        window_start_utc, settings_version, settings_digest,
                        total_reservation, output_reservation,
                        used_total_tokens, used_output_tokens, runs_started,
                        reserved_total_tokens, reserved_output_tokens,
                        decision, reasons)
ambient_dispatch (singleton_key PK CHECK 'ambient', run_id UNIQUE,
                  vault_id, store_uuid, lane, acquired_at, lease_expires_at)
app_sessions    (session_id, vault_id, store_uuid, opened_at,
                 last_heartbeat_at, clean_closed_at NULL, close_precision)
lane_registry   (lane PK, priority UNIQUE, enabled_by_default, introduced_version)
ambient_gate_state (vault_id, store_uuid, lane,
                    consecutive_failures, active_run_started_at, last_outcome)
scheduler       (vault_id, store_uuid, item_key, source_id, content_hash,
                 normalized_prior_snapshot, normalizer_version,
                 processing_epoch, event_cursor, route, state,
                 claimed_by_run_id NULL, claim_expires_at NULL,
                 first_seen, updated_at)
backoff         (vault_id NULL, lane, until, reason, quota_window_key)
source_registration (store_uuid, source_id, registration_event_id, kind,
                     source_key, actor_id NULL, connector_instance_id NULL,
                     logical_scope_id NULL, service_id NULL,
                     legacy_resource_hash NULL,
                     authority_capability, independence_domain_id NULL)
source_connection (store_uuid, source_id, state, since, detail)
source_health   (store_uuid, source_id, state, since, detail)
runtime_health  (component, state, since, detail)
coverage_cache  (store_uuid, assessment_id, source_id, subject_id,
                 predicate_class, scope_digest,
                 event_id)
coverage_dimension_cache (store_uuid, assessment_id, dimension, state,
                          basis_event_ids_json, as_of)
ingestion_failures (vault_id, store_uuid, item_key, stage, detail, first_seen,
                    last_seen, resolved_at)
responsibility_contracts (store_uuid, responsibility_id, contract_version,
                          contract_digest, source_id, subject_id,
                          predicate_class, scope_digest, retention_seconds,
                          deadline_seconds, active_from, active_to NULL)
catchup_outcomes (vault_id, store_uuid, episode_id, responsibility_id,
                  contract_version, contract_digest,
                  app_closed_at, close_precision, reopened_at, resolved_at, coverage_gap_id,
                  outcome, detail)
settings        (key, vault_id NULL, value)
```

This is an executable relational contract, not a column-name sketch. Tokens,
counts, versions, priorities, and durations are non-negative integers; hashes
are lowercase SHA-256; times are RFC3339 UTC. Primary/unique keys are:
`runs(run_id)`, `budget_days(window_start_utc)`, immutable budget settings on
`settings_version`, gate decisions on `decision_id`, the singleton ambient lease,
`app_sessions(session_id, vault_id, store_uuid)`, `lane_registry(lane)`,
`ambient_gate_state(vault_id, store_uuid, lane)`,
`scheduler(vault_id, store_uuid, item_key)`,
`backoff(vault_id, lane, quota_window_key)`, source tables on
`(store_uuid, source_id)` with unique registration event IDs,
`runtime_health(component)`, coverage cache on
`(store_uuid, assessment_id)` plus dimension rows on
`(store_uuid, assessment_id, dimension)`, with a current-lookup index over
`(store_uuid, source_id, subject_id, predicate_class, scope_digest)`, failures
on `(vault_id, store_uuid, item_key, stage)`, contracts on
`(store_uuid, responsibility_id, contract_version)`, and outcomes on
`(store_uuid, episode_id, responsibility_id, contract_version)`. Global
settings/backoff use partial unique indexes for `vault_id IS NULL`; SQLite NULL
equality is never relied upon. A run's vault/store fields are either both null
for a genuinely app-global attended operation or both non-null. Ambient runs
are always vault/store scoped; `ambient_gate_state` therefore forbids null IDs
and needs no nullable-composite exception.

Closed enums are:

- `mode = attended | ambient`;
- `outcome = running | succeeded | failed | quota_failed | elapsed_aborted |
  cancelled | abandoned_usage_unknown`;
- `usage_state = pending | exact | unknown`;
- `accounting_state = exact | unknown`;
- session `close_precision = open | clean_exact | heartbeat_lower_bound`;
- scheduler `state = baseline_held | recovery_held | pending | claimed |
  pending_review | consumed | failed_visible`;
- `ceiling_state = under_budget | warning | exhausted`;
- `CeilingReason = daily_runs | daily_tokens | daily_output_tokens`; and
- `GateReason = global_pause | accounting_unknown | lane_disabled |
  daily_runs | daily_tokens | daily_output_tokens | consecutive_failures |
  quota_backoff | ambient_busy | reservation_exceeds_remaining |
  reservation_exceeds_run_cap`.

`lane` is closed by `lane_registry`, not by arbitrary strings. M25 seeds the
current priority order `filed, scheduled, agent, behind, refresh, stale,
schema`; a later milestone must add a lane by migration before dispatch can
name it. The `behind` row survives repurposed as the hash-diff launch
catch-up lane; only its mtime feeder is deleted (below). `ceiling_reasons` is the sorted unique set of `CeilingReason`s whose
limits are hit; gate-only reasons never leak into that column.
`ambient_gate_decisions.decision = proceed | deferred`; its reasons are the
sorted unique closed `GateReason` set and are empty exactly for `proceed`.

`vault_id` is the app's stable registration for a vault path; `store_uuid` is
the portable ledger identity. Vault-bound rows carry both when both are known,
and all uniqueness keys/referential validation include the relevant scope. A path,
display name, or `source_id` alone can never collide work between vaults.
`budget_days` deliberately has no vault column: it meters the one personal CLI
subscription globally. `source_connection` and `source_health` are separate
live operational signals and foreign-key the portable-registration cache.
`source_registration` is a byte-faithful projection of M22's closed
`SourceRegistration` union; its kind is exactly `human_actor | connector |
builtin | cerebro_runtime | legacy_reference`, never a provider guess. A
legacy registration is `content_only`, has no independence domain, cannot
produce connector health/authority/independence facts, and begins with unknown
coverage until another trusted fact applies. Missing runtime rows rebuild from
`source.registered`; a source reference with no committed registration is
held/refused, never inferred. M28 R7 filters this exact same-store cache by
`kind = connector`. `runtime_health` is app-global; a component detail
may name affected vaults, but it is neither of those source signals.
`coverage_cache` is only a query cache of portable ledger events and rebuilds
from them; predicate and canonical scope digest are present so two assessments
for the same entity/source cannot collide.

Responsibility contracts are append-only versions. Editing or disabling one
sets the old row's `active_to` and inserts the next version in one transaction;
historical rows are never overwritten. Each catch-up outcome stores the exact
version and digest whose half-open `[active_from, active_to)` interval contains
`app_closed_at`. This makes “the declared contract active during the episode”
reproducible after later owner edits.

Every schema change is a numbered `PRAGMA user_version` migration run inside
one SQLite transaction (`BEGIN IMMEDIATE` → DDL/data copy/validation → set
`user_version` → commit). A failed migration rolls back to the prior readable
schema, sets ambient processing paused, and surfaces the failing version; it
never half-creates tables. Startup runs `quick_check` (and `integrity_check`
after an unclean shutdown). On corruption, preserve the original as a
timestamped `runtime.db.corrupt-*` artifact, create a fresh DB, and enter the
same conservative recovery mode below. Do not delete or silently overwrite
the only diagnostic copy.

### One-shot upgrade baseline

The pre-M25 state is split: current scan/pending data is volatile hook memory;
attempts, triggers, skill state, and the e2e kill switch are in localStorage.
On first M25 open, one transactional importer:

1. imports mappable attempts/triggers/skills with their current normalized
   content hash and store/vault scope;
2. computes a normalized snapshot for every current item and stores it as
   `normalized_prior_snapshot` (not just a hash, so restart diff is possible);
3. marks items backed by a legacy processed record as consumed; and
4. parks items with no trustworthy predecessor as `baseline_held` instead of
   inferring that volatile pending memory survived restart.

The UI names the held count and offers explicit **Use current state as
baseline** or **Process these items**. Either decision is durable. The import
sets its completion marker only in the same commit as all rows. The existing
localStorage background-disable kill switch remains read-compatible through
the transition, so e2e never launches ambient work.

### Missing/corrupt DB recovery — no impossible promise

Deleting `runtime.db` also deletes token telemetry, so M25 cannot honestly
guarantee “no re-spend.” Instead, startup automatically pauses ambient work
before any dispatch and reconstructs item/hash state from portable
`ingest.assessed` receipts in each ledger. Current content with an exact
consumed-route receipt (or its referenced terminal proposal/M26 outcome) is
restored as consumed; `deterministic_proposal_queued` restores pending review,
`m26_queued` restores pending M26, and `failed_visible` restores
`recovery_held`, never consumed. Changed, missing, or ambiguous items also
enter `recovery_held`; they are never automatically sent to an LLM. The owner must
explicitly rebaseline or reprocess them. Because today's global spend cannot
be reconstructed from epistemic receipts, the budget state is `unknown` and
ambient remains paused until the next daily window or an explicit owner-set
baseline. Attended chat remains available and metered from recovery onward.
The guarantee is **no automatic duplicate spend**, not no possible re-spend
after an explicit owner choice.

## Usage metering

agent.rs stops discarding usage: every stream-json result event's token
counts land on the run record, lane-attributed, attended and ambient alike.
The CLI's wire format is external and drifts: parse defensively, record the
presence of unknown fields in operational_log, and regression-test the parser
against recorded (sanitized) fixtures of real CLI stream output — never
against live CLI output in CI.

## The daily ambient budget

Ambient limits are owner-editable settings loaded from one versioned defaults
artifact, never scattered constants:

| Setting | Shipped v1 default |
|---|---:|
| `max_daily_runs` | 20 |
| `max_daily_tokens` | 200,000 |
| `max_daily_output_tokens` | 40,000 |
| `max_ambient_run_tokens` | 20,000 |
| `max_ambient_run_output_tokens` | 4,000 |
| `max_consecutive_failures` | 3 |
| `max_run_elapsed_seconds` | 600 |
| `warning_ppm` | 800,000 |

Every budget edit appends a `budget_settings_versions` row, even when its
content reverts to an older digest; rows are immutable and versions are never
reused. The edit is recorded immediately but becomes effective only when the
next local-day window opens. Each `budget_days` row then copies the complete
effective daily-ceiling, per-run, failure, elapsed, and warning snapshot and
pins its settings version plus canonical SHA-256 digest. Generic current
`settings` is not an authority for a budget decision. This lets M28 detect any
edit during an R2 observation window, including change-and-revert, and
reproduce each ordinary historical gate decision.

`budget_timezone` defaults to the system IANA zone captured in the initial
settings version. A window is the half-open interval between consecutive local
midnights converted to UTC; DST therefore produces honest 23/25-hour windows.
A timezone edit, like every budget edit, takes effect only at the next window.
`ceiling_state` remains exactly `under_budget | warning | exhausted`: warning
begins when any exact used-plus-reserved quantity reaches the day's
`warning_ppm`; exhausted names every hit `CeilingReason`. The separate
`accounting_state` carries `unknown`, so DB loss or missing usage never
masquerades as a fourth ceiling value.

All ambient runs, regardless of vault, reserve against the same window row.
The reservation is the launcher's declared total/output per-run cap, each no
larger than the active `budget_days` row's copied per-run limits — a
violation defers with `reservation_exceeds_run_cap`, while
`reservation_exceeds_remaining` stays the daily-headroom code. The shipped
v1 values only initialize the first settings version. `ambient_tokens_used` is
the sum of the CLI fixture-defined disjoint `input + output + cache_read +
cache_write` fields; output is also tracked separately. Before dispatch, one API —
`budget_gate(vault_id, lane, total_reservation, output_reservation) → proceed |
deferred(GateReason)` — checks pause/accounting state, registered/enabled lane,
all three used-plus-reserved daily limits, quota backoff, consecutive failures,
and the singleton ambient lease.

Gate, reservation, scheduler claim, run insertion, and lease acquisition occur
inside one `BEGIN IMMEDIATE` transaction. Only after commit does the subprocess
spawn. Completion uses a second transaction to record exact usage, release the
reservation/lease, and consume or requeue the claimed items. A successful run
resets its lane failure counter. The elapsed watchdog aborts an **already
started** run at `max_run_elapsed_seconds`, so its acceptance is abort/requeue,
not “no dispatch.” An expired lease marks the run
`abandoned_usage_unknown`, requeues its items, sets accounting unknown, and
pauses ambient work; a missing terminal usage record does the same. If the
external CLI ever reports more than the reservation, actual counts are kept,
the window becomes exhausted/accounting-unknown, and no further ambient run
starts. The ceilings are therefore hard dispatch ceilings; the doc does not
pretend an already-spent provider overrun can be undone.

Every gate decision records the budget window, immutable settings version/hash,
requested reservations, observed used/reserved/run counters, decision, and
typed reasons. Degradation halts lowest-priority registered lanes first
(reverse `lane_registry.priority`) at warning/exhaustion; attended chat is
metered but never enters this gate, reservation, or ambient lease. The
acceptance row "ambient halts by lane priority" traces to this transaction, not
to a meter readout.

## Durable scheduler

The new scheduler makes the processed-hash ledger, event cursor, pending set,
normalized prior snapshot, route, and backoff durable in `scheduler`/
`backoff`. This is a migration from the split hook-memory/localStorage state
described above, not a claim that a durable-shaped scheduler already exists.
Launch catch-up = normalized content/hash diff through the budget gate —
fixing the first-scan-yields-zero-events blindness for the app-closed period.
The mtime-based `behind` heuristic is **deleted**, replaced by content-hash
comparison against the vault-scoped scheduler rows; that catch-up work
dispatches on the surviving `behind` registry lane.

`pending → claimed(run_id, lease) → consumed|pending_review|failed_visible`
is the only dispatch state machine. Claim requires `state = pending`; lease
expiry follows the conservative unknown-usage recovery above. A quota failure
with exact usage returns claimed items to pending in the same transaction that
sets backoff; no separate “un-consume later” window exists. A process crash at
any transaction boundary yields either unclaimed work or a recoverable lease,
never an item with no owner and no receipt.

Two compatibility constraints:

- The localStorage kill switch e2e boot relies on (background distiller
  disabled) keeps working through the migration — e2e must boot exactly as
  before.
- The one-shot importer above preserves mappable legacy attempts/triggers/
  skills, baselines normalized snapshots, and visibly holds ambiguity; first
  post-upgrade launch never re-queues the whole vault automatically.

M25 also makes D10's future service trigger measurable without pretending a
daemon exists. An owner-declared, append-only version of a
`responsibility_contract` pins source, subject, predicate, and scope plus
retention and catch-up deadlines. On launch, catch-up writes one
`catchup_outcomes` row per closed-app interval and active contract version with exact
outcome `caught_up | retention_lost | declared_deadline_missed |
not_applicable`, stores that version/digest, and links any material miss to
`coverage_gap_id`. Ordinary delay, quota backoff, and source outage receive
non-qualifying outcomes. These rows are the M28 R10 numerator; the linked
portable gap explains the epistemic coverage effect.

The interval is not inferred from a nonexistent shutdown callback. While a
vault is open, `app_sessions` writes a durable heartbeat every 60 seconds; a
clean close stamps `clean_closed_at` in the same row. The next session sets
`app_closed_at` to that clean stamp with `clean_exact`, otherwise to the last
durable heartbeat with `heartbeat_lower_bound`; `reopened_at` is the next
session's `opened_at`, and `resolved_at` is when catch-up reaches its terminal
outcome. The lower-bound precision is persisted and visible in the R10 sample.
The same deterministic timestamp selects the active contract version and
computes duration, so an unclean exit cannot fabricate a precise shutdown time
or use file mtime.

## The materiality prefilter (Rust)

Given before/after of a watched artifact, emit a deterministic verdict:

```
no_change | non_material_change | material_candidate(dimensions)
| needs_semantic_judgment
```

`needs_semantic_judgment` is a *queue tag* for M26, not a call — Rust filters
the obvious; the LLM judges residual ambiguity (D6/amendment 5). Git
operations and projection regeneration cost **zero tokens** by construction.
Evidence-state materiality: a second independent lineage for an existing
value IS `material_candidate` even with zero field changes.

Per dimension, the deterministic mechanism: world-state and belief-state
candidates come from the per-field diff; evidence-state comes from
content-hash/lineage work — duplicate detection plus new-independent-source
detection (the zero-field-change corroboration case above); residual
attention-dimension ambiguity is tagged `needs_semantic_judgment` for the
LLM residual (D6) — escalated, never silently discarded.

Every verdict has one terminal route; none falls out of a switch statement:

| Verdict | Scheduler/result route |
|---|---|
| `no_change` | close as `closed_no_change`; no proposal and no LLM |
| `non_material_change` | close as `closed_non_material`; the underlying observation/capture remains recorded, no LLM |
| `material_candidate` | if a deterministic mapper can produce a complete M24 proposal, submit it through policy; otherwise enqueue the item in the next M26 ingest batch |
| `needs_semantic_judgment` | always enqueue in the next M26 ingest batch |

M25 does not dispatch those M26 queues while agents are off; it persists and
surfaces them. `material_candidate` therefore cannot disappear just because
the semantic consumer lands one milestone later.

Independence input uses M22's exact tri-state vocabulary:
`known_same_lineage | known_independent | independence_unknown`. Only a
positive `known_independent` record can produce corroboration.
`independence_unknown` is not weak corroboration; it routes to
`needs_semantic_judgment`. The scheduler stores the
normalized prior snapshot used to produce the diff, so restart repeats the
same verdict rather than comparing only two hashes with no recoverable before
state.

M25 owns the two deterministic positive producers under one shared artifact,
`shared/policy/independence-rules.v1.json = { format: 1, rule_version: 1,
distinct_firsthand_origin: {...}, independent_system_artifact: {...} }`.
Rust and reducer validation load the same bytes; changing either predicate
bumps `rule_version`, and the event pins it.

- `distinct_firsthand_origin` requires two assertion Observations with
  `authority_provenance: trusted_human_capture`, `assertion_basis: firsthand`,
  pinned `human_actor` registrations, and different bound actor IDs.
- `independent_system_artifact` requires two assertion Observations with
  `authority_provenance: registered_direct_artifact`, pinned registrations
  whose core-derived capability is `registered_direct_artifact` (D11's term),
  non-null and different
  `independence_domain_id`s, and different source artifact hashes.

Both rules also require distinct endpoint IDs, matching endpoint registration
refs, and no lineage/derived-Belief ancestry path in either direction. Distinct
source IDs, connector names, files, or hashes alone never suffice. Failure of
any positive condition emits no independence event and leaves the verdict
`independence_unknown` (or `known_same_lineage` when an ancestry path exists).
The explicit M24 HIGH approval path is the only producer of `human_confirmed`.

When a changed item introduces an eligible endpoint used for corroboration,
the trusted prefilter emits M22 `observation.independence_recorded` members in
canonical unordered endpoint-pair order, with the exact proof tag,
left/right registration event IDs, rule version, and a closed server reason.
The logical batch order is new Observation(s), deterministic independence
facts, deterministic proposal/M26 queue members, then the first
`ingest.assessed` receipt. Each independence fact advances both endpoint
Observation versions exactly once under M22, including an earlier staged new
endpoint. The receipt's operation digest covers the facts. A crash exposes
neither a positive independence edge without its source-item receipt nor a
receipt/proposal that claimed corroboration without the edge.

## Coverage model and portable assessment events

M25 adds five event kinds to M22's additive vocabulary. They use the complete
M22 common body (including `schema`, actor/times, `batch_id`, and optional
`idempotency_key`) and the M22 stable `source_id`; paths, connector names, and
display labels are never identities.

Concretely, `source_id` is M22's opaque lowercase 128-bit hex ID, stable within
a store. It and `source_registration_event_id` must validate against the
portable `source.registered` event and M22's exact source-key union/formula;
M25 defines no second derivation. Runtime rows are keyed by `(store_uuid,
source_id)` and rebuild from that registry; provider, location, record, and
revision remain provenance, never identity.

### Trusted coverage facts — no assessment can bootstrap itself

The first new body is server-only and telemetry-free:

```text
CoverageFactDimension = source_connected | source_healthy | scope_known |
  scope_accessible | retention_known | index_current | retrieval_attempted
coverage.fact_recorded = {
  ...common, fact_id, source_id, source_registration_event_id,
  subject: { entity_id, predicate_class, scope },
  dimension: CoverageFactDimension, state: yes | no, as_of,
  producer: {
    kind: connector_adapter | builtin_adapter | vault_indexer | retrieval_engine,
    producer_version
  },
  fact:
    { kind: connection_probe, result: connected | disconnected }
  | { kind: health_probe, result: healthy | unhealthy }
  | { kind: scope_discovery, scope_digest, result: known | unknown }
  | { kind: access_probe, scope_digest, result: accessible | denied }
  | { kind: retention_discovery, result: known | unknown,
      retention_seconds: null | non_negative_integer }
  | { kind: index_checkpoint, index_head, source_revision,
      result: current | stale }
  | { kind: retrieval_execution, retrieval_receipt }
  | { kind: retrieval_window_closed_without_attempt,
      window_start, window_end }
}
```

The fact variant maps one-to-one, in the order listed, to its dimension;
result maps exactly to `yes`/`no`. `retrieval_execution` is `yes`, and the
closed-without-attempt variant is `no`. A `known` retention fact requires a
non-null value and `unknown` requires null. Connection/health/scope/access/
retention facts may be emitted only by the connector/builtin adapter bound to
the pinned M22 registration. Index facts are stamped only by
`system:vault-indexer`; retrieval facts only by `system:retrieval-engine`.
The core stamps actor, source/registration binding, producer kind/version,
time, scope digest, index head/revision, and receipt fields from the operation
it executed. No proposal, agent Observation DTO, connector response body, or
prior assessment can author this event directly. Its append-once key is
`fact_id`; different bytes under the same ID are refused.

`coverage.assessed` has this kind-specific body:

```json
{
  "assessment_id": "<stable-id>",
  "subject": {
    "entity_id": null,
    "predicate_class": null,
    "scope": { "stage": null, "revision": null,
               "environment": null, "geography": null }
  },
  "source_id": "<stable-source-id>",
  "dimensions": {
    "source_connected": { "state": "yes | no | unknown | not_applicable",
                          "basis_event_ids": [], "as_of": "<RFC3339>" },
    "source_healthy": { "state": "yes | no | unknown | not_applicable",
                        "basis_event_ids": [], "as_of": "<RFC3339>" },
    "scope_known": { "state": "yes | no | unknown | not_applicable",
                     "basis_event_ids": [], "as_of": "<RFC3339>" },
    "scope_accessible": { "state": "yes | no | unknown | not_applicable",
                          "basis_event_ids": [], "as_of": "<RFC3339>" },
    "retention_known": { "state": "yes | no | unknown | not_applicable",
                         "basis_event_ids": [], "as_of": "<RFC3339>" },
    "index_current": { "state": "yes | no | unknown | not_applicable",
                       "basis_event_ids": [], "as_of": "<RFC3339>" },
    "retrieval_attempted": { "state": "yes | no | unknown | not_applicable",
                             "basis_event_ids": [], "as_of": "<RFC3339>" }
  },
  "retrieval_receipt": null,
  "limitations": [
    { "dimension": "scope_accessible", "reason": "<plain-language limitation>" }
  ],
  "supersedes_assessment_id": null
}
```

`retrieval_receipt`, when `dimensions.retrieval_attempted.state: yes`, is
`{ strategy_version, query_strategy, query_fingerprint, attempted_at,
searched_domain, search_scope, observation_window, searched_aliases,
searched_scopes }`, with non-empty canonical strings, a SHA-256 query
fingerprint, RFC3339 attempt time, string aliases, and M22-shaped scope
objects. `searched_domain`, `search_scope`, `observation_window`, and
`query_strategy` use exactly the normalization stored in M22's absence block;
M24 compares those four strings byte-for-byte and separately checks structured
subject/scope compatibility. A `yes` assessment requires the receipt; every
other retrieval state requires it null. It records that retrieval occurred,
not that it was adequate. Every dimension is required and independently
sourced. A `yes`/`no` basis is a non-empty sorted/unique list only of committed
`coverage.fact_recorded` IDs for the same source, dimension, compatible
subject/scope, and exact state. It must include the latest applicable fact at
the assessment's pre-append head, and `as_of` equals the greatest fact
`as_of`; an assessment ID is never a basis ID. Carry-forward reuses the
original validated fact IDs, so an empty-basis `unknown` assessment cannot
bootstrap a later `yes`. For `retrieval_attempted: yes`, the basis is exactly
the latest matching `retrieval_execution` fact and `retrieval_receipt` is
byte-identical to that fact's receipt. Every other retrieval state requires
the receipt null.

`unknown` and `not_applicable` require an empty basis plus exactly one
limitation for that dimension, and their server-stamped `as_of` equals the
assessment event's `occurred_at`. Each dimension has its own `as_of`; reducer
sequence still selects the current assessment, while policy may additionally
enforce dimension-specific maximum age. In
particular, connected does not imply healthy, healthy does not imply scope is
known or accessible, and current indexing does not imply a retrieval attempt.
M24 `basis.coverage_refs` resolves `assessment_id` values from these records
and checks subject/scope/currentness plus each required dimension's own state,
basis, and age; it never substitutes one global timestamp/basis for all seven.

`coverage.gap` is:

```json
{
  "gap_id": "<stable-id>",
  "subject": { "entity_id": null, "predicate_class": null, "scope": {} },
  "source_id": null,
  "responsibility_id": null,
  "contract_version": null,
  "contract_digest": null,
  "cause": { "kind": "source | reasoning_runtime", "component": null },
  "opened_at": "<RFC3339>",
  "assessment_id": null,
  "affected_dimensions": ["source_healthy"],
  "pending_count_at_open": 12,
  "reason": "<material coverage impact>"
}
```

`coverage.restored` is:

```json
{
  "gap_id": "<stable-id>",
  "restored_at": "<RFC3339>",
  "assessment_id": null,
  "restored_dimensions": ["source_healthy"],
  "reason": "<demonstrated recovery>"
}
```

A source-caused gap requires a stable `source_id` and a current assessment; a
runtime-caused gap requires `source_id: null`, names the runtime component,
and may affect processing/index/retrieval currency but **never** rewrites
`source_connected` or `source_healthy`. Restoration must reference an open gap
and, for source gaps, the newer assessment demonstrating recovery. Affected
and restored dimensions are non-empty unique subsets of the seven-dimension
enum. Restored dimensions must be a subset of the gap's remaining dimensions;
a partial restoration keeps the gap open, and only restoring the final
remaining dimension closes it.

Assessment IDs use `append_once(assessment_id)`. `gap_id` is server-derived
from store, cause, responsibility contract version, subject/scope, and threshold episode
and uses `append_once(gap_id)`; restoration uses a stable key over gap,
assessment/recovery marker, and sorted dimensions. Retry can therefore neither
duplicate an open episode nor close it twice. `responsibility_id` is nullable
for ordinary gaps, but an M28 R10-eligible launch-catch-up miss requires the
matching version/digest and a linked terminal `catchup_outcomes` row.

`ingest.assessed` is the portable, telemetry-free processing receipt:

```json
{
  "receipt_id": "<stable-id>",
  "item_id": "<stable-source-item-id>",
  "source_id": "<stable-source-id>",
  "source_record_id": null,
  "artifact_hash": "<sha256>",
  "normalized_snapshot_hash": "<sha256>",
  "normalizer_version": "<string>",
  "processing_epoch": 0,
  "assessed_against_chain_head": "<ledger-head>",
  "prefilter_verdict": "no_change | non_material_change | material_candidate | needs_semantic_judgment",
  "material_dimensions": ["world_state | belief_state | evidence_state | attention"],
  "independence": "known_same_lineage | known_independent | independence_unknown",
  "route": "closed_no_change | closed_non_material | deterministic_proposal_applied | deterministic_proposal_queued | deterministic_proposal_rejected | m26_queued | m26_completed | failed_visible",
  "observation_event_ids": [],
  "proposal_ids": [],
  "m26_batch_key": null,
  "m26_outcome_event_id": null,
  "supersedes_receipt_id": null
}
```

It contains no tokens, retries, quota window, duration, or model metadata.
Those remain operational. It never enters evidence lineage or Support; it
records which stable source item/bytes received which deterministic
disposition so a new runtime DB can avoid automatic duplicate dispatch. The
closed route matrix is:

| Route | Allowed prefilter verdict | Reducer/scheduler state | Required refs | Forbidden refs | Recovery |
|---|---|---|---|---|---|
| `closed_no_change` | `no_change` | `consumed` | prior committed Observation refs may be repeated | proposals and all M26 refs | consumed |
| `closed_non_material` | `non_material_change` | `consumed` | ≥1 Observation | proposals and all M26 refs | consumed |
| `deterministic_proposal_applied` | `material_candidate` | `consumed` | ≥1 Observation; ≥1 proposal, all applied | all M26 refs | consumed |
| `deterministic_proposal_queued` | `material_candidate` | `pending_review` | ≥1 Observation; ≥1 proposal, all queued | all M26 refs | pending review, never ambient re-dispatch |
| `deterministic_proposal_rejected` | `material_candidate` | `consumed` | ≥1 Observation; ≥1 proposal, all rejected | all M26 refs | consumed; rejection remains visible |
| `m26_queued` | `material_candidate` or `needs_semantic_judgment` | `pending` | ≥1 Observation; `m26_batch_key` | proposals and outcome event | pending M26 |
| `m26_completed` | either M26 verdict | `consumed` | superseded queued receipt, same batch key, outcome event; proposal refs exactly match semantic outcome | none beyond outcome rules | consumed |
| `failed_visible` | either M26 verdict | `failed_visible` | superseded queued receipt, same batch key, `blocked_visible` outcome event | proposal refs | `recovery_held`; owner retry/rebaseline or changed bytes required |

`material_dimensions` is empty for no/non-material, non-empty for
`material_candidate`, and lists only deterministically known dimensions for
`needs_semantic_judgment` (possibly empty). `known_independent` requires a
positive recorded fact; `known_same_lineage` requires an ancestry path.
`supersedes_receipt_id` is null on first-stage rows and required on both M26
successor routes; successor and queued rows have the same processing epoch.
Every required array is sorted/unique, forbidden arrays are
empty, and forbidden nullable refs are null. The referenced
`ingest.semantic_assessed` body determines whether an M26 completion's proposal
list must be empty or non-empty; a mismatch is refused.

Receipts use `append_once` with an idempotency key over source/item/artifact/
normalizer/processing-epoch/route, so rescanning identical bytes cannot append
or charge again. Epoch 0 is automatic for a new artifact/normalizer pair. Only
the owner's explicit **Retry processing** action may transactionally increment
the epoch for unchanged bytes and return `failed_visible`/`recovery_held` work
to pending; every receipt and `m26_batch_key` in that new attempt pins the new
epoch. Automatic restart/rescan never increments it. Thus retry is possible
without either colliding with the failed receipt chain or silently creating a
second queue/terminal chain.

A receipt is part of the state transition it describes, not an after-the-fact
best effort. Every changed source item batches its new Observation(s) with its
first receipt, including `closed_non_material` and `m26_queued`; no-change may
reference an existing committed Observation and append only its idempotent
receipt. Deterministic proposal application, queue, or rejection batches the
Observation(s), proposal lifecycle/mutations, and receipt together. M26 does
the same with its semantic outcome and all successor receipts. Callers cannot
author these trusted completion members. A crash therefore exposes the prior
state or the complete Observation→route→proposal/outcome association, never an
Observation with lost work or an apply with no source-item link. Every member
participates in the operation digest and retry receipt.

The reducer adds `coverage_assessments`, `coverage_current` keyed by subject/
scope/source (latest reducer `seq`, never agent-supplied `as_of`),
`coverage_gaps`, and `ingest_receipts` keyed by source/item/artifact/
normalizer version. It refuses missing dimensions, stale/mismatched
supersession, invalid restoration, inconsistent routes, unknown source IDs,
and a corroboration claim without positive independence. Shared conformance
vectors cover every new kind, every refusal, supersession/current selection,
gap/restoration, runtime-vs-source non-collapse, and rebuild-from-zero.

M25 registers four additional CAS classes and closes every new event effect:

| Event | `state_versions` effects |
|---|---|
| `coverage.fact_recorded` | create `coverage_fact(fact_id)` at v1 and increment its existing `source(source_id)` once |
| `coverage.assessed` | create `coverage_assessment(assessment_id)` at v1; when superseding, increment the named prior assessment once |
| `coverage.gap` | create `coverage_gap(gap_id)` at v1; referenced source/responsibility/assessment records are read-only |
| `coverage.restored` | increment the named existing `coverage_gap` once, including each partial restoration |
| `ingest.assessed` | create `ingest_receipt(receipt_id)` at v1; when superseding an M26 queued receipt, increment that prior receipt once |

Creation requires expected null; superseded/restored targets require their
pre-batch current version. An M26 successor receipt therefore targets both its
new receipt ID and the prior queued receipt. No health-cache row, scheduler
row, retrieval receipt, batch marker, or portable ref has an implicit version
effect. Vectors assert each row, multi-part restoration, successor fold order,
same-batch staged facts/Observations, and byte-identical rebuild.

## Quota exhaustion and backoff

On quota/ratelimit failure with exact usage, one finalization transaction
returns claimed scheduler items to pending, reconciles/releases the reservation,
sets lane backoff keyed to the CLI's 5-hour window, records `runtime_health`
degraded, and surfaces "N items unprocessed". Missing usage takes the
accounting-unknown lease-expiry path instead of assuming zero spend. Source
connection and source health get separate handling and copy;
even though v1's only source is the vault plus cached sources, the separate
tables and banners exist now so connectors arrive as data (§61 spirit).

Coverage promotion uses the complete events above. When a source or the
reasoning runtime stays blind past a threshold (default 24 hours with pending
work), the app first records or references a `coverage.assessed` record, then
emits `coverage.gap`; `coverage.restored` closes the same gap on demonstrated
recovery. A source failure updates source connection and/or health according
to what actually failed, plus the source assessment.
A CLI quota failure updates `runtime_health` and may open a runtime-caused gap
without falsifying source connection/health. This is the mechanism for
“connector unavailable for three days → coverage event”: prolonged blindness
materially changes what the knowledge base can claim to have observed; a
single retry never does.

Ingestion failures proper (§29) — scan, parse, extraction errors — are a
third face, distinct from quota death: recorded per item, surfaced as an
"N items failed ingestion" banner with its own copy; the item is
visible-and-skipped, never silently dropped.

Concurrency: background LLM work stays 1 inside MAX_CONCURRENT_RUNS=4 so
chat always has headroom (D6) — encoded as a runtime-DB-enforced cap, not a
comment.

## The control surface (first real UI of the overhaul)

- **Titlebar:** subscription-wide global pause, persisted in the runtime DB
  (not localStorage).
- **Panel:** vault-scoped per-lane toggles · global budget meter (today's
  ambient spend across every vault vs ceiling, ceiling state) · activity
  ledger filterable by vault (run → tokens → proposals → applied/rejected,
  reading scoped `runs` joined to proposal outcomes).
- Store-layer never-throw applies (these are human-UI actions).
- UI copy renders the activity ledger as **"Activity log"** — "ledger" stays
  reserved for the epistemic ledger.
- These banners and the meter are feeders for the §35 Epistemic Status
  surface whose skeleton lands in M27 (§35 lands across M25–M27) —
  scattered now, one coherent home later.
- Git checkpoints collapse to one commit per applied batch (the M21.7 trailer
  machinery already carries the chain head; batching is a frontend cadence
  change).

## Error handling

| Failure | Behavior |
|---|---|
| Quota death with exact usage | One finalization transaction requeues claims, reconciles reservation, sets backoff, and names N |
| Crash/missing usage/lease expiry | Claims requeued; accounting unknown; ambient paused, never charged zero |
| Scan/parse/extraction failure | Per-item record; "N items failed ingestion" banner, distinct from quota copy |
| runtime.db deleted/corrupt | Ambient auto-pauses; rebuild exact receipts; ambiguous items held for explicit rebaseline/reprocess; spend is unknown, never reset to zero |
| runtime DB migration fails | Transaction rolls back; prior schema remains; ambient paused and failing version visible |
| Ambient budget exhausted | Ambient halts by lane priority; attended chat unaffected |
| Git checkout over soak vault | Zero LLM-warranted queue entries |
| App closed a week | Catch-up via hash-diff through the budget gate; no stampede |
| Unknown fields in CLI stream | Parsed defensively; presence recorded operationally |

## Testing

- Parser fixtures from recorded CLI streams (sanitized).
- The corroborating-duplicate case: `material_candidate(evidence-state)`
  despite zero field diff.
- Route-matrix tests cover every verdict/route/ref/state/recovery combination,
  especially `failed_visible → recovery_held`; `independence_unknown` never
  counts as corroboration.
- Shared M22 conformance vectors cover complete coverage/ingest bodies,
  per-dimension state/basis/as-of, canonical absence receipt matching,
  partial/final restoration, stable retry keys, validation refusals, reducer
  state, and byte-identical rebuild.
- `user_version` migration tests cover every prior version, rollback at each
  statement/commit kill point, failed validation, corruption quarantine, and
  recovery-mode startup.
- One-shot baseline tests start from the real legacy split (hook-memory
  scan/pending plus localStorage attempts/triggers/skills), assert no automatic
  stampede, and preserve the background-disable kill switch.
- Runtime-DB loss tests assert no ambient dispatch before explicit recovery;
  exact portable receipts rebuild consumed state, ambiguity stays held, and an
  explicit reprocess may spend again with clear ownership.
- A two-vault fixture proves scheduler/source rows never collide while both
  vaults debit the same global subscription budget.
- Gate goldens independently exhaust daily runs, total tokens, output tokens,
  consecutive failures, quota backoff, and elapsed time; cover warning at 80%,
  local-midnight/DST windows, reservation overrun, missing usage, and lease
  expiry. Preflight gates defer before spawn; elapsed time aborts/requeues an
  already-started run; attended use remains available.
- Dispatch kill points surround `BEGIN IMMEDIATE`, claim/reserve/lease commit,
  spawn, usage finalization, and lease recovery; every item is pending or owned
  by one recoverable run and global ambient concurrency never exceeds one.
- Catch-up fixtures persist qualifying and non-qualifying responsibility
  versions/digests, clean-close and heartbeat-lower-bound sessions, later
  contract edits, and the exact M28 R10 query from rows plus linked gap events.
- Kill points between Observation capture, initial receipt/M26 queue,
  proposal lifecycle, semantic outcome, and terminal receipt prove every
  source-item association is reducer-atomic, including no/non-material routes.
- **The simulated-day soak:** scripted file churn, git checkouts,
  quota-failure injection, app restarts — asserting run counts bounded per
  D6's ~10–20 ambient runs/day (the soak asserts ≤20), zero
  mtime-triggered spend, every failure visible in the UI, budget arithmetic
  exact against injected usage fixtures.
- Playwright specs for the control surface against mockIpc serving fixed
  runtime-DB shapes; no budget logic in the mock beyond the fixture.
- demo-vault mtimes stay sacred during soak tests — copy first.
- e2e boots and passes with the distiller disabled exactly as before.

## Non-goals

No new LLM behavior, prompts, or agent constructs — M26 consumes this
milestone, it does not ship in it; the three passes stay OFF · no always-on
service (D10: continuous = while-app-open + launch catch-up) · no numeric
confidence, no product metrics dashboards — the meter and activity ledger are
operational surfaces, not epistemics · no semantic materiality judgments
(deterministic only, no LLM).

## Acceptance

A simulated day of churn produces bounded run counts (≤20 ambient, per D6's
~10–20/day) with exact global accounting across vaults when usage is exact and
a conservative pause when it is not · gate/reservation/claim/lease is one
crash-safe transaction · every failure mode is visible, none silent · git
operations cost zero tokens · every prefilter route satisfies the closed
ref/state/recovery matrix and `independence_unknown` never corroborates · every
changed Observation is atomic with its initial receipt · coverage dimensions
retain separate state/basis/as-of and formal absence joins exact receipt fields
· responsibility versions plus clean/heartbeat sessions reproduce R10 · the
control surface ships (pause, lanes, meter, activity ledger) · scheduler state
is vault-scoped and restart-safe · upgrade/recovery never auto-dispatches
ambiguous work or silently resets spend · full gates and new e2e specs green.
