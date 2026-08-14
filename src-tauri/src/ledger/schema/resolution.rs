//! `observation.subject_resolved` (M22.1, M26 vocabulary): attach an
//! unresolved Observation to an Entity, or explicitly correct its effective
//! attachment. Resolution is ADDITIVE history — the immutable Observation
//! and earlier resolutions are never rewritten.

use serde::{Deserialize, Serialize};

use super::{is_id128, schema_body};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResolverTier {
    ExactId,
    KnownAlias,
    ExplicitRelation,
    NormalizedMatch,
}

/// The exact attach/correct union. `basis_event_ids` is an ordered,
/// duplicate-free proof over already committed state (same-batch basis is
/// not permitted); each tier's cardinality is closed here, its content
/// checked at reduce time.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum ResolutionChange {
    Attach {
        entity_id: String,
        resolver_tier: ResolverTier,
        basis_event_ids: Vec<String>,
    },
    Correct {
        prior_resolution_event_id: String,
        from_entity_id: String,
        to_entity_id: String,
        resolver_tier: ResolverTier,
        basis_event_ids: Vec<String>,
        reason: String,
    },
}

schema_body! {
    pub struct SubjectResolved {
        pub observation_event_id: String,
        pub change: ResolutionChange,
    }
}

fn validate_basis_ids(basis: &[String]) -> Result<(), String> {
    let mut seen = std::collections::BTreeSet::new();
    for id in basis {
        if !is_id128(id) {
            return Err(format!("basis event id {id:?} is not a 128-bit hex id"));
        }
        if !seen.insert(id.as_str()) {
            return Err(format!("duplicate basis event id {id}"));
        }
    }
    Ok(())
}

/// The tier cardinality contract. `initial_exact_id` differs from a
/// correction's: an initial exact-id attach proves itself by the raw_ref
/// equalling the entity id (empty basis); a correction's exact_id names
/// exactly one Entity-registering event for the supplied target.
fn check_cardinality(tier: ResolverTier, basis_len: usize, correcting: bool) -> Result<(), String> {
    let ok = match tier {
        ResolverTier::ExactId => {
            if correcting {
                basis_len == 1
            } else {
                basis_len == 0
            }
        }
        ResolverTier::KnownAlias | ResolverTier::NormalizedMatch => basis_len == 1,
        ResolverTier::ExplicitRelation => basis_len >= 1,
    };
    if ok {
        Ok(())
    } else {
        Err(format!(
            "resolver tier {tier:?} with {basis_len} basis events is not a canonical proof"
        ))
    }
}

impl SubjectResolved {
    pub fn validate(&self) -> Result<(), String> {
        self.validate_common()?;
        if !is_id128(&self.observation_event_id) {
            return Err("observation_event_id is not a 128-bit hex event id".into());
        }
        match &self.change {
            ResolutionChange::Attach {
                entity_id,
                resolver_tier,
                basis_event_ids,
            } => {
                if !is_id128(entity_id) {
                    return Err("attach entity_id is not a stable id".into());
                }
                validate_basis_ids(basis_event_ids)?;
                check_cardinality(*resolver_tier, basis_event_ids.len(), false)
            }
            ResolutionChange::Correct {
                prior_resolution_event_id,
                from_entity_id,
                to_entity_id,
                resolver_tier,
                basis_event_ids,
                reason,
            } => {
                if !is_id128(prior_resolution_event_id) {
                    return Err("correction must pin its current prior resolution event".into());
                }
                if !is_id128(from_entity_id) || !is_id128(to_entity_id) {
                    return Err("correction from/to entity ids must be stable ids".into());
                }
                if from_entity_id == to_entity_id {
                    return Err(
                        "a correction to the same Entity is a no-op, refused with no state effect"
                            .into(),
                    );
                }
                if reason.is_empty() {
                    return Err("correction reason must be non-empty".into());
                }
                validate_basis_ids(basis_event_ids)?;
                if basis_event_ids.is_empty() {
                    return Err("correction basis must be non-empty for every tier".into());
                }
                check_cardinality(*resolver_tier, basis_event_ids.len(), true)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::{common, ID_A, ID_B, ID_C, ID_D};
    use super::*;

    fn resolved(change: ResolutionChange) -> SubjectResolved {
        let (schema, actor) = common("agent:resolver");
        SubjectResolved {
            schema,
            batch_id: None,
            idempotency_key: None,
            actor,
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            observation_event_id: ID_A.into(),
            change,
        }
    }

    #[test]
    fn attach_tier_cardinalities_are_closed() {
        let attach = |tier, basis: Vec<&str>| {
            resolved(ResolutionChange::Attach {
                entity_id: ID_B.into(),
                resolver_tier: tier,
                basis_event_ids: basis.into_iter().map(String::from).collect(),
            })
        };
        attach(ResolverTier::ExactId, vec![]).validate().unwrap();
        assert!(attach(ResolverTier::ExactId, vec![ID_C])
            .validate()
            .is_err());
        attach(ResolverTier::KnownAlias, vec![ID_C])
            .validate()
            .unwrap();
        assert!(attach(ResolverTier::KnownAlias, vec![]).validate().is_err());
        assert!(attach(ResolverTier::KnownAlias, vec![ID_C, ID_D])
            .validate()
            .is_err());
        attach(ResolverTier::NormalizedMatch, vec![ID_C])
            .validate()
            .unwrap();
        attach(ResolverTier::ExplicitRelation, vec![ID_C, ID_D])
            .validate()
            .unwrap();
        assert!(attach(ResolverTier::ExplicitRelation, vec![])
            .validate()
            .is_err());
    }

    #[test]
    fn corrections_pin_prior_target_and_reason() {
        let correct = resolved(ResolutionChange::Correct {
            prior_resolution_event_id: ID_B.into(),
            from_entity_id: ID_C.into(),
            to_entity_id: ID_D.into(),
            resolver_tier: ResolverTier::ExactId,
            basis_event_ids: vec![ID_A.into()],
            reason: "mention names the vendor, not the client".into(),
        });
        correct.validate().unwrap();

        // Same-entity correction is a refused no-op.
        let same = resolved(ResolutionChange::Correct {
            prior_resolution_event_id: ID_B.into(),
            from_entity_id: ID_C.into(),
            to_entity_id: ID_C.into(),
            resolver_tier: ResolverTier::ExactId,
            basis_event_ids: vec![ID_A.into()],
            reason: "why".into(),
        });
        assert!(same.validate().unwrap_err().contains("same Entity"));

        // Empty reason or empty basis: refused.
        let no_reason = resolved(ResolutionChange::Correct {
            prior_resolution_event_id: ID_B.into(),
            from_entity_id: ID_C.into(),
            to_entity_id: ID_D.into(),
            resolver_tier: ResolverTier::ExactId,
            basis_event_ids: vec![ID_A.into()],
            reason: String::new(),
        });
        assert!(no_reason.validate().is_err());
        let no_basis = resolved(ResolutionChange::Correct {
            prior_resolution_event_id: ID_B.into(),
            from_entity_id: ID_C.into(),
            to_entity_id: ID_D.into(),
            resolver_tier: ResolverTier::ExactId,
            basis_event_ids: vec![],
            reason: "why".into(),
        });
        assert!(no_basis.validate().is_err());
    }

    #[test]
    fn duplicate_basis_ids_are_refused() {
        let dup = resolved(ResolutionChange::Attach {
            entity_id: ID_B.into(),
            resolver_tier: ResolverTier::ExplicitRelation,
            basis_event_ids: vec![ID_C.into(), ID_C.into()],
        });
        assert!(dup.validate().unwrap_err().contains("duplicate"));
    }
}
