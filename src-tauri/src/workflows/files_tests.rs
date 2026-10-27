use super::*;
use std::{fs, path::PathBuf};

struct Fixture {
    root: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        Self {
            root: crate::vault::testutil::temp_vault("workflow-files"),
        }
    }
    fn store(&self) -> DefinitionStore {
        DefinitionStore::open(&self.root, "flow_1").unwrap()
    }
    fn workflow(&self) -> PathBuf {
        self.root.join(".cerebro/workflows/flow_1")
    }
    fn pointer(&self) -> PathBuf {
        self.workflow().join("published.json")
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn definition(label: &str) -> String {
    let schema = r#"{"type":"object","properties":{},"additionalProperties":false}"#;
    let digest = crate::actions::schema::workflow_schema_digest(schema).unwrap();
    serde_json::json!({
        "formatVersion":1,"workflowId":"flow_1","entryStepId":"result",
        "inputSchema":serde_json::from_str::<serde_json::Value>(schema).unwrap(),
        "inputSchemaDigest":digest,"declaredActionDigests":[],"authoredBy":"Owner",
        "trigger":{"kind":"manual"},
        "steps":[{"stepId":"result","label":label,"operation":{"kind":"result","output":{"kind":"literal","value":null}}}]
    }).to_string()
}
fn publish_first(store: &DefinitionStore) -> (DraftRef, PublicationRef) {
    let draft = store.save_draft(&definition("First"), None).unwrap();
    let published = store.publish(&draft, None).unwrap();
    (draft, published)
}

#[test]
fn incomplete_drafts_are_bounded_duplicate_free_and_saved_by_exact_etag() {
    let f = Fixture::new();
    let store = f.store();
    let raw = "{\n  \"steps\": [], \"unfinished\": true\n}\n";
    let first = store.save_draft(raw, None).unwrap();
    assert_eq!(store.read_draft().unwrap().unwrap().json, raw);
    assert_eq!(
        store.save_draft("{}", None).unwrap_err(),
        FileError::Conflict
    );
    assert_eq!(
        store.save_draft("{}", Some("stale")).unwrap_err(),
        FileError::Conflict
    );
    assert_eq!(store.read_draft().unwrap().unwrap().json, raw);
    assert_eq!(
        store
            .save_draft(r#"{"x":1,"x":2}"#, Some(&first.etag))
            .unwrap_err(),
        FileError::InvalidJson
    );
    let oversized = format!("{{\"x\":\"{}\"}}", "a".repeat(262144));
    assert_eq!(
        store.save_draft(&oversized, Some(&first.etag)).unwrap_err(),
        FileError::LimitExceeded
    );
    assert!(matches!(
        store.publish(&first, None),
        Err(FileError::InvalidDefinition(_))
    ));
    let second = store.save_draft("{}", Some(&first.etag)).unwrap();
    assert_ne!(first.etag, second.etag);
    assert!(store.read_publication().unwrap().is_none());
}

#[test]
fn publish_installs_immutable_version_before_pointer_and_never_activates() {
    let f = Fixture::new();
    let store = f.store();
    let (_, published) = publish_first(&store);
    assert_eq!(published.revision, 1);
    let version_path = f
        .workflow()
        .join("versions")
        .join(format!("{}.json", published.definition_hash));
    let bytes = fs::read_to_string(version_path).unwrap();
    assert_eq!(
        definition::validate(&bytes).unwrap().definition_hash,
        published.definition_hash
    );
    assert_eq!(store.read_publication().unwrap(), Some(published));
    assert!(!f.workflow().join("activation.json").exists());
    assert!(!f.root.join("runtime.db").exists());
}

#[test]
fn expected_draft_and_publication_revision_preserve_previous_pointer_on_conflict() {
    let f = Fixture::new();
    let store = f.store();
    let (old, published) = publish_first(&store);
    let previous = fs::read(f.pointer()).unwrap();
    let new = store
        .save_draft(&definition("Second"), Some(&old.etag))
        .unwrap();
    assert_eq!(
        store.publish(&old, Some(published.revision)).unwrap_err(),
        FileError::Conflict
    );
    assert_eq!(store.publish(&new, None).unwrap_err(), FileError::Conflict);
    assert_eq!(
        store.publish(&new, Some(99)).unwrap_err(),
        FileError::Conflict
    );
    assert_eq!(fs::read(f.pointer()).unwrap(), previous);
    let second = store.publish(&new, Some(published.revision)).unwrap();
    assert_eq!(second.revision, 2);
    assert_ne!(second.definition_hash, published.definition_hash);
    assert_eq!(
        store
            .read_version(&published.definition_hash)
            .unwrap()
            .definition
            .steps[0]
            .label,
        "First"
    );
}

#[test]
fn injected_prepublication_failures_leave_previous_pointer_bytes_intact() {
    for point in [
        FailPoint::BeforeVersionInstall,
        FailPoint::BeforePointerRename,
    ] {
        let f = Fixture::new();
        let store = f.store();
        let (first, published) = publish_first(&store);
        let previous = fs::read(f.pointer()).unwrap();
        let new = store
            .save_draft(&definition("Second"), Some(&first.etag))
            .unwrap();
        assert_eq!(
            with_failure(point, || store.publish(&new, Some(published.revision))).unwrap_err(),
            FileError::Unavailable
        );
        assert_eq!(fs::read(f.pointer()).unwrap(), previous);
        assert_eq!(store.read_publication().unwrap(), Some(published));
        let hash = definition::validate(&definition("Second"))
            .unwrap()
            .definition_hash;
        let version = f.workflow().join("versions").join(format!("{hash}.json"));
        assert_eq!(version.exists(), point == FailPoint::BeforePointerRename);
        if version.exists() {
            assert_eq!(store.read_version(&hash).unwrap().definition_hash, hash);
        }
    }
}

#[test]
fn postrename_failure_is_commit_uncertain_and_reads_actual_new_pointer() {
    let f = Fixture::new();
    let store = f.store();
    let (first, published) = publish_first(&store);
    let new = store
        .save_draft(&definition("Second"), Some(&first.etag))
        .unwrap();
    assert_eq!(
        with_failure(FailPoint::AfterPointerRename, || store
            .publish(&new, Some(published.revision)))
        .unwrap_err(),
        FileError::CommitUncertain
    );
    let current = store.read_publication().unwrap().unwrap();
    assert_eq!(current.revision, 2);
    assert_ne!(current.definition_hash, published.definition_hash);
    assert_eq!(
        store.publish(&new, Some(1)).unwrap_err(),
        FileError::Conflict
    );
}

#[test]
fn draft_commit_failure_keeps_previous_bytes_or_reports_uncertain_after_rename() {
    let f = Fixture::new();
    let store = f.store();
    let first = store.save_draft("{}", None).unwrap();
    assert_eq!(
        with_failure(FailPoint::BeforeDraftRename, || store
            .save_draft("{\"x\":1}", Some(&first.etag)))
        .unwrap_err(),
        FileError::Unavailable
    );
    assert_eq!(store.read_draft().unwrap().unwrap().json, "{}");
    assert_eq!(
        with_failure(FailPoint::AfterDraftRename, || store
            .save_draft("{\"x\":1}", Some(&first.etag)))
        .unwrap_err(),
        FileError::CommitUncertain
    );
    assert_eq!(store.read_draft().unwrap().unwrap().json, "{\"x\":1}");
}

#[test]
fn changed_version_bytes_are_never_overwritten_under_old_hash() {
    let f = Fixture::new();
    let store = f.store();
    let (draft, published) = publish_first(&store);
    let path = f
        .workflow()
        .join("versions")
        .join(format!("{}.json", published.definition_hash));
    fs::write(&path, definition("Foreign changed bytes")).unwrap();
    let before = fs::read(&path).unwrap();
    assert_eq!(
        store.read_version(&published.definition_hash).unwrap_err(),
        FileError::InvalidVersion
    );
    assert_eq!(
        store.publish(&draft, Some(1)).unwrap_err(),
        FileError::InvalidVersion
    );
    assert_eq!(fs::read(path).unwrap(), before);
}

#[test]
fn symlinked_owned_components_and_traversal_are_refused_without_foreign_writes() {
    let f = Fixture::new();
    let outside = f.root.join("foreign");
    fs::create_dir(&outside).unwrap();
    for id in ["../foreign", "a/b", "", ".", "..", "a\\b"] {
        assert!(DefinitionStore::open(&f.root, id).is_err());
    }
    fs::create_dir_all(f.root.join(".cerebro")).unwrap();
    std::os::unix::fs::symlink(&outside, f.root.join(".cerebro/workflows")).unwrap();
    assert!(DefinitionStore::open(&f.root, "flow_1").is_err());
    assert_eq!(fs::read_dir(outside).unwrap().count(), 0);
}

#[test]
fn replaced_owned_directory_before_pointer_commit_refuses_replacement_tree() {
    let f = Fixture::new();
    let store = f.store();
    let (first, published) = publish_first(&store);
    let previous = fs::read(f.pointer()).unwrap();
    let new = store
        .save_draft(&definition("Second"), Some(&first.etag))
        .unwrap();
    let original = f.workflow();
    let moved = f.root.join("moved");
    let outside = f.root.join("foreign");
    fs::create_dir(&outside).unwrap();
    let hook_moved = moved.clone();
    let hook_outside = outside.clone();
    let result = with_pointer_hook(
        move || {
            fs::rename(&original, &hook_moved).unwrap();
            std::os::unix::fs::symlink(&hook_outside, &original).unwrap();
        },
        || store.publish(&new, Some(published.revision)),
    );
    assert!(result.is_err());
    assert_eq!(fs::read(moved.join("published.json")).unwrap(), previous);
    assert_eq!(fs::read_dir(outside).unwrap().count(), 0);
}

#[test]
fn two_store_handles_cannot_overwrite_same_expected_publication_revision() {
    let f = Fixture::new();
    let first = f.store();
    let second = f.store();
    let (draft, _) = publish_first(&first);
    let next = first
        .save_draft(&definition("Second"), Some(&draft.etag))
        .unwrap();
    let (left, right) = std::thread::scope(|threads| {
        let left = threads.spawn(|| first.publish(&next, Some(1)));
        let right = threads.spawn(|| second.publish(&next, Some(1)));
        (left.join().unwrap(), right.join().unwrap())
    });
    assert_eq!(usize::from(left.is_ok()) + usize::from(right.is_ok()), 1);
    let refused = if left.is_err() {
        left.unwrap_err()
    } else {
        right.unwrap_err()
    };
    assert!(matches!(refused, FileError::Busy | FileError::Conflict));
    assert_eq!(first.read_publication().unwrap().unwrap().revision, 2);
}

#[test]
fn pointer_is_still_old_when_complete_new_version_is_ready_for_publication() {
    let f = Fixture::new();
    let store = f.store();
    let (first, published) = publish_first(&store);
    let previous = fs::read(f.pointer()).unwrap();
    let new = store
        .save_draft(&definition("Second"), Some(&first.etag))
        .unwrap();
    let hash = definition::validate(&definition("Second"))
        .unwrap()
        .definition_hash;
    let path = f.workflow();
    let seen = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let hook_seen = seen.clone();
    let result = with_pointer_hook(
        move || {
            let bytes =
                fs::read_to_string(path.join("versions").join(format!("{hash}.json"))).unwrap();
            let valid = definition::validate(&bytes).unwrap().definition_hash == hash;
            hook_seen.store(
                valid && fs::read(path.join("published.json")).unwrap() == previous,
                std::sync::atomic::Ordering::SeqCst,
            );
        },
        || store.publish(&new, Some(published.revision)),
    );
    result.unwrap();
    assert!(seen.load(std::sync::atomic::Ordering::SeqCst));
}

#[test]
fn schema_digest_mismatch_refuses_publication_and_unsupported_stored_format_is_explicit() {
    let f = Fixture::new();
    let store = f.store();
    let (draft, published) = publish_first(&store);
    let previous = fs::read(f.pointer()).unwrap();
    let mut bad: serde_json::Value = serde_json::from_str(&definition("Second")).unwrap();
    bad["inputSchemaDigest"] = serde_json::json!("0".repeat(64));
    let invalid = store
        .save_draft(&bad.to_string(), Some(&draft.etag))
        .unwrap();
    assert_eq!(
        store.publish(&invalid, Some(1)).unwrap_err(),
        FileError::InvalidDefinition(DefinitionError::SchemaDigestMismatch)
    );
    assert_eq!(fs::read(f.pointer()).unwrap(), previous);
    let path = f
        .workflow()
        .join("versions")
        .join(format!("{}.json", published.definition_hash));
    let mut future: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
    future["formatVersion"] = serde_json::json!(2);
    fs::write(path, future.to_string()).unwrap();
    assert_eq!(
        store.read_version(&published.definition_hash).unwrap_err(),
        FileError::InvalidDefinition(DefinitionError::UnsupportedFormat)
    );
}

#[test]
fn symlinked_draft_and_version_slots_never_read_or_overwrite_foreign_files() {
    let f = Fixture::new();
    let store = f.store();
    let foreign = f.root.join("foreign.json");
    fs::write(&foreign, "{\"keep\":true}").unwrap();
    std::os::unix::fs::symlink(&foreign, f.workflow().join("draft.json")).unwrap();
    assert!(store.read_draft().is_err());
    assert!(store.save_draft("{}", None).is_err());
    assert_eq!(fs::read_to_string(&foreign).unwrap(), "{\"keep\":true}");
    fs::remove_file(f.workflow().join("draft.json")).unwrap();
    let valid = definition::validate(&definition("First")).unwrap();
    std::os::unix::fs::symlink(
        &foreign,
        f.workflow()
            .join("versions")
            .join(format!("{}.json", valid.definition_hash)),
    )
    .unwrap();
    let draft = store.save_draft(&definition("First"), None).unwrap();
    assert!(store.publish(&draft, None).is_err());
    assert!(!f.pointer().exists());
    assert_eq!(fs::read_to_string(foreign).unwrap(), "{\"keep\":true}");
}

#[test]
fn draft_changed_during_publication_keeps_prior_pointer_and_newer_draft() {
    let f = Fixture::new();
    let store = f.store();
    let (first, published) = publish_first(&store);
    let previous = fs::read(f.pointer()).unwrap();
    let second = store
        .save_draft(&definition("Second"), Some(&first.etag))
        .unwrap();
    let draft_path = f.workflow().join("draft.json");
    let foreign = definition("Concurrent human draft");
    let hook_foreign = foreign.clone();
    let result = with_pointer_hook(
        move || fs::write(draft_path, hook_foreign).unwrap(),
        || store.publish(&second, Some(published.revision)),
    );
    assert_eq!(result.unwrap_err(), FileError::Conflict);
    assert_eq!(fs::read(f.pointer()).unwrap(), previous);
    assert_eq!(store.read_draft().unwrap().unwrap().json, foreign);
}

#[test]
fn replaced_lock_identity_refuses_pointer_commit_without_overwriting_new_lock() {
    let f = Fixture::new();
    let store = f.store();
    let (first, published) = publish_first(&store);
    let previous = fs::read(f.pointer()).unwrap();
    let second = store
        .save_draft(&definition("Second"), Some(&first.etag))
        .unwrap();
    let directory = f.workflow();
    let result = with_pointer_hook(
        move || {
            fs::rename(directory.join(".lock"), directory.join("old-lock")).unwrap();
            fs::write(directory.join(".lock"), b"foreign lock sentinel").unwrap();
        },
        || store.publish(&second, Some(published.revision)),
    );
    assert!(result.is_err());
    assert_eq!(fs::read(f.pointer()).unwrap(), previous);
    assert_eq!(
        fs::read(f.workflow().join(".lock")).unwrap(),
        b"foreign lock sentinel"
    );
}

#[test]
fn future_publication_pointer_is_reported_before_v1_shape_decoding() {
    let f = Fixture::new();
    let store = f.store();
    let (_, published) = publish_first(&store);
    let future = serde_json::json!({
        "formatVersion": 3,
        "workflowId": "flow_1",
        "selectedVersion": {"hash": published.definition_hash},
        "revision": 2,
        "futureMetadata": {"writer": "newer-reader"}
    })
    .to_string();
    fs::write(f.pointer(), &future).unwrap();
    assert_eq!(
        store.read_publication().unwrap_err(),
        FileError::InvalidDefinition(DefinitionError::UnsupportedFormat)
    );
    assert_eq!(fs::read_to_string(f.pointer()).unwrap(), future);
}

#[test]
fn interrupted_version_install_remains_single_link_readable_and_retryable() {
    use std::os::unix::fs::MetadataExt;
    let f = Fixture::new();
    let store = f.store();
    let (first, published) = publish_first(&store);
    let previous_pointer = fs::read(f.pointer()).unwrap();
    let old_version = f
        .workflow()
        .join("versions")
        .join(format!("{}.json", published.definition_hash));
    let previous_version = fs::read(&old_version).unwrap();
    let second = store
        .save_draft(&definition("Second"), Some(&first.etag))
        .unwrap();
    let second_hash = definition::validate(&definition("Second"))
        .unwrap()
        .definition_hash;
    assert_eq!(
        with_failure(FailPoint::AfterVersionEntryInstall, || store
            .publish(&second, Some(published.revision)))
        .unwrap_err(),
        FileError::Unavailable
    );
    drop(store);

    let reopened = f.store();
    assert_eq!(fs::read(f.pointer()).unwrap(), previous_pointer);
    assert_eq!(
        reopened.read_publication().unwrap(),
        Some(published.clone())
    );
    let second_path = f
        .workflow()
        .join("versions")
        .join(format!("{second_hash}.json"));
    assert_eq!(
        fs::metadata(&second_path).unwrap().nlink(),
        1,
        "one interrupted installation must never leave a second name for the immutable version"
    );
    assert_eq!(
        reopened.read_version(&second_hash).unwrap().definition_hash,
        second_hash
    );
    let resumed = reopened.publish(&second, Some(published.revision)).unwrap();
    assert_eq!(resumed.revision, published.revision + 1);
    assert_eq!(resumed.definition_hash, second_hash);
    assert_eq!(reopened.read_publication().unwrap(), Some(resumed));
    assert_eq!(fs::read(old_version).unwrap(), previous_version);
}

#[test]
fn catalog_missing_owned_namespace_is_empty_without_creating_it() {
    let f = Fixture::new();
    let page = DefinitionStore::list_existing(&f.root, None).unwrap();
    assert!(page.ids.is_empty());
    assert!(page.next_cursor.is_none());
    assert!(!page.truncated);
    assert!(!f.root.join(".cerebro").exists());
}
#[test]
fn catalog_pages_existing_private_workflows_without_creating_locks() {
    let f = Fixture::new();
    let limits = crate::runtime::workflows::catalog_policy();
    for i in 0..=limits.page_size {
        let id = format!("flow_{i:04}");
        drop(DefinitionStore::open(&f.root, &id).unwrap());
        fs::remove_file(f.root.join(".cerebro/workflows").join(id).join(".lock")).unwrap();
    }
    let first = DefinitionStore::list_existing(&f.root, None).unwrap();
    assert_eq!(first.ids.len(), limits.page_size);
    assert!(!first.truncated);
    let second = DefinitionStore::list_existing(&f.root, first.next_cursor.as_deref()).unwrap();
    assert_eq!(second.ids.len(), 1);
    assert!(second.next_cursor.is_none());
    assert!(!second.truncated);
    assert!(first.ids.last().unwrap() < second.ids.first().unwrap());
    for id in first.ids.iter().chain(second.ids.iter()) {
        assert!(!f
            .root
            .join(".cerebro/workflows")
            .join(id)
            .join(".lock")
            .exists());
    }
}
#[test]
fn catalog_refuses_symlink_namespace_without_following_it() {
    let f = Fixture::new();
    let other = Fixture::new();
    std::os::unix::fs::symlink(&other.root, f.root.join(".cerebro")).unwrap();
    assert_eq!(
        DefinitionStore::list_existing(&f.root, None).unwrap_err(),
        FileError::InvalidPath
    );
    assert!(!other.root.join("workflows").exists());
}
#[test]
fn catalog_inspection_reads_draft_publication_versions_without_lock_creation() {
    let f = Fixture::new();
    let store = f.store();
    let (draft, published) = publish_first(&store);
    drop(store);
    fs::remove_file(f.workflow().join(".lock")).unwrap();
    let document = DefinitionStore::inspect_existing(&f.root, "flow_1").unwrap();
    assert_eq!(document.draft.unwrap().reference, draft);
    assert_eq!(document.publication, Some(published.clone()));
    assert_eq!(document.versions, vec![published.definition_hash]);
    assert!(!document.versions_truncated);
    assert!(!f.workflow().join(".lock").exists());
}
#[test]
fn catalog_scan_bound_is_visible_and_never_claims_complete() {
    use std::os::unix::fs::DirBuilderExt;
    let f = Fixture::new();
    drop(f.store());
    let limits = crate::runtime::workflows::catalog_policy();
    for i in 0..limits.scan_entries {
        fs::DirBuilder::new()
            .mode(0o700)
            .create(
                f.root
                    .join(".cerebro/workflows")
                    .join(format!("entry_{i:04}")),
            )
            .unwrap();
    }
    let page = DefinitionStore::list_existing(&f.root, None).unwrap();
    assert!(page.truncated);
    assert!(page.ids.len() <= limits.page_size);
}
#[test]
fn catalog_version_cap_never_blocks_exact_pinned_historical_lookup() {
    let f = Fixture::new();
    let store = f.store();
    let (mut draft, mut publication) = publish_first(&store);
    let mut hashes = vec![publication.definition_hash.clone()];
    let limit = crate::runtime::workflows::catalog_policy().versions_per_workflow;
    for i in 0..limit {
        draft = store
            .save_draft(&definition(&format!("Version {i}")), Some(&draft.etag))
            .unwrap();
        publication = store.publish(&draft, Some(publication.revision)).unwrap();
        hashes.push(publication.definition_hash.clone());
    }
    hashes.sort();
    let omitted = hashes.last().unwrap();
    let document = DefinitionStore::inspect_existing(&f.root, "flow_1").unwrap();
    assert_eq!(document.versions.len(), limit);
    assert!(document.versions_truncated);
    assert!(!document.versions.contains(omitted));
    assert_eq!(
        DefinitionStore::read_existing_version(&f.root, "flow_1", omitted)
            .unwrap()
            .definition_hash,
        *omitted
    );
}

// M98 Unpublish: real descriptor-backed files, no activation or run authority.
const UNPUBLISH_KEY: &str = "a1111111111111111111111111111111";
const OTHER_UNPUBLISH_KEY: &str = "b2222222222222222222222222222222";
fn write_v1_pointer(f: &Fixture, published: &PublicationRef) -> String {
    let bytes = serde_json::json!({
        "formatVersion": 1,
        "workflowId": published.workflow_id,
        "definitionHash": published.definition_hash,
        "revision": published.revision
    })
    .to_string();
    fs::write(f.pointer(), &bytes).unwrap();
    bytes
}
fn tombstone_bytes(published: &PublicationRef, revision: u64, transition: &str) -> String {
    serde_json::json!({
        "formatVersion": 2,
        "workflowId": published.workflow_id,
        "state": "unpublished",
        "revision": revision,
        "transitionId": transition,
        "previousDefinitionHash": published.definition_hash
    })
    .to_string()
}

#[test]
fn unpublish_legacy_v1_publication_read_is_nonmutating() {
    let f = Fixture::new();
    let store = f.store();
    let (_, published) = publish_first(&store);
    let bytes = write_v1_pointer(&f, &published);
    assert_eq!(store.read_publication().unwrap(), Some(published));
    assert_eq!(fs::read_to_string(f.pointer()).unwrap(), bytes);
}

#[test]
fn unpublish_v1_decoder_refuses_v2_before_interpreting_tombstone() {
    let f = Fixture::new();
    let store = f.store();
    let (_, published) = publish_first(&store);
    assert_eq!(
        decode_v1_pointer(&tombstone_bytes(&published, 2, UNPUBLISH_KEY)).unwrap_err(),
        FileError::InvalidDefinition(DefinitionError::UnsupportedFormat)
    );
}

#[test]
fn unpublish_never_published_state_is_revision_zero_without_pointer_write() {
    let f = Fixture::new();
    let store = f.store();
    let state = store.read_publication_state().unwrap();
    assert_eq!(
        state,
        PublicationState {
            revision: 0,
            publication: None,
            unpublished: None
        }
    );
    assert!(!f.pointer().exists());
}

#[test]
fn unpublish_clears_target_preserving_draft_and_pinned_version_bytes() {
    let f = Fixture::new();
    let store = f.store();
    let (_, published) = publish_first(&store);
    let draft_before = fs::read(f.workflow().join("draft.json")).unwrap();
    let version_path = f
        .workflow()
        .join("versions")
        .join(format!("{}.json", published.definition_hash));
    let version_before = fs::read(&version_path).unwrap();
    let edit = store.begin_publication_edit().unwrap();
    let removed = edit.unpublish(&published, UNPUBLISH_KEY).unwrap();
    assert_eq!(
        removed,
        UnpublicationRef {
            previous: published.clone(),
            revision: 2,
            transition_id: UNPUBLISH_KEY.into()
        }
    );
    assert_eq!(
        edit.read().unwrap(),
        PublicationState {
            revision: 2,
            publication: None,
            unpublished: Some(removed)
        }
    );
    drop(edit);
    assert_eq!(store.read_publication().unwrap(), None);
    assert_eq!(
        fs::read(f.workflow().join("draft.json")).unwrap(),
        draft_before
    );
    assert_eq!(fs::read(&version_path).unwrap(), version_before);
    assert_eq!(
        store
            .read_version(&published.definition_hash)
            .unwrap()
            .definition_hash,
        published.definition_hash
    );
    let pointer: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(f.pointer()).unwrap()).unwrap();
    assert_eq!(pointer["formatVersion"], 2);
    assert_eq!(pointer["state"], "unpublished");
    assert!(pointer.get("definitionHash").is_none());
}

#[test]
fn unpublish_republish_increments_revision_and_refuses_stale_old_target() {
    let f = Fixture::new();
    let store = f.store();
    let (draft, original) = publish_first(&store);
    let edit = store.begin_publication_edit().unwrap();
    let removed = edit.unpublish(&original, UNPUBLISH_KEY).unwrap();
    assert_eq!(edit.publish(&draft, None).unwrap_err(), FileError::Conflict);
    let second = edit.publish(&draft, Some(removed.revision)).unwrap();
    assert_eq!(second.revision, 3);
    let bytes = fs::read(f.pointer()).unwrap();
    assert_eq!(
        edit.unpublish(&original, OTHER_UNPUBLISH_KEY).unwrap_err(),
        FileError::Conflict
    );
    assert_eq!(fs::read(f.pointer()).unwrap(), bytes);
    assert_eq!(edit.read().unwrap().publication, Some(second));
}

#[test]
fn unpublish_same_transition_replays_without_revision_or_byte_change() {
    let f = Fixture::new();
    let store = f.store();
    let (_, original) = publish_first(&store);
    let edit = store.begin_publication_edit().unwrap();
    let first = edit.unpublish(&original, UNPUBLISH_KEY).unwrap();
    let bytes = fs::read(f.pointer()).unwrap();
    assert_eq!(edit.unpublish(&original, UNPUBLISH_KEY).unwrap(), first);
    assert_eq!(fs::read(f.pointer()).unwrap(), bytes);
    assert_eq!(
        edit.unpublish(&original, OTHER_UNPUBLISH_KEY).unwrap_err(),
        FileError::Conflict
    );
}

#[test]
fn unpublish_requires_exact_prior_hash_and_valid_transition_identity() {
    let f = Fixture::new();
    let store = f.store();
    let (_, original) = publish_first(&store);
    let bytes = fs::read(f.pointer()).unwrap();
    let edit = store.begin_publication_edit().unwrap();
    let mut foreign = original.clone();
    foreign.definition_hash = "f".repeat(64);
    assert_eq!(
        edit.unpublish(&foreign, UNPUBLISH_KEY).unwrap_err(),
        FileError::Conflict
    );
    assert_eq!(
        edit.unpublish(&original, "../bad").unwrap_err(),
        FileError::InvalidPath
    );
    assert_eq!(fs::read(f.pointer()).unwrap(), bytes);
}

#[test]
fn unpublish_counter_exhaustion_refuses_before_any_pointer_write() {
    let f = Fixture::new();
    let store = f.store();
    let (_, mut original) = publish_first(&store);
    original.revision = 9_007_199_254_740_991;
    let before = write_v1_pointer(&f, &original);
    let edit = store.begin_publication_edit().unwrap();
    assert_eq!(
        edit.unpublish(&original, UNPUBLISH_KEY).unwrap_err(),
        FileError::LimitExceeded
    );
    assert_eq!(fs::read_to_string(f.pointer()).unwrap(), before);
}

#[test]
fn unpublish_postrename_failure_retains_exact_tombstone_for_recovery() {
    let f = Fixture::new();
    let store = f.store();
    let (_, original) = publish_first(&store);
    let edit = store.begin_publication_edit().unwrap();
    assert_eq!(
        with_failure(FailPoint::AfterPointerRename, || edit
            .unpublish(&original, UNPUBLISH_KEY))
        .unwrap_err(),
        FileError::CommitUncertain
    );
    drop(edit);
    let recovered = store.read_publication_state().unwrap();
    assert_eq!(recovered.revision, 2);
    assert_eq!(recovered.publication, None);
    assert_eq!(recovered.unpublished.unwrap().previous, original);
    let retry = store.begin_publication_edit().unwrap();
    assert_eq!(
        retry.unpublish(&original, UNPUBLISH_KEY).unwrap().revision,
        2
    );
}

#[test]
fn unpublish_retained_edit_lock_excludes_other_publishers_until_released() {
    let f = Fixture::new();
    let first = f.store();
    let second = f.store();
    let (draft, original) = publish_first(&first);
    let edit = first.begin_publication_edit().unwrap();
    assert!(matches!(
        second.begin_publication_edit(),
        Err(FileError::Busy)
    ));
    assert_eq!(
        second.publish(&draft, Some(original.revision)).unwrap_err(),
        FileError::Busy
    );
    drop(edit);
    assert_eq!(
        second
            .publish(&draft, Some(original.revision))
            .unwrap()
            .revision,
        2
    );
}

#[test]
fn unpublish_existing_only_tombstone_read_never_creates_a_lock() {
    let f = Fixture::new();
    let store = f.store();
    let (_, original) = publish_first(&store);
    let bytes = tombstone_bytes(&original, 2, UNPUBLISH_KEY);
    fs::write(f.pointer(), &bytes).unwrap();
    fs::remove_file(f.workflow().join(".lock")).unwrap();
    let state = DefinitionStore::read_existing_publication_state(&f.root, "flow_1").unwrap();
    assert_eq!(state.revision, 2);
    assert_eq!(state.publication, None);
    assert_eq!(state.unpublished.unwrap().previous, original);
    assert!(!f.workflow().join(".lock").exists());
    assert_eq!(fs::read_to_string(f.pointer()).unwrap(), bytes);
}

#[test]
fn unpublish_malformed_or_foreign_tombstone_is_not_an_empty_publication() {
    let f = Fixture::new();
    let store = f.store();
    let (_, original) = publish_first(&store);
    let valid: serde_json::Value =
        serde_json::from_str(&tombstone_bytes(&original, 2, UNPUBLISH_KEY)).unwrap();
    for (field, value) in [
        ("workflowId", serde_json::json!("other_flow")),
        ("revision", serde_json::json!(0)),
        ("transitionId", serde_json::json!("bad")),
        ("previousDefinitionHash", serde_json::json!("f".repeat(64))),
        (
            "definitionHash",
            serde_json::json!(original.definition_hash),
        ),
    ] {
        let mut invalid = valid.clone();
        invalid[field] = value;
        let bytes = invalid.to_string();
        fs::write(f.pointer(), &bytes).unwrap();
        assert_eq!(
            store.read_publication_state().unwrap_err(),
            FileError::InvalidVersion,
            "field {field}"
        );
        assert_eq!(fs::read_to_string(f.pointer()).unwrap(), bytes);
    }
}

#[test]
fn unpublish_directory_replacement_cannot_clear_the_replacement_target() {
    let f = Fixture::new();
    let store = f.store();
    let (_, original) = publish_first(&store);
    let bytes = fs::read(f.pointer()).unwrap();
    let edit = store.begin_publication_edit().unwrap();
    let directory = f.workflow();
    let moved = f.root.join("original-moved");
    let foreign = f.root.join("foreign");
    fs::create_dir(&foreign).unwrap();
    let original_directory = directory.clone();
    let moved_hook = moved.clone();
    let foreign_hook = foreign.clone();
    let result = with_pointer_hook(
        move || {
            fs::rename(&original_directory, &moved_hook).unwrap();
            std::os::unix::fs::symlink(&foreign_hook, &original_directory).unwrap();
        },
        || edit.unpublish(&original, UNPUBLISH_KEY),
    );
    assert!(result.is_err());
    assert_eq!(fs::read(moved.join("published.json")).unwrap(), bytes);
    assert_eq!(fs::read_dir(foreign).unwrap().count(), 0);
}
