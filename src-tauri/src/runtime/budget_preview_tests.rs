//! Budget-preview extraction regressions. Real migrations and SELECT-only
//! snapshots; no dispatcher, provider, CLI, grant, or synthetic budget store.
use super::*;
use rusqlite::{types::Value, Transaction, TransactionBehavior};

const VAULT: &str = "cccccccccccccccccccccccccccccccc";
const STORE: &str = "preview-store";
const ACTOR: &str = "process:digest";

fn at(raw: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(raw).unwrap().with_timezone(&Utc)
}

fn now() -> DateTime<Utc> { at("2026-10-27T10:00:00Z") }
fn small() -> Reservation { Reservation { total_tokens: 10, output_tokens: 5 } }
fn settings_in(zone: &str) -> Settings {
    Settings { ceilings: shipped_defaults().unwrap(), timezone_id: zone.into() }
}

fn empty() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.pragma_update(None, "foreign_keys", true).unwrap();
    for migration in crate::runtime::MIGRATIONS {
        crate::runtime::step(&conn, migration).unwrap();
    }
    conn.execute(
        "INSERT INTO vault_registry(vault_id,vault_path,first_seen_at) VALUES(?1,'preview-fixture','2026-10-27T00:00:00.000Z')",
        [VAULT],
    ).unwrap();
    conn
}

fn ready() -> Connection {
    let conn = empty();
    append_version(&conn, &settings_in("UTC"), now()).unwrap();
    ensure_day(&conn, now()).unwrap();
    conn
}

type Snapshot = Vec<(String, Vec<Vec<Value>>)>;
fn snapshot(conn: &Connection) -> Snapshot {
    let mut table_query = conn.prepare(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).unwrap();
    let names = table_query.query_map([], |row| row.get::<_, String>(0)).unwrap()
        .collect::<Result<Vec<_>, _>>().unwrap();
    names.into_iter().map(|name| {
        let mut query = conn.prepare(&format!("SELECT * FROM \"{}\"", name.replace('"', "\"\""))).unwrap();
        let columns = query.column_count();
        let mut rows = query.query_map([], |row| {
            (0..columns).map(|index| row.get::<_, Value>(index)).collect::<rusqlite::Result<Vec<_>>>()
        }).unwrap().collect::<Result<Vec<_>, _>>().unwrap();
        rows.sort_by_key(|row| format!("{row:?}"));
        (name, rows)
    }).collect()
}

fn changes(conn: &Connection) -> i64 {
    conn.query_row("SELECT total_changes()", [], |row| row.get(0)).unwrap()
}

fn read<T>(conn: &Connection, work: impl FnOnce(&Connection) -> T) -> T {
    let before = snapshot(conn);
    let writes = changes(conn);
    conn.pragma_update(None, "query_only", true).unwrap();
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Deferred).unwrap();
    let result = work(&tx);
    assert_eq!(snapshot(&tx), before, "preview changed a recorded fact");
    assert_eq!(changes(&tx), writes, "preview attempted a successful row write");
    tx.rollback().unwrap();
    conn.pragma_update(None, "query_only", false).unwrap();
    result
}

fn preview(conn: &Connection, clock: DateTime<Utc>) -> Result<(Decision, Day), String> {
    preview_rows(conn, VAULT, STORE, "filed", Some(ACTOR), small(), clock)
}

fn production(conn: &Connection, clock: DateTime<Utc>) -> (Decision, Day) {
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate).unwrap();
    let value = gate(&tx, VAULT, STORE, "filed", Some(ACTOR), small(), clock).unwrap();
    tx.rollback().unwrap();
    value
}

#[test]
fn preview_refuses_a_non_snapshot_connection() {
    let conn = ready();
    let before = snapshot(&conn);
    assert_eq!(preview(&conn, now()).unwrap_err(), "budget preview requires an active transaction");
    assert_eq!(snapshot(&conn), before);
}

#[test]
fn preview_does_not_initialize_missing_settings_or_a_day() {
    let conn = empty();
    assert!(read(&conn, |db| preview(db, now())).is_err());
    assert_eq!(latest_version(&conn).unwrap(), None);
    let days: i64 = conn.query_row("SELECT count(*) FROM budget_days", [], |row| row.get(0)).unwrap();
    assert_eq!(days, 0);
}

#[test]
fn preview_does_not_open_a_day_when_only_settings_exist() {
    let conn = empty();
    append_version(&conn, &settings_in("UTC"), now()).unwrap();
    assert!(read(&conn, |db| preview(db, now())).is_err());
    let days: i64 = conn.query_row("SELECT count(*) FROM budget_days", [], |row| row.get(0)).unwrap();
    assert_eq!(days, 0);
}

#[test]
fn preview_uses_a_recorded_day_without_reserving_or_recording_a_decision() {
    let conn = ready();
    let observed = read(&conn, |db| preview(db, now())).unwrap();
    assert_eq!(observed.0, Decision::Proceed);
    assert_eq!(observed.1.window_start_utc, "2026-10-27T00:00:00.000Z");
    assert_eq!(observed.1.settings_version, 1);
    assert_eq!(observed.1.ambient_runs_started, 0);
    assert_eq!(observed.1.reserved_total_tokens, 0);
    assert_eq!(observed, production(&conn, now()));
}

#[test]
fn preview_refuses_an_unrecorded_new_day_instead_of_reusing_yesterday() {
    let conn = ready();
    // Reach the actual positive branch before testing its rollover refusal.
    assert_eq!(read(&conn, |db| preview(db, now())).unwrap().0, Decision::Proceed);
    assert!(read(&conn, |db| preview(db, at("2026-10-28T00:00:00Z"))).is_err());
    let days: i64 = conn.query_row("SELECT count(*) FROM budget_days", [], |row| row.get(0)).unwrap();
    assert_eq!(days, 1);
}

#[test]
fn preview_keeps_copied_settings_while_a_new_version_waits_for_handover() {
    let conn = ready();
    let mut edited = settings_in("UTC");
    edited.ceilings.max_daily_runs = 0;
    append_version(&conn, &edited, at("2026-10-27T11:00:00Z")).unwrap();
    let observed = read(&conn, |db| preview(db, at("2026-10-27T12:00:00Z"))).unwrap();
    assert_eq!(observed.0, Decision::Proceed);
    assert_eq!(observed.1.settings_version, 1);
    assert_eq!(observed.1.ceilings.max_daily_runs, 20);
    assert_eq!(observed, production(&conn, at("2026-10-27T12:00:00Z")));
}

#[test]
fn preview_uses_the_short_timezone_handover_day_not_a_second_window_algorithm() {
    let conn = ready();
    append_version(&conn, &settings_in("America/New_York"), at("2026-10-27T11:00:00Z")).unwrap();
    let clock = at("2026-10-28T01:00:00Z");
    ensure_day(&conn, clock).unwrap();
    let observed = read(&conn, |db| preview(db, clock)).unwrap();
    assert_eq!(observed.0, Decision::Proceed);
    assert_eq!(observed.1.settings_version, 2);
    assert_eq!(observed.1.timezone_id, "America/New_York");
    assert_eq!(observed.1.window_start_utc, "2026-10-28T00:00:00.000Z");
    assert_eq!(observed.1.window_end_utc, "2026-10-28T04:00:00.000Z");
    assert_eq!(observed, production(&conn, clock));
}

#[test]
fn preview_collects_both_pauses_for_the_selected_actor_and_vault() {
    let conn = ready();
    settings::set_global_pause(&conn, true).unwrap();
    settings::set_agent_paused(&conn, VAULT, ACTOR, true).unwrap();
    let observed = read(&conn, |db| preview(db, now())).unwrap();
    assert_eq!(observed.0, Decision::Deferred(vec![GateReason::AgentPaused, GateReason::GlobalPause]));
    assert_eq!(observed, production(&conn, now()));
    let another = read(&conn, |db| preview_rows(db, VAULT, STORE, "filed", Some("process:other"), small(), now())).unwrap();
    assert_eq!(another.0, Decision::Deferred(vec![GateReason::GlobalPause]));
}

#[test]
fn preview_preserves_unknown_accounting_and_disabled_lane_as_separate_reasons() {
    let conn = ready();
    mark_accounting_unknown(&conn, "2026-10-27T00:00:00.000Z").unwrap();
    settings::set_lane_enabled(&conn, VAULT, "filed", false).unwrap();
    let observed = read(&conn, |db| preview(db, now())).unwrap();
    assert_eq!(observed.0, Decision::Deferred(vec![GateReason::AccountingUnknown, GateReason::LaneDisabled]));
    assert_eq!(observed, production(&conn, now()));
}

#[test]
fn preview_separates_insufficient_remaining_headroom_from_a_per_run_cap() {
    let conn = ready();
    conn.execute("UPDATE budget_days SET ambient_tokens_used=199995", []).unwrap();
    let observed = read(&conn, |db| preview(db, now())).unwrap();
    assert_eq!(observed.0, Decision::Deferred(vec![GateReason::ReservationExceedsRemaining]));
    assert_eq!(observed, production(&conn, now()));
    let too_large = read(&conn, |db| preview_rows(db, VAULT, STORE, "filed", Some(ACTOR),
        Reservation { total_tokens: 20001, output_tokens: 5 }, now())).unwrap();
    assert_eq!(too_large.0, Decision::Deferred(vec![GateReason::ReservationExceedsRunCap]));
}

#[test]
fn preview_uses_the_production_lane_priority_ramp() {
    let conn = ready();
    conn.execute("UPDATE budget_days SET ambient_tokens_used=160000", []).unwrap();
    let low = read(&conn, |db| preview_rows(db, VAULT, STORE, "schema", Some(ACTOR), small(), now())).unwrap();
    assert_eq!(low.0, Decision::Deferred(vec![GateReason::DailyTokens]));
    let high = read(&conn, |db| preview(db, now())).unwrap();
    assert_eq!(high.0, Decision::Proceed);
    assert_eq!(high, production(&conn, now()));
}

#[test]
fn preview_respects_scoped_failure_counts_and_the_explicit_backoff_clock() {
    let conn = ready();
    conn.execute("INSERT INTO ambient_gate_state(vault_id,store_uuid,lane,consecutive_failures) VALUES(?1,?2,'filed',3)",
        rusqlite::params![VAULT, STORE]).unwrap();
    conn.execute("INSERT INTO backoff(vault_id,lane,until,reason,quota_window_key) VALUES(NULL,'filed','2026-10-27T11:00:00.000Z','quota','preview')", []).unwrap();
    let observed = read(&conn, |db| preview(db, now())).unwrap();
    assert_eq!(observed.0, Decision::Deferred(vec![GateReason::ConsecutiveFailures, GateReason::QuotaBackoff]));
    assert_eq!(observed, production(&conn, now()));
    let another = read(&conn, |db| preview_rows(db, VAULT, "different-store", "filed", Some(ACTOR), small(), now())).unwrap();
    assert_eq!(another.0, Decision::Deferred(vec![GateReason::QuotaBackoff]));
    let expired = read(&conn, |db| preview_rows(db, VAULT, "different-store", "filed", Some(ACTOR), small(), at("2026-10-27T11:00:00Z"))).unwrap();
    assert_eq!(expired.0, Decision::Proceed);
}

#[test]
fn preview_measures_live_leases_without_claiming_or_recovering_them() {
    let conn = ready();
    conn.execute(
        "INSERT INTO runs(run_id,vault_id,store_uuid,mode,lane,started_at,outcome,usage_state,input_tokens,output_tokens,cache_read,cache_write,reserved_total_tokens,reserved_output_tokens,proposals_submitted,applied,rejected) VALUES('preview-running',?1,?2,'ambient','filed','2026-10-27T09:00:00.000Z','running','pending',0,0,0,0,0,0,0,0,0)",
        rusqlite::params![VAULT, STORE],
    ).unwrap();
    conn.execute(
        "INSERT INTO ambient_dispatch(run_id,vault_id,store_uuid,lane,acquired_at,lease_expires_at) VALUES('preview-running',?1,?2,'filed','2026-10-27T09:00:00.000Z','2026-10-27T11:00:00.000Z')",
        rusqlite::params![VAULT, STORE],
    ).unwrap();
    let observed = read(&conn, |db| preview(db, now())).unwrap();
    assert_eq!(observed.0, Decision::Deferred(vec![GateReason::AmbientBusy]));
    assert_eq!(observed, production(&conn, now()));
    let expired = read(&conn, |db| preview(db, at("2026-10-27T11:00:00Z"))).unwrap();
    assert_eq!(expired.0, Decision::Proceed);
    let leases: i64 = conn.query_row("SELECT count(*) FROM ambient_dispatch", [], |row| row.get(0)).unwrap();
    assert_eq!(leases, 1, "preview must not perform recovery");
}

#[test]
fn preview_does_not_turn_an_unreadable_required_table_into_permission() {
    let conn = ready();
    assert_eq!(read(&conn, |db| preview(db, now())).unwrap().0, Decision::Proceed);
    conn.execute_batch("DROP TABLE ambient_gate_state").unwrap();
    assert!(read(&conn, |db| preview(db, now())).is_err());
}


#[test]
fn production_gate_without_an_actor_refuses_unreadable_settings_instead_of_using_absent_defaults() {
    let conn = ready();
    // Legitimately absent pause/concurrency/override rows retain production defaults.
    let tx = Transaction::new_unchecked(&conn, TransactionBehavior::Immediate).unwrap();
    assert_eq!(gate(&tx, VAULT, STORE, "filed", None, small(), now()).unwrap().0, Decision::Proceed);
    tx.rollback().unwrap();
    conn.execute_batch("DROP TABLE settings").unwrap();
    let tx = Transaction::new_unchecked(&conn, TransactionBehavior::Immediate).unwrap();
    assert!(gate(&tx, VAULT, STORE, "filed", None, small(), now()).is_err(),
        "an unreadable settings table is not an observed unpaused subscription with default concurrency");
    tx.rollback().unwrap();
    assert!(read(&conn, |db| preview_rows(db, VAULT, STORE, "filed", None, small(), now())).is_err());
}
