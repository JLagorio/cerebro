//! The four attention lanes (M27.6) — deterministic, ranked in Rust.
//!
//! **The LLM never orders attention.** Every lane here is a predicate over
//! reducer state and M27's three axes, and the order lanes come back in is
//! declared in `shared/policy/lanes.v1.json`. A model that ranked what a
//! person sees first would be deciding what matters by fluency, and no
//! reader could check it.
//!
//! **Nothing speaks first (M8's tone rule).** These functions answer when
//! asked. Nothing here notifies, badges, or counts up on a surface — the lane
//! is a list a person opens, and M27.8's Epistemic Status page is the one
//! place that opens it.
//!
//! **The four lanes overlap on purpose.** A stale, contested, relied-upon
//! belief is in three of them, and collapsing that into one "worst" lane
//! would throw away the fact that it is three different problems with three
//! different remedies. Each lane answers its own question and the same belief
//! may appear in several.
//!
//! **Reliance gates the debt lane and only orders the blindness one.** §89
//! defines epistemic debt as a *materially relied-upon* thing carrying one of
//! six weaknesses, so reliance is a filter there. Blindness is a fact about
//! what nobody has looked at, and filtering that by reliance would hide
//! exactly the gaps nobody has noticed yet — so there it sorts and never
//! excludes.
//!
//! **Reliance is a proxy, and a declared one.** This base has no `depends_on`
//! relation, so "materially relied upon" is spelled as the three deterministic
//! facts it does hold, listed in the artifact: the base promoted it past draft
//! (`qualified`), somebody tried to and was refused (`promotion_attempted`,
//! M24's parked rows), or another live belief `refines` it (`refined_by`).
//! Widening it — a projection path, say — would make nearly every concept
//! "relied upon" and empty the word.
//!
//! **`as_of` is an argument.** Freshness needs a time and this module refuses
//! to read one, the same discipline [`crate::dynamics`] and
//! [`crate::convergence`] carry.

use std::collections::{BTreeMap, BTreeSet};

use crate::dynamics::bundle::{self, FacetChips};
use crate::ledger::reduce::EpistemicState;
use crate::ledger::schema::RelationKind;
use crate::ledger::sha256_hex;

const LANES_JSON: &str = include_str!("../../../shared/policy/lanes.v1.json");
const LANES_DIGEST: &str = include_str!("../../../shared/policy/lanes.v1.sha256");

#[derive(Debug, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Artifact {
    format: u64,
    artifact_version: u64,
    rule_version: String,
    lanes: Vec<LaneDef>,
    reliance: Vec<String>,
    debt_requires_reliance: bool,
}

#[derive(Debug, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct LaneDef {
    id: String,
    reasons: Vec<String>,
}

/// The loaded lane definitions.
///
/// Lane order and within-lane reason order are the artifact's LIST order, not
/// a numeric rank: a rank column is a second thing to keep in agreement with
/// the order, and two ways to say the same thing is one way to disagree.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Definitions {
    pub artifact_version: u64,
    pub rule_version: String,
    order: Vec<String>,
    reasons: BTreeMap<String, Vec<String>>,
    reliance: Vec<String>,
    debt_requires_reliance: bool,
}

impl Definitions {
    /// Lanes in the order a surface renders them.
    pub fn order(&self) -> &[String] {
        &self.order
    }

    /// Where a reason sorts within its lane. `None` for a reason the artifact
    /// does not declare — which [`lanes`] can never produce, because every
    /// reason it emits is checked against this at load.
    pub fn rank_of(&self, lane: &str, reason: &str) -> Option<usize> {
        self.reasons
            .get(lane)?
            .iter()
            .position(|declared| declared == reason)
    }
}

/// Load the shipped definitions, bytes checked against the committed digest.
pub fn load() -> Result<Definitions, String> {
    let expected = LANES_DIGEST.trim();
    let actual = sha256_hex(LANES_JSON.as_bytes());
    if actual != expected {
        return Err(format!(
            "shared/policy/lanes.v1.json hashes to {actual}, and the committed digest says \
             {expected} — regenerate the digest deliberately, or find out who changed what this \
             app puts in front of a person"
        ));
    }
    let artifact: Artifact =
        serde_json::from_str(LANES_JSON).map_err(|e| format!("lanes.v1.json: {e}"))?;
    if artifact.format != 1 {
        return Err(format!(
            "lanes format {} is not one this build speaks",
            artifact.format
        ));
    }
    if artifact.rule_version.is_empty() {
        return Err("rule_version must be non-empty".into());
    }

    // Every lane this build can compute must be declared, and every declared
    // lane must be one this build can compute. A lane in the artifact with no
    // code behind it would render as permanently empty — indistinguishable
    // from a lane with nothing in it, which is the exact confusion the rest of
    // this codebase says out loud.
    let declared: Vec<&str> = artifact.lanes.iter().map(|l| l.id.as_str()).collect();
    if declared != Lane::ALL.iter().map(Lane::as_str).collect::<Vec<_>>() {
        return Err(format!(
            "lanes.v1.json declares {declared:?}, and this build computes {:?} — a lane with no \
             code behind it renders as permanently empty, which reads as 'nothing here'",
            Lane::ALL.iter().map(Lane::as_str).collect::<Vec<_>>()
        ));
    }

    let mut reasons: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for lane in &artifact.lanes {
        if lane.reasons.is_empty() {
            return Err(format!(
                "lane {:?} declares no reasons — a lane that cannot say why is a badge",
                lane.id
            ));
        }
        let unique: BTreeSet<&String> = lane.reasons.iter().collect();
        if unique.len() != lane.reasons.len() {
            return Err(format!("lane {:?} declares a reason twice", lane.id));
        }
        reasons.insert(lane.id.clone(), lane.reasons.clone());
    }

    // The reasons this build can emit, against the reasons the artifact
    // declares. Both directions: an undeclared reason would sort nowhere, and
    // a declared-but-unreachable one is a promise the code does not keep.
    for (lane, emitted) in [
        (Lane::Contradiction, &Reason::CONTRADICTION[..]),
        (Lane::Blindness, &Reason::BLINDNESS[..]),
        (Lane::Staleness, &Reason::STALENESS[..]),
        (Lane::EpistemicDebt, &Reason::DEBT[..]),
    ] {
        let declared = reasons.get(lane.as_str()).expect("checked above");
        let emitted: BTreeSet<&str> = emitted.iter().map(|r| r.as_str()).collect();
        let declared_set: BTreeSet<&str> = declared.iter().map(String::as_str).collect();
        if emitted != declared_set {
            return Err(format!(
                "lane {:?} declares reasons {declared_set:?} and this build emits {emitted:?}",
                lane.as_str()
            ));
        }
    }

    let reliance: BTreeSet<&str> = artifact.reliance.iter().map(String::as_str).collect();
    let known: BTreeSet<&str> = Reliance::ALL.iter().map(|r| r.as_str()).collect();
    if reliance != known {
        return Err(format!(
            "lanes.v1.json declares reliance {reliance:?} and this build computes {known:?}"
        ));
    }

    Ok(Definitions {
        artifact_version: artifact.artifact_version,
        rule_version: artifact.rule_version,
        order: artifact.lanes.iter().map(|l| l.id.clone()).collect(),
        reasons,
        reliance: artifact.reliance,
        debt_requires_reliance: artifact.debt_requires_reliance,
    })
}

/// The four. Declaration order is render order, and the artifact must agree.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Lane {
    Contradiction,
    Blindness,
    Staleness,
    EpistemicDebt,
}

impl Lane {
    pub const ALL: [Lane; 4] = [
        Lane::Contradiction,
        Lane::Blindness,
        Lane::Staleness,
        Lane::EpistemicDebt,
    ];

    pub fn as_str(&self) -> &'static str {
        match self {
            Lane::Contradiction => "contradiction",
            Lane::Blindness => "blindness",
            Lane::Staleness => "staleness",
            Lane::EpistemicDebt => "epistemic_debt",
        }
    }
}

/// Why one item is in one lane. Closed, and every one is a fact.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Reason {
    // contradiction
    OpenEdgeGenuineDirect,
    OpenEdgePartial,
    OpenEdgeConditional,
    /// A live `contradicts` relation the pipeline has not classified. It stays
    /// visible and gate-protecting until it is — a declaration nobody has
    /// judged is not a declaration nobody made.
    LegacyUnclassified,
    // blindness
    CoverageBlindAssessed,
    CoverageUnassessed,
    // staleness
    FreshnessStale,
    // epistemic debt (§89)
    UnresolvedContradiction,
    UnsupportedInference,
    AuthorityRouteUnmatched,
    NoAuthorityRouteDeclared,
    PromotionBlocked,
    StaleEvidence,
    CoverageNotObserved,
}

impl Reason {
    pub const CONTRADICTION: [Reason; 4] = [
        Reason::OpenEdgeGenuineDirect,
        Reason::OpenEdgePartial,
        Reason::OpenEdgeConditional,
        Reason::LegacyUnclassified,
    ];
    pub const BLINDNESS: [Reason; 2] = [Reason::CoverageBlindAssessed, Reason::CoverageUnassessed];
    pub const STALENESS: [Reason; 1] = [Reason::FreshnessStale];
    pub const DEBT: [Reason; 7] = [
        Reason::UnresolvedContradiction,
        Reason::UnsupportedInference,
        Reason::AuthorityRouteUnmatched,
        Reason::NoAuthorityRouteDeclared,
        Reason::PromotionBlocked,
        Reason::StaleEvidence,
        Reason::CoverageNotObserved,
    ];

    pub fn as_str(&self) -> &'static str {
        match self {
            Reason::OpenEdgeGenuineDirect => "open_edge_genuine_direct",
            Reason::OpenEdgePartial => "open_edge_partial",
            Reason::OpenEdgeConditional => "open_edge_conditional",
            Reason::LegacyUnclassified => "legacy_unclassified",
            Reason::CoverageBlindAssessed => "coverage_blind_assessed",
            Reason::CoverageUnassessed => "coverage_unassessed",
            Reason::FreshnessStale => "freshness_stale",
            Reason::UnresolvedContradiction => "unresolved_contradiction",
            Reason::UnsupportedInference => "unsupported_inference",
            Reason::AuthorityRouteUnmatched => "authority_route_unmatched",
            Reason::NoAuthorityRouteDeclared => "no_authority_route_declared",
            Reason::PromotionBlocked => "promotion_blocked",
            Reason::StaleEvidence => "stale_evidence",
            Reason::CoverageNotObserved => "coverage_not_observed",
        }
    }
}

/// Why the base is taken to be relying on something.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Reliance {
    /// Promoted past draft: the base is standing behind it.
    Qualified,
    /// M24 refused a promotion and parked the attempt. Somebody wanted to
    /// stand behind it, which is reliance the base has not managed to record
    /// any other way.
    PromotionAttempted,
    /// Another live belief `refines` it, so something is built on top.
    RefinedBy,
}

impl Reliance {
    pub const ALL: [Reliance; 3] = [
        Reliance::Qualified,
        Reliance::PromotionAttempted,
        Reliance::RefinedBy,
    ];

    pub fn as_str(&self) -> &'static str {
        match self {
            Reliance::Qualified => "qualified",
            Reliance::PromotionAttempted => "promotion_attempted",
            Reliance::RefinedBy => "refined_by",
        }
    }
}

/// One thing in one lane.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Item {
    pub lane: Lane,
    pub belief_id: String,
    pub entity_id: String,
    /// The knowledge-relative projection path, when the belief is one.
    pub path: Option<String>,
    /// The facet this is about, when the reason is per-facet. `None` for the
    /// contradiction lane, whose subject is a whole belief pair.
    pub predicate: Option<String>,
    pub state_stage: Option<String>,
    /// Sorted by the artifact's within-lane order, never empty.
    pub reasons: Vec<Reason>,
    /// Why the base is taken to rely on this. Sorted, possibly empty — in the
    /// blindness lane an empty list is ordinary and orders the item last.
    pub reliance: Vec<Reliance>,
    /// The contradiction edge, for the lane whose item IS an edge.
    pub edge_id: Option<String>,
    /// The declared relation, for a legacy row nothing has classified.
    pub relation_id: Option<String>,
}

/// Everything the four lanes hold, in the artifact's lane order.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Lanes {
    pub rule_version: String,
    pub items: Vec<Item>,
}

impl Lanes {
    pub fn of(&self, lane: Lane) -> impl Iterator<Item = &Item> {
        self.items.iter().filter(move |item| item.lane == lane)
    }
}

/// One open parked promotion, as the debt lane reads it.
///
/// Taken as data rather than read from SQLite here: parking lives in
/// `runtime.db` (operational, never the ledger) and this stays a pure
/// function of what it is handed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParkedPromotion {
    pub belief_id: String,
    pub missing_roles: Vec<String>,
}

/// Compute all four lanes.
pub fn lanes(
    state: &EpistemicState,
    tables: &bundle::Tables,
    definitions: &Definitions,
    parked: &[ParkedPromotion],
    as_of: chrono::DateTime<chrono::Utc>,
) -> Lanes {
    let chips = bundle::all_chips(state, tables, as_of);
    let reliance = reliance_index(state, parked);
    let mut items = Vec::new();

    items.extend(contradiction(state));
    for belief in &chips {
        let relied = reliance
            .get(belief.belief_id.as_str())
            .cloned()
            .unwrap_or_default();
        // The entity is looked up rather than carried on the chips row: the
        // chip surface renders one concept and never needed it, and widening
        // a wire shape to save a map lookup is how wire shapes grow.
        let entity_id = match state.beliefs.get(&belief.belief_id) {
            Some(row) => row.entity_id.clone(),
            None => continue,
        };
        for facet in &belief.facets {
            items.extend(blindness(belief, facet, &relied, &entity_id));
            items.extend(staleness(belief, facet, &relied, &entity_id));
            items.extend(debt(
                tables,
                definitions,
                belief,
                facet,
                &relied,
                parked,
                &entity_id,
            ));
        }
    }

    // The artifact's order, then the artifact's within-lane reason order, then
    // the belief id. Every tie is broken by something declared or stable, so
    // two runs over one base put the same thing first.
    items.sort_by_key(|item| {
        let lane = definitions
            .order()
            .iter()
            .position(|id| id == item.lane.as_str())
            .unwrap_or(usize::MAX);
        let reason = item
            .reasons
            .first()
            .and_then(|r| definitions.rank_of(item.lane.as_str(), r.as_str()))
            .unwrap_or(usize::MAX);
        // Within the blindness lane reliance ORDERS and never filters: an
        // unrelied-upon blind spot is still a blind spot, and it sorts after
        // the ones something is standing on.
        let unrelied = usize::from(item.reliance.is_empty());
        (
            lane,
            reason,
            unrelied,
            item.belief_id.clone(),
            item.predicate.clone(),
        )
    });
    Lanes {
        rule_version: definitions.rule_version.clone(),
        items,
    }
}

fn sorted_reasons(definitions: &Definitions, lane: Lane, mut reasons: Vec<Reason>) -> Vec<Reason> {
    reasons.sort_by_key(|reason| {
        definitions
            .rank_of(lane.as_str(), reason.as_str())
            .unwrap_or(usize::MAX)
    });
    reasons.dedup();
    reasons
}

/// Open edges, plus declared `contradicts` relations nothing has classified.
///
/// Both halves are needed. An edge is a disagreement the pipeline judged; an
/// unclassified declaration is one a person wrote down and the pipeline has
/// not reached. Dropping the second while waiting would make the lane go
/// quiet about something the user can see in their own vault.
fn contradiction(state: &EpistemicState) -> Vec<Item> {
    let mut out = Vec::new();
    for edge in state.contradiction_edges.values() {
        if edge.closed.is_some() {
            continue;
        }
        let Some(belief) = state.beliefs.get(&edge.left_belief_id) else {
            continue;
        };
        out.push(Item {
            lane: Lane::Contradiction,
            belief_id: edge.left_belief_id.clone(),
            entity_id: belief.entity_id.clone(),
            path: belief.path.clone(),
            predicate: None,
            state_stage: None,
            reasons: vec![match edge.kind {
                crate::ledger::schema::EdgeKind::GenuineDirect => Reason::OpenEdgeGenuineDirect,
                crate::ledger::schema::EdgeKind::Partial => Reason::OpenEdgePartial,
                crate::ledger::schema::EdgeKind::Conditional => Reason::OpenEdgeConditional,
            }],
            reliance: Vec::new(),
            edge_id: Some(edge.edge_id.clone()),
            relation_id: None,
        });
    }

    // Which declared relations the pipeline has already turned into a
    // comparison. Anything else is legacy-unclassified, whatever its age.
    let classified: BTreeSet<&str> = state
        .comparisons
        .values()
        .filter_map(|row| match &row.origin {
            crate::ledger::reduce::ComparisonOrigin::Declared {
                source_relation_event_id,
                ..
            } => Some(source_relation_event_id.as_str()),
            _ => None,
        })
        .collect();
    for relation in state.relations.values() {
        if !relation.live || relation.relation != RelationKind::Contradicts {
            continue;
        }
        if classified.contains(relation.last_add_event_id.as_str()) {
            continue;
        }
        let Some(belief) = state.beliefs.get(&relation.from) else {
            continue;
        };
        out.push(Item {
            lane: Lane::Contradiction,
            belief_id: relation.from.clone(),
            entity_id: belief.entity_id.clone(),
            path: belief.path.clone(),
            predicate: None,
            state_stage: None,
            reasons: vec![Reason::LegacyUnclassified],
            reliance: Vec::new(),
            edge_id: None,
            relation_id: Some(relation.relation_id.clone()),
        });
    }
    out
}

fn facet_item(
    lane: Lane,
    belief: &bundle::BeliefChips,
    facet: &FacetChips,
    reasons: Vec<Reason>,
    relied: &[Reliance],
    entity_id: &str,
) -> Item {
    Item {
        lane,
        belief_id: belief.belief_id.clone(),
        entity_id: entity_id.to_string(),
        path: belief.path.clone(),
        predicate: facet.key.predicate.value().map(str::to_string),
        state_stage: Some(facet.key.state_stage.as_str().to_string()),
        reasons,
        reliance: relied.to_vec(),
        edge_id: None,
        relation_id: None,
    }
}

/// Coverage says blind. Detection is unqualified — reliance orders, never
/// filters — because a blind spot nobody is standing on is exactly the one
/// nobody has noticed.
fn blindness(
    belief: &bundle::BeliefChips,
    facet: &FacetChips,
    relied: &[Reliance],
    entity_id: &str,
) -> Vec<Item> {
    use crate::dynamics::coverage::{Coverage, Summary};
    if facet.coverage.summary() != Summary::Blind {
        return Vec::new();
    }
    // "Nobody has assessed this" and "the assessments fold to blind" are
    // different sentences with the same summary, and the lane says which.
    let reason = match facet.coverage {
        Coverage::NoAssessments { .. } => Reason::CoverageUnassessed,
        Coverage::Assessed { .. } => Reason::CoverageBlindAssessed,
    };
    vec![facet_item(
        Lane::Blindness,
        belief,
        facet,
        vec![reason],
        relied,
        entity_id,
    )]
}

/// `Validity.freshness = stale`, independent of conflict and lifecycle. A
/// stale truth is still a truth, and a contested one is a separate problem.
fn staleness(
    belief: &bundle::BeliefChips,
    facet: &FacetChips,
    relied: &[Reliance],
    entity_id: &str,
) -> Vec<Item> {
    if facet.validity.freshness != crate::ledger::schema::Freshness::Stale {
        return Vec::new();
    }
    vec![facet_item(
        Lane::Staleness,
        belief,
        facet,
        vec![Reason::FreshnessStale],
        relied,
        entity_id,
    )]
}

/// §89, operationally: a relied-upon thing carrying one of the named
/// weaknesses. Deterministic reasons, never a judgement.
#[allow(clippy::too_many_arguments)] // Each argument is a distinct input the
                                     // definition names; bundling them would
                                     // hide which of §89's terms is which.
fn debt(
    tables: &bundle::Tables,
    definitions: &Definitions,
    belief: &bundle::BeliefChips,
    facet: &FacetChips,
    relied: &[Reliance],
    parked: &[ParkedPromotion],
    entity_id: &str,
) -> Vec<Item> {
    use crate::dynamics::coverage::Summary;
    use crate::dynamics::support::Support;

    if definitions.debt_requires_reliance && relied.is_empty() {
        return Vec::new();
    }
    let mut reasons = Vec::new();
    if facet.validity.conflict == crate::dynamics::validity::Conflict::Contested {
        reasons.push(Reason::UnresolvedContradiction);
    }
    if matches!(facet.support, Support::Unsupported { .. }) {
        reasons.push(Reason::UnsupportedInference);
    }
    if !matches!(
        facet.support,
        Support::AuthoritativeForPredicateStage { .. }
    ) {
        // Two different absences, and the difference is actionable: a route
        // that exists and went unmatched is evidence somebody could still go
        // and get; no route at all means nobody has said how this claim could
        // EVER be authoritative, which is a decision, not a fetch.
        reasons.push(
            if crate::dynamics::support::route_declared(
                &tables.authority,
                facet.key.predicate.value(),
                facet.key.state_stage,
            ) {
                Reason::AuthorityRouteUnmatched
            } else {
                Reason::NoAuthorityRouteDeclared
            },
        );
    }
    if parked.iter().any(|row| row.belief_id == belief.belief_id) {
        reasons.push(Reason::PromotionBlocked);
    }
    if facet.validity.freshness == crate::ledger::schema::Freshness::Stale {
        reasons.push(Reason::StaleEvidence);
    }
    if facet.coverage.summary() != Summary::Observed {
        reasons.push(Reason::CoverageNotObserved);
    }
    if reasons.is_empty() {
        return Vec::new();
    }
    vec![facet_item(
        Lane::EpistemicDebt,
        belief,
        facet,
        sorted_reasons(definitions, Lane::EpistemicDebt, reasons),
        relied,
        entity_id,
    )]
}

/// Which beliefs the base is relying on, and why.
fn reliance_index(
    state: &EpistemicState,
    parked: &[ParkedPromotion],
) -> BTreeMap<String, Vec<Reliance>> {
    let mut out: BTreeMap<String, Vec<Reliance>> = BTreeMap::new();
    for belief in state.beliefs.values() {
        if belief.tombstoned_by.is_some() {
            continue;
        }
        if !matches!(
            belief.qualification,
            crate::ledger::schema::Qualification::Draft
        ) {
            out.entry(belief.belief_id.clone())
                .or_default()
                .push(Reliance::Qualified);
        }
    }
    for row in parked {
        out.entry(row.belief_id.clone())
            .or_default()
            .push(Reliance::PromotionAttempted);
    }
    for relation in state.relations.values() {
        if !relation.live || relation.relation != RelationKind::Refines {
            continue;
        }
        // `from` refines `to`, so the RELIED-UPON one is `to`.
        out.entry(relation.to.clone())
            .or_default()
            .push(Reliance::RefinedBy);
    }
    for reasons in out.values_mut() {
        reasons.sort();
        reasons.dedup();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::assembly::fixture::{relate, B_ONE, B_TWO, OBS_AUTHORITY, OBS_INFERRED, REV_ONE};
    use crate::dynamics::facet::tests::{assertion_facet, base};
    use crate::ledger::schema::{EdgeKind, Qualification, Stage};

    fn at(stamp: &str) -> chrono::DateTime<chrono::Utc> {
        chrono::DateTime::parse_from_rfc3339(stamp)
            .unwrap()
            .with_timezone(&chrono::Utc)
    }

    fn run(state: &EpistemicState, parked: &[ParkedPromotion]) -> Lanes {
        lanes(
            state,
            &bundle::Tables::load().expect("the shipped artifacts"),
            &load().expect("the shipped lane definitions"),
            parked,
            at("2026-08-12T00:00:00Z"),
        )
    }

    /// A stale, single-source, unassessed belief the base is standing behind,
    /// and a second one it does not.
    ///
    /// BOTH of B_ONE's supports are indexed on purpose: an assertion the
    /// reducer never indexed lands in the `unknown/unknown` bucket, which is a
    /// SECOND facet and therefore a second row in every per-facet lane. That
    /// is correct behaviour and a confusing fixture.
    fn standing() -> EpistemicState {
        let mut state = base();
        for event in [OBS_AUTHORITY, OBS_INFERRED] {
            let mut assertion = assertion_facet(
                "ci_status",
                Some(Stage::Implemented),
                "2020-01-01T00:00:00Z",
            );
            assertion.observed_at = Some("2020-01-01T00:00:00Z".into());
            state.assertion_facets.insert(event.into(), assertion);
        }
        state.beliefs.get_mut(B_ONE).unwrap().qualification = Qualification::Qualified;
        state
    }

    #[test]
    fn the_shipped_artifact_loads_and_its_digest_is_over_the_bytes_that_ship() {
        let definitions = load().expect("the shipped lanes");
        assert_eq!(definitions.rule_version, "lanes-v1");
        assert_eq!(
            definitions.order(),
            ["contradiction", "blindness", "staleness", "epistemic_debt"]
        );
        assert_eq!(
            sha256_hex(LANES_JSON.as_bytes()),
            LANES_DIGEST.trim(),
            "regenerate shared/policy/lanes.v1.sha256"
        );
    }

    #[test]
    fn an_open_edge_and_an_unclassified_declaration_are_both_the_contradiction_lane() {
        // The second half is the one that goes missing. A declaration nobody
        // has classified is not a declaration nobody made.
        let mut state = standing();
        let edge_id = "e".repeat(32);
        state.contradiction_edges.insert(
            edge_id.clone(),
            crate::ledger::reduce::ContradictionEdgeRow {
                edge_id: edge_id.clone(),
                comparison_id: "c".repeat(32),
                kind: EdgeKind::GenuineDirect,
                left_belief_id: B_ONE.into(),
                right_belief_id: B_TWO.into(),
                opened_event_id: "1".repeat(32),
                classified_event_id: "2".repeat(32),
                closed: None,
            },
        );
        relate(
            &mut state,
            &"r".repeat(32),
            B_TWO,
            B_ONE,
            RelationKind::Contradicts,
            true,
        );

        let out = run(&state, &[]);
        let lane: Vec<&Item> = out.of(Lane::Contradiction).collect();
        assert_eq!(lane.len(), 2);
        assert_eq!(lane[0].reasons, vec![Reason::OpenEdgeGenuineDirect]);
        assert_eq!(lane[0].edge_id.as_deref(), Some(edge_id.as_str()));
        assert_eq!(lane[1].reasons, vec![Reason::LegacyUnclassified]);
        assert!(lane[1].relation_id.is_some());
        assert!(
            lane[0].edge_id.is_some() && lane[1].edge_id.is_none(),
            "the two halves stay distinguishable"
        );
    }

    #[test]
    fn a_closed_edge_is_not_in_the_lane_and_a_classified_declaration_is_not_either() {
        let mut state = standing();
        let edge_id = "e".repeat(32);
        state.contradiction_edges.insert(
            edge_id.clone(),
            crate::ledger::reduce::ContradictionEdgeRow {
                edge_id: edge_id.clone(),
                comparison_id: "c".repeat(32),
                kind: EdgeKind::Partial,
                left_belief_id: B_ONE.into(),
                right_belief_id: B_TWO.into(),
                opened_event_id: "1".repeat(32),
                classified_event_id: "2".repeat(32),
                closed: Some(crate::ledger::reduce::EdgeClosure {
                    event_id: "3".repeat(32),
                    addressed_by_event_id: "4".repeat(32),
                    disposition: crate::ledger::schema::CloseDisposition::ResolvedWithEvidence,
                    evidence_event_ids: vec![],
                }),
            },
        );
        assert_eq!(run(&state, &[]).of(Lane::Contradiction).count(), 0);
    }

    #[test]
    fn blindness_detects_without_asking_whether_anybody_relies_on_it() {
        // The filter that must not exist. A blind spot nobody is standing on
        // is exactly the one nobody has noticed.
        let mut state = standing();
        state.beliefs.get_mut(B_ONE).unwrap().qualification = Qualification::Draft;
        let out = run(&state, &[]);
        let blind: Vec<&Item> = out.of(Lane::Blindness).collect();
        assert!(!blind.is_empty(), "an unrelied-upon blind spot still shows");
        assert!(blind.iter().all(|item| item.reliance.is_empty()));
        assert_eq!(blind[0].reasons, vec![Reason::CoverageUnassessed]);
    }

    #[test]
    fn reliance_orders_the_blindness_lane_rather_than_filtering_it() {
        let state = standing(); // B_ONE qualified, B_TWO not
        let out = run(&state, &[]);
        let blind: Vec<&Item> = out.of(Lane::Blindness).collect();
        assert_eq!(blind.len(), 2, "both beliefs are blind");
        assert_eq!(
            blind[0].belief_id, B_ONE,
            "the one something stands on sorts first"
        );
        assert!(blind[1].reliance.is_empty());
    }

    #[test]
    fn staleness_does_not_care_whether_the_belief_is_also_contested() {
        // The independence the spec asks for by name: a stale truth is still
        // a truth, and a contested one is a different problem.
        let mut state = standing();
        relate(
            &mut state,
            &"r".repeat(32),
            B_ONE,
            B_TWO,
            RelationKind::Contradicts,
            true,
        );
        let out = run(&state, &[]);
        let stale: Vec<&Item> = out.of(Lane::Staleness).collect();
        assert_eq!(stale.len(), 1);
        assert_eq!(stale[0].belief_id, B_ONE);
        assert_eq!(stale[0].reasons, vec![Reason::FreshnessStale]);
        assert_eq!(stale[0].predicate.as_deref(), Some("ci_status"));
    }

    #[test]
    fn debt_needs_reliance_and_says_every_reason_it_found() {
        let state = standing();
        let out = run(&state, &[]);
        let debt: Vec<&Item> = out.of(Lane::EpistemicDebt).collect();
        assert_eq!(debt.len(), 1, "only the belief the base stands behind");
        assert_eq!(debt[0].belief_id, B_ONE);
        assert_eq!(debt[0].reliance, vec![Reliance::Qualified]);
        assert_eq!(
            debt[0].reasons,
            vec![
                Reason::NoAuthorityRouteDeclared,
                Reason::StaleEvidence,
                Reason::CoverageNotObserved
            ],
            "in the artifact's declared order, and every one that applied"
        );
    }

    #[test]
    fn a_parked_promotion_is_reliance_and_a_debt_reason_at_once() {
        // M24 refused a promotion: somebody wanted the base to stand behind
        // this. That is the only reliance signal a draft can have, and
        // without it the debt lane would never see the item M24 parked
        // precisely so it would be seen.
        let mut state = standing();
        state.beliefs.get_mut(B_ONE).unwrap().qualification = Qualification::Draft;
        let parked = [ParkedPromotion {
            belief_id: B_ONE.into(),
            missing_roles: vec!["owner".into()],
        }];
        let out = run(&state, &parked);
        let debt: Vec<&Item> = out.of(Lane::EpistemicDebt).collect();
        assert_eq!(debt.len(), 1);
        assert_eq!(debt[0].reliance, vec![Reliance::PromotionAttempted]);
        assert!(debt[0].reasons.contains(&Reason::PromotionBlocked));
    }

    #[test]
    fn a_refined_belief_is_relied_on_and_the_refinement_is_not() {
        // Direction matters: `from` refines `to`, so the thing being built
        // ON is the one something depends on.
        let mut state = standing();
        state.beliefs.get_mut(B_ONE).unwrap().qualification = Qualification::Draft;
        state.beliefs.get_mut(B_TWO).unwrap().qualification = Qualification::Draft;
        relate(
            &mut state,
            &"r".repeat(32),
            B_TWO,
            B_ONE,
            RelationKind::Refines,
            true,
        );
        let index = reliance_index(&state, &[]);
        assert_eq!(index.get(B_ONE), Some(&vec![Reliance::RefinedBy]));
        assert_eq!(index.get(B_TWO), None);
    }

    #[test]
    fn one_belief_can_be_in_three_lanes_and_that_is_not_a_bug() {
        // Collapsing them into a worst-of would throw away the fact that
        // these are three problems with three different remedies.
        let mut state = standing();
        let edge_id = "e".repeat(32);
        state.contradiction_edges.insert(
            edge_id.clone(),
            crate::ledger::reduce::ContradictionEdgeRow {
                edge_id,
                comparison_id: "c".repeat(32),
                kind: EdgeKind::Conditional,
                left_belief_id: B_ONE.into(),
                right_belief_id: B_TWO.into(),
                opened_event_id: "1".repeat(32),
                classified_event_id: "2".repeat(32),
                closed: None,
            },
        );
        let out = run(&state, &[]);
        let mine: BTreeSet<Lane> = out
            .items
            .iter()
            .filter(|item| item.belief_id == B_ONE)
            .map(|item| item.lane)
            .collect();
        assert_eq!(
            mine,
            BTreeSet::from([
                Lane::Contradiction,
                Lane::Blindness,
                Lane::Staleness,
                Lane::EpistemicDebt
            ])
        );
    }

    #[test]
    fn the_order_is_the_artifacts_and_two_runs_agree() {
        let state = standing();
        let first = run(&state, &[]);
        let second = run(&state, &[]);
        assert_eq!(first, second, "deterministic");
        let order: Vec<&str> = first.items.iter().map(|i| i.lane.as_str()).collect();
        let mut sorted = order.clone();
        sorted.sort_by_key(|lane| {
            ["contradiction", "blindness", "staleness", "epistemic_debt"]
                .iter()
                .position(|declared| declared == lane)
                .unwrap()
        });
        assert_eq!(order, sorted, "lanes come back in the artifact's order");
    }

    #[test]
    fn a_quiet_base_says_nothing_at_all() {
        // Nothing speaks first. A base with no problems produces no items —
        // not a row saying there are none.
        let mut state = base();
        state.beliefs.remove(B_ONE);
        state.beliefs.remove(B_TWO);
        let out = run(&state, &[]);
        assert_eq!(out.items, vec![]);
        assert_eq!(out.rule_version, "lanes-v1");
    }

    #[test]
    fn a_facet_the_attestation_covers_is_still_stale_if_its_evidence_is() {
        // Review is not freshness. Somebody looking at a claim does not make
        // the evidence under it newer.
        let mut state = standing();
        state.beliefs.get_mut(B_ONE).unwrap().attested =
            Some(("a".repeat(32), REV_ONE.to_string()));
        assert_eq!(run(&state, &[]).of(Lane::Staleness).count(), 1);
    }

    /// Regenerate `shared/policy/lanes.v1.sha256` after a DELIBERATE edit.
    #[test]
    #[ignore = "regeneration is a deliberate act — run with --ignored after editing the artifact"]
    fn write_lanes_digest() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../shared/policy/lanes.v1.sha256");
        std::fs::write(&path, format!("{}\n", sha256_hex(LANES_JSON.as_bytes()))).unwrap();
    }
}
