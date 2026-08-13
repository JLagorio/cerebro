//! `shared/policy/authority-routes.v1.json` — predicate- and stage-specific
//! authority routes (D11), plus their immutable content-addressed snapshots
//! (M24.1).
//!
//! Authority is never a universal rank. A route says: *for this class of
//! claim, at these stages of reality, these are the ways an Observation can
//! carry authority.* The project lead is near-top authority for intent; the
//! manufacturing manifest outranks them for what shipped yesterday.
//!
//! Two things make a route usable as proof rather than as a label:
//!
//! - every criterion pins the M22 **registration** shape, not the display
//!   metadata. `agent_inferred` content can claim `role: project_owner` all
//!   day; it satisfies no route, because the route demands a `human_actor`
//!   registration bound to the capture actor with `trusted_human_capture`
//!   provenance;
//! - routes are **versioned and content-addressed**. A queued proposal pins
//!   `(route_id, rule_version, artifact_hash)`; editing the artifact bumps
//!   versions and leaves the prior snapshot loadable, so an approval that
//!   happens tomorrow is still evaluated against the rule the agent was
//!   actually shown — and a route edit under a queued proposal surfaces as
//!   `policy_precondition_stale` instead of silently re-deciding it.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

pub const AUTHORITY_ROUTES_V1_JSON: &str =
    include_str!("../../../shared/policy/authority-routes.v1.json");

pub const AUTHORITY_ROUTES_V1_PATH: &str = "shared/policy/authority-routes.v1.json";

/// Directory of immutable released snapshots, one file per artifact hash.
pub const SNAPSHOT_DIR: &str = "shared/policy/authority-routes";

/// Every artifact this build can resolve a pinned ref against: the current
/// one, then each superseded snapshot. At v1 the current artifact is the
/// only release; a v2 edit adds one `include_str!` line here and keeps the
/// v1 bytes resolvable forever. `snapshots_on_disk_are_all_compiled_in`
/// fails the build's tests if a released snapshot is ever left out.
pub const RESOLVABLE_ARTIFACTS: &[&str] = &[AUTHORITY_ROUTES_V1_JSON];

pub const FORMAT: u64 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RouteStage {
    Planned,
    Approved,
    Implemented,
    Validated,
    Deployed,
    Shipping,
    /// The Observation's `scope.stage` is absent. M22's `Stage` enum has no
    /// such variant on purpose — a missing stage is missing, not a sixth
    /// stage — so the route vocabulary carries the match token instead.
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RouteObservationKind {
    ExtractedAssertion,
    HumanAssertion,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RouteRegistrationKind {
    Builtin,
    Connector,
    HumanActor,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RouteCapability {
    DirectSystemArtifact,
    HumanAssertion,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RouteRole {
    ProjectOwner,
    TeamMember,
    Adjacent,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RouteBasis {
    Firsthand,
    ResponsibleOwner,
    Reported,
    Inferred,
    Unknown,
}

/// The closed criterion union. Each variant's `observation_kind` is fixed
/// by its class and re-stated in the artifact so a reader never has to know
/// the code to audit the rule; load refuses a mismatch.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[serde(deny_unknown_fields)]
pub enum Criterion {
    DirectArtifact {
        observation_kind: RouteObservationKind,
        registration_kinds: Vec<RouteRegistrationKind>,
        authority_capability: RouteCapability,
        require_source_artifact_hash: bool,
        require_raw_pointer: bool,
    },
    ResponsibleOwnerFirsthand {
        observation_kind: RouteObservationKind,
        registration_kind: RouteRegistrationKind,
        authority_capability: RouteCapability,
        relationship_roles: Vec<RouteRole>,
        assertion_bases: Vec<RouteBasis>,
    },
    FirsthandObserver {
        observation_kind: RouteObservationKind,
        registration_kind: RouteRegistrationKind,
        authority_capability: RouteCapability,
        relationship_roles: Vec<RouteRole>,
        assertion_bases: Vec<RouteBasis>,
    },
}

impl Criterion {
    fn class(&self) -> &'static str {
        match self {
            Criterion::DirectArtifact { .. } => "direct_artifact",
            Criterion::ResponsibleOwnerFirsthand { .. } => "responsible_owner_firsthand",
            Criterion::FirsthandObserver { .. } => "firsthand_observer",
        }
    }

    /// The observation kind and capability the class REQUIRES. Stated once,
    /// here, and checked against the artifact — the artifact may not invent
    /// a human-authored `direct_artifact`.
    fn fixed(&self) -> (RouteObservationKind, RouteCapability) {
        match self {
            Criterion::DirectArtifact { .. } => (
                RouteObservationKind::ExtractedAssertion,
                RouteCapability::DirectSystemArtifact,
            ),
            Criterion::ResponsibleOwnerFirsthand { .. } | Criterion::FirsthandObserver { .. } => (
                RouteObservationKind::HumanAssertion,
                RouteCapability::HumanAssertion,
            ),
        }
    }

    fn declared(&self) -> (RouteObservationKind, RouteCapability) {
        match self {
            Criterion::DirectArtifact {
                observation_kind,
                authority_capability,
                ..
            }
            | Criterion::ResponsibleOwnerFirsthand {
                observation_kind,
                authority_capability,
                ..
            }
            | Criterion::FirsthandObserver {
                observation_kind,
                authority_capability,
                ..
            } => (*observation_kind, *authority_capability),
        }
    }

    fn validate(&self, label: &str) -> Result<(), String> {
        let (kind, capability) = self.fixed();
        let (declared_kind, declared_capability) = self.declared();
        if declared_kind != kind {
            return Err(format!(
                "{label}: {} fixes observation_kind {kind:?}, artifact says {declared_kind:?}",
                self.class()
            ));
        }
        if declared_capability != capability {
            return Err(format!(
                "{label}: {} fixes authority_capability {capability:?}, artifact says \
                 {declared_capability:?}",
                self.class()
            ));
        }
        match self {
            Criterion::DirectArtifact {
                registration_kinds,
                require_source_artifact_hash,
                require_raw_pointer,
                ..
            } => {
                sorted_unique_non_empty(
                    &format!("{label}.registration_kinds"),
                    registration_kinds,
                )?;
                if registration_kinds.contains(&RouteRegistrationKind::HumanActor) {
                    return Err(format!(
                        "{label}: a human actor cannot satisfy a direct-artifact route"
                    ));
                }
                // The M22 artifact hash and raw pointer are what make the
                // claim checkable against the artifact itself. A route that
                // waived them would be authority by assertion.
                if !require_source_artifact_hash || !require_raw_pointer {
                    return Err(format!(
                        "{label}: a direct-artifact route must require both the source artifact \
                         hash and the raw pointer"
                    ));
                }
            }
            Criterion::ResponsibleOwnerFirsthand {
                registration_kind,
                relationship_roles,
                assertion_bases,
                ..
            }
            | Criterion::FirsthandObserver {
                registration_kind,
                relationship_roles,
                assertion_bases,
                ..
            } => {
                if *registration_kind != RouteRegistrationKind::HumanActor {
                    return Err(format!(
                        "{label}: a human route requires a human_actor registration"
                    ));
                }
                sorted_unique_non_empty(
                    &format!("{label}.relationship_roles"),
                    relationship_roles,
                )?;
                sorted_unique_non_empty(&format!("{label}.assertion_bases"), assertion_bases)?;
                // `unknown` on either axis is the absence of a claim. A route
                // that accepted it would grant authority for not answering.
                if relationship_roles.contains(&RouteRole::Unknown) {
                    return Err(format!(
                        "{label}: relationship role `unknown` proves nothing"
                    ));
                }
                for basis in [
                    RouteBasis::Unknown,
                    RouteBasis::Inferred,
                    RouteBasis::Reported,
                ] {
                    if assertion_bases.contains(&basis) {
                        return Err(format!(
                            "{label}: assertion basis {basis:?} is not a firsthand-class basis"
                        ));
                    }
                }
            }
        }
        Ok(())
    }
}

/// Non-empty, duplicate-free, and in CANONICAL order — which for a route's
/// vocabularies is the enum's DECLARATION order, not alphabetical:
/// `planned … shipping` reads as reality moving forward, and
/// `project_owner … unknown` as authority descending. Canonical order is
/// what makes two artifacts that mean the same thing hash the same.
fn sorted_unique_non_empty<T: Ord + std::fmt::Debug + Clone>(
    label: &str,
    items: &[T],
) -> Result<(), String> {
    if items.is_empty() {
        return Err(format!("{label} is empty"));
    }
    let mut sorted = items.to_vec();
    sorted.sort();
    sorted.dedup();
    if sorted.len() != items.len() {
        return Err(format!("{label} repeats a value"));
    }
    if sorted.as_slice() != items {
        return Err(format!(
            "{label} is not in canonical (declaration) order — expected {sorted:?}"
        ));
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AuthorityRoute {
    pub authority_route_id: String,
    pub authority_rule_version: u64,
    pub predicate_classes: Vec<String>,
    pub state_stages: Vec<RouteStage>,
    pub criteria: Vec<Criterion>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AuthorityRoutesV1 {
    pub format: u64,
    pub artifact_version: u64,
    pub routes: Vec<AuthorityRoute>,
}

/// A proposal's pinned reference into the immutable artifact set.
///
/// RE-EXPORTED, not redeclared: this shape is persisted inside
/// `ProposalBasis`, so a second copy here could drift from bytes already on
/// disk — the same reasoning that keeps `Risk` in the ledger schema.
pub use crate::ledger::schema::AuthorityRouteRef;

impl AuthorityRoutesV1 {
    pub fn load() -> Result<AuthorityRoutesV1, String> {
        Self::parse(AUTHORITY_ROUTES_V1_JSON)
    }

    pub fn parse(raw: &str) -> Result<AuthorityRoutesV1, String> {
        let artifact: AuthorityRoutesV1 =
            serde_json::from_str(raw).map_err(|e| format!("{AUTHORITY_ROUTES_V1_PATH}: {e}"))?;
        artifact.validate()?;
        Ok(artifact)
    }

    /// Canonical bytes: the M21 serializer over the parsed struct, so file
    /// formatting (prettier, an editor's trailing newline) can never move
    /// the hash. This is what a snapshot file contains, verbatim.
    pub fn canonical(&self) -> String {
        serde_json::to_string(self).expect("authority routes serialize")
    }

    pub fn artifact_hash(&self) -> String {
        crate::ledger::sha256_hex(self.canonical().as_bytes())
    }

    fn validate(&self) -> Result<(), String> {
        if self.format != FORMAT {
            return Err(format!(
                "{AUTHORITY_ROUTES_V1_PATH}: unsupported format {}",
                self.format
            ));
        }
        if self.artifact_version == 0 {
            return Err(format!(
                "{AUTHORITY_ROUTES_V1_PATH}: artifact_version must be positive"
            ));
        }
        if self.routes.is_empty() {
            return Err(format!("{AUTHORITY_ROUTES_V1_PATH}: no routes"));
        }
        let mut identities = BTreeSet::new();
        let mut applicability: BTreeMap<(String, RouteStage), String> = BTreeMap::new();
        let mut previous: Option<&str> = None;
        for route in &self.routes {
            let label = format!("route {}", route.authority_route_id);
            if route.authority_route_id.is_empty() {
                return Err(format!(
                    "{AUTHORITY_ROUTES_V1_PATH}: empty authority_route_id"
                ));
            }
            if let Some(prior) = previous {
                if prior >= route.authority_route_id.as_str() {
                    return Err(format!(
                        "{AUTHORITY_ROUTES_V1_PATH}: routes are not sorted by id ({prior} then {})",
                        route.authority_route_id
                    ));
                }
            }
            previous = Some(&route.authority_route_id);
            if route.authority_rule_version == 0 {
                return Err(format!("{label}: authority_rule_version must be positive"));
            }
            if !identities.insert((
                route.authority_route_id.clone(),
                route.authority_rule_version,
            )) {
                return Err(format!("{label}: duplicate (id, rule_version)"));
            }
            sorted_unique_non_empty(
                &format!("{label}.predicate_classes"),
                &route.predicate_classes,
            )?;
            if route.predicate_classes.iter().any(String::is_empty) {
                return Err(format!("{label}: empty predicate class"));
            }
            sorted_unique_non_empty(&format!("{label}.state_stages"), &route.state_stages)?;
            if route.criteria.is_empty() {
                return Err(format!(
                    "{label}: no criteria — a route that proves nothing"
                ));
            }
            let mut classes = BTreeSet::new();
            for criterion in &route.criteria {
                if !classes.insert(criterion.class()) {
                    return Err(format!(
                        "{label}: two {} criteria — a class appears at most once",
                        criterion.class()
                    ));
                }
                criterion.validate(&label)?;
            }
            // Duplicate applicability would make "which rule applied?"
            // ambiguous, and an ambiguous authority rule is not a rule.
            for class in &route.predicate_classes {
                for stage in &route.state_stages {
                    if let Some(other) = applicability
                        .insert((class.clone(), *stage), route.authority_route_id.clone())
                    {
                        return Err(format!(
                            "{label}: predicate class {class:?} at stage {stage:?} is already \
                             routed by {other}"
                        ));
                    }
                }
            }
        }
        Ok(())
    }

    /// Resolve a pinned ref. Every leg must match: an ID that exists at a
    /// different rule version, or at a different artifact hash, is a MISS —
    /// that is the whole point of pinning all three.
    pub fn resolve<'a>(
        artifacts: &'a [AuthorityRoutesV1],
        reference: &AuthorityRouteRef,
    ) -> Option<&'a AuthorityRoute> {
        artifacts
            .iter()
            .filter(|artifact| artifact.artifact_hash() == reference.artifact_hash)
            .flat_map(|artifact| artifact.routes.iter())
            .find(|route| {
                route.authority_route_id == reference.authority_route_id
                    && route.authority_rule_version == reference.authority_rule_version
            })
    }
}

/// Does this Observation satisfy this criterion? (M27.2b)
///
/// **Every leg is read from the ledger, never from the proposal.** An agent's
/// claim that its own assertion is firsthand is a claim, and D11 is the rule
/// that it never becomes proof. The order matters: registration first, then
/// derived provenance, and only THEN the payload's own tags — because
/// `relationship_to_subject.role` is trustworthy exactly when the store has
/// already established that this actor is the registered human the source is
/// bound to. On an `agent_inferred` observation the identical field proves
/// nothing, and the arms below never reach it.
///
/// **This is the ONE evaluator.** M24's high-stakes rule
/// ([`super::coverage::high_stakes`]) called a private copy of it until M27.2;
/// two readings of one artifact are two rules, and they drift on exactly the
/// criteria nobody exercises.
///
/// **The two M25 edges are closed here, and it is a behaviour change worth
/// naming.** They read:
///
/// - *"a cached artifact's hash and raw pointer are written by `cache_source`,
///   which nothing reduces into source state yet"* — true of SOURCE state, and
///   beside the point: both fields are required, non-optional members of
///   `ExtractedAssertionPayload`, on the Observation itself. M27.2 indexes them
///   in `assertion_facets` and the criterion checks them there.
/// - *"a relationship role is a property of the registered source, and no
///   source registration carries one yet"* — the role is a property of the
///   ASSERTION, and its trustworthiness is a property of the registration. The
///   design says so exactly: a human route requires the trusted registration,
///   the bound actor, AND an `m22 human_assertion` whose
///   `relationship_to_subject.role` is permitted.
///
/// Until this closed, no Observation could satisfy any route, so
/// `authoritative_for_predicate_stage` was underivable and every high-stakes
/// proposal queued regardless of its evidence. "Unverifiable is not verified"
/// was the right answer while the facts were genuinely absent; they are not.
pub fn satisfies(
    state: &crate::ledger::reduce::EpistemicState,
    observation_id: &str,
    criterion: &Criterion,
) -> bool {
    use crate::ledger::schema::{
        AssertionBasis, AuthorityProvenance, ObservationKind, SubjectRole,
    };

    let Some(observation) = state.observations.get(observation_id) else {
        return false;
    };
    let kind = match observation.kind {
        ObservationKind::HumanAssertion => RouteObservationKind::HumanAssertion,
        ObservationKind::ExtractedAssertion => RouteObservationKind::ExtractedAssertion,
        _ => return false,
    };
    let capability = match observation.authority {
        Some(AuthorityProvenance::TrustedHumanCapture) => RouteCapability::HumanAssertion,
        Some(AuthorityProvenance::RegisteredDirectArtifact) => {
            RouteCapability::DirectSystemArtifact
        }
        // `agent_inferred` carries no authority capability at all — that is
        // the whole of D11 in one arm.
        _ => return false,
    };
    // The route artifact names three registration kinds; `cerebro_runtime` and
    // `legacy_reference` are not among them, and an Observation from one
    // therefore carries no route authority whatever its payload says. A
    // runtime cache row with no ledger registration lands here as `None`.
    let Some(source) = state.sources.get(&observation.source_id) else {
        return false;
    };
    // The registration the OBSERVATION pinned has to be the one this source
    // actually holds. A mismatch means the assertion is quoting a registration
    // that was not in force for it.
    if source.registration_event_id != observation.source_registration_event_id {
        return false;
    }
    // The REGISTRATION's own capability, checked separately from the
    // provenance derived off it. `derive_authority` grants
    // `registered_direct_artifact` only to a `direct_system_artifact`
    // registration today, so this is belt and braces — and the design names it
    // as its own requirement precisely so a later loosening of that derivation
    // cannot quietly hand a `content_only` builtin an authority route. A test
    // drives exactly that state.
    let registered_capability = match source.registration.capability() {
        crate::ledger::schema::AuthorityCapability::HumanAssertion => {
            Some(RouteCapability::HumanAssertion)
        }
        crate::ledger::schema::AuthorityCapability::DirectSystemArtifact => {
            Some(RouteCapability::DirectSystemArtifact)
        }
        // `content_only` is not a route capability at all.
        _ => None,
    };
    if registered_capability != Some(capability) {
        return false;
    }
    let registration = match source.registration.kind_str() {
        "builtin" => Some(RouteRegistrationKind::Builtin),
        "connector" => Some(RouteRegistrationKind::Connector),
        "human_actor" => Some(RouteRegistrationKind::HumanActor),
        _ => None,
    };
    let facet = state.assertion_facets.get(observation_id);

    match criterion {
        Criterion::DirectArtifact {
            observation_kind,
            registration_kinds,
            authority_capability,
            require_source_artifact_hash,
            require_raw_pointer,
        } => {
            if kind != *observation_kind || capability != *authority_capability {
                return false;
            }
            if !registration.is_some_and(|r| registration_kinds.contains(&r)) {
                return false;
            }
            let Some(facet) = facet else { return false };
            // Checkable AGAINST the artifact rather than against a label. An
            // empty string is an absent hash spelled differently.
            let present =
                |value: &Option<String>| value.as_deref().is_some_and(|text| !text.is_empty());
            if *require_source_artifact_hash && !present(&facet.source_artifact_hash) {
                return false;
            }
            if *require_raw_pointer && !present(&facet.raw_pointer) {
                return false;
            }
            true
        }
        Criterion::ResponsibleOwnerFirsthand {
            observation_kind,
            registration_kind,
            authority_capability,
            relationship_roles,
            assertion_bases,
        }
        | Criterion::FirsthandObserver {
            observation_kind,
            registration_kind,
            authority_capability,
            relationship_roles,
            assertion_bases,
        } => {
            if kind != *observation_kind || capability != *authority_capability {
                return false;
            }
            if registration != Some(*registration_kind) {
                return false;
            }
            // The bound actor, explicitly. `trusted_human_capture` already
            // implies it (`derive_authority` grants that provenance only when
            // the actor IS the registered one), and the design names it as a
            // separate requirement — so it is checked separately rather than
            // inherited from a derivation somebody could later loosen.
            let bound = match &source.registration {
                crate::ledger::schema::SourceRegistration::HumanActor { actor_id, .. } => {
                    actor_id.as_str()
                }
                _ => return false,
            };
            if bound != observation.actor {
                return false;
            }
            let basis = match observation.assertion_basis {
                Some(AssertionBasis::Firsthand) => RouteBasis::Firsthand,
                Some(AssertionBasis::ResponsibleOwner) => RouteBasis::ResponsibleOwner,
                Some(AssertionBasis::Reported) => RouteBasis::Reported,
                Some(AssertionBasis::Inferred) => RouteBasis::Inferred,
                Some(AssertionBasis::Unknown) | None => RouteBasis::Unknown,
            };
            if !assertion_bases.contains(&basis) {
                return false;
            }
            let Some(facet) = facet else { return false };
            let role = match facet.relationship_role {
                SubjectRole::ProjectOwner => RouteRole::ProjectOwner,
                SubjectRole::TeamMember => RouteRole::TeamMember,
                SubjectRole::Adjacent => RouteRole::Adjacent,
                SubjectRole::Unknown => RouteRole::Unknown,
            };
            relationship_roles.contains(&role)
        }
    }
}

/// Every artifact this build can resolve pinned refs against.
pub fn resolvable() -> Result<Vec<AuthorityRoutesV1>, String> {
    RESOLVABLE_ARTIFACTS
        .iter()
        .map(|raw| AuthorityRoutesV1::parse(raw))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ledger::reduce::{AssertionFacet, EpistemicState, ObservationState, SourceState};
    use crate::ledger::schema::{
        AssertionBasis, AuthorityProvenance, ObservationKind, Scope, SourceRegistration,
        SubjectRef, SubjectRole, ValidInterval,
    };

    const OBS: &str = "20000000000000000000000000000001";
    const SOURCE: &str = "50000000000000000000000000000001";
    const REG: &str = "60000000000000000000000000000001";
    const ENTITY: &str = "e0000000000000000000000000000001";

    struct Fixture {
        state: EpistemicState,
    }

    impl Fixture {
        /// One registered source, one observation, one indexed assertion.
        fn new(
            registration: SourceRegistration,
            kind: ObservationKind,
            authority: AuthorityProvenance,
            actor: &str,
        ) -> Fixture {
            let mut state = EpistemicState::default();
            state.sources.insert(
                SOURCE.into(),
                SourceState {
                    source_id: SOURCE.into(),
                    registration_event_id: REG.into(),
                    registration,
                    canonical: String::new(),
                },
            );
            state.observations.insert(
                OBS.into(),
                ObservationState {
                    event_id: OBS.into(),
                    seq: 1,
                    kind,
                    source_id: SOURCE.into(),
                    source_registration_event_id: REG.into(),
                    subject: SubjectRef::Resolved {
                        entity_id: ENTITY.into(),
                        aliases: vec![],
                    },
                    effective_entity: Some(ENTITY.into()),
                    effective_resolution_event: None,
                    authority: Some(authority),
                    assertion_basis: Some(AssertionBasis::Firsthand),
                    absence: None,
                    actor: actor.into(),
                    lineage_parents: vec![],
                },
            );
            state.assertion_facets.insert(
                OBS.into(),
                AssertionFacet {
                    predicate: "ships_with".into(),
                    value_hash: "0".repeat(64),
                    scope: Scope::empty(),
                    valid_time: ValidInterval {
                        from: None,
                        to: None,
                    },
                    recorded_at: "2026-08-01T00:00:00.000Z".into(),
                    observed_at: None,
                    relationship_role: SubjectRole::Unknown,
                    source_artifact_hash: None,
                    raw_pointer: None,
                },
            );
            Fixture { state }
        }

        fn direct_artifact() -> Fixture {
            let mut fixture = Fixture::new(
                crate::ledger::schema::source::tests::registration("connector"),
                ObservationKind::ExtractedAssertion,
                AuthorityProvenance::RegisteredDirectArtifact,
                "system:connector",
            );
            let facet = fixture.state.assertion_facets.get_mut(OBS).unwrap();
            facet.source_artifact_hash = Some("a".repeat(64));
            facet.raw_pointer = Some("github://acme/repo/blob/main/bom.yml#L3".into());
            fixture
        }

        fn human(role: SubjectRole, basis: AssertionBasis) -> Fixture {
            let mut fixture = Fixture::new(
                crate::ledger::schema::source::tests::registration("human_actor"),
                ObservationKind::HumanAssertion,
                AuthorityProvenance::TrustedHumanCapture,
                "human:josef",
            );
            fixture
                .state
                .observations
                .get_mut(OBS)
                .unwrap()
                .assertion_basis = Some(basis);
            fixture
                .state
                .assertion_facets
                .get_mut(OBS)
                .unwrap()
                .relationship_role = role;
            fixture
        }

        fn matches(&self, route_id: &str) -> bool {
            let artifact = AuthorityRoutesV1::load().unwrap();
            let route = artifact
                .routes
                .iter()
                .find(|route| route.authority_route_id == route_id)
                .expect("a route by that id");
            route
                .criteria
                .iter()
                .any(|criterion| satisfies(&self.state, OBS, criterion))
        }
    }

    #[test]
    fn a_direct_production_artifact_can_be_authoritative_without_human_authorship() {
        // The acceptance row. Until M27.2b closed the M25 edge, nothing could
        // satisfy any route, so this returned false for the wrong reason.
        assert!(Fixture::direct_artifact().matches("route.observable_machine_state"));
    }

    #[test]
    fn a_direct_artifact_without_its_hash_or_pointer_satisfies_nothing() {
        // What makes the claim checkable AGAINST the artifact rather than
        // against a label. An empty string is an absent hash spelled
        // differently, and both spellings fail.
        for (hash, pointer) in [
            (None, Some("ptr".to_string())),
            (Some("a".repeat(64)), None),
            (Some(String::new()), Some("ptr".to_string())),
            (Some("a".repeat(64)), Some(String::new())),
        ] {
            let fixture = Fixture::direct_artifact();
            let mut fixture = fixture;
            let facet = fixture.state.assertion_facets.get_mut(OBS).unwrap();
            facet.source_artifact_hash = hash.clone();
            facet.raw_pointer = pointer.clone();
            assert!(
                !fixture.matches("route.observable_machine_state"),
                "hash {hash:?} pointer {pointer:?} should not match"
            );
        }
    }

    #[test]
    fn a_responsible_owner_firsthand_human_can_be_authoritative_for_intent() {
        assert!(
            Fixture::human(SubjectRole::ProjectOwner, AssertionBasis::ResponsibleOwner)
                .matches("route.intent_rationale")
        );
    }

    #[test]
    fn a_team_member_takes_the_observer_route_and_not_the_owner_one() {
        // Both criteria live on `route.intent_rationale`; only the observer
        // one admits a team member, and only for a firsthand basis.
        let member = Fixture::human(SubjectRole::TeamMember, AssertionBasis::Firsthand);
        assert!(member.matches("route.intent_rationale"));
        // `route.committed_organizational_state` carries only the
        // responsible-owner criterion, which a team member never satisfies.
        assert!(!member.matches("route.committed_organizational_state"));
    }

    #[test]
    fn an_adjacent_role_satisfies_no_human_route() {
        assert!(
            !Fixture::human(SubjectRole::Adjacent, AssertionBasis::Firsthand)
                .matches("route.intent_rationale")
        );
    }

    #[test]
    fn an_unknown_role_proves_nothing_and_neither_does_a_reported_basis() {
        assert!(
            !Fixture::human(SubjectRole::Unknown, AssertionBasis::Firsthand)
                .matches("route.intent_rationale")
        );
        assert!(
            !Fixture::human(SubjectRole::ProjectOwner, AssertionBasis::Reported)
                .matches("route.intent_rationale")
        );
    }

    #[test]
    fn a_payload_claiming_ownership_over_agent_inferred_content_satisfies_nothing() {
        // D11 in one test: the identical `relationship_to_subject.role` that
        // carries a trusted human capture proves nothing here, because the
        // arms never reach it — the provenance is checked first.
        let mut fixture = Fixture::new(
            crate::ledger::schema::source::tests::registration("human_actor"),
            ObservationKind::HumanAssertion,
            AuthorityProvenance::AgentInferred,
            "agent:sneaky",
        );
        fixture
            .state
            .assertion_facets
            .get_mut(OBS)
            .unwrap()
            .relationship_role = SubjectRole::ProjectOwner;
        assert!(!fixture.matches("route.intent_rationale"));
    }

    #[test]
    fn an_assertion_quoting_a_registration_this_source_does_not_hold_satisfies_nothing() {
        let mut fixture = Fixture::direct_artifact();
        fixture
            .state
            .observations
            .get_mut(OBS)
            .unwrap()
            .source_registration_event_id = "9".repeat(32);
        assert!(!fixture.matches("route.observable_machine_state"));
    }

    #[test]
    fn a_content_only_or_legacy_registration_can_never_carry_a_route() {
        for kind in ["builtin", "cerebro_runtime", "legacy_reference"] {
            let mut fixture = Fixture::new(
                crate::ledger::schema::source::tests::registration(kind),
                ObservationKind::ExtractedAssertion,
                AuthorityProvenance::RegisteredDirectArtifact,
                "system:whatever",
            );
            let facet = fixture.state.assertion_facets.get_mut(OBS).unwrap();
            facet.source_artifact_hash = Some("a".repeat(64));
            facet.raw_pointer = Some("ptr".into());
            assert!(
                !fixture.matches("route.observable_machine_state"),
                "{kind} must carry no route authority"
            );
        }
    }

    #[test]
    fn a_human_route_needs_the_registrations_own_bound_actor() {
        let mut fixture = Fixture::human(SubjectRole::ProjectOwner, AssertionBasis::Firsthand);
        fixture.state.observations.get_mut(OBS).unwrap().actor = "human:someone-else".into();
        assert!(!fixture.matches("route.intent_rationale"));
    }

    #[test]
    fn an_observation_with_no_indexed_assertion_satisfies_nothing() {
        // A snapshot or a system event supports a belief and asserts no
        // predicate; there is nothing for a route to read.
        let mut fixture = Fixture::direct_artifact();
        fixture.state.assertion_facets.remove(OBS);
        assert!(!fixture.matches("route.observable_machine_state"));
    }

    fn repo(rel: &str) -> std::path::PathBuf {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join(rel)
    }

    #[test]
    fn the_shipped_artifact_loads_and_validates() {
        let artifact = AuthorityRoutesV1::load().expect("committed authority routes must load");
        assert_eq!(artifact.format, FORMAT);
        assert!(!artifact.routes.is_empty());
    }

    #[test]
    fn the_compiled_artifact_is_the_file_on_disk() {
        let disk = std::fs::read_to_string(repo(AUTHORITY_ROUTES_V1_PATH)).unwrap();
        assert_eq!(disk, AUTHORITY_ROUTES_V1_JSON);
    }

    #[test]
    fn the_current_artifact_has_a_committed_content_addressed_snapshot() {
        // "A current file that does not equal its content-addressed
        // snapshot" is a load-time refusal in the design; here it is a
        // committed-tree invariant, so the released bytes for this hash can
        // never be edited out from under a proposal that pinned them.
        let artifact = AuthorityRoutesV1::load().unwrap();
        let hash = artifact.artifact_hash();
        let path = repo(SNAPSHOT_DIR).join(format!("{hash}.json"));
        let snapshot = std::fs::read_to_string(&path).unwrap_or_else(|e| {
            panic!(
                "{}: {e} — regenerate with `cargo test --lib policy:: -- --ignored \
                 write_authority_snapshot`",
                path.display()
            )
        });
        assert_eq!(
            snapshot,
            artifact.canonical(),
            "the snapshot is not the canonical form of the current artifact"
        );
    }

    #[test]
    fn snapshots_on_disk_are_all_compiled_in() {
        // A snapshot nobody compiled in is a rule a queued proposal can pin
        // and this binary cannot read.
        let compiled: BTreeSet<String> = resolvable()
            .unwrap()
            .iter()
            .map(|a| a.artifact_hash())
            .collect();
        let dir = repo(SNAPSHOT_DIR);
        for entry in std::fs::read_dir(&dir).expect("snapshot dir exists") {
            let entry = entry.unwrap();
            let name = entry.file_name().to_string_lossy().to_string();
            let Some(hash) = name.strip_suffix(".json") else {
                continue;
            };
            assert!(
                compiled.contains(hash),
                "{name} is a released snapshot no build can resolve — add it to \
                 RESOLVABLE_ARTIFACTS"
            );
        }
    }

    #[test]
    fn a_pinned_ref_resolves_only_on_all_three_legs() {
        let artifacts = resolvable().unwrap();
        let route = &artifacts[0].routes[0];
        let hash = artifacts[0].artifact_hash();
        let good = AuthorityRouteRef {
            authority_route_id: route.authority_route_id.clone(),
            authority_rule_version: route.authority_rule_version,
            artifact_hash: hash.clone(),
        };
        assert!(AuthorityRoutesV1::resolve(&artifacts, &good).is_some());

        let wrong_version = AuthorityRouteRef {
            authority_rule_version: route.authority_rule_version + 1,
            ..good.clone()
        };
        assert!(AuthorityRoutesV1::resolve(&artifacts, &wrong_version).is_none());

        let wrong_hash = AuthorityRouteRef {
            artifact_hash: "0".repeat(64),
            ..good.clone()
        };
        assert!(AuthorityRoutesV1::resolve(&artifacts, &wrong_hash).is_none());

        let wrong_id = AuthorityRouteRef {
            authority_route_id: "route.invented".to_string(),
            ..good
        };
        assert!(AuthorityRoutesV1::resolve(&artifacts, &wrong_id).is_none());
    }

    fn mutated(f: impl FnOnce(&mut serde_json::Value)) -> String {
        let mut raw: serde_json::Value = serde_json::from_str(AUTHORITY_ROUTES_V1_JSON).unwrap();
        f(&mut raw);
        raw.to_string()
    }

    #[test]
    fn a_human_authored_direct_artifact_route_is_refused() {
        // The D11 line: authorship never upgrades itself into a machine
        // artifact by relabelling the criterion.
        let raw = mutated(|v| {
            v["routes"][2]["criteria"][0]["observation_kind"] =
                serde_json::json!("human_assertion");
        });
        let err = AuthorityRoutesV1::parse(&raw).unwrap_err();
        assert!(err.contains("observation_kind"), "{err}");
    }

    #[test]
    fn a_direct_artifact_route_naming_a_human_actor_registration_is_refused() {
        let raw = mutated(|v| {
            v["routes"][2]["criteria"][0]["registration_kinds"] =
                serde_json::json!(["human_actor"]);
        });
        assert!(AuthorityRoutesV1::parse(&raw)
            .unwrap_err()
            .contains("human actor cannot satisfy"));
    }

    #[test]
    fn a_direct_artifact_route_cannot_waive_the_artifact_hash() {
        let raw = mutated(|v| {
            v["routes"][2]["criteria"][0]["require_source_artifact_hash"] =
                serde_json::json!(false);
        });
        assert!(AuthorityRoutesV1::parse(&raw)
            .unwrap_err()
            .contains("must require both"));
    }

    #[test]
    fn a_route_accepting_an_unknown_role_is_refused() {
        let raw = mutated(|v| {
            v["routes"][0]["criteria"][0]["relationship_roles"] =
                serde_json::json!(["project_owner", "unknown"]);
        });
        assert!(AuthorityRoutesV1::parse(&raw)
            .unwrap_err()
            .contains("proves nothing"));
    }

    #[test]
    fn a_route_accepting_a_reported_basis_is_refused() {
        // "Somebody told me" is not a firsthand-class basis, and a route
        // that took it would launder hearsay into authority.
        let raw = mutated(|v| {
            // Canonical (declaration) order, so the ORDERING check passes
            // and the basis-class check is what actually fires.
            v["routes"][0]["criteria"][0]["assertion_bases"] =
                serde_json::json!(["responsible_owner", "reported"]);
        });
        assert!(AuthorityRoutesV1::parse(&raw)
            .unwrap_err()
            .contains("not a firsthand-class basis"));
    }

    #[test]
    fn duplicate_applicability_is_refused() {
        let raw = mutated(|v| {
            v["routes"][1]["predicate_classes"] =
                serde_json::json!(["committed_organizational_state"]);
            v["routes"][1]["state_stages"] = serde_json::json!(["approved"]);
        });
        assert!(AuthorityRoutesV1::parse(&raw)
            .unwrap_err()
            .contains("is already"));
    }

    #[test]
    fn two_criteria_of_one_class_are_refused() {
        let raw = mutated(|v| {
            let first = v["routes"][3]["criteria"][0].clone();
            v["routes"][3]["criteria"] = serde_json::json!([first.clone(), first]);
        });
        assert!(AuthorityRoutesV1::parse(&raw)
            .unwrap_err()
            .contains("class appears at most once"));
    }

    #[test]
    fn an_unknown_stage_is_refused_rather_than_ignored() {
        let raw = mutated(|v| {
            v["routes"][0]["state_stages"] = serde_json::json!(["approved", "vibing"]);
        });
        assert!(AuthorityRoutesV1::parse(&raw).is_err());
    }

    /// Regenerate the content-addressed snapshot for the current artifact.
    /// Ignored by default: releasing a snapshot is a deliberate act, not a
    /// side effect of running the suite.
    #[test]
    #[ignore = "run explicitly to release a new authority-routes snapshot"]
    fn write_authority_snapshot() {
        let artifact = AuthorityRoutesV1::load().unwrap();
        let dir = repo(SNAPSHOT_DIR);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(format!("{}.json", artifact.artifact_hash()));
        std::fs::write(&path, artifact.canonical()).unwrap();
        println!("wrote {}", path.display());
    }
}
