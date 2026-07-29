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
        match copy_dir(&source, destination) {
            Ok(()) => return Ok(destination.to_string_lossy().to_string()),
            Err(error) => {
                // A half-written folder would read as seeded on the next launch
                // and strand the user in a vault missing most of its notes.
                let _ = std::fs::remove_dir_all(destination);
                failure = Some(format!("{}: {error}", destination.display()));
            }
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

/// A folder that exists but holds nothing is not a seeded vault — treat it as
/// absent so an interrupted first copy heals itself instead of dead-ending.
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
        assert!(in_tree.is_dir(), "demo-vault is missing from the source tree");
        assert!(is_populated(&in_tree));
    }
}
