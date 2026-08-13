//! The state-dependent predicates (M24.5) — expected-version CAS and the
//! pre-append re-resolution pass.
//!
//! **Approval is authorization, not a snapshot of the world.** A human who
//! approves a queued card is saying "yes, do that"; they are not freezing
//! the vault until they get around to clicking. So every predicate here runs
//! TWICE — once when the set is decided and again immediately before the
//! batch appends — and a set whose ground moved in between is rejected with
//! a code, not silently applied against a world nobody looked at.
//!
//! What that catches is exactly what target-id CAS alone cannot see: the
//! duplicate created while the card sat in the queue, and the evidence that
//! stopped resolving. Refreshing the immutable proposal in place would be
//! the tempting fix and the wrong one — the record would then say a human
//! approved something they never read.
//!
//! **Which predicates run is data.** The op's `requires` list in
//! `policy.v1.json` names them and fixes their precedence; this module
//! dispatches on those names. A predicate the table requires and nothing
//! evaluates would be a rule that looks like protection, so `PREDICATE_OWNERS`
//! names every one and the phase that implements it, and a tripwire proves
//! the two lists are the same set.

use crate::ledger::reduce::EpistemicState;
use crate::ledger::schema::{ProposalOp, ProposalV1, TypedValue};

use super::table::PolicyTable;

/// A precondition that no longer holds.
///
/// Boxed at every `Result` boundary: the failure carries two `TypedValue`s
/// so a card can say what it expected and what it found, which makes it far
/// larger than the `Ok` case that dominates every call.
pub type PreconditionResult = Result<(), Box<PreconditionFailure>>;

#[derive(Debug, Clone, PartialEq)]
pub struct PreconditionFailure {
    /// A `rejection_destinies` key.
    pub code: &'static str,
    /// The predicate that refused — a `predicates` entry, so the card can
    /// name the rule and not just the symptom.
    pub rule: &'static str,
    pub expected: TypedValue,
    pub actual: TypedValue,
}

/// Every predicate the table can require, and what evaluates it.
///
/// `None` means "declared, not yet evaluated" WITH the phase that owns it.
/// The point is that a gap is visible in one list rather than inferred from
/// the absence of a branch.
pub const PREDICATE_OWNERS: &[(&str, Option<&str>)] = &[
    ("absence_coverage_complete", Some("M24.8")),
    ("actor_matches_run", Some("M24.5")),
    ("alias_unbound", Some("M24.4")), // expand: alias_collision
    ("basis_refs_valid", Some("M24.5")),
    ("candidate_receipt_current", Some("M24.7")), // §15: mint, authorship, staleness
    ("conflict_capability_available", Some("M24.1")), // the table's capability stage
    ("exact_equivalence_proven", Some("M24.3")),  // EquivalenceReceipt::validate
    ("high_stakes_route_satisfied", Some("M24.8")),
    ("independence_confirmable", Some("M24.4")), // expand: server-bound proof
    ("no_self_ancestry", Some("M26.3")),         // ancestry::no_self_ancestry
    ("open_contradictions_addressed", Some("M27.4")),
    ("qualification_roles_present", Some("M24.6")),
    ("revert_current_and_invertible", Some("M24.4")), // expand: revert_not_*
    ("silence_transition_allowed", Some("M24.1")),    // the table's silence stage
    ("subject_correction_current", Some("M24.4")),    // expand: subject_resolution_*
    ("target_set_exact", Some("M26.3")), // classes: the table stage; ids: target_set_bound
    ("trusted_observation_provenance", Some("M24.3")), // AgentObservationDraft
    ("versions_current", Some("M24.5")),
];

/// What the binding predicate needs that a proposal does not carry: the
/// world its expansion would run against.
///
/// The staged sets matter. A commit set that creates a Belief and then links
/// it is the most ordinary thing an agent proposes, and without them the
/// second member's expansion would refuse `invalid_reference` against a
/// snapshot taken before its own set ran — the case atomic sets exist for.
/// They accumulate in member order, exactly as `commit.rs` accumulates them
/// for the real expansion.
pub struct TargetBinding<'a> {
    pub actor: &'a crate::ledger::schema::Actor,
    pub staged_beliefs: &'a std::collections::BTreeSet<String>,
    pub staged_entities: &'a std::collections::BTreeSet<String>,
    /// The approving decision, at the pre-append run. `None` at set-decision
    /// time, which is why an op whose expansion needs one binds on the
    /// second pass rather than the first.
    pub decision_event_id: Option<String>,
}

/// Every 128-bit hex id the op's payload NAMES, as a caller typed it.
///
/// The distinction this draws is the whole reason the rule is satisfiable.
/// Some write targets are SERVER-DERIVED — a relation id is
/// `sha256("cerebro-relation-v1\0" ++ canonical_json([from, to, kind]))`, and
/// no tool hands a caller a way to compute one. Requiring those in `targets`
/// would make `supersede_belief`, `split_belief`, and both merges
/// unproposable by anything except code that already imports the hasher.
///
/// A derived id is also not an attack surface: it is a pure function of ids
/// the payload already names, so a caller cannot aim it somewhere else
/// without changing the ids it is aimed from — which this rule does check.
fn ids_the_payload_names(op: &ProposalOp) -> std::collections::BTreeSet<String> {
    fn walk(value: &serde_json::Value, out: &mut std::collections::BTreeSet<String>) {
        match value {
            serde_json::Value::String(text) if crate::ledger::schema::is_id128(text) => {
                out.insert(text.clone());
            }
            serde_json::Value::Array(items) => items.iter().for_each(|item| walk(item, out)),
            serde_json::Value::Object(map) => map.values().for_each(|item| walk(item, out)),
            _ => {}
        }
    }
    let mut found = std::collections::BTreeSet::new();
    if let Ok(value) = serde_json::to_value(op) {
        walk(&value, &mut found);
    }
    found
}

/// **The target-binding rule (M26.3d).** Every `(class, id)` the op's own
/// expansion would ADVANCE, whose id the payload names, must appear in
/// `targets`.
///
/// This is the predicate whose name has promised id-level protection since
/// M24.1 while only classes were ever checked. What it stops: a caller
/// declaring a harmless target — a fresh id with `expected_version: null`,
/// which reads as a creation and so passes CAS — while the payload revises
/// something else entirely. Both risk escalators and the CAS read `targets`;
/// the mutation comes from `op`. Unbound, an agent could revise a
/// human-ATTESTED Belief and never trip `target_has_attestation`, so a HIGH
/// card would auto-apply at MEDIUM.
///
/// CONTAINMENT, not equality. Extra declared targets stay legal: a target an
/// op only reads keeps its version, and `commit.rs` is built to make a read
/// legible as a read. Extra targets can only widen CAS and turn MORE
/// escalators on, never fewer — they cost the caller, they do not buy it
/// anything.
fn target_set_bound(
    state: &EpistemicState,
    proposal: &ProposalV1,
    binding: &TargetBinding,
) -> PreconditionResult {
    let ctx = super::expand::ExpansionContext {
        actor: binding.actor.clone(),
        state,
        // Only shifts symbolic same-batch member references, never the
        // write set.
        base_ordinal: 0,
        decision_event_id: binding.decision_event_id.clone(),
        proposal_id: proposal.proposal_id.clone(),
        staged_beliefs: binding.staged_beliefs.clone(),
        staged_entities: binding.staged_entities.clone(),
        // The write set this binds against MUST include the closes: their
        // comparison and endpoint Beliefs are CAS targets, and a target set
        // that omitted them would let a merge run against an edge whose
        // Belief moved underneath it.
        addressed_contradictions: proposal.basis.addressed_contradictions.clone(),
    };
    // A plan that cannot be built writes nothing, so there is nothing to
    // bind. The refusal stays owned by the layer where expansion is
    // authoritative, which keeps one code coming from one place.
    let Ok(writes) = super::expand::write_targets_of(&proposal.op, &ctx) else {
        return Ok(());
    };

    let named = ids_the_payload_names(&proposal.op);
    let declared: std::collections::BTreeSet<(&str, &str)> = proposal
        .targets
        .iter()
        .map(|target| (target.target_class.as_str(), target.target_id.as_str()))
        .collect();

    for (class, id) in &writes {
        if !named.contains(id) {
            continue; // server-derived: the caller could not have aimed it
        }
        if !declared.contains(&(class.as_str(), id.as_str())) {
            return Err(Box::new(PreconditionFailure {
                code: "target_set_mismatch",
                rule: "target_set_exact",
                expected: TypedValue::string(&format!("{}/{id} among the targets", class.as_str())),
                actual: TypedValue::string("a target set that does not name what this op changes"),
            }));
        }
    }
    Ok(())
}

fn version_token(class: &str, id: &str, version: Option<u64>) -> TypedValue {
    match version {
        Some(version) => TypedValue::string(&format!("{class}/{id}@{version}")),
        None => TypedValue::string(&format!("{class}/{id}@absent")),
    }
}

/// Expected-version CAS over M22's `state_versions`.
///
/// A ledger-entity concept, never a file concept: `expected_version` is null
/// ONLY for something this proposal creates, and a null against a target that
/// already exists is a blind write wearing a compare-and-swap's clothes.
pub fn versions_current(state: &EpistemicState, proposal: &ProposalV1) -> PreconditionResult {
    for target in &proposal.targets {
        let class = target.target_class.as_str();
        let actual = state.version(class, &target.target_id);
        let agrees = match (target.expected_version, actual) {
            (Some(expected), Some(actual)) => expected == actual,
            // A creation: the target must not exist yet.
            (None, None) => true,
            _ => false,
        };
        if !agrees {
            return Err(Box::new(PreconditionFailure {
                code: "stale_target_version",
                rule: "versions_current",
                expected: version_token(class, &target.target_id, target.expected_version),
                actual: version_token(class, &target.target_id, actual),
            }));
        }
    }
    Ok(())
}

/// Every evidence and authority reference still resolves.
///
/// Evidence refs name committed Observations; authority refs are a subset of
/// them (the schema proves that inclusion). A pinned authority ROUTE must
/// still be readable by this build — a proposal that pinned an artifact no
/// build can load names a rule nothing can evaluate.
fn basis_refs_valid(state: &EpistemicState, proposal: &ProposalV1) -> PreconditionResult {
    for reference in &proposal.basis.evidence_refs {
        if !state.observations.contains_key(reference) {
            return Err(Box::new(PreconditionFailure {
                code: "invalid_reference",
                rule: "basis_refs_valid",
                expected: TypedValue::string("a committed observation"),
                actual: TypedValue::string(reference),
            }));
        }
    }
    let artifacts = super::authority::resolvable().map_err(|detail| PreconditionFailure {
        code: "invalid_reference",
        rule: "basis_refs_valid",
        expected: TypedValue::string("a loadable authority artifact"),
        actual: TypedValue::string(&detail),
    })?;
    for reference in &proposal.basis.authority_route_refs {
        if super::authority::AuthorityRoutesV1::resolve(&artifacts, reference).is_none() {
            return Err(Box::new(PreconditionFailure {
                code: "invalid_reference",
                rule: "basis_refs_valid",
                expected: TypedValue::string("a resolvable pinned authority route"),
                actual: TypedValue::string(&format!(
                    "{}@{}/{}",
                    reference.authority_route_id,
                    reference.authority_rule_version,
                    reference.artifact_hash
                )),
            }));
        }
    }
    Ok(())
}

/// §15 in one predicate: the candidate search, repeated at the CURRENT head
/// (M24.7).
///
/// A create is the one mutation with no target to compare against, so its
/// protection is a RECEIPT — proof the server looked for what already exists
/// before agreeing this is new. Four things can be wrong with one, and each
/// has its own code because they mean different things to whoever reads the
/// card:
///
/// - **missing** — created without looking. Ledger, not schema: "the agent
///   did not search" is exactly the epistemic history this milestone exists
///   to keep, and refusing it as a malformed argument would file it in the
///   operational log with the typos.
/// - **caller-authored** — the receipt asserts a search this server would
///   not produce. A caller cannot be prevented from writing JSON; what it
///   cannot do is make that JSON survive being recomputed here.
/// - **stale** — the world moved. Something now exists that the search never
///   saw, which is the window target-id CAS cannot see: a duplicate created
///   while the card sat in the queue.
/// - **unconsidered** — the search surfaced a candidate and the proposal
///   never says what it decided about it. Worse than no search: it looks
///   like diligence.
///
/// The immutable proposal is never silently refreshed — a re-minted receipt
/// under the old id would make the record say a human approved a search they
/// never saw.
fn candidate_receipt_current(state: &EpistemicState, proposal: &ProposalV1) -> PreconditionResult {
    let ProposalOp::CreateBelief {
        subject, content, ..
    } = &proposal.op
    else {
        return Ok(());
    };
    let refuse = |code: &'static str, expected: TypedValue, actual: TypedValue| {
        Box::new(PreconditionFailure {
            code,
            rule: "candidate_receipt_current",
            expected,
            actual,
        })
    };

    let Some(receipt) = &proposal.candidate_search_receipt else {
        return Err(refuse(
            "candidate_receipt_missing",
            TypedValue::string("a server-minted candidate search"),
            TypedValue::Missing,
        ));
    };
    let subject_id = match subject {
        crate::ledger::schema::SubjectRef::Resolved { entity_id, .. } => entity_id.clone(),
        // An unresolved subject cannot be searched for; the op's own
        // validation already refuses one on a create.
        _ => return Ok(()),
    };

    // AUTHORSHIP. The id is a digest of the legs, so recomputing it says
    // whether these legs and this id were ever minted together.
    let derived = super::candidates::derive_receipt_id(receipt).map_err(|detail| {
        refuse(
            "candidate_receipt_caller_authored",
            TypedValue::string("a receipt this build can digest"),
            TypedValue::string(&detail),
        )
    })?;
    if derived != receipt.receipt_id {
        return Err(refuse(
            "candidate_receipt_caller_authored",
            TypedValue::string(&derived),
            TypedValue::string(&receipt.receipt_id),
        ));
    }
    if receipt.search_version != super::candidates::SEARCH_VERSION {
        // A receipt from a search this build no longer runs is not a search
        // this build can vouch for.
        return Err(refuse(
            "candidate_receipt_caller_authored",
            TypedValue::string(&super::candidates::SEARCH_VERSION.to_string()),
            TypedValue::string(&receipt.search_version.to_string()),
        ));
    }

    // THE QUERY THE RECEIPT SEARCHED WITH IS THE ONE THIS PROPOSAL CARRIES
    // (M26.2). The deterministic legs record their own queries, but the
    // semantic leg expands over the proposed CONTENT, and content is not
    // stored on the receipt — so without this, a caller could mint against
    // innocuous prose and then attach the receipt to a proposal saying
    // something else entirely. The fingerprint is server-derived from the
    // subject, the normalized content, and the claimed spellings; if it
    // disagrees, this receipt is a real search wearing another proposal's
    // clothes.
    if let Some(claimed) = &receipt.semantic.query_fingerprint {
        let actual = crate::retrieval::query_fingerprint(&crate::retrieval::Query {
            subject_id: &subject_id,
            content,
            aliases: &receipt.aliases.queries,
        });
        if claimed != &actual {
            return Err(refuse(
                "candidate_receipt_caller_authored",
                TypedValue::string(&actual),
                TypedValue::string(claimed),
            ));
        }
    }

    // The same search, run again, here.
    let fresh = super::candidates::mint(
        state,
        &receipt.index_head,
        &subject_id,
        &receipt.exact.query,
        &receipt.aliases.queries,
        content,
    )
    .map_err(|detail| {
        refuse(
            "candidate_receipt_stale",
            TypedValue::string("a repeatable search"),
            TypedValue::string(&detail),
        )
    })?;
    // A subject the receipt did not search under is a different search
    // wearing this one's clothes.
    if receipt.scoped.subject_id != subject_id {
        return Err(refuse(
            "candidate_receipt_caller_authored",
            TypedValue::string(&subject_id),
            TypedValue::string(&receipt.scoped.subject_id),
        ));
    }
    // A candidate the receipt claims and the index does not hold was never
    // returned by any search this server ran.
    let live: std::collections::BTreeSet<&str> = fresh.returned_candidates().into_iter().collect();
    for claimed in receipt.returned_candidates() {
        if !live.contains(claimed) {
            return Err(refuse(
                "candidate_receipt_caller_authored",
                TypedValue::string("a candidate the index returns"),
                TypedValue::string(claimed),
            ));
        }
    }

    let considered: std::collections::BTreeSet<&str> = receipt
        .considered
        .iter()
        .map(|c| c.candidate_id.as_str())
        .collect();
    let claimed: std::collections::BTreeSet<&str> =
        receipt.returned_candidates().into_iter().collect();
    for candidate in fresh.returned_candidates() {
        if !claimed.contains(candidate) {
            // The world moved: this exists now and the search never saw it.
            return Err(refuse(
                "candidate_receipt_stale",
                TypedValue::string("no candidate the search did not return"),
                TypedValue::string(candidate),
            ));
        }
        if !considered.contains(candidate) {
            // The search saw it and the proposal says nothing about it.
            return Err(refuse(
                "candidate_unconsidered",
                TypedValue::string("a disposition for every candidate"),
                TypedValue::string(candidate),
            ));
        }
    }
    Ok(())
}

/// Every member of a commit set was submitted by the same actor.
///
/// A run has one actor; a set that mixed two would let one producer commit
/// another's work under a set id neither agreed to. Operational destiny —
/// it is a plumbing mistake, not a claim about the world.
pub fn actor_matches_run(actors: &[String]) -> PreconditionResult {
    let Some(first) = actors.first() else {
        return Ok(());
    };
    match actors.iter().find(|actor| *actor != first) {
        Some(other) => Err(Box::new(PreconditionFailure {
            code: "run_actor_mismatch",
            rule: "actor_matches_run",
            expected: TypedValue::string(first),
            actual: TypedValue::string(other),
        })),
        None => Ok(()),
    }
}

/// Run every predicate the op's table row requires, in the order the table
/// lists them — so precedence between preconditions is the artifact's, not
/// whichever branch happens to come first here.
pub fn check(
    table: &PolicyTable,
    state: &EpistemicState,
    catalog: &super::qualification::Catalog,
    proposal: &ProposalV1,
    binding: &TargetBinding,
) -> PreconditionResult {
    let Some(rule) = table.op(proposal.op.kind()) else {
        return Ok(()); // the tripwire already proves this cannot happen
    };
    for predicate in &rule.requires {
        match predicate.as_str() {
            "versions_current" => versions_current(state, proposal)?,
            "basis_refs_valid" => basis_refs_valid(state, proposal)?,
            // Preventive, and deliberately risk-blind: a LOW-risk
            // auto-applying update is exactly where a self-supporting loop
            // would never be seen (M26.3).
            "no_self_ancestry" => super::ancestry::no_self_ancestry(state, proposal)?,
            // Sorted `requires` puts this ahead of `versions_current`, so a
            // card says "you did not name what you are changing" before it
            // says "your version is stale" — binding first, CAS second, and
            // the order is the artifact's rather than this file's.
            "target_set_exact" => target_set_bound(state, proposal, binding)?,
            "candidate_receipt_current" => candidate_receipt_current(state, proposal)?,
            "qualification_roles_present" => {
                super::qualification::roles_present(catalog, state, proposal)?
            }
            "absence_coverage_complete" => {
                super::coverage::absence_complete(table, state, proposal)?
            }
            // Only the REFUSALS of the high-stakes rule are preconditions.
            // Its third outcome is a queue, which is a verdict and not a
            // failure — `commit.rs` reads it where verdicts are decided, so
            // that "structurally valid but unverified" cannot be quietly
            // turned into a rejection at one call site and a queue at
            // another.
            "open_contradictions_addressed" => open_contradictions_addressed(state, proposal)?,
            "high_stakes_route_satisfied" => {
                if let super::coverage::HighStakes::Refuse(failure) =
                    super::coverage::high_stakes(table, state, proposal)
                {
                    return Err(failure);
                }
            }
            // Everything else is evaluated elsewhere or owned by a later
            // phase; `PREDICATE_OWNERS` is where that is written down.
            _ => {}
        }
    }
    Ok(())
}

/// **The contradiction-preservation gate** (M27.4, D12/§8).
///
/// A merge, a supersede, or a split can make a disagreement disappear without
/// anybody deciding anything about it — the two claims stop being two, and the
/// question of which was right stops being asked. This is the rule that says a
/// contradiction may only be compressed away DELIBERATELY: the proposal names
/// every open edge over the Beliefs it touches, says what it did about each,
/// and cites the evidence it did it with.
///
/// **It fires only after the pipeline has failed to resolve the claims
/// apart.** An edge exists exactly when M27.3's gauntlet ran the pair through
/// subject, scope, time, and stage and none of them separated it. That is what
/// stops this gate from firing on stage lag, which is the failure that would
/// make the whole surface something the owner learns to click through.
///
/// **An unclassified live `contradicts` relation counts as an open edge**, and
/// cannot be addressed at all — it has no edge id to name. The only discharge
/// is to let the backfill classify it, which is exactly the point: a
/// declaration nobody has looked at yet is not a declaration anybody may
/// compress away. This counts EVERY unclassified live declaration rather than
/// only the migrated ones the design names; the reducer does not keep the
/// relation's authoring actor, and widening a preservation rule is the safe
/// direction to be wrong in.
fn open_contradictions_addressed(
    state: &EpistemicState,
    proposal: &ProposalV1,
) -> PreconditionResult {
    use crate::ledger::schema::TargetClass;

    let refuse = |code: &'static str, expected: TypedValue, actual: TypedValue| {
        Box::new(PreconditionFailure {
            code,
            rule: "open_contradictions_addressed",
            expected,
            actual,
        })
    };
    let beliefs: std::collections::BTreeSet<&str> = proposal
        .targets
        .iter()
        .filter(|target| target.target_class == TargetClass::Belief)
        .map(|target| target.target_id.as_str())
        .collect();
    if beliefs.is_empty() {
        return Ok(());
    }

    // 1. Live declarations nobody has classified. Checked FIRST, because a
    //    proposal cannot satisfy this one by adding an entry and a card that
    //    said "address these edges" while hiding an unaddressable obligation
    //    would send its reader in circles.
    let classified_relations: std::collections::BTreeSet<&str> = state
        .comparisons
        .values()
        .filter(|comparison| {
            state
                .conflict_classifications
                .contains_key(&comparison.comparison_id)
        })
        .filter_map(|comparison| match &comparison.origin {
            crate::ledger::reduce::ComparisonOrigin::Declared {
                source_relation_event_id,
                ..
            } => Some(source_relation_event_id.as_str()),
            crate::ledger::reduce::ComparisonOrigin::Detected { .. } => None,
        })
        .collect();
    let unclassified: Vec<&str> = state
        .relations
        .values()
        .filter(|relation| {
            relation.live
                && relation.relation == crate::ledger::schema::RelationKind::Contradicts
                && (beliefs.contains(relation.from.as_str())
                    || beliefs.contains(relation.to.as_str()))
                && !classified_relations.contains(relation.last_add_event_id.as_str())
        })
        .map(|relation| relation.relation_id.as_str())
        .collect();
    if let Some(relation_id) = unclassified.first() {
        return Err(refuse(
            "contradiction_preservation_required",
            TypedValue::string(
                "every declared contradiction over these Beliefs classified before one of them \
                 is compressed away",
            ),
            TypedValue::string(&format!(
                "relation {relation_id} declares a contradiction nothing has classified — it \
                 cannot be addressed by id because it has no edge yet, and the backfill is what \
                 gives it one"
            )),
        ));
    }

    // 2. The open edges themselves.
    let required: std::collections::BTreeMap<&str, &str> = state
        .contradiction_edges
        .values()
        .filter(|edge| edge.closed.is_none())
        .filter(|edge| {
            beliefs.contains(edge.left_belief_id.as_str())
                || beliefs.contains(edge.right_belief_id.as_str())
        })
        .map(|edge| (edge.edge_id.as_str(), edge.comparison_id.as_str()))
        .collect();
    let addressed: std::collections::BTreeMap<
        &str,
        &crate::ledger::schema::AddressedContradiction,
    > = proposal
        .basis
        .addressed_contradictions
        .iter()
        .map(|entry| (entry.edge_id.as_str(), entry))
        .collect();

    let list = |ids: Vec<&str>| TypedValue::Array {
        value: ids.into_iter().map(TypedValue::string).collect(),
    };
    let missing: Vec<&str> = required
        .keys()
        .filter(|edge_id| !addressed.contains_key(*edge_id))
        .copied()
        .collect();
    if !missing.is_empty() {
        return Err(refuse(
            "contradiction_preservation_required",
            list(required.keys().copied().collect()),
            list(addressed.keys().copied().collect()),
        ));
    }

    // 3. Every entry has to be about an edge this op is actually compressing,
    //    and about the comparison that edge came from. An entry for anything
    //    else would make the interpreter close an edge nothing addressed.
    for (edge_id, entry) in &addressed {
        let Some(comparison_id) = required.get(edge_id) else {
            let known = state.contradiction_edges.get(*edge_id);
            return Err(refuse(
                "contradiction_edge_stale",
                list(required.keys().copied().collect()),
                TypedValue::string(&match known {
                    Some(edge) if edge.closed.is_some() => format!(
                        "edge {edge_id} is already closed — it was addressed once, and a close \
                         does not happen twice"
                    ),
                    Some(_) => {
                        format!("edge {edge_id} is open over Beliefs this proposal does not touch")
                    }
                    None => format!("edge {edge_id} does not exist"),
                }),
            ));
        };
        if &entry.comparison_id != comparison_id {
            return Err(refuse(
                "contradiction_edge_stale",
                TypedValue::string(comparison_id),
                TypedValue::string(&entry.comparison_id),
            ));
        }
    }
    Ok(())
}

/// Prepare a fresh proposal from a stale one: the same intent, re-pinned to
/// what is true now.
///
/// This is the server half of "offer preparation of an updated proposal". It
/// is a NEW proposal with a new id — never an edit of the immutable one,
/// because a refreshed proposal under the old id would make the approval
/// record a lie.
pub fn prepare_updated(state: &EpistemicState, stale: &ProposalV1) -> ProposalV1 {
    let mut updated = stale.clone();
    updated.proposal_id = crate::ledger::schema::sha256_first128(
        format!(
            "cerebro-prepared-updated-v1\0{}\0{}",
            stale.proposal_id,
            state.versions.len()
        )
        .as_bytes(),
    );
    for target in &mut updated.targets {
        target.expected_version = state.version(target.target_class.as_str(), &target.target_id);
    }
    updated
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ledger::schema::TargetClass;
    use crate::policy::fixtures::{proposal, target};
    use crate::policy::table::Risk;

    const A: &str = "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";
    const B: &str = "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2";

    fn op() -> ProposalOp {
        ProposalOp::UpdateBelief {
            belief_id: A.into(),
            patch: vec![],
            basis: crate::ledger::schema::BeliefBasis::Unsupported {
                reason: "fixture".into(),
            },
        }
    }

    fn with_targets(targets: Vec<crate::ledger::schema::ProposalTarget>) -> ProposalV1 {
        proposal(A, B, op(), targets, Risk::Medium)
    }

    /// A world where `belief/A` sits at the given version.
    fn at_version(version: Option<u64>) -> EpistemicState {
        let mut state = EpistemicState::default();
        if let Some(version) = version {
            state
                .versions
                .insert(("belief".into(), A.into()), (version, B.into()));
        }
        state
    }

    /// A world holding one committed Belief about one Entity, so an
    /// `update_belief` against it can actually expand.
    fn world_with_belief(attested: bool) -> EpistemicState {
        use crate::ledger::reduce::{BeliefState, RevisionState};
        let mut state = at_version(Some(1));
        let mut belief = BeliefState {
            belief_id: A.to_string(),
            entity_id: "e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1".to_string(),
            created_event_id: "1".repeat(32),
            revisions: vec![RevisionState {
                revision: 1,
                event_id: "1".repeat(32),
                content: String::new(),
                fields: serde_json::json!({}),
                basis: crate::ledger::schema::BeliefBasis::Unsupported {
                    reason: "fixture".into(),
                },
            }],
            attested: None,
            attestation_events: vec![],
            path: None,
            overrides: vec![],
            override_head_event: None,
            projection_head_event: "1".repeat(32),
            qualification: crate::ledger::schema::Qualification::Draft,
            lifecycle: crate::ledger::schema::Lifecycle::Active,
            tombstoned_by: None,
            open_contest_event: None,
            qualification_head_event: None,
            lifecycle_head_event: None,
            contest_head_event: None,
            entity_merge_event_ids: vec![],
        };
        if attested {
            // (attesting event, attested revision event)
            belief.attested = Some(("1".repeat(32), "1".repeat(32)));
        }
        state.beliefs.insert(A.to_string(), belief);
        state
    }

    fn unbound() -> (
        crate::ledger::schema::Actor,
        std::collections::BTreeSet<String>,
    ) {
        (
            crate::ledger::schema::Actor {
                id: "agent:claude".into(),
            },
            Default::default(),
        )
    }

    fn bound(
        state: &EpistemicState,
        proposal: &ProposalV1,
    ) -> Result<(), Box<PreconditionFailure>> {
        let (actor, staged) = unbound();
        target_set_bound(
            state,
            proposal,
            &TargetBinding {
                actor: &actor,
                staged_beliefs: &staged,
                staged_entities: &staged,
                decision_event_id: None,
            },
        )
    }

    #[test]
    fn a_target_set_aimed_away_from_the_payload_is_refused() {
        // **THE ATTACK** (M26.3d). The payload revises Belief A; the targets
        // name a fresh id with `expected_version: null`, which reads as a
        // creation and so sails through CAS. Every consumer that could have
        // noticed — the expected-version check and BOTH risk escalators —
        // reads `targets`, while the mutation comes from `op`. Before this
        // predicate the two were never compared.
        let decoy = "d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4";
        let proposal = with_targets(vec![target(TargetClass::Belief, decoy, None)]);
        let failure = bound(&world_with_belief(false), &proposal).unwrap_err();
        assert_eq!(failure.code, "target_set_mismatch");
        assert_eq!(failure.rule, "target_set_exact");
        assert_eq!(
            failure.expected,
            TypedValue::string(&format!("belief/{A} among the targets"))
        );
    }

    #[test]
    fn the_attack_is_what_would_have_let_an_attested_belief_slip_a_card() {
        // WHY IT MATTERS, stated as the harm rather than the mechanism.
        // `target_has_attestation` floors risk at HIGH so a human-verified
        // Belief cannot be revised without a card. The escalator reads
        // TARGETS. Aim them elsewhere and a MEDIUM revision of an attested
        // Belief auto-applies — the exact protection `knowledge/` is
        // agent-written-human-verified for.
        let state = world_with_belief(true);
        assert!(state.beliefs[A].attested.is_some());
        let decoy = "d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4";
        assert!(bound(
            &state,
            &with_targets(vec![target(TargetClass::Belief, decoy, None)])
        )
        .is_err());
        // Named honestly, it binds — and the escalator can then see it.
        assert!(bound(
            &state,
            &with_targets(vec![target(TargetClass::Belief, A, Some(1))])
        )
        .is_ok());
    }

    #[test]
    fn naming_what_the_op_changes_passes_and_extra_targets_stay_legal() {
        // CONTAINMENT, not equality. A target an op only READS keeps its
        // version, and that is what makes a read legible as a read. Extra
        // targets can only widen CAS and turn MORE escalators on — they cost
        // the caller and buy it nothing, so there is no reason to refuse
        // them and one good reason not to: the shipped goldens declare reads.
        let state = world_with_belief(false);
        assert!(bound(
            &state,
            &with_targets(vec![target(TargetClass::Belief, A, Some(1))])
        )
        .is_ok());
        assert!(bound(
            &state,
            &with_targets(vec![
                target(TargetClass::Belief, A, Some(1)),
                target(
                    TargetClass::Entity,
                    "e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1",
                    Some(1)
                ),
            ])
        )
        .is_ok());
    }

    #[test]
    fn a_server_derived_id_is_not_required_of_a_caller() {
        // The rule covers only ids the PAYLOAD names. A relation id is
        // `sha256("cerebro-relation-v1\0" ++ canonical_json([from,to,kind]))`
        // and no tool hands a caller a way to compute one — requiring it
        // would make supersede, split, and both merges unproposable by
        // anything that does not already import the hasher. It is also not
        // an attack surface: it is a pure function of ids the payload names,
        // which this rule does check.
        let mut state = world_with_belief(false);
        let successor = "c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3";
        let mut peer = state.beliefs[A].clone();
        peer.belief_id = successor.to_string();
        state.beliefs.insert(successor.to_string(), peer);
        state
            .versions
            .insert(("belief".into(), successor.into()), (1, B.into()));

        let mut proposal = with_targets(vec![
            target(TargetClass::Belief, A, Some(1)),
            target(TargetClass::Belief, successor, Some(1)),
        ]);
        proposal.op = ProposalOp::SupersedeBelief {
            belief_id: A.into(),
            successor_id: successor.into(),
        };
        // The expansion writes a derived `supersedes` Relation that appears
        // in no target list here, and the proposal is still bound.
        assert!(bound(&state, &proposal).is_ok());
    }

    #[test]
    fn a_plan_that_cannot_be_built_binds_nothing_rather_than_guessing() {
        // An op whose expansion refuses writes nothing, so there is nothing
        // to bind — and the refusal stays owned by the layer where expansion
        // is authoritative, which keeps one code coming from one place.
        let empty = EpistemicState::default();
        let proposal = with_targets(vec![target(TargetClass::Belief, A, Some(1))]);
        assert!(bound(&empty, &proposal).is_ok());
    }

    #[test]
    fn a_matching_version_passes_and_a_moved_one_does_not() {
        let proposal = with_targets(vec![target(TargetClass::Belief, A, Some(3))]);
        assert!(versions_current(&at_version(Some(3)), &proposal).is_ok());
        let failure = versions_current(&at_version(Some(4)), &proposal).unwrap_err();
        assert_eq!(failure.code, "stale_target_version");
        assert_eq!(failure.rule, "versions_current");
        // The card stays inspectable: it says what it expected and what it
        // found, in the same breath.
        assert_eq!(
            failure.expected,
            TypedValue::string(&format!("belief/{A}@3"))
        );
        assert_eq!(failure.actual, TypedValue::string(&format!("belief/{A}@4")));
    }

    #[test]
    fn a_null_expected_version_means_creation_and_nothing_else() {
        // A null against something that already exists is a blind write
        // wearing a compare-and-swap's clothes.
        let creating = with_targets(vec![target(TargetClass::Belief, A, None)]);
        assert!(versions_current(&at_version(None), &creating).is_ok());
        assert_eq!(
            versions_current(&at_version(Some(1)), &creating)
                .unwrap_err()
                .code,
            "stale_target_version"
        );
        // ...and a version against something that does not exist is equally
        // a claim about a world that is not there.
        let updating = with_targets(vec![target(TargetClass::Belief, A, Some(1))]);
        assert_eq!(
            versions_current(&at_version(None), &updating)
                .unwrap_err()
                .code,
            "stale_target_version"
        );
    }

    #[test]
    fn one_stale_target_refuses_the_whole_proposal() {
        // Never a partial apply: the mismatch is on the second target and
        // the first one's agreement does not rescue it.
        let mut state = at_version(Some(1));
        state
            .versions
            .insert(("entity".into(), B.into()), (9, B.into()));
        let proposal = with_targets(vec![
            target(TargetClass::Belief, A, Some(1)),
            target(TargetClass::Entity, B, Some(2)),
        ]);
        let failure = versions_current(&state, &proposal).unwrap_err();
        assert_eq!(failure.actual, TypedValue::string(&format!("entity/{B}@9")));
    }

    #[test]
    fn evidence_that_stopped_resolving_is_an_invalid_reference() {
        let mut proposal = with_targets(vec![target(TargetClass::Belief, A, Some(1))]);
        proposal.basis.evidence_refs = vec![B.to_string()];
        let failure = basis_refs_valid(&at_version(Some(1)), &proposal).unwrap_err();
        assert_eq!(failure.code, "invalid_reference");
        assert_eq!(failure.rule, "basis_refs_valid");
    }

    #[test]
    fn a_pinned_route_no_build_can_read_names_a_rule_nothing_can_evaluate() {
        let mut proposal = with_targets(vec![target(TargetClass::Belief, A, Some(1))]);
        proposal.basis.authority_route_refs = vec![crate::ledger::schema::AuthorityRouteRef {
            authority_route_id: "shipping_soc".into(),
            authority_rule_version: 1,
            artifact_hash: "0".repeat(64),
        }];
        assert_eq!(
            basis_refs_valid(&at_version(Some(1)), &proposal)
                .unwrap_err()
                .code,
            "invalid_reference"
        );
    }

    #[test]
    fn a_run_has_one_actor() {
        assert!(actor_matches_run(&["agent:a".into(), "agent:a".into()]).is_ok());
        let failure = actor_matches_run(&["agent:a".into(), "agent:b".into()]).unwrap_err();
        assert_eq!(failure.code, "run_actor_mismatch");
        // Operational: a plumbing mistake, not a claim about the world.
        let table = PolicyTable::load().unwrap();
        assert_eq!(
            table.destiny(failure.code),
            Some(super::super::table::Destiny::Operational)
        );
    }

    #[test]
    fn preparing_an_updated_proposal_re_pins_versions_under_a_new_id() {
        // Never an edit of the immutable one: a refreshed proposal under the
        // old id would make the approval record a lie.
        let stale = with_targets(vec![target(TargetClass::Belief, A, Some(3))]);
        let updated = prepare_updated(&at_version(Some(7)), &stale);
        assert_ne!(updated.proposal_id, stale.proposal_id);
        assert_eq!(updated.targets[0].expected_version, Some(7));
        assert_eq!(updated.op, stale.op, "the intent is unchanged");
        assert!(versions_current(&at_version(Some(7)), &updated).is_ok());
    }

    // --- §15: the create receipt (M24.7) --------------------------------

    /// A world holding one Belief about `B`, projected at `churn.md`.
    fn base_with_a_belief() -> EpistemicState {
        use crate::ledger::reduce::{BeliefState, RevisionState};
        let mut state = EpistemicState::default();
        state.beliefs.insert(
            A.to_string(),
            BeliefState {
                belief_id: A.into(),
                entity_id: B.into(),
                created_event_id: B.into(),
                revisions: vec![RevisionState {
                    event_id: B.into(),
                    revision: 1,
                    content: String::new(),
                    fields: serde_json::json!({}),
                    basis: crate::ledger::schema::BeliefBasis::Unsupported {
                        reason: "fixture".into(),
                    },
                }],
                attested: None,
                attestation_events: vec![],
                path: None,
                overrides: vec![],
                override_head_event: None,
                projection_head_event: B.into(),
                qualification: crate::ledger::schema::Qualification::Draft,
                lifecycle: crate::ledger::schema::Lifecycle::Active,
                tombstoned_by: None,
                open_contest_event: None,
                qualification_head_event: None,
                lifecycle_head_event: None,
                contest_head_event: None,
                entity_merge_event_ids: vec![],
            },
        );
        state
            .projection_paths
            .insert("churn.md".to_string(), A.to_string());
        state
    }

    const NEW_BELIEF: &str = "c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3";

    fn creation(receipt: Option<crate::ledger::schema::CandidateSearchReceipt>) -> ProposalV1 {
        let mut p = proposal(
            A,
            B,
            ProposalOp::CreateBelief {
                belief_id: NEW_BELIEF.into(),
                subject: crate::ledger::schema::SubjectRef::Resolved {
                    entity_id: B.into(),
                    aliases: vec!["churn.md".into()],
                },
                content: CREATION_CONTENT.into(),
                fields: serde_json::json!({}),
                basis: crate::ledger::schema::BeliefBasis::Unsupported {
                    reason: "fixture".into(),
                },
                distinctness_reason: "nothing matched".into(),
            },
            vec![target(TargetClass::Belief, NEW_BELIEF, None)],
            Risk::Low,
        );
        p.candidate_search_receipt = receipt;
        p
    }

    /// The content `creation()` proposes. Shared so the receipt is minted
    /// with the prose it will be attached to — the fingerprint check refuses
    /// the pair otherwise, which is the point of it.
    const CREATION_CONTENT: &str = "# Churn\n";

    fn minted(state: &EpistemicState) -> crate::ledger::schema::CandidateSearchReceipt {
        super::super::candidates::mint(
            state,
            super::super::candidates::EMPTY_INDEX_HEAD,
            B,
            "churn.md",
            &["churn.md".to_string()],
            CREATION_CONTENT,
        )
        .unwrap()
    }

    #[test]
    fn a_search_this_server_ran_and_nothing_moved_passes() {
        let empty = EpistemicState::default();
        assert!(candidate_receipt_current(&empty, &creation(Some(minted(&empty)))).is_ok());
    }

    #[test]
    fn creating_without_looking_is_a_ledger_refusal_not_a_schema_error() {
        // The whole reason this check is here and not in the schema layer:
        // "the agent created without searching" is epistemic history. Filing
        // it as `schema_invalid` would put it in the operational log with
        // the typos.
        let failure =
            candidate_receipt_current(&EpistemicState::default(), &creation(None)).unwrap_err();
        assert_eq!(failure.code, "candidate_receipt_missing");
        assert_eq!(failure.rule, "candidate_receipt_current");
        let table = PolicyTable::load().unwrap();
        assert_eq!(
            table.destiny(failure.code),
            Some(super::super::table::Destiny::Ledger)
        );
    }

    #[test]
    fn a_receipt_whose_id_does_not_match_its_legs_was_not_minted_here() {
        let empty = EpistemicState::default();
        let mut receipt = minted(&empty);
        receipt.receipt_id = "f".repeat(32);
        assert_eq!(
            candidate_receipt_current(&empty, &creation(Some(receipt)))
                .unwrap_err()
                .code,
            "candidate_receipt_caller_authored"
        );
    }

    #[test]
    fn a_receipt_claiming_a_candidate_the_index_never_returned_is_forged() {
        // A caller cannot be stopped from writing JSON. What it cannot do is
        // make that JSON survive the search being run again here.
        let empty = EpistemicState::default();
        let mut receipt = minted(&empty);
        receipt.exact.candidate_ids = vec![A.to_string()];
        receipt.considered = vec![crate::ledger::schema::ConsideredCandidate {
            candidate_id: A.to_string(),
            decision: crate::ledger::schema::CandidateDecision::Distinct,
            reason: "invented".into(),
        }];
        receipt.receipt_id = super::super::candidates::derive_receipt_id(&receipt).unwrap();
        let failure = candidate_receipt_current(&empty, &creation(Some(receipt))).unwrap_err();
        assert_eq!(failure.code, "candidate_receipt_caller_authored");
        assert_eq!(failure.actual, TypedValue::string(A));
    }

    #[test]
    fn the_minted_receipt_carries_a_completed_semantic_leg() {
        // M26.2's registration precondition, asserted where it is produced.
        // The whole argument for turning proposal tools on is that a create
        // has been looked for semantically, not just by identity.
        let empty = EpistemicState::default();
        let receipt = minted(&empty);
        assert_eq!(
            receipt.semantic.status,
            crate::ledger::schema::SemanticStatus::Completed
        );
        assert_eq!(
            receipt.semantic.retriever_version.as_deref(),
            Some(crate::retrieval::RETRIEVER_VERSION)
        );
        assert_eq!(
            receipt.semantic.index_head.as_ref(),
            Some(&receipt.index_head)
        );
    }

    #[test]
    fn a_receipt_minted_for_different_prose_is_not_this_proposals_receipt() {
        // THE GAP THE FINGERPRINT CLOSES. The deterministic legs record their
        // own queries, so tampering with them is already caught — but the
        // semantic leg expands over the proposed CONTENT, and content is not
        // stored on the receipt. Without this check a caller could mint
        // against innocuous prose and attach the receipt to a proposal saying
        // something else, and every other check would pass.
        let empty = EpistemicState::default();
        let receipt = super::super::candidates::mint(
            &empty,
            super::super::candidates::EMPTY_INDEX_HEAD,
            B,
            "churn.md",
            &["churn.md".to_string()],
            "# Something else entirely\n",
        )
        .unwrap();
        let failure = candidate_receipt_current(&empty, &creation(Some(receipt))).unwrap_err();
        assert_eq!(failure.code, "candidate_receipt_caller_authored");
    }

    #[test]
    fn a_semantic_leg_naming_a_fresher_head_than_its_receipt_is_refused() {
        // Two heads on one receipt would let a real search be relabelled and
        // stop looking stale. Caught in the SHAPE layer, so it cannot reach
        // policy at all.
        let empty = EpistemicState::default();
        let mut receipt = minted(&empty);
        receipt.semantic.index_head = Some("a".repeat(32));
        assert!(receipt.validate().is_err());
    }

    #[test]
    fn a_semantic_leg_that_only_claims_to_have_tried_is_refused() {
        // `attempted` is the shape a caller reaches for to claim credit for a
        // search that did not finish. M26.2 mints no receipt at all when
        // retrieval fails, so this status can only be invented — and the
        // vocabulary keeps the word precisely to have somewhere to say no.
        let empty = EpistemicState::default();
        let mut receipt = minted(&empty);
        receipt.semantic.status = crate::ledger::schema::SemanticStatus::Attempted;
        receipt.semantic.retriever_version = None;
        receipt.semantic.index_head = None;
        receipt.semantic.query_fingerprint = None;
        let error = receipt.validate().unwrap_err();
        assert!(error.contains("attempted"), "{error}");
    }

    #[test]
    fn a_completed_semantic_leg_that_cannot_say_what_ran_is_refused() {
        let empty = EpistemicState::default();
        let mut receipt = minted(&empty);
        receipt.semantic.retriever_version = None;
        let error = receipt.validate().unwrap_err();
        assert!(error.contains("retriever_version"), "{error}");
    }

    #[test]
    fn a_receipt_from_a_search_this_build_no_longer_runs_is_refused() {
        let empty = EpistemicState::default();
        let mut receipt = minted(&empty);
        receipt.search_version = super::super::candidates::SEARCH_VERSION + 1;
        receipt.receipt_id = super::super::candidates::derive_receipt_id(&receipt).unwrap();
        assert_eq!(
            candidate_receipt_current(&empty, &creation(Some(receipt)))
                .unwrap_err()
                .code,
            "candidate_receipt_caller_authored"
        );
    }

    #[test]
    fn a_duplicate_that_appeared_after_the_search_makes_the_receipt_stale() {
        // The window target-id CAS cannot see: while the card waited,
        // something else created the very thing it calls new.
        let receipt = minted(&EpistemicState::default());
        let failure =
            candidate_receipt_current(&base_with_a_belief(), &creation(Some(receipt))).unwrap_err();
        assert_eq!(failure.code, "candidate_receipt_stale");
        assert_eq!(failure.actual, TypedValue::string(A));
    }

    #[test]
    fn a_candidate_the_search_returned_and_the_proposal_ignored_is_unconsidered() {
        // Reachable ONLY because the receipt id digests the legs and not the
        // dispositions: stripping the judgement leaves the search intact, so
        // this is not forgery — it is a search that surfaced a duplicate and
        // then said nothing about it, which looks like diligence.
        let state = base_with_a_belief();
        let mut receipt = minted(&state);
        assert_eq!(receipt.returned_candidates(), vec![A]);
        receipt.considered.clear();
        let failure = candidate_receipt_current(&state, &creation(Some(receipt))).unwrap_err();
        assert_eq!(failure.code, "candidate_unconsidered");
        assert_eq!(failure.actual, TypedValue::string(A));
    }

    #[test]
    fn a_proposer_may_disagree_with_the_servers_default_disposition() {
        // Similarity alone never forces a merge. The server says "this
        // exists, revise it"; a proposer may say "distinct, and here is why"
        // and the ledger holds them to it.
        let state = base_with_a_belief();
        let mut receipt = minted(&state);
        receipt.considered[0].decision = crate::ledger::schema::CandidateDecision::Distinct;
        receipt.considered[0].reason = "a different reporting scope".into();
        assert!(candidate_receipt_current(&state, &creation(Some(receipt))).is_ok());
    }

    #[test]
    fn every_code_this_predicate_names_is_one_create_belief_declares() {
        let table = PolicyTable::load().unwrap();
        let rule = table.op("create_belief").unwrap();
        for code in [
            "candidate_receipt_missing",
            "candidate_receipt_caller_authored",
            "candidate_receipt_stale",
            "candidate_unconsidered",
        ] {
            assert!(
                rule.possible_rejections.iter().any(|r| r == code),
                "{code} is refused by §15 and not declared by create_belief"
            );
        }
    }

    #[test]
    fn every_predicate_the_table_requires_is_named_by_an_owner() {
        // THE GAP TRIPWIRE. A predicate the table requires and nothing
        // evaluates is a rule that looks like protection. This does not
        // demand that all of them be implemented — it demands that every gap
        // be WRITTEN DOWN with the phase that closes it.
        let table = PolicyTable::load().unwrap();
        let declared: std::collections::BTreeSet<&str> =
            table.predicates.iter().map(String::as_str).collect();
        let owned: std::collections::BTreeSet<&str> =
            PREDICATE_OWNERS.iter().map(|(name, _)| *name).collect();
        assert_eq!(
            declared, owned,
            "the shipped table's predicates and PREDICATE_OWNERS disagree"
        );
        // Every predicate any op requires must be in the registry too.
        for rule in table.ops.values() {
            for predicate in &rule.requires {
                assert!(
                    owned.contains(predicate.as_str()),
                    "{predicate} is required by an op and has no owner"
                );
            }
        }
    }

    #[test]
    fn the_owner_list_is_sorted_and_unique() {
        let names: Vec<&str> = PREDICATE_OWNERS.iter().map(|(name, _)| *name).collect();
        let mut sorted = names.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted, names);
    }

    // --- M27.4: the contradiction-preservation gate -------------------------

    const EDGE: &str = "ed9eed9eed9eed9eed9eed9eed9eed9e";
    const COMPARISON: &str = "c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0";
    const EVIDENCE: &str = "e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5";
    const OTHER_BELIEF: &str = "b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3";

    /// A world holding one OPEN edge between belief A and belief B3.
    fn world_with_open_edge() -> EpistemicState {
        use crate::ledger::reduce::ContradictionEdgeRow;
        let mut state = world_with_belief(false);
        state.contradiction_edges.insert(
            EDGE.into(),
            ContradictionEdgeRow {
                edge_id: EDGE.into(),
                comparison_id: COMPARISON.into(),
                kind: crate::ledger::schema::EdgeKind::GenuineDirect,
                left_belief_id: A.into(),
                right_belief_id: OTHER_BELIEF.into(),
                opened_event_id: "9".repeat(32),
                classified_event_id: "8".repeat(32),
                closed: None,
            },
        );
        state
    }

    fn superseding(addressed: Vec<crate::ledger::schema::AddressedContradiction>) -> ProposalV1 {
        let mut proposal = with_targets(vec![crate::ledger::schema::ProposalTarget {
            target_class: crate::ledger::schema::TargetClass::Belief,
            target_id: A.into(),
            expected_version: Some(1),
        }]);
        if !addressed.is_empty() {
            proposal.basis.evidence_refs = vec![EVIDENCE.into()];
        }
        proposal.basis.addressed_contradictions = addressed;
        proposal
    }

    fn entry(edge_id: &str, comparison_id: &str) -> crate::ledger::schema::AddressedContradiction {
        crate::ledger::schema::AddressedContradiction {
            edge_id: edge_id.into(),
            comparison_id: comparison_id.into(),
            disposition: crate::ledger::schema::ContradictionDisposition::ResolvedWithEvidence,
            evidence_refs: vec![EVIDENCE.into()],
        }
    }

    #[test]
    fn compressing_a_belief_with_an_open_edge_needs_the_edge_named() {
        // The whole rule in one case: a merge or supersede can make a
        // disagreement stop existing without anybody deciding which side was
        // right, and this is what makes that deliberate.
        let state = world_with_open_edge();
        let failure = open_contradictions_addressed(&state, &superseding(vec![])).unwrap_err();
        assert_eq!(failure.code, "contradiction_preservation_required");
        assert_eq!(failure.rule, "open_contradictions_addressed");
        assert_eq!(
            failure.expected,
            TypedValue::Array {
                value: vec![TypedValue::string(EDGE)]
            }
        );
        assert_eq!(failure.actual, TypedValue::Array { value: vec![] });

        // Named, and it passes.
        open_contradictions_addressed(&state, &superseding(vec![entry(EDGE, COMPARISON)])).unwrap();
    }

    #[test]
    fn an_edge_over_beliefs_this_op_does_not_touch_is_not_this_ops_problem() {
        // The crying-wolf guard for the GATE: requiring every open edge in
        // the base would make every merge anywhere impossible, and the rule
        // would be routed around rather than obeyed.
        let mut state = world_with_open_edge();
        let edge = state.contradiction_edges.get_mut(EDGE).unwrap();
        edge.left_belief_id = OTHER_BELIEF.into();
        edge.right_belief_id = "b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4".into();
        open_contradictions_addressed(&state, &superseding(vec![])).unwrap();
    }

    #[test]
    fn a_closed_edge_cannot_be_addressed_again_and_a_wrong_comparison_is_stale() {
        let mut state = world_with_open_edge();
        state.contradiction_edges.get_mut(EDGE).unwrap().closed =
            Some(crate::ledger::reduce::EdgeClosure {
                event_id: "7".repeat(32),
                addressed_by_event_id: "6".repeat(32),
                disposition: crate::ledger::schema::CloseDisposition::ResolvedWithEvidence,
                evidence_event_ids: vec![EVIDENCE.into()],
            });
        let failure =
            open_contradictions_addressed(&state, &superseding(vec![entry(EDGE, COMPARISON)]))
                .unwrap_err();
        assert_eq!(failure.code, "contradiction_edge_stale");

        // An entry naming the right edge and the wrong comparison: the pair
        // has to be the one the edge came from, or the close would be filed
        // against a comparison nobody classified.
        let open = world_with_open_edge();
        let failure =
            open_contradictions_addressed(&open, &superseding(vec![entry(EDGE, &"f".repeat(32))]))
                .unwrap_err();
        assert_eq!(failure.code, "contradiction_edge_stale");
    }

    #[test]
    fn an_unclassified_declaration_blocks_and_cannot_be_addressed_by_id() {
        // The M27.3d dependency, enforced: a `contradicts` relation nobody
        // has classified has no edge id, so there is nothing to name — and
        // the only discharge is to let the backfill classify it. Anything
        // else would let a merge compress away a declaration nobody has
        // looked at.
        use crate::ledger::reduce::RelationState;
        let mut state = world_with_belief(false);
        state.relations.insert(
            "r1".into(),
            RelationState {
                relation_id: "r1".into(),
                from: A.into(),
                to: OTHER_BELIEF.into(),
                relation: crate::ledger::schema::RelationKind::Contradicts,
                live: true,
                last_add_event_id: "5".repeat(32),
                last_event_id: "5".repeat(32),
            },
        );
        let failure = open_contradictions_addressed(&state, &superseding(vec![])).unwrap_err();
        assert_eq!(failure.code, "contradiction_preservation_required");
        let TypedValue::String { value } = &failure.actual else {
            panic!("the card names the relation");
        };
        assert!(value.contains("r1"), "{value}");

        // Classified: the comparison exists and carries a verdict, so the
        // declaration is no longer an unaddressable obligation.
        state.comparisons.insert(
            COMPARISON.into(),
            crate::ledger::reduce::ComparisonRow {
                comparison_id: COMPARISON.into(),
                event_id: "4".repeat(32),
                left: crate::ledger::schema::ConflictEndpoint::DeclaredRelation {
                    endpoint: declared_endpoint(A),
                },
                right: crate::ledger::schema::ConflictEndpoint::DeclaredRelation {
                    endpoint: declared_endpoint(OTHER_BELIEF),
                },
                origin: crate::ledger::reduce::ComparisonOrigin::Declared {
                    source_relation_event_id: "5".repeat(32),
                    rule_version: "contradiction-backfill-v1".into(),
                },
            },
        );
        state.conflict_classifications.insert(
            COMPARISON.into(),
            crate::ledger::reduce::ClassificationRow {
                comparison_id: COMPARISON.into(),
                event_id: "3".repeat(32),
                outcome: crate::ledger::schema::ConflictOutcome::ResolvedByStage,
                classification: crate::ledger::schema::Classification::Deterministic {
                    rule_version: "contradiction-backfill-v1".into(),
                },
                reason_codes: vec![crate::ledger::schema::ConflictReasonCode::StageDisjoint],
                evidence_event_ids: vec![],
            },
        );
        open_contradictions_addressed(&state, &superseding(vec![])).unwrap();
    }

    fn declared_endpoint(belief_id: &str) -> crate::ledger::schema::DeclaredRelationEndpoint {
        crate::ledger::schema::DeclaredRelationEndpoint {
            relation_event_id: "5".repeat(32),
            belief_id: belief_id.into(),
            belief_revision_event_id: "1".repeat(32),
            relation_origin: crate::ledger::schema::RelationOrigin::LegacyMigration,
            subject_id: "e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1".into(),
            content_hash: "a".repeat(64),
            scope: crate::ledger::schema::KnownScope::Unknown,
            state_stage: crate::ledger::schema::KnownStage::Unknown,
            valid_time: crate::ledger::schema::KnownValidTime::Unknown,
        }
    }
}
