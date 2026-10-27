//! Separate selected workspace metadata. Never opens the app-global runtime DB.
use super::stage::{error, read_bounded, rules, sync_dir, RecordData, RecordInfo, StageResult};
use crate::workspace_service::{types::values::PropertyValue, value};
use rusqlite::{Connection, OpenFlags};
#[cfg(unix)]
use rusqlite::params;
use std::{collections::BTreeSet, fs, path::Path};
fn db(e: rusqlite::Error) -> super::stage::StageError {
    error("metadata_unavailable", e.to_string())
}
fn flags() -> OpenFlags {
    OpenFlags::SQLITE_OPEN_NO_MUTEX | OpenFlags::SQLITE_OPEN_NOFOLLOW
}
#[cfg(unix)]
pub(super) fn create(root: &Path, workspace_id: &str, records: &[RecordData]) -> StageResult<()> {
    let path = root.join(&rules().database);
    // Reserve the private file atomically before SQLite can create a header or
    // journal. No chmod of an existing caller-owned path and no CREATE fallback.
    let mut options = fs::OpenOptions::new();
    options.read(true).write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let file = options.open(&path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::AlreadyExists {
            error("destination_exists", "Selected metadata already exists.")
        } else {
            error("metadata_unavailable", e.to_string())
        }
    })?;
    file.sync_all()
        .map_err(|e| error("metadata_unavailable", e.to_string()))?;
    sync_dir(root)?;
    let mut connection =
        Connection::open_with_flags(&path, flags() | OpenFlags::SQLITE_OPEN_READ_WRITE)
            .map_err(db)?;
    connection.execute_batch("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF;").map_err(db)?;
    // Only this explicit create-new staging producer installs a schema. Reads
    // never upgrade an old staged store or an original selected workspace.
    connection.execute_batch(include_str!("../workspace_service/selected_schema_v4.sql")).map_err(db)?;
    let transaction = connection.transaction().map_err(db)?;
    transaction
        .execute("INSERT INTO workspace VALUES (1,2,?1,1,1)", [workspace_id])
        .map_err(db)?;
    for record in records {
        transaction
            .execute(
                "INSERT INTO records VALUES (?1,?2,1,?3,?4)",
                params![
                    record.info.id,
                    record.info.path,
                    record.info.body_hash,
                    record.metadata
                ],
            )
            .map_err(db)?;
    }
    transaction.commit().map_err(db)?;
    connection.close().map_err(|(_, e)| db(e))?;
    fs::File::open(&path)
        .and_then(|f| f.sync_all())
        .map_err(|e| error("io_unavailable", e.to_string()))?;
    sync_dir(root)
}
#[cfg(not(unix))]
pub(super) fn create(_root:&Path,_workspace_id:&str,_records:&[RecordData])->StageResult<()> {
    Err(error("unsupported_format","Fresh selected staging requires the supported native SQLite validation adapter."))
}
#[cfg(unix)]
fn read_fresh(root:&Path,workspace_id:&str,before:&[u8])->StageResult<Vec<RecordData>> {
    use crate::workspace_service::types::selected::AuthorityErrorKind;
    let facts=crate::workspace_service::selected::backup::read_fresh_stage_offline(before,workspace_id,rules().limits.database_bytes)
        .map_err(|e|error(match e.kind{AuthorityErrorKind::SourceLimit=>"source_limit",AuthorityErrorKind::WrongIdentity=>"wrong_binding",_=>"invalid_metadata"},e.message))?;
    let policy:serde_json::Value=serde_json::from_str(include_str!("../../../shared/workspace/metadata-patch.v1.json")).map_err(|_|error("invalid_metadata","Selected staging schema policy is unavailable."))?;
    let expected=policy["selectedSchemaVersion"].as_i64().ok_or_else(||error("invalid_metadata","Selected staging schema policy is invalid."))?;
    if facts.schema_version!=expected || facts.schema_revision!=1 || facts.epoch!=1 {
        return Err(error("unsupported_format","This is not an initial supported inactive selected stage."));
    }
    if facts.records.len()>rules().limits.files {return Err(error("source_limit","Staged database record count exceeds its bound."));}
    let mut result=Vec::new();let mut total=0usize;
    for record in facts.records {
        total=total.checked_add(record.metadata.len()).filter(|n|*n<=rules().limits.metadata_bytes).ok_or_else(||error("source_limit","Staged metadata exceeds its aggregate bound."))?;
        if record.revision!=1 {return Err(error("invalid_metadata","Inactive stage record revision is unsupported."));}
        let decoded=value::decode_tagged(&record.metadata).map_err(|e|error("invalid_metadata",e.message))?;
        if !matches!(decoded,PropertyValue::Object{..}) || serde_json::to_string(&decoded).map_err(|_|error("invalid_metadata","Invalid staged tagged metadata."))?!=record.metadata {
            return Err(error("invalid_metadata","Staged metadata must retain its exact canonical tagged encoding."));
        }
        result.push(RecordData{info:RecordInfo{id:record.id,path:record.path,revision:1,body_start:0,body_hash:record.body_hash,metadata_hash:crate::ledger::sha256_hex(record.metadata.as_bytes()),required_parts:Vec::new()},metadata:record.metadata});
    }
    if before!=read_bounded(root,&rules().database,rules().limits.database_bytes)? {
        return Err(error("stage_part_changed","SQLite bytes changed while validating the inactive stage."));
    }
    Ok(result)
}
pub(super) fn read(root: &Path, workspace_id: &str) -> StageResult<Vec<RecordData>> {
    // Hash/bound before SQLite, then check the same bytes after the read. This
    // guards ordinary drift, not a malicious same-user transient replacement.
    let before = read_bounded(root, &rules().database, rules().limits.database_bytes)?;
    // Historical staged format1 has SQLite user_version zero. New versioned
    // stages are validated from this exact bounded byte slice without opening
    // a second SQLite descriptor by pathname. Unknown versions never fall back.
    let version=before.get(60..64).and_then(|bytes|<[u8;4]>::try_from(bytes).ok()).map(u32::from_be_bytes);
    if version.is_some_and(|version|version!=0) {
        #[cfg(unix)] {return read_fresh(root,workspace_id,&before);}
        #[cfg(not(unix))] {return Err(error("unsupported_format","Versioned selected stages are unavailable on this platform."));}
    }
    let connection = Connection::open_with_flags(
        root.join(&rules().database),
        flags() | OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(db)?;
    connection
        .execute_batch("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;")
        .map_err(db)?;
    let integrity: String = connection
        .query_row("PRAGMA quick_check(1)", [], |r| r.get(0))
        .map_err(db)?;
    if integrity != "ok" {
        return Err(error("invalid_metadata", "SQLite integrity check failed."));
    }
    let (format, actual): (i64, String) = connection
        .query_row(
            "SELECT format,substr(workspace_id,1,37) FROM workspace WHERE singleton=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(db)?;
    let count: i64 = connection
        .query_row("SELECT count(*) FROM workspace", [], |r| r.get(0))
        .map_err(db)?;
    if count != 1 || format != 1 || actual != workspace_id {
        return Err(error(
            "wrong_binding",
            "SQLite workspace identity/format differs.",
        ));
    }
    let mut statement = connection.prepare("SELECT substr(id,1,37),substr(path,1,4097),revision,substr(body_hash,1,65),substr(metadata,1,65537) FROM records ORDER BY id LIMIT ?1").map_err(db)?;
    let mut rows = statement
        .query([rules().limits.files as i64 + 1])
        .map_err(db)?;
    let mut result = Vec::new();
    let mut ids = BTreeSet::new();
    let mut paths = BTreeSet::new();
    let mut total = 0;
    while let Some(row) = rows.next().map_err(db)? {
        let id: String = row.get(0).map_err(db)?;
        let path: String = row.get(1).map_err(db)?;
        let revision: i64 = row.get(2).map_err(db)?;
        let body_hash: String = row.get(3).map_err(db)?;
        let metadata: String = row.get(4).map_err(db)?;
        total += metadata.len();
        if result.len() >= rules().limits.files
            || id.len() != 36
            || path.len() > 4096
            || revision != 1
            || body_hash.len() != 64
            || metadata.len() > 65536
            || total > rules().limits.metadata_bytes
            || !ids.insert(id.clone())
            || !paths.insert(path.clone())
        {
            return Err(error(
                "invalid_metadata",
                "SQLite row projections exceed bounds or duplicate identity.",
            ));
        }
        let decoded =
            value::decode_tagged(&metadata).map_err(|e| error("invalid_metadata", e.message))?;
        if !matches!(decoded, PropertyValue::Object { .. })
            || serde_json::to_string(&decoded)
                .map_err(|_| error("invalid_metadata", "Invalid metadata encoding."))?
                != metadata
        {
            return Err(error(
                "invalid_metadata",
                "SQLite metadata is not canonical tagged object encoding.",
            ));
        }
        result.push(RecordData {
            info: RecordInfo {
                id,
                path,
                revision: 1,
                body_start: 0,
                body_hash,
                metadata_hash: crate::ledger::sha256_hex(metadata.as_bytes()),
                required_parts: Vec::new(),
            },
            metadata,
        });
    }
    drop(rows);
    drop(statement);
    connection.close().map_err(|(_, e)| db(e))?;
    if before != read_bounded(root, &rules().database, rules().limits.database_bytes)? {
        return Err(error(
            "stage_part_changed",
            "SQLite bytes changed while reading.",
        ));
    }
    Ok(result)
}
