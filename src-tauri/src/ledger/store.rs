//! `store.json` — the ledger's identity, minted once per vault ledger
//! (M21.2). The store id is also the chain anchor: `prev` of the very first
//! record, so even an empty-prefix splice is detectable.

use std::path::Path;

use serde::{Deserialize, Serialize};

use super::{fsync_dir, new_id128};

const STORE_FILE: &str = "store.json";
/// Temp name for the atomic mint. Deterministic on purpose: minting happens
/// once, under no concurrency (M21.3's lock arrives before any real writer),
/// and a crashed mint's temp is simply overwritten by the retry.
const STORE_TEMP: &str = "store.json.tmp";

/// Physical format version of the ledger directory layout (`format: 1` per
/// the M21 plan — distinct from the frame envelope's `v`).
pub const STORE_FORMAT: u64 = 1;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StoreInfo {
    /// 128-bit random lowercase hex.
    pub store_id: String,
    pub format: u64,
    /// RFC3339 millis at mint. Display only.
    pub created_at: String,
}

/// Read the store identity. `Ok(None)` = no ledger has been minted here; a
/// present-but-unreadable or torn store.json is an error, never a silent
/// re-mint (a new store id would orphan every existing segment).
pub fn load(ledger_dir: &Path) -> Result<Option<StoreInfo>, String> {
    let path = ledger_dir.join(STORE_FILE);
    match std::fs::read_to_string(&path) {
        Ok(raw) => {
            let info: StoreInfo =
                serde_json::from_str(&raw).map_err(|e| format!("{}: {e}", path.display()))?;
            if info.format != STORE_FORMAT {
                return Err(format!(
                    "{}: unsupported ledger format {}",
                    path.display(),
                    info.format
                ));
            }
            Ok(Some(info))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("{}: {e}", path.display())),
    }
}

/// Load the identity, or mint it exactly once when the ledger is new.
///
/// The mint is atomic (temp + fsync + rename + directory fsync) and the
/// directory chain up to the vault is fsynced, so a crash can lose the whole
/// mint — harmless, no events can exist yet; the next launch re-mints — but
/// can never leave a torn store.json behind a ledger that has started
/// committing events.
pub fn load_or_mint(ledger_dir: &Path) -> Result<StoreInfo, String> {
    if let Some(existing) = load(ledger_dir)? {
        return Ok(existing);
    }
    std::fs::create_dir_all(ledger_dir).map_err(|e| e.to_string())?;
    let info = StoreInfo {
        store_id: new_id128(),
        format: STORE_FORMAT,
        created_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    };
    let json = serde_json::to_string_pretty(&info).map_err(|e| e.to_string())?;
    let temp = ledger_dir.join(STORE_TEMP);
    {
        use std::io::Write;
        let mut file = std::fs::File::create(&temp).map_err(|e| e.to_string())?;
        file.write_all(json.as_bytes()).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
    }
    std::fs::rename(&temp, ledger_dir.join(STORE_FILE)).map_err(|e| e.to_string())?;
    // Durability of the mint AND of the freshly created directories: fsync
    // the ledger dir (store.json entry), then each parent up through the
    // vault root (.cerebro entry, ledger entry). A ledger whose identity can
    // vanish in a crash would re-mint a new store id on the next launch and
    // orphan nothing today — but orphan everything once events exist.
    fsync_dir(ledger_dir)?;
    if let Some(parent) = ledger_dir.parent() {
        fsync_dir(parent)?;
        if let Some(grandparent) = parent.parent() {
            fsync_dir(grandparent)?;
        }
    }
    Ok(info)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::testutil;

    #[test]
    fn minted_once_then_stable() {
        let vault = testutil::temp_vault("store-mint");
        let dir = crate::ledger::ledger_dir(&vault);
        assert_eq!(load(&dir).unwrap(), None);
        let minted = load_or_mint(&dir).unwrap();
        assert_eq!(minted.store_id.len(), 32);
        assert!(minted.store_id.bytes().all(|b| b.is_ascii_hexdigit()));
        assert_eq!(minted.format, STORE_FORMAT);
        // A second call returns the SAME identity — minting happens once.
        assert_eq!(load_or_mint(&dir).unwrap(), minted);
        assert_eq!(load(&dir).unwrap(), Some(minted));
        assert!(!dir.join(STORE_TEMP).exists());
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn a_torn_store_json_is_an_error_never_a_silent_remint() {
        let vault = testutil::temp_vault("store-torn");
        let dir = crate::ledger::ledger_dir(&vault);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(STORE_FILE), "{\"store_id\": \"abc").unwrap();
        assert!(load(&dir).is_err());
        // Re-minting over a torn identity would orphan every segment.
        assert!(load_or_mint(&dir).is_err());
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn an_unknown_format_is_refused() {
        let vault = testutil::temp_vault("store-format");
        let dir = crate::ledger::ledger_dir(&vault);
        std::fs::create_dir_all(&dir).unwrap();
        let alien = "{\"store_id\":\"00000000000000000000000000000000\",\"format\":2,\"created_at\":\"2026-08-07T12:00:00.000Z\"}";
        std::fs::write(dir.join(STORE_FILE), alien).unwrap();
        assert!(load(&dir).is_err());
        let _ = std::fs::remove_dir_all(&vault);
    }
}
