//! Trusted local path/UUID bindings. No registration or activation writer.
use super::types::{selected::*, StoreErrorCode};
use crate::workspace_migration::format_gate::{self, FORMAT_MARKER};
use serde::Deserialize;
use std::{
    collections::BTreeSet,
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Limits {
    pub registry_bytes: u64,
    pub registry_bindings: usize,
    pub marker_bytes: u64,
    pub body_bytes: u64,
    pub database_bytes: u64,
    pub records: usize,
    pub aggregate_metadata_bytes: usize,
    pub aggregate_body_bytes: usize,
    pub path_bytes: usize,
    pub path_components: usize,
    pub retained_carrier_bytes: u64,
    pub retained_entries: usize,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Rules {
    pub format: u32,
    pub authority: String,
    pub binding_version: u32,
    pub schema_version: i64,
    pub limits: Limits,
    pub boundary_limits: super::boundary::Limits,
}
pub(super) fn rules() -> &'static Rules {
    static RULES: OnceLock<Rules> = OnceLock::new();
    RULES.get_or_init(|| {
        serde_json::from_str(include_str!("../../../shared/workspace/authority.v2.json"))
            .expect("selected authority rules")
    })
}
pub(super) fn error(kind: AuthorityErrorKind, message: impl Into<String>) -> AuthorityError {
    AuthorityError {
        code: StoreErrorCode::CapabilityUnavailable,
        kind,
        message: message.into(),
        retryable: false,
    }
}
#[derive(Clone)]
pub(crate) struct AuthorityContext {
    pub(super) origin: PathBuf,
    active: Arc<Mutex<ActiveRoot>>,
    // Never evict a denial identity: exhaustion refuses new selected admission.
    observed: Arc<Mutex<Vec<SelectedBinding>>>,
}
#[path = "opening.rs"]
mod opening;
pub(crate) use opening::OpeningAttempt;
#[cfg(unix)]
pub(crate) use opening::{AdmittedBackupRead, OutputReservation, SelectedBackupOpening};
#[cfg(unix)]
#[cfg_attr(
    not(any(test, target_os = "macos")),
    expect(
        unused_imports,
        reason = "only the macOS backup dialog (backup_native.rs) reads OutputLocation"
    )
)]
pub(crate) use opening::{OutputLocation, OutputObservation, OutputProgress};
#[derive(Default)]
struct ActiveRoot {
    generation: u64,
    root: Option<PathBuf>,
    openings: opening::OpeningState,
}
/// Opaque lease for this context's exact already-published legacy opening.
/// A path or a numeric generation cannot construct one.
pub(crate) struct LegacyOpeningTicket {
    active: Arc<Mutex<ActiveRoot>>,
    root: PathBuf,
    generation: u64,
}
impl LegacyOpeningTicket {
    /// Comparison only; successful access still requires with_legacy_opening.
    pub(crate) fn same_as(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.active, &other.active)
            && self.generation == other.generation
            && self.root == other.root
    }
}
impl AuthorityContext {
    /// Observe the root and its exact opening generation under one active lock.
    /// active_root alone cannot be paired with a later capture without a race.
    pub(crate) fn capture_current_legacy_opening(
        &self,
    ) -> Result<(PathBuf, LegacyOpeningTicket), AuthorityError> {
        let active = self.active.lock().map_err(|_| {
            error(
                AuthorityErrorKind::ContextUnavailable,
                "Active workspace state is unavailable.",
            )
        })?;
        let published = active.root.as_ref().ok_or_else(|| {
            error(
                AuthorityErrorKind::ContextUnavailable,
                "No workspace opening is available.",
            )
        })?;
        let root = canonical_root(published)?;
        if &root != published || resolve_with(self, &root)?.is_some() {
            return Err(error(
                AuthorityErrorKind::SourceChanged,
                "This legacy workspace opening is unavailable.",
            ));
        }
        let ticket = LegacyOpeningTicket {
            active: self.active.clone(),
            root: root.clone(),
            generation: active.generation,
        };
        Ok((root, ticket))
    }
    pub(crate) fn capture_legacy_opening(
        &self,
        root: &Path,
    ) -> Result<LegacyOpeningTicket, AuthorityError> {
        let root = canonical_root(root)?;
        let active = self.active.lock().map_err(|_| {
            error(
                AuthorityErrorKind::ContextUnavailable,
                "Active workspace state is unavailable.",
            )
        })?;
        if active.root.as_ref() != Some(&root) || resolve_with(self, &root)?.is_some() {
            return Err(error(
                AuthorityErrorKind::SourceChanged,
                "This legacy workspace opening is unavailable.",
            ));
        }
        Ok(LegacyOpeningTicket {
            active: self.active.clone(),
            root,
            generation: active.generation,
        })
    }
    /// Order: ActiveRoot, observed identity, native owner, SQLite. Never enter
    /// with a listener/agent/native-owner lock or from publish_open_with.
    pub(crate) fn with_legacy_opening<T>(
        &self,
        ticket: &LegacyOpeningTicket,
        operation: impl FnOnce() -> T,
    ) -> Result<T, AuthorityError> {
        if !Arc::ptr_eq(&self.active, &ticket.active) {
            return Err(error(
                AuthorityErrorKind::WrongIdentity,
                "This workspace opening belongs to another context.",
            ));
        }
        let active = self.active.lock().map_err(|_| {
            error(
                AuthorityErrorKind::ContextUnavailable,
                "Active workspace state is unavailable.",
            )
        })?;
        if active.generation != ticket.generation
            || active.root.as_ref() != Some(&ticket.root)
            || resolve_with(self, &ticket.root)?.is_some()
        {
            return Err(error(
                AuthorityErrorKind::SourceChanged,
                "This legacy workspace opening was superseded.",
            ));
        }
        Ok(operation())
    }
    // These identities can only deny disappearance/rebinding; successful access
    // always resolves the current registry, marker and store independently.
    fn validate_observed(
        &self,
        root: &Path,
        current: Option<&SelectedBinding>,
    ) -> Result<(), AuthorityError> {
        let known = self.observed.lock().map_err(|_| {
            error(
                AuthorityErrorKind::ContextUnavailable,
                "Observed workspace identity is unavailable.",
            )
        })?;
        if let Some(observed) = known.iter().find(|binding| binding.root == root) {
            match current {
                Some(current) if current == observed => {}
                Some(_) => {
                    return Err(error(
                        AuthorityErrorKind::WrongIdentity,
                        "An observed selected workspace binding changed identity.",
                    ))
                }
                None => {
                    return Err(error(
                        AuthorityErrorKind::BindingUnavailable,
                        "An observed selected workspace binding disappeared.",
                    ))
                }
            }
        }
        Ok(())
    }
    fn observe(&self, binding: &SelectedBinding) -> Result<(), AuthorityError> {
        let mut known = self.observed.lock().map_err(|_| {
            error(
                AuthorityErrorKind::ContextUnavailable,
                "Observed workspace identity is unavailable.",
            )
        })?;
        if let Some(observed) = known.iter().find(|prior| prior.root == binding.root) {
            if observed != binding {
                return Err(error(
                    AuthorityErrorKind::WrongIdentity,
                    "An observed selected workspace binding changed identity.",
                ));
            }
            return Ok(());
        }
        if known.len() >= rules().limits.registry_bindings {
            return Err(error(
                AuthorityErrorKind::SourceLimit,
                "Observed workspace identities exceed their bound.",
            ));
        }
        known.push(binding.clone());
        Ok(())
    }
    pub(super) fn observed_roots(&self) -> Result<Vec<PathBuf>, AuthorityError> {
        self.observed
            .lock()
            .map(|known| known.iter().map(|binding| binding.root.clone()).collect())
            .map_err(|_| {
                error(
                    AuthorityErrorKind::ContextUnavailable,
                    "Observed workspace identity is unavailable.",
                )
            })
    }
    #[cfg(test)]
    pub(crate) fn begin_open(&self) -> Result<u64, AuthorityError> {
        let mut active = self.active.lock().map_err(|_| {
            error(
                AuthorityErrorKind::ContextUnavailable,
                "Active workspace state is unavailable.",
            )
        })?;
        active.root = None;
        active.generation = active.generation.checked_add(1).ok_or_else(|| {
            error(
                AuthorityErrorKind::ContextUnavailable,
                "Workspace opening generation is exhausted.",
            )
        })?;
        Ok(active.generation)
    }
    #[cfg(test)]
    pub(crate) fn publish_open(&self, generation: u64, root: &Path) -> Result<(), AuthorityError> {
        self.publish_open_with(generation, root, || {})
    }
    /// The synchronous late binding completes before another opening can begin.
    /// Audited order: ActiveRoot -> separate observed identity -> connector setup
    /// -> listener state. The callback must never reacquire ActiveRoot, enter with
    /// a retained listener lock, spawn deferred binding work, or wait for a task
    /// that needs this gate. The actual client callback follows this order.
    #[cfg(test)]
    pub(crate) fn publish_open_with(
        &self,
        generation: u64,
        root: &Path,
        bind: impl FnOnce(),
    ) -> Result<(), AuthorityError> {
        if resolve_with(self, root)?.is_none() {
            // Inspect before ActiveRoot: no recursive I/O under the publication mutex.
            super::boundary::guard(self, root, true)?;
        }
        let root = canonical_root(root)?;
        let mut active = self.active.lock().map_err(|_| {
            error(
                AuthorityErrorKind::ContextUnavailable,
                "Active workspace state is unavailable.",
            )
        })?;
        if active.generation != generation {
            return Err(error(
                AuthorityErrorKind::SourceChanged,
                "This workspace opening was superseded.",
            ));
        }
        active.root = Some(root);
        bind();
        Ok(())
    }
    pub(crate) fn active_root(&self) -> Result<Option<PathBuf>, AuthorityError> {
        self.active
            .lock()
            .map(|state| state.root.clone())
            .map_err(|_| {
                error(
                    AuthorityErrorKind::ContextUnavailable,
                    "Active workspace state is unavailable.",
                )
            })
    }
    pub(crate) fn new(origin: PathBuf) -> Self {
        Self {
            origin: fs::canonicalize(&origin).unwrap_or(origin),
            active: Arc::new(Mutex::new(ActiveRoot::default())),
            observed: Arc::new(Mutex::new(Vec::new())),
        }
    }
}
fn installed() -> &'static OnceLock<AuthorityContext> {
    static CONTEXT: OnceLock<AuthorityContext> = OnceLock::new();
    &CONTEXT
}
pub(crate) fn install(origin: PathBuf) -> Result<(), AuthorityError> {
    if !origin.is_absolute() {
        return Err(error(
            AuthorityErrorKind::ContextUnavailable,
            "Workspace storage origin is unavailable.",
        ));
    }
    installed().set(AuthorityContext::new(origin)).map_err(|_| {
        error(
            AuthorityErrorKind::ContextUnavailable,
            "Workspace storage context was already installed.",
        )
    })
}
#[cfg(test)]
thread_local! {static FIXTURE_CONTEXT:std::cell::RefCell<Option<AuthorityContext>>=const {std::cell::RefCell::new(None)};}
pub(crate) fn context() -> Result<AuthorityContext, AuthorityError> {
    #[cfg(test)]
    if let Some(context) = FIXTURE_CONTEXT.with(|slot| slot.borrow().clone()) {
        return Ok(context);
    }
    installed().get().cloned().ok_or_else(|| {
        error(
            AuthorityErrorKind::ContextUnavailable,
            "Workspace storage context is unavailable.",
        )
    })
}
#[cfg(test)]
pub(crate) fn with_fixture_context<T>(context: AuthorityContext, run: impl FnOnce() -> T) -> T {
    struct Reset(Option<AuthorityContext>);
    impl Drop for Reset {
        fn drop(&mut self) {
            FIXTURE_CONTEXT.with(|slot| {
                *slot.borrow_mut() = self.0.take();
            });
        }
    }
    let old = FIXTURE_CONTEXT.with(|slot| slot.replace(Some(context)));
    let _reset = Reset(old);
    run()
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct SelectedBinding {
    pub root: PathBuf,
    pub database: PathBuf,
    pub workspace_id: String,
    pub origin: PathBuf,
}
#[derive(Debug)]
pub(crate) enum Authority {
    Legacy,
    Selected,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Registry {
    version: u32,
    bindings: Vec<Registration>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Registration {
    workspace_id: String,
    body_root: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ActivatedMarker {
    format: u32,
    authority: String,
    state: String,
    workspace_id: String,
}
pub(super) fn uuid_valid(value: &str) -> bool {
    crate::workspace_migration::identity::is_uuid_v4(value)
}
pub(super) fn canonical_root(root: &Path) -> Result<PathBuf, AuthorityError> {
    let root = fs::canonicalize(root).map_err(|_| {
        error(
            AuthorityErrorKind::BindingUnavailable,
            "Workspace folder is unavailable.",
        )
    })?;
    if !root.is_dir() {
        return Err(error(
            AuthorityErrorKind::BindingUnavailable,
            "Workspace folder is unavailable.",
        ));
    }
    Ok(root)
}
fn optional_file(root: &Path, rel: &str, cap: u64) -> Result<Option<Vec<u8>>, AuthorityError> {
    let mut current = root.to_path_buf();
    match fs::symlink_metadata(&current) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => {}
        _ => {
            return Err(error(
                AuthorityErrorKind::BindingUnavailable,
                "Workspace storage path is unavailable.",
            ))
        }
    }
    for component in Path::new(rel).components() {
        current.push(component);
        match fs::symlink_metadata(&current) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Ok(meta) if !meta.file_type().is_symlink() => {}
            _ => {
                return Err(error(
                    AuthorityErrorKind::InvalidBinding,
                    "Workspace authority path is invalid.",
                ))
            }
        }
    }
    Ok(Some(read_bounded(root, rel, cap)?))
}
pub(super) fn read_bounded(root: &Path, rel: &str, cap: u64) -> Result<Vec<u8>, AuthorityError> {
    let root = canonical_root(root)?;
    let opened = crate::files::bytes::open_in(&root, "selected-authority", rel).map_err(|_| {
        error(
            AuthorityErrorKind::BindingUnavailable,
            "Required workspace data is unavailable.",
        )
    })?;
    if opened.path != root.join(rel) {
        return Err(error(
            AuthorityErrorKind::InvalidBinding,
            "Workspace authority cannot follow a symlink.",
        ));
    }
    let mut file = opened.file;
    let before = file.metadata().map_err(|_| {
        error(
            AuthorityErrorKind::BindingUnavailable,
            "Required workspace data is unavailable.",
        )
    })?;
    if !before.is_file() || before.len() > cap {
        return Err(error(
            AuthorityErrorKind::SourceLimit,
            "Required workspace data exceeds its byte bound.",
        ));
    }
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(cap + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| {
            error(
                AuthorityErrorKind::BindingUnavailable,
                "Required workspace data is unavailable.",
            )
        })?;
    let after = file.metadata().map_err(|_| {
        error(
            AuthorityErrorKind::BindingUnavailable,
            "Required workspace data is unavailable.",
        )
    })?;
    if bytes.len() as u64 > cap {
        return Err(error(
            AuthorityErrorKind::SourceLimit,
            "Required workspace data exceeds its byte bound.",
        ));
    }
    if before.len() != after.len()
        || before.modified().ok() != after.modified().ok()
        || after.len() != bytes.len() as u64
    {
        return Err(error(
            AuthorityErrorKind::SourceChanged,
            "Required workspace data changed during its read.",
        ));
    }
    Ok(bytes)
}
pub(super) fn registrations(
    context: &AuthorityContext,
) -> Result<Vec<SelectedBinding>, AuthorityError> {
    let Some(bytes) = optional_file(
        &context.origin,
        "workspaces/bindings.v1.json",
        rules().limits.registry_bytes,
    )?
    else {
        return Ok(Vec::new());
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::symlink_metadata(context.origin.join("workspaces/bindings.v1.json"))
            .map_err(|_| {
                error(
                    AuthorityErrorKind::BindingUnavailable,
                    "Workspace bindings are unavailable.",
                )
            })?
            .permissions()
            .mode();
        if mode & 0o077 != 0 {
            return Err(error(
                AuthorityErrorKind::InvalidBinding,
                "Workspace bindings must be private.",
            ));
        }
    }
    let registry: Registry = serde_json::from_slice(&bytes).map_err(|_| {
        error(
            AuthorityErrorKind::InvalidBinding,
            "Workspace bindings are malformed.",
        )
    })?;
    if registry.version != rules().binding_version
        || registry.bindings.len() > rules().limits.registry_bindings
    {
        return Err(error(
            AuthorityErrorKind::InvalidBinding,
            "Workspace binding version or count is unsupported.",
        ));
    }
    let mut ids = BTreeSet::new();
    let mut roots: BTreeSet<PathBuf> = BTreeSet::new();
    let mut out = Vec::new();
    for registered in registry.bindings {
        let path = Path::new(&registered.body_root);
        if !uuid_valid(&registered.workspace_id)
            || !path.is_absolute()
            || registered.body_root.len() > rules().limits.path_bytes
            || path.components().count() > rules().limits.path_components
            || path.components().any(|c| {
                matches!(
                    c,
                    std::path::Component::ParentDir | std::path::Component::CurDir
                )
            })
        {
            return Err(error(
                AuthorityErrorKind::InvalidBinding,
                "Workspace binding identity or path is invalid.",
            ));
        }
        let root = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
        if roots
            .iter()
            .any(|prior| root.starts_with(prior) || prior.starts_with(&root))
        {
            return Err(error(
                AuthorityErrorKind::InvalidBinding,
                "Selected workspace body roots may not overlap.",
            ));
        }
        if !ids.insert(registered.workspace_id.clone()) || !roots.insert(root.clone()) {
            return Err(error(
                AuthorityErrorKind::InvalidBinding,
                "Workspace bindings contain duplicate identities.",
            ));
        }
        let database = context
            .origin
            .join("workspaces")
            .join(&registered.workspace_id)
            .join("workspace.db");
        if root.starts_with(&context.origin) || context.origin.starts_with(&root) {
            return Err(error(
                AuthorityErrorKind::InvalidBinding,
                "Workspace body and metadata roots must be separate.",
            ));
        }
        out.push(SelectedBinding {
            root,
            database,
            workspace_id: registered.workspace_id,
            origin: context.origin.clone(),
        });
    }
    Ok(out)
}
pub(super) fn legacy_marker(root: &Path) -> Result<(), AuthorityError> {
    format_gate::guard_legacy_access(root).map_err(|e| {
        error(
            match e.kind {
                "unsupported_format" => AuthorityErrorKind::UnsupportedFormat,
                "inactive_workspace" | "selected_authority_required" => {
                    AuthorityErrorKind::InactiveWorkspace
                }
                _ => AuthorityErrorKind::InvalidFormat,
            },
            e.message,
        )
    })
}
pub(super) fn resolve_with(
    context: &AuthorityContext,
    root: &Path,
) -> Result<Option<SelectedBinding>, AuthorityError> {
    let root = canonical_root(root)?;
    let binding = registrations(context)?
        .into_iter()
        .find(|binding| binding.root == root);
    context.validate_observed(&root, binding.as_ref())?;
    let bytes = optional_file(&root, FORMAT_MARKER, rules().limits.marker_bytes)
        .map_err(|e| error(AuthorityErrorKind::InvalidFormat, e.message))?;
    let Some(bytes) = bytes else {
        if binding.is_some() {
            return Err(error(
                AuthorityErrorKind::MissingMarker,
                "A registered workspace is missing its authority marker.",
            ));
        }
        legacy_marker(&root)?;
        return Ok(None);
    };
    #[derive(Deserialize)]
    struct Header {
        format: u32,
    }
    let header: Header = serde_json::from_slice(&bytes).map_err(|_| {
        error(
            AuthorityErrorKind::InvalidFormat,
            "Workspace format marker is malformed.",
        )
    })?;
    if header.format != rules().format {
        legacy_marker(&root)?;
        return Err(error(
            AuthorityErrorKind::UnsupportedFormat,
            "Workspace format is unsupported.",
        ));
    }
    let value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| {
        error(
            AuthorityErrorKind::InvalidFormat,
            "Workspace format marker is malformed.",
        )
    })?;
    if matches!(
        value.get("state").and_then(|v| v.as_str()),
        Some("preparing" | "staged_inactive")
    ) {
        return Err(error(
            AuthorityErrorKind::InactiveWorkspace,
            "Selected workspace is not activated.",
        ));
    }
    let marker: ActivatedMarker = serde_json::from_slice(&bytes).map_err(|_| {
        error(
            AuthorityErrorKind::InvalidFormat,
            "Activated workspace marker is malformed.",
        )
    })?;
    if marker.format != rules().format
        || marker.authority != rules().authority
        || marker.state != "activated"
        || !uuid_valid(&marker.workspace_id)
    {
        return Err(error(
            AuthorityErrorKind::InvalidFormat,
            "Activated workspace marker is invalid.",
        ));
    }
    let binding = binding.ok_or_else(|| {
        error(
            AuthorityErrorKind::UnboundWorkspace,
            "Workspace has no trusted local binding.",
        )
    })?;
    if marker.workspace_id != binding.workspace_id {
        return Err(error(
            AuthorityErrorKind::WrongIdentity,
            "Workspace marker disagrees with its trusted binding.",
        ));
    }
    context.observe(&binding)?;
    Ok(Some(binding))
}
pub(super) fn selected_binding(root: &Path) -> Result<SelectedBinding, AuthorityError> {
    resolve_with(&context()?, root)?.ok_or_else(|| {
        error(
            AuthorityErrorKind::UnsupportedOperation,
            "This operation requires selected metadata authority.",
        )
    })
}
pub(crate) fn resolve(root: &Path) -> Result<Authority, AuthorityError> {
    let context = match context() {
        Ok(context) => context,
        Err(error) => {
            #[cfg(test)]
            {
                let _ = error;
                legacy_marker(&canonical_root(root)?)?;
                return Ok(Authority::Legacy);
            }
            #[cfg(not(test))]
            {
                return Err(error);
            }
        }
    };
    Ok(if resolve_with(&context, root)?.is_some() {
        Authority::Selected
    } else {
        Authority::Legacy
    })
}
pub(crate) fn guard_legacy(root: &Path) -> Result<(), AuthorityError> {
    match resolve(root)? {
        Authority::Legacy => Ok(()),
        Authority::Selected => Err(error(
            AuthorityErrorKind::UnsupportedOperation,
            "This operation is not supported for selected metadata workspaces.",
        )),
    }
}
