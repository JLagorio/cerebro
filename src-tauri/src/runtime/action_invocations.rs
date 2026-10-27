//! Durable action records are operational and survive conversation retention.

use rusqlite::{Connection, OptionalExtension};

pub(crate) fn load(conn: &Connection, id: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        "SELECT payload FROM action_invocations WHERE invocation_id=?1",
        [id],
        |r| r.get(0),
    )
    .optional()
}
pub(crate) fn save(
    conn: &Connection,
    id: &str,
    expected: u64,
    revision: u64,
    state_json: &str,
    payload: &str,
    fence: Option<&str>,
) -> rusqlite::Result<bool> {
    conn.execute("UPDATE action_invocations SET revision=?1,state=json_extract(?2,'$'),payload=?3,fence=?4 WHERE invocation_id=?5 AND revision=?6", rusqlite::params![i64::try_from(revision).map_err(|_|rusqlite::Error::InvalidQuery)?,state_json,payload,fence,id,i64::try_from(expected).map_err(|_|rusqlite::Error::InvalidQuery)?]).map(|n|n==1)
}
pub(crate) fn save_approval(
    conn: &Connection,
    id: &str,
    invocation: &str,
    payload: &str,
) -> rusqlite::Result<()> {
    conn.execute("INSERT INTO action_approvals(approval_id,invocation_id,payload) VALUES(?1,?2,?3) ON CONFLICT(approval_id) DO UPDATE SET payload=excluded.payload", rusqlite::params![id,invocation,payload])?;
    Ok(())
}

pub(crate) fn by_request(
    conn: &Connection,
    scope: &str,
    key: &str,
) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        "SELECT payload FROM action_invocations WHERE subject_scope=?1 AND request_key=?2",
        rusqlite::params![scope, key],
        |r| r.get(0),
    )
    .optional()
}
pub(crate) fn fence_busy(
    conn: &Connection,
    fence: &str,
    except: Option<&str>,
) -> rusqlite::Result<bool> {
    conn.query_row("SELECT EXISTS(SELECT 1 FROM action_invocations WHERE fence=?1 AND state IN ('dispatched','outcome_unknown') AND (?2 IS NULL OR invocation_id<>?2))",rusqlite::params![fence,except],|r|r.get(0))
}
#[expect(
    clippy::too_many_arguments,
    reason = "SQLite column insert, all checked by schema"
)]
pub(crate) fn insert(
    conn: &Connection,
    id: &str,
    scope: &str,
    key: &str,
    digest: &str,
    revision: u64,
    state: &str,
    fence: Option<&str>,
    payload: &str,
) -> rusqlite::Result<()> {
    conn.execute("INSERT INTO action_invocations(invocation_id,subject_scope,request_key,request_digest,revision,state,fence,payload) VALUES(?1,?2,?3,?4,?5,json_extract(?6,'$'),?7,?8)",rusqlite::params![id,scope,key,digest,i64::try_from(revision).map_err(|_|rusqlite::Error::InvalidQuery)?,state,fence,payload])?;
    Ok(())
}
pub(crate) fn approval_invocation(conn: &Connection, id: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        "SELECT invocation_id FROM action_approvals WHERE approval_id=?1",
        [id],
        |r| r.get(0),
    )
    .optional()
}
pub(crate) fn insert_attempt(
    conn: &Connection,
    id: &str,
    invocation: &str,
    ordinal: u64,
    payload: &str,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO action_attempts(attempt_id,invocation_id,ordinal,payload) VALUES(?1,?2,?3,?4)",
        rusqlite::params![
            id,
            invocation,
            i64::try_from(ordinal).map_err(|_| rusqlite::Error::InvalidQuery)?,
            payload
        ],
    )?;
    Ok(())
}
pub(crate) fn update_attempt(conn: &Connection, id: &str, payload: &str) -> rusqlite::Result<()> {
    let n = conn.execute(
        "UPDATE action_attempts SET payload=?1 WHERE attempt_id=?2",
        rusqlite::params![payload, id],
    )?;
    if n != 1 {
        return Err(rusqlite::Error::InvalidQuery);
    }
    Ok(())
}
#[cfg(test)]
pub(crate) fn dispatched(conn: &Connection) -> rusqlite::Result<Vec<String>> {
    let mut stmt =
        conn.prepare("SELECT invocation_id FROM action_invocations WHERE state='dispatched'")?;
    let rows = stmt.query_map([], |r| r.get(0))?;
    rows.collect()
}

/// Physical ownership pins original descriptors; names may be renamed while a
/// completed fact still needs settlement. New owners must match durable pins.
pub(crate) struct SubmissionOwner{files:super::physical_lease::LeaseFiles,invocation:String}
impl SubmissionOwner{
    pub(crate) fn matches_retained(&self,invocation:&str,identity:(u64,u64))->bool{self.invocation==invocation&&self.files.matches_original(identity)}
    #[cfg(test)]
    pub(crate) fn matches(&self,data_dir:&std::path::Path,invocation:&str)->Result<bool,String>{
        #[cfg(unix)]{let(_,identity)=submission_database(data_dir)?;Ok(self.matches_retained(invocation,identity))}
        #[cfg(not(unix))]{let _=(data_dir,invocation);Err("submission ownership is unsupported on this platform".into())}
    }
}
#[cfg(all(test, unix))]
fn submission_database(
    data_dir: &std::path::Path,
) -> Result<(std::path::PathBuf, (u64, u64)), String> {
    use std::os::unix::fs::MetadataExt;
    let path = crate::runtime::runtime_db_path(data_dir)
        .canonicalize()
        .map_err(|_| "submission storage is unavailable")?;
    let metadata = path
        .metadata()
        .map_err(|_| "submission storage is unavailable")?;
    if !metadata.is_file() || metadata.nlink() != 1 {
        return Err("submission storage identity is unavailable".into());
    }
    Ok((path, (metadata.dev(), metadata.ino())))
}

/// Fixture-only path discovery and explicit transaction owner. Never nest or
/// commit a caller's transaction, and never promote this path facade to native.
#[cfg(test)]
pub(crate) fn try_submission_owner(conn:&Connection,data_dir:&std::path::Path,invocation:&str)->Result<Option<SubmissionOwner>,String>{
    if !conn.is_autocommit(){return Err("fixture submission owner cannot nest a transaction".into());}
    #[cfg(unix)]{
        use std::os::unix::fs::MetadataExt;
        let(database,identity)=submission_database(data_dir)?;let directory=database.parent().ok_or("submission storage is unavailable")?;let metadata=directory.metadata().map_err(|_|"submission anchor is unavailable")?;
        let tx=rusqlite::Transaction::new_unchecked(conn,rusqlite::TransactionBehavior::Immediate).map_err(|_|"submission pin transaction unavailable")?;
        let result=try_retained_submission_owner(&tx,directory,identity,(metadata.dev(),metadata.ino()),invocation)?;
        tx.commit().map_err(|_|"submission pin commit unavailable")?;Ok(result)
    }
    #[cfg(not(unix))]{let _=(conn,data_dir,invocation);Err("submission ownership is unsupported on this platform".into())}
}
fn identity_text(value:u64)->String{format!("{value:016x}")}
fn pin_namespace(conn:&Connection,identity:&super::physical_lease::LeaseIdentity)->Result<(),String>{
    use crate::connections::metadata::bounded_text;
    let expected=[identity_text(identity.runtime.0),identity_text(identity.runtime.1),identity_text(identity.parent.0),identity_text(identity.parent.1),identity_text(identity.directory.0),identity_text(identity.directory.1)];
    let stored:Option<(i64,[String;6])>=conn.query_row("SELECT protocol,runtime_device,runtime_inode,parent_device,parent_inode,directory_device,directory_inode FROM action_submission_namespace WHERE singleton=1",[],|row|Ok((row.get(0)?,[bounded_text(row,"runtime_device",16)?,bounded_text(row,"runtime_inode",16)?,bounded_text(row,"parent_device",16)?,bounded_text(row,"parent_inode",16)?,bounded_text(row,"directory_device",16)?,bounded_text(row,"directory_inode",16)?]))).optional().map_err(|_|"submission namespace unavailable")?;
    if let Some((protocol,stored))=stored{if protocol!=1||stored!=expected{return Err("submission namespace identity changed".into());}return Ok(());}
    conn.execute("INSERT INTO action_submission_namespace(singleton,protocol,runtime_device,runtime_inode,parent_device,parent_inode,directory_device,directory_inode) VALUES(1,1,?1,?2,?3,?4,?5,?6)",rusqlite::params![expected[0],expected[1],expected[2],expected[3],expected[4],expected[5]]).map_err(|_|"submission namespace pin unavailable")?;Ok(())
}
fn pin_submission_file(conn:&Connection,invocation:&str,file:(u64,u64))->Result<(),String>{
    use crate::connections::metadata::bounded_text;
    let expected=(identity_text(file.0),identity_text(file.1));
    let stored:Option<(i64,String,String)>=conn.query_row("SELECT namespace_id,lock_device,lock_inode FROM action_submission_files WHERE invocation_id=?1",[invocation],|row|Ok((row.get(0)?,bounded_text(row,"lock_device",16)?,bounded_text(row,"lock_inode",16)?))).optional().map_err(|_|"submission file identity unavailable")?;
    if let Some((namespace,device,inode))=stored{if namespace!=1||(device,inode)!=expected{return Err("submission file identity changed".into());}return Ok(());}
    conn.execute("INSERT INTO action_submission_files(invocation_id,namespace_id,lock_device,lock_inode) VALUES(?1,1,?2,?3)",rusqlite::params![invocation,expected.0,expected.1]).map_err(|_|"submission file pin unavailable")?;Ok(())
}
/// Native caller owns an existing transaction and validates original storage.
/// No caller may select another namespace or rebind an existing physical inode.
pub(crate) fn try_retained_submission_owner(conn:&Connection,data_dir:&std::path::Path,identity:(u64,u64),directory_identity:(u64,u64),invocation:&str)->Result<Option<SubmissionOwner>,String>{
    if conn.is_autocommit(){return Err("submission pin requires a caller transaction".into());}
    let exists:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM action_invocations WHERE invocation_id=?1)",[invocation],|row|row.get(0)).map_err(|_|"submission record unavailable")?;
    if !exists{return Err("submission record was not found".into());}
    super::physical_lease::try_acquire(conn,data_dir,identity,directory_identity,super::physical_lease::LeaseDomain::ActionSubmission,invocation,|tx,pinned|{pin_namespace(tx,pinned)?;pin_submission_file(tx,invocation,pinned.file)})
        .map(|files|files.map(|files|SubmissionOwner{files,invocation:invocation.into()}))
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;
    #[test]
    fn durable_action_tables_survive_reopen() {
        let dir = crate::vault::testutil::temp_vault("action-invocations-reopen");
        let conn = crate::runtime::open(&dir).unwrap();
        for table in ["action_invocations", "action_approvals", "action_attempts"] {
            let exists: bool = conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
                    [table],
                    |row| row.get(0),
                )
                .unwrap();
            assert!(exists, "missing durable action table {table}");
        }
        drop(conn);
        let reopened = crate::runtime::open(&dir).unwrap();
        assert_eq!(
            crate::runtime::user_version(&reopened).unwrap(),
            crate::runtime::USER_VERSION
        );
    }
    #[test]
    fn v33_upgrade_preserves_existing_operational_rows() {
        let dir = crate::vault::testutil::temp_vault("action-upgrade-v33");
        let conn = Connection::open(crate::runtime::runtime_db_path(&dir)).unwrap();
        for migration in crate::runtime::MIGRATIONS.iter().filter(|m| m.to <= 33) {
            crate::runtime::step(&conn, migration).unwrap();
        }
        conn.execute("INSERT INTO operational_log(recorded_at,surface,code,detail) VALUES('2026-10-23T00:00:00.000Z','test','malformed_arguments','preserved pre-action data')",[]).unwrap();
        let before: String = conn
            .query_row("SELECT detail FROM operational_log", [], |r| r.get(0))
            .unwrap();
        drop(conn);
        let migrated = crate::runtime::open(&dir).unwrap();
        assert_eq!(
            crate::runtime::user_version(&migrated).unwrap(),
            crate::runtime::USER_VERSION
        );
        assert_eq!(
            migrated
                .query_row("SELECT detail FROM operational_log", [], |r| r
                    .get::<_, String>(0))
                .unwrap(),
            before
        );
        assert_eq!(
            migrated
                .query_row("SELECT count(*) FROM action_invocations", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
    #[test]
    fn v34_validation_failure_rolls_back_the_entire_migration() {
        let _lock = crate::runtime::status::test_lock();
        crate::runtime::status::clear();
        let dir = crate::vault::testutil::temp_vault("action-migration-rollback");
        let conn = Connection::open(crate::runtime::runtime_db_path(&dir)).unwrap();
        for migration in crate::runtime::MIGRATIONS.iter().filter(|m| m.to <= 33) {
            crate::runtime::step(&conn, migration).unwrap();
        }
        let migration = crate::runtime::Migration {
            to: 34,
            sql: crate::runtime::schema::SCHEMA_V34,
            validate: |_| Err("injected validation refusal".into()),
        };
        assert!(crate::runtime::step(&conn, &migration).is_err());
        assert_eq!(crate::runtime::user_version(&conn).unwrap(), 33);
        assert!(!conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='action_invocations')",
                [],
                |r| r.get::<_, bool>(0)
            )
            .unwrap());
        assert_eq!(
            conn.query_row("SELECT count(*) FROM operational_log", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        crate::runtime::status::clear();
    }
}
