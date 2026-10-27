//! Test-gated account-grant row readers; no authority constructor.
use super::native_runs::counter;
use rusqlite::{Result, Row};

pub(crate) const GRANTS_SQL: &str = "SELECT g.*,c.person AS connection_owner,c.status,c.secret_ref,EXISTS(SELECT 1 FROM managed_secret_cleanup q WHERE q.connection_id=c.connection_id) AS cleanup_pending FROM action_account_grants g JOIN managed_connections c ON c.connection_id=g.connection_id WHERE g.run_id=?1 ORDER BY g.grant_id LIMIT ?2";
pub(crate) const GRANT_SQL: &str = "SELECT g.*,c.person AS connection_owner,c.status,c.secret_ref,EXISTS(SELECT 1 FROM managed_secret_cleanup q WHERE q.connection_id=c.connection_id) AS cleanup_pending FROM action_account_grants g JOIN managed_connections c ON c.connection_id=g.connection_id WHERE g.grant_id=?1";
#[derive(Debug, Clone, serde::Serialize)]
pub(crate) struct AccountGrant {
    pub grant_id: String,
    pub run_id: String,
    pub connection_id: String,
    pub account_id: String,
    pub account_identity_digest: String,
    pub account_revision: u64,
    pub revocation_generation: u64,
    pub action_id: String,
    pub definition_digest: String,
    pub input_scope: String,
    pub input_digest: Option<String>,
    pub capabilities_json: String,
    pub parent_grant_id: Option<String>,
    pub revision: u64,
    pub granted_by: String,
    pub revoked_at: Option<String>,
    #[serde(skip)]
    pub connection_owner: String,
    #[serde(skip)]
    pub status: String,
    #[serde(skip)]
    pub secret_ref: Option<String>,
    #[serde(skip)]
    pub cleanup_pending: bool,
}
impl AccountGrant {
    pub(crate) fn read(r: &Row<'_>) -> Result<Self> {
        use crate::connections::metadata::{bounded_optional_text, bounded_text};
        let limits = &crate::actions::schema::admission_rules().limits;
        Ok(Self {
            grant_id: bounded_text(r, "grant_id", limits.identity_bytes)?,
            run_id: bounded_text(r, "run_id", limits.identity_bytes)?,
            connection_id: bounded_text(r, "connection_id", limits.identity_bytes)?,
            account_id: bounded_text(r, "account_id", limits.identity_bytes)?,
            account_identity_digest: bounded_text(
                r,
                "account_identity_digest",
                limits.identity_bytes,
            )?,
            account_revision: counter(r, "account_revision", 1)?,
            revocation_generation: counter(r, "revocation_generation", 0)?,
            action_id: bounded_text(
                r,
                "action_id",
                crate::actions::schema::limits().string_bytes,
            )?,
            definition_digest: bounded_text(r, "definition_digest", limits.identity_bytes)?,
            input_scope: bounded_text(r, "input_scope", limits.identity_bytes)?,
            input_digest: bounded_optional_text(r, "input_digest", limits.identity_bytes)?,
            capabilities_json: bounded_text(r, "capabilities_json", limits.grant_bytes)?,
            parent_grant_id: bounded_optional_text(r, "parent_grant_id", limits.identity_bytes)?,
            revision: counter(r, "revision", 1)?,
            granted_by: bounded_text(r, "granted_by", limits.identity_bytes)?,
            revoked_at: bounded_optional_text(r, "revoked_at", limits.identity_bytes)?,
            connection_owner: bounded_text(r, "connection_owner", limits.identity_bytes)?,
            status: bounded_text(r, "status", limits.grant_bytes)?,
            secret_ref: bounded_optional_text(r, "secret_ref", limits.grant_bytes)?,
            cleanup_pending: r.get("cleanup_pending")?,
        })
    }
}
#[cfg(test)]
pub(crate) const FIXTURE_SCHEMA_V35: &str = super::schema::SCHEMA_V35;
#[cfg(test)]
mod tests {
    // A negative/oversized SQLite INTEGER must never wrap or enter an exact
    // transport counter. Removing either range guard makes these cases fail.
    #[test]
    fn native_admission_sql_counter_conversion_rejects_invalid_ranges() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        for minimum in [0, 1] {
            for value in [-1_i64, 9_007_199_254_740_992, i64::MAX] {
                assert!(
                    conn.query_row("SELECT ?1 AS value", [value], |r| super::counter(
                        r, "value", minimum
                    ))
                    .is_err(),
                    "{value}"
                );
            }
        }
        assert!(conn
            .query_row("SELECT 0 AS value", [], |r| super::counter(r, "value", 1))
            .is_err());
        assert_eq!(
            conn.query_row("SELECT 0 AS value", [], |r| super::counter(r, "value", 0))
                .unwrap(),
            0
        );
        assert_eq!(
            conn.query_row("SELECT 1 AS value", [], |r| super::counter(r, "value", 1))
                .unwrap(),
            1
        );
        assert_eq!(
            conn.query_row("SELECT 9007199254740991 AS value", [], |r| super::counter(
                r, "value", 1
            ))
            .unwrap(),
            9_007_199_254_740_991
        );
        assert!(conn
            .query_row("SELECT 1.5 AS value", [], |r| super::counter(r, "value", 0))
            .is_err());
    }
    #[test]
    fn native_admission_v35_is_installed_by_the_real_runtime_chain() {
        let dir = crate::vault::testutil::temp_vault("m96-native-real-migration");
        let conn = crate::runtime::open(&dir).unwrap();
        for table in ["action_native_runs", "action_account_grants"] {
            let exists: bool = conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
                    [table],
                    |r| r.get(0),
                )
                .unwrap();
            assert!(exists, "missing native admission table {table}");
        }
        assert_eq!(
            crate::runtime::user_version(&conn).unwrap(),
            crate::runtime::USER_VERSION
        );
    }
    fn v34_database(label: &str) -> (std::path::PathBuf, rusqlite::Connection, String) {
        let dir = crate::vault::testutil::temp_vault(label);
        let conn = rusqlite::Connection::open(crate::runtime::runtime_db_path(&dir)).unwrap();
        for migration in crate::runtime::MIGRATIONS.iter().filter(|m| m.to <= 34) {
            crate::runtime::step(&conn, migration).unwrap();
        }
        let id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let hash = "b".repeat(64);
        let payload=serde_json::json!({"details":{"effect":{"invocationId":id,"state":"outcome_unknown"},"revision":3},"request":{"requestKey":"old-key"},"request_digest":hash,"retained":{"unknown":"unchanged"}}).to_string();
        conn.execute("INSERT INTO action_invocations(invocation_id,subject_scope,request_key,request_digest,revision,state,fence,payload) VALUES(?1,?2,'old-key',?2,3,'outcome_unknown',?2,?3)",rusqlite::params![id,hash,payload]).unwrap();
        conn.execute("INSERT INTO operational_log(recorded_at,surface,code,detail) VALUES('2026-10-23T00:00:00.000Z','native-test','malformed_arguments','retained')",[]).unwrap();
        (dir, conn, payload)
    }
    #[test]
    fn native_admission_v34_upgrade_preserves_exact_old_payload_without_backfill() {
        let (dir, conn, payload) = v34_database("m96-native-v34-upgrade");
        drop(conn);
        let conn = crate::runtime::open(&dir).unwrap();
        assert_eq!(
            crate::runtime::user_version(&conn).unwrap(),
            crate::runtime::USER_VERSION
        );
        assert_eq!(
            conn.query_row("SELECT payload FROM action_invocations", [], |r| r
                .get::<_, String>(0))
                .unwrap(),
            payload
        );
        for table in ["action_native_runs", "action_account_grants"] {
            assert_eq!(
                conn.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                0
            );
        }
        assert_eq!(
            conn.query_row("SELECT detail FROM operational_log", [], |r| r
                .get::<_, String>(0))
                .unwrap(),
            "retained"
        );
        drop(conn);
        let reopened = crate::runtime::open(&dir).unwrap();
        assert_eq!(
            reopened
                .query_row("SELECT payload FROM action_invocations", [], |r| r
                    .get::<_, String>(0))
                .unwrap(),
            payload
        );
    }
    #[test]
    fn native_admission_v35_validation_failure_rolls_back_rows_indices_and_version() {
        let _lock = crate::runtime::status::test_lock();
        crate::runtime::status::clear();
        let (_dir, conn, payload) = v34_database("m96-native-v35-rollback");
        let migration = crate::runtime::Migration {
            to: 35,
            sql: crate::runtime::schema::SCHEMA_V35,
            validate: |_| Err("native admission validation probe".into()),
        };
        assert!(crate::runtime::step(&conn, &migration).is_err());
        assert_eq!(crate::runtime::user_version(&conn).unwrap(), 34);
        assert_eq!(
            conn.query_row("SELECT payload FROM action_invocations", [], |r| r
                .get::<_, String>(0))
                .unwrap(),
            payload
        );
        assert_eq!(conn.query_row("SELECT count(*) FROM sqlite_master WHERE name LIKE 'action_native_%' OR name LIKE 'action_account_grants%'",[],|r|r.get::<_,i64>(0)).unwrap(),0);
        crate::runtime::status::clear();
    }
}
