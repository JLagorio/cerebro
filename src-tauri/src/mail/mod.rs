//! Mail is readable only during Cerebro's own attended conversations.
pub mod address;
pub mod body;
pub mod digest;
use crate::mcp::RunGrant;
use crate::policy::{mail, tool_approval::RunKind};

#[derive(Debug, serde::Serialize, PartialEq, Eq)]
pub struct GateRead {
    pub state: &'static str,
    pub kinds: Vec<String>,
}
pub fn gate_state(
    policy: &mail::MailPolicy,
    scope: Option<&crate::runtime::VaultScope>,
) -> GateRead {
    let state = if !policy.gate.open {
        "closed"
    } else if scope.is_some_and(|scope| {
        scope.store_uuid.as_deref().is_some_and(|store| {
            policy.gate.scope.as_deref() == Some(&format!("vault_store:{}:{store}", scope.vault_id))
        })
    }) {
        "open"
    } else {
        "other_vault"
    };
    GateRead {
        state,
        kinds: policy.gate.kinds.clone(),
    }
}
pub fn gate_read(vault: &std::path::Path) -> Result<GateRead, String> {
    let policy = mail::table();
    if !policy.gate.open {
        return Ok(gate_state(policy, None));
    }
    let scope = crate::runtime::open_vault(vault)
        .ok_or("The mail gate's vault store could not be read.")?;
    Ok(gate_state(policy, Some(&scope)))
}
pub fn write_refusal(path: &str) -> Option<String> {
    is_mail_path(path).then(|| {
        format!(
            "{}/ holds mail digests, which only cache_source writes. {path} was not changed.",
            mail::table().folder
        )
    })
}

pub fn is_mail_path(path: &str) -> bool {
    let mut path = path;
    loop {
        if let Some(rest) = path.strip_prefix("./") {
            path = rest;
        } else if let Some(rest) = path.strip_prefix('/') {
            path = rest;
        } else {
            break;
        }
    }
    let path = path.to_ascii_lowercase();
    let folder = mail::table().folder.to_ascii_lowercase();
    path == folder || path.starts_with(&format!("{folder}/"))
}
pub fn is_mail_url(value: &str) -> bool {
    let Ok(url) = tauri::Url::parse(value) else {
        return false;
    };
    if !matches!(url.scheme(), "http" | "https") {
        return false;
    }
    let Some(host) = url.host_str() else {
        return false;
    };
    let host = host.strip_suffix('.').unwrap_or(host).to_ascii_lowercase();
    mail::table()
        .mail_hosts
        .iter()
        .any(|mail| host == *mail || host.ends_with(&format!(".{mail}")))
}
pub fn attended(grant: &RunGrant) -> bool {
    grant.asks.kind == RunKind::Attended
        && !grant
            .actor
            .starts_with(crate::client_access::CLIENT_ACTOR_PREFIX)
}
pub fn readable_by(grant: &RunGrant, path: &str) -> bool {
    !is_mail_path(path) || attended(grant)
}
pub fn read_refusal(grant: &RunGrant, path: &str) -> Option<String> {
    if readable_by(grant, path) {
        return None;
    }
    Some(
        if grant
            .actor
            .starts_with(crate::client_access::CLIENT_ACTOR_PREFIX)
        {
            format!("Mail digests are read only in Cerebro's own conversations, so another app can't read {path}.")
        } else {
            format!("Mail digests are read only in a conversation a person is in. This run is unattended, so it cannot read {path}.")
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn replays_the_shared_host_cases() {
        // Shared with src/engine/mailPolicy.test.ts: shared/policy/mail.v1.json.
        for case in &mail::table().host_cases {
            assert_eq!(is_mail_url(&case.url), case.mail, "{}", case.url);
        }
    }
    #[test]
    fn mail_paths_match_only_at_a_separator() {
        for path in [
            "sources/mail/x.md",
            "./Sources/Mail/x.md",
            "/sources/mail",
            "././sources/mail/a.md",
        ] {
            assert!(is_mail_path(path), "{path}");
        }
        for path in [
            "sources/mailbox/x.md",
            ".comments/sources/mail/x.md.json",
            "notes/mail.md",
        ] {
            assert!(!is_mail_path(path), "{path}");
        }
    }
}
