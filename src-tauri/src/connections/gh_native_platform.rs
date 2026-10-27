//! macOS-only OS boundary for the selected gh adapter. No caller-supplied paths,
//! inherited environment, account enumeration, config reads or provider calls.
use super::*;
use super::super::gh_credentials::GhProcess;
use crate::spawn::private_output::{start_private_output, CapturePoll, FailureKind, PrivateFailure};
use std::ffi::OsStr;
use std::fs::{self, DirBuilder, Metadata};
use std::os::unix::{ffi::OsStrExt, fs::{DirBuilderExt, MetadataExt}};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

const LOCATIONS: [&str; 2] = ["/opt/homebrew/bin/gh", "/usr/local/bin/gh"];
static CAPTURE_OCCUPIED: AtomicBool = AtomicBool::new(false);

/// Construct only inside an admitted original-owner worker. Construction does
/// no I/O. Its native closure must return true when that exact attempt loses
/// authority (cancel/reconnect/revoke/retired owner), never consult React state.
/// The public Unavailable worker is intentionally not changed by this adapter.
impl NativeGhProcess {
    pub(crate) fn new(cancelled: impl Fn() -> bool + Send + 'static) -> Self {
        Self { cancelled: Box::new(cancelled) }
    }
}

struct CapturePermit;
impl CapturePermit {
    fn acquire() -> Result<Self, ConnectionError> {
        CAPTURE_OCCUPIED.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| Self).map_err(|_| ConnectionError::Unavailable)
    }
}
impl Drop for CapturePermit {
    fn drop(&mut self) { CAPTURE_OCCUPIED.store(false, Ordering::Release); }
}
impl GhProcess for NativeGhProcess {
    fn capture_token(&self, recipe: &GhTokenCommand) -> Result<SecretValue, ConnectionError> {
        check_cancelled(self.cancelled.as_ref())?;
        // One native capture at once, held through help, token and actual reap.
        // Concurrent requests fail unavailable rather than starting extra work.
        let _permit = CapturePermit::acquire()?;
        let native = NativeExecutor::discover()?;
        check_cancelled(self.cancelled.as_ref())?;
        let empty = EmptyConfig::create(native.uid)?;
        capture_selected(&native.context, &empty.path, recipe, &native, self.cancelled.as_ref())
    }
}

#[derive(Clone, PartialEq, Eq)]
struct PathPin {
    path: PathBuf,
    device: u64,
    inode: u64,
    bytes: u64,
    modified_seconds: i64,
    modified_nanos: i64,
    changed_seconds: i64,
    changed_nanos: i64,
    uid: u32,
    gid: u32,
    mode: u32,
}
impl PathPin {
    fn new(path: &Path, metadata: &Metadata) -> Self {
        Self {
            path: path.to_owned(), device: metadata.dev(), inode: metadata.ino(),
            bytes: metadata.len(), modified_seconds: metadata.mtime(),
            modified_nanos: metadata.mtime_nsec(), changed_seconds: metadata.ctime(),
            changed_nanos: metadata.ctime_nsec(), uid: metadata.uid(),
            gid: metadata.gid(), mode: metadata.mode(),
        }
    }
}
struct NativeExecutor {
    context: GhNativeContext,
    location: PathBuf,
    uid: u32,
    executable_paths: Vec<PathPin>,
    config_paths: Vec<PathPin>,
}
fn io_error(error: std::io::Error) -> ConnectionError {
    match error.kind() {
        std::io::ErrorKind::NotFound => ConnectionError::SignInRequired,
        _ => ConnectionError::Unavailable,
    }
}
fn trusted_metadata(path: &Path, uid: u32, directory: bool) -> Result<Metadata, ConnectionError> {
    let metadata = fs::symlink_metadata(path).map_err(io_error)?;
    if metadata.file_type().is_symlink()
        || (directory && !metadata.is_dir())
        || (!directory && !metadata.is_file())
        || (metadata.uid() != 0 && metadata.uid() != uid)
        || metadata.mode() & 0o022 != 0
    {
        return Err(ConnectionError::UnsafePath);
    }
    Ok(metadata)
}
/// Check every lexical directory without following an ancestor symlink. The
/// selected install's leaf gh symlink alone is allowed (Homebrew's layout).
fn directory_chain(path: &Path, uid: u32) -> Result<Vec<PathPin>, ConnectionError> {
    if !path.is_absolute() || path.components().any(|part| matches!(
        part, std::path::Component::ParentDir | std::path::Component::CurDir
    )) { return Err(ConnectionError::UnsafePath); }
    let mut pins = Vec::new();
    for directory in path.ancestors() {
        pins.push(PathPin::new(directory, &trusted_metadata(directory, uid, true)?));
    }
    Ok(pins)
}
fn executable_at(location: &Path, uid: u32) -> Result<(ExecutablePin, Vec<PathPin>), ConnectionError> {
    let parent = location.parent().ok_or(ConnectionError::UnsafePath)?;
    let mut paths = directory_chain(parent, uid)?;
    let origin = fs::symlink_metadata(location).map_err(io_error)?;
    if (!origin.file_type().is_symlink() && !origin.is_file())
        || (origin.uid() != 0 && origin.uid() != uid)
    { return Err(ConnectionError::UnsafePath); }
    paths.push(PathPin::new(location, &origin));
    let canonical = fs::canonicalize(location).map_err(io_error)?;
    // A Homebrew/user-local link cannot select arbitrary content elsewhere.
    let install_root = if location.starts_with("/opt/homebrew/") { Path::new("/opt/homebrew") }
        else if location.starts_with("/usr/local/") { Path::new("/usr/local") }
        else { return Err(ConnectionError::UnsafePath); };
    if !canonical.starts_with(install_root) { return Err(ConnectionError::UnsafePath); }
    paths.extend(directory_chain(canonical.parent().ok_or(ConnectionError::UnsafePath)?, uid)?);
    let metadata = trusted_metadata(&canonical, uid, false)?;
    if metadata.mode() & 0o111 == 0 || metadata.mode() & 0o6000 != 0 {
        return Err(ConnectionError::UnsafePath);
    }
    Ok((ExecutablePin {
        canonical, device: metadata.dev(), inode: metadata.ino(), bytes: metadata.len(),
        modified_seconds: metadata.mtime(), modified_nanos: metadata.mtime_nsec(),
    }, paths))
}
fn config_at(home: &Path, uid: u32) -> Result<Vec<PathPin>, ConnectionError> {
    let mut paths = directory_chain(home, uid)?;
    if fs::symlink_metadata(home).map_err(io_error)?.uid() != uid {
        return Err(ConnectionError::UnsafePath);
    }
    let root = home.join(".config/gh");
    paths.extend(directory_chain(&root, uid)?);
    paths.extend(config_files(&root, uid)?);
    Ok(paths)
}
fn config_files(root: &Path, uid: u32) -> Result<Vec<PathPin>, ConnectionError> {
    let mut paths = Vec::new();
    for (name, required) in [("hosts.yml", true), ("config.yml", false)] {
        let path = root.join(name);
        match trusted_metadata(&path, uid, false) {
            Ok(metadata) => {
                if metadata.uid() != uid || (required && metadata.mode() & 0o077 != 0) {
                    return Err(ConnectionError::UnsafePath);
                }
                paths.push(PathPin::new(&path, &metadata));
            }
            Err(ConnectionError::SignInRequired) if !required => {}
            Err(error) => return Err(error),
        }
    }
    // Metadata only: neither hosts.yml nor config.yml is opened/read/parsed.
    Ok(paths)
}
fn native_home() -> Result<(u32, PathBuf), ConnectionError> {
    // Fixed bounded storage; no inherited HOME/XDG/GH_CONFIG_DIR is consulted.
    let mut storage = [0u8; 16_384];
    let mut record = std::mem::MaybeUninit::<libc::passwd>::uninit();
    let mut result = std::ptr::null_mut();
    // SAFETY: geteuid has no pointer inputs. getpwuid_r writes only the supplied
    // record/buffer; the returned home pointer is checked within that buffer.
    let uid = unsafe { libc::geteuid() };
    let status = unsafe { libc::getpwuid_r(uid, record.as_mut_ptr(), storage.as_mut_ptr().cast(), storage.len(), &mut result) };
    if status != 0 || result.is_null() || result != record.as_mut_ptr() {
        return Err(ConnectionError::Unavailable);
    }
    // SAFETY: successful getpwuid_r initialized this exact passwd record.
    let record = unsafe { record.assume_init() };
    if record.pw_uid != uid { return Err(ConnectionError::Unavailable); }
    let start = record.pw_dir as usize;
    let offset = start.checked_sub(storage.as_ptr() as usize)
        .filter(|offset| *offset < storage.len()).ok_or(ConnectionError::UnsafePath)?;
    let bytes = std::ffi::CStr::from_bytes_until_nul(&storage[offset..])
        .map_err(|_| ConnectionError::UnsafePath)?.to_bytes();
    let home = PathBuf::from(OsStr::from_bytes(bytes));
    if !home.is_absolute() || home == Path::new("/") { return Err(ConnectionError::UnsafePath); }
    Ok((uid, home))
}
impl NativeExecutor {
    fn discover() -> Result<Self, ConnectionError> {
        let (uid, native_home) = native_home()?;
        let config_paths = config_at(&native_home, uid)?;
        for location in LOCATIONS {
            let location = PathBuf::from(location);
            // Absence alone permits trying the other supported installation.
            // An unsafe/replaced/unreadable selected install never falls back.
            match fs::symlink_metadata(&location) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(_) => return Err(ConnectionError::Unavailable),
                Ok(_) => {}
            }
            let (executable, executable_paths) = executable_at(&location, uid).map_err(|error| {
                if error == ConnectionError::UnsafePath { error } else { ConnectionError::Unavailable }
            })?;
            return Ok(Self {
                context: GhNativeContext { executable, native_home, neutral_cwd: PathBuf::from("/") },
                location, uid, executable_paths, config_paths,
            });
        }
        Err(ConnectionError::Unavailable)
    }
}
impl GhExecutor for NativeExecutor {
    fn revalidate(&self, context: &GhNativeContext) -> Result<(), ConnectionError> {
        let (uid, home) = native_home().map_err(|_| ConnectionError::SourceChanged)?;
        if uid != self.uid || home != context.native_home || context.neutral_cwd != Path::new("/") {
            return Err(ConnectionError::SourceChanged);
        }
        let (executable, paths) = executable_at(&self.location, self.uid)
            .map_err(|_| ConnectionError::SourceChanged)?;
        let config = config_at(&home, uid).map_err(|_| ConnectionError::SourceChanged)?;
        if executable != context.executable || paths != self.executable_paths || config != self.config_paths {
            return Err(ConnectionError::SourceChanged);
        }
        Ok(())
    }
    fn capture(&self, command: &mut Command, cancelled: &dyn Fn() -> bool) -> Result<PrivateOutput, ConnectionError> {
        check_cancelled(cancelled)?;
        let mut child = start_private_output(command).map_err(channel_error)?;
        // This local owner is retained until the direct child actually reaps,
        // including cancellation and pathological OS cleanup. No detached waiter.
        loop {
            match child.poll(cancelled()) {
                CapturePoll::Pending | CapturePoll::Reaping => std::thread::sleep(Duration::from_millis(5)),
                CapturePoll::Finished => return child.take_result().ok_or(ConnectionError::Unavailable)?
                    .map_err(channel_error),
            }
        }
    }
}
fn channel_error(failure: PrivateFailure) -> ConnectionError {
    match failure.kind {
        FailureKind::Cancelled => ConnectionError::Cancelled,
        _ => ConnectionError::Unavailable,
    }
}

struct EmptyConfig {
    path: PathBuf,
    pin: PathPin,
}
impl EmptyConfig {
    fn create(uid: u32) -> Result<Self, ConnectionError> {
        // Fixed canonical system temp root; do not use inherited TMPDIR. A
        // private 0700 directory remains owned through the child's actual reap.
        let root = Path::new("/private/tmp");
        let metadata = fs::symlink_metadata(root).map_err(io_error)?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() || metadata.uid() != 0
            || metadata.mode() & 0o1000 == 0 { return Err(ConnectionError::UnsafePath); }
        let path = root.join(format!("cerebro-gh-help-{}", super::super::opaque_id()));
        DirBuilder::new().mode(0o700).create(&path).map_err(|_| ConnectionError::Unavailable)?;
        let metadata = fs::symlink_metadata(&path).map_err(io_error)?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() || metadata.uid() != uid
            || metadata.mode() & 0o077 != 0 { return Err(ConnectionError::UnsafePath); }
        Ok(Self { pin: PathPin::new(&path, &metadata), path })
    }
}
impl Drop for EmptyConfig {
    fn drop(&mut self) {
        // Never recursively enumerate/delete arbitrary or substituted contents.
        // gh help should leave this empty. Unexpected entries remain local for
        // explicit repair; no cleanup traverses the user's configuration.
        if let Ok(metadata) = fs::symlink_metadata(&self.path) {
            let current = PathPin::new(&self.path, &metadata);
            if current.device == self.pin.device && current.inode == self.pin.inode
                && current.uid == self.pin.uid && metadata.is_dir() && !metadata.file_type().is_symlink()
            { let _ = fs::remove_dir(&self.path); }
        }
    }
}

#[cfg(test)]
#[path = "gh_native_platform_tests.rs"]
mod tests;
