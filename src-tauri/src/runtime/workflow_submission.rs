//! Workflow execution ownership, distinct from an ACT submission lease.
//! The native caller retains this only after its classified known commit.
use rusqlite::{Connection, OptionalExtension};
pub(crate) struct ExecutionOwner {
    files: super::physical_lease::LeaseFiles,
    run: String,
}
impl ExecutionOwner {
    pub(crate) fn matches_retained(&self, run: &str, runtime: (u64, u64)) -> bool {
        self.run == run && self.files.matches_original(runtime)
    }
}
fn identity_text(value: u64) -> String {
    format!("{value:016x}")
}
fn pin_namespace(
    conn: &Connection,
    identity: &super::physical_lease::LeaseIdentity,
) -> Result<(), String> {
    use crate::connections::metadata::bounded_text;
    let expected = [
        identity_text(identity.runtime.0),
        identity_text(identity.runtime.1),
        identity_text(identity.parent.0),
        identity_text(identity.parent.1),
        identity_text(identity.directory.0),
        identity_text(identity.directory.1),
    ];
    let stored:Option<(i64,[String;6])>=conn.query_row("SELECT protocol,runtime_device,runtime_inode,parent_device,parent_inode,directory_device,directory_inode FROM workflow_submission_namespace WHERE singleton=1",[],|row|Ok((row.get(0)?,[bounded_text(row,"runtime_device",16)?,bounded_text(row,"runtime_inode",16)?,bounded_text(row,"parent_device",16)?,bounded_text(row,"parent_inode",16)?,bounded_text(row,"directory_device",16)?,bounded_text(row,"directory_inode",16)?]))).optional().map_err(|_|"submission namespace unavailable")?;
    if let Some((protocol, stored)) = stored {
        if protocol != 1 || stored != expected {
            return Err("submission namespace identity changed".into());
        }
        return Ok(());
    }
    conn.execute("INSERT INTO workflow_submission_namespace(singleton,protocol,runtime_device,runtime_inode,parent_device,parent_inode,directory_device,directory_inode) VALUES(1,1,?1,?2,?3,?4,?5,?6)",rusqlite::params![expected[0],expected[1],expected[2],expected[3],expected[4],expected[5]]).map_err(|_|"submission namespace pin unavailable")?;
    Ok(())
}
fn pin_execution_file(conn: &Connection, run: &str, file: (u64, u64)) -> Result<(), String> {
    use crate::connections::metadata::bounded_text;
    let expected = (identity_text(file.0), identity_text(file.1));
    let stored:Option<(i64,String,String)>=conn.query_row("SELECT namespace_id,lock_device,lock_inode FROM workflow_submission_files WHERE workflow_run_id=?1",[run],|row|Ok((row.get(0)?,bounded_text(row,"lock_device",16)?,bounded_text(row,"lock_inode",16)?))).optional().map_err(|_|"submission file identity unavailable")?;
    if let Some((namespace, device, inode)) = stored {
        if namespace != 1 || (device, inode) != expected {
            return Err("submission file identity changed".into());
        }
        return Ok(());
    }
    conn.execute("INSERT INTO workflow_submission_files(workflow_run_id,namespace_id,lock_device,lock_inode) VALUES(?1,1,?2,?3)",rusqlite::params![run,expected.0,expected.1]).map_err(|_|"submission file pin unavailable")?;
    Ok(())
}
/// Native caller owns an existing transaction and validates original storage.
/// No caller may select another namespace or rebind an existing physical inode.

pub(crate) fn try_execution_owner(
    conn: &Connection,
    data_dir: &std::path::Path,
    identity: (u64, u64),
    parent: (u64, u64),
    run: &str,
) -> Result<Option<ExecutionOwner>, String> {
    if conn.is_autocommit() {
        return Err("workflow owner pin requires a caller transaction".into());
    }
    let exists:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM workflow_run_origins o JOIN workflow_runs w ON w.run_id=o.workflow_run_id WHERE o.workflow_run_id=?1 AND w.act_run_id=o.native_run_id)",[run],|row|row.get(0)).map_err(|_|"workflow origin is unavailable")?;
    if !exists {
        return Err("workflow origin was not found".into());
    }
    super::physical_lease::try_acquire(
        conn,
        data_dir,
        identity,
        parent,
        super::physical_lease::LeaseDomain::WorkflowExecution,
        run,
        |tx, pinned| {
            pin_namespace(tx, pinned)?;
            pin_execution_file(tx, run, pinned.file)
        },
    )
    .map(|files| {
        files.map(|files| ExecutionOwner {
            files,
            run: run.into(),
        })
    })
}
