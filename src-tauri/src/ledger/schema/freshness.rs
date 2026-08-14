//! `freshness.transitioned` (M27.1): the crossing, recorded — never the
//! clock, read.
//!
//! **The reducer folds this body and derives nothing.** Freshness itself is a
//! pure function of pinned evidence, a versioned rule, and an explicit
//! `as_of` ([`crate::dynamics::freshness`]); this event is how a CROSSING
//! enters history, so a surface can say "this went stale on Tuesday" and a
//! rebuild next week lands on the same bytes. If the reducer re-derived
//! freshness it would need the rules artifact, the predicate of every
//! assertion, and a clock — three things the TypeScript reducer has none of,
//! and the last of which the whole design forbids.
//!
//! **A duplicate `dedupe_key` is an idempotent NO-OP, not a refusal**, and
//! that is a deliberate difference from `conflict.candidate_detected`, whose
//! second append IS refused. Two independent producers emit the same due
//! transition — the timer and launch catch-up — and either may win. A retry
//! that changed nothing must therefore change nothing, including versions.
//! The same key carrying a DIFFERENT `from`/`to` is still a hard conflict:
//! those two fields are the only content the key does not cover, so a
//! disagreement about them is two producers disagreeing about what happened.
//!
//! **`effective_at` is not monotonic across a facet's history, and must not
//! be checked as if it were.** A facet goes stale at `anchor + duration`; it
//! becomes fresh again AT the newer anchor. A source that stamps evidence
//! retroactively can therefore make "became fresh" earlier than "went stale"
//! — which is the truthful record, because a claim can start being true again
//! as of a time before anybody noticed. Both times come from pinned evidence
//! and the versioned rule, and that is what makes replay byte-identical; a
//! monotonicity rule would have to reach for the wall clock to hold.

use serde::{Deserialize, Serialize};

use super::{canonical_json, is_id128, schema_body, sha256_first128, StateStage};

/// One of D9's three axes' values. `Unknown` is a member rather than an
/// absence: "nobody has said how long this stays current" and "this is
/// current" are different answers, and a nullable field makes a reader decide
/// which one a null meant.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Freshness {
    Fresh,
    Stale,
    Unknown,
}

impl Freshness {
    pub fn as_str(self) -> &'static str {
        match self {
            Freshness::Fresh => "fresh",
            Freshness::Stale => "stale",
            Freshness::Unknown => "unknown",
        }
    }

    pub fn parse(value: &str) -> Option<Freshness> {
        match value {
            "fresh" => Some(Freshness::Fresh),
            "stale" => Some(Freshness::Stale),
            "unknown" => Some(Freshness::Unknown),
            _ => None,
        }
    }

    pub const ALL: [Freshness; 3] = [Freshness::Fresh, Freshness::Stale, Freshness::Unknown];
}

/// The predicate half of a facet key, tagged.
///
/// `Unknown` is a member for the reason [`StateStage::Unknown`] is: "no
/// predicate was recorded" and "the predicate is `ci_status`" are different
/// keys, and a nullable field makes them one.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FacetPredicate {
    Known { value: String },
    Unknown,
}

impl FacetPredicate {
    /// The predicate string, when there is one. Freshness rules match on
    /// this; a facet with no predicate matches no rule, which is why its
    /// freshness is `unknown` rather than a guess.
    pub fn value(&self) -> Option<&str> {
        match self {
            FacetPredicate::Known { value } => Some(value.as_str()),
            FacetPredicate::Unknown => None,
        }
    }

    pub fn validate(&self, side: &str) -> Result<(), String> {
        match self {
            FacetPredicate::Known { value } if value.is_empty() => Err(format!(
                "{side}.predicate.known carries an empty value — an empty string is the unknown \
                 variant mis-spelled"
            )),
            _ => Ok(()),
        }
    }
}

/// What one set of axes is about: a PINNED belief revision, and the
/// `(predicate, stage)` pair within it.
///
/// The revision is pinned, not "current". That is what makes a facet's
/// history stable — a transition recorded against revision 3 stays true about
/// revision 3 after revision 4 lands — and it is why §45's "revision-bound"
/// shipping-BOM rule needs no column of its own.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BeliefFacetKey {
    pub belief_id: String,
    pub belief_revision_event_id: String,
    pub predicate: FacetPredicate,
    pub state_stage: StateStage,
}

impl BeliefFacetKey {
    pub fn validate(&self, side: &str) -> Result<(), String> {
        for (name, id) in [
            ("belief_id", &self.belief_id),
            ("belief_revision_event_id", &self.belief_revision_event_id),
        ] {
            if !is_id128(id) {
                return Err(format!("{side}.{name} is not a 128-bit hex id"));
            }
        }
        self.predicate.validate(side)
    }

    /// The facet's own 128-bit id — a domain-separated digest over the
    /// canonical key, in the shape every other derived id here takes.
    ///
    /// It exists so reducer state can be keyed by a facet without a composite
    /// map key that two implementations would have to spell the same way.
    pub fn facet_id(&self) -> String {
        let canonical = canonical_json(self).expect("a closed struct of strings and enums");
        sha256_first128(format!("cerebro-belief-facet-v1\0{canonical}").as_bytes())
    }
}

/// `sha256("cerebro-freshness-dedupe-v1\0" + canonical_json([revision,
/// predicate, stage, effective_at, rule_version]))`, first 128 bits.
///
/// The five fields the design names, and NOT `from`/`to`: the key identifies
/// the transition a rule and a body of evidence make due, so two producers
/// computing it independently arrive at the same key — which is the whole
/// point — while a disagreement about what the transition WAS remains
/// visible as a conflict rather than being deduplicated away.
pub fn derive_freshness_dedupe_key(
    belief_revision_event_id: &str,
    predicate: &FacetPredicate,
    state_stage: StateStage,
    effective_at: &str,
    rule_version: &str,
) -> Result<String, String> {
    let tuple = canonical_json(&serde_json::json!([
        belief_revision_event_id,
        predicate,
        state_stage,
        effective_at,
        rule_version,
    ]))?;
    Ok(sha256_first128(
        format!("cerebro-freshness-dedupe-v1\0{tuple}").as_bytes(),
    ))
}

/// The server-side idempotency key. Store-scoped, so two vaults whose facets
/// happen to be structurally identical never collide.
pub fn derive_freshness_transition_key(store_uuid: &str, dedupe_key: &str) -> String {
    format!("freshness-transition:{store_uuid}:{dedupe_key}")
}

schema_body! {
    /// One facet crossing a freshness boundary.
    pub struct FreshnessTransitioned {
        pub facet: BeliefFacetKey,
        pub from: Freshness,
        pub to: Freshness,
        /// The instant, on the rule's own time basis, at which the facet
        /// entered `to`. Derived from pinned evidence and the versioned rule
        /// — never from the clock at emission, which is what makes a rebuild
        /// next week byte-identical.
        pub effective_at: String,
        /// Which rules produced it. A rule change emits NEW transitions under
        /// a new version rather than reinterpreting old ones.
        pub rule_version: String,
        /// [`derive_freshness_dedupe_key`]. The reducer re-derives it: a key
        /// that does not follow from the body it claims to summarize is the
        /// one lie this event could tell.
        pub dedupe_key: String,
    }
}

impl FreshnessTransitioned {
    pub fn validate(&self) -> Result<(), String> {
        self.validate_common()?;
        self.facet.validate("facet")?;
        if self.from == self.to {
            return Err(format!(
                "from and to are both {} — a transition that changed nothing is not a \
                 transition, and recording one would put a crossing in history that never \
                 happened",
                self.to.as_str()
            ));
        }
        if chrono::DateTime::parse_from_rfc3339(&self.effective_at).is_err() {
            return Err(format!(
                "effective_at {:?} is not RFC3339",
                self.effective_at
            ));
        }
        if self.rule_version.is_empty() {
            return Err(
                "rule_version must be non-empty — a transition nobody can read against \
                        the rules that produced it is unreadable history"
                    .into(),
            );
        }
        let derived = derive_freshness_dedupe_key(
            &self.facet.belief_revision_event_id,
            &self.facet.predicate,
            self.facet.state_stage,
            &self.effective_at,
            &self.rule_version,
        )?;
        if derived != self.dedupe_key {
            return Err(format!(
                "dedupe_key {} does not follow from this transition (expected {derived})",
                self.dedupe_key
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ledger::schema::{Actor, BODY_SCHEMA};

    const BELIEF: &str = "b0000000000000000000000000000001";
    const REVISION: &str = "10000000000000000000000000000002";

    fn key() -> BeliefFacetKey {
        BeliefFacetKey {
            belief_id: BELIEF.into(),
            belief_revision_event_id: REVISION.into(),
            predicate: FacetPredicate::Known {
                value: "ci_status".into(),
            },
            state_stage: StateStage::Implemented,
        }
    }

    fn transition(from: Freshness, to: Freshness) -> FreshnessTransitioned {
        let facet = key();
        let effective_at = "2026-08-12T09:00:00.000Z".to_string();
        let rule_version = "freshness-v1".to_string();
        let dedupe_key = derive_freshness_dedupe_key(
            &facet.belief_revision_event_id,
            &facet.predicate,
            facet.state_stage,
            &effective_at,
            &rule_version,
        )
        .unwrap();
        FreshnessTransitioned {
            schema: BODY_SCHEMA,
            batch_id: None,
            idempotency_key: None,
            actor: Actor {
                id: "system:freshness".into(),
            },
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            facet,
            from,
            to,
            effective_at,
            rule_version,
            dedupe_key,
        }
    }

    #[test]
    fn a_well_formed_transition_validates() {
        transition(Freshness::Fresh, Freshness::Stale)
            .validate()
            .unwrap();
    }

    #[test]
    fn a_transition_that_changed_nothing_is_refused() {
        let detail = transition(Freshness::Stale, Freshness::Stale)
            .validate()
            .unwrap_err();
        assert!(detail.contains("never happened"), "{detail}");
    }

    #[test]
    fn a_dedupe_key_that_does_not_follow_from_the_body_is_refused() {
        let mut body = transition(Freshness::Fresh, Freshness::Stale);
        body.dedupe_key = "0".repeat(32);
        assert!(body
            .validate()
            .unwrap_err()
            .contains("does not follow from this transition"));
    }

    #[test]
    fn the_dedupe_key_covers_the_five_fields_the_design_names_and_not_the_states() {
        // `from`/`to` are deliberately outside the key: two producers
        // computing what is DUE must agree, and a disagreement about what
        // happened must stay visible rather than being deduplicated away.
        let a = transition(Freshness::Fresh, Freshness::Stale);
        let b = transition(Freshness::Unknown, Freshness::Fresh);
        assert_eq!(a.dedupe_key, b.dedupe_key);

        let mut moved = a.clone();
        moved.effective_at = "2026-08-12T10:00:00.000Z".into();
        assert_ne!(
            derive_freshness_dedupe_key(
                &moved.facet.belief_revision_event_id,
                &moved.facet.predicate,
                moved.facet.state_stage,
                &moved.effective_at,
                &moved.rule_version,
            )
            .unwrap(),
            a.dedupe_key
        );

        let mut restaged = a.clone();
        restaged.facet.state_stage = StateStage::Shipping;
        assert_ne!(
            derive_freshness_dedupe_key(
                &restaged.facet.belief_revision_event_id,
                &restaged.facet.predicate,
                restaged.facet.state_stage,
                &restaged.effective_at,
                &restaged.rule_version,
            )
            .unwrap(),
            a.dedupe_key
        );

        let mut reruled = a.clone();
        reruled.rule_version = "freshness-v2".into();
        assert_ne!(
            derive_freshness_dedupe_key(
                &reruled.facet.belief_revision_event_id,
                &reruled.facet.predicate,
                reruled.facet.state_stage,
                &reruled.effective_at,
                &reruled.rule_version,
            )
            .unwrap(),
            a.dedupe_key,
            "a rule change emits NEW transitions rather than reinterpreting old ones"
        );
    }

    #[test]
    fn an_empty_predicate_string_is_the_unknown_variant_mis_spelled() {
        let mut body = transition(Freshness::Fresh, Freshness::Stale);
        body.facet.predicate = FacetPredicate::Known {
            value: String::new(),
        };
        assert!(body.validate().unwrap_err().contains("mis-spelled"));
    }

    #[test]
    fn a_facet_id_follows_from_the_key_and_nothing_else() {
        let one = key();
        let mut two = one.clone();
        two.state_stage = StateStage::Planned;
        assert_eq!(one.facet_id(), key().facet_id());
        assert_ne!(one.facet_id(), two.facet_id());
        assert_eq!(one.facet_id().len(), 32);
    }

    #[test]
    fn the_idempotency_key_is_store_scoped() {
        assert_eq!(
            derive_freshness_transition_key("feedface", "abc"),
            "freshness-transition:feedface:abc"
        );
    }

    #[test]
    fn every_freshness_value_round_trips_through_its_spelling() {
        for value in Freshness::ALL {
            assert_eq!(Freshness::parse(value.as_str()), Some(value));
        }
        assert_eq!(Freshness::parse("stale-ish"), None);
    }
}
