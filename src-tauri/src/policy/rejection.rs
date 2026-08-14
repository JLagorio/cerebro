//! Typed rejections (M24.2) — the end of ad-hoc refusal strings on the
//! epistemic plane.
//!
//! Two shapes, because there are two records (D5):
//!
//! - [`Rejection`] `{ code, rule, expected, actual }` is what a PROPOSAL is
//!   refused with. It is the body of `proposal.rejected` when the code's
//!   declared destiny is `ledger`, and the typed result the proposal
//!   boundary returns either way.
//! - [`OperationalRefusal`] is what a TOOL SURFACE is refused with, before
//!   any proposal exists. Schema and transport failures never construct
//!   `proposal.rejected`; they return their own shape and land in the
//!   runtime DB's `operational_log`.
//!
//! Neither type declares a vocabulary. `RejectionCode` and `RuleCode` are
//! validated newtypes over `shared/policy/policy.v1.json` — a Rust enum
//! mirroring the registry would be exactly the twin-data defect the
//! milestone forbids, and the destiny of a code would then have two homes.
//!
//! The wire prose an agent sees is DELIBERATELY unchanged by this phase.
//! `write_concept`'s public arguments and response text are a prompt surface
//! (M17/M23); typing the refusal is about where it is recorded and how the
//! app can reason about it, not about rewording the message.

use serde::{Deserialize, Serialize};

use super::table::{Destiny, PolicyTable};
use crate::ledger::schema::TypedValue;

/// A rejection code that the loaded table registers. Construction is the
/// check: there is no way to hold one the artifact does not know.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct RejectionCode(String);

impl RejectionCode {
    pub fn new(table: &PolicyTable, code: &str) -> Result<RejectionCode, String> {
        if table.destiny(code).is_none() {
            return Err(format!(
                "rejection code {code:?} is not registered in the policy table"
            ));
        }
        Ok(RejectionCode(code.to_string()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Where a refusal with this code is recorded. Never inferred from the
    /// call site — the table is the only authority.
    pub fn destiny(&self, table: &PolicyTable) -> Destiny {
        table
            .destiny(&self.0)
            .expect("a RejectionCode cannot exist without a registered destiny")
    }
}

/// Which rule refused: a predicate, a transition, or one of the table's
/// registered non-predicate rule codes.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct RuleCode(String);

impl RuleCode {
    pub fn new(table: &PolicyTable, rule: &str) -> Result<RuleCode, String> {
        let known = table.predicates.iter().any(|p| p == rule)
            || table.transitions.iter().any(|t| t == rule)
            || table.rule_codes.iter().any(|r| r == rule);
        if !known {
            return Err(format!(
                "rule code {rule:?} is neither a predicate, a transition, nor a registered rule \
                 code"
            ));
        }
        Ok(RuleCode(rule.to_string()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// The refusal of a proposal. `expected`/`actual` are always M22
/// `TypedValue`s, never untyped JSON or a bare null: a version mismatch and
/// a missing record must not read the same way in a review card.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Rejection {
    pub code: RejectionCode,
    pub rule: RuleCode,
    pub expected: TypedValue,
    pub actual: TypedValue,
}

impl Rejection {
    /// Build a proposal rejection. Refuses to construct one from a
    /// transport or writer code: those failures happen before or beneath a
    /// proposal and have their own shape, and letting them in here is
    /// exactly how the append-only ledger turns into server logs.
    pub fn new(
        table: &PolicyTable,
        code: &str,
        rule: &str,
        expected: TypedValue,
        actual: TypedValue,
    ) -> Result<Rejection, String> {
        let code = RejectionCode::new(table, code)?;
        if table
            .transport_rejections
            .iter()
            .any(|c| c == code.as_str())
        {
            return Err(format!(
                "{} is a transport failure — it returns an operational refusal, never a proposal \
                 rejection",
                code.as_str()
            ));
        }
        expected.validate()?;
        actual.validate()?;
        Ok(Rejection {
            code,
            rule: RuleCode::new(table, rule)?,
            expected,
            actual,
        })
    }

    pub fn destiny(&self, table: &PolicyTable) -> Destiny {
        self.code.destiny(table)
    }

    /// The `human_rejected` shape the design fixes: expected `"approve"`,
    /// actual `"reject"`.
    pub fn human_rejected(table: &PolicyTable) -> Result<Rejection, String> {
        Rejection::new(
            table,
            "human_rejected",
            "human_decision",
            TypedValue::string("approve"),
            TypedValue::string("reject"),
        )
    }

    /// The `atomic_set_refused` shape: an object naming the member that
    /// actually failed and its code, so a peer's card can point at the
    /// cause instead of saying "something else went wrong".
    pub fn atomic_set_refused(
        table: &PolicyTable,
        refused_by_proposal_id: &str,
        cause: &RejectionCode,
    ) -> Result<Rejection, String> {
        let mut detail = indexmap::IndexMap::new();
        detail.insert(
            "refused_by_proposal_id".to_string(),
            TypedValue::string(refused_by_proposal_id),
        );
        detail.insert(
            "rejection_code".to_string(),
            TypedValue::string(cause.as_str()),
        );
        Rejection::new(
            table,
            "atomic_set_refused",
            "commit_set",
            TypedValue::string("applied"),
            TypedValue::Object { value: detail },
        )
    }
}

/// A typed refusal on a tool surface, before any proposal exists.
///
/// `detail` is the message the caller already sees; this type does not
/// reword it. What it adds is a code with a declared destiny and the
/// surface that produced it, so the refusal can be recorded and counted
/// instead of vanishing into a `Result<_, String>`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OperationalRefusal {
    pub code: RejectionCode,
    /// The entry point that refused — a tool name or internal boundary.
    pub surface: String,
    pub detail: String,
}

impl OperationalRefusal {
    /// Build an operational refusal. Refuses a code whose declared destiny
    /// is `ledger`: promoting a refusal into the epistemic record needs a
    /// coverage-materiality argument in review, not a call-site decision.
    pub fn new(
        table: &PolicyTable,
        code: &str,
        surface: &str,
        detail: impl Into<String>,
    ) -> Result<OperationalRefusal, String> {
        let code = RejectionCode::new(table, code)?;
        if code.destiny(table) == Destiny::Ledger {
            return Err(format!(
                "{} is ledger-destined — an operational refusal cannot carry it",
                code.as_str()
            ));
        }
        Ok(OperationalRefusal {
            code,
            surface: surface.to_string(),
            detail: detail.into(),
        })
    }

    /// The message the caller sees. Unchanged by typing — the tool surface
    /// is agent-facing prompt text, and this phase does not reword it.
    pub fn message(&self) -> &str {
        &self.detail
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn table() -> PolicyTable {
        PolicyTable::load().unwrap()
    }

    #[test]
    fn a_code_the_table_does_not_register_cannot_be_constructed() {
        let t = table();
        assert!(RejectionCode::new(&t, "vibes_were_off").is_err());
        assert!(RejectionCode::new(&t, "stale_target_version").is_ok());
    }

    #[test]
    fn destiny_comes_from_the_table_not_the_call_site() {
        let t = table();
        assert_eq!(
            RejectionCode::new(&t, "stale_target_version")
                .unwrap()
                .destiny(&t),
            Destiny::Ledger
        );
        assert_eq!(
            RejectionCode::new(&t, "malformed_arguments")
                .unwrap()
                .destiny(&t),
            Destiny::Operational
        );
    }

    #[test]
    fn a_rule_code_spans_predicates_transitions_and_the_registered_extras() {
        let t = table();
        assert!(RuleCode::new(&t, "versions_current").is_ok(), "a predicate");
        assert!(RuleCode::new(&t, "supersede").is_ok(), "a transition");
        assert!(
            RuleCode::new(&t, "risk_ladder").is_ok(),
            "a registered extra"
        );
        assert!(RuleCode::new(&t, "because_i_said_so").is_err());
    }

    #[test]
    fn a_transport_failure_cannot_become_a_proposal_rejection() {
        // The D5 leak this guards: `schema_invalid` in a `proposal.rejected`
        // body is how an append-only epistemic ledger becomes "Claude forgot
        // a required field 92,000 times".
        let t = table();
        let err = Rejection::new(
            &t,
            "schema_invalid",
            "risk_ladder",
            TypedValue::Missing,
            TypedValue::Missing,
        )
        .unwrap_err();
        assert!(err.contains("transport failure"), "{err}");
    }

    #[test]
    fn an_operational_refusal_cannot_carry_a_ledger_code() {
        // The mirror image: quietly routing epistemic history into the
        // runtime DB loses the Skeptic's food.
        let t = table();
        let err = OperationalRefusal::new(
            &t,
            "high_stakes_verification_required",
            "write_concept",
            "nope",
        )
        .unwrap_err();
        assert!(err.contains("ledger-destined"), "{err}");
    }

    #[test]
    fn the_human_rejected_shape_is_the_one_the_design_fixed() {
        let t = table();
        let rejection = Rejection::human_rejected(&t).unwrap();
        assert_eq!(rejection.expected, TypedValue::string("approve"));
        assert_eq!(rejection.actual, TypedValue::string("reject"));
        assert_eq!(rejection.rule.as_str(), "human_decision");
        assert_eq!(rejection.destiny(&t), Destiny::Ledger);
    }

    #[test]
    fn an_atomic_peer_names_the_member_that_actually_failed() {
        let t = table();
        let cause = RejectionCode::new(&t, "stale_target_version").unwrap();
        let rejection = Rejection::atomic_set_refused(&t, "p-17", &cause).unwrap();
        let detail = rejection.actual.as_object().expect("object actual");
        assert_eq!(
            detail.get("refused_by_proposal_id"),
            Some(&TypedValue::string("p-17"))
        );
        assert_eq!(
            detail.get("rejection_code"),
            Some(&TypedValue::string("stale_target_version"))
        );
    }

    #[test]
    fn a_rejection_round_trips_through_canonical_json() {
        // It becomes an event body; if it cannot serialize and come back
        // identical it cannot be a ledger record.
        let t = table();
        let rejection = Rejection::human_rejected(&t).unwrap();
        let raw = serde_json::to_string(&rejection).unwrap();
        assert_eq!(
            serde_json::from_str::<Rejection>(&raw).unwrap(),
            rejection,
            "{raw}"
        );
    }
}
