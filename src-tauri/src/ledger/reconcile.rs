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

use std::path::Path;

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

/// What one launch scan did, path by path — recovery actions executed,
/// out-of-band edits PARKED (M23.7 captures them), divergence recorded.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ScanOutcome {
    /// Same-bytes moves adopted before classifying, as (from, to) vault
    /// paths (M49.5, K29).
    pub moved: Vec<(String, String)>,
    pub matches: usize,
    /// Paths regenerated or created from reducer state — ZERO capture.
    pub regenerated: Vec<String>,
    /// Pending entries finalized (the file already held the target bytes).
    pub finalized: Vec<String>,
    /// Valid out-of-band edits still parked: capture was held back by a
    /// vault-wide stop, a mass signature, or a migration signal. A divergence
    /// on OTHER paths no longer parks them (M49.5).
    pub out_of_band: Vec<String>,
    /// Out-of-band edits CAPTURED this scan (M23.7's live half).
    pub captured: Vec<String>,
    /// Unproven states, with the classifier's reason.
    pub divergent: Vec<(String, String)>,
    /// The detection key of the divergence recorded this scan, if any.
    pub divergence_recorded: Option<String>,
    /// Reconciliation mode after the scan.
    pub reconciliation_open: bool,
}

/// The fixed mass-mismatch circuit-breaker threshold.
const MASS_MIN_PROJECTIONS: usize = 8;
const MASS_MIN_MISMATCHES: usize = 5;
const MASS_MIN_RATIO: f64 = 0.25;

/// The M23.6 launch scan: after recovery and arming, compare file,
/// manifest, and reducer projection for EVERY path; execute the safe
/// branches (match, pending recovery, ledger-ahead — all zero capture);
/// capture valid out-of-band edits path by path; and on any unproven state,
/// migration refusal, or the mass threshold, record ONE idempotent
/// `ledger.divergence` and open reconciliation mode. The model is per path
/// (M49.5): a diverged path is quarantined on its own while every other
/// path keeps its recoveries and captures. Only a vault-wide stop
/// ([`global_stop`] — a mass, migration, or regressed-head signal), a mass
/// signature, or a migration signal in THIS scan holds capture back, and
/// then the edits stay parked in `out_of_band`.
///
/// Detection is BEST EFFORT: the remembered app-data head is
/// corroboration, not proof, and git trailers are only a join key — nothing
/// reads them back (M49.10). A coherent restore that rewinds ledger,
/// manifest, and files together may be undetectable, and nothing here
/// claims otherwise.
pub fn launch_scan(
    writer: &mut super::writer::LedgerWriter,
    vault: &Path,
    migration_signal: Option<schema::DivergenceSignal>,
    remembered_head: Option<&str>,
) -> Result<ScanOutcome, String> {
    // Moves first (M49.5, K29): a concept moved with its bytes unchanged is
    // adopted before anything is classified, so a folder tidied in Finder
    // never reads as a mass of deletions and strangers.
    let moved = adopt_moves(writer, vault)?;
    let read = super::read_ledger(&super::ledger_dir(vault)).map_err(|e| e.to_string())?;
    let state = reduce(&read.frames, writer.store_id());
    let manifest = super::manifest::load(vault)?;
    let mut outcome = ScanOutcome {
        moved,
        ..ScanOutcome::default()
    };

    // The path universe: manifest entries ∪ knowledge files ∪ reducer
    // projections (vault-relative `knowledge/…` keys).
    let mut paths: std::collections::BTreeSet<String> = state
        .projection_paths
        .keys()
        .map(|krel| format!("knowledge/{krel}"))
        .collect();
    if let Some(manifest) = &manifest {
        paths.extend(manifest.entries.keys().cloned());
    }
    let knowledge = vault.join("knowledge");
    if knowledge.exists() {
        for entry in walkdir::WalkDir::new(&knowledge).sort_by_file_name() {
            let entry = entry.map_err(|e| e.to_string())?;
            if entry.file_type().is_file()
                && entry.path().extension().and_then(|e| e.to_str()) == Some("md")
            {
                let rel = entry
                    .path()
                    .strip_prefix(vault)
                    .map_err(|e| e.to_string())?
                    .to_str()
                    .ok_or("non-UTF-8 knowledge path")?
                    .replace('\\', "/");
                paths.insert(rel);
            }
        }
    }

    // Only a vault-wide stop holds the safe recoveries and the captures back
    // (M49.5, K8); a divergence on some paths quarantines only those.
    let stopped = global_stop(vault, &state)?;
    for path in &paths {
        let krel = path.strip_prefix("knowledge/").unwrap_or(path);
        let file = match std::fs::read(vault.join(path)) {
            Ok(bytes) => FileFact {
                hash: Some(crate::ledger::sha256_hex(&bytes)),
                parses: super::project::parse_okf(&String::from_utf8_lossy(&bytes)).is_ok()
                    && String::from_utf8(bytes).is_ok(),
            },
            Err(_) => FileFact::missing(),
        };
        let entry = manifest.as_ref().and_then(|m| m.entries.get(path));
        let projection = state
            .projection_paths
            .get(krel)
            .and_then(|belief| project_belief(&state, belief).ok());
        let ancestor =
            entry.is_some_and(|entry| verified_ancestor(&read.frames, writer.store_id(), entry));
        match classify_path(&file, entry, projection.as_ref(), ancestor) {
            PathClass::Match => outcome.matches += 1,
            // The knowledge log is a derived, system-owned view (the
            // 2026-09 owner decision; K11): a file that differs from its
            // projection is regenerated, never captured as an override or
            // escalated — its entries are ledger state, not the file's.
            _ if path == crate::knowledge::LOG_PATH
                && projection.is_some()
                && file.hash.as_deref() != projection.as_ref().map(|p| p.content_hash.as_str()) =>
            {
                if !stopped {
                    regenerate_log(writer, vault)?;
                }
                outcome.regenerated.push(path.clone());
            }
            PathClass::InterruptedFinalize => {
                if !stopped {
                    super::manifest::complete_entry(vault, path)?;
                }
                outcome.finalized.push(path.clone());
            }
            PathClass::InterruptedWrite
            | PathClass::LedgerAheadRegenerate
            | PathClass::LedgerAheadAdvance
            | PathClass::LedgerAheadCreate => {
                if !stopped {
                    let projection = projection
                        .as_ref()
                        .ok_or("a ledger-ahead class always has reducer state")?;
                    super::manifest::write_projection(vault, path, projection)?;
                }
                outcome.regenerated.push(path.clone());
            }
            PathClass::OutOfBandEdit => outcome.out_of_band.push(path.clone()),
            PathClass::Divergence(reason) => {
                outcome.divergent.push((path.clone(), reason.to_string()))
            }
        }
    }

    // A mass of mismatches is a RESTORE SIGNATURE, checked BEFORE any
    // capture: adopting it edit-by-edit would silently bless a rollback.
    let projection_count = paths.len();
    let initial_mismatches = outcome.out_of_band.len() + outcome.divergent.len();
    let mass_signature = projection_count >= MASS_MIN_PROJECTIONS
        && initial_mismatches >= MASS_MIN_MISMATCHES
        && (initial_mismatches as f64) >= (projection_count as f64) * MASS_MIN_RATIO;

    // The M23.7 live half: capture parked out-of-band edits — per path
    // (M49.5): another path's divergence no longer holds this one back.
    // Only a vault-wide condition does. A failed capture (forged
    // provenance, alias removal, ambiguous overlap) escalates THAT path to
    // divergence instead of guessing.
    if !stopped && !mass_signature && migration_signal.is_none() {
        let parked = std::mem::take(&mut outcome.out_of_band);
        for path in parked {
            match super::capture::capture_out_of_band_with(writer, vault, &path) {
                Ok(()) => outcome.captured.push(path),
                Err(reason) => {
                    super::capture::log_refused_capture("launch_scan", &path, &reason);
                    outcome.divergent.push((path, reason));
                }
            }
        }
    }

    // The circuit breaker: signals in canonical (declaration) order.
    let mismatches = outcome.out_of_band.len() + outcome.divergent.len();
    let mass = mass_signature;
    let mut signals: Vec<schema::DivergenceSignal> = Vec::new();
    if !outcome.divergent.is_empty() {
        signals.push(schema::DivergenceSignal::ManifestReducerDisagreement);
    }
    if mass {
        signals.push(schema::DivergenceSignal::MassProjectionMismatch);
    }
    if let Some(signal) = migration_signal {
        if !signals.contains(&signal) {
            signals.push(signal);
        }
    }
    signals.sort();

    if !signals.is_empty() {
        // M49.10 (K32): the record describes the ledger AFTER the captures
        // above — it used to be built from the state read before them, so
        // its head and digests named a moment that had already passed.
        let read = super::read_ledger(&super::ledger_dir(vault)).map_err(|e| e.to_string())?;
        let state = reduce(&read.frames, writer.store_id());
        let manifest = super::manifest::load(vault)?;
        let empty_digest = crate::ledger::sha256_hex(b"");
        let manifest_digest = match std::fs::read(super::manifest::manifest_path(vault)) {
            Ok(bytes) => crate::ledger::sha256_hex(&bytes),
            Err(_) => empty_digest.clone(),
        };
        let reducer_digest = reducer_projection_digest(&state)?;
        let mut samples: Vec<String> = outcome
            .divergent
            .iter()
            .map(|(path, _)| path)
            .chain(outcome.out_of_band.iter())
            .filter_map(|p| p.strip_prefix("knowledge/").map(str::to_string))
            .collect();
        samples.sort();
        samples.dedup();
        samples.truncate(schema::reconciliation::MAX_SAMPLE_PATHS);
        // The stable detection key: the condition, not the launch — and
        // the condition is the diverged FILES (M49.10, K32): each path,
        // whether it is on disk, and the bytes the manifest recorded.
        // Whole-bundle digests made the key move with any unrelated edit, so
        // one open condition minted event after event — and so did hashing
        // the diverged file itself, whose every autosave moved the key. Its
        // later edits are the same open condition.
        let mut files: Vec<(String, String, String)> = outcome
            .divergent
            .iter()
            .map(|(path, _)| path)
            .chain(outcome.out_of_band.iter())
            .map(|path| {
                let on_disk = if vault.join(path).exists() {
                    "present"
                } else {
                    "missing"
                }
                .to_string();
                let recorded = manifest
                    .as_ref()
                    .and_then(|m| m.entries.get(path))
                    .map(|e| e.content_hash.clone())
                    .unwrap_or_else(|| "unrecorded".to_string());
                (path.clone(), on_disk, recorded)
            })
            .collect();
        files.sort();
        files.dedup();
        // …and the resolution EPOCH: a condition resolved once and back
        // again (a restored file copied back, a second rewind) is a new
        // divergence. Without it the key collided with the resolved one's
        // claimed idempotency key, the append was a hard conflict, and the
        // recurrence could never be recorded.
        let condition = serde_json::json!({
            "signals": signals.iter().map(|s| s.as_str()).collect::<Vec<_>>(),
            "files": files,
            "epoch": state.reconciliation_log.len(),
        });
        let detection_key = crate::ledger::sha256_hex(
            serde_json::to_string(&condition)
                .map_err(|e| e.to_string())?
                .as_bytes(),
        );
        let already_recorded = state
            .reconciliation_divergences
            .contains_key(&detection_key);
        let body = schema::LedgerDivergence {
            schema: schema::BODY_SCHEMA,
            batch_id: None,
            idempotency_key: None, // append_once stamps the detection key
            actor: schema::Actor {
                id: schema::ACTOR_RECONCILIATION.to_string(),
            },
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            detection_key: detection_key.clone(),
            signals,
            ledger_head: read.head_hash.clone(),
            git_anchored_head: None, // never read — a trailer cannot anchor a synced ledger (M49.10)
            remembered_head: remembered_head.map(str::to_string),
            manifest_digest,
            reducer_projection_digest: reducer_digest,
            mismatch_count: mismatches as u64,
            projection_count: projection_count as u64,
            sample_paths: samples,
        };
        if !already_recorded {
            writer.append_once(
                &detection_key,
                schema::KIND_LEDGER_DIVERGENCE,
                serde_json::to_value(&body).map_err(|e| e.to_string())?,
            )?;
        }
        outcome.divergence_recorded = Some(detection_key);
    }

    let read = super::read_ledger(&super::ledger_dir(vault)).map_err(|e| e.to_string())?;
    outcome.reconciliation_open = reduce(&read.frames, writer.store_id()).reconciliation_open();
    Ok(outcome)
}

/// Adopt every same-bytes move (M49.5, K29): a recorded concept whose file
/// is gone, paired with a file the ledger never recorded whose bytes ARE
/// that concept's projection. Only unambiguous pairs — one missing concept,
/// one candidate file, one hash — are adopted; anything else stays for a
/// person. Recorded as `projection.moved` under the unattributed actor (no
/// one can say who moved it), and the manifest entry follows the file.
pub(crate) fn adopt_moves(
    writer: &mut super::writer::LedgerWriter,
    vault: &Path,
) -> Result<Vec<(String, String)>, String> {
    let read = super::read_ledger(&super::ledger_dir(vault)).map_err(|e| e.to_string())?;
    let state = reduce(&read.frames, writer.store_id());
    // Missing recorded projections, by the hash of what they project.
    let mut missing: std::collections::BTreeMap<String, Vec<(String, String)>> = Default::default();
    for (krel, belief_id) in &state.projection_paths {
        if vault.join(format!("knowledge/{krel}")).exists() {
            continue;
        }
        let projection = project_belief(&state, belief_id)?;
        missing
            .entry(projection.content_hash)
            .or_default()
            .push((krel.clone(), belief_id.clone()));
    }
    if missing.is_empty() {
        return Ok(Vec::new());
    }
    // Unrecorded files, by the hash of their bytes.
    let mut strangers: std::collections::BTreeMap<String, Vec<String>> = Default::default();
    let knowledge = vault.join("knowledge");
    if knowledge.exists() {
        for entry in walkdir::WalkDir::new(&knowledge).sort_by_file_name() {
            let entry = entry.map_err(|e| e.to_string())?;
            if !entry.file_type().is_file()
                || entry.path().extension().and_then(|e| e.to_str()) != Some("md")
            {
                continue;
            }
            let krel = entry
                .path()
                .strip_prefix(&knowledge)
                .map_err(|e| e.to_string())?
                .to_string_lossy()
                .replace('\\', "/");
            if state.projection_paths.contains_key(&krel) {
                continue;
            }
            let bytes = std::fs::read(entry.path()).map_err(|e| e.to_string())?;
            strangers
                .entry(crate::ledger::sha256_hex(&bytes))
                .or_default()
                .push(krel);
        }
    }
    let mut moved = Vec::new();
    for (hash, candidates) in &missing {
        let ([(from, belief_id)], Some([to])) = (
            candidates.as_slice(),
            strangers.get(hash).map(Vec::as_slice),
        ) else {
            continue;
        };
        let body = schema::ProjectionMoved {
            schema: schema::BODY_SCHEMA,
            batch_id: None,
            idempotency_key: None,
            actor: schema::Actor {
                id: super::capture::OUT_OF_BAND_ACTOR.to_string(),
            },
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            belief_id: belief_id.clone(),
            from_path: from.clone(),
            to_path: to.clone(),
            projection_hash: hash.clone(),
        };
        writer.append_once(
            &format!("projection-moved-v1:{belief_id}:{from}:{to}:{hash}"),
            schema::KIND_PROJECTION_MOVED,
            serde_json::to_value(&body).map_err(|e| e.to_string())?,
        )?;
        // The manifest entry follows the file: the new path's identity is
        // the moved projection (its bytes are already on disk), and the old
        // path's entry goes.
        let read = super::read_ledger(&super::ledger_dir(vault)).map_err(|e| e.to_string())?;
        let state = reduce(&read.frames, writer.store_id());
        let projection = project_belief(&state, belief_id)?;
        let (old_rel, new_rel) = (format!("knowledge/{from}"), format!("knowledge/{to}"));
        super::manifest::write_adopted_projection(vault, &new_rel, &projection, hash)?;
        if let Some(mut manifest) = super::manifest::load(vault)? {
            if manifest.entries.remove(&old_rel).is_some() {
                super::manifest::save(vault, &manifest)?;
            }
        }
        moved.push((old_rel, new_rel));
    }
    Ok(moved)
}

/// Regenerate the knowledge log from the ledger: retire any override that
/// pinned it (K11), then write the projection over whatever the file holds.
pub(crate) fn regenerate_log(
    writer: &mut super::writer::LedgerWriter,
    vault: &Path,
) -> Result<(), String> {
    super::concepts::clear_log_overrides_with(writer, vault)?;
    let read = super::read_ledger(&super::ledger_dir(vault)).map_err(|e| e.to_string())?;
    let state = reduce(&read.frames, writer.store_id());
    let belief = state
        .projection_paths
        .get("log.md")
        .ok_or("the knowledge log has no Belief")?;
    let projection = project_belief(&state, belief)?;
    super::manifest::restore_projection(vault, crate::knowledge::LOG_PATH, &projection)
}

/// Is automatic capture stopped for the WHOLE vault? (M49.5, K8)
///
/// Only an open divergence carrying a vault-wide signal stops it: a mass
/// mismatch (a restore signature), a migration refusal, or a regressed head.
/// `manifest_reducer_disagreement` alone names particular paths, and those
/// paths are quarantined by the projection guard — the file on disk is not
/// the one the manifest recorded — while the rest of the bundle keeps
/// capturing. Before M49.5 one diverged file stopped every human knowledge
/// edit in the vault: 39 days on the live vault.
pub fn global_stop(vault: &Path, state: &super::reduce::EpistemicState) -> Result<bool, String> {
    if !state.reconciliation_open() {
        return Ok(false);
    }
    let open: std::collections::BTreeSet<&String> =
        state.reconciliation_divergences.values().collect();
    let read = super::read_ledger(&super::ledger_dir(vault)).map_err(|e| e.to_string())?;
    Ok(read
        .frames
        .iter()
        .filter(|f| f.kind == schema::KIND_LEDGER_DIVERGENCE && open.contains(&f.event_id))
        .any(|f| {
            f.body
                .get("signals")
                .and_then(|s| s.as_array())
                .is_some_and(|signals| {
                    signals.iter().any(|s| {
                        s.as_str()
                            != Some(schema::DivergenceSignal::ManifestReducerDisagreement.as_str())
                    })
                })
        }))
}

// --- The reconciliation exits (M23.7) --------------------------------------

/// Dispatch one reconciliation action through the vault's active writer.
pub fn resolve(vault: &Path, action: &str) -> Option<Result<(), String>> {
    super::shadow::with_writer(vault, |writer| match action {
        "restore_ledger_authority" => resolve_restore_with(writer, vault),
        "accept_current_files" => resolve_accept_with(writer, vault),
        other => Err(format!("unknown reconciliation action {other:?}")),
    })
}

/// restore-ledger-authority: regenerate EVERY projection from reducer state
/// through the pending-manifest protocol, move the files the ledger cannot
/// explain into `.cerebro/reconcile-backup/` (a copy of each overwritten
/// file goes there too — nothing is deleted), drop their manifest entries,
/// recheck F=M=R, and only then append the UNBATCHED resolution. A crash
/// before that append leaves the mode open and resumable.
pub(crate) fn resolve_restore_with(
    writer: &mut super::writer::LedgerWriter,
    vault: &Path,
) -> Result<(), String> {
    let read = super::read_ledger(&super::ledger_dir(vault)).map_err(|e| e.to_string())?;
    let state = reduce(&read.frames, writer.store_id());
    let Some(divergence_event) = state.reconciliation_divergences.values().next().cloned() else {
        return Err("no open reconciliation to resolve".to_string());
    };
    let affected: Vec<String> = state.projection_paths.keys().cloned().collect();
    if affected.is_empty() {
        return Err("nothing to restore — the ledger holds no projections".to_string());
    }

    // The ledger is the authority: every projection regenerates; files and
    // manifest entries the reducer cannot explain are set aside. The one
    // deliberate overwrite in the ledger (M49.3): a person chose it — and
    // what it replaces is kept in `.cerebro/reconcile-backup/` (M49.5, K12).
    let backup = backup_dir(vault, &backup_label(&state, &read.head_hash));
    for (krel, belief) in &state.projection_paths {
        let rel = format!("knowledge/{krel}");
        let projection = project_belief(&state, belief)?;
        let differs = std::fs::read(vault.join(&rel))
            .map(|bytes| bytes != projection.bytes.as_bytes())
            .unwrap_or(false);
        if differs {
            back_up(vault, &rel, &backup, Keeping::Copy)?;
        }
        super::manifest::restore_projection(vault, &rel, &projection)?;
    }
    if let Some(mut manifest) = super::manifest::load(vault)? {
        manifest
            .entries
            .retain(|path, _| match path.strip_prefix("knowledge/") {
                Some(krel) => state.projection_paths.contains_key(krel),
                None => false,
            });
        super::manifest::save(vault, &manifest)?;
    }
    let knowledge = vault.join("knowledge");
    if knowledge.exists() {
        for entry in walkdir::WalkDir::new(&knowledge).sort_by_file_name() {
            let entry = entry.map_err(|e| e.to_string())?;
            if !entry.file_type().is_file()
                || entry.path().extension().and_then(|e| e.to_str()) != Some("md")
            {
                continue;
            }
            let krel = entry
                .path()
                .strip_prefix(&knowledge)
                .map_err(|e| e.to_string())?
                .to_string_lossy()
                .replace('\\', "/");
            if !state.projection_paths.contains_key(&krel) {
                back_up(vault, &format!("knowledge/{krel}"), &backup, Keeping::Move)?;
            }
        }
    }

    // Recheck F = M = R before declaring anything.
    for (krel, belief) in &state.projection_paths {
        let projection = project_belief(&state, belief)?;
        let bytes = std::fs::read(vault.join(format!("knowledge/{krel}")))
            .map_err(|e| format!("restore left {krel} unreadable: {e}"))?;
        if bytes != projection.bytes.as_bytes() {
            return Err(format!("restore did not reproduce {krel} byte-for-byte"));
        }
    }
    crate::crash::crash_point("restore-regenerated");

    // Only now: the unbatched resolution. A crash before this append leaves
    // the mode open; rerunning restore converges and appends it.
    let resulting = reducer_projection_digest(&state)?;
    let body = schema::ReconciliationResolved {
        schema: schema::BODY_SCHEMA,
        batch_id: None,
        idempotency_key: None,
        actor: schema::Actor {
            id: schema::ACTOR_RECONCILIATION.to_string(),
        },
        occurred_at: None,
        valid_from: None,
        valid_to: None,
        divergence_event_id: divergence_event,
        action: schema::ReconciliationAction::RestoreLedgerAuthority,
        affected_paths: affected,
        capture_batch_ids: vec![],
        accepted_files_digest: None,
        resulting_projection_digest: resulting,
    };
    writer.append(
        schema::KIND_RECONCILIATION_RESOLVED,
        serde_json::to_value(&body).map_err(|e| e.to_string())?,
    )?;
    let read = super::read_ledger(&super::ledger_dir(vault)).map_err(|e| e.to_string())?;
    let state = reduce(&read.frames, writer.store_id());
    if state.reconciliation_open() {
        return Err("the restore resolution did not close the mode".to_string());
    }
    Ok(())
}

/// accept-current-files — "Keep my files" for the whole vault (M49.5, K5):
/// per-path Keep over every quarantined file, then the divergence closes
/// once nothing is left quarantined.
///
/// It was ONE batch whose resolution pinned the RAW file bytes while the
/// reducer checks the CANONICAL projections — any formatting difference
/// killed it — under an operation key derived from the divergence alone,
/// so a refused attempt replayed forever and Keep could never work again.
/// Per path, each adoption stands on its own capture (keyed by the bytes it
/// adopts), one refused file stays quarantined without holding back the
/// rest, and the closing resolution is proven over projections the reducer
/// already holds.
pub(crate) fn resolve_accept_with(
    writer: &mut super::writer::LedgerWriter,
    vault: &Path,
) -> Result<(), String> {
    let state = reduce(
        &super::read_ledger(&super::ledger_dir(vault))
            .map_err(|e| e.to_string())?
            .frames,
        writer.store_id(),
    );
    if !state.reconciliation_open() {
        return Err("no open reconciliation to resolve".to_string());
    }
    let quarantined = quarantined_paths(vault, &state)?;
    let mut refused: Vec<String> = Vec::new();
    for path in &quarantined {
        if let Err(reason) = keep_path_with(writer, vault, path) {
            refused.push(format!("{path}: {reason}"));
        }
    }
    close_if_clean(writer, vault, Exit::Keep)?;
    if refused.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "kept {} of {} files; these could not be kept — Restore them, or fix them and Keep \
             again: {}",
            quarantined.len() - refused.len(),
            quarantined.len(),
            refused.join("; ")
        ))
    }
}

/// One file's exit (M49.5, K8): `keep` adopts the file as it is on disk;
/// `restore` backs it up and puts the recorded version back. Either way,
/// the recorded divergence closes once no file is left quarantined.
pub fn resolve_path(vault: &Path, path: &str, action: &str) -> Option<Result<(), String>> {
    super::shadow::with_writer(vault, |writer| {
        resolve_path_with(writer, vault, path, action)
    })
}

pub(crate) fn resolve_path_with(
    writer: &mut super::writer::LedgerWriter,
    vault: &Path,
    path: &str,
    action: &str,
) -> Result<(), String> {
    let path = crate::knowledge::canonical_path(path)
        .ok_or_else(|| format!("{path} is not in the knowledge bundle"))?;
    match action {
        "keep" => {
            keep_path_with(writer, vault, &path)?;
            close_if_clean(writer, vault, Exit::Keep).map(|_| ())
        }
        "restore" => {
            restore_path_with(writer, vault, &path)?;
            close_if_clean(writer, vault, Exit::Restore).map(|_| ())
        }
        other => Err(format!("unknown per-file action {other:?}")),
    }
}

/// Keep one file as it is on disk.
fn keep_path_with(
    writer: &mut super::writer::LedgerWriter,
    vault: &Path,
    path: &str,
) -> Result<(), String> {
    if path == crate::knowledge::LOG_PATH {
        // Derived: there is nothing of the file's to keep (K11).
        return regenerate_log(writer, vault);
    }
    let state = reduce(
        &super::read_ledger(&super::ledger_dir(vault))
            .map_err(|e| e.to_string())?
            .frames,
        writer.store_id(),
    );
    let krel = path.strip_prefix("knowledge/").unwrap_or(path);
    let recorded = state.projection_paths.contains_key(krel);
    let on_disk = vault.join(path).is_file();
    // A half of a same-bytes move (K29): keeping it is keeping the move.
    if recorded != on_disk
        && adopt_moves(writer, vault)?
            .iter()
            .any(|(from, to)| from == path || to == path)
    {
        return Ok(());
    }
    match (recorded, on_disk) {
        (true, true) => super::capture::keep_file_with(writer, vault, path),
        (true, false) => Err(
            "the file was deleted, and a deletion is not something Keep can record yet — Restore \
             brings it back"
                .to_string(),
        ),
        (false, _) => Err(
            "Cerebro never recorded this file, so there is no history to adopt it into — move it \
             out of knowledge/, or Restore to set it aside"
                .to_string(),
        ),
    }
}

/// Put the recorded version of one file back, keeping what was there.
fn restore_path_with(
    writer: &mut super::writer::LedgerWriter,
    vault: &Path,
    path: &str,
) -> Result<(), String> {
    let read = super::read_ledger(&super::ledger_dir(vault)).map_err(|e| e.to_string())?;
    let state = reduce(&read.frames, writer.store_id());
    let backup = backup_dir(vault, &backup_label(&state, &read.head_hash));
    let krel = path.strip_prefix("knowledge/").unwrap_or(path);
    match state.projection_paths.get(krel) {
        Some(belief) => {
            let projection = project_belief(&state, belief)?;
            let differs = std::fs::read(vault.join(path))
                .map(|bytes| bytes != projection.bytes.as_bytes())
                .unwrap_or(false);
            if differs {
                back_up(vault, path, &backup, Keeping::Copy)?;
            }
            super::manifest::restore_projection(vault, path, &projection)
        }
        // Nothing recorded explains the file: it is set aside, never
        // deleted.
        None if vault.join(path).is_file() => back_up(vault, path, &backup, Keeping::Move),
        None => Err(format!("{path} is neither recorded nor on disk")),
    }
}

/// Which exit closed the divergence — recorded as the resolution's action.
#[derive(Clone, Copy, PartialEq)]
enum Exit {
    Keep,
    Restore,
}

/// Close the recorded divergence once every file matches the ledger and no
/// unrecorded file remains (M49.5). The resolution is proven the way the
/// reducer proves every resolution — its digest over the reducer's own
/// projections — and those are exactly what is on disk now. `Ok(false)`
/// while anything is still quarantined, or when nothing is open.
fn close_if_clean(
    writer: &mut super::writer::LedgerWriter,
    vault: &Path,
    exit: Exit,
) -> Result<bool, String> {
    let read = super::read_ledger(&super::ledger_dir(vault)).map_err(|e| e.to_string())?;
    let store = writer.store_id().to_string();
    let state = reduce(&read.frames, &store);
    let Some(divergence_event) = state.reconciliation_divergences.values().next().cloned() else {
        return Ok(false);
    };
    if !quarantined_paths(vault, &state)?.is_empty() {
        return Ok(false);
    }
    // The derived log may still differ; it is regenerated, never judged.
    regenerate_log(writer, vault).ok();
    let read = super::read_ledger(&super::ledger_dir(vault)).map_err(|e| e.to_string())?;
    let state = reduce(&read.frames, &store);
    let affected: Vec<String> = state.projection_paths.keys().cloned().collect();
    if affected.is_empty() {
        return Ok(false);
    }
    // Every file matches: advance the manifest identity (byte-identical,
    // nothing moves on disk) so F = M = R before the resolution says so.
    for (krel, belief) in &state.projection_paths {
        let projection = project_belief(&state, belief)?;
        super::manifest::write_projection(vault, &format!("knowledge/{krel}"), &projection)?;
    }
    let resulting = reducer_projection_digest(&state)?;
    let body = |action, capture_batch_ids, accepted| schema::ReconciliationResolved {
        schema: schema::BODY_SCHEMA,
        batch_id: None,
        idempotency_key: None,
        actor: schema::Actor {
            id: schema::ACTOR_RECONCILIATION.to_string(),
        },
        occurred_at: None,
        valid_from: None,
        valid_to: None,
        divergence_event_id: divergence_event.clone(),
        action,
        affected_paths: affected.clone(),
        capture_batch_ids,
        accepted_files_digest: accepted,
        resulting_projection_digest: resulting.clone(),
    };
    match exit {
        // An accept resolution rides a batch by schema; this one carries
        // only itself — the adoptions it closes over committed file by file.
        Exit::Keep => {
            let resolution = body(
                schema::ReconciliationAction::AcceptCurrentFiles,
                vec![super::writer::batch_self_ref()],
                Some(resulting.clone()),
            );
            writer.append_batch(
                vec![(
                    schema::KIND_RECONCILIATION_RESOLVED.to_string(),
                    serde_json::to_value(&resolution).map_err(|e| e.to_string())?,
                )],
                Some(&format!(
                    "reconcile-close-v1:{store}:{divergence_event}:{resulting}"
                )),
            )?;
        }
        Exit::Restore => {
            let resolution = body(
                schema::ReconciliationAction::RestoreLedgerAuthority,
                vec![],
                None,
            );
            writer.append(
                schema::KIND_RECONCILIATION_RESOLVED,
                serde_json::to_value(&resolution).map_err(|e| e.to_string())?,
            )?;
        }
    }
    let read = super::read_ledger(&super::ledger_dir(vault)).map_err(|e| e.to_string())?;
    if reduce(&read.frames, &store).reconciliation_open() {
        return Err("the closing resolution did not close the divergence".to_string());
    }
    Ok(true)
}

/// Every knowledge file that is not the ledger's (M49.5, K8): a recorded
/// concept whose file differs from its projection or is missing, and any
/// `.md` in the bundle the ledger never recorded. The derived log is not
/// among them — it is regenerated, never quarantined.
pub fn quarantined_paths(
    vault: &Path,
    state: &super::reduce::EpistemicState,
) -> Result<Vec<String>, String> {
    let mut quarantined = Vec::new();
    for (krel, belief) in &state.projection_paths {
        let path = format!("knowledge/{krel}");
        if path == crate::knowledge::LOG_PATH {
            continue;
        }
        let projection = project_belief(state, belief)?;
        let matches = std::fs::read(vault.join(&path))
            .is_ok_and(|bytes| bytes == projection.bytes.as_bytes());
        if !matches {
            quarantined.push(path);
        }
    }
    let knowledge = vault.join("knowledge");
    if knowledge.exists() {
        for entry in walkdir::WalkDir::new(&knowledge).sort_by_file_name() {
            let entry = entry.map_err(|e| e.to_string())?;
            if !entry.file_type().is_file()
                || entry.path().extension().and_then(|e| e.to_str()) != Some("md")
            {
                continue;
            }
            let krel = entry
                .path()
                .strip_prefix(&knowledge)
                .map_err(|e| e.to_string())?
                .to_string_lossy()
                .replace('\\', "/");
            if !state.projection_paths.contains_key(&krel) {
                quarantined.push(format!("knowledge/{krel}"));
            }
        }
    }
    quarantined.sort();
    Ok(quarantined)
}

/// One quarantined file, as `ledger_status` reports it (M49.6, K13).
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct QuarantinedPath {
    pub path: String,
    /// `adoptable` — edited outside Cerebro, and Keep can record it.
    /// `refused` — Keep cannot record it (`reason` says why); Restore can.
    /// `deleted` — recorded, but the file is gone; Restore brings it back.
    /// `unrecorded` — in the bundle, but Cerebro never recorded it.
    pub class: &'static str,
    pub reason: String,
}

/// Why each quarantined file is quarantined — computed live, read-only,
/// from the same diff Keep would run. Before M49.6 the banner said "1
/// unresolved" and named nothing: the person could not find the files, let
/// alone judge the two buttons.
pub fn quarantine_report(
    vault: &Path,
    state: &super::reduce::EpistemicState,
) -> Result<Vec<QuarantinedPath>, String> {
    let mut report = Vec::new();
    for path in quarantined_paths(vault, state)? {
        let krel = path.strip_prefix("knowledge/").unwrap_or(&path);
        let (class, reason) = if !state.projection_paths.contains_key(krel) {
            (
                "unrecorded",
                "in the knowledge bundle, but Cerebro never recorded it".to_string(),
            )
        } else {
            match std::fs::read_to_string(vault.join(&path)) {
                Err(_) => ("deleted", "deleted outside Cerebro".to_string()),
                Ok(raw) => match super::capture::diff_projection_file(state, krel, &raw) {
                    Ok(_) => ("adoptable", "edited outside Cerebro".to_string()),
                    Err(reason) => ("refused", reason),
                },
            }
        };
        report.push(QuarantinedPath {
            path,
            class,
            reason,
        });
    }
    Ok(report)
}

/// Where a Restore keeps what it replaced (M49.5, K12): one folder per
/// divergence inside the gitignored `.cerebro/`, mirroring vault paths.
/// Restore never unlinks — a file it replaces is copied here first, and a
/// file it cannot explain is MOVED here rather than deleted.
pub fn backup_dir(vault: &Path, label: &str) -> std::path::PathBuf {
    vault.join(".cerebro").join("reconcile-backup").join(label)
}

/// The backup folder's name: the open divergence, else the ledger head the
/// restore ran against.
fn backup_label(state: &super::reduce::EpistemicState, head: &str) -> String {
    state
        .reconciliation_divergences
        .values()
        .next()
        .cloned()
        .unwrap_or_else(|| format!("head-{head}"))
}

#[derive(Clone, Copy)]
enum Keeping {
    Copy,
    Move,
}

/// Copy or move `rel` into `backup`, never overwriting an earlier backup of
/// the same file (a second restore under one divergence gets `.1`, `.2`…).
fn back_up(vault: &Path, rel: &str, backup: &Path, keeping: Keeping) -> Result<(), String> {
    let from = vault.join(rel);
    let mut to = backup.join(rel);
    let mut n = 0;
    while to.exists() {
        n += 1;
        to = backup.join(format!("{rel}.{n}"));
    }
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
    }
    match keeping {
        Keeping::Copy => std::fs::copy(&from, &to).map(|_| ()),
        Keeping::Move => std::fs::rename(&from, &to),
    }
    .map_err(|e| format!("could not back up {rel}: {e}"))
}

/// `path_digest` over EVERY reducer projection, path-sorted — the
/// divergence event's reducer side.
pub fn reducer_projection_digest(state: &super::reduce::EpistemicState) -> Result<String, String> {
    let mut entries: Vec<serde_json::Value> = Vec::new();
    for (krel, belief) in &state.projection_paths {
        let projection = project_belief(state, belief)?;
        entries.push(serde_json::json!({
            "path": krel,
            "content_hash": projection.content_hash,
        }));
    }
    Ok(crate::ledger::sha256_hex(
        serde_json::to_string(&entries)
            .map_err(|e| e.to_string())?
            .as_bytes(),
    ))
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

    // --- The M23.6 launch scan + circuit breaker ------------------------

    use super::super::arm::{arm, Arming};
    use super::super::migrate::tests::corpus_copy;
    use super::super::{manifest as manifest_mod, LedgerHead};

    fn armed(label: &str) -> (std::path::PathBuf, LedgerWriter) {
        let vault = corpus_copy(label);
        let mut writer = LedgerWriter::open(&vault, WRITER).unwrap();
        assert!(matches!(
            arm(&mut writer, &vault),
            Arming::Migrated {
                manifest_created: true,
                ..
            }
        ));
        (vault, writer)
    }

    fn head_of(writer: &LedgerWriter) -> Option<LedgerHead> {
        writer.head()
    }

    #[test]
    fn a_clean_vault_scans_to_all_matches_with_zero_events() {
        let (vault, mut writer) = armed("scan-clean");
        let head = head_of(&writer);
        let outcome = launch_scan(&mut writer, &vault, None, None).unwrap();
        assert_eq!(outcome.matches, 10);
        assert!(outcome.divergent.is_empty() && outcome.out_of_band.is_empty());
        assert!(outcome.divergence_recorded.is_none());
        assert!(!outcome.reconciliation_open);
        assert_eq!(head_of(&writer), head, "a scan is not an epistemic act");
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn ledger_ahead_regenerates_and_a_lone_out_of_band_edit_is_captured() {
        let (vault, mut writer) = armed("scan-ahead");
        let store = writer.store_id().to_string();
        // The ledger moves ahead of file+manifest: a solo revision with no
        // projection write (the crash shape).
        const AHEAD: &str = "systems/status-model.md";
        let mut body = revised_body();
        body.belief_id = crate::ledger::schema::migrate_id(&store, "belief", AHEAD);
        body.patch = vec![crate::ledger::schema::PatchOp {
            field_path: "/fields/lifecycle".into(),
            before: schema::TypedValue::string("stable"),
            after: schema::TypedValue::string("deprecated"),
        }];
        writer
            .append(
                schema::KIND_BELIEF_REVISED,
                serde_json::to_value(&body).unwrap(),
            )
            .unwrap();
        // And a single genuine out-of-band edit elsewhere.
        let oob = vault.join("knowledge/metrics/webinar-attendance.md");
        let original = std::fs::read_to_string(&oob).unwrap();
        std::fs::write(&oob, format!("{original}\nEdited outside the app.\n")).unwrap();

        let outcome = launch_scan(&mut writer, &vault, None, None).unwrap();
        assert_eq!(
            outcome.regenerated,
            vec![format!("knowledge/{AHEAD}")],
            "ledger-ahead regenerated"
        );
        // M23.7: the single valid out-of-band edit is CAPTURED — a body
        // change with no extracted-text overlap becomes an editorial
        // override, never a phantom assertion.
        assert_eq!(
            outcome.captured,
            vec!["knowledge/metrics/webinar-attendance.md".to_string()]
        );
        assert!(outcome.out_of_band.is_empty());
        assert!(
            outcome.divergence_recorded.is_none(),
            "one edit is no storm"
        );
        assert!(!outcome.reconciliation_open);
        let read = super::super::read_ledger(&super::super::ledger_dir(&vault)).unwrap();
        let state = reduce(&read.frames, &store);
        // The regenerated file is the exact reducer projection…
        let belief_id = crate::ledger::schema::migrate_id(&store, "belief", AHEAD);
        assert_eq!(
            std::fs::read_to_string(vault.join(format!("knowledge/{AHEAD}"))).unwrap(),
            project_belief(&state, &belief_id).unwrap().bytes
        );
        // …and the captured edit is now CANONICAL projection state: an
        // active editorial overlay reproduces the edited bytes, with no
        // Observation fabricated from the diff.
        let webinar =
            crate::ledger::schema::migrate_id(&store, "belief", "metrics/webinar-attendance.md");
        let captured = state.beliefs.get(&webinar).unwrap();
        assert_eq!(captured.overrides.len(), 1);
        assert_eq!(captured.current().revision, 1, "editorial, not a revision");
        assert_eq!(
            std::fs::read_to_string(&oob).unwrap(),
            project_belief(&state, &webinar).unwrap().bytes
        );
        assert!(std::fs::read_to_string(&oob)
            .unwrap()
            .contains("Edited outside the app."));
        // A second scan is all matches: the capture reconciled the vault.
        let head = head_of(&writer);
        let again = launch_scan(&mut writer, &vault, None, None).unwrap();
        assert_eq!(again.matches, 10);
        assert!(again.captured.is_empty());
        assert_eq!(head_of(&writer), head, "the rescan appends nothing");
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn an_unproven_state_records_one_divergence_and_quarantines_only_its_path() {
        let (vault, mut writer) = armed("scan-divergent");
        // Forge one manifest entry to pin non-ancestor reducer state.
        let mut manifest = manifest_mod::load(&vault).unwrap().unwrap();
        let entry = manifest
            .entries
            .get_mut("knowledge/systems/status-model.md")
            .unwrap();
        entry.projection_state_digest = crate::ledger::sha256_hex(b"forged");
        manifest_mod::save(&vault, &manifest).unwrap();

        let first = launch_scan(&mut writer, &vault, None, None).unwrap();
        let key = first.divergence_recorded.clone().expect("recorded");
        assert!(first.reconciliation_open, "the named mode opened");
        assert_eq!(first.divergent.len(), 1);

        // Idempotent across launches: the same condition, one event.
        let head = head_of(&writer);
        let second = launch_scan(&mut writer, &vault, None, None).unwrap();
        assert!(second.reconciliation_open);
        assert_eq!(head_of(&writer), head, "no second event, no storm");
        let _ = second;

        // M49.5 (K8): one path's divergence quarantines THAT path — the
        // rest of the vault keeps capturing. No vault-wide stop…
        let state = reduce(
            &super::super::read_ledger(&super::super::ledger_dir(&vault))
                .unwrap()
                .frames,
            writer.store_id(),
        );
        assert!(!global_stop(&vault, &state).unwrap());
        // …so a capture on ANOTHER path is judged on its own terms, never
        // refused as suspended.
        let request = crate::ledger::capture::CaptureRequest {
            path: "knowledge/metrics/webinar-attendance.md".into(),
            actor_id: "human:owner".into(),
            fields: vec![crate::ledger::capture::FieldEdit {
                field_path: "/fields/lifecycle".into(),
                before: schema::TypedValue::Missing,
                after: schema::TypedValue::string("stable"),
                corrects: None,
                reason: None,
            }],
            relations: vec![],
            alias_adds: vec![],
            authority: Default::default(),
            request_id: "req-suspended".into(),
        };
        let result = crate::ledger::capture::capture_structured_with(&mut writer, &vault, &request);
        assert!(
            !result
                .as_ref()
                .is_err_and(|e| e.starts_with("reconciliation_suspended")),
            "{result:?}"
        );
        // …and the status surface names the open divergence.
        drop(writer);
        let status = super::super::shadow::status(None, &vault);
        assert!(status.reconciliation_open);
        assert_eq!(status.divergences, vec![key]);
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn a_mass_of_out_of_band_edits_trips_the_circuit_breaker() {
        let (vault, mut writer) = armed("scan-mass");
        // 5 of 10 projections edited out of band: ≥8 projections, ≥5
        // mismatches, ≥25% — the restore signature.
        for rel in [
            "knowledge/index.md",
            // Not log.md: the log is a derived view, regenerated rather than
            // counted as a mismatch (M49.5, K11).
            "knowledge/playbooks/warehouse-cutover.md",
            "knowledge/metrics/onboarding-completion.md",
            "knowledge/metrics/sync-error-rate.md",
            "knowledge/metrics/webinar-attendance.md",
        ] {
            let path = vault.join(rel);
            let original = std::fs::read_to_string(&path).unwrap();
            std::fs::write(&path, format!("{original}\nRewritten en masse.\n")).unwrap();
        }
        let outcome = launch_scan(&mut writer, &vault, None, None).unwrap();
        assert!(outcome.divergence_recorded.is_some());
        assert!(outcome.reconciliation_open);
        // The event carries the mass signal and honest counts.
        let read = super::super::read_ledger(&super::super::ledger_dir(&vault)).unwrap();
        let divergence = read
            .frames
            .iter()
            .find(|f| f.kind == schema::KIND_LEDGER_DIVERGENCE)
            .unwrap();
        assert_eq!(
            divergence.body["signals"],
            serde_json::json!(["mass_projection_mismatch"])
        );
        assert_eq!(divergence.body["mismatch_count"], serde_json::json!(5));
        assert_eq!(divergence.body["projection_count"], serde_json::json!(10));
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn a_migration_refusal_rides_the_divergence_as_its_closed_signal() {
        let (vault, mut writer) = armed("scan-migration-signal");
        let outcome = launch_scan(
            &mut writer,
            &vault,
            Some(schema::DivergenceSignal::MigrationSourceChanged),
            Some("feedfacefeedfacefeedfacefeedface"),
        )
        .unwrap();
        assert!(outcome.divergence_recorded.is_some());
        let read = super::super::read_ledger(&super::super::ledger_dir(&vault)).unwrap();
        let divergence = read
            .frames
            .iter()
            .find(|f| f.kind == schema::KIND_LEDGER_DIVERGENCE)
            .unwrap();
        assert_eq!(
            divergence.body["signals"],
            serde_json::json!(["migration_source_changed"])
        );
        assert_eq!(
            divergence.body["remembered_head"],
            serde_json::json!("feedfacefeedfacefeedfacefeedface"),
            "best-effort corroboration rides along"
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    /// A COHERENT restore — ledger, manifest, files, and every anchor
    /// rewound together — is INDISTINGUISHABLE from a vault that simply
    /// never advanced: this scan (correctly) finds nothing. Detection is
    /// best effort by design; the product never claims universal restore
    /// detection, and neither does this suite.
    #[test]
    fn a_fully_coherent_state_scans_clean_documenting_the_honest_limit() {
        let (vault, mut writer) = armed("scan-coherent");
        let outcome = launch_scan(&mut writer, &vault, None, None).unwrap();
        assert_eq!(outcome.matches, 10);
        assert!(outcome.divergence_recorded.is_none());
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn a_hundred_file_regeneration_is_byte_identical_with_zero_events() {
        let vault = testutil::temp_vault("scan-hundred");
        let mut writer = LedgerWriter::open(&vault, WRITER).unwrap();
        assert!(matches!(arm(&mut writer, &vault), Arming::Migrated { .. }));
        // A hundred committed Beliefs, no files yet (the ledger-ahead
        // create shape at scale).
        for i in 0..100 {
            let mut body = created_body();
            body.belief_id = format!("{i:032x}");
            body.subject = SubjectRef::Resolved {
                entity_id: format!("{:032x}", 1000 + i),
                aliases: vec![format!("bulk/concept-{i:03}.md")],
            };
            writer
                .append(
                    schema::KIND_BELIEF_CREATED,
                    serde_json::to_value(&body).unwrap(),
                )
                .unwrap();
        }
        let first = launch_scan(&mut writer, &vault, None, None).unwrap();
        assert_eq!(first.regenerated.len(), 100);
        assert!(first.divergence_recorded.is_none());
        let bytes_before: Vec<(String, Vec<u8>)> = first
            .regenerated
            .iter()
            .map(|p| (p.clone(), std::fs::read(vault.join(p)).unwrap()))
            .collect();

        // Wipe every projection AND the manifest (the regeneration-burst
        // shape — a deleted file under a live manifest entry is divergence,
        // not regeneration); the rescan reproduces IDENTICAL bytes and
        // appends nothing — regeneration is never an epistemic act.
        for (path, _) in &bytes_before {
            std::fs::remove_file(vault.join(path)).unwrap();
        }
        std::fs::remove_file(manifest_mod::manifest_path(&vault)).unwrap();
        let head = head_of(&writer);
        let second = launch_scan(&mut writer, &vault, None, None).unwrap();
        assert_eq!(second.regenerated.len(), 100);
        assert!(second.divergence_recorded.is_none());
        assert_eq!(head_of(&writer), head, "zero events across 100 files");
        for (path, before) in &bytes_before {
            assert_eq!(&std::fs::read(vault.join(path)).unwrap(), before, "{path}");
        }
        let _ = std::fs::remove_dir_all(&vault);
    }

    /// Trip the breaker with a mass edit and return the edited paths.
    fn mass_edited(vault: &Path, writer: &mut LedgerWriter) -> Vec<&'static str> {
        let edited = vec![
            "knowledge/index.md",
            // Not log.md: the log is a derived view, regenerated rather than
            // counted as a mismatch (M49.5, K11).
            "knowledge/playbooks/warehouse-cutover.md",
            "knowledge/metrics/onboarding-completion.md",
            "knowledge/metrics/sync-error-rate.md",
            "knowledge/metrics/webinar-attendance.md",
        ];
        for rel in &edited {
            let path = vault.join(rel);
            let original = std::fs::read_to_string(&path).unwrap();
            std::fs::write(&path, format!("{original}\nRewritten en masse.\n")).unwrap();
        }
        let outcome = launch_scan(writer, vault, None, None).unwrap();
        assert!(outcome.reconciliation_open);
        edited
    }

    #[test]
    fn restore_ledger_authority_regenerates_everything_and_closes_the_mode() {
        let (vault, mut writer) = armed("exit-restore");
        let store = writer.store_id().to_string();
        mass_edited(&vault, &mut writer);
        // Plus an unexplained extra file the ledger never produced.
        std::fs::write(vault.join("knowledge/rogue.md"), "# Rogue\n").unwrap();

        resolve_restore_with(&mut writer, &vault).unwrap();

        // Every projection is the exact reducer bytes; the rogue file and
        // the edits are gone; the mode is closed and the rescan is clean.
        let read = super::super::read_ledger(&super::super::ledger_dir(&vault)).unwrap();
        let state = reduce(&read.frames, &store);
        assert!(!state.reconciliation_open());
        assert!(!vault.join("knowledge/rogue.md").exists());
        for (krel, belief) in &state.projection_paths {
            assert_eq!(
                std::fs::read_to_string(vault.join(format!("knowledge/{krel}"))).unwrap(),
                project_belief(&state, belief).unwrap().bytes,
                "{krel}"
            );
        }
        let resolution = read
            .frames
            .iter()
            .find(|f| f.kind == schema::KIND_RECONCILIATION_RESOLVED)
            .unwrap();
        assert_eq!(resolution.body["action"], "restore_ledger_authority");
        assert_eq!(resolution.body["batch_id"], serde_json::Value::Null);
        assert_eq!(
            resolution.body["accepted_files_digest"],
            serde_json::Value::Null
        );
        let again = launch_scan(&mut writer, &vault, None, None).unwrap();
        assert_eq!(again.matches, 10);
        assert!(!again.reconciliation_open);
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn accept_current_files_captures_file_by_file_then_closes_in_its_own_batch() {
        let (vault, mut writer) = armed("exit-accept");
        let store = writer.store_id().to_string();
        let edited = mass_edited(&vault, &mut writer);
        let edited_bytes: Vec<(String, String)> = edited
            .iter()
            .map(|rel| {
                (
                    rel.to_string(),
                    std::fs::read_to_string(vault.join(rel)).unwrap(),
                )
            })
            .collect();

        resolve_accept_with(&mut writer, &vault).unwrap();

        // The mode closed; every adopted file is unchanged on disk AND is
        // now the exact reducer projection (editorial overlays carry the
        // body edits — canonical state, never rebaselined bytes).
        let read = super::super::read_ledger(&super::super::ledger_dir(&vault)).unwrap();
        let state = reduce(&read.frames, &store);
        assert!(!state.reconciliation_open());
        for (rel, bytes) in &edited_bytes {
            assert_eq!(&std::fs::read_to_string(vault.join(rel)).unwrap(), bytes);
            let krel = rel.strip_prefix("knowledge/").unwrap();
            let belief = state.projection_paths.get(krel).unwrap();
            assert_eq!(
                &project_belief(&state, belief).unwrap().bytes,
                bytes,
                "{rel}: adopted bytes are reducer-reproducible"
            );
        }
        // Each file committed on its own capture; the closing batch holds
        // only the resolution, which names that batch and pins matching
        // digests.
        let resolution = read
            .frames
            .iter()
            .find(|f| f.kind == schema::KIND_RECONCILIATION_RESOLVED)
            .unwrap();
        assert_eq!(resolution.body["action"], "accept_current_files");
        assert_eq!(
            resolution.body["capture_batch_ids"][0], resolution.body["batch_id"],
            "the resolution names exactly its own batch"
        );
        assert_eq!(
            resolution.body["accepted_files_digest"],
            resolution.body["resulting_projection_digest"]
        );
        let again = launch_scan(&mut writer, &vault, None, None).unwrap();
        assert_eq!(again.matches, 10);
        assert!(!again.reconciliation_open);
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn one_forged_file_stays_quarantined_while_the_rest_are_kept() {
        let (vault, mut writer) = armed("exit-accept-forged");
        mass_edited(&vault, &mut writer);
        // One of the edited files also forges its verified stamp.
        let forged = vault.join("knowledge/metrics/sync-error-rate.md");
        let original = std::fs::read_to_string(&forged).unwrap();
        std::fs::write(
            &forged,
            original.replace(
                "---\ntype:",
                "---\nverified: { by: human:me, at: 2026-08-09 }\ntype:",
            ),
        )
        .unwrap();

        let forged_bytes = std::fs::read(&forged).unwrap();
        // M49.5 (K5, K8): per path. The forged stamp refuses THAT file and
        // names it; every other file is kept.
        let err = resolve_accept_with(&mut writer, &vault).unwrap_err();
        assert!(
            err.contains("sync-error-rate.md") && err.contains("forgery"),
            "{err}"
        );
        assert!(err.starts_with("kept 4 of 5 files"), "{err}");
        let read = super::super::read_ledger(&super::super::ledger_dir(&vault)).unwrap();
        let state = reduce(&read.frames, writer.store_id());
        assert_eq!(
            quarantined_paths(&vault, &state).unwrap(),
            vec!["knowledge/metrics/sync-error-rate.md".to_string()],
            "only the forged file is left quarantined"
        );
        assert_eq!(
            std::fs::read(&forged).unwrap(),
            forged_bytes,
            "its bytes are untouched"
        );
        assert!(
            state.reconciliation_open(),
            "the divergence stays open for it"
        );

        // Restoring that one file backs it up, closes the divergence, and
        // keeps the forged bytes recoverable.
        resolve_path_with(
            &mut writer,
            &vault,
            "knowledge/metrics/sync-error-rate.md",
            "restore",
        )
        .unwrap();
        let read = super::super::read_ledger(&super::super::ledger_dir(&vault)).unwrap();
        let state = reduce(&read.frames, writer.store_id());
        assert!(!state.reconciliation_open());
        let divergence = read
            .frames
            .iter()
            .find(|f| f.kind == schema::KIND_LEDGER_DIVERGENCE)
            .unwrap();
        let backup =
            backup_dir(&vault, &divergence.event_id).join("knowledge/metrics/sync-error-rate.md");
        assert_eq!(std::fs::read(backup).unwrap(), forged_bytes);
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

    // M49.4 (K10): an out-of-band change is filed under the unattributed
    // actor — never as the owner's own assertion. Seq 179 on the live vault
    // recorded an agent's log output as `human:owner`.
    #[test]
    fn an_out_of_band_change_is_recorded_as_unattributed() {
        let (vault, mut writer) = armed("scan-unattributed");
        let before = read_ledger_records(&vault);
        let rel = vault.join("knowledge/metrics/webinar-attendance.md");
        let original = std::fs::read_to_string(&rel).unwrap();
        let edited = original.replacen("lifecycle: ", "lifecycle: deprecated\nx-was: ", 1);
        let edited = if edited == original {
            format!("{original}\nEdited outside the app.\n")
        } else {
            edited
        };
        std::fs::write(&rel, format!("{edited}\nAnd a body line.\n")).unwrap();
        let outcome = launch_scan(&mut writer, &vault, None, None).unwrap();
        assert_eq!(outcome.captured.len(), 1, "{outcome:?}");

        let read = super::super::read_ledger(&super::super::ledger_dir(&vault)).unwrap();
        let actors: Vec<String> = read.frames[before..]
            .iter()
            .filter_map(|f| f.body.get("actor").and_then(|a| a.get("id")))
            .filter_map(|id| id.as_str().map(str::to_string))
            .collect();
        assert!(
            actors
                .iter()
                .any(|a| a == super::super::capture::OUT_OF_BAND_ACTOR),
            "{actors:?}"
        );
        assert!(!actors.iter().any(|a| a == "human:owner"), "{actors:?}");
        let _ = std::fs::remove_dir_all(&vault);
    }

    fn read_ledger_records(vault: &Path) -> usize {
        super::super::read_ledger(&super::super::ledger_dir(vault))
            .unwrap()
            .frames
            .len()
    }

    // M49.5 (K11): an override on the knowledge log pinned its body, so
    // every later entry was committed and never shown (the live vault's seq
    // 179). The log is a derived view: the next append retires the
    // override, and the entry appears.
    #[test]
    fn an_override_on_the_log_is_retired_and_new_entries_appear() {
        let (vault, mut writer) = armed("log-override-retired");
        let log = vault.join(crate::knowledge::LOG_PATH);
        let before = std::fs::read_to_string(&log).unwrap();
        let (content, _) = super::super::project::parse_okf(&before).unwrap();
        let request = crate::ledger::capture::EditorialRequest {
            path: crate::knowledge::LOG_PATH.into(),
            actor_id: "human:owner".into(),
            ops: vec![schema::OverridePatchOp {
                field_path: "/body".into(),
                before: schema::TypedValue::string(&content),
                after: schema::TypedValue::string(&format!("{content}\nPinned by hand.\n")),
            }],
            origin: schema::OverrideOrigin::InApp,
            request_id: "log-pin".into(),
        };
        crate::ledger::capture::capture_editorial_with(&mut writer, &vault, &request).unwrap();
        assert!(std::fs::read_to_string(&log)
            .unwrap()
            .contains("Pinned by hand."));

        super::super::concepts::tests_append_log(&mut writer, &vault, "knowledge/x.md", "X");
        let after = std::fs::read_to_string(&log).unwrap();
        assert!(after.contains("[X]"), "the new entry shows: {after}");
        assert!(
            !after.contains("Pinned by hand."),
            "the override is retired"
        );
        let read = super::super::read_ledger(&super::super::ledger_dir(&vault)).unwrap();
        let state = reduce(&read.frames, writer.store_id());
        let belief = &state.beliefs[&state.projection_paths["log.md"]];
        assert!(belief.overrides.is_empty());
        let _ = std::fs::remove_dir_all(&vault);
    }

    // M49.5 (K8): a mass mismatch — a restore signature — is the vault-wide
    // stop; one path's divergence is not.
    #[test]
    fn a_mass_mismatch_is_a_vault_wide_stop() {
        let (vault, mut writer) = armed("mass-global-stop");
        mass_edited(&vault, &mut writer);
        let read = super::super::read_ledger(&super::super::ledger_dir(&vault)).unwrap();
        let state = reduce(&read.frames, writer.store_id());
        assert!(global_stop(&vault, &state).unwrap());
        let _ = std::fs::remove_dir_all(&vault);
    }

    // M49.5 (K5): the incident's exact shape — a recheck lane rewrote
    // `generated.at` and nothing else. Same `by`, new `at`: a restamp, not
    // forgery. The scan captures it as an unattributed revision and nothing
    // diverges.
    #[test]
    fn a_generated_at_restamp_is_captured_not_refused_as_forgery() {
        let (vault, mut writer) = armed("restamp-captured");
        let rel = "knowledge/metrics/webinar-attendance.md";
        let original = std::fs::read_to_string(vault.join(rel)).unwrap();
        let restamped = original.replace(
            "generated: { by: claude-code/2.0, at: 2026-07-20T11:00:00Z }",
            "generated: { by: claude-code/2.0, at: 2026-08-17T11:52:02Z }",
        );
        assert_ne!(restamped, original, "the fixture carries the stamp");
        std::fs::write(vault.join(rel), &restamped).unwrap();

        let outcome = launch_scan(&mut writer, &vault, None, None).unwrap();
        assert_eq!(outcome.captured, vec![rel.to_string()], "{outcome:?}");
        assert!(outcome.divergence_recorded.is_none());
        let read = super::super::read_ledger(&super::super::ledger_dir(&vault)).unwrap();
        let state = reduce(&read.frames, writer.store_id());
        let belief = &state.projection_paths["metrics/webinar-attendance.md"];
        let disk = std::fs::read_to_string(vault.join(rel)).unwrap();
        assert_eq!(disk, project_belief(&state, belief).unwrap().bytes);
        assert!(
            disk.contains("at: 2026-08-17T11:52:02Z"),
            "the new stamp is kept"
        );
        // The concept was verified at r1; the restamp is r2. The review line
        // says so rather than keeping a stamp the ledger no longer grants
        // for the current revision — trust is the attestation's, not the
        // file's.
        assert!(disk.contains("attestation predates revision"), "{disk}");
        let revision = read
            .frames
            .iter()
            .rev()
            .find(|f| f.kind == schema::KIND_BELIEF_REVISED)
            .unwrap();
        assert_eq!(
            revision.body["actor"]["id"],
            super::super::capture::OUT_OF_BAND_ACTOR
        );
        // A different AUTHOR is still forgery.
        let reauthored = restamped.replace("by: claude-code/2.0", "by: human:someone");
        std::fs::write(vault.join(rel), reauthored).unwrap();
        let outcome = launch_scan(&mut writer, &vault, None, None).unwrap();
        assert_eq!(outcome.divergent.len(), 1, "{outcome:?}");
        assert!(outcome.divergent[0].1.contains("forgery"));
        let _ = std::fs::remove_dir_all(&vault);
    }

    // M49.5 (K12): Restore never unlinks. What it overwrites is copied, and
    // a file it cannot explain is moved, into the divergence's backup.
    #[test]
    fn restore_keeps_what_it_replaces_and_deletes_nothing() {
        let (vault, mut writer) = armed("restore-backup");
        let edited = mass_edited(&vault, &mut writer);
        let edited_bytes: Vec<Vec<u8>> = edited
            .iter()
            .map(|rel| std::fs::read(vault.join(rel)).unwrap())
            .collect();
        let stray = "knowledge/systems/hand-made.md";
        std::fs::write(
            vault.join(stray),
            "---\ntype: Reference\n---\n\n# Hand made\n",
        )
        .unwrap();

        resolve_restore_with(&mut writer, &vault).unwrap();

        let read = super::super::read_ledger(&super::super::ledger_dir(&vault)).unwrap();
        let divergence = read
            .frames
            .iter()
            .find(|f| f.kind == schema::KIND_LEDGER_DIVERGENCE)
            .unwrap();
        let backup = backup_dir(&vault, &divergence.event_id);
        for (rel, bytes) in edited.iter().zip(&edited_bytes) {
            assert_eq!(&std::fs::read(backup.join(rel)).unwrap(), bytes, "{rel}");
        }
        assert!(!vault.join(stray).exists(), "set aside…");
        assert!(backup.join(stray).is_file(), "…never deleted");
        let _ = std::fs::remove_dir_all(&vault);
    }

    // M49.10 (K32): the divergence key is the diverged FILES, so an
    // unrelated capture elsewhere (which moves the manifest digest) does not
    // mint a second event for the same open condition.
    #[test]
    fn an_unrelated_change_does_not_mint_a_second_divergence() {
        let (vault, mut writer) = armed("scan-stable-key");
        let mut manifest = manifest_mod::load(&vault).unwrap().unwrap();
        manifest
            .entries
            .get_mut("knowledge/systems/status-model.md")
            .unwrap()
            .projection_state_digest = crate::ledger::sha256_hex(b"forged");
        manifest_mod::save(&vault, &manifest).unwrap();
        let first = launch_scan(&mut writer, &vault, None, None).unwrap();
        assert!(first.divergence_recorded.is_some());

        // Elsewhere, an ordinary out-of-band edit the next scan captures —
        // the manifest digest moves with it.
        let other = vault.join("knowledge/metrics/webinar-attendance.md");
        let text = std::fs::read_to_string(&other).unwrap();
        std::fs::write(&other, format!("{text}\nAn unrelated edit.\n")).unwrap();
        let second = launch_scan(&mut writer, &vault, None, None).unwrap();
        assert_eq!(second.captured.len(), 1, "{second:?}");
        assert_eq!(second.divergence_recorded, first.divergence_recorded);

        let read = super::super::read_ledger(&super::super::ledger_dir(&vault)).unwrap();
        let divergences = read
            .frames
            .iter()
            .filter(|f| f.kind == schema::KIND_LEDGER_DIVERGENCE)
            .count();
        assert_eq!(divergences, 1, "one open condition, one event");
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn a_diverged_files_own_edits_do_not_mint_a_second_divergence() {
        // A file whose capture is refused (a stamp the ledger never
        // recorded), saved again and again — an editor's autosave.
        let (vault, mut writer) = armed("scan-own-edits");
        let path = vault.join("knowledge/metrics/sync-error-rate.md");
        let text = std::fs::read_to_string(&path).unwrap();
        let forged = text.replacen(
            "---\n",
            "---\nverified: { by: \"human:someone\", at: 2026-01-01 }\n",
            1,
        );
        std::fs::write(&path, &forged).unwrap();
        let first = launch_scan(&mut writer, &vault, None, None).unwrap();
        assert!(first.divergence_recorded.is_some(), "{first:?}");
        for draft in 0..3 {
            std::fs::write(&path, format!("{forged}\nDraft {draft}.\n")).unwrap();
            let again = launch_scan(&mut writer, &vault, None, None).unwrap();
            assert_eq!(again.divergence_recorded, first.divergence_recorded);
        }
        let read = super::super::read_ledger(&super::super::ledger_dir(&vault)).unwrap();
        let divergences = read
            .frames
            .iter()
            .filter(|f| f.kind == schema::KIND_LEDGER_DIVERGENCE)
            .count();
        assert_eq!(divergences, 1, "one open condition, one event");
        let _ = std::fs::remove_dir_all(&vault);
    }

    // M49.5 (K29): a concept moved in Finder, bytes unchanged, is adopted as
    // a move — never one concept deleted plus one stranger.
    #[test]
    fn a_same_bytes_rename_is_adopted_as_a_move() {
        let (vault, mut writer) = armed("scan-move");
        let from = vault.join("knowledge/systems/status-model.md");
        let to = vault.join("knowledge/archive/status-model.md");
        std::fs::create_dir_all(to.parent().unwrap()).unwrap();
        std::fs::rename(&from, &to).unwrap();

        let outcome = launch_scan(&mut writer, &vault, None, None).unwrap();
        assert_eq!(
            outcome.moved,
            vec![(
                "knowledge/systems/status-model.md".to_string(),
                "knowledge/archive/status-model.md".to_string()
            )]
        );
        assert!(outcome.divergence_recorded.is_none(), "{outcome:?}");
        let read = super::super::read_ledger(&super::super::ledger_dir(&vault)).unwrap();
        let state = reduce(&read.frames, writer.store_id());
        assert!(state
            .projection_paths
            .contains_key("archive/status-model.md"));
        assert!(!state
            .projection_paths
            .contains_key("systems/status-model.md"));
        assert!(quarantined_paths(&vault, &state).unwrap().is_empty());
        let manifest = manifest_mod::load(&vault).unwrap().unwrap();
        assert!(manifest
            .entries
            .contains_key("knowledge/archive/status-model.md"));
        assert!(!manifest
            .entries
            .contains_key("knowledge/systems/status-model.md"));
        // The next scan is quiet.
        let head = head_of(&writer);
        let again = launch_scan(&mut writer, &vault, None, None).unwrap();
        assert!(again.moved.is_empty());
        assert_eq!(head_of(&writer), head);
        let _ = std::fs::remove_dir_all(&vault);
    }

    // Two candidate files with the moved bytes: which one is the concept is
    // a person's call, so nothing is adopted.
    #[test]
    fn an_ambiguous_move_is_left_for_a_person() {
        let (vault, mut writer) = armed("scan-move-ambiguous");
        let from = vault.join("knowledge/systems/status-model.md");
        let bytes = std::fs::read(&from).unwrap();
        std::fs::remove_file(&from).unwrap();
        std::fs::write(vault.join("knowledge/a.md"), &bytes).unwrap();
        std::fs::write(vault.join("knowledge/b.md"), &bytes).unwrap();
        let outcome = launch_scan(&mut writer, &vault, None, None).unwrap();
        assert!(outcome.moved.is_empty());
        let _ = std::fs::remove_dir_all(&vault);
    }

    // Review fix (M49.10): a condition resolved and then back again is a new
    // divergence — the file-keyed condition used to collide with the
    // resolved one's claimed key, and the recurrence was never recorded.
    #[test]
    fn a_condition_that_recurs_after_resolution_is_recorded_again() {
        let (vault, mut writer) = armed("scan-recur");
        let rel = "knowledge/metrics/sync-error-rate.md";
        let path = vault.join(rel);
        let original = std::fs::read_to_string(&path).unwrap();
        let forged = original.replace(
            "---\ntype:",
            "---\nverified: { by: human:me, at: 2026-08-09 }\ntype:",
        );
        std::fs::write(&path, &forged).unwrap();
        let first = launch_scan(&mut writer, &vault, None, None).unwrap();
        let key = first.divergence_recorded.expect("recorded");
        resolve_path_with(&mut writer, &vault, rel, "restore").unwrap();
        std::fs::write(&path, &forged).unwrap(); // copied back from the backup
        let again = launch_scan(&mut writer, &vault, None, None).unwrap();
        let second = again.divergence_recorded.expect("recorded again");
        assert_ne!(second, key);
        assert!(again.reconciliation_open);
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn a_formatting_only_difference_is_normalized_and_leaves_quarantine() {
        // K5: same values, different spelling. The diff is empty, so before
        // M49.5's fix nothing was written and the file stayed quarantined
        // forever — Keep "succeeded" and changed nothing.
        let (vault, mut writer) = armed("capture-formatting");
        let rel = "knowledge/metrics/sync-error-rate.md";
        let canonical = std::fs::read_to_string(vault.join(rel)).unwrap();
        let reformatted =
            canonical.replacen("title: Sync error rate", "title: \"Sync error rate\"", 1);
        assert_ne!(reformatted, canonical);
        std::fs::write(vault.join(rel), &reformatted).unwrap();
        let head = head_of(&writer);
        crate::ledger::capture::capture_out_of_band_with(&mut writer, &vault, rel).unwrap();
        assert_eq!(head_of(&writer), head, "formatting is not an epistemic act");
        assert_eq!(std::fs::read_to_string(vault.join(rel)).unwrap(), canonical);
        let read = read_ledger(&ledger_dir(&vault)).unwrap();
        let state = reduce(&read.frames, writer.store_id());
        assert!(quarantined_paths(&vault, &state).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn a_watcher_edit_of_the_log_is_regenerated_not_pinned() {
        let (vault, mut writer) = armed("capture-log");
        let log = crate::knowledge::LOG_PATH;
        let recorded = std::fs::read_to_string(vault.join(log)).unwrap();
        std::fs::write(
            vault.join(log),
            format!("{recorded}\nA hand-written line.\n"),
        )
        .unwrap();
        crate::ledger::capture::capture_out_of_band_with(&mut writer, &vault, log).unwrap();
        assert_eq!(std::fs::read_to_string(vault.join(log)).unwrap(), recorded);
        let read = read_ledger(&ledger_dir(&vault)).unwrap();
        let state = reduce(&read.frames, writer.store_id());
        let belief = &state.beliefs[&state.projection_paths["log.md"]];
        assert!(
            belief.overrides.is_empty(),
            "the derived log is never pinned"
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn an_in_app_edit_is_filed_under_the_owner_and_a_file_edit_is_not() {
        // Activation arms the corpus through the process's one writer.
        let vault = corpus_copy("capture-actors");
        let _guard = crate::ledger::shadow::testing::activated(&vault);
        let actor_of_last_override = |vault: &Path| {
            let read = read_ledger(&ledger_dir(vault)).unwrap();
            read.frames
                .iter()
                .rev()
                .find(|f| f.kind == schema::KIND_PROJECTION_OVERRIDDEN)
                .map(|f| f.body["actor"]["id"].as_str().unwrap().to_string())
                .unwrap()
        };
        let rel = "knowledge/metrics/sync-error-rate.md";
        let mut bytes = std::fs::read_to_string(vault.join(rel)).unwrap();
        bytes.push_str("\nWritten in another editor.\n");
        std::fs::write(vault.join(rel), &bytes).unwrap();
        crate::ledger::capture::capture_out_of_band(&vault, rel)
            .unwrap()
            .unwrap();
        assert_eq!(
            actor_of_last_override(&vault),
            crate::ledger::capture::OUT_OF_BAND_ACTOR
        );

        let file = std::fs::read_to_string(vault.join(rel)).unwrap();
        let (_, body) = file.split_once("\n---\n").unwrap();
        crate::ledger::capture::capture_body_edit(&vault, rel, &format!("{body}\nTyped here.\n"))
            .unwrap()
            .unwrap();
        assert_eq!(
            actor_of_last_override(&vault),
            crate::ledger::capture::OWNER_ACTOR
        );
        crate::ledger::shadow::deactivate();
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn the_owners_own_supersedes_edit_is_their_agreement_and_a_file_edit_is_not() {
        // K22's gate asks whether a PERSON agreed a replacement retires a
        // reviewed claim. A card approval says so; so does the owner typing
        // `supersedes` into the replacement in the app. The same line
        // arriving from another editor does not.
        let vault = corpus_copy("capture-owner-supersedes");
        let _guard = crate::ledger::shadow::testing::activated(&vault);
        let pair = |state: &super::super::reduce::EpistemicState| {
            crate::knowledge::approved_supersessions(state).contains(&(
                "knowledge/metrics/webinar-attendance.md".to_string(),
                "knowledge/metrics/sync-error-rate.md".to_string(),
            ))
        };
        let state_now = || {
            let read = read_ledger(&ledger_dir(&vault)).unwrap();
            let store = super::super::store::load(&ledger_dir(&vault))
                .unwrap()
                .unwrap()
                .store_id;
            reduce(&read.frames, &store)
        };
        let replacement = "knowledge/metrics/webinar-attendance.md";
        let before = std::fs::read_to_string(vault.join(replacement)).unwrap();
        let mut patch = serde_json::Map::new();
        patch.insert(
            "supersedes".into(),
            serde_json::json!(["[[sync-error-rate]]"]),
        );
        crate::ledger::capture::capture_frontmatter_patch(&vault, replacement, &patch)
            .unwrap()
            .unwrap();
        assert!(pair(&state_now()), "the owner typed it");

        // Undo it, then have the same line arrive from another editor.
        let mut clear = serde_json::Map::new();
        clear.insert("supersedes".into(), serde_json::Value::Null);
        crate::ledger::capture::capture_frontmatter_patch(&vault, replacement, &clear)
            .unwrap()
            .unwrap();
        assert!(!pair(&state_now()));
        let typed = std::fs::read_to_string(vault.join(replacement)).unwrap();
        assert_ne!(typed, before);
        let elsewhere = typed.replacen(
            "---\n",
            "---\nsupersedes:\n  - \"[[sync-error-rate]]\"\n",
            1,
        );
        std::fs::write(vault.join(replacement), elsewhere).unwrap();
        crate::ledger::capture::capture_out_of_band(&vault, replacement)
            .unwrap()
            .unwrap();
        assert!(!pair(&state_now()), "an unattributed edit is not agreement");
        crate::ledger::shadow::deactivate();
        let _ = std::fs::remove_dir_all(&vault);
    }
}
