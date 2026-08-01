//! Vault file watcher: notify-based, 350 ms debounce, own-write suppression.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use notify::{recommended_watcher, EventKind, RecursiveMode, Watcher};
use tauri::Emitter;

pub const VAULT_CHANGED_EVENT: &str = "vault-changed";
pub const DEBOUNCE: Duration = Duration::from_millis(350);
pub const OWN_WRITE_WINDOW: Duration = Duration::from_secs(4);

/// Pure debounce decision: flush when there are pending changes and the vault
/// has been quiet for at least `quiet`.
pub fn should_flush(
    pending: bool,
    last_event: Option<Instant>,
    now: Instant,
    quiet: Duration,
) -> bool {
    pending && last_event.is_some_and(|t| now.duration_since(t) >= quiet)
}

/// Pure suppression-window decision for a registered own-write.
pub fn own_write_active(registered: Instant, now: Instant, window: Duration) -> bool {
    now.duration_since(registered) < window
}

/// Vault-relative paths that should trigger a rescan: `.md` or `.yml` files
/// with no dot-prefixed component.
pub fn is_relevant_path(path: &Path) -> bool {
    let hidden = path
        .components()
        .any(|c| c.as_os_str().to_string_lossy().starts_with('.'));
    if hidden {
        return false;
    }
    matches!(
        path.extension().and_then(|e| e.to_str()),
        Some("md") | Some("yml")
    )
}

fn own_writes() -> &'static Mutex<HashMap<PathBuf, Instant>> {
    static MAP: OnceLock<Mutex<HashMap<PathBuf, Instant>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Best-effort canonicalization so registered paths match the (possibly
/// symlink-resolved) paths reported by the OS watcher.
fn normalize(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

/// Record that this process just wrote `path` (called from write.rs).
pub fn note_own_write(path: &Path) {
    if let Ok(mut map) = own_writes().lock() {
        let now = Instant::now();
        map.retain(|_, t| own_write_active(*t, now, OWN_WRITE_WINDOW));
        map.insert(normalize(path), now);
    }
}

/// True while `path` is inside the own-write suppression window.
pub fn is_suppressed(path: &Path) -> bool {
    let Ok(map) = own_writes().lock() else {
        return false;
    };
    map.get(&normalize(path))
        .is_some_and(|t| own_write_active(*t, Instant::now(), OWN_WRITE_WINDOW))
}

/// True when notify reports the OS event queue overflowed and changes were
/// lost (`Flag::Rescan`). Such events carry a directory path (macOS FSEvents)
/// or no path at all (Linux inotify), so per-path relevance checks would drop
/// them; they must force a `vault-changed` emit instead.
pub fn is_forced_rescan(event: &notify::Event) -> bool {
    event.need_rescan()
}

const POLL: Duration = Duration::from_millis(100);

/// Signal from the notify callback to the debounce thread.
enum WatchSignal {
    /// Changed paths, subject to relevance and own-write suppression checks.
    Paths(Vec<PathBuf>),
    /// OS events were lost (overflow); emit unconditionally after debounce.
    Force,
}

/// Managed Tauri state holding the active watcher. Replacing it drops the
/// previous watcher, which disconnects its channel and ends its thread.
#[derive(Default)]
pub struct WatcherState(pub Mutex<Option<notify::RecommendedWatcher>>);

/// Start (or replace) the vault watcher: recursive notify watcher feeding a
/// debounce thread that emits `vault-changed` (unit payload) to the frontend.
pub fn start(app: tauri::AppHandle, state: &WatcherState, vault: PathBuf) -> Result<(), String> {
    if !vault.is_dir() {
        return Err(format!("not a directory: {}", vault.display()));
    }
    let (tx, rx) = mpsc::channel::<WatchSignal>();
    let mut watcher = recommended_watcher(move |result: Result<notify::Event, notify::Error>| {
        if let Ok(event) = result {
            if is_forced_rescan(&event) {
                let _ = tx.send(WatchSignal::Force);
                return;
            }
            if matches!(event.kind, EventKind::Access(_)) {
                return;
            }
            let _ = tx.send(WatchSignal::Paths(event.paths));
        }
    })
    .map_err(|e| e.to_string())?;
    watcher
        .watch(&vault, RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;
    let vault_root = normalize(&vault);
    std::thread::spawn(move || debounce_loop(app, vault_root, rx));
    let mut slot = state
        .0
        .lock()
        .map_err(|_| "watcher state poisoned".to_string())?;
    *slot = Some(watcher);
    Ok(())
}

fn relevant_change(vault: &Path, path: &Path) -> bool {
    if is_suppressed(path) {
        return false;
    }
    let normalized = normalize(path);
    let rel = normalized.strip_prefix(vault).unwrap_or(&normalized);
    is_relevant_path(rel)
}

/// Collect change events; after 350 ms of quiet, emit one `vault-changed`.
/// Exits when the watcher (and thus the channel sender) is dropped.
fn debounce_loop(app: tauri::AppHandle, vault: PathBuf, rx: mpsc::Receiver<WatchSignal>) {
    let mut pending = false;
    let mut last_event: Option<Instant> = None;
    loop {
        match rx.recv_timeout(POLL) {
            Ok(WatchSignal::Force) => {
                pending = true;
                last_event = Some(Instant::now());
            }
            Ok(WatchSignal::Paths(paths)) => {
                if paths.iter().any(|p| relevant_change(&vault, p)) {
                    pending = true;
                    last_event = Some(Instant::now());
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return,
        }
        if should_flush(pending, last_event, Instant::now(), DEBOUNCE) {
            pending = false;
            last_event = None;
            let _ = app.emit(VAULT_CHANGED_EVENT, ());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_pending_changes_never_flush() {
        let now = Instant::now();
        assert!(!should_flush(false, None, now, DEBOUNCE));
        assert!(!should_flush(false, Some(now), now + DEBOUNCE, DEBOUNCE));
        assert!(!should_flush(true, None, now, DEBOUNCE));
    }

    #[test]
    fn pending_changes_flush_only_after_quiet_period() {
        let t0 = Instant::now();
        assert!(!should_flush(
            true,
            Some(t0),
            t0 + Duration::from_millis(200),
            DEBOUNCE
        ));
        assert!(should_flush(
            true,
            Some(t0),
            t0 + Duration::from_millis(350),
            DEBOUNCE
        ));
        assert!(should_flush(
            true,
            Some(t0),
            t0 + Duration::from_millis(500),
            DEBOUNCE
        ));
    }

    #[test]
    fn own_write_suppression_expires_after_window() {
        let t0 = Instant::now();
        assert!(own_write_active(
            t0,
            t0 + Duration::from_secs(3),
            OWN_WRITE_WINDOW
        ));
        assert!(!own_write_active(
            t0,
            t0 + Duration::from_secs(4),
            OWN_WRITE_WINDOW
        ));
    }

    #[test]
    fn registered_own_writes_are_suppressed() {
        let dir = crate::vault::testutil::temp_vault("watcher-own");
        let file = dir.join("note.md");
        std::fs::write(&file, "x").unwrap();
        assert!(!is_suppressed(&file));
        note_own_write(&file);
        assert!(is_suppressed(&file));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn overflow_rescan_events_force_an_emit() {
        use notify::event::{CreateKind, Flag};
        // Linux inotify overflow: EventKind::Other, no path, Flag::Rescan.
        let linux_overflow = notify::Event::new(EventKind::Other).set_flag(Flag::Rescan);
        assert!(is_forced_rescan(&linux_overflow));
        // macOS FSEvents overflow: directory path attached, Flag::Rescan.
        let mac_overflow = notify::Event::new(EventKind::Other)
            .add_path(PathBuf::from("/some/vault"))
            .set_flag(Flag::Rescan);
        assert!(is_forced_rescan(&mac_overflow));
        // Ordinary file events never force an unconditional emit.
        let plain = notify::Event::new(EventKind::Create(CreateKind::File))
            .add_path(PathBuf::from("/some/vault/items/a.md"));
        assert!(!is_forced_rescan(&plain));
    }

    #[test]
    fn only_md_and_yml_outside_dot_dirs_are_relevant() {
        assert!(is_relevant_path(Path::new("items/atl-1.md")));
        assert!(is_relevant_path(Path::new("views/all-items.yml")));
        assert!(!is_relevant_path(Path::new("attachments/logo.png")));
        assert!(!is_relevant_path(Path::new(".obsidian/workspace.md")));
        assert!(!is_relevant_path(Path::new("items/.hidden.md")));
    }
}
