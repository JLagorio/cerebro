//! `shared/policy/trigger-registry.v1.json` — the closed gate table, Rust side.
//!
//! The registry answers exactly four questions about a gate key: does it
//! exist, which evaluation variant must its record use, which scope must that
//! record carry, and which parent (if any) may it name. Every answer is data;
//! this module is the generic machinery that reads it, and
//! `src/lib/trigger/registry.ts` is the second interpreter over the same
//! bytes. A rule spelled in either language instead of the artifact is the
//! review-blocking defect `shared/policy/README.md` names.
//!
//! **A key the artifact does not declare resolves to nothing.** R14's
//! connector keys are the deliberate demonstration: the pattern is declared,
//! the registered list is EMPTY, and so every `connector:<id>` key refuses
//! today. Registering a connector is an artifact edit under review, never a
//! code path learning to be generous.
//!
//! **The component-unit table must agree with the code that writes the
//! rows.** `metrics.component_units` restates `runtime::governance::Component`
//! so both languages can validate a projected-component metric without
//! reimplementing M26; `load()` refuses an artifact that disagrees with the
//! enum, the same posture `attention::lanes` takes — two statements are
//! tolerable only while something proves they cannot drift.

use std::collections::{BTreeMap, BTreeSet};

use crate::ledger::sha256_hex;
use crate::runtime::governance::Component;

const REGISTRY_JSON: &str = include_str!("../../../shared/policy/trigger-registry.v1.json");
const REGISTRY_DIGEST: &str = include_str!("../../../shared/policy/trigger-registry.v1.sha256");

/// The registry ids, closed at fourteen. Growing this list is a format bump.
pub const REGISTRY_IDS: [&str; 14] = [
    "R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8", "R9", "R10", "R11", "R12", "R13", "R14",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Variant {
    Measurable,
    Discretionary,
    Hybrid,
}

impl Variant {
    pub fn as_str(self) -> &'static str {
        match self {
            Variant::Measurable => "measurable",
            Variant::Discretionary => "discretionary",
            Variant::Hybrid => "hybrid",
        }
    }
}

/// Which scope an evaluation of this entry must carry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ScopeKind {
    SubscriptionGlobal,
    VaultStore,
}

impl ScopeKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ScopeKind::SubscriptionGlobal => "subscription_global",
            ScopeKind::VaultStore => "vault_store",
        }
    }
}

/// What a subcapability's `parent_evaluation_id` must resolve to.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ParentRule {
    /// R5 Discovery: a measurable record that is byte-equal to a FIRED parent
    /// on the named fields. The alias asserts nothing of its own.
    MeasurableAlias {
        allowed: Vec<String>,
        requires_result: String,
        byte_equal: Vec<String>,
    },
    /// R12 tails: a discretionary record whose parent gate has FIRED. The
    /// parent alone never satisfies the tail — the tail still needs its own
    /// evidence pack.
    FiredParent { allowed: Vec<String> },
}

impl ParentRule {
    pub fn allowed(&self) -> &[String] {
        match self {
            ParentRule::MeasurableAlias { allowed, .. } => allowed,
            ParentRule::FiredParent { allowed } => allowed,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Subcapability {
    pub key: String,
    pub variant: Variant,
    pub parent: Option<ParentRule>,
}

/// R14's shape: keys are `<prefix><registered-connector-id>`, and the
/// registered list is allowed to be EMPTY — the one empty list in this
/// artifact, because "no connector qualifies yet" is the shipped truth and a
/// fake registration to satisfy a validator would be worse.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SubcapabilityPattern {
    pub prefix: String,
    pub variant: Variant,
    pub parent: Option<ParentRule>,
    pub registered_connectors: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Entry {
    pub id: String,
    pub capability: String,
    pub scope: ScopeKind,
    pub subcapabilities: Vec<Subcapability>,
    #[serde(default)]
    pub subcapability_pattern: Option<SubcapabilityPattern>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Metrics {
    pub count_names: Vec<String>,
    pub ratio_names: Vec<String>,
    pub quantity_units: BTreeMap<String, String>,
    pub component_units: BTreeMap<String, String>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Artifact {
    format: u64,
    artifact_version: u64,
    rule_version: String,
    evaluation_id_domain: String,
    snapshot_hash_domain: String,
    evidence_root: String,
    protected_names: Vec<String>,
    entries: Vec<Entry>,
    metrics: Metrics,
    protocols: BTreeMap<String, BTreeMap<String, serde_json::Value>>,
}

/// The loaded registry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Registry {
    pub artifact_version: u64,
    pub rule_version: String,
    pub evaluation_id_domain: String,
    pub snapshot_hash_domain: String,
    pub evidence_root: String,
    pub protected_names: Vec<String>,
    pub metrics: Metrics,
    entries: Vec<Entry>,
    protocols: BTreeMap<String, BTreeMap<String, serde_json::Value>>,
}

/// One resolved gate key: what an evaluation of it must look like.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedGate<'a> {
    pub registry_id: &'a str,
    pub subkey: String,
    pub scope: ScopeKind,
    pub variant: Variant,
    pub parent: Option<&'a ParentRule>,
}

impl Registry {
    pub fn entries(&self) -> &[Entry] {
        &self.entries
    }

    pub fn entry(&self, id: &str) -> Option<&Entry> {
        self.entries.iter().find(|e| e.id == id)
    }

    /// Resolve `registry_id` + `subkey` against the closed table. `None` IS
    /// the refusal: a combination the artifact does not name has no variant,
    /// no scope, and no rules to evaluate under.
    pub fn resolve(&self, registry_id: &str, subkey: &str) -> Option<ResolvedGate<'_>> {
        let entry = self.entry(registry_id)?;
        if let Some(sub) = entry.subcapabilities.iter().find(|s| s.key == subkey) {
            return Some(ResolvedGate {
                registry_id: &entry.id,
                subkey: sub.key.clone(),
                scope: entry.scope,
                variant: sub.variant,
                parent: sub.parent.as_ref(),
            });
        }
        let pattern = entry.subcapability_pattern.as_ref()?;
        let connector = subkey.strip_prefix(&pattern.prefix)?;
        if !pattern
            .registered_connectors
            .iter()
            .any(|c| c.as_str() == connector)
        {
            return None;
        }
        Some(ResolvedGate {
            registry_id: &entry.id,
            subkey: subkey.to_string(),
            scope: entry.scope,
            variant: pattern.variant,
            parent: pattern.parent.as_ref(),
        })
    }

    /// Resolve a `"R4:issue"`-style gate-key string.
    pub fn resolve_key(&self, gate_key: &str) -> Option<ResolvedGate<'_>> {
        let (id, subkey) = gate_key.split_once(':')?;
        self.resolve(id, subkey)
    }

    /// The measurement protocol's constants for a gate key, when it has one.
    /// Aliased measurables (R5 Discovery) deliberately have none — their whole
    /// content is byte-equality with the parent's.
    pub fn protocol(&self, gate_key: &str) -> Option<&BTreeMap<String, serde_json::Value>> {
        self.protocols.get(gate_key)
    }
}

/// Load the shipped registry, bytes checked against the committed digest.
pub fn load() -> Result<Registry, String> {
    let expected = REGISTRY_DIGEST.trim();
    let actual = sha256_hex(REGISTRY_JSON.as_bytes());
    if actual != expected {
        return Err(format!(
            "shared/policy/trigger-registry.v1.json hashes to {actual}, and the committed digest \
             says {expected} — regenerate the digest deliberately, or find out who changed what \
             this registry governs"
        ));
    }
    parse_str(REGISTRY_JSON)
}

/// Parse and validate registry bytes. Split from `load()` so tests can refuse
/// mutated artifacts without forging a digest.
pub fn parse_str(json: &str) -> Result<Registry, String> {
    let artifact: Artifact =
        serde_json::from_str(json).map_err(|e| format!("trigger-registry.v1.json: {e}"))?;
    if artifact.format != 1 {
        return Err(format!(
            "trigger-registry format {} is not one this build speaks",
            artifact.format
        ));
    }
    for (field, value) in [
        ("rule_version", &artifact.rule_version),
        ("evaluation_id_domain", &artifact.evaluation_id_domain),
        ("snapshot_hash_domain", &artifact.snapshot_hash_domain),
        ("evidence_root", &artifact.evidence_root),
    ] {
        if value.is_empty() {
            return Err(format!("{field} must be non-empty"));
        }
    }
    if artifact.protected_names.is_empty() {
        return Err(
            "protected_names is empty — a glossary that protects nothing is a comment".into(),
        );
    }
    let mut names: BTreeSet<&str> = BTreeSet::new();
    for name in &artifact.protected_names {
        if name.is_empty() || !names.insert(name.as_str()) {
            return Err(format!(
                "protected name {name:?} is empty or declared twice"
            ));
        }
    }

    let ids: Vec<&str> = artifact.entries.iter().map(|e| e.id.as_str()).collect();
    if ids != REGISTRY_IDS {
        return Err(format!(
            "the registry must declare exactly {REGISTRY_IDS:?} in order; found {ids:?} — the \
             fourteen entries are closed by the design, and growing them is a format bump"
        ));
    }
    let mut capabilities: BTreeSet<&str> = BTreeSet::new();
    for entry in &artifact.entries {
        if entry.capability.is_empty() || !capabilities.insert(entry.capability.as_str()) {
            return Err(format!(
                "entry {} capability {:?} is empty or declared twice",
                entry.id, entry.capability
            ));
        }
        if entry.subcapabilities.is_empty() && entry.subcapability_pattern.is_none() {
            return Err(format!(
                "entry {} declares no subcapabilities and no pattern — an entry nothing can key \
                 is not deferred, it is absent",
                entry.id
            ));
        }
        let mut keys: BTreeSet<&str> = BTreeSet::new();
        for sub in &entry.subcapabilities {
            if sub.key.is_empty() || !keys.insert(sub.key.as_str()) {
                return Err(format!(
                    "entry {} subcapability {:?} is empty or declared twice",
                    entry.id, sub.key
                ));
            }
            check_variant_parent_shape(&entry.id, &sub.key, sub.variant, sub.parent.as_ref())?;
        }
        if let Some(pattern) = &entry.subcapability_pattern {
            if pattern.prefix.is_empty() {
                return Err(format!("entry {} pattern prefix is empty", entry.id));
            }
            for sub in &entry.subcapabilities {
                if sub.key.starts_with(&pattern.prefix) {
                    return Err(format!(
                        "entry {} subcapability {:?} collides with the pattern prefix {:?} — one \
                         key must not resolve two ways",
                        entry.id, sub.key, pattern.prefix
                    ));
                }
            }
            let mut connectors: BTreeSet<&str> = BTreeSet::new();
            for connector in &pattern.registered_connectors {
                if connector.is_empty() || !connectors.insert(connector.as_str()) {
                    return Err(format!(
                        "entry {} registered connector {connector:?} is empty or declared twice",
                        entry.id
                    ));
                }
            }
            check_variant_parent_shape(
                &entry.id,
                &format!("{}*", pattern.prefix),
                pattern.variant,
                pattern.parent.as_ref(),
            )?;
        }
    }

    // Parent references resolve against the table itself. `R14:connector:*`
    // is the one wildcard: it names "whichever connector gate is registered",
    // and resolves iff R14 declares the pattern — with zero connectors
    // registered it is a parent nothing can currently satisfy, which is the
    // fail-closed reading the tail wants.
    for entry in &artifact.entries {
        let parents = entry
            .subcapabilities
            .iter()
            .filter_map(|s| s.parent.as_ref().map(|p| (s.key.clone(), p)))
            .chain(
                entry
                    .subcapability_pattern
                    .as_ref()
                    .and_then(|p| p.parent.as_ref().map(|r| ("<pattern>".to_string(), r))),
            );
        for (key, parent) in parents {
            let allowed = parent.allowed();
            if allowed.is_empty() {
                return Err(format!(
                    "entry {} subcapability {key:?} declares a parent rule allowing nothing",
                    entry.id
                ));
            }
            for gate_key in allowed {
                if !parent_key_resolves(&artifact.entries, gate_key) {
                    return Err(format!(
                        "entry {} subcapability {key:?} allows parent {gate_key:?}, which the \
                         registry does not declare",
                        entry.id
                    ));
                }
            }
            if let ParentRule::MeasurableAlias {
                allowed,
                requires_result,
                byte_equal,
            } = parent
            {
                if requires_result != "fired" {
                    return Err(format!(
                        "entry {} subcapability {key:?}: a measurable alias of a parent that has \
                         not fired would let the alias assert what the parent never did",
                        entry.id
                    ));
                }
                if byte_equal.is_empty() {
                    return Err(format!(
                        "entry {} subcapability {key:?}: a byte-equal alias comparing no fields \
                         is not an alias",
                        entry.id
                    ));
                }
                for gate_key in allowed {
                    let target = artifact
                        .entries
                        .iter()
                        .find_map(|e| {
                            let (id, sub) = gate_key.split_once(':')?;
                            if e.id != id {
                                return None;
                            }
                            e.subcapabilities.iter().find(|s| s.key == sub)
                        })
                        .ok_or_else(|| {
                            format!("alias parent {gate_key:?} is not a plain subcapability")
                        })?;
                    if target.variant != Variant::Measurable || target.parent.is_some() {
                        return Err(format!(
                            "alias parent {gate_key:?} must be an unaliased measurable gate — an \
                             alias of an alias has no protocol anywhere in its ancestry"
                        ));
                    }
                }
            }
        }
    }

    check_metrics(&artifact.metrics)?;
    check_protocols(&artifact)?;

    Ok(Registry {
        artifact_version: artifact.artifact_version,
        rule_version: artifact.rule_version,
        evaluation_id_domain: artifact.evaluation_id_domain,
        snapshot_hash_domain: artifact.snapshot_hash_domain,
        evidence_root: artifact.evidence_root,
        protected_names: artifact.protected_names,
        metrics: artifact.metrics,
        entries: artifact.entries,
        protocols: artifact.protocols,
    })
}

/// Variant and parent must agree in shape: a measurable gate may only be
/// aliased to another measurable, a discretionary one may only wait on a
/// fired parent, and a hybrid stands alone. The MEANING is the artifact's;
/// this only refuses combinations that contradict themselves.
fn check_variant_parent_shape(
    entry_id: &str,
    key: &str,
    variant: Variant,
    parent: Option<&ParentRule>,
) -> Result<(), String> {
    match (variant, parent) {
        (_, None) => Ok(()),
        (Variant::Measurable, Some(ParentRule::MeasurableAlias { .. })) => Ok(()),
        (Variant::Discretionary, Some(ParentRule::FiredParent { .. })) => Ok(()),
        (variant, Some(rule)) => Err(format!(
            "entry {entry_id} subcapability {key:?}: variant {} cannot carry a {} parent rule",
            variant.as_str(),
            match rule {
                ParentRule::MeasurableAlias { .. } => "measurable_alias",
                ParentRule::FiredParent { .. } => "fired_parent",
            }
        )),
    }
}

fn parent_key_resolves(entries: &[Entry], gate_key: &str) -> bool {
    let Some((id, subkey)) = gate_key.split_once(':') else {
        return false;
    };
    let Some(entry) = entries.iter().find(|e| e.id == id) else {
        return false;
    };
    if entry.subcapabilities.iter().any(|s| s.key == subkey) {
        return true;
    }
    if let Some(pattern) = &entry.subcapability_pattern {
        // The wildcard form: `<prefix>*` names the pattern itself.
        if subkey == format!("{}*", pattern.prefix) {
            return true;
        }
    }
    false
}

fn check_metrics(metrics: &Metrics) -> Result<(), String> {
    for (name, list) in [
        ("count_names", &metrics.count_names),
        ("ratio_names", &metrics.ratio_names),
    ] {
        if list.is_empty() {
            return Err(format!("metrics.{name} is empty"));
        }
        let mut seen: BTreeSet<&str> = BTreeSet::new();
        for item in list {
            if item.is_empty() || !seen.insert(item.as_str()) {
                return Err(format!(
                    "metrics.{name} entry {item:?} is empty or declared twice"
                ));
            }
        }
    }
    const UNITS: [&str; 5] = ["tokens", "calls", "bytes", "micros", "seconds"];
    if metrics.quantity_units.is_empty() {
        return Err("metrics.quantity_units is empty".into());
    }
    for (name, unit) in metrics
        .quantity_units
        .iter()
        .chain(metrics.component_units.iter())
    {
        if name.is_empty() {
            return Err("a metric unit row names nothing".into());
        }
        if !UNITS.contains(&unit.as_str()) {
            return Err(format!(
                "metric {name:?} declares unit {unit:?}, which is not closed"
            ));
        }
    }
    // The component table restates `governance::Component` so TypeScript can
    // validate without reimplementing M26. Restatement is tolerable exactly
    // as long as this refusal exists.
    let expected: BTreeMap<String, String> = Component::ALL
        .iter()
        .map(|c| (c.as_str().to_string(), c.unit().to_string()))
        .collect();
    if metrics.component_units != expected {
        return Err(format!(
            "metrics.component_units disagrees with runtime::governance::Component — artifact \
             {:?}, code {:?}",
            metrics.component_units, expected
        ));
    }
    Ok(())
}

fn check_protocols(artifact: &Artifact) -> Result<(), String> {
    // Every unaliased measurable or hybrid gate owes a protocol; nothing else
    // may have one. A protocol for a discretionary gate would read as a
    // measurement nobody performs, and a measurable gate without one is a
    // threshold nobody wrote down.
    let mut owed: BTreeSet<String> = BTreeSet::new();
    for entry in &artifact.entries {
        for sub in &entry.subcapabilities {
            if matches!(sub.variant, Variant::Measurable | Variant::Hybrid) && sub.parent.is_none()
            {
                owed.insert(format!("{}:{}", entry.id, sub.key));
            }
        }
    }
    let declared: BTreeSet<String> = artifact.protocols.keys().cloned().collect();
    if owed != declared {
        return Err(format!(
            "protocols must cover exactly the unaliased measurable/hybrid gates — owed {owed:?}, \
             declared {declared:?}"
        ));
    }
    for (gate_key, constants) in &artifact.protocols {
        if constants.is_empty() {
            return Err(format!("protocol {gate_key:?} declares no constants"));
        }
        for (name, value) in constants {
            match value {
                serde_json::Value::Number(n) => {
                    let Some(v) = n.as_u64() else {
                        return Err(format!(
                            "protocol {gate_key:?} constant {name:?} must be a non-negative \
                             integer, found {n}"
                        ));
                    };
                    if v == 0 {
                        return Err(format!(
                            "protocol {gate_key:?} constant {name:?} is zero — a floor of \
                             nothing is not a floor"
                        ));
                    }
                    if name.ends_with("_ppm") && v > 1_000_000 {
                        return Err(format!(
                            "protocol {gate_key:?} constant {name:?} exceeds 1_000_000 ppm"
                        ));
                    }
                }
                serde_json::Value::String(s) => {
                    if s.is_empty() {
                        return Err(format!("protocol {gate_key:?} constant {name:?} is empty"));
                    }
                }
                other => {
                    return Err(format!(
                        "protocol {gate_key:?} constant {name:?} must be an integer or string, \
                         found {other}"
                    ));
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mutated(mutate: impl FnOnce(&mut serde_json::Value)) -> Result<Registry, String> {
        let mut value: serde_json::Value = serde_json::from_str(REGISTRY_JSON).unwrap();
        mutate(&mut value);
        parse_str(&serde_json::to_string(&value).unwrap())
    }

    #[test]
    fn the_shipped_artifact_loads_and_its_digest_is_over_the_bytes_that_ship() {
        let registry = load().expect("the shipped registry");
        assert_eq!(registry.rule_version, "trigger-registry-v1");
        assert_eq!(
            registry.evaluation_id_domain,
            "cerebro-trigger-evaluation-v1"
        );
        assert_eq!(registry.snapshot_hash_domain, "cerebro-trigger-snapshot-v1");
        assert_eq!(registry.evidence_root, "docs/superpowers/evidence/triggers");
        assert_eq!(
            sha256_hex(REGISTRY_JSON.as_bytes()),
            REGISTRY_DIGEST.trim(),
            "regenerate shared/policy/trigger-registry.v1.sha256"
        );
        assert_eq!(
            registry.protected_names,
            [
                "Skeptic",
                "Scout",
                "Curiosity",
                "Claim",
                "Discovery",
                "Forecast",
                "Narrative"
            ],
            "the protected-names glossary is the design's, verbatim"
        );
    }

    #[test]
    fn the_mode_map_is_exactly_the_designs() {
        let registry = load().unwrap();

        for id in ["R1", "R3", "R6", "R7", "R10", "R13"] {
            let gate = registry.resolve(id, "root").unwrap();
            assert_eq!(gate.variant, Variant::Measurable, "{id}");
            assert!(gate.parent.is_none(), "{id}");
        }
        let r2 = registry.resolve("R2", "root").unwrap();
        assert_eq!(r2.variant, Variant::Hybrid);
        assert!(r2.parent.is_none());
        for id in ["R8", "R9", "R11"] {
            let gate = registry.resolve(id, "root").unwrap();
            assert_eq!(gate.variant, Variant::Discretionary, "{id}");
            assert!(gate.parent.is_none(), "{id}");
        }

        // Scope: R1/R2 aggregate the whole subscription; everything else is
        // one vault store.
        for id in REGISTRY_IDS {
            let expected = if id == "R1" || id == "R2" {
                ScopeKind::SubscriptionGlobal
            } else {
                ScopeKind::VaultStore
            };
            assert_eq!(registry.entry(id).unwrap().scope, expected, "{id}");
        }

        // R4: four objects, each its own discretionary gate, no parent.
        let r4: Vec<&str> = registry
            .entry("R4")
            .unwrap()
            .subcapabilities
            .iter()
            .map(|s| s.key.as_str())
            .collect();
        assert_eq!(r4, ["issue", "risk", "action", "decision"]);
        for key in r4 {
            let gate = registry.resolve("R4", key).unwrap();
            assert_eq!(gate.variant, Variant::Discretionary);
            assert!(gate.parent.is_none());
        }

        // R5: three discretionary objects plus the Discovery alias.
        for key in ["assumption", "causal_hypothesis", "forecast"] {
            let gate = registry.resolve("R5", key).unwrap();
            assert_eq!(gate.variant, Variant::Discretionary, "{key}");
            assert!(gate.parent.is_none(), "{key}");
        }
        let discovery = registry.resolve("R5", "discovery").unwrap();
        assert_eq!(discovery.variant, Variant::Measurable);
        match discovery.parent.unwrap() {
            ParentRule::MeasurableAlias {
                allowed,
                requires_result,
                byte_equal,
            } => {
                assert_eq!(allowed, &["R13:root"]);
                assert_eq!(requires_result, "fired");
                assert_eq!(
                    byte_equal,
                    &[
                        "window",
                        "input_snapshot_refs",
                        "input_snapshot_hash",
                        "metrics",
                        "result"
                    ]
                );
            }
            other => panic!("R5:discovery parent is {other:?}"),
        }

        // R12: the sixteen named tails, each discretionary behind its exact
        // fired parents.
        let expected_tails: [(&str, &[&str]); 16] = [
            (
                "per_type_temporal_decay",
                &["R4:issue", "R4:risk", "R4:action", "R4:decision"],
            ),
            ("full_relation_vocabulary", &["R4:issue", "R4:decision"]),
            ("decision_urgency_blocker_lanes", &["R4:decision"]),
            ("decision_revisit_conditions", &["R4:decision"]),
            ("scope_collision_maintenance", &["R6:root"]),
            ("learned_aliases", &["R6:root"]),
            ("full_knowledge_fitness_review", &["R8:root"]),
            ("learned_preferences", &["R8:root"]),
            ("participant_workstream_metadata", &["R8:root"]),
            ("learned_authority_routes", &["R7:root"]),
            (
                "custom_predicate_freshness",
                &["R4:issue", "R4:risk", "R4:action", "R4:decision"],
            ),
            ("per_connector_scope_model", &["R14:connector:*"]),
            ("issue_theme_workstream_rungs", &["R4:issue"]),
            ("executive_narrative_rung", &["R9:root"]),
            ("advanced_graph_semantic_retrieval", &["R1:root"]),
            ("meeting_executive_prep", &["R8:root", "R9:root"]),
        ];
        let r12 = registry.entry("R12").unwrap();
        assert_eq!(r12.subcapabilities.len(), expected_tails.len());
        for (sub, (key, parents)) in r12.subcapabilities.iter().zip(expected_tails) {
            assert_eq!(sub.key, key);
            assert_eq!(sub.variant, Variant::Discretionary, "{key}");
            match sub.parent.as_ref().unwrap() {
                ParentRule::FiredParent { allowed } => assert_eq!(allowed, parents, "{key}"),
                other => panic!("{key} parent is {other:?}"),
            }
        }

        // R14: the pattern is declared and the registered list is EMPTY, so
        // no connector key resolves today. That is the shipped truth, not a
        // placeholder.
        let r14 = registry.entry("R14").unwrap();
        let pattern = r14.subcapability_pattern.as_ref().unwrap();
        assert_eq!(pattern.prefix, "connector:");
        assert_eq!(pattern.variant, Variant::Discretionary);
        assert!(pattern.registered_connectors.is_empty());
        assert!(registry.resolve("R14", "connector:github").is_none());
        assert!(registry.resolve("R14", "root").is_none());
    }

    #[test]
    fn every_combination_the_map_does_not_name_refuses() {
        // The whole universe of subkeys that appear anywhere in the artifact,
        // plus shapes an author might plausibly try, against every entry.
        // `resolve` must succeed for exactly the declared pairs — a lookup
        // that is generous anywhere is a gate somebody can satisfy under the
        // wrong rules.
        let registry = load().unwrap();
        let mut universe: BTreeSet<String> = ["root", "connector:github", "connector:", "issue "]
            .into_iter()
            .map(String::from)
            .collect();
        let mut declared: BTreeSet<(String, String)> = BTreeSet::new();
        for entry in registry.entries() {
            for sub in &entry.subcapabilities {
                universe.insert(sub.key.clone());
                declared.insert((entry.id.clone(), sub.key.clone()));
            }
        }
        assert_eq!(
            declared.len(),
            34,
            "10 roots + 4 R4 objects + 4 R5 objects + 16 R12 tails"
        );
        for entry in registry.entries() {
            for subkey in &universe {
                let resolved = registry.resolve(&entry.id, subkey).is_some();
                let expected = declared.contains(&(entry.id.clone(), subkey.clone()));
                assert_eq!(
                    resolved, expected,
                    "{}:{subkey} resolved={resolved}, declared={expected}",
                    entry.id
                );
            }
        }
    }

    #[test]
    fn the_component_units_cannot_drift_from_the_code_that_writes_the_rows() {
        let err = mutated(|v| {
            v["metrics"]["component_units"]["output_tokens"] = "calls".into();
        })
        .unwrap_err();
        assert!(
            err.contains("disagrees with runtime::governance::Component"),
            "{err}"
        );
    }

    #[test]
    fn a_missing_entry_refuses_by_naming_the_closed_list() {
        let err = mutated(|v| {
            v["entries"].as_array_mut().unwrap().remove(13);
        })
        .unwrap_err();
        assert!(err.contains("exactly"), "{err}");
    }

    #[test]
    fn a_protocol_for_a_discretionary_gate_refuses() {
        let err = mutated(|v| {
            v["protocols"]["R8:root"] = serde_json::json!({ "window_days": 30 });
        })
        .unwrap_err();
        assert!(
            err.contains("exactly the unaliased measurable/hybrid gates"),
            "{err}"
        );
    }

    #[test]
    fn a_measurable_gate_without_a_protocol_refuses() {
        let err = mutated(|v| {
            v["protocols"].as_object_mut().unwrap().remove("R13:root");
        })
        .unwrap_err();
        assert!(
            err.contains("exactly the unaliased measurable/hybrid gates"),
            "{err}"
        );
    }

    #[test]
    fn an_aliased_measurable_owns_no_protocol() {
        // R5:discovery is measurable and has NO protocol row — its content is
        // byte-equality with R13's. Giving it one must refuse.
        let err = mutated(|v| {
            v["protocols"]["R5:discovery"] = serde_json::json!({ "window_days": 30 });
        })
        .unwrap_err();
        assert!(
            err.contains("exactly the unaliased measurable/hybrid gates"),
            "{err}"
        );
    }

    #[test]
    fn an_unresolvable_parent_refuses() {
        let err = mutated(|v| {
            v["entries"][11]["subcapabilities"][4]["parent"]["allowed"] =
                serde_json::json!(["R6:aliases"]);
        })
        .unwrap_err();
        assert!(err.contains("which the registry does not declare"), "{err}");
    }

    #[test]
    fn an_alias_of_a_non_measurable_parent_refuses() {
        let err = mutated(|v| {
            v["entries"][4]["subcapabilities"][3]["parent"]["allowed"] =
                serde_json::json!(["R8:root"]);
        })
        .unwrap_err();
        assert!(
            err.contains("must be an unaliased measurable gate"),
            "{err}"
        );
    }

    #[test]
    fn a_variant_and_parent_that_contradict_each_other_refuse() {
        // A hybrid gate waiting on a fired parent is a combination the design
        // never names; the shape check refuses it before meaning is asked.
        let err = mutated(|v| {
            v["entries"][1]["subcapabilities"][0]["parent"] =
                serde_json::json!({ "kind": "fired_parent", "allowed": ["R13:root"] });
        })
        .unwrap_err();
        assert!(err.contains("cannot carry"), "{err}");
    }

    #[test]
    fn a_ppm_constant_above_one_million_refuses() {
        let err = mutated(|v| {
            v["protocols"]["R2:root"]["min_unused_ppm"] = serde_json::json!(1_000_001);
        })
        .unwrap_err();
        assert!(err.contains("exceeds 1_000_000 ppm"), "{err}");
    }

    #[test]
    fn a_zero_floor_refuses() {
        let err = mutated(|v| {
            v["protocols"]["R7:root"]["required_sources"] = serde_json::json!(0);
        })
        .unwrap_err();
        assert!(err.contains("a floor of nothing is not a floor"), "{err}");
    }

    #[test]
    fn a_duplicate_registered_connector_refuses() {
        let err = mutated(|v| {
            v["entries"][13]["subcapability_pattern"]["registered_connectors"] =
                serde_json::json!(["github", "github"]);
        })
        .unwrap_err();
        assert!(err.contains("empty or declared twice"), "{err}");
    }

    #[test]
    fn a_registered_connector_resolves_and_carries_the_patterns_rules() {
        let registry = mutated(|v| {
            v["entries"][13]["subcapability_pattern"]["registered_connectors"] =
                serde_json::json!(["github"]);
        })
        .unwrap();
        let gate = registry.resolve("R14", "connector:github").unwrap();
        assert_eq!(gate.variant, Variant::Discretionary);
        assert_eq!(gate.scope, ScopeKind::VaultStore);
        assert!(gate.parent.is_none());
        assert!(registry.resolve("R14", "connector:gitlab").is_none());
    }

    #[test]
    fn nothing_here_reads_a_clock() {
        // The registry answers "what must an evaluation of this gate look
        // like", which cannot depend on when anybody asks.
        let source = include_str!("registry.rs");
        let body = source
            .split("#[cfg(test)]")
            .next()
            .expect("the non-test half");
        for forbidden in ["Utc::now", "SystemTime", "Local::now"] {
            assert!(
                !body.contains(forbidden),
                "{forbidden:?} appears in the registry"
            );
        }
    }

    /// Regenerate `shared/policy/trigger-registry.v1.sha256` after a
    /// DELIBERATE edit.
    #[test]
    #[ignore = "regeneration is a deliberate act — run with --ignored after editing the artifact"]
    fn write_trigger_registry_digest() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../shared/policy/trigger-registry.v1.sha256");
        std::fs::write(&path, format!("{}\n", sha256_hex(REGISTRY_JSON.as_bytes()))).unwrap();
    }
}
