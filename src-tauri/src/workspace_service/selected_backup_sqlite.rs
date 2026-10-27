//! macOS-only scoped descriptor VFS for the live readonly backup connection.
//! The actual file methods and POSIX lock bookkeeping remain unix-posix's.
use super::*;
use rusqlite::ffi;
use std::{
    ffi::{CStr, CString},
    fs::File,
    ops::Deref,
    os::{
        fd::AsRawFd,
        unix::fs::{FileExt, MetadataExt, OpenOptionsExt},
    },
    path::PathBuf,
    ptr,
};

#[repr(C)]
struct VfsOwner {
    // Must be first: callbacks receive precisely this member's stable address.
    vfs: ffi::sqlite3_vfs,
    base: *mut ffi::sqlite3_vfs,
    name: CString,
    alias: CString,
    source: PathBuf,
    identity: (u64, u64),
}
impl Drop for VfsOwner {
    fn drop(&mut self) {
        // SAFETY: connection has closed before this owner; registration does not
        // own the allocation. No default VFS or syscall table was replaced.
        unsafe {
            ffi::sqlite3_vfs_unregister(&mut self.vfs);
        }
    }
}
fn sidecar_path(source: &Path, suffix: &str) -> PathBuf {
    let mut name = source.as_os_str().to_os_string();
    name.push(suffix);
    name.into()
}
fn no_sidecars(source: &Path) -> Result<(), AuthorityError> {
    for suffix in ["-journal", "-wal", "-shm"] {
        match fs::symlink_metadata(sidecar_path(source, suffix)) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            _ => return Err(error(AuthorityErrorKind::RecoveryRequired,
                "Portable backup requires settled rollback-mode storage with no journal, WAL or SHM sidecar.")),
        }
    }
    Ok(())
}
unsafe extern "C" fn full_path(
    vfs: *mut ffi::sqlite3_vfs,
    name: *const std::ffi::c_char,
    capacity: i32,
    output: *mut std::ffi::c_char,
) -> i32 {
    if vfs.is_null() || name.is_null() || output.is_null() || capacity <= 0 {
        return ffi::SQLITE_CANTOPEN;
    }
    // SAFETY: the registered repr(C) owner remains live until after close;
    // SQLite supplies a terminated name and an output buffer of capacity bytes.
    let owner = unsafe { &*(vfs.cast::<VfsOwner>()) };
    let input = unsafe { CStr::from_ptr(name) };
    let bytes = owner.alias.as_bytes_with_nul();
    if input != owner.alias.as_c_str() || bytes.len() > capacity as usize {
        return ffi::SQLITE_CANTOPEN;
    }
    unsafe {
        ptr::copy_nonoverlapping(bytes.as_ptr().cast(), output, bytes.len());
    }
    ffi::SQLITE_OK
}
unsafe extern "C" fn open_main(
    vfs: *mut ffi::sqlite3_vfs,
    name: ffi::sqlite3_filename,
    file: *mut ffi::sqlite3_file,
    flags: i32,
    output_flags: *mut i32,
) -> i32 {
    if vfs.is_null()
        || name.is_null()
        || file.is_null()
        || flags & ffi::SQLITE_OPEN_READONLY == 0
        || flags
            & (ffi::SQLITE_OPEN_READWRITE
                | ffi::SQLITE_OPEN_CREATE
                | ffi::SQLITE_OPEN_DELETEONCLOSE)
            != 0
        || flags & ffi::SQLITE_OPEN_MAIN_DB == 0
    {
        return ffi::SQLITE_CANTOPEN;
    }
    // SAFETY: same registration lifetime as full_path. The filename is SQLite's
    // own allocation, including its URI metadata; it is delegated unchanged.
    let owner = unsafe { &*(vfs.cast::<VfsOwner>()) };
    if unsafe { CStr::from_ptr(name) } != owner.alias.as_c_str() {
        return ffi::SQLITE_CANTOPEN;
    }
    let Some(open) = (unsafe { (*owner.base).xOpen }) else {
        return ffi::SQLITE_CANTOPEN;
    };
    unsafe { open(owner.base, name, file, flags, output_flags) }
}
unsafe extern "C" fn access(
    vfs: *mut ffi::sqlite3_vfs,
    name: *const std::ffi::c_char,
    _flags: i32,
    result: *mut i32,
) -> i32 {
    if vfs.is_null() || name.is_null() || result.is_null() {
        return ffi::SQLITE_IOERR_ACCESS;
    }
    // SAFETY: SQLite provides the live owner, terminated name and output int.
    let owner = unsafe { &*(vfs.cast::<VfsOwner>()) };
    let requested = unsafe { CStr::from_ptr(name) }.to_bytes();
    unsafe {
        *result = 0;
    }
    let Some(suffix) = requested.strip_prefix(owner.alias.as_bytes()) else {
        return ffi::SQLITE_IOERR_ACCESS;
    };
    if suffix.is_empty() {
        match fs::symlink_metadata(&owner.source) {
            Ok(meta)
                if meta.is_file()
                    && !meta.file_type().is_symlink()
                    && meta.nlink() == 1
                    && (meta.dev(), meta.ino()) == owner.identity =>
            {
                unsafe {
                    *result = 1;
                }
                ffi::SQLITE_OK
            }
            _ => ffi::SQLITE_IOERR_ACCESS,
        }
    } else if matches!(suffix, b"-journal" | b"-wal" | b"-shm") {
        // A descriptor alias must never conceal a real sidecar. Any presence or
        // unreadable state refuses; SQLite is not allowed to open or recover it.
        let suffix = match std::str::from_utf8(suffix) {
            Ok(s) => s,
            Err(_) => return ffi::SQLITE_IOERR_ACCESS,
        };
        match fs::symlink_metadata(sidecar_path(&owner.source, suffix)) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => ffi::SQLITE_OK,
            _ => ffi::SQLITE_IOERR_ACCESS,
        }
    } else {
        ffi::SQLITE_IOERR_ACCESS
    }
}
unsafe extern "C" fn deny_delete(
    _: *mut ffi::sqlite3_vfs,
    _: *const std::ffi::c_char,
    _: i32,
) -> i32 {
    ffi::SQLITE_READONLY
}

pub(super) struct PinnedConnection {
    // Field drop order is essential: SQLite closes its POSIX handle, then the
    // scoped registration is removed, then the independent original FD closes.
    conn: Connection,
    owner: Box<VfsOwner>,
    pin: File,
    // Every admitted selected SQLite connection takes this same exclusive
    // lock. It outlives both SQLite and the raw pin, including failed opens.
    guard: store::WorkspaceLock,
}
impl Deref for PinnedConnection {
    type Target = Connection;
    fn deref(&self) -> &Connection {
        &self.conn
    }
}
impl PinnedConnection {
    pub(super) fn open(
        source: &Path,
        cap: u64,
        guard: store::WorkspaceLock,
    ) -> Result<Self, AuthorityError> {
        guard.validate()?;
        let before =
            fs::symlink_metadata(source).map_err(|_| missing("Source metadata is missing."))?;
        let pin = fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK)
            .open(source)
            .map_err(|_| missing("Source metadata cannot be pinned."))?;
        let held = pin
            .metadata()
            .map_err(|_| missing("Pinned source identity is unavailable."))?;
        if !held.is_file()
            || held.nlink() != 1
            || held.len() > cap
            || before.file_type().is_symlink()
            || !before.is_file()
            || (before.dev(), before.ino()) != (held.dev(), held.ino())
        {
            return Err(error(
                AuthorityErrorKind::WrongIdentity,
                "Source metadata changed before its pin.",
            ));
        }
        // This bounded header admission is not a snapshot. The actual SQLite
        // shared transaction and schema reader validate the live image below.
        let mut header = [0_u8; 20];
        pin.read_exact_at(&mut header, 0)
            .map_err(|_| invalid("Source SQLite header is unavailable."))?;
        if !header.starts_with(b"SQLite format 3\0") || header[18] != 1 || header[19] != 1 {
            return Err(invalid("Live backup supports settled rollback-mode SQLite only; WAL and unknown header modes are unsupported."));
        }
        let alias = CString::new(format!("/dev/fd/{}", pin.as_raw_fd()))
            .map_err(|_| invalid("Descriptor alias cannot be encoded."))?;
        // macOS fdescfs reports its own st_dev when the alias path is statted.
        // Admit the path shape, then compare the opened descriptor's backing-file
        // identity with the still-held pin. Never reopen the original pathname.
        let alias_path = Path::new(
            alias
                .to_str()
                .map_err(|_| invalid("Descriptor alias is invalid."))?,
        );
        let alias_meta = fs::symlink_metadata(alias_path)
            .map_err(|_| missing("The platform has no supported descriptor alias."))?;
        if !alias_meta.is_file() || alias_meta.file_type().is_symlink() {
            return Err(error(
                AuthorityErrorKind::UnsupportedFormat,
                "This descriptor alias is unsupported.",
            ));
        }
        {
            // This probe must close before any SQLite connection exists. The
            // existing exclusive WorkspaceLock is held throughout, and the
            // original pin remains alive until after the live connection closes.
            let reopened = fs::OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK)
                .open(alias_path)
                .map_err(|_| missing("Descriptor alias cannot be reopened."))?;
            let actual = reopened
                .metadata()
                .map_err(|_| missing("Reopened descriptor identity is unavailable."))?;
            if !actual.is_file()
                || actual.nlink() != 1
                || actual.len() > cap
                || (actual.dev(), actual.ino()) != (held.dev(), held.ino())
            {
                return Err(error(
                    AuthorityErrorKind::WrongIdentity,
                    "Descriptor alias does not reopen its held source.",
                ));
            }
        }
        let name = CString::new(format!("cerebro-backup-{:032x}", rand::random::<u128>()))
            .map_err(|_| invalid("Scoped VFS name cannot be encoded."))?;
        // SAFETY: sqlite3_vfs_find initializes SQLite and returns its permanent
        // builtin VFS; copy only its C function table, not any owned allocation.
        let base = unsafe { ffi::sqlite3_vfs_find(c"unix-posix".as_ptr()) };
        if base.is_null() {
            return Err(missing("The POSIX SQLite VFS is unavailable."));
        }
        let vfs = unsafe { *base };
        let mut owner = Box::new(VfsOwner {
            vfs,
            base,
            name,
            alias,
            source: source.into(),
            identity: (held.dev(), held.ino()),
        });
        owner.vfs.pNext = ptr::null_mut();
        owner.vfs.zName = owner.name.as_ptr();
        owner.vfs.xOpen = Some(open_main);
        owner.vfs.xFullPathname = Some(full_path);
        owner.vfs.xAccess = Some(access);
        owner.vfs.xDelete = Some(deny_delete);
        owner.vfs.xSetSystemCall = None;
        owner.vfs.xGetSystemCall = None;
        owner.vfs.xNextSystemCall = None;
        // SAFETY: owner is boxed at a stable address and is retained through
        // connection close. This registration never becomes the default.
        if unsafe { ffi::sqlite3_vfs_register(&mut owner.vfs, 0) } != ffi::SQLITE_OK {
            return Err(missing("Scoped readonly SQLite VFS registration failed."));
        }
        #[cfg(test)]
        super::source_open_hook(source);
        no_sidecars(source)?;
        let flags = OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_NOFOLLOW;
        let conn = Connection::open_with_flags_and_vfs(
            Path::new(
                owner
                    .alias
                    .to_str()
                    .map_err(|_| invalid("Descriptor alias is invalid."))?,
            ),
            flags,
            owner
                .name
                .to_str()
                .map_err(|_| invalid("Scoped VFS name is invalid."))?,
        )
        .map_err(|_| missing("Pinned source SQLite cannot be opened."))?;
        let pinned = Self {
            conn,
            owner,
            pin,
            guard,
        };
        pinned.validate()?;
        pinned
            .conn
            .busy_timeout(std::time::Duration::ZERO)
            .map_err(|_| missing("Pinned source lock policy is unavailable."))?;
        pinned
            .conn
            .pragma_update(None, "trusted_schema", false)
            .map_err(|_| invalid("Pinned source schema policy is unavailable."))?;
        // Hold the actual unix-posix shared read lock for the complete source
        // capture and online Backup. This is a readonly transaction, not recovery.
        pinned
            .conn
            .execute_batch("BEGIN")
            .map_err(|_| missing("Pinned source read transaction cannot begin."))?;
        let _: i64 = pinned
            .conn
            .query_row("SELECT count(*) FROM sqlite_schema", [], |row| row.get(0))
            .map_err(|_| invalid("Pinned source schema is unreadable."))?;
        pinned.validate()?;
        Ok(pinned)
    }
    /// Identity of the already-owned pin; no extra database pathname handle.
    pub(super) fn identity(&self) -> (u64, u64) { self.owner.identity }
    pub(super) fn validate(&self) -> Result<(), AuthorityError> {
        no_sidecars(&self.owner.source)?;
        let current = fs::symlink_metadata(&self.owner.source).map_err(|_| {
            error(
                AuthorityErrorKind::WrongIdentity,
                "Source metadata disappeared.",
            )
        })?;
        let held = self
            .pin
            .metadata()
            .map_err(|_| missing("Pinned source identity disappeared."))?;
        if !current.is_file()
            || current.file_type().is_symlink()
            || current.nlink() != 1
            || held.nlink() != 1
            || !held.is_file()
            || (current.dev(), current.ino()) != self.owner.identity
            || (held.dev(), held.ino()) != self.owner.identity
        {
            return Err(error(
                AuthorityErrorKind::WrongIdentity,
                "Pinned source path changed identity.",
            ));
        }
        self.guard.validate()?;
        store::handle_unmoved(&self.conn)
    }
}
