use super::accounts::{ConnectionService, ValidatedCredential};
use super::secrets::{SecretRef, SecretStore, SecretValue};
use super::test_support::{BeforePut, FakeGh, FakeIdentity, FakeStore, SENTINEL};
use super::*;
use std::cell::{Cell, RefCell};

struct Db {
    dir: std::path::PathBuf,
    conn: rusqlite::Connection,
}
impl Db {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("cerebro-connections-{}", opaque_id()));
        std::fs::create_dir_all(&dir).unwrap();
        let conn = crate::runtime::open(&dir).unwrap();
        Self { dir, conn }
    }
}
impl Drop for Db {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}
fn person() -> AttendedPerson {
    AttendedPerson::at_native_door("human:owner").unwrap()
}
fn selected() -> GhSelection {
    GhSelection {
        connection_id: ConnectionId("test-connection".into()),
        host: "github.com".into(),
        login: "alice".into(),
    }
}
fn credential(subject: &str) -> ValidatedCredential {
    ValidatedCredential {
        login: "alice".into(),
        issuer: "https://github.com".into(),
        subject: subject.into(),
        scope_digest: digest(b"repo"),
        secret: SecretValue::from_bytes(SENTINEL.as_bytes().to_vec()).unwrap(),
    }
}
fn install(s: &mut ConnectionService<'_>, revision: u64, subject: &str) -> ConnectionStatus {
    let a = s.begin_gh_import(&person(), &selected(), revision).unwrap();
    s.complete_import(&person(), &a, credential(subject))
        .unwrap()
}

// A secret replacement must not invalidate approvals bound to the same account identity.
#[test]
fn token_refresh_keeps_account_revision() {
    let mut db = Db::new();
    let store = FakeStore::default();
    let mut s = ConnectionService {
        conn: &mut db.conn,
        store: &store,
    };
    let initial = s.connect(&person(), &selected()).unwrap();
    let first = install(&mut s, initial.revision, "123");
    let next = install(&mut s, first.revision, "123");
    assert_eq!(first.account, next.account);
    assert_eq!(next.secret_revision, 2);
    assert_eq!(store.items.borrow().len(), 1);
}
#[test]
fn changed_subject_invalidates_binding() {
    let mut db = Db::new();
    let store = FakeStore::default();
    let mut s = ConnectionService {
        conn: &mut db.conn,
        store: &store,
    };
    let initial = s.connect(&person(), &selected()).unwrap();
    let first = install(&mut s, initial.revision, "123");
    let next = install(&mut s, first.revision, "456");
    assert_eq!(next.account.as_ref().unwrap().account_revision, 2);
    assert_ne!(
        first.account.unwrap().account_id,
        next.account.unwrap().account_id
    );
}
#[test]
fn issuer_change_never_reuses_secret() {
    let mut db = Db::new();
    let store = FakeStore::default();
    let mut s = ConnectionService {
        conn: &mut db.conn,
        store: &store,
    };
    let initial = s.connect(&person(), &selected()).unwrap();
    let first = install(&mut s, initial.revision, "123");
    let a = s
        .begin_gh_import(&person(), &selected(), first.revision)
        .unwrap();
    let mut c = credential("123");
    c.issuer = "https://evil.example".into();
    assert_eq!(
        s.complete_import(&person(), &a, c),
        Err(ConnectionError::IdentityMismatch)
    );
    assert_eq!(store.items.borrow().len(), 1);
}
#[test]
fn cancelled_import_cannot_commit() {
    let mut db = Db::new();
    let store = FakeStore::default();
    let mut s = ConnectionService {
        conn: &mut db.conn,
        store: &store,
    };
    let initial = s.connect(&person(), &selected()).unwrap();
    let a = s
        .begin_gh_import(&person(), &selected(), initial.revision)
        .unwrap();
    assert_eq!(
        s.cancel_credential_acquisition(&person(), &a.attempt_id)
            .unwrap()
            .state,
        AcquisitionState::Cancelled
    );
    assert_eq!(
        s.complete_import(&person(), &a, credential("123")),
        Err(ConnectionError::Cancelled)
    );
    assert!(store.items.borrow().is_empty());
}
#[test]
fn revoke_during_import_cannot_resurrect() {
    let mut db = Db::new();
    let store = FakeStore::default();
    let mut s = ConnectionService {
        conn: &mut db.conn,
        store: &store,
    };
    let initial = s.connect(&person(), &selected()).unwrap();
    let a = s
        .begin_gh_import(&person(), &selected(), initial.revision)
        .unwrap();
    s.revoke(&person(), &selected().connection_id, a.expected_revision)
        .unwrap();
    assert!(s.complete_import(&person(), &a, credential("123")).is_err());
    assert_eq!(
        s.status(&person(), &selected().connection_id)
            .unwrap()
            .health,
        ConnectionHealth::Disabled
    );
    assert!(store.items.borrow().is_empty());
}
#[test]
fn late_refresh_cannot_overwrite_reconnect() {
    let mut db = Db::new();
    let store = FakeStore::default();
    let mut s = ConnectionService {
        conn: &mut db.conn,
        store: &store,
    };
    let initial = s.connect(&person(), &selected()).unwrap();
    let old = s
        .begin_gh_import(&person(), &selected(), initial.revision)
        .unwrap();
    let reconnected = s
        .reconnect(&person(), &selected().connection_id, old.expected_revision)
        .unwrap();
    let installed = install(&mut s, reconnected.revision, "456");
    assert!(s
        .complete_import(&person(), &old, credential("123"))
        .is_err());
    assert_eq!(
        s.status(&person(), &selected().connection_id)
            .unwrap()
            .account,
        installed.account
    );
}
#[test]
fn disconnect_deletion_failure_stays_disabled() {
    let mut db = Db::new();
    let store = FakeStore::default();
    let mut s = ConnectionService {
        conn: &mut db.conn,
        store: &store,
    };
    let initial = s.connect(&person(), &selected()).unwrap();
    let installed = install(&mut s, initial.revision, "123");
    store.fail_delete.set(true);
    let disconnected = s
        .revoke(&person(), &selected().connection_id, installed.revision)
        .unwrap();
    assert!(disconnected.cleanup_pending);
    assert_eq!(disconnected.health, ConnectionHealth::Disabled);
    let conn2 = crate::runtime::open(&db.dir).unwrap();
    let health: String = conn2
        .query_row(
            "SELECT json_extract(status, '$.health') FROM managed_connections",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(health, "disabled");
}
#[test]
fn disconnect_does_not_claim_remote_revocation() {
    let mut db = Db::new();
    let store = FakeStore::default();
    let mut s = ConnectionService {
        conn: &mut db.conn,
        store: &store,
    };
    let initial = s.connect(&person(), &selected()).unwrap();
    let status = s
        .revoke(&person(), &selected().connection_id, initial.revision)
        .unwrap();
    assert_eq!(status.remote_revocation, RemoteRevocation::NotAttempted);
}
#[test]
fn safe_payloads_and_database_never_contain_credential_bytes() {
    let mut db = Db::new();
    let store = FakeStore::default();
    let mut s = ConnectionService {
        conn: &mut db.conn,
        store: &store,
    };
    let initial = s.connect(&person(), &selected()).unwrap();
    let a = s
        .begin_gh_import(&person(), &selected(), initial.revision)
        .unwrap();
    let installed = s.complete_import(&person(), &a, credential("123")).unwrap();
    assert!(!serde_json::to_string(&(installed, a))
        .unwrap()
        .contains(SENTINEL));
    for entry in std::fs::read_dir(&db.dir).unwrap() {
        let bytes = std::fs::read(entry.unwrap().path()).unwrap();
        assert!(!bytes
            .windows(SENTINEL.len())
            .any(|b| b == SENTINEL.as_bytes()));
    }
}
#[test]
fn verify_reports_missing_and_unsupported_instead_of_ready() {
    let mut db = Db::new();
    let store = FakeStore::default();
    let mut s = ConnectionService {
        conn: &mut db.conn,
        store: &store,
    };
    let initial = s.connect(&person(), &selected()).unwrap();
    let installed = install(&mut s, initial.revision, "123");
    store.items.borrow_mut().clear();
    assert_eq!(
        s.verify(
            &person(),
            &selected().connection_id,
            installed.revision,
            &FakeIdentity { login: "alice" }
        )
        .unwrap()
        .health,
        ConnectionHealth::SignInRequired
    );
    let mut s = ConnectionService {
        conn: &mut db.conn,
        store: &secrets::UnsupportedSecretStore,
    };
    assert_eq!(
        s.verify(
            &person(),
            &selected().connection_id,
            installed.revision,
            &FakeIdentity { login: "alice" }
        )
        .unwrap()
        .health,
        ConnectionHealth::Unsupported
    );
}

#[test]
fn gh_import_explicit_user_never_active_fallback() {
    let gh = FakeGh {
        exists: false,
        calls: Cell::new(0),
    };
    assert!(matches!(
        gh_credentials::acquire(&selected(), &gh, &FakeIdentity { login: "alice" }),
        Err(ConnectionError::NotFound)
    ));
    assert_eq!(gh.calls.get(), 1);
}
#[test]
fn gh_env_token_override_is_removed() {
    let gh = FakeGh {
        exists: true,
        calls: Cell::new(0),
    };
    let c = gh_credentials::acquire(&selected(), &gh, &FakeIdentity { login: "alice" }).unwrap();
    assert_eq!(c.subject, "123");
    assert_eq!(gh.calls.get(), 1);
}
#[test]
fn gh_import_identity_mismatch_installs_nothing() {
    let gh = FakeGh {
        exists: true,
        calls: Cell::new(0),
    };
    assert!(matches!(
        gh_credentials::acquire(&selected(), &gh, &FakeIdentity { login: "bob" }),
        Err(ConnectionError::IdentityMismatch)
    ));
}

const LEGACY: &str = r#"{ "unknownRoot": {"keep": 1}, "servers": { "danger": {"transport":"stdio", "command":"never-launch-this", "env":{"TOKEN":"SENTINEL_ENV_NEVER_EXPORT"}, "headers":{"Authorization":"SENTINEL_HEADER_NEVER_EXPORT"}, "unknown":{"nested":[1,2,3]}} } }"#;
struct Importer {
    fail: bool,
    calls: Cell<usize>,
    discarded: Cell<usize>,
}
impl migration::LegacyImporter for Importer {
    fn import_and_verify(&self, _: &serde_json::Value) -> Result<SecretRef, ConnectionError> {
        self.calls.set(self.calls.get() + 1);
        if self.fail {
            return Err(ConnectionError::Unavailable);
        }
        Ok(SecretRef {
            id: "opaque-reference".into(),
            account_id: AccountId("account".into()),
            issuer: "https://github.com".into(),
            subject: "123".into(),
            secret_revision: 1,
        })
    }
    fn discard(&self, _: &SecretRef) -> Result<(), ConnectionError> {
        self.discarded.set(self.discarded.get() + 1);
        Ok(())
    }
}
fn importer(fail: bool) -> Importer {
    Importer {
        fail,
        calls: Cell::new(0),
        discarded: Cell::new(0),
    }
}
fn config(db: &Db) -> std::path::PathBuf {
    let dir = db.dir.join("vault/.cerebro");
    std::fs::create_dir_all(&dir).unwrap();
    let p = dir.join("connectors.json");
    std::fs::write(&p, LEGACY).unwrap();
    p
}
#[test]
fn unapproved_stdio_scan_launches_nothing() {
    let mut migration = migration::MigrationService::new();
    let preview = migration.plan_legacy_migration(LEGACY).unwrap();
    assert_eq!(preview.server_count, 1);
    assert_eq!(preview.plaintext_locations.len(), 2);
    let serialized = serde_json::to_string(&preview).unwrap();
    for forbidden in [
        "SENTINEL_ENV",
        "SENTINEL_HEADER",
        "never-launch-this",
        "Authorization",
    ] {
        assert!(!serialized.contains(forbidden));
    }
}
#[test]
fn migration_failure_preserves_old_config() {
    let db = Db::new();
    let path = config(&db);
    let mut migration = migration::MigrationService::new();
    let p = migration.plan_legacy_migration(LEGACY).unwrap();
    assert!(migration
        .commit_legacy_migration(
            &db.dir.join("vault"),
            &p.preview_id,
            &p.source_digest,
            0,
            &importer(true)
        )
        .is_err());
    assert_eq!(std::fs::read_to_string(&path).unwrap(), LEGACY);
    assert_eq!(
        std::fs::read_dir(path.parent().unwrap()).unwrap().count(),
        1
    );
}
#[test]
fn migration_preserves_unknown_fields_and_never_backs_up_plaintext() {
    let db = Db::new();
    let path = config(&db);
    let mut migration = migration::MigrationService::new();
    let p = migration.plan_legacy_migration(LEGACY).unwrap();
    let result = migration
        .commit_legacy_migration(
            &db.dir.join("vault"),
            &p.preview_id,
            &p.source_digest,
            0,
            &importer(false),
        )
        .unwrap();
    assert!(result.migrated);
    assert!(result.remaining_plaintext_locations.is_empty());
    let written = std::fs::read_to_string(&path).unwrap();
    let value: serde_json::Value = serde_json::from_str(&written).unwrap();
    assert_eq!(value["unknownRoot"]["keep"], 1);
    assert_eq!(
        value["servers"]["danger"]["unknown"]["nested"],
        serde_json::json!([1, 2, 3])
    );
    assert_eq!(value["servers"]["danger"]["executionOwner"], "cerebro");
    assert!(!written.contains("SENTINEL"));
    assert_eq!(
        std::fs::read_dir(path.parent().unwrap()).unwrap().count(),
        1
    );
}
#[test]
fn migration_source_change_and_cancel_cannot_replace_configuration() {
    let db = Db::new();
    let path = config(&db);
    let mut migration = migration::MigrationService::new();
    let p = migration.plan_legacy_migration(LEGACY).unwrap();
    let importer = importer(false);
    std::fs::write(&path, "{\"changed\":true}").unwrap();
    assert!(matches!(
        migration.commit_legacy_migration(
            &db.dir.join("vault"),
            &p.preview_id,
            &p.source_digest,
            0,
            &importer
        ),
        Err(ConnectionError::SourceChanged)
    ));
    assert_eq!(importer.calls.get(), 0);
    assert_eq!(
        std::fs::read_to_string(&path).unwrap(),
        "{\"changed\":true}"
    );
    let p = migration.plan_legacy_migration(LEGACY).unwrap();
    migration.cancel(&p.preview_id);
    assert!(matches!(
        migration.commit_legacy_migration(
            &db.dir.join("vault"),
            &p.preview_id,
            &p.source_digest,
            0,
            &importer
        ),
        Err(ConnectionError::Cancelled)
    ));
}
#[cfg(unix)]
#[test]
fn migration_refuses_symlink_source() {
    let db = Db::new();
    let path = config(&db);
    let target = db.dir.join("outside.json");
    std::fs::rename(&path, &target).unwrap();
    std::os::unix::fs::symlink(&target, &path).unwrap();
    let mut migration = migration::MigrationService::new();
    let p = migration.plan_legacy_migration(LEGACY).unwrap();
    let importer = importer(false);
    assert!(matches!(
        migration.commit_legacy_migration(
            &db.dir.join("vault"),
            &p.preview_id,
            &p.source_digest,
            0,
            &importer
        ),
        Err(ConnectionError::UnsafePath)
    ));
    assert_eq!(importer.calls.get(), 0);
    assert_eq!(std::fs::read_to_string(target).unwrap(), LEGACY);
}

// An OS store write may finish after another window disconnected the binding.
#[test]
fn revoke_while_store_write_is_in_flight_cleans_late_secret() {
    let mut db = Db::new();
    let store = FakeStore::default();
    let ticket = {
        let mut service = ConnectionService {
            conn: &mut db.conn,
            store: &store,
        };
        let initial = service.connect(&person(), &selected()).unwrap();
        service
            .begin_gh_import(&person(), &selected(), initial.revision)
            .unwrap()
    };
    let mut other = crate::runtime::open(&db.dir).unwrap();
    let racing = BeforePut {
        inner: &store,
        before: RefCell::new(Some(Box::new(|| {
            let mut service = ConnectionService {
                conn: &mut other,
                store: &store,
            };
            service
                .revoke(
                    &person(),
                    &selected().connection_id,
                    ticket.expected_revision,
                )
                .unwrap();
        }))),
    };
    let mut service = ConnectionService {
        conn: &mut db.conn,
        store: &racing,
    };
    assert!(service
        .complete_import(&person(), &ticket, credential("123"))
        .is_err());
    assert_eq!(
        service
            .status(&person(), &selected().connection_id)
            .unwrap()
            .health,
        ConnectionHealth::Disabled
    );
    assert!(
        store.items.borrow().is_empty(),
        "the late app-owned secret leaked after Disconnect"
    );
}
#[test]
fn reconnect_while_store_write_is_in_flight_keeps_only_new_secret() {
    let mut db = Db::new();
    let store = FakeStore::default();
    let ticket = {
        let mut service = ConnectionService {
            conn: &mut db.conn,
            store: &store,
        };
        let initial = service.connect(&person(), &selected()).unwrap();
        service
            .begin_gh_import(&person(), &selected(), initial.revision)
            .unwrap()
    };
    let mut other = crate::runtime::open(&db.dir).unwrap();
    let racing = BeforePut {
        inner: &store,
        before: RefCell::new(Some(Box::new(|| {
            let mut service = ConnectionService {
                conn: &mut other,
                store: &store,
            };
            let current = service
                .reconnect(
                    &person(),
                    &selected().connection_id,
                    ticket.expected_revision,
                )
                .unwrap();
            install(&mut service, current.revision, "456");
        }))),
    };
    let mut service = ConnectionService {
        conn: &mut db.conn,
        store: &racing,
    };
    assert!(service
        .complete_import(&person(), &ticket, credential("123"))
        .is_err());
    assert_eq!(
        service
            .status(&person(), &selected().connection_id)
            .unwrap()
            .account
            .unwrap()
            .subject,
        "456"
    );
    assert_eq!(
        store.items.borrow().len(),
        1,
        "the stale import leaked an unused secret"
    );
}
#[test]
fn polling_and_cancellation_are_person_bound() {
    let mut db = Db::new();
    let store = FakeStore::default();
    let mut service = ConnectionService {
        conn: &mut db.conn,
        store: &store,
    };
    let initial = service.connect(&person(), &selected()).unwrap();
    let ticket = service
        .begin_gh_import(&person(), &selected(), initial.revision)
        .unwrap();
    let other = AttendedPerson::at_native_door("human:other").unwrap();
    assert_eq!(
        service.credential_acquisition(&other, &ticket.attempt_id),
        Err(ConnectionError::NotFound)
    );
    assert_eq!(
        service.cancel_credential_acquisition(&other, &ticket.attempt_id),
        Err(ConnectionError::NotFound)
    );
    assert_eq!(
        service
            .credential_acquisition(&person(), &ticket.attempt_id)
            .unwrap()
            .state,
        AcquisitionState::Pending
    );
}
#[test]
fn failed_cleanup_can_retry_without_enabling_dispatch() {
    let mut db = Db::new();
    let store = FakeStore::default();
    let mut service = ConnectionService {
        conn: &mut db.conn,
        store: &store,
    };
    let initial = service.connect(&person(), &selected()).unwrap();
    let installed = install(&mut service, initial.revision, "123");
    store.fail_delete.set(true);
    let disconnected = service
        .revoke(&person(), &selected().connection_id, installed.revision)
        .unwrap();
    assert!(disconnected.cleanup_pending);
    store.fail_delete.set(false);
    service
        .cleanup(&person(), &selected().connection_id)
        .unwrap();
    let status = service
        .status(&person(), &selected().connection_id)
        .unwrap();
    assert!(!status.cleanup_pending);
    assert_eq!(status.health, ConnectionHealth::Disabled);
    assert!(store.items.borrow().is_empty());
}
struct SourceChangingImporter {
    path: std::path::PathBuf,
    discarded: Cell<bool>,
}
impl migration::LegacyImporter for SourceChangingImporter {
    fn import_and_verify(&self, _: &serde_json::Value) -> Result<SecretRef, ConnectionError> {
        std::fs::write(&self.path, "{\"changedDuringImport\":true}").unwrap();
        importer(false).import_and_verify(&serde_json::Value::Null)
    }
    fn discard(&self, _: &SecretRef) -> Result<(), ConnectionError> {
        self.discarded.set(true);
        Ok(())
    }
}
#[test]
fn migration_rechecks_source_after_import_and_discards_unused_secret() {
    let db = Db::new();
    let path = config(&db);
    let mut service = migration::MigrationService::new();
    let preview = service.plan_legacy_migration(LEGACY).unwrap();
    let importer = SourceChangingImporter {
        path: path.clone(),
        discarded: Cell::new(false),
    };
    assert!(matches!(
        service.commit_legacy_migration(
            &db.dir.join("vault"),
            &preview.preview_id,
            &preview.source_digest,
            0,
            &importer
        ),
        Err(ConnectionError::SourceChanged)
    ));
    assert!(importer.discarded.get());
    assert_eq!(
        std::fs::read_to_string(&path).unwrap(),
        "{\"changedDuringImport\":true}"
    );
    assert_eq!(
        std::fs::read_dir(path.parent().unwrap()).unwrap().count(),
        1
    );
}

struct CrashAfterPut<'a>(&'a FakeStore);
impl SecretStore for CrashAfterPut<'_> {
    fn put(&self, r: &SecretRef, s: &SecretValue) -> Result<(), ConnectionError> {
        self.0.put(r, s)?;
        panic!("injected interruption after native secret installation")
    }
    fn resolve(&self, r: &SecretRef) -> Result<SecretValue, ConnectionError> {
        self.0.resolve(r)
    }
    fn delete(&self, r: &SecretRef) -> Result<(), ConnectionError> {
        self.0.delete(r)
    }
}
#[test]
fn restart_retires_abandoned_import_and_cleans_reserved_secret() {
    let mut db = Db::new();
    let store = FakeStore::default();
    let ticket = {
        let mut service = ConnectionService {
            conn: &mut db.conn,
            store: &store,
        };
        let initial = service.connect(&person(), &selected()).unwrap();
        service
            .begin_gh_import(&person(), &selected(), initial.revision)
            .unwrap()
    };
    let crash = CrashAfterPut(&store);
    let interrupted = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let mut service = ConnectionService {
            conn: &mut db.conn,
            store: &crash,
        };
        let _ = service.complete_import(&person(), &ticket, credential("123"));
    }));
    assert!(interrupted.is_err());
    assert_eq!(store.items.borrow().len(), 1);
    let mut reopened = crate::runtime::open(&db.dir).unwrap();
    let mut service = ConnectionService {
        conn: &mut reopened,
        store: &store,
    };
    service.recover_after_restart(&person()).unwrap();
    assert_eq!(
        service
            .credential_acquisition(&person(), &ticket.attempt_id)
            .unwrap()
            .state,
        AcquisitionState::Cancelled
    );
    assert!(store.items.borrow().is_empty());
    assert!(service
        .complete_import(&person(), &ticket, credential("123"))
        .is_err());
}

struct BeforeResolve<'a> {
    inner: &'a FakeStore,
    before: RefCell<Option<Box<dyn FnOnce() + 'a>>>,
}
impl SecretStore for BeforeResolve<'_> {
    fn put(&self, r: &SecretRef, s: &SecretValue) -> Result<(), ConnectionError> {
        self.inner.put(r, s)
    }
    fn resolve(&self, r: &SecretRef) -> Result<SecretValue, ConnectionError> {
        let value = self.inner.resolve(r)?;
        if let Some(before) = self.before.borrow_mut().take() {
            before();
        }
        Ok(value)
    }
    fn delete(&self, r: &SecretRef) -> Result<(), ConnectionError> {
        self.inner.delete(r)
    }
}
#[test]
fn delayed_availability_observation_cannot_restore_old_binding() {
    let mut db = Db::new();
    let store = FakeStore::default();
    let ticket = {
        let mut service = ConnectionService {
            conn: &mut db.conn,
            store: &store,
        };
        let initial = service.connect(&person(), &selected()).unwrap();
        let installed = install(&mut service, initial.revision, "123");
        service
            .begin_gh_import(&person(), &selected(), installed.revision)
            .unwrap()
    };
    let mut other = crate::runtime::open(&db.dir).unwrap();
    let racing = BeforeResolve {
        inner: &store,
        before: RefCell::new(Some(Box::new(|| {
            let mut service = ConnectionService {
                conn: &mut other,
                store: &store,
            };
            service
                .complete_import(&person(), &ticket, credential("456"))
                .unwrap();
        }))),
    };
    let mut service = ConnectionService {
        conn: &mut db.conn,
        store: &racing,
    };
    assert_eq!(
        service.verify(
            &person(),
            &selected().connection_id,
            ticket.expected_revision,
            &FakeIdentity { login: "alice" }
        ),
        Err(ConnectionError::StaleRevision)
    );
    assert_eq!(
        service
            .status(&person(), &selected().connection_id)
            .unwrap()
            .account
            .unwrap()
            .subject,
        "456"
    );
}

#[test]
fn verification_authenticates_the_bound_account_instead_of_only_resolving_a_secret() {
    let mut db = Db::new();
    let store = FakeStore::default();
    let mut service = ConnectionService {
        conn: &mut db.conn,
        store: &store,
    };
    let initial = service.connect(&person(), &selected()).unwrap();
    let installed = install(&mut service, initial.revision, "123");
    let status = service
        .verify(
            &person(),
            &selected().connection_id,
            installed.revision,
            &FakeIdentity { login: "bob" },
        )
        .unwrap();
    assert_eq!(status.health, ConnectionHealth::SignInRequired);
    assert_eq!(status.account, installed.account);
}
#[test]
fn acquisition_failure_is_durable_and_repairable() {
    let mut db = Db::new();
    let store = FakeStore::default();
    let mut service = ConnectionService {
        conn: &mut db.conn,
        store: &store,
    };
    let initial = service.connect(&person(), &selected()).unwrap();
    let ticket = service
        .begin_gh_import(&person(), &selected(), initial.revision)
        .unwrap();
    let failed = service
        .fail_credential_acquisition(&person(), &ticket.attempt_id, ConnectionError::NotFound)
        .unwrap();
    assert_eq!(failed.state, AcquisitionState::Failed);
    assert_eq!(failed.error, Some(ConnectionError::NotFound));
    assert_eq!(
        service
            .status(&person(), &selected().connection_id)
            .unwrap()
            .health,
        ConnectionHealth::SignInRequired
    );
    assert!(service
        .complete_import(&person(), &ticket, credential("123"))
        .is_err());
    assert!(store.items.borrow().is_empty());
}

struct IndependentIdentityObservation<'a> {
    after_observation: RefCell<Option<Box<dyn FnOnce() + 'a>>>,
}
impl gh_credentials::IdentityReader for IndependentIdentityObservation<'_> {
    fn authenticated_identity(
        &self,
        token: &SecretValue,
    ) -> Result<gh_credentials::ProviderIdentity, ConnectionError> {
        let observed = FakeIdentity { login: "alice" }.authenticated_identity(token)?;
        if let Some(after) = self.after_observation.borrow_mut().take() {
            after();
        }
        Ok(observed)
    }
}
#[test]
fn independent_delayed_verify_cannot_overwrite_newer_identity_failure() {
    let mut db = Db::new();
    let store = FakeStore::default();
    let installed = {
        let mut service = ConnectionService {
            conn: &mut db.conn,
            store: &store,
        };
        let initial = service.connect(&person(), &selected()).unwrap();
        install(&mut service, initial.revision, "123")
    };
    let mut other = crate::runtime::open(&db.dir).unwrap();
    let racing = IndependentIdentityObservation {
        after_observation: RefCell::new(Some(Box::new(|| {
            let mut service = ConnectionService {
                conn: &mut other,
                store: &store,
            };
            let newer = service
                .verify(
                    &person(),
                    &selected().connection_id,
                    installed.revision,
                    &FakeIdentity { login: "bob" },
                )
                .unwrap();
            assert_eq!(newer.health, ConnectionHealth::SignInRequired);
        }))),
    };
    let mut service = ConnectionService {
        conn: &mut db.conn,
        store: &store,
    };
    let result = service.verify(
        &person(),
        &selected().connection_id,
        installed.revision,
        &racing,
    );
    assert!(
        matches!(result, Err(ConnectionError::StaleRevision)),
        "old verification overwrote a newer rejected identity: {result:?}"
    );
}

#[test]
fn independent_migration_preserves_unknown_large_integer_exactly() {
    let db = Db::new();
    let path = config(&db);
    let raw =
        r#"{"servers":{"github":{"command":"gh"}},"unknownRoot":{"id":18446744073709551617}}"#;
    std::fs::write(&path, raw).unwrap();
    let mut migration = migration::MigrationService::new();
    let p = migration.plan_legacy_migration(raw).unwrap();
    migration
        .commit_legacy_migration(
            &db.dir.join("vault"),
            &p.preview_id,
            &p.source_digest,
            0,
            &importer(false),
        )
        .unwrap();
    let written = std::fs::read_to_string(path).unwrap();
    assert!(
        written.contains("18446744073709551617"),
        "migration changed an unknown integer: {written}"
    );
}

#[test]
fn verification_during_install_keeps_a_current_import_and_advances_its_observation_epoch() {
    let mut db = Db::new();
    let store = FakeStore::default();
    let ticket = {
        let mut service = ConnectionService {
            conn: &mut db.conn,
            store: &store,
        };
        let initial = service.connect(&person(), &selected()).unwrap();
        let installed = install(&mut service, initial.revision, "123");
        service
            .begin_gh_import(&person(), &selected(), installed.revision)
            .unwrap()
    };
    let mut other = crate::runtime::open(&db.dir).unwrap();
    let racing = BeforePut {
        inner: &store,
        before: RefCell::new(Some(Box::new(|| {
            let mut service = ConnectionService {
                conn: &mut other,
                store: &store,
            };
            let rejected = service
                .verify(
                    &person(),
                    &selected().connection_id,
                    ticket.expected_revision,
                    &FakeIdentity { login: "bob" },
                )
                .unwrap();
            assert_eq!(rejected.health, ConnectionHealth::SignInRequired);
        }))),
    };
    let mut service = ConnectionService {
        conn: &mut db.conn,
        store: &racing,
    };
    let installed = service
        .complete_import(&person(), &ticket, credential("456"))
        .unwrap();
    assert_eq!(installed.health, ConnectionHealth::Ready);
    assert_eq!(installed.account.unwrap().subject, "456");
    let epoch: Option<i64> = service
        .conn
        .query_row(
            "SELECT observation_revision FROM managed_connections WHERE connection_id=?1",
            [&selected().connection_id.0],
            |row| row.get(0),
        )
        .ok();
    assert_eq!(
        epoch,
        Some(5),
        "begin, install, begin, verify and install each advance the private CAS epoch"
    );
}

#[test]
fn migration_preserves_nested_numeric_and_string_lexemes_in_unknown_fields() {
    let db = Db::new();
    let path = config(&db);
    let unknown = r#"{"integer":18446744073709551617,"decimal":1.00000000000000000001,"string":"\u0061\/\t","array":[-18446744073709551617,1e308]}"#;
    let raw = r#"{"unknownRoot":$UNKNOWN,"servers":{"chosen":{"command":"gh","unknown":$UNKNOWN},"other":{"unknown":$UNKNOWN}}}"#.replace("$UNKNOWN", unknown);
    std::fs::write(&path, &raw).unwrap();
    let mut service = migration::MigrationService::new();
    let preview = service.plan_legacy_migration(&raw).unwrap();
    service
        .commit_legacy_migration(
            &db.dir.join("vault"),
            &preview.preview_id,
            &preview.source_digest,
            0,
            &importer(false),
        )
        .unwrap();
    let written = std::fs::read_to_string(path).unwrap();
    assert_eq!(written.matches(unknown).count(), 3, "unknown root, selected-server and unselected-server values must retain their exact lexemes: {written}");
}

#[test]
fn migration_refuses_duplicate_keys_in_rewritten_objects_before_import() {
    for raw in [
        r#"{"servers":{"chosen":{}},"unknown":1,"unknown":2}"#,
        r#"{"servers":{"chosen":{},"chosen":{"command":"gh"}}}"#,
        r#"{"servers":{"chosen":{"unknown":1,"unknown":2}}}"#,
    ] {
        let db = Db::new();
        let path = config(&db);
        std::fs::write(&path, raw).unwrap();
        let mut service = migration::MigrationService::new();
        assert!(
            matches!(
                service.plan_legacy_migration(raw),
                Err(ConnectionError::InvalidConfig)
            ),
            "a rewritten object cannot silently collapse duplicate keys"
        );
        assert_eq!(std::fs::read_to_string(path).unwrap(), raw);
    }
}

// The acquisition recipe is real; only the unavailable external process/provider
// boundaries are replaced. These probes never spawn or persist a credential.
mod selected_capture_contract_tests {
    use super::*;

    #[derive(Debug)]
    struct CapturedRecipe {
        program: &'static str,
        args: Vec<String>,
        clear_environment: bool,
        environment: Vec<(&'static str, &'static str)>,
        timeout_ms: u64,
        output_limit: usize,
    }

    #[derive(Default)]
    struct CaptureProbe {
        identity_calls: Cell<usize>,
        stages: RefCell<Vec<&'static str>>,
        recipes: RefCell<Vec<CapturedRecipe>>,
        capture_error: Option<ConnectionError>,
        identity_error: Option<ConnectionError>,
    }

    impl gh_credentials::GhProcess for CaptureProbe {
        fn capture_token(
            &self,
            command: &gh_credentials::GhTokenCommand,
        ) -> Result<SecretValue, ConnectionError> {
            self.stages.borrow_mut().push("capture");
            self.recipes.borrow_mut().push(CapturedRecipe {
                program: command.program,
                args: command.args.clone(),
                clear_environment: command.clear_environment,
                environment: command.environment.clone(),
                timeout_ms: command.timeout_ms,
                output_limit: command.output_limit,
            });
            if let Some(error) = self.capture_error {
                return Err(error);
            }
            SecretValue::from_bytes(SENTINEL.as_bytes().to_vec())
        }
    }

    impl gh_credentials::IdentityReader for CaptureProbe {
        fn authenticated_identity(
            &self,
            _: &SecretValue,
        ) -> Result<gh_credentials::ProviderIdentity, ConnectionError> {
            self.identity_calls.set(self.identity_calls.get() + 1);
            self.stages.borrow_mut().push("identity");
            if let Some(error) = self.identity_error {
                return Err(error);
            }
            Ok(gh_credentials::ProviderIdentity {
                login: "alice".into(),
                subject: "123".into(),
                issuer: "https://github.com".into(),
                scope_digest: digest(b"repo"),
            })
        }
    }

    #[test]
    fn gh_selected_capture_contract_requires_no_refresh() {
        let probe = CaptureProbe::default();
        assert!(gh_credentials::acquire(&selected(), &probe, &probe).is_ok());
        let recipes = probe.recipes.borrow();
        assert_eq!(recipes.len(), 1);
        let recipe = &recipes[0];
        assert_eq!(recipe.program, "gh");
        assert_eq!(
            recipe.args,
            [
                "auth",
                "token",
                "--hostname",
                "github.com",
                "--user",
                "alice",
                "--no-refresh",
            ],
            "selected capture must prohibit automatic credential refresh"
        );
        assert!(recipe.clear_environment);
        assert_eq!(
            recipe.environment,
            [
                ("GH_PROMPT_DISABLED", "1"),
                ("GIT_TERMINAL_PROMPT", "0"),
                ("NO_COLOR", "1"),
            ]
        );
        assert_eq!(recipe.timeout_ms, 15_000);
        assert_eq!(recipe.output_limit, 16_384);
    }

    #[test]
    fn gh_selected_capture_contract_has_no_metadata_preflight() {
        let probe = CaptureProbe::default();
        assert!(gh_credentials::acquire(&selected(), &probe, &probe).is_ok());
        assert_eq!(probe.recipes.borrow().len(), 1);
        assert_eq!(probe.identity_calls.get(), 1);
        assert_eq!(*probe.stages.borrow(), ["capture", "identity"]);
    }

    #[test]
    fn gh_selected_capture_contract_missing_selected_token_stops() {
        let probe = CaptureProbe {
            capture_error: Some(ConnectionError::NotFound),
            ..CaptureProbe::default()
        };
        assert_eq!(
            gh_credentials::acquire(&selected(), &probe, &probe).err(),
            Some(ConnectionError::NotFound)
        );
        let recipes = probe.recipes.borrow();
        assert_eq!(recipes.len(), 1, "no fallback account or second capture");
        assert_eq!(recipes[0].args[3], "github.com");
        assert_eq!(recipes[0].args[4], "--user");
        assert_eq!(recipes[0].args[5], "alice");
        assert_eq!(probe.identity_calls.get(), 0);
    }

    #[test]
    fn gh_selected_capture_contract_unsupported_flag_never_retries() {
        let probe = CaptureProbe {
            capture_error: Some(ConnectionError::Unsupported),
            ..CaptureProbe::default()
        };
        assert_eq!(
            gh_credentials::acquire(&selected(), &probe, &probe).err(),
            Some(ConnectionError::Unsupported)
        );
        assert_eq!(probe.recipes.borrow().len(), 1, "no altered command retry");
        assert_eq!(probe.identity_calls.get(), 0);
        // The exact required flag is independently pinned by the recipe test;
        // this control pins failure propagation even before that RED is fixed.
    }

    #[test]
    fn gh_selected_capture_contract_invalid_selection_has_zero_adapters() {
        let cases = [
            (
                "unsupported.example",
                "alice".to_owned(),
                "test-connection".to_owned(),
                ConnectionError::Unsupported,
            ),
            (
                "github.com",
                String::new(),
                "test-connection".to_owned(),
                ConnectionError::InvalidSelection,
            ),
            (
                "github.com",
                "a".repeat(40),
                "test-connection".to_owned(),
                ConnectionError::InvalidSelection,
            ),
            (
                "github.com",
                "alice smith".to_owned(),
                "test-connection".to_owned(),
                ConnectionError::InvalidSelection,
            ),
            (
                "github.com",
                "-alice".to_owned(),
                "test-connection".to_owned(),
                ConnectionError::InvalidSelection,
            ),
            (
                "github.com",
                "alice-".to_owned(),
                "test-connection".to_owned(),
                ConnectionError::InvalidSelection,
            ),
            (
                "github.com",
                "alice".to_owned(),
                String::new(),
                ConnectionError::InvalidSelection,
            ),
            (
                "github.com",
                "alice".to_owned(),
                "c".repeat(129),
                ConnectionError::InvalidSelection,
            ),
        ];
        for (host, login, connection_id, expected) in cases {
            let probe = CaptureProbe::default();
            let choice = GhSelection {
                connection_id: ConnectionId(connection_id),
                host: host.into(),
                login,
            };
            assert_eq!(
                gh_credentials::acquire(&choice, &probe, &probe).err(),
                Some(expected)
            );
            assert!(probe.recipes.borrow().is_empty());
            assert_eq!(probe.identity_calls.get(), 0);
            assert!(probe.stages.borrow().is_empty());
        }
    }

    #[test]
    fn gh_selected_capture_contract_identity_error_stops_acquisition() {
        for error in [
            ConnectionError::Unsupported,
            ConnectionError::IdentityMismatch,
        ] {
            let probe = CaptureProbe {
                identity_error: Some(error),
                ..CaptureProbe::default()
            };
            assert_eq!(
                gh_credentials::acquire(&selected(), &probe, &probe).err(),
                Some(error)
            );
            assert_eq!(probe.recipes.borrow().len(), 1);
            assert_eq!(probe.identity_calls.get(), 1);
        }
    }
}
