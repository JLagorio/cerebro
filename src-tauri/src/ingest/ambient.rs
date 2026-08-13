//! The ambient scheduler (M26.4i) — a tick in the app process, in Rust.
//!
//! An owner decision, and worth restating: the driver is here and not in the
//! renderer's `useJobRunner`. A background pass that spends the user's
//! subscription must survive a window reload, must not run twice because two
//! windows are open, and must hold the one ambient lease the dispatcher
//! grants. All three are properties of the process, and the renderer is not
//! the process.
//!
//! **The SPENDING half is off unless the owner turns it on.** [`ENABLED`]
//! defaults to false and gates ingest and maintenance: an app may not start
//! spawning CLI runs against somebody's subscription without being asked, and
//! a default that spends money is not a default. The metering, the budget
//! gate and the surfaces all exist first — which was the point of doing them
//! first.
//!
//! **The DETERMINISTIC half is always on** (M26.9's flip): conflict
//! detection, the freshness scheduler (M27.1), the attention primitives,
//! convergence, and the Source Monitor run for every open vault. The argument for asking permission was about a
//! subscription, and none of these touches one — they spawn nothing, hold no
//! lease, and no budget gate can defer them. What they do cost is disk, and
//! that is bounded by the base's own size.
//!
//! **The pause governs both.** Somebody who pressed pause meant "stop", not
//! "stop the expensive half"; a deterministic phase that kept appending under
//! a pause would be the app arguing with a control the owner just used.
//!
//! **Its own connection, never the sink's.** `runtime::sink::with_sink`
//! holds a process-global mutex, and the MCP server takes it to record
//! operational refusals — so a tick that ran under it would hold the lock
//! across a blocking CLI run whose tools reach for the same lock. That is
//! precisely the deadlock `ingest::commit` exists to avoid on the ledger
//! side, and the answer is the same one `meter::finish` already uses: open a
//! second connection. WAL and a five-second busy timeout are what make that
//! safe, and they are set for exactly this.
//!
//! **One vault at a time.** Retargeting stops the previous loop before
//! starting the next, so switching vaults never leaves two supervisors
//! sharing one subscription.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{AppHandle, Manager};

use crate::runtime::settings;

/// `ambient.ingest_enabled` — per vault. Defaults to FALSE. See the module
/// note: a default that spends money is not a default.
pub const ENABLED: &str = "ambient.ingest_enabled";

/// How long after a vault opens before the first tick.
///
/// Long enough that opening a vault is not immediately followed by a
/// subprocess: the app is still indexing, the user is still deciding what
/// they came to do, and catch-up work is by definition not urgent.
pub const SETTLE_SECONDS: u64 = 45;

/// Between ticks. The work is a scan and a hash comparison; doing it more
/// often would find the same nothing.
pub const INTERVAL_SECONDS: u64 = 300;

/// How finely the loop checks whether it has been told to stop. A supervisor
/// that only noticed at the end of its interval would keep a closing app
/// alive for five minutes.
const STEP: Duration = Duration::from_millis(250);

/// Which vault the supervisor is watching, and the flag that stops it.
#[derive(Default)]
pub struct AmbientState {
    inner: Mutex<Option<Watching>>,
}

struct Watching {
    vault: PathBuf,
    stop: Arc<AtomicBool>,
}

/// What a retarget asks the caller to do.
#[derive(Debug, Clone)]
pub enum Action {
    /// Already watching this vault. Starting a second loop would put two
    /// supervisors on one subscription.
    Unchanged,
    /// Start a loop, and stop when this flag is set.
    Start(Arc<AtomicBool>),
}

impl AmbientState {
    /// Point the supervisor at `vault`, stopping whatever it was watching.
    pub fn retarget(&self, vault: &Path) -> Action {
        let Ok(mut guard) = self.inner.lock() else {
            // A poisoned lock means a previous holder panicked. Refusing to
            // start is the conservative answer: the alternative is a second
            // supervisor with no way to stop the first.
            return Action::Unchanged;
        };
        if let Some(current) = guard.as_ref() {
            if current.vault == vault {
                return Action::Unchanged;
            }
            current.stop.store(true, Ordering::Relaxed);
        }
        let stop = Arc::new(AtomicBool::new(false));
        *guard = Some(Watching {
            vault: vault.to_path_buf(),
            stop: stop.clone(),
        });
        Action::Start(stop)
    }

    /// Stop whatever is running. Idempotent.
    pub fn stop(&self) {
        let Ok(mut guard) = self.inner.lock() else {
            return;
        };
        if let Some(current) = guard.take() {
            current.stop.store(true, Ordering::Relaxed);
        }
    }

    /// The vault currently watched, if any.
    pub fn watching(&self) -> Option<PathBuf> {
        self.inner
            .lock()
            .ok()?
            .as_ref()
            .map(|current| current.vault.clone())
    }
}

/// Start the loop for `vault`, unless one is already running for it.
///
/// Returns whether a loop was started — false means "already watching this
/// vault", which is not a failure.
pub fn start(app: &AppHandle, state: &AmbientState, vault: &Path, config_dir: &Path) -> bool {
    let Action::Start(stop) = state.retarget(vault) else {
        return false;
    };
    let app = app.clone();
    let vault = vault.to_path_buf();
    let config_dir = config_dir.to_path_buf();
    std::thread::spawn(move || {
        if !sleep_until(&stop, Duration::from_secs(SETTLE_SECONDS)) {
            return;
        }
        loop {
            if let Err(detail) = tick_once(&app, &vault, &config_dir) {
                // Never fatal to the loop. An ambient pass that could not run
                // is a condition to report, and a supervisor that exited on
                // the first bad tick would stop working for the rest of the
                // session without saying so.
                eprintln!("ambient ingest: {detail}");
            }
            if !sleep_until(&stop, Duration::from_secs(INTERVAL_SECONDS)) {
                return;
            }
        }
    });
    true
}

/// Sleep in short steps. Returns false if the loop was told to stop.
fn sleep_until(stop: &AtomicBool, total: Duration) -> bool {
    let mut waited = Duration::ZERO;
    while waited < total {
        if stop.load(Ordering::Relaxed) {
            return false;
        }
        std::thread::sleep(STEP);
        waited += STEP;
    }
    !stop.load(Ordering::Relaxed)
}

/// One pass: check the owner's switch, then drive a tick.
fn tick_once(app: &AppHandle, vault: &Path, config_dir: &Path) -> Result<(), String> {
    let conn = crate::runtime::open_existing(config_dir)?;
    let vault_id = crate::runtime::scope::register(&conn, vault)?;

    // The pause governs EVERYTHING (M26.9). Somebody who pressed pause meant
    // "stop", not "stop the expensive half" — and a deterministic phase that
    // kept appending to the ledger under a pause would be the app arguing
    // with a control the owner just used.
    if crate::runtime::settings::global_pause(&conn) {
        return Ok(());
    }
    let Some(store_uuid) = crate::ledger::store::load(&crate::ledger::ledger_dir(vault))
        .map_err(|e| format!("store: {e}"))?
        .map(|store| store.store_id)
    else {
        // No ledger store, so nothing to ingest into and nothing to read.
        // Not an error: a vault that has never been armed is an ordinary
        // vault, and the supervisor now ticks over every open one.
        return Ok(());
    };

    // The deterministic phases run FIRST and unconditionally (M26.9's flip).
    // They spawn nothing, spend nothing, and cannot be deferred by a budget
    // gate; the argument for asking permission was always about somebody's
    // subscription, and these do not touch it.
    deterministic(&conn, vault, &vault_id, &store_uuid)?;

    // Everything below spends. It stays behind the owner's switch.
    if !enabled(&conn, &vault_id) {
        return Ok(());
    }

    let agents = app.state::<crate::agent::AgentState>();
    let mcp = app.state::<crate::mcp::McpState>();
    let live = super::spawn::Live {
        app,
        agents: agents.inner(),
        mcp: mcp.inner(),
        vault,
        config_dir: config_dir.to_path_buf(),
        data_dir: config_dir.to_path_buf(),
        vault_id: vault_id.clone(),
        store_uuid: store_uuid.clone(),
    };
    let runner = super::spawn::runner(&live);
    let committer = super::commit::ShadowCommit::new(vault);
    let context = super::driver::Context {
        vault,
        vault_id: &vault_id,
        store_uuid: &store_uuid,
    };
    let tick = super::driver::tick(&conn, &committer, &context, &runner, chrono::Utc::now())?;
    if let super::driver::Tick::Skipped(reason) = tick {
        // Not an error and not silent: two of the three reasons mean a person
        // has something to decide.
        eprintln!("ambient ingest: skipped ({reason:?})");
    }
    // The maintenance pass rides the SAME switch and the same tick, AFTER
    // ingest. Two reasons for the order: reading what changed is what makes
    // the base worth maintaining, and the one ambient lease is better spent
    // on new bytes than on tidying when both have work. It gets no default of
    // its own — `ambient.ingest_enabled` is off until asked, and maintenance
    // should not be the thing that starts spending somebody's subscription.
    //
    // Its fold is taken here rather than reusing the deterministic pass's,
    // because ingest committed in between and maintenance must see that.
    let read = crate::ledger::read_ledger(&crate::ledger::ledger_dir(vault))
        .map_err(|e| format!("ledger: {e}"))?;
    let chain_head = read
        .frames
        .last()
        .map(|frame| frame.event_id.clone())
        .unwrap_or_else(|| format!("genesis:{store_uuid}"));
    let state = crate::ledger::reduce::reduce(&read.frames, &store_uuid);
    maintain(
        app,
        &conn,
        vault,
        config_dir,
        &vault_id,
        &store_uuid,
        &state,
        &chain_head,
    )
}

/// The phases that need no permission (M26.9).
///
/// **These are on for every open vault, and the reasoning is the same one
/// that kept the LLM phases off.** A default that spends money is not a
/// default — and none of these spends any. They spawn no subprocess, hold no
/// lease, and cannot be deferred by a budget gate. What they do cost is disk:
/// conflict detection appends to the vault ledger, and the other three write
/// app-data. That is the honest price of a base that notices things, and it
/// is bounded by the base's own size rather than by a subscription.
///
/// Every one is reported and none is fatal. A base that could not compute its
/// attention signals is a base that still wants its comparisons; a supervisor
/// that returned early on the first failure would take the others down with
/// it for the rest of the session.
fn deterministic(
    conn: &rusqlite::Connection,
    vault: &Path,
    vault_id: &str,
    store_uuid: &str,
) -> Result<(), String> {
    // One read and one fold for the three phases that need the base.
    let read = crate::ledger::read_ledger(&crate::ledger::ledger_dir(vault))
        .map_err(|e| format!("ledger: {e}"))?;
    let chain_head = read
        .frames
        .last()
        .map(|frame| frame.event_id.clone())
        .unwrap_or_else(|| format!("genesis:{store_uuid}"));
    let state = crate::ledger::reduce::reduce(&read.frames, store_uuid);

    // Detection first, so the comparison counts the attention pass reads
    // include this tick's.
    detect_conflicts(vault, store_uuid, &state);
    // Then the gauntlet, on the same fold — so what it classifies is what the
    // base already held. Comparisons this tick just appended are deliberately
    // left for the next one: re-folding the ledger to catch them would double
    // the cost of every tick to save one interval on a signal nobody is
    // waiting on, and the classification is idempotent either way.
    classify_conflicts(vault, store_uuid, &state, chrono::Utc::now());
    // Then the freshness scheduler, on the same fold. It appends only
    // crossings the base has not already recorded, and the crossing's own
    // stamp comes from pinned evidence rather than from now — so a laptop
    // opened three days late records the boundary it missed, at the boundary.
    schedule_freshness(vault, store_uuid, &state, chrono::Utc::now());

    if let Err(detail) = record_attention(conn, vault_id, store_uuid, &chain_head, &state) {
        eprintln!("attention signals: {detail}");
    }
    if let Err(detail) = converge(conn, vault_id, store_uuid, &read.frames) {
        eprintln!("convergence: {detail}");
    }
    // The Source Monitor reads files rather than the ledger, so it neither
    // needs the fold above nor invalidates it.
    match crate::monitor::pass::run(conn, vault, vault_id, chrono::Utc::now()) {
        Ok((observed, unreadable)) => {
            if !observed.changed.is_empty() || !observed.due.is_empty() || unreadable > 0 {
                eprintln!(
                    "source monitor: {} changed, {} due for refetch, {unreadable} unreadable",
                    observed.changed.len(),
                    observed.due.len()
                );
            }
        }
        Err(detail) => eprintln!("source monitor: {detail}"),
    }
    Ok(())
}

/// One scheduled convergence run, from wherever the last one stopped.
///
/// It re-folds the ledger twice, which is the expensive thing on this tick —
/// so it runs only when the head has actually moved. A base nobody is writing
/// to should not pay for a daily re-read of itself, and the window helper is
/// where that decision lives rather than here.
fn converge(
    conn: &rusqlite::Connection,
    vault_id: &str,
    store_uuid: &str,
    frames: &[crate::ledger::frame::Frame],
) -> Result<(), String> {
    let Some(head_seq) = frames.last().map(|frame| frame.seq) else {
        return Ok(());
    };
    let last = crate::convergence::store::latest(conn, vault_id, store_uuid)?.map(|run| run.to_seq);
    let Some(window) = crate::convergence::next_window(last, head_seq) else {
        return Ok(());
    };
    let output = crate::convergence::over(frames, store_uuid, window)?;
    let now = chrono::Utc::now();
    let run_id = format!("convergence-{}-{}", window.from_seq, window.to_seq);
    crate::convergence::store::record(
        conn,
        vault_id,
        store_uuid,
        &run_id,
        crate::convergence::store::Trigger::Scheduled,
        &output,
        now,
    )?;
    Ok(())
}

/// Recompute and store the attention primitives.
///
/// The state passed in was folded BEFORE this tick's detection appended
/// anything, so the comparison counts here are one tick behind. That is the
/// honest trade: re-reading and re-folding the whole ledger to pick up a
/// handful of comparisons would double the cost of every tick of every open
/// vault, and these rows are recomputed from scratch on the next one.
fn record_attention(
    conn: &rusqlite::Connection,
    vault_id: &str,
    store_uuid: &str,
    chain_head: &str,
    state: &crate::ledger::reduce::EpistemicState,
) -> Result<(), String> {
    let now = chrono::Utc::now();
    let signals = crate::attention::signals::compute(state, now);
    crate::attention::store::record(conn, vault_id, store_uuid, chain_head, &signals, now)?;
    Ok(())
}

/// One deterministic detection pass.
///
/// Reported and never fatal. The only failure it can have is a writer that
/// is not armed, and the honest response to that is to say so and find the
/// same pairs again next tick — the detector is a pure function of the base,
/// so nothing is lost by not having written.
fn detect_conflicts(vault: &Path, store_uuid: &str, state: &crate::ledger::reduce::EpistemicState) {
    let candidates = crate::conflict::detect::find(state);
    if candidates.is_empty() {
        return;
    }
    let appender = crate::conflict::emit::ShadowAppend::new(vault);
    let emitted = crate::conflict::emit::emit(state, store_uuid, &candidates, &appender);
    if emitted.appended > 0 {
        eprintln!(
            "conflict detection: {} new comparison(s), {} already known",
            emitted.appended, emitted.already_known
        );
    }
    for (comparison, detail) in &emitted.failed {
        eprintln!("conflict detection: {comparison} could not be recorded — {detail}");
    }
}

/// Run D12's gauntlet over every committed comparison nobody has classified.
///
/// The overwhelmingly common outcome is a RESOLUTION — "we almost called this
/// a contradiction, and here is why we did not" — which is quiet by design
/// and still worth recording: it is what stops the same pair being
/// re-litigated on every tick.
///
/// `as_of` is passed IN for the reason the freshness scheduler's is: the
/// gauntlet is a pure function of state and that stamp, which is supplied
/// display content and never ordering (D3).
fn classify_conflicts(
    vault: &Path,
    store_uuid: &str,
    state: &crate::ledger::reduce::EpistemicState,
    as_of: chrono::DateTime<chrono::Utc>,
) {
    if state.comparisons.is_empty() {
        return;
    }
    let committer = crate::ingest::commit::ShadowCommit::new(vault);
    let classified_at = as_of.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
    let emitted = crate::conflict::resolve::emit(state, store_uuid, &classified_at, &committer);
    if emitted.resolved > 0 || emitted.opened > 0 {
        eprintln!(
            "conflict gauntlet: {} resolved apart, {} contradiction edge(s) opened, {} waiting \
             on review",
            emitted.resolved, emitted.opened, emitted.needs_semantics
        );
    }
    for (comparison, detail) in &emitted.failed {
        eprintln!("conflict gauntlet: {comparison} could not be classified — {detail}");
    }
}

/// Append every freshness crossing the base has not recorded yet.
///
/// `as_of` is passed IN. The scheduler is a pure function of state, the
/// versioned rules, and that instant; reading the clock is the supervisor's
/// job, which is what lets a test ask what is due on a day of its choosing
/// without pretending to be that day.
///
/// A rules artifact that will not load is reported and skipped rather than
/// fatal. The digest guard exists to catch an edited table, and the answer to
/// one is "say so and stop assessing freshness", not "take the ambient tick
/// down for every vault".
fn schedule_freshness(
    vault: &Path,
    store_uuid: &str,
    state: &crate::ledger::reduce::EpistemicState,
    as_of: chrono::DateTime<chrono::Utc>,
) {
    let rules = match crate::dynamics::freshness::load() {
        Ok(rules) => rules,
        Err(detail) => {
            eprintln!("freshness rules: {detail}");
            return;
        }
    };
    let appender = crate::conflict::emit::ShadowAppend::new(vault);
    let emitted = crate::dynamics::schedule::emit(state, store_uuid, &rules, as_of, &appender);
    if emitted.appended > 0 {
        eprintln!(
            "freshness: {} crossing(s) recorded, {} already known",
            emitted.appended, emitted.already_known
        );
    }
    for (dedupe_key, detail) in &emitted.failed {
        eprintln!("freshness: {dedupe_key} could not be recorded — {detail}");
    }
}

/// One maintenance attempt, on the same tick as ingest.
///
/// Reported and never fatal, like the ingest half: a pass that could not run
/// is a condition to say out loud, and a supervisor that exited on it would
/// stop maintaining for the rest of the session without telling anyone.
#[allow(clippy::too_many_arguments)] // A supervisor seam: every one is a
                                     // distinct identity the pass needs, and
                                     // bundling them into a struct nothing
                                     // else builds would hide that.
fn maintain(
    app: &AppHandle,
    conn: &rusqlite::Connection,
    vault: &Path,
    config_dir: &Path,
    vault_id: &str,
    store_uuid: &str,
    state: &crate::ledger::reduce::EpistemicState,
    chain_head: &str,
) -> Result<(), String> {
    let context = crate::maintain::pass::Context {
        vault_id,
        store_uuid,
        chain_head,
    };
    // The elapsed limit the lease will be issued under. Read from the shipped
    // defaults rather than invented here: the watchdog and the lease must
    // agree, or a run is killed before or after the thing that owns it.
    let elapsed = crate::runtime::budget::shipped_defaults()?.max_run_elapsed_seconds;
    let agents = app.state::<crate::agent::AgentState>();
    let mcp = app.state::<crate::mcp::McpState>();
    let live = crate::maintain::live::Live {
        app,
        agents: agents.inner(),
        mcp: mcp.inner(),
        vault,
        config_dir: config_dir.to_path_buf(),
        data_dir: config_dir.to_path_buf(),
        vault_id: vault_id.to_string(),
        store_uuid: store_uuid.to_string(),
        elapsed_limit_seconds: elapsed,
    };
    match crate::maintain::schedule::attempt(conn, &context, state, &live, chrono::Utc::now())? {
        crate::maintain::schedule::Scheduled::Deferred(reasons) => {
            eprintln!("maintenance: deferred ({reasons:?})");
        }
        crate::maintain::schedule::Scheduled::NothingNew => {}
        crate::maintain::schedule::Scheduled::Ran { said, .. } => {
            eprintln!("maintenance: said {said} finding(s)");
        }
    }
    Ok(())
}

/// Has the owner turned this on for this vault?
pub fn enabled(conn: &rusqlite::Connection, vault_id: &str) -> bool {
    matches!(
        settings::get(conn, ENABLED, Some(vault_id)),
        Ok(Some(ref value)) if value == "true"
    )
}

/// Turn it on or off for one vault.
pub fn set_enabled(conn: &rusqlite::Connection, vault_id: &str, on: bool) -> Result<(), String> {
    settings::set(
        conn,
        ENABLED,
        Some(vault_id),
        if on { "true" } else { "false" },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::testutil;

    #[test]
    fn the_owner_has_to_turn_it_on() {
        // The default that does not spend money. A vault that has never been
        // asked does not get a background subprocess.
        let dir = testutil::temp_vault("ambient-default");
        let conn = crate::runtime::open(&dir).unwrap();
        let vault = crate::runtime::scope::register(&conn, &dir).unwrap();
        assert!(!enabled(&conn, &vault), "off until asked");
        set_enabled(&conn, &vault, true).unwrap();
        assert!(enabled(&conn, &vault));
        set_enabled(&conn, &vault, false).unwrap();
        assert!(!enabled(&conn, &vault));
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unreadable_setting_is_not_permission_to_spend() {
        // Every other flag in `settings` chooses its own default; this one
        // chooses `false` for both "absent" and "unreadable", because the
        // conservative answer to "may I spend money" is no.
        let dir = testutil::temp_vault("ambient-unreadable");
        let conn = crate::runtime::open(&dir).unwrap();
        let vault = crate::runtime::scope::register(&conn, &dir).unwrap();
        set_enabled(&conn, &vault, true).unwrap();
        conn.execute("DROP TABLE settings", []).unwrap();
        assert!(!enabled(&conn, &vault));
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A vault with one belief resting on one assertion, and a second belief
    /// that disagrees with it — enough for the deterministic phases to have
    /// something to find.
    fn armed(label: &str) -> (std::path::PathBuf, rusqlite::Connection, String) {
        let dir = testutil::temp_vault(label);
        let conn = crate::runtime::open(&dir).unwrap();
        let vault = crate::runtime::scope::register(&conn, &dir).unwrap();
        (dir, conn, vault)
    }

    #[test]
    fn the_deterministic_phases_do_not_wait_for_the_spending_switch() {
        // M26.9's flip. `deterministic` is the function the tick calls before
        // it looks at `ambient.ingest_enabled` at all, so a vault that has
        // never been enabled still gets its attention signals.
        let (dir, conn, vault) = armed("ambient-flip");
        assert!(!enabled(&conn, &vault), "the spending switch stays off");
        let store = crate::ledger::store::load_or_mint(&crate::ledger::ledger_dir(&dir))
            .unwrap()
            .store_id;
        deterministic(&conn, &dir, &vault, &store).unwrap();
        // Nothing in the vault, so nothing to say — but the pass RAN, which
        // is what an empty read proves rather than an error.
        assert!(crate::attention::store::read(&conn, &vault, &store)
            .unwrap()
            .is_empty());
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_vault_with_no_ledger_store_is_an_ordinary_vault() {
        // The supervisor now ticks over every open vault, so "never armed"
        // has to be a quiet no-op rather than an error on every tick.
        let dir = testutil::temp_vault("ambient-unarmed");
        let conn = crate::runtime::open(&dir).unwrap();
        let vault = crate::runtime::scope::register(&conn, &dir).unwrap();
        assert!(crate::ledger::store::load(&crate::ledger::ledger_dir(&dir))
            .unwrap()
            .is_none());
        assert!(!enabled(&conn, &vault));
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn opening_the_same_vault_twice_does_not_start_a_second_supervisor() {
        // Two loops on one subscription would each hold the "one ambient
        // lease" the dispatcher grants, and one of them would lose.
        let state = AmbientState::default();
        let vault = Path::new("/tmp/cerebro-ambient-a");
        assert!(matches!(state.retarget(vault), Action::Start(_)));
        assert!(matches!(state.retarget(vault), Action::Unchanged));
        assert_eq!(state.watching().as_deref(), Some(vault));
    }

    #[test]
    fn switching_vaults_stops_the_previous_loop_before_starting_the_next() {
        let state = AmbientState::default();
        let first = Path::new("/tmp/cerebro-ambient-a");
        let second = Path::new("/tmp/cerebro-ambient-b");
        let Action::Start(stopped) = state.retarget(first) else {
            panic!("expected a start");
        };
        let Action::Start(running) = state.retarget(second) else {
            panic!("expected a start");
        };
        assert!(stopped.load(Ordering::Relaxed), "the old loop was told");
        assert!(!running.load(Ordering::Relaxed));
        assert_eq!(state.watching().as_deref(), Some(second));
    }

    #[test]
    fn stopping_is_idempotent_and_leaves_nothing_watching() {
        let state = AmbientState::default();
        let Action::Start(stop) = state.retarget(Path::new("/tmp/cerebro-ambient-a")) else {
            panic!("expected a start");
        };
        state.stop();
        state.stop();
        assert!(stop.load(Ordering::Relaxed));
        assert_eq!(state.watching(), None);
    }

    #[test]
    fn a_loop_told_to_stop_does_not_finish_its_sleep() {
        // A supervisor that only checked at the end of its interval would
        // keep a closing app alive for five minutes.
        let stop = AtomicBool::new(true);
        assert!(!sleep_until(&stop, Duration::from_secs(INTERVAL_SECONDS)));
    }

    #[test]
    fn a_sleep_that_is_never_interrupted_completes() {
        let stop = AtomicBool::new(false);
        assert!(sleep_until(&stop, Duration::from_millis(1)));
    }
}
