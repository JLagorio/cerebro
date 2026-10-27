//! Fixed local-only M95 freeze profile. Actual native origin; fixture CLI only.
use super::*;
use crate::actions::native_owner::{
    attempt_frozen_child_start, freeze_native_child as freeze,
    prepare_native_delegation as prepare, reserve_native_delegation as reserve, FreezeRefusal,
    FrozenNativeChild, NativeChildMode, NativeDelegationCaller, NativeDelegationRequest,
};
use crate::agent::child_jobs::types::{EvidenceRef, JobBudget, RequestedReadGrant};
use crate::runtime::child_jobs::Allocation;
use std::sync::Arc;

const PROMPT: &str = include_str!("../../shared/prompt/subagents/researcher.md");
const OBJECTIVE: &str = "M95_FREEZE_OBJECTIVE_CANARY_823df1";
const FIRST: &str = "projects/atlas/brief.md";
const SECOND: &str = "knowledge/topic/reference.md";
const MAIL: &str = "sources/mail/private.md";
const PRIVATE_BYTES: &[u8] = b"# Private\nOutside requested scope.\n";
const FIRST_BYTES: &[u8] = b"# Atlas\nM95_FREEZE_EVIDENCE_CANARY_823df1\n";
const SECOND_BYTES: &[u8] = b"# Reference\nA bounded local fixture.\n";
const PARENT_SCOPE: &[&str] = &["projects/atlas", "knowledge"];
const PARENT_TOOLS: &[&str] = &[
    "search_notes",
    "get_note",
    "edit_note",
    "hand_to",
    "navigate",
    "comment_on_note",
];

fn now() -> Result<u64, &'static str> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .map_err(|_| "freeze-clock")
}
// Actual existing policy and prompt loader; no copied preset or user config read.
fn compiled_source() -> Result<&'static str, &'static str> {
    let preset = crate::policy::subagents::presets()
        .iter()
        .find(|preset| preset.name == "cerebro-researcher")
        .ok_or("freeze-compiled-preset-unavailable")?;
    crate::agent::cli_agents::preset_prompt(&preset.name)
        .ok_or("freeze-compiled-prompt-unavailable")
}
fn request() -> Result<NativeDelegationRequest, &'static str> {
    Ok(NativeDelegationRequest {
        objective: OBJECTIVE.into(),
        instruction_source_version: crate::ledger::sha256_hex(compiled_source()?.as_bytes()),
        input_evidence_refs: vec![
            EvidenceRef {
                path: FIRST.into(),
                sha256: crate::ledger::sha256_hex(FIRST_BYTES),
            },
            EvidenceRef {
                path: SECOND.into(),
                sha256: crate::ledger::sha256_hex(SECOND_BYTES),
            },
        ],
        result_schema_id: "read_evidence_summary.v1".into(),
        requested_grant: RequestedReadGrant {
            read_scope: vec!["projects".into(), "knowledge/topic".into()],
        },
        budget: JobBudget {
            elapsed_seconds: 600,
            result_bytes: 262_144,
        },
        deadline_at: now()?.checked_add(600).ok_or("freeze-clock-overflow")?,
    })
}
fn seed(paths: &SmokePaths) -> Result<(), &'static str> {
    for folder in [
        "projects",
        "projects/atlas",
        "knowledge",
        "knowledge/topic",
        "private",
        "public",
        "sources",
        "sources/mail",
    ] {
        private_dir(&paths.vault_a.join(folder)).map_err(|_| "freeze-fixture-folder")?;
    }
    for (name, bytes) in [
        (FIRST, FIRST_BYTES),
        (SECOND, SECOND_BYTES),
        ("private/blocked.md", PRIVATE_BYTES),
        (MAIL, PRIVATE_BYTES),
    ] {
        create(&paths.vault_a.join(name), bytes).map_err(|_| "freeze-fixture-page")?;
    }
    std::os::unix::fs::symlink(
        "../private/blocked.md",
        paths.vault_a.join("public/alias.md"),
    )
    .map_err(|_| "freeze-fixture-contained-symlink")?;
    Ok(())
}
fn start_scoped(
    app: &AppHandle,
    window: &WebviewWindow,
    paths: &SmokePaths,
    scope: &[&str],
    tools: &[&str],
) -> Result<u64, &'static str> {
    let request = serde_json::from_value(serde_json::json!({
        "message":"", "attended":true, "connectors":false, "connector_names":[],
        "allowed_tools":tools, "scope":[], "read_scope":scope,
        "ask_first":true, "shell":"off", "web":false, "delegate":"off"
    }))
    .map_err(|_| "freeze-parent-request-shape")?;
    let vault = paths
        .vault_a
        .to_str()
        .ok_or("freeze-vault-path")?
        .to_owned();
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
    .map_err(|_| "freeze-actual-run-agent")?
    {
        crate::RunStart::Started(handle) => Ok(handle.run),
        _ => Err("freeze-actual-run-not-started"),
    }
}
fn reap(app: &AppHandle) -> Result<(), &'static str> {
    app.state::<crate::agent::AgentState>()
        .stop_all()
        .map(|_| ())
        .map_err(|_| "freeze-reap")
}

#[derive(PartialEq, Eq, Serialize)]
struct BaseCounts {
    intents: i64,
    reservations: i64,
    runs: i64,
    configurations: i64,
    native_jobs: i64,
    grants: i64,
    connections: i64,
    attempts: i64,
    secrets: i64,
}
fn counts(paths: &SmokePaths, known: &SettingsRuntime) -> Result<BaseCounts, &'static str> {
    known.recheck(paths)?;
    let read = crate::runtime::ReadOnly::open(&paths.config).map_err(|_| "freeze-audit-open")?;
    known.recheck(paths)?;
    let values = read.query_row(
        "SELECT (SELECT count(*) FROM chat_delegation_intents), (SELECT count(*) FROM child_job_reservations), (SELECT count(*) FROM runs), (SELECT count(*) FROM run_configurations), (SELECT count(*) FROM action_native_runs WHERE source_kind='job'), (SELECT count(*) FROM action_account_grants), (SELECT count(*) FROM managed_connections), (SELECT count(*) FROM managed_connection_attempts), (SELECT count(*) FROM managed_connections WHERE secret_ref IS NOT NULL)",
        [], |row| Ok(BaseCounts { intents:row.get(0)?, reservations:row.get(1)?, runs:row.get(2)?, configurations:row.get(3)?, native_jobs:row.get(4)?, grants:row.get(5)?, connections:row.get(6)?, attempts:row.get(7)?, secrets:row.get(8)? }),
    ).map_err(|_| "freeze-audit-counts")?;
    if values.native_jobs != 0
        || values.grants != 0
        || values.connections != 0
        || values.attempts != 0
        || values.secrets != 0
    {
        return Err("freeze-created-execution-authority");
    }
    drop(read);
    known.recheck(paths)?;
    Ok(values)
}
#[derive(PartialEq, Eq, Serialize)]
struct FrozenRows {
    count: u32,
    digest: String,
}
// Called only after the first freeze succeeds: missing V40 is not RED setup.
// These observations never construct a capsule or restore an opaque caller.
fn frozen_rows(paths: &SmokePaths, known: &SettingsRuntime) -> Result<FrozenRows, &'static str> {
    known.recheck(paths)?;
    let read = crate::runtime::ReadOnly::open(&paths.config).map_err(|_| "freeze-rows-open")?;
    known.recheck(paths)?;
    // Audit the full column set, including hidden/generated columns, so an
    // added content column cannot hide outside this bounded digest projection.
    let mut schema = read
        .prepare("SELECT name FROM pragma_table_xinfo('child_job_grant_freezes') ORDER BY cid")
        .map_err(|_| "freeze-schema-read")?;
    let mut columns = schema.query([]).map_err(|_| "freeze-schema-query")?;
    let mut names = Vec::new();
    while let Some(row) = columns.next().map_err(|_| "freeze-schema-next")? {
        if names.len() == 4 {
            return Err("freeze-unexpected-metadata-column");
        }
        names.push(
            row.get::<_, String>(0)
                .map_err(|_| "freeze-schema-column")?,
        );
    }
    if !names.iter().map(String::as_str).eq([
        "slot_id",
        "contract_digest",
        "instruction_source_version",
        "policy_digest",
    ]) {
        return Err("freeze-metadata-schema-is-not-digest-only");
    }
    drop(columns);
    drop(schema);
    let mut statement = read.prepare(
        "SELECT json_array(slot_id,contract_digest,instruction_source_version,policy_digest) FROM child_job_grant_freezes ORDER BY slot_id",
    ).map_err(|_| "freeze-metadata-table-unavailable")?;
    let mut rows = statement.query([]).map_err(|_| "freeze-rows-query")?;
    let mut count = 0_u32;
    let mut hash = Sha256::new();
    hash.update(b"M95-native-frozen-metadata-v1\0");
    while let Some(row) = rows.next().map_err(|_| "freeze-rows-next")? {
        count = count.checked_add(1).ok_or("freeze-rows-bound")?;
        if count > 64 {
            return Err("freeze-rows-bound");
        }
        let encoded: String = row.get(0).map_err(|_| "freeze-rows-text")?;
        if encoded.len() > 1024
            || [
                OBJECTIVE,
                FIRST,
                SECOND,
                "projects/atlas",
                "knowledge/topic",
                "You research one question",
            ]
            .iter()
            .any(|canary| encoded.contains(*canary))
        {
            return Err("freeze-content-persisted");
        }
        let columns: Vec<String> =
            serde_json::from_str(&encoded).map_err(|_| "freeze-metadata-shape")?;
        if columns.len() != 4
            || columns.iter().enumerate().any(|(index, value)| {
                value.len() != if index == 0 { 32 } else { 64 }
                    || !value
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            })
        {
            return Err("freeze-metadata-is-not-digest-only");
        }
        hash.update((encoded.len() as u64).to_be_bytes());
        hash.update(encoded.as_bytes());
    }
    drop(rows);
    drop(statement);
    drop(read);
    known.recheck(paths)?;
    Ok(FrozenRows {
        count,
        digest: format!("{:x}", hash.finalize()),
    })
}
fn row_matches(
    paths: &SmokePaths,
    known: &SettingsRuntime,
    capsule: &FrozenNativeChild,
) -> Result<bool, &'static str> {
    let view = capsule.view();
    known.recheck(paths)?;
    let read = crate::runtime::ReadOnly::open(&paths.config).map_err(|_| "freeze-binding-open")?;
    known.recheck(paths)?;
    let row: (String, String, String, String, i64, String) = read.query_row(
        "SELECT r.job_id,r.reserved_run_id,r.reserved_cli_session_id,r.request_digest,r.deadline_at,f.instruction_source_version FROM child_job_grant_freezes f JOIN child_job_reservations r ON r.slot_id=f.slot_id WHERE f.contract_digest=?1",
        [view.contract_digest], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?)),
    ).map_err(|_| "freeze-binding-row")?;
    let deadline =
        i64::try_from(view.allocation.deadline_at).map_err(|_| "freeze-binding-deadline")?;
    let same = row
        == (
            view.allocation.job_id.clone(),
            view.allocation.run_id.clone(),
            view.allocation.session_id.clone(),
            view.allocation.request_digest.clone(),
            deadline,
            view.instruction_source_version.to_owned(),
        );
    drop(read);
    known.recheck(paths)?;
    Ok(same)
}
fn reserve_for(
    app: &AppHandle,
    window: &WebviewWindow,
    run: u64,
    request: &NativeDelegationRequest,
) -> Result<(NativeDelegationCaller, Allocation), &'static str> {
    let caller = prepare(app, window, run).map_err(|_| "freeze-prepare-original-intent")?;
    let allocation =
        reserve(app, window, &caller, request).map_err(|_| "freeze-reserve-original-intent")?;
    Ok((caller, allocation))
}
#[expect(
    clippy::too_many_arguments,
    reason = "The fixed native fixture passes the actual caller, request and expected refusal explicitly; no authority bundle is synthesized."
)]
fn refuses_unchanged(
    app: &AppHandle,
    window: &WebviewWindow,
    paths: &SmokePaths,
    known: &SettingsRuntime,
    caller: &NativeDelegationCaller,
    request: &NativeDelegationRequest,
    mode: NativeChildMode,
    expected: FreezeRefusal,
) -> Result<bool, &'static str> {
    let before = counts(paths, known)?;
    let frozen = frozen_rows(paths, known)?;
    let refused = freeze(app, window, caller, request, mode).err() == Some(expected);
    Ok(refused && counts(paths, known)? == before && frozen_rows(paths, known)? == frozen)
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
    let run = start_scoped(app, window, &paths, PARENT_SCOPE, PARENT_TOOLS)?;
    observed(
        cases,
        "freeze-original-scoped-parent",
        available(app, window, run),
        "actual-native-opening-and-publication",
    )?;
    let request = request()?;
    observed(
        cases,
        "freeze-actual-compiled-source",
        compiled_source()? == PROMPT.trim(),
        "existing-preset-and-prompt-loader",
    )?;
    let (caller, allocation) = reserve_for(app, window, run, &request)?;
    let before = counts(&paths, &known)?;
    observed(
        cases,
        "freeze-original-reservation",
        before.intents == 1
            && before.reservations == 1
            && before.runs == 1
            && before.configurations == 1,
        "one-inert-original-reservation",
    )?;
    // All actual source/parent/storage prerequisites precede this causal RED.
    // The closed consumer must fail HERE, not at compilation or table setup.
    let capsule = freeze(
        app,
        window,
        &caller,
        &request,
        NativeChildMode::LocalResearcher,
    )
    .map_err(|_| "freeze-valid-original-parent")?;
    let view = capsule.view();
    observed(
        cases,
        "freeze-narrows-parent-and-policy",
        view.allocation == &allocation
            && view
                .read_scope
                .iter()
                .map(String::as_str)
                .eq(["knowledge/topic", "projects/atlas"])
            && view
                .tools
                .iter()
                .map(String::as_str)
                .eq(["get_note", "search_notes"])
            && view.instructions == PROMPT.trim()
            && view.instruction_source_version == request.instruction_source_version
            && view.evidence.len() == 2
            && view.evidence[0].path == FIRST
            && view.evidence[0].sha256 == crate::ledger::sha256_hex(FIRST_BYTES)
            && view.evidence[1].path == SECOND
            && view.evidence[1].sha256 == crate::ledger::sha256_hex(SECOND_BYTES),
        "frozen-local-read-contract-no-greater-tools",
    )?;
    observed(
        cases,
        "freeze-digest-only-original-binding",
        counts(&paths, &known)? == before
            && frozen_rows(&paths, &known)?.count == 1
            && row_matches(&paths, &known, &capsule)?,
        "one-immutable-binding-no-run-config-account-or-body",
    )?;
    observed(
        cases,
        "freeze-backend-stays-unverified",
        attempt_frozen_child_start(app, window, &capsule).err()
            == Some(FreezeRefusal::BackendIsolationUnverified)
            && counts(&paths, &known)? == before
            && frozen_rows(&paths, &known)?.count == 1,
        "backend-isolation-unverified-no-dispatch",
    )?;
    let replay = freeze(
        app,
        window,
        &caller,
        &request,
        NativeChildMode::LocalResearcher,
    )
    .map_err(|_| "freeze-replay-original-caller")?;
    observed(
        cases,
        "freeze-replay-retains-same-capsule",
        Arc::ptr_eq(&capsule, &replay)
            && counts(&paths, &known)? == before
            && frozen_rows(&paths, &known)?.count == 1,
        "same-transient-capsule-and-durable-tuple",
    )?;
    for mode in [NativeChildMode::AgentPage, NativeChildMode::ManagedAccount] {
        observed(
            cases,
            if mode == NativeChildMode::AgentPage {
                "freeze-agent-mode-refused"
            } else {
                "freeze-account-mode-refused"
            },
            refuses_unchanged(
                app,
                window,
                &paths,
                &known,
                &caller,
                &request,
                mode,
                FreezeRefusal::UnsupportedMode,
            )?,
            "unsupported-without-fallback",
        )?;
    }
    let mut changed = request.clone();
    changed.objective.push_str(" changed");
    observed(
        cases,
        "freeze-changed-request-conflicts",
        refuses_unchanged(
            app,
            window,
            &paths,
            &known,
            &caller,
            &changed,
            NativeChildMode::LocalResearcher,
            FreezeRefusal::RequestKeyConflict,
        )?,
        "original-contract-unchanged",
    )?;
    let mut invalid = request.clone();
    invalid.objective.clear();
    observed(
        cases,
        "freeze-malformed-spec-refused",
        refuses_unchanged(
            app,
            window,
            &paths,
            &known,
            &caller,
            &invalid,
            NativeChildMode::LocalResearcher,
            FreezeRefusal::InvalidSpec,
        )?,
        "invalid-spec-no-metadata-change",
    )?;
    let unreserved = prepare(app, window, run).map_err(|_| "freeze-unreserved-intent")?;
    observed(
        cases,
        "freeze-cannot-create-reservation",
        refuses_unchanged(
            app,
            window,
            &paths,
            &known,
            &unreserved,
            &request,
            NativeChildMode::LocalResearcher,
            FreezeRefusal::Unavailable,
        )?,
        "existing-reservation-required",
    )?;
    crate::stop_agent(app.state(), run).map_err(|_| "freeze-stop")?;
    observed(
        cases,
        "freeze-stopped-parent-unavailable",
        refuses_unchanged(
            app,
            window,
            &paths,
            &known,
            &caller,
            &request,
            NativeChildMode::LocalResearcher,
            FreezeRefusal::Unavailable,
        )?,
        "unavailable-not-empty-or-refrozen",
    )?;
    reap(app)?;

    for (name, scope, tools, mutation, expected) in [
        (
            "freeze-wrong-source-version",
            PARENT_SCOPE,
            PARENT_TOOLS,
            "source",
            FreezeRefusal::InvalidSource,
        ),
        (
            "freeze-empty-parent-scope",
            &[][..],
            PARENT_TOOLS,
            "none",
            FreezeRefusal::EmptyScope,
        ),
        (
            "freeze-empty-read-tools",
            PARENT_SCOPE,
            &["edit_note", "hand_to", "navigate", "comment_on_note"][..],
            "none",
            FreezeRefusal::EmptyTools,
        ),
        (
            "freeze-changed-evidence",
            PARENT_SCOPE,
            PARENT_TOOLS,
            "hash",
            FreezeRefusal::EvidenceUnavailable,
        ),
        (
            "freeze-outside-evidence",
            PARENT_SCOPE,
            PARENT_TOOLS,
            "outside",
            FreezeRefusal::EvidenceUnavailable,
        ),
        (
            "freeze-prefix-sibling-is-outside",
            &["work"][..],
            PARENT_TOOLS,
            "sibling",
            FreezeRefusal::EmptyScope,
        ),
        (
            "freeze-contained-symlink-is-outside",
            &["public"][..],
            PARENT_TOOLS,
            "symlink",
            FreezeRefusal::EvidenceUnavailable,
        ),
        (
            "freeze-parent-mail-authority-is-not-inherited",
            &["sources"][..],
            PARENT_TOOLS,
            "mail",
            FreezeRefusal::EvidenceUnavailable,
        ),
    ] {
        let run = start_scoped(app, window, &paths, scope, tools)?;
        let mut request = request_for_case(mutation)?;
        // Keep mutable request local: it is not stored or treated as authority.
        if mutation == "none" {
            request.objective.push_str(" control");
        }
        let (caller, _) = reserve_for(app, window, run, &request)?;
        observed(
            cases,
            name,
            refuses_unchanged(
                app,
                window,
                &paths,
                &known,
                &caller,
                &request,
                NativeChildMode::LocalResearcher,
                expected,
            )?,
            "typed-refusal-no-freeze-row",
        )?;
        reap(app)?;
    }
    let run = start_scoped(app, window, &paths, PARENT_SCOPE, PARENT_TOOLS)?;
    let mut expires = request_for_case("none")?;
    expires.deadline_at = now()?.checked_add(2).ok_or("freeze-deadline-overflow")?;
    let (caller, _) = reserve_for(app, window, run, &expires)?;
    let limit = Instant::now() + Duration::from_secs(4);
    while now()? < expires.deadline_at {
        if Instant::now() >= limit {
            return Err("freeze-deadline-wait-bound");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    observed(
        cases,
        "freeze-expired-reservation",
        refuses_unchanged(
            app,
            window,
            &paths,
            &known,
            &caller,
            &expires,
            NativeChildMode::LocalResearcher,
            FreezeRefusal::Deadline,
        )?,
        "deadline-not-renewed",
    )?;
    reap(app)?;
    let final_rows = frozen_rows(&paths, &known)?;
    let bytes = serde_json::to_vec_pretty(&serde_json::json!({
        "format":1,"profile":"child-grant-freeze","frozen":final_rows,
        "counts":counts(&paths,&known)?,"physicalIdentity":known,
        "scope":"local compiled researcher; digest-only metadata; no child execution"
    }))
    .map_err(|_| "freeze-audit-encode")?;
    if bytes.len() > 8192 {
        return Err("freeze-audit-output-bound");
    }
    create(&paths.root.join("freeze-audit.json"), &bytes).map_err(|_| "freeze-audit-write")?;
    Ok(())
}
fn request_for_case(mutation: &str) -> Result<NativeDelegationRequest, &'static str> {
    let mut request = request()?;
    match mutation {
        "source" => request.instruction_source_version = "c".repeat(64),
        "hash" => request.input_evidence_refs[0].sha256 = "c".repeat(64),
        "outside" => {
            request.input_evidence_refs[0] = EvidenceRef {
                path: "private/blocked.md".into(),
                sha256: crate::ledger::sha256_hex(PRIVATE_BYTES),
            }
        }
        "sibling" => {
            request.requested_grant.read_scope = vec!["workspace".into()];
            request.input_evidence_refs.clear();
        }
        "symlink" | "mail" => {
            request.requested_grant.read_scope = vec![if mutation == "mail" {
                "sources"
            } else {
                "public"
            }
            .into()];
            request.input_evidence_refs = vec![EvidenceRef {
                path: if mutation == "mail" {
                    MAIL
                } else {
                    "public/alias.md"
                }
                .into(),
                sha256: crate::ledger::sha256_hex(PRIVATE_BYTES),
            }];
        }
        "none" => {}
        _ => return Err("freeze-unknown-fixture"),
    }
    Ok(request)
}
pub(super) fn report(
    paths: &SmokePaths,
    cases: &[Case],
    failed_stage: Option<&'static str>,
) -> serde_json::Value {
    let saw = |name| cases.iter().any(|case| case.name == name);
    serde_json::json!({
        "format":6,"profile":"child-grant-freeze","observer":"native-injected-window-child-grant-freeze",
        "passed":failed_stage.is_none(),"failedStage":failed_stage,"cases":cases,"compiledInputs":compiled_inputs(),
        "claims":{
            "actualInjectedCommand":paths.started.load(Ordering::SeqCst),
            "actualScopedParentPublication":saw("freeze-original-scoped-parent"),
            "actualOriginalReservation":saw("freeze-original-reservation"),
            "localBuiltInGrantFrozen":saw("freeze-narrows-parent-and-policy"),
            "digestOnlyMetadata":saw("freeze-digest-only-original-binding"),
            "sameCallerCapsuleReplay":saw("freeze-replay-retains-same-capsule"),
            "backendExplicitlyUnverified":saw("freeze-backend-stays-unverified"),
            "childRunOrConfiguration":false,"childTokenOrSubject":false,"providerNetwork":false,
            "realCliAcceptance":false,"publicExecution":false,"agentPageMaximum":false,
            "managedAccountAuthority":false,"nativeRestartRecovery":false,"lostAckRecovery":false
        },"timeBasis":"wall-clock deadline; no performance claim"
    })
}
