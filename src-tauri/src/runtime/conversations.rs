//! Archive content is optional operational history, never run/effect authority.
//! The original generation writer produces new turns; the explicit native human
//! import writer copies validated legacy display records without execution facts.
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use crate::agent::archive_codec::{ArchiveTurnV1, Availability, Block};
use super::chat_generations::{Error, Receipt, Scope};
pub(crate) const CONTENT_BUDGET: i64 = 256 * 1024 * 1024;
pub(crate) const DISPLAY_BYTES: usize = 64 * 1024;
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test,derive(schemars::JsonSchema))]
#[serde(rename_all="snake_case")]
pub(crate) enum RetentionChoice { Off, Days30, Days90, Forever }
impl RetentionChoice {
    fn word(self)->&'static str {match self {Self::Off=>"off",Self::Days30=>"days30",Self::Days90=>"days90",Self::Forever=>"forever"}}
    fn parse(value:&str)->Result<Self,Error>{match value {"off"=>Ok(Self::Off),"days30"=>Ok(Self::Days30),"days90"=>Ok(Self::Days90),"forever"=>Ok(Self::Forever),_=>Err(Error::Unavailable)}}
    fn expiry(self,at:i64)->Option<i64>{match self {Self::Days30=>at.checked_add(2_592_000_000),Self::Days90=>at.checked_add(7_776_000_000),_=>None}}
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test,derive(schemars::JsonSchema))]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct DisplayMessage {
    pub text:String,
    #[serde(deserialize_with="crate::actions::read_types::required_nullable")]
    #[cfg_attr(test,schemars(with="crate::actions::read_types::RequiredNullable<String>"))]
    pub addressed_label:Option<String>,
    pub attachment_refs:Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test,derive(schemars::JsonSchema))]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct AttemptBinding {
    pub thread_id:String,
    pub user_message_id:String,
    pub assistant_message_id:String,
    #[serde(deserialize_with="crate::actions::read_types::required_nullable")]
    #[cfg_attr(test,schemars(with="crate::actions::read_types::RequiredNullable<String>"))]
    pub parent_thread_id:Option<String>,
    #[serde(deserialize_with="crate::actions::read_types::required_nullable")]
    #[cfg_attr(test,schemars(with="crate::actions::read_types::RequiredNullable<String>"))]
    pub branch_message_id:Option<String>,
    pub display_message:DisplayMessage,
}
fn unavailable<T>(_:T)->Error{Error::Unavailable}
fn opaque(value:&str)->bool{!value.is_empty()&&value.len()<=128&&!value.chars().any(char::is_control)}
fn checked(conn:&Connection,scope:Scope<'_>)->Result<(),Error>{
    if conn.is_autocommit(){return Err(Error::Unavailable);}
    if scope.owner!="human:me"||scope.vault.len()!=32||!scope.vault.bytes().all(|b|b.is_ascii_digit()||(b'a'..=b'f').contains(&b))||!opaque(scope.store){return Err(Error::Invalid);} Ok(())
}
fn choice(conn:&Connection,scope:Scope<'_>)->Result<RetentionChoice,Error>{
    let value:Option<String>=conn.query_row("SELECT choice FROM conversation_retention WHERE owner_person=?1 AND vault_id=?2 AND store_uuid=?3",params![scope.owner,scope.vault,scope.store],|r|r.get(0)).optional().map_err(unavailable)?;
    value.as_deref().map(RetentionChoice::parse).transpose().map(|value|value.unwrap_or(RetentionChoice::Off))
}
impl AttemptBinding {
    fn checked(&self)->Result<String,Error>{
        if ![&self.thread_id,&self.user_message_id,&self.assistant_message_id].iter().all(|value|opaque(value))
            || self.user_message_id==self.assistant_message_id
            || self.parent_thread_id.as_ref().is_some_and(|id|!opaque(id)||id==&self.thread_id)
            || self.branch_message_id.as_ref().is_some_and(|id|!opaque(id))
            || self.parent_thread_id.is_some()!=self.branch_message_id.is_some()
            || self.display_message.addressed_label.as_ref().is_some_and(|value|value.len()>128)
            || self.display_message.attachment_refs.len()>32
            || self.display_message.attachment_refs.iter().any(|path|path.is_empty()||path.len()>1024||path.starts_with('/')||path.contains('\\')||path.split('/').any(|part|part=="..")||path.chars().any(char::is_control)) {return Err(Error::Invalid);}
        let json=serde_json::to_string(self).map_err(unavailable)?;
        if json.len()>DISPLAY_BYTES{return Err(Error::Invalid);} Ok(json)
    }
}
/// The native owner calls this in the SAME transaction as begin_generation.
/// Caller IDs select display records only; they never manufacture a run ticket.
pub(crate) fn begin_rows(conn:&Connection,scope:Scope<'_>,receipt:&Receipt,binding:&AttemptBinding,now:i64)->Result<(),Error>{
    checked(conn,scope)?;let canonical=binding.checked()?;
    let digest=crate::ledger::sha256_hex(canonical.as_bytes());
    let existing:Option<(String,String,String,String)>=conn.query_row("SELECT owner_person,vault_id,store_uuid,binding_digest FROM conversation_bindings WHERE generation_id=?1",[&receipt.generation_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional().map_err(unavailable)?;
    if let Some((owner,vault,store,existing))=existing {
        if owner!=scope.owner||vault!=scope.vault||store!=scope.store{return Err(Error::Denied);}
        return if existing==digest {Ok(())}else{Err(Error::Conflict)}
    }
    let admitted:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM chat_generations WHERE generation_id=?1 AND owner_person=?2 AND vault_id=?3 AND store_uuid=?4 AND first_run_id=?5 AND current_run_id=?5 AND state='admitted')",params![receipt.generation_id,scope.owner,scope.vault,scope.store,receipt.first_run_id],|r|r.get(0)).map_err(unavailable)?;
    if !admitted{return Err(Error::Denied);}
    let ancestor:Option<(Option<String>,Option<String>,Option<i64>)>=conn.query_row("SELECT parent_thread_id,branch_message_id,tombstone_at FROM conversation_threads WHERE owner_person=?1 AND vault_id=?2 AND store_uuid=?3 AND thread_id=?4",params![scope.owner,scope.vault,scope.store,binding.thread_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(unavailable)?;
    if let Some((parent,message,tombstone))=ancestor {
        if tombstone.is_some(){return Err(Error::Denied);}
        if parent!=binding.parent_thread_id||message!=binding.branch_message_id{return Err(Error::Conflict);}
    }else{
        if let (Some(parent),Some(message))=(&binding.parent_thread_id,&binding.branch_message_id){
            let parent_exists:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM conversation_archive_attempts b JOIN conversation_threads t USING(owner_person,vault_id,store_uuid,thread_id) WHERE b.owner_person=?1 AND b.vault_id=?2 AND b.store_uuid=?3 AND b.thread_id=?4 AND b.assistant_message_id=?5 AND t.tombstone_at IS NULL)",params![scope.owner,scope.vault,scope.store,parent,message],|r|r.get(0)).map_err(unavailable)?;
            if !parent_exists{return Err(Error::Denied);}
        }
        conn.execute("INSERT INTO conversation_threads(owner_person,vault_id,store_uuid,thread_id,parent_thread_id,branch_message_id,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?7)",params![scope.owner,scope.vault,scope.store,binding.thread_id,binding.parent_thread_id,binding.branch_message_id,now]).map_err(unavailable)?;
    }
    let occupied:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM conversation_archive_attempts WHERE owner_person=?1 AND vault_id=?2 AND store_uuid=?3 AND (user_message_id IN (?4,?5) OR assistant_message_id IN (?4,?5)))",params![scope.owner,scope.vault,scope.store,binding.user_message_id,binding.assistant_message_id],|r|r.get(0)).map_err(unavailable)?;
    if occupied{return Err(Error::Conflict);}
    let display=serde_json::to_string(&binding.display_message).map_err(unavailable)?;
    conn.execute("INSERT INTO conversation_bindings(generation_id,owner_person,vault_id,store_uuid,thread_id,user_message_id,assistant_message_id,binding_digest,display_json,choice,archive_state) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,'pending')",params![receipt.generation_id,scope.owner,scope.vault,scope.store,binding.thread_id,binding.user_message_id,binding.assistant_message_id,digest,display,choice(conn,scope)?.word()]).map_err(unavailable)?;
    Ok(())
}
/// The reader hands only the bounded allowlist to its already-owned ticket.
/// Previous deferred segments are kept only when explicitly opted in.
pub(crate) fn stage_rows(conn:&Connection,scope:Scope<'_>,run:&str,turn:&ArchiveTurnV1)->Result<(),Error>{
    checked(conn,scope)?;
    if !turn.checked(){return Err(Error::Invalid);}
    let binding:Option<(String,Option<String>)>=conn.query_row("SELECT b.generation_id,b.pending_json FROM conversation_bindings b JOIN chat_generations g USING(generation_id) JOIN chat_generation_runs m ON m.run_id=g.current_run_id JOIN conversation_threads t ON t.owner_person=b.owner_person AND t.vault_id=b.vault_id AND t.store_uuid=b.store_uuid AND t.thread_id=b.thread_id WHERE g.current_run_id=?1 AND g.owner_person=?2 AND g.vault_id=?3 AND g.store_uuid=?4 AND g.actor_id=?5 AND m.app_session_id=?6 AND b.archive_state='pending' AND t.tombstone_at IS NULL",params![run,scope.owner,scope.vault,scope.store,scope.actor,scope.process],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(unavailable)?;
    let Some((generation,prior))=binding else{return Ok(())};
    if choice(conn,scope)?==RetentionChoice::Off{return Ok(())}
    let combined=match prior {
        None=>turn.clone(),
        Some(prior)=>{
            let mut prior:ArchiveTurnV1=serde_json::from_str(&prior).map_err(unavailable)?;
            if prior.blocks.len().saturating_add(turn.blocks.len())<=crate::agent::journal::RUN_EVENTS {
                for block in &turn.blocks {
                    if let Block::Tool {tool_id,name,state}=block {
                        if let Some(Block::Tool {name:old_name,state:old_state,..})=prior.blocks.iter_mut().find(|old|matches!(old,Block::Tool {tool_id:old_id,..} if old_id==tool_id)) {
                            if name!="not recorded" {*old_name=name.clone();} *old_state=state.clone(); continue;
                        }
                    }
                    prior.blocks.push(block.clone());
                }
                prior.append_references(turn.references.iter().cloned());
                prior.last_uuid=turn.last_uuid.clone();
                if prior.availability!=Availability::Complete||turn.availability!=Availability::Complete{prior.availability=Availability::Partial;}
                if prior.checked(){prior}else{ArchiveTurnV1 {version:1,blocks:turn.blocks.clone(),availability:Availability::Partial,references:turn.references.clone(),last_uuid:turn.last_uuid.clone()}}
            }else{ArchiveTurnV1 {version:1,blocks:turn.blocks.clone(),availability:Availability::Partial,references:turn.references.clone(),last_uuid:turn.last_uuid.clone()}}
        }
    };
    let json=serde_json::to_string(&combined).map_err(unavailable)?;
    conn.execute("UPDATE conversation_bindings SET pending_json=?2 WHERE generation_id=?1 AND completed_at IS NULL",params![generation,json]).map_err(unavailable)?;Ok(())
}
/// Invoked after the EXISTING generation owner mutates its current member.
/// Never called by the webview; old members and deferred exits cannot finalize.
pub(crate) fn settle_rows(conn:&Connection,scope:Scope<'_>,generation:&str,run:&str,now:i64)->Result<(),Error>{
    checked(conn,scope)?;
    let pending:Option<(Option<String>,Option<String>,String,Option<i64>)>=conn.query_row("SELECT b.display_json,b.pending_json,g.state,t.tombstone_at FROM conversation_bindings b JOIN chat_generations g USING(generation_id) JOIN conversation_threads t ON t.owner_person=b.owner_person AND t.vault_id=b.vault_id AND t.store_uuid=b.store_uuid AND t.thread_id=b.thread_id WHERE b.generation_id=?1 AND g.current_run_id=?2 AND g.owner_person=?3 AND g.vault_id=?4 AND g.store_uuid=?5 AND b.completed_at IS NULL",params![generation,run,scope.owner,scope.vault,scope.store],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional().map_err(unavailable)?;
    let Some((display,pending,state,tombstone))=pending else{return Ok(())};
    if matches!(state.as_str(),"admitted"|"running"|"deferred"){return Ok(())}
    let selected=choice(conn,scope)?;
    let mut archive_state=if tombstone.is_some(){"deleted"}else if selected==RetentionChoice::Off{"off"}else{"unavailable"};
    if tombstone.is_none()&&selected!=RetentionChoice::Off {
        let display:DisplayMessage=serde_json::from_str(display.as_deref().ok_or(Error::Unavailable)?).map_err(unavailable)?;
        let mut turn=pending.as_deref().map(serde_json::from_str::<ArchiveTurnV1>).transpose().map_err(unavailable)?.unwrap_or_else(ArchiveTurnV1::unavailable);
        let member_count:i64=conn.query_row("SELECT count(*) FROM chat_generation_runs WHERE generation_id=?1",[generation],|row|row.get(0)).map_err(unavailable)?;
        // Linked process membership alone cannot prove every original segment
        // was collected before a fast resumed member completed.
        if (state!="completed"||member_count>1)&&turn.availability==Availability::Complete{turn.availability=Availability::Partial;}
        let mut statement=conn.prepare("SELECT m.run_id,g.actor_id FROM chat_generation_runs m JOIN chat_generations g USING(generation_id) WHERE g.generation_id=?1 ORDER BY m.run_id LIMIT 128").map_err(unavailable)?;
        let members=statement.query_map([generation],|row|Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?))).map_err(unavailable)?.collect::<rusqlite::Result<Vec<_>>>().map_err(unavailable)?;
        if member_count>128 {turn.availability=Availability::Partial;}
        for (run,actor) in members {
            match crate::actions::chat_retention::references(conn,scope.vault,scope.store,&run,&actor) {
                Ok(ids)=>turn.append_references(ids.into_iter().map(|invocation_id|crate::agent::archive_references::Reference::Effect {invocation_id})),
                Err(())=>turn.availability=Availability::Partial,
            }
        }
        let content=serde_json::to_string(&serde_json::json!({"version":1,"displayMessage":&display,"answer":&turn,"completionStatus":state})).map_err(unavailable)?;
        let bytes=i64::try_from(content.len()).map_err(unavailable)?;
        retention::prune_rows(conn,scope,now)?;
        let used=legacy::used_bytes(conn,scope,now)?;
        if bytes<=crate::agent::journal::RUN_BYTES as i64 && used.checked_add(bytes).is_some_and(|total|total<=CONTENT_BUDGET) {
            conn.execute("INSERT INTO conversation_content(generation_id,content_json,logical_bytes,completed_at,expires_at) VALUES(?1,?2,?3,?4,?5)",params![generation,content,bytes,now,selected.expiry(now)]).map_err(unavailable)?;
            let search=format!("{}\n{}",display.text,turn.search_text());
            conn.execute("INSERT INTO conversation_search(generation_id,search_text) VALUES(?1,?2)",params![generation,search]).map_err(unavailable)?;
            let title:String=display.text.chars().take(80).collect();
            conn.execute("UPDATE conversation_threads SET title=coalesce(title,?5),title_generation_id=coalesce(title_generation_id,?4),updated_at=?6 WHERE owner_person=?1 AND vault_id=?2 AND store_uuid=?3 AND thread_id=(SELECT thread_id FROM conversation_bindings WHERE generation_id=?4)",params![scope.owner,scope.vault,scope.store,generation,title,now]).map_err(unavailable)?;
            archive_state="retained";
        }
    }
    // No completed question/answer remains in the recovery binding, even Off or full.
    conn.execute("UPDATE conversation_bindings SET display_json=NULL,pending_json=NULL,completed_at=?2,expires_at=?3,choice=?4,archive_state=?5 WHERE generation_id=?1 AND completed_at IS NULL",params![generation,now,selected.expiry(now),selected.word(),archive_state]).map_err(unavailable)?;Ok(())
}
pub(crate) fn unavailable_rows(conn:&Connection,generation:&str)->Result<bool,Error>{
    conn.query_row("SELECT b.archive_state='unavailable' OR (b.archive_state='pending' AND g.state NOT IN ('admitted','running','deferred')) FROM conversation_bindings b JOIN chat_generations g USING(generation_id) WHERE b.generation_id=?1",[generation],|r|r.get(0)).optional().map(|value|value.unwrap_or(false)).map_err(unavailable)
}

// Archive failures never roll back the independently observed generation outcome.
// Savepoints isolate only archive data; they create no execution authority.
fn archive_savepoint(conn:&Connection,work:impl FnOnce()->Result<(),Error>)->bool {
    if conn.execute_batch("SAVEPOINT conversation_archive").is_err(){return false;}
    if work().is_ok() {return conn.execute_batch("RELEASE conversation_archive").is_ok();}
    let _=conn.execute_batch("ROLLBACK TO conversation_archive; RELEASE conversation_archive");false
}
pub(crate) fn stage_best_effort_rows(conn:&Connection,scope:Scope<'_>,run:&str,turn:&ArchiveTurnV1)->bool {
    let valid=turn.checked();
    let unavailable=ArchiveTurnV1::unavailable();
    let safe=if valid {turn}else{&unavailable};
    let staged=archive_savepoint(conn,||stage_rows(conn,scope,run,safe));
    if !staged {
        // Discard incomplete staged answer state rather than mark old deferred
        // segments complete after a collection/storage failure.
        let safe=serde_json::to_string(&unavailable).unwrap_or_default();
        let _=conn.execute("UPDATE conversation_bindings SET pending_json=?2 WHERE generation_id=(SELECT generation_id FROM chat_generations WHERE current_run_id=?1 AND owner_person=?3 AND vault_id=?4 AND store_uuid=?5) AND completed_at IS NULL",params![run,safe,scope.owner,scope.vault,scope.store]);
    }
    valid&&staged
}
pub(crate) fn settle_best_effort_rows(conn:&Connection,scope:Scope<'_>,generation:&str,run:&str,now:i64) {
    if archive_savepoint(conn,||settle_rows(conn,scope,generation,run,now)){return;}
    // A minimal unavailable disposition is attempted after archive rollback.
    // If the archive itself cannot be read/written, callers report unavailable;
    // they still commit the already observed generation terminal metadata.
    let _=conn.execute("UPDATE conversation_bindings SET display_json=NULL,pending_json=NULL,archive_state='unavailable',completed_at=?2,expires_at=NULL WHERE generation_id=?1 AND completed_at IS NULL AND EXISTS(SELECT 1 FROM chat_generations g WHERE g.generation_id=?1 AND g.current_run_id=?3 AND g.owner_person=?4 AND g.vault_id=?5 AND g.store_uuid=?6 AND g.state NOT IN ('admitted','running','deferred'))",params![generation,now,run,scope.owner,scope.vault,scope.store]);
    log::warn!("Conversation archive unavailable after generation settlement.");
}

pub(crate) mod retention;

#[cfg(test)]
#[path="conversation_contract_tests.rs"]
mod contract_tests;

pub(crate) mod legacy;
