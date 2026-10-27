//! Real V37 -> V38 migration/storage probes. Fixtures confer no native authority.
use super::*;
use rusqlite::params;

const NOW: &str = "2026-10-24T00:00:00.000Z";
const FIRST: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SECOND: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

struct Fixture {
    data: PathBuf,
    conn: Connection,
}
impl Fixture {
    fn through_37() -> Self {
        let data = crate::vault::testutil::temp_vault("m95-parent-attempt-migration");
        let conn = Connection::open(runtime_db_path(&data)).unwrap();
        conn.pragma_update(None, "foreign_keys", true).unwrap();
        conn.pragma_update(None, "journal_mode", "WAL").unwrap();
        for migration in MIGRATIONS.iter().filter(|migration| migration.to <= 37) {
            step(&conn, migration).unwrap();
        }
        for (run, authority, folder, store) in [
            ("parent-one", FIRST, "vault-one", "store-one"),
            ("parent-two", SECOND, "vault-two", "store-two"),
        ] {
            let root = data.join(folder);
            std::fs::create_dir(&root).unwrap();
            let root = root.canonicalize().unwrap();
            let vault = scope::register(&conn, &root).unwrap();
            catchup::open_session(
                &conn,
                "migration-process",
                &vault,
                store,
                chrono::Utc::now(),
            )
            .unwrap();
            dispatch::begin_attended(
                &conn,
                run,
                Some(&vault),
                Some(store),
                Some("claude-code"),
                None,
                None,
                chrono::Utc::now(),
            )
            .unwrap();
            conn.execute("UPDATE runs SET cli_session_id='00000000-0000-4000-8000-000000000032' WHERE run_id=?1", [run]).unwrap();
            conn.execute("INSERT INTO action_native_runs(run_id,authority_id,revision,vault_id,store_uuid,canonical_vault_path,owner_person,actor_id,source_kind,app_session_id,cli_session_id,admitted_at) VALUES(?1,?2,1,?3,?4,?5,'human:me','claude-code','run','migration-process','00000000-0000-4000-8000-000000000032',?6)", params![run,authority,vault,store,root.to_str().unwrap(),NOW]).unwrap();
            // Exact pre-existing metadata bytes only; no prompt/result fixture.
            let manifest = serde_json::json!({"run_id":run,"vault_id":vault,"store_uuid":store,"retained":"configuration-metadata"}).to_string();
            conn.execute("INSERT INTO run_configurations(run_id,vault_id,store_uuid,format,captured_at,manifest_json,payload_bytes) VALUES(?1,?2,?3,1,?4,?5,?6)", params![run,vault,store,NOW,manifest,manifest.len() as i64]).unwrap();
        }
        Self { data, conn }
    }
    fn reopen(self) -> Self {
        let Self { data, conn } = self;
        drop(conn);
        let conn = open(&data).unwrap();
        Self { data, conn }
    }
    fn finish(self) {
        drop(self.conn);
        std::fs::remove_dir_all(self.data).unwrap();
    }
}
fn history(conn: &Connection) -> Vec<String> {
    let mut statement = conn.prepare(
        "SELECT json_array(r.run_id,r.vault_id,r.store_uuid,r.mode,r.outcome,r.cli_session_id,n.authority_id,n.owner_person,n.canonical_vault_path,n.app_session_id,c.manifest_json,c.payload_bytes) FROM runs r JOIN action_native_runs n ON n.run_id=r.run_id JOIN run_configurations c ON c.run_id=r.run_id ORDER BY r.run_id"
    ).unwrap();
    statement
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
}
fn attempts(conn: &Connection) -> i64 {
    conn.query_row("SELECT count(*) FROM chat_parent_attempts", [], |row| {
        row.get(0)
    })
    .unwrap()
}

#[test]
fn m95_parent_attempt_migration_real_open_preserves_scoped_history_without_backfill() {
    let fixture = Fixture::through_37();
    assert_eq!(user_version(&fixture.conn).unwrap(), 37);
    let original = history(&fixture.conn);
    let fixture = fixture.reopen();
    assert_eq!(user_version(&fixture.conn).unwrap(), USER_VERSION);
    validate_v38(&fixture.conn).unwrap();
    assert_eq!(
        attempts(&fixture.conn),
        0,
        "historical native roots must not acquire attempts by migration"
    );
    assert_eq!(history(&fixture.conn), original);
    let columns: Vec<String> = fixture
        .conn
        .prepare("SELECT name FROM pragma_table_info('chat_parent_attempts') ORDER BY cid")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(columns, ["parent_run_id", "attempt_id", "authority_id"]);
    let fixture = fixture.reopen();
    assert_eq!(attempts(&fixture.conn), 0);
    assert_eq!(history(&fixture.conn), original);
    fixture.finish();
}

#[test]
fn m95_parent_attempt_migration_constraints_and_deletion_follow_only_their_native_parent() {
    let fixture = Fixture::through_37().reopen();
    let insert = |run: &str, attempt: &str, authority: &str| {
        fixture.conn.execute(
        "INSERT INTO chat_parent_attempts(parent_run_id,attempt_id,authority_id) VALUES(?1,?2,?3)",
        params![run,attempt,authority],
    )
    };
    for bad in ["", "short", "GGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG"] {
        assert!(insert("parent-one", bad, FIRST).is_err());
    }
    let first = "11111111111111111111111111111111";
    let second = "22222222222222222222222222222222";
    assert!(insert("missing-parent", first, FIRST).is_err());
    assert!(insert("parent-one", first, "cccccccccccccccccccccccccccccccc").is_err());
    insert("parent-one", first, FIRST).unwrap();
    assert!(insert("parent-one", second, SECOND).is_err());
    assert!(insert("parent-two", first, SECOND).is_err());
    assert!(insert("parent-two", second, FIRST).is_err());
    insert("parent-two", second, SECOND).unwrap();
    assert_eq!(attempts(&fixture.conn), 2);
    fixture
        .conn
        .execute(
            "UPDATE runs SET outcome='cancelled',ended_at=?1 WHERE run_id='parent-one'",
            [NOW],
        )
        .unwrap();
    assert_eq!(
        attempts(&fixture.conn),
        2,
        "settlement retains metadata history"
    );
    fixture
        .conn
        .execute(
            "DELETE FROM action_native_runs WHERE run_id='parent-one'",
            [],
        )
        .unwrap();
    assert_eq!(attempts(&fixture.conn), 1);
    let remaining: String = fixture
        .conn
        .query_row(
            "SELECT parent_run_id FROM chat_parent_attempts",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        remaining, "parent-two",
        "deletion crossed vault/native-parent scope"
    );
    let bad: i64 = fixture
        .conn
        .query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(bad, 0);
    fixture.finish();
}

#[test]
fn m95_parent_attempt_migration_validation_refusal_rolls_back_schema_version_and_history() {
    let _guard = status::test_lock();
    let previous = status::current();
    let fixture = Fixture::through_37();
    let original = history(&fixture.conn);
    let migration = MIGRATIONS
        .iter()
        .find(|migration| migration.to == 38)
        .unwrap();
    let failing = Migration {
        to: migration.to,
        sql: migration.sql,
        validate: |_| Err("parent-attempt-validation-probe".into()),
    };
    let refused = step(&fixture.conn, &failing).is_err();
    let version = user_version(&fixture.conn).unwrap();
    let table: bool = fixture
        .conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='chat_parent_attempts')",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let unchanged = history(&fixture.conn) == original;
    status::set(previous);
    assert!(refused && version == 37 && !table && unchanged);
    step(&fixture.conn, migration).unwrap();
    assert_eq!(user_version(&fixture.conn).unwrap(), 38);
    assert_eq!(attempts(&fixture.conn), 0);
    assert_eq!(history(&fixture.conn), original);
    fixture.finish();
}

#[test]
fn m95_parent_attempt_migration_validator_rejects_missing_constraints_and_crossed_authority() {
    for clause in [
        "PRIMARY KEY NOT NULL",
        "REFERENCES action_native_runs(run_id) ON DELETE CASCADE",
        "attempt_id TEXT NOT NULL UNIQUE",
        "CHECK(length(attempt_id)=32 AND NOT attempt_id GLOB '*[^0-9a-f]*')",
        "REFERENCES action_native_runs(authority_id) ON DELETE CASCADE",
    ] {
        let fixture = Fixture::through_37();
        let replacement = if clause == "attempt_id TEXT NOT NULL UNIQUE" {
            "attempt_id TEXT NOT NULL"
        } else {
            ""
        };
        fixture
            .conn
            .execute_batch(&schema::SCHEMA_V38.replace(clause, replacement))
            .unwrap();
        assert!(validate_v38(&fixture.conn).is_err(), "missing {clause}");
        fixture.finish();
    }
    let fixture = Fixture::through_37().reopen();
    fixture.conn.execute("INSERT INTO chat_parent_attempts(parent_run_id,attempt_id,authority_id) VALUES('parent-one','11111111111111111111111111111111',?1)", [SECOND]).unwrap();
    assert!(
        validate_v38(&fixture.conn).is_err(),
        "separate valid FKs do not establish the same native parent"
    );
    fixture.finish();
}

#[test]
fn m95_parent_attempt_migration_unstarted_attended_discard_has_no_metadata_obligation() {
    let fixture = Fixture::through_37().reopen();
    dispatch::begin_attended(
        &fixture.conn,
        "never-published",
        None,
        None,
        None,
        None,
        None,
        chrono::Utc::now(),
    )
    .unwrap();
    dispatch::discard_unstarted_attended(&fixture.conn, "never-published").unwrap();
    let rows: i64 = fixture
        .conn
        .query_row(
            "SELECT count(*) FROM runs WHERE run_id='never-published'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(rows, 0);
    assert_eq!(attempts(&fixture.conn), 0);
    fixture.finish();
}
