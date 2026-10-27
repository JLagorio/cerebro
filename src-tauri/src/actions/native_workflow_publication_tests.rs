//! Real retained RuntimeOwner + descriptor file guard. No native permit fixture.
use super::*;
use crate::actions::native_owner::{
    native_workflows::{activation_service, publication_service as service},
    RuntimeOwner,
};
use crate::runtime::workflow_activations as activation;
use crate::workflows::{native_definition, publication};
use std::{cell::Cell, rc::Rc};
const TRANSITION: &str = "dddddddddddddddddddddddddddddddd";
fn publication_facts(conn: &Db) -> OpeningFacts<'_> {
    OpeningFacts {
        canonical_vault: conn.dir.to_str().unwrap(),
        ..facts()
    }
}
fn publication_scope(conn: &Db) -> activation::Scope<'_> {
    let value = publication_facts(conn);
    activation::Scope {
        owner: value.owner,
        vault: value.vault,
        store: value.store,
        canonical_vault: value.canonical_vault,
    }
}
fn published() -> (Db, publication::Reference) {
    let conn = db();
    conn.execute(
        "UPDATE vault_registry SET vault_path=?1 WHERE vault_id=?2",
        params![conn.dir.to_str().unwrap(), VAULT],
    )
    .unwrap();
    let schema = r#"{"type":"object"}"#;
    let schema_digest = crate::actions::schema::workflow_schema_digest(schema).unwrap();
    let raw = serde_json::json!({
        "formatVersion":1,"workflowId":"publication","entryStepId":"done",
        "inputSchema":{"type":"object"},"inputSchemaDigest":schema_digest,"declaredActionDigests":[],
        "steps":[{"stepId":"done","label":"done","operation":{"kind":"result","output":{"kind":"input","path":[]}}}],
        "trigger":{"kind":"schedule","intervalSeconds":60,"catchUp":"skip_missed"},"authoredBy":"human:me"
    });
    let definition = native_definition::publish_fixture(&conn.dir, &raw.to_string(), "{}");
    let reference = publication::Reference {
        workflow_id: definition.workflow().into(),
        definition_hash: definition.version().into(),
        revision: 1,
    };
    let mut owner = RuntimeOwner::open_existing(&conn.dir).unwrap();
    activation_service::enable_owned_rows(
        &mut owner,
        publication_facts(&conn),
        activation_service::Enable {
            key: KEY,
            expected: 0,
            definition: &definition,
            permissions: &permissions(),
            now: time(),
        },
        || Ok(()),
    )
    .unwrap();
    (conn, reference)
}
fn pointer_bytes(conn: &Db) -> Vec<u8> {
    std::fs::read(
        conn.dir
            .join(".cerebro/workflows/publication/published.json"),
    )
    .unwrap()
}
fn journal_phase(conn: &Connection) -> Option<String> {
    use rusqlite::OptionalExtension;
    conn.query_row(
        "SELECT phase FROM workflow_activation_journal WHERE transition_id=?1",
        [TRANSITION],
        |row| row.get(0),
    )
    .optional()
    .unwrap()
}
fn prepared(conn: &Db, original: &publication::Reference) -> activation::PublicationTransition {
    tx(conn, |db| {
        activation::prepare_unpublish_rows(
            db,
            publication_scope(conn),
            TRANSITION,
            &original.workflow_id,
            original.revision,
            &original.definition_hash,
            time().timestamp_millis(),
        )
    })
    .unwrap()
}
fn call(
    owner: &mut RuntimeOwner,
    conn: &Db,
    edit: &publication::Edit<'_>,
    original: &publication::Reference,
    recheck: impl Fn() -> Result<(), flow::Error>,
) -> Result<publication::Unpublished, flow::Error> {
    service::unpublish_owned(
        owner,
        publication_facts(conn),
        edit,
        original,
        TRANSITION,
        time().timestamp_millis(),
        recheck,
    )
}
#[test]
fn publication_existing_open_does_not_create_an_absent_workflow() {
    let conn = db();
    let path = conn.dir.join(".cerebro/workflows/absent");
    assert!(publication::Directory::open_existing(&conn.dir, "absent").is_err());
    assert!(!path.exists());
}
#[test]
fn publication_retained_file_guard_observes_the_actual_pinned_target() {
    let (conn, original) = published();
    let directory = publication::Directory::open_existing(&conn.dir, "publication").unwrap();
    let edit = directory.edit().unwrap();
    assert_eq!(edit.root(), conn.dir.as_path());
    assert_eq!(edit.read().unwrap().publication, Some(original));
    assert!(matches!(directory.edit(), Err(publication::Error::Busy)));
}
#[test]
fn unpublish_original_owner_commits_pause_tombstone_and_reconciled_journal() {
    let (conn, original) = published();
    let directory = publication::Directory::open_existing(&conn.dir, "publication").unwrap();
    let edit = directory.edit().unwrap();
    let mut owner = RuntimeOwner::open_existing(&conn.dir).unwrap();
    let result = call(&mut owner, &conn, &edit, &original, || Ok(())).unwrap();
    assert_eq!(result.previous, original);
    assert_eq!(
        (result.revision, result.transition_id.as_str()),
        (2, TRANSITION)
    );
    assert_eq!(edit.read().unwrap().unpublished, Some(result));
    assert_eq!(journal_phase(&conn).as_deref(), Some("reconciled"));
    let current = tx(&conn, |db| {
        activation::inspect_rows(db, publication_scope(&conn), "publication")
    })
    .unwrap()
    .unwrap();
    assert_eq!(
        (current.state.as_str(), current.revision, current.held),
        ("paused", 2, false)
    );
    assert_eq!((count(&conn, "flow"), count(&conn, "grants")), (0, 0));
}
#[test]
fn unpublish_precommit_original_refusal_preserves_pointer_and_selection() {
    let (conn, original) = published();
    let before = pointer_bytes(&conn);
    let directory = publication::Directory::open_existing(&conn.dir, "publication").unwrap();
    let edit = directory.edit().unwrap();
    let mut owner = RuntimeOwner::open_existing(&conn.dir).unwrap();
    assert_eq!(
        call(&mut owner, &conn, &edit, &original, || Err(
            flow::Error::Denied
        )),
        Err(flow::Error::Denied)
    );
    assert_eq!(pointer_bytes(&conn), before);
    assert_eq!(journal_phase(&conn), None);
    assert_eq!(
        tx(&conn, |db| activation::inspect_rows(
            db,
            publication_scope(&conn),
            "publication"
        ))
        .unwrap()
        .unwrap()
        .state,
        "enabled"
    );
}
#[test]
fn unpublish_lost_prepare_ack_retires_owner_without_touching_publication() {
    let (conn, original) = published();
    let before = pointer_bytes(&conn);
    let directory = publication::Directory::open_existing(&conn.dir, "publication").unwrap();
    let edit = directory.edit().unwrap();
    let mut owner = RuntimeOwner::open_existing(&conn.dir).unwrap();
    let result = crate::actions::native_owner::tests::with_transaction_ack_probe(|| {
        crate::actions::native_owner::tests::lose_next_transaction_ack();
        call(&mut owner, &conn, &edit, &original, || Ok(()))
    });
    assert_eq!(result, Err(flow::Error::Unavailable));
    assert!(owner.retired);
    assert_eq!(pointer_bytes(&conn), before);
    assert_eq!(journal_phase(&conn).as_deref(), Some("prepared"));
    let current = tx(&conn, |db| {
        activation::inspect_rows(db, publication_scope(&conn), "publication")
    })
    .unwrap()
    .unwrap();
    assert_eq!((current.state.as_str(), current.held), ("paused", true));
}
#[test]
fn unpublish_source_loss_after_prepare_keeps_exact_old_pointer_held() {
    let (conn, original) = published();
    let before = pointer_bytes(&conn);
    let directory = publication::Directory::open_existing(&conn.dir, "publication").unwrap();
    let edit = directory.edit().unwrap();
    let mut owner = RuntimeOwner::open_existing(&conn.dir).unwrap();
    let current = Rc::new(Cell::new(true));
    let stopped = current.clone();
    let result = service::with_stage_hook(
        move |stage| {
            if stage == service::Stage::Prepared {
                stopped.set(false);
            }
        },
        || {
            call(&mut owner, &conn, &edit, &original, || {
                if current.get() {
                    Ok(())
                } else {
                    Err(flow::Error::Denied)
                }
            })
        },
    );
    assert_eq!(result, Err(flow::Error::Denied));
    assert_eq!(pointer_bytes(&conn), before);
    assert_eq!(journal_phase(&conn).as_deref(), Some("prepared"));
    let recovered = call(&mut owner, &conn, &edit, &original, || Ok(())).unwrap();
    assert_eq!(recovered.revision, 2);
    assert_eq!(journal_phase(&conn).as_deref(), Some("reconciled"));
}
#[test]
fn unpublish_cleared_file_recovers_exact_journal_after_source_loss() {
    let (conn, original) = published();
    let directory = publication::Directory::open_existing(&conn.dir, "publication").unwrap();
    let edit = directory.edit().unwrap();
    let mut owner = RuntimeOwner::open_existing(&conn.dir).unwrap();
    let current = Rc::new(Cell::new(true));
    let stopped = current.clone();
    let result = service::with_stage_hook(
        move |stage| {
            if stage == service::Stage::Cleared {
                stopped.set(false);
            }
        },
        || {
            call(&mut owner, &conn, &edit, &original, || {
                if current.get() {
                    Ok(())
                } else {
                    Err(flow::Error::Denied)
                }
            })
        },
    );
    assert_eq!(result, Err(flow::Error::Denied));
    let tombstone = edit.read().unwrap().unpublished.unwrap();
    let bytes = pointer_bytes(&conn);
    assert_eq!(journal_phase(&conn).as_deref(), Some("prepared"));
    assert_eq!(
        call(&mut owner, &conn, &edit, &original, || Ok(())).unwrap(),
        tombstone
    );
    assert_eq!(pointer_bytes(&conn), bytes);
    assert_eq!(journal_phase(&conn).as_deref(), Some("reconciled"));
}
#[test]
fn unpublish_lost_final_ack_keeps_finite_success_and_recovers_same_key() {
    let (conn, original) = published();
    let directory = publication::Directory::open_existing(&conn.dir, "publication").unwrap();
    let edit = directory.edit().unwrap();
    let mut owner = RuntimeOwner::open_existing(&conn.dir).unwrap();
    let result = crate::actions::native_owner::tests::with_transaction_ack_probe(|| {
        service::with_stage_hook(
            |stage| {
                if stage == service::Stage::Cleared {
                    crate::actions::native_owner::tests::lose_next_transaction_ack();
                }
            },
            || call(&mut owner, &conn, &edit, &original, || Ok(())),
        )
    });
    assert_eq!(result, Err(flow::Error::Unavailable));
    assert!(owner.retired);
    assert_eq!(journal_phase(&conn).as_deref(), Some("reconciled"));
    let bytes = pointer_bytes(&conn);
    let tombstone = edit.read().unwrap().unpublished.unwrap();
    let mut reopened = RuntimeOwner::open_existing(&conn.dir).unwrap();
    assert_eq!(
        call(&mut reopened, &conn, &edit, &original, || Ok(())).unwrap(),
        tombstone
    );
    assert_eq!(pointer_bytes(&conn), bytes);
}
#[test]
fn unpublish_known_final_ack_survives_later_original_source_loss() {
    let (conn, original) = published();
    let directory = publication::Directory::open_existing(&conn.dir, "publication").unwrap();
    let edit = directory.edit().unwrap();
    let mut owner = RuntimeOwner::open_existing(&conn.dir).unwrap();
    let current = Rc::new(Cell::new(true));
    let stopped = current.clone();
    let result = service::with_stage_hook(
        move |stage| {
            if stage == service::Stage::Reconciled {
                stopped.set(false);
            }
        },
        || {
            call(&mut owner, &conn, &edit, &original, || {
                if current.get() {
                    Ok(())
                } else {
                    Err(flow::Error::Denied)
                }
            })
        },
    );
    assert_eq!(result.unwrap().revision, 2);
    assert!(!current.get());
    assert_eq!(journal_phase(&conn).as_deref(), Some("reconciled"));
}
#[test]
fn unpublish_recovery_never_clears_a_newer_publication() {
    let (conn, original) = published();
    prepared(&conn, &original);
    let directory = publication::Directory::open_existing(&conn.dir, "publication").unwrap();
    let edit = directory.edit().unwrap();
    let draft = std::fs::read(conn.dir.join(".cerebro/workflows/publication/draft.json")).unwrap();
    let etag = crate::ledger::sha256_hex(&draft);
    let newer = edit.publish("publication", &etag, Some(1)).unwrap();
    assert_eq!(newer.revision, 2);
    let before = pointer_bytes(&conn);
    let mut owner = RuntimeOwner::open_existing(&conn.dir).unwrap();
    assert_eq!(
        call(&mut owner, &conn, &edit, &original, || Ok(())),
        Err(flow::Error::Conflict)
    );
    assert_eq!(pointer_bytes(&conn), before);
    assert_eq!(journal_phase(&conn).as_deref(), Some("prepared"));
}
#[test]
fn unpublish_matching_file_without_durable_prepare_cannot_invent_history() {
    let (conn, original) = published();
    let directory = publication::Directory::open_existing(&conn.dir, "publication").unwrap();
    let edit = directory.edit().unwrap();
    edit.unpublish(&original, TRANSITION).unwrap();
    let before = pointer_bytes(&conn);
    let mut owner = RuntimeOwner::open_existing(&conn.dir).unwrap();
    assert_eq!(
        call(&mut owner, &conn, &edit, &original, || Ok(())),
        Err(flow::Error::Denied)
    );
    assert_eq!(pointer_bytes(&conn), before);
    assert_eq!(journal_phase(&conn), None);
}
#[test]
fn unpublish_original_runtime_cannot_clear_another_vaults_identical_file() {
    let (conn, original) = published();
    let (other, same) = published();
    assert_eq!(same, original);
    let directory = publication::Directory::open_existing(&other.dir, "publication").unwrap();
    let edit = directory.edit().unwrap();
    let before = pointer_bytes(&other);
    let mut owner = RuntimeOwner::open_existing(&conn.dir).unwrap();
    assert_eq!(
        call(&mut owner, &conn, &edit, &original, || Ok(())),
        Err(flow::Error::Denied)
    );
    assert_eq!(pointer_bytes(&other), before);
    assert_eq!(journal_phase(&conn), None);
    assert_eq!(journal_phase(&other), None);
}

#[test]
fn pending_publication_exact_lookup_requires_an_existing_transaction() {
    let (conn, _) = published();
    assert_eq!(
        activation::pending_publication_for_rows(&conn, publication_scope(&conn), "publication"),
        Err(flow::Error::Unavailable)
    );
}
#[test]
fn pending_publication_exact_lookup_is_query_only_and_checks_original_path() {
    let (conn, original) = published();
    let expected = prepared(&conn, &original);
    conn.execute_batch("PRAGMA query_only=ON; BEGIN").unwrap();
    let found =
        activation::pending_publication_for_rows(&conn, publication_scope(&conn), "publication")
            .unwrap();
    assert_eq!(found, Some(expected));
    let wrong = activation::Scope {
        canonical_vault: "/another-original-path",
        ..publication_scope(&conn)
    };
    assert_eq!(
        activation::pending_publication_for_rows(&conn, wrong, "publication"),
        Err(flow::Error::Denied)
    );
    conn.execute_batch("ROLLBACK; PRAGMA query_only=OFF")
        .unwrap();
    assert_eq!(journal_phase(&conn).as_deref(), Some("prepared"));
}
#[test]
fn publish_recovery_finds_exact_workflow_beyond_first_pending_page() {
    let (conn, original) = published();
    prepared(&conn, &original);
    let limit = flow::execution_policy().reconciliation_batch;
    for index in 0..limit {
        tx(&conn, |db| {
            activation::prepare_unpublish_rows(
                db,
                publication_scope(&conn),
                &format!("{index:032x}"),
                &format!("earlier-{index}"),
                1,
                &original.definition_hash,
                time().timestamp_millis(),
            )
        })
        .unwrap();
    }
    let first = tx(&conn, |db| {
        activation::pending_publications_rows(db, publication_scope(&conn), None)
    })
    .unwrap();
    assert_eq!(first.items.len(), limit);
    assert!(first.next.is_some());
    assert!(!first
        .items
        .iter()
        .any(|item| item.workflow == "publication"));
    let directory = publication::Directory::open_existing(&conn.dir, "publication").unwrap();
    let edit = directory.edit().unwrap();
    let mut owner = RuntimeOwner::open_existing(&conn.dir).unwrap();
    assert!(service::recover_workflow_owned(
        &mut owner,
        publication_facts(&conn),
        &edit,
        "publication",
        time().timestamp_millis(),
        || Ok(())
    )
    .unwrap());
    assert_eq!(edit.read().unwrap().unpublished.unwrap().previous, original);
    assert_eq!(journal_phase(&conn).as_deref(), Some("reconciled"));
    let pending: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM workflow_activation_journal WHERE phase<>'reconciled'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(usize::try_from(pending).unwrap(), limit);
}
#[test]
fn pending_recovery_runs_when_prepare_left_zero_enabled_selections() {
    let (conn, original) = published();
    prepared(&conn, &original);
    let enabled: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM workflow_activations WHERE state='enabled'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(enabled, 0);
    let mut owner = RuntimeOwner::open_existing(&conn.dir).unwrap();
    let recovered = service::recover_pending_owned(
        &mut owner,
        publication_facts(&conn),
        &conn.dir,
        None,
        time().timestamp_millis(),
        || Ok(()),
    )
    .unwrap();
    assert_eq!(
        recovered,
        service::RecoveredPage {
            reconciled: 1,
            next: None
        }
    );
    assert_eq!(journal_phase(&conn).as_deref(), Some("reconciled"));
    let directory = publication::Directory::open_existing(&conn.dir, "publication").unwrap();
    assert_eq!(
        directory
            .edit()
            .unwrap()
            .read()
            .unwrap()
            .unpublished
            .unwrap()
            .previous,
        original
    );
    let selection = tx(&conn, |db| {
        activation::inspect_rows(db, publication_scope(&conn), "publication")
    })
    .unwrap()
    .unwrap();
    assert_eq!(
        (selection.state.as_str(), selection.held),
        ("paused", false)
    );
    assert_eq!(
        service::recover_pending_owned(
            &mut owner,
            publication_facts(&conn),
            &conn.dir,
            None,
            time().timestamp_millis(),
            || Ok(())
        )
        .unwrap(),
        service::RecoveredPage {
            reconciled: 0,
            next: None
        }
    );
    assert_eq!((count(&conn, "flow"), count(&conn, "grants")), (0, 0));
}
#[test]
fn pending_recovery_refuses_lost_original_before_any_file_change() {
    let (conn, original) = published();
    prepared(&conn, &original);
    let before = pointer_bytes(&conn);
    let mut owner = RuntimeOwner::open_existing(&conn.dir).unwrap();
    assert_eq!(
        service::recover_pending_owned(
            &mut owner,
            publication_facts(&conn),
            &conn.dir,
            None,
            time().timestamp_millis(),
            || Err(flow::Error::Denied)
        ),
        Err(flow::Error::Denied)
    );
    assert_eq!(pointer_bytes(&conn), before);
    assert_eq!(journal_phase(&conn).as_deref(), Some("prepared"));
}
#[test]
fn pending_recovery_returns_a_bounded_continuation_without_dropping_later_work() {
    let (conn, original) = published();
    let mut source: serde_json::Value = serde_json::from_slice(
        &std::fs::read(conn.dir.join(".cerebro/workflows/publication/draft.json")).unwrap(),
    )
    .unwrap();
    let limit = flow::execution_policy().reconciliation_batch;
    for index in 0..=limit {
        let workflow = format!("recover-{index}");
        source["workflowId"] = serde_json::Value::String(workflow.clone());
        let definition = native_definition::publish_fixture(&conn.dir, &source.to_string(), "{}");
        tx(&conn, |db| {
            activation::prepare_unpublish_rows(
                db,
                publication_scope(&conn),
                &format!("{index:032x}"),
                &workflow,
                1,
                definition.version(),
                time().timestamp_millis(),
            )
        })
        .unwrap();
    }
    let mut owner = RuntimeOwner::open_existing(&conn.dir).unwrap();
    let first = service::recover_pending_owned(
        &mut owner,
        publication_facts(&conn),
        &conn.dir,
        None,
        time().timestamp_millis(),
        || Ok(()),
    )
    .unwrap();
    assert_eq!(first.reconciled, limit);
    assert!(first.next.is_some());
    let left: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM workflow_activation_journal WHERE phase<>'reconciled'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(left, 1);
    let second = service::recover_pending_owned(
        &mut owner,
        publication_facts(&conn),
        &conn.dir,
        first.next.as_deref(),
        time().timestamp_millis(),
        || Ok(()),
    )
    .unwrap();
    assert_eq!(
        second,
        service::RecoveredPage {
            reconciled: 1,
            next: None
        }
    );
    let original_directory =
        publication::Directory::open_existing(&conn.dir, "publication").unwrap();
    assert_eq!(
        original_directory
            .edit()
            .unwrap()
            .read()
            .unwrap()
            .publication,
        Some(original)
    );
}
#[test]
fn reconciled_unpublish_ack_is_historical_after_a_newer_publication() {
    let (conn, original) = published();
    let directory = publication::Directory::open_existing(&conn.dir, "publication").unwrap();
    let edit = directory.edit().unwrap();
    let mut owner = RuntimeOwner::open_existing(&conn.dir).unwrap();
    call(&mut owner, &conn, &edit, &original, || Ok(())).unwrap();
    let draft = std::fs::read(conn.dir.join(".cerebro/workflows/publication/draft.json")).unwrap();
    let newer = edit
        .publish("publication", &crate::ledger::sha256_hex(&draft), Some(2))
        .unwrap();
    let before = pointer_bytes(&conn);
    let replay = service::complete_owned(
        &mut owner,
        publication_facts(&conn),
        &edit,
        &original,
        TRANSITION,
        time().timestamp_millis(),
        || Ok(()),
    )
    .unwrap();
    assert!(replay.replayed);
    assert_eq!(replay.value.previous, original);
    assert_eq!(replay.value.revision, 2);
    assert_eq!(pointer_bytes(&conn), before);
    assert_eq!(edit.read().unwrap().publication, Some(newer));
}

fn enable_publication(
    owner: &mut RuntimeOwner,
    conn: &Db,
    edit: &publication::Edit<'_>,
    definition: &native_definition::NativeDefinition,
    key: &str,
    expected: u64,
) -> Result<activation::Changed, flow::Error> {
    activation_service::enable_published_owned(
        owner,
        publication_facts(conn),
        edit,
        activation_service::Enable {
            key,
            expected,
            definition,
            permissions: &permissions(),
            now: time(),
        },
        || Ok(()),
        |_, value| Ok(value),
    )
}
#[test]
fn fresh_enable_cannot_reactivate_a_reconciled_unpublished_version() {
    let (conn, original) = published();
    let directory = publication::Directory::open_existing(&conn.dir, "publication").unwrap();
    let edit = directory.edit().unwrap();
    let mut owner = RuntimeOwner::open_existing(&conn.dir).unwrap();
    call(&mut owner, &conn, &edit, &original, || Ok(())).unwrap();
    let historical = native_definition::NativeDefinition::load(
        &conn.dir,
        "publication",
        &original.definition_hash,
        "{}",
    )
    .unwrap();
    let before = tx(&conn, |db| {
        activation::inspect_rows(db, publication_scope(&conn), "publication")
    })
    .unwrap()
    .unwrap();
    assert_eq!((before.state.as_str(), before.held), ("paused", false));
    assert_eq!(
        enable_publication(&mut owner, &conn, &edit, &historical, &"e".repeat(32), 2),
        Err(flow::Error::Denied)
    );
    assert_eq!(
        tx(&conn, |db| activation::inspect_rows(
            db,
            publication_scope(&conn),
            "publication"
        ))
        .unwrap()
        .unwrap(),
        before
    );
    assert_eq!(edit.read().unwrap().revision, 2);
    assert_eq!((count(&conn, "flow"), count(&conn, "grants")), (0, 0));
}
#[test]
fn original_enable_replay_after_unpublish_stays_observational() {
    let (conn, original) = published();
    let directory = publication::Directory::open_existing(&conn.dir, "publication").unwrap();
    let edit = directory.edit().unwrap();
    let mut owner = RuntimeOwner::open_existing(&conn.dir).unwrap();
    call(&mut owner, &conn, &edit, &original, || Ok(())).unwrap();
    let historical = native_definition::NativeDefinition::load(
        &conn.dir,
        "publication",
        &original.definition_hash,
        "{}",
    )
    .unwrap();
    let before = tx(&conn, |db| {
        activation::inspect_rows(db, publication_scope(&conn), "publication")
    })
    .unwrap()
    .unwrap();
    let replay = enable_publication(&mut owner, &conn, &edit, &historical, KEY, 0).unwrap();
    assert!(replay.replayed);
    assert_eq!(replay.current, before);
    assert_eq!(
        (replay.receipt.state.as_str(), replay.receipt.revision),
        ("enabled", 1)
    );
    assert_eq!(edit.read().unwrap().revision, 2);
    assert_eq!((count(&conn, "flow"), count(&conn, "grants")), (0, 0));
}
#[test]
fn explicitly_republished_version_can_be_enabled_after_tombstone() {
    let (conn, original) = published();
    let directory = publication::Directory::open_existing(&conn.dir, "publication").unwrap();
    let edit = directory.edit().unwrap();
    let mut owner = RuntimeOwner::open_existing(&conn.dir).unwrap();
    call(&mut owner, &conn, &edit, &original, || Ok(())).unwrap();
    let draft = std::fs::read(conn.dir.join(".cerebro/workflows/publication/draft.json")).unwrap();
    let republished = edit
        .publish("publication", &crate::ledger::sha256_hex(&draft), Some(2))
        .unwrap();
    assert_eq!(republished.revision, 3);
    let definition = native_definition::NativeDefinition::load(
        &conn.dir,
        "publication",
        &republished.definition_hash,
        "{}",
    )
    .unwrap();
    let enabled =
        enable_publication(&mut owner, &conn, &edit, &definition, &"e".repeat(32), 2).unwrap();
    assert!(!enabled.replayed);
    assert_eq!(
        (enabled.current.state.as_str(), enabled.current.revision),
        ("enabled", 3)
    );
    assert_eq!(edit.read().unwrap().publication, Some(republished));
    assert_eq!((count(&conn, "flow"), count(&conn, "grants")), (0, 0));
}
#[test]
fn fresh_enable_refuses_a_version_superseded_by_current_publication() {
    let (conn, original) = published();
    use crate::workflows::{
        document_service,
        transport::{WorkflowContext, WorkflowPublishRequest, WorkflowSaveRequest},
    };
    let context = WorkflowContext {
        vault_id: facts().vault.into(),
        store_uuid: facts().store.into(),
    };
    let document = document_service::document(&conn.dir, context.clone(), "publication").unwrap();
    let saved = document.draft.unwrap();
    let mut draft = saved.draft;
    draft.steps[0].label = "New published result".into();
    let saved = document_service::save(
        &conn.dir,
        &WorkflowSaveRequest {
            context: context.clone(),
            draft,
            expected_etag: Some(saved.etag),
        },
        "human:me",
    )
    .unwrap();
    let current = document_service::publish(
        &conn.dir,
        &WorkflowPublishRequest {
            context,
            workflow_id: "publication".into(),
            expected_draft_etag: saved.etag,
            expected_publication_revision: Some(crate::actions::SafeCounter::new(1).unwrap()),
        },
    )
    .unwrap();
    assert_ne!(current.version.definition_hash, original.definition_hash);
    let directory = publication::Directory::open_existing(&conn.dir, "publication").unwrap();
    let edit = directory.edit().unwrap();
    let mut owner = RuntimeOwner::open_existing(&conn.dir).unwrap();
    let historical = native_definition::NativeDefinition::load(
        &conn.dir,
        "publication",
        &original.definition_hash,
        "{}",
    )
    .unwrap();
    let before = tx(&conn, |db| {
        activation::inspect_rows(db, publication_scope(&conn), "publication")
    })
    .unwrap()
    .unwrap();
    assert_eq!(
        enable_publication(&mut owner, &conn, &edit, &historical, &"e".repeat(32), 1),
        Err(flow::Error::Denied)
    );
    assert_eq!(
        tx(&conn, |db| activation::inspect_rows(
            db,
            publication_scope(&conn),
            "publication"
        ))
        .unwrap()
        .unwrap(),
        before
    );
    assert_eq!(
        edit.read().unwrap().publication.unwrap().definition_hash,
        current.version.definition_hash
    );
}
