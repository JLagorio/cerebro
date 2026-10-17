//! Mail projections. Connector input is validated before any writer
//! runs; labels decide direction and are never stored in the resulting page.
use super::address::{normalize_address, parse_mailbox, Mailbox};
use crate::policy::mail::Limits;
use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::{json, Map, Value};
use std::collections::BTreeSet;

#[derive(Debug)]
pub struct Message {
    pub id: String,
    pub from: Mailbox,
    pub to: Vec<Mailbox>,
    pub cc: Vec<Mailbox>,
    pub date: DateTime<Utc>,
    pub sent: bool,
    pub body: Option<String>,
}
#[derive(Debug)]
pub struct Thread {
    pub id: String,
    pub title: String,
    pub source_url: Option<String>,
    pub owners: BTreeSet<String>,
    pub messages: Vec<Message>,
}
#[derive(Debug)]
pub struct Digest {
    pub frontmatter: Map<String, Value>,
    pub body: String,
}
fn id(value: &str) -> bool {
    (1..=128).contains(&value.len())
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-'))
}
fn text<'a>(row: &'a Map<String, Value>, key: &str) -> Result<&'a str, String> {
    row.get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{key} must be text"))
}
fn date(raw: &Value) -> Option<DateTime<Utc>> {
    let value = match raw {
        Value::String(value) => value.clone(),
        Value::Number(value) => value.to_string(),
        _ => return None,
    };
    if value.len() == 13 && value.bytes().all(|c| c.is_ascii_digit()) {
        return DateTime::from_timestamp_millis(value.parse().ok()?);
    }
    DateTime::parse_from_rfc3339(&value)
        .or_else(|_| DateTime::parse_from_rfc2822(&value))
        .ok()
        .map(|value| value.with_timezone(&Utc))
}
fn mailboxes(row: &Map<String, Value>, key: &str, limits: &Limits) -> Result<Vec<Mailbox>, String> {
    let Some(value) = row.get(key) else {
        return Ok(Vec::new());
    };
    let values = value
        .as_array()
        .ok_or_else(|| format!("{key} must be a list of addresses"))?;
    if values.len() > limits.addresses_per_message {
        return Err(format!(
            "{key} has more than {} addresses",
            limits.addresses_per_message
        ));
    }
    values
        .iter()
        .map(|value| {
            value
                .as_str()
                .and_then(|raw| parse_mailbox(raw, limits.name_chars))
                .ok_or_else(|| format!("{key} holds an invalid address"))
        })
        .collect()
}
pub fn parse_thread(args: &Map<String, Value>, limits: &Limits) -> Result<Thread, String> {
    let thread_id = text(args, "id")?;
    if !id(thread_id) {
        return Err("thread id needs 1–128 letters, digits, - or _".into());
    }
    let title: String = text(args, "title")?
        .chars()
        .take(limits.subject_chars)
        .collect();
    let mut owners = BTreeSet::new();
    if let Some(value) = args.get("owner_addresses") {
        let values = value
            .as_array()
            .ok_or("owner_addresses must be a list of addresses")?;
        if values.len() > limits.participants {
            return Err("too many owner addresses".into());
        }
        for value in values {
            owners.insert(
                value
                    .as_str()
                    .and_then(normalize_address)
                    .ok_or("owner_addresses holds an invalid address")?,
            );
        }
    }
    let source_url = match args.get("source_url") {
        None => None,
        Some(Value::String(value))
            if tauri::Url::parse(value).is_ok_and(|url| {
                url.scheme() == "https" && url.username().is_empty() && url.password().is_none()
            }) && super::is_mail_url(value) =>
        {
            Some(value.clone())
        }
        Some(_) => return Err("source_url must be an https mail link".into()),
    };
    let rows = args
        .get("messages")
        .and_then(Value::as_array)
        .ok_or("messages must be a list")?;
    if rows.is_empty() || rows.len() > limits.messages {
        return Err(format!("a thread needs 1–{} messages", limits.messages));
    }
    let mut messages = Vec::new();
    let mut ids = BTreeSet::new();
    let mut participants = BTreeSet::new();
    let mut body_chars = 0usize;
    for raw in rows {
        let row = raw.as_object().ok_or("each message must be an object")?;
        let message_id = text(row, "id")?;
        if !id(message_id) {
            return Err("message id needs 1–128 letters, digits, - or _".into());
        }
        if !ids.insert(message_id.to_owned()) {
            return Err(format!("message {message_id} is repeated"));
        }
        if row.contains_key("bcc") {
            return Err(format!(
                "bcc is never cached. Leave it out of message {message_id}."
            ));
        }
        let body = row
            .get("body")
            .map(|value| value.as_str().ok_or("body must be plain text"))
            .transpose()?;
        body_chars = body_chars.saturating_add(body.map_or(0, |body| body.chars().count()));
        if body_chars > limits.bodies_chars_per_call {
            return Err(format!(
                "Message text exceeds {} characters in this call. Nothing was written.",
                limits.bodies_chars_per_call
            ));
        }
        if let Some(key) = row.keys().find(|key| {
            !["id", "from", "to", "cc", "date", "labels", "body"].contains(&key.as_str())
        }) {
            return Err(format!("message {message_id} has an unknown field: {key}"));
        }
        let from = parse_mailbox(text(row, "from")?, limits.name_chars)
            .ok_or_else(|| format!("message {message_id} has an invalid from address"))?;
        let to = mailboxes(row, "to", limits)?;
        let cc = mailboxes(row, "cc", limits)?;
        if 1 + to.len() + cc.len() > limits.addresses_per_message {
            return Err(format!(
                "message {message_id} has more than {} addresses",
                limits.addresses_per_message
            ));
        }
        let date = row
            .get("date")
            .and_then(date)
            .ok_or_else(|| format!("message {message_id} has an invalid date"))?;
        let labels = row
            .get("labels")
            .and_then(Value::as_array)
            .ok_or_else(|| format!("message {message_id} needs labels"))?;
        if labels.iter().any(|label| !label.is_string()) {
            return Err(format!("message {message_id} labels must be text"));
        }
        if labels.iter().any(|label| label.as_str() == Some("DRAFT")) {
            continue;
        }
        let sent = labels.iter().any(|label| label.as_str() == Some("SENT"));
        if sent {
            owners.insert(from.address.clone());
        }
        for mailbox in std::iter::once(&from).chain(&to).chain(&cc) {
            participants.insert(mailbox.address.clone());
        }
        if participants.len() > limits.participants {
            return Err(format!(
                "a thread holds at most {} participants",
                limits.participants
            ));
        }
        messages.push(Message {
            id: message_id.into(),
            from,
            to,
            cc,
            date,
            sent,
            body: body.map(str::to_owned),
        });
    }
    if messages.is_empty() {
        return Err("the thread has no messages after drafts are left out".into());
    }
    // Stable ordering preserves connector order when two timestamps are equal.
    messages.sort_by_key(|message| message.date);
    Ok(Thread {
        id: thread_id.into(),
        title,
        source_url,
        owners,
        messages,
    })
}

/// Text is separate from the header projection so a metadata refresh cannot
/// replace the text the person previously asked to keep.
pub fn build_text(
    thread: &Thread,
    actor: &str,
    fetched_at: &str,
    limits: &Limits,
) -> Option<Digest> {
    let messages: Vec<_> = thread
        .messages
        .iter()
        .filter(|message| message.body.is_some())
        .collect();
    if messages.is_empty() {
        return None;
    }
    let title = format!("{} (message text)", escape_vault_text(&thread.title));
    let mut fm = Map::new();
    fm.insert("type".into(), json!("Source"));
    fm.insert("title".into(), json!(title));
    fm.insert("source_id".into(), json!(thread.id));
    fm.insert(
        "source_kind".into(),
        json!(crate::policy::mail::table().kinds.text),
    );
    if let Some(url) = &thread.source_url {
        fm.insert("source_url".into(), json!(url));
    }
    fm.insert("fetched_at".into(), json!(fetched_at));
    fm.insert("generated".into(), json!({ "by": actor, "at": fetched_at }));
    fm.insert(
        "message_ids".into(),
        json!(messages
            .iter()
            .map(|message| &message.id)
            .collect::<Vec<_>>()),
    );
    let mut body = format!("# {title}\n");
    for message in &messages {
        let text = super::body::reply_text(
            &thread.title,
            message.body.as_deref().unwrap_or_default(),
            limits.body_chars,
        );
        body.push_str(&format!(
            "\n{}\n\n",
            message_header(message, &thread.owners)
        ));
        for line in text.split('\n') {
            body.push_str(&format!("> {line}\n"));
        }
    }
    Some(Digest {
        frontmatter: fm,
        body,
    })
}
pub fn escape_vault_text(value: &str) -> String {
    crate::files::extract::markdown::inert_line(value)
}
fn iso(date: DateTime<Utc>) -> String {
    date.to_rfc3339_opts(SecondsFormat::Secs, true)
}
fn person(mailbox: &Mailbox, owners: &BTreeSet<String>) -> String {
    if owners.contains(&mailbox.address) {
        return "you".into();
    }
    let address = escape_vault_text(&mailbox.address);
    match &mailbox.name {
        Some(name) => format!("{} ({address})", escape_vault_text(name)),
        None => address,
    }
}
pub fn message_header(message: &Message, owners: &BTreeSet<String>) -> String {
    let recipients = message
        .to
        .iter()
        .chain(&message.cc)
        .map(|mailbox| person(mailbox, owners))
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "**{} UTC** · {} → {}",
        message.date.format("%Y-%m-%d %H:%M"),
        person(&message.from, owners),
        if recipients.is_empty() {
            "recipient not recorded"
        } else {
            &recipients
        }
    )
}
pub fn build_digest(thread: &Thread, actor: &str, fetched_at: &str, has_text: bool) -> Digest {
    // parse_thread guarantees at least one non-draft message.
    let first = &thread.messages[0];
    let last = thread.messages.last().expect("a parsed thread is nonempty");
    let mut participants = BTreeSet::new();
    let mut sent_to = BTreeSet::new();
    for message in &thread.messages {
        for mailbox in std::iter::once(&message.from)
            .chain(&message.to)
            .chain(&message.cc)
        {
            participants.insert(mailbox.address.clone());
        }
        if message.sent {
            for mailbox in message.to.iter().chain(&message.cc) {
                if !thread.owners.contains(&mailbox.address) {
                    sent_to.insert(mailbox.address.clone());
                }
            }
        }
    }
    let mut fm = Map::new();
    fm.insert("type".into(), json!("Source"));
    fm.insert("title".into(), json!(escape_vault_text(&thread.title)));
    fm.insert("source_id".into(), json!(thread.id));
    fm.insert(
        "source_kind".into(),
        json!(crate::policy::mail::table().kinds.thread),
    );
    if let Some(url) = &thread.source_url {
        fm.insert("source_url".into(), json!(url));
    }
    fm.insert("fetched_at".into(), json!(fetched_at));
    fm.insert("generated".into(), json!({ "by": actor, "at": fetched_at }));
    fm.insert("participants".into(), json!(participants));
    fm.insert("sent_to".into(), json!(sent_to));
    fm.insert("owner_addresses".into(), json!(thread.owners));
    fm.insert(
        "message_ids".into(),
        json!(thread
            .messages
            .iter()
            .map(|message| &message.id)
            .collect::<Vec<_>>()),
    );
    fm.insert("last_message_id".into(), json!(last.id));
    fm.insert("message_count".into(), json!(thread.messages.len()));
    fm.insert("first_message_at".into(), json!(iso(first.date)));
    fm.insert("last_message_at".into(), json!(iso(last.date)));
    if let Some(message) = thread.messages.iter().rfind(|message| !message.sent) {
        fm.insert("last_inbound_at".into(), json!(iso(message.date)));
    }
    if let Some(message) = thread.messages.iter().rfind(|message| message.sent) {
        fm.insert("last_sent_at".into(), json!(iso(message.date)));
    }
    fm.insert("last_from".into(), json!(last.from.address));
    fm.insert("needs_reply".into(), json!(!last.sent));
    let lines = thread
        .messages
        .iter()
        .map(|message| message_header(message, &thread.owners))
        .collect::<Vec<_>>()
        .join("\n\n");
    let mut body = format!("# {}\n\nA header digest of a mail thread: who wrote to whom, and when. Message text is kept only when you ask for it in a conversation.\n\n{lines}\n", escape_vault_text(&thread.title));
    if has_text {
        body.push_str(&format!("\nMessage text: [[{}-text]]\n", thread.id));
    }
    Digest {
        frontmatter: fm,
        body,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const CASES: &str = include_str!("../../fixtures/thread-digests.json");
    fn limits(case: &Value) -> Limits {
        let mut limits = crate::policy::mail::table().limits.clone();
        if let Some(n) = case["limits"]["participants"].as_u64() {
            limits.participants = n as usize;
        }
        limits
    }
    fn outcome(case: &Value) -> Result<String, String> {
        let thread = parse_thread(case["input"].as_object().unwrap(), &limits(case))?;
        let digest = build_digest(
            &thread,
            "agent:mail-sweep",
            "2026-07-28T12:00:00Z",
            thread.messages.iter().any(|message| message.body.is_some()),
        );
        crate::vault::write::source_content(&digest.frontmatter, &digest.body)
    }
    fn text_outcome(case: &Value) -> Result<Option<String>, String> {
        let thread = parse_thread(case["input"].as_object().unwrap(), &limits(case))?;
        build_text(
            &thread,
            "agent:mail-sweep",
            "2026-07-28T12:00:00Z",
            &limits(case),
        )
        .map(|page| crate::vault::write::source_content(&page.frontmatter, &page.body))
        .transpose()
    }
    #[test]
    fn replays_the_thread_digest_cases() {
        let cases: Vec<Value> = serde_json::from_str(CASES).unwrap();
        for case in cases {
            match outcome(&case) {
                Ok(content) => assert_eq!(
                    content,
                    case["content"].as_str().unwrap(),
                    "{}",
                    case["name"]
                ),
                Err(error) => {
                    assert_eq!(error, case["refusal"].as_str().unwrap(), "{}", case["name"])
                }
            }
            if let Ok(Some(text)) = text_outcome(&case) {
                assert_eq!(
                    text,
                    case["text_content"].as_str().unwrap(),
                    "{}",
                    case["name"]
                );
                assert!(crate::vault::parse::wikilink_targets(&text).is_empty());
            }
        }
    }
    #[test]
    fn direction_comes_from_sent_only_and_drafts_never_reach_disk() {
        let cases: Vec<Value> = serde_json::from_str(CASES).unwrap();
        for (name, reply, sent) in [
            ("waiting-on-you", true, false),
            ("sent-only", false, true),
            ("two-people-replied", false, true),
        ] {
            let case = cases.iter().find(|case| case["name"] == name).unwrap();
            let thread = parse_thread(case["input"].as_object().unwrap(), &limits(case)).unwrap();
            let digest = build_digest(&thread, "agent:mail-sweep", "2026-07-28T12:00:00Z", false);
            assert_eq!(digest.frontmatter["needs_reply"], json!(reply));
            assert_eq!(digest.frontmatter.contains_key("last_sent_at"), sent);
            for key in ["labels", "bcc", "stale_after"] {
                assert!(!digest.frontmatter.contains_key(key));
            }
        }
        let case = cases
            .iter()
            .find(|case| case["name"] == "draft-dropped")
            .unwrap();
        assert!(!outcome(case).unwrap().contains("draft"));
    }
    #[test]
    fn mail_text_creates_no_link_task_or_date() {
        let raw = "[[Launch]] - [ ] @2026-07-28 📅 2026-07-28 :::toggle ``` <script>";
        let escaped = escape_vault_text(raw);
        assert!(crate::vault::parse::wikilink_targets(&escaped).is_empty());
        for token in ["- [ ]", "@2026", "📅", ":::toggle", "```", "<script>"] {
            assert!(!escaped.contains(token), "{token}");
        }
    }
    #[test]
    fn three_date_forms_name_the_same_instant() {
        let cases: Vec<Value> = serde_json::from_str(CASES).unwrap();
        let dates: Vec<_> = ["waiting-on-you", "rfc2822-date", "epoch-ms-date"]
            .iter()
            .map(|name| {
                let case = cases.iter().find(|case| case["name"] == *name).unwrap();
                parse_thread(case["input"].as_object().unwrap(), &limits(case))
                    .unwrap()
                    .messages[0]
                    .date
            })
            .collect();
        assert!(dates.windows(2).all(|pair| pair[0] == pair[1]));
    }
    #[test]
    #[ignore = "deliberately regenerate and review synthetic mail fixture bytes"]
    fn write_thread_digest_cases() {
        let mut cases: Vec<Value> = serde_json::from_str(CASES).unwrap();
        for case in &mut cases {
            let result = outcome(case);
            let text = text_outcome(case).ok().flatten();
            let row = case.as_object_mut().unwrap();
            row.shift_remove("content");
            row.shift_remove("refusal");
            row.shift_remove("text_content");
            if let Some(text) = text {
                row.insert("text_content".into(), json!(text));
            }
            match result {
                Ok(content) => {
                    row.insert("content".into(), json!(content));
                }
                Err(error) => {
                    row.insert("refusal".into(), json!(error));
                }
            }
        }
        let path =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/thread-digests.json");
        std::fs::write(
            path,
            format!("{}\n", serde_json::to_string_pretty(&cases).unwrap()),
        )
        .unwrap();
    }
}
