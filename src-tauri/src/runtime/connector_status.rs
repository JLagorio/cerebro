//! The last status each connector was seen in, per vault (M54.11).
//!
//! The meter writes what a run's stream said about each of its connectors
//! (`agent::connector_signals`) once the run is over, and Settings reads the
//! newest row per connector through the `connector_status` command. No row
//! is "not observed yet", never a state: a connector no run has used says
//! nothing about whether it works.
//!
//! Names, states, times and run ids only. Nothing here is credential
//! material: the URL, the headers and any token stay in the vault's list and
//! in Claude Code.

use rusqlite::{params, Connection};

/// What one observation concluded about a connector. The words are the
/// `state` CHECK in `schema::SCHEMA_V19`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    /// A call succeeded, or init said the server connected.
    Working,
    /// Init said the server needs sign-in (`needs-auth`).
    NeedsSignIn,
    /// Init said the server failed, or every call it got errored.
    Failed,
    /// Claude Code's own permission rules stopped a call the run's grant
    /// allowed.
    NotApproved,
}

impl State {
    pub fn as_str(self) -> &'static str {
        match self {
            State::Working => "working",
            State::NeedsSignIn => "needs_sign_in",
            State::Failed => "failed",
            State::NotApproved => "not_approved",
        }
    }
}

/// What in a run's stream decided the state. The words are the `signal`
/// CHECK, which also names `authenticate` and `server_error`: CLI 2.1.250
/// emits neither in `-p` (recorded), so nothing here produces them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Signal {
    /// The run's `system/init` status for the server.
    Init,
    /// A successful tool result.
    ToolResult,
    /// Every call the server got errored.
    ToolErrors,
    /// A denial in the run's result.
    PermissionDenial,
}

impl Signal {
    pub fn as_str(self) -> &'static str {
        match self {
            Signal::Init => "init",
            Signal::ToolResult => "tool_result",
            Signal::ToolErrors => "tool_errors",
            Signal::PermissionDenial => "permission_denial",
        }
    }
}

/// One connector, as one run saw it. `connector` is its name in the vault's
/// list; `seen_at` is in `runtime::now_utc`'s spelling.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Observation {
    pub connector: String,
    pub state: State,
    pub signal: Signal,
    pub seen_at: String,
}

/// The newest observation of one connector in one vault, as stored.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Row {
    pub connector: String,
    pub state: String,
    pub signal: String,
    pub seen_at: String,
    pub run_id: String,
}

/// Record one run's observations in one transaction. Each connector keeps
/// whichever observation was seen last, whatever order the runs finish in: a
/// run that started earlier and ended later must not overwrite what a newer
/// run saw. Times share one spelling, so comparing the strings compares the
/// instants.
pub fn record(
    conn: &Connection,
    vault_id: &str,
    run_id: &str,
    observations: &[Observation],
) -> Result<(), String> {
    if observations.is_empty() {
        return Ok(());
    }
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("connector_status: {e}"))?;
    for seen in observations {
        tx.execute(
            "INSERT INTO connector_status (vault_id, connector, state, signal, seen_at, run_id) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6) \
             ON CONFLICT (vault_id, connector) DO UPDATE SET \
                 state = excluded.state, signal = excluded.signal, \
                 seen_at = excluded.seen_at, run_id = excluded.run_id \
             WHERE excluded.seen_at >= connector_status.seen_at",
            params![
                vault_id,
                seen.connector,
                seen.state.as_str(),
                seen.signal.as_str(),
                seen.seen_at,
                run_id
            ],
        )
        .map_err(|e| format!("connector_status: {}: {e}", seen.connector))?;
    }
    tx.commit().map_err(|e| format!("connector_status: {e}"))
}

/// Every connector this vault has a row for, by name. A vault nobody
/// registered has none, and reading never registers it.
pub fn read(conn: &Connection, vault_id: &str) -> Result<Vec<Row>, String> {
    let mut statement = conn
        .prepare(
            "SELECT connector, state, signal, seen_at, run_id FROM connector_status \
             WHERE vault_id = ?1 ORDER BY connector",
        )
        .map_err(|e| format!("connector_status: {e}"))?;
    let rows = statement
        .query_map([vault_id], |row| {
            Ok(Row {
                connector: row.get(0)?,
                state: row.get(1)?,
                signal: row.get(2)?,
                seen_at: row.get(3)?,
                run_id: row.get(4)?,
            })
        })
        .map_err(|e| format!("connector_status: {e}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("connector_status: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::{self, scope};
    use crate::vault::testutil;

    fn seen(connector: &str, state: State, signal: Signal, seen_at: &str) -> Observation {
        Observation {
            connector: connector.into(),
            state,
            signal,
            seen_at: seen_at.into(),
        }
    }

    /// A fresh runtime database with one registered vault.
    fn registered(label: &str) -> (std::path::PathBuf, Connection, String) {
        let dir = testutil::temp_vault(label);
        let conn = runtime::open(&dir).unwrap();
        let vault = scope::register(&conn, &dir).unwrap();
        (dir, conn, vault)
    }

    #[test]
    fn a_newer_observation_wins_whatever_order_runs_finish() {
        let (dir, conn, vault) = registered("connector-status-newer");
        let older = seen(
            "gmail",
            State::NeedsSignIn,
            Signal::Init,
            "2026-10-13T09:00:00.000Z",
        );
        let newer = seen(
            "gmail",
            State::Working,
            Signal::ToolResult,
            "2026-10-13T10:00:00.000Z",
        );
        // The newer run finishes first, and the older one's late write must
        // not take its place.
        record(&conn, &vault, "run-new", std::slice::from_ref(&newer)).unwrap();
        record(&conn, &vault, "run-old", std::slice::from_ref(&older)).unwrap();
        let rows = read(&conn, &vault).unwrap();
        assert_eq!(
            rows,
            [Row {
                connector: "gmail".into(),
                state: "working".into(),
                signal: "tool_result".into(),
                seen_at: "2026-10-13T10:00:00.000Z".into(),
                run_id: "run-new".into(),
            }]
        );
        // And in the other order the newer one replaces the older.
        let (dir2, conn2, vault2) = registered("connector-status-newer-2");
        record(&conn2, &vault2, "run-old", &[older]).unwrap();
        record(&conn2, &vault2, "run-new", &[newer]).unwrap();
        let rows = read(&conn2, &vault2).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].state, "working");
        assert_eq!(rows[0].run_id, "run-new");
        drop((conn, conn2));
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&dir2);
    }

    #[test]
    fn rows_are_scoped_by_vault() {
        let (dir, conn, first) = registered("connector-status-scope-a");
        let other_dir = testutil::temp_vault("connector-status-scope-b");
        let second = scope::register(&conn, &other_dir).unwrap();
        record(
            &conn,
            &first,
            "run-a",
            &[seen(
                "gmail",
                State::Working,
                Signal::Init,
                "2026-10-13T10:00:00.000Z",
            )],
        )
        .unwrap();
        record(
            &conn,
            &second,
            "run-b",
            &[
                seen(
                    "gmail",
                    State::Failed,
                    Signal::ToolErrors,
                    "2026-10-13T11:00:00.000Z",
                ),
                seen(
                    "linear",
                    State::NotApproved,
                    Signal::PermissionDenial,
                    "2026-10-13T11:00:00.000Z",
                ),
            ],
        )
        .unwrap();
        let a = read(&conn, &first).unwrap();
        assert_eq!(a.len(), 1);
        assert_eq!(
            (a[0].state.as_str(), a[0].run_id.as_str()),
            ("working", "run-a")
        );
        let b: Vec<(String, String)> = read(&conn, &second)
            .unwrap()
            .into_iter()
            .map(|row| (row.connector, row.state))
            .collect();
        assert_eq!(
            b,
            [
                ("gmail".to_string(), "failed".to_string()),
                ("linear".to_string(), "not_approved".to_string())
            ]
        );
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&other_dir);
    }

    #[test]
    fn the_schema_refuses_an_unknown_state() {
        let (dir, conn, vault) = registered("connector-status-check");
        let insert = |state: &str, signal: &str, seen_at: &str| {
            conn.execute(
                "INSERT INTO connector_status (vault_id, connector, state, signal, seen_at, \
                 run_id) VALUES (?1, 'gmail', ?2, ?3, ?4, 'run-1')",
                params![vault, state, signal, seen_at],
            )
        };
        assert!(insert("connected", "init", "2026-10-13T10:00:00.000Z").is_err());
        assert!(insert("pending", "init", "2026-10-13T10:00:00.000Z").is_err());
        assert!(insert("working", "guess", "2026-10-13T10:00:00.000Z").is_err());
        assert!(insert("working", "init", "yesterday").is_err());
        // Every word the enums speak is one the CHECK takes.
        for (i, state) in [
            State::Working,
            State::NeedsSignIn,
            State::Failed,
            State::NotApproved,
        ]
        .into_iter()
        .enumerate()
        {
            for signal in [
                Signal::Init,
                Signal::ToolResult,
                Signal::ToolErrors,
                Signal::PermissionDenial,
            ] {
                record(
                    &conn,
                    &vault,
                    "run-1",
                    &[seen(
                        &format!("c{i}"),
                        state,
                        signal,
                        "2026-10-13T10:00:00.000Z",
                    )],
                )
                .unwrap_or_else(|e| panic!("{state:?} {signal:?}: {e}"));
            }
        }
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unregistered_vault_reads_empty() {
        let dir = testutil::temp_vault("connector-status-unregistered");
        let conn = runtime::open(&dir).unwrap();
        let never = scope::derive_vault_id(&dir.join("never-opened"));
        assert_eq!(read(&conn, &never).unwrap(), []);
        let registered: i64 = conn
            .query_row(
                "SELECT count(*) FROM vault_registry WHERE vault_id = ?1",
                [&never],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(registered, 0, "a read never registers the vault");
        // Nor can a write invent one: the row needs a registered vault.
        assert!(record(
            &conn,
            &never,
            "run-1",
            &[seen(
                "gmail",
                State::Working,
                Signal::Init,
                "2026-10-13T10:00:00.000Z"
            )]
        )
        .is_err());
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
