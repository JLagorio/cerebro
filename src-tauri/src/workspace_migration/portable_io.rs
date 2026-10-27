//! Descriptor-anchored I/O for new private portable outputs (Unix only).
use super::{error, Result, K};
use std::{
    ffi::CString,
    fs::{self, File},
    io::{Read, Write},
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::fs::{MetadataExt, OpenOptionsExt},
    },
    path::{Path, PathBuf},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct Identity {
    pub dev: u64,
    pub ino: u64,
}
impl Identity {
    pub(super) fn of(meta: &fs::Metadata) -> Self {
        Self {
            dev: meta.dev(),
            ino: meta.ino(),
        }
    }
    #[cfg(target_os = "macos")]
    pub(super) fn tuple(self) -> (u64, u64) {
        (self.dev, self.ino)
    }
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Stamp {
    pub identity: Identity,
    pub length: u64,
    modified: Option<std::time::SystemTime>,
}
fn stamp(meta: &fs::Metadata) -> Stamp {
    Stamp {
        identity: Identity::of(meta),
        length: meta.len(),
        modified: meta.modified().ok(),
    }
}
fn name(value: &str) -> Result<CString> {
    CString::new(value).map_err(|_| error(K::InvalidPath, "A path contains a nul byte."))
}
fn open_at(parent: &File, value: &str, flags: i32, mode: libc::mode_t) -> Result<File> {
    let value = name(value)?;
    // Parent is an owned directory descriptor; every component is opened separately.
    let fd = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            value.as_ptr(),
            flags | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            mode as libc::c_uint,
        )
    };
    if fd < 0 {
        return Err(error(
            match std::io::Error::last_os_error().raw_os_error() {
                Some(libc::ENOENT) => K::RequiredPartMissing,
                Some(libc::ELOOP) | Some(libc::ENOTDIR) => K::InvalidPath,
                _ => K::DestinationUnavailable,
            },
            "A contained file or directory is unavailable.",
        ));
    }
    Ok(unsafe { File::from_raw_fd(fd) })
}
fn stat_at(parent: &File, value: &str) -> Result<libc::stat> {
    let value = name(value)?;
    let mut result = std::mem::MaybeUninit::<libc::stat>::uninit();
    let code = unsafe {
        libc::fstatat(
            parent.as_raw_fd(),
            value.as_ptr(),
            result.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    };
    if code != 0 {
        return Err(error(
            K::RequiredPartMissing,
            "A declared path is unavailable.",
        ));
    }
    Ok(unsafe { result.assume_init() })
}
fn mkdir_at(parent: &File, value: &str, absent: bool) -> Result<()> {
    mkdir_at_observed(parent, value, absent, None)
}
fn mkdir_at_observed(parent: &File, value: &str, absent: bool, observed: Option<(&super::super::OutputFacts, &Path)>) -> Result<()> {
    let value = name(value)?;
    if let Some((facts, target)) = observed {
        facts.creation_attempted();
        super::step("output_mkdir_attempt", target, target);
    }
    let code = unsafe { libc::mkdirat(parent.as_raw_fd(), value.as_ptr(), 0o700) };
    if code == 0 {
        if let Some((facts, target)) = observed {
            facts.created();
            // Actual syscall success, before sync/stat/open can fail.
            super::step("output_mkdir_created", target, target);
        }
    }
    if code != 0 {
        let cause = std::io::Error::last_os_error();
        if absent || cause.raw_os_error() != Some(libc::EEXIST) {
            return Err(error(
                K::DestinationUnavailable,
                "A new private directory could not be created.",
            ));
        }
    }
    parent.sync_all().map_err(|_| {
        error(
            K::DestinationUnavailable,
            "Directory creation was not flushed.",
        )
    })
}
#[derive(Debug)]
pub(crate) struct Root {
    pub path: PathBuf,
    directory: File,
    identity: Identity,
}
impl Root {
    pub(crate) fn open(path: &Path) -> Result<Self> {
        let canonical = super::stage::canonical_root(path)
            .map_err(|_| error(K::InvalidPath, "A real contained directory is required."))?;
        let before = fs::symlink_metadata(&canonical)
            .map_err(|_| error(K::RequiredPartMissing, "A root is unavailable."))?;
        let directory = fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(&canonical)
            .map_err(|_| error(K::InvalidPath, "A root cannot be opened safely."))?;
        let actual = directory
            .metadata()
            .map_err(|_| error(K::InvalidPath, "Root identity is unavailable."))?;
        if !before.is_dir() || Identity::of(&before) != Identity::of(&actual) {
            return Err(error(K::SourceChanged, "Root identity changed."));
        }
        Ok(Self {
            path: canonical,
            directory,
            identity: Identity::of(&actual),
        })
    }
    pub(super) fn create(path: &Path) -> Result<Self> {
        let parent = path
            .parent()
            .ok_or_else(|| error(K::DestinationUnavailable, "Destination has no parent."))?;
        let parent = Self::open(parent)?;
        let leaf = path
            .file_name()
            .and_then(|x| x.to_str())
            .ok_or_else(|| error(K::InvalidPath, "Destination name is invalid."))?;
        super::checked_path(leaf)?;
        parent.create_child(leaf)
    }
    /// Actual first write for both path-library and held native output entry.
    /// Never reopen the parent or the new child by an unchecked pathname.
    pub(crate) fn create_child(&self, leaf: &str) -> Result<Self> {
        self.create_child_inner(leaf, None)
    }
    pub(crate) fn create_child_observed(&self, leaf: &str, facts: &super::super::OutputFacts) -> Result<Self> {
        self.create_child_inner(leaf, Some(facts))
    }
    fn create_child_inner(&self, leaf: &str, facts: Option<&super::super::OutputFacts>) -> Result<Self> {
        super::checked_path(leaf)?;
        if Path::new(leaf).components().count() != 1 {
            return Err(error(K::InvalidPath, "One child directory name is required."));
        }
        self.validate()?;
        let target = self.path.join(leaf);
        mkdir_at_observed(&self.directory, leaf, true, facts.map(|facts| (facts, target.as_path())))?;
        let created = stat_at(&self.directory, leaf)?;
        let directory = open_at(&self.directory, leaf, libc::O_RDONLY | libc::O_DIRECTORY, 0)?;
        let metadata = directory.metadata().map_err(|_| error(K::SourceChanged, "Created directory identity is unavailable."))?;
        if !metadata.is_dir() || Identity::of(&metadata) != (Identity { dev: created.st_dev as u64, ino: created.st_ino as u64 }) {
            return Err(error(K::SourceChanged, "Created directory changed identity."));
        }
        self.validate()?;
        let root = Self { path: self.path.join(leaf), identity: Identity::of(&metadata), directory };
        root.validate()?;
        if facts.is_some() { super::step("output_root_handoff", &root.path, &root.path); }
        Ok(root)
    }
    /// Observe the already-held directory, never reopen its pathname.
    pub(crate) fn held_identity(&self) -> Result<(u64, u64)> {
        let metadata = self.directory.metadata().map_err(|_| error(K::SourceChanged, "Held directory identity is unavailable."))?;
        let identity = Identity::of(&metadata);
        if !metadata.is_dir() || identity != self.identity { return Err(error(K::SourceChanged, "Held directory identity changed.")); }
        Ok((identity.dev, identity.ino))
    }
    /// Read-only descriptor proof, no Root/write API is retained by observer.
    pub(crate) fn passive_directory(&self) -> Result<File> {
        self.directory.try_clone().map_err(|_| error(K::SourceChanged, "Passive directory identity is unavailable."))
    }
    pub(crate) fn validate(&self) -> Result<()> {
        let current = fs::symlink_metadata(&self.path)
            .map_err(|_| error(K::SourceChanged, "Root identity disappeared."))?;
        if !current.is_dir()
            || current.file_type().is_symlink()
            || Identity::of(&current) != self.identity
            || Identity::of(
                &self
                    .directory
                    .metadata()
                    .map_err(|_| error(K::SourceChanged, "Held root is unavailable."))?,
            ) != self.identity
        {
            return Err(error(K::SourceChanged, "Root identity changed."));
        }
        Ok(())
    }
    fn parent(&self, rel: &str, create: bool) -> Result<(File, String)> {
        super::checked_storage_path(rel)?;
        self.validate()?;
        let mut components = rel.split('/').peekable();
        let mut directory = self
            .directory
            .try_clone()
            .map_err(|_| error(K::InvalidPath, "Root handle cannot be retained."))?;
        while let Some(component) = components.next() {
            if components.peek().is_none() {
                return Ok((directory, component.to_owned()));
            }
            if create {
                mkdir_at(&directory, component, false)?;
            }
            directory = open_at(&directory, component, libc::O_RDONLY | libc::O_DIRECTORY, 0)?;
        }
        Err(error(K::InvalidPath, "A contained path is required."))
    }
    pub(super) fn identity(&self, rel: &str) -> Result<Identity> {
        let (parent, leaf) = self.parent(rel, false)?;
        let meta = stat_at(&parent, &leaf)?;
        if meta.st_mode & libc::S_IFMT == libc::S_IFLNK {
            return Err(error(K::InvalidPath, "Symlinks are not portable parts."));
        }
        Ok(Identity {
            dev: meta.st_dev as u64,
            ino: meta.st_ino as u64,
        })
    }
    pub(super) fn read(&self, rel: &str, cap: u64) -> Result<(Vec<u8>, Stamp)> {
        let (parent, leaf) = self.parent(rel, false)?;
        let mut file = open_at(&parent, &leaf, libc::O_RDONLY | libc::O_NONBLOCK, 0)?;
        let before = file
            .metadata()
            .map_err(|_| error(K::RequiredPartMissing, "Part metadata is unavailable."))?;
        if !before.is_file() || before.nlink() != 1 {
            return Err(error(
                K::InvalidPath,
                "Only independent regular files are portable.",
            ));
        }
        if before.len() > cap {
            return Err(error(
                K::SourceLimit,
                "A part exceeds its category byte limit.",
            ));
        }
        let mut bytes = Vec::new();
        Read::by_ref(&mut file)
            .take(
                cap.checked_add(1)
                    .ok_or_else(|| error(K::SourceLimit, "Invalid read bound."))?,
            )
            .read_to_end(&mut bytes)
            .map_err(|_| error(K::RequiredPartMissing, "Part bytes are unavailable."))?;
        let after = file
            .metadata()
            .map_err(|_| error(K::SourceChanged, "Part identity is unavailable."))?;
        let expected = stamp(&before);
        if bytes.len() as u64 > cap {
            return Err(error(
                K::SourceLimit,
                "A part exceeds its category byte limit.",
            ));
        }
        if expected != stamp(&after)
            || bytes.len() as u64 != expected.length
            || self.identity(rel)? != expected.identity
        {
            return Err(error(K::SourceChanged, "A part changed during its read."));
        }
        self.validate()?;
        Ok((bytes, expected))
    }
    pub(super) fn directory(&self, rel: &str) -> Result<()> {
        let (parent, leaf) = self.parent(rel, true)?;
        mkdir_at(&parent, &leaf, false)?;
        let child = open_at(&parent, &leaf, libc::O_RDONLY | libc::O_DIRECTORY, 0)?;
        child.sync_all().map_err(|_| {
            error(
                K::DestinationUnavailable,
                "Destination directory was not flushed.",
            )
        })?;
        self.validate()
    }
    pub(super) fn write_new(&self, rel: &str, bytes: &[u8]) -> Result<Identity> {
        let (parent, leaf) = self.parent(rel, true)?;
        let mut file = open_at(
            &parent,
            &leaf,
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
            0o600,
        )?;
        let identity = Identity::of(&file.metadata().map_err(|_| {
            error(
                K::DestinationUnavailable,
                "New part identity is unavailable.",
            )
        })?);
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| {
                error(
                    K::DestinationUnavailable,
                    "New part bytes were not durably written.",
                )
            })?;
        parent.sync_all().map_err(|_| {
            error(
                K::DestinationUnavailable,
                "New part membership was not flushed.",
            )
        })?;
        if self.identity(rel)? != identity {
            return Err(error(K::SourceChanged, "New part was replaced."));
        }
        self.validate()?;
        Ok(identity)
    }
    /// Only the owned preparing marker is updated. An interrupted update remains
    /// preparing or malformed, both denied by current selected/legacy admission.
    pub(super) fn finish_marker(&self, rel: &str, identity: Identity, bytes: &[u8]) -> Result<()> {
        let (parent, leaf) = self.parent(rel, false)?;
        let mut file = open_at(&parent, &leaf, libc::O_WRONLY | libc::O_NONBLOCK, 0)?;
        if Identity::of(
            &file
                .metadata()
                .map_err(|_| error(K::SourceChanged, "Marker disappeared."))?,
        ) != identity
        {
            return Err(error(K::SourceChanged, "Preparing marker was replaced."));
        }
        file.write_all(bytes)
            .and_then(|_| file.set_len(bytes.len() as u64))
            .and_then(|_| file.sync_all())
            .map_err(|_| {
                error(
                    K::DestinationUnavailable,
                    "Inactive marker could not be completed.",
                )
            })?;
        if self.identity(rel)? != identity {
            return Err(error(K::SourceChanged, "Inactive marker was replaced."));
        }
        self.validate()
    }
}
#[cfg(target_os = "macos")]
pub(super) struct ExistingLock {
    file: File,
    root: Root,
    rel: String,
    identity: Identity,
}
#[cfg(target_os = "macos")]
impl ExistingLock {
    pub(super) fn acquire(root: &Path, rel: &str) -> Result<Self> {
        let root = Root::open(root)?;
        let (parent, leaf) = root.parent(rel, false)?;
        let file = open_at(&parent, &leaf, libc::O_RDONLY | libc::O_NONBLOCK, 0)?;
        let meta = file
            .metadata()
            .map_err(|_| error(K::InvalidLedger, "Existing ledger lock is unavailable."))?;
        if !meta.is_file() || meta.nlink() != 1 {
            return Err(error(K::InvalidPath, "Ledger lock is unsafe."));
        }
        let identity = Identity::of(&meta);
        file.try_lock()
            .map_err(|_| error(K::Busy, "The existing ledger owner is busy."))?;
        let held = Self {
            file,
            root,
            rel: rel.into(),
            identity,
        };
        held.validate()?;
        Ok(held)
    }
    pub(super) fn validate(&self) -> Result<()> {
        if self.root.identity(&self.rel)? != self.identity
            || Identity::of(
                &self
                    .file
                    .metadata()
                    .map_err(|_| error(K::SourceChanged, "Ledger lock disappeared."))?,
            ) != self.identity
        {
            return Err(error(K::SourceChanged, "Ledger lock identity changed."));
        }
        self.root.validate()
    }
}
