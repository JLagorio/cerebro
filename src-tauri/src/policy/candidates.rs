//! The server-minted candidate search receipt (§15), deterministic legs
//! only.
//!
//! A create is the one mutation with no target to compare against, so the
//! §15 protection is a RECEIPT: proof that the server looked for what
//! already exists, against a named index head, before agreeing that this is
//! new. A caller cannot author one — the whole value is that the lookups
//! were run here.
//!
//! M24.4 mints what the deterministic index can answer today: exact
//! identity and explicit alias. The scoped/temporal leg is present and
//! empty, and the semantic leg is explicitly `not_available` rather than
//! quietly absent — an empty `attempted` leg would read as "searched, found
//! nothing" when nothing was searched. M24.7 makes the scoped/temporal
//! lookup real and adds staleness; M26 supplies the semantic leg and makes
//! an attempted one a precondition for registering the proposal tools at
//! all.

use crate::ledger::reduce::EpistemicState;
use crate::ledger::schema::{
    AliasLeg, CandidateSearchReceipt, ExactLeg, ScopedLeg, SemanticLeg, SemanticStatus,
};

/// The receipt format this build mints. A bump means the legs changed.
pub const SEARCH_VERSION: u64 = 1;

/// The index head an empty ledger presents: no events, nothing to have
/// searched. Spelled rather than faked, so a receipt can never claim to have
/// been minted against a head that does not exist.
pub const EMPTY_INDEX_HEAD: &str = "00000000000000000000000000000000";

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

    // Every candidate any leg returned needs a disposition, or the receipt
    // proves a search happened and says nothing about what was found.
    let mut considered: Vec<crate::ledger::schema::ConsideredCandidate> = Vec::new();
    let mut seen: Vec<&str> = exact_hits
        .iter()
        .chain(alias_hits.iter())
        .map(String::as_str)
        .collect();
    seen.sort_unstable();
    seen.dedup();
    for candidate in seen {
        considered.push(crate::ledger::schema::ConsideredCandidate {
            candidate_id: candidate.to_string(),
            // A deterministic hit on the identity a create claims is free is
            // not a distinctness judgement the server can make — it is the
            // §15 failure. Saying `update` here is the honest disposition:
            // the thing exists, revise it.
            decision: crate::ledger::schema::CandidateDecision::Update,
            reason: "the deterministic index already holds this identity".to_string(),
        });
    }

    let receipt = CandidateSearchReceipt {
        receipt_id: crate::ledger::schema::sha256_first128(
            format!("cerebro-candidate-receipt-v1\0{index_head}\0{exact_query}").as_bytes(),
        ),
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
            scope: serde_json::json!({}),
            valid_interval: None,
            candidate_ids: vec![],
        },
        semantic: SemanticLeg {
            status: SemanticStatus::NotAvailable,
            candidate_ids: vec![],
        },
        considered,
    };
    // `validate` checks the head is an event id, so a receipt can never
    // claim a head that does not have the shape of one.
    receipt.validate()?;
    Ok(receipt)
}
