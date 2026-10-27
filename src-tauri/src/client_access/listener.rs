//! Opt-in personal-token transport (M62.5b). The state mutex is never held
//! while a tool dispatches. Authentication rereads durable tokens per request,
//! then opening a session rechecks them inside its recording transaction.

use super::CLIENT_ACTOR_PREFIX;
use crate::{
    app_config::{self, ClientAccessConfig},
    mcp::{self, RunGrant},
    runtime::{self, client_tokens, dispatch},
};
use chrono::{DateTime, Utc};
use rusqlite::{Transaction, TransactionBehavior};
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};

const WORKERS: usize = 4;
const IDLE_MINUTES: i64 = 30;
const PORT_WORDS: &str = "Choose a port from 1024 to 65535.";
const SESSION_UNAVAILABLE: &str = "Cerebro couldn't record this session, so it answers nothing.";
const NO_TOKEN: &str = "unauthorized: send a Cerebro personal token as Authorization: Bearer cbr_…";
const BAD_TOKEN: &str = "unauthorized: Cerebro doesn't know this token. It was revoked, mistyped or made by another install.";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientAccessStatus {
    pub enabled: bool,
    pub port: u16,
    pub url: Option<String>,
    pub error: Option<String>,
}

#[derive(Clone)]
struct Vault {
    path: PathBuf,
    id: String,
    store: Option<String>,
}
struct Running {
    server: Arc<tiny_http::Server>,
    workers: usize,
}

/// The guard moves with the original Session through every finishing path.
/// It is last in Session, so the RunClaim is released before scope completion.
#[derive(Default)]
struct ClientCompletionBook { inner: Mutex<ClientCompletionState> }
#[derive(Default)]
struct ClientCompletionState {
    active: BTreeMap<PathBuf, usize>,
    failed: std::collections::BTreeSet<PathBuf>,
}
struct ClientCompletion {
    book: Arc<ClientCompletionBook>,
    vault: PathBuf,
    confirmed: bool,
}
impl ClientCompletionBook {
    fn register(self: &Arc<Self>, vault: &Path) -> Result<ClientCompletion, String> {
        let mut inner = self.inner.lock().map_err(|_| SESSION_UNAVAILABLE)?;
        let count = inner.active.entry(vault.to_path_buf()).or_default();
        *count = count.checked_add(1).ok_or(SESSION_UNAVAILABLE)?;
        Ok(ClientCompletion { book: self.clone(), vault: vault.to_path_buf(), confirmed: false })
    }
}
impl ClientCompletion { fn confirm(&mut self) { self.confirmed = true; } }
impl Drop for ClientCompletion {
    fn drop(&mut self) {
        let mut inner = match self.book.inner.lock() { Ok(inner) => inner, Err(poisoned) => poisoned.into_inner() };
        if !self.confirmed || std::thread::panicking() { inner.failed.insert(self.vault.clone()); }
        match inner.active.get_mut(&self.vault) {
            Some(count) if *count > 0 => { *count -= 1; if *count == 0 { inner.active.remove(&self.vault); } }
            _ => { inner.failed.insert(self.vault.clone()); }
        }
    }
}

struct Session {
    run_id: String,
    token_id: String,
    actor: String,
    vault: Vault,
    claim: Option<crate::git::changeset::RunClaim>,
    last_call: DateTime<Utc>,
    in_flight: usize,
    closing: Option<End>,
    completion: ClientCompletion,
}
#[derive(Clone, Copy)]
struct End {
    succeeded: bool,
    at: DateTime<Utc>,
    quitting: bool,
}
struct Finished {
    session: Session,
    end: End,
    data_dir: PathBuf,
}
#[derive(Default)]
struct Inner {
    completions: Arc<ClientCompletionBook>,
    config: ClientAccessConfig,
    error: Option<String>,
    data_dir: Option<PathBuf>,
    vault: Option<Vault>,
    running: Option<Running>,
    generation: u64,
    sessions: BTreeMap<String, Session>,
    current: BTreeMap<String, String>,
    pending: Vec<Finished>,
    sweeper: bool,
    quitting: bool,
}
#[derive(Clone, Default)]
pub struct ClientAccessState {
    inner: Arc<Mutex<Inner>>,
}
fn global() -> &'static ClientAccessState {
    static STATE: OnceLock<ClientAccessState> = OnceLock::new();
    STATE.get_or_init(ClientAccessState::default)
}

impl ClientAccessState {
    fn status(&self) -> Result<ClientAccessStatus, String> {
        let inner = self.inner.lock().map_err(|_| SESSION_UNAVAILABLE)?;
        Ok(ClientAccessStatus {
            enabled: inner.config.enabled,
            port: inner.config.port,
            url: inner
                .running
                .as_ref()
                .map(|_| format!("http://127.0.0.1:{}/mcp", inner.config.port)),
            error: inner.error.clone(),
        })
    }
    fn data_dir(&self, generation: u64) -> Result<PathBuf, String> {
        let inner = self.inner.lock().map_err(|_| SESSION_UNAVAILABLE)?;
        if inner.quitting || !inner.config.enabled || inner.generation != generation {
            return Err(BAD_TOKEN.into());
        }
        inner
            .data_dir
            .clone()
            .ok_or_else(|| client_tokens::UNAVAILABLE.into())
    }
    fn authenticate(
        &self,
        generation: u64,
        presented: Option<&str>,
    ) -> Result<Option<String>, String> {
        let data = self.data_dir(generation)?;
        let conn = runtime::open_existing(&data)?;
        let live = client_tokens::live(&conn)?;
        Ok(match_token(&live, presented).map(|token| token.token.token_id.clone()))
    }
    fn touch(
        &self,
        generation: u64,
        token_id: &str,
        fingerprint: &str,
        request: &Value,
        now: DateTime<Utc>,
    ) -> Result<Ticket, String> {
        let mut inner = self.inner.lock().map_err(|_| SESSION_UNAVAILABLE)?;
        if inner.quitting || !inner.config.enabled || inner.generation != generation {
            return Err(BAD_TOKEN.into());
        }
        let data_dir = inner.data_dir.clone().ok_or(SESSION_UNAVAILABLE)?;
        let conn = runtime::open_existing(&data_dir).map_err(|_| SESSION_UNAVAILABLE)?;
        let tx = Transaction::new_unchecked(&conn, TransactionBehavior::Immediate)
            .map_err(|_| SESSION_UNAVAILABLE)?;
        let live = client_tokens::live(&tx).map_err(|_| SESSION_UNAVAILABLE)?;
        let token = live
            .iter()
            .find(|token| {
                token.token.token_id == token_id
                    && mcp::tokens_match(token.fingerprint().as_bytes(), fingerprint.as_bytes())
            })
            .ok_or(BAD_TOKEN)?;
        let vault = inner
            .vault
            .clone()
            .filter(|vault| vault.id == token.token.vault_id);
        let Some(vault) = vault else {
            if matches!(
                request.get("method").and_then(Value::as_str),
                Some("initialize" | "tools/list" | "ping")
            ) {
                let actor = format!("{CLIENT_ACTOR_PREFIX}{}", token.token.slug);
                let grant = RunGrant::for_client(
                    &actor,
                    "",
                    Path::new(&token.token.vault_path),
                    &token.grant(),
                )?;
                client_tokens::stamp_used(&tx, token_id, &runtime_stamp(now))
                    .map_err(|_| SESSION_UNAVAILABLE)?;
                tx.commit().map_err(|_| SESSION_UNAVAILABLE)?;
                return Ok(Ticket {
                    state: self.clone(),
                    run_id: String::new(),
                    grant,
                });
            }
            return Err(format!("This token is for the vault {}, which isn't open in Cerebro. Open it there, then try again.", token.token.vault_path));
        };
        if runtime::scope::canonical_path(&vault.path) != token.token.vault_path {
            return Err(SESSION_UNAVAILABLE.into());
        }
        let old = inner
            .current
            .get(token_id)
            .and_then(|run| inner.sessions.get(run));
        let renew = request.get("method").and_then(Value::as_str) == Some("initialize")
            || old.is_none_or(|session| {
                now.signed_duration_since(session.last_call).num_minutes() >= IDLE_MINUTES
            });
        let run_id = if renew {
            client_tokens::session_id()?
        } else {
            old.expect("a reusable session exists").run_id.clone()
        };
        let actor = format!("{CLIENT_ACTOR_PREFIX}{}", token.token.slug);
        let grant = RunGrant::for_client(&actor, &run_id, &vault.path, &token.grant())?;
        if renew {
            let info = request.get("params").and_then(|p| p.get("clientInfo"));
            let name = info
                .and_then(|v| v.get("name"))
                .and_then(Value::as_str)
                .unwrap_or("");
            let version = info
                .and_then(|v| v.get("version"))
                .and_then(Value::as_str)
                .unwrap_or("");
            let detail = format!("{name} {version}");
            dispatch::begin_client_session(
                &tx,
                &dispatch::ClientSession {
                    run_id: &run_id,
                    vault_id: &vault.id,
                    store_uuid: vault.store.as_deref().ok_or(SESSION_UNAVAILABLE)?,
                    actor: &actor,
                    token_name: &token.token.name,
                    client_info: (!detail.trim().is_empty()).then_some(detail.trim()),
                    started_at: now,
                },
            )
            .map_err(|_| SESSION_UNAVAILABLE)?;
        }
        if !client_tokens::stamp_used(&tx, token_id, &runtime_stamp(now))
            .map_err(|_| SESSION_UNAVAILABLE)?
        {
            return Err(BAD_TOKEN.into());
        }
        tx.commit().map_err(|_| SESSION_UNAVAILABLE)?;
        let mut finished = Vec::new();
        if renew {
            if let Some(previous) = inner.current.remove(token_id) {
                if let Some(session) = inner.sessions.get_mut(&previous) {
                    session.closing = Some(End {
                        succeeded: true,
                        at: session.last_call,
                        quitting: false,
                    });
                }
                collect_finished(&mut inner, &mut finished);
            }
            let completion = inner.completions.register(&vault.path)?;
            inner.current.insert(token_id.into(), run_id.clone());
            inner.sessions.insert(
                run_id.clone(),
                Session {
                    run_id: run_id.clone(),
                    token_id: token_id.into(),
                    claim: token
                        .token
                        .toolsets
                        .iter()
                        .any(|id| crate::policy::tools::toolset_writes(id))
                        .then(|| {
                            crate::git::changeset::claim_run(
                                &vault.path,
                                &data_dir,
                                &run_id,
                                &actor,
                            )
                        }),
                    actor,
                    vault,
                    last_call: now,
                    in_flight: 0,
                    closing: None,
                    completion,
                },
            );
        }
        let session = inner.sessions.get_mut(&run_id).ok_or(SESSION_UNAVAILABLE)?;
        session.last_call = session.last_call.max(now);
        session.in_flight += 1;
        drop(inner);
        self.finish_all(finished);
        Ok(Ticket {
            state: self.clone(),
            run_id,
            grant,
        })
    }
    fn complete(&self, run_id: &str) {
        let mut finished = Vec::new();
        if let Ok(mut inner) = self.inner.lock() {
            if let Some(session) = inner.sessions.get_mut(run_id) {
                session.in_flight = session.in_flight.saturating_sub(1);
            }
            collect_finished(&mut inner, &mut finished);
        }
        self.finish_all(finished);
    }
    fn close(&self, only_token: Option<&str>, succeeded: bool, now: DateTime<Utc>, quitting: bool) {
        let mut finished = Vec::new();
        if let Ok(mut inner) = self.inner.lock() {
            mark_closed(&mut inner, only_token, succeeded, now, quitting);
            collect_finished(&mut inner, &mut finished);
        }
        self.finish_all(finished);
    }
    fn sweep(&self, now: DateTime<Utc>) {
        let mut finished = Vec::new();
        if let Ok(mut inner) = self.inner.lock() {
            finished.append(&mut inner.pending);
            let expired: Vec<_> = inner
                .sessions
                .values()
                .filter(|s| {
                    s.closing.is_none()
                        && s.in_flight == 0
                        && now.signed_duration_since(s.last_call).num_minutes() >= IDLE_MINUTES
                })
                .map(|s| (s.run_id.clone(), s.token_id.clone()))
                .collect();
            for (run, token) in expired {
                if let Some(s) = inner.sessions.get_mut(&run) {
                    s.closing = Some(End {
                        succeeded: true,
                        at: s.last_call,
                        quitting: false,
                    });
                }
                if inner.current.get(&token) == Some(&run) {
                    inner.current.remove(&token);
                }
            }
            collect_finished(&mut inner, &mut finished);
        }
        self.finish_all(finished);
    }
    fn stop_generation(&self, generation: u64) {
        self.stop_inner(Some(generation), Utc::now(), false);
    }
    fn stop(&self, now: DateTime<Utc>, quitting: bool) {
        self.stop_inner(None, now, quitting);
    }
    // Selected opens suspend access without turning this process into a quitting app.
    fn suspend_for_selected(&self, now: DateTime<Utc>) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.vault = None;
        }
        self.stop(now, false);
    }

    fn stop_inner(&self, generation: Option<u64>, now: DateTime<Utc>, quitting: bool) {
        let mut finished = Vec::new();
        let running = self.inner.lock().ok().and_then(|mut inner| {
            if generation.is_some_and(|g| inner.generation != g) {
                return None;
            }
            inner.generation = inner.generation.wrapping_add(1);
            inner.quitting |= quitting;
            if generation.is_some() {
                inner.error = Some(SESSION_UNAVAILABLE.into());
            }
            mark_closed(&mut inner, None, false, now, quitting);
            if quitting {
                finished.append(&mut inner.pending);
            }
            collect_finished(&mut inner, &mut finished);
            inner.running.take()
        });
        unblock(running);
        self.finish_all(finished);
    }
    fn finish_all(&self, finished: Vec<Finished>) {
        for mut finished in finished {
            if let Err(error) = finish_record(&finished) {
                log::warn!("client session could not finish: {error}");
                if !finished.end.quitting {
                    if let Ok(mut inner) = self.inner.lock() {
                        inner.error = Some(SESSION_UNAVAILABLE.into());
                        inner.pending.push(finished);
                    }
                    continue;
                }
            }
            mcp::forget_run(&finished.session.run_id);
            if finished.end.quitting || finished.session.claim.is_none() {
                finished.session.completion.confirm();
                continue;
            }
            // The extra Arc retains ownership if thread creation fails, so a
            // later sweep can retry without a checkpoint taking these paths.
            let pending = Arc::new(Mutex::new(Some(finished)));
            let worker = Arc::clone(&pending);
            let state = self.clone();
            let spawned = std::thread::Builder::new()
                .name("cerebro-client-settle".into())
                .spawn(move || {
                    let finished = worker.lock().ok().and_then(|mut item| item.take());
                    if let Some(finished) = finished {
                        if state.inner.lock().is_ok_and(|inner| inner.quitting) {
                            let mut finished = finished;
                            finished.session.completion.confirm();
                            return;
                        }
                        settle(finished);
                    }
                });
            if let Err(error) = spawned {
                log::warn!("client settlement could not start: {error}");
                if let Some(finished) = pending.lock().ok().and_then(|mut item| item.take()) {
                    if let Ok(mut inner) = self.inner.lock() {
                        inner.pending.push(finished);
                    }
                }
            }
        }
    }
    fn start<F>(&self, dispatch: Arc<F>) -> Result<(), String>
    where
        F: Fn(&RunGrant, &Value) -> Value + Send + Sync + 'static,
    {
        let mut inner = self.inner.lock().map_err(|_| SESSION_UNAVAILABLE)?;
        if !inner.config.enabled || inner.quitting || inner.running.is_some() {
            return Ok(());
        }
        let data_dir = inner.data_dir.as_ref().ok_or(client_tokens::UNAVAILABLE)?;
        let conn = runtime::open_existing(data_dir)?;
        client_tokens::live(&conn)?;
        let server = Arc::new(
            tiny_http::Server::http(("127.0.0.1", inner.config.port)).map_err(|e| e.to_string())?,
        );
        let port = server
            .server_addr()
            .to_ip()
            .ok_or("listener has no IP address")?
            .port();
        inner.config.port = port;
        let generation = inner.generation;
        let state = self.clone();
        let workers = mcp::serve_pool(
            Arc::clone(&server),
            "cerebro-client",
            WORKERS,
            Arc::new(move |request| {
                answer(request, port, generation, &state, &*dispatch);
            }),
        );
        if workers.is_empty() {
            return Err("no client worker could start".into());
        }
        inner.running = Some(Running {
            server,
            workers: workers.len(),
        });
        inner.error = None;
        if !inner.sweeper {
            let weak = Arc::downgrade(&self.inner);
            std::thread::Builder::new()
                .name("cerebro-client-sweep".into())
                .spawn(move || loop {
                    std::thread::sleep(Duration::from_secs(60));
                    let Some(inner) = weak.upgrade() else { break };
                    if inner.lock().is_ok_and(|s| s.quitting) {
                        break;
                    }
                    ClientAccessState { inner }.sweep(Utc::now());
                })
                .map_err(|e| e.to_string())?;
            inner.sweeper = true;
        }
        Ok(())
    }
    fn start_app(&self, app: &tauri::AppHandle) {
        let app = app.clone();
        if let Err(error) = self.start(Arc::new(move |grant: &RunGrant, request: &Value| {
            mcp::answer_value(&app, grant, request)
        })) {
            self.stop(Utc::now(), false);
            if let Ok(mut inner) = self.inner.lock() {
                inner.error = Some(error);
            }
        }
    }
}

struct Ticket {
    state: ClientAccessState,
    run_id: String,
    grant: RunGrant,
}
impl Drop for Ticket {
    fn drop(&mut self) {
        if !self.run_id.is_empty() {
            self.state.complete(&self.run_id);
        }
    }
}
fn runtime_stamp(now: DateTime<Utc>) -> String {
    now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
fn collect_finished(inner: &mut Inner, out: &mut Vec<Finished>) {
    let Some(data_dir) = inner.data_dir.clone() else {
        return;
    };
    let ids: Vec<_> = inner
        .sessions
        .values()
        .filter(|s| s.in_flight == 0 && s.closing.is_some())
        .map(|s| s.run_id.clone())
        .collect();
    for id in ids {
        if let Some(session) = inner.sessions.remove(&id) {
            out.push(Finished {
                end: session.closing.expect("selected closing session"),
                session,
                data_dir: data_dir.clone(),
            });
        }
    }
}
fn finish_record(finished: &Finished) -> Result<(), String> {
    let conn = runtime::open_existing(&finished.data_dir)?;
    let tx = Transaction::new_unchecked(&conn, TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    dispatch::finish_client_session(
        &tx,
        &finished.session.run_id,
        finished.end.succeeded,
        finished.end.at,
    )?;
    client_tokens::stamp_used(
        &tx,
        &finished.session.token_id,
        &runtime_stamp(finished.end.at),
    )?;
    tx.commit().map_err(|e| e.to_string())
}
fn mark_closed(
    inner: &mut Inner,
    token: Option<&str>,
    succeeded: bool,
    now: DateTime<Utc>,
    quitting: bool,
) {
    for session in inner
        .sessions
        .values_mut()
        .filter(|s| token.is_none_or(|id| s.token_id == id))
    {
        session.closing = Some(End {
            succeeded,
            at: if succeeded { session.last_call } else { now },
            quitting,
        });
        if inner.current.get(&session.token_id) == Some(&session.run_id) {
            inner.current.remove(&session.token_id);
        }
        // Exit does not wait for arbitrary network calls. Close its row and
        // release ownership without git; an outstanding ticket later drops inertly.
        if quitting {
            session.in_flight = 0;
        }
    }
}
fn unblock(running: Option<Running>) {
    if let Some(running) = running {
        for _ in 0..running.workers {
            running.server.unblock();
        }
    }
}

fn settle(finished: Finished) {
    settle_with(finished, |finished| {
        let session = &finished.session;
        let _ = crate::git::changeset::settle_run(crate::git::changeset::SettleRun {
            vault: &session.vault.path, data_dir: &finished.data_dir,
            vault_id: Some(&session.vault.id), run_id: &session.run_id,
            actor: Some(&session.actor), cli_paths: Vec::new(), summary: None,
        });
    });
}
/// The real owned-resource kernel; tests substitute Git I/O only. The guard
/// cannot confirm until work returns, and panic/unwind remains sticky failed.
fn settle_with(mut finished: Finished, work: impl FnOnce(&Finished)) {
    work(&finished);
    finished.session.completion.confirm();
    // Finished owns Session/RunClaim through work and drops them in field order.
}

fn match_token<'a>(
    tokens: &'a [client_tokens::LiveToken],
    presented: Option<&str>,
) -> Option<&'a client_tokens::LiveToken> {
    match_token_with(tokens, presented, mcp::tokens_match)
}
fn match_token_with<'a>(
    tokens: &'a [client_tokens::LiveToken],
    presented: Option<&str>,
    compare: impl Fn(&[u8], &[u8]) -> bool,
) -> Option<&'a client_tokens::LiveToken> {
    let raw = presented.unwrap_or_default();
    let shaped = raw.len() == 68
        && raw.starts_with("cbr_")
        && raw[4..]
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c));
    let hash = crate::ledger::sha256_hex(raw.as_bytes());
    let mut found = None;
    for token in tokens {
        let matches = compare(hash.as_bytes(), token.fingerprint().as_bytes());
        if shaped && matches {
            found = Some(token);
        }
    }
    found
}
fn text_response(
    request: tiny_http::Request,
    status: u16,
    body: &'static str,
    header: Option<&str>,
) {
    if status >= 400 {
        mcp::log_first_refusal(body, "client endpoint");
    }
    let mut response = tiny_http::Response::from_string(body).with_status_code(status);
    if let Some(header) = header.and_then(|h| h.parse::<tiny_http::Header>().ok()) {
        response = response.with_header(header);
    }
    let _ = request.respond(response);
}
fn answer<F>(
    mut request: tiny_http::Request,
    port: u16,
    generation: u64,
    state: &ClientAccessState,
    dispatch: &F,
) where
    F: Fn(&RunGrant, &Value) -> Value,
{
    let host = mcp::header_value(&request, "Host");
    let origin = mcp::header_value(&request, "Origin");
    if let Some((status, reason)) = mcp::loopback_refusal(host.as_deref(), origin.as_deref(), port)
    {
        mcp::log_first_refusal(reason, "client endpoint address");
        text_response(request, status, reason, None);
        return;
    }
    if request.url() != "/mcp" {
        text_response(
            request,
            404,
            "not found: this endpoint serves /mcp only",
            None,
        );
        return;
    }
    if request.method() != &tiny_http::Method::Post {
        text_response(
            request,
            405,
            "method not allowed: this endpoint takes POST only",
            Some("Allow: POST"),
        );
        return;
    }
    let authorization = mcp::header_value(&request, "Authorization");
    let bearer = authorization
        .as_deref()
        .and_then(|h| h.strip_prefix("Bearer "));
    let token_id = match state.authenticate(generation, bearer) {
        Ok(Some(id)) => id,
        Ok(None) => {
            let sent = authorization.is_some();
            text_response(
                request,
                401,
                if sent { BAD_TOKEN } else { NO_TOKEN },
                Some(if sent {
                    "WWW-Authenticate: Bearer realm=\"cerebro\", error=\"invalid_token\""
                } else {
                    "WWW-Authenticate: Bearer realm=\"cerebro\""
                }),
            );
            return;
        }
        Err(_) => {
            state.stop_generation(generation);
            text_response(request, 503, SESSION_UNAVAILABLE, None);
            return;
        }
    };
    let body = match mcp::read_body(&mut request, mcp::MAX_BODY_BYTES) {
        mcp::Body::Text(body) => body,
        mcp::Body::TooLarge => {
            text_response(
                request,
                413,
                "refused: the request body is larger than the endpoint reads",
                None,
            );
            return;
        }
        mcp::Body::Unreadable => {
            text_response(
                request,
                400,
                "parse error: the request body could not be read as UTF-8 text",
                None,
            );
            return;
        }
    };
    if mcp::is_notification(&body) {
        let _ = request.respond(tiny_http::Response::empty(202));
        return;
    }
    let parsed: Value = match serde_json::from_str(&body) {
        Ok(value) => value,
        Err(_) => {
            mcp::respond_json(
                request,
                200,
                &mcp::rpc_error(Value::Null, -32700, "parse error: invalid JSON"),
            );
            return;
        }
    };
    let id = parsed.get("id").cloned().unwrap_or(Value::Null);
    let fingerprint = crate::ledger::sha256_hex(bearer.unwrap_or_default().as_bytes());
    let ticket = match state.touch(generation, &token_id, &fingerprint, &parsed, Utc::now()) {
        Ok(ticket) => ticket,
        Err(error) => {
            if error == BAD_TOKEN {
                text_response(
                    request,
                    401,
                    BAD_TOKEN,
                    Some("WWW-Authenticate: Bearer realm=\"cerebro\", error=\"invalid_token\""),
                );
            } else {
                mcp::respond_json(
                    request,
                    200,
                    &mcp::rpc_error(
                        id,
                        if error == SESSION_UNAVAILABLE {
                            -32603
                        } else {
                            -32000
                        },
                        &error,
                    ),
                );
            }
            return;
        }
    };
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        dispatch(&ticket.grant, &parsed)
    }))
    .unwrap_or_else(|_| {
        mcp::rpc_error(id, -32603, "internal error: the call failed inside Cerebro")
    });
    drop(ticket);
    mcp::respond_json(request, 200, &result);
}

/// Revoke the previous vault's dispatch access before opening another one,
/// including when that next vault cannot register its runtime scope.
pub fn vault_opening(path: &Path) {
    global().opening(path, Utc::now());
}
impl ClientAccessState {
    fn opening(&self, path: &Path, now: DateTime<Utc>) {
        let canonical = runtime::scope::canonical_path(path);
        let mut finished = Vec::new();
        if let Ok(mut inner) = self.inner.lock() {
            if inner
                .vault
                .as_ref()
                .is_some_and(|v| v.path != Path::new(&canonical))
            {
                mark_closed(&mut inner, None, false, now, false);
                inner.vault = None;
                collect_finished(&mut inner, &mut finished);
            }
        }
        self.finish_all(finished);
    }
}
pub fn vault_opened(app: &tauri::AppHandle, path: &Path, scope: &runtime::VaultScope) {
    if crate::workspace_service::boundary::guard_legacy_scope(path, None, true).is_err() {
        global().suspend_for_selected(Utc::now());
        return;
    }
    use tauri::Manager;
    let Ok(_setup) = crate::agent::connector_setup_lock() else {
        return;
    };
    let state = global();
    let data = match crate::config_dir(app) {
        Ok(data) => data,
        Err(_) => return,
    };
    let config = app_config::load(&data).client_access;
    state.opening(path, Utc::now());
    if let Ok(mut inner) = state.inner.lock() {
        inner.data_dir = Some(data);
        // Settings owns live reconfiguration. On first open load the persisted
        // configuration; never replace a running listener's port from disk.
        if inner.running.is_none() {
            inner.config = config;
        }
        inner.vault = Some(Vault {
            path: PathBuf::from(runtime::scope::canonical_path(path)),
            id: scope.vault_id.clone(),
            store: scope.store_uuid.clone(),
        });
        if valid_port(i64::from(inner.config.port)).is_err() {
            inner.error = Some(PORT_WORDS.into());
            return;
        }
    }
    if state.inner.lock().is_ok_and(|s| s.config.enabled) {
        if let Err(error) = app
            .state::<crate::agent::AgentState>()
            .ensure_client_access_safe()
        {
            if let Ok(mut inner) = state.inner.lock() {
                inner.error = Some(error);
            }
            return;
        }
    }
    state.start_app(app);
}
pub fn connector_config() -> Result<ClientAccessConfig, String> {
    global()
        .inner
        .lock()
        .map(|inner| inner.config.clone())
        .map_err(|_| SESSION_UNAVAILABLE.into())
}
pub fn shut_down() {
    global().stop(Utc::now(), true);
}
pub(crate) fn suspend_for_selected() {
    global().suspend_for_selected(Utc::now());
}

pub(super) fn token_created() { /* Authentication reads durable rows on every request. */
}
pub(super) fn token_revoked(id: &str, recorded: bool) {
    if recorded {
        global().close(Some(id), false, Utc::now(), false);
    } else {
        global().stop(Utc::now(), false);
    }
}
#[tauri::command(async)]
pub fn client_access_status() -> Result<ClientAccessStatus, String> {
    global().status()
}
fn valid_port(port: i64) -> Result<u16, String> {
    u16::try_from(port)
        .ok()
        .filter(|p| *p >= 1024)
        .ok_or_else(|| PORT_WORDS.into())
}
#[tauri::command(async)]
pub fn set_client_access(
    app: tauri::AppHandle,
    enabled: bool,
    port: i64,
) -> Result<ClientAccessStatus, String> {
    use tauri::Manager;
    if enabled {
        crate::workspace_service::native_admission::guard_active_enable(
            &crate::workspace_service::authority::context().map_err(|e| e.message)?,
        )
        .map_err(|e| e.message)?;
    }
    let port = valid_port(port)?;
    let _setup = crate::agent::connector_setup_lock()?;
    if enabled {
        app.state::<crate::agent::AgentState>()
            .ensure_client_access_safe()?;
    }
    let state = global();
    let data = crate::config_dir(&app)?;
    let mut finished = Vec::new();
    let running = {
        let mut inner = state.inner.lock().map_err(|_| SESSION_UNAVAILABLE)?;
        let mut config = app_config::load(&data);
        config.client_access = ClientAccessConfig { enabled, port };
        app_config::save(&data, &config)?;
        if inner.config == config.client_access && (inner.running.is_some() || !enabled) {
            drop(inner);
            return state.status();
        }
        inner.generation = inner.generation.wrapping_add(1);
        mark_closed(&mut inner, None, false, Utc::now(), false);
        collect_finished(&mut inner, &mut finished);
        inner.config = config.client_access;
        inner.data_dir = Some(data);
        inner.error = None;
        inner.running.take()
    };
    unblock(running);
    state.finish_all(finished);
    state.start_app(&app);
    state.status()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::testutil;
    use serde_json::json;
    use std::io::{Read, Write};
    use std::net::{Shutdown, TcpStream};

    fn at(minutes: i64) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-10-15T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc)
            + chrono::Duration::minutes(minutes)
    }
    struct Fixture {
        sink_guard: Option<std::sync::MutexGuard<'static, ()>>,
        dir: PathBuf,
        conn: rusqlite::Connection,
        state: ClientAccessState,
        token: client_tokens::CreatedClientToken,
    }
    impl Fixture {
        fn new(label: &str) -> Self {
            let dir = testutil::temp_vault(label);
            let conn = runtime::open(&dir).unwrap();
            let vault = runtime::scope::register(&conn, &dir).unwrap();
            let token = client_tokens::create(
                &conn,
                &vault,
                &client_tokens::ClientTokenRequest {
                    name: "Terminal".into(),
                    toolsets: vec!["read".into()],
                    write_scope: vec![],
                    read_scope: None,
                },
                &runtime_stamp(at(0)),
            )
            .unwrap();
            let state = ClientAccessState::default();
            {
                let mut inner = state.inner.lock().unwrap();
                inner.config = ClientAccessConfig {
                    enabled: true,
                    port: 0,
                };
                inner.data_dir = Some(dir.clone());
                inner.vault = Some(Vault {
                    path: PathBuf::from(runtime::scope::canonical_path(&dir)),
                    id: vault,
                    store: Some("store".into()),
                });
            }
            Self {
                sink_guard: None,
                dir,
                conn,
                state,
                token,
            }
        }
        fn touch(&self, method: &str, minutes: i64) -> Result<Ticket, String> {
            let generation = self.state.inner.lock().unwrap().generation;
            self.state.touch(generation,&self.token.token.token_id,&crate::ledger::sha256_hex(self.token.secret.as_bytes()),&json!({"id":1,"method":method,"params":{"clientInfo":{"name":"test","version":"1"}}}),at(minutes))
        }
        fn start(&self) -> u16 {
            self.state.start(Arc::new(|grant:&RunGrant,request:&Value|json!({"jsonrpc":"2.0","id":request["id"],"result":{"run":grant.run_id,"actor":grant.actor,"tools":grant.tools}}))).unwrap();
            self.state.status().unwrap().port
        }
        fn row(&self, run: &str) -> (String, Option<String>, String) {
            self.conn
                .query_row(
                    "SELECT outcome,ended_at,usage_state FROM runs WHERE run_id=?1",
                    [run],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .unwrap()
        }
        fn count(&self) -> i64 {
            self.conn
                .query_row("SELECT count(*) FROM runs", [], |r| r.get(0))
                .unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            self.state.stop(at(100), true);
            if self.sink_guard.is_some() {
                runtime::sink::disarm();
            }
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }
    struct Response {
        status: u16,
        head: String,
        body: String,
    }
    fn send(
        port: u16,
        method: &str,
        path: &str,
        headers: &[(&str, String)],
        body: &[u8],
        declared: Option<usize>,
    ) -> Response {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        let mut raw = format!("{method} {path} HTTP/1.1\r\n");
        for (key, value) in headers {
            raw.push_str(&format!("{key}: {value}\r\n"));
        }
        raw.push_str(&format!(
            "Content-Length: {}\r\nConnection: close\r\n\r\n",
            declared.unwrap_or(body.len())
        ));
        stream.write_all(raw.as_bytes()).unwrap();
        stream.write_all(body).unwrap();
        stream.shutdown(Shutdown::Write).unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        let (head, body) = response.split_once("\r\n\r\n").unwrap();
        Response {
            status: head.split(' ').nth(1).unwrap().parse().unwrap(),
            head: head.to_string(),
            body: body.to_string(),
        }
    }
    fn headers(port: u16, secret: Option<&str>) -> Vec<(&'static str, String)> {
        let mut out = vec![("Host", format!("127.0.0.1:{port}"))];
        if let Some(secret) = secret {
            out.push(("Authorization", format!("Bearer {secret}")));
        }
        out
    }
    fn rpc(f: &Fixture, port: u16, body: &str) -> Response {
        send(
            port,
            "POST",
            "/mcp",
            &headers(port, Some(&f.token.secret)),
            body.as_bytes(),
            None,
        )
    }

    #[test]
    fn nothing_listens_until_turned_on() {
        let f = Fixture::new("client-off");
        f.state.inner.lock().unwrap().config.enabled = false;
        f.state
            .start(Arc::new(|_: &RunGrant, _: &Value| panic!("off")))
            .unwrap();
        assert!(f.state.status().unwrap().url.is_none());
        assert!(f.state.inner.lock().unwrap().running.is_none());
        f.state.inner.lock().unwrap().config.enabled = true;
        let port = f.start();
        assert!(TcpStream::connect(("127.0.0.1", port)).is_ok());
    }
    #[test]
    fn only_its_own_address_reaches_the_client_port() {
        let f = Fixture::new("client-address");
        let port = f.start();
        assert_eq!(send(port, "POST", "/mcp", &[], b"{}", None).status, 400);
        for host in [
            "evil.example".into(),
            format!("localhost:{}", port.saturating_sub(1)),
            format!("127.0.0.1:{port}.evil"),
        ] {
            assert_eq!(
                send(port, "POST", "/mcp", &[("Host", host)], b"{}", None).status,
                403
            );
        }
        let mut h = headers(port, Some(&f.token.secret));
        h.push(("Origin", "https://evil.example".into()));
        assert_eq!(send(port, "POST", "/mcp", &h, b"{}", None).status, 403);
        assert_eq!(f.count(), 0);
    }
    #[test]
    fn anything_but_post_gets_405_with_allow_post() {
        let f = Fixture::new("client-method");
        let port = f.start();
        for method in ["GET", "PUT", "DELETE", "OPTIONS"] {
            let r = send(port, method, "/mcp", &headers(port, None), b"", None);
            assert_eq!(r.status, 405);
            assert!(r.head.contains("Allow: POST"));
        }
    }
    #[test]
    fn a_path_but_mcp_gets_404() {
        let f = Fixture::new("client-path");
        let port = f.start();
        for path in ["/", "/mcp/", "/mcp?x=1"] {
            assert_eq!(
                send(port, "POST", path, &headers(port, None), b"{}", None).status,
                404
            );
        }
    }
    #[test]
    fn no_token_gets_401_with_a_bearer_challenge() {
        let f = Fixture::new("client-auth");
        let port = f.start();
        let r = send(port, "POST", "/mcp", &headers(port, None), b"{}", None);
        assert_eq!(r.status, 401);
        assert!(r
            .head
            .contains("WWW-Authenticate: Bearer realm=\"cerebro\""));
        assert!(!r.head.contains("invalid_token"));
        assert_eq!(r.body, NO_TOKEN);
        assert_eq!(f.count(), 0);
    }
    #[test]
    fn an_unknown_or_revoked_token_gets_401_invalid_token() {
        let f = Fixture::new("client-revoked");
        let port = f.start();
        for secret in [
            "run-bearer".to_string(),
            format!("cbr_{}", "a".repeat(64)),
            "cbr_short".into(),
        ] {
            let r = send(
                port,
                "POST",
                "/mcp",
                &headers(port, Some(&secret)),
                b"{}",
                None,
            );
            assert_eq!(r.status, 401);
            assert!(r.head.contains("error=\"invalid_token\""));
        }
        client_tokens::revoke(&f.conn, &f.token.token.token_id).unwrap();
        assert_eq!(rpc(&f, port, "{}").status, 401);
        assert_eq!(f.count(), 0);
    }
    #[test]
    fn an_unauthenticated_body_is_never_read() {
        let f = Fixture::new("client-auth-first");
        let port = f.start();
        let r = send(
            port,
            "POST",
            "/mcp",
            &headers(port, None),
            b"",
            Some(mcp::MAX_BODY_BYTES + 1),
        );
        assert_eq!(r.status, 401);
        assert_eq!(f.token.token.last_used_at, None);
        assert_eq!(
            client_tokens::list(&f.conn, None).unwrap()[0].last_used_at,
            None
        );
    }
    #[test]
    fn an_oversized_body_with_a_token_gets_413() {
        let f = Fixture::new("client-large");
        let port = f.start();
        let r = send(
            port,
            "POST",
            "/mcp",
            &headers(port, Some(&f.token.secret)),
            b"",
            Some(mcp::MAX_BODY_BYTES + 1),
        );
        assert_eq!(r.status, 413);
        assert_eq!(f.count(), 0);
    }
    #[test]
    fn a_notification_gets_202() {
        let f = Fixture::new("client-notification");
        let port = f.start();
        assert_eq!(
            rpc(
                &f,
                port,
                r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#
            )
            .status,
            202
        );
        assert_eq!(f.count(), 0);
    }
    #[test]
    fn invalid_text_and_json_never_open_a_session() {
        let f = Fixture::new("client-invalid");
        let port = f.start();
        assert_eq!(
            send(
                port,
                "POST",
                "/mcp",
                &headers(port, Some(&f.token.secret)),
                &[255],
                None
            )
            .status,
            400
        );
        let r = rpc(&f, port, "{");
        assert_eq!(r.status, 200);
        assert_eq!(
            serde_json::from_str::<Value>(&r.body).unwrap()["error"]["code"],
            -32700
        );
        assert_eq!(f.count(), 0);
    }
    #[test]
    fn every_answered_call_carries_its_session_run() {
        let f = Fixture::new("client-run");
        let port = f.start();
        let r = rpc(&f, port, r#"{"id":1,"method":"tools/list"}"#);
        let answer: Value = serde_json::from_str(&r.body).unwrap();
        let run = answer["result"]["run"].as_str().unwrap();
        assert_eq!(run.len(), 32);
        assert_eq!(answer["result"]["actor"], "client:terminal");
        assert_eq!(f.count(), 1);
        assert_eq!(f.row(run).0, "running");
        assert_eq!(f.conn.query_row("SELECT counters_booked,writes_booked,mode,lane,json_extract(cause,'$.kind') FROM runs WHERE run_id=?1",[run],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,i64>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,String>(4)?))).unwrap(),(1,1,"attended".into(),"agent".into(),"client".into()));
    }
    #[test]
    fn calls_inside_the_idle_window_share_a_session() {
        let f = Fixture::new("client-reuse");
        let first = f.touch("initialize", 0).unwrap();
        let id = first.run_id.clone();
        drop(first);
        let second = f.touch("tools/list", 29).unwrap();
        assert_eq!(second.run_id, id);
        assert_eq!(f.count(), 1);
    }
    #[test]
    fn a_call_after_thirty_idle_minutes_opens_a_new_session_and_ends_the_old_at_its_last_call() {
        let f = Fixture::new("client-idle");
        let first = f.touch("initialize", 0).unwrap();
        let id = first.run_id.clone();
        drop(first);
        let second = f.touch("tools/list", 30).unwrap();
        assert_ne!(second.run_id, id);
        assert_eq!(
            f.row(&id),
            (
                "succeeded".into(),
                Some(runtime_stamp(at(0))),
                "unknown".into()
            )
        );
        assert_eq!(f.count(), 2);
    }
    #[test]
    fn a_second_initialize_ends_the_first_session_succeeded() {
        let f = Fixture::new("client-init");
        let first = f.touch("initialize", 0).unwrap();
        let id = first.run_id.clone();
        drop(first);
        let second = f.touch("initialize", 1).unwrap();
        assert_ne!(second.run_id, id);
        assert_eq!(f.row(&id).0, "succeeded");
    }
    #[test]
    fn revoking_a_token_ends_its_session_cancelled_and_its_next_call_gets_401() {
        let f = Fixture::new("client-revoke-live");
        let first = f.touch("initialize", 0).unwrap();
        let id = first.run_id.clone();
        drop(first);
        client_tokens::revoke(&f.conn, &f.token.token.token_id).unwrap();
        f.state
            .close(Some(&f.token.token.token_id), false, at(1), false);
        assert_eq!(f.row(&id).0, "cancelled");
        assert!(f
            .state
            .authenticate(0, Some(&f.token.secret))
            .unwrap()
            .is_none());
    }
    #[test]
    fn a_vault_switch_ends_the_other_vaults_sessions() {
        let f = Fixture::new("client-vault-switch");
        let first = f.touch("initialize", 0).unwrap();
        let id = first.run_id.clone();
        drop(first);
        f.state.opening(&f.dir.join("other"), at(1));
        assert_eq!(f.row(&id).0, "cancelled");
        assert!(f.state.inner.lock().unwrap().vault.is_none());
    }
    #[test]
    fn quitting_ends_every_session_cancelled_even_with_a_call_in_flight() {
        let f = Fixture::new("client-exit");
        let ticket = f.touch("initialize", 0).unwrap();
        let id = ticket.run_id.clone();
        f.state.stop(at(2), true);
        assert_eq!(f.row(&id).0, "cancelled");
        assert!(f.state.inner.lock().unwrap().sessions.is_empty());
        drop(ticket);
    }
    #[test]
    fn selected_suspend_stops_listener_and_session_then_allows_actual_legacy_rebind() {
        let f = Fixture::new("m99-client-selected-suspend");
        let legacy = f.state.inner.lock().unwrap().vault.clone().unwrap();
        let old_port = f.start();
        assert!(TcpStream::connect(("127.0.0.1", old_port)).is_ok());
        let ticket = f.touch("initialize", 0).unwrap();
        let previous_run = ticket.run_id.clone();
        drop(ticket);
        assert_eq!(f.row(&previous_run).0, "running");
        f.state.suspend_for_selected(at(1));
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while TcpStream::connect(("127.0.0.1", old_port)).is_ok()
            && std::time::Instant::now() < deadline
        {
            std::thread::sleep(Duration::from_millis(10));
        }
        let old_listener_closed = TcpStream::connect(("127.0.0.1", old_port)).is_err();
        let session_cancelled = f.row(&previous_run).0 == "cancelled";
        let (binding_cleared, enabled, quitting) = {
            let inner = f.state.inner.lock().unwrap();
            (inner.vault.is_none(), inner.config.enabled, inner.quitting)
        };
        // This is the same valid legacy Vault the runtime/token fixture bound,
        // installed at vault_opened's state seam before its real start method.
        {
            let mut inner = f.state.inner.lock().unwrap();
            inner.vault = Some(legacy);
            inner.config.port = 0;
        }
        f.state.start(Arc::new(|_: &RunGrant, request: &Value| {
            json!({"jsonrpc":"2.0","id":request["id"],"result":{"legacy":true}})
        })).unwrap();
        let restarted = f.state.status().unwrap();
        let legacy_rpc_ok = if restarted.url.is_some() {
            rpc(
                &f,
                restarted.port,
                r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#,
            )
            .status
                == 200
        } else {
            false
        };
        assert!(old_listener_closed && session_cancelled && binding_cleared && enabled && !quitting && legacy_rpc_ok,
            "closed={old_listener_closed},cancelled={session_cancelled},unbound={binding_cleared},enabled={enabled},quitting={quitting},legacy_rpc={legacy_rpc_ok}");
    }
    #[test]
    fn a_token_whose_vault_is_closed_can_discover_but_cannot_read_data_or_open_a_session() {
        let f = Fixture::new("client-closed");
        f.state.inner.lock().unwrap().vault = None;
        for method in ["initialize", "tools/list", "ping"] {
            let ticket = f.touch(method, 0).unwrap();
            assert!(ticket.run_id.is_empty());
        }
        assert_eq!(f.count(), 0);
        let error = f.touch("tools/call", 0).err().unwrap();
        assert!(error.contains(&f.token.token.vault_path));
        assert!(error.contains("isn't open"));
        assert_eq!(f.count(), 0);
    }
    #[test]
    fn a_session_whose_row_cannot_be_written_answers_nothing() {
        let f = Fixture::new("client-row-failure");
        f.conn.execute_batch("CREATE TRIGGER refuse_client_run BEFORE INSERT ON runs BEGIN SELECT RAISE(ABORT,'test refusal'); END;").unwrap();
        assert_eq!(f.touch("initialize", 0).err().unwrap(), SESSION_UNAVAILABLE);
        assert_eq!(f.count(), 0);
        assert_eq!(
            client_tokens::list(&f.conn, None).unwrap()[0].last_used_at,
            None
        );
    }
    #[test]
    fn last_used_is_stamped_at_open_and_close() {
        let f = Fixture::new("client-last-used");
        drop(f.touch("initialize", 0).unwrap());
        assert_eq!(
            client_tokens::list(&f.conn, None).unwrap()[0].last_used_at,
            Some(runtime_stamp(at(0)))
        );
        f.state.close(None, false, at(3), false);
        assert_eq!(
            client_tokens::list(&f.conn, None).unwrap()[0].last_used_at,
            Some(runtime_stamp(at(3)))
        );
    }
    #[test]
    fn a_session_waits_for_its_in_flight_call_before_finishing() {
        let f = Fixture::new("client-in-flight");
        let ticket = f.touch("initialize", 0).unwrap();
        let id = ticket.run_id.clone();
        f.state.close(None, false, at(1), false);
        assert_eq!(f.row(&id).0, "running");
        drop(ticket);
        assert_eq!(f.row(&id).0, "cancelled");
    }
    #[test]
    fn a_failed_close_is_retained_and_retried() {
        let f = Fixture::new("client-close-retry");
        let ticket = f.touch("initialize", 0).unwrap();
        let id = ticket.run_id.clone();
        drop(ticket);
        f.conn.execute_batch("CREATE TRIGGER refuse_client_close BEFORE UPDATE OF outcome ON runs BEGIN SELECT RAISE(ABORT,'test refusal'); END;").unwrap();
        f.state.close(None, false, at(1), false);
        assert_eq!(f.row(&id).0, "running");
        assert_eq!(f.state.inner.lock().unwrap().pending.len(), 1);
        f.conn
            .execute_batch("DROP TRIGGER refuse_client_close;")
            .unwrap();
        f.state.sweep(at(2));
        assert_eq!(f.row(&id).0, "cancelled");
        assert!(f.state.inner.lock().unwrap().pending.is_empty());
    }
    #[test]
    fn a_stale_listener_cannot_close_a_newer_session() {
        let f = Fixture::new("client-generation");
        f.state.inner.lock().unwrap().generation = 1;
        let ticket = f.touch("initialize", 0).unwrap();
        let id = ticket.run_id.clone();
        drop(ticket);
        f.state.stop_generation(0);
        assert_eq!(f.row(&id).0, "running");
        assert_eq!(f.state.inner.lock().unwrap().generation, 1);
    }
    #[test]
    fn the_port_refuses_outside_1024_to_65535() {
        for port in [-1, 0, 80, 1023, 65536, i64::MAX] {
            assert_eq!(valid_port(port).unwrap_err(), PORT_WORDS);
        }
        for port in [1024, 37421, 65535] {
            assert_eq!(valid_port(port).unwrap(), port as u16);
        }
    }
    #[test]
    fn token_comparison_reads_every_slot() {
        let f = Fixture::new("client-token-slots");
        for n in 0..4 {
            client_tokens::create(
                &f.conn,
                &f.token.token.vault_id,
                &client_tokens::ClientTokenRequest {
                    name: format!("App {n}"),
                    toolsets: vec!["read".into()],
                    write_scope: vec![],
                    read_scope: None,
                },
                &runtime_stamp(at(0)),
            )
            .unwrap();
        }
        let tokens = client_tokens::live(&f.conn).unwrap();
        for secret in [Some(f.token.secret.as_str()), Some("bad"), None] {
            let calls = std::cell::Cell::new(0);
            let result = match_token_with(&tokens, secret, |a, b| {
                calls.set(calls.get() + 1);
                mcp::tokens_match(a, b)
            });
            assert_eq!(calls.get(), 5);
            assert_eq!(result.is_some(), secret == Some(f.token.secret.as_str()));
        }
    }
    fn repo_fixture(label: &str, writing: bool) -> Fixture {
        let held = runtime::sink::test_lock();
        let mut f = Fixture::new(label);
        runtime::sink::arm(&f.dir).unwrap();
        f.sink_guard = Some(held);
        if writing {
            client_tokens::revoke(&f.conn, &f.token.token.token_id).unwrap();
            f.token = client_tokens::create(
                &f.conn,
                &f.token.token.vault_id,
                &client_tokens::ClientTokenRequest {
                    name: "Terminal".into(),
                    toolsets: vec!["read".into(), "write".into()],
                    write_scope: vec!["notes".into()],
                    read_scope: None,
                },
                &runtime_stamp(at(0)),
            )
            .unwrap();
        }
        testutil::write(&f.dir, ".gitignore", "runtime.db*\n");
        testutil::write(&f.dir, "notes/a.md", "# A\n");
        testutil::write(&f.dir, "notes/b.md", "# B\n");
        crate::git::commit::init_repo(&f.dir).unwrap();
        f
    }
    fn git(f: &Fixture, args: &[&str]) -> String {
        crate::git::command::run_str(&f.dir, args).unwrap()
    }
    fn wrote(f: &Fixture, run: &str) {
        testutil::write(&f.dir, "notes/a.md", "# A\n\nClient edit.\n");
        testutil::write(&f.dir, "notes/b.md", "# B\n\nHuman edit.\n");
        crate::runtime::vault_writes::record_at(
            &f.conn,
            &f.token.token.vault_id,
            &crate::runtime::vault_writes::WriteRow {
                kind: "vault.write",
                path: "notes/a.md",
                to: None,
                content_hash: None,
                actor: Some("client:terminal"),
                run_id: Some(run),
                approved_by: None,
            },
            at(0),
        )
        .unwrap();
    }
    fn wait_settled(f: &Fixture, run: &str) {
        let until = std::time::Instant::now() + Duration::from_secs(10);
        loop {
            let count: i64 = f
                .conn
                .query_row(
                    "SELECT count(*) FROM run_commits WHERE run_id=?1",
                    [run],
                    |r| r.get(0),
                )
                .unwrap();
            if count == 1 && crate::git::changeset::owned_paths(&f.dir).is_empty() {
                return;
            }
            assert!(
                std::time::Instant::now() < until,
                "client settlement completed"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    #[test]
    fn a_writing_session_commits_its_writes_when_it_ends() {
        let f = repo_fixture("client-settle", true);
        let ticket = f.touch("initialize", 0).unwrap();
        let run = ticket.run_id.clone();
        drop(ticket);
        wrote(&f, &run);
        assert_eq!(
            crate::git::changeset::owned_paths(&f.dir)["notes/a.md"].run_id,
            run
        );
        f.state.close(None, true, at(1), false);
        wait_settled(&f, &run);
        let message = git(&f, &["log", "-1", "--format=%B"]);
        assert!(message.contains(&format!("Cerebro-Run: {run}")));
        assert!(message.contains("Cerebro-Actor: client:terminal"));
        assert_eq!(
            git(&f, &["show", "--format=", "--name-only", "HEAD"]).trim(),
            "notes/a.md"
        );
        assert!(git(&f, &["status", "--porcelain"]).contains("notes/b.md"));
    }
    #[test]
    fn a_read_only_session_takes_no_claim_and_commits_nothing() {
        let f = repo_fixture("client-read-no-settle", false);
        let head = git(&f, &["rev-parse", "HEAD"]);
        let ticket = f.touch("initialize", 0).unwrap();
        let run = ticket.run_id.clone();
        drop(ticket);
        assert!(f.state.inner.lock().unwrap().sessions[&run].claim.is_none());
        wrote(&f, &run);
        assert!(crate::git::changeset::owned_paths(&f.dir).is_empty());
        f.state.close(None, true, at(1), false);
        assert_eq!(git(&f, &["rev-parse", "HEAD"]), head);
    }
    #[test]
    fn quitting_commits_nothing() {
        let f = repo_fixture("client-quit-no-settle", true);
        let head = git(&f, &["rev-parse", "HEAD"]);
        let ticket = f.touch("initialize", 0).unwrap();
        let run = ticket.run_id.clone();
        drop(ticket);
        wrote(&f, &run);
        f.state.stop(at(1), true);
        assert_eq!(git(&f, &["rev-parse", "HEAD"]), head);
        assert!(crate::git::changeset::owned_paths(&f.dir).is_empty());
        assert_eq!(f.row(&run).0, "cancelled");
    }
    #[test]
    fn a_sessions_paths_stay_owned_until_its_commit_lands() {
        let f = repo_fixture("client-held-settlement", true);
        let ticket = f.touch("initialize", 0).unwrap();
        let run = ticket.run_id.clone();
        drop(ticket);
        wrote(&f, &run);
        let lock = crate::git::commit::repo_lock(&f.dir);
        let held = crate::git::commit::hold(&lock);
        f.state.close(None, true, at(1), false);
        assert_eq!(
            crate::git::changeset::owned_paths(&f.dir)["notes/a.md"].run_id,
            run
        );
        assert_eq!(f.row(&run).0, "succeeded");
        drop(held);
        wait_settled(&f, &run);
    }
    #[test]
    fn revocation_between_authentication_and_session_admission_refuses_dispatch() {
        let f = Fixture::new("client-revoke-race");
        assert_eq!(
            f.state.authenticate(0, Some(&f.token.secret)).unwrap(),
            Some(f.token.token.token_id.clone())
        );
        client_tokens::revoke(&f.conn, &f.token.token.token_id).unwrap();
        assert_eq!(f.touch("initialize", 0).err().unwrap(), BAD_TOKEN);
        assert_eq!(f.count(), 0);
    }
    #[test]
    fn reconfiguration_between_authentication_and_admission_refuses_the_old_worker() {
        let f = Fixture::new("client-reconfigure-race");
        assert!(f
            .state
            .authenticate(0, Some(&f.token.secret))
            .unwrap()
            .is_some());
        f.state.stop(at(1), false);
        let result = f.state.touch(
            0,
            &f.token.token.token_id,
            &crate::ledger::sha256_hex(f.token.secret.as_bytes()),
            &json!({"id":1,"method":"initialize"}),
            at(1),
        );
        assert_eq!(result.err().unwrap(), BAD_TOKEN);
        assert_eq!(f.count(), 0);
    }
    #[test]
    fn a_closed_session_forgets_its_run_maps() {
        let f = Fixture::new("client-forgets");
        let ticket = f.touch("initialize", 0).unwrap();
        let run = ticket.run_id.clone();
        drop(ticket);
        mcp::note_tool_call(&run, "get_note");
        f.state.close(None, true, at(1), false);
        assert_eq!(mcp::take_tool_calls(&run), Some(BTreeMap::new()));
    }
}

impl ClientAccessState {
    fn wait_opening_settlement(&self, keep: Option<&Path>, timeout: Duration) -> Result<(), String> {
        let keep = keep.map(|path| PathBuf::from(runtime::scope::canonical_path(path)));
        let deadline = std::time::Instant::now() + timeout;
        loop {
            let snapshot = match self.inner.try_lock() {
                Ok(inner) => {
                    let pending = inner.sessions.values().any(|session| keep.as_ref() != Some(&session.vault.path))
                        || inner.pending.iter().any(|finished| keep.as_ref() != Some(&finished.session.vault.path));
                    Some((inner.completions.clone(), pending))
                }
                Err(std::sync::TryLockError::WouldBlock) => None,
                Err(std::sync::TryLockError::Poisoned(_)) => return Err(SESSION_UNAVAILABLE.into()),
            };
            if let Some((book, pending)) = snapshot {
                match book.inner.try_lock() {
                    Ok(completion) => {
                        if completion.failed.iter().any(|vault| keep.as_ref() != Some(vault)) {
                            return Err("A previous client writer ended without confirmed cleanup. Workspace opening is unavailable.".into());
                        }
                        let unsettled = completion.active.iter().any(|(vault, count)| *count > 0 && keep.as_ref() != Some(vault));
                        if !pending && !unsettled { return Ok(()); }
                    }
                    Err(std::sync::TryLockError::WouldBlock) => {}
                    Err(std::sync::TryLockError::Poisoned(_)) => return Err(SESSION_UNAVAILABLE.into()),
                };
            }
            if std::time::Instant::now() >= deadline {
                return Err("Previous client requests or Git settlement are still finishing. Workspace opening is unavailable.".into());
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }
}
/// Opening/cleanup only: call after closing old admission, outside ActiveRoot
/// and native/storage locks. This waits; it never retries a session or Git work.
pub(crate) fn wait_for_opening(keep: Option<&Path>, timeout: Duration) -> Result<(), String> {
    global().wait_opening_settlement(keep, timeout)
}

#[cfg(test)]
mod opening_settlement_tests {
    use super::*;
    fn at() -> DateTime<Utc> { DateTime::parse_from_rfc3339("2026-10-26T00:00:00Z").unwrap().with_timezone(&Utc) }
    fn session(state: &ClientAccessState, root: &str, flight: usize) -> Session {
        let vault = Vault { path: PathBuf::from(root), id: "synthetic-vault".into(), store: None };
        let completion = state.inner.lock().unwrap().completions.register(&vault.path).unwrap();
        Session { run_id: "synthetic-run".into(), token_id: "synthetic-token".into(), actor: "client:synthetic".into(),
            vault, claim: None, last_call: at(), in_flight: flight, closing: None, completion }
    }
    #[test]
    fn actual_opening_keeps_same_vault_but_waits_for_closed_inflight_session() {
        let state = ClientAccessState::default();
        let active = session(&state, "/synthetic/vault-a", 1);
        {
            let mut inner = state.inner.lock().unwrap();
            inner.vault = Some(active.vault.clone());
            inner.data_dir = Some(PathBuf::from("/synthetic/no-database-opened"));
            inner.sessions.insert(active.run_id.clone(), active);
        }
        state.opening(Path::new("/synthetic/vault-b"), at());
        let same = state.wait_opening_settlement(Some(Path::new("/synthetic/vault-a")), Duration::ZERO);
        let other = state.wait_opening_settlement(Some(Path::new("/synthetic/vault-b")), Duration::ZERO);
        let selected = state.wait_opening_settlement(None, Duration::ZERO);
        assert!(same.is_ok());
        assert!(other.is_err(), "closed in-flight requests retain their original vault scope");
        assert!(selected.is_err());
    }
    #[test]
    fn real_settle_kernel_retains_original_scope_after_session_map_removal() {
        let state = ClientAccessState::default();
        let mut ended = session(&state, "/synthetic/vault-a", 0);
        ended.closing = Some(End { succeeded: false, at: at(), quitting: false });
        let mut finished = Vec::new();
        {
            let mut inner = state.inner.lock().unwrap();
            inner.data_dir = Some(PathBuf::from("/synthetic/no-database-opened"));
            inner.sessions.insert(ended.run_id.clone(), ended);
            collect_finished(&mut inner, &mut finished);
            assert!(inner.sessions.is_empty());
        }
        let ended = finished.pop().unwrap();
        let (ready_send, ready) = std::sync::mpsc::sync_channel(0);
        let (release, wait) = std::sync::mpsc::sync_channel(0);
        let worker = std::thread::spawn(move || settle_with(ended, |_| { ready_send.send(()).unwrap(); let _ = wait.recv(); }));
        ready.recv().unwrap();
        // An unrelated current-vault change cannot relabel this original A resource.
        state.inner.lock().unwrap().vault = Some(Vault { path: PathBuf::from("/synthetic/vault-b"), id: "other-vault".into(), store: None });
        let held = state.wait_opening_settlement(Some(Path::new("/synthetic/vault-b")), Duration::ZERO);
        let same = state.wait_opening_settlement(Some(Path::new("/synthetic/vault-a")), Duration::ZERO);
        release.send(()).unwrap();
        worker.join().unwrap();
        let settled = state.wait_opening_settlement(None, Duration::ZERO);
        assert!(held.is_err(), "a missing session-map row is not finished Git settlement");
        assert!(same.is_ok());
        assert!(settled.is_ok());
    }
    #[test]
    fn panicked_settlement_remains_unavailable_after_owned_resources_unwind() {
        let state = ClientAccessState::default();
        let ended = Finished { session: session(&state, "/synthetic/vault-a", 0), end: End { succeeded: false, at: at(), quitting: false }, data_dir: PathBuf::from("/synthetic/no-database-opened") };
        let failed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| settle_with(ended, |_| panic!("synthetic settlement I/O panic"))));
        assert!(failed.is_err());
        assert!(state.wait_opening_settlement(Some(Path::new("/synthetic/vault-b")), Duration::ZERO).is_err());
        assert!(state.wait_opening_settlement(Some(Path::new("/synthetic/vault-b")), Duration::ZERO).is_err());
    }
}

#[cfg(test)]
mod pending_settlement_tests {
    use super::*;
    #[test]
    fn failed_scheduling_pending_owner_keeps_original_scope_until_actual_kernel_finishes() {
        let state = ClientAccessState::default();
        let vault = Vault { path: PathBuf::from("/synthetic/vault-a"), id: "synthetic".into(), store: None };
        let completion = state.inner.lock().unwrap().completions.register(&vault.path).unwrap();
        let at = DateTime::parse_from_rfc3339("2026-10-26T00:00:00Z").unwrap().with_timezone(&Utc);
        let finished = Finished { session: Session { run_id: "pending-run".into(), token_id: "pending-token".into(), actor: "client:synthetic".into(), vault, claim: None, last_call: at, in_flight: 0, closing: None, completion }, end: End { succeeded: false, at, quitting: false }, data_dir: PathBuf::from("/synthetic/no-database-opened") };
        state.inner.lock().unwrap().pending.push(finished);
        let pending = state.wait_opening_settlement(Some(Path::new("/synthetic/vault-b")), Duration::ZERO);
        let finished = state.inner.lock().unwrap().pending.pop().unwrap();
        let removed_from_pending = state.wait_opening_settlement(None, Duration::ZERO);
        settle_with(finished, |_| {});
        let settled = state.wait_opening_settlement(None, Duration::ZERO);
        assert!(pending.is_err());
        assert!(removed_from_pending.is_err(), "taking a pending owner does not release its scope");
        assert!(settled.is_ok());
    }
}

#[cfg(test)]
mod completion_lock_tests {
    use super::*;
    #[test]
    fn bounded_wait_refuses_held_state_or_completion_mutex_without_blocking() {
        let state = ClientAccessState::default();
        let state_guard = state.inner.lock().unwrap();
        let blocked_state = state.wait_opening_settlement(None, Duration::ZERO);
        let book = state_guard.completions.clone();
        drop(state_guard);
        let completion_guard = book.inner.lock().unwrap();
        let blocked_completion = state.wait_opening_settlement(None, Duration::ZERO);
        drop(completion_guard);
        let settled = state.wait_opening_settlement(None, Duration::ZERO);
        assert!(blocked_state.is_err());
        assert!(blocked_completion.is_err());
        assert!(settled.is_ok());
    }
}
