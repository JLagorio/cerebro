//! The single-writer append API (M21.3) and its M22.2 idempotent/logical
//! extensions.
//!
//! PUBLIC-SURFACE TRIPWIRE (code-review check): this module exposes
//! `LedgerWriter::{open, append, append_once, append_batch, head}`,
//! `Committed`, `ExistingOrCommitted`, `BatchReceipt`, `member_ref`,
//! `existing_writer_id`, and `writer_id` — and nothing else. No update, no
//! delete, no open-sealed-for-write exists here or anywhere. Appending is
//! the only way in-app state reaches the ledger, and only this module can
//! append (D3: enforced by construction).
//!
//! The acknowledgement rule (M21 rule one), verbatim:
//!
//! ```text
//! write frame → flush userspace buffers → fsync open segment
//! → only then return committed {event_id, seq} to the caller
//! ```
//!
//! Sealing is a SEPARATE operation (rotation) and is never the transaction
//! boundary. For a logical batch (M22.2) the SAME rule holds once, at the
//! marker: members are written contiguously unacknowledged, the
//! `batch.committed` marker follows, ONE fsync runs through the marker, and
//! only then does the receipt exist. A durable member prefix without its
//! marker is recovery history with zero entity-state effect.
//!
//! Idempotency (M22.2): `append_once` and `append_batch` replay against
//! VERIFIED COMMITTED FRAMES — the maps are rebuilt from segments at open,
//! never trusted from SQLite (the index is disposable). One door per
//! semantics: a schema-v1 body carrying an idempotency key is refused by
//! plain `append`; orphaned batch members never claim their keys.

use std::path::{Path, PathBuf};

use super::frame::{Frame, FRAME_VERSION};
use super::segment::{self, SegmentName, SegmentWriter, Tail};
use super::{ledger_dir, members_digest, new_id128, schema, sha256_hex, store};

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

/// What `append_once` found: the identical event already committed under
/// this key, or a fresh commit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExistingOrCommitted {
    Existing(Committed),
    Committed(Committed),
}

impl ExistingOrCommitted {
    pub fn committed(&self) -> &Committed {
        match self {
            ExistingOrCommitted::Existing(c) | ExistingOrCommitted::Committed(c) => c,
        }
    }

    pub fn was_existing(&self) -> bool {
        matches!(self, ExistingOrCommitted::Existing(_))
    }
}

/// The acknowledgement of a whole logical batch — members in order, then
/// the marker that made them reducer-visible.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BatchReceipt {
    pub batch_id: String,
    pub members: Vec<Committed>,
    pub marker: Committed,
    /// True when this receipt replays an already committed operation key.
    pub replayed: bool,
}

/// A same-batch reference for `append_batch` bodies: member event ids do
/// not exist before preallocation, so callers reference members by ordinal
/// and the writer substitutes the allocated ids. The SYMBOLIC form is what
/// the operation digest hashes — stable across retries whose physical ids
/// differ.
pub fn member_ref(ordinal: usize) -> String {
    format!("{MEMBER_REF_PREFIX}{ordinal}")
}

const MEMBER_REF_PREFIX: &str = "cerebro-batch-member:";

/// An idempotency key claimed by a committed solo event or batch member.
#[derive(Debug, Clone)]
struct ClaimedKey {
    committed: Committed,
    /// SHA-256 over kind + canonical body — the "identical content" test.
    content_hash: String,
}

/// An operation key claimed by a committed batch marker.
#[derive(Debug, Clone)]
struct ClaimedOp {
    operation_digest: String,
    receipt: BatchReceipt,
}

/// Read the writer identity WITHOUT minting — for read-only diagnostics
/// (`ledger_status` must not leave an id behind as a side effect).
pub fn existing_writer_id(config_dir: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(config_dir.join(WRITER_ID_FILE)).ok()?;
    let id = raw.trim();
    segment::is_hex128(id).then(|| id.to_string())
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
    /// Seq of the newest committed record — with the chain hash, the head
    /// that shadow mode remembers into the index after each append.
    head_seq: Option<u64>,
    /// The store identity — schema-v1 structural validation pins ids to it.
    store_id: String,
    /// Idempotency keys claimed by committed frames, rebuilt from verified
    /// segments at open (never from the disposable index).
    keys: std::collections::BTreeMap<String, ClaimedKey>,
    /// Operation keys claimed by committed batch markers.
    operations: std::collections::BTreeMap<String, ClaimedOp>,
}

impl LedgerWriter {
    pub fn open(vault: &Path, writer_id: &str) -> Result<LedgerWriter, String> {
        Self::open_with_limit(vault, writer_id, SEGMENT_MAX_RECORDS)
    }

    fn open_with_limit(vault: &Path, writer_id: &str, limit: u64) -> Result<LedgerWriter, String> {
        let dir = ledger_dir(vault);
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let lock = acquire_lock(&dir)?;
        // Mint the identity when the ledger is new; classify reloads it.
        store::load_or_mint(&dir)?;

        // One classification authority (M21.4): the writer proceeds only on
        // the verdicts whose recovery actions it owns; every other state —
        // corruption, gaps, forks, a foreign writer's or wiped-app-data
        // ledger — is refused with the verdict's own words, never guessed
        // around. (No remembered head here: that arrives with the M21.5
        // index, wired at startup in M21.8.)
        let recovery = super::recovery::classify(&dir, Some(writer_id), None);
        match recovery.verdict {
            super::recovery::Verdict::Valid
            | super::recovery::Verdict::TornTail { .. }
            | super::recovery::Verdict::SealPending => {}
            verdict => return Err(verdict.to_string()),
        }
        let read = recovery
            .read
            .ok_or("a recoverable verdict without a readable prefix")?;

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

        let (keys, operations) = rebuild_idempotency(&read.frames);
        Ok(LedgerWriter {
            _lock: lock,
            dir,
            writer_id: writer_id.to_string(),
            segment: Some(segment),
            prev_wall_clock: read.frames.last().map(|f| f.ingested_at.clone()),
            segment_limit: limit.max(1),
            head_seq: read.head_seq,
            store_id: read.store.store_id.clone(),
            keys,
            operations,
        })
    }

    /// The store identity this writer appends into.
    pub fn store_id(&self) -> &str {
        &self.store_id
    }

    /// The committed head as this writer knows it — no disk read.
    pub fn head(&self) -> Option<super::LedgerHead> {
        self.segment.as_ref().map(|segment| super::LedgerHead {
            seq: self.head_seq,
            hash: segment.last_hash().to_string(),
        })
    }

    /// Write one frame into the open segment WITHOUT syncing — the shared
    /// core of `append` (which syncs immediately) and `append_batch` (which
    /// syncs once, through the marker).
    fn write_frame(
        &mut self,
        kind: &str,
        body: serde_json::Value,
        event_id: Option<String>,
    ) -> Result<Frame, String> {
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
            event_id: event_id.unwrap_or_else(new_id128),
            prev: segment.last_hash().to_string(),
            hash: String::new(),
            ingested_at: now.clone(),
            wall_clock_anomaly: anomaly,
            kind: kind.to_string(),
            body,
        }
        .with_hash()?;
        segment.append(&frame)?;
        self.prev_wall_clock = Some(now);
        self.head_seq = Some(frame.seq);
        Ok(frame)
    }

    fn sync(&self) -> Result<(), String> {
        self.segment
            .as_ref()
            .ok_or("ledger writer fail-stopped after a failed rotation")?
            .sync()
    }

    /// Append one event. Returns only after the frame is durably on disk —
    /// an event that was never acknowledged may be lost by a crash; an
    /// acknowledged one may not. The caller-retry consequence is documented,
    /// not hidden: a caller that dies between fsync and receiving `Committed`
    /// and then retries writes a SECOND event — WHICH is why a schema-v1
    /// body carrying an idempotency key is refused here: keyed appends go
    /// through `append_once`/`append_batch`, the doors that replay instead.
    pub fn append(&mut self, kind: &str, body: serde_json::Value) -> Result<Committed, String> {
        if let Ok(Some(decoded)) = schema::decode_body(kind, &body) {
            if decoded.idempotency_key().is_some() {
                return Err(
                    "a schema-v1 body with an idempotency key goes through append_once or \
                     append_batch, never plain append"
                        .to_string(),
                );
            }
            if decoded.batch_id().is_some() {
                return Err(
                    "a schema-v1 body with a batch id is a batch member — use append_batch"
                        .to_string(),
                );
            }
        }
        // The acknowledgement rule. `write_all` on a raw File leaves no
        // userspace buffer to flush; sync_all is F_FULLFSYNC on Apple (see
        // the module doc in mod.rs).
        let frame = self.write_frame(kind, body, None)?;
        crate::crash::crash_point("ledger-frame-written");
        self.sync()?;
        crate::crash::crash_point("ledger-frame-synced");
        Ok(Committed {
            event_id: frame.event_id,
            seq: frame.seq,
        })
    }

    /// Append exactly once under a producer-scoped key. The identical
    /// key/kind/canonical body returns the existing receipt; the same key
    /// with different canonical content is a hard conflict, never a silent
    /// dedupe. The claim set is rebuilt from verified committed frames at
    /// open — index loss cannot cause a duplicate.
    pub fn append_once(
        &mut self,
        key: &str,
        kind: &str,
        body: serde_json::Value,
    ) -> Result<ExistingOrCommitted, String> {
        if key.is_empty() {
            return Err("append_once requires a non-empty idempotency key".to_string());
        }
        let mut body = body;
        let object = body
            .as_object_mut()
            .ok_or("append_once requires a schema-v1 body")?;
        object.insert("idempotency_key".to_string(), serde_json::json!(key));
        let decoded = schema::decode_body(kind, &body)?
            .ok_or("append_once requires a schema-v1 body — plumbing has no keys")?;
        if decoded.batch_id().is_some() {
            return Err(
                "append_once appends solo events — batch members carry no key of their \
                        own door"
                    .to_string(),
            );
        }
        decoded.validate(&self.store_id)?;
        let hash = content_hash(kind, &body)?;
        if let Some(claimed) = self.keys.get(key) {
            if claimed.content_hash == hash {
                return Ok(ExistingOrCommitted::Existing(claimed.committed.clone()));
            }
            return Err(format!(
                "idempotency key {key:?} is already committed with different canonical content — \
                 hard conflict, never a silent dedupe"
            ));
        }
        if self.operations.contains_key(key) {
            return Err(format!(
                "idempotency key {key:?} already names a committed batch operation"
            ));
        }
        let frame = self.write_frame(kind, body, None)?;
        crate::crash::crash_point("ledger-frame-written");
        self.sync()?;
        crate::crash::crash_point("ledger-frame-synced");
        let committed = Committed {
            event_id: frame.event_id,
            seq: frame.seq,
        };
        self.keys.insert(
            key.to_string(),
            ClaimedKey {
                committed: committed.clone(),
                content_hash: hash,
            },
        );
        Ok(ExistingOrCommitted::Committed(committed))
    }

    /// Append a logical batch: preallocate ids, stamp members, append them
    /// contiguously, append the `batch.committed` marker, fsync THROUGH the
    /// marker, and only then acknowledge. Any structurally invalid member
    /// refuses the whole batch before a byte is written. Same-batch
    /// references are `member_ref(ordinal)` placeholders in the submitted
    /// bodies; the digest of that symbolic plan is what an operation-key
    /// retry is checked against, so a retry with fresh physical ids still
    /// replays.
    pub fn append_batch(
        &mut self,
        events: Vec<(String, serde_json::Value)>,
        operation_key: Option<&str>,
    ) -> Result<BatchReceipt, String> {
        if events.is_empty() {
            return Err("a batch with no members is not a batch".to_string());
        }
        let op_digest = operation_digest(&events)?;
        if let Some(key) = operation_key {
            if key.is_empty() {
                return Err("operation key must be non-empty when supplied".to_string());
            }
            if let Some(claimed) = self.operations.get(key) {
                if claimed.operation_digest == op_digest {
                    let mut receipt = claimed.receipt.clone();
                    receipt.replayed = true;
                    return Ok(receipt);
                }
                return Err(format!(
                    "operation key {key:?} is already committed with a different logical plan — \
                     idempotency conflict, never a silent dedupe"
                ));
            }
            if self.keys.contains_key(key) {
                return Err(format!(
                    "operation key {key:?} already names a committed solo event"
                ));
            }
        }

        // Preallocate one fresh batch id and every member event id, then
        // stamp and validate every member BEFORE any disk write.
        let batch_id = new_id128();
        let member_ids: Vec<String> = events.iter().map(|_| new_id128()).collect();
        let mut stamped: Vec<(String, serde_json::Value)> = Vec::with_capacity(events.len());
        for (ordinal, (kind, body)) in events.into_iter().enumerate() {
            if kind == schema::KIND_BATCH_COMMITTED {
                return Err("a batch marker cannot be a batch member".to_string());
            }
            let mut body = body;
            substitute_member_refs(&mut body, &member_ids)?;
            let object = body
                .as_object_mut()
                .ok_or("batch members must be schema-v1 bodies")?;
            object.insert("batch_id".to_string(), serde_json::json!(batch_id));
            // A member that ARRIVES keyed keeps its own key (M23.5: a staged
            // source registration rides its `source-register-v1:` key, so
            // the same registration is idempotent whether it commits
            // standalone or as a batch member). An already-claimed member
            // key is a hard conflict here — the caller should not have
            // staged it — never a silent dedupe.
            let member_key = match object.get("idempotency_key").and_then(|v| v.as_str()) {
                Some(own) => {
                    if self.keys.contains_key(own) || self.operations.contains_key(own) {
                        return Err(format!(
                            "batch member {ordinal} carries idempotency key {own:?}, which is \
                             already committed — stage only what does not exist"
                        ));
                    }
                    Some(own.to_string())
                }
                None => operation_key.map(|key| format!("{key}#m{ordinal}")),
            };
            object.insert("idempotency_key".to_string(), serde_json::json!(member_key));
            let decoded = schema::decode_body(&kind, &body)
                .map_err(|e| format!("batch member {ordinal}: {e}"))?
                .ok_or_else(|| {
                    format!(
                        "batch member {ordinal} is not a schema-v1 body — plumbing does not batch"
                    )
                })?;
            decoded
                .validate(&self.store_id)
                .map_err(|e| format!("batch member {ordinal}: {e}"))?;
            stamped.push((kind, body));
        }

        // Append members contiguously, unacknowledged.
        let mut member_frames: Vec<Frame> = Vec::with_capacity(stamped.len());
        for (ordinal, (kind, body)) in stamped.into_iter().enumerate() {
            let frame = self.write_frame(&kind, body, Some(member_ids[ordinal].clone()))?;
            crate::crash::crash_point(&format!("ledger-batch-member-{ordinal}-written"));
            member_frames.push(frame);
        }

        // The marker, then ONE fsync through it — the transaction boundary.
        let marker_body = schema::BatchCommitted {
            schema: schema::BODY_SCHEMA,
            batch_id: Some(batch_id.clone()),
            idempotency_key: operation_key.map(str::to_string),
            actor: schema::Actor {
                id: schema::ACTOR_LEDGER.to_string(),
            },
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            member_event_ids: member_ids.clone(),
            member_count: member_ids.len() as u64,
            members_digest: members_digest(member_frames.iter())?,
            operation_digest: op_digest.clone(),
        };
        marker_body.validate()?;
        let marker_frame = self.write_frame(
            schema::KIND_BATCH_COMMITTED,
            serde_json::to_value(&marker_body).map_err(|e| e.to_string())?,
            None,
        )?;
        crate::crash::crash_point("ledger-batch-marker-written");
        self.sync()?;
        crate::crash::crash_point("ledger-batch-synced");

        let receipt = BatchReceipt {
            batch_id,
            members: member_frames
                .iter()
                .map(|f| Committed {
                    event_id: f.event_id.clone(),
                    seq: f.seq,
                })
                .collect(),
            marker: Committed {
                event_id: marker_frame.event_id.clone(),
                seq: marker_frame.seq,
            },
            replayed: false,
        };
        // The batch is committed: members claim their keys now (an orphaned
        // attempt never reaches this line).
        for frame in &member_frames {
            if let Ok(Some(decoded)) = schema::decode_body(&frame.kind, &frame.body) {
                if let Some(member_key) = decoded.idempotency_key() {
                    self.keys.insert(
                        member_key.to_string(),
                        ClaimedKey {
                            committed: Committed {
                                event_id: frame.event_id.clone(),
                                seq: frame.seq,
                            },
                            content_hash: content_hash(&frame.kind, &frame.body)?,
                        },
                    );
                }
            }
        }
        if let Some(key) = operation_key {
            self.operations.insert(
                key.to_string(),
                ClaimedOp {
                    operation_digest: op_digest,
                    receipt: receipt.clone(),
                },
            );
        }
        Ok(receipt)
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

/// The "identical content" test for idempotent replay: SHA-256 over the
/// kind and the canonical body bytes.
fn content_hash(kind: &str, body: &serde_json::Value) -> Result<String, String> {
    let canonical = serde_json::to_string(body).map_err(|e| e.to_string())?;
    let mut bytes = Vec::with_capacity(kind.len() + 1 + canonical.len());
    bytes.extend_from_slice(kind.as_bytes());
    bytes.push(0);
    bytes.extend_from_slice(canonical.as_bytes());
    Ok(sha256_hex(&bytes))
}

/// SHA-256 over the canonical JSON of the SYMBOLIC member plan — bodies as
/// submitted: batch id unstamped, member refs still ordinals. Stable across
/// a retry that receives fresh physical ids, which is the whole point.
fn operation_digest(events: &[(String, serde_json::Value)]) -> Result<String, String> {
    let plan: Vec<serde_json::Value> = events
        .iter()
        .map(|(kind, body)| serde_json::json!({ "kind": kind, "body": body }))
        .collect();
    let canonical = serde_json::to_string(&plan).map_err(|e| e.to_string())?;
    Ok(sha256_hex(canonical.as_bytes()))
}

/// Replace every `member_ref(ordinal)` placeholder string with the
/// allocated member event id, recursively.
fn substitute_member_refs(
    value: &mut serde_json::Value,
    member_ids: &[String],
) -> Result<(), String> {
    match value {
        serde_json::Value::String(s) => {
            if let Some(rest) = s.strip_prefix(MEMBER_REF_PREFIX) {
                let ordinal: usize = rest
                    .parse()
                    .map_err(|_| format!("malformed member ref {s:?}"))?;
                let id = member_ids
                    .get(ordinal)
                    .ok_or(format!("member ref {ordinal} is out of range"))?;
                *s = id.clone();
            }
            Ok(())
        }
        serde_json::Value::Array(items) => items
            .iter_mut()
            .try_for_each(|item| substitute_member_refs(item, member_ids)),
        serde_json::Value::Object(object) => object
            .values_mut()
            .try_for_each(|item| substitute_member_refs(item, member_ids)),
        _ => Ok(()),
    }
}

/// Rebuild the idempotency claim maps from verified committed frames. Solo
/// schema-v1 events claim their key directly; batch members claim theirs
/// ONLY when a valid marker proves their batch (an orphaned attempt does
/// not claim the key, so its retry appends under a fresh batch id); a valid
/// marker claims its operation key with a replayable receipt.
fn rebuild_idempotency(
    frames: &[Frame],
) -> (
    std::collections::BTreeMap<String, ClaimedKey>,
    std::collections::BTreeMap<String, ClaimedOp>,
) {
    let mut keys = std::collections::BTreeMap::new();
    let mut operations = std::collections::BTreeMap::new();
    let mut members_by_batch: std::collections::BTreeMap<String, Vec<&Frame>> =
        std::collections::BTreeMap::new();
    let mut markers: Vec<(&Frame, schema::BatchCommitted)> = Vec::new();

    for frame in frames {
        let Ok(Some(decoded)) = schema::decode_body(&frame.kind, &frame.body) else {
            continue; // plumbing or malformed: never claims a key
        };
        match (decoded.batch_id(), &decoded) {
            (Some(_), schema::EventBody::BatchCommitted(marker)) => {
                markers.push((frame, (**marker).clone()));
            }
            (Some(batch_id), _) => {
                members_by_batch
                    .entry(batch_id.to_string())
                    .or_default()
                    .push(frame);
            }
            (None, _) => {
                if let Some(key) = decoded.idempotency_key() {
                    if let Ok(hash) = content_hash(&frame.kind, &frame.body) {
                        keys.insert(
                            key.to_string(),
                            ClaimedKey {
                                committed: Committed {
                                    event_id: frame.event_id.clone(),
                                    seq: frame.seq,
                                },
                                content_hash: hash,
                            },
                        );
                    }
                }
            }
        }
    }

    let empty: Vec<&Frame> = Vec::new();
    for (marker_frame, marker) in markers {
        let batch_id = match &marker.batch_id {
            Some(id) => id,
            None => continue,
        };
        let members = members_by_batch.get(batch_id).unwrap_or(&empty);
        let ids_match = members.len() == marker.member_event_ids.len()
            && members
                .iter()
                .zip(&marker.member_event_ids)
                .all(|(frame, id)| &frame.event_id == id);
        let contiguous = members
            .windows(2)
            .all(|pair| pair[1].seq == pair[0].seq + 1)
            && members
                .last()
                .is_some_and(|last| last.seq + 1 == marker_frame.seq);
        let digest_ok = members_digest(members.iter().copied())
            .is_ok_and(|digest| digest == marker.members_digest);
        if !(ids_match && contiguous && digest_ok) {
            continue; // the reducer names this anomaly; nothing claims here
        }
        for frame in members {
            let Ok(Some(decoded)) = schema::decode_body(&frame.kind, &frame.body) else {
                continue;
            };
            if let Some(key) = decoded.idempotency_key() {
                if let Ok(hash) = content_hash(&frame.kind, &frame.body) {
                    keys.insert(
                        key.to_string(),
                        ClaimedKey {
                            committed: Committed {
                                event_id: frame.event_id.clone(),
                                seq: frame.seq,
                            },
                            content_hash: hash,
                        },
                    );
                }
            }
        }
        if let Some(op_key) = &marker.idempotency_key {
            operations.insert(
                op_key.clone(),
                ClaimedOp {
                    operation_digest: marker.operation_digest.clone(),
                    receipt: BatchReceipt {
                        batch_id: batch_id.clone(),
                        members: members
                            .iter()
                            .map(|frame| Committed {
                                event_id: frame.event_id.clone(),
                                seq: frame.seq,
                            })
                            .collect(),
                        marker: Committed {
                            event_id: marker_frame.event_id.clone(),
                            seq: marker_frame.seq,
                        },
                        replayed: false,
                    },
                },
            );
        }
    }
    (keys, operations)
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
    use super::super::read_ledger;
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

    // --- M22.2: append_once + logical batches -------------------------------

    use crate::ledger::schema::{self as schema_mod, tests as schema_tests};

    /// A snapshot observation body as a `(kind, body)` pair for batching.
    fn observation_member() -> (String, serde_json::Value) {
        let body = schema_tests::observation_recorded(schema_mod::ObservationKind::SourceSnapshot);
        (
            schema_mod::KIND_OBSERVATION_RECORDED.to_string(),
            serde_json::to_value(&body).unwrap(),
        )
    }

    /// A belief.created body whose basis links MEMBER 0 symbolically.
    fn belief_member_referencing(ordinal: usize) -> (String, serde_json::Value) {
        let mut belief = schema_tests::belief_created();
        belief.basis = schema_mod::BeliefBasis::Linked {
            links: vec![schema_mod::BasisLink {
                observation_event_id: member_ref(ordinal),
                role: schema_mod::BasisRole::Supports,
            }],
        };
        (
            schema_mod::KIND_BELIEF_CREATED.to_string(),
            serde_json::to_value(&belief).unwrap(),
        )
    }

    fn solo_belief_body() -> serde_json::Value {
        serde_json::to_value(schema_tests::belief_created()).unwrap()
    }

    #[test]
    fn append_once_appends_replays_and_conflicts() {
        let vault = testutil::temp_vault("writer-once");
        let mut writer = LedgerWriter::open(&vault, WRITER).unwrap();
        let first = writer
            .append_once(
                "op:create-acme",
                schema_mod::KIND_BELIEF_CREATED,
                solo_belief_body(),
            )
            .unwrap();
        assert!(!first.was_existing());

        // Identical key/kind/body: the existing receipt, no second event.
        let replay = writer
            .append_once(
                "op:create-acme",
                schema_mod::KIND_BELIEF_CREATED,
                solo_belief_body(),
            )
            .unwrap();
        assert!(replay.was_existing());
        assert_eq!(replay.committed(), first.committed());

        // Same key, different canonical content: hard conflict.
        let mut different = schema_tests::belief_created();
        different.content = "# Acme\n\nChanged.\n".into();
        let err = writer
            .append_once(
                "op:create-acme",
                schema_mod::KIND_BELIEF_CREATED,
                serde_json::to_value(&different).unwrap(),
            )
            .unwrap_err();
        assert!(err.contains("conflict"), "{err}");

        let read = read_ledger(&ledger_dir(&vault)).unwrap();
        assert_eq!(read.records, 1, "one event, however many calls");
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn append_once_replays_from_verified_frames_across_reopen() {
        let vault = testutil::temp_vault("writer-once-reopen");
        let mut writer = LedgerWriter::open(&vault, WRITER).unwrap();
        let first = writer
            .append_once(
                "op:create-acme",
                schema_mod::KIND_BELIEF_CREATED,
                solo_belief_body(),
            )
            .unwrap();
        drop(writer);
        // A fresh writer rebuilds the claim set from segments — the lost-ack
        // retry returns the existing receipt instead of duplicating.
        let mut writer = LedgerWriter::open(&vault, WRITER).unwrap();
        let replay = writer
            .append_once(
                "op:create-acme",
                schema_mod::KIND_BELIEF_CREATED,
                solo_belief_body(),
            )
            .unwrap();
        assert!(replay.was_existing());
        assert_eq!(replay.committed(), first.committed());
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn plain_append_refuses_keyed_or_batched_schema_bodies() {
        let vault = testutil::temp_vault("writer-one-door");
        let mut writer = LedgerWriter::open(&vault, WRITER).unwrap();
        let mut keyed = solo_belief_body();
        keyed["idempotency_key"] = serde_json::json!("op:sneaky");
        assert!(writer
            .append(schema_mod::KIND_BELIEF_CREATED, keyed)
            .unwrap_err()
            .contains("append_once"));
        let mut batched = solo_belief_body();
        batched["batch_id"] = serde_json::json!("beefbeefbeefbeefbeefbeefbeefbeef");
        assert!(writer
            .append(schema_mod::KIND_BELIEF_CREATED, batched)
            .unwrap_err()
            .contains("append_batch"));
        // Unkeyed schema bodies and plumbing still go through.
        writer
            .append(schema_mod::KIND_BELIEF_CREATED, solo_belief_body())
            .unwrap();
        writer.append("vault.write", body("a.md")).unwrap();
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn a_batch_commits_members_marker_and_symbolic_refs() {
        let vault = testutil::temp_vault("writer-batch");
        let mut writer = LedgerWriter::open(&vault, WRITER).unwrap();
        let receipt = writer
            .append_batch(
                vec![observation_member(), belief_member_referencing(0)],
                Some("op:capture-1"),
            )
            .unwrap();
        assert!(!receipt.replayed);
        assert_eq!(receipt.members.len(), 2);
        assert_eq!(receipt.members[0].seq + 1, receipt.members[1].seq);
        assert_eq!(receipt.members[1].seq + 1, receipt.marker.seq);

        let read = read_ledger(&ledger_dir(&vault)).unwrap();
        assert_eq!(read.records, 3);
        let member0 = &read.frames[0];
        let member1 = &read.frames[1];
        let marker = &read.frames[2];
        // Members are stamped with the shared batch id and derived keys.
        assert_eq!(
            member0.body["batch_id"],
            serde_json::json!(receipt.batch_id)
        );
        assert_eq!(
            member0.body["idempotency_key"],
            serde_json::json!("op:capture-1#m0")
        );
        // The symbolic basis ref became member 0's REAL event id.
        assert_eq!(
            member1.body["basis"]["links"][0]["observation_event_id"],
            serde_json::json!(receipt.members[0].event_id)
        );
        // The marker names the exact ordered members and verifies.
        let decoded = schema_mod::decode_body(&marker.kind, &marker.body)
            .unwrap()
            .unwrap();
        let schema_mod::EventBody::BatchCommitted(marker_body) = decoded else {
            panic!("marker decodes as batch.committed");
        };
        assert_eq!(
            marker_body.member_event_ids,
            vec![
                receipt.members[0].event_id.clone(),
                receipt.members[1].event_id.clone()
            ]
        );
        assert_eq!(
            marker_body.members_digest,
            members_digest([member0, member1].into_iter()).unwrap()
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn a_batch_retry_replays_by_operation_key_and_refuses_a_different_plan() {
        let vault = testutil::temp_vault("writer-batch-retry");
        let mut writer = LedgerWriter::open(&vault, WRITER).unwrap();
        let events = || vec![observation_member(), belief_member_referencing(0)];
        let receipt = writer.append_batch(events(), Some("op:capture-1")).unwrap();

        // Same plan, same key: the prior receipt, marked replayed.
        let replay = writer.append_batch(events(), Some("op:capture-1")).unwrap();
        assert!(replay.replayed);
        assert_eq!(replay.batch_id, receipt.batch_id);
        assert_eq!(replay.members, receipt.members);

        // ...and across a reopen (rebuilt from verified frames).
        drop(writer);
        let mut writer = LedgerWriter::open(&vault, WRITER).unwrap();
        let replay = writer.append_batch(events(), Some("op:capture-1")).unwrap();
        assert!(replay.replayed);
        assert_eq!(replay.batch_id, receipt.batch_id);

        // A different logical plan under the committed key: conflict.
        let err = writer
            .append_batch(vec![observation_member()], Some("op:capture-1"))
            .unwrap_err();
        assert!(err.contains("conflict"), "{err}");

        let read = read_ledger(&ledger_dir(&vault)).unwrap();
        assert_eq!(read.records, 3, "one batch, however many retries");
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn one_invalid_member_refuses_the_whole_batch_before_any_write() {
        let vault = testutil::temp_vault("writer-batch-invalid");
        let mut writer = LedgerWriter::open(&vault, WRITER).unwrap();
        let mut bad = schema_tests::belief_created();
        bad.subject = schema_mod::SubjectRef::None; // structurally invalid
        let err = writer
            .append_batch(
                vec![
                    observation_member(),
                    (
                        schema_mod::KIND_BELIEF_CREATED.to_string(),
                        serde_json::to_value(&bad).unwrap(),
                    ),
                ],
                Some("op:bad"),
            )
            .unwrap_err();
        assert!(err.contains("batch member 1"), "{err}");
        let read = read_ledger(&ledger_dir(&vault)).unwrap();
        assert_eq!(read.records, 0, "zero bytes written for a refused batch");
        // The key was never claimed: a corrected batch commits under it.
        writer
            .append_batch(vec![observation_member()], Some("op:bad"))
            .unwrap();
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn a_truncated_marker_leaves_an_orphan_that_claims_nothing() {
        let vault = testutil::temp_vault("writer-batch-orphan");
        let mut writer = LedgerWriter::open(&vault, WRITER).unwrap();
        let receipt = writer
            .append_batch(
                vec![observation_member(), belief_member_referencing(0)],
                Some("op:capture-1"),
            )
            .unwrap();
        drop(writer);

        // Tear the MARKER off the open segment: members survive, commit
        // proof does not.
        let dir = ledger_dir(&vault);
        let read = read_ledger(&dir).unwrap();
        let open_path = dir.join(read.segments.last().unwrap().file_name());
        let bytes = std::fs::read(&open_path).unwrap();
        let marker_line_start = bytes[..bytes.len() - 1]
            .iter()
            .rposition(|b| *b == b'\n')
            .map(|i| i + 1)
            .unwrap();
        std::fs::write(&open_path, &bytes[..marker_line_start]).unwrap();

        // The orphan does not claim the operation key: the retry commits a
        // FRESH batch (new physical ids), leaving the orphan as history.
        let mut writer = LedgerWriter::open(&vault, WRITER).unwrap();
        let retried = writer
            .append_batch(
                vec![observation_member(), belief_member_referencing(0)],
                Some("op:capture-1"),
            )
            .unwrap();
        assert!(!retried.replayed, "an orphan is not a commitment");
        assert_ne!(retried.batch_id, receipt.batch_id);
        let read = read_ledger(&dir).unwrap();
        assert_eq!(read.records, 5, "2 orphan members + a fresh 3-frame batch");
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn a_batch_spans_segment_rotation_and_still_verifies() {
        let vault = testutil::temp_vault("writer-batch-rotate");
        let mut writer = LedgerWriter::open_with_limit(&vault, WRITER, 2).unwrap();
        writer.append("vault.write", body("seed.md")).unwrap();
        let receipt = writer
            .append_batch(
                vec![
                    observation_member(),
                    observation_member(),
                    belief_member_referencing(0),
                ],
                Some("op:span"),
            )
            .unwrap();
        drop(writer);
        let read = read_ledger(&ledger_dir(&vault)).unwrap();
        assert_eq!(read.records, 5);
        assert!(read.segments.len() >= 2, "the batch crossed a rotation");
        // Reopen replays the operation across the segment boundary.
        let mut writer = LedgerWriter::open_with_limit(&vault, WRITER, 2).unwrap();
        let replay = writer
            .append_batch(
                vec![
                    observation_member(),
                    observation_member(),
                    belief_member_referencing(0),
                ],
                Some("op:span"),
            )
            .unwrap();
        assert!(replay.replayed);
        assert_eq!(replay.batch_id, receipt.batch_id);
        let _ = std::fs::remove_dir_all(&vault);
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

    /// Child: append a two-member batch under op key "op:crash". The parent
    /// picks the kill point via CEREBRO_CRASH_POINT.
    #[test]
    #[ignore = "crash-scenario child body, spawned by the crash tests"]
    fn crash_scenario_append_batch() {
        let Ok(vault) = std::env::var("CEREBRO_CRASH_VAULT") else {
            return;
        };
        let mut writer = LedgerWriter::open(Path::new(&vault), WRITER).unwrap();
        let _ = writer.append_batch(
            vec![observation_member(), belief_member_referencing(0)],
            Some("op:crash"),
        );
    }

    /// After a kill at ANY batch boundary, the retry must converge on
    /// exactly one committed operation under the key — replayed if the
    /// marker survived, fresh if it did not — and a further retry replays.
    fn assert_batch_crash_converges(point: &str) {
        let vault = testutil::temp_vault(&format!("writer-crash-{point}"));
        // Seed so the ledger exists with the right writer id.
        let mut writer = LedgerWriter::open(&vault, WRITER).unwrap();
        writer.append("vault.write", body("seed.md")).unwrap();
        drop(writer);
        let status = testutil::run_crash_scenario(
            "ledger::writer::tests::crash_scenario_append_batch",
            point,
            &vault,
        );
        assert!(!status.success(), "{point}: child must die at the point");

        // The committed prefix is readable and appendable either way.
        let mut writer = LedgerWriter::open(&vault, WRITER).unwrap();
        let retry = writer
            .append_batch(
                vec![observation_member(), belief_member_referencing(0)],
                Some("op:crash"),
            )
            .unwrap();
        let again = writer
            .append_batch(
                vec![observation_member(), belief_member_referencing(0)],
                Some("op:crash"),
            )
            .unwrap();
        assert!(again.replayed, "{point}: the second retry always replays");
        assert_eq!(again.batch_id, retry.batch_id);
        drop(writer);

        // Exactly one VALID batch exists for the key, whatever the kill
        // left behind physically.
        let read = read_ledger(&ledger_dir(&vault)).unwrap();
        let (_, operations) = rebuild_idempotency(&read.frames);
        let claimed = operations.get("op:crash").expect("operation committed");
        assert_eq!(claimed.receipt.batch_id, retry.batch_id);
        let markers = read
            .frames
            .iter()
            .filter(|f| f.kind == schema_mod::KIND_BATCH_COMMITTED)
            .count();
        assert!(
            (1..=2).contains(&markers),
            "{point}: one marker, or a survivor plus the retry — never garbage"
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn killed_after_the_first_member_the_orphan_never_commits() {
        assert_batch_crash_converges("ledger-batch-member-0-written");
    }

    #[test]
    fn killed_after_the_second_member_the_orphan_never_commits() {
        assert_batch_crash_converges("ledger-batch-member-1-written");
    }

    #[test]
    fn killed_after_the_marker_write_before_fsync_converges() {
        assert_batch_crash_converges("ledger-batch-marker-written");
    }

    #[test]
    fn killed_after_fsync_before_ack_the_batch_is_committed_and_replays() {
        let vault = testutil::temp_vault("writer-crash-batch-acked");
        let mut writer = LedgerWriter::open(&vault, WRITER).unwrap();
        writer.append("vault.write", body("seed.md")).unwrap();
        drop(writer);
        let status = testutil::run_crash_scenario(
            "ledger::writer::tests::crash_scenario_append_batch",
            "ledger-batch-synced",
            &vault,
        );
        assert!(!status.success());
        // The acknowledgement-loss row: fsync ran, the receipt never
        // arrived — the batch IS committed, and the retry replays it.
        let read = read_ledger(&ledger_dir(&vault)).unwrap();
        assert_eq!(read.records, 4, "seed + two members + marker");
        let mut writer = LedgerWriter::open(&vault, WRITER).unwrap();
        let retry = writer
            .append_batch(
                vec![observation_member(), belief_member_referencing(0)],
                Some("op:crash"),
            )
            .unwrap();
        assert!(retry.replayed, "a lost acknowledgement is not a lost batch");
        let read = read_ledger(&ledger_dir(&vault)).unwrap();
        assert_eq!(read.records, 4, "no duplicate");
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
