//! `parked_promotions` — what could not be promoted yet, and what it is
//! missing (M24.6).
//!
//! A qualification gate that only said "no" would be a wall. The point of
//! this table is that a refused promotion leaves a VISIBLE trace: the item,
//! the profile it was judged against, and the exact roles whose fields are
//! empty. That is a worklist a human can act on, and it is what M27's
//! epistemic-debt lane reads.
//!
//! **Operational, not ledger**, by the standing when-in-doubt rule. Every
//! column is recomputable from the vault's records plus the type docs, so
//! parking is a cache of a question and never an authority. It also means
//! parking must never be able to fail a decision: the refusal has already
//! been decided, and a database that would not take the note does not change
//! what the caller is told.
//!
//! One open row per (store, belief), enforced by a partial unique index
//! rather than by a read-then-write the gate's two passes would race on.

use rusqlite::Connection;

use crate::ledger::schema::FieldRole;

/// A promotion that could not go through, as the gate saw it.
#[derive(Debug, Clone, PartialEq)]
pub struct Parked {
    pub store_id: String,
    pub belief_id: String,
    /// The projected record, when the Belief has one — the thing a human
    /// would open to fill the missing fields in.
    pub record_path: Option<String>,
    pub type_id: String,
    pub type_schema_hash: String,
    pub missing_roles: Vec<FieldRole>,
}

/// One open row, as the debt lane reads it.
#[derive(Debug, Clone, PartialEq)]
pub struct ParkedRow {
    pub belief_id: String,
    pub record_path: Option<String>,
    pub type_id: String,
    pub missing_roles: Vec<String>,
    pub as_of: String,
}

/// The roles as stored: a JSON array of canonical role names, so the debt
/// lane reads a list rather than parsing prose.
fn encode(roles: &[FieldRole]) -> String {
    let names: Vec<&str> = roles.iter().map(FieldRole::as_str).collect();
    serde_json::to_string(&names).unwrap_or_else(|_| "[]".to_string())
}

fn decode(stored: &str) -> Vec<String> {
    serde_json::from_str(stored).unwrap_or_default()
}

/// Park a promotion, or refresh the open row if this item is already parked.
///
/// Re-parking is the NORMAL case, not an error: the gate runs once when a
/// set is decided and again immediately before it appends, and an agent that
/// retries runs it again. Upserting on the partial unique index means the
/// lane counts items, not attempts, and `missing_roles` always describes the
/// most recent look.
pub fn park(conn: &Connection, parked: &Parked) -> Result<(), String> {
    let as_of = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    conn.execute(
        "INSERT INTO parked_promotions \
         (store_id, belief_id, record_path, type_id, type_schema_hash, missing_roles, as_of) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) \
         ON CONFLICT (store_id, belief_id) WHERE cleared_at IS NULL DO UPDATE SET \
         record_path = excluded.record_path, \
         type_id = excluded.type_id, \
         type_schema_hash = excluded.type_schema_hash, \
         missing_roles = excluded.missing_roles, \
         as_of = excluded.as_of",
        rusqlite::params![
            parked.store_id,
            parked.belief_id,
            parked.record_path,
            parked.type_id,
            parked.type_schema_hash,
            encode(&parked.missing_roles),
            as_of,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Clear the open row, if there is one. Returns how many rows closed.
///
/// Called on every passing qualification check, including the ones for items
/// that were never parked — "the roles are present now" is the same fact
/// whether or not anyone recorded their absence, and making the caller ask
/// first would just be the same query twice.
pub fn clear(conn: &Connection, store_id: &str, belief_id: &str) -> Result<usize, String> {
    let cleared_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    conn.execute(
        "UPDATE parked_promotions SET cleared_at = ?1 \
         WHERE store_id = ?2 AND belief_id = ?3 AND cleared_at IS NULL",
        rusqlite::params![cleared_at, store_id, belief_id],
    )
    .map_err(|e| e.to_string())
}

/// Everything still parked in this store, oldest first — the M27 debt-lane
/// feed, and enough for a test to prove the row is visible rather than
/// merely written.
pub fn open_rows(conn: &Connection, store_id: &str) -> Result<Vec<ParkedRow>, String> {
    let mut statement = conn
        .prepare(
            "SELECT belief_id, record_path, type_id, missing_roles, as_of \
             FROM parked_promotions WHERE store_id = ?1 AND cleared_at IS NULL ORDER BY id",
        )
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([store_id], |row| {
            Ok(ParkedRow {
                belief_id: row.get(0)?,
                record_path: row.get(1)?,
                type_id: row.get(2)?,
                missing_roles: decode(&row.get::<_, String>(3)?),
                as_of: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime;
    use crate::vault::testutil;

    const BELIEF: &str = "b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1";
    const STORE: &str = "store-a";

    fn parked(roles: Vec<FieldRole>) -> Parked {
        Parked {
            store_id: STORE.into(),
            belief_id: BELIEF.into(),
            record_path: Some("knowledge/pick-a-metric.md".into()),
            type_id: "Metric".into(),
            type_schema_hash: "f".repeat(64),
            missing_roles: roles,
        }
    }

    #[test]
    fn a_parked_promotion_is_visible_with_the_roles_it_is_missing() {
        let dir = testutil::temp_vault("parked-visible");
        let conn = runtime::open(&dir).unwrap();
        park(&conn, &parked(vec![FieldRole::Evidence, FieldRole::Owner])).unwrap();

        let rows = open_rows(&conn, STORE).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].belief_id, BELIEF);
        assert_eq!(rows[0].missing_roles, vec!["evidence", "owner"]);
        assert_eq!(
            rows[0].record_path.as_deref(),
            Some("knowledge/pick-a-metric.md"),
            "the lane must point at the file a human would open"
        );
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn parking_the_same_item_twice_is_one_item_not_two_attempts() {
        // The gate runs at least twice per commit set. A lane that counted
        // attempts would grow without anything new being wrong.
        let dir = testutil::temp_vault("parked-idempotent");
        let conn = runtime::open(&dir).unwrap();
        park(&conn, &parked(vec![FieldRole::Evidence, FieldRole::Owner])).unwrap();
        park(&conn, &parked(vec![FieldRole::Owner])).unwrap();

        let rows = open_rows(&conn, STORE).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(
            rows[0].missing_roles,
            vec!["owner"],
            "the row describes the most recent look, not the first"
        );
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn clearing_closes_the_row_and_a_later_park_opens_a_new_one() {
        let dir = testutil::temp_vault("parked-clear");
        let conn = runtime::open(&dir).unwrap();
        park(&conn, &parked(vec![FieldRole::Owner])).unwrap();
        assert_eq!(clear(&conn, STORE, BELIEF).unwrap(), 1);
        assert!(open_rows(&conn, STORE).unwrap().is_empty());
        // Clearing something that was never parked is not an error.
        assert_eq!(clear(&conn, STORE, BELIEF).unwrap(), 0);

        // The history stays: a cleared row is closed, never deleted, so the
        // lane can say how long something sat.
        let total: i64 = conn
            .query_row("SELECT count(*) FROM parked_promotions", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(total, 1);

        park(&conn, &parked(vec![FieldRole::Owner])).unwrap();
        assert_eq!(open_rows(&conn, STORE).unwrap().len(), 1);
        let total: i64 = conn
            .query_row("SELECT count(*) FROM parked_promotions", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(total, 2, "regressing is a second episode, not an edit");
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn one_vaults_debt_is_not_anothers() {
        let dir = testutil::temp_vault("parked-stores");
        let conn = runtime::open(&dir).unwrap();
        park(&conn, &parked(vec![FieldRole::Owner])).unwrap();
        let mut other = parked(vec![FieldRole::Owner]);
        other.store_id = "store-b".into();
        park(&conn, &other).unwrap();

        assert_eq!(open_rows(&conn, STORE).unwrap().len(), 1);
        assert_eq!(open_rows(&conn, "store-b").unwrap().len(), 1);
        assert_eq!(clear(&conn, STORE, BELIEF).unwrap(), 1);
        assert_eq!(
            open_rows(&conn, "store-b").unwrap().len(),
            1,
            "clearing one store must not clear the other"
        );
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
