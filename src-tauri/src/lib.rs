pub mod agent;
pub mod app_config;
pub mod assembly;
pub mod attention;
pub mod canvas;
pub mod client_access;
mod comment_tools;
pub mod conflict;
pub mod connectors;
pub mod convergence;
pub mod crash;
pub mod demo;
#[cfg(test)]
#[path = "../build_support/demo_resources.rs"]
mod demo_resources;
pub mod diagnostics;
pub mod dynamics;
#[cfg(test)]
mod eval;
pub mod files;
pub mod forge;
pub mod forge_commands;
pub mod git;
pub mod git_commands;
pub mod import;
pub mod ingest;
pub mod knowledge;
pub mod ledger;
mod mail;
pub mod maintain;
pub mod mcp;
pub mod monitor;
pub mod policy;
#[cfg(test)]
mod rails;
pub mod retrieval;
pub mod roots;
pub mod roots_commands;
pub mod roots_git_commands;
pub mod runtime;
pub mod search;
pub mod sheet;
pub mod shell;
pub mod spawn;
pub mod starter;
pub mod trigger;
pub mod vault;

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

use vault::entry::Entry;
use vault::receipt::WriteReceipt;
use vault::watcher::WatcherState;
use vault::write::{CollectionYaml, ViewYaml};

pub(crate) fn config_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app_config::app_dir(app)
}

fn remember_vault(app: &tauri::AppHandle, path: &str) -> Result<(), String> {
    let dir = config_dir(app)?;
    let mut config = app_config::load(&dir);
    config.last_vault = Some(path.to_string());
    app_config::save(&dir, &config)
}

// Blocking native completion waits stay off the UI thread.
#[tauri::command(async)]
fn notification_permission(app: tauri::AppHandle) -> &'static str {
    shell::notify::permission(&app.config().identifier).word()
}
#[tauri::command(async)]
fn request_notification_permission(app: tauri::AppHandle) -> &'static str {
    shell::notify::request(&app.config().identifier).word()
}
#[tauri::command(async)]
fn post_notification(
    app: tauri::AppHandle,
    id: String,
    title: String,
    body: String,
) -> &'static str {
    shell::notify::post(&app.config().identifier, &id, &title, &body)
}

#[tauri::command]
async fn pick_vault(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let Some(picked) = app.dialog().file().blocking_pick_folder() else {
        return Ok(None);
    };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    let path = path.to_string_lossy().to_string();
    remember_vault(&app, &path)?;
    Ok(Some(path))
}

// All commands below are `(async)` so their disk IO runs on the thread pool
// instead of stalling the main thread on large vaults (M1.x).
/// Copy the bundled demo vault somewhere writable and remember it, so a fresh
/// install has something to open instead of a folder picker onto an empty Mac.
#[tauri::command(async)]
fn open_demo_vault(app: tauri::AppHandle) -> Result<String, String> {
    let path = demo::ensure(&app)?;
    remember_vault(&app, &path)?;
    Ok(path)
}

#[tauri::command(async)]
fn get_last_vault(app: tauri::AppHandle) -> Result<Option<String>, String> {
    Ok(app_config::load(&config_dir(&app)?).last_vault)
}

/// The Agent record handle this vault's assistant panel is bound to, or
/// None for the plain assistant (M56.6). App config, never the vault.
#[tauri::command(async)]
fn panel_agent(app: tauri::AppHandle, vault: String) -> Result<Option<String>, String> {
    Ok(app_config::panel_agent(&config_dir(&app)?, &vault))
}

/// Bind this vault's panel to an agent handle, or unbind it with None or a
/// blank (M56.6). A value outside the slug grammar is refused unwritten.
#[tauri::command(async)]
fn set_panel_agent(
    app: tauri::AppHandle,
    vault: String,
    handle: Option<String>,
) -> Result<(), String> {
    app_config::set_panel_agent(&config_dir(&app)?, &vault, handle.as_deref())
}

#[tauri::command(async)]
fn scan_vault(vault: String) -> Result<Vec<Entry>, String> {
    // M21.1 janitor: reap atomic-write temps abandoned by a crash. Here in
    // the command rather than inside scan::scan_vault so bare library scans
    // (tests, MCP-forced rescans) stay read-only.
    vault::write::clean_orphan_temps(
        Path::new(&vault),
        &WriteReceipt::system(vault::receipt::SystemWriter::OrphanTemps),
    );
    vault::scan::scan_vault(Path::new(&vault))
}

#[tauri::command(async)]
fn read_note(vault: String, path: String) -> Result<String, String> {
    vault::write::read_note(Path::new(&vault), &path)
}

/// The exact source used to prepare a checked link rewrite (M60.10).
#[tauri::command(async)]
fn read_note_source(vault: String, path: String) -> Result<vault::write::NoteSource, String> {
    vault::write::read_note_source(Path::new(&vault), &path)
}

#[tauri::command(async)]
fn read_canvas_file(
    vault: String,
    path: String,
) -> Result<vault::write::NoteSource, vault::write::CanvasRefusal> {
    vault::write::read_canvas_source(Path::new(&vault), &path)
}
#[derive(serde::Serialize)]
struct CanvasSaved {
    hash: String,
}
#[tauri::command(async)]
fn save_canvas_file(
    vault: String,
    path: String,
    content: String,
) -> Result<CanvasSaved, vault::write::CanvasRefusal> {
    let by = WriteReceipt::ipc(
        knowledge::guard_human_write(&path)
            .map_err(|_| vault::write::CanvasRefusal::new("read_only"))?,
    );
    vault::write::save_canvas(Path::new(&vault), &path, &content, &by)
        .map(|hash| CanvasSaved { hash })
}
#[derive(serde::Deserialize)]
#[serde(rename_all = "lowercase")]
enum CanvasWriteMode {
    Preview,
    Commit,
}
#[derive(serde::Serialize)]
struct CanvasCreated {
    path: String,
    hash: Option<String>,
}
#[tauri::command(async)]
fn create_canvas_file(
    vault: String,
    path: String,
    content: String,
    mode: CanvasWriteMode,
) -> Result<CanvasCreated, vault::write::CanvasRefusal> {
    let by = WriteReceipt::ipc(
        knowledge::guard_human_write(&path)
            .map_err(|_| vault::write::CanvasRefusal::new("read_only"))?,
    );
    let mode = match mode {
        CanvasWriteMode::Preview => vault::write::WriteMode::Preview,
        CanvasWriteMode::Commit => vault::write::WriteMode::Commit,
    };
    vault::write::create_canvas(Path::new(&vault), &path, &content, mode, &by).map(|landing| {
        CanvasCreated {
            path: landing.path,
            hash: (mode == vault::write::WriteMode::Commit).then_some(landing.after),
        }
    })
}

/// ⌘K's page-text search (M59.4): `search::vault_search` over the vault's
/// cached corpus, up to `limit` hits (50 when absent). Ungated: the webview
/// can already read every note.
#[tauri::command(async)]
fn search_vault(
    vault: String,
    query: String,
    limit: Option<u32>,
) -> Result<search::VaultSearch, String> {
    let limit = limit.map_or(search::VAULT_SEARCH_MAX, |l| l as usize);
    search::vault_search(Path::new(&vault), &query, limit)
}

// The write commands below are the HUMAN path — every one of them is
// reachable from the UI, so each mints its receipt from the knowledge/
// bundle's guard (M5, M58.1): a Human receipt from `guard_human_write` or
// `guard_human_move`, save_view's included, or a ConceptDoor receipt from
// the bundle's own doors. Either stamps `human:me`. The agent's MCP tools
// have their own, narrower boundary (M17.1): they reach the bundle through
// the two server-stamped tools alone, `write_concept` and `recheck_concept`
// (M49.7). See mcp.rs.
/// The editor omits expect_hash; outside readers carry their full-file hash.
/// A projection capture returns None; an ordinary save returns its new hash.
#[tauri::command(async)]
fn save_note(
    vault: String,
    path: String,
    body: String,
    expect_hash: Option<String>,
) -> Result<Option<String>, String> {
    let expected = expect_hash
        .as_deref()
        .map(vault::write::normalize_expect_hash)
        .transpose()?;
    // M23.7: a body edit to a projection is captured, not overwritten. Its
    // expectation is compared before the valve and again under its writer.
    if let Some(cleared) = knowledge::concept_door(knowledge::HumanConcept::Capture(&path)) {
        let by = WriteReceipt::ipc(cleared);
        if let Some(result) = ledger::capture::capture_body_edit(
            Path::new(&vault),
            &path,
            &body,
            expected.as_deref(),
            &by,
        ) {
            return result.map(|()| None).map_err(save_note_refusal);
        }
    }
    let by = WriteReceipt::ipc(knowledge::guard_human_write(&path)?);
    vault::write::save_note(Path::new(&vault), &path, &body, expected.as_deref(), &by)
        .map(Some)
        .map_err(save_note_refusal)
}

fn save_note_refusal(error: vault::write::NoteWriteError) -> String {
    match error {
        vault::write::NoteWriteError::Refused(message) => message,
        vault::write::NoteWriteError::Stale(stale) => {
            let message = vault::write::stale_save_words(&stale.path);
            let typed = policy::table::PolicyTable::load().and_then(|table| {
                policy::rejection::OperationalRefusal::new(
                    &table,
                    "stale_content",
                    "save_note",
                    &message,
                )
            });
            match typed {
                Ok(typed) => runtime::sink::record(&typed, &runtime::operational::LogEntry::bare()),
                Err(error) => log::warn!("operational_log: could not type stale_content: {error}"),
            }
            message
        }
    }
}

#[tauri::command(async)]
fn update_frontmatter(
    vault: String,
    path: String,
    patch: serde_json::Map<String, serde_json::Value>,
) -> Result<Option<String>, String> {
    // The M23.7 capture valve, frontmatter half: presentation keys become
    // editorial ops, epistemic keys become assertion+revision, relation and
    // alias keys their exact paired events. Provenance stamps and alias
    // removal remain hard-refused.
    //
    // The answer is the hash of the bytes written (M55.2), which the store
    // puts on its optimistic entry. A captured write answers None: the
    // projection is the ledger's to write, and the next scan reads its hash.
    if let Some(cleared) = knowledge::concept_door(knowledge::HumanConcept::Capture(&path)) {
        let by = WriteReceipt::ipc(cleared);
        if let Some(result) =
            ledger::capture::capture_frontmatter_patch(Path::new(&vault), &path, &patch, &by)
        {
            return result.map(|()| None);
        }
    }
    let by = WriteReceipt::ipc(knowledge::guard_human_write(&path)?);
    vault::write::update_frontmatter(Path::new(&vault), &path, &patch, &by).map(Some)
}

/// The M24.9 review surface. Every read rebuilds from the ledger — nothing
/// here is cached, so a wiped app-data directory cannot lose a card.
#[tauri::command(async)]
fn review_queue(vault: String) -> Result<Vec<policy::review::ReviewCard>, String> {
    policy::review::cards(Path::new(&vault))
}

#[tauri::command(async)]
fn revertable_applications(
    vault: String,
) -> Result<Vec<policy::review::RevertableApplication>, String> {
    policy::review::undoable(Path::new(&vault))
}

/// Approve or reject one card. A rejection needs a reason; the set resolves
/// the moment its last member has a decision. The files a resolved set
/// projected are recorded as yours (M58.1), whoever the wire names.
#[tauri::command(async)]
fn decide_proposal(
    vault: String,
    proposal_id: String,
    approve: bool,
    reviewer: String,
    reason: Option<String>,
) -> Result<Option<String>, String> {
    let vault = Path::new(&vault);
    let by = review_receipt();
    ledger::shadow::with_writer(vault, |writer| {
        policy::review::decide(
            writer,
            vault,
            &proposal_id,
            approve,
            &reviewer,
            reason.as_deref(),
        )
        .map(|outcome| {
            outcome.map(|o| {
                vault::write::record_projected(vault, &o.projected, &by);
                o.transition.as_str().to_string()
            })
        })
    })
    .unwrap_or_else(|| Err("no active ledger writer for this vault".to_string()))
}

/// A Review decision's receipt (M58.1): `human:me`, from the bundle's
/// Review door, never the reviewer string the webview sends.
fn review_receipt() -> WriteReceipt<vault::receipt::ConceptDoor> {
    WriteReceipt::ipc(
        knowledge::concept_door(knowledge::HumanConcept::Review)
            .expect("the Review door is always open"),
    )
}

/// Undo an applied change by appending a NEW forward mutation. The caller
/// hands back the applied event it was shown; nothing is rewound.
#[tauri::command(async)]
fn revert_application(
    vault: String,
    proposal_id: String,
    applied_event_ids: Vec<String>,
    reviewer: String,
) -> Result<String, String> {
    let vault = Path::new(&vault);
    let by = review_receipt();
    ledger::shadow::with_writer(vault, |writer| {
        policy::review::revert(writer, vault, &proposal_id, &applied_event_ids, &reviewer).map(
            |outcome| {
                vault::write::record_projected(vault, &outcome.projected, &by);
                outcome.transition.as_str().to_string()
            },
        )
    })
    .unwrap_or_else(|| Err("no active ledger writer for this vault".to_string()))
}

/// The M25.7 control surface. One query, one shape: the pause, the meter,
/// the lanes, recent activity, and every banner in one render — six round
/// trips would let the panel show a paused pipeline beside a budget it read
/// a second earlier.
///
/// A vault whose runtime DB is unavailable returns an error the caller shows
/// rather than a fabricated empty overview: "we cannot tell you" and "there
/// is nothing to tell" are different answers.
#[tauri::command(async)]
fn pipeline_overview(
    app: tauri::AppHandle,
    vault: String,
) -> Result<runtime::surface::Overview, String> {
    let dir = config_dir(&app)?;
    let conn = runtime::open_existing(&dir)?;
    let scope = runtime::open_vault(Path::new(&vault))
        .ok_or("this vault is not registered with the runtime database")?;
    runtime::surface::overview(
        &conn,
        &scope.vault_id,
        scope.store_uuid.as_deref().unwrap_or_default(),
        chrono::Utc::now(),
    )
}

/// What starting a run hands back (M33.7).
///
/// EXTENDED, not replaced: `run` is the process-local tag every event of this
/// run carries and the id `stop_agent` takes, exactly as before. `run_id` is
/// the DURABLE id M31.2a mints before the token — the one the `runs` row, the
/// grant, the proposals and the cost components all join on.
///
/// The renderer needed both. Its localStorage log has always been keyed by
/// the process tag, which restarts at zero every launch and therefore cannot
/// address a row in a database; carrying the durable id beside it is what
/// lets a finished run in the status bar open its own fleet detail.
///
/// `session_id` (M56.3) is the Claude Code session the run goes to, minted or
/// resumed before the child spawns, so the panel stores it before the first
/// event and a conversation can be rebuilt from its session file.
#[derive(Debug, Serialize)]
pub struct RunHandle {
    pub run: u64,
    pub run_id: String,
    pub session_id: String,
}

/// One page of the fleet's run history (M33.2).
///
/// Unlike `pipeline_overview`, this takes no vault: the fleet spans them, and
/// a caller that wants one vault's runs says so in the filter. A missing
/// runtime DB is an error for the same reason it is there — the section
/// renders "unavailable", which is not the same as "no runs".
#[tauri::command(async)]
fn fleet_runs(
    app: tauri::AppHandle,
    filter: runtime::fleet::Filter,
) -> Result<Vec<runtime::fleet::FleetRun>, String> {
    let ro = runtime::ReadOnly::open(&config_dir(&app)?)?;
    runtime::fleet::runs(&ro, &filter)
}

/// Page-scoped runs, including at most two descendant hop levels.
#[tauri::command(async)]
fn fleet_subject_runs(
    app: tauri::AppHandle,
    vault: String,
    subjects: Vec<String>,
    limit: Option<u32>,
) -> Result<Vec<runtime::fleet::FleetRun>, String> {
    let ro = runtime::ReadOnly::open(&config_dir(&app)?)?;
    runtime::fleet::subject_runs(
        &ro,
        &runtime::scope::derive_vault_id(Path::new(&vault)),
        &subjects,
        limit,
    )
}

/// One run, with whatever the governance tables recorded about it (M33.2),
/// the model Claude Code reported answering, the refusals recorded against
/// it (M56.9), and what it wrote in the vault (M58.1b).
///
/// An id nothing knows is an error rather than an empty detail: a typo and a
/// run that recorded nothing must not look the same.
#[tauri::command(async)]
fn fleet_run_detail(
    app: tauri::AppHandle,
    run_id: String,
) -> Result<runtime::fleet::RunDetail, String> {
    let ro = runtime::ReadOnly::open(&config_dir(&app)?)?;
    runtime::fleet::run_detail(&ro, &run_id)
}

/// One run's transcript, folded from Claude Code's own session file (M56.9,
/// D5): folded on read and stored nowhere — no runtime.db row, no vault file.
/// The run's session, vault and siblings come from a read-only handle; a run
/// with no session or no vault reads as not recorded. An unknown id is an
/// error, as it is for `fleet_run_detail`.
#[tauri::command(async)]
fn fleet_run_transcript(
    app: tauri::AppHandle,
    run_id: String,
) -> Result<agent::transcript::RunTranscript, String> {
    let key = {
        let ro = runtime::ReadOnly::open(&config_dir(&app)?)?;
        runtime::fleet::transcript_key(&ro, &run_id)?
    };
    let last_active = chrono::DateTime::parse_from_rfc3339(&key.last_activity_at)
        .ok()
        .map(|at| at.with_timezone(&chrono::Utc));
    Ok(agent::transcript::read_run_transcript(
        key.vault_path.as_deref().map(Path::new),
        key.session_id.as_deref(),
        last_active,
        key.runs_in_session,
        chrono::Utc::now(),
    ))
}

/// Who last changed one page (M58.1b), read from runtime.db's `vault_writes`
/// through a read-only handle. The path resolves to where it lands, the
/// spelling every row is stored under; a path that lands outside the vault
/// reads as not recorded, and its bytes are never read. The file's hash is
/// taken here, from disk, never from the caller.
#[tauri::command(async)]
fn page_attribution(
    app: tauri::AppHandle,
    vault: String,
    path: String,
) -> Result<runtime::write_log::Attribution, String> {
    page_attribution_in(&config_dir(&app)?, Path::new(&vault), &path)
}

/// `page_attribution` against the runtime database in `config`.
fn page_attribution_in(
    config: &Path,
    vault: &Path,
    path: &str,
) -> Result<runtime::write_log::Attribution, String> {
    let Some(landed) = vault::write::landing_path(vault, path) else {
        return Ok(runtime::write_log::Attribution::NotRecorded);
    };
    let bytes = std::fs::read(vault.join(&landed)).map_err(|e| format!("reading {landed}: {e}"))?;
    let ro = runtime::ReadOnly::open(config)?;
    runtime::write_log::page_attribution(
        &ro,
        &runtime::scope::derive_vault_id(vault),
        &landed,
        &ledger::sha256_hex(&bytes),
    )
}

/// Which recorded runs made these commits in this vault (M58.4, CV-35), read
/// from runtime.db's `run_commits` through a read-only handle: the one
/// record History names an agent from. A commit with no row is absent from
/// the answer and reads "unattributed"; a database that will not open is an
/// error, which reads "attribution unknown", never "unattributed".
#[tauri::command(async)]
fn commit_runs(
    app: tauri::AppHandle,
    vault: String,
    commits: Vec<runtime::fleet::CommitQuery>,
) -> Result<Vec<runtime::fleet::CommitRun>, String> {
    let ro = runtime::ReadOnly::open(&config_dir(&app)?)?;
    runtime::fleet::commit_runs(
        &ro,
        &runtime::scope::derive_vault_id(Path::new(&vault)),
        &commits,
    )
}

/// What happened in one vault (M64.2): its write rows, its runs and when
/// Cerebro had it open, each lane read alone from runtime.db through a
/// read-only handle, for History to fold into sessions and days. A window
/// that is not one is refused in words; a database that will not open is an
/// error, which History renders as unavailable, never as an empty year.
#[tauri::command(async)]
fn vault_activity(
    app: tauri::AppHandle,
    vault: String,
    since: String,
    until: String,
) -> Result<runtime::activity::VaultActivity, String> {
    vault_activity_in(&config_dir(&app)?, Path::new(&vault), &since, &until)
}

/// `vault_activity` against the runtime database in `config`.
fn vault_activity_in(
    config: &Path,
    vault: &Path,
    since: &str,
    until: &str,
) -> Result<runtime::activity::VaultActivity, String> {
    let window = runtime::activity::Window::parse(since, until)?;
    let ro =
        runtime::ReadOnly::open(config).map_err(|e| format!("History could not be read: {e}"))?;
    Ok(runtime::activity::vault_activity(
        &ro,
        &runtime::scope::derive_vault_id(vault),
        &window,
    ))
}

/// The most write rows one page's History reads (M64.2b).
const PAGE_WRITE_CAP: usize = 2_000;

/// What a page's History reads (M64.2b): the names it has had (newest
/// first), the write rows under any of them or their comment sidecars, the
/// runs those rows name, when the vault's recording began, and, on a
/// knowledge page only, what the ledger recorded about the concept. Each
/// lane is read alone, so one that fails says so and the rest still speak.
#[derive(Debug, Serialize)]
pub struct PageActivity {
    pub chain: Vec<String>,
    pub writes: runtime::activity::Lane<runtime::activity::ActivityWrite>,
    pub runs: runtime::activity::Lane<runtime::activity::ActivityRun>,
    pub recording_since: runtime::activity::Since,
    /// None outside the bundle: a page there has no Knowledge lane at all.
    pub knowledge: Option<KnowledgeLane>,
}

/// A concept's ledger lane: what it recorded, a vault that keeps no ledger
/// (not recorded, never "nothing happened"), or a read that failed.
#[derive(Debug, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum KnowledgeLane {
    Read {
        events: Vec<knowledge::ConceptEvent>,
    },
    NotRecorded,
    Unavailable {
        reason: String,
    },
}

/// What a page outside the vault is refused with (M64.2b).
fn page_outside_vault(path: &str) -> String {
    format!("{path} is outside this vault, so it has no history here.")
}

/// One page's History (M64.2b), merged in the tab with its versions. The
/// path resolves to where it lands, the spelling every row is stored under,
/// as `page_attribution` resolves it; a path outside the vault is refused in
/// words. runtime.db is read through a read-only handle; the ledger lane
/// through the fold and the index, which it never creates or repairs.
#[tauri::command(async)]
fn page_activity(
    app: tauri::AppHandle,
    vault: String,
    path: String,
) -> Result<PageActivity, String> {
    page_activity_in(
        &config_dir(&app)?,
        Path::new(&vault),
        &path,
        chrono::Utc::now(),
    )
}

/// `page_activity` against the runtime database and ledger index in `config`.
fn page_activity_in(
    config: &Path,
    vault: &Path,
    path: &str,
    now: chrono::DateTime<chrono::Utc>,
) -> Result<PageActivity, String> {
    use runtime::activity::{Lane, Since};
    let Some(landed) = vault::write::landing_path(vault, path) else {
        return Err(page_outside_vault(path));
    };
    let vault_id = runtime::scope::derive_vault_id(vault);
    let window = runtime::activity::Window::through(now);
    fn unavailable<T>(reason: &str) -> runtime::activity::Lane<T> {
        runtime::activity::Lane::Unavailable {
            reason: reason.to_string(),
        }
    }
    let mut chain = vec![landed.clone()];
    let (writes, runs, recording_since) = match runtime::ReadOnly::open(config) {
        Err(e) => {
            let reason = format!("History could not be read: {e}");
            (
                unavailable(&reason),
                unavailable(&reason),
                Since::Unavailable { reason },
            )
        }
        Ok(ro) => {
            let rows = runtime::write_log::rename_chain(
                &ro,
                &vault_id,
                &landed,
                runtime::write_log::RENAME_HOPS,
            )
            .and_then(|names| {
                chain = names;
                let mut paths = chain.clone();
                paths.extend(chain.iter().map(|name| vault::comments::sidecar_rel(name)));
                runtime::activity::write_rows(&ro, &vault_id, &window, Some(&paths), PAGE_WRITE_CAP)
            });
            let runs = match &rows {
                Err(_) => {
                    unavailable("the page's edits could not be read, so its runs are unknown")
                }
                Ok(page) => {
                    let mut ids: Vec<String> = Vec::new();
                    for id in page.rows.iter().filter_map(|w| w.run_id.as_ref()) {
                        if !ids.contains(id) {
                            ids.push(id.clone());
                        }
                    }
                    if ids.is_empty() {
                        Lane::Read {
                            rows: Vec::new(),
                            more: false,
                        }
                    } else {
                        runtime::activity::run_rows(
                            &ro,
                            &vault_id,
                            &window,
                            Some(&ids),
                            runtime::activity::RUN_CAP,
                        )
                        .into()
                    }
                }
            };
            let since = match runtime::activity::recording_since(&ro, &vault_id) {
                Ok(at) => Since::Read { at },
                Err(reason) => Since::Unavailable { reason },
            };
            (rows.into(), runs, since)
        }
    };
    let knowledge =
        knowledge::is_knowledge_path(&landed).then(|| concept_lane(config, vault, &landed));
    Ok(PageActivity {
        chain,
        writes,
        runs,
        recording_since,
        knowledge,
    })
}

/// What the ledger recorded about the concept at `landed` (M64.2b): no store
/// is not recorded; the fold names the events, and the index (read only,
/// when it exists) dates them and names who made each. With no index the
/// times read not recorded; any failed read makes the lane unavailable.
fn concept_lane(config: &Path, vault: &Path, landed: &str) -> KnowledgeLane {
    if !ledger::has_store(vault) {
        return KnowledgeLane::NotRecorded;
    }
    let read = || -> Result<Vec<knowledge::ConceptEvent>, String> {
        let krel = landed
            .strip_prefix(knowledge::KNOWLEDGE_DIR)
            .and_then(|rest| rest.strip_prefix('/'))
            .unwrap_or(landed);
        let folded = ledger::shadow::state_of(vault)?;
        let mut events = knowledge::concept_history(&folded.state, krel);
        let Some(store) = ledger::store::load(&ledger::ledger_dir(vault))? else {
            return Ok(events);
        };
        let Some(index) = ledger::index::Index::open_read_only(config, &store.store_id)? else {
            return Ok(events);
        };
        let ids: Vec<String> = events.iter().map(|e| e.event_id.clone()).collect();
        let facts = index.event_rows(&ids)?;
        for event in &mut events {
            if let Some(fact) = facts.get(&event.event_id) {
                event.at.get_or_insert_with(|| fact.ingested_at.clone());
                if event.actor.is_none() {
                    event.actor = fact.actor.clone();
                }
            }
        }
        Ok(events)
    };
    match read() {
        Ok(events) => KnowledgeLane::Read { events },
        Err(reason) => KnowledgeLane::Unavailable { reason },
    }
}

/// What one run changed in Knowledge (M50.3): the concepts its proposals
/// named and what became of each, joined from the ledger by `run_id`.
/// `None` when the vault keeps no ledger — not recorded, never "changed
/// nothing".
#[tauri::command(async)]
fn run_knowledge_writes(
    vault: String,
    run_id: String,
) -> Result<Option<Vec<knowledge::RunWrite>>, String> {
    let vault = Path::new(&vault);
    if !ledger::has_store(vault) {
        return Ok(None);
    }
    let folded = ledger::shadow::state_of(vault)?;
    Ok(Some(knowledge::run_writes(&folded.state, &run_id)))
}

/// What one actor's runs add up to (M33.6).
///
/// An actor with no runs is not an error — a freshly written Agent record has
/// none — so this answers with a zeroed summary and an absent last outcome
/// rather than refusing. "No runs yet" is a thing its dossier has to say.
#[tauri::command(async)]
fn fleet_actor_summary(
    app: tauri::AppHandle,
    actor: String,
) -> Result<runtime::fleet::ActorSummary, String> {
    let ro = runtime::ReadOnly::open(&config_dir(&app)?)?;
    runtime::fleet::actor_summary(&ro, &actor)
}

/// Every actor the run table has attributed anything to, summed (M33b.3).
///
/// The fleet surface lists AGENTS — records in a vault — and joins this to
/// them. An empty array is measured-at-zero: nothing attributed has ever run.
/// A missing runtime database REFUSES, and the roster renders that as
/// unavailable rather than as an empty team.
#[tauri::command(async)]
fn fleet_actor_summaries(
    app: tauri::AppHandle,
) -> Result<Vec<runtime::fleet::ActorSummary>, String> {
    let ro = runtime::ReadOnly::open(&config_dir(&app)?)?;
    runtime::fleet::actor_summaries(&ro)
}

/// The three job ledgers, hydrated per vault (M34.2.2).
#[derive(serde::Serialize, Default)]
struct JobLedgers {
    attempts: std::collections::HashMap<String, String>,
    #[serde(rename = "skillRuns")]
    skill_runs: std::collections::HashMap<String, String>,
    #[serde(rename = "triggerRuns")]
    trigger_runs: std::collections::HashMap<String, String>,
}

/// One localStorage-era entry offered for import (M34.2.3).
#[derive(serde::Deserialize)]
struct LedgerImportEntry {
    ledger: String,
    key: String,
    #[serde(rename = "runKey")]
    run_key: String,
}

fn job_ledger_scope(
    app: &tauri::AppHandle,
    vault: &str,
) -> Result<(rusqlite::Connection, String), String> {
    let conn = runtime::open_existing(&config_dir(app)?)?;
    let vault_id = runtime::scope::register(&conn, Path::new(vault))?;
    Ok((conn, vault_id))
}

/// Dismissals are operational local state, never a vault write or a receipt.
#[tauri::command(async)]
fn mail_dismissals_read(
    app: tauri::AppHandle,
    vault: String,
) -> Result<Vec<runtime::mail_dismissals::MailDismissal>, String> {
    let (conn, id) = job_ledger_scope(&app, &vault)?;
    runtime::mail_dismissals::read(&conn, &id)
}
#[tauri::command(async)]
fn mail_dismiss(
    app: tauri::AppHandle,
    vault: String,
    kind: String,
    value: String,
) -> Result<(), String> {
    runtime::mail_dismissals::normalize(&kind, &value)?;
    let (conn, id) = job_ledger_scope(&app, &vault)?;
    runtime::mail_dismissals::dismiss(&conn, &id, &kind, &value)
}
#[tauri::command(async)]
fn mail_undismiss(
    app: tauri::AppHandle,
    vault: String,
    kind: String,
    value: String,
) -> Result<(), String> {
    runtime::mail_dismissals::normalize(&kind, &value)?;
    let (conn, id) = job_ledger_scope(&app, &vault)?;
    runtime::mail_dismissals::restore(&conn, &id, &kind, &value)
}

/// Everything the ledgers remember about one vault. REFUSES without a
/// runtime database: an empty ledger means "nothing ever ran", which would
/// re-fire every schedule — the runner treats this error as "do not run".
#[tauri::command(async)]
fn job_ledger_read(app: tauri::AppHandle, vault: String) -> Result<JobLedgers, String> {
    let (conn, vault_id) = job_ledger_scope(&app, &vault)?;
    let mut out = JobLedgers::default();
    for (ledger, key, run_key) in runtime::job_ledger::read_all(&conn, &vault_id)? {
        match ledger.as_str() {
            "attempts" => out.attempts.insert(key, run_key),
            "skillRuns" => out.skill_runs.insert(key, run_key),
            _ => out.trigger_runs.insert(key, run_key),
        };
    }
    Ok(out)
}

/// Reminder reads refuse without the runtime database, never invent empty history.
#[derive(serde::Serialize)]
struct ReminderState {
    fires: Vec<runtime::reminders::Fire>,
    window: Option<runtime::sessions::SessionWindow>,
}
#[tauri::command(async)]
fn reminder_state(app: tauri::AppHandle, vault: String) -> Result<ReminderState, String> {
    let (conn, id) = job_ledger_scope(&app, &vault)?;
    Ok(ReminderState {
        fires: runtime::reminders::read_all(&conn, &id)?,
        window: runtime::sessions::window_for(&id),
    })
}
#[tauri::command(async)]
fn reminder_claim(
    app: tauri::AppHandle,
    vault: String,
    fires: Vec<serde_json::Value>,
) -> Result<Vec<runtime::reminders::ReminderClaim>, String> {
    let (conn, id) = job_ledger_scope(&app, &vault)?;
    runtime::reminders::claim(
        &conn,
        &id,
        &fires,
        &chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true),
    )
}
#[tauri::command(async)]
fn reminder_import(
    app: tauri::AppHandle,
    vault: String,
    fires: Vec<serde_json::Value>,
) -> Result<usize, String> {
    let (conn, id) = job_ledger_scope(&app, &vault)?;
    runtime::reminders::import(
        &conn,
        &id,
        &fires,
        &chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true),
    )
}
#[tauri::command(async)]
fn done_marks_read(
    app: tauri::AppHandle,
    vault: String,
) -> Result<Vec<runtime::done_marks::Mark>, String> {
    let (conn, id) = job_ledger_scope(&app, &vault)?;
    runtime::done_marks::read_all(&conn, &id)
}
#[tauri::command(async)]
fn done_mark(
    app: tauri::AppHandle,
    vault: String,
    mark: serde_json::Value,
) -> Result<runtime::done_marks::MarkResult, String> {
    let (conn, id) = job_ledger_scope(&app, &vault)?;
    runtime::done_marks::mark(
        &conn,
        &id,
        &mark,
        &chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true),
    )
}
#[tauri::command(async)]
fn done_unmark(
    app: tauri::AppHandle,
    vault: String,
    mark: serde_json::Value,
    restore: Option<serde_json::Value>,
) -> Result<bool, String> {
    let (conn, id) = job_ledger_scope(&app, &vault)?;
    runtime::done_marks::unmark(&conn, &id, &mark, restore.as_ref())
}
#[tauri::command(async)]
fn done_marks_import(
    app: tauri::AppHandle,
    vault: String,
    marks: Vec<serde_json::Value>,
) -> Result<usize, String> {
    let (conn, id) = job_ledger_scope(&app, &vault)?;
    runtime::done_marks::import(
        &conn,
        &id,
        &marks,
        &chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true),
    )
}

/// Record a run key, answering whether the record was FRESH — false means
/// another window or an earlier session already answered this exact fire,
/// and the caller must not spawn.
#[tauri::command(async)]
fn job_ledger_claim(
    app: tauri::AppHandle,
    vault: String,
    ledger: String,
    key: String,
    run_key: String,
) -> Result<bool, String> {
    let (conn, vault_id) = job_ledger_scope(&app, &vault)?;
    runtime::job_ledger::claim(&conn, &vault_id, &ledger, &key, &run_key)
}

/// Surrender a claim the caller holds — the deferred runner's revert, so a
/// gate refusal never eats the fire it refused. Conditional on the exact
/// run_key, so a claim another window re-won is never destroyed.
#[tauri::command(async)]
fn job_ledger_unclaim(
    app: tauri::AppHandle,
    vault: String,
    ledger: String,
    key: String,
    run_key: String,
) -> Result<bool, String> {
    let (conn, vault_id) = job_ledger_scope(&app, &vault)?;
    runtime::job_ledger::unclaim(&conn, &vault_id, &ledger, &key, &run_key)
}

/// Overwrite a cooldown stamp. No verdict — a clock is not a claim.
#[tauri::command(async)]
fn job_ledger_stamp(
    app: tauri::AppHandle,
    vault: String,
    ledger: String,
    key: String,
    run_key: String,
) -> Result<(), String> {
    let (conn, vault_id) = job_ledger_scope(&app, &vault)?;
    runtime::job_ledger::stamp(&conn, &vault_id, &ledger, &key, &run_key)
}

/// One-time import from the localStorage era. Keys the database already
/// holds are kept — it has been the arbiter since it existed.
#[tauri::command(async)]
fn job_ledger_import(
    app: tauri::AppHandle,
    vault: String,
    entries: Vec<LedgerImportEntry>,
) -> Result<usize, String> {
    let (conn, vault_id) = job_ledger_scope(&app, &vault)?;
    let rows: Vec<(String, String, String)> = entries
        .into_iter()
        .map(|e| (e.ledger, e.key, e.run_key))
        .collect();
    runtime::job_ledger::import(&conn, &vault_id, &rows)
}

/// The subscription-wide pause. Persisted, so it survives a restart — a
/// pause that forgot itself overnight would be the least trustworthy control
/// in the app.
#[tauri::command(async)]
fn set_global_pause(app: tauri::AppHandle, paused: bool) -> Result<(), String> {
    let conn = runtime::open_existing(&config_dir(&app)?)?;
    runtime::settings::set_global_pause(&conn, paused)
}

/// Stop or restart ONE agent, without deleting its record (M33b.5).
///
/// Vault-scoped, unlike the global pause: an agent is a record, and two vaults
/// may each hold one whose slug is the same word.
///
/// **This THROWS rather than no-opping** when there is no runtime database or
/// the vault is unregistered. A pause that silently failed to store would be
/// the worst possible outcome for this control — the button would look pressed
/// and the agent would keep running.
#[tauri::command(async)]
fn set_agent_paused(
    app: tauri::AppHandle,
    vault: String,
    actor: String,
    paused: bool,
) -> Result<(), String> {
    let conn = runtime::open_existing(&config_dir(&app)?)?;
    let vault_id = runtime::scope::register(&conn, Path::new(&vault))?;
    // M63.1: pausing cancels the agent's pending wakes in the same
    // transaction, so none is left to run when it resumes.
    runtime::wakes::pause_agent(&conn, &vault_id, &actor, paused, chrono::Utc::now())
}

/// Which agents are paused in this vault (M33b.5).
///
/// An EMPTY array is measured-at-zero — the rows were read and nobody is
/// paused. A missing runtime database REFUSES, and the roster renders that as
/// unavailable rather than as a fleet that is definitely running.
#[tauri::command(async)]
fn paused_agents(app: tauri::AppHandle, vault: String) -> Result<Vec<String>, String> {
    let conn = runtime::open_existing(&config_dir(&app)?)?;
    let vault_id = runtime::scope::register(&conn, Path::new(&vault))?;
    runtime::settings::paused_agents(&conn, &vault_id)
}

/// Admit the trigger matches the renderer saw in this vault (M63.1), each
/// once: a live key is counted, never admitted twice, and a malformed offer
/// or an agent paused on the fleet is refused by name. REFUSES without a
/// runtime database, and the renderer keeps the batch to offer again.
#[tauri::command(async)]
fn admit_wakes(
    app: tauri::AppHandle,
    vault: String,
    wakes: Vec<runtime::wakes::WakeOffer>,
    seen_at: Option<String>,
) -> Result<runtime::wakes::AdmitReport, String> {
    let (conn, vault_id) = job_ledger_scope(&app, &vault)?;
    let now = chrono::Utc::now();
    // A renderer clock outside the wake's own retention window cannot prove
    // a write happened after its scan. Exact hashes still prove that writer.
    let seen_at = seen_at
        .as_deref()
        .and_then(|raw| chrono::DateTime::parse_from_rfc3339(raw).ok())
        .map(|at| at.with_timezone(&chrono::Utc))
        .filter(|at| {
            *at <= now + chrono::Duration::minutes(1)
                && *at >= now - chrono::Duration::days(runtime::wakes::WAKE_TTL_DAYS)
        });
    let ro = runtime::ReadOnly::open(&config_dir(&app)?)?;
    let writers = wakes
        .iter()
        .map(|offer| {
            runtime::write_log::writer_of(
                &ro,
                &vault_id,
                &offer.path,
                &offer.hash,
                &offer.event,
                seen_at,
            )
        })
        .collect::<Result<Vec<_>, _>>()?;
    runtime::wakes::admit_with_writers(&conn, &vault_id, &wakes, &writers, now)
}

/// A removed Agent relation releases pending work, never an already running job.
#[tauri::command(async)]
fn release_assigned_wakes(
    app: tauri::AppHandle,
    vault: String,
    agent_key: String,
    subject: String,
    key_prefix: String,
) -> Result<usize, String> {
    let (conn, vault_id) = job_ledger_scope(&app, &vault)?;
    runtime::wakes::release_assignment(
        &conn,
        &vault_id,
        &agent_key,
        &subject,
        &key_prefix,
        chrono::Utc::now(),
    )
}

/// The wakes waiting in this vault, oldest first (M63.1), read through a
/// read-only handle. A failed read is an error, which the runner treats as
/// "derive no wake job and cancel nothing", never as nothing waiting.
#[tauri::command(async)]
fn wakes_pending(
    app: tauri::AppHandle,
    vault: String,
) -> Result<Vec<runtime::wakes::PendingWake>, String> {
    let ro = runtime::ReadOnly::open(&config_dir(&app)?)?;
    runtime::wakes::pending(
        &ro,
        &runtime::scope::derive_vault_id(Path::new(&vault)),
        chrono::Utc::now(),
    )
}

/// Cancel pending wakes the vault no longer backs (M63.1), each with its
/// why. An unknown why refuses the whole call before anything is written.
#[tauri::command(async)]
fn cancel_wakes(
    app: tauri::AppHandle,
    vault: String,
    cancels: Vec<runtime::wakes::WakeCancel>,
) -> Result<usize, String> {
    let (conn, vault_id) = job_ledger_scope(&app, &vault)?;
    runtime::wakes::cancel(&conn, &vault_id, &cancels, chrono::Utc::now())
}

/// What is waiting to wake this vault's agents, and what was skipped or
/// expired this week (M63.1b), optionally for one agent. Read through a
/// read-only handle under the derived vault id, never `register`: a read
/// writes nothing. A failed read is an error, which the list renders as
/// unavailable, never as nothing waiting.
#[tauri::command(async)]
fn fleet_wakes(
    app: tauri::AppHandle,
    vault: String,
    actor: Option<String>,
) -> Result<Vec<runtime::fleet::FleetWake>, String> {
    let ro = runtime::ReadOnly::open(&config_dir(&app)?)?;
    runtime::fleet::wakes(
        &ro,
        &runtime::scope::derive_vault_id(Path::new(&vault)),
        actor.as_deref(),
        chrono::Utc::now(),
    )
}

#[tauri::command(async)]
fn list_followups(
    app: tauri::AppHandle,
    vault: String,
) -> Result<Vec<runtime::followups::Followup>, String> {
    let ro = runtime::ReadOnly::open(&config_dir(&app)?)?;
    runtime::followups::list(
        &ro,
        &runtime::scope::derive_vault_id(Path::new(&vault)),
        chrono::Utc::now(),
    )
}

#[tauri::command(async)]
fn claim_followup(
    app: tauri::AppHandle,
    vault: String,
    id: String,
) -> Result<runtime::followups::FollowupClaim, String> {
    let (conn, vault_id) = job_ledger_scope(&app, &vault)?;
    let Some(row) = runtime::followups::get(&conn, &vault_id, &id)? else {
        return Ok(runtime::followups::FollowupClaim::NotWaiting);
    };
    let entries = vault::scan::scan_vault(Path::new(&vault))?;
    let standing = match mcp::own_agent_record(&entries, &row.actor) {
        None => runtime::followups::Standing::Gone,
        Some(record)
            if record
                .properties
                .get("paused")
                .and_then(serde_json::Value::as_bool)
                == Some(true)
                || runtime::settings::agent_paused(&conn, &vault_id, &row.actor)? =>
        {
            runtime::followups::Standing::Paused
        }
        Some(_) => runtime::followups::Standing::Active,
    };
    runtime::followups::claim(&conn, &vault_id, &id, standing, chrono::Utc::now())
}

#[tauri::command(async)]
fn cancel_followup(app: tauri::AppHandle, vault: String, id: String) -> Result<bool, String> {
    let (conn, vault_id) = job_ledger_scope(&app, &vault)?;
    runtime::followups::cancel(&conn, &vault_id, &id, chrono::Utc::now())
}

/// How many background runs may be live at once (M33b.2). Subscription-wide
/// and persisted, like the pause.
///
/// **This one THROWS, and must.** A ceiling below 1 or above the process cap
/// is refused by name so the person who typed it learns which end they hit —
/// clamping silently would leave the number on screen disagreeing with the
/// number in force.
#[tauri::command(async)]
fn set_ambient_concurrency(app: tauri::AppHandle, ceiling: usize) -> Result<(), String> {
    let conn = runtime::open_existing(&config_dir(&app)?)?;
    runtime::settings::set_ambient_concurrency(&conn, ceiling)
}

/// Where the ingest scheduler currently holds one item (M26.4j).
///
/// The one query the knowledge panel needs after the distillation lanes were
/// retired: "is the base going to read this note?" used to be answered by
/// re-deriving a renderer-side queue, which meant the answer existed only for
/// work the UI itself had remembered to record. It is now the durable
/// scheduler row, so a note edited in an external editor answers the same
/// way as one organized in the app.
///
/// `None` means the scheduler has never seen this item — a vault that has
/// not been scanned, or ambient ingest that has never been turned on. That is
/// a real answer and is rendered as "not queued", never as an error.
#[tauri::command(async)]
fn ingest_item_state(
    app: tauri::AppHandle,
    vault: String,
    path: String,
) -> Result<Option<runtime::surface::ItemState>, String> {
    let conn = runtime::open_existing(&config_dir(&app)?)?;
    let scope = runtime::open_vault(Path::new(&vault))
        .ok_or("this vault is not registered with the runtime database")?;
    runtime::surface::item_state(
        &conn,
        &scope.vault_id,
        scope.store_uuid.as_deref().unwrap_or_default(),
        &path,
    )
}

/// Ask the base a question, attended (M26.5e).
///
/// Assemble what the five intents can find, show it to one run, and hand back
/// what it answered — or a typed refusal. The refusal is a RESULT, not an
/// error: `cap_conflict` means accessible counterevidence would not fit and
/// nothing was synthesized, which is a card the person who asked has to see
/// rather than a toast to dismiss.
///
/// Attended, therefore bounded and never budgeted: the caps bound this one
/// request, and no daily-run ceiling, token gate, or ambient spend can refuse
/// a question somebody is waiting on.
#[tauri::command(async)]
fn ask_question(
    app: tauri::AppHandle,
    vault: String,
    question: String,
    aliases: Vec<String>,
    intended_use: assembly::manifest::QueryIntendedUse,
) -> Result<assembly::Asked, String> {
    let vault_path = Path::new(&vault);
    let config = config_dir(&app)?;
    let conn = runtime::open_existing(&config)?;
    let scope = runtime::open_vault(vault_path)
        .ok_or("this vault is not registered with the runtime database")?;
    let store_uuid = scope
        .store_uuid
        .clone()
        .ok_or("this vault has no ledger store — there is nothing to ask")?;

    // One read: the projection to select from, the corpus to render from, and
    // the head both were taken at.
    let (state, corpus, chain_head) = assembly::ask::read(vault_path, &store_uuid)?;
    let request = assembly::assemble::Request {
        store_uuid: &store_uuid,
        chain_head: &chain_head,
        question: &question,
        aliases: &aliases,
        scope: ledger::schema::Scope::empty(),
        intended_use,
        limits: assembly::manifest::Limits::ATTENDED,
    };
    let agents = app.state::<agent::AgentState>();
    let mcp_state = app.state::<mcp::McpState>();
    let live = assembly::live::Live {
        app: &app,
        agents: agents.inner(),
        mcp: mcp_state.inner(),
        vault: vault_path,
        config_dir: config.clone(),
        data_dir: config,
        vault_id: scope.vault_id.clone(),
        store_uuid: store_uuid.clone(),
        run_id: ledger::new_run_id(),
    };
    let context = assembly::ask::Context {
        vault: vault_path,
        vault_id: &scope.vault_id,
        store_uuid: &store_uuid,
    };
    Ok(
        match assembly::ask::ask(
            &conn,
            &context,
            &state,
            &corpus,
            &request,
            &live,
            chrono::Utc::now(),
        ) {
            Ok(outcome) => outcome.into(),
            Err(refusal) => refusal.into(),
        },
    )
}

/// Finished unattended work for this vault. A read never registers a vault.
#[tauri::command(async)]
fn home_runs(
    app: tauri::AppHandle,
    vault: String,
    limit: Option<u32>,
) -> Result<runtime::fleet::EndedRuns, String> {
    let ro = runtime::ReadOnly::open(&config_dir(&app)?)?;
    runtime::fleet::ended_runs(
        &ro,
        &runtime::scope::derive_vault_id(Path::new(&vault)),
        limit,
    )
}
/// The person's Knowledge change window. No ledger is not recorded; a torn
/// ledger is unavailable, never an empty window.
#[tauri::command(async)]
fn home_changes(
    app: tauri::AppHandle,
    vault: String,
    after_seq: Option<u64>,
) -> Result<Option<attention::status::ChangesView>, String> {
    let vault = Path::new(&vault);
    let directory = ledger::ledger_dir(vault);
    let Some(store) = ledger::store::load(&directory)? else {
        return Ok(None);
    };
    let conn = runtime::open_existing(&config_dir(&app)?)?;
    let vault_id = runtime::scope::derive_vault_id(vault);
    let read = ledger::read_ledger(&directory).map_err(|e| e.to_string())?;
    let latest = convergence::store::latest(&conn, &vault_id, &store.store_id)?;
    let window = convergence::home_window(
        after_seq,
        latest.map(|run| run.from_seq),
        read.head_seq.unwrap_or(0),
    );
    let (output, now) = convergence::over_with_now(&read.frames, &store.store_id, window)?;
    let mut view =
        attention::status::change_sections(&output, &attention::status::Subjects::of(&now));
    view.changed_at = convergence::changed_at(&read.frames, window);
    Ok(Some(view))
}

/// "How did our model change?", on demand (M26.8c).
///
/// **Attended means returned, not narrated.** The design's word is that
/// on-demand convergence is "returned as an attended answer" while scheduled
/// convergence is ambient and stored — the contrast is who gets the result,
/// not whether a model wrote it. So this hands back the computed diff
/// directly. Spending tokens to have a model re-say a deterministic
/// difference would be paying for prose about arithmetic, and the day-one
/// sections are all M26-computable by construction.
///
/// An omitted `from_seq` starts after the last stored convergence run.
/// Home uses its own Done mark through `home_changes`.
#[tauri::command(async)]
fn converge(
    app: tauri::AppHandle,
    vault: String,
    from_seq: Option<u64>,
) -> Result<attention::status::ChangesView, String> {
    let vault_path = Path::new(&vault);
    let conn = runtime::open_existing(&config_dir(&app)?)?;
    let scope = runtime::open_vault(vault_path)
        .ok_or("this vault is not registered with the runtime database")?;
    let store_uuid = scope
        .store_uuid
        .clone()
        .ok_or("this vault has no ledger store — there is nothing to compare")?;

    let read = ledger::read_ledger(&ledger::ledger_dir(vault_path)).map_err(|e| e.to_string())?;
    let head_seq = read.frames.last().map(|frame| frame.seq).unwrap_or(0);
    let from_seq = match from_seq {
        Some(explicit) => explicit,
        None => convergence::store::latest(&conn, &scope.vault_id, &store_uuid)?
            .map(|run| run.to_seq)
            .unwrap_or(0),
    };
    // A window with nothing in it is a real answer — "nothing has changed
    // in this window" — so it is computed rather than refused.
    let window = convergence::diff::Window {
        from_seq: from_seq.min(head_seq),
        to_seq: head_seq,
    };
    // Read aloud on the way out (M27.8a). The stored row keeps the structured
    // `Output` — its bytes are content-hashed and a prose field would change
    // every one already on disk — so the sentences, and the file each line's
    // subject projects to (M52.4), are composed per call, in the module that
    // owns the surface's whole vocabulary.
    let (output, now) = convergence::over_with_now(&read.frames, &store_uuid, window)?;
    Ok(attention::status::change_sections(
        &output,
        &attention::status::Subjects::of(&now),
    ))
}

/// The three axes, per belief facet (M27.5b).
///
/// The clock is read HERE and passed down, because the derivation must not
/// read one: freshness is a function of `as_of`, and a module that fetched
/// its own would answer differently about a ledger that had not moved.
#[tauri::command(async)]
fn belief_chips(vault: String) -> Result<Vec<dynamics::bundle::BeliefChips>, String> {
    dynamics::bundle::for_vault(Path::new(&vault), chrono::Utc::now())
}

/// The four attention lanes, for the Epistemic Status surface (M27.8a).
///
/// The parked-promotion feed is OPERATIONAL and its absence is not a reason to
/// refuse: a contradiction is worth showing to somebody whose app-data is
/// unavailable. But it is also not nothing — a debt lane silently missing every
/// parked item reads as a base that owes nothing — so `None` travels as far as
/// the view, which names it in `incomplete`.
///
/// Preferences are the defaults until they are persisted. That is one line to
/// change here and nowhere else, which is why every surface goes through this.
#[tauri::command(async)]
fn attention_lanes(
    app: tauri::AppHandle,
    vault: String,
) -> Result<attention::status::LanesView, String> {
    let vault_path = Path::new(&vault);
    let parked = parked_promotions(&app, vault_path);
    attention::status::for_vault(
        vault_path,
        parked.as_deref(),
        &attention::preferences::Preferences::default(),
        chrono::Utc::now(),
    )
}

/// Open parked promotions, or `None` when this process could not ask.
fn parked_promotions(
    app: &tauri::AppHandle,
    vault: &Path,
) -> Option<Vec<attention::lanes::ParkedPromotion>> {
    let conn = runtime::open_existing(&config_dir(app).ok()?).ok()?;
    let store_uuid = runtime::open_vault(vault)?.store_uuid?;
    let rows = runtime::parked::open_rows(&conn, &store_uuid).ok()?;
    Some(
        rows.into_iter()
            .map(|row| attention::lanes::ParkedPromotion {
                belief_id: row.belief_id,
                missing_roles: row.missing_roles,
            })
            .collect(),
    )
}

/// The ambient ingest switch, per vault (M26.4i). Defaults OFF.
///
/// The supervisor thread starts with the vault and reads this every tick, so
/// turning it on takes effect at the next tick rather than at the next
/// launch, and turning it off stops the spending without stopping the app.
#[tauri::command(async)]
fn ambient_ingest_enabled(app: tauri::AppHandle, vault: String) -> Result<bool, String> {
    let conn = runtime::open_existing(&config_dir(&app)?)?;
    let vault_id = runtime::scope::register(&conn, Path::new(&vault))?;
    Ok(ingest::ambient::enabled(&conn, &vault_id))
}

#[tauri::command(async)]
fn set_ambient_ingest(app: tauri::AppHandle, vault: String, enabled: bool) -> Result<(), String> {
    let conn = runtime::open_existing(&config_dir(&app)?)?;
    let vault_id = runtime::scope::register(&conn, Path::new(&vault))?;
    ingest::ambient::set_enabled(&conn, &vault_id, enabled)
}

/// One lane, for one vault. Lanes are per-vault by design: a person may want
/// scheduled agents in their work vault and nothing at all in their journal.
#[tauri::command(async)]
fn set_lane_enabled(
    app: tauri::AppHandle,
    vault: String,
    lane: String,
    enabled: bool,
) -> Result<(), String> {
    let conn = runtime::open_existing(&config_dir(&app)?)?;
    let scope = runtime::open_vault(Path::new(&vault))
        .ok_or("this vault is not registered with the runtime database")?;
    runtime::settings::set_lane_enabled(&conn, &scope.vault_id, &lane, enabled)
}

// --- The deferral gates (M28.1) ---------------------------------------------
//
// The trigger registry's caller surface: a status board, a run-on-demand,
// and the R7 scope declaration. No daemon — every measurable gate is a pure
// function of persisted history, so it is evaluated when somebody looks.
// The wall clock is read HERE, at the shell, and handed down: the trigger
// module's own source scans forbid it a clock of its own.

/// The vault-store scope the R3–R14 gates evaluate under.
fn trigger_vault_scope(vault: &str) -> Result<trigger::evaluate::VaultScope, String> {
    let scope = runtime::open_vault(Path::new(vault))
        .ok_or("this vault is not registered with the runtime database")?;
    let store_uuid = scope.store_uuid.ok_or(
        "this vault has no ledger store yet — the vault-scoped gates have nothing to measure",
    )?;
    Ok(trigger::evaluate::VaultScope {
        vault_id: scope.vault_id,
        store_uuid,
    })
}

/// The board: every gate the artifact declares, with its newest recorded
/// evaluation or an explicit never-evaluated.
#[tauri::command(async)]
fn trigger_status(
    app: tauri::AppHandle,
    vault: String,
) -> Result<Vec<trigger::runner::EntryStatus>, String> {
    let conn = runtime::open_existing(&config_dir(&app)?)?;
    let scope = trigger_vault_scope(&vault)?;
    let registry = trigger::registry::load()?;
    trigger::runner::status(&conn, &registry, &scope)
}

/// Declare what R7 should count for this vault. Returns the canonical
/// digest recorded evaluations will carry.
#[tauri::command(async)]
fn trigger_declare_r7_scope(
    app: tauri::AppHandle,
    vault: String,
    scope_json: String,
) -> Result<String, String> {
    let conn = runtime::open_existing(&config_dir(&app)?)?;
    let scope = trigger_vault_scope(&vault)?;
    runtime::settings::declare_r7_scope(&conn, &scope.vault_id, &scope_json)
}

/// The declared R7 scope, if any — None is "nothing declared", an error is
/// "cannot tell", and the two are never conflated.
#[tauri::command(async)]
fn trigger_r7_scope(
    app: tauri::AppHandle,
    vault: String,
) -> Result<Option<trigger::observations::VerificationScope>, String> {
    let conn = runtime::open_existing(&config_dir(&app)?)?;
    let scope = trigger_vault_scope(&vault)?;
    runtime::settings::r7_scope(&conn, &scope.vault_id)
}

/// One pass over every gate with a measurable leg. Rerunning inside one
/// local day replays byte-identically, so this is safe to call whenever the
/// surface opens.
#[tauri::command(async)]
fn trigger_run(app: tauri::AppHandle, vault: String) -> Result<trigger::runner::RunReport, String> {
    let conn = runtime::open_existing(&config_dir(&app)?)?;
    let scope = trigger_vault_scope(&vault)?;
    let registry = trigger::registry::load()?;
    let now = chrono::Utc::now();
    let timezone = runtime::budget::system_timezone();
    match runtime::settings::r7_scope(&conn, &scope.vault_id)? {
        None => Ok(trigger::runner::run_measurable(
            &conn, &registry, &scope, None, now, &timezone,
        )),
        Some(verification) => {
            // A declared scope makes R7 a real question, and a real question
            // needs the reduced ledger. No active writer is a whole-run
            // error, not a silent skip — the runner's not-evaluated wording
            // ("no scope declared") would be false here.
            let path = Path::new(&vault);
            ledger::shadow::with_writer(path, |writer| {
                let read =
                    ledger::read_ledger(&ledger::ledger_dir(path)).map_err(|e| e.to_string())?;
                let state = ledger::reduce::reduce(&read.frames, writer.store_id());
                Ok(trigger::runner::run_measurable(
                    &conn,
                    &registry,
                    &scope,
                    Some(trigger::runner::R7Input {
                        state: &state,
                        verification: &verification,
                    }),
                    now,
                    &timezone,
                ))
            })
            .unwrap_or_else(|| {
                Err(
                    "an R7 verification scope is declared, but this vault has no active ledger \
                     writer to reduce — reopen the vault and ask again"
                        .to_string(),
                )
            })
        }
    }
}

/// What recording one pack did, as the owner sees it.
#[derive(serde::Serialize)]
struct PackRecorded {
    gate: String,
    evaluation_id: String,
    result: String,
    replayed: bool,
}

/// Record an owner evidence pack (M28.2): the discretionary road, or R2's
/// hybrid assembly — dispatched on the pack's own gate. `repo_root` is where
/// `docs/superpowers/evidence/` lives; the packs govern this project's
/// deferrals, so they live in the repository, not the vault.
///
/// A discretionary recording REQUIRES `result` ("fired" | "not_fired") —
/// recording is the owner's explicit act. R2 refuses a supplied result: its
/// result is measured from `budget_days`, never declared.
#[tauri::command(async)]
fn trigger_record_pack(
    app: tauri::AppHandle,
    vault: String,
    repo_root: String,
    pack_path: String,
    result: Option<String>,
) -> Result<PackRecorded, String> {
    let conn = runtime::open_existing(&config_dir(&app)?)?;
    let scope = trigger_vault_scope(&vault)?;
    let registry = trigger::registry::load()?;
    let repo = Path::new(&repo_root);
    let bytes = std::fs::read_to_string(repo.join(&pack_path))
        .map_err(|e| format!("{pack_path:?} does not resolve from {repo_root:?}: {e}"))?;
    let pack =
        trigger::evidence::parse_pack(&bytes).map_err(|r| format!("{}: {}", r.code, r.detail))?;
    let gate = pack
        .frontmatter
        .get("gate")
        .cloned()
        .ok_or("the pack declares no gate")?;
    // A vault-scoped pack must be about THIS vault's store — recording
    // governance rows for a store you are not looking at is how a fired
    // gate ends up invisible.
    if let Some(declared) = pack.frontmatter.get("scope") {
        let own = format!("vault_store:{}:{}", scope.vault_id, scope.store_uuid);
        if declared != "subscription_global" && declared != &own {
            return Err(format!(
                "the pack is scoped to {declared:?} and this vault is {own:?} — open the vault \
                 the pack is about"
            ));
        }
    }
    let now = chrono::Utc::now();
    if gate == "R2:root" {
        if result.is_some() {
            return Err(
                "R2's result is measured from budget_days, never declared — omit \
                        result for a hybrid pack"
                    .to_string(),
            );
        }
        let recorded = trigger::record::evaluate_r2(&conn, &registry, repo, &pack_path, now)?;
        return Ok(PackRecorded {
            gate,
            evaluation_id: recorded.evaluation.evaluation_id,
            result: recorded.evaluation.result.as_str().to_string(),
            replayed: recorded.evaluation_put == runtime::triggers::Put::Replayed,
        });
    }
    let result = match result.as_deref() {
        Some("fired") => trigger::evaluation::TriggerResult::Fired,
        Some("not_fired") => trigger::evaluation::TriggerResult::NotFired,
        Some(other) => {
            return Err(format!(
                "result {other:?} is not one an owner may declare — fired or not_fired"
            ))
        }
        None => {
            return Err(
                "a discretionary recording is the owner's explicit act — say fired or \
                        not_fired"
                    .to_string(),
            )
        }
    };
    let recorded = trigger::record::record_discretionary(
        &conn,
        &registry,
        repo,
        &pack_path,
        result,
        &now.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
    )?;
    Ok(PackRecorded {
        gate,
        evaluation_id: recorded.evaluation.evaluation_id,
        result: recorded.evaluation.result.as_str().to_string(),
        replayed: recorded.evaluation_put == runtime::triggers::Put::Replayed,
    })
}

/// Resolve the held pile. `baseline` accepts today's content as already
/// accounted for; `process` queues it. Either decision is durable, and the
/// question is asked once rather than on every launch.
#[tauri::command(async)]
fn resolve_held_items(
    app: tauri::AppHandle,
    vault: String,
    which: String,
    choice: String,
) -> Result<usize, String> {
    let conn = runtime::open_existing(&config_dir(&app)?)?;
    let scope = runtime::open_vault(Path::new(&vault))
        .ok_or("this vault is not registered with the runtime database")?;
    let store = scope.store_uuid.as_deref().unwrap_or_default();
    let choice = match choice.as_str() {
        "baseline" => runtime::import::Choice::Baseline,
        "process" => runtime::import::Choice::Process,
        other => return Err(format!("unknown choice {other:?}")),
    };
    match which.as_str() {
        "baseline_held" => runtime::import::resolve(&conn, &scope.vault_id, store, choice),
        "recovery_held" => runtime::recovery::resolve(&conn, &scope.vault_id, store, choice),
        other => Err(format!("unknown held pile {other:?}")),
    }
}

/// The M23.7 reconciliation exits, per path since M49.5.
/// `accept_current_files` keeps every quarantined file: each is adopted on
/// its own capture, and once none is left quarantined a closing batch that
/// holds only the resolution closes the mode. `restore_ledger_authority`
/// regenerates every projection, moves the files the ledger cannot explain
/// into `.cerebro/reconcile-backup/`, and closes the mode with the
/// unbatched resolution. With a `path`, `keep` or `restore` exits one file.
#[tauri::command(async)]
fn resolve_reconciliation(
    vault: String,
    action: String,
    path: Option<String>,
) -> Result<(), String> {
    // M49.5: a `path` makes it one file's exit (`keep` | `restore`);
    // without one, the whole-vault exits.
    let vault = Path::new(&vault);
    match path {
        Some(path) => ledger::reconcile::resolve_path(vault, &path, &action),
        None => ledger::reconcile::resolve(vault, &action),
    }
    .unwrap_or_else(|| {
        Err(format!(
            "{}: no active ledger writer for this vault — reconciliation is unavailable",
            ledger::concepts::LEDGER_WRITER_UNAVAILABLE
        ))
    })
}

/// The one sanctioned human write into the bundle: recording that a person
/// has confirmed a concept. Scoped to the `verified` key (see knowledge.rs).
#[tauri::command(async)]
fn verify_concept(
    vault: String,
    path: String,
    patch: serde_json::Map<String, serde_json::Value>,
    viewed_body_hash: String,
) -> Result<(), String> {
    let by = WriteReceipt::ipc(knowledge::guard_verify(&path, &patch)?);
    // A field revision plus its attestation through the ledger writer
    // (M23.4); refused, not written, when no writer is active (M49.1) or
    // when the body on disk is not the one the person read (M49.3).
    vault::write::verify_frontmatter(Path::new(&vault), &path, &patch, &viewed_body_hash, &by)
}

/// The M23.5 capture boundary: a structured in-app edit to a knowledge
/// projection commits assertion+revision as one logical batch; an editorial
/// edit commits a projection override. The M23.7 valve routes the human
/// edit paths here; until then only capture-aware surfaces call it. A vault
/// without an active ledger writer cannot capture — the error names it.
#[tauri::command(async)]
fn capture_concept_edit(vault: String, request: serde_json::Value) -> Result<(), String> {
    // Only a bundle path opens the capture door (M58.1); anything else is no
    // projection to capture, whatever its shape.
    let path = request
        .get("path")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    let Some(cleared) = knowledge::concept_door(knowledge::HumanConcept::Capture(path)) else {
        return Err(ledger::capture::NOT_A_PROJECTION.to_string());
    };
    let by = WriteReceipt::ipc(cleared);
    ledger::capture::capture_from_json(Path::new(&vault), &request, &by).unwrap_or_else(|| {
        Err(
            "no active ledger writer for this vault — capture is unavailable (see ledger_status)"
                .to_string(),
        )
    })
}

#[tauri::command(async)]
fn create_note(
    vault: String,
    folder: String,
    slug: String,
    frontmatter: serde_json::Map<String, serde_json::Value>,
    body: String,
) -> Result<String, String> {
    let by = WriteReceipt::ipc(knowledge::guard_human_write(&folder)?);
    vault::write::create_note(Path::new(&vault), &folder, &slug, &frontmatter, &body, &by)
}

#[tauri::command(async)]
fn set_note_title(vault: String, path: String, title: String) -> Result<(), String> {
    let by = WriteReceipt::ipc(knowledge::guard_human_write(&path)?);
    vault::write::set_note_title(Path::new(&vault), &path, &title, &by)
}

#[tauri::command(async)]
fn list_views(vault: String) -> Result<Vec<ViewYaml>, String> {
    vault::write::list_views(Path::new(&vault))
}

#[tauri::command(async)]
fn save_view(
    vault: String,
    id: String,
    yaml: String,
    folder: Option<String>,
) -> Result<(), String> {
    // The bundle guard on the file it writes (M58.1): this was the one write
    // command without one.
    let target = match &folder {
        Some(folder) => format!("{folder}/views/{id}.yml"),
        None => format!("views/{id}.yml"),
    };
    let by = WriteReceipt::ipc(knowledge::guard_human_write(&target)?);
    vault::write::save_view(Path::new(&vault), &id, &yaml, folder.as_deref(), &by)
}

#[tauri::command(async)]
fn list_collections(vault: String) -> Result<Vec<CollectionYaml>, String> {
    vault::write::list_collections(Path::new(&vault))
}

#[tauri::command(async)]
fn save_collection(vault: String, folder: String, yaml: String) -> Result<(), String> {
    let by = WriteReceipt::ipc(knowledge::guard_human_write(&folder)?);
    vault::write::save_collection(Path::new(&vault), &folder, &yaml, &by)
}

#[tauri::command(async)]
fn save_list(vault: String, folder: String, id: String, yaml: String) -> Result<(), String> {
    let by = WriteReceipt::ipc(knowledge::guard_human_write(&folder)?);
    vault::write::save_list(Path::new(&vault), &folder, &id, &yaml, &by)
}

#[tauri::command(async)]
fn create_folder(vault: String, path: String) -> Result<(), String> {
    let by = WriteReceipt::ipc(knowledge::guard_human_write(&path)?);
    vault::write::create_folder(Path::new(&vault), &path, &by)
}

#[tauri::command(async)]
fn rename_note(vault: String, from: String, to: String) -> Result<(), String> {
    let by = WriteReceipt::ipc(knowledge::guard_human_move(&from, &to)?);
    vault::write::rename_note(Path::new(&vault), &from, &to, &by)
}

#[tauri::command(async)]
fn delete_note(vault: String, path: String) -> Result<vault::trash::TrashedItem, String> {
    // The one write command that never had this guard (M17.1). Read-only
    // that a delete can empty is not read-only: every other door into the
    // bundle was shut while this one let a concept — and its provenance —
    // be thrown away outright. M60.8: the page goes to the vault's own
    // Trash, `.trash/<stamp>/`, and Settings can bring it back.
    let by = WriteReceipt::ipc(knowledge::guard_human_write(&path)?);
    vault::write::delete_note(Path::new(&vault), &path, &by)
}

/// The vault's Trash, newest first (M60.8). Read-only.
#[tauri::command(async)]
fn list_trash(vault: String) -> Result<Vec<vault::trash::TrashedItem>, String> {
    vault::trash::list_trash(Path::new(&vault))
}

#[tauri::command(async)]
fn mail_gate_read(vault: String) -> Result<mail::GateRead, String> {
    mail::gate_read(Path::new(&vault))
}

/// Restore one Trash item to the path it came from (M60.8), guarded on that
/// path as any write is: a manifest that names knowledge/ refuses here.
#[tauri::command(async)]
fn restore_from_trash(vault: String, stamp: String) -> Result<String, String> {
    let target = vault::trash::restore_target(Path::new(&vault), &stamp)?;
    let by = WriteReceipt::ipc(knowledge::guard_human_write(&target)?);
    vault::trash::restore_from_trash(Path::new(&vault), &stamp, &by)
}

/// A marker read never treats unreadable state as an unoffered vault.
#[tauri::command(async)]
fn starter_marker(vault: String) -> Result<Option<starter::StarterMarker>, String> {
    starter::read_marker(Path::new(&vault))
}

#[tauri::command(async)]
fn install_starter_kit(vault: String) -> Result<starter::Installed, String> {
    let mut cleared = None;
    for (path, _) in starter::STARTER_FILES {
        cleared = Some(knowledge::guard_human_write(path)?);
    }
    let cleared = cleared.ok_or("The starter kit has no pages.")?;
    let by = WriteReceipt::ipc(cleared);
    starter::install(Path::new(&vault), &by)
}

#[tauri::command(async)]
fn decline_starter_kit(vault: String) -> Result<(), String> {
    starter::decline(Path::new(&vault))
}

/// One database-wide change, all or nothing (M60.6): a property rename,
/// kind change or copy, or a bulk delete, as `vault::batch` applies it.
/// Every op's path is guarded as any write is, and the first refusal answers
/// in its words. A stale `expectHash` (D2 (c)) answers `stale_content` and
/// records one operational row under surface `batch`.
#[tauri::command(async)]
fn apply_batch(
    vault: String,
    ops: Vec<serde_json::Value>,
) -> Result<vault::batch::BatchApplied, String> {
    let mut cleared = None;
    for op in &ops {
        let text = |key| {
            op.get(key)
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default()
        };
        cleared = Some(if text("op") == "rename" {
            knowledge::guard_human_move(text("from"), text("to"))?
        } else {
            knowledge::guard_human_write(text("path"))?
        });
    }
    let Some(cleared) = cleared else {
        return Ok(vault::batch::BatchApplied {
            batch_id: String::new(),
            files: Vec::new(),
            imports: None,
        });
    };
    let by = WriteReceipt::ipc(cleared);
    vault::batch::apply_batch(Path::new(&vault), &ops, &by).map_err(|error| match error {
        vault::batch::BatchError::Refused(message) => message,
        vault::batch::BatchError::Stale(stale) => {
            let message = vault::batch::stale_words(&stale.path);
            let typed = policy::table::PolicyTable::load().and_then(|table| {
                policy::rejection::OperationalRefusal::new(
                    &table,
                    "stale_content",
                    "batch",
                    &message,
                )
            });
            match typed {
                Ok(typed) => runtime::sink::record(&typed, &runtime::operational::LogEntry::bare()),
                Err(e) => log::warn!("operational_log: could not type stale_content: {e}"),
            }
            message
        }
    })
}

// --- Page comments (M70.2) -------------------------------------------------
//
// Each writes only the page's sidecar, `.comments/<page>.json`, never the
// page, so none runs `guard_human_write` on it: a concept page in knowledge/
// takes comments like any page (`vault::comments::comment_page` still holds
// the bundle to its own name). The author is always `human:owner`; the
// webview never names one.

#[tauri::command(async)]
fn list_comments(vault: String, path: String) -> Result<vault::comments::CommentsFile, String> {
    vault::comments::list_comments(Path::new(&vault), &path)
}

/// The one door every human comment op takes.
fn human_comment(
    vault: &str,
    path: &str,
    op: vault::comments::CommentOp,
) -> Result<vault::comments::CommentsFile, String> {
    vault::comments::write_comment(Path::new(vault), path, &op, vault::comments::OWNER, None)
}

#[tauri::command(async)]
fn start_comment_thread(
    vault: String,
    path: String,
    anchor: Option<vault::comments::AnchorInput>,
    body: String,
) -> Result<vault::comments::CommentsFile, String> {
    human_comment(
        &vault,
        &path,
        vault::comments::CommentOp::Start { anchor, body },
    )
}

#[tauri::command(async)]
fn reply_to_comment_thread(
    vault: String,
    path: String,
    thread: String,
    body: String,
) -> Result<vault::comments::CommentsFile, String> {
    human_comment(
        &vault,
        &path,
        vault::comments::CommentOp::Reply { thread, body },
    )
}

#[tauri::command(async)]
fn set_comment_thread_resolved(
    vault: String,
    path: String,
    thread: String,
    resolved: bool,
) -> Result<vault::comments::CommentsFile, String> {
    human_comment(
        &vault,
        &path,
        vault::comments::CommentOp::SetResolved {
            thread,
            resolved,
            closing: None,
        },
    )
}

#[tauri::command(async)]
fn delete_comment(
    vault: String,
    path: String,
    thread: String,
    comment: String,
) -> Result<vault::comments::CommentsFile, String> {
    human_comment(
        &vault,
        &path,
        vault::comments::CommentOp::DeleteComment { thread, comment },
    )
}

#[tauri::command(async)]
fn delete_comment_thread(
    vault: String,
    path: String,
    thread: String,
) -> Result<vault::comments::CommentsFile, String> {
    human_comment(
        &vault,
        &path,
        vault::comments::CommentOp::DeleteThread { thread },
    )
}

/// M70.4 — a person's comment names an agent with `@handle`: run one turn of
/// that agent, bound to the page and thread, and post its answer there.
/// Rust builds the run from the agent's record; the request names only the
/// page, the thread, the comment and the handle. A refusal is the error, and
/// writes nothing.
#[tauri::command(async)]
fn start_thread_turn(
    app: tauri::AppHandle,
    state: tauri::State<'_, agent::AgentState>,
    mcp_state: tauri::State<'_, mcp::McpState>,
    vault: String,
    request: agent::thread_turn::ThreadTurnRequest,
) -> Result<agent::thread_turn::ThreadTurnStarted, String> {
    agent::thread_turn::start(
        &app,
        state.inner(),
        mcp_state.inner(),
        Path::new(&vault),
        request,
    )
}

#[tauri::command(async)]
fn list_folders(vault: String) -> Result<Vec<String>, String> {
    vault::scan::list_folders(Path::new(&vault))
}

// --- Attachments (M16.13c) --------------------------------------------------

/// Native multi-file picker. Returns absolute paths; empty when cancelled.
///
/// Split from `import_attachment` so the copy stays a pure, unit-testable
/// function and so a future drag-and-drop can reuse it — the picker is the
/// only half that needs an AppHandle.
///
/// Not `(async)` but an `async fn`, matching `pick_vault`: the blocking
/// dialog must not run on the main thread.
#[tauri::command]
async fn pick_files(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let Some(picked) = app.dialog().file().blocking_pick_files() else {
        return Ok(Vec::new());
    };
    picked
        .into_iter()
        .map(|f| {
            f.into_path()
                .map(|p| p.to_string_lossy().to_string())
                .map_err(|e| e.to_string())
        })
        .collect()
}

/// Only the chosen filename and decoded preview cross into the webview.
#[tauri::command]
async fn pick_sheet_file(
    app: tauri::AppHandle,
) -> Result<Option<sheet::xlsx::PickedSheet>, String> {
    let Some(picked) = app
        .dialog()
        .file()
        .add_filter("Spreadsheets", &["xlsx", "xlsm", "csv"])
        .blocking_pick_file()
    else {
        return Ok(None);
    };
    let path = picked
        .into_path()
        .map_err(|_| "Choose a regular spreadsheet file.".to_string())?;
    let zone = runtime::budget::system_timezone();
    tauri::async_runtime::spawn_blocking(move || {
        sheet::xlsx::read_sheet_file(&path, &zone).map(Some)
    })
    .await
    .map_err(|_| "The spreadsheet importer stopped.".to_string())?
}

/// Copy a picked file into the vault's `attachments/` folder; returns its
/// vault-relative path. The destination is fixed inside `import_attachment`,
/// so its receipt is minted from the guard on that folder (M58.1).
#[tauri::command(async)]
fn import_attachment(
    vault: String,
    source: String,
) -> Result<vault::write::AttachmentImport, String> {
    let by = WriteReceipt::ipc(knowledge::guard_human_write(vault::write::ATTACHMENTS_DIR)?);
    vault::write::import_attachment(Path::new(&vault), &source, &by)
}

#[tauri::command(async)]
fn import_attachment_bytes(
    vault: String,
    name: String,
    bytes_base64: String,
) -> Result<vault::write::AttachmentImport, String> {
    let by = WriteReceipt::ipc(knowledge::guard_human_write(vault::write::ATTACHMENTS_DIR)?);
    vault::write::import_attachment_bytes(Path::new(&vault), &name, &bytes_base64, &by)
}

/// Read the already-kept original through the bounded Office reader. No write
/// or attribution receipt is minted by an extraction (M66.7c).
#[tauri::command(async)]
fn extract_document(vault: String, path: String) -> Result<files::extract::Extraction, String> {
    files::extract::capture(Path::new(&vault), &path, files::extract::Limits::SHIPPED)
}

/// Read only the outside paths explicitly supplied by a person's file drop.
#[tauri::command(async)]
fn inspect_dropped(paths: Vec<String>) -> Vec<files::dropped::DroppedFile> {
    files::dropped::inspect(paths)
}

#[tauri::command(async)]
fn read_dropped_text(path: String) -> files::dropped::DroppedText {
    files::dropped::read_text(&path)
}

/// Write a raw text file (`.mmd` only) into the vault; returns the actual
/// path after `-2` stem dedupe (M29.22). The knowledge guard mints the
/// receipt here (M58.1); the extension allowlist lives in write.rs beside
/// the dedupe, where it is unit-tested.
#[tauri::command(async)]
fn write_text_file(vault: String, path: String, content: String) -> Result<String, String> {
    let by = WriteReceipt::ipc(knowledge::guard_human_write(&path)?);
    vault::write::write_text_file(Path::new(&vault), &path, &content, &by)
}

/// Save PNG bytes wherever the user points the native dialog (M29.4).
/// Cancel is `Ok(None)` — not an error — mirroring `pick_files`.
#[tauri::command]
async fn export_png(
    app: tauri::AppHandle,
    default_name: String,
    bytes_base64: String,
) -> Result<Option<String>, String> {
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(bytes_base64)
        .map_err(|e| e.to_string())?;
    let Some(picked) = app
        .dialog()
        .file()
        .set_file_name(&default_name)
        .add_filter("PNG image", &["png"])
        .blocking_save_file()
    else {
        return Ok(None);
    };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(Some(path.to_string_lossy().to_string()))
}

/// Save an SVG document wherever the user points the native dialog (M44.3).
/// `export_png` minus the base64 — the payload is text. Cancel is `Ok(None)`.
#[tauri::command]
async fn export_svg(
    app: tauri::AppHandle,
    default_name: String,
    svg: String,
) -> Result<Option<String>, String> {
    let Some(picked) = app
        .dialog()
        .file()
        .set_file_name(&default_name)
        .add_filter("SVG image", &["svg"])
        .blocking_save_file()
    else {
        return Ok(None);
    };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    std::fs::write(&path, svg).map_err(|e| e.to_string())?;
    Ok(Some(path.to_string_lossy().to_string()))
}

/// Save a view as UTF-8 CSV at the native dialog's chosen destination (M61.5b).
/// Cancel is `Ok(None)` and never writes a file.
#[tauri::command]
async fn export_csv(
    app: tauri::AppHandle,
    default_name: String,
    csv: String,
) -> Result<Option<String>, String> {
    let Some(picked) = app
        .dialog()
        .file()
        .set_file_name(&default_name)
        .add_filter("CSV document", &["csv"])
        .blocking_save_file()
    else {
        return Ok(None);
    };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    std::fs::write(&path, csv).map_err(|e| e.to_string())?;
    Ok(Some(path.to_string_lossy().to_string()))
}

/// Export calculated live sheet fences; no vault read or write door is involved.
#[tauri::command]
async fn export_sheet_xlsx(
    app: tauri::AppHandle,
    default_name: String,
    page: String,
) -> Result<Option<String>, String> {
    let zone = runtime::budget::system_timezone();
    let bytes =
        tauri::async_runtime::spawn_blocking(move || sheet::xlsx::workbook_xlsx(page, zone))
            .await
            .map_err(|_| "The spreadsheet exporter stopped.".to_string())??;
    let Some(picked) = app
        .dialog()
        .file()
        .set_file_name(&default_name)
        .add_filter("Excel workbook", &["xlsx"])
        .blocking_save_file()
    else {
        return Ok(None);
    };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    std::fs::write(&path, bytes).map_err(|e| format!("The workbook couldn't be written: {e}"))?;
    Ok(Some(path.to_string_lossy().to_string()))
}

// --- Local agent + MCP (M6) ------------------------------------------------

#[tauri::command(async)]
fn check_agent() -> agent::AgentStatus {
    agent::status()
}

/// The pre-run question spends under the ambient gate, with a Rust-only
/// internal grant; the renderer names wakes, never the check's capabilities.
#[tauri::command(async)]
fn check_wake(
    app: tauri::AppHandle,
    state: tauri::State<'_, agent::AgentState>,
    mcp_state: tauri::State<'_, mcp::McpState>,
    vault: String,
    actor: String,
    wakes: Vec<String>,
    question: String,
) -> Result<agent::condition::WakeCheck, String> {
    let vault = Path::new(&vault);
    let scope = runtime::open_vault(vault)
        .ok_or("pre-run checks need the runtime database, which is not open")?;
    let store = scope
        .store_uuid
        .as_deref()
        .ok_or("this vault has no ledger store, so a pre-run check cannot claim its lease")?;
    let dir = config_dir(&app)?;
    let conn = runtime::open_existing(&dir)?;
    let entries = vault::scan::scan_vault(vault)?;
    agent::condition::check(
        &conn,
        &agent::condition::Input {
            vault,
            vault_id: &scope.vault_id,
            store_uuid: store,
            actor: &actor,
            wakes: &wakes,
            question: &question,
            entries: &entries,
        },
        &agent::condition::Live {
            app: &app,
            agents: state.inner(),
            mcp: mcp_state.inner(),
            vault,
            data_dir: &dir,
            vault_id: &scope.vault_id,
            store_uuid: store,
        },
        chrono::Utc::now(),
    )
}

/// What the CLI has stored about this vault OUTSIDE it (M17.14).
#[tauri::command(async)]
fn agent_workspace(vault: String) -> agent::CliWorkspace {
    agent::cli_workspace(Path::new(&vault))
}

#[tauri::command(async)]
fn purge_agent_workspace(vault: String) -> Result<usize, String> {
    agent::purge_cli_workspace(Path::new(&vault))
}

/// A conversation's transcript, folded from Claude Code's own session file
/// for this vault (M56.3): read-only, read through once, stored nowhere. A
/// session id that is not a UUID reads as not recorded and never reaches a
/// path; `last_active_at` (RFC 3339) tells a sweep from a clear, and one that
/// does not parse reads as unknown.
#[tauri::command(async)]
fn read_cli_transcript(
    vault: String,
    session_id: Option<String>,
    last_active_at: Option<String>,
) -> agent::transcript::TranscriptRead {
    let last_active = last_active_at
        .as_deref()
        .and_then(|at| chrono::DateTime::parse_from_rfc3339(at).ok())
        .map(|at| at.with_timezone(&chrono::Utc));
    agent::transcript::read_cli_transcript(Path::new(&vault), session_id.as_deref(), last_active)
}

/// M34.1.1: the tools half of the grant, taken from the REQUEST like the
/// scope half always was. `None` is unrestricted (the panel's own turns: a
/// person is watching them and no record narrowed them); `Some([])` is
/// narrowed to nothing (the editor popovers say exactly that). The CLI never
/// sees this and therefore cannot argue with it.
fn grant_tools(request: &agent::AgentRequest) -> Option<Vec<String>> {
    request.allowed_tools.clone()
}

/// Spawn a run another run asked for (M34.3.2) — mcp.rs's `hand_to` is the
/// one caller. The callee works under its OWN axes, taken from its record by
/// the tool and enforced by the token minted here; calling never lends the
/// caller's permissions. The row it books names the caller, so the chain is
/// walkable, and its chain in the grant carries the ancestry the hop rules
/// are enforced against. Booked `Attended` like every renderer-started agent
/// run — the §8.3 accounting question is answered for all of them at once,
/// not specially here.
pub(crate) fn start_handoff_run(
    app: &tauri::AppHandle,
    vault: &Path,
    mut request: agent::AgentRequest,
    caller: &mcp::RunGrant,
) -> Result<String, String> {
    use tauri::Manager;
    let actor = request
        .actor
        .clone()
        .ok_or("a handed-to run always has an actor — the callee's record names it")?;
    let scope = runtime::open_vault(vault);
    // The same pause gate run_agent enforces, for the same reason: a paused
    // agent cannot be called, and the chain that would have reached it stops
    // with it — before any token exists for a child to present.
    if let Some(scope) = scope.as_ref() {
        runtime::sink::with_sink(|conn| {
            runtime::settings::refuse_if_agent_paused(conn, &scope.vault_id, Some(&actor))
        })
        .unwrap_or(Ok(()))?;
        // M36.6 — the root's ceiling stops the chain, enforced at the spawn
        // like the hop budget and the cycle rule: hops bill to the root, so
        // a chain that has spent what one background run may spend gets no
        // further children, whatever its hop count says.
        let conn = runtime::open_existing(&config_dir(app)?)?;
        runtime::dispatch::refuse_if_chain_spent(&conn, &caller.run_id, chrono::Utc::now())?;
    }
    let mcp_state = app.state::<mcp::McpState>();
    // M53.10: the endpoint and the bearer are set here, in Rust, as for
    // every run. A handed-to run's request used to reach `agent::stream`
    // with no endpoint at all, so `hand_to` never started anything.
    request.mcp_url = Some(mcp_state.ensure(app)?.url);
    // Before the mint (M53.11): from the mint on, every failure is
    // `agent::stream`'s, and it revokes the bearer it was handed.
    let dir = config_dir(app)?;
    let run_id = ledger::new_run_id();
    let durable = run_id.clone();
    // M56.7 — a hand-off records its caller, and its message opens with the
    // WHY block that names the caller as data. M57.4c: after it, what became
    // of the writes this agent queued for Review, told once.
    let cause = runtime::cause::RunCause::handoff(&caller.actor);
    let (message, told) = with_outcomes(&request.message, &request, vault);
    request.message = runtime::cause::with_preamble(&message, Some(&cause), chrono::Utc::now());
    request.mcp_token = Some(mcp_state.handoff_token(
        &actor,
        request.scope.clone(),
        request.read_scope.clone(),
        request.allowed_tools.clone(),
        run_id.clone(),
        caller,
        // M57.4: the callee's own record, read by `hand_to`.
        request.ask_first == Some(true),
    )?);
    let meter = agent::meter::Meter {
        data_dir: dir.clone(),
        run_id,
        mode: agent::meter::Mode::Attended,
        vault_id: scope.as_ref().map(|s| s.vault_id.clone()),
        store_uuid: scope.as_ref().and_then(|s| s.store_uuid.clone()),
        started_at: chrono::Utc::now(),
        elapsed_limit_seconds: None,
        actor: Some(actor),
        // The whole point of M34.3.1: this run knows who started it.
        parent_run_id: Some(caller.run_id.clone()),
        cause: Some(cause),
    };
    let agent_state = app.state::<agent::AgentState>();
    agent::stream(
        app.clone(),
        agent_state.inner(),
        vault,
        request,
        &dir,
        Some(meter),
        None,
    )
    .map(|_run| {
        report_outcomes(&told, &durable);
        durable
    })
}

/// What starting a run answers: a handle, a typed deferral (M34.2.4), or a
/// woken run that had nothing left to run (M63.1).
///
/// `Deferred` is the ambient gate saying "not now" — over a ceiling, paused,
/// accounting unknown — and it is a RESULT, not an error: the caller is
/// expected to read the reasons and their human words, log one honest row, and leave the fire key
/// unconsumed so the run happens when the window resets. A woken run's wake
/// stays pending with a time to try again. `Settled` answers a woken run
/// whose wake was no longer pending, expired, or was cancelled by its
/// agent's pause: `gone`, nothing started and nothing to retry. Untagged
/// serde: the renderer tells the arms apart by which field is present.
#[derive(serde::Serialize)]
#[serde(untagged)]
enum RunStart {
    Started(RunHandle),
    Deferred {
        deferred: Vec<String>,
        words: Vec<String>,
    },
    Settled {
        settled: &'static str,
    },
}

impl RunStart {
    fn deferred(codes: Vec<String>) -> Self {
        let words = codes
            .iter()
            .map(|code| {
                runtime::budget::GateReason::ALL
                    .iter()
                    .find(|reason| reason.as_str() == code)
                    .map(|reason| reason.words())
                    .unwrap_or(match code.as_str() {
                        "agent_running" => "this agent is already running",
                        "nothing_to_claim" => "the dispatcher found nothing to start",
                        other => other,
                    })
                    .to_string()
            })
            .collect();
        Self::Deferred {
            deferred: codes,
            words,
        }
    }
}

/// Returns the run's id — the tag on every event this run emits.
#[tauri::command(async)]
fn run_agent(
    app: tauri::AppHandle,
    state: tauri::State<'_, agent::AgentState>,
    mcp_state: tauri::State<'_, mcp::McpState>,
    vault: String,
    request: agent::AgentRequest,
    wake: Option<runtime::wakes::WakeRequest>,
    followup: Option<String>,
) -> Result<RunStart, String> {
    // M56.5: the run's model and effort first, before the pause check, the
    // endpoint and any lease, so a refused run leaves no token, lease or row.
    agent::run_options::validate_request(&request)?;
    if followup.is_some()
        && (wake.is_some()
            || request.attended == Some(true)
            || request.lane.as_deref() != Some("agent")
            || !request
                .actor
                .as_deref()
                .is_some_and(|actor| actor.starts_with("process:") && actor.len() > 8))
    {
        return Err(
            "A follow-up starts only its own agent, unattended on lane agent, without a wake."
                .into(),
        );
    }
    // M63.1: a woken run is an agent's unattended run on lane agent, and its
    // cause is its wake's, so a request that says otherwise starts nothing.
    if wake.is_some() {
        if let Some(refused) = runtime::wakes::refuse_request(
            request.attended.unwrap_or(false),
            request.lane.as_deref(),
            request.actor.as_deref(),
            request.cause.is_some(),
        ) {
            return Err(refused);
        }
    }
    // Attribution rides the run's own bearer token (M13.4): the MCP server
    // stamps `generated.by` from the token each request presents, so a
    // child killed while a write is in flight still stamps as itself.
    // Shared "current actor" state had a window — set here, before the old
    // child was gone — where the outgoing run's trailing writes stamped as
    // the incoming run (PR #5 security review).
    let mut request = request;
    // M49.4 (K7): the knowledge recheck lanes are Cerebro's own work, not a
    // person's grant, and they exist to rewrite `knowledge/` — which they
    // may do only through the server-stamped write_concept and
    // recheck_concept. Never shell, whatever the Settings
    // ceiling or the job says, so the built-in writers stay denied.
    if matches!(request.lane.as_deref(), Some("stale" | "schema")) {
        request.shell = Some(agent::ShellCeiling::Off);
    }
    // M25.2: attended chat is METERED and never gated. The run is recorded
    // with its tokens; no reservation, no lease, and no ceiling can refuse it.
    let scope = runtime::open_vault(Path::new(&vault));
    // M33b.5 — the fleet pause gate every agent-attributed run passes is not a
    // budget question. Every frontend path that starts a CLI child funnels
    // here (the job runner's schedules and triggers, and the panel addressing
    // an agent by name), so this is where a per-agent pause has to be
    // enforced; enforcing it in whichever surface remembered to check would be
    // enforcing it nowhere. The one other door, `start_thread_turn` (M70.4, a
    // person's @mention in a comment thread), checks the same pause before
    // it writes or mints anything. Before the token is minted and long before a child is
    // spawned: a refused run must leave no run token behind for the CLI to
    // present.
    //
    // The check needs a runtime database to read, and `open_vault` is `None`
    // when there is none — in which case there is also nowhere a pause could
    // have been stored, so there is nothing being waved through.
    if let Some(scope) = scope.as_ref() {
        runtime::sink::with_sink(|conn| {
            runtime::settings::refuse_if_agent_paused(
                conn,
                &scope.vault_id,
                request.actor.as_deref(),
            )
        })
        .unwrap_or(Ok(()))?;
    }
    // M56.7 — why this run started, admitted before any endpoint, bearer or
    // claim, so a refused cause leaks none of them. An attended turn is
    // always `attended`; an unattended one names its cause or records NULL.
    let dir = config_dir(&app)?;
    // M63.8: only the bound claimed row can authorize a follow-up cause.
    // A supplied note, due time or different cause cannot rewrite its record.
    let bound_followup = if let Some(id) = followup.as_deref() {
        let scope = scope
            .as_ref()
            .filter(|s| s.store_uuid.is_some())
            .ok_or("this vault has no ledger store, so a follow-up cannot claim its lease")?;
        let conn = runtime::open_existing(&dir)?;
        let Some(row) = runtime::followups::ready_to_fire(
            &conn,
            &scope.vault_id,
            request.actor.as_deref().unwrap_or_default(),
            id,
            chrono::Utc::now(),
        )?
        else {
            return Ok(RunStart::Settled { settled: "gone" });
        };
        Some(row)
    } else {
        None
    };
    let cause = match bound_followup.as_ref() {
        Some(row) => Some(row.cause()),
        None => runtime::cause::admit(request.attended.unwrap_or(false), request.cause.as_ref())?,
    };
    // M63.5: manual starts never duplicate a live run of this actor, including
    // an attended @agent or hand-off. Refuse before endpoint, bearer or lease.
    if cause
        .as_ref()
        .is_some_and(|cause| cause.kind() == runtime::cause::CauseKind::Manual)
    {
        if let Some(actor) = request.actor.as_deref() {
            state.refuse_if_running(Path::new(&vault), actor)?;
        }
    }
    // M53.10: the endpoint this run dials, started here if it is not up yet.
    // Rust sets it for every run — the wire cannot name it — and before any
    // lease is claimed, so an endpoint that cannot start leaks none.
    request.mcp_url = Some(mcp_state.ensure(&app)?.url);
    // M34.2.4 — an unattended run that names its lane is AMBIENT spend, and
    // spec §8.3 is answered here: `mode='attended', lane='agent'` on every
    // renderer-started run was a gap, not intent. The claim is the same call
    // the ingest driver makes — zero items, the job's lane, the record's
    // actor, the day's per-run reservation — so schedules and ingest share
    // one budget, one concurrency ceiling, and one deferral record. A
    // deferral returns TYPED, with its reasons: the runner logs one honest
    // row and the fire key stays unconsumed, because a run the gate refused
    // must not eat the period it was refused in.
    //
    // No lane, or no runtime scope to claim against, keeps the legacy
    // attended booking — metering is a record, never a precondition.
    let mut lease: Option<runtime::dispatch::Lease> = None;
    let mut parent_run_id: Option<String> = None;
    // The wakes a woken run took with it, named on its WHY block's Also line.
    let mut also: Vec<runtime::cause::RunCause> = Vec::new();
    let mut cause = cause;
    if let Some(wake) = wake.as_ref() {
        // M63.1 — a woken run claims its wake inside the dispatch
        // transaction, with its lease, and records the wake's own cause.
        let Some((vault_id, store)) = scope
            .as_ref()
            .and_then(|s| s.store_uuid.as_ref().map(|store| (&s.vault_id, store)))
        else {
            return Err(
                "this vault has no ledger store, so a woken run cannot claim its lease".into(),
            );
        };
        let conn = runtime::open_existing(&dir)?;
        let now = chrono::Utc::now();
        let reservation = ingest::driver::reservation(&conn, now)?;
        match runtime::dispatch::claim_woken(
            &conn,
            vault_id,
            store,
            "agent",
            reservation,
            request.actor.as_deref().unwrap_or_default(),
            wake,
            now,
        )? {
            runtime::dispatch::Woken::Started {
                lease: l,
                cause: woke,
                also: took,
                parent_run_id: parent,
            } => {
                lease = Some(*l);
                cause = woke;
                also = took;
                parent_run_id = parent;
            }
            runtime::dispatch::Woken::Deferred(reasons) => {
                return Ok(RunStart::deferred(reasons));
            }
            runtime::dispatch::Woken::Gone => return Ok(RunStart::Settled { settled: "gone" }),
            runtime::dispatch::Woken::Skipped => {
                return Ok(RunStart::Settled { settled: "skipped" })
            }
        }
    } else if !request.attended.unwrap_or(false) {
        if let Some(lane) = request.lane.as_deref() {
            if !runtime::schema::LANES
                .iter()
                .any(|(name, _, _)| *name == lane)
            {
                return Err(format!(
                    "unknown lane {lane:?} — a lane is added by migration, not by request"
                ));
            }
            if let Some((vault_id, store)) = scope
                .as_ref()
                .and_then(|s| s.store_uuid.as_ref().map(|store| (&s.vault_id, store)))
            {
                let conn = runtime::open_existing(&dir)?;
                let now = chrono::Utc::now();
                let reservation = ingest::driver::reservation(&conn, now)?;
                match runtime::dispatch::claim(
                    &conn,
                    vault_id,
                    store,
                    lane,
                    reservation,
                    &[],
                    request.actor.as_deref(),
                    cause.as_ref(),
                    now,
                )? {
                    runtime::dispatch::Dispatched::Started(l) => lease = Some(l),
                    runtime::dispatch::Dispatched::Deferred(reasons) => {
                        if let Some(row) = bound_followup.as_ref() {
                            runtime::followups::release(
                                &conn,
                                vault_id,
                                &row.actor,
                                &row.followup_id,
                            )?;
                        }
                        return Ok(RunStart::deferred(
                            reasons.iter().map(|r| r.as_str().to_string()).collect(),
                        ));
                    }
                    // Unreachable with an empty item list — the empty-claim
                    // guard deliberately passes it to the gate — but if it
                    // ever arrives, honesty over spawning: nothing to do.
                    runtime::dispatch::Dispatched::NothingToClaim => {
                        if let Some(row) = bound_followup.as_ref() {
                            runtime::followups::release(
                                &conn,
                                vault_id,
                                &row.actor,
                                &row.followup_id,
                            )?;
                        }
                        return Ok(RunStart::deferred(vec!["nothing_to_claim".to_string()]));
                    }
                }
            }
        }
    }
    let admitted_run = lease.as_ref().map(|lease| lease.run_id.clone());
    if let Some(row) = bound_followup.as_ref() {
        let firing = (|| {
            let run = admitted_run
                .as_deref()
                .ok_or("A follow-up needs its ambient lease before it can run.")?;
            let scope = scope.as_ref().ok_or(runtime::followups::RUNTIME_NEEDED)?;
            let conn = runtime::open_existing(&dir)?;
            if !runtime::followups::fire(
                &conn,
                &scope.vault_id,
                &row.actor,
                &row.followup_id,
                run,
                chrono::Utc::now(),
            )? {
                return Err("That follow-up is no longer waiting. Nothing was started.".into());
            }
            Ok(())
        })();
        if let Err(error) = firing {
            return finish_unspawned_lease(&dir, admitted_run.as_deref(), Err(error));
        }
    }
    let result = spawn_requested_run(
        &app,
        state.inner(),
        mcp_state.inner(),
        Path::new(&vault),
        request,
        scope.as_ref(),
        cause,
        lease,
        also,
        parent_run_id,
    )
    .map(RunStart::Started);
    if result.is_err() {
        if let (Some(row), Some(run), Some(scope)) = (
            bound_followup.as_ref(),
            admitted_run.as_deref(),
            scope.as_ref(),
        ) {
            let restored = runtime::open_existing(&dir).and_then(|conn| {
                runtime::followups::unfire(&conn, &scope.vault_id, &row.followup_id, run)
            });
            if let Err(error) = restored {
                log::warn!(
                    "follow-up {} could not be restored after spawn refusal: {error}",
                    row.followup_id
                );
            }
        }
    }
    finish_unspawned_lease(&dir, admitted_run.as_deref(), result)
}

/// A failed start has no child to close the lease. In particular, a hop
/// bearer can be refused after claim but before the stream owns a meter.
/// Close that run and its wake now instead of waiting for lease recovery.
fn finish_unspawned_lease<T>(
    data_dir: &Path,
    run_id: Option<&str>,
    result: Result<T, String>,
) -> Result<T, String> {
    if let (Err(_), Some(run_id)) = (&result, run_id) {
        let closed = runtime::open_existing(data_dir).and_then(|conn| {
            runtime::dispatch::finalize(
                &conn,
                run_id,
                runtime::dispatch::RunOutcome::Failed,
                Some(agent::usage::Usage::default()),
                None,
                runtime::dispatch::ItemOutcome::Requeue,
                chrono::Utc::now(),
            )
        });
        if let Err(error) = closed {
            log::warn!("unspawned run {run_id} could not release its lease: {error}");
        }
    }
    result
}

/// Start an admitted run (out of `run_agent` for M57.1, whose answers resume
/// through it): the durable id, the bearer, the meter and the stream. The
/// request's endpoint is already set, its pause gate and cause already
/// passed. `lease` is the ambient claim an unattended laned run made; an
/// attended run, an answer's resume among them, has none. `also` is the
/// causes of the wakes a woken run took with it (M63.1), empty otherwise.
#[expect(
    clippy::too_many_arguments,
    reason = "each is a different fact run_agent and the answer command already hold"
)]
fn spawn_requested_run(
    app: &tauri::AppHandle,
    agents: &agent::AgentState,
    mcp_state: &mcp::McpState,
    vault: &Path,
    mut request: agent::AgentRequest,
    scope: Option<&runtime::VaultScope>,
    cause: Option<runtime::cause::RunCause>,
    lease: Option<runtime::dispatch::Lease>,
    also: Vec<runtime::cause::RunCause>,
    parent_run_id: Option<String>,
) -> Result<RunHandle, String> {
    let dir = config_dir(app)?;
    // M31.2a: the durable id is minted BEFORE the token so the grant and the
    // meter carry the SAME one — an attended run used to hold two (the meter's
    // here, a token-derived hash in the grant), and everything that joins runs
    // to proposals, answers, or costs needs them to be one. A leased run's id
    // was minted by the CLAIM, which already opened its row; an attended
    // run's row is opened by `agent::stream` just before the child spawns
    // (M49.9), so what the run books during its life has a row to land on.
    let run_id = lease
        .as_ref()
        .map(|l| l.run_id.clone())
        .unwrap_or_else(ledger::new_run_id);
    // M33.7: the renderer gets this id back, so its device-local run log and
    // the durable `runs` row can finally name the same run. Cloned rather
    // than moved because the meter takes ownership below.
    let durable = run_id.clone();
    // M17.13: the scope rides the same token. It is taken from the REQUEST,
    // which the app builds from the Agent record — the CLI never sees it and
    // therefore cannot argue with it. M34.1.1: so do the tools. argv
    // narrowing was always advice; this is the boundary behind it. M53.10:
    // and so does the vault, so a run's tool calls stay in the vault it was
    // started in, whatever is opened while it runs.
    // The WHY block opens an unattended run's message (M56.7), and says
    // nobody is watching, even when no cause was named (M57.3). An attended
    // turn's cause has none, so what a person typed goes to the CLI as typed.
    // M57.4c: an unattended agent run hears, after the WHY block, what became
    // of the writes it queued for Review; a run with none decided keeps its
    // message byte for byte, and an attended turn hears nothing. M63.1: a
    // woken run's block names the other wakes it took, as data.
    let (message, told) = with_outcomes(&request.message, &request, vault);
    request.message =
        runtime::cause::with_preamble_also(&message, cause.as_ref(), &also, chrono::Utc::now());
    // M57.4: whether the agent asks before its page writes, read from its
    // own record here as well as from the request, so a renderer that leaves
    // it out cannot drop it. The plan, the seat's snapshot (an answer's
    // resume) and the bearer all read the same value.
    request.ask_first = Some(mcp::effective_ask_first(
        vault,
        request.actor.as_deref(),
        request.ask_first,
    ));
    request.mcp_token = Some(if let Some(parent) = parent_run_id.as_deref() {
        let conn = runtime::open_existing(&dir)?;
        let chain = runtime::dispatch::chain_actors(&conn, parent)?
            .ok_or("the wake's parent run is no longer recorded")?;
        mcp_state.hop_token(
            request.actor.as_deref(),
            request.scope.clone(),
            request.read_scope.clone(),
            grant_tools(&request),
            run_id.clone(),
            vault,
            mcp::WriteAsks::of(&request),
            &chain,
        )?
    } else {
        mcp_state.run_token(
            request.actor.as_deref(),
            request.scope.clone(),
            request.read_scope.clone(),
            grant_tools(&request),
            run_id.clone(),
            vault,
            mcp::WriteAsks::of(&request),
        )?
    });
    let meter = agent::meter::Meter {
        data_dir: dir.clone(),
        run_id,
        // A leased run finalizes through the dispatcher: usage lands in
        // budget_days, the reservation is released, and the lease row goes
        // with it (M34.2.4). Everything else keeps the attended booking.
        mode: if lease.is_some() {
            agent::meter::Mode::Ambient
        } else {
            agent::meter::Mode::Attended
        },
        vault_id: scope.map(|s| s.vault_id.clone()),
        store_uuid: scope.and_then(|s| s.store_uuid.clone()),
        started_at: chrono::Utc::now(),
        // The lease's own limit, so the watchdog and the lease agree about
        // when a run has outstayed its welcome.
        elapsed_limit_seconds: lease.as_ref().map(|l| l.elapsed_limit_seconds),
        // M33.1: the same actor the run's bearer token already stamps on
        // every write it makes, so the operational row and the run's ledger
        // writes agree about who did the work. `None` is bare chat, and it
        // stays NULL — the fleet reads that as unattributed.
        actor: request.actor.clone(),
        // A recorded run's write wakes a hop; every other start stays a root.
        parent_run_id,
        // Written by the attended open; a leased run's claim already wrote it.
        cause,
    };
    agent::stream(
        app.clone(),
        agents,
        vault,
        request,
        &dir,
        Some(meter),
        // Nothing in the app waits on an attended run: the panel follows the
        // event stream, and the person is watching it.
        None,
    )
    .map(|spawned| {
        report_outcomes(&told, &durable);
        RunHandle {
            run: spawned.run,
            run_id: durable,
            session_id: spawned.session_id,
        }
    })
}

/// M57.4c — `message` with what became of the writes `request`'s agent
/// queued for Review in `vault` (`pending_writes::outcome_block`) before it,
/// and the ids it told. Only an unattended or handed-off run of a `process:`
/// agent hears it; an attended turn, one of Cerebro's own constructs, and a
/// run with nothing decided get `message` as it was. With no runtime
/// database nothing is told, and nothing is lost: the rows wait for a run
/// that can read them.
fn with_outcomes(
    message: &str,
    request: &agent::AgentRequest,
    vault: &Path,
) -> (String, Vec<String>) {
    let actor = match request.actor.as_deref() {
        Some(actor)
            if actor.starts_with("process:")
                && request.attended != Some(true)
                && !request.internal =>
        {
            actor
        }
        _ => return (message.to_string(), Vec::new()),
    };
    let vault_id = runtime::scope::derive_vault_id(vault);
    let told = runtime::sink::with_sink(|conn| {
        runtime::pending_writes::take_outcomes(conn, &vault_id, actor, &process_started_at())
    });
    let outcomes = match told {
        Some(Ok(outcomes)) => outcomes,
        Some(Err(detail)) => {
            log::warn!("pending_writes: could not read outcomes for {actor}: {detail}");
            return (message.to_string(), Vec::new());
        }
        None => return (message.to_string(), Vec::new()),
    };
    match runtime::pending_writes::outcome_block(&outcomes) {
        Some(block) => (
            format!("{block}\n\n{message}"),
            outcomes
                .rows
                .into_iter()
                .map(|row| row.pending_id)
                .collect(),
        ),
        None => (message.to_string(), Vec::new()),
    }
}

/// Mark what `with_outcomes` told as heard by `run_id`, once its run started,
/// so the next run is not told again.
fn report_outcomes(told: &[String], run_id: &str) {
    if told.is_empty() {
        return;
    }
    let marked =
        runtime::sink::with_sink(|conn| runtime::pending_writes::mark_reported(conn, told, run_id));
    if let Some(Err(detail)) = marked {
        log::warn!("pending_writes: could not mark outcomes reported: {detail}");
    }
}

/// M57.4c — the page writes waiting in Review for `vault`, oldest first,
/// each with its draft as JSON. An apply a previous process left unfinished
/// is swept to interrupted first. The vault's id is derived, not registered,
/// so the read registers nothing. A runtime database that cannot be read is
/// an error, which Review shows as unavailable, never as an empty queue.
#[tauri::command(async)]
fn pending_writes(vault: String) -> Result<Vec<runtime::pending_writes::PendingRow>, String> {
    let vault_id = runtime::scope::derive_vault_id(Path::new(&vault));
    runtime::sink::with_sink(|conn| {
        runtime::pending_writes::list_open(conn, &vault_id, &process_started_at())
    })
    .unwrap_or_else(|| Err("Cerebro's runtime database is unavailable".to_string()))
}

/// M57.4c — Review's Allow or Reject of one queued write (`mcp::decide_pending`):
/// the typed decision, read at the call site. `input` is the person's edit
/// of the draft, sent only with Allow; `reason` is required with Reject. A
/// write that lands is announced to the open pages, as an agent's write is.
#[tauri::command(async)]
fn decide_pending_write(
    app: tauri::AppHandle,
    vault: String,
    pending_id: String,
    allow: bool,
    input: Option<serde_json::Value>,
    reason: Option<String>,
) -> Result<mcp::PendingDecision, String> {
    use tauri::Emitter;
    mcp::decide_pending(
        Path::new(&vault),
        &pending_id,
        allow,
        input,
        reason.as_deref(),
        |change| {
            let _ = app.emit(mcp::UI_ACTION_EVENT, change);
        },
    )
}

/// Empty string = the vault has no connectors.json (a real state Settings
/// names). A file that EXISTS but cannot be read — permissions, a blocked
/// symlink — is an Err, never an empty Ok (PR #5 review): runs fail closed
/// on that config, and Settings rendering it as "no explicit list" would
/// claim legacy open mode while runs are pinned to zero servers.
#[tauri::command(async)]
fn read_connectors(vault: String) -> Result<String, String> {
    connectors::read_raw_checked(Path::new(&vault))
}

#[tauri::command(async)]
fn save_connectors(vault: String, json: String) -> Result<(), String> {
    connectors::save_raw(Path::new(&vault), &json)
}

/// Each connector in the vault's list with the last status a run saw it in
/// (M54.11): one row per entry, with why its name can't be granted when it
/// can't. An entry no run has seen comes back with no state, which Settings
/// says as "not observed yet". The vault's id is derived, not registered, so
/// a read writes nothing. A runtime DB or list that can't be read is an
/// error, which Settings shows as unavailable, never as unobserved.
#[tauri::command(async)]
fn connector_status(
    app: tauri::AppHandle,
    vault: String,
) -> Result<Vec<connectors::StatusRow>, String> {
    let vault = Path::new(&vault);
    let conn = runtime::open_existing(&config_dir(&app)?)?;
    let seen = runtime::connector_status::read(&conn, &runtime::scope::derive_vault_id(vault))?;
    connectors::status_rows(vault, &seen)
}

/// Stop ONE run (M17.3). `false` means it had already finished — a race, not
/// an error. Taking a run id is the point: a global kill was safe only while
/// there could be one child, and it is how closing the assistant used to
/// abort a background distill that had nothing to do with it. It answers at
/// once; the run's process group gets TERM, then KILL once the grace has
/// passed (M53.10).
#[tauri::command(async)]
fn stop_agent(state: tauri::State<'_, agent::AgentState>, run: u64) -> Result<bool, String> {
    state.stop(run)
}

/// What a run said after the cursor `after` (M57.6), for a panel that
/// re-attaches: held, a gap the journal's cap left, or unknown. `run_id` is
/// the durable id, so a run number reused after a restart never answers for
/// another run. Memory only: nothing here reads or writes the disk.
#[tauri::command(async)]
fn agent_events_since(
    state: tauri::State<'_, agent::AgentState>,
    run: u64,
    run_id: String,
    after: u64,
) -> agent::journal::EventsSince {
    state.events_since(run, &run_id, after)
}

/// Stop everything, reporting what was stopped. The manual door: Rust already
/// stops every run on quit (`RunEvent::Exit`) and the old vault's runs on a
/// vault switch (`start_watcher`), so nothing has to call this for either.
#[tauri::command(async)]
fn stop_all_agents(state: tauri::State<'_, agent::AgentState>) -> Result<Vec<u64>, String> {
    state.stop_all()
}

/// What answering a waiting call says (M57.1): the resumed run's handle, or
/// a typed refusal the panel words (`no_longer_waiting` when the request
/// already ended). Untagged: the renderer tells the arms apart by which field
/// is present, as with `RunStart`.
#[derive(Serialize)]
#[serde(untagged)]
enum AnswerResult {
    Resumed(RunHandle),
    Refused {
        refused: agent::interaction::Refusal,
    },
}

/// A person's answer to a waiting call (M57.1), the one door an answer
/// enters by (CV-27): no MCP tool, hook or bearer reaches it. The answer is
/// taken only while its card waits in this vault, then the run's request
/// resumes on the same Claude Code session with no new text, where the
/// call's hook reads the answer. The resume passes the same pause gate any
/// run of that actor does, and is recorded as attended (M56.7). A resume
/// that cannot start puts the card back and says why.
///
/// `updated_input` is the person's edit of a write card's draft (M57.4b),
/// sent only with Allow. The book checks its shape, then `mcp::edit_refusal`
/// judges it under the grant the resume will run with (`answer_grant`); a
/// refusal comes back to the card, which keeps waiting, and records nothing.
#[tauri::command(async)]
fn answer_interaction(
    app: tauri::AppHandle,
    state: tauri::State<'_, agent::AgentState>,
    mcp_state: tauri::State<'_, mcp::McpState>,
    vault: String,
    id: String,
    answer: agent::interaction::WireAnswer,
    updated_input: Option<serde_json::Value>,
) -> Result<AnswerResult, String> {
    let book = state.interactions();
    let answer = agent::interaction::PersonAnswer::from_ipc(answer);
    let check = |request: &agent::AgentRequest, tool: &str, input: &serde_json::Value| {
        let at = Path::new(&vault);
        mcp::edit_refusal(at, &answer_grant(at, request), tool, input)
    };
    let key = agent::vault_key(Path::new(&vault));
    let resume = match book.begin_answer_edited(&key, &id, answer, updated_input, check) {
        Ok(resume) => resume,
        Err(refused) => return Ok(AnswerResult::Refused { refused }),
    };
    // M57.4: an Allow of a write card is the one way an approval is minted,
    // recorded before the resume starts so its write finds it at dispatch,
    // and dropped again if the resume never starts (`abort_answer`).
    if let Some(approval) = resume.approval.clone() {
        book.record_write_approval(approval);
    }
    let started: Result<RunHandle, String> = (|| {
        let vault_path = resume.vault.as_path();
        let scope = runtime::open_vault(vault_path);
        let mut request = resume.snapshot.clone();
        if let Some(scope) = scope.as_ref() {
            runtime::sink::with_sink(|conn| {
                runtime::settings::refuse_if_agent_paused(
                    conn,
                    &scope.vault_id,
                    request.actor.as_deref(),
                )
            })
            .unwrap_or(Ok(()))?;
        }
        request.message = String::new();
        request.session_id = Some(resume.session_id.clone());
        request.attended = Some(true);
        let cause = runtime::cause::admit(true, None)?;
        request.mcp_url = Some(mcp_state.ensure(&app)?.url);
        spawn_requested_run(
            &app,
            state.inner(),
            mcp_state.inner(),
            vault_path,
            request,
            scope.as_ref(),
            cause,
            None,
            Vec::new(),
            None,
        )
    })();
    match started {
        Ok(handle) => {
            book.finish_answer(&resume.id, &handle.run_id);
            Ok(AnswerResult::Resumed(handle))
        }
        Err(why) => {
            book.abort_answer(&resume.id);
            Err(why)
        }
    }
}

/// The grant an answer's resume runs under (M57.4b): the bearer
/// `spawn_requested_run` mints from the same stored request, short of its
/// run id, which only recording reads and an answer's check never records.
fn answer_grant(vault: &Path, request: &agent::AgentRequest) -> mcp::RunGrant {
    let actor = mcp::normalize_actor(request.actor.as_deref()).to_string();
    mcp::RunGrant {
        chain: vec![actor.clone()],
        actor,
        run_id: String::new(),
        scope: request.scope.clone(),
        read_scope: request.read_scope.clone(),
        tools: grant_tools(request),
        vault: Some(vault.to_path_buf()),
        asks: mcp::WriteAsks::of(request),
    }
}

/// Cancel a waiting call (M57.1): the panel's Stop or New conversation with
/// a card open. The call is refused as stopped when its thread goes on.
/// False when it was no longer waiting, which is not an error.
#[tauri::command(async)]
fn cancel_interaction(state: tauri::State<'_, agent::AgentState>, id: String) -> bool {
    state
        .interactions()
        .cancel(&id, agent::interaction::CancelReason::Stopped)
}

/// The calls waiting for the person in `vault` (M57.1), oldest first: what a
/// reloaded panel shows again.
#[tauri::command(async)]
fn list_interactions(
    state: tauri::State<'_, agent::AgentState>,
    vault: String,
) -> Vec<agent::interaction::InteractionCard> {
    state
        .interactions()
        .pending(&agent::vault_key(Path::new(&vault)))
}

/// The person's own Claude Code settings, counted (M57.2): how many allow,
/// ask and deny rules and which hook events their settings file holds, so
/// Settings can say they act before Cerebro asks. Never a rule's text.
/// `vault` resolves a relative `CLAUDE_CONFIG_DIR`, as the CLI's cwd does.
#[tauri::command(async)]
fn claude_user_settings(vault: Option<String>) -> agent::user_settings::UserSettings {
    agent::user_settings::for_vault(Path::new(vault.as_deref().unwrap_or("/")))
}

/// The ledger chain head for git checkpoint trailers (M21.7) — a join key
/// from a commit to the ledger head it was made at, not rewind detection
/// (M49.10; see `ledger::head`). Best-effort by design: any absent or
/// unreadable ledger is `None`, never an error.
#[tauri::command(async)]
fn ledger_head(vault: String) -> Option<ledger::LedgerHead> {
    ledger::head(Path::new(&vault))
}

/// Ledger diagnostics (M21.8): a live classification of the vault's
/// ledger, read by the reconciliation banner. Read-only — no minting, no
/// side effects.
#[tauri::command(async)]
fn ledger_status(app: tauri::AppHandle, vault: String) -> ledger::shadow::LedgerStatus {
    ledger::shadow::status(config_dir(&app).ok().as_deref(), Path::new(&vault))
}

#[tauri::command(async)]
fn start_watcher(
    app: tauri::AppHandle,
    state: tauri::State<'_, WatcherState>,
    ambient: tauri::State<'_, ingest::ambient::AmbientState>,
    agents: tauri::State<'_, agent::AgentState>,
    vault: String,
) -> Result<OpenReport, String> {
    let vault_path = PathBuf::from(&vault);
    let mut report = OpenReport::default();
    // M53.10: a run or client session never outlives its vault.
    // Opening one stops every run in
    // any other, Cerebro's own included; reopening this one (a webview
    // reload) stops nothing, and a run started here while it opened is kept.
    agents.stop_other_vaults(&vault_path);
    client_access::vault_opening(&vault_path);
    // M53.11: a connectors.json an older build wrote world-readable holds the
    // vault's connector credentials. Opening the vault narrows it to its
    // owner, best effort, and never stops the open.
    connectors::tighten(&vault_path);
    // M21.8 startup: run the M21.4 verification, record the verdict, start
    // shadow recording for this vault. Never blocks watching — a refused
    // ledger holds no writer, so knowledge writes refuse and ledger_status
    // says why. Idempotent across webview reloads (M49.1).
    if let Ok(dir) = config_dir(&app) {
        let _ = ledger::shadow::activate(&dir, &vault_path);
        // M24.2: the runtime DB is armed beside the ledger index, in
        // app-data — never inside a possibly cloud-synced vault (D2).
        // Failing to open the OPERATIONAL LOG must not stop the app from
        // opening the vault: it would trade a working workspace for a
        // diagnostic, and every refusal is still returned to its caller.
        if let Err(e) = runtime::sink::arm(&dir) {
            log::warn!("runtime db unavailable, operational refusals go unrecorded: {e}");
        }
        // M49.9: after the arm, which migrated the database. An attended row
        // a previous process left `running` has no finisher left; the cutoff
        // is this process's start, so a run it opened is never touched.
        agent::meter::recover_orphaned(&dir, process_started());
        // M63.1: wakes past their week expire, and a started wake whose run
        // ended without finishing it is closed. Never fails the open.
        runtime::wakes::sweep_at_open(&dir, &vault_path, chrono::Utc::now());
        // M70.4: a comment thread's pending answer whose run this process
        // does not hold reads failed, "didn't finish"; a live one is kept.
        agent::thread_turn::settle_orphans(&vault_path);
        // M25.1: one database serves every vault, so an opening vault
        // registers itself before anything writes a row that has to say
        // which folder it belongs to. Failing here is degraded, not fatal,
        // for the same reason the line above is.
        // M49.9 (K25): and the session records which PROCESS has it open.
        if let Some(scope) = runtime::open_vault(&vault_path) {
            runtime::sessions::track(&scope);
            client_access::vault_opened(&app, &vault_path, &scope);
        }
        // M60.6: a batch an earlier process left unfinished is put back
        // before the purge and the watcher, and the webview says so. The
        // cutoff is this process's start, so a reload never touches a batch
        // this process is running.
        let recovered = WriteReceipt::system(vault::receipt::SystemWriter::BatchRecovery);
        let rolled = vault::batch::recover(&vault_path, process_started(), &recovered);
        report = OpenReport {
            unfinished: rolled.unfinished,
            restored: rolled.restored,
            kept: rolled.kept,
        };
        // M60.8: Trash items past their days move to the OS Trash, on a
        // thread of their own so the open never waits on the Finder.
        let purged = vault_path.clone();
        let by = WriteReceipt::system(vault::receipt::SystemWriter::TrashPurge);
        std::thread::spawn(move || {
            let report = vault::trash::purge_expired_to_os_trash(&purged, &by);
            if report.moved + report.kept > 0 {
                log::info!(
                    "trash: {} old items moved to the OS Trash, {} kept",
                    report.moved,
                    report.kept
                );
            }
        });
        // M26.4i: the ambient ingest supervisor. It reads its own switch,
        // which defaults OFF — starting the loop is not the same as
        // enabling the work, and nothing here turns it on.
        ingest::ambient::start(&app, ambient.inner(), &vault_path, &dir);
    }
    vault::watcher::start(app, state.inner(), vault_path)?;
    Ok(report)
}

/// What opening a vault put back (M60.6): the pages of batches an earlier
/// process left unfinished, the ones restored as they were, and the ones
/// left alone because they changed since. All zero on an ordinary open.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize)]
pub struct OpenReport {
    pub unfinished: usize,
    pub restored: usize,
    pub kept: usize,
}

/// The instant this process started (M49.9) — the line between attended
/// rows this process may still finish and rows a dead one left behind.
/// Pinned at the top of `run`, before anything can spawn a run.
fn process_started() -> chrono::DateTime<chrono::Utc> {
    static STARTED: std::sync::OnceLock<chrono::DateTime<chrono::Utc>> = std::sync::OnceLock::new();
    *STARTED.get_or_init(chrono::Utc::now)
}

/// `process_started` in `runtime::now_utc`'s spelling, so it compares with
/// the runtime database's stored times (M57.4c's sweep).
fn process_started_at() -> String {
    process_started().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // M53.24: first, so every line and panic from here on is kept; lines
    // wait in memory until `RunEvent::Ready` opens the file.
    diagnostics::init();
    let _ = process_started();
    tauri::Builder::default()
        .register_asynchronous_uri_scheme_protocol("cerebro-file", files::scheme::handle)
        .plugin(tauri_plugin_dialog::init())
        .manage(WatcherState::default())
        .manage(forge::PrReader::default())
        .manage(agent::AgentState::default())
        .manage(mcp::McpState::default())
        .manage(ingest::ambient::AmbientState::default())
        // M55.10: ⌘Q is Cerebro's own menu item, and it and the close guard
        // ask the webview to save before the app exits.
        .manage(shell::quit::QuitState::default())
        .manage(shell::deep_link::DeepLinkInbox::default())
        .menu(shell::quit::app_menu)
        .on_menu_event(shell::quit::on_menu_event)
        // M53.12: tauri.conf.json declares the window `create: false`, so it
        // is built here, with the link guard tauri's own path never attaches.
        .setup(|app| shell::build_main_window(app))
        .invoke_handler(tauri::generate_handler![
            mail_dismissals_read,
            mail_dismiss,
            mail_undismiss,
            mail_gate_read,
            sheet::calculate_sheets,
            sheet::sheet_restructure,
            pick_sheet_file,
            sheet::sheet_fill,
            sheet::sheet_complete,
            roots_commands::probe_file,
            roots_commands::file_thumbnail,
            roots_commands::read_file_bytes,
            roots_commands::open_file_outside,
            roots_commands::reveal_file,
            roots_commands::quick_look_file,
            roots_commands::save_file_copy,
            client_access::client_tokens,
            client_access::create_client_token,
            client_access::revoke_client_token,
            client_access::listener::client_access_status,
            client_access::listener::set_client_access,
            notification_permission,
            request_notification_permission,
            post_notification,
            pick_vault,
            open_demo_vault,
            get_last_vault,
            panel_agent,
            set_panel_agent,
            scan_vault,
            read_note,
            read_note_source,
            read_canvas_file,
            save_canvas_file,
            create_canvas_file,
            search_vault,
            save_note,
            update_frontmatter,
            verify_concept,
            capture_concept_edit,
            resolve_reconciliation,
            review_queue,
            revertable_applications,
            decide_proposal,
            revert_application,
            pipeline_overview,
            fleet_runs,
            fleet_subject_runs,
            fleet_run_detail,
            fleet_run_transcript,
            run_knowledge_writes,
            page_attribution,
            commit_runs,
            vault_activity,
            page_activity,
            fleet_actor_summary,
            fleet_actor_summaries,
            job_ledger_read,
            reminder_state,
            reminder_claim,
            reminder_import,
            done_marks_read,
            done_mark,
            done_unmark,
            done_marks_import,
            job_ledger_claim,
            job_ledger_unclaim,
            job_ledger_stamp,
            job_ledger_import,
            set_global_pause,
            set_agent_paused,
            paused_agents,
            admit_wakes,
            release_assigned_wakes,
            wakes_pending,
            cancel_wakes,
            fleet_wakes,
            list_followups,
            claim_followup,
            cancel_followup,
            set_ambient_concurrency,
            set_lane_enabled,
            trigger_status,
            trigger_run,
            trigger_declare_r7_scope,
            trigger_r7_scope,
            trigger_record_pack,
            ambient_ingest_enabled,
            set_ambient_ingest,
            ingest_item_state,
            ask_question,
            converge,
            home_runs,
            home_changes,
            belief_chips,
            attention_lanes,
            resolve_held_items,
            create_note,
            set_note_title,
            list_views,
            save_view,
            list_collections,
            save_collection,
            save_list,
            create_folder,
            rename_note,
            delete_note,
            list_trash,
            restore_from_trash,
            apply_batch,
            starter_marker,
            install_starter_kit,
            decline_starter_kit,
            list_comments,
            start_comment_thread,
            reply_to_comment_thread,
            set_comment_thread_resolved,
            delete_comment,
            delete_comment_thread,
            start_thread_turn,
            list_folders,
            pick_files,
            import_attachment,
            import_attachment_bytes,
            inspect_dropped,
            read_dropped_text,
            extract_document,
            write_text_file,
            export_png,
            export_svg,
            export_csv,
            export_sheet_xlsx,
            ledger_head,
            ledger_status,
            start_watcher,
            read_connectors,
            save_connectors,
            connector_status,
            check_agent,
            check_wake,
            agent_workspace,
            purge_agent_workspace,
            read_cli_transcript,
            run_agent,
            stop_agent,
            agent_events_since,
            stop_all_agents,
            answer_interaction,
            cancel_interaction,
            list_interactions,
            pending_writes,
            decide_pending_write,
            claude_user_settings,
            diagnostics::log_frontend,
            forge_commands::pull_request_state,
            // M9.4 — git tracking. Every command resolves the workspace
            // first, so a vault nested in a larger repo scopes correctly.
            git_commands::git_workspace_info,
            git_commands::is_git_repo,
            git_commands::init_git_repo,
            git_commands::git_author_identity,
            git_commands::get_modified_files,
            git_commands::git_discard_file,
            git_commands::get_file_history,
            git_commands::get_file_diff,
            git_commands::get_file_diff_at_commit,
            git_commands::get_file_at_commit,
            git_commands::restore_note_version,
            git_commands::get_file_patch,
            git_commands::get_commit_diff,
            git_commands::get_vault_pulse,
            git_commands::get_last_commit_info,
            git_commands::git_commit,
            git_commands::git_has_pending_changes,
            git_commands::git_file_url,
            git_commands::git_remote_status,
            git_commands::git_pull,
            git_commands::git_push,
            git_commands::git_add_remote,
            git_commands::git_disconnect_remote,
            git_commands::git_clone,
            git_commands::get_conflict_files,
            git_commands::get_conflict_mode,
            git_commands::git_resolve_conflict,
            git_commands::git_commit_conflict_resolution,
            git_commands::git_abort_conflict,
            git_commands::git_provider_status,
            roots_commands::list_roots,
            roots_commands::mount_root,
            roots_commands::unmount_root,
            roots_commands::list_dir,
            roots_commands::read_file_text,
            roots_git_commands::root_git_workspace_info,
            roots_git_commands::root_git_remote_status,
            roots_git_commands::root_git_modified_files,
            roots_git_commands::root_git_pulse,
            roots_git_commands::root_git_file_url,
            roots_git_commands::root_git_fetch,
            roots_git_commands::root_git_pull_ff,
            // M55.9 — Open with: Finder, the default app, agent links and
            // the clipboard. Each target is a vault note or an artifact base.
            shell::deep_link::take_deep_link,
            shell::deep_link::app_link,
            shell::open::reveal_in_finder,
            shell::open::open_in_default_app,
            shell::open::open_agent_link,
            shell::open::write_clipboard,
            // M55.10 — the webview's answer to a quit request.
            shell::quit::finish_quit,
            shell::quit::cancel_quit
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| match event {
            // M53.24: tauri raises Ready right after `setup` (tauri-2.12.4
            // app.rs:1442-1447), so the log opens here and lib.rs keeps one
            // `.setup()`: a second would replace the window builder's.
            tauri::RunEvent::Ready => diagnostics::arm(app),
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Opened { urls } => shell::deep_link::received(app, &urls),
            tauri::RunEvent::Exit => {
                use tauri::Manager;
                // M53.10: quitting ends runs and personal-token sessions.
                // Subprocesses get TERM, the grace, KILL —
                // admits no new one, and gives the readers a moment to book
                // theirs `cancelled`. About three seconds at most.
                app.state::<agent::AgentState>().shut_down();
                client_access::shut_down();
                shell::open::stop_quick_look();
                // M49.9: a clean exit closes the session exactly; anything
                // else leaves its last heartbeat as the honest lower bound.
                runtime::sessions::close_current();
            }
            _ => {}
        });
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_deferral_answers_its_reasons_and_their_words() {
        let mut codes: Vec<String> = runtime::budget::GateReason::ALL
            .iter()
            .map(|r| r.as_str().to_string())
            .collect();
        codes.extend([
            "agent_running".into(),
            "nothing_to_claim".into(),
            "future_reason".into(),
        ]);
        let output = serde_json::to_value(RunStart::deferred(codes.clone())).unwrap();
        assert_eq!(output["deferred"], serde_json::json!(codes));
        let mut words: Vec<&str> = runtime::budget::GateReason::ALL
            .iter()
            .map(|r| r.words())
            .collect();
        words.extend([
            "this agent is already running",
            "the dispatcher found nothing to start",
            "future_reason",
        ]);
        assert_eq!(output["words"], serde_json::json!(words));
    }

    use super::*;

    #[test]
    fn a_failed_hop_token_after_claim_closes_its_wake_and_releases_the_lease() {
        let _lock = runtime::status::test_lock();
        runtime::status::clear();
        let dir = vault::testutil::temp_vault("hop-start-failure");
        let conn = runtime::open(&dir).unwrap();
        let vault_id = runtime::scope::register(&conn, &dir).unwrap();
        let now = chrono::Utc::now();
        runtime::budget::append_version(
            &conn,
            &runtime::budget::Settings {
                ceilings: runtime::budget::shipped_defaults().unwrap(),
                timezone_id: "UTC".into(),
            },
            now,
        )
        .unwrap();
        let offered = runtime::wakes::WakeOffer {
            agent: "process:scout".into(),
            wake_key: "a".repeat(64),
            trigger: "b".repeat(16),
            path: "tasks/a.md".into(),
            hash: "c".repeat(64),
            event: "changed".into(),
            cause: runtime::cause::CauseRequest {
                kind: "event".into(),
                subject: Some("tasks/a.md".into()),
                detail: None,
                due_at: None,
            },
        };
        runtime::wakes::admit(&conn, &vault_id, &[offered], now).unwrap();
        let wake: String = conn
            .query_row("SELECT wake_id FROM agent_wakes", [], |row| row.get(0))
            .unwrap();
        let started = runtime::dispatch::claim_woken(
            &conn,
            &vault_id,
            "store",
            "agent",
            runtime::budget::Reservation {
                total_tokens: 5_000,
                output_tokens: 1_000,
            },
            "process:scout",
            &runtime::wakes::WakeRequest {
                claim: wake,
                coalesce: vec![],
            },
            now,
        )
        .unwrap();
        let runtime::dispatch::Woken::Started { lease, .. } = started else {
            panic!("expected a claim: {started:?}")
        };
        let token = mcp::McpState::default().hop_token(
            Some("process:scout"),
            None,
            None,
            None,
            lease.run_id.clone(),
            &dir,
            mcp::WriteAsks::of(&panel_style_request()),
            &["process:scout".into()],
        );
        assert!(token.is_err());
        assert!(finish_unspawned_lease(&dir, Some(&lease.run_id), token).is_err());
        assert_eq!(
            conn.query_row("SELECT count(*) FROM ambient_dispatch", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            conn.query_row("SELECT outcome FROM agent_wakes", [], |row| row
                .get::<_, String>(0))
                .unwrap(),
            "failed"
        );
        assert_eq!(
            conn.query_row(
                "SELECT usage_state FROM runs WHERE run_id = ?1",
                [&lease.run_id],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
            "exact"
        );
        assert_eq!(conn.query_row("SELECT input_tokens + output_tokens + cache_read + cache_write FROM runs WHERE run_id = ?1", [&lease.run_id], |row| row.get::<_, i64>(0)).unwrap(), 0);
        drop(conn);
        runtime::status::clear();
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A request shaped like the panel's — the same construction the agent
    /// module's own tests use, since `AgentRequest` derives no Default.
    fn panel_style_request() -> agent::AgentRequest {
        agent::AgentRequest {
            message: "hi".into(),
            system_prompt: None,
            session_id: None,
            model: None,
            shell: None,
            web: None,
            connectors: None,
            connector_names: None,
            attended: None,
            ask_first: None,
            mcp_url: None,
            mcp_token: None,
            actor: None,
            approved_stdio: None,
            scope: None,
            read_scope: None,
            allowed_tools: None,
            disallowed_tools: None,
            lane: None,
            cause: None,
            effort: None,
            internal: false,
        }
    }

    /// M57.4c: a database with one decided write of release-scout's in
    /// `vault`, and the request its next scheduled run makes.
    fn decided_write(label: &str) -> (std::path::PathBuf, std::path::PathBuf, agent::AgentRequest) {
        let config = vault::testutil::temp_vault(&format!("{label}-config"));
        let vault = vault::testutil::temp_vault(label);
        runtime::sink::arm(&config).unwrap();
        runtime::sink::with_sink(|conn| {
            let vault_id = runtime::scope::register(conn, &vault).unwrap();
            let input = serde_json::json!({ "folder": "records/risks", "slug": "vendor-delay" });
            let queued = runtime::pending_writes::queue(
                conn,
                &runtime::pending_writes::Queue {
                    vault_id: &vault_id,
                    run_id: "run-0",
                    actor: "process:release-scout",
                    tool: "create_note",
                    target: "records/risks/vendor-delay.md",
                    target_hash: None,
                    input: &input,
                    grant: &serde_json::json!({}),
                    limits: policy::tool_approval::queue_limits(),
                },
            )
            .unwrap();
            runtime::pending_writes::reject(conn, &vault_id, &queued.id, "not yet", "human:me")
                .unwrap();
        })
        .unwrap();
        let mut request = panel_style_request();
        request.actor = Some("process:release-scout".into());
        request.attended = Some(false);
        (config, vault, request)
    }

    #[test]
    fn vault_activity_refuses_a_malformed_window() {
        let config = vault::testutil::temp_vault("lib-activity-config");
        let vault = vault::testutil::temp_vault("lib-activity");
        let got = vault_activity_in(&config, &vault, "yesterday", "2026-07-29T00:00:00Z");
        assert_eq!(
            got.err().as_deref(),
            Some("yesterday is not an RFC 3339 instant.")
        );
        let backwards = vault_activity_in(
            &config,
            &vault,
            "2026-07-29T00:00:00Z",
            "2026-07-28T00:00:00Z",
        );
        assert_eq!(
            backwards.err().as_deref(),
            Some(runtime::activity::BACKWARDS)
        );
        // A good window over no runtime database says History could not be
        // read, never an empty year.
        let missing = vault_activity_in(
            &config,
            &vault,
            "2026-07-28T00:00:00Z",
            "2026-07-29T00:00:00Z",
        );
        let refused = missing.err().unwrap_or_default();
        assert!(
            refused.starts_with("History could not be read: "),
            "{refused}"
        );
        let conn = runtime::open(&config).unwrap();
        runtime::scope::register(&conn, &vault).unwrap();
        let read = vault_activity_in(
            &config,
            &vault,
            "2026-07-28T00:00:00Z",
            "2026-07-29T00:00:00Z",
        )
        .unwrap();
        assert!(matches!(
            read.recording_since,
            runtime::activity::Since::Read { at: None }
        ));
        drop(conn);
        for dir in [&vault, &config] {
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    /// One `vault_writes` row for the page-activity tests (M64.2b).
    fn page_row<'a>(
        kind: &'a str,
        path: &'a str,
        to: Option<&'a str>,
        actor: &'a str,
        run_id: Option<&'a str>,
    ) -> runtime::vault_writes::WriteRow<'a> {
        runtime::vault_writes::WriteRow {
            kind,
            path,
            to,
            content_hash: None,
            actor: Some(actor),
            run_id,
            approved_by: None,
        }
    }

    #[test]
    fn page_activity_refuses_a_path_outside_the_vault() {
        let config = vault::testutil::temp_vault("lib-page-activity-config");
        let vault = vault::testutil::temp_vault("lib-page-activity");
        let outside = config.join("outside.md");
        std::fs::write(&outside, "# A\n").unwrap();
        for path in ["../outside.md", outside.to_str().unwrap()] {
            assert_eq!(
                page_activity_in(&config, &vault, path, chrono::Utc::now())
                    .err()
                    .as_deref(),
                Some(page_outside_vault(path).as_str()),
                "{path} is no page of this vault"
            );
        }
        assert_eq!(
            page_outside_vault("../outside.md"),
            "../outside.md is outside this vault, so it has no history here."
        );
        // No runtime database: every runtime lane says so, never empty.
        let read = page_activity_in(&config, &vault, "notes/a.md", chrono::Utc::now()).unwrap();
        assert!(matches!(
            read.writes,
            runtime::activity::Lane::Unavailable { .. }
        ));
        assert!(matches!(
            read.recording_since,
            runtime::activity::Since::Unavailable { .. }
        ));
        for dir in [&vault, &config] {
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    #[test]
    fn a_renamed_page_reads_rows_under_its_old_name() {
        let config = vault::testutil::temp_vault("lib-page-rename-config");
        let vault = vault::testutil::temp_vault("lib-page-rename");
        let conn = runtime::open(&config).unwrap();
        let vault_id = runtime::scope::register(&conn, &vault).unwrap();
        let at = |minute: i64| {
            chrono::DateTime::parse_from_rfc3339("2026-07-27T14:00:00Z")
                .unwrap()
                .with_timezone(&chrono::Utc)
                + chrono::Duration::minutes(minute)
        };
        let me = vault::receipt::HUMAN_ACTOR;
        let rows = [
            page_row("vault.create", "notes/a.md", None, me, None),
            page_row(
                "vault.write",
                "notes/a.md",
                None,
                "process:release-scout",
                Some("run-1"),
            ),
            page_row(
                "vault.comment",
                ".comments/notes/a.md.json",
                None,
                "human:owner",
                None,
            ),
            page_row("vault.rename", "notes/a.md", Some("notes/b.md"), me, None),
            page_row("vault.write", "notes/b.md", None, me, None),
            page_row("vault.write", "notes/other.md", None, me, None),
        ];
        for (minute, row) in rows.iter().enumerate() {
            runtime::vault_writes::record_at(&conn, &vault_id, row, at(minute as i64 * 10))
                .unwrap();
        }
        let read = page_activity_in(&config, &vault, "notes/b.md", at(120)).unwrap();
        assert_eq!(read.chain, vec!["notes/b.md", "notes/a.md"]);
        let runtime::activity::Lane::Read { rows, more } = &read.writes else {
            panic!("the writes lane reads");
        };
        assert!(!more);
        let seen: Vec<(&str, &str)> = rows
            .iter()
            .map(|w| (w.kind.as_str(), w.path.as_str()))
            .collect();
        assert_eq!(
            seen,
            vec![
                ("vault.write", "notes/b.md"),
                ("vault.rename", "notes/a.md"),
                ("vault.comment", ".comments/notes/a.md.json"),
                ("vault.write", "notes/a.md"),
                ("vault.create", "notes/a.md"),
            ],
            "the old name's rows and its comments, never another page's"
        );
        // The run that wrote it under its old name is the page's run too. No
        // `runs` row was recorded for it, so the lane reads, and is empty.
        assert!(matches!(
            &read.runs,
            runtime::activity::Lane::Read { rows, .. } if rows.is_empty()
        ));
        assert!(matches!(
            &read.recording_since,
            runtime::activity::Since::Read { at: Some(_) }
        ));
        drop(conn);
        for dir in [&vault, &config] {
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    #[test]
    fn a_page_outside_the_bundle_has_no_knowledge_lane() {
        let config = vault::testutil::temp_vault("lib-page-lane-config");
        let vault = vault::testutil::temp_vault("lib-page-lane");
        let page = page_activity_in(&config, &vault, "notes/a.md", chrono::Utc::now()).unwrap();
        assert!(page.knowledge.is_none());
        let wire = serde_json::to_value(&page).unwrap();
        assert_eq!(wire["knowledge"], serde_json::Value::Null);
        // A concept in a vault that keeps no ledger: not recorded, never empty.
        let concept = page_activity_in(
            &config,
            &vault,
            "knowledge/systems/x.md",
            chrono::Utc::now(),
        )
        .unwrap();
        assert!(matches!(
            concept.knowledge,
            Some(KnowledgeLane::NotRecorded)
        ));
        let wire = serde_json::to_value(&concept).unwrap();
        assert_eq!(
            wire["knowledge"],
            serde_json::json!({ "state": "not_recorded" })
        );
        for dir in [&vault, &config] {
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    #[test]
    fn page_attribution_refuses_a_path_outside_the_vault() {
        let config = vault::testutil::temp_vault("lib-attribution-config");
        let vault = vault::testutil::temp_vault("lib-attribution");
        std::fs::create_dir_all(vault.join("notes")).unwrap();
        std::fs::write(vault.join("notes/a.md"), "# A\n").unwrap();
        let conn = runtime::open(&config).unwrap();
        let vault_id = runtime::scope::register(&conn, &vault).unwrap();
        let hash = ledger::sha256_hex(b"# A\n");
        runtime::vault_writes::record_at(
            &conn,
            &vault_id,
            &runtime::vault_writes::WriteRow {
                kind: "vault.write",
                path: "notes/a.md",
                to: None,
                content_hash: Some(&hash),
                actor: Some(vault::receipt::HUMAN_ACTOR),
                run_id: None,
                approved_by: None,
            },
            chrono::Utc::now(),
        )
        .unwrap();
        let outside = config.join("outside.md");
        std::fs::write(&outside, "# A\n").unwrap();
        for path in ["../outside.md", outside.to_str().unwrap()] {
            assert_eq!(
                page_attribution_in(&config, &vault, path).unwrap(),
                runtime::write_log::Attribution::NotRecorded,
                "{path} is no page of this vault"
            );
        }
        // The same command reads an inside page, under its landing spelling.
        let runtime::write_log::Attribution::Recorded(last) =
            page_attribution_in(&config, &vault, "./notes/a.md").unwrap()
        else {
            panic!("an editor save is recorded");
        };
        assert_eq!(last.actor.as_deref(), Some(vault::receipt::HUMAN_ACTOR));
        std::fs::write(vault.join("notes/a.md"), "# Changed elsewhere\n").unwrap();
        assert!(matches!(
            page_attribution_in(&config, &vault, "notes/a.md").unwrap(),
            runtime::write_log::Attribution::Unattributed(_)
        ));
        drop(conn);
        let _ = std::fs::remove_dir_all(&config);
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn the_next_run_hears_its_decided_writes_once() {
        let _lock = runtime::sink::test_lock();
        let (config, vault, request) = decided_write("lib-outcomes-once");
        let (first, told) = with_outcomes("Do the sweep.", &request, &vault);
        assert!(first.starts_with("WHAT HAPPENED TO WRITES YOU QUEUED FOR REVIEW:\n"));
        assert!(
            first.contains("rejected by the person: \"not yet\"."),
            "{first}"
        );
        assert!(first.ends_with("\n\nDo the sweep."));
        assert_eq!(told.len(), 1);
        // It follows the WHY block, as the run's message is built.
        let built = runtime::cause::with_preamble(&first, None, chrono::Utc::now());
        assert!(built.starts_with(runtime::cause::NOBODY_WATCHING_PREAMBLE));
        assert!(built.contains("assumed.\n\nWHAT HAPPENED TO WRITES"));
        report_outcomes(&told, "run-1");
        let (second, told) = with_outcomes("Do the sweep.", &request, &vault);
        assert_eq!(second, "Do the sweep.", "told once");
        assert!(told.is_empty());
        runtime::sink::disarm();
        let _ = std::fs::remove_dir_all(&vault);
        let _ = std::fs::remove_dir_all(&config);
    }

    #[test]
    fn a_run_with_nothing_decided_keeps_its_message() {
        let _lock = runtime::sink::test_lock();
        let (config, vault, mut request) = decided_write("lib-outcomes-none");
        request.actor = Some("process:librarian".into());
        let message = "Line one.\n\n  Line two, spaced.  ";
        assert_eq!(
            with_outcomes(message, &request, &vault),
            (message.to_string(), Vec::new()),
            "byte-identical"
        );
        runtime::sink::disarm();
        assert_eq!(
            with_outcomes(message, &request, &vault).0,
            message,
            "and with no runtime database"
        );
        let _ = std::fs::remove_dir_all(&vault);
        let _ = std::fs::remove_dir_all(&config);
    }

    #[test]
    fn attended_turns_carry_no_outcome_block() {
        let _lock = runtime::sink::test_lock();
        let (config, vault, mut request) = decided_write("lib-outcomes-attended");
        request.attended = Some(true);
        assert_eq!(with_outcomes("hi", &request, &vault).0, "hi");
        // Nor do Cerebro's own constructs.
        request.attended = Some(false);
        request.internal = true;
        assert_eq!(with_outcomes("hi", &request, &vault).0, "hi");
        // The decided write still waits to be told to a run that can hear it.
        request.internal = false;
        assert!(with_outcomes("hi", &request, &vault).0.contains("not yet"));
        runtime::sink::disarm();
        let _ = std::fs::remove_dir_all(&vault);
        let _ = std::fs::remove_dir_all(&config);
    }

    #[test]
    fn grant_tools_passes_the_request_through_without_inventing_either_default() {
        let mut req = panel_style_request();
        assert_eq!(grant_tools(&req), None, "absent stays unrestricted");
        req.allowed_tools = Some(vec![]);
        assert_eq!(
            grant_tools(&req),
            Some(vec![]),
            "narrowed-to-nothing stays nothing"
        );
        req.allowed_tools = Some(vec!["get_note".into()]);
        assert_eq!(grant_tools(&req), Some(vec!["get_note".into()]));
    }

    /// PLATFORM-API-1, the human half: these commands share the note writers
    /// the agent's MCP doors use, so they were just as path-unbounded — and
    /// now refuse the same targets, through the same mechanism.
    #[test]
    fn the_ipc_note_commands_refuse_what_is_not_a_note() {
        // The bundle under a spelling APFS folds onto it: past the capture
        // valve, a plain write would land on a concept. The commands'
        // knowledge check hears it as the bundle (M53.28), so each refuses it
        // as read-only, where the others are refused as not notes.
        const KELVIN: &str = "\u{212a}nowledge/metrics/churn.md";
        let dir = vault::testutil::temp_vault("ipc-note-targets");
        let seeded = [
            (".git/config", "[core]\n\tbare = false\n"),
            (".cerebro/connectors.json", "{\"mcpServers\":{}}\n"),
            (".claude/settings.json", "{\"permissions\":{}}\n"),
            ("views/x.yml", "name: X\n"),
            ("boards/plan.canvas", "{\"nodes\":[]}\n"),
            ("data/table.csv", "a,b\n"),
            (KELVIN, "---\ntype: Metric\n---\n\n# Churn\n"),
        ];
        for (rel, bytes) in seeded {
            vault::testutil::write(&dir, rel, bytes);
        }
        let snapshot = || -> std::collections::BTreeMap<std::path::PathBuf, Vec<u8>> {
            walkdir::WalkDir::new(&dir)
                .into_iter()
                .filter_map(Result::ok)
                .filter(|e| e.file_type().is_file())
                .map(|e| (e.path().to_path_buf(), std::fs::read(e.path()).unwrap()))
                .collect()
        };
        let before = snapshot();
        let v = dir.to_string_lossy().to_string();
        let mut patch = serde_json::Map::new();
        patch.insert(
            "core".into(),
            serde_json::json!({ "fsmonitor": "touch /tmp/pwned" }),
        );

        let targets = seeded.iter().map(|(rel, _)| *rel).chain([
            ".GIT/config",
            "Views/x.yml",
            "data/TABLE.CSV",
        ]);
        for target in targets {
            let named = if target == KELVIN {
                "read-only"
            } else {
                target
            };
            let saved = save_note(v.clone(), target.into(), "pwned\n".into(), None).unwrap_err();
            assert!(saved.contains(named), "{target}: {saved}");
            let patched = update_frontmatter(v.clone(), target.into(), patch.clone()).unwrap_err();
            assert!(patched.contains(named), "{target}: {patched}");
            let titled = set_note_title(v.clone(), target.into(), "Pwned".into()).unwrap_err();
            assert!(titled.contains(named), "{target}: {titled}");
        }
        for folder in [".git/hooks", ".cerebro"] {
            let created = create_note(
                v.clone(),
                folder.into(),
                "pre-commit".into(),
                serde_json::Map::new(),
                "#!/bin/sh\n".into(),
            );
            assert!(created.unwrap_err().starts_with("not a note"));
        }
        assert_eq!(snapshot(), before, "every byte where it was, nothing new");

        // An ordinary note still lands through every one of them.
        let rel = create_note(
            v.clone(),
            "records".into(),
            "x".into(),
            serde_json::Map::new(),
            "# X\n".into(),
        )
        .unwrap();
        assert_eq!(rel, "records/x.md");
        save_note(v.clone(), rel.clone(), "\n# X\n\nSaved.\n".into(), None).unwrap();
        let mut status = serde_json::Map::new();
        status.insert("status".into(), serde_json::json!("done"));
        update_frontmatter(v.clone(), rel.clone(), status).unwrap();
        set_note_title(v.clone(), rel.clone(), "Titled".into()).unwrap();
        let landed = std::fs::read_to_string(dir.join(&rel)).unwrap();
        assert!(
            landed.contains("status: done") && landed.contains("# Titled"),
            "{landed}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// M70.2: a comment writes no page byte, so the comment commands run no
    /// knowledge guard, and a concept page takes comments like any page.
    #[test]
    fn the_comment_commands_take_a_concept_page() {
        let dir = vault::testutil::temp_vault("ipc-concept-comments");
        let concept = "knowledge/systems/status-model.md";
        let bytes = "---\ntype: System\n---\n\n# Status model\n";
        vault::testutil::write(&dir, concept, bytes);
        let v = dir.to_string_lossy().to_string();
        let file =
            start_comment_thread(v.clone(), concept.into(), None, "Still true?".into()).unwrap();
        let thread = file.threads[0].id().to_string();
        assert_eq!(file.threads[0].comments[0].author, vault::comments::OWNER);
        reply_to_comment_thread(v.clone(), concept.into(), thread.clone(), "Yes.".into()).unwrap();
        set_comment_thread_resolved(v.clone(), concept.into(), thread.clone(), true).unwrap();
        delete_comment_thread(v.clone(), concept.into(), thread).unwrap();
        assert_eq!(list_comments(v, concept.into()).unwrap().threads.len(), 1);
        assert_eq!(std::fs::read_to_string(dir.join(concept)).unwrap(), bytes);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// M53.28: these five check the bundle's name and then reach `safe_join`,
    /// which judges no note target. While the check folded ASCII alone, the
    /// spelling APFS folds onto `knowledge/` walked through all five, and
    /// `delete_note` could send a concept to the trash.
    #[test]
    fn the_bundle_doors_refuse_the_spelling_apfs_folds_onto_knowledge() {
        let dir = vault::testutil::temp_vault("ipc-bundle-doors");
        let kelvin = "\u{212a}nowledge";
        let concept = format!("{kelvin}/metrics/churn.md");
        vault::testutil::write(&dir, &concept, "---\ntype: Metric\n---\n\n# Churn\n");
        vault::testutil::write(&dir, "records/x.md", "# X\n");
        // Folders as well as bytes: two of the doors only make a folder.
        let snapshot = || -> std::collections::BTreeMap<std::path::PathBuf, Option<Vec<u8>>> {
            walkdir::WalkDir::new(&dir)
                .into_iter()
                .filter_map(Result::ok)
                .map(|e| {
                    let bytes = e
                        .file_type()
                        .is_file()
                        .then(|| std::fs::read(e.path()).unwrap());
                    (e.path().to_path_buf(), bytes)
                })
                .collect()
        };
        let before = snapshot();
        let v = dir.to_string_lossy().to_string();
        let doors = [
            (
                "rename_note out",
                rename_note(v.clone(), concept.clone(), "records/stolen.md".into()),
            ),
            (
                "rename_note in",
                rename_note(v.clone(), "records/x.md".into(), format!("{kelvin}/x.md")),
            ),
            (
                "delete_note",
                delete_note(v.clone(), concept.clone()).map(drop),
            ),
            (
                "delete_note, the folder",
                delete_note(v.clone(), kelvin.into()).map(drop),
            ),
            (
                "create_folder",
                create_folder(v.clone(), format!("{kelvin}/new")),
            ),
            (
                "save_collection",
                save_collection(v.clone(), kelvin.into(), "name: Knowledge\n".into()),
            ),
            (
                "save_list",
                save_list(
                    v.clone(),
                    format!("{kelvin}/metrics"),
                    "churn".into(),
                    "name: Churn\n".into(),
                ),
            ),
        ];
        for (door, outcome) in doors {
            let err = outcome.expect_err(door);
            assert!(err.contains("read-only"), "{door}: {err}");
        }
        assert_eq!(snapshot(), before, "every byte and folder where it was");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// This vault's rows in `vault_writes`: kind, path, to, actor, run.
    type DoorRow = (
        String,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
    );

    fn door_rows(dir: &std::path::Path) -> Vec<DoorRow> {
        let vault_id = runtime::scope::derive_vault_id(dir);
        runtime::sink::with_sink(|conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT kind, path, to_path, actor, run_id FROM vault_writes \
                     WHERE vault_id = ?1 ORDER BY rowid",
                )
                .unwrap();
            stmt.query_map([&vault_id], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
        })
        .unwrap()
    }

    /// One IPC door of src-tauri/fixtures/write-doors.json, called the way the
    /// webview calls it.
    fn call_door(
        door: &str,
        v: &str,
        args: &serde_json::Value,
        source: &std::path::Path,
    ) -> Result<(), String> {
        let text = |key: &str| args[key].as_str().unwrap_or_default().to_string();
        let map = |key: &str| args[key].as_object().cloned().unwrap_or_default();
        let v = v.to_string();
        match door {
            "save_canvas_file" => save_canvas_file(v, text("path"), text("content"))
                .map(drop)
                .map_err(|error| error.message),
            "create_canvas_file" => create_canvas_file(
                v,
                text("path"),
                text("content"),
                if text("mode") == "preview" {
                    CanvasWriteMode::Preview
                } else {
                    CanvasWriteMode::Commit
                },
            )
            .map(drop)
            .map_err(|error| error.message),
            "save_note" => save_note(
                v,
                text("path"),
                text("body"),
                args["expect_hash"].as_str().map(str::to_string),
            )
            .map(drop),
            "update_frontmatter" => update_frontmatter(v, text("path"), map("patch")).map(drop),
            "set_note_title" => set_note_title(v, text("path"), text("title")),
            "create_note" => create_note(
                v,
                text("folder"),
                text("slug"),
                map("frontmatter"),
                text("body"),
            )
            .map(drop),
            "save_view" => save_view(
                v,
                text("id"),
                text("yaml"),
                args["folder"].as_str().map(str::to_string),
            ),
            "save_collection" => save_collection(v, text("folder"), text("yaml")),
            "save_list" => save_list(v, text("folder"), text("id"), text("yaml")),
            "create_folder" => create_folder(v, text("path")),
            "rename_note" => rename_note(v, text("from"), text("to")),
            "delete_note" => delete_note(v, text("path")).map(drop),
            "restore_from_trash" => restore_from_trash(v, text("stamp")).map(drop),
            "apply_batch" => {
                apply_batch(v, args["ops"].as_array().cloned().unwrap_or_default()).map(drop)
            }
            "install_starter_kit" => install_starter_kit(v).map(drop),
            "write_text_file" => write_text_file(v, text("path"), text("content")).map(drop),
            "import_attachment" => {
                let named = text("source").replace("/SOURCE/", "");
                import_attachment(v, source.join(named).to_string_lossy().to_string()).map(drop)
            }
            "import_attachment_bytes" => {
                import_attachment_bytes(v, text("name"), text("bytes_base64")).map(drop)
            }
            "verify_concept" => {
                verify_concept(v, text("path"), map("patch"), text("viewed_body_hash"))
            }
            "capture_concept_edit" => capture_concept_edit(v, args["request"].clone()),
            // M58.4: no runtime database, so a page no run wrote.
            "restore_note_version" => {
                git_commands::restore_note_version_in(&v, &text("path"), &text("commit"), None)
                    .map(drop)
            }
            other => panic!("no IPC door called {other}"),
        }
    }

    // M58.1 (CV-33): each IPC door refuses what the shared table says it
    // refuses, in its words, or records exactly its one row, stamped human:me
    // with no run. The mock replays the same table.
    #[test]
    fn write_doors_replay_the_shared_cases() {
        let table: serde_json::Value =
            serde_json::from_str(include_str!("../fixtures/write-doors.json")).unwrap();
        let human = table["human_actor"].as_str().unwrap();
        assert_eq!(human, vault::receipt::HUMAN_ACTOR);
        let _sink = runtime::sink::test_lock();
        let config = vault::testutil::temp_vault("write-doors-config");
        runtime::sink::arm(&config).unwrap();
        let source = vault::testutil::temp_vault("write-doors-source");
        std::fs::write(source.join("door-case.pdf"), b"%PDF-1.4").unwrap();
        for case in table["ipc"].as_array().unwrap() {
            let dir = vault::testutil::temp_vault("write-doors");
            for (rel, bytes) in case["seed"].as_object().into_iter().flatten() {
                vault::testutil::write(&dir, rel, bytes.as_str().unwrap());
            }
            let door = case["door"].as_str().unwrap();
            let outcome = call_door(door, &dir.to_string_lossy(), &case["args"], &source);
            match case["refused"].as_str() {
                Some(fragment) => {
                    let err = outcome.expect_err(&format!("{case} must refuse"));
                    assert!(err.contains(fragment), "{case}: {err}");
                    assert_eq!(
                        door_rows(&dir),
                        Vec::<DoorRow>::new(),
                        "{case}: a refusal records nothing"
                    );
                }
                None => {
                    outcome.unwrap_or_else(|e| panic!("{case} must land: {e}"));
                    let row_of = |row: &serde_json::Value| -> DoorRow {
                        (
                            row["kind"].as_str().unwrap().to_string(),
                            row["path"].as_str().unwrap().to_string(),
                            row["to"].as_str().map(str::to_string),
                            Some(human.to_string()),
                            None,
                        )
                    };
                    // M60.6: a batch names each row it records, in order.
                    let expected: Vec<DoorRow> = match &case["records"] {
                        serde_json::Value::Null => Vec::new(),
                        serde_json::Value::Array(rows) => rows.iter().map(row_of).collect(),
                        row => vec![row_of(row)],
                    };
                    assert_eq!(door_rows(&dir), expected, "{case}");
                }
            }
            let _ = std::fs::remove_dir_all(&dir);
        }
        runtime::sink::disarm();
        for dir in [&config, &source] {
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    // M60.6: a stale expectHash refuses the whole batch in the IPC's words,
    // and records one operational stale_content row under surface `batch`.
    #[test]
    fn a_stale_batch_records_one_operational_row() {
        let _sink = runtime::sink::test_lock();
        let config = vault::testutil::temp_vault("stale-batch-config");
        let dir = vault::testutil::temp_vault("stale-batch");
        runtime::sink::arm(&config).unwrap();
        vault::testutil::write(&dir, "records/a.md", "# A\n");
        vault::testutil::write(&dir, "records/b.md", "# B\n");
        let count = || {
            runtime::sink::with_sink(|conn| {
                conn.query_row(
                    "SELECT count(*) FROM operational_log WHERE surface = 'batch' \
                     AND code = 'stale_content'",
                    [],
                    |r| r.get::<_, i64>(0),
                )
                .unwrap()
            })
            .unwrap()
        };
        let before = count();
        let err = apply_batch(
            dir.to_string_lossy().to_string(),
            vec![
                serde_json::json!({ "op": "body", "path": "records/a.md", "body": "x\n" }),
                serde_json::json!({
                    "op": "body", "path": "records/b.md", "body": "y\n",
                    "expectHash": "0".repeat(64),
                }),
            ],
        )
        .unwrap_err();
        assert_eq!(err, vault::batch::stale_words("records/b.md"));
        assert_eq!(count(), before + 1);
        assert_eq!(
            std::fs::read_to_string(dir.join("records/a.md")).unwrap(),
            "# A\n"
        );
        runtime::sink::disarm();
        for d in [&dir, &config] {
            let _ = std::fs::remove_dir_all(d);
        }
    }

    // M60.8: a Trash manifest naming knowledge/ is guarded like any write
    // into the bundle, and the item stays in the Trash.
    #[test]
    fn restore_from_trash_refuses_a_knowledge_target() {
        let dir = vault::testutil::temp_vault("restore-trash-bundle");
        let stamp = "20261014T093000Z-a1b2";
        vault::testutil::write(
            &dir,
            &format!(".trash/{stamp}/knowledge/concepts/a.md"),
            "# A\n",
        );
        vault::testutil::write(
            &dir,
            &format!(".trash/{stamp}/.trashed.json"),
            "{\"format\":1,\"path\":\"knowledge/concepts/a.md\",\"kind\":\"file\",\
             \"title\":\"A\",\"deleted_at\":\"2026-10-14T09:30:00Z\"}",
        );
        let v = dir.to_string_lossy().to_string();
        let err = restore_from_trash(v.clone(), stamp.into()).unwrap_err();
        assert!(err.contains("read-only"), "{err}");
        assert!(!dir.join("knowledge").exists(), "nothing was restored");
        assert_eq!(list_trash(v).unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    // M58.1: save_view was the one write command with no bundle guard.
    #[test]
    fn save_view_refuses_the_bundle() {
        let dir = vault::testutil::temp_vault("save-view-bundle");
        let v = dir.to_string_lossy().to_string();
        let err = save_view(
            v.clone(),
            "x".into(),
            "name: X\n".into(),
            Some("knowledge".into()),
        )
        .unwrap_err();
        assert!(err.contains("read-only"), "{err}");
        assert!(!dir.join("knowledge").exists(), "nothing was written");
        save_view(v, "x".into(), "name: X\n".into(), Some("records".into())).unwrap();
        assert!(dir.join("records/views/x.yml").is_file());
        let _ = std::fs::remove_dir_all(&dir);
    }

    // M58.1: a Review decision that applies a set records the files it
    // projected as yours, whatever reviewer the webview names.
    #[test]
    fn a_review_decision_records_its_projections_as_you() {
        use policy::commit::tests_support::{seed_belief, submit, update_op, P1, RUN};
        let _sink = runtime::sink::test_lock();
        let config = vault::testutil::temp_vault("review-recorded-config");
        let dir = vault::testutil::temp_vault("review-recorded");
        let _shadow = ledger::shadow::testing::activated(&dir);
        runtime::sink::arm(&config).unwrap();
        ledger::shadow::with_writer(&dir, |writer| {
            let belief = seed_belief(writer, "seed");
            let state = ledger::concepts::current_state(writer, &dir).unwrap();
            let projection = ledger::reduce::project_belief(&state, &belief).unwrap();
            ledger::manifest::write_projection(&dir, "knowledge/seed.md", &projection).unwrap();
            submit(
                writer,
                P1,
                update_op(&belief, "x"),
                &belief,
                policy::table::Risk::High,
            );
            let table = policy::table::PolicyTable::load().unwrap();
            let queued =
                policy::commit::commit_proposals(&table, writer, &dir, RUN, &[P1.to_string()])
                    .unwrap();
            assert_eq!(
                queued.transition,
                policy::commit::TransitionCode::InitialQueue
            );
            assert!(queued.projected.is_empty(), "a queued set projects nothing");
        })
        .unwrap();
        let decided = decide_proposal(
            dir.to_string_lossy().to_string(),
            P1.to_string(),
            true,
            "human:someone-else".into(),
            None,
        )
        .unwrap();
        assert_eq!(decided.as_deref(), Some("apply"));
        assert_eq!(
            door_rows(&dir),
            vec![(
                "vault.write".to_string(),
                "knowledge/seed.md".to_string(),
                None,
                Some(vault::receipt::HUMAN_ACTOR.to_string()),
                None
            )]
        );
        runtime::sink::disarm();
        ledger::shadow::deactivate();
        for d in [&dir, &config] {
            let _ = std::fs::remove_dir_all(d);
        }
    }
    #[test]
    fn a_stale_save_records_one_operational_row() {
        let _sink = runtime::sink::test_lock();
        let config = vault::testutil::temp_vault("stale-save-config");
        let dir = vault::testutil::temp_vault("stale-save-command");
        runtime::sink::arm(&config).unwrap();
        vault::testutil::write(&dir, "notes/a.md", "# Outside\n");
        let error = save_note(
            dir.to_string_lossy().into(),
            "notes/a.md".into(),
            "# Stale\n".into(),
            Some("0".repeat(64)),
        )
        .unwrap_err();
        assert_eq!(
            error,
            "stale_content: notes/a.md changed since it was read, so nothing was saved."
        );
        let rows = runtime::sink::with_sink(|conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT code,surface,run_id FROM operational_log WHERE surface='save_note'",
                )
                .unwrap();
            stmt.query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<String>>(2)?,
                ))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
        })
        .unwrap();
        assert_eq!(
            rows,
            vec![("stale_content".into(), "save_note".into(), None)]
        );
        assert!(door_rows(&dir).is_empty());
        assert_eq!(
            std::fs::read_to_string(dir.join("notes/a.md")).unwrap(),
            "# Outside\n"
        );
        assert_eq!(
            save_note(
                dir.to_string_lossy().into(),
                "notes/a.md".into(),
                "# Bad\n".into(),
                Some("bad".into())
            )
            .unwrap_err(),
            "expectHash must be a 64-character hex hash"
        );
        let current = ledger::sha256_hex(b"# Outside\n");
        let hash = save_note(
            dir.to_string_lossy().into(),
            "notes/a.md".into(),
            "# Saved\n".into(),
            Some(current),
        )
        .unwrap();
        assert_eq!(hash, Some(ledger::sha256_hex(b"# Saved\n")));
        assert_eq!(door_rows(&dir).len(), 1);
        runtime::sink::disarm();
        for path in [&dir, &config] {
            let _ = std::fs::remove_dir_all(path);
        }
    }
    #[test]
    fn a_hashed_knowledge_save_compares_before_the_capture() {
        use policy::commit::tests_support::seed_belief;
        let _sink = runtime::sink::test_lock();
        let config = vault::testutil::temp_vault("hashed-capture-config");
        let dir = vault::testutil::temp_vault("hashed-capture");
        let _shadow = ledger::shadow::testing::activated(&dir);
        runtime::sink::arm(&config).unwrap();
        ledger::shadow::with_writer(&dir, |writer| {
            let belief = seed_belief(writer, "seed");
            let state = ledger::concepts::current_state(writer, &dir).unwrap();
            let projection = ledger::reduce::project_belief(&state, &belief).unwrap();
            ledger::manifest::write_projection(&dir, "knowledge/seed.md", &projection).unwrap();
        })
        .unwrap();
        let before = std::fs::read_to_string(dir.join("knowledge/seed.md")).unwrap();
        let head = ledger::head(&dir).unwrap().hash;
        let error = save_note(
            dir.to_string_lossy().into(),
            "knowledge/seed.md".into(),
            "# Draft\n".into(),
            Some("0".repeat(64)),
        )
        .unwrap_err();
        assert_eq!(
            error,
            "stale_content: knowledge/seed.md changed since it was read, so nothing was saved."
        );
        assert_eq!(ledger::head(&dir).unwrap().hash, head);
        assert_eq!(
            std::fs::read_to_string(dir.join("knowledge/seed.md")).unwrap(),
            before
        );
        assert!(door_rows(&dir).is_empty());
        let (_, body) = vault::parse::split_frontmatter(&before);
        let saved = save_note(
            dir.to_string_lossy().into(),
            "knowledge/seed.md".into(),
            format!("{body}\nAdded here.\n"),
            Some(ledger::sha256_hex(before.as_bytes())),
        )
        .unwrap();
        assert_eq!(saved, None);
        assert!(std::fs::read_to_string(dir.join("knowledge/seed.md"))
            .unwrap()
            .contains("Added here."));
        assert_ne!(ledger::head(&dir).unwrap().hash, head);
        assert_eq!(door_rows(&dir).len(), 1);
        runtime::sink::disarm();
        ledger::shadow::deactivate();
        assert_eq!(
            save_note(
                dir.to_string_lossy().into(),
                "knowledge/seed.md".into(),
                "# Stale without writer\n".into(),
                Some("0".repeat(64))
            )
            .unwrap_err(),
            "stale_content: knowledge/seed.md changed since it was read, so nothing was saved."
        );
        for path in [&dir, &config] {
            let _ = std::fs::remove_dir_all(path);
        }
    }
}

#[cfg(test)]
mod extraction_command_tests {
    use super::*;
    #[test]
    fn extracting_a_kept_document_returns_text_without_changing_the_original() {
        let dir = files::extract::testdocs::TempDir::new();
        std::fs::create_dir(dir.path().join("attachments")).unwrap();
        let bytes = files::extract::testdocs::docx();
        std::fs::write(dir.path().join("attachments/plan.docx"), &bytes).unwrap();
        let read = extract_document(
            dir.path().to_string_lossy().into_owned(),
            "attachments/plan.docx".into(),
        )
        .unwrap();
        assert_eq!(read.format, "docx");
        assert!(matches!(
            read.outcome,
            files::extract::Outcome::Extracted { .. }
        ));
        assert_eq!(
            std::fs::read(dir.path().join("attachments/plan.docx")).unwrap(),
            bytes
        );
        assert!(!dir.path().join("inbox").exists());
    }
    #[test]
    fn the_extraction_command_keeps_the_contained_file_refusals() {
        let dir = files::extract::testdocs::TempDir::new();
        for (path, words) in [
            ("../outside.docx", "path escapes the vault: ../outside.docx"),
            (
                ".secret.docx",
                "dot-folders and dotfiles are not readable here",
            ),
        ] {
            assert_eq!(
                extract_document(dir.path().to_string_lossy().into_owned(), path.into())
                    .unwrap_err(),
                words
            );
        }
    }
}
