//! The pure three-way F/M/R classifier (M23.2): file bytes, manifest
//! entry, and reducer-current projection compared per path. File-vs-manifest
//! alone cannot detect a ledger-ahead crash; every branch here names all
//! three authorities, and any mixed state the closed table does not prove
//! is DIVERGENCE, never guessed human intent.
//!
//! The classifier has NO timestamp input — mtime is never evidence (D4).
//! `M is an ancestor of R` is not inferred from revision numbers: the
//! current chain must contain M's generating event, and replaying the
//! reducer only through that event (its logical batch included) must
//! reproduce M's complete identity tuple.

use super::frame::Frame;
use super::manifest::{ManifestEntry, WriteState};
use super::reduce::{project_belief, reduce, ProjectionResult};
use super::schema;

/// What one path's file state contributes: content hash (None = missing)
/// and whether the bytes parse as a projection. No timestamps, ever.
#[derive(Debug, Clone, PartialEq)]
pub struct FileFact {
    pub hash: Option<String>,
    pub parses: bool,
}

impl FileFact {
    pub fn missing() -> FileFact {
        FileFact {
            hash: None,
            parses: false,
        }
    }
}

/// The classification of one path, per the CLOSED M23 table.
#[derive(Debug, Clone, PartialEq)]
pub enum PathClass {
    /// F = M = R, manifest complete: nothing to do.
    Match,
    /// Pending entry, M = R, file is the previous bytes or missing:
    /// our own write died before the file landed — regenerate.
    InterruptedWrite,
    /// Pending entry, M = R, file is the target bytes: our own write died
    /// before the finalize — mark the entry complete.
    InterruptedFinalize,
    /// M = R complete, valid file differs: a genuine out-of-band edit,
    /// owned by capture.
    OutOfBandEdit,
    /// Verified-ancestor manifest, file still matches it: the ledger moved
    /// ahead — regenerate the projection, ZERO capture.
    LedgerAheadRegenerate,
    /// Verified-ancestor manifest, file already matches the reducer: only
    /// the manifest lags — advance it, ZERO capture.
    LedgerAheadAdvance,
    /// The reducer holds a Belief with no entry and no file: create the
    /// projection.
    LedgerAheadCreate,
    /// Everything the table does not prove.
    Divergence(&'static str),
}

/// The one classification function. `manifest_is_ancestor` is the
/// verified-prefix replay result (`verified_ancestor`), false whenever the
/// entry or the reducer state is absent.
pub fn classify_path(
    file: &FileFact,
    entry: Option<&ManifestEntry>,
    reducer: Option<&ProjectionResult>,
    manifest_is_ancestor: bool,
) -> PathClass {
    let (entry, reducer) = match (entry, reducer) {
        (None, None) => {
            // A knowledge file neither the manifest nor the ledger can
            // explain (or a phantom path with neither file nor state).
            return PathClass::Divergence("path is unknown to both manifest and reducer");
        }
        (None, Some(_)) => {
            return if file.hash.is_none() {
                PathClass::LedgerAheadCreate
            } else {
                PathClass::Divergence("a file exists for reducer state the manifest never recorded")
            };
        }
        (Some(_), None) => {
            return PathClass::Divergence("manifest entry names missing reducer state");
        }
        (Some(entry), Some(reducer)) => (entry, reducer),
    };

    let manifest_equals_reducer = entry.belief_id == reducer.belief_id
        && entry.projected_revision == reducer.projected_revision
        && entry.belief_revision_event == reducer.belief_revision_event
        && entry.generating_event == reducer.generating_event
        && entry.projection_state_digest == reducer.projection_state_digest
        && entry.content_hash == reducer.content_hash;

    match entry.write_state {
        WriteState::Pending if manifest_equals_reducer => {
            if file.hash.as_deref() == Some(entry.content_hash.as_str()) {
                PathClass::InterruptedFinalize
            } else if file.hash.is_none() || file.hash == entry.previous_content_hash {
                PathClass::InterruptedWrite
            } else {
                PathClass::Divergence("pending entry with a file that is neither prior nor target")
            }
        }
        WriteState::Pending => {
            // The ledger moved past an interrupted write. Regenerating
            // overwrites whatever the torn write left — safe with zero
            // capture — but only over a PROVEN ancestor.
            if manifest_is_ancestor {
                PathClass::LedgerAheadRegenerate
            } else {
                PathClass::Divergence("pending entry pins non-ancestor reducer state")
            }
        }
        WriteState::Complete if manifest_equals_reducer => match &file.hash {
            Some(hash) if hash == &entry.content_hash => PathClass::Match,
            Some(_) if file.parses => PathClass::OutOfBandEdit,
            Some(_) => PathClass::Divergence("out-of-band bytes do not parse as a projection"),
            None => PathClass::Divergence("a complete projection file disappeared out of band"),
        },
        WriteState::Complete => {
            if !manifest_is_ancestor {
                return PathClass::Divergence("manifest pins non-ancestor reducer state");
            }
            match &file.hash {
                Some(hash) if hash == &entry.content_hash => PathClass::LedgerAheadRegenerate,
                Some(hash) if hash == &reducer.content_hash => PathClass::LedgerAheadAdvance,
                _ => PathClass::Divergence(
                    "the ledger moved ahead AND the file changed — nothing proves whose bytes \
                     these are",
                ),
            }
        }
    }
}

/// `M is an ancestor of R`, by verified-prefix replay: the current chain
/// must contain the entry's generating event, and reducing only through it
/// (extending through its logical batch marker, since a batch member has no
/// effect before its marker) must reproduce the entry's COMPLETE identity
/// tuple. Revision-number comparison alone is insufficient.
pub fn verified_ancestor(frames: &[Frame], store_id: &str, entry: &ManifestEntry) -> bool {
    let Some(index) = frames
        .iter()
        .position(|f| f.event_id == entry.generating_event)
    else {
        return false;
    };
    let mut end = index;
    let frame = &frames[index];
    let batch_id = frame.body.get("batch_id").and_then(|v| v.as_str());
    if let Some(batch_id) = batch_id {
        if frame.kind != schema::KIND_BATCH_COMMITTED {
            let Some(marker) = frames.iter().skip(index).position(|f| {
                f.kind == schema::KIND_BATCH_COMMITTED
                    && f.body.get("batch_id").and_then(|v| v.as_str()) == Some(batch_id)
            }) else {
                return false; // an orphaned member proves nothing
            };
            end = index + marker;
        }
    }
    let prefix = reduce(&frames[..=end], store_id);
    let Ok(projection) = project_belief(&prefix, &entry.belief_id) else {
        return false;
    };
    projection.projected_revision == entry.projected_revision
        && projection.belief_revision_event == entry.belief_revision_event
        && projection.generating_event == entry.generating_event
        && projection.projection_state_digest == entry.projection_state_digest
        && projection.content_hash == entry.content_hash
}

#[cfg(test)]
mod tests {
    use super::super::migrate::tests::WRITER;
    use super::super::reduce::project_belief;
    use super::super::schema::{self, BeliefBasis, PatchOp, SubjectRef, TypedValue};
    use super::super::writer::LedgerWriter;
    use super::super::{ledger_dir, read_ledger};
    use super::*;
    use crate::vault::testutil;

    const BELIEF: &str = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    const ENTITY: &str = "cccccccccccccccccccccccccccccccc";
    const PATH: &str = "concepts/acme.md";

    fn created_body() -> schema::BeliefCreated {
        let (schema_v, actor) = schema::tests::common("agent:run-1");
        schema::BeliefCreated {
            schema: schema_v,
            batch_id: None,
            idempotency_key: None,
            actor,
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            belief_id: BELIEF.into(),
            subject: SubjectRef::Resolved {
                entity_id: ENTITY.into(),
                aliases: vec![PATH.into()],
            },
            content: "# Acme\n\nActive vendor.\n".into(),
            fields: serde_json::json!({ "status": "active" }),
            basis: BeliefBasis::Unsupported {
                reason: "classifier fixture without observations".into(),
            },
        }
    }

    fn revised_body() -> schema::BeliefRevised {
        let (schema_v, actor) = schema::tests::common("agent:run-1");
        schema::BeliefRevised {
            schema: schema_v,
            batch_id: None,
            idempotency_key: None,
            actor,
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            belief_id: BELIEF.into(),
            patch: vec![PatchOp {
                field_path: "/fields/status".into(),
                before: TypedValue::string("active"),
                after: TypedValue::string("paused"),
            }],
            basis: BeliefBasis::Unsupported {
                reason: "classifier fixture without observations".into(),
            },
        }
    }

    /// A vault whose ledger holds one projection Belief; returns the
    /// reducer projection at the creation prefix.
    fn seeded(label: &str) -> (std::path::PathBuf, ProjectionResult) {
        let vault = testutil::temp_vault(label);
        let mut writer = LedgerWriter::open(&vault, WRITER).unwrap();
        let store = writer.store_id().to_string();
        writer
            .append(
                schema::KIND_BELIEF_CREATED,
                serde_json::to_value(created_body()).unwrap(),
            )
            .unwrap();
        drop(writer);
        let read = read_ledger(&ledger_dir(&vault)).unwrap();
        let state = reduce(&read.frames, &store);
        let projection = project_belief(&state, BELIEF).unwrap();
        (vault, projection)
    }

    fn complete_entry(projection: &ProjectionResult) -> ManifestEntry {
        ManifestEntry {
            belief_id: projection.belief_id.clone(),
            projected_revision: projection.projected_revision,
            belief_revision_event: projection.belief_revision_event.clone(),
            generating_event: projection.generating_event.clone(),
            projection_state_digest: projection.projection_state_digest.clone(),
            content_hash: projection.content_hash.clone(),
            write_state: WriteState::Complete,
            previous_content_hash: None,
        }
    }

    fn file(hash: &str) -> FileFact {
        FileFact {
            hash: Some(hash.to_string()),
            parses: true,
        }
    }

    #[test]
    fn the_closed_classification_table_row_by_row() {
        let (vault, projection) = seeded("classify-table");
        let entry = complete_entry(&projection);
        let target = projection.content_hash.clone();
        let other = crate::ledger::sha256_hex(b"out of band bytes");

        // F = M = R complete → match.
        assert_eq!(
            classify_path(&file(&target), Some(&entry), Some(&projection), false),
            PathClass::Match
        );
        // pending, M = R, F prior → interrupted own write.
        let mut pending = entry.clone();
        pending.write_state = WriteState::Pending;
        pending.previous_content_hash = Some(other.clone());
        assert_eq!(
            classify_path(&file(&other), Some(&pending), Some(&projection), false),
            PathClass::InterruptedWrite
        );
        // pending, M = R, F missing → interrupted own write.
        assert_eq!(
            classify_path(
                &FileFact::missing(),
                Some(&pending),
                Some(&projection),
                false
            ),
            PathClass::InterruptedWrite
        );
        // pending, M = R, F target → interrupted finalize.
        assert_eq!(
            classify_path(&file(&target), Some(&pending), Some(&projection), false),
            PathClass::InterruptedFinalize
        );
        // pending, M = R, F unrelated → divergence.
        assert!(matches!(
            classify_path(
                &file(&crate::ledger::sha256_hex(b"third bytes")),
                Some(&pending),
                Some(&projection),
                false
            ),
            PathClass::Divergence(_)
        ));
        // M = R complete, valid F differs → out-of-band edit.
        assert_eq!(
            classify_path(&file(&other), Some(&entry), Some(&projection), false),
            PathClass::OutOfBandEdit
        );
        // ...but unparsable bytes are divergence, never adopted silently.
        assert!(matches!(
            classify_path(
                &FileFact {
                    hash: Some(other.clone()),
                    parses: false
                },
                Some(&entry),
                Some(&projection),
                false
            ),
            PathClass::Divergence(_)
        ));
        // ...and a vanished complete file is divergence.
        assert!(matches!(
            classify_path(&FileFact::missing(), Some(&entry), Some(&projection), false),
            PathClass::Divergence(_)
        ));

        // R exists; M and F absent → create.
        assert_eq!(
            classify_path(&FileFact::missing(), None, Some(&projection), false),
            PathClass::LedgerAheadCreate
        );
        // Manifest names reducer state that does not exist → divergence.
        assert!(matches!(
            classify_path(&file(&target), Some(&entry), None, false),
            PathClass::Divergence(_)
        ));
        // Unknown to everything → divergence.
        assert!(matches!(
            classify_path(&file(&other), None, None, false),
            PathClass::Divergence(_)
        ));
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn ledger_ahead_requires_a_verified_ancestor_not_a_revision_number() {
        let (vault, old_projection) = seeded("classify-ancestor");
        let old_entry = complete_entry(&old_projection);
        // The ledger moves ahead: a solo revision.
        let mut writer = LedgerWriter::open(&vault, WRITER).unwrap();
        let store = writer.store_id().to_string();
        writer
            .append(
                schema::KIND_BELIEF_REVISED,
                serde_json::to_value(revised_body()).unwrap(),
            )
            .unwrap();
        drop(writer);
        let read = read_ledger(&ledger_dir(&vault)).unwrap();
        let state = reduce(&read.frames, &store);
        let current = project_belief(&state, BELIEF).unwrap();
        assert_ne!(current.content_hash, old_entry.content_hash);

        // The prefix replay proves the old entry.
        assert!(verified_ancestor(&read.frames, &store, &old_entry));
        // F = M → regenerate; F = R → advance the manifest; both zero
        // capture.
        let ancestor = verified_ancestor(&read.frames, &store, &old_entry);
        assert_eq!(
            classify_path(
                &file(&old_entry.content_hash),
                Some(&old_entry),
                Some(&current),
                ancestor
            ),
            PathClass::LedgerAheadRegenerate
        );
        assert_eq!(
            classify_path(
                &file(&current.content_hash),
                Some(&old_entry),
                Some(&current),
                ancestor
            ),
            PathClass::LedgerAheadAdvance
        );
        // Ledger ahead AND the file changed → divergence.
        assert!(matches!(
            classify_path(
                &file(&crate::ledger::sha256_hex(b"edited during the gap")),
                Some(&old_entry),
                Some(&current),
                ancestor
            ),
            PathClass::Divergence(_)
        ));

        // A forged entry (right shape, wrong digest) is NOT an ancestor —
        // and without ancestry, ledger-ahead is divergence.
        let mut forged = old_entry.clone();
        forged.projection_state_digest = crate::ledger::sha256_hex(b"forged digest");
        assert!(!verified_ancestor(&read.frames, &store, &forged));
        assert!(matches!(
            classify_path(
                &file(&forged.content_hash),
                Some(&forged),
                Some(&current),
                verified_ancestor(&read.frames, &store, &forged)
            ),
            PathClass::Divergence(_)
        ));
        // A generating event outside the chain proves nothing.
        let mut alien = old_entry.clone();
        alien.generating_event = "f".repeat(32);
        assert!(!verified_ancestor(&read.frames, &store, &alien));
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn ancestry_replay_extends_through_a_members_batch_marker() {
        let (vault, _) = seeded("classify-batched");
        let mut writer = LedgerWriter::open(&vault, WRITER).unwrap();
        let store = writer.store_id().to_string();
        // A BATCHED revision: its effect exists only at the marker.
        let receipt = writer
            .append_batch(
                vec![(
                    schema::KIND_BELIEF_REVISED.to_string(),
                    serde_json::to_value(revised_body()).unwrap(),
                )],
                Some("op:classify-batched"),
            )
            .unwrap();
        drop(writer);
        let read = read_ledger(&ledger_dir(&vault)).unwrap();
        let state = reduce(&read.frames, &store);
        let current = project_belief(&state, BELIEF).unwrap();
        assert_eq!(
            current.generating_event, receipt.members[0].event_id,
            "the revision member is the projection head"
        );
        let entry = complete_entry(&current);
        // Cutting the prefix at the member alone would show revision 1;
        // the replay must extend through the marker to prove the tuple.
        assert!(verified_ancestor(&read.frames, &store, &entry));
        let _ = std::fs::remove_dir_all(&vault);
    }

    /// The D4 tripwire: no capture/reconciliation module reads file
    /// timestamps. Test code below the `#[cfg(test)]` marker is exempt
    /// (fingerprint assertions legitimately compare mtimes).
    #[test]
    fn no_capture_or_reconciliation_module_reads_mtime() {
        for (name, source) in [
            ("reconcile.rs", include_str!("reconcile.rs")),
            ("manifest.rs", include_str!("manifest.rs")),
            ("arm.rs", include_str!("arm.rs")),
            ("migrate.rs", include_str!("migrate.rs")),
        ] {
            let production: String = source
                .split("#[cfg(test)]")
                .next()
                .unwrap()
                .lines()
                .filter(|line| !line.trim_start().starts_with("//"))
                .collect::<Vec<_>>()
                .join("\n");
            for needle in ["mtime", ".modified()", "SystemTime"] {
                assert!(
                    !production.contains(needle),
                    "{name}: production code references {needle} — timestamps are never evidence"
                );
            }
        }
    }
}
