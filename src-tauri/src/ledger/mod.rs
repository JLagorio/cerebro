//! Tamper-evident event ledger (M21): hash-chained, append-only NDJSON
//! segments under `<vault>/.cerebro/ledger/`, per master-doc D2/D3.
//!
//! M21.2 is the pure data layer: envelope framing, canonical serialization,
//! record hashing, chain verification, segment read/write/seal, and the
//! store identity. No policy, no scheduling, no event semantics — bodies are
//! opaque JSON until M22 gives them a schema.
//!
//! Not git-tracked (the `.cerebro/` blanket ignore and its `rm --cached`
//! self-heal in git/commit.rs stand). Invisible to the scanner (dot-dir) and
//! the watcher (`is_relevant_path` wants `.md`/`.yml`).
//!
//! Durability: every fsync in this module is `File::sync_all`. Verified
//! against the pinned toolchain (rustc 1.95.0, Homebrew): on Apple targets
//! `sync_all` issues `fcntl(F_FULLFSYNC)` — a real flush through the drive
//! cache — with NO silent `fsync` fallback; an unsupported filesystem
//! surfaces an error instead of a fake sync
//! (library/std/src/sys/fs/unix.rs:1381-1388). Exactly what a commit
//! acknowledgement wants. Re-verify on toolchain bumps.

pub mod frame;
pub mod segment;
pub mod store;

use std::path::{Path, PathBuf};

/// Vault-relative home of the ledger.
pub const LEDGER_DIR: &str = ".cerebro/ledger";

pub fn ledger_dir(vault: &Path) -> PathBuf {
    vault.join(LEDGER_DIR)
}

/// Lowercase-hex SHA-256, the one digest format the ledger speaks.
pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// 128-bit random lowercase hex via the existing `rand` crate — store ids,
/// writer ids, event ids. No uuid dependency (house rule: justify every
/// crate; random hex needs none).
pub(crate) fn new_id128() -> String {
    format!("{:032x}", rand::random::<u128>())
}

/// Fsync a directory so a create/seal/rename inside it is durable, not just
/// the file bytes.
pub(crate) fn fsync_dir(dir: &Path) -> Result<(), String> {
    std::fs::File::open(dir)
        .and_then(|d| d.sync_all())
        .map_err(|e| format!("fsync {}: {e}", dir.display()))
}

/// Everything one pass over a ledger directory can know (M21.2 mechanism —
/// M21.4 recovery builds its typed classification on top of this and of the
/// errors it returns).
#[derive(Debug)]
pub struct LedgerRead {
    pub store: store::StoreInfo,
    /// Seq of the last committed record; None when no records exist yet.
    pub head_seq: Option<u64>,
    /// Hash of the last committed record; the store id when none exist (the
    /// same anchor the first record's `prev` must carry).
    pub head_hash: String,
    /// Committed records across all segments.
    pub records: u64,
    pub frames: Vec<frame::Frame>,
    pub segments: Vec<segment::SegmentName>,
    /// Tail state of the final (open) segment; `Clean` when none exist.
    pub tail: segment::Tail,
}

/// Read and chain-verify the whole ledger. `Err` is corruption or a state
/// this layer refuses to guess about (missing store.json, multiple writer
/// ids, seq discontinuity between segments, more than one open segment…);
/// a torn tail on the final open segment is NOT an error — it is a state,
/// reported in `tail`, recovered by M21.4.
pub fn read_ledger(dir: &Path) -> Result<LedgerRead, String> {
    let store = store::load(dir)?.ok_or_else(|| format!("no store.json in {}", dir.display()))?;

    let mut names: Vec<segment::SegmentName> = Vec::new();
    let entries = std::fs::read_dir(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let file_name = entry.file_name();
        let Some(name) = file_name.to_str() else {
            continue;
        };
        if let Some(parsed) = segment::parse_segment_name(name) {
            names.push(parsed);
        }
        // Anything else (store.json, lock, temps, foreign debris) is not a
        // segment; M21.4 learns to DIAGNOSE debris, this layer skips it.
    }
    names.sort_by_key(|n| n.start_seq);

    // v1 is single-writer: every segment must carry one writer id. A second
    // id is a foreign fork — diagnosable, never merged (D2).
    let writer_ids: std::collections::BTreeSet<&str> =
        names.iter().map(|n| n.writer_id.as_str()).collect();
    if writer_ids.len() > 1 {
        return Err(format!(
            "segments from multiple writers ({}) — foreign fork, never merged",
            writer_ids.into_iter().collect::<Vec<_>>().join(", ")
        ));
    }

    let mut frames: Vec<frame::Frame> = Vec::new();
    let mut anchor = store.store_id.clone();
    let mut next_seq: Option<u64> = None; // None until the first segment names it
    let mut tail = segment::Tail::Clean;

    for (i, name) in names.iter().enumerate() {
        let last = i + 1 == names.len();
        if !last && !name.sealed {
            return Err(format!(
                "open segment {} is not the last segment",
                name.file_name()
            ));
        }
        if let Some(expected) = next_seq {
            if name.start_seq != expected {
                return Err(format!(
                    "segment {} starts at seq {} where {} was expected",
                    name.file_name(),
                    name.start_seq,
                    expected
                ));
            }
        }
        let read =
            segment::read_segment(&dir.join(name.file_name()), name, &anchor, name.start_seq)?;
        if let Some(frame) = read.frames.last() {
            anchor = frame.hash.clone();
        }
        next_seq = Some(name.start_seq + read.frames.len() as u64);
        frames.extend(read.frames);
        tail = read.tail;
    }

    Ok(LedgerRead {
        head_seq: frames.last().map(|f| f.seq),
        head_hash: anchor,
        records: frames.len() as u64,
        frames,
        segments: names,
        tail,
        store,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use frame::tests::fixture;

    const WRITER: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab";
    const OTHER_WRITER: &str = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeef";

    /// A minted ledger dir plus a chain of `n` frames anchored on its store
    /// id (not yet written into any segment).
    fn minted(label: &str, n: u64) -> (std::path::PathBuf, store::StoreInfo, Vec<frame::Frame>) {
        let vault = crate::vault::testutil::temp_vault(label);
        let dir = ledger_dir(&vault);
        let store = store::load_or_mint(&dir).unwrap();
        let frames = frame::tests::chain(&store.store_id, n);
        (vault, store, frames)
    }

    #[test]
    fn an_empty_ledger_reads_as_its_anchor() {
        let (vault, store, _) = minted("ledger-empty", 0);
        let read = read_ledger(&ledger_dir(&vault)).unwrap();
        assert_eq!(read.head_seq, None);
        assert_eq!(read.head_hash, store.store_id);
        assert_eq!(read.records, 0);
        assert!(read.segments.is_empty());
        assert_eq!(read.tail, segment::Tail::Clean);
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn the_chain_verifies_across_a_segment_boundary() {
        let (vault, store, frames) = minted("ledger-cross", 5);
        let dir = ledger_dir(&vault);
        // Seal seq 1-3; leave seq 4-5 open — prev of frame 4 is frame 3's
        // hash, so the chain crosses the boundary record-to-record.
        let mut writer = segment::SegmentWriter::create(&dir, WRITER, 1, &store.store_id).unwrap();
        for frame in &frames[..3] {
            writer.append(frame).unwrap();
        }
        writer.sync().unwrap();
        writer.seal().unwrap();
        let mut writer = segment::SegmentWriter::create(&dir, WRITER, 4, &frames[2].hash).unwrap();
        for frame in &frames[3..] {
            writer.append(frame).unwrap();
        }
        writer.sync().unwrap();

        let read = read_ledger(&dir).unwrap();
        assert_eq!(read.head_seq, Some(5));
        assert_eq!(read.head_hash, frames[4].hash);
        assert_eq!(read.records, 5);
        assert_eq!(read.frames, frames);
        assert_eq!(read.segments.len(), 2);
        assert_eq!(read.tail, segment::Tail::Clean);
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn a_segment_that_does_not_link_to_its_predecessor_is_refused() {
        let (vault, store, frames) = minted("ledger-splice", 3);
        let dir = ledger_dir(&vault);
        let mut writer = segment::SegmentWriter::create(&dir, WRITER, 1, &store.store_id).unwrap();
        for frame in &frames {
            writer.append(frame).unwrap();
        }
        writer.sync().unwrap();
        writer.seal().unwrap();
        // Segment 2 chains from a FORGED anchor — a spliced history.
        let forged = fixture(4, "0000forged", "vault.write", serde_json::json!({}));
        let mut writer = segment::SegmentWriter::create(&dir, WRITER, 4, "0000forged").unwrap();
        writer.append(&forged).unwrap();
        writer.sync().unwrap();
        let err = read_ledger(&dir).unwrap_err();
        assert!(err.contains("broken chain link at seq 4"), "{err}");
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn a_seq_gap_between_segments_is_refused() {
        let (vault, store, frames) = minted("ledger-gap", 3);
        let dir = ledger_dir(&vault);
        let mut writer = segment::SegmentWriter::create(&dir, WRITER, 1, &store.store_id).unwrap();
        for frame in &frames {
            writer.append(frame).unwrap();
        }
        writer.sync().unwrap();
        writer.seal().unwrap();
        // Next segment claims to start at 5 — seq 4 is missing.
        segment::SegmentWriter::create(&dir, WRITER, 5, &frames[2].hash).unwrap();
        let err = read_ledger(&dir).unwrap_err();
        assert!(err.contains("starts at seq 5 where 4"), "{err}");
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn segments_from_a_second_writer_are_refused_never_merged() {
        let (vault, store, frames) = minted("ledger-foreign", 2);
        let dir = ledger_dir(&vault);
        let mut writer = segment::SegmentWriter::create(&dir, WRITER, 1, &store.store_id).unwrap();
        writer.append(&frames[0]).unwrap();
        writer.sync().unwrap();
        writer.seal().unwrap();
        // The same vault synced from a second Mac: same store, different
        // writer — diagnosable, never merged (D2).
        segment::SegmentWriter::create(&dir, OTHER_WRITER, 2, &frames[0].hash).unwrap();
        let err = read_ledger(&dir).unwrap_err();
        assert!(err.contains("multiple writers"), "{err}");
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn an_open_segment_anywhere_but_last_is_refused() {
        let (vault, store, frames) = minted("ledger-openmid", 3);
        let dir = ledger_dir(&vault);
        // Open segment covering 1-2, then a SEALED one at 3 — a shape the
        // single writer can never produce.
        let mut writer = segment::SegmentWriter::create(&dir, WRITER, 1, &store.store_id).unwrap();
        writer.append(&frames[0]).unwrap();
        writer.append(&frames[1]).unwrap();
        writer.sync().unwrap();
        let mut writer = segment::SegmentWriter::create(&dir, WRITER, 3, &frames[1].hash).unwrap();
        writer.append(&frames[2]).unwrap();
        writer.sync().unwrap();
        writer.seal().unwrap();
        let err = read_ledger(&dir).unwrap_err();
        assert!(err.contains("not the last segment"), "{err}");
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn a_missing_store_json_is_an_error() {
        let vault = crate::vault::testutil::temp_vault("ledger-nostore");
        let dir = ledger_dir(&vault);
        std::fs::create_dir_all(&dir).unwrap();
        assert!(read_ledger(&dir).unwrap_err().contains("no store.json"));
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn a_torn_tail_in_the_final_open_segment_is_a_state_not_an_error() {
        let (vault, store, frames) = minted("ledger-tail", 2);
        let dir = ledger_dir(&vault);
        let mut writer = segment::SegmentWriter::create(&dir, WRITER, 1, &store.store_id).unwrap();
        for frame in &frames {
            writer.append(frame).unwrap();
        }
        writer.sync().unwrap();
        let path = dir.join(
            segment::SegmentName {
                writer_id: WRITER.to_string(),
                start_seq: 1,
                sealed: false,
            }
            .file_name(),
        );
        // Tear the tail: drop the last 5 bytes of the final record.
        let bytes = std::fs::read(&path).unwrap();
        std::fs::write(&path, &bytes[..bytes.len() - 5]).unwrap();
        let read = read_ledger(&dir).unwrap();
        assert_eq!(read.head_seq, Some(1));
        assert_eq!(read.records, 1);
        assert!(matches!(read.tail, segment::Tail::Torn { .. }));
        let _ = std::fs::remove_dir_all(&vault);
    }
}
