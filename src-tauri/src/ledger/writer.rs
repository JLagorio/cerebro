//! The single-writer append API (M21.3).
//!
//! PUBLIC-SURFACE TRIPWIRE (code-review check): this module exposes
//! `LedgerWriter::{open, append}`, `Committed`, and `writer_id` — and
//! nothing else. No update, no delete, no open-sealed-for-write exists here
//! or anywhere. Appending is the only way in-app state reaches the ledger,
//! and only this module can append (D3: enforced by construction).
//!
//! The acknowledgement rule (M21 rule one), verbatim:
//!
//!     write frame → flush userspace buffers → fsync open segment
//!     → only then return committed {event_id, seq} to the caller
//!
//! Sealing is a SEPARATE operation (rotation) and is never the transaction
//! boundary.

use std::path::{Path, PathBuf};

use super::frame::{Frame, FRAME_VERSION};
use super::segment::{self, SegmentName, SegmentWriter, Tail};
use super::{ledger_dir, new_id128, read_ledger, store};

/// Records per segment before rotation seals it and opens the next. Any
/// value works; this one keeps segments small enough that recovery scans
/// and cloud-sync conflict units stay boring.
const SEGMENT_MAX_RECORDS: u64 = 1024;

/// Name of the advisory lock file inside the ledger directory.
const LOCK_FILE: &str = "lock";

/// App-data file holding this installation's writer identity.
const WRITER_ID_FILE: &str = "ledger-writer-id";

/// The acknowledgement an append returns — the ONLY receipt an event gets.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Committed {
    pub event_id: String,
    pub seq: u64,
}

/// This installation's writer identity, minted once in APP-DATA — never the
/// vault: two Macs syncing one vault must present different writer ids. A
/// corrupt id file is an error, never a silent re-mint (a fresh id would
/// make this machine's own segments read as a foreign fork).
pub fn writer_id(config_dir: &Path) -> Result<String, String> {
    let path = config_dir.join(WRITER_ID_FILE);
    match std::fs::read_to_string(&path) {
        Ok(raw) => {
            let id = raw.trim();
            if segment::is_hex128(id) {
                Ok(id.to_string())
            } else {
                Err(format!("{}: not a writer id", path.display()))
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            std::fs::create_dir_all(config_dir).map_err(|e| e.to_string())?;
            let id = new_id128();
            let temp = config_dir.join(format!("{WRITER_ID_FILE}.tmp"));
            {
                use std::io::Write;
                let mut file = std::fs::File::create(&temp).map_err(|e| e.to_string())?;
                file.write_all(id.as_bytes()).map_err(|e| e.to_string())?;
                file.sync_all().map_err(|e| e.to_string())?;
            }
            std::fs::rename(&temp, &path).map_err(|e| e.to_string())?;
            super::fsync_dir(config_dir)?;
            Ok(id)
        }
        Err(e) => Err(format!("{}: {e}", path.display())),
    }
}

/// The one handle that can append to a vault's ledger. Holds the advisory
/// lock for its lifetime; dropping it (or dying, kill -9 included) releases
/// the lock with the file descriptor.
#[derive(Debug)]
pub struct LedgerWriter {
    /// Held, never read — the flock rides the descriptor.
    _lock: std::fs::File,
    dir: PathBuf,
    writer_id: String,
    /// None only after a failed rotation — the writer fail-stops rather
    /// than guess which segment is current.
    segment: Option<SegmentWriter>,
    /// `ingested_at` of the newest record, for wall-clock-anomaly stamping.
    prev_wall_clock: Option<String>,
    segment_limit: u64,
}

impl LedgerWriter {
    pub fn open(vault: &Path, writer_id: &str) -> Result<LedgerWriter, String> {
        Self::open_with_limit(vault, writer_id, SEGMENT_MAX_RECORDS)
    }

    fn open_with_limit(vault: &Path, writer_id: &str, limit: u64) -> Result<LedgerWriter, String> {
        let dir = ledger_dir(vault);
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let lock = acquire_lock(&dir)?;
        // Mint the identity when the ledger is new; read_ledger reloads it.
        store::load_or_mint(&dir)?;
        let read = read_ledger(&dir)?;

        if let Some(foreign) = read.segments.iter().find(|n| n.writer_id != writer_id) {
            // The M21.4 matrix names this state; v1 refuses it. A wiped
            // app-data dir (new writer id, old segments) lands here too —
            // adopt-and-reingest is a later milestone, never a guess.
            return Err(format!(
                "ledger segments belong to writer {}; this installation is {} — \
                 foreign ledger, never merged",
                foreign.writer_id, writer_id
            ));
        }

        let next_start = read.head_seq.map_or(1, |seq| seq + 1);
        let last_open = read.segments.last().filter(|n| !n.sealed).cloned();
        let segment = match (last_open, &read.tail) {
            // Fresh ledger, or every segment sealed: start the next one.
            (None, _) => SegmentWriter::create(&dir, writer_id, next_start, &read.head_hash)?,
            // A crash landed between seal-write and rename: finish the
            // rename (the retry the acceptance matrix names), then open the
            // next segment.
            (Some(name), Tail::SealPendingRename) => {
                let sealed = SegmentName {
                    sealed: true,
                    ..name.clone()
                };
                std::fs::rename(dir.join(name.file_name()), dir.join(sealed.file_name()))
                    .map_err(|e| e.to_string())?;
                super::fsync_dir(&dir)?;
                SegmentWriter::create(&dir, writer_id, next_start, &read.head_hash)?
            }
            // A write died mid-frame: truncate the never-acknowledged torn
            // bytes (recovery of garbage, not deletion of events — nothing
            // past `valid_len` was ever committed), then resume.
            (Some(name), Tail::Torn { valid_len }) => {
                let path = dir.join(name.file_name());
                let file = std::fs::File::options()
                    .write(true)
                    .open(&path)
                    .map_err(|e| format!("{}: {e}", path.display()))?;
                file.set_len(*valid_len).map_err(|e| e.to_string())?;
                file.sync_all().map_err(|e| e.to_string())?;
                drop(file);
                resume_last(&dir, &name, &read)?
            }
            (Some(name), Tail::Clean) => resume_last(&dir, &name, &read)?,
        };

        Ok(LedgerWriter {
            _lock: lock,
            dir,
            writer_id: writer_id.to_string(),
            segment: Some(segment),
            prev_wall_clock: read.frames.last().map(|f| f.ingested_at.clone()),
            segment_limit: limit.max(1),
        })
    }

    /// Append one event. Returns only after the frame is durably on disk —
    /// an event that was never acknowledged may be lost by a crash; an
    /// acknowledged one may not. The caller-retry consequence is documented,
    /// not hidden: a caller that dies between fsync and receiving `Committed`
    /// and then retries writes a SECOND event — idempotency is the M22+
    /// reducer's concern, visibility is this layer's.
    pub fn append(&mut self, kind: &str, body: serde_json::Value) -> Result<Committed, String> {
        if self
            .segment
            .as_ref()
            .is_some_and(|s| s.records() >= self.segment_limit)
        {
            self.rotate()?;
        }
        let segment = self
            .segment
            .as_mut()
            .ok_or("ledger writer fail-stopped after a failed rotation")?;

        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let anomaly = self
            .prev_wall_clock
            .as_deref()
            .is_some_and(|prev| wall_clock_regressed(&now, prev));
        let frame = Frame {
            v: FRAME_VERSION,
            seq: segment.next_seq(),
            event_id: new_id128(),
            prev: segment.last_hash().to_string(),
            hash: String::new(),
            ingested_at: now.clone(),
            wall_clock_anomaly: anomaly,
            kind: kind.to_string(),
            body,
        }
        .with_hash()?;

        // The acknowledgement rule. `write_all` on a raw File leaves no
        // userspace buffer to flush; sync_all is F_FULLFSYNC on Apple (see
        // the module doc in mod.rs).
        segment.append(&frame)?;
        crate::crash::crash_point("ledger-frame-written");
        segment.sync()?;
        crate::crash::crash_point("ledger-frame-synced");
        self.prev_wall_clock = Some(now);
        Ok(Committed {
            event_id: frame.event_id,
            seq: frame.seq,
        })
    }

    /// Seal the full segment and open the next. Seal first, create second:
    /// a crash between the two leaves "last segment sealed, none open" —
    /// a state `open` already handles — never two open segments.
    fn rotate(&mut self) -> Result<(), String> {
        let full = self
            .segment
            .take()
            .ok_or("ledger writer fail-stopped after a failed rotation")?;
        let anchor = full.last_hash().to_string();
        let start = full.next_seq();
        full.seal()?;
        self.segment = Some(SegmentWriter::create(
            &self.dir,
            &self.writer_id,
            start,
            &anchor,
        )?);
        Ok(())
    }
}

/// Resume the final open segment: reconstruct the anchor it was created
/// against from the frames BEFORE it, then reopen it for append.
fn resume_last(
    dir: &Path,
    name: &SegmentName,
    read: &super::LedgerRead,
) -> Result<SegmentWriter, String> {
    let split = read
        .frames
        .iter()
        .position(|f| f.seq >= name.start_seq)
        .unwrap_or(read.frames.len());
    let anchor = if split == 0 {
        read.store.store_id.clone()
    } else {
        read.frames[split - 1].hash.clone()
    };
    let tail_read = segment::SegmentRead {
        frames: read.frames[split..].to_vec(),
        seal: None,
        tail: Tail::Clean,
    };
    SegmentWriter::resume(dir, name, &tail_read, &anchor)
}

/// `<ledger>/lock` via the OS advisory lock. std's `File::try_lock` is
/// `flock(LOCK_EX | LOCK_NB)` on Apple targets (rustc 1.95.0,
/// library/std/src/sys/fs/unix.rs:1532) — released with the descriptor on
/// ANY process death, kill -9 included; a pidfile would be stale after one.
/// The M21 plan named the `fs4` crate for this; std has provided the same
/// flock since 1.89, and the house rule is to justify every crate — a
/// dependency duplicating std does not qualify.
fn acquire_lock(dir: &Path) -> Result<std::fs::File, String> {
    let path = dir.join(LOCK_FILE);
    let file = std::fs::File::options()
        .create(true)
        .truncate(false)
        .write(true)
        .open(&path)
        .map_err(|e| format!("{}: {e}", path.display()))?;
    match file.try_lock() {
        Ok(()) => Ok(file),
        Err(std::fs::TryLockError::WouldBlock) => Err(
            "another Cerebro instance holds this vault's ledger — one writer per vault".to_string(),
        ),
        Err(std::fs::TryLockError::Error(e)) => Err(format!("{}: {e}", path.display())),
    }
}

/// True when `now` reads earlier than `prev` — a wall-clock regression,
/// recorded on the frame and never smoothed over (D3). Unparseable stamps
/// never block an append.
fn wall_clock_regressed(now: &str, prev: &str) -> bool {
    match (
        chrono::DateTime::parse_from_rfc3339(now),
        chrono::DateTime::parse_from_rfc3339(prev),
    ) {
        (Ok(now), Ok(prev)) => now < prev,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::testutil;

    const WRITER: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab";
    const OTHER_WRITER: &str = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeef";

    fn body(path: &str) -> serde_json::Value {
        serde_json::json!({ "path": path })
    }

    #[test]
    fn appends_acknowledge_monotonic_seqs_that_survive_reopen() {
        let vault = testutil::temp_vault("writer-basic");
        let mut writer = LedgerWriter::open(&vault, WRITER).unwrap();
        let a = writer.append("vault.write", body("a.md")).unwrap();
        let b = writer.append("vault.write", body("b.md")).unwrap();
        assert_eq!((a.seq, b.seq), (1, 2));
        assert_ne!(a.event_id, b.event_id);
        drop(writer);
        // Seq resumes across writer lifetimes — the segment is resumed, not
        // recreated.
        let mut writer = LedgerWriter::open(&vault, WRITER).unwrap();
        let c = writer.append("vault.delete", body("a.md")).unwrap();
        assert_eq!(c.seq, 3);
        drop(writer);
        let read = read_ledger(&ledger_dir(&vault)).unwrap();
        assert_eq!(read.head_seq, Some(3));
        assert_eq!(read.records, 3);
        assert_eq!(read.segments.len(), 1);
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn rotation_seals_full_segments_and_the_chain_crosses_them() {
        let vault = testutil::temp_vault("writer-rotate");
        let mut writer = LedgerWriter::open_with_limit(&vault, WRITER, 2).unwrap();
        for i in 0..5 {
            writer
                .append("vault.write", body(&format!("n{i}.md")))
                .unwrap();
        }
        drop(writer);
        let read = read_ledger(&ledger_dir(&vault)).unwrap();
        assert_eq!(read.head_seq, Some(5));
        assert_eq!(read.segments.len(), 3);
        assert_eq!(
            read.segments.iter().filter(|s| s.sealed).count(),
            2,
            "two full segments sealed, the tail open"
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    // The M21.3 tripwire test: sealed segment files never change — not
    // their bytes, not their mtimes — across a later append run.
    #[test]
    fn sealed_segments_never_change_across_an_append_run() {
        let vault = testutil::temp_vault("writer-sealed-frozen");
        let mut writer = LedgerWriter::open_with_limit(&vault, WRITER, 2).unwrap();
        for i in 0..5 {
            writer
                .append("vault.write", body(&format!("n{i}.md")))
                .unwrap();
        }
        drop(writer);
        let dir = ledger_dir(&vault);
        let sealed: Vec<_> = read_ledger(&dir)
            .unwrap()
            .segments
            .into_iter()
            .filter(|s| s.sealed)
            .map(|s| dir.join(s.file_name()))
            .collect();
        assert_eq!(sealed.len(), 2);
        let before: Vec<_> = sealed
            .iter()
            .map(|p| {
                let meta = std::fs::metadata(p).unwrap();
                (meta.modified().unwrap(), std::fs::read(p).unwrap())
            })
            .collect();

        let mut writer = LedgerWriter::open_with_limit(&vault, WRITER, 2).unwrap();
        for i in 0..4 {
            writer
                .append("vault.write", body(&format!("m{i}.md")))
                .unwrap();
        }
        drop(writer);

        for (path, (mtime, bytes)) in sealed.iter().zip(before) {
            let meta = std::fs::metadata(path).unwrap();
            assert_eq!(meta.modified().unwrap(), mtime, "{}", path.display());
            assert_eq!(std::fs::read(path).unwrap(), bytes, "{}", path.display());
        }
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn the_lock_admits_exactly_one_writer() {
        let vault = testutil::temp_vault("writer-lock");
        let first = LedgerWriter::open(&vault, WRITER).unwrap();
        let second = LedgerWriter::open(&vault, WRITER);
        assert!(
            second.unwrap_err().contains("another Cerebro"),
            "a second writer must be refused while the first lives"
        );
        drop(first);
        LedgerWriter::open(&vault, WRITER).unwrap();
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn a_foreign_writers_segments_are_refused_never_adopted() {
        let vault = testutil::temp_vault("writer-foreign");
        let mut writer = LedgerWriter::open(&vault, OTHER_WRITER).unwrap();
        writer.append("vault.write", body("theirs.md")).unwrap();
        drop(writer);
        let err = LedgerWriter::open(&vault, WRITER).unwrap_err();
        assert!(err.contains("foreign ledger"), "{err}");
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn a_torn_tail_is_truncated_on_open_and_seq_resumes_correctly() {
        let vault = testutil::temp_vault("writer-torn");
        let mut writer = LedgerWriter::open(&vault, WRITER).unwrap();
        writer.append("vault.write", body("a.md")).unwrap();
        writer.append("vault.write", body("b.md")).unwrap();
        drop(writer);
        // Tear the tail: a half-written third frame, no terminator.
        let dir = ledger_dir(&vault);
        let read = read_ledger(&dir).unwrap();
        let open_path = dir.join(read.segments.last().unwrap().file_name());
        let clean_len = std::fs::metadata(&open_path).unwrap().len();
        use std::io::Write;
        let mut file = std::fs::File::options()
            .append(true)
            .open(&open_path)
            .unwrap();
        file.write_all(b"{\"v\":0,\"seq\":3,\"event_id\":\"dead")
            .unwrap();
        drop(file);

        let mut writer = LedgerWriter::open(&vault, WRITER).unwrap();
        let next = writer.append("vault.write", body("c.md")).unwrap();
        assert_eq!(next.seq, 3, "the torn frame was never committed");
        drop(writer);
        let read = read_ledger(&dir).unwrap();
        assert_eq!(read.head_seq, Some(3));
        assert_eq!(read.tail, Tail::Clean);
        assert!(
            std::fs::metadata(&open_path).unwrap().len() > clean_len,
            "the recovered segment holds the new record where the garbage was"
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn a_future_clock_in_history_stamps_the_next_append_anomalous() {
        assert!(wall_clock_regressed(
            "2026-08-07T11:00:00.000Z",
            "2026-08-07T12:00:00.000Z"
        ));
        assert!(!wall_clock_regressed(
            "2026-08-07T12:00:00.001Z",
            "2026-08-07T12:00:00.000Z"
        ));
        // End to end: hand-build a ledger whose last record claims a wall
        // clock far in the future, then append normally.
        let vault = testutil::temp_vault("writer-anomaly");
        let dir = ledger_dir(&vault);
        let store = store::load_or_mint(&dir).unwrap();
        let future = Frame {
            v: FRAME_VERSION,
            seq: 1,
            event_id: new_id128(),
            prev: store.store_id.clone(),
            hash: String::new(),
            ingested_at: "2999-01-01T00:00:00.000Z".to_string(),
            wall_clock_anomaly: false,
            kind: "vault.write".to_string(),
            body: body("t.md"),
        }
        .with_hash()
        .unwrap();
        let mut seg = SegmentWriter::create(&dir, WRITER, 1, &store.store_id).unwrap();
        seg.append(&future).unwrap();
        seg.sync().unwrap();
        drop(seg);

        let mut writer = LedgerWriter::open(&vault, WRITER).unwrap();
        writer.append("vault.write", body("now.md")).unwrap();
        drop(writer);
        let read = read_ledger(&dir).unwrap();
        assert!(
            read.frames[1].wall_clock_anomaly,
            "a clock reading earlier than its predecessor is recorded, never smoothed over"
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn writer_ids_mint_once_and_never_silently_regenerate() {
        let config = testutil::temp_vault("writer-id");
        let first = writer_id(&config).unwrap();
        assert!(segment::is_hex128(&first));
        assert_eq!(writer_id(&config).unwrap(), first, "stable across calls");
        std::fs::write(config.join(WRITER_ID_FILE), "not a writer id").unwrap();
        assert!(
            writer_id(&config).is_err(),
            "corrupt identity is an error — a silent re-mint would fork the ledger"
        );
        let _ = std::fs::remove_dir_all(&config);
    }

    // --- Crash scenarios (children) and their parents -----------------------

    /// Child: append one more event to an existing ledger. The parent picks
    /// the kill point via CEREBRO_CRASH_POINT.
    #[test]
    #[ignore = "crash-scenario child body, spawned by the crash tests"]
    fn crash_scenario_append_event() {
        let Ok(vault) = std::env::var("CEREBRO_CRASH_VAULT") else {
            return;
        };
        let mut writer = LedgerWriter::open(Path::new(&vault), WRITER).unwrap();
        writer.append("vault.write", body("killed.md")).unwrap();
    }

    /// Child: the third append against limit 2 forces a rotation, whose seal
    /// carries the `ledger-seal-written` crash point.
    #[test]
    #[ignore = "crash-scenario child body, spawned by the crash tests"]
    fn crash_scenario_rotate_at_limit_two() {
        let Ok(vault) = std::env::var("CEREBRO_CRASH_VAULT") else {
            return;
        };
        let mut writer = LedgerWriter::open_with_limit(Path::new(&vault), WRITER, 2).unwrap();
        writer.append("vault.write", body("third.md")).unwrap();
    }

    fn seeded_vault(label: &str, events: u64) -> std::path::PathBuf {
        let vault = testutil::temp_vault(label);
        let mut writer = LedgerWriter::open(&vault, WRITER).unwrap();
        for i in 0..events {
            writer
                .append("vault.write", body(&format!("seed{i}.md")))
                .unwrap();
        }
        vault
    }

    #[test]
    fn killed_after_fsync_before_ack_the_event_is_committed() {
        let vault = seeded_vault("writer-crash-synced", 1);
        let status = testutil::run_crash_scenario(
            "ledger::writer::tests::crash_scenario_append_event",
            "ledger-frame-synced",
            &vault,
        );
        assert!(!status.success());
        // The acknowledgement-rule row: fsync happened, the ack never
        // reached the caller — the event IS committed. A caller that
        // retries appends a second event; that visibility is documented,
        // not hidden.
        let read = read_ledger(&ledger_dir(&vault)).unwrap();
        assert_eq!(read.head_seq, Some(2));
        assert_eq!(read.frames[1].body, body("killed.md"));
        // And the ledger keeps working.
        let mut writer = LedgerWriter::open(&vault, WRITER).unwrap();
        assert_eq!(
            writer.append("vault.write", body("after.md")).unwrap().seq,
            3
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn killed_between_write_and_fsync_the_ledger_reopens_deterministically() {
        let vault = seeded_vault("writer-crash-written", 1);
        let status = testutil::run_crash_scenario(
            "ledger::writer::tests::crash_scenario_append_event",
            "ledger-frame-written",
            &vault,
        );
        assert!(!status.success());
        // Killed before fsync the event was never acknowledged. From a
        // process kill the page cache usually survives, so the frame may
        // well be complete on disk — either way the state must be
        // deterministically explainable and appendable. (True torn tails
        // are enumerated byte-by-byte in the M21.2 construction tests and
        // the torn-tail writer test — a kill cannot produce them on
        // demand, which is exactly why the seam sits before AND after the
        // fsync.)
        let read = read_ledger(&ledger_dir(&vault)).unwrap();
        let head = read.head_seq.unwrap();
        assert!(head == 1 || head == 2, "committed prefix only, got {head}");
        let mut writer = LedgerWriter::open(&vault, WRITER).unwrap();
        let next = writer.append("vault.write", body("after.md")).unwrap();
        assert_eq!(next.seq, head + 1, "seq resumes from the committed head");
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn killed_during_sealing_the_open_segment_survives_and_the_seal_retries() {
        let vault = testutil::temp_vault("writer-crash-seal");
        {
            let mut writer = LedgerWriter::open_with_limit(&vault, WRITER, 2).unwrap();
            writer.append("vault.write", body("a.md")).unwrap();
            writer.append("vault.write", body("b.md")).unwrap();
        }
        let status = testutil::run_crash_scenario(
            "ledger::writer::tests::crash_scenario_rotate_at_limit_two",
            "ledger-seal-written",
            &vault,
        );
        assert!(!status.success());
        // The matrix row: open segment still valid — both committed events
        // readable, the seal trailer pending its rename.
        let dir = ledger_dir(&vault);
        let read = read_ledger(&dir).unwrap();
        assert_eq!(read.head_seq, Some(2));
        assert_eq!(read.tail, Tail::SealPendingRename);
        // …and the seal is retried on next open: the segment seals, a new
        // one opens, appends continue.
        let mut writer = LedgerWriter::open_with_limit(&vault, WRITER, 2).unwrap();
        assert_eq!(writer.append("vault.write", body("c.md")).unwrap().seq, 3);
        drop(writer);
        let read = read_ledger(&dir).unwrap();
        assert_eq!(read.head_seq, Some(3));
        assert_eq!(read.segments.len(), 2);
        assert!(read.segments[0].sealed, "the interrupted seal completed");
        assert_eq!(read.tail, Tail::Clean);
        let _ = std::fs::remove_dir_all(&vault);
    }
}
