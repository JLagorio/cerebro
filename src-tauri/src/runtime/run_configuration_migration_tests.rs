//! Actual migration step rollback, not a second migration runner.
use super::*;

#[test]
fn run_configuration_migration_36_validation_failure_rolls_back_and_preserves_v35_history() {
    let _status = status::test_lock();
    let previous = status::current();
    let data = crate::vault::testutil::temp_vault("m97-configuration-migration");
    let conn = Connection::open(runtime_db_path(&data)).unwrap();
    conn.pragma_update(None, "foreign_keys", true).unwrap();
    for migration in MIGRATIONS.iter().filter(|m| m.to <= 35) {
        step(&conn, migration).unwrap();
    }
    conn.execute("INSERT INTO operational_log(recorded_at,surface,code,detail) VALUES('2026-10-24T00:00:00.000Z','configuration-fixture','malformed_arguments','fixture')",[]).unwrap();
    conn.execute("INSERT INTO runs(run_id,mode,lane,started_at,outcome,usage_state,input_tokens,output_tokens,cache_read,cache_write,reserved_total_tokens,reserved_output_tokens,proposals_submitted,applied,rejected) VALUES('m97-old-run','attended','agent','2026-10-24T00:00:00.000Z','succeeded','unknown',0,0,0,0,0,0,0,0,0)",[]).unwrap();
    let migration = MIGRATIONS.iter().find(|m| m.to == 36);
    let present = migration.is_some();
    let mut rejected = false;
    let mut rollback_version = 0;
    let mut absent_table = false;
    let mut absent_column = false;
    let mut final_version = 0;
    let mut legacy = None;
    if let Some(migration) = migration {
        fn reject(_: &Connection) -> Result<(), String> {
            Err("configuration-fixture-rejected-validation".into())
        }
        let failing = Migration {
            to: migration.to,
            sql: migration.sql,
            validate: reject,
        };
        rejected = step(&conn, &failing).is_err();
        rollback_version = user_version(&conn).unwrap();
        absent_table = !conn.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='run_configurations')",[],|r|r.get::<_,bool>(0)).unwrap();
        absent_column = !conn.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('runs') WHERE name='configuration_capture')",[],|r|r.get::<_,bool>(0)).unwrap();
        step(&conn, migration).unwrap();
        final_version = user_version(&conn).unwrap();
        legacy = conn
            .query_row(
                "SELECT configuration_capture FROM runs WHERE run_id='m97-old-run'",
                [],
                |r| r.get::<_, String>(0),
            )
            .ok();
    }
    let rows: i64 = conn
        .query_row(
            "SELECT count(*) FROM runs WHERE run_id='m97-old-run'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let log: i64 = conn
        .query_row("SELECT count(*) FROM operational_log", [], |r| r.get(0))
        .unwrap();
    drop(conn);
    std::fs::remove_dir_all(data).unwrap();
    status::set(previous);
    assert!(present, "new configuration migration is not registered");
    assert!(
        rejected && rollback_version == 35 && absent_table && absent_column,
        "failed configuration step left partial schema or version"
    );
    assert_eq!(final_version, 36);
    assert_eq!(legacy.as_deref(), Some("legacy"));
    assert_eq!(
        (rows, log),
        (1, 1),
        "configuration migration rewrote historical facts"
    );
}
