//! The operational vault-write log (M49.10, the 2026-09 owner decision Q4).
//!
//! A note saved, patched, renamed or deleted is recorded here — in app-data,
//! beside the operational log — and no longer in the vault ledger. The ledger
//! is the EPISTEMIC record: what the knowledge base believes and why. These
//! `vault.*` events were shadow observations nothing ever read, and they were
//! most of the chain's bytes.
//!
//! Best-effort by constitution, as the shadow events were: recording never
//! fails the write it describes, and without an armed runtime DB it records
//! nothing.

use std::path::Path;

/// Record one vault write. `to` only for a rename; `content_hash` for a
/// write whose bytes are known.
pub fn record(
    vault: &Path,
    kind: &str,
    path: &str,
    to: Option<&str>,
    content_hash: Option<&str>,
    actor: Option<&str>,
) {
    super::sink::with_sink(|conn| {
        let Ok(vault_id) = super::scope::register(conn, vault) else {
            return;
        };
        let _ = conn.execute(
            "INSERT INTO vault_writes \
             (vault_id, kind, path, to_path, content_hash, actor, recorded_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![
                vault_id,
                kind,
                path,
                to,
                content_hash,
                actor,
                super::now_utc()
            ],
        );
    });
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_vault_write_is_recorded_operationally_not_in_the_ledger() {
        let _sink = super::super::sink::test_lock();
        let config = crate::vault::testutil::temp_vault("vault-writes-config");
        let vault = crate::vault::testutil::temp_vault("vault-writes");
        super::super::sink::arm(&config).unwrap();
        crate::vault::testutil::write(&vault, "items/a.md", "# A\n");
        crate::vault::write::save_note(&vault, "items/a.md", "\n# A\n\nEdited.\n").unwrap();
        crate::vault::write::rename_note(&vault, "items/a.md", "items/b.md").unwrap();
        // The sink is process-global: other tests' writes may land in it
        // while it is armed, so only this vault's rows are asked for.
        let vault_id = super::super::scope::derive_vault_id(&vault);
        let rows: Vec<(String, String, Option<String>)> = super::super::sink::with_sink(|conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT kind, path, to_path FROM vault_writes WHERE vault_id = ?1 \
                     ORDER BY rowid",
                )
                .unwrap();
            stmt.query_map([&vault_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
        })
        .unwrap();
        assert_eq!(
            rows,
            vec![
                ("vault.write".into(), "items/a.md".into(), None),
                (
                    "vault.rename".into(),
                    "items/a.md".into(),
                    Some("items/b.md".into())
                ),
            ]
        );
        assert!(
            !crate::ledger::ledger_dir(&vault).exists(),
            "the ledger saw none of it"
        );
        super::super::sink::disarm();
        for dir in [&vault, &config] {
            let _ = std::fs::remove_dir_all(dir);
        }
    }
}
