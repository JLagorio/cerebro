//! Actual ACT Harness and V43/V44 rows; no native authority is simulated.
use super::*;
use crate::actions::{
    effect_record, effect_types::*, service::test_support::Harness, types::ActionService,
};
use rusqlite::{params, Transaction, TransactionBehavior};
const HASH: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const KEY: &str = "11111111111111111111111111111111";
const INPUT: &str = r#"{"title":"first"}"#;
struct F {
    h: Harness,
    conn: Connection,
    subject: ActionSubjectView,
}
impl F {
    fn new() -> Self {
        let h = Harness::new("workflow-atomic-act");
        let conn = crate::runtime::open_existing(h.dir()).unwrap();
        let raw:String=conn.query_row("SELECT json_extract(value,'$.scope') FROM fixture_native_authority WHERE run_id='run'",[],|r|r.get(0)).unwrap();
        let subject: ActionSubjectView = serde_json::from_str(&raw).unwrap();
        conn.execute("INSERT OR IGNORE INTO vault_registry(vault_id,vault_path,first_seen_at) VALUES(?1,?2,'2026-10-26T00:00:00.000Z')",params![subject.vault_id,h.dir().join("vault").to_string_lossy()]).unwrap();
        Self { h, conn, subject }
    }
    fn scope(&self) -> Scope<'_> {
        Scope {
            owner: "human:me",
            vault: &self.subject.vault_id,
            store: "fixture-store",
            actor: &self.subject.actor_id,
        }
    }
    fn start(&self) -> flow::Run {
        let tx = Transaction::new_unchecked(&self.conn, TransactionBehavior::Immediate).unwrap();
        let scope = effect_record::scope_key(&self.subject).unwrap();
        let steps = [
            flow::Step {
                id: "action",
                kind: flow::Kind::Action,
                next: Some("done"),
                otherwise: None,
            },
            flow::Step {
                id: "done",
                kind: flow::Kind::Result,
                next: None,
                otherwise: None,
            },
        ];
        let flow::Started::New(run) = flow::start_rows(
            &tx,
            self.scope(),
            flow::Start {
                key: KEY,
                workflow: "atomic",
                version: HASH,
                schema_digest: HASH,
                input: "{}",
                configuration: HASH,
                grants: HASH,
                act_scope: Some(&scope),
                act_run: Some(&self.subject.run_id),
                entry: "action",
                steps: &steps,
                now: 100,
            },
        )
        .unwrap() else {
            panic!("new")
        };
        tx.commit().unwrap();
        run
    }
    fn request(&self, key: &str) -> PrepareAction {
        let value: String = self
            .conn
            .query_row(
                "SELECT value FROM fixture_native_authority WHERE run_id='run'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let value: serde_json::Value = serde_json::from_str(&value).unwrap();
        PrepareAction {
            action_id: ActionId("fixture:issue-create".into()),
            definition_digest: DefinitionDigest(value["definition"].as_str().unwrap().into()),
            connection_id: ConnectionId(value["connectionId"].as_str().unwrap().into()),
            account_id: AccountId(value["binding"]["account_id"].as_str().unwrap().into()),
            snapshot_digest: SnapshotDigest(
                value["binding"]["snapshot_digest"].as_str().unwrap().into(),
            ),
            input: INPUT.into(),
            request_key: key.into(),
        }
    }
    fn counts(&self) -> (i64, i64, i64) {
        self.conn.query_row("SELECT (SELECT count(*) FROM action_invocations),(SELECT count(*) FROM action_output_handoffs),(SELECT count(*) FROM workflow_attempts)",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap()
    }
    fn claim(&self, c: &Connection, run: &flow::Run) -> Claim {
        flow::claim_rows(
            c,
            self.scope(),
            &run.id,
            run.revision,
            INPUT,
            "process",
            101,
        )
        .unwrap()
    }
}
#[test]
fn atomic_workflow_act_requires_transaction() {
    let f = F::new();
    let run = f.start();
    let tx = Transaction::new_unchecked(&f.conn, TransactionBehavior::Immediate).unwrap();
    let claim = f.claim(&tx, &run);
    tx.commit().unwrap();
    assert!(prepare_claim_rows(
        &f.conn,
        f.scope(),
        &claim,
        &f.h.service(),
        &f.subject,
        f.request(&claim.request_key),
        102
    )
    .is_err());
    assert_eq!(f.counts(), (0, 0, 1));
}
#[test]
fn atomic_workflow_act_claim_prepare_register_and_park_commit_together() {
    let f = F::new();
    let run = f.start();
    let tx = Transaction::new_unchecked(&f.conn, TransactionBehavior::Immediate).unwrap();
    let claim = f.claim(&tx, &run);
    let prepared = prepare_claim_rows(
        &tx,
        f.scope(),
        &claim,
        &f.h.service(),
        &f.subject,
        f.request(&claim.request_key),
        102,
    )
    .unwrap();
    assert!(prepared.inserted);
    assert_eq!(prepared.run.state, "waiting");
    assert_eq!(prepared.run.reason.as_deref(), Some("approval_pending"));
    let id = prepared.prepared.effect.invocation_id.clone();
    tx.commit().unwrap();
    assert_eq!(f.counts(), (1, 1, 1));
    let linked: String = f
        .conn
        .query_row(
            "SELECT invocation_id FROM workflow_attempts WHERE run_id=?1",
            [run.id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(linked, id.0);
    assert_eq!(f.h.submissions(), 0);
}
#[test]
fn atomic_workflow_act_rollback_removes_claim_invocation_and_consumer() {
    let f = F::new();
    let run = f.start();
    let tx = Transaction::new_unchecked(&f.conn, TransactionBehavior::Immediate).unwrap();
    let claim = f.claim(&tx, &run);
    prepare_claim_rows(
        &tx,
        f.scope(),
        &claim,
        &f.h.service(),
        &f.subject,
        f.request(&claim.request_key),
        102,
    )
    .unwrap();
    tx.rollback().unwrap();
    assert_eq!(f.counts(), (0, 0, 0));
    let state: String = f
        .conn
        .query_row(
            "SELECT state FROM workflow_runs WHERE run_id=?1",
            [run.id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(state, "queued");
}
#[test]
fn atomic_workflow_act_prepared_response_loss_returns_original_invocation() {
    let f = F::new();
    let run = f.start();
    let tx = Transaction::new_unchecked(&f.conn, TransactionBehavior::Immediate).unwrap();
    let claim = f.claim(&tx, &run);
    let value = prepare_claim_rows(
        &tx,
        f.scope(),
        &claim,
        &f.h.service(),
        &f.subject,
        f.request(&claim.request_key),
        102,
    )
    .unwrap();
    let id = value.prepared.effect.invocation_id;
    tx.commit().unwrap();
    let replay = f.h.prepare(&claim.request_key, "first").unwrap();
    assert_eq!(replay.effect.invocation_id, id);
    assert_eq!(f.counts(), (1, 1, 1));
    assert_eq!(f.h.submissions(), 0);
}
#[test]
fn atomic_workflow_act_preserves_person_approval_and_uses_actual_output_receipt() {
    let f = F::new();
    let run = f.start();
    let tx = Transaction::new_unchecked(&f.conn, TransactionBehavior::Immediate).unwrap();
    let claim = f.claim(&tx, &run);
    let value = prepare_claim_rows(
        &tx,
        f.scope(),
        &claim,
        &f.h.service(),
        &f.subject,
        f.request(&claim.request_key),
        102,
    )
    .unwrap();
    let id = value.prepared.effect.invocation_id;
    let revision = value.run.revision;
    tx.commit().unwrap();
    assert_eq!(f.h.submissions(), 0);
    f.h.allow(&id).unwrap();
    assert_eq!(
        f.h.service().dispatch(id.clone()).unwrap().state,
        InvocationState::Succeeded
    );
    let tx = Transaction::new_unchecked(&f.conn, TransactionBehavior::Immediate).unwrap();
    let done = crate::actions::output_handoff::consume_rows(
        &tx,
        f.scope(),
        &run.id,
        revision,
        &f.h.service(),
        &f.subject,
        &id,
        103,
    )
    .unwrap();
    assert_eq!(done.state, "queued");
    assert_eq!(done.cursor.as_deref(), Some("done"));
    tx.commit().unwrap();
    assert_eq!(f.h.submissions(), 1);
    let state: String = f
        .conn
        .query_row(
            "SELECT state FROM action_output_handoffs WHERE invocation_id=?1",
            [id.0],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(state, "acknowledged");
}
#[test]
fn atomic_workflow_act_cancellation_after_success_discards_receipt_atomically() {
    let f = F::new();
    let run = f.start();
    let tx = Transaction::new_unchecked(&f.conn, TransactionBehavior::Immediate).unwrap();
    let claim = f.claim(&tx, &run);
    let value = prepare_claim_rows(
        &tx,
        f.scope(),
        &claim,
        &f.h.service(),
        &f.subject,
        f.request(&claim.request_key),
        102,
    )
    .unwrap();
    let id = value.prepared.effect.invocation_id;
    let revision = value.run.revision;
    tx.commit().unwrap();
    f.h.allow(&id).unwrap();
    f.h.service().dispatch(id.clone()).unwrap();
    let tx = Transaction::new_unchecked(&f.conn, TransactionBehavior::Immediate).unwrap();
    let cancelled = flow::cancel_rows(&tx, f.scope(), &run.id, revision, 103).unwrap();
    let settled = crate::actions::output_handoff::consume_rows(
        &tx,
        f.scope(),
        &run.id,
        cancelled.revision,
        &f.h.service(),
        &f.subject,
        &id,
        104,
    )
    .unwrap();
    assert_eq!(settled.state, "cancelled");
    tx.commit().unwrap();
    let (reserved,body,state,ack):(i64,Option<String>,String,String)=f.conn.query_row("SELECT r.reserved_bytes,h.output_json,h.state,h.ack_kind FROM workflow_runs r JOIN action_output_handoffs h ON h.workflow_run_id=r.run_id WHERE r.run_id=?1 AND h.invocation_id=?2",params![run.id,id.0],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).unwrap();
    assert_eq!(reserved, 0);
    assert!(body.is_none());
    assert_eq!(state, "acknowledged");
    assert_eq!(ack, "discarded");
}
#[test]
fn atomic_workflow_act_rejects_request_identity_before_prepare() {
    let f = F::new();
    let run = f.start();
    for change in ["key", "input", "subject"] {
        let tx = Transaction::new_unchecked(&f.conn, TransactionBehavior::Immediate).unwrap();
        let claim = f.claim(&tx, &run);
        let mut request = f.request(&claim.request_key);
        let mut subject = f.subject.clone();
        match change {
            "key" => request.request_key = "different".into(),
            "input" => request.input = r#"{"title":"second"}"#.into(),
            _ => subject.run_id = "other-run".into(),
        };
        assert!(prepare_claim_rows(
            &tx,
            f.scope(),
            &claim,
            &f.h.service(),
            &subject,
            request,
            102
        )
        .is_err());
        let count: i64 = tx
            .query_row("SELECT count(*) FROM action_invocations", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0, "reject before preparing a different request");
        tx.rollback().unwrap();
    }
    assert_eq!(f.counts(), (0, 0, 0));
}
