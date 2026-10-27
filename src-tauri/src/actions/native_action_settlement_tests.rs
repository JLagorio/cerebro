//! Actual retained owner / original-fact probes only. No native window,
//! publication, Keychain or live HTTP fixture; captured row facts are metadata.
use super::*;
use crate::actions::service::test_support::Harness;
use rusqlite::params;
const NOW: &str = "2026-10-26T00:00:00.000Z";
const SESSION: &str = "settlement-fixture-session";
struct Fixture {
    h: Harness,
    owner: RuntimeOwner,
    store: super::super::super::NativeStoreObservation,
    physical: SubmissionOwner,
    facts: SubmissionFacts,
    root: std::path::PathBuf,
}
impl Fixture {
    fn new(label: &str) -> Self {
        let h = Harness::new(label);
        let prepared = h.prepare("original", "first").unwrap();
        h.allow(&prepared.effect.invocation_id).unwrap();
        let root = h.dir().join("fixture-vault");
        std::fs::create_dir(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let info = crate::ledger::store::load_or_mint(&root.join(".cerebro/ledger")).unwrap();
        let store = super::super::super::read_native_store(&root).unwrap();
        let mut owner = RuntimeOwner::open_existing(&h.dir().canonicalize().unwrap()).unwrap();
        let scope = h.subject().view().clone();
        action_transaction(&mut owner, |conn| {
            conn.execute(
                "INSERT INTO vault_registry(vault_id,vault_path,first_seen_at) VALUES(?1,?2,?3)",
                params![scope.vault_id, root.to_str().unwrap(), NOW],
            )
            .unwrap();
            crate::runtime::catchup::open_session(
                conn,
                SESSION,
                &scope.vault_id,
                &info.store_id,
                NOW.parse().unwrap(),
            )
            .unwrap();
            crate::runtime::dispatch::begin_attended(
                conn,
                &scope.run_id,
                Some(&scope.vault_id),
                Some(&info.store_id),
                Some(&scope.actor_id),
                None,
                None,
                NOW.parse().unwrap(),
            )
            .unwrap();
            conn.execute(
                "UPDATE runs SET cli_session_id='settlement-fixture-cli' WHERE run_id=?1",
                [&scope.run_id],
            )
            .unwrap();
            native_lineage::insert_if_absent(
                conn,
                &native_lineage::NativeBinding {
                    run_id: &scope.run_id,
                    vault_id: &scope.vault_id,
                    store_uuid: &info.store_id,
                    canonical_vault: &root,
                    owner_person: "human:me",
                    actor_id: &scope.actor_id,
                    source_kind: "run",
                    app_session_id: SESSION,
                    cli_session_id: Some("settlement-fixture-cli"),
                    parent_run_id: None,
                    client_id: None,
                    child_job_id: None,
                },
                "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                NOW,
            )
            .unwrap();
            Ok(())
        })
        .unwrap();
        let id = prepared.effect.invocation_id;
        let physical = owner.action_submission_owner(&id).unwrap().unwrap();
        let service = h.service();
        let attempt = action_transaction(&mut owner, |conn| {
            match kernel::claim_rows(conn, &service, &id)? {
                kernel::ClaimDisposition::Claimed { attempt_id, .. } => Ok(attempt_id),
                kernel::ClaimDisposition::CommitRefusal(error) => Err(error),
            }
        })
        .unwrap();
        let native =
            native_lineage::load_run(AuthorityDb::Writer(&owner.conn), &scope.run_id).unwrap();
        let record = kernel::load(&owner.conn, &id).unwrap();
        let facts = SubmissionFacts {
            runtime_seal: owner.runtime_seal.clone(),
            runtime_identity: owner.identity,
            invocation: id,
            attempt,
            native_run: scope.run_id,
            native_fingerprint: native_fingerprint(&native).unwrap(),
            action_fingerprint: action_fingerprint(&record).unwrap(),
        };
        Self {
            h,
            owner,
            store,
            physical,
            facts,
            root,
        }
    }
    fn settle(&mut self, observation: kernel::Observation) -> Result<ActionEffectRef, ActionError> {
        settle_original_rows(
            &mut self.owner,
            &self.store,
            &self.physical,
            &self.facts,
            observation,
        )
    }
    fn success(&mut self) -> Result<ActionEffectRef, ActionError> {
        self.settle(kernel::Observation::Succeeded {
            output: "null".into(),
            remote_effect_reference: Some("fixture-effect:42".into()),
        })
    }
    fn rows(&self) -> Vec<String> {
        self.h.raw_action_rows()
    }
    fn close_source(&mut self, kind: &str) {
        action_transaction(&mut self.owner,|conn|{
            conn.execute("UPDATE runs SET outcome='succeeded',ended_at=?1 WHERE run_id=?2",params![NOW,self.facts.native_run]).unwrap();
            conn.execute("UPDATE action_native_runs SET revision=revision+1,closed_at=?1,close_kind=?2 WHERE run_id=?3",params![NOW,kind,self.facts.native_run]).unwrap();
            let vault=kernel::load(conn,&self.facts.invocation)?.scope.vault_id;
            crate::runtime::catchup::close_session(conn,SESSION,&vault,&self.store.info.store_id,NOW.parse().unwrap()).unwrap();
            Ok(())
        }).unwrap();
    }
}
#[test]
fn original_claim_source_disappearance_prevents_provider_poll_and_settles_not_applied() {
    let mut f = Fixture::new("original-capsule-source-gone");
    f.close_source("completed");
    let mut polls = 0;
    let observation = match pre_submit_decision(false, false) {
        PreSubmitDecision::NotSubmitted => kernel::Observation::ConfirmedNotApplied,
        PreSubmitDecision::Poll => {
            polls += 1;
            kernel::Observation::Unknown
        }
    };
    assert_eq!(
        polls, 0,
        "source disappearance after known claim must not poll the provider"
    );
    let effect = f.settle(observation).unwrap();
    assert_eq!(effect.state, InvocationState::Failed);
    assert_eq!(f.h.submissions(), 0);
}
#[test]
fn original_claim_cancellation_during_secret_resolution_prevents_provider_poll() {
    let mut f = Fixture::new("original-capsule-resolver-cancel");
    let book = Arc::new(cancellation::CancellationBook::default());
    let registration = book
        .register_fixture(
            &f.facts.native_run,
            &ConnectionId("connection".into()),
            &f.facts.invocation,
        )
        .unwrap();
    // Deterministic resolver boundary: the actual registry changes after claim,
    // before the first provider future poll; no installed secret store is used.
    book.cancel_connection(&ConnectionId("connection".into()));
    let mut polls = 0;
    let observation = match pre_submit_decision(true, registration.stopped()) {
        PreSubmitDecision::NotSubmitted => kernel::Observation::ConfirmedNotApplied,
        PreSubmitDecision::Poll => {
            polls += 1;
            kernel::Observation::Unknown
        }
    };
    assert_eq!(
        polls, 0,
        "account/run cancellation after synchronous resolution must prevent submission"
    );
    assert_eq!(
        f.settle(observation).unwrap().state,
        InvocationState::Failed
    );
    assert_eq!(f.h.submissions(), 0);
}
#[test]
fn original_completed_fact_survives_natural_end_revocation_stop_and_closed_context() {
    for kind in ["completed", "revoked", "stopped", "context_closed"] {
        let mut f = Fixture::new(&format!("original-capsule-{kind}"));
        let seal = f.owner.runtime_seal.clone();
        let identity = f.owner.identity;
        f.close_source(kind);
        if kind == "revoked" {
            f.h.change_authority("revocation");
        }
        let effect = f
            .success()
            .expect("original completed fact needs no new publication, grant or opening");
        assert_eq!(effect.state, InvocationState::Succeeded);
        assert!(Arc::ptr_eq(&seal, &f.owner.runtime_seal));
        assert_eq!(f.owner.identity, identity);
        let actual = kernel::load(&f.owner.conn, &f.facts.invocation).unwrap();
        let attempt = actual.details.attempts.last().unwrap();
        assert_eq!(attempt.attempt_id, f.facts.attempt);
        assert!(attempt.receipt_id.is_some());
        assert_eq!(f.h.attempts(), 1);
        assert_eq!(f.h.submissions(), 0);
    }
}
#[test]
fn original_capsule_refuses_second_owner_even_for_same_database() {
    let f = Fixture::new("original-capsule-other-owner");
    let before = f.rows();
    let mut reopened = RuntimeOwner::open_existing(&f.h.dir().canonicalize().unwrap()).unwrap();
    assert!(!Arc::ptr_eq(&reopened.runtime_seal, &f.facts.runtime_seal));
    assert_eq!(
        settle_original_rows(
            &mut reopened,
            &f.store,
            &f.physical,
            &f.facts,
            kernel::Observation::Unknown
        )
        .unwrap_err()
        .code,
        ActionErrorCode::Unavailable
    );
    assert_eq!(f.rows(), before);
}
#[test]
fn original_capsule_refuses_changed_original_store_bytes() {
    let mut f = Fixture::new("original-capsule-store-changed");
    let before = f.rows();
    let mut info = f.store.info.clone();
    info.store_id = "cccccccccccccccccccccccccccccccc".into();
    std::fs::write(
        f.root.join(".cerebro/ledger/store.json"),
        serde_json::to_vec(&info).unwrap(),
    )
    .unwrap();
    assert_eq!(f.success().unwrap_err().code, ActionErrorCode::Unavailable);
    assert_eq!(f.rows(), before);
}
#[test]
fn original_capsule_refuses_changed_action_request() {
    let mut f = Fixture::new("original-capsule-action-changed");
    f.owner.conn.execute("UPDATE action_invocations SET request_digest=?1,payload=json_set(payload,'$.request_digest',?1) WHERE invocation_id=?2",params!["0".repeat(64),f.facts.invocation.0]).unwrap();
    let before = f.rows();
    assert_eq!(f.success().unwrap_err().code, ActionErrorCode::Unavailable);
    assert_eq!(f.rows(), before);
}
#[test]
fn original_capsule_refuses_other_actual_attempt() {
    let mut f = Fixture::new("original-capsule-attempt-changed");
    f.facts.attempt = AttemptId("cccccccccccccccccccccccccccccccc".into());
    let before = f.rows();
    assert_eq!(f.success().unwrap_err().code, ActionErrorCode::Unavailable);
    assert_eq!(f.rows(), before);
}
#[test]
fn original_capsule_refuses_changed_native_identity() {
    let mut f = Fixture::new("original-capsule-native-changed");
    f.owner.conn.execute("UPDATE action_native_runs SET authority_id='cccccccccccccccccccccccccccccccc' WHERE run_id=?1",[&f.facts.native_run]).unwrap();
    let before = f.rows();
    assert_eq!(f.success().unwrap_err().code, ActionErrorCode::Unavailable);
    assert_eq!(f.rows(), before);
}

#[test]
fn original_observation_returns_actual_validated_null_without_confusing_it_with_missing_output() {
    let mut f = Fixture::new("original-output-null");
    let value = action_transaction(&mut f.owner, |conn| {
        kernel::observe_completed_rows(
            conn,
            &f.facts.invocation,
            &f.facts.attempt,
            None,
            kernel::Observation::Succeeded {
                output: "  null ".into(),
                remote_effect_reference: Some("fixture-effect:42".into()),
            },
        )
    })
    .unwrap();
    assert_eq!(value.effect.state, InvocationState::Succeeded);
    assert_eq!(
        value
            .output
            .expect("actual validated output retained transiently")
            .canonical,
        "null"
    );
    let record = kernel::load(&f.owner.conn, &f.facts.invocation).unwrap();
    assert!(record.details.attempts.last().unwrap().receipt_id.is_some());
}
#[test]
fn malformed_observation_output_remains_unknown_and_cannot_escape_as_transient_success() {
    let mut f = Fixture::new("original-output-invalid");
    let value = action_transaction(&mut f.owner, |conn| {
        kernel::observe_completed_rows(
            conn,
            &f.facts.invocation,
            &f.facts.attempt,
            None,
            kernel::Observation::Succeeded {
                output: "{}".into(),
                remote_effect_reference: Some("fixture-effect:42".into()),
            },
        )
    })
    .unwrap();
    assert_eq!(value.effect.state, InvocationState::OutcomeUnknown);
    assert!(value.output.is_none());
}
#[test]
fn confirmed_not_applied_does_not_invent_an_output_value() {
    let mut f = Fixture::new("original-output-not-applied");
    let value = action_transaction(&mut f.owner, |conn| {
        kernel::observe_completed_rows(
            conn,
            &f.facts.invocation,
            &f.facts.attempt,
            None,
            kernel::Observation::ConfirmedNotApplied,
        )
    })
    .unwrap();
    assert_eq!(value.effect.state, InvocationState::Failed);
    assert!(value.output.is_none());
}
#[test]
fn transient_observation_rows_cannot_commit_their_own_output_or_receipt() {
    let mut f = Fixture::new("original-output-rollback");
    let before = f.rows();
    let tx = f
        .owner
        .conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .unwrap();
    let value = kernel::observe_completed_rows(
        &tx,
        &f.facts.invocation,
        &f.facts.attempt,
        None,
        kernel::Observation::Succeeded {
            output: "null".into(),
            remote_effect_reference: None,
        },
    )
    .unwrap();
    assert!(value.output.is_some());
    tx.rollback().unwrap();
    assert_eq!(f.rows(), before);
}

// This exercises the actual row-disposition seam on the retained RuntimeOwner.
// The fixture context is row metadata, not an authenticated native capability.
fn check_original_prepare_redelivery(state: &str) {
    let mut f = Fixture::new(&format!("original-prepare-replay-{state}"));
    let id = if state == "dispatched" {
        f.facts.invocation.clone()
    } else {
        f.settle(kernel::Observation::ConfirmedNotApplied).unwrap();
        let prepared = f.h.prepare("observed-request", "second").unwrap();
        if state == "ready" {
            f.h.allow(&prepared.effect.invocation_id).unwrap();
        }
        prepared.effect.invocation_id
    };
    let record = kernel::load(&f.owner.conn, &id).unwrap();
    let request = record.request.clone();
    let scope = record.scope.clone();
    let service = f.h.service();
    let before = f.rows();
    let attempts = f.h.attempts();
    let disposition = action_transaction(&mut f.owner, |conn| {
        let native = native_lineage::load_run(AuthorityDb::Writer(conn), &scope.run_id)
            .map_err(|_| kernel::unavailable())?;
        super::managed_call::prepare_record_rows(conn, &service, &scope, &native, request)
    })
    .unwrap();
    let super::managed_call::PreparedRecordRows::Existing(observed) = disposition else {
        panic!("a redelivered existing action must not mint a new cancellation/dispatch owner");
    };
    assert_eq!(observed.details.effect.invocation_id, id);
    assert_eq!(observed.details.effect.state, record.details.effect.state);
    assert_eq!(f.rows(), before);
    assert_eq!(f.h.attempts(), attempts);
    assert_eq!(f.h.submissions(), 0);
}
#[test]
fn original_prepare_redelivery_cannot_own_another_waiting_approval() {
    check_original_prepare_redelivery("awaiting");
}
#[test]
fn original_prepare_redelivery_cannot_claim_another_ready_action() {
    check_original_prepare_redelivery("ready");
}
#[test]
fn original_prepare_redelivery_cannot_cancel_another_active_submission() {
    check_original_prepare_redelivery("dispatched");
}
#[test]
fn original_prepare_new_rows_keep_their_own_known_commit_disposition() {
    let mut f = Fixture::new("original-prepare-new-owner");
    f.settle(kernel::Observation::ConfirmedNotApplied).unwrap();
    let mut request = kernel::load(&f.owner.conn, &f.facts.invocation)
        .unwrap()
        .request;
    request.request_key = "fresh-request".into();
    request.input = r#"{"title":"second"}"#.into();
    let scope = f.h.subject().view().clone();
    let service = f.h.service();
    let disposition = action_transaction(&mut f.owner, |conn| {
        let native = native_lineage::load_run(AuthorityDb::Writer(conn), &scope.run_id)
            .map_err(|_| kernel::unavailable())?;
        super::managed_call::prepare_record_rows(conn, &service, &scope, &native, request)
    })
    .unwrap();
    let super::managed_call::PreparedRecordRows::Created {
        inserted, record, ..
    } = disposition
    else {
        panic!("new rows retain only their own disposition")
    };
    assert!(inserted);
    assert_eq!(
        record.details.effect.state,
        InvocationState::AwaitingApproval
    );
    assert_ne!(record.details.effect.invocation_id, f.facts.invocation);
    assert_eq!(f.h.invocations(), 2);
    assert_eq!(f.h.attempts(), 1);
    assert_eq!(f.h.submissions(), 0);
}
