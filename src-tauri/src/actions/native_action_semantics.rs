//! Fixed provider semantics only. No origin, current-permission admission,
//! read authority, secret store or execution factory lives in this module.
//! Owning native origins must guard the same borrowed db/scope before delegation.
use crate::actions::{
    effect_kernel as kernel,
    effect_record::{AdapterTarget, Binding, PrepareAction},
    effect_types::*,
    native_authority::{CatalogExecution, ScopedCatalog},
    native_db::AuthorityDb,
    schema::ValidatedInput,
};
pub(in crate::actions::native_owner) fn definition(
    id: &ActionId,
    digest: &DefinitionDigest,
) -> Result<ActionDefinition, ActionError> {
    crate::actions::compiled_catalog::compiled_catalog()
        .map_err(|_| kernel::unavailable())?
        .resolve(id, digest)
}
pub(in crate::actions::native_owner) fn checked_binding(
    db: AuthorityDb<'_>,
    scope: &ActionSubjectView,
    owner: &str,
    request: &PrepareAction,
    definition: &ActionDefinition,
) -> Result<Binding, ActionError> {
    ScopedCatalog {
        catalog: crate::actions::compiled_catalog::compiled_catalog()
            .map_err(|_| kernel::unavailable())?,
        scope,
        owner,
        execution: CatalogExecution::NoExecutor,
    }
    .checked_binding(db, scope, request, definition)
}
pub(in crate::actions::native_owner) fn target(
    definition: &ActionDefinition,
    input: &ValidatedInput,
) -> Result<AdapterTarget, ActionError> {
    Ok(
        crate::actions::github_issues::prepare(definition, &input.value.canonical())?
            .target()
            .clone(),
    )
}
pub(in crate::actions::native_owner) fn preview(
    definition: &ActionDefinition,
    input: &ValidatedInput,
) -> Result<SafeEffectPreview, ActionError> {
    Ok(
        crate::actions::github_issues::prepare(definition, &input.value.canonical())?
            .preview()
            .clone(),
    )
}
