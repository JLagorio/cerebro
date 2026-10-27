//! Guarded actions on a root file (M66.4). Bytes and the open verdict come
//! from one contained descriptor. Open uses a macOS file-reference URL made
//! from that descriptor, so a replacement at its old path cannot become the
//! program LaunchServices opens. The original remains editable; no snapshot
//! is silently substituted. References are transient, never persisted.

#[cfg(target_os = "macos")]
use std::ffi::OsString;
#[cfg(target_os = "macos")]
use std::fs::File;
#[cfg(target_os = "macos")]
use std::io::{Read, Seek};
#[cfg(target_os = "macos")]
use std::path::{Path, PathBuf};

use crate::files::bytes;
#[cfg(target_os = "macos")]
use crate::files::kinds::{self, OpenPolicy};
#[cfg(target_os = "macos")]
use bytes::OpenedFile;
use bytes::Refusal;

#[cfg(target_os = "macos")]
pub const CONFIRM_OPEN: &str =
    "Cerebro can't tell what this kind of file does. Open it only if you trust where it came from.";

#[derive(Debug, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum FileActionOutcome {
    Opened,
    Revealed,
    Previewed,
    Cancelled,
    Saved { destination: String },
}

fn refusal(code: &str) -> Refusal {
    Refusal {
        code: code.into(),
        message: match code {
            "denied" => "This looks like a program or script, so Cerebro won't open it.",
            "inside_vault" => {
                "Choose a different file outside your vaults and Cerebro application data."
            }
            "changed" => "This file changed. Reopen it and try again.",
            "macos_only" => "This action is available on macOS only.",
            _ => "The desktop action couldn't be completed. Try again.",
        }
        .into(),
    }
}

/// UI and desktop side effects are injected together. A test never opens
/// Finder, an application, Quick Look, or a native dialog.
#[cfg(target_os = "macos")]
trait Actions {
    fn confirm(&self) -> bool;
    fn choose_copy(&self, name: &str) -> Result<Option<PathBuf>, Refusal>;
    fn open(&self, args: &[OsString]) -> Result<bool, String>;
    fn preview(&self, path: &Path) -> Result<(), String>;
}

#[cfg(target_os = "macos")]
fn verdict(opened: &mut OpenedFile) -> Result<OpenPolicy, Refusal> {
    let meta = opened
        .file
        .metadata()
        .map_err(|_| bytes::refusal("not_found"))?;
    opened
        .file
        .rewind()
        .map_err(|_| bytes::refusal("not_found"))?;
    let mut head = Vec::with_capacity(8192);
    opened
        .file
        .by_ref()
        .take(8192)
        .read_to_end(&mut head)
        .map_err(|_| bytes::refusal("not_found"))?;
    Ok(kinds::open_policy_for(
        &opened.path.to_string_lossy(),
        &meta,
        Some(&head),
    ))
}

#[cfg(target_os = "macos")]
fn same_file(left: &std::fs::Metadata, right: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt as _;
    left.dev() == right.dev() && left.ino() == right.ino()
}

/// Reveal and Quick Look do not execute a target, but still refuse a name
/// which no longer names the file we checked. Open does not use this path.
#[cfg(target_os = "macos")]
fn current_path(opened: &OpenedFile) -> Result<&Path, Refusal> {
    let current = std::fs::symlink_metadata(&opened.path).map_err(|_| refusal("changed"))?;
    let held = opened.file.metadata().map_err(|_| refusal("changed"))?;
    if !current.is_file() || !same_file(&current, &held) {
        return Err(refusal("changed"));
    }
    Ok(&opened.path)
}

#[cfg(target_os = "macos")]
fn reference_argument(opened: &OpenedFile) -> Result<OsString, Refusal> {
    use objc2_foundation::{NSString, NSURL};
    use std::os::fd::AsRawFd as _;
    // /dev/fd is the kernel's reference to our owned descriptor, not a path
    // supplied by the caller. Foundation produces the opaque file identity.
    // The owned file stays alive until /usr/bin/open has handed it off.
    let fd_path = NSString::from_str(&format!("/dev/fd/{}", opened.file.as_raw_fd()));
    let reference = NSURL::fileURLWithPath(&fd_path)
        .fileReferenceURL()
        .filter(|url| url.isFileReferenceURL())
        .ok_or_else(|| refusal("changed"))?;
    reference
        .absoluteString()
        .map(|value| OsString::from(value.to_string()))
        .ok_or_else(|| refusal("changed"))
}

#[cfg(target_os = "macos")]
fn open_with(actions: &impl Actions, mut opened: OpenedFile) -> Result<FileActionOutcome, Refusal> {
    #[cfg(target_os = "macos")]
    {
        opened.path = descriptor_path(&opened.file)?;
    }
    let policy = verdict(&mut opened)?;
    match policy {
        OpenPolicy::Deny => return Err(refusal("denied")),
        OpenPolicy::Confirm if !actions.confirm() => return Ok(FileActionOutcome::Cancelled),
        _ => {}
    }
    open_after_initial_verdict(actions, opened, policy == OpenPolicy::Confirm)
}

#[cfg(target_os = "macos")]
fn open_after_initial_verdict(
    actions: &impl Actions,
    mut opened: OpenedFile,
    mut confirmed: bool,
) -> Result<FileActionOutcome, Refusal> {
    // A dialog may be open for minutes, and a rename can change a known
    // extension into an unknown one. Rejudge both bytes and current name;
    // a newly required confirmation cannot borrow the earlier Allow.
    loop {
        #[cfg(target_os = "macos")]
        {
            opened.path = descriptor_path(&opened.file)?;
        }
        match verdict(&mut opened)? {
            OpenPolicy::Deny => return Err(refusal("denied")),
            OpenPolicy::Confirm if !confirmed => {
                if !actions.confirm() {
                    return Ok(FileActionOutcome::Cancelled);
                }
                confirmed = true;
            }
            _ => break,
        }
    }
    let target = reference_argument(&opened)?;
    if !actions
        .open(&[target])
        .map_err(|_| refusal("desktop_failed"))?
    {
        return Err(refusal("desktop_failed"));
    }
    Ok(FileActionOutcome::Opened)
}

#[cfg(target_os = "macos")]
fn reveal_with(
    actions: &impl Actions,
    mut opened: OpenedFile,
) -> Result<FileActionOutcome, Refusal> {
    let _ = verdict(&mut opened)?;
    let path = current_path(&opened)?;
    if !actions
        .open(&["-R".into(), path.as_os_str().to_owned()])
        .map_err(|_| refusal("desktop_failed"))?
    {
        return Err(refusal("desktop_failed"));
    }
    Ok(FileActionOutcome::Revealed)
}

#[cfg(target_os = "macos")]
fn preview_with(
    actions: &impl Actions,
    mut opened: OpenedFile,
) -> Result<FileActionOutcome, Refusal> {
    let _ = verdict(&mut opened)?;
    actions
        .preview(current_path(&opened)?)
        .map_err(|_| refusal("desktop_failed"))?;
    Ok(FileActionOutcome::Previewed)
}

#[cfg(target_os = "macos")]
fn save_with(
    actions: &impl Actions,
    config: &Path,
    mut opened: OpenedFile,
    root_id: &str,
) -> Result<FileActionOutcome, Refusal> {
    let _ = verdict(&mut opened)?;
    let initial_vault = std::fs::canonicalize(bytes::root_dir(config, "0")?)
        .map_err(|_| bytes::refusal("no_such_root"))?;
    let mut protected_vaults = vec![initial_vault];
    if root_id == bytes::rules().vault_root {
        protected_vaults.push(opened.root.clone());
    }
    let name = opened
        .path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy();
    let Some(destination) = actions.choose_copy(&name)? else {
        return Ok(FileActionOutcome::Cancelled);
    };
    copy_to(config, &protected_vaults, &mut opened, &destination)?;
    Ok(FileActionOutcome::Saved {
        destination: destination.to_string_lossy().into_owned(),
    })
}

/// Save one explicitly selected recovery copy outside protected application roots.
pub(crate) fn save_recovery_copy(
    app: &tauri::AppHandle,
    config: &std::path::Path,
    vault: &std::path::Path,
    name: &str,
    bytes: &[u8],
) -> Result<Option<String>, Refusal> {
    #[cfg(target_os = "macos")]
    {
        save_recovery_with(&NativeActions(app), config, vault, name, bytes)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, config, vault, name, bytes);
        Err(refusal("macos_only"))
    }
}

#[cfg(target_os = "macos")]
fn save_recovery_with(
    actions: &impl Actions,
    config: &Path,
    vault: &Path,
    name: &str,
    content: &[u8],
) -> Result<Option<String>, Refusal> {
    if content.len() as u64 > crate::vault::recovery::limits().entry_bytes as u64 {
        return Err(refusal("desktop_failed"));
    }
    let protected = [
        std::fs::canonicalize(vault).map_err(|_| refusal("changed"))?,
        std::fs::canonicalize(config).map_err(|_| refusal("changed"))?,
        std::fs::canonicalize(bytes::root_dir(config, "0")?)
            .map_err(|_| bytes::refusal("no_such_root"))?,
    ];
    let Some(destination) = actions.choose_copy(name)? else {
        return Ok(None);
    };
    copy_payload_to(config, &protected, &destination, None, |output| {
        std::io::Write::write_all(output, content).map_err(|_| refusal("desktop_failed"))
    })?;
    Ok(Some(destination.to_string_lossy().into_owned()))
}

/// A native save choice is an in-memory capability, never a wire pathname.
/// Pin the selected directory identity before returning to the webview.
pub(crate) struct DraftCopyDestination {
    path: std::path::PathBuf,
    #[cfg(target_os = "macos")]
    parent: File,
    #[cfg(target_os = "macos")]
    parent_path: PathBuf,
}
impl DraftCopyDestination {
    pub(crate) fn extension(&self) -> Option<&str> {
        self.path.extension().and_then(|value| value.to_str())
    }
}
#[cfg(target_os = "macos")]
fn pin_draft_destination(path: PathBuf) -> Result<DraftCopyDestination, Refusal> {
    use std::os::unix::fs::OpenOptionsExt as _;
    let parent_path = path
        .parent()
        .filter(|parent| parent.is_absolute())
        .ok_or_else(|| refusal("changed"))?
        .canonicalize()
        .map_err(|_| refusal("changed"))?;
    let parent = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(&parent_path)
        .map_err(|_| refusal("changed"))?;
    if descriptor_path(&parent)? != parent_path {
        return Err(refusal("changed"));
    }
    Ok(DraftCopyDestination {
        path,
        parent,
        parent_path,
    })
}
pub(crate) fn choose_draft_copy(
    app: &tauri::AppHandle,
    name: &str,
) -> Result<Option<DraftCopyDestination>, Refusal> {
    #[cfg(target_os = "macos")]
    {
        NativeActions(app)
            .choose_copy(name)?
            .map(pin_draft_destination)
            .transpose()
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, name);
        Err(refusal("macos_only"))
    }
}
pub(crate) fn publish_draft_copy(
    config: &std::path::Path,
    vault: &std::path::Path,
    choice: DraftCopyDestination,
    content: &[u8],
) -> Result<String, Refusal> {
    #[cfg(target_os = "macos")]
    {
        let protected = [
            vault.canonicalize().map_err(|_| refusal("changed"))?,
            config.canonicalize().map_err(|_| refusal("changed"))?,
        ];
        let held_parent = choice.parent.metadata().map_err(|_| refusal("changed"))?;
        copy_payload_to_pinned(
            config,
            &protected,
            &choice.path,
            None,
            Some(&held_parent),
            Some(&choice.parent_path),
            Some(protected[0].as_path()),
            |output| {
                std::io::Write::write_all(output, content).map_err(|_| refusal("desktop_failed"))
            },
        )?;
        Ok(choice.path.to_string_lossy().into_owned())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (config, vault, choice, content);
        Err(refusal("macos_only"))
    }
}

/// Stream an archive through the existing retained native save destination.
/// The callback supplies bounded archive bytes; it creates no filesystem authority.
pub(crate) fn publish_archive_copy(
    config: &Path,
    protected_roots: &[PathBuf],
    original_vault: &Path,
    choice: DraftCopyDestination,
    write: impl FnOnce(&mut std::fs::File) -> Result<(), Refusal>,
) -> Result<String, Refusal> {
    #[cfg(target_os = "macos")]
    {
        let mut protected = vec![
            original_vault
                .canonicalize()
                .map_err(|_| refusal("changed"))?,
            config.canonicalize().map_err(|_| refusal("changed"))?,
        ];
        for root in protected_roots {
            protected.push(root.canonicalize().map_err(|_| refusal("changed"))?);
        }
        let held_parent = choice.parent.metadata().map_err(|_| refusal("changed"))?;
        copy_payload_to_pinned(
            config,
            &protected,
            &choice.path,
            None,
            Some(&held_parent),
            Some(&choice.parent_path),
            Some(protected[0].as_path()),
            write,
        )?;
        Ok(choice.path.to_string_lossy().into_owned())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (config, protected_roots, original_vault, choice, write);
        Err(refusal("macos_only"))
    }
}

/// macOS supplies the current pathname of an owned descriptor without
/// reopening a caller-controlled name. Used to check the save parent again
/// immediately before publishing the fully written copy.
#[cfg(target_os = "macos")]
fn descriptor_path(file: &File) -> Result<PathBuf, Refusal> {
    use std::os::{fd::AsRawFd, unix::ffi::OsStringExt};
    let mut buffer = [0u8; libc::PATH_MAX as usize];
    // SAFETY: F_GETPATH writes at most PATH_MAX bytes to this live buffer;
    // the borrowed file descriptor is valid for the entire call.
    let result = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETPATH, buffer.as_mut_ptr()) };
    if result < 0 {
        return Err(refusal("changed"));
    }
    let length = buffer
        .iter()
        .position(|byte| *byte == 0)
        .ok_or_else(|| refusal("changed"))?;
    Ok(PathBuf::from(OsString::from_vec(buffer[..length].to_vec())))
}

#[cfg(target_os = "macos")]
fn copy_to(
    config: &Path,
    protected_vaults: &[PathBuf],
    source: &mut OpenedFile,
    destination: &Path,
) -> Result<(), Refusal> {
    let source_meta = source.file.metadata().map_err(|_| refusal("changed"))?;
    copy_payload_to(
        config,
        protected_vaults,
        destination,
        Some(&source_meta),
        |output| {
            source
                .file
                .rewind()
                .map_err(|_| refusal("desktop_failed"))?;
            std::io::copy(&mut source.file, output).map_err(|_| refusal("desktop_failed"))?;
            Ok(())
        },
    )
}

#[cfg(target_os = "macos")]
fn copy_payload_to(
    config: &Path,
    protected_vaults: &[PathBuf],
    destination: &Path,
    source_meta: Option<&std::fs::Metadata>,
    write: impl FnOnce(&mut File) -> Result<(), Refusal>,
) -> Result<(), Refusal> {
    copy_payload_to_pinned(
        config,
        protected_vaults,
        destination,
        source_meta,
        None,
        None,
        None,
        write,
    )
}

#[cfg(target_os = "macos")]
fn selected_copy_destination(path: &Path) -> Result<(), Refusal> {
    let context = match crate::workspace_service::authority::context() {
        Ok(context) => context,
        Err(error) => {
            // Standalone legacy desktop fixtures have no installed app context.
            // Selected fixtures install a scoped context and exercise the same
            // guard as production. Production never allows missing context.
            #[cfg(test)]
            {
                let _ = error;
                return Ok(());
            }
            #[cfg(not(test))]
            return Err(Refusal {
                code: "capability_unavailable".into(),
                message: error.message,
            });
        }
    };
    crate::workspace_service::native_admission::guard_external_write(&context, path).map_err(
        |error| Refusal {
            code: "capability_unavailable".into(),
            message: error.message,
        },
    )
}

#[cfg(target_os = "macos")]
fn owned_temporary(parent: &File, name: &std::ffi::CStr, created: &File) -> bool {
    use std::os::{fd::AsRawFd, unix::fs::MetadataExt};
    let Ok(held) = created.metadata() else {
        return false;
    };
    let mut named = std::mem::MaybeUninit::<libc::stat>::uninit();
    // SAFETY: live borrowed directory FD, single-component terminated name,
    // and storage for one stat. No symlink is followed and no object is opened.
    if unsafe {
        libc::fstatat(
            parent.as_raw_fd(),
            name.as_ptr(),
            named.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    } != 0
    {
        return false;
    }
    // SAFETY: successful fstatat initialized the complete stat object.
    let named = unsafe { named.assume_init() };
    held.is_file()
        && named.st_mode & libc::S_IFMT == libc::S_IFREG
        && named.st_dev as u64 == held.dev()
        && named.st_ino == held.ino()
}

#[cfg(target_os = "macos")]
#[expect(
    clippy::too_many_arguments,
    reason = "the active vault, protected vaults, source and expected parent and route are separate rechecks against the pinned descriptor before the writer runs"
)]
fn copy_payload_to_pinned(
    config: &Path,
    protected_vaults: &[PathBuf],
    destination: &Path,
    source_meta: Option<&std::fs::Metadata>,
    expected_parent: Option<&std::fs::Metadata>,
    expected_parent_route: Option<&Path>,
    expected_active: Option<&Path>,
    write: impl FnOnce(&mut File) -> Result<(), Refusal>,
) -> Result<(), Refusal> {
    use std::{
        ffi::CString,
        os::{
            fd::{AsRawFd, FromRawFd},
            unix::{ffi::OsStrExt, fs::OpenOptionsExt},
        },
    };
    let parent_path = destination
        .parent()
        .filter(|path| path.is_absolute())
        .ok_or_else(|| refusal("desktop_failed"))?;
    let name = destination
        .file_name()
        .ok_or_else(|| refusal("desktop_failed"))?;
    let name = CString::new(name.as_bytes()).map_err(|_| refusal("desktop_failed"))?;
    let parent_path = std::fs::canonicalize(parent_path).map_err(|_| refusal("desktop_failed"))?;
    let parent = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(&parent_path)
        .map_err(|_| refusal("desktop_failed"))?;
    if let Some(expected) = expected_parent {
        let actual = parent.metadata().map_err(|_| refusal("changed"))?;
        if !same_file(expected, &actual) {
            return Err(refusal("changed"));
        }
    }
    let check = || -> Result<(), Refusal> {
        // The active vault may change while the native save panel is open.
        // A missing/unreadable config cannot turn off this protection.
        let vault = std::fs::canonicalize(bytes::root_dir(config, "0")?)
            .map_err(|_| bytes::refusal("no_such_root"))?;
        if expected_active.is_some_and(|expected| expected != vault) {
            return Err(refusal("changed"));
        }
        let actual_parent = descriptor_path(&parent)?;
        // Never recapture a renamed original directory or a retargeted route.
        // The descriptor is the publication authority; names can only deny.
        if actual_parent != parent_path
            || expected_parent_route.is_some_and(|expected| expected != actual_parent)
            || destination
                .parent()
                .ok_or_else(|| refusal("changed"))?
                .canonicalize()
                .map_err(|_| refusal("changed"))?
                != actual_parent
        {
            return Err(refusal("changed"));
        }
        if actual_parent.starts_with(&vault)
            || protected_vaults
                .iter()
                .any(|vault| actual_parent.starts_with(vault))
        {
            return Err(refusal("inside_vault"));
        }
        let target = actual_parent.join(destination.file_name().unwrap_or_default());
        match std::fs::symlink_metadata(&target) {
            Ok(meta) => {
                if let Ok(resolved) = std::fs::canonicalize(&target) {
                    if resolved.starts_with(&vault)
                        || protected_vaults
                            .iter()
                            .any(|vault| resolved.starts_with(vault))
                    {
                        return Err(refusal("inside_vault"));
                    }
                }
                if source_meta.is_some_and(|source| same_file(&meta, source)) {
                    return Err(refusal("inside_vault"));
                }
                if !meta.is_file() {
                    return Err(refusal("changed"));
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(refusal("desktop_failed")),
        }
        selected_copy_destination(&target)?;
        Ok(())
    };
    check()?;
    let temporary = CString::new(format!(".cerebro-copy-{}", crate::ledger::new_run_id()))
        .map_err(|_| refusal("desktop_failed"))?;
    // SAFETY: the directory descriptor and single-component NUL-terminated
    // name live through openat; create_new cannot truncate an existing file.
    let fd = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            temporary.as_ptr(),
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0o600,
        )
    };
    if fd < 0 {
        return Err(refusal("desktop_failed"));
    }
    // SAFETY: openat returned a new descriptor, owned exactly once here.
    let mut output = unsafe { File::from_raw_fd(fd) };
    let result = (|| {
        write(&mut output)?;
        output.sync_all().map_err(|_| refusal("desktop_failed"))?;
        check()?;
        if !owned_temporary(&parent, &temporary, &output) {
            return Err(refusal("changed"));
        }
        // SAFETY: both names are single components within the pinned parent.
        // Rename replaces a directory entry; it never follows a destination
        // symlink or writes through an existing hard link into the vault.
        if unsafe {
            libc::renameat(
                parent.as_raw_fd(),
                temporary.as_ptr(),
                parent.as_raw_fd(),
                name.as_ptr(),
            )
        } != 0
        {
            return Err(refusal("desktop_failed"));
        }
        let _ = parent.sync_all();
        Ok(())
    })();
    if result.is_err() && owned_temporary(&parent, &temporary, &output) {
        // SAFETY: cleanup requires the exact original regular-file identity,
        // relative to its still-owned parent; a substituted name is preserved.
        unsafe {
            libc::unlinkat(parent.as_raw_fd(), temporary.as_ptr(), 0);
        }
    }
    result
}

#[cfg(target_os = "macos")]
struct NativeActions<'a>(&'a tauri::AppHandle);

#[cfg(target_os = "macos")]
impl Actions for NativeActions<'_> {
    fn confirm(&self) -> bool {
        use tauri_plugin_dialog::{
            DialogExt as _, MessageDialogButtons, MessageDialogKind, MessageDialogResult,
        };
        self.0
            .dialog()
            .message(CONFIRM_OPEN)
            .title("Open this file?")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom(
                "Open".into(),
                "Cancel".into(),
            ))
            .blocking_show_with_result()
            == MessageDialogResult::Custom("Open".into())
    }
    fn choose_copy(&self, name: &str) -> Result<Option<PathBuf>, Refusal> {
        use tauri_plugin_dialog::DialogExt as _;
        self.0
            .dialog()
            .file()
            .set_file_name(name)
            .blocking_save_file()
            .map(|picked| picked.into_path().map_err(|_| refusal("desktop_failed")))
            .transpose()
    }
    fn open(&self, args: &[OsString]) -> Result<bool, String> {
        use super::open::Desktop as _;
        super::open::SystemDesktop.open(args)
    }
    fn preview(&self, path: &Path) -> Result<(), String> {
        use super::open::Desktop as _;
        super::open::SystemDesktop.quick_look(path)
    }
}

#[derive(Clone, Copy)]
pub(crate) enum Action {
    Open,
    Reveal,
    Preview,
    Save,
}

#[cfg(target_os = "macos")]
fn dispatch(
    desktop: &impl Actions,
    config: &Path,
    root: &str,
    path: &str,
    action: Action,
) -> Result<FileActionOutcome, Refusal> {
    let opened = bytes::locate(config, root, path)?;
    match action {
        Action::Open => open_with(desktop, opened),
        Action::Reveal => reveal_with(desktop, opened),
        Action::Preview => preview_with(desktop, opened),
        Action::Save => save_with(desktop, config, opened, root),
    }
}

pub(crate) fn act(
    app: &tauri::AppHandle,
    root: &str,
    path: &str,
    action: Action,
) -> Result<FileActionOutcome, Refusal> {
    let config = crate::app_config::app_dir(app).map_err(|_| bytes::refusal("no_such_root"))?;
    #[cfg(target_os = "macos")]
    {
        dispatch(&NativeActions(app), &config, root, path, action)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (bytes::locate(&config, root, path)?, action);
        Err(refusal("macos_only"))
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use crate::vault::testutil::{temp_vault, write};
    use std::cell::{Cell, RefCell};

    #[derive(Default)]
    struct Recorder {
        yes: Cell<bool>,
        asks: Cell<usize>,
        destination: RefCell<Option<PathBuf>>,
        opened: RefCell<Vec<Vec<OsString>>>,
        previews: RefCell<Vec<PathBuf>>,
        on_confirm: RefCell<Option<Box<dyn FnOnce()>>>,
        on_choose: RefCell<Option<Box<dyn FnOnce()>>>,
    }
    impl Actions for Recorder {
        fn confirm(&self) -> bool {
            self.asks.set(self.asks.get() + 1);
            if let Some(change) = self.on_confirm.borrow_mut().take() {
                change();
            }
            self.yes.get()
        }
        fn choose_copy(&self, _name: &str) -> Result<Option<PathBuf>, Refusal> {
            if let Some(change) = self.on_choose.borrow_mut().take() {
                change();
            }
            Ok(self.destination.borrow().clone())
        }
        fn open(&self, args: &[OsString]) -> Result<bool, String> {
            self.opened.borrow_mut().push(args.to_vec());
            Ok(true)
        }
        fn preview(&self, path: &Path) -> Result<(), String> {
            self.previews.borrow_mut().push(path.into());
            Ok(())
        }
    }
    fn config(vault: &Path) -> PathBuf {
        let config = temp_vault("file-action-config");
        crate::app_config::save(
            &config,
            &crate::app_config::AppConfig {
                last_vault: Some(vault.to_string_lossy().into_owned()),
                ..Default::default()
            },
        )
        .unwrap();
        config
    }
    fn opened(root: &Path, path: &str) -> OpenedFile {
        bytes::open_in(root, "0", path).unwrap()
    }

    #[test]
    fn actions_take_only_a_file_inside_the_root() {
        use std::os::unix::fs::symlink;
        let root = temp_vault("file-actions-contained");
        std::fs::create_dir(root.join("folder")).unwrap();
        symlink("/etc/hosts", root.join("outside")).unwrap();
        let config = config(&root);
        let desktop = Recorder::default();
        for path in ["../etc/hosts", "/etc/hosts", "outside", "folder", "missing"] {
            for action in [Action::Open, Action::Reveal, Action::Preview, Action::Save] {
                assert!(
                    dispatch(&desktop, &config, "0", path, action).is_err(),
                    "{path}"
                );
            }
        }
        assert_eq!(desktop.asks.get(), 0);
        assert!(desktop.opened.borrow().is_empty());
        assert!(desktop.previews.borrow().is_empty());
        let source = include_str!("../roots_commands.rs");
        for name in [
            "open_file_outside",
            "reveal_file",
            "quick_look_file",
            "save_file_copy",
        ] {
            assert!(source.contains(&format!("pub fn {name}(")));
        }
        std::fs::remove_dir_all(root).unwrap();
        std::fs::remove_dir_all(config).unwrap();
    }

    #[test]
    fn deny_never_reaches_the_desktop() {
        let root = temp_vault("file-actions-deny");
        write(&root, "image.png", "\u{7f}ELFnot-an-image");
        let desktop = Recorder::default();
        assert_eq!(
            open_with(&desktop, opened(&root, "image.png"))
                .unwrap_err()
                .code,
            "denied"
        );
        assert_eq!(desktop.asks.get(), 0);
        assert!(desktop.opened.borrow().is_empty());
        assert_eq!(
            reveal_with(&desktop, opened(&root, "image.png")).unwrap(),
            FileActionOutcome::Revealed
        );
        assert_eq!(
            preview_with(&desktop, opened(&root, "image.png")).unwrap(),
            FileActionOutcome::Previewed
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn confirm_asks_and_a_cancel_opens_nothing() {
        let root = temp_vault("file-actions-confirm");
        write(&root, "data.unknown", "data");
        let desktop = Recorder::default();
        assert_eq!(
            open_with(&desktop, opened(&root, "data.unknown")).unwrap(),
            FileActionOutcome::Cancelled
        );
        assert_eq!(desktop.asks.get(), 1);
        assert!(desktop.opened.borrow().is_empty());
        desktop.yes.set(true);
        assert_eq!(
            open_with(&desktop, opened(&root, "data.unknown")).unwrap(),
            FileActionOutcome::Opened
        );
        assert_eq!(desktop.opened.borrow().len(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_program_written_during_confirmation_does_not_borrow_the_allow() {
        let root = temp_vault("file-actions-confirm-race");
        write(&root, "data.unknown", "data");
        let desktop = Recorder::default();
        desktop.yes.set(true);
        let path = root.join("data.unknown");
        *desktop.on_confirm.borrow_mut() =
            Some(Box::new(move || std::fs::write(path, b"\x7fELF").unwrap()));
        assert_eq!(
            open_with(&desktop, opened(&root, "data.unknown"))
                .unwrap_err()
                .code,
            "denied"
        );
        assert!(desktop.opened.borrow().is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_newly_unknown_extension_needs_confirmation_after_an_initial_allow() {
        let root = temp_vault("file-actions-later-confirm");
        write(&root, "report.pdf", "original");
        let mut file = opened(&root, "report.pdf");
        assert_eq!(verdict(&mut file).unwrap(), OpenPolicy::Allow);
        std::fs::rename(root.join("report.pdf"), root.join("report.unknown")).unwrap();
        let desktop = Recorder::default();
        assert_eq!(
            open_after_initial_verdict(&desktop, file, false).unwrap(),
            FileActionOutcome::Cancelled
        );
        assert_eq!(desktop.asks.get(), 1);
        assert!(desktop.opened.borrow().is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn open_passes_one_reference_to_the_original_canonical_file() {
        use objc2_foundation::{NSString, NSURL};
        let root = temp_vault("file-actions-open");
        write(&root, "report.pdf", "original");
        let original = opened(&root, "report.pdf");
        let expected = NSURL::fileURLWithPath(&NSString::from_str(original.path.to_str().unwrap()))
            .fileReferenceURL()
            .unwrap()
            .absoluteString()
            .unwrap()
            .to_string();
        // Even replacing the name BEFORE Foundation creates our reference
        // cannot redirect it: /dev/fd names the still-open original inode.
        std::fs::rename(root.join("report.pdf"), root.join("moved.pdf")).unwrap();
        write(&root, "report.pdf", "\u{7f}ELFreplacement");
        let desktop = Recorder::default();
        assert_eq!(
            open_with(&desktop, original).unwrap(),
            FileActionOutcome::Opened
        );
        assert_eq!(
            *desktop.opened.borrow(),
            vec![vec![OsString::from(expected)]]
        );
        assert_eq!(std::fs::read(root.join("moved.pdf")).unwrap(), b"original");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reveal_passes_dash_r_and_the_canonical_path() {
        let root = temp_vault("file-actions-reveal");
        write(&root, "report.pdf", "original");
        let file = opened(&root, "report.pdf");
        let path = file.path.clone();
        let desktop = Recorder::default();
        reveal_with(&desktop, file).unwrap();
        assert_eq!(
            *desktop.opened.borrow(),
            vec![vec![OsString::from("-R"), path.into_os_string()]]
        );
        let file = opened(&root, "report.pdf");
        std::fs::rename(root.join("report.pdf"), root.join("moved.pdf")).unwrap();
        write(&root, "report.pdf", "replacement");
        assert_eq!(preview_with(&desktop, file).unwrap_err().code, "changed");
        assert!(desktop.previews.borrow().is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn save_a_copy_refuses_the_vault_and_the_source() {
        use std::os::unix::fs::symlink;
        let vault = temp_vault("file-actions-save-vault");
        let root = temp_vault("file-actions-save-root");
        write(&root, "report.pdf", "original");
        write(&vault, "kept.md", "keep");
        let config = config(&vault);
        let desktop = Recorder::default();
        symlink(&vault, root.join("vault-link")).unwrap();
        std::fs::hard_link(root.join("report.pdf"), root.join("hard-link.pdf")).unwrap();
        for dest in [
            vault.join("copy.pdf"),
            root.join("report.pdf"),
            root.join("hard-link.pdf"),
            root.join("vault-link/copy.pdf"),
        ] {
            *desktop.destination.borrow_mut() = Some(dest);
            assert_eq!(
                save_with(&desktop, &config, opened(&root, "report.pdf"), "0")
                    .unwrap_err()
                    .code,
                "inside_vault"
            );
        }
        assert_eq!(
            std::fs::read_to_string(vault.join("kept.md")).unwrap(),
            "keep"
        );
        for dir in [vault, root, config] {
            std::fs::remove_dir_all(dir).unwrap();
        }
    }

    #[test]
    fn save_a_copy_copies_bytes_and_a_cancel_writes_nothing() {
        let vault = temp_vault("file-actions-copy-vault");
        write(&vault, "report.pdf", "original");
        let target = temp_vault("file-actions-copy-target");
        let config = config(&vault);
        let desktop = Recorder::default();
        assert_eq!(
            save_with(&desktop, &config, opened(&vault, "report.pdf"), "0").unwrap(),
            FileActionOutcome::Cancelled
        );
        assert_eq!(std::fs::read_dir(&target).unwrap().count(), 0);
        let file = opened(&vault, "report.pdf");
        std::fs::rename(vault.join("report.pdf"), vault.join("moved.pdf")).unwrap();
        write(&vault, "report.pdf", "replacement");
        let dest = target.join("copy.pdf");
        *desktop.destination.borrow_mut() = Some(dest.clone());
        assert_eq!(
            save_with(&desktop, &config, file, "0").unwrap(),
            FileActionOutcome::Saved {
                destination: dest.to_string_lossy().into_owned()
            }
        );
        assert_eq!(std::fs::read(&dest).unwrap(), b"original");
        assert_eq!(std::fs::read_dir(&target).unwrap().count(), 1);
        for dir in [vault, target, config] {
            std::fs::remove_dir_all(dir).unwrap();
        }
    }

    #[test]
    fn replacing_an_outside_hard_link_never_writes_through_it_into_the_vault() {
        let vault = temp_vault("file-actions-copy-hardlink-vault");
        write(&vault, "source.pdf", "source");
        write(&vault, "keep.md", "keep");
        let outside = temp_vault("file-actions-copy-hardlink-outside");
        let destination = outside.join("copy.pdf");
        std::fs::hard_link(vault.join("keep.md"), &destination).unwrap();
        let config = config(&vault);
        let desktop = Recorder::default();
        *desktop.destination.borrow_mut() = Some(destination.clone());
        save_with(&desktop, &config, opened(&vault, "source.pdf"), "0").unwrap();
        assert_eq!(std::fs::read(destination).unwrap(), b"source");
        assert_eq!(std::fs::read(vault.join("keep.md")).unwrap(), b"keep");
        for dir in [vault, outside, config] {
            std::fs::remove_dir_all(dir).unwrap();
        }
    }

    #[test]
    fn an_unavailable_current_vault_never_disables_the_copy_guard() {
        let root = temp_vault("file-actions-unavailable-vault");
        write(&root, "source.pdf", "source");
        let config = temp_vault("file-actions-unavailable-config");
        let desktop = Recorder::default();
        *desktop.destination.borrow_mut() = Some(root.join("copy.pdf"));
        assert_eq!(
            save_with(&desktop, &config, opened(&root, "source.pdf"), "0")
                .unwrap_err()
                .code,
            "no_such_root"
        );
        assert!(!root.join("copy.pdf").exists());
        for dir in [root, config] {
            std::fs::remove_dir_all(dir).unwrap();
        }
    }

    #[test]
    fn switching_vaults_during_the_save_dialog_protects_both_vaults() {
        let initial = temp_vault("file-actions-initial-vault");
        let current = temp_vault("file-actions-current-vault");
        write(&initial, "source.pdf", "source");
        let config = config(&initial);
        for destination in [initial.join("copy.pdf"), current.join("copy.pdf")] {
            crate::app_config::save(
                &config,
                &crate::app_config::AppConfig {
                    last_vault: Some(initial.to_string_lossy().into_owned()),
                    ..Default::default()
                },
            )
            .unwrap();
            let desktop = Recorder::default();
            *desktop.destination.borrow_mut() = Some(destination.clone());
            let new_vault = current.to_string_lossy().into_owned();
            let config_to_change = config.clone();
            *desktop.on_choose.borrow_mut() = Some(Box::new(move || {
                crate::app_config::save(
                    &config_to_change,
                    &crate::app_config::AppConfig {
                        last_vault: Some(new_vault),
                        ..Default::default()
                    },
                )
                .unwrap();
            }));
            assert_eq!(
                save_with(&desktop, &config, opened(&initial, "source.pdf"), "0")
                    .unwrap_err()
                    .code,
                "inside_vault"
            );
            assert!(!destination.exists());
        }
        for dir in [initial, current, config] {
            std::fs::remove_dir_all(dir).unwrap();
        }
    }

    #[test]
    fn the_source_root_stays_protected_if_the_vault_changes_before_the_dialog() {
        let original = temp_vault("file-actions-original-root");
        let current = temp_vault("file-actions-next-root");
        write(&original, "source.pdf", "source");
        let file = opened(&original, "source.pdf");
        let config = config(&current);
        let desktop = Recorder::default();
        let destination = original.join("copy.pdf");
        *desktop.destination.borrow_mut() = Some(destination.clone());
        assert_eq!(
            save_with(&desktop, &config, file, "0").unwrap_err().code,
            "inside_vault"
        );
        assert!(!destination.exists());
        // A mounted repository is an allowed destination outside the vault.
        assert!(matches!(
            save_with(&desktop, &config, opened(&original, "source.pdf"), "repo"),
            Ok(FileActionOutcome::Saved { .. })
        ));
        assert_eq!(std::fs::read(destination).unwrap(), b"source");
        for dir in [original, current, config] {
            std::fs::remove_dir_all(dir).unwrap();
        }
    }
    #[test]
    fn recovery_export_preserves_bytes_cancel_and_protected_destinations() {
        use std::os::unix::fs::symlink;
        let origin = temp_vault("recovery-export-origin");
        let current = temp_vault("recovery-export-current");
        let outside = temp_vault("recovery-export-outside");
        let config = config(&current);
        let desktop = Recorder::default();
        let bytes = b"\xef\xbb\xbf---\r\ntitle: Exact\r\n---\r\n# Old\r\n";
        assert_eq!(
            save_recovery_with(&desktop, &config, &origin, "page.md", bytes).unwrap(),
            None
        );
        assert_eq!(std::fs::read_dir(&outside).unwrap().count(), 0);
        let destination = outside.join("copy.md");
        *desktop.destination.borrow_mut() = Some(destination.clone());
        assert_eq!(
            save_recovery_with(&desktop, &config, &origin, "page.md", bytes).unwrap(),
            Some(destination.to_string_lossy().into_owned())
        );
        assert_eq!(std::fs::read(&destination).unwrap(), bytes);
        write(&origin, "kept.md", "keep");
        symlink(&origin, outside.join("origin-link")).unwrap();
        symlink(origin.join("kept.md"), outside.join("target-link.md")).unwrap();
        for target in [
            origin.join("copy.md"),
            current.join("copy.md"),
            config.join("copy.md"),
            outside.join("origin-link/copy.md"),
            outside.join("target-link.md"),
        ] {
            *desktop.destination.borrow_mut() = Some(target);
            assert!(save_recovery_with(&desktop, &config, &origin, "page.md", bytes).is_err());
        }
        let hardlink = outside.join("hardlink.md");
        std::fs::hard_link(origin.join("kept.md"), &hardlink).unwrap();
        *desktop.destination.borrow_mut() = Some(hardlink.clone());
        save_recovery_with(&desktop, &config, &origin, "page.md", bytes).unwrap();
        assert_eq!(std::fs::read(&hardlink).unwrap(), bytes);
        assert_eq!(std::fs::read(origin.join("kept.md")).unwrap(), b"keep");
        for dir in [origin, current, outside, config] {
            std::fs::remove_dir_all(dir).unwrap();
        }
    }

    #[test]
    fn recovery_export_rechecks_vault_after_dialog_and_refuses_unavailable_config() {
        let origin = temp_vault("recovery-export-switch-origin");
        let current = temp_vault("recovery-export-switch-current");
        let config = config(&origin);
        let desktop = Recorder::default();
        *desktop.destination.borrow_mut() = Some(current.join("copy.md"));
        let changed_config = config.clone();
        let changed_vault = current.to_string_lossy().into_owned();
        *desktop.on_choose.borrow_mut() = Some(Box::new(move || {
            crate::app_config::save(
                &changed_config,
                &crate::app_config::AppConfig {
                    last_vault: Some(changed_vault),
                    ..Default::default()
                },
            )
            .unwrap();
        }));
        assert!(save_recovery_with(&desktop, &config, &origin, "page.md", b"old").is_err());
        assert!(!current.join("copy.md").exists());
        let missing_config = temp_vault("recovery-export-missing-config");
        *desktop.destination.borrow_mut() = Some(current.join("copy.md"));
        assert!(save_recovery_with(&desktop, &missing_config, &origin, "page.md", b"old").is_err());
        assert!(!current.join("copy.md").exists());
        for dir in [origin, current, config, missing_config] {
            std::fs::remove_dir_all(dir).unwrap();
        }
    }
    #[test]
    fn retained_draft_choice_pins_parent_and_preserves_bytes_outside_protected_roots() {
        use std::os::unix::fs::symlink;
        let vault = temp_vault("draft-copy-vault");
        let outside = temp_vault("draft-copy-outside");
        let config = config(&vault);
        write(&vault, "kept.md", "keep");
        let content = b"\xef\xbb\xbfraw\r\n  text\r\n";
        let destination = outside.join("draft.md");
        let choice = pin_draft_destination(destination.clone()).unwrap();
        publish_draft_copy(&config, &vault, choice, content).unwrap();
        assert_eq!(std::fs::read(&destination).unwrap(), content);
        for path in [vault.join("copy.md"), config.join("copy.md")] {
            assert!(publish_draft_copy(
                &config,
                &vault,
                pin_draft_destination(path).unwrap(),
                content
            )
            .is_err());
        }
        let linked = outside.join("linked.md");
        symlink(vault.join("kept.md"), &linked).unwrap();
        assert!(publish_draft_copy(
            &config,
            &vault,
            pin_draft_destination(linked.clone()).unwrap(),
            content
        )
        .is_err());
        std::fs::remove_file(&linked).unwrap();
        std::fs::hard_link(vault.join("kept.md"), &linked).unwrap();
        publish_draft_copy(
            &config,
            &vault,
            pin_draft_destination(linked.clone()).unwrap(),
            content,
        )
        .unwrap();
        assert_eq!(std::fs::read(linked).unwrap(), content);
        assert_eq!(std::fs::read(vault.join("kept.md")).unwrap(), b"keep");
        let parent = outside.join("chosen");
        std::fs::create_dir(&parent).unwrap();
        let choice = pin_draft_destination(parent.join("draft.json")).unwrap();
        std::fs::rename(&parent, outside.join("moved")).unwrap();
        std::fs::create_dir(&parent).unwrap();
        assert!(publish_draft_copy(&config, &vault, choice, content).is_err());
        assert!(!parent.join("draft.json").exists());
        assert!(!outside.join("moved/draft.json").exists());
        let choice = pin_draft_destination(parent.join("draft.json")).unwrap();
        std::fs::remove_dir(&parent).unwrap();
        symlink(&vault, &parent).unwrap();
        assert!(publish_draft_copy(&config, &vault, choice, content).is_err());
        assert!(!vault.join("draft.json").exists());
        for directory in [vault, outside, config] {
            std::fs::remove_dir_all(directory).unwrap();
        }
    }
    #[test]
    fn retained_draft_commit_refuses_an_active_vault_switch_after_choice() {
        let vault = temp_vault("draft-copy-active");
        let other = temp_vault("draft-copy-other");
        let outside = temp_vault("draft-copy-active-outside");
        let config = config(&vault);
        let target = outside.join("draft.json");
        let choice = pin_draft_destination(target.clone()).unwrap();
        crate::app_config::save(
            &config,
            &crate::app_config::AppConfig {
                last_vault: Some(other.to_string_lossy().into_owned()),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(publish_draft_copy(&config, &vault, choice, b"recovery").is_err());
        assert!(!target.exists());
        for directory in [vault, other, outside, config] {
            std::fs::remove_dir_all(directory).unwrap();
        }
    }

    fn register_selected_copy_fixture(config: &Path, root: &Path) {
        use std::os::unix::fs::PermissionsExt as _;
        let registry = config.join("workspaces/bindings.v1.json");
        std::fs::create_dir_all(registry.parent().unwrap()).unwrap();
        std::fs::write(&registry,serde_json::json!({"version":1,"bindings":[{"workspaceId":"3ee5b6eb-9f80-4bac-9538-f2a0c5938a62","bodyRoot":root}]}).to_string()).unwrap();
        std::fs::set_permissions(&registry, std::fs::Permissions::from_mode(0o600)).unwrap();
        write(root,".cerebro/workspace-format.json",&serde_json::json!({"format":2,"authority":"sqlite_metadata","state":"activated","workspaceId":"3ee5b6eb-9f80-4bac-9538-f2a0c5938a62"}).to_string());
    }
    #[test]
    fn selected_destination_copy_refuses_before_staging_through_actual_save_route() {
        let current = temp_vault("m99-copy-current-legacy");
        let source = temp_vault("m99-copy-source-legacy");
        let selected = temp_vault("m99-copy-other-selected");
        let config = config(&current);
        write(&source, "source.pdf", "%PDF-1.4\nexact source\r\n");
        register_selected_copy_fixture(&config, &selected);
        crate::workspace_service::authority::with_fixture_context(
            crate::workspace_service::authority::AuthorityContext::new(config.clone()),
            || {
                let desktop = Recorder::default();
                let destination = selected.join("copy.pdf");
                *desktop.destination.borrow_mut() = Some(destination.clone());
                let saved = save_with(&desktop, &config, opened(&source, "source.pdf"), "external");
                let wrote = Cell::new(false);
                let second = selected.join("other.pdf");
                let staged = copy_payload_to(&config, &[], &second, None, |output| {
                    wrote.set(true);
                    std::io::Write::write_all(output, b"must not stage")
                        .map_err(|_| refusal("desktop_failed"))
                });
                assert!(
                    saved.is_err() && staged.is_err() && !wrote.get(),
                    "saved={saved:?}, staged={staged:?}, writer_called={}",
                    wrote.get()
                );
                assert_eq!(saved.unwrap_err().code, "capability_unavailable");
                assert!(!destination.exists() && !second.exists());
                assert!(!std::fs::read_dir(&selected).unwrap().any(|entry| entry
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".cerebro-copy-")));
            },
        );
        for path in [current, source, selected, config] {
            std::fs::remove_dir_all(path).unwrap();
        }
    }
    #[test]
    fn selected_destination_copy_revalidates_after_payload_before_publication() {
        let current = temp_vault("m99-copy-recheck-current");
        let selected = temp_vault("m99-copy-recheck-selected");
        let outside = temp_vault("m99-copy-recheck-outside");
        let config = config(&current);
        register_selected_copy_fixture(&config, &selected);
        let destination = outside.join("keep.pdf");
        std::fs::write(&destination, b"keep").unwrap();
        crate::workspace_service::authority::with_fixture_context(
            crate::workspace_service::authority::AuthorityContext::new(config.clone()),
            || {
                let wrote = Cell::new(false);
                let result = copy_payload_to(&config, &[], &destination, None, |output| {
                    wrote.set(true);
                    std::io::Write::write_all(output, b"must not publish")
                        .map_err(|_| refusal("desktop_failed"))?;
                    register_selected_copy_fixture(&config, &outside);
                    Ok(())
                });
                assert!(wrote.get());
                assert!(
                    result.is_err(),
                    "a destination became selected while the payload was staged"
                );
                assert_eq!(result.unwrap_err().code, "capability_unavailable");
                assert_eq!(std::fs::read(&destination).unwrap(), b"keep");
                assert!(!std::fs::read_dir(&outside).unwrap().any(|entry| entry
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".cerebro-copy-")));
            },
        );
        for path in [current, selected, outside, config] {
            std::fs::remove_dir_all(path).unwrap();
        }
    }
    #[test]
    fn selected_destination_copy_alias_stays_closed_when_known_authority_disappears() {
        let current = temp_vault("m99-copy-disappear-current");
        let source = temp_vault("m99-copy-disappear-source");
        let selected = temp_vault("m99-copy-disappear-selected");
        let outside = temp_vault("m99-copy-disappear-alias");
        let config = config(&current);
        write(&source, "source.pdf", "%PDF-1.4\nexact source\n");
        register_selected_copy_fixture(&config, &selected);
        std::os::unix::fs::symlink(&selected, outside.join("alias")).unwrap();
        crate::workspace_service::authority::with_fixture_context(
            crate::workspace_service::authority::AuthorityContext::new(config.clone()),
            || {
                assert!(matches!(
                    crate::workspace_service::authority::resolve(&selected).unwrap(),
                    crate::workspace_service::authority::Authority::Selected
                ));
                std::fs::remove_file(config.join("workspaces/bindings.v1.json")).unwrap();
                std::fs::remove_file(selected.join(".cerebro/workspace-format.json")).unwrap();
                let desktop = Recorder::default();
                *desktop.destination.borrow_mut() = Some(outside.join("alias/copy.pdf"));
                let result =
                    save_with(&desktop, &config, opened(&source, "source.pdf"), "external");
                assert!(result.is_err());
                assert_eq!(result.unwrap_err().code, "capability_unavailable");
                assert!(!selected.join("copy.pdf").exists());
            },
        );
        for path in [current, source, selected, outside, config] {
            std::fs::remove_dir_all(path).unwrap();
        }
    }
    #[test]
    fn selected_destination_copy_preserves_explicit_legacy_outside_bytes() {
        let current = temp_vault("m99-copy-outside-current");
        let source = temp_vault("m99-copy-outside-source");
        let selected = temp_vault("m99-copy-outside-selected");
        let outside = temp_vault("m99-copy-outside-target");
        let config = config(&current);
        let exact = b"%PDF-1.4\nexact outside copy\r\n";
        std::fs::write(source.join("source.pdf"), exact).unwrap();
        register_selected_copy_fixture(&config, &selected);
        crate::workspace_service::authority::with_fixture_context(
            crate::workspace_service::authority::AuthorityContext::new(config.clone()),
            || {
                let desktop = Recorder::default();
                let target = outside.join("copy.pdf");
                *desktop.destination.borrow_mut() = Some(target.clone());
                assert!(matches!(
                    save_with(&desktop, &config, opened(&source, "source.pdf"), "external")
                        .unwrap(),
                    FileActionOutcome::Saved { .. }
                ));
                assert_eq!(std::fs::read(target).unwrap(), exact);
                let dangling = outside.join("dangling.pdf");
                std::os::unix::fs::symlink(selected.join("never-created.pdf"), &dangling).unwrap();
                *desktop.destination.borrow_mut() = Some(dangling);
                assert_eq!(
                    save_with(&desktop, &config, opened(&source, "source.pdf"), "external")
                        .unwrap_err()
                        .code,
                    "changed"
                );
                assert!(!selected.join("never-created.pdf").exists());
            },
        );
        for path in [current, source, selected, outside, config] {
            std::fs::remove_dir_all(path).unwrap();
        }
    }
    #[test]
    fn selected_destination_copy_cannot_overwrite_installed_canonical_database_namespace() {
        let current = temp_vault("m99-copy-metadata-current");
        let source = temp_vault("m99-copy-metadata-source");
        let selected = temp_vault("m99-copy-metadata-selected");
        let config = config(&current);
        write(&source, "source.pdf", "%PDF-1.4\nsource bytes\r\n");
        register_selected_copy_fixture(&config, &selected);
        let destination =
            config.join("workspaces/3ee5b6eb-9f80-4bac-9538-f2a0c5938a62/workspace.db");
        std::fs::create_dir_all(destination.parent().unwrap()).unwrap();
        std::fs::write(&destination, b"canonical database bytes").unwrap();
        crate::workspace_service::authority::with_fixture_context(
            crate::workspace_service::authority::AuthorityContext::new(config.clone()),
            || {
                let desktop = Recorder::default();
                *desktop.destination.borrow_mut() = Some(destination.clone());
                let result =
                    save_with(&desktop, &config, opened(&source, "source.pdf"), "external");
                assert!(result.is_err());
                assert_eq!(result.unwrap_err().code, "capability_unavailable");
                assert_eq!(
                    std::fs::read(&destination).unwrap(),
                    b"canonical database bytes"
                );
                std::fs::remove_file(config.join("workspaces/bindings.v1.json")).unwrap();
                let result =
                    save_with(&desktop, &config, opened(&source, "source.pdf"), "external");
                assert!(result.is_err());
                assert_eq!(
                    std::fs::read(&destination).unwrap(),
                    b"canonical database bytes"
                );
            },
        );
        for path in [current, source, selected, config] {
            std::fs::remove_dir_all(path).unwrap();
        }
    }
    // Actual retained desktop publication seams. No assertions run in Drop.
    fn archive_temporary(parent: &Path) -> PathBuf {
        std::fs::read_dir(parent)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .find(|path| {
                path.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with(".cerebro-copy-")
            })
            .expect("actual create-new publication temporary")
    }
    #[test]
    fn archive_publication_stream_control_preserves_explicit_overwrite_and_exact_bytes() {
        let vault = temp_vault("archive-publish-control-vault");
        let outside = temp_vault("archive-publish-control-outside");
        let config = config(&vault);
        let target = outside.join("conversation.json");
        std::fs::write(&target, b"original chosen destination").unwrap();
        let choice = pin_draft_destination(target.clone()).unwrap();
        let result = publish_archive_copy(&config, &[], &vault, choice, |output| {
            use std::io::Write as _;
            output
                .write_all(b"{\"literal\":\"007\"}\r\n")
                .map_err(|_| refusal("desktop_failed"))
        });
        assert_eq!(result.unwrap(), target.to_string_lossy().into_owned());
        assert_eq!(
            std::fs::read(&target).unwrap(),
            b"{\"literal\":\"007\"}\r\n"
        );
        assert_eq!(std::fs::read_dir(&outside).unwrap().count(), 1);
        for path in [vault, outside, config] {
            std::fs::remove_dir_all(path).unwrap();
        }
    }
    #[test]
    fn archive_publication_refuses_original_parent_retarget_after_streaming() {
        use std::os::unix::fs::symlink;
        let vault = temp_vault("archive-publish-parent-vault");
        let outside = temp_vault("archive-publish-parent-outside");
        let config = config(&vault);
        let parent = outside.join("chosen");
        let moved = outside.join("original-moved");
        std::fs::create_dir(&parent).unwrap();
        let target = parent.join("conversation.json");
        std::fs::write(&target, b"keep original destination").unwrap();
        let choice = pin_draft_destination(target.clone()).unwrap();
        let result = publish_archive_copy(&config, &[], &vault, choice, |output| {
            use std::io::Write as _;
            output.write_all(b"private archive body").unwrap();
            std::fs::rename(&parent, &moved).unwrap();
            symlink(&vault, &parent).unwrap();
            Ok(())
        });
        assert!(
            result.is_err(),
            "a moved original choice cannot be recaptured through a fresh route"
        );
        assert_eq!(
            std::fs::read(moved.join("conversation.json")).unwrap(),
            b"keep original destination"
        );
        assert!(!vault.join("conversation.json").exists());
        assert_eq!(
            std::fs::read_dir(&moved).unwrap().count(),
            1,
            "owned original temporary is cleaned through its held parent"
        );
        for path in [vault, outside, config] {
            std::fs::remove_dir_all(path).unwrap();
        }
    }
    #[test]
    fn archive_publication_does_not_publish_a_replaced_temporary() {
        let vault = temp_vault("archive-publish-temp-vault");
        let outside = temp_vault("archive-publish-temp-outside");
        let config = config(&vault);
        let target = outside.join("conversation.json");
        std::fs::write(&target, b"keep chosen destination").unwrap();
        let choice = pin_draft_destination(target.clone()).unwrap();
        let mut replaced = None;
        let result = publish_archive_copy(&config, &[], &vault, choice, |output| {
            use std::io::Write as _;
            output.write_all(b"private archive body").unwrap();
            let temporary = archive_temporary(&outside);
            std::fs::rename(&temporary, outside.join("externally-displaced-original")).unwrap();
            std::fs::write(&temporary, b"unrelated replacement").unwrap();
            replaced = Some(temporary);
            Ok(())
        });
        assert!(
            result.is_err(),
            "publication must bind the temporary name to the original created FD"
        );
        assert_eq!(std::fs::read(&target).unwrap(), b"keep chosen destination");
        assert_eq!(
            std::fs::read(replaced.unwrap()).unwrap(),
            b"unrelated replacement"
        );
        assert_eq!(
            std::fs::read(outside.join("externally-displaced-original")).unwrap(),
            b"private archive body"
        );
        for path in [vault, outside, config] {
            std::fs::remove_dir_all(path).unwrap();
        }
    }
    #[test]
    fn archive_publication_failed_stream_cleanup_preserves_a_replaced_temporary() {
        let vault = temp_vault("archive-publish-cleanup-vault");
        let outside = temp_vault("archive-publish-cleanup-outside");
        let config = config(&vault);
        let target = outside.join("conversation.json");
        std::fs::write(&target, b"keep chosen destination").unwrap();
        let choice = pin_draft_destination(target.clone()).unwrap();
        let mut replaced = None;
        let result = publish_archive_copy(&config, &[], &vault, choice, |output| {
            use std::io::Write as _;
            output.write_all(b"private partial archive").unwrap();
            let temporary = archive_temporary(&outside);
            std::fs::rename(&temporary, outside.join("externally-displaced-original")).unwrap();
            std::fs::write(&temporary, b"unrelated replacement").unwrap();
            replaced = Some(temporary);
            Err(refusal("desktop_failed"))
        });
        assert!(result.is_err());
        assert_eq!(std::fs::read(&target).unwrap(), b"keep chosen destination");
        assert_eq!(
            std::fs::read(replaced.unwrap()).unwrap(),
            b"unrelated replacement",
            "failed cleanup must not unlink a replacement"
        );
        assert_eq!(
            std::fs::read(outside.join("externally-displaced-original")).unwrap(),
            b"private partial archive"
        );
        for path in [vault, outside, config] {
            std::fs::remove_dir_all(path).unwrap();
        }
    }
}
