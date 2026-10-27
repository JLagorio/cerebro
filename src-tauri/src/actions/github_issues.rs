//! Fixed GitHub issue semantics; native admission owns any eventual execution.
#![expect(
    dead_code,
    reason = "M96 provider adapter is integrated before its guarded native execution door"
)]
use super::{
    effect_record::AdapterTarget,
    effect_types::*,
    schema::{self, Node},
};
use serde::Deserialize;
use std::{collections::BTreeMap, sync::OnceLock};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Policy {
    version: u32,
    api_base: String,
    web_base: String,
    api_version: String,
    response_bytes: usize,
    repository_owner_bytes: usize,
    repository_name_bytes: usize,
    operations: Vec<Operation>,
    transport: TransportPolicy,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TransportPolicy {
    header_count: usize,
    header_bytes: usize,
    connect_seconds: u64,
    read_seconds: u64,
    total_seconds: u64,
    cancellation_poll_millis: u64,
    blocking_threads: usize,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Operation {
    action_id: String,
    method: String,
    success_status: u16,
    not_applied_statuses: Vec<u16>,
}
const POLICY: &str = include_str!("../../../shared/actions/github-transport.v1.json");
fn policy() -> &'static Policy {
    static VALUE: OnceLock<Policy> = OnceLock::new();
    VALUE.get_or_init(|| {
        let value: Policy = serde_json::from_str(POLICY).expect("compiled GitHub protocol policy");
        assert_eq!(value.version, 1);
        assert_eq!(
            schema::digest(POLICY.as_bytes()),
            "8300a9ebb7926ba4a55510fc0b660615674d55f575888813d6f147fb482018f9"
        );
        value
    })
}
/// The managed account must belong to the same fixed issuer as this adapter.
pub(super) fn account_issuer() -> &'static str {
    &policy().web_base
}

pub(super) struct IssuePlan {
    endpoint: String,
    method: String,
    body: Option<String>,
    target: AdapterTarget,
    preview: SafeEffectPreview,
    definition: ActionDefinition,
    repository: String,
    number: Option<u64>,
}

impl IssuePlan {
    pub(super) fn target(&self) -> &AdapterTarget {
        &self.target
    }
    pub(super) fn preview(&self) -> &SafeEffectPreview {
        &self.preview
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum IssueOutcome {
    Succeeded {
        output: String,
        remote_reference: String,
    },
    NotApplied,
    Unknown,
}
fn invalid() -> ActionError {
    error(
        ActionErrorCode::InvalidInput,
        "This GitHub issue request is unsupported.",
    )
}
fn repository(value: &str) -> Result<String, ActionError> {
    let (owner, name) = value.split_once('/').ok_or_else(invalid)?;
    let valid_owner = !owner.is_empty()
        && owner.len() <= policy().repository_owner_bytes
        && owner
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-')
        && !owner.starts_with('-')
        && !owner.ends_with('-')
        && !owner.contains("--");
    let valid_name = !name.is_empty()
        && name.len() <= policy().repository_name_bytes
        && !matches!(name, "." | "..")
        && !name.to_ascii_lowercase().ends_with(".git")
        && name
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'.'));
    if !valid_owner || !valid_name {
        return Err(invalid());
    }
    Ok(format!(
        "{}/{}",
        owner.to_ascii_lowercase(),
        name.to_ascii_lowercase()
    ))
}
fn string(value: Option<&Node>) -> Result<&str, ActionError> {
    match value {
        Some(Node::String(text)) => Ok(text),
        _ => Err(invalid()),
    }
}
// Canonical decimal coefficients have neither a decimal point nor trailing zero.
// No f64 or JSON-number conversion can round a remote id or issue number.
fn positive_integer(value: Option<&Node>) -> Result<u64, ActionError> {
    let Some(Node::Number(text)) = value else {
        return Err(invalid());
    };
    let (coefficient, exponent) = text.split_once('e').unwrap_or((text, "0"));
    if !coefficient.bytes().all(|c| c.is_ascii_digit()) {
        return Err(invalid());
    }
    let coefficient: u64 = coefficient.parse().map_err(|_| invalid())?;
    let exponent: u32 = exponent.parse().map_err(|_| invalid())?;
    coefficient
        .checked_mul(10_u64.checked_pow(exponent).ok_or_else(invalid)?)
        .filter(|value| *value > 0)
        .ok_or_else(invalid)
}
fn operation(definition: &ActionDefinition) -> Result<&'static Operation, ActionError> {
    let operation = policy()
        .operations
        .iter()
        .find(|operation| operation.action_id == definition.action_id.0)
        .ok_or_else(invalid)?;
    let known = super::compiled_catalog::compiled_catalog()
        .map_err(|_| {
            error(
                ActionErrorCode::Unavailable,
                "Local GitHub definitions are unavailable.",
            )
        })?
        .resolve(&definition.action_id, &definition.definition_digest)?;
    if known != *definition {
        return Err(error(
            ActionErrorCode::DefinitionMismatch,
            "GitHub action definition changed.",
        ));
    }
    Ok(operation)
}
pub(super) fn prepare(
    definition: &ActionDefinition,
    input: &str,
) -> Result<IssuePlan, ActionError> {
    let operation = operation(definition)?;
    let input = schema::validate_input(definition, input)?;
    let Node::Object(fields) = input.value else {
        return Err(invalid());
    };
    let repo = repository(string(fields.get("repository"))?)?;
    let mut endpoint = format!("{}/repos/{repo}/issues", policy().api_base);
    let mut preview_fields = vec![PreviewField {
        label: "Repository".into(),
        value: repo.clone(),
    }];
    let (number, body, kind, label, reference, summary) = match operation.method.as_str() {
        "GET" => {
            let number = positive_integer(fields.get("number"))?;
            endpoint.push_str(&format!("/{number}"));
            preview_fields.push(PreviewField {
                label: "Issue".into(),
                value: number.to_string(),
            });
            (
                Some(number),
                None,
                "github_issue",
                format!("{repo} #{number}"),
                format!("{}/repos/{repo}/issues/{number}", policy().api_base),
                "Read GitHub issue",
            )
        }
        "POST" => {
            let title = string(fields.get("title"))?;
            let body = string(fields.get("body"))?;
            // Preview is plain text. Preserve the entire schema-supported body,
            // including Markdown and line breaks; no hidden truncation/redaction.
            preview_fields.push(PreviewField {
                label: "Title".into(),
                value: title.into(),
            });
            preview_fields.push(PreviewField {
                label: "Body".into(),
                value: body.into(),
            });
            let body = serde_json::to_string(&serde_json::json!({"title":title,"body":body}))
                .map_err(|_| invalid())?;
            (
                None,
                Some(body),
                "github_repository",
                repo.clone(),
                format!("{}/repos/{repo}", policy().api_base),
                "Create GitHub issue",
            )
        }
        _ => return Err(invalid()),
    };
    Ok(IssuePlan {
        endpoint,
        method: operation.method.clone(),
        body,
        target: AdapterTarget {
            conflict_domain: definition.action_id.0.clone(),
            target: EffectTarget {
                kind: kind.into(),
                label,
                safe_reference: reference,
            },
        },
        preview: SafeEffectPreview {
            summary: summary.into(),
            fields: preview_fields,
            redacted_fields: Vec::new(),
        },
        definition: definition.clone(),
        repository: repo,
        number,
    })
}
fn checked_output(plan: &IssuePlan, body: &[u8]) -> Result<(String, String), ActionError> {
    let text = std::str::from_utf8(body).map_err(|_| invalid())?;
    let Node::Object(fields) = schema::parse_bounded(text, policy().response_bytes)? else {
        return Err(invalid());
    };
    if fields.contains_key("pull_request") {
        return Err(invalid());
    }
    let id = positive_integer(fields.get("id"))?;
    let number = positive_integer(fields.get("number"))?;
    if plan.number.is_some_and(|expected| expected != number) {
        return Err(invalid());
    }
    let api_prefix = format!("{}/repos/", policy().api_base);
    let remote_repo = string(fields.get("repository_url"))?
        .strip_prefix(&api_prefix)
        .ok_or_else(invalid)?;
    if repository(remote_repo)? != plan.repository {
        return Err(invalid());
    }
    let web_prefix = format!("{}/", policy().web_base);
    let relative = string(fields.get("html_url"))?
        .strip_prefix(&web_prefix)
        .ok_or_else(invalid)?;
    let (web_repo, web_number) = relative.rsplit_once("/issues/").ok_or_else(invalid)?;
    if repository(web_repo)? != plan.repository || web_number != number.to_string() {
        return Err(invalid());
    }
    let url = format!("{}/{}/issues/{number}", policy().web_base, plan.repository);
    let title = string(fields.get("title"))?;
    let body = match fields.get("body") {
        Some(Node::Null) => "",
        other => string(other)?,
    };
    let output = Node::Object(BTreeMap::from([
        ("issueId".into(), Node::String(id.to_string())),
        ("repository".into(), Node::String(plan.repository.clone())),
        ("number".into(), Node::Number(number.to_string())),
        ("url".into(), Node::String(url.clone())),
        ("title".into(), Node::String(title.into())),
        ("body".into(), Node::String(body.into())),
    ]))
    .canonical();
    schema::validate_output(&plan.definition, &output)?;
    Ok((output, url))
}
fn response(plan: &IssuePlan, status: u16, content_type: &str, body: &[u8]) -> IssueOutcome {
    let Ok(operation) = operation(&plan.definition) else {
        return IssueOutcome::Unknown;
    };
    // These status-only dispositions come from the trusted fixed HTTPS origin.
    // The transport validates header framing before calling this function; error
    // bodies never become UI text or influence retry permission.
    if operation.not_applied_statuses.contains(&status) {
        return IssueOutcome::NotApplied;
    }
    if status != operation.success_status
        || body.len() > policy().response_bytes
        || !content_type
            .split(';')
            .next()
            .is_some_and(|value| value.trim().eq_ignore_ascii_case("application/json"))
    {
        return IssueOutcome::Unknown;
    }
    match checked_output(plan, body) {
        Ok((output, remote_reference)) => IssueOutcome::Succeeded {
            output,
            remote_reference,
        },
        Err(_) => IssueOutcome::Unknown,
    }
}

#[cfg(test)]
#[path = "github_issues_tests.rs"]
mod tests;

#[cfg(any(test, target_os = "macos"))]
#[path = "github_issue_transport.rs"]
mod native;

#[cfg(any(test, target_os = "macos"))]
#[expect(
    unused_imports,
    reason = "retained native action dispatcher is the next integration boundary"
)]
pub(super) use native::{execute, TransportOutcome};
