//! The ask seam (M57.1): a run stops on a call, the person answers in a
//! card, and the run resumes on the same permission host.
//!
//! Claude Code holds the permission host. A run whose argv leaves a tool out
//! of `--allowedTools` and names a PreToolUse hook for it (`hook_settings`)
//! asks that hook before the call runs. The hook is an `mcp_tool` hook: Claude
//! Code calls `ask_gate` on the run's own loopback connection with the call,
//! and `mcp.rs` answers it from this book (`Interactions::gate`). The gate can
//! say three things: no opinion (argv decides), defer (the run ends
//! `tool_deferred`, suspended on the call), or the person's answer, allow or
//! deny. Only a call the run's own stream confirms as deferred becomes a card
//! (`confirm`), and only the answer command (`answer_interaction` in lib.rs,
//! through `PersonAnswer::from_ipc` and `begin_answer`) records an answer.
//! The resume (`-p '' --resume <session>`) re-runs the hook on the same call,
//! which now reads the answer (CLI 2.1.250, derived from its bundle; live run
//! owed: the D4 record's "M57.1: the gate").
//!
//! **A bearer can wait, never answer** (CV-27). Nothing reachable from MCP
//! mints a `PersonAnswer`: the hook and any process holding the run's bearer
//! can register a wait in that run's own conversation and read the person's
//! decision, nothing more. A tool the gate may defer is never pre-approved in
//! argv, so a hook that fails, times out or never runs leaves the call
//! refused.
//!
//! `decide` is the seam's one policy point. Until M57.2 it returns `Argv` in
//! release builds, so no production run asks; debug builds may name
//! cerebro tools to ask for in `CEREBRO_ASK_TOOLS` (`ask_override`), a test
//! seam that can add asks and never allows.
//!
//! The book lives in memory. Quit drops it, and the next send in a thread
//! whose call was still waiting refuses that call as not answered and runs the
//! new message (the settle: `open_seat` with the session file's marker,
//! `super::transcript::pending_deferral`).

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::transcript::PendingDeferral;
use super::AgentRequest;

/// The gate's tool name on cerebro's loopback server. A hook endpoint, never
/// a manifest row: `tools/list` never names it (`shared/policy/README.md`).
pub const GATE_TOOL: &str = "ask_gate";

/// The one refusal code the seam adds (policy.v3, operational transport): a
/// person's late click after its request ended.
pub const NO_LONGER_WAITING: &str = "no_longer_waiting";

/// Every refusal code this module can hand the webview.
pub const REFUSAL_CODES: &[&str] = &[NO_LONGER_WAITING];

/// The oldest Claude Code the gate is built against (M54's pin): below it,
/// or when the version is unknown, a run asks nothing.
pub const MIN_CLI_VERSION: (u64, u64, u64) = (2, 1, 250);

/// How long Claude Code waits on the hook, in seconds: a book lookup, so a
/// slow answer is a fault, and the call is then refused by argv.
pub const HOOK_TIMEOUT_SECS: u64 = 10;

/// Cancelled calls a session keeps until a resume reads them.
const CANCELLED_PER_SESSION: usize = 64;

/// The most of a person's deny message the model is told.
const MESSAGE_CHARS: usize = 2000;

/// The most of a call's input a card carries, cut on a character boundary.
const CARD_INPUT_BYTES: usize = 256 * 1024;

// What the model reads (Appendix C, M57.1).
const DEFER_REASON: &str = "Waiting for the person to answer in Cerebro.";
const ALLOW_REASON: &str = "The person allowed this call in Cerebro.";
const DECLINED: &str = "The person declined this call, so it did not run.";
const STOPPED: &str = "The person stopped the turn before answering, so this call did not run.";
const NEVER_ANSWERED: &str = "This call waited for an answer that never came, so it did not run.";
const NOBODY_WATCHING: &str =
    "Nobody is watching this run, so no one can allow this call. It did not run.";
const MAIN_ONLY: &str =
    "Cerebro can ask the person only from the main conversation, so this call did not run.";

/// What the webview shows for a late click.
pub const STALE: &str = "No longer waiting: this request was already answered or cancelled.";

/// The lock, poisoned or not: no entry is ever left half written.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// One attended run that can ask: its durable id (the bearer's, M31.2a), its
/// Claude Code session, its vault, and the request it was started with, so
/// an answer can resume it on the same grant. The snapshot holds no bearer,
/// no endpoint and no message.
#[derive(Debug, Clone)]
pub struct Seat {
    pub run_id: String,
    pub session_id: String,
    pub vault: PathBuf,
    pub snapshot: Arc<AgentRequest>,
    /// The tool of a deferred call the session left open, which this run
    /// refuses before its new text runs (the settle).
    settle: Option<String>,
}

impl Seat {
    pub fn new(run_id: &str, session_id: &str, vault: &Path, request: &AgentRequest) -> Self {
        let mut snapshot = request.clone();
        snapshot.mcp_token = None;
        snapshot.mcp_url = None;
        snapshot.message = String::new();
        Self {
            run_id: run_id.to_string(),
            session_id: session_id.to_string(),
            vault: vault.to_path_buf(),
            snapshot: Arc::new(snapshot),
            settle: None,
        }
    }
}

/// What the hook hands the gate: the CLI's PreToolUse input, interpolated.
#[derive(Debug, Clone, PartialEq)]
pub struct GateCall {
    pub session_id: String,
    pub tool_use_id: String,
    pub tool_name: String,
    pub tool_input: Value,
    /// A subagent's id; empty on the main conversation.
    pub agent_id: String,
}

impl GateCall {
    /// The hook's arguments as the MCP call carries them. `tool_input`
    /// arrives as a JSON string (the CLI interpolates an object as text); one
    /// that does not parse reads as null. A missing field reads empty.
    pub fn from_args(args: &serde_json::Map<String, Value>) -> Self {
        let text = |key: &str| {
            args.get(key)
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string()
        };
        let tool_input = match args.get("tool_input") {
            Some(Value::String(raw)) => serde_json::from_str(raw).unwrap_or(Value::Null),
            Some(other) => other.clone(),
            None => Value::Null,
        };
        Self {
            session_id: text("session_id"),
            tool_use_id: text("tool_use_id"),
            tool_name: text("tool_name"),
            tool_input,
            agent_id: text("agent_id"),
        }
    }
}

/// What the policy point says about a call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    /// No opinion: argv decides.
    Argv,
    /// Ask the person, with a card of this kind.
    Ask(Kind),
    /// Refuse, telling the model why.
    Deny(String),
}

/// A card's kind. Later parts add kinds to this registry, never a second
/// path (M57.3 a question, M57.4 a write).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Permission,
}

/// Why a call no person answered was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CancelReason {
    /// The person pressed Stop (or New conversation) with the card open.
    Stopped,
    /// The session went on without an answer: a restart, or new text.
    NotAnswered,
    /// The vault the card belongs to was closed.
    VaultClosed,
}

impl CancelReason {
    fn model_text(self) -> &'static str {
        match self {
            Self::Stopped => STOPPED,
            Self::NotAnswered | Self::VaultClosed => NEVER_ANSWERED,
        }
    }
}

/// A person's answer as the webview sends it. Only `PersonAnswer::from_ipc`
/// reads it.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WireAnswer {
    Allow,
    Deny { message: Option<String> },
}

/// A person's answer. It has no `Deserialize` and no public constructor
/// beside `from_ipc`, which only the answer command calls
/// (`only_the_answer_command_mints_a_person_answer`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PersonAnswer {
    Allow,
    Deny { message: Option<String> },
}

impl PersonAnswer {
    /// The webview's answer, cleaned: a deny message trimmed, its control
    /// characters (C0, DEL, C1) turned into spaces, and cut at 2000
    /// characters; an empty one is none.
    pub fn from_ipc(wire: WireAnswer) -> Self {
        match wire {
            WireAnswer::Allow => Self::Allow,
            WireAnswer::Deny { message } => Self::Deny {
                message: message.and_then(|text| {
                    let cleaned: String = text
                        .trim()
                        .chars()
                        .map(|c| if c.is_control() { ' ' } else { c })
                        .take(MESSAGE_CHARS)
                        .collect();
                    let cleaned = cleaned.trim().to_string();
                    (!cleaned.is_empty()).then_some(cleaned)
                }),
            },
        }
    }

    fn gate_answer(&self) -> GateAnswer {
        match self {
            Self::Allow => GateAnswer::Allow {
                updated_input: None,
            },
            Self::Deny { message: None } => GateAnswer::Deny(DECLINED.into()),
            Self::Deny {
                message: Some(said),
            } => GateAnswer::Deny(format!("{DECLINED} They said: {said}")),
        }
    }
}

/// What the gate answers the hook.
#[derive(Debug, Clone, PartialEq)]
pub enum GateAnswer {
    NoOpinion,
    Defer,
    Allow { updated_input: Option<Value> },
    Deny(String),
}

impl GateAnswer {
    /// The hook JSON Claude Code reads from the tool's text: `{}` for no
    /// opinion, else a PreToolUse decision with its reason.
    pub fn hook_json(&self) -> Value {
        let (decision, reason, updated) = match self {
            Self::NoOpinion => return json!({}),
            Self::Defer => ("defer", DEFER_REASON.to_string(), None),
            Self::Allow { updated_input } => {
                ("allow", ALLOW_REASON.to_string(), updated_input.clone())
            }
            Self::Deny(reason) => ("deny", reason.clone(), None),
        };
        let mut output = json!({
            "hookEventName": "PreToolUse",
            "permissionDecision": decision,
            "permissionDecisionReason": reason,
        });
        if let Some(input) = updated {
            output["updatedInput"] = input;
        }
        json!({ "hookSpecificOutput": output })
    }
}

/// A call waiting for the person, as the panel draws it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct InteractionCard {
    /// 128-bit hex, minted by the book.
    pub id: String,
    pub kind: Kind,
    pub tool_name: String,
    pub tool_id: String,
    pub session_id: String,
    /// The manifest's title and the call's target, else the tool's name.
    pub summary: String,
    /// The call's input, pretty JSON, cut at 256 KiB.
    pub input: String,
    /// RFC 3339 UTC.
    pub asked_at: String,
}

/// What an answer resumes: the run's request, on the same session, in the
/// same vault.
#[derive(Debug, Clone)]
pub struct Resume {
    pub id: String,
    pub session_id: String,
    pub vault: PathBuf,
    pub snapshot: AgentRequest,
}

/// A typed refusal the webview words: `{code, message}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Refusal {
    pub code: &'static str,
    pub message: String,
}

impl Refusal {
    fn no_longer_waiting() -> Self {
        Self {
            code: NO_LONGER_WAITING,
            message: STALE.into(),
        }
    }
}

/// What a run's argv and settings take from the book: the tools that may
/// ask (out of `--allowedTools`), and a settle marker's tool, which joins
/// the hook's matcher only.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AskPlan {
    pub asks: Vec<String>,
    pub settle: Option<String>,
}

impl AskPlan {
    pub fn is_empty(&self) -> bool {
        self.asks.is_empty() && self.settle.is_none()
    }

    /// The hook's matcher: the asks, then the settle tool.
    pub fn matcher(&self) -> Vec<String> {
        let mut names = self.asks.clone();
        if let Some(settle) = &self.settle {
            if !names.contains(settle) {
                names.push(settle.clone());
            }
        }
        names
    }
}

#[derive(Debug, Clone, PartialEq)]
enum State {
    /// The gate deferred it; the stream has not confirmed it yet.
    Registered,
    /// A card: the stream confirmed the deferral.
    Waiting,
    /// The person answered and the resume is starting.
    Answering(PersonAnswer),
    /// The resume started.
    Answered(PersonAnswer),
    Cancelled(CancelReason),
}

#[derive(Debug, Clone)]
struct Entry {
    id: String,
    kind: Kind,
    session_id: String,
    tool_use_id: String,
    tool_name: String,
    tool_input: Value,
    summary: String,
    vault: PathBuf,
    /// The run whose gate registered it, or whose seat settled it.
    run_id: String,
    /// The request to resume. None on a settled marker, which no one answers.
    snapshot: Option<Arc<AgentRequest>>,
    state: State,
    /// A gate call read its answer or its refusal.
    consumed: bool,
    /// The run resuming it.
    resume_run: Option<String>,
    seq: u64,
    asked_at: String,
}

impl Entry {
    fn card(&self) -> InteractionCard {
        let pretty = serde_json::to_string_pretty(&self.tool_input).unwrap_or_default();
        InteractionCard {
            id: self.id.clone(),
            kind: self.kind,
            tool_name: self.tool_name.clone(),
            tool_id: self.tool_use_id.clone(),
            session_id: self.session_id.clone(),
            summary: self.summary.clone(),
            input: cut_at(pretty, CARD_INPUT_BYTES),
            asked_at: self.asked_at.clone(),
        }
    }
}

/// `text`, cut to at most `limit` bytes on a character boundary.
fn cut_at(mut text: String, limit: usize) -> String {
    if text.len() > limit {
        let mut at = limit;
        while !text.is_char_boundary(at) {
            at -= 1;
        }
        text.truncate(at);
    }
    text
}

#[derive(Debug, Default)]
struct Book {
    seats: std::collections::HashMap<String, Seat>,
    entries: Vec<Entry>,
    seq: u64,
}

impl Book {
    fn find(&mut self, session: &str, tool_use_id: &str) -> Option<&mut Entry> {
        self.entries
            .iter_mut()
            .find(|e| e.session_id == session && e.tool_use_id == tool_use_id)
    }

    fn next_seq(&mut self) -> u64 {
        self.seq += 1;
        self.seq
    }

    /// Keep at most CANCELLED_PER_SESSION cancelled entries in `session`,
    /// dropping the oldest.
    fn bound(&mut self, session: &str) {
        let mut cancelled: Vec<u64> = self
            .entries
            .iter()
            .filter(|e| e.session_id == session && matches!(e.state, State::Cancelled(_)))
            .map(|e| e.seq)
            .collect();
        if cancelled.len() <= CANCELLED_PER_SESSION {
            return;
        }
        cancelled.sort_unstable();
        let evict: HashSet<u64> = cancelled[..cancelled.len() - CANCELLED_PER_SESSION]
            .iter()
            .copied()
            .collect();
        self.entries.retain(|e| !evict.contains(&e.seq));
    }
}

/// A fresh card id: 128 random bits, hex.
fn mint_id() -> String {
    format!("{:032x}", rand::random::<u128>())
}

fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// A card's summary: the manifest's title, and the call's target argument
/// when the row names one and the input holds it (M54.1); else the name.
fn summary_of(tool_name: &str, input: &Value) -> String {
    let Some(row) = crate::policy::tools::row(tool_name) else {
        return tool_name.to_string();
    };
    let target = row
        .target
        .as_ref()
        .and_then(|target| target.arg.as_deref())
        .and_then(|arg| input.get(arg))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty());
    match target {
        Some(target) => format!("{} · {target}", row.title),
        None => row.title.clone(),
    }
}

// ---------------------------------------------------------------------------
// The policy point
// ---------------------------------------------------------------------------

/// What the seam says about a call (the one policy point; M57.2 replaces this
/// body with the tool-approval table, CV-04). `asks` is the debug override's
/// list, empty in a release build, so a release build answers `Argv` for
/// every call: no production run asks until M57.2. `seat` is the run the
/// call came from, if any; an ask on a run with no seat is the gate's to
/// refuse, since nobody is there to answer it.
pub fn decide(asks: &[String], _seat: Option<&Seat>, call: &GateCall) -> Decision {
    if asks.iter().any(|name| *name == call.tool_name) {
        return Decision::Ask(Kind::Permission);
    }
    Decision::Argv
}

/// The debug override, pure: the names in `raw` (comma separated), keeping
/// only cerebro's own MCP tools. acceptEdits never pre-approves an MCP tool,
/// so a call left out of `--allowedTools` cannot slip through it, where a
/// file tool or the shell could.
pub fn ask_override(raw: Option<&str>) -> Vec<String> {
    let mut names: Vec<String> = raw
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|name| {
            name.strip_prefix(super::MCP_PREFIX)
                .is_some_and(|bare| !bare.is_empty() && valid_name(bare))
        })
        .map(str::to_string)
        .collect();
    names.sort();
    names.dedup();
    names
}

/// The tools a debug build asks for: `CEREBRO_ASK_TOOLS`, read once. The one
/// place the variable is read, and compiled out of a release build
/// (`the_ask_override_lives_in_one_debug_item`).
#[cfg(debug_assertions)]
fn override_tools() -> Vec<String> {
    static TOOLS: OnceLock<Vec<String>> = OnceLock::new();
    TOOLS
        .get_or_init(|| ask_override(std::env::var("CEREBRO_ASK_TOOLS").ok().as_deref()))
        .clone()
}

#[cfg(not(debug_assertions))]
fn override_tools() -> Vec<String> {
    Vec::new()
}

/// `(major, minor, patch)` from `claude --version`'s answer
/// ("2.1.250 (Claude Code)").
fn parse_version(raw: &str) -> Option<(u64, u64, u64)> {
    let word = raw.split_whitespace().next()?;
    let mut parts = word.split('.').map(|part| part.parse::<u64>().ok());
    Some((parts.next()??, parts.next()??, parts.next()??))
}

/// Does this Claude Code have the gate's facts? Unknown reads as no.
pub fn supports_gate(version: Option<&str>) -> bool {
    version
        .and_then(parse_version)
        .is_some_and(|found| found >= MIN_CLI_VERSION)
}

/// The installed Claude Code's version, asked once per process and only
/// when a run would ask (`AgentState::status` is not cached).
pub fn cached_cli_version() -> Option<String> {
    static VERSION: OnceLock<Option<String>> = OnceLock::new();
    VERSION.get_or_init(|| super::status().version).clone()
}

/// A tool name the matcher can hold: `[A-Za-z0-9_-]` only, so a `|` (the
/// matcher's list separator in 2.1.250) or a regex character can never widen
/// it.
fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// The run's settings file, pure: one PreToolUse entry whose matcher is
/// exactly `matcher`, holding one `mcp_tool` hook on cerebro's server that
/// hands `ask_gate` the call. Refuses an empty list and any name outside the
/// matcher grammar.
pub fn hook_settings(matcher: &[String]) -> Result<String, String> {
    if matcher.is_empty() {
        return Err("a gate needs at least one tool to match".into());
    }
    if let Some(bad) = matcher.iter().find(|name| !valid_name(name)) {
        return Err(format!(
            "{} cannot be matched exactly, so no gate was written",
            Value::String(bad.chars().take(64).collect())
        ));
    }
    let field = |name: &str| Value::String(format!("${{{name}}}"));
    Ok(json!({
        "hooks": {
            "PreToolUse": [{
                "matcher": matcher.join("|"),
                "hooks": [{
                    "type": "mcp_tool",
                    "server": super::CEREBRO_SERVER,
                    "tool": GATE_TOOL,
                    "input": {
                        "session_id": field("session_id"),
                        "tool_use_id": field("tool_use_id"),
                        "tool_name": field("tool_name"),
                        "tool_input": field("tool_input"),
                        "agent_id": field("agent_id"),
                    },
                    "timeout": HOOK_TIMEOUT_SECS,
                }],
            }],
        },
    })
    .to_string())
}

// ---------------------------------------------------------------------------
// The book
// ---------------------------------------------------------------------------

/// The seam's one home: seats and calls, shared by the reader threads, the
/// loopback endpoint and the answer commands.
#[derive(Clone)]
pub struct Interactions {
    book: Arc<Mutex<Book>>,
    asks: Arc<Vec<String>>,
}

impl Default for Interactions {
    fn default() -> Self {
        Self::with_asks(override_tools())
    }
}

impl std::fmt::Debug for Interactions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Interactions")
            .field("asks", &self.asks)
            .finish_non_exhaustive()
    }
}

impl Interactions {
    /// A book whose policy point asks for `asks` (tests, and the debug
    /// override through `Default`).
    pub fn with_asks(asks: Vec<String>) -> Self {
        Self {
            book: Arc::default(),
            asks: Arc::new(asks),
        }
    }

    /// Seat a run. `pending` is the session file's open deferral, read for a
    /// resumed session. A seat that resumes a person's answer links it to
    /// the entry it resumes. Any other seat on that session settles: a card
    /// still waiting there, and an open marker no person answered, become
    /// Cancelled(NotAnswered), and the marker's tool joins this run's
    /// matcher, so Claude Code's re-emitted call is refused and the new text
    /// runs.
    pub fn open_seat(&self, mut seat: Seat, pending: Option<PendingDeferral>) {
        let mut book = lock(&self.book);
        let session = seat.session_id.clone();
        let answering = book
            .entries
            .iter_mut()
            .find(|e| e.session_id == session && matches!(e.state, State::Answering(_)));
        if let Some(entry) = answering {
            entry.resume_run = Some(seat.run_id.clone());
            book.seats.insert(seat.run_id.clone(), seat);
            return;
        }
        let mut settle = None;
        for entry in book.entries.iter_mut().filter(|e| e.session_id == session) {
            if matches!(entry.state, State::Waiting | State::Registered) {
                entry.state = State::Cancelled(CancelReason::NotAnswered);
            }
        }
        if let Some(marker) = pending {
            if book.find(&session, &marker.tool_use_id).is_none() {
                let seq = book.next_seq();
                book.entries.push(Entry {
                    id: mint_id(),
                    kind: Kind::Permission,
                    session_id: session.clone(),
                    tool_use_id: marker.tool_use_id.clone(),
                    tool_name: marker.tool_name.clone(),
                    tool_input: Value::Null,
                    summary: marker.tool_name.clone(),
                    vault: seat.vault.clone(),
                    run_id: seat.run_id.clone(),
                    snapshot: None,
                    state: State::Cancelled(CancelReason::NotAnswered),
                    consumed: false,
                    resume_run: None,
                    seq,
                    asked_at: now_rfc3339(),
                });
            }
            settle = Some(marker.tool_name);
        }
        // A refusal no resume has read yet keeps its tool in the matcher even
        // when the marker could not be read, so the call still meets it.
        if settle.is_none() {
            settle = book
                .entries
                .iter()
                .filter(|e| {
                    e.session_id == session && !e.consumed && matches!(e.state, State::Cancelled(_))
                })
                .max_by_key(|e| e.seq)
                .map(|e| e.tool_name.clone());
        }
        seat.settle = settle.filter(|name| !name.is_empty());
        book.bound(&session);
        book.seats.insert(seat.run_id.clone(), seat);
    }

    /// Unseat a run, once it has been reaped. Its unconfirmed registrations
    /// die with it; a call it resumed is gone once the gate read the answer,
    /// and back to Waiting when the resume never reached the gate; refusals
    /// it read are dropped.
    pub fn close_seat(&self, run_id: &str) {
        let mut book = lock(&self.book);
        let seat = book.seats.remove(run_id);
        book.entries
            .retain(|e| !(e.run_id == run_id && e.state == State::Registered));
        book.entries
            .retain(|e| !(e.resume_run.as_deref() == Some(run_id) && e.consumed));
        for entry in book.entries.iter_mut() {
            if entry.resume_run.as_deref() == Some(run_id) {
                entry.resume_run = None;
                entry.state = State::Waiting;
            }
        }
        if let Some(seat) = seat {
            book.entries.retain(|e| {
                !(e.session_id == seat.session_id
                    && e.consumed
                    && matches!(e.state, State::Cancelled(_)))
            });
        }
    }

    /// What a seated run's argv and settings take: the asks it holds among
    /// `granted` (its `--allowedTools`), and its settle tool. Empty for a run
    /// with no seat, and, with one warn line per process, on a Claude Code
    /// older than the gate or of unknown version.
    pub fn ask_plan(&self, run_id: &str, granted: &[String], version: Option<&str>) -> AskPlan {
        let plan = {
            let book = lock(&self.book);
            let Some(seat) = book.seats.get(run_id) else {
                return AskPlan::default();
            };
            AskPlan {
                asks: self
                    .asks
                    .iter()
                    .filter(|name| granted.iter().any(|held| held == *name))
                    .cloned()
                    .collect(),
                settle: seat.settle.clone(),
            }
        };
        if plan.is_empty() || supports_gate(version) {
            return plan;
        }
        static WARNED: OnceLock<()> = OnceLock::new();
        if WARNED.set(()).is_ok() {
            log::warn!(
                "Claude Code {} is older than the ask gate needs (2.1.250), so no run asks",
                version.unwrap_or("of unknown version")
            );
        }
        AskPlan::default()
    }

    /// Would this seated run ask anything (before the version check)? Lets
    /// the spawn skip asking the CLI its version for every run that cannot.
    pub fn wants_gate(&self, run_id: &str, granted: &[String]) -> bool {
        !self.ask_plan(run_id, granted, Some("999.0.0")).is_empty()
    }

    /// The hook's question (`ask_gate`). In this order: no seat turns an ask
    /// into a refusal; another session's call gets no opinion; a subagent's
    /// call is refused; a known call defers while it waits, repeats the
    /// person's answer once answered, and is refused with its reason once
    /// cancelled; a new call goes to `decide`, and an ask registers it and
    /// defers. Never allows a call no person answered.
    pub fn gate(&self, run_id: &str, call: &GateCall) -> GateAnswer {
        let mut book = lock(&self.book);
        let Some(seat) = book.seats.get(run_id).cloned() else {
            return match decide(&self.asks, None, call) {
                Decision::Argv => GateAnswer::NoOpinion,
                Decision::Ask(_) => GateAnswer::Deny(NOBODY_WATCHING.into()),
                Decision::Deny(reason) => GateAnswer::Deny(reason),
            };
        };
        if call.session_id != seat.session_id {
            return GateAnswer::NoOpinion;
        }
        if !call.agent_id.is_empty() {
            return GateAnswer::Deny(MAIN_ONLY.into());
        }
        if let Some(entry) = book.find(&seat.session_id, &call.tool_use_id) {
            if entry.tool_name != call.tool_name {
                return GateAnswer::NoOpinion;
            }
            return match &entry.state {
                State::Registered | State::Waiting => GateAnswer::Defer,
                State::Answering(answer) | State::Answered(answer) => {
                    entry.consumed = true;
                    answer.gate_answer()
                }
                State::Cancelled(reason) => {
                    entry.consumed = true;
                    GateAnswer::Deny(reason.model_text().into())
                }
            };
        }
        match decide(&self.asks, Some(&seat), call) {
            Decision::Argv => GateAnswer::NoOpinion,
            Decision::Deny(reason) => GateAnswer::Deny(reason),
            Decision::Ask(kind) => {
                let seq = book.next_seq();
                book.entries.push(Entry {
                    id: mint_id(),
                    kind,
                    session_id: seat.session_id.clone(),
                    tool_use_id: call.tool_use_id.clone(),
                    tool_name: call.tool_name.clone(),
                    tool_input: call.tool_input.clone(),
                    summary: summary_of(&call.tool_name, &call.tool_input),
                    vault: seat.vault.clone(),
                    run_id: run_id.to_string(),
                    snapshot: Some(seat.snapshot.clone()),
                    state: State::Registered,
                    consumed: false,
                    resume_run: None,
                    seq,
                    asked_at: now_rfc3339(),
                });
                GateAnswer::Defer
            }
        }
    }

    /// The run's stream confirmed a deferral: Cerebro's own registration
    /// becomes a card. A deferral no gate registered (a hook outside
    /// Cerebro), or one already shown, gives none.
    pub fn confirm(&self, session_id: &str, tool_use_id: &str) -> Option<InteractionCard> {
        let mut book = lock(&self.book);
        let entry = book.find(session_id, tool_use_id)?;
        if entry.state != State::Registered {
            return None;
        }
        entry.state = State::Waiting;
        Some(entry.card())
    }

    /// Take a person's answer: only from Waiting, in the same vault. What
    /// comes back is what to resume.
    pub fn begin_answer(
        &self,
        vault: &Path,
        id: &str,
        answer: PersonAnswer,
    ) -> Result<Resume, Refusal> {
        let mut book = lock(&self.book);
        let entry = book
            .entries
            .iter_mut()
            .find(|e| e.id == id)
            .filter(|e| e.state == State::Waiting && e.vault == vault)
            .ok_or_else(Refusal::no_longer_waiting)?;
        let snapshot = entry
            .snapshot
            .as_ref()
            .ok_or_else(Refusal::no_longer_waiting)?;
        let resume = Resume {
            id: entry.id.clone(),
            session_id: entry.session_id.clone(),
            vault: entry.vault.clone(),
            snapshot: (**snapshot).clone(),
        };
        entry.state = State::Answering(answer);
        entry.consumed = false;
        entry.resume_run = None;
        Ok(resume)
    }

    /// The resume started under `resume_run`.
    pub fn finish_answer(&self, id: &str, resume_run: &str) {
        let mut book = lock(&self.book);
        if let Some(entry) = book.entries.iter_mut().find(|e| e.id == id) {
            if let State::Answering(answer) = entry.state.clone() {
                entry.state = State::Answered(answer);
                entry
                    .resume_run
                    .get_or_insert_with(|| resume_run.to_string());
            }
        }
    }

    /// The resume could not start: the card waits again, unless the gate
    /// already read the answer.
    pub fn abort_answer(&self, id: &str) {
        let mut book = lock(&self.book);
        if let Some(entry) = book.entries.iter_mut().find(|e| e.id == id) {
            if matches!(entry.state, State::Answering(_)) && !entry.consumed {
                entry.state = State::Waiting;
                entry.resume_run = None;
            }
        }
    }

    /// Cancel a call no one has answered. True when this cancelled it; a
    /// second cancel, or one after an answer, is false.
    pub fn cancel(&self, id: &str, reason: CancelReason) -> bool {
        let mut book = lock(&self.book);
        let Some(entry) = book.entries.iter_mut().find(|e| e.id == id) else {
            return false;
        };
        if !matches!(entry.state, State::Waiting | State::Registered) {
            return false;
        }
        entry.state = State::Cancelled(reason);
        let session = entry.session_id.clone();
        book.bound(&session);
        true
    }

    /// A vault switch: every waiting call of another vault is refused as not
    /// answered. Returns the cards it cancelled.
    pub fn cancel_other_vaults(&self, vault: &Path) -> Vec<String> {
        let mut book = lock(&self.book);
        let mut cancelled = Vec::new();
        let mut sessions = Vec::new();
        for entry in book.entries.iter_mut() {
            if entry.vault != vault && matches!(entry.state, State::Waiting | State::Registered) {
                entry.state = State::Cancelled(CancelReason::VaultClosed);
                cancelled.push(entry.id.clone());
                sessions.push(entry.session_id.clone());
            }
        }
        for session in sessions {
            book.bound(&session);
        }
        cancelled
    }

    /// The cards waiting in `vault`, oldest first.
    pub fn pending(&self, vault: &Path) -> Vec<InteractionCard> {
        let book = lock(&self.book);
        let mut waiting: Vec<&Entry> = book
            .entries
            .iter()
            .filter(|e| e.vault == vault && e.state == State::Waiting)
            .collect();
        waiting.sort_by_key(|e| e.seq);
        waiting.into_iter().map(Entry::card).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ASKED: &str = "mcp__cerebro__append_to_note";

    fn request() -> AgentRequest {
        serde_json::from_value(json!({
            "message": "Add it to my inbox", "system_prompt": "be brief",
            "session_id": null, "attended": true, "shell": false
        }))
        .unwrap()
    }

    fn seat(run: &str, session: &str, vault: &str) -> Seat {
        let mut req = request();
        req.mcp_token = Some("bearer-secret".into());
        req.mcp_url = Some("http://127.0.0.1:1/mcp".into());
        Seat::new(run, session, Path::new(vault), &req)
    }

    fn book() -> Interactions {
        Interactions::with_asks(vec![ASKED.into()])
    }

    fn call(session: &str, id: &str, tool: &str) -> GateCall {
        GateCall {
            session_id: session.into(),
            tool_use_id: id.into(),
            tool_name: tool.into(),
            tool_input: json!({ "path": "notes/inbox.md", "content": "- call the vendor" }),
            agent_id: String::new(),
        }
    }

    /// A run that asked, deferred, and whose stream confirmed it: the card.
    fn waiting(book: &Interactions) -> InteractionCard {
        book.open_seat(seat("run-1", "s-1", "/v"), None);
        assert_eq!(
            book.gate("run-1", &call("s-1", "t1", ASKED)),
            GateAnswer::Defer
        );
        let card = book.confirm("s-1", "t1").expect("a confirmed card");
        book.close_seat("run-1");
        card
    }

    fn allow() -> PersonAnswer {
        PersonAnswer::from_ipc(WireAnswer::Allow)
    }

    fn deny(message: &str) -> PersonAnswer {
        PersonAnswer::from_ipc(WireAnswer::Deny {
            message: Some(message.into()),
        })
    }

    #[test]
    fn a_run_without_a_seat_never_waits() {
        let book = book();
        assert_eq!(
            book.gate("nobody", &call("s-1", "t1", ASKED)),
            GateAnswer::Deny(NOBODY_WATCHING.into())
        );
        assert_eq!(
            book.gate("nobody", &call("s-1", "t2", "mcp__cerebro__get_note")),
            GateAnswer::NoOpinion
        );
        assert!(book.confirm("s-1", "t1").is_none());
    }

    #[test]
    fn argv_decisions_get_no_opinion() {
        let book = book();
        book.open_seat(seat("run-1", "s-1", "/v"), None);
        assert_eq!(
            book.gate("run-1", &call("s-1", "t1", "mcp__cerebro__get_note")),
            GateAnswer::NoOpinion
        );
        assert_eq!(GateAnswer::NoOpinion.hook_json(), json!({}));
        // A release build's policy point asks for nothing at all.
        let s = seat("run-1", "s-1", "/v");
        assert_eq!(
            decide(&[], Some(&s), &call("s-1", "t1", ASKED)),
            Decision::Argv
        );
    }

    #[test]
    fn an_ask_registers_and_defers() {
        let book = book();
        book.open_seat(seat("run-1", "s-1", "/v"), None);
        let answer = book.gate("run-1", &call("s-1", "t1", ASKED));
        assert_eq!(answer, GateAnswer::Defer);
        assert_eq!(
            answer.hook_json(),
            json!({ "hookSpecificOutput": { "hookEventName": "PreToolUse",
                "permissionDecision": "defer", "permissionDecisionReason": DEFER_REASON } })
        );
        // Registered, not yet a card.
        assert!(book.pending(Path::new("/v")).is_empty());
        // Asked again before the stream confirms: still deferred, one entry.
        assert_eq!(
            book.gate("run-1", &call("s-1", "t1", ASKED)),
            GateAnswer::Defer
        );
        assert_eq!(lock(&book.book).entries.len(), 1);
    }

    #[test]
    fn another_sessions_call_gets_no_opinion() {
        let book = book();
        book.open_seat(seat("run-1", "s-1", "/v"), None);
        assert_eq!(
            book.gate("run-1", &call("s-other", "t1", ASKED)),
            GateAnswer::NoOpinion
        );
        assert!(lock(&book.book).entries.is_empty());
    }

    #[test]
    fn a_subagents_call_is_refused_not_deferred() {
        let book = book();
        book.open_seat(seat("run-1", "s-1", "/v"), None);
        let mut sub = call("s-1", "t1", ASKED);
        sub.agent_id = "agent-7".into();
        assert_eq!(book.gate("run-1", &sub), GateAnswer::Deny(MAIN_ONLY.into()));
        assert!(lock(&book.book).entries.is_empty());
    }

    #[test]
    fn the_gate_never_allows_what_no_person_answered() {
        let book = book();
        book.open_seat(seat("run-1", "s-1", "/v"), None);
        // Every path a bearer can drive, many times over: nothing allows.
        for round in 0..3 {
            for tool in [ASKED, "mcp__cerebro__get_note", "Bash", ""] {
                for session in ["s-1", "s-2", ""] {
                    let mut c = call(session, &format!("t{round}"), tool);
                    for agent in ["", "a"] {
                        c.agent_id = agent.into();
                        let answer = book.gate("run-1", &c);
                        assert!(
                            !matches!(answer, GateAnswer::Allow { .. }),
                            "{c:?} -> {answer:?}"
                        );
                        let answer = book.gate("no-seat", &c);
                        assert!(!matches!(answer, GateAnswer::Allow { .. }));
                    }
                }
            }
            book.confirm("s-1", &format!("t{round}"));
        }
    }

    #[test]
    fn an_answer_is_read_and_repeated() {
        let book = book();
        let card = waiting(&book);
        let resume = book
            .begin_answer(Path::new("/v"), &card.id, allow())
            .unwrap();
        assert_eq!(resume.session_id, "s-1");
        assert_eq!(resume.snapshot.message, "", "the resume sends no text");
        assert_eq!(resume.snapshot.mcp_token, None, "and holds no bearer");
        assert_eq!(resume.snapshot.system_prompt.as_deref(), Some("be brief"));
        book.open_seat(seat("run-2", "s-1", "/v"), None);
        book.finish_answer(&card.id, "run-2");
        let first = book.gate("run-2", &call("s-1", "t1", ASKED));
        assert_eq!(
            first,
            GateAnswer::Allow {
                updated_input: None
            }
        );
        assert_eq!(
            first.hook_json()["hookSpecificOutput"]["permissionDecision"],
            "allow"
        );
        // A repeat call reads the same answer.
        assert_eq!(book.gate("run-2", &call("s-1", "t1", ASKED)), first);
        book.close_seat("run-2");
        // Consumed and its resume over: gone. The next identical call asks.
        assert!(lock(&book.book).entries.is_empty());
        book.open_seat(seat("run-3", "s-1", "/v"), None);
        assert_eq!(
            book.gate("run-3", &call("s-1", "t9", ASKED)),
            GateAnswer::Defer
        );
    }

    #[test]
    fn a_deny_carries_the_persons_cleaned_words() {
        let book = book();
        let card = waiting(&book);
        let said = format!("  not\u{7}now\u{85}please{}  ", "x".repeat(3000));
        book.begin_answer(Path::new("/v"), &card.id, deny(&said))
            .unwrap();
        book.open_seat(seat("run-2", "s-1", "/v"), None);
        let GateAnswer::Deny(reason) = book.gate("run-2", &call("s-1", "t1", ASKED)) else {
            panic!("a deny");
        };
        let said = reason
            .strip_prefix(&format!("{DECLINED} They said: "))
            .unwrap();
        assert!(said.starts_with("not now please"), "{said}");
        assert_eq!(said.chars().count(), MESSAGE_CHARS);
        assert_eq!(
            PersonAnswer::from_ipc(WireAnswer::Deny {
                message: Some(" \u{0} ".into())
            }),
            PersonAnswer::Deny { message: None }
        );
        assert_eq!(
            PersonAnswer::Deny { message: None }.gate_answer(),
            GateAnswer::Deny(DECLINED.into())
        );
    }

    #[test]
    fn a_cancelled_call_is_refused_with_its_reason() {
        for (reason, text) in [
            (CancelReason::Stopped, STOPPED),
            (CancelReason::NotAnswered, NEVER_ANSWERED),
            (CancelReason::VaultClosed, NEVER_ANSWERED),
        ] {
            let book = book();
            let card = waiting(&book);
            assert!(book.cancel(&card.id, reason));
            book.open_seat(seat("run-2", "s-1", "/v"), None);
            assert_eq!(
                book.gate("run-2", &call("s-1", "t1", ASKED)),
                GateAnswer::Deny(text.into())
            );
            book.close_seat("run-2");
            // Read once by a resume, it is gone.
            assert!(lock(&book.book).entries.is_empty(), "{reason:?}");
        }
    }

    #[test]
    fn cancel_is_idempotent() {
        let book = book();
        let card = waiting(&book);
        assert!(book.cancel(&card.id, CancelReason::Stopped));
        assert!(!book.cancel(&card.id, CancelReason::Stopped));
        assert!(!book.cancel("no-such-card", CancelReason::Stopped));
        assert!(book.pending(Path::new("/v")).is_empty());
    }

    #[test]
    fn only_a_confirmed_registration_becomes_a_card() {
        let book = book();
        book.open_seat(seat("run-1", "s-1", "/v"), None);
        // A deferral no gate registered (a hook outside Cerebro): no card.
        assert!(book.confirm("s-1", "foreign").is_none());
        book.gate("run-1", &call("s-1", "t1", ASKED));
        let card = book.confirm("s-1", "t1").unwrap();
        assert_eq!(card.kind, Kind::Permission);
        assert_eq!(card.tool_name, ASKED);
        assert_eq!(card.tool_id, "t1");
        assert_eq!(card.session_id, "s-1");
        assert_eq!(card.id.len(), 32);
        assert!(card.id.chars().all(|c| c.is_ascii_hexdigit()));
        assert!(card.summary.ends_with("notes/inbox.md"), "{}", card.summary);
        assert!(card.input.contains("call the vendor"));
        // Shown once.
        assert!(book.confirm("s-1", "t1").is_none());
        assert_eq!(book.pending(Path::new("/v")), vec![card.clone()]);
        assert!(book.pending(Path::new("/other")).is_empty());
        let wire = serde_json::to_value(&card).unwrap();
        assert_eq!(wire["kind"], "permission");
        assert!(wire.get("asked_at").is_some());
    }

    #[test]
    fn an_unconfirmed_registration_dies_with_its_run() {
        let book = book();
        book.open_seat(seat("run-1", "s-1", "/v"), None);
        book.gate("run-1", &call("s-1", "t1", ASKED));
        book.close_seat("run-1");
        assert!(lock(&book.book).entries.is_empty());
        assert!(book.confirm("s-1", "t1").is_none());
    }

    #[test]
    fn a_second_answer_is_no_longer_waiting() {
        let book = book();
        let card = waiting(&book);
        book.begin_answer(Path::new("/v"), &card.id, allow())
            .unwrap();
        let late = book
            .begin_answer(Path::new("/v"), &card.id, deny("no"))
            .unwrap_err();
        assert_eq!(late.code, NO_LONGER_WAITING);
        assert_eq!(late.message, STALE);
        assert!(book.begin_answer(Path::new("/v"), "nope", allow()).is_err());
        // A cancelled card is no longer waiting either.
        let book2 = Interactions::with_asks(vec![ASKED.into()]);
        let card2 = waiting(&book2);
        book2.cancel(&card2.id, CancelReason::Stopped);
        assert!(book2
            .begin_answer(Path::new("/v"), &card2.id, allow())
            .is_err());
    }

    #[test]
    fn an_answer_from_another_vault_is_no_longer_waiting() {
        let book = book();
        let card = waiting(&book);
        let refused = book
            .begin_answer(Path::new("/elsewhere"), &card.id, allow())
            .unwrap_err();
        assert_eq!(refused.code, NO_LONGER_WAITING);
        assert_eq!(book.pending(Path::new("/v")).len(), 1, "still waiting");
    }

    #[test]
    fn a_failed_resume_puts_the_card_back() {
        let book = book();
        let card = waiting(&book);
        book.begin_answer(Path::new("/v"), &card.id, allow())
            .unwrap();
        assert!(book.pending(Path::new("/v")).is_empty());
        book.abort_answer(&card.id);
        assert_eq!(book.pending(Path::new("/v")), vec![card]);
    }

    #[test]
    fn a_resume_that_never_reached_the_gate_puts_the_card_back() {
        let book = book();
        let card = waiting(&book);
        book.begin_answer(Path::new("/v"), &card.id, allow())
            .unwrap();
        book.open_seat(seat("run-2", "s-1", "/v"), None);
        book.finish_answer(&card.id, "run-2");
        // The resume ended without its hook ever asking.
        book.close_seat("run-2");
        assert_eq!(book.pending(Path::new("/v")), vec![card.clone()]);
        // And it can be answered again.
        assert!(book
            .begin_answer(Path::new("/v"), &card.id, allow())
            .is_ok());
    }

    #[test]
    fn a_vault_switch_cancels_other_vaults_cards() {
        let book = book();
        let card = waiting(&book);
        book.open_seat(seat("run-9", "s-9", "/kept"), None);
        book.gate("run-9", &call("s-9", "t1", ASKED));
        let kept = book.confirm("s-9", "t1").unwrap();
        assert_eq!(book.cancel_other_vaults(Path::new("/kept")), vec![card.id]);
        assert!(book.pending(Path::new("/v")).is_empty());
        assert_eq!(book.pending(Path::new("/kept")), vec![kept]);
        book.open_seat(seat("run-2", "s-1", "/v"), None);
        assert_eq!(
            book.gate("run-2", &call("s-1", "t1", ASKED)),
            GateAnswer::Deny(NEVER_ANSWERED.into())
        );
    }

    #[test]
    fn a_new_text_resume_refuses_an_unanswered_marker() {
        // After a restart: the book is empty and the file holds the marker.
        let book = book();
        let marker = PendingDeferral {
            tool_use_id: "t1".into(),
            tool_name: "mcp__cerebro__edit_note".into(),
        };
        book.open_seat(seat("run-1", "s-1", "/v"), Some(marker));
        let plan = book.ask_plan("run-1", &[ASKED.into()], Some("2.1.250"));
        assert_eq!(plan.asks, vec![ASKED.to_string()]);
        assert_eq!(plan.settle.as_deref(), Some("mcp__cerebro__edit_note"));
        assert_eq!(plan.matcher(), vec![ASKED, "mcp__cerebro__edit_note"]);
        assert_eq!(
            book.gate("run-1", &call("s-1", "t1", "mcp__cerebro__edit_note")),
            GateAnswer::Deny(NEVER_ANSWERED.into())
        );
        // A card still waiting in that session is cancelled the same way.
        let book = Interactions::with_asks(vec![ASKED.into()]);
        let card = waiting(&book);
        book.open_seat(seat("run-2", "s-1", "/v"), None);
        assert!(book.pending(Path::new("/v")).is_empty());
        assert!(book
            .begin_answer(Path::new("/v"), &card.id, allow())
            .is_err());
        assert_eq!(
            book.ask_plan("run-2", &[], Some("2.1.250"))
                .settle
                .as_deref(),
            Some(ASKED),
            "its tool stays in the matcher"
        );
    }

    #[test]
    fn an_answer_resume_keeps_its_own_marker() {
        let book = book();
        let card = waiting(&book);
        book.begin_answer(Path::new("/v"), &card.id, allow())
            .unwrap();
        let marker = PendingDeferral {
            tool_use_id: "t1".into(),
            tool_name: ASKED.into(),
        };
        book.open_seat(seat("run-2", "s-1", "/v"), Some(marker));
        assert_eq!(
            book.ask_plan("run-2", &[], Some("2.1.250")).settle,
            None,
            "an answer's resume settles nothing"
        );
        assert_eq!(
            book.gate("run-2", &call("s-1", "t1", ASKED)),
            GateAnswer::Allow {
                updated_input: None
            }
        );
    }

    #[test]
    fn cancelled_entries_are_bounded() {
        let book = book();
        book.open_seat(seat("run-1", "s-1", "/v"), None);
        for n in 0..(CANCELLED_PER_SESSION + 10) {
            let id = format!("t{n}");
            book.gate("run-1", &call("s-1", &id, ASKED));
            let card = book.confirm("s-1", &id).unwrap();
            assert!(book.cancel(&card.id, CancelReason::Stopped));
        }
        let entries = lock(&book.book).entries.clone();
        assert_eq!(entries.len(), CANCELLED_PER_SESSION);
        assert!(
            !entries.iter().any(|e| e.tool_use_id == "t0"),
            "the oldest went first"
        );
    }

    #[test]
    fn the_hook_matches_exactly_the_asked_tools() {
        let settings: Value = serde_json::from_str(
            &hook_settings(&[ASKED.into(), "mcp__cerebro__edit_note".into()]).unwrap(),
        )
        .unwrap();
        let entries = settings["hooks"]["PreToolUse"].as_array().unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(
            entries[0]["matcher"],
            "mcp__cerebro__append_to_note|mcp__cerebro__edit_note"
        );
        let hooks = entries[0]["hooks"].as_array().unwrap();
        assert_eq!(hooks.len(), 1);
        assert_eq!(
            hooks[0],
            json!({
                "type": "mcp_tool", "server": "cerebro", "tool": "ask_gate",
                "input": {
                    "session_id": "${session_id}", "tool_use_id": "${tool_use_id}",
                    "tool_name": "${tool_name}", "tool_input": "${tool_input}",
                    "agent_id": "${agent_id}"
                },
                "timeout": 10
            })
        );
        assert!(hook_settings(&[]).is_err());
    }

    #[test]
    fn a_name_outside_the_matcher_grammar_is_refused() {
        for bad in ["a|b", "mcp__x.*", "Bash(rm *)", "a b", "", "é"] {
            assert!(hook_settings(&[bad.into()]).is_err(), "{bad:?}");
        }
        assert!(hook_settings(&["Bash".into(), "mcp__a-b__c_d9".into()]).is_ok());
    }

    #[test]
    fn ask_override_keeps_only_cerebro_tools() {
        assert_eq!(
            ask_override(Some(
                " mcp__cerebro__append_to_note,Bash,Write, mcp__other__x,mcp__cerebro__,mcp__cerebro__a|b,mcp__cerebro__append_to_note "
            )),
            vec![ASKED.to_string()]
        );
        assert!(ask_override(None).is_empty());
        assert!(ask_override(Some("")).is_empty());
    }

    #[test]
    fn the_ask_override_lives_in_one_debug_item() {
        let source = include_str!("interaction.rs");
        let body = source.split("#[cfg(test)]\nmod tests").next().unwrap();
        let literal = concat!("\"CEREBRO_", "ASK_TOOLS\"");
        assert_eq!(body.matches(literal).count(), 1, "read in one place");
        assert_eq!(body.matches("std::env::var(").count(), 1);
        let at = body.find(literal).unwrap();
        let item = &body[..at];
        let item_start = item.rfind("\nfn ").unwrap();
        let attribute = item[..item_start].rfind("#[cfg(").unwrap();
        assert_eq!(
            &item[attribute..item_start],
            "#[cfg(debug_assertions)]",
            "the item that reads it is compiled only into a debug build"
        );
    }

    #[test]
    fn an_older_cli_gets_no_gate() {
        let book = book();
        book.open_seat(seat("run-1", "s-1", "/v"), None);
        let granted = vec![ASKED.to_string()];
        for old in [
            None,
            Some("2.1.249 (Claude Code)"),
            Some("1.9.999"),
            Some("garbage"),
        ] {
            assert!(book.ask_plan("run-1", &granted, old).is_empty(), "{old:?}");
        }
        for new in ["2.1.250 (Claude Code)", "2.2.0", "3.0.0"] {
            assert_eq!(book.ask_plan("run-1", &granted, Some(new)).asks, granted);
        }
        assert!(book.wants_gate("run-1", &granted));
        // A run with no seat, or that holds none of the asks, asks nothing.
        assert!(book.ask_plan("other", &granted, Some("2.1.250")).is_empty());
        assert!(!book.wants_gate("run-1", &["mcp__cerebro__get_note".into()]));
    }

    #[test]
    fn the_gate_reads_the_hooks_arguments() {
        let args = json!({
            "session_id": "s-1", "tool_use_id": "t1", "tool_name": ASKED,
            "tool_input": "{\"path\":\"a.md\"}", "agent_id": ""
        });
        let parsed = GateCall::from_args(args.as_object().unwrap());
        assert_eq!(parsed.tool_input, json!({ "path": "a.md" }));
        let bad = json!({ "tool_input": "{not json" });
        let parsed = GateCall::from_args(bad.as_object().unwrap());
        assert_eq!(parsed.tool_input, Value::Null);
        assert_eq!(parsed.session_id, "");
    }

    /// Non-test source of every Rust file under `src/`.
    fn sources() -> Vec<(String, String)> {
        fn walk(dir: &Path, out: &mut Vec<(String, String)>) {
            for entry in std::fs::read_dir(dir).unwrap().flatten() {
                let path = entry.path();
                if path.is_dir() {
                    walk(&path, out);
                } else if path.extension().is_some_and(|e| e == "rs") {
                    let text = std::fs::read_to_string(&path).unwrap();
                    let body = text
                        .split("#[cfg(test)]\nmod tests")
                        .next()
                        .unwrap()
                        .to_string();
                    let name = path
                        .strip_prefix(Path::new(env!("CARGO_MANIFEST_DIR")).join("src"))
                        .unwrap()
                        .to_string_lossy()
                        .replace('\\', "/");
                    out.push((name, body));
                }
            }
        }
        let mut out = Vec::new();
        walk(&Path::new(env!("CARGO_MANIFEST_DIR")).join("src"), &mut out);
        out
    }

    #[test]
    fn only_the_answer_command_mints_a_person_answer() {
        let sources = sources();
        assert!(sources.len() > 20);
        for (name, body) in &sources {
            let mints = body.matches("PersonAnswer::from_ipc(").count();
            match name.as_str() {
                "lib.rs" => assert_eq!(mints, 1, "the answer command mints it once"),
                "agent/interaction.rs" => {}
                _ => assert_eq!(mints, 0, "{name} mints a person's answer"),
            }
            if name != "agent/interaction.rs" {
                for built in ["PersonAnswer::Allow", "PersonAnswer::Deny"] {
                    assert!(!body.contains(built), "{name} builds {built}");
                }
            }
        }
        let mcp = &sources.iter().find(|(name, _)| name == "mcp.rs").unwrap().1;
        assert!(
            !mcp.contains("begin_answer"),
            "no MCP path records an answer"
        );
        assert!(!mcp.contains("finish_answer"));
        assert!(!mcp.contains("PersonAnswer"));
    }

    #[test]
    fn every_interaction_refusal_code_is_declared_operational() {
        let table = crate::policy::table::PolicyTable::load().unwrap();
        for code in REFUSAL_CODES {
            assert_eq!(
                table.destiny(code),
                Some(crate::policy::table::Destiny::Operational),
                "{code}"
            );
            assert!(table.transport_rejections.iter().any(|c| c == code));
        }
    }
}
