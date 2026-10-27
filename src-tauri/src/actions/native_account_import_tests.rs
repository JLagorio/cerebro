//! Private lifecycle fixtures around the actual NativeOwnerState coordinator.
//! WindowRegistration below is descriptive fixture state, not AppKit admission.
//! No native proof constructor is exported; no real gh/Keychain/provider runs.
use super::*;
use crate::actions::ids::{AttemptId, ConnectionId};
use crate::connections::{
    account_metadata::{MetadataOperation as Op, MetadataOutcome as Out},
    accounts::ConnectionService,
    gh_credentials::{self, GhProcess, GhTokenCommand, IdentityReader, ProviderIdentity},
    metadata::{MetadataRecord, STATUS_SQL},
    secrets::{SecretValue, UnsupportedSecretStore},
    test_support::{BeforePut, FakeGh, FakeIdentity, FakeStore, SENTINEL},
    AcquisitionState, AttendedPerson, ConnectionError, ConnectionHealth, ConnectionStatus,
    CredentialAcquisition, GhSelection,
};
use rusqlite::params;
use std::{
    cell::{Cell, RefCell},
    fs,
    time::Duration,
};

struct Fixture {
    path: PathBuf,
    ordinary: Connection,
    owner: Arc<NativeOwnerState>,
}
impl Fixture {
    fn new(name: &str) -> Self {
        let path = crate::vault::testutil::temp_vault(name)
            .canonicalize()
            .unwrap();
        let ordinary = crate::runtime::open(&path).unwrap();
        ordinary.busy_timeout(Duration::ZERO).unwrap();
        let retained = RuntimeOwner::open_existing(&path).unwrap();
        // These scalar values deliberately do not come from a native window.
        // Tests enter the private coordinator, never authenticate() or a command.
        let registration = Arc::new(WindowRegistration {
            identity: NativeWindowIdentity {
                window: 100,
                view: 200,
                label: "main".into(),
            },
            origin: path.clone(),
            live: AtomicBool::new(true),
        });
        let owner = Arc::new(NativeOwnerState {
            credential_cancellations: Arc::default(),
            action_cancellations: Arc::default(),
            registration,
            storage: Mutex::new(StorageState {
                owner: Some(retained),
                failed: false,
            }),
        });
        Self {
            path,
            ordinary,
            owner,
        }
    }
    fn metadata(&self, op: Op<'_>) -> Result<Out, ConnectionError> {
        // Also usable inside a fake OS callback: a held owner mutex fails the
        // test immediately rather than deadlocking the native test process.
        let mut storage = self
            .owner
            .storage
            .try_lock()
            .expect("owner mutex must be released");
        storage.owner.as_mut().unwrap().account_metadata(op)
    }
    fn ticket(&self) -> CredentialAcquisition {
        let first = match self
            .metadata(Op::Connect {
                selection: &selection(),
            })
            .unwrap()
        {
            Out::Status(value) => value,
            _ => panic!("connect returns status"),
        };
        self.begin(first.revision)
    }
    fn begin(&self, expected: u64) -> CredentialAcquisition {
        match self
            .metadata(Op::BeginImport {
                selection: &selection(),
                expected,
            })
            .unwrap()
        {
            Out::Acquisition(value) => value,
            _ => panic!("begin returns acquisition"),
        }
    }
    fn status(&self) -> ConnectionStatus {
        self.ordinary
            .query_row(
                STATUS_SQL,
                params![selection().connection_id.0, owner_key()],
                MetadataRecord::read,
            )
            .unwrap()
            .status
    }
    fn attempt(&self, id: &AttemptId) -> CredentialAcquisition {
        let raw: String = self
            .ordinary
            .query_row(
                "SELECT payload FROM managed_connection_attempts WHERE attempt_id=?1 AND person=?2",
                params![id.0, owner_key()],
                |r| r.get(0),
            )
            .unwrap();
        serde_json::from_str(&raw).unwrap()
    }
    fn cleanup(&self) -> Vec<(String, String)> {
        let mut statement = self
            .ordinary
            .prepare("SELECT secret_id,disposition FROM managed_secret_cleanup ORDER BY secret_id")
            .unwrap();
        let rows = statement
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        rows.collect::<rusqlite::Result<Vec<_>>>().unwrap()
    }
    fn grants(&self) -> i64 {
        self.ordinary
            .query_row("SELECT count(*) FROM action_account_grants", [], |r| {
                r.get(0)
            })
            .unwrap()
    }
    fn assert_unlocked(&self) {
        let held = self
            .owner
            .storage
            .try_lock()
            .expect("native owner mutex held across OS seam");
        assert!(!held.failed);
        drop(held);
        // A distinct already-open connection proves no retained SQLite writer
        // transaction remains held. Zero busy timeout makes a violation finite.
        self.ordinary
            .execute_batch("BEGIN IMMEDIATE; ROLLBACK;")
            .expect("SQLite transaction held across OS seam");
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}
fn owner_key() -> String {
    super::super::native_rules::admission_rules()
        .owner_storage_key
        .clone()
}
fn selection() -> GhSelection {
    GhSelection {
        connection_id: ConnectionId("native-import-one".into()),
        host: "github.com".into(),
        login: "alice".into(),
    }
}
fn gh() -> FakeGh {
    FakeGh {
        exists: true,
        calls: Cell::new(0),
    }
}
fn identity() -> FakeIdentity {
    FakeIdentity { login: "alice" }
}

struct ObservedGh<'a> {
    inner: &'a FakeGh,
    observe: &'a dyn Fn(&'static str),
}
impl GhProcess for ObservedGh<'_> {
    fn capture_token(&self, command: &GhTokenCommand) -> Result<SecretValue, ConnectionError> {
        (self.observe)("gh-token");
        self.inner.capture_token(command)
    }
}
struct ObservedIdentity<'a> {
    inner: &'a FakeIdentity,
    observe: &'a dyn Fn(&'static str),
}
impl IdentityReader for ObservedIdentity<'_> {
    fn authenticated_identity(
        &self,
        secret: &SecretValue,
    ) -> Result<ProviderIdentity, ConnectionError> {
        (self.observe)("provider-identity");
        self.inner.authenticated_identity(secret)
    }
}

#[test]
fn native_account_import_legacy_control_reuses_selected_gh_and_fake_secret_seams() {
    let mut f = Fixture::new("m96-import-legacy-control");
    let store = FakeStore::default();
    let process = gh();
    let person = AttendedPerson::at_native_door(&owner_key()).unwrap();
    let mut service = ConnectionService {
        conn: &mut f.ordinary,
        store: &store,
    };
    let initial = service.connect(&person, &selection()).unwrap();
    let ticket = service
        .begin_gh_import(&person, &selection(), initial.revision)
        .unwrap();
    let credential = gh_credentials::acquire(&selection(), &process, &identity()).unwrap();
    let installed = service
        .complete_import(&person, &ticket, credential)
        .unwrap();
    assert_eq!(installed.health, ConnectionHealth::Ready);
    assert_eq!(process.calls.get(), 1);
    assert_eq!(store.items.borrow().len(), 1);
    assert_eq!(f.grants(), 0);
}

#[test]
fn native_account_import_installs_exact_binding_once_and_refuses_ticket_replay() {
    let f = Fixture::new("m96-import-success");
    let ticket = f.ticket();
    let process = gh();
    let store = FakeStore::default();
    let installed = f
        .owner
        .import_account(&ticket, &process, &identity(), &store)
        .unwrap();
    assert_eq!(installed, f.status());
    assert_eq!(installed.health, ConnectionHealth::Ready);
    assert_eq!(installed.revision, ticket.expected_revision + 1);
    assert_eq!(installed.secret_revision, 1);
    assert_eq!(installed.account.as_ref().unwrap().subject, "123");
    assert_eq!(
        installed.account.as_ref().unwrap().issuer,
        "https://github.com"
    );
    assert_eq!(
        f.attempt(&ticket.attempt_id).state,
        AcquisitionState::Installed
    );
    assert!(f.cleanup().is_empty());
    assert_eq!(store.items.borrow().len(), 1);
    assert_eq!(f.grants(), 0);
    assert!(!serde_json::to_string(&installed)
        .unwrap()
        .contains(SENTINEL));
    assert_eq!(
        f.owner
            .import_account(&ticket, &process, &identity(), &store),
        Err(ConnectionError::Cancelled)
    );
    assert_eq!(
        process.calls.get(),
        1,
        "replay must refuse before acquiring another credential"
    );
    assert_eq!(f.status(), installed);
    assert_eq!(store.items.borrow().len(), 1);
}

#[test]
fn native_account_import_releases_actual_owner_and_sql_locks_and_reserves_before_put() {
    let f = Fixture::new("m96-import-unlocked");
    let ticket = f.ticket();
    let process = gh();
    let remote = identity();
    let store = FakeStore::default();
    let stages = RefCell::new(Vec::new());
    let observe = |stage| {
        f.assert_unlocked();
        assert!(
            f.cleanup().is_empty(),
            "no secret reference exists before validated identity"
        );
        stages.borrow_mut().push(stage);
    };
    let put = BeforePut {
        inner: &store,
        before: RefCell::new(Some(Box::new(|| {
            f.assert_unlocked();
            let reserved = f.cleanup();
            assert_eq!(reserved.len(), 1);
            assert_eq!(reserved[0].1, "reserved");
            assert_eq!(
                f.attempt(&ticket.attempt_id).state,
                AcquisitionState::Pending
            );
            assert_eq!(f.status().secret_revision, 0);
            assert!(store.items.borrow().is_empty());
            stages.borrow_mut().push("keychain-put");
        }))),
    };
    let result = f.owner.import_account(
        &ticket,
        &ObservedGh {
            inner: &process,
            observe: &observe,
        },
        &ObservedIdentity {
            inner: &remote,
            observe: &observe,
        },
        &put,
    );
    assert_eq!(
        *stages.borrow(),
        ["gh-token", "provider-identity", "keychain-put"]
    );
    assert_eq!(result.unwrap().health, ConnectionHealth::Ready);
    assert!(f.cleanup().is_empty());
}

#[test]
fn native_account_import_cancel_during_put_never_installs_and_deletes_only_its_secret() {
    let f = Fixture::new("m96-import-cancel");
    let ticket = f.ticket();
    let process = gh();
    let store = FakeStore::default();
    let put = BeforePut {
        inner: &store,
        before: RefCell::new(Some(Box::new(|| {
            f.assert_unlocked();
            f.metadata(Op::CancelImport {
                attempt: &ticket.attempt_id,
            })
            .unwrap();
        }))),
    };
    assert_eq!(
        f.owner.import_account(&ticket, &process, &identity(), &put),
        Err(ConnectionError::Cancelled)
    );
    assert_eq!(
        f.attempt(&ticket.attempt_id).state,
        AcquisitionState::Cancelled
    );
    assert_eq!(f.status().health, ConnectionHealth::SignInRequired);
    assert!(store.items.borrow().is_empty());
    assert!(f.cleanup().is_empty());
    assert_eq!(f.grants(), 0);
}

#[test]
fn native_account_import_disable_during_put_preserves_revocation() {
    let f = Fixture::new("m96-import-disable");
    let ticket = f.ticket();
    let store = FakeStore::default();
    let put = BeforePut {
        inner: &store,
        before: RefCell::new(Some(Box::new(|| {
            f.assert_unlocked();
            f.metadata(Op::Disable {
                connection: &selection().connection_id,
                expected: ticket.expected_revision,
            })
            .unwrap();
        }))),
    };
    assert_eq!(
        f.owner.import_account(&ticket, &gh(), &identity(), &put),
        Err(ConnectionError::Cancelled)
    );
    assert_eq!(f.status().health, ConnectionHealth::Disabled);
    assert_eq!(
        f.status().revocation_generation,
        ticket.revocation_generation + 1
    );
    assert_eq!(
        f.attempt(&ticket.attempt_id).state,
        AcquisitionState::Cancelled
    );
    assert!(store.items.borrow().is_empty());
    assert!(f.cleanup().is_empty());
}

#[test]
fn native_account_import_reconnect_during_put_preserves_only_new_installation() {
    let f = Fixture::new("m96-import-reconnect");
    let old = f.ticket();
    let store = FakeStore::default();
    let installed = RefCell::new(None);
    let put = BeforePut {
        inner: &store,
        before: RefCell::new(Some(Box::new(|| {
            f.assert_unlocked();
            let revision = match f
                .metadata(Op::Reconnect {
                    connection: &selection().connection_id,
                    expected: old.expected_revision,
                })
                .unwrap()
            {
                Out::Status(value) => value.revision,
                _ => panic!("reconnect returns status"),
            };
            let newer = f.begin(revision);
            let result = f
                .owner
                .import_account(&newer, &gh(), &identity(), &store)
                .unwrap();
            *installed.borrow_mut() = Some((newer, result));
        }))),
    };
    assert_eq!(
        f.owner.import_account(&old, &gh(), &identity(), &put),
        Err(ConnectionError::Cancelled)
    );
    let saved = installed.borrow();
    let (newer, current) = saved.as_ref().expect("replacement import never ran");
    assert!(
        current.cleanup_pending,
        "the inner installation still observes the outer reserved secret"
    );
    let settled = f.status();
    assert!(
        !settled.cleanup_pending,
        "the outer cancelled import must retire its own cleanup reservation"
    );
    let mut expected_settled = current.clone();
    expected_settled.cleanup_pending = false;
    // Every other binding, revision, health and observation field stays exact.
    assert_eq!(settled, expected_settled);
    assert_eq!(
        f.attempt(&old.attempt_id).state,
        AcquisitionState::Cancelled
    );
    assert_eq!(
        f.attempt(&newer.attempt_id).state,
        AcquisitionState::Installed
    );
    let current_ref: String = f
        .ordinary
        .query_row(
            "SELECT json_extract(secret_ref,'$.id') FROM managed_connections",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        store.items.borrow().keys().cloned().collect::<Vec<_>>(),
        [current_ref]
    );
    assert!(f.cleanup().is_empty());
    assert_eq!(f.grants(), 0);
}

#[test]
fn native_account_import_runtime_replacement_retires_original_without_reopening() {
    let f = Fixture::new("m96-import-runtime-retire");
    let ticket = f.ticket();
    let process = gh();
    let store = FakeStore::default();
    let path = crate::runtime::runtime_db_path(&f.path);
    let original = f.path.join("runtime.original.db");
    let replacement = f.path.join("runtime.replacement.db");
    let put = BeforePut {
        inner: &store,
        before: RefCell::new(Some(Box::new(|| {
            f.assert_unlocked();
            assert_eq!(f.cleanup().len(), 1);
            f.ordinary
                .execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
                .unwrap();
            fs::copy(&path, &replacement).unwrap();
            fs::rename(&path, &original).unwrap();
            fs::rename(&replacement, &path).unwrap();
        }))),
    };
    let result = f.owner.import_account(&ticket, &process, &identity(), &put);
    assert_eq!(
        process.calls.get(),
        1,
        "must reach real reserve/work before replacement refusal"
    );
    assert_eq!(result, Err(ConnectionError::Unavailable));
    assert!(
        f.owner
            .storage
            .try_lock()
            .unwrap()
            .owner
            .as_ref()
            .unwrap()
            .retired
    );
    assert_eq!(f.status().health, ConnectionHealth::SignInRequired);
    assert_eq!(
        f.attempt(&ticket.attempt_id).state,
        AcquisitionState::Pending
    );
    assert_eq!(
        f.cleanup()
            .iter()
            .map(|row| row.1.as_str())
            .collect::<Vec<_>>(),
        ["reserved"]
    );
    assert!(
        store.items.borrow().is_empty(),
        "unused app-owned secret may be cleaned without writing another runtime"
    );
    let substituted =
        Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let health: String = substituted
        .query_row(
            "SELECT json_extract(status,'$.health') FROM managed_connections",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(health, "sign_in_required");
    drop(substituted);
    fs::remove_file(&path).unwrap();
    fs::rename(&original, &path).unwrap();
    assert_eq!(
        f.owner
            .import_account(&ticket, &process, &identity(), &store),
        Err(ConnectionError::Unavailable)
    );
    assert_eq!(
        process.calls.get(),
        1,
        "restoring a path cannot recapture an owner"
    );
}

#[test]
fn native_account_import_original_registration_retirement_blocks_completion() {
    let f = Fixture::new("m96-import-registration-retire");
    let ticket = f.ticket();
    let process = gh();
    let store = FakeStore::default();
    let put = BeforePut {
        inner: &store,
        before: RefCell::new(Some(Box::new(|| {
            f.assert_unlocked();
            // Same liveness field retired by the real Destroyed hook; this is a
            // lifecycle fixture, not a claim that this test destroyed a window.
            f.owner.registration.live.store(false, Ordering::SeqCst);
        }))),
    };
    assert_eq!(
        f.owner.import_account(&ticket, &process, &identity(), &put),
        Err(ConnectionError::Unavailable)
    );
    assert_eq!(process.calls.get(), 1);
    assert_eq!(f.status().health, ConnectionHealth::SignInRequired);
    assert_eq!(
        f.attempt(&ticket.attempt_id).state,
        AcquisitionState::Pending
    );
    assert!(store.items.borrow().is_empty());
    assert_eq!(
        f.cleanup()
            .iter()
            .map(|row| row.1.as_str())
            .collect::<Vec<_>>(),
        ["reserved"]
    );
}

#[test]
fn native_account_import_stale_or_foreign_ticket_refuses_before_credential_work() {
    let f = Fixture::new("m96-import-wrong-ticket");
    let ticket = f.ticket();
    let process = gh();
    let store = FakeStore::default();
    let mut foreign = ticket.clone();
    foreign.person = "human:other".into();
    assert_eq!(
        f.owner
            .import_account(&foreign, &process, &identity(), &store),
        Err(ConnectionError::StaleRevision)
    );
    let mut stale = ticket.clone();
    stale.expected_revision += 1;
    assert_eq!(
        f.owner
            .import_account(&stale, &process, &identity(), &store),
        Err(ConnectionError::StaleRevision)
    );
    assert_eq!(process.calls.get(), 0);
    assert!(store.items.borrow().is_empty());
    assert!(f.cleanup().is_empty());
    assert_eq!(f.attempt(&ticket.attempt_id), ticket);
}

#[test]
fn native_account_import_missing_selected_login_never_falls_back_or_puts() {
    let f = Fixture::new("m96-import-no-selected-login");
    let ticket = f.ticket();
    let process = FakeGh {
        exists: false,
        calls: Cell::new(0),
    };
    let store = FakeStore::default();
    assert_eq!(
        f.owner
            .import_account(&ticket, &process, &identity(), &store),
        Err(ConnectionError::NotFound)
    );
    assert_eq!(process.calls.get(), 1);
    assert!(store.items.borrow().is_empty());
    assert!(f.cleanup().is_empty());
    assert_eq!(f.status().health, ConnectionHealth::SignInRequired);
    assert_eq!(
        f.attempt(&ticket.attempt_id).state,
        AcquisitionState::Failed
    );
}

#[test]
fn native_account_import_failed_put_never_installs_or_fabricates_cleanup() {
    let f = Fixture::new("m96-import-put-failed");
    let ticket = f.ticket();
    let process = gh();
    assert_eq!(
        f.owner
            .import_account(&ticket, &process, &identity(), &UnsupportedSecretStore),
        Err(ConnectionError::Unsupported)
    );
    assert_eq!(process.calls.get(), 1);
    assert_eq!(f.status().health, ConnectionHealth::Unsupported);
    assert_eq!(
        f.attempt(&ticket.attempt_id).state,
        AcquisitionState::Failed
    );
    assert_eq!(f.status().secret_revision, 0);
    assert!(f.status().account.is_none());
    assert!(f.status().cleanup_pending);
    assert_eq!(
        f.cleanup()
            .iter()
            .map(|row| row.1.as_str())
            .collect::<Vec<_>>(),
        ["delete"]
    );
}

#[test]
fn native_account_import_failed_late_delete_stays_pending_without_readiness() {
    let f = Fixture::new("m96-import-delete-failed");
    let ticket = f.ticket();
    let store = FakeStore::default();
    store.fail_delete.set(true);
    let put = BeforePut {
        inner: &store,
        before: RefCell::new(Some(Box::new(|| {
            f.metadata(Op::CancelImport {
                attempt: &ticket.attempt_id,
            })
            .unwrap();
        }))),
    };
    assert_eq!(
        f.owner.import_account(&ticket, &gh(), &identity(), &put),
        Err(ConnectionError::Cancelled)
    );
    assert_eq!(store.items.borrow().len(), 1);
    assert_eq!(f.status().health, ConnectionHealth::SignInRequired);
    assert!(f.status().cleanup_pending);
    assert_eq!(f.status().secret_revision, 0);
    assert_eq!(
        f.cleanup()
            .iter()
            .map(|row| row.1.as_str())
            .collect::<Vec<_>>(),
        ["delete"]
    );
}

#[test]
fn native_account_import_merges_new_verify_observation_without_rewinding_epoch() {
    let f = Fixture::new("m96-import-observation");
    let ticket = f.ticket();
    let store = FakeStore::default();
    let mut observer = crate::runtime::open(&f.path).unwrap();
    observer.busy_timeout(Duration::ZERO).unwrap();
    let observed = Cell::new(0i64);
    let put = BeforePut {
        inner: &store,
        before: RefCell::new(Some(Box::new(|| {
            f.assert_unlocked();
            let mut service = ConnectionService {
                conn: &mut observer,
                store: &store,
            };
            service
                .verify(
                    &AttendedPerson::at_native_door(&owner_key()).unwrap(),
                    &selection().connection_id,
                    ticket.expected_revision,
                    &identity(),
                )
                .unwrap();
            observed.set(
                f.ordinary
                    .query_row(
                        "SELECT observation_revision FROM managed_connections",
                        [],
                        |r| r.get(0),
                    )
                    .unwrap(),
            );
        }))),
    };
    assert_eq!(
        f.owner
            .import_account(&ticket, &gh(), &identity(), &put)
            .unwrap()
            .health,
        ConnectionHealth::Ready
    );
    assert!(observed.get() > 0);
    let final_observation: i64 = f
        .ordinary
        .query_row(
            "SELECT observation_revision FROM managed_connections",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(final_observation, observed.get() + 1);
    assert_eq!(f.status().revision, ticket.expected_revision + 1);
    assert!(f.cleanup().is_empty());
}

#[test]
fn native_account_import_lost_completion_ack_preserves_the_actually_installed_secret() {
    let f = Fixture::new("m96-import-lost-completion-ack");
    let ticket = f.ticket();
    let process = gh();
    let store = FakeStore::default();
    let put = BeforePut {
        inner: &store,
        before: RefCell::new(Some(Box::new(|| {
            f.assert_unlocked();
            assert_eq!(f.cleanup().len(), 1);
            // Reserve has committed. The next transaction is exact completion;
            // lose only its acknowledgement after the real SQLite commit.
            super::tests::lose_next_transaction_ack();
        }))),
    };
    let result = super::tests::with_transaction_ack_probe(|| {
        f.owner.import_account(&ticket, &process, &identity(), &put)
    });
    assert_eq!(
        process.calls.get(),
        1,
        "must reach actual reserve/work/completion"
    );
    assert_eq!(result, Err(ConnectionError::Unavailable));
    let committed = f.status();
    assert_eq!(committed.health, ConnectionHealth::Ready);
    assert_eq!(committed.revision, ticket.expected_revision + 1);
    assert_eq!(
        f.attempt(&ticket.attempt_id).state,
        AcquisitionState::Installed
    );
    let installed_ref: String = f
        .ordinary
        .query_row(
            "SELECT json_extract(secret_ref,'$.id') FROM managed_connections",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        store.items.borrow().keys().cloned().collect::<Vec<_>>(),
        [installed_ref]
    );
    assert!(
        f.cleanup().is_empty(),
        "do not turn an uncertain reply into deletion of the installed reference"
    );
    assert!(
        f.owner
            .storage
            .try_lock()
            .unwrap()
            .owner
            .as_ref()
            .unwrap()
            .retired
    );
    assert_eq!(
        f.owner
            .import_account(&ticket, &process, &identity(), &store),
        Err(ConnectionError::Unavailable)
    );
    assert_eq!(
        process.calls.get(),
        1,
        "a lost acknowledgement cannot reopen or repeat acquisition"
    );
    assert_eq!(store.items.borrow().len(), 1);
}

// The same private production coordinator used after actual native authentication.
// These fixtures prove retained SQLite ownership only, not native window admission.
fn settings_seed(f: &Fixture, id: &str, login: &str) -> ConnectionStatus {
    match f
        .metadata(Op::Connect {
            selection: &GhSelection {
                connection_id: ConnectionId(id.into()),
                host: "github.com".into(),
                login: login.into(),
            },
        })
        .unwrap()
    {
        Out::Status(status) => status,
        _ => panic!("metadata connect must return status"),
    }
}
fn settings_status(f: &Fixture, id: &ConnectionId) -> ConnectionStatus {
    f.ordinary
        .query_row(STATUS_SQL, params![id.0, owner_key()], MetadataRecord::read)
        .unwrap()
        .status
}
fn settings_count(f: &Fixture) -> i64 {
    f.ordinary
        .query_row("SELECT count(*) FROM managed_connections", [], |row| {
            row.get(0)
        })
        .unwrap()
}

#[test]
fn native_account_settings_empty_is_measured_and_add_is_metadata_only() {
    let f = Fixture::new("m96-settings-add");
    let empty = f.owner.list_accounts(None).unwrap();
    assert!(empty.items.is_empty());
    assert_eq!(empty.next_cursor, None);
    let added = f
        .owner
        .add_account_selection("github.com", "alice")
        .unwrap();
    assert!(!added.connection_id.0.is_empty());
    assert!(
        added.connection_id.0.len()
            <= crate::actions::schema::admission_rules()
                .limits
                .identity_bytes
    );
    assert_eq!(added.login, "alice");
    assert_eq!(added.health, ConnectionHealth::SignInRequired);
    assert_eq!(added.account, None);
    assert_eq!(added.secret_revision, 0);
    assert!(!added.cleanup_pending);
    assert_eq!(settings_status(&f, &added.connection_id), added);
    let page = f.owner.list_accounts(None).unwrap();
    assert_eq!(page.items, [added]);
    assert_eq!(page.next_cursor, None);
    assert_eq!(f.grants(), 0);
    let (attempts, secrets): (i64, i64) = f.ordinary.query_row(
        "SELECT (SELECT count(*) FROM managed_connection_attempts),(SELECT count(*) FROM managed_connections WHERE secret_ref IS NOT NULL)",
        [], |r| Ok((r.get(0)?, r.get(1)?)),
    ).unwrap();
    assert_eq!((attempts, secrets), (0, 0));
    assert!(f.cleanup().is_empty());
}

#[test]
fn native_account_settings_invalid_selection_never_creates_rows() {
    let f = Fixture::new("m96-settings-selection");
    assert_eq!(
        f.owner.add_account_selection("enterprise.example", "alice"),
        Err(ConnectionError::Unsupported)
    );
    for login in ["", "-alice", "alice-", "alice smith", "alice;echo", "é"] {
        assert_eq!(
            f.owner.add_account_selection("github.com", login),
            Err(ConnectionError::InvalidSelection)
        );
    }
    assert_eq!(
        f.owner.add_account_selection("github.com", &"a".repeat(40)),
        Err(ConnectionError::InvalidSelection)
    );
    assert_eq!(settings_count(&f), 0);
    assert_eq!(f.grants(), 0);
}

#[test]
fn native_account_settings_pages_fixed_owner_rows_without_truncation() {
    let f = Fixture::new("m96-settings-pages");
    let cap = crate::actions::schema::admission_rules()
        .limits
        .catalog_page_size;
    let mut expected = Vec::new();
    for index in 0..cap + 2 {
        expected.push(settings_seed(&f, &format!("settings-{index:04}"), "alice"));
    }
    let mut foreign = expected[0].clone();
    foreign.connection_id = ConnectionId("foreign-before-settings".into());
    f.ordinary.execute("INSERT INTO managed_connections(connection_id,person,status) VALUES(?1,'human:other',?2)",
        params![foreign.connection_id.0, serde_json::to_string(&foreign).unwrap()]).unwrap();
    let first = f.owner.list_accounts(None).unwrap();
    assert_eq!(first.items, expected[..cap]);
    assert_eq!(
        first.next_cursor,
        Some(expected[cap - 1].connection_id.clone())
    );
    let next = f.owner.list_accounts(first.next_cursor).unwrap();
    assert_eq!(next.items, expected[cap..]);
    assert_eq!(next.next_cursor, None);
    assert_eq!(settings_count(&f), (cap + 3) as i64);
}

#[test]
fn native_account_settings_invalid_cursor_refuses_without_broadening_owner() {
    let f = Fixture::new("m96-settings-cursor");
    for cursor in [
        String::new(),
        "x".repeat(
            crate::actions::schema::admission_rules()
                .limits
                .identity_bytes
                + 1,
        ),
    ] {
        assert_eq!(
            f.owner.list_accounts(Some(ConnectionId(cursor))),
            Err(ConnectionError::InvalidSelection)
        );
    }
    assert_eq!(settings_count(&f), 0);
}

#[test]
fn native_account_settings_disable_cas_cancels_original_attempt() {
    let f = Fixture::new("m96-settings-disable");
    let ticket = f.ticket();
    let before = f.status();
    assert_eq!(
        f.owner
            .disable_account(&ticket.connection_id, before.revision - 1),
        Err(ConnectionError::StaleRevision)
    );
    assert_eq!(f.status(), before);
    let disabled = f
        .owner
        .disable_account(&ticket.connection_id, before.revision)
        .unwrap();
    assert_eq!(disabled.health, ConnectionHealth::Disabled);
    assert_eq!(disabled.revision, before.revision + 1);
    assert_eq!(
        disabled.revocation_generation,
        before.revocation_generation + 1
    );
    assert_eq!(
        disabled.remote_revocation,
        crate::connections::RemoteRevocation::NotAttempted
    );
    assert_eq!(
        f.attempt(&ticket.attempt_id).state,
        AcquisitionState::Cancelled
    );
    assert_eq!(f.status(), disabled);
    assert_eq!(
        f.owner
            .disable_account(&ticket.connection_id, before.revision),
        Err(ConnectionError::StaleRevision)
    );
    assert_eq!(f.status(), disabled);
    assert_eq!(f.grants(), 0);
}

#[test]
fn native_account_settings_disable_keeps_exact_cleanup_pending_without_secret_io() {
    let f = Fixture::new("m96-settings-cleanup");
    let ticket = f.ticket();
    let store = FakeStore::default();
    let installed = f
        .owner
        .import_account(&ticket, &gh(), &identity(), &store)
        .unwrap();
    let keys = store.items.borrow().keys().cloned().collect::<Vec<_>>();
    assert_eq!(keys.len(), 1);
    let disabled = f
        .owner
        .disable_account(&ticket.connection_id, installed.revision)
        .unwrap();
    assert_eq!(disabled.health, ConnectionHealth::Disabled);
    assert!(disabled.cleanup_pending);
    assert_eq!(disabled.account, installed.account);
    assert_eq!(
        store.items.borrow().keys().cloned().collect::<Vec<_>>(),
        keys
    );
    assert_eq!(f.cleanup(), vec![(keys[0].clone(), "delete".into())]);
    assert_eq!(
        disabled.remote_revocation,
        crate::connections::RemoteRevocation::NotAttempted
    );
}

#[test]
fn native_account_settings_corrupt_oversized_or_crosswired_row_is_unavailable() {
    for scenario in ["oversized", "crosswired"] {
        let f = Fixture::new(&format!("m96-settings-{scenario}"));
        let seeded = settings_seed(&f, "settings-corrupt", "alice");
        assert_eq!(
            f.owner.list_accounts(None).unwrap().items.as_slice(),
            std::slice::from_ref(&seeded)
        );
        let mut raw = serde_json::to_value(&seeded).unwrap();
        if scenario == "oversized" {
            raw["unknownPadding"] = serde_json::json!(
                "x".repeat(crate::actions::schema::admission_rules().limits.grant_bytes + 1)
            );
        } else {
            raw["connectionId"] = serde_json::json!("another-physical-id");
        }
        let encoded = serde_json::to_string(&raw).unwrap();
        assert!(f
            .ordinary
            .execute(
                "UPDATE managed_connections SET status=?1 WHERE connection_id=?2",
                params![encoded, seeded.connection_id.0]
            )
            .is_err());
        f.ordinary
            .execute_batch("PRAGMA ignore_check_constraints=ON")
            .unwrap();
        f.ordinary
            .execute(
                "UPDATE managed_connections SET status=?1 WHERE connection_id=?2",
                params![encoded, seeded.connection_id.0],
            )
            .unwrap();
        f.ordinary
            .execute_batch("PRAGMA ignore_check_constraints=OFF")
            .unwrap();
        assert_eq!(
            f.owner.list_accounts(None),
            Err(ConnectionError::Unavailable)
        );
        let after: String = f
            .ordinary
            .query_row(
                "SELECT status FROM managed_connections WHERE connection_id=?1",
                [&seeded.connection_id.0],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(after, encoded);
    }
}

#[test]
fn native_account_settings_missing_or_retired_original_owner_refuses_no_reopen() {
    let f = Fixture::new("m96-settings-retired");
    assert!(f.owner.list_accounts(None).unwrap().items.is_empty());
    f.owner.registration.live.store(false, Ordering::SeqCst);
    assert_eq!(
        f.owner.add_account_selection("github.com", "alice"),
        Err(ConnectionError::Unavailable)
    );
    assert_eq!(
        f.owner.list_accounts(None),
        Err(ConnectionError::Unavailable)
    );
    assert_eq!(settings_count(&f), 0);
    let f = Fixture::new("m96-settings-missing-owner");
    f.owner.storage.lock().unwrap().owner = None;
    assert_eq!(
        f.owner.add_account_selection("github.com", "alice"),
        Err(ConnectionError::Unavailable)
    );
    assert_eq!(
        f.owner.list_accounts(None),
        Err(ConnectionError::Unavailable)
    );
    assert!(f.owner.storage.lock().unwrap().owner.is_none());
    assert_eq!(settings_count(&f), 0);
}

#[test]
fn native_account_settings_replaced_runtime_retires_without_adopting_same_bytes() {
    let f = Fixture::new("m96-settings-replaced");
    assert!(f.owner.list_accounts(None).unwrap().items.is_empty());
    let path = crate::runtime::runtime_db_path(&f.path);
    let original = f.path.join("settings.original.db");
    let replacement = f.path.join("settings.replacement.db");
    f.ordinary
        .execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
        .unwrap();
    fs::copy(&path, &replacement).unwrap();
    fs::rename(&path, &original).unwrap();
    fs::rename(&replacement, &path).unwrap();
    assert_eq!(
        f.owner.add_account_selection("github.com", "alice"),
        Err(ConnectionError::Unavailable)
    );
    assert!(
        f.owner
            .storage
            .lock()
            .unwrap()
            .owner
            .as_ref()
            .unwrap()
            .retired
    );
    assert_eq!(settings_count(&f), 0);
    fs::remove_file(&path).unwrap();
    fs::rename(&original, &path).unwrap();
    assert_eq!(
        f.owner.add_account_selection("github.com", "alice"),
        Err(ConnectionError::Unavailable)
    );
    assert_eq!(settings_count(&f), 0);
}

#[test]
fn native_account_settings_lost_add_ack_preserves_actual_row_and_retires_owner() {
    let f = Fixture::new("m96-settings-uncertain");
    let result = super::tests::with_transaction_ack_probe(|| {
        super::tests::lose_next_transaction_ack();
        f.owner.add_account_selection("github.com", "alice")
    });
    assert_eq!(result, Err(ConnectionError::Unavailable));
    assert_eq!(
        settings_count(&f),
        1,
        "the real transaction committed before acknowledgement loss"
    );
    assert!(
        f.owner
            .storage
            .lock()
            .unwrap()
            .owner
            .as_ref()
            .unwrap()
            .retired
    );
    assert_eq!(
        f.owner.add_account_selection("github.com", "alice"),
        Err(ConnectionError::Unavailable)
    );
    assert_eq!(
        settings_count(&f),
        1,
        "no retry/reopen may create another row"
    );
}

fn settings_other_ticket(f: &Fixture) -> CredentialAcquisition {
    let selected = GhSelection {
        connection_id: ConnectionId("native-import-other".into()),
        host: "github.com".into(),
        login: "bob".into(),
    };
    let first = settings_seed(f, &selected.connection_id.0, &selected.login);
    match f
        .metadata(Op::BeginImport {
            selection: &selected,
            expected: first.revision,
        })
        .unwrap()
    {
        Out::Acquisition(value) => value,
        _ => panic!("begin returns acquisition"),
    }
}
fn settings_binding_bytes(f: &Fixture) -> Vec<(String, String, Option<String>, i64)> {
    let mut statement = f.ordinary.prepare(
        "SELECT connection_id,status,active_attempt,observation_revision FROM managed_connections ORDER BY connection_id"
    ).unwrap();
    let rows = statement
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
        .unwrap();
    rows.collect::<rusqlite::Result<Vec<_>>>().unwrap()
}

#[test]
fn native_account_settings_disable_refuses_same_owner_cross_connection_attempt() {
    let f = Fixture::new("m96-settings-cross-connection-attempt");
    let original = f.ticket();
    let foreign = settings_other_ticket(&f);
    assert_ne!(original.connection_id, foreign.connection_id);
    assert_eq!(original.person, foreign.person);
    // V32 permits this 32-byte active-attempt selector. No constraint bypass,
    // forged ticket payload or fake metadata coordinator supplies this defect.
    assert_eq!(
        f.ordinary
            .execute(
                "UPDATE managed_connections SET active_attempt=?1 WHERE connection_id=?2",
                params![foreign.attempt_id.0, original.connection_id.0],
            )
            .unwrap(),
        1
    );
    let before = settings_binding_bytes(&f);
    let outcome = f.metadata(Op::Disable {
        connection: &original.connection_id,
        expected: original.expected_revision,
    });
    assert_eq!(outcome, Err(ConnectionError::Unavailable));
    assert_eq!(settings_binding_bytes(&f), before);
    assert_eq!(f.attempt(&original.attempt_id), original);
    assert_eq!(f.attempt(&foreign.attempt_id), foreign);
    assert!(f.cleanup().is_empty());
    assert_eq!(f.grants(), 0);
}

#[test]
fn native_account_settings_disable_same_connection_preserves_other_pending_ticket() {
    let f = Fixture::new("m96-settings-same-connection-control");
    let original = f.ticket();
    let foreign = settings_other_ticket(&f);
    let other_status = settings_status(&f, &foreign.connection_id);
    let outcome = f
        .metadata(Op::Disable {
            connection: &original.connection_id,
            expected: original.expected_revision,
        })
        .unwrap();
    let Out::Status(disabled) = outcome else {
        panic!("disable returns status")
    };
    assert_eq!(disabled.connection_id, original.connection_id);
    assert_eq!(disabled.health, ConnectionHealth::Disabled);
    assert_eq!(disabled.revision, original.expected_revision + 1);
    assert_eq!(
        f.attempt(&original.attempt_id).state,
        AcquisitionState::Cancelled
    );
    assert_eq!(f.attempt(&foreign.attempt_id), foreign);
    assert_eq!(settings_status(&f, &foreign.connection_id), other_status);
    assert!(f.cleanup().is_empty());
    assert_eq!(f.grants(), 0);
}

// Acquisition bridge RED. These call the same private retained owner that the
// admitted native producer must retain; fixture registration is not a gesture.
fn bridge_connect(f: &Fixture) -> ConnectionStatus {
    match f
        .metadata(Op::Connect {
            selection: &selection(),
        })
        .unwrap()
    {
        Out::Status(value) => value,
        _ => panic!("connect returns status"),
    }
}
fn bridge_attempt_count(f: &Fixture) -> i64 {
    f.ordinary
        .query_row(
            "SELECT count(*) FROM managed_connection_attempts",
            [],
            |r| r.get(0),
        )
        .unwrap()
}
fn bridge_owner_changes(f: &Fixture) -> i64 {
    let storage = f.owner.storage.try_lock().unwrap();
    storage
        .owner
        .as_ref()
        .unwrap()
        .conn
        .query_row("SELECT total_changes()", [], |r| r.get(0))
        .unwrap()
}

#[test]
fn native_account_bridge_begin_durably_binds_exact_selection_on_original_owner() {
    let f = Fixture::new("m96-bridge-begin");
    let first = bridge_connect(&f);
    let ticket = f
        .owner
        .begin_account_acquisition(&selection(), first.revision)
        .unwrap();
    assert_eq!(ticket.connection_id, first.connection_id);
    assert_eq!(ticket.person, owner_key());
    assert_eq!(ticket.host, "github.com");
    assert_eq!(ticket.login, "alice");
    assert_eq!(ticket.expected_revision, first.revision + 1);
    assert_eq!(ticket.revocation_generation, first.revocation_generation);
    assert_eq!(ticket.state, AcquisitionState::Pending);
    assert_eq!(f.attempt(&ticket.attempt_id), ticket);
    assert_eq!(f.status().revision, ticket.expected_revision);
    assert_eq!(f.status().health, ConnectionHealth::SignInRequired);
    assert!(f.status().account.is_none());
    assert!(f.cleanup().is_empty());
    assert_eq!(f.grants(), 0);
    assert_eq!(bridge_attempt_count(&f), 1);
    f.assert_unlocked();
}

#[test]
fn native_account_bridge_handoff_reuses_existing_unlocked_import_coordinator() {
    let f = Fixture::new("m96-bridge-handoff");
    let first = bridge_connect(&f);
    let ticket = f
        .owner
        .begin_account_acquisition(&selection(), first.revision)
        .unwrap();
    let process = gh();
    let store = FakeStore::default();
    let observe = |_: &'static str| {
        f.assert_unlocked();
        assert_eq!(f.attempt(&ticket.attempt_id), ticket);
    };
    let observed = ObservedGh {
        inner: &process,
        observe: &observe,
    };
    let put = BeforePut {
        inner: &store,
        before: RefCell::new(Some(Box::new(|| {
            f.assert_unlocked();
            assert_eq!(f.cleanup().len(), 1);
        }))),
    };
    let status = f
        .owner
        .import_account(&ticket, &observed, &identity(), &put)
        .unwrap();
    assert_eq!(status.health, ConnectionHealth::Ready);
    assert_eq!(status, f.status());
    assert_eq!(process.calls.get(), 1);
    assert_eq!(
        f.owner
            .account_acquisition(&ticket.attempt_id)
            .unwrap()
            .state,
        AcquisitionState::Installed
    );
    assert_eq!(store.items.borrow().len(), 1);
    assert_eq!(f.grants(), 0);
    assert!(f.cleanup().is_empty());
    let encoded = serde_json::to_string(&status).unwrap();
    assert!(!encoded.contains(SENTINEL));
    assert!(!encoded.contains("secretRef"));
}

#[test]
fn native_account_bridge_begin_rejects_stale_and_changed_login_before_mutation() {
    let f = Fixture::new("m96-bridge-stale-selection");
    let first = bridge_connect(&f);
    let before = bridge_owner_changes(&f);
    assert_eq!(
        f.owner
            .begin_account_acquisition(&selection(), first.revision + 1),
        Err(ConnectionError::StaleRevision)
    );
    let mut wrong = selection();
    wrong.login = "bob".into();
    assert_eq!(
        f.owner.begin_account_acquisition(&wrong, first.revision),
        Err(ConnectionError::InvalidSelection)
    );
    wrong = selection();
    wrong.host = "elsewhere.invalid".into();
    assert_eq!(
        f.owner.begin_account_acquisition(&wrong, first.revision),
        Err(ConnectionError::Unsupported)
    );
    assert_eq!(f.status(), first);
    assert_eq!(bridge_owner_changes(&f), before);
    assert_eq!(bridge_attempt_count(&f), 0);
    assert_eq!(f.grants(), 0);
    assert!(f.cleanup().is_empty());
}

#[test]
fn native_account_bridge_poll_is_exact_and_does_not_write_or_reimport() {
    let f = Fixture::new("m96-bridge-poll");
    let ticket = f.ticket();
    let before_status = f.status();
    let before_changes = bridge_owner_changes(&f);
    for _ in 0..2 {
        assert_eq!(
            f.owner.account_acquisition(&ticket.attempt_id).unwrap(),
            ticket
        );
    }
    assert_eq!(
        f.owner
            .account_acquisition(&AttemptId("unknown-attempt".into())),
        Err(ConnectionError::NotFound)
    );
    assert_eq!(f.status(), before_status);
    assert_eq!(f.attempt(&ticket.attempt_id), ticket);
    assert_eq!(bridge_owner_changes(&f), before_changes);
    assert_eq!(bridge_attempt_count(&f), 1);
    assert!(f.cleanup().is_empty());
    assert_eq!(f.grants(), 0);
}

#[test]
fn native_account_bridge_cancel_blocks_late_handoff_without_credential_work() {
    let f = Fixture::new("m96-bridge-cancel");
    let ticket = f.ticket();
    let cancelled = f
        .owner
        .cancel_account_acquisition(&ticket.attempt_id)
        .unwrap();
    assert_eq!(cancelled.state, AcquisitionState::Cancelled);
    assert_eq!(cancelled.error, Some(ConnectionError::Cancelled));
    assert_eq!(f.attempt(&ticket.attempt_id), cancelled);
    assert_eq!(f.status().revision, ticket.expected_revision + 1);
    let before_changes = bridge_owner_changes(&f);
    assert_eq!(
        f.owner
            .cancel_account_acquisition(&ticket.attempt_id)
            .unwrap(),
        cancelled
    );
    assert_eq!(bridge_owner_changes(&f), before_changes);
    let process = gh();
    let store = FakeStore::default();
    assert_eq!(
        f.owner
            .import_account(&ticket, &process, &identity(), &store),
        Err(ConnectionError::Cancelled)
    );
    assert_eq!(process.calls.get(), 0);
    assert!(store.items.borrow().is_empty());
    assert!(f.cleanup().is_empty());
    assert_eq!(f.grants(), 0);
}

#[test]
fn native_account_bridge_missing_or_retired_owner_never_reopens() {
    let f = Fixture::new("m96-bridge-retired");
    let ticket = f.ticket();
    let before = f.status();
    f.owner.registration.live.store(false, Ordering::SeqCst);
    assert_eq!(
        f.owner
            .begin_account_acquisition(&selection(), before.revision),
        Err(ConnectionError::Unavailable)
    );
    assert_eq!(
        f.owner.account_acquisition(&ticket.attempt_id),
        Err(ConnectionError::Unavailable)
    );
    assert_eq!(
        f.owner.cancel_account_acquisition(&ticket.attempt_id),
        Err(ConnectionError::Unavailable)
    );
    assert_eq!(f.status(), before);
    assert_eq!(f.attempt(&ticket.attempt_id), ticket);
    let f = Fixture::new("m96-bridge-owner-missing");
    let ticket = f.ticket();
    f.owner.storage.lock().unwrap().owner = None;
    assert_eq!(
        f.owner.account_acquisition(&ticket.attempt_id),
        Err(ConnectionError::Unavailable)
    );
    assert_eq!(
        f.owner.cancel_account_acquisition(&ticket.attempt_id),
        Err(ConnectionError::Unavailable)
    );
    assert!(f.owner.storage.lock().unwrap().owner.is_none());
    assert_eq!(f.attempt(&ticket.attempt_id), ticket);
}

#[test]
fn native_account_bridge_begin_lost_ack_keeps_pending_row_and_retires_original() {
    let f = Fixture::new("m96-bridge-begin-lost-ack");
    let first = bridge_connect(&f);
    let result = super::tests::with_transaction_ack_probe(|| {
        super::tests::lose_next_transaction_ack();
        f.owner
            .begin_account_acquisition(&selection(), first.revision)
    });
    assert_eq!(result, Err(ConnectionError::Unavailable));
    assert_eq!(
        bridge_attempt_count(&f),
        1,
        "actual begin committed before acknowledgement was lost"
    );
    let raw: String = f
        .ordinary
        .query_row("SELECT payload FROM managed_connection_attempts", [], |r| {
            r.get(0)
        })
        .unwrap();
    let actual: CredentialAcquisition = serde_json::from_str(&raw).unwrap();
    assert_eq!(actual.state, AcquisitionState::Pending);
    assert_eq!(actual.expected_revision, first.revision + 1);
    assert_eq!(f.status().revision, actual.expected_revision);
    let held = f.owner.storage.try_lock().unwrap();
    assert!(held.failed);
    assert!(held.owner.as_ref().unwrap().retired);
    drop(held);
    assert_eq!(
        f.owner
            .begin_account_acquisition(&selection(), f.status().revision),
        Err(ConnectionError::Unavailable)
    );
    assert_eq!(
        bridge_attempt_count(&f),
        1,
        "no retry through a replacement owner"
    );
    assert_eq!(f.grants(), 0);
    assert!(f.cleanup().is_empty());
}

#[test]
fn native_account_bridge_poll_replacement_retires_without_adopting_same_bytes() {
    let f = Fixture::new("m96-bridge-poll-replacement");
    let ticket = f.ticket();
    let path = crate::runtime::runtime_db_path(&f.path);
    let original = f.path.join("bridge.original.db");
    let replacement = f.path.join("bridge.replacement.db");
    f.ordinary
        .execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
        .unwrap();
    fs::copy(&path, &replacement).unwrap();
    fs::rename(&path, &original).unwrap();
    fs::rename(&replacement, &path).unwrap();
    assert_eq!(
        f.owner.account_acquisition(&ticket.attempt_id),
        Err(ConnectionError::Unavailable)
    );
    assert!(
        f.owner
            .storage
            .lock()
            .unwrap()
            .owner
            .as_ref()
            .unwrap()
            .retired
    );
    fs::remove_file(&path).unwrap();
    fs::rename(&original, &path).unwrap();
    assert_eq!(
        f.owner.account_acquisition(&ticket.attempt_id),
        Err(ConnectionError::Unavailable)
    );
    assert_eq!(f.attempt(&ticket.attempt_id), ticket);
    assert_eq!(f.status().health, ConnectionHealth::SignInRequired);
    assert_eq!(f.grants(), 0);
    assert!(f.cleanup().is_empty());
}

// Public bridge core: these descriptive Fixtures are NOT native authentication.
// Native Wry acceptance invokes the same production commands separately.
use super::native_account_commands::{
    begin_owned_import_for_test, begin_owned_on_owner,
    handoff_probe::Control as OwnedHandoffControl,
};

fn assert_owned_bridge_empty_effects(f: &Fixture) {
    assert_eq!(bridge_attempt_count(f), 1);
    assert!(f.cleanup().is_empty());
    assert_eq!(f.grants(), 0);
    let references: i64 = f
        .ordinary
        .query_row(
            "SELECT count(*) FROM managed_connections WHERE secret_ref IS NOT NULL",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(references, 0);
}

// Removing actual Worker handoff or holding native/SQLite guards across its
// task gate makes Pending/poll/cancel or the independent writer assertion fail.
#[test]
fn native_credential_owned_handoff_pending_poll_cancel_before_adapter() {
    let f = Fixture::new("m96-owned-handoff-cancel");
    let first = bridge_connect(&f);
    let control = OwnedHandoffControl::new(false, false);
    let (pending, adapter) = control
        .enter(|| begin_owned_import_for_test(f.owner.clone(), &selection(), first.revision))
        .unwrap();
    control.wait_until_parked();
    f.assert_unlocked();
    assert_eq!(pending.state, AcquisitionState::Pending);
    assert_eq!(pending.connection_id, first.connection_id);
    assert_eq!(pending.expected_revision, first.revision + 1);
    let changes = bridge_owner_changes(&f);
    assert_eq!(
        crate::connections::metadata::CredentialAcquisitionView::from(
            &f.owner.account_acquisition(&pending.attempt_id).unwrap()
        ),
        pending,
    );
    assert_eq!(bridge_owner_changes(&f), changes, "poll is SELECT-only");
    assert_eq!(adapter.snapshot().unwrap(), [0; 3]);
    let cancelled = f
        .owner
        .cancel_account_acquisition(&pending.attempt_id)
        .unwrap();
    let expected = crate::connections::metadata::CredentialAcquisitionView::from(&cancelled);
    assert_eq!(expected.state, AcquisitionState::Cancelled);
    let status = f.status();
    assert_eq!(control.release_and_wait(), Ok(expected));
    assert_eq!(
        adapter.snapshot().unwrap(),
        [0; 3],
        "late work never reaches any adapter"
    );
    assert_eq!(f.status(), status);
    assert_eq!(f.attempt(&pending.attempt_id), cancelled);
    assert_eq!(control.launches(), (1, 1));
    assert_owned_bridge_empty_effects(&f);
}

#[test]
fn native_credential_owned_handoff_unavailable_settles_after_pending_once() {
    let f = Fixture::new("m96-owned-handoff-unavailable");
    let first = bridge_connect(&f);
    let control = OwnedHandoffControl::new(false, false);
    let pending = control
        .enter(|| begin_owned_on_owner(f.owner.clone(), &selection(), first.revision))
        .unwrap();
    control.wait_until_parked();
    f.assert_unlocked();
    assert_eq!(pending.state, AcquisitionState::Pending);
    assert_eq!(
        f.attempt(&pending.attempt_id).state,
        AcquisitionState::Pending
    );
    let terminal = control.release_and_wait().unwrap();
    assert_eq!(terminal.attempt_id, pending.attempt_id);
    assert_eq!(terminal.state, AcquisitionState::Failed);
    assert_eq!(terminal.error, Some(ConnectionError::Unavailable));
    let actual = f.owner.account_acquisition(&pending.attempt_id).unwrap();
    assert_eq!(
        crate::connections::metadata::CredentialAcquisitionView::from(&actual),
        terminal
    );
    assert_eq!(
        f.owner
            .cancel_account_acquisition(&pending.attempt_id)
            .unwrap(),
        actual
    );
    assert_eq!(f.status().health, ConnectionHealth::Unavailable);
    assert_eq!(f.status().revision, first.revision + 2);
    assert_eq!(control.launches(), (1, 1));
    assert_owned_bridge_empty_effects(&f);
}

#[test]
fn native_credential_owned_handoff_lost_begin_ack_launches_no_task_or_retry() {
    let f = Fixture::new("m96-owned-handoff-lost-ack");
    let first = bridge_connect(&f);
    let control = OwnedHandoffControl::new(false, false);
    let result = control.enter(|| {
        super::tests::with_transaction_ack_probe(|| {
            super::tests::lose_next_transaction_ack();
            begin_owned_on_owner(f.owner.clone(), &selection(), first.revision)
        })
    });
    assert_eq!(result, Err(ConnectionError::Unavailable));
    assert_eq!(control.launches(), (0, 0));
    assert_eq!(
        bridge_attempt_count(&f),
        1,
        "real commit preceded lost acknowledgement"
    );
    let raw: String = f
        .ordinary
        .query_row(
            "SELECT payload FROM managed_connection_attempts",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let ticket: CredentialAcquisition = serde_json::from_str(&raw).unwrap();
    assert_eq!(ticket.state, AcquisitionState::Pending);
    assert_eq!(
        f.owner.account_acquisition(&ticket.attempt_id),
        Err(ConnectionError::Unavailable)
    );
    assert_eq!(
        control.enter(|| begin_owned_on_owner(f.owner.clone(), &selection(), f.status().revision)),
        Err(ConnectionError::Unavailable)
    );
    assert_eq!(control.launches(), (0, 0));
    assert_owned_bridge_empty_effects(&f);
}

#[test]
fn native_credential_owned_handoff_worker_launch_failure_never_acknowledges_pending() {
    let f = Fixture::new("m96-owned-handoff-worker-failure");
    let first = bridge_connect(&f);
    let control = OwnedHandoffControl::new(true, false);
    assert_eq!(
        control.enter(|| begin_owned_on_owner(f.owner.clone(), &selection(), first.revision)),
        Err(ConnectionError::Unavailable)
    );
    assert_eq!(control.launches(), (1, 0));
    let raw: String = f
        .ordinary
        .query_row(
            "SELECT payload FROM managed_connection_attempts",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let ticket: CredentialAcquisition = serde_json::from_str(&raw).unwrap();
    assert_eq!(ticket.state, AcquisitionState::Failed);
    assert_eq!(ticket.error, Some(ConnectionError::Unavailable));
    assert_eq!(f.status().health, ConnectionHealth::Unavailable);
    assert_owned_bridge_empty_effects(&f);
}

#[test]
fn native_credential_owned_handoff_join_launch_failure_owns_terminalization() {
    let f = Fixture::new("m96-owned-handoff-join-failure");
    let first = bridge_connect(&f);
    let control = OwnedHandoffControl::new(false, true);
    assert_eq!(
        control.enter(|| begin_owned_on_owner(f.owner.clone(), &selection(), first.revision)),
        Err(ConnectionError::Unavailable)
    );
    assert_eq!(control.launches(), (1, 1));
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    let ticket = loop {
        let raw: String = f
            .ordinary
            .query_row(
                "SELECT payload FROM managed_connection_attempts",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let ticket: CredentialAcquisition = serde_json::from_str(&raw).unwrap();
        if ticket.state != AcquisitionState::Pending {
            break ticket;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "original worker must terminalize failed transfer"
        );
        std::thread::yield_now();
    };
    control.wait_worker_finished();
    assert_eq!(
        ticket.state,
        AcquisitionState::Failed,
        "the exact original worker owns failed-transfer terminalization"
    );
    assert_eq!(ticket.error, Some(ConnectionError::Unavailable));
    assert_eq!(f.status().health, ConnectionHealth::Unavailable);
    assert_owned_bridge_empty_effects(&f);
}

#[test]
fn native_credential_owned_handoff_response_abandonment_does_not_abandon_worker() {
    let f = Fixture::new("m96-owned-handoff-abandoned-response");
    let first = bridge_connect(&f);
    let control = OwnedHandoffControl::new(false, false);
    control.enter(|| {
        // Drop the entire response without reading its identity or retaining a
        // caller-owned task handle. Storage and the background join still own it.
        drop(begin_owned_on_owner(
            f.owner.clone(),
            &selection(),
            first.revision,
        ));
    });
    control.wait_until_parked();
    f.assert_unlocked();
    let raw: String = f
        .ordinary
        .query_row(
            "SELECT payload FROM managed_connection_attempts",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let ticket: CredentialAcquisition = serde_json::from_str(&raw).unwrap();
    assert_eq!(ticket.state, AcquisitionState::Pending);
    let terminal = control.release_and_wait().unwrap();
    assert_eq!(terminal.attempt_id, ticket.attempt_id);
    assert_eq!(terminal.state, AcquisitionState::Failed);
    assert_eq!(terminal.error, Some(ConnectionError::Unavailable));
    assert_eq!(control.launches(), (1, 1));
    assert_owned_bridge_empty_effects(&f);
}

#[test]
fn native_credential_owned_handoff_replaced_runtime_never_adopts_new_owner() {
    let f = Fixture::new("m96-owned-handoff-replacement");
    let first = bridge_connect(&f);
    let control = OwnedHandoffControl::new(false, false);
    let pending = control
        .enter(|| begin_owned_on_owner(f.owner.clone(), &selection(), first.revision))
        .unwrap();
    control.wait_until_parked();
    f.assert_unlocked();
    let original_ticket = f.attempt(&pending.attempt_id);
    let current = crate::runtime::runtime_db_path(&f.path);
    let held = f.path.join("owned-handoff.original.db");
    let replacement = f.path.join("owned-handoff.replacement.db");
    f.ordinary
        .execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
        .unwrap();
    fs::copy(&current, &replacement).unwrap();
    fs::rename(&current, &held).unwrap();
    fs::rename(&replacement, &current).unwrap();
    let completion = control.release_and_wait();
    let replacement_read = Connection::open(&current).unwrap();
    let replacement_attempt: String = replacement_read
        .query_row(
            "SELECT payload FROM managed_connection_attempts",
            [],
            |row| row.get(0),
        )
        .unwrap();
    drop(replacement_read);
    fs::remove_file(&current).unwrap();
    fs::rename(&held, &current).unwrap();
    assert_eq!(completion, Err(ConnectionError::Unavailable));
    assert_eq!(
        serde_json::from_str::<CredentialAcquisition>(&replacement_attempt).unwrap(),
        original_ticket
    );
    assert_eq!(f.attempt(&pending.attempt_id), original_ticket);
    assert_eq!(
        f.owner.account_acquisition(&pending.attempt_id),
        Err(ConnectionError::Unavailable)
    );
    let state = f.owner.storage.try_lock().unwrap();
    assert!(state.failed);
    assert!(state.owner.as_ref().unwrap().retired);
    drop(state);
    assert_eq!(control.launches(), (1, 1));
    assert_owned_bridge_empty_effects(&f);
}

#[test]
fn native_credential_owned_handoff_retired_registration_does_not_complete_elsewhere() {
    let f = Fixture::new("m96-owned-handoff-retired");
    let first = bridge_connect(&f);
    let control = OwnedHandoffControl::new(false, false);
    let pending = control
        .enter(|| begin_owned_on_owner(f.owner.clone(), &selection(), first.revision))
        .unwrap();
    control.wait_until_parked();
    let ticket = f.attempt(&pending.attempt_id);
    f.owner.registration.live.store(false, Ordering::SeqCst);
    assert_eq!(
        control.release_and_wait(),
        Err(ConnectionError::Unavailable)
    );
    assert_eq!(f.attempt(&pending.attempt_id), ticket);
    assert_eq!(
        f.owner.account_acquisition(&pending.attempt_id),
        Err(ConnectionError::Unavailable)
    );
    assert_eq!(control.launches(), (1, 1));
    assert_owned_bridge_empty_effects(&f);
}

#[test]
fn gh_selected_capture_contract_identity_error_cannot_install_on_original_owner() {
    struct RefusedIdentity {
        error: ConnectionError,
        calls: Cell<usize>,
    }
    impl IdentityReader for RefusedIdentity {
        fn authenticated_identity(
            &self,
            _: &SecretValue,
        ) -> Result<ProviderIdentity, ConnectionError> {
            self.calls.set(self.calls.get() + 1);
            Err(self.error)
        }
    }

    struct NeverStore {
        calls: Cell<usize>,
    }
    impl crate::connections::secrets::SecretStore for NeverStore {
        fn put(
            &self,
            _: &crate::connections::secrets::SecretRef,
            _: &SecretValue,
        ) -> Result<(), ConnectionError> {
            self.calls.set(self.calls.get() + 1);
            Err(ConnectionError::Unavailable)
        }
        fn resolve(
            &self,
            _: &crate::connections::secrets::SecretRef,
        ) -> Result<SecretValue, ConnectionError> {
            self.calls.set(self.calls.get() + 1);
            Err(ConnectionError::Unavailable)
        }
        fn delete(
            &self,
            _: &crate::connections::secrets::SecretRef,
        ) -> Result<(), ConnectionError> {
            self.calls.set(self.calls.get() + 1);
            Err(ConnectionError::Unavailable)
        }
    }

    for error in [
        ConnectionError::Unsupported,
        ConnectionError::IdentityMismatch,
    ] {
        let f = Fixture::new("m96-selected-identity-refused");
        let ticket = f.ticket();
        let process = gh();
        let refused = RefusedIdentity {
            error,
            calls: Cell::new(0),
        };
        let store = NeverStore {
            calls: Cell::new(0),
        };
        assert_eq!(
            f.owner.import_account(&ticket, &process, &refused, &store),
            Err(error)
        );
        assert_eq!(process.calls.get(), 1);
        assert_eq!(refused.calls.get(), 1);
        let attempt = f.attempt(&ticket.attempt_id);
        assert_eq!(attempt.state, AcquisitionState::Failed);
        assert_eq!(attempt.error, Some(error));
        let status = f.status();
        assert!(status.account.is_none());
        assert_eq!(status.secret_revision, 0);
        assert!(f.cleanup().is_empty());
        assert_eq!(
            store.calls.get(),
            0,
            "no store operation before verified identity"
        );
        assert_eq!(f.grants(), 0);
    }
}

#[path = "native_credential_owner_tests.rs"]
mod credential_owner_tests;

#[path = "native_action_account_hooks_tests.rs"]
mod action_hooks;
