//! Transaction-owned durable workflow origin metadata. Rows are not authority.
//! Only the native owning start/resume service authenticates OpeningFacts inputs.
#![cfg_attr(not(test), expect(dead_code, reason = "native workflow producer follows causal row tests"))]
use crate::runtime::workflows as flow;
use rusqlite::Connection;
use serde::{Serialize,Deserialize};
#[derive(Debug,Clone,PartialEq,Eq,Serialize,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(super) struct AccountSelection {pub(super) connection:String,pub(super) account:String,pub(super) action:String,pub(super) definition:String,pub(super) capabilities:Vec<String>,pub(super) input_scope:String,pub(super) input_digest:Option<String>}
#[derive(Debug,Clone,PartialEq,Eq,Serialize,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(super) struct Permissions {pub(super) read_prefixes:Vec<String>,pub(super) query_records:bool,pub(super) accounts:Vec<AccountSelection>}
#[derive(Debug,Clone,PartialEq,Eq)]
pub(super) struct SelectorRequest {pub(super) step:String,pub(super) action:String,pub(super) definition:String,pub(super) connection:String,pub(super) account:String}
#[derive(Debug,Clone,PartialEq,Eq)]
pub(super) struct Selector {pub(super) step:String,pub(super) action:String,pub(super) definition:String,pub(super) connection:String,pub(super) account:String,pub(super) snapshot:String}
#[derive(Clone,Copy)]
pub(super) struct OpeningFacts<'a> {pub(super) owner:&'a str,pub(super) vault:&'a str,pub(super) store:&'a str,pub(super) canonical_vault:&'a str,pub(super) session:&'a str,pub(super) process:&'a str}
pub(super) struct Start<'a> {pub(super) key:&'a str,pub(super) workflow:&'a str,pub(super) version:&'a str,pub(super) schema:&'a str,pub(super) input:&'a str,pub(super) configuration:&'a str,pub(super) permissions:&'a Permissions,pub(super) selectors:&'a [SelectorRequest],pub(super) entry:&'a str,pub(super) steps:&'a [flow::Step<'a>],pub(super) now:chrono::DateTime<chrono::Utc>}
#[derive(Debug,Clone,PartialEq,Eq)]
pub(super) struct Origin {pub(super) flow_run:String,pub(super) native_run:String,pub(super) actor:String,pub(super) authority:String,pub(super) configuration:String,pub(super) version:String,pub(super) epoch:u64,pub(super) original:Permissions,pub(super) current:Permissions}
#[derive(Debug,PartialEq,Eq)]
pub(super) enum Started {New(Origin),Observed(Origin)}

use rusqlite::{params,OptionalExtension};
use crate::actions::{schema,read_types::{ActionId,DefinitionDigest,ActionSubjectView},native_db::AuthorityDb,native_lineage,native_authority::{ScopedCatalog,CatalogExecution}};
use std::collections::BTreeSet;
fn db(_:rusqlite::Error)->flow::Error{flow::Error::Unavailable}
fn stamp(now:chrono::DateTime<chrono::Utc>)->String{now.to_rfc3339_opts(chrono::SecondsFormat::Millis,true)}
fn hex(value:&str,n:usize)->bool{value.len()==n&&value.bytes().all(|b|b.is_ascii_digit()||(b'a'..=b'f').contains(&b))}
fn text(value:&str,max:usize)->bool{!value.is_empty()&&value.len()<=max&&!value.chars().any(char::is_control)}
fn integer(value:u64)->Result<i64,flow::Error>{if value>9_007_199_254_740_991{return Err(flow::Error::Invalid);}i64::try_from(value).map_err(|_|flow::Error::Invalid)}
fn counter(row:&rusqlite::Row<'_>,column:usize)->rusqlite::Result<u64>{let raw:i64=row.get(column)?;u64::try_from(raw).ok().filter(|v|(1..=9_007_199_254_740_991).contains(v)).ok_or(rusqlite::Error::InvalidQuery)}
fn guarded(conn:&Connection,facts:OpeningFacts<'_>)->Result<(),flow::Error>{
 if conn.is_autocommit(){return Err(flow::Error::Unavailable);}
 if facts.owner!=crate::actions::native_rules::admission_rules().owner_storage_key{return Err(flow::Error::Denied);}
 if !hex(facts.vault,32)||!text(facts.store,128)||!text(facts.canonical_vault,4096)||!facts.canonical_vault.starts_with('/')||!text(facts.session,1024)||!text(facts.process,1024){return Err(flow::Error::Invalid);}Ok(())
}
fn session_open(conn:&Connection,facts:OpeningFacts<'_>)->Result<(),flow::Error>{
 let found:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM app_sessions s JOIN vault_registry v ON v.vault_id=s.vault_id WHERE s.session_id=?1 AND s.vault_id=?2 AND s.store_uuid=?3 AND s.close_precision='open' AND v.vault_path=?4)",params![facts.session,facts.vault,facts.store,facts.canonical_vault],|r|r.get(0)).map_err(db)?;
 if !found{return Err(flow::Error::Denied);}Ok(())
}
pub(super) fn permission_bytes(value:&Permissions)->Result<String,flow::Error>{
 let limits=flow::origin_policy();
 if value.read_prefixes.len()>limits.read_prefixes||value.accounts.len()>limits.account_grants{return Err(flow::Error::Capacity);}
 let mut prefixes=BTreeSet::new();
 for path in &value.read_prefixes {
  // Empty *element* is an explicit whole-vault selection in the existing MCP
  // grammar. Empty vector remains deny-all; no absence is promoted to it.
  if path.len()>4096||path.starts_with('/')||path.contains('\\')||path.chars().any(char::is_control)||(!path.is_empty()&&path.split('/').any(|part|part.is_empty()||matches!(part,"."|"..")))||!prefixes.insert(path){return Err(flow::Error::Invalid);}
 }
 let mut accounts=BTreeSet::new();
 for account in &value.accounts {
  if !text(&account.connection,128)||!text(&account.account,128)||!text(&account.action,128)||!hex(&account.definition,64)||!matches!(account.input_scope.as_str(),"all_valid_inputs"|"exact_canonical_input")||(account.input_scope=="exact_canonical_input")!=account.input_digest.is_some()||account.input_digest.as_ref().is_some_and(|s|!hex(s,64))||account.capabilities.is_empty()||account.capabilities.len()>crate::actions::schema::admission_rules().limits.grant_capabilities||account.capabilities.iter().any(|s|!text(s,128))||account.capabilities.windows(2).any(|p|p[0]>=p[1])||!accounts.insert((&account.connection,&account.account,&account.action,&account.definition)){return Err(flow::Error::Invalid);}
 }
 let bytes=serde_json::to_string(value).map_err(|_|flow::Error::Invalid)?;
 if bytes.len()>limits.permission_bytes{return Err(flow::Error::Capacity);}Ok(bytes)
}
fn narrower(original:&Permissions,current:&Permissions)->bool{
 (!current.query_records||original.query_records)
 &&current.read_prefixes.iter().all(|path|crate::mcp::scope_admits(&Some(original.read_prefixes.clone()),path))
 &&current.accounts.iter().all(|item|original.accounts.iter().any(|old|old.connection==item.connection&&old.account==item.account&&old.action==item.action&&old.definition==item.definition&&item.capabilities.iter().all(|c|old.capabilities.contains(c))&&(old.input_scope=="all_valid_inputs"||old.input_scope==item.input_scope&&old.input_digest==item.input_digest)))
}
fn selectors_input(value:&[SelectorRequest],steps:&[flow::Step<'_>])->Result<String,flow::Error>{
 if value.len()>flow::definition_step_limit(){return Err(flow::Error::Capacity);}
 let mut seen=BTreeSet::new();
 for selector in value {
  if !seen.insert(&selector.step)||!text(&selector.step,128)||!text(&selector.action,128)||!hex(&selector.definition,64)||!text(&selector.connection,128)||!text(&selector.account,128)||!steps.iter().any(|step|step.id==selector.step&&step.kind==flow::Kind::Action){return Err(flow::Error::Invalid);}
  crate::actions::compiled_catalog::compiled_catalog().map_err(|_|flow::Error::Unavailable)?.resolve(&ActionId(selector.action.clone()),&DefinitionDigest(selector.definition.clone())).map_err(|_|flow::Error::Denied)?;
 }
 if steps.iter().filter(|s|s.kind==flow::Kind::Action).count()!=value.len(){return Err(flow::Error::Invalid);}
 let tuples:Vec<_>=value.iter().map(|s|(&s.step,&s.action,&s.definition,&s.connection,&s.account)).collect();serde_json::to_string(&tuples).map_err(|_|flow::Error::Invalid)
}
fn subject(facts:OpeningFacts<'_>,origin:&Origin)->ActionSubjectView{ActionSubjectView{vault_id:facts.vault.into(),run_id:origin.native_run.clone(),actor_id:origin.actor.clone(),client_id:None,child_job_id:None}}
fn scope<'a>(facts:OpeningFacts<'a>,origin:&'a Origin)->flow::Scope<'a>{flow::Scope{owner:facts.owner,vault:facts.vault,store:facts.store,actor:&origin.actor}}

struct Stored {origin:Origin,revoked:bool,session:String,process:String}
fn load(conn:&Connection,facts:OpeningFacts<'_>,run:&str)->Result<Stored,flow::Error>{
 guarded(conn,facts)?;
 let row=conn.query_row("SELECT workflow_run_id,native_run_id,actor_id,authority_id,configuration_digest,definition_hash,admission_epoch,original_permissions_json,current_permissions_json,permission_digest,current_permission_digest,owner_person,vault_id,store_uuid,canonical_vault_path,creation_session_id,admission_session_id,admission_process_id,revoked_at IS NOT NULL FROM workflow_run_origins WHERE workflow_run_id=?1",[run],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,String>(4)?,r.get::<_,String>(5)?,counter(r,6)?,r.get::<_,String>(7)?,r.get::<_,String>(8)?,r.get::<_,String>(9)?,r.get::<_,String>(10)?,r.get::<_,String>(11)?,r.get::<_,String>(12)?,r.get::<_,String>(13)?,r.get::<_,String>(14)?,r.get::<_,String>(15)?,r.get::<_,String>(16)?,r.get::<_,String>(17)?,r.get::<_,bool>(18)?))).optional().map_err(db)?.ok_or(flow::Error::Denied)?;
 let (flow_run,native_run,actor,authority,configuration,version,epoch,original_bytes,current_bytes,original_digest,current_digest,owner,vault,store,path,creation,session,process,revoked)=row;
 if owner!=facts.owner||vault!=facts.vault||store!=facts.store||path!=facts.canonical_vault{return Err(flow::Error::Denied);}
 let original:Permissions=serde_json::from_str(&original_bytes).map_err(|_|flow::Error::Unavailable)?;
 let current:Permissions=serde_json::from_str(&current_bytes).map_err(|_|flow::Error::Unavailable)?;
 if permission_bytes(&original)?!=original_bytes||permission_bytes(&current)?!=current_bytes||schema::digest(original_bytes.as_bytes())!=original_digest||schema::digest(current_bytes.as_bytes())!=current_digest||!narrower(&original,&current){return Err(flow::Error::Unavailable);}
 let origin=Origin{flow_run,native_run,actor,authority,configuration,version,epoch,original,current};
 let native=native_lineage::load_run(AuthorityDb::Writer(conn),&origin.native_run).map_err(|_|flow::Error::Unavailable)?;
 let scope=scope(facts,&origin);let current_run=flow::inspect_rows(conn,scope,&origin.flow_run)?;
 let (act_scope,act_run,config,grants):(Option<String>,Option<String>,String,String)=conn.query_row("SELECT act_scope_digest,act_run_id,configuration_digest,grant_digest FROM workflow_runs WHERE run_id=?1",[&origin.flow_run],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).map_err(db)?;
 let expected_scope=crate::actions::effect_record::scope_key(&subject(facts,&origin)).map_err(|_|flow::Error::Unavailable)?;
 if native.run_id!=origin.native_run||native.authority_id!=origin.authority||native.revision!=1||native.vault_id!=vault||native.store_uuid!=store||native.owner_person!=owner||native.actor_id!=origin.actor||origin.actor!=format!("workflow:{}",origin.native_run)||native.source_kind!="attended_operation"||native.app_session_id!=creation||native.canonical_vault_path!=path||native.vault_path!=path||native.actual_vault.as_deref()!=Some(vault.as_str())||native.actual_store.as_deref()!=Some(store.as_str())||native.actual_actor.as_deref()!=Some(origin.actor.as_str())||native.cli_session_id.is_some()||native.actual_cli.is_some()||native.parent_run_id.is_some()||native.actual_parent.is_some()||native.client_id.is_some()||native.child_job_id.is_some()||act_scope.as_deref()!=Some(expected_scope.as_str())||act_run.as_deref()!=Some(origin.native_run.as_str())||config!=origin.configuration||grants!=original_digest||current_run.version!=origin.version{return Err(flow::Error::Denied);}
 if !matches!(current_run.state.as_str(),"succeeded"|"failed"|"cancelled")&&(native.outcome!="running"||native.ended_at.is_some()||native.close_kind.is_some()){return Err(flow::Error::Denied);}
 Ok(Stored{origin,revoked,session,process})
}
struct GrantMaterial {selection:AccountSelection,identity:String,account_revision:u64,revocation_generation:u64}
fn grant_material(conn:&Connection,facts:OpeningFacts<'_>,selected:&AccountSelection)->Result<GrantMaterial,flow::Error>{
 use crate::connections::{account_metadata,metadata::ConnectionHealth};
 let metadata=account_metadata::load(conn,facts.owner,&crate::actions::ids::ConnectionId(selected.connection.clone())).map_err(|error|if error==crate::connections::metadata::ConnectionError::NotFound{flow::Error::Denied}else{flow::Error::Unavailable})?;
 let account=metadata.status.account.as_ref().ok_or(flow::Error::Denied)?;
 let reference=metadata.reference.as_ref().ok_or(flow::Error::Denied)?;
 let definition=crate::actions::compiled_catalog::compiled_catalog().map_err(|_|flow::Error::Unavailable)?.resolve(&ActionId(selected.action.clone()),&DefinitionDigest(selected.definition.clone())).map_err(|_|flow::Error::Denied)?;
 if account.issuer!=crate::actions::github_issues::account_issuer()||metadata.status.health!=ConnectionHealth::Ready||metadata.status.cleanup_pending||metadata.active.is_some()||account.account_id.0!=selected.account||reference.account_id!=account.account_id||reference.issuer!=account.issuer||reference.subject!=account.subject||reference.secret_revision!=metadata.status.secret_revision||!definition.required_capabilities.iter().all(|c|selected.capabilities.contains(c))||!selected.capabilities.iter().all(|c|definition.required_capabilities.contains(c)){return Err(flow::Error::Denied);}
 let identity=schema::digest(serde_json::to_string(&(&account.issuer,&account.subject)).map_err(|_|flow::Error::Unavailable)?.as_bytes());
 Ok(GrantMaterial{selection:selected.clone(),identity,account_revision:account.account_revision,revocation_generation:metadata.status.revocation_generation})
}

/// Enable-time identity pins are finite metadata, not grants. Refuse current
/// account recapture before the existing single grant/snapshot producer runs.
fn check_activation_pins(conn:&Connection,activation:&str,epoch:&str,materials:&[GrantMaterial])->Result<(),flow::Error>{
 let mut selected=BTreeSet::new();
 for material in materials{let s=&material.selection;selected.insert((&s.connection,&s.account));}
 let count:i64=conn.query_row("SELECT count(*) FROM workflow_activation_accounts WHERE activation_id=?1 AND epoch=?2",params![activation,epoch],|row|row.get(0)).map_err(db)?;
 if usize::try_from(count).map_err(|_|flow::Error::Unavailable)?!=selected.len(){return Err(flow::Error::Denied);}
 for material in materials{
  let s=&material.selection;
  let pin:Option<(String,i64,i64)>=conn.query_row("SELECT account_identity_digest,account_revision,revocation_generation FROM workflow_activation_accounts WHERE activation_id=?1 AND epoch=?2 AND connection_id=?3 AND account_id=?4",params![activation,epoch,s.connection,s.account],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?))).optional().map_err(db)?;
  if pin!=Some((material.identity.clone(),integer(material.account_revision)?,integer(material.revocation_generation)?)){return Err(flow::Error::Denied);}
 }Ok(())
}
fn issue_grants(conn:&Connection,facts:OpeningFacts<'_>,native:&str,materials:&[GrantMaterial],now:chrono::DateTime<chrono::Utc>)->Result<Vec<String>,flow::Error>{
 let mut ids=Vec::new();
 for material in materials {let selected=&material.selection;let id=crate::ledger::new_id128();let capabilities=serde_json::to_string(&selected.capabilities).map_err(|_|flow::Error::Invalid)?;
  conn.execute("INSERT INTO action_account_grants(grant_id,run_id,connection_id,account_id,account_identity_digest,account_revision,revocation_generation,action_id,definition_digest,input_scope,input_digest,capabilities_json,parent_grant_id,revision,granted_by,granted_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,NULL,1,?13,?14)",params![id,native,selected.connection,selected.account,material.identity,integer(material.account_revision)?,integer(material.revocation_generation)?,selected.action,selected.definition,selected.input_scope,selected.input_digest,capabilities,facts.owner,stamp(now)]).map_err(db)?;ids.push(id);
 }Ok(ids)
}
fn verify_current_grants(conn:&Connection,facts:OpeningFacts<'_>,origin:&Origin,current:&Permissions)->Result<(),flow::Error>{
 for selected in &current.accounts {
  let material=grant_material(conn,facts,selected)?;
  let (identity,revision,generation,capabilities,input_scope,input_digest,revoked):(String,i64,i64,String,String,Option<String>,bool)=conn.query_row("SELECT g.account_identity_digest,g.account_revision,g.revocation_generation,g.capabilities_json,g.input_scope,g.input_digest,g.revoked_at IS NOT NULL FROM workflow_origin_account_grants w JOIN action_account_grants g ON g.grant_id=w.grant_id WHERE w.workflow_run_id=?1 AND g.run_id=?2 AND g.connection_id=?3 AND g.account_id=?4 AND g.action_id=?5 AND g.definition_digest=?6 AND g.granted_by=?7 AND g.parent_grant_id IS NULL",params![origin.flow_run,origin.native_run,selected.connection,selected.account,selected.action,selected.definition,facts.owner],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?))).optional().map_err(db)?.ok_or(flow::Error::Denied)?;
  let capabilities:Vec<String>=serde_json::from_str(&capabilities).map_err(|_|flow::Error::Unavailable)?;
  if revoked||identity!=material.identity||revision!=integer(material.account_revision)?||generation!=integer(material.revocation_generation)?||!selected.capabilities.iter().all(|c|capabilities.contains(c))||!(input_scope=="all_valid_inputs"||input_scope==selected.input_scope&&input_digest==selected.input_digest){return Err(flow::Error::Denied);}
 }Ok(())
}

fn saved_selectors(conn:&Connection,origin:&Origin)->Result<Vec<Selector>,flow::Error>{
 let cap=flow::definition_step_limit();let limit=i64::try_from(cap.checked_add(1).ok_or(flow::Error::Unavailable)?).map_err(|_|flow::Error::Unavailable)?;
 let mut statement=conn.prepare("SELECT step_id,action_id,definition_digest,connection_id,account_id,snapshot_digest,configuration_digest FROM workflow_run_action_selectors WHERE workflow_run_id=?1 ORDER BY step_id LIMIT ?2").map_err(db)?;
 let rows=statement.query_map(params![origin.flow_run,limit],|r|Ok((Selector{step:r.get(0)?,action:r.get(1)?,definition:r.get(2)?,connection:r.get(3)?,account:r.get(4)?,snapshot:r.get(5)?},r.get::<_,String>(6)?))).map_err(db)?.collect::<Result<Vec<_>,_>>().map_err(db)?;
 if rows.len()>cap||rows.iter().any(|(row,config)|config!=&origin.configuration||!hex(&row.snapshot,64)){return Err(flow::Error::Unavailable);}
 let rows:Vec<_>=rows.into_iter().map(|(s,_)|s).collect();
 let tuples:Vec<_>=rows.iter().map(|s|(&s.step,&s.action,&s.definition,&s.connection,&s.account,&s.snapshot,&origin.configuration)).collect();
 let digest=schema::digest(serde_json::to_string(&tuples).map_err(|_|flow::Error::Unavailable)?.as_bytes());
 let expected:String=conn.query_row("SELECT selector_digest FROM workflow_run_origins WHERE workflow_run_id=?1",[&origin.flow_run],|r|r.get(0)).map_err(db)?;
 if digest!=expected{return Err(flow::Error::Unavailable);}Ok(rows)
}
pub(super) fn inspect_rows(conn:&Connection,facts:OpeningFacts<'_>,run:&str)->Result<Origin,flow::Error>{let stored=load(conn,facts,run)?;saved_selectors(conn,&stored.origin)?;Ok(stored.origin)}
pub(super) fn selector_rows(conn:&Connection,facts:OpeningFacts<'_>,run:&str,step:&str)->Result<Selector,flow::Error>{let stored=load(conn,facts,run)?;saved_selectors(conn,&stored.origin)?.into_iter().find(|s|s.step==step).ok_or(flow::Error::MissingValue)}
pub(super) fn start_rows(conn:&Connection,facts:OpeningFacts<'_>,start:Start<'_>)->Result<Started,flow::Error>{
 start_with_cause_rows(conn,facts,start,crate::runtime::dispatch::WorkflowOperationCause::Manual)
}
/// Native schedule coordinator supplies original occurrence metadata only. The
/// same start writer below still owns all grants, snapshots and native/FLOW rows.
pub(super) fn start_scheduled_rows(conn:&Connection,facts:OpeningFacts<'_>,start:Start<'_>,activation:&str,epoch:&str,occurrence:&str,due:chrono::DateTime<chrono::Utc>)->Result<Started,flow::Error>{
 start_with_cause_rows(conn,facts,start,crate::runtime::dispatch::WorkflowOperationCause::Schedule{activation,epoch,occurrence,due})
}
fn start_with_cause_rows(conn:&Connection,facts:OpeningFacts<'_>,start:Start<'_>,cause:crate::runtime::dispatch::WorkflowOperationCause<'_>)->Result<Started,flow::Error>{
 guarded(conn,facts)?;session_open(conn,facts)?;
 let permission_bytes=permission_bytes(start.permissions)?;let permission_digest=schema::digest(permission_bytes.as_bytes());
 let mut selectors=start.selectors.to_vec();selectors.sort_by(|a,b|a.step.cmp(&b.step));
 let selector_bytes=selectors_input(&selectors,start.steps)?;
 if !hex(start.key,32)||!hex(start.configuration,64){return Err(flow::Error::Invalid);}
 // The key is looked up before any actor/native identity is minted. A run
 // without its exact workflow origin cannot be adopted or backfilled.
 let existing:Option<String>=conn.query_row("SELECT run_id FROM workflow_runs WHERE owner_person=?1 AND vault_id=?2 AND store_uuid=?3 AND start_key=?4",params![facts.owner,facts.vault,facts.store,start.key],|r|r.get(0)).optional().map_err(db)?;
 if let Some(id)=existing {
  let old=load(conn,facts,&id)?;let saved=saved_selectors(conn,&old.origin)?;
  let recorded:String=conn.query_row("SELECT cause FROM runs WHERE run_id=?1",[&old.origin.native_run],|row|row.get(0)).map_err(db)?;
  if recorded!=cause.recorded(start.workflow).map_err(|_|flow::Error::Invalid)?.to_column(){return Err(flow::Error::Conflict); }
  let saved_tuples:Vec<_>=saved.iter().map(|s|(&s.step,&s.action,&s.definition,&s.connection,&s.account)).collect();
  if old.origin.original!=*start.permissions||old.origin.configuration!=start.configuration||serde_json::to_string(&saved_tuples).map_err(|_|flow::Error::Unavailable)?!=selector_bytes{return Err(flow::Error::Conflict);}
  let subject=subject(facts,&old.origin);let act_scope=crate::actions::effect_record::scope_key(&subject).map_err(|_|flow::Error::Unavailable)?;
  let observed=flow::start_rows(conn,scope(facts,&old.origin),flow::Start{key:start.key,workflow:start.workflow,version:start.version,schema_digest:start.schema,input:start.input,configuration:start.configuration,grants:&permission_digest,act_scope:Some(&act_scope),act_run:Some(&old.origin.native_run),entry:start.entry,steps:start.steps,now:start.now.timestamp_millis()})?;
  if !matches!(observed,flow::Started::Observed(_)){return Err(flow::Error::Unavailable);}return Ok(Started::Observed(old.origin));
 }
 selected_accounts_match(start.permissions,&selectors)?;
 let materials=start.permissions.accounts.iter().map(|a|grant_material(conn,facts,a)).collect::<Result<Vec<_>,_>>()?;
 if let crate::runtime::dispatch::WorkflowOperationCause::Schedule{activation,epoch,..}=cause{
  check_activation_pins(conn,activation,epoch,&materials)?;
 }
 let native=crate::ledger::new_id128();let authority=crate::ledger::new_id128();let actor=format!("workflow:{native}");
 crate::runtime::dispatch::begin_workflow_operation_rows(conn,&native,facts.vault,facts.store,&actor,start.workflow,cause,start.now).map_err(|_|flow::Error::Unavailable)?;
 let binding=native_lineage::NativeBinding{run_id:&native,vault_id:facts.vault,store_uuid:facts.store,canonical_vault:std::path::Path::new(facts.canonical_vault),owner_person:facts.owner,actor_id:&actor,source_kind:"attended_operation",app_session_id:facts.session,cli_session_id:None,parent_run_id:None,client_id:None,child_job_id:None};
 native_lineage::insert_if_absent(conn,&binding,&authority,&stamp(start.now)).map_err(|_|flow::Error::Unavailable)?;
 let admitted=native_lineage::resolve_lineage(AuthorityDb::Writer(conn),&binding,false).map_err(|_|flow::Error::Denied)?;
 if !admitted.can_call||admitted.row.authority_id!=authority{return Err(flow::Error::Denied);}
 let grants=issue_grants(conn,facts,&native,&materials,start.now)?;
 let subject=ActionSubjectView{vault_id:facts.vault.into(),run_id:native.clone(),actor_id:actor.clone(),client_id:None,child_job_id:None};
 // Capture once, after the original scope and validated explicit grants exist.
 // No caller snapshot or fresh catalog read is used to reconstruct a replay.
 let snapshot=ScopedCatalog{catalog:crate::actions::compiled_catalog::compiled_catalog().map_err(|_|flow::Error::Unavailable)?,scope:&subject,owner:facts.owner,execution:CatalogExecution::NoExecutor}.catalog(AuthorityDb::Writer(conn),None).map_err(|_|flow::Error::Unavailable)?.snapshot_digest.0;
 let frozen_tuples:Vec<_>=selectors.iter().map(|s|(&s.step,&s.action,&s.definition,&s.connection,&s.account,&snapshot,start.configuration)).collect();
 let selector_digest=schema::digest(serde_json::to_string(&frozen_tuples).map_err(|_|flow::Error::Unavailable)?.as_bytes());
 let act_scope=crate::actions::effect_record::scope_key(&subject).map_err(|_|flow::Error::Unavailable)?;
 let flow::Started::New(run)=flow::start_rows(conn,flow::Scope{owner:facts.owner,vault:facts.vault,store:facts.store,actor:&actor},flow::Start{key:start.key,workflow:start.workflow,version:start.version,schema_digest:start.schema,input:start.input,configuration:start.configuration,grants:&permission_digest,act_scope:Some(&act_scope),act_run:Some(&native),entry:start.entry,steps:start.steps,now:start.now.timestamp_millis()})?else{return Err(flow::Error::Conflict);};
 conn.execute("INSERT INTO workflow_run_origins(workflow_run_id,native_run_id,authority_id,owner_person,vault_id,store_uuid,canonical_vault_path,actor_id,configuration_digest,definition_hash,permission_digest,selector_digest,original_permissions_json,current_permissions_json,current_permission_digest,creation_session_id,admission_session_id,admission_process_id,admission_epoch,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?13,?11,?14,?14,?15,1,?16,?16)",params![run.id,native,authority,facts.owner,facts.vault,facts.store,facts.canonical_vault,actor,start.configuration,start.version,permission_digest,selector_digest,permission_bytes,facts.session,facts.process,stamp(start.now)]).map_err(db)?;
 for selector in selectors {conn.execute("INSERT INTO workflow_run_action_selectors(workflow_run_id,step_id,action_id,definition_digest,connection_id,account_id,snapshot_digest,configuration_digest) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",params![run.id,selector.step,selector.action,selector.definition,selector.connection,selector.account,snapshot,start.configuration]).map_err(db)?;}
 for grant in grants {conn.execute("INSERT INTO workflow_origin_account_grants(workflow_run_id,grant_id) VALUES(?1,?2)",params![run.id,grant]).map_err(db)?;}
 inspect_rows(conn,facts,&run.id).map(Started::New)
}
pub(super) fn reauthorize_rows(conn:&Connection,facts:OpeningFacts<'_>,run:&str,expected:u64,current:&Permissions,now:chrono::DateTime<chrono::Utc>)->Result<Origin,flow::Error>{
 let old=load(conn,facts,run)?;session_open(conn,facts)?;
 if old.origin.epoch!=expected{return Err(flow::Error::Stale);}if old.revoked{return Err(flow::Error::Denied);}
 let current_bytes=permission_bytes(current)?;
 if !narrower(&old.origin.original,current)||!narrower(&old.origin.current,current){return Err(flow::Error::Denied);}
 let flow=flow::inspect_rows(conn,scope(facts,&old.origin),run)?;
 if flow.cancel_requested||matches!(flow.state.as_str(),"succeeded"|"failed"|"cancelled"){return Err(flow::Error::Denied);}
 verify_current_grants(conn,facts,&old.origin,current)?;saved_selectors(conn,&old.origin)?;
 let next=expected.checked_add(1).ok_or(flow::Error::Unavailable)?;
 let changed=conn.execute("UPDATE workflow_run_origins SET current_permissions_json=?2,current_permission_digest=?3,admission_session_id=?4,admission_process_id=?5,admission_epoch=?6,updated_at=?7 WHERE workflow_run_id=?1 AND admission_epoch=?8 AND revoked_at IS NULL",params![run,current_bytes,schema::digest(current_bytes.as_bytes()),facts.session,facts.process,integer(next)?,stamp(now),integer(expected)?]).map_err(db)?;
 if changed!=1{return Err(flow::Error::Stale);}inspect_rows(conn,facts,run)
}
pub(super) fn revoke_rows(conn:&Connection,facts:OpeningFacts<'_>,run:&str,expected:u64,now:chrono::DateTime<chrono::Utc>)->Result<Origin,flow::Error>{
 let old=load(conn,facts,run)?;session_open(conn,facts)?;
 if old.origin.epoch!=expected{return Err(flow::Error::Stale);}if old.revoked{return Ok(old.origin);}
 let next=expected.checked_add(1).ok_or(flow::Error::Unavailable)?;
 let changed=conn.execute("UPDATE workflow_run_origins SET admission_epoch=?2,revoked_at=?3,updated_at=?3 WHERE workflow_run_id=?1 AND admission_epoch=?4 AND revoked_at IS NULL",params![run,integer(next)?,stamp(now),integer(expected)?]).map_err(db)?;
 if changed!=1{return Err(flow::Error::Stale);}
 conn.execute("UPDATE action_account_grants SET revoked_at=?2,revision=revision+1 WHERE run_id=?1 AND grant_id IN (SELECT grant_id FROM workflow_origin_account_grants WHERE workflow_run_id=?3) AND revoked_at IS NULL",params![old.origin.native_run,stamp(now),run]).map_err(db)?;
 inspect_rows(conn,facts,run)
}

/// Operation data only. The native host authenticates OpeningFacts and retains
/// the owning transaction; neither this enum nor the returned Origin is a permit.
#[derive(Clone,Copy)]
pub(super) enum CurrentUse<'a> {QueryRecords,Action{step:&'a str,input_digest:&'a str}}
/// Current identity metadata only. The native producer still holds its real
/// opening/store/window/runtime guards; no capability escapes this row check.
pub(super) fn admission_rows(conn:&Connection,facts:OpeningFacts<'_>,run:&str,expected:u64)->Result<Origin,flow::Error>{
 let stored=load(conn,facts,run)?;
 if stored.origin.epoch!=expected{return Err(flow::Error::Stale);}
 if stored.revoked||stored.session!=facts.session||stored.process!=facts.process{return Err(flow::Error::Denied);}
 session_open(conn,facts)?;
 let state=flow::inspect_rows(conn,scope(facts,&stored.origin),run)?;
 if state.cancel_requested||matches!(state.state.as_str(),"succeeded"|"failed"|"cancelled"){return Err(flow::Error::Denied);}
 saved_selectors(conn,&stored.origin)?;
 Ok(stored.origin)
}
pub(super) fn current_rows(conn:&Connection,facts:OpeningFacts<'_>,run:&str,expected:u64,operation:CurrentUse<'_>)->Result<Origin,flow::Error>{
 let origin=admission_rows(conn,facts,run,expected)?;
 match operation {
  CurrentUse::QueryRecords=>{
   if !origin.current.query_records||origin.current.read_prefixes.is_empty(){return Err(flow::Error::Denied);}
  }
  CurrentUse::Action{step,input_digest}=>{
   selected_action_rows(conn,facts,&origin,step,input_digest)?;
  }
 }
 Ok(origin)
}

/// Selection classification only, independent of admission session freshness.
/// This never authorizes dispatch; current_rows still requires admission first.
fn selected_action_rows(conn:&Connection,facts:OpeningFacts<'_>,origin:&Origin,step:&str,input_digest:&str)->Result<(),flow::Error>{
   if !hex(input_digest,64){return Err(flow::Error::Invalid);}
   let selector=saved_selectors(conn,origin)?.into_iter().find(|selector|selector.step==step).ok_or(flow::Error::Denied)?;
   let selected=origin.current.accounts.iter().find(|selected|selected.connection==selector.connection&&selected.account==selector.account&&selected.action==selector.action&&selected.definition==selector.definition&&(selected.input_scope=="all_valid_inputs"||selected.input_digest.as_deref()==Some(input_digest))).ok_or(flow::Error::Denied)?;
   // Original grant rows intentionally persist. Revalidate only the selected
   // current permission against those rows and live account metadata.
   let selected_only=Permissions{read_prefixes:vec![],query_records:false,accounts:vec![selected.clone()]};
   verify_current_grants(conn,facts,origin,&selected_only)?;
 Ok(())
}
/// A historical receipt may be discarded after explicit loss of its selected
/// use. A closed session is separately deferred by the native history adapter.
pub(super) fn receipt_use_rows(conn:&Connection,facts:OpeningFacts<'_>,run:&str,step:&str,input_digest:&str)->Result<bool,flow::Error>{
 let stored=load(conn,facts,run)?;
 saved_selectors(conn,&stored.origin)?;
 if stored.revoked{return Ok(false);}
 match selected_action_rows(conn,facts,&stored.origin,step,input_digest){
  Ok(())=>Ok(true),Err(flow::Error::Denied)=>Ok(false),Err(error)=>Err(error)
 }
}

#[cfg(test)]
#[path="native_workflow_rows_tests.rs"]
mod tests;

fn selected_accounts_match(permissions:&Permissions,selectors:&[SelectorRequest])->Result<(),flow::Error>{
 if permissions.accounts.iter().any(|a|!selectors.iter().any(|s|s.action==a.action&&s.definition==a.definition&&s.connection==a.connection&&s.account==a.account)){return Err(flow::Error::Denied);}Ok(())
}
/// Selection bytes only. Genuine native Enable owns the opening and definition;
/// no definition declaration is promoted into an account permission.
pub(super) fn activation_selection_rows(conn:&Connection,facts:OpeningFacts<'_>,permissions:&Permissions,selectors:&[SelectorRequest],steps:&[flow::Step<'_>])->Result<String,flow::Error>{
 guarded(conn,facts)?;session_open(conn,facts)?;
 let bytes=permission_bytes(permissions)?;selectors_input(selectors,steps)?;selected_accounts_match(permissions,selectors)?;Ok(bytes)
}
fn activation_material_rows(conn:&Connection,facts:OpeningFacts<'_>,activation:&str,epoch:&str,permissions:&Permissions)->Result<Vec<GrantMaterial>,flow::Error>{
 guarded(conn,facts)?;session_open(conn,facts)?;let bytes=permission_bytes(permissions)?;
 let exact:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM workflow_activations WHERE activation_id=?1 AND epoch=?2 AND owner_person=?3 AND vault_id=?4 AND store_uuid=?5 AND canonical_vault_path=?6 AND state='enabled' AND permissions_json=?7 AND permission_digest=?8)",params![activation,epoch,facts.owner,facts.vault,facts.store,facts.canonical_vault,bytes,schema::digest(bytes.as_bytes())],|row|row.get(0)).map_err(db)?;
 if !exact{return Err(flow::Error::Denied);}
 permissions.accounts.iter().map(|selection|grant_material(conn,facts,selection)).collect()
}
/// Explicit configuration pins only, never action_account_grants or a scope.
/// Existing pins are removed by the V48 replacement in this same transaction.
pub(super) fn pin_activation_accounts_rows(conn:&Connection,facts:OpeningFacts<'_>,activation:&str,epoch:&str,permissions:&Permissions)->Result<(),flow::Error>{
 let materials=activation_material_rows(conn,facts,activation,epoch,permissions)?;let mut written=BTreeSet::new();
 for material in &materials{
  let selected=&material.selection;if !written.insert((&selected.connection,&selected.account)){continue;}
  conn.execute("INSERT INTO workflow_activation_accounts(activation_id,epoch,connection_id,account_id,account_identity_digest,account_revision,revocation_generation) VALUES(?1,?2,?3,?4,?5,?6,?7)",params![activation,epoch,selected.connection,selected.account,material.identity,integer(material.account_revision)?,integer(material.revocation_generation)?]).map_err(db)?;
 }Ok(())
}
/// Current readiness check for finite skipped-only schedule bookkeeping. It
/// validates original configuration/account pins and creates no per-run grants.
pub(super) fn activation_ready_rows(conn:&Connection,facts:OpeningFacts<'_>,activation:&str,epoch:&str,permissions:&Permissions)->Result<(),flow::Error>{
 let materials=activation_material_rows(conn,facts,activation,epoch,permissions)?;
 check_activation_pins(conn,activation,epoch,&materials)
}
