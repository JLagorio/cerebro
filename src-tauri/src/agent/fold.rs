//! One fold over Claude Code's two formats (M56.3).
//!
//! The live stream (`--output-format stream-json`) and the session file the
//! CLI writes for the same turns (`transcript.rs`) carry the same assistant
//! and user lines, framed differently: the stream adds `system/init`, deltas
//! and a `result`, and the file adds the prompts, queue and bookkeeping
//! records. `TranscriptFold` reads either, a line at a time, into the one
//! event vocabulary the panel renders, so a thread restored from the file and
//! a turn watched live are reduced by the same code (`src/agent/transcript.ts`).
//!
//! The rules, as CLI 2.1.250 writes its lines:
//!
//! - Assistant lines group by `message.id`: the CLI writes one line per
//!   content block, all under one id. A text or tool call already folded for
//!   the message is not folded again.
//! - A turn ends once, at its end: the stream's `result`, the next prompt, or
//!   `finish`. A stop reason is read when its message closes, so a Stop-hook
//!   continuation (a second message after a terminal one) does not end the
//!   turn early. A message line may carry `stop_reason: null` (the stream
//!   writes each block's line before `message_delta` names the reason); a turn
//!   whose last message asked for no tool and said something then reads as
//!   ended, with no stop reason recorded.
//! - A turn that never ends (a killed run, a file cut off mid-turn) reads
//!   `TurnInterrupted { cut_off }`; an interrupt marker reads `stopped`.
//! - A turn a PreToolUse hook deferred is suspended, not ended (M57.1): the
//!   stream's result carrying `deferred_tool_use`, and the session file's
//!   `hook_deferred_tool` attachment, fold to one `ToolDeferred` and nothing
//!   else, no Result and no TurnEnded. A suspended turn that never goes on
//!   ends silently; the next line of its own (the resumed call's result, or
//!   a reply) takes it up again.
//! - Sidechain lines (subagents) and repeated uuids are skipped. A
//!   `<synthetic>` line is never a model or a reply: an API error becomes one
//!   `Error` per turn, and any other placeholder is skipped.
//! - A turn that failed carries a notice on its `Error` when Claude Code's
//!   typed fields say how (M56.4, `super::failure`): the turn's `Failures`
//!   reads the limit events, retries, API-error replies and the result the
//!   fold already sees, in either format.
//! - A tool call's input and result cross as previews: each long input
//!   string cut, a result cut at 2000 characters. When a preview cut
//!   something, the whole follows as a `ToolPayload` (M56.8), up to
//!   `PAYLOAD_LIMIT_BYTES`, so a card can show all of it while previews keep
//!   every other reader (the run log, the gate) small. Both formats hold the
//!   same blocks, so they carry the same payloads.
//! - The fold never fails. A line it cannot classify is counted as
//!   `Unclassified` by kind (`super::kinds` is the one table of kinds and the
//!   reasons each ignored one is safe to drop), and the tests are strict
//!   about it: every recorded line classifies.

use std::collections::{BTreeMap, HashSet};

use serde::Serialize;
use serde_json::Value;

use super::failure::{self, Failures};
use super::kinds;
use super::{AgentEvent, PayloadPart};

/// What the fold made of one line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LineClass {
    /// Read into events (possibly none, when it repeated what was folded).
    Translated,
    /// Dropped on purpose, for the reason given.
    Ignored(&'static str),
    /// A kind this build has no row for.
    Unclassified(String),
}

const SUBAGENT: &str = "a subagent's line, which belongs to its own transcript";
const DUPLICATE: &str = "a line already folded under the same uuid";
const META: &str = "a line the CLI wrote for the model, never shown to the person";
const COMPACT_SUMMARY: &str = "the summary the CLI wrote when it compacted, never shown as a turn";
const SYNTHETIC: &str = "a placeholder reply no model wrote";
const MALFORMED_PR_LINK: &str = "a pr-link record without a usable number, https url or owner/repo";
const NO_CONTENT: &str = "a line with no text or tool call in it";

/// The stop reasons that end a turn.
const TERMINAL: &[&str] = &["end_turn", "stop_sequence", "max_tokens", "refusal"];

/// The model the CLI names for a reply it wrote itself.
const SYNTHETIC_MODEL: &str = "<synthetic>";

/// What an interrupt marker's text starts with.
const INTERRUPT_MARKER: &str = "[Request interrupted by user";

/// A pr-link url may be at most this long.
const MAX_PR_URL: usize = 2048;

/// The most of a tool call's input or output one `ToolPayload` carries
/// (M56.8): what a card can show whole. It is held in memory per open thread,
/// so a larger one is cut, on a character boundary, and says so.
pub const PAYLOAD_LIMIT_BYTES: usize = 256 * 1024;

/// A tool result's preview stops at this many characters.
const RESULT_PREVIEW_CHARS: usize = 2000;

/// An input string's preview stops at this many characters.
const INPUT_PREVIEW_CHARS: usize = 160;

/// The assistant message lines are being folded under.
#[derive(Debug, Default)]
struct OpenMessage {
    id: Option<String>,
    stop_reason: Option<String>,
    texts: HashSet<String>,
    tools: HashSet<String>,
}

/// The turn being folded.
#[derive(Debug, Default)]
struct Turn {
    open: bool,
    ended: bool,
    errored: bool,
    /// ModelChanged was emitted in this turn.
    model_named: bool,
    /// The last closed message's stop reason, whether it asked for a tool,
    /// and whether it said anything.
    last_stop: Option<String>,
    last_asked_tool: bool,
    last_said: bool,
    /// Tool calls with no result yet.
    pending: HashSet<String>,
    /// A hook deferred a call and nothing has come since (M57.1): the turn
    /// waits, so its end is no end at all.
    suspended: bool,
    /// The calls already folded as deferred, so a deferral the stream says
    /// twice (its marker and its result) is one event.
    deferred: HashSet<String>,
    /// What the turn's lines said about how it failed (M56.4).
    failures: Failures,
}

/// The line-by-line fold. `fold_lines` is the batch fold, a loop over it.
#[derive(Debug, Default)]
pub struct TranscriptFold {
    seen: HashSet<String>,
    open: Option<OpenMessage>,
    turn: Turn,
    model: Option<String>,
    session_id: Option<String>,
    /// The Claude Code version the lines name: init's, else a session line's
    /// own (M56.4, for the notice).
    cli_version: Option<String>,
}

/// How many lines a fold read, by what it made of them.
#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
pub struct Classes {
    pub translated: usize,
    pub ignored: BTreeMap<String, usize>,
    pub unclassified: BTreeMap<String, usize>,
}

/// A whole format folded.
#[derive(Debug, Clone, Serialize)]
pub struct Folded {
    pub events: Vec<AgentEvent>,
    pub classes: Classes,
}

/// Fold `lines`, then finish: the batch fold.
pub fn fold_lines(lines: &[Value]) -> Folded {
    let mut fold = TranscriptFold::default();
    let mut events = Vec::new();
    let mut classes = Classes::default();
    for line in lines {
        let (class, folded) = fold.entry(line);
        match class {
            LineClass::Translated => classes.translated += 1,
            LineClass::Ignored(reason) => *classes.ignored.entry(reason.into()).or_default() += 1,
            LineClass::Unclassified(kind) => *classes.unclassified.entry(kind).or_default() += 1,
        }
        events.extend(folded);
    }
    events.extend(fold.finish());
    Folded { events, classes }
}

fn str_of<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn flag(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(false)
}

/// The text a line's content holds: a bare string, or its text blocks.
fn text_of(content: &Value) -> Option<String> {
    match content {
        Value::String(text) => Some(text.clone()),
        Value::Array(blocks) => {
            let texts: Vec<&str> = blocks
                .iter()
                .filter(|block| str_of(block, "type") == Some("text"))
                .filter_map(|block| str_of(block, "text"))
                .collect();
            (!texts.is_empty()).then(|| texts.join("\n"))
        }
        _ => None,
    }
}

/// The ignore reason `kinds` gives `kind`.
fn ignored(kind: &str) -> LineClass {
    LineClass::Ignored(kinds::ignored_reason(kind))
}

impl TranscriptFold {
    /// Fold one parsed line. Never fails: a line it cannot read is classed,
    /// and the events it could read are still returned.
    pub fn entry(&mut self, line: &Value) -> (LineClass, Vec<AgentEvent>) {
        let mut events = Vec::new();
        let class = self.read(line, &mut events);
        // The kind table is the one list of kinds: a block or kind it has no
        // row for leaves the whole line unclassified, whatever else was read.
        let class = match kinds::unclassified(line).into_iter().next() {
            Some(kind) => LineClass::Unclassified(kind),
            None => class,
        };
        (class, events)
    }

    /// End the fold: a turn still open ends here, as ended or cut off.
    pub fn finish(&mut self) -> Vec<AgentEvent> {
        let mut events = Vec::new();
        self.end_turn(None, &mut events);
        events
    }

    /// The notice for the open turn's failure, when it failed in a typed way
    /// (M56.4).
    pub fn notice(&self) -> Option<failure::FailureNotice> {
        self.turn.failures.notice(self.cli_version.as_deref())
    }

    /// Did the open (or last) turn fail for want of quota? The meter's quota
    /// outcome reads this, never the result's words.
    pub fn is_quota(&self) -> bool {
        self.turn.failures.is_quota()
    }

    /// Every arm, in one match.
    fn read(&mut self, line: &Value, events: &mut Vec<AgentEvent>) -> LineClass {
        let kind = str_of(line, "type").unwrap_or("");
        if self.cli_version.is_none() {
            self.cli_version = str_of(line, "claude_code_version")
                .or_else(|| str_of(line, "version"))
                .map(str::to_string);
        }
        match kind {
            "system" => {
                let subtype = str_of(line, "subtype").unwrap_or("");
                match subtype {
                    "init" => {
                        self.init(line, events);
                        LineClass::Translated
                    }
                    // Read for the failure they may end in (M56.4).
                    "api_retry" | "api_error" => {
                        self.turn.failures.observe(line);
                        LineClass::Translated
                    }
                    _ => ignored(&format!("system/{subtype}")),
                }
            }
            "rate_limit_event" => {
                self.turn.failures.observe(line);
                LineClass::Translated
            }
            "stream_event" => self.stream_event(line, events),
            "assistant" => self.assistant(line, events),
            "user" => self.user(line, events),
            "result" => {
                self.result(line, events);
                LineClass::Translated
            }
            "attachment"
                if kinds::kinds_of(line).first().map(String::as_str)
                    == Some("attachment/hook_deferred_tool") =>
            {
                let attachment = line.get("attachment").unwrap_or(&Value::Null);
                self.defer(
                    str_of(attachment, "toolUseID"),
                    str_of(attachment, "toolName"),
                    events,
                );
                LineClass::Translated
            }
            "pr-link" => match pr_link(line) {
                Some(link) => {
                    events.push(link);
                    LineClass::Translated
                }
                None => LineClass::Ignored(MALFORMED_PR_LINK),
            },
            "attachment"
            | "queue-operation"
            | "last-prompt"
            | "mode"
            | "atis-latch"
            | "ai-title"
            | "custom-title"
            | "agent-name"
            | "agent-color"
            | "summary"
            | "file-history-snapshot"
            | "file-history-delta"
            | "cost-state"
            | "relocated"
            | "control_request"
            | "control_response"
            | "control_cancel_request"
            | "keep_alive"
            | "tool_progress" => ignored(kind),
            _ => LineClass::Unclassified(kinds::kinds_of(line).join(",")),
        }
    }

    /// Open a turn unless one is open and not yet ended. What a turn that
    /// never opened had already heard about a failure (a limit event before
    /// the init) carries into it; an ended turn's does not.
    fn ensure_turn(&mut self) {
        // A line of the turn's own after a deferral takes the turn up again.
        self.turn.suspended = false;
        if !self.turn.open || self.turn.ended {
            let failures = if self.turn.open {
                Failures::default()
            } else {
                std::mem::take(&mut self.turn.failures)
            };
            self.turn = Turn {
                open: true,
                failures,
                ..Turn::default()
            };
        }
    }

    fn name_model(&mut self, model: &str, events: &mut Vec<AgentEvent>) {
        if model.is_empty() || model == SYNTHETIC_MODEL {
            return;
        }
        if self.turn.model_named && self.model.as_deref() == Some(model) {
            return;
        }
        self.turn.model_named = true;
        self.model = Some(model.to_string());
        events.push(AgentEvent::ModelChanged {
            model: model.to_string(),
        });
    }

    fn init(&mut self, line: &Value, events: &mut Vec<AgentEvent>) {
        self.ensure_turn();
        if let Some(id) = str_of(line, "session_id") {
            self.session_id = Some(id.to_string());
            events.push(AgentEvent::Init {
                session_id: id.to_string(),
            });
        }
        if let Some(model) = str_of(line, "model") {
            self.name_model(model, events);
        }
    }

    fn stream_event(&mut self, line: &Value, events: &mut Vec<AgentEvent>) -> LineClass {
        let event = line.get("event").unwrap_or(&Value::Null);
        let event_type = str_of(event, "type").unwrap_or("-");
        if event_type != "content_block_delta" {
            return ignored(&format!("stream_event/{event_type}"));
        }
        let delta = event.get("delta").unwrap_or(&Value::Null);
        let delta_type = str_of(delta, "type").unwrap_or("-");
        let text = match delta_type {
            "text_delta" => str_of(delta, "text").map(|text| AgentEvent::TextDelta {
                text: text.to_string(),
            }),
            "thinking_delta" => str_of(delta, "thinking").map(|text| AgentEvent::ThinkingDelta {
                text: text.to_string(),
            }),
            other => return ignored(&format!("stream_event/content_block_delta/{other}")),
        };
        self.ensure_turn();
        events.extend(text);
        LineClass::Translated
    }

    fn close_message(&mut self) {
        if let Some(open) = self.open.take() {
            self.turn.last_stop = open.stop_reason;
            self.turn.last_asked_tool = !open.tools.is_empty();
            self.turn.last_said = !open.texts.is_empty();
        }
    }

    fn assistant(&mut self, line: &Value, events: &mut Vec<AgentEvent>) -> LineClass {
        if flag(line, "isSidechain") || line.get("parent_tool_use_id").is_some_and(|p| !p.is_null())
        {
            return LineClass::Ignored(SUBAGENT);
        }
        if let Some(uuid) = str_of(line, "uuid") {
            if !self.seen.insert(uuid.to_string()) {
                return LineClass::Ignored(DUPLICATE);
            }
        }
        let message = line.get("message").unwrap_or(&Value::Null);
        let content = message.get("content").unwrap_or(&Value::Null);
        if str_of(message, "model") == Some(SYNTHETIC_MODEL) {
            if !failure::is_api_error_line(line) {
                return LineClass::Ignored(SYNTHETIC);
            }
            self.close_message();
            self.ensure_turn();
            self.turn.failures.observe(line);
            if !self.turn.errored {
                self.turn.errored = true;
                events.push(AgentEvent::Error {
                    message: text_of(content)
                        .unwrap_or_else(|| "Claude Code reported an API error".into()),
                    code: str_of(line, "error").map(str::to_string),
                    notice: self.notice(),
                });
            }
            return LineClass::Translated;
        }
        self.ensure_turn();
        let id = str_of(message, "id").map(str::to_string);
        if self.open.as_ref().is_some_and(|open| open.id != id) {
            self.close_message();
        }
        if let Some(model) = str_of(message, "model") {
            self.name_model(model, events);
        }
        let open = self.open.get_or_insert_with(|| OpenMessage {
            id,
            ..OpenMessage::default()
        });
        if let Some(stop) = str_of(message, "stop_reason") {
            open.stop_reason = Some(stop.to_string());
        }
        let message_id = open.id.clone().unwrap_or_default();
        let mut read_any = false;
        for block in content.as_array().map(Vec::as_slice).unwrap_or_default() {
            match str_of(block, "type") {
                Some("text") => {
                    read_any = true;
                    let text = str_of(block, "text").unwrap_or_default();
                    if !text.is_empty() && open.texts.insert(text.to_string()) {
                        events.push(AgentEvent::Text {
                            message_id: message_id.clone(),
                            text: text.to_string(),
                        });
                    }
                }
                Some("tool_use") => {
                    read_any = true;
                    let tool_id = str_of(block, "id").unwrap_or_default().to_string();
                    if open.tools.insert(tool_id.clone()) {
                        self.turn.pending.insert(tool_id.clone());
                        let input = block.get("input");
                        let preview = input.map(tool_input_preview);
                        // The whole input, when the preview cut a string.
                        let whole = input
                            .map(Value::to_string)
                            .filter(|whole| Some(whole) != preview.as_ref());
                        events.push(AgentEvent::ToolStart {
                            tool_name: str_of(block, "name").unwrap_or("tool").to_string(),
                            tool_id: tool_id.clone(),
                            input: preview,
                        });
                        if let Some(whole) = whole {
                            events.push(payload(tool_id, PayloadPart::Input, whole));
                        }
                    }
                }
                _ => {}
            }
        }
        if read_any {
            return LineClass::Translated;
        }
        // Reasoning and redacted reasoning only: the table says why each is
        // dropped.
        match kinds::kinds_of(line).first() {
            Some(kind) if kinds::handling(kind).is_some() => ignored(kind),
            _ => LineClass::Ignored(NO_CONTENT),
        }
    }

    fn user(&mut self, line: &Value, events: &mut Vec<AgentEvent>) -> LineClass {
        if flag(line, "isSidechain") || line.get("parent_tool_use_id").is_some_and(|p| !p.is_null())
        {
            return LineClass::Ignored(SUBAGENT);
        }
        if flag(line, "isMeta") {
            return LineClass::Ignored(META);
        }
        if flag(line, "isCompactSummary") || flag(line, "isVisibleInTranscriptOnly") {
            return LineClass::Ignored(COMPACT_SUMMARY);
        }
        if let Some(uuid) = str_of(line, "uuid") {
            if !self.seen.insert(uuid.to_string()) {
                return LineClass::Ignored(DUPLICATE);
            }
        }
        let content = line
            .get("message")
            .and_then(|message| message.get("content"))
            .unwrap_or(&Value::Null);
        let results: Vec<&Value> = content
            .as_array()
            .map(|blocks| {
                blocks
                    .iter()
                    .filter(|block| str_of(block, "type") == Some("tool_result"))
                    .collect()
            })
            .unwrap_or_default();
        if !results.is_empty() {
            self.close_message();
            self.ensure_turn();
            for block in results {
                let tool_id = str_of(block, "tool_use_id").unwrap_or_default().to_string();
                self.turn.pending.remove(&tool_id);
                // A preview here, which every reader of the event gets; the
                // whole rides a ToolPayload only when the preview cut it, so a
                // short result crosses once.
                let whole = tool_result_whole(block);
                events.push(AgentEvent::ToolDone {
                    tool_id: tool_id.clone(),
                    output: whole.as_deref().map(result_preview),
                    is_error: flag(block, "is_error"),
                });
                if let Some(whole) =
                    whole.filter(|whole| whole.chars().count() > RESULT_PREVIEW_CHARS)
                {
                    events.push(payload(tool_id, PayloadPart::Output, whole));
                }
            }
            return LineClass::Translated;
        }
        let Some(text) = text_of(content) else {
            return LineClass::Ignored(NO_CONTENT);
        };
        self.close_message();
        if text.starts_with(INTERRUPT_MARKER) {
            if self.turn.open && !self.turn.ended {
                self.turn.ended = true;
                events.push(AgentEvent::TurnInterrupted {
                    reason: "stopped".into(),
                });
            }
            return LineClass::Translated;
        }
        self.end_turn(None, events);
        self.turn = Turn {
            open: true,
            ..Turn::default()
        };
        events.push(AgentEvent::UserPrompt { text });
        LineClass::Translated
    }

    fn result(&mut self, line: &Value, events: &mut Vec<AgentEvent>) {
        self.close_message();
        self.ensure_turn();
        if let Some(id) = str_of(line, "session_id") {
            self.session_id = Some(id.to_string());
        }
        // M57.1: a deferred run's result is a suspension, not an answer.
        if let Some(deferred) = line.get("deferred_tool_use").filter(|d| d.is_object()) {
            self.defer(str_of(deferred, "id"), str_of(deferred, "name"), events);
            return;
        }
        self.turn.failures.observe(line);
        let text = str_of(line, "result").unwrap_or_default().to_string();
        if flag(line, "is_error") {
            if !self.turn.errored {
                self.turn.errored = true;
                events.push(AgentEvent::Error {
                    message: if text.is_empty() {
                        "the agent reported an error".into()
                    } else {
                        text
                    },
                    code: str_of(line, "subtype").map(str::to_string),
                    notice: self.notice(),
                });
            }
        } else {
            events.push(AgentEvent::Result {
                text,
                session_id: self.session_id.clone(),
            });
        }
        self.end_turn(
            Some(str_of(line, "stop_reason").map(str::to_string)),
            events,
        );
    }

    /// Suspend the turn on a deferred call (M57.1): one `ToolDeferred` per
    /// call, whichever of its two lines comes first.
    fn defer(&mut self, id: Option<&str>, name: Option<&str>, events: &mut Vec<AgentEvent>) {
        self.close_message();
        self.ensure_turn();
        self.turn.suspended = true;
        let tool_id = id.unwrap_or_default().to_string();
        if self.turn.deferred.insert(tool_id.clone()) {
            events.push(AgentEvent::ToolDeferred {
                tool_id,
                tool_name: name.unwrap_or("tool").to_string(),
            });
        }
    }

    /// End the open turn, once. A `result` (Some, with its stop reason when it
    /// named one) always ends it. Otherwise the last message's terminal stop
    /// reason, or an error, ends it; a last message that asked for nothing
    /// and said something ends it with no stop reason recorded; anything else
    /// was cut off.
    fn end_turn(&mut self, result: Option<Option<String>>, events: &mut Vec<AgentEvent>) {
        self.close_message();
        if !self.turn.open || self.turn.ended {
            return;
        }
        self.turn.ended = true;
        // A suspended turn ends with no word: it waits on a deferred call,
        // and whatever answers that call says how it went.
        if self.turn.suspended {
            return;
        }
        let terminal = self
            .turn
            .last_stop
            .clone()
            .filter(|stop| TERMINAL.contains(&stop.as_str()));
        let error = self.turn.errored.then(|| "error".to_string());
        let replied =
            self.turn.last_said && !self.turn.last_asked_tool && self.turn.pending.is_empty();
        let ended = match result {
            Some(stop) => Some(stop.or(terminal).or(error)),
            None if terminal.is_some() || error.is_some() => Some(terminal.or(error)),
            None if replied => Some(None),
            None => None,
        };
        events.push(match ended {
            Some(stop_reason) => AgentEvent::TurnEnded { stop_reason },
            None => AgentEvent::TurnInterrupted {
                reason: "cut_off".into(),
            },
        });
    }
}

/// A pr-link record as a link, when it names a positive number, an https url
/// of at most MAX_PR_URL bytes and an `owner/repo`.
fn pr_link(line: &Value) -> Option<AgentEvent> {
    let number = line.get("prNumber")?.as_u64().filter(|n| *n > 0)?;
    let url = str_of(line, "prUrl")?;
    let repository = str_of(line, "prRepository")?;
    let usable = url.starts_with("https://")
        && url.len() <= MAX_PR_URL
        && repository.matches('/').count() == 1
        && !repository.starts_with('/')
        && !repository.ends_with('/');
    usable.then(|| AgentEvent::PrLink {
        number,
        url: url.to_string(),
        repository: repository.to_string(),
    })
}

// ---------------------------------------------------------------------------
// Moved from agent/mod.rs unchanged, with translate gone (M56.3)
// ---------------------------------------------------------------------------

/// A tool call's input, shortened for the event stream WITHOUT breaking it
/// (M49.9, K25): each long string value is cut, never the JSON. It used to
/// be the serialized input cut at 200 characters — a write_concept body is
/// always longer, so the run log's `writtenPath` could never parse it and
/// every knowledge run logged `files: []`, "wrote nothing" and "did not
/// look" reading the same.
pub(crate) fn tool_input_preview(input: &Value) -> String {
    fn shorten(value: &Value) -> Value {
        match value {
            Value::String(s) if s.chars().count() > INPUT_PREVIEW_CHARS => Value::String(format!(
                "{}…",
                s.chars().take(INPUT_PREVIEW_CHARS).collect::<String>()
            )),
            Value::Array(items) => Value::Array(items.iter().map(shorten).collect()),
            Value::Object(map) => {
                Value::Object(map.iter().map(|(k, v)| (k.clone(), shorten(v))).collect())
            }
            other => other.clone(),
        }
    }
    shorten(input).to_string()
}

/// A tool result's preview: `whole`, cut at `RESULT_PREVIEW_CHARS`.
fn result_preview(whole: &str) -> String {
    if whole.chars().count() > RESULT_PREVIEW_CHARS {
        let head: String = whole.chars().take(RESULT_PREVIEW_CHARS).collect();
        format!("{head}…")
    } else {
        whole.to_string()
    }
}

/// The whole of `whole` that one `ToolPayload` carries: at most
/// `PAYLOAD_LIMIT_BYTES`, cut on a character boundary.
fn payload(tool_id: String, part: PayloadPart, mut whole: String) -> AgentEvent {
    let bytes = whole.len();
    let truncated = bytes > PAYLOAD_LIMIT_BYTES;
    if truncated {
        let mut end = PAYLOAD_LIMIT_BYTES;
        while !whole.is_char_boundary(end) {
            end -= 1;
        }
        whole.truncate(end);
    }
    AgentEvent::ToolPayload {
        tool_id,
        part,
        text: whole,
        bytes: bytes as u64,
        truncated,
    }
}

/// A tool result's whole text, however the CLI shaped it, trimmed; `None`
/// when it holds none.
///
/// `content` is a bare string in some versions and an array of typed blocks
/// in others; both appear in the same stream depending on the tool. Reading
/// only one shape silently drops half the outputs.
fn tool_result_whole(block: &Value) -> Option<String> {
    let content = block.get("content")?;
    let text = match content {
        Value::String(s) => s.clone(),
        Value::Array(items) => items
            .iter()
            .filter_map(|i| {
                i.get("text")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .or_else(|| i.as_str().map(str::to_string))
            })
            .collect::<Vec<_>>()
            .join("\n"),
        other => other.to_string(),
    };
    let trimmed = text.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

pub(crate) fn content_blocks(value: &Value) -> Vec<Value> {
    value
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

/// One turn's message content, as the stream and the session file must
/// agree on it: the model last in effect, then what the person reads, in
/// order. A turn's end is a marker only: the stream names its stop reason in
/// the result, which the file does not hold.
#[cfg(test)]
#[derive(Debug, Clone, Serialize, PartialEq)]
pub(crate) struct TurnContent {
    pub model: Option<String>,
    pub events: Vec<Value>,
}

#[cfg(test)]
impl TurnContent {
    fn ended(&self) -> Option<&str> {
        self.events
            .last()
            .and_then(|event| event["kind"].as_str())
            .filter(|kind| matches!(*kind, "TurnEnded" | "TurnInterrupted" | "ToolDeferred"))
    }

    fn body(&self) -> &[Value] {
        match self.ended() {
            Some(_) => &self.events[..self.events.len() - 1],
            None => &self.events,
        }
    }
}

/// `events`, split into turns at each turn's end, a deferral included.
#[cfg(test)]
pub(crate) fn turn_content(events: &[AgentEvent]) -> Vec<TurnContent> {
    use serde_json::json;
    let mut turns = Vec::new();
    let mut model: Option<String> = None;
    let mut current: Vec<Value> = Vec::new();
    for event in events {
        let shown = match event {
            AgentEvent::ModelChanged { model: named } => {
                model = Some(named.clone());
                None
            }
            AgentEvent::Text { text, .. } => Some(json!({ "kind": "Text", "text": text })),
            AgentEvent::ToolStart {
                tool_name,
                tool_id,
                input,
            } => Some(
                json!({ "kind": "ToolStart", "tool_name": tool_name, "tool_id": tool_id, "input": input }),
            ),
            AgentEvent::ToolDone {
                tool_id,
                output,
                is_error,
            } => Some(
                json!({ "kind": "ToolDone", "tool_id": tool_id, "output": output, "is_error": is_error }),
            ),
            AgentEvent::ToolPayload {
                tool_id,
                part,
                text,
                bytes,
                truncated,
            } => Some(json!({
                "kind": "ToolPayload", "tool_id": tool_id, "part": part, "text": text,
                "bytes": bytes, "truncated": truncated
            })),
            AgentEvent::Error {
                message,
                code,
                notice,
            } => {
                Some(json!({ "kind": "Error", "message": message, "code": code, "notice": notice }))
            }
            AgentEvent::TurnEnded { .. } => Some(json!({ "kind": "TurnEnded" })),
            AgentEvent::TurnInterrupted { .. } => Some(json!({ "kind": "TurnInterrupted" })),
            AgentEvent::ToolDeferred { tool_id, tool_name } => {
                Some(json!({ "kind": "ToolDeferred", "tool_id": tool_id, "tool_name": tool_name }))
            }
            _ => None,
        };
        let Some(shown) = shown else { continue };
        // A deferral suspends the turn (M57.1), so it closes the half the
        // stream that deferred holds; the resumed half is a turn of its own
        // in both formats.
        let ends = matches!(
            event,
            AgentEvent::TurnEnded { .. }
                | AgentEvent::TurnInterrupted { .. }
                | AgentEvent::ToolDeferred { .. }
        );
        current.push(shown);
        if ends {
            turns.push(TurnContent {
                model: model.clone(),
                events: std::mem::take(&mut current),
            });
        }
    }
    if !current.is_empty() {
        turns.push(TurnContent {
            model,
            events: current,
        });
    }
    turns
}

/// The stream's and the session file's content for the same turn agree: the
/// same events when both ended or both deferred the same call, and when one
/// side was cut off (or the stream
/// alone holds the result's error), the interrupted side's events are a
/// prefix of the other's. The model is compared when both name one: the file
/// holds no init, so a turn no model answered names none there.
#[cfg(test)]
pub(crate) fn assert_same_turn(label: &str, stream: &TurnContent, session: &TurnContent) {
    if let (Some(a), Some(b)) = (&stream.model, &session.model) {
        assert_eq!(a, b, "{label}: the model");
    }
    let (s, f) = (stream.body(), session.body());
    let both_ended = stream.ended() == Some("TurnEnded") && session.ended() == Some("TurnEnded");
    if both_ended {
        assert_eq!(
            s, f,
            "{label}: an ended turn shows the same content in both"
        );
        return;
    }
    // Suspended on the same deferred call in both (M57.1).
    if stream.ended() == Some("ToolDeferred") && session.ended() == Some("ToolDeferred") {
        assert_eq!(
            stream.events, session.events,
            "{label}: a deferred turn shows the same content and the same call in both"
        );
        return;
    }
    let (short, long) = if s.len() <= f.len() { (s, f) } else { (f, s) };
    assert_eq!(
        short,
        &long[..short.len()],
        "{label}: a cut-off turn's content is a prefix of the other's"
    );
    assert!(
        stream.ended().is_some() && session.ended().is_some(),
        "{label}: both sides end the turn somehow"
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::path::{Path, PathBuf};

    fn fixtures() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/cli-stream")
    }

    /// A fixture under cli-stream/: an array is a stream, a hand-built
    /// stream's `{synthetic, why, events}` its events (M56.4), and any other
    /// object one line.
    fn lines_of(path: &Path) -> Vec<Value> {
        let value: Value = serde_json::from_str(
            &std::fs::read_to_string(path)
                .unwrap_or_else(|error| panic!("{}: {error}", path.display())),
        )
        .unwrap_or_else(|error| panic!("{}: {error}", path.display()));
        match value {
            Value::Array(lines) => lines,
            Value::Object(wrapper) if wrapper.get("synthetic") == Some(&Value::Bool(true)) => {
                match wrapper.get("events") {
                    Some(Value::Array(lines)) => lines.clone(),
                    _ => panic!("{}: a synthetic stream holds events", path.display()),
                }
            }
            line => vec![line],
        }
    }

    fn fixture(name: &str) -> Vec<Value> {
        lines_of(&fixtures().join(name))
    }

    /// Fold lines one at a time without finishing.
    fn each(lines: &[Value]) -> Vec<AgentEvent> {
        let mut fold = TranscriptFold::default();
        lines.iter().flat_map(|line| fold.entry(line).1).collect()
    }

    fn one(line: Value) -> Vec<AgentEvent> {
        TranscriptFold::default().entry(&line).1
    }

    fn jsonl(path: &Path) -> Vec<Value> {
        std::fs::read_to_string(path)
            .unwrap_or_else(|error| panic!("{}: {error}", path.display()))
            .lines()
            .filter(|line| !line.trim().is_empty())
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    fn kind_of(event: &AgentEvent) -> String {
        serde_json::to_value(event).unwrap()["kind"]
            .as_str()
            .unwrap_or_default()
            .to_string()
    }

    fn kinds(events: &[AgentEvent]) -> Vec<String> {
        events.iter().map(kind_of).collect()
    }

    // --- Ported from agent/mod.rs's translate tests -------------------------

    #[test]
    fn translates_the_cli_stream_into_normalized_events() {
        let events = each(&[
            json!({ "type": "system", "subtype": "init", "session_id": "s-1" }),
            json!({ "type": "stream_event", "event": { "type": "content_block_delta",
                "delta": { "type": "text_delta", "text": "he" } } }),
            json!({ "type": "assistant", "message": { "content": [
                { "type": "tool_use", "id": "t1", "name": "search_notes", "input": { "query": "x" } }
            ] } }),
            json!({ "type": "user", "message": { "content": [{ "type": "tool_result", "tool_use_id": "t1" }] } }),
            json!({ "type": "result", "subtype": "success", "result": "done", "session_id": "s-1" }),
        ]);
        assert!(
            matches!(events.as_slice(), [
                AgentEvent::Init { session_id },
                AgentEvent::TextDelta { text },
                AgentEvent::ToolStart { tool_name, tool_id, .. },
                AgentEvent::ToolDone { tool_id: done, .. },
                AgentEvent::Result { text: result, session_id: Some(sid) },
                AgentEvent::TurnEnded { stop_reason: None },
            ] if session_id == "s-1" && text == "he" && tool_name == "search_notes"
                && tool_id == "t1" && done == "t1" && result == "done" && sid == "s-1"),
            "{events:?}"
        );
    }

    // M9.5: the CLI shapes tool_result content two different ways in the same
    // stream. Reading only one silently drops half the outputs.
    #[test]
    fn tool_results_carry_their_output_in_either_shape() {
        let string_form = one(json!({ "type": "user", "message": { "content": [
            { "type": "tool_result", "tool_use_id": "t1", "content": "  four notes  " }
        ] } }));
        assert!(matches!(
            string_form.as_slice(),
            [AgentEvent::ToolDone { output: Some(text), is_error: false, .. }] if text == "four notes"
        ));
        let block_form = one(json!({ "type": "user", "message": { "content": [
            { "type": "tool_result", "tool_use_id": "t2", "content": [
                { "type": "text", "text": "line one" },
                { "type": "text", "text": "line two" }
            ] }
        ] } }));
        assert!(matches!(
            block_form.as_slice(),
            [AgentEvent::ToolDone { output: Some(text), .. }] if text == "line one\nline two"
        ));
    }

    #[test]
    fn a_failed_tool_reports_as_such() {
        let events = one(json!({ "type": "user", "message": { "content": [
            { "type": "tool_result", "tool_use_id": "t1", "content": "nope", "is_error": true }
        ] } }));
        assert!(matches!(
            events.as_slice(),
            [AgentEvent::ToolDone { is_error: true, .. }]
        ));
    }

    #[test]
    fn an_empty_tool_result_carries_no_output() {
        let events = one(json!({ "type": "user", "message": { "content": [
            { "type": "tool_result", "tool_use_id": "t1", "content": "   " }
        ] } }));
        assert!(matches!(
            events.as_slice(),
            [AgentEvent::ToolDone { output: None, .. }]
        ));
    }

    #[test]
    fn a_failed_result_surfaces_as_an_error_not_a_reply() {
        let events = one(
            json!({ "type": "result", "subtype": "error_during_execution",
            "is_error": true, "result": "rate limited" }),
        );
        assert!(
            matches!(events.as_slice(), [AgentEvent::Error { message, code: Some(code), notice: None }, AgentEvent::TurnEnded { stop_reason: Some(stop) }]
                if message == "rate limited" && code == "error_during_execution" && stop == "error"),
            "{events:?}"
        );
    }

    #[test]
    fn unknown_and_malformed_lines_are_ignored_rather_than_shown() {
        // The CLI's wire format changes between versions; an unknown shape
        // must not become a visible error in the conversation, and it must be
        // counted rather than dropped without a word.
        let mut fold = TranscriptFold::default();
        for (line, kind) in [
            (json!({ "type": "telemetry" }), "telemetry"),
            (json!({}), "-"),
            (json!({ "type": "stream_event" }), "stream_event/-"),
        ] {
            let (class, events) = fold.entry(&line);
            assert!(events.is_empty(), "{line}: {events:?}");
            assert_eq!(class, LineClass::Unclassified(kind.into()), "{line}");
        }
        assert!(fold.finish().is_empty(), "no turn ever opened");
    }

    // M49.9 (K25): the preview keeps the path a long write_concept names —
    // the run log reads it from here.
    #[test]
    fn a_long_tool_input_keeps_its_path_and_stays_json() {
        let input = json!({ "path": "knowledge/metrics/churn.md", "body": "x".repeat(5_000) });
        let preview = super::tool_input_preview(&input);
        let parsed: Value = serde_json::from_str(&preview).unwrap();
        assert_eq!(parsed["path"], "knowledge/metrics/churn.md");
        assert!(preview.len() < 400, "{}", preview.len());
    }

    // --- Payloads (M56.8) ----------------------------------------------------

    fn tool_use(id: &str, input: Value) -> Value {
        json!({ "type": "assistant", "message": { "id": "msg_1", "content": [
            { "type": "tool_use", "id": id, "name": "mcp__cerebro__write_concept", "input": input }
        ] } })
    }

    fn tool_result(id: &str, content: &str) -> Value {
        json!({ "type": "user", "message": { "content": [
            { "type": "tool_result", "tool_use_id": id, "content": content }
        ] } })
    }

    #[test]
    fn a_cut_tool_input_rides_a_payload_event() {
        let body = "Monthly churn is the share of paying accounts that cancel. ".repeat(8);
        let input = json!({ "path": "knowledge/metrics/churn.md", "body": body });
        let events = one(tool_use("t1", input.clone()));
        let [AgentEvent::ToolStart {
            tool_id,
            input: Some(preview),
            ..
        }, AgentEvent::ToolPayload {
            tool_id: payload_id,
            part: PayloadPart::Input,
            text,
            bytes,
            truncated: false,
        }] = events.as_slice()
        else {
            panic!("a start, then its input whole: {events:?}");
        };
        assert_eq!((tool_id.as_str(), payload_id.as_str()), ("t1", "t1"));
        assert!(preview.len() < text.len(), "{preview}");
        assert_eq!(text, &input.to_string());
        assert_eq!(*bytes, input.to_string().len() as u64);

        // A result past the preview rides one too, after its ToolDone.
        let long = "Churn rose in March. ".repeat(150);
        let events = one(tool_result("t2", &long));
        let [AgentEvent::ToolDone {
            output: Some(preview),
            ..
        }, AgentEvent::ToolPayload {
            part: PayloadPart::Output,
            text,
            truncated: false,
            ..
        }] = events.as_slice()
        else {
            panic!("a completion, then its output whole: {events:?}");
        };
        assert_eq!(
            preview.chars().count(),
            RESULT_PREVIEW_CHARS + 1,
            "the cut and its ellipsis"
        );
        assert_eq!(text, long.trim());
    }

    #[test]
    fn a_short_tool_call_needs_no_payload() {
        let events = one(tool_use(
            "t1",
            json!({ "path": "knowledge/metrics/churn.md" }),
        ));
        assert_eq!(kinds(&events), ["ToolStart"]);
        let events = one(tool_use("t2", json!({})));
        assert_eq!(kinds(&events), ["ToolStart"]);
        let at_the_limit = "a".repeat(RESULT_PREVIEW_CHARS);
        let events = one(tool_result("t1", &at_the_limit));
        assert_eq!(kinds(&events), ["ToolDone"]);
        let events = one(tool_result("t3", "   "));
        assert_eq!(kinds(&events), ["ToolDone"]);
    }

    #[test]
    fn a_payload_stops_at_the_limit_on_a_char_boundary() {
        // A three-byte character straddles the limit: the cut falls before
        // it, never inside it, and the whole size is still reported.
        let whole = format!("{}€ and more", "a".repeat(PAYLOAD_LIMIT_BYTES - 1));
        assert!(!whole.is_char_boundary(PAYLOAD_LIMIT_BYTES));
        let AgentEvent::ToolPayload {
            text,
            bytes,
            truncated,
            ..
        } = payload("t1".into(), PayloadPart::Output, whole.clone())
        else {
            unreachable!()
        };
        assert!(truncated);
        assert_eq!(text.len(), PAYLOAD_LIMIT_BYTES - 1);
        assert!(text.chars().all(|c| c == 'a'));
        assert_eq!(bytes, whole.len() as u64);
        // Exactly the limit is whole.
        let AgentEvent::ToolPayload {
            text, truncated, ..
        } = payload(
            "t1".into(),
            PayloadPart::Output,
            "b".repeat(PAYLOAD_LIMIT_BYTES),
        )
        else {
            unreachable!()
        };
        assert!(!truncated);
        assert_eq!(text.len(), PAYLOAD_LIMIT_BYTES);
        // And through the fold, a result past the limit says it was cut.
        let huge = "c".repeat(PAYLOAD_LIMIT_BYTES + 10);
        let events = one(tool_result("t1", &huge));
        assert!(
            matches!(events.last(), Some(AgentEvent::ToolPayload { truncated: true, bytes, text, .. })
                if *bytes == huge.len() as u64 && text.len() == PAYLOAD_LIMIT_BYTES),
            "{:?}",
            kinds(&events)
        );
    }

    #[test]
    fn the_stream_and_the_session_file_carry_the_same_payloads() {
        let payloads = |name: &str| -> Vec<AgentEvent> {
            fold_lines(&load(name))
                .events
                .into_iter()
                .filter(|event| matches!(event, AgentEvent::ToolPayload { .. }))
                .collect()
        };
        let stream = payloads("transcript-long-payload.stream.json");
        assert_eq!(stream, payloads("transcript-long-payload.session.json"));
        // The 400-character body its preview cut, then the 3000-character
        // result cut at 2000: one of each, whole.
        assert!(
            matches!(stream.as_slice(), [
                AgentEvent::ToolPayload { part: PayloadPart::Input, truncated: false, text: input, .. },
                AgentEvent::ToolPayload { part: PayloadPart::Output, truncated: false, text: out, .. },
            ] if out.chars().count() == 3000 && serde_json::from_str::<Value>(input).unwrap()["body"].as_str().unwrap().chars().count() == 400),
            "{stream:?}"
        );
    }

    // --- The fold's own rules -----------------------------------------------

    fn assistant(id: &str, uuid: &str, model: &str, stop: Value, content: Value) -> Value {
        json!({ "type": "assistant", "uuid": uuid, "message": {
            "id": id, "model": model, "stop_reason": stop, "content": content } })
    }

    fn prompt(text: &str, uuid: &str) -> Value {
        json!({ "type": "user", "uuid": uuid, "message": { "role": "user", "content": text } })
    }

    #[test]
    fn blocks_group_by_message_id_and_the_turn_ends_once() {
        // 2.1.250 writes one line per block and repeats the stop reason on
        // each: the turn ends at its end, not at the first line that names
        // end_turn.
        let block = |uuid: &str, content: Value| {
            assistant("msg_1", uuid, "claude-haiku", json!("end_turn"), content)
        };
        let folded = fold_lines(&[
            prompt("hi", "u0"),
            block("u1", json!([{ "type": "text", "text": "One." }])),
            block(
                "u2",
                json!([{ "type": "text", "text": "One." }, { "type": "text", "text": "Two." }]),
            ),
            block("u3", json!([{ "type": "text", "text": "Three." }])),
        ]);
        assert_eq!(
            kinds(&folded.events),
            [
                "UserPrompt",
                "ModelChanged",
                "Text",
                "Text",
                "Text",
                "TurnEnded"
            ]
        );
        assert!(
            matches!(folded.events.last(), Some(AgentEvent::TurnEnded { stop_reason: Some(s) }) if s == "end_turn")
        );
    }

    #[test]
    fn a_repeated_uuid_folds_once() {
        let line = assistant(
            "msg_1",
            "u1",
            "m",
            Value::Null,
            json!([
                { "type": "tool_use", "id": "t1", "name": "Read", "input": {} }
            ]),
        );
        let mut fold = TranscriptFold::default();
        assert_eq!(fold.entry(&line).0, LineClass::Translated);
        let (class, events) = fold.entry(&line);
        assert_eq!(class, LineClass::Ignored(DUPLICATE));
        assert!(events.is_empty());
    }

    #[test]
    fn meta_sidechain_and_compact_summary_lines_are_skipped() {
        let mut fold = TranscriptFold::default();
        let cases = [
            (
                json!({ "type": "user", "isMeta": true, "message": { "content": "Caveat" } }),
                META,
            ),
            (
                json!({ "type": "user", "isCompactSummary": true, "isVisibleInTranscriptOnly": true,
                "message": { "content": "Summary" } }),
                COMPACT_SUMMARY,
            ),
            (
                json!({ "type": "assistant", "isSidechain": true, "message": { "id": "m", "model": "x",
                "content": [{ "type": "text", "text": "sub" }] } }),
                SUBAGENT,
            ),
            (
                json!({ "type": "assistant", "parent_tool_use_id": "t9", "message": { "id": "m",
                "model": "x", "content": [{ "type": "text", "text": "sub" }] } }),
                SUBAGENT,
            ),
        ];
        for (line, reason) in cases {
            let (class, events) = fold.entry(&line);
            assert_eq!(class, LineClass::Ignored(reason), "{line}");
            assert!(events.is_empty(), "{line}");
        }
    }

    #[test]
    fn an_api_error_line_is_one_error_that_ends_the_turn() {
        let folded = fold_lines(&fixture("transcript-api-error.stream.json"));
        let errors: Vec<&AgentEvent> = folded
            .events
            .iter()
            .filter(|event| matches!(event, AgentEvent::Error { .. }))
            .collect();
        assert!(
            matches!(errors.as_slice(), [AgentEvent::Error { code: Some(code), message, notice: Some(notice) }]
                if code == "rate_limit" && message.starts_with("API Error")
                    && notice.kind == failure::FailureKind::RateLimited),
            "the result's error is not repeated: {errors:?}"
        );
        assert!(!folded
            .events
            .iter()
            .any(|e| matches!(e, AgentEvent::ModelChanged { model } if model == SYNTHETIC_MODEL)));
        assert!(matches!(
            folded.events.last(),
            Some(AgentEvent::TurnEnded { .. })
        ));
        assert_eq!(
            folded
                .events
                .iter()
                .filter(|e| matches!(e, AgentEvent::TurnEnded { .. }))
                .count(),
            1
        );
    }

    // M56.4: the turn's failure rides its Error, from either format.
    #[test]
    fn a_session_file_limit_line_folds_to_its_notice() {
        let history: Value = serde_json::from_str(
            &std::fs::read_to_string(fixtures().join("jsonl/usage-limit-5h.json")).unwrap(),
        )
        .unwrap();
        let folded = fold_lines(&[prompt("hi", "u0"), history["line"].clone()]);
        let notice = folded
            .events
            .iter()
            .find_map(|event| match event {
                AgentEvent::Error { notice, .. } => notice.clone(),
                _ => None,
            })
            .expect("a notice");
        assert_eq!(notice.kind, failure::FailureKind::UsageLimit);
        assert_eq!(notice.window.as_deref(), Some("5-hour"));
        assert_eq!(notice.resets_at.as_deref(), Some("2026-01-01T00:00:00Z"));

        // Live, the stream's rejected limit event names the window.
        let mut fold = TranscriptFold::default();
        let events: Vec<AgentEvent> = fixture("usage-limit-stream.json")
            .iter()
            .flat_map(|line| fold.entry(line).1)
            .collect();
        assert!(fold.is_quota());
        assert!(
            events.iter().any(|event| matches!(event,
                AgentEvent::Error { notice: Some(n), .. } if n.window.as_deref() == Some("weekly"))),
            "{events:?}"
        );
        // A later prompt starts a turn that has not failed.
        fold.entry(&prompt("again", "u9"));
        assert!(!fold.is_quota());
        assert_eq!(fold.notice(), None);
    }

    #[test]
    fn an_error_the_fold_cannot_type_keeps_its_text_and_no_notice() {
        let folded = fold_lines(&[
            json!({ "type": "result", "subtype": "error_during_execution",
            "is_error": true, "result": "usage limit reached, rate limit, quota" }),
        ]);
        assert!(
            matches!(folded.events.first(), Some(AgentEvent::Error { message, notice: None, .. })
                if message.contains("usage limit")),
            "a limit phrase with no typed field is only words: {:?}",
            folded.events
        );
    }

    #[test]
    fn a_synthetic_placeholder_is_never_a_model_or_a_reply() {
        let folded = fold_lines(&[
            prompt("hi", "u0"),
            assistant(
                "00000000-0000-4000-8000-000000000009",
                "u1",
                SYNTHETIC_MODEL,
                json!("stop_sequence"),
                json!([{ "type": "text", "text": "No response requested." }]),
            ),
        ]);
        assert_eq!(kinds(&folded.events), ["UserPrompt", "TurnInterrupted"]);
        assert_eq!(folded.classes.ignored.get(SYNTHETIC), Some(&1));
    }

    #[test]
    fn each_turn_names_its_model_once() {
        let text = |id: &str, uuid: &str, model: &str| {
            assistant(
                id,
                uuid,
                model,
                json!("end_turn"),
                json!([{ "type": "text", "text": uuid }]),
            )
        };
        let folded = fold_lines(&[
            prompt("one", "p1"),
            text("m1", "a1", "haiku"),
            text("m2", "a2", "haiku"),
            prompt("two", "p2"),
            text("m3", "a3", "haiku"),
            text("m4", "a4", "sonnet"),
        ]);
        let models: Vec<&str> = folded
            .events
            .iter()
            .filter_map(|event| match event {
                AgentEvent::ModelChanged { model } => Some(model.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(models, ["haiku", "haiku", "sonnet"]);
    }

    #[test]
    fn an_interrupt_marker_or_a_cut_off_file_interrupts_the_turn() {
        let marker = fold_lines(&[
            prompt("go", "p1"),
            assistant(
                "m1",
                "a1",
                "haiku",
                Value::Null,
                json!([
                    { "type": "tool_use", "id": "t1", "name": "Bash", "input": {} }
                ]),
            ),
            json!({ "type": "user", "uuid": "i1", "message": { "content": [
                { "type": "text", "text": "[Request interrupted by user for tool use]" }
            ] } }),
        ]);
        assert!(
            matches!(marker.events.last(), Some(AgentEvent::TurnInterrupted { reason }) if reason == "stopped"),
            "{:?}",
            marker.events
        );
        // A run stopped mid-tool leaves its call unanswered in both formats.
        for name in [
            "spike-killed-mid-tool.stream.jsonl",
            "spike-killed-mid-tool.session.jsonl",
        ] {
            let cut = fold_lines(&jsonl(&fixtures().join("real").join(name)));
            assert!(
                matches!(cut.events.last(), Some(AgentEvent::TurnInterrupted { reason }) if reason == "cut_off"),
                "{name}: {:?}",
                cut.events
            );
        }
    }

    #[test]
    fn a_stop_hook_continuation_ends_the_turn_at_its_end() {
        let folded = fold_lines(&[
            prompt("go", "p1"),
            assistant(
                "m1",
                "a1",
                "haiku",
                json!("end_turn"),
                json!([{ "type": "text", "text": "Done." }]),
            ),
            json!({ "type": "user", "uuid": "h1", "isMeta": true, "message": { "content": "Stop hook feedback: keep going" } }),
            assistant(
                "m2",
                "a2",
                "haiku",
                json!("tool_use"),
                json!([
                    { "type": "tool_use", "id": "t1", "name": "Read", "input": {} }
                ]),
            ),
            json!({ "type": "user", "uuid": "r1", "message": { "content": [
                { "type": "tool_result", "tool_use_id": "t1", "content": "ok" }
            ] } }),
            assistant(
                "m3",
                "a3",
                "haiku",
                json!("end_turn"),
                json!([{ "type": "text", "text": "Really done." }]),
            ),
        ]);
        assert_eq!(
            kinds(&folded.events),
            [
                "UserPrompt",
                "ModelChanged",
                "Text",
                "ToolStart",
                "ToolDone",
                "Text",
                "TurnEnded"
            ]
        );
    }

    #[test]
    fn pr_link_records_become_links_and_malformed_ones_are_ignored() {
        let good = json!({ "type": "pr-link", "prNumber": 7,
            "prUrl": "https://github.com/example/notes/pull/7", "prRepository": "example/notes" });
        assert_eq!(
            one(good),
            [AgentEvent::PrLink {
                number: 7,
                url: "https://github.com/example/notes/pull/7".into(),
                repository: "example/notes".into(),
            }]
        );
        let long = format!("https://github.com/{}", "x".repeat(MAX_PR_URL));
        for bad in [
            json!({ "type": "pr-link", "prNumber": 0, "prUrl": "https://x/1", "prRepository": "a/b" }),
            json!({ "type": "pr-link", "prNumber": -3, "prUrl": "https://x/1", "prRepository": "a/b" }),
            json!({ "type": "pr-link", "prNumber": 7, "prUrl": "http://x/1", "prRepository": "a/b" }),
            json!({ "type": "pr-link", "prNumber": 7, "prUrl": "javascript:alert(1)", "prRepository": "a/b" }),
            json!({ "type": "pr-link", "prNumber": 7, "prUrl": long, "prRepository": "a/b" }),
            json!({ "type": "pr-link", "prNumber": 7, "prUrl": "https://x/1", "prRepository": "a/b/c" }),
            json!({ "type": "pr-link", "prNumber": "7", "prUrl": "https://x/1", "prRepository": "a/b" }),
        ] {
            let (class, events) = TranscriptFold::default().entry(&bad);
            assert_eq!(class, LineClass::Ignored(MALFORMED_PR_LINK), "{bad}");
            assert!(events.is_empty());
        }
    }

    // --- A deferred call (M57.1) ---------------------------------------------

    fn deferred_result(id: &str, name: &str) -> Value {
        json!({ "type": "result", "subtype": "success", "is_error": false, "result": "",
            "stop_reason": "tool_deferred", "terminal_reason": "tool_deferred",
            "deferred_tool_use": { "id": id, "name": name, "input": { "path": "a.md" } },
            "session_id": "s-1" })
    }

    #[test]
    fn a_deferred_result_folds_to_tool_deferred_alone() {
        let folded = fold_lines(&fixture("transcript-deferred.stream.json"));
        assert_eq!(
            kinds(&folded.events),
            [
                "Init",
                "ModelChanged",
                "TextDelta",
                "Text",
                "ToolStart",
                "ToolDeferred"
            ]
        );
        assert_eq!(
            folded.events.last(),
            Some(&AgentEvent::ToolDeferred {
                tool_id: "toolu_000000000000000000005701".into(),
                tool_name: "mcp__cerebro__append_to_note".into(),
            })
        );
        assert!(
            folded.classes.unclassified.is_empty(),
            "{:?}",
            folded.classes
        );
        // No Result, no TurnEnded, and finishing adds no interruption: the
        // turn is suspended, not ended.
        let mut fold = TranscriptFold::default();
        let (_, events) = fold.entry(&deferred_result("t1", "Bash"));
        assert_eq!(
            events,
            [AgentEvent::ToolDeferred {
                tool_id: "t1".into(),
                tool_name: "Bash".into()
            }]
        );
        assert!(fold.finish().is_empty());
    }

    #[test]
    fn the_session_files_marker_folds_alike() {
        let session = fold_lines(&fixture("transcript-deferred.session.json"));
        let stream = fold_lines(&fixture("transcript-deferred.stream.json"));
        assert!(
            session.classes.unclassified.is_empty(),
            "{:?}",
            session.classes
        );
        assert_eq!(
            session
                .events
                .iter()
                .find(|e| matches!(e, AgentEvent::ToolDeferred { .. })),
            stream
                .events
                .iter()
                .find(|e| matches!(e, AgentEvent::ToolDeferred { .. })),
        );
        assert!(!session.events.iter().any(|e| matches!(
            e,
            AgentEvent::TurnEnded { .. } | AgentEvent::TurnInterrupted { .. }
        )));
        // A marker the stream also carries (a resume that defers again
        // writes both) is one event.
        let mut fold = TranscriptFold::default();
        let marker = json!({ "type": "attachment", "attachment": {
            "type": "hook_deferred_tool", "toolUseID": "t1", "toolName": "Bash" } });
        let (class, first) = fold.entry(&marker);
        assert_eq!(class, LineClass::Translated);
        assert_eq!(first.len(), 1);
        assert!(fold.entry(&deferred_result("t1", "Bash")).1.is_empty());
        // The resumed call's result takes the turn up again, and it ends.
        let (_, resumed) = fold.entry(&tool_result("t1", "appended"));
        assert_eq!(kinds(&resumed), ["ToolDone"]);
        let reply = json!({ "type": "assistant", "message": { "id": "m9", "stop_reason": "end_turn",
            "content": [{ "type": "text", "text": "Done." }] } });
        fold.entry(&reply);
        assert_eq!(kinds(&fold.finish()), ["TurnEnded"]);
    }

    #[test]
    fn a_result_without_the_marker_is_an_ordinary_result() {
        for line in [
            json!({ "type": "result", "subtype": "success", "result": "done",
                "stop_reason": "end_turn", "session_id": "s-1" }),
            json!({ "type": "result", "subtype": "success", "result": "done",
                "stop_reason": "end_turn", "deferred_tool_use": null, "session_id": "s-1" }),
        ] {
            let events = one(line.clone());
            assert_eq!(kinds(&events), ["Result", "TurnEnded"], "{line}");
        }
        // Every other attachment is still ignored.
        let other = json!({ "type": "attachment", "attachment": { "type": "skill_listing" } });
        assert!(matches!(
            TranscriptFold::default().entry(&other).0,
            LineClass::Ignored(_)
        ));
    }

    // --- Every recording, both formats, and the goldens ---------------------

    #[test]
    fn every_recorded_line_is_classified() {
        let mut names: Vec<PathBuf> = std::fs::read_dir(fixtures())
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
            .collect();
        names.sort();
        assert!(names.len() >= 15, "{names:?}");
        let mut unclassified = Vec::new();
        for path in names {
            let mut fold = TranscriptFold::default();
            for (at, line) in lines_of(&path).iter().enumerate() {
                if let (LineClass::Unclassified(kind), _) = fold.entry(line) {
                    unclassified.push(format!("{}[{at}]: {kind}", path.display()));
                }
            }
        }
        assert!(
            unclassified.is_empty(),
            "give each kind an arm in the fold and a row in kinds::STREAM_KINDS: {unclassified:#?}"
        );
    }

    /// One golden case: its streams, one per turn, and its session file.
    struct Case {
        name: &'static str,
        streams: &'static [&'static str],
        session: Option<&'static str>,
    }

    const CASES: &[Case] = &[
        Case {
            name: "two-turns",
            streams: &[
                "transcript-two-turns.turn1.stream.json",
                "transcript-two-turns.turn2.stream.json",
            ],
            session: Some("transcript-two-turns.session.json"),
        },
        Case {
            name: "interrupted",
            streams: &["real/spike-killed-mid-tool.stream.jsonl"],
            session: Some("real/spike-killed-mid-tool.session.jsonl"),
        },
        Case {
            name: "api-error",
            streams: &["transcript-api-error.stream.json"],
            session: Some("transcript-api-error.session.json"),
        },
        Case {
            name: "session-records",
            streams: &[],
            session: Some("transcript-session-records.session.json"),
        },
        Case {
            name: "long-payload",
            streams: &["transcript-long-payload.stream.json"],
            session: Some("transcript-long-payload.session.json"),
        },
        // M57.1: a turn a PreToolUse hook deferred. SYNTHETIC: hand-shaped
        // from 2.1.250's result, attachment and session-file shapes (each
        // file's first line says so), until the defer-gate record commit
        // swaps in a recorded pair.
        Case {
            name: "deferred",
            streams: &["transcript-deferred.stream.json"],
            session: Some("transcript-deferred.session.json"),
        },
    ];

    fn load(name: &str) -> Vec<Value> {
        let path = fixtures().join(name);
        if name.ends_with(".jsonl") {
            jsonl(&path)
        } else {
            lines_of(&path)
        }
    }

    fn folded_json(name: &str) -> (Folded, Value) {
        let folded = fold_lines(&load(name));
        let value = json!({ "file": name, "events": folded.events, "classes": folded.classes });
        (folded, value)
    }

    fn golden(case: &Case) -> Value {
        let streams: Vec<(Folded, Value)> = case.streams.iter().map(|s| folded_json(s)).collect();
        let session = case.session.map(folded_json);
        let content = match &session {
            Some((folded, _)) => turn_content(&folded.events),
            None => streams
                .iter()
                .flat_map(|(folded, _)| turn_content(&folded.events))
                .collect(),
        };
        json!({
            "case": case.name,
            "cli_version": super::super::transcript::CLI_VERSION,
            "streams": streams.iter().map(|(_, value)| value.clone()).collect::<Vec<_>>(),
            "session": session.as_ref().map(|(_, value)| value.clone()),
            "content": content,
        })
    }

    #[test]
    fn the_stream_and_the_session_file_fold_to_the_same_content() {
        for case in CASES.iter().filter(|case| !case.streams.is_empty()) {
            let session = turn_content(&fold_lines(&load(case.session.unwrap())).events);
            let streams: Vec<TurnContent> = case
                .streams
                .iter()
                .flat_map(|name| turn_content(&fold_lines(&load(name)).events))
                .collect();
            assert!(session.len() >= streams.len(), "{}", case.name);
            let skip = session.len() - streams.len();
            for (at, stream) in streams.iter().enumerate() {
                assert_same_turn(
                    &format!("{} turn {}", case.name, skip + at + 1),
                    stream,
                    &session[skip + at],
                );
            }
        }
    }

    #[test]
    fn transcript_goldens_are_committed_and_current() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../conformance/transcript");
        let update = std::env::var_os("UPDATE_CONFORMANCE").is_some();
        for case in CASES {
            let mut bytes = serde_json::to_string_pretty(&golden(case)).unwrap();
            bytes.push('\n');
            let path = dir.join(format!("{}.json", case.name));
            if update {
                std::fs::create_dir_all(&dir).unwrap();
                std::fs::write(&path, &bytes).unwrap();
                continue;
            }
            let committed = std::fs::read_to_string(&path).unwrap_or_else(|_| {
                panic!(
                    "{} is missing: UPDATE_CONFORMANCE=1 cargo test --manifest-path src-tauri/Cargo.toml --lib agent::fold::tests::transcript_goldens",
                    path.display()
                )
            });
            assert!(
                committed == bytes,
                "{} is stale: UPDATE_CONFORMANCE=1 cargo test --manifest-path src-tauri/Cargo.toml --lib agent::fold::tests::transcript_goldens",
                path.display()
            );
        }
    }
}
