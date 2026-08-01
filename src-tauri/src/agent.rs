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
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

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
    // M9.5: the result travels with the completion. Action cards expand to
    // show what a tool actually returned, and without a payload here there
    // is nothing to expand to.
    ToolDone { tool_id: String, output: Option<String>, is_error: bool },
    Result { text: String, session_id: Option<String> },
    Error { message: String },
    Done,
}

/// What actually crosses the event channel: every event tagged with the run
/// (child process) it came from. A killed child's terminal `Done` arrives
/// AFTER the kill — sometimes in the very dispatch that hands the stream to
/// the next turn — and only the tag lets a listener refuse it instead of
/// ending whichever turn happens to be active (PR #5 review).
#[derive(Debug, Serialize, Clone)]
struct TaggedEvent {
    run: u64,
    #[serde(flatten)]
    event: AgentEvent,
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
    /// Who this run's MCP writes are attributed to (M13.4) — `process:<slug>`
    /// for an agent record's run. Absent reads as the default actor.
    pub actor: Option<String>,
    /// Fingerprints of the vault's stdio connectors the user approved on
    /// this machine (PR #5 security review) — connectors::stdio_fingerprint.
    /// Absent reads as none approved: a missing field must never widen
    /// access, least of all to executing commands a vault file names.
    pub approved_stdio: Option<Vec<String>>,
}

#[derive(Default)]
pub struct AgentState {
    /// The one live child, paired with the run id its events are tagged with.
    child: Mutex<Option<(Child, u64)>>,
}

impl AgentState {
    fn set(&self, child: Child, run: u64) {
        if let Ok(mut guard) = self.child.lock() {
            // Replacing a live child without killing it would leave an
            // orphaned CLI streaming into a conversation nobody is reading.
            if let Some((mut previous, _)) = guard.take() {
                let _ = previous.kill();
            }
            *guard = Some((child, run));
        }
    }

    /// Kill the current child and report WHICH run died. The killed child's
    /// terminal events arrive after this returns, so the caller needs the id
    /// to recognize and drop them (PR #5 review).
    pub fn stop(&self) -> Result<Option<u64>, String> {
        let mut guard = self.child.lock().map_err(|_| "agent state poisoned")?;
        if let Some((mut child, run)) = guard.take() {
            child.kill().map_err(|e| e.to_string())?;
            return Ok(Some(run));
        }
        Ok(None)
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
    let stdout = login_shell_probe("which claude")?;
    path_from_output(stdout.as_bytes(), true)
}

/// Run one command through the user's login+interactive shell and return its
/// stdout, or None if the shell is unavailable or reported failure.
///
/// `-l` sources `.zprofile`/`.zlogin` (where Homebrew puts its PATH) and `-i`
/// sources `.zshrc` (where nvm, fnm, and Volta put theirs); a CLI installed by
/// any of them is invisible without both. stdin is closed because an rc file
/// that prompts would otherwise hang the app on a startup check.
fn login_shell_probe(script: &str) -> Option<String> {
    if cfg!(windows) {
        return None;
    }
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let output = Command::new(shell)
        .args(["-lic", script])
        .stdin(Stdio::null())
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).into_owned())
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
    candidates_for(&std::env::var("HOME").unwrap_or_default())
}

fn candidates_for(home: &str) -> Vec<PathBuf> {
    [
        "/opt/homebrew/bin/claude",
        "/usr/local/bin/claude",
        "/usr/bin/claude",
    ]
    .iter()
    .map(PathBuf::from)
    .chain(
        [
            ".local/bin/claude",
            ".claude/local/claude",
            ".bun/bin/claude",
            ".volta/bin/claude",
            ".yarn/bin/claude",
            ".npm-global/bin/claude",
            ".local/share/pnpm/claude",
        ]
        .iter()
        .map(|rel| PathBuf::from(home).join(rel)),
    )
    .chain(nvm_candidates(home))
    .collect()
}

/// nvm installs global binaries per node version, under a directory whose name
/// is the version — so there is nothing to hard-code. Walk the versions dir.
fn nvm_candidates(home: &str) -> Vec<PathBuf> {
    let versions = PathBuf::from(home).join(".nvm/versions/node");
    let Ok(entries) = std::fs::read_dir(versions) else {
        return Vec::new();
    };
    entries
        .filter_map(Result::ok)
        .map(|e| e.path().join("bin/claude"))
        .collect()
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

/// The PATH the CLI needs in order to run, not merely to be found.
///
/// A GUI app launched from Finder inherits launchd's PATH — `/usr/bin:/bin:
/// /usr/sbin:/sbin` — and nothing else. Finding the binary is handled above,
/// but finding it is not enough: an npm- or bun-installed `claude` is a script
/// whose shebang is `#!/usr/bin/env node`, and node lives wherever Homebrew,
/// nvm, or Volta put it. Launched from a terminal the app inherits a PATH that
/// has node on it and everything works; launched from the Dock it does not,
/// and the CLI exits instantly with `env: node: No such file or directory`.
/// That difference is the whole bug, so we recover the login shell's PATH once
/// and hand it to every process we spawn.
fn login_shell_path() -> Option<&'static str> {
    static CACHED: OnceLock<Option<String>> = OnceLock::new();
    CACHED
        .get_or_init(|| {
            // The sentinel survives rc files that print banners of their own.
            login_shell_probe("printf '\\n__CEREBRO_PATH__%s\\n' \"$PATH\"")
                .as_deref()
                .and_then(path_from_probe)
        })
        .as_deref()
}

const PATH_SENTINEL: &str = "__CEREBRO_PATH__";

fn path_from_probe(stdout: &str) -> Option<String> {
    stdout
        .lines()
        .find_map(|line| line.trim().strip_prefix(PATH_SENTINEL))
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(str::to_string)
}

/// Give `command` the login shell's PATH, keeping what we already inherited so
/// a shell that fails to answer can never make things worse than not asking.
fn with_login_path(command: &mut Command) -> &mut Command {
    if let Some(login) = login_shell_path() {
        let inherited = std::env::var("PATH").unwrap_or_default();
        let merged = if inherited.is_empty() {
            login.to_string()
        } else {
            format!("{login}:{inherited}")
        };
        command.env("PATH", merged);
    }
    command
}

pub fn status() -> AgentStatus {
    let Some(path) = find_binary() else {
        return AgentStatus { installed: false, version: None, path: None };
    };
    let version = with_login_path(Command::new(&path).arg("--version"))
        .stdin(Stdio::null())
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

pub fn build_args(req: &AgentRequest, mcp_config: &Path, strict_mcp: bool) -> Vec<String> {
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
    // Strictness is decided by connectors::connector_context (M13.3): a vault
    // with an explicit connector list is pinned to it (strict, the enabled
    // servers merged into our config); a vault without one keeps the legacy
    // open mode when connectors are on. Off stays strict — reaching other
    // systems is a choice, never one inherited from opening the panel.
    if strict_mcp {
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

pub fn mcp_config_json(
    url: &str,
    token: &str,
    extra: &serde_json::Map<String, serde_json::Value>,
) -> String {
    // Connector entries first, cerebro last: on a name collision the loopback
    // wins, because a config that shadows our own tools is a broken run.
    let mut servers = extra.clone();
    servers.insert(
        "cerebro".into(),
        serde_json::json!({
            "type": "http",
            "url": url,
            "headers": { "Authorization": format!("Bearer {token}") }
        }),
    );
    serde_json::json!({ "mcpServers": servers }).to_string()
}

/// The merged MCP config carries secrets — the vault's connector headers/env
/// and this run's loopback token — so it must not take up residence in the
/// app config dir (PR #5 security review). Owner-readable only, and swept:
/// every run removes whatever configs earlier runs (or crashes) left behind.
fn write_run_config(path: &Path, contents: &str) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)
            .map_err(|e| e.to_string())?;
        file.write_all(contents.as_bytes()).map_err(|e| e.to_string())
    }
    #[cfg(not(unix))]
    std::fs::write(path, contents).map_err(|e| e.to_string())
}

pub fn sweep_run_configs(config_dir: &Path) {
    let Ok(dir) = std::fs::read_dir(config_dir) else { return };
    for entry in dir.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with("mcp-config") && name.ends_with(".json") {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

/// Spawn a run and return its RUN ID — the tag every event it emits carries,
/// and the id `AgentState::stop` reports back when this child is killed.
pub fn stream(
    app: AppHandle,
    state: &AgentState,
    vault: &Path,
    req: AgentRequest,
    config_dir: &Path,
) -> Result<u64, String> {
    let binary = find_binary().ok_or(
        "Claude Code was not found on this machine. Install it from https://claude.com/claude-code, then reopen cerebro.",
    )?;

    let (url, token) = match (req.mcp_url.clone(), req.mcp_token.clone()) {
        (Some(u), Some(t)) => (u, t),
        _ => return Err("the MCP endpoint is not running".into()),
    };
    std::fs::create_dir_all(config_dir).map_err(|e| e.to_string())?;
    // One sequence names both the run and its config file. A UNIQUE config
    // path per run: the sweep below or a killed run's late cleanup must
    // never delete the config a just-spawned CLI has not read yet. This
    // also retires the old persistent `mcp-config.json`, which sat in the
    // app config dir holding connector credentials between runs.
    static RUN_SEQ: AtomicU64 = AtomicU64::new(0);
    sweep_run_configs(config_dir);
    let run = RUN_SEQ.fetch_add(1, Ordering::Relaxed);
    let config_path = config_dir.join(format!("mcp-config-{run}.json"));
    let (extra_servers, strict_mcp) = crate::connectors::connector_context(
        vault,
        req.connectors.unwrap_or(false),
        req.approved_stdio.as_deref().unwrap_or(&[]),
    );
    write_run_config(&config_path, &mcp_config_json(&url, &token, &extra_servers))?;

    let mut child =
        with_login_path(Command::new(&binary).args(build_args(&req, &config_path, strict_mcp)))
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
    state.set(child, run);

    let run_config = config_path.clone();
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
                let _ = app.emit(AGENT_EVENT, TaggedEvent { run, event });
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
                        TaggedEvent {
                            run,
                            event: AgentEvent::Error { message: text.chars().take(600).collect() },
                        },
                    );
                }
            }
        }
        // The child has exited; its config's job is done. Secrets end their
        // residency with the run — the sweep at the next spawn is only the
        // backstop for a crash between here and there.
        let _ = std::fs::remove_file(&run_config);
        let _ = app.emit(AGENT_EVENT, TaggedEvent { run, event: AgentEvent::Done });
    });

    Ok(run)
}

/// Map one CLI stream-json object onto zero or more normalized events.
/// A tool result's text, however the CLI shaped it.
///
/// `content` is a bare string in some versions and an array of typed blocks
/// in others; both appear in the same stream depending on the tool. Reading
/// only one shape silently drops half the outputs.
fn tool_result_text(block: &Value) -> Option<String> {
    const LIMIT: usize = 2000;
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
    if trimmed.is_empty() {
        return None;
    }
    Some(if trimmed.chars().count() > LIMIT {
        let head: String = trimmed.chars().take(LIMIT).collect();
        format!("{head}…")
    } else {
        trimmed.to_string()
    })
}

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
                // Truncated here rather than in the panel: a Read of a large
                // note would otherwise cross the IPC boundary in full on
                // every turn, to be thrown away by the renderer.
                output: tool_result_text(b),
                is_error: b.get("is_error").and_then(Value::as_bool).unwrap_or(false),
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
                actor: None,
                approved_stdio: None,
            },
            Path::new("/tmp/mcp.json"),
            true,
        )
    }

    fn allowed_tools(args: &[String]) -> String {
        args.iter()
            .position(|a| a == "--allowedTools")
            .map(|i| args[i + 1].clone())
            .expect("--allowedTools is always passed")
    }

    #[test]
    fn a_run_config_is_owner_readable_only() {
        let dir = std::env::temp_dir().join("cerebro-agent-test-perms");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("mcp-config-0.json");
        write_run_config(&path, "{\"secret\":true}").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{\"secret\":true}");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "the merged config carries bearer tokens");
        }
        // Re-writing an existing path must truncate, not append.
        write_run_config(&path, "{}").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{}");
    }

    #[test]
    fn the_sweep_removes_every_leftover_run_config_and_nothing_else() {
        let dir = std::env::temp_dir().join("cerebro-agent-test-sweep");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // The legacy persistent name, a per-run name, and a bystander.
        std::fs::write(dir.join("mcp-config.json"), "old").unwrap();
        std::fs::write(dir.join("mcp-config-7.json"), "crashed run").unwrap();
        std::fs::write(dir.join("app-config.json"), "keep").unwrap();
        sweep_run_configs(&dir);
        assert!(!dir.join("mcp-config.json").exists(), "legacy residency must end");
        assert!(!dir.join("mcp-config-7.json").exists());
        assert!(dir.join("app-config.json").exists());
    }

    #[test]
    fn every_event_crosses_the_channel_tagged_with_its_run() {
        // The tag is what lets a listener tell a killed run's trailing Done
        // from the live run's (PR #5 review) — flattening must keep the
        // event's own shape intact beside it.
        let done = serde_json::to_value(TaggedEvent { run: 7, event: AgentEvent::Done }).unwrap();
        assert_eq!(done["run"], 7);
        assert_eq!(done["kind"], "Done");

        let delta = serde_json::to_value(TaggedEvent {
            run: 3,
            event: AgentEvent::TextDelta { text: "hi".into() },
        })
        .unwrap();
        assert_eq!(delta["run"], 3);
        assert_eq!(delta["kind"], "TextDelta");
        assert_eq!(delta["text"], "hi");
    }

    #[cfg(unix)]
    #[test]
    fn stop_reports_which_run_was_killed() {
        let state = AgentState::default();
        assert_eq!(state.stop().unwrap(), None, "nothing running: nothing to report");
        let child = Command::new("sleep").arg("5").spawn().unwrap();
        state.set(child, 42);
        assert_eq!(state.stop().unwrap(), Some(42), "the killed run is named");
        assert_eq!(state.stop().unwrap(), None, "a second stop has nothing left to kill");
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
                actor: None,
                approved_stdio: None,
            },
            Path::new("/tmp/mcp.json"),
            true,
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
    fn a_non_strict_run_opens_the_users_own_mcp_servers_and_nothing_else() {
        // connector_context decides strictness (see connectors.rs tests);
        // this pins what the flag changes at the args level: MCP scope only.
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
                actor: None,
                approved_stdio: None,
            },
            Path::new("/tmp/mcp.json"),
            false,
        );
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
                actor: None,
                approved_stdio: None,
            },
            Path::new("/tmp/mcp.json"),
            true,
        );
        assert!(full.windows(2).any(|w| w[0] == "--resume" && w[1] == "abc"));
        assert!(full.windows(2).any(|w| w[0] == "--model" && w[1] == "claude-opus-5"));
        // A whitespace-only system prompt is not a system prompt.
        assert!(!full.contains(&"--append-system-prompt".to_string()));
    }

    #[test]
    fn the_login_path_survives_a_chatty_shell_profile() {
        // Plenty of .zshrc files print a banner. Reading the last line, or the
        // whole of stdout, would hand the CLI a PATH of "Welcome back!".
        let probe = format!("Welcome back!\nnvm loaded\n{PATH_SENTINEL}/opt/homebrew/bin:/usr/bin\n");
        assert_eq!(
            path_from_probe(&probe).as_deref(),
            Some("/opt/homebrew/bin:/usr/bin")
        );
    }

    #[test]
    fn a_shell_that_answers_with_nothing_useful_leaves_path_alone() {
        // Falling back to an empty PATH would be worse than not asking: it
        // would strip the little that launchd did give us.
        assert_eq!(path_from_probe("no sentinel here\n"), None);
        assert_eq!(path_from_probe(&format!("{PATH_SENTINEL}   \n")), None);
        assert_eq!(path_from_probe(""), None);
    }

    #[test]
    fn discovery_covers_the_installers_that_hide_from_launchd() {
        let found: Vec<String> = candidates_for("/Users/example")
            .iter()
            .map(|p| p.to_string_lossy().to_string())
            .collect();
        for expected in [
            "/opt/homebrew/bin/claude",
            "/Users/example/.local/bin/claude",
            "/Users/example/.bun/bin/claude",
            "/Users/example/.volta/bin/claude",
        ] {
            assert!(found.contains(&expected.to_string()), "missing {expected}");
        }
    }

    #[test]
    fn nvm_discovery_is_empty_rather_than_wrong_when_nvm_is_absent() {
        assert!(nvm_candidates("/nonexistent-home").is_empty());
    }

    #[test]
    fn mcp_config_carries_the_bearer_token() {
        let config = mcp_config_json("http://127.0.0.1:9/mcp", "secret", &serde_json::Map::new());
        assert!(config.contains("\"type\":\"http\""));
        assert!(config.contains("Bearer secret"));
    }

    #[test]
    fn connector_servers_merge_beside_cerebro_and_never_shadow_it() {
        let mut extra = serde_json::Map::new();
        extra.insert("jira".into(), json!({"type": "http", "url": "https://jira/mcp"}));
        extra.insert("cerebro".into(), json!({"type": "http", "url": "https://evil/mcp"}));
        let config = mcp_config_json("http://127.0.0.1:9/mcp", "secret", &extra);
        let parsed: serde_json::Value = serde_json::from_str(&config).unwrap();
        assert_eq!(parsed["mcpServers"]["jira"]["url"], "https://jira/mcp");
        assert_eq!(parsed["mcpServers"]["cerebro"]["url"], "http://127.0.0.1:9/mcp");
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
        assert!(matches!(done.as_slice(), [AgentEvent::ToolDone { tool_id, .. }] if tool_id == "t1"));

        let result = translate(
            &json!({ "type": "result", "subtype": "success", "result": "done", "session_id": "s-1" }),
            &mut session,
        );
        assert!(matches!(result.as_slice(), [AgentEvent::Result { text, .. }] if text == "done"));
    }

    // M9.5: the CLI shapes tool_result content two different ways in the same
    // stream. Reading only one silently drops half the outputs.
    #[test]
    fn tool_results_carry_their_output_in_either_shape() {
        let mut sid = None;
        let string_form = translate(
            &json!({ "type": "user", "message": { "content": [
                { "type": "tool_result", "tool_use_id": "t1", "content": "  four notes  " }
            ] } }),
            &mut sid,
        );
        assert!(matches!(
            string_form.as_slice(),
            [AgentEvent::ToolDone { output: Some(text), is_error: false, .. }] if text == "four notes"
        ));

        let block_form = translate(
            &json!({ "type": "user", "message": { "content": [
                { "type": "tool_result", "tool_use_id": "t2", "content": [
                    { "type": "text", "text": "line one" },
                    { "type": "text", "text": "line two" }
                ] }
            ] } }),
            &mut sid,
        );
        assert!(matches!(
            block_form.as_slice(),
            [AgentEvent::ToolDone { output: Some(text), .. }] if text == "line one\nline two"
        ));
    }

    #[test]
    fn a_failed_tool_reports_as_such() {
        let mut sid = None;
        let events = translate(
            &json!({ "type": "user", "message": { "content": [
                { "type": "tool_result", "tool_use_id": "t1", "content": "nope", "is_error": true }
            ] } }),
            &mut sid,
        );
        assert!(matches!(events.as_slice(), [AgentEvent::ToolDone { is_error: true, .. }]));
    }

    #[test]
    fn an_empty_tool_result_carries_no_output() {
        let mut sid = None;
        let events = translate(
            &json!({ "type": "user", "message": { "content": [
                { "type": "tool_result", "tool_use_id": "t1", "content": "   " }
            ] } }),
            &mut sid,
        );
        assert!(matches!(events.as_slice(), [AgentEvent::ToolDone { output: None, .. }]));
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
