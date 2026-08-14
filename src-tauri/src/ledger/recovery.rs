//! Open-time classification (M21.4): every state a ledger directory can be
//! in, named deterministically. The verdict is typed — never a bool — and
//! `classify` never mutates anything: recovery ACTIONS (truncating a torn
//! tail, completing a pending seal rename) belong to the writer's open path,
//! which acts only on the recoverable verdicts.

use std::path::Path;

use serde::Serialize;

use super::segment::Tail;
use super::{read_ledger, LedgerFault, LedgerRead};

/// What this machine remembers about the ledger from a previous session —
/// the app-data side of divergence detection (wired to the M21.5 index
/// meta table; a Time Machine restore can rewind app-data too, so this is
/// corroboration, never proof).
#[derive(Debug, Clone, PartialEq)]
pub struct Remembered {
    pub store_id: String,
    pub head_seq: Option<u64>,
    pub head_hash: String,
}

/// The deterministic classification of a ledger directory. Serialized (as a
/// kebab-case `state` tag) into M21.8's `ledger_status` diagnostics.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "kebab-case")]
pub enum Verdict {
    /// No store.json: nothing has ever been recorded here. A fine state,
    /// not a fault — the writer mints on first open.
    NoLedger,
    /// The whole chain verifies, tail clean.
    Valid,
    /// Valid committed prefix, then a partial final line in the open
    /// segment (torn payload or torn frame header — both are the same
    /// physical state: an unterminated last line). Recoverable by
    /// truncation at writer open; never acknowledged, so nothing is lost.
    TornTail { committed_seq: Option<u64> },
    /// The final open segment ends in a valid seal that was never renamed —
    /// a crash mid-seal. The rename is retried at writer open.
    SealPending,
    /// Damage inside the committed region (bad hash, broken link, malformed
    /// terminated line, seal mismatch, structural impossibilities…).
    /// Integrity state: surfaced, never silently truncated.
    Corrupt { detail: String },
    /// A seq range is missing between segments.
    Gap { detail: String },
    /// Overlapping seq coverage — two histories claim the same range.
    Fork { detail: String },
    /// Segments written by another installation (or several). v1 refuses:
    /// diagnosable, never merged; adopt-and-reingest is a later milestone.
    ForeignWriter { theirs: String },
    /// The vault's store identity is not the one this machine remembers —
    /// a wholesale ledger replacement (restore, foreign vault copy).
    ForeignStore { theirs: String, remembered: String },
    /// The ledger head is behind — or rewritten relative to — what this
    /// machine last saw: a restore or history rewrite landed. D3's launch
    /// circuit breaker (a later milestone) consumes this state.
    Diverged { detail: String },
}

impl std::fmt::Display for Verdict {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Verdict::NoLedger => write!(f, "no ledger exists here yet"),
            Verdict::Valid => write!(f, "chain verifies"),
            Verdict::TornTail { committed_seq } => write!(
                f,
                "torn tail after committed seq {} — recoverable by truncation",
                committed_seq.map_or_else(|| "none".to_string(), |s| s.to_string())
            ),
            Verdict::SealPending => write!(f, "seal written, rename pending — retried on open"),
            Verdict::Corrupt { detail } => write!(f, "corrupt: {detail}"),
            Verdict::Gap { detail } => write!(f, "gap: {detail}"),
            Verdict::Fork { detail } => write!(f, "fork: {detail}"),
            Verdict::ForeignWriter { theirs } => {
                write!(f, "foreign ledger: segments belong to writer {theirs}")
            }
            Verdict::ForeignStore { theirs, remembered } => write!(
                f,
                "foreign store: vault ledger is {theirs}, this machine remembers {remembered}"
            ),
            Verdict::Diverged { detail } => write!(f, "diverged: {detail}"),
        }
    }
}

/// A classification plus the committed prefix, when one is readable. The
/// prefix is present exactly for the verdicts a writer may proceed on
/// (`Valid`, `TornTail`, `SealPending`).
#[derive(Debug)]
pub struct Recovery {
    pub verdict: Verdict,
    pub read: Option<LedgerRead>,
}

/// Classify a ledger directory deterministically. Read-only: the filesystem
/// is byte-identical before and after, whatever the verdict.
///
/// `writer_id` — this installation's identity, when the caller has one, for
/// foreign-writer detection. `remembered` — the app-data record of the last
/// head this machine saw, for foreign-store and divergence detection.
pub fn classify(dir: &Path, writer_id: Option<&str>, remembered: Option<&Remembered>) -> Recovery {
    let read = match read_ledger(dir) {
        Ok(read) => read,
        Err(fault) => {
            let verdict = match fault {
                LedgerFault::NoStore => Verdict::NoLedger,
                LedgerFault::StoreUnreadable(detail) => Verdict::Corrupt { detail },
                LedgerFault::MultipleWriters(ids) => Verdict::ForeignWriter {
                    theirs: ids.join(", "),
                },
                fault @ LedgerFault::OpenSegmentNotLast { .. } => Verdict::Corrupt {
                    detail: fault.to_string(),
                },
                fault @ LedgerFault::SeqGap { .. } => Verdict::Gap {
                    detail: fault.to_string(),
                },
                fault @ LedgerFault::SeqOverlap { .. } => Verdict::Fork {
                    detail: fault.to_string(),
                },
                fault @ LedgerFault::SegmentCorrupt { .. } => Verdict::Corrupt {
                    detail: fault.to_string(),
                },
            };
            return Recovery {
                verdict,
                read: None,
            };
        }
    };

    // Identity checks come before tail states: a torn tail in someone
    // else's ledger is still someone else's ledger.
    if let Some(remembered) = remembered {
        if remembered.store_id != read.store.store_id {
            return Recovery {
                verdict: Verdict::ForeignStore {
                    theirs: read.store.store_id.clone(),
                    remembered: remembered.store_id.clone(),
                },
                read: Some(read),
            };
        }
        let regressed = match (read.head_seq, remembered.head_seq) {
            (_, None) => false,
            (None, Some(_)) => true,
            (Some(head), Some(seen)) => {
                head < seen || (head == seen && read.head_hash != remembered.head_hash)
            }
        };
        if regressed {
            let detail = format!(
                "head is seq {} ({}) but this machine last saw seq {} ({}) — \
                 a restore or rewrite landed",
                read.head_seq
                    .map_or_else(|| "none".into(), |s: u64| s.to_string()),
                read.head_hash,
                remembered
                    .head_seq
                    .map_or_else(|| "none".into(), |s: u64| s.to_string()),
                remembered.head_hash,
            );
            return Recovery {
                verdict: Verdict::Diverged { detail },
                read: Some(read),
            };
        }
    }
    if let Some(ours) = writer_id {
        if let Some(foreign) = read.segments.iter().find(|n| n.writer_id != ours) {
            return Recovery {
                verdict: Verdict::ForeignWriter {
                    theirs: foreign.writer_id.clone(),
                },
                read: Some(read),
            };
        }
    }

    let verdict = match read.tail {
        Tail::Clean => Verdict::Valid,
        Tail::Torn { .. } => Verdict::TornTail {
            committed_seq: read.head_seq,
        },
        Tail::SealPendingRename => Verdict::SealPending,
    };
    Recovery {
        verdict,
        read: Some(read),
    }
}

/// The `Remembered` view of a just-read ledger — what M21.5 persists after
/// a successful open so the NEXT open can detect regression.
pub fn remember(read: &LedgerRead) -> Remembered {
    Remembered {
        store_id: read.store.store_id.clone(),
        head_seq: read.head_seq,
        head_hash: read.head_hash.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::super::frame::tests::fixture;
    use super::super::segment::{Seal, SealBody, SegmentName, SegmentWriter};
    use super::super::{ledger_dir, segment, store as ledger_store};
    use super::*;
    use crate::vault::testutil;

    const WRITER: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab";
    const OTHER_WRITER: &str = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeef";

    /// A ledger with `sealed_count` sealed records in one sealed segment and
    /// `open_count` records in a following open segment.
    fn build(
        label: &str,
        sealed_count: u64,
        open_count: u64,
    ) -> (std::path::PathBuf, ledger_store::StoreInfo) {
        let vault = testutil::temp_vault(label);
        let dir = ledger_dir(&vault);
        let store = ledger_store::load_or_mint(&dir).unwrap();
        let frames = super::super::frame::tests::chain(&store.store_id, sealed_count + open_count);
        let mut anchor = store.store_id.clone();
        if sealed_count > 0 {
            let mut writer = SegmentWriter::create(&dir, WRITER, 1, &anchor).unwrap();
            for frame in &frames[..sealed_count as usize] {
                writer.append(frame).unwrap();
            }
            writer.sync().unwrap();
            writer.seal().unwrap();
            anchor = frames[sealed_count as usize - 1].hash.clone();
        }
        if open_count > 0 {
            let mut writer =
                SegmentWriter::create(&dir, WRITER, sealed_count + 1, &anchor).unwrap();
            for frame in &frames[sealed_count as usize..] {
                writer.append(frame).unwrap();
            }
            writer.sync().unwrap();
        }
        (vault, store)
    }

    fn verdict_of(
        vault: &Path,
        writer_id: Option<&str>,
        remembered: Option<&Remembered>,
    ) -> Verdict {
        classify(&ledger_dir(vault), writer_id, remembered).verdict
    }

    fn open_segment_path(vault: &Path, start_seq: u64) -> std::path::PathBuf {
        ledger_dir(vault).join(
            SegmentName {
                writer_id: WRITER.to_string(),
                start_seq,
                sealed: false,
            }
            .file_name(),
        )
    }

    /// Every byte under the ledger dir — classification must never change one.
    fn ledger_bytes(vault: &Path) -> Vec<(std::path::PathBuf, Vec<u8>)> {
        let mut out: Vec<_> = std::fs::read_dir(ledger_dir(vault))
            .unwrap()
            .map(|e| e.unwrap().path())
            .map(|p| (p.clone(), std::fs::read(&p).unwrap()))
            .collect();
        out.sort();
        out
    }

    // Matrix row: no ledger at all.
    #[test]
    fn an_absent_ledger_is_a_named_state_not_an_error() {
        let vault = testutil::temp_vault("rec-none");
        assert_eq!(verdict_of(&vault, Some(WRITER), None), Verdict::NoLedger);
        let _ = std::fs::remove_dir_all(&vault);
    }

    // Matrix rows: valid sealed segment · valid open segment.
    #[test]
    fn valid_sealed_and_open_segments_classify_valid() {
        let (vault, _) = build("rec-valid", 2, 2);
        assert_eq!(verdict_of(&vault, Some(WRITER), None), Verdict::Valid);
        let (sealed_only, _) = build("rec-valid-sealed", 2, 0);
        assert_eq!(verdict_of(&sealed_only, Some(WRITER), None), Verdict::Valid);
        let (open_only, _) = build("rec-valid-open", 0, 2);
        assert_eq!(verdict_of(&open_only, Some(WRITER), None), Verdict::Valid);
        for v in [vault, sealed_only, open_only] {
            let _ = std::fs::remove_dir_all(&v);
        }
    }

    // Matrix row: torn payload (partial JSON tail).
    #[test]
    fn a_torn_payload_classifies_as_recoverable_torn_tail() {
        let (vault, _) = build("rec-torn-payload", 0, 2);
        let path = open_segment_path(&vault, 1);
        let bytes = std::fs::read(&path).unwrap();
        // Cut inside the LAST record's JSON payload, mid-value.
        std::fs::write(&path, &bytes[..bytes.len() - 7]).unwrap();
        let before = ledger_bytes(&vault);
        let recovery = classify(&ledger_dir(&vault), Some(WRITER), None);
        assert_eq!(
            recovery.verdict,
            Verdict::TornTail {
                committed_seq: Some(1)
            }
        );
        assert_eq!(recovery.read.unwrap().records, 1);
        assert_eq!(ledger_bytes(&vault), before, "classification is read-only");
        let _ = std::fs::remove_dir_all(&vault);
    }

    // Matrix row: torn frame header (partial line start).
    #[test]
    fn a_torn_frame_header_classifies_as_recoverable_torn_tail() {
        let (vault, _) = build("rec-torn-header", 0, 2);
        let path = open_segment_path(&vault, 1);
        use std::io::Write;
        let mut file = std::fs::File::options().append(true).open(&path).unwrap();
        // The write died two bytes into the next frame's line.
        file.write_all(b"{\"").unwrap();
        drop(file);
        assert_eq!(
            verdict_of(&vault, Some(WRITER), None),
            Verdict::TornTail {
                committed_seq: Some(2)
            }
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    // Matrix row: bad hash mid-segment — integrity state, NOT truncation.
    #[test]
    fn a_bad_hash_mid_segment_is_corrupt_and_nothing_is_truncated() {
        let (vault, store) = build("rec-badhash", 0, 3);
        let path = open_segment_path(&vault, 1);
        let text = std::fs::read_to_string(&path).unwrap();
        let mut lines: Vec<String> = text.lines().map(str::to_string).collect();
        // Rewrite record 2's body without rehashing — valid JSON, wrong bytes.
        let mut evil = super::super::frame::Frame::from_line(&lines[1]).unwrap();
        evil.body = serde_json::json!({"path": "items/evil.md"});
        lines[1] = evil.to_line().unwrap();
        std::fs::write(&path, format!("{}\n", lines.join("\n"))).unwrap();

        let before = ledger_bytes(&vault);
        let recovery = classify(&ledger_dir(&vault), Some(WRITER), None);
        assert!(
            matches!(&recovery.verdict, Verdict::Corrupt { detail } if detail.contains("hash mismatch")),
            "{:?}",
            recovery.verdict
        );
        assert!(recovery.read.is_none(), "no committed prefix is guessed at");
        assert_eq!(
            ledger_bytes(&vault),
            before,
            "corruption is surfaced, never truncated"
        );
        let _ = (store, ());
        let _ = std::fs::remove_dir_all(&vault);
    }

    // Matrix row: missing seq (gap).
    #[test]
    fn a_missing_seq_range_classifies_as_gap() {
        let (vault, store) = build("rec-gap", 2, 0);
        let dir = ledger_dir(&vault);
        let orphan = fixture(4, "wherever", "vault.write", serde_json::json!({}));
        let mut writer = SegmentWriter::create(&dir, WRITER, 4, "wherever").unwrap();
        writer.append(&orphan).unwrap();
        writer.sync().unwrap();
        let verdict = verdict_of(&vault, Some(WRITER), None);
        assert!(
            matches!(&verdict, Verdict::Gap { detail } if detail.contains("seq 4 where 3")),
            "{verdict:?}"
        );
        let _ = (store, ());
        let _ = std::fs::remove_dir_all(&vault);
    }

    // Matrix row: duplicate seq (fork).
    #[test]
    fn overlapping_seq_ranges_classify_as_fork() {
        let (vault, store) = build("rec-fork", 2, 0);
        let dir = ledger_dir(&vault);
        // A second history claims seq 2 as well.
        let rival = fixture(
            2,
            "elsewhere",
            "vault.write",
            serde_json::json!({"path": "b.md"}),
        );
        let mut writer = SegmentWriter::create(&dir, WRITER, 2, "elsewhere").unwrap();
        writer.append(&rival).unwrap();
        writer.sync().unwrap();
        let verdict = verdict_of(&vault, Some(WRITER), None);
        assert!(
            matches!(&verdict, Verdict::Fork { detail } if detail.contains("seq 2 where 3")),
            "{verdict:?}"
        );
        let _ = (store, ());
        let _ = std::fs::remove_dir_all(&vault);
    }

    // Matrix row: foreign writer_id segment — diagnosable, never merged.
    #[test]
    fn foreign_writer_segments_are_named_never_merged() {
        // All segments one writer, but not OURS (wiped app-data).
        let (vault, _) = build("rec-foreign-writer", 1, 0);
        let verdict = verdict_of(&vault, Some(OTHER_WRITER), None);
        assert_eq!(
            verdict,
            Verdict::ForeignWriter {
                theirs: WRITER.to_string()
            }
        );
        // Two writers on disk at once (sync debris) — foreign regardless of
        // who asks, even with no identity at all.
        let dir = ledger_dir(&vault);
        let read = super::super::read_ledger(&dir).unwrap();
        let stray = fixture(2, &read.head_hash, "vault.write", serde_json::json!({}));
        let mut writer = SegmentWriter::create(&dir, OTHER_WRITER, 2, &read.head_hash).unwrap();
        writer.append(&stray).unwrap();
        writer.sync().unwrap();
        let verdict = verdict_of(&vault, None, None);
        assert!(
            matches!(verdict, Verdict::ForeignWriter { .. }),
            "{verdict:?}"
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    // Matrix row: foreign store_id — v1 refuses with a named state.
    #[test]
    fn a_foreign_store_id_is_refused_with_a_named_state() {
        let (vault, store) = build("rec-foreign-store", 1, 0);
        let remembered = Remembered {
            store_id: "1111111111111111111111111111111f".to_string(),
            head_seq: Some(1),
            head_hash: "whatever".to_string(),
        };
        let verdict = verdict_of(&vault, Some(WRITER), Some(&remembered));
        assert_eq!(
            verdict,
            Verdict::ForeignStore {
                theirs: store.store_id,
                remembered: remembered.store_id.clone(),
            }
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    // Matrix row: restored older head — divergence, not corruption.
    #[test]
    fn a_restored_older_head_classifies_as_diverged() {
        let (vault, store) = build("rec-diverge", 0, 2);
        let dir = ledger_dir(&vault);
        let read = super::super::read_ledger(&dir).unwrap();
        // This machine remembers seq 5; the vault came back at seq 2.
        let remembered = Remembered {
            store_id: store.store_id.clone(),
            head_seq: Some(5),
            head_hash: "some-later-head".to_string(),
        };
        let verdict = verdict_of(&vault, Some(WRITER), Some(&remembered));
        assert!(
            matches!(&verdict, Verdict::Diverged { detail } if detail.contains("last saw seq 5")),
            "{verdict:?}"
        );
        // Same seq, different hash — a rewrite, equally diverged.
        let rewritten = Remembered {
            store_id: store.store_id.clone(),
            head_seq: read.head_seq,
            head_hash: "a-different-history".to_string(),
        };
        assert!(matches!(
            verdict_of(&vault, Some(WRITER), Some(&rewritten)),
            Verdict::Diverged { .. }
        ));
        // And the matching memory classifies Valid — remembering is not
        // suspicion.
        let matching = remember(&read);
        assert_eq!(
            verdict_of(&vault, Some(WRITER), Some(&matching)),
            Verdict::Valid
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    // Matrix row: during segment sealing (the pending rename).
    #[test]
    fn a_pending_seal_rename_classifies_as_seal_pending() {
        let (vault, _) = build("rec-sealpending", 0, 2);
        let path = open_segment_path(&vault, 1);
        let read = super::super::read_ledger(&ledger_dir(&vault)).unwrap();
        let seal = Seal {
            kind: segment::SEAL_KIND.to_string(),
            body: SealBody {
                records: 2,
                segment_hash: segment::segment_hash(read.frames.iter().map(|f| f.hash.as_str())),
            },
        };
        use std::io::Write;
        let mut file = std::fs::File::options().append(true).open(&path).unwrap();
        file.write_all(serde_json::to_string(&seal).unwrap().as_bytes())
            .unwrap();
        file.write_all(b"\n").unwrap();
        drop(file);
        assert_eq!(verdict_of(&vault, Some(WRITER), None), Verdict::SealPending);
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn verdicts_serialize_with_named_states_for_diagnostics() {
        let json = serde_json::to_value(Verdict::TornTail {
            committed_seq: Some(7),
        })
        .unwrap();
        assert_eq!(json["state"], "torn-tail");
        assert_eq!(json["committed_seq"], 7);
        let json = serde_json::to_value(Verdict::NoLedger).unwrap();
        assert_eq!(json["state"], "no-ledger");
    }
}
