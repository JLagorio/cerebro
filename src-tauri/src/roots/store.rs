//! Where the mounted-root list is persisted.
//!
//! App-data, NOT the vault. AGENTS.md's two-records rule assigns operational
//! state to the runtime side and epistemic history to the vault ledger; which
//! repositories you happen to have mounted is plainly operational.
//!
//! Every failure degrades to "no roots mounted" rather than propagating. A
//! corrupt list must not prevent the app from starting — the user can re-mount.

use std::path::{Path, PathBuf};

use super::Root;

const ROOTS_FILE: &str = "roots.json";

fn roots_path(dir: &Path) -> PathBuf {
    dir.join(ROOTS_FILE)
}

/// Load the mounted-root list. Any failure — missing, unreadable, malformed —
/// yields an empty list.
pub fn load(dir: &Path) -> Vec<Root> {
    std::fs::read_to_string(roots_path(dir))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

/// Write the mounted-root list, creating the directory.
pub fn save(dir: &Path, roots: &[Root]) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let raw = serde_json::to_string_pretty(roots).map_err(|e| e.to_string())?;
    std::fs::write(roots_path(dir), raw).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::roots::RootCaps;
    use crate::vault::testutil;

    fn sample(id: &str) -> Root {
        Root {
            id: id.to_string(),
            path: format!("/tmp/{id}"),
            label: id.to_string(),
            alias: id.to_string(),
            color: None,
            caps: RootCaps {
                knowledge: false,
                git: true,
                writable: true,
            },
        }
    }

    #[test]
    fn load_returns_empty_when_missing() {
        let dir = testutil::temp_vault("roots-store-missing");
        assert_eq!(load(&dir), Vec::<Root>::new());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_then_load_round_trips() {
        let dir = testutil::temp_vault("roots-store-roundtrip");
        let roots = vec![sample("alpha"), sample("beta")];
        save(&dir, &roots).unwrap();
        assert_eq!(load(&dir), roots);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_json_degrades_to_empty() {
        let dir = testutil::temp_vault("roots-store-corrupt");
        std::fs::write(dir.join(ROOTS_FILE), "{not json").unwrap();
        assert_eq!(load(&dir), Vec::<Root>::new());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_creates_the_directory() {
        let dir = testutil::temp_vault("roots-store-mkdir").join("nested");
        save(&dir, &[sample("gamma")]).unwrap();
        assert_eq!(load(&dir).len(), 1);
        let _ = std::fs::remove_dir_all(dir.parent().unwrap());
    }
}
