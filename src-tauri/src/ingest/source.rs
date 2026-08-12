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
//! - `vault-files-v1` carries `HumanAssertion`. The user's notes are the
//!   user's own words, and the authority routes should read them that way.
//! - `vault-knowledge-v1` carries `ContentOnly`. `knowledge/` is agent-written
//!   and human-VERIFIED; giving it human authority would let the base vouch
//!   for its own output at full strength, which is the failure M26.3a's
//!   anti-self-ancestry walk exists to prevent, arriving through a different
//!   door. The bundle earns authority by being verified, not by being stored.
//!
//! **This is provenance, not type.** The split is on where a file lives in
//! the vault because that is where the write guard lives (`knowledge.rs`
//! admits only `write_concept`/`verify_concept`), not on what `type:` a file
//! declares. A record that happens to be filed under `knowledge/` is
//! agent-written whatever it calls itself.

use serde_json::Value;

use crate::ledger::reduce::EpistemicState;
use crate::ledger::schema::{
    self, Actor, AuthorityCapability, SourceRegistration, ACTOR_SOURCE_REGISTRY,
};
use crate::ledger::writer::member_ref;

/// The service id behind `HumanAssertion` — everything a person authors.
pub const AUTHORED_SERVICE: &str = "vault-files-v1";
/// The service id behind `ContentOnly` — the agent-written bundle.
pub const BUNDLE_SERVICE: &str = "vault-knowledge-v1";

/// Which of the two a vault-relative path belongs to.
///
/// Uses the same boundary `knowledge.rs` guards, so a file cannot be written
/// by the agent through one door and read as human-authored through another.
pub fn service_for(item_key: &str) -> &'static str {
    if crate::knowledge::is_knowledge_path(item_key) {
        BUNDLE_SERVICE
    } else {
        AUTHORED_SERVICE
    }
}

fn capability_for(service: &str) -> AuthorityCapability {
    if service == BUNDLE_SERVICE {
        AuthorityCapability::ContentOnly
    } else {
        AuthorityCapability::HumanAssertion
    }
}

/// The source id, its registration event, and — when nothing has registered
/// it yet — the member to stage at ordinal 0.
///
/// The same three-part shape `ledger::capture::resolve_registration` returns,
/// and for the same reason: a registration that must ride a batch cannot know
/// its own event id until the writer preallocates one.
pub fn resolve(
    state: &EpistemicState,
    store: &str,
    service: &str,
) -> (String, String, Option<(String, Value)>) {
    let mut registration = SourceRegistration::Builtin {
        source_key: String::new(),
        service_id: service.to_string(),
        authority_capability: capability_for(service),
        // Two vault sources in one store are NOT independent of each other:
        // a concept in the bundle is derived from the notes beside it, and
        // saying otherwise would manufacture corroboration out of one
        // person's filing. Independence between vaults is M27's question.
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
        member_ref(0),
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

    #[test]
    fn the_bundle_and_the_users_own_notes_are_different_sources() {
        // The whole point of the split. One id for both would mean a concept
        // the assistant wrote carries the same authority as a note the user
        // typed.
        let empty = EpistemicState::default();
        let (authored, _, _) = resolve(&empty, STORE, AUTHORED_SERVICE);
        let (bundle, _, _) = resolve(&empty, STORE, BUNDLE_SERVICE);
        assert_ne!(authored, bundle);
    }

    #[test]
    fn the_bundle_never_carries_human_authority() {
        assert_eq!(
            capability_for(BUNDLE_SERVICE),
            AuthorityCapability::ContentOnly
        );
        assert_eq!(
            capability_for(AUTHORED_SERVICE),
            AuthorityCapability::HumanAssertion
        );
    }

    #[test]
    fn the_split_follows_the_write_guards_boundary() {
        // Not `type:` — where the file lives, which is what knowledge.rs
        // guards. A record filed under knowledge/ is agent-written whatever
        // it calls itself.
        assert_eq!(service_for("knowledge/metrics/revenue.md"), BUNDLE_SERVICE);
        assert_eq!(service_for("records/risks/r-1.md"), AUTHORED_SERVICE);
        assert_eq!(service_for("inbox/capture.md"), AUTHORED_SERVICE);
        // A sibling directory that merely shares the prefix is not the
        // bundle.
        assert_eq!(service_for("knowledge-archive/x.md"), AUTHORED_SERVICE);
    }

    #[test]
    fn an_id_is_a_function_of_the_store_and_the_service_and_nothing_else() {
        // Irreversibility, made explicit: every item and receipt id is
        // derived from this, and a change re-derives the whole ledger.
        let empty = EpistemicState::default();
        let (a, _, _) = resolve(&empty, STORE, AUTHORED_SERVICE);
        let (again, _, _) = resolve(&empty, STORE, AUTHORED_SERVICE);
        assert_eq!(a, again);
        let (elsewhere, _, _) =
            resolve(&empty, "0000000000000000000000000000beef", AUTHORED_SERVICE);
        assert_ne!(a, elsewhere, "two vaults never share a source identity");
    }

    #[test]
    fn a_registered_source_is_named_rather_than_staged_again() {
        let empty = EpistemicState::default();
        let (_, event, staged) = resolve(&empty, STORE, AUTHORED_SERVICE);
        assert_eq!(event, member_ref(0), "unregistered rides ordinal 0");
        let staged = staged.expect("a registration to stage");
        assert_eq!(staged.0, schema::KIND_SOURCE_REGISTERED);
        // Its own idempotency key, so it is safe standalone or batched.
        assert!(staged.1["idempotency_key"]
            .as_str()
            .unwrap()
            .starts_with("source-register-v1:"));
    }

    #[test]
    fn neither_vault_source_claims_an_independence_domain() {
        // A concept in the bundle is derived from the notes beside it.
        // Declaring the two independent would manufacture corroboration out
        // of one person's filing.
        let empty = EpistemicState::default();
        for service in [AUTHORED_SERVICE, BUNDLE_SERVICE] {
            let (_, _, staged) = resolve(&empty, STORE, service);
            let body = staged.expect("a registration").1;
            assert!(body["registration"]["independence_domain_id"].is_null());
        }
    }
}
