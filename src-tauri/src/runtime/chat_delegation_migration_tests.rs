#![cfg(test)]
//! Additional REDs against the real migration chain. Historical metadata is
//! deliberately plain fixture data, never a live parent/capability producer.
use super::*;
use rusqlite::params;
const NOW: &str = "2026-10-24T00:00:00.000Z";
const SESSION: &str = "00000000-0000-4000-8000-000000000032";
const AUTHORITY: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ATTEMPT: &str = "cccccccccccccccccccccccccccccccc";
struct Fixture {
    data: PathBuf,
    conn: Connection,
}
impl Fixture {
    fn through_38() -> Self {
        let data = crate::vault::testutil::temp_vault("m95-delegation-migration");
        let conn = Connection::open(runtime_db_path(&data)).unwrap();
        conn.pragma_update(None, "foreign_keys", true).unwrap();
        conn.pragma_update(None, "journal_mode", "WAL").unwrap();
        for migration in MIGRATIONS.iter().filter(|m| m.to <= 38) {
            step(&conn, migration).unwrap();
        }
        let root = data.join("vault");
        std::fs::create_dir(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let vault = scope::register(&conn, &root).unwrap();
        catchup::open_session(
            &conn,
            "historical-app-session",
            &vault,
            "store-one",
            chrono::Utc::now(),
        )
        .unwrap();
        dispatch::begin_attended(
            &conn,
            "historic-parent",
            Some(&vault),
            Some("store-one"),
            Some("claude-code"),
            None,
            None,
            chrono::Utc::now(),
        )
        .unwrap();
        conn.execute(
            "UPDATE runs SET cli_session_id=?1 WHERE run_id='historic-parent'",
            [SESSION],
        )
        .unwrap();
        conn.execute("INSERT INTO action_native_runs(run_id,authority_id,revision,vault_id,store_uuid,canonical_vault_path,owner_person,actor_id,source_kind,app_session_id,cli_session_id,admitted_at) VALUES('historic-parent',?1,1,?2,'store-one',?3,'human:me','claude-code','run','historical-app-session',?4,?5)",params![AUTHORITY,vault,root.to_str().unwrap(),SESSION,NOW]).unwrap();
        conn.execute("INSERT INTO chat_parent_attempts(parent_run_id,attempt_id,authority_id) VALUES('historic-parent',?1,?2)",params![ATTEMPT,AUTHORITY]).unwrap();
        let manifest = serde_json::json!({"run_id":"historic-parent","vault_id":vault,"store_uuid":"store-one","marker":"existing-config-metadata"}).to_string();
        conn.execute("INSERT INTO run_configurations(run_id,vault_id,store_uuid,format,captured_at,manifest_json,payload_bytes) VALUES('historic-parent',?1,'store-one',1,?2,?3,?4)",params![vault,NOW,manifest,manifest.len() as i64]).unwrap();
        conn.execute("INSERT INTO operational_log(recorded_at,surface,code,detail) VALUES(?1,'m95-historical','malformed_arguments','bounded-history')",[NOW]).unwrap();
        Self { data, conn }
    }
    fn step_39(&self) {
        let migration = MIGRATIONS
            .iter()
            .find(|m| m.to == 39)
            .expect("M95 causal storage RED: real runtime migration 39 is not registered");
        step(&self.conn, migration).unwrap();
    }
    fn seed_intent(&self, actor: &str) {
        self.conn.execute("INSERT INTO chat_delegation_intents(slot_id,request_key,parent_run_id,attempt_id,authority_id,authority_revision,owner_person,vault_id,store_uuid,parent_cli_session_id,app_session_id,actor_id,slot_ordinal) SELECT 'dddddddddddddddddddddddddddddddd','eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',n.run_id,?1,n.authority_id,n.revision,n.owner_person,n.vault_id,n.store_uuid,n.cli_session_id,n.app_session_id,?2,0 FROM action_native_runs n WHERE n.run_id='historic-parent'",params![ATTEMPT,actor]).unwrap();
    }
    fn seed_reservation(&self) {
        self.conn.execute("INSERT INTO child_job_reservations(slot_id,job_id,reserved_run_id,reserved_cli_session_id,request_digest,deadline_at,elapsed_seconds,result_bytes,occupies_slot) VALUES('dddddddddddddddddddddddddddddddd','11111111111111111111111111111111','22222222222222222222222222222222','00000000-0000-4000-8000-000000000033',?1,1600,600,262144,1)",["a".repeat(64)]).unwrap();
    }
    fn finish(self) {
        drop(self.conn);
        std::fs::remove_dir_all(self.data).unwrap();
    }
}
fn history(conn: &Connection) -> Vec<String> {
    let mut statement = conn.prepare("SELECT json_array(r.run_id,r.mode,r.outcome,r.cli_session_id,n.authority_id,n.owner_person,n.app_session_id,a.attempt_id,c.manifest_json,c.payload_bytes) FROM runs r JOIN action_native_runs n ON n.run_id=r.run_id JOIN chat_parent_attempts a ON a.parent_run_id=r.run_id JOIN run_configurations c ON c.run_id=r.run_id ORDER BY r.run_id").unwrap();
    let rows = statement
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    rows
}
#[test]
fn m95_delegation_migration_real_chain_reopens_without_backfill_or_history_rewrite() {
    let fixture = Fixture::through_38();
    let original = history(&fixture.conn);
    assert_eq!(user_version(&fixture.conn).unwrap(), 38);
    fixture.step_39();
    assert_eq!(user_version(&fixture.conn).unwrap(), 39);
    assert_eq!(history(&fixture.conn), original);
    for table in ["chat_delegation_intents", "child_job_reservations"] {
        assert_eq!(
            fixture
                .conn
                .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
    let Fixture { data, conn } = fixture;
    drop(conn);
    let conn = open(&data).unwrap();
    assert_eq!(user_version(&conn).unwrap(), USER_VERSION);
    assert_eq!(history(&conn), original);
    assert_eq!(
        conn.query_row("SELECT count(*) FROM operational_log", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
    drop(conn);
    std::fs::remove_dir_all(data).unwrap();
}
#[test]
fn m95_delegation_migration_validation_failure_rolls_back_ddl_and_version() {
    let _guard = status::test_lock();
    let previous = status::current();
    let fixture = Fixture::through_38();
    let original = history(&fixture.conn);
    let migration = MIGRATIONS
        .iter()
        .find(|m| m.to == 39)
        .expect("M95 causal storage RED: real migration 39 is missing");
    let failing = Migration {
        to: 39,
        sql: migration.sql,
        validate: |_| Err("delegation validation fault".into()),
    };
    let rejected = step(&fixture.conn, &failing).is_err();
    let version = user_version(&fixture.conn).unwrap();
    let objects: i64 = fixture.conn.query_row("SELECT count(*) FROM sqlite_master WHERE name IN ('chat_delegation_intents','child_job_reservations','chat_parent_attempt_binding')",[],|r|r.get(0)).unwrap();
    status::set(previous);
    assert!(rejected && version == 38 && objects == 0);
    assert_eq!(history(&fixture.conn), original);
    fixture.step_39();
    assert_eq!(history(&fixture.conn), original);
    fixture.finish();
}
#[test]
fn m95_delegation_migration_immutable_identity_restricts_deletion_and_never_refunds_lifetime() {
    let fixture = Fixture::through_38();
    fixture.step_39();
    fixture.seed_intent("claude-code");
    fixture.seed_reservation();
    for sql in [
        "UPDATE child_job_reservations SET request_digest=printf('%064d',0)",
        "UPDATE child_job_reservations SET deadline_at=1700",
        "UPDATE chat_delegation_intents SET parent_cli_session_id='00000000-0000-4000-8000-000000000034'",
        "DELETE FROM child_job_reservations",
        "DELETE FROM chat_delegation_intents",
        "DELETE FROM chat_parent_attempts",
        "DELETE FROM action_native_runs",
    ] { assert!(fixture.conn.execute(sql,[]).is_err(),"immutable accounting mutation was accepted"); }
    fixture
        .conn
        .execute("UPDATE child_job_reservations SET occupies_slot=0", [])
        .unwrap();
    assert!(fixture
        .conn
        .execute("UPDATE child_job_reservations SET occupies_slot=1", [])
        .is_err());
    assert_eq!(
        fixture
            .conn
            .query_row(
                "SELECT count(*),sum(occupies_slot) FROM child_job_reservations",
                [],
                |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?))
            )
            .unwrap(),
        (1, 0)
    );
    let migration = MIGRATIONS.iter().find(|m| m.to == 39).unwrap();
    (migration.validate)(&fixture.conn).unwrap();
    let Fixture { data, conn } = fixture;
    drop(conn);
    let conn = open(&data).unwrap();
    assert_eq!(
        conn.query_row(
            "SELECT count(*),sum(occupies_slot) FROM child_job_reservations",
            [],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?))
        )
        .unwrap(),
        (1, 0)
    );
    drop(conn);
    std::fs::remove_dir_all(data).unwrap();
}
#[test]
fn m95_delegation_migration_validator_refuses_changed_constraints_and_crossed_scope() {
    let fixture = Fixture::through_38();
    let migration = MIGRATIONS
        .iter()
        .find(|m| m.to == 39)
        .expect("M95 causal storage RED: migration 39 missing");
    for (from, to) in [
        ("ON DELETE RESTRICT", "ON DELETE CASCADE"),
        (
            "CREATE TRIGGER child_job_reservations_immutable",
            "CREATE TRIGGER wrong_immutable_name",
        ),
        ("CHECK(job_id<>reserved_run_id)", "CHECK(1=1)"),
    ] {
        fixture.conn.execute_batch("BEGIN IMMEDIATE").unwrap();
        fixture
            .conn
            .execute_batch(&migration.sql.replace(from, to))
            .unwrap();
        let rejected = (migration.validate)(&fixture.conn).is_err();
        fixture.conn.execute_batch("ROLLBACK").unwrap();
        assert!(rejected, "changed migration constraints were accepted");
        assert_eq!(user_version(&fixture.conn).unwrap(), 38);
    }
    fixture.step_39();
    fixture.seed_intent("process:other");
    assert!(
        (migration.validate)(&fixture.conn).is_err(),
        "individually valid FKs did not prove matching native scope"
    );
    fixture.finish();
}

#[path = "child_grant_freeze_migration_tests.rs"]
mod child_grant_freeze_migration_tests;

#[path = "child_claim_history_tests.rs"]
mod child_claim_history_tests;
