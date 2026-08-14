//! Basic semantic retrieval (M26.2) — expansion over the knowledge graph.
//!
//! **What "semantic" means here, precisely.** Not a vector space: expansion
//! over the entities, aliases, and explicit relations M22 already holds. BM25
//! (`search.rs`) scores the words a note contains, so it cannot find a Belief
//! that talks about the same THING under a different name, and it cannot
//! reach the neighbour a relation points at. Those two misses are what this
//! module exists to close, and they are the two that matter for belief
//! retrieval — every one of the assembly's five intents (positive,
//! contradiction, historical, authority, scope-neighbour) is scoped by entity
//! or by graph position, not by prose similarity.
//!
//! **The boundary, named rather than discovered.** A true free-text
//! paraphrase — same meaning, no shared entity, no shared alias, no relation
//! — is NOT recalled by `expansion-v1`, and
//! `a_pure_paraphrase_is_not_recalled_and_that_is_the_documented_limit`
//! asserts it. Distributional similarity needs either a model or a corpus
//! large enough for co-occurrence to mean something; the golden corpus is
//! 133 notes and ~9k words, where co-occurrence is noise. Saying so in a test
//! is the honest version of §93's "adequacy must not assess an intentionally
//! crippled retriever": the retriever is not crippled, it is structural, and
//! the shape it cannot see is written down for M26.5 to inherit.
//!
//! **Purity is a hard requirement, not a style.** `preconditions.rs`
//! re-mints the whole receipt to check it — "the same search, run again,
//! here" — so retrieval MUST be a function of `EpistemicState` and the query
//! alone. A retriever backed by its own mutable store would return a
//! different set on the second run and every proposal would go stale for
//! reasons no one could see. This is also why M26.2 adds no index table: the
//! reducer state it reads is already the disposable, rebuildable artifact
//! (`ledger/index.rs`), so "the index is app-data, never the vault, and a
//! rebuild reproduces the same candidates" holds by construction rather than
//! by a second cache that could disagree with the first.

use std::collections::{BTreeMap, BTreeSet};

use crate::ledger::reduce::EpistemicState;
use crate::ledger::schema::{normalize_alias_v1, sha256_first128};

/// The retriever generation a receipt names. A change to what expansion
/// REACHES bumps this; a change to how it is stored does not.
///
/// It is a string rather than an integer because the next generation may not
/// be a successor — swapping in embeddings would be `embedding-<model>-v1`,
/// a different mechanism rather than a better version of this one.
pub const RETRIEVER_VERSION: &str = "expansion-v1";

/// How far expansion walks the relation graph.
///
/// ONE HOP. Two hops on a well-linked vault reaches most of it, which would
/// make the semantic leg a list of everything and therefore evidence of
/// nothing — and every candidate it returns costs the proposer a disposition
/// it has to justify. Neighbours-of-neighbours is a retrieval intent M26.5
/// can ask for explicitly if it ever needs one.
pub const RELATION_HOPS: usize = 1;

/// What a create is searching with.
pub struct Query<'a> {
    /// The entity the proposed Belief is about.
    pub subject_id: &'a str,
    /// The proposed Belief's prose. Read for the NAMES it mentions, never
    /// scored for similarity.
    pub content: &'a str,
    /// Spellings the proposal claims for itself.
    pub aliases: &'a [String],
}

/// The query's identity, server-derived.
///
/// Covers the subject, the normalized content, and the claimed spellings —
/// everything that changes what expansion reaches. Two callers proposing the
/// same thing about the same entity fingerprint identically; a caller who
/// edits the prose after the search gets a different one, which is how the
/// receipt's staleness check can see that the search no longer describes the
/// proposal it is attached to.
pub fn query_fingerprint(query: &Query) -> String {
    let mut aliases: Vec<String> = query
        .aliases
        .iter()
        .map(|a| normalize_alias_v1(a))
        .collect();
    aliases.sort();
    aliases.dedup();
    let body = format!(
        "{}\0{}\0{}",
        query.subject_id,
        normalize_alias_v1(query.content),
        aliases.join("\u{1}")
    );
    let mut bytes = Vec::with_capacity(body.len() + 32);
    bytes.extend_from_slice(b"cerebro-retrieval-query-v1\0");
    bytes.extend_from_slice(body.as_bytes());
    sha256_first128(&bytes)
}

/// Every alias whose normalized spelling appears in `content` as a whole
/// token run.
///
/// WHOLE RUNS, not substrings: "Rev C" must not match inside "Rev Council",
/// and a two-word alias must match both words in order. This is the leg BM25
/// structurally cannot have — it matches the corpus's NAMES against the
/// query's prose, where BM25 matches the query's words against the corpus's
/// prose.
pub(crate) fn entities_named_in(state: &EpistemicState, content: &str) -> BTreeSet<String> {
    let tokens: Vec<String> = crate::search::tokenize(content)
        .iter()
        .map(|token| normalize_alias_v1(token))
        .collect();

    // Group aliases by their token length so a multi-word alias is compared
    // against a window of the same width.
    let mut by_len: BTreeMap<usize, Vec<&crate::ledger::reduce::AliasState>> = BTreeMap::new();
    for alias in state.alias_registry.values() {
        let width = crate::search::tokenize(&alias.normalized).len();
        if width == 0 {
            continue;
        }
        by_len.entry(width).or_default().push(alias);
    }

    let mut found = BTreeSet::new();
    for (width, aliases) in &by_len {
        if *width > tokens.len() {
            continue;
        }
        for window in tokens.windows(*width) {
            let joined = window.join(" ");
            for alias in aliases {
                if crate::search::tokenize(&alias.normalized).join(" ") == joined {
                    found.insert(alias.entity_id.clone());
                }
            }
        }
    }
    found
}

/// Beliefs reachable from the subject's own Beliefs across live relations,
/// in either direction, within `RELATION_HOPS`.
///
/// **Relations join BELIEFS, not entities** — `supersedes`, `refines`, and
/// `contradicts` are claims about claims, and the reducer resolves an
/// endpoint by looking it up in `beliefs` (`reduce.rs`, the explicit-relation
/// basis walk). So the walk starts at what the base already believes about
/// this subject and steps to what those Beliefs are explicitly connected to.
/// `contradicts` is the edge that matters most here: it is literally the
/// accessible-counterevidence path the assembly contract requires be looked
/// down.
///
/// Direction-blind on purpose. A `contradicts` edge is one fact recorded from
/// one end, and a retriever that followed only outgoing edges would surface
/// the counterevidence for whichever Belief happened to be written second.
fn related_beliefs(state: &EpistemicState, subject_id: &str) -> BTreeSet<String> {
    let mut frontier: Vec<String> = state
        .beliefs
        .values()
        .filter(|belief| belief.entity_id == subject_id)
        .map(|belief| belief.belief_id.clone())
        .collect();
    let start: BTreeSet<String> = frontier.iter().cloned().collect();

    let mut reached: BTreeSet<String> = BTreeSet::new();
    for _ in 0..RELATION_HOPS {
        let mut next = Vec::new();
        for current in &frontier {
            for relation in state.relations.values() {
                if !relation.live {
                    continue;
                }
                let other = if &relation.from == current {
                    &relation.to
                } else if &relation.to == current {
                    &relation.from
                } else {
                    continue;
                };
                if !start.contains(other) && reached.insert(other.clone()) {
                    next.push(other.clone());
                }
            }
        }
        frontier = next;
    }
    reached
}

/// Live Beliefs about any of `entities`.
///
/// Tombstoned Beliefs are excluded for the same reason the scoped leg
/// excludes them: they are not something a create could have been an update
/// to. Superseded and archived ones stay — "there is already a retired belief
/// about this" is exactly what a reviewer wants to know.
fn beliefs_about(state: &EpistemicState, entities: &BTreeSet<String>) -> Vec<String> {
    let mut ids: Vec<String> = state
        .beliefs
        .values()
        .filter(|belief| entities.contains(&belief.entity_id) && belief.tombstoned_by.is_none())
        .map(|belief| belief.belief_id.clone())
        .collect();
    ids.sort();
    ids.dedup();
    ids
}

/// A retriever answers, or says it could not. `Err` carries the operator-
/// facing detail behind `semantic_search_unavailable`.
///
/// **`expansion-v1` never returns `Err`** — it reads state already in memory.
/// The fallible signature is here because the NEXT retriever can fail (a
/// model that will not load, an index that will not open) and the refusal
/// path has to exist and be tested before something needs it, not after. A
/// refusal nothing can produce is a refusal nobody has ever seen work.
pub type Outcome = Result<Vec<String>, String>;

/// The semantic candidate set: sorted, deduplicated, unranked.
///
/// **No scores, anywhere.** A rank would be a number nobody could defend and
/// the surrounding milestone forbids scalar salience outright; more
/// practically, the receipt's authorship check re-runs this and compares
/// SETS, so an ordering that drifted with a tie-break would manufacture
/// staleness out of nothing.
pub fn candidates(state: &EpistemicState, query: &Query) -> Outcome {
    Ok(reachable(state, query))
}

/// The expansion itself, infallible by construction. Two paths, unioned:
/// Beliefs about entities the PROSE names, and Beliefs one explicit relation
/// hop from what the base already believes about the subject.
fn reachable(state: &EpistemicState, query: &Query) -> Vec<String> {
    let mut entities = entities_named_in(state, query.content);
    for alias in query.aliases {
        if let Some(hit) = state.alias_registry.get(&normalize_alias_v1(alias)) {
            entities.insert(hit.entity_id.clone());
        }
    }
    // The subject's OWN Beliefs are the deterministic scoped leg's job. A
    // semantic leg that repeated them would inflate what expansion appears
    // to have contributed, and `returned_candidates` dedupes the evidence of
    // that away.
    entities.remove(query.subject_id);

    let mut ids: BTreeSet<String> = beliefs_about(state, &entities).into_iter().collect();
    for belief_id in related_beliefs(state, query.subject_id) {
        let is_live_and_elsewhere = state
            .beliefs
            .get(&belief_id)
            .is_some_and(|belief| belief.tombstoned_by.is_none());
        if is_live_and_elsewhere {
            ids.insert(belief_id);
        }
    }
    ids.into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ledger::reduce::{
        AliasState, BeliefState, EntityState, RelationState, RevisionState,
    };
    use crate::ledger::schema::{BeliefBasis, Lifecycle, Qualification, RelationKind};

    // The §84 worked examples, which are also M26.1's resolver corpus: one
    // product known by several surface forms, one revision known by an
    // abbreviation, and one neighbour reachable only across a relation.
    const FALCON: &str = "e0000000000000000000000000000001";
    const REV_C: &str = "e0000000000000000000000000000002";
    const PRODUCT_A: &str = "e0000000000000000000000000000003";
    const XAVIER: &str = "e0000000000000000000000000000004";

    const B_FALCON: &str = "b0000000000000000000000000000001";
    const B_REV_C: &str = "b0000000000000000000000000000002";
    const B_PRODUCT_A: &str = "b0000000000000000000000000000003";
    const B_XAVIER: &str = "b0000000000000000000000000000004";

    fn belief(id: &str, entity: &str) -> BeliefState {
        BeliefState {
            belief_id: id.to_string(),
            entity_id: entity.to_string(),
            created_event_id: "1".repeat(32),
            revisions: vec![RevisionState {
                revision: 1,
                event_id: "1".repeat(32),
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
            projection_head_event: "1".repeat(32),
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

    fn alias(state: &mut EpistemicState, spelling: &str, entity: &str) {
        let normalized = normalize_alias_v1(spelling);
        state.alias_registry.insert(
            normalized.clone(),
            AliasState {
                normalized,
                alias: spelling.to_string(),
                entity_id: entity.to_string(),
                event_id: "1".repeat(32),
            },
        );
    }

    /// Relations join BELIEFS. `contradicts` is used deliberately: it is the
    /// accessible-counterevidence edge the assembly contract requires be
    /// looked down.
    fn relate(state: &mut EpistemicState, id: &str, from: &str, to: &str, live: bool) {
        state.relations.insert(
            id.to_string(),
            RelationState {
                relation_id: id.to_string(),
                from: from.to_string(),
                to: to.to_string(),
                relation: RelationKind::Contradicts,
                live,
                last_add_event_id: "1".repeat(32),
                last_event_id: "1".repeat(32),
            },
        );
    }

    /// A base that knows four things and how two of them are connected.
    fn world() -> EpistemicState {
        let mut state = EpistemicState::default();
        for (entity, id) in [
            (FALCON, B_FALCON),
            (REV_C, B_REV_C),
            (PRODUCT_A, B_PRODUCT_A),
            (XAVIER, B_XAVIER),
        ] {
            state.entities.insert(
                entity.to_string(),
                EntityState {
                    entity_id: entity.to_string(),
                    registered_by_event_id: "1".repeat(32),
                },
            );
            state.beliefs.insert(id.to_string(), belief(id, entity));
        }
        alias(&mut state, "Falcon", FALCON);
        alias(&mut state, "Falcon C", FALCON);
        alias(&mut state, "Rev C", REV_C);
        alias(&mut state, "Product A", PRODUCT_A);
        alias(&mut state, "Xavier", XAVIER);
        // Xavier's Belief CONTRADICTS Product A's, and nothing else links.
        relate(&mut state, "r1", B_PRODUCT_A, B_XAVIER, true);
        state
    }

    fn recall(state: &EpistemicState, subject: &str, content: &str) -> Vec<String> {
        candidates(
            state,
            &Query {
                subject_id: subject,
                content,
                aliases: &[],
            },
        )
        .unwrap()
    }

    #[test]
    fn a_belief_named_only_by_an_alias_is_recalled() {
        // THE RECALL BM25 CANNOT HAVE. The prose says "Falcon C"; the Belief
        // it is about is stored under an entity id and its own content may
        // never contain that spelling. Lexical scoring matches the query's
        // words against the corpus's prose, and this matches the corpus's
        // NAMES against the query's prose — a different direction, which is
        // why one finds it and the other cannot.
        // The create is about Product A; its prose mentions Falcon C. Falcon's
        // Belief shares no path, no alias with the subject, and no relation —
        // the ONLY thing connecting them is a name in the text.
        let found = recall(
            &world(),
            PRODUCT_A,
            "the regression showed up on Falcon C last week",
        );
        assert!(found.contains(&B_FALCON.to_string()), "{found:?}");
    }

    #[test]
    fn an_abbreviation_registered_as_an_alias_is_recalled() {
        // "Rev C" is not a word in any Belief's body; it is a name the base
        // was taught.
        let found = recall(&world(), FALCON, "Rev C shipped without the fix");
        assert!(found.contains(&B_REV_C.to_string()), "{found:?}");
    }

    #[test]
    fn a_multi_word_alias_must_match_whole_tokens_in_order() {
        // "Rev C" must not fire inside "Rev Council", or expansion would
        // reach half the vault by accident and the semantic leg would become
        // evidence of nothing.
        let found = recall(&world(), FALCON, "the Rev Council met on Tuesday");
        assert!(!found.contains(&B_REV_C.to_string()), "{found:?}");
        // And the tokens have to be adjacent and ordered.
        let reversed = recall(&world(), FALCON, "C Rev was mentioned");
        assert!(!reversed.contains(&B_REV_C.to_string()), "{reversed:?}");
    }

    #[test]
    fn counterevidence_one_relation_hop_away_is_recalled() {
        // THE ACCESSIBLE-COUNTEREVIDENCE CASE. Nothing about Xavier appears
        // in the prose and no alias matches; the only path is the explicit
        // relation from Product A. A retriever that could not cross it would
        // let the assembly claim it looked while the one disconfirming
        // Belief sat one edge away.
        let found = recall(&world(), PRODUCT_A, "the rollout is on schedule");
        assert!(found.contains(&B_XAVIER.to_string()), "{found:?}");
    }

    #[test]
    fn a_dead_relation_is_not_a_path() {
        let mut state = world();
        relate(&mut state, "r1", B_PRODUCT_A, B_XAVIER, false);
        let found = recall(&state, PRODUCT_A, "the rollout is on schedule");
        assert!(!found.contains(&B_XAVIER.to_string()), "{found:?}");
    }

    #[test]
    fn relations_are_followed_from_either_end() {
        // "A blocks B" and "B is blocked by A" are the same fact written from
        // two ends. If only outgoing edges were followed, whether
        // counterevidence is visible would depend on who wrote the link.
        let found = recall(&world(), XAVIER, "nothing relevant here");
        assert!(found.contains(&B_PRODUCT_A.to_string()), "{found:?}");
    }

    #[test]
    fn the_subjects_own_beliefs_are_left_to_the_deterministic_leg() {
        // The scoped leg already returns these. Repeating them here would
        // inflate what expansion appears to have contributed.
        // Even when the prose names the subject's own alias, its Beliefs are
        // the scoped leg's to report.
        let named = recall(&world(), FALCON, "Falcon C again");
        assert!(!named.contains(&B_FALCON.to_string()), "{named:?}");
        let unnamed = recall(&world(), FALCON, "nothing named here");
        assert!(!unnamed.contains(&B_FALCON.to_string()), "{unnamed:?}");
    }

    #[test]
    fn a_tombstoned_belief_is_not_a_candidate() {
        let mut state = world();
        state.beliefs.get_mut(B_REV_C).unwrap().tombstoned_by = Some("1".repeat(32));
        let found = recall(&state, FALCON, "Rev C shipped without the fix");
        assert!(!found.contains(&B_REV_C.to_string()), "{found:?}");
    }

    #[test]
    fn a_pure_paraphrase_is_not_recalled_and_that_is_the_documented_limit() {
        // THE BOUNDARY, ASSERTED RATHER THAN DISCOVERED. "the bird slipped"
        // means what "Falcon C is late" means, and `expansion-v1` does not
        // know it: no shared alias, no shared entity, no relation. Reaching
        // it needs distributional similarity, which needs either a model or a
        // corpus far larger than this one.
        //
        // This test exists so M26.5 INHERITS the gap as a committed fact. If
        // a later retriever closes it, this test is the one that should fail
        // and be rewritten — deliberately, with a version bump — rather than
        // the gap being noticed by a user.
        let found = recall(&world(), FALCON, "the bird slipped");
        assert!(
            found.is_empty(),
            "expansion-v1 recalled a paraphrase it has no mechanism for: {found:?}"
        );
    }

    #[test]
    fn the_same_state_and_query_always_give_the_same_set() {
        // The purity the receipt validator depends on: it re-mints and
        // compares. A retriever with hidden state would manufacture staleness
        // out of nothing.
        let state = world();
        let once = recall(&state, PRODUCT_A, "Falcon C and Rev C");
        let twice = recall(&state, PRODUCT_A, "Falcon C and Rev C");
        assert_eq!(once, twice);
        let mut sorted = once.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(once, sorted, "candidates must be sorted and unique");
    }

    #[test]
    fn a_rebuilt_state_retrieves_identically() {
        // "The index is disposable and a rebuild reproduces the same
        // candidates" — which holds BY CONSTRUCTION here, because the only
        // state this reads is reducer state the rebuild already reconstructs.
        // M26.2 adds no index of its own precisely so there is no second
        // cache that could disagree with the first.
        let original = world();
        let rebuilt = world();
        assert_eq!(
            recall(&original, PRODUCT_A, "Falcon C and Rev C"),
            recall(&rebuilt, PRODUCT_A, "Falcon C and Rev C")
        );
    }

    #[test]
    fn the_fingerprint_moves_with_the_prose_and_not_with_anything_else() {
        let a = query_fingerprint(&Query {
            subject_id: FALCON,
            content: "Falcon C is late",
            aliases: &[],
        });
        let same = query_fingerprint(&Query {
            subject_id: FALCON,
            content: "Falcon C is late",
            aliases: &[],
        });
        let edited = query_fingerprint(&Query {
            subject_id: FALCON,
            content: "Falcon C is early",
            aliases: &[],
        });
        let other_subject = query_fingerprint(&Query {
            subject_id: REV_C,
            content: "Falcon C is late",
            aliases: &[],
        });
        assert_eq!(a, same);
        assert_ne!(a, edited, "editing the prose must change the fingerprint");
        assert_ne!(a, other_subject);
    }
}
