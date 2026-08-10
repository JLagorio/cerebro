//! The basic entity resolver (M26.1) — deterministic, Rust, no embeddings.
//!
//! **This lands first because everything after it is fiction without it.**
//! An Observation whose subject never attaches to an Entity cannot join a
//! belief, cannot carry lineage, and cannot participate in contradiction
//! detection. "The base contradicts itself" is a claim about two things
//! being about the SAME thing, and nothing knows that until something
//! resolves it.
//!
//! **Five tiers, ending in `unresolved`.** Exact entity id → known alias →
//! explicit relation traversal → normalized string-equality class →
//! unresolved. The last is a FIRST-CLASS OUTCOME, not a failure: it parks
//! the observation so the ingest pass can propose an alias (a MEDIUM op — an
//! alias claim is a claim) or a qualified create. The resolver never invents
//! an alias and never attaches on similarity.
//!
//! **A disagreement is never silently corrected.** Where a prior resolution
//! attached this Observation to a DIFFERENT entity, the attempt parks and
//! prepares M24's HIGH, non-reversible `correct_observation_subject` with
//! the prior resolution pinned. Overwriting would rewrite what somebody
//! already decided, using a rule that has no idea they decided it.
//!
//! **This is not the M28 claim-granularity Resolver**, and must never be
//! named as if it were. It can only NOTICE that an extracted candidate names
//! several independently attachable targets, and park.

use std::collections::BTreeSet;

use crate::ledger::reduce::EpistemicState;
use crate::ledger::schema::{normalize_alias_v1, ResolverTier};

/// Why an attempt never entered the resolution question at all.
///
/// Ineligible rows are EXCLUDED from M28's denominators: a candidate with no
/// subject was never a resolution the resolver could have got right, and
/// counting it would make the rate a measure of extraction quality instead.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ineligible {
    SubjectNone,
    MalformedSubject,
    NonAssertionObservation,
    MissingAssertionEvent,
    AlreadyAttached,
}

impl Ineligible {
    pub fn as_str(self) -> &'static str {
        match self {
            Ineligible::SubjectNone => "subject_none",
            Ineligible::MalformedSubject => "malformed_subject",
            Ineligible::NonAssertionObservation => "non_assertion_observation",
            Ineligible::MissingAssertionEvent => "missing_assertion_event",
            Ineligible::AlreadyAttached => "already_attached",
        }
    }
}

/// Which tier attached, or why nothing did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    ExactId,
    KnownAlias,
    ExplicitRelation,
    NormalizedMatch,
    Unresolved,
    ClaimGranularityBlocked,
    ConflictingAttachment,
}

impl Outcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Outcome::ExactId => "exact_id",
            Outcome::KnownAlias => "known_alias",
            Outcome::ExplicitRelation => "explicit_relation",
            Outcome::NormalizedMatch => "normalized_match",
            Outcome::Unresolved => "unresolved",
            Outcome::ClaimGranularityBlocked => "claim_granularity_blocked",
            Outcome::ConflictingAttachment => "conflicting_attachment",
        }
    }

    /// The M22 tier an attach emits. `None` for every parked outcome —
    /// nothing attached, so there is no tier to name.
    pub fn tier(self) -> Option<ResolverTier> {
        Some(match self {
            Outcome::ExactId => ResolverTier::ExactId,
            Outcome::KnownAlias => ResolverTier::KnownAlias,
            Outcome::ExplicitRelation => ResolverTier::ExplicitRelation,
            Outcome::NormalizedMatch => ResolverTier::NormalizedMatch,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReasonCode {
    AmbiguousCandidates,
    NoCandidate,
    CompoundAssertionTargets,
    ConflictingAttachment,
}

impl ReasonCode {
    pub fn as_str(self) -> &'static str {
        match self {
            ReasonCode::AmbiguousCandidates => "ambiguous_candidates",
            ReasonCode::NoCandidate => "no_candidate",
            ReasonCode::CompoundAssertionTargets => "compound_assertion_targets",
            ReasonCode::ConflictingAttachment => "conflicting_attachment",
        }
    }
}

/// What happened to an eligible attempt. A closed tagged union, so
/// chosen-entity and reason-code nullability cannot disagree with the
/// outcome — the shape IS the invariant.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Resolution {
    Attached {
        outcome: Outcome,
        chosen_entity_id: String,
    },
    ParkedUnresolved {
        reason: ReasonCode,
    },
    ParkedGranularity,
    ParkedConflict {
        chosen_entity_id: String,
        prior_entity_id: String,
        prior_resolution_event_id: String,
    },
}

impl Resolution {
    pub fn outcome(&self) -> Outcome {
        match self {
            Resolution::Attached { outcome, .. } => *outcome,
            Resolution::ParkedUnresolved { .. } => Outcome::Unresolved,
            Resolution::ParkedGranularity => Outcome::ClaimGranularityBlocked,
            Resolution::ParkedConflict { .. } => Outcome::ConflictingAttachment,
        }
    }

    pub fn chosen_entity_id(&self) -> Option<&str> {
        match self {
            Resolution::Attached {
                chosen_entity_id, ..
            }
            | Resolution::ParkedConflict {
                chosen_entity_id, ..
            } => Some(chosen_entity_id),
            _ => None,
        }
    }

    pub fn reason_codes(&self) -> Vec<ReasonCode> {
        match self {
            Resolution::Attached { .. } => Vec::new(),
            Resolution::ParkedUnresolved { reason } => vec![*reason],
            Resolution::ParkedGranularity => vec![ReasonCode::CompoundAssertionTargets],
            Resolution::ParkedConflict { .. } => vec![ReasonCode::ConflictingAttachment],
        }
    }

    /// Attached rows attach; everything else parks. One word, one place.
    pub fn attachment_state(&self) -> &'static str {
        match self {
            Resolution::Attached { .. } => "attached",
            _ => "parked",
        }
    }
}

/// One recorded attempt, tagged.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Attempt {
    Ineligible {
        reason: Ineligible,
    },
    Eligible {
        normalized_mention_hashes: Vec<String>,
        target_count: u64,
        candidate_entity_ids: Vec<String>,
        resolution: Resolution,
    },
}

impl Attempt {
    /// The outcome word a row stores — an ineligible attempt never reached
    /// an outcome, so it says so rather than borrowing one.
    pub fn outcome_str(&self) -> &'static str {
        match self {
            Attempt::Ineligible { .. } => "ineligible",
            Attempt::Eligible { resolution, .. } => resolution.outcome().as_str(),
        }
    }

    /// Every structural rule the design states, checked in one place.
    ///
    /// These are not belt-and-braces: they are what makes each M28 numerator
    /// and denominator reconstructible from the rows alone. A row that broke
    /// one of them would make a rate mean something different without
    /// looking any different.
    pub fn validate(&self) -> Result<(), String> {
        let Attempt::Eligible {
            normalized_mention_hashes,
            target_count,
            candidate_entity_ids,
            resolution,
        } = self
        else {
            return Ok(());
        };
        if normalized_mention_hashes.is_empty() {
            return Err("an eligible attempt hashed at least one mention".into());
        }
        if *target_count == 0 {
            return Err("an eligible attempt has at least one typed target".into());
        }
        let unique: BTreeSet<&String> = candidate_entity_ids.iter().collect();
        if unique.len() != candidate_entity_ids.len() {
            return Err("candidate_entity_ids must be unique".into());
        }
        let sorted: Vec<&String> = unique.into_iter().collect();
        let given: Vec<&String> = candidate_entity_ids.iter().collect();
        if sorted != given {
            return Err("candidate_entity_ids must be in canonical order".into());
        }
        match resolution {
            Resolution::Attached {
                chosen_entity_id, ..
            } => {
                if *target_count != 1 {
                    return Err("an attached row has exactly one target".into());
                }
                if candidate_entity_ids.as_slice() != [chosen_entity_id.clone()] {
                    return Err(
                        "an attached row has exactly one candidate, and it is the chosen entity"
                            .into(),
                    );
                }
            }
            Resolution::ParkedConflict {
                chosen_entity_id,
                prior_entity_id,
                prior_resolution_event_id,
            } => {
                if *target_count != 1 {
                    return Err("a conflicting row has exactly one target".into());
                }
                if candidate_entity_ids.as_slice() != [chosen_entity_id.clone()] {
                    return Err("a conflicting row's one candidate is its chosen entity".into());
                }
                if chosen_entity_id == prior_entity_id {
                    return Err(
                        "a conflict names a DIFFERENT entity than the prior attachment".into(),
                    );
                }
                if prior_resolution_event_id.is_empty() {
                    return Err("a conflict pins the prior resolution event".into());
                }
            }
            Resolution::ParkedUnresolved { reason } => {
                if *target_count != 1 {
                    return Err("an unresolved row has exactly one target".into());
                }
                match reason {
                    ReasonCode::AmbiguousCandidates if candidate_entity_ids.len() < 2 => {
                        return Err("ambiguous means at least two candidates".into())
                    }
                    ReasonCode::NoCandidate if !candidate_entity_ids.is_empty() => {
                        return Err("no_candidate means zero candidates".into())
                    }
                    ReasonCode::AmbiguousCandidates | ReasonCode::NoCandidate => {}
                    other => return Err(format!("{} is not an unresolved reason", other.as_str())),
                }
            }
            Resolution::ParkedGranularity => {
                if *target_count < 2 {
                    return Err(
                        "granularity-blocked is the ONLY outcome with more than one target, and \
                         it requires them"
                            .into(),
                    );
                }
            }
        }
        Ok(())
    }
}

/// `sha256("cerebro-resolver-attempt-v1" | 0 | store | 0 | run | 0 | item |
/// 0 | candidate hash)`.
///
/// Derived from exactly what a retry would repeat, so retrying one
/// run/item/candidate is idempotent rather than a second row that inflates
/// every rate computed from these.
pub fn attempt_id(
    store_uuid: &str,
    run_id: &str,
    ingest_item_id: &str,
    assertion_candidate_hash: &str,
) -> String {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(b"cerebro-resolver-attempt-v1");
    for part in [store_uuid, run_id, ingest_item_id, assertion_candidate_hash] {
        bytes.push(0);
        bytes.extend_from_slice(part.as_bytes());
    }
    crate::ledger::sha256_hex(&bytes)
}

/// The mention hash a row stores. RAW SOURCE TEXT IS NEVER COPIED into the
/// runtime DB: a hash answers "was this the same mention" without turning the
/// operational database into a second copy of the vault.
pub fn mention_hash(mention: &str) -> String {
    crate::ledger::sha256_hex(normalize_alias_v1(mention).as_bytes())
}

/// What the extractor handed the resolver.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    /// The subject as written. Empty means the extractor found none.
    pub mention: String,
    /// How many independently attachable targets the extractor identified.
    /// More than one means the claim conflates things and must park.
    pub target_count: u64,
    /// The committed assertion Observation, when there is a singular one.
    pub assertion_event_id: Option<String>,
    /// Is the Observation an assertion at all? A snapshot or a system event
    /// has no subject to resolve.
    pub is_assertion: bool,
    /// A relation the extractor read off the record, e.g. `about: [[Falcon]]`
    /// — the explicit-relation tier's input.
    pub explicit_relation_target: Option<String>,
    /// A prior `observation.subject_resolved` for this Observation, if any.
    pub prior_attachment: Option<(String, String)>,
}

impl Candidate {
    /// The stable hash of this candidate, for the attempt id.
    pub fn hash(&self) -> String {
        let canonical = serde_json::json!({
            "mention": normalize_alias_v1(&self.mention),
            "target_count": self.target_count,
            "assertion_event_id": self.assertion_event_id,
        })
        .to_string();
        crate::ledger::sha256_hex(canonical.as_bytes())
    }
}

/// Resolve one candidate against committed reducer state.
///
/// Tier order is the design's and is load-bearing: an exact id beats an
/// alias, an alias beats a relation, and a normalized match is the LAST
/// thing tried because it is the only tier that could be wrong about two
/// different things sharing a name.
pub fn resolve(state: &EpistemicState, candidate: &Candidate) -> Attempt {
    if !candidate.is_assertion {
        return Attempt::Ineligible {
            reason: Ineligible::NonAssertionObservation,
        };
    }
    if candidate.mention.trim().is_empty() {
        return Attempt::Ineligible {
            reason: Ineligible::SubjectNone,
        };
    }
    if candidate.target_count == 0 {
        return Attempt::Ineligible {
            reason: Ineligible::MalformedSubject,
        };
    }

    // A compound claim is noticed and parked BEFORE anything is looked up:
    // resolving one of several conflated targets would attach a claim to a
    // subject it is only partly about.
    if candidate.target_count > 1 {
        return Attempt::Eligible {
            normalized_mention_hashes: vec![mention_hash(&candidate.mention)],
            target_count: candidate.target_count,
            candidate_entity_ids: Vec::new(),
            resolution: Resolution::ParkedGranularity,
        };
    }
    // A singular assertion has to name the event it is about; without one
    // there is nothing for a resolution event to point at.
    if candidate.assertion_event_id.is_none() {
        return Attempt::Ineligible {
            reason: Ineligible::MissingAssertionEvent,
        };
    }

    let (outcome, candidates) = tiers(state, candidate);
    let hashes = vec![mention_hash(&candidate.mention)];
    let eligible = |resolution: Resolution, candidate_entity_ids: Vec<String>| Attempt::Eligible {
        normalized_mention_hashes: hashes.clone(),
        target_count: 1,
        candidate_entity_ids,
        resolution,
    };

    let Some(outcome) = outcome else {
        // Nothing matched. Ambiguity and absence are DIFFERENT answers: one
        // says "several things could be meant", the other "nothing here is".
        let reason = if candidates.len() >= 2 {
            ReasonCode::AmbiguousCandidates
        } else {
            ReasonCode::NoCandidate
        };
        let candidate_entity_ids = if reason == ReasonCode::AmbiguousCandidates {
            candidates
        } else {
            Vec::new()
        };
        return eligible(
            Resolution::ParkedUnresolved { reason },
            candidate_entity_ids,
        );
    };
    let chosen = candidates[0].clone();

    match &candidate.prior_attachment {
        // Already attached to the same entity: nothing to decide, and it
        // never enters a rate.
        Some((prior_entity, _)) if prior_entity == &chosen => Attempt::Ineligible {
            reason: Ineligible::AlreadyAttached,
        },
        // Attached to something else. PARK — a rule that has no idea a
        // person decided this must not overwrite them.
        Some((prior_entity, prior_event)) => eligible(
            Resolution::ParkedConflict {
                chosen_entity_id: chosen.clone(),
                prior_entity_id: prior_entity.clone(),
                prior_resolution_event_id: prior_event.clone(),
            },
            vec![chosen],
        ),
        None => eligible(
            Resolution::Attached {
                outcome,
                chosen_entity_id: chosen.clone(),
            },
            vec![chosen],
        ),
    }
}

/// The tier ladder. Returns the winning tier (if any) and the candidate set
/// the row records.
fn tiers(state: &EpistemicState, candidate: &Candidate) -> (Option<Outcome>, Vec<String>) {
    let mention = candidate.mention.trim();

    // 1. An exact entity id. Unambiguous by construction.
    if state.entities.contains_key(mention) {
        return (Some(Outcome::ExactId), vec![mention.to_string()]);
    }

    // 2. A registered alias. Somebody said this name means this entity.
    let normalized = normalize_alias_v1(mention);
    if let Some(alias) = state.alias_registry.get(&normalized) {
        return (Some(Outcome::KnownAlias), vec![alias.entity_id.clone()]);
    }

    // 3. An explicit relation the record itself declares.
    if let Some(target) = &candidate.explicit_relation_target {
        let target = target.trim();
        if state.entities.contains_key(target) {
            return (Some(Outcome::ExplicitRelation), vec![target.to_string()]);
        }
        if let Some(alias) = state.alias_registry.get(&normalize_alias_v1(target)) {
            return (
                Some(Outcome::ExplicitRelation),
                vec![alias.entity_id.clone()],
            );
        }
    }

    // 4. The normalized string-equality CLASS — every entity whose registered
    // aliases normalize to this mention. Deliberately last, and deliberately
    // refusing on a tie: this is the one tier that could be wrong about two
    // different things sharing a name, and a coin flip there attaches a claim
    // to the wrong subject permanently.
    let mut matches: BTreeSet<String> = BTreeSet::new();
    for alias in state.alias_registry.values() {
        if alias.normalized == normalized {
            matches.insert(alias.entity_id.clone());
        }
    }
    let matches: Vec<String> = matches.into_iter().collect();
    match matches.len() {
        1 => (Some(Outcome::NormalizedMatch), matches),
        _ => (None, matches),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ledger::reduce::{AliasState, EntityState};

    const FALCON: &str = "f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1";
    const XAVIER: &str = "8a8a8a8a8a8a8a8a8a8a8a8a8a8a8a8a";
    const REV_C: &str = "c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1";
    const OBSERVATION: &str = "0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b";
    const PRIOR: &str = "9d9d9d9d9d9d9d9d9d9d9d9d9d9d9d9d";

    /// The §84 worked corpus: a product, a revision that shares a name with
    /// nothing, and a person. Aliases are what somebody REGISTERED, never
    /// what the resolver guessed.
    fn corpus() -> EpistemicState {
        let mut state = EpistemicState::default();
        for (id, aliases) in [
            (FALCON, vec!["Falcon", "Falcon C"]),
            (XAVIER, vec!["Xavier"]),
            (REV_C, vec!["Rev C"]),
        ] {
            state.entities.insert(
                id.to_string(),
                EntityState {
                    entity_id: id.to_string(),
                    registered_by_event_id: OBSERVATION.to_string(),
                },
            );
            for alias in aliases {
                state.alias_registry.insert(
                    normalize_alias_v1(alias),
                    AliasState {
                        normalized: normalize_alias_v1(alias),
                        alias: alias.to_string(),
                        entity_id: id.to_string(),
                        event_id: OBSERVATION.to_string(),
                    },
                );
            }
        }
        state
    }

    fn candidate(mention: &str) -> Candidate {
        Candidate {
            mention: mention.to_string(),
            target_count: 1,
            assertion_event_id: Some(OBSERVATION.to_string()),
            is_assertion: true,
            explicit_relation_target: None,
            prior_attachment: None,
        }
    }

    fn attached(attempt: &Attempt) -> Option<(Outcome, String)> {
        match attempt {
            Attempt::Eligible {
                resolution:
                    Resolution::Attached {
                        outcome,
                        chosen_entity_id,
                    },
                ..
            } => Some((*outcome, chosen_entity_id.clone())),
            _ => None,
        }
    }

    #[test]
    fn every_tier_attaches_the_thing_it_is_named_for() {
        let state = corpus();
        assert_eq!(
            attached(&resolve(&state, &candidate(FALCON))),
            Some((Outcome::ExactId, FALCON.into()))
        );
        assert_eq!(
            attached(&resolve(&state, &candidate("Falcon C"))),
            Some((Outcome::KnownAlias, FALCON.into())),
            "a registered alias is somebody's decision, not a guess"
        );
        let mut relation = candidate("something nobody registered");
        relation.explicit_relation_target = Some("Xavier".into());
        assert_eq!(
            attached(&resolve(&state, &relation)),
            Some((Outcome::ExplicitRelation, XAVIER.into()))
        );
        assert_eq!(
            attached(&resolve(&state, &candidate("  falcon  "))),
            Some((Outcome::KnownAlias, FALCON.into())),
            "normalization is NFKC + lowercase, and it is M22's, not a second one"
        );
    }

    #[test]
    fn the_tiers_are_ordered_and_the_order_is_load_bearing() {
        // An exact id wins over an alias that points somewhere else — an id
        // cannot be ambiguous and an alias can.
        let mut state = corpus();
        state.alias_registry.insert(
            normalize_alias_v1(FALCON),
            AliasState {
                normalized: normalize_alias_v1(FALCON),
                alias: FALCON.to_string(),
                entity_id: XAVIER.to_string(),
                event_id: OBSERVATION.to_string(),
            },
        );
        assert_eq!(
            attached(&resolve(&state, &candidate(FALCON))),
            Some((Outcome::ExactId, FALCON.into()))
        );

        // A registered alias wins over an explicit relation: the alias is a
        // statement about this NAME, the relation about this record.
        let mut both = candidate("Falcon C");
        both.explicit_relation_target = Some("Xavier".into());
        assert_eq!(
            attached(&resolve(&state, &both)),
            Some((Outcome::KnownAlias, FALCON.into()))
        );
    }

    #[test]
    fn a_name_nobody_registered_is_unresolved_and_never_guessed() {
        // The whole point of the fifth tier being `unresolved`: "Product A"
        // is not Falcon just because Falcon is the only product around.
        let attempt = resolve(&corpus(), &candidate("Product A"));
        let Attempt::Eligible {
            resolution: Resolution::ParkedUnresolved { reason },
            candidate_entity_ids,
            ..
        } = &attempt
        else {
            panic!("{attempt:?}");
        };
        assert_eq!(*reason, ReasonCode::NoCandidate);
        assert!(candidate_entity_ids.is_empty());
        assert_eq!(attempt.validate(), Ok(()));
    }

    #[test]
    fn two_entities_sharing_a_name_are_ambiguous_rather_than_a_coin_flip() {
        // The one tier that can be wrong about two things sharing a name
        // refuses on a tie. A guess here attaches a claim to the wrong
        // subject permanently.
        let mut state = corpus();
        state.alias_registry.insert(
            normalize_alias_v1("Rev C"),
            AliasState {
                normalized: normalize_alias_v1("Rev C"),
                alias: "Rev C".to_string(),
                entity_id: REV_C.to_string(),
                event_id: OBSERVATION.to_string(),
            },
        );
        // Two OTHER entities also carry aliases that normalize to this
        // mention, stored under their own registry keys.
        for (key, entity) in [("rev-c-falcon", FALCON), ("rev-c-xavier", XAVIER)] {
            state.alias_registry.insert(
                key.to_string(),
                AliasState {
                    normalized: normalize_alias_v1("Rev C"),
                    alias: "REV  C".to_string(),
                    entity_id: entity.to_string(),
                    event_id: OBSERVATION.to_string(),
                },
            );
        }
        let attempt = resolve(&state, &candidate("Rev C"));
        // The direct registry hit still wins — it is tier 2, and exact.
        assert_eq!(
            attached(&attempt),
            Some((Outcome::KnownAlias, REV_C.into()))
        );

        // With no direct registry entry, the equality CLASS is consulted —
        // and two entities in it means a tie, which refuses.
        state.alias_registry.remove(&normalize_alias_v1("Rev C"));
        let attempt = resolve(&state, &candidate("Rev C"));
        let Attempt::Eligible {
            resolution: Resolution::ParkedUnresolved { reason },
            candidate_entity_ids,
            ..
        } = &attempt
        else {
            panic!("{attempt:?}");
        };
        assert_eq!(*reason, ReasonCode::AmbiguousCandidates);
        assert_eq!(candidate_entity_ids.len(), 2);
        assert_eq!(attempt.validate(), Ok(()));
    }

    #[test]
    fn a_compound_claim_parks_before_anything_is_looked_up() {
        // Resolving one of several conflated targets would attach a claim to
        // a subject it is only partly about. Noticed, parked, and NOT called
        // the M28 granularity Resolver, which this is not.
        let mut compound = candidate("Falcon");
        compound.target_count = 3;
        let attempt = resolve(&corpus(), &compound);
        assert!(matches!(
            attempt,
            Attempt::Eligible {
                resolution: Resolution::ParkedGranularity,
                target_count: 3,
                ..
            }
        ));
        assert_eq!(attempt.validate(), Ok(()));
        assert_eq!(
            attempt,
            Attempt::Eligible {
                normalized_mention_hashes: vec![mention_hash("Falcon")],
                target_count: 3,
                candidate_entity_ids: vec![],
                resolution: Resolution::ParkedGranularity,
            }
        );
    }

    #[test]
    fn a_prior_attachment_to_the_same_entity_is_not_a_resolution_at_all() {
        // Ineligible, so it never enters an M28 denominator: nothing was
        // resolved, and counting it would measure how often we re-ask.
        let mut again = candidate("Falcon");
        again.prior_attachment = Some((FALCON.to_string(), PRIOR.to_string()));
        assert_eq!(
            resolve(&corpus(), &again),
            Attempt::Ineligible {
                reason: Ineligible::AlreadyAttached
            }
        );
    }

    #[test]
    fn a_disagreement_parks_and_pins_what_it_disagrees_with() {
        // Never auto-replaces: the prior attachment was somebody's decision,
        // and this rule has no idea they made it.
        let mut moved = candidate("Falcon");
        moved.prior_attachment = Some((XAVIER.to_string(), PRIOR.to_string()));
        let attempt = resolve(&corpus(), &moved);
        let Attempt::Eligible {
            resolution:
                Resolution::ParkedConflict {
                    chosen_entity_id,
                    prior_entity_id,
                    prior_resolution_event_id,
                },
            ..
        } = &attempt
        else {
            panic!("{attempt:?}");
        };
        assert_eq!(chosen_entity_id, FALCON);
        assert_eq!(prior_entity_id, XAVIER);
        assert_eq!(prior_resolution_event_id, PRIOR);
        assert_eq!(attempt.outcome_str(), "conflicting_attachment");
        assert_eq!(attempt.validate(), Ok(()));
    }

    #[test]
    fn every_ineligible_reason_is_reachable_and_none_of_them_resolve() {
        let state = corpus();
        let mut snapshot = candidate("Falcon");
        snapshot.is_assertion = false;
        let mut empty = candidate("   ");
        empty.target_count = 1;
        let mut no_target = candidate("Falcon");
        no_target.target_count = 0;
        let mut no_event = candidate("Falcon");
        no_event.assertion_event_id = None;

        for (expected, candidate) in [
            (Ineligible::NonAssertionObservation, snapshot),
            (Ineligible::SubjectNone, empty),
            (Ineligible::MalformedSubject, no_target),
            (Ineligible::MissingAssertionEvent, no_event),
        ] {
            assert_eq!(
                resolve(&state, &candidate),
                Attempt::Ineligible { reason: expected },
                "{}",
                expected.as_str()
            );
        }
    }

    #[test]
    fn the_attempt_id_is_idempotent_for_one_run_item_and_candidate() {
        // A retry must not become a second row: every M28 rate is computed
        // from these, and a duplicate would inflate both halves differently.
        let hash = candidate("Falcon").hash();
        let first = attempt_id("store", "run-1", "item-1", &hash);
        assert_eq!(first, attempt_id("store", "run-1", "item-1", &hash));
        assert_ne!(first, attempt_id("store", "run-2", "item-1", &hash));
        assert_ne!(first, attempt_id("store", "run-1", "item-2", &hash));
        assert_eq!(first.len(), 64);
    }

    #[test]
    fn the_row_stores_a_hash_and_never_the_source_text() {
        // runtime.db is not a second copy of the vault. A hash answers "was
        // this the same mention" without becoming one.
        let attempt = resolve(&corpus(), &candidate("Falcon"));
        let Attempt::Eligible {
            normalized_mention_hashes,
            ..
        } = &attempt
        else {
            panic!("{attempt:?}");
        };
        assert_eq!(normalized_mention_hashes, &vec![mention_hash("Falcon")]);
        assert!(!normalized_mention_hashes[0].contains("Falcon"));
        assert_eq!(
            mention_hash("Falcon"),
            mention_hash("  FALCON  "),
            "the hash is over the NORMALIZED mention, so casing is not a new mention"
        );
    }

    #[test]
    fn the_structural_invariants_refuse_every_shape_that_would_break_a_rate() {
        let bad = |resolution, targets, candidates: Vec<&str>| Attempt::Eligible {
            normalized_mention_hashes: vec![mention_hash("x")],
            target_count: targets,
            candidate_entity_ids: candidates.into_iter().map(str::to_string).collect(),
            resolution,
        };
        // Attached with two candidates.
        assert!(bad(
            Resolution::Attached {
                outcome: Outcome::ExactId,
                chosen_entity_id: FALCON.into()
            },
            1,
            vec![FALCON, XAVIER],
        )
        .validate()
        .is_err());
        // Ambiguous with one candidate.
        assert!(bad(
            Resolution::ParkedUnresolved {
                reason: ReasonCode::AmbiguousCandidates
            },
            1,
            vec![FALCON],
        )
        .validate()
        .is_err());
        // No-candidate with a candidate.
        assert!(bad(
            Resolution::ParkedUnresolved {
                reason: ReasonCode::NoCandidate
            },
            1,
            vec![FALCON],
        )
        .validate()
        .is_err());
        // Granularity with one target.
        assert!(bad(Resolution::ParkedGranularity, 1, vec![])
            .validate()
            .is_err());
        // A conflict that "moved" to the same entity.
        assert!(bad(
            Resolution::ParkedConflict {
                chosen_entity_id: FALCON.into(),
                prior_entity_id: FALCON.into(),
                prior_resolution_event_id: PRIOR.into(),
            },
            1,
            vec![FALCON],
        )
        .validate()
        .is_err());
        // Unsorted candidates. (`FALCON` sorts after `XAVIER`, so this pair
        // in this order is the non-canonical one.)
        assert!(bad(
            Resolution::ParkedUnresolved {
                reason: ReasonCode::AmbiguousCandidates
            },
            1,
            vec![FALCON, XAVIER],
        )
        .validate()
        .is_err());
        // And the same pair in canonical order is fine.
        assert_eq!(
            bad(
                Resolution::ParkedUnresolved {
                    reason: ReasonCode::AmbiguousCandidates
                },
                1,
                vec![XAVIER, FALCON],
            )
            .validate(),
            Ok(())
        );
    }

    #[test]
    fn only_an_attached_outcome_names_a_tier() {
        for outcome in [
            Outcome::ExactId,
            Outcome::KnownAlias,
            Outcome::ExplicitRelation,
            Outcome::NormalizedMatch,
        ] {
            assert!(outcome.tier().is_some(), "{}", outcome.as_str());
        }
        for outcome in [
            Outcome::Unresolved,
            Outcome::ClaimGranularityBlocked,
            Outcome::ConflictingAttachment,
        ] {
            assert!(
                outcome.tier().is_none(),
                "{} attached nothing, so it names no tier",
                outcome.as_str()
            );
        }
    }
}
