//! Explicit raw-connector ownership admission (M96.4a). No reference is resolved.
use serde::Deserialize;
use serde_json::Value;
use std::sync::OnceLock;

pub const POLICY_JSON: &str = include_str!("../../../shared/policy/connector-ownership.v1.json");
const UNAVAILABLE_REASON: &str = "Connector ownership policy is unavailable.";

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Ownership {
    Cli,
    Managed,
    Invalid,
    Unavailable,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OwnershipPolicy {
    format: u64,
    artifact_version: u64,
    owner_field: String,
    owners: Vec<OwnerRule>,
    absent_owner: Ownership,
    unknown_owner: Ownership,
    managed_only_fields: Vec<String>,
    cli_with_managed_field: Ownership,
    messages: Messages,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct OwnerRule {
    value: String,
    disposition: Ownership,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Messages {
    managed: String,
    invalid: String,
    unavailable: String,
}

fn identifier(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_graphic())
}

fn message(value: &str) -> bool {
    value.bytes().all(|byte| (b' '..=b'~').contains(&byte))
        && value.bytes().any(|byte| byte != b' ')
}

/// An unsupported/corrupt policy is unavailable, never the legacy default.
pub fn parse(source: &str) -> Option<OwnershipPolicy> {
    let mut value: Value = serde_json::from_str(source).ok()?;
    if value.get("format").and_then(Value::as_f64) != Some(1.0) {
        return None;
    }
    let version = value.get("artifact_version")?.as_f64()?;
    if !(1.0..=9_007_199_254_740_991.0).contains(&version) || version.fract() != 0.0 {
        return None;
    }
    value["format"] = Value::from(1);
    value["artifact_version"] = Value::from(version as u64);
    let policy: OwnershipPolicy = serde_json::from_value(value).ok()?;
    if policy.format != 1
        || policy.artifact_version == 0
        || !identifier(&policy.owner_field)
        || policy.absent_owner != Ownership::Cli
        || policy.unknown_owner != Ownership::Invalid
        || policy.cli_with_managed_field != Ownership::Invalid
        || policy.owners.is_empty()
        || !policy.owners.iter().all(|rule| {
            identifier(&rule.value)
                && matches!(rule.disposition, Ownership::Cli | Ownership::Managed)
        })
        || !policy
            .owners
            .windows(2)
            .all(|pair| pair[0].value < pair[1].value)
        || !policy
            .owners
            .iter()
            .any(|rule| rule.disposition == Ownership::Cli)
        || !policy
            .owners
            .iter()
            .any(|rule| rule.disposition == Ownership::Managed)
        || policy.managed_only_fields.is_empty()
        || !policy
            .managed_only_fields
            .iter()
            .all(|field| identifier(field) && field != &policy.owner_field)
        || !policy
            .managed_only_fields
            .windows(2)
            .all(|pair| pair[0] < pair[1])
        || !message(&policy.messages.managed)
        || !message(&policy.messages.invalid)
        || !message(&policy.messages.unavailable)
    {
        return None;
    }
    Some(policy)
}

fn table() -> Option<&'static OwnershipPolicy> {
    static TABLE: OnceLock<Option<OwnershipPolicy>> = OnceLock::new();
    TABLE.get_or_init(|| parse(POLICY_JSON)).as_ref()
}

fn ownership_with(entry: &Value, policy: Option<&OwnershipPolicy>) -> Ownership {
    let Some(policy) = policy else {
        return Ownership::Unavailable;
    };
    let Some(entry) = entry.as_object() else {
        return Ownership::Invalid;
    };
    let disposition = match entry.get(&policy.owner_field) {
        None => policy.absent_owner,
        Some(value) => value
            .as_str()
            .and_then(|owner| policy.owners.iter().find(|rule| rule.value == owner))
            .map_or(policy.unknown_owner, |rule| rule.disposition),
    };
    if disposition == Ownership::Cli
        && policy
            .managed_only_fields
            .iter()
            .any(|field| entry.contains_key(field))
    {
        policy.cli_with_managed_field
    } else {
        disposition
    }
}

pub fn ownership(entry: &Value) -> Ownership {
    ownership_with(entry, table())
}

/// Static words only: never expose a URL, command, header, env or reference.
pub fn refusal(entry: &Value) -> Option<&'static str> {
    let policy = table();
    match (ownership_with(entry, policy), policy) {
        (Ownership::Cli, _) => None,
        (Ownership::Managed, Some(policy)) => Some(&policy.messages.managed),
        (Ownership::Invalid, Some(policy)) => Some(&policy.messages.invalid),
        _ => Some(UNAVAILABLE_REASON),
    }
}

#[cfg(test)]
#[path = "connector_ownership_tests.rs"]
mod tests;
