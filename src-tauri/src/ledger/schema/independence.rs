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
            IndependenceProof::HumanConfirmed { .. } => Err(
                "human_confirmed independence requires M24's HIGH proposal and decision \
                 validator — reserved, refused until it ships"
                    .into(),
            ),
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
    fn human_confirmed_is_reserved_until_m24() {
        let reserved = event(IndependenceProof::HumanConfirmed {
            left_source_registration_event_id: ID_C.into(),
            right_source_registration_event_id: ID_D.into(),
            proposal_id: ID_A.into(),
            decision_event_id: ID_B.into(),
        });
        assert!(reserved.validate().unwrap_err().contains("M24"));
    }
}
