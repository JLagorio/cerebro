//! What a vault file IS, as a Source (M26.4i).
//!
//! **Two registrations, split by provenance — an owner decision, and an
//! irreversible one.** `derive_item_id` and `derive_receipt_id` both bake the
//! source id into every identity they mint, and there is no migration for a
//! re-registration under a different key. So this is written down here rather
//! than decided at a call site.
//!
//! The split is between what a PERSON wrote and what the ASSISTANT wrote:
//!
//! - Everything outside `knowledge/` is the OWNER's, and it is registered as
//!   the owner — the same `human_actor` source `ledger::capture` resolves for
//!   in-app edits, not a parallel one. A note typed into the app and the same
//!   note typed into an external editor are one person asserting one thing;
//!   two source identities for that would make a single claim look like two,
//!   which is manufactured corroboration.
//! - `vault-knowledge-v1` is a `builtin` carrying `ContentOnly`.
//!   `knowledge/` is agent-written and human-VERIFIED; giving it human
//!   authority would let the base vouch for its own output at full strength,
//!   which is the failure M26.3a's anti-self-ancestry walk exists to prevent,
//!   arriving through a different door. The bundle earns authority by being
//!   verified, not by being stored.
//!
//! **The schema settles the shape, and it is stricter than the decision.**
//! `human_assertion` is a capability only a `human_actor` registration may
//! carry — authority is provenance derived from WHO, never a label attached
//! to a service id. An earlier draft of this module registered the authored
//! side as a `builtin` claiming `human_assertion`; every test here passed and
//! the writer refused it at the first real append, because nothing in those
//! tests ran a registration through `validate`. They do now.
//!
//! **This is provenance, not type.** The split is on where a file lives in
//! the vault because that is where the write guard lives (`knowledge.rs`
//! admits only `write_concept`/`verify_concept`), not on what `type:` a file
//! declares. A record that happens to be filed under `knowledge/` is
//! agent-written whatever it calls itself.

use serde_json::Value;

use crate::ledger::capture;
use crate::ledger::reduce::EpistemicState;
use crate::ledger::schema::{
    self, Actor, AuthorityCapability, SourceRegistration, ACTOR_SOURCE_REGISTRY,
};
use crate::ledger::writer::member_ref;

/// The vault owner. The same id `capture::capture_out_of_band_with` attributes
/// an external edit to, so the ingest pass and the capture valve resolve ONE
/// source rather than two.
pub const OWNER_ACTOR: &str = "human:owner";

/// The service id behind the agent-written bundle.
pub const BUNDLE_SERVICE: &str = "vault-knowledge-v1";

/// Which side of the split a vault-relative path is on.
///
/// Ordered so a caller that resolves several gets a stable batch layout.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Provenance {
    /// The owner wrote it.
    Authored,
    /// The assistant wrote it and a human verified it.
    Bundle,
}

/// Which of the two a vault-relative path belongs to.
///
/// Uses the same boundary `knowledge.rs` guards, so a file cannot be written
/// by the agent through one door and read as human-authored through another.
pub fn provenance_of(item_key: &str) -> Provenance {
    if crate::knowledge::is_knowledge_path(item_key) {
        Provenance::Bundle
    } else {
        Provenance::Authored
    }
}

/// The source id, its registration event, and — when nothing has registered
/// it yet — the member to stage at `ordinal`.
///
/// The same three-part shape `ledger::capture::resolve_registration` returns,
/// and for the same reason: a registration that must ride a batch cannot know
/// its own event id until the writer preallocates one.
///
/// `ordinal` is the caller's, not a constant, because BOTH vault sources can
/// need registering in the same batch — the first launch of a vault that
/// already holds a `knowledge/` bundle registers two. Two registrations both
/// claiming member 0 would have one source's Observations pinning the other's
/// registration event, which the reducer would accept because both are real.
pub fn resolve(
    state: &EpistemicState,
    store: &str,
    provenance: Provenance,
    ordinal: usize,
) -> (String, String, Option<(String, Value)>) {
    match provenance {
        // Delegated, not copied: one definition of what the owner's source
        // IS, shared with the capture valve.
        Provenance::Authored => capture::resolve_registration(state, store, OWNER_ACTOR, ordinal),
        Provenance::Bundle => bundle(state, store, ordinal),
    }
}

fn bundle(
    state: &EpistemicState,
    store: &str,
    ordinal: usize,
) -> (String, String, Option<(String, Value)>) {
    let mut registration = SourceRegistration::Builtin {
        source_key: String::new(),
        service_id: BUNDLE_SERVICE.to_string(),
        authority_capability: AuthorityCapability::ContentOnly,
        // The bundle is NOT independent of the notes beside it: a concept is
        // derived from them, and declaring otherwise would manufacture
        // corroboration out of one person's filing. Independence between
        // vaults is M27's question.
        independence_domain_id: None,
    };
    let key = registration
        .derived_source_key()
        .expect("strings serialize");
    if let SourceRegistration::Builtin { source_key, .. } = &mut registration {
        *source_key = key.clone();
    }
    let source_id = schema::derive_source_id(store, &key);
    if let Some(existing) = state.sources.get(&source_id) {
        return (source_id, existing.registration_event_id.clone(), None);
    }
    let body = schema::SourceRegistered {
        schema: schema::BODY_SCHEMA,
        batch_id: None,
        // Its own key, so the registration is idempotent whether it commits
        // standalone or as a batch member.
        idempotency_key: Some(format!("source-register-v1:{store}:{source_id}")),
        actor: Actor {
            id: ACTOR_SOURCE_REGISTRY.to_string(),
        },
        occurred_at: None,
        valid_from: None,
        valid_to: None,
        source_id: source_id.clone(),
        registration,
    };
    (
        source_id,
        member_ref(ordinal),
        Some((
            schema::KIND_SOURCE_REGISTERED.to_string(),
            serde_json::to_value(&body).expect("registrations serialize"),
        )),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const STORE: &str = "feedfacefeedfacefeedfacefeedface";

    /// The registration inside a staged member, as the writer will read it.
    fn registration(staged: &Option<(String, Value)>) -> SourceRegistration {
        let body = &staged.as_ref().expect("a registration to stage").1;
        serde_json::from_value(body["registration"].clone()).expect("a registration")
    }

    #[test]
    fn both_registrations_survive_the_validator() {
        // THE test this module shipped without. An earlier draft registered
        // the authored side as a `builtin` claiming `human_assertion`; every
        // other test here passed and the first real append was refused.
        let empty = EpistemicState::default();
        for provenance in [Provenance::Authored, Provenance::Bundle] {
            let (_, _, staged) = resolve(&empty, STORE, provenance, 0);
            registration(&staged)
                .validate()
                .unwrap_or_else(|e| panic!("{provenance:?}: {e}"));
        }
    }

    #[test]
    fn the_bundle_and_the_users_own_notes_are_different_sources() {
        // The whole point of the split. One id for both would mean a concept
        // the assistant wrote carries the same authority as a note the user
        // typed.
        let empty = EpistemicState::default();
        let (authored, _, _) = resolve(&empty, STORE, Provenance::Authored, 0);
        let (bundle, _, _) = resolve(&empty, STORE, Provenance::Bundle, 0);
        assert_ne!(authored, bundle);
    }

    #[test]
    fn the_bundle_never_carries_human_authority() {
        let empty = EpistemicState::default();
        let (_, _, staged) = resolve(&empty, STORE, Provenance::Bundle, 0);
        assert_eq!(
            registration(&staged).capability(),
            AuthorityCapability::ContentOnly
        );
        let (_, _, staged) = resolve(&empty, STORE, Provenance::Authored, 0);
        assert_eq!(
            registration(&staged).capability(),
            AuthorityCapability::HumanAssertion
        );
    }

    #[test]
    fn the_owners_notes_and_the_owners_in_app_edits_are_one_source() {
        // Two identities for one person would make a single claim look like
        // two, which is manufactured corroboration.
        let empty = EpistemicState::default();
        let (ingest, _, _) = resolve(&empty, STORE, Provenance::Authored, 0);
        let (capture, _, _) = capture::resolve_registration(&empty, STORE, OWNER_ACTOR, 0);
        assert_eq!(ingest, capture);
    }

    #[test]
    fn the_split_follows_the_write_guards_boundary() {
        // Not `type:` — where the file lives, which is what knowledge.rs
        // guards. A record filed under knowledge/ is agent-written whatever
        // it calls itself.
        assert_eq!(
            provenance_of("knowledge/metrics/revenue.md"),
            Provenance::Bundle
        );
        assert_eq!(provenance_of("records/risks/r-1.md"), Provenance::Authored);
        assert_eq!(provenance_of("inbox/capture.md"), Provenance::Authored);
        // A sibling directory that merely shares the prefix is not the
        // bundle.
        assert_eq!(
            provenance_of("knowledge-archive/x.md"),
            Provenance::Authored
        );
    }

    #[test]
    fn an_id_is_a_function_of_the_store_and_the_identity_and_nothing_else() {
        // Irreversibility, made explicit: every item and receipt id is
        // derived from this, and a change re-derives the whole ledger.
        let empty = EpistemicState::default();
        let (a, _, _) = resolve(&empty, STORE, Provenance::Authored, 0);
        let (again, _, _) = resolve(&empty, STORE, Provenance::Authored, 0);
        assert_eq!(a, again);
        let (elsewhere, _, _) = resolve(
            &empty,
            "0000000000000000000000000000beef",
            Provenance::Authored,
            0,
        );
        assert_ne!(a, elsewhere, "two vaults never share a source identity");
    }

    #[test]
    fn a_registration_carries_its_own_key_so_it_is_safe_batched_or_alone() {
        let empty = EpistemicState::default();
        for provenance in [Provenance::Authored, Provenance::Bundle] {
            let (_, event, staged) = resolve(&empty, STORE, provenance, 0);
            assert_eq!(event, member_ref(0), "unregistered rides the ordinal given");
            let staged = staged.expect("a registration to stage");
            assert_eq!(staged.0, schema::KIND_SOURCE_REGISTERED);
            assert!(staged.1["idempotency_key"]
                .as_str()
                .unwrap()
                .starts_with("source-register-v1:"));
        }
    }

    #[test]
    fn two_registrations_in_one_batch_take_two_ordinals() {
        // A first launch over a vault that already holds a `knowledge/`
        // bundle registers BOTH sources in one batch. If they both claimed
        // member 0, one source's Observations would pin the other's
        // registration event — which the reducer would accept, because both
        // are real registrations.
        let empty = EpistemicState::default();
        let (_, authored_event, authored) = resolve(&empty, STORE, Provenance::Authored, 0);
        let (_, bundle_event, bundle) = resolve(&empty, STORE, Provenance::Bundle, 1);
        assert_eq!(authored_event, member_ref(0));
        assert_eq!(bundle_event, member_ref(1));
        assert_ne!(
            authored.unwrap().1["idempotency_key"],
            bundle.unwrap().1["idempotency_key"]
        );
    }

    #[test]
    fn neither_vault_source_claims_an_independence_domain() {
        // A concept in the bundle is derived from the notes beside it.
        // Declaring the two independent would manufacture corroboration out
        // of one person's filing.
        let empty = EpistemicState::default();
        for provenance in [Provenance::Authored, Provenance::Bundle] {
            let (_, _, staged) = resolve(&empty, STORE, provenance, 0);
            assert!(registration(&staged).independence_domain_id().is_none());
        }
    }
}
