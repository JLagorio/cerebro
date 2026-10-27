//! Explicit, default-off packaged adapter acceptance. No account/import producer.
//! Three fresh native-only references; receipts never contain values or value hashes.
use super::{
    secrets::{platform_secret_store, SecretRef, SecretStore, SecretValue},
    ConnectionError,
};
use crate::actions::ids::AccountId;
use rand::RngCore;
use serde::Serialize;
use std::{
    ffi::CString,
    fs,
    io::Write,
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::fs::{MetadataExt, OpenOptionsExt},
    },
    path::{Path, PathBuf},
};
use tauri::{AppHandle, WebviewWindow};

const MAX_RECEIPTS: usize = 32;
const RECEIPT_BYTES: usize = 8192;
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BundleObservation {
    identifier: String,
    path: String,
    executable_path: String,
}
#[derive(Serialize)]
struct Case {
    name: &'static str,
    observed: &'static str,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Observation {
    pub outcome: &'static str,
    failure_kind: Option<&'static str>,
    failed_stage: Option<&'static str>,
    cleanup: &'static str,
    bundle: Option<BundleObservation>,
    cases: Vec<Case>,
    keychain_access: Option<bool>,
    receipt_count: Option<usize>,
    reference_count: Option<usize>,
    confirmed_owned: Option<usize>,
    uncertain_puts: Option<usize>,
    denied_or_locked: &'static str,
    production_signing_profile: &'static str,
}
impl Observation {
    pub(crate) fn incomplete(stage: &'static str) -> Self {
        Self {
            outcome: "cleanup_pending",
            failure_kind: Some("not_exercised"),
            failed_stage: Some(stage),
            cleanup: "unknown",
            bundle: None,
            cases: Vec::new(),
            keychain_access: None,
            receipt_count: None,
            reference_count: None,
            confirmed_owned: None,
            uncertain_puts: None,
            denied_or_locked: "not_exercised",
            production_signing_profile: "not_exercised",
        }
    }
}
#[derive(Clone, Copy)]
struct Failure {
    kind: &'static str,
    stage: &'static str,
}
type Result<T> = std::result::Result<T, Failure>;
fn defect(stage: &'static str) -> Failure {
    Failure {
        kind: "defect",
        stage,
    }
}
fn access(error: ConnectionError, stage: &'static str) -> Failure {
    let kind = match error {
        ConnectionError::Unavailable
        | ConnectionError::Cancelled
        | ConnectionError::Unsupported => "environment_blocked",
        _ => "defect",
    };
    Failure { kind, stage }
}
#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum ItemState {
    Unchecked,
    Absent,
    Preexisting,
    PutInFlight,
    Owned,
    DeleteInFlight,
    Missing,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Item {
    label: &'static str,
    reference: SecretRef,
    state: ItemState,
}
struct Receipts {
    root: PathBuf,
    directory: fs::File,
    dev: u64,
    ino: u64,
    next: usize,
    failed: bool,
}
fn private_directory(path: &Path) -> Result<fs::Metadata> {
    let metadata = fs::symlink_metadata(path).map_err(|_| defect("private-directory"))?;
    // SAFETY: side-effect-free process identity observation.
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o077 != 0
        || fs::canonicalize(path).map_err(|_| defect("private-directory"))? != path
    {
        return Err(defect("private-directory"));
    }
    Ok(metadata)
}
impl Receipts {
    fn new(root: &Path) -> Result<Self> {
        let metadata = private_directory(root)?;
        let directory = fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(root)
            .map_err(|_| defect("receipt-directory-open"))?;
        let held = directory
            .metadata()
            .map_err(|_| defect("receipt-directory-stat"))?;
        if (held.dev(), held.ino()) != (metadata.dev(), metadata.ino()) {
            return Err(defect("receipt-directory-replaced"));
        }
        Ok(Self {
            root: root.to_owned(),
            directory,
            dev: metadata.dev(),
            ino: metadata.ino(),
            next: 0,
            failed: false,
        })
    }
    fn write(&mut self, nonce: &str, stage: &'static str, items: &[Item; 3]) -> Result<()> {
        let result = (|| {
            let metadata = private_directory(&self.root)?;
            if (metadata.dev(), metadata.ino()) != (self.dev, self.ino) || self.next >= MAX_RECEIPTS
            {
                return Err(defect("receipt-identity-or-count"));
            }
            let value = serde_json::json!({"format":1,"profile":"keychain-adhoc","sequence":self.next,
                "runNonce":nonce,"stage":stage,"items":items,
                "signingProfile":"adhoc-minus-no-entitlements","rootIdentity":{"dev":self.dev,"ino":self.ino}});
            let bytes = serde_json::to_vec_pretty(&value).map_err(|_| defect("receipt-encode"))?;
            if bytes.len() > RECEIPT_BYTES {
                return Err(defect("receipt-bound"));
            }
            let name = format!("keychain-receipt-{:02}.json", self.next);
            let native_name = CString::new(name.as_bytes()).map_err(|_| defect("receipt-name"))?;
            // SAFETY: the original directory descriptor is retained, the fixed
            // filename is NUL-terminated, and exclusive/no-follow creation cannot
            // adopt an existing file or escape this directory.
            let descriptor = unsafe {
                libc::openat(
                    self.directory.as_raw_fd(),
                    native_name.as_ptr(),
                    libc::O_WRONLY
                        | libc::O_CREAT
                        | libc::O_EXCL
                        | libc::O_NOFOLLOW
                        | libc::O_NONBLOCK
                        | libc::O_CLOEXEC,
                    0o600,
                )
            };
            if descriptor < 0 {
                return Err(defect("receipt-create"));
            }
            // SAFETY: openat returned one owned descriptor; File closes it once.
            let mut file = unsafe { fs::File::from_raw_fd(descriptor) };
            let created = file.metadata().map_err(|_| defect("receipt-stat"))?;
            file.write_all(&bytes)
                .and_then(|_| file.sync_all())
                .map_err(|_| defect("receipt-sync"))?;
            self.directory
                .sync_all()
                .map_err(|_| defect("receipt-directory-sync"))?;
            let named_root = private_directory(&self.root)?;
            let named = fs::symlink_metadata(self.root.join(name))
                .map_err(|_| defect("receipt-name-lost"))?;
            if (named_root.dev(), named_root.ino()) != (self.dev, self.ino)
                || !named.is_file()
                || named.file_type().is_symlink()
                || named.uid() != created.uid()
                || named.mode() & 0o077 != 0
                || named.len() != bytes.len() as u64
                || (named.dev(), named.ino()) != (created.dev(), created.ino())
            {
                return Err(defect("receipt-name-replaced"));
            }
            self.next += 1;
            Ok(())
        })();
        if result.is_err() {
            self.failed = true;
        }
        result
    }
}
fn bundle(root: &Path) -> Result<BundleObservation> {
    if root.file_name().is_none_or(|name| name != "run") {
        return Err(defect("package-run-root"));
    }
    let parent = root.parent().ok_or_else(|| defect("package-parent"))?;
    private_directory(parent)?;
    let expected = parent.join("Cerebro Keychain Acceptance.app");
    for path in [
        &expected,
        &expected.join("Contents"),
        &expected.join("Contents/MacOS"),
    ] {
        private_directory(path)?;
    }
    let native = objc2_foundation::NSBundle::mainBundle();
    let identifier = native
        .bundleIdentifier()
        .map(|value| value.to_string())
        .ok_or_else(|| defect("native-bundle-identifier"))?;
    let path = native.bundlePath().to_string();
    let executable = std::env::current_exe().map_err(|_| defect("native-executable"))?;
    let expected_executable = expected.join("Contents/MacOS/native-read-smoke");
    let metadata = fs::symlink_metadata(&executable).map_err(|_| defect("native-executable"))?;
    // SAFETY: geteuid only observes this process identity.
    let uid = unsafe { libc::geteuid() };
    if identifier != "com.cerebro.native-read-smoke"
        || Path::new(&path) != expected
        || executable != expected_executable
        || !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.uid() != uid
        || metadata.mode() & 0o022 != 0
        || fs::canonicalize(&executable).map_err(|_| defect("native-executable"))? != executable
    {
        return Err(defect("native-bundle-mismatch"));
    }
    Ok(BundleObservation {
        identifier,
        path,
        executable_path: executable
            .to_str()
            .ok_or_else(|| defect("native-executable-utf8"))?
            .to_owned(),
    })
}
struct Session<'a> {
    app: &'a AppHandle,
    window: &'a WebviewWindow,
    store: Box<dyn SecretStore>,
    nonce: String,
    items: [Item; 3],
    receipts: Receipts,
    accessed: bool,
    cases: Vec<Case>,
}
impl Session<'_> {
    fn guard(&self) -> Result<()> {
        crate::actions::native_owner::authenticate_keychain_smoke(self.app, self.window)
            .map_err(|_| defect("injected-window-retired"))
    }
    fn record(&mut self, stage: &'static str) -> Result<()> {
        self.receipts.write(&self.nonce, stage, &self.items)
    }
    fn case(&mut self, name: &'static str, observed: &'static str) {
        self.cases.push(Case { name, observed });
    }
    fn resolve_matches(
        &mut self,
        index: usize,
        secret: &SecretValue,
        stage: &'static str,
    ) -> Result<()> {
        self.guard()?;
        self.accessed = true;
        let value = self
            .store
            .resolve(&self.items[index].reference)
            .map_err(|error| access(error, stage))?;
        if value.expose() != secret.expose() {
            return Err(defect(stage));
        }
        Ok(())
    }
    fn put(&mut self, index: usize, secret: &SecretValue, stage: &'static str) -> Result<()> {
        self.guard()?;
        if self.items[index].state != ItemState::Absent {
            return Err(defect("put-not-fresh"));
        }
        self.items[index].state = ItemState::PutInFlight;
        if let Err(error) = self.record(stage) {
            self.items[index].state = ItemState::Absent;
            return Err(error);
        }
        self.accessed = true;
        match self.store.put(&self.items[index].reference, secret) {
            Ok(()) => {
                self.items[index].state = ItemState::Owned;
                self.record("put-confirmed")
            }
            Err(error) => {
                // The OS may have committed despite a failed acknowledgement. No
                // automatic delete/read claim upgrades this to confirmed ownership.
                let _ = self.record("put-outcome-unknown");
                Err(access(error, stage))
            }
        }
    }
    fn delete_owned(&mut self, index: usize, stage: &'static str) -> Result<()> {
        if !matches!(
            self.items[index].state,
            ItemState::Owned | ItemState::DeleteInFlight
        ) {
            return Err(defect("delete-not-confirmed-owned"));
        }
        self.items[index].state = ItemState::DeleteInFlight;
        // Cleanup still targets only an in-memory confirmed-owned reference when a
        // later journal write fails; that failure remains pending in the report.
        let journal = self.record(stage);
        self.accessed = true;
        self.store
            .delete(&self.items[index].reference)
            .map_err(|error| access(error, stage))?;
        match self.store.resolve(&self.items[index].reference) {
            Err(ConnectionError::SignInRequired) => self.items[index].state = ItemState::Missing,
            Err(error) => return Err(access(error, stage)),
            Ok(_) => return Err(defect(stage)),
        }
        self.record("delete-confirmed-missing")?;
        journal
    }
    fn run(&mut self) -> Result<()> {
        self.record("fresh-references-before-io")?;
        for index in 0..3 {
            self.guard()?;
            self.accessed = true;
            match self.store.resolve(&self.items[index].reference) {
                Err(ConnectionError::SignInRequired) => self.items[index].state = ItemState::Absent,
                Err(error) => return Err(access(error, "fresh-reference-probe")),
                Ok(_) => {
                    self.items[index].state = ItemState::Preexisting;
                    self.record("unexpected-existing-reference")?;
                    return Err(defect("unexpected-existing-reference"));
                }
            }
        }
        self.record("three-references-missing")?;
        self.case("keychain-three-fresh-refs", "missing-sign-in-required");
        let random_secret = || {
            let mut bytes = vec![0u8; 32];
            rand::thread_rng().fill_bytes(&mut bytes);
            SecretValue::from_bytes(bytes).map_err(|_| defect("random-value-construction"))
        };
        let a = random_secret()?;
        let b = random_secret()?;
        let c = random_secret()?;
        if a.expose() == b.expose() || a.expose() == c.expose() || b.expose() == c.expose() {
            return Err(defect("random-values-collided"));
        }
        self.put(0, &a, "put-A-intent")?;
        self.case("keychain-create-A", "created");
        self.resolve_matches(0, &a, "read-A")?;
        self.case("keychain-read-A", "exact-rust-comparison");
        self.guard()?;
        self.record("duplicate-A-put-intent")?;
        self.accessed = true;
        match self.store.put(&self.items[0].reference, &b) {
            Err(ConnectionError::Unavailable) => (),
            Err(error) => return Err(access(error, "duplicate-A-put")),
            Ok(()) => return Err(defect("duplicate-A-put-accepted")),
        }
        self.resolve_matches(0, &a, "duplicate-A-original")?;
        self.record("duplicate-A-original-confirmed")?;
        self.case("keychain-duplicate-A", "refused-original-retained");
        self.put(1, &b, "put-B-intent")?;
        self.case("keychain-create-B", "fresh-reference-replacement");
        self.resolve_matches(0, &a, "independent-A")?;
        self.resolve_matches(1, &b, "independent-B")?;
        self.case("keychain-independent-A-B", "both-exact");
        self.guard()?;
        self.delete_owned(0, "delete-A-intent")?;
        self.resolve_matches(1, &b, "B-after-A-delete")?;
        self.case("keychain-delete-A", "A-missing-B-retained");
        self.put(2, &c, "put-C-intent")?;
        self.case("keychain-create-C", "uncommitted-candidate");
        self.guard()?;
        self.record("candidate-C-cancelled")?;
        self.delete_owned(2, "delete-C-intent")?;
        self.resolve_matches(1, &b, "B-after-C-cleanup")?;
        self.case("keychain-cancelled-C", "C-missing-B-retained");
        self.guard()?;
        self.delete_owned(1, "delete-B-intent")?;
        self.case("keychain-delete-B", "missing-sign-in-required");
        self.guard()?;
        self.record("repeat-delete-B-intent")?;
        self.accessed = true;
        self.store
            .delete(&self.items[1].reference)
            .map_err(|error| access(error, "repeat-delete-B"))?;
        self.case("keychain-repeat-delete-B", "idempotent");
        for index in 0..3 {
            self.guard()?;
            self.accessed = true;
            match self.store.resolve(&self.items[index].reference) {
                Err(ConnectionError::SignInRequired) => (),
                Err(error) => return Err(access(error, "final-missing-probe")),
                Ok(_) => return Err(defect("final-missing-probe")),
            }
        }
        self.record("all-confirmed-missing")?;
        self.case("keychain-final-cleanup", "all-three-missing");
        Ok(())
    }
    fn cleanup(&mut self) {
        for index in 0..3 {
            if matches!(
                self.items[index].state,
                ItemState::Owned | ItemState::DeleteInFlight
            ) {
                // Even on retired-window/error/panic, this run may clean only its
                // confirmed successful puts. Unknown puts are deliberately retained.
                let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    self.delete_owned(index, "failure-owned-cleanup")
                }));
            }
        }
    }
}
pub(crate) fn capture(app: &AppHandle, window: &WebviewWindow, root: &Path) -> Observation {
    let mut observation = Observation::incomplete("before-adapter");
    let prepared: Result<(BundleObservation, Receipts)> = (|| {
        crate::actions::native_owner::authenticate_keychain_smoke(app, window)
            .map_err(|_| defect("injected-window-authentication"))?;
        let observed_bundle = bundle(root)?;
        let receipts = Receipts::new(root)?;
        Ok((observed_bundle, receipts))
    })();
    let (observed_bundle, receipts) = match prepared {
        Ok(value) => value,
        Err(error) => {
            observation.outcome = error.kind;
            observation.failure_kind = Some(error.kind);
            observation.failed_stage = Some(error.stage);
            observation.cleanup = "not_needed";
            observation.keychain_access = Some(false);
            return observation;
        }
    };
    observation.bundle = Some(observed_bundle);
    let nonce = super::opaque_id();
    let account = AccountId(super::opaque_id());
    let items = std::array::from_fn(|index| Item {
        label: ["A", "B", "C"][index],
        reference: SecretRef {
            id: super::opaque_id(),
            account_id: account.clone(),
            issuer: "cerebro-native-acceptance".into(),
            subject: "disposable-noncredential".into(),
            secret_revision: (index + 1) as u64,
        },
        state: ItemState::Unchecked,
    });
    if items[0].reference.id == items[1].reference.id
        || items[0].reference.id == items[2].reference.id
        || items[1].reference.id == items[2].reference.id
    {
        observation.outcome = "defect";
        observation.failure_kind = Some("defect");
        observation.failed_stage = Some("random-reference-collision");
        observation.cleanup = "not_needed";
        observation.keychain_access = Some(false);
        return observation;
    }
    let mut session = Session {
        app,
        window,
        store: platform_secret_store(),
        nonce,
        items,
        receipts,
        accessed: false,
        cases: vec![Case {
            name: "keychain-injected-bundle",
            observed: "actual-window-private-app",
        }],
    };
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| session.run()))
        .unwrap_or(Err(defect("adapter-sequence-panicked")));
    session.cleanup();
    let pending = session.receipts.failed
        || session.items.iter().any(|item| {
            matches!(
                item.state,
                ItemState::PutInFlight | ItemState::Owned | ItemState::DeleteInFlight
            )
        });
    observation.outcome = if pending {
        "cleanup_pending"
    } else {
        result.as_ref().err().map_or("pass", |error| error.kind)
    };
    observation.failure_kind = result.as_ref().err().map(|error| error.kind);
    observation.failed_stage = result.as_ref().err().map(|error| error.stage);
    observation.cleanup = if pending { "pending" } else { "complete" };
    observation.cases = session.cases;
    observation.keychain_access = Some(session.accessed);
    observation.receipt_count = Some(session.receipts.next);
    observation.reference_count = Some(3);
    observation.confirmed_owned = Some(
        session
            .items
            .iter()
            .filter(|item| matches!(item.state, ItemState::Owned | ItemState::DeleteInFlight))
            .count(),
    );
    observation.uncertain_puts = Some(
        session
            .items
            .iter()
            .filter(|item| item.state == ItemState::PutInFlight)
            .count(),
    );
    observation
}

#[cfg(test)]
mod observation_tests {
    use super::Observation;

    #[test]
    fn keychain_observation_incomplete_counts_are_unavailable() {
        // These are the actual watchdog and outer-panic constructor paths; neither
        // has the live Session. This test constructs no store and performs no I/O.
        for stage in ["smoke-deadline", "keychain-worker-panicked"] {
            let value = serde_json::to_value(Observation::incomplete(stage)).unwrap();
            assert_eq!(value["outcome"], "cleanup_pending");
            assert_eq!(value["cleanup"], "unknown");
            assert_eq!(value["failedStage"], stage);
            assert!(value["keychainAccess"].is_null());
            for field in [
                "receiptCount",
                "referenceCount",
                "confirmedOwned",
                "uncertainPuts",
            ] {
                assert!(value.get(field).is_some(), "missing nullable field {field}");
                assert!(
                    value[field].is_null(),
                    "unobserved {field} must not be measured zero"
                );
            }
        }
    }

    #[test]
    fn keychain_observation_measured_zero_remains_numeric() {
        // Serialization control for a known measurement, not a native operation.
        let mut observed = Observation::incomplete("serialization-control");
        observed.receipt_count = Some(19);
        observed.reference_count = Some(3);
        observed.confirmed_owned = Some(0);
        observed.uncertain_puts = Some(0);
        let value = serde_json::to_value(observed).unwrap();
        assert_eq!(value["receiptCount"], 19);
        assert_eq!(value["referenceCount"], 3);
        assert_eq!(value["confirmedOwned"], 0);
        assert_eq!(value["uncertainPuts"], 0);
    }
}
