//! The explicitly accepted, create-only kit for an empty vault (M64.8).
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::vault::receipt::{Human, WriteReceipt};

pub const MARKER_PATH: &str = ".cerebro/starter.json";
pub const KIT_VERSION: u32 = 1;
pub const ALREADY_OFFERED: &str = "This vault was already offered the starter kit.";
pub const HAS_PAGES: &str =
    "The starter kit goes only into an empty vault, and this one has pages.";

pub const STARTER_FILES: &[(&str, &str)] = &[
    (
        "types/tasks.md",
        include_str!("../../shared/starter/vault/types/tasks.md"),
    ),
    (
        "records/agents/task-helper.md",
        include_str!("../../shared/starter/vault/records/agents/task-helper.md"),
    ),
    (
        "records/agents/weekly-notes.md",
        include_str!("../../shared/starter/vault/records/agents/weekly-notes.md"),
    ),
    (
        "records/skills/catch-me-up.md",
        include_str!("../../shared/starter/vault/records/skills/catch-me-up.md"),
    ),
    (
        "records/skills/what-i-did.md",
        include_str!("../../shared/starter/vault/records/skills/what-i-did.md"),
    ),
    (
        "tasks/capture-an-idea.md",
        include_str!("../../shared/starter/vault/tasks/capture-an-idea.md"),
    ),
    (
        "tasks/hand-a-task-to-the-helper.md",
        include_str!("../../shared/starter/vault/tasks/hand-a-task-to-the-helper.md"),
    ),
    (
        "tasks/read-getting-started.md",
        include_str!("../../shared/starter/vault/tasks/read-getting-started.md"),
    ),
    (
        "getting-started.md",
        include_str!("../../shared/starter/vault/getting-started.md"),
    ),
];
static OFFER: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Outcome {
    Added,
    Declined,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct StarterMarker {
    pub kit: u32,
    pub outcome: Outcome,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offered_at: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct Installed {
    pub marker_saved: bool,
}

fn marker_path(vault: &Path) -> Result<PathBuf, String> {
    for path in [vault.join(".cerebro"), vault.join(MARKER_PATH)] {
        match std::fs::symlink_metadata(&path) {
            Ok(meta) if meta.file_type().is_symlink() => {
                return Err("The starter marker may not be a symbolic link.".into());
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("The starter marker could not be read: {error}")),
        }
    }
    Ok(vault.join(MARKER_PATH))
}

pub fn read_marker(vault: &Path) -> Result<Option<StarterMarker>, String> {
    let path = marker_path(vault)?;
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|error| format!("The starter marker could not be read: {error}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("The starter marker could not be read: {error}")),
    }
}

fn write_marker(vault: &Path, outcome: Outcome) -> Result<(), String> {
    let path = marker_path(vault)?;
    std::fs::create_dir_all(vault.join(".cerebro")).map_err(|error| error.to_string())?;
    // Check again after creating the parent; neither a redirected folder nor a
    // redirected file is a destination for this app-owned marker.
    marker_path(vault)?;
    let marker = StarterMarker {
        kit: KIT_VERSION,
        outcome,
        offered_at: Some(chrono::Utc::now().to_rfc3339()),
    };
    let bytes = serde_json::to_string_pretty(&marker).map_err(|error| error.to_string())? + "\n";
    crate::connectors::write_owner_only(&path, &bytes)
}

pub fn install(vault: &Path, by: &WriteReceipt<Human>) -> Result<Installed, String> {
    let _offer = OFFER.lock().map_err(|error| error.to_string())?;
    if read_marker(vault)?.is_some() {
        return Err(ALREADY_OFFERED.into());
    }
    if !crate::vault::scan::scan_vault(vault)?.is_empty() {
        return Err(HAS_PAGES.into());
    }
    let ops: Vec<_> = STARTER_FILES.iter().map(|(path, content)| {
        serde_json::json!({ "op": "create", "path": path, "content": content })
    }).collect();
    crate::vault::batch::apply_batch(vault, &ops, by).map_err(|error| match error {
        crate::vault::batch::BatchError::Refused(message) => message,
        crate::vault::batch::BatchError::Stale(stale) => {
            crate::vault::batch::stale_words(&stale.path)
        }
    })?;
    let marker_saved = match write_marker(vault, Outcome::Added) {
        Ok(()) => true,
        Err(error) => {
            log::warn!("starter: installed but could not save the offer marker: {error}");
            false
        }
    };
    Ok(Installed { marker_saved })
}

pub fn decline(vault: &Path) -> Result<(), String> {
    let _offer = OFFER.lock().map_err(|error| error.to_string())?;
    if read_marker(vault)?.is_none() {
        write_marker(vault, Outcome::Declined)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::testutil::{temp_vault, write};

    fn human() -> WriteReceipt<Human> {
        WriteReceipt::ipc(crate::knowledge::guard_human_write("getting-started.md").unwrap())
    }

    #[test]
    fn compiled_files_are_all_shipped_bytes_and_only_plain_pages() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../shared/starter/vault");
        let mut files = Vec::new();
        fn walk(root: &Path, dir: &Path, files: &mut Vec<String>) {
            for entry in std::fs::read_dir(dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    walk(root, &path, files);
                } else {
                    files.push(
                        path.strip_prefix(root)
                            .unwrap()
                            .to_string_lossy()
                            .into_owned(),
                    );
                }
            }
        }
        walk(&root, &root, &mut files);
        files.sort();
        let mut compiled: Vec<_> = STARTER_FILES
            .iter()
            .map(|(path, _)| path.to_string())
            .collect();
        compiled.sort();
        assert_eq!(files, compiled);
        for (path, bytes) in STARTER_FILES {
            assert!(path.ends_with(".md") && !path.starts_with("knowledge/"));
            assert!(path
                .split('/')
                .all(|part| !part.starts_with('.') && !part.is_empty()));
            assert_eq!(std::fs::read_to_string(root.join(path)).unwrap(), *bytes);
        }
        assert_eq!(STARTER_FILES[0].0, "types/tasks.md");
        assert_eq!(STARTER_FILES.last().unwrap().0, "getting-started.md");
    }

    #[test]
    fn an_empty_vault_gets_exact_bytes_once_and_the_marker_stays_out_of_scan() {
        let _sink = crate::runtime::sink::test_lock();
        let config = temp_vault("starter-install-config");
        crate::runtime::sink::arm(&config).unwrap();
        let vault = temp_vault("starter-install");
        assert!(install(&vault, &human()).unwrap().marker_saved);
        for (path, bytes) in STARTER_FILES {
            assert_eq!(std::fs::read_to_string(vault.join(path)).unwrap(), *bytes);
        }
        assert_eq!(
            crate::vault::scan::scan_vault(&vault).unwrap().len(),
            STARTER_FILES.len()
        );
        assert_eq!(
            read_marker(&vault).unwrap().unwrap().outcome,
            Outcome::Added
        );
        let marker = std::fs::read(vault.join(MARKER_PATH)).unwrap();
        assert_eq!(install(&vault, &human()).unwrap_err(), ALREADY_OFFERED);
        decline(&vault).unwrap();
        assert_eq!(std::fs::read(vault.join(MARKER_PATH)).unwrap(), marker);
        std::fs::remove_dir_all(vault).unwrap();
        crate::runtime::sink::disarm();
        std::fs::remove_dir_all(config).unwrap();
    }

    #[test]
    fn a_page_or_declined_marker_refuses_without_touching_the_vault() {
        let vault = temp_vault("starter-existing");
        write(&vault, "mine.md", "# Mine\n");
        assert_eq!(install(&vault, &human()).unwrap_err(), HAS_PAGES);
        assert_eq!(
            std::fs::read_to_string(vault.join("mine.md")).unwrap(),
            "# Mine\n"
        );
        assert!(!vault.join(MARKER_PATH).exists());
        std::fs::remove_file(vault.join("mine.md")).unwrap();
        decline(&vault).unwrap();
        assert_eq!(
            read_marker(&vault).unwrap().unwrap().outcome,
            Outcome::Declined
        );
        assert!(crate::vault::scan::scan_vault(&vault).unwrap().is_empty());
        assert_eq!(install(&vault, &human()).unwrap_err(), ALREADY_OFFERED);
        std::fs::remove_dir_all(vault).unwrap();
    }

    #[test]
    fn corrupt_and_unreadable_markers_are_not_absence() {
        let vault = temp_vault("starter-corrupt");
        write(&vault, MARKER_PATH, "not json");
        assert!(read_marker(&vault).is_err());
        assert!(install(&vault, &human()).is_err());
        assert!(decline(&vault).is_err());
        std::fs::remove_file(vault.join(MARKER_PATH)).unwrap();
        std::fs::create_dir(vault.join(MARKER_PATH)).unwrap();
        assert!(read_marker(&vault).is_err());
        std::fs::remove_dir_all(vault).unwrap();
    }

    #[test]
    fn a_legacy_marker_without_a_clock_still_counts() {
        let vault = temp_vault("starter-legacy");
        write(&vault, MARKER_PATH, r#"{"kit":1,"outcome":"declined"}"#);
        assert_eq!(read_marker(&vault).unwrap().unwrap().offered_at, None);
        assert_eq!(install(&vault, &human()).unwrap_err(), ALREADY_OFFERED);
        std::fs::remove_dir_all(vault).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_marker_or_its_folder_cannot_redirect_to_a_symlink() {
        use std::os::unix::fs::symlink;
        let vault = temp_vault("starter-link");
        let outside = temp_vault("starter-outside");
        symlink(&outside, vault.join(".cerebro")).unwrap();
        assert!(read_marker(&vault).unwrap_err().contains("symbolic link"));
        assert!(install(&vault, &human()).is_err());
        assert!(decline(&vault).is_err());
        std::fs::remove_file(vault.join(".cerebro")).unwrap();
        std::fs::create_dir(vault.join(".cerebro")).unwrap();
        write(&outside, "marker.json", "{}");
        symlink(outside.join("marker.json"), vault.join(MARKER_PATH)).unwrap();
        assert!(read_marker(&vault).unwrap_err().contains("symbolic link"));
        assert!(decline(&vault).is_err());
        assert_eq!(
            std::fs::read_to_string(outside.join("marker.json")).unwrap(),
            "{}"
        );
        for path in [vault, outside] {
            std::fs::remove_dir_all(path).unwrap();
        }
    }
}
