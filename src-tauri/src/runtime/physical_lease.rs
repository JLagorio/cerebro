//! Fixed physical lease domains. SQL pinning belongs to the same borrowed tx.
//! No database opener, namespace-from-wire selector, authority or provider factory.
use rusqlite::Connection;
#[derive(Clone, Copy)]
pub(super) enum LeaseDomain {
    ActionSubmission,
    WorkflowExecution,
}
impl LeaseDomain {
    #[cfg(unix)]
    fn directory(self) -> &'static std::ffi::CStr {
        match self {
            Self::ActionSubmission => c".action-submission-owners",
            Self::WorkflowExecution => c".workflow-execution-owners",
        }
    }
    fn key_prefix(self) -> &'static str {
        match self {
            Self::ActionSubmission => "cerebro.action-submission-owner.v1",
            Self::WorkflowExecution => "cerebro.workflow-execution-owner.v1",
        }
    }
}
#[derive(Clone, Copy)]
pub(super) struct LeaseIdentity {
    pub(super) runtime: (u64, u64),
    pub(super) parent: (u64, u64),
    pub(super) directory: (u64, u64),
    pub(super) file: (u64, u64),
}
pub(super) struct LeaseFiles {
    _file: std::fs::File,
    _directory: std::fs::File,
    _parent: std::fs::File,
    identities: LeaseIdentity,
}
impl LeaseFiles {
    pub(super) fn matches_original(&self, runtime: (u64, u64)) -> bool {
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let (Ok(file), Ok(directory), Ok(parent)) = (
                self._file.metadata(),
                self._directory.metadata(),
                self._parent.metadata(),
            ) else {
                return false;
            };
            self.identities.runtime == runtime
                && (file.dev(), file.ino()) == self.identities.file
                && (directory.dev(), directory.ino()) == self.identities.directory
                && (parent.dev(), parent.ino()) == self.identities.parent
        }
        #[cfg(not(unix))]
        {
            let _ = runtime;
            false
        }
    }
}
pub(super) fn try_acquire(
    conn: &Connection,
    data_dir: &std::path::Path,
    identity: (u64, u64),
    directory_identity: (u64, u64),
    domain: LeaseDomain,
    owner_id: &str,
    pin: impl FnOnce(&Connection, &LeaseIdentity) -> Result<(), String>,
) -> Result<Option<LeaseFiles>, String> {
    if conn.is_autocommit() {
        return Err("physical lease requires a caller-owned transaction".into());
    }
    if owner_id.len() != 32
        || !owner_id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err("physical lease selector is invalid".into());
    }
    #[cfg(unix)]
    {
        use sha2::{Digest, Sha256};
        use std::{
            ffi::CString,
            fs::File,
            os::{
                fd::{AsRawFd, FromRawFd},
                unix::fs::{MetadataExt, OpenOptionsExt},
            },
        };
        let parent = File::options()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(data_dir)
            .map_err(|_| "submission anchor is unavailable")?;
        let anchor = parent
            .metadata()
            .map_err(|_| "submission anchor is unavailable")?;
        if (anchor.dev(), anchor.ino()) != directory_identity {
            return Err("submission anchor identity is unavailable".into());
        }
        let directory = domain.directory();
        // SAFETY: the live descriptor anchors a fixed NUL-terminated child name.
        let made = unsafe { libc::mkdirat(parent.as_raw_fd(), directory.as_ptr(), 0o700) };
        if made == -1 && std::io::Error::last_os_error().kind() != std::io::ErrorKind::AlreadyExists
        {
            return Err("submission directory is unavailable".into());
        }
        // SAFETY: the descriptor and fixed CString are valid for this call.
        let directory_fd = unsafe {
            libc::openat(
                parent.as_raw_fd(),
                directory.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if directory_fd == -1 {
            return Err("submission directory is unavailable".into());
        }
        // SAFETY: openat returned a fresh descriptor; ownership transfers once.
        let directory = unsafe { File::from_raw_fd(directory_fd) };
        // SAFETY: geteuid has no arguments or memory preconditions.
        let owner_uid = unsafe { libc::geteuid() };
        let metadata = directory
            .metadata()
            .map_err(|_| "submission directory is unavailable")?;
        if !metadata.is_dir() || metadata.mode() & 0o077 != 0 || metadata.uid() != owner_uid {
            return Err("submission directory is not private".into());
        }
        let namespace_identity = (metadata.dev(), metadata.ino());
        // Stable ownership protocol v1: independent of wire DTO order, path
        // spelling and symlink/case aliases of this physical SQLite database.
        let key = format!(
            "{}\0{}:{}\0{owner_id}",
            domain.key_prefix(),
            identity.0,
            identity.1
        );
        let name = CString::new(format!("{:x}.lock", Sha256::digest(key.as_bytes())))
            .expect("hex owner filename");
        // SAFETY: the checked directory stays open and the hex CString is valid.
        let file_fd = unsafe {
            libc::openat(
                directory.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDWR
                    | libc::O_CREAT
                    | libc::O_NOFOLLOW
                    | libc::O_NONBLOCK
                    | libc::O_CLOEXEC,
                0o600,
            )
        };
        if file_fd == -1 {
            return Err("submission owner is unavailable".into());
        }
        // SAFETY: openat returned a fresh descriptor; ownership transfers once.
        let file = unsafe { File::from_raw_fd(file_fd) };
        let metadata = file
            .metadata()
            .map_err(|_| "submission owner is unavailable")?;
        if !metadata.is_file()
            || metadata.nlink() != 1
            || metadata.len() != 0
            || metadata.mode() & 0o077 != 0
            || metadata.uid() != owner_uid
        {
            return Err("submission owner is not a private regular file".into());
        }
        // Publish the actual empty file and both membership links before SQL
        // can durably pin their inodes. Use retained FDs; never reopen the DB.
        file.sync_all()
            .map_err(|_| "physical lease file sync unavailable")?;
        directory
            .sync_all()
            .map_err(|_| "physical lease directory sync unavailable")?;
        parent
            .sync_all()
            .map_err(|_| "physical lease parent sync unavailable")?;
        let identities = LeaseIdentity {
            runtime: identity,
            parent: directory_identity,
            directory: namespace_identity,
            file: (metadata.dev(), metadata.ino()),
        };
        pin(conn, &identities)?;
        if conn.is_autocommit() {
            return Err("physical lease pin ended its caller transaction".into());
        }
        match file.try_lock() {
            Ok(()) => Ok(Some(LeaseFiles {
                _file: file,
                _directory: directory,
                _parent: parent,
                identities,
            })),
            Err(std::fs::TryLockError::WouldBlock) => Ok(None),
            Err(std::fs::TryLockError::Error(_)) => Err("submission owner is unavailable".into()),
        }
    }
    #[cfg(not(unix))]
    {
        let _ = (
            conn,
            data_dir,
            identity,
            directory_identity,
            domain,
            owner_id,
            pin,
        );
        Err("submission ownership is unsupported on this platform".into())
    }
}
