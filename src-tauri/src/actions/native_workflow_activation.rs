//! Explicit native Enable coordinator. Finite configuration is not a run grant.
use super::{RuntimeOwner,workflow_rows};
use crate::{runtime::{workflow_activations as activation,workflows as flow},workflows::native_definition::NativeDefinition};
pub(in crate::actions::native_owner) struct Enable<'a>{
 pub(in crate::actions::native_owner) key:&'a str,
 pub(in crate::actions::native_owner) expected:u64,
 pub(in crate::actions::native_owner) definition:&'a NativeDefinition,
 pub(in crate::actions::native_owner) permissions:&'a workflow_rows::Permissions,
 pub(in crate::actions::native_owner) now:chrono::DateTime<chrono::Utc>,
}
/// The genuine WorkflowOpening wraps this same retained owner and pre/post check.
/// Returned configuration metadata is never an origin or grant constructor.
pub(in crate::actions::native_owner) fn enable_owned_rows(owner:&mut RuntimeOwner,facts:workflow_rows::OpeningFacts<'_>,request:Enable<'_>,recheck:impl Fn()->Result<(),flow::Error>)->Result<activation::Changed,flow::Error>{
 super::row_transaction(owner,recheck,|conn|enable_rows(conn,facts,request))
}
pub(in crate::actions::native_owner) fn enable_rows(conn:&rusqlite::Connection,facts:workflow_rows::OpeningFacts<'_>,request:Enable<'_>)->Result<activation::Changed,flow::Error>{
 if conn.is_autocommit(){return Err(flow::Error::Unavailable);}
 let definition=request.definition;let(interval,catch_up)=definition.schedule().ok_or(flow::Error::Denied)?;
 let steps=definition.steps();let mut selectors=definition.selectors().into_iter().map(|s|workflow_rows::SelectorRequest{step:s.step,action:s.action,definition:s.definition,connection:s.connection,account:s.account}).collect::<Vec<_>>();selectors.sort_by(|a,b|a.step.cmp(&b.step));
 let permissions=workflow_rows::activation_selection_rows(conn,facts,request.permissions,&selectors,&steps)?;
 let configuration=super::workflow_configuration(definition).map_err(|_|flow::Error::Unavailable)?;
 let changed=activation::enable_rows(conn,activation::Scope{owner:facts.owner,vault:facts.vault,store:facts.store,canonical_vault:facts.canonical_vault},request.key,request.expected,activation::Selection{workflow:definition.workflow(),version:definition.version(),schema:definition.schema(),configuration:&configuration,input:definition.input(),permissions:&permissions,interval_seconds:interval,catch_up},request.now.timestamp_millis())?;
 if !changed.replayed{
  // Validation/pins and the configuration share the owning transaction. A
  // disabled account or later opening refusal rolls back the entire replacement.
  workflow_rows::pin_activation_accounts_rows(conn,facts,&changed.current.id,&changed.current.epoch,request.permissions)?;
 }
 // A stable-key observation never refreshes pins from a newly changed account.
 Ok(changed)
}

/// Descriptor-held explicit Enable boundary. The caller retains the actual Edit
/// through the one classified transaction and projects its acknowledgement there.
pub(in crate::actions::native_owner) fn enable_published_owned<T>(
    owner: &mut RuntimeOwner,
    facts: workflow_rows::OpeningFacts<'_>,
    edit: &crate::workflows::publication::Edit<'_>,
    request: Enable<'_>,
    recheck: impl Fn() -> Result<(), flow::Error>,
    project: impl FnOnce(&rusqlite::Connection, activation::Changed) -> Result<T, flow::Error>,
) -> Result<T, flow::Error> {
    recheck()?;
    if edit.root().to_str() != Some(facts.canonical_vault) {
        return Err(flow::Error::Denied);
    }
    let observed = edit.read().map_err(super::publication_service::file_error)?;
    let matches_publication = observed.publication.as_ref().is_some_and(|publication| {
        publication.workflow_id == request.definition.workflow()
            && publication.definition_hash == request.definition.version()
    });
    // The caller holds the original publication lock through this known commit.
    // Only bounded readback/identity checks occur here; no file is mutated.
    let still_original = || {
        recheck()?;
        if edit.read().map_err(super::publication_service::file_error)? != observed {
            return Err(flow::Error::Conflict);
        }
        Ok(())
    };
    super::row_transaction(owner, still_original, |conn| {
        let changed = enable_rows(conn, facts, request)?;
        // Same-key observation must not re-enable a selection paused by later
        // Unpublish. A fresh admission must use the currently published version.
        if !changed.replayed && !matches_publication {
            return Err(flow::Error::Denied);
        }
        project(conn, changed)
    })
}
