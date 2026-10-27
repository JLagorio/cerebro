//! Real retained RuntimeOwner/shared ACT rows; never an OS gesture/origin proof.
use super::*;
use crate::actions::{
    effect_kernel as kernel, effect_record::PrepareAction, service::test_support::Harness,
};
fn seed(label: &str) -> (Harness, RuntimeOwner, PrepareAction) {
    let h = Harness::new(label);
    let p = h.prepare("seed", "first").unwrap();
    let ordinary = crate::runtime::open_existing(h.dir()).unwrap();
    let mut request = kernel::load(&ordinary, &p.effect.invocation_id)
        .unwrap()
        .request;
    request.request_key = "native-transaction".into();
    let owner = RuntimeOwner::open_existing(&h.dir().canonicalize().unwrap()).unwrap();
    (h, owner, request)
}
#[test]
fn native_action_transaction_uses_real_retained_writer_and_shared_prepare_rows() {
    let (h, mut owner, request) = seed("native-act-prepare");
    let subject = h.subject();
    let service = h.service();
    let rows = action_transaction(&mut owner, |conn| {
        kernel::prepare_rows(conn, &service, subject.view(), request)
    })
    .expect("known committed prepare");
    assert!(rows.inserted);
    assert_eq!(h.invocations(), 2);
    assert!(owner.conn.is_autocommit());
    assert!(!owner.retired);
}
#[test]
fn native_action_transaction_preserves_domain_refusal_and_rolls_back_all_mutations() {
    let (h, mut owner, request) = seed("native-act-domain-rollback");
    let before = h.raw_action_rows();
    let subject = h.subject();
    let service = h.service();
    let result: Result<(), ActionError> = action_transaction(&mut owner, |conn| {
        kernel::prepare_rows(conn, &service, subject.view(), request)?;
        Err(kernel::denied())
    });
    assert_eq!(result.unwrap_err().code, ActionErrorCode::Denied);
    assert_eq!(h.raw_action_rows(), before);
    assert!(!owner.retired);
}
#[test]
fn native_action_transaction_commits_claim_refusal_as_value_before_returning_domain_error() {
    let h = Harness::new("native-act-commit-refusal");
    let p = h.prepare("request", "first").unwrap();
    h.allow(&p.effect.invocation_id).unwrap();
    h.expire_id(&p.effect.invocation_id);
    let mut owner = RuntimeOwner::open_existing(&h.dir().canonicalize().unwrap()).unwrap();
    let service = h.service();
    let physical = crate::runtime::action_invocations::try_submission_owner(
        &owner.conn,
        h.dir(),
        &p.effect.invocation_id.0,
    )
    .unwrap()
    .unwrap();
    let outcome = action_transaction(&mut owner, |conn| {
        kernel::claim_rows(conn, &service, &p.effect.invocation_id)
    })
    .expect("changed domain refusal must commit");
    let kernel::ClaimDisposition::CommitRefusal(refusal) = outcome else {
        panic!("expired approval cannot claim")
    };
    assert_eq!(refusal.code, ActionErrorCode::Denied);
    let actual = kernel::load(&owner.conn, &p.effect.invocation_id).unwrap();
    assert_eq!(
        actual.details.effect.state,
        InvocationState::AwaitingApproval
    );
    assert!(actual.approval.unwrap().retired);
    assert_eq!(h.attempts(), 0);
    assert_eq!(h.submissions(), 0);
    drop(physical);
}
#[test]
fn native_action_transaction_lost_ack_never_returns_dispatch_authority_or_reopens() {
    let (h, mut owner, request) = seed("native-act-lost-ack");
    let subject = h.subject();
    let service = h.service();
    let outcome = super::super::tests::with_transaction_ack_probe(|| {
        super::super::tests::lose_next_transaction_ack();
        action_transaction(&mut owner, |conn| {
            kernel::prepare_rows(conn, &service, subject.view(), request)
        })
    });
    assert_eq!(
        outcome
            .err()
            .expect("uncertain commit has no returned action value")
            .code,
        ActionErrorCode::Unavailable
    );
    assert!(owner.retired);
    assert_eq!(
        h.invocations(),
        2,
        "test seam loses ack only after a real commit"
    );
    assert_eq!(h.submissions(), 0);
}
#[test]
fn native_action_submission_owner_uses_original_retained_identity_and_shared_physical_lock() {
    let (h, mut owner, _) = seed("native-act-physical-owner");
    let ordinary = crate::runtime::open_existing(h.dir()).unwrap();
    let id = InvocationId(
        ordinary
            .query_row("SELECT invocation_id FROM action_invocations", [], |r| {
                r.get(0)
            })
            .unwrap(),
    );
    let held = owner
        .action_submission_owner(&id)
        .expect("retained physical owner")
        .expect("first physical owner");
    assert!(
        crate::runtime::action_invocations::try_submission_owner(&ordinary, h.dir(), &id.0)
            .unwrap()
            .is_none(),
        "fixture/native callers must share one real lock protocol"
    );
    let mut other = RuntimeOwner::open_existing(&h.dir().canonicalize().unwrap()).unwrap();
    assert!(other.action_submission_owner(&id).unwrap().is_none());
    drop(held);
    assert!(other.action_submission_owner(&id).unwrap().is_some());
}
#[test]
fn native_action_submission_owner_rejects_replaced_database_without_creating_lock_for_replacement()
{
    let (h, mut owner, _) = seed("native-act-replaced-before-lease");
    let id = InvocationId(
        owner
            .conn
            .query_row("SELECT invocation_id FROM action_invocations", [], |r| {
                r.get(0)
            })
            .unwrap(),
    );
    let path = crate::runtime::runtime_db_path(h.dir());
    std::fs::rename(&path, h.dir().join("original-runtime.db")).unwrap();
    std::fs::write(&path, b"replacement bytes").unwrap();
    assert!(owner.action_submission_owner(&id).is_err());
    assert!(owner.retired);
    assert!(!h.dir().join(".action-submission-owners").exists());
    assert_eq!(std::fs::read(path).unwrap(), b"replacement bytes");
}

#[test]
fn native_action_submission_owner_refuses_renamed_recreated_child_lock_namespace_while_original_is_held(
) {
    use std::os::unix::fs::PermissionsExt;
    let (h, mut original, _) = seed("native-act-lock-namespace-aba");
    let id = InvocationId(
        original
            .conn
            .query_row("SELECT invocation_id FROM action_invocations", [], |r| {
                r.get(0)
            })
            .unwrap(),
    );
    let held = original.action_submission_owner(&id).unwrap().unwrap();
    let namespace = h.dir().join(".action-submission-owners");
    let retained = h.dir().join("held-original-submission-owners");
    std::fs::rename(&namespace, &retained).unwrap();
    std::fs::create_dir(&namespace).unwrap();
    std::fs::set_permissions(&namespace, std::fs::Permissions::from_mode(0o700)).unwrap();
    let mut other = RuntimeOwner::open_existing(&h.dir().canonicalize().unwrap()).unwrap();
    let attempt = other.action_submission_owner(&id);
    assert!(!matches!(attempt,Ok(Some(_))),"a renamed/recreated child directory must not establish a second physical lock namespace for the same retained database/invocation");
    drop(held);
}

#[test]
fn native_action_submission_owner_refuses_renamed_recreated_lock_file_while_original_is_held() {
    use std::os::unix::fs::OpenOptionsExt;
    let (h, mut original, _) = seed("native-act-lock-file-aba");
    let id = InvocationId(
        original
            .conn
            .query_row("SELECT invocation_id FROM action_invocations", [], |r| {
                r.get(0)
            })
            .unwrap(),
    );
    let held = original.action_submission_owner(&id).unwrap().unwrap();
    let namespace = h.dir().join(".action-submission-owners");
    let path = std::fs::read_dir(&namespace)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|path| path.extension().is_some_and(|ext| ext == "lock"))
        .unwrap();
    std::fs::rename(&path, namespace.join("retained-original.lock")).unwrap();
    let replacement = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&path)
        .unwrap();
    drop(replacement);
    let mut other = RuntimeOwner::open_existing(&h.dir().canonicalize().unwrap()).unwrap();
    let attempt = other.action_submission_owner(&id);
    assert!(!matches!(attempt,Ok(Some(_))),"same parent/child directory but replaced lock inode must never grant another physical owner");
    drop(held);
}
#[test]
fn native_action_submission_owner_refuses_caller_transaction_without_nested_begin_or_commit() {
    let (h, mut owner, _) = seed("native-act-lease-active-tx");
    let id = InvocationId(
        owner
            .conn
            .query_row("SELECT invocation_id FROM action_invocations", [], |r| {
                r.get(0)
            })
            .unwrap(),
    );
    owner.conn.execute_batch("BEGIN IMMEDIATE").unwrap();
    let result = owner.action_submission_owner(&id);
    assert!(
        result.is_err(),
        "retained lease API cannot create or commit a nested caller transaction"
    );
    assert!(!owner.conn.is_autocommit());
    assert!(!h.dir().join(".action-submission-owners").exists());
    owner.conn.execute_batch("ROLLBACK").unwrap();
}
