//! Segment files: write-once NDJSON runs of the chain (M21.2).
//!
//! `{writer_id}-{start_seq:016}.ndjsonl.open` while active, renamed to
//! `{writer_id}-{start_seq:016}.ndjsonl` at seal. Write-once after seal — no
//! code path in this module (or anywhere) opens a sealed segment for
//! writing. The commit invariant (master doc D2): only complete, hash-valid
//! records before the first malformed trailing record are committed; a torn
//! tail is by construction a partial LAST line, and a malformed line
//! anywhere else is corruption, never silent truncation.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::frame::Frame;
use super::{fsync_dir, sha256_hex};

pub const SEALED_SUFFIX: &str = ".ndjsonl";
pub const OPEN_SUFFIX: &str = ".ndjsonl.open";

/// Machine-specific segment identity (D2): writer id + seq range, so a
/// foreign fork ("conflicted copy" from a second Mac) is diagnosable rather
/// than ambiguous — even though it is never auto-merged.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SegmentName {
    /// 128-bit lowercase hex identifying the writing installation. Lives in
    /// app-data, not the vault: two Macs syncing one vault present two ids.
    pub writer_id: String,
    /// Seq of the first record this segment holds (or will hold).
    pub start_seq: u64,
    pub sealed: bool,
}

impl SegmentName {
    pub fn file_name(&self) -> String {
        let suffix = if self.sealed {
            SEALED_SUFFIX
        } else {
            OPEN_SUFFIX
        };
        format!("{}-{:016}{suffix}", self.writer_id, self.start_seq)
    }
}

fn is_hex128(s: &str) -> bool {
    s.len() == 32
        && s.bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

/// Parse a directory entry name; None = not a segment (store.json, lock,
/// temps, foreign debris — M21.4 learns to diagnose debris, this layer
/// only recognizes its own).
pub fn parse_segment_name(name: &str) -> Option<SegmentName> {
    let (stem, sealed) = match name.strip_suffix(OPEN_SUFFIX) {
        Some(stem) => (stem, false),
        None => (name.strip_suffix(SEALED_SUFFIX)?, true),
    };
    let (writer_id, dash_seq) = stem.split_at(stem.len().checked_sub(17)?);
    let seq = dash_seq.strip_prefix('-')?;
    if !is_hex128(writer_id) || seq.len() != 16 || !seq.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some(SegmentName {
        writer_id: writer_id.to_string(),
        start_seq: seq.parse().ok()?,
        sealed,
    })
}

pub const SEAL_KIND: &str = "ledger.seal";

/// The seal trailer — the last line of every sealed segment. NOT an event
/// frame: it carries no seq, no event id, and does not participate in the
/// chain (the chain crosses segment boundaries record-to-record). Its
/// integrity is checkable without a self-hash: `records` must match the
/// count read, `segment_hash` must match the hashes read.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Seal {
    pub kind: String,
    pub body: SealBody,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SealBody {
    /// Records in this segment (frames only — the seal never counts itself).
    pub records: u64,
    /// SHA-256 (hex) over the concatenated lowercase-hex record hashes, in
    /// order — the segment-level checksum written at seal (D2).
    pub segment_hash: String,
}

/// The segment-level checksum over record hashes in order.
pub fn segment_hash<'a>(record_hashes: impl Iterator<Item = &'a str>) -> String {
    let mut concat = String::new();
    for hash in record_hashes {
        concat.push_str(hash);
    }
    sha256_hex(concat.as_bytes())
}

/// Append-side handle on one OPEN segment. Durability is split on purpose:
/// `append` writes, `sync` makes durable — the M21.3 append API owns the
/// acknowledgement rule (write frame → fsync → only then ack). `seal`
/// consumes the writer; nothing can append to a sealed segment.
pub struct SegmentWriter {
    file: std::fs::File,
    dir: PathBuf,
    name: SegmentName,
    last_hash: String,
    next_seq: u64,
    record_hashes: Vec<String>,
}

impl SegmentWriter {
    /// Create a fresh open segment. `anchor` is the chain link the first
    /// record must carry as `prev` — the previous segment's last record
    /// hash, or the store id for the very first. The directory is fsynced:
    /// segment create is a directory mutation (D2).
    pub fn create(
        dir: &Path,
        writer_id: &str,
        start_seq: u64,
        anchor: &str,
    ) -> Result<SegmentWriter, String> {
        let name = SegmentName {
            writer_id: writer_id.to_string(),
            start_seq,
            sealed: false,
        };
        let path = dir.join(name.file_name());
        let file = std::fs::File::options()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|e| format!("{}: {e}", path.display()))?;
        fsync_dir(dir)?;
        Ok(SegmentWriter {
            file,
            dir: dir.to_path_buf(),
            name,
            last_hash: anchor.to_string(),
            next_seq: start_seq,
            record_hashes: Vec::new(),
        })
    }

    /// Write one frame line (buffered in the OS — call `sync` to commit).
    /// The data layer refuses a frame that does not extend its own chain: a
    /// caller bug must never become disk state.
    pub fn append(&mut self, frame: &Frame) -> Result<(), String> {
        use std::io::Write;
        if frame.seq != self.next_seq {
            return Err(format!(
                "frame seq {} where {} was expected",
                frame.seq, self.next_seq
            ));
        }
        if frame.prev != self.last_hash {
            return Err(format!(
                "frame at seq {} does not link to the chain head",
                frame.seq
            ));
        }
        if frame.hash != frame.compute_hash()? {
            return Err(format!("frame at seq {} does not verify", frame.seq));
        }
        let mut line = frame.to_line()?;
        line.push('\n');
        self.file
            .write_all(line.as_bytes())
            .map_err(|e| e.to_string())?;
        self.last_hash = frame.hash.clone();
        self.next_seq += 1;
        self.record_hashes.push(frame.hash.clone());
        Ok(())
    }

    /// Fsync the open segment — the durability half of the commit rule.
    pub fn sync(&self) -> Result<(), String> {
        self.file.sync_all().map_err(|e| e.to_string())
    }

    /// Seal: write the trailer, fsync, rename open→sealed, fsync the
    /// directory. A SEPARATE operation from commit, never the transaction
    /// boundary (M21 rule one). Consumes the writer.
    pub fn seal(mut self) -> Result<PathBuf, String> {
        use std::io::Write;
        let seal = Seal {
            kind: SEAL_KIND.to_string(),
            body: SealBody {
                records: self.record_hashes.len() as u64,
                segment_hash: segment_hash(self.record_hashes.iter().map(String::as_str)),
            },
        };
        let mut line = serde_json::to_string(&seal).map_err(|e| e.to_string())?;
        line.push('\n');
        self.file
            .write_all(line.as_bytes())
            .map_err(|e| e.to_string())?;
        self.file.sync_all().map_err(|e| e.to_string())?;
        crate::crash::crash_point("ledger-seal-written");
        let open_path = self.dir.join(self.name.file_name());
        let sealed_name = SegmentName {
            sealed: true,
            ..self.name.clone()
        };
        let sealed_path = self.dir.join(sealed_name.file_name());
        std::fs::rename(&open_path, &sealed_path).map_err(|e| e.to_string())?;
        fsync_dir(&self.dir)?;
        Ok(sealed_path)
    }

    pub fn last_hash(&self) -> &str {
        &self.last_hash
    }

    pub fn next_seq(&self) -> u64 {
        self.next_seq
    }

    pub fn records(&self) -> u64 {
        self.record_hashes.len() as u64
    }
}

/// How a segment's byte stream ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Tail {
    /// Every byte accounted for.
    Clean,
    /// A partial (unterminated) FINAL line — a write died mid-frame. The
    /// committed prefix ends at `valid_len`; truncating there recovers it.
    /// Open segments only: a torn SEALED segment is corruption, not a state.
    Torn { valid_len: u64 },
    /// An open segment whose last line is a valid, matching seal: a crash
    /// landed between seal-write and the rename. The seal is retried (rename
    /// completed) on next open — never re-written.
    SealPendingRename,
}

#[derive(Debug)]
pub struct SegmentRead {
    pub frames: Vec<Frame>,
    pub seal: Option<Seal>,
    pub tail: Tail,
}

/// Read one segment and verify every record against the chain (`anchor`,
/// `first_seq` — the link and seq the first record must carry).
///
/// The commit invariant, literally: a valid line is a `\n`-terminated,
/// hash-valid, chain-linked frame. An UNTERMINATED final chunk is a torn
/// tail (our writer fsyncs record+newline as one write; a missing terminator
/// proves the write never completed — the record was never acknowledged).
/// Every other irregularity — a terminated malformed line, a bad hash, a
/// broken link, content after a seal, a torn or seal-less SEALED segment —
/// is an `Err`: corruption or foreign meddling, never silently truncated.
pub fn read_segment(
    path: &Path,
    name: &SegmentName,
    anchor: &str,
    first_seq: u64,
) -> Result<SegmentRead, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
    parse_segment(&bytes, name.sealed, anchor, first_seq)
        .map_err(|e| format!("{}: {e}", path.display()))
}

/// The pure parser behind `read_segment` — takes bytes so the property tests
/// (bit-flip and torn-tail loops) can run thousands of cases in memory.
pub(crate) fn parse_segment(
    bytes: &[u8],
    sealed: bool,
    anchor: &str,
    first_seq: u64,
) -> Result<SegmentRead, String> {
    let mut frames: Vec<Frame> = Vec::new();
    let mut seal: Option<Seal> = None;
    let mut valid_len: u64 = 0;
    let mut prev_hash = anchor.to_string();
    let mut expect_seq = first_seq;

    let mut pos = 0usize;
    while pos < bytes.len() {
        let (line_bytes, terminated, next_pos) = match bytes[pos..].iter().position(|&b| b == b'\n')
        {
            Some(i) => (&bytes[pos..pos + i], true, pos + i + 1),
            None => (&bytes[pos..], false, bytes.len()),
        };
        if seal.is_some() {
            return Err("content after the seal record".to_string());
        }
        if !terminated {
            if sealed {
                return Err(
                    "torn tail in a sealed segment — sealed segments are write-once and complete"
                        .to_string(),
                );
            }
            return Ok(SegmentRead {
                frames,
                seal: None,
                tail: Tail::Torn { valid_len },
            });
        }
        let text = std::str::from_utf8(line_bytes)
            .map_err(|_| format!("non-UTF-8 record at byte {pos}"))?;
        match Frame::from_line(text) {
            Ok(frame) => {
                if frame.seq != expect_seq {
                    return Err(format!("seq {} where {expect_seq} was expected", frame.seq));
                }
                if frame.prev != prev_hash {
                    return Err(format!("broken chain link at seq {}", frame.seq));
                }
                if frame.hash != frame.compute_hash()? {
                    return Err(format!("hash mismatch at seq {}", frame.seq));
                }
                prev_hash = frame.hash.clone();
                expect_seq += 1;
                frames.push(frame);
                valid_len = next_pos as u64;
            }
            Err(frame_err) => match serde_json::from_str::<Seal>(text) {
                Ok(candidate) if candidate.kind == SEAL_KIND => {
                    if candidate.body.records != frames.len() as u64 {
                        return Err(format!(
                            "seal counts {} records where {} exist",
                            candidate.body.records,
                            frames.len()
                        ));
                    }
                    let expected = segment_hash(frames.iter().map(|f| f.hash.as_str()));
                    if candidate.body.segment_hash != expected {
                        return Err("seal checksum mismatch".to_string());
                    }
                    seal = Some(candidate);
                    valid_len = next_pos as u64;
                }
                _ => {
                    return Err(format!("malformed record at byte {pos}: {frame_err}"));
                }
            },
        }
        pos = next_pos;
    }

    let tail = match (&seal, sealed) {
        (Some(_), true) => Tail::Clean,
        (Some(_), false) => Tail::SealPendingRename,
        (None, true) => {
            return Err("sealed segment without a seal record".to_string());
        }
        (None, false) => Tail::Clean,
    };
    Ok(SegmentRead { frames, seal, tail })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ledger::frame::tests::{chain, fixture};
    use crate::vault::testutil;

    const WRITER: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab";
    const STORE: &str = "cccccccccccccccccccccccccccccccd";

    fn open_name() -> SegmentName {
        SegmentName {
            writer_id: WRITER.to_string(),
            start_seq: 1,
            sealed: false,
        }
    }

    /// Build an open on-disk segment of n records; returns (dir, path, frames).
    fn open_segment(label: &str, n: u64) -> (std::path::PathBuf, std::path::PathBuf, Vec<Frame>) {
        let dir = testutil::temp_vault(label);
        let frames = chain(STORE, n);
        let mut writer = SegmentWriter::create(&dir, WRITER, 1, STORE).unwrap();
        for frame in &frames {
            writer.append(frame).unwrap();
        }
        writer.sync().unwrap();
        let path = dir.join(open_name().file_name());
        (dir, path, frames)
    }

    #[test]
    fn segment_names_round_trip_and_reject_foreign_shapes() {
        for sealed in [false, true] {
            let name = SegmentName {
                writer_id: WRITER.to_string(),
                start_seq: 42,
                sealed,
            };
            assert_eq!(parse_segment_name(&name.file_name()), Some(name));
        }
        let valid = format!("{WRITER}-{:016}.ndjsonl", 7);
        assert!(parse_segment_name(&valid).is_some());
        for foreign in [
            "store.json",
            "lock",
            "segment-000010 conflicted copy.ndjsonl", // the D2 cloud-sync case
            &format!("{WRITER}-{:016}.ndjsonl.open extra", 7),
            &format!("{WRITER}-{:015}.ndjsonl", 7), // 15-digit seq
            &format!("{WRITER}_{:016}.ndjsonl", 7), // no dash
            &format!("{}-{:016}.ndjsonl", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB", 7), // uppercase
            &format!("{}-{:016}.ndjsonl", "abc123", 7), // short writer id
            &format!("{WRITER}-{}.ndjsonl", "00000000000000x7"), // non-digit seq
        ] {
            assert_eq!(parse_segment_name(foreign), None, "{foreign}");
        }
    }

    #[test]
    fn writer_appends_and_reader_round_trips() {
        let (dir, path, frames) = open_segment("seg-roundtrip", 3);
        let read = read_segment(&path, &open_name(), STORE, 1).unwrap();
        assert_eq!(read.frames, frames);
        assert_eq!(read.tail, Tail::Clean);
        assert!(read.seal.is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn writer_refuses_frames_that_do_not_extend_its_chain() {
        let dir = testutil::temp_vault("seg-refuse");
        let frames = chain(STORE, 2);
        let mut writer = SegmentWriter::create(&dir, WRITER, 1, STORE).unwrap();
        // Wrong starting seq.
        assert!(writer.append(&frames[1]).is_err());
        writer.append(&frames[0]).unwrap();
        // Replay of the same frame (seq already taken).
        assert!(writer.append(&frames[0]).is_err());
        // Right seq, wrong link.
        let unlinked = fixture(2, "not-the-head", "vault.write", serde_json::json!({}));
        assert!(writer.append(&unlinked).is_err());
        // Right seq and link, tampered hash.
        let mut forged = fixture(2, &frames[0].hash, "vault.write", serde_json::json!({}));
        forged.hash = format!("{:0>64}", "beef");
        assert!(writer.append(&forged).is_err());
        // A second segment at the same start seq cannot be created.
        assert!(SegmentWriter::create(&dir, WRITER, 1, STORE).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn seal_renames_and_the_sealed_segment_verifies() {
        let (dir, open_path, frames) = open_segment("seg-seal", 3);
        // Rebuild a writer state by re-creating: instead, seal via a fresh
        // writer over a new dir to keep the flow honest.
        let _ = (open_path, frames);
        let dir2 = testutil::temp_vault("seg-seal2");
        let frames = chain(STORE, 3);
        let mut writer = SegmentWriter::create(&dir2, WRITER, 1, STORE).unwrap();
        for frame in &frames {
            writer.append(frame).unwrap();
        }
        writer.sync().unwrap();
        let sealed_path = writer.seal().unwrap();
        let sealed_name = SegmentName {
            writer_id: WRITER.to_string(),
            start_seq: 1,
            sealed: true,
        };
        assert_eq!(sealed_path, dir2.join(sealed_name.file_name()));
        assert!(!dir2.join(open_name().file_name()).exists());
        let read = read_segment(&sealed_path, &sealed_name, STORE, 1).unwrap();
        assert_eq!(read.frames, frames);
        assert_eq!(read.tail, Tail::Clean);
        let seal = read.seal.expect("sealed segment carries its seal");
        assert_eq!(seal.body.records, 3);
        assert_eq!(
            seal.body.segment_hash,
            segment_hash(frames.iter().map(|f| f.hash.as_str()))
        );
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&dir2);
    }

    #[test]
    fn a_seal_pending_rename_is_a_state_not_corruption() {
        let (dir, path, frames) = open_segment("seg-pending", 2);
        // Hand-write the seal line without the rename — the exact bytes a
        // crash between seal-fsync and rename leaves behind.
        let seal = Seal {
            kind: SEAL_KIND.to_string(),
            body: SealBody {
                records: 2,
                segment_hash: segment_hash(frames.iter().map(|f| f.hash.as_str())),
            },
        };
        let mut bytes = std::fs::read(&path).unwrap();
        bytes.extend_from_slice(serde_json::to_string(&seal).unwrap().as_bytes());
        bytes.push(b'\n');
        std::fs::write(&path, &bytes).unwrap();

        let read = read_segment(&path, &open_name(), STORE, 1).unwrap();
        assert_eq!(read.tail, Tail::SealPendingRename);
        assert_eq!(read.frames, frames);

        // Anything AFTER a seal is corruption, not a state.
        let mut after = bytes.clone();
        after.extend_from_slice(frames[0].to_line().unwrap().as_bytes());
        after.push(b'\n');
        let err = parse_segment(&after, false, STORE, 1).unwrap_err();
        assert!(err.contains("after the seal"), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_sealed_segment_without_its_seal_is_corrupt() {
        let (dir, path, _) = open_segment("seg-sealless", 2);
        let bytes = std::fs::read(&path).unwrap();
        let err = parse_segment(&bytes, true, STORE, 1).unwrap_err();
        assert!(err.contains("without a seal"), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_malformed_line_mid_file_is_corruption_never_truncation() {
        let (dir, path, frames) = open_segment("seg-midcorrupt", 3);
        let bytes = std::fs::read(&path).unwrap();
        // Cut the SECOND record short but leave the third intact — a state no
        // torn write can produce (a torn tail is only ever the last line).
        let text = String::from_utf8(bytes).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        let doctored = format!(
            "{}\n{}\n{}\n",
            lines[0],
            &lines[1][..lines[1].len() - 10],
            lines[2]
        );
        let err = parse_segment(doctored.as_bytes(), false, STORE, 1).unwrap_err();
        assert!(err.contains("malformed record"), "{err}");
        // And a hash-invalid middle record (valid JSON, wrong bytes) is the
        // same class: corruption, not recovery.
        let evil = frames[1].clone();
        let mut evil = evil;
        evil.body = serde_json::json!({"path": "items/evil.md"});
        let doctored = format!("{}\n{}\n{}\n", lines[0], evil.to_line().unwrap(), lines[2]);
        let err = parse_segment(doctored.as_bytes(), false, STORE, 1).unwrap_err();
        assert!(err.contains("hash mismatch"), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // The M21.2 property test, literally: truncate at EVERY byte offset —
    // the reader must always recover exactly the committed prefix. Loop,
    // not spot checks.
    #[test]
    fn truncation_at_every_byte_offset_recovers_the_committed_prefix() {
        let (dir, path, frames) = open_segment("seg-torn", 3);
        let bytes = std::fs::read(&path).unwrap();
        // Line-end offsets: after byte `end`, exactly `i+1` records are in.
        let line_ends: Vec<usize> = bytes
            .iter()
            .enumerate()
            .filter_map(|(i, &b)| (b == b'\n').then_some(i + 1))
            .collect();
        assert_eq!(line_ends.len(), 3);
        for cut in 0..=bytes.len() {
            let prefix = &bytes[..cut];
            let read = parse_segment(prefix, false, STORE, 1)
                .unwrap_or_else(|e| panic!("cut at {cut} must stay readable: {e}"));
            let committed = line_ends.iter().filter(|&&end| end <= cut).count();
            assert_eq!(read.frames, frames[..committed], "cut at {cut}");
            let on_boundary = cut == 0 || line_ends.contains(&cut);
            if on_boundary {
                assert_eq!(read.tail, Tail::Clean, "cut at {cut}");
            } else {
                let valid_len = line_ends
                    .iter()
                    .rev()
                    .find(|&&end| end <= cut)
                    .copied()
                    .unwrap_or(0) as u64;
                assert_eq!(read.tail, Tail::Torn { valid_len }, "cut at {cut}");
            }
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    // The other M21.2 property test: EVERY single-bit flip anywhere in a
    // sealed segment must be caught. Sealed segments are write-once and
    // complete, so every flip is corruption — asserting is_err() is exact,
    // not approximate.
    #[test]
    fn every_single_bit_flip_in_a_sealed_segment_is_caught() {
        let dir = testutil::temp_vault("seg-bitflip");
        let frames = chain(STORE, 2);
        let mut writer = SegmentWriter::create(&dir, WRITER, 1, STORE).unwrap();
        for frame in &frames {
            writer.append(frame).unwrap();
        }
        let sealed_path = writer.seal().unwrap();
        let bytes = std::fs::read(&sealed_path).unwrap();
        parse_segment(&bytes, true, STORE, 1).expect("pristine segment verifies");
        for i in 0..bytes.len() {
            for bit in 0..8 {
                let mut flipped = bytes.clone();
                flipped[i] ^= 1 << bit;
                assert!(
                    parse_segment(&flipped, true, STORE, 1).is_err(),
                    "flip of bit {bit} at byte {i} went undetected"
                );
            }
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    // An open segment admits one legitimate non-Err outcome under damage —
    // a torn tail — so the property is weaker but still total: no flip may
    // ever read back as the pristine clean segment.
    #[test]
    fn every_single_bit_flip_in_an_open_segment_is_detected() {
        let (dir, path, frames) = open_segment("seg-bitflip-open", 2);
        let bytes = std::fs::read(&path).unwrap();
        for i in 0..bytes.len() {
            for bit in 0..8 {
                let mut flipped = bytes.clone();
                flipped[i] ^= 1 << bit;
                let undetected = matches!(
                    parse_segment(&flipped, false, STORE, 1),
                    Ok(SegmentRead { frames: f, tail: Tail::Clean, .. }) if f == frames
                );
                assert!(!undetected, "flip of bit {bit} at byte {i} went undetected");
            }
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
