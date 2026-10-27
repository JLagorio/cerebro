//! Proposed native person-only run-action grant contract. Wire values are
//! selectors; only actual injected-window/original-publication admission may
//! read/write the run-bound rows. No provider, secret resolver or subject factory.
use crate::actions::{effect_types::*,read_types::ActionDefinition};
use serde::{Deserialize,Serialize};
#[derive(Debug,Clone,Serialize,Deserialize)]
#[cfg_attr(test,derive(schemars::JsonSchema))]
#[serde(tag="kind",rename_all="snake_case",deny_unknown_fields)]
pub(crate) enum GrantInputSelection{AllValidInputs,ExactCanonicalInput{input:String}}
#[derive(Debug,Clone,Serialize,Deserialize)]
#[cfg_attr(test,derive(schemars::JsonSchema))]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct RunActionSelection{
 pub(crate) connection_id:ConnectionId,pub(crate) account_id:AccountId,
 pub(crate) account_revision:SafeCounter,pub(crate) revocation_generation:SafeCounter,
 pub(crate) action_id:ActionId,pub(crate) definition_digest:DefinitionDigest,
 pub(crate) input_scope:GrantInputSelection,
}
#[derive(Debug,Clone,Serialize,Deserialize)]
#[cfg_attr(test,derive(schemars::JsonSchema))]
#[serde(tag="kind",rename_all="snake_case",deny_unknown_fields)]
pub(crate) enum GrantInputView{AllValidInputs,ExactCanonicalInput{#[serde(rename="inputDigest")] input_digest:String}}
#[derive(Debug,Clone,Serialize,Deserialize)]
#[cfg_attr(test,derive(schemars::JsonSchema))]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct RunActionGrantView{
 pub(crate) grant_id:String,pub(crate) revision:SafeCounter,
 pub(crate) connection_id:ConnectionId,pub(crate) account_id:AccountId,
 pub(crate) action_id:ActionId,pub(crate) definition_digest:DefinitionDigest,
 pub(crate) input_scope:GrantInputView,pub(crate) available:bool,
}
#[derive(Debug,Clone,Serialize,Deserialize)]
#[cfg_attr(test,derive(schemars::JsonSchema))]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct RunActionAccountChoice{
 pub(crate) connection_id:ConnectionId,pub(crate) account_id:AccountId,
 pub(crate) label:String,pub(crate) account_revision:SafeCounter,
 pub(crate) revocation_generation:SafeCounter,
}
#[derive(Debug,Clone,Serialize,Deserialize)]
#[cfg_attr(test,derive(schemars::JsonSchema))]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct RunActionAccessView{
 /// Actual original durable id for metadata only; never a writer capability.
 pub(crate) run_id:String,
 /// Digest of this exact origin/grant-set/current account/catalog metadata.
 /// Native validates it again in the same transaction before replacing choices.
 pub(crate) access_revision:String,
 pub(crate) accounts:Vec<RunActionAccountChoice>,
 pub(crate) definitions:Vec<ActionDefinition>,pub(crate) grants:Vec<RunActionGrantView>,
 /// Current original held access-request card, not a fabricated invocation.
 #[serde(deserialize_with="crate::actions::read_types::required_nullable")]
 #[cfg_attr(test,schemars(with="crate::actions::read_types::RequiredNullable<String>"))]
 pub(crate) access_request_id:Option<String>,
}
/// Preserve exact original rows without round-tripping hidden canonical input.
/// A new selection always supplies new explicit input-scope material; it never
/// changes the meaning of an existing exact-input grant implicitly.
#[derive(Debug,Clone,Serialize,Deserialize)]
#[cfg_attr(test,derive(schemars::JsonSchema))]
#[serde(tag="kind",rename_all="snake_case",deny_unknown_fields)]
pub(crate) enum RunActionGrantSelection{
 Preserve{#[serde(rename="grantId")] grant_id:String,#[serde(rename="expectedRevision")] expected_revision:SafeCounter},
 New{selection:RunActionSelection},
}
#[derive(Debug,Clone,Serialize,Deserialize)]
#[cfg_attr(test,derive(schemars::JsonSchema))]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct SetRunActionAccess{
 pub(crate) expected_access_revision:String,pub(crate) selections:Vec<RunActionGrantSelection>,
 /// An explicit Done may finish this exact original access request, including
 /// a deliberate empty selection. Null changes access without answering a wait.
 #[serde(deserialize_with="crate::actions::read_types::required_nullable")]
 #[cfg_attr(test,schemars(with="crate::actions::read_types::RequiredNullable<String>"))]
 pub(crate) complete_request_id:Option<String>,
}
#[derive(Debug,Clone,Serialize,Deserialize)]
#[cfg_attr(test,derive(schemars::JsonSchema))]
#[serde(tag="state",rename_all="snake_case",deny_unknown_fields)]
pub(crate) enum SetRunActionAccessResult{
 /// Only known commit produces Changed. sourceCurrent is a fresh observation
 /// of the ORIGINAL source after commit, not execution authority. requestClosed
 /// confirms only the exact access-choice wait consumed explicit Done; false
 /// never rolls back the already committed grants and must not trigger resend.
 Changed{view:RunActionAccessView,#[serde(rename="sourceCurrent")] source_current:bool,#[serde(rename="requestClosed")] request_closed:bool},
 /// The original classified transaction could not establish whether commit
 /// occurred. This never claims changed/refused; UI disables blind resubmit.
 CommitUnknown{message:String},
 Refused{error:ActionError},
}

// Proposed top-level native command signatures (registered only after reviewed
// producer/tests). Root owns IPC generation/mocks/mounted consumer.
// read_managed_action_access(app, injected_window, agents, run:u64)
//     -> Result<RunActionAccessView,ActionError>
// set_managed_action_access(app, injected_window, agents, run:u64, request:SetRunActionAccess)
//     -> SetRunActionAccessResult
//
// Both use actual CurrentOrigin native person capture before authority locks;
// run is only a selector into its actual live original publication. No native
// lineage, actor, person, session, issuer/subject, capability or grant digest is
// accepted from the renderer. Never fall back to another/new CLI run.
//
// Store: existing action_account_grants, FK exact action_native_runs.run_id.
// Original scope/authority is verified on the same retained RuntimeOwner tx.
// No migration/new global permission or preference-as-authority store is needed.
// Required capabilities, account issuer/subject identity, revisions/generation,
// input digest and trusted owner are computed/checked natively. Exact input
// uses existing compiled schema/parser; its body remains private Rust.
//
// Replace set atomically: preserve identical original grants; revoke removed or
// narrowed rows with their own revision CAS; insert newly explicit grants under
// this actual run only. Never reset a revoked row, mutate the native origin's
// pinned revision, copy a grant from another run or infer a grant from import.
// access_revision covers original native identity and all relevant current
// rows; mismatch returns RevisionConflict without mutation. Account/definition
// drift denies/refuses before insertion. An unchanged explicit Done may finish
// its exact access wait without creating a grant.
//
// Only known commit publishes cancellation of old managed requests under the
// original retained storage guard. No book lock is held during SQL/admission;
// notify exact original access wait after guards drop. Changed with false
// source_current still reports the committed old-run fact, never new authority.
// Provider invocation is absent. Creation still needs its distinct full ACT
// effect preview/person approval; access selection alone performs no effect.

// Preserve resolves grantId+expectedRevision on this exact original native run,
// checks it is the unchanged unrevoked row, and leaves every byte/input digest
// untouched. No hidden exact input is requested from the renderer or rebuilt
// from a digest. Revoked rows cannot be reactivated by Preserve. Removed/new
// choices use existing revision/revocation rules and fresh native validation.
//
// Bootstrap presentation opens the bound access sheet directly from the held
// chat card (Settings may link). Scope label is This run. No remembered/global
// permission or automatic inheritance exists. Access selection and effect
// approval remain distinct, and access choice does not dispatch a provider.

use tauri::{AppHandle,Manager,WebviewWindow};
use rusqlite::Connection;
use super::{Origin,RuntimeOwner,kernel,native_lineage,AuthorityDb};
struct GrantAdmission<'a>{conn:&'a Connection,scope:&'a ActionSubjectView,native:&'a crate::runtime::native_runs::NativeRun}
enum GrantWriteOutcome{Committed(RunActionAccessView),NotCommitted(ActionError),CommitUnknown}

use crate::connections::{account_metadata,metadata::{ConnectionHealth,MetadataRecord}};
use crate::runtime::action_authority::{AccountGrant,GRANTS_SQL};
use rusqlite::params;
use std::collections::BTreeSet;
fn grant_db(_:rusqlite::Error)->ActionError{kernel::unavailable()}
fn grant_error(code:ActionErrorCode,message:&str)->ActionError{crate::actions::read_types::error(code,message)}
fn grant_integer(value:u64)->Result<i64,ActionError>{i64::try_from(value).ok().filter(|_|value<=9_007_199_254_740_991).ok_or_else(kernel::unavailable)}
fn check_admission(conn:&Connection,admission:&GrantAdmission<'_>)->Result<(),ActionError>{
 if conn.is_autocommit(){return Err(kernel::unavailable());}
 if !std::ptr::eq(conn,admission.conn)||admission.scope.run_id!=admission.native.run_id||admission.scope.vault_id!=admission.native.vault_id||admission.scope.actor_id!=admission.native.actor_id||admission.scope.client_id.is_some()||admission.scope.child_job_id.is_some(){return Err(kernel::denied());}
 let row=admission.native;
 if row.source_kind!="run"||row.parent_run_id.is_some()||row.client_id.is_some()||row.child_job_id.is_some()||row.owner_person!=crate::actions::native_rules::admission_rules().owner_storage_key{return Err(kernel::denied());}
 let binding=native_lineage::NativeBinding{run_id:&row.run_id,vault_id:&row.vault_id,store_uuid:&row.store_uuid,canonical_vault:std::path::Path::new(&row.canonical_vault_path),owner_person:&row.owner_person,actor_id:&row.actor_id,source_kind:&row.source_kind,app_session_id:&row.app_session_id,cli_session_id:row.cli_session_id.as_deref(),parent_run_id:None,client_id:None,child_job_id:None};
 let actual=native_lineage::resolve_lineage(AuthorityDb::Writer(conn),&binding,false).map_err(|_|kernel::denied())?;
 if !actual.can_call||actual.row.authority_id!=row.authority_id||actual.row.revision!=row.revision{return Err(kernel::denied());}Ok(())
}
fn stored_grants(conn:&Connection,admission:&GrantAdmission<'_>)->Result<Vec<AccountGrant>,ActionError>{
 let cap=crate::actions::schema::admission_rules().limits.grants_per_run;let limit=cap.checked_add(1).ok_or_else(kernel::unavailable)?.to_string();
 let mut statement=conn.prepare(GRANTS_SQL).map_err(grant_db)?;
 let grants=statement.query_map([admission.scope.run_id.as_str(),limit.as_str()],AccountGrant::read).map_err(grant_db)?.collect::<Result<Vec<_>,_>>().map_err(grant_db)?;
 if grants.len()>cap{return Err(grant_error(ActionErrorCode::LimitExceeded,"This run has reached its action-access limit."));}
 if grants.iter().any(|grant|grant.run_id!=admission.scope.run_id||grant.granted_by!=admission.native.owner_person||grant.parent_grant_id.is_some()){return Err(kernel::denied());}Ok(grants)
}
fn account_rows(conn:&Connection,owner:&str)->Result<Vec<MetadataRecord>,ActionError>{
 let cap=crate::actions::schema::admission_rules().limits.grants_per_run;let limit=i64::try_from(cap.checked_add(1).ok_or_else(kernel::unavailable)?).map_err(|_|kernel::unavailable())?;
 let mut statement=conn.prepare("SELECT connection_id FROM managed_connections WHERE person=?1 ORDER BY connection_id LIMIT ?2").map_err(grant_db)?;
 let ids=statement.query_map(params![owner,limit],|row|crate::connections::metadata::bounded_text(row,"connection_id",crate::actions::native_rules::admission_rules().limits.identity_bytes)).map_err(grant_db)?.collect::<Result<Vec<_>,_>>().map_err(grant_db)?;
 if ids.len()>cap{return Err(grant_error(ActionErrorCode::LimitExceeded,"Managed-account choices exceed this view's limit."));}
 ids.into_iter().map(|id|account_metadata::load(conn,owner,&ConnectionId(id)).map_err(|_|kernel::unavailable())).collect()
}
fn usable_account(record:&MetadataRecord)->bool{
 let Some(account)=record.status.account.as_ref()else{return false;};let Some(reference)=record.reference.as_ref()else{return false;};
 record.status.health==ConnectionHealth::Ready&&!record.status.cleanup_pending&&record.active.is_none()&&account.issuer==crate::actions::github_issues::account_issuer()&&reference.account_id==account.account_id&&reference.issuer==account.issuer&&reference.subject==account.subject&&reference.secret_revision==record.status.secret_revision
}
fn grant_scope(grant:&AccountGrant)->Result<GrantInputView,ActionError>{match(grant.input_scope.as_str(),grant.input_digest.as_ref()){("all_valid_inputs",None)=>Ok(GrantInputView::AllValidInputs),("exact_canonical_input",Some(digest)) if digest.len()==64&&digest.bytes().all(|b|b.is_ascii_digit()||(b'a'..=b'f').contains(&b))=>Ok(GrantInputView::ExactCanonicalInput{input_digest:digest.clone()}),_=>Err(kernel::unavailable())}}
fn material_identity(record:&MetadataRecord)->Result<String,ActionError>{let account=record.status.account.as_ref().ok_or_else(kernel::denied)?;Ok(super::schema::digest(serde_json::to_string(&(&account.issuer,&account.subject)).map_err(|_|kernel::unavailable())?.as_bytes()))}
fn grant_available(grant:&AccountGrant,accounts:&[MetadataRecord])->Result<bool,ActionError>{
 let Some(record)=accounts.iter().find(|record|record.status.connection_id.0==grant.connection_id&&record.status.account.as_ref().is_some_and(|account|account.account_id.0==grant.account_id))else{return Ok(false);};
 if !usable_account(record){return Ok(false);}let account=record.status.account.as_ref().unwrap();
 let definition=match super::semantics::definition(&ActionId(grant.action_id.clone()),&DefinitionDigest(grant.definition_digest.clone())){Ok(definition)=>definition,Err(error) if matches!(error.code,ActionErrorCode::NotFound|ActionErrorCode::DefinitionMismatch)=>return Ok(false),Err(error)=>return Err(error)};
 let capabilities:Vec<String>=serde_json::from_str(&grant.capabilities_json).map_err(|_|kernel::unavailable())?;
 Ok(grant.connection_owner==grant.granted_by&&grant.account_revision==account.account_revision&&grant.revocation_generation==record.status.revocation_generation&&grant.account_identity_digest==material_identity(record)?&&capabilities.len()==definition.required_capabilities.len()&&capabilities.iter().all(|cap|definition.required_capabilities.contains(cap)))
}
fn read_rows(conn:&Connection,admission:&GrantAdmission<'_>)->Result<RunActionAccessView,ActionError>{
 check_admission(conn,admission)?;let grants=stored_grants(conn,admission)?;let accounts=account_rows(conn,&admission.native.owner_person)?;
 let definitions=crate::actions::compiled_catalog::compiled_catalog().map_err(|_|kernel::unavailable())?.definitions();
 let choices=accounts.iter().filter(|record|usable_account(record)).map(|record|{let account=record.status.account.as_ref().unwrap();Ok(RunActionAccountChoice{connection_id:record.status.connection_id.clone(),account_id:account.account_id.clone(),label:record.status.login.clone(),account_revision:SafeCounter::new(account.account_revision)?,revocation_generation:SafeCounter::new(record.status.revocation_generation)?})}).collect::<Result<Vec<_>,ActionError>>()?;
 let views=grants.iter().filter(|grant|grant.revoked_at.is_none()).map(|grant|Ok(RunActionGrantView{grant_id:grant.grant_id.clone(),revision:SafeCounter::new(grant.revision)?,connection_id:ConnectionId(grant.connection_id.clone()),account_id:AccountId(grant.account_id.clone()),action_id:ActionId(grant.action_id.clone()),definition_digest:DefinitionDigest(grant.definition_digest.clone()),input_scope:grant_scope(grant)?,available:grant_available(grant,&accounts)?})).collect::<Result<Vec<_>,ActionError>>()?;
 // Secret references are identifiers only and remain inside this hash. Never
 // resolve a credential or serialize these internal metadata rows into the DTO.
 let account_evidence=accounts.iter().map(|record|(&record.status,&record.reference,&record.active,record.observation_revision)).collect::<Vec<_>>();
 let revision=super::schema::digest(serde_json::to_string(&("cerebro.native-run-action-access",1,super::native_fingerprint(admission.native)?,&grants,account_evidence,&definitions)).map_err(|_|kernel::unavailable())?.as_bytes());
 Ok(RunActionAccessView{run_id:admission.scope.run_id.clone(),access_revision:revision,accounts:choices,definitions,grants:views,access_request_id:None})
}
struct Candidate{connection:String,account:String,identity:String,account_revision:u64,generation:u64,action:String,definition:String,input_scope:String,input_digest:Option<String>,capabilities:String}
impl Candidate{
 fn same(&self,grant:&AccountGrant)->bool{grant.revoked_at.is_none()&&grant.connection_id==self.connection&&grant.account_id==self.account&&grant.account_identity_digest==self.identity&&grant.account_revision==self.account_revision&&grant.revocation_generation==self.generation&&grant.action_id==self.action&&grant.definition_digest==self.definition&&grant.input_scope==self.input_scope&&grant.input_digest==self.input_digest&&grant.capabilities_json==self.capabilities&&grant.parent_grant_id.is_none()}
 fn key(&self)->(&str,&str,&str,&str,&str,&Option<String>){(&self.connection,&self.account,&self.action,&self.definition,&self.input_scope,&self.input_digest)}
}
fn candidate(conn:&Connection,admission:&GrantAdmission<'_>,selection:&RunActionSelection)->Result<Candidate,ActionError>{
 let definition=super::semantics::definition(&selection.action_id,&selection.definition_digest)?;
 let record=account_metadata::load(conn,&admission.native.owner_person,&selection.connection_id).map_err(|_|kernel::denied())?;
 if !usable_account(&record){return Err(kernel::denied());}let account=record.status.account.as_ref().unwrap();
 if selection.account_id!=account.account_id||selection.account_revision.get()!=account.account_revision||selection.revocation_generation.get()!=record.status.revocation_generation{return Err(kernel::denied());}
 let(input_scope,input_digest)=match &selection.input_scope{GrantInputSelection::AllValidInputs=>("all_valid_inputs".to_owned(),None),GrantInputSelection::ExactCanonicalInput{input}=>{let input=super::schema::validate_input(&definition,input)?;super::semantics::target(&definition,&input)?;("exact_canonical_input".into(),Some(input.digest))}};
 Ok(Candidate{connection:selection.connection_id.0.clone(),account:selection.account_id.0.clone(),identity:material_identity(&record)?,account_revision:account.account_revision,generation:record.status.revocation_generation,action:definition.action_id.0,definition:definition.definition_digest.0,input_scope,input_digest,capabilities:serde_json::to_string(&definition.required_capabilities).map_err(|_|kernel::unavailable())?})
}
fn replace_rows(conn:&Connection,admission:&GrantAdmission<'_>,request:&SetRunActionAccess)->Result<RunActionAccessView,ActionError>{
 let current=read_rows(conn,admission)?;
 if request.expected_access_revision!=current.access_revision{return Err(kernel::stale());}
 let cap=crate::actions::schema::admission_rules().limits.grants_per_run;if request.selections.len()>cap{return Err(grant_error(ActionErrorCode::LimitExceeded,"This run has too many action selections."));}
 let existing=stored_grants(conn,admission)?;let mut keep=BTreeSet::new();let mut insert=Vec::<Candidate>::new();
 for selection in &request.selections{match selection{
  RunActionGrantSelection::Preserve{grant_id,expected_revision}=>{
   let row=existing.iter().find(|row|row.grant_id==*grant_id&&row.revoked_at.is_none()).ok_or_else(kernel::denied)?;
   if row.revision!=expected_revision.get(){return Err(kernel::stale());}if !keep.insert(row.grant_id.clone()){return Err(grant_error(ActionErrorCode::InvalidInput,"An action grant was selected more than once."));}
  },
  RunActionGrantSelection::New{selection}=>{let candidate=candidate(conn,admission,selection)?;
   if insert.iter().any(|old|old.key()==candidate.key()){return Err(grant_error(ActionErrorCode::InvalidInput,"An action was selected more than once."));}
   if let Some(same)=existing.iter().find(|row|candidate.same(row)){if !keep.insert(same.grant_id.clone()){return Err(grant_error(ActionErrorCode::InvalidInput,"An action grant was selected more than once."));}}
   else{insert.push(candidate);}
  }
 }}
 if existing.len().checked_add(insert.len()).is_none_or(|count|count>cap){return Err(grant_error(ActionErrorCode::LimitExceeded,"This run has reached its action-access limit."));}
 let now=chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis,true);
 for row in existing.iter().filter(|row|row.revoked_at.is_none()&&!keep.contains(&row.grant_id)){
  let next=row.revision.checked_add(1).ok_or_else(kernel::unavailable)?;
  let changed=conn.execute("UPDATE action_account_grants SET revision=?1,revoked_at=?2 WHERE grant_id=?3 AND run_id=?4 AND revision=?5 AND revoked_at IS NULL",params![grant_integer(next)?,now,row.grant_id,admission.scope.run_id,grant_integer(row.revision)?]).map_err(grant_db)?;if changed!=1{return Err(kernel::stale());}
 }
 for row in insert{
  conn.execute("INSERT INTO action_account_grants(grant_id,run_id,connection_id,account_id,account_identity_digest,account_revision,revocation_generation,action_id,definition_digest,input_scope,input_digest,capabilities_json,parent_grant_id,revision,granted_by,granted_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,NULL,1,?13,?14)",params![crate::ledger::new_id128(),admission.scope.run_id,row.connection,row.account,row.identity,grant_integer(row.account_revision)?,grant_integer(row.generation)?,row.action,row.definition,row.input_scope,row.input_digest,row.capabilities,admission.native.owner_person,now]).map_err(grant_db)?;
 }
 read_rows(conn,admission)
}

fn change_owned(owner:&mut RuntimeOwner,operation:impl FnOnce(&Connection)->Result<RunActionAccessView,ActionError>)->GrantWriteOutcome{
 use super::super::super::{RuntimeTransactionOutcome,NativeOwnerError};
 let mut domain=None;
 match owner.classified_transaction(|conn|operation(conn).map_err(|error|{domain=Some(error);NativeOwnerError::Unavailable})){
  RuntimeTransactionOutcome::Committed(view)=>GrantWriteOutcome::Committed(view),
  RuntimeTransactionOutcome::NotCommitted(_)=>GrantWriteOutcome::NotCommitted(if owner.retired{kernel::unavailable()}else{domain.unwrap_or_else(kernel::unavailable)}),
  RuntimeTransactionOutcome::CommitUncertain=>GrantWriteOutcome::CommitUnknown,
 }
}
pub(in crate::actions::native_owner) fn read(app:&AppHandle,window:&WebviewWindow,run:u64)->Result<RunActionAccessView,ActionError>{
 let call=Origin::capture(app,window,run)?;
 let mut view=call.guarded(app,|owner,recheck|super::read_snapshot(owner,|read|{
  call.with_current_context(AuthorityDb::Retained(read),|_,scope,native|{
   let view=read_rows(read.conn,&GrantAdmission{conn:read.conn,scope,native})?;recheck()?;Ok(view)
  })
 }))?;
 // Control metadata is read after storage/current-origin guards are released.
 // It names only the same original native run's actual held access request.
 if let Some(agents)=app.try_state::<crate::agent::AgentState>(){view.access_request_id=agents.interactions().managed_access_request(&view.run_id);}
 Ok(view)
}
pub(in crate::actions::native_owner) fn set(app:&AppHandle,window:&WebviewWindow,run:u64,request:SetRunActionAccess)->SetRunActionAccessResult{
 let call=match Origin::capture(app,window,run){Ok(call)=>call,Err(error)=>return SetRunActionAccessResult::Refused{error}};
 let expected=request.expected_access_revision.clone();
 let result=call.guarded_rows(app,|owner,recheck|{
  let result=change_owned(owner,|conn|call.with_current_context(AuthorityDb::Writer(conn),|_,scope,native|{
   recheck()?;let view=replace_rows(conn,&GrantAdmission{conn,scope,native},&request)?;recheck()?;Ok(view)
  }));
  if let GrantWriteOutcome::Committed(view)=&result{
   if view.access_revision!=expected{call.owner().action_cancellations.cancel_run(&view.run_id);}
  }
  Ok(result)
 });
 match result{
  Ok((Ok(GrantWriteOutcome::Committed(mut view)),source_current))=>{
   // The actual original-run writer has returned a known commit. Never wake
   // a held request from NotCommitted, CommitUnknown, or a caller-supplied run.
   let mut request_closed=false;
   if let Some(agents)=app.try_state::<crate::agent::AgentState>(){
    let book=agents.interactions();
    if let Some(id)=request.complete_request_id.as_deref(){
     request_closed=book.complete_managed_access(&view.run_id,id);
     if request_closed{if let Origin::Attended(original)=&call{agents.publish_managed_closed(&original.origin.receipt,id);}}
    }
    view.access_request_id=book.managed_access_request(&view.run_id);
   }
   SetRunActionAccessResult::Changed{view,source_current,request_closed}
  },
  Ok((Ok(GrantWriteOutcome::NotCommitted(error)),_))|Ok((Err(error),_))|Err(error)=>SetRunActionAccessResult::Refused{error},
  Ok((Ok(GrantWriteOutcome::CommitUnknown),_))=>SetRunActionAccessResult::CommitUnknown{message:"Cerebro could not confirm this access change. Reload and review before trying again.".into()},
 }
}

#[cfg(all(test,target_os="macos"))]
#[path="native_action_grants_tests.rs"]
mod tests;

#[derive(serde::Serialize)]
#[serde(rename_all="camelCase")]
pub(super) struct CatalogBinding{pub(super) action_id:ActionId,pub(super) definition_digest:DefinitionDigest,pub(super) connection_id:ConnectionId,pub(super) account_id:AccountId,pub(super) label:String}
/// Same active retained snapshot as the catalog; not an authority constructor.
pub(super) fn catalog_bindings_rows(conn:&Connection,scope:&ActionSubjectView,native:&crate::runtime::native_runs::NativeRun)->Result<Vec<CatalogBinding>,ActionError>{
 let view=read_rows(conn,&GrantAdmission{conn,scope,native})?;
 let mut bindings=view.grants.into_iter().filter(|grant|grant.available).map(|grant|{
  let account=view.accounts.iter().find(|account|account.connection_id==grant.connection_id&&account.account_id==grant.account_id).ok_or_else(kernel::unavailable)?;
  Ok(CatalogBinding{action_id:grant.action_id,definition_digest:grant.definition_digest,connection_id:grant.connection_id,account_id:grant.account_id,label:account.label.clone()})
 }).collect::<Result<Vec<_>,ActionError>>()?;
 bindings.sort_by(|a,b|(&a.action_id.0,&a.definition_digest.0,&a.connection_id.0,&a.account_id.0).cmp(&(&b.action_id.0,&b.definition_digest.0,&b.connection_id.0,&b.account_id.0)));
 bindings.dedup_by(|a,b|a.action_id==b.action_id&&a.definition_digest==b.definition_digest&&a.connection_id==b.connection_id&&a.account_id==b.account_id);Ok(bindings)
}
