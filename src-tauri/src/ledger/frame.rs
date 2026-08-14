//! The record envelope: one NDJSON line per committed event (M21.2).
//!
//! THE STRUCT IS THE CANON. Canonical JSON is exactly what serde_json emits
//! for [`Frame`], fields in declaration order — there is no separate
//! canonicalization pass, so a line this module did not write hash-verifies
//! only if it is byte-canonical, which is the point.

use serde::{Deserialize, Serialize};

/// Envelope version. Envelope changes bump this; new `kind`s and body fields
/// do not (additive-only discipline — ledger vocabulary creep is a standing
/// risk). `v: 0` = M21 shadow plumbing, pre-M22-schema.
pub const FRAME_VERSION: u64 = 0;

/// One committed ledger record.
///
/// Event identity ≠ entity identity (M21 rule two): a frame carries
/// `event_id` + `seq` and nothing else. Entity ids live in `body`; entity
/// VERSIONS are M22 reducer state — no `version` field may ever appear in
/// this envelope.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Frame {
    pub v: u64,
    /// The monotonic sequence stamped in-core at append — the whole ordering
    /// story (D3: no HLC).
    pub seq: u64,
    /// 128-bit random hex: the event's immutable identity.
    pub event_id: String,
    /// Hash of the previous record; the store id for the very first record,
    /// so an empty-prefix splice is detectable.
    pub prev: String,
    /// Lowercase-hex SHA-256 of this record's canonical JSON with `hash`
    /// set to `""`.
    pub hash: String,
    /// RFC3339 millis wall clock — display and temporal context only, never
    /// ordering.
    pub ingested_at: String,
    /// True when this record's wall clock reads earlier than its
    /// predecessor's: recorded, never smoothed over (D3).
    pub wall_clock_anomaly: bool,
    pub kind: String,
    pub body: serde_json::Value,
}

impl Frame {
    /// The canonical line (no trailing newline). serde_json escapes control
    /// characters, so a canonical line can never contain a raw newline —
    /// NDJSON framing is safe by construction.
    pub fn to_line(&self) -> Result<String, String> {
        serde_json::to_string(self).map_err(|e| e.to_string())
    }

    /// Parse one line. Unknown envelope fields and unknown versions are
    /// refused — a frame this reader cannot re-serialize canonically is a
    /// frame it cannot verify.
    pub fn from_line(line: &str) -> Result<Frame, String> {
        let frame: Frame = serde_json::from_str(line).map_err(|e| e.to_string())?;
        if frame.v != FRAME_VERSION {
            return Err(format!("unsupported frame version {}", frame.v));
        }
        Ok(frame)
    }

    /// What `hash` must equal: SHA-256 over the canonical JSON with `hash`
    /// blanked.
    pub fn compute_hash(&self) -> Result<String, String> {
        let mut unhashed = self.clone();
        unhashed.hash = String::new();
        Ok(super::sha256_hex(unhashed.to_line()?.as_bytes()))
    }

    /// Fill `hash` from the current contents.
    pub fn with_hash(mut self) -> Result<Frame, String> {
        self.hash = self.compute_hash()?;
        Ok(self)
    }
}

/// Verify hashes and links over consecutive frames: each `hash` matches its
/// content, each `prev` equals its predecessor's hash (`anchor` for the
/// first — the previous segment's last hash, or the store id), and `seq`
/// increments by exactly one from `first_seq`.
pub fn verify_chain(frames: &[Frame], anchor: &str, first_seq: u64) -> Result<(), String> {
    let mut prev_hash = anchor;
    for (expect_seq, frame) in (first_seq..).zip(frames.iter()) {
        if frame.seq != expect_seq {
            return Err(format!("seq {} where {expect_seq} was expected", frame.seq));
        }
        if frame.prev != prev_hash {
            return Err(format!("broken chain link at seq {}", frame.seq));
        }
        if frame.hash != frame.compute_hash()? {
            return Err(format!("hash mismatch at seq {}", frame.seq));
        }
        prev_hash = &frame.hash;
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// Deterministic fixture frame — fixed ids and clock so golden values
    /// are stable.
    pub(crate) fn fixture(seq: u64, prev: &str, kind: &str, body: serde_json::Value) -> Frame {
        Frame {
            v: FRAME_VERSION,
            seq,
            event_id: format!("{seq:032x}"),
            prev: prev.to_string(),
            hash: String::new(),
            ingested_at: "2026-08-07T12:00:00.000Z".to_string(),
            wall_clock_anomaly: false,
            kind: kind.to_string(),
            body,
        }
        .with_hash()
        .unwrap()
    }

    /// A chain of n fixture frames anchored on `anchor`, seq starting at 1.
    pub(crate) fn chain(anchor: &str, n: u64) -> Vec<Frame> {
        let mut frames = Vec::new();
        let mut prev = anchor.to_string();
        for seq in 1..=n {
            let frame = fixture(
                seq,
                &prev,
                "vault.write",
                serde_json::json!({ "path": format!("items/n{seq}.md") }),
            );
            prev = frame.hash.clone();
            frames.push(frame);
        }
        frames
    }

    #[test]
    fn the_canonical_line_is_pinned() {
        // THE STRUCT IS THE CANON: this literal is the format. If this test
        // breaks, the envelope changed — that is a format migration, not a
        // refactor. (v is 0; additive-only from here.)
        let frame = fixture(
            1,
            "anchor",
            "vault.write",
            serde_json::json!({"path": "a.md"}),
        );
        let line = frame.to_line().unwrap();
        assert_eq!(
            line,
            format!(
                concat!(
                    "{{\"v\":0,\"seq\":1,",
                    "\"event_id\":\"00000000000000000000000000000001\",",
                    "\"prev\":\"anchor\",",
                    "\"hash\":\"{}\",",
                    "\"ingested_at\":\"2026-08-07T12:00:00.000Z\",",
                    "\"wall_clock_anomaly\":false,",
                    "\"kind\":\"vault.write\",",
                    "\"body\":{{\"path\":\"a.md\"}}}}"
                ),
                frame.hash
            )
        );
    }

    #[test]
    fn encode_decode_round_trips_byte_for_byte() {
        let bodies = [
            serde_json::json!({}),
            serde_json::json!({ "path": "items/ünïcode — dash.md", "n": 42, "f": 1.5 }),
            serde_json::json!({ "nested": { "deep": [1, 2, { "k": null }] }, "esc": "a\nb\t\"c\"" }),
            // Key order must survive the round trip (preserve_order).
            serde_json::json!({ "z": 1, "a": 2, "m": 3 }),
        ];
        for body in bodies {
            let frame = fixture(7, "prev-hash", "vault.rename", body);
            let line = frame.to_line().unwrap();
            let back = Frame::from_line(&line).unwrap();
            assert_eq!(back, frame);
            assert_eq!(back.to_line().unwrap(), line);
        }
    }

    #[test]
    fn hash_covers_every_field() {
        let base = fixture(
            3,
            "prev",
            "vault.write",
            serde_json::json!({"path": "a.md"}),
        );
        assert_eq!(
            base.hash,
            base.compute_hash().unwrap(),
            "fixture self-verifies"
        );
        let variants: Vec<Frame> = vec![
            Frame {
                seq: 4,
                ..base.clone()
            },
            Frame {
                event_id: "ff".into(),
                ..base.clone()
            },
            Frame {
                prev: "other".into(),
                ..base.clone()
            },
            Frame {
                ingested_at: "2026-08-07T12:00:00.001Z".into(),
                ..base.clone()
            },
            Frame {
                wall_clock_anomaly: true,
                ..base.clone()
            },
            Frame {
                kind: "vault.delete".into(),
                ..base.clone()
            },
            Frame {
                body: serde_json::json!({"path": "b.md"}),
                ..base.clone()
            },
        ];
        for variant in variants {
            assert_ne!(
                variant.compute_hash().unwrap(),
                base.hash,
                "a changed field must change the hash: {variant:?}"
            );
        }
    }

    #[test]
    fn from_line_refuses_unknown_fields_and_versions() {
        let frame = fixture(1, "anchor", "vault.write", serde_json::json!({}));
        let line = frame.to_line().unwrap();
        // An extra envelope field would be dropped on re-serialization and
        // could never verify — refuse it at the door. (This is also the
        // no-version-field-in-the-envelope tripwire: `version` is an
        // unknown field here by construction.)
        let with_extra = line.replacen("{\"v\":0,", "{\"v\":0,\"version\":9,", 1);
        assert!(Frame::from_line(&with_extra).is_err());
        let v1 = line.replacen("{\"v\":0,", "{\"v\":1,", 1);
        assert!(Frame::from_line(&v1).is_err());
    }

    #[test]
    fn verify_chain_accepts_a_valid_chain_and_names_each_break() {
        let frames = chain("store-id", 3);
        verify_chain(&frames, "store-id", 1).unwrap();
        // Wrong anchor.
        assert!(verify_chain(&frames, "other-store", 1).is_err());
        // Wrong starting seq.
        assert!(verify_chain(&frames, "store-id", 2).is_err());
        // A re-linked but un-rehashed middle record.
        let mut relinked = frames.clone();
        relinked[1].prev = "spliced".into();
        assert!(verify_chain(&relinked, "store-id", 1).is_err());
        // A record whose body was edited after hashing.
        let mut edited = frames.clone();
        edited[2].body = serde_json::json!({"path": "items/evil.md"});
        assert!(verify_chain(&edited, "store-id", 1).is_err());
        // A dropped middle record (seq gap + broken link).
        let mut gapped = frames.clone();
        gapped.remove(1);
        assert!(verify_chain(&gapped, "store-id", 1).is_err());
    }
}
