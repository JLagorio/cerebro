//! Real migration/SQLite controls. No native authority or grant writer proof.
use super::*;
use rusqlite::params;
const NOW: &str = "2026-10-24T00:00:00.000Z";
const PARENT: &str = "11111111111111111111111111111111";
const CHILD: &str = "22222222222222222222222222222222";
const REVOKED: &str = "33333333333333333333333333333333";
struct Fixture {
    data: PathBuf,
    conn: Connection,
}
impl Fixture {
    fn through_36() -> Self {
        let data = crate::vault::testutil::temp_vault("m96-action-namespace-v37");
        let conn = Connection::open(runtime_db_path(&data)).unwrap();
        conn.pragma_update(None, "foreign_keys", true).unwrap();
        conn.pragma_update(None, "journal_mode", "WAL").unwrap();
        for migration in MIGRATIONS.iter().filter(|m| m.to <= 36) {
            step(&conn, migration).unwrap();
        }
        let root = data.join("vault");
        std::fs::create_dir(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let vault = scope::register(&conn, &root).unwrap();
        conn.execute("INSERT INTO app_sessions(session_id,vault_id,store_uuid,opened_at,last_heartbeat_at,close_precision) VALUES('namespace-session',?1,'namespace-store',?2,?2,'open')", params![vault,NOW]).unwrap();
        for (run, parent, authority) in [
            ("namespace-root", None, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
            (
                "namespace-child",
                Some("namespace-root"),
                "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            ),
        ] {
            dispatch::begin_attended(
                &conn,
                run,
                Some(&vault),
                Some("namespace-store"),
                Some("claude-code"),
                parent,
                None,
                chrono::DateTime::parse_from_rfc3339(NOW)
                    .unwrap()
                    .with_timezone(&chrono::Utc),
            )
            .unwrap();
            conn.execute(
                "UPDATE runs SET cli_session_id='namespace-cli' WHERE run_id=?1",
                [run],
            )
            .unwrap();
            conn.execute("INSERT INTO action_native_runs(run_id,authority_id,revision,vault_id,store_uuid,canonical_vault_path,owner_person,actor_id,source_kind,app_session_id,cli_session_id,parent_run_id,admitted_at) VALUES(?1,?2,1,?3,'namespace-store',?4,'human:me','claude-code','run','namespace-session','namespace-cli',?5,?6)", params![run,authority,vault,root.to_str().unwrap(),parent,NOW]).unwrap();
        }
        let status=serde_json::json!({"connectionId":"namespace-connection","revision":1,"login":"fixture","health":"ready","account":{"accountId":"namespace-account","subject":"42","issuer":"https://fixture.invalid","accountRevision":1,"scopeDigest":"scope"},"secretRevision":1,"revocationGeneration":0,"observedAt":NOW,"cleanupPending":false,"remoteRevocation":"not_attempted","retainedUnknown":{"unchanged":true}}).to_string();
        let reference=serde_json::json!({"id":"ffffffffffffffffffffffffffffffff","accountId":"namespace-account","subject":"42","issuer":"https://fixture.invalid","secretRevision":1}).to_string();
        conn.execute("INSERT INTO managed_connections(connection_id,person,status,secret_ref) VALUES('namespace-connection','human:me',?1,?2)",params![status,reference]).unwrap();
        let digest = "c".repeat(64);
        for (id, run, parent, revoked) in [
            (PARENT, "namespace-root", None, None),
            (CHILD, "namespace-child", Some(PARENT), None),
            (REVOKED, "namespace-root", None, Some(NOW)),
        ] {
            conn.execute("INSERT INTO action_account_grants(grant_id,run_id,connection_id,account_id,account_identity_digest,account_revision,revocation_generation,action_id,definition_digest,input_scope,capabilities_json,parent_grant_id,revision,granted_by,granted_at,revoked_at) VALUES(?1,?2,'namespace-connection','namespace-account',?3,1,0,'Legacy:Original_ID',?3,'all_valid_inputs','[\"Legacy:Original_ID\"]',?4,1,'human:me',?5,?6)",params![id,run,digest,parent,NOW,revoked]).unwrap();
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
fn rows(conn: &Connection) -> Vec<String> {
    let mut q=conn.prepare("SELECT json_array(grant_id,run_id,connection_id,account_id,account_identity_digest,account_revision,revocation_generation,action_id,definition_digest,input_scope,input_digest,capabilities_json,parent_grant_id,revision,granted_by,granted_at,revoked_at) FROM action_account_grants ORDER BY grant_id").unwrap();
    q.query_map([], |r| r.get(0))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap()
}
fn indices(conn: &Connection) -> Vec<(String, String)> {
    let mut q=conn.prepare("SELECT name,sql FROM sqlite_master WHERE type='index' AND tbl_name='action_account_grants' AND sql IS NOT NULL ORDER BY name").unwrap();
    q.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap()
}
fn account_bytes(conn: &Connection) -> (String, String) {
    conn.query_row("SELECT status,secret_ref FROM managed_connections WHERE connection_id='namespace-connection'",[],|r|Ok((r.get(0)?,r.get(1)?))).unwrap()
}
#[test]
fn action_namespace_v37_real_open_accepts_dotted_grants_without_changing_legacy_rows() {
    let f = Fixture::through_36();
    let before = rows(&f.conn);
    let accounts = account_bytes(&f.conn);
    let old_indices = indices(&f.conn);
    let f = f.reopen();
    let after = rows(&f.conn);
    let after_accounts = account_bytes(&f.conn);
    let after_indices = indices(&f.conn);
    let dotted=f.conn.execute("UPDATE action_account_grants SET action_id='github.issue.read',capabilities_json='[\"github.issue.read\"]'",[]);
    let all_dotted = dotted.is_ok()
        && f.conn
            .query_row(
                "SELECT count(*) FROM action_account_grants WHERE action_id='github.issue.read'",
                [],
                |r| r.get::<_, i64>(0),
            )
            .unwrap()
            == 3;
    f.finish();
    assert_eq!(
        before, after,
        "migration rewrote or lost original parent/child/revoked rows"
    );
    assert_eq!(
        accounts, after_accounts,
        "migration changed account/reference bytes"
    );
    assert_eq!(
        old_indices, after_indices,
        "migration changed partial/unique index definitions"
    );
    assert!(
        all_dotted,
        "actual current runtime still refuses approved dotted action IDs: {dotted:?}"
    );
}
#[test]
fn action_namespace_v37_preserves_foreign_keys_unique_partial_indices_and_reopen() {
    let f = Fixture::through_36().reopen();
    let before = rows(&f.conn);
    let bad_parent = f.conn.execute(
        "UPDATE action_account_grants SET parent_grant_id='missing' WHERE grant_id=?1",
        [CHILD],
    );
    let bad_connection = f.conn.execute(
        "UPDATE action_account_grants SET connection_id='missing' WHERE grant_id=?1",
        [CHILD],
    );
    let duplicate=f.conn.execute("INSERT INTO action_account_grants SELECT '44444444444444444444444444444444',run_id,connection_id,account_id,account_identity_digest,account_revision,revocation_generation,action_id,definition_digest,input_scope,input_digest,capabilities_json,parent_grant_id,revision,granted_by,granted_at,revoked_at FROM action_account_grants WHERE grant_id=?1",[PARENT]);
    let no_namespace = f.conn.execute(
        "UPDATE action_account_grants SET action_id='unnamespaced' WHERE grant_id=?1",
        [PARENT],
    );
    let check: i64 = f
        .conn
        .query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| {
            r.get(0)
        })
        .unwrap();
    let self_fk:i64=f.conn.query_row("SELECT count(*) FROM pragma_foreign_key_list('action_account_grants') WHERE \"table\"='action_account_grants' AND \"from\"='parent_grant_id'",[],|r|r.get(0)).unwrap();
    let f = f.reopen();
    let after = rows(&f.conn);
    f.finish();
    assert!(
        bad_parent.is_err()
            && bad_connection.is_err()
            && duplicate.is_err()
            && no_namespace.is_err()
    );
    assert_eq!(check, 0);
    assert_eq!(self_fk, 1);
    assert_eq!(before, after);
}
#[test]
fn action_namespace_v37_validation_failure_rolls_back_exact_rows_schema_and_version() {
    let _status = super::status::test_lock();
    super::status::clear();
    let f = Fixture::through_36();
    let before = rows(&f.conn);
    let old_indices = indices(&f.conn);
    let version = user_version(&f.conn).unwrap();
    let schema: String = f
        .conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE name='action_account_grants'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let result = step(
        &f.conn,
        &Migration {
            to: 37,
            sql: super::schema::SCHEMA_V37,
            validate: |_| Err("namespace migration rollback probe".into()),
        },
    );
    let after = rows(&f.conn);
    let after_indices = indices(&f.conn);
    let after_version = user_version(&f.conn).unwrap();
    let after_schema: String = f
        .conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE name='action_account_grants'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let leftovers: i64 = f
        .conn
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE name='action_account_grants_v37'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let dotted = f.conn.execute(
        "UPDATE action_account_grants SET action_id='github.issue.read' WHERE grant_id=?1",
        [PARENT],
    );
    f.finish();
    super::status::clear();
    assert!(result.is_err());
    assert_eq!(before, after);
    assert_eq!(old_indices, after_indices);
    assert_eq!(schema, after_schema);
    assert_eq!(version, after_version);
    assert_eq!(leftovers, 0);
    assert!(dotted.is_err());
}
