//! ACT-owned recovery bytes for one explicitly registered FLOW consumer.
//! No path opener, provider executor or native authority constructor lives here.
#![cfg_attr(not(test), expect(dead_code, reason = "native ACT/FLOW dispatch remains disabled until retained-owner integration"))]
use super::{effect_kernel::{self as kernel, MutationContext}, effect_record::{self, ActionInvocation}, effect_types::*, native_db::AuthorityDb, schema};
use crate::runtime::workflows::{self as flow, Scope, Claim, Run};
use rusqlite::{params, Connection, OptionalExtension};

fn unavailable<T>() -> Result<T, flow::Error> { Err(flow::Error::Unavailable) }
fn db(_: rusqlite::Error) -> flow::Error { flow::Error::Unavailable }
fn action(error: ActionError) -> flow::Error {
    match error.code { ActionErrorCode::Denied => flow::Error::Denied, ActionErrorCode::RevisionConflict => flow::Error::Stale, _ => flow::Error::Unavailable }
}
fn guarded(conn: &Connection) -> Result<(), flow::Error> {
    if conn.is_autocommit() { unavailable() } else { Ok(()) }
}
fn integer(value: u64) -> Result<i64, flow::Error> {
    SafeCounter::new(value).map_err(action)?;
    i64::try_from(value).map_err(|_| flow::Error::Unavailable)
}
fn sql_counter(row: &rusqlite::Row<'_>, column: usize) -> rusqlite::Result<u64> {
    let value: i64 = row.get(column)?;
    let value = u64::try_from(value).map_err(|_| rusqlite::Error::InvalidQuery)?;
    SafeCounter::new(value).map_err(|_| rusqlite::Error::InvalidQuery)?;
    Ok(value)
}
fn sql_size(row: &rusqlite::Row<'_>, column: usize) -> rusqlite::Result<usize> {
    usize::try_from(sql_counter(row, column)?).map_err(|_| rusqlite::Error::InvalidQuery)
}
fn sql_optional_counter(row: &rusqlite::Row<'_>, column: usize) -> rusqlite::Result<Option<u64>> {
    let value: Option<i64> = row.get(column)?;
    value.map(|value| {
        let value = u64::try_from(value).map_err(|_| rusqlite::Error::InvalidQuery)?;
        SafeCounter::new(value).map_err(|_| rusqlite::Error::InvalidQuery)?;
        Ok(value)
    }).transpose()
}
fn size(value: usize) -> Result<i64, flow::Error> {
    integer(u64::try_from(value).map_err(|_| flow::Error::Capacity)?)
}
fn canonical(value: &str) -> Result<String, flow::Error> {
    schema::workflow_canonical_json(value, flow::action_output_allocation(), flow::action_output_json_depth()).map_err(action)
}
fn scope_json(scope: &ActionSubjectView) -> Result<String, flow::Error> {
    canonical(&serde_json::to_string(scope).map_err(|_| flow::Error::Unavailable)?)
}
fn actual(conn: &Connection, context: &dyn MutationContext, subject: &ActionSubjectView, id: &InvocationId) -> Result<ActionInvocation, flow::Error> {
    let record = kernel::load(conn, id).map_err(action)?;
    if &record.scope != subject { return Err(flow::Error::Denied); }
    context.read_access(AuthorityDb::Writer(conn), subject, &record.request.account_id).map_err(action)?;
    Ok(record)
}
struct Handoff {
    invocation: String, run: String, step: String, ordinal: u64, request_key: String,
    owner: String, vault: String, store: String, actor: String,
    act_scope_json: String, act_scope_digest: String,
    original_request_digest: String, original_input_digest: String, effective_input_digest: Option<String>,
    allocation: usize, attempt: Option<String>, receipt: Option<String>, observation_revision: Option<u64>,
    state: String, output: Option<String>, output_digest: Option<String>, byte_count: usize, ack_kind: Option<String>,
}
impl Handoff {
    fn scope(&self) -> Scope<'_> { Scope { owner: &self.owner, vault: &self.vault, store: &self.store, actor: &self.actor } }
    fn same_scope(&self, scope: Scope<'_>) -> bool { self.owner==scope.owner && self.vault==scope.vault && self.store==scope.store && self.actor==scope.actor }
}
fn load(conn: &Connection, id: &InvocationId) -> Result<Option<Handoff>, flow::Error> {
    conn.query_row("SELECT invocation_id,workflow_run_id,step_id,ordinal,request_key,owner_person,vault_id,store_uuid,actor_id,act_scope_json,act_scope_digest,original_request_digest,original_input_digest,effective_input_digest,reserved_bytes,attempt_id,receipt_id,observation_revision,state,CASE WHEN length(CAST(output_json AS BLOB))<=reserved_bytes AND reserved_bytes<=?2 THEN output_json ELSE NULL END,output_digest,byte_count,ack_kind FROM action_output_handoffs WHERE invocation_id=?1", params![id.0,size(flow::action_output_allocation())?], |r| Ok(Handoff {
        invocation:r.get(0)?,run:r.get(1)?,step:r.get(2)?,ordinal:sql_counter(r,3)?,request_key:r.get(4)?,owner:r.get(5)?,vault:r.get(6)?,store:r.get(7)?,actor:r.get(8)?,act_scope_json:r.get(9)?,act_scope_digest:r.get(10)?,original_request_digest:r.get(11)?,original_input_digest:r.get(12)?,effective_input_digest:r.get(13)?,allocation:sql_size(r,14)?,attempt:r.get(15)?,receipt:r.get(16)?,observation_revision:sql_optional_counter(r,17)?,state:r.get(18)?,output:r.get(19)?,output_digest:r.get(20)?,byte_count:sql_size(r,21)?,ack_kind:r.get(22)?,
    })).optional().map_err(db)
}
fn check_original(row: &Handoff, record: &ActionInvocation) -> Result<(), flow::Error> {
    let stored: ActionSubjectView = serde_json::from_str(&row.act_scope_json).map_err(|_| flow::Error::Unavailable)?;
    let original = schema::validate_input(&record.definition, &record.request.input).map_err(action)?;
    let request_digest = match record.lookup_version { 0 => effect_record::legacy_request_digest(&record.request), 1 => effect_record::request_digest(&record.request), _ => return unavailable() }.map_err(action)?;
    if stored!=record.scope || scope_json(&stored)?!=row.act_scope_json || effect_record::scope_key(&stored).map_err(action)?!=row.act_scope_digest
        || row.invocation!=record.details.effect.invocation_id.0 || row.request_key!=record.request.request_key
        || row.original_request_digest!=record.request_digest || request_digest!=record.request_digest
        || row.original_input_digest!=original.digest { return Err(flow::Error::Denied); }
    if row.allocation!=flow::action_output_allocation() { return unavailable(); }
    Ok(())
}
fn allocation(conn: &Connection, row: &Handoff) -> Result<(), flow::Error> {
    let run = flow::inspect_rows(conn,row.scope(),&row.run)?;
    if !matches!(run.state.as_str(),"running"|"waiting"|"blocked") || run.cancel_requested || run.cursor.as_deref()!=Some(&row.step) { return Err(flow::Error::Denied); }
    let (reserved, ordinal, key, input, invocation, act_scope, act_run): (usize,u64,String,String,Option<String>,Option<String>,Option<String>) = conn.query_row("SELECT r.reserved_bytes,s.attempt_ordinal,a.request_key,a.input_digest,a.invocation_id,r.act_scope_digest,r.act_run_id FROM workflow_runs r JOIN workflow_steps s ON s.run_id=r.run_id AND s.step_id=?2 JOIN workflow_attempts a ON a.run_id=s.run_id AND a.step_id=s.step_id AND a.ordinal=?3 WHERE r.run_id=?1 AND s.kind='action' AND s.state IN ('running','waiting','blocked')",params![row.run,row.step,integer(row.ordinal)?],|r|Ok((sql_size(r,0)?,sql_counter(r,1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?))).map_err(db)?;
    let subject: ActionSubjectView = serde_json::from_str(&row.act_scope_json).map_err(|_| flow::Error::Unavailable)?;
    if reserved<row.allocation || ordinal!=row.ordinal || key!=row.request_key || input!=row.original_input_digest || invocation.as_deref()!=Some(&row.invocation) || act_scope.as_deref()!=Some(&row.act_scope_digest) || act_run.as_deref()!=Some(&subject.run_id) { return Err(flow::Error::Denied); }
    Ok(())
}
pub(super) fn register_rows(conn:&Connection,scope:Scope<'_>,claim:&Claim,context:&dyn MutationContext,subject:&ActionSubjectView,id:&InvocationId)->Result<(),flow::Error>{
    guarded(conn)?;
    if scope.vault!=subject.vault_id || scope.actor!=subject.actor_id { return Err(flow::Error::Denied); }
    let record=actual(conn,context,subject,id)?;
    if let Some(row)=load(conn,id)? {
        check_original(&row,&record)?;
        if !row.same_scope(scope)||row.run!=claim.run||row.step!=claim.step||row.ordinal!=claim.ordinal||row.request_key!=claim.request_key||row.original_input_digest!=claim.input_digest { return Err(flow::Error::Denied); }
        return Ok(());
    }
    kernel::check(conn,context,&record).map_err(action)?;
    if !matches!(record.details.effect.state,InvocationState::Ready|InvocationState::AwaitingApproval)||!record.details.attempts.is_empty(){return Err(flow::Error::Denied);}
    let run=flow::inspect_rows(conn,scope,&claim.run)?;
    if run.revision!=claim.run_revision||run.state!="running"||run.cancel_requested||run.cursor.as_deref()!=Some(&claim.step){return Err(flow::Error::Stale);}
    let (revision,lease,key,input,body,invocation,act_scope,act_run,reserved):(u64,Option<String>,String,String,String,Option<String>,Option<String>,Option<String>,usize)=conn.query_row("SELECT s.revision,s.lease_token,a.request_key,a.input_digest,v.canonical_json,a.invocation_id,r.act_scope_digest,r.act_run_id,r.reserved_bytes FROM workflow_runs r JOIN workflow_steps s ON s.run_id=r.run_id AND s.step_id=?2 JOIN workflow_attempts a ON a.run_id=s.run_id AND a.step_id=s.step_id AND a.ordinal=?3 JOIN workflow_values v ON v.run_id=a.run_id AND v.value_ref=a.input_ref WHERE r.run_id=?1 AND s.kind='action' AND s.state='running' AND s.attempt_ordinal=?3",params![claim.run,claim.step,integer(claim.ordinal)?],|r|Ok((sql_counter(r,0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get(7)?,sql_size(r,8)?))).map_err(db)?;
    let original=schema::validate_input(&record.definition,&record.request.input).map_err(action)?;
    let act_digest=effect_record::scope_key(subject).map_err(action)?;
    if revision!=claim.step_revision||lease.as_deref()!=Some(&claim.lease)||key!=claim.request_key||key!=record.request.request_key||input!=claim.input_digest||input!=original.digest||canonical(&body)?!=original.value.canonical()||schema::digest(body.as_bytes())!=input||invocation.as_deref().is_some_and(|value|value!=id.0)||act_scope.as_deref()!=Some(&act_digest)||act_run.as_deref()!=Some(&subject.run_id){return Err(flow::Error::Denied);}
    if reserved!=flow::action_output_allocation(){return Err(flow::Error::Capacity);}
    let changed=conn.execute("UPDATE workflow_attempts SET invocation_id=?4 WHERE run_id=?1 AND step_id=?2 AND ordinal=?3 AND (invocation_id IS NULL OR invocation_id=?4)",params![claim.run,claim.step,integer(claim.ordinal)?,id.0]).map_err(db)?;
    if changed!=1{return Err(flow::Error::Stale);}
    conn.execute("INSERT INTO action_output_handoffs(invocation_id,workflow_run_id,step_id,ordinal,request_key,owner_person,vault_id,store_uuid,actor_id,act_scope_json,act_scope_digest,original_request_digest,original_input_digest,reserved_bytes,state,byte_count) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,'registered',0)",params![id.0,claim.run,claim.step,integer(claim.ordinal)?,claim.request_key,scope.owner,scope.vault,scope.store,scope.actor,scope_json(subject)?,act_digest,record.request_digest,original.digest,size(reserved)?]).map_err(db)?;
    Ok(())
}
/// Called within the real claim transaction before its known commit/provider call.
pub(super) fn pin_claim_rows(conn:&Connection,record:&ActionInvocation,attempt:&AttemptId)->Result<(),ActionError>{
    pin_claim(conn,record,attempt).map_err(|error| match error { flow::Error::Denied|flow::Error::Stale|flow::Error::Conflict => kernel::denied(), _ => kernel::unavailable() })
}
fn pin_claim(conn:&Connection,record:&ActionInvocation,attempt:&AttemptId)->Result<(),flow::Error>{
    guarded(conn)?;
    let Some(row)=load(conn,&record.details.effect.invocation_id)? else{return Ok(());};
    check_original(&row,record)?; allocation(conn,&row)?;
    if row.state!="registered"||row.attempt.is_some()||row.receipt.is_some(){return Err(flow::Error::Denied);}
    let changed=conn.execute("UPDATE action_output_handoffs SET attempt_id=?2,effective_input_digest=?3 WHERE invocation_id=?1 AND state='registered' AND attempt_id IS NULL",params![row.invocation,attempt.0,record.details.input_digest]).map_err(db)?;
    if changed!=1{return Err(flow::Error::Stale);}Ok(())
}
/// Canonical bytes and actual success receipt are stored with the observation.
pub(super) fn retain_rows(conn:&Connection,record:&ActionInvocation,output:&schema::ValidatedInput)->Result<(),ActionError>{
    retain(conn,record,output).map_err(|_|kernel::unavailable())
}
fn retain(conn:&Connection,record:&ActionInvocation,validated:&schema::ValidatedInput)->Result<(),flow::Error>{
    let output=validated.value.canonical();
    guarded(conn)?;let Some(row)=load(conn,&record.details.effect.invocation_id)? else{return Ok(());};
    check_original(&row,record)?;
    let reserved:usize=conn.query_row("SELECT reserved_bytes FROM workflow_runs WHERE run_id=?1",[&row.run],|r|sql_size(r,0)).map_err(db)?;
    let last=record.details.attempts.last().ok_or(flow::Error::Unavailable)?;
    let receipt=last.receipt_id.as_ref().ok_or(flow::Error::Unavailable)?;
    if record.details.effect.state!=InvocationState::Succeeded||row.state!="registered"||row.attempt.as_deref()!=Some(&last.attempt_id.0)||row.effective_input_digest.as_deref()!=Some(&record.details.input_digest)||output.len()>row.allocation||reserved<row.allocation{return unavailable();}
    let changed=conn.execute("UPDATE action_output_handoffs SET state='retained',receipt_id=?2,observation_revision=?3,output_json=?4,output_digest=?5,byte_count=?6 WHERE invocation_id=?1 AND state='registered' AND attempt_id=?7",params![row.invocation,receipt,integer(record.revision())?,output,validated.digest,size(output.len())?,last.attempt_id.0]).map_err(db)?;
    if changed!=1{return Err(flow::Error::Stale);}Ok(())
}


fn checked_success(conn:&Connection,row:&Handoff,record:&ActionInvocation)->Result<Option<schema::ValidatedInput>,flow::Error>{
    let last=record.details.attempts.last().ok_or(flow::Error::Unavailable)?;
    if record.details.effect.state!=InvocationState::Succeeded||row.attempt.as_deref()!=Some(&last.attempt_id.0)||row.receipt!=last.receipt_id||row.observation_revision!=Some(record.revision())||row.effective_input_digest.as_deref()!=Some(&record.details.input_digest){return Err(flow::Error::Denied);}
    if row.state=="acknowledged" {
        if row.output.is_some()||!matches!(row.ack_kind.as_deref(),Some("transferred"|"discarded")){return unavailable();}
        return Ok(None);
    }
    if row.state!="retained"{return Err(flow::Error::MissingValue);}
    let output=row.output.as_ref().ok_or(flow::Error::Unavailable)?;
    let validated=schema::validate_output(&record.definition,output).map_err(action)?;
    if output.len()!=row.byte_count||row.byte_count>row.allocation||validated.value.canonical()!=*output||row.output_digest.as_deref()!=Some(&validated.digest){return unavailable();}
    let reserved:usize=conn.query_row("SELECT reserved_bytes FROM workflow_runs WHERE run_id=?1",[&row.run],|r|sql_size(r,0)).map_err(db)?;
    if reserved<row.allocation{return Err(flow::Error::Capacity);}
    Ok(Some(validated))
}
/// Finite original-consumer metadata. This is neither output nor authority.
pub(super) struct RecordedConsumer {pub(super) step:String,pub(super) ordinal:u64,pub(super) request_key:String,pub(super) acknowledged:bool}
/// SELECT-only validation on the caller's existing retained transaction. The
/// success checks are shared with consume_rows, before any cancellation write.
pub(super) fn recorded_consumer_rows(conn:&Connection,scope:Scope<'_>,run:&str,context:&dyn MutationContext,subject:&ActionSubjectView,id:&InvocationId)->Result<RecordedConsumer,flow::Error>{
 guarded(conn)?;
 if scope.vault!=subject.vault_id||scope.actor!=subject.actor_id{return Err(flow::Error::Denied);}
 let record=actual(conn,context,subject,id)?;
 let row=load(conn,id)?.ok_or(flow::Error::MissingValue)?;
 check_original(&row,&record)?;
 if !row.same_scope(scope)||row.run!=run{return Err(flow::Error::Denied);}
 if record.details.effect.state==InvocationState::Succeeded{
  checked_success(conn,&row,&record)?;
 }else{
  if row.state!="registered"||row.output.is_some()||row.output_digest.is_some()||row.byte_count!=0||row.ack_kind.is_some()||row.receipt.is_some()||row.observation_revision.is_some(){return unavailable();}
  if row.attempt.as_deref()!=record.details.attempts.last().map(|attempt|attempt.attempt_id.0.as_str())||row.effective_input_digest.as_deref()!=row.attempt.as_ref().map(|_|record.details.input_digest.as_str()){return Err(flow::Error::Denied);}
 }
 Ok(RecordedConsumer{step:row.step,ordinal:row.ordinal,request_key:row.request_key,acknowledged:row.state=="acknowledged"})
}

/// Only this module can construct proof of an exact authenticated retained body.
pub(crate) struct VerifiedOutput {
    run:String,step:String,ordinal:u64,request_key:String,invocation:String,revision:u64,
    owner:String,vault:String,store:String,actor:String,output_digest:String,
}
impl VerifiedOutput {
    pub(crate) fn matches(&self,scope:Scope<'_>,run:&str,effect:&flow::Effect<'_>)->bool{
        self.run==run&&self.step==effect.step&&self.ordinal==effect.ordinal&&self.request_key==effect.request_key&&self.invocation==effect.invocation&&self.revision==effect.revision&&self.owner==scope.owner&&self.vault==scope.vault&&self.store==scope.store&&self.actor==scope.actor&&effect.state==flow::EffectState::Succeeded&&effect.output.is_some_and(|value|schema::digest(value.as_bytes())==self.output_digest)
    }
}
#[expect(clippy::too_many_arguments,reason="handoff binds actual FLOW revision and original ACT subject/invocation")]
pub(super) fn consume_rows(conn:&Connection,scope:Scope<'_>,run:&str,expected:u64,context:&dyn MutationContext,subject:&ActionSubjectView,id:&InvocationId,now:i64)->Result<Run,flow::Error>{
    guarded(conn)?;if scope.vault!=subject.vault_id || scope.actor!=subject.actor_id { return Err(flow::Error::Denied); }
    let record=actual(conn,context,subject,id)?;
    let row=load(conn,id)?.ok_or(flow::Error::MissingValue)?;check_original(&row,&record)?;
    if !row.same_scope(scope)||row.run!=run{return Err(flow::Error::Denied);}
    let current=flow::inspect_rows(conn,scope,run)?;
    if current.revision!=expected{return Err(flow::Error::Stale);}
    let validated=checked_success(conn,&row,&record)?;
    if row.state=="acknowledged"{return Ok(current);}
    let validated=validated.ok_or(flow::Error::Unavailable)?;
    let output=row.output.as_ref().ok_or(flow::Error::Unavailable)?;
    let proof=VerifiedOutput{run:row.run.clone(),step:row.step.clone(),ordinal:row.ordinal,request_key:row.request_key.clone(),invocation:row.invocation.clone(),revision:record.revision(),owner:row.owner.clone(),vault:row.vault.clone(),store:row.store.clone(),actor:row.actor.clone(),output_digest:validated.digest};
    let effect=flow::Effect{step:&row.step,ordinal:row.ordinal,request_key:&row.request_key,invocation:&row.invocation,approval:record.details.effect.approval_id.as_ref().map(|id|id.0.as_str()),revision:record.revision(),state:flow::EffectState::Succeeded,output:Some(output)};
    let advanced=flow::effect_receipt_rows(conn,scope,run,expected,effect,&proof,now)?;
    conn.execute("UPDATE action_output_handoffs SET state='acknowledged',output_json=NULL,ack_kind=?2 WHERE invocation_id=?1 AND state='retained'",params![id.0,if current.cancel_requested{"discarded"}else{"transferred"}]).map_err(db)?;
    Ok(advanced)
}
/// Same-transaction terminal cleanup cannot leave bytes whose backing is released.
pub(crate) fn terminal_cleanup_rows(conn:&Connection,run:&str)->Result<(),flow::Error>{
    guarded(conn)?;
    let state:String=conn.query_row("SELECT state FROM workflow_runs WHERE run_id=?1",[run],|r|r.get(0)).map_err(db)?;
    if !matches!(state.as_str(),"succeeded"|"failed"|"cancelled"){return Err(flow::Error::Denied);}
    conn.execute("UPDATE action_output_handoffs SET state='acknowledged',output_json=NULL,ack_kind=?2 WHERE workflow_run_id=?1 AND state='retained'",params![run,if state=="succeeded"{"transferred"}else{"discarded"}]).map_err(db)?;Ok(())
}
