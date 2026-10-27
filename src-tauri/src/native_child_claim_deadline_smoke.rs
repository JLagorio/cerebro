//! R1 regression at the actual original-caller postcommit phase-C boundary.
//! Separate from the healthy thirteen-case profile. No manufactured authority.
use super::*;
use crate::actions::native_owner::{arm_child_claim_phase_c_probe, recover_unstarted_children};

fn interrupted_join(
    paths: &SmokePaths,
    known: &SettingsRuntime,
    capsule: &FrozenNativeChild,
) -> Result<bool, &'static str> {
    known.recheck(paths)?;
    let read =
        crate::runtime::ReadOnly::open(&paths.config).map_err(|_| "deadline-terminal-read")?;
    let a = capsule.view().allocation;
    let joined:bool=read.query_row(
        "SELECT count(*)=1 FROM child_job_claims j
         JOIN child_job_reservations s ON s.slot_id=j.slot_id AND s.reserved_run_id=j.run_id
         JOIN child_job_grant_freezes f ON f.slot_id=j.slot_id AND f.contract_digest=j.contract_digest
         JOIN chat_delegation_intents i ON i.slot_id=s.slot_id
         JOIN runs r ON r.run_id=j.run_id
         JOIN action_native_runs n ON n.run_id=j.run_id AND n.authority_id=j.authority_id
         JOIN action_native_runs p ON p.run_id=i.parent_run_id AND p.authority_id=i.authority_id
         WHERE s.job_id=?1 AND s.reserved_run_id=?2 AND s.reserved_cli_session_id=?3
         AND s.request_digest=?4 AND s.deadline_at=?5 AND f.contract_digest=?6
         AND j.state='interrupted' AND j.ended_at IS NOT NULL AND s.occupies_slot=0
         AND r.outcome='abandoned_usage_unknown' AND r.usage_state='unknown' AND r.ended_at=j.ended_at
         AND r.actor='job:'||s.job_id AND r.cli_session_id=s.reserved_cli_session_id
         AND r.parent_run_id=i.parent_run_id AND r.vault_id=i.vault_id AND r.store_uuid=i.store_uuid
         AND r.mode='attended' AND r.configuration_capture='required'
         AND n.source_kind='job' AND n.child_job_id=s.job_id AND n.client_id IS NULL
         AND n.actor_id=r.actor AND n.cli_session_id=r.cli_session_id AND n.parent_run_id=r.parent_run_id
         AND n.owner_person=i.owner_person AND n.vault_id=i.vault_id AND n.store_uuid=i.store_uuid
         AND n.app_session_id=i.app_session_id AND j.app_session_id=i.app_session_id
         AND n.canonical_vault_path=p.canonical_vault_path AND n.revision=2
         AND n.close_kind='context_closed' AND n.closed_at=j.ended_at",
        rusqlite::params![a.job_id,a.run_id,a.session_id,a.request_digest,i64::try_from(a.deadline_at).map_err(|_|"deadline-terminal-deadline")?,capsule.view().contract_digest],
        |r|r.get(0),
    ).map_err(|_|"deadline-terminal-join")?;
    drop(read);
    known.recheck(paths)?;
    Ok(joined)
}

pub(super) fn capture(
    app: &AppHandle,
    window: &WebviewWindow,
    cases: &mut Vec<Case>,
) -> Result<(), &'static str> {
    let paths = app.state::<SmokePaths>();
    seed(&paths)?;
    open(app, window, &paths.vault_a)?;
    let known = SettingsRuntime::capture(&paths)?;
    let run = start_parent(app, window, &paths, None)?;
    let mut req = request()?;
    // Booking admits any positive original deadline within its elapsed budget.
    // Choose it BEFORE reserve/freeze; no frozen row or shared limit is changed.
    let span = u64::from(req.budget.elapsed_seconds).min(10);
    if span < 2 {
        return Err("deadline-fixture-budget-too-short");
    }
    req.deadline_at = crate::agent::child_jobs::freeze::now()
        .map_err(|_| "deadline-clock")?
        .checked_add(span)
        .ok_or("deadline-overflow")?;
    let caller = prepare_native_delegation(app, window, run).map_err(|_| "deadline-prepare")?;
    let allocation =
        reserve_native_delegation(app, window, &caller, &req).map_err(|_| "deadline-reserve")?;
    let frozen = freeze_native_child(app, window, &caller, &req, NativeChildMode::LocalResearcher)
        .map_err(|_| "deadline-freeze")?;
    let replay = freeze_native_child(app, window, &caller, &req, NativeChildMode::LocalResearcher)
        .map_err(|_| "deadline-freeze-replay")?;
    observed(
        cases,
        "deadline-original-parent-reservation-same-arc",
        available(app, window, run)
            && Arc::ptr_eq(&frozen, &replay)
            && frozen.view().allocation == &allocation
            && allocation.deadline_at == req.deadline_at
            && original_binding(&paths, &known, &frozen)?,
        "real-original-caller-short-original-deadline",
    )?;
    let immutable = immutable_allocations(&paths, &known)?;
    let before = child_backend_consumptions();
    let probe = arm_child_claim_phase_c_probe().map_err(|_| "deadline-arm-phase-c")?;
    let (attempted, reached_at, released_at, returned_at) =
        std::thread::scope(|scope| -> Result<_, &'static str> {
            let claim = scope.spawn(|| {
                let attempted = claim_native_child_run(app, window, &caller, &req, &frozen);
                let returned_at = crate::agent::child_jobs::freeze::now();
                (attempted, returned_at)
            });
            // Release and join even when prerequisite observation fails. Neither the
            // probe nor this controller can supply an owner, row writer or backend.
            let delayed = (|| -> Result<u64, &'static str> {
                probe
                    .wait_reached()
                    .map_err(|_| "deadline-phase-c-not-reached")?;
                let reached = crate::agent::child_jobs::freeze::now()
                    .map_err(|_| "deadline-reached-clock")?;
                observed(
                    cases,
                    "deadline-paused-after-commit-before-expiry",
                    reached < req.deadline_at
                        && actual_join(&paths, &known, &frozen, false)?
                        && occupancy(&paths, &known)? == (1, 1, 1)
                        && child_backend_consumptions() == before,
                    "actual-committed-claim-paused-after-first-prepared-check",
                )?;
                let wait_started = std::time::Instant::now();
                while crate::agent::child_jobs::freeze::now().map_err(|_| "deadline-wait-clock")?
                    < req.deadline_at
                {
                    if wait_started.elapsed() > std::time::Duration::from_secs(15) {
                        return Err("deadline-original-clock-did-not-cross");
                    }
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
                Ok(reached)
            })();
            let released_at =
                crate::agent::child_jobs::freeze::now().map_err(|_| "deadline-release-clock");
            let released = probe.release().map_err(|_| "deadline-phase-c-release");
            let result = claim.join().map_err(|_| "deadline-claim-worker-panicked");
            let reached_at = delayed?;
            released?;
            let (attempted, returned_at) = result?;
            Ok((
                attempted,
                reached_at,
                released_at?,
                returned_at.map_err(|_| "deadline-return-clock")?,
            ))
        })?;
    drop(probe);
    let no_owner = matches!(
        &attempted,
        Err(ClaimRefusal::Freeze(FreezeRefusal::Deadline))
    );
    // Inspect only the Result discriminant and the closed refusal enum. Never
    // format or serialize the owner, proof, grant, request or evidence body.
    let (exposed_owner, refusal) = match &attempted {
        Ok(_) => (true, None),
        Err(refusal) => (false, Some(format!("{refusal:?}"))),
    };
    let consumed_after = child_backend_consumptions();
    let attempt_join = actual_join(&paths, &known, &frozen, false);
    let attempt_occupancy = occupancy(&paths, &known);
    let attempt_immutable = immutable_allocations(&paths, &known);
    let attempt_rows = rows(&paths, &known);
    // Persist even an unavailable row observation as null plus its bounded
    // static error category. Missing observations cannot be accepted as RED.
    let attempt_audit = serde_json::json!({"format":1,"profile":"child-claim-deadline-attempt",
        "originalDeadline":req.deadline_at,"shortDeadlineSeconds":span,
        "reachedAt":reached_at,"releasedAt":released_at,"returnedAt":returned_at,
        "exposedOwner":exposed_owner,"claimRefusal":refusal,
        "backendConsumptionsBefore":before,"backendConsumptionsAfter":consumed_after,
        "liveJoin":attempt_join.as_ref().ok(),"occupancy":attempt_occupancy.as_ref().ok(),
        "immutableMetadataEqual":attempt_immutable.as_ref().ok().map(|value|value==&immutable),
        "immutableAllocationCount":attempt_immutable.as_ref().ok().map(Vec::len),
        "counts":attempt_rows.as_ref().ok(),
        "observationErrors":{"liveJoin":attempt_join.as_ref().err().copied(),
            "occupancy":attempt_occupancy.as_ref().err().copied(),
            "immutableMetadata":attempt_immutable.as_ref().err().copied(),
            "counts":attempt_rows.as_ref().err().copied()}});
    let attempt_bytes =
        serde_json::to_vec_pretty(&attempt_audit).map_err(|_| "deadline-attempt-audit-encode")?;
    if attempt_bytes.len() > 8192 {
        return Err("deadline-attempt-audit-bound");
    }
    create(
        &paths.root.join("claim-deadline-attempt.json"),
        &attempt_bytes,
    )
    .map_err(|_| "deadline-attempt-audit-write")?;
    // The same evidence and assertion run in repaired and one-line-suppressed
    // binaries. A RED owner remains unconsumed through audit persistence.
    drop(attempted);
    observed(
        cases,
        "deadline-no-owner-after-final-live-lookup",
        no_owner
            && consumed_after == before
            && attempt_join?
            && attempt_occupancy? == (1, 1, 1)
            && attempt_immutable? == immutable,
        "deadline-refusal-keeps-coherent-committed-occupancy-no-handoff",
    )?;
    let same_caller = claim_native_child_run(app, window, &caller, &req, &frozen);
    observed(
        cases,
        "deadline-closed-caller-cannot-remint",
        matches!(
            same_caller,
            Err(ClaimRefusal::Freeze(FreezeRefusal::Unavailable))
        ) && actual_join(&paths, &known, &frozen, false)?
            && child_backend_consumptions() == before,
        "postcommit-expiry-never-restores-unclaimed",
    )?;
    drop(caller);
    // Remove the real parent publication before either recovery path. This is
    // historical retained-storage recovery with a test cutoff, NOT app restart.
    app.state::<crate::agent::AgentState>()
        .stop_all()
        .map_err(|_| "deadline-stop-parent")?;
    let cutoff = chrono::Utc::now();
    // Exercise the existing generic sweep and require its Result to succeed;
    // an unavailable sweep cannot masquerade as successful child protection.
    known.recheck(&paths)?;
    let generic = crate::runtime::open(&paths.config).map_err(|_| "deadline-generic-open")?;
    known.recheck(&paths)?;
    let generic_count =
        crate::runtime::dispatch::recover_orphaned_attended(&generic, cutoff, chrono::Utc::now())
            .map_err(|_| "deadline-generic-recovery")?;
    drop(generic);
    known.recheck(&paths)?;
    let protected =
        actual_join(&paths, &known, &frozen, false)? && occupancy(&paths, &known)? == (1, 1, 1);
    observed(
        cases,
        "deadline-generic-recovery-keeps-child-whole",
        protected
            && generic_count <= 1
            && !available(app, window, run)
            && child_backend_consumptions() == before,
        "generic-sweep-excludes-held-child-after-real-parent-stop",
    )?;
    let recovered =
        recover_unstarted_children(app, cutoff).map_err(|_| "deadline-historical-recovery")?;
    let terminal = interrupted_join(&paths, &known, &frozen)?;
    observed(
        cases,
        "deadline-historical-recovery-settles-without-owner",
        recovered == 1
            && terminal
            && occupancy(&paths, &known)? == (1, 0, 0)
            && immutable_allocations(&paths, &known)? == immutable
            && child_backend_consumptions() == before
            && recover_unstarted_children(app, cutoff).map_err(|_| "deadline-recovery-replay")?
                == 0,
        "historical-interruption-closes-claim-run-native-and-occupancy-once",
    )?;
    let final_rows = rows(&paths, &known)?;
    if !no_account_authority(&final_rows)
        || final_rows.runs != 2
        || final_rows.configurations != 1
        || final_rows.claims != 1
        || final_rows.native_jobs != 1
        || before != 0
        || child_backend_consumptions() != 0
    {
        return Err("deadline-final-effects-audit");
    }
    let audit = serde_json::json!({"format":1,"profile":"child-claim-deadline",
        "originalDeadline":req.deadline_at,"shortDeadlineSeconds":span,"claimRefusal":"Deadline",
        "ownedCreated":false,"closedBackendConsumptions":0,"genericRecoveryProtected":protected,
        "genericSweepSucceeded":true,"genericRecoveredParents":generic_count,
        "historicalRecoveryCount":recovered,"terminalJoin":terminal,"occupancy":[1,0,0],
        "actualParentRuns":1,"after":final_rows,"immutableAllocationRows":immutable,
        "nativeRestartRecovery":false,"backendIsolationVerified":false});
    let bytes = serde_json::to_vec_pretty(&audit).map_err(|_| "deadline-audit-encode")?;
    if bytes.len() > 8192 {
        return Err("deadline-audit-bound");
    }
    create(&paths.root.join("claim-deadline-audit.json"), &bytes)
        .map_err(|_| "deadline-audit-write")?;
    Ok(())
}
pub(super) fn report(
    paths: &SmokePaths,
    cases: &[Case],
    failed_stage: Option<&'static str>,
) -> serde_json::Value {
    let saw = |name| cases.iter().any(|c| c.name == name);
    serde_json::json!({"format":8,"profile":"child-claim-deadline",
        "observer":"native-injected-window-child-claim-phase-c-deadline","passed":failed_stage.is_none(),
        "failedStage":failed_stage,"cases":cases,"compiledInputs":compiled_inputs(),
        "claims":{"actualInjectedCommand":paths.started.load(Ordering::SeqCst),
            "actualOriginalCallerAndSameArc":saw("deadline-original-parent-reservation-same-arc"),
            "phaseCDeadlineNoOwner":saw("deadline-no-owner-after-final-live-lookup"),
            "closedCallerNoRemint":saw("deadline-closed-caller-cannot-remint"),
            "genericRecoveryProtected":saw("deadline-generic-recovery-keeps-child-whole"),
            "historicalRecoveryTerminal":saw("deadline-historical-recovery-settles-without-owner"),
            "childTokenOrProcess":false,"childConfiguration":false,"managedAccountAuthority":false,
            "providerNetwork":false,"publicExecution":false,"resultBodyRetention":false,
            "nativeRestartRecovery":false,"realCliAcceptance":false,"backendIsolationVerified":false},
        "timeBasis":"original wall-clock deadline; bounded test-only phase-C wait"})
}
