//! The table-decidable verdict (M24.1) — the slice of policy that needs
//! only the artifact and the proposal, no reducer state.
//!
//! This is deliberately NOT the whole interpreter. M24.4 wraps it with the
//! state-dependent predicates (CAS, receipts, coverage, contradiction
//! edges); what lives here is exactly what the shared goldens can assert
//! identically in Rust and TS today, so the table's semantics are settled as
//! data before an engine exists to argue with them.
//!
//! Everything it decides comes off the artifact: which stages run and in
//! what order (`evaluation_order`), which capability gates an op or a
//! payload shape, which classes an op may target, how declared risk relates
//! to base risk, which transitions silence permits, and what each rejection
//! code's destiny is. No op, risk, code, or threshold is named in this file.

use std::collections::BTreeMap;

use super::risk::{effective_risk, EffectiveRisk, RiskRefusal, Signals};
use super::table::{ApplyMode, Destiny, PolicyTable, Risk, Stage};

/// The facts a table-only verdict needs. M24.3's `ProposalV1` projects into
/// this; a golden fixture parses straight into it.
#[derive(Debug, Clone, PartialEq)]
pub struct ProposalFacts {
    pub op: String,
    pub transition: String,
    pub declared_risk: Risk,
    pub target_classes: Vec<String>,
    pub transition_cause: String,
    /// Flattened payload discriminators a `conditional_capabilities` entry
    /// can match on (`action`, `relation`, …). Absent keys never match.
    pub payload_conditions: BTreeMap<String, String>,
    /// Server-derived escalator signals, already folded across targets: a
    /// proposal escalates when ANY of its targets trips an escalator, so
    /// flags are OR-ed and counts are maxed before they arrive here.
    pub signals: Signals,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Rejection {
    pub code: String,
    pub destiny: Destiny,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Verdict {
    /// The ladder auto-applies this rung.
    Applied { risk: EffectiveRisk },
    /// The ladder wants a human card; `review` carries the rung's mode.
    Queued {
        risk: EffectiveRisk,
        review: Option<String>,
    },
    Rejected {
        rejection: Rejection,
        /// Present when risk was resolved before the refusal — a review
        /// card still wants to say how dangerous the attempt was.
        risk: Option<EffectiveRisk>,
    },
}

/// A structural problem with the request that policy cannot express as a
/// verdict: an op the table does not know, or a transition the op does not
/// allow. Both are tripwire/schema failures upstream of policy, kept typed
/// so no caller can mistake them for a decision.
#[derive(Debug, Clone, PartialEq)]
pub enum FactsError {
    UnknownOp(String),
    TransitionNotAllowed { op: String, transition: String },
    UnknownThreshold(String),
}

fn reject(table: &PolicyTable, code: &str) -> Result<Rejection, FactsError> {
    let destiny = table
        .destiny(code)
        .expect("table load proved every code has a destiny");
    Ok(Rejection {
        code: code.to_string(),
        destiny,
    })
}

/// The capability blocking this proposal, if any: the op's own gate first,
/// then any `conditional_capabilities` entry whose full condition matches
/// the payload.
fn blocking_capability<'a>(table: &'a PolicyTable, facts: &ProposalFacts) -> Option<&'a str> {
    if let Some(capability) = table.blocking_capability(&facts.op) {
        return Some(capability);
    }
    table
        .conditional_capabilities
        .iter()
        .filter(|c| c.op == facts.op)
        .filter(|c| {
            c.when
                .iter()
                .all(|(key, want)| facts.payload_conditions.get(key) == Some(want))
        })
        .find_map(|c| match table.capabilities.get(&c.capability) {
            Some(capability) if !capability.available => Some(c.capability.as_str()),
            _ => None,
        })
}

/// Decide everything the artifact alone can decide.
pub fn table_verdict(table: &PolicyTable, facts: &ProposalFacts) -> Result<Verdict, FactsError> {
    let rule = table
        .op(&facts.op)
        .ok_or_else(|| FactsError::UnknownOp(facts.op.clone()))?;
    if !rule.allowed_transitions.contains(&facts.transition) {
        return Err(FactsError::TransitionNotAllowed {
            op: facts.op.clone(),
            transition: facts.transition.clone(),
        });
    }

    let mut risk: Option<EffectiveRisk> = None;
    for stage in &table.evaluation_order {
        match stage {
            Stage::Capability => {
                if blocking_capability(table, facts).is_some() {
                    return Ok(Verdict::Rejected {
                        rejection: reject(table, "capability_unavailable")?,
                        risk: risk.clone(),
                    });
                }
            }
            Stage::TargetClass => {
                if facts
                    .target_classes
                    .iter()
                    .any(|class| !rule.target_classes.contains(class))
                {
                    return Ok(Verdict::Rejected {
                        rejection: reject(table, "target_set_mismatch")?,
                        risk: risk.clone(),
                    });
                }
            }
            Stage::RiskDeclaration => {
                match effective_risk(table, &facts.op, facts.declared_risk, &facts.signals) {
                    Ok(resolved) => risk = Some(resolved),
                    Err(RiskRefusal::RiskLowered { .. }) => {
                        return Ok(Verdict::Rejected {
                            rejection: reject(table, "risk_lowered")?,
                            risk: None,
                        })
                    }
                    Err(RiskRefusal::UnknownOp(op)) => return Err(FactsError::UnknownOp(op)),
                    Err(RiskRefusal::UnknownThreshold(key)) => {
                        return Err(FactsError::UnknownThreshold(key))
                    }
                }
            }
            Stage::Silence => {
                // Silence may move freshness/coverage/attention and nothing
                // else. The allowlist is the artifact's, so a transition
                // invented later is forbidden here until someone says
                // otherwise in data.
                if table.silence.causes.contains(&facts.transition_cause)
                    && !table
                        .silence
                        .allowed_transitions
                        .contains(&facts.transition)
                {
                    return Ok(Verdict::Rejected {
                        rejection: reject(table, &table.silence.rejection)?,
                        risk: risk.clone(),
                    });
                }
            }
        }
    }

    let resolved = risk.expect("evaluation_order always runs the risk stage");
    let rung = table
        .risk_ladder
        .get(&resolved.risk)
        .expect("table load proved every rung exists");
    Ok(match rung.apply {
        ApplyMode::Auto => Verdict::Applied { risk: resolved },
        ApplyMode::QueuedHumanCard => Verdict::Queued {
            review: rung.review.clone(),
            risk: resolved,
        },
    })
}

impl Verdict {
    /// `applied | queued | rejected` — the wire word the goldens assert and
    /// the proposal boundary returns.
    pub fn kind(&self) -> &'static str {
        match self {
            Verdict::Applied { .. } => "applied",
            Verdict::Queued { .. } => "queued",
            Verdict::Rejected { .. } => "rejected",
        }
    }

    pub fn effective_risk(&self) -> Option<Risk> {
        match self {
            Verdict::Applied { risk } | Verdict::Queued { risk, .. } => Some(risk.risk),
            Verdict::Rejected { risk, .. } => risk.as_ref().map(|r| r.risk),
        }
    }

    pub fn escalated_by(&self) -> Vec<String> {
        match self {
            Verdict::Applied { risk } | Verdict::Queued { risk, .. } => risk.fired.clone(),
            Verdict::Rejected { risk, .. } => {
                risk.as_ref().map(|r| r.fired.clone()).unwrap_or_default()
            }
        }
    }

    pub fn rejection(&self) -> Option<&Rejection> {
        match self {
            Verdict::Rejected { rejection, .. } => Some(rejection),
            _ => None,
        }
    }
}
