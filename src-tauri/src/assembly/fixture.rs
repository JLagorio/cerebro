//! The assembler's shared fixture (M26.5e).
//!
//! Lives in its own module rather than inside `assemble`'s test block because
//! four modules now build against it — the assembler, the prompt, the attended
//! pass, and the MCP submit tool — and a fixture reachable only through one
//! module's private tests is a fixture the other three would each copy. Four
//! copies of "the base" is four bases that drift.
//!
//! **One Falcon cutover the base disagrees with itself about**: two live
//! beliefs joined by a live `contradicts` edge, an earlier revision of one of
//! them, one authoritative assertion, one the agent merely inferred, one claim
//! about the PLANNED stage (a scope-neighbour to a shipping question), and one
//! neighbour a `refines` edge away.

#![cfg(test)]

use crate::ledger::reduce::{
    AliasState, BeliefState, EpistemicState, ObservationState, RelationState, RevisionState,
};
use crate::ledger::schema::{
    normalize_alias_v1, AssertionBasis, AuthorityProvenance, BasisLink, BasisRole, BeliefBasis,
    IntendedUseKind, Lifecycle, ObservationKind, Qualification, RelationKind, Risk, Scope, Stage,
    SubjectRef,
};

use super::assemble::{assemble, Assembly, Expansion, Request};
use super::corpus::Corpus;
use super::manifest::{Limits, QueryIntendedUse};

pub(crate) const FALCON: &str = "e0000000000000000000000000000001";
pub(crate) const KESTREL: &str = "e0000000000000000000000000000002";
pub(crate) const B_ONE: &str = "b0000000000000000000000000000001";
pub(crate) const B_TWO: &str = "b0000000000000000000000000000002";
pub(crate) const B_KESTREL: &str = "b0000000000000000000000000000003";
pub(crate) const REV_ONE_OLD: &str = "10000000000000000000000000000001";
pub(crate) const REV_ONE: &str = "10000000000000000000000000000002";
pub(crate) const REV_TWO: &str = "10000000000000000000000000000003";
pub(crate) const REV_KESTREL: &str = "10000000000000000000000000000004";
pub(crate) const OBS_AUTHORITY: &str = "20000000000000000000000000000001";
pub(crate) const OBS_INFERRED: &str = "20000000000000000000000000000002";
pub(crate) const OBS_PLANNED: &str = "20000000000000000000000000000003";
pub(crate) const SOURCE_A: &str = "50000000000000000000000000000001";
pub(crate) const SOURCE_B: &str = "50000000000000000000000000000002";
pub(crate) const SOURCE_C: &str = "50000000000000000000000000000003";
pub(crate) const REG: &str = "60000000000000000000000000000001";
pub(crate) const HEAD: &str = "90000000000000000000000000000001";
pub(crate) const STORE: &str = "cafebabecafebabecafebabecafebabe";

pub(crate) fn revision(
    revision: u64,
    event_id: &str,
    content: &str,
    basis: BeliefBasis,
) -> RevisionState {
    RevisionState {
        revision,
        event_id: event_id.to_string(),
        content: content.to_string(),
        fields: serde_json::json!({}),
        basis,
    }
}

pub(crate) fn unsupported() -> BeliefBasis {
    BeliefBasis::Unsupported {
        reason: "nobody wrote down where this came from".into(),
    }
}

pub(crate) fn linked(observations: &[&str]) -> BeliefBasis {
    BeliefBasis::Linked {
        links: observations
            .iter()
            .map(|id| BasisLink {
                observation_event_id: (*id).to_string(),
                role: BasisRole::Supports,
            })
            .collect(),
    }
}

pub(crate) fn belief(id: &str, entity: &str, revisions: Vec<RevisionState>) -> BeliefState {
    BeliefState {
        belief_id: id.to_string(),
        entity_id: entity.to_string(),
        created_event_id: revisions[0].event_id.clone(),
        projection_head_event: revisions[revisions.len() - 1].event_id.clone(),
        revisions,
        attested: None,
        attestation_events: vec![],
        path: None,
        overrides: vec![],
        override_head_event: None,
        qualification: Qualification::Draft,
        lifecycle: Lifecycle::Active,
        tombstoned_by: None,
        open_contest_event: None,
        qualification_head_event: None,
        contest_head_event: None,
        lifecycle_head_event: None,
        entity_merge_event_ids: vec![],
    }
}

pub(crate) fn observation(
    event_id: &str,
    entity: &str,
    source: &str,
    authority: AuthorityProvenance,
) -> ObservationState {
    ObservationState {
        event_id: event_id.to_string(),
        seq: 1,
        kind: ObservationKind::ExtractedAssertion,
        source_id: source.to_string(),
        source_registration_event_id: REG.to_string(),
        subject: SubjectRef::Resolved {
            entity_id: entity.to_string(),
            aliases: vec![],
        },
        effective_entity: Some(entity.to_string()),
        effective_resolution_event: None,
        authority: Some(authority),
        assertion_basis: Some(AssertionBasis::Firsthand),
        absence: None,
        actor: "system:test".into(),
        lineage_parents: vec![],
    }
}

pub(crate) fn assertion(event_id: &str, statement: &str, scope: Scope) -> super::corpus::Assertion {
    super::corpus::Assertion {
        event_id: event_id.to_string(),
        statement: statement.to_string(),
        scope,
        valid_from: None,
        valid_to: None,
    }
}

pub(crate) fn planned() -> Scope {
    Scope {
        stage: Some(Stage::Planned),
        revision: None,
        environment: None,
        geography: None,
    }
}

pub(crate) fn shipping() -> Scope {
    Scope {
        stage: Some(Stage::Shipping),
        revision: None,
        environment: None,
        geography: None,
    }
}

/// One Falcon cutover the base disagrees with itself about, one earlier
/// revision of that disagreement, one authoritative assertion, one the
/// agent merely inferred, one claim about the PLANNED stage, and one
/// neighbour a `refines` edge away.
pub(crate) fn state() -> EpistemicState {
    let mut state = EpistemicState::default();
    for (alias, entity) in [("Falcon", FALCON), ("Kestrel", KESTREL)] {
        state.alias_registry.insert(
            normalize_alias_v1(alias),
            AliasState {
                normalized: normalize_alias_v1(alias),
                alias: alias.to_string(),
                entity_id: entity.to_string(),
                event_id: REG.to_string(),
            },
        );
    }
    state.beliefs.insert(
        B_ONE.into(),
        belief(
            B_ONE,
            FALCON,
            vec![
                revision(
                    1,
                    REV_ONE_OLD,
                    "the cutover was on track in June",
                    unsupported(),
                ),
                revision(
                    2,
                    REV_ONE,
                    "the cutover is on track",
                    linked(&[OBS_AUTHORITY, OBS_INFERRED]),
                ),
            ],
        ),
    );
    state.beliefs.insert(
        B_TWO.into(),
        belief(
            B_TWO,
            FALCON,
            vec![revision(
                1,
                REV_TWO,
                "the cutover slipped a week",
                unsupported(),
            )],
        ),
    );
    state.beliefs.insert(
        B_KESTREL.into(),
        belief(
            B_KESTREL,
            KESTREL,
            vec![revision(
                1,
                REV_KESTREL,
                "Kestrel ships after Falcon",
                unsupported(),
            )],
        ),
    );
    relate(
        &mut state,
        "r1",
        B_ONE,
        B_TWO,
        RelationKind::Contradicts,
        true,
    );
    relate(
        &mut state,
        "r2",
        B_ONE,
        B_KESTREL,
        RelationKind::Refines,
        true,
    );
    for (event, source, authority) in [
        (
            OBS_AUTHORITY,
            SOURCE_A,
            AuthorityProvenance::RegisteredDirectArtifact,
        ),
        (OBS_INFERRED, SOURCE_B, AuthorityProvenance::AgentInferred),
        (
            OBS_PLANNED,
            SOURCE_C,
            AuthorityProvenance::RegisteredDirectArtifact,
        ),
    ] {
        state
            .observations
            .insert(event.into(), observation(event, FALCON, source, authority));
    }
    state
}

pub(crate) fn relate(
    state: &mut EpistemicState,
    id: &str,
    from: &str,
    to: &str,
    relation: RelationKind,
    live: bool,
) {
    state.relations.insert(
        id.into(),
        RelationState {
            relation_id: id.into(),
            from: from.into(),
            to: to.into(),
            relation,
            live,
            last_add_event_id: REG.into(),
            last_event_id: REG.into(),
        },
    );
}

pub(crate) fn corpus() -> Corpus {
    let mut corpus = Corpus::default();
    corpus.insert(assertion(
        OBS_AUTHORITY,
        "cutover_status: on track",
        shipping(),
    ));
    corpus.insert(assertion(OBS_INFERRED, "cutover_risk: low", shipping()));
    corpus.insert(assertion(
        OBS_PLANNED,
        "cutover_status: not started",
        planned(),
    ));
    corpus
}

pub(crate) fn limits(sources: u64, bytes: u64, items: u64) -> Limits {
    Limits {
        max_sources_per_run: sources,
        max_context_bytes: bytes,
        max_evidence_items: items,
    }
}

pub(crate) fn request<'a>(scope: Scope, limits: Limits) -> Request<'a> {
    Request {
        store_uuid: STORE,
        chain_head: HEAD,
        question: "Is the Falcon cutover on track?",
        aliases: &[],
        scope,
        intended_use: QueryIntendedUse {
            kind: IntendedUseKind::OperationalDecision,
            stakes: Risk::Medium,
            predicate_class: None,
            description: "whether to hold the release meeting".into(),
        },
        limits,
    }
}

/// Generous caps: nothing is refused, so a test can look at what the
/// intents FOUND rather than at what the caps did.
pub(crate) fn wide() -> Limits {
    limits(10, 100_000, 100)
}

pub(crate) fn assembled(request: &Request<'_>) -> Assembly {
    assemble(&state(), &corpus(), &Expansion, request).expect("a manifest")
}
