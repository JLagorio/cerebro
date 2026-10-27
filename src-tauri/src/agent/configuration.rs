//! Secret-free configuration facts from the actual CLI dispatch owners.
use crate::runtime::run_configuration::{Known, SelectorIdentity, StrictCliVersion, UnknownReason};
#[cfg(test)]
use serde::Serialize;

#[cfg(test)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectionError {
    TooLarge,
}
#[cfg(test)]
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProjectedSelectors {
    pub actor: SelectorIdentity,
    pub chain: Vec<SelectorIdentity>,
    pub grant_write: Option<Vec<SelectorIdentity>>,
    pub grant_read: Option<Vec<SelectorIdentity>>,
    pub grant_tools: Option<Vec<SelectorIdentity>>,
    pub cli_tools: Vec<SelectorIdentity>,
    pub allowed: Vec<SelectorIdentity>,
    pub denied: Vec<SelectorIdentity>,
    pub asked: Vec<SelectorIdentity>,
    pub requested_model: Option<SelectorIdentity>,
    pub connector_ids: Vec<SelectorIdentity>,
}
// Inputs are actual descriptive dispatch values, never authority. No Debug on
// arbitrary selector strings, because a rule can contain a secret argument.
#[cfg(test)]
pub struct SelectorInput<'a> {
    pub grant: &'a crate::mcp::RunGrant,
    pub cli_tools: &'a [String],
    pub allowed: &'a [String],
    pub denied: &'a [String],
    pub asked: &'a [String],
    pub requested_model: Option<&'a str>,
    pub connector_ids: &'a [String],
}
#[cfg(test)]
pub fn project_selectors(input: SelectorInput<'_>) -> Result<ProjectedSelectors, ProjectionError> {
    let count = input
        .grant
        .chain
        .len()
        .saturating_add(input.grant.scope.as_ref().map_or(0, Vec::len))
        .saturating_add(input.grant.read_scope.as_ref().map_or(0, Vec::len))
        .saturating_add(input.grant.tools.as_ref().map_or(0, Vec::len))
        .saturating_add(input.cli_tools.len())
        .saturating_add(input.allowed.len())
        .saturating_add(input.denied.len())
        .saturating_add(input.asked.len())
        .saturating_add(input.connector_ids.len());
    if count > crate::runtime::run_configuration::limits().encoded_bytes {
        return Err(ProjectionError::TooLarge);
    }
    use crate::runtime::run_configuration::selector_identity as identity;
    let vector = |values: &[String], labels| -> Vec<SelectorIdentity> {
        values.iter().map(|v| identity(v, labels)).collect()
    };
    Ok(ProjectedSelectors {
        actor: identity(&input.grant.actor, false),
        chain: vector(&input.grant.chain, false),
        grant_write: input.grant.scope.as_ref().map(|v| vector(v, false)),
        grant_read: input.grant.read_scope.as_ref().map(|v| vector(v, false)),
        grant_tools: input.grant.tools.as_ref().map(|v| vector(v, true)),
        cli_tools: vector(input.cli_tools, true),
        allowed: vector(input.allowed, true),
        denied: vector(input.denied, true),
        asked: vector(input.asked, true),
        requested_model: input.requested_model.map(|v| identity(v, false)),
        connector_ids: vector(input.connector_ids, false),
    })
}
pub fn observed_cli_version(raw: Option<&str>) -> Known<StrictCliVersion> {
    let Some(raw) = raw else {
        return Known::Unknown {
            reason: UnknownReason::NotReportedByNativeProbe,
        };
    };
    let version = raw.strip_suffix(" (Claude Code)").unwrap_or(raw);
    let parsed = (|| {
        let mut parts = version.split('.');
        let mut component = || {
            let raw = parts.next()?;
            if raw.is_empty() || !raw.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            raw.parse::<u32>().ok()
        };
        let value = StrictCliVersion {
            major: component()?,
            minor: component()?,
            patch: component()?,
        };
        if parts.next().is_some() {
            return None;
        }
        Some(value)
    })();
    parsed.map_or(
        Known::Unknown {
            reason: UnknownReason::UnrecognizedCliVersion,
        },
        |value| Known::Recorded { value },
    )
}

// Snapshot before taking the original M99 publication guard. No listener/table
// lock is acquired while holding agent admission, storage or ActiveRoot.
pub(super) struct PreparedCapture {
    snapshot: crate::mcp::ConfigurationGrantSnapshot,
}
pub(super) fn prepare(
    endpoint: Option<&crate::mcp::McpState>,
    meter: Option<&super::meter::Meter>,
    request: &super::AgentRequest,
    vault: &std::path::Path,
) -> Result<Option<PreparedCapture>, crate::runtime::run_configuration::ManifestWriteError> {
    use crate::runtime::run_configuration::ManifestWriteError as Error;
    let Some(meter) = meter.filter(|m| m.vault_id.is_some() && m.store_uuid.is_some()) else {
        return Ok(None);
    };
    // Explicit legacy fixture coverage (None endpoint) is retained; actual
    // stream rejects a missing managed endpoint for a supported scoped run.
    let Some(endpoint) = endpoint else {
        return Ok(None);
    };
    let token = request.mcp_token.as_deref().ok_or(Error::Unavailable)?;
    let snapshot = endpoint
        .snapshot_configuration_grant(token)
        .ok_or(Error::Unavailable)?;
    let grant = snapshot.grant();
    let root = vault.canonicalize().map_err(|_| Error::Unavailable)?;
    if meter.vault_id.as_deref() != Some(crate::runtime::scope::derive_vault_id(&root).as_str())
        || grant.run_id != meter.run_id
        || grant.actor != crate::mcp::normalize_actor(meter.actor.as_deref())
        || grant.vault.as_deref() != Some(root.as_path())
        || grant.asks != crate::mcp::WriteAsks::of(request)
    {
        return Err(Error::Unavailable);
    }
    Ok(Some(PreparedCapture { snapshot }))
}
pub(super) fn retire(endpoint: Option<&crate::mcp::McpState>, request: &super::AgentRequest) {
    if let (Some(endpoint), Some(token)) = (endpoint, request.mcp_token.as_deref()) {
        endpoint.revoke(token, std::time::Duration::ZERO);
    }
}

// Safe facts emitted from the one actual argv producer, not reconstructed by
// rereading current files, evaluating permissions twice or parsing argv.
pub(super) struct DispatchFacts {
    pub cli_tools: Vec<SelectorIdentity>,
    pub allowed: Vec<SelectorIdentity>,
    pub denied: Vec<SelectorIdentity>,
    pub asked: Vec<SelectorIdentity>,
    pub system_prompt_sha256: Option<String>,
    pub defined_subagents: Vec<crate::runtime::run_configuration::DefinitionIdentity>,
}
pub(super) struct CaptureInput<'a> {
    pub meter: Option<&'a super::meter::Meter>,
    pub prepared: Option<&'a PreparedCapture>,
    pub request: &'a super::AgentRequest,
    pub cli: &'a super::readiness::Observation,
    pub approval: &'a crate::policy::tool_approval::RunApproval,
    pub connectors: &'a super::RunConnectors,
    pub setup: Option<&'a super::RunSetup>,
    pub facts: &'a DispatchFacts,
    pub strict_mcp: bool,
}
pub(super) fn record_before_launch(
    input: CaptureInput<'_>,
) -> Result<(), crate::runtime::run_configuration::ManifestWriteError> {
    use crate::runtime::run_configuration::*;
    let Some(prepared) = input.prepared else {
        return Ok(());
    };
    let meter = input.meter.ok_or(ManifestWriteError::Unavailable)?;
    let grant = prepared.snapshot.grant();
    let selector = |value: &str, labels| selector_identity(value, labels);
    let scope = |value: &Option<Vec<String>>| match value {
        None => ScopeAxis::Unrestricted,
        Some(values) if values.is_empty() => ScopeAxis::None,
        Some(values) => ScopeAxis::Prefixes {
            selectors: values.iter().map(|v| selector(v, false)).collect(),
        },
    };
    let tools = match &grant.tools {
        None => ToolAxis::Unrestricted,
        Some(values) if values.is_empty() => ToolAxis::None,
        Some(values) => ToolAxis::Restricted {
            selectors: values.iter().map(|v| selector(v, true)).collect(),
        },
    };
    let manifest = RunConfigurationManifestV1 {
        format: 1,
        run_id: meter.run_id.clone(),
        vault_id: meter
            .vault_id
            .clone()
            .ok_or(ManifestWriteError::Unavailable)?,
        store_uuid: meter.store_uuid.clone(),
        dispatched_at: meter
            .started_at
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        effective_grant: EffectiveGrant {
            actor_id: selector(&grant.actor, false),
            write_scope: scope(&grant.scope),
            read_scope: scope(&grant.read_scope),
            tools,
            chain: grant.chain.iter().map(|v| selector(v, false)).collect(),
            run_kind: grant.asks.kind.as_str().into(),
            ask_first: grant.asks.ask_first,
        },
        permission_mode: input.approval.permission_mode.clone(),
        cli_tools: input.facts.cli_tools.clone(),
        allowed_tools: input.facts.allowed.clone(),
        denied_tools: input.facts.denied.clone(),
        asked_tools: input.facts.asked.clone(),
        requested_model: input
            .request
            .model
            .as_deref()
            .filter(|v| !v.trim().is_empty())
            .map(|v| selector(v, false)),
        requested_effort: input
            .request
            .effort
            .clone()
            .filter(|v| !v.trim().is_empty()),
        observed_model_at_dispatch: Known::Unknown {
            reason: UnknownReason::NotObservedBeforeDispatch,
        },
        observed_cli_version: observed_cli_version(input.cli.version.as_deref()),
        artifacts: artifact_identities(),
        standing_agent: Known::Unknown {
            reason: UnknownReason::NoNativeIdentityReceipt,
        },
        skills: Known::Unknown {
            reason: UnknownReason::NoNativeIdentityReceipt,
        },
        defined_subagents: input.facts.defined_subagents.clone(),
        effective_system_prompt_sha256: input.facts.system_prompt_sha256.clone(),
        connectors: input
            .connectors
            .servers
            .iter()
            .map(|(_, id)| ConnectorIdentity {
                cli_id: selector(id, false),
                spec_identity: Known::Unknown {
                    reason: UnknownReason::SpecIdentityNotSupplied,
                },
            })
            .collect(),
        inherits_user_mcp: !input.strict_mcp,
        user_settings: Known::Unknown {
            reason: UnknownReason::InheritedUserConfiguration,
        },
        settings_hardening: input.setup.is_some(),
        seated: input.setup.is_some_and(|s| s.gate.is_some()),
        message_transport: if input
            .setup
            .is_some_and(|s| s.input == super::RunInput::Stdin)
        {
            "stdin"
        } else {
            "argv"
        }
        .into(),
        coverage: [
            "hash_only_instructions",
            "model_not_observed_before_dispatch",
            "standing_agent_identity_not_recorded",
            "skill_identity_not_recorded",
            "connector_spec_identity_not_recorded",
            "inherited_user_configuration_not_observed",
            "subagent_brief_identity_not_recorded",
        ]
        .into_iter()
        .map(str::to_owned)
        .collect(),
    };
    let conn = crate::runtime::open_existing(&meter.data_dir)
        .map_err(|_| ManifestWriteError::Unavailable)?;
    record_configuration(&conn, &manifest, chrono::Utc::now()).map(|_| ())
}

// Observer only: it never supplies a configuration, capability or fake owner.
#[cfg(test)]
thread_local! {
    static BEFORE_CHILD: std::cell::RefCell<Option<Box<dyn FnOnce()>>> = const { std::cell::RefCell::new(None) };
}
#[cfg(test)]
pub(super) fn observe_before_child_for_test(operation: impl FnOnce() + 'static) {
    BEFORE_CHILD.with(|slot| {
        assert!(slot.borrow().is_none());
        slot.replace(Some(Box::new(operation)));
    });
}
#[cfg(test)]
pub(super) fn notify_before_child_for_test() {
    if let Some(observe) = BEFORE_CHILD.with(|slot| slot.borrow_mut().take()) {
        observe();
    }
}
#[cfg(test)]
pub(super) fn clear_before_child_for_test() {
    BEFORE_CHILD.with(|slot| {
        slot.borrow_mut().take();
    });
}

#[cfg(test)]
#[path = "configuration_tests.rs"]
mod tests;
