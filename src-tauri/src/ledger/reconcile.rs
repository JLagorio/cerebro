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
    pub matches: usize,
    /// Paths regenerated or created from reducer state — ZERO capture.
    pub regenerated: Vec<String>,
    /// Pending entries finalized (the file already held the target bytes).
    pub finalized: Vec<String>,
    /// Valid out-of-band edits still parked (mode open, or mass signature).
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
/// park valid out-of-band edits; and on any unproven state, migration
/// refusal, or the mass threshold, record ONE idempotent
/// `ledger.divergence` and open reconciliation mode. Regular agent writes
/// stay available while the mode is open; automatic capture does not.
///
/// Detection is BEST EFFORT: the remembered app-data head and git anchors
/// are corroboration, not proof — a coherent restore that rewinds ledger,
/// manifest, files, and every anchor together may be undetectable, and
/// nothing here claims otherwise.
pub fn launch_scan(
    writer: &mut super::writer::LedgerWriter,
    vault: &Path,
    migration_signal: Option<schema::DivergenceSignal>,
    remembered_head: Option<&str>,
) -> Result<ScanOutcome, String> {
    let read = super::read_ledger(&super::ledger_dir(vault)).map_err(|e| e.to_string())?;
    let state = reduce(&read.frames, writer.store_id());
    let manifest = super::manifest::load(vault)?;
    let mut outcome = ScanOutcome::default();

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

    let already_open = state.reconciliation_open();
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
            PathClass::InterruptedFinalize => {
                if !already_open {
                    super::manifest::complete_entry(vault, path)?;
                }
                outcome.finalized.push(path.clone());
            }
            PathClass::InterruptedWrite
            | PathClass::LedgerAheadRegenerate
            | PathClass::LedgerAheadAdvance
            | PathClass::LedgerAheadCreate => {
                if !already_open {
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

    // The M23.7 live half: capture parked out-of-band edits — but only
    // when nothing else already demands reconciliation. A failed capture
    // (forged provenance, alias removal, ambiguous overlap) escalates to
    // divergence instead of guessing.
    if !already_open
        && !mass_signature
        && outcome.divergent.is_empty()
        && migration_signal.is_none()
    {
        let parked = std::mem::take(&mut outcome.out_of_band);
        for path in parked {
            match super::capture::capture_out_of_band_with(writer, vault, &path) {
                Ok(()) => outcome.captured.push(path),
                Err(reason) => outcome.divergent.push((path, reason)),
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
        // The stable detection key: the condition, not the launch.
        let condition = serde_json::json!({
            "signals": signals.iter().map(|s| s.as_str()).collect::<Vec<_>>(),
            "samples": samples,
            "manifest_digest": manifest_digest,
            "reducer_digest": reducer_digest,
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
            git_anchored_head: None, // best-effort: read at M23.7's exits
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
/// through the pending-manifest protocol, remove what the ledger cannot
/// explain, recheck F=M=R, and only then append the UNBATCHED resolution.
/// A crash before that append leaves the mode open and resumable.
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
    // manifest entries the reducer cannot explain are removed.
    for (krel, belief) in &state.projection_paths {
        let projection = project_belief(&state, belief)?;
        super::manifest::write_projection(vault, &format!("knowledge/{krel}"), &projection)?;
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
                std::fs::remove_file(entry.path()).map_err(|e| e.to_string())?;
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

/// accept-current-files: adoption through the capture valve, never manifest
/// rebaselining. Every affected file is parsed and mechanically diffed;
/// every representable epistemic diff becomes assertion+revision/effect
/// members and every editorial diff an override member; the resolution
/// rides the SAME logical batch, its digests proving the staged reducer
/// projections equal the adopted bytes. One unparsable, forged, ambiguous,
/// or unrepresentable file refuses the entire action — the manifest
/// advances only after the marker fsync and reducer equality.
pub(crate) fn resolve_accept_with(
    writer: &mut super::writer::LedgerWriter,
    vault: &Path,
) -> Result<(), String> {
    use super::capture;
    use super::writer::{batch_self_ref, member_ref};

    let read = super::read_ledger(&super::ledger_dir(vault)).map_err(|e| e.to_string())?;
    let store = writer.store_id().to_string();
    let state = reduce(&read.frames, &store);
    let Some(divergence_event) = state.reconciliation_divergences.values().next().cloned() else {
        return Err("no open reconciliation to resolve".to_string());
    };
    let manifest = super::manifest::load(vault)?;

    // Classify everything; every non-Match path is affected and must be
    // fully explainable from its CURRENT file bytes.
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
                    .to_string_lossy()
                    .replace('\\', "/");
                paths.insert(rel);
            }
        }
    }

    let mut affected: Vec<String> = Vec::new();
    let mut diffs: Vec<(String, capture::FileDiff, String)> = Vec::new(); // (krel, diff, raw)
    for path in &paths {
        let krel = path.strip_prefix("knowledge/").unwrap_or(path);
        let raw = match std::fs::read_to_string(vault.join(path)) {
            Ok(raw) => raw,
            Err(_) => {
                return Err(format!(
                    "accept-current-files: {path} is missing — a deleted projection has no bytes \
                     to adopt; restore ledger authority instead"
                ))
            }
        };
        let entry = manifest.as_ref().and_then(|m| m.entries.get(path));
        let projection = state
            .projection_paths
            .get(krel)
            .and_then(|belief| project_belief(&state, belief).ok());
        let ancestor = entry.is_some_and(|entry| verified_ancestor(&read.frames, &store, entry));
        let file = FileFact {
            hash: Some(crate::ledger::sha256_hex(raw.as_bytes())),
            parses: super::project::parse_okf(&raw).is_ok(),
        };
        if classify_path(&file, entry, projection.as_ref(), ancestor) == PathClass::Match {
            continue;
        }
        // The mechanical diff refuses forgery, alias removal, ambiguity,
        // and unknown paths — one bad file kills the whole adoption.
        let diff = capture::diff_projection_file(&state, krel, &raw)
            .map_err(|e| format!("accept-current-files refused at {path}: {e}"))?;
        affected.push(krel.to_string());
        diffs.push((krel.to_string(), diff, raw));
    }
    if affected.is_empty() {
        return Err("accept-current-files: nothing differs — resolve by restore instead".into());
    }
    affected.sort();

    // Assemble ONE logical batch: staged registration first when needed,
    // then per file the editorial override (based on CURRENT state) and the
    // assertion+revision+effect members, then the resolution.
    let authority = capture::AuthorityAnswers::default();
    let mut members: Vec<(String, serde_json::Value)> = Vec::new();
    let (source_id, registration_event, staged_registration) =
        capture::resolve_registration(&state, &store, "human:owner", members.len());
    if let Some(member) = staged_registration {
        members.push(member);
    }
    let common = |actor: &str| schema::Actor {
        id: actor.to_string(),
    };
    for (krel, diff, _) in &diffs {
        let belief = state.beliefs.get(&diff.belief_id).expect("diffed belief");
        let current = belief.current();
        if !diff.editorial_ops.is_empty() {
            let (mut content, mut fields) = super::reduce::overlaid(&state, belief);
            for op in &diff.editorial_ops {
                super::reduce::apply_overlay_op(&mut content, &mut fields, op);
            }
            let after_bytes = super::project::project(&content, &fields);
            let body = schema::ProjectionOverridden {
                schema: schema::BODY_SCHEMA,
                batch_id: None,
                idempotency_key: None,
                actor: common("human:owner"),
                occurred_at: None,
                valid_from: None,
                valid_to: None,
                belief_id: diff.belief_id.clone(),
                path: krel.clone(),
                base_belief_revision: current.revision,
                base_belief_revision_event: current.event_id.clone(),
                base_generating_event: belief.projection_head_event.clone(),
                before_projection_hash: diff.old_hash.clone(),
                after_projection_hash: crate::ledger::sha256_hex(after_bytes.as_bytes()),
                origin: schema::OverrideOrigin::ReconciliationAdoption,
                change: schema::OverrideChange::Set {
                    patch: diff.editorial_ops.clone(),
                    supersedes_override_event_ids: vec![],
                },
            };
            members.push((
                schema::KIND_PROJECTION_OVERRIDDEN.to_string(),
                serde_json::to_value(&body).map_err(|e| e.to_string())?,
            ));
        }
        if diff.fields.is_empty() && diff.relations.is_empty() && diff.alias_adds.is_empty() {
            continue;
        }
        let mut observation_refs: Vec<String> = Vec::new();
        for edit in &diff.fields {
            let ordinal = members.len();
            members.push(capture::human_assertion(
                "human:owner",
                &source_id,
                &registration_event,
                &belief.entity_id,
                &authority,
                &edit.field_path,
                edit.after.clone(),
                schema::HumanAssertionForm::FieldChange {
                    target_belief_id: diff.belief_id.clone(),
                    field_path: edit.field_path.clone(),
                    before: edit.before.clone(),
                    after: edit.after.clone(),
                    corrects: edit.corrects.clone(),
                    reason: edit.reason.clone(),
                },
            ));
            observation_refs.push(member_ref(ordinal));
        }
        for relation in &diff.relations {
            let relation_id =
                schema::derive_relation_id(&diff.belief_id, &relation.to_belief_id, relation.kind);
            let value = schema::TypedValue::Object {
                value: [
                    (
                        "relation_id".to_string(),
                        schema::TypedValue::string(&relation_id),
                    ),
                    (
                        "action".to_string(),
                        schema::TypedValue::string(match relation.action {
                            schema::RelationAction::Add => "add",
                            schema::RelationAction::Remove => "remove",
                        }),
                    ),
                    (
                        "from".to_string(),
                        schema::TypedValue::string(&diff.belief_id),
                    ),
                    (
                        "to".to_string(),
                        schema::TypedValue::string(&relation.to_belief_id),
                    ),
                    (
                        "relation".to_string(),
                        schema::TypedValue::string(relation.kind.as_str()),
                    ),
                ]
                .into_iter()
                .collect(),
            };
            let ordinal = members.len();
            members.push(capture::human_assertion(
                "human:owner",
                &source_id,
                &registration_event,
                &belief.entity_id,
                &authority,
                "belief_relation",
                value,
                schema::HumanAssertionForm::RelationChange {
                    target_belief_id: diff.belief_id.clone(),
                    relation_id,
                    action: relation.action,
                    from: diff.belief_id.clone(),
                    to: relation.to_belief_id.clone(),
                    relation: relation.kind,
                    corrects: None,
                    reason: None,
                },
            ));
            observation_refs.push(member_ref(ordinal));
        }
        for alias in &diff.alias_adds {
            let normalized = schema::normalize_alias_v1(alias);
            let value = schema::TypedValue::Object {
                value: [
                    (
                        "entity_id".to_string(),
                        schema::TypedValue::string(&belief.entity_id),
                    ),
                    ("alias".to_string(), schema::TypedValue::string(alias)),
                    (
                        "normalized_alias".to_string(),
                        schema::TypedValue::string(&normalized),
                    ),
                ]
                .into_iter()
                .collect(),
            };
            let ordinal = members.len();
            members.push(capture::human_assertion(
                "human:owner",
                &source_id,
                &registration_event,
                &belief.entity_id,
                &authority,
                "entity_alias",
                value,
                schema::HumanAssertionForm::AliasAdd {
                    target_belief_id: diff.belief_id.clone(),
                    entity_id: belief.entity_id.clone(),
                    alias: alias.clone(),
                    normalized_alias: normalized,
                    corrects: None,
                    reason: None,
                },
            ));
            observation_refs.push(member_ref(ordinal));
        }
        let mut links: Vec<schema::BasisLink> = match &current.basis {
            schema::BeliefBasis::Linked { links } => links.clone(),
            schema::BeliefBasis::Unsupported { .. } => Vec::new(),
        };
        for observation in &observation_refs {
            links.push(schema::BasisLink {
                observation_event_id: observation.clone(),
                role: schema::BasisRole::Supports,
            });
        }
        let revised = schema::BeliefRevised {
            schema: schema::BODY_SCHEMA,
            batch_id: None,
            idempotency_key: None,
            actor: common("human:owner"),
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            belief_id: diff.belief_id.clone(),
            patch: diff
                .fields
                .iter()
                .map(|edit| schema::PatchOp {
                    field_path: edit.field_path.clone(),
                    before: edit.before.clone(),
                    after: edit.after.clone(),
                })
                .collect(),
            basis: schema::BeliefBasis::Linked { links },
        };
        members.push((
            schema::KIND_BELIEF_REVISED.to_string(),
            serde_json::to_value(&revised).map_err(|e| e.to_string())?,
        ));
        for relation in &diff.relations {
            let body = schema::BeliefRelation {
                schema: schema::BODY_SCHEMA,
                batch_id: None,
                idempotency_key: None,
                actor: common("human:owner"),
                occurred_at: None,
                valid_from: None,
                valid_to: None,
                relation_id: schema::derive_relation_id(
                    &diff.belief_id,
                    &relation.to_belief_id,
                    relation.kind,
                ),
                action: relation.action,
                from: diff.belief_id.clone(),
                to: relation.to_belief_id.clone(),
                relation: relation.kind,
            };
            members.push((
                schema::KIND_BELIEF_RELATION.to_string(),
                serde_json::to_value(&body).map_err(|e| e.to_string())?,
            ));
        }
        for alias in &diff.alias_adds {
            let body = schema::EntityAliasAdded {
                schema: schema::BODY_SCHEMA,
                batch_id: None,
                idempotency_key: None,
                actor: common("human:owner"),
                occurred_at: None,
                valid_from: None,
                valid_to: None,
                entity_id: belief.entity_id.clone(),
                alias: alias.clone(),
                normalized_alias: schema::normalize_alias_v1(alias),
            };
            members.push((
                schema::KIND_ENTITY_ALIAS_ADDED.to_string(),
                serde_json::to_value(&body).map_err(|e| e.to_string())?,
            ));
        }
    }

    // The resolution member, in the SAME batch: its digests pin the adopted
    // bytes, and the reducer proves the staged projections equal them —
    // or the whole batch dies.
    let adopted: Vec<serde_json::Value> = affected
        .iter()
        .map(|krel| {
            let (_, _, raw) = diffs
                .iter()
                .find(|(k, _, _)| k == krel)
                .expect("affected paths come from diffs");
            serde_json::json!({
                "path": krel,
                "content_hash": crate::ledger::sha256_hex(raw.as_bytes()),
            })
        })
        .collect();
    let accepted_digest = crate::ledger::sha256_hex(
        serde_json::to_string(&adopted)
            .map_err(|e| e.to_string())?
            .as_bytes(),
    );
    let resolution = schema::ReconciliationResolved {
        schema: schema::BODY_SCHEMA,
        batch_id: None,
        idempotency_key: None,
        actor: common(schema::ACTOR_RECONCILIATION),
        occurred_at: None,
        valid_from: None,
        valid_to: None,
        divergence_event_id: divergence_event.clone(),
        action: schema::ReconciliationAction::AcceptCurrentFiles,
        affected_paths: affected.clone(),
        capture_batch_ids: vec![batch_self_ref()],
        accepted_files_digest: Some(accepted_digest.clone()),
        resulting_projection_digest: accepted_digest,
    };
    members.push((
        schema::KIND_RECONCILIATION_RESOLVED.to_string(),
        serde_json::to_value(&resolution).map_err(|e| e.to_string())?,
    ));

    let op_key = format!("reconcile-accept-v1:{store}:{divergence_event}");
    let receipt = writer.append_batch(members, Some(&op_key))?;
    crate::crash::crash_point("accept-committed");

    let read = super::read_ledger(&super::ledger_dir(vault)).map_err(|e| e.to_string())?;
    let state = reduce(&read.frames, &store);
    let committed = state
        .batches
        .iter()
        .any(|b| b.batch_id == receipt.batch_id && b.state == "committed");
    if !committed && !receipt.replayed {
        let detail = state
            .anomalies
            .iter()
            .rev()
            .find(|a| a.batch_id.as_deref() == Some(receipt.batch_id.as_str()))
            .map(|a| a.detail.clone())
            .unwrap_or_else(|| "the adoption batch did not apply".to_string());
        return Err(format!("accept-current-files refused: {detail}"));
    }
    if state.reconciliation_open() {
        return Err("the adoption resolution did not close the mode".to_string());
    }
    // Only now may the manifest advance — every adopted file is already the
    // reducer projection, so this is identity-only.
    for krel in &affected {
        let belief = state
            .projection_paths
            .get(krel)
            .ok_or_else(|| format!("adopted path {krel} lost its Belief"))?;
        let projection = project_belief(&state, belief)?;
        super::manifest::write_projection(vault, &format!("knowledge/{krel}"), &projection)?;
    }
    Ok(())
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
    fn an_unproven_state_records_one_divergence_opens_the_mode_and_suspends_capture() {
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

        // Automatic capture is SUSPENDED while the mode is open…
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
        let err = crate::ledger::capture::capture_structured_with(&mut writer, &vault, &request)
            .unwrap_err();
        assert!(err.contains("reconciliation is open"), "{err}");
        // …and the status surface names it.
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
            "knowledge/log.md",
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
            "knowledge/log.md",
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
    fn accept_current_files_adopts_through_capture_in_one_batch() {
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
        // The resolution rode the adoption batch and pins matching digests.
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
    fn one_forged_file_refuses_the_entire_adoption() {
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

        let head = head_of(&writer);
        let err = resolve_accept_with(&mut writer, &vault).unwrap_err();
        assert!(err.contains("forgery") || err.contains("refused"), "{err}");
        assert_eq!(head_of(&writer), head, "nothing committed");
        // The mode stays open; the manifest did not move.
        let read = super::super::read_ledger(&super::super::ledger_dir(&vault)).unwrap();
        let state = reduce(&read.frames, writer.store_id());
        assert!(state.reconciliation_open());
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
