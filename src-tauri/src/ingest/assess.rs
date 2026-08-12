//! One scanned item, assessed (M26.4i) — the producer `ingest.assessed` never
//! had.
//!
//! M25.3 defined the receipt and M25.5 defined the verdict that fills it in.
//! Nothing built the thing between them: a function that takes a file catch-up
//! found and returns the two events that record what was decided about it.
//! This is that function, and it is deliberately pure — no connection, no
//! writer, no clock — because everything interesting about it is a decision
//! and decisions should be testable without a vault.
//!
//! **Exactly ONE Observation per receipt, and that is a hard constraint
//! rather than a preference.** `IngestAssessed::validate_refs` requires
//! `observation_event_ids` to be sorted and duplicate-free, while
//! `append_batch` mints a fresh random id per member and substitutes
//! same-batch refs BEFORE validation. So a receipt naming two same-batch
//! Observations by ordinal would be sorted only when the two random ids
//! happened to land in ordinal order — passing roughly half the time, and
//! non-deterministically. One Observation per receipt makes the sorted check
//! trivially true.
//!
//! **What the item's two events cannot know here**: the batch key of the
//! window it may join (a function of every queued receipt in the pass) and
//! the ordinal its Observation will occupy (the caller lays out the batch).
//! Both are supplied or stamped by [`super::deterministic`]; this module
//! validates the shape around them with stand-ins, which is the same trick
//! [`super::outcome::close`] uses for the outcome id the writer mints.

use std::collections::BTreeMap;

use crate::ledger::schema::{
    self, Actor, IngestAssessed, ObservationKind, ObservationRecorded, Provenance, Route,
    SourceSnapshotPayload, SubjectRef,
};
use crate::ledger::writer::member_ref;
use crate::runtime::catchup::Scanned;
use crate::runtime::normalize::Snapshot;
use crate::runtime::scheduler::Row;

use super::{context, prefilter};

/// Who records that a file was seen at these bytes. The scanner did; naming
/// the prefilter here would credit the reading to the decision.
pub const ACTOR_SCANNER: &str = "system:vault-scanner";
/// Who records what was decided about them.
pub const ACTOR_PREFILTER: &str = "system:prefilter";

/// The epoch every receipt this milestone mints is stamped with.
///
/// The only thing that bumps it is an explicit owner retry of unchanged bytes
/// — automatic restart and rescan never touch it (M25.3) — and nothing in
/// this tree offers one. When a later milestone does, it reads the scheduler
/// row's `processing_epoch` column, which [`Row`] does not yet carry; this
/// constant is where that change lands, rather than a bare `0` in two places.
pub const PROCESSING_EPOCH: u64 = 0;

/// Where an item's two events sit in the batch the caller is assembling.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Placement<'a> {
    pub source_id: &'a str,
    /// The event that registered the source: a committed event id, or a
    /// same-batch [`member_ref`] when the registration rides this batch.
    pub registration_event: &'a str,
    /// The ordinal this item's Observation will occupy.
    pub observation_ordinal: usize,
}

/// What one item's assessment produced.
#[derive(Debug, Clone, PartialEq)]
pub struct Assessment {
    /// The vault-relative path — what the scheduler knows the item by.
    pub item_key: String,
    pub item_id: String,
    pub receipt_id: String,
    pub route: Route,
    pub verdict: prefilter::Verdict,
    /// Commit FIRST; the receipt names it by ordinal.
    pub observation: ObservationRecorded,
    /// `m26_batch_key` is still `None` — see the module note.
    pub receipt: IngestAssessed,
}

impl Assessment {
    /// Members in the order `append_batch` must receive them: the Observation
    /// the receipt references, then the receipt.
    pub fn members(&self) -> Vec<(String, serde_json::Value)> {
        vec![
            (
                schema::KIND_OBSERVATION_RECORDED.to_string(),
                serde_json::to_value(&self.observation).expect("schema body serializes"),
            ),
            (
                schema::KIND_INGEST_ASSESSED.to_string(),
                serde_json::to_value(&self.receipt).expect("schema body serializes"),
            ),
        ]
    }

    /// Stamp the window key, once the caller knows which receipts queued.
    ///
    /// The receipt's own idempotency key does not cover it (M25.3's
    /// append-once key is source, bytes, normalizer, epoch and route), so a
    /// receipt stamped here still refuses a second append of the same
    /// assessment.
    pub fn set_batch_key(&mut self, key: &str) {
        self.receipt.m26_batch_key = Some(key.to_string());
    }
}

/// Assess one item against what the scheduler last recorded about it.
///
/// `prior` is `None` for an item nobody has seen. Its snapshot then diffs
/// against an EMPTY one, so every field reads as changed — which is the truth
/// about a file the base is meeting for the first time, and is why a new note
/// reaches a model while a reformatted one does not.
pub fn assess_item(
    store_id: &str,
    chain_head: &str,
    item: &Scanned,
    prior: Option<&Row>,
    artifact_changed: bool,
    placement: &Placement<'_>,
) -> Result<Assessment, String> {
    if item.item_key.is_empty() {
        return Err("an item with no key has no identity".into());
    }
    let context = context::context_for(prior, item, artifact_changed);
    let empty = Snapshot {
        normalizer_version: item.snapshot.normalizer_version.clone(),
        fields: BTreeMap::new(),
    };
    let before = prior.map(|row| &row.snapshot).unwrap_or(&empty);
    let verdict = prefilter::assess(before, &item.snapshot, &context);
    // `None`: no deterministic mapper exists in this milestone, so no
    // proposal outcome can be reported. See `context::context_for`.
    let route = prefilter::route_for(&verdict, &context, None);

    let item_id = schema::derive_item_id(store_id, placement.source_id, &item.item_key);
    let receipt_id = schema::derive_receipt_id(
        store_id,
        placement.source_id,
        &item_id,
        &item.artifact_hash,
        &item.snapshot.normalizer_version,
        PROCESSING_EPOCH,
        route,
    );

    let observation = ObservationRecorded {
        schema: schema::BODY_SCHEMA,
        batch_id: None,
        idempotency_key: None,
        actor: Actor {
            id: ACTOR_SCANNER.to_string(),
        },
        occurred_at: None,
        valid_from: None,
        valid_to: None,
        // A snapshot, never an extracted assertion: reading a file is not
        // reading a claim out of it, and this pass does not read claims.
        observation_kind: ObservationKind::SourceSnapshot,
        source_id: placement.source_id.to_string(),
        source_registration_event_id: placement.registration_event.to_string(),
        // Snapshots may say none, and this one honestly does — resolving a
        // subject is the semantic pass's job, and inventing one here would be
        // the deterministic pass claiming a reading it never made.
        subject: SubjectRef::None,
        lineage: vec![],
        provenance: Provenance {
            source_location: Some(item.item_key.clone()),
            ..Provenance::empty()
        },
        payload: serde_json::to_value(SourceSnapshotPayload {
            // D7: the bytes are on disk and hashed, so this is never null.
            source_artifact_hash: Some(item.artifact_hash.clone()),
            raw_pointer: item.item_key.clone(),
        })
        .expect("a snapshot payload serializes"),
    };
    // Validated now, with the registration ref as the caller supplied it: a
    // same-batch ref is not an id128 and would fail, so only a committed ref
    // is checked here. The writer re-validates every member after
    // substitution, which is where a bad same-batch ref is caught.
    if schema::is_id128(placement.registration_event) {
        observation
            .validate()
            .map_err(|e| format!("observation for {}: {e}", item.item_key))?;
    }

    let mut receipt = IngestAssessed {
        schema: schema::BODY_SCHEMA,
        batch_id: None,
        idempotency_key: None,
        actor: Actor {
            id: ACTOR_PREFILTER.to_string(),
        },
        occurred_at: None,
        valid_from: None,
        valid_to: None,
        receipt_id: receipt_id.clone(),
        item_id: item_id.clone(),
        source_id: placement.source_id.to_string(),
        // A vault file has no record id of its own. The path is provenance
        // and already lives on the Observation.
        source_record_id: None,
        artifact_hash: item.artifact_hash.clone(),
        normalized_snapshot_hash: item.snapshot.hash()?,
        normalizer_version: item.snapshot.normalizer_version.clone(),
        processing_epoch: PROCESSING_EPOCH,
        assessed_against_chain_head: chain_head.to_string(),
        prefilter_verdict: verdict.verdict,
        material_dimensions: verdict.dimensions.clone(),
        independence: verdict.independence,
        route,
        observation_event_ids: vec![member_ref(placement.observation_ordinal)],
        proposal_ids: vec![],
        // Stamped by the caller once the whole window is known.
        m26_batch_key: None,
        m26_outcome_event_id: None,
        supersedes_receipt_id: None,
    };
    receipt.idempotency_key = Some(receipt.idempotency());

    // Shape-checked with stand-ins for the two things a single item cannot
    // know: the id the writer will mint for its Observation, and the key of
    // the window it may join. Everything else — the route matrix, the
    // dimension rules, the ref table — is checked for real, here, before a
    // batch is assembled out of it.
    let mut shape = receipt.clone();
    shape.observation_event_ids = vec!["0".repeat(32)];
    if shape.route.requires_batch_key() {
        shape.m26_batch_key = Some("stand-in".into());
    }
    shape
        .validate()
        .map_err(|e| format!("receipt for {}: {e}", item.item_key))?;

    Ok(Assessment {
        item_key: item.item_key.clone(),
        item_id,
        receipt_id,
        route,
        verdict,
        observation,
        receipt,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ledger::schema::{Independence, MaterialDimension, PrefilterVerdict};
    use crate::runtime::normalize::{self, NORMALIZER_VERSION};
    use crate::runtime::scheduler::SchedulerState;
    use crate::vault::entry::Entry;

    const STORE: &str = "feedfacefeedfacefeedfacefeedface";
    const SOURCE: &str = "aa11bb22cc33dd44ee55ff6600778899";
    const REGISTRATION: &str = "11223344556677889900112233445566";
    const HEAD: &str = "c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0";

    fn placement() -> Placement<'static> {
        Placement {
            source_id: SOURCE,
            registration_event: REGISTRATION,
            observation_ordinal: 0,
        }
    }

    fn entry(title: &str) -> Entry {
        let mut entry = Entry::empty_for_test("records/a.md");
        entry.title = title.into();
        entry
    }

    fn scanned(title: &str, bytes: &str) -> Scanned {
        Scanned {
            item_key: "records/a.md".into(),
            artifact_hash: normalize::artifact_hash(bytes.as_bytes()),
            snapshot: normalize::snapshot(&entry(title)),
        }
    }

    fn row(title: &str, bytes: &str) -> Row {
        Row {
            item_key: "records/a.md".into(),
            source_id: Some(SOURCE.into()),
            content_hash: normalize::artifact_hash(bytes.as_bytes()),
            snapshot: normalize::snapshot(&entry(title)),
            event_cursor: None,
            route: None,
            state: SchedulerState::Pending,
        }
    }

    fn assess(item: &Scanned, prior: Option<&Row>) -> Assessment {
        assess_item(STORE, HEAD, item, prior, true, &placement()).unwrap()
    }

    #[test]
    fn a_receipt_names_exactly_one_observation() {
        // Not a style choice. `validate_refs` requires the list sorted and
        // duplicate-free, `append_batch` mints RANDOM member ids, and it
        // substitutes same-batch refs before validating — so a receipt naming
        // two would validate only when the two random ids happened to land in
        // ordinal order.
        let assessment = assess(&scanned("Beta", "beta"), Some(&row("Alpha", "alpha")));
        assert_eq!(assessment.receipt.observation_event_ids, vec![member_ref(0)]);
        assert_eq!(assessment.members().len(), 2);
    }

    #[test]
    fn the_observation_is_committed_before_the_receipt_that_names_it() {
        let assessment = assess(&scanned("Beta", "beta"), Some(&row("Alpha", "alpha")));
        let members = assessment.members();
        assert_eq!(members[0].0, schema::KIND_OBSERVATION_RECORDED);
        assert_eq!(members[1].0, schema::KIND_INGEST_ASSESSED);
    }

    #[test]
    fn a_file_the_base_has_never_seen_diffs_against_nothing_and_is_all_news() {
        // The alternative — treating an absent prior as "unchanged" — would
        // make a whole first scan cost zero and teach the base nothing.
        let assessment = assess(&scanned("Alpha", "alpha"), None);
        assert_eq!(
            assessment.verdict.verdict,
            PrefilterVerdict::MaterialCandidate
        );
        assert!(assessment
            .verdict
            .changed_fields
            .contains(&"title".to_string()));
        assert_eq!(assessment.route, Route::M26Queued);
    }

    #[test]
    fn a_reformat_is_closed_and_never_reaches_a_window() {
        // Bytes moved, no normalized field did. The property the prefilter
        // exists to buy, asserted at the producer.
        let before = row("Alpha", "alpha");
        let after = Scanned {
            artifact_hash: normalize::artifact_hash(b"alpha reformatted"),
            ..scanned("Alpha", "alpha")
        };
        let assessment = assess(&after, Some(&before));
        assert_eq!(assessment.route, Route::ClosedNonMaterial);
        assert_eq!(
            assessment.receipt.prefilter_verdict,
            PrefilterVerdict::NonMaterialChange
        );
        assert!(assessment.receipt.m26_batch_key.is_none());
        // And it still records that the file was seen at these bytes:
        // recording is epistemic and unconditional, spending is not.
        assert_eq!(assessment.members().len(), 2);
    }

    #[test]
    fn a_structured_edit_queues_and_carries_its_dimension() {
        let assessment = assess(&scanned("Beta", "beta"), Some(&row("Alpha", "alpha")));
        assert_eq!(assessment.route, Route::M26Queued);
        assert_eq!(
            assessment.receipt.material_dimensions,
            vec![MaterialDimension::WorldState]
        );
        assert_eq!(
            assessment.receipt.independence,
            Independence::IndependenceUnknown
        );
    }

    #[test]
    fn the_receipt_id_and_its_append_once_key_cover_the_same_components() {
        // Deriving the id from the key's components is what stops a retry
        // minting a second receipt for work already recorded.
        let item = scanned("Beta", "beta");
        let a = assess(&item, Some(&row("Alpha", "alpha")));
        let b = assess(&item, Some(&row("Alpha", "alpha")));
        assert_eq!(a.receipt_id, b.receipt_id);
        assert_eq!(a.receipt.idempotency_key, b.receipt.idempotency_key);
        assert!(a
            .receipt
            .idempotency_key
            .as_deref()
            .unwrap()
            .contains(&item.artifact_hash));
    }

    #[test]
    fn different_bytes_are_a_different_receipt() {
        let prior = row("Alpha", "alpha");
        let a = assess(&scanned("Beta", "beta"), Some(&prior));
        let b = assess(&scanned("Gamma", "gamma"), Some(&prior));
        assert_ne!(a.receipt_id, b.receipt_id);
        assert_eq!(a.item_id, b.item_id, "the same file is the same item");
    }

    #[test]
    fn the_item_id_is_a_function_of_the_source_and_two_sources_never_share_one() {
        // The provenance split has teeth only if the id carries it: the same
        // path under the other source must be a different item.
        let item = scanned("Alpha", "alpha");
        let bundle = Placement {
            source_id: "9999999999999999999999999999aaaa",
            ..placement()
        };
        let authored = assess_item(STORE, HEAD, &item, None, true, &placement()).unwrap();
        let other = assess_item(STORE, HEAD, &item, None, true, &bundle).unwrap();
        assert_ne!(authored.item_id, other.item_id);
        assert_ne!(authored.receipt_id, other.receipt_id);
    }

    #[test]
    fn the_receipt_pins_the_head_the_decision_read() {
        let assessment = assess(&scanned("Beta", "beta"), Some(&row("Alpha", "alpha")));
        assert_eq!(assessment.receipt.assessed_against_chain_head, HEAD);
        assert_eq!(
            assessment.receipt.normalized_snapshot_hash,
            normalize::snapshot(&entry("Beta")).hash().unwrap()
        );
        assert_eq!(assessment.receipt.normalizer_version, NORMALIZER_VERSION);
    }

    #[test]
    fn the_observation_says_which_bytes_it_saw_and_claims_no_subject() {
        let item = scanned("Beta", "beta");
        let assessment = assess(&item, Some(&row("Alpha", "alpha")));
        let payload: SourceSnapshotPayload =
            serde_json::from_value(assessment.observation.payload.clone()).unwrap();
        assert_eq!(payload.source_artifact_hash, Some(item.artifact_hash));
        assert_eq!(payload.raw_pointer, "records/a.md");
        assert_eq!(assessment.observation.subject, SubjectRef::None);
        assert_eq!(
            assessment.observation.source_registration_event_id,
            REGISTRATION
        );
        assert!(assessment.observation.lineage.is_empty());
    }

    #[test]
    fn a_queued_receipt_leaves_here_without_the_window_key_and_takes_one_later() {
        // The key is a function of every queued receipt in the pass, so one
        // item cannot know it. What must not happen is a receipt that ships
        // queued with no key at all — the route matrix refuses that, which is
        // why the shape check stands one in.
        let mut assessment = assess(&scanned("Beta", "beta"), Some(&row("Alpha", "alpha")));
        assert_eq!(assessment.route, Route::M26Queued);
        assert!(assessment.receipt.m26_batch_key.is_none());
        let before = assessment.receipt.idempotency_key.clone();
        assessment.set_batch_key("window-key");
        assert_eq!(
            assessment.receipt.m26_batch_key.as_deref(),
            Some("window-key")
        );
        assert_eq!(
            assessment.receipt.idempotency_key, before,
            "the append-once key does not cover the window"
        );
    }

    #[test]
    fn a_closed_receipt_is_never_given_a_window_key() {
        // `Route::batch_key()` FORBIDS it, so stamping one would be refused
        // at commit rather than merely being untidy.
        let after = Scanned {
            artifact_hash: normalize::artifact_hash(b"alpha reformatted"),
            ..scanned("Alpha", "alpha")
        };
        let assessment = assess(&after, Some(&row("Alpha", "alpha")));
        let mut shape = assessment.receipt.clone();
        shape.observation_event_ids = vec!["0".repeat(32)];
        shape.validate().expect("as built, it validates");
        shape.m26_batch_key = Some("window-key".into());
        assert!(shape.validate().is_err(), "a closed route forbids a key");
    }

    #[test]
    fn an_item_with_no_key_has_no_identity() {
        let mut item = scanned("Alpha", "alpha");
        item.item_key = String::new();
        let err = assess_item(STORE, HEAD, &item, None, true, &placement()).unwrap_err();
        assert!(err.contains("no identity"), "{err}");
    }
}
