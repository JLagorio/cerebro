//! Real ACT service/fake provider and real V43 tables, never native authority.
use super::*;
use crate::actions::{effect_record::scope_key, read_types::{ActionErrorCode, ActionSubjectView}, service::test_support::Harness, types::{ActionService, InvocationState}};
use crate::runtime::workflows as flow;
use rusqlite::{params, Transaction, TransactionBehavior};
const HASH:&str="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const KEY:&str="11111111111111111111111111111111";
const INPUT:&str=r#"{"title":"first"}"#;
fn tx<T>(conn:&Connection,operation:impl FnOnce(&Connection)->Result<T,flow::Error>)->Result<T,flow::Error>{
    let tx=Transaction::new_unchecked(conn,TransactionBehavior::Immediate).unwrap();let result=operation(&tx)?;tx.commit().unwrap();Ok(result)
}
struct Fixture { h:Harness, conn:Connection, subject_view:ActionSubjectView }
impl Fixture {
    fn new(label:&str)->Self{
        let h=Harness::new(label);let conn=crate::runtime::open_existing(h.dir()).unwrap();
        let raw:String=conn.query_row("SELECT json_extract(value,'$.scope') FROM fixture_native_authority WHERE run_id='run'",[],|row|row.get(0)).unwrap();
        let subject_view:ActionSubjectView=serde_json::from_str(&raw).unwrap();
        conn.execute("INSERT OR IGNORE INTO vault_registry(vault_id,vault_path,first_seen_at) VALUES(?1,?2,'2026-10-26T00:00:00.000Z')",params![subject_view.vault_id,h.dir().join("fixture-vault").to_string_lossy()]).unwrap();
        Self{h,conn,subject_view}
    }
    fn scope(&self)->flow::Scope<'_>{flow::Scope{owner:"human:me",vault:&self.subject_view.vault_id,store:"fixture-store",actor:&self.subject_view.actor_id}}
    fn start(&self,key:&str,act_run:&str)->(flow::Run,flow::Claim){
        // Use the actual fixture's authority record to freeze scope metadata;
        // this read creates no ActionSubject. Only Harness owns that capability.
        let raw:String=self.conn.query_row("SELECT json_extract(value,'$.scope') FROM fixture_native_authority WHERE run_id=?1",[act_run],|row|row.get(0)).unwrap();
        let subject:ActionSubjectView=serde_json::from_str(&raw).unwrap();let scoped=scope_key(&subject).unwrap();
        let steps=[flow::Step{id:"action",kind:flow::Kind::Action,next:Some("result"),otherwise:None},flow::Step{id:"result",kind:flow::Kind::Result,next:None,otherwise:None}];
        let request=flow::Start{key,workflow:"act-flow",version:HASH,schema_digest:HASH,input:"{}",configuration:HASH,grants:HASH,act_scope:Some(&scoped),act_run:Some(&subject.run_id),entry:"action",steps:&steps,now:100};
        let flow::Started::New(run)=tx(&self.conn,|conn|flow::start_rows(conn,self.scope(),request)).unwrap() else {panic!("fresh workflow")};
        let claim=tx(&self.conn,|conn|flow::claim_rows(conn,self.scope(),&run.id,run.revision,INPUT,"process",101)).unwrap();(run,claim)
    }
    fn run(&self,id:&str)->flow::Run{tx(&self.conn,|conn|flow::inspect_rows(conn,self.scope(),id)).unwrap()}
    fn observe(&self,run:&str,revision:u64,id:&InvocationId)->Result<flow::Run,flow::Error>{
        tx(&self.conn,|conn|observe_rows(conn,self.scope(),run,revision,&self.h.service(),self.h.subject(),id,200))
    }
    fn linked(&self,run:&str)->Option<String>{self.conn.query_row("SELECT invocation_id FROM workflow_attempts WHERE run_id=?1",[run],|row|row.get(0)).unwrap()}
}
#[test]
fn workflow_real_act_lost_prepare_response_recovers_original_invocation_and_approval(){
    let f=Fixture::new("flow-act-lost-prepare");let (run,claim)=f.start(KEY,"run");
    let prepared=f.h.prepare(&claim.request_key,"first").unwrap();assert!(f.linked(&run.id).is_none());
    tx(&f.conn,|conn|flow::recover_rows(conn,f.scope(),"new-process",32,150)).unwrap();
    let original_key:String=f.conn.query_row("SELECT request_key FROM workflow_attempts WHERE run_id=?1",[&run.id],|row|row.get(0)).unwrap();
    let replay=f.h.prepare(&original_key,"first").unwrap();assert_eq!(prepared.effect.invocation_id,replay.effect.invocation_id);assert_eq!(prepared.approval_id,replay.approval_id);
    let parked=f.observe(&run.id,f.run(&run.id).revision,&replay.effect.invocation_id).unwrap();
    assert_eq!(parked.state,"waiting");assert_eq!(parked.reason.as_deref(),Some("approval_pending"));
    assert_eq!(f.linked(&run.id).as_deref(),Some(replay.effect.invocation_id.0.as_str()));assert_eq!(f.h.invocations(),1);assert_eq!(f.h.submissions(),0);
}
#[test]
fn workflow_real_act_same_key_changed_payload_conflicts_without_new_approval(){
    let f=Fixture::new("flow-act-conflict");let (run,claim)=f.start(KEY,"run");let prepared=f.h.prepare(&claim.request_key,"first").unwrap();
    assert_eq!(f.h.prepare(&claim.request_key,"second").unwrap_err().code,ActionErrorCode::RequestKeyConflict);
    let parked=f.observe(&run.id,claim.run_revision,&prepared.effect.invocation_id).unwrap();assert_eq!(parked.state,"waiting");assert_eq!(f.h.invocations(),1);assert_eq!(f.h.submissions(),0);
}
#[test]
fn workflow_real_act_fresh_workflow_cannot_bypass_unknown_target_fence(){
    let f=Fixture::new("flow-act-fence");let (run,claim)=f.start(KEY,"run");let prepared=f.h.prepare(&claim.request_key,"first").unwrap();
    f.h.allow(&prepared.effect.invocation_id).unwrap();f.h.set_observation("unknown");
    assert_eq!(f.h.service().dispatch(prepared.effect.invocation_id.clone()).unwrap().state,InvocationState::OutcomeUnknown);
    let blocked=f.observe(&run.id,claim.run_revision,&prepared.effect.invocation_id).unwrap();assert_eq!(blocked.reason.as_deref(),Some("effect_outcome_unknown"));
    let (_,fresh)=f.start("22222222222222222222222222222222","other-run");
    assert!(f.h.prepare_other_run(&fresh.request_key,"first").is_err());assert_eq!(f.h.submissions(),1);assert_eq!(f.h.invocations(),1);
}
#[test]
fn workflow_real_act_completed_output_absence_blocks_without_synthesized_null(){
    let f=Fixture::new("flow-act-output-absent");let (run,claim)=f.start(KEY,"run");let prepared=f.h.prepare(&claim.request_key,"first").unwrap();
    f.h.allow(&prepared.effect.invocation_id).unwrap();assert_eq!(f.h.service().dispatch(prepared.effect.invocation_id.clone()).unwrap().state,InvocationState::Succeeded);
    let blocked=f.observe(&run.id,claim.run_revision,&prepared.effect.invocation_id).unwrap();
    assert_eq!(blocked.state,"blocked");assert_eq!(blocked.reason.as_deref(),Some("action_output_unavailable"));assert_eq!(blocked.cursor.as_deref(),Some("action"));
    assert_eq!(f.h.details(&prepared.effect.invocation_id).effect.state,InvocationState::Succeeded,"FLOW cannot relabel ACT success as unknown");
    let (reserved,outputs):(i64,i64)=f.conn.query_row("SELECT reserved_bytes,(SELECT count(*) FROM workflow_values WHERE run_id=?1 AND role='step_output') FROM workflow_runs WHERE run_id=?1",[&run.id],|row|Ok((row.get(0)?,row.get(1)?))).unwrap();
    assert_eq!(reserved,262144);assert_eq!(outputs,0);assert_eq!(f.h.submissions(),1);
}
#[test]
fn workflow_real_act_natural_expiry_then_explicit_renewal_preserves_attempt(){
    let f=Fixture::new("flow-act-renew");let (run,claim)=f.start(KEY,"run");let prepared=f.h.prepare(&claim.request_key,"first").unwrap();
    let waiting=f.observe(&run.id,claim.run_revision,&prepared.effect.invocation_id).unwrap();let original_revision=f.h.details(&prepared.effect.invocation_id).revision.get();
    f.h.expire_id(&prepared.effect.invocation_id);assert_eq!(f.h.details(&prepared.effect.invocation_id).revision.get(),original_revision,"expiry is a SELECT-only time projection");
    let expired=f.observe(&run.id,waiting.revision,&prepared.effect.invocation_id).unwrap();assert_eq!(expired.reason.as_deref(),Some("approval_expired"));
    let same=f.observe(&run.id,expired.revision,&prepared.effect.invocation_id).unwrap();assert_eq!(same.revision,expired.revision,"repeating the same derived expiry is observational");
    let old_wait:i64=f.conn.query_row("SELECT revision FROM workflow_waits WHERE run_id=?1",[&run.id],|row|row.get(0)).unwrap();
    let renewed=f.h.service().refresh_approval(f.h.subject(),prepared.effect.invocation_id.clone(),original_revision).unwrap();assert_ne!(renewed.approval_id,prepared.approval_id);
    let current=f.observe(&run.id,expired.revision,&renewed.invocation_id).unwrap();assert_eq!(current.reason.as_deref(),Some("approval_pending"));
    let (state,revision,approval):(String,i64,String)=f.conn.query_row("SELECT state,revision,approval_id FROM workflow_waits WHERE run_id=?1",[&run.id],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?))).unwrap();
    assert_eq!(state,"pending");assert!(revision>old_wait);assert_eq!(Some(approval),renewed.approval_id.map(|id|id.0));assert_eq!(f.h.invocations(),1);assert_eq!(f.h.attempts(),0);assert_eq!(f.h.submissions(),0);
}
#[test]
fn workflow_real_act_human_edit_keeps_original_request_and_effective_input_distinct(){
    let f=Fixture::new("flow-act-edited-input");let (run,claim)=f.start(KEY,"run");let prepared=f.h.prepare(&claim.request_key,"first").unwrap();
    let waiting=f.observe(&run.id,claim.run_revision,&prepared.effect.invocation_id).unwrap();let original_lookup=f.h.lookup_columns(&prepared.effect.invocation_id);
    let edited=f.h.service().answer(f.h.decision(&prepared.effect.invocation_id,true,Some("edited"))).unwrap();assert_ne!(edited.approval_id,prepared.approval_id);
    assert_ne!(f.h.details(&prepared.effect.invocation_id).input_digest,claim.input_digest);assert_eq!(f.h.lookup_columns(&prepared.effect.invocation_id),original_lookup);
    let current=f.observe(&run.id,waiting.revision,&edited.invocation_id).unwrap();assert_eq!(current.state,"waiting");
    let approval:String=f.conn.query_row("SELECT approval_id FROM workflow_waits WHERE run_id=?1",[&run.id],|row|row.get(0)).unwrap();assert_eq!(Some(approval),edited.approval_id.map(|id|id.0));
    assert_eq!(f.h.prepare(&claim.request_key,"first").unwrap().effect.invocation_id,prepared.effect.invocation_id);assert_eq!(f.h.invocations(),1);assert_eq!(f.h.submissions(),0);
}
#[test]
fn workflow_real_act_wrong_subject_cannot_link_an_invocation(){
    let f=Fixture::new("flow-act-wrong-subject");let (run,claim)=f.start(KEY,"run");let prepared=f.h.prepare(&claim.request_key,"first").unwrap();
    assert_eq!(tx(&f.conn,|conn|observe_rows(conn,f.scope(),&run.id,claim.run_revision,&f.h.service(),f.h.other_subject(),&prepared.effect.invocation_id,200)),Err(flow::Error::Denied));
    assert!(f.linked(&run.id).is_none());assert_eq!(f.run(&run.id).state,"running");assert_eq!(f.h.submissions(),0);
}
#[test]
fn workflow_real_act_changed_original_input_cannot_link_under_frozen_key(){
    let f=Fixture::new("flow-act-wrong-input");let (run,claim)=f.start(KEY,"run");let prepared=f.h.prepare(&claim.request_key,"second").unwrap();
    assert_eq!(f.observe(&run.id,claim.run_revision,&prepared.effect.invocation_id),Err(flow::Error::Denied));assert!(f.linked(&run.id).is_none());assert_eq!(f.h.submissions(),0);
}
#[test]
fn workflow_real_act_cancel_unknown_remains_blocked_and_keeps_recovery_values(){
    let f=Fixture::new("flow-act-cancel-unknown");let (run,claim)=f.start(KEY,"run");let prepared=f.h.prepare(&claim.request_key,"first").unwrap();
    f.h.allow(&prepared.effect.invocation_id).unwrap();f.h.set_observation("unknown");f.h.service().dispatch(prepared.effect.invocation_id.clone()).unwrap();
    let blocked=f.observe(&run.id,claim.run_revision,&prepared.effect.invocation_id).unwrap();
    let cancelling=tx(&f.conn,|conn|flow::cancel_rows(conn,f.scope(),&run.id,blocked.revision,201)).unwrap();f.h.cancel(&prepared.effect.invocation_id).unwrap();
    let current=f.observe(&run.id,cancelling.revision,&prepared.effect.invocation_id).unwrap();assert_eq!(current.state,"blocked");assert!(current.cancel_requested);assert_eq!(current.reason.as_deref(),Some("effect_outcome_unknown"));
    assert!(f.conn.query_row("SELECT count(*) FROM workflow_values WHERE run_id=?1",[&run.id],|row|row.get::<_,i64>(0)).unwrap()>0);assert_eq!(f.h.submissions(),1);
}
#[test]
fn workflow_real_act_observation_requires_the_flow_transaction(){
    let f=Fixture::new("flow-act-no-tx");let (run,claim)=f.start(KEY,"run");let prepared=f.h.prepare(&claim.request_key,"first").unwrap();
    assert_eq!(observe_rows(&f.conn,f.scope(),&run.id,claim.run_revision,&f.h.service(),f.h.subject(),&prepared.effect.invocation_id,200),Err(flow::Error::Unavailable));assert!(f.linked(&run.id).is_none());assert_eq!(f.h.submissions(),0);
}

#[test]
fn workflow_real_act_person_denial_is_failed_approval_denied_not_cancelled() {
    let f=Fixture::new("flow-act-person-denied");let (run,claim)=f.start(KEY,"run");
    let prepared=f.h.prepare(&claim.request_key,"first").unwrap();
    let waiting=f.observe(&run.id,claim.run_revision,&prepared.effect.invocation_id).unwrap();
    let denied=f.h.service().answer(f.h.decision(&prepared.effect.invocation_id,false,None)).unwrap();
    assert_eq!(denied.state,InvocationState::Cancelled,"ACT stores person denial as retired cancelled approval");
    assert!(denied.approval_id.is_none());
    let failed=f.observe(&run.id,waiting.revision,&denied.invocation_id).unwrap();
    assert_eq!(failed.state,"failed");assert_eq!(failed.reason.as_deref(),Some("approval_denied"));
    assert!(failed.cursor.is_none());assert_eq!(f.h.submissions(),0);assert_eq!(f.h.attempts(),0);
}
#[test]
fn workflow_real_act_expired_dispatch_claim_blocks_after_retiring_approval() {
    let f=Fixture::new("flow-act-expired-claim");let (run,claim)=f.start(KEY,"run");
    let prepared=f.h.prepare(&claim.request_key,"first").unwrap();f.h.allow(&prepared.effect.invocation_id).unwrap();
    let ready=f.observe(&run.id,claim.run_revision,&prepared.effect.invocation_id).unwrap();
    assert_eq!(ready.reason.as_deref(),Some("action_ready"));
    f.h.expire_id(&prepared.effect.invocation_id);
    assert!(f.h.service().dispatch(prepared.effect.invocation_id.clone()).is_err());
    let retired=f.h.details(&prepared.effect.invocation_id);
    assert_eq!(retired.effect.state,InvocationState::AwaitingApproval);
    assert!(retired.effect.approval_id.is_none());assert!(retired.approval.is_none());
    let blocked=f.observe(&run.id,ready.revision,&prepared.effect.invocation_id).unwrap();
    assert_eq!(blocked.state,"blocked");assert_eq!(blocked.reason.as_deref(),Some("approval_expired"));
    assert_eq!(blocked.cursor.as_deref(),Some("action"));assert_eq!(f.h.submissions(),0);assert_eq!(f.h.attempts(),0);
    let (reserved,pending):(i64,i64)=f.conn.query_row("SELECT reserved_bytes,(SELECT count(*) FROM workflow_waits WHERE run_id=?1 AND state='pending') FROM workflow_runs WHERE run_id=?1",[&run.id],|row|Ok((row.get(0)?,row.get(1)?))).unwrap();
    assert_eq!(reserved,262144);assert_eq!(pending,0);
    assert!(f.conn.query_row("SELECT count(*) FROM workflow_values WHERE run_id=?1",[&run.id],|row|row.get::<_,i64>(0)).unwrap()>0);
}

fn receipt_register(f: &Fixture, claim: &flow::Claim, id: &InvocationId) -> Result<(), flow::Error> {
    tx(&f.conn, |conn| super::super::output_handoff::register_rows(conn, f.scope(), claim, &f.h.service(), &f.subject_view, id))
}
fn receipt_consume(f: &Fixture, run: &str, revision: u64, id: &InvocationId) -> Result<flow::Run, flow::Error> {
    tx(&f.conn, |conn| super::super::output_handoff::consume_rows(conn, f.scope(), run, revision, &f.h.service(), &f.subject_view, id, 300))
}
fn receipt_snapshot(f: &Fixture, run: &str) -> String {
    f.conn.query_row("SELECT json_array(r.state,r.revision,r.reserved_bytes,r.output_bytes,(SELECT json_group_array(json_array(role,canonical_json,digest,byte_count)) FROM workflow_values WHERE run_id=r.run_id),(SELECT json_group_array(json_array(state,output_json,output_digest,byte_count,ack_kind)) FROM action_output_handoffs WHERE workflow_run_id=r.run_id)) FROM workflow_runs r WHERE r.run_id=?1", [run], |row| row.get(0)).unwrap()
}
fn receipt_prepared(f: &Fixture, key: &str) -> (flow::Run, flow::Claim, InvocationId) {
    let (run, claim) = f.start(key, "run");
    let prepared = f.h.prepare(&claim.request_key, "first").unwrap();
    receipt_register(f, &claim, &prepared.effect.invocation_id).expect("explicit consumer registered before effect");
    (run, claim, prepared.effect.invocation_id)
}
fn receipt_succeed(f: &Fixture, id: &InvocationId) {
    f.h.allow(id).unwrap();
    assert_eq!(f.h.service().dispatch(id.clone()).unwrap().state, InvocationState::Succeeded);
}
#[test]
fn workflow_output_receipt_v44_schema_is_present_in_actual_runtime_database() {
    let f = Fixture::new("receipt-schema");
    let version: i64 = f.conn.pragma_query_value(None, "user_version", |row| row.get(0)).unwrap();
    assert!(version >= 44, "V44 output handoff schema is required");
    assert_eq!(f.conn.query_row("SELECT count(*) FROM action_output_handoffs", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
}
#[test]
fn workflow_output_receipt_registration_requires_the_outer_transaction() {
    let f = Fixture::new("receipt-register-no-tx");
    let (_, claim) = f.start(KEY, "run");
    let prepared = f.h.prepare(&claim.request_key, "first").unwrap();
    let result = super::super::output_handoff::register_rows(&f.conn, f.scope(), &claim, &f.h.service(), &f.subject_view, &prepared.effect.invocation_id);
    assert_eq!(result, Err(flow::Error::Unavailable));
    assert_eq!(f.h.submissions(), 0);
}
#[test]
fn workflow_output_receipt_original_consumer_is_immutable_and_registration_replay_is_observational() {
    let f = Fixture::new("receipt-consumer");
    let (run, claim, id) = receipt_prepared(&f, KEY);
    let before = receipt_snapshot(&f, &run.id);
    receipt_register(&f, &claim, &id).unwrap();
    assert_eq!(receipt_snapshot(&f, &run.id), before);
    let (_, other) = f.start("22222222222222222222222222222222", "run");
    assert_eq!(receipt_register(&f, &other, &id), Err(flow::Error::Denied));
    assert_eq!(f.conn.query_row("SELECT count(*) FROM action_output_handoffs", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
    assert_eq!(f.h.submissions(), 0);
}
#[test]
fn workflow_output_receipt_actual_success_retains_recorded_null_and_exact_attempt_receipt_revision() {
    let f = Fixture::new("receipt-success-null");
    let (run, _, id) = receipt_prepared(&f, KEY);
    receipt_succeed(&f, &id);
    let actual = f.h.details(&id);
    let attempt = actual.attempts.last().unwrap();
    let row: (String, String, String, i64, String, String, i64) = f.conn.query_row("SELECT state,output_json,output_digest,byte_count,attempt_id,receipt_id,observation_revision FROM action_output_handoffs WHERE invocation_id=?1", [&id.0], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,row.get(6)?))).unwrap();
    assert_eq!(row.0, "retained"); assert_eq!(row.1, "null");
    assert_eq!(row.2, crate::actions::schema::digest(b"null")); assert_eq!(row.3, 4);
    assert_eq!(row.4, attempt.attempt_id.0); assert_eq!(Some(row.5), attempt.receipt_id.clone());
    assert_eq!(row.6 as u64, actual.revision.get());
    assert_eq!(f.conn.query_row("SELECT reserved_bytes FROM workflow_runs WHERE run_id=?1", [&run.id], |row| row.get::<_, i64>(0)).unwrap(), 262144);
    assert_eq!(f.h.submissions(), 1);
}
#[test]
fn workflow_output_receipt_transfer_rollback_preserves_body_reservation_cursor_and_no_output_value() {
    let f = Fixture::new("receipt-transfer-rollback");
    let (run, claim, id) = receipt_prepared(&f, KEY); receipt_succeed(&f, &id);
    let before = receipt_snapshot(&f, &run.id);
    let outer = Transaction::new_unchecked(&f.conn, TransactionBehavior::Immediate).unwrap();
    let advanced = super::super::output_handoff::consume_rows(&outer, f.scope(), &run.id, claim.run_revision, &f.h.service(), &f.subject_view, &id, 300).unwrap();
    assert_eq!(advanced.cursor.as_deref(), Some("result"));
    let inside: (String, Option<String>, i64) = outer.query_row("SELECT h.state,h.output_json,r.reserved_bytes FROM action_output_handoffs h JOIN workflow_runs r ON r.run_id=h.workflow_run_id WHERE h.invocation_id=?1", [&id.0], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?))).unwrap();
    assert_eq!(inside, ("acknowledged".into(), None, 0));
    assert_eq!(outer.query_row("SELECT canonical_json FROM workflow_values WHERE run_id=?1 AND role='step_output'", [&run.id], |row| row.get::<_, String>(0)).unwrap(), "null");
    outer.rollback().unwrap(); assert_eq!(receipt_snapshot(&f, &run.id), before); assert_eq!(f.h.submissions(), 1);
}
#[test]
fn workflow_output_receipt_transfer_commits_once_and_replay_never_duplicates_output_or_dispatch() {
    let f = Fixture::new("receipt-transfer-replay");
    let (run, claim, id) = receipt_prepared(&f, KEY); receipt_succeed(&f, &id);
    let advanced = receipt_consume(&f, &run.id, claim.run_revision, &id).unwrap();
    assert_eq!(advanced.cursor.as_deref(), Some("result"));
    let before = receipt_snapshot(&f, &run.id);
    let replay = receipt_consume(&f, &run.id, advanced.revision, &id).unwrap(); assert_eq!(replay, advanced);
    assert_eq!(receipt_snapshot(&f, &run.id), before);
    let row: (String, Option<String>, String, i64) = f.conn.query_row("SELECT state,output_json,ack_kind,byte_count FROM action_output_handoffs WHERE invocation_id=?1", [&id.0], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?))).unwrap();
    assert_eq!(row, ("acknowledged".into(), None, "transferred".into(), 4));
    assert_eq!(f.conn.query_row("SELECT count(*) FROM workflow_values WHERE run_id=?1 AND role='step_output'", [&run.id], |row| row.get::<_, i64>(0)).unwrap(), 1);
    assert_eq!(f.h.submissions(), 1);
}
#[test]
fn workflow_output_receipt_cancel_after_success_discards_body_and_releases_reservation_atomically() {
    let f = Fixture::new("receipt-cancel-after-success");
    let (run, claim, id) = receipt_prepared(&f, KEY); receipt_succeed(&f, &id);
    let cancelling = tx(&f.conn, |conn| flow::cancel_rows(conn, f.scope(), &run.id, claim.run_revision, 250)).unwrap();
    assert_eq!(cancelling.state, "blocked"); let before = receipt_snapshot(&f, &run.id);
    let outer = Transaction::new_unchecked(&f.conn, TransactionBehavior::Immediate).unwrap();
    let cancelled = super::super::output_handoff::consume_rows(&outer, f.scope(), &run.id, cancelling.revision, &f.h.service(), &f.subject_view, &id, 300).unwrap();
    assert_eq!(cancelled.state, "cancelled"); assert_eq!(cancelled.reason.as_deref(), Some("cancelled_after_effect"));
    let inside: (String, Option<String>, String, i64) = outer.query_row("SELECT h.state,h.output_json,h.ack_kind,r.reserved_bytes FROM action_output_handoffs h JOIN workflow_runs r ON r.run_id=h.workflow_run_id WHERE h.invocation_id=?1", [&id.0], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?))).unwrap();
    assert_eq!(inside, ("acknowledged".into(), None, "discarded".into(), 0));
    assert_eq!(outer.query_row("SELECT count(*) FROM workflow_values WHERE run_id=?1", [&run.id], |row| row.get::<_, i64>(0)).unwrap(), 0);
    outer.rollback().unwrap(); assert_eq!(receipt_snapshot(&f, &run.id), before);
    let cancelled = receipt_consume(&f, &run.id, cancelling.revision, &id).unwrap(); assert_eq!(cancelled.state, "cancelled");
    assert_eq!(f.conn.query_row("SELECT count(*) FROM action_output_handoffs WHERE output_json IS NOT NULL AND workflow_run_id=?1", [&run.id], |row| row.get::<_, i64>(0)).unwrap(), 0);
    assert_eq!(f.conn.query_row("SELECT reserved_bytes FROM workflow_runs WHERE run_id=?1", [&run.id], |row| row.get::<_, i64>(0)).unwrap(), 0);
    assert_eq!(f.h.submissions(), 1);
}
#[test]
fn workflow_output_receipt_preserves_original_request_digest_separate_from_edited_approved_input() {
    let f = Fixture::new("receipt-original-edited-input");
    let (_, claim, id) = receipt_prepared(&f, KEY); let original = f.h.lookup_columns(&id);
    f.h.service().answer(f.h.decision(&id, true, Some("edited"))).unwrap();
    f.h.allow(&id).unwrap(); f.h.service().dispatch(id.clone()).unwrap();
    let row: (String, String, String, String) = f.conn.query_row("SELECT request_key,original_request_digest,original_input_digest,effective_input_digest FROM action_output_handoffs WHERE invocation_id=?1", [&id.0], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?))).unwrap();
    assert_eq!(row.0, claim.request_key); assert_eq!(row.1, original.1); assert_eq!(row.2, claim.input_digest);
    assert_eq!(row.3, f.h.details(&id).input_digest); assert_ne!(row.2, row.3); assert_eq!(f.h.lookup_columns(&id), original);
}
#[test]
fn workflow_output_receipt_unknown_has_no_retained_payload_and_cannot_release_backing_reservation() {
    let f = Fixture::new("receipt-unknown");
    let (run, _, id) = receipt_prepared(&f, KEY); f.h.allow(&id).unwrap(); f.h.set_observation("unknown");
    assert_eq!(f.h.service().dispatch(id.clone()).unwrap().state, InvocationState::OutcomeUnknown);
    let row: (Option<String>, Option<String>, i64) = f.conn.query_row("SELECT h.output_json,h.receipt_id,r.reserved_bytes FROM action_output_handoffs h JOIN workflow_runs r ON r.run_id=h.workflow_run_id WHERE h.invocation_id=?1", [&id.0], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?))).unwrap();
    assert_eq!(row, (None, None, 262144));
    assert_eq!(f.conn.query_row("SELECT count(*) FROM workflow_values WHERE run_id=?1 AND role='step_output'", [&run.id], |row| row.get::<_, i64>(0)).unwrap(), 0); assert_eq!(f.h.submissions(), 1);
}
#[test]
fn workflow_output_receipt_wrong_subject_cannot_consume_and_preserves_all_rows() {
    let f = Fixture::new("receipt-wrong-subject");
    let (run, claim, id) = receipt_prepared(&f, KEY); receipt_succeed(&f, &id); let before = receipt_snapshot(&f, &run.id);
    for field in ["vault", "run", "actor", "child", "client"] {
        let mut wrong = f.subject_view.clone();
        match field {
            "vault" => wrong.vault_id = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".into(),
            "run" => wrong.run_id = "wrong-run".into(),
            "actor" => wrong.actor_id = "human:other".into(),
            "child" => wrong.child_job_id = Some("forged-child".into()),
            "client" => wrong.client_id = Some("forged-client".into()),
            _ => unreachable!(),
        }
        let result = tx(&f.conn, |conn| super::super::output_handoff::consume_rows(conn, f.scope(), &run.id, claim.run_revision, &f.h.service(), &wrong, &id, 300));
        assert_eq!(result, Err(flow::Error::Denied), "{field}"); assert_eq!(receipt_snapshot(&f, &run.id), before);
    }
    assert_eq!(f.h.submissions(), 1);
}
#[test]
fn workflow_output_receipt_can_refine_only_real_missing_output_at_same_actual_act_revision() {
    let f = Fixture::new("receipt-same-revision-refinement");
    let (run, claim, id) = receipt_prepared(&f, KEY); receipt_succeed(&f, &id); let actual = f.h.details(&id);
    let missing = tx(&f.conn, |conn| flow::effect_rows(conn, f.scope(), &run.id, claim.run_revision, flow::Effect{step:&claim.step,ordinal:claim.ordinal,request_key:&claim.request_key,invocation:&id.0,approval:actual.effect.approval_id.as_ref().map(|id|id.0.as_str()),revision:actual.revision.get(),state:flow::EffectState::OutputUnavailable,output:None},250)).unwrap();
    assert_eq!(missing.reason.as_deref(), Some("action_output_unavailable"));
    let refined = receipt_consume(&f, &run.id, missing.revision, &id).unwrap(); assert_eq!(refined.cursor.as_deref(), Some("result"));
    assert_eq!(f.conn.query_row("SELECT effect_revision FROM workflow_steps WHERE run_id=?1 AND step_id='action'", [&run.id], |row| row.get::<_, i64>(0)).unwrap() as u64, actual.revision.get()); assert_eq!(f.h.submissions(), 1);
}

#[test]
fn workflow_output_receipt_unregistered_chat_success_retains_no_output_payload() {
    let f = Fixture::new("receipt-unregistered-chat");
    let prepared = f.h.prepare("ordinary-chat-request", "first").unwrap(); receipt_succeed(&f, &prepared.effect.invocation_id);
    assert_eq!(f.conn.query_row("SELECT count(*) FROM action_output_handoffs", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
    assert!(f.h.details(&prepared.effect.invocation_id).attempts.last().unwrap().receipt_id.is_some());
}
#[test]
fn workflow_output_receipt_missing_or_reduced_reservation_refuses_claim_before_provider_effect() {
    for allocation in [0_i64, 3_i64] {
        let f = Fixture::new(&format!("receipt-lost-reservation-{allocation}"));
        let (run, _, id) = receipt_prepared(&f, KEY); f.h.allow(&id).unwrap();
        f.conn.execute("UPDATE workflow_runs SET reserved_bytes=?2 WHERE run_id=?1", params![run.id, allocation]).unwrap();
        assert!(f.h.service().dispatch(id.clone()).is_err(), "registered output cannot outlive its pre-effect allocation");
        assert_eq!(f.h.attempts(), 0); assert_eq!(f.h.submissions(), 0);
        let row: (Option<String>, Option<String>) = f.conn.query_row("SELECT output_json,receipt_id FROM action_output_handoffs WHERE invocation_id=?1", [&id.0], |row| Ok((row.get(0)?,row.get(1)?))).unwrap();
        assert_eq!(row, (None, None));
    }
}
#[test]
fn workflow_output_receipt_corrupt_digest_refuses_transfer_without_ack_or_budget_release() {
    let f = Fixture::new("receipt-corrupt-digest");
    let (run, claim, id) = receipt_prepared(&f, KEY); receipt_succeed(&f, &id);
    f.conn.execute("UPDATE action_output_handoffs SET output_digest=?2 WHERE invocation_id=?1", params![id.0, "0".repeat(64)]).unwrap();
    let before = receipt_snapshot(&f, &run.id);
    assert_eq!(receipt_consume(&f, &run.id, claim.run_revision, &id), Err(flow::Error::Unavailable));
    assert_eq!(receipt_snapshot(&f, &run.id), before); assert_eq!(f.h.submissions(), 1);
}
