//! R7's observation extractor (M28.0h) — the seam, made real.
//!
//! The protocol counts "distinct committed assertion-bearing Observations
//! matching the declared scope digest", and this module is the one place
//! that sentence is turned into checks over reducer state. Every clause is
//! its own exclusion, and every exclusion has its own test, because the
//! M27.10 lesson was that a rule comparing two things is invisible to a
//! fixture where the two things are equal — here every excluded observation
//! differs from the qualifying one in exactly one property.
//!
//! **What qualifies.** An `observation.recorded` the reducer holds (committed
//! by construction — the reducer applies nothing else) that is
//! assertion-bearing about the WORLD (`extracted_assertion` or
//! `human_assertion`; snapshots are bytes, system events are operations, and
//! derived content is the base talking to itself), carries the D11 metadata
//! (an assertion basis on the observation, and the indexed facet holding the
//! relationship claim and scope), is attached to a DECLARED subject, has a
//! predicate whose CLASS — resolved through the freshness artifact, the one
//! predicate→class authority this codebase has — is declared, satisfies
//! every declared scope constraint, was recorded inside the window by the
//! store's own stamp (D3: source-supplied times are never trusted for
//! ordering), and is pinned to the registration the M25 cache row names,
//! which must itself agree with the ledger's CURRENT registration — a stale
//! or orphaned cache row disqualifies its whole source.
//!
//! **A constrained axis must be claimed.** If the declared scope constrains
//! `stage`, an observation silent about stage does not count: silence about
//! the constrained slice is not a claim about it, and counting it would let
//! unscoped chatter verify a scoped question.

use std::collections::{BTreeMap, BTreeSet};

use crate::dynamics::freshness;
use crate::ledger::reduce::EpistemicState;
use crate::ledger::schema::ObservationKind;
use crate::ledger::sha256_hex;

/// The declared verification scope: what "the same subject/predicate/scope"
/// means for one R7 evaluation. Declared by the caller, hashed into the
/// input snapshot, and carried in the payload so the evaluation names what
/// it was scoped to.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VerificationScope {
    /// Resolved entity ids, sorted and duplicate-free.
    pub subjects: Vec<String>,
    /// Predicate classes as the freshness artifact names them, sorted and
    /// duplicate-free.
    pub predicate_classes: Vec<String>,
    pub stage: Option<String>,
    pub environment: Option<String>,
    pub geography: Option<String>,
}

impl VerificationScope {
    pub fn validate(&self) -> Result<(), String> {
        for (name, list) in [
            ("subjects", &self.subjects),
            ("predicate_classes", &self.predicate_classes),
        ] {
            if list.is_empty() {
                return Err(format!(
                    "a verification scope with no {name} verifies nothing — refusing beats \
                     counting everything"
                ));
            }
            for pair in list.windows(2) {
                if pair[0] >= pair[1] {
                    return Err(format!("{name} must be sorted and duplicate-free"));
                }
            }
        }
        for (name, value) in [
            ("stage", &self.stage),
            ("environment", &self.environment),
            ("geography", &self.geography),
        ] {
            if value.as_deref() == Some("") {
                return Err(format!(
                    "an empty {name} constraint is a constraint on nothing"
                ));
            }
        }
        Ok(())
    }

    /// The canonical digest the evaluation's snapshot declares. Domain
    /// separated and over the canonical serialization, so two scopes that
    /// mean the same thing cannot hash apart and two that differ cannot
    /// collide.
    pub fn digest(&self) -> Result<String, String> {
        let canonical =
            serde_json::to_string(self).map_err(|e| format!("canonicalizing scope: {e}"))?;
        Ok(sha256_hex(
            format!("cerebro-verification-scope-v1\0{canonical}").as_bytes(),
        ))
    }
}

/// One M25 cache row, as the join sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CacheRegistration {
    pub registration_event_id: String,
    pub kind: String,
}

/// Distinct qualifying Observation event ids per source id.
pub fn qualifying_observations(
    state: &EpistemicState,
    scope: &VerificationScope,
    rules: &freshness::Rules,
    cache: &BTreeMap<String, CacheRegistration>,
    window_start: chrono::DateTime<chrono::Utc>,
    window_end: chrono::DateTime<chrono::Utc>,
) -> Result<BTreeMap<String, BTreeSet<String>>, String> {
    scope.validate()?;
    let mut out: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for (event_id, observation) in &state.observations {
        // The join: a cache row for the source, connector-kind, agreeing
        // with the ledger's CURRENT registration, and the observation pinned
        // to exactly that registration. A source failing any of these
        // contributes nothing, however many observations it made.
        let Some(row) = cache.get(&observation.source_id) else {
            continue;
        };
        if row.kind != "connector" {
            continue;
        }
        let current = state
            .sources
            .get(&observation.source_id)
            .map(|s| s.registration_event_id.as_str());
        if current != Some(row.registration_event_id.as_str()) {
            continue; // orphaned or stale cache row
        }
        if observation.source_registration_event_id != row.registration_event_id {
            continue; // pinned registration differs from the joined one
        }

        // Assertion-bearing about the world: snapshots are bytes, system
        // events are operations, derived content is the base's own output.
        if !matches!(
            observation.kind,
            ObservationKind::ExtractedAssertion | ObservationKind::HumanAssertion
        ) {
            continue;
        }
        // D11's metadata: the basis on the observation, the relationship and
        // scope on the indexed facet. No facet means the assertion never
        // indexed — nothing to match a scope against.
        if observation.assertion_basis.is_none() {
            continue;
        }
        let Some(facet) = state.assertion_facets.get(event_id) else {
            continue;
        };

        // A declared, currently-attached subject.
        let attached = observation
            .effective_entity
            .as_deref()
            .is_some_and(|entity| scope.subjects.iter().any(|s| s == entity));
        if !attached {
            continue;
        }

        // The predicate's CLASS, through the one predicate→class authority.
        // A predicate no rule classifies has no class and cannot match a
        // class-scoped question.
        let class = rules
            .rule_for(Some(facet.predicate.as_str()))
            .map(|rule| rule.predicate_class.as_str());
        if !class.is_some_and(|c| scope.predicate_classes.iter().any(|declared| declared == c)) {
            continue;
        }

        // Every declared constraint must be CLAIMED, not merely not
        // contradicted.
        let stage = facet
            .scope
            .stage
            .as_ref()
            .and_then(|s| serde_json::to_value(s).ok())
            .and_then(|v| v.as_str().map(String::from));
        let constraints = [
            (&scope.stage, stage),
            (&scope.environment, facet.scope.environment.clone()),
            (&scope.geography, facet.scope.geography.clone()),
        ];
        if constraints
            .iter()
            .any(|(declared, actual)| declared.is_some() && **declared != *actual)
        {
            continue;
        }

        // Inside the window, by the store's own stamp.
        let recorded = chrono::DateTime::parse_from_rfc3339(&facet.recorded_at)
            .map_err(|e| format!("facet {event_id} recorded_at {:?}: {e}", facet.recorded_at))?
            .with_timezone(&chrono::Utc);
        if recorded < window_start || recorded >= window_end {
            continue;
        }

        out.entry(observation.source_id.clone())
            .or_default()
            .insert(event_id.clone());
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ledger::reduce::{AssertionFacet, ObservationState, SourceState};
    use crate::ledger::schema::{
        AssertionBasis, AuthorityCapability, Scope, SourceRegistration, Stage, SubjectRef,
        TypedValue, ValidInterval,
    };

    const SOURCE_A: &str = "50000000000000000000000000000001";
    const REG_A: &str = "60000000000000000000000000000001";
    const FALCON: &str = "e0000000000000000000000000000001";
    const KESTREL: &str = "e0000000000000000000000000000002";
    const IN_WINDOW: &str = "2026-08-01T10:00:00.000Z";

    fn window() -> (chrono::DateTime<chrono::Utc>, chrono::DateTime<chrono::Utc>) {
        let parse = |s: &str| {
            chrono::DateTime::parse_from_rfc3339(s)
                .unwrap()
                .with_timezone(&chrono::Utc)
        };
        (parse("2026-07-15T00:00:00Z"), parse("2026-08-14T00:00:00Z"))
    }

    fn declared() -> VerificationScope {
        VerificationScope {
            subjects: vec![FALCON.to_string()],
            predicate_classes: vec!["ci_status".to_string()],
            stage: None,
            environment: None,
            geography: None,
        }
    }

    fn source_state(source_id: &str, registration_event_id: &str) -> SourceState {
        SourceState {
            source_id: source_id.to_string(),
            registration_event_id: registration_event_id.to_string(),
            registration: SourceRegistration::Connector {
                source_key: "connector:test".into(),
                connector_instance_id: "ci".into(),
                logical_scope_id: "repo".into(),
                authority_capability: AuthorityCapability::DirectSystemArtifact,
                independence_domain_id: None,
            },
            canonical: "{}".into(),
        }
    }

    fn observation(event_id: &str, source_id: &str, registration: &str) -> ObservationState {
        ObservationState {
            event_id: event_id.to_string(),
            seq: 1,
            kind: ObservationKind::ExtractedAssertion,
            source_id: source_id.to_string(),
            source_registration_event_id: registration.to_string(),
            subject: SubjectRef::Resolved {
                entity_id: FALCON.into(),
                aliases: vec![],
            },
            effective_entity: Some(FALCON.into()),
            effective_resolution_event: None,
            authority: None,
            assertion_basis: Some(AssertionBasis::Firsthand),
            absence: None,
            actor: "system:connector".into(),
            lineage_parents: vec![],
        }
    }

    fn facet(predicate: &str, recorded_at: &str) -> AssertionFacet {
        AssertionFacet {
            predicate: predicate.to_string(),
            value_hash: "f".repeat(64),
            value: TypedValue::string("green"),
            scope: Scope::empty(),
            valid_time: ValidInterval {
                from: None,
                to: None,
            },
            recorded_at: recorded_at.to_string(),
            observed_at: None,
            relationship_role: crate::ledger::schema::SubjectRole::Unknown,
            source_artifact_hash: Some("a".repeat(64)),
            raw_pointer: Some("repo/ci.json#L1".into()),
        }
    }

    /// One qualifying observation. Every exclusion test takes THIS state and
    /// changes exactly one property — a fixture where the compared things
    /// are equal tests nothing about the comparison.
    fn base() -> EpistemicState {
        let mut state = EpistemicState::default();
        state
            .sources
            .insert(SOURCE_A.into(), source_state(SOURCE_A, REG_A));
        let obs = "20000000000000000000000000000001";
        state
            .observations
            .insert(obs.into(), observation(obs, SOURCE_A, REG_A));
        state
            .assertion_facets
            .insert(obs.into(), facet("ci_status", IN_WINDOW));
        state
    }

    fn cache() -> BTreeMap<String, CacheRegistration> {
        BTreeMap::from([(
            SOURCE_A.to_string(),
            CacheRegistration {
                registration_event_id: REG_A.to_string(),
                kind: "connector".to_string(),
            },
        )])
    }

    fn qualify(state: &EpistemicState) -> BTreeMap<String, BTreeSet<String>> {
        let (start, end) = window();
        qualifying_observations(
            state,
            &declared(),
            &freshness::load().unwrap(),
            &cache(),
            start,
            end,
        )
        .unwrap()
    }

    #[test]
    fn the_qualifying_observation_qualifies() {
        let counted = qualify(&base());
        assert_eq!(counted.get(SOURCE_A).map(BTreeSet::len), Some(1));
    }

    #[test]
    fn every_exclusion_excludes_on_its_own() {
        type Mutation = Box<dyn Fn(&mut EpistemicState)>;
        let mutations: Vec<(&str, Mutation)> = vec![
            (
                "a snapshot is bytes, not a claim",
                Box::new(|s: &mut EpistemicState| {
                    s.observations.get_mut(&obs()).unwrap().kind = ObservationKind::SourceSnapshot;
                }),
            ),
            (
                "derived content is the base talking to itself",
                Box::new(|s| {
                    s.observations.get_mut(&obs()).unwrap().kind = ObservationKind::DerivedContent;
                }),
            ),
            (
                "an undeclared subject is out of scope",
                Box::new(|s| {
                    s.observations.get_mut(&obs()).unwrap().effective_entity = Some(KESTREL.into());
                }),
            ),
            (
                "a detached observation claims nobody",
                Box::new(|s| {
                    s.observations.get_mut(&obs()).unwrap().effective_entity = None;
                }),
            ),
            (
                "no assertion basis is no D11 metadata",
                Box::new(|s| {
                    s.observations.get_mut(&obs()).unwrap().assertion_basis = None;
                }),
            ),
            (
                "an unindexed assertion has no facet to match",
                Box::new(|s| {
                    s.assertion_facets.remove(&obs());
                }),
            ),
            (
                "a declared class the predicate is not in",
                Box::new(|s| {
                    s.assertion_facets.get_mut(&obs()).unwrap().predicate =
                        "charter_rationale".into();
                }),
            ),
            (
                "a predicate no rule classifies has no class",
                Box::new(|s| {
                    s.assertion_facets.get_mut(&obs()).unwrap().predicate = "vibes".into();
                }),
            ),
            (
                "recorded before the window",
                Box::new(|s| {
                    s.assertion_facets.get_mut(&obs()).unwrap().recorded_at =
                        "2026-07-14T23:59:59.000Z".into();
                }),
            ),
            (
                "recorded at the window's exclusive end",
                Box::new(|s| {
                    s.assertion_facets.get_mut(&obs()).unwrap().recorded_at =
                        "2026-08-14T00:00:00.000Z".into();
                }),
            ),
            (
                "pinned to a registration the cache row does not name",
                Box::new(|s| {
                    s.observations
                        .get_mut(&obs())
                        .unwrap()
                        .source_registration_event_id = "60000000000000000000000000000009".into();
                }),
            ),
            (
                "a stale cache row disqualifies its whole source",
                Box::new(|s| {
                    s.sources.get_mut(SOURCE_A).unwrap().registration_event_id =
                        "60000000000000000000000000000009".into();
                }),
            ),
        ];
        fn obs() -> String {
            "20000000000000000000000000000001".to_string()
        }
        for (why, mutate) in mutations {
            let mut state = base();
            mutate(&mut state);
            let counted = qualify(&state);
            assert!(
                counted.get(SOURCE_A).is_none_or(BTreeSet::is_empty),
                "{why}: the observation still counted"
            );
        }
    }

    #[test]
    fn a_non_connector_cache_row_contributes_nothing() {
        let state = base();
        let (start, end) = window();
        let mut human = cache();
        human.get_mut(SOURCE_A).unwrap().kind = "human_actor".into();
        let counted = qualifying_observations(
            &state,
            &declared(),
            &freshness::load().unwrap(),
            &human,
            start,
            end,
        )
        .unwrap();
        assert!(counted.is_empty());
        // And an entirely uncached source is the orphan case.
        let counted = qualifying_observations(
            &state,
            &declared(),
            &freshness::load().unwrap(),
            &BTreeMap::new(),
            start,
            end,
        )
        .unwrap();
        assert!(counted.is_empty());
    }

    #[test]
    fn a_constrained_axis_must_be_claimed_not_merely_not_contradicted() {
        let mut scope = declared();
        scope.stage = Some("implemented".into());
        let (start, end) = window();
        let rules = freshness::load().unwrap();

        // Silent about stage: does not count against a stage-constrained
        // question.
        let silent = base();
        let counted =
            qualifying_observations(&silent, &scope, &rules, &cache(), start, end).unwrap();
        assert!(
            counted.is_empty(),
            "silence about the slice is not a claim about it"
        );

        // Claiming the constrained stage: counts.
        let mut claiming = base();
        claiming
            .assertion_facets
            .get_mut("20000000000000000000000000000001")
            .unwrap()
            .scope
            .stage = Some(Stage::Implemented);
        let counted =
            qualifying_observations(&claiming, &scope, &rules, &cache(), start, end).unwrap();
        assert_eq!(counted.get(SOURCE_A).map(BTreeSet::len), Some(1));

        // Claiming a DIFFERENT stage: excluded.
        let mut other = claiming.clone();
        other
            .assertion_facets
            .get_mut("20000000000000000000000000000001")
            .unwrap()
            .scope
            .stage = Some(Stage::Planned);
        let counted =
            qualifying_observations(&other, &scope, &rules, &cache(), start, end).unwrap();
        assert!(counted.is_empty());
    }

    #[test]
    fn the_scope_digest_is_canonical_and_content_sensitive() {
        let scope = declared();
        assert_eq!(scope.digest().unwrap(), declared().digest().unwrap());
        let mut widened = declared();
        widened.predicate_classes = vec!["ci_status".into(), "shipping_bom".into()];
        assert_ne!(scope.digest().unwrap(), widened.digest().unwrap());

        let mut unsorted = declared();
        unsorted.subjects = vec![KESTREL.into(), FALCON.into()];
        assert!(unsorted.validate().is_err(), "unsorted subjects refuse");
        let mut empty = declared();
        empty.predicate_classes.clear();
        assert!(empty.validate().is_err(), "a scope over nothing refuses");
    }

    #[test]
    fn nothing_here_reads_a_clock() {
        let source = include_str!("observations.rs");
        let body = source
            .split("#[cfg(test)]")
            .next()
            .expect("the non-test half");
        for forbidden in ["Utc::now", "SystemTime", "Local::now"] {
            assert!(
                !body.contains(forbidden),
                "{forbidden:?} appears in the extractor"
            );
        }
    }
}
