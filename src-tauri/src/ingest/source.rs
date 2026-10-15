//! What a vault file IS, as a Source (M26.4i).
//!
//! **Three registrations, split by provenance — an owner decision, and an
//! irreversible one.** `derive_item_id` and `derive_receipt_id` both bake the
//! source id into every identity they mint, and there is no migration for a
//! re-registration under a different key. So this is written down here rather
//! than decided at a call site.
//!
//! The split is between what the OWNER wrote, what the ASSISTANT wrote, and
//! what came from OUTSIDE the vault:
//!
//! - A note is the OWNER's unless one of the two below claims it, and it is
//!   registered as the owner — the same `human_actor` source
//!   `ledger::capture` resolves for in-app edits, not a parallel one. A note
//!   typed into the app and the same note typed into an external editor are
//!   one person asserting one thing; two source identities for that would
//!   make a single claim look like two, which is manufactured corroboration.
//! - `vault-knowledge-v1` is a `builtin` carrying `ContentOnly`.
//!   `knowledge/` is agent-written and human-VERIFIED; giving it human
//!   authority would let the base vouch for its own output at full strength,
//!   which is the failure M26.3a's anti-self-ancestry walk exists to prevent,
//!   arriving through a different door. The bundle earns authority by being
//!   verified, not by being stored.
//! - `vault-import-v1` is a `builtin` carrying `ContentOnly` too (D15 (i),
//!   M66.7b). A note whose frontmatter names a `source_system` holds text
//!   somebody else wrote — a dropped .docx, an export — and the owner filing
//!   it is not the owner asserting it. The key is M69.3's own, so M69's
//!   import writer adopts these items with no re-keying.
//!
//! **The schema settles the shape, and it is stricter than the decision.**
//! `human_assertion` is a capability only a `human_actor` registration may
//! carry — authority is provenance derived from WHO, never a label attached
//! to a service id. An earlier draft of this module registered the authored
//! side as a `builtin` claiming `human_assertion`; every test here passed and
//! the writer refused it at the first real append, because nothing in those
//! tests ran a registration through `validate`. They do now.
//!
//! **This is provenance, not type.** The bundle splits on where a file lives
//! in the vault, because that is where the write guard lives (`knowledge.rs`
//! admits only `write_concept`/`verify_concept`), not on what `type:` a file
//! declares. A record that happens to be filed under `knowledge/` is
//! agent-written whatever it calls itself, so `knowledge/` wins over the
//! import marker: the guard is the boundary, and a frontmatter key is not.
//! Imports split on a frontmatter key because an import travels: the marker
//! goes wherever the file is moved.
//!
//! **An item's id derives from its source, so a provenance change is a new
//! item.** Adding or removing `source_system` later starts a new ledger item
//! for the same path, as a rename does. Nothing re-keys an item already
//! recorded.

use serde_json::Value;

use crate::ledger::capture;
use crate::ledger::reduce::EpistemicState;
use crate::ledger::schema::{
    self, Actor, AuthorityCapability, SourceRegistration, ACTOR_SOURCE_REGISTRY,
};
use crate::ledger::writer::member_ref;
use crate::runtime::normalize::Snapshot;

/// The vault owner. The same id `capture::capture_out_of_band_with` attributes
/// an external edit to, so the ingest pass and the capture valve resolve ONE
/// source rather than two.
pub const OWNER_ACTOR: &str = "human:owner";

/// The service id behind the agent-written bundle.
pub const BUNDLE_SERVICE: &str = "vault-knowledge-v1";

/// The service id behind imported material (D15 (i), M66.7b).
pub const IMPORT_SERVICE: &str = "vault-import-v1";

/// The frontmatter key that marks a note as imported. M69.3's own key, so
/// its import writer and M66.7c's captures share one vocabulary.
pub const IMPORT_MARKER: &str = "source_system";

/// Which of the three registrations a note belongs to.
///
/// Ordered so a caller that resolves several gets a stable batch layout.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Provenance {
    /// The owner wrote it.
    Authored,
    /// The assistant wrote it and a human verified it.
    Bundle,
    /// Somebody outside the vault wrote it; the owner filed it.
    Imported,
}

/// Which registration a note belongs to, from its vault-relative path and
/// the snapshot the scan took of it.
///
/// `knowledge/` comes first and ignores the frontmatter: it uses the same
/// boundary `knowledge.rs` guards, so a file cannot be written by the agent
/// through one door and read as anything else through another. Then a
/// non-blank string `source_system` marks an import. A blank or non-string
/// marker, or a wikilink (which the scanner files under relationships, never
/// properties), names no outside system and stays the owner's.
pub fn provenance_of(item_key: &str, snapshot: &Snapshot) -> Provenance {
    if crate::knowledge::is_knowledge_path(item_key) {
        return Provenance::Bundle;
    }
    let marker = snapshot
        .fields
        .get(&format!("properties.{IMPORT_MARKER}"))
        .and_then(Value::as_str);
    match marker {
        Some(system) if !system.trim().is_empty() => Provenance::Imported,
        _ => Provenance::Authored,
    }
}

/// The source id, its registration event, and — when nothing has registered
/// it yet — the member to stage at `ordinal`.
///
/// The same three-part shape `ledger::capture::resolve_registration` returns,
/// and for the same reason: a registration that must ride a batch cannot know
/// its own event id until the writer preallocates one.
///
/// `ordinal` is the caller's, not a constant, because up to three vault
/// sources can need registering in the same batch — the first launch of a
/// vault that already holds a `knowledge/` bundle and an imported capture
/// registers three. Two registrations both claiming one member would have one
/// source's Observations pinning another's registration event, which the
/// reducer would accept because both are real.
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
        Provenance::Bundle => builtin(state, store, BUNDLE_SERVICE, ordinal),
        Provenance::Imported => builtin(state, store, IMPORT_SERVICE, ordinal),
    }
}

/// A content-only `builtin` for one vault service: the bundle and imports
/// share this one code path, differing only in the service id.
fn builtin(
    state: &EpistemicState,
    store: &str,
    service: &str,
    ordinal: usize,
) -> (String, String, Option<(String, Value)>) {
    let mut registration = SourceRegistration::Builtin {
        source_key: String::new(),
        service_id: service.to_string(),
        authority_capability: AuthorityCapability::ContentOnly,
        // Neither is independent of the notes beside it: a concept is derived
        // from them, and an import is one the owner chose to file. Declaring
        // otherwise would manufacture corroboration out of one person's
        // filing. Independence between vaults is M27's question.
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
    use std::collections::BTreeSet;

    use crate::runtime::normalize;
    use crate::vault::entry::Entry;

    const STORE: &str = "feedfacefeedfacefeedfacefeedface";

    const ALL: [Provenance; 3] = [
        Provenance::Authored,
        Provenance::Bundle,
        Provenance::Imported,
    ];

    /// The snapshot the scan takes of a note with these frontmatter
    /// properties.
    fn snapshot_with(key: &str, properties: Value) -> Snapshot {
        let mut entry = Entry::empty_for_test(key);
        entry.properties = properties.as_object().cloned().unwrap_or_default();
        normalize::snapshot(&entry)
    }

    fn plain(key: &str) -> Snapshot {
        snapshot_with(key, serde_json::json!({}))
    }

    /// The registration inside a staged member, as the writer will read it.
    fn registration(staged: &Option<(String, Value)>) -> SourceRegistration {
        let body = &staged.as_ref().expect("a registration to stage").1;
        serde_json::from_value(body["registration"].clone()).expect("a registration")
    }

    #[test]
    fn all_three_registrations_survive_the_validator() {
        // THE test this module shipped without. An earlier draft registered
        // the authored side as a `builtin` claiming `human_assertion`; every
        // other test here passed and the first real append was refused.
        let empty = EpistemicState::default();
        for provenance in ALL {
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
        let (imported, _, _) = resolve(&empty, STORE, Provenance::Imported, 0);
        assert_ne!(authored, bundle);
        assert_ne!(authored, imported, "an import is not the owner's word");
        assert_ne!(bundle, imported, "nor the assistant's");
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
    fn an_import_never_carries_human_authority() {
        // D15 (i): text somebody else wrote, filed by the owner, is content
        // the owner holds — never the owner asserting it.
        let empty = EpistemicState::default();
        let (_, _, staged) = resolve(&empty, STORE, Provenance::Imported, 0);
        let registration = registration(&staged);
        assert_eq!(registration.capability(), AuthorityCapability::ContentOnly);
        match &registration {
            SourceRegistration::Builtin { service_id, .. } => {
                assert_eq!(service_id, IMPORT_SERVICE)
            }
            other => panic!("an import registers as a builtin, not {other:?}"),
        }
        let (imported, _, _) = resolve(&empty, STORE, Provenance::Imported, 0);
        let (owner, _, _) = capture::resolve_registration(&empty, STORE, OWNER_ACTOR, 0);
        assert_ne!(imported, owner);
    }

    #[test]
    fn each_import_system_registers_as_imported_content() {
        for system in crate::import::table().value["systems"].as_array().unwrap() {
            let key = "imports/page.md";
            let snapshot = snapshot_with(key, serde_json::json!({"source_system": system["id"]}));
            let provenance = provenance_of(key, &snapshot);
            assert_eq!(provenance, Provenance::Imported);
            let (_, _, staged) = resolve(&EpistemicState::default(), STORE, provenance, 0);
            let registered = registration(&staged);
            assert_eq!(registered.capability(), AuthorityCapability::ContentOnly);
            assert!(
                matches!(registered, SourceRegistration::Builtin { service_id, .. } if service_id == IMPORT_SERVICE)
            );
        }
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
        let concept = "knowledge/metrics/revenue.md";
        assert_eq!(provenance_of(concept, &plain(concept)), Provenance::Bundle);
        for key in [
            "records/risks/r-1.md",
            "inbox/capture.md",
            // A sibling directory that merely shares the prefix is not the
            // bundle.
            "knowledge-archive/x.md",
        ] {
            assert_eq!(provenance_of(key, &plain(key)), Provenance::Authored);
        }
    }

    #[test]
    fn the_split_reads_the_import_marker_and_knowledge_wins() {
        let key = "inbox/report.md";
        let marked = snapshot_with(key, serde_json::json!({ "source_system": "file" }));
        assert_eq!(provenance_of(key, &marked), Provenance::Imported);

        // The write guard is the boundary: a marker under knowledge/ does
        // not make the bundle an import.
        let concept = "knowledge/metrics/revenue.md";
        let marked_concept = snapshot_with(concept, serde_json::json!({ "source_system": "file" }));
        assert_eq!(provenance_of(concept, &marked_concept), Provenance::Bundle);

        // A marker that names no outside system stays the owner's.
        for value in [
            serde_json::json!(""),
            serde_json::json!("   "),
            serde_json::json!(null),
            serde_json::json!(true),
            serde_json::json!(3),
            serde_json::json!(["file"]),
            serde_json::json!({ "name": "file" }),
        ] {
            let snapshot = snapshot_with(key, serde_json::json!({ "source_system": value }));
            assert_eq!(
                provenance_of(key, &snapshot),
                Provenance::Authored,
                "{value} names no source system"
            );
        }

        // A wikilinked marker is a relationship, never a property — the
        // scanner files it there — so it names a note, not a system.
        let mut linked = Entry::empty_for_test(key);
        linked
            .relationships
            .insert(IMPORT_MARKER.to_string(), vec!["file".to_string()]);
        assert_eq!(
            provenance_of(key, &normalize::snapshot(&linked)),
            Provenance::Authored
        );

        // And a missing marker is the plain case.
        assert_eq!(provenance_of(key, &plain(key)), Provenance::Authored);
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
    fn an_import_id_is_a_function_of_the_store_alone() {
        // One import source per vault, whatever system a note names: the
        // marker's value is the item's business, not the source's, so a
        // capture from a file and one from an export are the same source.
        let empty = EpistemicState::default();
        let (a, _, _) = resolve(&empty, STORE, Provenance::Imported, 0);
        let (again, _, _) = resolve(&empty, STORE, Provenance::Imported, 2);
        assert_eq!(a, again, "the ordinal places it, never names it");
        let (elsewhere, _, _) = resolve(
            &empty,
            "0000000000000000000000000000beef",
            Provenance::Imported,
            0,
        );
        assert_ne!(a, elsewhere, "two vaults never share a source identity");
    }

    #[test]
    fn a_registration_carries_its_own_key_so_it_is_safe_batched_or_alone() {
        let empty = EpistemicState::default();
        for provenance in ALL {
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
    fn three_registrations_in_one_batch_take_three_ordinals() {
        // A first launch over a vault that already holds a `knowledge/`
        // bundle and an imported capture registers ALL THREE sources in one
        // batch. If two claimed one member, one source's Observations would
        // pin another's registration event — which the reducer would accept,
        // because both are real registrations.
        let empty = EpistemicState::default();
        let mut keys = BTreeSet::new();
        for (ordinal, provenance) in ALL.into_iter().enumerate() {
            let (_, event, staged) = resolve(&empty, STORE, provenance, ordinal);
            assert_eq!(event, member_ref(ordinal), "{provenance:?}");
            let key = staged.expect("a registration to stage").1["idempotency_key"].clone();
            assert!(keys.insert(key.to_string()), "{provenance:?} reused a key");
        }
        assert_eq!(keys.len(), 3);
    }

    #[test]
    fn no_vault_source_claims_an_independence_domain() {
        // A concept in the bundle is derived from the notes beside it, and an
        // import is one the owner chose to file. Declaring any of the three
        // independent would manufacture corroboration out of one person's
        // filing.
        let empty = EpistemicState::default();
        for provenance in ALL {
            let (_, _, staged) = resolve(&empty, STORE, provenance, 0);
            assert!(registration(&staged).independence_domain_id().is_none());
        }
    }
}
