//! Disposable SQLite metadata adapter; visible Markdown is the body authority.
use super::comparison::{
    decode_metadata, encoded, safe_path, validate_state, State, WorkspaceStore,
};
use crate::workspace_service::types::prototype::{error, Record, Result};
use rusqlite::{params, Connection, OpenFlags};
use std::path::{Path, PathBuf};
pub(crate) struct Sqlite {
    root: PathBuf,
    metadata: PathBuf,
    connection: Connection,
}
fn db(e: rusqlite::Error) -> crate::workspace_service::types::prototype::PrototypeError {
    error("metadata_unavailable", e.to_string())
}
impl Sqlite {
    pub(crate) fn create(root: PathBuf, metadata: PathBuf) -> Result<Self> {
        let path = safe_path(&metadata, "workspace.db")?;
        if path.exists() {
            return Err(error(
                "destination_exists",
                "SQLite metadata already exists.",
            ));
        }
        let connection = Connection::open(path).map_err(db)?;
        connection.execute_batch("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE workspace (singleton INTEGER PRIMARY KEY CHECK(singleton=1), payload BLOB NOT NULL); CREATE TABLE records (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, revision INTEGER NOT NULL, payload BLOB NOT NULL);").map_err(db)?;
        Ok(Self {
            root,
            metadata,
            connection,
        })
    }
    pub(crate) fn open(root: PathBuf, metadata: PathBuf) -> Result<Self> {
        let path = safe_path(&metadata, "workspace.db")?;
        let connection =
            Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE).map_err(db)?;
        connection
            .execute_batch("PRAGMA synchronous=FULL;")
            .map_err(db)?;
        Ok(Self {
            root,
            metadata,
            connection,
        })
    }
}
impl WorkspaceStore for Sqlite {
    fn root(&self) -> &Path {
        &self.root
    }
    fn metadata_root(&self) -> &Path {
        &self.metadata
    }
    fn load_state(&self) -> Result<State> {
        let header: Vec<u8> = self
            .connection
            .query_row(
                "SELECT substr(payload,1,33554433) FROM workspace WHERE singleton=1",
                [],
                |r| r.get(0),
            )
            .map_err(db)?;
        if header.len() > 32 * 1024 * 1024 {
            return Err(error("source_limit", "SQLite header exceeds limit."));
        }
        let mut state: State = decode_metadata(&header)?;
        if !state.records.is_empty() {
            return Err(error("invalid_metadata", "SQLite header contains records."));
        }
        let mut statement = self
            .connection
            .prepare("SELECT substr(id,1,37), substr(path,1,4097), revision, substr(payload,1,262145) FROM records ORDER BY id LIMIT 6001")
            .map_err(db)?;
        let rows = statement
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, Vec<u8>>(3)?,
                ))
            })
            .map_err(db)?;
        for row in rows {
            let (id, path, revision, bytes) = row.map_err(db)?;
            // Bound the text projected into Rust before validating row identity.
            // SQLite substr counts Unicode characters; this byte check can refuse
            // earlier, while even malformed multibyte text has a bounded projection.
            if id.len() > 36 || path.len() > 4096 {
                return Err(error(
                    "source_limit",
                    "SQLite identity column exceeds limit.",
                ));
            }
            if bytes.len() > 256 * 1024 {
                return Err(error("source_limit", "SQLite record exceeds limit."));
            }
            let record: Record = decode_metadata(&bytes)?;
            if record.id != id
                || record.path != path
                || i64::try_from(record.version.metadata_revision).ok() != Some(revision)
            {
                return Err(error(
                    "invalid_metadata",
                    "SQLite row disagrees with payload.",
                ));
            }
            state.records.insert(id, record);
        }
        validate_state(&state)?;
        Ok(state)
    }
    fn commit_state(&mut self, state: &State) -> Result<()> {
        validate_state(state)?;
        let transaction = self.connection.transaction().map_err(db)?;
        transaction.execute("DELETE FROM records", []).map_err(db)?;
        for record in state.records.values() {
            transaction
                .execute(
                    "INSERT INTO records(id,path,revision,payload) VALUES (?1,?2,?3,?4)",
                    params![
                        record.id,
                        record.path,
                        i64::try_from(record.version.metadata_revision).map_err(|_| error(
                            "revision_limit",
                            "SQLite revision exceeds signed 64-bit range."
                        ))?,
                        encoded(record)?
                    ],
                )
                .map_err(db)?;
        }
        let mut header = state.clone();
        header.records.clear();
        transaction.execute("INSERT INTO workspace(singleton,payload) VALUES (1,?1) ON CONFLICT(singleton) DO UPDATE SET payload=excluded.payload", params![encoded(&header)?]).map_err(db)?;
        transaction.commit().map_err(db)
    }
}
