//! Causal transaction tests. Root executes; no provider/CLI authority here.
use super::*;
use rusqlite::{Transaction, TransactionBehavior};
const KEY: &str = "11111111111111111111111111111111";
const SIGNAL: &str = "22222222222222222222222222222222";
const HASH: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
fn scope() -> Scope<'static> { Scope { owner: "human:me", vault: "cccccccccccccccccccccccccccccccc", store: "store", actor: "workflow:owner" } }
fn result() -> Vec<Step<'static>> { vec![Step { id: "result", kind: Kind::Result, next: None, otherwise: None }] }
fn pair(kind: Kind) -> Vec<Step<'static>> { vec![Step { id: "first", kind, next: Some("result"), otherwise: None }, result().remove(0)] }
fn start<'a>(key: &'a str, input: &'a str, steps: &'a [Step<'a>]) -> Start<'a> {
    Start { key, workflow: "flow", version: HASH, schema_digest: HASH, input,
        configuration: HASH, grants: HASH, act_scope: Some(HASH), act_run: Some("original-act-run"),
        entry: steps[0].id, steps, now: 100 }
}
fn setup(conn: &Connection) {
    conn.pragma_update(None, "foreign_keys", true).unwrap();
    // Exercise the actual migration steps, including ACT output handoff tables
    // required by terminal cleanup. The connection remains owned by this fixture.
    for migration in crate::runtime::MIGRATIONS {
        crate::runtime::step(conn, migration).unwrap();
    }
    conn.execute("INSERT INTO vault_registry(vault_id,vault_path,first_seen_at) VALUES(?1,'workflow-fixture','2026-10-26T00:00:00.000Z')", [scope().vault]).unwrap();
}
fn db() -> Connection { let conn=Connection::open_in_memory().unwrap(); setup(&conn); conn }
fn tx<T>(conn: &Connection, f: impl FnOnce(&Connection)->Result<T,Error>) -> Result<T,Error> {
    let tx=Transaction::new_unchecked(conn,TransactionBehavior::Immediate).unwrap();
    let result=f(&tx)?; tx.commit().unwrap(); Ok(result)
}
fn begin(conn: &Connection, steps: &[Step<'_>]) -> Run {
    match tx(conn,|c|start_rows(c,scope(),start(KEY,"{}",steps))).unwrap() {
        Started::New(run)=>run, other=>panic!("expected one initial run: {other:?}")
    }
}
fn inspect(conn: &Connection, run: &str) -> Run { tx(conn,|c|inspect_rows(c,scope(),run)).unwrap() }
fn claim(conn: &Connection, run: &Run) -> Claim {
    tx(conn,|c|claim_rows(c,scope(),&run.id,run.revision,"{}","process-one",101)).unwrap()
}
fn count(conn: &Connection, table: &str) -> i64 { conn.query_row(&format!("SELECT count(*) FROM {table}"),[],|r|r.get(0)).unwrap() }
fn timer(conn: &Connection) -> (Run,Claim,Wait) {
    let run=begin(conn,&pair(Kind::Timer)); let claim=claim(conn,&run);
    let wait=tx(conn,|c|park_rows(c,scope(),&claim,WaitFor::Timer {due:200},102)).unwrap();
    (run,claim,wait)
}
#[test]
fn workflow_requires_transaction_before_any_admission() {
    let conn=db(); assert_eq!(start_rows(&conn,scope(),start(KEY,"{}",&result())),Err(Error::Unavailable));
    assert_eq!(count(&conn,"workflow_runs"),0);
}
#[test]
fn workflow_lost_start_ack_returns_same_run_without_new_claim() {
    let conn=db(); let run=begin(&conn,&result());
    assert_eq!(tx(&conn,|c|start_rows(c,scope(),start(KEY,"{}",&result()))),Ok(Started::Observed(run)));
    assert_eq!(count(&conn,"workflow_runs"),1); assert_eq!(count(&conn,"workflow_steps"),1);
    assert_eq!(count(&conn,"workflow_attempts"),0);
}
#[test]
fn workflow_same_start_key_changed_input_version_or_actor_conflicts() {
    let conn=db(); begin(&conn,&result());
    assert_eq!(tx(&conn,|c|start_rows(c,scope(),start(KEY,"[]",&result()))),Err(Error::Conflict));
    let steps=result(); let mut changed=start(KEY,"{}",&steps); changed.version="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    assert_eq!(tx(&conn,|c|start_rows(c,scope(),changed)),Err(Error::Conflict));
    assert_eq!(tx(&conn,|c|start_rows(c,Scope {actor:"another",..scope()},start(KEY,"{}",&steps))),Err(Error::Conflict));
    assert_eq!(count(&conn,"workflow_runs"),1);
}
#[test]
fn workflow_canonical_input_replay_is_stable_and_exact() {
    let conn=db(); let steps=result();
    let first=tx(&conn,|c|start_rows(c,scope(),start(KEY,r#"{ "n":9007199254740993, "x":1.0 }"#,&steps))).unwrap();
    let Started::New(first)=first else {panic!("new")};
    assert_eq!(tx(&conn,|c|start_rows(c,scope(),start(KEY,r#"{"x":1e0,"n":9007199254740993}"#,&steps))),Ok(Started::Observed(first.clone())));
    let value=tx(&conn,|c|value_rows(c,scope(),&first.id,&first.input_digest)).unwrap();
    assert!(value.contains("9007199254740993"));
}
#[test]
fn workflow_start_rollback_preserves_no_partial_identity_or_values() {
    let conn=db(); let result:Result<(),Error>=tx(&conn,|c|{start_rows(c,scope(),start(KEY,"{}",&result()))?;Err(Error::Invalid)});
    assert_eq!(result,Err(Error::Invalid));
    for table in ["workflow_runs","workflow_steps","workflow_values"] {assert_eq!(count(&conn,table),0);}
}
#[test]
fn workflow_wrong_scope_cannot_inspect_claim_or_resume() {
    let conn=db(); let (run,_,wait)=timer(&conn);
    for wrong in [Scope {owner:"other",..scope()},Scope {vault:"dddddddddddddddddddddddddddddddd",..scope()},Scope {store:"other",..scope()},Scope {actor:"other",..scope()}] {
        assert_eq!(tx(&conn,|c|inspect_rows(c,wrong,&run.id)),Err(Error::Denied));
        assert_eq!(tx(&conn,|c|resume_rows(c,wrong,&wait.id,wait.revision,SIGNAL,Signal::Timer {ready:true},200)),Err(Error::Denied));
    }
    assert_eq!(inspect(&conn,&run.id).state,"waiting");
}
#[test]
fn workflow_claim_is_unique_and_freezes_request_before_action_prepare() {
    let conn=db(); let run=begin(&conn,&pair(Kind::Action)); let claimed=claim(&conn,&run);
    assert_eq!(claimed.ordinal,1); assert_eq!(claimed.request_key.len(),64);
    assert_eq!(tx(&conn,|c|claim_rows(c,scope(),&run.id,run.revision,"{}","process-two",101)),Err(Error::Stale));
    let stored:(String,String,Option<String>)=conn.query_row("SELECT request_key,input_digest,invocation_id FROM workflow_attempts",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap();
    assert_eq!(stored,(claimed.request_key,claimed.input_digest,None));
    let reserved:i64=conn.query_row("SELECT reserved_bytes FROM workflow_runs",[],|r|r.get(0)).unwrap();
    assert_eq!(reserved,262144);
}
#[test]
fn workflow_result_and_cursor_rollback_together_then_commit_once() {
    let conn=db(); let run=begin(&conn,&pair(Kind::Transform)); let claimed=claim(&conn,&run);
    let refused:Result<(),Error>=tx(&conn,|c|{finish_rows(c,scope(),&claimed,"1",Some("result"),102)?;Err(Error::Invalid)});
    assert_eq!(refused,Err(Error::Invalid)); assert_eq!(inspect(&conn,&run.id).cursor.as_deref(),Some("first"));
    let done=tx(&conn,|c|finish_rows(c,scope(),&claimed,"1",Some("result"),102)).unwrap();
    assert_eq!(done.cursor.as_deref(),Some("result"));
    assert_eq!(tx(&conn,|c|finish_rows(c,scope(),&claimed,"1",Some("result"),103)),Err(Error::Stale));
    assert_eq!(conn.query_row("SELECT count(*) FROM workflow_values WHERE role='step_output'",[],|r|r.get::<_,i64>(0)).unwrap(),1);
}
#[test]
fn workflow_branch_marks_only_unreachable_pending_steps_skipped() {
    let conn=db(); let steps=vec![Step {id:"branch",kind:Kind::Condition,next:Some("yes"),otherwise:Some("no")},Step {id:"yes",kind:Kind::Transform,next:Some("result"),otherwise:None},Step {id:"no",kind:Kind::Transform,next:Some("result"),otherwise:None},result().remove(0)];
    let run=begin(&conn,&steps); let claimed=claim(&conn,&run);
    tx(&conn,|c|finish_rows(c,scope(),&claimed,"true",Some("yes"),102)).unwrap();
    let rows:Vec<(String,String)>=conn.prepare("SELECT step_id,state FROM workflow_steps ORDER BY definition_ordinal").unwrap().query_map([],|r|Ok((r.get(0)?,r.get(1)?))).unwrap().collect::<Result<_,_>>().unwrap();
    assert_eq!(rows,vec![("branch".into(),"succeeded".into()),("yes".into(),"pending".into()),("no".into(),"skipped".into()),("result".into(),"pending".into())]);
}
#[test]
fn workflow_timer_early_unready_duplicate_and_unknown_are_not_new_work() {
    let conn=db(); let (run,_,wait)=timer(&conn); let before=inspect(&conn,&run.id);
    assert!(matches!(tx(&conn,|c|resume_rows(c,scope(),&wait.id,wait.revision,SIGNAL,Signal::Timer {ready:true},199)),Ok(Resumed::NotDue(_))));
    assert_eq!(tx(&conn,|c|resume_rows(c,scope(),&wait.id,wait.revision,SIGNAL,Signal::Timer {ready:false},200)),Err(Error::Denied));
    assert_eq!(inspect(&conn,&run.id),before);
    let first=tx(&conn,|c|resume_rows(c,scope(),&wait.id,wait.revision,SIGNAL,Signal::Timer {ready:true},200)).unwrap();
    let Resumed::Advanced(first)=first else {panic!("one advancement")}; assert_eq!(first.cursor.as_deref(),Some("result"));
    assert_eq!(tx(&conn,|c|resume_rows(c,scope(),&wait.id,wait.revision,SIGNAL,Signal::Timer {ready:true},201)),Ok(Resumed::AlreadyConsumed(first)));
    assert!(tx(&conn,|c|resume_rows(c,scope(),"ffffffffffffffffffffffffffffffff",1,SIGNAL,Signal::Timer {ready:true},201)).is_err());
    assert_eq!(count(&conn,"workflow_waits"),1);
}
#[test]
fn workflow_external_invalid_input_preserves_wait_then_expiry_blocks() {
    let conn=db(); let run=begin(&conn,&pair(Kind::ExternalInput)); let claimed=claim(&conn,&run);
    let wait=tx(&conn,|c|park_rows(c,scope(),&claimed,WaitFor::ExternalInput {schema:r#"{"type":"integer"}"#,expires:200},102)).unwrap();
    let before=inspect(&conn,&run.id);
    assert!(matches!(tx(&conn,|c|resume_rows(c,scope(),&wait.id,wait.revision,SIGNAL,Signal::ExternalInput {value:r#""wrong""#},150)),Ok(Resumed::Rejected(_))));
    assert_eq!(inspect(&conn,&run.id),before);
    let blocked=tx(&conn,|c|resume_rows(c,scope(),&wait.id,wait.revision,SIGNAL,Signal::ExternalInput {value:"1"},201)).unwrap();
    let Resumed::Blocked(blocked)=blocked else {panic!("expiry blocks")};
    assert_eq!(blocked.reason.as_deref(),Some("input_expired"));
    assert!(count(&conn,"workflow_values")>0,"unresolved input expiry does not reclaim active recovery bytes");
}
#[test]
fn workflow_cancel_wait_prevents_signal_and_stale_local_completion() {
    let conn=db(); let (run,claimed,wait)=timer(&conn); let parked=inspect(&conn,&run.id);
    let cancelled=tx(&conn,|c|cancel_rows(c,scope(),&run.id,parked.revision,103)).unwrap();
    assert_eq!(cancelled.state,"cancelled");
    assert!(tx(&conn,|c|resume_rows(c,scope(),&wait.id,wait.revision,SIGNAL,Signal::Timer {ready:true},201)).is_err());
    assert_eq!(tx(&conn,|c|finish_rows(c,scope(),&claimed,"null",Some("result"),201)),Err(Error::Stale));
    assert_eq!(count(&conn,"workflow_values"),0);
}
#[test]
fn workflow_terminal_retention_off_removes_bodies_but_keeps_digests() {
    let conn=db(); let run=begin(&conn,&result()); let claimed=claim(&conn,&run);
    let finished=tx(&conn,|c|finish_rows(c,scope(),&claimed,r#"{"answer":"sensitive"}"#,None,102)).unwrap();
    assert_eq!(finished.state,"succeeded"); assert_eq!(count(&conn,"workflow_values"),0);
    assert_eq!(count(&conn,"workflow_attempts"),1); assert_eq!(count(&conn,"workflow_steps"),1);
    assert_eq!(finished.input_digest,run.input_digest);
    assert_eq!(tx(&conn,|c|value_rows(c,scope(),&run.id,&run.input_digest)),Err(Error::MissingValue));
    assert_eq!(tx(&conn,|c|start_rows(c,scope(),start(KEY,"{}",&result()))),Ok(Started::Observed(finished)));
    assert_eq!(count(&conn,"workflow_values"),0,"replay must not rehydrate completed details");
}
fn effect<'a>(claim:&'a Claim,state:EffectState,revision:u64,output:Option<&'a str>)->Effect<'a> {
    Effect {step:&claim.step,ordinal:claim.ordinal,request_key:&claim.request_key,invocation:"original-invocation",approval:Some("original-approval"),revision,state,output}
}
#[test]
fn workflow_action_completed_before_park_advances_once_without_new_attempt() {
    let conn=db(); let run=begin(&conn,&pair(Kind::Action)); let claimed=claim(&conn,&run);
    let next=tx(&conn,|c|effect_rows(c,scope(),&run.id,claimed.run_revision,effect(&claimed,EffectState::Succeeded,3,Some("null")),102)).unwrap();
    assert_eq!(next.cursor.as_deref(),Some("result")); assert_eq!(count(&conn,"workflow_attempts"),1);
    assert!(tx(&conn,|c|effect_rows(c,scope(),&run.id,claimed.run_revision,effect(&claimed,EffectState::Succeeded,3,Some("null")),103)).is_err());
}
#[test]
fn workflow_action_unknown_and_cancellation_keep_original_recovery_values() {
    let conn=db(); let run=begin(&conn,&pair(Kind::Action)); let claimed=claim(&conn,&run);
    let blocked=tx(&conn,|c|effect_rows(c,scope(),&run.id,claimed.run_revision,effect(&claimed,EffectState::Unknown,3,None),102)).unwrap();
    assert_eq!(blocked.state,"blocked"); assert_eq!(blocked.reason.as_deref(),Some("effect_outcome_unknown"));
    let cancelled=tx(&conn,|c|cancel_rows(c,scope(),&run.id,blocked.revision,103)).unwrap();
    assert_eq!(cancelled.state,"blocked"); assert!(cancelled.cancel_requested);
    assert_eq!(cancelled.reason.as_deref(),Some("effect_outcome_unknown"));
    assert!(count(&conn,"workflow_values")>0); assert_eq!(count(&conn,"workflow_attempts"),1);
}
#[test]
fn workflow_recovery_never_repeats_interrupted_local_read() {
    let conn=db(); let run=begin(&conn,&pair(Kind::Read)); claim(&conn,&run);
    assert_eq!(tx(&conn,|c|recover_rows(c,scope(),"new-process",32,200)).unwrap(),1);
    let recovered=inspect(&conn,&run.id); assert_eq!(recovered.state,"blocked");
    assert_eq!(recovered.reason.as_deref(),Some("step_interrupted"));
    assert!(tx(&conn,|c|claim_rows(c,scope(),&run.id,recovered.revision,"{}","new-process",201)).is_err());
    assert_eq!(count(&conn,"workflow_attempts"),1);
}
#[test]
fn workflow_two_connections_claim_one_current_step() {
    let dir=crate::vault::testutil::temp_vault("workflow-step-claim");
    struct Cleanup(std::path::PathBuf); impl Drop for Cleanup {fn drop(&mut self){let _=std::fs::remove_dir_all(&self.0);}}
    let _cleanup=Cleanup(dir.clone()); let path=dir.join("workflow.db");
    let conn=Connection::open(&path).unwrap(); setup(&conn); let run=begin(&conn,&result());
    let barrier=std::sync::Arc::new(std::sync::Barrier::new(2));
    let results=std::thread::scope(|threads| {
        let mut workers=Vec::new();
        for _ in 0..2 {let path=path.clone();let barrier=barrier.clone();let run=run.clone();workers.push(threads.spawn(move || {
            let conn=Connection::open(path).unwrap();conn.busy_timeout(std::time::Duration::from_secs(2)).unwrap();
            barrier.wait();tx(&conn,|c|claim_rows(c,scope(),&run.id,run.revision,"{}","process",101))
        }));}
        workers.into_iter().map(|worker|worker.join().unwrap()).collect::<Vec<_>>()
    });
    assert_eq!(results.iter().filter(|result|result.is_ok()).count(),1);
    assert_eq!(count(&conn,"workflow_attempts"),1);
}

#[test]
fn workflow_vault_budget_reserves_before_claim_and_releases_only_settled_values() {
    with_active_vault_limit(262154, || {
        let conn=db(); let first=begin(&conn,&result()); let active=claim(&conn,&first);
        let key="33333333333333333333333333333333"; let steps=result();
        let second=tx(&conn,|c|start_rows(c,scope(),start(key,"{}",&steps))).unwrap();
        let Started::New(second)=second else {panic!("new second run")};
        assert_eq!(tx(&conn,|c|claim_rows(c,scope(),&second.id,second.revision,"{}","process",102)),Err(Error::Capacity));
        assert_eq!(count(&conn,"workflow_attempts"),1,"no second preparation identity before capacity exists");
        tx(&conn,|c|finish_rows(c,scope(),&active,"null",None,103)).unwrap();
        assert!(tx(&conn,|c|claim_rows(c,scope(),&second.id,second.revision,"{}","process",104)).is_ok());
    });
}
#[test]
fn workflow_unknown_effect_keeps_its_active_vault_reservation_protected() {
    with_active_vault_limit(262154, || {
        let conn=db(); let first=begin(&conn,&pair(Kind::Action)); let active=claim(&conn,&first);
        let blocked=tx(&conn,|c|effect_rows(c,scope(),&first.id,active.run_revision,effect(&active,EffectState::Unknown,3,None),102)).unwrap();
        tx(&conn,|c|cancel_rows(c,scope(),&first.id,blocked.revision,103)).unwrap();
        let key="33333333333333333333333333333333"; let steps=result();
        let Started::New(second)=tx(&conn,|c|start_rows(c,scope(),start(key,"{}",&steps))).unwrap() else {panic!("second")};
        assert_eq!(tx(&conn,|c|claim_rows(c,scope(),&second.id,second.revision,"{}","process",104)),Err(Error::Capacity));
        assert_eq!(inspect(&conn,&first.id).state,"blocked");
    });
}

#[test]
fn workflow_wait_wrong_kind_revision_and_new_replay_key_cannot_advance() {
    let conn=db(); let (run,_,wait)=timer(&conn); let before=inspect(&conn,&run.id);
    assert_eq!(tx(&conn,|c|resume_rows(c,scope(),&wait.id,wait.revision+1,SIGNAL,Signal::Timer {ready:true},200)),Err(Error::Stale));
    assert_eq!(tx(&conn,|c|resume_rows(c,scope(),&wait.id,wait.revision,SIGNAL,Signal::ExternalInput {value:"1"},200)),Err(Error::Denied));
    assert_eq!(inspect(&conn,&run.id),before);
    tx(&conn,|c|resume_rows(c,scope(),&wait.id,wait.revision,SIGNAL,Signal::Timer {ready:true},200)).unwrap();
    assert_eq!(tx(&conn,|c|resume_rows(c,scope(),&wait.id,wait.revision,"33333333333333333333333333333333",Signal::Timer {ready:true},201)),Err(Error::Conflict));
}
#[test]
fn workflow_restart_action_keeps_original_attempt_key_and_input() {
    let conn=db(); let run=begin(&conn,&pair(Kind::Action)); let claimed=claim(&conn,&run);
    tx(&conn,|c|recover_rows(c,scope(),"new-process",32,200)).unwrap();
    let frozen:(String,String,Option<String>)=conn.query_row("SELECT request_key,input_digest,invocation_id FROM workflow_attempts",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap();
    assert_eq!(frozen,(claimed.request_key,claimed.input_digest,None));
    assert_eq!(inspect(&conn,&run.id).reason.as_deref(),Some("action_reconcile_required"));
    assert_eq!(count(&conn,"workflow_attempts"),1);
}
#[test]
fn workflow_two_connections_consume_one_timer_continuation() {
    let dir=crate::vault::testutil::temp_vault("workflow-wait-claim");
    struct Cleanup(std::path::PathBuf); impl Drop for Cleanup {fn drop(&mut self){let _=std::fs::remove_dir_all(&self.0);}}
    let _cleanup=Cleanup(dir.clone()); let path=dir.join("workflow.db");
    let conn=Connection::open(&path).unwrap(); setup(&conn); let (run,_,wait)=timer(&conn);
    let barrier=std::sync::Arc::new(std::sync::Barrier::new(2));
    let results=std::thread::scope(|threads| {
        let mut workers=Vec::new();
        for _ in 0..2 {let path=path.clone();let barrier=barrier.clone();let wait=wait.clone();workers.push(threads.spawn(move || {
            let conn=Connection::open(path).unwrap();conn.busy_timeout(std::time::Duration::from_secs(2)).unwrap();
            barrier.wait();tx(&conn,|c|resume_rows(c,scope(),&wait.id,wait.revision,SIGNAL,Signal::Timer {ready:true},200))
        }));}
        workers.into_iter().map(|worker|worker.join().unwrap()).collect::<Vec<_>>()
    });
    assert_eq!(results.iter().filter(|result|matches!(result,Ok(Resumed::Advanced(_)))).count(),1);
    assert_eq!(results.iter().filter(|result|matches!(result,Ok(Resumed::AlreadyConsumed(_)))).count(),1);
    assert_eq!(inspect(&conn,&run.id).cursor.as_deref(),Some("result"));
}

#[test]
fn workflow_vault_budget_counts_unresolved_values_across_store_replacement() {
    with_active_vault_limit(262154, || {
        let conn=db(); let first=begin(&conn,&pair(Kind::Action)); let active=claim(&conn,&first);
        tx(&conn,|c|effect_rows(c,scope(),&first.id,active.run_revision,effect(&active,EffectState::Unknown,3,None),102)).unwrap();
        let replacement=Scope {store:"replacement-store",..scope()}; let steps=result();
        let Started::New(second)=tx(&conn,|c|start_rows(c,replacement,start(KEY,"{}",&steps))).unwrap() else {panic!("new store identity")};
        assert_eq!(tx(&conn,|c|claim_rows(c,replacement,&second.id,second.revision,"{}","process",103)),Err(Error::Capacity),
            "same vault's unresolved old-store bytes/reservation still consume its active-vault budget");
        assert_eq!(inspect(&conn,&first.id).reason.as_deref(),Some("effect_outcome_unknown"));
        assert_eq!(count(&conn,"workflow_attempts"),1);
    });
}
#[test]
fn workflow_actual_new_approval_reopens_expired_wait_under_a_new_revision() {
    let conn=db(); let run=begin(&conn,&pair(Kind::Action)); let claimed=claim(&conn,&run);
    let waiting=tx(&conn,|c|effect_rows(c,scope(),&run.id,claimed.run_revision,effect(&claimed,EffectState::AwaitingApproval,1,None),102)).unwrap();
    let expired=tx(&conn,|c|effect_rows(c,scope(),&run.id,waiting.revision,effect(&claimed,EffectState::Expired,2,None),103)).unwrap();
    let old:(String,i64,String)=conn.query_row("SELECT continuation_id,revision,state FROM workflow_waits",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap();
    assert_eq!(old.2,"expired"); assert_eq!(expired.reason.as_deref(),Some("approval_expired"));
    // ACT service.rs::refresh_approval is the explicit renewal owner: it keeps
    // the original invocation/request/input, installs a NEW approval ID and
    // bumps ACT revision. FLOW observes that outcome; it never renews approval.
    let mut renewed=effect(&claimed,EffectState::AwaitingApproval,3,None);
    renewed.approval=Some("explicitly-renewed-act-approval");
    let current=tx(&conn,|c|effect_rows(c,scope(),&run.id,expired.revision,renewed,104)).unwrap();
    let new:(String,i64,String,String)=conn.query_row("SELECT continuation_id,revision,state,approval_id FROM workflow_waits",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).unwrap();
    assert_eq!(current.state,"waiting"); assert_eq!(current.reason.as_deref(),Some("approval_pending"));
    assert_eq!(new.2,"pending","an actually renewed approval must not park behind an expired continuation");
    assert_eq!(new.0,old.0); assert!(new.1>old.1,"old expected revision cannot consume renewed wait");
    assert_eq!(new.3,"explicitly-renewed-act-approval");
    assert_eq!(count(&conn,"workflow_attempts"),1); assert_eq!(count(&conn,"workflow_waits"),1);
}

fn historical_approval_after_dispatch(state:EffectState,parked:bool) {
    let conn=db();let run=begin(&conn,&pair(Kind::Action));let claimed=claim(&conn,&run);
    let expected=if parked {
        tx(&conn,|c|effect_rows(c,scope(),&run.id,claimed.run_revision,effect(&claimed,EffectState::AwaitingApproval,1,None),102)).unwrap().revision
    }else{claimed.run_revision};
    let observed=tx(&conn,|c|effect_rows(c,scope(),&run.id,expected,effect(&claimed,state,2,None),103)).unwrap();
    assert!(matches!(observed.state.as_str(),"waiting"|"blocked"));
    let pending:i64=conn.query_row("SELECT count(*) FROM workflow_waits WHERE run_id=?1 AND kind='person_approval' AND state='pending'",[&run.id],|row|row.get(0)).unwrap();
    assert_eq!(pending,0,"a historical consumed ACT approval is not a new human task");
    if parked {
        let (state,revision):(String,i64)=conn.query_row("SELECT state,revision FROM workflow_waits WHERE run_id=?1",[&run.id],|row|Ok((row.get(0)?,row.get(1)?))).unwrap();
        assert_eq!(state,"consumed");assert!(revision>1);
    }else{assert_eq!(count(&conn,"workflow_waits"),0,"observation must not fabricate a wait");}
    let approval:String=conn.query_row("SELECT approval_id FROM workflow_attempts WHERE run_id=?1",[&run.id],|row|row.get(0)).unwrap();
    assert_eq!(approval,"original-approval","retain historical ACT identity on the attempt");
    let reserved:i64=conn.query_row("SELECT reserved_bytes FROM workflow_runs WHERE run_id=?1",[&run.id],|row|row.get(0)).unwrap();
    assert_eq!(reserved,262144);assert!(count(&conn,"workflow_values")>0);
}
#[test]
fn workflow_dispatched_historical_approval_creates_no_person_wait(){historical_approval_after_dispatch(EffectState::Dispatched,false);}
#[test]
fn workflow_unknown_historical_approval_creates_no_person_wait(){historical_approval_after_dispatch(EffectState::Unknown,false);}
#[test]
fn workflow_missing_output_historical_approval_creates_no_person_wait(){historical_approval_after_dispatch(EffectState::OutputUnavailable,false);}
#[test]
fn workflow_dispatched_consumes_existing_person_wait(){historical_approval_after_dispatch(EffectState::Dispatched,true);}
#[test]
fn workflow_unknown_consumes_existing_person_wait(){historical_approval_after_dispatch(EffectState::Unknown,true);}
#[test]
fn workflow_missing_output_consumes_existing_person_wait(){historical_approval_after_dispatch(EffectState::OutputUnavailable,true);}

#[test]
fn workflow_ready_historical_approval_creates_no_person_wait(){historical_approval_after_dispatch(EffectState::Ready,false);}
#[test]
fn workflow_ready_consumes_existing_person_wait(){historical_approval_after_dispatch(EffectState::Ready,true);}
