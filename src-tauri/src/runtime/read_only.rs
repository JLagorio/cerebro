//! A runtime database handle SQLite refuses writes on (M56.9).
//!
//! The fleet read model used to be SELECT-only by convention, on the same
//! writable connection everything else opens. `ReadOnly` makes the convention
//! a property of the handle: it opens the file with `SQLITE_OPEN_READ_ONLY`,
//! which no statement can undo, and sets `PRAGMA query_only = ON`, which names
//! the intent (and which a statement could switch off, so it is never the
//! guard on its own). The connection is a private field with no `Deref`, so a
//! caller holding one can `prepare` and `query_row` and nothing else.
//!
//! It never creates or migrates anything: a missing database is an error, and
//! so is any `user_version` but the one this build speaks. A reader that met
//! an older schema would read columns that are not there yet; one that met a
//! newer schema would read columns that mean something else.

use std::path::Path;
use std::time::Duration;

use rusqlite::{Connection, OpenFlags, Params, Row, Statement};

use super::{runtime_db_path, user_version, USER_VERSION};

/// A read-only runtime database. See the module note.
pub struct ReadOnly(Connection);

impl ReadOnly {
    /// Open the runtime database in `data_dir` read-only.
    pub fn open(data_dir: &Path) -> Result<Self, String> {
        let path = runtime_db_path(data_dir);
        if !path.exists() {
            return Err(format!("{}: no runtime database", path.display()));
        }
        let conn = Connection::open_with_flags(
            &path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|e| format!("{}: {e}", path.display()))?;
        // A writer mid-transaction holds the file briefly; waiting is the
        // right answer for a read, as it is for every other connection.
        conn.busy_timeout(Duration::from_secs(5))
            .map_err(|e| e.to_string())?;
        conn.pragma_update(None, "query_only", true)
            .map_err(|e| e.to_string())?;
        let version = user_version(&conn)?;
        if version != USER_VERSION {
            return Err(format!(
                "{}: runtime db is at user_version {version}, this build speaks {USER_VERSION}",
                path.display()
            ));
        }
        Ok(ReadOnly(conn))
    }

    /// Prepare one statement. Running a write through it fails: the file was
    /// opened read-only.
    pub fn prepare(&self, sql: &str) -> rusqlite::Result<Statement<'_>> {
        self.0.prepare(sql)
    }

    /// Run a query that returns one row.
    pub fn query_row<T, P, F>(&self, sql: &str, params: P, f: F) -> rusqlite::Result<T>
    where
        P: Params,
        F: FnOnce(&Row<'_>) -> rusqlite::Result<T>,
    {
        self.0.query_row(sql, params, f)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::testutil;

    fn seeded(label: &str) -> (std::path::PathBuf, Connection) {
        let dir = testutil::temp_vault(label);
        let writer = crate::runtime::open(&dir).unwrap();
        writer
            .execute(
                "INSERT INTO operational_log (recorded_at, surface, code, detail) \
                 VALUES ('2026-10-14T00:00:00.000Z', 'test', 'malformed_arguments', 'x')",
                [],
            )
            .unwrap();
        (dir, writer)
    }

    fn rows(ro: &ReadOnly) -> i64 {
        ro.query_row("SELECT count(*) FROM operational_log", [], |r| r.get(0))
            .unwrap()
    }

    #[test]
    fn a_read_only_connection_refuses_every_write() {
        let (dir, writer) = seeded("read-only-refuses");
        let ro = ReadOnly::open(&dir).unwrap();
        for sql in [
            "INSERT INTO operational_log (recorded_at, surface, code, detail) \
             VALUES ('2026-10-14T00:00:00.000Z', 'test', 'malformed_arguments', 'y')",
            "UPDATE operational_log SET detail = 'z'",
            "DELETE FROM operational_log",
            "CREATE TABLE smuggled (x INTEGER)",
        ] {
            let mut statement = match ro.prepare(sql) {
                Ok(statement) => statement,
                // Refused at prepare is refused too.
                Err(_) => continue,
            };
            assert!(statement.execute([]).is_err(), "{sql} must be refused");
        }
        assert_eq!(rows(&ro), 1, "nothing changed");
        drop(ro);
        drop(writer);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn switching_query_only_off_still_writes_nothing() {
        let (dir, writer) = seeded("read-only-pragma-off");
        let ro = ReadOnly::open(&dir).unwrap();
        // The pragma is the intent; the open flag is the guard. A statement
        // that turns the pragma off has not turned the guard off.
        ro.0.execute_batch("PRAGMA query_only = OFF").unwrap();
        let off: i64 = ro.query_row("PRAGMA query_only", [], |r| r.get(0)).unwrap();
        assert_eq!(off, 0, "the pragma really is off");
        let wrote = ro.0.execute(
            "INSERT INTO operational_log (recorded_at, surface, code, detail) \
             VALUES ('2026-10-14T00:00:00.000Z', 'test', 'malformed_arguments', 'y')",
            [],
        );
        assert!(wrote.is_err(), "the read-only open still refuses the write");
        assert!(ro.0.execute_batch("CREATE TABLE smuggled (x)").is_err());
        assert_eq!(rows(&ro), 1);
        drop(ro);
        drop(writer);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn it_refuses_a_missing_database_and_another_version() {
        let dir = testutil::temp_vault("read-only-missing");
        std::fs::create_dir_all(&dir).unwrap();
        let missing = ReadOnly::open(&dir).err().unwrap();
        assert!(missing.contains("no runtime database"), "{missing}");
        assert!(
            !runtime_db_path(&dir).exists(),
            "a read-only open never creates the file"
        );

        let writer = crate::runtime::open(&dir).unwrap();
        writer
            .pragma_update(None, "user_version", USER_VERSION - 1)
            .unwrap();
        let older = ReadOnly::open(&dir).err().unwrap();
        assert!(older.contains("this build speaks"), "{older}");
        writer
            .pragma_update(None, "user_version", USER_VERSION + 1)
            .unwrap();
        assert!(ReadOnly::open(&dir).is_err(), "a newer schema too");
        drop(writer);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn it_reads_what_a_writer_committed_while_the_writer_is_open() {
        let (dir, writer) = seeded("read-only-sees-commits");
        let ro = ReadOnly::open(&dir).unwrap();
        assert_eq!(rows(&ro), 1);
        writer
            .execute(
                "INSERT INTO operational_log (recorded_at, surface, code, detail) \
                 VALUES ('2026-10-14T00:00:01.000Z', 'test', 'malformed_arguments', 'y')",
                [],
            )
            .unwrap();
        assert_eq!(rows(&ro), 2, "a commit is visible to the next read");
        drop(ro);
        drop(writer);

        // And with the writer gone, the WAL checkpointed away.
        let ro = ReadOnly::open(&dir).unwrap();
        assert_eq!(rows(&ro), 2);
        drop(ro);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
