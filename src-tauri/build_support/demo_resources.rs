//! Package a sanitized working corpus: ordinary untracked content is included,
//! while named runtime files and the shared policy's private mail roots are not.
//! This is not a Git tracked-only snapshot. Bare Cargo needs neither Node nor Git.

use std::fs::{self, File, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

const MAIL_POLICY: &str = include_str!("../../shared/policy/mail.v1.json");

fn private_roots(json: &str) -> io::Result<Vec<String>> {
    let invalid =
        || io::Error::other("demo resources: mail policy needs safe kept_out_of_git folders");
    let table: serde_json::Value = serde_json::from_str(json).map_err(|_| invalid())?;
    let roots = table["kept_out_of_git"].as_array().ok_or_else(invalid)?;
    if roots.is_empty() {
        return Err(invalid());
    }
    roots
        .iter()
        .map(|root| {
            let root = root
                .as_str()
                .and_then(|root| root.strip_suffix('/'))
                .ok_or_else(invalid)?;
            if root
                .split('/')
                .any(|part| part.is_empty() || part == "." || part == "..")
                || !root
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"._-/".contains(&byte))
            {
                return Err(invalid());
            }
            Ok(root.to_ascii_lowercase())
        })
        .collect()
}

fn excluded(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    matches!(
        name.as_str(),
        ".cerebro"
            | ".trash"
            | ".git"
            | ".hg"
            | ".svn"
            | ".bzr"
            | ".ds_store"
            | ".appledouble"
            | ".lsoverride"
            | ".spotlight-v100"
            | ".trashes"
            | ".fseventsd"
            | ".temporaryitems"
            | "__macosx"
    ) || name.starts_with("._")
}

fn refusal(path: &Path, reason: &str) -> io::Error {
    io::Error::other(format!("demo resources: {} {reason}", path.display()))
}

fn directory(path: &Path) -> io::Result<()> {
    let meta = fs::symlink_metadata(path)?;
    if meta.file_type().is_symlink() || !meta.is_dir() {
        return Err(refusal(path, "must be a real directory, not a link"));
    }
    Ok(())
}

fn copy_tree(
    source: &Path,
    destination: &Path,
    relative: &str,
    private: &[String],
) -> io::Result<()> {
    directory(source)?;
    let mut entries = fs::read_dir(source)?.collect::<io::Result<Vec<_>>>()?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let name = entry.file_name();
        let name = name
            .to_str()
            .ok_or_else(|| refusal(&entry.path(), "has a non-UTF-8 name"))?;
        let relative = if relative.is_empty() {
            name.to_owned()
        } else {
            format!("{relative}/{name}")
        };
        // Walked paths are already relative, with real components. Match the
        // policy roots case-insensitively, just as the mail/Git boundary does.
        // Excluded entries are never opened or traversed, even if links.
        if excluded(name)
            || private
                .iter()
                .any(|root| relative.eq_ignore_ascii_case(root))
        {
            continue;
        }
        let path = entry.path();
        let target = destination.join(name);
        let meta = fs::symlink_metadata(&path)?;
        if meta.file_type().is_symlink() {
            return Err(refusal(&path, "is a symlink; package real source files"));
        }
        if meta.is_dir() {
            fs::create_dir(&target)?;
            copy_tree(&path, &target, &relative, private)?;
        } else if meta.is_file() {
            // Copy bytes only: no decoding, line-ending conversion or macOS
            // extended metadata. Destination files are newly created here.
            io::copy(&mut File::open(&path)?, &mut File::create(&target)?)?;
        } else {
            return Err(refusal(&path, "is not a regular file or directory"));
        }
    }
    Ok(())
}

struct Scratch(PathBuf);

impl Scratch {
    fn new(parent: &Path) -> io::Result<Self> {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        for _ in 0..100 {
            let path = parent.join(format!(
                ".demo-stage-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            match fs::create_dir(&path) {
                Ok(()) => return Ok(Self(path)),
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error),
            }
        }
        Err(refusal(
            parent,
            "could not allocate a fresh staging directory",
        ))
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        // Only a freshly allocated child of the generated output directory.
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn lock(parent: &Path) -> io::Result<File> {
    let path = parent.join(".demo-resources.lock");
    let file = match OpenOptions::new().write(true).create_new(true).open(&path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            let meta = fs::symlink_metadata(&path)?;
            if meta.file_type().is_symlink() || !meta.is_file() {
                return Err(refusal(&path, "is not a regular lock file"));
            }
            OpenOptions::new().write(true).open(&path)?
        }
        Err(error) => return Err(error),
    };
    let until = Instant::now() + Duration::from_secs(30);
    loop {
        match file.try_lock() {
            Ok(()) => return Ok(file),
            Err(fs::TryLockError::WouldBlock) if Instant::now() < until => {
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(fs::TryLockError::WouldBlock) => {
                return Err(refusal(parent, "is busy in another build; try again"));
            }
            Err(fs::TryLockError::Error(error)) => return Err(error),
        }
    }
}

/// Replace `<output>/demo-vault` with a sanitized snapshot of `source`.
/// `output` is a generated sibling tree, never inside or above the source.
/// Hold the returned lock until Tauri finishes copying its build resources.
pub fn stage(source: &Path, output: &Path) -> io::Result<File> {
    let private = private_roots(MAIL_POLICY)?;
    directory(source)?;
    let source = source.canonicalize()?;
    let parent = output
        .parent()
        .ok_or_else(|| refusal(output, "needs an existing parent directory"))?
        .canonicalize()?;
    let name = output
        .file_name()
        .ok_or_else(|| refusal(output, "needs a generated directory name"))?;
    let output = parent.join(name);
    if output.starts_with(&source) || source.starts_with(&output) {
        return Err(refusal(&output, "must be separate from the source corpus"));
    }
    match fs::create_dir(&output) {
        Ok(()) => (),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => directory(&output)?,
        Err(error) => return Err(error),
    }
    let held = lock(&output)?;
    let target = output.join("demo-vault");
    match fs::symlink_metadata(&target) {
        Ok(_) => directory(&target)?,
        Err(error) if error.kind() == io::ErrorKind::NotFound => (),
        Err(error) => return Err(error),
    }
    let scratch = Scratch::new(&output)?;
    let fresh = scratch.0.join("fresh");
    fs::create_dir(&fresh)?;
    copy_tree(&source, &fresh, "", &private)?;
    let previous = scratch.0.join("previous");
    let replaced = match fs::rename(&target, &previous) {
        Ok(()) => true,
        Err(error) if error.kind() == io::ErrorKind::NotFound => false,
        Err(error) => return Err(error),
    };
    if let Err(error) = fs::rename(&fresh, &target) {
        if replaced {
            if let Err(restore) = fs::rename(&previous, &target) {
                // Preserve the previous generated snapshot for recovery if
                // even the rollback failed; never remove the source corpus.
                let recovery = previous.display().to_string();
                std::mem::forget(scratch);
                return Err(io::Error::other(format!(
                    "demo resources: publish failed ({error}); restore failed ({restore}); previous snapshot remains at {recovery}"
                )));
            }
        }
        return Err(error);
    }
    Ok(held)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let scratch = Scratch::new(&std::env::temp_dir()).unwrap();
            let fixture = Self(scratch.0.clone());
            std::mem::forget(scratch);
            fs::create_dir(fixture.0.join("source")).unwrap();
            fixture
        }
        fn source(&self) -> PathBuf {
            self.0.join("source")
        }
        fn output(&self) -> PathBuf {
            self.0.join("resources")
        }
        fn target(&self) -> PathBuf {
            self.output().join("demo-vault")
        }
        fn write(&self, path: &str, bytes: &[u8]) {
            let path = self.source().join(path);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, bytes).unwrap();
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn packages_exact_bytes_and_authored_hidden_content_without_git() {
        let f = Fixture::new();
        for (path, bytes) in [
            ("notes/a.md", &b"\xef\xbb\xbf# A\r\n"[..]),
            ("images/picture.bin", &b"\0\xff\x01"[..]),
            (".comments/notes/a.md.json", &b"{\"threads\":[]}"[..]),
            (".gitignore", &b".cerebro/\n"[..]),
            (".authored/kept.md", &b"hidden content"[..]),
        ] {
            f.write(path, bytes);
        }
        let _held = stage(&f.source(), &f.output()).unwrap();
        for path in [
            "notes/a.md",
            "images/picture.bin",
            ".comments/notes/a.md.json",
            ".gitignore",
            ".authored/kept.md",
        ] {
            assert_eq!(
                fs::read(f.source().join(path)).unwrap(),
                fs::read(f.target().join(path)).unwrap()
            );
        }
        assert!(!f.source().join(".git").exists());
    }

    #[test]
    fn excludes_transient_components_at_every_depth_without_touching_source() {
        let f = Fixture::new();
        for path in [
            ".cerebro/connectors.json",
            ".trash/a.md",
            ".git/config",
            "notes/.Hg/store",
            ".svn/entries",
            ".bzr/state",
            ".DS_Store",
            "notes/._a.md",
            "__MACOSX/file",
            ".Spotlight-V100/data",
            ".Trashes/file",
            ".fseventsd/file",
            ".TemporaryItems/file",
            ".AppleDouble/file",
            ".LSOverride",
        ] {
            f.write(path, b"must not ship");
        }
        f.write("notes/keep.md", b"kept");
        let _held = stage(&f.source(), &f.output()).unwrap();
        assert_eq!(fs::read_dir(f.target()).unwrap().count(), 1);
        assert_eq!(fs::read_dir(f.target().join("notes")).unwrap().count(), 1);
        assert_eq!(
            fs::read(f.source().join(".cerebro/connectors.json")).unwrap(),
            b"must not ship"
        );
    }

    #[test]
    fn refresh_removes_deleted_and_previously_leaked_files() {
        let f = Fixture::new();
        f.write("old.md", b"old");
        drop(stage(&f.source(), &f.output()).unwrap());
        fs::create_dir(f.target().join(".cerebro")).unwrap();
        fs::write(f.target().join(".cerebro/leak"), b"stale").unwrap();
        fs::remove_file(f.source().join("old.md")).unwrap();
        f.write("new.md", b"new");
        let _held = stage(&f.source(), &f.output()).unwrap();
        assert!(!f.target().join("old.md").exists());
        assert!(!f.target().join(".cerebro").exists());
        assert_eq!(fs::read(f.target().join("new.md")).unwrap(), b"new");
    }

    #[test]
    fn shared_mail_roots_are_private_but_other_source_pages_and_comments_ship() {
        let f = Fixture::new();
        for root in private_roots(MAIL_POLICY).unwrap() {
            let path = format!("{}/private.md", root.to_ascii_uppercase());
            f.write(&path, b"private cached mail");
        }
        for path in [
            "sources/issues/one.md",
            "sources/mailbox/page.md",
            ".comments/sources/issues/one.md.json",
            "notes/sources/mail/example.md",
        ] {
            f.write(path, b"ordinary authored content");
        }
        let _held = stage(&f.source(), &f.output()).unwrap();
        for root in private_roots(MAIL_POLICY).unwrap() {
            let path = format!("{}/private.md", root.to_ascii_uppercase());
            assert!(!f.target().join(&path).exists());
            assert_eq!(
                fs::read(f.source().join(path)).unwrap(),
                b"private cached mail"
            );
        }
        for path in [
            "sources/issues/one.md",
            "sources/mailbox/page.md",
            ".comments/sources/issues/one.md.json",
            "notes/sources/mail/example.md",
        ] {
            assert_eq!(
                fs::read(f.target().join(path)).unwrap(),
                b"ordinary authored content"
            );
        }
    }

    #[test]
    fn missing_or_unsafe_mail_policy_refuses_instead_of_dropping_privacy() {
        for roots in [
            serde_json::json!(null),
            serde_json::json!([]),
            serde_json::json!(["../private/"]),
            serde_json::json!(["/private/"]),
            serde_json::json!(["private"]),
        ] {
            assert!(
                private_roots(&serde_json::json!({"kept_out_of_git": roots}).to_string()).is_err()
            );
        }
    }

    #[test]
    fn source_and_generated_output_cannot_overlap() {
        let f = Fixture::new();
        f.write("keep.md", b"unchanged");
        assert!(stage(&f.source(), &f.source().join("generated")).is_err());
        assert!(stage(&f.source(), &f.0).is_err());
        assert!(!f.source().join("generated").exists());
        assert_eq!(fs::read(f.source().join("keep.md")).unwrap(), b"unchanged");
    }

    #[cfg(unix)]
    #[test]
    fn a_source_link_refuses_and_preserves_the_last_complete_snapshot() {
        use std::os::unix::fs::symlink;
        let f = Fixture::new();
        f.write("keep.md", b"before");
        drop(stage(&f.source(), &f.output()).unwrap());
        f.write("keep.md", b"after");
        fs::write(f.0.join("outside"), b"private").unwrap();
        symlink(f.0.join("outside"), f.source().join("link.md")).unwrap();
        assert!(stage(&f.source(), &f.output())
            .unwrap_err()
            .to_string()
            .contains("symlink"));
        assert_eq!(fs::read(f.target().join("keep.md")).unwrap(), b"before");
        assert!(!f.target().join("link.md").exists());
        assert_eq!(fs::read(f.0.join("outside")).unwrap(), b"private");
    }

    #[cfg(unix)]
    #[test]
    fn destination_and_lock_links_never_reach_their_targets() {
        use std::os::unix::fs::symlink;
        let f = Fixture::new();
        let outside = f.0.join("outside");
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("keep"), b"private").unwrap();
        symlink(&outside, f.output()).unwrap();
        assert!(stage(&f.source(), &f.output()).is_err());
        fs::remove_file(f.output()).unwrap();
        fs::create_dir(f.output()).unwrap();
        symlink(&outside, f.target()).unwrap();
        assert!(stage(&f.source(), &f.output()).is_err());
        fs::remove_file(f.target()).unwrap();
        fs::remove_file(f.output().join(".demo-resources.lock")).unwrap();
        symlink(
            outside.join("keep"),
            f.output().join(".demo-resources.lock"),
        )
        .unwrap();
        assert!(stage(&f.source(), &f.output()).is_err());
        assert_eq!(fs::read(outside.join("keep")).unwrap(), b"private");
        assert_eq!(fs::read_dir(outside).unwrap().count(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn a_special_file_refuses_without_waiting_for_a_writer() {
        let f = Fixture::new();
        let _socket = std::os::unix::net::UnixListener::bind(f.source().join("socket")).unwrap();
        assert!(stage(&f.source(), &f.output())
            .unwrap_err()
            .to_string()
            .contains("not a regular file"));
        assert!(!f.target().exists());
    }
}
