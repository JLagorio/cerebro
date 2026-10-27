//! Mutation signatures remain test-only; canonical value types are shared.
pub(super) use super::effect_record::PrepareAction;
pub(super) use super::effect_types::*;
// Native authority is private and never a wire DTO.
pub(super) use super::service::{ActionSubject, PersonActionDecision, PersonRetryDecision};
#[expect(
    dead_code,
    reason = "signature contract only; M96.3 must supply guarded implementation"
)]
pub(super) trait ActionService {
    fn catalog(
        &self,
        subject: ActionSubject,
        cursor: Option<CatalogCursor>,
    ) -> Result<ActionCatalogPage, ActionReadError>;
    fn definition(
        &self,
        subject: ActionSubject,
        action_id: ActionId,
        definition_digest: DefinitionDigest,
    ) -> Result<ActionDefinitionView, ActionReadError>;
    fn prepare(
        &self,
        subject: ActionSubject,
        request: PrepareAction,
    ) -> Result<PreparedAction, ActionError>;
    fn answer(&self, person: PersonActionDecision) -> Result<ActionEffectRef, ActionError>;
    fn dispatch(&self, invocation_id: InvocationId) -> Result<ActionEffectRef, ActionError>;
    fn reconcile(
        &self,
        subject: ActionSubject,
        invocation_id: InvocationId,
        expected_revision: u64,
    ) -> Result<ActionEffectRef, ActionError>;
    fn retry(
        &self,
        subject: ActionSubject,
        invocation_id: InvocationId,
        expected_revision: u64,
        decision: PersonRetryDecision,
    ) -> Result<ActionEffectRef, ActionError>;
    fn effect_ref(
        &self,
        subject: ActionSubject,
        invocation_id: InvocationId,
    ) -> Result<ActionEffectRef, ActionReadError>;
    fn effect_details(
        &self,
        subject: ActionSubject,
        invocation_id: InvocationId,
    ) -> Result<ActionEffectDetails, ActionReadError>;
    fn request_cancel(
        &self,
        subject: ActionSubject,
        invocation_id: InvocationId,
        expected_revision: u64,
    ) -> Result<ActionEffectRef, ActionError>;
}
