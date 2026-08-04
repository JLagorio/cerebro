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

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

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

#[derive(Clone)]
struct Running {
    port: u16,
    token: String,
    vault: Arc<Mutex<PathBuf>>,
    /// token → actor for recent runs (M13.4). Attribution rides the bearer
    /// each request PRESENTS rather than shared "current actor" state
    /// (PR #5 security review): a child killed while a write is in flight
    /// can only present the token it was spawned with, so its trailing
    /// writes stamp as ITS actor and never as the incoming run's.
    run_actors: Arc<Mutex<Vec<(String, String)>>>,
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

fn push_run_token(runs: &mut Vec<(String, String)>, token: String, actor: String) {
    runs.push((token, actor));
    let excess = runs.len().saturating_sub(RUN_TOKEN_WINDOW);
    runs.drain(..excess);
}

/// The actor a presented bearer resolves to: the endpoint's own token (from
/// `ensure`) is the default actor, a minted run token is its run's actor,
/// and anything else is unauthorized.
fn resolve_actor(presented: &str, base: &str, runs: &[(String, String)]) -> Option<String> {
    if presented == base {
        return Some(DEFAULT_ACTOR.to_string());
    }
    runs.iter()
        .rev()
        .find(|(t, _)| t == presented)
        .map(|(_, a)| a.clone())
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
                let actor = request.headers().iter().find_map(|h| {
                    if !h.field.equiv("Authorization") {
                        return None;
                    }
                    let presented = h.value.as_str().strip_prefix("Bearer ")?;
                    let runs = handler.run_actors.lock().ok()?;
                    resolve_actor(presented, &handler.token, &runs)
                });
                // JSON-RPC notifications carry no id and take no response
                // body. Verified against the real CLI: it sends
                // `notifications/initialized` right after `initialize` and is
                // happy with a bodyless 202.
                if actor.is_some() && is_notification(&body) {
                    let _ = request.respond(tiny_http::Response::empty(202));
                    continue;
                }
                let response = if let Some(actor) = actor.as_deref() {
                    handle_rpc(&app, &handler, actor, &body)
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
    pub fn run_token(&self, actor: Option<&str>) -> Result<String, String> {
        let guard = self.inner.lock().map_err(|_| "mcp state poisoned")?;
        let running = guard.as_ref().ok_or("the MCP endpoint is not running")?;
        let token = random_token();
        let mut runs = running
            .run_actors
            .lock()
            .map_err(|_| "run token lock poisoned")?;
        push_run_token(&mut runs, token.clone(), normalize_actor(actor).to_string());
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

fn handle_rpc(app: &AppHandle, running: &Running, actor: &str, body: &str) -> Value {
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
        "tools/list" => Ok(json!({ "tools": tool_catalog() })),
        "tools/call" => {
            let params = request.get("params").cloned().unwrap_or(Value::Null);
            let name = params.get("name").and_then(Value::as_str).unwrap_or("");
            let args = params
                .get("arguments")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            call_tool(app, running, actor, name, &args)
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

fn tool_catalog() -> Vec<Value> {
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
// Tools
// ---------------------------------------------------------------------------

fn arg_str(args: &Map<String, Value>, key: &str) -> Option<String> {
    args.get(key).and_then(Value::as_str).map(str::to_string)
}

fn call_tool(
    app: &AppHandle,
    running: &Running,
    actor: &str,
    name: &str,
    args: &Map<String, Value>,
) -> Result<Value, String> {
    let vault = running
        .vault
        .lock()
        .map_err(|_| "vault lock poisoned")?
        .clone();

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
        "open_note" => tool_ui(app, "open_note", args),
        "navigate" => tool_ui(app, "navigate", args),
        other => Err(format!("unknown tool: {other}")),
    };

    // A failing tool must reach the model as readable content, not as a
    // transport error it cannot see or recover from.
    Ok(match outcome {
        Ok(value) => value,
        Err(message) => error_result(message),
    })
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
    let needle = query.to_lowercase();
    let type_filter = arg_str(args, "type");
    let limit = args
        .get("limit")
        .and_then(Value::as_u64)
        .unwrap_or(20)
        .min(100) as usize;

    let entries = vault::scan::scan_vault(vault)?;
    let mut hits = Vec::new();
    for entry in entries {
        if let Some(wanted) = &type_filter {
            if entry.entry_type.as_deref() != Some(wanted.as_str()) {
                continue;
            }
        }
        let body = vault::write::read_note(vault, &entry.path).unwrap_or_default();
        let haystack = format!("{} {}", entry.title, body).to_lowercase();
        if !haystack.contains(&needle) {
            continue;
        }
        let excerpt = body
            .lines()
            .find(|l| l.to_lowercase().contains(&needle))
            .unwrap_or(&entry.snippet)
            .trim()
            .chars()
            .take(180)
            .collect::<String>();
        hits.push(format!(
            "- {} — {}{}\n  {}",
            entry.path,
            entry.title,
            entry
                .entry_type
                .map(|t| format!(" [{t}]"))
                .unwrap_or_default(),
            excerpt
        ));
        if hits.len() >= limit {
            break;
        }
    }

    Ok(text_result(if hits.is_empty() {
        format!("No notes matched \"{query}\".")
    } else {
        format!(
            "{} match(es) for \"{}\":\n{}",
            hits.len(),
            query,
            hits.join("\n")
        )
    }))
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
        for tool in tool_catalog() {
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

    #[test]
    fn an_actor_rides_its_runs_token_never_shared_state() {
        // The race this retires (PR #5 review): with one shared "current
        // actor", a child killed mid-write had its trailing writes stamped
        // as whatever run was being spawned. Bound to the token, the killed
        // run can only ever present its own identity.
        let mut runs = Vec::new();
        push_run_token(&mut runs, "tok-agent".into(), "process:scout".into());
        push_run_token(&mut runs, "tok-chat".into(), DEFAULT_ACTOR.into());
        assert_eq!(
            resolve_actor("tok-agent", "base", &runs).as_deref(),
            Some("process:scout"),
            "the outgoing run's trailing write still stamps as the outgoing run"
        );
        assert_eq!(
            resolve_actor("tok-chat", "base", &runs).as_deref(),
            Some(DEFAULT_ACTOR)
        );
        assert_eq!(
            resolve_actor("base", "base", &runs).as_deref(),
            Some(DEFAULT_ACTOR),
            "the endpoint's own token is the default actor"
        );
        assert_eq!(
            resolve_actor("unknown", "base", &runs),
            None,
            "unminted tokens are refused"
        );
    }

    #[test]
    fn run_tokens_expire_beyond_the_window() {
        let mut runs = Vec::new();
        for i in 0..(RUN_TOKEN_WINDOW + 2) {
            push_run_token(&mut runs, format!("tok-{i}"), format!("actor-{i}"));
        }
        assert_eq!(
            runs.len(),
            RUN_TOKEN_WINDOW,
            "the ledger never grows unboundedly"
        );
        assert_eq!(
            resolve_actor("tok-0", "base", &runs),
            None,
            "old credentials retire"
        );
        let newest = format!("tok-{}", RUN_TOKEN_WINDOW + 1);
        assert!(resolve_actor(&newest, "base", &runs).is_some());
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
        for tool in tool_catalog() {
            let name = tool["name"].as_str().unwrap_or_default().to_string();
            assert!(
                !name.contains("delete") && !name.contains("remove") && !name.contains("trash"),
                "the agent has no delete capability; `{name}` would be the first"
            );
        }
    }

    #[test]
    fn write_concept_is_not_offered_a_verified_field() {
        let concept = tool_catalog()
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
