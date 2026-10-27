//! Fixed native acceptance journey. Production commands own every mutation.
use super::*;
use crate::workflow_commands as commands;
use crate::workflows::transport::*;
use serde_json::{json, Value};
use std::future::Future;

const WORKFLOW: &str = "native-pinned-journey";
const START: &str = "11111111111111111111111111111111";
const SIGNAL: &str = "22222222222222222222222222222222";
const UNPUBLISH: &str = "33333333333333333333333333333333";
const EXPECTED_OUTPUT: &str = r#"{"answer":"answered","version":"v1"}"#;

pub(super) fn selected(value: &std::ffi::OsStr) -> bool {
    value == "--quit-workflow-pinned"
}
fn entered<T>(
    name: &'static str,
    payload: Value,
    future: impl Future<Output = Result<T, WorkflowError>>,
) -> Result<Result<T, WorkflowError>, &'static str> {
    checked(name, payload, || tauri::async_runtime::block_on(future))
}
fn call<T>(
    name: &'static str,
    payload: Value,
    future: impl Future<Output = Result<T, WorkflowError>>,
) -> Result<T, &'static str> {
    entered(name, payload, future)?.map_err(|_| name)
}
fn draft(version: &str, expires: &str) -> WorkflowDraft {
    WorkflowDraft {
        workflow_id: WORKFLOW.into(),
        entry_step_id: "wait".into(),
        input_schema_json: r#"{"additionalProperties":false,"properties":{},"type":"object"}"#
            .into(),
        trigger_json: r#"{"kind":"manual"}"#.into(),
        steps: vec![
            WorkflowStepDraft {
                step_id: "wait".into(),
                label: "Original external input".into(),
                operation: WorkflowOperationDraft::ExternalInput {
                    schema_json: r#"{"type":"string"}"#.into(),
                    expires_at: expires.into(),
                    next_step_id: "result".into(),
                },
            },
            WorkflowStepDraft {
                step_id: "result".into(),
                label: format!("Pinned {version} result"),
                operation: WorkflowOperationDraft::Result {
                    output_json: json!({
                        "kind":"object", "fields":{
                            "answer":{"kind":"output","stepId":"wait","path":[]},
                            "version":{"kind":"literal","value":version}
                        }
                    })
                    .to_string(),
                },
            },
        ],
    }
}
fn run(
    app: &AppHandle,
    window: &WebviewWindow,
    context: &WorkflowContext,
    id: &str,
) -> Result<WorkflowRunView, &'static str> {
    call(
        "workflow_run",
        json!({"context":context,"runId":id}),
        commands::workflow_run(app.clone(), window.clone(), context.clone(), id.into()),
    )
}
fn same_run(value: &WorkflowRunView, start: &WorkflowStartAck) -> bool {
    value.context == start.context
        && value.run_id == start.run_id
        && value.version == start.version
        && value.admission_epoch == start.admission_epoch
        && !value.cancel_requested
        && value.steps.len() == 2
}
fn pending(value: &WorkflowRunView) -> Result<WorkflowWaitView, &'static str> {
    let step = value.steps.first().ok_or("workflow-wait-step")?;
    let wait = step.wait.clone().ok_or("workflow-wait-absent")?;
    if value.state != WorkflowRunState::Waiting
        || step.step_id != "wait"
        || step.kind != WorkflowStepKind::ExternalInput
        || step.state != WorkflowStepState::Waiting
        || wait.kind != WorkflowWaitKind::ExternalInput
        || wait.state != WorkflowWaitState::Pending
        || wait.schema_json.as_deref() != Some(r#"{"type":"string"}"#)
    {
        return Err("workflow-original-wait-differs");
    }
    Ok(wait)
}
fn await_state(
    app: &AppHandle,
    window: &WebviewWindow,
    start: &WorkflowStartAck,
    target: WorkflowRunState,
) -> Result<WorkflowRunView, &'static str> {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let value = run(app, window, &start.context, &start.run_id)?;
        if !same_run(&value, start) {
            return Err("workflow-original-run-differs");
        }
        if value.state == target {
            return Ok(value);
        }
        if matches!(
            value.state,
            WorkflowRunState::Failed | WorkflowRunState::Cancelled | WorkflowRunState::Blocked
        ) || Instant::now() >= deadline
        {
            return Err("workflow-state-deadline");
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}
fn continue_wait(
    app: &AppHandle,
    window: &WebviewWindow,
    start: &WorkflowStartAck,
    wait: &WorkflowWaitView,
) -> Result<(), &'static str> {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let view = run(app, window, &start.context, &start.run_id)?;
        if !same_run(&view, start) || pending(&view)? != *wait {
            return Err("workflow-continue-wait-differs");
        }
        let request = WorkflowRunRequest {
            context: start.context.clone(),
            run_id: start.run_id.clone(),
            expected_revision: view.revision,
            expected_epoch: view.admission_epoch,
        };
        match entered(
            "workflow_continue",
            json!({"request":request}),
            commands::workflow_continue(app.clone(), window.clone(), request),
        )? {
            Ok(ack) => {
                if ack.context != start.context
                    || ack.version != start.version
                    || ack.run_id != start.run_id
                    || ack.admission_epoch != start.admission_epoch
                    || ack.revision != view.revision
                    || ack.created
                {
                    return Err("workflow-continue-owner");
                }
                if ack.admission == WorkflowAdmission::Ready {
                    return Ok(());
                }
                if ack.admission != WorkflowAdmission::Busy {
                    return Err("workflow-continue-unavailable");
                }
            }
            Err(error) if error.code == WorkflowErrorCode::Unavailable => {}
            Err(_) => return Err("workflow-continue-refused"),
        }
        if Instant::now() >= deadline {
            return Err("workflow-continue-deadline");
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}
fn answer(
    app: &AppHandle,
    window: &WebviewWindow,
    start: &WorkflowStartAck,
    wait: &WorkflowWaitView,
) -> Result<(), &'static str> {
    let request = WorkflowWaitAnswer {
        context: start.context.clone(),
        run_id: start.run_id.clone(),
        continuation_id: wait.continuation_id.clone(),
        expected_revision: wait.revision,
        signal_key: SIGNAL.into(),
        input_json: r#""answered""#.into(),
    };
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        match entered(
            "workflow_answer_wait",
            json!({"request":request}),
            commands::workflow_answer_wait(app.clone(), window.clone(), request.clone()),
        )? {
            Ok(view) => {
                if !same_run(&view, start) {
                    return Err("workflow-answer-owner");
                }
                return Ok(());
            }
            Err(error) if error.code == WorkflowErrorCode::Unavailable => {}
            Err(_) => return Err("workflow-answer-refused"),
        }
        // The request/key is never replaced. A committed reply loss is recovered
        // by the actual consumed-signal reader on this same command.
        let view = run(app, window, &start.context, &start.run_id)?;
        if !same_run(&view, start) {
            return Err("workflow-answer-original-lost");
        }
        if Instant::now() >= deadline {
            return Err("workflow-answer-deadline");
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}
fn audit(
    paths: &SmokePaths,
    known: &SettingsRuntime,
    start: &WorkflowStartAck,
    first: &WorkflowPublication,
    second: &WorkflowPublication,
    wait: &WorkflowWaitView,
    ended: &WorkflowRunView,
    tombstone: &WorkflowUnpublishAck,
) -> Result<Value, &'static str> {
    known.recheck(paths)?;
    let read = crate::runtime::ReadOnly::open(&paths.config).map_err(|_| "workflow-audit-open")?;
    known.recheck(paths)?;
    // One query-only statement supplies one snapshot of the original database.
    let text: String = read.query_row(r#"
SELECT json_object(
 'runId',r.run_id,'nativeRunId',o.native_run_id,'vaultId',r.vault_id,'storeUuid',r.store_uuid,
 'version',r.definition_hash,'originVersion',o.definition_hash,'startKey',r.start_key,
 'state',r.state,'outputDigest',s.output_digest,'continuationId',w.continuation_id,
 'waitVersion',w.definition_hash,'waitState',w.state,'signalKey',w.signal_key,
 'originalPermissions',json(o.original_permissions_json),'currentPermissions',json(o.current_permissions_json),
 'counts',json_object('runs',(SELECT count(*) FROM runs),'nativeRuns',(SELECT count(*) FROM action_native_runs),
  'workflowRuns',(SELECT count(*) FROM workflow_runs),'origins',(SELECT count(*) FROM workflow_run_origins),
  'steps',(SELECT count(*) FROM workflow_steps),'attempts',(SELECT count(*) FROM workflow_attempts),
  'waits',(SELECT count(*) FROM workflow_waits),'values',(SELECT count(*) FROM workflow_values),
  'connections',(SELECT count(*) FROM managed_connections),'grants',(SELECT count(*) FROM action_account_grants),
  'invocations',(SELECT count(*) FROM action_invocations),'actionAttempts',(SELECT count(*) FROM action_attempts)),
 'reservedBytes',r.reserved_bytes)
FROM workflow_runs r JOIN workflow_run_origins o ON o.workflow_run_id=r.run_id
JOIN workflow_steps s ON s.run_id=r.run_id AND s.step_id='result'
JOIN workflow_waits w ON w.run_id=r.run_id AND w.step_id='wait'
WHERE r.run_id=?1 AND o.canonical_vault_path=?2
"#, rusqlite::params![start.run_id,paths.vault_a.to_str().ok_or("workflow-audit-path")?],
        |row| row.get(0)).map_err(|_|"workflow-audit-rows")?;
    drop(read);
    known.recheck(paths)?;
    let rows: Value = serde_json::from_str(&text).map_err(|_| "workflow-audit-json")?;
    let empty = json!({"readPrefixes":[],"queryRecords":false,"accounts":[]});
    let output = crate::ledger::sha256_hex(EXPECTED_OUTPUT.as_bytes());
    if rows["runId"] != start.run_id
        || rows["nativeRunId"] != ended.native_run_id
        || rows["vaultId"] != start.context.vault_id
        || rows["storeUuid"] != start.context.store_uuid
        || rows["version"] != first.version.definition_hash
        || rows["originVersion"] != first.version.definition_hash
        || rows["waitVersion"] != first.version.definition_hash
        || rows["startKey"] != START
        || rows["state"] != "succeeded"
        || rows["outputDigest"] != output
        || rows["continuationId"] != wait.continuation_id
        || rows["waitState"] != "consumed"
        || rows["signalKey"] != SIGNAL
        || rows["reservedBytes"] != 0
        || rows["originalPermissions"] != empty
        || rows["currentPermissions"] != empty
        || rows["counts"]
            != json!({"runs":1,"nativeRuns":1,"workflowRuns":1,"origins":1,
            "steps":2,"attempts":2,"waits":1,"values":0,"connections":0,"grants":0,"invocations":0,"actionAttempts":0})
    {
        return Err("workflow-final-original-audit");
    }
    Ok(
        json!({"rows":rows,"context":start.context,"first":first,"second":second,
        "unpublish":tombstone,"expectedOutputDigest":output,"physicalIdentity":known}),
    )
}
pub(super) fn capture(
    app: &AppHandle,
    window: &WebviewWindow,
    cases: &mut Vec<Case>,
) -> Result<(), &'static str> {
    let paths = app.state::<SmokePaths>();
    if !paths.workflow_pinned {
        return Err("workflow-profile-absent");
    }
    open(app, window, &paths.vault_a)?;
    let context = call(
        "workflow_context",
        json!({}),
        commands::workflow_context(app.clone(), window.clone()),
    )?;
    let known = SettingsRuntime::capture(&paths)?;
    let expires = (chrono::Utc::now() + chrono::Duration::minutes(10))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let first_draft = draft("v1", &expires);
    let save = WorkflowSaveRequest {
        context: context.clone(),
        draft: first_draft.clone(),
        expected_etag: None,
    };
    let saved = call(
        "workflow_save",
        json!({"request":save}),
        commands::workflow_save(app.clone(), window.clone(), save),
    )?;
    if saved.draft != first_draft {
        return Err("workflow-first-save-differs");
    }
    let publish = WorkflowPublishRequest {
        context: context.clone(),
        workflow_id: WORKFLOW.into(),
        expected_draft_etag: saved.etag.clone(),
        expected_publication_revision: None,
    };
    let first = call(
        "workflow_publish",
        json!({"request":publish}),
        commands::workflow_publish(app.clone(), window.clone(), publish),
    )?;
    observed(
        cases,
        "workflow-v1-published",
        first.version.workflow_id == WORKFLOW && first.revision.get() == 1,
        "actual-save-publish-original-opening",
    )?;
    let start_request = WorkflowStartRequest {
        context: context.clone(),
        version: first.version.clone(),
        start_key: START.into(),
        input_json: "{}".into(),
        permissions: WorkflowPermissions {
            read_prefixes: vec![],
            query_records: false,
            accounts: vec![],
        },
    };
    let start = call(
        "workflow_start",
        json!({"request":start_request}),
        commands::workflow_start(app.clone(), window.clone(), start_request.clone()),
    )?;
    if !start.created
        || start.context != context
        || start.version != first.version
        || start.admission != WorkflowAdmission::Ready
    {
        return Err("workflow-start-not-admitted");
    }
    let waiting = await_state(app, window, &start, WorkflowRunState::Waiting)?;
    let wait = pending(&waiting)?;
    observed(
        cases,
        "workflow-v1-waiting",
        true,
        "actual-owned-worker-original-continuation",
    )?;
    let save = WorkflowSaveRequest {
        context: context.clone(),
        draft: draft("v2", &expires),
        expected_etag: Some(saved.etag),
    };
    let saved = call(
        "workflow_save",
        json!({"request":save}),
        commands::workflow_save(app.clone(), window.clone(), save),
    )?;
    let publish = WorkflowPublishRequest {
        context: context.clone(),
        workflow_id: WORKFLOW.into(),
        expected_draft_etag: saved.etag,
        expected_publication_revision: Some(first.revision),
    };
    let second = call(
        "workflow_publish",
        json!({"request":publish}),
        commands::workflow_publish(app.clone(), window.clone(), publish),
    )?;
    let still_waiting = run(app, window, &context, &start.run_id)?;
    observed(
        cases,
        "workflow-v2-published",
        second.version.workflow_id == WORKFLOW
            && second.revision.get() == 2
            && second.version != first.version
            && same_run(&still_waiting, &start)
            && pending(&still_waiting)? == wait,
        "new-publication-original-wait-unchanged",
    )?;
    let unpublish = WorkflowUnpublishRequest {
        context: context.clone(),
        request_key: UNPUBLISH.into(),
        publication: second.clone(),
    };
    let tombstone = call(
        "workflow_unpublish",
        json!({"request":unpublish}),
        commands::workflow_unpublish(app.clone(), window.clone(), unpublish),
    )?;
    let document = call(
        "workflow_document",
        json!({"context":context,"workflowId":WORKFLOW}),
        commands::workflow_document(
            app.clone(),
            window.clone(),
            context.clone(),
            WORKFLOW.into(),
        ),
    )?;
    let historical = call(
        "workflow_version",
        json!({"context":context,"version":first.version}),
        commands::workflow_version(
            app.clone(),
            window.clone(),
            context.clone(),
            first.version.clone(),
        ),
    )?;
    let still_waiting = run(app, window, &context, &start.run_id)?;
    observed(
        cases,
        "workflow-unpublished",
        tombstone.context == context
            && tombstone.original == second
            && tombstone.request_key == UNPUBLISH
            && tombstone.publication_revision.get() == 3
            && !tombstone.replayed
            && document.context == context
            && document.publication.is_none()
            && document.publication_revision.get() == 3
            && historical == first_draft
            && same_run(&still_waiting, &start)
            && pending(&still_waiting)? == wait,
        "revisioned-tombstone-pinned-v1-wait-preserved",
    )?;
    let replay = call(
        "workflow_start",
        json!({"request":start_request}),
        commands::workflow_start(app.clone(), window.clone(), start_request),
    )?;
    observed(
        cases,
        "workflow-start-replayed",
        !replay.created
            && replay.context == context
            && replay.version == first.version
            && replay.run_id == start.run_id
            && replay.admission_epoch == start.admission_epoch
            && replay.admission == WorkflowAdmission::Busy,
        "same-key-original-run-no-new-admission",
    )?;
    continue_wait(app, window, &start, &wait)?;
    observed(
        cases,
        "workflow-explicit-continue",
        true,
        "original-revision-epoch-and-wait",
    )?;
    answer(app, window, &start, &wait)?;
    let ended = await_state(app, window, &start, WorkflowRunState::Succeeded)?;
    let digest = crate::ledger::sha256_hex(EXPECTED_OUTPUT.as_bytes());
    observed(
        cases,
        "workflow-v1-result",
        ended.steps[1].step_id == "result"
            && ended.steps[1].label == "Pinned v1 result"
            && ended
                .steps
                .iter()
                .all(|step| step.state == WorkflowStepState::Succeeded)
            && matches!(&ended.steps[1].output,WorkflowValueView::NotRetained{digest:actual} if *actual==digest),
        "v1-answer-digest-completed-content-not-retained",
    )?;
    let final_audit = audit(
        &paths, &known, &start, &first, &second, &wait, &ended, &tombstone,
    )?;
    let bytes = serde_json::to_vec(&final_audit).map_err(|_| "workflow-audit-encode")?;
    if bytes.len() > 16384 {
        return Err("workflow-audit-bound");
    }
    create(&paths.root.join("workflow-audit.json"), &bytes).map_err(|_| "workflow-audit-save")?;
    observed(
        cases,
        "workflow-final-audit",
        true,
        "one-original-run-zero-effects-zero-value-bodies",
    )?;
    Ok(())
}
fn read_audit(path: &Path) -> Result<Value, &'static str> {
    let before = fs::symlink_metadata(path).map_err(|_| "workflow-audit-metadata")?;
    let original = settings_identity(path, false)?;
    if before.mode() & 0o077 != 0 || before.len() > 16384 {
        return Err("workflow-audit-private-bound");
    }
    let file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(|_| "workflow-audit-read-open")?;
    let opened = file.metadata().map_err(|_| "workflow-audit-read-stat")?;
    if opened.dev() != original.dev || opened.ino() != original.ino || opened.len() != before.len()
    {
        return Err("workflow-audit-read-identity");
    }
    let mut bytes = Vec::new();
    (&file)
        .take(16385)
        .read_to_end(&mut bytes)
        .map_err(|_| "workflow-audit-read")?;
    let after = file.metadata().map_err(|_| "workflow-audit-read-restat")?;
    if bytes.len() > 16384
        || u64::try_from(bytes.len()).ok() != Some(after.len())
        || after.len() != opened.len()
        || after.mtime() != opened.mtime()
        || after.mtime_nsec() != opened.mtime_nsec()
        || settings_identity(path, false)? != original
    {
        return Err("workflow-audit-read-changed");
    }
    serde_json::from_slice(&bytes).map_err(|_| "workflow-audit-read-json")
}
pub(super) fn report(paths: &SmokePaths, cases: &[Case], failed: Option<&'static str>) -> Value {
    let audit = read_audit(&paths.root.join("workflow-audit.json")).ok();
    json!({"format":1,"observer":"native-original-pinned-workflow-smoke","profile":"workflow-pinned",
        "nativePid":std::process::id(),"passed":failed.is_none()&&audit.is_some(),"failedStage":failed,
        "compiledInputs":compiled_inputs(),"cases":cases,"audit":audit,
        "claims":{"actualMacosWindow":true,"actualInjectedCommand":paths.started.load(Ordering::SeqCst),
            "actualWorkflowCommands":cases.iter().any(|case|case.name=="workflow-v1-published"),
            "actualOwnedWorker":cases.iter().any(|case|case.name=="workflow-v1-waiting"),
            "originalPinnedVersion":cases.iter().any(|case|case.name=="workflow-v1-result"),
            "completedDetailRetention":"off","cliExecution":false,"credentialAccess":false,
            "providerNetwork":false,"accountAuthority":false,"automaticScheduling":false,
            "realPersonBehavior":false,"packagedSigningAcceptance":false}})
}
