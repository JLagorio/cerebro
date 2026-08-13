//! The ambient scheduler (M26.4i) — a tick in the app process, in Rust.
//!
//! An owner decision, and worth restating: the driver is here and not in the
//! renderer's `useJobRunner`. A background pass that spends the user's
//! subscription must survive a window reload, must not run twice because two
//! windows are open, and must hold the one ambient lease the dispatcher
//! grants. All three are properties of the process, and the renderer is not
//! the process.
//!
//! **OFF unless the owner turns it on.** [`ENABLED`] defaults to false and
//! nothing here flips it. Wiring the spine is this milestone's job; deciding
//! that an app may start spawning CLI runs against somebody's subscription
//! without being asked is not, and a default that spends money is not a
//! default. The metering, the budget gate and the surfaces all exist first —
//! which was the point of doing them first.
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
    if !enabled(&conn, &vault_id) {
        return Ok(());
    }
    let store_uuid = crate::ledger::store::load(&crate::ledger::ledger_dir(vault))
        .map_err(|e| format!("store: {e}"))?
        .ok_or("this vault has no ledger store — nothing to ingest into")?
        .store_id;

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
    // One read and one fold for everything downstream of ingest. Both passes
    // below want the base as it stands AFTER this tick's commits, and reading
    // the ledger twice to get the same answer twice is a cost paid on every
    // tick of every open vault.
    let read = crate::ledger::read_ledger(&crate::ledger::ledger_dir(vault))
        .map_err(|e| format!("ledger: {e}"))?;
    let chain_head = read
        .frames
        .last()
        .map(|frame| frame.event_id.clone())
        .unwrap_or_else(|| format!("genesis:{store_uuid}"));
    let state = crate::ledger::reduce::reduce(&read.frames, &store_uuid);

    // Conflict detection first, and not because it is more important: it is
    // FREE. It spawns nothing, spends nothing, and cannot be deferred by a
    // budget gate, so running it ahead of the pass that competes for the one
    // ambient lease means a base whose lease is exhausted still gets its
    // comparisons. M26.9 lifts it out of this switch entirely — a
    // deterministic phase is always on — and until then it rides the owner's
    // switch rather than writing to a vault nobody asked it to touch.
    detect_conflicts(vault, &store_uuid, &state);

    // The attention primitives, on the same free footing and computed AFTER
    // detection so the comparison counts include this tick's. Nothing reads
    // these yet — M27's lanes will — and computing them now is what makes the
    // lanes a query rather than a scan when they arrive.
    if let Err(detail) = record_attention(&conn, &vault_id, &store_uuid, &chain_head, &state) {
        eprintln!("attention signals: {detail}");
    }

    // The Source Monitor, last, and also free. It reads files rather than the
    // ledger, so it neither needs this tick's fold nor invalidates it.
    match crate::monitor::pass::run(&conn, vault, &vault_id, chrono::Utc::now()) {
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

    // The maintenance pass rides the SAME switch and the same tick, AFTER
    // ingest. Two reasons for the order: reading what changed is what makes
    // the base worth maintaining, and the one ambient lease is better spent
    // on new bytes than on tidying when both have work. It gets no default of
    // its own — `ambient.ingest_enabled` is off until asked, and maintenance
    // should not be the thing that starts spending somebody's subscription.
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
