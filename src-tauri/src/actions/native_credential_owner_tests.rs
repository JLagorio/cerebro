//! Real retained owner + transactions; no installed gh/provider/Keychain work.
use super::*;
fn pending(f: &Fixture) -> CredentialAcquisition {
    let first = match f
        .metadata(Op::Connect {
            selection: &selection(),
        })
        .unwrap()
    {
        Out::Status(status) => status,
        _ => unreachable!(),
    };
    f.owner
        .begin_account_acquisition(&selection(), first.revision)
        .unwrap()
}
#[test]
fn committed_cancel_sets_original_worker_atomic_and_late_registration_refuses() {
    let f = Fixture::new("m96-cancel-atomic-commit");
    let ticket = pending(&f);
    let registration = f.owner.credential_cancellation(&ticket).unwrap();
    f.owner
        .cancel_account_acquisition(&ticket.attempt_id)
        .unwrap();
    assert!(registration.flag.stopped());
    // Finish the already-cancelled worker registration before testing a late
    // registration. A simultaneously live duplicate must remain Unavailable.
    drop(registration);
    assert_eq!(
        f.owner.credential_cancellation(&ticket).err(),
        Some(ConnectionError::Cancelled)
    );
    assert_eq!(
        f.attempt(&ticket.attempt_id).state,
        AcquisitionState::Cancelled
    );
}
#[test]
fn supersede_notification_does_not_cancel_new_attempt_and_disable_does() {
    let f = Fixture::new("m96-cancel-atomic-supersede");
    let first = pending(&f);
    let old = f.owner.credential_cancellation(&first).unwrap();
    let second = f
        .owner
        .begin_account_acquisition(&selection(), first.expected_revision)
        .unwrap();
    assert!(old.flag.stopped());
    let current = f.owner.credential_cancellation(&second).unwrap();
    f.owner
        .cancel_account_acquisition(&first.attempt_id)
        .unwrap();
    assert!(!current.flag.stopped());
    f.owner
        .disable_account(&second.connection_id, second.expected_revision)
        .unwrap();
    assert!(current.flag.stopped());
    assert_eq!(f.status().health, ConnectionHealth::Disabled);
}
#[test]
fn unrelated_classified_transaction_uncertainty_cancels_credential_flags_at_owner_seam() {
    let f = Fixture::new("m96-cancel-atomic-any-transaction");
    let ticket = pending(&f);
    let registration = f.owner.credential_cancellation(&ticket).unwrap();
    let result = super::super::tests::with_transaction_ack_probe(|| {
        super::super::tests::lose_next_transaction_ack();
        let mut storage = f.owner.storage.lock().unwrap();
        storage
            .owner
            .as_mut()
            .unwrap()
            .classified_transaction(|_| Ok(()))
    });
    assert_eq!(result, RuntimeTransactionOutcome::CommitUncertain);
    assert!(
        registration.flag.stopped(),
        "retirement inside any owner transaction must notify before its wrapper returns"
    );
}
#[test]
fn public_worker_uses_explicit_fixture_boundary_and_never_installed_credentials() {
    let f = Fixture::new("m96-native-bundle-injected");
    let selected = GhSelection {
        connection_id: ConnectionId("native-bundle-fixture".into()),
        host: "github.com".into(),
        login: "cerebro-import-fixture".into(),
    };
    let first = match f
        .metadata(Op::Connect {
            selection: &selected,
        })
        .unwrap()
    {
        Out::Status(status) => status,
        _ => unreachable!(),
    };
    let fixture = super::super::native_account_worker_fixture::CredentialImportFixture::default();
    let control = super::super::native_account_commands::handoff_probe::Control::new(false, false);
    let view = super::super::native_credential_bundle::with_fixture(fixture.clone(), || {
        control.enter(|| {
            super::super::native_account_commands::begin_owned_on_owner(
                f.owner.clone(),
                &selected,
                first.revision,
            )
        })
    })
    .unwrap();
    control.wait_until_parked();
    f.assert_unlocked();
    assert_eq!(fixture.snapshot().unwrap(), [0, 0, 0]);
    let settled = control.release_and_wait().unwrap();
    assert_eq!(settled.attempt_id, view.attempt_id);
    assert_eq!(settled.state, AcquisitionState::Failed);
    assert_eq!(settled.error, Some(ConnectionError::Unavailable));
    assert_eq!(fixture.snapshot().unwrap(), [1, 0, 0]);
    assert!(f.cleanup().is_empty());
}
