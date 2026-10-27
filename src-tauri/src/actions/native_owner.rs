//! Optional native ownership and retained runtime lineage. No action is enabled.
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior};
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use tauri::{AppHandle, Manager, Url, WebviewWindow};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum NativeOwnerError {
    Unavailable,
}
type OwnerResult<T> = Result<T, NativeOwnerError>;

// Only the owner of the actual transaction can distinguish a safe precommit
// refusal from an uncertain commit/acknowledgement. No second writer exists.
#[derive(Debug, PartialEq, Eq)]
enum RuntimeTransactionOutcome<T> {
    Committed(T),
    NotCommitted(NativeOwnerError),
    CommitUncertain,
}
fn unavailable<T>(_: T) -> NativeOwnerError {
    NativeOwnerError::Unavailable
}

#[derive(Clone, PartialEq, Eq)]
struct NativeWindowIdentity {
    window: usize,
    view: usize,
    label: String,
}
struct WindowRegistration {
    identity: NativeWindowIdentity,
    origin: PathBuf,
    live: AtomicBool,
}
struct WindowObservation {
    registration: Arc<WindowRegistration>,
    injected: NativeWindowIdentity,
    current: NativeWindowIdentity,
    origin: PathBuf,
    entry: Url,
}
fn verify_window(
    owner: &Arc<WindowRegistration>,
    observed: &WindowObservation,
    dev_root: Option<&Url>,
) -> OwnerResult<()> {
    if !owner.live.load(Ordering::SeqCst)
        || !Arc::ptr_eq(owner, &observed.registration)
        || owner.identity.window == 0
        || owner.identity.view == 0
        || owner.identity.label != crate::shell::MAIN_WINDOW
        || observed.injected != owner.identity
        || observed.current != owner.identity
        || observed.origin != owner.origin
        || crate::shell::links::classify(&observed.entry, dev_root)
            != crate::shell::links::LinkVerdict::Allow
    {
        return Err(NativeOwnerError::Unavailable);
    }
    Ok(())
}
#[cfg(target_os = "macos")]
// Private fixed-result native-read gate. It cannot construct an attended,
// opening or action proof; the actual window getter supplies the read below.
fn read_main_window_identity(
    read: impl FnOnce() -> OwnerResult<NativeWindowIdentity>,
) -> OwnerResult<NativeWindowIdentity> {
    let _main = objc2::MainThreadMarker::new().ok_or(NativeOwnerError::Unavailable)?;
    read()
}
#[cfg(target_os = "macos")]
fn window_identity(window: &WebviewWindow) -> OwnerResult<NativeWindowIdentity> {
    read_main_window_identity(|| {
        let identity = NativeWindowIdentity {
            window: window.ns_window().map_err(unavailable)? as usize,
            view: window.ns_view().map_err(unavailable)? as usize,
            label: window.label().to_owned(),
        };
        if identity.window == 0 || identity.view == 0 || identity.label != crate::shell::MAIN_WINDOW
        {
            return Err(NativeOwnerError::Unavailable);
        }
        Ok(identity)
    })
}
#[cfg(not(target_os = "macos"))]
fn window_identity(_: &WebviewWindow) -> OwnerResult<NativeWindowIdentity> {
    Err(NativeOwnerError::Unavailable)
}
struct StorageState {
    owner: Option<RuntimeOwner>,
    failed: bool,
}
struct NativeOwnerState {
    action_cancellations: Arc<native_actions::cancellation::CancellationBook>,
    credential_cancellations: Arc<credential_cancel::CancellationBook>,
    registration: Arc<WindowRegistration>,
    storage: Mutex<StorageState>,
}

/// Called beside the window shell actually constructed. Failure is local to
/// M96 and does not change the window/vault/legacy CLI result.
pub(crate) fn register(app: &AppHandle, window: &WebviewWindow) {
    let installed = (|| -> OwnerResult<()> {
        if app.try_state::<Arc<NativeOwnerState>>().is_some() {
            return Err(NativeOwnerError::Unavailable);
        }
        let identity = window_identity(window)?;
        let current = app
            .get_webview_window(crate::shell::MAIN_WINDOW)
            .ok_or(NativeOwnerError::Unavailable)?;
        if window_identity(&current)? != identity {
            return Err(NativeOwnerError::Unavailable);
        }
        let origin = crate::config_dir(app)
            .map_err(unavailable)?
            .canonicalize()
            .map_err(unavailable)?;
        private_directory(&origin)?;
        let state = Arc::new(NativeOwnerState {
            action_cancellations: Arc::default(),
            credential_cancellations: Arc::default(),
            registration: Arc::new(WindowRegistration {
                identity,
                origin,
                live: AtomicBool::new(true),
            }),
            storage: Mutex::new(StorageState {
                owner: None,
                failed: false,
            }),
        });
        if !app.manage(state) {
            return Err(NativeOwnerError::Unavailable);
        }
        Ok(())
    })();
    if installed.is_err() {
        log::warn!("managed action native ownership is unavailable");
    }
}
/// Registrations are never replaced. This app's Destroyed event retires its
/// one actual registration; retain storage until owned operations settle.
pub(crate) fn retire(app: &AppHandle) {
    if let Some(owner) = app.try_state::<Arc<NativeOwnerState>>() {
        owner.registration.live.store(false, Ordering::SeqCst);
        owner.action_cancellations.cancel_all();
        owner.credential_cancellations.cancel_all();
    }
}
struct AttendedWindowProof {
    owner: Arc<NativeOwnerState>,
}
struct MainThreadSnapshot {
    injected: NativeWindowIdentity,
    current: NativeWindowIdentity,
    entry: Url,
}
/// Schedule and return only owned native scalar/string observations. Never
/// enter this function under ActiveRoot, listener, agent, storage or SQLite
/// locks. The callback cannot publish an owner/action proof or write any state.
fn snapshot_on_main_thread(
    app: &AppHandle,
    window: &WebviewWindow,
) -> OwnerResult<MainThreadSnapshot> {
    let (send, receive) = std::sync::mpsc::sync_channel(1);
    let capture_app = app.clone();
    let capture_window = window.clone();
    app.run_on_main_thread(move || {
        let observed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let owner = capture_window
                .app_handle()
                .try_state::<Arc<NativeOwnerState>>()
                .ok_or(NativeOwnerError::Unavailable)?;
            if !owner.registration.live.load(Ordering::SeqCst) {
                return Err(NativeOwnerError::Unavailable);
            }
            let current = capture_app
                .get_webview_window(crate::shell::MAIN_WINDOW)
                .ok_or(NativeOwnerError::Unavailable)?;
            Ok(MainThreadSnapshot {
                injected: window_identity(&capture_window)?,
                current: window_identity(&current)?,
                entry: capture_window.url().map_err(unavailable)?,
            })
        }))
        .map_err(unavailable)
        .and_then(|value| value);
        // A timeout cannot later publish proof/state. A late observation is
        // dropped without blocking the main loop when the receiver has gone.
        let _ = send.try_send(observed);
    })
    .map_err(unavailable)?;
    receive
        .recv_timeout(std::time::Duration::from_secs(2))
        .map_err(unavailable)?
}
fn authenticate(app: &AppHandle, window: &WebviewWindow) -> OwnerResult<AttendedWindowProof> {
    let owner = app
        .try_state::<Arc<NativeOwnerState>>()
        .ok_or(NativeOwnerError::Unavailable)?
        .inner()
        .clone();
    let injected = window
        .app_handle()
        .try_state::<Arc<NativeOwnerState>>()
        .ok_or(NativeOwnerError::Unavailable)?;
    if !Arc::ptr_eq(&owner, injected.inner()) {
        return Err(NativeOwnerError::Unavailable);
    }
    // The AppHandle/state comparison above is thread-safe; native window and
    // URL reads happen together on the real main thread before authority locks.
    let native = snapshot_on_main_thread(app, window)?;
    let observed = WindowObservation {
        registration: injected.registration.clone(),
        injected: native.injected,
        current: native.current,
        origin: crate::config_dir(app)
            .map_err(unavailable)?
            .canonicalize()
            .map_err(unavailable)?,
        entry: native.entry,
    };
    let dev_root = if tauri::is_dev() {
        app.config().build.dev_url.as_ref()
    } else {
        None
    };
    verify_window(&owner.registration, &observed, dev_root)?;
    Ok(AttendedWindowProof { owner })
}

// Only the private, opt-in connections::keychain_acceptance caller uses this.
// Authenticate the actual injected window without exposing its proof, storage,
// opening, run authority or a constructor. Normal production exports are unchanged.
#[cfg(feature = "native-keychain-smoke")]
pub(crate) fn authenticate_keychain_smoke(
    app: &AppHandle,
    window: &WebviewWindow,
) -> Result<(), NativeOwnerError> {
    authenticate(app, window).map(|_| ())
}

/// Actual opening calls this after sink arm but BEFORE process/session
/// production. Never reopen failed lineage from a newly named file. This
/// creates no session, owner/action proof, account grant or invocation.
pub(crate) fn prepare_storage(app: &AppHandle) -> OwnerResult<()> {
    let state = app
        .try_state::<Arc<NativeOwnerState>>()
        .ok_or(NativeOwnerError::Unavailable)?;
    if !state.registration.live.load(Ordering::SeqCst) {
        return Err(NativeOwnerError::Unavailable);
    }
    let mut storage = state.storage.lock().map_err(unavailable)?;
    if storage.failed {
        return Err(NativeOwnerError::Unavailable);
    }
    let result = match storage.owner.as_mut() {
        Some(owner) => {
            owner.action_cancellations = Arc::downgrade(&state.action_cancellations);
            owner.validate()
        }
        None => RuntimeOwner::open_existing(&state.registration.origin).map(|mut owner| {
            owner.action_cancellations = Arc::downgrade(&state.action_cancellations);
            storage.owner = Some(owner);
        }),
    };
    if result.is_err() {
        storage.failed = true;
        state.action_cancellations.cancel_all();
        state.credential_cancellations.cancel_all();
    }
    result
}

/// Historical terminalization only, before generic attended recovery and before
/// binding any new opening/session. No source publication or capsule is rebuilt.
pub(crate) fn recover_unstarted_children(
    app: &AppHandle,
    cutoff: chrono::DateTime<chrono::Utc>,
) -> OwnerResult<usize> {
    let state = app
        .try_state::<Arc<NativeOwnerState>>()
        .ok_or(NativeOwnerError::Unavailable)?;
    let mut storage = state.storage.lock().map_err(unavailable)?;
    if storage.failed {
        return Err(NativeOwnerError::Unavailable);
    }
    let owner = storage
        .owner
        .as_mut()
        .ok_or(NativeOwnerError::Unavailable)?;
    owner.transaction(|tx| {
        crate::runtime::child_claim_history::recover(tx, cutoff, chrono::Utc::now())
            .map_err(unavailable)
    })
}

/// Receives the existing command's injected window and real scope only AFTER
/// successful legacy publication released ActiveRoot. Missing provenance is
/// never written here. No action, account or RunGrant authority is created.
/// Opening-binding-only observation. No proof/owner accessor or other consumer.
pub(crate) struct OpeningBindingObservation {
    proof: AttendedWindowProof,
}
pub(crate) fn observe_opening_binding(
    app: &AppHandle,
    window: &WebviewWindow,
) -> OwnerResult<OpeningBindingObservation> {
    authenticate(app, window).map(|proof| OpeningBindingObservation { proof })
}
pub(crate) fn bind_opening(
    observation: OpeningBindingObservation,
    context: &crate::workspace_service::authority::AuthorityContext,
    root: &Path,
    scope: &crate::runtime::VaultScope,
    attempt: &crate::workspace_service::authority::OpeningAttempt,
) -> OwnerResult<()> {
    let proof = observation.proof;
    context
        .with_published_legacy_attempt(attempt, root, || {
            if !proof.owner.registration.live.load(Ordering::SeqCst) {
                return Err(NativeOwnerError::Unavailable);
            }
            let mut storage = proof.owner.storage.lock().map_err(unavailable)?;
            if storage.failed {
                return Err(NativeOwnerError::Unavailable);
            }
            let owner = storage
                .owner
                .as_mut()
                .ok_or(NativeOwnerError::Unavailable)?;
            owner.check_open_session(root, scope)?;
            if !proof.owner.registration.live.load(Ordering::SeqCst) {
                return Err(NativeOwnerError::Unavailable);
            }
            Ok(())
        })
        .map_err(unavailable)?
}

// Created only at the actual injected desktop command. Borrowing preserves the
// original preparation and managed AgentState/MCP instances without recapture.
pub(crate) struct NativeRootEntry<'a> {
    proof: AttendedWindowProof,
    context: crate::workspace_service::authority::AuthorityContext,
    opening: crate::workspace_service::authority::LegacyOpeningTicket,
    root: PathBuf,
    agents: &'a crate::agent::AgentState,
    preparation: &'a crate::agent::RunPreparation,
    mcp: &'a crate::mcp::McpState,
    authority_id: String,
}

pub(crate) fn prepare_root_entry<'a>(
    app: &AppHandle,
    window: &WebviewWindow,
    root: &Path,
    agents: &'a crate::agent::AgentState,
    preparation: &'a crate::agent::RunPreparation,
    mcp: &'a crate::mcp::McpState,
) -> OwnerResult<NativeRootEntry<'a>> {
    // Main-thread observation must finish before any authority/agent/storage
    // lock. Neither an attended flag nor a supplied actor proves native owner.
    let proof = authenticate(app, window)?;
    let actual_agents = app
        .try_state::<crate::agent::AgentState>()
        .ok_or(NativeOwnerError::Unavailable)?;
    let actual_mcp = app
        .try_state::<crate::mcp::McpState>()
        .ok_or(NativeOwnerError::Unavailable)?;
    if !std::ptr::eq(actual_agents.inner(), agents) || !std::ptr::eq(actual_mcp.inner(), mcp) {
        return Err(NativeOwnerError::Unavailable);
    }
    let root = root.canonicalize().map_err(unavailable)?;
    let _ = root.to_str().ok_or(NativeOwnerError::Unavailable)?;
    let context = crate::workspace_service::authority::context().map_err(unavailable)?;
    let opening = context.capture_legacy_opening(&root).map_err(unavailable)?;
    if !proof.owner.registration.live.load(Ordering::SeqCst) {
        return Err(NativeOwnerError::Unavailable);
    }
    Ok(NativeRootEntry {
        proof,
        context,
        opening,
        root,
        agents,
        preparation,
        mcp,
        authority_id: crate::ledger::new_id128(),
    })
}

// Optional native-observation I/O ceiling; the ledger's format is unchanged.
#[cfg(target_os = "macos")]
const NATIVE_STORE_MAX_BYTES: u64 = 4096;

struct NativeStoreObservation {
    info: crate::ledger::store::StoreInfo,
    #[cfg(target_os = "macos")]
    source: NativeStoreFile,
    #[cfg(target_os = "macos")]
    bytes: Vec<u8>,
}

impl NativeStoreObservation {
    // Read the original regular-file handle, never reopen or adopt a new inode.
    #[cfg(target_os = "macos")]
    fn recheck(&self) -> OwnerResult<()> {
        if self.source.read()? != self.bytes {
            return Err(NativeOwnerError::Unavailable);
        }
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    fn recheck(&self) -> OwnerResult<()> {
        Err(NativeOwnerError::Unavailable)
    }
}

#[cfg(target_os = "macos")]
struct NativeStoreFile {
    file: std::fs::File,
    path: PathBuf,
    identity: (u64, u64),
    directories: Vec<(PathBuf, (u64, u64))>,
}

#[cfg(target_os = "macos")]
fn open_store_component(
    parent: std::os::fd::RawFd,
    name: &std::ffi::CStr,
    directory: bool,
) -> OwnerResult<std::fs::File> {
    use std::os::fd::FromRawFd;
    let flags = libc::O_RDONLY
        | libc::O_NOFOLLOW
        | libc::O_NONBLOCK
        | libc::O_CLOEXEC
        | if directory { libc::O_DIRECTORY } else { 0 };
    // SAFETY: parent is live (or AT_FDCWD), name is NUL-terminated, no creation
    // flag or variadic mode is needed. The new fd is owned exactly once below.
    let fd = unsafe { libc::openat(parent, name.as_ptr(), flags) };
    if fd < 0 {
        return Err(NativeOwnerError::Unavailable);
    }
    // SAFETY: successful openat returned this fresh, uniquely owned descriptor.
    Ok(unsafe { std::fs::File::from_raw_fd(fd) })
}

#[cfg(target_os = "macos")]
impl NativeStoreFile {
    fn open(root: &Path) -> OwnerResult<Self> {
        use std::{
            ffi::CString,
            os::{fd::AsRawFd, unix::ffi::OsStrExt},
            path::Component,
        };
        if !root.is_absolute()
            || root.to_str().is_none()
            || root.as_os_str().len()
                > super::native_rules::admission_rules()
                    .limits
                    .canonical_path_bytes
        {
            return Err(NativeOwnerError::Unavailable);
        }
        let path = crate::ledger::ledger_dir(root).join("store.json");
        let parent = path.parent().ok_or(NativeOwnerError::Unavailable)?;
        // Walk from / with actual directory handles; leaf-only NOFOLLOW would
        // still follow a substituted .cerebro/ledger or vault ancestor symlink.
        let mut directory = open_store_component(libc::AT_FDCWD, c"/", true)?;
        let mut current = PathBuf::from("/");
        let mut directories = vec![(
            current.clone(),
            physical_identity(&directory.metadata().map_err(unavailable)?),
        )];
        for component in parent.components() {
            match component {
                Component::RootDir => continue,
                Component::Normal(name) => {
                    let name_c = CString::new(name.as_bytes()).map_err(unavailable)?;
                    directory = open_store_component(directory.as_raw_fd(), &name_c, true)?;
                    current.push(name);
                    let metadata = directory.metadata().map_err(unavailable)?;
                    if !metadata.is_dir() {
                        return Err(NativeOwnerError::Unavailable);
                    }
                    directories.push((current.clone(), physical_identity(&metadata)));
                }
                _ => return Err(NativeOwnerError::Unavailable),
            }
        }
        let named = std::fs::symlink_metadata(&path).map_err(unavailable)?;
        if !named.is_file()
            || named.file_type().is_symlink()
            || named.len() > NATIVE_STORE_MAX_BYTES
        {
            return Err(NativeOwnerError::Unavailable);
        }
        let identity = physical_identity(&named);
        #[cfg(test)]
        tests::store_before_open();
        let file = open_store_component(directory.as_raw_fd(), c"store.json", false)?;
        #[cfg(test)]
        tests::store_after_open();
        let source = Self {
            file,
            path,
            identity,
            directories,
        };
        source.validate_name()?;
        Ok(source)
    }

    fn validate_name(&self) -> OwnerResult<()> {
        for (path, identity) in &self.directories {
            let named = std::fs::symlink_metadata(path).map_err(unavailable)?;
            if !named.is_dir()
                || named.file_type().is_symlink()
                || physical_identity(&named) != *identity
            {
                return Err(NativeOwnerError::Unavailable);
            }
        }
        let named = std::fs::symlink_metadata(&self.path).map_err(unavailable)?;
        let held = self.file.metadata().map_err(unavailable)?;
        if !named.is_file()
            || named.file_type().is_symlink()
            || !held.is_file()
            || physical_identity(&named) != self.identity
            || physical_identity(&held) != self.identity
        {
            return Err(NativeOwnerError::Unavailable);
        }
        Ok(())
    }

    fn read(&self) -> OwnerResult<Vec<u8>> {
        use std::os::unix::fs::{FileExt, MetadataExt};
        self.validate_name()?;
        let before = self.file.metadata().map_err(unavailable)?;
        if before.len() > NATIVE_STORE_MAX_BYTES {
            return Err(NativeOwnerError::Unavailable);
        }
        let mut bytes = Vec::with_capacity(before.len() as usize);
        let mut block = [0_u8; 1024];
        while bytes.len() as u64 <= NATIVE_STORE_MAX_BYTES {
            let remaining = (NATIVE_STORE_MAX_BYTES + 1 - bytes.len() as u64) as usize;
            let limit = remaining.min(block.len());
            let count = self
                .file
                .read_at(&mut block[..limit], bytes.len() as u64)
                .map_err(unavailable)?;
            if count == 0 {
                break;
            }
            bytes.extend_from_slice(&block[..count]);
        }
        #[cfg(test)]
        tests::store_after_read();
        let after = self.file.metadata().map_err(unavailable)?;
        self.validate_name()?;
        if bytes.len() as u64 > NATIVE_STORE_MAX_BYTES
            || bytes.len() as u64 != before.len()
            || after.len() != before.len()
            || physical_identity(&after) != self.identity
            || (
                before.mtime(),
                before.mtime_nsec(),
                before.ctime(),
                before.ctime_nsec(),
            ) != (
                after.mtime(),
                after.mtime_nsec(),
                after.ctime(),
                after.ctime_nsec(),
            )
        {
            return Err(NativeOwnerError::Unavailable);
        }
        Ok(bytes)
    }
}

// Private reader only. StoreInfo and STORE_FORMAT remain the sole parser
// contract; no mint, source write, runtime descriptor or authority is created.
#[cfg(target_os = "macos")]
fn read_native_store(root: &Path) -> OwnerResult<NativeStoreObservation> {
    let source = NativeStoreFile::open(root)?;
    let bytes = source.read()?;
    let info: crate::ledger::store::StoreInfo =
        serde_json::from_slice(&bytes).map_err(unavailable)?;
    if info.format != crate::ledger::store::STORE_FORMAT {
        return Err(NativeOwnerError::Unavailable);
    }
    Ok(NativeStoreObservation {
        info,
        source,
        bytes,
    })
}
#[cfg(not(target_os = "macos"))]
fn read_native_store(_: &Path) -> OwnerResult<NativeStoreObservation> {
    Err(NativeOwnerError::Unavailable)
}

impl NativeRootEntry<'_> {
    fn validate_scope(
        &self,
        scope: &crate::runtime::VaultScope,
        receipt: &crate::agent::NativePublicationReceipt,
        actual_store: &NativeStoreObservation,
    ) -> OwnerResult<()> {
        let rules = super::native_rules::admission_rules();
        let bounds = &rules.limits;
        let store = scope
            .store_uuid
            .as_deref()
            .ok_or(NativeOwnerError::Unavailable)?;
        let process = crate::runtime::sessions::session_id();
        let session = receipt
            .cli_session_id()
            .ok_or(NativeOwnerError::Unavailable)?;
        if !self.proof.owner.registration.live.load(Ordering::SeqCst)
            || self.root.canonicalize().map_err(unavailable)? != self.root
            || self.root.as_os_str().len() > bounds.canonical_path_bytes
            || self.root.to_str().is_none()
            || crate::runtime::scope::derive_vault_id(&self.root) != scope.vault_id
            || [
                scope.vault_id.as_str(),
                store,
                receipt.run_id(),
                receipt.actor_id(),
            ]
            .iter()
            .any(|value| value.is_empty() || value.len() > bounds.identity_bytes)
            || process.is_empty()
            || process.len() > bounds.process_session_bytes
            || !crate::runtime::cause::is_cli_session_id(session)
        {
            return Err(NativeOwnerError::Unavailable);
        }
        // Read existing identity only. No mint, activation, registration or
        // conversion can repair missing provenance during optional finalization.
        actual_store.recheck()?;
        if actual_store.info.store_id != store {
            return Err(NativeOwnerError::Unavailable);
        }
        Ok(())
    }
}

// One optional origin lives on its actual source slot, never in a run-ID map.
// It retains the exact original seal only after the original finalizer commits.
pub(crate) struct NativeActionReadOrigin {
    runtime_seal: Arc<()>,
    owner: Arc<NativeOwnerState>,
    context: crate::workspace_service::authority::AuthorityContext,
    opening: crate::workspace_service::authority::LegacyOpeningTicket,
    root: PathBuf,
    store: NativeStoreObservation,
    scope: crate::runtime::VaultScope,
    authority_id: String,
    revision: u64,
    entry: crate::agent::RetainedPublicationEntry,
    slot: crate::mcp::NativeSlotWitness,
    receipt: Arc<crate::agent::NativePublicationReceipt>,
}

pub(crate) fn register_published_root(
    entry: NativeRootEntry<'_>,
    slot: crate::mcp::NativeSlotWitness,
    scope: &crate::runtime::VaultScope,
) -> OwnerResult<()> {
    // No MCP lock crosses ActiveRoot/admission/storage/SQLite.
    let receipt = entry
        .mcp
        .current_native_publication(&slot)
        .ok_or(NativeOwnerError::Unavailable)?;
    let actual_store = read_native_store(&entry.root)?;
    let (retained, revision, runtime_seal) = entry
        .context
        .with_legacy_opening(&entry.opening, || {
            let publication = entry
                .agents
                .guard_publication_entry(entry.preparation, &entry.root, &receipt)
                .map_err(unavailable)?;
            let mut storage = entry.proof.owner.storage.lock().map_err(unavailable)?;
            if storage.failed {
                return Err(NativeOwnerError::Unavailable);
            }
            let owner = storage
                .owner
                .as_mut()
                .ok_or(NativeOwnerError::Unavailable)?;
            let revision = owner.transaction(|tx| {
                entry.validate_scope(scope, &receipt, &actual_store)?;
                RuntimeOwner::record_root_rows(
                    tx,
                    &entry.root,
                    scope,
                    &receipt,
                    &entry.authority_id,
                )?;
                entry.validate_scope(scope, &receipt, &actual_store)?;
                if !publication.recheck() {
                    return Err(NativeOwnerError::Unavailable);
                }
                let row = super::native_lineage::load_run(
                    super::native_db::AuthorityDb::Writer(tx),
                    receipt.run_id(),
                )
                .map_err(unavailable)?;
                if row.authority_id != entry.authority_id {
                    return Err(NativeOwnerError::Unavailable);
                }
                Ok(row.revision)
            })?;
            // The only production strong-seal capture follows a successful commit.
            Ok((
                publication.retain_original_entry(),
                revision,
                owner.runtime_seal.clone(),
            ))
        })
        .map_err(unavailable)??;
    let agents = entry.agents;
    let current = entry
        .mcp
        .current_native_publication(&slot)
        .ok_or(NativeOwnerError::Unavailable)?;
    if !Arc::ptr_eq(&current, &receipt) {
        return Err(NativeOwnerError::Unavailable);
    }
    let origin = Arc::new(NativeActionReadOrigin {
        runtime_seal,
        owner: entry.proof.owner,
        context: entry.context,
        opening: entry.opening,
        root: entry.root,
        store: actual_store,
        scope: scope.clone(),
        authority_id: entry.authority_id,
        revision,
        entry: retained,
        slot,
        receipt,
    });
    // The first guard is gone before ActiveRoot is acquired again. Installation
    // checks the original generation and source slot, with no SQLite/MCP wait.
    origin
        .context
        .with_legacy_opening(&origin.opening, || {
            let publication = agents
                .guard_retained_publication(&origin.entry, &origin.receipt)
                .map_err(unavailable)?;
            if !origin.owner.registration.live.load(Ordering::SeqCst)
                || !publication.recheck()
                || !agents.install_native_action_read(&origin.receipt, origin.clone())
            {
                return Err(NativeOwnerError::Unavailable);
            }
            Ok(())
        })
        .map_err(unavailable)?
}

fn read_unavailable() -> super::read_types::ActionReadError {
    super::read_types::ActionReadError {
        code: super::read_types::ActionReadErrorCode::Unavailable,
        retry_disposition: super::read_types::RetryDisposition::Never,
        message: "Native action metadata is unavailable.".into(),
    }
}
// This capability is created only within the guarded retained-read closure.
// It contains no callable ActionSubject, mutation connection or secret resolver.
struct AdmittedActionRead<'a> {
    db: super::native_db::AuthorityDb<'a>,
    scope: super::read_types::ActionSubjectView,
    owner: &'a str,
}
impl AdmittedActionRead<'_> {
    fn catalog(
        &self,
        cursor: Option<super::read_types::CatalogCursor>,
    ) -> Result<super::read_types::ActionCatalogPage, super::read_types::ActionReadError> {
        super::native_authority::ScopedCatalog {
            catalog: super::compiled_catalog::compiled_catalog()?,
            scope: &self.scope,
            owner: self.owner,
            execution: super::native_authority::CatalogExecution::NoExecutor,
        }
        .catalog(self.db, cursor)
    }
    fn definition(
        &self,
        id: super::read_types::ActionId,
        digest: super::read_types::DefinitionDigest,
    ) -> Result<super::read_types::ActionDefinitionView, super::read_types::ActionReadError> {
        super::native_authority::ScopedCatalog {
            catalog: super::compiled_catalog::compiled_catalog()?,
            scope: &self.scope,
            owner: self.owner,
            execution: super::native_authority::CatalogExecution::NoExecutor,
        }
        .definition(self.db, id, digest)
    }
}
fn with_action_read<T>(
    app: &AppHandle,
    window: &WebviewWindow,
    run: u64,
    operation: impl FnOnce(AdmittedActionRead<'_>) -> Result<T, super::read_types::ActionReadError>,
) -> Result<T, super::read_types::ActionReadError> {
    // Authentication's main-thread callback always precedes authority locks.
    let proof = authenticate(app, window).map_err(|_| read_unavailable())?;
    let agents = app
        .try_state::<crate::agent::AgentState>()
        .ok_or_else(read_unavailable)?;
    let mcp = app
        .try_state::<crate::mcp::McpState>()
        .ok_or_else(read_unavailable)?;
    let origin = agents
        .native_action_read(run)
        .ok_or_else(read_unavailable)?;
    if !Arc::ptr_eq(&proof.owner, &origin.owner) {
        return Err(read_unavailable());
    }
    let current = mcp
        .current_native_publication(&origin.slot)
        .ok_or_else(read_unavailable)?;
    if !Arc::ptr_eq(&current, &origin.receipt) {
        return Err(read_unavailable());
    }
    origin.store.recheck().map_err(|_| read_unavailable())?;
    let value = origin
        .context
        .with_legacy_opening(&origin.opening, || {
            let publication = agents
                .guard_retained_publication(&origin.entry, &origin.receipt)
                .map_err(unavailable)?;
            if !proof.owner.registration.live.load(Ordering::SeqCst) {
                return Err(NativeOwnerError::Unavailable);
            }
            let mut storage = proof.owner.storage.lock().map_err(unavailable)?;
            if storage.failed {
                return Err(NativeOwnerError::Unavailable);
            }
            let owner = storage
                .owner
                .as_mut()
                .ok_or(NativeOwnerError::Unavailable)?;
            owner.action_cancellations = Arc::downgrade(&origin.owner.action_cancellations);
            if !Arc::ptr_eq(&owner.runtime_seal, &origin.runtime_seal) {
                return Err(NativeOwnerError::Unavailable);
            }
            owner.read_snapshot(|read| {
                origin.store.recheck()?;
                let rules = super::native_rules::admission_rules();
                let binding = super::native_lineage::NativeBinding {
                    run_id: origin.receipt.run_id(),
                    vault_id: &origin.scope.vault_id,
                    store_uuid: origin
                        .scope
                        .store_uuid
                        .as_deref()
                        .ok_or(NativeOwnerError::Unavailable)?,
                    canonical_vault: &origin.root,
                    owner_person: &rules.owner_storage_key,
                    actor_id: origin.receipt.actor_id(),
                    source_kind: "run",
                    app_session_id: crate::runtime::sessions::session_id(),
                    cli_session_id: origin.receipt.cli_session_id(),
                    parent_run_id: None,
                    client_id: None,
                    child_job_id: None,
                };
                let db = super::native_db::AuthorityDb::Retained(read);
                let joined = super::native_lineage::resolve_lineage(db, &binding, false)
                    .map_err(unavailable)?;
                if !joined.can_call
                    || joined.row.authority_id != origin.authority_id
                    || joined.row.revision != origin.revision
                    || origin.store.info.store_id != binding.store_uuid
                {
                    return Err(NativeOwnerError::Unavailable);
                }
                let result = operation(AdmittedActionRead {
                    db,
                    scope: super::read_types::ActionSubjectView {
                        vault_id: joined.row.vault_id,
                        run_id: joined.row.run_id,
                        actor_id: joined.row.actor_id,
                        child_job_id: joined.row.child_job_id,
                        client_id: joined.row.client_id,
                    },
                    owner: &rules.owner_storage_key,
                });
                origin.store.recheck()?;
                if !publication.recheck() || !proof.owner.registration.live.load(Ordering::SeqCst) {
                    return Err(NativeOwnerError::Unavailable);
                }
                Ok(result)
            })
        })
        .map_err(|_| read_unavailable())?
        .map_err(|_| read_unavailable())?;
    // Source token/listener checks happen after all authority/storage guards drop.
    let current = mcp
        .current_native_publication(&origin.slot)
        .ok_or_else(read_unavailable)?;
    if !Arc::ptr_eq(&current, &origin.receipt)
        || !proof.owner.registration.live.load(Ordering::SeqCst)
    {
        return Err(read_unavailable());
    }
    value
}
pub(crate) fn catalog(
    app: &AppHandle,
    window: &WebviewWindow,
    run: u64,
    cursor: Option<super::read_types::CatalogCursor>,
) -> Result<super::read_types::ActionCatalogPage, super::read_types::ActionReadError> {
    with_action_read(app, window, run, |read| read.catalog(cursor))
}
pub(crate) fn definition(
    app: &AppHandle,
    window: &WebviewWindow,
    run: u64,
    id: super::read_types::ActionId,
    digest: super::read_types::DefinitionDigest,
) -> Result<super::read_types::ActionDefinitionView, super::read_types::ActionReadError> {
    with_action_read(app, window, run, |read| read.definition(id, digest))
}
pub(crate) fn managed_status(
    app: &AppHandle,
    window: &WebviewWindow,
    id: crate::actions::ids::ConnectionId,
) -> Result<crate::connections::ConnectionStatus, crate::connections::ConnectionError> {
    use crate::connections::{
        metadata::{MetadataRecord, STATUS_SQL},
        ConnectionError,
    };
    use rusqlite::OptionalExtension;
    let proof = authenticate(app, window).map_err(|_| ConnectionError::Unavailable)?;
    if id.0.is_empty() || id.0.len() > super::native_rules::admission_rules().limits.identity_bytes
    {
        return Err(ConnectionError::InvalidSelection);
    }
    let mut storage = proof
        .owner
        .storage
        .lock()
        .map_err(|_| ConnectionError::Unavailable)?;
    if storage.failed {
        return Err(ConnectionError::Unavailable);
    }
    let owner = storage.owner.as_mut().ok_or(ConnectionError::Unavailable)?;
    let result = owner
        .read_snapshot(|read| {
            let found = read
                .query(
                    STATUS_SQL,
                    &[
                        &id.0,
                        &super::native_rules::admission_rules().owner_storage_key,
                    ],
                    MetadataRecord::read,
                )
                .optional()
                .map_err(unavailable)?;
            if !proof.owner.registration.live.load(Ordering::SeqCst) {
                return Err(NativeOwnerError::Unavailable);
            }
            Ok(found.map(|record| record.status))
        })
        .map_err(|_| ConnectionError::Unavailable)?;
    let status = result.ok_or(ConnectionError::NotFound)?;
    if status.connection_id != id {
        return Err(ConnectionError::Unavailable);
    }
    Ok(status)
}

#[cfg(target_os = "macos")]
fn physical_identity(metadata: &std::fs::Metadata) -> (u64, u64) {
    use std::os::unix::fs::MetadataExt;
    (metadata.dev(), metadata.ino())
}
#[cfg(target_os = "macos")]
fn private_path(path: &Path, directory: bool) -> OwnerResult<(u64, u64)> {
    use std::os::unix::{ffi::OsStrExt, fs::MetadataExt};
    let metadata = std::fs::symlink_metadata(path).map_err(unavailable)?;
    // SAFETY: geteuid has no arguments or borrowed state and cannot mutate Rust
    // memory. Match the actual process uid, never a caller-provided owner id.
    let uid = unsafe { libc::geteuid() };
    if metadata.file_type().is_symlink()
        || (directory && !metadata.is_dir())
        || (!directory && !metadata.is_file())
        || metadata.uid() != uid
        || metadata.mode() & 0o022 != 0
    {
        return Err(NativeOwnerError::Unavailable);
    }
    let name = std::ffi::CString::new(path.as_os_str().as_bytes()).map_err(unavailable)?;
    let mut info = std::mem::MaybeUninit::<libc::statfs>::uninit();
    // SAFETY: name is a live NUL-terminated path; info is writable statfs space.
    // statfs writes only that space and retains neither pointer. Do NOT open
    // and close a second File here: closing any fd for this database could drop
    // this process's POSIX SQLite locks during the active transaction.
    if unsafe { libc::statfs(name.as_ptr(), info.as_mut_ptr()) } != 0 {
        return Err(NativeOwnerError::Unavailable);
    }
    // SAFETY: successful statfs initialized the complete statfs result above.
    let info = unsafe { info.assume_init() };
    if info.f_flags & libc::MNT_LOCAL as u32 == 0 {
        return Err(NativeOwnerError::Unavailable);
    }
    Ok(physical_identity(&metadata))
}
#[cfg(target_os = "macos")]
fn private_directory(path: &Path) -> OwnerResult<(u64, u64)> {
    if !path.is_absolute() || path.canonicalize().map_err(unavailable)? != path {
        return Err(NativeOwnerError::Unavailable);
    }
    private_path(path, true)
}
#[cfg(not(target_os = "macos"))]
fn private_directory(_: &Path) -> OwnerResult<(u64, u64)> {
    Err(NativeOwnerError::Unavailable)
}

/// Query the actual main-file handle, not pragma's path. Explicit unix-posix
/// at open is required: unix-none/dotlock can have no pInode and return zero.
/// No raw pointer, file-layout cast or native fd extraction escapes.
#[cfg(target_os = "macos")]
fn check_handle(conn: &Connection) -> OwnerResult<()> {
    let mut moved: std::ffi::c_int = -1;
    // SAFETY: conn is live and exclusively owned/borrowed by RuntimeOwner. The
    // call does not close/reconfigure it. main is static NUL-terminated storage;
    // moved is a writable c_int for this supported file-control opcode.
    let rc = unsafe {
        rusqlite::ffi::sqlite3_file_control(
            conn.handle(),
            c"main".as_ptr(),
            rusqlite::ffi::SQLITE_FCNTL_HAS_MOVED,
            (&mut moved as *mut std::ffi::c_int).cast(),
        )
    };
    if rc != rusqlite::ffi::SQLITE_OK || moved != 0 {
        return Err(NativeOwnerError::Unavailable);
    }
    Ok(())
}
struct RuntimeOwner {
    runtime_seal: Arc<()>,
    action_cancellations: std::sync::Weak<native_actions::cancellation::CancellationBook>,
    conn: Connection,
    data_dir: PathBuf,
    identity: (u64, u64),
    directory_identity: (u64, u64),
    retired: bool,
    credential_cancellations: std::sync::Weak<credential_cancel::CancellationBook>,
}
// Borrow-only view created by the retained owner for one protected snapshot.
// Neither callers nor wire values can obtain the connection or change pragmas.
pub(super) struct RetainedRead<'a> {
    conn: &'a Connection,
}
impl RetainedRead<'_> {
    fn statement(&self, sql: &str) -> rusqlite::Result<rusqlite::Statement<'_>> {
        let sql = sql.trim_start();
        if !sql
            .get(..6)
            .is_some_and(|s| s.eq_ignore_ascii_case("SELECT"))
            || !sql.as_bytes().get(6).is_some_and(u8::is_ascii_whitespace)
        {
            return Err(rusqlite::Error::InvalidQuery);
        }
        let statement = self.conn.prepare(sql)?;
        if !statement.readonly() {
            return Err(rusqlite::Error::InvalidQuery);
        }
        Ok(statement)
    }
    pub(super) fn query<T>(
        &self,
        sql: &str,
        values: &[&str],
        f: impl FnOnce(&rusqlite::Row<'_>) -> rusqlite::Result<T>,
    ) -> rusqlite::Result<T> {
        let mut statement = self.statement(sql)?;
        statement.query_row(rusqlite::params_from_iter(values), f)
    }
    pub(super) fn query_all<T>(
        &self,
        sql: &str,
        values: &[&str],
        f: impl FnMut(&rusqlite::Row<'_>) -> rusqlite::Result<T>,
    ) -> rusqlite::Result<Vec<T>> {
        let mut statement = self.statement(sql)?;
        let rows = statement.query_map(rusqlite::params_from_iter(values), f)?;
        rows.collect()
    }
}
impl RuntimeOwner {
    #[cfg(target_os = "macos")]
    fn open_existing(data_dir: &Path) -> OwnerResult<Self> {
        let directory_identity = private_directory(data_dir)?;
        let path = crate::runtime::runtime_db_path(data_dir);
        let identity = private_path(&path, false)?;
        #[cfg(test)]
        tests::constructor_before_open();
        // No CREATE, URI, symlink, migration, exclusive VFS or fallback.
        // NOFOLLOW applies at the actual SQLite open, including a substitution
        // after private_path checked the name. unix-posix uses ordinary POSIX
        // locks, including with existing runtime connections.
        let conn = Connection::open_with_flags_and_vfs(
            &path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE
                | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX
                | rusqlite::OpenFlags::SQLITE_OPEN_NOFOLLOW,
            "unix-posix",
        )
        .map_err(unavailable)?;
        #[cfg(test)]
        tests::constructor_after_open();
        conn.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(unavailable)?;
        conn.pragma_update(None, "foreign_keys", true)
            .map_err(unavailable)?;
        let _: i64 = conn
            .query_row("SELECT count(*) FROM sqlite_schema", [], |r| r.get(0))
            .map_err(unavailable)?;
        // SQLite's retained unix-posix handle pins its own original inode.
        // Capture the name before open and check both after open: if the name
        // swaps to a replacement and back, HAS_MOVED detects the wrong handle.
        // A separate raw File is unnecessary and closing it could drop POSIX
        // locks belonging to any other SQLite connection in this process.
        let mut owner = Self {
            runtime_seal: Arc::new(()),
            action_cancellations: std::sync::Weak::new(),
            conn,
            data_dir: data_dir.to_owned(),
            identity,
            directory_identity,
            retired: false,
            credential_cancellations: std::sync::Weak::new(),
        };
        owner.validate()?;
        Ok(owner)
    }
    #[cfg(not(target_os = "macos"))]
    fn open_existing(_: &Path) -> OwnerResult<Self> {
        Err(NativeOwnerError::Unavailable)
    }
    #[cfg(target_os = "macos")]
    fn validate_inner(&self) -> OwnerResult<()> {
        if self.retired
            || private_directory(&self.data_dir)? != self.directory_identity
            || private_path(&crate::runtime::runtime_db_path(&self.data_dir), false)?
                != self.identity
        {
            return Err(NativeOwnerError::Unavailable);
        }
        check_handle(&self.conn)?;
        let version: i64 = self
            .conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .map_err(unavailable)?;
        let foreign_keys: i64 = self
            .conn
            .query_row("PRAGMA foreign_keys", [], |r| r.get(0))
            .map_err(unavailable)?;
        let mode: String = self
            .conn
            .query_row("PRAGMA journal_mode", [], |r| r.get(0))
            .map_err(unavailable)?;
        if version != crate::runtime::USER_VERSION || foreign_keys != 1 || mode != "wal" {
            return Err(NativeOwnerError::Unavailable);
        }
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    fn validate_inner(&self) -> OwnerResult<()> {
        Err(NativeOwnerError::Unavailable)
    }
    fn validate(&mut self) -> OwnerResult<()> {
        let result = self.validate_inner();
        if result.is_err() {
            retire_credential_owner(
                &mut self.retired,
                &self.credential_cancellations,
                &self.action_cancellations,
            );
        }
        result
    }
    fn classified_transaction<T>(
        &mut self,
        operation: impl FnOnce(&Connection) -> OwnerResult<T>,
    ) -> RuntimeTransactionOutcome<T> {
        use RuntimeTransactionOutcome as Outcome;
        if let Err(error) = self.validate() {
            return Outcome::NotCommitted(error);
        }
        let tx = match Transaction::new_unchecked(&self.conn, TransactionBehavior::Immediate) {
            Ok(tx) => tx,
            Err(_) => return Outcome::NotCommitted(NativeOwnerError::Unavailable),
        };
        let result = operation(&tx);
        // A helper unexpectedly ending its transaction cannot be interpreted as
        // a safe rollback. Only this owner may cross the commit boundary.
        if tx.is_autocommit() {
            retire_credential_owner(
                &mut self.retired,
                &self.credential_cancellations,
                &self.action_cancellations,
            );
            return Outcome::CommitUncertain;
        }
        if self.validate_inner().is_err() {
            retire_credential_owner(
                &mut self.retired,
                &self.credential_cancellations,
                &self.action_cancellations,
            );
            return Outcome::NotCommitted(NativeOwnerError::Unavailable);
        }
        let value = match result {
            Ok(value) => value,
            Err(error) => return Outcome::NotCommitted(error),
        };
        if tx.commit().is_err() {
            retire_credential_owner(
                &mut self.retired,
                &self.credential_cancellations,
                &self.action_cancellations,
            );
            return Outcome::CommitUncertain;
        }
        #[cfg(test)]
        if tests::transaction_ack_lost() {
            retire_credential_owner(
                &mut self.retired,
                &self.credential_cancellations,
                &self.action_cancellations,
            );
            return Outcome::CommitUncertain;
        }
        Outcome::Committed(value)
    }
    fn transaction<T>(
        &mut self,
        operation: impl FnOnce(&Connection) -> OwnerResult<T>,
    ) -> OwnerResult<T> {
        match self.classified_transaction(operation) {
            RuntimeTransactionOutcome::Committed(value) => Ok(value),
            RuntimeTransactionOutcome::NotCommitted(error) => Err(error),
            RuntimeTransactionOutcome::CommitUncertain => Err(NativeOwnerError::Unavailable),
        }
    }
    fn read_snapshot<T>(
        &mut self,
        operation: impl FnOnce(&RetainedRead<'_>) -> OwnerResult<T>,
    ) -> OwnerResult<T> {
        self.validate()?;
        let previous: i64 = self
            .conn
            .query_row("PRAGMA query_only", [], |r| r.get(0))
            .map_err(unavailable)?;
        if self.conn.pragma_update(None, "query_only", true).is_err() {
            retire_credential_owner(
                &mut self.retired,
                &self.credential_cancellations,
                &self.action_cancellations,
            );
            return Err(NativeOwnerError::Unavailable);
        }
        // Unwind restores query_only too; an un-restorable owner is retired.
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let tx = Transaction::new_unchecked(&self.conn, TransactionBehavior::Deferred)
                .map_err(unavailable)?;
            let value = operation(&RetainedRead { conn: &tx });
            self.validate_inner()?;
            tx.rollback().map_err(unavailable)?;
            value
        }));
        if self
            .conn
            .pragma_update(None, "query_only", previous)
            .is_err()
            || self.validate_inner().is_err()
        {
            retire_credential_owner(
                &mut self.retired,
                &self.credential_cancellations,
                &self.action_cancellations,
            );
            return Err(NativeOwnerError::Unavailable);
        }
        match result {
            Ok(value) => value,
            Err(panic) => std::panic::resume_unwind(panic),
        }
    }
    // Low-level same-transaction row registration, never authentication. The
    // actual outer caller owns native/opening/original-entry/liveness guards.
    fn record_root_rows(
        conn: &Connection,
        root: &Path,
        scope: &crate::runtime::VaultScope,
        receipt: &crate::agent::NativePublicationReceipt,
        authority_id: &str,
    ) -> OwnerResult<()> {
        if conn.is_autocommit() {
            return Err(NativeOwnerError::Unavailable);
        }
        Self::verify_open_session(conn, root, scope)?;
        let session = receipt
            .cli_session_id()
            .ok_or(NativeOwnerError::Unavailable)?;
        let store = scope
            .store_uuid
            .as_deref()
            .ok_or(NativeOwnerError::Unavailable)?;
        // Exactly one existing attended root row, including actual scope.
        // The legacy best-effort session writer's zero-row Ok is not proof.
        let changed = conn.execute(
                "UPDATE runs SET cli_session_id=?2 WHERE run_id=?1 AND mode='attended' AND vault_id=?3 AND store_uuid=?4 AND parent_run_id IS NULL AND outcome='running' AND ended_at IS NULL AND (cli_session_id IS NULL OR cli_session_id=?2)",
                rusqlite::params![receipt.run_id(), session, scope.vault_id, store],
            ).map_err(unavailable)?;
        if changed != 1 {
            return Err(NativeOwnerError::Unavailable);
        }
        let rules = super::native_rules::admission_rules();
        let binding = super::native_lineage::NativeBinding {
            run_id: receipt.run_id(),
            vault_id: &scope.vault_id,
            store_uuid: store,
            canonical_vault: root,
            owner_person: &rules.owner_storage_key,
            actor_id: receipt.actor_id(),
            source_kind: "run",
            app_session_id: crate::runtime::sessions::session_id(),
            cli_session_id: Some(session),
            parent_run_id: None,
            client_id: None,
            child_job_id: None,
        };
        let native_existed: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM action_native_runs WHERE run_id=?1)",
                [receipt.run_id()],
                |row| row.get(0),
            )
            .map_err(unavailable)?;
        super::native_lineage::insert_if_absent(
            conn,
            &binding,
            authority_id,
            &crate::runtime::now_utc(),
        )
        .map_err(unavailable)?;
        let joined = super::native_lineage::resolve_lineage(
            super::native_db::AuthorityDb::Writer(conn),
            &binding,
            false,
        )
        .map_err(unavailable)?;
        if !joined.can_call || joined.row.authority_id.as_str() != authority_id {
            return Err(NativeOwnerError::Unavailable);
        }
        // M95: metadata for this original native root, in the SAME retained
        // transaction as its provenance. No caller supplies the attempt ID.
        // Query by run first: a corrupt run/authority pair must refuse rather
        // than look absent and be repaired or acquire a replacement identity.
        let previous: Option<(String, String)> = conn
            .query_row(
                "SELECT attempt_id,authority_id FROM chat_parent_attempts WHERE parent_run_id=?1",
                [receipt.run_id()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(unavailable)?;
        if let Some((attempt, recorded_authority)) = previous {
            if recorded_authority != joined.row.authority_id
                || attempt.len() != 32
                || !attempt
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            {
                return Err(NativeOwnerError::Unavailable);
            }
        } else {
            // An older native row or a lost/tampered identity cannot be
            // backfilled during replay. Only this transaction's new root mints.
            if native_existed {
                return Err(NativeOwnerError::Unavailable);
            }
            let attempt = crate::ledger::new_id128();
            conn.execute(
                "INSERT INTO chat_parent_attempts(parent_run_id,attempt_id,authority_id) VALUES(?1,?2,?3)",
                rusqlite::params![receipt.run_id(), attempt, joined.row.authority_id],
            )
            .map_err(unavailable)?;
        }
        // The enclosing finalizer publishes its retained origin only after a
        // definite commit and its existing original-entry/current-slot checks.
        // This row alone grants no capability and enables no supervised job.
        Ok(())
    }
    fn check_open_session(
        &mut self,
        root: &Path,
        scope: &crate::runtime::VaultScope,
    ) -> OwnerResult<()> {
        self.transaction(|tx| Self::verify_open_session(tx, root, scope))
    }
    fn verify_open_session(
        conn: &Connection,
        root: &Path,
        scope: &crate::runtime::VaultScope,
    ) -> OwnerResult<()> {
        let root = root.canonicalize().map_err(unavailable)?;
        let path = root.to_str().ok_or(NativeOwnerError::Unavailable)?;
        let store = scope
            .store_uuid
            .as_deref()
            .filter(|v| !v.is_empty())
            .ok_or(NativeOwnerError::Unavailable)?;
        if crate::runtime::scope::derive_vault_id(&root) != scope.vault_id {
            return Err(NativeOwnerError::Unavailable);
        }
        let found: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM app_sessions s JOIN vault_registry v ON v.vault_id=s.vault_id WHERE s.session_id=?1 AND s.vault_id=?2 AND s.store_uuid=?3 AND s.close_precision='open' AND v.vault_path=?4)",
            rusqlite::params![crate::runtime::sessions::session_id(), scope.vault_id, store, path], |r| r.get(0)
        ).map_err(unavailable)?;
        if !found {
            return Err(NativeOwnerError::Unavailable);
        }
        Ok(())
    }
}
#[cfg(test)]
#[path = "native_owner_tests.rs"]
pub(crate) mod tests;

// Test-stage storage adapter only. No command or native caller factory is added.
// The future authenticated desktop producer must retain its real owner before
// invoking this boundary; fixture callers prove SQLite ownership, not a gesture.
#[cfg(test)]
impl RuntimeOwner {
    fn account_metadata(
        &mut self,
        operation: crate::connections::account_metadata::MetadataOperation<'_>,
    ) -> Result<
        crate::connections::account_metadata::MetadataOutcome,
        crate::connections::ConnectionError,
    > {
        use crate::connections::{account_metadata, ConnectionError};
        let mut domain_error = None;
        let value = self.transaction(|tx| {
            account_metadata::apply(
                tx,
                &super::native_rules::admission_rules().owner_storage_key,
                operation,
            )
            .map_err(|error| {
                domain_error = Some(error);
                NativeOwnerError::Unavailable
            })
        });
        value.map_err(|_| {
            if self.retired {
                ConnectionError::Unavailable
            } else {
                domain_error.unwrap_or(ConnectionError::Unavailable)
            }
        })
    }
}
#[cfg(all(test, target_os = "macos"))]
#[path = "native_account_tests.rs"]
mod native_account_tests;

// Safe metadata and Unavailable worker serve the real authenticated command doors.
// Secret-bearing import and the fixed no-secret fixture remain gated below.
#[path = "native_account_acquisition.rs"]
mod native_account_acquisition;
#[path = "native_account_commands.rs"]
mod native_account_commands;
#[cfg(feature = "native-credential-smoke")]
pub(crate) use native_account_commands::credential_begin;
#[cfg(all(feature = "native-credential-smoke", target_os = "macos"))]
pub(crate) use native_account_commands::credential_begin_import_fixture;
pub(crate) use native_account_commands::{
    credential_begin_owned, credential_cancel, credential_poll,
};
#[cfg(target_os = "macos")]
#[path = "native_account_import.rs"]
mod native_account_import;
#[cfg(all(test, target_os = "macos"))]
#[path = "native_account_import_tests.rs"]
mod native_account_import_tests;
#[cfg(all(any(test, feature = "native-credential-smoke"), target_os = "macos"))]
#[path = "native_account_worker_fixture.rs"]
mod native_account_worker_fixture;

// Fixed-purpose Settings doors authenticate the injected native window first.
#[path = "native_account_lifecycle.rs"]
mod native_account_lifecycle;
pub(crate) use native_account_lifecycle::{managed_add, managed_disable, managed_list};

// Fixed M95 native origin consumer; normal production has no caller or door.
#[cfg(feature = "native-read-smoke")]
#[path = "native_delegation_origin.rs"]
mod native_delegation_origin;
#[cfg(feature = "native-read-smoke")]
pub(crate) use native_delegation_origin::{
    arm_child_claim_phase_c_probe, attempt_frozen_child_start, child_backend_consumptions,
    claim_native_child_run, consume_native_child_backend, freeze_native_child,
    prepare_native_delegation, reserve_native_delegation, ClaimRefusal, FreezeRefusal,
    FrozenNativeChild, NativeChildMode, NativeDelegationCaller, NativeDelegationRequest,
    OwnedChildRun,
};

#[path = "native_chat_recovery.rs"]
pub(super) mod native_chat_recovery;
pub(crate) use native_chat_recovery::inspect as chat_recovery_inspect;

#[path = "native_chat_generation.rs"]
mod native_chat_generation;
pub(crate) use native_chat_generation::{
    GenerationStart, NativeGenerationRun, NativeGenerationSettlement,
};

#[path = "native_credential_cancel.rs"]
mod credential_cancel;

fn retire_credential_owner(
    retired: &mut bool,
    book: &std::sync::Weak<credential_cancel::CancellationBook>,
    actions: &std::sync::Weak<native_actions::cancellation::CancellationBook>,
) {
    *retired = true;
    if let Some(book) = book.upgrade() {
        book.cancel_all();
    }
    if let Some(book) = actions.upgrade() {
        book.cancel_all();
    }
}

#[cfg(target_os = "macos")]
#[path = "native_credential_bundle.rs"]
mod native_credential_bundle;

#[path = "native_actions.rs"]
mod native_actions;

impl NativeActionReadOrigin {
    /// Stop/opening invalidation notification only: no storage, I/O or joins.
    pub(crate) fn cancel_action_workers(&self) {
        self.owner
            .action_cancellations
            .cancel_run(self.receipt.run_id());
    }
}

/// Explicit app-level Stop-all also reaches owned actions after their CLI slot ended.
/// This control notification does not retire the book or mint any action authority.
pub(crate) fn stop_action_workers(app: &AppHandle) {
    native_workflows::worker::stop(app);
    if let Some(owner) = app.try_state::<Arc<NativeOwnerState>>() {
        owner.action_cancellations.stop_all();
    }
}

#[path = "native_workflow_rows.rs"]
mod workflow_rows;

#[path = "native_workflows.rs"]
mod native_workflows;

pub(crate) use native_actions::operations::grants::{
    RunActionAccessView, SetRunActionAccess, SetRunActionAccessResult,
};
pub(crate) fn read_managed_action_access(
    app: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
    run: u64,
) -> Result<RunActionAccessView, crate::actions::effect_types::ActionError> {
    native_actions::operations::grants::read(app, window, run)
}
pub(crate) fn set_managed_action_access(
    app: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
    run: u64,
    request: SetRunActionAccess,
) -> SetRunActionAccessResult {
    native_actions::operations::grants::set(app, window, run, request)
}

/// Process-owned workflow worker joins after actual provider cleanup on exit.
pub(crate) fn shutdown_workflow_workers(app: &AppHandle) {
    native_workflows::worker::shutdown(app);
}

pub(crate) use native_workflows::commands::{
    workflow_actions, workflow_catalog, workflow_context, workflow_document, workflow_publish,
    workflow_save, workflow_unpublish, workflow_validate, workflow_version,
};

/// Existing compiled metadata bounds only; no origin, grant or execution proof.
pub(crate) fn managed_call_limits() -> (usize, std::time::Duration) {
    (
        super::schema::history_limits().max_id_bytes,
        super::effect_kernel::approval_lifetime()
            .to_std()
            .unwrap_or_default(),
    )
}

/// Private matched-call route only; no renderer/grant view can construct caller.
pub(crate) fn managed_action_tool(
    app: &tauri::AppHandle,
    caller: &crate::mcp::NativeManagedCall,
    name: &str,
    args: &serde_json::Map<String, serde_json::Value>,
) -> Result<serde_json::Value, super::read_types::ActionError> {
    native_actions::operations::managed_call::invoke(app, caller, name, args)
}
/// Returns None only for an ordinary legacy card. A managed acknowledgement
/// contains no run handle and only follows its actual original worker commit.
pub(crate) fn answer_held_managed_interaction(
    app: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
    vault: &std::path::Path,
    id: &str,
    answer: &crate::agent::interaction::PersonAnswer,
    edited: Option<&serde_json::Value>,
) -> Option<Result<(), crate::agent::interaction::Refusal>> {
    native_actions::operations::managed_call::person_answer(app, window, vault, id, answer, edited)
}

// Actual authenticated workflow command facade; DTOs are selectors only.
pub(crate) use native_workflows::runtime_commands::{
    workflow_action_details, workflow_answer_action, workflow_answer_wait, workflow_cancel,
    workflow_continue, workflow_reauthorize, workflow_run, workflow_runs, workflow_start,
    workflow_value,
};

pub(crate) use native_workflows::runtime_commands::workflow_access;

#[cfg(feature = "native-action-smoke")]
pub(crate) use native_actions::operations::smoke::{
    entries as native_action_smoke_entries, input as native_action_smoke_input,
    output_digest as native_action_smoke_output_digest, seed as seed_native_action_smoke,
    Fixture as NativeActionSmokeFixture,
};

// Awake schedule doors capture the injected native opening themselves.
pub(crate) use native_workflows::schedule_commands::{
    workflow_schedule, workflow_schedule_enable, workflow_schedule_pause,
    workflow_schedule_preview, workflow_schedule_remove,
};
pub(crate) use native_workflows::worker::monitor::{
    opened as workflow_schedule_opened, workflow_schedule_wake,
};

#[path = "native_conversations.rs"]
mod native_conversations;
pub(crate) use native_conversations::{
    context as conversation_context, delete as conversation_delete, export as conversation_export,
    import as conversation_import, list as conversation_list, messages as conversation_messages,
    prune as conversation_prune, set_retention as conversation_set_retention,
    setting as conversation_retention,
};
