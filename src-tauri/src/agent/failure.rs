//! Typed failure notices (M56.4): the one classifier of how a run failed.
//!
//! Claude Code 2.1.250 types its failures. A reply it wrote itself after an
//! API error carries `error` (eleven values, `ASSISTANT_ERRORS`) and, for a
//! data-loss-prevention refusal, `api_error`; `rate_limit_event` carries the
//! usage window's `status`, `resetsAt` and `rateLimitType`; `system/api_retry`
//! names each retried error; the result names `terminal_reason` and its
//! subtype. A session file's API-error line carries the same `error`, with
//! `quotaLimits` in place of the stream's limit event. This module reads those
//! fields, and only those, into a `FailureNotice`: a kind, the words the panel
//! shows, and the one action that would fix it. No text is matched. A failure
//! it cannot type has no notice and keeps its raw text, which the card shows
//! anyway.
//!
//! Pure: no I/O. The fold (`super::fold`) owns a `Failures` for each turn and
//! feeds it the lines it already reads, so a turn watched live and a thread
//! rebuilt from the session file get the same notice; the init gate
//! (`super::InitGate`) makes the tools notice, since M57.2 the ask-first
//! one, and since M91.2b its two stops for what Claude Code offered beyond
//! the run's plan: an unknown built-in and an unexpected agent type. TS
//! renders these words and never switches on the kind (D3).

use chrono::{DateTime, SecondsFormat};
use serde::Serialize;
use serde_json::Value;

/// How a run failed, as far as Claude Code's typed fields say. Closed: a
/// failure that fits none has no notice.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FailureKind {
    NotSignedIn,
    AccountBlocked,
    UsageLimit,
    RateLimited,
    OutOfCredits,
    ServiceUnavailable,
    ModelUnavailable,
    ContextFull,
    RequestRefused,
    ToolsUnavailable,
    TurnLimit,
    /// A run whose plan asks before running commands started in another
    /// permission mode or on an older Claude Code (M57.2, the init gate).
    AskUnavailable,
    /// Claude Code offered a built-in the tool manifest has no row for
    /// (M91.1, the init gate).
    UnknownTool,
    /// A run that holds the subagent tool was offered an agent type its
    /// argv neither allows nor denies (M91.2b, the init gate).
    UnexpectedAgentType,
}

impl FailureKind {
    /// Every kind, in declaration order.
    pub const ALL: [FailureKind; 14] = [
        FailureKind::NotSignedIn,
        FailureKind::AccountBlocked,
        FailureKind::UsageLimit,
        FailureKind::RateLimited,
        FailureKind::OutOfCredits,
        FailureKind::ServiceUnavailable,
        FailureKind::ModelUnavailable,
        FailureKind::ContextFull,
        FailureKind::RequestRefused,
        FailureKind::ToolsUnavailable,
        FailureKind::TurnLimit,
        FailureKind::AskUnavailable,
        FailureKind::UnknownTool,
        FailureKind::UnexpectedAgentType,
    ];

    /// Does this failure pause unattended work (the meter's `quota_failed`)?
    /// Only the three that say the account has run out for now.
    pub fn is_quota(self) -> bool {
        matches!(
            self,
            FailureKind::UsageLimit | FailureKind::RateLimited | FailureKind::OutOfCredits
        )
    }

    /// The fix the card offers, when there is one.
    pub fn action(self) -> Option<NoticeAction> {
        match self {
            FailureKind::NotSignedIn
            | FailureKind::AccountBlocked
            | FailureKind::AskUnavailable => Some(NoticeAction::OpenSettings),
            FailureKind::ModelUnavailable => Some(NoticeAction::ChooseModel),
            FailureKind::ContextFull => Some(NoticeAction::NewConversation),
            _ => None,
        }
    }

    fn title(self) -> &'static str {
        match self {
            FailureKind::NotSignedIn => "Claude Code isn't signed in",
            FailureKind::AccountBlocked => "Claude Code can't use this account",
            FailureKind::UsageLimit => "You've reached your Claude usage limit",
            FailureKind::RateLimited => "Claude is limiting requests",
            FailureKind::OutOfCredits => "No Claude usage left",
            FailureKind::ServiceUnavailable => "Claude is unavailable right now",
            FailureKind::ModelUnavailable => "That model isn't available",
            FailureKind::ContextFull => "This conversation is too long",
            FailureKind::RequestRefused => "Your organization's policy refused this request",
            FailureKind::ToolsUnavailable => "Cerebro's tools didn't load",
            FailureKind::TurnLimit => "The run reached its turn limit",
            FailureKind::AskUnavailable => "This run couldn't ask first",
            FailureKind::UnknownTool => "Claude Code offered a tool Cerebro doesn't know",
            FailureKind::UnexpectedAgentType => "Claude Code offered an agent Cerebro doesn't know",
        }
    }
}

/// What the card's button does. TS draws a button only for an action it has
/// a handler for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NoticeAction {
    OpenSettings,
    NewConversation,
    ChooseModel,
}

/// One failure, worded. Every field crosses to the panel as it is; the
/// optional ones cross as null.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FailureNotice {
    pub kind: FailureKind,
    pub title: String,
    pub body: String,
    pub action: Option<NoticeAction>,
    /// When the limit resets, RFC 3339 in UTC, when Claude Code said.
    pub resets_at: Option<String>,
    /// The limit's window in words ("5-hour", "weekly"), when it named one.
    pub window: Option<String>,
    /// The Claude Code version that reported it, when known.
    pub cli_version: Option<String>,
}

/// The eleven values CLI 2.1.250's assistant `error` field takes.
pub const ASSISTANT_ERRORS: [&str; 11] = [
    "authentication_failed",
    "oauth_org_not_allowed",
    "account_on_hold",
    "billing_error",
    "rate_limit",
    "overloaded",
    "invalid_request",
    "model_not_found",
    "server_error",
    "unknown",
    "max_output_tokens",
];

/// The one mapping from a typed error to a kind. `rejected` says this run saw
/// a rejected usage limit (the stream's `rate_limit_info.status` or the
/// session file's `quotaLimits.status`), which makes a `rate_limit` a usage
/// limit rather than a brief throttle. `invalid_request`, `unknown`,
/// `max_output_tokens` and any value this build does not know give none, so
/// the raw text stays.
pub fn kind_of(code: &str, rejected: bool) -> Option<FailureKind> {
    match code {
        "authentication_failed" => Some(FailureKind::NotSignedIn),
        "oauth_org_not_allowed" | "account_on_hold" => Some(FailureKind::AccountBlocked),
        "billing_error" => Some(FailureKind::OutOfCredits),
        "rate_limit" if rejected => Some(FailureKind::UsageLimit),
        "rate_limit" => Some(FailureKind::RateLimited),
        "overloaded" | "server_error" => Some(FailureKind::ServiceUnavailable),
        "model_not_found" => Some(FailureKind::ModelUnavailable),
        "dlp_request_denied" => Some(FailureKind::RequestRefused),
        _ => None,
    }
}

/// A result's `terminal_reason` or error subtype, as a kind. The aborts
/// (`aborted_streaming`, `aborted_tools`) and every other reason give none.
fn terminal_kind(terminal_reason: Option<&str>, subtype: Option<&str>) -> Option<FailureKind> {
    match terminal_reason {
        Some("prompt_too_long" | "blocking_limit") => return Some(FailureKind::ContextFull),
        Some("max_turns") => return Some(FailureKind::TurnLimit),
        _ => {}
    }
    (subtype == Some("error_max_turns")).then_some(FailureKind::TurnLimit)
}

/// A limit's `rateLimitType` in words, for "your {window} limit".
pub fn window_words(rate_limit_type: &str) -> Option<&'static str> {
    match rate_limit_type {
        "five_hour" => Some("5-hour"),
        "seven_day" | "seven_day_overage_included" => Some("weekly"),
        "seven_day_opus" => Some("weekly Opus"),
        "seven_day_sonnet" => Some("weekly Sonnet"),
        "overage" => Some("extra-usage"),
        _ => None,
    }
}

/// A session file's retried API error as 2.1.250 types it for the stream's
/// `api_retry`: by its HTTP status (the bundle's own rule).
fn retried_code(error: &Value) -> Option<String> {
    if let Some(code) = error.as_str() {
        return Some(code.to_string());
    }
    let status = error.get("status").and_then(Value::as_u64);
    let overloaded = error
        .get("message")
        .and_then(Value::as_str)
        .is_some_and(|m| m.contains("\"type\":\"overloaded_error\""));
    let code = match status {
        Some(529) => "overloaded",
        _ if overloaded => "overloaded",
        Some(429) => "rate_limit",
        Some(401 | 403) => "authentication_failed",
        Some(status) if status >= 408 => "server_error",
        _ => "unknown",
    };
    Some(code.to_string())
}

/// The sentence the init gate's error says (M54.5, Appendix C), which is
/// also the tools notice's body.
pub(crate) fn init_refusal(word: &str) -> String {
    format!(
        "Cerebro's tools did not load for this run (Claude Code reported them as {word}), so the run was stopped before it could answer without them. Try again; if it repeats, restart Cerebro."
    )
}

/// The copy, in one place: each kind's body.
fn body(kind: FailureKind, window: Option<&str>) -> String {
    match kind {
        FailureKind::NotSignedIn => "Cerebro runs your own Claude Code, and it has no sign-in on this Mac. Open Terminal, run claude, and type /login. Then try again.".into(),
        FailureKind::AccountBlocked => "Claude Code is signed in to an account that can't run requests right now: its organization doesn't allow this sign-in, or the account is on hold. Open Terminal, run claude, and type /login to use another account.".into(),
        FailureKind::UsageLimit => match window {
            Some(window) => format!("Claude Code stopped because your {window} limit is used up. Background work waits until then."),
            None => "Claude Code stopped because your usage limit is used up. Background work waits until then.".into(),
        },
        FailureKind::RateLimited => "Claude turned this request away after Claude Code's own retries. Wait a few minutes, then try again. Background work pauses for a while.".into(),
        FailureKind::OutOfCredits => "Your Claude account has no usage left to spend. Add usage, or wait for your plan to renew, then try again. Background work waits too.".into(),
        FailureKind::ServiceUnavailable => "Claude's servers are overloaded or failing, and Claude Code's retries ran out. Try again in a few minutes.".into(),
        FailureKind::ModelUnavailable => "Claude Code couldn't use the model this run asked for. Choose another model, or leave it to Claude Code's default.".into(),
        FailureKind::ContextFull => "This conversation has grown past what the model can read at once. Start a new conversation to keep going.".into(),
        FailureKind::RequestRefused => "Your organization's data-loss-prevention policy refused what this run would have sent. Ask again without the material it guards.".into(),
        FailureKind::ToolsUnavailable => init_refusal("unreported"),
        FailureKind::TurnLimit => "The run used every turn it was allowed before it finished. Ask again to carry on from where it stopped.".into(),
        FailureKind::AskUnavailable => crate::policy::tool_approval::messages().mode_mismatch.clone(),
        FailureKind::UnknownTool | FailureKind::UnexpectedAgentType => unknown_tool_words(UNNAMED),
    }
}

/// What the two offer stops say when they name nothing, which no stop does:
/// each names what Claude Code offered (`unknown_tool`,
/// `unexpected_agent_type`).
const UNNAMED: &str = "one it did not name";

/// The table's words for a stop over something Claude Code offered beyond
/// the run's plan (M91.1): `messages.unknown_tool`, naming `tool`.
pub(crate) fn unknown_tool_words(tool: &str) -> String {
    crate::policy::tool_approval::messages()
        .unknown_tool
        .replace("{tool}", tool)
}

/// The notice for `kind`.
pub fn notice(
    kind: FailureKind,
    window: Option<&str>,
    resets_at: Option<i64>,
    cli_version: Option<&str>,
) -> FailureNotice {
    let quota = kind == FailureKind::UsageLimit;
    FailureNotice {
        kind,
        title: kind.title().into(),
        body: body(kind, window),
        action: kind.action(),
        resets_at: resets_at
            .filter(|_| quota)
            .and_then(|secs| DateTime::from_timestamp(secs, 0))
            .map(|at| at.to_rfc3339_opts(SecondsFormat::Secs, true)),
        window: window.filter(|_| quota).map(str::to_string),
        cli_version: cli_version.map(str::to_string),
    }
}

/// The tools notice the init gate attaches (M54.5): `word` is the status
/// Claude Code reported for cerebro's server.
pub fn tools_unavailable(word: &str, cli_version: Option<&str>) -> FailureNotice {
    FailureNotice {
        body: init_refusal(word),
        ..notice(FailureKind::ToolsUnavailable, None, None, cli_version)
    }
}

/// The notice the init gate attaches to a run that had to ask first and
/// could not (M57.2): `message` is the table's `mode_mismatch`.
pub fn ask_unavailable(message: &str, cli_version: Option<&str>) -> FailureNotice {
    FailureNotice {
        body: message.to_string(),
        ..notice(FailureKind::AskUnavailable, None, None, cli_version)
    }
}

/// The notice the init gate attaches to a run whose init offered a built-in
/// the manifest has no row for (M91.1): `message` is the table's
/// `unknown_tool`, naming it.
pub fn unknown_tool(message: &str, cli_version: Option<&str>) -> FailureNotice {
    FailureNotice {
        body: message.to_string(),
        ..notice(FailureKind::UnknownTool, None, None, cli_version)
    }
}

/// The notice the init gate attaches to a run that holds the subagent tool
/// and whose init listed an agent type its argv neither allows nor denies
/// (M91.2b): `message` is the table's `unknown_tool`, naming the type as
/// its deny rule would (`super::cli_agents::agent_type_rule`).
pub fn unexpected_agent_type(message: &str, cli_version: Option<&str>) -> FailureNotice {
    FailureNotice {
        body: message.to_string(),
        ..notice(FailureKind::UnexpectedAgentType, None, None, cli_version)
    }
}

/// What one turn's lines have said about how it failed, accumulated as the
/// fold reads them.
#[derive(Debug, Clone, Default)]
pub struct Failures {
    /// The turn failed: an API-error reply, a result marked `is_error`, or an
    /// error subtype. No notice exists before this.
    failed: bool,
    /// A rejected usage limit was seen, with its window and reset.
    rejected: bool,
    rate_limit_type: Option<String>,
    resets_at: Option<i64>,
    /// The last API-error reply's typed code, when one arrived.
    api_error: Option<Option<String>>,
    /// The result's terminal reason, as a kind.
    terminal: Option<FailureKind>,
    /// The last retried error's code.
    retry: Option<String>,
}

fn str_of<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn flag(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(false)
}

/// Is `line` a reply Claude Code wrote itself for an API error? Both
/// spellings: the stream's `is_api_error_message`, the file's
/// `isApiErrorMessage`.
pub(crate) fn is_api_error_line(line: &Value) -> bool {
    str_of(line, "type") == Some("assistant")
        && (flag(line, "isApiErrorMessage")
            || flag(line, "is_api_error_message")
            || line.get("error").is_some_and(Value::is_string))
}

impl Failures {
    /// Read one line of either format: the stream's limit event, retries and
    /// result, the file's retried errors, and an API-error reply from both.
    pub fn observe(&mut self, line: &Value) {
        match str_of(line, "type") {
            Some("rate_limit_event") => {
                if let Some(info) = line.get("rate_limit_info") {
                    self.limit(info);
                }
            }
            Some("system") => match str_of(line, "subtype") {
                Some("api_retry") => {
                    self.retry = line.get("error").and_then(retried_code);
                }
                Some("api_error") => {
                    self.retry = line.get("error").and_then(retried_code);
                }
                _ => {}
            },
            Some("assistant") if is_api_error_line(line) => {
                self.failed = true;
                if let Some(limits) = line.get("quotaLimits") {
                    self.limit(limits);
                }
                // A data-loss-prevention refusal says so beside a plain code.
                let code = match str_of(line, "api_error") {
                    Some("dlp_request_denied") => Some("dlp_request_denied".to_string()),
                    _ => str_of(line, "error").map(str::to_string).or_else(|| {
                        line.get("apiErrorStatus")
                            .or_else(|| line.get("api_error_status"))
                            .and_then(|status| {
                                retried_code(&serde_json::json!({ "status": status }))
                            })
                    }),
                };
                self.api_error = Some(code);
            }
            Some("result") => {
                let subtype = str_of(line, "subtype");
                if flag(line, "is_error") || subtype.is_some_and(|s| s.starts_with("error_")) {
                    self.failed = true;
                }
                self.terminal = terminal_kind(str_of(line, "terminal_reason"), subtype);
            }
            _ => {}
        }
    }

    /// A limit's state: the stream's `rate_limit_info` or the file's
    /// `quotaLimits`. Only a rejected one is kept.
    fn limit(&mut self, info: &Value) {
        if str_of(info, "status") != Some("rejected") {
            return;
        }
        self.rejected = true;
        self.rate_limit_type = str_of(info, "rateLimitType").map(str::to_string);
        self.resets_at = info.get("resetsAt").and_then(Value::as_i64);
    }

    /// The failure's kind: the last API-error reply's, else the result's
    /// terminal reason or subtype, else (when no API-error reply arrived) the
    /// last retried error's. None before the turn failed.
    pub fn kind(&self) -> Option<FailureKind> {
        if !self.failed {
            return None;
        }
        let from_reply = self
            .api_error
            .as_ref()
            .and_then(|code| code.as_deref())
            .and_then(|code| kind_of(code, self.rejected));
        from_reply.or(self.terminal).or_else(|| {
            if self.api_error.is_some() {
                return None;
            }
            self.retry
                .as_deref()
                .and_then(|code| kind_of(code, self.rejected))
        })
    }

    /// The notice for this turn's failure, when it failed in a typed way.
    pub fn notice(&self, cli_version: Option<&str>) -> Option<FailureNotice> {
        let kind = self.kind()?;
        let window = self.rate_limit_type.as_deref().and_then(window_words);
        Some(notice(kind, window, self.resets_at, cli_version))
    }

    /// Did this turn fail for want of quota?
    pub fn is_quota(&self) -> bool {
        self.kind().is_some_and(FailureKind::is_quota)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::path::{Path, PathBuf};

    fn fixtures() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/cli-stream")
    }

    /// A fixture's lines: a `.jsonl` one a line each; a `.json` array, an
    /// `{events}` wrapper, or a history line's `{recorded, line}`.
    fn lines(name: &str) -> Vec<Value> {
        let path = fixtures().join(name);
        let text = std::fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("{}: {error}", path.display()));
        if name.ends_with(".jsonl") {
            return text
                .lines()
                .filter(|line| !line.trim().is_empty())
                .map(|line| serde_json::from_str(line).unwrap())
                .collect();
        }
        match serde_json::from_str::<Value>(&text).unwrap() {
            Value::Array(lines) => lines,
            Value::Object(mut wrapper) if wrapper.contains_key("events") => {
                match wrapper.remove("events") {
                    Some(Value::Array(lines)) => lines,
                    _ => panic!("{name}: events is not an array"),
                }
            }
            Value::Object(mut wrapper) if wrapper.contains_key("line") => {
                vec![wrapper.remove("line").unwrap()]
            }
            line => vec![line],
        }
    }

    /// What a run's lines classify to, as the fold sees them: the init's CLI
    /// version, or a session line's own.
    fn classify(lines: &[Value]) -> Option<FailureNotice> {
        let mut failures = Failures::default();
        let mut version = None;
        for line in lines {
            version = version.or_else(|| {
                str_of(line, "claude_code_version")
                    .or_else(|| str_of(line, "version"))
                    .map(str::to_string)
            });
            failures.observe(line);
        }
        failures.notice(version.as_deref())
    }

    fn api_error(code: &str) -> Value {
        json!({ "type": "assistant", "error": code, "is_api_error_message": true,
            "message": { "model": "<synthetic>", "content": [{ "type": "text", "text": "x" }] } })
    }

    #[test]
    fn the_assistant_error_enum_maps_to_its_kinds() {
        let expected = [
            ("authentication_failed", Some(FailureKind::NotSignedIn)),
            ("oauth_org_not_allowed", Some(FailureKind::AccountBlocked)),
            ("account_on_hold", Some(FailureKind::AccountBlocked)),
            ("billing_error", Some(FailureKind::OutOfCredits)),
            ("rate_limit", Some(FailureKind::RateLimited)),
            ("overloaded", Some(FailureKind::ServiceUnavailable)),
            ("invalid_request", None),
            ("model_not_found", Some(FailureKind::ModelUnavailable)),
            ("server_error", Some(FailureKind::ServiceUnavailable)),
            ("unknown", None),
            ("max_output_tokens", None),
        ];
        assert_eq!(
            expected.map(|(code, _)| code),
            ASSISTANT_ERRORS,
            "CLI 2.1.250's eleven values, in its order"
        );
        for (code, kind) in expected {
            assert_eq!(kind_of(code, false), kind, "{code}");
            let mut failures = Failures::default();
            failures.observe(&api_error(code));
            assert_eq!(failures.kind(), kind, "{code} on a reply");
        }
        assert_eq!(kind_of("rate_limit", true), Some(FailureKind::UsageLimit));
        assert_eq!(
            kind_of("teleport_failed", false),
            None,
            "drift keeps its raw text"
        );
    }

    #[test]
    fn a_rejected_limit_names_its_reset_and_window() {
        let notice = classify(&lines("usage-limit-stream.json")).expect("a notice");
        assert_eq!(notice.kind, FailureKind::UsageLimit);
        assert_eq!(notice.title, "You've reached your Claude usage limit");
        assert_eq!(
            notice.body,
            "Claude Code stopped because your weekly limit is used up. Background work waits until then."
        );
        assert_eq!(notice.resets_at.as_deref(), Some("2026-01-01T00:00:00Z"));
        assert_eq!(notice.window.as_deref(), Some("weekly"));
        assert_eq!(notice.cli_version.as_deref(), Some("2.1.250"));
        assert_eq!(notice.action, None);
    }

    #[test]
    fn real_jsonl_limit_lines_classify_with_their_reset() {
        for (name, window) in [
            ("jsonl/usage-limit-5h.json", "5-hour"),
            ("jsonl/usage-limit-weekly.json", "weekly"),
        ] {
            let notice = classify(&lines(name)).expect(name);
            assert_eq!(notice.kind, FailureKind::UsageLimit, "{name}");
            assert_eq!(notice.window.as_deref(), Some(window), "{name}");
            assert_eq!(
                notice.resets_at.as_deref(),
                Some("2026-01-01T00:00:00Z"),
                "{name}"
            );
            assert!(
                notice.body.contains(&format!("your {window} limit")),
                "{name}"
            );
        }
    }

    #[test]
    fn the_not_signed_in_recording_asks_for_settings() {
        for name in [
            "real/spike-not-signed-in.stream.jsonl",
            "real/spike-not-signed-in.session.jsonl",
        ] {
            let notice = classify(&lines(name)).expect(name);
            assert_eq!(notice.kind, FailureKind::NotSignedIn, "{name}");
            assert_eq!(notice.title, "Claude Code isn't signed in");
            assert_eq!(notice.action, Some(NoticeAction::OpenSettings));
            assert_eq!(notice.cli_version.as_deref(), Some("2.1.250"));
            assert!(notice.body.ends_with("type /login. Then try again."));
        }
    }

    #[test]
    fn a_good_run_with_an_allowed_limit_event_has_no_notice() {
        let lines = lines("real/scripted-bash.stream.jsonl");
        assert!(
            lines
                .iter()
                .any(|l| str_of(l, "type") == Some("rate_limit_event")),
            "the recording shows an allowed limit event"
        );
        assert_eq!(classify(&lines), None);
        // Not even a rejected limit makes a notice on a run that did not fail.
        let mut failures = Failures::default();
        failures.observe(&json!({ "type": "rate_limit_event",
            "rate_limit_info": { "status": "rejected", "rateLimitType": "five_hour" } }));
        failures.observe(&json!({ "type": "result", "subtype": "success", "is_error": false }));
        assert_eq!(failures.notice(None), None);
        assert!(!failures.is_quota());
    }

    #[test]
    fn a_rate_limit_without_a_rejected_status_is_rate_limited() {
        let mut failures = Failures::default();
        failures.observe(&json!({ "type": "rate_limit_event",
            "rate_limit_info": { "status": "allowed_warning", "rateLimitType": "five_hour",
                "resetsAt": 1767225600 } }));
        failures.observe(&api_error("rate_limit"));
        let notice = failures.notice(Some("2.1.250")).unwrap();
        assert_eq!(notice.kind, FailureKind::RateLimited);
        assert_eq!(notice.title, "Claude is limiting requests");
        assert_eq!(
            (notice.resets_at, notice.window),
            (None, None),
            "a throttle has no reset to name"
        );
    }

    #[test]
    fn terminal_reasons_and_subtypes_map() {
        let result = |terminal: Option<&str>, subtype: &str| {
            let mut failures = Failures::default();
            failures.observe(
                &json!({ "type": "result", "subtype": subtype, "is_error": true,
                "terminal_reason": terminal }),
            );
            failures.kind()
        };
        assert_eq!(
            result(Some("prompt_too_long"), "success"),
            Some(FailureKind::ContextFull)
        );
        assert_eq!(
            result(Some("blocking_limit"), "success"),
            Some(FailureKind::ContextFull)
        );
        assert_eq!(
            result(Some("max_turns"), "error_max_turns"),
            Some(FailureKind::TurnLimit)
        );
        assert_eq!(
            result(None, "error_max_turns"),
            Some(FailureKind::TurnLimit)
        );
        for reason in [
            "aborted_streaming",
            "aborted_tools",
            "api_error",
            "completed",
        ] {
            assert_eq!(
                result(Some(reason), "error_during_execution"),
                None,
                "{reason}"
            );
        }
        // The recorded max-turns run says so in both fields.
        let notice = classify(&lines("real/scripted-max-turns.stream.jsonl")).unwrap();
        assert_eq!(notice.kind, FailureKind::TurnLimit);
        // A context-full turn often arrives as an invalid_request reply: the
        // reply has no kind, so the terminal reason names it.
        let mut failures = Failures::default();
        failures.observe(&api_error("invalid_request"));
        failures.observe(
            &json!({ "type": "result", "subtype": "success", "is_error": true,
            "terminal_reason": "prompt_too_long" }),
        );
        assert_eq!(failures.kind(), Some(FailureKind::ContextFull));
        assert_eq!(
            failures.notice(None).unwrap().action,
            Some(NoticeAction::NewConversation)
        );
    }

    #[test]
    fn api_retry_exhaustion_is_service_unavailable() {
        let mut failures = Failures::default();
        for attempt in 1..=10 {
            failures.observe(&json!({ "type": "system", "subtype": "api_retry",
                "attempt": attempt, "max_retries": 10, "error_status": 529, "error": "overloaded" }));
        }
        assert_eq!(failures.kind(), None, "retrying is not failing");
        failures.observe(
            &json!({ "type": "result", "subtype": "error_during_execution",
            "is_error": true, "terminal_reason": "api_error" }),
        );
        assert_eq!(failures.kind(), Some(FailureKind::ServiceUnavailable));
        // The session file's retried error carries the HTTP status instead.
        let mut failures = Failures::default();
        failures.observe(&json!({ "type": "system", "subtype": "api_error",
            "error": { "status": 503 } }));
        failures.observe(&json!({ "type": "result", "is_error": true, "subtype": "success" }));
        assert_eq!(failures.kind(), Some(FailureKind::ServiceUnavailable));
        // An API-error reply that arrived outranks the retries, even with no kind.
        failures.observe(&api_error("unknown"));
        assert_eq!(failures.kind(), None);
    }

    #[test]
    fn dlp_refusal_is_request_refused() {
        let mut failures = Failures::default();
        failures.observe(&json!({ "type": "assistant", "is_api_error_message": true,
            "error": "invalid_request", "api_error": "dlp_request_denied",
            "message": { "model": "<synthetic>", "content": [] } }));
        let notice = failures.notice(None).unwrap();
        assert_eq!(notice.kind, FailureKind::RequestRefused);
        assert_eq!(
            notice.title,
            "Your organization's policy refused this request"
        );
    }

    #[test]
    fn quota_kinds_are_exactly_three() {
        let quota: Vec<FailureKind> = FailureKind::ALL
            .into_iter()
            .filter(|kind| kind.is_quota())
            .collect();
        assert_eq!(
            quota,
            [
                FailureKind::UsageLimit,
                FailureKind::RateLimited,
                FailureKind::OutOfCredits
            ]
        );
    }

    #[test]
    fn the_tools_notice_carries_the_init_refusal() {
        let notice = tools_unavailable("failed", Some("2.1.250"));
        assert_eq!(notice.kind, FailureKind::ToolsUnavailable);
        assert_eq!(notice.title, "Cerebro's tools didn't load");
        assert_eq!(notice.body, init_refusal("failed"));
        assert_eq!(notice.action, None);
    }

    // M91.2b: the two offer stops have kinds of their own, worded by the
    // tool-approval table and titled here; neither has a fix the panel can
    // offer, and neither pauses unattended work.
    #[test]
    fn the_offer_stops_have_their_own_kinds() {
        let tool = unknown_tool_words("Teleport");
        assert!(tool.starts_with("Claude Code offered a tool Cerebro doesn't know: Teleport."));
        let notice = unknown_tool(&tool, Some("2.1.250"));
        assert_eq!(notice.kind, FailureKind::UnknownTool);
        assert_eq!(
            notice.title,
            "Claude Code offered a tool Cerebro doesn't know"
        );
        assert_eq!(notice.body, tool);
        assert_eq!(notice.action, None);
        assert_eq!(notice.cli_version.as_deref(), Some("2.1.250"));
        let agent = unknown_tool_words(&super::super::cli_agents::agent_type_rule("gsd-planner"));
        let notice = unexpected_agent_type(&agent, None);
        assert_eq!(notice.kind, FailureKind::UnexpectedAgentType);
        assert_eq!(
            notice.title,
            "Claude Code offered an agent Cerebro doesn't know"
        );
        assert!(
            notice.body.contains("Agent(gsd-planner)"),
            "{}",
            notice.body
        );
        assert_eq!(notice.action, None);
        for kind in [FailureKind::UnknownTool, FailureKind::UnexpectedAgentType] {
            assert!(!kind.is_quota());
            assert!(!notice_body(kind).contains("{tool}"), "{kind:?}");
            assert_eq!(
                serde_json::to_value(kind).unwrap(),
                json!(match kind {
                    FailureKind::UnknownTool => "unknown_tool",
                    _ => "unexpected_agent_type",
                })
            );
        }
    }

    fn notice_body(kind: FailureKind) -> String {
        notice(kind, None, None, None).body
    }

    #[test]
    fn ask_unavailable_maps_with_open_settings() {
        let message = &crate::policy::tool_approval::messages().mode_mismatch;
        let notice = ask_unavailable(message, Some("2.1.249"));
        assert_eq!(notice.kind, FailureKind::AskUnavailable);
        assert_eq!(notice.title, "This run couldn't ask first");
        assert_eq!(&notice.body, message);
        assert_eq!(notice.action, Some(NoticeAction::OpenSettings));
        assert_eq!(notice.cli_version.as_deref(), Some("2.1.249"));
        assert!(!FailureKind::AskUnavailable.is_quota(), "it pauses nothing");
    }

    // --- The golden ---------------------------------------------------------

    /// Every failure fixture, and the good run that must stay quiet.
    const GOLDEN_CASES: &[&str] = &[
        "real/spike-not-signed-in.stream.jsonl",
        "real/spike-not-signed-in.session.jsonl",
        "real/scripted-max-turns.stream.jsonl",
        "real/scripted-bash.stream.jsonl",
        "usage-limit-stream.json",
        "jsonl/usage-limit-5h.json",
        "jsonl/usage-limit-weekly.json",
        "transcript-api-error.stream.json",
        "transcript-api-error.session.json",
    ];

    fn golden_path() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../conformance/failure/notices.json")
    }

    fn golden() -> Value {
        let notices: serde_json::Map<String, Value> = GOLDEN_CASES
            .iter()
            .map(|name| {
                (
                    name.to_string(),
                    serde_json::to_value(classify(&lines(name))).unwrap(),
                )
            })
            .collect();
        json!({
            "cli_version": super::super::transcript::CLI_VERSION,
            "notices": notices,
        })
    }

    #[test]
    fn the_failure_notices_golden_is_current() {
        let path = golden_path();
        let committed: Value = serde_json::from_str(
            &std::fs::read_to_string(&path).unwrap_or_else(|_| {
                panic!(
                    "{} is missing: cargo test --manifest-path src-tauri/Cargo.toml --lib agent::failure::tests::write_failure_notices -- --ignored, then prettier",
                    path.display()
                )
            }),
        )
        .unwrap();
        // Parsed, not byte-compared: prettier formats the file.
        assert!(
            committed == golden(),
            "{} is stale: cargo test --manifest-path src-tauri/Cargo.toml --lib agent::failure::tests::write_failure_notices -- --ignored, then prettier",
            path.display()
        );
    }

    #[test]
    #[ignore = "rewrites conformance/failure/notices.json; run on purpose, then prettier"]
    fn write_failure_notices() {
        let path = golden_path();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut bytes = serde_json::to_string_pretty(&golden()).unwrap();
        bytes.push('\n');
        std::fs::write(path, bytes).unwrap();
    }
}
