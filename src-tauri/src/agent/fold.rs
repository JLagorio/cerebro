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
//!   content block, all under one id. A text, reasoning block or tool call
//!   already folded for the message is not folded again.
//! - A turn ends once, at its end: the stream's `result`, the next prompt, or
//!   `finish`; only a background task's continuation, below, ends it again.
//!   A stop reason is read when its message closes, so a Stop-hook
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
//! - A result's `duration_ms`, how long Claude Code worked as it counted,
//!   rides the event the result folds to (M92.2): its Result, or the
//!   ToolDeferred of a turn a hook held. A failed result's Error carries no
//!   count, and a session file, which holds no result line, gives none.
//! - A background task's notification continues a finished turn in the same
//!   process (M91.3a): a second init, the continuation's lines, and a result
//!   whose origin names the notification. That result ends the turn again,
//!   with its own Result and TurnEnded; no prompt opens it, and a session
//!   file's notification line is not one.
//! - Repeated uuids are skipped. A `<synthetic>` line is never a model or a
//!   reply: an API error becomes one `Error` per turn, and any other
//!   placeholder is skipped.
//! - A subagent's lines fold apart from the turn (M91.3b), in one sub-fold
//!   per Agent call: the stream names the call each forwarded line came
//!   from, and a subagent's own transcript names it in its meta
//!   (`SessionFold` merges those files into the session file by time). A
//!   sub-fold groups its messages and skips its repeats as the main thread
//!   does, and its events name the call as their `parent`. It never opens,
//!   ends or answers the turn, never names the turn's model, and never feeds
//!   the run's capture (CV-60). Its calls cross as previews: an input the
//!   preview cut still follows whole, since the run's commit reads a
//!   writer's path from it, but an output never does, so a subagent that
//!   reads far more than it reports stays within the journal's bounds. Its
//!   API error is its own `Error`, never the turn's. A sidechain line that
//!   names no call, and a subagent's streamed deltas, are skipped.
//! - Claude Code's notes on a subagent's life (`system/task_*`, stream only)
//!   fold to `SubagentStarted`, `SubagentProgress` and `SubagentDone`, never
//!   with its tokens; a task that is not a subagent is ignored.
//! - Reasoning folds to one `Thinking` per block, whole, in both formats
//!   (M91.3a): empty unless Claude Code was asked to show its reasoning, and
//!   with no text when redacted. Live, a delta with words in it streams first
//!   as a `ThinkingDelta`; an empty one is dropped.
//! - Each line's `timestamp` rides its events as `at` (M91.3a). A prompt
//!   carries its line's uuid, and a turn's end the uuid of its last
//!   main-thread assistant line: the anchor a conversation branches from.
//!   The stream and the session file write the same uuids.
//! - A call's structured result (the stream's `tool_use_result`, the file's
//!   `toolUseResult`) follows its ToolDone as a `ToolResult` for the tools
//!   the panel draws: a shell's output, a todo list, a subagent's report, a
//!   web fetch or search, each bounded here. A shape the fold does not read
//!   gives none, and neither does a line that carries none: 2.1.250 forwards
//!   a subagent's results to the stream without theirs. A subagent's report
//!   crosses without the trailer Claude Code writes for the model, the agent
//!   id it would continue and the tokens it spent, in its preview, its
//!   payload and its summary alike.
//! - Claude Code refusing a call by its own rules (`system/permission_denied`,
//!   stream only) folds to a `ToolDenied` before the call's error result.
//! - A turn that failed carries a notice on its `Error` when Claude Code's
//!   typed fields say how (M56.4, `super::failure`): the turn's `Failures`
//!   reads the limit events, retries, API-error replies and the result the
//!   fold already sees, in either format. An API-error reply no kind names
//!   yet holds its `Error` for the turn's result, or its end: a context-full
//!   turn replies `invalid_request` and only its result says why.
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

use std::collections::{BTreeMap, HashMap, HashSet};

use serde::Serialize;
use serde_json::Value;

use super::failure::{self, Failures};
use super::kinds;
use super::{AgentEvent, PayloadPart, SearchHit, TodoEntry, ToolResultData};

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

const SUBAGENT: &str = "a subagent's line that names no Agent call, so no sub-fold can hold it";
const SUBAGENT_DELTA: &str =
    "a piece of a subagent's message as it streamed; only the main thread streams to the panel";
const SUBAGENT_WORDS: &str =
    "words sent to a subagent, such as its prompt, which its Agent call's input already holds";
const SUBAGENT_RECORD: &str =
    "a record of a subagent's own transcript other than its messages, which no turn reads";
const OTHER_TASK: &str =
    "a background task Claude Code ran that is not a subagent, which the panel does not draw";
const DUPLICATE: &str = "a line already folded under the same uuid";
const META: &str = "a line the CLI wrote for the model, never shown to the person";
const COMPACT_SUMMARY: &str = "the summary the CLI wrote when it compacted, never shown as a turn";
const NOTIFICATION: &str =
    "a background task's notification, which continues the turn it belongs to rather than starting one";
const SYNTHETIC: &str = "a placeholder reply no model wrote";
const MALFORMED_PR_LINK: &str = "a pr-link record without a usable number, https url or owner/repo";
const NO_CONTENT: &str = "a line with no text or tool call in it";

/// What a denial says when Claude Code gave no words for it.
const DENIED: &str = "Claude Code refused this call";

/// What an API error says when Claude Code's reply gave no words for it.
const API_ERROR: &str = "Claude Code reported an API error";

/// The task type Claude Code gives a subagent (M91.3b).
const SUBAGENT_TASK: &str = "local_agent";

/// The stop reasons that end a turn.
const TERMINAL: &[&str] = &["end_turn", "stop_sequence", "max_tokens", "refusal"];

/// The model the CLI names for a reply it wrote itself.
const SYNTHETIC_MODEL: &str = "<synthetic>";

/// What an interrupt marker's text starts with.
const INTERRUPT_MARKER: &str = "[Request interrupted by user";

/// The origin Claude Code gives a turn a background task's notification
/// started (M91.3a).
const NOTIFICATION_ORIGIN: &str = "task-notification";

/// A url the fold passes on, a pr-link's or a web result's, may be at most
/// this long.
const MAX_URL: usize = 2048;

/// What a shell result keeps of each stream: its last characters, where a
/// runner prints its summary (M91.3a).
const SHELL_TAIL_CHARS: usize = 2000;

/// The most characters a todo, a search result's title or query, or a
/// subagent's summary or other words in a structured result keep (M91.3a).
const RESULT_TEXT_CHARS: usize = 500;

/// The most todos one list keeps (M91.3a).
const MAX_TODOS: usize = 100;

/// The most results one web search keeps (M91.3a).
const MAX_SEARCH_RESULTS: usize = 20;

/// What begins the trailer Claude Code appends to a subagent's report for
/// the model: the agent id it would continue it by (M91.3a).
const AGENT_TRAILER: &str = "agentId:";

/// The span that counts a subagent's tokens in its report (M91.3a).
const USAGE_OPEN: &str = "<usage>";
const USAGE_CLOSE: &str = "</usage>";

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
    /// Its reasoning blocks already folded, by signature (M91.3a).
    thoughts: HashSet<String>,
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
    /// An API-error reply's Error that no kind named yet, as its message and
    /// code: held for the turn's result, which may name the kind (a
    /// context-full turn replies `invalid_request` first, then its result
    /// says `prompt_too_long`), or for the turn's end.
    held: Option<(String, Option<String>)>,
    /// The uuid of the turn's last main-thread assistant line a model wrote
    /// (M91.3a): what its TurnEnded anchors to.
    last_uuid: Option<String>,
}

/// One thread of assistant messages: the main thread, or a subagent's
/// (M91.3b).
#[derive(Debug, Default)]
struct Thread {
    /// Its lines already folded, by uuid.
    seen: HashSet<String>,
    open: Option<OpenMessage>,
    /// Each started call's tool, by id, until its result (M91.3a): what
    /// says how to read the result's structure.
    tools: HashMap<String, String>,
}

/// A subagent's thread, folded apart from the turn (M91.3b).
#[derive(Debug, Default)]
struct SubFold {
    thread: Thread,
    /// Its calls with no result yet.
    pending: HashSet<String>,
    /// Its API error was sent: one per subagent, as one per turn.
    errored: bool,
}

/// The line-by-line fold. `fold_lines` is the batch fold, a loop over it;
/// `SessionFold` merges a subagent's own transcripts into it (M91.3b).
#[derive(Debug, Default)]
pub struct TranscriptFold {
    capture: Option<crate::import::capture::Handle>,
    /// The main thread: the person's turns.
    main: Thread,
    /// Each subagent's thread, by the Agent call that started it (M91.3b).
    subs: HashMap<String, SubFold>,
    /// The subagents Claude Code said it started, by task id, with the call
    /// each answers (M91.3b): its later notes name the task.
    tasks: HashMap<String, String>,
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

impl Classes {
    fn count(&mut self, class: LineClass) {
        match class {
            LineClass::Translated => self.translated += 1,
            LineClass::Ignored(reason) => *self.ignored.entry(reason.into()).or_default() += 1,
            LineClass::Unclassified(kind) => *self.unclassified.entry(kind).or_default() += 1,
        }
    }
}

/// Fold `lines`, then finish: the batch fold.
pub fn fold_lines(lines: &[Value]) -> Folded {
    fold_session(lines, Vec::new())
}

/// Fold a session file's `lines` with its subagents' own transcripts merged
/// in (M91.3b), then finish: `SessionFold`'s batch fold.
pub fn fold_session(lines: &[Value], subagents: Vec<SubagentTranscript>) -> Folded {
    let mut fold = SessionFold::new(subagents);
    let mut events = Vec::new();
    let mut classes = Classes::default();
    let mut sink = |class: LineClass, folded: Vec<AgentEvent>| {
        classes.count(class);
        events.extend(folded);
    };
    for line in lines {
        fold.entry(line, &mut sink);
    }
    let end = fold.finish(&mut sink);
    events.extend(end);
    Folded { events, classes }
}

/// A subagent's own transcript, as `transcript.rs` found it beside a session
/// file (M91.3b): its `agent-<id>.jsonl` lines in the file's order, read as
/// the merge asks for them, and its `.meta.json`, which names the Agent call
/// it answers. What either says is the fold's to read (CV-27).
pub struct SubagentTranscript {
    pub meta: Option<Value>,
    pub lines: Box<dyn Iterator<Item = Value>>,
}

/// Where the merge places a line: its own `timestamp`, else where the line
/// before it in its file was placed. No time sorts first.
type Placed = Option<chrono::DateTime<chrono::FixedOffset>>;

/// One subagent transcript being merged.
struct Source {
    /// The Agent call its meta names; None when the meta names none, and
    /// then its lines fold to nothing.
    parent: Option<String>,
    lines: std::iter::Fuse<Box<dyn Iterator<Item = Value>>>,
    /// Its next line, read ahead, and where it is placed.
    next: Option<(Value, Placed)>,
    /// Where its last line was placed.
    at: Placed,
}

impl Source {
    /// Where its next line is placed, reading it ahead; None once it is
    /// read through.
    fn ahead(&mut self) -> Option<Placed> {
        if self.next.is_none() {
            let line = self.lines.next()?;
            let at = time_of(&line).or(self.at);
            self.next = Some((line, at));
        }
        self.next.as_ref().map(|(_, at)| *at)
    }

    /// Its next line, which `ahead` read.
    fn take(&mut self) -> Option<Value> {
        let (line, at) = self.next.take()?;
        self.at = at;
        Some(line)
    }
}

/// A session file folded with its subagents' own transcripts (M91.3b).
/// Claude Code 2.1.250 keeps a subagent's lines out of the session file, in
/// a transcript of its own beside it, so a replay merges them back in by
/// time: before each line of the session file, every subagent line written
/// before it, earliest first; the session file wins a tie, then the earlier
/// transcript. Within each file the order is the file's. A transcript is
/// held to its meta's Agent call, as a stream line is to its
/// `parent_tool_use_id`, so both formats fold a subagent to the same events.
/// A transcript that is missing or cannot be read leaves the session file's
/// own fold whole: its subagent's steps are simply not there.
pub struct SessionFold {
    fold: TranscriptFold,
    sources: Vec<Source>,
    /// Where the session file's last line was placed.
    at: Placed,
}

impl SessionFold {
    pub fn new(subagents: Vec<SubagentTranscript>) -> Self {
        let sources = subagents
            .into_iter()
            .map(|subagent| Source {
                parent: subagent
                    .meta
                    .as_ref()
                    .and_then(|meta| str_of(meta, "toolUseId"))
                    .filter(|id| !id.is_empty())
                    .map(str::to_string),
                lines: subagent.lines.fuse(),
                next: None,
                at: None,
            })
            .collect();
        Self {
            fold: TranscriptFold::default(),
            sources,
            at: None,
        }
    }

    /// Fold one line of the session file, after every subagent line written
    /// before it. `sink` hears each line folded, with what it made of it.
    pub fn entry(&mut self, line: &Value, sink: &mut dyn FnMut(LineClass, Vec<AgentEvent>)) {
        let at = time_of(line).or(self.at);
        self.at = at;
        self.merge(Some(at), sink);
        let (class, events) = self.fold.entry(line);
        sink(class, events);
    }

    /// Fold what the subagents wrote after the session file's last line,
    /// then finish the fold, returning its last events.
    pub fn finish(mut self, sink: &mut dyn FnMut(LineClass, Vec<AgentEvent>)) -> Vec<AgentEvent> {
        self.merge(None, sink);
        self.fold.finish()
    }

    /// Fold subagent lines, earliest first, while one was written before
    /// `until`; with no bound, every one left.
    fn merge(&mut self, until: Option<Placed>, sink: &mut dyn FnMut(LineClass, Vec<AgentEvent>)) {
        loop {
            let mut next: Option<(usize, Placed)> = None;
            for (index, source) in self.sources.iter_mut().enumerate() {
                let Some(at) = source.ahead() else {
                    continue;
                };
                if next.is_none_or(|(_, earliest)| at < earliest) {
                    next = Some((index, at));
                }
            }
            let Some((index, at)) = next else {
                return;
            };
            if until.is_some_and(|until| at >= until) {
                return;
            }
            let source = &mut self.sources[index];
            let Some(line) = source.take() else {
                return;
            };
            let (class, events) = self.fold.subagent_entry(source.parent.as_deref(), &line);
            sink(class, events);
        }
    }
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

/// `key`'s string, when it is one with something in it.
fn named<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    str_of(value, key).filter(|text| !text.is_empty())
}

/// Does `line` belong to a subagent? Claude Code marks a session file's
/// sidechain lines, and the stream names the Agent call each of its lines
/// came from.
fn from_a_subagent(line: &Value) -> bool {
    flag(line, "isSidechain") || line.get("parent_tool_use_id").is_some_and(|p| !p.is_null())
}

/// The Agent call a stream line's subagent came from (M91.3b).
fn parent_of(line: &Value) -> Option<&str> {
    named(line, "parent_tool_use_id")
}

/// When `line` was written, as Claude Code wrote it (M91.3a): its
/// `timestamp`, when that is an RFC 3339 time. Durations are read from these,
/// so anything else is left out rather than passed on.
fn at_of(line: &Value) -> Option<String> {
    str_of(line, "timestamp")
        .filter(|at| chrono::DateTime::parse_from_rfc3339(at).is_ok())
        .map(str::to_string)
}

/// When `line` was written, to merge by (M91.3b).
fn time_of(line: &Value) -> Placed {
    str_of(line, "timestamp").and_then(|at| chrono::DateTime::parse_from_rfc3339(at).ok())
}

/// A line's tool results: the blocks a user line answers calls with.
fn tool_results(content: &Value) -> Vec<&Value> {
    content
        .as_array()
        .map(|blocks| {
            blocks
                .iter()
                .filter(|block| str_of(block, "type") == Some("tool_result"))
                .collect()
        })
        .unwrap_or_default()
}

/// What an assistant line with no block the fold reads is: dropped for the
/// reason the table gives its kind, or a line that held nothing.
fn unread(line: &Value) -> LineClass {
    match kinds::kinds_of(line).first() {
        Some(kind) if kinds::handling(kind).is_some() => ignored(kind),
        _ => LineClass::Ignored(NO_CONTENT),
    }
}

/// A line's own class, unless it shows a kind the table has no row for: the
/// table is the one list of kinds, so a block or kind it lacks leaves the
/// whole line unclassified, whatever else was read.
fn classified(line: &Value, class: LineClass) -> LineClass {
    match kinds::unclassified(line).into_iter().next() {
        Some(kind) => LineClass::Unclassified(kind),
        None => class,
    }
}

/// Where one thread's calls are kept while a line's blocks fold (M91.3b).
struct Calls<'a> {
    /// The Agent call whose subagent the thread is; None on the main thread.
    parent: Option<&'a str>,
    tools: &'a mut HashMap<String, String>,
    pending: &'a mut HashSet<String>,
    /// The run's capture (M69.5): the main thread's calls alone feed it,
    /// never a subagent's (CV-60).
    capture: Option<&'a crate::import::capture::Handle>,
}

/// Fold an assistant line's blocks into `open`'s message: each text,
/// reasoning block and call once. Says whether it read any block.
fn fold_blocks(
    open: &mut OpenMessage,
    content: &Value,
    at: Option<&str>,
    calls: Calls<'_>,
    events: &mut Vec<AgentEvent>,
) -> bool {
    let parent = calls.parent.map(str::to_string);
    let at = at.map(str::to_string);
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
                        parent: parent.clone(),
                        at: at.clone(),
                    });
                }
            }
            Some(kind @ ("thinking" | "redacted_thinking")) => {
                read_any = true;
                let redacted = kind == "redacted_thinking";
                // A block is known by its signature (a redacted one by its
                // sealed data), so a line that repeats the message's earlier
                // blocks folds each once.
                let key = str_of(block, if redacted { "data" } else { "signature" })
                    .filter(|key| !key.is_empty())
                    .or_else(|| str_of(block, "thinking"))
                    .unwrap_or_default();
                if open.thoughts.insert(format!("{kind}:{key}")) {
                    events.push(AgentEvent::Thinking {
                        message_id: message_id.clone(),
                        text: if redacted {
                            String::new()
                        } else {
                            str_of(block, "thinking").unwrap_or_default().to_string()
                        },
                        redacted,
                        parent: parent.clone(),
                        at: at.clone(),
                    });
                }
            }
            Some("tool_use") => {
                read_any = true;
                let tool_id = str_of(block, "id").unwrap_or_default().to_string();
                if open.tools.insert(tool_id.clone()) {
                    calls.pending.insert(tool_id.clone());
                    let tool_name = str_of(block, "name").unwrap_or("tool");
                    calls.tools.insert(tool_id.clone(), tool_name.to_string());
                    let input = block.get("input");
                    if let Some(capture) = calls.capture {
                        capture.begin(str_of(block, "name").unwrap_or(""), &tool_id, input);
                    }
                    let preview = input.map(tool_input_preview);
                    // The whole input, when the preview cut a string.
                    let whole = input
                        .map(Value::to_string)
                        .filter(|whole| Some(whole) != preview.as_ref());
                    events.push(AgentEvent::ToolStart {
                        tool_name: tool_name.to_string(),
                        tool_id: tool_id.clone(),
                        input: preview,
                        parent: parent.clone(),
                        at: at.clone(),
                    });
                    if let Some(whole) = whole {
                        events.push(payload(tool_id, PayloadPart::Input, whole, parent.clone()));
                    }
                }
            }
            _ => {}
        }
    }
    read_any
}

/// Fold a user line's tool results: each call's completion, a preview, and
/// what its structure says. A main-thread result that its preview cut
/// follows whole; a subagent's never does (M91.3b), so its reading stays
/// within the journal's bounds.
fn fold_results(line: &Value, results: &[&Value], calls: Calls<'_>, events: &mut Vec<AgentEvent>) {
    let parent = calls.parent.map(str::to_string);
    let at = at_of(line);
    // M91.3a: the structured result is the line's own, so it is read only
    // when the line answers one call.
    let structured = match results {
        [_] => line
            .get("tool_use_result")
            .or_else(|| line.get("toolUseResult")),
        _ => None,
    };
    for block in results {
        let tool_id = str_of(block, "tool_use_id").unwrap_or_default().to_string();
        calls.pending.remove(&tool_id);
        let tool = calls.tools.remove(&tool_id);
        // A subagent's report, by its call's tool, or, for a call the fold
        // never saw start, by its result's shape: its trailer never crosses.
        let report = match tool.as_deref() {
            Some(tool) => is_agent_tool(tool),
            None => structured.is_some_and(is_agent_result),
        };
        // A preview here, which every reader of the event gets; the whole
        // rides a ToolPayload only when the preview cut it, so a short result
        // crosses once.
        let whole = tool_result_whole(block);
        let whole = if report {
            whole
                .map(|whole| clean_agent_report(&whole))
                .filter(|whole| !whole.is_empty())
        } else {
            whole
        };
        // The run-owned capture precedes both preview and payload cuts; it
        // never becomes an event or a session-file reader's state.
        if let Some(capture) = calls.capture {
            capture.put(
                &tool_id,
                whole.as_deref().unwrap_or(""),
                flag(block, "is_error"),
            );
        }
        events.push(AgentEvent::ToolDone {
            tool_id: tool_id.clone(),
            output: whole.as_deref().map(result_preview),
            is_error: flag(block, "is_error"),
            parent: parent.clone(),
            at: at.clone(),
        });
        let data = structured.and_then(|result| {
            let tool = if report {
                super::cli_agents::delegate_tool()?.name.as_str()
            } else {
                tool.as_deref()?
            };
            tool_result_data(tool, result, whole.as_deref())
        });
        if let Some(whole) =
            whole.filter(|whole| parent.is_none() && whole.chars().count() > RESULT_PREVIEW_CHARS)
        {
            events.push(payload(tool_id.clone(), PayloadPart::Output, whole, None));
        }
        if let Some(data) = data {
            events.push(AgentEvent::ToolResult {
                tool_id,
                parent: parent.clone(),
                data,
            });
        }
    }
}

impl SubFold {
    /// One assistant line of the subagent the Agent call `parent` started.
    /// Its API error is its own, once: the turn's failures never hear it.
    fn assistant(
        &mut self,
        parent: &str,
        line: &Value,
        cli_version: Option<&str>,
        events: &mut Vec<AgentEvent>,
    ) -> LineClass {
        if let Some(uuid) = str_of(line, "uuid") {
            if !self.thread.seen.insert(uuid.to_string()) {
                return LineClass::Ignored(DUPLICATE);
            }
        }
        let message = line.get("message").unwrap_or(&Value::Null);
        let content = message.get("content").unwrap_or(&Value::Null);
        if str_of(message, "model") == Some(SYNTHETIC_MODEL) {
            if !failure::is_api_error_line(line) {
                return LineClass::Ignored(SYNTHETIC);
            }
            if !self.errored {
                self.errored = true;
                let mut failures = Failures::default();
                failures.observe(line);
                events.push(AgentEvent::Error {
                    message: text_of(content).unwrap_or_else(|| API_ERROR.into()),
                    code: str_of(line, "error").map(str::to_string),
                    notice: failures.notice(cli_version),
                    parent: Some(parent.to_string()),
                });
            }
            return LineClass::Translated;
        }
        let id = str_of(message, "id").map(str::to_string);
        if self.thread.open.as_ref().is_some_and(|open| open.id != id) {
            self.thread.open = None;
        }
        let open = self.thread.open.get_or_insert_with(|| OpenMessage {
            id,
            ..OpenMessage::default()
        });
        let calls = Calls {
            parent: Some(parent),
            tools: &mut self.thread.tools,
            pending: &mut self.pending,
            capture: None,
        };
        if fold_blocks(open, content, at_of(line).as_deref(), calls, events) {
            LineClass::Translated
        } else {
            unread(line)
        }
    }

    /// One user line of the subagent the Agent call `parent` started: its
    /// calls' results. The words sent to it are its call's input already.
    fn user(&mut self, parent: &str, line: &Value, events: &mut Vec<AgentEvent>) -> LineClass {
        if flag(line, "isMeta") {
            return LineClass::Ignored(META);
        }
        if flag(line, "isCompactSummary") || flag(line, "isVisibleInTranscriptOnly") {
            return LineClass::Ignored(COMPACT_SUMMARY);
        }
        if let Some(uuid) = str_of(line, "uuid") {
            if !self.thread.seen.insert(uuid.to_string()) {
                return LineClass::Ignored(DUPLICATE);
            }
        }
        let content = line
            .get("message")
            .and_then(|message| message.get("content"))
            .unwrap_or(&Value::Null);
        let results = tool_results(content);
        if results.is_empty() {
            return LineClass::Ignored(match text_of(content) {
                Some(_) => SUBAGENT_WORDS,
                None => NO_CONTENT,
            });
        }
        self.thread.open = None;
        let calls = Calls {
            parent: Some(parent),
            tools: &mut self.thread.tools,
            pending: &mut self.pending,
            capture: None,
        };
        fold_results(line, &results, calls, events);
        LineClass::Translated
    }
}

impl TranscriptFold {
    /// Live stream only. The batch/session fold deliberately has no handle.
    pub fn with_capture(capture: crate::import::capture::Handle) -> Self {
        Self {
            capture: Some(capture),
            ..Self::default()
        }
    }

    /// A resumed run's fold, told which tool the call its deferral held is
    /// (M57.1, M91.3a): the resumed stream opens with that call's result,
    /// never its start, and the result's structure is read by its tool.
    pub(crate) fn holding(mut self, held: Option<&super::cli_writes::HeldCall>) -> Self {
        if let Some(held) = held {
            self.main
                .tools
                .insert(held.tool_id.clone(), held.tool_name.clone());
        }
        self
    }

    /// Fold one parsed line. Never fails: a line it cannot read is classed,
    /// and the events it could read are still returned.
    pub fn entry(&mut self, line: &Value) -> (LineClass, Vec<AgentEvent>) {
        let mut events = Vec::new();
        let class = self.read(line, &mut events);
        (classified(line, class), events)
    }

    /// Fold one line of a subagent's own transcript (M91.3b), held to the
    /// Agent call `parent` its meta names: a message of that subagent's
    /// thread. Its other records, and every line of a transcript whose meta
    /// names no call, fold to nothing.
    fn subagent_entry(
        &mut self,
        parent: Option<&str>,
        line: &Value,
    ) -> (LineClass, Vec<AgentEvent>) {
        let mut events = Vec::new();
        let class = match (parent, str_of(line, "type")) {
            (Some(parent), Some("assistant" | "user")) => {
                self.subagent_line(parent, line, &mut events)
            }
            (Some(_), _) => LineClass::Ignored(SUBAGENT_RECORD),
            (None, _) => LineClass::Ignored(SUBAGENT),
        };
        (classified(line, class), events)
    }

    /// Fold one message line of the subagent the Agent call `parent` started
    /// (M91.3b), in that call's sub-fold.
    fn subagent_line(
        &mut self,
        parent: &str,
        line: &Value,
        events: &mut Vec<AgentEvent>,
    ) -> LineClass {
        let cli_version = self.cli_version.as_deref();
        let sub = self.subs.entry(parent.to_string()).or_default();
        if str_of(line, "type") == Some("assistant") {
            sub.assistant(parent, line, cli_version, events)
        } else {
            sub.user(parent, line, events)
        }
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
                    "permission_denied" => {
                        self.deny(line, events);
                        LineClass::Translated
                    }
                    "task_started" => self.task_started(line, events),
                    "task_progress" => self.task_progress(line, events),
                    "task_notification" => self.task_done(line, events),
                    _ => ignored(&format!("system/{subtype}")),
                }
            }
            "rate_limit_event" => {
                self.turn.failures.observe(line);
                LineClass::Translated
            }
            "stream_event" => self.stream_event(line, events),
            // M91.3b: a subagent's line folds in its call's sub-fold.
            "assistant" | "user" if from_a_subagent(line) => match parent_of(line) {
                Some(parent) => self.subagent_line(parent, line, events),
                None => LineClass::Ignored(SUBAGENT),
            },
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
                    None,
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
            | "command_lifecycle"
            | "keep_alive"
            | "tool_progress"
            | "tool_use_summary" => ignored(kind),
            _ => LineClass::Unclassified(kinds::kinds_of(line).join(",")),
        }
    }

    /// Open a turn unless one is open and not yet ended. What a turn that
    /// never opened had already heard about a failure (a limit event before
    /// the init) carries into it; an ended turn's does not. A turn that opens
    /// again with no prompt continues the one that ended (M91.3a, a
    /// background task's continuation): it keeps that turn's anchor until a
    /// line of its own names a later one.
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
                last_uuid: self.turn.last_uuid.take(),
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
        // M91.3a: only the main thread streams; a subagent's words arrive on
        // its whole lines.
        if from_a_subagent(line) {
            return LineClass::Ignored(SUBAGENT_DELTA);
        }
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
            // 2.1.250 streams an empty delta for every piece of reasoning it
            // does not show (M91.3a): nothing to send.
            "thinking_delta" => str_of(delta, "thinking")
                .filter(|text| !text.is_empty())
                .map(|text| AgentEvent::ThinkingDelta {
                    text: text.to_string(),
                }),
            other => return ignored(&format!("stream_event/content_block_delta/{other}")),
        };
        self.ensure_turn();
        events.extend(text);
        LineClass::Translated
    }

    fn close_message(&mut self) {
        if let Some(open) = self.main.open.take() {
            self.turn.last_stop = open.stop_reason;
            self.turn.last_asked_tool = !open.tools.is_empty();
            self.turn.last_said = !open.texts.is_empty();
        }
    }

    fn assistant(&mut self, line: &Value, events: &mut Vec<AgentEvent>) -> LineClass {
        if let Some(uuid) = str_of(line, "uuid") {
            if !self.main.seen.insert(uuid.to_string()) {
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
                let message = text_of(content).unwrap_or_else(|| API_ERROR.into());
                let code = str_of(line, "error").map(str::to_string);
                match self.notice() {
                    Some(notice) => events.push(AgentEvent::Error {
                        message,
                        code,
                        notice: Some(notice),
                        parent: None,
                    }),
                    None => self.turn.held = Some((message, code)),
                }
            }
            return LineClass::Translated;
        }
        self.ensure_turn();
        // M91.3a: a turn branches from a line a model wrote, never from a
        // placeholder.
        if let Some(uuid) = str_of(line, "uuid") {
            self.turn.last_uuid = Some(uuid.to_string());
        }
        let at = at_of(line);
        let id = str_of(message, "id").map(str::to_string);
        if self.main.open.as_ref().is_some_and(|open| open.id != id) {
            self.close_message();
        }
        if let Some(model) = str_of(message, "model") {
            self.name_model(model, events);
        }
        let open = self.main.open.get_or_insert_with(|| OpenMessage {
            id,
            ..OpenMessage::default()
        });
        if let Some(stop) = str_of(message, "stop_reason") {
            open.stop_reason = Some(stop.to_string());
        }
        let calls = Calls {
            parent: None,
            tools: &mut self.main.tools,
            pending: &mut self.turn.pending,
            capture: self.capture.as_ref(),
        };
        if fold_blocks(open, content, at.as_deref(), calls, events) {
            LineClass::Translated
        } else {
            unread(line)
        }
    }

    fn user(&mut self, line: &Value, events: &mut Vec<AgentEvent>) -> LineClass {
        if flag(line, "isMeta") {
            return LineClass::Ignored(META);
        }
        if flag(line, "isCompactSummary") || flag(line, "isVisibleInTranscriptOnly") {
            return LineClass::Ignored(COMPACT_SUMMARY);
        }
        // M91.3a: what a background task's notification says goes to the
        // model; the turn it continues is still the person's.
        if line.pointer("/origin/kind").and_then(Value::as_str) == Some(NOTIFICATION_ORIGIN) {
            return LineClass::Ignored(NOTIFICATION);
        }
        if let Some(uuid) = str_of(line, "uuid") {
            if !self.main.seen.insert(uuid.to_string()) {
                return LineClass::Ignored(DUPLICATE);
            }
        }
        let content = line
            .get("message")
            .and_then(|message| message.get("content"))
            .unwrap_or(&Value::Null);
        let results = tool_results(content);
        if !results.is_empty() {
            self.close_message();
            self.ensure_turn();
            let calls = Calls {
                parent: None,
                tools: &mut self.main.tools,
                pending: &mut self.turn.pending,
                capture: self.capture.as_ref(),
            };
            fold_results(line, &results, calls, events);
            return LineClass::Translated;
        }
        let Some(text) = text_of(content) else {
            return LineClass::Ignored(NO_CONTENT);
        };
        self.close_message();
        if text.starts_with(INTERRUPT_MARKER) {
            if self.turn.open && !self.turn.ended {
                self.release_held(events);
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
        events.push(AgentEvent::UserPrompt {
            text,
            uuid: str_of(line, "uuid").map(str::to_string),
        });
        LineClass::Translated
    }

    fn result(&mut self, line: &Value, events: &mut Vec<AgentEvent>) {
        self.close_message();
        // A background task's notification (M91.3a) answers in the process
        // whose turn already ended: its result opens that turn again, as the
        // continuation's, and ends it at the continuation's anchor.
        self.ensure_turn();
        if let Some(id) = str_of(line, "session_id") {
            self.session_id = Some(id.to_string());
        }
        // M92.2: how long Claude Code worked, as it counted. Anything but a
        // whole count of milliseconds is no count at all.
        let duration_ms = line.get("duration_ms").and_then(Value::as_u64);
        // M57.1: a deferred run's result is a suspension, not an answer.
        if let Some(deferred) = line.get("deferred_tool_use").filter(|d| d.is_object()) {
            self.defer(
                str_of(deferred, "id"),
                str_of(deferred, "name"),
                duration_ms,
                events,
            );
            return;
        }
        self.turn.failures.observe(line);
        self.release_held(events);
        let text = str_of(line, "result").unwrap_or_default().to_string();
        if flag(line, "is_error") {
            if !self.turn.errored {
                self.turn.errored = true;
                // A failed result with no `result` text may say why in
                // `errors` instead: a `--resume` whose session file is gone
                // answers "No conversation found with session ID: ..." there.
                let reported = if text.is_empty() {
                    result_errors(line)
                } else {
                    text
                };
                events.push(AgentEvent::Error {
                    message: if reported.is_empty() {
                        "the agent reported an error".into()
                    } else {
                        reported
                    },
                    code: str_of(line, "subtype").map(str::to_string),
                    notice: self.notice(),
                    parent: None,
                });
            }
        } else {
            events.push(AgentEvent::Result {
                text,
                session_id: self.session_id.clone(),
                duration_ms,
            });
        }
        self.end_turn(
            Some(str_of(line, "stop_reason").map(str::to_string)),
            events,
        );
    }

    /// Suspend the turn on a deferred call (M57.1): one `ToolDeferred` per
    /// call, whichever of its two lines comes first, carrying the time the
    /// stream's result counted (M92.2).
    fn defer(
        &mut self,
        id: Option<&str>,
        name: Option<&str>,
        duration_ms: Option<u64>,
        events: &mut Vec<AgentEvent>,
    ) {
        self.close_message();
        self.ensure_turn();
        self.turn.suspended = true;
        let tool_id = id.unwrap_or_default().to_string();
        if self.turn.deferred.insert(tool_id.clone()) {
            events.push(AgentEvent::ToolDeferred {
                tool_id,
                tool_name: name.unwrap_or("tool").to_string(),
                duration_ms,
            });
        }
    }

    /// Claude Code refused a call by its own rules (M91.3a): one ToolDenied,
    /// in its words, ahead of the call's error result. A denial that names
    /// no call has nothing to land on, and one of a subagent's calls leaves
    /// the turn alone (M91.3b).
    fn deny(&mut self, line: &Value, events: &mut Vec<AgentEvent>) {
        let Some(tool_id) = str_of(line, "tool_use_id").filter(|id| !id.is_empty()) else {
            return;
        };
        if !self.subs.values().any(|sub| sub.pending.contains(tool_id)) {
            self.ensure_turn();
        }
        let message = str_of(line, "message")
            .map(str::trim)
            .filter(|message| !message.is_empty())
            .map_or_else(|| DENIED.to_string(), result_preview);
        events.push(AgentEvent::ToolDenied {
            tool_id: tool_id.to_string(),
            tool_name: str_of(line, "tool_name").unwrap_or("tool").to_string(),
            message,
        });
    }

    /// Claude Code started a task (M91.3b, stream only): a subagent, by its
    /// task type, folds to SubagentStarted and is known by its task id from
    /// then on; any other task is not drawn. One that names no task or no
    /// call has nothing to land on. Its prompt is its call's input already.
    fn task_started(&mut self, line: &Value, events: &mut Vec<AgentEvent>) -> LineClass {
        if str_of(line, "task_type") != Some(SUBAGENT_TASK) {
            return LineClass::Ignored(OTHER_TASK);
        }
        let (Some(task), Some(tool_id)) = (named(line, "task_id"), named(line, "tool_use_id"))
        else {
            return LineClass::Translated;
        };
        self.tasks.insert(task.to_string(), tool_id.to_string());
        events.push(AgentEvent::SubagentStarted {
            tool_id: tool_id.to_string(),
            agent_id: clip(task, RESULT_TEXT_CHARS),
            subagent_type: words(line, "subagent_type"),
            description: words(line, "description"),
            background: flag(line, "is_backgrounded"),
            depth: line.get("spawn_depth").and_then(Value::as_u64),
        });
        LineClass::Translated
    }

    /// What a running subagent is doing (M91.3b, stream only): its latest
    /// step in Claude Code's words, its last tool, and its tool uses and time
    /// so far. Never its tokens.
    fn task_progress(&self, line: &Value, events: &mut Vec<AgentEvent>) -> LineClass {
        let Some(tool_id) = self.subagent_call(line) else {
            return LineClass::Ignored(OTHER_TASK);
        };
        let usage = line.get("usage").unwrap_or(&Value::Null);
        events.push(AgentEvent::SubagentProgress {
            tool_id,
            description: words(line, "description"),
            last_tool: named(line, "last_tool_name").map(|tool| clip(tool, RESULT_TEXT_CHARS)),
            tool_uses: usage.get("tool_uses").and_then(Value::as_u64),
            duration_ms: usage.get("duration_ms").and_then(Value::as_u64),
        });
        LineClass::Translated
    }

    /// A subagent ended (M91.3b, stream only), in Claude Code's word for
    /// how, with its totals. Never its tokens, and never its summary: the
    /// Agent call's own result carries its report.
    fn task_done(&mut self, line: &Value, events: &mut Vec<AgentEvent>) -> LineClass {
        let Some(tool_id) = self.subagent_call(line) else {
            return LineClass::Ignored(OTHER_TASK);
        };
        if let Some(task) = named(line, "task_id") {
            self.tasks.remove(task);
        }
        let usage = line.get("usage").unwrap_or(&Value::Null);
        events.push(AgentEvent::SubagentDone {
            tool_id,
            status: words(line, "status"),
            tool_uses: usage.get("tool_uses").and_then(Value::as_u64),
            duration_ms: usage.get("duration_ms").and_then(Value::as_u64),
        });
        LineClass::Translated
    }

    /// The Agent call a task's note is about (M91.3b): a subagent this fold
    /// saw start, by its task id, or, for one it did not, a call it knows was
    /// made with the subagent tool. Any other task is no subagent's.
    fn subagent_call(&self, line: &Value) -> Option<String> {
        let tool_id = named(line, "tool_use_id");
        if let Some(started) = named(line, "task_id").and_then(|task| self.tasks.get(task)) {
            return Some(tool_id.unwrap_or(started).to_string());
        }
        let tool_id = tool_id?;
        let tool = self.main.tools.get(tool_id).or_else(|| {
            self.subs
                .values()
                .find_map(|sub| sub.thread.tools.get(tool_id))
        })?;
        is_agent_tool(tool).then(|| tool_id.to_string())
    }

    /// Send the held API-error Error, carrying whatever notice the turn's
    /// lines name by now (M56.4).
    fn release_held(&mut self, events: &mut Vec<AgentEvent>) {
        if let Some((message, code)) = self.turn.held.take() {
            events.push(AgentEvent::Error {
                message,
                code,
                notice: self.notice(),
                parent: None,
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
        self.release_held(events);
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
            Some(stop_reason) => AgentEvent::TurnEnded {
                stop_reason,
                last_uuid: self.turn.last_uuid.clone(),
            },
            None => AgentEvent::TurnInterrupted {
                reason: "cut_off".into(),
            },
        });
    }
}

/// The non-blank strings of a result's `errors` array, joined, or empty.
fn result_errors(line: &Value) -> String {
    line.get("errors")
        .and_then(Value::as_array)
        .map(|errors| {
            errors
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|e| !e.is_empty())
                .collect::<Vec<_>>()
                .join("; ")
        })
        .unwrap_or_default()
}

/// A pr-link record as a link, when it names a positive number, an https url
/// of at most MAX_URL bytes and an `owner/repo`.
fn pr_link(line: &Value) -> Option<AgentEvent> {
    let number = line.get("prNumber")?.as_u64().filter(|n| *n > 0)?;
    let url = str_of(line, "prUrl")?;
    let repository = str_of(line, "prRepository")?;
    let usable = url.starts_with("https://")
        && url.len() <= MAX_URL
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
fn payload(
    tool_id: String,
    part: PayloadPart,
    mut whole: String,
    parent: Option<String>,
) -> AgentEvent {
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
        parent,
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

// ---------------------------------------------------------------------------
// Structured results (M91.3a)
// ---------------------------------------------------------------------------

/// Is `tool` Claude Code's subagent tool, by any name the manifest's
/// delegate row gives it (CV-04: its name and aliases are data)?
fn is_agent_tool(tool: &str) -> bool {
    super::cli_agents::delegate_tool().is_some_and(|subagent| {
        crate::policy::tools::cli_tool(tool).is_some_and(|row| row.name == subagent.name)
    })
}

/// Is a call's structured result a subagent's report? Asked only of a call
/// the fold never saw start.
fn is_agent_result(result: &Value) -> bool {
    str_of(result, "agentId").is_some()
}

/// A subagent's report without what Claude Code appends to it for the model:
/// every `<usage>…</usage>` span, which counts the subagent's tokens, and
/// the `agentId: …` block that says how to continue it. An unclosed span
/// runs to the end.
fn clean_agent_report(whole: &str) -> String {
    let mut text = String::with_capacity(whole.len());
    let mut rest = whole;
    while let Some(open) = rest.find(USAGE_OPEN) {
        text.push_str(&rest[..open]);
        rest = match rest[open..].find(USAGE_CLOSE) {
            Some(close) => &rest[open + close + USAGE_CLOSE.len()..],
            None => "",
        };
    }
    text.push_str(rest);
    // The trailer is the report's last block, so the last line that opens
    // with it is where it starts.
    let trailer = text
        .match_indices(AGENT_TRAILER)
        .map(|(at, _)| at)
        .filter(|&at| at == 0 || text[..at].ends_with('\n'))
        .last();
    if let Some(at) = trailer {
        text.truncate(at);
    }
    text.trim().to_string()
}

/// `text`, cut to at most `max` characters, the cut marked with an ellipsis.
fn clip(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let head: String = text.chars().take(max - 1).collect();
    format!("{head}…")
}

/// `key`'s words on `line`, clipped to `RESULT_TEXT_CHARS`, or none at all
/// when it says nothing (M91.3b).
fn words(line: &Value, key: &str) -> String {
    str_of(line, key)
        .map(|text| clip(text, RESULT_TEXT_CHARS))
        .unwrap_or_default()
}

/// The last `max` characters of `text`, and whether that cut anything.
fn tail(text: &str, max: usize) -> (String, bool) {
    let count = text.chars().count();
    if count <= max {
        return (text.to_string(), false);
    }
    let start = text
        .char_indices()
        .nth(count - max)
        .map_or(text.len(), |(at, _)| at);
    (text[start..].to_string(), true)
}

/// What a call's structured result says, for the tools whose results the
/// panel draws; `report` is the call's result text, a subagent's cleaned. A
/// tool the panel draws no result for, or a shape this build does not read,
/// gives none, never an error.
fn tool_result_data(tool: &str, result: &Value, report: Option<&str>) -> Option<ToolResultData> {
    match tool {
        "Bash" => shell_result(result),
        "TodoWrite" => todos_result(result),
        "WebFetch" => web_fetch_result(result),
        "WebSearch" => web_search_result(result),
        _ if is_agent_tool(tool) => agent_result(result, report),
        _ => None,
    }
}

/// A shell call's streams, each cut to its last `SHELL_TAIL_CHARS`; a call
/// that names neither stream, or names one that is not text, is not one.
fn shell_result(result: &Value) -> Option<ToolResultData> {
    let result = result.as_object()?;
    if !result.contains_key("stdout") && !result.contains_key("stderr") {
        return None;
    }
    let stream = |key: &str| match result.get(key) {
        None => Some(""),
        Some(Value::String(text)) => Some(text.as_str()),
        Some(_) => None,
    };
    let (stdout, cut_out) = tail(stream("stdout")?, SHELL_TAIL_CHARS);
    let (stderr, cut_err) = tail(stream("stderr")?, SHELL_TAIL_CHARS);
    Some(ToolResultData::Shell {
        stdout,
        stderr,
        interrupted: result
            .get("interrupted")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        truncated: cut_out || cut_err,
    })
}

/// The list a TodoWrite call left, its `newTodos`: at most `MAX_TODOS`, each
/// with a content and a status, every word clipped.
fn todos_result(result: &Value) -> Option<ToolResultData> {
    let todos = result
        .get("newTodos")?
        .as_array()?
        .iter()
        .filter_map(|todo| {
            Some(TodoEntry {
                content: clip(str_of(todo, "content")?, RESULT_TEXT_CHARS),
                status: clip(str_of(todo, "status")?, RESULT_TEXT_CHARS),
                active_form: str_of(todo, "activeForm").map(|form| clip(form, RESULT_TEXT_CHARS)),
            })
        })
        .take(MAX_TODOS)
        .collect();
    Some(ToolResultData::Todos { todos })
}

/// What a subagent reported: Claude Code's totals for it, never its tokens,
/// and its cleaned `report` as its summary.
fn agent_result(result: &Value, report: Option<&str>) -> Option<ToolResultData> {
    let result = result.as_object()?;
    let words = |key: &str| {
        result
            .get(key)
            .and_then(Value::as_str)
            .map(|text| clip(text, RESULT_TEXT_CHARS))
    };
    let count = |key: &str| result.get(key).and_then(Value::as_u64);
    Some(ToolResultData::Agent {
        agent_id: words("agentId"),
        agent_type: words("agentType"),
        status: words("status"),
        tool_uses: count("totalToolUseCount"),
        duration_ms: count("totalDurationMs"),
        model: words("resolvedModel"),
        summary: report
            .filter(|report| !report.is_empty())
            .map(|report| clip(report, RESULT_TEXT_CHARS)),
    })
}

/// A web fetch's url and how the fetch went.
fn web_fetch_result(result: &Value) -> Option<ToolResultData> {
    let url = str_of(result, "url").filter(|url| url.len() <= MAX_URL)?;
    Some(ToolResultData::WebFetch {
        url: url.to_string(),
        code: result.get("code").and_then(Value::as_u64),
        bytes: result.get("bytes").and_then(Value::as_u64),
        duration_ms: result.get("durationMs").and_then(Value::as_u64),
    })
}

/// A web search's query and its results: each result block's `{title, url}`
/// entries, http(s) only, at most `MAX_SEARCH_RESULTS`. Claude Code mixes its
/// own words about the results in as bare strings, which are not results.
fn web_search_result(result: &Value) -> Option<ToolResultData> {
    let query = str_of(result, "query")?;
    let results = result
        .get("results")?
        .as_array()?
        .iter()
        .filter_map(|item| item.get("content").and_then(Value::as_array))
        .flatten()
        .filter_map(|hit| {
            let url = str_of(hit, "url").filter(|url| is_web_url(url))?;
            Some(SearchHit {
                title: clip(str_of(hit, "title")?, RESULT_TEXT_CHARS),
                url: url.to_string(),
            })
        })
        .take(MAX_SEARCH_RESULTS)
        .collect();
    Some(ToolResultData::WebSearch {
        query: clip(query, RESULT_TEXT_CHARS),
        results,
    })
}

/// Is `url` an http(s) url short enough to pass on?
fn is_web_url(url: &str) -> bool {
    let scheme = url.split_once("://").map(|(scheme, _)| scheme);
    url.len() <= MAX_URL
        && scheme.is_some_and(|scheme| {
            scheme.eq_ignore_ascii_case("https") || scheme.eq_ignore_ascii_case("http")
        })
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
/// order, a subagent's events naming their Agent call (M91.3b). A turn's end
/// is a marker and its anchor (M91.3a): the stream names its stop reason in
/// the result, which the file does not hold. When each line was written
/// (`at`) is left out, and so is what only the stream says.
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
            AgentEvent::Thinking { text, redacted, .. } => {
                Some(json!({ "kind": "Thinking", "text": text, "redacted": redacted }))
            }
            AgentEvent::ToolStart {
                tool_name,
                tool_id,
                input,
                ..
            } => Some(
                json!({ "kind": "ToolStart", "tool_name": tool_name, "tool_id": tool_id, "input": input }),
            ),
            AgentEvent::ToolDone {
                tool_id,
                output,
                is_error,
                ..
            } => Some(
                json!({ "kind": "ToolDone", "tool_id": tool_id, "output": output, "is_error": is_error }),
            ),
            AgentEvent::ToolPayload {
                tool_id,
                part,
                text,
                bytes,
                truncated,
                ..
            } => Some(json!({
                "kind": "ToolPayload", "tool_id": tool_id, "part": part, "text": text,
                "bytes": bytes, "truncated": truncated
            })),
            AgentEvent::ToolResult { tool_id, data, .. } => {
                Some(json!({ "kind": "ToolResult", "tool_id": tool_id, "data": data }))
            }
            AgentEvent::Error {
                message,
                code,
                notice,
                ..
            } => {
                Some(json!({ "kind": "Error", "message": message, "code": code, "notice": notice }))
            }
            AgentEvent::TurnEnded { last_uuid, .. } => {
                Some(json!({ "kind": "TurnEnded", "last_uuid": last_uuid }))
            }
            AgentEvent::TurnInterrupted { .. } => Some(json!({ "kind": "TurnInterrupted" })),
            AgentEvent::ToolDeferred {
                tool_id, tool_name, ..
            } => {
                Some(json!({ "kind": "ToolDeferred", "tool_id": tool_id, "tool_name": tool_name }))
            }
            _ => None,
        };
        let Some(mut shown) = shown else { continue };
        // M91.3b: a subagent's event names its Agent call.
        if let Some(parent) = event.parent() {
            shown["parent"] = json!(parent);
        }
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
                AgentEvent::Result { text: result, session_id: Some(sid), duration_ms: None },
                AgentEvent::TurnEnded { stop_reason: None, .. },
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
            matches!(events.as_slice(), [AgentEvent::Error { message, code: Some(code), notice: None, parent: None }, AgentEvent::TurnEnded { stop_reason: Some(stop), .. }]
                if message == "rate limited" && code == "error_during_execution" && stop == "error"),
            "{events:?}"
        );
    }

    #[test]
    fn a_failed_result_with_no_text_says_its_errors() {
        // Measured on CLI 2.1.250: a `--resume` whose session file is gone
        // answers with `errors` and no `result` text.
        let events = one(
            json!({ "type": "result", "subtype": "error_during_execution",
            "is_error": true, "errors": [
                "No conversation found with session ID: 00000000-0000-4000-8000-000000000009", " "
            ] }),
        );
        assert!(
            matches!(events.as_slice(), [AgentEvent::Error { message, .. }, AgentEvent::TurnEnded { .. }]
                if message == "No conversation found with session ID: 00000000-0000-4000-8000-000000000009"),
            "{events:?}"
        );
        let bare = one(
            json!({ "type": "result", "subtype": "error_during_execution",
            "is_error": true, "errors": [] }),
        );
        assert!(
            matches!(bare.as_slice(), [AgentEvent::Error { message, .. }, AgentEvent::TurnEnded { .. }]
                if message == "the agent reported an error"),
            "{bare:?}"
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
            parent: None,
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
        } = payload("t1".into(), PayloadPart::Output, whole.clone(), None)
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
            None,
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
            matches!(folded.events.last(), Some(AgentEvent::TurnEnded { stop_reason: Some(s), .. }) if s == "end_turn")
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
            // M91.3b: a subagent's line that names no Agent call has no
            // sub-fold to fold in.
            (
                json!({ "type": "assistant", "isSidechain": true, "message": { "id": "m", "model": "x",
                "content": [{ "type": "text", "text": "sub" }] } }),
                SUBAGENT,
            ),
            (
                json!({ "type": "user", "parent_tool_use_id": "", "message": {
                "content": [{ "type": "tool_result", "tool_use_id": "t1", "content": "sub" }] } }),
                SUBAGENT,
            ),
            (
                json!({ "type": "assistant", "parent_tool_use_id": 9, "message": { "id": "m",
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
            matches!(errors.as_slice(), [AgentEvent::Error { code: Some(code), message, notice: Some(notice), parent: None }]
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
    fn a_context_full_turn_sends_one_error_with_its_notice() {
        // 2.1.250 ends a context-full turn with an invalid_request reply, then
        // the result naming prompt_too_long: the reply alone names no kind, so
        // its Error waits for the result and carries the result's notice.
        let reply = json!({ "type": "assistant", "uuid": "a1", "error": "invalid_request",
            "is_api_error_message": true, "message": { "id": "m1", "model": "<synthetic>",
            "content": [{ "type": "text", "text": "Prompt is too long" }] } });
        let folded = fold_lines(&[
            json!({ "type": "system", "subtype": "init", "session_id": "s1",
                "model": "claude-test", "claude_code_version": "2.1.250" }),
            reply.clone(),
            json!({ "type": "result", "subtype": "success", "is_error": true,
                "result": "Prompt is too long", "terminal_reason": "prompt_too_long",
                "session_id": "s1" }),
        ]);
        let errors: Vec<&AgentEvent> = folded
            .events
            .iter()
            .filter(|event| matches!(event, AgentEvent::Error { .. }))
            .collect();
        assert!(
            matches!(errors.as_slice(), [AgentEvent::Error { code: Some(code), message, notice: Some(notice), parent: None }]
                if code == "invalid_request" && message == "Prompt is too long"
                    && notice.kind == failure::FailureKind::ContextFull
                    && notice.action == Some(failure::NoticeAction::NewConversation)),
            "{:?}",
            folded.events
        );
        assert!(matches!(
            folded.events.last(),
            Some(AgentEvent::TurnEnded { .. })
        ));

        // A session file has no result: the held Error goes at the turn's
        // end, still one, and with no kind to name it keeps its words alone.
        let folded = fold_lines(&[prompt("hi", "u0"), reply]);
        assert!(
            matches!(
                folded.events.as_slice(),
                [
                    AgentEvent::UserPrompt { .. },
                    AgentEvent::Error { notice: None, .. },
                    AgentEvent::TurnEnded { .. }
                ]
            ),
            "{:?}",
            folded.events
        );
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
        let long = format!("https://github.com/{}", "x".repeat(MAX_URL));
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
        // M92.2: it carries the time the result counted.
        assert_eq!(
            folded.events.last(),
            Some(&AgentEvent::ToolDeferred {
                tool_id: "toolu_000000000000000000005701".into(),
                tool_name: "mcp__cerebro__append_to_note".into(),
                duration_ms: Some(2400),
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
                tool_name: "Bash".into(),
                duration_ms: None,
            }]
        );
        assert!(fold.finish().is_empty());
    }

    /// The call the first ToolDeferred of `events` holds, and the time it
    /// carries.
    fn held(events: &[AgentEvent]) -> Option<(&str, &str, Option<u64>)> {
        events.iter().find_map(|event| match event {
            AgentEvent::ToolDeferred {
                tool_id,
                tool_name,
                duration_ms,
            } => Some((tool_id.as_str(), tool_name.as_str(), *duration_ms)),
            _ => None,
        })
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
        // The same call, held; only the stream's result counted the time
        // (M92.2), so the marker carries none.
        let (marked, streamed) = (
            held(&session.events).unwrap(),
            held(&stream.events).unwrap(),
        );
        assert_eq!((marked.0, marked.1), (streamed.0, streamed.1));
        assert_eq!((marked.2, streamed.2), (None, Some(2400)));
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

    // --- How long Claude Code worked (M92.2) ---------------------------------

    /// The time each event a result folded to carries, in order.
    fn worked(events: &[AgentEvent]) -> Vec<Option<u64>> {
        events
            .iter()
            .filter_map(|event| match event {
                AgentEvent::Result { duration_ms, .. }
                | AgentEvent::ToolDeferred { duration_ms, .. } => Some(*duration_ms),
                _ => None,
            })
            .collect()
    }

    /// A finished result line, with `extra` set on it.
    fn finished(extra: Value) -> Value {
        let mut line = json!({ "type": "result", "subtype": "success", "is_error": false,
            "result": "done", "stop_reason": "end_turn", "session_id": "s-1" });
        for (key, value) in extra.as_object().unwrap() {
            line[key] = value.clone();
        }
        line
    }

    #[test]
    fn a_results_working_time_rides_its_result() {
        // P14's measurement: a live ask's wait is in it.
        let counted = finished(json!({ "duration_ms": 12_213, "duration_api_ms": 4_278 }));
        let events = one(counted);
        assert_eq!(kinds(&events), ["Result", "TurnEnded"]);
        assert_eq!(worked(&events), [Some(12_213)]);
        // A result that counted nothing, or nothing as a whole number of
        // milliseconds, says so: None, never 0.
        for extra in [
            json!({}),
            json!({ "duration_ms": null }),
            json!({ "duration_ms": "12213" }),
            json!({ "duration_ms": -5 }),
            json!({ "duration_ms": 12.5 }),
        ] {
            assert_eq!(worked(&one(finished(extra.clone()))), [None], "{extra}");
        }
        // A held turn's result carries it on its one ToolDeferred.
        let mut deferred = deferred_result("t1", "Bash");
        deferred["duration_ms"] = json!(2_400);
        assert_eq!(
            one(deferred),
            [AgentEvent::ToolDeferred {
                tool_id: "t1".into(),
                tool_name: "Bash".into(),
                duration_ms: Some(2_400),
            }]
        );
        // A failed result folds to an Error, which carries no count.
        let failed = finished(json!({ "is_error": true, "subtype": "error_max_turns",
            "duration_ms": 2_400 }));
        let events = one(failed);
        assert_eq!(kinds(&events), ["Error", "TurnEnded"]);
        assert_eq!(worked(&events), []);
        // On the wire it is left out when nobody counted, so such an event
        // crosses as it did before.
        let wire = |duration_ms| {
            serde_json::to_value(AgentEvent::Result {
                text: "done".into(),
                session_id: None,
                duration_ms,
            })
            .unwrap()
        };
        assert_eq!(
            wire(None),
            json!({ "kind": "Result", "text": "done", "session_id": null })
        );
        assert_eq!(wire(Some(9)).get("duration_ms"), Some(&json!(9)));
    }

    #[test]
    fn a_session_file_gives_no_working_time_and_each_stream_its_results_own() {
        for case in CASES {
            // A session file holds no result line: no Result, and its
            // deferral marker counts nothing.
            if let Some((session, _)) = session_json(case) {
                assert!(
                    !session
                        .events
                        .iter()
                        .any(|event| matches!(event, AgentEvent::Result { .. })),
                    "{}",
                    case.name
                );
                assert!(
                    worked(&session.events).iter().all(Option::is_none),
                    "{}",
                    case.name
                );
            }
            // Each stream's events carry what each of its results counted,
            // a failed one's aside.
            for name in case.streams {
                let lines = load(name);
                let counted: Vec<Option<u64>> = lines
                    .iter()
                    .filter(|line| {
                        str_of(line, "type") == Some("result") && !flag(line, "is_error")
                    })
                    .map(|line| line.get("duration_ms").and_then(Value::as_u64))
                    .collect();
                assert_eq!(worked(&fold_lines(&lines).events), counted, "{name}");
            }
        }
    }

    // --- Reasoning, results, denials and anchors (M91.3a) --------------------

    /// The events of `kind` the fold of fixture `name` made.
    fn of_kind(name: &str, kind: &str) -> Vec<AgentEvent> {
        fold_lines(&load(name))
            .events
            .into_iter()
            .filter(|event| kind_of(event) == kind)
            .collect()
    }

    #[test]
    fn reasoning_folds_whole_from_both_formats() {
        let stream = of_kind("transcript-thinking-summarized.stream.json", "Thinking");
        assert_eq!(
            stream,
            of_kind("transcript-thinking-summarized.session.json", "Thinking"),
            "the same blocks, at the same times, in both"
        );
        let [AgentEvent::Thinking {
            message_id,
            text: first,
            redacted: false,
            parent: None,
            at: Some(at),
        }, AgentEvent::Thinking { text: second, .. }] = stream.as_slice()
        else {
            panic!("two blocks: {stream:?}");
        };
        assert_eq!(message_id, "msg_000000000000000000009101");
        assert_eq!(at, "2026-10-22T12:00:02.000Z");
        // Live, the words streamed first, every delta holding some.
        let streamed: Vec<String> = of_kind(
            "transcript-thinking-summarized.stream.json",
            "ThinkingDelta",
        )
        .into_iter()
        .map(|event| match event {
            AgentEvent::ThinkingDelta { text } => text,
            other => panic!("{other:?}"),
        })
        .collect();
        assert!(streamed.iter().all(|text| !text.is_empty()), "{streamed:?}");
        assert_eq!(streamed.concat(), format!("{first}{second}"));

        // A redacted block has no words to show, from either format.
        let redacted = json!({ "type": "redacted_thinking", "data": "sealed-1" });
        let lines = [
            json!({ "type": "assistant", "uuid": "u1", "timestamp": "2026-10-22T12:00:00.000Z",
                "parent_tool_use_id": null, "message": { "id": "m1", "model": "haiku",
                "content": [redacted.clone()] } }),
            json!({ "type": "assistant", "uuid": "u1", "timestamp": "2026-10-22T12:00:00.000Z",
                "isSidechain": false, "message": { "id": "m1", "model": "haiku",
                "content": [redacted] } }),
        ];
        for line in lines {
            let (class, events) = TranscriptFold::default().entry(&line);
            assert_eq!(class, LineClass::Translated, "{line}");
            assert!(
                matches!(events.as_slice(), [AgentEvent::ModelChanged { .. }, AgentEvent::Thinking {
                    text, redacted: true, at: Some(_), ..
                }] if text.is_empty()),
                "{events:?}"
            );
        }
        // A line that repeats its message's earlier block folds it once.
        let thought = json!({ "type": "thinking", "thinking": "Hm.", "signature": "s1" });
        let lines = [
            assistant("m1", "u1", "haiku", Value::Null, json!([thought.clone()])),
            assistant(
                "m1",
                "u2",
                "haiku",
                Value::Null,
                json!([thought, { "type": "text", "text": "Yes." }]),
            ),
        ];
        assert_eq!(
            kinds(&each(&lines)),
            ["ModelChanged", "Thinking", "Text"],
            "{lines:?}"
        );
    }

    #[test]
    fn an_empty_reasoning_delta_sends_nothing() {
        // 2.1.250's default: every reasoning delta and block empty.
        assert!(of_kind("transcript-todos.stream.json", "ThinkingDelta").is_empty());
        let blocks = of_kind("transcript-todos.stream.json", "Thinking");
        assert_eq!(blocks.len(), 2);
        assert!(blocks
            .iter()
            .all(|block| matches!(block, AgentEvent::Thinking { text, .. } if text.is_empty())));
        let empty = json!({ "type": "stream_event", "event": { "type": "content_block_delta",
            "delta": { "type": "thinking_delta", "thinking": "" } } });
        let (class, events) = TranscriptFold::default().entry(&empty);
        assert_eq!(class, LineClass::Translated);
        assert!(events.is_empty(), "{events:?}");
    }

    #[test]
    fn a_subagents_streamed_delta_is_ignored() {
        for delta in [
            json!({ "type": "text_delta", "text": "sub" }),
            json!({ "type": "thinking_delta", "thinking": "sub" }),
        ] {
            let line = json!({ "type": "stream_event", "parent_tool_use_id": "toolu_parent",
                "event": { "type": "content_block_delta", "delta": delta } });
            let (class, events) = TranscriptFold::default().entry(&line);
            assert_eq!(class, LineClass::Ignored(SUBAGENT_DELTA), "{line}");
            assert!(events.is_empty(), "{line}");
        }
        // The main thread's, its parent named null, still streams.
        let main = json!({ "type": "stream_event", "parent_tool_use_id": null,
            "event": { "type": "content_block_delta", "delta": { "type": "text_delta", "text": "hi" } } });
        assert_eq!(kinds(&one(main)), ["TextDelta"]);
    }

    #[test]
    fn structured_results_fold_alike_from_both_formats() {
        for name in ["todos", "web", "denied"] {
            let stream = of_kind(&format!("transcript-{name}.stream.json"), "ToolResult");
            assert!(!stream.is_empty(), "{name}");
            assert_eq!(
                stream,
                of_kind(&format!("transcript-{name}.session.json"), "ToolResult"),
                "{name}"
            );
        }
        // TodoWrite: the list each call left. ToolSearch and the vault's own
        // tools have none the panel draws.
        let lists: Vec<Vec<(String, String, Option<String>)>> =
            of_kind("transcript-todos.stream.json", "ToolResult")
                .into_iter()
                .map(|event| match event {
                    AgentEvent::ToolResult {
                        data: ToolResultData::Todos { todos },
                        parent: None,
                        ..
                    } => todos
                        .into_iter()
                        .map(|todo| (todo.content, todo.status, todo.active_form))
                        .collect(),
                    other => panic!("{other:?}"),
                })
                .collect();
        let todo = |content: &str, status: &str, form: &str| {
            (
                content.to_string(),
                status.to_string(),
                Some(form.to_string()),
            )
        };
        assert_eq!(
            lists,
            [
                vec![
                    todo("List the inbox", "in_progress", "Listing the inbox"),
                    todo("File each capture", "pending", "Filing each capture"),
                ],
                vec![
                    todo("List the inbox", "completed", "Listing the inbox"),
                    todo("File each capture", "completed", "Filing each capture"),
                ],
            ]
        );
        // The fetch answered first, then the search, its words left out.
        let web = of_kind("transcript-web.stream.json", "ToolResult");
        assert!(
            matches!(web.as_slice(), [
                AgentEvent::ToolResult { tool_id: fetch, data: ToolResultData::WebFetch {
                    url, code: Some(200), bytes: Some(55102), duration_ms: Some(3151) }, .. },
                AgentEvent::ToolResult { tool_id: search, data: ToolResultData::WebSearch {
                    query, results }, .. },
            ] if fetch == "toolu_000000000000000000009302"
                && url == "https://example.com/docs/components/trace"
                && search == "toolu_000000000000000000009301"
                && query == "example docs trace component"
                && results.iter().map(|hit| hit.title.as_str()).collect::<Vec<_>>()
                    == ["Trace - Example Docs", "Changelog - Example Docs"]),
            "{web:?}"
        );
        // A refused call's result is Claude Code's words, not a shell's.
        assert_eq!(
            of_kind("transcript-denied.stream.json", "ToolResult"),
            [AgentEvent::ToolResult {
                tool_id: "toolu_000000000000000000009402".into(),
                parent: None,
                data: ToolResultData::Shell {
                    stdout: "3".into(),
                    stderr: String::new(),
                    interrupted: false,
                    truncated: false,
                },
            }]
        );
    }

    fn bash_call(id: &str) -> Value {
        json!({ "type": "assistant", "message": { "id": "m-bash", "content": [
            { "type": "tool_use", "id": id, "name": "Bash", "input": { "command": "cargo test" } }
        ] } })
    }

    fn answered_with(id: &str, structured: Value) -> Value {
        json!({ "type": "user", "message": { "content": [
            { "type": "tool_result", "tool_use_id": id, "content": "done" }
        ] }, "tool_use_result": structured })
    }

    /// What one Bash call's result folds to.
    fn shell_of(structured: Value) -> Vec<AgentEvent> {
        let mut fold = TranscriptFold::default();
        fold.entry(&bash_call("t1"));
        fold.entry(&answered_with("t1", structured)).1
    }

    #[test]
    fn a_shell_result_keeps_the_tail_of_each_stream() {
        // Runners print their summary last, so the head goes, cut between
        // characters: a byte count would split every one of these.
        let stdout = format!("{}{}", "x".repeat(10), "€".repeat(SHELL_TAIL_CHARS));
        let events = shell_of(json!({ "stdout": stdout, "stderr": "warning: unused",
            "interrupted": false, "isImage": false }));
        let Some(AgentEvent::ToolResult {
            tool_id,
            data:
                ToolResultData::Shell {
                    stdout: kept,
                    stderr,
                    interrupted: false,
                    truncated: true,
                },
            ..
        }) = events.last()
        else {
            panic!("{events:?}");
        };
        assert_eq!(tool_id, "t1");
        assert_eq!(*kept, "€".repeat(SHELL_TAIL_CHARS));
        assert_eq!(stderr, "warning: unused");
        // Either stream cut says so; a stream left out is empty.
        assert!(matches!(
            shell_of(json!({ "stderr": "e".repeat(SHELL_TAIL_CHARS + 1), "interrupted": true })).last(),
            Some(AgentEvent::ToolResult { data: ToolResultData::Shell { stdout, interrupted: true, truncated: true, .. }, .. })
                if stdout.is_empty()
        ));
        assert!(matches!(
            shell_of(json!({ "stdout": "x".repeat(SHELL_TAIL_CHARS), "stderr": "" })).last(),
            Some(AgentEvent::ToolResult {
                data: ToolResultData::Shell {
                    truncated: false,
                    ..
                },
                ..
            })
        ));
        // A shape this build does not read gives no result, never an error.
        for structured in [
            json!("Error: refused"),
            json!({ "stdout": 7 }),
            json!({ "isImage": true }),
            Value::Null,
        ] {
            assert_eq!(
                kinds(&shell_of(structured.clone())),
                ["ToolDone"],
                "{structured}"
            );
        }
        // Nor does a tool the panel draws none for, or a line answering two
        // calls, whose one structured result belongs to neither.
        let mut fold = TranscriptFold::default();
        fold.entry(
            &json!({ "type": "assistant", "message": { "id": "m", "content": [
            { "type": "tool_use", "id": "r1", "name": "Read", "input": {} },
            { "type": "tool_use", "id": "b1", "name": "Bash", "input": {} }
        ] } }),
        );
        let (_, events) = fold.entry(&answered_with("r1", json!({ "stdout": "a" })));
        assert_eq!(kinds(&events), ["ToolDone"]);
        let (_, events) = fold.entry(&json!({ "type": "user", "message": { "content": [
            { "type": "tool_result", "tool_use_id": "b1", "content": "a" },
            { "type": "tool_result", "tool_use_id": "b2", "content": "b" }
        ] }, "tool_use_result": { "stdout": "a" } }));
        assert_eq!(kinds(&events), ["ToolDone", "ToolDone"]);
    }

    /// The trailer 2.1.250 appends to a subagent's report for the model
    /// (measured), with a synthetic agent id.
    const TRAILER: &str = "agentId: a0000000000000001 (use SendMessage with to: \
        'a0000000000000001', summary: '<5-10 word recap>' to continue this agent)\n\
        <usage>subagent_tokens: 2778\ntool_uses: 1\nduration_ms: 4145</usage>";

    /// An Agent call's result as 2.1.250 writes it (measured): the report,
    /// then the trailer, and the totals under `key`, the stream's or the
    /// session file's.
    fn agent_report(id: &str, report: &str, key: &str) -> Value {
        let mut line = json!({ "type": "user", "timestamp": "2026-10-22T12:00:09.000Z",
            "message": { "role": "user", "content": [{ "tool_use_id": id, "type": "tool_result",
                "content": [{ "type": "text", "text": report }, { "type": "text", "text": TRAILER }] }] } });
        line[key] = json!({ "status": "completed", "prompt": "Read b.md.",
            "agentId": "a0000000000000001", "agentType": "cerebro-researcher",
            "content": [{ "type": "text", "text": report }],
            "resolvedModel": "claude-haiku-4-5-20251001", "totalDurationMs": 4145,
            "totalTokens": 2778, "totalToolUseCount": 1,
            "usage": { "input_tokens": 2686, "output_tokens": 92 } });
        line
    }

    #[test]
    fn a_subagents_report_crosses_without_its_trailer() {
        let report = format!("{}The file says beta.", "Read it with care. ".repeat(150));
        assert!(report.chars().count() > RESULT_PREVIEW_CHARS);
        for (name, key) in [("Agent", "tool_use_result"), ("Task", "toolUseResult")] {
            let mut fold = TranscriptFold::default();
            let mut events = fold
                .entry(
                    &json!({ "type": "assistant", "message": { "id": "m-agent", "content": [
                    { "type": "tool_use", "id": "t-agent", "name": name, "input": {
                        "description": "Read b.md", "subagent_type": "cerebro-researcher",
                        "prompt": "Read b.md." } }
                ] } }),
                )
                .1;
            events.extend(fold.entry(&agent_report("t-agent", &report, key)).1);
            let wire = serde_json::to_string(&events).unwrap();
            for leak in [
                "subagent_tokens",
                "agentId:",
                "<usage>",
                "totalTokens",
                "2778",
            ] {
                assert!(!wire.contains(leak), "{name}: {leak} crossed: {wire}");
            }
            assert_eq!(
                kinds(&events),
                ["ToolStart", "ToolDone", "ToolPayload", "ToolResult"],
                "{name}"
            );
            assert!(
                matches!(&events[2], AgentEvent::ToolPayload { part: PayloadPart::Output, text, .. }
                    if *text == report),
                "{name}: the payload is the report whole"
            );
            let AgentEvent::ToolResult {
                data:
                    ToolResultData::Agent {
                        agent_id,
                        agent_type,
                        status,
                        tool_uses,
                        duration_ms,
                        model,
                        summary,
                    },
                ..
            } = &events[3]
            else {
                panic!("{events:?}");
            };
            assert_eq!(agent_id.as_deref(), Some("a0000000000000001"));
            assert_eq!(agent_type.as_deref(), Some("cerebro-researcher"));
            assert_eq!(status.as_deref(), Some("completed"));
            assert_eq!((*tool_uses, *duration_ms), (Some(1), Some(4145)));
            assert_eq!(model.as_deref(), Some("claude-haiku-4-5-20251001"));
            let summary = summary.as_deref().unwrap();
            assert_eq!(summary.chars().count(), RESULT_TEXT_CHARS);
            assert!(report.starts_with(summary.trim_end_matches('…')));
        }
        // A call the fold never saw start is known by its result's shape.
        let (_, events) =
            TranscriptFold::default().entry(&agent_report("t-unseen", "Done.", "tool_use_result"));
        let wire = serde_json::to_string(&events).unwrap();
        assert!(
            !wire.contains("subagent_tokens") && !wire.contains("agentId:"),
            "{wire}"
        );
        assert!(
            matches!(events.as_slice(), [
                AgentEvent::ToolDone { output: Some(output), .. },
                AgentEvent::ToolResult { data: ToolResultData::Agent { summary: Some(summary), .. }, .. },
            ] if output == "Done." && summary == "Done."),
            "{events:?}"
        );
    }

    #[test]
    fn a_report_loses_its_trailer_and_keeps_its_words() {
        for (whole, clean) in [
            (format!("Beta.\n{TRAILER}"), "Beta."),
            // An unclosed count runs to the end.
            ("Beta. <usage>subagent_tokens: 9".to_string(), "Beta."),
            (TRAILER.to_string(), ""),
            // Only a line that opens with the trailer is one.
            (
                "Look up the agentId: field.".to_string(),
                "Look up the agentId: field.",
            ),
            (
                format!("agentId: is a field.\nBeta.\n{TRAILER}"),
                "agentId: is a field.\nBeta.",
            ),
        ] {
            assert_eq!(clean_agent_report(&whole), clean, "{whole:?}");
        }
    }

    #[test]
    fn a_result_keeps_its_bounds() {
        let hit = |n: usize, url: &str| json!({ "title": format!("Result {n}"), "url": url });
        let mut hits: Vec<Value> = (0..25)
            .map(|n| hit(n, &format!("https://example.com/{n}")))
            .collect();
        hits.insert(0, hit(99, "javascript:alert(1)"));
        hits.insert(1, hit(98, "ftp://example.com/x"));
        hits.insert(2, json!({ "url": "https://example.com/untitled" }));
        hits.insert(
            3,
            hit(97, &format!("https://example.com/{}", "x".repeat(MAX_URL))),
        );
        let search = json!({ "query": "q", "results": [
            "Claude Code's own words first.", { "tool_use_id": "s1", "content": hits }
        ] });
        let Some(ToolResultData::WebSearch { query, results }) = web_search_result(&search) else {
            panic!("a search");
        };
        assert_eq!(query, "q");
        assert_eq!(results.len(), MAX_SEARCH_RESULTS);
        assert_eq!(results[0].title, "Result 0");
        assert!(results
            .iter()
            .all(|hit| hit.url.starts_with("https://example.com/")));
        assert_eq!(
            web_search_result(&json!({ "query": "q", "results": "none" })),
            None
        );
        // A todo list keeps its first hundred, each word clipped, and drops
        // a todo without its words rather than guess at them.
        let todos: Vec<Value> = (0..120)
            .map(|n| {
                json!({ "content": "c".repeat(600), "status": "pending",
                    "activeForm": format!("Doing {n}") })
            })
            .collect();
        let Some(ToolResultData::Todos { todos }) =
            todos_result(&json!({ "oldTodos": [], "newTodos": todos }))
        else {
            panic!("a list");
        };
        assert_eq!(todos.len(), MAX_TODOS);
        assert_eq!(todos[0].content.chars().count(), RESULT_TEXT_CHARS);
        assert!(todos[0].content.ends_with('…'));
        assert_eq!(todos[0].active_form.as_deref(), Some("Doing 0"));
        assert_eq!(
            todos_result(&json!({ "newTodos": [
                { "status": "pending" }, { "content": "x", "status": "done" }
            ] })),
            Some(ToolResultData::Todos {
                todos: vec![TodoEntry {
                    content: "x".into(),
                    status: "done".into(),
                    active_form: None,
                }],
            })
        );
        // A fetch's url is passed on whole or not at all.
        let long = format!("https://example.com/{}", "x".repeat(MAX_URL));
        assert_eq!(web_fetch_result(&json!({ "url": long, "code": 200 })), None);
        assert_eq!(
            tool_result_data("Read", &json!({ "stdout": "a" }), None),
            None
        );
    }

    #[test]
    fn claude_codes_own_refusal_folds_to_tool_denied_live_only() {
        let stream = fold_lines(&load("transcript-denied.stream.json")).events;
        let at = stream
            .iter()
            .position(|event| matches!(event, AgentEvent::ToolDenied { .. }))
            .expect("a denial");
        assert!(
            matches!(&stream[at], AgentEvent::ToolDenied { tool_id, tool_name, message }
                if tool_id == "toolu_000000000000000000009401" && tool_name == "Bash"
                    && message.starts_with("This Bash command contains multiple operations")),
            "{stream:?}"
        );
        assert!(
            matches!(&stream[at + 1], AgentEvent::ToolDone { tool_id, is_error: true, .. }
                if tool_id == "toolu_000000000000000000009401"),
            "its error result follows: {stream:?}"
        );
        assert!(
            of_kind("transcript-denied.session.json", "ToolDenied").is_empty(),
            "the session file never says it"
        );
        // With no words of its own it still says so; naming no call, it
        // lands nowhere.
        assert_eq!(
            one(
                json!({ "type": "system", "subtype": "permission_denied", "tool_name": "Write",
                "tool_use_id": "t9" })
            ),
            [AgentEvent::ToolDenied {
                tool_id: "t9".into(),
                tool_name: "Write".into(),
                message: DENIED.into(),
            }]
        );
        let (class, events) = TranscriptFold::default().entry(
            &json!({ "type": "system", "subtype": "permission_denied", "tool_name": "Write" }),
        );
        assert_eq!(class, LineClass::Translated);
        assert!(events.is_empty());
    }

    #[test]
    fn prompts_and_turn_ends_carry_their_anchors_and_lines_their_times() {
        let session = fold_lines(&load("transcript-two-turns.session.json")).events;
        let prompts: Vec<Option<&str>> = session
            .iter()
            .filter_map(|event| match event {
                AgentEvent::UserPrompt { uuid, .. } => Some(uuid.as_deref()),
                _ => None,
            })
            .collect();
        assert_eq!(
            prompts,
            [
                Some("00000000-0000-4000-8000-000000000001"),
                Some("00000000-0000-4000-8000-000000000020")
            ]
        );
        let anchors = |events: &[AgentEvent]| -> Vec<Option<String>> {
            events
                .iter()
                .filter_map(|event| match event {
                    AgentEvent::TurnEnded { last_uuid, .. } => Some(last_uuid.clone()),
                    _ => None,
                })
                .collect()
        };
        assert_eq!(
            anchors(&session),
            [
                Some("00000000-0000-4000-8000-000000000015".to_string()),
                Some("00000000-0000-4000-8000-000000000022".to_string())
            ]
        );
        // The stream ends each turn at the same anchor, its lines at the
        // same times.
        let turn = fold_lines(&load("transcript-two-turns.turn1.stream.json")).events;
        assert_eq!(anchors(&turn), [anchors(&session)[0].clone()]);
        let times: Vec<(String, Option<&str>)> = turn
            .iter()
            .filter_map(|event| match event {
                AgentEvent::Text { at, .. }
                | AgentEvent::ToolStart { at, .. }
                | AgentEvent::ToolDone { at, .. } => Some((kind_of(event), at.as_deref())),
                _ => None,
            })
            .collect();
        let at = |kind: &str, second: u32| {
            (
                kind.to_string(),
                Some(format!("2026-07-28T12:00:{second:02}.000Z")),
            )
        };
        assert_eq!(
            times
                .into_iter()
                .map(|(kind, at)| (kind, at.map(str::to_string)))
                .collect::<Vec<_>>(),
            [
                at("Text", 5),
                at("ToolStart", 6),
                at("ToolStart", 7),
                at("ToolDone", 8),
                at("ToolDone", 9),
                at("Text", 10)
            ]
        );
        // A time that is not RFC 3339 is left out, and a placeholder no
        // model wrote is never the anchor.
        let folded = fold_lines(&[
            prompt("hi", "u0"),
            json!({ "type": "assistant", "uuid": "a1", "timestamp": "yesterday", "message": {
                "id": "m1", "model": "haiku", "stop_reason": "end_turn",
                "content": [{ "type": "text", "text": "Hi." }] } }),
            assistant(
                "00000000-0000-4000-8000-000000000009",
                "a2",
                SYNTHETIC_MODEL,
                json!("stop_sequence"),
                json!([{ "type": "text", "text": "No response requested." }]),
            ),
        ]);
        assert!(
            matches!(folded.events.as_slice(), [
                AgentEvent::UserPrompt { uuid: Some(prompt), .. },
                AgentEvent::ModelChanged { .. },
                AgentEvent::Text { at: None, .. },
                AgentEvent::TurnEnded { last_uuid: Some(anchor), .. },
            ] if prompt == "u0" && anchor == "a1"),
            "{:?}",
            folded.events
        );
    }

    /// A background task's continuation in one process, as 2.1.250 sent it
    /// (measured): the turn's answer, then a second init, the continuation's
    /// answer, and a result whose origin names the task's notification. The
    /// probe saw the first result arrive after the continuation's lines;
    /// `early` puts it before them, as the SDK's documents describe.
    fn continued(early: bool) -> Vec<Value> {
        let init =
            json!({ "type": "system", "subtype": "init", "session_id": "s-1", "model": "haiku" });
        let mut lines = vec![
            init.clone(),
            assistant(
                "m1",
                "a1",
                "haiku",
                Value::Null,
                json!([{ "type": "tool_use", "id": "t1", "name": "Agent", "input": {
                "description": "Read a.md", "subagent_type": "reader", "prompt": "Read a.md." } }]),
            ),
            json!({ "type": "user", "uuid": "r1", "message": { "content": [
                { "type": "tool_result", "tool_use_id": "t1", "content": "Async agent launched successfully." }
            ] } }),
            assistant(
                "m2",
                "a2",
                "haiku",
                json!("end_turn"),
                json!([{ "type": "text", "text": "Waiting for the reader." }]),
            ),
        ];
        let first = json!({ "type": "result", "subtype": "success", "is_error": false,
            "result": "Waiting for the reader.", "stop_reason": "end_turn", "session_id": "s-1" });
        let continuation = [
            json!({ "type": "system", "subtype": "background_tasks_changed", "tasks": [],
                "session_id": "s-1" }),
            init,
            assistant(
                "m3",
                "a3",
                "haiku",
                json!("end_turn"),
                json!([{ "type": "text", "text": "Alpha." }]),
            ),
        ];
        if early {
            lines.push(first);
            lines.extend(continuation);
        } else {
            lines.extend(continuation);
            lines.push(first);
        }
        lines.push(
            json!({ "type": "result", "subtype": "success", "is_error": false,
            "result": "Alpha.", "stop_reason": "end_turn", "session_id": "s-1",
            "origin": { "kind": "task-notification" } }),
        );
        lines
    }

    #[test]
    fn a_continuation_ends_the_turn_again_at_its_own_anchor() {
        for early in [true, false] {
            let mut lines = vec![prompt("Have the reader read a.md.", "p1")];
            lines.extend(continued(early));
            let folded = fold_lines(&lines);
            assert!(
                folded.classes.unclassified.is_empty(),
                "{:?}",
                folded.classes
            );
            let count = |kind: &str| {
                folded
                    .events
                    .iter()
                    .filter(|event| kind_of(event) == kind)
                    .count()
            };
            assert_eq!(count("UserPrompt"), 1, "early {early}");
            assert_eq!(count("Result"), 2, "early {early}");
            assert_eq!(count("TurnEnded"), 2, "early {early}: {:?}", folded.events);
            assert_eq!(count("TurnInterrupted"), 0, "early {early}");
            assert_eq!(
                folded.events.last(),
                Some(&AgentEvent::TurnEnded {
                    stop_reason: Some("end_turn".into()),
                    last_uuid: Some("a3".into()),
                }),
                "early {early}: the continuation's anchor"
            );
        }
        // A session file's notification line opens no turn: the
        // continuation's lines go on in the person's.
        let notified = json!({ "type": "user", "uuid": "n1", "origin": { "kind": "task-notification" },
            "message": { "role": "user", "content": "<task-notification>done</task-notification>" } });
        let (class, events) = TranscriptFold::default().entry(&notified);
        assert_eq!(class, LineClass::Ignored(NOTIFICATION));
        assert!(events.is_empty());
        let folded = fold_lines(&[
            prompt("Have the reader read a.md.", "p1"),
            assistant(
                "m2",
                "a2",
                "haiku",
                Value::Null,
                json!([{ "type": "text", "text": "Waiting for the reader." }]),
            ),
            notified,
            assistant(
                "m3",
                "a3",
                "haiku",
                Value::Null,
                json!([{ "type": "text", "text": "Alpha." }]),
            ),
        ]);
        assert_eq!(
            kinds(&folded.events),
            ["UserPrompt", "ModelChanged", "Text", "Text", "TurnEnded"]
        );
        assert_eq!(
            folded.events.last(),
            Some(&AgentEvent::TurnEnded {
                stop_reason: None,
                last_uuid: Some("a3".into()),
            })
        );
    }

    #[test]
    fn a_resumed_fold_reads_the_held_calls_result_by_its_tool() {
        let held = super::super::cli_writes::HeldCall {
            tool_id: "t-held".into(),
            tool_name: "Bash".into(),
            input: r#"{"command":"ls"}"#.into(),
        };
        let result = answered_with("t-held", json!({ "stdout": "a.md", "stderr": "" }));
        let (_, events) = TranscriptFold::default()
            .holding(Some(&held))
            .entry(&result);
        assert!(
            matches!(
                events.as_slice(),
                [
                    AgentEvent::ToolDone { .. },
                    AgentEvent::ToolResult {
                        data: ToolResultData::Shell { .. },
                        ..
                    }
                ]
            ),
            "{events:?}"
        );
        // Without it, the call's tool is unknown, and so is how to read it.
        let (_, events) = TranscriptFold::default().holding(None).entry(&result);
        assert_eq!(kinds(&events), ["ToolDone"]);
    }

    // M92.0: live on 2.1.250 an answer-resume streams the CLI's bookkeeping
    // around the call it resumes, started and completed (measured). Each line
    // is ignored for the table's reason, never unclassified, so the meter
    // writes no drift row for it, and the held call's result still folds
    // between them.
    #[test]
    fn the_command_lifecycle_around_a_resumed_call_is_ignored() {
        const KIND: &str = "command_lifecycle";
        assert!(matches!(
            kinds::handling(KIND),
            Some(kinds::Handling::Ignored(_))
        ));
        let lifecycle = |state: &str, uuid: &str| {
            json!({ "type": KIND, "command_uuid": "c-1", "state": state,
                "uuid": uuid, "session_id": "s-1" })
        };
        let (started, completed) = (lifecycle("started", "u-1"), lifecycle("completed", "u-2"));
        for line in [&started, &completed] {
            assert_eq!(kinds::kinds_of(line), [KIND]);
            assert!(kinds::unclassified(line).is_empty(), "{line}");
        }
        let held = super::super::cli_writes::HeldCall {
            tool_id: "t-held".into(),
            tool_name: "Bash".into(),
            input: r#"{"command":"ls"}"#.into(),
        };
        let mut fold = TranscriptFold::default().holding(Some(&held));
        let ignored = LineClass::Ignored(kinds::ignored_reason(KIND));
        assert_eq!(fold.entry(&started), (ignored.clone(), vec![]));
        let result = answered_with("t-held", json!({ "stdout": "a.md", "stderr": "" }));
        let (class, events) = fold.entry(&result);
        assert_eq!(class, LineClass::Translated);
        assert_eq!(kinds(&events), ["ToolDone", "ToolResult"]);
        assert_eq!(fold.entry(&completed), (ignored, vec![]));
    }

    #[test]
    fn a_tool_summary_and_the_background_task_list_are_ignored() {
        for (line, kind) in [
            (
                json!({ "type": "tool_use_summary", "summary": "Read two notes",
                    "preceding_tool_use_ids": ["t1"] }),
                "tool_use_summary",
            ),
            (
                json!({ "type": "system", "subtype": "background_tasks_changed", "tasks": [] }),
                "system/background_tasks_changed",
            ),
        ] {
            assert!(matches!(
                kinds::handling(kind),
                Some(kinds::Handling::Ignored(_))
            ));
            let (class, events) = TranscriptFold::default().entry(&line);
            assert_eq!(
                class,
                LineClass::Ignored(kinds::ignored_reason(kind)),
                "{line}"
            );
            assert!(events.is_empty(), "{line}");
        }
    }

    // --- Subagents (M91.3b) -------------------------------------------------

    /// The fixture's Agent call, the subagent's own call, and the agent id
    /// Claude Code gave it.
    const AGENT_CALL: &str = "toolu_000000000000000000009501";
    const SUB_CALL: &str = "toolu_000000000000000000009511";
    const AGENT_ID: &str = "a0000000000000001";

    /// Each subagent's events, by the Agent call they name, as live and
    /// replay must agree on them: the kinds only the stream sends carry no
    /// `parent`, and when each line was written is left out.
    fn by_parent(events: &[AgentEvent]) -> BTreeMap<String, Vec<Value>> {
        let mut parents: BTreeMap<String, Vec<Value>> = BTreeMap::new();
        for event in events {
            let Some(parent) = event.parent() else {
                continue;
            };
            let mut value = serde_json::to_value(event).unwrap();
            value.as_object_mut().unwrap().remove("at");
            parents.entry(parent.to_string()).or_default().push(value);
        }
        parents
    }

    /// A line of a subagent's thread, as the stream forwards it.
    fn forwarded(mut line: Value, parent: &str) -> Value {
        line["parent_tool_use_id"] = json!(parent);
        line
    }

    fn agent_call(id: &str, uuid: &str) -> Value {
        assistant(
            &format!("m-{uuid}"),
            uuid,
            "haiku",
            json!("tool_use"),
            json!([{ "type": "tool_use", "id": id, "name": "Agent", "input": {
                "description": "Read the launch note", "subagent_type": "cerebro-researcher",
                "prompt": "Read projects/launch.md." } }]),
        )
    }

    #[test]
    fn a_subagent_streams_into_its_calls_sub_fold() {
        let folded = fold_lines(&load("transcript-subagent.stream.json"));
        assert!(
            folded.classes.unclassified.is_empty(),
            "{:?}",
            folded.classes
        );
        let events = &folded.events;
        // Its life, live, by the call it answers, and never its tokens.
        let life: Vec<&AgentEvent> = events
            .iter()
            .filter(|event| kind_of(event).starts_with("Subagent"))
            .collect();
        assert_eq!(
            life,
            [
                &AgentEvent::SubagentStarted {
                    tool_id: AGENT_CALL.into(),
                    agent_id: AGENT_ID.into(),
                    subagent_type: "cerebro-researcher".into(),
                    description: "Read the launch note".into(),
                    background: false,
                    depth: Some(1),
                },
                &AgentEvent::SubagentProgress {
                    tool_id: AGENT_CALL.into(),
                    description: "Reading projects/launch.md".into(),
                    last_tool: Some("mcp__cerebro__get_note".into()),
                    tool_uses: Some(1),
                    duration_ms: Some(1600),
                },
                &AgentEvent::SubagentDone {
                    tool_id: AGENT_CALL.into(),
                    status: "completed".into(),
                    tool_uses: Some(1),
                    duration_ms: Some(3800),
                },
            ]
        );
        let wire = serde_json::to_string(events).unwrap();
        for leak in [
            "total_tokens",
            "subagent_tokens",
            "totalTokens",
            "output_file",
        ] {
            assert!(!wire.contains(leak), "{leak} crossed");
        }
        // Its steps, each naming the call; its prompt is the call's input.
        let steps = by_parent(events);
        assert_eq!(steps.keys().collect::<Vec<_>>(), [AGENT_CALL]);
        let shown: Vec<(String, Option<&str>)> = steps[AGENT_CALL]
            .iter()
            .map(|step| {
                (
                    step["kind"].as_str().unwrap().to_string(),
                    step["text"].as_str(),
                )
            })
            .collect();
        assert_eq!(
            shown,
            [
                (
                    "Thinking".to_string(),
                    Some("I need to read projects/launch.md before I can report its status.")
                ),
                ("ToolStart".to_string(), None),
                ("ToolDone".to_string(), None),
                (
                    "Thinking".to_string(),
                    Some("It says ready for review, with the press list still open.")
                ),
                (
                    "Text".to_string(),
                    Some("The launch note is ready for review, but its press list is still open.")
                ),
            ]
        );
        // The note it read was cut to its preview, and never followed whole.
        assert!(
            events.iter().any(|event| matches!(event,
                AgentEvent::ToolDone { tool_id, output: Some(output), parent: Some(_), at: Some(_), .. }
                    if tool_id == SUB_CALL && output.ends_with('…'))),
            "{events:?}"
        );
        assert!(!events.iter().any(
            |event| matches!(event, AgentEvent::ToolPayload { tool_id, .. } if tool_id == SUB_CALL)
        ));
        // The turn is the main thread's: one model, one answer, one end, at
        // the main thread's last line.
        let count = |kind: &str| events.iter().filter(|event| kind_of(event) == kind).count();
        assert_eq!(
            (
                count("ModelChanged"),
                count("Result"),
                count("TurnEnded"),
                count("TurnInterrupted")
            ),
            (1, 1, 1, 0)
        );
        assert_eq!(
            events.last(),
            Some(&AgentEvent::TurnEnded {
                stop_reason: Some("end_turn".into()),
                last_uuid: Some("00000000-0000-4000-8000-000009500111".into()),
            })
        );
        assert!(
            matches!(events.iter().rev().find(|e| kind_of(e) == "Text"),
                Some(AgentEvent::Text { parent: None, text, .. })
                    if text.starts_with("Almost: the launch note")),
            "the reply is the main thread's"
        );
        // Claude Code's own record of the task changing says nothing new.
        assert_eq!(
            folded
                .classes
                .ignored
                .get(kinds::ignored_reason("system/task_updated")),
            Some(&1)
        );
        assert_eq!(folded.classes.ignored.get(SUBAGENT_WORDS), Some(&1));
    }

    #[test]
    fn a_subagent_replays_from_its_own_transcript_as_it_streamed() {
        let stream = fold_lines(&load("transcript-subagent.stream.json"));
        let replayed = fold_session(
            &load("transcript-subagent.session.json"),
            subagents_of("transcript-subagent.agents"),
        );
        assert!(
            replayed.classes.unclassified.is_empty(),
            "{:?}",
            replayed.classes
        );
        let live = by_parent(&stream.events);
        assert!(!live.is_empty());
        assert_eq!(by_parent(&replayed.events), live);
        // Its steps keep their times, which are the stream's.
        let times = |events: &[AgentEvent]| -> Vec<Option<String>> {
            events
                .iter()
                .filter(|event| event.parent().is_some())
                .map(|event| {
                    serde_json::to_value(event).unwrap()["at"]
                        .as_str()
                        .map(str::to_string)
                })
                .collect()
        };
        assert!(times(&replayed.events).iter().all(Option::is_some));
        assert_eq!(times(&replayed.events), times(&stream.events));
        // Its life is the stream's alone, and so is the denial kind.
        assert!(!replayed
            .events
            .iter()
            .any(|event| kind_of(event).starts_with("Subagent")));
        // Without its transcript the session still folds whole, its
        // subagent's steps not there.
        let alone = fold_lines(&load("transcript-subagent.session.json"));
        assert!(by_parent(&alone.events).is_empty());
        let main = |events: &[AgentEvent]| -> Vec<AgentEvent> {
            events
                .iter()
                .filter(|event| event.parent().is_none())
                .cloned()
                .collect()
        };
        assert_eq!(main(&alone.events), main(&replayed.events));
    }

    #[test]
    fn a_session_merges_its_subagents_lines_by_time() {
        let at = |second: u32| format!("2026-10-22T12:00:{second:02}.000Z");
        let said = |id: &str, text: &str, time: Option<String>, sidechain: bool| {
            let mut line = json!({ "type": "assistant", "uuid": format!("u-{text}"),
                "message": { "id": id, "model": "haiku", "stop_reason": null,
                    "content": [{ "type": "text", "text": text }] } });
            if let Some(time) = time {
                line["timestamp"] = json!(time);
            }
            if sidechain {
                line["isSidechain"] = json!(true);
            }
            line
        };
        let main = [
            said("m1", "m1", Some(at(1)), false),
            said("m3", "m3", Some(at(3)), false),
            // A line with no time of its own sits where its file put it.
            said("m3b", "m3b", None, false),
            said("m5", "m5", Some(at(5)), false),
        ];
        let first = SubagentTranscript {
            meta: Some(json!({ "agentType": "cerebro-researcher", "toolUseId": "t-a" })),
            lines: Box::new(
                vec![
                    said("s2", "s2", Some(at(2)), true),
                    // A tie goes to the session file, then the earlier
                    // transcript.
                    said("s3", "s3", Some(at(3)), true),
                    said("s4", "s4", Some(at(4)), true),
                    said("s4b", "s4b", None, true),
                    json!({ "type": "attachment", "isSidechain": true, "timestamp": at(4),
                        "attachment": { "type": "skill_listing" } }),
                    // What it wrote after the session file's last line folds
                    // at the end.
                    said("s6", "s6", Some(at(6)), true),
                ]
                .into_iter(),
            ),
        };
        let second = SubagentTranscript {
            meta: Some(json!({ "toolUseId": "t-b" })),
            lines: Box::new(vec![said("b2", "b2", Some(at(2)), true)].into_iter()),
        };
        // A transcript whose meta names no call has no thread to fold into.
        let unanchored = SubagentTranscript {
            meta: Some(json!({ "agentType": "cerebro-researcher" })),
            lines: Box::new(vec![said("x1", "x1", Some(at(1)), true)].into_iter()),
        };
        let folded = fold_session(&main, vec![first, second, unanchored]);
        let texts: Vec<(&str, Option<&str>)> = folded
            .events
            .iter()
            .filter_map(|event| match event {
                AgentEvent::Text { text, parent, .. } => Some((text.as_str(), parent.as_deref())),
                _ => None,
            })
            .collect();
        assert_eq!(
            texts,
            [
                ("m1", None),
                ("s2", Some("t-a")),
                ("b2", Some("t-b")),
                ("m3", None),
                ("m3b", None),
                ("s3", Some("t-a")),
                ("s4", Some("t-a")),
                ("s4b", Some("t-a")),
                ("m5", None),
                ("s6", Some("t-a")),
            ]
        );
        assert_eq!(folded.classes.ignored.get(SUBAGENT), Some(&1));
        assert_eq!(folded.classes.ignored.get(SUBAGENT_RECORD), Some(&1));
        // The fold's own end comes after every line.
        assert!(matches!(
            folded.events.last(),
            Some(AgentEvent::TurnEnded { last_uuid: Some(anchor), .. }) if anchor == "u-m5"
        ));
    }

    #[test]
    fn a_subagents_call_sends_its_cut_input_whole_and_never_its_output() {
        let body = "Monthly churn is the share of paying accounts that cancel. ".repeat(8);
        let mut fold = TranscriptFold::default();
        let call = forwarded(
            json!({ "type": "assistant", "uuid": "s1", "message": { "id": "m-sub", "content": [
                { "type": "tool_use", "id": "s-write", "name": "Write",
                  "input": { "file_path": "notes/churn.md", "content": body } },
                { "type": "tool_use", "id": "s-bash", "name": "Bash",
                  "input": { "command": "cargo test" } }
            ] } }),
            "t-agent",
        );
        let (class, events) = fold.entry(&call);
        assert_eq!(class, LineClass::Translated);
        assert_eq!(kinds(&events), ["ToolStart", "ToolPayload", "ToolStart"]);
        assert!(events.iter().all(|event| event.parent() == Some("t-agent")));
        assert!(
            matches!(&events[1], AgentEvent::ToolPayload { part: PayloadPart::Input, text, .. }
            if serde_json::from_str::<Value>(text).unwrap()["content"] == json!(body))
        );
        let long = "Churn rose in March. ".repeat(150);
        let (_, events) = fold.entry(&forwarded(
            json!({ "type": "user", "uuid": "s2", "message": { "content": [
                { "type": "tool_result", "tool_use_id": "s-write", "content": long }
            ] } }),
            "t-agent",
        ));
        assert!(
            matches!(events.as_slice(), [AgentEvent::ToolDone { output: Some(output), parent: Some(parent), .. }]
                if output.ends_with('…') && parent == "t-agent"),
            "{events:?}"
        );
        // A structured result is read wherever the line carries one.
        let (_, events) = fold.entry(&forwarded(
            json!({ "type": "user", "uuid": "s3", "message": { "content": [
                { "type": "tool_result", "tool_use_id": "s-bash", "content": "ok" }
            ] }, "toolUseResult": { "stdout": "ok", "stderr": "", "interrupted": false } }),
            "t-agent",
        ));
        assert!(
            matches!(events.as_slice(), [
                AgentEvent::ToolDone { parent: Some(_), .. },
                AgentEvent::ToolResult { parent: Some(parent), data: ToolResultData::Shell { .. }, .. },
            ] if parent == "t-agent"),
            "{events:?}"
        );
        // None of it opened a turn.
        assert!(fold.finish().is_empty());
    }

    #[test]
    fn a_subagents_lines_never_open_end_or_answer_the_turn() {
        // The subagent says its last word while the turn waits on its call:
        // the turn is still cut off where it waits, and still the model the
        // main thread named.
        let said = forwarded(
            json!({ "type": "assistant", "uuid": "s1", "message": { "id": "m-sub",
                "model": "claude-sonnet-5", "stop_reason": "end_turn",
                "content": [{ "type": "text", "text": "Done." }] } }),
            "t-agent",
        );
        let folded = fold_lines(&[
            prompt("Have a researcher read it.", "p1"),
            agent_call("t-agent", "a1"),
            said,
        ]);
        assert_eq!(
            kinds(&folded.events),
            [
                "UserPrompt",
                "ModelChanged",
                "ToolStart",
                "Text",
                "TurnInterrupted"
            ]
        );
        // A subagent's lines after the turn ended (one in the background, as
        // Claude Code can still run one) open nothing, and the
        // continuation's answer follows the turn's first.
        let mut lines = vec![prompt("Have the reader read a.md.", "p1")];
        let mut continued = continued(true);
        let after_the_first_result = 5;
        continued.splice(
            after_the_first_result..after_the_first_result,
            [
                forwarded(
                    json!({ "type": "assistant", "uuid": "s2", "message": { "id": "m-sub2",
                        "model": "haiku", "content": [{ "type": "thinking", "thinking": "Reading.",
                        "signature": "sig-s2" }] } }),
                    "t1",
                ),
                forwarded(
                    json!({ "type": "assistant", "uuid": "s3", "message": { "id": "m-sub2",
                        "model": "haiku", "stop_reason": "end_turn",
                        "content": [{ "type": "text", "text": "Alpha, from the reader." }] } }),
                    "t1",
                ),
            ],
        );
        lines.extend(continued);
        let folded = fold_lines(&lines);
        let shown: Vec<String> = folded
            .events
            .iter()
            .filter_map(|event| match event {
                AgentEvent::Text { text, parent, .. } => Some(format!(
                    "{}{text}",
                    if parent.is_some() { "sub: " } else { "" }
                )),
                AgentEvent::Thinking {
                    parent: Some(_), ..
                } => Some("sub: thinking".into()),
                AgentEvent::TurnEnded { last_uuid, .. } => {
                    Some(format!("ended at {}", last_uuid.as_deref().unwrap_or("-")))
                }
                AgentEvent::TurnInterrupted { .. } => Some("interrupted".into()),
                _ => None,
            })
            .collect();
        assert_eq!(
            shown,
            [
                "Waiting for the reader.",
                "ended at a2",
                "sub: thinking",
                "sub: Alpha, from the reader.",
                "Alpha.",
                "ended at a3",
            ]
        );
    }

    #[test]
    fn a_subagents_api_error_is_its_own_and_never_fails_the_turn() {
        let error = |uuid: &str| {
            forwarded(
                json!({ "type": "assistant", "uuid": uuid, "error": "rate_limit",
                    "is_api_error_message": true, "message": { "id": uuid, "model": "<synthetic>",
                    "content": [{ "type": "text", "text": "API Error: Request rejected (429)" }] } }),
                "t-agent",
            )
        };
        let mut fold = TranscriptFold::default();
        let lines = [
            json!({ "type": "system", "subtype": "init", "session_id": "s-1", "model": "haiku",
                "claude_code_version": "2.1.250" }),
            agent_call("t-agent", "a1"),
            error("e1"),
            error("e2"),
            json!({ "type": "user", "uuid": "r1", "message": { "content": [
                { "type": "tool_result", "tool_use_id": "t-agent", "is_error": true,
                  "content": "The researcher stopped." }
            ] } }),
            assistant(
                "m2",
                "a2",
                "haiku",
                json!("end_turn"),
                json!([{ "type": "text", "text": "The researcher could not finish." }]),
            ),
            json!({ "type": "result", "subtype": "success", "is_error": false,
                "result": "The researcher could not finish.", "stop_reason": "end_turn",
                "session_id": "s-1" }),
        ];
        let events: Vec<AgentEvent> = lines.iter().flat_map(|line| fold.entry(line).1).collect();
        let errors: Vec<&AgentEvent> = events
            .iter()
            .filter(|event| kind_of(event) == "Error")
            .collect();
        assert!(
            matches!(errors.as_slice(), [AgentEvent::Error { parent: Some(parent), code: Some(code), notice: Some(notice), message }]
                if parent == "t-agent" && code == "rate_limit" && message.starts_with("API Error")
                    && notice.kind == failure::FailureKind::RateLimited),
            "one Error, the subagent's: {errors:?}"
        );
        assert_eq!(fold.notice(), None, "the turn did not fail");
        assert!(!fold.is_quota());
        assert_eq!(
            events.last(),
            Some(&AgentEvent::TurnEnded {
                stop_reason: Some("end_turn".into()),
                last_uuid: Some("a2".into()),
            })
        );
        assert!(events
            .iter()
            .any(|event| matches!(event, AgentEvent::Result { text, .. } if text.starts_with("The researcher"))));
    }

    #[test]
    fn a_task_that_is_not_a_subagent_is_not_drawn() {
        let mut fold = TranscriptFold::default();
        let task = |subtype: &str, fields: Value| {
            let mut line = json!({ "type": "system", "subtype": subtype, "session_id": "s-1" });
            for (key, value) in fields.as_object().unwrap() {
                line[key] = value.clone();
            }
            line
        };
        let mut check = |line: Value, class: LineClass, shown: &[&str]| {
            let (got, events) = fold.entry(&line);
            assert_eq!(got, class, "{line}");
            assert_eq!(kinds(&events), shown, "{line}");
        };
        // A background shell is a task, and no subagent.
        check(
            task(
                "task_started",
                json!({ "task_id": "b1", "tool_use_id": "t-bash", "task_type": "local_bash",
                "description": "cargo test" }),
            ),
            LineClass::Ignored(OTHER_TASK),
            &[],
        );
        check(
            task(
                "task_progress",
                json!({ "task_id": "b1", "tool_use_id": "t-bash", "description": "Running" }),
            ),
            LineClass::Ignored(OTHER_TASK),
            &[],
        );
        check(
            task(
                "task_notification",
                json!({ "task_id": "b1", "tool_use_id": "t-bash", "status": "completed" }),
            ),
            LineClass::Ignored(OTHER_TASK),
            &[],
        );
        check(
            task(
                "task_updated",
                json!({ "task_id": "b1", "patch": { "status": "completed" } }),
            ),
            LineClass::Ignored(kinds::ignored_reason("system/task_updated")),
            &[],
        );
        // A subagent's that names no call has nothing to land on.
        check(
            task(
                "task_started",
                json!({ "task_id": "a1", "task_type": "local_agent" }),
            ),
            LineClass::Translated,
            &[],
        );
        // One this fold never saw start is known by its Agent call.
        check(
            agent_call("t-agent", "a1"),
            LineClass::Translated,
            &["ModelChanged", "ToolStart"],
        );
        check(
            task(
                "task_progress",
                json!({ "task_id": "a9", "tool_use_id": "t-agent", "description": "Reading",
                "usage": { "total_tokens": 9, "tool_uses": 2 } }),
            ),
            LineClass::Translated,
            &["SubagentProgress"],
        );
        // A subagent's life opens no turn: only the call above did.
        let mut fold = TranscriptFold::default();
        fold.entry(&task(
            "task_started",
            json!({ "task_id": "a1", "tool_use_id": "t-agent", "task_type": "local_agent",
            "description": "Read", "subagent_type": "cerebro-researcher" }),
        ));
        fold.entry(&task(
            "task_notification",
            json!({ "task_id": "a1", "status": "failed" }),
        ));
        assert!(fold.finish().is_empty());
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
        // M91.3b: and every subagent transcript beside a session file.
        let mut folders: Vec<String> = std::fs::read_dir(fixtures())
            .unwrap()
            .filter_map(Result::ok)
            .filter_map(|entry| entry.file_name().into_string().ok())
            .filter(|name| name.ends_with(".agents"))
            .collect();
        folders.sort();
        assert!(!folders.is_empty());
        for folder in folders {
            let folded = fold_session(&[], subagents_of(&folder));
            assert!(folded.classes.translated > 0, "{folder}");
            for (kind, count) in folded.classes.unclassified {
                unclassified.push(format!("{folder}: {kind} x{count}"));
            }
        }
        assert!(
            unclassified.is_empty(),
            "give each kind an arm in the fold and a row in kinds::STREAM_KINDS: {unclassified:#?}"
        );
    }

    /// One golden case: its streams, one per turn, its session file, and
    /// the folder of subagent transcripts beside it (M91.3b).
    struct Case {
        name: &'static str,
        streams: &'static [&'static str],
        session: Option<&'static str>,
        agents: Option<&'static str>,
    }

    const CASES: &[Case] = &[
        Case {
            name: "two-turns",
            streams: &[
                "transcript-two-turns.turn1.stream.json",
                "transcript-two-turns.turn2.stream.json",
            ],
            session: Some("transcript-two-turns.session.json"),
            agents: None,
        },
        Case {
            name: "interrupted",
            streams: &["real/spike-killed-mid-tool.stream.jsonl"],
            session: Some("real/spike-killed-mid-tool.session.jsonl"),
            agents: None,
        },
        Case {
            name: "api-error",
            streams: &["transcript-api-error.stream.json"],
            session: Some("transcript-api-error.session.json"),
            agents: None,
        },
        Case {
            name: "session-records",
            streams: &[],
            session: Some("transcript-session-records.session.json"),
            agents: None,
        },
        Case {
            name: "long-payload",
            streams: &["transcript-long-payload.stream.json"],
            session: Some("transcript-long-payload.session.json"),
            agents: None,
        },
        // M57.1: a turn a PreToolUse hook deferred. SYNTHETIC: hand-shaped
        // from 2.1.250's result, attachment and session-file shapes (each
        // file's first line says so), until the defer-gate record commit
        // swaps in a recorded pair.
        Case {
            name: "deferred",
            streams: &["transcript-deferred.stream.json"],
            session: Some("transcript-deferred.session.json"),
            agents: None,
        },
        // M91.3a: reasoning shown, a todo list, a web search and fetch, and a
        // call Claude Code refused. SYNTHETIC: hand-shaped from 2.1.250's
        // measured shapes (each file's first line says so), until M91.R's
        // live recordings replace them.
        Case {
            name: "thinking-summarized",
            streams: &["transcript-thinking-summarized.stream.json"],
            session: Some("transcript-thinking-summarized.session.json"),
            agents: None,
        },
        Case {
            name: "todos",
            streams: &["transcript-todos.stream.json"],
            session: Some("transcript-todos.session.json"),
            agents: None,
        },
        Case {
            name: "web",
            streams: &["transcript-web.stream.json"],
            session: Some("transcript-web.session.json"),
            agents: None,
        },
        Case {
            name: "denied",
            streams: &["transcript-denied.stream.json"],
            session: Some("transcript-denied.session.json"),
            agents: None,
        },
        // M91.3b: a foreground subagent, streamed with its text forwarded and
        // replayed from its own transcript. SYNTHETIC: hand-shaped from
        // 2.1.250's measured shapes (each file's first line says so), until
        // M91.R's live recording replaces it.
        Case {
            name: "subagent",
            streams: &["transcript-subagent.stream.json"],
            session: Some("transcript-subagent.session.json"),
            agents: Some("transcript-subagent.agents"),
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

    /// The subagent transcripts in `folder` (M91.3b), as `transcript.rs`
    /// hands them over: each `agent-*.jsonl` by name, with its meta.
    fn subagents_of(folder: &str) -> Vec<SubagentTranscript> {
        let dir = fixtures().join(folder);
        let mut names: Vec<String> = std::fs::read_dir(&dir)
            .unwrap_or_else(|error| panic!("{}: {error}", dir.display()))
            .filter_map(Result::ok)
            .filter_map(|entry| entry.file_name().into_string().ok())
            .filter(|name| name.starts_with("agent-") && name.ends_with(".jsonl"))
            .collect();
        names.sort();
        names
            .into_iter()
            .map(|name| {
                let meta = dir.join(name.replace(".jsonl", ".meta.json"));
                let lines = jsonl(&dir.join(&name));
                SubagentTranscript {
                    meta: std::fs::read_to_string(meta)
                        .ok()
                        .map(|text| serde_json::from_str(&text).unwrap()),
                    lines: Box::new(lines.into_iter()),
                }
            })
            .collect()
    }

    fn folded_json(name: &str) -> (Folded, Value) {
        let folded = fold_lines(&load(name));
        let value = json!({ "file": name, "events": folded.events, "classes": folded.classes });
        (folded, value)
    }

    /// A case's session file folded, with its subagents' transcripts merged
    /// in when it has a folder of them (M91.3b).
    fn session_json(case: &Case) -> Option<(Folded, Value)> {
        let name = case.session?;
        let Some(agents) = case.agents else {
            return Some(folded_json(name));
        };
        let folded = fold_session(&load(name), subagents_of(agents));
        let mut value = json!({ "file": name, "agents": agents });
        value["events"] = json!(folded.events);
        value["classes"] = json!(folded.classes);
        Some((folded, value))
    }

    fn golden(case: &Case) -> Value {
        let streams: Vec<(Folded, Value)> = case.streams.iter().map(|s| folded_json(s)).collect();
        let session = session_json(case);
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
            let session = turn_content(&session_json(case).unwrap().0.events);
            let streams: Vec<TurnContent> = case
                .streams
                .iter()
                .flat_map(|name| turn_content(&fold_lines(&load(name)).events))
                .collect();
            assert!(session.len() >= streams.len(), "{}", case.name);
            let skip = session.len() - streams.len();
            for (at, stream) in streams.iter().enumerate() {
                let label = format!("{} turn {}", case.name, skip + at + 1);
                let file = &session[skip + at];
                assert_same_turn(&label, stream, file);
                // M91.3a: 2.1.250 writes the same line uuids to both formats,
                // and the hand-built pairs do too, so a turn both ended ends
                // at the same anchor. The derived recordings under real/
                // differ until M91.R records them live.
                if stream.ended() == Some("TurnEnded") && file.ended() == Some("TurnEnded") {
                    assert_eq!(
                        stream.events.last(),
                        file.events.last(),
                        "{label}: an ended turn ends at the same anchor in both"
                    );
                }
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

#[cfg(test)]
mod capture_tests {
    use super::*;
    use crate::import::capture;
    use serde_json::json;
    use std::time::Duration;
    const PAGE: &str = "33333333333333333333333333333333";
    const TOOL: &str = "mcp__notion__notion-fetch";
    fn call() -> Value {
        json!({"type":"assistant","message":{"id":"message","role":"assistant","content":[{"type":"tool_use","id":"fetch-call","name":TOOL,"input":{"id":PAGE}}]}})
    }
    fn answer(text: &str) -> Value {
        json!({"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"fetch-call","content":text}]}})
    }
    #[test]
    fn an_eligible_result_is_kept_whole_while_the_event_is_cut() {
        let lease = capture::arm("fold-capture-whole", vec![TOOL.into()]).unwrap();
        let mut fold = TranscriptFold::with_capture(lease.handle());
        fold.entry(&call());
        let text = "z".repeat(PAYLOAD_LIMIT_BYTES + 4096);
        let (_, events) = fold.entry(&answer(&text));
        let saved = capture::find("fold-capture-whole", PAGE, Duration::ZERO).unwrap();
        assert_eq!(&*saved.text, text);
        assert!(!saved.truncated);
        let done = events
            .iter()
            .find_map(|e| match e {
                AgentEvent::ToolDone { output, .. } => output.as_ref(),
                _ => None,
            })
            .unwrap();
        assert!(done.len() < text.len());
        let encoded = serde_json::to_string(&events).unwrap();
        assert!(!encoded.contains(&text));
        drop(lease);
        assert!(capture::find("fold-capture-whole", PAGE, Duration::ZERO).is_none());
    }
    #[test]
    fn session_files_and_unarmed_folds_never_capture() {
        let _lease = capture::arm("fold-capture-session", vec![TOOL.into()]).unwrap();
        let lines = vec![call(), answer("private")];
        fold_lines(&lines);
        let mut fold = TranscriptFold::default();
        for line in &lines {
            fold.entry(line);
        }
        assert!(capture::find("fold-capture-session", PAGE, Duration::ZERO).is_none());
    }
    #[test]
    fn a_subagents_result_cannot_supply_the_parent_page() {
        let lease = capture::arm("fold-capture-sidechain", vec![TOOL.into()]).unwrap();
        let mut fold = TranscriptFold::with_capture(lease.handle());
        fold.entry(&call());
        let mut result = answer("wrong run");
        result["parent_tool_use_id"] = json!("child");
        let (_, events) = fold.entry(&result);
        // M91.3b: it folds in the subagent's sub-fold, never the run's.
        assert!(
            matches!(events.as_slice(), [AgentEvent::ToolDone { parent: Some(parent), .. }] if parent == "child")
        );
        assert!(capture::find("fold-capture-sidechain", PAGE, Duration::ZERO).is_none());
        // Nor does a subagent's own call of the tool, start or result.
        let mut own = call();
        own["parent_tool_use_id"] = json!("child");
        own["message"]["content"][0]["id"] = json!("sub-fetch");
        fold.entry(&own);
        let mut result = answer("the subagent's fetch");
        result["parent_tool_use_id"] = json!("child");
        result["message"]["content"][0]["tool_use_id"] = json!("sub-fetch");
        fold.entry(&result);
        assert!(capture::find("fold-capture-sidechain", PAGE, Duration::ZERO).is_none());
        // The run's own result, answered last, still supplies it.
        fold.entry(&answer("the page"));
        assert_eq!(
            &*capture::find("fold-capture-sidechain", PAGE, Duration::ZERO)
                .unwrap()
                .text,
            "the page"
        );
        drop(lease);
    }
}
