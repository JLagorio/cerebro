//! Durable scheduler rows — the storage half (M25.1).
//!
//! M25.1 owns the row and its states; M25.3 adds the dispatch state machine
//! (`pending → claimed(run_id, lease) → consumed | pending_review |
//! failed_visible`) on top of it. They are split because the one-shot upgrade
//! and the runtime-DB recovery in this phase both have to WRITE these rows
//! before anything is allowed to claim one, and a row-writing helper that
//! lived inside the dispatcher would have been copied here instead.
//!
//! Every row is scoped by `(vault_id, store_uuid, item_key)`. Two vaults
//! holding a file at the same relative path are two items; a display name or
//! a path alone can never collide work between them.

use rusqlite::Connection;

use super::normalize::Snapshot;

/// Where an item sits. The schema's `CHECK` holds the same list — this enum
/// is how Rust names them, not a second definition of what is allowed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SchedulerState {
    /// The one-shot upgrade could not prove what happened to this item, and
    /// declined to guess. Waits for an explicit owner choice.
    BaselineHeld,
    /// The runtime DB was lost or quarantined and this item's disposition is
    /// unprovable from portable receipts. Never auto-dispatched.
    RecoveryHeld,
    Pending,
    Claimed,
    /// A deterministic proposal is queued for a human. Restored as itself
    /// after a crash — never re-dispatched to an LLM.
    PendingReview,
    Consumed,
    /// Processing failed visibly. Recovery restores it as `recovery_held`:
    /// an owner retry or changed bytes, never an automatic re-spend.
    FailedVisible,
}

impl SchedulerState {
    pub fn as_str(self) -> &'static str {
        match self {
            SchedulerState::BaselineHeld => "baseline_held",
            SchedulerState::RecoveryHeld => "recovery_held",
            SchedulerState::Pending => "pending",
            SchedulerState::Claimed => "claimed",
            SchedulerState::PendingReview => "pending_review",
            SchedulerState::Consumed => "consumed",
            SchedulerState::FailedVisible => "failed_visible",
        }
    }

    pub fn parse(raw: &str) -> Option<SchedulerState> {
        Some(match raw {
            "baseline_held" => SchedulerState::BaselineHeld,
            "recovery_held" => SchedulerState::RecoveryHeld,
            "pending" => SchedulerState::Pending,
            "claimed" => SchedulerState::Claimed,
            "pending_review" => SchedulerState::PendingReview,
            "consumed" => SchedulerState::Consumed,
            "failed_visible" => SchedulerState::FailedVisible,
            _ => return None,
        })
    }

    /// Is this a state only the owner can leave? Both held states are, and
    /// that is the whole "no automatic duplicate spend" promise: nothing in
    /// the dispatcher may move an item out of them.
    pub fn is_held(self) -> bool {
        matches!(
            self,
            SchedulerState::BaselineHeld | SchedulerState::RecoveryHeld
        )
    }
}

/// One item as it is written. `snapshot` is stored whole, not hashed, so a
/// restart can diff fields rather than only notice difference.
#[derive(Debug, Clone, PartialEq)]
pub struct Row {
    pub item_key: String,
    pub source_id: Option<String>,
    pub content_hash: String,
    pub snapshot: Snapshot,
    pub event_cursor: Option<String>,
    pub route: Option<String>,
    pub state: SchedulerState,
}

/// Insert or replace one item's row, preserving `first_seen`.
///
/// Deliberately NOT an upsert that touches `claimed_by_run_id`: this helper
/// is for the two writers that own an item outright (upgrade baseline and
/// recovery rebuild). Claiming is M25.3's, is conditional on `pending`, and
/// has its own transaction.
pub fn put(conn: &Connection, vault_id: &str, store_uuid: &str, row: &Row) -> Result<(), String> {
    let now = super::now_utc();
    let snapshot = row.snapshot.canonical()?;
    conn.execute(
        "INSERT INTO scheduler (vault_id, store_uuid, item_key, source_id, content_hash, \
         normalized_prior_snapshot, normalizer_version, processing_epoch, event_cursor, route, \
         state, claimed_by_run_id, claim_expires_at, first_seen, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8, ?9, ?10, NULL, NULL, ?11, ?11) \
         ON CONFLICT (vault_id, store_uuid, item_key) DO UPDATE SET \
           source_id = excluded.source_id, \
           content_hash = excluded.content_hash, \
           normalized_prior_snapshot = excluded.normalized_prior_snapshot, \
           normalizer_version = excluded.normalizer_version, \
           event_cursor = excluded.event_cursor, \
           route = excluded.route, \
           state = excluded.state, \
           claimed_by_run_id = NULL, \
           claim_expires_at = NULL, \
           updated_at = excluded.updated_at",
        rusqlite::params![
            vault_id,
            store_uuid,
            row.item_key,
            row.source_id,
            row.content_hash,
            snapshot,
            row.snapshot.normalizer_version,
            row.event_cursor,
            row.route,
            row.state.as_str(),
            now,
        ],
    )
    .map_err(|e| format!("scheduler {}: {e}", row.item_key))?;
    Ok(())
}

/// How many items sit in each state, sorted by state name — what a banner
/// counts and what a test asserts.
pub fn counts_by_state(
    conn: &Connection,
    vault_id: &str,
    store_uuid: &str,
) -> Result<Vec<(String, i64)>, String> {
    let mut statement = conn
        .prepare(
            "SELECT state, count(*) FROM scheduler \
             WHERE vault_id = ?1 AND store_uuid = ?2 GROUP BY state ORDER BY state",
        )
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map(rusqlite::params![vault_id, store_uuid], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

/// Item keys in one state, sorted — the worklist behind "N items are waiting
/// for you to decide".
pub fn keys_in_state(
    conn: &Connection,
    vault_id: &str,
    store_uuid: &str,
    state: SchedulerState,
) -> Result<Vec<String>, String> {
    let mut statement = conn
        .prepare(
            "SELECT item_key FROM scheduler \
             WHERE vault_id = ?1 AND store_uuid = ?2 AND state = ?3 ORDER BY item_key",
        )
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map(
            rusqlite::params![vault_id, store_uuid, state.as_str()],
            |row| row.get::<_, String>(0),
        )
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

/// One item's stored row, if the scheduler knows it.
pub fn get(
    conn: &Connection,
    vault_id: &str,
    store_uuid: &str,
    item_key: &str,
) -> Result<Option<Row>, String> {
    let result = conn.query_row(
        "SELECT source_id, content_hash, normalized_prior_snapshot, event_cursor, route, state \
         FROM scheduler WHERE vault_id = ?1 AND store_uuid = ?2 AND item_key = ?3",
        rusqlite::params![vault_id, store_uuid, item_key],
        |row| {
            Ok((
                row.get::<_, Option<String>>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, String>(5)?,
            ))
        },
    );
    match result {
        Ok((source_id, content_hash, snapshot, event_cursor, route, state)) => Ok(Some(Row {
            item_key: item_key.to_string(),
            source_id,
            content_hash,
            snapshot: serde_json::from_str(&snapshot)
                .map_err(|e| format!("scheduler {item_key}: stored snapshot is unreadable: {e}"))?,
            event_cursor,
            route,
            state: SchedulerState::parse(&state)
                .ok_or_else(|| format!("scheduler {item_key}: unknown state {state:?}"))?,
        })),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(format!("scheduler {item_key}: {e}")),
    }
}

/// Move every item in `from` to `to` for one vault, returning how many moved.
/// The two held states are the only ones this is used for, and the owner is
/// the only caller — see [`super::import::resolve`].
pub fn move_state(
    conn: &Connection,
    vault_id: &str,
    store_uuid: &str,
    from: SchedulerState,
    to: SchedulerState,
) -> Result<usize, String> {
    conn.execute(
        "UPDATE scheduler SET state = ?4, updated_at = ?5 \
         WHERE vault_id = ?1 AND store_uuid = ?2 AND state = ?3",
        rusqlite::params![
            vault_id,
            store_uuid,
            from.as_str(),
            to.as_str(),
            super::now_utc()
        ],
    )
    .map_err(|e| format!("scheduler: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::normalize;
    use crate::vault::testutil;

    fn fixture(label: &str) -> (std::path::PathBuf, Connection, String) {
        let dir = testutil::temp_vault(label);
        let conn = crate::runtime::open(&dir).unwrap();
        let vault = crate::runtime::scope::register(&conn, &dir).unwrap();
        (dir, conn, vault)
    }

    fn row(key: &str, state: SchedulerState) -> Row {
        let entry = crate::vault::entry::Entry::empty_for_test(key);
        Row {
            item_key: key.to_string(),
            source_id: None,
            content_hash: "b".repeat(64),
            snapshot: normalize::snapshot(&entry),
            event_cursor: None,
            route: None,
            state,
        }
    }

    #[test]
    fn every_state_round_trips_through_its_stored_spelling() {
        for state in [
            SchedulerState::BaselineHeld,
            SchedulerState::RecoveryHeld,
            SchedulerState::Pending,
            SchedulerState::Claimed,
            SchedulerState::PendingReview,
            SchedulerState::Consumed,
            SchedulerState::FailedVisible,
        ] {
            assert_eq!(SchedulerState::parse(state.as_str()), Some(state));
        }
        assert_eq!(SchedulerState::parse("nearly"), None);
    }

    #[test]
    fn only_the_two_held_states_wait_for_a_person() {
        assert!(SchedulerState::BaselineHeld.is_held());
        assert!(SchedulerState::RecoveryHeld.is_held());
        for state in [
            SchedulerState::Pending,
            SchedulerState::Claimed,
            SchedulerState::PendingReview,
            SchedulerState::Consumed,
            SchedulerState::FailedVisible,
        ] {
            assert!(!state.is_held(), "{}", state.as_str());
        }
    }

    #[test]
    fn a_row_round_trips_with_its_whole_snapshot() {
        let (dir, conn, vault) = fixture("sched-roundtrip");
        let written = row("records/a.md", SchedulerState::Pending);
        put(&conn, &vault, "store", &written).unwrap();
        let read = get(&conn, &vault, "store", "records/a.md")
            .unwrap()
            .unwrap();
        assert_eq!(read, written, "the snapshot must survive storage whole");
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn two_vaults_holding_the_same_path_are_two_items() {
        let (dir, conn, vault_a) = fixture("sched-isolation-a");
        let other = testutil::temp_vault("sched-isolation-b");
        let vault_b = crate::runtime::scope::register(&conn, &other).unwrap();
        put(
            &conn,
            &vault_a,
            "store-a",
            &row("records/a.md", SchedulerState::Pending),
        )
        .unwrap();
        put(
            &conn,
            &vault_b,
            "store-b",
            &row("records/a.md", SchedulerState::Consumed),
        )
        .unwrap();
        assert_eq!(
            get(&conn, &vault_a, "store-a", "records/a.md")
                .unwrap()
                .unwrap()
                .state,
            SchedulerState::Pending
        );
        assert_eq!(
            get(&conn, &vault_b, "store-b", "records/a.md")
                .unwrap()
                .unwrap()
                .state,
            SchedulerState::Consumed
        );
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&other);
    }

    #[test]
    fn counts_and_worklists_read_off_the_same_rows() {
        let (dir, conn, vault) = fixture("sched-counts");
        put(
            &conn,
            &vault,
            "s",
            &row("a.md", SchedulerState::BaselineHeld),
        )
        .unwrap();
        put(
            &conn,
            &vault,
            "s",
            &row("b.md", SchedulerState::BaselineHeld),
        )
        .unwrap();
        put(&conn, &vault, "s", &row("c.md", SchedulerState::Consumed)).unwrap();
        assert_eq!(
            counts_by_state(&conn, &vault, "s").unwrap(),
            vec![
                ("baseline_held".to_string(), 2),
                ("consumed".to_string(), 1)
            ]
        );
        assert_eq!(
            keys_in_state(&conn, &vault, "s", SchedulerState::BaselineHeld).unwrap(),
            vec!["a.md".to_string(), "b.md".to_string()]
        );
        let moved = move_state(
            &conn,
            &vault,
            "s",
            SchedulerState::BaselineHeld,
            SchedulerState::Pending,
        )
        .unwrap();
        assert_eq!(moved, 2);
        assert_eq!(
            counts_by_state(&conn, &vault, "s").unwrap(),
            vec![("consumed".to_string(), 1), ("pending".to_string(), 2)]
        );
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unreadable_stored_snapshot_is_an_error_not_a_default() {
        // A snapshot that silently defaulted would make the next diff compare
        // an item against nothing and call every field new.
        let (dir, conn, vault) = fixture("sched-corrupt-snapshot");
        put(&conn, &vault, "s", &row("a.md", SchedulerState::Pending)).unwrap();
        conn.execute(
            "UPDATE scheduler SET normalized_prior_snapshot = '{\"nope\":1}'",
            [],
        )
        .unwrap();
        let err = get(&conn, &vault, "s", "a.md").unwrap_err();
        assert!(err.contains("unreadable"), "{err}");
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
