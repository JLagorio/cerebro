//! What the Source Monitor last saw, and what one check found (M26.7d).

use std::collections::BTreeMap;

use rusqlite::{params, Connection};

use super::sources::{
    compare, creates_work, freshness, Cached, Change, Freshness, MONITOR_VERSION,
};

/// One copy the monitor thinks is worth asking about again.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Due {
    pub item_key: String,
    pub source_id: String,
    pub source_url: Option<String>,
    /// The date it went stale — carried so a surface can say how long without
    /// a clock of its own.
    pub since: String,
}

/// One copy whose content actually moved.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Changed {
    pub item_key: String,
    pub source_id: String,
    pub from: String,
    pub to: String,
}

/// What one pass found.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Observed {
    /// Copies whose `stale_after` has passed. This is a WORKLIST for the
    /// assistant, not work this process can do — nothing here fetches.
    pub due: Vec<Due>,
    /// Copies whose content hash moved. These, and only these, create ingest
    /// work.
    pub changed: Vec<Changed>,
    pub first_seen: usize,
    pub unchanged: usize,
    /// Rows for copies that are no longer in the vault, removed.
    pub forgotten: usize,
}

/// Record what the vault holds now, and report what moved and what is due.
///
/// `today` is a `YYYY-MM-DD` local date and `now` an instant — two arguments
/// rather than one because staleness is a calendar question the owner set in
/// calendar terms, and "checked at" is a moment.
pub fn observe(
    conn: &Connection,
    vault_id: &str,
    copies: &[Cached],
    today: &str,
    now: chrono::DateTime<chrono::Utc>,
) -> Result<Observed, String> {
    let stamp = now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;

    let mut known: BTreeMap<String, String> = tx
        .prepare("SELECT item_key, content_hash FROM source_monitor_state WHERE vault_id = ?1")
        .and_then(|mut stmt| {
            stmt.query_map(params![vault_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<Result<BTreeMap<String, String>, _>>()
        })
        .map_err(|e| format!("reading source monitor state: {e}"))?;

    let mut out = Observed::default();
    for copy in copies {
        let previous = known.remove(&copy.item_key);
        let change = compare(previous.as_deref(), copy);
        match &change {
            Change::FirstSeen => out.first_seen += 1,
            Change::Unchanged => out.unchanged += 1,
            Change::Changed { from } => out.changed.push(Changed {
                item_key: copy.item_key.clone(),
                source_id: copy.source_id.clone(),
                from: from.clone(),
                to: copy.content_hash.clone(),
            }),
        }
        if let Freshness::Due { since } = freshness(copy, today) {
            out.due.push(Due {
                item_key: copy.item_key.clone(),
                source_id: copy.source_id.clone(),
                source_url: copy.source_url.clone(),
                since,
            });
        }

        // `last_changed_at` moves only when the hash does. A refetch that
        // brought back identical bytes updates `last_checked_at` and nothing
        // else — which is the whole point of hashing the content instead of
        // the file.
        let moved = creates_work(&change) || matches!(change, Change::FirstSeen);
        tx.execute(
            "INSERT INTO source_monitor_state (
                 vault_id, item_key, source_id, source_kind, source_url,
                 monitor_version, content_hash, fetched_at, stale_after,
                 first_seen_at, last_checked_at, last_changed_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10, ?10)
             ON CONFLICT (vault_id, item_key) DO UPDATE SET
                 source_id = excluded.source_id,
                 source_kind = excluded.source_kind,
                 source_url = excluded.source_url,
                 monitor_version = excluded.monitor_version,
                 content_hash = excluded.content_hash,
                 fetched_at = excluded.fetched_at,
                 stale_after = excluded.stale_after,
                 last_checked_at = excluded.last_checked_at,
                 last_changed_at = CASE WHEN ?11 THEN excluded.last_changed_at
                                        ELSE source_monitor_state.last_changed_at END",
            params![
                vault_id,
                copy.item_key,
                copy.source_id,
                copy.source_kind,
                copy.source_url,
                MONITOR_VERSION,
                copy.content_hash,
                copy.fetched_at,
                copy.stale_after,
                stamp,
                moved,
            ],
        )
        .map_err(|e| format!("recording {}: {e}", copy.item_key))?;
    }

    for item_key in known.keys() {
        tx.execute(
            "DELETE FROM source_monitor_state WHERE vault_id = ?1 AND item_key = ?2",
            params![vault_id, item_key],
        )
        .map_err(|e| format!("forgetting {item_key}: {e}"))?;
    }
    out.forgotten = known.len();

    tx.commit().map_err(|e| e.to_string())?;
    Ok(out)
}

/// When a copy's content last moved, for a caller that wants to say so.
pub fn last_changed_at(
    conn: &Connection,
    vault_id: &str,
    item_key: &str,
) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT last_changed_at FROM source_monitor_state WHERE vault_id = ?1 AND item_key = ?2",
        params![vault_id, item_key],
        |row| row.get::<_, String>(0),
    )
    .map(Some)
    .or_else(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => Ok(None),
        other => Err(other.to_string()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const VAULT: &str = "vault-1";
    const TODAY: &str = "2026-08-12";

    fn conn() -> Connection {
        let conn = Connection::open_in_memory().expect("memory db");
        conn.execute_batch(
            "CREATE TABLE vault_registry (vault_id TEXT PRIMARY KEY, path TEXT NOT NULL);",
        )
        .expect("registry");
        conn.execute(
            "INSERT INTO vault_registry (vault_id, path) VALUES (?1, '/tmp/v')",
            params![VAULT],
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

    fn copy(hash: &str, stale_after: Option<&str>, fetched_at: &str) -> Cached {
        Cached {
            item_key: "sources/web-alpha.md".into(),
            source_id: "web:alpha".into(),
            source_kind: Some("web".into()),
            source_url: Some("https://example.test/a".into()),
            content_hash: hash.repeat(64),
            fetched_at: Some(fetched_at.into()),
            stale_after: stale_after.map(str::to_string),
        }
    }

    #[test]
    fn a_refetch_that_brought_back_nothing_new_moves_only_the_check_time() {
        let conn = conn();
        let first = copy("a", Some("2026-09-01"), "2026-08-01T00:00:00Z");
        observe(
            &conn,
            VAULT,
            &[first],
            TODAY,
            at("2026-08-01T00:00:00.000Z"),
        )
        .unwrap();
        let changed_at = last_changed_at(&conn, VAULT, "sources/web-alpha.md")
            .unwrap()
            .unwrap();

        // Same content, later fetch, later stale date — the exact shape of a
        // refetch that found nothing.
        let again = copy("a", Some("2026-10-01"), "2026-08-12T00:00:00Z");
        let out = observe(
            &conn,
            VAULT,
            &[again],
            TODAY,
            at("2026-08-12T00:00:00.000Z"),
        )
        .unwrap();
        assert_eq!(out.unchanged, 1);
        assert!(
            out.changed.is_empty(),
            "no ingest work from an identical copy"
        );
        assert_eq!(
            last_changed_at(&conn, VAULT, "sources/web-alpha.md")
                .unwrap()
                .unwrap(),
            changed_at,
            "the content did not move, so neither did the time it last moved"
        );
    }

    #[test]
    fn a_changed_hash_is_reported_with_what_it_moved_from() {
        let conn = conn();
        observe(
            &conn,
            VAULT,
            &[copy("a", Some("2026-09-01"), "2026-08-01T00:00:00Z")],
            TODAY,
            at("2026-08-01T00:00:00.000Z"),
        )
        .unwrap();
        let out = observe(
            &conn,
            VAULT,
            &[copy("b", Some("2026-09-01"), "2026-08-12T00:00:00Z")],
            TODAY,
            at("2026-08-12T00:00:00.000Z"),
        )
        .unwrap();
        assert_eq!(out.changed.len(), 1);
        assert_eq!(out.changed[0].from, "a".repeat(64));
        assert_eq!(out.changed[0].to, "b".repeat(64));
    }

    #[test]
    fn a_stale_copy_lands_on_the_worklist_with_its_link() {
        let conn = conn();
        let out = observe(
            &conn,
            VAULT,
            &[copy("a", Some("2026-08-01"), "2026-07-01T00:00:00Z")],
            TODAY,
            at("2026-08-12T00:00:00.000Z"),
        )
        .unwrap();
        assert_eq!(out.due.len(), 1);
        assert_eq!(out.due[0].since, "2026-08-01");
        assert_eq!(
            out.due[0].source_url.as_deref(),
            Some("https://example.test/a"),
            "the worklist has to say what to fetch — nothing in this process can"
        );
    }

    #[test]
    fn a_copy_that_left_the_vault_is_forgotten() {
        let conn = conn();
        observe(
            &conn,
            VAULT,
            &[copy("a", None, "2026-08-01T00:00:00Z")],
            TODAY,
            at("2026-08-01T00:00:00.000Z"),
        )
        .unwrap();
        let out = observe(&conn, VAULT, &[], TODAY, at("2026-08-12T00:00:00.000Z")).unwrap();
        assert_eq!(out.forgotten, 1);
        assert_eq!(
            last_changed_at(&conn, VAULT, "sources/web-alpha.md").unwrap(),
            None
        );
    }

    #[test]
    fn a_first_sighting_is_not_ingest_work() {
        // The ordinary way a copy is first seen is that the scanner just
        // wrote it, and the scanner is already carrying those bytes.
        let conn = conn();
        let out = observe(
            &conn,
            VAULT,
            &[copy("a", None, "2026-08-01T00:00:00Z")],
            TODAY,
            at("2026-08-01T00:00:00.000Z"),
        )
        .unwrap();
        assert_eq!(out.first_seen, 1);
        assert!(out.changed.is_empty());
    }
}
