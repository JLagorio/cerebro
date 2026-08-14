//! `observation.independence_recorded` (M22.1, D12): the positive
//! independence primitive. No event means unknown, never independent.

use serde::{Deserialize, Serialize};

use super::{is_id128, schema_body};

/// The closed proof union. The firsthand and direct-artifact proofs carry a
/// rule version (M25's deterministic prefilter is their production
/// emitter); `human_confirmed` additionally pins M24's HIGH proposal and
/// approving decision — its validator ships with M24, so this build refuses
/// it rather than half-checking it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum IndependenceProof {
    DistinctFirsthandOrigin {
        left_source_registration_event_id: String,
        right_source_registration_event_id: String,
        rule_version: String,
    },
    IndependentSystemArtifact {
        left_source_registration_event_id: String,
        right_source_registration_event_id: String,
        rule_version: String,
    },
    HumanConfirmed {
        left_source_registration_event_id: String,
        right_source_registration_event_id: String,
        proposal_id: String,
        decision_event_id: String,
    },
}

impl IndependenceProof {
    pub fn registration_refs(&self) -> (&str, &str) {
        match self {
            IndependenceProof::DistinctFirsthandOrigin {
                left_source_registration_event_id,
                right_source_registration_event_id,
                ..
            }
            | IndependenceProof::IndependentSystemArtifact {
                left_source_registration_event_id,
                right_source_registration_event_id,
                ..
            }
            | IndependenceProof::HumanConfirmed {
                left_source_registration_event_id,
                right_source_registration_event_id,
                ..
            } => (
                left_source_registration_event_id,
                right_source_registration_event_id,
            ),
        }
    }
}

schema_body! {
    /// A positive independence fact between two Observations, stored as an
    /// unordered pair. Shared ancestry refuses it; absence of any fact
    /// stays `independence_unknown` — the reducer never materializes an
    /// inferred independence row.
    pub struct IndependenceRecorded {
        pub left_observation_event_id: String,
        pub right_observation_event_id: String,
        pub proof: IndependenceProof,
        pub reason: String,
    }
}

impl IndependenceRecorded {
    pub fn validate(&self) -> Result<(), String> {
        self.validate_common()?;
        if !is_id128(&self.left_observation_event_id) || !is_id128(&self.right_observation_event_id)
        {
            return Err("independence endpoints must be event ids".into());
        }
        if self.left_observation_event_id == self.right_observation_event_id {
            return Err("an Observation cannot be independent of itself".into());
        }
        if self.reason.is_empty() {
            return Err("independence reason must be non-empty".into());
        }
        let (left, right) = self.proof.registration_refs();
        if !is_id128(left) || !is_id128(right) {
            return Err("proof registration refs must be event ids".into());
        }
        match &self.proof {
            IndependenceProof::DistinctFirsthandOrigin { rule_version, .. }
            | IndependenceProof::IndependentSystemArtifact { rule_version, .. } => {
                if rule_version.is_empty() {
                    return Err("independence proof needs a non-empty rule_version".into());
                }
                Ok(())
            }
            IndependenceProof::HumanConfirmed {
                proposal_id,
                decision_event_id,
                ..
            } => {
                // M22 said "wait for M24"; M25.5 kept the refusal for a
                // better reason — accepting the body would let any caller
                // mint corroboration by naming two ids, because what makes
                // `human_confirmed` TRUE is that a specific proposal was
                // approved by a person, and that is reducer state rather than
                // body shape.
                //
                // M27.2c builds that reducer join, so the blanket refusal
                // lifts and this stage keeps only what a body can answer for
                // itself: two real refs. `apply_independence` does the rest —
                // the proposal must be committed, its decision must be an
                // APPROVAL, that approval must be the one named here, and the
                // proposal must have been put to a person at all.
                if !is_id128(proposal_id) || !is_id128(decision_event_id) {
                    return Err(
                        "human_confirmed independence pins a proposal and a decision by id".into(),
                    );
                }
                Ok(())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::{common, ID_A, ID_B, ID_C, ID_D};
    use super::*;

    fn event(proof: IndependenceProof) -> IndependenceRecorded {
        let (schema, actor) = common("system:prefilter");
        IndependenceRecorded {
            schema,
            batch_id: None,
            idempotency_key: None,
            actor,
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            left_observation_event_id: ID_A.into(),
            right_observation_event_id: ID_B.into(),
            proof,
            reason: "distinct registered human reporters".into(),
        }
    }

    fn firsthand() -> IndependenceProof {
        IndependenceProof::DistinctFirsthandOrigin {
            left_source_registration_event_id: ID_C.into(),
            right_source_registration_event_id: ID_D.into(),
            rule_version: "prefilter-v1".into(),
        }
    }

    #[test]
    fn the_two_produced_proofs_validate() {
        event(firsthand()).validate().unwrap();
        event(IndependenceProof::IndependentSystemArtifact {
            left_source_registration_event_id: ID_C.into(),
            right_source_registration_event_id: ID_D.into(),
            rule_version: "prefilter-v1".into(),
        })
        .validate()
        .unwrap();
    }

    #[test]
    fn self_pairs_empty_reasons_and_versions_are_refused() {
        let mut same = event(firsthand());
        same.right_observation_event_id = ID_A.into();
        assert!(same.validate().unwrap_err().contains("itself"));

        let mut no_reason = event(firsthand());
        no_reason.reason = String::new();
        assert!(no_reason.validate().is_err());

        let no_version = event(IndependenceProof::DistinctFirsthandOrigin {
            left_source_registration_event_id: ID_C.into(),
            right_source_registration_event_id: ID_D.into(),
            rule_version: String::new(),
        });
        assert!(no_version.validate().is_err());
    }

    #[test]
    fn a_human_confirmed_body_answers_only_for_its_own_shape() {
        // M27.2c: what a caller CANNOT do here is name two ids that are not
        // ids. Whether the proposal was really approved is reducer state, and
        // `apply_independence` is where a caller's claim about it dies.
        let well_formed = event(IndependenceProof::HumanConfirmed {
            left_source_registration_event_id: ID_C.into(),
            right_source_registration_event_id: ID_D.into(),
            proposal_id: ID_A.into(),
            decision_event_id: ID_B.into(),
        });
        well_formed.validate().unwrap();

        let forged = event(IndependenceProof::HumanConfirmed {
            left_source_registration_event_id: ID_C.into(),
            right_source_registration_event_id: ID_D.into(),
            proposal_id: "not-an-id".into(),
            decision_event_id: ID_B.into(),
        });
        assert!(forged
            .validate()
            .unwrap_err()
            .contains("pins a proposal and a decision by id"));
    }
}
