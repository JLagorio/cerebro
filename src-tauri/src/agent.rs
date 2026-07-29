//! Local agent runtime (M6) — streams the Claude Code CLI into the app.
//!
//! The agent is a process on the user's machine, holding its own auth and its
//! own model access. Cerebro spawns it, hands it an MCP endpoint pointing back
//! at the open vault, and normalizes its NDJSON output into events the panel
//! renders. Nothing about the conversation leaves the machine except through
//! the CLI the user already installed and signed into.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter};

pub const AGENT_EVENT: &str = "cerebro://agent";

#[derive(Debug, Serialize, Clone)]
pub struct AgentStatus {
    pub installed: bool,
    pub version: Option<String>,
    pub path: Option<String>,
}

/// Normalized stream events. The CLI's wire format is richer and version-
/// dependent; the panel only ever sees this shape.
#[derive(Debug, Serialize, Clone)]
#[serde(tag = "kind")]
pub enum AgentEvent {
    Init { session_id: String },
    TextDelta { text: String },
    ThinkingDelta { text: String },
    ToolStart { tool_name: String, tool_id: String, input: Option<String> },
    ToolDone { tool_id: String },
    Result { text: String, session_id: Option<String> },
    Error { message: String },
    Done,
}

#[derive(Debug, Deserialize)]
pub struct AgentRequest {
    pub message: String,
    pub system_prompt: Option<String>,
    pub session_id: Option<String>,
    pub model: Option<String>,
    /// The Settings ceiling (M8.1): adds shell + the CLI's own file tools.
    /// Absent reads as false — a missing field must never widen access.
    pub shell: Option<bool>,
    /// Let the agent reach the user's own MCP servers (M8.2) — Atlassian and
    /// friends — so the connector inlet has something to connect with.
    /// Absent reads as false, for the same reason.
    pub connectors: Option<bool>,
    pub mcp_url: Option<String>,
    pub mcp_token: Option<String>,
}

#[derive(Default)]
pub struct AgentState {
    child: Mutex<Option<Child>>,
}

impl AgentState {
    fn set(&self, child: Child) {
        if let Ok(mut guard) = self.child.lock() {
            // Replacing a live child without killing it would leave an
            // orphaned CLI streaming into a conversation nobody is reading.
            if let Some(mut previous) = guard.take() {
                let _ = previous.kill();
            }
            *guard = Some(child);
        }
    }

    pub fn stop(&self) -> Result<(), String> {
        let mut guard = self.child.lock().map_err(|_| "agent state poisoned")?;
        if let Some(mut child) = guard.take() {
            child.kill().map_err(|e| e.to_string())?;
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/// GUI apps on macOS do not inherit the shell's PATH, so a CLI installed by
/// Homebrew or a version manager is invisible to a plain `which`. Fall back to
/// a login shell, then to the known install locations.
pub fn find_binary() -> Option<PathBuf> {
    if let Some(found) = which_on_path() {
        return Some(found);
    }
    if let Some(found) = which_in_login_shell() {
        return Some(found);
    }
    candidates().into_iter().find(|p| p.is_file())
}

fn which_on_path() -> Option<PathBuf> {
    let program = if cfg!(windows) { "where" } else { "which" };
    let output = Command::new(program).arg("claude").output().ok()?;
    path_from_output(&output.stdout, output.status.success())
}

fn which_in_login_shell() -> Option<PathBuf> {
    if cfg!(windows) {
        return None;
    }
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let output = Command::new(shell)
        .args(["-lic", "which claude"])
        .output()
        .ok()?;
    path_from_output(&output.stdout, output.status.success())
}

fn path_from_output(stdout: &[u8], success: bool) -> Option<PathBuf> {
    if !success {
        return None;
    }
    let text = String::from_utf8_lossy(stdout);
    let first = text.lines().map(str::trim).find(|l| !l.is_empty())?;
    let path = PathBuf::from(first);
    path.is_file().then_some(path)
}

fn candidates() -> Vec<PathBuf> {
    let home = std::env::var("HOME").unwrap_or_default();
    [
        "/opt/homebrew/bin/claude",
        "/usr/local/bin/claude",
        "/usr/bin/claude",
    ]
    .iter()
    .map(PathBuf::from)
    .chain(
        [".local/bin/claude", ".claude/local/claude", ".bun/bin/claude"]
            .iter()
            .map(|rel| PathBuf::from(&home).join(rel)),
    )
    .collect()
}

pub fn status() -> AgentStatus {
    let Some(path) = find_binary() else {
        return AgentStatus { installed: false, version: None, path: None };
    };
    let version = Command::new(&path)
        .arg("--version")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());
    AgentStatus {
        installed: true,
        version,
        path: Some(path.to_string_lossy().to_string()),
    }
}

// ---------------------------------------------------------------------------
// Invocation
// ---------------------------------------------------------------------------

/// Tools the agent may use.
///
/// M8.1 collapsed three user-picked modes into one ceiling. The modes were a
/// question nobody could answer in advance — what the agent should be allowed
/// to do depends on the request, not on a dropdown set before it. What replaced
/// them is structural: cerebro's tools are always available and enforce their
/// own boundaries (write_concept refuses any path outside `knowledge/`), so the
/// only thing left to decide is whether the agent gets a shell, which no folder
/// rule can express.
fn tool_policy(shell: bool) -> Vec<&'static str> {
    let mut tools = vec![
        "mcp__cerebro__get_vault_context",
        "mcp__cerebro__search_notes",
        "mcp__cerebro__get_note",
        "mcp__cerebro__list_inbox",
        "mcp__cerebro__open_note",
        "mcp__cerebro__navigate",
        "mcp__cerebro__propose_organize",
        "mcp__cerebro__create_note",
        "mcp__cerebro__update_frontmatter",
        "mcp__cerebro__append_to_note",
        "mcp__cerebro__write_concept",
        "mcp__cerebro__cache_source",
    ];
    if shell {
        tools.extend(["Bash", "Read", "Write", "Edit", "Glob", "Grep"]);
    }
    tools
}

pub fn build_args(req: &AgentRequest, mcp_config: &Path) -> Vec<String> {
    let tools = tool_policy(req.shell.unwrap_or(false));
    let mut args: Vec<String> = vec![
        "-p".into(),
        req.message.clone(),
        "--output-format".into(),
        "stream-json".into(),
        "--verbose".into(),
        "--include-partial-messages".into(),
        "--mcp-config".into(),
        mcp_config.to_string_lossy().to_string(),
        // The CLI's own gate stays out of the way: cerebro's tools enforce
        // their boundaries themselves, and shell access is decided above.
        "--permission-mode".into(),
        "acceptEdits".into(),
        "--allowedTools".into(),
        tools.join(","),
    ];
    // Without connectors, --strict-mcp-config keeps the agent from loading the
    // user's other MCP servers into a session they opened inside a notes app.
    // WITH connectors, those servers are the whole point: they are how a Jira
    // key in a note becomes a cached source doc. Off by default — reaching
    // other systems is a choice, never one inherited from opening the panel.
    if !req.connectors.unwrap_or(false) {
        args.push("--strict-mcp-config".into());
    }
    if let Some(prompt) = req.system_prompt.as_ref().filter(|p| !p.trim().is_empty()) {
        args.push("--append-system-prompt".into());
        args.push(prompt.clone());
    }
    if let Some(model) = req.model.as_ref().filter(|m| !m.trim().is_empty()) {
        args.push("--model".into());
        args.push(model.clone());
    }
    if let Some(session) = req.session_id.as_ref().filter(|s| !s.trim().is_empty()) {
        args.push("--resume".into());
        args.push(session.clone());
    }
    args
}

pub fn mcp_config_json(url: &str, token: &str) -> String {
    serde_json::json!({
        "mcpServers": {
            "cerebro": {
                "type": "http",
                "url": url,
                "headers": { "Authorization": format!("Bearer {token}") }
            }
        }
    })
    .to_string()
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

pub fn stream(
    app: AppHandle,
    state: &AgentState,
    vault: &Path,
    req: AgentRequest,
    config_dir: &Path,
) -> Result<(), String> {
    let binary = find_binary().ok_or(
        "Claude Code was not found on this machine. Install it from https://claude.com/claude-code, then reopen cerebro.",
    )?;

    let (url, token) = match (req.mcp_url.clone(), req.mcp_token.clone()) {
        (Some(u), Some(t)) => (u, t),
        _ => return Err("the MCP endpoint is not running".into()),
    };
    std::fs::create_dir_all(config_dir).map_err(|e| e.to_string())?;
    let config_path = config_dir.join("mcp-config.json");
    std::fs::write(&config_path, mcp_config_json(&url, &token)).map_err(|e| e.to_string())?;

    let mut child = Command::new(&binary)
        .args(build_args(&req, &config_path))
        // The vault is the working directory, so shell-capable modes and the
        // CLI's own file tools stay pointed at the user's notes.
        .current_dir(vault)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null())
        .spawn()
        .map_err(|e| format!("could not start Claude Code: {e}"))?;

    let stdout = child.stdout.take().ok_or("agent produced no stdout")?;
    let stderr = child.stderr.take();
    state.set(child);

    std::thread::spawn(move || {
        let mut session_id: Option<String> = None;
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if line.trim().is_empty() {
                continue;
            }
            // A line we cannot parse is skipped rather than surfaced: the CLI
            // interleaves diagnostics with the stream and its wire format
            // changes between versions.
            let Ok(value) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            for event in translate(&value, &mut session_id) {
                let _ = app.emit(AGENT_EVENT, event);
            }
        }

        // stderr is only worth surfacing when the stream produced nothing —
        // the CLI writes warnings there on perfectly good runs.
        if session_id.is_none() {
            if let Some(stderr) = stderr {
                let text: String = BufReader::new(stderr)
                    .lines()
                    .map_while(Result::ok)
                    .collect::<Vec<_>>()
                    .join("\n");
                if !text.trim().is_empty() {
                    let _ = app.emit(
                        AGENT_EVENT,
                        AgentEvent::Error { message: text.chars().take(600).collect() },
                    );
                }
            }
        }
        let _ = app.emit(AGENT_EVENT, AgentEvent::Done);
    });

    Ok(())
}

/// Map one CLI stream-json object onto zero or more normalized events.
pub fn translate(value: &Value, session_id: &mut Option<String>) -> Vec<AgentEvent> {
    let kind = value.get("type").and_then(Value::as_str).unwrap_or("");
    match kind {
        "system" => {
            if value.get("subtype").and_then(Value::as_str) == Some("init") {
                if let Some(id) = value.get("session_id").and_then(Value::as_str) {
                    *session_id = Some(id.to_string());
                    return vec![AgentEvent::Init { session_id: id.to_string() }];
                }
            }
            vec![]
        }
        "stream_event" => {
            let event = value.get("event").unwrap_or(&Value::Null);
            if event.get("type").and_then(Value::as_str) != Some("content_block_delta") {
                return vec![];
            }
            let delta = event.get("delta").unwrap_or(&Value::Null);
            match delta.get("type").and_then(Value::as_str) {
                Some("text_delta") => delta
                    .get("text")
                    .and_then(Value::as_str)
                    .map(|t| vec![AgentEvent::TextDelta { text: t.to_string() }])
                    .unwrap_or_default(),
                Some("thinking_delta") => delta
                    .get("thinking")
                    .and_then(Value::as_str)
                    .map(|t| vec![AgentEvent::ThinkingDelta { text: t.to_string() }])
                    .unwrap_or_default(),
                _ => vec![],
            }
        }
        "assistant" => content_blocks(value)
            .iter()
            .filter(|b| b.get("type").and_then(Value::as_str) == Some("tool_use"))
            .map(|b| AgentEvent::ToolStart {
                tool_name: b
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("tool")
                    .to_string(),
                tool_id: b.get("id").and_then(Value::as_str).unwrap_or("").to_string(),
                input: b.get("input").map(|i| {
                    let text = i.to_string();
                    text.chars().take(200).collect()
                }),
            })
            .collect(),
        "user" => content_blocks(value)
            .iter()
            .filter(|b| b.get("type").and_then(Value::as_str) == Some("tool_result"))
            .map(|b| AgentEvent::ToolDone {
                tool_id: b
                    .get("tool_use_id")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
            })
            .collect(),
        "result" => {
            if let Some(id) = value.get("session_id").and_then(Value::as_str) {
                *session_id = Some(id.to_string());
            }
            let is_error = value.get("is_error").and_then(Value::as_bool).unwrap_or(false);
            let text = value
                .get("result")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            if is_error {
                vec![AgentEvent::Error {
                    message: if text.is_empty() { "the agent reported an error".into() } else { text },
                }]
            } else {
                vec![AgentEvent::Result { text, session_id: session_id.clone() }]
            }
        }
        _ => vec![],
    }
}

fn content_blocks(value: &Value) -> Vec<Value> {
    value
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn args_for(shell: bool) -> Vec<String> {
        build_args(
            &AgentRequest {
                message: "hi".into(),
                system_prompt: None,
                session_id: None,
                model: None,
                shell: Some(shell),
                connectors: None,
                mcp_url: None,
                mcp_token: None,
            },
            Path::new("/tmp/mcp.json"),
        )
    }

    fn allowed_tools(args: &[String]) -> String {
        args.iter()
            .position(|a| a == "--allowedTools")
            .map(|i| args[i + 1].clone())
            .expect("--allowedTools is always passed")
    }

    #[test]
    fn the_default_is_cerebros_own_tools_and_never_a_shell() {
        let allowed = allowed_tools(&args_for(false));
        assert!(allowed.contains("write_concept"));
        assert!(allowed.contains("search_notes"));
        // The whole point of the ceiling: everything else follows from the
        // folder model, so nothing but the shell is switchable — and it is off.
        for host_tool in ["Bash", "Write", "Edit", "Glob", "Grep"] {
            assert!(
                !allowed.contains(host_tool),
                "{host_tool} leaked in without the user turning shell access on"
            );
        }
    }

    #[test]
    fn shell_access_adds_the_host_tools() {
        let allowed = allowed_tools(&args_for(true));
        assert!(allowed.contains("Bash"));
        assert!(allowed.contains("write_concept"), "the cerebro tools stay");
    }

    #[test]
    fn an_absent_shell_flag_never_widens_access() {
        let args = build_args(
            &AgentRequest {
                message: "hi".into(),
                system_prompt: None,
                session_id: None,
                model: None,
                shell: None,
                connectors: None,
                mcp_url: None,
                mcp_token: None,
            },
            Path::new("/tmp/mcp.json"),
        );
        assert!(!allowed_tools(&args).contains("Bash"));
    }

    #[test]
    fn by_default_a_run_is_pinned_to_our_mcp_config_alone() {
        let args = args_for(false);
        assert!(
            args.contains(&"--strict-mcp-config".to_string()),
            "without this the agent loads the user's other MCP servers into a notes app"
        );
        assert!(args.contains(&"--mcp-config".to_string()));
    }

    #[test]
    fn connectors_open_the_users_own_mcp_servers_and_nothing_else() {
        let args = build_args(
            &AgentRequest {
                message: "hi".into(),
                system_prompt: None,
                session_id: None,
                model: None,
                shell: None,
                connectors: Some(true),
                mcp_url: None,
                mcp_token: None,
            },
            Path::new("/tmp/mcp.json"),
        );
        // The connector inlet needs Atlassian and friends reachable; that is
        // the ONLY thing this flag changes.
        assert!(!args.contains(&"--strict-mcp-config".to_string()));
        assert!(!allowed_tools(&args).contains("Bash"));
    }

    #[test]
    fn cache_source_is_always_available_so_a_fetch_can_be_written_down() {
        // A connector the agent can call but not record from would re-fetch
        // the same ticket every turn.
        assert!(allowed_tools(&args_for(false)).contains("cache_source"));
    }

    #[test]
    fn resume_and_model_are_only_passed_when_set() {
        let bare = args_for(false);
        assert!(!bare.contains(&"--resume".to_string()));
        assert!(!bare.contains(&"--model".to_string()));

        let full = build_args(
            &AgentRequest {
                message: "hi".into(),
                system_prompt: Some("  ".into()),
                session_id: Some("abc".into()),
                model: Some("claude-opus-5".into()),
                shell: None,
                connectors: None,
                mcp_url: None,
                mcp_token: None,
            },
            Path::new("/tmp/mcp.json"),
        );
        assert!(full.windows(2).any(|w| w[0] == "--resume" && w[1] == "abc"));
        assert!(full.windows(2).any(|w| w[0] == "--model" && w[1] == "claude-opus-5"));
        // A whitespace-only system prompt is not a system prompt.
        assert!(!full.contains(&"--append-system-prompt".to_string()));
    }

    #[test]
    fn mcp_config_carries_the_bearer_token() {
        let config = mcp_config_json("http://127.0.0.1:9/mcp", "secret");
        assert!(config.contains("\"type\":\"http\""));
        assert!(config.contains("Bearer secret"));
    }

    #[test]
    fn translates_the_cli_stream_into_normalized_events() {
        let mut session = None;

        let init = translate(
            &json!({ "type": "system", "subtype": "init", "session_id": "s-1" }),
            &mut session,
        );
        assert!(matches!(init.as_slice(), [AgentEvent::Init { session_id }] if session_id == "s-1"));
        assert_eq!(session.as_deref(), Some("s-1"));

        let delta = translate(
            &json!({
                "type": "stream_event",
                "event": { "type": "content_block_delta", "delta": { "type": "text_delta", "text": "he" } }
            }),
            &mut session,
        );
        assert!(matches!(delta.as_slice(), [AgentEvent::TextDelta { text }] if text == "he"));

        let tool = translate(
            &json!({
                "type": "assistant",
                "message": { "content": [{ "type": "tool_use", "id": "t1", "name": "search_notes", "input": { "query": "x" } }] }
            }),
            &mut session,
        );
        assert!(
            matches!(tool.as_slice(), [AgentEvent::ToolStart { tool_name, tool_id, .. }]
                if tool_name == "search_notes" && tool_id == "t1")
        );

        let done = translate(
            &json!({ "type": "user", "message": { "content": [{ "type": "tool_result", "tool_use_id": "t1" }] } }),
            &mut session,
        );
        assert!(matches!(done.as_slice(), [AgentEvent::ToolDone { tool_id }] if tool_id == "t1"));

        let result = translate(
            &json!({ "type": "result", "subtype": "success", "result": "done", "session_id": "s-1" }),
            &mut session,
        );
        assert!(matches!(result.as_slice(), [AgentEvent::Result { text, .. }] if text == "done"));
    }

    #[test]
    fn a_failed_result_surfaces_as_an_error_not_a_reply() {
        let mut session = None;
        let events = translate(
            &json!({ "type": "result", "is_error": true, "result": "rate limited" }),
            &mut session,
        );
        assert!(matches!(events.as_slice(), [AgentEvent::Error { message }] if message == "rate limited"));
    }

    #[test]
    fn unknown_and_malformed_lines_are_ignored_rather_than_shown() {
        let mut session = None;
        // The CLI's wire format changes between versions; an unknown shape
        // must not become a visible error in the conversation.
        assert!(translate(&json!({ "type": "telemetry" }), &mut session).is_empty());
        assert!(translate(&json!({}), &mut session).is_empty());
        assert!(translate(&json!({ "type": "stream_event" }), &mut session).is_empty());
    }
}
