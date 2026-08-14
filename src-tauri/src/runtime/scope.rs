//! Vault scoping — `vault_id`, and why it is derived as well as recorded
//! (M25.1).
//!
//! `runtime.db` is app-global. Two vaults open in two windows share one
//! scheduler table, one run log, and one subscription budget, so every row
//! that belongs to a vault has to say which one. The design names two
//! identities and they are not interchangeable:
//!
//! - `store_uuid` — the ledger's PORTABLE identity. It travels with the vault
//!   folder, survives a move, and is what a coverage or receipt event means
//!   by "this store".
//! - `vault_id` — the app's LOCAL registration of a path. It exists because
//!   the runtime DB has rows to write before a ledger is armed (a scan
//!   failure, a session heartbeat, an ingestion error on an unparseable
//!   file), and because "which folder is this" is an app question, not an
//!   epistemic one.
//!
//! **The judgment call: derived, not minted.** A random registration id would
//! be the obvious choice, and it is the wrong one here. Losing `runtime.db`
//! is a first-class scenario in this milestone; a random id would make every
//! rebuilt row point at a vault that no longer exists under that name, and
//! recovery would have to re-associate history by path anyway. Deriving the
//! id from the canonicalized absolute path means a rebuilt database re-derives
//! the same ids and the rebuilt rows rejoin their vault. The row still
//! exists — the registry is what makes the id auditable, and what gives the
//! foreign keys something to point at.
//!
//! The cost is honest and stated: moving a vault folder mints a new
//! `vault_id`. That is correct for the local questions `vault_id` answers
//! ("which folder's scheduler queue is this") and irrelevant to the portable
//! ones, which key on `store_uuid`.

use std::path::Path;

use rusqlite::Connection;

use crate::ledger::sha256_hex;

/// Domain separator. Every derived id in this codebase carries one, so two
/// formulas can never collide by hashing the same bytes for different
/// reasons.
const DOMAIN: &str = "cerebro:vault-registration:v1";

/// The canonical spelling of a vault path for identity purposes.
///
/// `canonicalize` resolves symlinks and `..`, which is what stops the same
/// folder reached two ways from becoming two vaults. A path that cannot be
/// canonicalized (it does not exist yet, or permissions refuse) falls back to
/// its literal string rather than failing: an id for a path we cannot stat is
/// still better than refusing to record a scan error about it.
pub fn canonical_path(vault: &Path) -> String {
    std::fs::canonicalize(vault)
        .unwrap_or_else(|_| vault.to_path_buf())
        .to_string_lossy()
        .into_owned()
}

/// `sha256_first128(DOMAIN | 0x00 | canonical_path)`, lowercase hex.
pub fn derive_vault_id(vault: &Path) -> String {
    let path = canonical_path(vault);
    let mut bytes = Vec::with_capacity(DOMAIN.len() + 1 + path.len());
    bytes.extend_from_slice(DOMAIN.as_bytes());
    bytes.push(0);
    bytes.extend_from_slice(path.as_bytes());
    sha256_hex(&bytes)[..32].to_string()
}

/// Register a vault path, returning its id. Idempotent: the same path always
/// yields the same id and at most one row.
///
/// The path column is updated on re-registration so a canonicalization that
/// starts resolving differently (the folder now exists, a symlink was
/// replaced) does not leave the registry describing a path that no longer
/// spells that way — while the id, and therefore every foreign key, is
/// untouched.
pub fn register(conn: &Connection, vault: &Path) -> Result<String, String> {
    let vault_id = derive_vault_id(vault);
    let path = canonical_path(vault);
    let now = super::now_utc();
    conn.execute(
        "INSERT INTO vault_registry (vault_id, vault_path, first_seen_at) \
         VALUES (?1, ?2, ?3) \
         ON CONFLICT (vault_id) DO UPDATE SET vault_path = excluded.vault_path",
        rusqlite::params![vault_id, path, now],
    )
    .map_err(|e| format!("vault_registry: {e}"))?;
    Ok(vault_id)
}

/// The registered path for an id, if the registry knows it.
pub fn path_of(conn: &Connection, vault_id: &str) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT vault_path FROM vault_registry WHERE vault_id = ?1",
        [vault_id],
        |row| row.get::<_, String>(0),
    )
    .map(Some)
    .or_else(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => Ok(None),
        other => Err(format!("vault_registry: {other}")),
    })
}

/// Every registered vault, oldest first — what a cross-vault surface (the
/// budget meter, the activity log's filter) enumerates.
pub fn all(conn: &Connection) -> Result<Vec<(String, String)>, String> {
    let mut statement = conn
        .prepare("SELECT vault_id, vault_path FROM vault_registry ORDER BY first_seen_at, vault_id")
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::testutil;

    #[test]
    fn the_same_path_derives_the_same_id_every_time() {
        // The whole point of deriving rather than minting: a deleted runtime
        // DB must rebuild rows that rejoin their vault.
        let dir = testutil::temp_vault("scope-stable");
        let first = derive_vault_id(&dir);
        let second = derive_vault_id(&dir);
        assert_eq!(first, second);
        assert_eq!(first.len(), 32);
        assert!(first
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn two_vaults_never_share_an_id() {
        let a = testutil::temp_vault("scope-a");
        let b = testutil::temp_vault("scope-b");
        assert_ne!(derive_vault_id(&a), derive_vault_id(&b));
        let _ = std::fs::remove_dir_all(&a);
        let _ = std::fs::remove_dir_all(&b);
    }

    #[test]
    fn the_same_folder_reached_two_ways_is_one_vault() {
        // `/tmp/x/../x` and `/tmp/x` are the same scheduler queue. Without
        // canonicalization they would be two, and each would re-process the
        // other's work.
        let dir = testutil::temp_vault("scope-canonical");
        let indirect = dir.join("..").join(dir.file_name().unwrap());
        assert_eq!(derive_vault_id(&dir), derive_vault_id(&indirect));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn registering_twice_leaves_one_row_and_one_id() {
        let dir = testutil::temp_vault("scope-register");
        let conn = super::super::open(&dir).unwrap();
        let first = register(&conn, &dir).unwrap();
        let second = register(&conn, &dir).unwrap();
        assert_eq!(first, second);
        let rows: i64 = conn
            .query_row("SELECT count(*) FROM vault_registry", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 1);
        assert_eq!(path_of(&conn, &first).unwrap(), Some(canonical_path(&dir)));
        assert_eq!(all(&conn).unwrap().len(), 1);
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unregistered_id_resolves_to_nothing_rather_than_an_error() {
        let dir = testutil::temp_vault("scope-missing");
        let conn = super::super::open(&dir).unwrap();
        assert_eq!(path_of(&conn, &"0".repeat(32)).unwrap(), None);
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
