pub mod agent;
pub mod app_config;
pub mod assembly;
pub mod attention;
pub mod conflict;
pub mod connectors;
pub mod convergence;
pub mod crash;
pub mod demo;
pub mod dynamics;
#[cfg(test)]
mod eval;
pub mod git;
pub mod git_commands;
pub mod ingest;
pub mod knowledge;
pub mod ledger;
pub mod maintain;
pub mod mcp;
pub mod monitor;
pub mod policy;
pub mod retrieval;
pub mod roots;
pub mod roots_commands;
pub mod runtime;
pub mod search;
pub mod trigger;
pub mod vault;

use std::path::{Path, PathBuf};

use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

use vault::entry::Entry;
use vault::watcher::WatcherState;
use vault::write::{CollectionYaml, ViewYaml};

fn config_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path().app_config_dir().map_err(|e| e.to_string())
}

fn remember_vault(app: &tauri::AppHandle, path: &str) -> Result<(), String> {
    let dir = config_dir(app)?;
    let mut config = app_config::load(&dir);
    config.last_vault = Some(path.to_string());
    app_config::save(&dir, &config)
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

#[tauri::command(async)]
fn scan_vault(vault: String) -> Result<Vec<Entry>, String> {
    // M21.1 janitor: reap atomic-write temps abandoned by a crash. Here in
    // the command rather than inside scan::scan_vault so bare library scans
    // (tests, MCP-forced rescans) stay read-only.
    vault::write::clean_orphan_temps(Path::new(&vault));
    vault::scan::scan_vault(Path::new(&vault))
}

#[tauri::command(async)]
fn read_note(vault: String, path: String) -> Result<String, String> {
    vault::write::read_note(Path::new(&vault), &path)
}

// The write commands below are the HUMAN path — every one of them is
// reachable from the UI, so each guards the knowledge/ bundle (M5). The
// agent's MCP tools have their own, narrower boundary (M17.1): they reach
// the bundle through `write_concept` alone. See mcp.rs.
#[tauri::command(async)]
fn save_note(vault: String, path: String, body: String) -> Result<(), String> {
    // The M23.7 capture valve: an in-app body edit to a knowledge
    // projection is CAPTURED (an editorial override, or the unique
    // extracted-text correction), not refused. The old refusal survives
    // only where no writer is active or the edit cannot be represented.
    if knowledge::is_knowledge_path(&path) {
        if let Some(result) = ledger::capture::capture_body_edit(Path::new(&vault), &path, &body) {
            return result;
        }
        knowledge::guard_human_write(&path)?;
    }
    vault::write::save_note(Path::new(&vault), &path, &body)
}

#[tauri::command(async)]
fn update_frontmatter(
    vault: String,
    path: String,
    patch: serde_json::Map<String, serde_json::Value>,
) -> Result<(), String> {
    // The M23.7 capture valve, frontmatter half: presentation keys become
    // editorial ops, epistemic keys become assertion+revision, relation and
    // alias keys their exact paired events. Provenance stamps and alias
    // removal remain hard-refused.
    if knowledge::is_knowledge_path(&path) {
        if let Some(result) =
            ledger::capture::capture_frontmatter_patch(Path::new(&vault), &path, &patch)
        {
            return result;
        }
        knowledge::guard_human_write(&path)?;
    }
    vault::write::update_frontmatter(Path::new(&vault), &path, &patch)
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
/// the moment its last member has a decision.
#[tauri::command(async)]
fn decide_proposal(
    vault: String,
    proposal_id: String,
    approve: bool,
    reviewer: String,
    reason: Option<String>,
) -> Result<Option<String>, String> {
    let vault = Path::new(&vault);
    ledger::shadow::with_writer(vault, |writer| {
        policy::review::decide(
            writer,
            vault,
            &proposal_id,
            approve,
            &reviewer,
            reason.as_deref(),
        )
        .map(|outcome| outcome.map(|o| o.transition.as_str().to_string()))
    })
    .unwrap_or_else(|| Err("no active ledger writer for this vault".to_string()))
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
    ledger::shadow::with_writer(vault, |writer| {
        policy::review::revert(writer, vault, &proposal_id, &applied_event_ids, &reviewer)
            .map(|outcome| outcome.transition.as_str().to_string())
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

/// The subscription-wide pause. Persisted, so it survives a restart — a
/// pause that forgot itself overnight would be the least trustworthy control
/// in the app.
#[tauri::command(async)]
fn set_global_pause(app: tauri::AppHandle, paused: bool) -> Result<(), String> {
    let conn = runtime::open_existing(&config_dir(&app)?)?;
    runtime::settings::set_global_pause(&conn, paused)
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
/// `from_seq` omitted means "since the last stored run", which is the
/// question a person actually asks; an explicit window is for a surface that
/// wants to look further back.
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
    // since you last looked" — so it is computed rather than refused.
    let window = convergence::diff::Window {
        from_seq: from_seq.min(head_seq),
        to_seq: head_seq,
    };
    // Read aloud on the way out (M27.8a). The stored row keeps the structured
    // `Output` — its bytes are content-hashed and a prose field would change
    // every one already on disk — so the sentences are composed per call, in
    // the module that owns the surface's whole vocabulary.
    let output = convergence::over(&read.frames, &store_uuid, window)?;
    Ok(attention::status::change_sections(&output))
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

/// The M23.7 reconciliation exits: `accept_current_files` adopts every
/// representable diff through the capture valve in one logical batch;
/// `restore_ledger_authority` regenerates every projection and closes the
/// mode with the unbatched resolution.
#[tauri::command(async)]
fn resolve_reconciliation(vault: String, action: String) -> Result<(), String> {
    ledger::reconcile::resolve(Path::new(&vault), &action).unwrap_or_else(|| {
        Err("no active ledger writer for this vault — reconciliation is unavailable".to_string())
    })
}

/// The one sanctioned human write into the bundle: recording that a person
/// has confirmed a concept. Scoped to the `verified` key (see knowledge.rs).
#[tauri::command(async)]
fn verify_concept(
    vault: String,
    path: String,
    patch: serde_json::Map<String, serde_json::Value>,
) -> Result<(), String> {
    knowledge::guard_verify(&path, &patch)?;
    // Byte-identical writes to update_frontmatter; the shadow event says
    // what actually happened (knowledge.verify, M21.8).
    vault::write::verify_frontmatter(Path::new(&vault), &path, &patch)
}

/// The M23.5 capture boundary: a structured in-app edit to a knowledge
/// projection commits assertion+revision as one logical batch; an editorial
/// edit commits a projection override. The M23.7 valve routes the human
/// edit paths here; until then only capture-aware surfaces call it. A vault
/// without an active ledger writer cannot capture — the error names it.
#[tauri::command(async)]
fn capture_concept_edit(vault: String, request: serde_json::Value) -> Result<(), String> {
    ledger::capture::capture_from_json(Path::new(&vault), &request).unwrap_or_else(|| {
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
    knowledge::guard_human_write(&folder)?;
    vault::write::create_note(Path::new(&vault), &folder, &slug, &frontmatter, &body)
}

#[tauri::command(async)]
fn set_note_title(vault: String, path: String, title: String) -> Result<(), String> {
    knowledge::guard_human_write(&path)?;
    vault::write::set_note_title(Path::new(&vault), &path, &title)
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
    vault::write::save_view(Path::new(&vault), &id, &yaml, folder.as_deref())
}

#[tauri::command(async)]
fn list_collections(vault: String) -> Result<Vec<CollectionYaml>, String> {
    vault::write::list_collections(Path::new(&vault))
}

#[tauri::command(async)]
fn save_collection(vault: String, folder: String, yaml: String) -> Result<(), String> {
    knowledge::guard_human_write(&folder)?;
    vault::write::save_collection(Path::new(&vault), &folder, &yaml)
}

#[tauri::command(async)]
fn save_list(vault: String, folder: String, id: String, yaml: String) -> Result<(), String> {
    knowledge::guard_human_write(&folder)?;
    vault::write::save_list(Path::new(&vault), &folder, &id, &yaml)
}

#[tauri::command(async)]
fn create_folder(vault: String, path: String) -> Result<(), String> {
    knowledge::guard_human_write(&path)?;
    vault::write::create_folder(Path::new(&vault), &path)
}

#[tauri::command(async)]
fn rename_note(vault: String, from: String, to: String) -> Result<(), String> {
    knowledge::guard_human_move(&from, &to)?;
    vault::write::rename_note(Path::new(&vault), &from, &to)
}

#[tauri::command(async)]
fn delete_note(vault: String, path: String) -> Result<(), String> {
    // The one write command that never had this guard (M17.1). Read-only
    // that a delete can empty is not read-only: every other door into the
    // bundle was shut while this one let a concept — and its provenance —
    // be thrown away outright.
    knowledge::guard_human_write(&path)?;
    vault::write::delete_note(Path::new(&vault), &path)
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

/// Copy a picked file into the vault's `attachments/` folder; returns its
/// vault-relative path. No knowledge guard: the destination is fixed inside
/// `import_attachment` and can never be `knowledge/`.
#[tauri::command(async)]
fn import_attachment(vault: String, source: String) -> Result<String, String> {
    vault::write::import_attachment(Path::new(&vault), &source)
}

/// Write a raw text file (`.mmd` only) into the vault; returns the actual
/// path after `-2` stem dedupe (M29.22). The extension allowlist and the
/// knowledge guard live in write.rs beside the dedupe, where they are
/// unit-tested — this command stays thin on purpose.
#[tauri::command(async)]
fn write_text_file(vault: String, path: String, content: String) -> Result<String, String> {
    vault::write::write_text_file(Path::new(&vault), &path, &content)
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

// --- Local agent + MCP (M6) ------------------------------------------------

#[tauri::command(async)]
fn check_agent() -> agent::AgentStatus {
    agent::status()
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

/// Start (or retarget) the loopback MCP endpoint and return its address. The
/// token is handed to the CLI through a private config file; the frontend
/// carries it only to pass it back into `run_agent`.
#[tauri::command(async)]
fn start_mcp(
    app: tauri::AppHandle,
    state: tauri::State<'_, mcp::McpState>,
    vault: String,
) -> Result<mcp::McpInfo, String> {
    state.ensure(&app, Path::new(&vault))
}

/// Returns the run's id — the tag on every event this run emits.
#[tauri::command(async)]
fn run_agent(
    app: tauri::AppHandle,
    state: tauri::State<'_, agent::AgentState>,
    mcp_state: tauri::State<'_, mcp::McpState>,
    vault: String,
    request: agent::AgentRequest,
) -> Result<u64, String> {
    // Attribution rides the run's own bearer token (M13.4): the MCP server
    // stamps `generated.by` from the token each request presents, so a
    // child killed while a write is in flight still stamps as itself.
    // Shared "current actor" state had a window — set here, before the old
    // child was gone — where the outgoing run's trailing writes stamped as
    // the incoming run (PR #5 security review).
    let mut request = request;
    // M31.2a: the durable id is minted BEFORE the token so the grant and the
    // meter carry the SAME one — an attended run used to hold two (the meter's
    // here, a token-derived hash in the grant), and everything that joins runs
    // to proposals, answers, or costs needs them to be one.
    let run_id = ledger::new_run_id();
    // M17.13: the scope rides the same token. It is taken from the REQUEST,
    // which the app builds from the Agent record — the CLI never sees it and
    // therefore cannot argue with it. No tool narrowing (M31.1b): the
    // panel's own turns are unrestricted, and a person is watching them.
    request.mcp_token = Some(mcp_state.run_token(
        request.actor.as_deref(),
        request.scope.clone(),
        None,
        run_id.clone(),
    )?);
    let dir = config_dir(&app)?;
    // M25.2: attended chat is METERED and never gated. The run is recorded
    // with its tokens; no reservation, no lease, and no ceiling can refuse it.
    let scope = runtime::open_vault(Path::new(&vault));
    let meter = agent::meter::Meter {
        data_dir: dir.clone(),
        run_id,
        mode: agent::meter::Mode::Attended,
        vault_id: scope.as_ref().map(|s| s.vault_id.clone()),
        store_uuid: scope.as_ref().and_then(|s| s.store_uuid.clone()),
        started_at: chrono::Utc::now(),
        elapsed_limit_seconds: None,
    };
    agent::stream(
        app.clone(),
        state.inner(),
        Path::new(&vault),
        request,
        &dir,
        Some(meter),
        // Nothing in the app waits on an attended run: the panel follows the
        // event stream, and the person is watching it.
        None,
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

/// Returns the killed run's id (if anything was running) so the frontend can
/// recognize and drop that run's trailing events (PR #5 review).
#[tauri::command(async)]
/// Stop ONE run (M17.3). `false` means it had already finished — a race, not
/// an error. Taking a run id is the point: a global kill was safe only while
/// there could be one child, and it is how closing the assistant used to
/// abort a background distill that had nothing to do with it.
fn stop_agent(state: tauri::State<'_, agent::AgentState>, run: u64) -> Result<bool, String> {
    state.stop(run)
}

/// Stop everything, reporting what died. For shutdown and vault switches: a
/// child left pointed at the vault you just closed is worse than one
/// interrupted.
#[tauri::command(async)]
fn stop_all_agents(state: tauri::State<'_, agent::AgentState>) -> Result<Vec<u64>, String> {
    state.stop_all()
}

/// The ledger chain head for git cross-attestation trailers (M21.7).
/// Best-effort by design: any absent or unreadable ledger is `None`, never
/// an error — checkpoints are periodic anchoring, not a ledger dependency.
#[tauri::command(async)]
fn ledger_head(vault: String) -> Option<ledger::LedgerHead> {
    ledger::head(Path::new(&vault))
}

/// Shadow-mode diagnostics (M21.8): a live classification of the vault's
/// ledger. Read-only — no minting, no side effects, no UI.
#[tauri::command(async)]
fn ledger_status(app: tauri::AppHandle, vault: String) -> ledger::shadow::LedgerStatus {
    ledger::shadow::status(config_dir(&app).ok().as_deref(), Path::new(&vault))
}

#[tauri::command(async)]
fn start_watcher(
    app: tauri::AppHandle,
    state: tauri::State<'_, WatcherState>,
    ambient: tauri::State<'_, ingest::ambient::AmbientState>,
    vault: String,
) -> Result<(), String> {
    let vault_path = PathBuf::from(&vault);
    // M21.8 startup: run the M21.4 verification, record the verdict, start
    // shadow recording for this vault. Never blocks watching — a refused
    // ledger records nothing and says why through ledger_status.
    if let Ok(dir) = config_dir(&app) {
        let _ = ledger::shadow::activate(&dir, &vault_path);
        // M24.2: the runtime DB is armed beside the ledger index, in
        // app-data — never inside a possibly cloud-synced vault (D2).
        // Failing to open the OPERATIONAL LOG must not stop the app from
        // opening the vault: it would trade a working workspace for a
        // diagnostic, and every refusal is still returned to its caller.
        if let Err(e) = runtime::sink::arm(&dir) {
            eprintln!("runtime db unavailable, operational refusals go unrecorded: {e}");
        }
        // M25.1: one database serves every vault, so an opening vault
        // registers itself before anything writes a row that has to say
        // which folder it belongs to. Failing here is degraded, not fatal,
        // for the same reason the line above is.
        let _ = runtime::open_vault(&vault_path);
        // M26.4i: the ambient ingest supervisor. It reads its own switch,
        // which defaults OFF — starting the loop is not the same as
        // enabling the work, and nothing here turns it on.
        ingest::ambient::start(&app, ambient.inner(), &vault_path, &dir);
    }
    vault::watcher::start(app, state.inner(), vault_path)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(WatcherState::default())
        .manage(agent::AgentState::default())
        .manage(mcp::McpState::default())
        .manage(ingest::ambient::AmbientState::default())
        .invoke_handler(tauri::generate_handler![
            pick_vault,
            open_demo_vault,
            get_last_vault,
            scan_vault,
            read_note,
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
            set_global_pause,
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
            list_folders,
            pick_files,
            import_attachment,
            write_text_file,
            export_png,
            ledger_head,
            ledger_status,
            start_watcher,
            read_connectors,
            save_connectors,
            check_agent,
            agent_workspace,
            purge_agent_workspace,
            start_mcp,
            run_agent,
            stop_agent,
            stop_all_agents,
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
            roots_commands::read_file_text
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
