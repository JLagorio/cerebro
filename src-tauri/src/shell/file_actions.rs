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
                "Save the copy outside this vault and choose a different file from the original."
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
    let source_meta = source.file.metadata().map_err(|_| refusal("changed"))?;
    let check = || -> Result<(), Refusal> {
        // The active vault may change while the native save panel is open.
        // A missing/unreadable config cannot turn off this protection.
        let vault = std::fs::canonicalize(bytes::root_dir(config, "0")?)
            .map_err(|_| bytes::refusal("no_such_root"))?;
        let actual_parent = descriptor_path(&parent)?;
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
                if same_file(&meta, &source_meta) {
                    return Err(refusal("inside_vault"));
                }
                if !meta.is_file() {
                    return Err(refusal("changed"));
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(refusal("desktop_failed")),
        }
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
        source
            .file
            .rewind()
            .map_err(|_| refusal("desktop_failed"))?;
        std::io::copy(&mut source.file, &mut output).map_err(|_| refusal("desktop_failed"))?;
        output.sync_all().map_err(|_| refusal("desktop_failed"))?;
        check()?;
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
    if result.is_err() {
        // SAFETY: cleanup names only our unpredictable create_new temporary
        // entry relative to its still-owned directory descriptor.
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
}
