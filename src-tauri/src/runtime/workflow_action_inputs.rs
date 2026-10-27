//! Frozen workflow/ACT request identities; no duplicated input body or authority.
#![cfg_attr(not(test), expect(dead_code, reason = "V45 frozen action request rows precede retained native runner wiring"))]
use crate::actions::workflow_requests::{self,FrozenRequest,Selectors};
use super::workflows::{self,Claim,Error,Scope};
use rusqlite::{Connection,OptionalExtension,params};
use sha2::{Digest,Sha256};
pub(crate) const SCHEMA_V45:&str=super::schema::SCHEMA_V45;
#[derive(PartialEq,Eq)]
struct Frozen {act_scope:String,act_run:String,configuration:String,input_ref:String,input_digest:String,key:String,request_digest:String,selectors:Selectors}
fn db(_:rusqlite::Error)->Error{Error::Unavailable}
fn ordinal(value:u64)->Result<i64,Error>{if value>9_007_199_254_740_991{return Err(Error::Invalid);}i64::try_from(value).map_err(|_|Error::Invalid)}
fn load(conn:&Connection,run:&str,step:&str,attempt:i64)->Result<Option<Frozen>,Error>{
    conn.query_row("SELECT act_scope_digest,act_run_id,configuration_digest,input_ref,input_digest,request_key,request_digest,action_id,definition_digest,connection_id,account_id,snapshot_digest FROM workflow_action_inputs WHERE run_id=?1 AND step_id=?2 AND ordinal=?3",params![run,step,attempt],|row|Ok(Frozen{act_scope:row.get(0)?,act_run:row.get(1)?,configuration:row.get(2)?,input_ref:row.get(3)?,input_digest:row.get(4)?,key:row.get(5)?,request_digest:row.get(6)?,selectors:Selectors{action_id:row.get(7)?,definition_digest:row.get(8)?,connection_id:row.get(9)?,account_id:row.get(10)?,snapshot_digest:row.get(11)?}})).optional().map_err(db)
}
fn original_input(conn:&Connection,run:&str,step:&str,attempt:i64,reference:&str,digest:&str)->Result<String,Error>{
    let value:Option<(String,String)>=conn.query_row("SELECT canonical_json,digest FROM workflow_values WHERE run_id=?1 AND value_ref=?2 AND role='step_input' AND step_id=?3 AND ordinal=?4 AND byte_count<=?5",params![run,reference,step,attempt,i64::try_from(workflows::step_value_bytes()).map_err(|_|Error::Unavailable)?],|row|Ok((row.get(0)?,row.get(1)?))).optional().map_err(db)?;
    let (value,stored)=value.ok_or(Error::MissingValue)?;
    if value.len()>workflows::step_value_bytes()||stored!=digest||format!("{:x}",Sha256::digest(value.as_bytes()))!=digest{return Err(Error::Unavailable);}Ok(value)
}
pub(crate) fn freeze_rows(conn:&Connection,scope:Scope<'_>,claim:&Claim,request:&FrozenRequest,configuration:&str)->Result<(),Error>{
    workflows::check_claim_rows(conn,scope,claim)?;
    let checked=workflow_requests::freeze(request.selectors.clone(),&request.input,&request.request_key).map_err(|_|Error::Invalid)?;
    if checked!=*request||request.request_key!=claim.request_key||request.input_digest!=claim.input_digest{return Err(Error::Denied);}
    let (act_scope,act_run,current_configuration,kind):(Option<String>,Option<String>,String,String)=conn.query_row("SELECT r.act_scope_digest,r.act_run_id,r.configuration_digest,s.kind FROM workflow_runs r JOIN workflow_steps s USING(run_id) WHERE r.run_id=?1 AND s.step_id=?2",params![claim.run,claim.step],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?))).map_err(db)?;
    if current_configuration!=configuration||kind!="action"{return Err(Error::Denied);}
    let attempt=ordinal(claim.ordinal)?;
    let (input_ref,input_digest,key):(String,String,String)=conn.query_row("SELECT input_ref,input_digest,request_key FROM workflow_attempts WHERE run_id=?1 AND step_id=?2 AND ordinal=?3",params![claim.run,claim.step,attempt],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?))).map_err(db)?;
    if input_digest!=request.input_digest||key!=request.request_key||original_input(conn,&claim.run,&claim.step,attempt,&input_ref,&input_digest)?!=request.input{return Err(Error::Denied);}
    let frozen=Frozen{act_scope:act_scope.ok_or(Error::Denied)?,act_run:act_run.ok_or(Error::Denied)?,configuration:current_configuration,input_ref,input_digest,key,request_digest:request.request_digest.clone(),selectors:request.selectors.clone()};
    if let Some(existing)=load(conn,&claim.run,&claim.step,attempt)? {return if existing==frozen{Ok(())}else{Err(Error::Conflict)};}
    conn.execute("INSERT INTO workflow_action_inputs(run_id,step_id,ordinal,act_scope_digest,act_run_id,action_id,definition_digest,connection_id,account_id,snapshot_digest,configuration_digest,input_ref,input_digest,request_key,request_digest) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)",params![claim.run,claim.step,attempt,frozen.act_scope,frozen.act_run,frozen.selectors.action_id,frozen.selectors.definition_digest,frozen.selectors.connection_id,frozen.selectors.account_id,frozen.selectors.snapshot_digest,frozen.configuration,frozen.input_ref,frozen.input_digest,frozen.key,frozen.request_digest]).map_err(db)?;
    Ok(())
}
pub(crate) fn recover_rows(conn:&Connection,scope:Scope<'_>,id:&str,step:&str)->Result<FrozenRequest,Error>{
    let run=workflows::inspect_rows(conn,scope,id)?;
    if run.cursor.as_deref()!=Some(step)||!matches!(run.state.as_str(),"running"|"waiting"|"blocked"){return Err(Error::Stale);}
    let (attempt,kind,state,step_ref,step_digest):(i64,String,String,Option<String>,Option<String>)=conn.query_row("SELECT attempt_ordinal,kind,state,input_ref,input_digest FROM workflow_steps WHERE run_id=?1 AND step_id=?2",params![id,step],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?))).map_err(db)?;
    if !(1..=9_007_199_254_740_991).contains(&attempt)||kind!="action"{return Err(Error::Unavailable);}
    if !matches!(state.as_str(),"running"|"waiting"|"blocked"){return Err(Error::Stale);}
    let frozen=load(conn,id,step,attempt)?.ok_or(Error::MissingValue)?;
    // Frozen selectors are data, not permission to bypass the actual current
    // attempt. A stale/corrupt step must never recover a different request.
    let (input_ref,input_digest,key):(String,String,String)=conn.query_row("SELECT input_ref,input_digest,request_key FROM workflow_attempts WHERE run_id=?1 AND step_id=?2 AND ordinal=?3",params![id,step,attempt],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?))).optional().map_err(db)?.ok_or(Error::Stale)?;
    if input_ref!=frozen.input_ref||input_digest!=frozen.input_digest||key!=frozen.key||step_ref.as_deref()!=Some(input_ref.as_str())||step_digest.as_deref()!=Some(input_digest.as_str()){return Err(Error::Denied);}
    let (act_scope,act_run,configuration):(Option<String>,Option<String>,String)=conn.query_row("SELECT act_scope_digest,act_run_id,configuration_digest FROM workflow_runs WHERE run_id=?1",[id],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?))).map_err(db)?;
    if act_scope.as_deref()!=Some(frozen.act_scope.as_str())||act_run.as_deref()!=Some(frozen.act_run.as_str())||configuration!=frozen.configuration{return Err(Error::Denied);}
    let input=original_input(conn,id,step,attempt,&frozen.input_ref,&frozen.input_digest)?;
    let request=workflow_requests::freeze(frozen.selectors,&input,&frozen.key).map_err(|_|Error::Unavailable)?;
    if request.input!=input||request.input_digest!=frozen.input_digest||request.request_digest!=frozen.request_digest{return Err(Error::Unavailable);}
    Ok(request)
}
