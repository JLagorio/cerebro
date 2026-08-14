//! `ingest.semantic_assessed` (M26.4): what the one semantic run per settled
//! window concluded.
//!
//! M25's prefilter emits two branches it cannot finish — `material_candidate`
//! and `needs_semantic_judgment` — and parks both on an `m26_queued` receipt.
//! This is the event that answers them. One event per settled window, not per
//! file and not per role: Observer, Extractor, Resolver and Proposer share a
//! single run, and this is that run's single disposition.
//!
//! **It is processing history, never evidence.** Like the receipt it succeeds,
//! it says which items were looked at and what happened; it says nothing about
//! what is true. The reducer indexes it and stops — it never enters
//! Observation lineage, never enters Support, and has no registered-target
//! version effect. `semantic_assessment_id` is an idempotent history key, not
//! a CAS target, and neither the receipts it names nor the proposals it
//! carries advance a version merely by being referenced.
//!
//! **The outcome table is closed and total.** Three outcomes, three
//! dispositions, and exactly one legal pairing each — so six of the nine
//! combinations do not deserialize at all. A run that concluded nothing and a
//! run that was interrupted are different events with different obligations,
//! and neither can borrow the other's shape.
//!
//! **"Not material" is a real answer.** The pass is allowed to conclude that a
//! window changed nothing worth recording — but it must say which of §17's
//! four dimensions it evaluated to get there. A window with zero field changes
//! and a new independent source is MATERIAL on `evidence_state`; "no field
//! changed → discard" is the reasoning this shape exists to make unsayable.

use serde::{Deserialize, Serialize};

use super::{is_id128, schema_body, sha256_first128, MaterialDimension};

/// What the run concluded about the window.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SemanticOutcome {
    Material,
    NonMaterial,
    Undetermined,
}

/// Where the window ended up. Pinned one-to-one to the outcome: the pair is
/// carried in the event so a reader never has to infer one from the other,
/// and checked here so the two can never disagree.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SemanticDisposition {
    ProposalsSubmitted,
    ClosedNonMaterial,
    BlockedVisible,
}

/// Why an undetermined window stopped. Closed: a blocked run names one of
/// these or it is not a blocked run. "Something went wrong" is not a member,
/// because a reason nobody can act on is the same as no reason.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BlockedReason {
    /// A queued receipt in the window could not be read back.
    BatchInputIncomplete,
    /// The policy table or one of its artifacts was unavailable, so no
    /// proposal could be evaluated. Never used for a policy REFUSAL — a
    /// refusal is an answer.
    PolicyDependencyUnavailable,
    /// The CLI session could not be started or did not survive the run.
    RuntimeUnavailable,
    /// The run returned, and what it returned was not a valid proposal set.
    SemanticValidationFailed,
    /// The bytes the window was about stopped being reachable mid-run.
    SourceAccessLost,
}

impl BlockedReason {
    pub fn as_str(self) -> &'static str {
        match self {
            BlockedReason::BatchInputIncomplete => "batch_input_incomplete",
            BlockedReason::PolicyDependencyUnavailable => "policy_dependency_unavailable",
            BlockedReason::RuntimeUnavailable => "runtime_unavailable",
            BlockedReason::SemanticValidationFailed => "semantic_validation_failed",
            BlockedReason::SourceAccessLost => "source_access_lost",
        }
    }
}

/// Who wrote `explanation`. One variant today and that is the point: the
/// field exists so a reader never has to guess whether the prose in front of
/// them came from a model, and a future system-written explanation is an
/// added variant rather than a changed meaning.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContentLabel {
    AgentSupplied,
}

/// The ceiling on agent prose in the vault ledger.
///
/// The ledger is append-only NDJSON that a human is expected to be able to
/// read, and `explanation` is the one field a model writes freely. Unbounded,
/// a single confused run can put a page of text into a file nobody can
/// rewrite. The bound is generous for a sentence or two of reasoning and
/// hostile to an essay.
pub const MAX_EXPLANATION_BYTES: usize = 2_000;

/// Which references a given outcome requires, forbids, or leaves open.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Refs {
    Required,
    Forbidden,
    Free,
}

impl SemanticOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            SemanticOutcome::Material => "material",
            SemanticOutcome::NonMaterial => "non_material",
            SemanticOutcome::Undetermined => "undetermined",
        }
    }

    /// The one disposition this outcome may carry. This is the closed table:
    /// everything else about the event follows from the outcome, and the
    /// disposition is checked against it rather than validated separately.
    fn disposition(self) -> SemanticDisposition {
        match self {
            SemanticOutcome::Material => SemanticDisposition::ProposalsSubmitted,
            SemanticOutcome::NonMaterial => SemanticDisposition::ClosedNonMaterial,
            SemanticOutcome::Undetermined => SemanticDisposition::BlockedVisible,
        }
    }

    fn material_dimensions(self) -> Refs {
        match self {
            SemanticOutcome::Material => Refs::Required,
            SemanticOutcome::NonMaterial | SemanticOutcome::Undetermined => Refs::Forbidden,
        }
    }

    fn proposals(self) -> Refs {
        match self {
            SemanticOutcome::Material => Refs::Required,
            SemanticOutcome::NonMaterial | SemanticOutcome::Undetermined => Refs::Forbidden,
        }
    }

    fn blocked_reason(self) -> Refs {
        match self {
            SemanticOutcome::Undetermined => Refs::Required,
            SemanticOutcome::Material | SemanticOutcome::NonMaterial => Refs::Forbidden,
        }
    }

    /// A window that reached a verdict must say what it looked at. A window
    /// that was interrupted may not have got that far, and pretending it did
    /// would be the dishonest half of `undetermined`.
    fn evaluated_dimensions(self) -> Refs {
        match self {
            SemanticOutcome::Material | SemanticOutcome::NonMaterial => Refs::Required,
            SemanticOutcome::Undetermined => Refs::Free,
        }
    }

    /// The M25 scheduler state this outcome restores for its window's items.
    /// Named here, beside the outcomes, so routing and recovery cannot drift
    /// — the same discipline `Route::scheduler_state` follows.
    pub fn scheduler_state(self) -> &'static str {
        match self {
            SemanticOutcome::Material | SemanticOutcome::NonMaterial => "consumed",
            // Never auto-retried: an owner retry or changed bytes, or it stays
            // visible. A blocked window that quietly re-ran would be the
            // automatic duplicate spend M25 exists to prevent.
            SemanticOutcome::Undetermined => "recovery_held",
        }
    }

    pub const ALL: [SemanticOutcome; 3] = [
        SemanticOutcome::Material,
        SemanticOutcome::NonMaterial,
        SemanticOutcome::Undetermined,
    ];
}

impl SemanticDisposition {
    pub fn as_str(self) -> &'static str {
        match self {
            SemanticDisposition::ProposalsSubmitted => "proposals_submitted",
            SemanticDisposition::ClosedNonMaterial => "closed_non_material",
            SemanticDisposition::BlockedVisible => "blocked_visible",
        }
    }

    pub const ALL: [SemanticDisposition; 3] = [
        SemanticDisposition::ProposalsSubmitted,
        SemanticDisposition::ClosedNonMaterial,
        SemanticDisposition::BlockedVisible,
    ];
}

schema_body! {
    /// One semantic run's disposition of one settled change-window.
    pub struct IngestSemanticAssessed {
        /// Derived from the window's inputs (see
        /// [`derive_semantic_assessment_id`]), which is what makes "at most
        /// one semantic run per settled window" structural rather than a rule
        /// somebody remembers: a second run over the same inputs mints the
        /// same id and the reducer refuses it.
        pub semantic_assessment_id: String,
        /// The window this run answered — the same key its queued receipts
        /// carry.
        pub m26_batch_key: String,
        /// The `m26_queued` receipts this run consumed. Non-empty: a run with
        /// no inputs assessed nothing.
        pub input_receipt_ids: Vec<String>,
        pub outcome: SemanticOutcome,
        pub disposition: SemanticDisposition,
        /// Which of §17's four dimensions the run actually considered.
        pub evaluated_dimensions: Vec<MaterialDimension>,
        /// Which of those it found movement on. Always a subset of
        /// `evaluated_dimensions` — claiming materiality on a dimension you
        /// did not look at is the one arithmetic this event forbids outright.
        pub material_dimensions: Vec<MaterialDimension>,
        pub proposal_ids: Vec<String>,
        pub blocked_reason: Option<BlockedReason>,
        /// Agent-written display text. Untrusted prose, labeled as such.
        pub explanation: String,
        pub content_label: ContentLabel,
    }
}

fn sorted_unique(ids: &[String]) -> bool {
    ids.windows(2).all(|pair| pair[0] < pair[1])
}

fn sorted_unique_dimensions(dimensions: &[MaterialDimension]) -> bool {
    dimensions.windows(2).all(|pair| pair[0] < pair[1])
}

impl IngestSemanticAssessed {
    pub fn validate(&self) -> Result<(), String> {
        self.validate_common()?;
        if !is_id128(&self.semantic_assessment_id) {
            return Err("semantic_assessment_id must be a 128-bit hex id".into());
        }
        if self.m26_batch_key.is_empty() {
            return Err("m26_batch_key must be non-empty".into());
        }
        if self.explanation.is_empty() {
            return Err("explanation must be non-empty — a disposition states its reason".into());
        }
        if self.explanation.len() > MAX_EXPLANATION_BYTES {
            return Err(format!(
                "explanation is bounded at {MAX_EXPLANATION_BYTES} bytes"
            ));
        }

        if self.disposition != self.outcome.disposition() {
            return Err(format!(
                "outcome {} carries disposition {}, never {} — the table is closed",
                self.outcome.as_str(),
                self.outcome.disposition().as_str(),
                self.disposition.as_str()
            ));
        }

        self.validate_dimensions()?;
        self.validate_refs()?;
        Ok(())
    }

    fn validate_dimensions(&self) -> Result<(), String> {
        for (name, dimensions) in [
            ("evaluated_dimensions", &self.evaluated_dimensions),
            ("material_dimensions", &self.material_dimensions),
        ] {
            if !sorted_unique_dimensions(dimensions) {
                return Err(format!("{name} must be sorted and duplicate-free"));
            }
        }
        check_dimensions(
            "evaluated_dimensions",
            self.outcome.evaluated_dimensions(),
            &self.evaluated_dimensions,
            self.outcome,
        )?;
        check_dimensions(
            "material_dimensions",
            self.outcome.material_dimensions(),
            &self.material_dimensions,
            self.outcome,
        )?;
        if let Some(unevaluated) = self
            .material_dimensions
            .iter()
            .find(|d| !self.evaluated_dimensions.contains(d))
        {
            return Err(format!(
                "material dimension {} was never evaluated — materiality is a subset of what \
                 the run looked at",
                unevaluated.as_str()
            ));
        }
        Ok(())
    }

    fn validate_refs(&self) -> Result<(), String> {
        for (name, ids) in [
            ("input_receipt_ids", &self.input_receipt_ids),
            ("proposal_ids", &self.proposal_ids),
        ] {
            if !sorted_unique(ids) {
                return Err(format!("{name} must be sorted and duplicate-free"));
            }
            if ids.iter().any(|id| !is_id128(id)) {
                return Err(format!("{name} entries must be 128-bit hex ids"));
            }
        }
        // Inputs are required for every outcome including a blocked one: a
        // window that never had inputs is not a window.
        if self.input_receipt_ids.is_empty() {
            return Err(
                "input_receipt_ids must be non-empty — a run with no inputs \
                        assessed nothing"
                    .into(),
            );
        }
        check_ids(
            "proposal_ids",
            self.outcome.proposals(),
            &self.proposal_ids,
            self.outcome,
        )?;
        match (self.outcome.blocked_reason(), &self.blocked_reason) {
            (Refs::Required, None) => Err(format!(
                "outcome {} names one blocked reason",
                self.outcome.as_str()
            )),
            (Refs::Forbidden, Some(reason)) => Err(format!(
                "outcome {} is not blocked, and names {}",
                self.outcome.as_str(),
                reason.as_str()
            )),
            _ => Ok(()),
        }
    }

    /// The append-once key. The window and the run's inputs are the whole
    /// identity: the same settled window cannot be assessed twice, which is
    /// the "at most one semantic run per settled window" rule expressed where
    /// it cannot be forgotten.
    pub fn idempotency(&self) -> String {
        format!(
            "ingest-semantic-v1:{}:{}",
            self.m26_batch_key, self.semantic_assessment_id
        )
    }
}

fn check_dimensions(
    name: &str,
    rule: Refs,
    dimensions: &[MaterialDimension],
    outcome: SemanticOutcome,
) -> Result<(), String> {
    match rule {
        Refs::Required if dimensions.is_empty() => Err(format!(
            "outcome {} requires at least one {name}",
            outcome.as_str()
        )),
        Refs::Forbidden if !dimensions.is_empty() => {
            Err(format!("outcome {} names no {name}", outcome.as_str()))
        }
        _ => Ok(()),
    }
}

fn check_ids(
    name: &str,
    rule: Refs,
    ids: &[String],
    outcome: SemanticOutcome,
) -> Result<(), String> {
    match rule {
        Refs::Required if ids.is_empty() => Err(format!(
            "outcome {} requires at least one {name} entry",
            outcome.as_str()
        )),
        Refs::Forbidden if !ids.is_empty() => {
            Err(format!("outcome {} carries no {name}", outcome.as_str()))
        }
        _ => Ok(()),
    }
}

/// `sha256_first128("m26-window-v1" | 0x00 | store | 0x00 | each receipt id)`.
///
/// The window IS its queued receipts. Deriving the key from them rather than
/// from a clock or a counter means two schedulers that saw the same settled
/// set agree on the key without coordinating, and a window that gained an
/// item is a DIFFERENT window rather than the same one silently grown.
///
/// Receipt ids are sorted here rather than required sorted: a caller that
/// collected them in scan order should not mint a second key for the same
/// set.
pub fn derive_m26_batch_key(store_id: &str, queued_receipt_ids: &[String]) -> String {
    let mut sorted: Vec<&str> = queued_receipt_ids.iter().map(String::as_str).collect();
    sorted.sort_unstable();
    sorted.dedup();
    let mut bytes = Vec::new();
    bytes.extend_from_slice(b"m26-window-v1");
    bytes.push(0);
    bytes.extend_from_slice(store_id.as_bytes());
    for id in sorted {
        bytes.push(0);
        bytes.extend_from_slice(id.as_bytes());
    }
    sha256_first128(&bytes)
}

/// `sha256_first128("m26-semantic-v1" | 0x00 | store | 0x00 | batch key)`.
///
/// Deliberately NOT a function of the outcome. Two runs over one settled
/// window mint the same assessment id whatever they concluded, so the second
/// one collides and is refused rather than appending a second opinion — the
/// duplicate spend M25 meters against, made impossible rather than merely
/// discouraged.
pub fn derive_semantic_assessment_id(store_id: &str, m26_batch_key: &str) -> String {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(b"m26-semantic-v1");
    for part in [store_id, m26_batch_key] {
        bytes.push(0);
        bytes.extend_from_slice(part.as_bytes());
    }
    sha256_first128(&bytes)
}

#[cfg(test)]
mod tests {
    use super::super::tests::{common, ID_A, ID_B, ID_C};
    use super::*;

    /// A valid body for every outcome — the closed table, made concrete.
    fn valid(outcome: SemanticOutcome) -> IngestSemanticAssessed {
        let (schema, actor) = common("agent:m26-ingest");
        IngestSemanticAssessed {
            schema,
            batch_id: None,
            idempotency_key: None,
            actor,
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            semantic_assessment_id: ID_A.into(),
            m26_batch_key: "window-1".into(),
            input_receipt_ids: vec![ID_B.into()],
            outcome,
            disposition: outcome.disposition(),
            evaluated_dimensions: match outcome {
                SemanticOutcome::Undetermined => vec![],
                _ => vec![
                    MaterialDimension::EvidenceState,
                    MaterialDimension::WorldState,
                ],
            },
            material_dimensions: match outcome {
                SemanticOutcome::Material => vec![MaterialDimension::EvidenceState],
                _ => vec![],
            },
            proposal_ids: match outcome {
                SemanticOutcome::Material => vec![ID_C.into()],
                _ => vec![],
            },
            blocked_reason: match outcome {
                SemanticOutcome::Undetermined => Some(BlockedReason::RuntimeUnavailable),
                _ => None,
            },
            explanation: "what the run concluded, in its own words".into(),
            content_label: ContentLabel::AgentSupplied,
        }
    }

    #[test]
    fn every_outcome_has_a_valid_shape() {
        for outcome in SemanticOutcome::ALL {
            valid(outcome)
                .validate()
                .unwrap_or_else(|e| panic!("{}: {e}", outcome.as_str()));
        }
    }

    #[test]
    fn six_of_the_nine_outcome_disposition_pairings_do_not_exist() {
        // The table is not "usually the disposition follows the outcome". It
        // is three pairs, and the other six are refused by name.
        let mut legal = 0;
        for outcome in SemanticOutcome::ALL {
            for disposition in SemanticDisposition::ALL {
                let mut body = valid(outcome);
                body.disposition = disposition;
                if disposition == outcome.disposition() {
                    body.validate().expect("the legal pairing");
                    legal += 1;
                } else {
                    let err = body.validate().expect_err("an illegal pairing");
                    assert!(err.contains("the table is closed"), "{err}");
                }
            }
        }
        assert_eq!(legal, 3, "exactly one disposition per outcome");
    }

    #[test]
    fn a_decided_window_says_what_it_looked_at() {
        for outcome in [SemanticOutcome::Material, SemanticOutcome::NonMaterial] {
            let mut body = valid(outcome);
            body.evaluated_dimensions.clear();
            body.material_dimensions.clear();
            let err = body
                .validate()
                .expect_err("a verdict with no look behind it");
            assert!(err.contains("evaluated_dimensions"), "{err}");
        }
        // A blocked run is not asked to, because it may not have got there.
        let mut blocked = valid(SemanticOutcome::Undetermined);
        blocked.evaluated_dimensions.clear();
        blocked.validate().expect("a blocked run evaluated nothing");
    }

    #[test]
    fn materiality_cannot_name_a_dimension_the_run_never_evaluated() {
        let mut body = valid(SemanticOutcome::Material);
        body.material_dimensions = vec![MaterialDimension::Attention];
        let err = body.validate().expect_err("materiality outside the look");
        assert!(err.contains("was never evaluated"), "{err}");
    }

    #[test]
    fn corroboration_alone_is_material_on_evidence_state() {
        // The §17 case "no field changed → discard" is forbidden by: zero
        // world-state movement, a new independent source, MATERIAL.
        let mut body = valid(SemanticOutcome::Material);
        body.evaluated_dimensions = vec![MaterialDimension::EvidenceState];
        body.material_dimensions = vec![MaterialDimension::EvidenceState];
        body.validate().expect("corroboration is materiality");
    }

    #[test]
    fn a_run_with_no_inputs_assessed_nothing() {
        for outcome in SemanticOutcome::ALL {
            let mut body = valid(outcome);
            body.input_receipt_ids.clear();
            let err = body.validate().expect_err("a window with no items");
            assert!(err.contains("input_receipt_ids"), "{err}");
        }
    }

    #[test]
    fn only_a_blocked_run_names_a_reason_and_it_must() {
        let mut blocked = valid(SemanticOutcome::Undetermined);
        blocked.blocked_reason = None;
        assert!(blocked
            .validate()
            .expect_err("blocked with no reason")
            .contains("names one blocked reason"));

        for outcome in [SemanticOutcome::Material, SemanticOutcome::NonMaterial] {
            let mut body = valid(outcome);
            body.blocked_reason = Some(BlockedReason::SourceAccessLost);
            assert!(body
                .validate()
                .expect_err("a decided run that claims to be blocked")
                .contains("is not blocked"));
        }
    }

    #[test]
    fn only_a_material_run_carries_proposals_and_it_must() {
        let mut material = valid(SemanticOutcome::Material);
        material.proposal_ids.clear();
        assert!(material
            .validate()
            .expect_err("material with nothing proposed")
            .contains("proposal_ids"));

        for outcome in [SemanticOutcome::NonMaterial, SemanticOutcome::Undetermined] {
            let mut body = valid(outcome);
            body.proposal_ids = vec![ID_C.into()];
            assert!(body
                .validate()
                .expect_err("a closed window carrying proposals")
                .contains("carries no proposal_ids"));
        }
    }

    #[test]
    fn lists_are_sorted_and_duplicate_free() {
        let mut body = valid(SemanticOutcome::Material);
        body.input_receipt_ids = vec![ID_C.into(), ID_B.into()];
        assert!(body.validate().expect_err("unsorted").contains("sorted"));

        let mut dims = valid(SemanticOutcome::NonMaterial);
        dims.evaluated_dimensions =
            vec![MaterialDimension::WorldState, MaterialDimension::Attention];
        assert!(dims.validate().expect_err("unsorted").contains("sorted"));
    }

    #[test]
    fn agent_prose_is_required_and_bounded() {
        let mut empty = valid(SemanticOutcome::NonMaterial);
        empty.explanation = String::new();
        assert!(empty
            .validate()
            .expect_err("no reason")
            .contains("non-empty"));

        let mut essay = valid(SemanticOutcome::NonMaterial);
        essay.explanation = "x".repeat(MAX_EXPLANATION_BYTES + 1);
        assert!(essay.validate().expect_err("an essay").contains("bounded"));

        let mut edge = valid(SemanticOutcome::NonMaterial);
        edge.explanation = "x".repeat(MAX_EXPLANATION_BYTES);
        edge.validate().expect("the bound is inclusive");
    }

    #[test]
    fn the_window_key_is_its_items_and_order_does_not_change_it() {
        let a = derive_m26_batch_key("store", &[ID_A.into(), ID_B.into()]);
        assert_eq!(
            a,
            derive_m26_batch_key("store", &[ID_B.into(), ID_A.into()])
        );
        assert_eq!(
            a,
            derive_m26_batch_key("store", &[ID_B.into(), ID_A.into(), ID_B.into()])
        );
        // A window that gained an item is a DIFFERENT window, never the same
        // one quietly grown.
        assert_ne!(a, derive_m26_batch_key("store", &[ID_A.into()]));
        assert_ne!(
            a,
            derive_m26_batch_key("other", &[ID_A.into(), ID_B.into()])
        );
    }

    #[test]
    fn the_assessment_id_does_not_depend_on_what_the_run_concluded() {
        // This is the whole "at most one semantic run per settled window"
        // rule: a second run mints the SAME id whatever it decided, so it
        // collides instead of appending a second opinion.
        let window = derive_m26_batch_key("store", &[ID_A.into()]);
        let id = derive_semantic_assessment_id("store", &window);
        assert_eq!(id, derive_semantic_assessment_id("store", &window));
        assert_ne!(id, derive_semantic_assessment_id("other", &window));
        assert_ne!(id, derive_semantic_assessment_id("store", "another-window"));
    }

    #[test]
    fn the_idempotency_key_is_the_window_and_its_assessment() {
        let body = valid(SemanticOutcome::Material);
        let mut second_opinion = valid(SemanticOutcome::Undetermined);
        second_opinion.m26_batch_key = body.m26_batch_key.clone();
        assert_eq!(body.idempotency(), second_opinion.idempotency());
    }
}
