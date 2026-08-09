//! The six `proposal.*` bodies (M24.3) — the durable proposal lifecycle.
//!
//! M22 RESERVED these six names with deliberately undefined bodies. These
//! are those bodies.
//!
//! **Pending review is reducer state, not runtime cache.** A queued HIGH
//! proposal survives a restart, a runtime-DB deletion, and an app-data wipe,
//! because the queue is derived by folding the ledger. The operational DB
//! may cache it; it is never asked. That is what makes "the app forgot what
//! it was waiting for you to approve" impossible rather than unlikely.
//!
//! Both human decisions are durable. A rejection is not the absence of an
//! approval — it is a recorded act with a reason, and the Skeptic reads it.

use serde::{Deserialize, Serialize};

use super::proposal::{ProposalV1, RevertPlan, TargetClass};
use super::risk::Risk;
use super::value::TypedValue;
use super::{is_id128, schema_body};

/// One target's version, as recorded on a queue or an application.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TargetVersion {
    pub target_class: TargetClass,
    pub target_id: String,
    pub version: u64,
}

/// Non-empty, duplicate-free ids in THEIR OWN ORDER.
///
/// Deliberately not `sorted_unique`. Two different orders here are two
/// different things: a batch's members have a plan order that the marker's
/// `member_event_ids` also preserves, and a commit set's members have the
/// frozen order its id was derived from — sorting either would destroy the
/// only durable record of it. Physical event ids are minted fresh at
/// preallocation, so requiring THOSE sorted would demand an ordering the
/// writer cannot produce at all.
fn unique_ids(label: &str, ids: &[String]) -> Result<(), String> {
    if ids.is_empty() {
        return Err(format!("{label} is empty"));
    }
    let mut seen = std::collections::BTreeSet::new();
    for id in ids {
        if !is_id128(id) {
            return Err(format!(
                "{label} entry {id:?} is not a 128-bit hex event id"
            ));
        }
        if !seen.insert(id.as_str()) {
            return Err(format!("{label} repeats {id}"));
        }
    }
    Ok(())
}

fn sorted_unique_versions(label: &str, versions: &[TargetVersion]) -> Result<(), String> {
    let mut seen = std::collections::BTreeSet::new();
    for entry in versions {
        if !is_id128(&entry.target_id) {
            return Err(format!("{label} target_id is not an id"));
        }
        if !seen.insert((entry.target_class, entry.target_id.as_str())) {
            return Err(format!(
                "{label} names {}/{} twice",
                entry.target_class.as_str(),
                entry.target_id
            ));
        }
    }
    let given: Vec<(TargetClass, &str)> = versions
        .iter()
        .map(|v| (v.target_class, v.target_id.as_str()))
        .collect();
    if seen.into_iter().collect::<Vec<_>>() != given {
        return Err(format!("{label} is not in canonical (class, id) order"));
    }
    Ok(())
}

schema_body! {
    /// The validated proposal, stored whole. Everything downstream —
    /// the review card, the pre-append revalidation, the revert — reads
    /// this record rather than a summary of it.
    pub struct ProposalSubmitted {
        pub proposal: Box<ProposalV1>,
    }
}

impl ProposalSubmitted {
    pub fn validate(&self) -> Result<(), String> {
        self.validate_common()?;
        self.proposal.validate()
    }
}

schema_body! {
    /// Durable pending-review state for an ALL-OR-NOTHING set.
    ///
    /// Every member of a mixed-risk commit set is queued, including the
    /// LOW and MEDIUM peers that would have auto-applied alone. Holding
    /// them is the point: applying the cheap half of an atomic set while
    /// the expensive half waits for a human is exactly the partial state
    /// the protocol exists to make impossible.
    pub struct ProposalQueued {
        pub proposal_id: String,
        pub commit_set_id: String,
        pub member_proposal_ids: Vec<String>,
        pub effective_risk: Risk,
        pub policy_version: u64,
        pub target_versions: Vec<TargetVersion>,
        pub queued_at: String,
    }
}

impl ProposalQueued {
    pub fn validate(&self) -> Result<(), String> {
        self.validate_common()?;
        if !is_id128(&self.proposal_id) {
            return Err("proposal_id is not an id".into());
        }
        if !is_id128(&self.commit_set_id) {
            return Err("commit_set_id is not an id".into());
        }
        // Order-preserving: this IS the frozen order the commit-set id was
        // derived from, and the only durable copy of it.
        unique_ids("member_proposal_ids", &self.member_proposal_ids)?;
        if !self.member_proposal_ids.contains(&self.proposal_id) {
            return Err("a queued proposal must be a member of its own commit set".into());
        }
        if self.policy_version == 0 {
            return Err("policy_version must be positive".into());
        }
        sorted_unique_versions("target_versions", &self.target_versions)?;
        if chrono::DateTime::parse_from_rfc3339(&self.queued_at).is_err() {
            return Err("queued_at is not RFC3339".into());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Decision {
    Approve,
    Reject,
}

schema_body! {
    /// A human's answer, either way, durably.
    ///
    /// Approval is AUTHORIZATION, not a CAS bypass: the versions recorded
    /// here are what the reviewer actually looked at, and application
    /// re-checks them against the head at append time.
    pub struct ProposalDecisionRecorded {
        pub decision_id: String,
        pub proposal_id: String,
        pub decision: Decision,
        pub reviewer: String,
        pub decided_at: String,
        pub reason: Option<String>,
        pub reviewed_target_versions: Vec<TargetVersion>,
    }
}

impl ProposalDecisionRecorded {
    pub fn validate(&self) -> Result<(), String> {
        self.validate_common()?;
        if !is_id128(&self.decision_id) {
            return Err("decision_id is not an id".into());
        }
        if !is_id128(&self.proposal_id) {
            return Err("proposal_id is not an id".into());
        }
        if self.reviewer.trim().is_empty() {
            return Err("a decision with no reviewer is not a decision".into());
        }
        if chrono::DateTime::parse_from_rfc3339(&self.decided_at).is_err() {
            return Err("decided_at is not RFC3339".into());
        }
        sorted_unique_versions("reviewed_target_versions", &self.reviewed_target_versions)?;
        match (self.decision, &self.reason) {
            // Saying no is a claim about the proposal; it owes a sentence.
            (Decision::Reject, Some(reason)) if !reason.trim().is_empty() => Ok(()),
            (Decision::Reject, _) => Err("a rejection requires a reason".into()),
            // Saying yes is agreement with what is already written; a
            // second free-text field would just be somewhere else to look.
            (Decision::Approve, None) => Ok(()),
            (Decision::Approve, Some(_)) => {
                Err("an approval carries no reason — the proposal is the statement".into())
            }
        }
    }
}

schema_body! {
    /// Success. `revert_plan` is non-null EXACTLY when the op's policy rule
    /// says `one_click`, which is what the UI keys the Revert action off —
    /// never a guess from the op name.
    pub struct ProposalApplied {
        pub proposal_id: String,
        pub commit_set_id: String,
        pub effective_risk: Risk,
        /// Null only for an auto-apply; a queued proposal names the
        /// decision that authorized it.
        pub decision_id: Option<String>,
        pub mutation_event_ids: Vec<String>,
        pub resulting_versions: Vec<TargetVersion>,
        pub revert_plan: Option<RevertPlan>,
    }
}

impl ProposalApplied {
    pub fn validate(&self) -> Result<(), String> {
        self.validate_common()?;
        if !is_id128(&self.proposal_id) {
            return Err("proposal_id is not an id".into());
        }
        if !is_id128(&self.commit_set_id) {
            return Err("commit_set_id is not an id".into());
        }
        if let Some(decision) = &self.decision_id {
            if !is_id128(decision) {
                return Err("decision_id is not an id".into());
            }
        }
        // An application that changed nothing is not an application.
        unique_ids("mutation_event_ids", &self.mutation_event_ids)?;
        sorted_unique_versions("resulting_versions", &self.resulting_versions)?;
        if let Some(plan) = &self.revert_plan {
            plan.validate()?;
        }
        Ok(())
    }
}

schema_body! {
    /// A refusal worth keeping. Only MEANINGFUL policy rejections and human
    /// rejections reach the ledger — schema and transport failures carry an
    /// operational destiny and never construct this body.
    pub struct ProposalRejected {
        pub proposal_id: String,
        pub commit_set_id: String,
        pub code: String,
        pub rule: String,
        pub expected: TypedValue,
        pub actual: TypedValue,
        /// Required only for the member a human actually rejected.
        pub decision_id: Option<String>,
        /// Set on the atomic PEERS, naming the member that failed, so a
        /// card can point at the cause instead of saying "something else
        /// went wrong".
        pub refused_by_proposal_id: Option<String>,
    }
}

impl ProposalRejected {
    pub fn validate(&self) -> Result<(), String> {
        self.validate_common()?;
        if !is_id128(&self.proposal_id) {
            return Err("proposal_id is not an id".into());
        }
        if !is_id128(&self.commit_set_id) {
            return Err("commit_set_id is not an id".into());
        }
        // The registry lives in the policy table, which the reducer
        // deliberately does not load — a reducer that needed policy to
        // replay would make conformance vectors policy-dependent. Shape is
        // checked here; membership is guaranteed at the producing end by
        // `policy::rejection::RejectionCode`.
        for (label, value) in [("code", &self.code), ("rule", &self.rule)] {
            if value.is_empty()
                || !value
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b == b'_' || b.is_ascii_digit())
            {
                return Err(format!("{label} {value:?} is not a lower_snake_case code"));
            }
        }
        self.expected.validate()?;
        self.actual.validate()?;
        if let Some(decision) = &self.decision_id {
            if !is_id128(decision) {
                return Err("decision_id is not an id".into());
            }
        }
        if let Some(peer) = &self.refused_by_proposal_id {
            if !is_id128(peer) {
                return Err("refused_by_proposal_id is not an id".into());
            }
            if peer == &self.proposal_id {
                return Err("a proposal cannot be refused by itself".into());
            }
        }
        Ok(())
    }
}

schema_body! {
    /// The forward inverse, linked to what it undid. NEITHER record is
    /// erased: the original application and this reversion both stand, and
    /// the ledger is never rewound.
    pub struct ProposalReverted {
        pub proposal_id: String,
        pub reverted_by_proposal_id: String,
        pub prior_applied_event_ids: Vec<String>,
        pub forward_event_ids: Vec<String>,
        pub resulting_versions: Vec<TargetVersion>,
    }
}

impl ProposalReverted {
    pub fn validate(&self) -> Result<(), String> {
        self.validate_common()?;
        if !is_id128(&self.proposal_id) {
            return Err("proposal_id is not an id".into());
        }
        if !is_id128(&self.reverted_by_proposal_id) {
            return Err("reverted_by_proposal_id is not an id".into());
        }
        if self.proposal_id == self.reverted_by_proposal_id {
            return Err("a proposal cannot revert itself".into());
        }
        unique_ids("prior_applied_event_ids", &self.prior_applied_event_ids)?;
        unique_ids("forward_event_ids", &self.forward_event_ids)?;
        sorted_unique_versions("resulting_versions", &self.resulting_versions)?;
        Ok(())
    }
}

/// The proposal's durable lifecycle state, derived by the reducer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProposalState {
    Submitted,
    Queued,
    Rejected,
    Applied,
    Reverted,
}

impl ProposalState {
    /// Terminal states cannot be left. A second terminal event for one
    /// proposal is a refusal, not a state change — otherwise an applied
    /// proposal could be "rejected" later and the record would lie.
    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            ProposalState::Rejected | ProposalState::Applied | ProposalState::Reverted
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ledger::schema::Actor;

    const A: &str = "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";
    const B: &str = "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2";
    const SET: &str = "5e75e75e75e75e75e75e75e75e75e75e";

    fn decision(decision: Decision, reason: Option<&str>) -> ProposalDecisionRecorded {
        ProposalDecisionRecorded {
            schema: 1,
            batch_id: None,
            idempotency_key: None,
            actor: Actor { id: "human".into() },
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            decision_id: A.into(),
            proposal_id: B.into(),
            decision,
            reviewer: "human:josef".into(),
            decided_at: "2026-08-09T10:00:00Z".into(),
            reason: reason.map(str::to_string),
            reviewed_target_versions: vec![],
        }
    }

    #[test]
    fn a_rejection_owes_a_reason_and_an_approval_does_not_take_one() {
        assert!(decision(Decision::Reject, Some("wrong scope"))
            .validate()
            .is_ok());
        assert!(decision(Decision::Reject, None)
            .validate()
            .unwrap_err()
            .contains("requires a reason"));
        assert!(decision(Decision::Reject, Some("   "))
            .validate()
            .unwrap_err()
            .contains("requires a reason"));
        assert!(decision(Decision::Approve, None).validate().is_ok());
        // A second free-text field on approval is just somewhere else to
        // look for the reasoning that is already in the proposal.
        assert!(decision(Decision::Approve, Some("looks fine"))
            .validate()
            .unwrap_err()
            .contains("carries no reason"));
    }

    #[test]
    fn a_queued_proposal_belongs_to_its_own_set() {
        let queued = |members: Vec<&str>| ProposalQueued {
            schema: 1,
            batch_id: None,
            idempotency_key: None,
            actor: Actor {
                id: "system:ledger".into(),
            },
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            proposal_id: A.into(),
            commit_set_id: SET.into(),
            member_proposal_ids: members.into_iter().map(str::to_string).collect(),
            effective_risk: Risk::High,
            policy_version: 1,
            target_versions: vec![],
            queued_at: "2026-08-09T10:00:00Z".into(),
        };
        assert!(queued(vec![A, B]).validate().is_ok());
        assert!(queued(vec![B])
            .validate()
            .unwrap_err()
            .contains("member of its own commit set"));
    }

    #[test]
    fn an_atomic_peer_cannot_name_itself_as_the_cause() {
        let rejected = |peer: Option<&str>| ProposalRejected {
            schema: 1,
            batch_id: None,
            idempotency_key: None,
            actor: Actor {
                id: "system:ledger".into(),
            },
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            proposal_id: A.into(),
            commit_set_id: SET.into(),
            code: "atomic_set_refused".into(),
            rule: "commit_set".into(),
            expected: TypedValue::string("applied"),
            actual: TypedValue::string("refused"),
            decision_id: None,
            refused_by_proposal_id: peer.map(str::to_string),
        };
        assert!(rejected(Some(B)).validate().is_ok());
        assert!(rejected(Some(A))
            .validate()
            .unwrap_err()
            .contains("refused by itself"));
        assert!(rejected(None).validate().is_ok());
    }

    #[test]
    fn a_rejection_code_must_look_like_a_code() {
        let mut body = ProposalRejected {
            schema: 1,
            batch_id: None,
            idempotency_key: None,
            actor: Actor {
                id: "system:ledger".into(),
            },
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            proposal_id: A.into(),
            commit_set_id: SET.into(),
            code: "Stale Target Version".into(),
            rule: "target_version".into(),
            expected: TypedValue::Missing,
            actual: TypedValue::Missing,
            decision_id: None,
            refused_by_proposal_id: None,
        };
        assert!(body.validate().unwrap_err().contains("lower_snake_case"));
        body.code = "stale_target_version".into();
        assert!(body.validate().is_ok());
    }

    #[test]
    fn a_proposal_cannot_revert_itself() {
        let reverted = ProposalReverted {
            schema: 1,
            batch_id: None,
            idempotency_key: None,
            actor: Actor {
                id: "system:ledger".into(),
            },
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            proposal_id: A.into(),
            reverted_by_proposal_id: A.into(),
            prior_applied_event_ids: vec![B.into()],
            forward_event_ids: vec![B.into()],
            resulting_versions: vec![],
        };
        assert!(reverted.validate().unwrap_err().contains("revert itself"));
    }

    #[test]
    fn terminal_states_are_the_ones_that_cannot_be_left() {
        assert!(!ProposalState::Submitted.is_terminal());
        assert!(!ProposalState::Queued.is_terminal());
        for state in [
            ProposalState::Rejected,
            ProposalState::Applied,
            ProposalState::Reverted,
        ] {
            assert!(state.is_terminal());
        }
    }
}
