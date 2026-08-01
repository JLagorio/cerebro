//! Seeding the demo vault out of the app bundle.
//!
//! In the repo, "Open demo vault" means the folder sitting next to the source.
//! In a downloaded `.app` there is no repo, and the button that promises a
//! vault can only open a folder picker onto a machine that has no vault on it
//! — a first run that dead-ends. So the demo vault ships inside the bundle as
//! a resource and is copied out on first use, into a real folder the user can
//! see, edit, and point any other tool at. Copied, not read in place: a vault
//! is writable by definition, and the bundle is not.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

/// The folder name the demo lands in, under the user's documents directory.
pub const FOLDER_NAME: &str = "Cerebro Demo Vault";

/// Return the path to a writable demo vault, copying it out of the bundle the
/// first time. Subsequent calls return the existing folder untouched — this is
/// the user's vault now, and edits made in it survive reopening.
pub fn ensure(app: &AppHandle) -> Result<String, String> {
    let destinations = destinations(app);
    if destinations.is_empty() {
        return Err("no writable folder to put the demo vault in".into());
    }
    if let Some(seeded) = destinations.iter().find(|dir| is_populated(dir)) {
        return Ok(seeded.to_string_lossy().to_string());
    }

    let source = source(app)?;
    let mut failure = None;
    for destination in &destinations {
        match copy_atomically(&source, destination) {
            Ok(()) => return Ok(destination.to_string_lossy().to_string()),
            Err(error) => failure = Some(format!("{}: {error}", destination.display())),
        }
    }
    Err(format!(
        "could not copy the demo vault anywhere ({})",
        failure.unwrap_or_else(|| "no candidate folders".into())
    ))
}

/// Where the demo vault may live once it is the user's, best first.
///
/// Documents leads, because a files-first app whose starter content is buried
/// in Application Support is telling the user something false about itself.
/// macOS gates that folder behind a consent prompt, and a refusal surfaces
/// only when the copy is attempted — not from any check we could run first —
/// so the app's own data directory follows as a fallback that always works.
fn destinations(app: &AppHandle) -> Vec<PathBuf> {
    [app.path().document_dir(), app.path().app_data_dir()]
        .into_iter()
        .flatten()
        .map(|dir| dir.join(FOLDER_NAME))
        .collect()
}

/// The bundled copy. In a release bundle it is a resource; under `tauri dev`
/// there is no bundle, so fall back to the folder in the source tree.
fn source(app: &AppHandle) -> Result<PathBuf, String> {
    let bundled = app
        .path()
        .resource_dir()
        .map(|dir| dir.join("demo-vault"))
        .ok()
        .filter(|dir| dir.is_dir());
    if let Some(dir) = bundled {
        return Ok(dir);
    }
    let in_tree = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../demo-vault");
    if in_tree.is_dir() {
        return Ok(in_tree);
    }
    Err("the demo vault is missing from this build".into())
}

/// The folder the demo is assembled in before it is anything to the user.
fn staging_path(destination: &Path) -> PathBuf {
    destination.with_file_name(format!("{FOLDER_NAME} (incomplete)"))
}

/// Copy the vault into place in a state that is only ever whole.
///
/// Copying straight into the destination is not safe to interrupt: kill the
/// app halfway, or lose the cleanup to a failing `remove_dir_all`, and what is
/// left is a folder holding some of a vault. The next launch sees a folder
/// with files in it, calls that seeded, and opens a vault missing most of its
/// notes with nothing to suggest anything went wrong.
///
/// So the copy happens beside the destination and is renamed in once it is
/// complete. Rename is atomic within a filesystem, which makes the destination
/// binary: absent, or the whole vault. Nothing here can overwrite a vault the
/// user has been editing — `ensure` returns early for a populated folder, and
/// the only directory this removes is an empty one.
fn copy_atomically(source: &Path, destination: &Path) -> std::io::Result<()> {
    let staging = staging_path(destination);
    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent)?;
    }
    // Whatever an earlier interrupted run left behind is half a vault, not a
    // head start.
    if staging.exists() {
        std::fs::remove_dir_all(&staging)?;
    }

    let staged = copy_dir(source, &staging).and_then(|()| {
        // An empty destination from an earlier run would block the rename on
        // some platforms. `remove_dir` refuses to touch a non-empty directory,
        // so this cannot cost anyone their notes.
        let _ = std::fs::remove_dir(destination);
        std::fs::rename(&staging, destination)
    });
    if staged.is_err() {
        let _ = std::fs::remove_dir_all(&staging);
    }
    staged
}

/// Whether a seeded vault is already here. Because the copy is renamed in
/// whole (see `copy_atomically`), a folder with anything in it is a finished
/// vault and the user's to keep — not a copy that may have been cut short.
fn is_populated(dir: &Path) -> bool {
    std::fs::read_dir(dir)
        .map(|mut entries| entries.next().is_some())
        .unwrap_or(false)
}

fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::testutil;

    #[test]
    fn copying_preserves_the_folder_tree() {
        let root = testutil::temp_vault("demo-copy");
        let from = root.join("from");
        std::fs::create_dir_all(from.join("projects/nested")).unwrap();
        std::fs::write(from.join("top.md"), "# top").unwrap();
        std::fs::write(from.join("projects/nested/deep.md"), "# deep").unwrap();

        let to = root.join("to");
        copy_dir(&from, &to).unwrap();

        assert_eq!(std::fs::read_to_string(to.join("top.md")).unwrap(), "# top");
        assert_eq!(
            std::fs::read_to_string(to.join("projects/nested/deep.md")).unwrap(),
            "# deep"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_existing_demo_vault_is_never_overwritten() {
        // The second launch must not clobber notes the user wrote in the demo.
        let root = testutil::temp_vault("demo-existing");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("mine.md"), "my work").unwrap();
        assert!(is_populated(&root));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_cut_short_copy_never_becomes_the_vault() {
        // Reported by review: the copy used to write straight into the
        // destination, so an interrupted run left a partial vault that the
        // next launch read as seeded. The staging folder absorbs that now.
        let root = testutil::temp_vault("demo-partial");
        let from = root.join("from");
        std::fs::create_dir_all(&from).unwrap();
        std::fs::write(from.join("top.md"), "# top").unwrap();

        let destination = root.join(FOLDER_NAME);
        // Half a vault, left behind by a run that died mid-copy.
        let staging = staging_path(&destination);
        std::fs::create_dir_all(&staging).unwrap();
        std::fs::write(staging.join("half.md"), "truncated").unwrap();

        copy_atomically(&from, &destination).unwrap();

        assert!(
            !staging.exists(),
            "the staging folder is not left lying around"
        );
        assert!(
            !destination.join("half.md").exists(),
            "content from the abandoned run must not survive into the vault"
        );
        assert_eq!(
            std::fs::read_to_string(destination.join("top.md")).unwrap(),
            "# top"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn seeding_into_a_folder_left_empty_still_works() {
        // `rename` onto an existing directory is not portable; an empty
        // destination must not be the thing that blocks a first run.
        let root = testutil::temp_vault("demo-empty-dest");
        let from = root.join("from");
        std::fs::create_dir_all(&from).unwrap();
        std::fs::write(from.join("top.md"), "# top").unwrap();

        let destination = root.join(FOLDER_NAME);
        std::fs::create_dir_all(&destination).unwrap();

        copy_atomically(&from, &destination).unwrap();

        assert!(destination.join("top.md").is_file());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_empty_or_missing_folder_reads_as_unseeded() {
        // An interrupted first copy leaves an empty folder; treating it as
        // seeded would strand the user in a vault with nothing in it.
        let root = testutil::temp_vault("demo-empty");
        std::fs::create_dir_all(&root).unwrap();
        assert!(!is_populated(&root));
        assert!(!is_populated(&root.join("does-not-exist")));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_shipped_demo_vault_is_a_real_vault() {
        // Guards the bundling config: if the resource glob ever stops matching,
        // this is the test that says so before a user finds out on first run.
        let in_tree = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../demo-vault");
        assert!(
            in_tree.is_dir(),
            "demo-vault is missing from the source tree"
        );
        assert!(is_populated(&in_tree));
    }
}
