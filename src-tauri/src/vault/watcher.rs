//! Vault file watcher: notify-based, 350 ms debounce, own-write suppression.
//!
//! Own-write recognition is content-hash-first since M21.6: the write
//! funnel records the SHA-256 of what it wrote, and a change event on a
//! path whose CURRENT bytes hash to that record is a no-op regardless of
//! timing — a projection burst that outlives any window is still our own
//! write, and a foreign write two seconds after ours is still foreign. The
//! 4-second window survives only for own-writes that have no meaningful
//! content hash (renames, deletes, attachment copies) — a UI-refresh
//! debounce heuristic, no longer the authority. Groundwork for the M23
//! projection manifest; no capture behavior yet.

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

/// One registered own-write: when it happened, and — for content writes —
/// the SHA-256 of exactly what was written.
#[derive(Debug, Clone)]
pub struct OwnWrite {
    pub at: Instant,
    pub content_hash: Option<String>,
}

/// Pure suppression decision for one registered own-write (M21.6).
///
/// A hashed record is matched by CONTENT, never by clock: the event is ours
/// iff the file's current bytes hash to what we wrote — however much later
/// the event arrives, and never when the bytes differ (the exact hole the
/// time window had: a foreign write landing inside it was swallowed).
/// An unhashed record (rename, delete, attachment copy) keeps the window
/// heuristic.
pub fn own_write_suppresses(
    own: &OwnWrite,
    current_hash: Option<&str>,
    now: Instant,
    window: Duration,
) -> bool {
    match &own.content_hash {
        Some(written) => current_hash == Some(written.as_str()),
        None => own_write_active(own.at, now, window),
    }
}

/// Vault-relative paths that should trigger a rescan: `.md`, `.mmd`, or
/// `.yml` files with no dot-prefixed component.
pub fn is_relevant_path(path: &Path) -> bool {
    let hidden = path
        .components()
        .any(|c| c.as_os_str().to_string_lossy().starts_with('.'));
    if hidden {
        return false;
    }
    matches!(
        path.extension().and_then(|e| e.to_str()),
        Some("md") | Some("mmd") | Some("yml")
    )
}

fn own_writes() -> &'static Mutex<HashMap<PathBuf, OwnWrite>> {
    static MAP: OnceLock<Mutex<HashMap<PathBuf, OwnWrite>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Best-effort canonicalization so registered paths match the (possibly
/// symlink-resolved) paths reported by the OS watcher.
fn normalize(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

fn insert_own_write(path: &Path, content_hash: Option<String>) {
    if let Ok(mut map) = own_writes().lock() {
        let now = Instant::now();
        // Prune expired WINDOW entries only: a hashed record's authority is
        // content, not clock, so it stays until overwritten (one entry per
        // path — the map is bounded by paths written this session).
        map.retain(|_, own| {
            own.content_hash.is_some() || own_write_active(own.at, now, OWN_WRITE_WINDOW)
        });
        map.insert(
            normalize(path),
            OwnWrite {
                at: now,
                content_hash,
            },
        );
    }
}

/// Record a structural own-write (rename, delete, attachment copy) — no
/// meaningful content hash, so only the time window suppresses its echo.
pub fn note_own_write(path: &Path) {
    insert_own_write(path, None);
}

/// Record a content own-write with the SHA-256 of exactly what was written
/// (called from the write funnel). Its echo is recognized by hash,
/// regardless of timing.
pub fn note_own_write_hashed(path: &Path, content_hash: String) {
    insert_own_write(path, Some(content_hash));
}

/// Is this change event our own write coming back? Hashed records compare
/// the file's CURRENT bytes against what we wrote; unhashed records fall
/// back to the window.
pub fn is_suppressed(path: &Path) -> bool {
    let normalized = normalize(path);
    let own = {
        let Ok(map) = own_writes().lock() else {
            return false;
        };
        map.get(&normalized).cloned()
        // Lock released before any disk IO below.
    };
    let Some(own) = own else {
        return false;
    };
    let current_hash = match own.content_hash {
        Some(_) => std::fs::read(&normalized)
            .ok()
            .map(|bytes| crate::ledger::sha256_hex(&bytes)),
        None => None,
    };
    own_write_suppresses(
        &own,
        current_hash.as_deref(),
        Instant::now(),
        OWN_WRITE_WINDOW,
    )
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

    // The M21.6 test the plan names: the exact hole the time window has —
    // a FOREIGN write landing inside the 4s window after an app write used
    // to be swallowed as our own echo. Content-hash recognition must not
    // swallow it.
    #[test]
    fn a_foreign_write_inside_the_window_is_not_suppressed() {
        let dir = crate::vault::testutil::temp_vault("watcher-foreign");
        let file = dir.join("note.md");
        std::fs::write(&file, "app content").unwrap();
        note_own_write_hashed(&file, crate::ledger::sha256_hex(b"app content"));
        assert!(is_suppressed(&file), "our own echo is recognized");
        // An external editor rewrites the file two ticks later — well
        // inside the old window.
        std::fs::write(&file, "foreign edit").unwrap();
        assert!(
            !is_suppressed(&file),
            "a foreign write must surface no matter how soon it lands"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn hashed_recognition_ignores_the_clock_entirely() {
        let t0 = Instant::now();
        let far_beyond_window = t0 + Duration::from_secs(600);
        let own = OwnWrite {
            at: t0,
            content_hash: Some("abc123".to_string()),
        };
        // Ten minutes later — a projection burst no window survives — the
        // matching echo is still ours…
        assert!(own_write_suppresses(
            &own,
            Some("abc123"),
            far_beyond_window,
            OWN_WRITE_WINDOW
        ));
        // …and a mismatch is foreign even INSIDE the window.
        assert!(!own_write_suppresses(
            &own,
            Some("other"),
            t0,
            OWN_WRITE_WINDOW
        ));
        assert!(!own_write_suppresses(&own, None, t0, OWN_WRITE_WINDOW));
        // Unhashed records (rename, delete) keep the window heuristic.
        let structural = OwnWrite {
            at: t0,
            content_hash: None,
        };
        assert!(own_write_suppresses(
            &structural,
            None,
            t0 + Duration::from_secs(3),
            OWN_WRITE_WINDOW
        ));
        assert!(!own_write_suppresses(
            &structural,
            None,
            far_beyond_window,
            OWN_WRITE_WINDOW
        ));
    }

    #[test]
    fn a_missing_file_under_a_hashed_record_is_a_real_change() {
        let dir = crate::vault::testutil::temp_vault("watcher-gone");
        let file = dir.join("note.md");
        std::fs::write(&file, "here").unwrap();
        note_own_write_hashed(&file, crate::ledger::sha256_hex(b"here"));
        std::fs::remove_file(&file).unwrap();
        assert!(
            !is_suppressed(&file),
            "a deletion under a content record must surface"
        );
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
        assert!(is_relevant_path(Path::new("diagrams/pipeline.mmd")));
        assert!(is_relevant_path(Path::new("views/all-items.yml")));
        assert!(!is_relevant_path(Path::new("attachments/logo.png")));
        assert!(!is_relevant_path(Path::new(".obsidian/workspace.md")));
        assert!(!is_relevant_path(Path::new("items/.hidden.md")));
    }
}
