//! One Source Monitor pass over a vault (M26.7d).
//!
//! Reads the vault, picks out the cached copies, and hands them to the store.
//! The only IO is reading files this process already owns — see the module
//! note in [`super::sources`] for why the fetch is not here.

use std::path::Path;

use super::sources::{cached, Cached};
use super::store::{observe, Observed};

/// Every cached copy the vault currently holds.
///
/// A file that cannot be read is SKIPPED rather than fatal, and skipped
/// silently is the wrong shape — so it is counted. A monitor that quietly
/// dropped an unreadable source would report "nothing is due" for a copy it
/// never looked at.
pub fn copies(vault: &Path) -> Result<(Vec<Cached>, usize), String> {
    let entries = crate::vault::scan::scan_vault(vault)?;
    let mut out = Vec::new();
    let mut unreadable = 0usize;
    for entry in &entries {
        if entry.entry_type.as_deref() != Some(super::sources::SOURCE_TYPE) {
            continue;
        }
        let Ok(raw) = std::fs::read_to_string(vault.join(&entry.path)) else {
            unreadable += 1;
            continue;
        };
        let (_, body) = crate::vault::parse::split_frontmatter(&raw);
        match cached(entry, body)? {
            Some(copy) => out.push(copy),
            None => continue,
        }
    }
    out.sort_by(|a, b| a.item_key.cmp(&b.item_key));
    Ok((out, unreadable))
}

/// Run one pass.
pub fn run(
    conn: &rusqlite::Connection,
    vault: &Path,
    vault_id: &str,
    now: chrono::DateTime<chrono::Utc>,
) -> Result<(Observed, usize), String> {
    let (copies, unreadable) = copies(vault)?;
    let today = now.format("%Y-%m-%d").to_string();
    let observed = observe(conn, vault_id, &copies, &today, now)?;
    Ok((observed, unreadable))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::testutil;

    fn source(vault: &Path, path: &str, id: &str, stale_after: &str, body: &str) {
        testutil::write(
            vault,
            path,
            &format!(
                "---\ntype: Source\ntitle: Alpha\nsource_id: {id}\nsource_kind: web\n\
                 source_url: https://example.test/a\nfetched_at: 2026-08-01T00:00:00Z\n\
                 stale_after: {stale_after}\n---\n\n{body}\n"
            ),
        );
    }

    fn conn() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().expect("memory db");
        conn.execute_batch(
            "CREATE TABLE vault_registry (vault_id TEXT PRIMARY KEY, path TEXT NOT NULL);",
        )
        .expect("registry");
        conn.execute(
            "INSERT INTO vault_registry (vault_id, path) VALUES ('vault-1', '/tmp/v')",
            [],
        )
        .expect("register");
        conn.execute_batch(crate::runtime::schema::SCHEMA_V8)
            .expect("v8");
        conn
    }

    fn at(stamp: &str) -> chrono::DateTime<chrono::Utc> {
        chrono::DateTime::parse_from_rfc3339(stamp)
            .unwrap()
            .with_timezone(&chrono::Utc)
    }

    #[test]
    fn a_pass_finds_the_cached_copies_and_leaves_everything_else_alone() {
        let vault = testutil::temp_vault("monitor-pass");
        source(
            &vault,
            "sources/a.md",
            "web:alpha",
            "2026-08-01",
            "Alpha text.",
        );
        testutil::write(
            &vault,
            "records/r.md",
            "---\ntype: Person\n---\n\nSomeone.\n",
        );

        let conn = conn();
        let (observed, unreadable) =
            run(&conn, &vault, "vault-1", at("2026-08-12T00:00:00.000Z")).unwrap();
        assert_eq!(unreadable, 0);
        assert_eq!(observed.first_seen, 1, "one cached copy, not the Person");
        assert_eq!(observed.due.len(), 1, "stale since the first of the month");
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn restamping_the_fetch_time_creates_no_work_and_a_new_body_does() {
        let vault = testutil::temp_vault("monitor-refetch");
        source(
            &vault,
            "sources/a.md",
            "web:alpha",
            "2026-08-01",
            "Alpha text.",
        );
        let conn = conn();
        run(&conn, &vault, "vault-1", at("2026-08-12T00:00:00.000Z")).unwrap();

        // A refetch that found nothing: same text, new stamps.
        testutil::write(
            &vault,
            "sources/a.md",
            "---\ntype: Source\ntitle: Alpha\nsource_id: web:alpha\nsource_kind: web\n\
             source_url: https://example.test/a\nfetched_at: 2026-08-12T00:00:00Z\n\
             stale_after: 2026-09-11\n---\n\nAlpha text.\n",
        );
        let (observed, _) = run(&conn, &vault, "vault-1", at("2026-08-12T00:01:00.000Z")).unwrap();
        assert_eq!(observed.unchanged, 1);
        assert!(observed.changed.is_empty());
        assert!(
            observed.due.is_empty(),
            "the new stale date is in the future"
        );

        // A refetch that found something.
        source(
            &vault,
            "sources/a.md",
            "web:alpha",
            "2026-09-11",
            "Alpha text, revised.",
        );
        let (observed, _) = run(&conn, &vault, "vault-1", at("2026-08-12T00:02:00.000Z")).unwrap();
        assert_eq!(observed.changed.len(), 1);
        let _ = std::fs::remove_dir_all(&vault);
    }
}
