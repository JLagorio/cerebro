//! Native-owner boundary and real SQLite lineage probes. No OS gesture claim.
use super::*;
use std::sync::atomic::Ordering;
#[cfg(target_os = "macos")]
use std::{fs, time::Duration};

fn dir(label: &str) -> PathBuf {
    crate::vault::testutil::temp_vault(label)
        .canonicalize()
        .unwrap()
}
fn identity(view: usize) -> NativeWindowIdentity {
    NativeWindowIdentity {
        window: 100,
        view,
        label: "main".into(),
    }
}
fn registration(origin: &Path) -> Arc<WindowRegistration> {
    Arc::new(WindowRegistration {
        identity: identity(200),
        origin: origin.to_owned(),
        live: AtomicBool::new(true),
    })
}
fn observation(owner: &Arc<WindowRegistration>) -> WindowObservation {
    WindowObservation {
        registration: owner.clone(),
        injected: identity(200),
        current: identity(200),
        origin: owner.origin.clone(),
        entry: Url::parse("tauri://localhost/").unwrap(),
    }
}

// Removing native app Arc, view identity, liveness or origin admission makes
// at least one denial below become success. Fixture observations call the
// production comparison; actual Tauri getter/injection needs root native smoke.
#[test]
fn native_owner_matches_registered_app_window_and_guarded_entry() {
    let origin = dir("m96-native-window");
    let owner = registration(&origin);
    assert_eq!(verify_window(&owner, &observation(&owner), None), Ok(()));
    let mut observed = observation(&owner);
    observed.registration = registration(&origin);
    assert_eq!(
        verify_window(&owner, &observed, None),
        Err(NativeOwnerError::Unavailable)
    );
    observed = observation(&owner);
    observed.injected.view = 201;
    assert!(verify_window(&owner, &observed, None).is_err());
    observed = observation(&owner);
    observed.current.window = 101;
    assert!(verify_window(&owner, &observed, None).is_err());
    observed = observation(&owner);
    observed.entry = Url::parse("https://example.invalid/").unwrap();
    assert!(verify_window(&owner, &observed, None).is_err());
    observed = observation(&owner);
    observed.entry = Url::parse("tauri://localhost/?forged=1").unwrap();
    assert!(verify_window(&owner, &observed, None).is_err());
    observed = observation(&owner);
    observed.origin = dir("m96-native-other-origin");
    assert!(verify_window(&owner, &observed, None).is_err());
    owner.live.store(false, Ordering::SeqCst);
    assert!(verify_window(&owner, &observation(&owner), None).is_err());
}

#[cfg(target_os = "macos")]
fn seeded(label: &str) -> (PathBuf, Connection) {
    let data = dir(label);
    let ordinary = crate::runtime::open(&data).unwrap();
    ordinary
        .execute_batch("CREATE TABLE m96_native_probe(value INTEGER NOT NULL); INSERT INTO m96_native_probe VALUES(10);")
        .unwrap();
    (data, ordinary)
}
#[cfg(target_os = "macos")]
fn sql<T>(value: rusqlite::Result<T>) -> Result<T, NativeOwnerError> {
    value.map_err(|_| NativeOwnerError::Unavailable)
}

// Real ordinary and owned connections must share normal POSIX read/write and
// contention behavior. Choosing unix-excl or abandoning the owned transaction
// makes a commit/visibility/contention assertion below fail.
#[test]
#[cfg(target_os = "macos")]
fn native_owner_runtime_shares_commits_and_normal_transaction_contention() {
    let (data, ordinary) = seeded("m96-native-posix");
    let mut owner =
        RuntimeOwner::open_existing(&data).expect("native owner opens existing runtime");
    owner
        .transaction(|tx| {
            sql(tx.execute("INSERT INTO m96_native_probe VALUES(20)", []))?;
            Ok(())
        })
        .unwrap();
    assert_eq!(
        ordinary
            .query_row("SELECT sum(value) FROM m96_native_probe", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        30
    );
    ordinary
        .execute("INSERT INTO m96_native_probe VALUES(30)", [])
        .unwrap();
    assert_eq!(
        owner
            .conn
            .query_row("SELECT sum(value) FROM m96_native_probe", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        60
    );
    owner.conn.busy_timeout(Duration::ZERO).unwrap();
    ordinary.execute_batch("BEGIN IMMEDIATE").unwrap();
    assert!(owner
        .transaction(
            |tx| sql(tx.execute("INSERT INTO m96_native_probe VALUES(40)", [])).map(|_| ())
        )
        .is_err());
    ordinary.execute_batch("ROLLBACK").unwrap();
    owner
        .transaction(|tx| {
            sql(tx.execute("INSERT INTO m96_native_probe VALUES(40)", [])).map(|_| ())
        })
        .unwrap();
    assert_eq!(
        ordinary
            .query_row("SELECT sum(value) FROM m96_native_probe", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        100
    );
}

#[test]
#[cfg(target_os = "macos")]
fn native_owner_runtime_refuses_missing_wrong_schema_and_unsafe_directory() {
    use std::os::unix::fs::PermissionsExt;
    let data = dir("m96-native-no-create");
    assert!(RuntimeOwner::open_existing(&data).is_err());
    assert!(!crate::runtime::runtime_db_path(&data).exists());
    let ordinary = crate::runtime::open(&data).unwrap();
    ordinary
        .pragma_update(None, "user_version", crate::runtime::USER_VERSION - 1)
        .unwrap();
    assert!(RuntimeOwner::open_existing(&data).is_err());
    ordinary
        .pragma_update(None, "user_version", crate::runtime::USER_VERSION)
        .unwrap();
    let owner = RuntimeOwner::open_existing(&data).expect("restored real schema admits storage");
    drop(owner);
    let original = fs::metadata(&data).unwrap().permissions();
    fs::set_permissions(&data, fs::Permissions::from_mode(0o777)).unwrap();
    let refused = RuntimeOwner::open_existing(&data).is_err();
    fs::set_permissions(&data, original).unwrap();
    assert!(refused);
}

// A clone with the same valid schema/rows at the original name must never
// replace an already-owned handle. Querying only pragma's path misses this.
#[test]
#[cfg(target_os = "macos")]
fn native_owner_runtime_replacement_retires_original_handle_without_reopen() {
    let (data, ordinary) = seeded("m96-native-replacement");
    let mut owner =
        RuntimeOwner::open_existing(&data).expect("native owner opens existing runtime");
    owner.validate().unwrap();
    ordinary
        .execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
        .unwrap();
    let path = crate::runtime::runtime_db_path(&data);
    let old = data.join("runtime.original.db");
    let replacement = data.join("runtime.copy.db");
    fs::copy(&path, &replacement).unwrap();
    fs::rename(&path, &old).unwrap();
    fs::rename(&replacement, &path).unwrap();
    assert_eq!(owner.validate(), Err(NativeOwnerError::Unavailable));
    fs::remove_file(&path).unwrap();
    fs::rename(&old, &path).unwrap();
    assert_eq!(
        owner.validate(),
        Err(NativeOwnerError::Unavailable),
        "restoring the name does not revive retired lineage"
    );
    assert_eq!(
        ordinary
            .query_row("SELECT count(*) FROM action_native_runs", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

// Renaming between transaction entry and its commit must reject and roll back
// the pending row. An entry-only or path-only validation commits the write.
#[test]
#[cfg(target_os = "macos")]
fn native_owner_runtime_replacement_before_commit_rolls_back() {
    let (data, ordinary) = seeded("m96-native-mid-transaction");
    let mut owner =
        RuntimeOwner::open_existing(&data).expect("native owner opens existing runtime");
    ordinary
        .execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
        .unwrap();
    let path = crate::runtime::runtime_db_path(&data);
    let old = data.join("runtime.original.db");
    let replacement = data.join("runtime.copy.db");
    fs::copy(&path, &replacement).unwrap();
    assert_eq!(
        owner.transaction(|tx| {
            sql(tx.execute("INSERT INTO m96_native_probe VALUES(999)", []))?;
            fs::rename(&path, &old).unwrap();
            fs::rename(&replacement, &path).unwrap();
            Ok(())
        }),
        Err(NativeOwnerError::Unavailable)
    );
    assert_eq!(
        ordinary
            .query_row("SELECT sum(value) FROM m96_native_probe", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        10
    );
    drop(owner);
    drop(ordinary);
    for file in [old, path] {
        let read = Connection::open(file).unwrap();
        assert_eq!(
            read.query_row("SELECT sum(value) FROM m96_native_probe", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            10
        );
    }
}

#[test]
#[cfg(target_os = "macos")]
fn native_owner_requires_current_process_exact_open_session_and_real_store() {
    let (data, ordinary) = seeded("m96-native-process-session");
    let root = dir("m96-native-process-vault");
    let vault_id = crate::runtime::scope::register(&ordinary, &root).unwrap();
    let mut scope = crate::runtime::VaultScope {
        vault_id,
        store_uuid: Some("real-test-store".into()),
    };
    let mut owner =
        RuntimeOwner::open_existing(&data).expect("prepare before process/session producer");
    assert!(owner.check_open_session(&root, &scope).is_err());
    crate::runtime::catchup::open_session(
        &ordinary,
        "different-process",
        &scope.vault_id,
        "real-test-store",
        chrono::Utc::now(),
    )
    .unwrap();
    assert!(owner.check_open_session(&root, &scope).is_err());
    crate::runtime::catchup::open_session(
        &ordinary,
        crate::runtime::sessions::session_id(),
        &scope.vault_id,
        "real-test-store",
        chrono::Utc::now(),
    )
    .unwrap();
    owner
        .check_open_session(&root, &scope)
        .expect("exact real current process/session row");
    scope.store_uuid = None;
    assert!(owner.check_open_session(&root, &scope).is_err());
    scope.store_uuid = Some("different-store".into());
    assert!(owner.check_open_session(&root, &scope).is_err());
    scope.store_uuid = Some("real-test-store".into());
    crate::runtime::catchup::close_session(
        &ordinary,
        crate::runtime::sessions::session_id(),
        &scope.vault_id,
        "real-test-store",
        chrono::Utc::now(),
    )
    .unwrap();
    assert!(owner.check_open_session(&root, &scope).is_err());
    assert_eq!(
        ordinary
            .query_row("SELECT count(*) FROM action_native_runs", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        ordinary
            .query_row("SELECT count(*) FROM action_account_grants", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

// Capturing a path is insufficient: opening B then A must not revive old A.
#[test]
fn native_owner_legacy_opening_ticket_fences_same_path_reopen_and_other_context() {
    use crate::workspace_service::authority::AuthorityContext;
    let origin = dir("m96-native-generation-origin");
    let a = dir("m96-native-generation-a");
    let b = dir("m96-native-generation-b");
    let context = AuthorityContext::new(origin.clone());
    assert!(context.capture_legacy_opening(&a).is_err());
    let first = context.begin_open().unwrap();
    context.publish_open(first, &a).unwrap();
    let old = context
        .capture_legacy_opening(&a)
        .expect("published legacy opening has a ticket");
    assert_eq!(context.with_legacy_opening(&old, || 17).unwrap(), 17);
    let second = context.begin_open().unwrap();
    assert!(context
        .with_legacy_opening(&old, || panic!("superseded opening ran"))
        .is_err());
    context.publish_open(second, &b).unwrap();
    assert!(context.capture_legacy_opening(&a).is_err());
    let third = context.begin_open().unwrap();
    context.publish_open(third, &a).unwrap();
    assert!(context
        .with_legacy_opening(&old, || panic!("same path revived old ticket"))
        .is_err());
    let fresh = context.capture_legacy_opening(&a).unwrap();
    assert_eq!(context.with_legacy_opening(&fresh, || 23).unwrap(), 23);
    let other = AuthorityContext::new(origin);
    let generation = other.begin_open().unwrap();
    other.publish_open(generation, &a).unwrap();
    assert!(other
        .with_legacy_opening(&fresh, || panic!("another context accepted ticket"))
        .is_err());
}

// NativeOwner production gets ONLY two cfg(test) calls, immediately before and
// immediately after Connection::open_with_flags_and_vfs. Helpers live here.
type ConstructorHook = Box<dyn FnOnce()>;
thread_local! {
    static CONSTRUCTOR_HOOKS: std::cell::RefCell<Option<(Option<ConstructorHook>, Option<ConstructorHook>)>> = const { std::cell::RefCell::new(None) };
}
pub(super) fn constructor_before_open() {
    let hook =
        CONSTRUCTOR_HOOKS.with(|slot| slot.borrow_mut().as_mut().and_then(|hooks| hooks.0.take()));
    if let Some(hook) = hook {
        hook();
    }
}
pub(super) fn constructor_after_open() {
    let hook =
        CONSTRUCTOR_HOOKS.with(|slot| slot.borrow_mut().as_mut().and_then(|hooks| hooks.1.take()));
    if let Some(hook) = hook {
        hook();
    }
}
fn with_constructor_hooks<T>(
    before: ConstructorHook,
    after: ConstructorHook,
    run: impl FnOnce() -> T,
) -> T {
    struct Reset;
    impl Drop for Reset {
        fn drop(&mut self) {
            CONSTRUCTOR_HOOKS.with(|slot| *slot.borrow_mut() = None);
        }
    }
    CONSTRUCTOR_HOOKS.with(|slot| {
        assert!(slot.borrow().is_none());
        *slot.borrow_mut() = Some((Some(before), Some(after)));
    });
    let _reset = Reset;
    run()
}

#[cfg(target_os = "macos")]
struct RestoreRuntimePath {
    path: PathBuf,
    old: PathBuf,
}
#[cfg(target_os = "macos")]
impl Drop for RestoreRuntimePath {
    fn drop(&mut self) {
        if self.old.exists() {
            if fs::symlink_metadata(&self.path).is_ok() {
                fs::remove_file(&self.path).unwrap();
            }
            fs::rename(&self.old, &self.path).unwrap();
        }
    }
}

// Root RED: existing constructor follows the symlink, canonicalizes its target
// inside SQLite, then admits it after the original name is restored. NOFOLLOW
// must reject at the actual SQLite open; preexisting-symlink rejection is not
// enough and merely statting again before/after misses this interleaving.
#[test]
#[cfg(target_os = "macos")]
fn native_owner_constructor_rejects_swap_to_symlink_open_restore() {
    use std::os::unix::fs::symlink;
    let (data, original) = seeded("m96-native-constructor-symlink");
    let (target_data, target) = seeded("m96-native-constructor-target");
    original
        .execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
        .unwrap();
    target
        .execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
        .unwrap();
    drop(original);
    drop(target);
    let path = crate::runtime::runtime_db_path(&data);
    let target_path = crate::runtime::runtime_db_path(&target_data);
    let old = data.join("runtime.original.db");
    let expected_identity = private_path(&path, false).unwrap();
    let _restore = RestoreRuntimePath {
        path: path.clone(),
        old: old.clone(),
    };
    let before_path = path.clone();
    let before_old = old.clone();
    let after_path = path.clone();
    let after_old = old.clone();
    let opened = with_constructor_hooks(
        Box::new(move || {
            fs::rename(&before_path, &before_old).unwrap();
            symlink(&target_path, &before_path).unwrap();
        }),
        Box::new(move || {
            fs::remove_file(&after_path).unwrap();
            fs::rename(&after_old, &after_path).unwrap();
        }),
        || RuntimeOwner::open_existing(&data),
    );
    // NOFOLLOW exits before after_open, so restore explicitly before assertions.
    drop(_restore);
    assert_eq!(private_path(&path, false).unwrap(), expected_identity);
    assert!(
        opened.is_err(),
        "SQLite followed a substituted symlink and admitted its target"
    );
    for parent in [&data, &target_data] {
        let reader = crate::runtime::ReadOnly::open(parent).unwrap();
        assert_eq!(
            reader
                .query_row("SELECT count(*) FROM action_native_runs", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            reader
                .query_row("SELECT count(*) FROM action_account_grants", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
}

// Eighth originally proposed probe, now through the ACTUAL constructor instead
// of recomposing private RuntimeOwner fields. It isolates the original name
// restored around the SQLite handle that actually opened a regular replacement.
#[test]
#[cfg(target_os = "macos")]
fn native_owner_constructor_rejects_regular_swap_open_restore() {
    let (data, ordinary) = seeded("m96-native-constructor-regular");
    ordinary
        .execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
        .unwrap();
    drop(ordinary);
    let path = crate::runtime::runtime_db_path(&data);
    let old = data.join("runtime.original.db");
    let replacement = data.join("runtime.replacement.db");
    fs::copy(&path, &replacement).unwrap();
    let expected_identity = private_path(&path, false).unwrap();
    let _restore = RestoreRuntimePath {
        path: path.clone(),
        old: old.clone(),
    };
    let before_path = path.clone();
    let before_old = old.clone();
    let before_copy = replacement.clone();
    let after_path = path.clone();
    let after_old = old.clone();
    let after_copy = replacement.clone();
    let opened = with_constructor_hooks(
        Box::new(move || {
            fs::rename(&before_path, &before_old).unwrap();
            fs::rename(&before_copy, &before_path).unwrap();
        }),
        Box::new(move || {
            fs::rename(&after_path, &after_copy).unwrap();
            fs::rename(&after_old, &after_path).unwrap();
        }),
        || RuntimeOwner::open_existing(&data),
    );
    drop(_restore);
    assert_eq!(private_path(&path, false).unwrap(), expected_identity);
    assert!(
        opened.is_err(),
        "restored path disguised a replacement SQLite handle"
    );
}

#[test]
#[cfg(target_os = "macos")]
fn native_owner_worker_refuses_native_getter_before_touching_appkit() {
    let result = std::thread::spawn(|| {
        read_main_window_identity(|| {
            panic!("off-main native NSView getter was reached");
        })
    })
    .join();
    assert!(
        matches!(result, Ok(Err(NativeOwnerError::Unavailable))),
        "off-main identity read must return unavailable before invoking AppKit"
    );
}

// SQL-kernel access only, never a NativeRootEntry/window/owner proof factory.
// Tests supply a receipt emitted by the actual supervised publication producer.
#[cfg(target_os = "macos")]
pub(crate) struct PublicationSqlOwner {
    owner: RuntimeOwner,
}
#[cfg(target_os = "macos")]
impl PublicationSqlOwner {
    pub(crate) fn open(data: &Path) -> Self {
        let data = data.canonicalize().unwrap();
        Self {
            owner: RuntimeOwner::open_existing(&data).unwrap(),
        }
    }
    pub(crate) fn record(
        &mut self,
        root: &Path,
        scope: &crate::runtime::VaultScope,
        receipt: &crate::agent::NativePublicationReceipt,
        authority_id: &str,
    ) -> Result<(), NativeOwnerError> {
        self.owner.transaction(|tx| {
            RuntimeOwner::record_root_rows(tx, root, scope, receipt, authority_id)
        })
    }
}

// Actual production-used store-reader probes. No window/NativeRootEntry factory.
#[cfg(target_os = "macos")]
fn native_store_fixture(label: &str) -> (PathBuf, PathBuf, crate::ledger::store::StoreInfo) {
    let root = dir(label);
    let ledger = crate::ledger::ledger_dir(&root);
    let info = crate::ledger::store::load_or_mint(&ledger).unwrap();
    (root, ledger.join("store.json"), info)
}

#[test]
#[cfg(target_os = "macos")]
fn native_owner_store_reads_real_identity_and_exact_byte_bound_without_writing() {
    let (root, path, expected) = native_store_fixture("m96-native-store-regular");
    let original = fs::read(&path).unwrap();
    let ordinary = read_native_store(&root).map(|store| store.info);
    let original_unchanged = fs::read(&path).unwrap() == original;
    let mut boundary = original;
    boundary.resize(NATIVE_STORE_MAX_BYTES as usize, b' ');
    fs::write(&path, &boundary).unwrap();
    let exact_limit = read_native_store(&root).map(|store| store.info);
    let boundary_unchanged = fs::read(&path).unwrap() == boundary;
    fs::remove_dir_all(&root).unwrap();
    assert_eq!(ordinary, Ok(expected.clone()));
    assert_eq!(exact_limit, Ok(expected));
    assert!(original_unchanged && boundary_unchanged);
}

#[test]
#[cfg(target_os = "macos")]
fn native_owner_store_refuses_missing_malformed_unknown_and_wrong_format_without_mint() {
    let (root, path, expected) = native_store_fixture("m96-native-store-decode");
    let mut unknown = serde_json::to_value(&expected).unwrap();
    unknown["extra"] = serde_json::json!(true);
    let mut unsupported = expected;
    unsupported.format = crate::ledger::store::STORE_FORMAT + 1;
    let mut refused = Vec::new();
    for bytes in [
        b"{".to_vec(),
        serde_json::to_vec(&unknown).unwrap(),
        serde_json::to_vec(&unsupported).unwrap(),
    ] {
        fs::write(&path, &bytes).unwrap();
        refused.push(read_native_store(&root).is_err() && fs::read(&path).unwrap() == bytes);
    }
    fs::remove_file(&path).unwrap();
    refused.push(read_native_store(&root).is_err() && !path.exists());
    fs::create_dir(&path).unwrap();
    refused.push(read_native_store(&root).is_err() && path.is_dir());
    fs::remove_dir_all(&root).unwrap();
    assert!(refused.into_iter().all(|value| value));
}

#[test]
#[cfg(target_os = "macos")]
fn native_owner_store_refuses_valid_json_one_byte_over_native_bound() {
    let (root, path, _) = native_store_fixture("m96-native-store-oversize");
    let mut bytes = fs::read(&path).unwrap();
    bytes.resize(NATIVE_STORE_MAX_BYTES as usize + 1, b' ');
    fs::write(&path, &bytes).unwrap();
    let result = read_native_store(&root);
    let unchanged = fs::read(&path).unwrap() == bytes;
    fs::remove_dir_all(&root).unwrap();
    assert!(result.is_err(), "valid oversized StoreInfo was admitted");
    assert!(unchanged, "optional identity read changed the source");
}

#[test]
#[cfg(target_os = "macos")]
fn native_owner_store_refuses_leaf_and_containment_directory_symlinks() {
    use std::os::unix::fs::symlink;
    for component in ["store.json", "ledger", ".cerebro"] {
        let (root, path, _) = native_store_fixture("m96-native-store-symlink");
        let original = fs::read(&path).unwrap();
        let named = match component {
            "store.json" => path.clone(),
            "ledger" => crate::ledger::ledger_dir(&root),
            _ => root.join(".cerebro"),
        };
        let retained = root.join("moved-original");
        fs::rename(&named, &retained).unwrap();
        symlink(&retained, &named).unwrap();
        let result = read_native_store(&root);
        let target_unchanged = fs::read(&path).unwrap() == original;
        fs::remove_file(&named).unwrap();
        fs::rename(&retained, &named).unwrap();
        fs::remove_dir_all(&root).unwrap();
        assert!(result.is_err(), "followed symlink at {component}");
        assert!(target_unchanged);
    }
}

#[test]
#[cfg(target_os = "macos")]
fn native_owner_store_fifo_refuses_without_stalling_retained_transaction() {
    use std::{ffi::CString, io::Read, os::unix::ffi::OsStrExt, process::Stdio, time::Instant};
    let (root, path, _) = native_store_fixture("m96-native-store-fifo");
    fs::remove_file(&path).unwrap();
    let c_path = CString::new(path.as_os_str().as_bytes()).unwrap();
    // SAFETY: NUL-terminated fixture-only path, mode argument contains no pointer.
    assert_eq!(unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) }, 0);
    let output = root.join("child-output.txt");
    let log = fs::File::create(&output).unwrap();
    let mut child = crate::spawn::command(std::env::current_exe().unwrap())
        .args([
            "actions::native_owner::tests::native_owner_store_fifo_child",
            "--exact",
            "--include-ignored",
            "--nocapture",
            "--test-threads=1",
        ])
        .env_remove("CEREBRO_CRASH_POINT")
        .env_remove("CEREBRO_STOP_POINT")
        .env("CEREBRO_M96_STORE_FIFO_ROOT", &root)
        .env_remove("CEREBRO_M96_STORE_FIFO_AT_OPEN")
        .stdout(Stdio::from(log.try_clone().unwrap()))
        .stderr(Stdio::from(log))
        .spawn()
        .unwrap();
    let start_deadline = Instant::now() + Duration::from_secs(10);
    let mut read_deadline = None;
    let mut reached_reader = false;
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break Some(status);
        }
        if !reached_reader && root.join("reader-entered").is_file() {
            reached_reader = true;
            read_deadline = Some(Instant::now() + Duration::from_secs(3));
        }
        if Instant::now() >= read_deadline.unwrap_or(start_deadline) {
            child.kill().unwrap();
            child.wait().unwrap();
            break None;
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    // A very fast repaired child can exit before the parent first sees its mark.
    reached_reader |= root.join("reader-entered").is_file();
    let mut text = String::new();
    fs::File::open(&output)
        .unwrap()
        .take(65536)
        .read_to_string(&mut text)
        .unwrap();
    let remained_fifo = {
        use std::os::unix::fs::FileTypeExt;
        fs::symlink_metadata(&path).unwrap().file_type().is_fifo()
    };
    fs::remove_dir_all(&root).unwrap();
    assert!(
        reached_reader,
        "child never reached the actual reader: {text}"
    );
    assert!(
        status.is_some(),
        "actual reader stalled a retained transaction on FIFO: {text}"
    );
    assert!(
        status.unwrap().success(),
        "child reader assertion failed: {text}"
    );
    assert!(remained_fifo, "the refusal changed the source file");
}

#[test]
#[ignore = "owned finite child of native_owner_store_fifo_refuses_without_stalling_retained_transaction"]
#[cfg(target_os = "macos")]
fn native_owner_store_fifo_child() {
    let root = PathBuf::from(std::env::var_os("CEREBRO_M96_STORE_FIFO_ROOT").unwrap());
    let temporary = std::env::temp_dir().canonicalize().unwrap();
    assert_eq!(root.parent(), Some(temporary.as_path()));
    assert!(root
        .file_name()
        .unwrap()
        .to_string_lossy()
        .starts_with("cerebro-test-m96-native-store-fifo-"));
    assert_eq!(root.canonicalize().unwrap(), root);
    let data = root.join("runtime-owner");
    fs::create_dir(&data).unwrap();
    let ordinary = crate::runtime::open(&data).unwrap();
    let mut owner = RuntimeOwner::open_existing(&data).unwrap();
    let at_open = std::env::var("CEREBRO_M96_STORE_FIFO_AT_OPEN").as_deref() == Ok("1");
    let before: Option<Box<dyn FnOnce()>> = if at_open {
        let path = crate::ledger::ledger_dir(&root).join("store.json");
        Some(Box::new(move || {
            use std::{ffi::CString, os::unix::ffi::OsStrExt};
            fs::remove_file(&path).unwrap();
            let path = CString::new(path.as_os_str().as_bytes()).unwrap();
            // SAFETY: NUL-terminated path belongs only to this finite child's fixture.
            assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
        }))
    } else {
        None
    };
    let result = with_store_hooks(before, None, None, || {
        owner.transaction(|_| {
            fs::write(root.join("reader-entered"), b"ready").unwrap();
            read_native_store(&root).map(|_| ())
        })
    });
    drop(owner);
    drop(ordinary);
    assert!(
        result.is_err(),
        "FIFO was accepted as a real StoreInfo file"
    );
}

#[cfg(target_os = "macos")]
thread_local! {
    static STORE_BEFORE_OPEN: std::cell::RefCell<Option<Box<dyn FnOnce()>>> = const { std::cell::RefCell::new(None) };
    static STORE_AFTER_OPEN: std::cell::RefCell<Option<Box<dyn FnOnce()>>> = const { std::cell::RefCell::new(None) };
    static STORE_AFTER_READ: std::cell::RefCell<Option<Box<dyn FnOnce()>>> = const { std::cell::RefCell::new(None) };
}
#[cfg(target_os = "macos")]
pub(super) fn store_before_open() {
    let hook = STORE_BEFORE_OPEN.with(|slot| slot.borrow_mut().take());
    if let Some(hook) = hook {
        hook();
    }
}
#[cfg(target_os = "macos")]
pub(super) fn store_after_open() {
    let hook = STORE_AFTER_OPEN.with(|slot| slot.borrow_mut().take());
    if let Some(hook) = hook {
        hook();
    }
}
#[cfg(target_os = "macos")]
pub(super) fn store_after_read() {
    let hook = STORE_AFTER_READ.with(|slot| slot.borrow_mut().take());
    if let Some(hook) = hook {
        hook();
    }
}
#[cfg(target_os = "macos")]
fn with_store_hooks<T>(
    before: Option<Box<dyn FnOnce()>>,
    opened: Option<Box<dyn FnOnce()>>,
    read: Option<Box<dyn FnOnce()>>,
    operation: impl FnOnce() -> T,
) -> T {
    struct Clear;
    impl Drop for Clear {
        fn drop(&mut self) {
            STORE_BEFORE_OPEN.with(|slot| {
                slot.borrow_mut().take();
            });
            STORE_AFTER_OPEN.with(|slot| {
                slot.borrow_mut().take();
            });
            STORE_AFTER_READ.with(|slot| {
                slot.borrow_mut().take();
            });
        }
    }
    STORE_BEFORE_OPEN.with(|slot| *slot.borrow_mut() = before);
    STORE_AFTER_OPEN.with(|slot| *slot.borrow_mut() = opened);
    STORE_AFTER_READ.with(|slot| *slot.borrow_mut() = read);
    let _clear = Clear;
    operation()
}

#[test]
#[cfg(target_os = "macos")]
fn native_owner_store_retains_original_inode_and_directory_across_rechecks() {
    for component in ["store.json", "ledger", ".cerebro"] {
        let (root, path, _) = native_store_fixture("m96-native-store-retained");
        let observation = read_native_store(&root).unwrap();
        assert!(
            observation.recheck().is_ok(),
            "unchanged original should recheck"
        );
        let bytes = fs::read(&path).unwrap();
        let named = match component {
            "store.json" => path.clone(),
            "ledger" => crate::ledger::ledger_dir(&root),
            _ => root.join(".cerebro"),
        };
        let retained = root.join("original-source");
        fs::rename(&named, &retained).unwrap();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, &bytes).unwrap();
        let result = observation.recheck();
        let unchanged = fs::read(&path).unwrap() == bytes;
        drop(observation);
        fs::remove_dir_all(&root).unwrap();
        assert!(
            result.is_err(),
            "adopted same-byte replacement at {component}"
        );
        assert!(unchanged);
    }
}

#[test]
#[cfg(target_os = "macos")]
fn native_owner_store_refuses_regular_swap_open_restore() {
    let (root, path, _) = native_store_fixture("m96-native-store-swap");
    let original = root.join("original-source.json");
    let replacement = root.join("replacement-source.json");
    fs::copy(&path, &replacement).unwrap();
    let before_path = path.clone();
    let before_original = original.clone();
    let before_replacement = replacement.clone();
    let after_path = path.clone();
    let after_original = original.clone();
    let after_replacement = replacement.clone();
    let result = with_store_hooks(
        Some(Box::new(move || {
            fs::rename(&before_path, &before_original).unwrap();
            fs::rename(&before_replacement, &before_path).unwrap();
        })),
        Some(Box::new(move || {
            fs::rename(&after_path, &after_replacement).unwrap();
            fs::rename(&after_original, &after_path).unwrap();
        })),
        None,
        || read_native_store(&root),
    );
    fs::remove_dir_all(&root).unwrap();
    assert!(
        result.is_err(),
        "restored name disguised a different opened inode"
    );
}

#[test]
#[cfg(target_os = "macos")]
fn native_owner_store_refuses_mutation_during_bounded_read() {
    for grow in [false, true] {
        let (root, path, _) = native_store_fixture("m96-native-store-read-change");
        let mut changed = fs::read(&path).unwrap();
        if grow {
            changed.resize(NATIVE_STORE_MAX_BYTES as usize + 1, b' ');
        } else {
            let offset = changed.iter().position(|byte| *byte == b'{').unwrap();
            changed[offset] = b' ';
        }
        let mutate_path = path.clone();
        let mutate_bytes = changed.clone();
        let result = with_store_hooks(
            None,
            None,
            Some(Box::new(move || {
                fs::write(&mutate_path, &mutate_bytes).unwrap();
            })),
            || read_native_store(&root),
        );
        let preserved = fs::read(&path).unwrap() == changed;
        fs::remove_dir_all(&root).unwrap();
        assert!(
            result.is_err(),
            "accepted changed file after actual bounded read, grow={grow}"
        );
        assert!(preserved, "reader overwrote external bytes");
    }
}

#[test]
#[cfg(target_os = "macos")]
fn native_owner_store_refuses_fifo_substituted_after_regular_precheck() {
    use std::{io::Read, process::Stdio, time::Instant};
    let (root, path, _) = native_store_fixture("m96-native-store-fifo");
    let output = root.join("child-output.txt");
    let log = fs::File::create(&output).unwrap();
    let mut child = crate::spawn::command(std::env::current_exe().unwrap())
        .args([
            "actions::native_owner::tests::native_owner_store_fifo_child",
            "--exact",
            "--include-ignored",
            "--nocapture",
            "--test-threads=1",
        ])
        .env_remove("CEREBRO_CRASH_POINT")
        .env_remove("CEREBRO_STOP_POINT")
        .env("CEREBRO_M96_STORE_FIFO_ROOT", &root)
        .env("CEREBRO_M96_STORE_FIFO_AT_OPEN", "1")
        .stdout(Stdio::from(log.try_clone().unwrap()))
        .stderr(Stdio::from(log))
        .spawn()
        .unwrap();
    let start_deadline = Instant::now() + Duration::from_secs(10);
    let mut read_deadline = None;
    let mut reached_reader = false;
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break Some(status);
        }
        if !reached_reader && root.join("reader-entered").is_file() {
            reached_reader = true;
            read_deadline = Some(Instant::now() + Duration::from_secs(3));
        }
        if Instant::now() >= read_deadline.unwrap_or(start_deadline) {
            child.kill().unwrap();
            child.wait().unwrap();
            break None;
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    // A very fast repaired child can exit before the parent first sees its mark.
    reached_reader |= root.join("reader-entered").is_file();
    let mut text = String::new();
    fs::File::open(&output)
        .unwrap()
        .take(65536)
        .read_to_string(&mut text)
        .unwrap();
    let remained_fifo = {
        use std::os::unix::fs::FileTypeExt;
        fs::symlink_metadata(&path).unwrap().file_type().is_fifo()
    };
    fs::remove_dir_all(&root).unwrap();
    assert!(
        reached_reader,
        "child never reached the actual reader: {text}"
    );
    assert!(
        status.is_some(),
        "actual reader stalled a retained transaction on FIFO: {text}"
    );
    assert!(
        status.unwrap().success(),
        "child reader assertion failed: {text}"
    );
    assert!(remained_fifo, "the refusal changed the source file");
}

#[test]
#[cfg(target_os = "macos")]
fn native_catalog_retained_snapshot_reads_actual_committed_rows() {
    let (data, ordinary) = seeded("m96-catalog-read-positive");
    let mut owner = RuntimeOwner::open_existing(&data).unwrap();
    let values = owner
        .read_snapshot(|read| {
            sql(read.query_all(
                "SELECT value FROM m96_native_probe ORDER BY value",
                &[],
                |row| row.get::<_, i64>(0),
            ))
        })
        .unwrap();
    assert_eq!(values, vec![10]);
    ordinary
        .execute("INSERT INTO m96_native_probe VALUES(20)", [])
        .unwrap();
    assert_eq!(
        owner
            .read_snapshot(|read| sql(read.query(
                "SELECT sum(value) FROM m96_native_probe",
                &[],
                |row| row.get::<_, i64>(0)
            )))
            .unwrap(),
        30
    );
}
#[test]
#[cfg(target_os = "macos")]
fn native_catalog_retained_read_rejects_real_update_and_pragma_without_changing_data() {
    let (data, ordinary) = seeded("m96-catalog-read-negative");
    let mut owner = RuntimeOwner::open_existing(&data).unwrap();
    let attempts = owner
        .read_snapshot(|read| {
            let update = read.query(
                "UPDATE m96_native_probe SET value=99 RETURNING value",
                &[],
                |row| row.get::<_, i64>(0),
            );
            let pragma = read.query("PRAGMA query_only", &[], |row| row.get::<_, i64>(0));
            Ok((update.is_err(), pragma.is_err()))
        })
        .unwrap();
    let durable: i64 = ordinary
        .query_row("SELECT value FROM m96_native_probe", [], |row| row.get(0))
        .unwrap();
    assert_eq!((attempts, durable), ((true, true), 10));
    // The retained writer remains usable after the scoped read restores state.
    owner
        .transaction(|conn| {
            sql(conn.execute("UPDATE m96_native_probe SET value=11", [])).map(|_| ())
        })
        .unwrap();
}
#[test]
#[cfg(target_os = "macos")]
fn native_catalog_retained_read_is_one_snapshot_and_restores_after_error_and_unwind() {
    let (data, ordinary) = seeded("m96-catalog-read-snapshot");
    let mut owner = RuntimeOwner::open_existing(&data).unwrap();
    let pair = owner
        .read_snapshot(|read| {
            let before = sql(
                read.query("SELECT value FROM m96_native_probe", &[], |row| {
                    row.get::<_, i64>(0)
                }),
            )?;
            sql(ordinary.execute("UPDATE m96_native_probe SET value=20", []))?;
            let after = sql(
                read.query("SELECT value FROM m96_native_probe", &[], |row| {
                    row.get::<_, i64>(0)
                }),
            )?;
            Ok((before, after))
        })
        .unwrap();
    assert_eq!(pair, (10, 10));
    assert!(owner
        .read_snapshot(|_| Err::<(), _>(NativeOwnerError::Unavailable))
        .is_err());
    let panic = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = owner.read_snapshot::<()>(|_| panic!("read snapshot unwind probe"));
    }));
    assert!(panic.is_err());
    assert_eq!(
        owner
            .conn
            .query_row("PRAGMA query_only", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        0
    );
    owner
        .transaction(|conn| {
            sql(conn.execute("UPDATE m96_native_probe SET value=21", [])).map(|_| ())
        })
        .unwrap();
    assert_eq!(
        ordinary
            .query_row("SELECT value FROM m96_native_probe", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        21
    );
}
#[test]
#[cfg(target_os = "macos")]
fn native_catalog_retained_read_refuses_replaced_runtime_without_reopening() {
    let (data, ordinary) = seeded("m96-catalog-read-moved");
    let mut owner = RuntimeOwner::open_existing(&data).unwrap();
    assert!(owner
        .read_snapshot(|read| sql(
            read.query("SELECT value FROM m96_native_probe", &[], |row| row
                .get::<_, i64>(0))
        ))
        .is_ok());
    let named = crate::runtime::runtime_db_path(&data);
    fs::rename(&named, data.join("held-original.db")).unwrap();
    fs::write(&named, b"replacement is never opened").unwrap();
    assert!(owner.read_snapshot(|_| Ok(())).is_err());
    assert!(owner.retired);
    assert_eq!(fs::read(&named).unwrap(), b"replacement is never opened");
    drop(ordinary);
}

// One-shot acknowledgement-loss probe at the actual successful commit boundary.
// It does not emulate SQLite corruption, replace the runtime or access credentials.
thread_local! {
    static LOSE_NEXT_TRANSACTION_ACK: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}
pub(super) fn lose_next_transaction_ack() {
    LOSE_NEXT_TRANSACTION_ACK.with(|value| value.set(true));
}
pub(super) fn transaction_ack_lost() -> bool {
    LOSE_NEXT_TRANSACTION_ACK.with(|value| value.replace(false))
}
pub(super) fn with_transaction_ack_probe<T>(work: impl FnOnce() -> T) -> T {
    struct Reset;
    impl Drop for Reset {
        fn drop(&mut self) {
            LOSE_NEXT_TRANSACTION_ACK.with(|value| value.set(false));
        }
    }
    LOSE_NEXT_TRANSACTION_ACK.with(|value| value.set(false));
    let _reset = Reset;
    work()
}

#[test]
#[cfg(target_os = "macos")]
fn native_owner_commit_outcome_lost_ack_is_uncertain_after_real_commit() {
    let (data, ordinary) = seeded("m96-owner-lost-commit-ack");
    let mut owner = RuntimeOwner::open_existing(&data).unwrap();
    let outcome = with_transaction_ack_probe(|| {
        lose_next_transaction_ack();
        owner.classified_transaction(|tx| {
            sql(tx.execute("UPDATE m96_native_probe SET value=99", []))?;
            Ok(())
        })
    });
    let stored: i64 = ordinary
        .query_row("SELECT value FROM m96_native_probe", [], |r| r.get(0))
        .unwrap();
    assert_eq!(
        stored, 99,
        "the injected lost acknowledgement follows a real successful commit"
    );
    assert!(owner.retired);
    assert_eq!(outcome, RuntimeTransactionOutcome::CommitUncertain);
    fs::remove_dir_all(data).unwrap();
}

#[test]
#[cfg(target_os = "macos")]
fn native_owner_commit_outcome_controls_distinguish_commit_from_precommit_refusal() {
    let (data, ordinary) = seeded("m96-owner-commit-controls");
    let mut owner = RuntimeOwner::open_existing(&data).unwrap();
    assert_eq!(
        owner.classified_transaction(|tx| {
            sql(tx.execute("UPDATE m96_native_probe SET value=20", []))?;
            Ok(())
        }),
        RuntimeTransactionOutcome::Committed(())
    );
    assert_eq!(
        owner.classified_transaction(|tx| {
            sql(tx.execute("UPDATE m96_native_probe SET value=30", []))?;
            Err::<(), _>(NativeOwnerError::Unavailable)
        }),
        RuntimeTransactionOutcome::NotCommitted(NativeOwnerError::Unavailable)
    );
    let stored: i64 = ordinary
        .query_row("SELECT value FROM m96_native_probe", [], |r| r.get(0))
        .unwrap();
    assert_eq!(
        stored, 20,
        "a rejected operation must roll back before any commit attempt"
    );
    assert!(!owner.retired);
    fs::remove_dir_all(data).unwrap();
}

// M95 RED support: closed probes on the existing owner/production row kernel.
// No NativeRootEntry, window proof, attempt ID, capability or fake registry.
#[cfg(target_os = "macos")]
impl PublicationSqlOwner {
    pub(crate) fn m95_record_then_refuse(
        &mut self,
        root: &Path,
        scope: &crate::runtime::VaultScope,
        receipt: &crate::agent::NativePublicationReceipt,
        authority_id: &str,
    ) -> Result<(), NativeOwnerError> {
        self.owner.transaction(|tx| {
            RuntimeOwner::record_root_rows(tx, root, scope, receipt, authority_id)?;
            Err(NativeOwnerError::Unavailable)
        })
    }
    pub(crate) fn m95_record_losing_ack(
        &mut self,
        root: &Path,
        scope: &crate::runtime::VaultScope,
        receipt: &crate::agent::NativePublicationReceipt,
        authority_id: &str,
    ) -> Result<(), NativeOwnerError> {
        with_transaction_ack_probe(|| {
            lose_next_transaction_ack();
            self.record(root, scope, receipt, authority_id)
        })
    }
}

// Closed M95 retained SQL-owner kernel scaffold. No native proof factory.
#[cfg(all(test, target_os = "macos"))]
#[path = "native_chat_delegation_tests.rs"]
pub(crate) mod chat_delegation;
