//! The disposable materialized index (M21.5): SQLite in app-data, keyed by
//! store id. A CACHE, constitutionally: nothing may exist in it that
//! segments cannot reproduce, it is never synced, never authoritative, and
//! on any sign of damage it is deleted and rebuilt — never trusted. It
//! lives in app-data precisely so SQLite never sits inside a possibly
//! cloud-synced vault (WAL + sync = corruption, D2).
//!
//! Tables: `events` — the replayed frames, whose max seq IS the replay
//! cursor; `meta` — the latest-seen head (the `Remembered` that feeds
//! divergence detection; app-data can be rewound too, so corroboration,
//! never proof) plus this installation's writer id for diagnostics.

use std::path::{Path, PathBuf};

use rusqlite::Connection;

use super::recovery::Remembered;
use super::LedgerRead;

/// Sub-directory of the app config dir holding one index per store.
const INDEX_DIR: &str = "ledger-index";

pub fn index_path(config_dir: &Path, store_id: &str) -> PathBuf {
    config_dir
        .join(INDEX_DIR)
        .join(format!("{store_id}.sqlite"))
}

#[derive(Debug)]
pub struct Index {
    conn: Connection,
    path: PathBuf,
}

fn open_connection(path: &Path) -> Result<Connection, String> {
    let conn = Connection::open(path).map_err(|e| e.to_string())?;
    // WAL per D2; both rebuilds of a byte-identical pair set it the same
    // way, and the last connection's close checkpoints and removes the
    // sidecar files.
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| e.to_string())?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS events (
            seq INTEGER PRIMARY KEY,
            event_id TEXT NOT NULL,
            hash TEXT NOT NULL,
            prev TEXT NOT NULL,
            ingested_at TEXT NOT NULL,
            wall_clock_anomaly INTEGER NOT NULL,
            kind TEXT NOT NULL,
            body TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );",
    )
    .map_err(|e| e.to_string())?;
    Ok(conn)
}

/// Is this database healthy enough to trust as a cache? Any failure —
/// unreadable header, malformed image, failed pragma — means no.
fn healthy(path: &Path) -> bool {
    let Ok(conn) = Connection::open(path) else {
        return false;
    };
    let check: Result<String, _> = conn.query_row("PRAGMA quick_check", [], |row| row.get(0));
    matches!(check.as_deref(), Ok("ok"))
}

impl Index {
    /// Open the store's index, creating it fresh when absent — and deleting
    /// it first when damaged. A cache that cannot prove itself healthy is
    /// deleted and rebuilt from segments, never trusted.
    pub fn open(config_dir: &Path, store_id: &str) -> Result<Index, String> {
        let path = index_path(config_dir, store_id);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        if path.exists() && !healthy(&path) {
            remove_index_files(&path)?;
        }
        let conn = open_connection(&path)?;
        Ok(Index { conn, path })
    }

    /// Replay committed frames into the index, incrementally by seq, and
    /// remember the ledger's head. Refuses a ledger BEHIND the index or one
    /// whose history disagrees at the cursor — the cache must never smooth
    /// over a divergence the verdict layer exists to name.
    pub fn replay(&mut self, read: &LedgerRead, writer_id: &str) -> Result<(), String> {
        let cursor = self.max_seq()?;
        if let Some(cursor) = cursor {
            if read.head_seq.is_none() || read.head_seq < Some(cursor) {
                return Err(format!(
                    "ledger head {:?} is behind the index cursor {cursor} — diverged, not replayable",
                    read.head_seq
                ));
            }
            let cursor_hash: String = self
                .conn
                .query_row(
                    "SELECT hash FROM events WHERE seq = ?1",
                    [to_sql_seq(cursor)?],
                    |row| row.get(0),
                )
                .map_err(|e| e.to_string())?;
            let ledger_hash = read
                .frames
                .iter()
                .find(|f| f.seq == cursor)
                .map(|f| f.hash.as_str());
            if ledger_hash != Some(cursor_hash.as_str()) {
                return Err(format!(
                    "ledger history disagrees with the index at seq {cursor} — diverged, not replayable"
                ));
            }
        }

        let tx = self.conn.transaction().map_err(|e| e.to_string())?;
        {
            let mut insert = tx
                .prepare(
                    "INSERT INTO events
                     (seq, event_id, hash, prev, ingested_at, wall_clock_anomaly, kind, body)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                )
                .map_err(|e| e.to_string())?;
            for frame in read
                .frames
                .iter()
                .filter(|f| cursor.is_none_or(|c| f.seq > c))
            {
                insert
                    .execute(rusqlite::params![
                        to_sql_seq(frame.seq)?,
                        frame.event_id,
                        frame.hash,
                        frame.prev,
                        frame.ingested_at,
                        frame.wall_clock_anomaly,
                        frame.kind,
                        serde_json::to_string(&frame.body).map_err(|e| e.to_string())?,
                    ])
                    .map_err(|e| e.to_string())?;
            }
            let mut put_meta = tx
                .prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?1, ?2)")
                .map_err(|e| e.to_string())?;
            let head_seq = read.head_seq.map_or_else(String::new, |s| s.to_string());
            for (key, value) in [
                ("store_id", read.store.store_id.as_str()),
                ("writer_id", writer_id),
                ("head_seq", head_seq.as_str()),
                ("head_hash", read.head_hash.as_str()),
            ] {
                put_meta.execute([key, value]).map_err(|e| e.to_string())?;
            }
        }
        tx.commit().map_err(|e| e.to_string())
    }

    /// Drop the file and replay everything from segments — the
    /// rebuild-from-zero path. Two rebuilds of the same ledger produce a
    /// byte-identical file (same pinned SQLite, same operation sequence).
    pub fn rebuild(self, read: &LedgerRead, writer_id: &str) -> Result<Index, String> {
        let path = self.path.clone();
        drop(self); // close cleanly: checkpoint WAL, remove sidecars
        remove_index_files(&path)?;
        let conn = open_connection(&path)?;
        let mut index = Index { conn, path };
        index.replay(read, writer_id)?;
        Ok(index)
    }

    /// Update only the remembered head — the cheap per-append path (shadow
    /// mode calls it after every commit). The events table catches up on
    /// the next activate replay; a briefly stale events table is fine in a
    /// cache whose meta is the anchor that matters.
    pub fn remember(&mut self, remembered: &Remembered, writer_id: &str) -> Result<(), String> {
        let head_seq = remembered
            .head_seq
            .map_or_else(String::new, |s| s.to_string());
        let tx = self.conn.transaction().map_err(|e| e.to_string())?;
        for (key, value) in [
            ("store_id", remembered.store_id.as_str()),
            ("writer_id", writer_id),
            ("head_seq", head_seq.as_str()),
            ("head_hash", remembered.head_hash.as_str()),
        ] {
            tx.execute(
                "INSERT OR REPLACE INTO meta (key, value) VALUES (?1, ?2)",
                [key, value],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())
    }

    /// The head this machine last saw, for divergence classification.
    pub fn remembered(&self) -> Result<Option<Remembered>, String> {
        let get = |key: &str| -> Result<Option<String>, String> {
            match self
                .conn
                .query_row("SELECT value FROM meta WHERE key = ?1", [key], |row| {
                    row.get::<_, String>(0)
                }) {
                Ok(value) => Ok(Some(value)),
                Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
                Err(e) => Err(e.to_string()),
            }
        };
        let (Some(store_id), Some(head_hash)) = (get("store_id")?, get("head_hash")?) else {
            return Ok(None);
        };
        let head_seq = match get("head_seq")?.as_deref() {
            None | Some("") => None,
            Some(raw) => Some(raw.parse::<u64>().map_err(|e| e.to_string())?),
        };
        Ok(Some(Remembered {
            store_id,
            head_seq,
            head_hash,
        }))
    }

    /// The replay cursor: seq of the newest indexed event.
    pub fn max_seq(&self) -> Result<Option<u64>, String> {
        let max: Option<i64> = self
            .conn
            .query_row("SELECT MAX(seq) FROM events", [], |row| row.get(0))
            .map_err(|e| e.to_string())?;
        max.map(from_sql_seq).transpose()
    }

    pub fn event_count(&self) -> Result<u64, String> {
        let count: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM events", [], |row| row.get(0))
            .map_err(|e| e.to_string())?;
        from_sql_seq(count)
    }

    /// Every row, for content-equality assertions (incremental vs rebuilt
    /// indexes differ in file bytes — transaction counters — but must never
    /// differ in content).
    pub fn dump_events(&self) -> Result<Vec<(u64, String, String, String)>, String> {
        let mut stmt = self
            .conn
            .prepare("SELECT seq, event_id, hash, body FROM events ORDER BY seq")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, i64>(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })
            .map_err(|e| e.to_string())?;
        let rows = rows
            .collect::<Result<Vec<(i64, String, String, String)>, _>>()
            .map_err(|e| e.to_string())?;
        rows.into_iter()
            .map(|(seq, event_id, hash, body)| Ok((from_sql_seq(seq)?, event_id, hash, body)))
            .collect()
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

/// SQLite integers are i64; ledger seqs are u64. The conversions are total
/// for any ledger a single writer can produce, and loud if they ever stop
/// being so.
fn to_sql_seq(seq: u64) -> Result<i64, String> {
    i64::try_from(seq).map_err(|_| format!("seq {seq} exceeds the index's integer range"))
}

fn from_sql_seq(seq: i64) -> Result<u64, String> {
    u64::try_from(seq).map_err(|_| format!("negative seq {seq} in the index"))
}

/// Delete the database and its WAL sidecars — the whole cache, atomically
/// enough for a file that is never authoritative.
fn remove_index_files(path: &Path) -> Result<(), String> {
    for suffix in ["", "-wal", "-shm"] {
        let mut name = path.as_os_str().to_os_string();
        name.push(suffix);
        match std::fs::remove_file(PathBuf::from(&name)) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::writer::LedgerWriter;
    use super::super::{ledger_dir, read_ledger};
    use super::*;
    use crate::vault::testutil;

    const WRITER: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab";

    fn seeded(label: &str, events: u64) -> (PathBuf, PathBuf) {
        let vault = testutil::temp_vault(label);
        let config = testutil::temp_vault(&format!("{label}-config"));
        let mut writer = LedgerWriter::open(&vault, WRITER).unwrap();
        for i in 0..events {
            writer
                .append(
                    "vault.write",
                    serde_json::json!({ "path": format!("n{i}.md") }),
                )
                .unwrap();
        }
        (vault, config)
    }

    #[test]
    fn replay_is_incremental_and_remembers_the_head() {
        let (vault, config) = seeded("idx-replay", 3);
        let read = read_ledger(&ledger_dir(&vault)).unwrap();
        let mut index = Index::open(&config, &read.store.store_id).unwrap();
        index.replay(&read, WRITER).unwrap();
        assert_eq!(index.event_count().unwrap(), 3);
        assert_eq!(index.max_seq().unwrap(), Some(3));

        // Two more events; replay again — only the delta is new.
        let mut writer = LedgerWriter::open(&vault, WRITER).unwrap();
        writer
            .append("vault.write", serde_json::json!({"path": "x.md"}))
            .unwrap();
        writer
            .append("vault.delete", serde_json::json!({"path": "x.md"}))
            .unwrap();
        drop(writer);
        let read = read_ledger(&ledger_dir(&vault)).unwrap();
        index.replay(&read, WRITER).unwrap();
        assert_eq!(index.event_count().unwrap(), 5);

        let remembered = index.remembered().unwrap().expect("head remembered");
        assert_eq!(remembered.store_id, read.store.store_id);
        assert_eq!(remembered.head_seq, Some(5));
        assert_eq!(remembered.head_hash, read.head_hash);
        // The remembered head satisfies the M21.4 classifier.
        assert_eq!(
            super::super::recovery::classify(&ledger_dir(&vault), Some(WRITER), Some(&remembered))
                .verdict,
            super::super::recovery::Verdict::Valid
        );
        let _ = std::fs::remove_dir_all(&vault);
        let _ = std::fs::remove_dir_all(&config);
    }

    #[test]
    fn rebuild_from_zero_is_byte_identical() {
        let (vault, config) = seeded("idx-deterministic", 4);
        let read = read_ledger(&ledger_dir(&vault)).unwrap();
        let index = Index::open(&config, &read.store.store_id).unwrap();
        let index = index.rebuild(&read, WRITER).unwrap();
        let path = index.path().to_path_buf();
        drop(index);
        let first = std::fs::read(&path).unwrap();

        let index = Index::open(&config, &read.store.store_id).unwrap();
        let index = index.rebuild(&read, WRITER).unwrap();
        drop(index);
        let second = std::fs::read(&path).unwrap();
        assert_eq!(first, second, "rebuild-from-zero must be deterministic");
        let _ = std::fs::remove_dir_all(&vault);
        let _ = std::fs::remove_dir_all(&config);
    }

    #[test]
    fn a_corrupt_index_is_deleted_and_rebuilt_never_trusted() {
        let (vault, config) = seeded("idx-corrupt", 4);
        let read = read_ledger(&ledger_dir(&vault)).unwrap();
        let mut index = Index::open(&config, &read.store.store_id).unwrap();
        index.replay(&read, WRITER).unwrap();
        let path = index.path().to_path_buf();
        drop(index);

        // Truncate the database mid-file.
        let bytes = std::fs::read(&path).unwrap();
        std::fs::write(&path, &bytes[..bytes.len() / 2]).unwrap();

        let mut index = Index::open(&config, &read.store.store_id).unwrap();
        assert_eq!(index.event_count().unwrap(), 0, "damaged cache starts over");
        index.replay(&read, WRITER).unwrap();
        assert_eq!(index.event_count().unwrap(), 4);
        assert_eq!(index.max_seq().unwrap(), Some(4));
        let _ = std::fs::remove_dir_all(&vault);
        let _ = std::fs::remove_dir_all(&config);
    }

    #[test]
    fn incremental_and_from_zero_agree_on_content() {
        let (vault, config) = seeded("idx-content", 3);
        let read3 = read_ledger(&ledger_dir(&vault)).unwrap();
        let mut incremental = Index::open(&config, &read3.store.store_id).unwrap();
        incremental.replay(&read3, WRITER).unwrap();
        let mut writer = LedgerWriter::open(&vault, WRITER).unwrap();
        writer
            .append("vault.write", serde_json::json!({"path": "late.md"}))
            .unwrap();
        drop(writer);
        let read4 = read_ledger(&ledger_dir(&vault)).unwrap();
        incremental.replay(&read4, WRITER).unwrap();
        let incremental_rows = incremental.dump_events().unwrap();
        // Nothing exists in the cache that segments cannot reproduce: a
        // from-zero rebuild has exactly the same content.
        let rebuilt = incremental.rebuild(&read4, WRITER).unwrap();
        assert_eq!(rebuilt.dump_events().unwrap(), incremental_rows);
        assert_eq!(rebuilt.event_count().unwrap(), 4);
        let _ = std::fs::remove_dir_all(&vault);
        let _ = std::fs::remove_dir_all(&config);
    }

    #[test]
    fn replay_refuses_a_ledger_behind_or_beside_the_index() {
        let (vault, config) = seeded("idx-diverge", 4);
        let read = read_ledger(&ledger_dir(&vault)).unwrap();
        let mut index = Index::open(&config, &read.store.store_id).unwrap();
        index.replay(&read, WRITER).unwrap();

        // A "restored" ledger: same store, shorter history.
        let mut behind = read_ledger(&ledger_dir(&vault)).unwrap();
        behind.frames.truncate(2);
        behind.head_seq = Some(2);
        let err = index.replay(&behind, WRITER).unwrap_err();
        assert!(err.contains("behind the index"), "{err}");

        // A rewritten history: same length, different bytes at the cursor.
        let mut rewritten = read_ledger(&ledger_dir(&vault)).unwrap();
        rewritten.frames[3].hash = "im-a-different-history".to_string();
        let err = index.replay(&rewritten, WRITER).unwrap_err();
        assert!(err.contains("disagrees with the index"), "{err}");

        // The honest ledger still replays (a no-op — cursor is the head).
        index.replay(&read, WRITER).unwrap();
        assert_eq!(index.event_count().unwrap(), 4);
        let _ = std::fs::remove_dir_all(&vault);
        let _ = std::fs::remove_dir_all(&config);
    }
}
