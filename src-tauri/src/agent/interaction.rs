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
//! **A bearer can wait, never answer** (CV-28). Nothing reachable from MCP
//! mints a `PersonAnswer`: the hook and any process holding the run's bearer
//! can register a wait in that run's own conversation and read the person's
//! decision, nothing more. A tool the gate may defer is never pre-approved in
//! argv, so a hook that fails, times out or never runs leaves the call
//! refused.
//!
//! `decide` is the seam's one policy point. Since M57.2 it answers from the
//! tool-approval table (`policy::tool_approval::host_answer`, CV-04) over the
//! run's plan, which its seat holds: the shell ceiling's asks become cards,
//! an ask-first agent's page writes become write cards (M57.4), refusals are
//! denied with the family's message, and a This conversation grant
//! (`ConversationGrants`) for the call's exact subject allows it where the
//! family's card offers one. Debug builds may also name cerebro tools to ask
//! for in `CEREBRO_ASK_TOOLS` (`ask_override`), a test seam that can add asks
//! and never allows.
//!
//! **A subagent starts only as a type the run may start** (M91.2b). A seated
//! run that holds Claude Code's subagent tool has its hook match the tool by
//! every name (`AskPlan::inspects`), and the gate reads each main-thread
//! call's `subagent_type`: one the plan allows gets no opinion, so argv's
//! denials still apply (never an allow), and any other is denied with the
//! types it may start. A subagent's own calls keep MAIN_ONLY: no subagent
//! can ask the person anything, so nothing it calls is ever deferred.
//!
//! **A write lands only on a person's Allow** (M57.4, CV-29). The gate's
//! allow lets an asked page write reach dispatch, and dispatch is the
//! boundary: `mcp.rs` lets an ask-first write land only by taking a
//! `WriteApproval` (`take_write_approval`), bound to its vault, Claude Code
//! session, actor, tool and input, used once, and good for
//! APPROVAL_MINUTES. Only the answer command records one
//! (`record_write_approval`, from the `Resume` an Allow of a write card
//! starts), so a user allow rule or a hook that never runs can make the CLI
//! call the tool sooner, and the write is still refused.
//!
//! **The person may edit the draft before Allow** (M57.4b). The answer
//! command hands `begin_answer_edited` the edited input, which must fit the
//! tool's schema (`policy::tools::validate_input`) and pass the caller's
//! check of the run's stored grant (scopes, tool grant, corpus, and since
//! M57.4c the write previewed on the bytes on disk); a refusal
//! leaves the card waiting and records nothing, so an edit never widens the
//! grant. The approval keeps the asked input's hash, the approved input and
//! its hash. The resume's gate allows the call with the approved input as
//! `updatedInput`, and dispatch takes the approval by either hash and runs
//! the approved input, so the edit lands whether or not Claude Code applies
//! `updatedInput` on a resumed allow (F5/F8, derived; live run owed).
//!
//! **A question returns its answers as the call's input** (M57.3). The
//! table asks for AskUserQuestion on an attended run with a question card:
//! the gate parses the call's questions (`super::question`) and refuses a set
//! no card can show, so no card appears and the model hears why. The
//! person's answers are checked for membership and counts, then held as the
//! call's own input with `answers` set, and the resume's gate allows the
//! call with that input (`updatedInput`), which is how Claude Code hears
//! them (F9, derived from 2.1.250; live run owed). Don't answer declines,
//! and the model is told to decide itself.
//!
//! This conversation lives here too, in memory only: per vault and Claude
//! Code session, bounded, forgotten at a vault switch and at quit, and
//! written only when the person's answer starts its resume
//! (`finish_answer`).
//!
//! The book lives in memory. Quit drops it, and the next send in a thread
//! whose call was still waiting refuses that call as not answered and runs the
//! new message (the settle: `open_seat` with the session file's marker,
//! `super::transcript::pending_deferral`).

use std::collections::{HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::question::{self, Question, QuestionAnswer};
use super::transcript::PendingDeferral;
use super::AgentRequest;
use crate::policy::tool_approval::{self, CardKind, HostAnswer, RunApproval};

/// The gate's tool name on cerebro's loopback server. A hook endpoint, never
/// a manifest row: `tools/list` never names it (`shared/policy/README.md`),
/// and live on 2.1.250 an `mcp_tool` hook reaches a tool the list leaves out.
pub const GATE_TOOL: &str = "ask_gate";

/// The one refusal code the seam adds (policy.v3, operational transport): a
/// person's late click after its request ended.
pub const NO_LONGER_WAITING: &str = "no_longer_waiting";

/// A This conversation answer for a call the table does not ask about
/// (M57.2), or an answer that does not fit its card (M57.3): an existing
/// transport code, recorded nowhere.
pub const MALFORMED_ARGUMENTS: &str = "malformed_arguments";

/// The prompt tool's name on cerebro's loopback server (M57.3): Claude
/// Code's `--permission-prompt-tool`, which 2.1.250 needs before it offers
/// AskUserQuestion in `-p` (F9, derived). Like `ask_gate`, a hook endpoint,
/// never a manifest row. Unlike it, the run that names it must find it in
/// `tools/list`: live on 2.1.250, an unlisted prompt tool fails every tool
/// call of the run. So a seat records that its run was handed it
/// (`hand_prompt_tool`), `mcp.rs` lists it for that run alone, and the run's
/// `--disallowedTools` hides it from the model. `Interactions::host_prompt`
/// is its answer.
pub const HOST_TOOL: &str = "ask_host";

/// Every refusal code this module can hand the webview.
pub const REFUSAL_CODES: &[&str] = &[NO_LONGER_WAITING, MALFORMED_ARGUMENTS];

/// How many sessions keep This conversation grants, and how many subjects
/// each keeps; the oldest goes first.
const GRANT_SESSIONS: usize = 64;
const GRANT_SUBJECTS: usize = 100;

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
/// A subagent call for a type the run may not start (M91.2b); `{types}` is
/// the ones it may, comma-separated.
const AGENT_TYPE_REFUSED: &str =
    "This conversation may start only these subagent types: {types}. Start one of those, or do the work yourself.";
/// The same, for a run whose plan names no type at all.
const NO_AGENT_TYPE: &str = "This conversation may start no subagent, so this call did not run.";

/// What the webview shows for a late click.
pub const STALE: &str = "No longer waiting: this request was already answered or cancelled.";

/// What it shows for This conversation on a call no ceiling asks about.
pub const NOT_REMEMBERED: &str =
    "This conversation is offered only for a command or file change the shell ceiling asks about.";

/// What it shows for This conversation on a call whose subject was cut
/// (`tool_approval::subject_is_cut`): a grant on a prefix would cover every
/// call that shares it.
pub const NOT_REMEMBERED_CUT: &str =
    "This conversation is not offered for a command too long to show in full. Allow it once instead.";

/// What it shows for an Allow on a question card (M57.3).
pub const ANSWER_THE_QUESTION: &str = "A question is answered with its answers.";

/// What it shows for answers sent to a card that asks no question (M57.3).
pub const NOT_A_QUESTION: &str = "Only a question takes answers.";

/// Book words for an edited draft sent with anything but an Allow of a
/// write card (M57.4b).
pub const EDIT_MISFIT: &str = "Only an Allow of a page write carries an edited draft.";

/// What the prompt tool tells the model about a call no person answered
/// (M57.3), and what `mcp.rs` answers for it when no book exists.
pub const NOT_PUT: &str = "Cerebro couldn't put this call to the person, so it did not run.";

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
/// Claude Code session, its vault, the request it was started with, so an
/// answer can resume it on the same grant, and its tool-approval plan
/// (M57.2), the one its argv was built from. The snapshot holds no bearer,
/// no endpoint and no message.
#[derive(Debug, Clone)]
pub struct Seat {
    pub run_id: String,
    pub session_id: String,
    pub vault: PathBuf,
    pub snapshot: Arc<AgentRequest>,
    pub approval: Arc<RunApproval>,
    /// The tool of a deferred call the session left open, which this run
    /// refuses before its new text runs (the settle).
    settle: Option<String>,
    /// The run's argv names `ask_host` as its permission prompt tool, so its
    /// `tools/list` lists it (`hand_prompt_tool`).
    prompted: bool,
    generation_bound: bool,
    generation_settlement: Option<Arc<crate::actions::native_owner::NativeGenerationSettlement>>,
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
            approval: Arc::new(tool_approval::plan_for(request, true)),
            snapshot: Arc::new(snapshot),
            settle: None,
            prompted: false,
            generation_bound: false,
            generation_settlement: None,
        }
    }

    pub(crate) fn with_generation(
        mut self,
        tracking: Option<Arc<crate::actions::native_owner::NativeGenerationSettlement>>,
    ) -> Self {
        self.generation_bound = tracking.is_some();
        self.generation_settlement = tracking;
        self
    }

    /// The seat with the plan its run's argv was built from (`agent::stream`).
    pub fn with_approval(mut self, approval: RunApproval) -> Self {
        self.approval = Arc::new(approval);
        self
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

    /// The prompt tool's arguments (M57.3, F8 derived): `tool_name`,
    /// `tool_use_id` and the call's `input` as an object. They name no
    /// session, so `host_prompt` reads the seat's.
    pub fn from_prompt_args(args: &serde_json::Map<String, Value>) -> Self {
        let text = |key: &str| {
            args.get(key)
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string()
        };
        Self {
            session_id: String::new(),
            tool_use_id: text("tool_use_id"),
            tool_name: text("tool_name"),
            tool_input: args.get("input").cloned().unwrap_or(Value::Null),
            agent_id: String::new(),
        }
    }
}

/// What the policy point says about a call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    /// No opinion: argv decides.
    Argv,
    /// Allow: a This conversation grant for this exact subject (M57.2).
    Allow,
    /// Ask the person, with a card of this kind; a table ask names its
    /// family and exact subject (M57.2).
    Ask {
        kind: Kind,
        family: Option<String>,
        subject: Option<String>,
    },
    /// Refuse, telling the model why.
    Deny(String),
}

/// A card's kind: a registry later parts add kinds to, never a second path.
/// The table names which kind a family's ask draws (M57.4).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Permission,
    /// An ask-first agent's page write (M57.4).
    Write,
    /// AskUserQuestion's questions (M57.3).
    Question,
    /// A genuinely held native managed-action tools/call; never a CLI resume.
    ManagedAction,
    /// Original held account/action access choice; no invocation or effect.
    ManagedAccess,
}

impl Kind {
    fn of(card: Option<CardKind>) -> Self {
        match card {
            Some(CardKind::Write) => Kind::Write,
            Some(CardKind::Question) => Kind::Question,
            Some(CardKind::Permission) | None => Kind::Permission,
        }
    }
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

/// How long an Allow holds (M57.2): this call only, or every call in the
/// conversation with the same family and exact subject.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Remember {
    #[default]
    Once,
    Conversation,
}

/// A person's answer as the webview sends it. Only `PersonAnswer::from_ipc`
/// reads it.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WireAnswer {
    Allow {
        #[serde(default)]
        remember: Remember,
    },
    Deny {
        message: Option<String>,
    },
    /// A question card's answers (M57.3), one per question.
    Answers {
        answers: Vec<QuestionAnswer>,
    },
}

/// A person's answer. It has no `Deserialize` and no public constructor
/// beside `from_ipc`, which only the answer command calls
/// (`only_the_answer_command_mints_a_person_answer`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PersonAnswer {
    Allow {
        remember: Remember,
    },
    Deny {
        message: Option<String>,
    },
    /// Checked against the card's questions when it is taken
    /// (`begin_answer`), never here.
    Answers {
        answers: Vec<QuestionAnswer>,
    },
}

impl PersonAnswer {
    /// Finite held-action control, not person admission. Only the native answer
    /// command constructs this value from IPC; the original ACT worker still
    /// authenticates its owner and commits the real approval separately.
    pub(crate) fn managed_choice(&self) -> Option<bool> {
        match self {
            Self::Allow {
                remember: Remember::Once,
            } => Some(true),
            Self::Deny { .. } => Some(false),
            _ => None,
        }
    }
    /// The webview's answer, cleaned: a deny message trimmed, its control
    /// characters (C0, DEL, C1) turned into spaces, and cut at 2000
    /// characters; an empty one is none.
    pub fn from_ipc(wire: WireAnswer) -> Self {
        match wire {
            WireAnswer::Allow { remember } => Self::Allow { remember },
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
            WireAnswer::Answers { answers } => Self::Answers { answers },
        }
    }

    #[cfg(test)]
    fn gate_answer(&self) -> GateAnswer {
        self.gate_answer_for(Kind::Permission, None, None)
    }

    /// What the model reads: a deny of a write card says the table's
    /// `ask_first_declined`, with the person's reason quoted (M57.4), and an
    /// Allow of an edited one allows with the edited input (M57.4b); a deny
    /// of another table ask (one with a `family`) says `person_denied`
    /// (M57.2), any other says DECLINED, and either adds the person's own
    /// words. A question's answers allow the call with `answered`, its input
    /// with the answers set (M57.3); a Don't answer says `question_declined`,
    /// and adds the person's words. An answer of the wrong shape for its
    /// card, which `begin_answer` never takes, is a decline.
    fn gate_answer_for(
        &self,
        kind: Kind,
        family: Option<&str>,
        answered: Option<&Value>,
    ) -> GateAnswer {
        let person_denied = || tool_approval::messages().person_denied.as_str();
        if let (Kind::Write, Self::Deny { message }) = (kind, self) {
            return GateAnswer::Deny(write_declined(message.as_deref()));
        }
        // M57.4b: an Allow of an edited draft hands Claude Code the person's
        // version; dispatch lands it whichever input the call carries.
        if let (Kind::Write, Self::Allow { .. }, Some(edited)) = (kind, self, answered) {
            return GateAnswer::Allow {
                updated_input: Some(edited.clone()),
            };
        }
        if kind == Kind::Question {
            let declined = tool_approval::messages().question_declined.as_str();
            return match (self, answered) {
                (Self::Answers { .. }, Some(input)) => GateAnswer::Allow {
                    updated_input: Some(input.clone()),
                },
                (
                    Self::Deny {
                        message: Some(said),
                    },
                    _,
                ) => GateAnswer::Deny(format!("{declined} They said: {said}")),
                _ => GateAnswer::Deny(declined.into()),
            };
        }
        match (self, family) {
            (Self::Answers { .. }, _) => GateAnswer::Deny(DECLINED.into()),
            (Self::Allow { .. }, _) => GateAnswer::Allow {
                updated_input: None,
            },
            (Self::Deny { message: None }, None) => GateAnswer::Deny(DECLINED.into()),
            (
                Self::Deny {
                    message: Some(said),
                },
                None,
            ) => GateAnswer::Deny(format!("{DECLINED} They said: {said}")),
            (Self::Deny { message: None }, Some(_)) => GateAnswer::Deny(person_denied().into()),
            (
                Self::Deny {
                    message: Some(said),
                },
                Some(_),
            ) => GateAnswer::Deny(format!("{} They said: {said}", person_denied())),
        }
    }
}

/// What the model reads when the person declines a write (M57.4): the
/// table's words, and the reason in quotes when they gave one.
pub fn write_declined(reason: Option<&str>) -> String {
    let messages = tool_approval::messages();
    match reason {
        Some(reason) => format!(
            "{} {}",
            messages.ask_first_declined,
            messages.ask_first_reason.replace("{reason}", reason)
        ),
        None => messages.ask_first_declined.clone(),
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

/// What the prompt tool answers Claude Code (M57.3): run the call with this
/// input, or refuse it, telling the model why.
#[derive(Debug, Clone, PartialEq)]
pub enum HostPrompt {
    Allow { updated_input: Value },
    Deny(String),
}

impl HostPrompt {
    /// The JSON Claude Code reads from the prompt tool's text (F8, derived):
    /// `{"behavior": "allow", "updatedInput": …}`, which replaces the
    /// call's input, or `{"behavior": "deny", "message": …}`.
    pub fn prompt_json(&self) -> Value {
        match self {
            Self::Allow { updated_input } => {
                json!({ "behavior": "allow", "updatedInput": updated_input })
            }
            Self::Deny(message) => json!({ "behavior": "deny", "message": message }),
        }
    }
}

/// A call waiting for the person, as the panel draws it.
#[derive(Debug, Clone, PartialEq)]
pub struct InteractionCard {
    /// 128-bit hex, minted by the book.
    pub id: String,
    pub kind: Kind,
    /// Managed-only native in-flight person decision; absent for legacy cards.
    pub answering: Option<bool>,
    /// Actual original handle selector; never an execution or origin proof.
    pub run: Option<crate::actions::SafeCounter>,
    pub tool_name: String,
    pub tool_id: String,
    pub session_id: String,
    /// The manifest's title and the call's target, else the tool's name.
    pub summary: String,
    /// A table ask's family (M57.2): what the card is titled by, and what a
    /// This conversation grant covers with the subject. None for any other
    /// ask, which offers no This conversation.
    pub family: Option<String>,
    /// The exact command, path or input the card names (M57.2).
    pub subject: Option<String>,
    /// A cerebro tool's manifest title (M57.4): a write card's headline.
    pub title: Option<String>,
    /// The note or folder the call is aimed at, when the manifest names its
    /// argument and the input holds it (M57.4).
    pub target: Option<String>,
    /// Who asks (M57.4): the run's actor, `process:<handle>` for an agent;
    /// None for the plain panel.
    pub actor: Option<String>,
    /// A question card's questions (M57.3), parsed; left out of every other
    /// card, so a permission or write card reads as it did before.
    pub questions: Option<Vec<Question>>,
    /// The call's input, pretty JSON, cut at 256 KiB.
    pub input: String,
    /// RFC 3339 UTC.
    pub asked_at: String,
}

impl Serialize for InteractionCard {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let mut wire = serializer.serialize_map(None)?;
        wire.serialize_entry("id", &self.id)?;
        wire.serialize_entry("kind", &self.kind)?;
        let managed = matches!(self.kind, Kind::ManagedAction | Kind::ManagedAccess);
        if managed {
            wire.serialize_entry("answering", &self.answering.unwrap_or(false))?;
            wire.serialize_entry("run", &self.run)?;
        }
        wire.serialize_entry("tool_name", &self.tool_name)?;
        let tool_id = if managed && self.tool_id.is_empty() {
            None
        } else {
            Some(&self.tool_id)
        };
        wire.serialize_entry("tool_id", &tool_id)?;
        wire.serialize_entry("session_id", &self.session_id)?;
        wire.serialize_entry("summary", &self.summary)?;
        wire.serialize_entry("family", &self.family)?;
        wire.serialize_entry("subject", &self.subject)?;
        wire.serialize_entry("title", &self.title)?;
        wire.serialize_entry("target", &self.target)?;
        wire.serialize_entry("actor", &self.actor)?;
        if let Some(questions) = &self.questions {
            wire.serialize_entry("questions", questions)?;
        }
        wire.serialize_entry("input", &self.input)?;
        wire.serialize_entry("asked_at", &self.asked_at)?;
        wire.end()
    }
}

/// What an answer resumes: the run's request, on the same session, in the
/// same vault.
#[derive(Debug, Clone)]
pub struct Resume {
    pub(crate) link: AnswerLink,
    pub id: String,
    pub session_id: String,
    pub vault: PathBuf,
    pub snapshot: AgentRequest,
    /// An Allow of a write card (M57.4): the approval its resume's write
    /// takes at dispatch. Only the answer command hands it to
    /// `record_write_approval`.
    pub approval: Option<WriteApproval>,
}

/// Minted only while the original interaction is accepted for an answer. IDs
/// copied out of a card or CLI session cannot construct or reactivate this link.
#[derive(Debug, Clone)]
pub(crate) struct AnswerLink {
    book: std::sync::Weak<Mutex<Book>>,
    id: String,
    source_run: String,
    session: String,
    vault: PathBuf,
    answer_key: String,
    generation_bound: bool,
}
impl AnswerLink {
    pub(crate) fn source_run(&self) -> &str {
        &self.source_run
    }
    pub(crate) fn session(&self) -> &str {
        &self.session
    }
    pub(crate) fn answer_key(&self) -> &str {
        &self.answer_key
    }
    pub(crate) fn generation_bound(&self) -> bool {
        self.generation_bound
    }
    pub(crate) fn belongs_to(&self, interactions: &Interactions) -> bool {
        self.book.ptr_eq(&Arc::downgrade(&interactions.book))
    }
    fn matches(&self, book: &Book) -> bool {
        book.entries.iter().any(|entry| {
            entry.id == self.id
                && entry.run_id == self.source_run
                && entry.session_id == self.session
                && entry.vault == self.vault
                && entry.answer_key.as_deref() == Some(&self.answer_key)
                && matches!(entry.state, State::Answering(_))
                && !entry.consumed
                && entry.resume_run.is_none()
        })
    }
    pub(crate) fn validate(&self, vault: &Path) -> bool {
        let Some(book) = self.book.upgrade() else {
            return false;
        };
        vault == self.vault && self.matches(&lock(&book))
    }
}

/// A person's Allow of one ask-first write (M57.4): the vault, Claude Code
/// session and actor it was asked in, the tool, the asked input's
/// `canonical_hash`, the input the person approved (the asked one, or their
/// edit of it, M57.4b) with its hash and the keys the edit changed, and
/// when. It has no public constructor: `begin_answer_edited` builds one for
/// an Allow of a write card, and the answer command records it
/// (`only_the_answer_command_mints_an_approval` in mcp.rs).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WriteApproval {
    entry: String,
    vault: PathBuf,
    session_id: String,
    actor: String,
    tool: String,
    asked_hash: String,
    approved_input: Value,
    approved_hash: String,
    edited: Vec<String>,
    at: chrono::DateTime<chrono::Utc>,
    /// The run resuming the call, once it started; the approval dies with it.
    resume_run: Option<String>,
}

impl WriteApproval {
    /// The input the person approved (M57.4b).
    pub fn approved_input(&self) -> &Value {
        &self.approved_input
    }

    /// The top-level keys the person's edit changed, sorted; empty when they
    /// allowed the draft as asked.
    pub fn edited(&self) -> &[String] {
        &self.edited
    }
}

/// What dispatch runs once it takes an approval (M57.4b): the approved input,
/// and the keys the person changed, which the tool's result names.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApprovedWrite {
    pub input: Value,
    pub edited: Vec<String>,
}

/// The top-level keys whose values differ between `asked` and `approved`,
/// added and removed ones included, sorted (M57.4b). Values compare by
/// `canonical_hash`, so key order inside them is no change.
pub fn changed_keys(asked: &Value, approved: &Value) -> Vec<String> {
    let empty = serde_json::Map::new();
    let asked = asked.as_object().unwrap_or(&empty);
    let approved = approved.as_object().unwrap_or(&empty);
    let mut keys: Vec<String> = asked
        .keys()
        .chain(approved.keys())
        .filter(|key| asked.get(*key).map(canonical_hash) != approved.get(*key).map(canonical_hash))
        .cloned()
        .collect();
    keys.sort();
    keys.dedup();
    keys
}

/// A JSON value's hash with every object's keys sorted, recursively: the
/// same input hashes the same however its keys were ordered (M57.4).
/// serde_json keeps insertion order in this build, so the sort is explicit.
pub fn canonical_hash(value: &Value) -> String {
    fn sorted(value: &Value) -> Value {
        match value {
            Value::Object(map) => {
                let mut keys: Vec<&String> = map.keys().collect();
                keys.sort();
                let mut out = serde_json::Map::new();
                for key in keys {
                    out.insert(key.clone(), sorted(&map[key]));
                }
                Value::Object(out)
            }
            Value::Array(items) => Value::Array(items.iter().map(sorted).collect()),
            other => other.clone(),
        }
    }
    crate::ledger::sha256_hex(sorted(value).to_string().as_bytes())
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

    fn not_remembered() -> Self {
        Self::malformed(NOT_REMEMBERED)
    }

    fn not_remembered_cut() -> Self {
        Self::malformed(NOT_REMEMBERED_CUT)
    }

    /// An answer that does not fit its card (M57.3), in the words given.
    fn malformed(message: impl Into<String>) -> Self {
        Self {
            code: MALFORMED_ARGUMENTS,
            message: message.into(),
        }
    }
}

/// What a run's argv and settings take from the book: the tools that may
/// ask (out of `--allowedTools`), a settle marker's tool, which joins the
/// hook's matcher only, and the tools the gate inspects without ever asking
/// (M91.2b): the subagent tool a seated run holds, by every name, whose
/// calls the gate holds to the agent types the run may start.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AskPlan {
    pub asks: Vec<String>,
    pub settle: Option<String>,
    pub inspects: Vec<String>,
}

impl AskPlan {
    pub fn is_empty(&self) -> bool {
        self.asks.is_empty() && self.settle.is_none() && self.inspects.is_empty()
    }

    /// The hook's matcher: the asks, then the settle tool, then the tools it
    /// inspects.
    pub fn matcher(&self) -> Vec<String> {
        let mut names = self.asks.clone();
        for name in self.settle.iter().chain(&self.inspects) {
            if !names.contains(name) {
                names.push(name.clone());
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
    /// A table ask's family and exact subject (M57.2).
    family: Option<String>,
    subject: Option<String>,
    /// A question card's questions (M57.3), parsed when it registered.
    questions: Option<Vec<Question>>,
    /// The input a person's answers make (M57.3): the call's own, with
    /// `answers` set; what the gate's allow hands Claude Code.
    answered_input: Option<Value>,
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
    answer_key: Option<String>,
    generation_bound: bool,
    generation_settlement: Option<Arc<crate::actions::native_owner::NativeGenerationSettlement>>,
    seq: u64,
    asked_at: String,
}

impl Entry {
    fn card(&self) -> InteractionCard {
        let pretty = serde_json::to_string_pretty(&self.tool_input).unwrap_or_default();
        let (title, target) = title_and_target(&self.tool_name, &self.tool_input);
        InteractionCard {
            id: self.id.clone(),
            kind: self.kind,
            answering: None,
            run: None,
            tool_name: self.tool_name.clone(),
            tool_id: self.tool_use_id.clone(),
            session_id: self.session_id.clone(),
            summary: self.summary.clone(),
            family: self.family.clone(),
            subject: self.subject.clone(),
            title,
            target,
            actor: self.snapshot.as_ref().and_then(|req| req.actor.clone()),
            questions: self.questions.clone(),
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
    grants: ConversationGrants,
    /// A person's Allows of ask-first writes not yet taken (M57.4).
    approvals: Vec<WriteApproval>,
}

/// This conversation (M57.2): per vault and Claude Code session, the exact
/// (family, subject) pairs a person allowed for the rest of it. Memory only,
/// so a restart asks again; at most GRANT_SESSIONS sessions of
/// GRANT_SUBJECTS subjects each, the oldest out; a vault switch drops every
/// other vault's. Its one writer is `remember_subject`, which only
/// `finish_answer` calls. A cut subject (`tool_approval::subject_is_cut`) is
/// never held and never covered: it names only a prefix of the call.
#[derive(Debug, Default)]
struct ConversationGrants {
    /// Oldest session first.
    sessions: VecDeque<GrantedSession>,
}

#[derive(Debug)]
struct GrantedSession {
    vault: PathBuf,
    session_id: String,
    /// Oldest subject first.
    subjects: VecDeque<(String, String)>,
}

impl ConversationGrants {
    fn covers(&self, vault: &Path, session: &str, family: &str, subject: &str) -> bool {
        !tool_approval::subject_is_cut(subject)
            && self
                .sessions
                .iter()
                .find(|s| s.vault == vault && s.session_id == session)
                .is_some_and(|s| {
                    s.subjects
                        .iter()
                        .any(|(f, sub)| f == family && sub == subject)
                })
    }

    fn remember_subject(&mut self, vault: &Path, session: &str, family: &str, subject: &str) {
        if tool_approval::subject_is_cut(subject) {
            return;
        }
        let at = self
            .sessions
            .iter()
            .position(|s| s.vault == vault && s.session_id == session);
        let mut held = match at.and_then(|at| self.sessions.remove(at)) {
            Some(held) => held,
            None => GrantedSession {
                vault: vault.to_path_buf(),
                session_id: session.to_string(),
                subjects: VecDeque::new(),
            },
        };
        held.subjects
            .retain(|(f, sub)| !(f == family && sub == subject));
        held.subjects
            .push_back((family.to_string(), subject.to_string()));
        while held.subjects.len() > GRANT_SUBJECTS {
            held.subjects.pop_front();
        }
        self.sessions.push_back(held);
        while self.sessions.len() > GRANT_SESSIONS {
            self.sessions.pop_front();
        }
    }

    fn forget_other_vaults(&mut self, keep: &Path) {
        self.sessions.retain(|s| s.vault == keep);
    }
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

/// A cerebro tool's manifest title, and the call's target argument when the
/// row names one and the input holds it (M54.1); None for a tool the
/// manifest has no row for.
fn title_and_target(tool_name: &str, input: &Value) -> (Option<String>, Option<String>) {
    let Some(row) = crate::policy::tools::row(tool_name) else {
        return (None, None);
    };
    let target = row
        .target
        .as_ref()
        .and_then(|target| target.arg.as_deref())
        .and_then(|arg| input.get(arg))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    (Some(row.title.clone()), target)
}

/// A card's summary: the manifest's title and the call's target, else the
/// title alone, else the tool's name.
fn summary_of(tool_name: &str, input: &Value) -> String {
    match title_and_target(tool_name, input) {
        (Some(title), Some(target)) => format!("{title} · {target}"),
        (Some(title), None) => title,
        _ => tool_name.to_string(),
    }
}

// ---------------------------------------------------------------------------
// The policy point
// ---------------------------------------------------------------------------

/// What the seam says about a call (the one policy point). `asks` is the
/// debug override's list, empty in a release build, and asks first: a test
/// seam may add asks, never allows. Then the tool-approval table, over the
/// plan of the run the call came from (`seat`): its asks become cards unless
/// `granted(family, subject)` holds a This conversation grant for the exact
/// subject, its refusals and denials carry their message, a subagent start
/// for a type the plan does not allow is denied with the ones it does
/// (M91.2b, `agent_type_refusal`), and everything else is argv's. An ask
/// draws the card its family's table row names: a confirmable page write
/// draws a write card (M57.4). A call with no seat that names a CLI built-in
/// is the gate's to refuse, since nobody is there to answer it; one that
/// names a cerebro tool is argv's, and dispatch's.
pub fn decide(
    asks: &[String],
    seat: Option<&Seat>,
    call: &GateCall,
    granted: impl Fn(&str, &str) -> bool,
) -> Decision {
    let unseated_ask = Decision::Ask {
        kind: Kind::Permission,
        family: None,
        subject: None,
    };
    if asks.contains(&call.tool_name) {
        return unseated_ask;
    }
    let Some(seat) = seat else {
        return match crate::policy::tools::cli_tool(&call.tool_name) {
            Some(_) => unseated_ask,
            None => Decision::Argv,
        };
    };
    match tool_approval::host_answer(&seat.approval, granted, &call.tool_name, &call.tool_input) {
        HostAnswer::Pass => match agent_type_refusal(&seat.approval, call) {
            Some(refusal) => Decision::Deny(refusal),
            None => Decision::Argv,
        },
        HostAnswer::Allow => Decision::Allow,
        HostAnswer::Deny { message } => Decision::Deny(message),
        HostAnswer::Ask { family, subject } => Decision::Ask {
            kind: Kind::of(tool_approval::card_of(&family).map(|card| card.kind)),
            family: Some(family),
            subject: Some(subject),
        },
    }
}

/// Why a call to the subagent tool `approval` holds may not start its agent
/// type (M91.2b): its `subagent_type` names none of the plan's allowed
/// types. None for an allowed type, which the gate leaves to argv (never an
/// allow: a deny rule of argv's or the person's still binds it), and for a
/// call to any other tool.
fn agent_type_refusal(approval: &RunApproval, call: &GateCall) -> Option<String> {
    let delegates = super::cli_agents::delegate_rows(approval);
    let named = delegates
        .iter()
        .any(|row| row.name == call.tool_name || row.aliases.contains(&call.tool_name));
    if !named {
        return None;
    }
    let asked = call.tool_input.get("subagent_type").and_then(Value::as_str);
    let allowed = &approval.allowed_agent_types;
    if asked.is_some_and(|asked| allowed.iter().any(|t| t == asked)) {
        return None;
    }
    Some(if allowed.is_empty() {
        NO_AGENT_TYPE.to_string()
    } else {
        AGENT_TYPE_REFUSED.replace("{types}", &allowed.join(", "))
    })
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

/// A tool name the matcher can hold: `[A-Za-z0-9_-]` only, so a `|` (the
/// matcher's list separator in 2.1.250) or a regex character can never widen
/// it.
fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// The run's settings file, pure: `settings` (the hardening and environment
/// every run but an internal one carries, M91.2b) with one PreToolUse entry
/// added whose matcher is exactly `matcher`, holding one `mcp_tool` hook on
/// cerebro's server that hands `ask_gate` the call. Refuses an empty list,
/// any name outside the matcher grammar, and settings that name hooks of
/// their own.
pub fn hook_settings(
    matcher: &[String],
    mut settings: serde_json::Map<String, Value>,
) -> Result<String, String> {
    if matcher.is_empty() {
        return Err("a gate needs at least one tool to match".into());
    }
    if let Some(bad) = matcher.iter().find(|name| !valid_name(name)) {
        return Err(format!(
            "{} cannot be matched exactly, so no gate was written",
            Value::String(bad.chars().take(64).collect())
        ));
    }
    if settings.contains_key(HOOKS) {
        return Err("the run's settings already name hooks, so no gate was written".into());
    }
    let field = |name: &str| Value::String(format!("${{{name}}}"));
    settings.insert(
        HOOKS.into(),
        json!({
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
        }),
    );
    Ok(Value::Object(settings).to_string())
}

/// The settings key Claude Code reads hooks under.
const HOOKS: &str = "hooks";

// ---------------------------------------------------------------------------
// The book
// ---------------------------------------------------------------------------

/// The seam's one home: seats and calls, shared by the reader threads, the
/// loopback endpoint and the answer commands.
#[derive(Clone)]
pub struct Interactions {
    book: Arc<Mutex<Book>>,
    asks: Arc<Vec<String>>,
    managed: Arc<Mutex<managed_action_wait::ManagedBook>>,
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
            managed: Arc::default(),
        }
    }

    /// Seat a run. `pending` is the session file's open deferral, read for a
    /// resumed session. A seat that resumes a person's answer links it to
    /// the entry it resumes. Any other seat on that session settles: a card
    /// still waiting there, and an open marker no person answered, become
    /// Cancelled(NotAnswered), and the marker's tool joins this run's
    /// matcher, so Claude Code's re-emitted call is refused and the new text
    /// runs.
    #[cfg(test)]
    pub fn open_seat(&self, seat: Seat, pending: Option<PendingDeferral>) {
        let _ = self.open_seat_inner(seat, pending, false);
    }
    pub(crate) fn open_unlinked_seat(
        &self,
        seat: Seat,
        pending: Option<PendingDeferral>,
    ) -> Result<(), String> {
        self.open_seat_inner(seat, pending, true)
    }
    fn open_seat_inner(
        &self,
        mut seat: Seat,
        pending: Option<PendingDeferral>,
        checked: bool,
    ) -> Result<(), String> {
        let mut book = lock(&self.book);
        let session = seat.session_id.clone();
        if checked
            && book.entries.iter().any(|entry| {
                entry.session_id == session
                    && entry.generation_bound
                    && !entry.consumed
                    && matches!(entry.state, State::Answering(_) | State::Answered(_))
            })
        {
            return Err(
                "This conversation is resuming a waiting call. Nothing was started.".into(),
            );
        }
        let mut cancelled_generations = Vec::new();
        let answering = book
            .entries
            .iter_mut()
            .find(|e| e.session_id == session && matches!(e.state, State::Answering(_)));
        if let Some(entry) = answering {
            entry.resume_run = Some(seat.run_id.clone());
            book.seats.insert(seat.run_id.clone(), seat);
            return Ok(());
        }
        let mut settle = None;
        for entry in book.entries.iter_mut().filter(|e| e.session_id == session) {
            if matches!(entry.state, State::Waiting | State::Registered) {
                entry.state = State::Cancelled(CancelReason::NotAnswered);
                cancelled_generations.extend(entry.generation_settlement.clone());
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
                    family: None,
                    subject: None,
                    questions: None,
                    answered_input: None,
                    vault: seat.vault.clone(),
                    run_id: seat.run_id.clone(),
                    snapshot: None,
                    state: State::Cancelled(CancelReason::NotAnswered),
                    consumed: false,
                    resume_run: None,
                    answer_key: None,
                    generation_bound: seat.generation_bound,
                    generation_settlement: seat.generation_settlement.clone(),
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
        drop(book);
        for generation in cancelled_generations {
            generation.cancel_wait();
        }
        Ok(())
    }

    pub(crate) fn open_answer_seat(&self, seat: Seat, link: &AnswerLink) -> Result<(), String> {
        let mut book = lock(&self.book);
        if !link.book.ptr_eq(&Arc::downgrade(&self.book))
            || !link.matches(&book)
            || seat.vault != link.vault
            || seat.session_id != link.session
            || seat.generation_bound != link.generation_bound
        {
            return Err("The waiting call changed. Nothing was started.".into());
        }
        let entry = book
            .entries
            .iter_mut()
            .find(|entry| entry.id == link.id)
            .expect("checked above");
        entry.resume_run = Some(seat.run_id.clone());
        book.seats.insert(seat.run_id.clone(), seat);
        Ok(())
    }

    /// Unseat a run, once it has been reaped. Its unconfirmed registrations
    /// die with it; a call it resumed is gone once the gate read the answer,
    /// and back to Waiting when the resume never reached the gate; refusals
    /// it read are dropped.
    pub fn close_seat(&self, run_id: &str) -> bool {
        let mut book = lock(&self.book);
        let restored = book.entries.iter().any(|entry| {
            entry.resume_run.as_deref() == Some(run_id)
                && !entry.consumed
                && matches!(entry.state, State::Answering(_) | State::Answered(_))
        });
        let seat = book.seats.remove(run_id);
        self.close_managed_run(run_id);
        // M57.4: an approval dies with the run that resumed its call.
        book.approvals
            .retain(|a| a.resume_run.as_deref() != Some(run_id));
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
        restored
    }

    /// What a seated run's argv and settings take: the debug asks it holds
    /// among `granted` (its `--allowedTools`), then the tools its plan asks
    /// for or refuses (M57.2), which no list names, and its settle tool.
    /// Empty for a run with no seat, and, with one warn line per process, on
    /// a Claude Code older than the gate or of unknown version.
    pub fn ask_plan(&self, run_id: &str, granted: &[String], version: Option<&str>) -> AskPlan {
        let plan = {
            let book = lock(&self.book);
            let Some(seat) = book.seats.get(run_id) else {
                return AskPlan::default();
            };
            let mut asks: Vec<String> = self
                .asks
                .iter()
                .filter(|name| granted.iter().any(|held| held == *name))
                .cloned()
                .collect();
            for name in seat.approval.matcher() {
                if !asks.contains(&name) {
                    asks.push(name);
                }
            }
            let inspects = super::cli_agents::delegate_rows(&seat.approval)
                .into_iter()
                .flat_map(|row| std::iter::once(&row.name).chain(&row.aliases))
                .cloned()
                .collect();
            AskPlan {
                asks,
                settle: seat.settle.clone(),
                inspects,
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

    /// Record that the seated run's argv names `ask_host` as its permission
    /// prompt tool (`agent::run_gate`, beside the gate it writes). A run with
    /// no seat is handed none, so nothing is recorded.
    pub fn hand_prompt_tool(&self, run_id: &str) {
        if let Some(seat) = lock(&self.book).seats.get_mut(run_id) {
            seat.prompted = true;
        }
    }

    /// Does this run's `tools/list` list `ask_host` (`mcp.rs`)? Only while
    /// its seat records that its argv names it.
    pub fn lists_prompt_tool(&self, run_id: &str) -> bool {
        lock(&self.book)
            .seats
            .get(run_id)
            .is_some_and(|seat| seat.prompted)
    }

    /// The hook's question (`ask_gate`). In this order: no seat turns an ask
    /// into a refusal; another session's call gets no opinion; a subagent's
    /// call is refused; a known call defers while it waits, repeats the
    /// person's answer once answered, and is refused with its reason once
    /// cancelled; a new call goes to `decide`, and an ask registers it and
    /// defers. Never allows a call no person answered, now or earlier in the
    /// conversation for its exact subject (This conversation, M57.2), and
    /// never a subagent's start (M91.2b): an allowed type gets no opinion.
    pub fn gate(&self, run_id: &str, call: &GateCall) -> GateAnswer {
        let mut book = lock(&self.book);
        let Some(seat) = book.seats.get(run_id).cloned() else {
            return match decide(&self.asks, None, call, |_, _| false) {
                Decision::Argv => GateAnswer::NoOpinion,
                Decision::Ask { .. } | Decision::Allow => GateAnswer::Deny(NOBODY_WATCHING.into()),
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
                    answer.gate_answer_for(
                        entry.kind,
                        entry.family.as_deref(),
                        entry.answered_input.as_ref(),
                    )
                }
                State::Cancelled(reason) => {
                    entry.consumed = true;
                    GateAnswer::Deny(reason.model_text().into())
                }
            };
        }
        let granted = |family: &str, subject: &str| {
            book.grants
                .covers(&seat.vault, &seat.session_id, family, subject)
        };
        match decide(&self.asks, Some(&seat), call, granted) {
            Decision::Argv => GateAnswer::NoOpinion,
            Decision::Allow => GateAnswer::Allow {
                updated_input: None,
            },
            Decision::Deny(reason) => GateAnswer::Deny(reason),
            Decision::Ask {
                kind,
                family,
                subject,
            } => {
                // M57.3: a question set no card can show is refused here, so
                // nothing registers and the model hears why.
                let questions = match kind {
                    Kind::Question => match question::parse_questions(&call.tool_input) {
                        Ok(set) => Some(set),
                        Err(reason) => {
                            return GateAnswer::Deny(tool_approval::question_malformed(&reason))
                        }
                    },
                    Kind::Permission | Kind::Write | Kind::ManagedAction | Kind::ManagedAccess => {
                        None
                    }
                };
                let seq = book.next_seq();
                book.entries.push(Entry {
                    id: mint_id(),
                    kind,
                    session_id: seat.session_id.clone(),
                    tool_use_id: call.tool_use_id.clone(),
                    tool_name: call.tool_name.clone(),
                    tool_input: call.tool_input.clone(),
                    summary: summary_of(&call.tool_name, &call.tool_input),
                    family,
                    subject,
                    questions,
                    answered_input: None,
                    vault: seat.vault.clone(),
                    run_id: run_id.to_string(),
                    snapshot: Some(seat.snapshot.clone()),
                    state: State::Registered,
                    consumed: false,
                    resume_run: None,
                    answer_key: None,
                    generation_bound: seat.generation_bound,
                    generation_settlement: seat.generation_settlement.clone(),
                    seq,
                    asked_at: now_rfc3339(),
                });
                GateAnswer::Defer
            }
        }
    }

    /// The prompt tool's answer (M57.3): what Claude Code asks `ask_host`
    /// when a call reaches its permission prompt instead of the gate. It
    /// allows only a call this run's seat holds a person's answer for, by
    /// the call's tool_use id in the seat's session, with the input the
    /// answer made (the call's own, or a question's with its answers set).
    /// Everything else is refused: the table's message where it denies or
    /// refuses, `unlisted` where it would pass, and NOT_PUT where it would
    /// ask, so a hook that never ran still refuses. Like the gate, it can
    /// read an answer and never record one.
    pub fn host_prompt(&self, run_id: &str, call: &GateCall) -> HostPrompt {
        let mut book = lock(&self.book);
        let Some(seat) = book.seats.get(run_id).cloned() else {
            return HostPrompt::Deny(NOBODY_WATCHING.into());
        };
        if let Some(entry) = book.find(&seat.session_id, &call.tool_use_id) {
            if entry.tool_name != call.tool_name {
                return HostPrompt::Deny(NOT_PUT.into());
            }
            return match &entry.state {
                State::Answering(answer) | State::Answered(answer) => {
                    entry.consumed = true;
                    match answer.gate_answer_for(
                        entry.kind,
                        entry.family.as_deref(),
                        entry.answered_input.as_ref(),
                    ) {
                        GateAnswer::Allow { updated_input } => HostPrompt::Allow {
                            updated_input: updated_input.unwrap_or_else(|| call.tool_input.clone()),
                        },
                        GateAnswer::Deny(reason) => HostPrompt::Deny(reason),
                        GateAnswer::NoOpinion | GateAnswer::Defer => {
                            HostPrompt::Deny(NOT_PUT.into())
                        }
                    }
                }
                State::Cancelled(reason) => {
                    entry.consumed = true;
                    HostPrompt::Deny(reason.model_text().into())
                }
                State::Registered | State::Waiting => HostPrompt::Deny(NOT_PUT.into()),
            };
        }
        let call = GateCall {
            session_id: seat.session_id.clone(),
            ..call.clone()
        };
        match decide(&self.asks, Some(&seat), &call, |_, _| false) {
            Decision::Deny(reason) => HostPrompt::Deny(reason),
            Decision::Argv => HostPrompt::Deny(tool_approval::messages().unlisted.clone()),
            Decision::Ask { .. } | Decision::Allow => HostPrompt::Deny(NOT_PUT.into()),
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

    /// `begin_answer_edited` with no edited draft.
    pub fn begin_answer(
        &self,
        vault: &Path,
        id: &str,
        answer: PersonAnswer,
    ) -> Result<Resume, Refusal> {
        self.begin_answer_edited(vault, id, answer, None, |_, _, _| Ok(()))
    }

    /// Take a person's answer: only from Waiting, in the same vault; a
    /// question card only with its answers, which must fit its questions,
    /// and answers only for a question card (M57.3); and This conversation
    /// only for a table ask whose card offers it (M57.2, M57.4), on a subject
    /// that was not cut. An edited
    /// draft (M57.4b) only with an Allow of a write card, and only once it
    /// fits the tool's schema (`validate_input`) and `check` admits it under
    /// the run's stored request: the caller's re-check of scopes, tool grant,
    /// corpus and the previewed write (M57.4c), which records nothing. A refusal leaves the card waiting.
    /// What comes back is what to resume, and, for an Allow of a write card,
    /// the approval the answer command records.
    pub fn begin_answer_edited(
        &self,
        vault: &Path,
        id: &str,
        answer: PersonAnswer,
        edit: Option<Value>,
        check: impl FnOnce(&AgentRequest, &str, &Value) -> Result<(), Refusal>,
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
        let answered_input = match (entry.kind, &answer) {
            (Kind::Question, PersonAnswer::Answers { answers }) => {
                let set = entry.questions.as_deref().unwrap_or_default();
                let map = question::answers_for(set, answers).map_err(Refusal::malformed)?;
                Some(question::updated_input(&entry.tool_input, map))
            }
            (Kind::Question, PersonAnswer::Allow { .. }) => {
                return Err(Refusal::malformed(ANSWER_THE_QUESTION))
            }
            (_, PersonAnswer::Answers { .. }) => return Err(Refusal::malformed(NOT_A_QUESTION)),
            _ => None,
        };
        if let Some(edited) = &edit {
            if entry.kind != Kind::Write || !matches!(answer, PersonAnswer::Allow { .. }) {
                return Err(Refusal::malformed(EDIT_MISFIT));
            }
            crate::policy::tools::validate_input(&entry.tool_name, edited)
                .map_err(Refusal::malformed)?;
            check(snapshot, &entry.tool_name, edited)?;
        }
        let remembers = matches!(
            answer,
            PersonAnswer::Allow {
                remember: Remember::Conversation
            }
        );
        let offered = entry
            .family
            .as_deref()
            .is_some_and(tool_approval::offers_conversation);
        if remembers && (!offered || entry.subject.is_none()) {
            return Err(Refusal::not_remembered());
        }
        if remembers
            && entry
                .subject
                .as_deref()
                .is_some_and(tool_approval::subject_is_cut)
        {
            return Err(Refusal::not_remembered_cut());
        }
        let approval = (entry.kind == Kind::Write && matches!(answer, PersonAnswer::Allow { .. }))
            .then(|| {
                let approved = edit.clone().unwrap_or_else(|| entry.tool_input.clone());
                WriteApproval {
                    entry: entry.id.clone(),
                    vault: entry.vault.clone(),
                    session_id: entry.session_id.clone(),
                    actor: crate::mcp::normalize_actor(snapshot.actor.as_deref()).to_string(),
                    tool: crate::policy::tools::bare_name(&entry.tool_name).to_string(),
                    asked_hash: canonical_hash(&entry.tool_input),
                    approved_hash: canonical_hash(&approved),
                    edited: changed_keys(&entry.tool_input, &approved),
                    approved_input: approved,
                    at: chrono::Utc::now(),
                    resume_run: None,
                }
            });
        let answer_key = crate::ledger::new_id128();
        let resume = Resume {
            link: AnswerLink {
                book: Arc::downgrade(&self.book),
                id: entry.id.clone(),
                source_run: entry.run_id.clone(),
                session: entry.session_id.clone(),
                vault: entry.vault.clone(),
                answer_key: answer_key.clone(),
                generation_bound: entry.generation_bound,
            },
            id: entry.id.clone(),
            session_id: entry.session_id.clone(),
            vault: entry.vault.clone(),
            snapshot: (**snapshot).clone(),
            approval,
        };
        entry.answer_key = Some(answer_key);
        entry.state = State::Answering(answer);
        // M57.4b: the edited draft is what the resume's gate allows with.
        entry.answered_input = answered_input.or(edit);
        entry.consumed = false;
        entry.resume_run = None;
        Ok(resume)
    }

    /// The resume started under `resume_run`. A This conversation answer is
    /// remembered here, once its resume is under way: the one place a grant
    /// is written (`only_the_answer_command_remembers`).
    pub fn finish_answer(&self, id: &str, resume_run: &str) {
        let mut book = lock(&self.book);
        let mut grant = None;
        if let Some(entry) = book.entries.iter_mut().find(|e| e.id == id) {
            if let State::Answering(answer) = entry.state.clone() {
                if answer
                    == (PersonAnswer::Allow {
                        remember: Remember::Conversation,
                    })
                {
                    if let (Some(family), Some(subject)) = (&entry.family, &entry.subject) {
                        grant = Some((
                            entry.vault.clone(),
                            entry.session_id.clone(),
                            family.clone(),
                            subject.clone(),
                        ));
                    }
                }
                entry.state = State::Answered(answer);
                entry
                    .resume_run
                    .get_or_insert_with(|| resume_run.to_string());
            }
        }
        for approval in book.approvals.iter_mut().filter(|a| a.entry == id) {
            approval
                .resume_run
                .get_or_insert_with(|| resume_run.to_string());
        }
        if let Some((vault, session, family, subject)) = grant {
            book.grants
                .remember_subject(&vault, &session, &family, &subject);
        }
    }

    /// The resume could not start: the card waits again, unless the gate
    /// already read the answer.
    pub fn abort_answer(&self, id: &str) {
        let mut book = lock(&self.book);
        // M57.4: the person answers again, so the Allow goes too.
        book.approvals.retain(|a| a.entry != id);
        if let Some(entry) = book.entries.iter_mut().find(|e| e.id == id) {
            if matches!(entry.state, State::Answering(_)) && !entry.consumed {
                entry.state = State::Waiting;
                entry.answered_input = None;
                entry.resume_run = None;
            }
        }
    }

    /// Cancel a call no one has answered. True when this cancelled it; a
    /// second cancel, or one after an answer, is false.
    pub fn cancel(&self, id: &str, reason: CancelReason) -> bool {
        if self.cancel_managed(id) {
            return true;
        }
        self.cancel_inner(id, reason)
    }
    fn cancel_inner(&self, id: &str, reason: CancelReason) -> bool {
        let mut book = lock(&self.book);
        let Some(entry) = book.entries.iter_mut().find(|e| e.id == id) else {
            return false;
        };
        if !matches!(entry.state, State::Waiting | State::Registered) {
            return false;
        }
        entry.state = State::Cancelled(reason);
        let generation = entry.generation_settlement.clone();
        let session = entry.session_id.clone();
        book.bound(&session);
        drop(book);
        if let Some(generation) = generation {
            generation.cancel_wait();
        }
        true
    }

    /// A vault switch: every waiting call of another vault is refused as not
    /// answered, and every other vault's This conversation grants are
    /// forgotten (M57.2). Returns the cards it cancelled.
    pub fn cancel_other_vaults(&self, vault: &Path) -> Vec<String> {
        let mut book = lock(&self.book);
        let retired_runs: Vec<_> = book
            .seats
            .iter()
            .filter(|(_, seat)| seat.vault != vault)
            .map(|(run, _)| run.clone())
            .collect();
        let managed_cancelled = self.cancel_managed_other_vaults(vault, &retired_runs);
        #[cfg(test)]
        managed_action_wait::probes::after_other_scan();
        book.grants.forget_other_vaults(vault);
        let mut cancelled = Vec::new();
        let mut generations = Vec::new();
        let mut sessions = Vec::new();
        for entry in book.entries.iter_mut() {
            if entry.vault != vault && matches!(entry.state, State::Waiting | State::Registered) {
                entry.state = State::Cancelled(CancelReason::VaultClosed);
                cancelled.push(entry.id.clone());
                generations.extend(entry.generation_settlement.clone());
                sessions.push(entry.session_id.clone());
            }
        }
        for session in sessions {
            book.bound(&session);
        }
        drop(book);
        for generation in generations {
            generation.cancel_wait();
        }
        cancelled.extend(managed_cancelled);
        cancelled
    }

    /// Selected opening keeps no legacy conversation authority. Revoke seats
    /// before their exiting hooks can register more calls, and detach unfinished
    /// resumes so close_seat cannot put their cancelled calls back in Waiting.
    /// A consumed answer remains historical; unused dispatch approvals do not.
    pub(super) fn cancel_all(&self) {
        let mut book = lock(&self.book);
        book.seats.clear();
        self.cancel_managed_all();
        #[cfg(test)]
        managed_action_wait::probes::after_all_scan();
        book.grants = ConversationGrants::default();
        book.approvals.clear();
        let mut sessions = HashSet::new();
        let mut generations = Vec::new();
        for entry in &mut book.entries {
            if entry.consumed {
                // The hook already delivered this answer. Finalize that
                // history without minting a conversation grant: a command's
                // late finish_answer must not recreate retired authority.
                if let State::Answering(answer) = entry.state.clone() {
                    entry.state = State::Answered(answer);
                }
            } else {
                generations.extend(entry.generation_settlement.clone());
                if !matches!(entry.state, State::Cancelled(_)) {
                    entry.state = State::Cancelled(CancelReason::VaultClosed);
                }
                entry.resume_run = None;
                entry.answered_input = None;
                sessions.insert(entry.session_id.clone());
            }
        }
        for session in sessions {
            book.bound(&session);
        }
        drop(book);
        for generation in generations {
            generation.cancel_wait();
        }
    }

    /// Record a person's Allow of a write (M57.4): the one writer of the
    /// approvals dispatch takes, called only by the answer command with the
    /// approval its `begin_answer` built. A second Allow of the same card
    /// replaces the first.
    pub fn record_write_approval(&self, approval: WriteApproval) {
        let mut book = lock(&self.book);
        // The native command can pause after begin_answer_edited. Validate
        // against that still-current answer under this same lock before
        // replacing anything: retirement or a new edit invalidates its copy.
        let current = book.entries.iter().any(|entry| {
            if entry.id != approval.entry
                || entry.vault != approval.vault
                || entry.session_id != approval.session_id
                || entry.kind != Kind::Write
                || !matches!(entry.state, State::Answering(PersonAnswer::Allow { .. }))
                || crate::policy::tools::bare_name(&entry.tool_name) != approval.tool
                || !entry.snapshot.as_ref().is_some_and(|snapshot| {
                    crate::mcp::normalize_actor(snapshot.actor.as_deref()) == approval.actor
                })
            {
                return false;
            }
            let approved = entry.answered_input.as_ref().unwrap_or(&entry.tool_input);
            canonical_hash(&entry.tool_input) == approval.asked_hash
                && canonical_hash(approved) == approval.approved_hash
                && approved == &approval.approved_input
        });
        if !current {
            return;
        }
        book.approvals.retain(|a| a.entry != approval.entry);
        book.approvals.push(approval);
    }

    /// Take the approval for this write (M57.4): one recorded in the vault,
    /// Claude Code session and actor of `grant`'s seat, for this tool, whose
    /// asked or approved input this call carries (M57.4b: Claude Code may or
    /// may not apply the person's edit on a resumed allow), at most
    /// APPROVAL_MINUTES old at `now`. It gives the approved input, which is
    /// what dispatch runs, and the keys the person changed. Used once: a
    /// taken approval is gone, and so is every expired one. None with no
    /// seat, so a run nobody watches has none to take.
    pub fn take_write_approval_at(
        &self,
        grant: &crate::mcp::RunGrant,
        tool: &str,
        args: &Value,
        now: chrono::DateTime<chrono::Utc>,
    ) -> Option<ApprovedWrite> {
        let mut book = lock(&self.book);
        let limit = chrono::Duration::minutes(tool_approval::APPROVAL_MINUTES);
        book.approvals.retain(|a| now - a.at <= limit);
        let seat = book.seats.get(&grant.run_id)?;
        let session = seat.session_id.clone();
        let vault = seat.vault.clone();
        if grant
            .vault
            .as_deref()
            .is_none_or(|bound| super::vault_key(bound) != vault)
        {
            return None;
        }
        let tool = crate::policy::tools::bare_name(tool).to_string();
        let hash = canonical_hash(args);
        let at = book.approvals.iter().position(|a| {
            a.vault == vault
                && a.session_id == session
                && a.actor == grant.actor
                && a.tool == tool
                && (a.approved_hash == hash || a.asked_hash == hash)
        })?;
        let taken = book.approvals.remove(at);
        Some(ApprovedWrite {
            input: taken.approved_input,
            edited: taken.edited,
        })
    }

    /// `take_write_approval_at`, now.
    pub fn take_write_approval(
        &self,
        grant: &crate::mcp::RunGrant,
        tool: &str,
        args: &Value,
    ) -> Option<ApprovedWrite> {
        self.take_write_approval_at(grant, tool, args, chrono::Utc::now())
    }

    /// The decision a seated run's plan holds for cerebro tool `tool`
    /// (M57.4), the plan its argv was built from; None for a run with no
    /// seat, or a tool the plan does not decide.
    pub fn planned(&self, run_id: &str, tool: &str) -> Option<tool_approval::Decision> {
        let book = lock(&self.book);
        let seat = book.seats.get(run_id)?;
        let name = format!(
            "{}{}",
            super::MCP_PREFIX,
            crate::policy::tools::bare_name(tool)
        );
        seat.approval.decision_of(&name).map(|row| row.decision)
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
        let mut cards: Vec<_> = waiting.into_iter().map(Entry::card).collect();
        drop(book);
        cards.extend(self.managed_pending(vault));
        cards.sort_by(|a, b| a.asked_at.cmp(&b.asked_at));
        cards
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
        PersonAnswer::from_ipc(WireAnswer::Allow {
            remember: Remember::Once,
        })
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
            decide(&[], Some(&s), &call("s-1", "t1", ASKED), |_, _| false),
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
        assert_eq!(
            plan.asks,
            [ASKED, "AskUserQuestion", "ExitPlanMode", "EnterPlanMode"]
        );
        assert_eq!(plan.settle.as_deref(), Some("mcp__cerebro__edit_note"));
        // M91.2b: the subagent tool the seat's plan holds follows, by both
        // its names, for the gate to inspect.
        assert_eq!(plan.inspects, ["Agent", "Task"]);
        assert_eq!(
            plan.matcher(),
            [
                ASKED,
                "AskUserQuestion",
                "ExitPlanMode",
                "EnterPlanMode",
                "mcp__cerebro__edit_note",
                "Agent",
                "Task"
            ]
        );
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
            &hook_settings(
                &[ASKED.into(), "mcp__cerebro__edit_note".into()],
                serde_json::Map::new(),
            )
            .unwrap(),
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
        assert!(hook_settings(&[], serde_json::Map::new()).is_err());
    }

    // M91.2b: the hook joins the run's own settings, the hardening and the
    // environment every run but an internal one carries, in one file, and
    // never stands beside hooks it did not write.
    #[test]
    fn the_hook_joins_the_runs_settings() {
        let base = json!({
            "permissions": { "disableBypassPermissionsMode": "disable" },
            "disableAutoMode": "disable",
            "env": { "CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH": "1" },
        });
        let Value::Object(base) = base else {
            unreachable!()
        };
        let written: Value =
            serde_json::from_str(&hook_settings(&["Agent".into()], base.clone()).unwrap()).unwrap();
        for (key, value) in &base {
            assert_eq!(&written[key], value, "{key}");
        }
        assert_eq!(written["hooks"]["PreToolUse"][0]["matcher"], "Agent");
        assert_eq!(written.as_object().unwrap().len(), base.len() + 1);
        let mut hooked = base;
        hooked.insert("hooks".into(), json!({}));
        assert!(hook_settings(&["Agent".into()], hooked).is_err());
    }

    #[test]
    fn a_name_outside_the_matcher_grammar_is_refused() {
        for bad in ["a|b", "mcp__x.*", "Bash(rm *)", "a b", "", "é"] {
            assert!(
                hook_settings(&[bad.into()], serde_json::Map::new()).is_err(),
                "{bad:?}"
            );
        }
        assert!(hook_settings(
            &["Bash".into(), "mcp__a-b__c_d9".into()],
            serde_json::Map::new()
        )
        .is_ok());
    }

    /// A main-thread call to the subagent tool, spelled `tool`, starting
    /// `subagent_type` (left out when None).
    fn agent_call(id: &str, tool: &str, subagent_type: Option<&str>) -> GateCall {
        let mut input = json!({ "description": "Read the plan", "prompt": "Summarize it." });
        if let Some(subagent_type) = subagent_type {
            input["subagent_type"] = json!(subagent_type);
        }
        GateCall {
            session_id: "s-1".into(),
            tool_use_id: id.into(),
            tool_name: tool.into(),
            tool_input: input,
            agent_id: String::new(),
        }
    }

    // M91.2b: the gate holds a seated run's subagent calls to the types its
    // plan allows: an allowed one gets no opinion, never an allow, so argv's
    // denials still bind; any other type, or none, is denied with the ones
    // it may start; a subagent's own call is refused as before.
    #[test]
    fn a_subagent_starts_only_as_an_allowed_type() {
        let book = Interactions::with_asks(Vec::new());
        book.open_seat(seat("run-1", "s-1", "/v"), None);
        let allowed = tool_approval::table().agent_types.allowed.clone();
        assert_eq!(allowed, ["cerebro-researcher"]);
        let refused = AGENT_TYPE_REFUSED.replace("{types}", "cerebro-researcher");
        assert!(refused.starts_with(
            "This conversation may start only these subagent types: cerebro-researcher."
        ));
        for tool in ["Agent", "Task"] {
            assert_eq!(
                book.gate("run-1", &agent_call("t1", tool, Some("cerebro-researcher"))),
                GateAnswer::NoOpinion,
                "{tool}"
            );
            for odd in [Some("general-purpose"), Some("gsd-planner"), Some(""), None] {
                assert_eq!(
                    book.gate("run-1", &agent_call("t2", tool, odd)),
                    GateAnswer::Deny(refused.clone()),
                    "{tool} {odd:?}"
                );
            }
            let mut sub = agent_call("t3", tool, Some("cerebro-researcher"));
            sub.agent_id = "a0000000000000001".into();
            assert_eq!(book.gate("run-1", &sub), GateAnswer::Deny(MAIN_ONLY.into()));
        }
        assert!(lock(&book.book).entries.is_empty(), "nothing registered");
        // Another tool is no subagent's start, whatever its input says.
        let mut other = agent_call("t4", "mcp__cerebro__get_note", Some("x"));
        other.tool_input["path"] = json!("a.md");
        assert_eq!(book.gate("run-1", &other), GateAnswer::NoOpinion);
    }

    // M91.2b: with the Subagents switch off, the plan denies the tool in
    // the table's words, and its gate never inspects it.
    #[test]
    fn with_the_switch_off_the_gate_denies_the_tool_and_inspects_nothing() {
        let mut req = request();
        req.delegate = Some(tool_approval::DelegateCeiling::Off);
        let book = Interactions::with_asks(Vec::new());
        book.open_seat(Seat::new("run-1", "s-1", Path::new("/v"), &req), None);
        let plan = book.ask_plan("run-1", &[], Some("2.1.250"));
        assert!(plan.inspects.is_empty());
        assert!(!plan.matcher().iter().any(|t| t == "Agent" || t == "Task"));
        assert_eq!(
            book.gate(
                "run-1",
                &agent_call("t1", "Agent", Some("cerebro-researcher"))
            ),
            GateAnswer::Deny(tool_approval::messages().denied.clone())
        );
        // On, the same seat inspects it by both names.
        let book = Interactions::with_asks(Vec::new());
        book.open_seat(seat("run-1", "s-1", "/v"), None);
        assert_eq!(
            book.ask_plan("run-1", &[], Some("2.1.250")).inspects,
            ["Agent", "Task"]
        );
    }

    // M91.2b: a plan that holds the tool but names no type refuses every
    // start in its own words.
    #[test]
    fn a_plan_with_no_type_refuses_every_start() {
        let mut approval = tool_approval::plan_for(&request(), true);
        approval.allowed_agent_types.clear();
        assert_eq!(
            agent_type_refusal(
                &approval,
                &agent_call("t1", "Agent", Some("cerebro-researcher"))
            ),
            Some(NO_AGENT_TYPE.to_string())
        );
        approval.allowed_agent_types = vec!["a".into(), "b".into()];
        assert_eq!(
            agent_type_refusal(&approval, &agent_call("t1", "Task", Some("c"))),
            Some(AGENT_TYPE_REFUSED.replace("{types}", "a, b"))
        );
        assert_eq!(
            agent_type_refusal(&approval, &agent_call("t1", "Task", Some("b"))),
            None
        );
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
            assert_eq!(
                book.ask_plan("run-1", &granted, Some(new)).asks,
                [ASKED, "AskUserQuestion", "ExitPlanMode", "EnterPlanMode"]
            );
        }
        // A run with no seat asks nothing; one that holds none of the debug
        // asks still meets the gate for its plan's question ask (M57.3) and
        // its refusal (M57.2).
        assert!(book.ask_plan("other", &granted, Some("2.1.250")).is_empty());
        assert_eq!(
            book.ask_plan("run-1", &["mcp__cerebro__get_note".into()], Some("2.1.250"))
                .asks,
            ["AskUserQuestion", "ExitPlanMode", "EnterPlanMode"]
        );
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

    // --- M57.2: the table decides, and This conversation ---------------------

    /// A seat whose run is under the shell ceiling `shell`.
    fn seat_under(shell: &str, run: &str, session: &str, vault: &str) -> Seat {
        let mut req = request();
        req.shell = Some(tool_approval::ShellCeiling::read(&json!(shell)));
        Seat::new(run, session, Path::new(vault), &req)
    }

    fn bash(session: &str, id: &str, command: &str) -> GateCall {
        GateCall {
            session_id: session.into(),
            tool_use_id: id.into(),
            tool_name: "Bash".into(),
            tool_input: json!({ "command": command, "description": "check" }),
            agent_id: String::new(),
        }
    }

    fn named_call(session: &str, id: &str, tool: &str, input: Value) -> GateCall {
        GateCall {
            session_id: session.into(),
            tool_use_id: id.into(),
            tool_name: tool.into(),
            tool_input: input,
            agent_id: String::new(),
        }
    }

    /// Run `run` in `session` asks for `command`, the stream confirms it, and
    /// the run ends: the card.
    fn asked(
        book: &Interactions,
        run: &str,
        session: &str,
        id: &str,
        command: &str,
    ) -> InteractionCard {
        book.open_seat(seat_under("ask", run, session, "/v"), None);
        assert_eq!(
            book.gate(run, &bash(session, id, command)),
            GateAnswer::Defer
        );
        let card = book.confirm(session, id).expect("a card");
        book.close_seat(run);
        card
    }

    fn conversation() -> PersonAnswer {
        PersonAnswer::from_ipc(WireAnswer::Allow {
            remember: Remember::Conversation,
        })
    }

    #[test]
    fn the_host_answers_from_the_table() {
        let book = Interactions::with_asks(Vec::new());
        book.open_seat(seat_under("ask", "run-1", "s-1", "/v"), None);
        assert_eq!(
            book.gate("run-1", &bash("s-1", "t1", "git status")),
            GateAnswer::Defer
        );
        let card = book.confirm("s-1", "t1").unwrap();
        assert_eq!(card.family.as_deref(), Some("shell"));
        assert_eq!(card.subject.as_deref(), Some("git status"));
        let plan = tool_approval::table().family("plan").unwrap();
        assert_eq!(
            book.gate("run-1", &named_call("s-1", "t2", "ExitPlanMode", json!({}))),
            GateAnswer::Deny(plan.message.clone().unwrap())
        );
        // M57.3: a question asks, and one no card can show is refused.
        assert_eq!(
            book.gate(
                "run-1",
                &named_call("s-1", "t2", "AskUserQuestion", json!({}))
            ),
            GateAnswer::Deny(tool_approval::question_malformed(
                "A question set holds 1 to 4 questions; this one holds 0."
            ))
        );
        for tool in ["Read", "mcp__cerebro__get_note", "mcp__toy__echo"] {
            assert_eq!(
                book.gate(
                    "run-1",
                    &named_call("s-1", "t3", tool, json!({ "file_path": "a" }))
                ),
                GateAnswer::NoOpinion,
                "{tool}"
            );
        }
        // Under On the shell is pre-approved, so the host has no opinion.
        book.open_seat(seat_under("on", "run-2", "s-2", "/v"), None);
        assert_eq!(
            book.gate("run-2", &bash("s-2", "t1", "ls")),
            GateAnswer::NoOpinion
        );
    }

    #[test]
    fn a_deny_of_a_table_ask_says_the_person_said_no() {
        let book = Interactions::with_asks(Vec::new());
        let card = asked(&book, "run-1", "s-1", "t1", "rm -rf build");
        let resume = book
            .begin_answer(Path::new("/v"), &card.id, deny("not now"))
            .unwrap();
        book.open_seat(seat_under("ask", "run-2", &resume.session_id, "/v"), None);
        book.finish_answer(&card.id, "run-2");
        let person_denied = &tool_approval::messages().person_denied;
        assert_eq!(
            book.gate("run-2", &bash("s-1", "t1", "rm -rf build")),
            GateAnswer::Deny(format!("{person_denied} They said: not now"))
        );
    }

    #[test]
    fn this_conversation_is_per_vault_and_session() {
        let book = Interactions::with_asks(Vec::new());
        let card = asked(&book, "run-1", "s-1", "t1", "git status");
        book.begin_answer(Path::new("/v"), &card.id, conversation())
            .unwrap();
        book.open_seat(seat_under("ask", "run-2", "s-1", "/v"), None);
        book.finish_answer(&card.id, "run-2");
        // The answered call reads its allow, and the next one like it in
        // this conversation runs with no card.
        assert!(matches!(
            book.gate("run-2", &bash("s-1", "t1", "git status")),
            GateAnswer::Allow { .. }
        ));
        assert!(matches!(
            book.gate("run-2", &bash("s-1", "t2", "git status")),
            GateAnswer::Allow { .. }
        ));
        // Another command asks.
        assert_eq!(
            book.gate("run-2", &bash("s-1", "t3", "git push")),
            GateAnswer::Defer
        );
        // Another session asks, and so does the same session in another vault.
        book.open_seat(seat_under("ask", "run-3", "s-9", "/v"), None);
        assert_eq!(
            book.gate("run-3", &bash("s-9", "t1", "git status")),
            GateAnswer::Defer
        );
        book.open_seat(seat_under("ask", "run-4", "s-1", "/w"), None);
        assert_eq!(
            book.gate("run-4", &bash("s-1", "t9", "git status")),
            GateAnswer::Defer
        );
    }

    #[test]
    fn allow_once_remembers_nothing() {
        let book = Interactions::with_asks(Vec::new());
        let card = asked(&book, "run-1", "s-1", "t1", "git status");
        book.begin_answer(Path::new("/v"), &card.id, allow())
            .unwrap();
        book.open_seat(seat_under("ask", "run-2", "s-1", "/v"), None);
        book.finish_answer(&card.id, "run-2");
        assert_eq!(
            book.gate("run-2", &bash("s-1", "t2", "git status")),
            GateAnswer::Defer
        );
    }

    #[test]
    fn conversation_is_refused_for_a_request_that_does_not_ask() {
        // A debug-override ask names no family: nothing to remember.
        let book = book();
        let card = waiting(&book);
        assert_eq!(card.family, None);
        let refused = book
            .begin_answer(Path::new("/v"), &card.id, conversation())
            .unwrap_err();
        assert_eq!(refused.code, MALFORMED_ARGUMENTS);
        assert_eq!(refused.message, NOT_REMEMBERED);
        // The card still waits for an answer it can take.
        assert_eq!(book.pending(Path::new("/v")).len(), 1);
        assert!(book
            .begin_answer(Path::new("/v"), &card.id, allow())
            .is_ok());
    }

    #[test]
    fn conversation_is_refused_for_a_cut_subject() {
        // A command past SUBJECT_CHARS shows only its prefix: a grant on that
        // text would cover any command sharing it, so only Allow once goes.
        let book = Interactions::with_asks(Vec::new());
        let long = format!("{}; echo benign", "x".repeat(tool_approval::SUBJECT_CHARS));
        let card = asked(&book, "run-1", "s-1", "t1", &long);
        assert!(tool_approval::subject_is_cut(
            card.subject.as_deref().unwrap()
        ));
        let refused = book
            .begin_answer(Path::new("/v"), &card.id, conversation())
            .unwrap_err();
        assert_eq!(refused.code, MALFORMED_ARGUMENTS);
        assert_eq!(refused.message, NOT_REMEMBERED_CUT);
        assert!(book
            .begin_answer(Path::new("/v"), &card.id, allow())
            .is_ok());
        // The store never holds nor matches a cut subject, whoever writes it.
        let mut grants = ConversationGrants::default();
        let cut = card.subject.unwrap();
        grants.remember_subject(Path::new("/v"), "s-1", "shell", &cut);
        assert!(grants.sessions.is_empty());
        assert!(!grants.covers(Path::new("/v"), "s-1", "shell", &cut));
    }

    #[test]
    fn a_vault_switch_forgets_other_vaults_grants() {
        let book = Interactions::with_asks(Vec::new());
        let card = asked(&book, "run-1", "s-1", "t1", "git status");
        book.begin_answer(Path::new("/v"), &card.id, conversation())
            .unwrap();
        book.finish_answer(&card.id, "run-2");
        assert!(lock(&book.book)
            .grants
            .covers(Path::new("/v"), "s-1", "shell", "git status"));
        book.cancel_other_vaults(Path::new("/v"));
        assert!(lock(&book.book)
            .grants
            .covers(Path::new("/v"), "s-1", "shell", "git status"));
        book.cancel_other_vaults(Path::new("/w"));
        assert!(!lock(&book.book)
            .grants
            .covers(Path::new("/v"), "s-1", "shell", "git status"));
    }

    #[test]
    fn the_grant_store_stays_bounded() {
        let mut grants = ConversationGrants::default();
        let vault = Path::new("/v");
        for n in 0..=GRANT_SESSIONS {
            grants.remember_subject(vault, &format!("s-{n}"), "shell", "ls");
        }
        assert_eq!(grants.sessions.len(), GRANT_SESSIONS);
        assert!(
            !grants.covers(vault, "s-0", "shell", "ls"),
            "the oldest went"
        );
        assert!(grants.covers(vault, &format!("s-{GRANT_SESSIONS}"), "shell", "ls"));
        for n in 0..=GRANT_SUBJECTS {
            grants.remember_subject(vault, "busy", "shell", &format!("cmd {n}"));
        }
        let busy = grants
            .sessions
            .iter()
            .find(|s| s.session_id == "busy")
            .unwrap();
        assert_eq!(busy.subjects.len(), GRANT_SUBJECTS);
        assert!(!grants.covers(vault, "busy", "shell", "cmd 0"));
        // Remembering one again moves it to the back, never twice.
        grants.remember_subject(vault, "busy", "shell", "cmd 5");
        let busy = grants
            .sessions
            .iter()
            .find(|s| s.session_id == "busy")
            .unwrap();
        assert_eq!(busy.subjects.len(), GRANT_SUBJECTS);
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
            // Exact cfg(test)-owned fixture files may exercise the existing
            // parser/control values. No production file gains mint permission.
            let fixture_owner = match name.as_str() {
                "agent/managed_action_wait_tests.rs" => Some((
                    "agent/managed_action_wait.rs",
                    "#[cfg(test)]#[path=\"managed_action_wait_tests.rs\"]modtests;",
                )),
                "actions/native_chat_generation_tests.rs" => Some((
                    "actions/native_chat_generation.rs",
                    "#[cfg(test)]#[path=\"native_chat_generation_tests.rs\"]modtests;",
                )),
                _ => None,
            };
            if let Some((owner, expected)) = fixture_owner {
                let owner = &sources.iter().find(|(name, _)| name == owner).unwrap().1;
                let compact: String = owner.split_whitespace().collect();
                assert!(
                    compact.contains(expected),
                    "{name} must have its exact cfg(test) source owner"
                );
            }
            let mints = body.matches("PersonAnswer::from_ipc(").count();
            match name.as_str() {
                "lib.rs" => assert_eq!(mints, 1, "the answer command mints it once"),
                "agent/interaction.rs" => {}
                _ if fixture_owner.is_some() => {}
                _ => assert_eq!(mints, 0, "{name} mints a person's answer"),
            }
            if name != "agent/interaction.rs" && fixture_owner.is_none() {
                for built in [
                    "PersonAnswer::Allow",
                    "PersonAnswer::Deny",
                    "PersonAnswer::Answers",
                ] {
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
    fn only_the_answer_command_remembers() {
        let sources = sources();
        for (name, body) in &sources {
            let writes = body.matches("remember_subject(").count();
            match name.as_str() {
                // Its definition, and its one call, in finish_answer.
                "agent/interaction.rs" => {
                    assert_eq!(writes, 2, "one writer, called once");
                    let call = body.rfind(".remember_subject(").unwrap();
                    let owner = body[..call].rfind("pub fn ").unwrap();
                    assert!(body[owner..].starts_with("pub fn finish_answer("));
                }
                _ => assert_eq!(writes, 0, "{name} writes a grant"),
            }
            let finishes = body.matches(".finish_answer(").count();
            match name.as_str() {
                "lib.rs" => assert_eq!(finishes, 1, "only the answer command"),
                _ => assert_eq!(finishes, 0, "{name} finishes an answer"),
            }
        }
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

    // --- Questions (M57.3) ---------------------------------------------------

    const QUESTION: &str = "AskUserQuestion";

    fn questions() -> Value {
        json!({ "questions": [
            { "question": "Which format?", "header": "Format", "multiSelect": false,
              "options": [ { "label": "Markdown", "description": "Headings and lists" },
                           { "label": "Plain text", "description": "No markup" } ] },
            { "question": "Which sections?", "header": "Sections", "multiSelect": true,
              "options": [ { "label": "Summary", "description": "" },
                           { "label": "Risks", "description": "" },
                           { "label": "Next steps", "description": "", "preview": "<b>x</b>" } ] }
        ] })
    }

    fn answers(format: &[&str], sections: &[&str]) -> PersonAnswer {
        let wire: WireAnswer = serde_json::from_value(json!({
            "kind": "answers",
            "answers": [
                { "question": "Which format?", "picked": format, "other": null },
                { "question": "Which sections?", "picked": sections }
            ]
        }))
        .unwrap();
        PersonAnswer::from_ipc(wire)
    }

    /// A panel run asks its questions, the stream confirms them, and the run
    /// ends: the question card.
    fn question_card(book: &Interactions) -> InteractionCard {
        book.open_seat(seat("run-1", "s-1", "/v"), None);
        assert_eq!(
            book.gate("run-1", &named_call("s-1", "t1", QUESTION, questions())),
            GateAnswer::Defer
        );
        let card = book.confirm("s-1", "t1").expect("a question card");
        book.close_seat("run-1");
        card
    }

    /// Answer `card` with `answer`, start its resume as run-2, and read what
    /// the resumed call's gate says.
    fn resumed_with(
        book: &Interactions,
        card: &InteractionCard,
        answer: PersonAnswer,
    ) -> GateAnswer {
        book.begin_answer(Path::new("/v"), &card.id, answer)
            .expect("the answer is taken");
        book.open_seat(seat("run-2", "s-1", "/v"), None);
        book.finish_answer(&card.id, "run-2");
        book.gate("run-2", &named_call("s-1", "t1", QUESTION, questions()))
    }

    #[test]
    fn a_question_registers_with_its_parsed_set() {
        let book = Interactions::with_asks(Vec::new());
        let card = question_card(&book);
        assert_eq!(card.kind, Kind::Question);
        assert_eq!(card.family.as_deref(), Some("question"));
        let set = card.questions.clone().expect("the parsed questions");
        assert_eq!(set.len(), 2);
        assert!(set[1].multi_select);
        assert_eq!(set[1].options[2].preview.as_deref(), Some("<b>x</b>"));
        let wire = serde_json::to_value(&card).unwrap();
        assert_eq!(wire["kind"], "question");
        assert_eq!(wire["questions"][0]["multiSelect"], false);
        // A permission card carries no questions key at all.
        let book = Interactions::with_asks(Vec::new());
        let permission = asked(&book, "run-1", "s-1", "t1", "git status");
        assert!(serde_json::to_value(&permission)
            .unwrap()
            .get("questions")
            .is_none());
    }

    #[test]
    fn a_malformed_question_is_refused_and_never_shown() {
        let book = Interactions::with_asks(Vec::new());
        book.open_seat(seat("run-1", "s-1", "/v"), None);
        let one_option = json!({ "questions": [
            { "question": "Which release?", "options": [ { "label": "1.4" } ] }
        ] });
        let answer = book.gate("run-1", &named_call("s-1", "t1", QUESTION, one_option));
        assert_eq!(
            answer,
            GateAnswer::Deny(
                "Cerebro couldn't show this question (\"Which release?\" offers 1 options; a \
                 question offers 2 to 4). Ask again with 1 to 4 questions, each with 2 to 4 \
                 distinct options."
                    .into()
            )
        );
        assert!(lock(&book.book).entries.is_empty(), "nothing registered");
        assert!(book.confirm("s-1", "t1").is_none());
        assert!(book.pending(Path::new("/v")).is_empty());
    }

    #[test]
    fn an_answered_question_allows_with_its_answers() {
        let book = Interactions::with_asks(Vec::new());
        let card = question_card(&book);
        let answer = resumed_with(&book, &card, answers(&["Markdown"], &["Summary", "Risks"]));
        let GateAnswer::Allow {
            updated_input: Some(input),
        } = &answer
        else {
            panic!("an allow with the answers: {answer:?}");
        };
        assert_eq!(
            input["answers"],
            json!({ "Which format?": "Markdown", "Which sections?": "Summary, Risks" })
        );
        assert_eq!(
            serde_json::to_string(&input["questions"]).unwrap(),
            serde_json::to_string(&questions()["questions"]).unwrap()
        );
        assert_eq!(
            answer.hook_json()["hookSpecificOutput"]["updatedInput"]["answers"]["Which format?"],
            "Markdown"
        );
        // The prompt tool reads the same answer for the same call.
        let prompt = book.host_prompt(
            "run-2",
            &GateCall::from_prompt_args(
                json!({ "tool_name": QUESTION, "tool_use_id": "t1", "input": questions() })
                    .as_object()
                    .unwrap(),
            ),
        );
        assert_eq!(
            prompt,
            HostPrompt::Allow {
                updated_input: input.clone()
            }
        );
        assert_eq!(prompt.prompt_json()["behavior"], "allow");
    }

    #[test]
    fn a_wrong_answer_is_malformed_and_the_card_stays() {
        let book = Interactions::with_asks(Vec::new());
        let card = question_card(&book);
        for (answer, words) in [
            (
                answers(&["HTML"], &["Risks"]),
                "\"HTML\" is not an option of \"Which format?\".",
            ),
            (
                answers(&["Markdown"], &[]),
                "Answer every question: \"Which sections?\" has no answer.",
            ),
            (
                answers(&["Markdown", "Plain text"], &["Risks"]),
                "\"Which format?\" takes one answer.",
            ),
        ] {
            let refused = book
                .begin_answer(Path::new("/v"), &card.id, answer)
                .unwrap_err();
            assert_eq!(refused.code, MALFORMED_ARGUMENTS);
            assert_eq!(refused.message, words);
            assert_eq!(
                book.pending(Path::new("/v")).len(),
                1,
                "the card still waits"
            );
        }
        // Answers to a card that asks no question are refused too.
        let book = Interactions::with_asks(Vec::new());
        let permission = asked(&book, "run-1", "s-1", "t1", "git status");
        let refused = book
            .begin_answer(
                Path::new("/v"),
                &permission.id,
                answers(&["Markdown"], &["Risks"]),
            )
            .unwrap_err();
        assert_eq!(
            (refused.code, refused.message.as_str()),
            (MALFORMED_ARGUMENTS, NOT_A_QUESTION)
        );
    }

    #[test]
    fn declining_tells_the_model_to_decide() {
        let declined = &tool_approval::messages().question_declined;
        let book = Interactions::with_asks(Vec::new());
        let card = question_card(&book);
        assert_eq!(
            resumed_with(&book, &card, deny("use your judgement")),
            GateAnswer::Deny(format!("{declined} They said: use your judgement"))
        );
        let book = Interactions::with_asks(Vec::new());
        let card = question_card(&book);
        let bare = PersonAnswer::from_ipc(WireAnswer::Deny { message: None });
        assert_eq!(
            resumed_with(&book, &card, bare),
            GateAnswer::Deny(declined.clone())
        );
        assert!(declined.starts_with("The person chose not to answer"));
    }

    #[test]
    fn plain_allow_does_not_answer_a_question() {
        let book = Interactions::with_asks(Vec::new());
        let card = question_card(&book);
        for answer in [allow(), conversation()] {
            let refused = book
                .begin_answer(Path::new("/v"), &card.id, answer)
                .unwrap_err();
            assert_eq!(
                (refused.code, refused.message.as_str()),
                (MALFORMED_ARGUMENTS, ANSWER_THE_QUESTION)
            );
        }
        assert_eq!(
            book.pending(Path::new("/v")).len(),
            1,
            "the card still waits"
        );
    }

    #[test]
    fn the_prompt_tool_allows_only_a_persons_answer() {
        let book = Interactions::with_asks(Vec::new());
        let prompt = |run: &str, tool: &str, id: &str, input: Value| {
            book.host_prompt(
                run,
                &GateCall::from_prompt_args(
                    json!({ "tool_name": tool, "tool_use_id": id, "input": input })
                        .as_object()
                        .unwrap(),
                ),
            )
        };
        assert_eq!(
            prompt("nobody", QUESTION, "t1", questions()),
            HostPrompt::Deny(NOBODY_WATCHING.into())
        );
        book.open_seat(seat_under("ask", "run-1", "s-1", "/v"), None);
        // An ask no person answered, a waiting one, a pass and a refusal.
        assert_eq!(
            prompt("run-1", "Bash", "t1", json!({ "command": "ls" })),
            HostPrompt::Deny(NOT_PUT.into())
        );
        book.gate("run-1", &named_call("s-1", "t2", QUESTION, questions()));
        assert_eq!(
            prompt("run-1", QUESTION, "t2", questions()),
            HostPrompt::Deny(NOT_PUT.into())
        );
        assert_eq!(
            prompt("run-1", "Read", "t3", json!({ "file_path": "/etc/hosts" })),
            HostPrompt::Deny(tool_approval::messages().unlisted.clone())
        );
        let plan = tool_approval::table().family("plan").unwrap();
        assert_eq!(
            prompt("run-1", "ExitPlanMode", "t4", json!({})),
            HostPrompt::Deny(plan.message.clone().unwrap())
        );
        // The person's Allow of a command runs it as asked.
        let book = Interactions::with_asks(Vec::new());
        let card = asked(&book, "run-1", "s-1", "t1", "git status");
        book.begin_answer(Path::new("/v"), &card.id, allow())
            .unwrap();
        book.open_seat(seat_under("ask", "run-2", "s-1", "/v"), None);
        book.finish_answer(&card.id, "run-2");
        let input = json!({ "command": "git status", "description": "check" });
        assert_eq!(
            book.host_prompt(
                "run-2",
                &GateCall::from_prompt_args(
                    json!({ "tool_name": "Bash", "tool_use_id": "t1", "input": input })
                        .as_object()
                        .unwrap()
                )
            ),
            HostPrompt::Allow {
                updated_input: input.clone()
            }
        );
        assert_eq!(
            HostPrompt::Deny("no".into()).prompt_json(),
            json!({ "behavior": "deny", "message": "no" })
        );
    }

    // --- Ask-first writes (M57.4) -------------------------------------------

    const CREATE: &str = "mcp__cerebro__create_note";

    fn draft() -> Value {
        json!({ "folder": "records/risks", "slug": "vendor-delay", "body": "# Vendor delay\n" })
    }

    fn ask_first_seat(run: &str, session: &str) -> Seat {
        let mut req = request();
        req.actor = Some("process:release-scout".into());
        req.ask_first = Some(true);
        Seat::new(run, session, Path::new("/v"), &req)
    }

    fn scout_grant(run: &str) -> crate::mcp::RunGrant {
        crate::mcp::RunGrant {
            actor: "process:release-scout".into(),
            run_id: run.into(),
            scope: None,
            read_scope: None,
            tools: None,
            chain: vec!["process:release-scout".into()],
            vault: Some(PathBuf::from("/v")),
            asks: crate::mcp::WriteAsks {
                kind: tool_approval::RunKind::Attended,
                ask_first: true,
            },
        }
    }

    /// An ask-first run asks to create a note, the stream confirms it, the
    /// run ends, and the person allows it: the approval the answer command
    /// records, and the resume run seated on the same session.
    fn allowed_write(book: &Interactions) -> WriteApproval {
        book.open_seat(ask_first_seat("run-1", "s-1"), None);
        assert_eq!(
            book.gate("run-1", &named_call("s-1", "t1", CREATE, draft())),
            GateAnswer::Defer
        );
        let card = book.confirm("s-1", "t1").expect("a write card");
        assert_eq!(card.kind, Kind::Write);
        assert_eq!(card.family.as_deref(), Some("confirmable"));
        assert_eq!(card.title.as_deref(), Some("Create a note"));
        assert_eq!(card.target.as_deref(), Some("records/risks"));
        book.close_seat("run-1");
        let resume = book
            .begin_answer(Path::new("/v"), &card.id, allow())
            .unwrap();
        let approval = resume
            .approval
            .expect("an Allow of a write carries an approval");
        book.record_write_approval(approval.clone());
        book.open_seat(ask_first_seat("run-2", "s-1"), None);
        book.finish_answer(&card.id, "run-2");
        approval
    }

    #[test]
    fn an_ask_first_write_draws_a_write_card() {
        let book = Interactions::with_asks(Vec::new());
        allowed_write(&book);
        // The resumed call reads the Allow at the gate.
        assert_eq!(
            book.gate("run-2", &named_call("s-1", "t1", CREATE, draft())),
            GateAnswer::Allow {
                updated_input: None
            }
        );
        assert_eq!(
            book.planned("run-2", "create_note"),
            Some(tool_approval::Decision::Ask)
        );
        assert_eq!(book.planned("run-2", "get_note"), None);
        assert_eq!(book.planned("nobody", "create_note"), None);
    }

    #[test]
    fn an_approval_is_single_use() {
        let book = Interactions::with_asks(Vec::new());
        allowed_write(&book);
        let grant = scout_grant("run-2");
        assert!(book
            .take_write_approval(&grant, "create_note", &draft())
            .is_some());
        assert!(book
            .take_write_approval(&grant, "create_note", &draft())
            .is_none());
    }

    #[test]
    fn an_approval_is_bound_to_its_tool_input_and_actor() {
        let book = Interactions::with_asks(Vec::new());
        allowed_write(&book);
        let grant = scout_grant("run-2");
        let mut other = draft();
        other["slug"] = json!("something-else");
        assert!(book
            .take_write_approval(&grant, "create_note", &other)
            .is_none());
        assert!(book
            .take_write_approval(&grant, "append_to_note", &draft())
            .is_none());
        let someone = crate::mcp::RunGrant {
            actor: "process:other".into(),
            ..scout_grant("run-2")
        };
        assert!(book
            .take_write_approval(&someone, "create_note", &draft())
            .is_none());
        let elsewhere = crate::mcp::RunGrant {
            vault: Some(PathBuf::from("/w")),
            ..scout_grant("run-2")
        };
        assert!(book
            .take_write_approval(&elsewhere, "create_note", &draft())
            .is_none());
        // Another session's run holds no approval for it.
        book.open_seat(ask_first_seat("run-3", "s-2"), None);
        assert!(book
            .take_write_approval(&scout_grant("run-3"), "create_note", &draft())
            .is_none());
        // A spelling the name test takes, and keys in another order, match.
        let reordered = json!({ "body": "# Vendor delay\n", "slug": "vendor-delay", "folder": "records/risks" });
        assert!(book
            .take_write_approval(&grant, CREATE, &reordered)
            .is_some());
    }

    #[test]
    fn an_approval_is_refused_after_ten_minutes() {
        let book = Interactions::with_asks(Vec::new());
        let approval = allowed_write(&book);
        let grant = scout_grant("run-2");
        let late = approval.at
            + chrono::Duration::minutes(tool_approval::APPROVAL_MINUTES)
            + chrono::Duration::seconds(1);
        assert!(book
            .take_write_approval_at(&grant, "create_note", &draft(), late)
            .is_none());
        // Expired is gone, even back in time.
        assert!(book
            .take_write_approval_at(&grant, "create_note", &draft(), approval.at)
            .is_none());
        let book = Interactions::with_asks(Vec::new());
        let approval = allowed_write(&book);
        let in_time = approval.at + chrono::Duration::minutes(tool_approval::APPROVAL_MINUTES);
        assert!(book
            .take_write_approval_at(&grant, "create_note", &draft(), in_time)
            .is_some());
    }

    #[test]
    fn an_approval_dies_with_its_resumed_run() {
        let book = Interactions::with_asks(Vec::new());
        allowed_write(&book);
        book.close_seat("run-2");
        book.open_seat(ask_first_seat("run-2", "s-1"), None);
        assert!(book
            .take_write_approval(&scout_grant("run-2"), "create_note", &draft())
            .is_none());
    }

    #[test]
    fn an_aborted_resume_drops_its_approval() {
        let book = Interactions::with_asks(Vec::new());
        book.open_seat(ask_first_seat("run-1", "s-1"), None);
        book.gate("run-1", &named_call("s-1", "t1", CREATE, draft()));
        let card = book.confirm("s-1", "t1").unwrap();
        book.close_seat("run-1");
        let resume = book
            .begin_answer(Path::new("/v"), &card.id, allow())
            .unwrap();
        book.record_write_approval(resume.approval.unwrap());
        book.abort_answer(&card.id);
        book.open_seat(ask_first_seat("run-2", "s-1"), None);
        assert!(book
            .take_write_approval(&scout_grant("run-2"), "create_note", &draft())
            .is_none());
    }

    #[test]
    fn a_write_card_offers_no_this_conversation_and_a_deny_says_why() {
        let book = Interactions::with_asks(Vec::new());
        book.open_seat(ask_first_seat("run-1", "s-1"), None);
        book.gate("run-1", &named_call("s-1", "t1", CREATE, draft()));
        let card = book.confirm("s-1", "t1").unwrap();
        book.close_seat("run-1");
        assert_eq!(
            book.begin_answer(Path::new("/v"), &card.id, conversation())
                .unwrap_err()
                .code,
            MALFORMED_ARGUMENTS
        );
        let resume = book
            .begin_answer(Path::new("/v"), &card.id, deny("not yet"))
            .unwrap();
        assert!(resume.approval.is_none(), "a Deny mints nothing");
        book.open_seat(ask_first_seat("run-2", "s-1"), None);
        book.finish_answer(&card.id, "run-2");
        assert_eq!(
            book.gate("run-2", &named_call("s-1", "t1", CREATE, draft())),
            GateAnswer::Deny(
                "The person declined this write, so nothing was written. Their reason: \"not yet\""
                    .into()
            )
        );
        assert_eq!(
            write_declined(None),
            "The person declined this write, so nothing was written."
        );
    }

    // --- The person edits the draft (M57.4b) --------------------------------

    fn edited_draft() -> Value {
        json!({ "folder": "records/risks", "slug": "vendor-delay", "body": "# Vendor delay risk\n" })
    }

    /// An ask-first run asks to create a note and its run ends: the card.
    fn waiting_write(book: &Interactions) -> InteractionCard {
        book.open_seat(ask_first_seat("run-1", "s-1"), None);
        book.gate("run-1", &named_call("s-1", "t1", CREATE, draft()));
        let card = book.confirm("s-1", "t1").expect("a write card");
        book.close_seat("run-1");
        card
    }

    #[test]
    fn an_edited_approval_keeps_both_hashes() {
        let book = Interactions::with_asks(Vec::new());
        let card = waiting_write(&book);
        let resume = book
            .begin_answer_edited(
                Path::new("/v"),
                &card.id,
                allow(),
                Some(edited_draft()),
                |req, tool, input| {
                    assert_eq!(req.actor.as_deref(), Some("process:release-scout"));
                    assert_eq!(tool, CREATE);
                    assert_eq!(input, &edited_draft());
                    Ok(())
                },
            )
            .unwrap();
        let approval = resume.approval.expect("an approval");
        assert_eq!(approval.asked_hash, canonical_hash(&draft()));
        assert_eq!(approval.approved_hash, canonical_hash(&edited_draft()));
        assert_eq!(approval.approved_input(), &edited_draft());
        assert_eq!(approval.edited(), ["body"]);
        book.record_write_approval(approval);
        book.open_seat(ask_first_seat("run-2", "s-1"), None);
        book.finish_answer(&card.id, "run-2");
        // The resume's gate allows with the person's version.
        assert_eq!(
            book.gate("run-2", &named_call("s-1", "t1", CREATE, draft())),
            GateAnswer::Allow {
                updated_input: Some(edited_draft())
            }
        );
        // A CLI that ignores updatedInput sends the asked draft: it matches,
        // and what runs is the approved one.
        let grant = scout_grant("run-2");
        assert_eq!(
            book.take_write_approval(&grant, CREATE, &draft()),
            Some(ApprovedWrite {
                input: edited_draft(),
                edited: vec!["body".into()],
            })
        );
        // Used once, whichever hash comes next.
        assert!(book
            .take_write_approval(&grant, CREATE, &edited_draft())
            .is_none());
    }

    #[test]
    fn a_cli_that_applies_the_edit_matches_the_approved_hash() {
        let book = Interactions::with_asks(Vec::new());
        let card = waiting_write(&book);
        let resume = book
            .begin_answer_edited(
                Path::new("/v"),
                &card.id,
                allow(),
                Some(edited_draft()),
                |_, _, _| Ok(()),
            )
            .unwrap();
        book.record_write_approval(resume.approval.unwrap());
        book.open_seat(ask_first_seat("run-2", "s-1"), None);
        book.finish_answer(&card.id, "run-2");
        let taken = book
            .take_write_approval(&scout_grant("run-2"), CREATE, &edited_draft())
            .expect("the approved hash matches");
        assert_eq!(taken.input, edited_draft());
    }

    #[test]
    fn a_refused_edit_records_nothing_and_the_card_waits() {
        let book = Interactions::with_asks(Vec::new());
        let card = waiting_write(&book);
        let at = Path::new("/v");
        let unchecked = |_: &AgentRequest, _: &str, _: &Value| -> Result<(), Refusal> {
            panic!("a misshapen draft never reaches the grant check")
        };
        let shape = book
            .begin_answer_edited(
                at,
                &card.id,
                allow(),
                Some(json!({ "folder": "x", "body": "# X\n" })),
                unchecked,
            )
            .unwrap_err();
        assert_eq!(shape.code, MALFORMED_ARGUMENTS);
        assert_eq!(
            shape.message,
            "The edited draft leaves out slug, which this tool requires."
        );
        let scoped = book
            .begin_answer_edited(at, &card.id, allow(), Some(edited_draft()), |_, _, _| {
                Err(Refusal {
                    code: "write_outside_scope",
                    message: "This run is scoped to records/risks and cannot write to notes."
                        .into(),
                })
            })
            .unwrap_err();
        assert_eq!(scoped.code, "write_outside_scope");
        let denied = book
            .begin_answer_edited(at, &card.id, deny("no"), Some(edited_draft()), |_, _, _| {
                Ok(())
            })
            .unwrap_err();
        assert_eq!(denied.message, EDIT_MISFIT);
        // Nothing was taken: the card still waits, and a plain Allow mints an
        // approval with no edit.
        assert_eq!(book.pending(at).len(), 1);
        let resume = book.begin_answer(at, &card.id, allow()).unwrap();
        let approval = resume.approval.unwrap();
        assert!(approval.edited().is_empty());
        assert_eq!(approval.approved_input(), &draft());
    }

    #[test]
    fn only_a_write_card_takes_an_edited_draft() {
        let book = book();
        let card = waiting(&book);
        let refused = book
            .begin_answer_edited(
                Path::new("/v"),
                &card.id,
                allow(),
                Some(json!({ "path": "notes/inbox.md", "content": "x" })),
                |_, _, _| Ok(()),
            )
            .unwrap_err();
        assert_eq!(refused.message, EDIT_MISFIT);
    }

    #[test]
    fn changed_keys_names_added_removed_and_changed_keys() {
        let asked = json!({ "a": 1, "b": { "x": 1, "y": 2 }, "c": "same" });
        let approved = json!({ "b": { "y": 2, "x": 1 }, "c": "same", "d": null, "a": 2 });
        assert_eq!(changed_keys(&asked, &approved), ["a", "d"]);
        assert!(changed_keys(&asked, &asked).is_empty());
        assert_eq!(changed_keys(&asked, &json!({})), ["a", "b", "c"]);
    }

    #[test]
    fn canonical_hash_ignores_key_order() {
        let a = json!({ "a": 1, "b": { "x": [1, { "q": true, "p": null }], "y": "z" } });
        let b = json!({ "b": { "y": "z", "x": [1, { "p": null, "q": true }] }, "a": 1 });
        assert_eq!(canonical_hash(&a), canonical_hash(&b));
        // Order inside a list is meaning, and so is every value.
        let c = json!({ "a": 1, "b": { "x": [{ "q": true, "p": null }, 1], "y": "z" } });
        assert_ne!(canonical_hash(&a), canonical_hash(&c));
        assert_ne!(
            canonical_hash(&json!({ "a": 1 })),
            canonical_hash(&json!({ "a": 2 }))
        );
    }

    // M91.6: a branch seats as `agent::stream` seats it, in the session
    // minted for it. A card it raises answers into the branch, whose resume
    // never branches again; the card its source's turn was waiting on when
    // the branch began still answers into the source.
    #[test]
    fn a_branch_and_its_source_each_answer_into_their_own_session() {
        use super::super::transcript::{CliSession, ForkRequest};
        const SOURCE: &str = "00000000-0000-4000-8000-0000000000b1";
        const ANCHOR: &str = "00000000-0000-4000-8000-0000000000b2";
        let vault = Path::new("/v");
        let book = book();
        book.open_seat(seat("run-source", SOURCE, "/v"), None);
        assert_eq!(
            book.gate("run-source", &call(SOURCE, "t-source", ASKED)),
            GateAnswer::Defer
        );
        let source_card = book.confirm(SOURCE, "t-source").expect("the source's card");
        book.close_seat("run-source");

        let mut req = request();
        req.fork = Some(ForkRequest {
            from: SOURCE.into(),
            at: ANCHOR.into(),
        });
        let session = CliSession::for_request(None, req.fork.as_ref()).unwrap();
        let branch = session.id().to_string();
        let approval = tool_approval::plan_for(&req, true);
        book.open_seat(
            super::super::seat_for("run-branch", vault, &req, &session, &approval),
            None,
        );
        assert_eq!(
            book.gate("run-branch", &call(&branch, "t-branch", ASKED)),
            GateAnswer::Defer
        );
        let branch_card = book.confirm(&branch, "t-branch").expect("its own card");
        assert_eq!(branch_card.session_id, branch);
        let waiting: Vec<String> = book.pending(vault).into_iter().map(|c| c.id).collect();
        assert_eq!(waiting, [source_card.id.clone(), branch_card.id.clone()]);
        book.close_seat("run-branch");

        let resume = book.begin_answer(vault, &branch_card.id, allow()).unwrap();
        assert_eq!(resume.session_id, branch);
        assert_eq!(resume.snapshot.fork, None);
        // What the answer command builds from it resumes the branch itself.
        assert_eq!(
            CliSession::for_request(Some(&resume.session_id), resume.snapshot.fork.as_ref()),
            Ok(CliSession::Resume(branch.clone()))
        );
        let resumed = book.begin_answer(vault, &source_card.id, allow()).unwrap();
        assert_eq!(resumed.session_id, SOURCE);
    }

    #[test]
    fn selected_open_cancels_prior_vault_waiting_calls_without_live_process() {
        let _sink = crate::runtime::sink::test_lock();
        let _shadow = crate::ledger::shadow::testing::lock();
        let agents = crate::agent::AgentState {
            interactions: book(),
            ..Default::default()
        };
        let card = waiting(agents.interactions());
        assert_eq!(
            agents.interactions().pending(Path::new("/v")),
            vec![card.clone()]
        );
        let watcher = crate::vault::watcher::WatcherState::default();
        let ambient = crate::ingest::ambient::AmbientState::default();
        crate::suspend_legacy_for_selected(&watcher, &ambient, &agents).unwrap();
        // Expected RED: current stop_all() has no interaction/journal teardown.
        assert!(agents.interactions().pending(Path::new("/v")).is_empty());
        assert!(agents
            .interactions()
            .begin_answer(Path::new("/v"), &card.id, allow())
            .is_err());
    }

    #[test]
    fn selected_open_forgets_prior_vault_conversation_grants() {
        let _sink = crate::runtime::sink::test_lock();
        let _shadow = crate::ledger::shadow::testing::lock();
        let agents = crate::agent::AgentState {
            interactions: Interactions::with_asks(Vec::new()),
            ..Default::default()
        };
        let book = agents.interactions();
        let card = asked(book, "run-1", "s-1", "t1", "git status");
        book.begin_answer(Path::new("/v"), &card.id, conversation())
            .unwrap();
        book.finish_answer(&card.id, "run-2");
        book.open_seat(seat_under("ask", "run-3", "s-1", "/v"), None);
        assert_eq!(
            book.gate("run-3", &bash("s-1", "t2", "git status")),
            GateAnswer::Allow {
                updated_input: None
            }
        );
        book.close_seat("run-3");
        let watcher = crate::vault::watcher::WatcherState::default();
        let ambient = crate::ingest::ambient::AmbientState::default();
        crate::suspend_legacy_for_selected(&watcher, &ambient, &agents).unwrap();
        book.open_seat(seat_under("ask", "run-4", "s-1", "/v"), None);
        assert_eq!(
            book.gate("run-4", &bash("s-1", "t3", "git status")),
            GateAnswer::Defer
        );
    }

    #[test]
    fn selected_open_releases_finished_and_late_finishing_journals() {
        let _sink = crate::runtime::sink::test_lock();
        let _shadow = crate::ledger::shadow::testing::lock();
        let agents = crate::agent::AgentState::default();
        let none = HashSet::new();
        let now = std::time::Instant::now();
        agents
            .journal
            .open(1, "run-ended", Path::new("/v"), "s-1", now, &none);
        agents
            .journal
            .open(2, "run-live", Path::new("/w"), "s-2", now, &none);
        agents.journal.finish(1, now);
        let watcher = crate::vault::watcher::WatcherState::default();
        let ambient = crate::ingest::ambient::AmbientState::default();
        crate::suspend_legacy_for_selected(&watcher, &ambient, &agents).unwrap();
        assert_eq!(
            agents.events_since(1, "run-ended", 0),
            super::super::journal::EventsSince::Unknown
        );
        // A reader finishing after suspension must release its journal too.
        agents.journal.finish(2, std::time::Instant::now());
        assert_eq!(
            agents.events_since(2, "run-live", 0),
            super::super::journal::EventsSince::Unknown
        );
    }

    #[test]
    fn stopping_all_preserves_waiting_cards_grants_and_finished_journals() {
        let agents = crate::agent::AgentState {
            interactions: Interactions::with_asks(Vec::new()),
            ..Default::default()
        };
        let book = agents.interactions();
        let allowed = asked(book, "run-1", "s-1", "t1", "git status");
        book.begin_answer(Path::new("/v"), &allowed.id, conversation())
            .unwrap();
        book.finish_answer(&allowed.id, "run-2");
        let waiting = asked(book, "run-3", "s-2", "t2", "git diff");
        let now = std::time::Instant::now();
        agents
            .journal
            .open(1, "run-ended", Path::new("/v"), "s-1", now, &HashSet::new());
        agents.journal.finish(1, now);
        assert!(agents.stop_all().unwrap().is_empty());
        assert!(book.pending(Path::new("/v")).contains(&waiting));
        assert!(matches!(
            agents.events_since(1, "run-ended", 0),
            super::super::journal::EventsSince::Held { done: true, .. }
        ));
        book.open_seat(seat_under("ask", "run-4", "s-1", "/v"), None);
        assert_eq!(
            book.gate("run-4", &bash("s-1", "t3", "git status")),
            GateAnswer::Allow {
                updated_input: None
            }
        );
    }

    #[test]
    fn selected_open_does_not_requeue_a_resume_that_closes_after_suspension() {
        let _sink = crate::runtime::sink::test_lock();
        let _shadow = crate::ledger::shadow::testing::lock();
        let agents = crate::agent::AgentState {
            interactions: book(),
            ..Default::default()
        };
        let book = agents.interactions();
        let card = waiting(book);
        book.begin_answer(Path::new("/v"), &card.id, allow())
            .unwrap();
        book.open_seat(seat("run-2", "s-1", "/v"), None);
        book.finish_answer(&card.id, "run-2");
        let watcher = crate::vault::watcher::WatcherState::default();
        let ambient = crate::ingest::ambient::AmbientState::default();
        crate::suspend_legacy_for_selected(&watcher, &ambient, &agents).unwrap();
        book.close_seat("run-2");
        assert!(book.pending(Path::new("/v")).is_empty());
        assert!(book
            .begin_answer(Path::new("/v"), &card.id, allow())
            .is_err());
    }

    #[test]
    fn selected_open_revokes_unused_write_approvals_after_the_hook_read_allow() {
        let _sink = crate::runtime::sink::test_lock();
        let _shadow = crate::ledger::shadow::testing::lock();
        let agents = crate::agent::AgentState {
            interactions: Interactions::with_asks(Vec::new()),
            ..Default::default()
        };
        let book = agents.interactions();
        let card = waiting_write(book);
        let resume = book
            .begin_answer(Path::new("/v"), &card.id, allow())
            .unwrap();
        book.record_write_approval(resume.approval.unwrap());
        book.open_seat(ask_first_seat("run-2", "s-1"), None);
        book.finish_answer(&card.id, "run-2");
        assert!(matches!(
            book.gate("run-2", &named_call("s-1", "t1", CREATE, draft())),
            GateAnswer::Allow { .. }
        ));
        let watcher = crate::vault::watcher::WatcherState::default();
        let ambient = crate::ingest::ambient::AmbientState::default();
        crate::suspend_legacy_for_selected(&watcher, &ambient, &agents).unwrap();
        assert!(book
            .take_write_approval(&scout_grant("run-2"), CREATE, &draft())
            .is_none());
        // The consumed decision is historical; suspension revokes unused
        // dispatch authority without rewriting a decision already delivered.
        assert!(matches!(
            lock(&book.book)
                .entries
                .iter()
                .find(|entry| entry.id == card.id)
                .unwrap()
                .state,
            State::Answered(_)
        ));
        book.close_seat("run-2");
        assert!(book.pending(Path::new("/v")).is_empty());
    }

    #[test]
    fn selected_open_closes_legacy_run_admission_before_late_preparation_finishes() {
        let _sink = crate::runtime::sink::test_lock();
        let _shadow = crate::ledger::shadow::testing::lock();
        let agents = crate::agent::AgentState::default();
        // A command admitted before opening may still be preparing its CLI.
        assert!(agents.admit().is_ok());
        let watcher = crate::vault::watcher::WatcherState::default();
        let ambient = crate::ingest::ambient::AmbientState::default();
        crate::suspend_legacy_for_selected(&watcher, &ambient, &agents).unwrap();
        // Re-enter the real pre-spawn admission seam after selected teardown.
        // No seat, run config, child or slot may be created from this point.
        assert!(agents.admit().is_err());
    }

    #[test]
    fn selected_open_does_not_restore_a_grant_from_a_late_consumed_answer() {
        let _sink = crate::runtime::sink::test_lock();
        let _shadow = crate::ledger::shadow::testing::lock();
        let agents = crate::agent::AgentState {
            interactions: Interactions::with_asks(Vec::new()),
            ..Default::default()
        };
        let book = agents.interactions();
        let card = asked(book, "run-1", "s-1", "t1", "git status");
        book.begin_answer(Path::new("/v"), &card.id, conversation())
            .unwrap();
        // stream_prepared has opened the seat and launched the reader, but
        // answer_interaction has not yet reached finish_answer.
        book.open_seat(seat_under("ask", "run-2", "s-1", "/v"), None);
        assert_eq!(
            book.gate("run-2", &bash("s-1", "t1", "git status")),
            GateAnswer::Allow {
                updated_input: None
            }
        );
        let watcher = crate::vault::watcher::WatcherState::default();
        let ambient = crate::ingest::ambient::AmbientState::default();
        crate::suspend_legacy_for_selected(&watcher, &ambient, &agents).unwrap();
        // The command's post-spawn continuation is outside admission lock.
        book.finish_answer(&card.id, "run-2");
        // A later Legacy opening may start the same conversation. Seat setup
        // here uses the established grant regression fixture; it is not an
        // actual process start or a claim to prove native opening.
        book.open_seat(seat_under("ask", "run-3", "s-1", "/v"), None);
        assert_eq!(
            book.gate("run-3", &bash("s-1", "t2", "git status")),
            GateAnswer::Defer
        );
    }

    #[test]
    fn selected_open_rejects_a_late_write_approval_from_a_retired_answer() {
        let _sink = crate::runtime::sink::test_lock();
        let _shadow = crate::ledger::shadow::testing::lock();
        let agents = crate::agent::AgentState {
            interactions: Interactions::with_asks(Vec::new()),
            ..Default::default()
        };
        let book = agents.interactions();
        let card = waiting_write(book);
        let resume = book
            .begin_answer_edited(Path::new("/v"), &card.id, allow(), None, |_, _, _| Ok(()))
            .unwrap();
        let approval = resume.approval.expect("the person allowed this write");
        // The command is paused between lib.rs begin_answer_edited and
        // record_write_approval. Selected opening retires this answer now.
        crate::suspend_legacy_for_selected(&Default::default(), &Default::default(), &agents)
            .unwrap();
        assert!(book.pending(Path::new("/v")).is_empty());
        // The delayed native command has not yet reached stream's stale-ticket
        // refusal/abort_answer. Its next line tries to restore the old approval.
        book.record_write_approval(approval);
        book.open_seat(ask_first_seat("fresh-run", "s-1"), None);
        assert!(
            book.take_write_approval(&scout_grant("fresh-run"), CREATE, &draft())
                .is_none(),
            "selected retirement must also reject approval insertion delayed until after its sweep"
        );
    }
    #[test]
    fn a_live_consumed_answer_records_its_current_edited_write_approval() {
        let book = Interactions::with_asks(Vec::new());
        let card = waiting_write(&book);
        let resume = book
            .begin_answer_edited(
                Path::new("/v"),
                &card.id,
                allow(),
                Some(edited_draft()),
                |_, _, _| Ok(()),
            )
            .unwrap();
        book.open_seat(ask_first_seat("run-2", "s-1"), None);
        assert_eq!(
            book.gate("run-2", &named_call("s-1", "t1", CREATE, draft())),
            GateAnswer::Allow {
                updated_input: Some(edited_draft())
            },
        );
        book.record_write_approval(resume.approval.unwrap());
        let approved = book
            .take_write_approval(&scout_grant("run-2"), CREATE, &draft())
            .expect("the live current answer still grants its edited write");
        assert_eq!(approved.input, edited_draft());
        assert_eq!(approved.edited, vec!["body".to_string()]);
        assert!(book
            .take_write_approval(&scout_grant("run-2"), CREATE, &edited_draft())
            .is_none());
    }

    #[test]
    fn a_detached_prior_edit_cannot_replace_the_current_answers_approval() {
        let book = Interactions::with_asks(Vec::new());
        let card = waiting_write(&book);
        let old = book
            .begin_answer_edited(
                Path::new("/v"),
                &card.id,
                allow(),
                Some(edited_draft()),
                |_, _, _| Ok(()),
            )
            .unwrap()
            .approval
            .unwrap();
        book.abort_answer(&card.id);
        let current = book
            .begin_answer(Path::new("/v"), &card.id, allow())
            .unwrap()
            .approval
            .unwrap();
        book.record_write_approval(current);
        book.record_write_approval(old);
        book.open_seat(ask_first_seat("run-2", "s-1"), None);
        let approved = book
            .take_write_approval(&scout_grant("run-2"), CREATE, &draft())
            .expect("the current Allow remains recorded");
        assert_eq!(approved.input, draft());
        assert!(approved.edited.is_empty());
    }
    #[test]
    fn generation_answer_link_comes_from_the_original_entry_and_dies_on_abort() {
        let book = book();
        let card = waiting(&book);
        let resume = book
            .begin_answer(Path::new("/v"), &card.id, allow())
            .unwrap();
        assert_eq!(resume.link.source_run(), "run-1");
        assert_eq!(resume.link.session(), "s-1");
        assert!(resume.link.validate(Path::new("/v")));
        assert!(!resume.link.validate(Path::new("/wrong")));
        book.abort_answer(&resume.id);
        assert!(!resume.link.validate(Path::new("/v")));
        let next = book
            .begin_answer(Path::new("/v"), &card.id, allow())
            .unwrap();
        assert_ne!(next.link.answer_key(), resume.link.answer_key());
        assert!(!resume.link.validate(Path::new("/v")));
    }
    #[test]
    fn generation_answer_seat_cannot_take_another_books_or_sessions_answer() {
        let book = book();
        let card = waiting(&book);
        let resume = book
            .begin_answer(Path::new("/v"), &card.id, allow())
            .unwrap();
        assert!(book
            .open_answer_seat(seat("run-2", "wrong", "/v"), &resume.link)
            .is_err());
        let other = Interactions::default();
        assert!(other
            .open_answer_seat(seat("run-2", "s-1", "/v"), &resume.link)
            .is_err());
        book.open_answer_seat(seat("run-2", "s-1", "/v"), &resume.link)
            .unwrap();
        book.finish_answer(&resume.id, "run-2");
        assert!(matches!(
            book.gate("run-2", &call("s-1", "t1", ASKED)),
            GateAnswer::Allow { .. }
        ));
        assert!(
            !resume.link.validate(Path::new("/v")),
            "consumed answer is not a launch credential"
        );
    }
}

#[path = "managed_action_wait.rs"]
pub(crate) mod managed_action_wait;
