//! Same-transaction native account/action authority. No provider is enabled.
#[cfg(test)]
use super::{
    admission::{self, NativeAdmissionProof},
    service::AuthoritySource,
    types::AccountId,
};
use super::{
    catalog::ActionCatalog,
    effect_record::{Binding, PrepareAction},
    native_db::AuthorityDb,
    read_types::*,
    schema::{admission_rules, digest, validate_input, POLICY},
};
use crate::{
    connections::metadata::{self, AccountBinding, ConnectionHealth},
    runtime::action_authority::{AccountGrant, GRANTS_SQL, GRANT_SQL},
};
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
#[cfg(test)]
use std::sync::Arc;
#[cfg(test)]
pub(super) struct NativeAuthoritySource {
    proof: NativeAdmissionProof,
    catalog: Arc<ActionCatalog>,
}
// Pure scoped projection: callers must authenticate before supplying this data.
// This type cannot construct a run, origin, grant or effect-capable subject.
pub(super) struct ScopedCatalog<'a> {
    pub(super) catalog: &'a ActionCatalog,
    pub(super) scope: &'a ActionSubjectView,
    pub(super) owner: &'a str,
    pub(super) execution: CatalogExecution,
}
pub(super) enum CatalogExecution {
    NoExecutor,
    /// Only the actual retained fixed GitHub native producer selects this.
    FixedGithub,
    #[cfg(test)]
    FixtureExecutor,
}
impl CatalogExecution {
    fn available(&self) -> bool {
        match self {
            Self::NoExecutor => false,
            Self::FixedGithub => cfg!(target_os = "macos"),
            #[cfg(test)]
            Self::FixtureExecutor => true,
        }
    }
}
fn unavailable() -> ActionError {
    error(
        ActionErrorCode::Unavailable,
        "Native action authority is unavailable.",
    )
}
struct Eligible {
    grant: AccountGrant,
    chain: Vec<AccountGrant>,
    definition: ActionDefinition,
    account: AccountBinding,
    health: ConnectionHealth,
    label: String,
    native_digest: String,
}
impl Eligible {
    fn evidence(&self) -> Result<String, ActionError> {
        serde_json::to_string(&(
            "cerebro:action-grant-binding",
            1,
            &self.native_digest,
            &self.chain,
            &self.account.scope_digest,
        ))
        .map_err(|_| unavailable())
    }
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    version: u8,
    scope: String,
    snapshot: String,
    offset: usize,
}
pub(super) fn read_error(e: ActionError) -> ActionReadError {
    ActionReadError {
        code: match e.code {
            ActionErrorCode::Denied => ActionReadErrorCode::Denied,
            ActionErrorCode::NotFound => ActionReadErrorCode::NotFound,
            _ => ActionReadErrorCode::Unavailable,
        },
        retry_disposition: e.retry_disposition,
        message: "Scoped action catalog could not be read.".into(),
    }
}
pub(super) fn scope_digest(scope: &ActionSubjectView) -> String {
    digest(
        serde_json::to_string(&(
            "cerebro:native-action-catalog-scope",
            1,
            &scope.vault_id,
            &scope.run_id,
            &scope.actor_id,
            &scope.client_id,
            &scope.child_job_id,
        ))
        .expect("scope tuple")
        .as_bytes(),
    )
}
fn capabilities(g: &AccountGrant) -> Result<Vec<String>, ActionError> {
    let l = &admission_rules().limits;
    if g.capabilities_json.len() > l.grant_bytes {
        return Err(unavailable());
    }
    let values: Vec<String> =
        serde_json::from_str(&g.capabilities_json).map_err(|_| unavailable())?;
    if values.len() > l.grant_capabilities
        || values
            .iter()
            .any(|v| v.is_empty() || v.len() > super::schema::limits().string_bytes)
        || values.windows(2).any(|v| v[0] >= v[1])
        || serde_json::to_string(&values).map_err(|_| unavailable())? != g.capabilities_json
    {
        return Err(unavailable());
    }
    Ok(values)
}
fn contains(parent: &AccountGrant, child: &AccountGrant) -> bool {
    parent.connection_id == child.connection_id
        && parent.account_id == child.account_id
        && parent.account_identity_digest == child.account_identity_digest
        && parent.account_revision == child.account_revision
        && parent.revocation_generation == child.revocation_generation
        && parent.action_id == child.action_id
        && parent.definition_digest == child.definition_digest
        && parent.granted_by == child.granted_by
        && (parent.input_scope == "all_valid_inputs"
            || (child.input_scope == "exact_canonical_input"
                && child.input_digest == parent.input_digest))
}
fn safe_grant(g: &AccountGrant) -> Result<bool, ActionError> {
    capabilities(g)?;
    Ok(g.revoked_at.is_none()
        && g.revision > 0
        && g.revision <= 9_007_199_254_740_991
        && admission_rules()
            .grant_input_scopes
            .contains(&g.input_scope)
        && (g.input_scope == "exact_canonical_input") == g.input_digest.is_some())
}
impl ScopedCatalog<'_> {
    fn chain(
        &self,
        db: AuthorityDb<'_>,
        grant: &AccountGrant,
    ) -> Result<Option<(Vec<AccountGrant>, String)>, ActionError> {
        let mut current = grant.clone();
        let mut chain = Vec::new();
        let mut seen = BTreeSet::new();
        let mut native = Vec::new();
        loop {
            if chain.len() >= admission_rules().limits.ancestry_depth
                || !seen.insert(current.grant_id.clone())
                || !safe_grant(&current)?
            {
                return Ok(None);
            }
            let run =
                super::native_lineage::load_run(db, &current.run_id).map_err(|e| match e {
                    super::native_lineage::LineageError::Denied => error(
                        ActionErrorCode::Denied,
                        "Native action authority was not admitted.",
                    ),
                    super::native_lineage::LineageError::Unavailable => unavailable(),
                })?;
            native.push((run.authority_id, run.revision, run.run_id.clone()));
            let parent_run = run.parent_run_id;
            let parent_id = current.parent_grant_id.clone();
            chain.push(current.clone());
            match (parent_run, parent_id) {
                (None, None) => break,
                (Some(run), Some(id)) => {
                    let Some(parent) = db
                        .query(GRANT_SQL, &[&id], AccountGrant::read)
                        .optional()
                        .map_err(|_| unavailable())?
                    else {
                        return Ok(None);
                    };
                    let parent_caps = capabilities(&parent)?;
                    if parent.run_id != run
                        || !contains(&parent, &current)
                        || !capabilities(&current)?
                            .iter()
                            .all(|v| parent_caps.contains(v))
                    {
                        return Ok(None);
                    }
                    current = parent;
                }
                _ => return Ok(None),
            }
        }
        Ok(Some((
            chain,
            digest(
                serde_json::to_string(&("cerebro:native-action-lineage", 1, native))
                    .map_err(|_| unavailable())?
                    .as_bytes(),
            ),
        )))
    }
    fn eligible(
        &self,
        db: AuthorityDb<'_>,
    ) -> Result<(ActionSubjectView, Vec<Eligible>), ActionError> {
        let limit = (admission_rules().limits.grants_per_run + 1).to_string();
        let grants = db
            .query_all(
                GRANTS_SQL,
                &[&self.scope.run_id, &limit],
                AccountGrant::read,
            )
            .map_err(|_| unavailable())?;
        if grants.len() > admission_rules().limits.grants_per_run {
            return Err(unavailable());
        }
        let mut eligible = Vec::new();
        for g in grants {
            if g.granted_by != self.owner || g.connection_owner != self.owner || !safe_grant(&g)? {
                continue;
            }
            let definition = match self.catalog.resolve(
                &ActionId(g.action_id.clone()),
                &DefinitionDigest(g.definition_digest.clone()),
            ) {
                Ok(d) => d,
                Err(e) if e.code == ActionErrorCode::NotFound => continue,
                Err(e) => return Err(e),
            };
            let caps = capabilities(&g)?;
            if !definition
                .required_capabilities
                .iter()
                .all(|v| caps.contains(v))
            {
                continue;
            }
            if g.status.len() > admission_rules().limits.grant_bytes
                || g.secret_ref
                    .as_ref()
                    .is_some_and(|r| r.len() > admission_rules().limits.grant_bytes)
            {
                return Err(unavailable());
            }
            // These are metadata only. No SecretStore access occurs in admission.
            let status =
                metadata::decode_status(&g.status, g.cleanup_pending).map_err(|_| unavailable())?;
            let Some(account) = status.account else {
                continue;
            };
            if account.account_id.0.is_empty()
                || account.issuer.is_empty()
                || account.subject.is_empty()
                || account.scope_digest.is_empty()
            {
                return Err(unavailable());
            }
            let identity = digest(
                serde_json::to_string(&(&account.issuer, &account.subject))
                    .map_err(|_| unavailable())?
                    .as_bytes(),
            );
            if status.connection_id.0 != g.connection_id
                || account.account_id.0 != g.account_id
                || identity != g.account_identity_digest
                || account.account_revision != g.account_revision
                || status.revocation_generation != g.revocation_generation
                || matches!(status.health, ConnectionHealth::Disabled)
                || status.cleanup_pending
            {
                continue;
            }
            let Some((chain, native_digest)) = self.chain(db, &g)? else {
                continue;
            };
            let mut health = status.health;
            if health == ConnectionHealth::Ready {
                let reference = metadata::decode_reference(g.secret_ref.as_deref())
                    .map_err(|_| unavailable())?;
                if !reference.is_some_and(|r| {
                    r.account_id == account.account_id
                        && r.issuer == account.issuer
                        && r.subject == account.subject
                        && r.secret_revision == status.secret_revision
                }) {
                    health = ConnectionHealth::Unavailable;
                }
            }
            eligible.push(Eligible {
                grant: g,
                chain,
                definition,
                account,
                health,
                label: status.login,
                native_digest,
            });
        }
        Ok((self.scope.clone(), eligible))
    }
    fn snapshot(
        scope: &ActionSubjectView,
        entries: &[Eligible],
    ) -> Result<SnapshotDigest, ActionError> {
        let mut evidence = Vec::new();
        for e in entries {
            evidence.push((
                &e.grant.connection_id,
                &e.grant.account_id,
                &e.grant.account_identity_digest,
                e.grant.account_revision,
                e.grant.revocation_generation,
                &e.definition.definition_digest,
                e.health,
                &e.label,
                e.evidence()?,
            ));
        }
        Ok(SnapshotDigest(digest(
            serde_json::to_string(&(
                "cerebro:native-action-catalog-snapshot",
                1,
                scope_digest(scope),
                digest(POLICY.as_bytes()),
                evidence,
            ))
            .map_err(|_| unavailable())?
            .as_bytes(),
        )))
    }
    pub(super) fn catalog(
        &self,
        db: AuthorityDb<'_>,
        cursor: Option<CatalogCursor>,
    ) -> Result<ActionCatalogPage, ActionReadError> {
        let (scope, entries) = self.eligible(db).map_err(read_error)?;
        let snapshot = Self::snapshot(&scope, &entries).map_err(read_error)?;
        let mut descriptors = std::collections::BTreeMap::new();
        for e in entries {
            let status = if !self.execution.available() {
                CatalogStatus::Unavailable {
                    reason: "Managed execution is not enabled.".into(),
                }
            } else if e.health == ConnectionHealth::Ready {
                CatalogStatus::Callable {}
            } else {
                CatalogStatus::Unavailable {
                    reason: "Account is currently unavailable.".into(),
                }
            };
            let key = (
                e.definition.action_id.clone(),
                e.definition.definition_digest.clone(),
            );
            let item = descriptors.entry(key).or_insert(ActionDescriptor {
                action_id: e.definition.action_id,
                definition_digest: e.definition.definition_digest,
                status: status.clone(),
            });
            if matches!(status, CatalogStatus::Callable {}) {
                item.status = status;
            }
        }
        let descriptors: Vec<_> = descriptors.into_values().collect();
        let mut offset = 0;
        if let Some(c) = cursor {
            let invalid = || {
                read_error(error(
                    ActionErrorCode::Denied,
                    "Catalog cursor is stale or invalid.",
                ))
            };
            if c.0.len() > admission_rules().limits.cursor_bytes {
                return Err(invalid());
            }
            let c: Cursor = serde_json::from_str(&c.0).map_err(|_| invalid())?;
            if c.version != 1
                || c.scope != scope_digest(&scope)
                || c.snapshot != snapshot.0
                || c.offset > descriptors.len()
            {
                let mut e = invalid();
                e.retry_disposition = RetryDisposition::Refresh;
                return Err(e);
            }
            offset = c.offset;
        }
        let end = (offset + admission_rules().limits.catalog_page_size).min(descriptors.len());
        let next_cursor = if end < descriptors.len() {
            Some(CatalogCursor(
                serde_json::to_string(&Cursor {
                    version: 1,
                    scope: scope_digest(&scope),
                    snapshot: snapshot.0.clone(),
                    offset: end,
                })
                .expect("bounded cursor"),
            ))
        } else {
            None
        };
        Ok(ActionCatalogPage {
            descriptors: descriptors[offset..end].to_vec(),
            snapshot_digest: snapshot,
            next_cursor,
        })
    }
    pub(super) fn definition(
        &self,
        db: AuthorityDb<'_>,
        id: ActionId,
        value: DefinitionDigest,
    ) -> Result<ActionDefinitionView, ActionReadError> {
        let (_, entries) = self.eligible(db).map_err(read_error)?;
        entries
            .into_iter()
            .find(|e| e.definition.action_id == id && e.definition.definition_digest == value)
            .map(|e| e.definition)
            .ok_or_else(|| {
                read_error(error(
                    ActionErrorCode::NotFound,
                    "Action definition was not found.",
                ))
            })
    }
}
#[cfg(test)]
impl NativeAuthoritySource {
    pub(super) fn from_proof(proof: NativeAdmissionProof, catalog: Arc<ActionCatalog>) -> Self {
        Self { proof, catalog }
    }
    fn with_scoped<T>(
        &self,
        db: AuthorityDb<'_>,
        operation: impl FnOnce(ScopedCatalog<'_>) -> Result<T, ActionError>,
    ) -> Result<T, ActionError> {
        let admitted = admission::resolve(db, Some(&self.proof))?;
        if !admitted.can_call() {
            return Err(admission::denied());
        }
        operation(ScopedCatalog {
            catalog: &self.catalog,
            scope: admitted.scope(),
            owner: admitted.owner_person(),
            execution: CatalogExecution::FixtureExecutor,
        })
    }
    pub(super) fn catalog(
        &self,
        db: AuthorityDb<'_>,
        cursor: Option<CatalogCursor>,
    ) -> Result<ActionCatalogPage, ActionReadError> {
        let admitted = admission::resolve(db, Some(&self.proof)).map_err(read_error)?;
        if !admitted.can_call() {
            return Err(read_error(admission::denied()));
        }
        ScopedCatalog {
            catalog: &self.catalog,
            scope: admitted.scope(),
            owner: admitted.owner_person(),
            execution: CatalogExecution::FixtureExecutor,
        }
        .catalog(db, cursor)
    }
    pub(super) fn definition(
        &self,
        db: AuthorityDb<'_>,
        id: ActionId,
        digest: DefinitionDigest,
    ) -> Result<ActionDefinitionView, ActionReadError> {
        let admitted = admission::resolve(db, Some(&self.proof)).map_err(read_error)?;
        if !admitted.can_call() {
            return Err(read_error(admission::denied()));
        }
        ScopedCatalog {
            catalog: &self.catalog,
            scope: admitted.scope(),
            owner: admitted.owner_person(),
            execution: CatalogExecution::FixtureExecutor,
        }
        .definition(db, id, digest)
    }
}
#[cfg(test)]
impl AuthoritySource for NativeAuthoritySource {
    fn catalog(
        &self,
        db: AuthorityDb<'_>,
        scope: &ActionSubjectView,
        cursor: Option<CatalogCursor>,
    ) -> Result<ActionCatalogPage, ActionReadError> {
        if admission::resolve(db, Some(&self.proof))
            .map_err(read_error)?
            .scope()
            != scope
        {
            return Err(read_error(admission::denied()));
        }
        NativeAuthoritySource::catalog(self, db, cursor)
    }
    fn definition(
        &self,
        db: AuthorityDb<'_>,
        scope: &ActionSubjectView,
        id: ActionId,
        digest: DefinitionDigest,
    ) -> Result<ActionDefinitionView, ActionReadError> {
        if admission::resolve(db, Some(&self.proof))
            .map_err(read_error)?
            .scope()
            != scope
        {
            return Err(read_error(admission::denied()));
        }
        NativeAuthoritySource::definition(self, db, id, digest)
    }
    fn read_access(
        &self,
        db: AuthorityDb<'_>,
        scope: &ActionSubjectView,
        _account: &AccountId,
    ) -> Result<(), ActionError> {
        let admitted = admission::resolve_history(db, Some(&self.proof))?;
        if admitted.scope() != scope {
            return Err(admission::denied());
        }
        Ok(())
    }
    fn check(
        &self,
        db: AuthorityDb<'_>,
        scope: &ActionSubjectView,
        request: &PrepareAction,
        definition: &ActionDefinition,
    ) -> Result<Binding, ActionError> {
        self.with_scoped(db, |catalog| {
            catalog.checked_binding(db, scope, request, definition)
        })
    }
}

fn binding_denied() -> ActionError {
    error(
        ActionErrorCode::Denied,
        "Native action authority was not admitted.",
    )
}
impl ScopedCatalog<'_> {
    /// Borrowed, same-snapshot account/grant binding. This projection never
    /// authenticates callers, mints capabilities or resolves credentials.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "native mutation owner is composed next")
    )]
    pub(super) fn checked_binding(
        &self,
        db: AuthorityDb<'_>,
        scope: &ActionSubjectView,
        request: &PrepareAction,
        definition: &ActionDefinition,
    ) -> Result<Binding, ActionError> {
        let (admitted, entries) = self.eligible(db)?;
        if &admitted != scope
            || request.action_id != definition.action_id
            || request.definition_digest != definition.definition_digest
            || self
                .catalog
                .resolve(&request.action_id, &request.definition_digest)?
                != *definition
        {
            return Err(binding_denied());
        }
        let input = validate_input(definition, &request.input)?;
        let chosen = entries
            .iter()
            .find(|e| {
                e.definition == *definition
                    && e.grant.connection_id == request.connection_id.0
                    && e.grant.account_id == request.account_id.0
                    && e.health == ConnectionHealth::Ready
                    && (e.grant.input_scope == "all_valid_inputs"
                        || e.grant.input_digest.as_deref() == Some(input.digest.as_str()))
            })
            .ok_or_else(binding_denied)?;
        let snapshot = ScopedCatalog::snapshot(scope, &entries)?;
        if request.snapshot_digest != snapshot {
            let mut e = binding_denied();
            e.retry_disposition = RetryDisposition::Refresh;
            return Err(e);
        }
        Ok(Binding {
            account_id: request.account_id.clone(),
            account_identity_digest: chosen.grant.account_identity_digest.clone(),
            account_revision: chosen.account.account_revision,
            account_label: chosen.label.clone(),
            grant_digest: digest(chosen.evidence()?.as_bytes()),
            policy_digest: digest(POLICY.as_bytes()),
            revocation_generation: chosen.grant.revocation_generation,
            snapshot_digest: snapshot,
        })
    }
}
