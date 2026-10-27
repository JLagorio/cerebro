//! Default-off durable acquisition metadata through the actual injected command.
//! No credential/provider/Keychain module is used by this profile.
use super::*;
use crate::actions::{
    ids::AttemptId,
    native_owner::{credential_begin, credential_cancel, credential_poll},
};
use crate::connections::{metadata::CredentialAcquisitionView, AcquisitionState, GhSelection};

const LOGIN: &str = "cerebro-credential-smoke";
fn selection(status: &ConnectionStatus) -> GhSelection {
    GhSelection {
        connection_id: status.connection_id.clone(),
        host: "github.com".into(),
        login: LOGIN.into(),
    }
}
fn refused(
    app: &AppHandle,
    window: &WebviewWindow,
    choice: &GhSelection,
    expected: u64,
    attempt: &AttemptId,
) -> bool {
    let begin = credential_begin(app, window, choice, expected).err();
    let poll = credential_poll(app, window, attempt);
    let cancel = credential_cancel(app, window, attempt);
    begin == Some(ConnectionError::Unavailable)
        && poll == Err(ConnectionError::Unavailable)
        && cancel == Err(ConnectionError::Unavailable)
}
fn untrusted_window(app: &AppHandle) -> Result<WebviewWindow, &'static str> {
    let (send, receive) = std::sync::mpsc::sync_channel(1);
    let capture = app.clone();
    app.run_on_main_thread(move || {
        let result = tauri::WebviewWindowBuilder::new(
            &capture,
            "credential-untrusted",
            tauri::WebviewUrl::App("index.html".into()),
        )
        .visible(false)
        .incognito(true)
        .on_navigation(|url| {
            crate::shell::links::classify(url, None) == crate::shell::links::LinkVerdict::Allow
        })
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .build()
        .map_err(|_| "credential-secondary-window");
        // A late created window must not escape if the receiver timed out.
        if let Err(error) = send.try_send(result) {
            let value = match error {
                std::sync::mpsc::TrySendError::Full(value)
                | std::sync::mpsc::TrySendError::Disconnected(value) => value,
            };
            if let Ok(window) = value {
                let _ = window.destroy();
            }
        }
    })
    .map_err(|_| "credential-secondary-main-thread")?;
    receive
        .recv_timeout(Duration::from_secs(2))
        .map_err(|_| "credential-secondary-timeout")?
}
fn journal(
    paths: &SmokePaths,
    known: &SettingsRuntime,
    replacement: SettingsIdentity,
    stage: &'static str,
) -> Result<(), &'static str> {
    known.root_current(paths)?;
    let bytes = serde_json::to_vec(&serde_json::json!({"format":1,"profile":"credential-metadata","stage":stage,
        "databaseName":"config/runtime.db","heldName":"runtime.credential-original.db",
        "replacementName":"runtime.credential-replacement.db","physicalIdentity":known,"replacementIdentity":replacement}))
        .map_err(|_| "credential-journal-encode")?;
    if bytes.len() > 4096 {
        return Err("credential-journal-bound");
    }
    create(
        &paths.root.join(format!("credential-runtime-{stage}.json")),
        &bytes,
    )
    .map_err(|_| "credential-journal-write")?;
    fs::File::open(&paths.root)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| "credential-journal-sync")
}
fn replacement_probe(
    app: &AppHandle,
    window: &WebviewWindow,
    paths: &SmokePaths,
    known: &SettingsRuntime,
    choice: &GhSelection,
    expected: u64,
    attempt: &AttemptId,
) -> Result<bool, &'static str> {
    known.recheck(paths)?;
    let path = crate::runtime::runtime_db_path(&paths.config);
    let held = paths.root.join("runtime.credential-original.db");
    let replacement = paths.root.join("runtime.credential-replacement.db");
    if !settings_absent(&held) || !settings_absent(&replacement) {
        return Err("credential-runtime-occupied");
    }
    let file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&path)
        .map_err(|_| "credential-runtime-copy-open")?;
    let metadata = file
        .metadata()
        .map_err(|_| "credential-runtime-copy-metadata")?;
    if !metadata.is_file()
        || metadata.dev() != known.database.dev
        || metadata.ino() != known.database.ino
        || metadata.len() > 4 * 1024 * 1024
    {
        return Err("credential-runtime-copy-identity");
    }
    let mut bytes = Vec::new();
    (&file)
        .take(4 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "credential-runtime-copy-read")?;
    if bytes.len() > 4 * 1024 * 1024 || bytes.len() as u64 != metadata.len() {
        return Err("credential-runtime-copy-bound");
    }
    let after = file
        .metadata()
        .map_err(|_| "credential-runtime-copy-after")?;
    if (
        metadata.dev(),
        metadata.ino(),
        metadata.len(),
        metadata.mtime(),
        metadata.mtime_nsec(),
    ) != (
        after.dev(),
        after.ino(),
        after.len(),
        after.mtime(),
        after.mtime_nsec(),
    ) {
        return Err("credential-runtime-copy-changed");
    }
    drop(file);
    known.recheck(paths)?;
    create(&replacement, &bytes).map_err(|_| "credential-runtime-copy-create")?;
    let alternate = settings_identity(&replacement, false)?;
    if alternate == known.database {
        return Err("credential-runtime-copy-same-inode");
    }
    journal(paths, known, alternate, "00-prepared")?;
    known.recheck(paths)?;
    settings_rename_exclusive(&path, &held)?;
    let mut installed = false;
    let attempted = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        known.root_current(paths)?;
        if settings_identity(&held, false)? != known.database
            || !settings_absent(&path)
            || settings_identity(&replacement, false)? != alternate
        {
            return Err("credential-runtime-rename-changed");
        }
        journal(paths, known, alternate, "01-renamed")?;
        settings_rename_exclusive(&replacement, &path)?;
        installed = true;
        journal(paths, known, alternate, "02-replaced")?;
        Ok(refused(app, window, choice, expected, attempt))
    }))
    .unwrap_or(Err("credential-runtime-probe-panicked"));
    let restore_intent = journal(paths, known, alternate, "03-restore-intent");
    let restored = (|| {
        known.root_current(paths)?;
        if settings_identity(&held, false)? != known.database {
            return Err("credential-runtime-held-changed");
        }
        if installed {
            if settings_identity(&path, false)? != alternate {
                return Err("credential-runtime-replacement-changed");
            }
            fs::remove_file(&path).map_err(|_| "credential-runtime-remove-copy")?;
        } else if !settings_absent(&path) {
            return Err("credential-runtime-name-occupied");
        }
        settings_rename_exclusive(&held, &path)?;
        known.recheck(paths)?;
        // If replacement was not installed, preserve its exact unused file as
        // diagnostic evidence; failure is never reported as a passed profile.
        journal(paths, known, alternate, "04-restored")
    })();
    if restored.is_err() {
        return Err("credential-runtime-restoration-pending");
    }
    restore_intent?;
    attempted
}
fn audit(
    paths: &SmokePaths,
    known: &SettingsRuntime,
    expected: &ConnectionStatus,
    first: &CredentialAcquisitionView,
    second: &CredentialAcquisitionView,
) -> Result<bool, &'static str> {
    known.recheck(paths)?;
    if !settings_absent(&paths.root.join("runtime.credential-original.db"))
        || !settings_absent(&paths.root.join("runtime.credential-replacement.db"))
    {
        return Err("credential-audit-restoration-pending");
    }
    let read =
        crate::runtime::ReadOnly::open(&paths.config).map_err(|_| "credential-audit-open")?;
    known.recheck(paths)?;
    let counts: (i64, i64, i64, i64, i64) = read.query_row("SELECT (SELECT count(*) FROM managed_connections),(SELECT count(*) FROM managed_connection_attempts),(SELECT count(*) FROM managed_connections WHERE secret_ref IS NOT NULL),(SELECT count(*) FROM managed_secret_cleanup),(SELECT count(*) FROM action_account_grants)", [], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?))).map_err(|_| "credential-audit-counts")?;
    let owner = &crate::actions::schema::admission_rules().owner_storage_key;
    let record = read
        .query_row(
            STATUS_SQL,
            [&expected.connection_id.0, owner],
            MetadataRecord::read,
        )
        .map_err(|_| "credential-audit-status")?;
    let attempt = |id: &AttemptId| -> Result<CredentialAcquisitionView, &'static str> {
        let raw = read
            .query_row(
                crate::connections::account_metadata::ACQUISITION_SQL,
                [&id.0, owner],
                crate::connections::account_metadata::AcquisitionRecord::read,
            )
            .map_err(|_| "credential-audit-attempt-read")?;
        let value = raw
            .decode(owner, id)
            .map_err(|_| "credential-audit-attempt-decode")?;
        Ok(CredentialAcquisitionView::from(&value))
    };
    let actual_first = attempt(&first.attempt_id)?;
    let actual_second = attempt(&second.attempt_id)?;
    drop(read);
    known.recheck(paths)?;
    let matches = counts == (1, 2, 0, 0, 0)
        && record.status == *expected
        && record.active.is_none()
        && record.reference.is_none()
        && actual_first == *first
        && actual_second == *second;
    let bytes = serde_json::to_vec_pretty(&serde_json::json!({"format":1,"profile":"credential-metadata","counts":{"connections":counts.0,"attempts":counts.1,"secretReferences":counts.2,"cleanup":counts.3,"accountGrants":counts.4},"status":record.status,"attempts":[actual_first,actual_second],"matchesExpected":matches,"physicalIdentity":known,"activeAttemptAbsent":record.active.is_none(),"secretReferenceAbsent":record.reference.is_none()})).map_err(|_| "credential-audit-encode")?;
    if bytes.len() > 16384 {
        return Err("credential-audit-bound");
    }
    create(&paths.root.join("credential-audit.json"), &bytes)
        .map_err(|_| "credential-audit-write")?;
    Ok(matches)
}
pub(super) fn capture(
    app: &AppHandle,
    window: &WebviewWindow,
    cases: &mut Vec<Case>,
) -> Result<(), &'static str> {
    let paths = app.state::<SmokePaths>();
    let absent = GhSelection {
        connection_id: ConnectionId("credential-not-created".into()),
        host: "github.com".into(),
        login: LOGIN.into(),
    };
    let missing = AttemptId("credential-attempt-not-created".into());
    let known = public_credential_invoke(
        app,
        window,
        "capture_native_reads",
        serde_json::json!({"probe": null}),
    )?;
    let unknown = public_credential_invoke(
        app,
        window,
        "m96_unknown_credential_probe",
        serde_json::json!({}),
    )?;
    observed(
        cases,
        "credential-route-dispatch-controls",
        known == Err(serde_json::json!("capture-already-started"))
            && public_route_kind("m96_unknown_credential_probe", &unknown) == "unknown_command",
        "known-and-unknown-distinct",
    )?;
    observed(
        cases,
        "credential-route-before-open",
        public_credential_refused(
            app,
            window,
            &absent,
            1,
            &missing,
            "credential-public-before-open",
        )?,
        "all-three-domain-unavailable-not-unknown",
    )?;

    observed(
        cases,
        "credential-before-open",
        refused(app, window, &absent, 1, &missing),
        "all-three-unavailable",
    )?;
    open(app, window, &paths.vault_a)?;
    let known = SettingsRuntime::capture(&paths)?;
    let added =
        settings_add(app, window, "github.com", LOGIN)?.map_err(|_| "credential-selection-add")?;
    paths.metadata_write_observed.store(true, Ordering::SeqCst);
    let choice = selection(&added);
    let mut wrong = choice.clone();
    wrong.host = "unsupported.example".into();
    let host = credential_begin(app, window, &wrong, added.revision).err();
    wrong = choice.clone();
    wrong.login = "other-login".into();
    let login = credential_begin(app, window, &wrong, added.revision).err();
    let stale = credential_begin(app, window, &choice, 0).err();
    observed(
        cases,
        "credential-invalid-selection",
        host == Some(ConnectionError::Unsupported)
            && login == Some(ConnectionError::InvalidSelection)
            && stale == Some(ConnectionError::StaleRevision)
            && settings_same(app, window, &added)?,
        "exact-refusals-unchanged",
    )?;
    let secondary = untrusted_window(app)?;
    let rejected = refused(app, &secondary, &choice, added.revision, &missing);
    let public_rejected = public_credential_refused(
        app,
        &secondary,
        &choice,
        added.revision,
        &missing,
        "credential-public-wrong-window",
    )?;
    observed(
        cases,
        "credential-route-wrong-window",
        public_rejected && settings_same(app, window, &added)?,
        "native-window-wins-over-wire-selectors",
    )?;

    secondary
        .destroy()
        .map_err(|_| "credential-secondary-destroy")?;
    observed(
        cases,
        "credential-wrong-window",
        rejected,
        "all-three-unavailable",
    )?;
    let (pending, worker) = credential_begin(app, window, &choice, added.revision)
        .map_err(|_| "credential-begin-unavailable")?;
    worker
        .wait_until_parked()
        .map_err(|_| "credential-worker-park")?;
    observed(
        cases,
        "credential-begin",
        pending.connection_id == added.connection_id
            && pending.host == "github.com"
            && pending.login == LOGIN
            && pending.expected_revision == added.revision + 1
            && pending.state == AcquisitionState::Pending
            && pending.error.is_none(),
        "pending-original-owner",
    )?;
    let polled = credential_poll(app, window, &pending.attempt_id)
        .map_err(|_| "credential-poll-unavailable")?;
    observed(cases, "credential-poll", polled == pending, "exact-pending")?;
    let failed = worker
        .release_and_join()
        .map_err(|_| "credential-worker-settlement")?;
    observed(
        cases,
        "credential-unavailable-worker",
        failed.state == AcquisitionState::Failed
            && failed.error == Some(ConnectionError::Unavailable)
            && credential_poll(app, window, &failed.attempt_id).is_ok_and(|value| value == failed),
        "failed-unavailable-no-credential",
    )?;
    let state = settings_status(app, window, &choice.connection_id)?
        .map_err(|_| "credential-status-after-failure")?;
    let terminal = credential_cancel(app, window, &failed.attempt_id)
        .map_err(|_| "credential-terminal-cancel")?;
    observed(
        cases,
        "credential-terminal-cancel",
        terminal == failed && settings_same(app, window, &state)?,
        "idempotent-no-revision-change",
    )?;
    open(app, window, &paths.vault_b)?;
    let public_vault_result = (|| -> Result<bool, &'static str> {
        let poll = public_credential_invoke(
            app,
            window,
            "credential_acquisition",
            serde_json::json!({"attemptId": failed.attempt_id}),
        )?;
        let cancel = public_credential_invoke(
            app,
            window,
            "cancel_credential_acquisition",
            serde_json::json!({"attemptId": failed.attempt_id}),
        )?;
        let exact = serde_json::to_value(&failed).map_err(|_| "credential-route-view-encode")?;
        Ok(poll == Ok(exact.clone()) && cancel == Ok(exact) && settings_same(app, window, &state)?)
    })();
    let public_vault_restore = open(app, window, &paths.vault_a);
    let public_vault_same = public_vault_result?;
    public_vault_restore?;
    observed(
        cases,
        "credential-route-current-vault",
        public_vault_same,
        "original-app-owner-across-vault-switch",
    )?;
    let (pending2, worker2) = credential_begin(app, window, &choice, state.revision)
        .map_err(|_| "credential-second-begin")?;
    worker2
        .wait_until_parked()
        .map_err(|_| "credential-second-worker-park")?;
    observed(
        cases,
        "credential-second-begin",
        pending2.state == AcquisitionState::Pending
            && pending2.attempt_id != pending.attempt_id
            && pending2.expected_revision == state.revision + 1,
        "new-exact-pending",
    )?;
    let cancelled = credential_cancel(app, window, &pending2.attempt_id)
        .map_err(|_| "credential-cancel-unavailable")?;
    observed(
        cases,
        "credential-cancel",
        cancelled.state == AcquisitionState::Cancelled
            && cancelled.error == Some(ConnectionError::Cancelled)
            && credential_poll(app, window, &pending2.attempt_id)
                .is_ok_and(|value| value == cancelled),
        "durable-cancelled",
    )?;
    let after_cancel = settings_status(app, window, &choice.connection_id)?
        .map_err(|_| "credential-status-after-cancel")?;
    let settled = worker2
        .release_and_join()
        .map_err(|_| "credential-cancelled-worker-settlement")?;
    observed(
        cases,
        "credential-late-worker",
        settled == cancelled && settings_same(app, window, &after_cancel)?,
        "cancel-preserved-no-resurrection",
    )?;
    let disabled = settings_disable(app, window, &choice.connection_id, after_cancel.revision)?
        .map_err(|_| "credential-disable")?;
    observed(
        cases,
        "credential-disabled",
        disabled.health == ConnectionHealth::Disabled
            && disabled.account.is_none()
            && disabled.secret_revision == 0
            && disabled.revocation_generation == 1
            && !disabled.cleanup_pending
            && disabled.revision == 6,
        "disabled-no-secret-or-effect-authority",
    )?;
    observed(
        cases,
        "credential-runtime-replaced",
        replacement_probe(
            app,
            window,
            &paths,
            &known,
            &choice,
            disabled.revision,
            &cancelled.attempt_id,
        )?,
        "all-three-unavailable",
    )?;
    observed(
        cases,
        "credential-runtime-restored",
        refused(
            app,
            window,
            &choice,
            disabled.revision,
            &cancelled.attempt_id,
        ),
        "original-owner-stays-retired",
    )?;
    window.destroy().map_err(|_| "credential-main-destroy")?;
    let deadline = Instant::now() + Duration::from_secs(3);
    while app.get_webview_window(crate::shell::MAIN_WINDOW).is_some() {
        if Instant::now() >= deadline {
            return Err("credential-main-destroy-timeout");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    observed(
        cases,
        "credential-destroyed-window",
        refused(
            app,
            window,
            &choice,
            disabled.revision,
            &cancelled.attempt_id,
        ),
        "all-three-unavailable",
    )?;
    observed(
        cases,
        "credential-final-storage-audit",
        audit(&paths, &known, &disabled, &failed, &cancelled)?,
        "one-connection-two-terminal-attempts-zero-secrets-cleanup-grants",
    )?;
    Ok(())
}
pub(super) fn report(
    paths: &SmokePaths,
    cases: &[Case],
    failed_stage: Option<&'static str>,
) -> serde_json::Value {
    let reached = |name| cases.iter().any(|case| case.name == name);
    serde_json::json!({"format":4,"observer":"native-injected-window-credential-metadata-smoke","profile":"credential-metadata","passed":failed_stage.is_none(),"failedStage":failed_stage,"cases":cases,"compiledInputs":compiled_inputs(),
        "claims":{"actualMacosWindow":reached("credential-begin"),"actualInjectedCommand":paths.started.load(Ordering::SeqCst),"authenticatedAcquisitionWrappers":reached("credential-poll"),"disposableAccountMetadataWrites":paths.metadata_write_observed.load(Ordering::SeqCst),"unavailableHarnessWorkers":reached("credential-late-worker"),"individuallyRegisteredAcquisitionCommands":reached("credential-route-current-vault"),"credentialAccess":false,"realAccountImport":false,"providerNetwork":false,"keychainAccess":false,"grantsOrEffectsEnabled":false,"usableConnection":false},"timeBasis":"wall-clock deadlines; not deterministic performance evidence"})
}

// M96 public-route acceptance: Wry invokes the same registered production functions.
// The invocation key stays in native memory and never enters an audit/report.
fn public_credential_invoke(
    app: &AppHandle,
    window: &WebviewWindow,
    command: &str,
    payload: serde_json::Value,
) -> Result<Result<serde_json::Value, serde_json::Value>, &'static str> {
    let (send, receive) = std::sync::mpsc::sync_channel(1);
    let webview: &tauri::Webview<tauri::Wry> = window.as_ref();
    webview.clone().on_message(
        tauri::webview::InvokeRequest {
            cmd: command.into(),
            callback: tauri::ipc::CallbackFn(101),
            error: tauri::ipc::CallbackFn(102),
            url: window.url().map_err(|_| "credential-route-window-url")?,
            body: tauri::ipc::InvokeBody::Json(payload),
            headers: Default::default(),
            invoke_key: app.invoke_key().to_string(),
        },
        Box::new(move |_, _, response, _, _| {
            let value = match response {
                tauri::ipc::InvokeResponse::Ok(body) => body
                    .deserialize::<serde_json::Value>()
                    .map_err(|_| serde_json::json!("probe-response-decode")),
                tauri::ipc::InvokeResponse::Err(error) => Err(error.0),
            };
            let _ = send.try_send(value);
        }),
    );
    receive
        .recv_timeout(Duration::from_secs(2))
        .map_err(|_| "credential-route-response-timeout")
}

fn public_route_kind(
    command: &str,
    value: &Result<serde_json::Value, serde_json::Value>,
) -> &'static str {
    match value {
        Ok(_) => "success",
        Err(error) if error == &serde_json::json!("unavailable") => "domain_unavailable",
        Err(error) if error.as_str() == Some(format!("Command {command} not found").as_str()) => {
            "unknown_command"
        }
        Err(_) => "other_error",
    }
}

fn public_credential_refused(
    app: &AppHandle,
    window: &WebviewWindow,
    choice: &GhSelection,
    expected: u64,
    attempt: &AttemptId,
    audit_name: &'static str,
) -> Result<bool, &'static str> {
    let begin = public_credential_invoke(
        app,
        window,
        "begin_gh_import",
        serde_json::json!({
            "connectionId": choice.connection_id, "host": choice.host, "login": choice.login,
            "expectedRevision": expected, "person": "human:wire-forged", "vault": "wire-forged-vault"
        }),
    )?;
    let poll = public_credential_invoke(
        app,
        window,
        "credential_acquisition",
        serde_json::json!({
            "attemptId": attempt, "person": "human:wire-forged", "vault": "wire-forged-vault"
        }),
    )?;
    let cancel = public_credential_invoke(
        app,
        window,
        "cancel_credential_acquisition",
        serde_json::json!({
            "attemptId": attempt, "person": "human:wire-forged", "vault": "wire-forged-vault"
        }),
    )?;
    let audit = serde_json::to_vec_pretty(&serde_json::json!({
        "format": 1, "profile": if app.state::<SmokePaths>().credential_public { "credential-public" } else { "credential-metadata" }, "routes": [
            {"command": "begin_gh_import", "kind": public_route_kind("begin_gh_import", &begin)},
            {"command": "credential_acquisition", "kind": public_route_kind("credential_acquisition", &poll)},
            {"command": "cancel_credential_acquisition", "kind": public_route_kind("cancel_credential_acquisition", &cancel)}
        ]
    })).map_err(|_| "credential-route-audit-encode")?;
    if audit.len() > 4096 {
        return Err("credential-route-audit-bound");
    }
    let paths = app.state::<SmokePaths>();
    create(&paths.root.join(format!("{audit_name}.json")), &audit)
        .map_err(|_| "credential-route-audit-write")?;
    let unavailable = Err(serde_json::json!("unavailable"));
    Ok(begin == unavailable && poll == unavailable && cancel == unavailable)
}

// Separate process/profile: preserve the original metadata profile's 15 controls,
// four route checks, exact two attempts and final revision without changing them.
pub(super) fn capture_public(
    app: &AppHandle,
    window: &WebviewWindow,
    cases: &mut Vec<Case>,
) -> Result<(), &'static str> {
    let paths = app.state::<SmokePaths>();
    let login = "cerebro-public-bridge-smoke";
    let absent = GhSelection {
        connection_id: ConnectionId("public-bridge-not-created".into()),
        host: "github.com".into(),
        login: login.into(),
    };
    let missing = AttemptId("public-bridge-attempt-not-created".into());
    let known = public_credential_invoke(
        app,
        window,
        "capture_native_reads",
        serde_json::json!({"probe":null}),
    )?;
    let unknown = public_credential_invoke(
        app,
        window,
        "m96_unknown_credential_probe",
        serde_json::json!({}),
    )?;
    observed(
        cases,
        "public-bridge-dispatch-controls",
        known == Err(serde_json::json!("capture-already-started"))
            && public_route_kind("m96_unknown_credential_probe", &unknown) == "unknown_command",
        "known-and-unknown-distinct",
    )?;
    observed(
        cases,
        "public-bridge-before-open",
        public_credential_refused(
            app,
            window,
            &absent,
            1,
            &missing,
            "credential-public-before-open",
        )?,
        "all-three-domain-unavailable-not-unknown",
    )?;
    open(app, window, &paths.vault_a)?;
    let known = SettingsRuntime::capture(&paths)?;
    let added = settings_add(app, window, "github.com", login)?.map_err(|_| "public-bridge-add")?;
    paths.metadata_write_observed.store(true, Ordering::SeqCst);
    let choice = GhSelection {
        connection_id: added.connection_id.clone(),
        host: "github.com".into(),
        login: login.into(),
    };
    let invalid = public_credential_invoke(
        app,
        window,
        "begin_gh_import",
        serde_json::json!({
            "connectionId": added.connection_id, "host":"unsupported.example", "login":login,
            "expectedRevision":added.revision,
        }),
    )?;
    observed(
        cases,
        "public-bridge-invalid-selection",
        invalid == Err(serde_json::json!("unsupported")) && settings_same(app, window, &added)?,
        "domain-refusal-no-attempt",
    )?;
    let secondary = untrusted_window(app)?;
    let refused = public_credential_refused(
        app,
        &secondary,
        &choice,
        added.revision,
        &missing,
        "credential-public-wrong-window",
    );
    secondary
        .destroy()
        .map_err(|_| "public-bridge-secondary-destroy")?;
    observed(
        cases,
        "public-bridge-wrong-window",
        refused? && settings_same(app, window, &added)?,
        "native-window-wins-over-wire-selectors",
    )?;
    let pending = public_acquisition_view(
        app,
        window,
        "begin_gh_import",
        serde_json::json!({
            "connectionId": added.connection_id, "host":"github.com", "login":login,
            "expectedRevision":added.revision, "person":"human:forged", "vault":"forged",
        }),
    )?;
    observed(
        cases,
        "public-bridge-owned-begin",
        pending.connection_id == added.connection_id
            && pending.host == "github.com"
            && pending.login == login
            && pending.expected_revision == added.revision + 1
            && pending.revocation_generation == 0
            && pending.state == AcquisitionState::Pending
            && pending.error.is_none(),
        "pending-transferred-to-owned-worker",
    )?;
    let deadline = Instant::now() + Duration::from_secs(2);
    let terminal = loop {
        let view = public_acquisition_view(
            app,
            window,
            "credential_acquisition",
            serde_json::json!({"attemptId":pending.attempt_id}),
        )?;
        if view.state != AcquisitionState::Pending {
            break view;
        }
        if Instant::now() >= deadline {
            return Err("public-bridge-worker-timeout");
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    let status =
        settings_status(app, window, &added.connection_id)?.map_err(|_| "public-bridge-status")?;
    observed(
        cases,
        "public-bridge-unavailable-settlement",
        terminal.attempt_id == pending.attempt_id
            && terminal.connection_id == pending.connection_id
            && terminal.state == AcquisitionState::Failed
            && terminal.error == Some(ConnectionError::Unavailable)
            && status.health == ConnectionHealth::Unavailable
            && status.revision == added.revision + 2
            && status.account.is_none()
            && status.secret_revision == 0
            && !status.cleanup_pending,
        "one-terminal-attempt-zero-credential-backend",
    )?;
    open(app, window, &paths.vault_b)?;
    let across = (|| -> Result<bool, &'static str> {
        let poll = public_acquisition_view(
            app,
            window,
            "credential_acquisition",
            serde_json::json!({"attemptId":pending.attempt_id}),
        )?;
        let cancel = public_acquisition_view(
            app,
            window,
            "cancel_credential_acquisition",
            serde_json::json!({"attemptId":pending.attempt_id}),
        )?;
        Ok(poll == terminal && cancel == terminal && settings_same(app, window, &status)?)
    })();
    let restored = open(app, window, &paths.vault_a);
    let same = across?;
    restored?;
    observed(
        cases,
        "public-bridge-terminal-vault-switch",
        same,
        "exact-original-app-attempt-idempotent-cancel",
    )?;
    let replaced = replacement_probe(
        app,
        window,
        &paths,
        &known,
        &choice,
        status.revision,
        &terminal.attempt_id,
    )?;
    observed(
        cases,
        "public-bridge-retired-runtime",
        replaced
            && public_credential_refused(
                app,
                window,
                &choice,
                status.revision,
                &terminal.attempt_id,
                "credential-public-retired-runtime",
            )?,
        "original-owner-retired-no-reopen",
    )?;
    observed(
        cases,
        "public-bridge-storage-audit",
        public_storage_audit(&paths, &known, &status, &pending, &terminal)?,
        "one-selection-one-terminal-attempt-zero-secrets-cleanup-grants",
    )?;
    Ok(())
}
fn public_acquisition_view(
    app: &AppHandle,
    window: &WebviewWindow,
    command: &str,
    payload: serde_json::Value,
) -> Result<CredentialAcquisitionView, &'static str> {
    let value = public_credential_invoke(app, window, command, payload)?
        .map_err(|_| "public-bridge-domain-error")?;
    serde_json::from_value(value).map_err(|_| "public-bridge-safe-view-decode")
}
fn public_storage_audit(
    paths: &SmokePaths,
    known: &SettingsRuntime,
    status: &ConnectionStatus,
    pending: &CredentialAcquisitionView,
    terminal: &CredentialAcquisitionView,
) -> Result<bool, &'static str> {
    known.recheck(paths)?;
    let read =
        crate::runtime::ReadOnly::open(&paths.config).map_err(|_| "public-bridge-audit-open")?;
    let counts: (i64,i64,i64,i64,i64) = read.query_row("SELECT (SELECT count(*) FROM managed_connections),(SELECT count(*) FROM managed_connection_attempts),(SELECT count(*) FROM managed_connections WHERE secret_ref IS NOT NULL),(SELECT count(*) FROM managed_secret_cleanup),(SELECT count(*) FROM action_account_grants)", [], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?))).map_err(|_| "public-bridge-audit-counts")?;
    let owner = &crate::actions::schema::admission_rules().owner_storage_key;
    let record = read
        .query_row(
            STATUS_SQL,
            [&status.connection_id.0, owner],
            MetadataRecord::read,
        )
        .map_err(|_| "public-bridge-audit-status")?;
    let attempt = read
        .query_row(
            crate::connections::account_metadata::ACQUISITION_SQL,
            [&terminal.attempt_id.0, owner],
            crate::connections::account_metadata::AcquisitionRecord::read,
        )
        .map_err(|_| "public-bridge-audit-attempt")?
        .decode(owner, &terminal.attempt_id)
        .map_err(|_| "public-bridge-audit-decode")?;
    drop(read);
    known.recheck(paths)?;
    let matches = counts == (1, 1, 0, 0, 0)
        && record.status == *status
        && record.active.is_none()
        && record.reference.is_none()
        && CredentialAcquisitionView::from(&attempt) == *terminal;
    let bytes = serde_json::to_vec_pretty(&serde_json::json!({
        "format":1,"profile":"credential-public","counts":{"connections":counts.0,"attempts":counts.1,
        "secretReferences":counts.2,"cleanup":counts.3,"accountGrants":counts.4},
        "pending":pending,"terminal":terminal,"status":record.status,"matchesExpected":matches,
        "activeAttemptAbsent":record.active.is_none(),"secretReferenceAbsent":record.reference.is_none(),
        "physicalIdentity":known,
    })).map_err(|_| "public-bridge-audit-encode")?;
    if bytes.len() > 16384 {
        return Err("public-bridge-audit-bound");
    }
    create(&paths.root.join("credential-public-audit.json"), &bytes)
        .map_err(|_| "public-bridge-audit-write")?;
    Ok(matches)
}
pub(super) fn public_report(
    paths: &SmokePaths,
    cases: &[Case],
    failed_stage: Option<&'static str>,
) -> serde_json::Value {
    let reached = |name| cases.iter().any(|case| case.name == name);
    serde_json::json!({"format":1,"profile":"credential-public","observer":"native-public-credential-bridge-smoke",
        "passed":failed_stage.is_none(),"failedStage":failed_stage,"cases":cases,"compiledInputs":compiled_inputs(),
        "claims":{"actualInjectedCommand":paths.started.load(Ordering::SeqCst),
        "individuallyRegisteredAcquisitionCommands":reached("public-bridge-before-open"),
        "actualAuthenticatedPublicBegin":reached("public-bridge-owned-begin"),
        "ownedUnavailableWorkerSettled":reached("public-bridge-unavailable-settlement"),
        "originalAppOwnerAcrossVaults":reached("public-bridge-terminal-vault-switch"),
        "disposableAccountMetadataWrites":paths.metadata_write_observed.load(Ordering::SeqCst),
        "credentialAccess":false,"realAccountImport":false,"providerNetwork":false,"keychainAccess":false,
        "grantsOrEffectsEnabled":false,"usableConnection":false},
        "timeBasis":"wall-clock deadlines; not deterministic performance evidence"})
}
