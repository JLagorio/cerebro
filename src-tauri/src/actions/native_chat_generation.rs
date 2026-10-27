//! Native-only metadata admission. Existing root provenance/P1a stay separate.
use super::*;
use crate::runtime::chat_generations::{self as rows, Admission, Error, Receipt, Scope};

pub(crate) enum GenerationStart { New(NativeGenerationRun), Observed(Receipt) }
// No Clone/serde/public constructor: only a definitely committed insertion can
// create this one-use dispatch ticket. Replay returns a receipt, never a ticket.
pub(crate) struct NativeGenerationRun {
    owner: Arc<NativeOwnerState>,
    entry: crate::agent::EntryWitness,
    root: PathBuf,
    store: NativeStoreObservation,
    scope: crate::runtime::VaultScope,
    actor: String,
    process: String,
    receipt: Receipt,
    published: bool,
    settled: bool,
}

/// A retained card may settle only its generation's metadata. This carries no
/// preparation, opening, session credential, grant, prompt or dispatch ticket.
pub(crate) struct NativeGenerationSettlement {
    owner: Arc<NativeOwnerState>,
    scope: crate::runtime::VaultScope,
    actor: String,
    process: String,
    run_id: String,
}
impl std::fmt::Debug for NativeGenerationSettlement {
    fn fmt(&self,f:&mut std::fmt::Formatter<'_>)->std::fmt::Result {f.debug_struct("NativeGenerationSettlement").finish_non_exhaustive()}
}
impl NativeGenerationSettlement {
    pub(crate) fn cancel_wait(&self) {
        if transaction(&self.owner,|tx|rows::cancel_wait_rows(tx,scope(&self.scope,&self.actor,&self.process)?,&self.run_id)).is_err() {
            log::warn!("Generation cancellation metadata is unavailable; the held call remains refused.");
        }
    }
}

fn words(error:Error)->String {
    match error {
        Error::Conflict=>"request_key_conflict: this request key already names a different launch.",
        Error::Invalid=>"The generation request is invalid. Nothing was started.",
        Error::Denied=>"The generation no longer owns this launch. Nothing was started.",
        Error::Unavailable=>"Generation admission is unavailable. Nothing was started.",
    }.into()
}
fn transaction<T>(owner:&NativeOwnerState, operation:impl FnOnce(&Connection)->Result<T,Error>)->Result<T,Error> {
    let mut storage=owner.storage.lock().map_err(|_|Error::Unavailable)?;
    if storage.failed {return Err(Error::Unavailable);}
    let writer=storage.owner.as_mut().ok_or(Error::Unavailable)?;
    let mut refusal=None;
    match writer.classified_transaction(|tx|operation(tx).map_err(|error|{refusal=Some(error); NativeOwnerError::Unavailable})) {
        RuntimeTransactionOutcome::Committed(value)=>Ok(value),
        RuntimeTransactionOutcome::NotCommitted(_)=>Err(refusal.unwrap_or(Error::Unavailable)),
        RuntimeTransactionOutcome::CommitUncertain=>Err(Error::Unavailable),
    }
}
fn scope<'a>(vault:&'a crate::runtime::VaultScope,actor:&'a str,process:&'a str)->Result<Scope<'a>,Error> {
    Ok(Scope {owner:&super::super::native_rules::admission_rules().owner_storage_key,vault:&vault.vault_id,store:vault.store_uuid.as_deref().ok_or(Error::Unavailable)?,actor,process})
}
impl NativeRootEntry<'_> {
    fn generation_rows<T>(&self, vault:&crate::runtime::VaultScope,actor:&str,work:impl FnOnce(&Connection,Scope<'_>)->Result<T,Error>)->Result<(T,NativeStoreObservation,crate::agent::EntryWitness),Error> {
        let store=read_native_store(&self.root).map_err(|_|Error::Unavailable)?;
        let process=crate::runtime::sessions::session_id();
        let scoped=scope(vault,actor,process)?;
        let result=self.context.with_legacy_opening(&self.opening,|| {
            let entry=self.agents.guard_generation_preparation(self.preparation,&self.root).map_err(|_|Error::Unavailable)?;
            if !self.proof.owner.registration.live.load(Ordering::SeqCst) || store.info.store_id!=scoped.store {
                return Err(Error::Unavailable);
            }
            store.recheck().map_err(|_|Error::Unavailable)?;
            let value=transaction(&self.proof.owner,|tx| {
                RuntimeOwner::verify_open_session(tx,&self.root,vault).map_err(|_|Error::Unavailable)?;
                let value=work(tx,scoped)?;
                store.recheck().map_err(|_|Error::Unavailable)?;
                if !self.proof.owner.registration.live.load(Ordering::SeqCst) {return Err(Error::Unavailable);}
                Ok(value)
            })?;
            Ok((value,entry.entry_witness()))
        }).map_err(|_|Error::Unavailable)??;
        Ok((result.0,store,result.1))
    }
    fn ticket(&self,vault:&crate::runtime::VaultScope,actor:&str,receipt:Receipt,store:NativeStoreObservation,entry:crate::agent::EntryWitness)->NativeGenerationRun {
        NativeGenerationRun {owner:self.proof.owner.clone(),entry,root:self.root.clone(),store,scope:vault.clone(),actor:actor.into(),process:crate::runtime::sessions::session_id().into(),receipt,published:false,settled:false}
    }
    #[cfg(test)]
    pub(crate) fn begin_generation(&self,vault:&crate::runtime::VaultScope,key:&str,request:&crate::agent::AgentRequest)->Result<GenerationStart,String> {
        self.begin_generation_with_archive(vault,key,request,None)
    }
    pub(crate) fn begin_generation_with_archive(&self,vault:&crate::runtime::VaultScope,key:&str,request:&crate::agent::AgentRequest,binding:Option<&crate::runtime::conversations::AttemptBinding>)->Result<GenerationStart,String> {
        if request.attended!=Some(true)||request.internal {return Err(words(Error::Denied));}
        let actor=crate::mcp::normalize_actor(request.actor.as_deref());
        let digest=request_digest(request)?;
        let (admission,store,entry)=self.generation_rows(vault,actor,|tx,scope| {
            rows::recover_rows(tx,scope)?;
            let admitted=rows::begin_rows(tx,scope,key,&digest)?;
            let receipt=match &admitted {Admission::New(receipt)|Admission::Observed(receipt)=>receipt};
            if let Some(binding)=binding {crate::runtime::conversations::begin_rows(tx,scope,receipt,binding,chrono::Utc::now().timestamp_millis())?;}
            Ok(admitted)
        }).map_err(words)?;
        Ok(match admission {
            Admission::New(receipt)=>GenerationStart::New(self.ticket(vault,actor,receipt,store,entry)),
            Admission::Observed(receipt)=>GenerationStart::Observed(receipt),
        })
    }
    pub(crate) fn resume_generation(&self,vault:&crate::runtime::VaultScope,request:&crate::agent::AgentRequest,link:&crate::agent::interaction::AnswerLink)->Result<NativeGenerationRun,String> {
        if !link.generation_bound()||!link.belongs_to(self.agents.interactions())||!link.validate(&self.root) {return Err(words(Error::Denied));}
        let actor=crate::mcp::normalize_actor(request.actor.as_deref());
        let (admission,store,entry)=self.generation_rows(vault,actor,|tx,scope| {
            if !link.validate(&self.root) {return Err(Error::Denied);}
            let admitted=rows::resume_rows(tx,scope,link.source_run(),link.session(),link.answer_key())?;
            if !link.validate(&self.root) {return Err(Error::Denied);}
            Ok(admitted)
        }).map_err(words)?;
        match admission {
            Some(Admission::New(receipt))=>Ok(self.ticket(vault,actor,receipt,store,entry)),
            // A cloned/stale answer cannot turn an observed row into a ticket.
            _=>Err(words(Error::Denied)),
        }
    }
}
impl NativeGenerationRun {
    pub(crate) fn generation_id(&self)->&str {&self.receipt.generation_id}
    pub(crate) fn run_id(&self)->&str {&self.receipt.current_run_id}
    pub(crate) fn bind_session(&mut self,session:&str,preparation:&crate::agent::RunPreparation,vault:&Path)->Result<(),String> {
        if self.published||self.settled||!self.entry.matches_preparation(preparation)||crate::agent::vault_key(vault)!=self.root {return Err(words(Error::Denied));}
        // Stream subsequently holds guard_prepared on this SAME original entry
        // through process publication. Never take ActiveRoot under that guard.
        self.store.recheck().map_err(|_|words(Error::Unavailable))?;
        if !self.owner.registration.live.load(Ordering::SeqCst) {return Err(words(Error::Unavailable));}
        transaction(&self.owner,|tx| {
            RuntimeOwner::verify_open_session(tx,&self.root,&self.scope).map_err(|_|Error::Unavailable)?;
            rows::bind_session_rows(tx,scope(&self.scope,&self.actor,&self.process)?,self.run_id(),session)
        }).map_err(words)
    }
    pub(crate) fn tracker(&self)->Arc<NativeGenerationSettlement> {
        Arc::new(NativeGenerationSettlement {owner:self.owner.clone(),scope:self.scope.clone(),actor:self.actor.clone(),process:self.process.clone(),run_id:self.run_id().into()})
    }
    pub(crate) fn restore_waiting(&mut self)->Result<(),String> {
        if self.settled {return Ok(());}
        let result=transaction(&self.owner,|tx|rows::restore_waiting_rows(tx,scope(&self.scope,&self.actor,&self.process)?,self.run_id()));
        self.settled=true;
        result.map_err(words)
    }
    pub(crate) fn published(&mut self) {self.published=true;}
    #[cfg(test)]
    pub(crate) fn finish(&mut self,end:rows::End)->Result<(),String> {
        self.finish_with_archive(end,None)
    }
    pub(crate) fn finish_with_archive(&mut self,end:rows::End,turn:Option<&crate::agent::archive_codec::ArchiveTurnV1>)->Result<(),String> {
        if self.settled {return Ok(());}
        // Settlement is metadata only and still belongs to its original vault
        // after that opening closes. It cannot reopen execution or any effect.
        let result=transaction(&self.owner,|tx| {
            let scope=scope(&self.scope,&self.actor,&self.process)?;
            let archive_ready=turn.is_none_or(|turn|crate::runtime::conversations::stage_best_effort_rows(tx,scope,self.run_id(),turn));
            rows::finish_rows(tx,scope,self.run_id(),end)?;
            Ok(!archive_ready||crate::runtime::conversations::unavailable_rows(tx,self.generation_id()).unwrap_or(true))
        });
        self.settled=result.is_ok();
        if result.map_err(|_|"The run ended, but its generation status could not be recorded. Review what happened before trying again.".to_owned())? {return Err("The run ended, but its completed conversation could not be archived. Existing archived content was kept.".into());}
        Ok(())
    }
}
impl Drop for NativeGenerationRun {
    fn drop(&mut self) {
        if self.settled {return;}
        let _=transaction(&self.owner,|tx| {
            let scope=scope(&self.scope,&self.actor,&self.process)?;
            if self.published {rows::finish_rows(tx,scope,self.run_id(),rows::End::Interrupted)}
            else {rows::fail_unstarted_rows(tx,scope,self.run_id())}
        });
    }
}

// Exhaustive destructuring makes a newly added launch input require an explicit
// digest decision. Only the digest is stored; no request/prompt snapshot exists.
fn request_digest(request:&crate::agent::AgentRequest)->Result<String,String> {
    use serde::ser::{SerializeMap,Serializer};
    use sha2::{Digest,Sha256};
    struct Hash(Sha256);
    impl std::io::Write for Hash {
        fn write(&mut self,bytes:&[u8])->std::io::Result<usize> {self.0.update(bytes);Ok(bytes.len())}
        fn flush(&mut self)->std::io::Result<()> {Ok(())}
    }
    let crate::agent::AgentRequest {message,system_prompt,session_id,fork,model,effort,shell,web,delegate,connectors,connector_names,attended,ask_first,mcp_url:_,mcp_token:_,actor,approved_stdio,scope,read_scope,allowed_tools,disallowed_tools,lane,cause,internal}=request;
    let mut hash=Hash(Sha256::new());
    {
        let mut serializer=serde_json::Serializer::new(&mut hash);
        let mut map=serializer.serialize_map(None).map_err(|_|words(Error::Invalid))?;
        macro_rules! field {($name:ident)=>{map.serialize_entry(stringify!($name),$name).map_err(|_|words(Error::Invalid))?;}}
        field!(message);field!(system_prompt);field!(session_id);
        map.serialize_entry("fork",&fork.as_ref().map(|f|(&f.from,&f.at))).map_err(|_|words(Error::Invalid))?;
        field!(model);field!(effort);field!(shell);field!(web);field!(delegate);field!(connectors);field!(connector_names);field!(attended);field!(ask_first);field!(actor);field!(approved_stdio);field!(scope);field!(read_scope);field!(allowed_tools);field!(disallowed_tools);field!(lane);field!(internal);
        map.serialize_entry("cause",&cause.as_ref().map(|c|(&c.kind,&c.subject,&c.detail,&c.due_at))).map_err(|_|words(Error::Invalid))?;
        map.end().map_err(|_|words(Error::Invalid))?;
    }
    Ok(format!("{:x}",hash.0.finalize()))
}

#[cfg(test)]
#[path = "native_chat_generation_tests.rs"]
mod tests;
