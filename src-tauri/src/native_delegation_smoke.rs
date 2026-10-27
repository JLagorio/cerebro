//! Separate fixed M95 profile; no credentials, real CLI, public API, or child run.
use super::*;
use crate::actions::native_owner::{
    prepare_native_delegation as prepare, reserve_native_delegation as reserve,
    NativeDelegationCaller, NativeDelegationRequest,
};
use crate::agent::child_jobs::types::{EvidenceRef, JobBudget, RequestedReadGrant};
use crate::runtime::child_jobs::Refusal;

const OBJECTIVE: &str = "M95_NATIVE_OBJECTIVE_CANARY_b926ad";
const EVIDENCE: &str = "evidence/M95_NATIVE_EVIDENCE_CANARY_b926ad.md";

fn request() -> Result<NativeDelegationRequest, &'static str> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| "delegation-clock")?
        .as_secs();
    Ok(NativeDelegationRequest {
        objective: OBJECTIVE.into(),
        instruction_source_version: "a".repeat(64),
        input_evidence_refs: vec![EvidenceRef {
            path: EVIDENCE.into(),
            sha256: "b".repeat(64),
        }],
        result_schema_id: "read_evidence_summary.v1".into(),
        requested_grant: RequestedReadGrant {
            read_scope: vec!["evidence".into()],
        },
        budget: JobBudget {
            elapsed_seconds: 600,
            result_bytes: 262_144,
        },
        deadline_at: now.checked_add(600).ok_or("delegation-clock-overflow")?,
    })
}

#[derive(PartialEq, Eq, Serialize)]
struct Counts {
    intents: i64,
    reservations: i64,
    runs: i64,
    configurations: i64,
    native_jobs: i64,
    account_grants: i64,
    connections: i64,
    connection_attempts: i64,
    secret_references: i64,
}
#[derive(PartialEq, Eq, Serialize)]
struct Audit {
    counts: Counts,
    metadata_digest: String,
}
impl Audit {
    fn delta_only(&self, before: &Self, intents: i64, reservations: i64) -> bool {
        intents >= 0
            && reservations >= 0
            && self.counts.intents == before.counts.intents + intents
            && self.counts.reservations == before.counts.reservations + reservations
            && self.counts.runs == before.counts.runs
            && self.counts.configurations == before.counts.configurations
            && self.counts.native_jobs == 0
            && self.counts.account_grants == 0
            && self.counts.connections == 0
            && self.counts.connection_attempts == 0
            && self.counts.secret_references == 0
    }
}

// Read-only observation after each completed door. Counts/digests never become
// authority, origin constructors, request keys, or recovery selectors.
fn audit(paths: &SmokePaths, known: &SettingsRuntime) -> Result<Audit, &'static str> {
    known.recheck(paths)?;
    let read =
        crate::runtime::ReadOnly::open(&paths.config).map_err(|_| "delegation-audit-open")?;
    known.recheck(paths)?;
    let counts = read.query_row(
        "SELECT (SELECT count(*) FROM chat_delegation_intents),         (SELECT count(*) FROM child_job_reservations),         (SELECT count(*) FROM runs),(SELECT count(*) FROM run_configurations),         (SELECT count(*) FROM action_native_runs WHERE source_kind='job'),         (SELECT count(*) FROM action_account_grants),(SELECT count(*) FROM managed_connections),         (SELECT count(*) FROM managed_connection_attempts),         (SELECT count(*) FROM managed_connections WHERE secret_ref IS NOT NULL)",
        [], |row| Ok(Counts { intents: row.get(0)?, reservations: row.get(1)?,
            runs: row.get(2)?, configurations: row.get(3)?, native_jobs: row.get(4)?,
            account_grants: row.get(5)?, connections: row.get(6)?,
            connection_attempts: row.get(7)?, secret_references: row.get(8)? }),
    ).map_err(|_| "delegation-audit-counts")?;
    if [
        counts.intents,
        counts.reservations,
        counts.runs,
        counts.configurations,
        counts.native_jobs,
        counts.account_grants,
        counts.connections,
        counts.connection_attempts,
        counts.secret_references,
    ]
    .into_iter()
    .any(|count| count < 0)
        || counts.intents > 64
        || counts.reservations > 64
    {
        return Err("delegation-audit-row-bound");
    }
    let mut hash = Sha256::new();
    hash.update(b"M95-native-smoke-metadata-v1\0");
    for (table, sql) in [
        (b"intent".as_slice(), "SELECT json_array(slot_id,request_key,parent_run_id,attempt_id,authority_id,authority_revision,owner_person,vault_id,store_uuid,parent_cli_session_id,app_session_id,actor_id,slot_ordinal) FROM chat_delegation_intents ORDER BY slot_id"),
        (b"reservation".as_slice(), "SELECT json_array(slot_id,job_id,reserved_run_id,reserved_cli_session_id,request_digest,deadline_at,elapsed_seconds,result_bytes,occupies_slot) FROM child_job_reservations ORDER BY slot_id"),
    ] {
        hash.update(table);
        let mut statement = read.prepare(sql).map_err(|_| "delegation-audit-prepare")?;
        let mut rows = statement.query([]).map_err(|_| "delegation-audit-query")?;
        let mut count = 0;
        while let Some(row) = rows.next().map_err(|_| "delegation-audit-next")? {
            count += 1;
            if count > 64 { return Err("delegation-audit-row-bound"); }
            let metadata: String = row.get(0).map_err(|_| "delegation-audit-row")?;
            if metadata.len() > 8192 || metadata.contains(OBJECTIVE) || metadata.contains(EVIDENCE) {
                return Err("delegation-metadata-privacy");
            }
            hash.update((metadata.len() as u64).to_be_bytes());
            hash.update(metadata.as_bytes());
        }
    }
    drop(read);
    known.recheck(paths)?;
    Ok(Audit {
        counts,
        metadata_digest: format!("{:x}", hash.finalize()),
    })
}

fn prepare_checked(
    app: &AppHandle,
    window: &WebviewWindow,
    paths: &SmokePaths,
    known: &SettingsRuntime,
    run: u64,
) -> Result<NativeDelegationCaller, &'static str> {
    let before = audit(paths, known)?;
    let caller = prepare(app, window, run).map_err(|_| "prepare-original-native-intent")?;
    let after = audit(paths, known)?;
    if !after.delta_only(&before, 1, 0) || after.metadata_digest == before.metadata_digest {
        return Err("prepared-intent-not-durable-before-reservation");
    }
    Ok(caller)
}

fn refusal_unchanged(
    app: &AppHandle,
    window: &WebviewWindow,
    paths: &SmokePaths,
    known: &SettingsRuntime,
    caller: &NativeDelegationCaller,
    request: &NativeDelegationRequest,
) -> Result<bool, &'static str> {
    let before = audit(paths, known)?;
    let refused = matches!(
        reserve(app, window, caller, request),
        Err(Refusal::Unavailable)
    );
    Ok(refused && audit(paths, known)? == before)
}
fn reap(app: &AppHandle) -> Result<(), &'static str> {
    app.state::<crate::agent::AgentState>()
        .stop_all()
        .map(|_| ())
        .map_err(|_| "delegation-reap")
}

// Deliberate fixture corruption only. Selects the latest committed intent's
// parent to advance its SQL revision; no row is used to construct a caller.
fn advance_revision(paths: &SmokePaths, known: &SettingsRuntime) -> Result<(), &'static str> {
    known.recheck(paths)?;
    let conn = crate::runtime::open_existing(&paths.config).map_err(|_| "revision-fixture-open")?;
    known.recheck(paths)?;
    let changed = conn.execute(
        "UPDATE action_native_runs SET revision=revision+1 WHERE run_id=(SELECT parent_run_id FROM chat_delegation_intents ORDER BY rowid DESC LIMIT 1)", [],
    ).map_err(|_| "revision-fixture-advance")?;
    drop(conn);
    known.recheck(paths)?;
    if changed != 1 {
        return Err("revision-fixture-count");
    }
    Ok(())
}

struct StoreSwap {
    store: PathBuf,
    held: PathBuf,
    original: SettingsIdentity,
    replacement: Option<SettingsIdentity>,
    restored: bool,
}
impl StoreSwap {
    fn install(paths: &SmokePaths) -> Result<Self, &'static str> {
        let store = crate::ledger::ledger_dir(&paths.vault_a).join("store.json");
        let held = store.with_file_name("store.delegation-original");
        let original = settings_identity(&store, false)?;
        let file = fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(&store)
            .map_err(|_| "delegation-store-read")?;
        let metadata = file.metadata().map_err(|_| "delegation-store-metadata")?;
        if !metadata.is_file()
            || metadata.len() > 4096
            || metadata.dev() != original.dev
            || metadata.ino() != original.ino
        {
            return Err("delegation-store-bound");
        }
        let mut bytes = Vec::new();
        file.take(4097)
            .read_to_end(&mut bytes)
            .map_err(|_| "delegation-store-bytes")?;
        if bytes.len() > 4096 || settings_identity(&store, false)? != original {
            return Err("delegation-store-changed");
        }
        settings_rename_exclusive(&store, &held)?;
        let mut value = Self {
            store,
            held,
            original,
            replacement: None,
            restored: false,
        };
        create(&value.store, &bytes).map_err(|_| "delegation-store-replacement")?;
        value.replacement = Some(settings_identity(&value.store, false)?);
        if value.replacement.as_ref() == Some(&value.original) {
            return Err("delegation-store-inode-reused");
        }
        Ok(value)
    }
    fn restore(&mut self) -> Result<(), &'static str> {
        if self.restored {
            return Ok(());
        }
        if settings_identity(&self.held, false)? != self.original {
            return Err("delegation-held-store-changed");
        }
        if let Some(replacement) = &self.replacement {
            if settings_identity(&self.store, false)? != *replacement {
                return Err("delegation-replacement-changed");
            }
            fs::remove_file(&self.store).map_err(|_| "delegation-remove-replacement")?;
            self.replacement = None;
        }
        if !settings_absent(&self.store) {
            return Err("delegation-restore-destination");
        }
        settings_rename_exclusive(&self.held, &self.store)?;
        self.restored = true;
        Ok(())
    }
}
impl Drop for StoreSwap {
    fn drop(&mut self) {
        let _ = self.restore();
    }
}

pub(super) fn capture(
    app: &AppHandle,
    window: &WebviewWindow,
    cases: &mut Vec<Case>,
) -> Result<(), &'static str> {
    let paths = app.state::<SmokePaths>();
    observed(
        cases,
        "delegation-before-opening",
        matches!(prepare(app, window, 9_000_000), Err(Refusal::Unavailable)),
        "unavailable",
    )?;
    open(app, window, &paths.vault_a)?;
    let known = SettingsRuntime::capture(&paths)?;
    let before = audit(&paths, &known)?;
    observed(
        cases,
        "delegation-unstarted-selector",
        matches!(prepare(app, window, 9_000_000), Err(Refusal::Unavailable))
            && audit(&paths, &known)? == before,
        "unavailable-metadata-unchanged",
    )?;
    let run = start(app, window, &paths.vault_a)?;
    observed(
        cases,
        "delegation-original-origin-catalog",
        available(app, window, run),
        "original-catalog-available",
    )?;
    let caller = prepare_checked(app, window, &paths, &known, run)?;
    observed(
        cases,
        "prepared-intent-before-reservation",
        true,
        "one-durable-intent-no-child-row",
    )?;
    let request = request()?;
    let before = audit(&paths, &known)?;
    let first =
        reserve(app, window, &caller, &request).map_err(|_| "reserve-original-native-intent")?;
    let reserved = audit(&paths, &known)?;
    observed(
        cases,
        "inert-reservation",
        reserved.delta_only(&before, 0, 1) && reserved.metadata_digest != before.metadata_digest,
        "one-reservation-no-run-config-grants",
    )?;
    let replay =
        reserve(app, window, &caller, &request).map_err(|_| "replay-original-native-intent")?;
    observed(
        cases,
        "same-caller-replay",
        first == replay && audit(&paths, &known)? == reserved,
        "same-identity-tuple-metadata-unchanged",
    )?;
    let mut changed = request.clone();
    changed.objective.push_str(" changed");
    observed(
        cases,
        "same-caller-changed-request",
        matches!(
            reserve(app, window, &caller, &changed),
            Err(Refusal::RequestKeyConflict)
        ) && audit(&paths, &known)? == reserved,
        "request-key-conflict-metadata-unchanged",
    )?;
    let fresh = prepare_checked(app, window, &paths, &known, run)?;
    drop(fresh);
    observed(
        cases,
        "fresh-prepare-is-new-intent",
        true,
        "new-intent-no-lost-caller-recovery",
    )?;
    crate::stop_agent(app.state(), run).map_err(|_| "delegation-stop")?;
    observed(
        cases,
        "retained-caller-after-stop",
        refusal_unchanged(app, window, &paths, &known, &caller, &request)?,
        "unavailable-metadata-unchanged",
    )?;
    reap(app)?;

    let run = start(app, window, &paths.vault_a)?;
    let caller = prepare_checked(app, window, &paths, &known, run)?;
    open(app, window, &paths.vault_a)?;
    observed(
        cases,
        "retained-caller-same-path-reopen",
        refusal_unchanged(app, window, &paths, &known, &caller, &request)?,
        "unavailable-metadata-unchanged",
    )?;
    reap(app)?;

    let run = start(app, window, &paths.vault_a)?;
    let caller = prepare_checked(app, window, &paths, &known, run)?;
    open(app, window, &paths.vault_b)?;
    open(app, window, &paths.vault_a)?;
    observed(
        cases,
        "retained-caller-opening-A-B-A",
        refusal_unchanged(app, window, &paths, &known, &caller, &request)?,
        "unavailable-metadata-unchanged",
    )?;
    reap(app)?;

    let run = start(app, window, &paths.vault_a)?;
    let caller = prepare_checked(app, window, &paths, &known, run)?;
    advance_revision(&paths, &known)?;
    observed(
        cases,
        "retained-caller-authority-revision",
        refusal_unchanged(app, window, &paths, &known, &caller, &request)?,
        "unavailable-metadata-unchanged",
    )?;
    reap(app)?;

    let run = start(app, window, &paths.vault_a)?;
    let caller = prepare_checked(app, window, &paths, &known, run)?;
    let mut replacement = StoreSwap::install(&paths)?;
    let refused = refusal_unchanged(app, window, &paths, &known, &caller, &request)?;
    replacement.restore()?;
    observed(
        cases,
        "retained-caller-same-id-new-store-inode",
        refused,
        "unavailable-metadata-unchanged",
    )?;
    reap(app)?;

    let run = start(app, window, &paths.vault_a)?;
    let caller = prepare_checked(app, window, &paths, &known, run)?;
    window.destroy().map_err(|_| "delegation-window-destroy")?;
    let deadline = Instant::now() + Duration::from_secs(3);
    while app.get_webview_window(crate::shell::MAIN_WINDOW).is_some() {
        if Instant::now() >= deadline {
            return Err("delegation-window-destroy-timeout");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    observed(
        cases,
        "retained-caller-destroyed-owner",
        refusal_unchanged(app, window, &paths, &known, &caller, &request)?,
        "unavailable-metadata-unchanged",
    )?;
    let final_audit = audit(&paths, &known)?;
    let bytes = serde_json::to_vec_pretty(&serde_json::json!({
        "format":1,"profile":"delegation-origin","audit":final_audit,
        "physicalIdentity":known,"metadataCanariesAbsent":true,
        "scope":"V39 intent/reservation metadata only"
    }))
    .map_err(|_| "delegation-audit-encode")?;
    if bytes.len() > 8192 {
        return Err("delegation-audit-output-bound");
    }
    create(&paths.root.join("delegation-audit.json"), &bytes)
        .map_err(|_| "delegation-audit-write")?;
    observed(
        cases,
        "delegation-metadata-privacy",
        true,
        "request-canaries-absent-from-job-metadata",
    )?;
    Ok(())
}

pub(super) fn report(
    paths: &SmokePaths,
    cases: &[Case],
    failed_stage: Option<&'static str>,
) -> serde_json::Value {
    let saw = |name| cases.iter().any(|case| case.name == name);
    serde_json::json!({
        "format":5,"profile":"delegation-origin","observer":"native-injected-window-delegation-origin-smoke",
        "passed":failed_stage.is_none(),"failedStage":failed_stage,"cases":cases,
        "compiledInputs":compiled_inputs(),
        "claims":{
            "actualInjectedCommand":paths.started.load(Ordering::SeqCst),
            "actualMacosWindow":saw("delegation-original-origin-catalog"),
            "actualOpeningAndRunPublication":saw("delegation-original-origin-catalog"),
            "providerFreeFixtureCli":saw("delegation-original-origin-catalog"),
            "callerOwnedDurableIntent":saw("prepared-intent-before-reservation"),
            "sameCallerInertReplay":saw("same-caller-replay"),
            "requestMetadataPrivacy":saw("delegation-metadata-privacy"),
            "publicExecution":false,"childRunOrConfiguration":false,"childCredentials":false,
            "grantIntersection":false,"childLaunchOrLifecycle":false,"providerNetwork":false,
            "realCliAcceptance":false,"nativeRestartRecovery":false,"lostCallerIdempotency":false
        },
        "timeBasis":"wall-clock deadlines; not deterministic performance evidence"
    })
}
