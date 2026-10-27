//! V40 migration and immutable metadata regressions on the existing history fixture.
use super::*;
fn ready() -> Fixture {
    let fixture = Fixture::through_38();
    fixture.step_39();
    fixture.seed_intent("claude-code");
    fixture.seed_reservation();
    fixture
}
fn migrate(fixture: &Fixture) {
    let migration = MIGRATIONS
        .iter()
        .find(|migration| migration.to == 40)
        .unwrap();
    step(&fixture.conn, migration).unwrap();
}
fn record(conn: &Connection) {
    conn.execute("INSERT INTO child_job_grant_freezes(slot_id,contract_digest,instruction_source_version,policy_digest) VALUES('dddddddddddddddddddddddddddddddd',?1,?2,?3)",params!["a".repeat(64),"b".repeat(64),"c".repeat(64)]).unwrap();
}
#[test]
fn m95_freeze_migration_preserves_v39_and_history_without_backfill() {
    let fixture = ready();
    let prior = history(&fixture.conn);
    let reservation:String=fixture.conn.query_row("SELECT json_array(slot_id,job_id,reserved_run_id,reserved_cli_session_id,request_digest,deadline_at,elapsed_seconds,result_bytes,occupies_slot) FROM child_job_reservations",[],|row|row.get(0)).unwrap();
    migrate(&fixture);
    assert_eq!(user_version(&fixture.conn).unwrap(), 40);
    assert_eq!(history(&fixture.conn), prior);
    assert_eq!(
        fixture
            .conn
            .query_row("SELECT count(*) FROM child_job_grant_freezes", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap(),
        0
    );
    assert_eq!(fixture.conn.query_row("SELECT json_array(slot_id,job_id,reserved_run_id,reserved_cli_session_id,request_digest,deadline_at,elapsed_seconds,result_bytes,occupies_slot) FROM child_job_reservations",[],|row|row.get::<_,String>(0)).unwrap(),reservation);
    record(&fixture.conn);
    let Fixture { data, conn } = fixture;
    drop(conn);
    let conn = open(&data).unwrap();
    assert_eq!(history(&conn), prior);
    validate_v40(&conn).unwrap();
    assert_eq!(
        conn.query_row("SELECT count(*) FROM child_job_grant_freezes", [], |row| {
            row.get::<_, i64>(0)
        })
        .unwrap(),
        1
    );
    drop(conn);
    std::fs::remove_dir_all(data).unwrap();
}
#[test]
fn m95_freeze_migration_validation_failure_rolls_back_ddl_and_version() {
    let _guard = status::test_lock();
    let prior_status = status::current();
    let fixture = ready();
    let prior = history(&fixture.conn);
    let failed = Migration {
        to: 40,
        sql: schema::SCHEMA_V40,
        validate: |_| Err("freeze migration fault".into()),
    };
    let rejected = step(&fixture.conn, &failed).is_err();
    status::set(prior_status);
    assert!(rejected);
    assert_eq!(user_version(&fixture.conn).unwrap(), 39);
    assert_eq!(history(&fixture.conn), prior);
    assert_eq!(
        fixture
            .conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE name LIKE 'child_job_grant_freezes%'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
    migrate(&fixture);
    fixture.finish();
}
#[test]
fn m95_freeze_metadata_cannot_update_delete_replace_or_hold_body_columns() {
    let fixture = ready();
    migrate(&fixture);
    record(&fixture.conn);
    for sql in [
        "UPDATE child_job_grant_freezes SET policy_digest=policy_digest",
        "DELETE FROM child_job_grant_freezes",
        "INSERT OR REPLACE INTO child_job_grant_freezes SELECT slot_id,contract_digest,instruction_source_version,policy_digest FROM child_job_grant_freezes",
    ] { assert!(fixture.conn.execute(sql,[]).is_err(),"{sql}"); }
    assert!(fixture.conn.execute("INSERT INTO child_job_grant_freezes(slot_id,contract_digest,instruction_source_version,policy_digest) VALUES('eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',?1,?2,?3)",params!["d".repeat(64),"e".repeat(64),"f".repeat(64)]).is_err());
    fixture
        .conn
        .execute_batch("ALTER TABLE child_job_grant_freezes ADD COLUMN body TEXT")
        .unwrap();
    assert!(validate_v40(&fixture.conn).is_err());
    fixture.finish();
}
#[test]
fn m95_freeze_migration_rejects_missing_immutability_trigger_and_non_digest_values() {
    let fixture = ready();
    migrate(&fixture);
    for value in [
        "private objective body".into(),
        "z".repeat(64),
        "A".repeat(64),
    ] {
        assert!(fixture.conn.execute("INSERT INTO child_job_grant_freezes(slot_id,contract_digest,instruction_source_version,policy_digest) VALUES('dddddddddddddddddddddddddddddddd',?1,?2,?3)",params![value,"b".repeat(64),"c".repeat(64)]).is_err());
    }
    record(&fixture.conn);
    fixture
        .conn
        .execute_batch("DROP TRIGGER child_job_grant_freezes_no_replace")
        .unwrap();
    assert!(validate_v40(&fixture.conn).is_err());
    fixture.finish();
}
