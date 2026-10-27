//! Actual main-window producer. No authority comes from labels/renderer paths.
use super::*;
use crate::workspace_service::{authority, backup_types::*};
use std::{
    fs::OpenOptions,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
const WORKSPACE_BACKUP_EVENT: &str = "workspace-backup-changed";
struct NativeApp {
    context: Arc<authority::AuthorityContext>,
    slot: Arc<AppSlot>,
    origin: Arc<OriginPin>,
    current: Mutex<Option<Arc<Registration>>>,
}
pub(crate) struct WindowLifecycle(std::sync::Weak<Registration>);
impl WindowLifecycle {
    pub(crate) fn retire(&self) {
        if let Some(original) = self.0.upgrade() {
            original.retire();
        }
    }
}
pub(crate) fn initialize(app: &AppHandle) -> Result<(), Refusal> {
    if app.try_state::<Arc<NativeApp>>().is_some() {
        return Err(Refusal::Unavailable);
    }
    let context = Arc::new(authority::context().map_err(|_| Refusal::Unavailable)?);
    let path = crate::config_dir(app)
        .map_err(|_| Refusal::Unavailable)?
        .canonicalize()
        .map_err(|_| Refusal::Unavailable)?;
    if context
        .origin
        .canonicalize()
        .map_err(|_| Refusal::Unavailable)?
        != path
    {
        return Err(Refusal::Unavailable);
    }
    let directory = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(&path)
        .map_err(|_| Refusal::Unavailable)?;
    let metadata = directory.metadata().map_err(|_| Refusal::Unavailable)?;
    if !metadata.is_dir()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o022 != 0
    {
        return Err(Refusal::Unavailable);
    }
    let origin = Arc::new(OriginPin {
        directory,
        path,
        device: metadata.dev(),
        inode: metadata.ino(),
    });
    origin.validate()?;
    app.manage(Arc::new(NativeApp {
        context,
        slot: AppSlot::new(),
        origin,
        current: Mutex::new(None),
    }))
    .then_some(())
    .ok_or(Refusal::Unavailable)
}
fn state(app: &AppHandle) -> Result<Arc<NativeApp>, Refusal> {
    app.try_state::<Arc<NativeApp>>()
        .map(|state| state.inner().clone())
        .ok_or(Refusal::Unavailable)
}
fn identity(window: &WebviewWindow) -> Result<WindowIdentity, Refusal> {
    let _main = objc2::MainThreadMarker::new().ok_or(Refusal::Unavailable)?;
    let identity = WindowIdentity {
        window: window.ns_window().map_err(|_| Refusal::Unavailable)? as usize,
        view: window.ns_view().map_err(|_| Refusal::Unavailable)? as usize,
        label: window.label().into(),
    };
    if identity.window == 0 || identity.view == 0 || identity.label != crate::shell::MAIN_WINDOW {
        return Err(Refusal::WrongWindow);
    }
    Ok(identity)
}
pub(crate) fn register(
    app: &AppHandle,
    window: &WebviewWindow,
) -> Result<WindowLifecycle, Refusal> {
    let state = state(app)?;
    state.origin.validate()?;
    let observed = identity(window)?;
    let current = app
        .get_webview_window(crate::shell::MAIN_WINDOW)
        .ok_or(Refusal::WrongWindow)?;
    if identity(&current)? != observed {
        return Err(Refusal::WrongWindow);
    }
    let original = state
        .current
        .lock()
        .map_err(|_| Refusal::Unavailable)?
        .clone();
    if let Some(old) = original.as_ref() {
        if old.identity == observed && old.live.load(Ordering::SeqCst) {
            return Err(Refusal::Unavailable);
        }
        old.retire();
    }
    let registration = Arc::new(Registration {
        app: state.slot.clone(),
        identity: observed,
        origin: state.origin.path.clone(),
        origin_pin: Some(state.origin.clone()),
        live: AtomicBool::new(true),
        book: Mutex::new(Book::Idle),
    });
    let mut current = state.current.lock().map_err(|_| Refusal::Unavailable)?;
    if !match (&*current, &original) {
        (None, None) => true,
        (Some(now), Some(old)) => Arc::ptr_eq(now, old),
        _ => false,
    } {
        return Err(Refusal::Unavailable);
    }
    *current = Some(registration.clone());
    Ok(WindowLifecycle(Arc::downgrade(&registration)))
}
fn observe(
    app: &AppHandle,
    window: &WebviewWindow,
    registration: Arc<Registration>,
) -> Result<WindowObservation, Refusal> {
    let owner = state(app)?;
    let injected = state(window.app_handle())?;
    if !Arc::ptr_eq(&owner, &injected)
        || !owner
            .current
            .lock()
            .map_err(|_| Refusal::Unavailable)?
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, &registration))
    {
        return Err(Refusal::WrongWindow);
    }
    owner.origin.validate()?;
    let read = |app: &AppHandle,
                window: &WebviewWindow|
     -> Result<(WindowIdentity, WindowIdentity, bool), Refusal> {
        let current = app
            .get_webview_window(crate::shell::MAIN_WINDOW)
            .ok_or(Refusal::WrongWindow)?;
        let entry = window.url().map_err(|_| Refusal::Unavailable)?;
        let dev_root = if tauri::is_dev() {
            app.config().build.dev_url.as_ref()
        } else {
            None
        };
        Ok((
            identity(window)?,
            identity(&current)?,
            crate::shell::links::classify(&entry, dev_root)
                == crate::shell::links::LinkVerdict::Allow,
        ))
    };
    let (injected, current, allowed_entry) = if objc2::MainThreadMarker::new().is_some() {
        read(app, window)?
    } else {
        let (send, receive) = std::sync::mpsc::sync_channel(1);
        let app = app.clone();
        let window = window.clone();
        let scheduler = app.clone();
        scheduler
            .run_on_main_thread(move || {
                let result = read(&app, &window);
                let _ = send.try_send(result);
            })
            .map_err(|_| Refusal::Unavailable)?;
        receive
            .recv_timeout(Duration::from_secs(2))
            .map_err(|_| Refusal::Unavailable)??
    };
    Ok(WindowObservation {
        registration,
        injected,
        current,
        origin: owner.origin.path.clone(),
        allowed_entry,
    })
}
fn entry(
    app: &AppHandle,
    window: &WebviewWindow,
) -> Result<(Arc<NativeApp>, WindowProof), Refusal> {
    let state = state(app)?;
    let registration = state
        .current
        .lock()
        .map_err(|_| Refusal::Unavailable)?
        .clone()
        .ok_or(Refusal::Unavailable)?;
    let proof = authenticate(&registration, observe(app, window, registration.clone())?)?;
    Ok((state, proof))
}
fn changed(app: &AppHandle) {
    let _ = app.emit(WORKSPACE_BACKUP_EVENT, ());
}
fn mode(mode: Mode) -> WorkspaceBackupMode {
    match mode {
        Mode::Create => WorkspaceBackupMode::Create,
        Mode::Check => WorkspaceBackupMode::Check,
        Mode::Restore => WorkspaceBackupMode::Restore,
    }
}
fn summary(
    value: &crate::workspace_migration::backup::CheckedBackupSummary,
) -> Option<WorkspaceBackupSummary> {
    Some(WorkspaceBackupSummary {
        workspace_id: value.workspace_id.clone(),
        portable_version: value.format,
        schema_version: u32::try_from(value.schema_version).ok()?,
        part_count: u32::try_from(value.part_count).ok()?,
        total_bytes: value.total_bytes.clone(),
        omissions: crate::workspace_migration::backup::omissions(),
    })
}
fn location(value: &authority::OutputObservation) -> WorkspaceBackupLocation {
    WorkspaceBackupLocation {
        display_location: label(&value.display_location),
        verification: match value.location {
            authority::OutputLocation::Verified => WorkspaceBackupLocationVerification::Verified,
            authority::OutputLocation::OriginalSpellingOnly => {
                WorkspaceBackupLocationVerification::OriginalSpellingOnly
            }
            authority::OutputLocation::Unavailable => {
                WorkspaceBackupLocationVerification::Unavailable
            }
        },
    }
}
fn no_output() -> WorkspaceBackupDisposition {
    WorkspaceBackupDisposition::NoneCreated
}
fn control(error: Refusal) -> WorkspaceBackupRefusal {
    use WorkspaceBackupRefusalKind as K;
    let (kind, message) = match error {
        Refusal::Busy => (K::Busy, "Another backup action is still open or finishing."),
        Refusal::InvalidChoice => (
            K::InvalidChoice,
            "This choice is no longer available. Choose again.",
        ),
        Refusal::ExpiredChoice => (K::ExpiredChoice, "This choice expired. Choose again."),
        Refusal::WrongWindow => (
            K::WrongWindow,
            "This choice belongs to a different or closed window.",
        ),
        Refusal::WrongMode => (
            K::WrongMode,
            "This choice is for a different backup action.",
        ),
        Refusal::UnknownOutcome => (
            K::UnknownOutcome,
            "The outcome is unavailable. Check the saved backup before trying again.",
        ),
        Refusal::Unavailable => (K::Unavailable, "Backup service is unavailable."),
        Refusal::UnsupportedPlatform => (
            K::UnsupportedPlatform,
            "Native backups are unavailable on this platform.",
        ),
    };
    WorkspaceBackupRefusal {
        kind,
        message: message.into(),
        authority: None,
        backup: None,
        output: no_output(),
    }
}
fn cause(error: &KernelFailure, output: WorkspaceBackupDisposition) -> WorkspaceBackupRefusal {
    use crate::workspace_migration::backup::BackupErrorKind as B;
    use crate::workspace_service::types::selected::AuthorityErrorKind as A;
    use WorkspaceBackupRefusalKind as K;
    let mut refusal = match error {
        KernelFailure::Control(error) => control(*error),
        KernelFailure::Authority(error) => WorkspaceBackupRefusal {
            kind: match error.kind {
                A::Busy => K::OutputOverlap,
                A::SourceChanged | A::WrongIdentity => K::StaleOpening,
                A::UnsupportedOperation => K::UnsupportedCurrentVault,
                A::RecoveryRequired | A::RecoveryConflict => K::RecoveryRequired,
                _ => K::Unavailable,
            },
            message: error.message.clone(),
            authority: Some(error.clone()),
            backup: None,
            output: no_output(),
        },
        KernelFailure::Backup(error) => WorkspaceBackupRefusal {
            kind: match error.kind {
                B::SourceChanged => K::ChangedChoice,
                B::DestinationUnavailable => K::DestinationUnavailable,
                B::Busy => K::Busy,
                B::UnsupportedPlatform => K::UnsupportedPlatform,
                B::RecoveryRequired => K::RecoveryRequired,
                _ => K::InvalidBackup,
            },
            message: error.message.clone(),
            authority: None,
            backup: Some(WorkspaceBackupErrorView {
                code: error.code.into(),
                kind: error.kind,
                message: error.message.clone(),
            }),
            output: no_output(),
        },
    };
    refusal.output = output;
    refusal
}
fn disposition(terminal: &CopyTerminal) -> WorkspaceBackupDisposition {
    match &terminal.disposition {
        CopyDisposition::NoneCreated => no_output(),
        CopyDisposition::CreationUncertain(value) => {
            WorkspaceBackupDisposition::CreationUncertain {
                location: location(value),
            }
        }
        CopyDisposition::Incomplete(value) => WorkspaceBackupDisposition::Incomplete {
            location: location(value),
        },
        CopyDisposition::CompletionUnknown(value) => {
            WorkspaceBackupDisposition::CompletionUnknown {
                location: value.as_ref().map(location),
            }
        }
        CopyDisposition::Completed(value) => {
            if terminal.response_available && terminal.summary.as_ref().and_then(summary).is_some()
            {
                WorkspaceBackupDisposition::Completed {
                    location: location(value),
                }
            } else {
                WorkspaceBackupDisposition::CompletedButResponseUnavailable {
                    location: location(value),
                }
            }
        }
    }
}
fn terminal(value: &Terminal) -> WorkspaceBackupTerminal {
    match value {
        Terminal::Copy(value) => {
            let output = disposition(value);
            if matches!(&value.disposition, CopyDisposition::Completed(_)) {
                WorkspaceBackupTerminal::Completed {
                    workspace_id: value.workspace_id.clone(),
                    summary: value.summary.as_ref().and_then(summary),
                    output,
                }
            } else {
                let mut refusal = value
                    .failure
                    .as_ref()
                    .map(|error| cause(error, output.clone()))
                    .unwrap_or_else(|| control(Refusal::UnknownOutcome));
                refusal.output = output;
                if matches!(&value.disposition, CopyDisposition::CompletionUnknown(_)) {
                    refusal.kind = WorkspaceBackupRefusalKind::UnknownOutcome;
                }
                WorkspaceBackupTerminal::Refused { refusal }
            }
        }
        Terminal::ChoiceRefused(failure) => WorkspaceBackupTerminal::Refused {
            refusal: cause(failure, no_output()),
        },
        Terminal::Refused {
            reason,
            none_created,
        } => {
            let mut refusal = control(*reason);
            if !none_created {
                refusal.output = WorkspaceBackupDisposition::CompletionUnknown { location: None };
            }
            WorkspaceBackupTerminal::Refused { refusal }
        }
        #[cfg(test)]
        Terminal::Completed => WorkspaceBackupTerminal::Refused {
            refusal: control(Refusal::UnknownOutcome),
        },
    }
}
fn review(value: &Review) -> WorkspaceBackupReview {
    WorkspaceBackupReview {
        operation_id: value.operation.clone(),
        token: value.token.clone(),
        mode: mode(value.mode),
        expires_at: value.expires_at.clone(),
        labels: value.labels.clone(),
        summary: value.summary.as_ref().and_then(summary),
    }
}
fn operation(value: Status) -> WorkspaceBackupOperation {
    match value {
        Status::Idle => WorkspaceBackupOperation::None,
        Status::Choosing {
            operation,
            mode: value,
            labels,
        } => WorkspaceBackupOperation::Choosing {
            operation_id: operation,
            mode: mode(value),
            labels,
        },
        Status::Pending(value) => WorkspaceBackupOperation::Pending {
            review: review(&value),
        },
        Status::Running {
            operation,
            mode: value,
            labels,
        } => WorkspaceBackupOperation::Running {
            operation_id: operation,
            mode: mode(value),
            labels,
        },
        Status::Terminal {
            operation,
            mode: value,
            labels,
            outcome,
        } => WorkspaceBackupOperation::Terminal {
            operation_id: operation,
            mode: mode(value),
            labels,
            result: terminal(&outcome),
        },
    }
}
fn token(token: &str) -> bool {
    token.len() == 32
        && token
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
// The actual native callback owns the WHOLE original ChoosingWork. If its
// receiver disappears, the permit/input close only after that callback settles.
fn pick(
    app: &AppHandle,
    window: &WebviewWindow,
    work: ChoosingWork,
    title: &'static str,
) -> Result<(Result<Option<PathBuf>, Refusal>, ChoosingWork), Refusal> {
    use tauri_plugin_dialog::DialogExt as _;
    let (send, receive) = std::sync::mpsc::sync_channel(1);
    let app = app.clone();
    let window = window.clone();
    let scheduler = app.clone();
    scheduler
        .run_on_main_thread(move || {
            let checked = observe(&app, &window, work.registration.clone())
                .and_then(|observed| authenticate(&work.registration, observed));
            if let Err(error) = checked {
                let _ = send.try_send((Err(error), work));
                return;
            }
            app.dialog()
                .file()
                .set_parent(&window)
                .set_title(title)
                .set_can_create_directories(false)
                .pick_folder(move |picked| {
                    let result = picked
                        .map(|path| path.into_path().map_err(|_| Refusal::Unavailable))
                        .transpose();
                    let _ = send.try_send((result, work));
                });
        })
        .map_err(|_| Refusal::Unavailable)?;
    // No pending TTL/cancellation releases a still-open native chooser.
    receive.recv().map_err(|_| Refusal::Unavailable)
}
pub(crate) fn availability(
    app: &AppHandle,
    window: &WebviewWindow,
    selector: Option<&str>,
) -> WorkspaceBackupAvailability {
    let (state, _) = match entry(app, window) {
        Ok(value) => value,
        Err(error) => {
            return WorkspaceBackupAvailability::Unavailable {
                refusal: control(error),
                check_restore: false,
            }
        }
    };
    let Some(selector) = selector else {
        return WorkspaceBackupAvailability::UnsupportedCurrentVault { message: "Open a supported vault to create a backup. Existing backups can still be checked or restored.".into(), check_restore: true };
    };
    match state.context.capture_selected_backup_opening(Path::new(selector)) {
        Ok(source) => WorkspaceBackupAvailability::Available { source_label: label(source.root()), check_restore: true },
        Err(error) if error.kind == crate::workspace_service::types::selected::AuthorityErrorKind::UnsupportedOperation => WorkspaceBackupAvailability::UnsupportedCurrentVault { message: "Create backup is not available for this vault yet. You can check or restore an existing backup.".into(), check_restore: true },
        Err(error) => WorkspaceBackupAvailability::Unavailable { refusal: cause(&KernelFailure::Authority(error), no_output()), check_restore: true },
    }
}
fn choose(
    app: &AppHandle,
    window: &WebviewWindow,
    state: Arc<NativeApp>,
    work: ChoosingWork,
    desired: Mode,
) -> WorkspaceBackupChoiceResult {
    let title = match desired {
        Mode::Create => "Choose an existing folder for the backup",
        Mode::Check => "Choose a backup folder to check",
        Mode::Restore => "Choose an existing folder for the separate copy",
    };
    changed(app);
    let (picked, work) = match pick(app, window, work, title) {
        Ok(value) => value,
        Err(error) => {
            changed(app);
            return WorkspaceBackupChoiceResult::Refused {
                refusal: control(error),
            };
        }
    };
    let picked = match picked {
        Ok(value) => value,
        Err(error) => {
            drop(work);
            changed(app);
            return WorkspaceBackupChoiceResult::Refused {
                refusal: control(error),
            };
        }
    };
    let registration = work.registration.clone();
    let result = work.complete_bound(&state.context, Instant::now, || {
        let Some(path) = picked else {
            return Ok(None);
        };
        let chosen = if desired == Mode::Check {
            match crate::workspace_migration::backup::check_backup_input(&path) {
                Ok(input) => NativeChoice::Input(input),
                Err(error) => {
                    return Err(KernelFailure::Backup(error));
                }
            }
        } else {
            let names = &super::super::backup_policy::rules().destination_names;
            let prefix = if desired == Mode::Create {
                &names.backup_prefix
            } else {
                &names.restore_prefix
            };
            let leaf = format!("{prefix}{}", nonce()?);
            match crate::workspace_migration::backup::NewDirectoryChoice::new(&path, &leaf) {
                Ok(output) => NativeChoice::Output(output),
                Err(error) => {
                    return Err(KernelFailure::Backup(error));
                }
            }
        };
        Ok(Some(ChoiceCompletion {
            chosen,
            observation: observe(app, window, registration)?,
        }))
    });
    changed(app);
    match result {
        Ok(Some(value)) => WorkspaceBackupChoiceResult::Review {
            review: review(&value),
        },
        Ok(None) => WorkspaceBackupChoiceResult::Cancelled,
        Err(error) => WorkspaceBackupChoiceResult::Refused {
            refusal: cause(&error, no_output()),
        },
    }
}
pub(crate) fn choose_backup(
    app: &AppHandle,
    window: &WebviewWindow,
    selector: &str,
) -> WorkspaceBackupChoiceResult {
    let (state, proof) = match entry(app, window) {
        Ok(value) => value,
        Err(error) => {
            return WorkspaceBackupChoiceResult::Refused {
                refusal: control(error),
            }
        }
    };
    let source = match state
        .context
        .capture_selected_backup_opening(Path::new(selector))
    {
        Ok(value) => value,
        Err(error) => {
            return WorkspaceBackupChoiceResult::Refused {
                refusal: cause(&KernelFailure::Authority(error), no_output()),
            }
        }
    };
    match proof.begin_create(source) {
        Ok(work) => choose(app, window, state, work, Mode::Create),
        Err(error) => WorkspaceBackupChoiceResult::Refused {
            refusal: control(error),
        },
    }
}
pub(crate) fn check_backup(app: &AppHandle, window: &WebviewWindow) -> WorkspaceBackupChoiceResult {
    let (state, proof) = match entry(app, window) {
        Ok(value) => value,
        Err(error) => {
            return WorkspaceBackupChoiceResult::Refused {
                refusal: control(error),
            }
        }
    };
    match proof.begin_check() {
        Ok(work) => choose(app, window, state, work, Mode::Check),
        Err(error) => WorkspaceBackupChoiceResult::Refused {
            refusal: control(error),
        },
    }
}
pub(crate) fn choose_restore(
    app: &AppHandle,
    window: &WebviewWindow,
    value: &str,
) -> WorkspaceBackupChoiceResult {
    let (state, proof) = match entry(app, window) {
        Ok(value) => value,
        Err(error) => {
            return WorkspaceBackupChoiceResult::Refused {
                refusal: control(error),
            }
        }
    };
    if !token(value) {
        return WorkspaceBackupChoiceResult::Refused {
            refusal: control(Refusal::InvalidChoice),
        };
    }
    match proof.choose_restore(value, Instant::now()) {
        Ok(work) => choose(app, window, state, work, Mode::Restore),
        Err(error) => WorkspaceBackupChoiceResult::Refused {
            refusal: control(error),
        },
    }
}
fn commit(
    app: &AppHandle,
    window: &WebviewWindow,
    value: &str,
    desired: Mode,
) -> WorkspaceBackupCommitResult {
    let (state, proof) = match entry(app, window) {
        Ok(value) => value,
        Err(error) => {
            return WorkspaceBackupCommitResult::Refused {
                refusal: control(error),
            }
        }
    };
    if !token(value) {
        return WorkspaceBackupCommitResult::Refused {
            refusal: control(Refusal::InvalidChoice),
        };
    }
    let work = match proof.commit(value, desired, Instant::now()) {
        Ok(Commit::Started(work)) => work,
        Ok(Commit::AlreadyStarted(value)) => {
            return WorkspaceBackupCommitResult::AlreadyStarted {
                operation: operation(value),
            }
        }
        Err(error) => {
            return WorkspaceBackupCommitResult::Refused {
                refusal: control(error),
            }
        }
    };
    let operation_id = work.operation.clone();
    let labels = work.labels.clone();
    let registration = work.registration.clone();
    let original = operation_id.clone();
    let app = app.clone();
    let scheduled = std::thread::Builder::new()
        .name("cerebro-backup".into())
        .spawn(move || {
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                work.execute_copy(&state.context)
            }));
            if !registration.live.load(Ordering::SeqCst) {
                if let Ok(mut book) = registration.book.lock() {
                    if matches!(&*book, Book::Terminal { operation, .. } if operation == &original)
                    {
                        *book = Book::Idle;
                    }
                }
            }
            changed(&app);
        });
    match scheduled {
        Ok(handle) => {
            drop(handle);
            WorkspaceBackupCommitResult::Started {
                operation_id,
                mode: mode(desired),
                labels,
            }
        }
        Err(_) => WorkspaceBackupCommitResult::Refused {
            refusal: control(Refusal::Unavailable),
        },
    }
}
pub(crate) fn cancel(
    app: &AppHandle,
    window: &WebviewWindow,
    value: &str,
) -> WorkspaceBackupCancelResult {
    let (_, proof) = match entry(app, window) {
        Ok(value) => value,
        Err(error) => {
            return WorkspaceBackupCancelResult::Refused {
                refusal: control(error),
            }
        }
    };
    if !token(value) {
        return WorkspaceBackupCancelResult::Refused {
            refusal: control(Refusal::InvalidChoice),
        };
    }
    let result = match proof.cancel(value, Instant::now()) {
        Ok(Status::Idle) => WorkspaceBackupCancelResult::Cancelled,
        Ok(value) => WorkspaceBackupCancelResult::AlreadyStarted {
            operation: operation(value),
        },
        Err(error) => WorkspaceBackupCancelResult::Refused {
            refusal: control(error),
        },
    };
    changed(app);
    result
}
pub(crate) fn status(app: &AppHandle, window: &WebviewWindow) -> WorkspaceBackupOperation {
    match entry(app, window).and_then(|(_, proof)| proof.status(Instant::now())) {
        Ok(value) => operation(value),
        Err(error) => WorkspaceBackupOperation::Unavailable {
            refusal: control(error),
        },
    }
}

pub(crate) fn commit_backup(
    app: &AppHandle,
    window: &WebviewWindow,
    token: &str,
) -> WorkspaceBackupCommitResult {
    commit(app, window, token, Mode::Create)
}
pub(crate) fn commit_restore(
    app: &AppHandle,
    window: &WebviewWindow,
    token: &str,
) -> WorkspaceBackupCommitResult {
    commit(app, window, token, Mode::Restore)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_token_grammar_refuses_paths_uppercase_and_non_128_bit_values() {
        assert!(token("0123456789abcdef0123456789abcdef"));
        for value in [
            "",
            "../backup",
            "0123456789ABCDEF0123456789ABCDEF",
            "0123456789abcdef",
            "0123456789abcdef0123456789abcdef0",
        ] {
            assert!(!token(value));
        }
    }
    #[test]
    fn native_response_preserves_published_fact_when_summary_cannot_be_represented() {
        let output = authority::OutputObservation {
            display_location: PathBuf::from("/synthetic-output"),
            phase: crate::workspace_migration::backup::OutputPhase::Published,
            location: authority::OutputLocation::OriginalSpellingOnly,
        };
        let result = terminal(&Terminal::Copy(CopyTerminal {
            disposition: CopyDisposition::Completed(output),
            workspace_id: Some("synthetic-id".into()),
            summary: None,
            failure: None,
            response_available: false,
        }));
        assert!(matches!(
            result,
            WorkspaceBackupTerminal::Completed {
                summary: None,
                output: WorkspaceBackupDisposition::CompletedButResponseUnavailable { .. },
                ..
            }
        ));
    }
    #[test]
    fn native_choice_refusal_preserves_source_changed_cause_and_none_created() {
        let error = authority::error(
            crate::workspace_service::types::selected::AuthorityErrorKind::SourceChanged,
            "synthetic source replacement",
        );
        let value = terminal(&Terminal::ChoiceRefused(KernelFailure::Authority(
            error.clone(),
        )));
        assert!(
            matches!(value, WorkspaceBackupTerminal::Refused { refusal: WorkspaceBackupRefusal { kind: WorkspaceBackupRefusalKind::StaleOpening, authority: Some(actual), output: WorkspaceBackupDisposition::NoneCreated, .. } } if actual == error)
        );
    }
}
