//! Persisting the attention primitives (M26.7c).
//!
//! **One row per belief, replaced.** These signals describe the base as it
//! stands; a history of them would be a history of the computation, and the
//! base already keeps its own history in the place that is tamper-evident.
//!
//! **Rows for beliefs that no longer qualify are removed in the same
//! transaction.** A tombstoned belief that kept its last signal row would go
//! on looking like something to attend to forever — the exact failure mode
//! "nothing speaks first" exists to prevent, arriving through the back door
//! of a stale cache.

use rusqlite::{params, Connection};

use super::signals::{Signals, SIGNALS_VERSION};

/// What one write did.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Stored {
    pub written: usize,
    /// Rows removed because their belief is gone or no longer live.
    pub retired: usize,
}

/// Replace this store's signals with `signals`, computed at `chain_head`.
pub fn record(
    conn: &Connection,
    vault_id: &str,
    store_uuid: &str,
    chain_head: &str,
    signals: &[Signals],
    now: chrono::DateTime<chrono::Utc>,
) -> Result<Stored, String> {
    let stamp = now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;

    let mut retired = tx
        .prepare("SELECT belief_id FROM attention_signals WHERE vault_id = ?1 AND store_uuid = ?2")
        .and_then(|mut stmt| {
            stmt.query_map(params![vault_id, store_uuid], |row| row.get::<_, String>(0))?
                .collect::<Result<std::collections::BTreeSet<String>, _>>()
        })
        .map_err(|e| format!("reading attention signals: {e}"))?;

    for signal in signals {
        retired.remove(&signal.belief_id);
        tx.execute(
            "INSERT INTO attention_signals (
                 vault_id, store_uuid, belief_id, entity_id, revision_event_id,
                 signals_version, supporting_assertions, distinct_sources,
                 newest_evidence_at, evidence_age_seconds, coverage_assessments,
                 open_coverage_gaps, declared_contradictions, open_comparisons,
                 chain_head, computed_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
             ON CONFLICT (vault_id, store_uuid, belief_id) DO UPDATE SET
                 entity_id = excluded.entity_id,
                 revision_event_id = excluded.revision_event_id,
                 signals_version = excluded.signals_version,
                 supporting_assertions = excluded.supporting_assertions,
                 distinct_sources = excluded.distinct_sources,
                 newest_evidence_at = excluded.newest_evidence_at,
                 evidence_age_seconds = excluded.evidence_age_seconds,
                 coverage_assessments = excluded.coverage_assessments,
                 open_coverage_gaps = excluded.open_coverage_gaps,
                 declared_contradictions = excluded.declared_contradictions,
                 open_comparisons = excluded.open_comparisons,
                 chain_head = excluded.chain_head,
                 computed_at = excluded.computed_at",
            params![
                vault_id,
                store_uuid,
                signal.belief_id,
                signal.entity_id,
                signal.revision_event_id,
                SIGNALS_VERSION,
                signal.supporting_assertions,
                signal.distinct_sources,
                signal.newest_evidence_at,
                signal.evidence_age_seconds,
                signal.coverage_assessments,
                signal.open_coverage_gaps,
                signal.declared_contradictions,
                signal.open_comparisons,
                chain_head,
                stamp,
            ],
        )
        .map_err(|e| format!("writing attention signals for {}: {e}", signal.belief_id))?;
    }

    for belief_id in &retired {
        tx.execute(
            "DELETE FROM attention_signals
             WHERE vault_id = ?1 AND store_uuid = ?2 AND belief_id = ?3",
            params![vault_id, store_uuid, belief_id],
        )
        .map_err(|e| format!("retiring attention signals for {belief_id}: {e}"))?;
    }

    tx.commit().map_err(|e| e.to_string())?;
    Ok(Stored {
        written: signals.len(),
        retired: retired.len(),
    })
}

/// Read one store's signals, belief-id order.
pub fn read(
    conn: &Connection,
    vault_id: &str,
    store_uuid: &str,
) -> Result<Vec<(Signals, String)>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT belief_id, entity_id, revision_event_id, supporting_assertions,
                    distinct_sources, newest_evidence_at, evidence_age_seconds,
                    coverage_assessments, open_coverage_gaps, declared_contradictions,
                    open_comparisons, chain_head
             FROM attention_signals
             WHERE vault_id = ?1 AND store_uuid = ?2
             ORDER BY belief_id",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![vault_id, store_uuid], |row| {
            Ok((
                Signals {
                    belief_id: row.get(0)?,
                    entity_id: row.get(1)?,
                    revision_event_id: row.get(2)?,
                    supporting_assertions: row.get(3)?,
                    distinct_sources: row.get(4)?,
                    newest_evidence_at: row.get(5)?,
                    evidence_age_seconds: row.get(6)?,
                    coverage_assessments: row.get(7)?,
                    open_coverage_gaps: row.get(8)?,
                    declared_contradictions: row.get(9)?,
                    open_comparisons: row.get(10)?,
                },
                row.get(11)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;

    const VAULT: &str = "vault-1";
    const STORE: &str = "cafebabecafebabecafebabecafebabe";
    const HEAD: &str = "90000000000000000000000000000001";
    const B_ONE: &str = "b0000000000000000000000000000001";
    const B_TWO: &str = "b0000000000000000000000000000002";
    const ENTITY: &str = "e0000000000000000000000000000001";

    fn now() -> chrono::DateTime<chrono::Utc> {
        chrono::DateTime::parse_from_rfc3339("2026-08-12T12:00:00.000Z")
            .unwrap()
            .with_timezone(&chrono::Utc)
    }

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
        conn.execute_batch(crate::runtime::schema::SCHEMA_V7)
            .expect("v7");
        conn
    }

    fn signal(belief_id: &str, contradictions: u32) -> Signals {
        Signals {
            belief_id: belief_id.into(),
            entity_id: ENTITY.into(),
            revision_event_id: HEAD.into(),
            supporting_assertions: 1,
            distinct_sources: 1,
            newest_evidence_at: Some("2026-08-11T12:00:00.000Z".into()),
            evidence_age_seconds: Some(86_400),
            coverage_assessments: 0,
            open_coverage_gaps: 0,
            declared_contradictions: contradictions,
            open_comparisons: 0,
        }
    }

    #[test]
    fn a_second_write_replaces_rather_than_accumulates() {
        let conn = conn();
        record(&conn, VAULT, STORE, HEAD, &[signal(B_ONE, 0)], now()).unwrap();
        let out = record(&conn, VAULT, STORE, HEAD, &[signal(B_ONE, 3)], now()).unwrap();
        assert_eq!(out.written, 1);
        assert_eq!(out.retired, 0);
        let rows = read(&conn, VAULT, STORE).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].0.declared_contradictions, 3);
    }

    #[test]
    fn a_belief_that_stopped_qualifying_stops_having_a_row() {
        // The stale-cache failure mode: a tombstoned belief whose last signal
        // row survived would go on looking like something to attend to.
        let conn = conn();
        record(
            &conn,
            VAULT,
            STORE,
            HEAD,
            &[signal(B_ONE, 0), signal(B_TWO, 0)],
            now(),
        )
        .unwrap();
        let out = record(&conn, VAULT, STORE, HEAD, &[signal(B_ONE, 0)], now()).unwrap();
        assert_eq!(out.retired, 1);
        let rows = read(&conn, VAULT, STORE).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].0.belief_id, B_ONE);
    }

    #[test]
    fn no_evidence_round_trips_as_no_evidence() {
        let conn = conn();
        let mut blind = signal(B_ONE, 0);
        blind.newest_evidence_at = None;
        blind.evidence_age_seconds = None;
        blind.supporting_assertions = 0;
        blind.distinct_sources = 0;
        record(&conn, VAULT, STORE, HEAD, &[blind.clone()], now()).unwrap();
        let rows = read(&conn, VAULT, STORE).unwrap();
        assert_eq!(rows[0].0, blind);
    }

    #[test]
    fn a_stamp_without_an_age_is_refused_by_the_table_itself() {
        let conn = conn();
        let detail = conn
            .execute(
                "INSERT INTO attention_signals (
                     vault_id, store_uuid, belief_id, entity_id, revision_event_id,
                     signals_version, supporting_assertions, distinct_sources,
                     newest_evidence_at, evidence_age_seconds, coverage_assessments,
                     open_coverage_gaps, declared_contradictions, open_comparisons,
                     chain_head, computed_at
                 ) VALUES (?1, ?2, ?3, ?4, 'r', 'v', 0, 0, '2026-08-11T12:00:00.000Z',
                           NULL, 0, 0, 0, 0, 'h', '2026-08-12T12:00:00.000Z')",
                params![VAULT, STORE, B_ONE, ENTITY],
            )
            .unwrap_err()
            .to_string();
        assert!(detail.contains("CHECK"), "{detail}");
    }

    #[test]
    fn two_stores_in_one_vault_do_not_see_each_others_rows() {
        let conn = conn();
        record(&conn, VAULT, STORE, HEAD, &[signal(B_ONE, 0)], now()).unwrap();
        record(&conn, VAULT, "other", HEAD, &[signal(B_TWO, 0)], now()).unwrap();
        assert_eq!(read(&conn, VAULT, STORE).unwrap().len(), 1);
        assert_eq!(read(&conn, VAULT, "other").unwrap().len(), 1);
    }
}
