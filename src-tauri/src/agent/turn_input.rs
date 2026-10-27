//! A seated run's stdin (M92.13): the one writer of what Cerebro says to a
//! Claude Code run over `--input-format stream-json`.
//!
//! A seated run takes its prompt here rather than in argv, so that once its
//! result is in it can be asked how full its context is: Claude Code answers
//! `get_context_usage` only over stream-json input, and only in the run's own
//! process, since a separate one counts its own argv's tools (measured on
//! 2.1.250). The thread `cerebro-turn-input` owns the child's stdin ([`open`]
//! is the one caller of `take_stdin` for a CLI run) and writes three things,
//! in this order and nothing else: the prompt, as one user line; the context
//! ask, one control request, after the run's first result; and the close.
//! [`TurnMessage`] is that whole vocabulary. Nothing here answers the CLI: no
//! permission, interrupt, mode change or hook answer reaches a run this way
//! (CV-28, CV-29, CV-32). A request the CLI makes is met by closing stdin,
//! which refuses its call while the turn goes on (measured: the turn
//! completes and the run exits 0).
//!
//! Stdin closes on every path a run ends by. The reader closes it on the
//! ask's answer, on any request from the CLI and on any line it cannot parse
//! (a result too deep to read would otherwise never ask), an ask nobody
//! answers closes it after [`CONTEXT_ASK_WAIT`], and the channel's end
//! closes it too, so the end of the stream, a panic, an init refusal, a Stop
//! and quit all close it.
//! A write to a run that has gone fails with EPIPE, which ends the writing
//! and nothing else. Claude Code waits for more input for as long as its
//! stdin stays open after its result, so once the ask is written the run has
//! [`CONTEXT_ASK_WAIT`] past the close to end, and is ended, TERM then KILL
//! after `STOP_GRACE`, when it has not.

use std::fs::File;
use std::io::Write;
use std::process::ChildStdin;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::spawn::{Handle, Supervised};

/// How long the context ask waits for its answer once written, and how long
/// the run then has to end once its stdin has closed (M92.13). Claude Code
/// answered within 0.4 s of its result in every probe: at 168k tokens of a
/// 200k window as at 8k, after an error result and after a subagent's turn
/// (P8, P9, P12). Done waits on it, so it stays at 2 s.
pub(crate) const CONTEXT_ASK_WAIT: Duration = Duration::from_secs(2);

/// How often a run being seen out is looked at again.
const POLL: Duration = Duration::from_millis(25);

/// The context ask's subtype: the one control request a run is ever sent.
const CONTEXT_USAGE: &str = "get_context_usage";

/// Everything a seated run's stdin is told (M92.13). A closed set: nothing
/// outside this module can name a message, and nothing else is written.
enum TurnMessage {
    /// The person's message, as the run's one user line.
    Prompt(String),
    /// Ask the run how full its context is, once, after its first result.
    AskContext,
    /// Close stdin.
    Close,
}

/// The reader's hold on its run's stdin (M92.13). Dropping it closes stdin.
pub(crate) struct TurnInput {
    messages: Sender<TurnMessage>,
    request_id: String,
    asked: bool,
}

impl TurnInput {
    /// Ask the run how full its context is, the first time only: the request
    /// id its answer carries, or None when it was asked already or its stdin
    /// is gone.
    pub(crate) fn ask(&mut self) -> Option<&str> {
        if self.asked {
            return None;
        }
        self.asked = true;
        self.messages.send(TurnMessage::AskContext).ok()?;
        Some(&self.request_id)
    }

    /// Close the run's stdin. Closing a closed one does nothing.
    pub(crate) fn close(&self) {
        let _ = self.messages.send(TurnMessage::Close);
    }
}

/// Start a seated run's turn input (M92.13): take its child's stdin, which
/// `cli_command` piped, and hand it `prompt` as the run's one user line.
/// `run` names the ask (`ctx-<run>`) and the log; `copy` is the run's
/// recording's stdin file, when it has one (`tee::Recording::stdin_copy`).
/// Refused when stdin was not piped or the thread could not start, and
/// stdin is closed either way.
pub(crate) fn open(
    child: &Supervised,
    run: u64,
    prompt: &str,
    copy: Option<File>,
) -> Result<TurnInput, String> {
    let pipe = child.take_stdin().ok_or("the run's stdin was not piped")?;
    let (messages, inbox) = mpsc::channel();
    // Queued before the thread starts, so the prompt is its first write.
    let _ = messages.send(TurnMessage::Prompt(prompt.to_string()));
    let request_id = format!("ctx-{run}");
    let asked_as = request_id.clone();
    let leader = child.handle();
    let stdin = Stdin {
        pipe: Some(pipe),
        copy,
        run,
    };
    std::thread::Builder::new()
        .name("cerebro-turn-input".into())
        .spawn(move || serve(stdin, &inbox, &asked_as, &leader, run))
        .map_err(|error| format!("the run's input did not start: {error}"))?;
    Ok(TurnInput {
        messages,
        request_id,
        asked: false,
    })
}

/// The thread's whole life: write each prompt until the ask, close, or the
/// channel's end; then, once the ask is written, wait for its answer, close,
/// and see the run out. Nothing is written after the ask.
fn serve(
    mut stdin: Stdin,
    inbox: &Receiver<TurnMessage>,
    request_id: &str,
    leader: &Handle,
    run: u64,
) {
    loop {
        match inbox.recv() {
            Ok(TurnMessage::Prompt(text)) => {
                if !stdin.write(&UserLine::new(&text)) {
                    return;
                }
            }
            Ok(TurnMessage::AskContext) => {
                if stdin.write(&ContextAsk::new(request_id)) {
                    // The reader's close on the answer, the channel's end or
                    // the wait running out: each ends the ask.
                    let _ = inbox.recv_timeout(CONTEXT_ASK_WAIT);
                    stdin.close();
                    see_out(inbox, leader, run);
                }
                return;
            }
            Ok(TurnMessage::Close) | Err(_) => return,
        }
    }
}

/// See a run out once its stdin has closed after the ask (M92.13): it has
/// CONTEXT_ASK_WAIT to end, its stream read to its end (the channel's end
/// says so) and its process gone, and is ended, TERM then KILL after
/// STOP_GRACE, when it has not. A run that waits on stdin for ever, or a
/// child left holding its stdout, would otherwise keep its slot, its seat
/// and its bearer until quit. The run is not booked cancelled: it said how
/// it ended before this.
fn see_out(inbox: &Receiver<TurnMessage>, leader: &Handle, run: u64) {
    let deadline = Instant::now() + CONTEXT_ASK_WAIT;
    let mut read = false;
    while Instant::now() < deadline {
        if read {
            if !leader.alive() {
                return;
            }
            std::thread::sleep(POLL);
        } else if let Err(RecvTimeoutError::Disconnected) = inbox.recv_timeout(POLL) {
            read = true;
        }
    }
    if read && !leader.alive() {
        return;
    }
    log::warn!(
        "agent run {run}: Claude Code or its stream had not ended {} s after its stdin closed, so its group was ended",
        CONTEXT_ASK_WAIT.as_secs()
    );
    leader.terminate(super::STOP_GRACE);
}

/// A run's stdin as the thread writes it, each line copied to the run's
/// recording when it has one. Dropping it closes stdin.
struct Stdin {
    pipe: Option<ChildStdin>,
    copy: Option<File>,
    run: u64,
}

impl Stdin {
    /// Write `message` as one line. False once stdin is closed or the run
    /// has gone (EPIPE), which closes it: nothing more is written.
    fn write(&mut self, message: &impl Serialize) -> bool {
        let Some(pipe) = self.pipe.as_mut() else {
            return false;
        };
        let Ok(mut line) = serde_json::to_vec(message) else {
            self.close();
            return false;
        };
        line.push(b'\n');
        if pipe.write_all(&line).is_err() {
            self.close();
            return false;
        }
        if let Some(copy) = self.copy.as_mut() {
            if let Err(error) = copy.write_all(&line) {
                log::warn!(
                    "agent run {}: its recording stopped copying stdin, the file refused a write: {error}",
                    self.run
                );
                self.copy = None;
            }
        }
        true
    }

    fn close(&mut self) {
        self.pipe = None;
    }
}

/// The prompt as Claude Code's stream-json input reads it:
/// `{"type":"user","message":{"role":"user","content":"…"}}`.
#[derive(Serialize)]
struct UserLine<'a> {
    #[serde(rename = "type")]
    kind: &'static str,
    message: UserMessage<'a>,
}

#[derive(Serialize)]
struct UserMessage<'a> {
    role: &'static str,
    content: &'a str,
}

impl<'a> UserLine<'a> {
    fn new(content: &'a str) -> Self {
        Self {
            kind: "user",
            message: UserMessage {
                role: "user",
                content,
            },
        }
    }
}

/// The context ask:
/// `{"type":"control_request","request_id":"ctx-<run>","request":{"subtype":"get_context_usage"}}`.
#[derive(Serialize)]
struct ContextAsk<'a> {
    #[serde(rename = "type")]
    kind: &'static str,
    request_id: &'a str,
    request: AskBody,
}

#[derive(Serialize)]
struct AskBody {
    subtype: &'static str,
}

impl<'a> ContextAsk<'a> {
    fn new(request_id: &'a str) -> Self {
        Self {
            kind: "control_request",
            request_id,
            request: AskBody {
                subtype: CONTEXT_USAGE,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use std::path::{Path, PathBuf};

    fn line_of(message: &impl Serialize) -> Value {
        serde_json::from_slice(&serde_json::to_vec(message).unwrap()).unwrap()
    }

    #[test]
    fn the_prompt_is_one_user_line_whatever_it_holds() {
        let text = "- buy milk\n\"and\" eggs \u{2026} -v";
        let mut bytes = serde_json::to_vec(&UserLine::new(text)).unwrap();
        bytes.push(b'\n');
        assert_eq!(
            bytes.iter().filter(|byte| **byte == b'\n').count(),
            1,
            "a newline in the message is escaped, so the line is one line"
        );
        assert_eq!(
            line_of(&UserLine::new(text)),
            json!({ "type": "user", "message": { "role": "user", "content": text } })
        );
    }

    #[test]
    fn the_ask_is_the_one_control_request() {
        assert_eq!(
            line_of(&ContextAsk::new("ctx-7")),
            json!({ "type": "control_request", "request_id": "ctx-7",
                "request": { "subtype": "get_context_usage" } })
        );
    }

    // --- Rails (M92.13) -------------------------------------------------------

    /// This file's code, before its tests.
    fn code_half(source: &str) -> &str {
        source
            .split("\n#[cfg(test)]\nmod tests {")
            .next()
            .expect("the file has a code half")
    }

    /// The string literals of `code`, comments left out.
    fn literals(code: &str) -> Vec<String> {
        let mut found = Vec::new();
        for line in code.lines() {
            let trimmed = line.trim_start();
            if trimmed.starts_with("//") {
                continue;
            }
            let mut chars = line.chars().peekable();
            while let Some(c) = chars.next() {
                match c {
                    '/' if chars.peek() == Some(&'/') => break,
                    '\'' => {
                        // A char literal, or a lifetime: skip what it holds.
                        let mut ahead = chars.clone();
                        let first = ahead.next();
                        if first == Some('\\') {
                            ahead.next();
                        }
                        if ahead.next() == Some('\'') {
                            chars = ahead;
                        }
                    }
                    '"' => {
                        let mut literal = String::new();
                        while let Some(c) = chars.next() {
                            match c {
                                '\\' => {
                                    if let Some(escaped) = chars.next() {
                                        literal.push(escaped);
                                    }
                                }
                                '"' => break,
                                c => literal.push(c),
                            }
                        }
                        found.push(literal);
                    }
                    _ => {}
                }
            }
        }
        found
    }

    /// The SDK control protocol's other request and answer words, none of
    /// which a run's stdin may ever carry: approvals, interrupts, mode and
    /// model changes, hook and MCP answers.
    const NEVER_WRITTEN: [&str; 16] = [
        "control_response",
        "control_cancel_request",
        "can_use_tool",
        "set_permission_mode",
        "interrupt",
        "initialize",
        "hook_callback",
        "mcp_message",
        "mcp_status",
        "mcp_set_servers",
        "mcp_reconnect",
        "mcp_toggle",
        "set_model",
        "set_max_thinking_tokens",
        "rewind_files",
        "end_session",
    ];

    #[test]
    fn the_turn_input_writes_only_a_prompt_or_the_context_ask() {
        let code = code_half(include_str!("turn_input.rs"));
        // The closed enum: these three messages, and no other enum here.
        assert_eq!(code.matches("enum ").count(), 1, "one message type");
        let body = code
            .split("enum TurnMessage {")
            .nth(1)
            .and_then(|rest| rest.split("\n}").next())
            .expect("the message enum");
        let variants: Vec<&str> = body
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty() && !line.starts_with("//"))
            .map(|line| {
                line.split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
                    .next()
                    .unwrap_or("")
            })
            .collect();
        assert_eq!(variants, ["Prompt", "AskContext", "Close"]);
        // One control request, of one subtype, and no answer to anything.
        let said = literals(code);
        let count = |word: &str| said.iter().filter(|literal| *literal == word).count();
        assert_eq!(count("get_context_usage"), 1, "{said:?}");
        assert_eq!(count("control_request"), 1, "{said:?}");
        for word in NEVER_WRITTEN {
            assert!(
                !said.iter().any(|literal| literal.contains(word)),
                "{word} in {said:?}"
            );
        }
        assert!(
            !code.contains("subtype: \"") && code.matches("subtype: CONTEXT_USAGE").count() == 1,
            "the one subtype is the one constant"
        );
    }

    #[test]
    fn the_literal_reader_finds_what_it_guards_against() {
        let sample = "let a = \"can_use_tool\"; // \"interrupt\"\n/// \"set_model\"\nlet c = 'x'; fn f<'a>() {}\nlet b = \"esc\\\"aped\";";
        assert_eq!(literals(sample), ["can_use_tool", "esc\"aped"]);
    }

    /// Every Rust file under `dir`, recursively.
    fn rust_files(dir: &Path) -> Vec<PathBuf> {
        let mut found = Vec::new();
        for entry in std::fs::read_dir(dir).unwrap().flatten() {
            let path = entry.path();
            if path.is_dir() {
                found.extend(rust_files(&path));
            } else if path.extension().is_some_and(|ext| ext == "rs") {
                found.push(path);
            }
        }
        found
    }

    #[test]
    fn only_the_turn_input_takes_a_runs_stdin() {
        let agent = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/agent");
        let files = rust_files(&agent);
        assert!(files.len() > 10, "{files:?}");
        for file in files {
            let text = std::fs::read_to_string(&file).unwrap();
            if file.ends_with("turn_input.rs") {
                assert_eq!(
                    code_half(&text).matches("take_stdin()").count(),
                    1,
                    "open takes it, once"
                );
            } else {
                assert!(
                    !text.contains("take_stdin"),
                    "{} takes a run's stdin",
                    file.display()
                );
            }
        }
    }

    #[test]
    fn the_ask_waits_well_past_every_measured_answer() {
        // P9's 0.4 s was the slowest answer measured; Done waits on the ask,
        // so its wait is capped at 2 s.
        assert!(CONTEXT_ASK_WAIT >= Duration::from_millis(1200));
        assert!(CONTEXT_ASK_WAIT <= Duration::from_secs(2));
    }
}
