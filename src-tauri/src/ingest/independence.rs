//! The two deterministic positive-independence producers (M25.5).
//!
//! **No event means unknown, never independent.** M22 built the primitive
//! that way; this is the only thing in the build that produces a positive
//! one, and it produces exactly two proofs:
//!
//! - `distinct_firsthand_origin` — two people said it, firsthand, under two
//!   different pinned human registrations;
//! - `independent_system_artifact` — two registered direct artifacts from
//!   different independence domains with different source bytes.
//!
//! **Distinct source ids, connector names, files, or hashes alone never
//! suffice.** Two exports of the same upstream system are two files and one
//! observation; counting them as corroboration would let a copy vouch for its
//! original, which is the failure independence exists to prevent. That is why
//! the artifact demands a distinct independence DOMAIN and not merely a
//! distinct source.
//!
//! ## Why the predicates live in an artifact and the reducer does not read it
//!
//! `shared/policy/independence-rules.v1.json` is loaded here, byte-checked
//! against its committed digest, and the `rule_version` it declares is pinned
//! into every event this module emits. The REDUCER deliberately does not load
//! it: it validates that a proof carries a non-empty `rule_version` and
//! nothing more. If reducer validation depended on the artifact's contents,
//! every conformance vector's expected refusals would become
//! artifact-version-dependent, and a rule-version bump would rewrite the
//! parity contract for reasons that have nothing to do with parity. The
//! artifact governs PRODUCTION; the vectors govern agreement.

use serde::Deserialize;

use crate::ledger::reduce::EpistemicState;
use crate::ledger::schema::{
    AssertionBasis, AuthorityCapability, AuthorityProvenance, IndependenceProof,
};

const RULES_JSON: &str = include_str!("../../../shared/policy/independence-rules.v1.json");
const RULES_DIGEST: &str = include_str!("../../../shared/policy/independence-rules.v1.sha256");

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Predicate {
    pub authority_provenance: String,
    pub assertion_basis: Option<String>,
    pub registration_kind: Option<String>,
    #[serde(default)]
    pub authority_capability: Option<String>,
    pub require_distinct_bound_actor: bool,
    pub require_distinct_independence_domain: bool,
    pub require_distinct_source_artifact_hash: bool,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Rules {
    pub format: u64,
    /// Bumped by ANY predicate change, and pinned by every event this module
    /// emits — so an edge recorded last month can still be read against the
    /// rule that produced it.
    pub rule_version: u64,
    pub distinct_firsthand_origin: Predicate,
    pub independent_system_artifact: Predicate,
}

/// Load the artifact, checking its bytes against the committed digest.
pub fn rules() -> Result<Rules, String> {
    let expected = RULES_DIGEST.trim();
    let actual = crate::ledger::sha256_hex(RULES_JSON.as_bytes());
    if actual != expected {
        return Err(format!(
            "shared/policy/independence-rules.v1.json hashes to {actual}, and the committed \
             digest says {expected} — regenerate deliberately, and bump rule_version if a \
             predicate moved"
        ));
    }
    let rules: Rules =
        serde_json::from_str(RULES_JSON).map_err(|e| format!("independence rules: {e}"))?;
    if rules.format != 1 {
        return Err(format!(
            "independence rules artifact is format {}, this build speaks 1",
            rules.format
        ));
    }
    Ok(rules)
}

/// One endpoint of a candidate independence pair, as the reducer knows it.
#[derive(Debug, Clone, PartialEq)]
pub struct Endpoint {
    pub observation_event_id: String,
    pub source_registration_event_id: String,
    pub authority: Option<AuthorityProvenance>,
    pub assertion_basis: Option<AssertionBasis>,
    pub registration_kind: &'static str,
    pub capability: AuthorityCapability,
    pub bound_actor_id: Option<String>,
    pub independence_domain_id: Option<String>,
    pub source_artifact_hash: Option<String>,
}

fn provenance_name(provenance: Option<AuthorityProvenance>) -> &'static str {
    match provenance {
        Some(AuthorityProvenance::TrustedHumanCapture) => "trusted_human_capture",
        Some(AuthorityProvenance::RegisteredDirectArtifact) => "registered_direct_artifact",
        Some(AuthorityProvenance::AgentInferred) => "agent_inferred",
        None => "",
    }
}

fn basis_name(basis: Option<AssertionBasis>) -> &'static str {
    match basis {
        Some(AssertionBasis::Firsthand) => "firsthand",
        Some(AssertionBasis::ResponsibleOwner) => "responsible_owner",
        Some(AssertionBasis::Reported) => "reported",
        Some(AssertionBasis::Inferred) => "inferred",
        Some(AssertionBasis::Unknown) => "unknown",
        None => "",
    }
}

fn capability_name(capability: AuthorityCapability) -> &'static str {
    match capability {
        AuthorityCapability::ContentOnly => "content_only",
        AuthorityCapability::HumanAssertion => "human_assertion",
        AuthorityCapability::DirectSystemArtifact => "direct_system_artifact",
    }
}

fn satisfies(predicate: &Predicate, endpoint: &Endpoint) -> bool {
    if provenance_name(endpoint.authority) != predicate.authority_provenance {
        return false;
    }
    if let Some(basis) = &predicate.assertion_basis {
        if basis_name(endpoint.assertion_basis) != basis {
            return false;
        }
    }
    if let Some(kind) = &predicate.registration_kind {
        if endpoint.registration_kind != kind {
            return false;
        }
    }
    if let Some(capability) = &predicate.authority_capability {
        if capability_name(endpoint.capability) != capability {
            return false;
        }
    }
    true
}

/// Does the pair satisfy this predicate's DISTINCTNESS requirements?
///
/// Every required field must be present on BOTH sides and different. A
/// missing domain or hash is not "probably different" — it is unknown, and
/// unknown never produces a positive fact.
fn distinct(predicate: &Predicate, left: &Endpoint, right: &Endpoint) -> bool {
    let pairs: [(bool, &Option<String>, &Option<String>); 3] = [
        (
            predicate.require_distinct_bound_actor,
            &left.bound_actor_id,
            &right.bound_actor_id,
        ),
        (
            predicate.require_distinct_independence_domain,
            &left.independence_domain_id,
            &right.independence_domain_id,
        ),
        (
            predicate.require_distinct_source_artifact_hash,
            &left.source_artifact_hash,
            &right.source_artifact_hash,
        ),
    ];
    pairs.iter().all(|(required, a, b)| {
        if !*required {
            return true;
        }
        match (a, b) {
            (Some(a), Some(b)) => a != b,
            _ => false,
        }
    })
}

/// The proof this pair earns, if any.
///
/// Returns `None` for every failure — a failed positive condition emits
/// nothing at all and leaves the verdict `independence_unknown`. There is no
/// "weak" outcome, by construction.
pub fn proof_for(
    rules: &Rules,
    state: &EpistemicState,
    left: &Endpoint,
    right: &Endpoint,
) -> Option<IndependenceProof> {
    if left.observation_event_id == right.observation_event_id {
        return None;
    }
    if left.source_registration_event_id == right.source_registration_event_id {
        // Two assertions under ONE registration are one origin, whatever
        // else differs about them.
        return None;
    }
    // Shared ancestry disqualifies both proofs: a derivation of a claim is
    // not a second witness to it.
    if shares_ancestry(
        state,
        &left.observation_event_id,
        &right.observation_event_id,
    ) {
        return None;
    }
    let version = rules.rule_version.to_string();
    let candidates = [
        (
            &rules.distinct_firsthand_origin,
            true, // firsthand variant
        ),
        (&rules.independent_system_artifact, false),
    ];
    for (predicate, firsthand) in candidates {
        if satisfies(predicate, left)
            && satisfies(predicate, right)
            && distinct(predicate, left, right)
        {
            // Canonical unordered pair order: the smaller registration ref is
            // the left. Two callers who saw the same pair in opposite orders
            // must produce the same event.
            let (a, b) = if left.source_registration_event_id <= right.source_registration_event_id
            {
                (
                    left.source_registration_event_id.clone(),
                    right.source_registration_event_id.clone(),
                )
            } else {
                (
                    right.source_registration_event_id.clone(),
                    left.source_registration_event_id.clone(),
                )
            };
            return Some(if firsthand {
                IndependenceProof::DistinctFirsthandOrigin {
                    left_source_registration_event_id: a,
                    right_source_registration_event_id: b,
                    rule_version: version,
                }
            } else {
                IndependenceProof::IndependentSystemArtifact {
                    left_source_registration_event_id: a,
                    right_source_registration_event_id: b,
                    rule_version: version,
                }
            });
        }
    }
    None
}

/// Is either Observation an ancestor of the other?
///
/// Walks the lineage graph both ways. A derivation is not a second witness;
/// counting it as one is precisely how a single source becomes "corroborated"
/// by its own restatement.
fn shares_ancestry(state: &EpistemicState, left: &str, right: &str) -> bool {
    reaches(state, left, right) || reaches(state, right, left)
}

fn reaches(state: &EpistemicState, from: &str, target: &str) -> bool {
    let mut seen = std::collections::BTreeSet::new();
    let mut stack = vec![from.to_string()];
    while let Some(current) = stack.pop() {
        if current == target {
            return true;
        }
        if !seen.insert(current.clone()) {
            continue;
        }
        if let Some(observation) = state.observations.get(&current) {
            for (_, parent) in &observation.lineage_parents {
                stack.push(parent.clone());
            }
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn human(id: &str, registration: &str, actor: &str) -> Endpoint {
        Endpoint {
            observation_event_id: id.into(),
            source_registration_event_id: registration.into(),
            authority: Some(AuthorityProvenance::TrustedHumanCapture),
            assertion_basis: Some(AssertionBasis::Firsthand),
            registration_kind: "human_actor",
            capability: AuthorityCapability::HumanAssertion,
            bound_actor_id: Some(actor.into()),
            independence_domain_id: None,
            source_artifact_hash: None,
        }
    }

    fn artifact(id: &str, registration: &str, domain: &str, hash: &str) -> Endpoint {
        Endpoint {
            observation_event_id: id.into(),
            source_registration_event_id: registration.into(),
            authority: Some(AuthorityProvenance::RegisteredDirectArtifact),
            assertion_basis: Some(AssertionBasis::Reported),
            registration_kind: "connector",
            capability: AuthorityCapability::DirectSystemArtifact,
            bound_actor_id: None,
            independence_domain_id: Some(domain.into()),
            source_artifact_hash: Some(hash.into()),
        }
    }

    #[test]
    fn the_artifact_bytes_are_pinned_and_the_version_is_what_events_carry() {
        let rules = rules().expect("the committed digest must match the artifact");
        assert_eq!(rules.format, 1);
        assert_eq!(rules.rule_version, 1);
    }

    #[test]
    fn two_people_saying_it_firsthand_is_independence() {
        let rules = rules().unwrap();
        let state = EpistemicState::default();
        let proof = proof_for(
            &rules,
            &state,
            &human("a".repeat(32).as_str(), "r1", "human:josef"),
            &human("b".repeat(32).as_str(), "r2", "human:maya"),
        )
        .expect("two distinct firsthand humans");
        assert!(matches!(
            proof,
            IndependenceProof::DistinctFirsthandOrigin { ref rule_version, .. }
                if rule_version == "1"
        ));
    }

    #[test]
    fn one_person_saying_it_twice_is_not_two_witnesses() {
        let rules = rules().unwrap();
        let state = EpistemicState::default();
        assert_eq!(
            proof_for(
                &rules,
                &state,
                &human("a".repeat(32).as_str(), "r1", "human:josef"),
                &human("b".repeat(32).as_str(), "r2", "human:josef"),
            ),
            None
        );
    }

    #[test]
    fn one_registration_is_one_origin_however_much_else_differs() {
        let rules = rules().unwrap();
        let state = EpistemicState::default();
        assert_eq!(
            proof_for(
                &rules,
                &state,
                &human("a".repeat(32).as_str(), "r1", "human:josef"),
                &human("b".repeat(32).as_str(), "r1", "human:maya"),
            ),
            None
        );
    }

    #[test]
    fn two_artifacts_need_different_domains_and_different_bytes() {
        let rules = rules().unwrap();
        let state = EpistemicState::default();
        let left = artifact("a".repeat(32).as_str(), "r1", "domain-a", "h1");

        // Different domain, different bytes: independence.
        assert!(proof_for(
            &rules,
            &state,
            &left,
            &artifact("b".repeat(32).as_str(), "r2", "domain-b", "h2"),
        )
        .is_some());

        // Same domain: two exports of one upstream system.
        assert_eq!(
            proof_for(
                &rules,
                &state,
                &left,
                &artifact("b".repeat(32).as_str(), "r2", "domain-a", "h2"),
            ),
            None
        );

        // Different domain, IDENTICAL bytes: a copy, not a second witness.
        assert_eq!(
            proof_for(
                &rules,
                &state,
                &left,
                &artifact("b".repeat(32).as_str(), "r2", "domain-b", "h1"),
            ),
            None
        );
    }

    #[test]
    fn an_absent_domain_is_unknown_and_unknown_never_produces_a_positive_fact() {
        let rules = rules().unwrap();
        let state = EpistemicState::default();
        let mut right = artifact("b".repeat(32).as_str(), "r2", "domain-b", "h2");
        right.independence_domain_id = None;
        assert_eq!(
            proof_for(
                &rules,
                &state,
                &artifact("a".repeat(32).as_str(), "r1", "domain-a", "h1"),
                &right,
            ),
            None
        );
    }

    #[test]
    fn an_agent_inferred_endpoint_earns_nothing() {
        // D11 in one assertion: an agent's own claim that its assertion is
        // firsthand is a claim, and it never becomes proof.
        let rules = rules().unwrap();
        let state = EpistemicState::default();
        let mut left = human("a".repeat(32).as_str(), "r1", "human:josef");
        left.authority = Some(AuthorityProvenance::AgentInferred);
        assert_eq!(
            proof_for(
                &rules,
                &state,
                &left,
                &human("b".repeat(32).as_str(), "r2", "human:maya"),
            ),
            None
        );
    }

    #[test]
    fn the_pair_order_does_not_change_the_event() {
        // Canonical unordered order: two callers who saw the same pair in
        // opposite orders must emit identical bytes, or a retry would append
        // a second edge for one fact.
        let rules = rules().unwrap();
        let state = EpistemicState::default();
        let a = human("a".repeat(32).as_str(), "r1", "human:josef");
        let b = human("b".repeat(32).as_str(), "r2", "human:maya");
        assert_eq!(
            proof_for(&rules, &state, &a, &b),
            proof_for(&rules, &state, &b, &a)
        );
    }
}
