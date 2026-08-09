//! `ProposalV1` — the complete, frozen mutation-proposal record (M24.3).
//!
//! Not a loose `op/target/reason` map. Every field policy reads is
//! STRUCTURED, and `reason` is display text with no policy effect at all:
//! the silence, absence, high-stakes, authority, and coverage rules read
//! typed fields and referenced records, never prose. A rule that grepped
//! `reason` for "quiet" or "no evidence" would be defeated by rephrasing,
//! which is the one thing a language model is guaranteed to be good at.
//!
//! `targets[]` is the CAS set AND the complete read/write surface. Because
//! the op payload is a closed union with no free-form escape (see
//! [`super::ops`]), a mutation cannot reach a target this list does not
//! name — which is what makes expected-version checking meaningful rather
//! than advisory.

use serde::{Deserialize, Serialize};

use super::lifecycle::QualificationProfileRef;
use super::ops::{sorted_unique, ProposalOp};
use super::risk::Risk;
use super::{canonical_json, is_id128, is_sha256};

/// The closed target classes, backed by M22's reducer-owned version
/// registry. The policy table carries the same seven as DATA; a test in
/// `policy` asserts the two agree exactly, the same way the op tripwire
/// binds the op union to the table.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TargetClass {
    Belief,
    Comparison,
    Entity,
    Observation,
    Proposal,
    Relation,
    Source,
}

impl TargetClass {
    pub const ALL: [TargetClass; 7] = [
        TargetClass::Belief,
        TargetClass::Comparison,
        TargetClass::Entity,
        TargetClass::Observation,
        TargetClass::Proposal,
        TargetClass::Relation,
        TargetClass::Source,
    ];

    pub fn as_str(&self) -> &'static str {
        match self {
            TargetClass::Belief => "belief",
            TargetClass::Comparison => "comparison",
            TargetClass::Entity => "entity",
            TargetClass::Observation => "observation",
            TargetClass::Proposal => "proposal",
            TargetClass::Relation => "relation",
            TargetClass::Source => "source",
        }
    }
}

/// One CAS target. `expected_version` is null ONLY for something this
/// proposal creates — an existing target with a null version would be a
/// blind write wearing a compare-and-swap's clothes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProposalTarget {
    pub target_id: String,
    pub target_class: TargetClass,
    pub expected_version: Option<u64>,
}

/// What the resulting belief is FOR. Stakes drive the high-stakes stopping
/// rule; `predicate_class` selects the authority route.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IntendedUseKind {
    DraftNote,
    ReversibleWork,
    OperationalDecision,
    ProductionRelease,
    SafetyOrCompliance,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IntendedUse {
    pub kind: IntendedUseKind,
    pub stakes: Risk,
    pub predicate_class: Option<String>,
}

/// Why this transition is happening. The last two are the SILENCE causes:
/// they may move freshness, coverage, and attention, and may never by
/// themselves resolve, falsify, supersede, or tombstone anything.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TransitionCause {
    NewEvidence,
    HumanCorrection,
    QualificationMet,
    ConflictResolution,
    Maintenance,
    Revert,
    ElapsedTime,
    AbsenceOfObservations,
}

impl TransitionCause {
    pub fn as_str(&self) -> &'static str {
        match self {
            TransitionCause::NewEvidence => "new_evidence",
            TransitionCause::HumanCorrection => "human_correction",
            TransitionCause::QualificationMet => "qualification_met",
            TransitionCause::ConflictResolution => "conflict_resolution",
            TransitionCause::Maintenance => "maintenance",
            TransitionCause::Revert => "revert",
            TransitionCause::ElapsedTime => "elapsed_time",
            TransitionCause::AbsenceOfObservations => "absence_of_observations",
        }
    }
}

/// A pinned reference into the immutable authority-route artifact set. All
/// three legs must match: an id that exists at a different rule version, or
/// under a different artifact hash, is a MISS. That is the point of pinning
/// — an approval tomorrow is evaluated against the rule the proposer was
/// actually shown.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AuthorityRouteRef {
    pub authority_route_id: String,
    pub authority_rule_version: u64,
    pub artifact_hash: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContradictionDisposition {
    ResolvedWithEvidence,
    SupersededWithAddressing,
}

/// One open contradiction edge this operation addresses. Required (possibly
/// empty) for the ops that can compress a conflict away; forbidden for the
/// rest. Contradictions may not be compressed away silently — that is a
/// class-(a) invariant, and this is where a proposal says what it did about
/// each one.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AddressedContradiction {
    pub edge_id: String,
    pub comparison_id: String,
    pub disposition: ContradictionDisposition,
    pub evidence_refs: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProposalBasis {
    pub transition_cause: TransitionCause,
    pub evidence_refs: Vec<String>,
    pub coverage_refs: Vec<String>,
    pub authority_refs: Vec<String>,
    pub authority_route_refs: Vec<AuthorityRouteRef>,
    pub addressed_contradictions: Vec<AddressedContradiction>,
    pub absence_claim: bool,
}

fn sorted_unique_or_empty(label: &str, ids: &[String]) -> Result<(), String> {
    if ids.is_empty() {
        return Ok(());
    }
    sorted_unique(label, ids)
}

impl ProposalBasis {
    pub fn validate(&self) -> Result<(), String> {
        sorted_unique_or_empty("basis.evidence_refs", &self.evidence_refs)?;
        sorted_unique_or_empty("basis.authority_refs", &self.authority_refs)?;
        // Authority is a SUBSET of evidence: a record that carries authority
        // is first a record. Letting them diverge would allow an authority
        // reference the basis never actually cites.
        for reference in &self.authority_refs {
            if !self.evidence_refs.contains(reference) {
                return Err(format!(
                    "authority ref {reference} is not among the evidence refs — authority is a \
                     property of cited evidence, not a separate claim"
                ));
            }
        }
        for coverage in &self.coverage_refs {
            if coverage.trim().is_empty() {
                return Err("basis.coverage_refs contains an empty id".into());
            }
        }
        let mut sorted = self.coverage_refs.clone();
        sorted.sort();
        sorted.dedup();
        if sorted != self.coverage_refs {
            return Err("basis.coverage_refs is not sorted and unique".into());
        }

        let mut routes = std::collections::BTreeSet::new();
        for route in &self.authority_route_refs {
            if route.authority_route_id.is_empty() {
                return Err("an authority route ref with no id".into());
            }
            if route.authority_rule_version == 0 {
                return Err("authority_rule_version must be positive".into());
            }
            if !is_sha256(&route.artifact_hash) {
                return Err("authority route artifact_hash is not a sha256".into());
            }
            if !routes.insert((
                route.authority_route_id.as_str(),
                route.authority_rule_version,
            )) {
                return Err(format!(
                    "authority route {} is pinned twice",
                    route.authority_route_id
                ));
            }
        }

        let mut edges = std::collections::BTreeSet::new();
        for addressed in &self.addressed_contradictions {
            if !is_id128(&addressed.edge_id) {
                return Err("addressed contradiction edge_id is not an id".into());
            }
            if !is_id128(&addressed.comparison_id) {
                return Err("addressed contradiction comparison_id is not an id".into());
            }
            // Addressing an edge with nothing is not addressing it.
            sorted_unique(
                "addressed contradiction evidence_refs",
                &addressed.evidence_refs,
            )?;
            for reference in &addressed.evidence_refs {
                if !self.evidence_refs.contains(reference) {
                    return Err(format!(
                        "contradiction evidence {reference} is not among the proposal's evidence \
                         refs"
                    ));
                }
            }
            if !edges.insert(addressed.edge_id.as_str()) {
                return Err(format!(
                    "contradiction edge {} appears twice",
                    addressed.edge_id
                ));
            }
        }
        let given: Vec<&str> = self
            .addressed_contradictions
            .iter()
            .map(|a| a.edge_id.as_str())
            .collect();
        if edges.into_iter().collect::<Vec<_>>() != given {
            return Err("addressed_contradictions is not sorted by edge id".into());
        }

        // An absence claim is a claim ABOUT COVERAGE. Without a coverage
        // reference there is nothing to check it against, and "we found
        // nothing" collapses into "we did not look".
        if self.absence_claim && self.coverage_refs.is_empty() {
            return Err(
                "an absence claim with no coverage reference is indistinguishable from not having \
                 looked"
                    .into(),
            );
        }
        Ok(())
    }
}

// --- Candidate search receipt (§15) ---------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExactLeg {
    pub query: String,
    pub candidate_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AliasLeg {
    pub queries: Vec<String>,
    pub candidate_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ScopedLeg {
    pub subject_id: String,
    pub scope: serde_json::Value,
    pub valid_interval: Option<super::ops::ValidInterval>,
    pub candidate_ids: Vec<String>,
}

/// M24 implements the deterministic legs only. The semantic leg is
/// explicitly `not_available` rather than quietly absent, so nobody can read
/// this receipt as proof that semantic retrieval happened. M26 implements it
/// and makes an attempted semantic leg a precondition for registering the
/// proposal tools at all.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SemanticStatus {
    NotAvailable,
    Attempted,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SemanticLeg {
    pub status: SemanticStatus,
    pub candidate_ids: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CandidateDecision {
    Update,
    Qualify,
    Distinct,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConsideredCandidate {
    pub candidate_id: String,
    pub decision: CandidateDecision,
    pub reason: String,
}

/// Server-minted proof that a search happened before a create. Callers
/// cannot author one: the whole value is that the SERVER ran the lookups
/// against a named index head, so "I checked" is a fact rather than a claim.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CandidateSearchReceipt {
    pub receipt_id: String,
    pub index_head: String,
    pub search_version: u64,
    pub exact: ExactLeg,
    pub aliases: AliasLeg,
    pub scoped: ScopedLeg,
    pub semantic: SemanticLeg,
    pub considered: Vec<ConsideredCandidate>,
}

impl CandidateSearchReceipt {
    /// Every candidate any leg returned, sorted and deduplicated.
    pub fn returned_candidates(&self) -> Vec<&str> {
        let mut all: Vec<&str> = self
            .exact
            .candidate_ids
            .iter()
            .chain(self.aliases.candidate_ids.iter())
            .chain(self.scoped.candidate_ids.iter())
            .chain(self.semantic.candidate_ids.iter())
            .map(String::as_str)
            .collect();
        all.sort_unstable();
        all.dedup();
        all
    }

    pub fn validate(&self) -> Result<(), String> {
        if !is_id128(&self.receipt_id) {
            return Err("candidate receipt_id is not an id".into());
        }
        if !is_id128(&self.index_head) {
            return Err("candidate receipt index_head is not an event id".into());
        }
        if self.search_version == 0 {
            return Err("search_version must be positive".into());
        }
        for (label, ids) in [
            ("exact", &self.exact.candidate_ids),
            ("aliases", &self.aliases.candidate_ids),
            ("scoped", &self.scoped.candidate_ids),
            ("semantic", &self.semantic.candidate_ids),
        ] {
            sorted_unique_or_empty(&format!("candidate receipt {label}"), ids)?;
        }
        if !is_id128(&self.scoped.subject_id) {
            return Err("candidate receipt scoped.subject_id is not an id".into());
        }
        // The semantic leg is unavailable in M24, and saying so is the
        // point: an empty `attempted` leg would read as "searched, found
        // nothing" when nothing was searched.
        if self.semantic.status == SemanticStatus::NotAvailable
            && !self.semantic.candidate_ids.is_empty()
        {
            return Err("an unavailable semantic leg cannot have returned candidates".into());
        }

        let mut considered = std::collections::BTreeSet::new();
        for candidate in &self.considered {
            if !is_id128(&candidate.candidate_id) {
                return Err("considered candidate_id is not an id".into());
            }
            if candidate.reason.trim().is_empty() {
                return Err("a considered candidate needs a reason".into());
            }
            if !considered.insert(candidate.candidate_id.as_str()) {
                return Err(format!(
                    "candidate {} is considered twice",
                    candidate.candidate_id
                ));
            }
        }
        // EVERY returned candidate must have a disposition. A search that
        // surfaced a duplicate and then ignored it is worse than no search:
        // it looks like diligence.
        for candidate in self.returned_candidates() {
            if !considered.contains(candidate) {
                return Err(format!(
                    "candidate_unconsidered: the search returned {candidate} and the proposal \
                     never says what it decided about it"
                ));
            }
        }
        Ok(())
    }
}

// --- Revert plans ---------------------------------------------------------

/// One stored inverse step. Only the five reversible ops can produce these,
/// and each step names exactly the state it restores.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum RevertStep {
    BeliefRevised {
        belief_id: String,
        patch: Vec<super::belief::PatchOp>,
        basis: super::belief::BeliefBasis,
    },
    LifecycleRestored {
        belief_id: String,
        from: super::lifecycle::Lifecycle,
        to: super::lifecycle::Lifecycle,
        relation_id: String,
        successor_id: String,
    },
    QualificationRestored {
        belief_id: String,
        from: super::lifecycle::Qualification,
        to: super::lifecycle::Qualification,
        qualification_profile: QualificationProfileRef,
    },
    RelationRestored {
        relation_id: String,
        action: super::belief::RelationAction,
        from: String,
        to: String,
        relation: super::belief::RelationKind,
    },
    ContestClosed {
        belief_id: String,
        open_contest_event_id: String,
        /// SYMBOLIC. The addressing event is the future revert
        /// application's own id, which cannot exist when the plan is
        /// stored; materializing it is the applier's job.
        addressed_by: ContestAddressing,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContestAddressing {
    RevertApplication,
}

/// The stored inverse of an applied change. Kept on `proposal.applied` for
/// exactly the ops whose policy rule says `one_click`.
///
/// Reverting is a NEW FORWARD MUTATION, never a deletion: history is never
/// rewound, and `expected_post_versions` is what makes "is this inverse
/// still safe?" answerable at click time rather than hopeful.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RevertPlan {
    pub source_operation_digest: String,
    pub expected_post_versions: Vec<PostVersion>,
    pub steps: Vec<RevertStep>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PostVersion {
    pub target_class: TargetClass,
    pub target_id: String,
    pub version: u64,
}

impl RevertPlan {
    pub fn validate(&self) -> Result<(), String> {
        if !is_sha256(&self.source_operation_digest) {
            return Err("revert plan source_operation_digest is not a sha256".into());
        }
        if self.steps.is_empty() {
            return Err("a revert plan with no steps reverts nothing".into());
        }
        if self.expected_post_versions.is_empty() {
            return Err(
                "a revert plan with no expected post-versions cannot tell whether it is still safe"
                    .into(),
            );
        }
        let mut seen = std::collections::BTreeSet::new();
        for post in &self.expected_post_versions {
            if !is_id128(&post.target_id) {
                return Err("revert plan target_id is not an id".into());
            }
            if !seen.insert((post.target_class, post.target_id.as_str())) {
                return Err(format!(
                    "revert plan names {}/{} twice",
                    post.target_class.as_str(),
                    post.target_id
                ));
            }
        }
        for step in &self.steps {
            match step {
                RevertStep::BeliefRevised { belief_id, .. } => {
                    if !is_id128(belief_id) {
                        return Err("revert step belief_id is not an id".into());
                    }
                }
                RevertStep::LifecycleRestored {
                    belief_id,
                    from,
                    to,
                    relation_id,
                    successor_id,
                } => {
                    if !is_id128(belief_id) || !is_id128(relation_id) || !is_id128(successor_id) {
                        return Err("revert step ids are not ids".into());
                    }
                    if (*from, *to)
                        != (
                            super::lifecycle::Lifecycle::Superseded,
                            super::lifecycle::Lifecycle::Active,
                        )
                    {
                        return Err(
                            "the only stored lifecycle inverse is superseded → active".into()
                        );
                    }
                }
                RevertStep::QualificationRestored {
                    belief_id,
                    from,
                    to,
                    qualification_profile,
                } => {
                    if !is_id128(belief_id) {
                        return Err("revert step belief_id is not an id".into());
                    }
                    if (*from, *to)
                        != (
                            super::lifecycle::Qualification::Qualified,
                            super::lifecycle::Qualification::Draft,
                        )
                    {
                        return Err(
                            "the only stored qualification inverse is qualified → draft".into()
                        );
                    }
                    qualification_profile.validate()?;
                }
                RevertStep::RelationRestored {
                    relation_id,
                    from,
                    to,
                    relation,
                    ..
                } => {
                    let derived = super::belief::derive_relation_id(from, to, *relation);
                    if &derived != relation_id {
                        return Err("revert step relation_id is not the derived identity".into());
                    }
                }
                RevertStep::ContestClosed {
                    belief_id,
                    open_contest_event_id,
                    ..
                } => {
                    if !is_id128(belief_id) || !is_id128(open_contest_event_id) {
                        return Err("revert step contest ids are not ids".into());
                    }
                }
            }
        }
        Ok(())
    }
}

// --- The proposal ---------------------------------------------------------

/// The frozen v1 proposal.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProposalV1 {
    pub schema: u64,
    pub proposal_id: String,
    pub run_id: String,
    pub targets: Vec<ProposalTarget>,
    pub op: ProposalOp,
    pub intended_use: IntendedUse,
    pub basis: ProposalBasis,
    pub declared_risk: Risk,
    /// DISPLAY ONLY. No policy rule reads it, ever.
    pub reason: String,
    pub candidate_search_receipt: Option<CandidateSearchReceipt>,
}

/// The schema version of the proposal record itself.
pub const PROPOSAL_SCHEMA: u64 = 1;

impl ProposalV1 {
    pub fn validate(&self) -> Result<(), String> {
        if self.schema != PROPOSAL_SCHEMA {
            return Err(format!("unsupported proposal schema {}", self.schema));
        }
        if !is_id128(&self.proposal_id) {
            return Err("proposal_id is not a stable 128-bit hex id".into());
        }
        if !is_id128(&self.run_id) {
            return Err("run_id is not a stable 128-bit hex id".into());
        }
        if self.targets.is_empty() {
            return Err("a proposal with no targets mutates nothing".into());
        }
        let mut seen = std::collections::BTreeSet::new();
        for target in &self.targets {
            if !is_id128(&target.target_id) {
                return Err(format!(
                    "target {:?} is not a stable 128-bit hex id",
                    target.target_id
                ));
            }
            if !seen.insert((target.target_class, target.target_id.as_str())) {
                return Err(format!(
                    "target {}/{} appears twice — one target, one expected version",
                    target.target_class.as_str(),
                    target.target_id
                ));
            }
        }
        // Sorted, so two spellings of one target set cannot both exist and
        // the operation digest is stable.
        let given: Vec<(TargetClass, &str)> = self
            .targets
            .iter()
            .map(|t| (t.target_class, t.target_id.as_str()))
            .collect();
        if seen.into_iter().collect::<Vec<_>>() != given {
            return Err("targets are not in canonical (class, id) order".into());
        }

        self.op.validate()?;
        self.basis.validate()?;
        if self.reason.trim().is_empty() {
            // Display-only does not mean optional: a queued card with no
            // sentence on it is unreviewable.
            return Err("reason is empty — it is display text, but a card needs one".into());
        }
        if let Some(receipt) = &self.candidate_search_receipt {
            receipt.validate()?;
        }
        // A create without a receipt is the §15 failure this milestone
        // exists to prevent; the receipt's presence is checked here and its
        // freshness at append time (M24.7).
        if matches!(self.op, ProposalOp::CreateBelief { .. })
            && self.candidate_search_receipt.is_none()
        {
            return Err(
                "candidate_receipt_missing: creating a Belief requires a server-minted candidate \
                 search receipt"
                    .into(),
            );
        }
        // Everything else must NOT carry one: a receipt on an update would
        // be evidence of a search that decided nothing.
        if !matches!(self.op, ProposalOp::CreateBelief { .. })
            && self.candidate_search_receipt.is_some()
        {
            return Err("only create_belief carries a candidate search receipt".into());
        }
        Ok(())
    }

    /// The target classes this proposal names, sorted and deduplicated —
    /// what the policy table's per-op `target_classes` is checked against.
    pub fn target_classes(&self) -> Vec<&'static str> {
        let mut classes: Vec<&'static str> = self
            .targets
            .iter()
            .map(|t| t.target_class.as_str())
            .collect();
        classes.sort_unstable();
        classes.dedup();
        classes
    }

    pub fn canonical(&self) -> Result<String, String> {
        canonical_json(self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ledger::schema::belief::BeliefBasis;

    const A: &str = "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";
    const B: &str = "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2";
    const C: &str = "c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3";

    fn basis() -> ProposalBasis {
        ProposalBasis {
            transition_cause: TransitionCause::NewEvidence,
            evidence_refs: vec![],
            coverage_refs: vec![],
            authority_refs: vec![],
            authority_route_refs: vec![],
            addressed_contradictions: vec![],
            absence_claim: false,
        }
    }

    fn proposal(op: ProposalOp, targets: Vec<ProposalTarget>) -> ProposalV1 {
        ProposalV1 {
            schema: PROPOSAL_SCHEMA,
            proposal_id: A.into(),
            run_id: B.into(),
            targets,
            op,
            intended_use: IntendedUse {
                kind: IntendedUseKind::ReversibleWork,
                stakes: Risk::Low,
                predicate_class: None,
            },
            basis: basis(),
            declared_risk: Risk::Medium,
            reason: "a synthetic proposal".into(),
            candidate_search_receipt: None,
        }
    }

    fn target(id: &str, class: TargetClass, version: Option<u64>) -> ProposalTarget {
        ProposalTarget {
            target_id: id.into(),
            target_class: class,
            expected_version: version,
        }
    }

    fn supersede() -> ProposalOp {
        ProposalOp::SupersedeBelief {
            belief_id: A.into(),
            successor_id: B.into(),
        }
    }

    #[test]
    fn a_complete_proposal_validates() {
        let p = proposal(
            supersede(),
            vec![
                target(A, TargetClass::Belief, Some(3)),
                target(B, TargetClass::Belief, Some(1)),
            ],
        );
        assert!(p.validate().is_ok(), "{:?}", p.validate());
        assert_eq!(p.target_classes(), vec!["belief"]);
    }

    #[test]
    fn one_target_gets_one_expected_version() {
        // Two entries for one target would let a proposal satisfy CAS
        // against whichever version happened to be checked.
        let p = proposal(
            supersede(),
            vec![
                target(A, TargetClass::Belief, Some(3)),
                target(A, TargetClass::Belief, Some(4)),
            ],
        );
        assert!(p.validate().unwrap_err().contains("appears twice"));
    }

    #[test]
    fn targets_are_canonically_ordered() {
        let p = proposal(
            supersede(),
            vec![
                target(B, TargetClass::Belief, Some(1)),
                target(A, TargetClass::Belief, Some(3)),
            ],
        );
        assert!(p.validate().unwrap_err().contains("canonical"));
    }

    #[test]
    fn authority_must_be_a_subset_of_evidence() {
        // Otherwise a proposal could cite an authority record its basis
        // never actually relies on.
        let mut p = proposal(
            supersede(),
            vec![
                target(A, TargetClass::Belief, Some(1)),
                target(B, TargetClass::Belief, Some(1)),
            ],
        );
        p.basis.authority_refs = vec![C.into()];
        assert!(p
            .validate()
            .unwrap_err()
            .contains("not among the evidence refs"));
        p.basis.evidence_refs = vec![C.into()];
        assert!(p.validate().is_ok());
    }

    #[test]
    fn an_absence_claim_needs_a_coverage_reference() {
        let mut p = proposal(
            supersede(),
            vec![
                target(A, TargetClass::Belief, Some(1)),
                target(B, TargetClass::Belief, Some(1)),
            ],
        );
        p.basis.absence_claim = true;
        assert!(p
            .validate()
            .unwrap_err()
            .contains("indistinguishable from not having looked"));
        p.basis.coverage_refs = vec!["coverage-1".into()];
        assert!(p.validate().is_ok());
    }

    #[test]
    fn creating_without_a_receipt_is_refused_and_updating_with_one_is_too() {
        let create = ProposalOp::CreateBelief {
            belief_id: C.into(),
            subject: super::super::subject::SubjectRef::Resolved {
                entity_id: A.into(),
                aliases: vec![],
            },
            content: "c".into(),
            fields: serde_json::json!({}),
            basis: BeliefBasis::Unsupported {
                reason: "new".into(),
            },
            distinctness_reason: "nothing matched".into(),
        };
        let p = proposal(create, vec![target(C, TargetClass::Belief, None)]);
        assert!(p
            .validate()
            .unwrap_err()
            .contains("candidate_receipt_missing"));

        let mut p = proposal(
            supersede(),
            vec![
                target(A, TargetClass::Belief, Some(1)),
                target(B, TargetClass::Belief, Some(1)),
            ],
        );
        p.candidate_search_receipt = Some(receipt(vec![]));
        assert!(p
            .validate()
            .unwrap_err()
            .contains("only create_belief carries"));
    }

    fn receipt(considered: Vec<ConsideredCandidate>) -> CandidateSearchReceipt {
        CandidateSearchReceipt {
            receipt_id: A.into(),
            index_head: B.into(),
            search_version: 1,
            exact: ExactLeg {
                query: "q".into(),
                candidate_ids: vec![],
            },
            aliases: AliasLeg {
                queries: vec!["q".into()],
                candidate_ids: vec![],
            },
            scoped: ScopedLeg {
                subject_id: A.into(),
                scope: serde_json::json!({}),
                valid_interval: None,
                candidate_ids: vec![],
            },
            semantic: SemanticLeg {
                status: SemanticStatus::NotAvailable,
                candidate_ids: vec![],
            },
            considered,
        }
    }

    #[test]
    fn a_returned_candidate_with_no_disposition_is_refused() {
        // The §15 failure mode: a search that surfaced a duplicate and then
        // ignored it looks like diligence and is worse than no search.
        let mut r = receipt(vec![]);
        r.exact.candidate_ids = vec![C.into()];
        assert!(r.validate().unwrap_err().contains("candidate_unconsidered"));
        r.considered = vec![ConsideredCandidate {
            candidate_id: C.into(),
            decision: CandidateDecision::Distinct,
            reason: "different scope".into(),
        }];
        assert!(r.validate().is_ok());
    }

    #[test]
    fn an_unavailable_semantic_leg_cannot_have_found_anything() {
        let mut r = receipt(vec![]);
        r.semantic.candidate_ids = vec![C.into()];
        assert!(r
            .validate()
            .unwrap_err()
            .contains("unavailable semantic leg"));
    }

    #[test]
    fn a_revert_plan_stores_only_the_inverses_that_exist() {
        let plan = |steps: Vec<RevertStep>| RevertPlan {
            source_operation_digest: "1".repeat(64),
            expected_post_versions: vec![PostVersion {
                target_class: TargetClass::Belief,
                target_id: A.into(),
                version: 4,
            }],
            steps,
        };
        let relation = super::super::belief::derive_relation_id(
            B,
            A,
            super::super::belief::RelationKind::Supersedes,
        );
        assert!(plan(vec![RevertStep::LifecycleRestored {
            belief_id: A.into(),
            from: super::super::lifecycle::Lifecycle::Superseded,
            to: super::super::lifecycle::Lifecycle::Active,
            relation_id: relation,
            successor_id: B.into(),
        }])
        .validate()
        .is_ok());
        // Un-archiving is not a stored inverse; it would be a new proposal.
        assert!(plan(vec![RevertStep::LifecycleRestored {
            belief_id: A.into(),
            from: super::super::lifecycle::Lifecycle::Archived,
            to: super::super::lifecycle::Lifecycle::Active,
            relation_id: "0".repeat(32),
            successor_id: B.into(),
        }])
        .validate()
        .unwrap_err()
        .contains("only stored lifecycle inverse"));
        assert!(plan(vec![])
            .validate()
            .unwrap_err()
            .contains("reverts nothing"));
    }

    #[test]
    fn the_contest_inverse_stays_symbolic() {
        // The addressing event is the future revert application's own id.
        // Guessing or hashing it into the stored plan would bind a physical
        // id that does not exist yet.
        let step = RevertStep::ContestClosed {
            belief_id: A.into(),
            open_contest_event_id: B.into(),
            addressed_by: ContestAddressing::RevertApplication,
        };
        let raw = serde_json::to_value(&step).unwrap();
        // The step names the contest it closes — that event already exists.
        assert_eq!(raw["open_contest_event_id"], serde_json::json!(B));
        // But WHAT addresses it is a symbolic token, not an id: the
        // addressing event is the future revert application's own, and it
        // cannot exist when the plan is stored.
        assert_eq!(raw["addressed_by"], serde_json::json!("revert_application"));
    }
}
