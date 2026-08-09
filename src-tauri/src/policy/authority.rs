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
