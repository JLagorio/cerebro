//! Effective-risk resolution — generic machinery over the table's data
//! (M24.1).
//!
//! Three inputs, in this order, and nothing else:
//!   1. the table's `base_risk` for the op,
//!   2. the proposal's `declared_risk`, which may only RAISE (D5), and
//!   3. the table's deterministic `escalators`, evaluated against signals
//!      the server derives from reducer state — never from the agent.
//!
//! No op name, threshold, or floor appears in this file. `target_has_
//! attestation` and `lineage_fan_in` are strings read out of the artifact;
//! adding a third escalator is a table edit plus a golden, not a patch here.

use std::collections::BTreeMap;

use super::table::{PolicyTable, Risk};

/// A derived, server-owned signal. Flags gate on truth; counts gate on a
/// named threshold — the two escalator shapes the artifact can express.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SignalValue {
    Flag(bool),
    Count(u64),
}

/// Signals for one evaluation. A signal an escalator names but nobody
/// supplied is treated as ABSENT, which never escalates — the caller must
/// supply what it knows, and the pre-append revalidation (M24.5) recomputes
/// them at the current head rather than trusting a stale snapshot.
pub type Signals = BTreeMap<String, SignalValue>;

/// Why an evaluation refused, in table vocabulary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RiskRefusal {
    /// The op is not in the table at all — the tripwire's failure mode.
    UnknownOp(String),
    /// A proposal tried to declare itself less dangerous than the table says.
    RiskLowered { base: Risk, declared: Risk },
    /// The artifact named a threshold it does not define. Load-time
    /// validation makes this unreachable; it is kept typed rather than
    /// unwrapped so a future partial table cannot panic in the interpreter.
    UnknownThreshold(String),
}

/// The resolved risk plus the escalator signals that raised it — the review
/// card needs to say *why* a LOW-declared change is sitting in a queue.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EffectiveRisk {
    pub risk: Risk,
    pub base: Risk,
    pub declared: Risk,
    pub fired: Vec<String>,
}

fn fires(
    table: &PolicyTable,
    escalator: &super::table::Escalator,
    signals: &Signals,
) -> Result<bool, RiskRefusal> {
    let Some(value) = signals.get(&escalator.signal) else {
        return Ok(false);
    };
    match (&escalator.above, value) {
        // A count escalator: strictly above the named threshold.
        (Some(key), SignalValue::Count(n)) => {
            let limit = table
                .threshold(key)
                .ok_or_else(|| RiskRefusal::UnknownThreshold(key.clone()))?;
            Ok(*n > limit)
        }
        // A flag escalator: present and true.
        (None, SignalValue::Flag(flag)) => Ok(*flag),
        // A signal supplied in the other shape says nothing about this
        // escalator; silently ignoring it beats guessing a coercion.
        _ => Ok(false),
    }
}

/// Resolve the effective risk for one proposal.
pub fn effective_risk(
    table: &PolicyTable,
    op: &str,
    declared: Risk,
    signals: &Signals,
) -> Result<EffectiveRisk, RiskRefusal> {
    let rule = table
        .op(op)
        .ok_or_else(|| RiskRefusal::UnknownOp(op.to_string()))?;
    let base = rule.base_risk;
    if declared < base {
        return Err(RiskRefusal::RiskLowered { base, declared });
    }
    let mut risk = base.max(declared);
    let mut fired = Vec::new();
    for escalator in &table.escalators {
        if fires(table, escalator, signals)? {
            risk = risk.max(escalator.floor);
            fired.push(escalator.signal.clone());
        }
    }
    Ok(EffectiveRisk {
        risk,
        base,
        declared,
        fired,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::policy::table::ApplyMode;

    fn table() -> PolicyTable {
        PolicyTable::load().unwrap()
    }

    fn flag(name: &str, on: bool) -> Signals {
        Signals::from([(name.to_string(), SignalValue::Flag(on))])
    }

    #[test]
    fn a_declared_risk_below_the_table_is_refused_not_clamped() {
        // Clamping would let an agent's understatement pass silently; the
        // whole point of "can only RAISE" is that the attempt is visible.
        let t = table();
        let err = effective_risk(&t, "merge_entities", Risk::Low, &Signals::new()).unwrap_err();
        assert_eq!(
            err,
            RiskRefusal::RiskLowered {
                base: Risk::Critical,
                declared: Risk::Low
            }
        );
    }

    #[test]
    fn a_declared_risk_above_the_table_is_honoured() {
        let t = table();
        let out = effective_risk(&t, "update_belief", Risk::Critical, &Signals::new()).unwrap();
        assert_eq!(out.risk, Risk::Critical);
        assert!(out.fired.is_empty());
    }

    #[test]
    fn an_attested_target_floors_a_low_declared_supersede_at_high() {
        // The acceptance-matrix row: supersede of an attested belief at LOW
        // declared risk escalates to HIGH and therefore queues.
        let t = table();
        let out = effective_risk(
            &t,
            "supersede_belief",
            Risk::Medium,
            &flag("target_has_attestation", true),
        )
        .unwrap();
        assert_eq!(out.risk, Risk::High);
        assert_eq!(out.fired, vec!["target_has_attestation".to_string()]);
        assert_eq!(t.risk_ladder[&out.risk].apply, ApplyMode::QueuedHumanCard);
    }

    #[test]
    fn an_unattested_target_leaves_the_base_alone() {
        let t = table();
        let out = effective_risk(
            &t,
            "supersede_belief",
            Risk::Medium,
            &flag("target_has_attestation", false),
        )
        .unwrap();
        assert_eq!(out.risk, Risk::Medium);
        assert!(out.fired.is_empty());
    }

    #[test]
    fn fan_in_escalates_strictly_above_the_named_threshold() {
        let t = table();
        let limit = t.threshold("lineage_fan_in_high").unwrap();
        let at_limit = Signals::from([("lineage_fan_in".to_string(), SignalValue::Count(limit))]);
        let over = Signals::from([("lineage_fan_in".to_string(), SignalValue::Count(limit + 1))]);
        assert_eq!(
            effective_risk(&t, "update_belief", Risk::Medium, &at_limit)
                .unwrap()
                .risk,
            Risk::Medium,
            "at the threshold is not above it"
        );
        assert_eq!(
            effective_risk(&t, "update_belief", Risk::Medium, &over)
                .unwrap()
                .risk,
            Risk::High
        );
    }

    #[test]
    fn a_missing_signal_never_escalates() {
        let t = table();
        let out = effective_risk(&t, "update_belief", Risk::Medium, &Signals::new()).unwrap();
        assert_eq!(out.risk, Risk::Medium);
    }

    #[test]
    fn escalators_cannot_lower_an_already_higher_risk() {
        // CRITICAL stays CRITICAL: `floor` is a floor, not an assignment.
        let t = table();
        let out = effective_risk(
            &t,
            "merge_entities",
            Risk::Critical,
            &flag("target_has_attestation", true),
        )
        .unwrap();
        assert_eq!(out.risk, Risk::Critical);
        assert_eq!(out.fired, vec!["target_has_attestation".to_string()]);
    }

    #[test]
    fn an_unmapped_op_is_a_typed_refusal_not_a_default_risk() {
        let t = table();
        assert_eq!(
            effective_risk(&t, "quietly_delete_everything", Risk::Low, &Signals::new())
                .unwrap_err(),
            RiskRefusal::UnknownOp("quietly_delete_everything".to_string())
        );
    }
}
