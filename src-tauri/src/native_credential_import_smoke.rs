//! Default-off actual-window worker-to-import coordinator proof.
//! The fixed adapter cannot produce a token, provider request or OS-store call.
use super::*;
use crate::actions::native_owner::{
    credential_begin_import_fixture, credential_cancel, credential_poll,
};
use crate::connections::{metadata::CredentialAcquisitionView, AcquisitionState, GhSelection};

const LOGIN: &str = "cerebro-import-fixture";

fn audit(
    paths: &SmokePaths,
    known: &SettingsRuntime,
    expected: &ConnectionStatus,
    attempts: &[CredentialAcquisitionView; 3],
) -> Result<bool, &'static str> {
    known.recheck(paths)?;
    let read = crate::runtime::ReadOnly::open(&paths.config)
        .map_err(|_| "credential-import-audit-open")?;
    known.recheck(paths)?;
    let counts: (i64, i64, i64, i64, i64) = read.query_row(
        "SELECT (SELECT count(*) FROM managed_connections),(SELECT count(*) FROM managed_connection_attempts),(SELECT count(*) FROM managed_connections WHERE secret_ref IS NOT NULL),(SELECT count(*) FROM managed_secret_cleanup),(SELECT count(*) FROM action_account_grants)",
        [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
    ).map_err(|_| "credential-import-audit-counts")?;
    let owner = &crate::actions::schema::admission_rules().owner_storage_key;
    let record = read
        .query_row(
            STATUS_SQL,
            [&expected.connection_id.0, owner],
            MetadataRecord::read,
        )
        .map_err(|_| "credential-import-audit-status")?;
    let mut actual = Vec::new();
    for expected_attempt in attempts {
        let raw = read
            .query_row(
                crate::connections::account_metadata::ACQUISITION_SQL,
                [&expected_attempt.attempt_id.0, owner],
                crate::connections::account_metadata::AcquisitionRecord::read,
            )
            .map_err(|_| "credential-import-audit-attempt")?;
        let value = raw
            .decode(owner, &expected_attempt.attempt_id)
            .map_err(|_| "credential-import-audit-decode")?;
        actual.push(CredentialAcquisitionView::from(&value));
    }
    drop(read);
    known.recheck(paths)?;
    let matches = counts == (1, 3, 0, 0, 0)
        && record.status == *expected
        && record.active.is_none()
        && record.reference.is_none()
        && actual.as_slice() == attempts;
    let bytes = serde_json::to_vec_pretty(&serde_json::json!({
        "format":1,"profile":"credential-import-fixture",
        "counts":{"connections":counts.0,"attempts":counts.1,"secretReferences":counts.2,
            "cleanup":counts.3,"accountGrants":counts.4},
        "status":record.status,"attempts":actual,"matchesExpected":matches,
        "physicalIdentity":known,"activeAttemptAbsent":record.active.is_none(),
        "secretReferenceAbsent":record.reference.is_none(),
    }))
    .map_err(|_| "credential-import-audit-encode")?;
    if bytes.len() > 16384 {
        return Err("credential-import-audit-bound");
    }
    create(&paths.root.join("credential-import-audit.json"), &bytes)
        .map_err(|_| "credential-import-audit-write")?;
    Ok(matches)
}

pub(super) fn capture(
    app: &AppHandle,
    window: &WebviewWindow,
    cases: &mut Vec<Case>,
) -> Result<(), &'static str> {
    let paths = app.state::<SmokePaths>();
    let absent = GhSelection {
        connection_id: ConnectionId("credential-import-not-created".into()),
        host: "github.com".into(),
        login: LOGIN.into(),
    };
    observed(
        cases,
        "credential-import-before-open",
        credential_begin_import_fixture(app, window, &absent, 1).err()
            == Some(ConnectionError::Unavailable),
        "original-owner-unavailable",
    )?;
    open(app, window, &paths.vault_a)?;
    let known = SettingsRuntime::capture(&paths)?;
    let added =
        settings_add(app, window, "github.com", LOGIN)?.map_err(|_| "credential-import-add")?;
    paths.metadata_write_observed.store(true, Ordering::SeqCst);
    let choice = GhSelection {
        connection_id: added.connection_id.clone(),
        host: "github.com".into(),
        login: LOGIN.into(),
    };
    let mut wrong = choice.clone();
    wrong.host = "unsupported.example".into();
    let host = credential_begin_import_fixture(app, window, &wrong, added.revision).err();
    wrong = choice.clone();
    wrong.login = "other-login".into();
    let login = credential_begin_import_fixture(app, window, &wrong, added.revision).err();
    let stale = credential_begin_import_fixture(app, window, &choice, 0).err();
    observed(
        cases,
        "credential-import-invalid-selection",
        host == Some(ConnectionError::Unsupported)
            && login == Some(ConnectionError::InvalidSelection)
            && stale == Some(ConnectionError::StaleRevision)
            && settings_same(app, window, &added)?,
        "exact-refusals-no-worker",
    )?;

    let (pending, worker, fixture) =
        credential_begin_import_fixture(app, window, &choice, added.revision)
            .map_err(|_| "credential-import-begin")?;
    worker
        .wait_until_parked()
        .map_err(|_| "credential-import-worker-park")?;
    observed(
        cases,
        "credential-import-begin",
        pending.connection_id == added.connection_id
            && pending.host == "github.com"
            && pending.login == LOGIN
            && pending.expected_revision == added.revision + 1
            && pending.state == AcquisitionState::Pending
            && pending.error.is_none()
            && fixture.snapshot() == Ok([0, 0, 0]),
        "pending-original-owned-worker",
    )?;
    let polled =
        credential_poll(app, window, &pending.attempt_id).map_err(|_| "credential-import-poll")?;
    observed(
        cases,
        "credential-import-poll",
        polled == pending && fixture.snapshot() == Ok([0, 0, 0]),
        "exact-pending-no-adapter",
    )?;
    let failed = worker
        .release_and_join()
        .map_err(|_| "credential-import-join")?;
    let calls = fixture
        .snapshot()
        .map_err(|_| "credential-import-call-audit")?;
    let bridge_audit = serde_json::to_vec_pretty(&serde_json::json!({
        "format":2,"profile":"credential-import-fixture","attempt":failed,
        "acquisitionContract":"selected-token-no-refresh-v1",
        "fixtureCalls":{"tokenCapture":calls[0],"identity":calls[1],"secretStore":calls[2]},
        "expectedCalls":[1,0,0],"realCredentialAccess":false,
    }))
    .map_err(|_| "credential-import-call-audit-encode")?;
    if bridge_audit.len() > 4096 {
        return Err("credential-import-call-audit-bound");
    }
    create(
        &paths.root.join("credential-import-worker.json"),
        &bridge_audit,
    )
    .map_err(|_| "credential-import-call-audit-write")?;
    // RED: the old unavailable worker skips import_account, leaving all three
    // counters zero. Only the existing coordinator's acquire path can visit
    // these fixed adapter boundaries; no secret value can leave the fixture.
    observed(
        cases,
        "credential-import-coordinator",
        failed.state == AcquisitionState::Failed
            && failed.error == Some(ConnectionError::Unavailable)
            && credential_poll(app, window, &failed.attempt_id).is_ok_and(|value| value == failed)
            && fixture.snapshot() == Ok([1, 0, 0]),
        "selected-capture-once-no-refresh-identity-store-never",
    )?;

    let after_failure = settings_status(app, window, &choice.connection_id)?
        .map_err(|_| "credential-import-status-after-failure")?;
    let (pending2, worker2, cancelled_fixture) =
        credential_begin_import_fixture(app, window, &choice, after_failure.revision)
            .map_err(|_| "credential-import-cancel-begin")?;
    worker2
        .wait_until_parked()
        .map_err(|_| "credential-import-cancel-park")?;
    let cancelled = credential_cancel(app, window, &pending2.attempt_id)
        .map_err(|_| "credential-import-cancel")?;
    let after_cancel = settings_status(app, window, &choice.connection_id)?
        .map_err(|_| "credential-import-status-after-cancel")?;
    let late = worker2
        .release_and_join()
        .map_err(|_| "credential-import-cancel-join")?;
    observed(
        cases,
        "credential-import-cancel-before-release",
        cancelled.state == AcquisitionState::Cancelled
            && cancelled.error == Some(ConnectionError::Cancelled)
            && late == cancelled
            && cancelled_fixture.snapshot() == Ok([0, 0, 0])
            && settings_same(app, window, &after_cancel)?,
        "cancel-preserved-before-any-adapter",
    )?;

    let (pending3, worker3, disabled_fixture) =
        credential_begin_import_fixture(app, window, &choice, after_cancel.revision)
            .map_err(|_| "credential-import-disable-begin")?;
    worker3
        .wait_until_parked()
        .map_err(|_| "credential-import-disable-park")?;
    let disabled = settings_disable(
        app,
        window,
        &choice.connection_id,
        pending3.expected_revision,
    )?
    .map_err(|_| "credential-import-disable")?;
    let disabled_attempt = worker3
        .release_and_join()
        .map_err(|_| "credential-import-disable-join")?;
    observed(
        cases,
        "credential-import-disable-before-release",
        disabled.health == ConnectionHealth::Disabled
            && disabled.revocation_generation == 1
            && disabled.revision == 7
            && disabled.account.is_none()
            && disabled.secret_revision == 0
            && !disabled.cleanup_pending
            && disabled_attempt.state == AcquisitionState::Cancelled
            && disabled_attempt.error == Some(ConnectionError::Cancelled)
            && disabled_fixture.snapshot() == Ok([0, 0, 0])
            && settings_same(app, window, &disabled)?,
        "disabled-original-generation-zero-adapter-work",
    )?;
    observed(
        cases,
        "credential-import-final-storage-audit",
        audit(
            &paths,
            &known,
            &disabled,
            &[failed, cancelled, disabled_attempt],
        )?,
        "one-connection-three-terminal-attempts-zero-secrets-cleanup-grants",
    )?;
    Ok(())
}

pub(super) fn report(
    paths: &SmokePaths,
    cases: &[Case],
    failed_stage: Option<&'static str>,
) -> serde_json::Value {
    let reached = |name| cases.iter().any(|case| case.name == name);
    serde_json::json!({
        "format":7,"observer":"native-injected-window-credential-import-fixture",
        "acquisitionContract":"selected-token-no-refresh-v1",
        "profile":"credential-import-fixture","passed":failed_stage.is_none(),
        "failedStage":failed_stage,"cases":cases,"compiledInputs":compiled_inputs(),
        "claims":{"actualMacosWindow":reached("credential-import-begin"),
            "actualInjectedCommand":paths.started.load(Ordering::SeqCst),
            "ownedWorkerImportCoordinator":reached("credential-import-coordinator"),
            "disposableAccountMetadataWrites":paths.metadata_write_observed.load(Ordering::SeqCst),
            "fixedNoSecretAdapter":reached("credential-import-coordinator"),
            "individuallyRegisteredAcquisitionCommands":false,"credentialAccess":false,
            "realAccountImport":false,"providerNetwork":false,"keychainAccess":false,
            "grantsOrEffectsEnabled":false,"usableConnection":false},
        "timeBasis":"wall-clock deadlines; not deterministic performance evidence",
    })
}
