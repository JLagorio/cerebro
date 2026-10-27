//! Crate-private validated file/graph projection for the native workflow host.
//! All returned selectors are data; publishing a definition grants nothing.
use super::definition::{self,ValidatedDefinition,Operation};
#[derive(Debug,Clone,PartialEq,Eq)]
pub(crate) enum Error {DefinitionUnavailable,InvalidInput}
#[derive(Debug,Clone,PartialEq,Eq)]
pub(crate) struct ActionSelector {pub step:String,pub action:String,pub definition:String,pub connection:String,pub account:String}
pub(crate) struct NativeDefinition {definition:ValidatedDefinition,input:String}
impl NativeDefinition {
 pub(crate) fn load(root:&std::path::Path,workflow:&str,version:&str,input:&str)->Result<Self,Error>{
  let definition=super::files::DefinitionStore::read_existing_version(root,workflow,version).map_err(|_|Error::DefinitionUnavailable)?;
  definition::validate_input(&definition,input).map_err(|_|Error::InvalidInput)?;
  let limits=definition::limits();
  let input=crate::actions::schema::workflow_canonical_json(input,limits.step_output_bytes,limits.json_depth).map_err(|_|Error::InvalidInput)?;
  Ok(Self{definition,input})
 }
 pub(crate) fn schedule(&self)->Option<(u32,super::schedule::CatchUp)>{
  match &self.definition.definition.trigger{
   definition::Trigger::Schedule{interval_seconds,catch_up}=>Some((*interval_seconds,match catch_up{definition::CatchUp::SkipMissed=>super::schedule::CatchUp::SkipMissed,definition::CatchUp::CoalesceLatest=>super::schedule::CatchUp::CoalesceLatest})),
   definition::Trigger::Manual|definition::Trigger::Event{..}=>None,
  }
 }
 pub(crate) fn workflow(&self)->&str{&self.definition.definition.workflow_id}
 pub(crate) fn version(&self)->&str{&self.definition.definition_hash}
 pub(crate) fn schema(&self)->&str{&self.definition.definition.input_schema_digest}
 pub(crate) fn input(&self)->&str{&self.input}
 pub(crate) fn entry(&self)->&str{&self.definition.definition.entry_step_id}
 pub(crate) fn steps(&self)->Vec<crate::runtime::workflows::Step<'_>>{self.definition.definition.steps.iter().map(|step|{let(kind,next,otherwise)=super::runner::contract(&step.operation);crate::runtime::workflows::Step{id:&step.step_id,kind,next,otherwise}}).collect()}
 pub(crate) fn selectors(&self)->Vec<ActionSelector>{self.definition.definition.steps.iter().filter_map(|step|match &step.operation{Operation::Action{action_id,definition_digest,connection_id,account_id,..}=>Some(ActionSelector{step:step.step_id.clone(),action:action_id.clone(),definition:definition_digest.clone(),connection:connection_id.clone(),account:account_id.clone()}),_=>None}).collect()}
}
#[cfg(all(test,unix))]
#[path="native_definition_tests.rs"]
mod tests;

// Plain orchestration data only. Actual native origins own every read/effect.
pub(crate) use super::runner::{Error as RunnerError,Plan,Snapshot,Prepared,ReadWork,Applied,ActionSnapshot};
pub(crate) use super::read::Error as ReadError;
pub(crate) fn prepare(plan:&Snapshot)->Result<Prepared,RunnerError>{super::runner::prepare(plan)}
pub(crate) fn apply_rows(conn:&rusqlite::Connection,scope:crate::runtime::workflows::Scope<'_>,prepared:Prepared,snapshot:Option<ActionSnapshot<'_>>,process:&str,now:i64)->Result<Applied,RunnerError>{super::runner::apply_rows(conn,scope,prepared,snapshot,process,now)}
pub(crate) fn reject_rows(conn:&rusqlite::Connection,scope:crate::runtime::workflows::Scope<'_>,plan:&Snapshot,error:RunnerError,now:i64)->Result<crate::runtime::workflows::Run,RunnerError>{super::runner::reject_rows(conn,scope,plan,error,now)}
pub(crate) fn execute_read(cache:&crate::vault::corpus::CorpusCache,grant:&crate::mcp::RunGrant,query:&str,zone:chrono_tz::Tz,today:chrono::NaiveDate)->Result<String,ReadError>{super::read::execute(cache,grant,query,zone,today)}
impl NativeDefinition{
 pub(crate) fn plan_rows(&self,conn:&rusqlite::Connection,scope:crate::runtime::workflows::Scope<'_>,run:&str)->Result<Plan,RunnerError>{super::runner::plan_rows(conn,scope,run,&self.definition)}
 pub(crate) fn settle_read_rows(&self,conn:&rusqlite::Connection,scope:crate::runtime::workflows::Scope<'_>,work:&ReadWork,output:Result<&str,ReadError>,now:i64)->Result<crate::runtime::workflows::Run,RunnerError>{super::runner::settle_read_rows(conn,scope,work,&self.definition,output,now)}
}
/// Actual immutable-file fixture only; never creates a native origin or grant.
#[cfg(test)]
pub(crate) fn publish_fixture(root:&std::path::Path,raw:&str,input:&str)->NativeDefinition{
 let checked=definition::validate(raw).unwrap();
 let store=super::files::DefinitionStore::open(root,&checked.definition.workflow_id).unwrap();
 let draft=store.save_draft(raw,None).unwrap();let version=store.publish(&draft,None).unwrap();
 NativeDefinition::load(root,&checked.definition.workflow_id,&version.definition_hash,input).unwrap()
}
