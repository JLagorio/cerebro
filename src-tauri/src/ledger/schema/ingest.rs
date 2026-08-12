//! `ingest.assessed` (M25.3): the portable processing receipt.
//!
//! **This is not telemetry and it is not evidence.** It carries no tokens, no
//! retries, no quota window, no duration, and no model name — those are
//! operational and live in `runtime.db` (D5). It never enters evidence
//! lineage or Support either: a receipt says which stable source item, at
//! which exact bytes, received which deterministic disposition. Nothing
//! about what is TRUE.
//!
//! Its materiality is observability and safe reconstruction. A runtime
//! database that was deleted can read these back and know what has already
//! been processed, which is the difference between "no automatic duplicate
//! spend" and a vault that reprocesses itself from scratch.
//!
//! **A receipt is part of the transition it describes.** Every changed item
//! batches its new Observation(s) with its first receipt, so a crash exposes
//! either the prior state or the complete association — never an Observation
//! whose work is untracked, nor an applied proposal with no source item
//! behind it.
//!
//! **The route matrix is closed and total.** Every prefilter verdict has
//! exactly one terminal route, every route declares which refs it requires
//! and which it forbids, and both are checked here. A verdict that fell out
//! of a `match` with nowhere to go is the failure mode this table exists to
//! make impossible.

use serde::{Deserialize, Serialize};

use super::{is_id128, is_sha256, schema_body, sha256_first128};

/// What the deterministic prefilter concluded. `needs_semantic_judgment` is a
/// QUEUE TAG for M26, never a call into a model from here.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PrefilterVerdict {
    NoChange,
    NonMaterialChange,
    MaterialCandidate,
    NeedsSemanticJudgment,
}

impl PrefilterVerdict {
    pub fn as_str(self) -> &'static str {
        match self {
            PrefilterVerdict::NoChange => "no_change",
            PrefilterVerdict::NonMaterialChange => "non_material_change",
            PrefilterVerdict::MaterialCandidate => "material_candidate",
            PrefilterVerdict::NeedsSemanticJudgment => "needs_semantic_judgment",
        }
    }
}

/// The four dimensions of materiality (§17). Independent corroboration is
/// `evidence_state` and is material even when the believed value did not
/// move, which is why "no field changed → discard" is forbidden.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MaterialDimension {
    Attention,
    BeliefState,
    EvidenceState,
    WorldState,
}

impl MaterialDimension {
    pub fn as_str(self) -> &'static str {
        match self {
            MaterialDimension::Attention => "attention",
            MaterialDimension::BeliefState => "belief_state",
            MaterialDimension::EvidenceState => "evidence_state",
            MaterialDimension::WorldState => "world_state",
        }
    }
}

/// M22's exact tri-state. `independence_unknown` is not weak corroboration.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Independence {
    IndependenceUnknown,
    KnownIndependent,
    KnownSameLineage,
}

/// Where an assessed item ended up. One terminal route per verdict; the
/// matrix below is the whole contract.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Route {
    ClosedNoChange,
    ClosedNonMaterial,
    DeterministicProposalApplied,
    DeterministicProposalQueued,
    DeterministicProposalRejected,
    M26Queued,
    M26Completed,
    FailedVisible,
}

impl Route {
    pub fn as_str(self) -> &'static str {
        match self {
            Route::ClosedNoChange => "closed_no_change",
            Route::ClosedNonMaterial => "closed_non_material",
            Route::DeterministicProposalApplied => "deterministic_proposal_applied",
            Route::DeterministicProposalQueued => "deterministic_proposal_queued",
            Route::DeterministicProposalRejected => "deterministic_proposal_rejected",
            Route::M26Queued => "m26_queued",
            Route::M26Completed => "m26_completed",
            Route::FailedVisible => "failed_visible",
        }
    }

    /// Which verdicts may reach this route.
    fn allows(self, verdict: PrefilterVerdict) -> bool {
        use PrefilterVerdict::*;
        match self {
            Route::ClosedNoChange => verdict == NoChange,
            Route::ClosedNonMaterial => verdict == NonMaterialChange,
            Route::DeterministicProposalApplied
            | Route::DeterministicProposalQueued
            | Route::DeterministicProposalRejected => verdict == MaterialCandidate,
            Route::M26Queued => matches!(verdict, MaterialCandidate | NeedsSemanticJudgment),
            // An M26 successor supersedes a queued receipt, so it inherits
            // whichever verdict queued it.
            Route::M26Completed | Route::FailedVisible => {
                matches!(verdict, MaterialCandidate | NeedsSemanticJudgment)
            }
        }
    }

    /// Does this route need at least one proposal ref, forbid them, or leave
    /// the count to the referenced semantic outcome?
    fn proposals(self) -> Refs {
        match self {
            Route::DeterministicProposalApplied
            | Route::DeterministicProposalQueued
            | Route::DeterministicProposalRejected => Refs::Required,
            Route::M26Completed => Refs::Free,
            _ => Refs::Forbidden,
        }
    }

    /// Does this route need an Observation ref?
    ///
    /// `closed_no_change` MAY repeat a previously committed Observation —
    /// nothing changed, so there is nothing new to record — while every other
    /// route describes a state transition that produced one.
    fn observations(self) -> Refs {
        match self {
            Route::ClosedNoChange => Refs::Free,
            _ => Refs::Required,
        }
    }

    fn batch_key(self) -> Refs {
        match self {
            Route::M26Queued => Refs::Required,
            Route::M26Completed | Route::FailedVisible => Refs::Required,
            _ => Refs::Forbidden,
        }
    }

    /// Does this route require an `m26_batch_key`?
    ///
    /// Public because the producer builds a receipt before the window it may
    /// join is known, and stands a key in to shape-check the rest. Reading
    /// the table is the point — a producer with its own list of which routes
    /// need a key is a second copy of this table.
    pub fn requires_batch_key(self) -> bool {
        self.batch_key() == Refs::Required
    }

    fn outcome_event(self) -> Refs {
        match self {
            Route::M26Completed | Route::FailedVisible => Refs::Required,
            _ => Refs::Forbidden,
        }
    }

    fn supersedes(self) -> Refs {
        match self {
            Route::M26Completed | Route::FailedVisible => Refs::Required,
            _ => Refs::Forbidden,
        }
    }

    /// The scheduler state this route restores after a runtime-DB loss.
    /// Named here, beside the routes, so recovery and routing cannot drift.
    pub fn scheduler_state(self) -> &'static str {
        match self {
            Route::ClosedNoChange
            | Route::ClosedNonMaterial
            | Route::DeterministicProposalApplied
            | Route::DeterministicProposalRejected
            | Route::M26Completed => "consumed",
            Route::DeterministicProposalQueued => "pending_review",
            Route::M26Queued => "pending",
            // Never consumed and never auto-retried: an owner retry or
            // changed bytes, or it stays visible.
            Route::FailedVisible => "recovery_held",
        }
    }

    pub const ALL: [Route; 8] = [
        Route::ClosedNoChange,
        Route::ClosedNonMaterial,
        Route::DeterministicProposalApplied,
        Route::DeterministicProposalQueued,
        Route::DeterministicProposalRejected,
        Route::M26Queued,
        Route::M26Completed,
        Route::FailedVisible,
    ];
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Refs {
    Required,
    Forbidden,
    /// The route neither requires nor forbids; a different rule decides.
    Free,
}

schema_body! {
    /// One deterministic disposition of one stable source item at one exact
    /// artifact.
    pub struct IngestAssessed {
        pub receipt_id: String,
        /// The stable source-item id — derived from store, source, and item
        /// key (see [`derive_item_id`]). A path is provenance, never identity.
        pub item_id: String,
        pub source_id: String,
        /// The source's own record id, when it has one. Vault files do not.
        pub source_record_id: Option<String>,
        pub artifact_hash: String,
        pub normalized_snapshot_hash: String,
        pub normalizer_version: String,
        /// Bumped only by an explicit owner retry of unchanged bytes.
        /// Automatic restart and rescan never touch it.
        pub processing_epoch: u64,
        /// The ledger head this assessment read. Says what the decision could
        /// have known, which is the only honest way to read it later.
        pub assessed_against_chain_head: String,
        pub prefilter_verdict: PrefilterVerdict,
        pub material_dimensions: Vec<MaterialDimension>,
        pub independence: Independence,
        pub route: Route,
        pub observation_event_ids: Vec<String>,
        pub proposal_ids: Vec<String>,
        pub m26_batch_key: Option<String>,
        pub m26_outcome_event_id: Option<String>,
        pub supersedes_receipt_id: Option<String>,
    }
}

fn sorted_unique(ids: &[String]) -> bool {
    ids.windows(2).all(|pair| pair[0] < pair[1])
}

impl IngestAssessed {
    pub fn validate(&self) -> Result<(), String> {
        self.validate_common()?;
        for (name, id) in [
            ("receipt_id", &self.receipt_id),
            ("item_id", &self.item_id),
            ("source_id", &self.source_id),
        ] {
            if !is_id128(id) {
                return Err(format!("{name} must be a 128-bit hex id"));
            }
        }
        for (name, hash) in [
            ("artifact_hash", &self.artifact_hash),
            ("normalized_snapshot_hash", &self.normalized_snapshot_hash),
        ] {
            if !is_sha256(hash) {
                return Err(format!("{name} must be a lowercase SHA-256"));
            }
        }
        if self.normalizer_version.is_empty() {
            return Err("normalizer_version must be non-empty".into());
        }
        if self.assessed_against_chain_head.is_empty() {
            return Err("assessed_against_chain_head must be non-empty".into());
        }
        if self.source_record_id.as_deref() == Some("") {
            return Err("source_record_id is null or a value, never empty".into());
        }

        if !self.route.allows(self.prefilter_verdict) {
            return Err(format!(
                "route {} cannot carry verdict {} — the route matrix is closed",
                self.route.as_str(),
                self.prefilter_verdict.as_str()
            ));
        }

        self.validate_dimensions()?;
        self.validate_refs()?;
        Ok(())
    }

    /// `material_dimensions` is empty for the two closing verdicts, non-empty
    /// for a material candidate, and may be either for a semantic queue tag —
    /// the deterministic pass lists what it DOES know and escalates the rest.
    fn validate_dimensions(&self) -> Result<(), String> {
        let mut sorted = self.material_dimensions.clone();
        sorted.sort();
        sorted.dedup();
        if sorted != self.material_dimensions {
            return Err("material_dimensions must be sorted and duplicate-free".into());
        }
        match self.prefilter_verdict {
            PrefilterVerdict::NoChange | PrefilterVerdict::NonMaterialChange => {
                if !self.material_dimensions.is_empty() {
                    return Err(format!(
                        "verdict {} names no material dimensions",
                        self.prefilter_verdict.as_str()
                    ));
                }
            }
            PrefilterVerdict::MaterialCandidate => {
                if self.material_dimensions.is_empty() {
                    return Err(
                        "material_candidate must name at least one material dimension".into(),
                    );
                }
            }
            PrefilterVerdict::NeedsSemanticJudgment => {}
        }
        // Corroboration is the one dimension that requires a positive record.
        if self
            .material_dimensions
            .contains(&MaterialDimension::EvidenceState)
            && self.independence == Independence::IndependenceUnknown
            && self.prefilter_verdict == PrefilterVerdict::MaterialCandidate
        {
            return Err(
                "evidence-state materiality on a deterministic candidate needs a recorded \
                 independence fact — `independence_unknown` is not weak corroboration"
                    .into(),
            );
        }
        Ok(())
    }

    fn validate_refs(&self) -> Result<(), String> {
        for (name, ids) in [
            ("observation_event_ids", &self.observation_event_ids),
            ("proposal_ids", &self.proposal_ids),
        ] {
            if !sorted_unique(ids) {
                return Err(format!("{name} must be sorted and duplicate-free"));
            }
            if ids.iter().any(|id| !is_id128(id)) {
                return Err(format!("{name} entries must be 128-bit hex ids"));
            }
        }
        check_list(
            "observation_event_ids",
            self.route.observations(),
            &self.observation_event_ids,
            self.route,
        )?;
        check_list(
            "proposal_ids",
            self.route.proposals(),
            &self.proposal_ids,
            self.route,
        )?;
        check_option(
            "m26_batch_key",
            self.route.batch_key(),
            &self.m26_batch_key,
            self.route,
        )?;
        check_option(
            "m26_outcome_event_id",
            self.route.outcome_event(),
            &self.m26_outcome_event_id,
            self.route,
        )?;
        check_option(
            "supersedes_receipt_id",
            self.route.supersedes(),
            &self.supersedes_receipt_id,
            self.route,
        )?;
        for (name, id) in [
            ("m26_outcome_event_id", &self.m26_outcome_event_id),
            ("supersedes_receipt_id", &self.supersedes_receipt_id),
        ] {
            if let Some(id) = id {
                if !is_id128(id) {
                    return Err(format!("{name} must be a 128-bit hex id"));
                }
            }
        }
        if self.m26_batch_key.as_deref() == Some("") {
            return Err("m26_batch_key is null or a value, never empty".into());
        }
        // NOTE: "failed_visible carries no proposal refs" is not a separate
        // check. It is `Route::proposals() == Forbidden`, enforced above —
        // and writing it twice would let the table and the special case
        // disagree, which is the whole reason the table exists.
        Ok(())
    }

    /// The append-once key: the same source item, bytes, normalizer, epoch,
    /// and route can only ever appear once. A rescan of identical bytes
    /// therefore appends nothing and charges nothing.
    pub fn idempotency(&self) -> String {
        format!(
            "ingest-receipt-v1:{}:{}:{}:{}:{}:{}",
            self.source_id,
            self.item_id,
            self.artifact_hash,
            self.normalizer_version,
            self.processing_epoch,
            self.route.as_str()
        )
    }
}

fn check_list(name: &str, rule: Refs, ids: &[String], route: Route) -> Result<(), String> {
    match rule {
        Refs::Required if ids.is_empty() => Err(format!(
            "route {} requires at least one {name}",
            route.as_str()
        )),
        Refs::Forbidden if !ids.is_empty() => {
            Err(format!("route {} forbids {name}", route.as_str()))
        }
        _ => Ok(()),
    }
}

fn check_option(
    name: &str,
    rule: Refs,
    value: &Option<String>,
    route: Route,
) -> Result<(), String> {
    match rule {
        Refs::Required if value.is_none() => {
            Err(format!("route {} requires {name}", route.as_str()))
        }
        Refs::Forbidden if value.is_some() => Err(format!(
            "route {} requires {name} to be null",
            route.as_str()
        )),
        _ => Ok(()),
    }
}

/// `sha256_first128("ingest-item-v1" | 0x00 | store | 0x00 | source | 0x00 |
/// item key)`.
///
/// The item key is a vault-relative path today, and that is exactly why it is
/// hashed into an id rather than used as one: a path is where something was
/// found, not what it is, and two vaults with the same folder layout must not
/// share an item identity.
pub fn derive_item_id(store_id: &str, source_id: &str, item_key: &str) -> String {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(b"ingest-item-v1");
    for part in [store_id, source_id, item_key] {
        bytes.push(0);
        bytes.extend_from_slice(part.as_bytes());
    }
    sha256_first128(&bytes)
}

/// `sha256_first128` over everything the append-once key covers.
///
/// Deriving the id from the same components as the key means a retry cannot
/// mint a second receipt for work already recorded, and a receipt id cannot
/// be forged onto different content.
pub fn derive_receipt_id(
    store_id: &str,
    source_id: &str,
    item_id: &str,
    artifact_hash: &str,
    normalizer_version: &str,
    processing_epoch: u64,
    route: Route,
) -> String {
    let epoch = processing_epoch.to_string();
    let mut bytes = Vec::new();
    bytes.extend_from_slice(b"ingest-receipt-v1");
    for part in [
        store_id,
        source_id,
        item_id,
        artifact_hash,
        normalizer_version,
        epoch.as_str(),
        route.as_str(),
    ] {
        bytes.push(0);
        bytes.extend_from_slice(part.as_bytes());
    }
    sha256_first128(&bytes)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::super::tests::{common, ID_A, ID_B, ID_C, SHA_A};
    use super::*;

    fn receipt(route: Route, verdict: PrefilterVerdict) -> IngestAssessed {
        let (schema, actor) = common("system:prefilter");
        IngestAssessed {
            schema,
            batch_id: None,
            idempotency_key: None,
            actor,
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            receipt_id: ID_A.into(),
            item_id: ID_B.into(),
            source_id: ID_C.into(),
            source_record_id: None,
            artifact_hash: SHA_A.into(),
            normalized_snapshot_hash: SHA_A.into(),
            normalizer_version: "vault-entry-v1".into(),
            processing_epoch: 0,
            assessed_against_chain_head: SHA_A.into(),
            prefilter_verdict: verdict,
            material_dimensions: Vec::new(),
            independence: Independence::IndependenceUnknown,
            route,
            observation_event_ids: Vec::new(),
            proposal_ids: Vec::new(),
            m26_batch_key: None,
            m26_outcome_event_id: None,
            supersedes_receipt_id: None,
        }
    }

    /// A valid receipt for every route — the matrix, made concrete.
    pub(crate) fn valid(route: Route) -> IngestAssessed {
        let verdict = match route {
            Route::ClosedNoChange => PrefilterVerdict::NoChange,
            Route::ClosedNonMaterial => PrefilterVerdict::NonMaterialChange,
            Route::M26Queued | Route::M26Completed | Route::FailedVisible => {
                PrefilterVerdict::NeedsSemanticJudgment
            }
            _ => PrefilterVerdict::MaterialCandidate,
        };
        let mut body = receipt(route, verdict);
        if verdict == PrefilterVerdict::MaterialCandidate {
            body.material_dimensions = vec![MaterialDimension::WorldState];
        }
        if !matches!(route, Route::ClosedNoChange) {
            body.observation_event_ids = vec![ID_A.into()];
        }
        if matches!(
            route,
            Route::DeterministicProposalApplied
                | Route::DeterministicProposalQueued
                | Route::DeterministicProposalRejected
        ) {
            body.proposal_ids = vec![ID_B.into()];
        }
        if matches!(
            route,
            Route::M26Queued | Route::M26Completed | Route::FailedVisible
        ) {
            body.m26_batch_key = Some("batch-2026-08-09".into());
        }
        if matches!(route, Route::M26Completed | Route::FailedVisible) {
            body.m26_outcome_event_id = Some(ID_C.into());
            body.supersedes_receipt_id = Some(ID_B.into());
        }
        body
    }

    #[test]
    fn every_route_has_a_valid_shape_and_exactly_one_recovery_destiny() {
        for route in Route::ALL {
            valid(route)
                .validate()
                .unwrap_or_else(|e| panic!("{}: {e}", route.as_str()));
            assert!(
                !route.scheduler_state().is_empty(),
                "{} must name where recovery puts it",
                route.as_str()
            );
        }
        // The two that must never be restored as done.
        assert_eq!(Route::FailedVisible.scheduler_state(), "recovery_held");
        assert_eq!(
            Route::DeterministicProposalQueued.scheduler_state(),
            "pending_review",
            "a decision waiting for a human is not work waiting for a model"
        );
        assert_eq!(Route::M26Queued.scheduler_state(), "pending");
    }

    #[test]
    fn a_verdict_cannot_take_a_route_the_matrix_does_not_allow() {
        let mut body = valid(Route::ClosedNoChange);
        body.prefilter_verdict = PrefilterVerdict::MaterialCandidate;
        body.material_dimensions = vec![MaterialDimension::WorldState];
        let err = body.validate().unwrap_err();
        assert!(err.contains("route matrix is closed"), "{err}");
    }

    #[test]
    fn a_closing_verdict_names_no_material_dimensions() {
        let mut body = valid(Route::ClosedNonMaterial);
        body.material_dimensions = vec![MaterialDimension::WorldState];
        assert!(body.validate().is_err());
    }

    #[test]
    fn a_material_candidate_must_say_which_dimension_moved() {
        let mut body = valid(Route::DeterministicProposalApplied);
        body.material_dimensions.clear();
        let err = body.validate().unwrap_err();
        assert!(err.contains("at least one material dimension"), "{err}");
    }

    #[test]
    fn corroboration_without_a_positive_independence_record_is_refused() {
        // The §17 rule, mechanized: a second lineage for an unchanged value
        // is material — but only when independence was actually RECORDED.
        let mut body = valid(Route::DeterministicProposalApplied);
        body.material_dimensions = vec![MaterialDimension::EvidenceState];
        body.independence = Independence::IndependenceUnknown;
        let err = body.validate().unwrap_err();
        assert!(err.contains("not weak corroboration"), "{err}");

        body.independence = Independence::KnownIndependent;
        assert!(body.validate().is_ok());
    }

    #[test]
    fn forbidden_refs_are_refused_on_every_route_that_forbids_them() {
        for route in Route::ALL {
            let mut body = valid(route);
            if body.proposal_ids.is_empty() && route != Route::M26Completed {
                body.proposal_ids = vec![ID_C.into()];
                assert!(
                    body.validate().is_err(),
                    "{} must forbid proposal refs",
                    route.as_str()
                );
            }
            let mut body = valid(route);
            if body.m26_outcome_event_id.is_none() {
                body.m26_outcome_event_id = Some(ID_C.into());
                assert!(
                    body.validate().is_err(),
                    "{} must forbid an outcome event",
                    route.as_str()
                );
            }
        }
    }

    #[test]
    fn an_m26_successor_must_name_the_receipt_it_supersedes() {
        for route in [Route::M26Completed, Route::FailedVisible] {
            let mut body = valid(route);
            body.supersedes_receipt_id = None;
            let err = body.validate().unwrap_err();
            assert!(err.contains("supersedes_receipt_id"), "{route:?}: {err}");
        }
    }

    #[test]
    fn a_visible_failure_never_claims_a_proposal() {
        // Work that failed visibly produced no decision; naming a proposal
        // would claim otherwise. Enforced by the route table's forbidden
        // list, not by a second rule beside it.
        let mut body = valid(Route::FailedVisible);
        body.proposal_ids = vec![ID_B.into()];
        let err = body.validate().unwrap_err();
        assert!(err.contains("forbids proposal_ids"), "{err}");
    }

    #[test]
    fn a_no_change_receipt_may_repeat_an_existing_observation_or_name_none() {
        let mut body = valid(Route::ClosedNoChange);
        assert!(body.validate().is_ok(), "naming none is allowed");
        body.observation_event_ids = vec![ID_A.into()];
        assert!(body.validate().is_ok(), "repeating one is allowed");
    }

    #[test]
    fn ref_lists_must_be_sorted_and_duplicate_free() {
        let mut body = valid(Route::DeterministicProposalApplied);
        body.observation_event_ids = vec![ID_C.into(), ID_A.into()];
        assert!(body.validate().is_err(), "unsorted");
        body.observation_event_ids = vec![ID_A.into(), ID_A.into()];
        assert!(body.validate().is_err(), "duplicated");
    }

    #[test]
    fn the_body_carries_no_telemetry_at_all() {
        // The native failure mode of this milestone, mechanized: the field
        // set is asserted, so adding `total_tokens` to a "portable" receipt
        // fails here rather than in a review nobody ran.
        let value = serde_json::to_value(valid(Route::M26Queued)).unwrap();
        let fields: Vec<&String> = value.as_object().unwrap().keys().collect();
        assert_eq!(
            fields,
            vec![
                "schema",
                "batch_id",
                "idempotency_key",
                "actor",
                "occurred_at",
                "valid_from",
                "valid_to",
                "receipt_id",
                "item_id",
                "source_id",
                "source_record_id",
                "artifact_hash",
                "normalized_snapshot_hash",
                "normalizer_version",
                "processing_epoch",
                "assessed_against_chain_head",
                "prefilter_verdict",
                "material_dimensions",
                "independence",
                "route",
                "observation_event_ids",
                "proposal_ids",
                "m26_batch_key",
                "m26_outcome_event_id",
                "supersedes_receipt_id",
            ],
            "a receipt is not telemetry: no tokens, retries, quota window, \
             duration, or model may appear here"
        );
    }

    #[test]
    fn identical_bytes_derive_the_identical_receipt_and_item_id() {
        let item = derive_item_id("store", "source", "records/a.md");
        assert_eq!(item, derive_item_id("store", "source", "records/a.md"));
        assert_ne!(item, derive_item_id("store2", "source", "records/a.md"));
        assert_ne!(item, derive_item_id("store", "source", "records/b.md"));
        assert_eq!(item.len(), 32);

        let id = derive_receipt_id("s", "src", &item, SHA_A, "v1", 0, Route::M26Queued);
        assert_eq!(
            id,
            derive_receipt_id("s", "src", &item, SHA_A, "v1", 0, Route::M26Queued)
        );
        assert_ne!(
            id,
            derive_receipt_id("s", "src", &item, SHA_A, "v1", 1, Route::M26Queued),
            "an owner retry is a different receipt, not a collision"
        );
    }

    #[test]
    fn the_append_once_key_covers_exactly_the_retry_question() {
        let a = valid(Route::M26Queued);
        let mut b = a.clone();
        assert_eq!(a.idempotency(), b.idempotency(), "identical bytes, one row");
        b.processing_epoch = 1;
        assert_ne!(
            a.idempotency(),
            b.idempotency(),
            "an explicit retry gets its own chain"
        );
    }
}
