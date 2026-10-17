//! Nested under mcp: the attended, scoped-gate mail cache door can mint only
//! its own run receipt. Message parsing and projection remain pure.
use super::*;
use crate::mail::{digest, gate_state};
use crate::policy::mail::MailPolicy;

pub(super) fn is_thread(args: &Map<String, Value>) -> bool {
    args.get("kind").and_then(Value::as_str)
        == Some(crate::policy::mail::table().kinds.thread.as_str())
}
fn gate_refusal(
    policy: &MailPolicy,
    scope: Option<&crate::runtime::VaultScope>,
) -> Option<&'static str> {
    match gate_state(policy, scope).state {
        "closed" => Some("Mail digests are off until the owner accepts the Gmail evidence pack (R14). Nothing was written."),
        "other_vault" => Some("Mail digests are on only in the vault the accepted Gmail evidence pack (R14) names. Nothing was written."),
        _ if !policy.gate.kinds.contains(&policy.kinds.thread) => Some("Mail digests are off until the owner accepts the Gmail evidence pack (R14). Nothing was written."),
        _ => None,
    }
}
pub(super) fn cache(
    vault: &Path,
    args: &Map<String, Value>,
    grant: &RunGrant,
) -> Result<Value, String> {
    let policy = crate::policy::mail::table();
    let scope = policy
        .gate
        .open
        .then(|| crate::runtime::open_vault(vault))
        .flatten();
    cache_in(vault, args, grant, policy, scope.as_ref())
}
pub(super) fn cache_in(
    vault: &Path,
    args: &Map<String, Value>,
    grant: &RunGrant,
    policy: &MailPolicy,
    scope: Option<&crate::runtime::VaultScope>,
) -> Result<Value, String> {
    let refuse = |code, target: &str, message: String| {
        record_refusal(&grant.run_id, "cache_source", code, target, &message);
        message
    };
    if let Some(message) = gate_refusal(policy, scope) {
        return Err(refuse(
            "capability_unavailable",
            "mail_gate",
            message.into(),
        ));
    }
    let wants_text = args
        .get("messages")
        .and_then(Value::as_array)
        .is_some_and(|messages| messages.iter().any(|message| message.get("body").is_some()));
    if wants_text && !policy.gate.kinds.contains(&policy.kinds.text) {
        return Err(refuse("capability_unavailable", "mail_text_gate", "Message text is off until the Gmail evidence pack (R14) opens it. Nothing was written.".into()));
    }
    if !crate::mail::attended(grant) {
        return Err(refuse("capability_unavailable", "mail_attendance", "Mail is cached only in a conversation a person is in. This run is unattended. Nothing was written.".into()));
    }
    let thread = digest::parse_thread(args, &policy.limits)
        .map_err(|message| refuse("malformed_arguments", "mail_thread", message))?;
    let path = format!("{}/{}.md", policy.folder, thread.id);
    if !grant.may_read(&path) || !scope_admits_landing(vault, &grant.read_scope, &path) {
        return Err(refuse(
            READ_OUTSIDE_SCOPE,
            &path,
            format!(
                "This run may read only {} and cannot read {path}.",
                scope_words(&grant.read_scope)
            ),
        ));
    }
    let text_path = format!("{}/{}-text.md", policy.folder, thread.id);
    if wants_text
        && (!grant.may_read(&text_path)
            || !scope_admits_landing(vault, &grant.read_scope, &text_path))
    {
        return Err(refuse(
            READ_OUTSIDE_SCOPE,
            &text_path,
            format!("This run cannot read {text_path}. Nothing was written."),
        ));
    }
    let now = now_iso();
    let by = WriteReceipt::run(cleared_for_source(grant));
    // Both paths are locked even for a metadata-only refresh. Presence is a
    // read too: a concurrent text cache must not lose its header link.
    let changed = vault::write::write_sources(
        vault,
        &[&path, &text_path],
        || {
            let has_text = grant.may_read(&text_path)
                && scope_admits_landing(vault, &grant.read_scope, &text_path)
                && {
                    if let Some(refusal) = vault::write::note_target_refusal(vault, &text_path) {
                        return Err(refusal);
                    }
                    vault.join(&text_path).is_file()
                };
            let text = digest::build_text(&thread, &grant.actor, &now, &policy.limits);
            let digest =
                digest::build_digest(&thread, &grant.actor, &now, has_text || text.is_some());
            let mut pages = Vec::new();
            if let Some(text) = text {
                pages.push(vault::write::SourcePage {
                    path: text_path.clone(),
                    frontmatter: text.frontmatter,
                    body: text.body,
                });
            }
            pages.push(vault::write::SourcePage {
                path: path.clone(),
                frontmatter: digest.frontmatter,
                body: digest.body,
            });
            Ok(pages)
        },
        &by,
    )?
    .iter()
    .any(|changed| *changed);
    Ok(text_result(if changed {
        format!(
            "Cached thread {} at {path} ({} messages).",
            thread.id,
            thread.messages.len()
        )
    } else {
        format!("Unchanged: {path} already holds this thread.")
    }))
}
