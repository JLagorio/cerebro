//! Fixed M95 actual-claim RED profile. Existing native parent; no child execution.
use super::*;
use crate::actions::native_owner::{
    attempt_frozen_child_start, child_backend_consumptions, claim_native_child_run,
    consume_native_child_backend, freeze_native_child, prepare_native_delegation,
    reserve_native_delegation, ClaimRefusal, FreezeRefusal, FrozenNativeChild, NativeChildMode,
    NativeDelegationCaller, NativeDelegationRequest, OwnedChildRun,
};
use crate::agent::child_jobs::types::{EvidenceRef, JobBudget, RequestedReadGrant};
use std::sync::Arc;

const EVIDENCE: &str = "projects/atlas/brief.md";
const EVIDENCE_BYTES: &[u8] = b"# Atlas\nM95_CLAIM_EVIDENCE_CANARY_14fa2c\n";
const OBJECTIVE: &str = "M95_CLAIM_OBJECTIVE_CANARY_14fa2c";
const CAUSAL_CASE: &str = "claim-actual-owned-run-and-closed-handoff";

fn request() -> Result<NativeDelegationRequest, &'static str> {
    let limits = crate::agent::child_jobs::limits::load().map_err(|_| "claim-policy")?;
    let instructions = crate::agent::cli_agents::preset_prompt("cerebro-researcher")
        .ok_or("claim-compiled-researcher")?;
    let now = crate::agent::child_jobs::freeze::now().map_err(|_| "claim-clock")?;
    Ok(NativeDelegationRequest {
        objective: OBJECTIVE.into(),
        instruction_source_version: crate::ledger::sha256_hex(instructions.as_bytes()),
        input_evidence_refs: vec![EvidenceRef {
            path: EVIDENCE.into(),
            sha256: crate::ledger::sha256_hex(EVIDENCE_BYTES),
        }],
        result_schema_id: "read_evidence_summary.v1".into(),
        requested_grant: RequestedReadGrant {
            read_scope: vec!["projects/atlas".into()],
        },
        budget: JobBudget {
            elapsed_seconds: u32::try_from(limits.max_elapsed_seconds)
                .map_err(|_| "claim-elapsed-policy-bound")?,
            result_bytes: u32::try_from(limits.max_result_bytes)
                .map_err(|_| "claim-result-policy-bound")?,
        },
        deadline_at: now
            .checked_add(limits.max_elapsed_seconds)
            .ok_or("claim-deadline-overflow")?,
    })
}
fn seed(paths: &SmokePaths) -> Result<(), &'static str> {
    for folder in ["projects", "projects/atlas"] {
        private_dir(&paths.vault_a.join(folder)).map_err(|_| "claim-fixture-folder")?;
    }
    create(&paths.vault_a.join(EVIDENCE), EVIDENCE_BYTES).map_err(|_| "claim-fixture-evidence")
}
fn start_parent(
    app: &AppHandle,
    window: &WebviewWindow,
    paths: &SmokePaths,
    session: Option<&str>,
) -> Result<u64, &'static str> {
    let request = serde_json::from_value(serde_json::json!({
        "message":"", "session_id":session, "attended":true, "connectors":false, "connector_names":[],
        "allowed_tools":["get_note","edit_note"], "scope":[], "read_scope":["projects"],
        "ask_first":true, "shell":"off", "web":false, "delegate":"off"
    }))
    .map_err(|_| "claim-parent-request-shape")?;
    let vault = paths.vault_a.to_str().ok_or("claim-vault-path")?.to_owned();
    match checked("run_agent", serde_json::json!({"vault":vault}), || {
        crate::run_agent(
            app.clone(),
            window.clone(),
            app.state(),
            vault,
            request,
            None,
            None,
            None,
            None,
        )
    })?
    .map_err(|_| "claim-actual-run-agent")?
    {
        crate::RunStart::Started(handle) => Ok(handle.run),
        _ => Err("claim-actual-parent-not-started"),
    }
}

#[derive(PartialEq, Eq, Serialize)]
struct Rows {
    intents: i64,
    reservations: i64,
    freezes: i64,
    runs: i64,
    configurations: i64,
    native_jobs: i64,
    account_grants: i64,
    connections: i64,
    connection_attempts: i64,
    secret_refs: i64,
    claim_table_present: bool,
    claims: i64,
}
fn rows(paths: &SmokePaths, known: &SettingsRuntime) -> Result<Rows, &'static str> {
    known.recheck(paths)?;
    let read = crate::runtime::ReadOnly::open(&paths.config).map_err(|_| "claim-audit-open")?;
    known.recheck(paths)?;
    let mut result = read.query_row(
        "SELECT (SELECT count(*) FROM chat_delegation_intents), (SELECT count(*) FROM child_job_reservations), (SELECT count(*) FROM child_job_grant_freezes), (SELECT count(*) FROM runs), (SELECT count(*) FROM run_configurations), (SELECT count(*) FROM action_native_runs WHERE source_kind='job'), (SELECT count(*) FROM action_account_grants), (SELECT count(*) FROM managed_connections), (SELECT count(*) FROM managed_connection_attempts), (SELECT count(*) FROM managed_connections WHERE secret_ref IS NOT NULL), EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='child_job_claims')",
        [], |row| Ok(Rows {
            intents: row.get(0)?, reservations: row.get(1)?, freezes: row.get(2)?,
            runs: row.get(3)?, configurations: row.get(4)?, native_jobs: row.get(5)?,
            account_grants: row.get(6)?, connections: row.get(7)?,
            connection_attempts: row.get(8)?, secret_refs: row.get(9)?,
            claim_table_present: row.get(10)?, claims: 0,
        }),
    ).map_err(|_| "claim-audit-existing-rows")?;
    // Known absence is an observable baseline, not a missing-table query error.
    // A present but unreadable/malformed table is an infrastructure failure.
    if result.claim_table_present {
        result.claims = read
            .query_row("SELECT count(*) FROM child_job_claims", [], |row| {
                row.get(0)
            })
            .map_err(|_| "claim-audit-claim-rows")?;
    }
    drop(read);
    known.recheck(paths)?;
    Ok(result)
}
fn no_account_authority(rows: &Rows) -> bool {
    rows.account_grants == 0
        && rows.connections == 0
        && rows.connection_attempts == 0
        && rows.secret_refs == 0
}
fn original_binding(
    paths: &SmokePaths,
    known: &SettingsRuntime,
    capsule: &FrozenNativeChild,
) -> Result<bool, &'static str> {
    known.recheck(paths)?;
    let read = crate::runtime::ReadOnly::open(&paths.config).map_err(|_| "claim-binding-open")?;
    known.recheck(paths)?;
    let view = capsule.view();
    let matched: i64 = read.query_row(
        "SELECT count(*) FROM child_job_reservations r JOIN child_job_grant_freezes f ON f.slot_id=r.slot_id JOIN chat_delegation_intents i ON i.slot_id=r.slot_id JOIN runs p ON p.run_id=i.parent_run_id JOIN action_native_runs n ON n.run_id=p.run_id WHERE r.job_id=?1 AND r.reserved_run_id=?2 AND r.reserved_cli_session_id=?3 AND r.request_digest=?4 AND r.deadline_at=?5 AND f.contract_digest=?6 AND f.instruction_source_version=?7 AND r.occupies_slot=1 AND p.outcome='running' AND p.ended_at IS NULL AND n.source_kind='run' AND n.child_job_id IS NULL AND n.authority_id=i.authority_id AND n.owner_person=i.owner_person AND n.vault_id=i.vault_id AND n.store_uuid=i.store_uuid AND n.cli_session_id=i.parent_cli_session_id AND n.app_session_id=i.app_session_id",
        rusqlite::params![view.allocation.job_id, view.allocation.run_id, view.allocation.session_id,
            view.allocation.request_digest, i64::try_from(view.allocation.deadline_at)
                .map_err(|_| "claim-binding-deadline")?, view.contract_digest,
            view.instruction_source_version],
        |row| row.get(0),
    ).map_err(|_| "claim-binding-existing-join")?;
    drop(read);
    known.recheck(paths)?;
    Ok(matched == 1)
}

// This independent SQL observer cannot construct a caller, owner or grant.
// The first claim migration must supply the four selected claim columns;
// additional immutable metadata is for the implementation/review to settle.
fn actual_join(
    paths: &SmokePaths,
    known: &SettingsRuntime,
    capsule: &FrozenNativeChild,
    terminal: bool,
) -> Result<bool, &'static str> {
    known.recheck(paths)?;
    let read = crate::runtime::ReadOnly::open(&paths.config).map_err(|_| "claim-join-open")?;
    known.recheck(paths)?;
    let present: bool = read.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='child_job_claims')",
        [], |row| row.get(0),
    ).map_err(|_| "claim-join-schema-observation")?;
    if !present {
        drop(read);
        known.recheck(paths)?;
        return Ok(false);
    }
    let view = capsule.view();
    let matched: i64 = read.query_row(
        "SELECT count(*) FROM child_job_claims j JOIN child_job_reservations r ON r.slot_id=j.slot_id JOIN child_job_grant_freezes f ON f.slot_id=r.slot_id JOIN chat_delegation_intents i ON i.slot_id=r.slot_id JOIN runs p ON p.run_id=i.parent_run_id JOIN action_native_runs pn ON pn.run_id=p.run_id JOIN runs c ON c.run_id=r.reserved_run_id JOIN action_native_runs n ON n.run_id=c.run_id WHERE r.job_id=?1 AND r.reserved_run_id=?2 AND r.reserved_cli_session_id=?3 AND r.request_digest=?4 AND r.deadline_at=?5 AND f.contract_digest=?6 AND f.instruction_source_version=?7 AND length(j.claim_id)=32 AND j.claim_id NOT GLOB '*[^0-9a-f]*' AND c.parent_run_id=p.run_id AND c.vault_id=i.vault_id AND c.store_uuid=i.store_uuid AND c.cli_session_id=r.reserved_cli_session_id AND c.actor='job:'||r.job_id AND c.mode='attended' AND c.configuration_capture='required' AND json_extract(c.cause,'$.kind')='handoff' AND n.source_kind='job' AND n.child_job_id=r.job_id AND n.parent_run_id=p.run_id AND n.cli_session_id=c.cli_session_id AND n.actor_id=c.actor AND n.client_id IS NULL AND n.vault_id=i.vault_id AND n.store_uuid=i.store_uuid AND n.owner_person=i.owner_person AND n.app_session_id=i.app_session_id AND n.canonical_vault_path=pn.canonical_vault_path AND n.authority_id<>pn.authority_id AND ((?8=0 AND j.state='claimed' AND j.ended_at IS NULL AND r.occupies_slot=1 AND c.outcome='running' AND c.ended_at IS NULL AND c.usage_state='pending' AND n.closed_at IS NULL AND n.close_kind IS NULL) OR (?8=1 AND j.state='backend_unavailable' AND j.ended_at IS NOT NULL AND r.occupies_slot=0 AND c.outcome='failed' AND c.ended_at IS NOT NULL AND c.usage_state='unknown' AND n.closed_at IS NOT NULL AND n.close_kind='completed'))",
        rusqlite::params![view.allocation.job_id, view.allocation.run_id, view.allocation.session_id,
            view.allocation.request_digest, i64::try_from(view.allocation.deadline_at)
                .map_err(|_| "claim-join-deadline")?, view.contract_digest,
            view.instruction_source_version, if terminal { 1_i64 } else { 0_i64 }],
        |row| row.get(0),
    ).map_err(|_| "claim-join-query")?;
    drop(read);
    known.recheck(paths)?;
    Ok(matched == 1)
}

fn own_child(
    app: &AppHandle,
    window: &WebviewWindow,
    run: u64,
    request: &NativeDelegationRequest,
) -> Result<
    (
        NativeDelegationCaller,
        Arc<FrozenNativeChild>,
        OwnedChildRun,
    ),
    &'static str,
> {
    let caller = prepare_native_delegation(app, window, run).map_err(|_| "sequence-prepare")?;
    reserve_native_delegation(app, window, &caller, request).map_err(|_| "sequence-reserve")?;
    let frozen = freeze_native_child(
        app,
        window,
        &caller,
        request,
        NativeChildMode::LocalResearcher,
    )
    .map_err(|_| "sequence-freeze")?;
    let owned = claim_native_child_run(app, window, &caller, request, &frozen)
        .map_err(|_| "sequence-claim")?;
    Ok((caller, frozen, owned))
}
fn occupancy(paths: &SmokePaths, known: &SettingsRuntime) -> Result<(i64, i64, i64), &'static str> {
    known.recheck(paths)?;
    let read = crate::runtime::ReadOnly::open(&paths.config).map_err(|_| "sequence-read")?;
    let counts=read.query_row("SELECT count(*),coalesce(sum(occupies_slot),0),(SELECT count(*) FROM child_job_claims WHERE state='claimed') FROM child_job_reservations",
        [],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).map_err(|_|"sequence-counts")?;
    drop(read);
    known.recheck(paths)?;
    Ok(counts)
}
fn immutable_allocations(
    paths: &SmokePaths,
    known: &SettingsRuntime,
) -> Result<Vec<String>, &'static str> {
    known.recheck(paths)?;
    let read =
        crate::runtime::ReadOnly::open(&paths.config).map_err(|_| "sequence-immutable-read")?;
    let rows = {
        let mut statement=read.prepare("SELECT json_array(slot_id,job_id,reserved_run_id,reserved_cli_session_id,request_digest,deadline_at,elapsed_seconds,result_bytes) FROM child_job_reservations ORDER BY slot_id")
            .map_err(|_|"sequence-immutable-prepare")?;
        let rows = statement
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|_| "sequence-immutable-query")?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|_| "sequence-immutable-rows")?
    };
    drop(read);
    known.recheck(paths)?;
    Ok(rows)
}
fn sequential(
    app: &AppHandle,
    window: &WebviewWindow,
    paths: &SmokePaths,
    known: &SettingsRuntime,
    run: u64,
    cases: &mut Vec<Case>,
) -> Result<(), &'static str> {
    use crate::runtime::child_jobs::Refusal;
    let req = request()?;
    let (first_caller, first, one) = own_child(app, window, run, &req)?;
    // The first real run is already committed; only NOW create the second intent.
    let (_, second, two) = own_child(app, window, run, &req)?;
    let third = prepare_native_delegation(app, window, run).map_err(|_| "sequence-third-intent")?;
    let before = rows(paths, known)?;
    let immutable = immutable_allocations(paths, known)?;
    observed(
        cases,
        "claim-first-before-second-third-exact-concurrency",
        actual_join(paths, known, &first, false)?
            && actual_join(paths, known, &second, false)?
            && occupancy(paths, known)? == (3, 2, 2)
            && reserve_native_delegation(app, window, &third, &req).err()
                == Some(Refusal::Concurrency)
            && rows(paths, known)? == before
            && immutable_allocations(paths, known)? == immutable,
        "actual-claims-before-next-reservation-no-pre-reserved-pair",
    )?;
    observed(
        cases,
        "claim-owned-replay-does-not-remint",
        claim_native_child_run(app, window, &first_caller, &req, &first).err()
            == Some(ClaimRefusal::AlreadyClaimed)
            && rows(paths, known)? == before,
        "one-owner-outstanding",
    )?;
    consume_native_child_backend(app, window, one).map_err(|_| "sequence-settle-one")?;
    observed(
        cases,
        "claim-terminal-replay-is-descriptive-only",
        matches!(
            claim_native_child_run(app, window, &first_caller, &req, &first),
            Err(ClaimRefusal::Terminal(_))
        ) && actual_join(paths, known, &first, true)?,
        "terminal-caller-never-remints-owner",
    )?;
    let retried = reserve_native_delegation(app, window, &third, &req)
        .map_err(|_| "sequence-retry-same-third")?;
    let third_frozen =
        freeze_native_child(app, window, &third, &req, NativeChildMode::LocalResearcher)
            .map_err(|_| "sequence-freeze-third")?;
    let three = claim_native_child_run(app, window, &third, &req, &third_frozen)
        .map_err(|_| "sequence-claim-third")?;
    observed(
        cases,
        "claim-settle-one-retry-original-third",
        third_frozen.view().allocation == &retried
            && occupancy(paths, known)? == (4, 2, 2)
            && actual_join(paths, known, &first, true)?
            && actual_join(paths, known, &second, false)?
            && actual_join(paths, known, &third_frozen, false)?
            && immutable.iter().all(|row| {
                immutable_allocations(paths, known).is_ok_and(|current| current.contains(row))
            }),
        "settlement-releases-only-one-same-intention-retry",
    )?;
    consume_native_child_backend(app, window, three).map_err(|_| "sequence-settle-three")?;
    consume_native_child_backend(app, window, two).map_err(|_| "sequence-settle-two")?;
    let maximum = crate::agent::child_jobs::limits::load()
        .map_err(|_| "sequence-policy")?
        .max_admissions;
    for _ in 4..maximum {
        let (_, capsule, owner) = own_child(app, window, run, &req)?;
        if !actual_join(paths, known, &capsule, false)? {
            return Err("sequence-cycle-live-join");
        }
        consume_native_child_backend(app, window, owner).map_err(|_| "sequence-cycle-consume")?;
        if !actual_join(paths, known, &capsule, true)? {
            return Err("sequence-cycle-terminal-join");
        }
    }
    let retained = immutable_allocations(paths, known)?;
    observed(
        cases,
        "claim-eight-lifetime-zero-terminal-occupancy",
        maximum == 8 && occupancy(paths, known)? == (i64::from(maximum), 0, 0),
        "all-actual-admissions-count-forever",
    )?;
    let read = crate::runtime::ReadOnly::open(&paths.config)
        .map_err(|_| "sequence-parent-session-read")?;
    let session:String=read.query_row("SELECT p.cli_session_id FROM runs p JOIN child_job_reservations r ON r.reserved_run_id=?1 JOIN chat_delegation_intents i ON i.slot_id=r.slot_id WHERE p.run_id=i.parent_run_id",
        [&first.view().allocation.run_id],|r|r.get(0)).map_err(|_|"sequence-actual-parent-session")?;
    drop(read);
    known.recheck(paths)?;
    app.state::<crate::agent::AgentState>()
        .stop_all()
        .map_err(|_| "sequence-stop-original-parent")?;
    let resumed = start_parent(app, window, paths, Some(&session))?;
    let ninth = prepare_native_delegation(app, window, resumed)
        .map_err(|_| "sequence-resumed-original-intent")?;
    let next = request()?;
    let before_ninth = rows(paths, known)?;
    let read =
        crate::runtime::ReadOnly::open(&paths.config).map_err(|_| "sequence-resumed-join-read")?;
    let resumed_join:bool=read.query_row("SELECT count(*)=1 FROM action_native_runs n JOIN runs r ON r.run_id=n.run_id WHERE n.source_kind='run' AND n.parent_run_id IS NULL AND n.cli_session_id=?1 AND r.cli_session_id=n.cli_session_id AND n.close_kind IS NULL AND r.outcome='running' AND r.ended_at IS NULL",
        [&session],|r|r.get(0)).map_err(|_|"sequence-resumed-native-join")?;
    drop(read);
    known.recheck(paths)?;
    observed(
        cases,
        "claim-resumed-actual-session-ninth-exact-lifetime-refusal",
        resumed_join
            && available(app, window, resumed)
            && reserve_native_delegation(app, window, &ninth, &next).err()
                == Some(Refusal::SessionAdmissions)
            && rows(paths, known)? == before_ninth
            && immutable_allocations(paths, known)? == retained
            && occupancy(paths, known)? == (i64::from(maximum), 0, 0),
        "new-native-parent-same-real-session-keeps-lifetime",
    )?;
    let final_rows = rows(paths, known)?;
    if final_rows.reservations != i64::from(maximum)
        || final_rows.claims != i64::from(maximum)
        || final_rows.native_jobs != i64::from(maximum)
        || final_rows.runs != i64::from(maximum) + 2
        || final_rows.configurations != 2
        || !no_account_authority(&final_rows)
        || child_backend_consumptions() != u64::from(maximum)
    {
        return Err("sequence-final-child-versus-parent-audit");
    }
    let audit = serde_json::json!({"format":1,"profile":"child-claim-sequential",
        "actualParentRuns":2,"resumedActualSessionJoin":resumed_join,"after":final_rows,
        "occupancy":occupancy(paths,known)?,"closedBackendConsumptions":child_backend_consumptions(),
        "immutableAllocationRows":retained,"backendIsolationVerified":false,"restartRecoveryAccepted":false});
    let bytes = serde_json::to_vec_pretty(&audit).map_err(|_| "sequence-audit-encode")?;
    if bytes.len() > 16384 {
        return Err("sequence-audit-bound");
    }
    create(&paths.root.join("claim-sequential-audit.json"), &bytes)
        .map_err(|_| "sequence-audit-write")?;
    Ok(())
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
    observed(
        cases,
        "claim-original-scoped-parent",
        available(app, window, run),
        "actual-native-opening-and-publication",
    )?;
    let request = request()?;
    let caller =
        prepare_native_delegation(app, window, run).map_err(|_| "claim-prepare-original-intent")?;
    let allocation = reserve_native_delegation(app, window, &caller, &request)
        .map_err(|_| "claim-reserve-original-intent")?;
    let reserved = rows(&paths, &known)?;
    observed(
        cases,
        "claim-original-reservation",
        reserved.intents == 1
            && reserved.reservations == 1
            && reserved.freezes == 0
            && reserved.runs == 1
            && reserved.configurations == 1
            && reserved.native_jobs == 0
            && reserved.claims == 0
            && no_account_authority(&reserved),
        "one-original-reservation-one-parent-no-child",
    )?;
    let capsule = freeze_native_child(
        app,
        window,
        &caller,
        &request,
        NativeChildMode::LocalResearcher,
    )
    .map_err(|_| "claim-freeze-valid-original-parent")?;
    let view = capsule.view();
    observed(
        cases,
        "claim-local-compiled-freeze",
        view.allocation == &allocation
            && view
                .read_scope
                .iter()
                .map(String::as_str)
                .eq(["projects/atlas"])
            && view.tools.iter().map(String::as_str).eq(["get_note"])
            && view.instruction_source_version == request.instruction_source_version
            && view.evidence.len() == 1
            && view.evidence[0].path == EVIDENCE
            && view.evidence[0].sha256 == crate::ledger::sha256_hex(EVIDENCE_BYTES),
        "actual-compiled-readonly-capsule",
    )?;
    let replay = freeze_native_child(
        app,
        window,
        &caller,
        &request,
        NativeChildMode::LocalResearcher,
    )
    .map_err(|_| "claim-replay-original-freeze")?;
    observed(
        cases,
        "claim-same-caller-capsule-replay",
        Arc::ptr_eq(&capsule, &replay),
        "same-retained-arc-no-reconstruction",
    )?;
    let before = rows(&paths, &known)?;
    observed(
        cases,
        "claim-freeze-only-original-binding",
        before.intents == 1
            && before.reservations == 1
            && before.freezes == 1
            && before.runs == 1
            && before.configurations == 1
            && before.native_jobs == 0
            && before.claims == 0
            && no_account_authority(&before)
            && original_binding(&paths, &known, &capsule)?,
        "existing-v40-tuple-no-child-claim",
    )?;
    observed(
        cases,
        "claim-public-backend-stays-unverified",
        attempt_frozen_child_start(app, window, &capsule).err()
            == Some(FreezeRefusal::BackendIsolationUnverified)
            && rows(&paths, &known)? == before,
        "existing-start-gate-remains-closed",
    )?;

    // All real native prerequisites above must pass before the intended RED.
    // Absence of the new schema is measured, never queried as a missing table.
    let consumed_before = child_backend_consumptions();
    let attempted = claim_native_child_run(app, window, &caller, &request, &capsule);
    let owned_created = attempted.is_ok();
    let refusal = match attempted.as_ref().err() {
        None => None,
        Some(ClaimRefusal::Freeze(FreezeRefusal::BackendIsolationUnverified)) => {
            Some("BackendIsolationUnverified")
        }
        Some(_) => Some("UnexpectedRefusal"),
    };
    let claimed = rows(&paths, &known)?;
    let claimed_join = actual_join(&paths, &known, &capsule, false)?;
    let receipt = match attempted {
        Ok(owner) => Some(
            consume_native_child_backend(app, window, owner)
                .map_err(|_| "claim-closed-consumer-unavailable")?,
        ),
        Err(_) => None,
    };
    let same_capsule_consumed = receipt.as_ref().is_some_and(|receipt| {
        receipt.holds(&capsule) && receipt.refusal() == FreezeRefusal::BackendIsolationUnverified
    });
    let consumed_after = child_backend_consumptions();
    let consumed = consumed_after
        .checked_sub(consumed_before)
        .ok_or("claim-consumer-count-regressed")?;
    let settled = rows(&paths, &known)?;
    let terminal_join = actual_join(&paths, &known, &capsule, true)?;
    let audit = serde_json::json!({
        "format":1,"profile":"child-claim","before":&before,"claimed":&claimed,"settled":&settled,
        "ownedCreated":owned_created,"claimRefusal":refusal,"claimedJoin":claimed_join,
        "closedBackendConsumptions":consumed,"consumptionsBefore":consumed_before,
        "consumptionsAfter":consumed_after,"sameCapsuleConsumed":same_capsule_consumed,
        "terminalJoin":terminal_join,"physicalIdentity":known,
        "scope":"actual child claim and fixed closed consumer; no token or process"
    });
    let bytes = serde_json::to_vec_pretty(&audit).map_err(|_| "claim-audit-encode")?;
    if bytes.len() > 8192 {
        return Err("claim-audit-output-bound");
    }
    create(&paths.root.join("claim-audit.json"), &bytes).map_err(|_| "claim-audit-write")?;
    observed(
        cases,
        CAUSAL_CASE,
        owned_created
            && claimed_join
            && terminal_join
            && same_capsule_consumed
            && consumed_before == 0
            && consumed_after == 1
            && consumed == 1
            && claimed.intents == 1
            && claimed.reservations == 1
            && claimed.freezes == 1
            && claimed.runs == 2
            && claimed.native_jobs == 1
            && claimed.claims == 1
            && claimed.configurations == 1
            && no_account_authority(&claimed)
            && settled.intents == 1
            && settled.reservations == 1
            && settled.freezes == 1
            && settled.runs == 2
            && settled.native_jobs == 1
            && settled.claims == 1
            && settled.configurations == 1
            && no_account_authority(&settled),
        "one-actual-claim-run-native-join-one-owned-closed-handoff-and-settlement",
    )?;
    sequential(app, window, &paths, &known, run, cases)?;
    app.state::<crate::agent::AgentState>()
        .stop_all()
        .map_err(|_| "claim-reap-parent")?;
    Ok(())
}
pub(super) fn report(
    paths: &SmokePaths,
    cases: &[Case],
    failed_stage: Option<&'static str>,
) -> serde_json::Value {
    let saw = |name| cases.iter().any(|case| case.name == name);
    serde_json::json!({
        "format":7,"profile":"child-claim","observer":"native-injected-window-child-claim",
        "passed":failed_stage.is_none(),"failedStage":failed_stage,"cases":cases,
        "compiledInputs":compiled_inputs(),
        "claims":{
            "actualInjectedCommand":paths.started.load(Ordering::SeqCst),
            "actualOriginalParent":saw("claim-original-scoped-parent"),
            "actualOriginalReservation":saw("claim-original-reservation"),
            "actualCompiledFreeze":saw("claim-local-compiled-freeze"),
            "sameCallerCapsuleReplay":saw("claim-same-caller-capsule-replay"),
            "existingStartGateClosed":saw("claim-public-backend-stays-unverified"),
            "actualClaimAndOwnedClosedHandoff":saw(CAUSAL_CASE),
            "childTokenOrProcess":false,"childConfiguration":false,
            "managedAccountAuthority":false,"providerNetwork":false,
            "realCliAcceptance":false,"publicExecution":false,"resultBodyRetention":false,
            "sequentialAdmissionsAcceptance":saw("claim-resumed-actual-session-ninth-exact-lifetime-refusal"),"restartRecoveryAcceptance":false
        },"timeBasis":"wall-clock deadline; no performance claim"
    })
}

// Separate fixed profile: the healthy thirteen-case capture/report are intact.
#[path = "native_child_claim_deadline_smoke.rs"]
mod deadline_profile;
pub(super) fn capture_deadline(
    app: &AppHandle,
    window: &WebviewWindow,
    cases: &mut Vec<Case>,
) -> Result<(), &'static str> {
    deadline_profile::capture(app, window, cases)
}
pub(super) fn report_deadline(
    paths: &SmokePaths,
    cases: &[Case],
    failed_stage: Option<&'static str>,
) -> serde_json::Value {
    deadline_profile::report(paths, cases, failed_stage)
}

#[path = "native_restart_smoke.rs"]
pub(crate) mod restart_profile;
