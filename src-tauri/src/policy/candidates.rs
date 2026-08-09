//! The server-minted candidate search receipt (§15), deterministic legs
//! only.
//!
//! A create is the one mutation with no target to compare against, so the
//! §15 protection is a RECEIPT: proof that the server looked for what
//! already exists, against a named index head, before agreeing that this is
//! new. A caller cannot author one — the whole value is that the lookups
//! were run here.
//!
//! The three deterministic legs are all real (M24.7): exact identity,
//! explicit alias, and the scoped/temporal lookup — every live Belief the
//! base already holds about this same subject. The semantic leg is
//! explicitly `not_available` rather than quietly absent; an empty
//! `attempted` leg would read as "searched, found nothing" when nothing was
//! searched. M26 supplies it and makes an attempted one a precondition for
//! registering the proposal tools at all.
//!
//! The server decides what the search RETURNED; it does not decide what the
//! results MEAN. Dispositions (`update | qualify | distinct`) and the
//! payload's `distinctness_reason` are the proposer's judgement, recorded
//! for review — "similarity alone never forces a merge" cuts both ways, and
//! a server that auto-merged on a name collision would be the same mistake
//! upside down.

use crate::ledger::reduce::EpistemicState;
use crate::ledger::schema::{
    AliasLeg, CandidateSearchReceipt, ExactLeg, ScopedLeg, SemanticLeg, SemanticStatus,
};
use crate::ledger::LedgerHead;

/// The receipt format this build mints. A bump means the legs changed.
pub const SEARCH_VERSION: u64 = 2;

/// The index head an empty ledger presents: no events, nothing to have
/// searched. Spelled rather than faked, so a receipt can never claim to have
/// been minted against a head that does not exist.
pub const EMPTY_INDEX_HEAD: &str = "00000000000000000000000000000000";

/// The token a receipt names as "the head I searched against".
///
/// Derived from the chain head rather than being it: `index_head` is an id,
/// and the chain head is a sequence and a segment hash. Deriving keeps the
/// receipt's claim CHECKABLE — anyone holding the ledger can recompute this
/// and see whether the search really happened where it says it did.
pub fn index_head_of(head: Option<&LedgerHead>) -> String {
    match head {
        None => EMPTY_INDEX_HEAD.to_string(),
        Some(head) => crate::ledger::schema::sha256_first128(
            format!(
                "cerebro-index-head-v1\0{}\0{}",
                head.seq.unwrap_or(0),
                head.hash
            )
            .as_bytes(),
        ),
    }
}

/// Mint a receipt for a proposed creation.
///
/// `exact_query` is the identity the caller is claiming is free (for
/// `write_concept`, the projection path); `alias_queries` are the display
/// spellings whose normalized keys must not already belong to something
/// else.
pub fn mint(
    state: &EpistemicState,
    index_head: &str,
    subject_id: &str,
    exact_query: &str,
    alias_queries: &[String],
) -> Result<CandidateSearchReceipt, String> {
    let mut exact_hits: Vec<String> = state
        .projection_paths
        .get(exact_query)
        .into_iter()
        .cloned()
        .collect();
    exact_hits.sort();

    let mut alias_hits: Vec<String> = alias_queries
        .iter()
        .filter_map(|alias| {
            let normalized = crate::ledger::schema::normalize_alias_v1(alias);
            state.alias_registry.get(&normalized)
        })
        // An alias resolves to an Entity; the candidates a create competes
        // with are the Beliefs ABOUT that entity.
        .flat_map(|hit| {
            state
                .beliefs
                .values()
                .filter(|belief| belief.entity_id == hit.entity_id)
                .map(|belief| belief.belief_id.clone())
        })
        .collect();
    alias_hits.sort();
    alias_hits.dedup();

    // THE SCOPED/TEMPORAL LEG. What the base already believes about this
    // same subject — the duplicate that shares neither a path nor an alias
    // but is about the same thing, which is the shape §15 exists for.
    //
    // Tombstoned Beliefs are excluded: they are not something a create could
    // have been an update to. Superseded and archived ones are NOT excluded —
    // "there is already a retired belief about this" is exactly the context
    // a reviewer wants before agreeing that a new one is distinct.
    let mut scoped_hits: Vec<String> = state
        .beliefs
        .values()
        .filter(|belief| belief.entity_id == subject_id && belief.tombstoned_by.is_none())
        .map(|belief| belief.belief_id.clone())
        .collect();
    scoped_hits.sort();
    scoped_hits.dedup();

    // Every candidate any leg returned needs a disposition, or the receipt
    // proves a search happened and says nothing about what was found.
    let mut considered: Vec<crate::ledger::schema::ConsideredCandidate> = Vec::new();
    let mut seen: Vec<&str> = exact_hits
        .iter()
        .chain(alias_hits.iter())
        .chain(scoped_hits.iter())
        .map(String::as_str)
        .collect();
    seen.sort_unstable();
    seen.dedup();
    for candidate in seen {
        considered.push(crate::ledger::schema::ConsideredCandidate {
            candidate_id: candidate.to_string(),
            // The SERVER's default disposition, and the only one it is
            // entitled to: a deterministic hit means the thing is already
            // here, so the honest move is to revise it. A proposer who
            // believes otherwise replaces this with `distinct` and says why
            // — a judgement the ledger then holds against them, which is the
            // point.
            decision: crate::ledger::schema::CandidateDecision::Update,
            reason: "the deterministic index already holds this identity".to_string(),
        });
    }

    let mut receipt = CandidateSearchReceipt {
        // Filled below: the id is a digest of the search, so it cannot be
        // written before the search exists.
        receipt_id: EMPTY_INDEX_HEAD.to_string(),
        index_head: index_head.to_string(),
        search_version: SEARCH_VERSION,
        exact: ExactLeg {
            query: exact_query.to_string(),
            candidate_ids: exact_hits,
        },
        aliases: AliasLeg {
            queries: {
                let mut queries = alias_queries.to_vec();
                queries.sort();
                queries.dedup();
                queries
            },
            candidate_ids: alias_hits,
        },
        scoped: ScopedLeg {
            subject_id: subject_id.to_string(),
            // Scope and interval stay empty because a create's payload
            // carries no scope to search WITHIN: the subject is the whole
            // scope this build can express. M25's coverage records are what
            // give these fields something to say; writing a guess here would
            // make the receipt claim a narrower search than it ran.
            scope: serde_json::json!({}),
            valid_interval: None,
            candidate_ids: scoped_hits,
        },
        semantic: SemanticLeg {
            status: SemanticStatus::NotAvailable,
            candidate_ids: vec![],
        },
        considered,
    };
    receipt.receipt_id = derive_receipt_id(&receipt)?;
    // `validate` checks the head is an event id, so a receipt can never
    // claim a head that does not have the shape of one.
    receipt.validate()?;
    Ok(receipt)
}

/// The receipt's id is a DIGEST OF THE SEARCH — head, version, and all four
/// legs — and never of the dispositions.
///
/// That split is the whole authorship test. What the server found is the
/// server's; what it means is the proposer's. An id that covered the
/// dispositions could not survive a proposer disagreeing with a default,
/// and an id that covered less than the legs would let a fabricated search
/// wear a real one's id.
pub fn derive_receipt_id(receipt: &CandidateSearchReceipt) -> Result<String, String> {
    let legs = serde_json::json!({
        "index_head": receipt.index_head,
        "search_version": receipt.search_version,
        "exact": receipt.exact,
        "aliases": receipt.aliases,
        "scoped": receipt.scoped,
        "semantic": receipt.semantic,
    });
    let body = serde_json::to_string(&legs).map_err(|e| e.to_string())?;
    let mut bytes = Vec::with_capacity(body.len() + 32);
    bytes.extend_from_slice(b"cerebro-candidate-receipt-v1\0");
    bytes.extend_from_slice(body.as_bytes());
    Ok(crate::ledger::schema::sha256_first128(&bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ledger::reduce::{AliasState, BeliefState, RevisionState};
    use crate::ledger::schema::{BeliefBasis, Lifecycle, Qualification};

    const BELIEF: &str = "b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1";
    const OTHER: &str = "c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2";
    const SUBJECT: &str = "e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3";
    const ELSEWHERE: &str = "d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4";

    fn belief(belief_id: &str, entity_id: &str) -> BeliefState {
        BeliefState {
            belief_id: belief_id.into(),
            entity_id: entity_id.into(),
            created_event_id: SUBJECT.into(),
            revisions: vec![RevisionState {
                event_id: SUBJECT.into(),
                revision: 1,
                content: String::new(),
                fields: serde_json::json!({}),
                basis: BeliefBasis::Unsupported {
                    reason: "fixture".into(),
                },
            }],
            attested: None,
            attestation_events: vec![],
            path: None,
            overrides: vec![],
            override_head_event: None,
            projection_head_event: SUBJECT.into(),
            qualification: Qualification::Draft,
            lifecycle: Lifecycle::Active,
            tombstoned_by: None,
            open_contest_event: None,
            qualification_head_event: None,
            lifecycle_head_event: None,
            contest_head_event: None,
            entity_merge_event_ids: vec![],
        }
    }

    /// A world holding one Belief about SUBJECT, projected at `churn.md`.
    fn world() -> EpistemicState {
        let mut state = EpistemicState::default();
        state
            .beliefs
            .insert(BELIEF.to_string(), belief(BELIEF, SUBJECT));
        state
            .projection_paths
            .insert("churn.md".to_string(), BELIEF.to_string());
        state.alias_registry.insert(
            crate::ledger::schema::normalize_alias_v1("Churn Rate"),
            AliasState {
                normalized: crate::ledger::schema::normalize_alias_v1("Churn Rate"),
                alias: "Churn Rate".to_string(),
                entity_id: SUBJECT.to_string(),
                event_id: SUBJECT.to_string(),
            },
        );
        state
    }

    fn search(
        state: &EpistemicState,
        subject: &str,
        query: &str,
        aliases: &[&str],
    ) -> CandidateSearchReceipt {
        let aliases: Vec<String> = aliases.iter().map(|a| a.to_string()).collect();
        mint(state, EMPTY_INDEX_HEAD, subject, query, &aliases).unwrap()
    }

    #[test]
    fn a_search_of_an_empty_base_returns_nothing_and_says_so_per_leg() {
        let receipt = search(&EpistemicState::default(), SUBJECT, "churn.md", &["Churn"]);
        assert!(receipt.returned_candidates().is_empty());
        // Not "no candidates" but "not available": an empty attempted leg
        // would read as searched-and-found-nothing.
        assert_eq!(receipt.semantic.status, SemanticStatus::NotAvailable);
        assert_eq!(receipt.scoped.subject_id, SUBJECT);
    }

    #[test]
    fn the_scoped_leg_finds_what_shares_no_path_and_no_alias() {
        // THE LEG M24.7 MADE REAL. A second belief about the same subject
        // matches neither the exact path nor any alias; before this, the
        // receipt said "searched, found nothing" about the one duplicate
        // shape §15 exists for.
        let receipt = search(&world(), SUBJECT, "something-else.md", &[]);
        assert!(receipt.exact.candidate_ids.is_empty());
        assert!(receipt.aliases.candidate_ids.is_empty());
        assert_eq!(receipt.scoped.candidate_ids, vec![BELIEF.to_string()]);
        assert_eq!(receipt.returned_candidates(), vec![BELIEF]);
    }

    #[test]
    fn a_belief_about_a_different_subject_is_not_a_candidate() {
        let mut state = world();
        state
            .beliefs
            .insert(OTHER.to_string(), belief(OTHER, ELSEWHERE));
        assert_eq!(
            search(&state, SUBJECT, "no.md", &[]).scoped.candidate_ids,
            vec![BELIEF.to_string()]
        );
    }

    #[test]
    fn a_tombstoned_belief_is_not_something_a_create_could_have_updated() {
        let mut state = world();
        state.beliefs.get_mut(BELIEF).unwrap().tombstoned_by = Some(SUBJECT.to_string());
        assert!(search(&state, SUBJECT, "no.md", &[])
            .scoped
            .candidate_ids
            .is_empty());
    }

    #[test]
    fn every_leg_that_returns_something_gets_a_disposition() {
        let receipt = search(&world(), SUBJECT, "churn.md", &["Churn Rate"]);
        // One belief, reached three ways — and considered once.
        assert_eq!(receipt.exact.candidate_ids, vec![BELIEF.to_string()]);
        assert_eq!(receipt.aliases.candidate_ids, vec![BELIEF.to_string()]);
        assert_eq!(receipt.scoped.candidate_ids, vec![BELIEF.to_string()]);
        assert_eq!(receipt.considered.len(), 1);
        assert_eq!(receipt.considered[0].candidate_id, BELIEF);
    }

    #[test]
    fn the_receipt_id_digests_the_search_and_not_the_judgement() {
        // The authorship test rests on this split. What the server FOUND is
        // the server's and is sealed; what it MEANS is the proposer's and
        // must be free to change, or a disagreement with a default
        // disposition would look like forgery.
        let mut receipt = search(&world(), SUBJECT, "churn.md", &[]);
        let sealed = receipt.receipt_id.clone();
        receipt.considered[0].decision = crate::ledger::schema::CandidateDecision::Distinct;
        receipt.considered[0].reason = "a different scope entirely".into();
        assert_eq!(derive_receipt_id(&receipt).unwrap(), sealed);

        receipt.scoped.candidate_ids = vec![];
        assert_ne!(
            derive_receipt_id(&receipt).unwrap(),
            sealed,
            "dropping a leg's finding must not keep the id it was minted with"
        );
    }

    #[test]
    fn an_index_head_names_a_place_that_can_be_recomputed() {
        let head = crate::ledger::LedgerHead {
            seq: Some(7),
            hash: "abc".into(),
        };
        let derived = index_head_of(Some(&head));
        assert_eq!(derived, index_head_of(Some(&head)));
        assert_ne!(derived, EMPTY_INDEX_HEAD);
        assert_ne!(
            derived,
            index_head_of(Some(&crate::ledger::LedgerHead {
                seq: Some(8),
                hash: "abc".into()
            })),
            "a moved head is a different place to have searched"
        );
        assert_eq!(index_head_of(None), EMPTY_INDEX_HEAD);
    }
}
