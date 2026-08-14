//! The closed `TriggerEvaluation` record (M28.0) — Rust side.
//!
//! One record shape, three arms, and the ARTIFACT decides which arm a gate
//! key must use. This module holds the generic machinery: the serde types,
//! the domain-separated derivations (`evaluation_id`, `input_snapshot_hash`),
//! and `validate`, which checks a record against
//! `shared/policy/trigger-registry.v1.json` and refuses with a CLOSED code.
//! `src/lib/trigger/evaluation.ts` is the second interpreter, and the parity
//! mechanism is the shared goldens in `shared/policy/goldens-trigger/` —
//! replayed by `cargo test` and `pnpm test:run` from the same bytes.
//!
//! **Refusal codes are the contract; details are prose.** The goldens pin
//! codes, never messages, the same split the conformance vectors use.
//!
//! **The record is one struct, not three.** The spec's union arms differ only
//! in which halves are present, exactly as the V11 DDL spells it; a struct
//! with options plus a `variant` tag means a record with a forbidden half
//! present PARSES and then refuses with a code a golden can name, rather
//! than failing as an anonymous serde error on one side and something else
//! on the other.

use std::collections::BTreeSet;
use std::str::FromStr;

use crate::ledger::sha256_hex;
use crate::trigger::registry::{ParentRule, Registry, ScopeKind, Variant};

/// The closed result vocabulary.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TriggerResult {
    NotReady,
    NotFired,
    Fired,
}

impl TriggerResult {
    pub fn as_str(self) -> &'static str {
        match self {
            TriggerResult::NotReady => "not_ready",
            TriggerResult::NotFired => "not_fired",
            TriggerResult::Fired => "fired",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub struct GateKey {
    pub registry_id: String,
    pub subcapability: String,
}

impl GateKey {
    /// `R4:issue` — the spelling the evaluation id hashes.
    pub fn canonical(&self) -> String {
        format!("{}:{}", self.registry_id, self.subcapability)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EvaluationScope {
    SubscriptionGlobal,
    VaultStore {
        vault_id: String,
        store_uuid: String,
    },
}

impl EvaluationScope {
    /// The spelling the evaluation id hashes. Flat and positional, so neither
    /// language depends on an object key order.
    pub fn canonical(&self) -> String {
        match self {
            EvaluationScope::SubscriptionGlobal => "subscription_global".to_string(),
            EvaluationScope::VaultStore {
                vault_id,
                store_uuid,
            } => format!("vault_store:{vault_id}:{store_uuid}"),
        }
    }

    fn kind(&self) -> ScopeKind {
        match self {
            EvaluationScope::SubscriptionGlobal => ScopeKind::SubscriptionGlobal,
            EvaluationScope::VaultStore { .. } => ScopeKind::VaultStore,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub struct Window {
    pub start: String,
    pub end: String,
    pub timezone: String,
}

/// Declared in tag-alphabetical order (`evidence` < `runtime`) so the derived
/// `Ord` IS the canonical ref order — the same order a TS sort by tag then
/// key produces, with no second rule to keep in agreement.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum InputSnapshotRef {
    Evidence { path: String },
    Runtime { snapshot_id: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
pub enum Quantile {
    #[serde(rename = "p50")]
    P50,
    #[serde(rename = "p90")]
    P90,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MetricSeriesKey {
    Aggregate,
    Sample {
        run_id: String,
    },
    Source {
        store_uuid: String,
        source_id: String,
    },
    Day {
        local_date: String,
    },
    Bucket {
        ordinal: u8,
        start_date: String,
        end_date: String,
    },
    Statistic {
        quantile: Quantile,
    },
    HighStakesDailyLoad,
}

/// A quantity metric's name: one of the fixed names, or a projected M26 cost
/// component. Untagged, so the fixed names read as plain strings.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(untagged)]
pub enum QuantityName {
    Component { projected_component: ComponentRef },
    Fixed(String),
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub struct ComponentRef {
    pub component: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TriggerMetric {
    Count {
        name: String,
        series: MetricSeriesKey,
        value: u64,
    },
    RatioPpm {
        name: String,
        numerator: u64,
        denominator: u64,
        value_ppm: u64,
        series: MetricSeriesKey,
    },
    Quantity {
        name: QuantityName,
        value: u64,
        unit: String,
        series: MetricSeriesKey,
    },
}

/// The record, all three arms in one shape. Which halves must be present is
/// the artifact's answer, checked in [`validate`].
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub struct TriggerEvaluation {
    pub variant: Variant,
    pub evaluation_id: String,
    pub gate_key: GateKey,
    pub scope: EvaluationScope,
    pub evaluated_at: String,
    #[serde(default)]
    pub window: Option<Window>,
    pub input_snapshot_refs: Vec<InputSnapshotRef>,
    pub input_snapshot_hash: String,
    #[serde(default)]
    pub metrics: Vec<TriggerMetric>,
    #[serde(default)]
    pub evidence_pack_path: Option<String>,
    pub result: TriggerResult,
    pub rule_version: String,
    #[serde(default)]
    pub approving_owner: Option<String>,
    #[serde(default)]
    pub parent_evaluation_id: Option<String>,
}

/// A validation refusal: a closed code the goldens pin, and prose they do not.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refusal {
    pub code: &'static str,
    pub detail: String,
}

fn refuse(code: &'static str, detail: impl Into<String>) -> Refusal {
    Refusal {
        code,
        detail: detail.into(),
    }
}

/// `sha256(domain \0 gate_key \0 scope \0 rule_version \0 snapshot_hash)` —
/// the design's formula, verbatim.
pub fn derive_evaluation_id(
    domain: &str,
    gate_key: &GateKey,
    scope: &EvaluationScope,
    rule_version: &str,
    input_snapshot_hash: &str,
) -> String {
    sha256_hex(
        format!(
            "{domain}\0{}\0{}\0{rule_version}\0{input_snapshot_hash}",
            gate_key.canonical(),
            scope.canonical()
        )
        .as_bytes(),
    )
}

/// The domain-separated hash of the RESOLVED canonical payloads, in tag/key
/// order. `parts` is (tag, key, canonical_payload): `("runtime",
/// snapshot_id, payload_json)` or `("evidence", path, canonical_payload)`.
/// Sorted here, so a caller's collection order cannot mint a second hash.
pub fn derive_input_snapshot_hash(domain: &str, parts: &[(String, String, String)]) -> String {
    let mut sorted: Vec<&(String, String, String)> = parts.iter().collect();
    sorted.sort();
    let mut bytes = domain.as_bytes().to_vec();
    for (tag, key, payload) in sorted {
        bytes.push(0);
        bytes.extend_from_slice(tag.as_bytes());
        bytes.push(0);
        bytes.extend_from_slice(key.as_bytes());
        bytes.push(0);
        bytes.extend_from_slice(payload.as_bytes());
    }
    sha256_hex(&bytes)
}

fn is_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
}

fn is_local_date(value: &str) -> bool {
    value.len() == 10 && chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d").is_ok()
}

fn parse_stamp(value: &str) -> Option<chrono::DateTime<chrono::FixedOffset>> {
    chrono::DateTime::parse_from_rfc3339(value).ok()
}

/// Validate a record against the registry, without its parent. A gate whose
/// rules name a parent still needs [`validate_parent`] — this function
/// refuses `parent_invalid` only for the half it can see alone (a parent
/// named where none is allowed, or none named where one is required).
pub fn validate(record: &TriggerEvaluation, registry: &Registry) -> Result<(), Refusal> {
    let gate = registry
        .resolve(&record.gate_key.registry_id, &record.gate_key.subcapability)
        .ok_or_else(|| {
            refuse(
                "gate_unknown",
                format!(
                    "{} is not a gate the registry declares — there is no default variant and no \
                     benefit of the doubt",
                    record.gate_key.canonical()
                ),
            )
        })?;

    if record.variant != gate.variant {
        return Err(refuse(
            "variant_mismatch",
            format!(
                "{} must be evaluated as {}, not {}",
                record.gate_key.canonical(),
                gate.variant.as_str(),
                record.variant.as_str()
            ),
        ));
    }
    if record.scope.kind() != gate.scope {
        return Err(refuse(
            "scope_mismatch",
            format!(
                "{} evaluations are {}-scoped",
                record.gate_key.canonical(),
                gate.scope.as_str()
            ),
        ));
    }
    if let EvaluationScope::VaultStore {
        vault_id,
        store_uuid,
    } = &record.scope
    {
        if vault_id.is_empty() || store_uuid.is_empty() {
            return Err(refuse(
                "scope_mismatch",
                "a vault_store scope names both halves",
            ));
        }
    }

    // The arm shape: which halves exist is the variant's answer, the same
    // CHECKs the V11 DDL holds.
    let shape_err = |detail: &str| refuse("variant_shape", detail.to_string());
    match record.variant {
        Variant::Measurable => {
            if record.window.is_none() {
                return Err(shape_err("a measurable record carries a window"));
            }
            if record.metrics.is_empty() {
                return Err(shape_err("a measurable record carries at least one metric"));
            }
            if record.evidence_pack_path.is_some() {
                return Err(shape_err("a measurable record carries no evidence pack"));
            }
            if record.approving_owner.is_some() {
                return Err(shape_err("a measurable record has no approving owner"));
            }
        }
        Variant::Discretionary => {
            if record.window.is_some() {
                return Err(shape_err("a discretionary record carries no window"));
            }
            if !record.metrics.is_empty() {
                return Err(shape_err("a discretionary record carries no metrics"));
            }
            if record.evidence_pack_path.is_none() {
                return Err(shape_err("a discretionary record names its evidence pack"));
            }
            if record.approving_owner.as_deref().is_none_or(str::is_empty) {
                return Err(shape_err(
                    "a discretionary record names its approving owner",
                ));
            }
        }
        Variant::Hybrid => {
            if record.window.is_none() || record.metrics.is_empty() {
                return Err(shape_err(
                    "a hybrid record carries the whole measurable half",
                ));
            }
            if record.evidence_pack_path.is_none()
                || record.approving_owner.as_deref().is_none_or(str::is_empty)
            {
                return Err(shape_err(
                    "a hybrid record carries the whole discretionary half",
                ));
            }
        }
    }

    if parse_stamp(&record.evaluated_at).is_none() {
        return Err(refuse("window_invalid", "evaluated_at is not RFC3339"));
    }
    if let Some(window) = &record.window {
        let (Some(start), Some(end)) = (parse_stamp(&window.start), parse_stamp(&window.end))
        else {
            return Err(refuse("window_invalid", "window stamps are not RFC3339"));
        };
        if end < start {
            return Err(refuse(
                "window_invalid",
                "a window ends no earlier than it starts",
            ));
        }
        if chrono_tz::Tz::from_str(&window.timezone).is_err() {
            return Err(refuse(
                "window_invalid",
                format!("{:?} is not an IANA timezone", window.timezone),
            ));
        }
    }

    validate_refs(record, registry)?;
    validate_metrics(record, registry)?;

    if record.rule_version != registry.rule_version {
        return Err(refuse(
            "rule_version_mismatch",
            format!(
                "the record claims {:?} and the registry is {:?} — an evaluation under different \
                 rules is a different evaluation",
                record.rule_version, registry.rule_version
            ),
        ));
    }

    // Parent presence, from the artifact. The parent RECORD is checked in
    // `validate_parent`; here only the topology the registry alone decides.
    match (&gate.parent, &record.parent_evaluation_id) {
        (None, Some(_)) => {
            return Err(refuse(
                "parent_invalid",
                format!("{} takes no parent evaluation", record.gate_key.canonical()),
            ))
        }
        (Some(_), None) => {
            return Err(refuse(
                "parent_invalid",
                format!(
                    "{} requires a fired parent evaluation",
                    record.gate_key.canonical()
                ),
            ))
        }
        _ => {}
    }
    if let Some(parent_id) = &record.parent_evaluation_id {
        if !is_hash(parent_id) {
            return Err(refuse(
                "parent_invalid",
                "parent_evaluation_id is not a sha256",
            ));
        }
        if *parent_id == record.evaluation_id {
            return Err(refuse(
                "parent_invalid",
                "an evaluation cannot parent itself",
            ));
        }
    }

    if !is_hash(&record.input_snapshot_hash) {
        return Err(refuse(
            "refs_invalid",
            "input_snapshot_hash is not a sha256",
        ));
    }
    let expected_id = derive_evaluation_id(
        &registry.evaluation_id_domain,
        &record.gate_key,
        &record.scope,
        &record.rule_version,
        &record.input_snapshot_hash,
    );
    if record.evaluation_id != expected_id {
        return Err(refuse(
            "evaluation_id_mismatch",
            format!(
                "the id does not recompute: claimed {}, derived {expected_id}",
                record.evaluation_id
            ),
        ));
    }
    Ok(())
}

fn validate_refs(record: &TriggerEvaluation, registry: &Registry) -> Result<(), Refusal> {
    if record.input_snapshot_refs.is_empty() {
        return Err(refuse("refs_invalid", "input_snapshot_refs is never empty"));
    }
    let mut sorted = record.input_snapshot_refs.clone();
    sorted.sort();
    if sorted != record.input_snapshot_refs {
        return Err(refuse("refs_invalid", "input_snapshot_refs must be sorted"));
    }
    let runtime: Vec<&str> = record
        .input_snapshot_refs
        .iter()
        .filter_map(|r| match r {
            InputSnapshotRef::Runtime { snapshot_id } => Some(snapshot_id.as_str()),
            InputSnapshotRef::Evidence { .. } => None,
        })
        .collect();
    let evidence: Vec<&str> = record
        .input_snapshot_refs
        .iter()
        .filter_map(|r| match r {
            InputSnapshotRef::Evidence { path } => Some(path.as_str()),
            InputSnapshotRef::Runtime { .. } => None,
        })
        .collect();
    let (want_runtime, want_evidence) = match record.variant {
        Variant::Measurable => (1, 0),
        Variant::Discretionary => (0, 1),
        Variant::Hybrid => (1, 1),
    };
    if runtime.len() != want_runtime || evidence.len() != want_evidence {
        return Err(refuse(
            "refs_invalid",
            format!(
                "a {} record carries exactly {want_runtime} runtime and {want_evidence} evidence \
                 refs; found {} and {}",
                record.variant.as_str(),
                runtime.len(),
                evidence.len()
            ),
        ));
    }
    for snapshot_id in &runtime {
        if !is_hash(snapshot_id) {
            return Err(refuse(
                "refs_invalid",
                "a runtime ref names a sha256 snapshot id",
            ));
        }
    }
    if let Some(path) = evidence.first() {
        if record.evidence_pack_path.as_deref() != Some(*path) {
            return Err(refuse(
                "refs_invalid",
                "the evidence ref and evidence_pack_path name the same file",
            ));
        }
        let root = format!(
            "{}/{}/",
            registry.evidence_root, record.gate_key.registry_id
        );
        let name = path.strip_prefix(&root).ok_or_else(|| {
            refuse(
                "evidence_path_invalid",
                format!(
                    "an {} evidence pack lives under {root}",
                    record.gate_key.registry_id
                ),
            )
        })?;
        let dated = name.len() > 14
            && is_local_date(&name[..10])
            && name.as_bytes()[10] == b'-'
            && name.ends_with(".md");
        if !dated {
            return Err(refuse(
                "evidence_path_invalid",
                format!("{name:?} is not <date>-<slug>.md"),
            ));
        }
    }
    Ok(())
}

fn validate_metrics(record: &TriggerEvaluation, registry: &Registry) -> Result<(), Refusal> {
    let metrics = &registry.metrics;
    for metric in &record.metrics {
        match metric {
            TriggerMetric::Count { name, series, .. } => {
                if !metrics.count_names.contains(name) {
                    return Err(refuse(
                        "metrics_invalid",
                        format!("{name:?} is not a count metric"),
                    ));
                }
                validate_series(series)?;
            }
            TriggerMetric::RatioPpm {
                name,
                numerator,
                denominator,
                value_ppm,
                series,
            } => {
                if !metrics.ratio_names.contains(name) {
                    return Err(refuse(
                        "metrics_invalid",
                        format!("{name:?} is not a ratio metric"),
                    ));
                }
                if *denominator == 0 {
                    return Err(refuse(
                        "metrics_invalid",
                        "a ratio has a positive denominator",
                    ));
                }
                let recomputed = numerator
                    .checked_mul(1_000_000)
                    .map(|n| n / denominator)
                    .ok_or_else(|| refuse("metrics_invalid", "ratio numerator overflows"))?;
                if recomputed != *value_ppm || *value_ppm > 1_000_000 {
                    return Err(refuse(
                        "metrics_invalid",
                        format!(
                            "{name}: {numerator}/{denominator} recomputes to {recomputed} ppm, \
                             not {value_ppm}"
                        ),
                    ));
                }
                validate_series(series)?;
            }
            TriggerMetric::Quantity {
                name, unit, series, ..
            } => {
                let expected = match name {
                    QuantityName::Fixed(fixed) => metrics.quantity_units.get(fixed),
                    QuantityName::Component {
                        projected_component,
                    } => metrics.component_units.get(&projected_component.component),
                };
                let Some(expected) = expected else {
                    return Err(refuse(
                        "metrics_invalid",
                        format!("{name:?} is not a quantity metric"),
                    ));
                };
                if unit != expected {
                    return Err(refuse(
                        "metrics_invalid",
                        format!("{name:?} is measured in {expected}, not {unit}"),
                    ));
                }
                validate_series(series)?;
            }
        }
    }
    Ok(())
}

fn validate_series(series: &MetricSeriesKey) -> Result<(), Refusal> {
    match series {
        MetricSeriesKey::Aggregate | MetricSeriesKey::HighStakesDailyLoad => Ok(()),
        MetricSeriesKey::Sample { run_id } => {
            if run_id.is_empty() {
                return Err(refuse("metrics_invalid", "a sample series names its run"));
            }
            Ok(())
        }
        MetricSeriesKey::Source {
            store_uuid,
            source_id,
        } => {
            if store_uuid.is_empty() || source_id.is_empty() {
                return Err(refuse(
                    "metrics_invalid",
                    "a source series names both halves",
                ));
            }
            Ok(())
        }
        MetricSeriesKey::Day { local_date } => {
            if !is_local_date(local_date) {
                return Err(refuse("metrics_invalid", "a day series is YYYY-MM-DD"));
            }
            Ok(())
        }
        MetricSeriesKey::Bucket {
            ordinal,
            start_date,
            end_date,
        } => {
            if !(1..=4).contains(ordinal) {
                return Err(refuse("metrics_invalid", "bucket ordinals run 1..4"));
            }
            if !is_local_date(start_date) || !is_local_date(end_date) || end_date < start_date {
                return Err(refuse(
                    "metrics_invalid",
                    "a bucket's dates are ordered YYYY-MM-DD",
                ));
            }
            Ok(())
        }
        MetricSeriesKey::Statistic { .. } => Ok(()),
    }
}

/// Validate the parent half: the parent's gate is allowed, the parent FIRED,
/// and — for the R5 Discovery alias — the named fields are byte-equal.
pub fn validate_parent(
    record: &TriggerEvaluation,
    parent: &TriggerEvaluation,
    registry: &Registry,
) -> Result<(), Refusal> {
    let gate = registry
        .resolve(&record.gate_key.registry_id, &record.gate_key.subcapability)
        .ok_or_else(|| refuse("gate_unknown", record.gate_key.canonical()))?;
    let Some(rule) = gate.parent else {
        return Err(refuse(
            "parent_invalid",
            format!("{} takes no parent evaluation", record.gate_key.canonical()),
        ));
    };
    if record.parent_evaluation_id.as_deref() != Some(parent.evaluation_id.as_str()) {
        return Err(refuse(
            "parent_invalid",
            "the record does not name this parent",
        ));
    }
    if !parent_allowed(rule, &parent.gate_key, registry) {
        return Err(refuse(
            "parent_invalid",
            format!(
                "{} is not an allowed parent for {}",
                parent.gate_key.canonical(),
                record.gate_key.canonical()
            ),
        ));
    }
    if parent.result != TriggerResult::Fired {
        return Err(refuse(
            "parent_invalid",
            format!(
                "the parent evaluation is {}, and only a FIRED parent counts",
                parent.result.as_str()
            ),
        ));
    }
    // R3–R14 scopes must agree with the parent's; a subscription-global
    // parent (none exist today) would be its own scope.
    if record.scope != parent.scope {
        return Err(refuse(
            "parent_invalid",
            "a parent evaluation must share the record's scope",
        ));
    }
    if let ParentRule::MeasurableAlias { byte_equal, .. } = rule {
        for field in byte_equal {
            let (own, parents) = field_bytes(record, parent, field).ok_or_else(|| {
                refuse(
                    "parent_invalid",
                    format!("byte_equal names {field:?}, which this build cannot compare"),
                )
            })?;
            if own != parents {
                return Err(refuse(
                    "parent_invalid",
                    format!("an alias is byte-equal to its parent on {field:?}, and this is not"),
                ));
            }
        }
    }
    Ok(())
}

/// The canonical bytes of one byte_equal field, on both records. The field
/// NAMES come from the artifact; a name this match does not know is a
/// refusal, never a silently-passing comparison.
fn field_bytes(
    record: &TriggerEvaluation,
    parent: &TriggerEvaluation,
    field: &str,
) -> Option<(String, String)> {
    fn json<T: serde::Serialize>(value: &T) -> String {
        serde_json::to_string(value).unwrap_or_default()
    }
    match field {
        "window" => Some((json(&record.window), json(&parent.window))),
        "input_snapshot_refs" => Some((
            json(&record.input_snapshot_refs),
            json(&parent.input_snapshot_refs),
        )),
        "input_snapshot_hash" => Some((
            record.input_snapshot_hash.clone(),
            parent.input_snapshot_hash.clone(),
        )),
        "metrics" => Some((json(&record.metrics), json(&parent.metrics))),
        "result" => Some((
            record.result.as_str().to_string(),
            parent.result.as_str().to_string(),
        )),
        _ => None,
    }
}

fn parent_allowed(rule: &ParentRule, parent_key: &GateKey, registry: &Registry) -> bool {
    let canonical = parent_key.canonical();
    rule.allowed().iter().any(|allowed| {
        if let Some(prefix) = allowed.strip_suffix('*') {
            // The `R14:connector:*` wildcard: any REGISTERED connector gate.
            canonical.starts_with(prefix)
                && registry
                    .resolve(&parent_key.registry_id, &parent_key.subcapability)
                    .is_some()
        } else {
            canonical == *allowed
        }
    })
}

/// The distinct refusal codes this validator can produce — the vocabulary the
/// goldens pin. Closed here so a golden cannot name a code no path emits.
pub const REFUSAL_CODES: [&str; 10] = [
    "gate_unknown",
    "variant_mismatch",
    "variant_shape",
    "scope_mismatch",
    "refs_invalid",
    "metrics_invalid",
    "window_invalid",
    "parent_invalid",
    "evidence_path_invalid",
    "rule_version_mismatch",
];

/// `evaluation_id_mismatch` is the eleventh, listed separately because the
/// goldens that carry it must be authored with a deliberately wrong id.
/// `schema_invalid` is the twelfth, produced by the PARSER rather than any
/// branch here — a record that does not deserialize has no fields to refuse
/// by.
pub const ID_MISMATCH_CODE: &str = "evaluation_id_mismatch";

/// Every code the golden runner may see. Closed so a golden cannot name a
/// code no path emits.
pub fn all_codes() -> BTreeSet<&'static str> {
    let mut set: BTreeSet<&'static str> = REFUSAL_CODES.into_iter().collect();
    set.insert(ID_MISMATCH_CODE);
    set.insert("schema_invalid");
    set
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::trigger::registry;

    #[derive(Debug, serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Golden {
        name: String,
        description: String,
        record: serde_json::Value,
        #[serde(default)]
        parent: Option<serde_json::Value>,
        expected: Expected,
    }

    #[derive(Debug, PartialEq, serde::Deserialize)]
    #[serde(untagged)]
    enum Expected {
        Accepted(String),
        Refused { refused: String },
    }

    fn goldens() -> Vec<(String, Golden)> {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../shared/policy/goldens-trigger");
        let mut files: Vec<std::path::PathBuf> = std::fs::read_dir(dir)
            .expect("the goldens directory")
            .filter_map(|entry| entry.ok().map(|e| e.path()))
            .filter(|path| path.extension().is_some_and(|e| e == "json"))
            .collect();
        files.sort();
        files
            .into_iter()
            .map(|path| {
                let raw = std::fs::read_to_string(&path).expect("readable");
                let golden: Golden = serde_json::from_str(&raw)
                    .unwrap_or_else(|e| panic!("{}: {e}", path.display()));
                (
                    path.file_name().unwrap().to_string_lossy().to_string(),
                    golden,
                )
            })
            .collect()
    }

    /// The whole outcome a golden pins: parse, validate, and — when a parent
    /// rides along — validate it and the parent relation too.
    fn outcome(golden: &Golden, registry: &registry::Registry) -> Result<(), String> {
        let record: TriggerEvaluation = serde_json::from_value(golden.record.clone())
            .map_err(|_| "schema_invalid".to_string())?;
        validate(&record, registry).map_err(|r| r.code.to_string())?;
        if let Some(parent_value) = &golden.parent {
            let parent: TriggerEvaluation = serde_json::from_value(parent_value.clone())
                .map_err(|_| "schema_invalid".to_string())?;
            validate(&parent, registry).map_err(|r| r.code.to_string())?;
            validate_parent(&record, &parent, registry).map_err(|r| r.code.to_string())?;
        }
        Ok(())
    }

    #[test]
    fn the_goldens_replay() {
        let registry = registry::load().unwrap();
        for (name, golden) in goldens() {
            let got = outcome(&golden, &registry);
            match (&golden.expected, got) {
                (Expected::Accepted(word), Ok(())) => assert_eq!(word, "accepted", "{name}"),
                (Expected::Refused { refused }, Err(code)) => assert_eq!(
                    &code, refused,
                    "{name} ({}): {}",
                    golden.name, golden.description
                ),
                (expected, got) => panic!(
                    "{name} ({}): expected {expected:?}, got {got:?} — {}",
                    golden.name, golden.description
                ),
            }
        }
    }

    #[test]
    fn every_refusal_code_has_a_golden_and_no_golden_invents_one() {
        let mut covered: BTreeSet<String> = BTreeSet::new();
        for (name, golden) in goldens() {
            if let Expected::Refused { refused } = &golden.expected {
                assert!(
                    all_codes().contains(refused.as_str()),
                    "{name} names {refused:?}, which no validator path emits"
                );
                covered.insert(refused.clone());
            }
        }
        let all: BTreeSet<String> = all_codes().into_iter().map(String::from).collect();
        assert_eq!(
            covered, all,
            "a refusal code with no golden is a rule nobody has to keep"
        );
    }

    #[test]
    fn parsed_records_round_trip() {
        // Serialization is part of the contract: the alias's byte-equal
        // comparison and the stored record_json both ride on it.
        for (name, golden) in goldens() {
            let Ok(record) = serde_json::from_value::<TriggerEvaluation>(golden.record.clone())
            else {
                continue;
            };
            let reparsed: TriggerEvaluation =
                serde_json::from_str(&serde_json::to_string(&record).unwrap()).unwrap();
            assert_eq!(record, reparsed, "{name}");
        }
    }

    #[test]
    fn the_snapshot_hash_is_order_independent_and_content_sensitive() {
        let a = (
            "runtime".to_string(),
            "s1".to_string(),
            "{\"x\":1}".to_string(),
        );
        let b = (
            "evidence".to_string(),
            "p1".to_string(),
            "payload".to_string(),
        );
        let forward =
            derive_input_snapshot_hash("cerebro-trigger-snapshot-v1", &[a.clone(), b.clone()]);
        let reversed =
            derive_input_snapshot_hash("cerebro-trigger-snapshot-v1", &[b.clone(), a.clone()]);
        assert_eq!(
            forward, reversed,
            "collection order must not mint a second hash"
        );
        let mut tampered = a.clone();
        tampered.2 = "{\"x\":2}".to_string();
        assert_ne!(
            forward,
            derive_input_snapshot_hash("cerebro-trigger-snapshot-v1", &[tampered, b]),
            "a changed payload is a different snapshot"
        );
    }

    #[test]
    fn nothing_here_reads_a_clock() {
        // An evaluation is dated by its record; a validator that read the
        // wall clock would answer differently about bytes that had not moved.
        let source = include_str!("evaluation.rs");
        let body = source
            .split("#[cfg(test)]")
            .next()
            .expect("the non-test half");
        for forbidden in ["Utc::now", "SystemTime", "Local::now"] {
            assert!(
                !body.contains(forbidden),
                "{forbidden:?} appears in the validator"
            );
        }
    }
}
