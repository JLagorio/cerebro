//! Original-owner native backup workflow; finite IPC is in backup_commands.
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}},
    time::Instant,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mode { Create, Check, Restore }
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Refusal { Busy, InvalidChoice, ExpiredChoice, WrongWindow, WrongMode, UnknownOutcome, Unavailable, #[cfg_attr(target_os = "macos", expect(dead_code, reason = "The non-macOS fixed-copy refusal is represented by the shared wire type."))] UnsupportedPlatform }

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum KernelFailure {
    Authority(crate::workspace_service::types::selected::AuthorityError),
    Backup(crate::workspace_migration::backup::BackupError),
    Control(Refusal),
}
impl From<Refusal> for KernelFailure { fn from(value: Refusal) -> Self { Self::Control(value) } }
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum CopyDisposition {
    NoneCreated,
    CreationUncertain(crate::workspace_service::authority::OutputObservation),
    Incomplete(crate::workspace_service::authority::OutputObservation),
    CompletionUnknown(Option<crate::workspace_service::authority::OutputObservation>),
    Completed(crate::workspace_service::authority::OutputObservation),
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CopyTerminal {
    pub disposition: CopyDisposition,
    pub workspace_id: Option<String>,
    pub summary: Option<crate::workspace_migration::backup::CheckedBackupSummary>,
    pub failure: Option<KernelFailure>,
    pub response_available: bool,
}
fn copy_terminal(
    report: Option<crate::workspace_migration::backup::NativeCopyReport>,
    failure: Option<KernelFailure>,
    observed: Option<crate::workspace_service::authority::OutputObservation>,
) -> CopyTerminal {
    use crate::workspace_migration::backup::OutputPhase;
    let reported_success = report.is_some();
    let workspace_id = report.as_ref().map(|report| report.workspace_id.clone());
    let summary = report.and_then(|report| report.summary);
    // The fixed route installs observation before either admitted writer.
    // Contradictory report/facts remain unknown rather than inventing no output.
    let disposition = match observed {
        None if reported_success => CopyDisposition::CompletionUnknown(None),
        None => CopyDisposition::NoneCreated,
        Some(output) if reported_success && output.phase != OutputPhase::Published => CopyDisposition::CompletionUnknown(Some(output)),
        Some(output) => match output.phase {
            OutputPhase::NotStarted => CopyDisposition::NoneCreated,
            OutputPhase::CreationAttempted => CopyDisposition::CreationUncertain(output),
            OutputPhase::Created => CopyDisposition::Incomplete(output),
            OutputPhase::PublicationAttempted => CopyDisposition::CompletionUnknown(Some(output)),
            OutputPhase::Published => CopyDisposition::Completed(output),
        },
    };
    // Published dominates later failure; absent response facts stay unavailable.
    let response_available = matches!(&disposition, CopyDisposition::Completed(_)) && reported_success && summary.is_some() && failure.is_none();
    CopyTerminal { disposition, workspace_id, summary, failure, response_available }
}

#[derive(Clone, PartialEq, Eq)]
struct WindowIdentity { window: usize, view: usize, label: String }
use super::backup_types::WorkspaceBackupLabels;
fn label(path: &Path) -> String { path.to_string_lossy().into_owned() }
struct AppSlot { occupied: AtomicBool }
impl AppSlot {
    fn new() -> Arc<Self> { Arc::new(Self { occupied: AtomicBool::new(false) }) }
    fn acquire(self: &Arc<Self>) -> Result<ActivityLease, Refusal> {
        self.occupied.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map_err(|_| Refusal::Busy)?;
        Ok(ActivityLease { app: self.clone() })
    }
}
/// One app-lifetime nonclone slot, independent of a window registration/book.
/// It is the last resource released by owned chooser/pending/copy values.
struct ActivityLease { app: Arc<AppSlot> }
impl Drop for ActivityLease { fn drop(&mut self) { self.app.occupied.store(false, Ordering::SeqCst); } }
struct OriginPin { directory: std::fs::File, path: PathBuf, device: u64, inode: u64 }
impl OriginPin {
    fn validate(&self) -> Result<(), Refusal> {
        use std::os::unix::fs::MetadataExt as _;
        let held = self.directory.metadata().map_err(|_| Refusal::Unavailable)?;
        let current = std::fs::symlink_metadata(&self.path).map_err(|_| Refusal::Unavailable)?;
        if !held.is_dir() || !current.is_dir() || current.file_type().is_symlink()
            || held.uid() != unsafe { libc::geteuid() } || held.mode() & 0o022 != 0
            || held.dev() != self.device || held.ino() != self.inode
            || current.dev() != self.device || current.ino() != self.inode { return Err(Refusal::Unavailable); }
        Ok(())
    }
}
struct Registration {
    app: Arc<AppSlot>, identity: WindowIdentity, origin: PathBuf, origin_pin: Option<Arc<OriginPin>>, live: AtomicBool, book: Mutex<Book>,
}
impl Registration {
    fn check_origin(&self) -> Result<(), Refusal> {
        match self.origin_pin.as_ref() {
            Some(pin) => pin.validate(),
            #[cfg(test)] None => Ok(()),
            #[cfg(not(test))] None => Err(Refusal::Unavailable),
        }
    }
}
struct WindowObservation {
    registration: Arc<Registration>, injected: WindowIdentity, current: WindowIdentity, origin: PathBuf, allowed_entry: bool,
}
struct WindowProof { registration: Arc<Registration> }
fn authenticate(registration: &Arc<Registration>, observed: WindowObservation) -> Result<WindowProof, Refusal> {
    if !registration.live.load(Ordering::SeqCst)
        || !Arc::ptr_eq(registration, &observed.registration)
        || registration.identity.window == 0 || registration.identity.view == 0
        || registration.identity.label != crate::shell::MAIN_WINDOW
        || observed.injected != registration.identity || observed.current != registration.identity
        || observed.origin != registration.origin || !observed.allowed_entry
    { return Err(Refusal::WrongWindow); }
    registration.check_origin()?;
    Ok(WindowProof { registration: registration.clone() })
}

// The opaque original source ticket survives every await. Only the real
// reserve_selected_output consumes it; no same-path/generation recapture.
enum Choice {
    Create { source: crate::workspace_service::authority::SelectedBackupOpening, output: crate::workspace_migration::backup::NewDirectoryChoice },
    Checked { input: crate::workspace_migration::backup::CheckedBackupInput },
    Restore { input: crate::workspace_migration::backup::CheckedBackupInput, output: crate::workspace_migration::backup::NewDirectoryChoice },
    #[cfg(test)]
    Fixture { mode: Mode, resource: ChoiceResource },
}
impl Choice {
    fn mode(&self) -> Mode { match self {
        Self::Create { .. } => Mode::Create, Self::Checked { .. } => Mode::Check, Self::Restore { .. } => Mode::Restore,
        #[cfg(test)] Self::Fixture { mode, .. } => *mode,
    }}
}
// Own source/input evidence through the native dialog callback. Restore can
// choose only a new output; it cannot substitute the checked input.
enum ChoosingInput {
    Check,
    Create { source: crate::workspace_service::authority::SelectedBackupOpening },
    Restore { input: crate::workspace_migration::backup::CheckedBackupInput },
    #[cfg(test)] Fixture { mode: Mode, retained: Option<Choice> },
}
enum NativeChoice {
    Input(crate::workspace_migration::backup::CheckedBackupInput),
    Output(crate::workspace_migration::backup::NewDirectoryChoice),
    #[cfg(test)] Fixture(Choice),
}
struct ChoiceCompletion { chosen: NativeChoice, observation: WindowObservation }
#[derive(Debug, Clone, PartialEq, Eq)]
struct Review { operation: String, token: String, mode: Mode, labels: WorkspaceBackupLabels, summary: Option<crate::workspace_migration::backup::CheckedBackupSummary>, expires_at: Option<String> }
#[derive(Debug, Clone, PartialEq, Eq)]
enum Terminal { #[cfg(test)] Completed, Refused { reason: Refusal, none_created: bool }, ChoiceRefused(KernelFailure), Copy(CopyTerminal) }
#[derive(Debug, Clone, PartialEq, Eq)]
enum Status { Idle, Choosing { operation: String, mode: Mode, labels: WorkspaceBackupLabels }, Pending(Review), Running { operation: String, mode: Mode, labels: WorkspaceBackupLabels }, Terminal { operation: String, mode: Mode, labels: WorkspaceBackupLabels, outcome: Terminal } }
struct Pending { review: Review, expires: Instant, choice: Choice, slot: ActivityLease }
enum Book { Idle, Choosing { operation: String, mode: Mode, labels: WorkspaceBackupLabels }, Pending(Pending), Running { operation: String, token: String, mode: Mode, labels: WorkspaceBackupLabels }, Terminal { operation: String, token: Option<String>, mode: Mode, labels: WorkspaceBackupLabels, outcome: Terminal } }
struct ChoosingWork { registration: Arc<Registration>, operation: String, mode: Mode, labels: WorkspaceBackupLabels, input: Option<ChoosingInput>, slot: Option<ActivityLease>, finished: bool }
struct CommitWindow { registration: Arc<Registration> }
impl CommitWindow { fn check(&self) -> Result<(), Refusal> {
    if self.registration.live.load(Ordering::SeqCst) { self.registration.check_origin() } else { Err(Refusal::WrongWindow) }
}}
struct RunningWork { registration: Arc<Registration>, operation: String, token: String, mode: Mode, labels: WorkspaceBackupLabels, choice: Option<Choice>, began: bool, finished: bool, real_kernel: bool, progress: Option<crate::workspace_service::authority::OutputProgress>, slot: Option<ActivityLease> }
enum Commit { Started(RunningWork), AlreadyStarted(Status) }

impl Choice {
    fn labels(&self) -> WorkspaceBackupLabels { match self {
        Self::Create { source, output } => WorkspaceBackupLabels { source: Some(label(source.root())), input: None, output: Some(label(output.path())) },
        Self::Checked { input } => WorkspaceBackupLabels { source: None, input: Some(label(input.path())), output: None },
        Self::Restore { input, output } => WorkspaceBackupLabels { source: None, input: Some(label(input.path())), output: Some(label(output.path())) },
        #[cfg(test)] Self::Fixture { .. } => WorkspaceBackupLabels::default(),
    }}
    fn summary(&self) -> Option<crate::workspace_migration::backup::CheckedBackupSummary> { match self {
        Self::Checked { input } | Self::Restore { input, .. } => Some(input.summary().clone()),
        _ => None,
    }}
}
impl ChoosingInput {
    fn labels(&self) -> WorkspaceBackupLabels { match self {
        Self::Check => WorkspaceBackupLabels::default(),
        Self::Create { source } => WorkspaceBackupLabels { source: Some(label(source.root())), input: None, output: None },
        Self::Restore { input } => WorkspaceBackupLabels { source: None, input: Some(label(input.path())), output: None },
        #[cfg(test)] Self::Fixture { retained: Some(choice), .. } => { let mut labels = choice.labels(); labels.output = None; labels },
        #[cfg(test)] Self::Fixture { retained: None, .. } => WorkspaceBackupLabels::default(),
    }}
}

fn nonce() -> Result<String, Refusal> {
    use rand::RngCore as _;
    use std::fmt::Write as _;
    let mut bytes = [0u8; 16];
    rand::rngs::OsRng.try_fill_bytes(&mut bytes).map_err(|_| Refusal::Unavailable)?;
    let mut value = String::with_capacity(32);
    for byte in bytes { write!(&mut value, "{byte:02x}").map_err(|_| Refusal::Unavailable)?; }
    Ok(value)
}
impl ChoosingInput {
    fn mode(&self) -> Mode { match self {
        Self::Check => Mode::Check, Self::Create { .. } => Mode::Create, Self::Restore { .. } => Mode::Restore,
        #[cfg(test)] Self::Fixture { mode, .. } => *mode,
    }}
}
impl Book {
    fn snapshot(&self) -> Status { match self {
        Self::Idle => Status::Idle,
        Self::Choosing { operation, mode, labels } => Status::Choosing { operation: operation.clone(), mode: *mode, labels: labels.clone() },
        Self::Pending(pending) => Status::Pending(pending.review.clone()),
        Self::Running { operation, mode, labels, .. } => Status::Running { operation: operation.clone(), mode: *mode, labels: labels.clone() },
        Self::Terminal { operation, mode, labels, outcome, .. } => Status::Terminal { operation: operation.clone(), mode: *mode, labels: labels.clone(), outcome: outcome.clone() },
    }}
}
fn release_pending(pending: Pending) {
    let Pending { choice, slot, .. } = pending;
    drop(choice);
    drop(slot);
}
impl WindowProof {
    fn live(&self) -> Result<(), Refusal> {
        if self.registration.live.load(Ordering::SeqCst) { self.registration.check_origin() } else { Err(Refusal::WrongWindow) }
    }
    fn expire_pending(&self, now: Instant) -> Result<bool, Refusal> {
        self.live()?;
        let expired = {
            let mut book = self.registration.book.lock().map_err(|_| Refusal::Unavailable)?;
            self.live()?;
            if matches!(&*book, Book::Pending(pending) if pending.expires <= now) {
                let Book::Pending(pending) = std::mem::replace(&mut *book, Book::Idle) else { return Err(Refusal::Unavailable); };
                *book = Book::Terminal { operation: pending.review.operation.clone(), token: Some(pending.review.token.clone()), mode: pending.review.mode, labels: pending.review.labels.clone(), outcome: Terminal::Refused { reason: Refusal::ExpiredChoice, none_created: true } };
                Some(pending)
            } else { None }
        };
        let changed = expired.is_some();
        if let Some(pending) = expired { release_pending(pending); }
        Ok(changed)
    }
    fn begin(&self, input: ChoosingInput) -> Result<ChoosingWork, Refusal> {
        self.live()?;
        self.expire_pending(Instant::now())?;
        let operation = nonce()?;
        let mode = input.mode();
        let labels = input.labels();
        // Acquire the app-lifetime slot without a book/global nested mutex.
        // An old retired window's actual callback/copy keeps this occupied.
        let slot = self.registration.app.acquire()?;
        {
            let mut book = self.registration.book.lock().map_err(|_| Refusal::Unavailable)?;
            self.live()?;
            if !matches!(&*book, Book::Idle | Book::Terminal { .. }) { return Err(Refusal::Busy); }
            *book = Book::Choosing { operation: operation.clone(), mode, labels: labels.clone() };
        }
        Ok(ChoosingWork { registration: self.registration.clone(), operation, mode, labels, input: Some(input), slot: Some(slot), finished: false })
    }
    fn begin_check(&self) -> Result<ChoosingWork, Refusal> { self.begin(ChoosingInput::Check) }
    fn begin_create(&self, source: crate::workspace_service::authority::SelectedBackupOpening) -> Result<ChoosingWork, Refusal> {
        self.begin(ChoosingInput::Create { source })
    }
    fn choose_restore(&self, token: &str, now: Instant) -> Result<ChoosingWork, Refusal> {
        if self.expire_pending(now)? { return Err(Refusal::ExpiredChoice); }
        let pending = {
            let mut book = self.registration.book.lock().map_err(|_| Refusal::Unavailable)?;
            self.live()?;
            let Book::Pending(pending) = &*book else { return Err(Refusal::InvalidChoice); };
            if pending.review.token != token { return Err(Refusal::InvalidChoice); }
            if pending.review.mode != Mode::Check || pending.choice.mode() != Mode::Check { return Err(Refusal::WrongMode); }
            let Book::Pending(pending) = std::mem::replace(&mut *book, Book::Idle) else { return Err(Refusal::Unavailable); };
            *book = Book::Choosing { operation: pending.review.operation.clone(), mode: Mode::Restore, labels: WorkspaceBackupLabels { source: None, input: pending.review.labels.input.clone(), output: None } };
            pending
        };
        let Pending { review, choice, slot, .. } = pending;
        let input = match choice {
            Choice::Checked { input } => ChoosingInput::Restore { input },
            #[cfg(test)] fixture @ Choice::Fixture { mode: Mode::Check, .. } => ChoosingInput::Fixture { mode: Mode::Restore, retained: Some(fixture) },
            _ => return Err(Refusal::Unavailable),
        };
        Ok(ChoosingWork { registration: self.registration.clone(), operation: review.operation, mode: Mode::Restore, labels: input.labels(), input: Some(input), slot: Some(slot), finished: false })
    }
    fn commit(&self, token: &str, mode: Mode, now: Instant) -> Result<Commit, Refusal> {
        if self.expire_pending(now)? { return Err(Refusal::ExpiredChoice); }
        let pending = {
            let mut book = self.registration.book.lock().map_err(|_| Refusal::Unavailable)?;
            self.live()?;
            match &*book {
                Book::Running { token: consumed, mode: original, .. } if consumed == token => {
                    if *original != mode { return Err(Refusal::WrongMode); }
                    return Ok(Commit::AlreadyStarted(book.snapshot()));
                },
                Book::Terminal { token: Some(consumed), mode: original, outcome, .. } if consumed == token => {
                    if *original != mode { return Err(Refusal::WrongMode); }
                    if matches!(outcome, Terminal::Refused { reason: Refusal::ExpiredChoice, .. }) { return Err(Refusal::ExpiredChoice); }
                    return Ok(Commit::AlreadyStarted(book.snapshot()));
                },
                Book::Pending(pending) => {
                    if pending.review.token != token { return Err(Refusal::InvalidChoice); }
                    if pending.review.mode != mode || mode == Mode::Check || pending.choice.mode() != mode { return Err(Refusal::WrongMode); }
                },
                _ => return Err(Refusal::InvalidChoice),
            }
            let Book::Pending(pending) = std::mem::replace(&mut *book, Book::Idle) else { return Err(Refusal::Unavailable); };
            *book = Book::Running { operation: pending.review.operation.clone(), token: pending.review.token.clone(), mode, labels: pending.review.labels.clone() };
            pending
        };
        let Pending { review, choice, slot, .. } = pending;
        Ok(Commit::Started(RunningWork { registration: self.registration.clone(), operation: review.operation, token: review.token, mode, labels: review.labels, choice: Some(choice), began: false, finished: false, real_kernel: false, progress: None, slot: Some(slot) }))
    }
    fn cancel(&self, token: &str, now: Instant) -> Result<Status, Refusal> {
        if self.expire_pending(now)? { return Err(Refusal::ExpiredChoice); }
        let pending = {
            let mut book = self.registration.book.lock().map_err(|_| Refusal::Unavailable)?;
            self.live()?;
            match &*book {
                Book::Running { token: consumed, .. } | Book::Terminal { token: Some(consumed), .. } if consumed == token => return Ok(book.snapshot()),
                Book::Pending(pending) if pending.review.token == token => {},
                _ => return Err(Refusal::InvalidChoice),
            }
            let Book::Pending(pending) = std::mem::replace(&mut *book, Book::Idle) else { return Err(Refusal::Unavailable); };
            pending
        };
        release_pending(pending);
        Ok(Status::Idle)
    }
    fn status(&self, now: Instant) -> Result<Status, Refusal> {
        self.expire_pending(now)?;
        let book = self.registration.book.lock().map_err(|_| Refusal::Unavailable)?;
        self.live()?;
        if matches!(&*book, Book::Idle) && self.registration.app.occupied.load(Ordering::SeqCst) { return Err(Refusal::Busy); }
        Ok(book.snapshot())
    }
}
impl Registration {
    fn retire(&self) {
        self.live.store(false, Ordering::SeqCst);
        let released = if let Ok(mut book) = self.book.lock() {
            if matches!(&*book, Book::Pending(_) | Book::Terminal { .. }) { Some(std::mem::replace(&mut *book, Book::Idle)) } else { None }
        } else { None };
        // Choosing/Running owners keep their slot through actual callback/kernel
        // completion. Pending descriptors close outside book before their slot.
        if let Some(Book::Pending(pending)) = released { release_pending(pending); }
    }
}
impl ChoosingWork {
    fn close(&mut self, reason: Option<KernelFailure>) -> Result<(), Refusal> {
        drop(self.input.take());
        drop(self.slot.take());
        self.finished = true;
        let mut book = self.registration.book.lock().map_err(|_| Refusal::Unavailable)?;
        if matches!(&*book, Book::Choosing { operation, .. } if operation == &self.operation) {
            *book = if let Some(reason) = reason.filter(|_| self.registration.live.load(Ordering::SeqCst)) {
                Book::Terminal { operation: self.operation.clone(), token: None, mode: self.mode, labels: self.labels.clone(), outcome: Terminal::ChoiceRefused(reason) }
            } else { Book::Idle };
        }
        Ok(())
    }
    #[cfg(test)]
    fn complete(self, now: impl FnOnce() -> Instant, work: impl FnOnce() -> Result<Option<ChoiceCompletion>, Refusal>) -> Result<Option<Review>, Refusal> {
        self.complete_inner(None, now, || work().map_err(KernelFailure::Control)).map_err(|error| match error { KernelFailure::Control(reason) => reason, _ => Refusal::InvalidChoice })
    }
    fn complete_bound(self, context: &crate::workspace_service::authority::AuthorityContext, now: impl FnOnce() -> Instant, work: impl FnOnce() -> Result<Option<ChoiceCompletion>, KernelFailure>) -> Result<Option<Review>, KernelFailure> {
        self.complete_inner(Some(context), now, work)
    }
    fn complete_inner(mut self, context: Option<&crate::workspace_service::authority::AuthorityContext>, now: impl FnOnce() -> Instant, work: impl FnOnce() -> Result<Option<ChoiceCompletion>, KernelFailure>) -> Result<Option<Review>, KernelFailure> {
        let result: Result<Option<Review>, KernelFailure> = (|| {
            if !self.registration.live.load(Ordering::SeqCst) { return Err(Refusal::WrongWindow.into()); }
            let Some(completion) = work()? else { return Ok(None); };
            authenticate(&self.registration, completion.observation)?;
            let token = nonce()?;
            let input = self.input.take().ok_or(Refusal::Unavailable)?;
            let choice = match (input, completion.chosen) {
                (ChoosingInput::Check, NativeChoice::Input(input)) => Choice::Checked { input },
                (ChoosingInput::Create { source }, NativeChoice::Output(output)) => Choice::Create { source, output },
                (ChoosingInput::Restore { input }, NativeChoice::Output(output)) => Choice::Restore { input, output },
                #[cfg(test)]
                (ChoosingInput::Fixture { mode, retained: None }, NativeChoice::Fixture(choice)) if mode == choice.mode() => choice,
                _ => return Err(Refusal::WrongMode.into()),
            };
            if let Choice::Create { source, .. } = &choice {
                context.ok_or(Refusal::Unavailable)?.validate_selected_backup_opening(source).map_err(KernelFailure::Authority)?;
            }
            // The private clock runs AFTER the chooser/full validator and fresh
            // native observation, never before a potentially long callback.
            let completed_at = now();
            let expires = completed_at.checked_add(std::time::Duration::from_secs(super::backup_policy::rules().pending_lease_seconds)).ok_or(Refusal::Unavailable)?;
            let expires_at = std::time::SystemTime::now().checked_add(std::time::Duration::from_secs(super::backup_policy::rules().pending_lease_seconds))
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok()).map(|duration| duration.as_millis().to_string());
            let labels = choice.labels();
            let summary = choice.summary();
            self.labels = labels.clone();
            let review = Review { operation: self.operation.clone(), token, mode: self.mode, labels, summary, expires_at };
            {
                let mut book = self.registration.book.lock().map_err(|_| Refusal::Unavailable)?;
                if !self.registration.live.load(Ordering::SeqCst) { return Err(Refusal::WrongWindow.into()); }
                if !matches!(&*book, Book::Choosing { operation, mode, .. } if operation == &self.operation && *mode == self.mode) { return Err(Refusal::InvalidChoice.into()); }
                let slot = self.slot.take().ok_or(Refusal::Unavailable)?;
                *book = Book::Pending(Pending { review: review.clone(), expires, choice, slot });
                self.finished = true;
            }
            Ok(Some(review))
        })();
        match result {
            Ok(Some(review)) => Ok(Some(review)),
            Ok(None) => { self.close(None)?; Ok(None) },
            Err(reason) => { self.close(Some(reason.clone()))?; Err(reason) },
        }
    }
}
impl Drop for ChoosingWork {
    fn drop(&mut self) { if !self.finished { let _ = self.close(None); } }
}
impl RunningWork {
    fn finish_copy(&mut self, report: Option<crate::workspace_migration::backup::NativeCopyReport>, failure: Option<KernelFailure>) -> CopyTerminal {
        drop(self.choice.take());
        let observed = self.progress.take().map(|observer| {
            let snapshot = observer.snapshot();
            // Drops the passive directory FD before app permit release.
            drop(observer);
            snapshot
        });
        let mut terminal = copy_terminal(report, failure, observed);
        if self.settle(Terminal::Copy(terminal.clone())).is_err() {
            if terminal.failure.is_none() { terminal.failure = Some(KernelFailure::Control(Refusal::Unavailable)); }
            terminal.response_available = false;
        }
        terminal
    }
    fn copy_choice(&mut self, context: &crate::workspace_service::authority::AuthorityContext, choice: Choice, gate: CommitWindow) -> Result<crate::workspace_migration::backup::NativeCopyReport, KernelFailure> {
        use crate::workspace_migration::backup;
        use crate::workspace_service::{authority, types::selected::AuthorityErrorKind};
        let check_window = || gate.check().map_err(|_| authority::error(AuthorityErrorKind::ContextUnavailable, "The original backup window retired before output admission."));
        match choice {
            #[cfg(target_os = "macos")]
            Choice::Create { source, output } => {
                #[cfg(test)] let display = output.path().to_path_buf();
                #[cfg(test)] backup::native_copy_step("backup_before_output_admission", &display, &display);
                let (lease, source) = context.reserve_selected_output(source, output, check_window).map_err(KernelFailure::Authority)?;
                self.progress = Some(lease.progress());
                #[cfg(test)] backup::native_copy_step("backup_after_output_admission", &display, &display);
                let result = backup::backup_admitted(source, lease).map_err(KernelFailure::Backup);
                #[cfg(test)] backup::native_copy_step("backup_after_kernel_return", &display, &display);
                result
            },
            #[cfg(not(target_os = "macos"))]
            Choice::Create { .. } => Err(KernelFailure::Control(Refusal::UnsupportedPlatform)),
            Choice::Restore { input, output } => {
                #[cfg(all(test, target_os = "macos"))] let display = output.path().to_path_buf();
                #[cfg(all(test, target_os = "macos"))] backup::native_copy_step("backup_before_output_admission", &display, &display);
                let separation = [input.path().to_path_buf()];
                let (lease, ()) = context.reserve_output(output, &separation, check_window).map_err(KernelFailure::Authority)?;
                self.progress = Some(lease.progress());
                #[cfg(all(test, target_os = "macos"))] backup::native_copy_step("backup_after_output_admission", &display, &display);
                let result = backup::restore_admitted(input, lease).map_err(KernelFailure::Backup);
                #[cfg(all(test, target_os = "macos"))] backup::native_copy_step("backup_after_kernel_return", &display, &display);
                result
            },
            Choice::Checked { .. } => Err(KernelFailure::Control(Refusal::WrongMode)),
            #[cfg(test)]
            Choice::Fixture { .. } => Err(KernelFailure::Control(Refusal::WrongMode)),
        }
    }
    /// Shipping route is fixed: one exact Choice, one actual reserve gate, one
    /// admitted existing kernel. No callback can bypass reservation/progress.
    fn execute_copy(mut self, context: &crate::workspace_service::authority::AuthorityContext) -> CopyTerminal {
        self.real_kernel = true;
        let gate = CommitWindow { registration: self.registration.clone() };
        if let Err(reason) = gate.check() { return self.finish_copy(None, Some(KernelFailure::Control(reason))); }
        let Some(choice) = self.choice.take() else { return self.finish_copy(None, Some(KernelFailure::Control(Refusal::Unavailable))); };
        self.began = true;
        match self.copy_choice(context, choice, gate) {
            Ok(report) => self.finish_copy(Some(report), None),
            Err(failure) => self.finish_copy(None, Some(failure)),
        }
    }
    fn settle(&mut self, outcome: Terminal) -> Result<(), Refusal> {
        // The synchronous kernel has returned/unwound before this boundary.
        // Never update a replacement operation or release a live callback's slot.
        drop(self.choice.take());
        drop(self.slot.take());
        self.finished = true;
        let mut book = self.registration.book.lock().map_err(|_| Refusal::Unavailable)?;
        if !matches!(&*book, Book::Running { operation, token, mode, .. } if operation == &self.operation && token == &self.token && *mode == self.mode) { return Err(Refusal::Unavailable); }
        *book = Book::Terminal { operation: self.operation.clone(), token: Some(self.token.clone()), mode: self.mode, labels: self.labels.clone(), outcome };
        Ok(())
    }
    #[cfg(test)]
    fn execute(mut self, work: impl FnOnce(Choice, CommitWindow) -> Result<(), Refusal>) -> Result<(), Refusal> {
        let gate = CommitWindow { registration: self.registration.clone() };
        if let Err(reason) = gate.check() {
            self.settle(Terminal::Refused { reason, none_created: true })?;
            return Err(reason);
        }
        let choice = self.choice.take().ok_or(Refusal::Unavailable)?;
        self.began = true;
        // The real kernel must check this original CommitWindow INSIDE its
        // existing reserve gate as well. This early check alone is no admission.
        let result = work(choice, gate);
        // Until the real output-progress handoff is composed, a kernel error
        // cannot establish whether output was created or durably published.
        // Preserve the immediate cause to the caller; terminal disposition is unknown.
        let outcome = match result { Ok(()) => Terminal::Completed, Err(_) => Terminal::Refused { reason: Refusal::UnknownOutcome, none_created: false } };
        self.settle(outcome)?;
        result
    }
}
impl Drop for RunningWork {
    fn drop(&mut self) {
        if !self.finished {
            if self.real_kernel {
                let _ = self.finish_copy(None, Some(KernelFailure::Control(Refusal::UnknownOutcome)));
            } else {
                let outcome = Terminal::Refused { reason: if self.began { Refusal::UnknownOutcome } else { Refusal::Unavailable }, none_created: !self.began };
                let _ = self.settle(outcome);
            }
        }
    }
}

#[cfg(test)]
pub(crate) enum TestCopyRequest {
    Create { source: crate::workspace_service::authority::SelectedBackupOpening, output: crate::workspace_migration::backup::NewDirectoryChoice },
    Restore { input: crate::workspace_migration::backup::CheckedBackupInput, output: crate::workspace_migration::backup::NewDirectoryChoice },
}
#[cfg(test)]
#[derive(Clone)]
pub(crate) struct TestRetirement(Arc<Registration>);
#[cfg(test)]
impl TestRetirement {
    pub(crate) fn retire(&self) { self.0.retire(); }
    pub(crate) fn slot_occupied(&self) -> bool { self.0.app.occupied.load(Ordering::SeqCst) }
    pub(crate) fn recreated_check_refusal(&self) -> Option<Refusal> {
        let identity = WindowIdentity { window: 2, view: 202, label: crate::shell::MAIN_WINDOW.into() };
        let registration = Arc::new(Registration { app: self.0.app.clone(), identity: identity.clone(), origin: self.0.origin.clone(), origin_pin: None, live: AtomicBool::new(true), book: Mutex::new(Book::Idle) });
        let observed = WindowObservation { registration: registration.clone(), injected: identity.clone(), current: identity, origin: registration.origin.clone(), allowed_entry: true };
        authenticate(&registration, observed).unwrap().begin_check().map(drop).err()
    }
    pub(crate) fn poison_book(&self) {
        let registration = self.0.clone();
        let _ = std::thread::spawn(move || { let _held = registration.book.lock().unwrap(); panic!("synthetic terminal-book poison"); }).join();
    }
}
#[cfg(test)]
pub(crate) struct TestCopyWork { work: Option<RunningWork>, registration: Arc<Registration> }
#[cfg(test)]
pub(crate) struct TestCopyResult { pub terminal: CopyTerminal, pub panicked: bool, pub slot_occupied: bool }
#[cfg(test)]
pub(crate) fn test_copy_work(request: TestCopyRequest) -> TestCopyWork {
    let choice = match request {
        TestCopyRequest::Create { source, output } => Choice::Create { source, output },
        TestCopyRequest::Restore { input, output } => Choice::Restore { input, output },
    };
    let mode = choice.mode();
    let app = AppSlot::new();
    let identity = WindowIdentity { window: 1, view: 101, label: crate::shell::MAIN_WINDOW.into() };
    let registration = Arc::new(Registration { app: app.clone(), identity: identity.clone(), origin: PathBuf::from("/synthetic-backup-kernel-origin"), origin_pin: None, live: AtomicBool::new(true), book: Mutex::new(Book::Idle) });
    let observed = WindowObservation { registration: registration.clone(), injected: identity.clone(), current: identity, origin: registration.origin.clone(), allowed_entry: true };
    let proof = authenticate(&registration, observed).unwrap();
    let review = Review { operation: nonce().unwrap(), token: nonce().unwrap(), mode, labels: choice.labels(), summary: choice.summary(), expires_at: None };
    let now = Instant::now();
    let expires = now.checked_add(std::time::Duration::from_secs(super::backup_policy::rules().pending_lease_seconds)).unwrap();
    *registration.book.lock().unwrap() = Book::Pending(Pending { review: review.clone(), expires, choice, slot: app.acquire().unwrap() });
    let Commit::Started(work) = proof.commit(&review.token, mode, now).unwrap() else { panic!("fixture did not create the original owned copy"); };
    TestCopyWork { work: Some(work), registration }
}
#[cfg(test)]
impl TestCopyWork {
    pub(crate) fn retirement(&self) -> TestRetirement { TestRetirement(self.registration.clone()) }
    pub(crate) fn run(mut self, context: &crate::workspace_service::authority::AuthorityContext) -> TestCopyResult {
        let work = self.work.take().unwrap();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| work.execute_copy(context)));
        let (terminal, panicked) = match result {
            Ok(terminal) => (terminal, false),
            Err(_) => {
                let book = self.registration.book.lock().unwrap();
                let Book::Terminal { outcome: Terminal::Copy(terminal), .. } = &*book else { panic!("owned kernel unwind lost its typed terminal"); };
                (terminal.clone(), true)
            },
        };
        TestCopyResult { terminal, panicked, slot_occupied: self.registration.app.occupied.load(Ordering::SeqCst) }
    }
}

#[cfg(test)]
struct ChoiceResource(Arc<std::sync::atomic::AtomicUsize>);
#[cfg(test)]
impl Drop for ChoiceResource { fn drop(&mut self) { self.0.fetch_add(1, Ordering::SeqCst); } }
#[cfg(test)]
#[path = "backup_coordinator_tests.rs"]
mod tests;

#[cfg(target_os = "macos")]
#[path = "backup_native.rs"]
pub(crate) mod native;
