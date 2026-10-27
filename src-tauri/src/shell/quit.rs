//! Quitting saves first (M55.10).
//!
//! A page saves 500 ms after the last keystroke, and a field such as a title
//! or a property commits when it loses focus. Tauri's own macOS menu quits
//! with `terminate:`, which goes straight to `RunEvent::Exit`, and the close
//! button closed the window without asking, so either way an edit typed a
//! moment before was lost.
//!
//! So three ways out ask the webview first: ⌘Q (Cerebro's own "Quit Cerebro"
//! item, which replaces the predefined one), and the close button and ⌘W,
//! which both arrive as `CloseRequested` and are prevented in
//! `build_main_window`. Each calls [`request`], which emits
//! [`QUIT_REQUESTED_EVENT`]. The webview commits the focused field, flushes
//! every open page, leaves the shell so each page runs its own leave path,
//! waits for the writes, and then calls [`finish_quit`]. When a save fails it
//! calls [`cancel_quit`] instead and stays open with a toast; a second quit
//! within 30 s closes anyway. Rust owns the bound: [`QUIT_DEADLINE`] after the
//! request the app exits whatever the webview did, so a hung webview cannot
//! keep it open.
//!
//! **The limit.** Dock Quit, the app switcher's Q, logout, restart, shutdown
//! and a quit Apple Event all send `terminate:` to the application, and tao
//! 0.37.1 implements only `applicationWillTerminate:`, never
//! `applicationShouldTerminate:`. Those exit with no prepare, and a page's
//! last half second can be lost. Patching tao's private delegate class at
//! runtime was considered and rejected: it would break silently on any tao
//! upgrade. README.md and AGENTS.md say the same.

use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::Duration;
#[cfg(feature = "native-read-smoke")]
use std::time::Instant;

use serde::Serialize;
use tauri::menu::{
    AboutMetadata, IsMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu,
    HELP_SUBMENU_ID, WINDOW_SUBMENU_ID,
};
use tauri::{AppHandle, Emitter, Manager, Runtime};

/// What the webview hears when a quit begins.
pub const QUIT_REQUESTED_EVENT: &str = "cerebro://quit-requested";

/// The menu item that replaces the predefined Quit.
pub const QUIT_MENU_ID: &str = "cerebro-quit";

/// How long the webview has to prepare, in milliseconds. The webview splits
/// it into its own budgets, so no TypeScript constant twins it.
const QUIT_DEADLINE_MS: u64 = 5_000;

/// How long the webview has to prepare before the app exits anyway.
pub const QUIT_DEADLINE: Duration = Duration::from_millis(QUIT_DEADLINE_MS);

/// Where a quit stands.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
enum Phase {
    #[default]
    Idle,
    Preparing,
    Exiting,
}

// Closed-smoke observations come from the real gate decisions and deadline thread.
#[cfg(feature = "native-read-smoke")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SmokePhase {
    Idle,
    Preparing,
    Exiting,
}

#[cfg(feature = "native-read-smoke")]
impl From<Phase> for SmokePhase {
    fn from(phase: Phase) -> Self {
        match phase {
            Phase::Idle => Self::Idle,
            Phase::Preparing => Self::Preparing,
            Phase::Exiting => Self::Exiting,
        }
    }
}

#[cfg(feature = "native-read-smoke")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct SmokePending {
    pub epoch: u64,
    pub armed_at: Option<Instant>,
    pub duration: Duration,
}

#[cfg(feature = "native-read-smoke")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SmokeDecision {
    Admitted {
        epoch: u64,
    },
    Armed {
        epoch: u64,
    },
    Cancel {
        epoch: u64,
        before: SmokePhase,
        after: SmokePhase,
        cancelled: bool,
    },
    Deadline {
        timer_epoch: u64,
        gate_epoch: u64,
        before: SmokePhase,
        after: SmokePhase,
        exits: bool,
    },
}

#[cfg(feature = "native-read-smoke")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct SmokeEntry {
    pub sequence: u64,
    pub captured_at: Instant,
    pub decision: SmokeDecision,
}

#[cfg(feature = "native-read-smoke")]
#[derive(Debug, Clone)]
pub(crate) struct SmokeObservation {
    pub observed_at: Instant,
    pub phase: SmokePhase,
    pub epoch: u64,
    pub pending: Option<SmokePending>,
    pub entries: Vec<SmokeEntry>,
    pub broken: bool,
}

#[cfg(feature = "native-read-smoke")]
const SMOKE_ENTRY_CAP: usize = 192;

#[cfg(feature = "native-read-smoke")]
#[derive(Debug)]
struct SmokeJournal {
    // Keep the first bounded evidence; overflow invalidates it without blocking quit.
    entries: [Option<SmokeEntry>; SMOKE_ENTRY_CAP],
    next_sequence: u64,
    broken: bool,
}

#[cfg(feature = "native-read-smoke")]
impl Default for SmokeJournal {
    fn default() -> Self {
        Self {
            entries: [None; SMOKE_ENTRY_CAP],
            next_sequence: 0,
            broken: false,
        }
    }
}

#[cfg(feature = "native-read-smoke")]
impl SmokeJournal {
    fn record(&mut self, decision: SmokeDecision) {
        if self.next_sequence >= SMOKE_ENTRY_CAP as u64 {
            self.broken = true;
            return;
        }
        let index = self.next_sequence as usize;
        self.next_sequence += 1;
        self.entries[index] = Some(SmokeEntry {
            sequence: self.next_sequence,
            captured_at: Instant::now(),
            decision,
        });
    }
}

/// What a quit request does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    /// Ask the webview to prepare; `epoch` names this attempt.
    Prepare { epoch: u64 },
    /// A quit is already preparing or exiting: its deadline bounds the wait.
    Wait,
}

/// The quit state machine: Idle, then Preparing, then Exiting. The epoch
/// tells one attempt's deadline from the next attempt's, so a cancelled
/// quit's timer cannot end a later one early.
#[derive(Debug, Default)]
pub struct QuitGate {
    phase: Phase,
    epoch: u64,
    #[cfg(feature = "native-read-smoke")]
    smoke: SmokeJournal,
}

impl QuitGate {
    /// A quit was asked for.
    pub fn request(&mut self) -> Step {
        match self.phase {
            Phase::Idle => {
                self.phase = Phase::Preparing;
                self.epoch += 1;
                #[cfg(feature = "native-read-smoke")]
                self.smoke
                    .record(SmokeDecision::Admitted { epoch: self.epoch });
                Step::Prepare { epoch: self.epoch }
            }
            Phase::Preparing | Phase::Exiting => Step::Wait,
        }
    }

    /// The webview finished preparing. True when the app should exit now.
    pub fn ready(&mut self) -> bool {
        if self.phase == Phase::Preparing {
            self.phase = Phase::Exiting;
            true
        } else {
            false
        }
    }

    /// The webview stayed open. True when a prepare was cancelled.
    pub fn cancel(&mut self) -> bool {
        #[cfg(feature = "native-read-smoke")]
        let before = self.phase.into();
        if self.phase == Phase::Preparing {
            self.phase = Phase::Idle;
            #[cfg(feature = "native-read-smoke")]
            self.smoke.record(SmokeDecision::Cancel {
                epoch: self.epoch,
                before,
                after: self.phase.into(),
                cancelled: true,
            });
            true
        } else {
            #[cfg(feature = "native-read-smoke")]
            self.smoke.record(SmokeDecision::Cancel {
                epoch: self.epoch,
                before,
                after: self.phase.into(),
                cancelled: false,
            });
            false
        }
    }

    /// Attempt `epoch`'s deadline passed. True when that same attempt is
    /// still preparing, so the app should exit without it.
    pub fn deadline(&mut self, epoch: u64) -> bool {
        #[cfg(feature = "native-read-smoke")]
        let before = self.phase.into();
        if self.phase == Phase::Preparing && self.epoch == epoch {
            self.phase = Phase::Exiting;
            #[cfg(feature = "native-read-smoke")]
            self.smoke.record(SmokeDecision::Deadline {
                timer_epoch: epoch,
                gate_epoch: self.epoch,
                before,
                after: self.phase.into(),
                exits: true,
            });
            true
        } else {
            #[cfg(feature = "native-read-smoke")]
            self.smoke.record(SmokeDecision::Deadline {
                timer_epoch: epoch,
                gate_epoch: self.epoch,
                before,
                after: self.phase.into(),
                exits: false,
            });
            false
        }
    }

    /// Called only by the actual deadline thread, with its captured attempt.
    #[cfg(feature = "native-read-smoke")]
    fn note_deadline_arm(&mut self, epoch: u64) {
        self.smoke.record(SmokeDecision::Armed { epoch });
    }
}

/// The app's one gate, managed in `run`.
#[derive(Debug, Default)]
pub struct QuitState {
    gate: Mutex<QuitGate>,
}

impl QuitState {
    /// The gate. A thread that panicked holding it leaves a valid state
    /// machine, and quitting must always work, so a poisoned lock is
    /// recovered.
    fn gate(&self) -> MutexGuard<'_, QuitGate> {
        self.gate.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Read the actual gate once. Missing producer evidence stays unavailable.
    #[cfg(feature = "native-read-smoke")]
    pub(crate) fn smoke_observation(&self) -> SmokeObservation {
        let gate = self.gate();
        let observed_at = Instant::now();
        let phase = match gate.phase {
            Phase::Idle => SmokePhase::Idle,
            Phase::Preparing => SmokePhase::Preparing,
            Phase::Exiting => SmokePhase::Exiting,
        };
        let entries: Vec<_> = gate.smoke.entries.iter().flatten().copied().collect();
        let armed_at = entries.iter().rev().find_map(|entry| match entry.decision {
            SmokeDecision::Armed { epoch } if epoch == gate.epoch => Some(entry.captured_at),
            _ => None,
        });
        let pending = (gate.phase == Phase::Preparing).then_some(SmokePending {
            epoch: gate.epoch,
            armed_at,
            duration: QUIT_DEADLINE,
        });
        let ordered = entries
            .iter()
            .enumerate()
            .all(|(index, entry)| entry.sequence == index as u64 + 1);
        let complete = gate.smoke.next_sequence == entries.len() as u64;
        SmokeObservation {
            observed_at,
            phase,
            epoch: gate.epoch,
            pending,
            entries,
            broken: gate.smoke.broken || !ordered || !complete,
        }
    }
}

/// The payload of [`QUIT_REQUESTED_EVENT`].
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuitRequest {
    /// How long the webview has before the app exits anyway.
    pub deadline_ms: u64,
}

/// Ask the webview to prepare for a quit, and exit at [`QUIT_DEADLINE`] if
/// it has not finished. A second request while one runs waits for it.
pub fn request<R: Runtime>(app: &AppHandle<R>) {
    let step = app.state::<QuitState>().gate().request();
    let Step::Prepare { epoch } = step else {
        return;
    };
    let payload = QuitRequest {
        deadline_ms: QUIT_DEADLINE_MS,
    };
    if let Err(err) = app.emit(QUIT_REQUESTED_EVENT, payload) {
        log::warn!("the quit request could not reach the webview ({err}), so Cerebro quits now");
        app.exit(0);
        return;
    }
    let handle = app.clone();
    let spawned = std::thread::Builder::new()
        .name("cerebro-quit-deadline".into())
        .spawn(move || {
            #[cfg(feature = "native-read-smoke")]
            {
                handle.state::<QuitState>().gate().note_deadline_arm(epoch);
            }
            std::thread::sleep(QUIT_DEADLINE);
            if handle.state::<QuitState>().gate().deadline(epoch) {
                log::warn!(
                    "the webview did not finish saving within {QUIT_DEADLINE_MS} ms, so Cerebro quits without it"
                );
                handle.exit(0);
            }
        });
    if let Err(err) = spawned {
        // The app must always be able to quit.
        log::warn!("the quit deadline could not start ({err}), so Cerebro quits now");
        app.exit(0);
    }
}

/// The webview saved everything: exit.
#[tauri::command]
pub fn finish_quit(
    app: tauri::AppHandle,
    state: tauri::State<'_, QuitState>,
) -> Result<(), String> {
    if state.gate().ready() {
        app.exit(0);
        Ok(())
    } else {
        Err("no quit is in progress".into())
    }
}

/// A save failed: the webview stays open.
#[tauri::command]
pub fn cancel_quit(state: tauri::State<'_, QuitState>) {
    state.gate().cancel();
}

/// One entry of the menu.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Item {
    About,
    Separator,
    Services,
    Hide,
    HideOthers,
    /// Cerebro's own Quit, which saves first.
    Quit,
    CloseWindow,
    Undo,
    Redo,
    Cut,
    Copy,
    Paste,
    SelectAll,
    Fullscreen,
    Minimize,
    Maximize,
}

/// One submenu: its id when tauri names it, its title (`None` is the
/// package name) and its entries.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Sub {
    pub id: Option<&'static str>,
    pub title: Option<&'static str>,
    pub items: &'static [Item],
}

/// Tauri 2.12.4's macOS default menu (menu.rs:142-241), with one change: the
/// app submenu's Quit is [`Item::Quit`]. The Edit entries carry WKWebView's
/// clipboard and undo keys, so dropping one breaks ⌘C, ⌘V, ⌘X, ⌘Z or ⌘A in
/// every page. Linux compiles this table and never shows it.
pub const MENU: &[Sub] = &[
    Sub {
        id: None,
        title: None,
        items: &[
            Item::About,
            Item::Separator,
            Item::Services,
            Item::Separator,
            Item::Hide,
            Item::HideOthers,
            Item::Separator,
            Item::Quit,
        ],
    },
    Sub {
        id: None,
        title: Some("File"),
        items: &[Item::CloseWindow],
    },
    Sub {
        id: None,
        title: Some("Edit"),
        items: &[
            Item::Undo,
            Item::Redo,
            Item::Separator,
            Item::Cut,
            Item::Copy,
            Item::Paste,
            Item::SelectAll,
        ],
    },
    Sub {
        id: None,
        title: Some("View"),
        items: &[Item::Fullscreen],
    },
    Sub {
        id: Some(WINDOW_SUBMENU_ID),
        title: Some("Window"),
        items: &[
            Item::Minimize,
            Item::Maximize,
            Item::Separator,
            Item::CloseWindow,
        ],
    },
    Sub {
        id: Some(HELP_SUBMENU_ID),
        title: Some("Help"),
        items: &[],
    },
];

fn build_item<R: Runtime>(
    app: &AppHandle<R>,
    item: Item,
    about: &AboutMetadata<'static>,
) -> tauri::Result<Box<dyn IsMenuItem<R>>> {
    Ok(match item {
        Item::About => Box::new(PredefinedMenuItem::about(app, None, Some(about.clone()))?),
        Item::Separator => Box::new(PredefinedMenuItem::separator(app)?),
        Item::Services => Box::new(PredefinedMenuItem::services(app, None)?),
        Item::Hide => Box::new(PredefinedMenuItem::hide(app, None)?),
        Item::HideOthers => Box::new(PredefinedMenuItem::hide_others(app, None)?),
        Item::Quit => Box::new(MenuItem::with_id(
            app,
            QUIT_MENU_ID,
            "Quit Cerebro",
            true,
            Some("CmdOrCtrl+Q"),
        )?),
        Item::CloseWindow => Box::new(PredefinedMenuItem::close_window(app, None)?),
        Item::Undo => Box::new(PredefinedMenuItem::undo(app, None)?),
        Item::Redo => Box::new(PredefinedMenuItem::redo(app, None)?),
        Item::Cut => Box::new(PredefinedMenuItem::cut(app, None)?),
        Item::Copy => Box::new(PredefinedMenuItem::copy(app, None)?),
        Item::Paste => Box::new(PredefinedMenuItem::paste(app, None)?),
        Item::SelectAll => Box::new(PredefinedMenuItem::select_all(app, None)?),
        Item::Fullscreen => Box::new(PredefinedMenuItem::fullscreen(app, None)?),
        Item::Minimize => Box::new(PredefinedMenuItem::minimize(app, None)?),
        Item::Maximize => Box::new(PredefinedMenuItem::maximize(app, None)?),
    })
}

/// The app's menu, built from [`MENU`]. Passed to the builder's `.menu`.
pub fn app_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let pkg_info = app.package_info();
    let config = app.config();
    // The same metadata tauri's default About shows.
    let about = AboutMetadata {
        name: Some(pkg_info.name.clone()),
        version: Some(pkg_info.version.to_string()),
        copyright: config.bundle.copyright.clone(),
        authors: config.bundle.publisher.clone().map(|p| vec![p]),
        ..Default::default()
    };
    let mut subs = Vec::with_capacity(MENU.len());
    for sub in MENU {
        let items = sub
            .items
            .iter()
            .map(|&item| build_item(app, item, &about))
            .collect::<tauri::Result<Vec<_>>>()?;
        let refs: Vec<&dyn IsMenuItem<R>> = items.iter().map(AsRef::as_ref).collect();
        let title = sub
            .title
            .map_or_else(|| pkg_info.name.clone(), str::to_owned);
        subs.push(match sub.id {
            Some(id) => Submenu::with_id_and_items(app, id, title, true, &refs)?,
            None => Submenu::with_items(app, title, true, &refs)?,
        });
    }
    let refs: Vec<&dyn IsMenuItem<R>> = subs.iter().map(|sub| sub as &dyn IsMenuItem<R>).collect();
    Menu::with_items(app, &refs)
}

/// The builder's menu handler: Quit Cerebro asks the webview first.
pub fn on_menu_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    if *event.id() == QUIT_MENU_ID {
        request(app);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(feature = "native-read-smoke")]
    #[test]
    fn smoke_actual_state_and_absent_arm_are_read_without_invention() {
        let state = QuitState::default();
        let before = Instant::now();
        let idle = state.smoke_observation();
        assert_eq!(idle.phase, SmokePhase::Idle);
        assert_eq!(idle.epoch, 0);
        assert_eq!(idle.pending, None);
        assert!(idle.entries.is_empty());
        assert!(!idle.broken);
        assert!(before <= idle.observed_at && idle.observed_at <= Instant::now());

        assert_eq!(state.gate().request(), Step::Prepare { epoch: 1 });
        let pending = state.smoke_observation();
        assert_eq!(pending.phase, SmokePhase::Preparing);
        assert_eq!(pending.epoch, 1);
        assert_eq!(
            pending.pending,
            Some(SmokePending {
                epoch: 1,
                armed_at: None,
                duration: QUIT_DEADLINE,
            })
        );
        assert!(!pending.broken);
        // Calling the real gate directly does not create its request thread.
        // An observed epoch must never be promoted into an invented timer arm.
        assert!(state.gate().cancel());
        let cancelled = state.smoke_observation();
        assert_eq!(cancelled.phase, SmokePhase::Idle);
        assert_eq!(cancelled.epoch, 1);
        assert_eq!(cancelled.pending, None);
    }

    #[cfg(feature = "native-read-smoke")]
    #[test]
    fn smoke_returned_snapshot_cannot_mutate_or_replay_the_actual_gate() {
        let state = QuitState::default();
        assert_eq!(state.gate().request(), Step::Prepare { epoch: 1 });
        let mut copy = state.smoke_observation();
        let entries = copy.entries.clone();
        let first_read_at = copy.observed_at;
        copy.phase = SmokePhase::Exiting;
        copy.epoch = 999;
        copy.pending = None;
        copy.entries.clear();
        let again = state.smoke_observation();
        assert_eq!(again.phase, SmokePhase::Preparing);
        assert_eq!(again.epoch, 1);
        assert_eq!(
            again.pending,
            Some(SmokePending {
                epoch: 1,
                armed_at: None,
                duration: QUIT_DEADLINE,
            })
        );
        assert_eq!(again.entries, entries);
        assert!(again.observed_at >= first_read_at);
        assert_eq!(state.gate().request(), Step::Wait);
        assert!(state.gate().cancel());
        assert_eq!(
            copy.phase,
            SmokePhase::Exiting,
            "only the detached copy changed"
        );
        assert_eq!(copy.epoch, 999);
        assert_eq!(copy.pending, None);
        assert!(copy.entries.is_empty());
    }

    #[cfg(feature = "native-read-smoke")]
    #[test]
    fn smoke_records_actual_successful_and_refused_cancel_decisions() {
        let state = QuitState::default();
        let before = Instant::now();
        assert_eq!(state.gate().request(), Step::Prepare { epoch: 1 });
        assert!(state.gate().cancel());
        assert!(!state.gate().cancel());
        let observed = state.smoke_observation();
        assert_eq!(observed.phase, SmokePhase::Idle);
        assert_eq!(observed.pending, None);
        assert_eq!(
            observed
                .entries
                .iter()
                .map(|entry| entry.decision)
                .collect::<Vec<_>>(),
            vec![
                SmokeDecision::Admitted { epoch: 1 },
                SmokeDecision::Cancel {
                    epoch: 1,
                    before: SmokePhase::Preparing,
                    after: SmokePhase::Idle,
                    cancelled: true
                },
                SmokeDecision::Cancel {
                    epoch: 1,
                    before: SmokePhase::Idle,
                    after: SmokePhase::Idle,
                    cancelled: false
                },
            ]
        );
        assert_eq!(
            observed
                .entries
                .iter()
                .map(|entry| entry.sequence)
                .collect::<Vec<_>>(),
            vec![1, 2, 3]
        );
        assert!(observed
            .entries
            .iter()
            .all(|entry| before <= entry.captured_at && entry.captured_at <= observed.observed_at));
        assert!(observed
            .entries
            .windows(2)
            .all(|pair| pair[0].captured_at <= pair[1].captured_at));
        assert!(!observed.broken);
    }

    #[cfg(feature = "native-read-smoke")]
    #[test]
    fn smoke_records_old_timer_epoch_and_actual_new_gate_epoch_separately() {
        let state = QuitState::default();
        {
            let mut gate = state.gate();
            assert_eq!(gate.request(), Step::Prepare { epoch: 1 });
            assert!(gate.cancel());
            assert_eq!(gate.request(), Step::Prepare { epoch: 2 });
            assert!(!gate.deadline(1));
            assert_eq!(gate.phase, Phase::Preparing);
            assert!(gate.deadline(2));
            assert_eq!(gate.phase, Phase::Exiting);
            assert!(!gate.cancel());
        }
        let observed = state.smoke_observation();
        assert_eq!(observed.phase, SmokePhase::Exiting);
        assert_eq!(observed.epoch, 2);
        assert_eq!(observed.pending, None);
        assert_eq!(
            observed
                .entries
                .iter()
                .map(|entry| entry.decision)
                .collect::<Vec<_>>(),
            vec![
                SmokeDecision::Admitted { epoch: 1 },
                SmokeDecision::Cancel {
                    epoch: 1,
                    before: SmokePhase::Preparing,
                    after: SmokePhase::Idle,
                    cancelled: true
                },
                SmokeDecision::Admitted { epoch: 2 },
                SmokeDecision::Deadline {
                    timer_epoch: 1,
                    gate_epoch: 2,
                    before: SmokePhase::Preparing,
                    after: SmokePhase::Preparing,
                    exits: false
                },
                SmokeDecision::Deadline {
                    timer_epoch: 2,
                    gate_epoch: 2,
                    before: SmokePhase::Preparing,
                    after: SmokePhase::Exiting,
                    exits: true
                },
                SmokeDecision::Cancel {
                    epoch: 2,
                    before: SmokePhase::Exiting,
                    after: SmokePhase::Exiting,
                    cancelled: false
                },
            ]
        );
        assert_eq!(
            observed
                .entries
                .iter()
                .map(|entry| entry.sequence)
                .collect::<Vec<_>>(),
            vec![1, 2, 3, 4, 5, 6]
        );
        assert!(!observed.broken);
    }

    #[cfg(feature = "native-read-smoke")]
    #[test]
    fn smoke_duplicate_requests_do_not_create_observed_admissions() {
        let state = QuitState::default();
        assert_eq!(state.gate().request(), Step::Prepare { epoch: 1 });
        assert_eq!(state.gate().request(), Step::Wait);
        assert_eq!(state.gate().request(), Step::Wait);
        let observed = state.smoke_observation();
        assert_eq!(observed.phase, SmokePhase::Preparing);
        assert_eq!(observed.pending.unwrap().epoch, 1);
        assert_eq!(
            observed
                .entries
                .iter()
                .map(|entry| entry.decision)
                .collect::<Vec<_>>(),
            vec![SmokeDecision::Admitted { epoch: 1 }]
        );
        assert_eq!(observed.entries[0].sequence, 1);
        assert!(!observed.broken);
    }

    #[cfg(feature = "native-read-smoke")]
    #[test]
    fn smoke_overflow_preserves_evidence_without_blocking_quit() {
        let state = QuitState::default();
        for epoch in 1..=96 {
            assert_eq!(state.gate().request(), Step::Prepare { epoch });
            assert!(state.gate().cancel());
        }
        let full = state.smoke_observation();
        assert_eq!(full.entries.len(), 192);
        assert_eq!(full.entries.first().unwrap().sequence, 1);
        assert_eq!(full.entries.last().unwrap().sequence, 192);
        assert_eq!(full.phase, SmokePhase::Idle);
        assert!(!full.broken, "the last available entry is still recorded");

        assert_eq!(state.gate().request(), Step::Prepare { epoch: 97 });
        let overflowed = state.smoke_observation();
        assert!(
            overflowed.broken,
            "the first lost entry invalidates evidence"
        );
        assert_eq!(
            overflowed.entries, full.entries,
            "never overwrite old evidence"
        );
        assert_eq!(overflowed.phase, SmokePhase::Preparing);
        assert_eq!(overflowed.epoch, 97);
        assert_eq!(overflowed.pending.unwrap().armed_at, None);
        assert_eq!(state.gate().request(), Step::Wait);
        assert!(!state.gate().deadline(96));
        assert!(state.gate().cancel());
        assert_eq!(state.gate().request(), Step::Prepare { epoch: 98 });
        assert!(state.gate().deadline(98));
        assert!(!state.gate().cancel());
        let after = state.smoke_observation();
        assert!(
            after.broken,
            "reads and later operations cannot clear lost evidence"
        );
        assert_eq!(after.entries, full.entries);
        assert_eq!(after.phase, SmokePhase::Exiting);
        assert_eq!(after.epoch, 98);
        assert_eq!(after.pending, None);
    }

    /// A file's half before its test module.
    fn non_test_half(source: &str) -> &str {
        source
            .split("#[cfg(test)]\nmod tests")
            .next()
            .expect("the non-test half")
    }

    #[test]
    fn a_quit_request_prepares_once() {
        let mut gate = QuitGate::default();
        assert_eq!(gate.request(), Step::Prepare { epoch: 1 });
        assert_eq!(gate.request(), Step::Wait, "a second ⌘Q waits");
        assert_eq!(gate.request(), Step::Wait);
        assert!(gate.ready());
        assert_eq!(
            gate.request(),
            Step::Wait,
            "an exiting app does not prepare again"
        );
    }

    #[test]
    fn ready_exits_only_while_preparing() {
        let mut gate = QuitGate::default();
        assert!(!gate.ready(), "no quit is in progress");
        gate.request();
        assert!(gate.ready());
        assert!(!gate.ready(), "the app is already exiting");
        assert!(!gate.cancel(), "an exit cannot be cancelled");
    }

    #[test]
    fn a_cancel_returns_to_idle_and_its_deadline_is_void() {
        let mut gate = QuitGate::default();
        assert_eq!(gate.request(), Step::Prepare { epoch: 1 });
        assert!(gate.cancel());
        assert!(!gate.cancel(), "nothing is left to cancel");
        assert!(
            !gate.deadline(1),
            "the cancelled attempt's deadline exits nothing"
        );
        assert_eq!(gate.request(), Step::Prepare { epoch: 2 });
        assert!(
            !gate.deadline(1),
            "the old deadline cannot end the new attempt"
        );
        assert!(gate.deadline(2));
    }

    #[test]
    fn the_deadline_exits_only_its_own_attempt() {
        let mut gate = QuitGate::default();
        assert!(!gate.deadline(0), "idle");
        let Step::Prepare { epoch } = gate.request() else {
            panic!("an idle gate prepares");
        };
        assert!(!gate.deadline(epoch + 1));
        assert!(gate.deadline(epoch));
        assert!(!gate.deadline(epoch), "already exiting");
        assert!(
            !gate.ready(),
            "the deadline won, so the late finish exits nothing twice"
        );
    }

    #[test]
    fn a_poisoned_gate_still_quits() {
        let state = std::sync::Arc::new(QuitState::default());
        let held = std::sync::Arc::clone(&state);
        let _ = std::thread::spawn(move || {
            let _guard = held.gate();
            panic!("poison the gate");
        })
        .join();
        assert!(state.gate.is_poisoned());
        assert_eq!(state.gate().request(), Step::Prepare { epoch: 1 });
    }

    #[test]
    fn the_request_names_its_deadline() {
        let payload = QuitRequest {
            deadline_ms: QUIT_DEADLINE_MS,
        };
        assert_eq!(
            serde_json::to_value(payload).unwrap(),
            serde_json::json!({ "deadlineMs": 5000 })
        );
        assert!(QUIT_DEADLINE >= Duration::from_secs(3) && QUIT_DEADLINE <= Duration::from_secs(5));
        assert_eq!(QUIT_DEADLINE.as_millis(), u128::from(QUIT_DEADLINE_MS));
    }

    #[test]
    fn the_menu_is_tauris_macos_default_with_our_quit() {
        use Item::*;
        let expected: &[(Option<&str>, Option<&str>, &[Item])] = &[
            (
                None,
                None,
                &[
                    About, Separator, Services, Separator, Hide, HideOthers, Separator, Quit,
                ],
            ),
            (None, Some("File"), &[CloseWindow]),
            (
                None,
                Some("Edit"),
                &[Undo, Redo, Separator, Cut, Copy, Paste, SelectAll],
            ),
            (None, Some("View"), &[Fullscreen]),
            (
                Some(WINDOW_SUBMENU_ID),
                Some("Window"),
                &[Minimize, Maximize, Separator, CloseWindow],
            ),
            (Some(HELP_SUBMENU_ID), Some("Help"), &[]),
        ];
        let actual: Vec<_> = MENU.iter().map(|s| (s.id, s.title, s.items)).collect();
        assert_eq!(actual, expected.to_vec());
        let quits = MENU
            .iter()
            .flat_map(|s| s.items)
            .filter(|&&item| item == Quit)
            .count();
        assert_eq!(quits, 1, "one Quit, and it is ours");
    }

    #[test]
    fn the_edit_menu_keeps_the_clipboard_keys() {
        let edit = MENU
            .iter()
            .find(|s| s.title == Some("Edit"))
            .expect("an Edit submenu");
        for key in [
            Item::Undo,
            Item::Redo,
            Item::Cut,
            Item::Copy,
            Item::Paste,
            Item::SelectAll,
        ] {
            assert!(
                edit.items.contains(&key),
                "WKWebView needs {key:?} in the menu for its key"
            );
        }
    }

    #[test]
    fn no_predefined_quit_is_built() {
        // Split so this file's own test half does not name it whole.
        let needle = concat!("PredefinedMenuItem::", "quit");
        let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut scanned = 0;
        for entry in walkdir::WalkDir::new(&src) {
            let entry = entry.expect("src-tauri/src is readable");
            let path = entry.path();
            if path.extension().is_none_or(|e| e != "rs") {
                continue;
            }
            scanned += 1;
            let source = std::fs::read_to_string(path).expect("a source file reads");
            assert!(
                !non_test_half(&source).contains(needle),
                "{} builds the predefined Quit, which exits without saving: use shell::quit's item",
                path.display()
            );
        }
        assert!(
            scanned > 50,
            "the scan is walking the real tree ({scanned} files)"
        );
    }

    #[test]
    fn the_quit_is_wired() {
        let lib = non_test_half(include_str!("../lib.rs"));
        for wire in [
            ".manage(shell::quit::QuitState::default())",
            ".menu(shell::quit::app_menu)",
            ".on_menu_event(shell::quit::on_menu_event)",
            "shell::quit::finish_quit",
            "shell::quit::cancel_quit",
        ] {
            assert!(lib.contains(wire), "lib.rs lost {wire:?}");
        }
        // ipcContract.test.ts holds the emit to the webview's listener.
        let here = non_test_half(include_str!("quit.rs"));
        assert!(here.contains("\"cerebro-quit-deadline\""));
    }
}
