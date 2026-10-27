//! Opening/output admission shares ActiveRoot. No storage lock may enter this gate.
use super::super::boundary;
use super::*;
#[cfg(unix)]
use crate::workspace_migration::backup::{NewDirectoryChoice, OutputDirectory};

fn unavailable() -> AuthorityError {
    error(
        AuthorityErrorKind::ContextUnavailable,
        "Opening coordination is unavailable.",
    )
}
fn changed() -> AuthorityError {
    error(
        AuthorityErrorKind::SourceChanged,
        "This workspace opening was superseded or changed.",
    )
}
fn overlap() -> AuthorityError {
    error(
        AuthorityErrorKind::Busy,
        "The output overlaps an opening workspace.",
    )
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Identity {
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
}
impl Identity {
    fn at(path: &Path) -> Result<Self, AuthorityError> {
        let metadata = fs::symlink_metadata(path).map_err(|_| changed())?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(changed());
        }
        #[cfg(unix)]
        use std::os::unix::fs::MetadataExt;
        Ok(Self {
            #[cfg(unix)]
            device: metadata.dev(),
            #[cfg(unix)]
            inode: metadata.ino(),
        })
    }
}
/// Bounded physical ancestry, never a filesystem search for a renamed object.
#[derive(Clone)]
struct Scope {
    root: PathBuf,
    ancestry: Vec<(PathBuf, Identity)>,
    // P1 has already bounded the tree and followed each reachable directory alias.
    routed: Vec<PathBuf>,
    anchors: Option<boundary::OpeningAnchors>,
}
impl Scope {
    fn capture(root: &Path, routed: Vec<PathBuf>) -> Result<Self, AuthorityError> {
        let root = canonical_root(root)?;
        boundary::lexical(&root)?;
        let ancestry = root
            .ancestors()
            .map(|p| Ok((p.to_path_buf(), Identity::at(p)?)))
            .collect::<Result<Vec<_>, AuthorityError>>()?;
        Ok(Self {
            root,
            ancestry,
            routed,
            anchors: None,
        })
    }
    fn validate(&self) -> Result<(), AuthorityError> {
        for (path, identity) in &self.ancestry {
            if Identity::at(path)? != *identity {
                return Err(changed());
            }
        }
        if let Some(anchors) = &self.anchors {
            anchors.revalidate()?;
        }
        Ok(())
    }
    fn intersects(&self, output: &Footprint) -> Result<bool, AuthorityError> {
        self.validate()?;
        output.validate()?;
        Ok(self
            .routed
            .iter()
            .chain(std::iter::once(&self.root))
            .any(|root| root.starts_with(&output.path) || output.path.starts_with(root))
            || output
                .created
                .is_some_and(|identity| self.ancestry.iter().any(|(_, i)| *i == identity)))
    }
}
struct RequestIdentity {
    generation: u64,
    scope: Scope,
    selected: Option<SelectedBinding>,
}
/// A generation is only an agent ordering number; this identity is the opening capability.
pub(crate) struct OpeningAttempt {
    active: Arc<Mutex<ActiveRoot>>,
    request: Arc<RequestIdentity>,
}
impl OpeningAttempt {
    pub(crate) fn generation(&self) -> u64 {
        self.request.generation
    }
    pub(crate) fn root(&self) -> &Path {
        &self.request.scope.root
    }
    pub(crate) fn selected(&self) -> bool {
        self.request.selected.is_some()
    }
}
/// One protected prior, newest request, entered request and output. No attempt history.
#[derive(Default)]
pub(super) struct OpeningState {
    prior: Option<(Arc<RequestIdentity>, Scope)>,
    requested: Option<Arc<RequestIdentity>>,
    entered: Option<(Arc<RequestIdentity>, Scope)>,
    output: Option<Arc<Mutex<Footprint>>>,
}
fn observe(
    context: &AuthorityContext,
    root: &Path,
) -> Result<(Scope, Option<SelectedBinding>, Option<boundary::Inspection>), AuthorityError> {
    let selected = resolve_with(context, root)?;
    let inspection = if selected.is_none() {
        Some(boundary::inspect_with_limits(
            Some(context),
            &[(root.to_path_buf(), true)],
            boundary::limits(),
        )?)
    } else {
        None
    };
    let routed = inspection
        .as_ref()
        .map_or_else(Vec::new, boundary::Inspection::opening_directories);
    let mut scope = Scope::capture(root, routed)?;
    scope.anchors = inspection
        .as_ref()
        .map(boundary::Inspection::opening_anchors)
        .transpose()?;
    Ok((scope, selected, inspection))
}
fn revalidate_fresh(inspection: Option<&boundary::Inspection>) -> Result<(), AuthorityError> {
    if let Some(inspection) = inspection {
        inspection.revalidate()?;
    }
    Ok(())
}

#[cfg(test)]
thread_local! { static REQUEST_OBSERVED: std::cell::RefCell<Option<Box<dyn FnOnce()>>> = const { std::cell::RefCell::new(None) }; }
#[cfg(test)]
fn request_observed() {
    let hook = REQUEST_OBSERVED.with(|slot| slot.borrow_mut().take());
    if let Some(hook) = hook {
        hook();
    }
}

fn check_output(state: &OpeningState, scope: &Scope) -> Result<(), AuthorityError> {
    if let Some(output) = &state.output {
        let output = output.lock().map_err(|_| unavailable())?;
        if scope.intersects(&output)? {
            return Err(overlap());
        }
    }
    Ok(())
}
impl AuthorityContext {
    /// The native binder may run after OPEN_LOCK release; it must still name
    /// this original published incarnation, never recapture a same-path reopen.
    pub(crate) fn with_published_legacy_attempt<T>(
        &self,
        attempt: &OpeningAttempt,
        root: &Path,
        operation: impl FnOnce() -> T,
    ) -> Result<T, AuthorityError> {
        let root = canonical_root(root)?;
        let active = self.active.lock().map_err(|_| unavailable())?;
        if !Arc::ptr_eq(&self.active, &attempt.active)
            || active.generation != attempt.generation()
            || active.root.as_ref() != Some(&root)
            || attempt.root() != root
            || attempt.request.selected.is_some()
            || !active
                .openings
                .prior
                .as_ref()
                .is_some_and(|(published, _)| Arc::ptr_eq(published, &attempt.request))
            || resolve_with(self, &root)?.is_some()
        {
            return Err(changed());
        }
        if let Some((_, published_scope)) = &active.openings.prior {
            published_scope.validate()?;
        }
        Ok(operation())
    }

    /// P1 traversal occurs outside ActiveRoot; only bounded anchors and the current
    /// output footprint are compared within it. Admission precedes agents.begin_open.
    pub(crate) fn request_open(&self, root: &Path) -> Result<OpeningAttempt, AuthorityError> {
        let (scope, selected, inspection) = observe(self, root)?;
        #[cfg(test)]
        request_observed();
        let mut active = self.active.lock().map_err(|_| unavailable())?;
        revalidate_fresh(inspection.as_ref())?;
        scope.validate()?;
        check_output(&active.openings, &scope)?;
        let generation = active.generation.checked_add(1).ok_or_else(unavailable)?;
        let request = Arc::new(RequestIdentity {
            generation,
            scope,
            selected,
        });
        active.generation = generation;
        active.root = None;
        active.openings.requested = Some(request.clone());
        Ok(OpeningAttempt {
            active: self.active.clone(),
            request,
        })
    }
    fn validate_attempt(
        &self,
        active: &ActiveRoot,
        attempt: &OpeningAttempt,
    ) -> Result<(), AuthorityError> {
        if !Arc::ptr_eq(&self.active, &attempt.active)
            || active.generation != attempt.generation()
            || !active
                .openings
                .requested
                .as_ref()
                .is_some_and(|r| Arc::ptr_eq(r, &attempt.request))
        {
            return Err(changed());
        }
        attempt.request.scope.validate()?;
        if resolve_with(self, attempt.root())? != attempt.request.selected {
            return Err(changed());
        }
        check_output(&active.openings, &attempt.request.scope)
    }
    /// Caller owns OPEN_LOCK, and has not performed watcher/recovery/service effects.
    pub(crate) fn enter_open(&self, attempt: &OpeningAttempt) -> Result<(), AuthorityError> {
        let (scope, selected, inspection) = observe(self, attempt.root())?;
        if selected != attempt.request.selected {
            return Err(changed());
        }
        let mut active = self.active.lock().map_err(|_| unavailable())?;
        revalidate_fresh(inspection.as_ref())?;
        self.validate_attempt(&active, attempt)?;
        scope.validate()?;
        check_output(&active.openings, &scope)?;
        if active.openings.entered.is_some() {
            return Err(unavailable());
        }
        active.openings.entered = Some((attempt.request.clone(), scope));
        Ok(())
    }
    /// Bind synchronously in audited ActiveRoot -> observed -> connector/listener order.
    /// Do not call with SQLite/ledger/native-owner/listener locks already held.
    pub(crate) fn publish_attempt_with<T>(
        &self,
        attempt: &OpeningAttempt,
        bind: impl FnOnce() -> Result<T, AuthorityError>,
    ) -> Result<T, AuthorityError> {
        let (scope, selected, inspection) = observe(self, attempt.root())?;
        if selected != attempt.request.selected {
            return Err(changed());
        }
        let mut active = self.active.lock().map_err(|_| unavailable())?;
        revalidate_fresh(inspection.as_ref())?;
        self.validate_attempt(&active, attempt)?;
        if !active
            .openings
            .entered
            .as_ref()
            .is_some_and(|(r, _)| Arc::ptr_eq(r, &attempt.request))
        {
            return Err(changed());
        }
        scope.validate()?;
        check_output(&active.openings, &scope)?;
        let result = bind()?;
        active.root = Some(attempt.root().to_path_buf());
        active.openings.prior = Some((attempt.request.clone(), scope));
        active.openings.requested = None;
        active.openings.entered = None;
        Ok(result)
    }
    /// Invoke only AFTER all opening cleanup succeeds. Failure/unwind otherwise
    /// leaves entered denial in place; it cannot erase a newer queued request.
    pub(crate) fn abandon_open(&self, attempt: &OpeningAttempt) -> Result<(), AuthorityError> {
        if !Arc::ptr_eq(&self.active, &attempt.active) {
            return Err(changed());
        }
        let mut active = self.active.lock().map_err(|_| unavailable())?;
        if active
            .openings
            .requested
            .as_ref()
            .is_some_and(|r| Arc::ptr_eq(r, &attempt.request))
        {
            active.openings.requested = None;
        }
        if active
            .openings
            .entered
            .as_ref()
            .is_some_and(|(r, _)| Arc::ptr_eq(r, &attempt.request))
        {
            active.openings.entered = None;
        }
        Ok(())
    }
    /// No source WorkspaceLock/SQLite/ledger may exist yet. Native coordinator
    /// supplies its source/input/window recheck in admit, under this SAME gate.
    /// The callback must be passive and must never reenter ActiveRoot.
    #[cfg(unix)]
    pub(crate) fn reserve_output<T>(
        &self,
        choice: NewDirectoryChoice,
        separate: &[PathBuf],
        admit: impl FnOnce() -> Result<T, AuthorityError>,
    ) -> Result<(OutputReservation, T), AuthorityError> {
        self.reserve_output_with(choice, separate, |_| admit())
    }
    #[cfg(unix)]
    fn reserve_output_with<T>(
        &self,
        choice: NewDirectoryChoice,
        separate: &[PathBuf],
        admit: impl FnOnce(&ActiveRoot) -> Result<T, AuthorityError>,
    ) -> Result<(OutputReservation, T), AuthorityError> {
        let path = choice.path().to_path_buf();
        // Capture a fresh bounded P1 snapshot for each protected opening without
        // holding ActiveRoot. The gate below accepts only those same identities.
        let requests = {
            let active = self.active.lock().map_err(|_| unavailable())?;
            if active.openings.output.is_some() {
                return Err(error(
                    AuthorityErrorKind::Busy,
                    "Another output is reserved.",
                ));
            }
            let mut requests: Vec<Arc<RequestIdentity>> = Vec::new();
            for request in active
                .openings
                .prior
                .iter()
                .map(|(request, _)| request)
                .chain(active.openings.requested.iter())
                .chain(active.openings.entered.iter().map(|(request, _)| request))
            {
                if !requests.iter().any(|old| Arc::ptr_eq(old, request)) {
                    requests.push(request.clone());
                }
            }
            requests
        };
        let observations = requests
            .into_iter()
            .map(|request| {
                let (scope, selected, inspection) = observe(self, &request.scope.root)?;
                if selected != request.selected {
                    return Err(changed());
                }
                Ok((request, scope, inspection))
            })
            .collect::<Result<Vec<_>, AuthorityError>>()?;
        super::super::native_admission::guard_external_write(self, &path)?;
        let mut active = self.active.lock().map_err(|_| unavailable())?;
        if active.openings.output.is_some() {
            return Err(error(
                AuthorityErrorKind::Busy,
                "Another output is reserved.",
            ));
        }
        choice.validate().map_err(|_| changed())?;
        // Recheck the existing external exclusion under the gate. This future
        // leaf is absent, so there is no output subtree walk inside the mutex.
        super::super::native_admission::guard_external_write(self, &path)?;
        let footprint = Footprint {
            path,
            parent: Scope::capture(choice.parent(), Vec::new())?,
            created: None,
            created_anchor: None,
            live: true,
        };
        footprint.validate()?;
        for (request, retained_scope) in active
            .openings
            .prior
            .iter()
            .map(|(request, scope)| (request, scope))
            .chain(
                active
                    .openings
                    .requested
                    .iter()
                    .map(|request| (request, &request.scope)),
            )
            .chain(
                active
                    .openings
                    .entered
                    .iter()
                    .map(|(request, scope)| (request, scope)),
            )
        {
            let (_, scope, inspection) = observations
                .iter()
                .find(|(observed, _, _)| Arc::ptr_eq(observed, request))
                .ok_or_else(changed)?;
            retained_scope.validate()?;
            revalidate_fresh(inspection.as_ref())?;
            if scope.intersects(&footprint)? {
                return Err(overlap());
            }
        }
        for source in separate {
            let source = boundary::target(source)?;
            if source.starts_with(&footprint.path) || footprint.path.starts_with(&source) {
                return Err(overlap());
            }
        }
        let admitted = admit(&active)?;
        let footprint = Arc::new(Mutex::new(footprint));
        active.openings.output = Some(footprint.clone());
        let display_location = choice.path().to_path_buf();
        let facts = Arc::new(crate::workspace_migration::backup::OutputFacts::new());
        Ok((
            OutputReservation {
                active: self.active.clone(),
                footprint,
                choice: Some(choice),
                facts,
                display_location,
            },
            admitted,
        ))
    }
}
struct Footprint {
    path: PathBuf,
    parent: Scope,
    created: Option<Identity>,
    // One read-only directory descriptor pins physical identity until the
    // original worker converts its passive observer into bounded terminal facts.
    created_anchor: Option<std::fs::File>,
    live: bool,
}
impl Footprint {
    fn validate(&self) -> Result<(), AuthorityError> {
        if !self.live {
            return Err(unavailable());
        }
        self.parent.validate()?;
        match self.created {
            Some(identity) if Identity::at(&self.path)? == identity => Ok(()),
            Some(_) => Err(changed()),
            None => match fs::symlink_metadata(&self.path) {
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                _ => Err(changed()),
            },
        }
    }
}
/// Outer lifetime owner. Keep this outside the inner scope containing Source,
/// SQLite, ledger and writers. No pending timeout/window event owns this value.
#[cfg(unix)]
pub(crate) struct OutputReservation {
    active: Arc<Mutex<ActiveRoot>>,
    footprint: Arc<Mutex<Footprint>>,
    choice: Option<NewDirectoryChoice>,
    facts: Arc<crate::workspace_migration::backup::OutputFacts>,
    display_location: PathBuf,
}
#[cfg(unix)]
impl OutputReservation {
    /// Footprint only: never takes ActiveRoot under a source/storage lock.
    /// Held parent reaches the real mkdir; created identity is installed before
    /// any child content is writable and while opener checks cannot interleave.
    pub(crate) fn path(&self) -> Result<PathBuf, AuthorityError> {
        let footprint = self.footprint.lock().map_err(|_| unavailable())?;
        footprint.validate()?;
        Ok(footprint.path.clone())
    }
    pub(crate) fn create_root(&mut self) -> Result<OutputDirectory, AuthorityError> {
        let mut footprint = self.footprint.lock().map_err(|_| unavailable())?;
        footprint.validate()?;
        let choice = self.choice.take().ok_or_else(changed)?;
        let output = choice.create_observed(&self.facts).map_err(|_| changed())?;
        if output.path() != footprint.path.as_path() {
            return Err(changed());
        }
        let (device, inode) = output.held_identity().map_err(|_| changed())?;
        footprint.created = Some(Identity { device, inode });
        // Descriptor duplication is optional evidence, never a copy/identity
        // fallback. Without it, later passive location stays unverified.
        footprint.created_anchor = output.passive_directory().ok();
        footprint.validate()?;
        Ok(output)
    }
    pub(crate) fn progress(&self) -> OutputProgress {
        OutputProgress {
            facts: self.facts.clone(),
            footprint: self.footprint.clone(),
            display_location: self.display_location.clone(),
        }
    }
    pub(crate) fn publication_attempted(&self) {
        self.facts.publication_attempted();
    }
    pub(crate) fn published(&self) {
        self.facts.published();
    }
    /// At final manifest/marker publication. Caller also validates held Root.
    pub(crate) fn validate(&self) -> Result<(), AuthorityError> {
        self.footprint.lock().map_err(|_| unavailable())?.validate()
    }
}
#[cfg(unix)]
impl Drop for OutputReservation {
    fn drop(&mut self) {
        // Explicit outer owner: workers must close all copy resources first.
        // Poison remains closed; never recover an unknown state for new work.
        if let Ok(mut active) = self.active.lock() {
            if active
                .openings
                .output
                .as_ref()
                .is_some_and(|r| Arc::ptr_eq(r, &self.footprint))
            {
                if let Ok(mut footprint) = self.footprint.lock() {
                    footprint.live = false;
                    active.openings.output = None;
                }
            }
        }
    }
}

/// Passive factual observer only; never retains ActiveRoot or lease liveness.
#[cfg(unix)]
pub(crate) struct OutputProgress {
    facts: Arc<crate::workspace_migration::backup::OutputFacts>,
    footprint: Arc<Mutex<Footprint>>,
    display_location: PathBuf,
}
#[cfg(unix)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum OutputLocation {
    Verified,
    OriginalSpellingOnly,
    Unavailable,
}
#[cfg(unix)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct OutputObservation {
    pub phase: crate::workspace_migration::backup::OutputPhase,
    pub display_location: PathBuf,
    pub location: OutputLocation,
}
#[cfg(unix)]
impl OutputProgress {
    pub(crate) fn snapshot(&self) -> OutputObservation {
        use std::os::unix::fs::MetadataExt as _;
        let phase = self.facts.phase();
        // Passive inspection deliberately ignores live: it cannot revive a
        // lease. A retained descriptor prevents dev/inode reuse after the writer
        // Root closes; no database path/descriptor is opened by this observer.
        let location = match self.footprint.lock() {
            Err(_) => OutputLocation::Unavailable,
            Ok(footprint) => match (footprint.created, footprint.created_anchor.as_ref()) {
                (Some(identity), Some(directory)) => match directory.metadata() {
                    Err(_) => OutputLocation::Unavailable,
                    Ok(metadata)
                        if !metadata.is_dir()
                            || metadata.dev() != identity.device
                            || metadata.ino() != identity.inode =>
                    {
                        OutputLocation::Unavailable
                    }
                    Ok(_) => {
                        if footprint.parent.validate().is_ok()
                            && Identity::at(&footprint.path)
                                .is_ok_and(|current| current == identity)
                        {
                            OutputLocation::Verified
                        } else {
                            OutputLocation::OriginalSpellingOnly
                        }
                    }
                },
                _ => OutputLocation::OriginalSpellingOnly,
            },
        };
        OutputObservation {
            phase,
            display_location: self.display_location.clone(),
            location,
        }
    }
}

/// Captured only from the exact published selected incarnation; no SQLite handle.
#[cfg(unix)]
pub(crate) struct SelectedBackupOpening {
    active: Arc<Mutex<ActiveRoot>>,
    opening: Arc<RequestIdentity>,
    expected: AdmittedBackupRead,
}
#[cfg(unix)]
impl SelectedBackupOpening {
    pub(in crate::workspace_service) fn root(&self) -> &Path {
        &self.expected.binding.root
    }
}
/// Original source expectation consumed by the existing Source reader after gate
/// admission. An unrelated later selection cannot retarget these physical objects.
#[cfg(unix)]
pub(crate) struct AdmittedBackupRead {
    binding: SelectedBinding,
    bodies: Scope,
    metadata: Scope,
    database: (u64, u64),
}
#[cfg(unix)]
fn database_identity(path: &Path) -> Result<(u64, u64), AuthorityError> {
    use std::os::unix::fs::MetadataExt;
    let meta = fs::symlink_metadata(path).map_err(|_| changed())?;
    if !meta.is_file() || meta.file_type().is_symlink() || meta.nlink() != 1 {
        return Err(changed());
    }
    Ok((meta.dev(), meta.ino()))
}
#[cfg(unix)]
impl AdmittedBackupRead {
    pub(crate) fn root(&self) -> &Path {
        &self.binding.root
    }
    pub(in crate::workspace_service) fn validate_binding(
        &self,
        binding: &SelectedBinding,
    ) -> Result<(), AuthorityError> {
        if binding != &self.binding {
            return Err(changed());
        }
        self.bodies.validate()?;
        self.metadata.validate()
    }
    /// Compare the already owned SQLite pin. Never open a second database FD.
    pub(crate) fn validate_database(&self, identity: (u64, u64)) -> Result<(), AuthorityError> {
        if identity != self.database {
            return Err(changed());
        }
        Ok(())
    }
}
#[cfg(unix)]
impl AuthorityContext {
    pub(crate) fn capture_selected_backup_opening(
        &self,
        selector: &Path,
    ) -> Result<SelectedBackupOpening, AuthorityError> {
        let selector = canonical_root(selector)?;
        let active = self.active.lock().map_err(|_| unavailable())?;
        if active.root.as_ref() != Some(&selector) {
            return Err(changed());
        }
        let (opening, _) = active.openings.prior.as_ref().ok_or_else(changed)?;
        if active.generation != opening.generation {
            return Err(changed());
        }
        let binding = resolve_with(self, &selector)?.ok_or_else(|| {
            error(
                AuthorityErrorKind::UnsupportedOperation,
                "Portable backup requires a published selected workspace.",
            )
        })?;
        if opening.selected.as_ref() != Some(&binding) {
            return Err(changed());
        }
        opening.scope.validate()?;
        let expected = AdmittedBackupRead {
            bodies: Scope::capture(&binding.root, Vec::new())?,
            metadata: Scope::capture(binding.database.parent().ok_or_else(changed)?, Vec::new())?,
            database: database_identity(&binding.database)?,
            binding,
        };
        Ok(SelectedBackupOpening {
            active: self.active.clone(),
            opening: opening.clone(),
            expected,
        })
    }
    fn check_selected_ticket(
        &self,
        ticket: &SelectedBackupOpening,
        active: &ActiveRoot,
    ) -> Result<(), AuthorityError> {
        if !Arc::ptr_eq(&self.active, &ticket.active)
            || active.generation != ticket.opening.generation
            || active.root.as_ref() != Some(&ticket.expected.binding.root)
            || !active
                .openings
                .prior
                .as_ref()
                .is_some_and(|(opening, _)| Arc::ptr_eq(opening, &ticket.opening))
        {
            return Err(changed());
        }
        let current = resolve_with(self, &ticket.expected.binding.root)?.ok_or_else(changed)?;
        ticket.expected.validate_binding(&current)?;
        ticket
            .expected
            .validate_database(database_identity(&current.database)?)
    }
    pub(in crate::workspace_service) fn validate_selected_backup_opening(
        &self,
        ticket: &SelectedBackupOpening,
    ) -> Result<(), AuthorityError> {
        let active = self.active.lock().map_err(|_| unavailable())?;
        self.check_selected_ticket(ticket, &active)
    }
    pub(crate) fn reserve_selected_output(
        &self,
        ticket: SelectedBackupOpening,
        choice: NewDirectoryChoice,
        window_live: impl FnOnce() -> Result<(), AuthorityError>,
    ) -> Result<(OutputReservation, AdmittedBackupRead), AuthorityError> {
        let separate = [
            ticket.expected.binding.root.clone(),
            ticket.expected.metadata.root.clone(),
        ];
        self.reserve_output_with(choice, &separate, |active| {
            self.check_selected_ticket(&ticket, active)?;
            window_live()?;
            Ok(ticket.expected)
        })
    }
}

#[cfg(all(test, unix))]
#[path = "opening_tests.rs"]
mod tests;
