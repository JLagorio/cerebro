//! Real retained-runtime fixtures; these do not authenticate an AppKit gesture.
use super::*;
use crate::actions::ids::{AttemptId, ConnectionId};
use crate::connections::{
    account_metadata::{MetadataOperation as Op, MetadataOutcome as Out},
    accounts::ConnectionService,
    secrets::UnsupportedSecretStore,
    AcquisitionState, AttendedPerson, ConnectionError, ConnectionHealth, GhSelection,
};
use rusqlite::params;
use std::fs;

struct Fixture {
    path: PathBuf,
    ordinary: Connection,
    owner: RuntimeOwner,
}
impl Fixture {
    fn new(name: &str) -> Self {
        let path = crate::vault::testutil::temp_vault(name)
            .canonicalize()
            .unwrap();
        let ordinary = crate::runtime::open(&path).unwrap();
        let owner = RuntimeOwner::open_existing(&path).unwrap();
        Self {
            path,
            ordinary,
            owner,
        }
    }
    fn rows(&self, table: &str) -> i64 {
        let query = match table {
            "connections" => "SELECT count(*) FROM managed_connections",
            "attempts" => "SELECT count(*) FROM managed_connection_attempts",
            "grants" => "SELECT count(*) FROM action_account_grants",
            "cleanup" => "SELECT count(*) FROM managed_secret_cleanup",
            _ => panic!("fixed table selector"),
        };
        self.ordinary.query_row(query, [], |r| r.get(0)).unwrap()
    }
    fn raw_status(&self) -> serde_json::Value {
        let raw: String = self
            .ordinary
            .query_row(
                "SELECT status FROM managed_connections WHERE connection_id=?1 AND person=?2",
                params![
                    selection().connection_id.0,
                    super::super::native_rules::admission_rules().owner_storage_key
                ],
                |r| r.get(0),
            )
            .unwrap();
        serde_json::from_str(&raw).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}
fn selection() -> GhSelection {
    GhSelection {
        connection_id: ConnectionId("native-account-one".into()),
        host: "github.com".into(),
        login: "alice".into(),
    }
}
fn status(outcome: Out) -> crate::connections::ConnectionStatus {
    match outcome {
        Out::Status(value) => value,
        _ => panic!("expected status"),
    }
}
fn acquisition(outcome: Out) -> crate::connections::CredentialAcquisition {
    match outcome {
        Out::Acquisition(value) => value,
        _ => panic!("expected acquisition"),
    }
}
fn connect(f: &mut Fixture) -> crate::connections::ConnectionStatus {
    status(
        f.owner
            .account_metadata(Op::Connect {
                selection: &selection(),
            })
            .unwrap(),
    )
}
fn begin(f: &mut Fixture, revision: u64) -> crate::connections::CredentialAcquisition {
    acquisition(
        f.owner
            .account_metadata(Op::BeginImport {
                selection: &selection(),
                expected: revision,
            })
            .unwrap(),
    )
}

#[test]
fn native_account_legacy_metadata_control_uses_no_secret_adapter() {
    let mut f = Fixture::new("m96-account-legacy-control");
    let store = UnsupportedSecretStore;
    let mut legacy = ConnectionService {
        conn: &mut f.ordinary,
        store: &store,
    };
    let person = AttendedPerson::at_native_door("human:legacy-fixture").unwrap();
    let first = legacy.connect(&person, &selection()).unwrap();
    let attempt = legacy
        .begin_gh_import(&person, &selection(), first.revision)
        .unwrap();
    assert_eq!(attempt.state, AcquisitionState::Pending);
    assert_eq!(
        legacy
            .cancel_credential_acquisition(&person, &attempt.attempt_id)
            .unwrap()
            .state,
        AcquisitionState::Cancelled
    );
    assert_eq!(f.rows("connections"), 1);
    assert_eq!(f.rows("grants"), 0);
    assert_eq!(f.rows("cleanup"), 0);
}
#[test]
fn native_account_connect_uses_retained_runtime_and_fixed_owner_without_granting() {
    let mut f = Fixture::new("m96-account-connect");
    let first = connect(&mut f);
    assert_eq!(first.health, ConnectionHealth::SignInRequired);
    assert_eq!(first.revision, 1);
    assert!(first.account.is_none());
    let person: String = f
        .ordinary
        .query_row("SELECT person FROM managed_connections", [], |r| r.get(0))
        .unwrap();
    assert_eq!(
        person,
        super::super::native_rules::admission_rules().owner_storage_key
    );
    assert_eq!(f.rows("connections"), 1);
    assert_eq!(f.rows("attempts"), 0);
    assert_eq!(f.rows("grants"), 0);
    assert_eq!(f.rows("cleanup"), 0);
}
#[test]
fn native_account_import_requires_exact_selected_host_and_login_before_writes() {
    let mut f = Fixture::new("m96-account-selection");
    let first = connect(&mut f);
    let mut wrong = selection();
    wrong.host = "elsewhere.invalid".into();
    assert_eq!(
        f.owner.account_metadata(Op::BeginImport {
            selection: &wrong,
            expected: first.revision
        }),
        Err(ConnectionError::Unsupported)
    );
    wrong = selection();
    wrong.login = "someone-else".into();
    assert_eq!(
        f.owner.account_metadata(Op::BeginImport {
            selection: &wrong,
            expected: first.revision
        }),
        Err(ConnectionError::InvalidSelection)
    );
    assert_eq!(f.rows("attempts"), 0);
    assert_eq!(f.raw_status()["revision"], 1);
    let admitted = begin(&mut f, first.revision);
    assert_eq!(admitted.login, "alice");
    assert_eq!(admitted.host, "github.com");
    assert_eq!(admitted.state, AcquisitionState::Pending);
}
#[test]
fn native_account_metadata_owner_filter_does_not_adopt_another_persons_connection() {
    let mut f = Fixture::new("m96-account-other-person");
    let store = UnsupportedSecretStore;
    let person = AttendedPerson::at_native_door("human:other-person").unwrap();
    let initial = ConnectionService {
        conn: &mut f.ordinary,
        store: &store,
    }
    .connect(&person, &selection())
    .unwrap();
    let before: String = f
        .ordinary
        .query_row("SELECT status FROM managed_connections", [], |r| r.get(0))
        .unwrap();
    assert_eq!(
        f.owner.account_metadata(Op::BeginImport {
            selection: &selection(),
            expected: initial.revision
        }),
        Err(ConnectionError::NotFound)
    );
    assert_eq!(f.rows("attempts"), 0);
    let after: String = f
        .ordinary
        .query_row("SELECT status FROM managed_connections", [], |r| r.get(0))
        .unwrap();
    assert_eq!(before, after);
}
#[test]
fn native_account_two_retained_writers_consume_one_expected_revision() {
    let mut f = Fixture::new("m96-account-cas");
    let first = connect(&mut f);
    let mut other = RuntimeOwner::open_existing(&f.path).unwrap();
    let ticket = begin(&mut f, first.revision);
    assert_eq!(
        other.account_metadata(Op::BeginImport {
            selection: &selection(),
            expected: first.revision
        }),
        Err(ConnectionError::StaleRevision)
    );
    assert_eq!(f.rows("attempts"), 1);
    assert_eq!(f.raw_status()["revision"], ticket.expected_revision);
}
#[test]
fn native_account_cancelled_old_attempt_does_not_cancel_its_replacement() {
    let mut f = Fixture::new("m96-account-cancel-cas");
    let first = connect(&mut f);
    let old = begin(&mut f, first.revision);
    let next = begin(&mut f, old.expected_revision);
    let cancelled = acquisition(
        f.owner
            .account_metadata(Op::CancelImport {
                attempt: &old.attempt_id,
            })
            .unwrap(),
    );
    assert_eq!(cancelled.state, AcquisitionState::Cancelled);
    let active: String = f
        .ordinary
        .query_row("SELECT active_attempt FROM managed_connections", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(active, next.attempt_id.0);
    assert_eq!(f.raw_status()["revision"], next.expected_revision);
    let ended = acquisition(
        f.owner
            .account_metadata(Op::CancelImport {
                attempt: &AttemptId(active),
            })
            .unwrap(),
    );
    assert_eq!(ended.state, AcquisitionState::Cancelled);
    assert_eq!(f.raw_status()["revision"], next.expected_revision + 1);
}
#[test]
fn native_account_disable_cancels_pending_and_reconnect_requires_current_revision() {
    let mut f = Fixture::new("m96-account-disable");
    let first = connect(&mut f);
    let pending = begin(&mut f, first.revision);
    let disabled = status(
        f.owner
            .account_metadata(Op::Disable {
                connection: &selection().connection_id,
                expected: pending.expected_revision,
            })
            .unwrap(),
    );
    assert_eq!(disabled.health, ConnectionHealth::Disabled);
    assert_eq!(disabled.revocation_generation, 1);
    assert_eq!(f.raw_status()["health"], "disabled");
    let raw: String = f
        .ordinary
        .query_row("SELECT payload FROM managed_connection_attempts", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&raw).unwrap()["state"],
        "cancelled"
    );
    assert_eq!(
        f.owner.account_metadata(Op::Reconnect {
            connection: &selection().connection_id,
            expected: pending.expected_revision
        }),
        Err(ConnectionError::StaleRevision)
    );
    let current = status(
        f.owner
            .account_metadata(Op::Reconnect {
                connection: &selection().connection_id,
                expected: disabled.revision,
            })
            .unwrap(),
    );
    assert_eq!(current.health, ConnectionHealth::SignInRequired);
    assert_eq!(
        current.revocation_generation,
        disabled.revocation_generation
    );
    assert_eq!(f.rows("grants"), 0);
}
#[test]
fn native_account_same_byte_runtime_replacement_retires_the_writer_without_reopening() {
    let mut f = Fixture::new("m96-account-runtime-replacement");
    let first = connect(&mut f);
    f.ordinary
        .execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
        .unwrap();
    let path = crate::runtime::runtime_db_path(&f.path);
    let old = f.path.join("runtime.original.db");
    let replacement = f.path.join("runtime.replacement.db");
    fs::copy(&path, &replacement).unwrap();
    fs::rename(&path, &old).unwrap();
    fs::rename(&replacement, &path).unwrap();
    assert_eq!(
        f.owner.account_metadata(Op::BeginImport {
            selection: &selection(),
            expected: first.revision
        }),
        Err(ConnectionError::Unavailable)
    );
    fs::remove_file(&path).unwrap();
    fs::rename(&old, &path).unwrap();
    assert_eq!(
        f.owner.account_metadata(Op::BeginImport {
            selection: &selection(),
            expected: first.revision
        }),
        Err(ConnectionError::Unavailable)
    );
    assert_eq!(f.rows("attempts"), 0);
    assert_eq!(f.raw_status()["revision"], first.revision);
}
// APPEND ONLY to actions/native_account_tests.rs if root registers a future
// bounded-attempt acceptance RED. No worker execution or registered edit.
// This deliberately corrupts ONLY the disposable fixture, matching the existing
// metadata_tests corruption-fixture convention. Normal schema refusal is a control.
#[test]
fn native_account_corrupt_oversize_attempt_is_unavailable_before_metadata_mutation() {
    let mut f = Fixture::new("m96-account-corrupt-large-attempt");
    let first = connect(&mut f);
    let pending = begin(&mut f, first.revision);
    let mut value = serde_json::to_value(&pending).unwrap();
    // An unknown field is intentional: ordinary serde silently drops it, so
    // today's UPDATE can succeed after allocating the over-cap source String.
    value["corruptionPadding"] = serde_json::json!("x".repeat(128 * 1024));
    let oversized = serde_json::to_string(&value).unwrap();
    let schema_rejected = f
        .ordinary
        .execute(
            "UPDATE managed_connection_attempts SET payload=?1 WHERE attempt_id=?2",
            rusqlite::params![oversized, pending.attempt_id.0],
        )
        .is_err();
    f.ordinary
        .pragma_update(None, "ignore_check_constraints", true)
        .unwrap();
    f.ordinary
        .execute(
            "UPDATE managed_connection_attempts SET payload=?1 WHERE attempt_id=?2",
            rusqlite::params![oversized, pending.attempt_id.0],
        )
        .unwrap();
    f.ordinary
        .pragma_update(None, "ignore_check_constraints", false)
        .unwrap();
    let before_status = f.raw_status();
    let result = f.owner.account_metadata(Op::CancelImport {
        attempt: &pending.attempt_id,
    });
    let after_payload: String = f
        .ordinary
        .query_row(
            "SELECT payload FROM managed_connection_attempts WHERE attempt_id=?1",
            [&pending.attempt_id.0],
            |row| row.get(0),
        )
        .unwrap();
    let after_status = f.raw_status();
    let active: Option<String> = f
        .ordinary
        .query_row(
            "SELECT active_attempt FROM managed_connections WHERE connection_id=?1",
            [&pending.connection_id.0],
            |row| row.get(0),
        )
        .unwrap();
    drop(f);
    assert!(
        schema_rejected,
        "normal V32 fixture must reject over-limit JSON"
    );
    assert_eq!(result, Err(ConnectionError::Unavailable));
    assert_eq!(after_payload, oversized, "unavailable input was rewritten");
    assert_eq!(
        after_status, before_status,
        "unavailable input changed account revision"
    );
    assert_eq!(active.as_deref(), Some(pending.attempt_id.0.as_str()));
}
// Standalone corrupted-row negative; real RuntimeOwner and actual replaced A/B.
// Normal V32 rejects this payload/physical-row mismatch. Only this disposable
// fixture bypasses CHECKs to establish the reader's independent fail-closed gate.
#[test]
fn native_account_corrupt_old_attempt_cannot_cancel_its_replacement_payload() {
    let mut f = Fixture::new("m96-account-corrupt-crosswired-attempt");
    let first = connect(&mut f);
    let old = begin(&mut f, first.revision);
    let replacement = begin(&mut f, old.expected_revision);
    let borrowed = serde_json::to_string(&replacement).unwrap();
    let schema_rejected = f
        .ordinary
        .execute(
            "UPDATE managed_connection_attempts SET payload=?1 WHERE attempt_id=?2",
            rusqlite::params![borrowed, old.attempt_id.0],
        )
        .is_err();
    f.ordinary
        .pragma_update(None, "ignore_check_constraints", true)
        .unwrap();
    f.ordinary
        .execute(
            "UPDATE managed_connection_attempts SET payload=?1 WHERE attempt_id=?2",
            rusqlite::params![borrowed, old.attempt_id.0],
        )
        .unwrap();
    f.ordinary
        .pragma_update(None, "ignore_check_constraints", false)
        .unwrap();
    let payload = |id: &AttemptId| -> String {
        f.ordinary
            .query_row(
                "SELECT payload FROM managed_connection_attempts WHERE attempt_id=?1",
                [&id.0],
                |row| row.get(0),
            )
            .unwrap()
    };
    let before_old = payload(&old.attempt_id);
    let before_replacement = payload(&replacement.attempt_id);
    let before_status = f.raw_status();
    let before_active: Option<String> = f
        .ordinary
        .query_row(
            "SELECT active_attempt FROM managed_connections WHERE connection_id=?1",
            [&old.connection_id.0],
            |row| row.get(0),
        )
        .unwrap();
    let result = f.owner.account_metadata(Op::CancelImport {
        attempt: &old.attempt_id,
    });
    let after_old: String = f
        .ordinary
        .query_row(
            "SELECT payload FROM managed_connection_attempts WHERE attempt_id=?1",
            [&old.attempt_id.0],
            |row| row.get(0),
        )
        .unwrap();
    let after_replacement: String = f
        .ordinary
        .query_row(
            "SELECT payload FROM managed_connection_attempts WHERE attempt_id=?1",
            [&replacement.attempt_id.0],
            |row| row.get(0),
        )
        .unwrap();
    let after_status = f.raw_status();
    let after_active: Option<String> = f
        .ordinary
        .query_row(
            "SELECT active_attempt FROM managed_connections WHERE connection_id=?1",
            [&old.connection_id.0],
            |row| row.get(0),
        )
        .unwrap();
    drop(f);
    assert!(
        schema_rejected,
        "normal V32 must reject payload/physical-row identity mismatch"
    );
    assert_eq!(result, Err(ConnectionError::Unavailable));
    assert_eq!(after_old, before_old, "corrupt original row was changed");
    assert_eq!(
        after_replacement, before_replacement,
        "old attempt cancelled its replacement"
    );
    assert_eq!(
        after_active, before_active,
        "active ticket changed after unavailable read"
    );
    assert_eq!(
        after_active.as_deref(),
        Some(replacement.attempt_id.0.as_str())
    );
    assert_eq!(
        after_status, before_status,
        "account status changed after unavailable read"
    );
}
