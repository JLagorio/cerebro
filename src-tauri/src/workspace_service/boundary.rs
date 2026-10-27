//! Deny-only inspection of actual legacy request scopes. Never an activation grant.
//! Raw marker reads stay below workspace-aware content readers to avoid recursion.
use super::{
    authority::{self, AuthorityContext},
    types::selected::*,
};
use serde::Deserialize;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Component, Path, PathBuf},
};

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Limits {
    pub entries: usize,
    pub depth: usize,
    pub path_bytes: usize,
    pub marker_bytes: u64,
    pub single_marker_bytes: u64,
}
pub(crate) fn limits() -> Limits {
    authority::rules().boundary_limits
}
fn failure(kind: AuthorityErrorKind, words: &str) -> AuthorityError {
    authority::error(kind, words)
}
fn unavailable() -> AuthorityError {
    failure(
        AuthorityErrorKind::BindingUnavailable,
        "The requested scope cannot be inspected safely.",
    )
}
fn changed() -> AuthorityError {
    failure(
        AuthorityErrorKind::SourceChanged,
        "The requested scope changed during inspection.",
    )
}
pub(crate) fn limit() -> AuthorityError {
    failure(
        AuthorityErrorKind::SourceLimit,
        "The requested scope exceeds the boundary inspection support limit.",
    )
}
fn invalid() -> AuthorityError {
    failure(
        AuthorityErrorKind::InvalidFormat,
        "A workspace boundary is unavailable or invalid.",
    )
}
fn unsupported() -> AuthorityError {
    failure(
        AuthorityErrorKind::UnsupportedOperation,
        "This scope intersects a selected workspace boundary.",
    )
}

/// Keep absolute request spelling, including parent steps, separate from its landing.
/// Relative requests keep their caller validation; never fold away a routed boundary.
pub(super) fn lexical(path: &Path) -> Result<PathBuf, AuthorityError> {
    if !path.is_absolute()
        || path.as_os_str().len() > authority::rules().limits.path_bytes
        || path.components().count() > authority::rules().limits.path_components
    {
        return Err(unavailable());
    }
    let mut normalized = PathBuf::new();
    for component in path.components() {
        if !matches!(component, Component::CurDir) {
            normalized.push(component.as_os_str());
        }
    }
    Ok(normalized)
}
/// Canonicalize the real ancestor of a future path without discarding request scope.
pub(super) fn target(path: &Path) -> Result<PathBuf, AuthorityError> {
    let normalized = lexical(path)?;
    let mut existing = normalized.as_path();
    let mut tail = Vec::new();
    loop {
        match fs::symlink_metadata(existing) {
            Ok(_) => break,
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
                ) =>
            {
                // A future leaf can be blocked by an ordinary file. Preserve
                // that suffix and inspect the real prefix; planning owns its
                // not-a-folder refusal, and the prefix identity is witnessed.
                tail.push(existing.file_name().ok_or_else(unavailable)?.to_owned());
                existing = existing.parent().ok_or_else(unavailable)?;
            }
            Err(_) => return Err(unavailable()),
        }
    }
    let mut actual = fs::canonicalize(existing).map_err(|_| unavailable())?;
    for component in tail.into_iter().rev() {
        actual.push(component);
    }
    if actual.as_os_str().len() > authority::rules().limits.path_bytes
        || actual.components().count() > authority::rules().limits.path_components
    {
        return Err(limit());
    }
    Ok(actual)
}
#[derive(Clone, Debug, PartialEq, Eq)]
struct Identity {
    #[cfg(unix)]
    dev: u64,
    #[cfg(unix)]
    ino: u64,
    kind: u8,
}
impl Identity {
    fn of(meta: &fs::Metadata) -> Self {
        #[cfg(unix)]
        use std::os::unix::fs::MetadataExt;
        Self {
            #[cfg(unix)]
            dev: meta.dev(),
            #[cfg(unix)]
            ino: meta.ino(),
            kind: if meta.file_type().is_symlink() {
                1
            } else if meta.is_dir() {
                2
            } else if meta.is_file() {
                3
            } else {
                4
            },
        }
    }
}
#[derive(Clone, Debug)]
struct Witness {
    path: PathBuf,
    identity: Identity,
    // Membership changes in traversed directories invalidate the snapshot.
    directory_modified: Option<std::time::SystemTime>,
    #[cfg(unix)]
    directory_ctime: Option<(i64, i64)>,
}
impl Witness {
    fn new(path: PathBuf, meta: &fs::Metadata, membership: bool) -> Self {
        #[cfg(unix)]
        use std::os::unix::fs::MetadataExt;
        Self {
            path,
            identity: Identity::of(meta),
            directory_modified: if membership {
                meta.modified().ok()
            } else {
                None
            },
            #[cfg(unix)]
            directory_ctime: membership.then_some((meta.ctime(), meta.ctime_nsec())),
        }
    }
    fn validate(&self) -> Result<(), AuthorityError> {
        let meta = fs::symlink_metadata(&self.path).map_err(|_| changed())?;
        let current = Self::new(self.path.clone(), &meta, self.directory_modified.is_some());
        if current.identity != self.identity
            || current.directory_modified != self.directory_modified
        {
            return Err(changed());
        }
        #[cfg(unix)]
        if current.directory_ctime != self.directory_ctime {
            return Err(changed());
        }
        Ok(())
    }
}
/// A bounded snapshot, useful only for rechecking this operation's own handoff.
/// It is not a persistent grant and cannot authorize a later process on its own.
/// Compact persistent opening anchors. Membership epochs belong only to a
/// fresh per-gate Inspection; ordinary body/recovery/Trash writes may change
/// directory contents without changing these original alias/physical objects.
#[derive(Clone)]
pub(super) struct OpeningAnchors {
    witnesses: Vec<Witness>,
    aliases: Vec<(PathBuf, PathBuf)>,
}
impl OpeningAnchors {
    pub(super) fn revalidate(&self) -> Result<(), AuthorityError> {
        for witness in &self.witnesses {
            witness.validate()?;
        }
        for (requested, actual) in &self.aliases {
            if target(requested)? != *actual {
                return Err(changed());
            }
        }
        Ok(())
    }
}

#[derive(Debug)]
pub(crate) struct Inspection {
    witnesses: BTreeMap<PathBuf, Witness>,
    marker_absences: BTreeSet<PathBuf>,
    aliases: Vec<(PathBuf, PathBuf)>,
}
impl Inspection {
    pub(super) fn opening_anchors(&self) -> Result<OpeningAnchors, AuthorityError> {
        let mut paths = BTreeSet::new();
        for (requested, actual) in &self.aliases {
            paths.insert(requested.clone());
            paths.extend(actual.ancestors().map(Path::to_path_buf));
        }
        let witnesses = paths
            .into_iter()
            .map(|path| {
                let mut witness = self.witnesses.get(&path).ok_or_else(changed)?.clone();
                witness.directory_modified = None;
                #[cfg(unix)]
                {
                    witness.directory_ctime = None;
                }
                Ok(witness)
            })
            .collect::<Result<Vec<_>, AuthorityError>>()?;
        Ok(OpeningAnchors {
            witnesses,
            aliases: self.aliases.clone(),
        })
    }

    /// Already bounded P1 inventory; used only for deny-only output intersections.
    pub(super) fn opening_directories(&self) -> Vec<PathBuf> {
        self.witnesses
            .iter()
            .filter(|(_, witness)| witness.identity.kind == 2)
            .map(|(path, _)| path.clone())
            .filter(|path| {
                self.aliases
                    .iter()
                    .any(|(_, actual)| path.starts_with(actual))
            })
            .collect()
    }
    // Per-file checks use the held inventory; they never repeat a recursive walk
    // or reread the selected registry for every note.
    pub(crate) fn open_file(&self, path: &Path) -> Result<fs::File, AuthorityError> {
        let actual = target(path)?;
        self.validate_requested_path(path)?;
        // A leaf link and its regular target have different identities.
        // Only a captured canonical target may authorize this descriptor.
        let witness = self.witnesses.get(&actual).ok_or_else(changed)?;
        witness.validate()?;
        let parent = actual.parent().ok_or_else(unavailable)?;
        let leaf = actual
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or_else(unavailable)?;
        let opened = crate::files::bytes::open_in(parent, "boundary-content", leaf)
            .map_err(|_| unavailable())?;
        if opened.path != actual
            || Identity::of(&opened.file.metadata().map_err(|_| unavailable())?) != witness.identity
        {
            return Err(changed());
        }
        for directory in actual.ancestors().skip(1) {
            if !self.marker_absences.contains(directory) {
                return Err(changed());
            }
            marker_absent(directory)?;
            if let Some(directory_witness) = self.witnesses.get(directory) {
                directory_witness.validate()?;
            }
        }
        self.validate_requested_path(path)?;
        Ok(opened.file)
    }
    fn validate_requested_path(&self, requested: &Path) -> Result<(), AuthorityError> {
        let requested = lexical(requested)?;
        for path in requested.ancestors() {
            let meta = fs::symlink_metadata(path).map_err(|_| changed())?;
            // Resolve the parent only so a leaf symlink keeps its own identity.
            // This also finds inventory witnesses beneath a stable root alias.
            let anchored = match (path.parent(), path.file_name()) {
                (Some(parent), Some(leaf)) => target(parent)?.join(leaf),
                _ => path.to_path_buf(),
            };
            let witness = self
                .witnesses
                .get(path)
                .or_else(|| self.witnesses.get(&anchored))
                .ok_or_else(changed)?;
            witness.validate()?;
            if Identity::of(&meta) != witness.identity {
                return Err(changed());
            }
            if meta.is_dir() && !meta.file_type().is_symlink() {
                marker_absent(path)?;
            }
            let routed = target(path)?;
            if routed.as_path() != path {
                let routed_meta = fs::symlink_metadata(&routed).map_err(|_| changed())?;
                if routed_meta.file_type().is_symlink() {
                    return Err(changed());
                }
                if routed_meta.is_dir() {
                    self.validate_routed_ancestry(&routed)?;
                }
            }
        }
        Ok(())
    }
    fn validate_routed_ancestry(&self, routed: &Path) -> Result<(), AuthorityError> {
        // Validate only this request route's captured ancestry, never the whole
        // held tree inventory or registry. A stable alias does not prove that
        // its intermediate namespace is still unmarked at content handoff.
        for directory in routed.ancestors() {
            if !self.marker_absences.contains(directory) {
                return Err(changed());
            }
            self.witnesses
                .get(directory)
                .ok_or_else(changed)?
                .validate()?;
            marker_absent(directory)?;
        }
        Ok(())
    }
    pub(crate) fn revalidate(&self) -> Result<(), AuthorityError> {
        for witness in self.witnesses.values() {
            witness.validate()?;
        }
        for directory in &self.marker_absences {
            marker_absent(directory)?;
        }
        for (requested, actual) in &self.aliases {
            if target(requested)? != *actual {
                return Err(changed());
            }
        }
        Ok(())
    }
}
fn marker_absent(directory: &Path) -> Result<(), AuthorityError> {
    let marker = directory.join(crate::workspace_migration::format_gate::FORMAT_MARKER);
    let control = marker.parent().ok_or_else(invalid)?;
    match fs::symlink_metadata(control) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => {}
        _ => return Err(invalid()),
    }
    match fs::symlink_metadata(&marker) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        _ => Err(changed()),
    }
}
struct Inspector<'a> {
    context: Option<&'a AuthorityContext>,
    bounds: Limits,
    entries: usize,
    names: usize,
    marker_bytes: u64,
    known: Vec<PathBuf>,
    visited: BTreeSet<PathBuf>,
    inspection: Inspection,
}
impl<'a> Inspector<'a> {
    fn new(context: Option<&'a AuthorityContext>, bounds: Limits) -> Result<Self, AuthorityError> {
        let mut known = Vec::new();
        if let Some(context) = context {
            known.extend(
                authority::registrations(context)?
                    .into_iter()
                    .map(|binding| binding.root),
            );
            known.extend(context.observed_roots()?);
        }
        Ok(Self {
            context,
            bounds,
            entries: 0,
            names: 0,
            marker_bytes: 0,
            known,
            visited: BTreeSet::new(),
            inspection: Inspection {
                witnesses: BTreeMap::new(),
                marker_absences: BTreeSet::new(),
                aliases: Vec::new(),
            },
        })
    }
    fn charge(&mut self, path: &Path, depth: usize) -> Result<(), AuthorityError> {
        self.entries = self.entries.checked_add(1).ok_or_else(limit)?;
        self.names = self
            .names
            .checked_add(path.as_os_str().len())
            .ok_or_else(limit)?;
        if self.entries > self.bounds.entries
            || depth > self.bounds.depth
            || self.names > self.bounds.path_bytes
        {
            return Err(limit());
        }
        if path.as_os_str().len() > authority::rules().limits.path_bytes
            || path.components().count() > authority::rules().limits.path_components
        {
            return Err(limit());
        }
        Ok(())
    }
    fn known_intersection(&self, actual: &Path, tree: bool) -> Result<(), AuthorityError> {
        for root in &self.known {
            if actual.starts_with(root) || (tree && root.starts_with(actual)) {
                if let Some(context) = self.context {
                    authority::resolve_with(context, root)?;
                }
                return Err(unsupported());
            }
        }
        Ok(())
    }
    fn directory(&mut self, directory: &Path) -> Result<(), AuthorityError> {
        if self.inspection.marker_absences.contains(directory) {
            return Ok(());
        }
        let marker = directory.join(crate::workspace_migration::format_gate::FORMAT_MARKER);
        let control = marker.parent().ok_or_else(invalid)?;
        match fs::symlink_metadata(control) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                self.inspection
                    .marker_absences
                    .insert(directory.to_path_buf());
                return Ok(());
            }
            Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => {}
            _ => return Err(invalid()),
        }
        match fs::symlink_metadata(&marker) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                self.inspection
                    .marker_absences
                    .insert(directory.to_path_buf());
                Ok(())
            }
            Ok(meta) => {
                if !meta.is_file() || meta.file_type().is_symlink() {
                    return Err(invalid());
                }
                self.marker_bytes = self
                    .marker_bytes
                    .checked_add(meta.len())
                    .ok_or_else(limit)?;
                if meta.len() > self.bounds.single_marker_bytes
                    || self.marker_bytes > self.bounds.marker_bytes
                {
                    return Err(limit());
                }
                // This raw classifier uses the existing bounded, descriptor-contained marker reader.
                // Every present marker denies legacy use, even a valid bound activated marker.
                if let Some(context) = self.context {
                    authority::resolve_with(context, directory)?;
                } else {
                    authority::legacy_marker(directory)?;
                }
                Err(unsupported())
            }
            Err(_) => Err(invalid()),
        }
    }
    fn ancestry(&mut self, actual: &Path) -> Result<(), AuthorityError> {
        let mut current = if actual.is_dir() {
            Some(actual)
        } else {
            actual.parent()
        };
        while let Some(directory) = current {
            // Future path components do not have markers; their real ancestry still does.
            match fs::symlink_metadata(directory) {
                Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => {
                    self.charge(directory, 0)?;
                    self.inspection
                        .witnesses
                        .entry(directory.to_path_buf())
                        .or_insert_with(|| Witness::new(directory.to_path_buf(), &meta, false));
                    self.directory(directory)?;
                }
                Ok(meta) if meta.is_file() && !meta.file_type().is_symlink() => {
                    // A regular file is an impassable prefix, not a directory
                    // to search. Keep its identity so replacing it invalidates
                    // this boundary snapshot before a later operation phase.
                    self.charge(directory, 0)?;
                    self.inspection
                        .witnesses
                        .entry(directory.to_path_buf())
                        .or_insert_with(|| Witness::new(directory.to_path_buf(), &meta, false));
                }
                Err(e)
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
                    ) => {}
                _ => return Err(unavailable()),
            }
            current = directory.parent();
        }
        Ok(())
    }
    fn walk(&mut self, path: &Path, depth: usize) -> Result<(), AuthorityError> {
        self.charge(path, depth)?;
        self.walk_charged(path, depth)
    }
    fn walk_charged(&mut self, path: &Path, depth: usize) -> Result<(), AuthorityError> {
        let meta = fs::symlink_metadata(path).map_err(|_| unavailable())?;
        self.inspection.witnesses.insert(
            path.to_path_buf(),
            Witness::new(path.to_path_buf(), &meta, meta.is_dir()),
        );
        if meta.file_type().is_symlink() {
            let actual = target(path)?;
            self.known_intersection(&actual, true)?;
            self.ancestry(&actual)?;
            self.inspection
                .aliases
                .push((path.to_path_buf(), actual.clone()));
            if !self.visited.contains(&actual) {
                self.walk(&actual, depth + 1)?;
            }
        } else if meta.is_dir() {
            if !self.visited.insert(path.to_path_buf()) {
                return Ok(());
            }
            self.directory(path)?;
            // Charge streamed names before retaining them. Deterministic traversal
            // gives stable typed refusals when several marked siblings intersect.
            let mut children = Vec::new();
            for entry in fs::read_dir(path).map_err(|_| unavailable())? {
                let child = entry.map_err(|_| unavailable())?.path();
                self.charge(&child, depth + 1)?;
                children.push(child);
            }
            children.sort();
            for child in children {
                self.walk_charged(&child, depth + 1)?;
            }
        } else if !meta.is_file() {
            return Err(unavailable());
        }
        Ok(())
    }
    fn scope(&mut self, requested: &Path, tree: bool) -> Result<(), AuthorityError> {
        let requested = lexical(requested)?;
        let actual = target(&requested)?;
        self.known_intersection(&actual, tree)?;
        self.known_intersection(&requested, tree)?;
        self.ancestry(&actual)?;
        // Namespace boundaries on the request route remain boundaries even when
        // a contained alias lands in an unrelated ordinary directory.
        for path in requested.ancestors() {
            self.known_intersection(path, false)?;
            match fs::symlink_metadata(path) {
                Ok(meta) => {
                    self.charge(path, 0)?;
                    self.inspection
                        .witnesses
                        .entry(path.to_path_buf())
                        .or_insert_with(|| Witness::new(path.to_path_buf(), &meta, false));
                    if meta.is_dir() && !meta.file_type().is_symlink() {
                        self.directory(path)?;
                    }
                    // A lexical position may itself be a directory alias. Check
                    // that position's landing too: final-target ancestry alone
                    // misses a marked intermediate directory followed by alias-out.
                    let routed = target(path)?;
                    self.known_intersection(&routed, false)?;
                    let routed_meta = fs::symlink_metadata(&routed).map_err(|_| changed())?;
                    if routed_meta.file_type().is_symlink() {
                        return Err(changed());
                    }
                    if routed_meta.is_dir() {
                        if routed.as_path() != path {
                            // A route can land below a boundary, then alias out again.
                            // Inspect every ancestor of that intermediate landing using
                            // this same Inspector and budget, without a sibling-tree walk.
                            self.ancestry(&routed)?;
                        } else {
                            self.directory(&routed)?;
                        }
                    }
                }
                Err(e)
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
                    ) => {}
                Err(_) => return Err(unavailable()),
            }
        }
        // Exact scopes do not walk files. Capture the canonical target separately
        // from a requested leaf-link witness before comparing an opened descriptor.
        if actual != requested {
            match fs::symlink_metadata(&actual) {
                Ok(meta) if meta.is_file() && !meta.file_type().is_symlink() => {
                    self.charge(&actual, 0)?;
                    self.inspection
                        .witnesses
                        .entry(actual.clone())
                        .or_insert_with(|| Witness::new(actual.clone(), &meta, false));
                }
                Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => {}
                Err(e)
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
                    ) => {}
                _ => return Err(changed()),
            }
        }
        self.inspection.aliases.push((requested, actual.clone()));
        if tree && actual.exists() {
            self.walk(&actual, 0)?;
        }
        Ok(())
    }
}
pub(super) fn inspect_with_limits(
    context: Option<&AuthorityContext>,
    scopes: &[(PathBuf, bool)],
    bounds: Limits,
) -> Result<Inspection, AuthorityError> {
    if scopes.len() > bounds.entries {
        return Err(limit());
    }
    let mut inspector = Inspector::new(context, bounds)?;
    for (path, tree) in scopes {
        inspector.scope(path, *tree)?;
    }
    inspector.inspection.revalidate()?;
    Ok(inspector.inspection)
}
pub(crate) fn guard(
    context: &AuthorityContext,
    path: &Path,
    tree: bool,
) -> Result<(), AuthorityError> {
    inspect_with_limits(Some(context), &[(path.to_path_buf(), tree)], limits()).map(|_| ())
}
pub(crate) fn guard_scopes(
    context: &AuthorityContext,
    scopes: &[(PathBuf, bool)],
) -> Result<(), AuthorityError> {
    inspect_with_limits(Some(context), scopes, limits()).map(|_| ())
}
pub(crate) fn inspect_legacy_tree(root: &Path) -> Result<Inspection, AuthorityError> {
    authority::guard_legacy(root)?;
    match authority::context() {
        Ok(context) => inspect_with_limits(Some(&context), &[(root.to_path_buf(), true)], limits()),
        #[cfg(test)]
        Err(_) => inspect_with_limits(None, &[(root.to_path_buf(), true)], limits()),
        #[cfg(not(test))]
        Err(error) => Err(error),
    }
}
pub(crate) fn guard_legacy_scope(
    root: &Path,
    relative: Option<&str>,
    tree: bool,
) -> Result<(), AuthorityError> {
    inspect_legacy_scope(root, relative, tree).map(|_| ())
}
pub(crate) fn open_legacy_file(root: &Path, relative: &str) -> Result<fs::File, AuthorityError> {
    inspect_legacy_scope(root, Some(relative), false)?.open_file(&root.join(relative))
}
pub(crate) fn open_legacy_source(
    root: &Path,
    relative: &str,
) -> Result<crate::files::bytes::OpenedFile, AuthorityError> {
    let inspection = inspect_legacy_scope(root, Some(relative), false)?;
    let canonical_root = authority::canonical_root(root)?;
    let requested = root.join(relative);
    let path = target(&requested)?;
    // This is the SAME content FD checked by the existing boundary witnesses,
    // marker absences and original alias route; no second content open.
    let file = inspection.open_file(&requested)?;
    inspection.revalidate()?;
    if authority::canonical_root(root)? != canonical_root
        || target(&requested)? != path
        || !path.starts_with(&canonical_root)
    {
        return Err(changed());
    }
    Ok(crate::files::bytes::OpenedFile {
        root: canonical_root,
        path,
        file,
    })
}
pub(crate) fn guard_legacy_targets_with_limits(
    root: &Path,
    targets: &[(&str, bool)],
    bounds: Limits,
) -> Result<(), AuthorityError> {
    if targets.len() > bounds.entries {
        return Err(limit());
    }
    let relative: Vec<_> = targets
        .iter()
        .map(|(path, tree)| (Some(*path), *tree))
        .collect();
    inspect_legacy_scopes(root, &relative, bounds).map(|_| ())
}
fn inspect_legacy_scope(
    root: &Path,
    relative: Option<&str>,
    tree: bool,
) -> Result<Inspection, AuthorityError> {
    inspect_legacy_scopes(root, &[(relative, tree)], limits())
}
fn inspect_legacy_scopes(
    root: &Path,
    relative: &[(Option<&str>, bool)],
    bounds: Limits,
) -> Result<Inspection, AuthorityError> {
    if relative.len() > bounds.entries {
        return Err(limit());
    }
    authority::guard_legacy(root)?;
    let actual_root = authority::canonical_root(root)?;
    let mut scopes = Vec::with_capacity(relative.len());
    for (relative, tree) in relative {
        let path = match relative {
            Some(relative) => {
                let rel = Path::new(relative);
                if rel.is_absolute()
                    || rel
                        .components()
                        .any(|p| !matches!(p, Component::Normal(_) | Component::CurDir))
                {
                    return Err(unavailable());
                }
                let path = root.join(rel);
                if !target(&path)?.starts_with(&actual_root) {
                    return Err(unavailable());
                }
                path
            }
            None => root.to_path_buf(),
        };
        scopes.push((path, *tree));
    }
    match authority::context() {
        Ok(context) => inspect_with_limits(Some(&context), &scopes, bounds),
        #[cfg(test)]
        Err(_) => inspect_with_limits(None, &scopes, bounds),
        #[cfg(not(test))]
        Err(error) => Err(error),
    }
}

#[cfg(test)]
#[path = "boundary_tests.rs"]
mod tests;
