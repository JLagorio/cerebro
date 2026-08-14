//! The read-only measurable evaluators (M28.0d) — the runtime-table five.
//!
//! R13 (unexecuted discovery plans), R3 (claim-granularity pressure), R6
//! (resolver bottleneck), R10 (recurring launch-catch-up gap), and R2's
//! measurable headroom leg. Each is a PURE core over typed rows — the SQL
//! collector fetches, the core decides — so every floor and threshold is
//! testable at its exact boundary without a database in the loop. R1 and R7
//! read different substrates (the cost-projection artifact; reducer state
//! plus the portable source cache) and land in their own phase.
//!
//! **Reading is the whole privilege.** The collectors SELECT from the named
//! M22–M27 promotion sources and nothing else; the only writes anywhere in
//! this module go through `runtime::triggers`, into the two governance
//! tables. Before a record is written it is run through
//! `evaluation::validate` — the same validator the shared goldens pin — so
//! an evaluator that drifted from the artifact refuses its own output
//! rather than persisting it.
//!
//! **Floors gate readiness; thresholds gate firing.** A sample below its
//! declared floor is `not_ready` — the question cannot be answered yet, and
//! answering `not_fired` would claim it was. Only a floor-satisfying sample
//! ever says `fired` or `not_fired`. Missing substrate (no live contract for
//! R10, a missing or mismatched `budget_days` row for R2) is `not_ready` for
//! the same reason.
//!
//! **No clock.** `evaluated_at` and the IANA timezone arrive from the
//! caller; two runs over the same rows at the same declared instant produce
//! byte-identical records, which is what makes the rerun a `Replayed`.

use std::str::FromStr;

use chrono::TimeZone;
use rusqlite::Connection;

use crate::ledger::sha256_hex;
use crate::runtime::triggers::{self, EvaluationRow, Put, SnapshotRow, StoredScope};
use crate::trigger::evaluation::{
    self, derive_evaluation_id, derive_input_snapshot_hash, EvaluationScope, GateKey,
    InputSnapshotRef, MetricSeriesKey, TriggerEvaluation, TriggerMetric, TriggerResult, Window,
};
use crate::trigger::registry::Registry;

/// What one evaluation run produced and recorded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Recorded {
    pub evaluation: TriggerEvaluation,
    pub snapshot_id: String,
    pub snapshot_put: Put,
    pub evaluation_put: Put,
}

/// One vault store, as every R3–R14 evaluation must name it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VaultScope {
    pub vault_id: String,
    pub store_uuid: String,
}

impl VaultScope {
    fn evaluation_scope(&self) -> EvaluationScope {
        EvaluationScope::VaultStore {
            vault_id: self.vault_id.clone(),
            store_uuid: self.store_uuid.clone(),
        }
    }

    fn stored_scope(&self) -> StoredScope {
        StoredScope::VaultStore {
            vault_id: self.vault_id.clone(),
            store_uuid: self.store_uuid.clone(),
        }
    }
}

pub(crate) fn constant(registry: &Registry, gate: &str, name: &str) -> Result<u64, String> {
    registry
        .protocol(gate)
        .and_then(|p| p.get(name))
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| format!("protocol {gate} has no integer constant {name}"))
}

/// The one runtime snapshot-id rule: the id names the QUESTION — gate,
/// scope, rule version, window — alongside the payload bytes (M28.1a).
/// Shared by the measurable persist path and R2's hybrid assembly, so the
/// rule cannot fork.
pub(crate) fn derive_runtime_snapshot_id(
    registry: &Registry,
    gate_key: &GateKey,
    stored_scope: &StoredScope,
    window: &Window,
    payload_json: &str,
) -> String {
    let scope_bytes = match stored_scope {
        StoredScope::SubscriptionGlobal => "subscription_global".to_string(),
        StoredScope::VaultStore {
            vault_id,
            store_uuid,
        } => format!("vault_store\0{vault_id}\0{store_uuid}"),
    };
    sha256_hex(
        format!(
            "{}\0{}\0{scope_bytes}\0{}\0{}\0{}\0{}\0{payload_json}",
            registry.snapshot_hash_domain,
            gate_key.canonical(),
            registry.rule_version,
            window.start,
            window.end,
            window.timezone,
        )
        .as_bytes(),
    )
}

/// The first instant of a local calendar day. A skipped midnight (spring
/// forward) starts at the first minute that exists — the M25 budget rule.
fn local_day_start(
    tz: chrono_tz::Tz,
    date: chrono::NaiveDate,
) -> Result<chrono::DateTime<chrono_tz::Tz>, String> {
    let midnight = date
        .and_hms_opt(0, 0, 0)
        .ok_or_else(|| format!("{date} has no midnight"))?;
    match tz.from_local_datetime(&midnight) {
        chrono::LocalResult::Single(instant) => Ok(instant),
        chrono::LocalResult::Ambiguous(earliest, _) => Ok(earliest),
        chrono::LocalResult::None => {
            for minute in 1..=180 {
                let shifted = midnight + chrono::Duration::minutes(minute);
                if let chrono::LocalResult::Single(instant) = tz.from_local_datetime(&shifted) {
                    return Ok(instant);
                }
            }
            Err(format!("{date} in {tz} has no representable start"))
        }
    }
}

/// The preceding `days` COMPLETE local calendar days: ends at the most
/// recent local midnight at or before `evaluated_at`, starts `days` local
/// days earlier.
pub(crate) fn complete_window(
    tz: chrono_tz::Tz,
    evaluated_at: chrono::DateTime<chrono::Utc>,
    days: u64,
) -> Result<
    (
        Window,
        chrono::DateTime<chrono::Utc>,
        chrono::DateTime<chrono::Utc>,
    ),
    String,
> {
    let local_date = evaluated_at.with_timezone(&tz).date_naive();
    let end = local_day_start(tz, local_date)?;
    let start_date = local_date
        .checked_sub_days(chrono::Days::new(days))
        .ok_or("window start before the calendar")?;
    let start = local_day_start(tz, start_date)?;
    let window = Window {
        start: start.to_rfc3339(),
        end: end.to_rfc3339(),
        timezone: tz.name().to_string(),
    };
    Ok((
        window,
        start.with_timezone(&chrono::Utc),
        end.with_timezone(&chrono::Utc),
    ))
}

pub(crate) fn parse_z(stamp: &str) -> Result<chrono::DateTime<chrono::Utc>, String> {
    chrono::DateTime::parse_from_rfc3339(stamp)
        .map(|t| t.with_timezone(&chrono::Utc))
        .map_err(|e| format!("{stamp:?} is not RFC3339: {e}"))
}

/// Record what a protocol concluded: snapshot first, evaluation second, both
/// idempotent, and the record checked against the shared validator before a
/// byte is written.
///
/// **The snapshot id names the question, not only the bytes.** Two gates can
/// collect byte-identical payloads (R3 and R6 over an empty store do), and
/// the same gate collects the same bytes under a different window on a quiet
/// day — so gate key, scope, rule version, and window are hashed alongside
/// the payload. The M28.1 runner's first pass over one database found the
/// collision the no-caller seam had been hiding.
///
/// **A later ask of an answered question adopts the stored stamps.** The
/// evaluation id deliberately hashes inputs, not the instant of asking; the
/// record still carries `evaluated_at`. Without adoption, a 9am ask followed
/// by a 5pm ask of the same window would refuse as "different content" over
/// the one field the id does not cover. With it, the first observation of
/// the fact stands, the rerun replays byte-identically, and any OTHER
/// divergence under the same id still refuses in the store.
#[allow(clippy::too_many_arguments)]
fn persist(
    conn: &Connection,
    registry: &Registry,
    gate_key: GateKey,
    scope: EvaluationScope,
    stored_scope: StoredScope,
    window: Window,
    payload: &serde_json::Value,
    metrics: Vec<TriggerMetric>,
    result: TriggerResult,
    evaluated_at: &str,
) -> Result<Recorded, String> {
    let payload_json =
        serde_json::to_string(payload).map_err(|e| format!("canonicalizing payload: {e}"))?;
    let snapshot_id =
        derive_runtime_snapshot_id(registry, &gate_key, &stored_scope, &window, &payload_json);
    let input_snapshot_hash = derive_input_snapshot_hash(
        &registry.snapshot_hash_domain,
        &[(
            "runtime".to_string(),
            snapshot_id.clone(),
            payload_json.clone(),
        )],
    );
    let evaluation_id = derive_evaluation_id(
        &registry.evaluation_id_domain,
        &gate_key,
        &scope,
        &registry.rule_version,
        &input_snapshot_hash,
    );
    let stamp = match triggers::evaluation(conn, &evaluation_id)? {
        Some(existing) => existing.evaluated_at,
        None => evaluated_at.to_string(),
    };
    let collected_at = match triggers::snapshot(conn, &snapshot_id)? {
        Some(existing) => existing.collected_at,
        None => stamp.clone(),
    };
    let evaluation = TriggerEvaluation {
        variant: crate::trigger::registry::Variant::Measurable,
        evaluation_id: evaluation_id.clone(),
        gate_key,
        scope,
        evaluated_at: stamp.clone(),
        window: Some(window),
        input_snapshot_refs: vec![InputSnapshotRef::Runtime {
            snapshot_id: snapshot_id.clone(),
        }],
        input_snapshot_hash,
        metrics,
        evidence_pack_path: None,
        result,
        rule_version: registry.rule_version.clone(),
        approving_owner: None,
        parent_evaluation_id: None,
    };
    // The evaluator's own output must satisfy the validator the goldens pin.
    // A drifted evaluator refuses here, before anything is persisted.
    evaluation::validate(&evaluation, registry).map_err(|r| {
        format!(
            "the evaluator produced an invalid record — {}: {}",
            r.code, r.detail
        )
    })?;

    let snapshot_put = triggers::put_snapshot(
        conn,
        &SnapshotRow {
            snapshot_id: snapshot_id.clone(),
            registry_id: evaluation.gate_key.registry_id.clone(),
            subkey: evaluation.gate_key.subcapability.clone(),
            scope: stored_scope.clone(),
            rule_version: registry.rule_version.clone(),
            payload_json,
            collected_at,
        },
    )?;
    let window_row = evaluation.window.clone().map(|w| triggers::Window {
        start: w.start,
        end: w.end,
        timezone: w.timezone,
    });
    let record_json =
        serde_json::to_string(&evaluation).map_err(|e| format!("canonicalizing record: {e}"))?;
    let evaluation_put = triggers::put_evaluation(
        conn,
        &EvaluationRow {
            evaluation_id,
            registry_id: evaluation.gate_key.registry_id.clone(),
            subkey: evaluation.gate_key.subcapability.clone(),
            variant: "measurable".to_string(),
            scope: stored_scope,
            evaluated_at: stamp,
            window: window_row,
            input_snapshot_refs_json: serde_json::to_string(&evaluation.input_snapshot_refs)
                .map_err(|e| e.to_string())?,
            input_snapshot_hash: evaluation.input_snapshot_hash.clone(),
            metrics_json: Some(
                serde_json::to_string(&evaluation.metrics).map_err(|e| e.to_string())?,
            ),
            evidence_pack_path: None,
            result: evaluation.result.as_str().to_string(),
            rule_version: registry.rule_version.clone(),
            approving_owner: None,
            parent_evaluation_id: None,
            record_json,
        },
    )?;
    Ok(Recorded {
        snapshot_id,
        snapshot_put,
        evaluation_put,
        evaluation,
    })
}

/// A measurable evaluation being assembled: gate, scope, and window fixed
/// up front; constants and window containment to hand while a protocol
/// collects; persistence at the end. R1 and R7 build through this, so their
/// modules cannot reach `persist` with a shape the window math never blessed.
pub struct MeasurableOutcome<'a> {
    registry: &'a Registry,
    gate: String,
    gate_key: GateKey,
    scope: EvaluationScope,
    stored_scope: StoredScope,
    window: Window,
    start: chrono::DateTime<chrono::Utc>,
    end: chrono::DateTime<chrono::Utc>,
    evaluated_at: String,
}

impl<'a> MeasurableOutcome<'a> {
    fn build(
        registry: &'a Registry,
        gate: &str,
        scope: EvaluationScope,
        stored_scope: StoredScope,
        evaluated_at: chrono::DateTime<chrono::Utc>,
        timezone: &str,
    ) -> Result<Self, String> {
        let tz = chrono_tz::Tz::from_str(timezone).map_err(|e| format!("{timezone:?}: {e}"))?;
        let days = constant(registry, gate, "window_days")?;
        let (window, start, end) = complete_window(tz, evaluated_at, days)?;
        let (registry_id, subcapability) = gate
            .split_once(':')
            .ok_or_else(|| format!("{gate:?} is not a gate key"))?;
        Ok(MeasurableOutcome {
            registry,
            gate: gate.to_string(),
            gate_key: GateKey {
                registry_id: registry_id.to_string(),
                subcapability: subcapability.to_string(),
            },
            scope,
            stored_scope,
            window,
            start,
            end,
            evaluated_at: evaluated_at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        })
    }

    /// R1/R2's shape: the whole subscription, no vault.
    pub fn subscription(
        registry: &'a Registry,
        gate: &str,
        evaluated_at: chrono::DateTime<chrono::Utc>,
        timezone: &str,
    ) -> Result<Self, String> {
        Self::build(
            registry,
            gate,
            EvaluationScope::SubscriptionGlobal,
            StoredScope::SubscriptionGlobal,
            evaluated_at,
            timezone,
        )
    }

    /// R3–R14's shape: one vault store.
    pub fn vault(
        registry: &'a Registry,
        gate: &str,
        scope: &VaultScope,
        evaluated_at: chrono::DateTime<chrono::Utc>,
        timezone: &str,
    ) -> Result<Self, String> {
        Self::build(
            registry,
            gate,
            scope.evaluation_scope(),
            scope.stored_scope(),
            evaluated_at,
            timezone,
        )
    }

    /// One protocol constant, off the artifact.
    pub fn constant(&self, name: &str) -> Result<u64, String> {
        constant(self.registry, &self.gate, name)
    }

    /// Whether an RFC3339 stamp falls inside the window.
    pub fn contains(&self, stamp: &str) -> Result<bool, String> {
        let instant = parse_z(stamp)?;
        Ok(instant >= self.start && instant < self.end)
    }

    /// The window's opening instant in the `…Z` spelling the runtime tables
    /// store, for byte comparisons against their stamps.
    pub fn window_start_utc(&self) -> String {
        self.start
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    }

    /// The window's UTC bounds, start inclusive and end exclusive.
    pub fn bounds(&self) -> (chrono::DateTime<chrono::Utc>, chrono::DateTime<chrono::Utc>) {
        (self.start, self.end)
    }

    /// Record the outcome — see [`persist`].
    pub fn persist(
        self,
        conn: &Connection,
        payload: &serde_json::Value,
        metrics: Vec<TriggerMetric>,
        result: TriggerResult,
    ) -> Result<Recorded, String> {
        persist(
            conn,
            self.registry,
            self.gate_key,
            self.scope,
            self.stored_scope,
            self.window,
            payload,
            metrics,
            result,
            &self.evaluated_at,
        )
    }
}

fn aggregate_count(name: &str, value: u64) -> TriggerMetric {
    TriggerMetric::Count {
        name: name.to_string(),
        series: MetricSeriesKey::Aggregate,
        value,
    }
}

fn ratio(name: &str, numerator: u64, denominator: u64, series: MetricSeriesKey) -> TriggerMetric {
    TriggerMetric::RatioPpm {
        name: name.to_string(),
        numerator,
        denominator,
        value_ppm: numerator * 1_000_000 / denominator,
        series,
    }
}

// --- R13: unexecuted discovery plans ---------------------------------------

/// One discovery plan as sampled. `stakes` is the emitting manifest's, and a
/// plan whose manifest is gone keeps `None` — it still counts as emitted and
/// pending, and never as HIGH/CRITICAL, because a missing record cannot
/// raise stakes.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct R13Row {
    pub plan_id: String,
    pub assembly_id: String,
    pub state: String,
    pub created_at: String,
    pub stakes: Option<String>,
}

pub struct R13Constants {
    pub min_emitted_plans: u64,
    pub min_emission_runs: u64,
    pub fire_min_pending_plans: u64,
    pub min_pending_days: u64,
    pub fire_min_high_stakes_pending: u64,
}

impl R13Constants {
    fn load(registry: &Registry) -> Result<(u64, R13Constants), String> {
        Ok((
            constant(registry, "R13:root", "window_days")?,
            R13Constants {
                min_emitted_plans: constant(registry, "R13:root", "min_emitted_plans")?,
                min_emission_runs: constant(registry, "R13:root", "min_emission_runs")?,
                fire_min_pending_plans: constant(registry, "R13:root", "fire_min_pending_plans")?,
                min_pending_days: constant(registry, "R13:root", "min_pending_days")?,
                fire_min_high_stakes_pending: constant(
                    registry,
                    "R13:root",
                    "fire_min_high_stakes_pending",
                )?,
            },
        ))
    }
}

/// The pure core. `pending_cutoff` is the instant a pending plan must
/// predate to have waited `min_pending_days` FULL days.
pub fn r13_outcome(
    rows: &[R13Row],
    constants: &R13Constants,
    pending_cutoff: chrono::DateTime<chrono::Utc>,
) -> Result<(Vec<TriggerMetric>, TriggerResult), String> {
    let emitted: std::collections::BTreeSet<&str> =
        rows.iter().map(|r| r.plan_id.as_str()).collect();
    let runs: std::collections::BTreeSet<&str> =
        rows.iter().map(|r| r.assembly_id.as_str()).collect();
    let mut pending = 0u64;
    let mut pending_high = 0u64;
    for row in rows {
        if row.state != "pending" {
            continue;
        }
        if parse_z(&row.created_at)? > pending_cutoff {
            continue;
        }
        pending += 1;
        if matches!(row.stakes.as_deref(), Some("HIGH") | Some("CRITICAL")) {
            pending_high += 1;
        }
    }
    let metrics = vec![
        aggregate_count("emitted_plans", emitted.len() as u64),
        aggregate_count("emission_runs", runs.len() as u64),
        aggregate_count("pending_plans", pending),
        aggregate_count("pending_high_stakes_plans", pending_high),
    ];
    let result = if (emitted.len() as u64) < constants.min_emitted_plans
        || (runs.len() as u64) < constants.min_emission_runs
    {
        TriggerResult::NotReady
    } else if pending >= constants.fire_min_pending_plans
        && pending_high >= constants.fire_min_high_stakes_pending
    {
        TriggerResult::Fired
    } else {
        TriggerResult::NotFired
    };
    Ok((metrics, result))
}

/// Evaluate R13 over one vault store and record the outcome.
pub fn evaluate_r13(
    conn: &Connection,
    registry: &Registry,
    scope: &VaultScope,
    evaluated_at: chrono::DateTime<chrono::Utc>,
    timezone: &str,
) -> Result<Recorded, String> {
    let tz = chrono_tz::Tz::from_str(timezone).map_err(|e| format!("{timezone:?}: {e}"))?;
    let (window_days, constants) = R13Constants::load(registry)?;
    let (window, start, end) = complete_window(tz, evaluated_at, window_days)?;

    let mut statement = conn
        .prepare(
            "SELECT p.plan_id, p.assembly_id, p.state, p.created_at, m.stakes \
             FROM discovery_plan_runs p \
             LEFT JOIN working_memory_manifests m \
               ON m.vault_id = p.vault_id AND m.store_uuid = p.store_uuid \
              AND m.assembly_id = p.assembly_id \
             WHERE p.vault_id = ?1 AND p.store_uuid = ?2 \
             ORDER BY p.plan_id",
        )
        .map_err(|e| e.to_string())?;
    let mut rows = Vec::new();
    let fetched = statement
        .query_map(rusqlite::params![scope.vault_id, scope.store_uuid], |r| {
            Ok(R13Row {
                plan_id: r.get(0)?,
                assembly_id: r.get(1)?,
                state: r.get(2)?,
                created_at: r.get(3)?,
                stakes: r.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?;
    for row in fetched {
        let row = row.map_err(|e| e.to_string())?;
        let created = parse_z(&row.created_at)?;
        if created >= start && created < end {
            rows.push(row);
        }
    }

    let pending_cutoff = end - chrono::Duration::days(constants.min_pending_days as i64);
    let (metrics, result) = r13_outcome(&rows, &constants, pending_cutoff)?;
    persist(
        conn,
        registry,
        GateKey {
            registry_id: "R13".into(),
            subcapability: "root".into(),
        },
        scope.evaluation_scope(),
        scope.stored_scope(),
        window,
        &serde_json::json!({ "rows": rows }),
        metrics,
        result,
        &evaluated_at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
    )
}

// --- R3 / R6: resolver-outcome buckets -------------------------------------

/// One resolver attempt as sampled. Ineligible rows are kept and REPORTED —
/// excluded from every denominator, never silently dropped.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct ResolverRow {
    pub attempt_id: String,
    pub artifact_id: String,
    pub ingest_item_id: String,
    pub eligible: bool,
    pub ineligible_reason: Option<String>,
    pub outcome: String,
    pub attachment_state: Option<String>,
    pub target_count: Option<u64>,
    pub attempted_at: String,
}

pub struct BucketConstants {
    pub bucket_days: u64,
    pub bucket_count: u64,
    pub min_eligible_attempts: u64,
    pub min_distinct_artifacts: u64,
    pub min_attempts_per_bucket: u64,
    pub fire_min_buckets: u64,
}

fn bucket_constants(registry: &Registry, gate: &str) -> Result<BucketConstants, String> {
    Ok(BucketConstants {
        bucket_days: constant(registry, gate, "bucket_days")?,
        bucket_count: constant(registry, gate, "bucket_count")?,
        min_eligible_attempts: constant(registry, gate, "min_eligible_attempts")?,
        min_distinct_artifacts: constant(registry, gate, "min_distinct_artifacts")?,
        min_attempts_per_bucket: constant(registry, gate, "min_attempts_per_bucket")?,
        fire_min_buckets: constant(registry, gate, "fire_min_buckets")?,
    })
}

/// One bucket: its inclusive local-date bounds and its member rows.
pub type Bucket<'a> = (chrono::NaiveDate, chrono::NaiveDate, Vec<&'a ResolverRow>);

/// Assign rows to the four buckets by `attempted_at` in the evaluation
/// timezone. Buckets are `Vec<Vec<&row>>`, oldest first, with their date
/// bounds for the series keys.
fn bucketize<'a>(
    rows: &'a [ResolverRow],
    tz: chrono_tz::Tz,
    start_date: chrono::NaiveDate,
    constants: &BucketConstants,
) -> Result<Vec<Bucket<'a>>, String> {
    let mut buckets = Vec::new();
    for ordinal in 0..constants.bucket_count {
        let from = start_date
            .checked_add_days(chrono::Days::new(ordinal * constants.bucket_days))
            .ok_or("bucket start overflow")?;
        let to = start_date
            .checked_add_days(chrono::Days::new((ordinal + 1) * constants.bucket_days - 1))
            .ok_or("bucket end overflow")?;
        buckets.push((from, to, Vec::new()));
    }
    for row in rows {
        let local = parse_z(&row.attempted_at)?.with_timezone(&tz).date_naive();
        for (from, to, members) in &mut buckets {
            if local >= *from && local <= *to {
                members.push(row);
                break;
            }
        }
    }
    Ok(buckets)
}

fn distinct<'a>(iter: impl Iterator<Item = &'a str>) -> u64 {
    iter.collect::<std::collections::BTreeSet<&str>>().len() as u64
}

fn bucket_series(ordinal: u64, from: chrono::NaiveDate, to: chrono::NaiveDate) -> MetricSeriesKey {
    MetricSeriesKey::Bucket {
        ordinal: (ordinal + 1) as u8,
        start_date: from.format("%Y-%m-%d").to_string(),
        end_date: to.format("%Y-%m-%d").to_string(),
    }
}

/// R3's numerator: the closed OUTCOME, parked, at least two targets. An
/// outcome, never reason prose.
fn r3_blocked(row: &ResolverRow) -> bool {
    row.outcome == "claim_granularity_blocked"
        && row.attachment_state.as_deref() == Some("parked")
        && row.target_count.is_some_and(|t| t >= 2)
}

/// The shared floor check: total eligible attempts, distinct artifacts, and
/// every bucket's own attempt floor.
fn floors_met(buckets: &[Bucket<'_>], constants: &BucketConstants) -> bool {
    let eligible: Vec<&&ResolverRow> = buckets
        .iter()
        .flat_map(|(_, _, members)| members.iter())
        .filter(|r| r.eligible)
        .collect();
    if distinct(eligible.iter().map(|r| r.attempt_id.as_str())) < constants.min_eligible_attempts {
        return false;
    }
    if distinct(eligible.iter().map(|r| r.artifact_id.as_str())) < constants.min_distinct_artifacts
    {
        return false;
    }
    buckets.iter().all(|(_, _, members)| {
        distinct(
            members
                .iter()
                .filter(|r| r.eligible)
                .map(|r| r.attempt_id.as_str()),
        ) >= constants.min_attempts_per_bucket
    })
}

/// R3's pure core over bucketized rows.
pub fn r3_outcome(
    buckets: &[Bucket<'_>],
    constants: &BucketConstants,
    fire_min_blocked_ppm: u64,
) -> (Vec<TriggerMetric>, TriggerResult) {
    let mut metrics = Vec::new();
    let eligible_all: Vec<&&ResolverRow> = buckets
        .iter()
        .flat_map(|(_, _, m)| m.iter())
        .filter(|r| r.eligible)
        .collect();
    metrics.push(aggregate_count(
        "eligible_attempts",
        distinct(eligible_all.iter().map(|r| r.attempt_id.as_str())),
    ));
    metrics.push(aggregate_count(
        "distinct_artifacts",
        distinct(eligible_all.iter().map(|r| r.artifact_id.as_str())),
    ));
    let mut firing_buckets = 0u64;
    for (ordinal, (from, to, members)) in buckets.iter().enumerate() {
        let series = bucket_series(ordinal as u64, *from, *to);
        let eligible = distinct(
            members
                .iter()
                .filter(|r| r.eligible)
                .map(|r| r.attempt_id.as_str()),
        );
        let blocked = distinct(
            members
                .iter()
                .filter(|r| r.eligible && r3_blocked(r))
                .map(|r| r.attempt_id.as_str()),
        );
        metrics.push(TriggerMetric::Count {
            name: "eligible_attempts".to_string(),
            series: series.clone(),
            value: eligible,
        });
        metrics.push(TriggerMetric::Count {
            name: "granularity_blocked_attempts".to_string(),
            series: series.clone(),
            value: blocked,
        });
        if eligible > 0 {
            let row = ratio("granularity_blocked_rate", blocked, eligible, series);
            if let TriggerMetric::RatioPpm { value_ppm, .. } = &row {
                if *value_ppm >= fire_min_blocked_ppm {
                    firing_buckets += 1;
                }
            }
            metrics.push(row);
        }
    }
    let result = if !floors_met(buckets, constants) {
        TriggerResult::NotReady
    } else if firing_buckets >= constants.fire_min_buckets {
        TriggerResult::Fired
    } else {
        TriggerResult::NotFired
    };
    (metrics, result)
}

/// R6's pure core: attempt rate AND parked-item rate, both per bucket.
pub fn r6_outcome(
    buckets: &[Bucket<'_>],
    constants: &BucketConstants,
    fire_min_unresolved_ppm: u64,
    fire_min_unresolved_parked_ppm: u64,
) -> (Vec<TriggerMetric>, TriggerResult) {
    let mut metrics = Vec::new();
    let eligible_all: Vec<&&ResolverRow> = buckets
        .iter()
        .flat_map(|(_, _, m)| m.iter())
        .filter(|r| r.eligible)
        .collect();
    metrics.push(aggregate_count(
        "eligible_attempts",
        distinct(eligible_all.iter().map(|r| r.attempt_id.as_str())),
    ));
    metrics.push(aggregate_count(
        "distinct_artifacts",
        distinct(eligible_all.iter().map(|r| r.artifact_id.as_str())),
    ));
    let mut firing_buckets = 0u64;
    for (ordinal, (from, to, members)) in buckets.iter().enumerate() {
        let series = bucket_series(ordinal as u64, *from, *to);
        let eligible: Vec<&&ResolverRow> = members.iter().filter(|r| r.eligible).collect();
        let attempts = distinct(eligible.iter().map(|r| r.attempt_id.as_str()));
        let unresolved = distinct(
            eligible
                .iter()
                .filter(|r| r.outcome == "unresolved")
                .map(|r| r.attempt_id.as_str()),
        );
        let parked_items = distinct(
            eligible
                .iter()
                .filter(|r| r.attachment_state.as_deref() == Some("parked"))
                .map(|r| r.ingest_item_id.as_str()),
        );
        let unresolved_parked_items = distinct(
            eligible
                .iter()
                .filter(|r| {
                    r.outcome == "unresolved" && r.attachment_state.as_deref() == Some("parked")
                })
                .map(|r| r.ingest_item_id.as_str()),
        );
        metrics.push(TriggerMetric::Count {
            name: "unresolved_attempts".to_string(),
            series: series.clone(),
            value: unresolved,
        });
        metrics.push(TriggerMetric::Count {
            name: "eligible_attachment_parked_items".to_string(),
            series: series.clone(),
            value: parked_items,
        });
        metrics.push(TriggerMetric::Count {
            name: "unresolved_parked_items".to_string(),
            series: series.clone(),
            value: unresolved_parked_items,
        });
        let mut attempt_leg = false;
        let mut item_leg = false;
        if attempts > 0 {
            let row = ratio("unresolved_rate", unresolved, attempts, series.clone());
            if let TriggerMetric::RatioPpm { value_ppm, .. } = &row {
                attempt_leg = *value_ppm >= fire_min_unresolved_ppm;
            }
            metrics.push(row);
        }
        if parked_items > 0 {
            let row = ratio(
                "unresolved_parked_rate",
                unresolved_parked_items,
                parked_items,
                series,
            );
            if let TriggerMetric::RatioPpm { value_ppm, .. } = &row {
                item_leg = *value_ppm >= fire_min_unresolved_parked_ppm;
            }
            metrics.push(row);
        }
        if attempt_leg && item_leg {
            firing_buckets += 1;
        }
    }
    let result = if !floors_met(buckets, constants) {
        TriggerResult::NotReady
    } else if firing_buckets >= constants.fire_min_buckets {
        TriggerResult::Fired
    } else {
        TriggerResult::NotFired
    };
    (metrics, result)
}

fn collect_resolver_rows(
    conn: &Connection,
    scope: &VaultScope,
    start: chrono::DateTime<chrono::Utc>,
    end: chrono::DateTime<chrono::Utc>,
) -> Result<Vec<ResolverRow>, String> {
    let mut statement = conn
        .prepare(
            "SELECT attempt_id, artifact_id, ingest_item_id, eligible, ineligible_reason, \
                    outcome, attachment_state, target_count, attempted_at \
             FROM resolver_outcomes WHERE vault_id = ?1 AND store_uuid = ?2 \
             ORDER BY attempt_id",
        )
        .map_err(|e| e.to_string())?;
    let fetched = statement
        .query_map(rusqlite::params![scope.vault_id, scope.store_uuid], |r| {
            Ok(ResolverRow {
                attempt_id: r.get(0)?,
                artifact_id: r.get(1)?,
                ingest_item_id: r.get(2)?,
                eligible: r.get::<_, i64>(3)? == 1,
                ineligible_reason: r.get(4)?,
                outcome: r.get(5)?,
                attachment_state: r.get(6)?,
                target_count: r.get::<_, Option<i64>>(7)?.map(|t| t as u64),
                attempted_at: r.get(8)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut rows = Vec::new();
    for row in fetched {
        let row = row.map_err(|e| e.to_string())?;
        let attempted = parse_z(&row.attempted_at)?;
        if attempted >= start && attempted < end {
            rows.push(row);
        }
    }
    Ok(rows)
}

fn evaluate_buckets(
    conn: &Connection,
    registry: &Registry,
    scope: &VaultScope,
    evaluated_at: chrono::DateTime<chrono::Utc>,
    timezone: &str,
    gate: &str,
) -> Result<Recorded, String> {
    let tz = chrono_tz::Tz::from_str(timezone).map_err(|e| format!("{timezone:?}: {e}"))?;
    let constants = bucket_constants(registry, gate)?;
    let (window, start, end) = complete_window(
        tz,
        evaluated_at,
        constants.bucket_days * constants.bucket_count,
    )?;
    let rows = collect_resolver_rows(conn, scope, start, end)?;
    let start_date = start.with_timezone(&tz).date_naive();
    let buckets = bucketize(&rows, tz, start_date, &constants)?;
    let (metrics, result) = if gate == "R3:root" {
        r3_outcome(
            &buckets,
            &constants,
            constant(registry, gate, "fire_min_blocked_ppm")?,
        )
    } else {
        r6_outcome(
            &buckets,
            &constants,
            constant(registry, gate, "fire_min_unresolved_ppm")?,
            constant(registry, gate, "fire_min_unresolved_parked_ppm")?,
        )
    };
    // Ineligible rows are excluded from every denominator and REPORTED, by
    // closed reason, in the payload — never silently dropped.
    let mut ineligible: std::collections::BTreeMap<String, u64> = Default::default();
    for row in rows.iter().filter(|r| !r.eligible) {
        *ineligible
            .entry(row.ineligible_reason.clone().unwrap_or_default())
            .or_default() += 1;
    }
    let registry_id = gate.split(':').next().unwrap_or_default().to_string();
    persist(
        conn,
        registry,
        GateKey {
            registry_id,
            subcapability: "root".into(),
        },
        scope.evaluation_scope(),
        scope.stored_scope(),
        window,
        &serde_json::json!({ "rows": rows, "ineligible_by_reason": ineligible }),
        metrics,
        result,
        &evaluated_at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
    )
}

/// Evaluate R3 (claim-granularity pressure) over one vault store.
pub fn evaluate_r3(
    conn: &Connection,
    registry: &Registry,
    scope: &VaultScope,
    evaluated_at: chrono::DateTime<chrono::Utc>,
    timezone: &str,
) -> Result<Recorded, String> {
    evaluate_buckets(conn, registry, scope, evaluated_at, timezone, "R3:root")
}

/// Evaluate R6 (resolver bottleneck) over one vault store.
pub fn evaluate_r6(
    conn: &Connection,
    registry: &Registry,
    scope: &VaultScope,
    evaluated_at: chrono::DateTime<chrono::Utc>,
    timezone: &str,
) -> Result<Recorded, String> {
    evaluate_buckets(conn, registry, scope, evaluated_at, timezone, "R6:root")
}

// --- R10: recurring launch-catch-up gap ------------------------------------

/// One catch-up episode as sampled, already joined to its contract.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct R10Row {
    pub episode_id: String,
    pub responsibility_id: String,
    pub contract_version: u64,
    pub app_closed_at: String,
    pub resolved_at: String,
    pub outcome: String,
    pub coverage_gap_id: Option<String>,
}

pub struct R10Constants {
    pub min_episodes: u64,
    pub min_distinct_days: u64,
    pub min_episode_seconds: u64,
    pub min_total_seconds: u64,
}

/// The pure core. `live_responsibilities` is the population — with none, the
/// question has no subject and the answer is `not_ready`.
pub fn r10_outcome(
    rows: &[R10Row],
    live_responsibilities: &[String],
    constants: &R10Constants,
    tz: chrono_tz::Tz,
) -> Result<(Vec<TriggerMetric>, TriggerResult), String> {
    if live_responsibilities.is_empty() {
        return Ok((
            vec![aggregate_count("gap_episodes", 0)],
            TriggerResult::NotReady,
        ));
    }
    // A qualifying episode: a loss outcome, a linked gap, and at least the
    // per-episode duration. Ordinary caught_up delay never counts.
    let mut best: Option<(u64, u64, u64)> = None; // episodes, days, seconds
    let mut qualifying_total = 0u64;
    for responsibility in live_responsibilities {
        let mut episodes = 0u64;
        let mut days: std::collections::BTreeSet<String> = Default::default();
        let mut seconds = 0u64;
        for row in rows
            .iter()
            .filter(|r| &r.responsibility_id == responsibility)
        {
            if !matches!(
                row.outcome.as_str(),
                "retention_lost" | "declared_deadline_missed"
            ) {
                continue;
            }
            if row.coverage_gap_id.is_none() {
                continue;
            }
            let closed = parse_z(&row.app_closed_at)?;
            let resolved = parse_z(&row.resolved_at)?;
            let duration = (resolved - closed).num_seconds().max(0) as u64;
            if duration < constants.min_episode_seconds {
                continue;
            }
            episodes += 1;
            seconds += duration;
            days.insert(
                closed
                    .with_timezone(&tz)
                    .date_naive()
                    .format("%Y-%m-%d")
                    .to_string(),
            );
        }
        qualifying_total += episodes;
        let candidate = (episodes, days.len() as u64, seconds);
        if best.as_ref().is_none_or(|b| candidate > *b) {
            best = Some(candidate);
        }
    }
    let (episodes, days, seconds) = best.unwrap_or((0, 0, 0));
    let metrics = vec![
        aggregate_count("gap_episodes", qualifying_total),
        aggregate_count("qualifying_gap_days", days),
        TriggerMetric::Quantity {
            name: evaluation::QuantityName::Fixed("gap_duration".to_string()),
            value: seconds,
            unit: "seconds".to_string(),
            series: MetricSeriesKey::Aggregate,
        },
    ];
    let fired = episodes >= constants.min_episodes
        && days >= constants.min_distinct_days
        && seconds >= constants.min_total_seconds;
    Ok((
        metrics,
        if fired {
            TriggerResult::Fired
        } else {
            TriggerResult::NotFired
        },
    ))
}

/// Evaluate R10 over one vault store.
pub fn evaluate_r10(
    conn: &Connection,
    registry: &Registry,
    scope: &VaultScope,
    evaluated_at: chrono::DateTime<chrono::Utc>,
    timezone: &str,
) -> Result<Recorded, String> {
    let tz = chrono_tz::Tz::from_str(timezone).map_err(|e| format!("{timezone:?}: {e}"))?;
    let window_days = constant(registry, "R10:root", "window_days")?;
    let constants = R10Constants {
        min_episodes: constant(registry, "R10:root", "min_episodes")?,
        min_distinct_days: constant(registry, "R10:root", "min_distinct_days")?,
        min_episode_seconds: constant(registry, "R10:root", "min_episode_seconds")?,
        min_total_seconds: constant(registry, "R10:root", "min_total_seconds")?,
    };
    let (window, start, end) = complete_window(tz, evaluated_at, window_days)?;

    let mut live = Vec::new();
    let mut statement = conn
        .prepare(
            "SELECT DISTINCT responsibility_id FROM responsibility_contracts \
             WHERE store_uuid = ?1 AND active_to IS NULL ORDER BY responsibility_id",
        )
        .map_err(|e| e.to_string())?;
    let fetched = statement
        .query_map(rusqlite::params![scope.store_uuid], |r| {
            r.get::<_, String>(0)
        })
        .map_err(|e| e.to_string())?;
    for id in fetched {
        live.push(id.map_err(|e| e.to_string())?);
    }

    let mut statement = conn
        .prepare(
            "SELECT episode_id, responsibility_id, contract_version, app_closed_at, \
                    resolved_at, outcome, coverage_gap_id \
             FROM catchup_outcomes WHERE vault_id = ?1 AND store_uuid = ?2 \
             ORDER BY episode_id, responsibility_id, contract_version",
        )
        .map_err(|e| e.to_string())?;
    let fetched = statement
        .query_map(rusqlite::params![scope.vault_id, scope.store_uuid], |r| {
            Ok(R10Row {
                episode_id: r.get(0)?,
                responsibility_id: r.get(1)?,
                contract_version: r.get::<_, i64>(2)? as u64,
                app_closed_at: r.get(3)?,
                resolved_at: r.get(4)?,
                outcome: r.get(5)?,
                coverage_gap_id: r.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut rows = Vec::new();
    for row in fetched {
        let row = row.map_err(|e| e.to_string())?;
        let resolved = parse_z(&row.resolved_at)?;
        if resolved >= start && resolved < end {
            rows.push(row);
        }
    }

    let (metrics, result) = r10_outcome(&rows, &live, &constants, tz)?;
    persist(
        conn,
        registry,
        GateKey {
            registry_id: "R10".into(),
            subcapability: "root".into(),
        },
        scope.evaluation_scope(),
        scope.stored_scope(),
        window,
        &serde_json::json!({ "rows": rows, "live_responsibilities": live }),
        metrics,
        result,
        &evaluated_at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
    )
}

// --- R2: the fixed-ceiling headroom leg ------------------------------------

/// One budget day as sampled for R2.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct R2Row {
    pub window_start_utc: String,
    pub timezone_id: String,
    pub settings_version: u64,
    pub settings_digest: String,
    pub max_daily_tokens: u64,
    pub accounting_state: String,
    pub ambient_tokens_used: u64,
    pub local_date: String,
}

/// What the owner's evidence pack froze before the window began. Parsing the
/// pack itself is the evidence validator's job; this leg takes the frozen
/// values and answers only the measurable question.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct R2Pack {
    pub max_daily_tokens: u64,
    pub timezone_id: String,
    pub settings_version: u64,
    pub settings_digest: String,
}

/// The pure headroom leg. Every one of the `window_days` rows must exist and
/// match the pack's immutable ceiling, digest, version, and timezone — a
/// change-and-revert appends a NEW settings version, so it stays visible
/// here. History is never reconstructed from today's mutable setting.
pub fn r2_headroom(
    rows: &[R2Row],
    pack: &R2Pack,
    window_days: u64,
    min_unused_ppm: u64,
    min_qualifying_days: u64,
) -> (Vec<TriggerMetric>, TriggerResult) {
    let mut metrics = Vec::new();
    if rows.len() as u64 != window_days || pack.max_daily_tokens == 0 {
        return (
            vec![aggregate_count("headroom_days", 0)],
            TriggerResult::NotReady,
        );
    }
    let mut qualifying = 0u64;
    for row in rows {
        let matches_pack = row.timezone_id == pack.timezone_id
            && row.settings_version == pack.settings_version
            && row.settings_digest == pack.settings_digest
            && row.max_daily_tokens == pack.max_daily_tokens
            && row.accounting_state == "exact";
        if !matches_pack {
            return (
                vec![aggregate_count("headroom_days", 0)],
                TriggerResult::NotReady,
            );
        }
        // Saturating: usage past the ceiling is zero headroom, not negative.
        let unused = pack
            .max_daily_tokens
            .saturating_sub(row.ambient_tokens_used);
        let unused_ppm = unused * 1_000_000 / pack.max_daily_tokens;
        if unused_ppm >= min_unused_ppm {
            qualifying += 1;
        }
        metrics.push(ratio(
            "unused_headroom",
            unused,
            pack.max_daily_tokens,
            MetricSeriesKey::Day {
                local_date: row.local_date.clone(),
            },
        ));
    }
    metrics.push(aggregate_count("headroom_days", qualifying));
    let result = if qualifying >= min_qualifying_days {
        TriggerResult::Fired
    } else {
        TriggerResult::NotFired
    };
    (metrics, result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::trigger::registry;
    use crate::vault::testutil;

    const NOW: &str = "2026-08-14T09:30:00Z";

    fn utc(stamp: &str) -> chrono::DateTime<chrono::Utc> {
        parse_z(stamp).unwrap()
    }

    fn empty_store(label: &str) -> (std::path::PathBuf, Connection, VaultScope) {
        let dir = testutil::temp_vault(label);
        let conn = crate::runtime::open(&dir).unwrap();
        let vault = crate::runtime::scope::register(&conn, &dir).unwrap();
        let scope = VaultScope {
            vault_id: vault,
            store_uuid: "feedfacefeedfacefeedfacefeedface".to_string(),
        };
        (dir, conn, scope)
    }

    #[test]
    fn two_gates_sharing_bytes_are_two_snapshots() {
        // R3 and R6 over an empty store collect byte-identical payloads. The
        // snapshot id names the question as well as the bytes — without
        // that, the second gate's record refuses as an amended snapshot.
        // Found by the M28.1 runner's first pass over one database.
        let (dir, conn, scope) = empty_store("evaluate-shared-bytes");
        let registry = registry::load().unwrap();
        let r3 = evaluate_r3(&conn, &registry, &scope, utc(NOW), "Europe/Berlin").unwrap();
        let r6 = evaluate_r6(&conn, &registry, &scope, utc(NOW), "Europe/Berlin").unwrap();
        assert_eq!(r3.snapshot_put, Put::Inserted);
        assert_eq!(r6.snapshot_put, Put::Inserted);
        assert_ne!(r3.snapshot_id, r6.snapshot_id);
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_later_ask_the_same_day_replays_with_the_first_stamp() {
        // The evaluation id hashes inputs, not the instant of asking. The
        // 17:30 ask answers the same window as the 09:30 ask, so it replays
        // the 09:30 record — first observation of the fact stands.
        let (dir, conn, scope) = empty_store("evaluate-same-day");
        let registry = registry::load().unwrap();
        let first = evaluate_r13(&conn, &registry, &scope, utc(NOW), "Europe/Berlin").unwrap();
        let later = evaluate_r13(
            &conn,
            &registry,
            &scope,
            utc("2026-08-14T17:30:00Z"),
            "Europe/Berlin",
        )
        .unwrap();
        assert_eq!(later.evaluation_put, Put::Replayed);
        assert_eq!(later.evaluation, first.evaluation);
        assert_eq!(later.evaluation.evaluated_at, "2026-08-14T09:30:00Z");
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_next_day_is_a_new_evaluation() {
        // The window moved, so the question moved — even when the store is
        // quiet and the payload bytes did not.
        let (dir, conn, scope) = empty_store("evaluate-next-day");
        let registry = registry::load().unwrap();
        let today = evaluate_r13(&conn, &registry, &scope, utc(NOW), "Europe/Berlin").unwrap();
        let tomorrow = evaluate_r13(
            &conn,
            &registry,
            &scope,
            utc("2026-08-15T09:30:00Z"),
            "Europe/Berlin",
        )
        .unwrap();
        assert_eq!(tomorrow.evaluation_put, Put::Inserted);
        assert_ne!(
            tomorrow.evaluation.evaluation_id,
            today.evaluation.evaluation_id
        );
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn r13_constants() -> R13Constants {
        let (_, constants) = R13Constants::load(&registry::load().unwrap()).unwrap();
        constants
    }

    fn plan(n: usize, state: &str, created_at: &str, stakes: Option<&str>) -> R13Row {
        R13Row {
            plan_id: format!("{n:064}"),
            assembly_id: format!("{:032}", n % 10),
            state: state.to_string(),
            created_at: created_at.to_string(),
            stakes: stakes.map(String::from),
        }
    }

    /// A sample satisfying every R13 floor and threshold exactly: 20 plans
    /// from 10 runs, 12 pending past the cutoff, 4 of them HIGH.
    fn r13_firing_sample() -> Vec<R13Row> {
        let mut rows = Vec::new();
        for n in 0..12 {
            let stakes = if n < 4 { Some("HIGH") } else { Some("LOW") };
            rows.push(plan(n, "pending", "2026-07-20T08:00:00Z", stakes));
        }
        for n in 12..20 {
            rows.push(plan(n, "dismissed", "2026-08-01T08:00:00Z", Some("LOW")));
        }
        rows
    }

    #[test]
    fn r13_fires_at_exactly_the_thresholds_and_not_one_below() {
        let constants = r13_constants();
        let cutoff = utc("2026-07-31T00:00:00Z");
        let rows = r13_firing_sample();
        let (_, result) = r13_outcome(&rows, &constants, cutoff).unwrap();
        assert_eq!(result, TriggerResult::Fired);

        // One fewer HIGH pending: not fired.
        let mut fewer_high = rows.clone();
        fewer_high[3].stakes = Some("MEDIUM".into());
        let (_, result) = r13_outcome(&fewer_high, &constants, cutoff).unwrap();
        assert_eq!(result, TriggerResult::NotFired);

        // One pending plan too YOUNG to have waited 14 full days: not fired.
        let mut young = rows.clone();
        young[11].created_at = "2026-08-10T08:00:00Z".into();
        let (metrics, result) = r13_outcome(&young, &constants, cutoff).unwrap();
        assert_eq!(result, TriggerResult::NotFired);
        assert!(metrics.contains(&aggregate_count("pending_plans", 11)));
    }

    #[test]
    fn r13_below_a_sample_floor_is_not_ready_never_not_fired() {
        let constants = r13_constants();
        let cutoff = utc("2026-07-31T00:00:00Z");
        let mut rows = r13_firing_sample();
        rows.pop(); // 19 emitted plans: below the floor.
        let (_, result) = r13_outcome(&rows, &constants, cutoff).unwrap();
        assert_eq!(result, TriggerResult::NotReady);

        // Twenty plans all from ONE run: the emission-run floor fails alone.
        let mut one_run = r13_firing_sample();
        for row in &mut one_run {
            row.assembly_id = format!("{:032}", 1);
        }
        let (_, result) = r13_outcome(&one_run, &constants, cutoff).unwrap();
        assert_eq!(result, TriggerResult::NotReady);
    }

    #[test]
    fn r13_a_missing_manifest_cannot_raise_stakes() {
        let constants = r13_constants();
        let cutoff = utc("2026-07-31T00:00:00Z");
        let mut rows = r13_firing_sample();
        rows[0].stakes = None;
        let (_, result) = r13_outcome(&rows, &constants, cutoff).unwrap();
        assert_eq!(
            result,
            TriggerResult::NotFired,
            "3 HIGH is below the floor of 4"
        );
    }

    fn resolver_row(n: usize, day: &str, outcome: &str, parked: bool, targets: u64) -> ResolverRow {
        ResolverRow {
            attempt_id: format!("attempt-{n}"),
            artifact_id: format!("artifact-{}", n % 60),
            ingest_item_id: format!("item-{n}"),
            eligible: true,
            ineligible_reason: None,
            outcome: outcome.to_string(),
            attachment_state: Some(if parked { "parked" } else { "attached" }.to_string()),
            target_count: Some(targets),
            attempted_at: format!("{day}T10:00:00Z"),
        }
    }

    /// 60 eligible attempts per bucket, exactly 10% blocked in buckets 1-3.
    fn r3_sample() -> Vec<ResolverRow> {
        let days = ["2026-07-17", "2026-07-24", "2026-07-31", "2026-08-07"];
        let mut rows = Vec::new();
        let mut n = 0;
        for (bucket, day) in days.iter().enumerate() {
            for i in 0..60 {
                let blocked = bucket < 3 && i < 6;
                rows.push(resolver_row(
                    n,
                    day,
                    if blocked {
                        "claim_granularity_blocked"
                    } else {
                        "exact_id"
                    },
                    blocked,
                    if blocked { 2 } else { 1 },
                ));
                n += 1;
            }
        }
        rows
    }

    fn bucketized(
        rows: &[ResolverRow],
    ) -> Vec<(chrono::NaiveDate, chrono::NaiveDate, Vec<&ResolverRow>)> {
        let registry = registry::load().unwrap();
        let constants = bucket_constants(&registry, "R3:root").unwrap();
        let start = chrono::NaiveDate::parse_from_str("2026-07-17", "%Y-%m-%d").unwrap();
        bucketize(rows, chrono_tz::Tz::UTC, start, &constants).unwrap()
    }

    #[test]
    fn r3_fires_on_three_buckets_at_the_rate_and_not_on_two() {
        let registry = registry::load().unwrap();
        let constants = bucket_constants(&registry, "R3:root").unwrap();
        let rows = r3_sample();
        let (_, result) = r3_outcome(&bucketized(&rows), &constants, 100_000);
        assert_eq!(result, TriggerResult::Fired);

        // Nudge one blocked attempt in bucket 3 under the numerator's
        // definition (attached, not parked): 5.9% there, two firing buckets.
        let mut two_buckets = rows.clone();
        let victim = two_buckets
            .iter_mut()
            .find(|r| r.attempted_at.starts_with("2026-07-31") && r3_blocked(r))
            .unwrap();
        victim.attachment_state = Some("attached".into());
        let (_, result) = r3_outcome(&bucketized(&two_buckets), &constants, 100_000);
        assert_eq!(result, TriggerResult::NotFired);
    }

    #[test]
    fn r3_a_bucket_below_its_floor_is_not_ready_even_when_rates_scream() {
        let registry = registry::load().unwrap();
        let constants = bucket_constants(&registry, "R3:root").unwrap();
        let mut rows = r3_sample();
        // Starve bucket 4 below 50 attempts.
        rows.retain(|r| {
            !(r.attempted_at.starts_with("2026-08-07")
                && r.attempt_id
                    .strip_prefix("attempt-")
                    .and_then(|n| n.parse::<usize>().ok())
                    .is_some_and(|n| n >= 220))
        });
        let (_, result) = r3_outcome(&bucketized(&rows), &constants, 100_000);
        assert_eq!(result, TriggerResult::NotReady);
    }

    #[test]
    fn r6_needs_both_legs_in_the_same_bucket() {
        let registry = registry::load().unwrap();
        let constants = bucket_constants(&registry, "R6:root").unwrap();
        let days = ["2026-07-17", "2026-07-24", "2026-07-31", "2026-08-07"];
        // Per bucket: 60 attempts, 10 unresolved+parked, 10 resolved+parked —
        // attempt rate 16.6% (>=15%), item rate 10/20 = 50% (>=40%).
        let mut rows = Vec::new();
        let mut n = 0;
        for day in days {
            for i in 0..60 {
                let unresolved = i < 10;
                let parked = i < 20;
                rows.push(resolver_row(
                    n,
                    day,
                    if unresolved { "unresolved" } else { "exact_id" },
                    parked,
                    1,
                ));
                n += 1;
            }
        }
        let (_, result) = r6_outcome(&bucketized(&rows), &constants, 150_000, 400_000);
        assert_eq!(result, TriggerResult::Fired);

        // Keep the attempt leg, break the item leg: park MANY resolved items
        // so unresolved/parked drops under 40% in every bucket.
        let mut diluted = rows.clone();
        for row in &mut diluted {
            if row.outcome == "exact_id" {
                row.attachment_state = Some("parked".into());
            }
        }
        let (_, result) = r6_outcome(&bucketized(&diluted), &constants, 150_000, 400_000);
        assert_eq!(result, TriggerResult::NotFired);
    }

    #[test]
    fn r10_counts_only_lossful_linked_long_episodes_of_a_live_responsibility() {
        let constants = R10Constants {
            min_episodes: 3,
            min_distinct_days: 3,
            min_episode_seconds: 14_400,
            min_total_seconds: 43_200,
        };
        let episode = |n: usize, day: &str, outcome: &str, hours: i64, gap: bool| R10Row {
            episode_id: format!("episode-{n}"),
            responsibility_id: "resp-1".into(),
            contract_version: 1,
            app_closed_at: format!("{day}T00:00:00Z"),
            resolved_at: format!("{day}T{hours:02}:00:00Z"),
            outcome: outcome.into(),
            coverage_gap_id: gap.then(|| format!("gap-{n}")),
        };
        let rows = vec![
            episode(1, "2026-07-20", "retention_lost", 5, true),
            episode(2, "2026-07-22", "declared_deadline_missed", 4, true),
            episode(3, "2026-07-25", "retention_lost", 4, true),
        ];
        let live = vec!["resp-1".to_string()];
        let (_, result) = r10_outcome(&rows, &live, &constants, chrono_tz::Tz::UTC).unwrap();
        assert_eq!(
            result,
            TriggerResult::Fired,
            "13h across 3 days and 3 episodes"
        );

        // A successful catch-up, an unlinked outcome, and a short episode
        // each fail to qualify — swap any one in and the gate closes.
        for spoiled in [
            episode(3, "2026-07-25", "caught_up", 4, true),
            episode(3, "2026-07-25", "retention_lost", 4, false),
            episode(3, "2026-07-25", "retention_lost", 3, true),
        ] {
            let rows = vec![rows[0].clone(), rows[1].clone(), spoiled];
            let (_, result) = r10_outcome(&rows, &live, &constants, chrono_tz::Tz::UTC).unwrap();
            assert_eq!(result, TriggerResult::NotFired);
        }

        // No live responsibility: there is nothing to measure, and saying
        // "not fired" would claim there was.
        let (_, result) = r10_outcome(&rows, &[], &constants, chrono_tz::Tz::UTC).unwrap();
        assert_eq!(result, TriggerResult::NotReady);
    }

    fn r2_pack() -> R2Pack {
        R2Pack {
            max_daily_tokens: 1_000_000,
            timezone_id: "Europe/Berlin".into(),
            settings_version: 3,
            settings_digest: "d".repeat(64),
        }
    }

    fn r2_rows(days: u64, used: u64) -> Vec<R2Row> {
        (0..days)
            .map(|n| R2Row {
                window_start_utc: format!("2026-07-{:02}T22:00:00Z", n + 1),
                timezone_id: "Europe/Berlin".into(),
                settings_version: 3,
                settings_digest: "d".repeat(64),
                max_daily_tokens: 1_000_000,
                accounting_state: "exact".into(),
                ambient_tokens_used: used,
                local_date: format!("2026-07-{:02}", n + 2),
            })
            .collect()
    }

    #[test]
    fn r2_fires_on_twenty_one_quiet_days_and_saturates_over_ceiling() {
        let mut rows = r2_rows(28, 700_000); // 300_000 ppm unused everywhere
        for row in rows.iter_mut().take(7) {
            row.ambient_tokens_used = 1_200_000; // over ceiling: ZERO, not negative
        }
        let (metrics, result) = r2_headroom(&rows, &r2_pack(), 28, 200_000, 21);
        assert_eq!(result, TriggerResult::Fired, "exactly 21 qualifying days");
        assert!(metrics.contains(&aggregate_count("headroom_days", 21)));

        rows[7].ambient_tokens_used = 900_000; // 100_000 ppm: 20 qualifying
        let (_, result) = r2_headroom(&rows, &r2_pack(), 28, 200_000, 21);
        assert_eq!(result, TriggerResult::NotFired);
    }

    #[test]
    fn r2_any_row_that_disagrees_with_the_pack_invalidates_the_window() {
        let pack = r2_pack();
        for mutate in [
            |r: &mut R2Row| r.settings_version = 4,
            |r: &mut R2Row| r.settings_digest = "e".repeat(64),
            |r: &mut R2Row| r.max_daily_tokens = 2_000_000,
            |r: &mut R2Row| r.timezone_id = "UTC".into(),
            |r: &mut R2Row| r.accounting_state = "unknown".into(),
        ] {
            let mut rows = r2_rows(28, 700_000);
            mutate(&mut rows[13]);
            let (_, result) = r2_headroom(&rows, &pack, 28, 200_000, 21);
            assert_eq!(result, TriggerResult::NotReady);
        }
        // A missing day is the same answer.
        let (_, result) = r2_headroom(&r2_rows(27, 700_000), &pack, 28, 200_000, 21);
        assert_eq!(result, TriggerResult::NotReady);
    }

    #[test]
    fn an_evaluation_persists_replays_and_touches_only_the_governance_tables() {
        let dir = testutil::temp_vault("trigger-evaluate-r13");
        let conn = crate::runtime::open(&dir).unwrap();
        let vault = crate::runtime::scope::register(&conn, &dir).unwrap();
        let registry = registry::load().unwrap();
        let scope = VaultScope {
            vault_id: vault.clone(),
            store_uuid: "feedfacefeedfacefeedfacefeedface".into(),
        };
        // Seed a small (below-floor) discovery population, with one manifest.
        conn.execute(
            "INSERT INTO working_memory_manifests (vault_id, store_uuid, assembly_id, \
             question_hash, chain_head, assembler_version, intended_use_kind, stakes, \
             predicate_class, counterevidence_state, source_count, context_bytes, \
             evidence_item_count, manifest_json, assembled_at) \
             VALUES (?1, ?2, ?3, ?4, 'head', 'v1', 'draft_note', 'HIGH', NULL, 'included', \
                     1, 10, 1, '{}', '2026-07-20T08:00:00.000Z')",
            rusqlite::params![vault, scope.store_uuid, "a".repeat(32), "b".repeat(64)],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO discovery_plan_runs (vault_id, store_uuid, plan_id, assembly_id, \
             state, created_at) VALUES (?1, ?2, ?3, ?4, 'pending', '2026-07-20T08:05:00.000Z')",
            rusqlite::params![vault, scope.store_uuid, "c".repeat(64), "a".repeat(32)],
        )
        .unwrap();

        let recorded = evaluate_r13(&conn, &registry, &scope, utc(NOW), "Europe/Berlin").unwrap();
        assert_eq!(recorded.evaluation.result, TriggerResult::NotReady);
        assert_eq!(recorded.snapshot_put, Put::Inserted);
        assert_eq!(recorded.evaluation_put, Put::Inserted);
        assert_eq!(
            recorded.evaluation.window.as_ref().unwrap().timezone,
            "Europe/Berlin"
        );

        // The rerun is byte-identical and replays — the design's idempotency
        // contract, observed rather than asserted.
        let rerun = evaluate_r13(&conn, &registry, &scope, utc(NOW), "Europe/Berlin").unwrap();
        assert_eq!(rerun.evaluation, recorded.evaluation);
        assert_eq!(rerun.snapshot_put, Put::Replayed);
        assert_eq!(rerun.evaluation_put, Put::Replayed);

        // Only the two governance tables hold trigger rows; the row we can
        // read back validates against the shared registry.
        let stored =
            crate::runtime::triggers::evaluation(&conn, &recorded.evaluation.evaluation_id)
                .unwrap()
                .unwrap();
        let reparsed: TriggerEvaluation = serde_json::from_str(&stored.record_json).unwrap();
        assert_eq!(reparsed, recorded.evaluation);
        evaluation::validate(&reparsed, &registry).unwrap();
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn nothing_here_reads_a_clock() {
        // `evaluated_at` arrives from the caller; two runs over the same
        // rows at the same declared instant are byte-identical, which is what
        // makes reruns replays.
        let source = include_str!("evaluate.rs");
        let body = source
            .split("#[cfg(test)]")
            .next()
            .expect("the non-test half");
        for forbidden in ["Utc::now", "SystemTime", "Local::now"] {
            assert!(
                !body.contains(forbidden),
                "{forbidden:?} appears in the evaluator"
            );
        }
    }
}
