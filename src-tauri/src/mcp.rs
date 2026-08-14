//! In-process MCP server (M6).
//!
//! The local agent reaches cerebro's vault and UI through this endpoint. It
//! runs INSIDE the app on 127.0.0.1 rather than as a spawned Node process
//! with a socket back-channel (Tolaria's design), because everything the
//! tools need — the vault path, the window handle — is already here. That
//! makes `open_note` a direct call into app state instead of a hop through
//! a second process, and it removes Node from the runtime requirements.
//!
//! Security: bound to loopback, and every request must carry a bearer token
//! minted at startup. The token is handed to the CLI through a private
//! `--mcp-config` file and nothing else, and `--strict-mcp-config` keeps the
//! agent from loading any other server.
//!
//! The bundle is the agent's to write and the human's to verify — but the
//! agent writes it through `write_concept` and nothing else (M17.1). That tool
//! refuses a `verified` field and stamps `generated` from the run's actor, so
//! it is where provenance comes from; `create_note`, `update_frontmatter` and
//! `append_to_note` therefore call `knowledge::guard_agent_write` and refuse
//! the bundle outright. This module used to say the agent's tools were "NOT
//! subject to the knowledge/ guard" and treat that as the design — it was the
//! hole that let a model stamp the user's own review onto its own output.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use rand::Rng;
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Emitter};

use crate::vault;

pub const UI_ACTION_EVENT: &str = "cerebro://ui-action";
const PROTOCOL_VERSION: &str = "2025-06-18";

#[derive(Default)]
pub struct McpState {
    inner: Mutex<Option<Running>>,
}

pub const DEFAULT_ACTOR: &str = "claude-code";

/// None and blank both read as the default — a panel run AFTER an agent run
/// must reset the attribution, never inherit it.
fn normalize_actor(actor: Option<&str>) -> &str {
    actor
        .filter(|a| !a.trim().is_empty())
        .unwrap_or(DEFAULT_ACTOR)
}

/// What a run's bearer token buys it (M13.4 actor, M17.13 scope).
///
/// Both ride the token rather than shared "current run" state, for the reason
/// PR #5 gave about attribution and which applies twice over to scope: a child
/// killed while a write is in flight can only present the token it was spawned
/// with, so its trailing writes are stamped as ITS actor and confined to ITS
/// scope, never to the incoming run's.
#[derive(Clone, Debug, PartialEq)]
pub struct RunGrant {
    pub actor: String,
    /// The durable 128-bit id every proposal this run submits carries
    /// (M26.3c), DERIVED FROM THE BEARER TOKEN.
    ///
    /// It rides the token for exactly the reason actor and scope do, and one
    /// more: `commit_proposals` refuses members belonging to another run
    /// (`policy/commit.rs`), so if a caller could name its own run id it
    /// could sweep another run's queued proposals into its own commit set.
    /// A caller only ever knows its own token, so it can only ever name its
    /// own run.
    pub run_id: String,
    /// Vault-relative folders this run may write inside. `None` is unrestricted
    /// — the panel's own turns, which the user is watching.
    ///
    /// FOLDERS, deliberately, and it is the only scope primitive offered.
    /// A folder prefix is something Rust can check without knowing anything
    /// about the vault's schema, so the refusal is structural. "Only records of
    /// type Risk" is not: it would have to be re-derived per write, would go
    /// wrong the moment a type is renamed (which already does not rewrite
    /// ListSource.type), and the honest version of it is a sentence in a
    /// prompt — which is exactly the thing this milestone exists to replace.
    /// A Collection is a folder, so "the Product collection" is expressible;
    /// its empty entry set (surface.ts) is not consulted and does not matter.
    pub scope: Option<Vec<String>>,
    /// Tool names this token may dispatch. `None` is unrestricted — the
    /// panel's own turns. Same upper-bound semantics as `scope`, and checked
    /// in the same place, for the same reason: argv is advice, the grant is
    /// the boundary.
    pub tools: Option<Vec<String>>,
}

/// A run's durable id, derived from its bearer token.
///
/// Domain-separated so a token can never be read back out of an id that
/// travels in the ledger, and 128-bit hex because `ProposalV1::validate`
/// requires that shape.
pub fn run_id_of(token: &str) -> String {
    crate::ledger::schema::sha256_first128(format!("cerebro-mcp-run-v1\0{token}").as_bytes())
}

impl RunGrant {
    fn unrestricted(actor: &str) -> Self {
        Self {
            actor: actor.to_string(),
            run_id: run_id_of(actor),
            scope: None,
            tools: None,
        }
    }

    /// Is this run allowed to write here? Prefix containment on vault-relative
    /// paths, matched at a path SEPARATOR so that a scope of `work` cannot be
    /// escaped into `workspace/` — the classic prefix bug, and the reason this
    /// is a function rather than `starts_with`.
    pub fn may_write(&self, path: &str) -> bool {
        let Some(scope) = &self.scope else {
            return true;
        };
        let target = path.trim_start_matches("./").trim_start_matches('/');
        scope.iter().any(|folder| {
            let folder = folder.trim_matches('/');
            folder.is_empty() || target == folder || target.starts_with(&format!("{folder}/"))
        })
    }
}

#[derive(Clone)]
struct Running {
    port: u16,
    token: String,
    vault: Arc<Mutex<PathBuf>>,
    /// token → grant for recent runs. See RunGrant.
    run_actors: Arc<Mutex<Vec<(String, RunGrant)>>>,
}

/// How many run tokens stay valid at once. A killed child's writes can still
/// be in flight when the next run is minted, so its token must outlive the
/// mint — briefly, and never unboundedly.
///
/// M17.3 raised this from 4. It was sized for one live child plus a little
/// slack; with up to `MAX_CONCURRENT_RUNS` alive at once, four would evict a
/// RUNNING run's token as soon as a fifth was minted, and that run's next
/// write would come back `-32001 unauthorized` mid-task. The window now holds
/// every live run several times over, so eviction can only ever reach tokens
/// whose children are long gone.
const RUN_TOKEN_WINDOW: usize = 4 * crate::agent::MAX_CONCURRENT_RUNS;

/// Exposed so agent.rs can assert the window outlasts the run cap.
pub fn run_token_window() -> usize {
    RUN_TOKEN_WINDOW
}

fn push_run_token(runs: &mut Vec<(String, RunGrant)>, token: String, grant: RunGrant) {
    runs.push((token, grant));
    let excess = runs.len().saturating_sub(RUN_TOKEN_WINDOW);
    // A run whose token is gone can never propose again, so its attempt
    // counters go with it. Bounding the counters by the same window that
    // bounds the tokens is what stops this map growing for the life of the
    // process.
    for (_, dropped) in runs.drain(..excess) {
        forget_attempts(&dropped.run_id);
    }
}

/// What one run has already tried for one piece of work (M26.4g).
#[derive(Debug, Clone, PartialEq, Eq)]
struct Attempt {
    /// Including the first. `in_session_retry.max_attempts` bounds this.
    count: u32,
    /// The typed code the last attempt was refused with.
    code: String,
    /// What the last attempt actually said, so an unchanged resubmission is
    /// distinguishable from an adjusted one.
    digest: String,
}

/// `(run_id, work_key)` → what that run has tried.
///
/// Process-global rather than per-connection because a run is a bearer token,
/// not a socket: an agent that reconnects is the same run and must not get a
/// fresh allowance by doing so.
fn attempts() -> &'static Mutex<BTreeMap<(String, String), Attempt>> {
    static ATTEMPTS: OnceLock<Mutex<BTreeMap<(String, String), Attempt>>> = OnceLock::new();
    ATTEMPTS.get_or_init(|| Mutex::new(BTreeMap::new()))
}

fn forget_attempts(run_id: &str) {
    if let Ok(mut map) = attempts().lock() {
        map.retain(|(run, _), _| run != run_id);
    }
}

/// One run's ingest window, while it is open (M26.4h).
///
/// The driver opens it before spawning and takes the report after; the run
/// reports through `report_window_outcome`. Held server-side for the reason
/// every other derived fact is: the run does not get to tell us what it
/// submitted, because the server already knows.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
struct WindowSession {
    batch_key: String,
    /// Proposal ids THIS server accepted from this run. Never caller-supplied
    /// — a run that could name its own list could attribute another run's
    /// work to its window.
    submitted: std::collections::BTreeSet<String>,
    report: Option<crate::ingest::outcome::RunResult>,
}

fn windows() -> &'static Mutex<BTreeMap<String, WindowSession>> {
    static WINDOWS: OnceLock<Mutex<BTreeMap<String, WindowSession>>> = OnceLock::new();
    WINDOWS.get_or_init(|| Mutex::new(BTreeMap::new()))
}

/// Declare that this run is assessing this window. Without it,
/// `report_window_outcome` has nothing to report about and refuses.
pub(crate) fn open_window(run_id: &str, batch_key: &str) {
    if let Ok(mut map) = windows().lock() {
        map.insert(
            run_id.to_string(),
            WindowSession {
                batch_key: batch_key.to_string(),
                ..Default::default()
            },
        );
    }
}

/// Take what the run reported and close its window. `None` means it never
/// reported — which is a BLOCKED window, never a guessed "nothing material".
pub(crate) fn take_window_report(run_id: &str) -> Option<crate::ingest::outcome::RunResult> {
    let mut map = windows().lock().ok()?;
    map.remove(run_id).and_then(|session| session.report)
}

/// Test-only: record a report the way the tool does, so `ingest::cli`'s
/// tests exercise the REAL registry rather than a second one that could
/// disagree with it.
#[cfg(test)]
pub(crate) fn test_report_window(run_id: &str, result: crate::ingest::outcome::RunResult) {
    if let Ok(mut map) = windows().lock() {
        if let Some(session) = map.get_mut(run_id) {
            session.report = Some(result);
        }
    }
}

/// One run's open question (M26.5e).
///
/// The attended twin of `WindowSession`: the app opens the question before
/// spawning and takes the answer after, and the run answers through
/// `submit_answer`. The manifest is held HERE rather than passed through the
/// model, for the reason every derived fact is held server-side — an answer
/// validated against a manifest the run supplied would be an answer validated
/// against itself.
#[derive(Debug, Clone, PartialEq)]
struct QuestionSession {
    manifest: Box<crate::assembly::manifest::WorkingMemoryManifest>,
    answer: Option<Box<crate::assembly::answer::SynthesisAnswer>>,
}

fn questions() -> &'static Mutex<BTreeMap<String, QuestionSession>> {
    static QUESTIONS: OnceLock<Mutex<BTreeMap<String, QuestionSession>>> = OnceLock::new();
    QUESTIONS.get_or_init(|| Mutex::new(BTreeMap::new()))
}

/// Declare that this run is answering this assembly. Without it,
/// `submit_answer` has nothing to answer and refuses.
pub(crate) fn open_question(
    run_id: &str,
    manifest: &crate::assembly::manifest::WorkingMemoryManifest,
) {
    if let Ok(mut map) = questions().lock() {
        map.insert(
            run_id.to_string(),
            QuestionSession {
                manifest: Box::new(manifest.clone()),
                answer: None,
            },
        );
    }
}

/// Take what the run answered and close its question. `None` means it never
/// answered — which is a run that produced nothing, never a guessed answer.
pub(crate) fn take_answer(run_id: &str) -> Option<crate::assembly::answer::SynthesisAnswer> {
    let mut map = questions().lock().ok()?;
    map.remove(run_id)
        .and_then(|session| session.answer)
        .map(|answer| *answer)
}

/// Test-only: the manifest a question was opened with, and the answer path
/// the tool takes — so `assembly::ask`'s tests drive the REAL registry rather
/// than a second one that could disagree with it.
#[cfg(test)]
pub(crate) fn test_open_manifest(
    run_id: &str,
) -> Option<crate::assembly::manifest::WorkingMemoryManifest> {
    let map = questions().lock().ok()?;
    map.get(run_id).map(|session| (*session.manifest).clone())
}

#[cfg(test)]
pub(crate) fn test_submit_answer(
    run_id: &str,
    answer: crate::assembly::answer::SynthesisAnswer,
) -> Result<(), String> {
    let args: Map<String, Value> = serde_json::from_value(
        json!({ "answer": serde_json::to_value(&answer).map_err(|e| e.to_string())? }),
    )
    .map_err(|e| e.to_string())?;
    tool_submit_answer(
        &args,
        &RunGrant {
            actor: crate::assembly::ask::ACTOR.to_string(),
            run_id: run_id.to_string(),
            scope: Some(vec![]),
            // The narrowing the real mint site grants a synthesis run.
            tools: Some(crate::assembly::live::declared_tools()),
        },
    )
    .map(|_| ())
}

fn record_submission(run_id: &str, proposal_id: &str) {
    if let Ok(mut map) = windows().lock() {
        if let Some(session) = map.get_mut(run_id) {
            session.submitted.insert(proposal_id.to_string());
        }
    }
}

/// What identifies "the same piece of work" across an adjustment.
///
/// The op and its targets, NOT the payload — because a legitimate retry
/// changes the payload. An agent that refetches a moved version and
/// resubmits is doing the same work on the same targets, and that is exactly
/// what the attempt count is counting.
fn work_key(op_kind: &str, targets: &[crate::ledger::schema::ProposalTarget]) -> String {
    let mut ids: Vec<&str> = targets.iter().map(|t| t.target_id.as_str()).collect();
    ids.sort_unstable();
    crate::ledger::schema::sha256_first128(
        format!("cerebro-mcp-attempt-v1\0{op_kind}\0{}", ids.join("\0")).as_bytes(),
    )
}

/// What a presented bearer resolves to: the endpoint's own token (from
/// `ensure`) is the default actor with no scope, a minted run token is its
/// run's grant, and anything else is unauthorized.
fn resolve_grant(presented: &str, base: &str, runs: &[(String, RunGrant)]) -> Option<RunGrant> {
    if presented == base {
        let mut grant = RunGrant::unrestricted(DEFAULT_ACTOR);
        // The panel's own turns are a run too, and its id comes from the
        // endpoint token like every other.
        grant.run_id = run_id_of(presented);
        return Some(grant);
    }
    runs.iter()
        .rev()
        .find(|(t, _)| t == presented)
        .map(|(_, g)| g.clone())
}

#[derive(serde::Serialize, Clone)]
pub struct McpInfo {
    pub url: String,
    pub token: String,
}

fn random_token() -> String {
    let mut rng = rand::thread_rng();
    (0..32)
        .map(|_| char::from(b'a' + rng.gen_range(0..26)))
        .collect()
}

impl McpState {
    /// Start the endpoint if it is not already up, and point it at `vault`.
    /// Idempotent: reopening a vault retargets the running server rather than
    /// leaking a second listener on a new port.
    pub fn ensure(&self, app: &AppHandle, vault: &Path) -> Result<McpInfo, String> {
        let mut guard = self.inner.lock().map_err(|_| "mcp state poisoned")?;
        if let Some(running) = guard.as_ref() {
            *running.vault.lock().map_err(|_| "vault lock poisoned")? = vault.to_path_buf();
            return Ok(McpInfo {
                url: format!("http://127.0.0.1:{}/mcp", running.port),
                token: running.token.clone(),
            });
        }

        let server = tiny_http::Server::http("127.0.0.1:0")
            .map_err(|e| format!("could not start the MCP endpoint: {e}"))?;
        let port = server
            .server_addr()
            .to_ip()
            .ok_or("MCP endpoint did not bind to an IP address")?
            .port();
        let running = Running {
            port,
            token: random_token(),
            vault: Arc::new(Mutex::new(vault.to_path_buf())),
            run_actors: Arc::new(Mutex::new(Vec::new())),
        };

        let handler = running.clone();
        let app = app.clone();
        std::thread::spawn(move || {
            for mut request in server.incoming_requests() {
                let mut body = String::new();
                let _ = request.as_reader().read_to_string(&mut body);
                // Authorization and attribution are one act: the bearer the
                // request presents names the run it came from, and that
                // run's actor stamps its writes (PR #5 security review).
                let grant = request.headers().iter().find_map(|h| {
                    if !h.field.equiv("Authorization") {
                        return None;
                    }
                    let presented = h.value.as_str().strip_prefix("Bearer ")?;
                    let runs = handler.run_actors.lock().ok()?;
                    resolve_grant(presented, &handler.token, &runs)
                });
                // JSON-RPC notifications carry no id and take no response
                // body. Verified against the real CLI: it sends
                // `notifications/initialized` right after `initialize` and is
                // happy with a bodyless 202.
                if grant.is_some() && is_notification(&body) {
                    let _ = request.respond(tiny_http::Response::empty(202));
                    continue;
                }
                let response = if let Some(grant) = grant.as_ref() {
                    handle_rpc(&app, &handler, grant, &body)
                } else {
                    json!({
                        "jsonrpc": "2.0", "id": Value::Null,
                        "error": { "code": -32001, "message": "unauthorized" }
                    })
                };
                let payload = response.to_string();
                let header = "Content-Type: application/json"
                    .parse::<tiny_http::Header>()
                    .expect("static header parses");
                let _ =
                    request.respond(tiny_http::Response::from_string(payload).with_header(header));
            }
        });

        let info = McpInfo {
            url: format!("http://127.0.0.1:{port}/mcp"),
            token: running.token.clone(),
        };
        *guard = Some(running);
        Ok(info)
    }

    /// Mint a bearer token for ONE run, bound to that run's actor (M13.4).
    /// None reads as the default actor. Written into that run's private MCP
    /// config and nowhere else; only the last few run tokens stay valid.
    pub fn run_token(
        &self,
        actor: Option<&str>,
        scope: Option<Vec<String>>,
        tools: Option<Vec<String>>,
    ) -> Result<String, String> {
        let guard = self.inner.lock().map_err(|_| "mcp state poisoned")?;
        let running = guard.as_ref().ok_or("the MCP endpoint is not running")?;
        let token = random_token();
        let mut runs = running
            .run_actors
            .lock()
            .map_err(|_| "run token lock poisoned")?;
        push_run_token(
            &mut runs,
            token.clone(),
            RunGrant {
                actor: normalize_actor(actor).to_string(),
                run_id: run_id_of(&token),
                // An empty declaration is not "everywhere" — a record that
                // declares `scope:` and lists nothing has scoped itself to
                // nothing, and the only safe reading of that is no writes.
                scope,
                // Same reading (M31.1b): an empty tools list grants no
                // dispatch, and only `None` — the panel — is unrestricted.
                tools,
            },
        );
        Ok(token)
    }

    pub fn info(&self) -> Option<McpInfo> {
        let guard = self.inner.lock().ok()?;
        let running = guard.as_ref()?;
        Some(McpInfo {
            url: format!("http://127.0.0.1:{}/mcp", running.port),
            token: running.token.clone(),
        })
    }
}

// ---------------------------------------------------------------------------
// JSON-RPC
// ---------------------------------------------------------------------------

/// A JSON-RPC notification: a method call with no `id` to respond to.
fn is_notification(body: &str) -> bool {
    serde_json::from_str::<Value>(body)
        .map(|v| v.get("method").is_some() && v.get("id").is_none())
        .unwrap_or(false)
}

fn handle_rpc(app: &AppHandle, running: &Running, grant: &RunGrant, body: &str) -> Value {
    let request: Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(e) => {
            return json!({
                "jsonrpc": "2.0", "id": Value::Null,
                "error": { "code": -32700, "message": format!("parse error: {e}") }
            })
        }
    };
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    let method = request.get("method").and_then(Value::as_str).unwrap_or("");

    let result = match method {
        "initialize" => Ok(json!({
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "cerebro", "version": env!("CARGO_PKG_VERSION") }
        })),
        // Notifications carry no id and expect no response body; returning an
        // empty result is harmless and keeps the handler total.
        "notifications/initialized" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": tool_catalog(proposals_enabled(app)) })),
        "tools/call" => {
            let params = request.get("params").cloned().unwrap_or(Value::Null);
            let name = params.get("name").and_then(Value::as_str).unwrap_or("");
            let args = params
                .get("arguments")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            call_tool(app, running, grant, name, &args)
        }
        other => Err(format!("unknown method: {other}")),
    };

    match result {
        Ok(value) => json!({ "jsonrpc": "2.0", "id": id, "result": value }),
        Err(message) => json!({
            "jsonrpc": "2.0", "id": id,
            "error": { "code": -32000, "message": message }
        }),
    }
}

/// MCP tool results are content blocks. Errors come back as `isError` content
/// rather than JSON-RPC errors so the agent can read and recover from them.
fn text_result(text: String) -> Value {
    json!({ "content": [{ "type": "text", "text": text }] })
}

fn error_result(message: String) -> Value {
    json!({ "content": [{ "type": "text", "text": message }], "isError": true })
}

fn schema(properties: Value, required: &[&str]) -> Value {
    json!({ "type": "object", "properties": properties, "required": required })
}

/// The hand-written tools: read, note-write, and UI. Twelve, spelled out.
///
/// Kept as literal `json!` entries in one scrapeable function because the TS
/// picker mirrors them by name (`src/engine/tools.ts`) and there is nothing
/// to derive them from — unlike the proposal surface below, which has an
/// artifact.
fn base_tools() -> Vec<Value> {
    vec![
        json!({
            "name": "get_vault_context",
            "description": "Orient yourself: the vault's types, saved views, projects, note counts, and how many captures are waiting in the Inbox. Call this first.",
            "inputSchema": schema(json!({}), &[])
        }),
        json!({
            "name": "search_notes",
            "description": "Full-text search over note titles, bodies, and frontmatter. Returns paths with matching excerpts.",
            "inputSchema": schema(json!({
                "query": { "type": "string", "description": "Text to search for" },
                "type": { "type": "string", "description": "Optional: only notes with this frontmatter type" },
                "limit": { "type": "number", "description": "Max results (default 20)" }
            }), &["query"])
        }),
        json!({
            "name": "get_note",
            "description": "Read one note in full: frontmatter and body. For knowledge/ concepts the derived trust tier is included.",
            "inputSchema": schema(json!({
                "path": { "type": "string", "description": "Vault-relative path, e.g. records/risks/r-1.md" }
            }), &["path"])
        }),
        json!({
            "name": "report_window_outcome",
            "description": "Background ingest only: report what you concluded about this run's change-window, once, at the end. `material` requires that you actually proposed something; `undetermined` names one blocked_reason. Say which of the four dimensions you evaluated.",
            "inputSchema": schema(json!({
                "outcome": { "type": "string", "enum": ["material", "non_material", "undetermined"], "description": "What you concluded about the window" },
                "explanation": { "type": "string", "description": "In your own words, why" },
                "evaluated_dimensions": { "type": "array", "items": { "type": "string", "enum": ["world_state", "belief_state", "evidence_state", "attention"] }, "description": "Which of the four you actually considered" },
                "material_dimensions": { "type": "array", "items": { "type": "string", "enum": ["world_state", "belief_state", "evidence_state", "attention"] }, "description": "Which of those moved. A subset of evaluated_dimensions." },
                "blocked_reason": { "type": "string", "enum": ["batch_input_incomplete", "policy_dependency_unavailable", "runtime_unavailable", "semantic_validation_failed", "source_access_lost"], "description": "Required when outcome is undetermined" }
            }), &["outcome", "explanation"])
        }),
        json!({
            // A literal, like every other entry: `base_tools` is scraped by
            // the TS parity test (`src/engine/tools.test.ts`), and a name
            // behind a constant is a name that test cannot see. The constant
            // is still the one truth — `the_submit_tool_the_prompt_names_is_the_one_served`
            // asserts the two agree.
            "name": "submit_answer",
            "description": "Attended synthesis only: submit the nine-part answer to the question this run was given, once. It is checked against the working-memory manifest the app assembled — every ref must name an item that manifest held, and the intended use must come back unchanged. A refusal names what to fix.",
            "inputSchema": schema(json!({
                "answer": { "type": "object", "description": "The SynthesisAnswer object, in the shape the prompt printed" }
            }), &["answer"])
        }),
        json!({
            "name": "list_inbox",
            "description": "Captures waiting to be organized: untyped notes the user has not yet filed.",
            "inputSchema": schema(json!({}), &[])
        }),
        json!({
            "name": "create_note",
            "description": "Create a note. Use for ordinary vault content, not knowledge concepts (use write_concept for those).",
            "inputSchema": schema(json!({
                "folder": { "type": "string", "description": "Vault-relative folder, '' for the root" },
                "slug": { "type": "string", "description": "Filename stem, kebab-case" },
                "frontmatter": { "type": "object", "description": "YAML frontmatter as a mapping" },
                "body": { "type": "string", "description": "Markdown body, starting with an H1" }
            }), &["folder", "slug", "body"])
        }),
        json!({
            "name": "update_frontmatter",
            "description": "Patch a note's frontmatter. Keys set to null are removed; untouched keys and key order are preserved.",
            "inputSchema": schema(json!({
                "path": { "type": "string" },
                "patch": { "type": "object", "description": "Keys to set; null deletes" }
            }), &["path", "patch"])
        }),
        json!({
            "name": "append_to_note",
            "description": "Append markdown to the end of an existing note's body.",
            "inputSchema": schema(json!({
                "path": { "type": "string" },
                "content": { "type": "string" }
            }), &["path", "content"])
        }),
        json!({
            "name": "write_concept",
            "description": "Create or replace a concept in the knowledge/ bundle (Open Knowledge Format). You maintain this bundle; the user only verifies it. Always record where a claim came from in `sources`. Never write `verified` — that is the human's stamp, and claiming it would defeat the review model.",
            "inputSchema": schema(json!({
                "path": { "type": "string", "description": "Path under knowledge/, e.g. knowledge/metrics/churn.md" },
                "type": { "type": "string", "description": "OKF concept type, e.g. Metric, Playbook, Reference" },
                "title": { "type": "string" },
                "description": { "type": "string", "description": "One sentence" },
                "about": {
                    "type": "array",
                    "description": "The vault entities this concept is knowledge OF, as wikilinks — e.g. [\"[[phoenix-warehouse-rollout]]\", \"[[risk-rollback-unrehearsed]]\"]. Distinct from `sources`: that is where the claim came from, this is what it is about. Anchor every concept you can; an unanchored concept cannot surface anywhere but the bundle.",
                    "items": { "type": "string" }
                },
                "body": { "type": "string", "description": "Markdown body. Favour structure: headings, tables, lists." },
                "tags": { "type": "array", "items": { "type": "string" } },
                "sources": {
                    "type": "array",
                    "description": "Where this came from. Each: {id, resource, title?}. `resource` may be a vault path or a URL.",
                    "items": { "type": "object" }
                },
                "supersedes": {
                    "type": "array",
                    "description": "Concepts this one REPLACES, as wikilinks. Use it instead of writing a second concept that contradicts an old one: the old concept stops being offered as current, and the record of what was believed before survives. Do not edit the concept being replaced.",
                    "items": { "type": "string" }
                },
                "refines": {
                    "type": "array",
                    "description": "Concepts this one narrows or makes more exact, as wikilinks. Both stay true — this is a hierarchy, not a correction.",
                    "items": { "type": "string" }
                },
                "contradicts": {
                    "type": "array",
                    "description": "Concepts this one disagrees with, where you cannot tell which is right. Say so rather than picking a winner; that judgement belongs to the person who owns the work.",
                    "items": { "type": "string" }
                },
                "lifecycle": { "type": "string", "description": "draft | stable | deprecated. Use deprecated when a concept is no longer true and nothing replaces it — a wrong concept left stable is worse than one that is gone." },
                "stale_after": { "type": "string", "description": "YYYY-MM-DD after which this should be rechecked" }
            }), &["path", "type", "title", "body"])
        }),
        json!({
            "name": "cache_source",
            "description": "Write down external material you just fetched — a Jira ticket, a Confluence page, a web page — as a local working doc under sources/. ALWAYS call this after fetching through a connector. The point is that the next question about the same thing reads a file instead of spending another round trip, so the copy has to exist locally before the conversation moves on. Check with search_notes whether a copy already exists before fetching at all.",
            "inputSchema": schema(json!({
                "id": { "type": "string", "description": "Issue key (PHX-421) or the URL you fetched" },
                "kind": { "type": "string", "description": "issue | web" },
                "title": { "type": "string" },
                "body": { "type": "string", "description": "The content, as markdown" },
                "source_url": { "type": "string", "description": "Canonical link back to the original" },
                "stale_after": { "type": "string", "description": "YYYY-MM-DD after which the copy should be refetched. Default: 30 days out." }
            }), &["id", "kind", "title", "body"])
        }),
        json!({
            "name": "propose_organize",
            "description": "Propose how to file an Inbox capture. This does NOT write — it shows the user an accept/reject card. Use it instead of editing a capture directly.",
            "inputSchema": schema(json!({
                "path": { "type": "string", "description": "The capture's path" },
                "type": { "type": "string", "description": "Suggested cerebro type" },
                "title": { "type": "string", "description": "Suggested H1, if the current one is unclear" },
                "properties": { "type": "object", "description": "Suggested frontmatter, e.g. status, priority, assignee" },
                "reasoning": { "type": "string", "description": "One or two sentences: why this filing" }
            }), &["path", "reasoning"])
        }),
        json!({
            "name": "open_note",
            "description": "Open a note in the cerebro UI so the user sees what you are talking about.",
            "inputSchema": schema(json!({ "path": { "type": "string" } }), &["path"])
        }),
        json!({
            "name": "navigate",
            "description": "Move the cerebro UI to a surface: home, inbox, knowledge, docs, or a saved view.",
            "inputSchema": schema(json!({
                "to": { "type": "string", "description": "home | inbox | knowledge | docs | view" },
                "id": { "type": "string", "description": "View id, when to = view" }
            }), &["to"])
        }),
    ]
}

// ---------------------------------------------------------------------------
// The proposal surface (M26.3c)
// ---------------------------------------------------------------------------

/// Every proposal tool's name is its op's, prefixed.
///
/// The prefix does two jobs. It keeps the namespace injective — `cache_source`
/// is BOTH an existing write tool and a policy op, and `propose_cache_source`
/// collides with neither — and it makes the surface say what it does: nothing
/// here mutates, it proposes, and the policy table decides what happens next.
pub const PROPOSAL_PREFIX: &str = "propose_";

/// The terminal tool. Named without the prefix because it proposes nothing:
/// it closes the run's set.
pub const COMMIT_TOOL: &str = "commit_proposals";

/// Served by base_tools as a literal (the TS parity test scrapes those
/// bytes — leave them); this const exists so SPAWN SITES never spell the
/// name: a drifted spelling would be silently dropped by narrow().
pub const REPORT_TOOL: &str = "report_window_outcome";

/// Same contract. propose_organize is hand-written, not generated from the
/// policy table (`proposal_op_of` says why), so proposal_tool_names() cannot
/// yield it.
pub const ORGANIZE_TOOL: &str = "propose_organize";

pub fn proposal_tool_name(op: &str) -> String {
    format!("{PROPOSAL_PREFIX}{op}")
}

/// Every generated proposal tool plus the terminal commit — the surface an
/// internal run needs to act on what it finds. Derived from the same table
/// that serves them: a hand-copied list at a spawn site would be the twin
/// inventory policy-is-data forbids. A table that fails to load yields only
/// the terminal commit — the run is narrowed harder, never wider
/// (fail-closed).
pub fn proposal_tool_names() -> Vec<String> {
    let mut names: Vec<String> = crate::policy::table::PolicyTable::load()
        .map(|table| {
            table
                .agent_facing_ops()
                .into_iter()
                .map(proposal_tool_name)
                .collect()
        })
        .unwrap_or_default();
    names.push(COMMIT_TOOL.to_string());
    names
}

/// The op a proposal tool name refers to, or `None` for anything else.
///
/// **Checked against the table, not just the prefix.** `propose_organize` is
/// a hand-written tool that predates this namespace and is not a policy op;
/// a bare `strip_prefix` would route it to the mutation boundary, and it
/// currently escapes only because its match arm happens to come first. Order
/// is not a security property, so the mapping asks the artifact.
fn proposal_op_of<'a>(tool: &'a str, table: &crate::policy::table::PolicyTable) -> Option<&'a str> {
    let op = tool.strip_prefix(PROPOSAL_PREFIX)?;
    table.agent_facing_ops().contains(&op).then_some(op)
}

/// **The registration gate.** Refuses to build any proposal tool unless this
/// build's safety machinery is bound in the table it is about to serve.
///
/// Registration is activation. The plan is explicit that the preventive
/// ancestry vectors and the semantic-receipt validator must be green before
/// the tools are registered — not merely before default-on — so the check
/// lives here, in front of the only function that can produce them, rather
/// than in a test that a shipped binary never runs.
fn registration_gate(table: &crate::policy::table::PolicyTable) -> Result<(), String> {
    // 1. The preventive anti-self-ancestry walk is BOUND, not merely
    //    implemented. Against the frozen format-1 table this names the absent
    //    binding rather than an unknown code (M26.3b).
    crate::policy::ancestry::table_binding(table)?;

    // 2. The semantic candidate receipt is required and can be refused. A
    //    create is the one mutation with no target to compare against, so a
    //    live create surface without a receipt requirement would be the §15
    //    hole with a tool attached to it.
    let create = table
        .op("create_belief")
        .ok_or("the table has no create_belief row")?;
    if !create
        .requires
        .iter()
        .any(|p| p == "candidate_receipt_current")
    {
        return Err(
            "create_belief does not require candidate_receipt_current — the live create surface \
             may not be registered against a table that does not demand a search"
                .to_string(),
        );
    }
    for code in [
        "candidate_receipt_missing",
        "candidate_receipt_caller_authored",
        "candidate_receipt_stale",
        "candidate_unconsidered",
    ] {
        if !create.possible_rejections.iter().any(|c| c == code) {
            return Err(format!(
                "create_belief cannot report {code} — the receipt rule would refuse under a code \
                 the op never declared"
            ));
        }
    }

    // 3. The contradiction-preservation gate is LIVE (M27.4). Every op that
    //    can compress a disagreement away requires the rule, can report both
    //    of its codes, and — the part only an artifact can say — the
    //    capability is available. A format-2 table is a valid table that
    //    simply has it unavailable, which is what M24 through M26 shipped;
    //    registering the merge and supersede surfaces against one now would
    //    serve tools that can retire a contradiction with nothing evaluating
    //    whether they addressed it.
    let addressing = &table.contradiction_addressing;
    let capability = table
        .capabilities
        .get(&addressing.capability)
        .ok_or_else(|| format!("the table has no {} capability", addressing.capability))?;
    if !capability.available {
        return Err(format!(
            "{} is unavailable in this table — the contradiction-preservation gate cannot be \
             registered against a table that predates it, because every op it protects would be \
             served with the rule switched off",
            addressing.capability
        ));
    }
    for op in &addressing.required_for_ops {
        let rule = table.op(op).ok_or_else(|| {
            format!("the addressing rule names {op}, which the table has no row for")
        })?;
        if !rule
            .requires
            .iter()
            .any(|p| p == "open_contradictions_addressed")
        {
            return Err(format!(
                "{op} can compress a contradiction away and does not require \
                 open_contradictions_addressed"
            ));
        }
        for code in [&addressing.omitted_rejection, &addressing.stale_rejection] {
            if !rule.possible_rejections.iter().any(|c| c == code) {
                return Err(format!(
                    "{op} cannot report {code} — the preservation rule would refuse under a code \
                     the op never declared"
                ));
            }
        }
    }
    Ok(())
}

/// The uniform envelope every proposal tool takes.
///
/// **`payload` is deliberately an open object.** A hand-written JSON Schema
/// per op would be a second copy of `ProposalOp`'s twenty closed variants,
/// free to drift from the frozen union — the twin-implementation defect this
/// codebase treats as review-blocking. The real validator is serde plus
/// `ProposalV1::validate`, which refuses a malformed payload as
/// `schema_invalid` (operational, so the ledger does not fill with typos).
/// What the schema constrains is the envelope, which is this layer's own.
fn proposal_schema() -> Value {
    schema(
        json!({
            "payload": {
                "type": "object",
                "description": "The op's payload, exactly as the closed ProposalOp variant for this op spells it."
            },
            "targets": {
                "type": "array",
                "description": "CAS set: [{target_id, target_class, expected_version}]. expected_version is null ONLY for something this proposal creates.",
                "items": { "type": "object" }
            },
            "reason": {
                "type": "string",
                "description": "Why, for a human reading the card. Display text with no policy effect — no rule reads it."
            },
            "declared_risk": {
                "type": "string",
                "description": "LOW | MEDIUM | HIGH | CRITICAL. May only RAISE the table's base risk; understating it is refused as risk_lowered."
            },
            "intended_use": {
                "type": "object",
                "description": "{kind, stakes, predicate_class} — what the resulting belief is FOR. Drives the high-stakes stopping rule."
            },
            "basis": {
                "type": "object",
                "description": "{transition_cause, evidence_refs, coverage_refs, authority_refs, authority_route_refs, addressed_contradictions, absence_claim}."
            }
        }),
        // `intended_use` and `basis` are REQUIRED, and that is a change of
        // mind: they were optional with synthesized defaults until an
        // attacker pointed out that omission was therefore the MODAL path,
        // not an edge case. A synthesized `draft_note`/`LOW` intended use
        // understates the stakes the high-stakes stopping rule reads, and a
        // synthesized `new_evidence` cause asserts a reason for the change
        // that nobody supplied. A proposal that cannot say what it is for
        // and why is not a proposal this server will carry.
        &["payload", "targets", "reason", "intended_use", "basis"],
    )
}

/// One sentence per op, generated from its table row.
///
/// Descriptions are agent-facing prompt surface and are reviewed like code —
/// which is the argument for deriving them from the artifact rather than
/// writing twenty of them by hand, where one could quietly come to describe a
/// risk the table does not assign.
fn describe(op: &str, rule: &crate::policy::table::OpRule) -> String {
    let applies = match rule.base_risk {
        crate::policy::table::Risk::Low | crate::policy::table::Risk::Medium => {
            "applies automatically if policy allows"
        }
        _ => "always waits for a person to approve it",
    };
    format!(
        "Propose `{op}` ({}). It {applies}. Touches: {}. Nothing applies until you call \
         `{COMMIT_TOOL}`; policy may still refuse it, and a refusal names the rule.",
        rule.base_risk.as_str(),
        rule.target_classes.join(", "),
    )
}

/// Every proposal tool this build serves, GENERATED from the loaded table.
///
/// There is no second list. The names come from the artifact's agent-facing
/// ops, so an op added to the table is offered the moment it lands and an op
/// marked `agent_facing: false` is not offered at all — and the tripwire in
/// `policy::submit` proves the served set and the artifact agree in both
/// directions.
pub fn proposal_tools(table: &crate::policy::table::PolicyTable) -> Result<Vec<Value>, String> {
    registration_gate(table)?;
    let mut tools: Vec<Value> = table
        .agent_facing_ops()
        .into_iter()
        .map(|op| {
            let rule = table.op(op).expect("agent_facing_ops names table rows");
            json!({
                "name": proposal_tool_name(op),
                "description": describe(op, rule),
                "inputSchema": proposal_schema(),
            })
        })
        .collect();
    tools.push(json!({
        "name": COMMIT_TOOL,
        "description": "Close this run's proposal set and decide it as one atomic batch. Nothing you proposed has been applied before this call. Returns each proposal's outcome: applied, queued for a person, or rejected with the rule that refused it.",
        "inputSchema": schema(
            json!({
                "proposal_ids": {
                    "type": "array",
                    "description": "The proposals to commit, in order. All must belong to this run.",
                    "items": { "type": "string" }
                }
            }),
            &["proposal_ids"],
        )
    }));
    Ok(tools)
}

/// Is the proposal surface switched on for this install?
///
/// Reads `agentProposalsEnabled` from the app config on every `tools/list`,
/// so turning it off takes effect for the next run rather than the next
/// launch. Every failure path — no config dir, no file, corrupt JSON —
/// resolves to OFF.
fn proposals_enabled(app: &AppHandle) -> bool {
    use tauri::Manager;
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| crate::app_config::load(&dir).agent_proposals_enabled)
        .unwrap_or(false)
}

/// What `tools/list` serves.
///
/// The proposal half is absent unless the switch is on AND the gate passes.
/// A gate failure is recorded operationally rather than swallowed: a server
/// that quietly served twelve tools when it was asked for thirty-two would be
/// indistinguishable from one that was switched off.
pub fn tool_catalog(proposals_enabled: bool) -> Vec<Value> {
    let mut tools = base_tools();
    if !proposals_enabled {
        return tools;
    }
    let Ok(table) = crate::policy::table::PolicyTable::load() else {
        return tools;
    };
    match proposal_tools(&table) {
        Ok(mut generated) => tools.append(&mut generated),
        Err(detail) => {
            if let Ok(refusal) = crate::policy::rejection::OperationalRefusal::new(
                &table,
                "capability_unavailable",
                "mcp_proposal_registration",
                &detail,
            ) {
                crate::runtime::sink::record(
                    &refusal,
                    &crate::runtime::operational::LogEntry::bare(),
                );
            }
        }
    }
    tools
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

fn arg_str(args: &Map<String, Value>, key: &str) -> Option<String> {
    args.get(key).and_then(Value::as_str).map(str::to_string)
}

/// The vault path a write tool is aimed at, for the scope check (M17.13).
///
/// Centralised here rather than inside each tool so that adding a write tool
/// cannot accidentally add an unscoped one. A name this does not recognise
/// falls through to `None`, which means UNSCOPED — so the claim that a future
/// write "will be caught" is only as true as the tripwire, and until M26.3d
/// the tripwire named three tools and never looked at the catalog. It now
/// partitions the whole served catalog into scoped and
/// explicitly-exempt-with-a-reason, so a new tool in neither half fails.
fn write_target(name: &str, args: &Map<String, Value>) -> Option<String> {
    match name {
        // create_note names a folder and a title; the file lands inside the
        // folder, so the folder is what has to be in scope.
        "create_note" => Some(arg_str(args, "folder").unwrap_or_default()),
        "update_frontmatter" | "append_to_note" => arg_str(args, "path"),
        _ => None,
    }
}

/// M31.1b — the refusal an un-granted tool name earns, or `None` if the
/// grant permits dispatch.
///
/// A function beside the check that uses it, like `may_write`, so the tests
/// can hold the refusal itself. BOTH sides are normalized to the short
/// spelling: loopback names arrive short, but a caller presenting the full
/// `mcp__cerebro__` form names the same tool, and a grant DECLARED in the
/// full form must admit the short-spelled call the loopback actually
/// receives — a one-sided strip would refuse it, fail-closed but a silent
/// drift channel. `MCP_PREFIX` lives in `agent/mod.rs` so the two spellings
/// cannot drift.
fn ungranted_tool_refusal(grant: &RunGrant, name: &str) -> Option<String> {
    let tools = grant.tools.as_ref()?;
    let strip = |t: &str| -> String {
        t.strip_prefix(crate::agent::MCP_PREFIX)
            .unwrap_or(t)
            .to_string()
    };
    let short = strip(name);
    // Equal names strip to equal names, so this one comparison also covers
    // the verbatim `t == name` case.
    if tools.iter().any(|t| strip(t) == short) {
        return None;
    }
    Some(format!(
        "This run is granted {} and cannot call {name}.",
        if tools.is_empty() {
            "nothing".to_string()
        } else {
            tools.join(", ")
        }
    ))
}

const PREFERENCES_REFUSAL: &str =
    "`preferences` is the user's memory for this agent and cannot be written by a run. Put what \
you learned in `recent`, or record it as a concept with write_concept.";

/// M17.14 — may this run write the `preferences` tier?
///
/// It may not, if it carries a process identity — which is exactly the set of
/// runs a vault file started. An agent that can rewrite the corrections made to
/// it does not have preferences, it has notes, and the tier only means anything
/// if the run it governs cannot reach it. A person editing the same field in
/// the record panel goes through the human write path and never touches this.
fn writes_preferences(actor: &str, name: &str, args: &Map<String, Value>) -> bool {
    if name != "update_frontmatter" || actor == DEFAULT_ACTOR {
        return false;
    }
    args.get("patch")
        .and_then(Value::as_object)
        .is_some_and(|patch| patch.contains_key("preferences"))
}

fn call_tool(
    app: &AppHandle,
    running: &Running,
    grant: &RunGrant,
    name: &str,
    args: &Map<String, Value>,
) -> Result<Value, String> {
    let vault = running
        .vault
        .lock()
        .map_err(|_| "vault lock poisoned")?
        .clone();

    // M17.13 — scope is enforced HERE, before the tool runs, and it is a
    // refusal rather than a request. An agent bound to `projects/atlas` cannot
    // write outside it even if its instructions, or a note it just read, tell
    // it to. `write_concept` and `cache_source` are deliberately exempt: the
    // knowledge bundle and the source cache have their own guards (M17.1) and
    // an agent's whole job may be to record what it found, which is not the
    // same permission as editing the user's records.
    if let Some(target) = write_target(name, args) {
        if !grant.may_write(&target) {
            return Ok(error_result(format!(
                "This run is scoped to {} and cannot write to {target}.",
                grant
                    .scope
                    .as_ref()
                    .map(|s| if s.is_empty() {
                        "nothing".to_string()
                    } else {
                        s.join(", ")
                    })
                    .unwrap_or_default()
            )));
        }
    }

    // M31.1b — reads were the one surface the grant did not bound. Checked
    // exactly like scope: a name outside the grant is refused before any
    // tool body runs. And exactly like scope's refusal above, this is a
    // plain error_result the model can read — no OperationalRefusal, no
    // operational_log row. Deliberate, and symmetric: if either refusal
    // ever starts recording operationally, both change together.
    if let Some(refusal) = ungranted_tool_refusal(grant, name) {
        return Ok(error_result(refusal));
    }

    if writes_preferences(&grant.actor, name, args) {
        return Ok(error_result(PREFERENCES_REFUSAL.to_string()));
    }

    let actor = grant.actor.as_str();
    let outcome = match name {
        "get_vault_context" => tool_vault_context(&vault),
        "search_notes" => tool_search(&vault, args),
        "get_note" => tool_get_note(&vault, args),
        "list_inbox" => tool_list_inbox(&vault),
        "create_note" => tool_create_note(&vault, args),
        "update_frontmatter" => tool_update_frontmatter(&vault, args),
        "append_to_note" => tool_append(&vault, args),
        "write_concept" => tool_write_concept(&vault, args, actor),
        "cache_source" => tool_cache_source(&vault, args, actor),
        "propose_organize" => tool_propose_organize(app, args),
        "report_window_outcome" => tool_report_window_outcome(args, grant),
        name if name == crate::assembly::prompt::SUBMIT_TOOL => tool_submit_answer(args, grant),
        "open_note" => tool_ui(app, "open_note", args),
        "navigate" => tool_ui(app, "navigate", args),
        // The proposal surface. Gated twice: the switch decides whether the
        // tools are ever LISTED, and this decides whether a name that was
        // guessed rather than listed can be CALLED. A model that remembered
        // `propose_update_belief` from a previous install must not reach the
        // mutation boundary on an install where the surface is off.
        COMMIT_TOOL if proposals_enabled(app) => tool_commit_proposals(&vault, args, grant),
        other => match crate::policy::table::PolicyTable::load()
            .ok()
            .filter(|_| proposals_enabled(app))
            .and_then(|table| proposal_op_of(other, &table).map(str::to_string))
        {
            Some(op) => tool_propose(&vault, args, grant, &op),
            None => Err(format!("unknown tool: {other}")),
        },
    };

    // A failing tool must reach the model as readable content, not as a
    // transport error it cannot see or recover from.
    Ok(match outcome {
        Ok(value) => value,
        Err(message) => error_result(message),
    })
}

/// A proposal-boundary answer, as the model sees it.
///
/// **Never collapsed into an error.** `queued` and `rejected` are the two
/// outcomes this whole milestone exists to produce, and `call_tool` turns
/// every handler `Err` into `isError` content — so returning a queued HIGH
/// card as `Err` would tell the model its proposal failed when in fact a
/// person is about to look at it. The store-layer never-throw rule is for
/// human UI actions; AGENTS.md exempts proposal channels by name, and this is
/// the channel it means.
fn typed_result(value: Value) -> Result<Value, String> {
    Ok(text_result(
        serde_json::to_string_pretty(&value).unwrap_or_else(|e| e.to_string()),
    ))
}

/// One proposal, submitted. Nothing applies until `commit_proposals`.
fn tool_propose(
    vault: &Path,
    args: &Map<String, Value>,
    grant: &RunGrant,
    op_kind: &str,
) -> Result<Value, String> {
    let table = crate::policy::table::PolicyTable::load()?;
    // The name was generated from the table, so a call naming an op the
    // table does not carry — or one the artifact marks not agent-facing —
    // did not come from the catalog we served.
    if !table.agent_facing_ops().contains(&op_kind) {
        return Err(format!(
            "{op_kind} is not an op an agent may propose on this build"
        ));
    }

    // SERVER-STAMPED, never taken from arguments: the op kind comes from the
    // tool name, the actor and run from the bearer token, and the proposal id
    // from both. A caller that could name its own run could sweep another
    // run's queued proposals into its commit set.
    let op_value = json!({
        "kind": op_kind,
        "payload": args.get("payload").cloned().unwrap_or(Value::Null),
    });
    let op: crate::ledger::schema::ProposalOp = serde_json::from_value(op_value)
        .map_err(|e| format!("the payload is not a valid {op_kind}: {e}"))?;

    let targets: Vec<crate::ledger::schema::ProposalTarget> =
        serde_json::from_value(args.get("targets").cloned().unwrap_or(json!([])))
            .map_err(|e| format!("targets: {e}"))?;
    let reason = arg_str(args, "reason").unwrap_or_default();
    let declared_risk: crate::policy::table::Risk = match args.get("declared_risk") {
        Some(value) => {
            serde_json::from_value(value.clone()).map_err(|e| format!("declared_risk: {e}"))?
        }
        // Absent means "the table's own base risk" — the honest default. A
        // caller cannot LOWER it (that is `risk_lowered`), so defaulting can
        // only ever be as strict as the table.
        None => {
            table
                .op(op_kind)
                .ok_or_else(|| format!("{op_kind} is not in the policy table"))?
                .base_risk
        }
    };
    // NO DEFAULTS. Synthesizing these would have the server assert, on the
    // caller's behalf, both what the change is FOR (which the high-stakes
    // stopping rule reads) and WHY it is happening (which the silence rules
    // read). Absent means the caller did not say, and the honest answer to
    // that is a refusal the caller can act on.
    let intended_use: crate::ledger::schema::IntendedUse = serde_json::from_value(
        args.get("intended_use")
            .cloned()
            .ok_or("intended_use is required: say what this change is for")?,
    )
    .map_err(|e| format!("intended_use: {e}"))?;
    let basis: crate::ledger::schema::ProposalBasis = serde_json::from_value(
        args.get("basis")
            .cloned()
            .ok_or("basis is required: say why this change is happening")?,
    )
    .map_err(|e| format!("basis: {e}"))?;

    // THE HUMAN'S OWN STAMP IS NOT AN AGENT FIELD. `knowledge/` is
    // agent-written and human-VERIFIED, and `write_concept` has refused a
    // `verified` field since M23 — but that guard sits on the note-writing
    // tools, and this is a fourth door into the same subtree that never
    // passes it. An agent that could patch `/fields/verified` would be
    // signing the review it exists to be checked by.
    //
    // Checked on the serialized op so it catches the field wherever a payload
    // spells it — a patch path, a fields object, a split output.
    let serialized = serde_json::to_string(&op).unwrap_or_default();
    if serialized.contains("verified") {
        return Err(
            "`verified` is the user's stamp on a concept and is never yours to set — it is \
             recorded by verify_concept, which is the human's own act"
                .to_string(),
        );
    }

    // The in-session retry bound (M26.4g). The policy table says which
    // refusals may be resubmitted and how many times; this is where the
    // count lives, because the count is per RUN and the run is the bearer.
    //
    // Checked BEFORE submitting: a resubmission the table forbids should not
    // cost another policy evaluation, and more to the point, an agent that
    // keeps asking should be told to stop rather than quietly re-refused
    // until it gives up.
    let key = (grant.run_id.clone(), work_key(op_kind, &targets));
    let digest = crate::ledger::schema::sha256_first128(
        format!(
            "{}\0{}\0{}\0{}\0{}\0{reason}",
            serde_json::to_string(&op).unwrap_or_default(),
            serde_json::to_string(&targets).unwrap_or_default(),
            serde_json::to_string(&declared_risk).unwrap_or_default(),
            serde_json::to_string(&intended_use).unwrap_or_default(),
            serde_json::to_string(&basis).unwrap_or_default(),
        )
        .as_bytes(),
    );
    if let Some(prior) = attempts().lock().ok().and_then(|m| m.get(&key).cloned()) {
        if prior.digest == digest {
            return typed_result(json!({
                "outcome": "refused",
                "code": "retry_unchanged",
                "detail": format!(
                    "this is byte-for-byte the proposal that was refused with {}. A refusal is                      an answer — read it and change something, or say the window is blocked.",
                    prior.code
                ),
            }));
        }
        match table.retry_verdict(&prior.code, prior.count) {
            crate::policy::table::RetryVerdict::Retry => {}
            crate::policy::table::RetryVerdict::Exhausted => {
                return typed_result(json!({
                    "outcome": "refused",
                    "code": "retry_exhausted",
                    "detail": format!(
                        "{} attempts on this work have been refused with {}. The window is                          blocked; say so rather than trying again.",
                        prior.count, prior.code
                    ),
                }));
            }
            crate::policy::table::RetryVerdict::NotRetryable => {
                return typed_result(json!({
                    "outcome": "refused",
                    "code": "retry_not_permitted",
                    "detail": format!(
                        "{} is a refusal about what this change IS, not about the state of the                          request. Resubmitting it is not an adjustment.",
                        prior.code
                    ),
                }));
            }
        }
    }

    let actor = crate::ledger::schema::Actor {
        id: grant.actor.clone(),
    };
    let run_id = grant.run_id.clone();

    crate::ledger::shadow::with_writer(vault, |writer| {
        let head = writer.head();
        // The proposal's id is derived from the run and the op, so a retry
        // after a lost acknowledgement replays instead of duplicating.
        let proposal_id = crate::ledger::schema::sha256_first128(
            format!(
                "cerebro-mcp-proposal-v1\0{run_id}\0{op_kind}\0{}",
                serde_json::to_string(&op).unwrap_or_default()
            )
            .as_bytes(),
        );

        // THE RECEIPT IS MINTED HERE, never accepted from the caller. A
        // create is the one mutation with no target to compare against, and
        // the whole value of the receipt is that the SERVER ran the lookups.
        let candidate_search_receipt = match &op {
            crate::ledger::schema::ProposalOp::CreateBelief {
                subject,
                content,
                fields,
                ..
            } => {
                let crate::ledger::schema::SubjectRef::Resolved { entity_id, aliases } = subject
                else {
                    return Err("a created belief's subject must be resolved".to_string());
                };
                let mut queries = aliases.clone();
                if let Some(more) = fields.get("aliases").and_then(Value::as_array) {
                    queries.extend(more.iter().filter_map(|a| a.as_str().map(str::to_string)));
                }
                queries.sort();
                queries.dedup();
                let index_head = crate::policy::candidates::index_head_of(head.as_ref());
                Some(crate::policy::candidates::mint(
                    &crate::ledger::concepts::current_state(writer, vault)?,
                    &index_head,
                    entity_id,
                    queries.first().map(String::as_str).unwrap_or_default(),
                    &queries,
                    content,
                )?)
            }
            _ => None,
        };

        let proposal = crate::ledger::schema::ProposalV1 {
            schema: crate::ledger::schema::PROPOSAL_SCHEMA,
            proposal_id,
            run_id: run_id.clone(),
            targets,
            op,
            intended_use,
            basis,
            declared_risk,
            reason,
            candidate_search_receipt,
        };
        match crate::policy::commit::submit_proposal(&table, writer, &actor, &proposal) {
            Ok(id) => {
                // The work landed, so the run's allowance for it is spent
                // and irrelevant. Clearing rather than keeping means a LATER
                // piece of work on the same targets starts fresh, which is
                // right: the count bounds retries of a refusal, not the
                // number of times a run may touch a belief.
                if let Ok(mut map) = attempts().lock() {
                    map.remove(&key);
                }
                // The server's own record of what it accepted, for the
                // window report. Never assembled from what the caller says.
                record_submission(&run_id, &id);
                Ok(json!({ "outcome": "submitted", "proposal_id": id }))
            }
            // A typed refusal is an ANSWER, not a transport failure: it names
            // the rule and what it expected, which is what the model needs in
            // order to do something different.
            Err(error) => {
                if let Ok(mut map) = attempts().lock() {
                    let entry = map.entry(key.clone()).or_insert(Attempt {
                        count: 0,
                        code: String::new(),
                        digest: String::new(),
                    });
                    entry.count += 1;
                    entry.code = error.code.to_string();
                    entry.digest = digest.clone();
                }
                Ok(json!({
                    "outcome": "refused",
                    "code": error.code,
                    "detail": error.detail,
                }))
            }
        }
    })
    .ok_or_else(|| {
        "this vault has no active ledger writer, so nothing can be proposed against it".to_string()
    })?
    .and_then(typed_result_value)
}

fn typed_result_value(value: Value) -> Result<Value, String> {
    typed_result(value)
}

/// Close the run's set and decide it atomically.
fn tool_commit_proposals(
    vault: &Path,
    args: &Map<String, Value>,
    grant: &RunGrant,
) -> Result<Value, String> {
    let table = crate::policy::table::PolicyTable::load()?;
    let ids: Vec<String> =
        serde_json::from_value(args.get("proposal_ids").cloned().unwrap_or(json!([])))
            .map_err(|e| format!("proposal_ids: {e}"))?;
    if ids.is_empty() {
        return Err("a commit set with no members is not a set".to_string());
    }
    // The RUN comes from the bearer token. `commit_proposals` refuses members
    // belonging to another run, and this is what makes that check meaningful:
    // a caller cannot name a run it does not hold the token for.
    let run_id = grant.run_id.clone();
    crate::ledger::shadow::with_writer(
        vault,
        |writer| match crate::policy::commit::commit_proposals(&table, writer, vault, &run_id, &ids)
        {
            Ok(outcome) => Ok(json!({
                "commit_set_id": outcome.commit_set_id,
                "transition": outcome.transition.as_str(),
                "results": outcome.results,
                "batch_id": outcome.batch_id,
                "replayed": outcome.replayed,
            })),
            Err(error) => Ok(json!({
                "outcome": "refused",
                "code": error.code,
                "detail": error.detail,
            })),
        },
    )
    .ok_or_else(|| {
        "this vault has no active ledger writer, so nothing can be committed against it".to_string()
    })?
    .and_then(typed_result_value)
}

/// Writes go straight to disk, so the UI must be told to rescan — the
/// watcher suppresses events for writes the app itself made.
fn notify_vault_changed(app: &AppHandle) {
    let _ = app.emit(UI_ACTION_EVENT, json!({ "action": "vault_changed" }));
}

fn tool_vault_context(vault: &Path) -> Result<Value, String> {
    let entries = vault::scan::scan_vault(vault)?;
    let mut types: Vec<String> = entries
        .iter()
        .filter_map(|e| e.entry_type.clone())
        .filter(|t| t != "Type")
        .collect();
    types.sort();
    types.dedup();

    let projects: Vec<String> = entries
        .iter()
        .filter(|e| e.filename == "project.md")
        .map(|e| format!("{} ({})", e.title, e.path))
        .collect();
    let concepts = entries
        .iter()
        .filter(|e| crate::knowledge::is_knowledge_path(&e.path))
        .count();
    let inbox = entries.iter().filter(|e| is_capture(e)).count();

    Ok(text_result(format!(
        "Vault: {}\n\nNotes: {}\nTypes in use: {}\nContainers:\n{}\n\nKnowledge concepts: {}\nInbox captures waiting: {}\n\nConventions: notes are markdown with YAML frontmatter. A TYPED note is a record of its type; an untyped note is a doc — the two never blend. Types are declared by `type: Type` docs in types/ (their fields:, statuses:, folder:, and views: keys are the schema); records default to records/<plural>/. A Collection is a folder holding collection.yml (legacy project.md folders read as Collections); Lists are *.list.yml files inside one. The knowledge/ bundle is yours to maintain (Open Knowledge Format) and the user's to verify.",
        vault.display(),
        entries.len(),
        types.join(", "),
        if projects.is_empty() { "  (none)".to_string() } else { projects.iter().map(|p| format!("  - {p}")).collect::<Vec<_>>().join("\n") },
        concepts,
        inbox,
    )))
}

/// Mirrors engine/inbox.ts: an explicit `_organized` wins, else untyped
/// means unorganized. Structural files never queue.
fn is_capture(entry: &vault::entry::Entry) -> bool {
    if entry.filename == "project.md"
        || entry.filename == "index.md"
        || entry.filename == "log.md"
        || entry.entry_type.as_deref() == Some("Type")
        || entry.path.starts_with("templates/")
        || crate::knowledge::is_knowledge_path(&entry.path)
    {
        return false;
    }
    match entry.properties.get("_organized").and_then(Value::as_bool) {
        Some(organized) => !organized,
        None => entry.entry_type.is_none(),
    }
}

fn tool_search(vault: &Path, args: &Map<String, Value>) -> Result<Value, String> {
    let query = arg_str(args, "query").ok_or("search_notes needs a query")?;
    let type_filter = arg_str(args, "type");
    let limit = args
        .get("limit")
        .and_then(Value::as_u64)
        .unwrap_or(20)
        .min(100) as usize;

    // Every body is read either way — the old substring search did the same —
    // so ranking costs arithmetic over data already in hand and no index
    // (M17.19). Kept as one materialised corpus because `Doc` borrows it.
    let entries: Vec<vault::entry::Entry> = vault::scan::scan_vault(vault)?
        .into_iter()
        .filter(|e| match &type_filter {
            Some(wanted) => e.entry_type.as_deref() == Some(wanted.as_str()),
            None => true,
        })
        .collect();
    let bodies: Vec<String> = entries
        .iter()
        .map(|e| vault::write::read_note(vault, &e.path).unwrap_or_default())
        .collect();
    let docs: Vec<crate::search::Doc> = entries
        .iter()
        .zip(bodies.iter())
        .map(|(e, body)| crate::search::Doc {
            path: &e.path,
            title: &e.title,
            kind: e.entry_type.as_deref(),
            body,
        })
        .collect();

    let ranked = crate::search::rank(&query, &docs, limit);
    if ranked.hits.is_empty() {
        return Ok(text_result(format!("No notes matched \"{query}\".")));
    }

    let lines: Vec<String> = ranked
        .hits
        .iter()
        .map(|hit| {
            let entry = &entries[hit.index];
            let excerpt = if hit.excerpt.is_empty() {
                entry.snippet.clone()
            } else {
                hit.excerpt.clone()
            };
            format!(
                "- {} — {}{}\n  {}",
                entry.path,
                entry.title,
                entry
                    .entry_type
                    .as_deref()
                    .map(|t| format!(" [{t}]"))
                    .unwrap_or_default(),
                excerpt
            )
        })
        .collect();

    Ok(text_result(format!(
        "{} match(es) for \"{}\"{}:\n{}",
        lines.len(),
        query,
        // Said out loud: an agent handed loose matches as if they were tight
        // ones will report them to the user as the answer.
        if ranked.widened {
            " (no note contained every term — closest matches, best first)"
        } else {
            " (best first)"
        },
        lines.join("\n")
    )))
}

fn tool_get_note(vault: &Path, args: &Map<String, Value>) -> Result<Value, String> {
    let path = arg_str(args, "path").ok_or("get_note needs a path")?;
    let entries = vault::scan::scan_vault(vault)?;
    let entry = entries
        .iter()
        .find(|e| e.path == path)
        .ok_or_else(|| format!("no note at {path}"))?;
    let body = vault::write::read_note(vault, &path)?;

    let mut header = format!(
        "Path: {}\nTitle: {}\nType: {}\n",
        entry.path,
        entry.title,
        entry
            .entry_type
            .clone()
            .unwrap_or_else(|| "(untyped)".into())
    );
    if crate::knowledge::is_knowledge_path(&path) {
        header.push_str(&format!("Trust: {}\n", trust_tier(entry)));
    }
    if !entry.properties.is_empty() {
        header.push_str(&format!(
            "Frontmatter: {}\n",
            serde_json::to_string_pretty(&entry.properties).unwrap_or_default()
        ));
    }
    Ok(text_result(format!("{header}\n---\n{body}")))
}

/// Mirrors engine/okf.ts trustTier: derived from `verified`, never stored.
fn trust_tier(entry: &vault::entry::Entry) -> &'static str {
    let Some(verified) = entry.properties.get("verified") else {
        return "unverified";
    };
    let stamps: Vec<&Value> = match verified {
        Value::Array(list) => list.iter().collect(),
        other => vec![other],
    };
    let mut any = false;
    for stamp in stamps {
        let Some(by) = stamp.get("by").and_then(Value::as_str) else {
            continue;
        };
        any = true;
        if by.starts_with("human:") {
            return "human-reviewed";
        }
    }
    if any {
        "machine-confirmed"
    } else {
        "unverified"
    }
}

fn tool_list_inbox(vault: &Path) -> Result<Value, String> {
    let entries = vault::scan::scan_vault(vault)?;
    let captures: Vec<String> = entries
        .iter()
        .filter(|e| is_capture(e))
        .map(|e| format!("- {} — {}\n  {}", e.path, e.title, e.snippet))
        .collect();
    Ok(text_result(if captures.is_empty() {
        "The Inbox is empty.".to_string()
    } else {
        format!(
            "{} capture(s) waiting:\n{}",
            captures.len(),
            captures.join("\n")
        )
    }))
}

/// M13.5 tells the agent it never creates or modifies `type: Type` docs —
/// they are the vault's schema, and schema changes go through people. A rule
/// only the prompt holds is a suggestion to an unattended run (PR #5 review),
/// so the write tools refuse here rather than trusting the model to remember.
const TYPE_DOC_REFUSAL: &str = "type: Type docs are the vault's schema and are changed by \
     people, not by agent runs. Tell the user what schema change you need instead.";

fn is_type_doc(vault: &Path, rel: &str) -> bool {
    vault::write::note_type(vault, rel).as_deref() == Some("Type")
}

fn declares_type_doc(frontmatter: &Map<String, Value>) -> bool {
    frontmatter.get("type").and_then(Value::as_str) == Some("Type")
}

fn tool_create_note(vault: &Path, args: &Map<String, Value>) -> Result<Value, String> {
    let folder = arg_str(args, "folder").unwrap_or_default();
    let slug = arg_str(args, "slug").ok_or("create_note needs a slug")?;
    let body = arg_str(args, "body").unwrap_or_default();
    let frontmatter = args
        .get("frontmatter")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    if declares_type_doc(&frontmatter) {
        return Err(TYPE_DOC_REFUSAL.into());
    }
    // The folder is what decides where this lands, so it is what gets checked
    // (M17.1). A concept authored here would arrive with whatever provenance
    // the model chose to type, including a `verified` stamp it may not make.
    crate::knowledge::guard_agent_write(&folder)?;
    let path = vault::write::create_note(vault, &folder, &slug, &frontmatter, &body)?;
    Ok(text_result(format!("Created {path}")))
}

fn tool_update_frontmatter(vault: &Path, args: &Map<String, Value>) -> Result<Value, String> {
    let path = arg_str(args, "path").ok_or("update_frontmatter needs a path")?;
    let patch = args
        .get("patch")
        .and_then(Value::as_object)
        .cloned()
        .ok_or("update_frontmatter needs a patch object")?;
    // Both directions are schema changes: editing a Type doc, and retyping
    // an ordinary note INTO one.
    if is_type_doc(vault, &path) || declares_type_doc(&patch) {
        return Err(TYPE_DOC_REFUSAL.into());
    }
    // The self-certification hole (M17.1): this tool could patch `verified`
    // onto any concept, which is exactly what write_concept refuses to do.
    crate::knowledge::guard_agent_write(&path)?;
    vault::write::update_frontmatter(vault, &path, &patch)?;
    Ok(text_result(format!("Updated frontmatter on {path}")))
}

fn tool_append(vault: &Path, args: &Map<String, Value>) -> Result<Value, String> {
    let path = arg_str(args, "path").ok_or("append_to_note needs a path")?;
    let content = arg_str(args, "content").ok_or("append_to_note needs content")?;
    if is_type_doc(vault, &path) {
        return Err(TYPE_DOC_REFUSAL.into());
    }
    // Least severe of the three, still a bypass (M17.1): a concept body grown
    // here carries no `sources`, no updated `generated`, and no dedup check.
    crate::knowledge::guard_agent_write(&path)?;
    let existing = vault::write::read_note(vault, &path)?;
    let joined = format!("{}\n\n{}\n", existing.trim_end(), content.trim());
    vault::write::save_note(vault, &path, &joined)?;
    Ok(text_result(format!("Appended to {path}")))
}

fn tool_write_concept(
    vault: &Path,
    args: &Map<String, Value>,
    actor: &str,
) -> Result<Value, String> {
    let path = arg_str(args, "path").ok_or("write_concept needs a path")?;
    if !crate::knowledge::is_knowledge_path(&path) {
        return Err(format!(
            "write_concept only writes into the knowledge/ bundle; {path} is outside it"
        ));
    }
    // A concept typed "Type" would scan as schema (the scanner reads the
    // frontmatter, not the folder) — the one thing no agent tool may author.
    if arg_str(args, "type").as_deref() == Some("Type") {
        return Err(TYPE_DOC_REFUSAL.into());
    }
    let body = arg_str(args, "body").ok_or("write_concept needs a body")?;

    let mut frontmatter = Map::new();
    frontmatter.insert(
        "type".into(),
        json!(arg_str(args, "type").unwrap_or_else(|| "Reference".into())),
    );
    if let Some(title) = arg_str(args, "title") {
        frontmatter.insert("title".into(), json!(title));
    }
    if let Some(description) = arg_str(args, "description") {
        frontmatter.insert("description".into(), json!(description));
    }
    // `about` anchors the concept to the entities it describes (M8.1) — the
    // join that lets knowledge reach a project page instead of only ever
    // being reachable from inside the bundle.
    if let Some(about) = args.get("about") {
        frontmatter.insert("about".into(), about.clone());
    }
    if let Some(tags) = args.get("tags") {
        frontmatter.insert("tags".into(), tags.clone());
    }
    // Concept-to-concept relations (M8.7). `supersedes` is the one that
    // retires something: without it the bundle can only ever append, and a
    // corrected fact sits beside the fact it corrected with nothing saying
    // which one won.
    for field in ["supersedes", "refines", "contradicts"] {
        if let Some(value) = args.get(field) {
            frontmatter.insert(field.into(), value.clone());
        }
    }
    frontmatter.insert(
        "lifecycle".into(),
        json!(arg_str(args, "lifecycle").unwrap_or_else(|| "draft".into())),
    );
    // Provenance is stamped by US, not by the model: an agent that could
    // choose its own `generated.by` could disclaim its own output.
    frontmatter.insert("generated".into(), json!({ "by": actor, "at": now_iso() }));
    if let Some(sources) = args.get("sources") {
        frontmatter.insert("sources".into(), sources.clone());
    }
    if let Some(stale_after) = arg_str(args, "stale_after") {
        frontmatter.insert("stale_after".into(), json!(stale_after));
    }
    // `verified` is deliberately never accepted from the agent — see the
    // tool description. Self-certification would empty the trust model.

    // Recorded BEFORE the write, or every concept reads as an update of itself.
    let existed = crate::vault::write::concept_exists(vault, &path);

    // Checked before the write for the same reason: afterwards the new file is
    // on disk and would have to be excluded from its own duplicate scan.
    // Only for NEW concepts — revising one in place is the behaviour this is
    // trying to encourage, so warning about it would be backwards.
    let duplicates = if existed {
        Vec::new()
    } else {
        let about: Vec<String> = args
            .get("about")
            .and_then(|v| v.as_array())
            .map(|items| {
                items
                    .iter()
                    .filter_map(|v| v.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();
        crate::knowledge::near_duplicates(
            vault,
            &path,
            &arg_str(args, "title").unwrap_or_default(),
            &about,
        )
    };

    vault::write::write_concept(vault, &path, &frontmatter, &body)?;

    // The log is appended by us, on every write, rather than left to the agent
    // to remember — see knowledge::insert_log_entry. A failure here must not
    // lose the concept that was already written, so it degrades to a note in
    // the tool result instead of an error.
    let title = arg_str(args, "title").unwrap_or_else(|| path.clone());
    let logged = crate::vault::write::append_knowledge_log(vault, &path, &title, existed);
    let note = match logged {
        Ok(()) => String::new(),
        Err(e) => format!(" (could not update the knowledge log: {e})"),
    };
    let warning =
        if duplicates.is_empty() {
            String::new()
        } else {
            format!(
            " The bundle already holds {} about the same thing: {}. Consolidate: revise one of \
             those instead, or set `supersedes` on this one if it replaces them.",
            if duplicates.len() == 1 { "a concept" } else { "concepts" },
            duplicates.join(", ")
        )
        };
    Ok(text_result(format!(
        "Wrote {path}. It is unverified until the user reviews it in Knowledge.{note}{warning}"
    )))
}

fn now_iso() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

/// Slug for a cached source. Mirrors `slugForUrl` in src/engine/ingest.ts —
/// the frontend decides whether a reference is already cached by building the
/// same path, so the two MUST agree or every fetch looks uncached forever.
fn source_slug(kind: &str, id: &str) -> String {
    if kind == "issue" {
        return format!("issues/{}", id.to_lowercase());
    }
    let trimmed = id
        .trim_start_matches("https://")
        .trim_start_matches("http://");
    // ASCII-only on purpose: the TypeScript side uses `\w`, which is ASCII,
    // and `char::is_alphanumeric` is Unicode-aware. A é in a URL would
    // otherwise produce two different paths and the cache would never hit.
    let mut slug: String = trimmed
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    while slug.contains("--") {
        slug = slug.replace("--", "-");
    }
    let slug = slug.trim_matches('-').to_lowercase();
    format!("web/{}", slug.chars().take(80).collect::<String>())
}

/// Cache fetched external material as a working doc (M8.2).
///
/// This is the connector inlet. Cerebro owns no credentials and runs no sync:
/// the agent reaches for whatever MCP server or CLI it has when a note names
/// something it cannot read, and writes the answer down here. What makes that
/// affordable is exactly this file — one fetch, a permanent local copy, and
/// every later turn reads markdown instead of calling an API.
fn tool_cache_source(
    vault: &Path,
    args: &Map<String, Value>,
    actor: &str,
) -> Result<Value, String> {
    let id = arg_str(args, "id").ok_or("cache_source needs an id")?;
    let kind = arg_str(args, "kind").unwrap_or_else(|| "web".into());
    if kind != "issue" && kind != "web" {
        return Err(format!(
            "cache_source kind must be issue or web, not {kind}"
        ));
    }
    let title = arg_str(args, "title").ok_or("cache_source needs a title")?;
    let body = arg_str(args, "body").ok_or("cache_source needs a body")?;
    let path = format!(
        "{}/{}.md",
        crate::vault::write::SOURCES_DIR,
        source_slug(&kind, &id)
    );

    let mut frontmatter = Map::new();
    // Typed so it is a first-class note, and `display: doc` keeps the cache
    // browsable rather than hidden — a copy you cannot read is not evidence.
    frontmatter.insert("type".into(), json!("Source"));
    frontmatter.insert("title".into(), json!(title));
    frontmatter.insert("source_id".into(), json!(id));
    frontmatter.insert("source_kind".into(), json!(kind));
    if let Some(url) = arg_str(args, "source_url") {
        frontmatter.insert("source_url".into(), json!(url));
    }
    frontmatter.insert("fetched_at".into(), json!(now_iso()));
    // A cached copy goes stale exactly the way a concept does, so refreshing
    // it is the same mechanism rather than a second one (engine/okf.ts).
    let stale = arg_str(args, "stale_after").unwrap_or_else(|| {
        (chrono::Utc::now() + chrono::Duration::days(30))
            .format("%Y-%m-%d")
            .to_string()
    });
    frontmatter.insert("stale_after".into(), json!(stale));
    // Provenance is stamped by us for the same reason it is on a concept: an
    // agent that can author its own `generated` can disclaim its own work.
    frontmatter.insert("generated".into(), json!({ "by": actor, "at": now_iso() }));

    let doc = format!("# {title}\n\n{}\n", body.trim());
    crate::vault::write::write_source(vault, &path, &frontmatter, &doc)?;
    Ok(text_result(format!(
        "Cached {id} at {path}. Cite that path in `sources` rather than refetching."
    )))
}

/// `report_window_outcome` (M26.4h) — what one ingest run concluded.
///
/// **The proposal list is the server's, not the caller's.** Everything else
/// here is a judgment only the run can make; which proposals it actually got
/// accepted is a fact this server already holds, and a run that could name
/// its own list could attribute another run's work to its window.
///
/// Refused when the run has no open window: a chat turn has nothing to report
/// about, and a background run whose window the driver never opened is a
/// caller confused about what it is doing.
/// The attended answer, submitted once and checked against what was assembled.
///
/// **Every check is server-side, and the manifest is the server's.** The run
/// cannot tell us which manifest to check against, cannot widen what counts as
/// a valid ref, and cannot lower the stakes it was given — those are the three
/// ways an answer could be made to validate against itself.
///
/// **A refusal is an answer to the model, not a transport failure.**
/// `call_tool` turns an `Err` here into readable `isError` content, which is
/// the point: a model that cited an item this assembly never held should be
/// told exactly that and given the chance to fix it.
fn tool_submit_answer(args: &Map<String, Value>, grant: &RunGrant) -> Result<Value, String> {
    use crate::assembly::answer::SynthesisAnswer;

    let mut map = questions().lock().map_err(|_| "question lock poisoned")?;
    let session = map
        .get_mut(&grant.run_id)
        .ok_or("this run has no open question, so there is nothing to submit an answer for")?;
    if session.answer.is_some() {
        return Err(
            "this question has already been answered. One run, one answer — say \
                    everything in the first one."
                .to_string(),
        );
    }

    let raw = args
        .get("answer")
        .cloned()
        .ok_or("answer is required: the nine-part object the prompt printed the shape of")?;
    let answer: SynthesisAnswer = serde_json::from_value(raw).map_err(|e| {
        format!(
            "answer: {e}. The shape is the one in the prompt — every part is required, and the \
             field names are exact."
        )
    })?;
    answer.validate_against(&session.manifest)?;

    let cited = answer.evidence_refs().count();
    session.answer = Some(Box::new(answer));
    typed_result(json!({
        "accepted": true,
        "working_memory_manifest_id": session.manifest.assembly_id,
        "distinct_refs_cited": cited,
    }))
}

fn tool_report_window_outcome(
    args: &Map<String, Value>,
    grant: &RunGrant,
) -> Result<Value, String> {
    use crate::ingest::outcome::RunResult;
    use crate::ledger::schema::{BlockedReason, MaterialDimension};

    let mut map = windows().lock().map_err(|_| "window lock poisoned")?;
    let session = map.get_mut(&grant.run_id).ok_or(
        "this run has no open ingest window, so there is nothing to report an outcome for",
    )?;
    if session.report.is_some() {
        return Err(
            "this window has already been reported. One run, one disposition — say everything              in the first report."
                .to_string(),
        );
    }

    let dimensions = |field: &str| -> Result<Vec<MaterialDimension>, String> {
        let raw = args.get(field).cloned().unwrap_or(json!([]));
        let mut parsed: Vec<MaterialDimension> =
            serde_json::from_value(raw).map_err(|e| format!("{field}: {e}"))?;
        parsed.sort();
        parsed.dedup();
        Ok(parsed)
    };
    let explanation = arg_str(args, "explanation")
        .ok_or("explanation is required: say in your own words what you concluded")?;
    let evaluated = dimensions("evaluated_dimensions")?;
    let material = dimensions("material_dimensions")?;

    let outcome = arg_str(args, "outcome")
        .ok_or("outcome is required: material, non_material, or undetermined")?;
    let result = match outcome.as_str() {
        "material" => {
            let proposal_ids: Vec<String> = session.submitted.iter().cloned().collect();
            if proposal_ids.is_empty() {
                return Err(
                    "you reported `material` and this server accepted no proposals from this                      run. Either propose the change, or report what actually happened."
                        .to_string(),
                );
            }
            RunResult::Material {
                proposal_ids,
                evaluated_dimensions: evaluated,
                material_dimensions: material,
                explanation,
            }
        }
        "non_material" => RunResult::NonMaterial {
            evaluated_dimensions: evaluated,
            explanation,
        },
        "undetermined" => {
            let reason: BlockedReason = serde_json::from_value(
                args.get("blocked_reason")
                    .cloned()
                    .ok_or("an undetermined window names one blocked_reason")?,
            )
            .map_err(|e| format!("blocked_reason: {e}"))?;
            RunResult::Blocked {
                reason,
                evaluated_dimensions: evaluated,
                explanation,
            }
        }
        other => {
            return Err(format!(
                "{other:?} is not an outcome. It is material, non_material, or undetermined."
            ))
        }
    };

    let batch_key = session.batch_key.clone();
    session.report = Some(result);
    Ok(text_result(format!(
        "Recorded. Window {batch_key} is closed as {outcome}; nothing more is needed from you."
    )))
}

fn tool_propose_organize(app: &AppHandle, args: &Map<String, Value>) -> Result<Value, String> {
    let path = arg_str(args, "path").ok_or("propose_organize needs a path")?;
    let mut payload = Map::new();
    payload.insert("action".into(), json!("propose_organize"));
    for key in ["path", "type", "title", "reasoning"] {
        if let Some(value) = args.get(key) {
            payload.insert(key.into(), value.clone());
        }
    }
    if let Some(properties) = args.get("properties") {
        payload.insert("properties".into(), properties.clone());
    }
    app.emit(UI_ACTION_EVENT, Value::Object(payload))
        .map_err(|e| e.to_string())?;
    Ok(text_result(format!(
        "Proposed a filing for {path}. The user sees an accept/reject card; nothing was written."
    )))
}

fn tool_ui(app: &AppHandle, action: &str, args: &Map<String, Value>) -> Result<Value, String> {
    let mut payload = args.clone();
    payload.insert("action".into(), json!(action));
    app.emit(UI_ACTION_EVENT, Value::Object(payload))
        .map_err(|e| e.to_string())?;
    Ok(text_result(format!("Done ({action}).")))
}

pub fn vault_changed(app: &AppHandle) {
    notify_vault_changed(app);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// These exact strings are asserted again in src/engine/ingest.test.ts.
    /// The frontend decides a reference is already cached by building the
    /// same path this function builds — if the two ever disagree, every
    /// fetched source looks uncached forever and the agent refetches on
    /// every turn.
    #[test]
    fn source_slugs_match_the_frontends_cache_paths() {
        assert_eq!(source_slug("issue", "PHX-421"), "issues/phx-421");
        assert_eq!(
            source_slug("web", "https://wiki.test/x/Rollback"),
            "web/wiki.test-x-rollback"
        );
        assert_eq!(
            source_slug("web", "https://a.test/p?q=1&r=2"),
            "web/a.test-p-q-1-r-2"
        );
        // Trailing separators are filing noise, not part of the name.
        assert_eq!(source_slug("web", "http://a.test/p/"), "web/a.test-p");
    }

    #[test]
    fn cached_sources_cannot_be_written_outside_the_sources_folder() {
        let dir = std::env::temp_dir().join("cerebro-src-guard");
        let _ = std::fs::create_dir_all(&dir);
        let fm = serde_json::Map::new();
        assert!(crate::vault::write::write_source(&dir, "knowledge/x.md", &fm, "b").is_err());
        assert!(crate::vault::write::write_source(&dir, "docs/x.md", &fm, "b").is_err());
        assert!(crate::vault::write::write_source(&dir, "sources/web/x.md", &fm, "b").is_ok());
    }

    #[test]
    fn notifications_are_recognised_by_their_missing_id() {
        assert!(is_notification(
            r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#
        ));
        assert!(!is_notification(
            r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#
        ));
        assert!(!is_notification("not json"));
    }

    #[test]
    fn tokens_are_long_and_not_shared_between_calls() {
        let a = random_token();
        let b = random_token();
        assert_eq!(a.len(), 32);
        assert_ne!(a, b, "a fixed token would be a fixed credential");
    }

    #[test]
    fn every_catalog_tool_has_a_name_description_and_schema() {
        // WITH the proposal surface on, so the generated entries are held to
        // the same bar as the hand-written twelve.
        for tool in tool_catalog(true) {
            assert!(tool.get("name").and_then(Value::as_str).is_some());
            let description = tool
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or("");
            assert!(
                description.len() > 20,
                "a thin description is how an agent picks the wrong tool"
            );
            assert!(tool.get("inputSchema").is_some());
        }
    }

    #[test]
    fn writes_are_stamped_with_the_runs_actor_never_self_declared() {
        let dir = std::env::temp_dir().join("cerebro-actor-stamp");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let mut args = Map::new();
        args.insert("path".into(), json!("knowledge/systems/scouted.md"));
        args.insert("title".into(), json!("Scouted"));
        args.insert("body".into(), json!("What the scout learned."));
        tool_write_concept(&dir, &args, "process:release-scout").unwrap();
        let written = std::fs::read_to_string(dir.join("knowledge/systems/scouted.md")).unwrap();
        assert!(written.contains("process:release-scout"));
        assert!(!written.contains("claude-code"));

        // Both stamping tools, not just one — cache_source regressing to a
        // hardcoded actor would misattribute every fetched copy.
        let mut cache = Map::new();
        cache.insert("id".into(), json!("https://wiki.test/x/page"));
        cache.insert("title".into(), json!("Page"));
        cache.insert("body".into(), json!("fetched content"));
        tool_cache_source(&dir, &cache, "process:release-scout").unwrap();
        let cached = std::fs::read_to_string(dir.join("sources/web/wiki.test-x-page.md")).unwrap();
        assert!(cached.contains("process:release-scout"));
        assert!(!cached.contains("claude-code"));
    }

    #[test]
    fn a_missing_or_blank_actor_resets_to_the_default_never_inherits() {
        assert_eq!(normalize_actor(None), DEFAULT_ACTOR);
        assert_eq!(normalize_actor(Some("")), DEFAULT_ACTOR);
        assert_eq!(normalize_actor(Some("   ")), DEFAULT_ACTOR);
        assert_eq!(normalize_actor(Some("process:scout")), "process:scout");
    }

    fn grant(actor: &str) -> RunGrant {
        RunGrant::unrestricted(actor)
    }

    // --- The in-session retry bound (M26.4g) ---------------------------
    //
    // The counter is process-global, so these tests use distinct run ids
    // rather than a shared lock: a run is a bearer token, and two tests are
    // two runs.

    fn target(id: &str) -> crate::ledger::schema::ProposalTarget {
        crate::ledger::schema::ProposalTarget {
            target_id: id.to_string(),
            target_class: crate::ledger::schema::TargetClass::Belief,
            expected_version: Some(1),
        }
    }

    /// Record one refusal the way `tool_propose` does.
    fn refuse(run: &str, key: &str, code: &str, digest: &str) {
        let mut map = attempts().lock().unwrap();
        let entry = map
            .entry((run.to_string(), key.to_string()))
            .or_insert(Attempt {
                count: 0,
                code: String::new(),
                digest: String::new(),
            });
        entry.count += 1;
        entry.code = code.to_string();
        entry.digest = digest.to_string();
    }

    fn attempt(run: &str, key: &str) -> Option<Attempt> {
        attempts()
            .lock()
            .unwrap()
            .get(&(run.into(), key.into()))
            .cloned()
    }

    #[test]
    fn the_work_key_survives_the_adjustment_a_retry_is_supposed_to_make() {
        // A `stale_target_version` retry refetches and resubmits with a new
        // expected version. That is the SAME work, and a key that changed
        // would give every retry a fresh allowance — the bound would count
        // to one, forever.
        let a = work_key("update_belief", &[target("b1")]);
        let mut moved = target("b1");
        moved.expected_version = Some(7);
        assert_eq!(a, work_key("update_belief", &[moved]));
        // Order does not matter; the targets and the op do.
        assert_eq!(
            work_key("update_belief", &[target("b1"), target("b2")]),
            work_key("update_belief", &[target("b2"), target("b1")])
        );
        // Different work is different work.
        assert_ne!(a, work_key("update_belief", &[target("b2")]));
        assert_ne!(a, work_key("tombstone_belief", &[target("b1")]));
    }

    #[test]
    fn the_bound_counts_attempts_and_the_table_says_how_many() {
        let table = crate::policy::table::PolicyTable::load().unwrap();
        let run = "retry-run-bounded";
        let key = work_key("update_belief", &[target("b1")]);
        // Nothing recorded: the first attempt is never gated.
        assert!(attempt(run, &key).is_none());

        refuse(run, &key, "stale_target_version", "digest-1");
        assert_eq!(
            table.retry_verdict("stale_target_version", attempt(run, &key).unwrap().count),
            crate::policy::table::RetryVerdict::Retry
        );
        refuse(run, &key, "stale_target_version", "digest-2");
        refuse(run, &key, "stale_target_version", "digest-3");
        assert_eq!(
            table.retry_verdict("stale_target_version", attempt(run, &key).unwrap().count),
            crate::policy::table::RetryVerdict::Exhausted,
            "three attempts is the table's bound"
        );
        forget_attempts(run);
    }

    #[test]
    fn a_refusal_about_substance_is_not_retryable_at_any_count() {
        let table = crate::policy::table::PolicyTable::load().unwrap();
        let run = "retry-run-substance";
        let key = work_key("create_belief", &[target("b9")]);
        refuse(run, &key, "self_ancestry", "digest-1");
        assert_eq!(
            table.retry_verdict("self_ancestry", attempt(run, &key).unwrap().count),
            crate::policy::table::RetryVerdict::NotRetryable
        );
        forget_attempts(run);
    }

    #[test]
    fn an_unchanged_resubmission_is_recognised_by_its_digest() {
        // The loop the prompt forbids, made structural: the same bytes back
        // again is not an adjustment, whatever the code allows.
        let run = "retry-run-unchanged";
        let key = work_key("update_belief", &[target("b1")]);
        refuse(run, &key, "stale_target_version", "same-digest");
        assert_eq!(attempt(run, &key).unwrap().digest, "same-digest");
        forget_attempts(run);
    }

    #[test]
    fn a_runs_attempts_die_with_its_token() {
        // Otherwise the map grows for the life of the process, and a run
        // whose token is gone can never propose again anyway.
        let run = "retry-run-evicted";
        let key = work_key("update_belief", &[target("b1")]);
        refuse(run, &key, "stale_target_version", "digest-1");
        assert!(attempt(run, &key).is_some());
        forget_attempts(run);
        assert!(attempt(run, &key).is_none());
    }

    #[test]
    fn evicting_a_run_token_forgets_that_runs_attempts_and_no_others() {
        let mut runs: Vec<(String, RunGrant)> = Vec::new();
        let evicted = format!("evicted-{}", RUN_TOKEN_WINDOW);
        let mut first = RunGrant::unrestricted("agent:a");
        first.run_id = evicted.clone();
        push_run_token(&mut runs, "token-0".into(), first);

        let key = work_key("update_belief", &[target("b1")]);
        refuse(&evicted, &key, "stale_target_version", "digest-1");
        refuse("survivor-run", &key, "stale_target_version", "digest-1");

        // Fill the window so the first grant is dropped.
        for n in 1..=RUN_TOKEN_WINDOW {
            let mut grant = RunGrant::unrestricted("agent:a");
            grant.run_id = format!("later-{n}");
            push_run_token(&mut runs, format!("token-{n}"), grant);
        }
        assert!(attempt(&evicted, &key).is_none(), "evicted with its token");
        assert!(
            attempt("survivor-run", &key).is_some(),
            "and only that run's"
        );
        forget_attempts("survivor-run");
    }

    // --- report_window_outcome (M26.4h) --------------------------------

    fn reporting_grant(run: &str) -> RunGrant {
        let mut grant = RunGrant::unrestricted("agent:m26-ingest");
        grant.run_id = run.to_string();
        grant
    }

    fn report(run: &str, body: Value) -> Result<Value, String> {
        let args: Map<String, Value> = serde_json::from_value(body).unwrap();
        tool_report_window_outcome(&args, &reporting_grant(run))
    }

    #[test]
    fn a_run_with_no_open_window_has_nothing_to_report() {
        // A chat turn calling this is confused, and so is a background run
        // whose window the driver never opened.
        let err = report(
            "report-no-window",
            json!({ "outcome": "non_material", "explanation": "nothing moved" }),
        )
        .expect_err("no window");
        assert!(err.contains("no open ingest window"), "{err}");
    }

    #[test]
    fn a_window_is_reported_once() {
        open_window("report-twice", "window-1");
        report(
            "report-twice",
            json!({ "outcome": "non_material", "explanation": "a heading was renamed" }),
        )
        .unwrap();
        let err = report(
            "report-twice",
            json!({ "outcome": "non_material", "explanation": "actually, also this" }),
        )
        .expect_err("a second disposition");
        assert!(err.contains("already been reported"), "{err}");
        take_window_report("report-twice");
    }

    #[test]
    fn material_with_nothing_proposed_is_refused_rather_than_recorded() {
        // The run says it found something material and this server accepted
        // no proposals from it. One of those two statements is wrong, and
        // the run is the one that can say which.
        open_window("report-empty-material", "window-1");
        let err = report(
            "report-empty-material",
            json!({
                "outcome": "material",
                "explanation": "the cutover slipped",
                "evaluated_dimensions": ["world_state"],
                "material_dimensions": ["world_state"],
            }),
        )
        .expect_err("material with no proposals");
        assert!(err.contains("accepted no proposals"), "{err}");
        take_window_report("report-empty-material");
    }

    #[test]
    fn the_proposal_list_is_the_servers_and_the_caller_cannot_name_it() {
        // A run that could name its own list could attribute another run's
        // work to its window. So the argument is ignored entirely.
        let run = "report-server-list";
        open_window(run, "window-1");
        record_submission(run, "1111111111111111111111111111111a");
        report(
            run,
            json!({
                "outcome": "material",
                "explanation": "a second independent source",
                "evaluated_dimensions": ["evidence_state"],
                "material_dimensions": ["evidence_state"],
                "proposal_ids": ["9999999999999999999999999999999z"],
            }),
        )
        .unwrap();

        let crate::ingest::outcome::RunResult::Material { proposal_ids, .. } =
            take_window_report(run).expect("the report")
        else {
            panic!("expected a material outcome");
        };
        assert_eq!(proposal_ids, vec!["1111111111111111111111111111111a"]);
    }

    #[test]
    fn an_undetermined_window_names_one_reason() {
        let run = "report-blocked";
        open_window(run, "window-1");
        let err = report(
            run,
            json!({ "outcome": "undetermined", "explanation": "the sources went away" }),
        )
        .expect_err("blocked with no reason");
        assert!(err.contains("names one blocked_reason"), "{err}");

        report(
            run,
            json!({
                "outcome": "undetermined",
                "explanation": "the sources went away",
                "blocked_reason": "source_access_lost",
            }),
        )
        .unwrap();
        assert!(matches!(
            take_window_report(run),
            Some(crate::ingest::outcome::RunResult::Blocked { .. })
        ));
    }

    #[test]
    fn an_outcome_outside_the_closed_set_is_refused() {
        let run = "report-invented";
        open_window(run, "window-1");
        let err = report(
            run,
            json!({ "outcome": "probably_fine", "explanation": "eh" }),
        )
        .expect_err("an invented outcome");
        assert!(err.contains("is not an outcome"), "{err}");
        take_window_report(run);
    }

    #[test]
    fn a_run_that_never_reports_leaves_no_verdict_to_guess_from() {
        // The driver reads `None` and closes the window BLOCKED. It must
        // never read silence as "nothing material" — that is the difference
        // between a window nobody assessed and one assessed as quiet.
        open_window("report-silent", "window-1");
        assert!(take_window_report("report-silent").is_none());
    }

    #[test]
    fn taking_a_report_closes_the_window() {
        let run = "report-closes";
        open_window(run, "window-1");
        report(
            run,
            json!({ "outcome": "non_material", "explanation": "nothing moved" }),
        )
        .unwrap();
        assert!(take_window_report(run).is_some());
        // And it is gone, so a late call has nothing to report about.
        assert!(report(
            run,
            json!({ "outcome": "non_material", "explanation": "late" })
        )
        .is_err());
    }

    fn actor_of(presented: &str, base: &str, runs: &[(String, RunGrant)]) -> Option<String> {
        resolve_grant(presented, base, runs).map(|g| g.actor)
    }

    #[test]
    fn an_actor_rides_its_runs_token_never_shared_state() {
        // The race this retires (PR #5 review): with one shared "current
        // actor", a child killed mid-write had its trailing writes stamped
        // as whatever run was being spawned. Bound to the token, the killed
        // run can only ever present its own identity.
        let mut runs = Vec::new();
        push_run_token(&mut runs, "tok-agent".into(), grant("process:scout"));
        push_run_token(&mut runs, "tok-chat".into(), grant(DEFAULT_ACTOR));
        assert_eq!(
            actor_of("tok-agent", "base", &runs).as_deref(),
            Some("process:scout"),
            "the outgoing run's trailing write still stamps as the outgoing run"
        );
        assert_eq!(
            actor_of("tok-chat", "base", &runs).as_deref(),
            Some(DEFAULT_ACTOR)
        );
        assert_eq!(
            actor_of("base", "base", &runs).as_deref(),
            Some(DEFAULT_ACTOR),
            "the endpoint's own token is the default actor"
        );
        assert_eq!(
            actor_of("unknown", "base", &runs),
            None,
            "unminted tokens are refused"
        );
    }

    #[test]
    fn run_tokens_expire_beyond_the_window() {
        let mut runs = Vec::new();
        for i in 0..(RUN_TOKEN_WINDOW + 2) {
            push_run_token(&mut runs, format!("tok-{i}"), grant(&format!("actor-{i}")));
        }
        assert_eq!(
            runs.len(),
            RUN_TOKEN_WINDOW,
            "the ledger never grows unboundedly"
        );
        assert_eq!(
            actor_of("tok-0", "base", &runs),
            None,
            "old credentials retire"
        );
        let newest = format!("tok-{}", RUN_TOKEN_WINDOW + 1);
        assert!(actor_of(&newest, "base", &runs).is_some());
    }

    /// M17.13 — scope is structural, and these are the property.
    ///
    /// The point is not that an agent is ASKED to stay inside its folder; it
    /// is that it cannot leave, and the refusal is here rather than in a
    /// sentence a model can be talked out of.
    fn scoped(folders: &[&str]) -> RunGrant {
        RunGrant {
            actor: "process:scout".into(),
            run_id: run_id_of("process:scout"),
            scope: Some(folders.iter().map(|f| f.to_string()).collect()),
            tools: None,
        }
    }

    #[test]
    fn an_agent_run_cannot_rewrite_the_corrections_made_to_it() {
        // M17.14. An agent that can edit its own `preferences` does not have
        // preferences, it has notes.
        let patch: Map<String, Value> =
            serde_json::from_value(json!({ "path": "records/agents/a.md",
                "patch": { "preferences": "be terser" } }))
            .unwrap();
        assert!(writes_preferences(
            "process:scout",
            "update_frontmatter",
            &patch
        ));
    }

    #[test]
    fn the_person_can_still_write_their_own_preferences() {
        // The record panel writes through the human path, which carries the
        // default actor. Refusing that too would make the tier unwritable.
        let patch: Map<String, Value> =
            serde_json::from_value(json!({ "patch": { "preferences": "be terser" } })).unwrap();
        assert!(!writes_preferences(
            DEFAULT_ACTOR,
            "update_frontmatter",
            &patch
        ));
    }

    #[test]
    fn an_agent_may_still_write_its_own_working_notes() {
        // `recent` is the agent's tier and rewriting it every run is the whole
        // mechanism — refusing it would leave an agent with no memory at all.
        let patch: Map<String, Value> =
            serde_json::from_value(json!({ "patch": { "recent": "saw three risks" } })).unwrap();
        assert!(!writes_preferences(
            "process:scout",
            "update_frontmatter",
            &patch
        ));
    }

    #[test]
    fn a_scoped_run_writes_inside_its_folder_and_nowhere_else() {
        let g = scoped(&["projects/atlas"]);
        assert!(g.may_write("projects/atlas/items/a.md"));
        assert!(g.may_write("projects/atlas"));
        assert!(!g.may_write("projects/beta/items/a.md"));
        assert!(!g.may_write("inbox/capture.md"));
    }

    #[test]
    fn a_scope_cannot_be_escaped_by_a_prefix_that_merely_starts_the_same() {
        // The classic one: `work` must not reach `workspace/`. Matching at a
        // separator is why `may_write` exists rather than `starts_with`.
        let g = scoped(&["work"]);
        assert!(g.may_write("work/a.md"));
        assert!(!g.may_write("workspace/a.md"));
        assert!(!g.may_write("workshop.md"));
    }

    #[test]
    fn a_scope_that_lists_nothing_permits_nothing() {
        // A record that declares `scope:` and lists none has scoped itself to
        // nothing. Reading that as "everywhere" would make the safest-looking
        // declaration the most dangerous one.
        let g = scoped(&[]);
        assert!(!g.may_write("anything.md"));
    }

    #[test]
    fn an_unscoped_run_is_unrestricted() {
        // The panel's own turns, which a person is watching.
        assert!(RunGrant::unrestricted(DEFAULT_ACTOR).may_write("anywhere/at/all.md"));
    }

    #[test]
    fn a_leading_slash_or_dot_cannot_slip_past_the_check() {
        let g = scoped(&["projects/atlas"]);
        assert!(g.may_write("./projects/atlas/a.md"));
        assert!(g.may_write("/projects/atlas/a.md"));
        assert!(!g.may_write("/projects/beta/a.md"));
    }

    #[test]
    fn no_write_tool_escapes_the_scope_check() {
        // The list in `write_target` is the enforcement surface, so a new write
        // tool that is not listed there is silently unscoped. This test is the
        // tripwire: every tool the policy grants that can change a note must
        // resolve to a target.
        let args: Map<String, Value> = serde_json::from_value(json!({
            "path": "projects/atlas/a.md",
            "folder": "projects/atlas"
        }))
        .unwrap();
        for tool in ["create_note", "update_frontmatter", "append_to_note"] {
            assert!(
                write_target(tool, &args).is_some(),
                "{tool} must be scope-checked"
            );
        }
        // EVERY EXEMPTION IS DECLARED, and the partition is TOTAL over the
        // served catalog — including the generated proposal surface, which
        // did not exist when this test named three tools and called itself a
        // tripwire.
        let exempt: std::collections::BTreeMap<&str, &str> = [
            (
                "write_concept",
                "knowledge/ has its own guard (knowledge.rs)",
            ),
            (
                "cache_source",
                "sources/ is the agent's own corpus, not the user's records",
            ),
            ("get_vault_context", "reads"),
            ("search_notes", "reads"),
            ("get_note", "reads"),
            ("list_inbox", "reads"),
            ("open_note", "moves the UI, changes nothing on disk"),
            ("navigate", "moves the UI, changes nothing on disk"),
            ("propose_organize", "shows a card; the user decides"),
            (
                "report_window_outcome",
                "records a run's own verdict in memory; writes no file and no event",
            ),
            (
                "submit_answer",
                "records a run's own answer in memory; writes no file and no event",
            ),
        ]
        .into_iter()
        .collect();
        for tool in tool_catalog(true) {
            let name = tool["name"].as_str().unwrap();
            if write_target(name, &args).is_some() {
                continue;
            }
            // The proposal surface writes through the LEDGER, not to a path.
            // `RunGrant.scope` is a folder primitive by deliberate design
            // (it is checkable without knowing the vault's schema), and
            // "which Beliefs may this run change" is not a folder — so a
            // folder scope cannot express it and pretending otherwise would
            // be a rule that looks like protection. Governing WHICH
            // mutations a run may propose belongs to the policy table,
            // which already does it per op and per risk.
            if name.starts_with(PROPOSAL_PREFIX) || name == COMMIT_TOOL {
                continue;
            }
            assert!(
                exempt.contains_key(name),
                "{name} is served, is not scope-checked, and declares no exemption"
            );
        }
    }

    // --- The tools narrowing (M31.1b) ----------------------------------
    //
    // Same property as scope, one surface over: the point is not that a run
    // is ASKED to stay inside its granted tools (that is argv, M31.1a); it
    // is that dispatch refuses an un-granted name before any tool body runs.

    #[test]
    fn a_granted_narrowing_is_enforced_at_dispatch_not_just_argv() {
        // M31.1b. A token minted with a tool narrowing refuses un-granted
        // reads server-side — a compromised CLI that ignores its argv still
        // cannot read the vault through the loopback. Minted through the REAL
        // `run_token`, which needs state but no live socket.
        let run_actors = Arc::new(Mutex::new(Vec::new()));
        let state = McpState {
            inner: Mutex::new(Some(Running {
                port: 0,
                token: "base".into(),
                vault: Arc::new(Mutex::new(PathBuf::new())),
                run_actors: run_actors.clone(),
            })),
        };
        let token = state
            .run_token(
                Some("agent:m26-ingest"),
                Some(vec![]),
                Some(vec![COMMIT_TOOL.into()]),
            )
            .expect("minting needs state, not a socket");
        let grant = resolve_grant(&token, "base", &run_actors.lock().unwrap())
            .expect("a minted token resolves to its grant");

        let refusal = ungranted_tool_refusal(&grant, "get_note")
            .expect("an un-granted read is refused before any tool body runs");
        assert!(refusal.contains("get_note"), "names the tool: {refusal}");
        assert!(
            refusal.contains(COMMIT_TOOL),
            "names the narrowing: {refusal}"
        );
        // What the grant names still dispatches.
        assert!(ungranted_tool_refusal(&grant, COMMIT_TOOL).is_none());
    }

    #[test]
    fn the_full_mcp_spelling_cannot_slip_past_the_narrowing() {
        // Loopback names arrive short, so the strip is defensive — but both
        // spellings must name the SAME tool: a granted short name admits the
        // full spelling, and an un-granted one refuses both.
        let mut grant = RunGrant::unrestricted("agent:m26-synthesis");
        grant.tools = Some(vec![crate::assembly::prompt::SUBMIT_TOOL.to_string()]);
        let full = format!(
            "{}{}",
            crate::agent::MCP_PREFIX,
            crate::assembly::prompt::SUBMIT_TOOL
        );
        assert!(ungranted_tool_refusal(&grant, &full).is_none());
        let refusal = format!("{}get_note", crate::agent::MCP_PREFIX);
        assert!(ungranted_tool_refusal(&grant, &refusal).is_some());
        // And the declared side normalizes too: a grant WRITTEN in the full
        // spelling admits the short-spelled call the loopback actually
        // receives — a one-sided strip would refuse it, fail-closed but a
        // silent drift channel.
        grant.tools = Some(vec![full]);
        assert!(ungranted_tool_refusal(&grant, crate::assembly::prompt::SUBMIT_TOOL).is_none());
    }

    #[test]
    fn a_narrowing_that_lists_nothing_grants_nothing() {
        // The same reading scope settled on: a declaration that lists nothing
        // has narrowed itself to nothing, and the only safe reading of that
        // is no dispatch — never "everything".
        let mut grant = RunGrant::unrestricted("agent:x");
        grant.tools = Some(vec![]);
        let refusal = ungranted_tool_refusal(&grant, "get_note").expect("nothing is granted");
        assert!(refusal.contains("get_note"), "{refusal}");
    }

    #[test]
    fn an_unrestricted_grant_dispatches_the_whole_catalog() {
        // The panel's own turns: `None` is no narrowing, not an empty one.
        let grant = RunGrant::unrestricted(DEFAULT_ACTOR);
        for tool in tool_catalog(true) {
            let name = tool["name"].as_str().unwrap();
            assert!(ungranted_tool_refusal(&grant, name).is_none(), "{name}");
        }
    }

    /// One assembled question, opened for a run the way the app opens it.
    fn open_a_question(run_id: &str) -> crate::assembly::manifest::WorkingMemoryManifest {
        use crate::assembly::fixture;
        let assembly = fixture::assembled(&fixture::request(fixture::shipping(), fixture::wide()));
        open_question(run_id, &assembly.manifest);
        assembly.manifest
    }

    fn grant_for(run_id: &str) -> RunGrant {
        RunGrant {
            actor: "agent:m26-synthesis".into(),
            run_id: run_id.to_string(),
            scope: None,
            tools: None,
        }
    }

    fn submit(
        grant: &RunGrant,
        answer: &crate::assembly::answer::SynthesisAnswer,
    ) -> Result<Value, String> {
        let args: Map<String, Value> = serde_json::from_value(json!({
            "answer": serde_json::to_value(answer).unwrap()
        }))
        .unwrap();
        tool_submit_answer(&args, grant)
    }

    #[test]
    fn a_run_with_no_open_question_has_nothing_to_answer() {
        // The registry is what makes the manifest the SERVER's. A run that
        // could answer without one could hand us the manifest to check itself
        // against.
        let grant = grant_for(&run_id_of("mcp-answer-unopened"));
        let answer = {
            use crate::assembly::fixture;
            let assembly =
                fixture::assembled(&fixture::request(fixture::shipping(), fixture::wide()));
            crate::assembly::answer::tests::valid_for(&assembly.manifest)
        };
        let refusal = submit(&grant, &answer).expect_err("no open question");
        assert!(refusal.contains("no open question"), "{refusal}");
    }

    #[test]
    fn a_valid_answer_is_accepted_once_and_taken_by_the_app() {
        let run = run_id_of("mcp-answer-happy");
        let manifest = open_a_question(&run);
        let grant = grant_for(&run);
        let answer = crate::assembly::answer::tests::valid_for(&manifest);

        submit(&grant, &answer).expect("a complete answer is accepted");
        let second = submit(&grant, &answer).expect_err("one run, one answer");
        assert!(second.contains("already been answered"), "{second}");

        let taken = take_answer(&run).expect("the app takes it");
        assert_eq!(taken.working_memory_manifest_id, manifest.assembly_id);
        assert!(take_answer(&run).is_none(), "taking closes the question");
    }

    #[test]
    fn an_answer_citing_what_the_assembly_never_held_is_refused_readably() {
        // And it reaches the model as content it can act on, not as a
        // transport error it cannot see.
        let run = run_id_of("mcp-answer-bad-ref");
        let manifest = open_a_question(&run);
        let grant = grant_for(&run);
        let mut answer = crate::assembly::answer::tests::valid_for(&manifest);
        let invented = crate::assembly::answer::EvidenceRef::ManifestItem {
            item_id: "an-item-nobody-assembled".into(),
        };
        answer.basis[0].statement.basis_refs = vec![invented.clone()];
        answer.basis[0].citation_refs = vec![invented.clone()];
        answer.current_answer.basis_refs = vec![invented];

        let refusal = submit(&grant, &answer).expect_err("the ref resolves to nothing");
        assert!(refusal.contains("never held"), "{refusal}");
        assert!(
            take_answer(&run).is_none(),
            "a refused answer is not recorded"
        );
    }

    #[test]
    fn a_run_cannot_lower_the_stakes_it_was_given() {
        let run = run_id_of("mcp-answer-stakes");
        let manifest = open_a_question(&run);
        let grant = grant_for(&run);
        let mut answer = crate::assembly::answer::tests::valid_for(&manifest);
        answer.evidence_sufficiency.intended_use.stakes = crate::ledger::schema::Risk::Low;
        let refusal = submit(&grant, &answer).expect_err("the use is fixed before retrieval");
        assert!(refusal.contains("cannot weaken"), "{refusal}");
        take_answer(&run);
    }

    #[test]
    fn a_malformed_answer_is_told_the_shape_rather_than_a_parser_error_alone() {
        let run = run_id_of("mcp-answer-malformed");
        open_a_question(&run);
        let grant = grant_for(&run);
        let args: Map<String, Value> =
            serde_json::from_value(json!({ "answer": { "observations": [] } })).unwrap();
        let refusal = tool_submit_answer(&args, &grant).expect_err("not an answer");
        assert!(refusal.contains("field names are exact"), "{refusal}");
        take_answer(&run);
    }

    #[test]
    fn the_submit_tool_the_prompt_names_is_the_one_served() {
        // `base_tools` must spell the name literally so the TS parity test can
        // scrape it; this is what stops that literal drifting from the
        // constant the prompt tells the model to call and the dispatcher
        // routes on.
        let served: Vec<&str> = tool_catalog(true)
            .iter()
            .filter_map(|tool| tool["name"].as_str())
            .map(|name| Box::leak(name.to_string().into_boxed_str()) as &str)
            .collect();
        assert!(
            served.contains(&crate::assembly::prompt::SUBMIT_TOOL),
            "the prompt names {} and the server serves {served:?}",
            crate::assembly::prompt::SUBMIT_TOOL
        );
    }

    #[test]
    fn the_hand_served_tool_consts_name_tools_the_catalog_serves() {
        // M31.1a. `base_tools` spells these names literally so the TS parity
        // test can scrape the bytes; the consts exist so SPAWN SITES never
        // spell them. This ties the two ends together: a const that drifted
        // from the served literal would be silently dropped by narrow().
        let served: Vec<String> = tool_catalog(true)
            .iter()
            .filter_map(|tool| tool["name"].as_str().map(str::to_string))
            .collect();
        assert!(served.iter().any(|name| name == REPORT_TOOL), "{served:?}");
        assert!(
            served.iter().any(|name| name == ORGANIZE_TOOL),
            "{served:?}"
        );
    }

    #[test]
    fn the_agent_cannot_route_around_write_concept() {
        // M17.1. `write_concept` refuses `verified` and stamps `generated`
        // server-side — but three other tools reached the same files with no
        // check at all, so the refusal was a formality. The worst of them:
        // update_frontmatter could patch the human's own stamp onto a concept.
        let dir = std::env::temp_dir().join("cerebro-agent-knowledge-guard");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("knowledge/metrics")).unwrap();
        std::fs::create_dir_all(dir.join("records/decisions")).unwrap();
        let concept = "---\ntype: Metric\nlifecycle: active\n---\n\n# Onboarding\n";
        let at = dir.join("knowledge/metrics/onboarding.md");
        std::fs::write(&at, concept).unwrap();

        // Self-certification, the hole this closes.
        let mut verify = Map::new();
        verify.insert("path".into(), json!("knowledge/metrics/onboarding.md"));
        verify.insert(
            "patch".into(),
            json!({ "verified": { "by": "human:josef", "at": "2026-08-03" } }),
        );
        assert!(tool_update_frontmatter(&dir, &verify).is_err());

        // Authoring a pre-stamped concept from the side door.
        let mut create = Map::new();
        create.insert("folder".into(), json!("knowledge/metrics"));
        create.insert("slug".into(), json!("smuggled"));
        create.insert("body".into(), json!("# Smuggled"));
        create.insert(
            "frontmatter".into(),
            json!({ "type": "Metric", "verified": { "by": "human:josef" } }),
        );
        assert!(tool_create_note(&dir, &create).is_err());

        // Growing a body with no sources and no refreshed provenance.
        let mut append = Map::new();
        append.insert("path".into(), json!("knowledge/metrics/onboarding.md"));
        append.insert("content".into(), json!("Actually it is 99%."));
        assert!(tool_append(&dir, &append).is_err());

        // The concept is untouched, and nothing was smuggled in beside it.
        assert_eq!(std::fs::read_to_string(&at).unwrap(), concept);
        assert!(!dir.join("knowledge/metrics/smuggled.md").exists());

        // Outside the bundle every one of them still works — this is a
        // boundary, not a lockdown.
        let mut ok_create = Map::new();
        ok_create.insert("folder".into(), json!("records/decisions"));
        ok_create.insert("slug".into(), json!("d-2"));
        ok_create.insert("body".into(), json!("# D-2"));
        ok_create.insert("frontmatter".into(), json!({ "type": "Decision" }));
        assert!(tool_create_note(&dir, &ok_create).is_ok());
        let mut ok_patch = Map::new();
        ok_patch.insert("path".into(), json!("records/decisions/d-2.md"));
        ok_patch.insert("patch".into(), json!({ "status": "done" }));
        assert!(tool_update_frontmatter(&dir, &ok_patch).is_ok());

        // And write_concept — the sanctioned door — is still open.
        let mut wc = Map::new();
        wc.insert("path".into(), json!("knowledge/metrics/onboarding.md"));
        wc.insert("type".into(), json!("Metric"));
        wc.insert("title".into(), json!("Onboarding"));
        wc.insert("body".into(), json!("Completion sits at 62%."));
        assert!(tool_write_concept(&dir, &wc, DEFAULT_ACTOR).is_ok());
    }

    #[test]
    fn the_agent_cannot_create_or_modify_type_docs() {
        // M13.5 as a rule rather than a prompt suggestion (PR #5 review):
        // every MCP write path refuses schema, in both directions.
        let dir = std::env::temp_dir().join("cerebro-type-doc-guard");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("types")).unwrap();
        std::fs::create_dir_all(dir.join("records/decisions")).unwrap();
        let schema_doc = "---\ntype: Type\nfields:\n  - status\n---\n\n# Decision\n";
        std::fs::write(dir.join("types/decision.md"), schema_doc).unwrap();
        std::fs::write(
            dir.join("records/decisions/d-1.md"),
            "---\ntype: Decision\nstatus: open\n---\n\n# D-1\n",
        )
        .unwrap();

        // Creating a new Type doc, wherever it is aimed.
        let mut create = Map::new();
        create.insert("folder".into(), json!("types"));
        create.insert("slug".into(), json!("sneaky"));
        create.insert("body".into(), json!("# Sneaky"));
        create.insert("frontmatter".into(), json!({ "type": "Type" }));
        assert!(tool_create_note(&dir, &create).is_err());

        // Patching an existing Type doc.
        let mut patch = Map::new();
        patch.insert("path".into(), json!("types/decision.md"));
        patch.insert("patch".into(), json!({ "fields": ["status", "owner"] }));
        assert!(tool_update_frontmatter(&dir, &patch).is_err());

        // Retyping an ordinary record INTO schema.
        let mut retype = Map::new();
        retype.insert("path".into(), json!("records/decisions/d-1.md"));
        retype.insert("patch".into(), json!({ "type": "Type" }));
        assert!(tool_update_frontmatter(&dir, &retype).is_err());

        // Appending to a Type doc's body — its keys ARE the schema.
        let mut append = Map::new();
        append.insert("path".into(), json!("types/decision.md"));
        append.insert("content".into(), json!("statuses:\n  - sneaky"));
        assert!(tool_append(&dir, &append).is_err());

        // Smuggling one into knowledge/ through write_concept.
        let mut concept = Map::new();
        concept.insert("path".into(), json!("knowledge/systems/x.md"));
        concept.insert("type".into(), json!("Type"));
        concept.insert("title".into(), json!("X"));
        concept.insert("body".into(), json!("b"));
        assert!(tool_write_concept(&dir, &concept, DEFAULT_ACTOR).is_err());

        // The doc survived all of it, and ordinary writes still land.
        assert_eq!(
            std::fs::read_to_string(dir.join("types/decision.md")).unwrap(),
            schema_doc
        );
        let mut ok = Map::new();
        ok.insert("path".into(), json!("records/decisions/d-1.md"));
        ok.insert("patch".into(), json!({ "status": "done" }));
        assert!(tool_update_frontmatter(&dir, &ok).is_ok());
    }

    #[test]
    fn no_tool_deletes() {
        // Agents do not delete (M17.1). Cerebro's tools can create, revise and
        // append; removing something a person may not have finished with is
        // not a capability the catalog offers, and the absence is the design
        // rather than an omission — assert it so nobody adds one casually.
        // Checked with the surface ON: a generated name is still a name, and
        // an op called `delete_*` must not become a tool by being added to
        // the table.
        for tool in tool_catalog(true) {
            let name = tool["name"].as_str().unwrap_or_default().to_string();
            assert!(
                !name.contains("delete") && !name.contains("remove") && !name.contains("trash"),
                "the agent has no delete capability; `{name}` would be the first"
            );
        }
    }

    #[test]
    fn write_concept_is_not_offered_a_verified_field() {
        let concept = tool_catalog(false)
            .into_iter()
            .find(|t| t["name"] == "write_concept")
            .expect("write_concept is in the catalog");
        let properties = &concept["inputSchema"]["properties"];
        assert!(
            properties.get("verified").is_none(),
            "an agent that can stamp `verified` can self-certify, which empties the trust model"
        );
    }

    #[test]
    fn trust_tier_matches_the_typescript_engine() {
        use crate::vault::entry::Entry;
        let mut entry = Entry::empty_for_test("knowledge/a.md");
        assert_eq!(trust_tier(&entry), "unverified");

        entry.properties.insert(
            "verified".into(),
            json!([{ "by": "process:nightly", "at": "2026-07-01" }]),
        );
        assert_eq!(trust_tier(&entry), "machine-confirmed");

        entry.properties.insert(
            "verified".into(),
            json!([
                { "by": "process:nightly", "at": "2026-07-01" },
                { "by": "human:josef", "at": "2026-07-02" }
            ]),
        );
        assert_eq!(trust_tier(&entry), "human-reviewed");

        // A bare mapping must read as a one-element list (OKF §5.2).
        entry
            .properties
            .insert("verified".into(), json!({ "by": "human:josef", "at": "x" }));
        assert_eq!(trust_tier(&entry), "human-reviewed");
    }

    #[test]
    fn captures_are_untyped_notes_that_are_not_structure() {
        use crate::vault::entry::Entry;
        let mut note = Entry::empty_for_test("inbox/a.md");
        assert!(is_capture(&note), "an untyped note is a capture");

        note.entry_type = Some("Work item".into());
        assert!(!is_capture(&note), "a typed note is organized");

        note.properties.insert("_organized".into(), json!(false));
        assert!(
            is_capture(&note),
            "an explicit flag overrides the type default"
        );

        let concept = Entry::empty_for_test("knowledge/metrics/x.md");
        assert!(
            !is_capture(&concept),
            "the bundle is reviewed, not organized"
        );
    }
}
