//! Disk writes: frontmatter patching, note bodies, note creation, views.
//! Every write lands through `stage_temp` and `rename_into_place`, which
//! register own-writes with the watcher (Task 8) in one place: `write_file`
//! composes the two for one file, and the batch writer (`vault::batch`,
//! M60.6) stages every file of a change first and renames them after its
//! journal row says so. All caller-supplied paths are
//! validated by `safe_join`/`safe_component` — Task 7 exposes these functions
//! over IPC, so vault containment is enforced here, not in the callers. The
//! writers that change a NOTE go one step further through `note_join`, which
//! also refuses anything that is not a note (PLATFORM-API-1) — the same
//! mechanism under the agent's MCP doors and the human IPC commands — and the
//! ledger's projection writer goes through `bundle_join`, which keeps a
//! projection inside the bundle. Every write runs under its path lock
//! (`lock_paths`, M55.1): a writer that reads its file first holds the lock
//! from the read to the rename (`rewrite_note`), so two writes to one file
//! take turns and the second builds on the first. The agent's note writers
//! also run as a preview (`WriteMode::Preview`, M57.4c): every check the
//! write would make, on the bytes the lock holds now, and the landing it
//! would pick, with no temp file, no rename, no `vault_writes` row and no
//! announcement. A queued write is previewed before it waits in Review.
//!
//! Every writer takes a `WriteReceipt` (`vault::receipt`, M58.1) as its last
//! argument, minted by its door's guard: a person's (`Human`), a run's
//! (`Agent`), the bundle's (`ConceptDoor`) or the app's own (`System`). The
//! write records one `vault_writes` row under the receipt's stamp, or its
//! writer is in [`UNRECORDED`] with the reason it records nothing.

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::{Condvar, Mutex, OnceLock, PoisonError};
use std::thread::ThreadId;

use unicode_normalization::UnicodeNormalization;

use super::parse;
use super::receipt::{Agent, ConceptDoor, CreatesNotes, Door, Human, System, WriteReceipt};

/// Raw List file — a database: a source type, filters, and one view (M10).
///
/// Three shapes live on disk, and all three load:
/// - `<collection>/<id>.list.yml` — the M10 form, inside a Collection folder.
/// - `views/<id>.yml` — legacy vault-global; surfaces with no collection.
/// - `<project dir>/views/<id>.yml` — legacy project-scoped.
///
/// Nothing has to move for a vault written before M10 to keep working; the
/// legacy paths are read but never written back to.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ViewYaml {
    pub id: String,
    pub yaml: String,
    pub project: Option<String>,
    /// Folder of the owning Collection (the dir holding `collection.yml`);
    /// None for a top-level List, which is how legacy views surface.
    pub collection: Option<String>,
    /// Vault-relative file path — what a rename or delete operates on.
    pub path: String,
}

/// Raw Collection file: `<folder>/collection.yml`. A Collection is a container,
/// so it is a FOLDER, the same way a project is — containers on screen should be
/// containers on disk in a markdown app.
#[derive(Debug, Clone, serde::Serialize)]
pub struct CollectionYaml {
    /// Vault-relative folder path, e.g. "product".
    pub folder: String,
    pub yaml: String,
}

/// The `<name>.list.yml` suffix that marks a List file.
const LIST_SUFFIX: &str = ".list.yml";
/// The marker that makes a folder a Collection.
const COLLECTION_MARKER: &str = "collection.yml";

fn rel_path(vault: &Path, path: &Path) -> Result<String, String> {
    Ok(path
        .strip_prefix(vault)
        .map_err(|e| e.to_string())?
        .components()
        .map(|c| c.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/"))
}

/// Marker every atomic-write temp file carries: `.{name}.cerebro-tmp-{hex}`.
/// Dot-prefixed and non-`.md`, so the scanner and the watcher never see one.
const TEMP_MARKER: &str = ".cerebro-tmp-";

/// Marker a batch's staged temps carry instead (M60.6):
/// `.{name}.cerebro-batch-{hex}`. A batch stages every file before it renames
/// any, so its temps live as long as the batch; its journal row, not their
/// age, says whether they are still wanted.
pub(super) const BATCH_TEMP_MARKER: &str = ".cerebro-batch-";

/// How old a single write's temp must be before `clean_orphan_temps` may
/// reap it. The engine is stateless and concurrent commands re-scan
/// constantly, so an in-flight write's temp must never be reaped, and for a
/// single write age is the only guard.
const ORPHAN_TEMP_MAX_AGE: std::time::Duration = std::time::Duration::from_secs(60);

/// How old a batch temp must be before the janitor reaps it (M60.6). The
/// batch's journal guards it while the batch runs and recovery removes it
/// after a crash, so this only clears what both missed.
const ORPHAN_BATCH_TEMP_MAX_AGE: std::time::Duration = std::time::Duration::from_secs(24 * 60 * 60);

/// The single-file write: `content` staged beside `abs` (`stage_temp`),
/// renamed over it (`rename_into_place`) and the rename made durable
/// (`sync_dir`). Our own saves register with the watcher on the way, so they
/// don't bounce back as `vault-changed` events.
///
/// Atomic since M21.1: content lands in a same-directory temp, is fsynced,
/// then renamed over the destination, and the parent directory is fsynced so
/// the rename itself is durable. A crash at any point leaves either the old
/// bytes or the new bytes at the destination, never a truncated mix. Known
/// limitations (the same trade-off every atomic-save editor makes): xattrs
/// are not preserved across the rename, and a symlinked destination is
/// replaced by a regular file; plain permissions are preserved.
///
/// Every write runs under its path lock (M55.1): the funnel takes the
/// `PathLock` that covers `abs`, so a write outside one does not compile.
pub(super) fn write_file(lock: &PathLock, abs: &Path, content: &str) -> Result<(), String> {
    debug_assert!(
        lock.covers(abs),
        "{} is written outside its path lock",
        abs.display()
    );
    let parent = abs
        .parent()
        .ok_or_else(|| format!("no parent directory: {}", abs.display()))?;
    let temp = temp_beside(abs, TEMP_MARKER)?;
    let result = stage_temp(&temp, abs, content).and_then(|()| {
        rename_into_place(
            lock,
            &temp,
            abs,
            crate::ledger::sha256_hex(content.as_bytes()),
        )?;
        sync_dir(parent)
    });
    if result.is_err() {
        // Best-effort: after a successful rename the temp no longer exists,
        // and a failure here still gets reaped by clean_orphan_temps later.
        let _ = std::fs::remove_file(&temp);
    }
    result
}

/// A fresh temp name beside `abs`, carrying `marker`:
/// `.{name}{marker}{16 hex}`.
pub(super) fn temp_beside(abs: &Path, marker: &str) -> Result<PathBuf, String> {
    let parent = abs
        .parent()
        .ok_or_else(|| format!("no parent directory: {}", abs.display()))?;
    let name = abs
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| format!("unusable file name: {}", abs.display()))?;
    Ok(parent.join(format!(".{name}{marker}{:016x}", rand::random::<u64>())))
}

/// Stage `content` at `temp`, beside the file it will replace (`abs`): the
/// parent made, the bytes written, `abs`'s permissions copied over and the
/// file fsynced. Nothing at `abs` changes. Crash point `temp-written`.
pub(super) fn stage_temp(temp: &Path, abs: &Path, content: &str) -> Result<(), String> {
    use std::io::Write;

    if let Some(parent) = temp.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut file = std::fs::File::create(temp).map_err(|e| e.to_string())?;
    file.write_all(content.as_bytes())
        .map_err(|e| e.to_string())?;
    // Re-point permissions at the temp BEFORE the rename, so replacing the
    // destination cannot widen a user-tightened mode (chmod 600 stays 600).
    match std::fs::metadata(abs) {
        Ok(meta) => file
            .set_permissions(meta.permissions())
            .map_err(|e| e.to_string())?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.to_string()),
    }
    file.sync_all().map_err(|e| e.to_string())?;
    crate::crash::crash_point("temp-written");
    Ok(())
}

/// Rename a staged `temp` over `abs`, under the lock that holds `abs`, its
/// bytes' SHA-256 registered with the watcher first. Crash point
/// `renamed-pre-dirsync`; the rename is durable only after `sync_dir`.
pub(super) fn rename_into_place(
    lock: &PathLock,
    temp: &Path,
    abs: &Path,
    hash: String,
) -> Result<(), String> {
    debug_assert!(
        lock.covers(abs),
        "{} is renamed into outside its path lock",
        abs.display()
    );
    // Register BEFORE the rename: the suppression entry must exist by the
    // time the OS can deliver a change event for the destination path. With
    // the content hash (M21.6), so the echo is recognized by bytes, not by
    // clock.
    super::watcher::note_own_write_hashed(abs, hash);
    std::fs::rename(temp, abs).map_err(|e| e.to_string())?;
    crate::crash::crash_point("renamed-pre-dirsync");
    Ok(())
}

/// Make the renames into `dir` durable: the directory entry itself fsynced.
pub(super) fn sync_dir(dir: &Path) -> Result<(), String> {
    std::fs::File::open(dir)
        .and_then(|dir| dir.sync_all())
        .map_err(|e| e.to_string())
}

/// Reap atomic-write temps abandoned by a crash, anywhere in the vault
/// `write_file` writes: every folder but the dot-folders, plus the comment
/// sidecars under `.comments/` (M70.2) and the Trash's manifests under
/// `.trash/` (M60.8). Best-effort janitor run once per
/// `scan_vault` command. A single write's temp younger than
/// [`ORPHAN_TEMP_MAX_AGE`] may belong to a write in flight, and a batch's
/// younger than [`ORPHAN_BATCH_TEMP_MAX_AGE`] to a batch whose journal row
/// still names it (M60.6), so both are spared. Records nothing (see
/// [`UNRECORDED`]).
pub fn clean_orphan_temps(vault: &Path, _by: &WriteReceipt<System>) {
    let walker = walkdir::WalkDir::new(vault)
        .into_iter()
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            e.depth() == 0
                || e.file_type().is_file()
                || !name.starts_with('.')
                || (e.depth() == 1
                    && (name == super::comments::COMMENTS_DIR || name == super::trash::TRASH_DIR))
        })
        .filter_map(Result::ok);
    for item in walker {
        if !item.file_type().is_file() {
            continue;
        }
        let name = item.file_name().to_string_lossy();
        let max_age = if name.contains(TEMP_MARKER) {
            ORPHAN_TEMP_MAX_AGE
        } else if name.contains(BATCH_TEMP_MARKER) {
            ORPHAN_BATCH_TEMP_MAX_AGE
        } else {
            continue;
        };
        let stale = item
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| std::time::SystemTime::now().duration_since(t).ok())
            .is_some_and(|age| age >= max_age);
        if stale {
            let _ = std::fs::remove_file(item.path());
        }
    }
}

/// Join a vault-relative path onto the vault root, rejecting empty paths,
/// absolute paths (`Path::join` would replace the base!), any `..`
/// traversal, AND any symlink — planted anywhere along the path, leaf or
/// intermediate — that resolves outside the vault. The component check
/// alone only looks at the string; a name with no `..` in it can still be a
/// symlink pointing wherever it likes, so containment has to be verified
/// against the resolved filesystem path, not the requested one.
pub(super) fn safe_join(vault: &Path, rel: &str) -> Result<PathBuf, String> {
    resolve(vault, rel)
        .map(|resolved| resolved.joined)
        .map_err(String::from)
}

/// A contained vault-relative path, and where it actually lands.
struct Resolved {
    /// `vault.join(rel)` — what the writers open.
    joined: PathBuf,
    /// Where `joined` lands, relative to the vault: its longest existing
    /// ancestor as the filesystem resolves it — symlinks followed, and every
    /// name as the disk stores it, which `realpath` answers with on APFS even
    /// when the request folded case — then the part that does not exist yet.
    landing: PathBuf,
}

/// Why a write has no target, each with the message the writers have always
/// returned (M54.10). Only `Refused` judges the target itself, so only it is
/// what the agent's MCP doors record as `target_outside_corpus` before
/// dispatch; the other two leave the call to answer in its own words.
enum NoTarget {
    /// Outside the vault, or no note a note writer may touch.
    Refused(String),
    /// An argument that names nothing: an empty path, or a slug that is not
    /// one name.
    Malformed(String),
    /// The disk could not say where the path lands, which judges nothing
    /// about it.
    Unresolved(String),
}

impl From<NoTarget> for String {
    fn from(no_target: NoTarget) -> String {
        match no_target {
            NoTarget::Refused(message)
            | NoTarget::Malformed(message)
            | NoTarget::Unresolved(message) => message,
        }
    }
}

/// The message in a judgement that refused the target itself, or `None`.
fn refused<T>(judged: Result<T, NoTarget>) -> Option<String> {
    match judged {
        Err(NoTarget::Refused(message)) => Some(message),
        _ => None,
    }
}

/// `safe_join`'s whole check, keeping the resolution it already has to do
/// for `note_join` to judge.
fn resolve(vault: &Path, rel: &str) -> Result<Resolved, NoTarget> {
    let escapes = || format!("path escapes the vault: {rel:?}");
    if rel.is_empty() {
        // Refused in the same words as an escape, but an empty path names
        // nothing, which is not the same as naming somewhere outside.
        return Err(NoTarget::Malformed(escapes()));
    }
    let contained = Path::new(rel)
        .components()
        .all(|c| matches!(c, Component::Normal(_) | Component::CurDir));
    if !contained {
        return Err(NoTarget::Refused(escapes()));
    }
    let joined = vault.join(rel);
    let canonical_vault = vault
        .canonicalize()
        .map_err(|e| NoTarget::Unresolved(format!("resolving vault root: {e}")))?;
    // `canonicalize` requires the path to exist, and most of the paths this
    // function sees are about to be CREATED. Walk up to the longest
    // existing ancestor (the vault root itself always exists, so this
    // terminates) and resolve symlinks from there — a symlink further up
    // the chain than the leaf is exactly as much an escape as one at the
    // leaf.
    let mut existing = joined.as_path();
    while !existing.exists() {
        match existing.parent() {
            Some(parent) => existing = parent,
            None => break,
        }
    }
    let canonical_existing = existing
        .canonicalize()
        .map_err(|e| NoTarget::Unresolved(format!("resolving path: {e}")))?;
    let Ok(inside) = canonical_existing.strip_prefix(&canonical_vault) else {
        return Err(NoTarget::Refused(escapes()));
    };
    // `existing` was walked up from `joined` by `parent`, so it is a prefix
    // and this cannot miss; if it ever did, refusing is the safe answer.
    let rest = joined
        .strip_prefix(existing)
        .map_err(|_| NoTarget::Unresolved(format!("resolving path: {rel:?}")))?;
    let landing = inside.join(rest);
    Ok(Resolved { joined, landing })
}

/// Where `rel` lands, `/`-joined: the path as the scan lists it, or `None`
/// when it is not a contained vault path.
///
/// What the agent's MCP writes announce to the open pages (M53.6). A page
/// knows its file by the path the scan listed it under, and the agent may
/// spell that file `./notes/a.md` or, on APFS, with its folder case-folded;
/// the landing is the one spelling both agree on.
pub fn landing_path(vault: &Path, rel: &str) -> Option<String> {
    resolve(vault, rel).ok().map(|r| slashed(&r.landing))
}

// --- Path locks (M55.1) ------------------------------------------------------
//
// One writer per file. A person's patch, an agent's append and a second run
// each read, compute and rename, so without a lock the last rename silently
// dropped the other change, and a writer that picked a free name and then
// wrote could overwrite one picked at the same moment. Writes to one file now
// take turns, keyed by where the path LANDS (`lock_key`), so every spelling of
// one file waits on the same key; writes to different files overlap.
//
// Lock order: while a path lock is held, code takes only leaf locks — the
// watcher's own-write map, the runtime sink (`shadow_write`) and the Trash's
// `TRASH_LOCK`, which a restore shares only with the launch purge (M60.8,
// `vault::trash`). It never
// calls `shadow::with_writer`, and never calls `lock_paths` a second time
// (that refuses instead of hanging). knowledge/ projections belong to the
// ledger writer alone and take no path lock.
//
// What it does not cover: a folder move holds only the folder's own keys, so
// a write into that folder racing the move may land in either place or fail;
// and outside writers (git, other editors) never take the lock.

/// Which thread holds each key, and the signal a release sends.
type LockTable = (Mutex<HashMap<String, ThreadId>>, Condvar);

/// The process-global lock table, built like `watcher::own_writes`.
fn path_locks() -> &'static LockTable {
    static LOCKS: OnceLock<LockTable> = OnceLock::new();
    LOCKS.get_or_init(|| (Mutex::new(HashMap::new()), Condvar::new()))
}

/// The one key every spelling of a file shares: where it lands (`resolve`:
/// `./`, symlinks, and the names the disk stores), under the canonical vault,
/// each name folded as a folding disk hears it (`knowledge::disk_folded`:
/// case and the HFS+ ignorables) and NFC-normalized. Case twins on a
/// case-sensitive disk share a key too, which only over-locks.
fn lock_key(vault: &Path, rel: &str) -> Result<String, String> {
    let resolved = resolve(vault, rel)?;
    let canonical_vault = vault
        .canonicalize()
        .map_err(|e| format!("resolving vault root: {e}"))?;
    Ok(canonical_vault
        .join(&resolved.landing)
        .components()
        .map(|c| {
            crate::knowledge::disk_folded(&c.as_os_str().to_string_lossy())
                .nfc()
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("/"))
}

/// The paths one write holds. Dropping it releases every key and wakes the
/// writers waiting on them, during a panic's unwinding too.
#[must_use = "a path lock releases its paths as soon as it is dropped"]
pub(crate) struct PathLock {
    keys: Vec<String>,
    /// `vault.join(rel)` for each path, as the writers open it.
    joined: Vec<PathBuf>,
}

impl PathLock {
    /// Does this lock hold `abs`?
    pub(super) fn covers(&self, abs: &Path) -> bool {
        self.joined.iter().any(|path| path == abs)
    }
}

impl Drop for PathLock {
    fn drop(&mut self) {
        let (table, released) = path_locks();
        // The table guards plain data, so a poisoned one is taken back as it
        // is: refusing every later write until a restart is the worse failure.
        let mut held = table.lock().unwrap_or_else(PoisonError::into_inner);
        for key in &self.keys {
            held.remove(key);
        }
        drop(held);
        released.notify_all();
    }
}

/// Take every path in `rels` at once, waiting until none of them is held.
///
/// All or nothing, so two writers that each need several paths cannot hold
/// one apiece and wait on each other forever. A path this thread already
/// holds refuses (`<rel> is already locked by this write`) instead of
/// waiting on itself. Waits have no timeout: writers are short and make no
/// network calls.
pub(crate) fn lock_paths(vault: &Path, rels: &[&str]) -> Result<PathLock, String> {
    let mut keys: Vec<(String, &str)> = Vec::new();
    let mut joined = Vec::new();
    for rel in rels {
        let key = lock_key(vault, rel)?;
        joined.push(vault.join(rel));
        if !keys.iter().any(|(taken, _)| *taken == key) {
            keys.push((key, rel));
        }
    }
    let me = std::thread::current().id();
    let (table, released) = path_locks();
    let mut held = table.lock().unwrap_or_else(PoisonError::into_inner);
    loop {
        if let Some((_, rel)) = keys.iter().find(|(key, _)| held.get(key) == Some(&me)) {
            return Err(format!("{rel} is already locked by this write"));
        }
        if keys.iter().all(|(key, _)| !held.contains_key(key)) {
            break;
        }
        held = released.wait(held).unwrap_or_else(PoisonError::into_inner);
    }
    for (key, _) in &keys {
        held.insert(key.clone(), me);
    }
    Ok(PathLock {
        keys: keys.into_iter().map(|(key, _)| key).collect(),
        joined,
    })
}

/// An agent write's expectation that did not hold (M55.3): it named the
/// hash of `expected` bytes, and the lock found `actual` ones. Nothing was
/// written.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StaleContent {
    pub path: String,
    pub expected: String,
    pub actual: String,
}

/// Why a note write wrote nothing (M55.3): the agent's expectation was
/// stale, or the write was refused in words.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NoteWriteError {
    Stale(StaleContent),
    Refused(String),
}

impl From<String> for NoteWriteError {
    fn from(message: String) -> Self {
        NoteWriteError::Refused(message)
    }
}

impl From<NoteWriteError> for String {
    /// The words a caller that passed no expectation reads. Such a caller
    /// never meets `Stale`, so its words are only a fallback.
    fn from(error: NoteWriteError) -> Self {
        match error {
            NoteWriteError::Refused(message) => message,
            NoteWriteError::Stale(stale) => format!(
                "{} changed since it was read, so nothing was written",
                stale.path
            ),
        }
    }
}

/// Whether a writer lands its bytes or only says what it would land
/// (M57.4c). A preview reads, compares `expect`, runs the writer's own
/// bytes and checks and picks the first free name, under the same lock, and
/// stops there: it writes nothing, records nothing and announces nothing.
/// Human writers always commit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WriteMode {
    Commit,
    Preview,
}

/// Where a write lands, or in a preview would: the vault-relative path, the
/// SHA-256 of the bytes it replaces (None for a new note), and of the bytes
/// it lands.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Landing {
    pub path: String,
    pub before: Option<String>,
    pub after: String,
}

/// Rewrite one note under its path lock: the one note funnel (M55.1).
///
/// In order, all under one lock: `note_join` judges the target (it refuses
/// before any lock or read), the lock is taken, the file is read, `expect`
/// (an agent's hash of the bytes it read, M55.3) is compared with the bytes
/// the lock holds, `next` computes the new bytes from them, and `write_file`
/// renames them into place, recorded by `shadow_write` as a `vault.write`
/// under `by`'s stamp, a `.mmd` too (M58.1). A stale `expect` or an `Err`
/// from `next` writes nothing: no temp file, no `vault_writes` row. A
/// person's saves never pass an expectation, so a save never compares and
/// the last write wins; only Restore does, as D2 (c)'s undo clause (M58.4).
/// Returns the written bytes' SHA-256.
pub(crate) fn rewrite_note<D: Door>(
    vault: &Path,
    rel: &str,
    extensions: &[&str],
    expect: Option<&str>,
    next: impl FnOnce(&str) -> Result<String, String>,
    by: &WriteReceipt<D>,
) -> Result<String, NoteWriteError> {
    rewrite_note_in(vault, rel, extensions, expect, WriteMode::Commit, next, by)
        .map(|landing| landing.after)
}

/// `rewrite_note` in `mode` (M57.4c): a preview runs every step up to the
/// write, under the same lock, and lands nothing. Returns the landing.
pub(crate) fn rewrite_note_in<D: Door>(
    vault: &Path,
    rel: &str,
    extensions: &[&str],
    expect: Option<&str>,
    mode: WriteMode,
    next: impl FnOnce(&str) -> Result<String, String>,
    by: &WriteReceipt<D>,
) -> Result<Landing, NoteWriteError> {
    rewrite_note_outcome(vault, rel, extensions, expect, mode, false, next, by)
        .map(|(landing, _)| landing)
}

/// `rewrite_note_in`, and whether the bytes changed. With `keep_identical`
/// false, as every other writer asks, identical bytes are written and
/// recorded like any others; `set_note_fields` (M60.4) passes true, so a
/// plan that changes nothing writes nothing: no temp file, no rename, no
/// `vault_writes` row.
#[expect(
    clippy::too_many_arguments,
    reason = "the funnel's arguments, plus the one flag set_note_fields needs"
)]
fn rewrite_note_outcome<D: Door>(
    vault: &Path,
    rel: &str,
    extensions: &[&str],
    expect: Option<&str>,
    mode: WriteMode,
    keep_identical: bool,
    next: impl FnOnce(&str) -> Result<String, String>,
    by: &WriteReceipt<D>,
) -> Result<(Landing, bool), NoteWriteError> {
    let target = note_join(vault, rel, extensions)?;
    let lock = lock_paths(vault, &[rel])?;
    let current = std::fs::read_to_string(&target).map_err(|e| format!("{rel}: {e}"))?;
    let before = crate::ledger::sha256_hex(current.as_bytes());
    if let Some(expected) = expect {
        if before != expected {
            return Err(NoteWriteError::Stale(StaleContent {
                path: rel.to_string(),
                expected: expected.to_string(),
                actual: before,
            }));
        }
    }
    let content = next(&current)?;
    let changed = content != current;
    if mode == WriteMode::Commit && (changed || !keep_identical) {
        write_file(&lock, &target, &content)?;
        shadow_write(vault, rel, &content, "vault.write", by);
    }
    Ok((
        Landing {
            path: rel.to_string(),
            before: Some(before),
            after: crate::ledger::sha256_hex(content.as_bytes()),
        },
        changed,
    ))
}

/// The markdown note a Restore may write (M58.4): `note_join` with the
/// markdown set, so Restore refuses every target `save_note` refuses, in its
/// words, before it asks git anything.
pub(crate) fn restore_target(vault: &Path, rel: &str) -> Result<PathBuf, String> {
    note_join(vault, rel, MARKDOWN)
}

/// Restore's write (M58.4): `bytes` exactly, through the one note funnel,
/// as the person's write. `expect` is the hash Restore read before its
/// safety commit (D2 (c)'s undo clause): a page that changed since writes
/// nothing and answers `Stale`. Returns the written bytes' SHA-256.
pub(crate) fn restore_note(
    vault: &Path,
    rel: &str,
    bytes: &str,
    expect: &str,
    by: &WriteReceipt<Human>,
) -> Result<String, NoteWriteError> {
    rewrite_note(
        vault,
        rel,
        MARKDOWN,
        Some(expect),
        |_| Ok(bytes.to_string()),
        by,
    )
}

/// Write the first free name among `candidates`, and return it.
///
/// Each candidate taken already is passed over; the first free one is
/// judged (`judge`, in the writer's own words), locked, and checked again
/// under its lock, since another writer may have taken it while this one
/// waited. Then `write` lands it, or the lock is released and the walk goes
/// on.
fn claim_free_name(
    vault: &Path,
    candidates: impl IntoIterator<Item = String>,
    judge: impl Fn(&str) -> Result<PathBuf, String>,
    write: impl FnOnce(&PathLock, &str, &Path) -> Result<(), String>,
) -> Result<String, String> {
    for rel in candidates {
        if vault.join(&rel).exists() {
            continue;
        }
        let target = judge(&rel)?;
        let lock = lock_paths(vault, &[&rel])?;
        if target.exists() {
            continue;
        }
        write(&lock, &rel, &target)?;
        return Ok(rel);
    }
    Err("every candidate name is taken".to_string())
}

/// Require a single normal path component: non-empty, no separators, no
/// traversal. Used for note slugs and view ids.
fn safe_component(kind: &str, value: &str) -> Result<(), String> {
    let mut components = Path::new(value).components();
    let single_normal = matches!(
        (components.next(), components.next()),
        (Some(Component::Normal(_)), None)
    );
    if single_normal && !value.contains(['/', '\\']) {
        Ok(())
    } else {
        Err(format!("invalid {kind}: {value:?}"))
    }
}

// --- Note targets (PLATFORM-API-1, CANVAS-1) --------------------------------

/// What the markdown-only note writers accept.
pub(super) const MARKDOWN: &[&str] = &["md"];

/// `save_note`'s set: the diagram page and the whiteboard tab save a `.mmd`
/// raw, through the body editor's own door (M29.20, M29.46).
const MARKDOWN_OR_DIAGRAM: &[&str] = &["md", "mmd"];

/// Why `path` is not a note a note writer may touch, or `None` when it is.
///
/// Judged per component, the way the scanner judges names:
/// - No component may be hidden (`scan::is_hidden`): not `.git/`, whose
///   config the app's own auto-commit and sync still execute
///   (`gpg.program`, `core.sshCommand`, and more), and whose
///   `core.fsmonitor` and hooks the person's own git runs (Cerebro's git
///   pins those two off); not `.cerebro/`, with its write-once ledger
///   segments and connector config; not `.claude/`, any other dot-folder,
///   or any dotfile. Heard as HFS+ hears a name, which ignores U+200C,
///   U+FEFF and their kind (`scan::hfs_ignorable`): there, `\u{200c}.claude/`
///   IS `.claude/` (git's `core.protectHFS` class), and with no such folder
///   yet the landing check has nothing to resolve. The scanner hides exactly
///   what this rule refuses, Obsidian-style, so no page it lists is one this
///   rule leaves read-only.
/// - The extension must be one of `extensions`, spelled exactly as the
///   scanner spells it. An append adds markdown and a frontmatter patch
///   prepends YAML, and in a `.canvas`, `.csv`, `.json` or `.yml` either one
///   is corruption.
/// - A markdown note may not sit in a folder the scanner skips, asked with
///   the scanner's own predicate (`scan::is_skipped_dir`), which past the
///   rule above is exactly `views/` and `attachments/`, at any depth. This
///   rule only decides what is VISIBLE — the two above are the boundary — so
///   it says exactly what the scanner says. `Attachments/`, `Views/` and
///   `views./` are folders the scanner lists, so their notes save; where a
///   disk folds `Views/` onto an existing `views/`, the LANDING is `views/`
///   (see `note_join`), and that refuses.
///
/// One consequence, deliberate: a `.mmd` is exempt from the folder rule
/// because something writes one there today. `WhiteboardView` files a legacy
/// `views/<id>.yml` List's canvases under `views/whiteboards/`, and refusing
/// would strand every canvas such a List already has. Only the human doors
/// take a `.mmd`.
///
/// Mirrored by `noteRefusal` in src/lib/mockIpc.ts; both replay
/// src-tauri/fixtures/note-targets.json.
fn note_refusal(path: &Path, extensions: &[&str]) -> Option<String> {
    let names: Vec<_> = path
        .components()
        .filter_map(|c| match c {
            Component::Normal(name) => Some(name.to_string_lossy()),
            _ => None,
        })
        .collect();
    if names.iter().any(|name| super::scan::is_hidden(name)) {
        return Some("dot-folders and dotfiles hold no notes".to_string());
    }
    let leaf = names.last().map(|name| name.as_ref()).unwrap_or_default();
    let folders = &names[..names.len().saturating_sub(1)];
    let extension = Path::new(leaf)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default();
    if !extensions.contains(&extension) {
        let kinds: Vec<String> = extensions.iter().map(|e| format!(".{e}")).collect();
        return Some(format!("only {} files are notes", kinds.join(" and ")));
    }
    if extension == "md" && folders.iter().any(|name| super::scan::is_skipped_dir(name)) {
        return Some("views/ and attachments/ hold no notes".to_string());
    }
    None
}

/// Where the bundle is on this disk, relative to the vault: what
/// `vault/knowledge` resolves to — through a symlink, and under the name the
/// disk stores, which `realpath` answers with even for a folder planted as
/// U+212A + `nowledge`. `None` while the vault holds no bundle.
fn bundle_root(vault: &Path) -> Option<PathBuf> {
    let canonical_vault = vault.canonicalize().ok()?;
    let root = vault
        .join(crate::knowledge::KNOWLEDGE_DIR)
        .canonicalize()
        .ok()?;
    root.strip_prefix(&canonical_vault)
        .ok()
        .map(Path::to_path_buf)
}

/// The first named component of `path`.
fn first_name(path: &Path) -> Option<String> {
    path.components().find_map(|c| match c {
        Component::Normal(name) => Some(name.to_string_lossy().into_owned()),
        _ => None,
    })
}

/// Is `path`'s first component one a folding disk hears as `knowledge`?
fn names_the_bundle(path: &Path) -> bool {
    first_name(path).is_some_and(|name| crate::knowledge::folds_to_bundle(&name))
}

/// A vault-relative path `/`-joined, for a message.
fn slashed(path: &Path) -> String {
    path.components()
        .map(|c| c.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

/// `safe_join` for a writer that changes a NOTE (PLATFORM-API-1): the target
/// must be contained, AND be a note.
///
/// Every note writer below resolves its target here before it reads a byte —
/// the ones that go through `rewrite_note` (`save_note`, `update_frontmatter`,
/// `set_note_title`, and the agent's `patch_note_checked`,
/// `append_note_checked`, `edit_note` and `set_note_fields`), `create_note`,
/// `write_source` and
/// `write_text_file` — so the agent's MCP doors and the human IPC commands share one boundary,
/// and a refused file is never opened, let alone rewritten. It lives in the
/// mechanism because the grant cannot hold it: panel turns, and every Agent
/// record without `scope:`, run unscoped, so nothing upstream ever stopped an
/// append to `.git/config`. Writers whose job IS config (`save_view`,
/// `save_list`, `save_collection`, the ledger, the connector settings) do not
/// come through here.
///
/// Judged twice: once as asked, and once where it LANDS (see `Resolved`), so
/// a symlink with an innocent name cannot carry the write into `.git/`, and a
/// name a folding disk hears as a skipped folder (`view` + U+017F LONG S IS
/// `views` on APFS) is judged as the folder it reaches.
///
/// And it may not reach `knowledge/` by any name but exactly the bundle's
/// own (M53.28). The bundle's guards (`knowledge::canonical_path`) fold a
/// first name as the disk does, so they hear `Knowledge/` and U+212A KELVIN
/// SIGN + `nowledge` as the bundle; but a symlink into it, or the folder
/// `knowledge` links to, carries a name no fold can guess, so this check
/// leans on none of them. Past it, a write reaches the bundle only under the
/// one spelling the capture valve and the ledger file a concept by.
/// Membership is IDENTITY (it lands under where `knowledge/` resolves) or
/// NAME (a first component that folds to `knowledge`, as asked or as
/// landed). Identity alone misses the plant: a folder made under a folded
/// spelling before the bundle exists, which the bundle's own writes then
/// land in.
///
/// The agent's MCP doors also ask this judgement before dispatch (M54.10),
/// through `note_target_refusal` and `new_note_refusal`, so a refusal is
/// recorded against its run in the words the door would use. The doors
/// still come through here, so a path that changes on disk between that
/// check and the write is refused all the same, uncoded.
pub(super) fn note_join(vault: &Path, rel: &str, extensions: &[&str]) -> Result<PathBuf, String> {
    Ok(judge_note(vault, rel, extensions)?.joined)
}

/// `note_join`'s judgement, keeping why it refused (M54.10).
fn judge_note(vault: &Path, rel: &str, extensions: &[&str]) -> Result<Resolved, NoTarget> {
    let resolved = resolve(vault, rel)?;
    if let Some(reason) = note_refusal(Path::new(rel), extensions) {
        return Err(NoTarget::Refused(format!("not a note: {rel} — {reason}")));
    }
    let landing = slashed(&resolved.landing);
    if let Some(reason) = note_refusal(&resolved.landing, extensions) {
        return Err(NoTarget::Refused(format!(
            "not a note: {rel} resolves to {landing} — {reason}"
        )));
    }
    let in_bundle = names_the_bundle(Path::new(rel))
        || names_the_bundle(&resolved.landing)
        || bundle_root(vault).is_some_and(|root| resolved.landing.starts_with(root));
    let own_name = first_name(Path::new(rel)).as_deref() == Some(crate::knowledge::KNOWLEDGE_DIR);
    if in_bundle && !own_name {
        let lands = if landing == slashed(Path::new(rel)) {
            String::new()
        } else {
            format!(" (it resolves to {landing})")
        };
        return Err(NoTarget::Refused(format!(
            "{rel} is inside knowledge/ by another name{lands} — the bundle is reached by its own \
             name or not at all"
        )));
    }
    Ok(resolved)
}

/// Why a markdown note door refuses `rel` as no note it may touch, in
/// `note_join`'s words, or `None` (M54.10): the check the agent's
/// `update_frontmatter`, `set_fields`, `append_to_note` and `edit_note` make
/// before dispatch.
///
/// `None` as well where those doors answer in other words: a `.mmd`, which
/// each refuses as raw diagram source before it judges a note, an empty
/// path, and a path the disk could not resolve.
pub(crate) fn note_target_refusal(vault: &Path, rel: &str) -> Option<String> {
    if rel.ends_with(".mmd") {
        return None;
    }
    refused(judge_note(vault, rel, MARKDOWN))
}

/// The markdown note `rel` names, as an absolute canonical path, for a door
/// that hands the file to something outside the app (M55.9: Reveal in Finder
/// and Open in default editor). `note_join` judges it, so M53.4's refusals
/// hold here too: no dot-path, no non-note, nothing in `views/` or
/// `attachments/`, no bundle alias and no symlink out. Then it must exist and
/// be a file. It reads and writes nothing.
pub(crate) fn existing_note(vault: &Path, rel: &str) -> Result<PathBuf, String> {
    let joined = note_join(vault, rel, MARKDOWN)?;
    joined
        .canonicalize()
        .ok()
        .filter(|abs| abs.is_file())
        .ok_or_else(|| format!("{rel} is not a file in the vault"))
}

/// `safe_join` for the ledger's projection writer (`ledger::manifest`): the
/// file must land INSIDE the bundle — under where `knowledge/` resolves, not
/// merely at a path spelled `knowledge/…` — and be markdown.
///
/// A projection path is `knowledge/` plus the path a write named, so a
/// symlink inside the bundle (`knowledge/sys` → `.git/hooks`, or a folder
/// outside the vault) carried `write_concept`, a capture or a governed apply
/// wherever it pointed. Judged before anything is recorded or written, and
/// by the concept writers before anything commits (`manifest::ensure_writable`).
///
/// Containment and nothing more, because this writer also writes back what a
/// PERSON filed: a concept moved into `knowledge/.archive/` is adopted where
/// it went (`reconcile::adopt_moves`), and every reconciliation exit
/// rewrites every projection, so a path refused here fails the whole vault's
/// exits, not one write. Which folders a NEW concept may go in is the agent
/// doors' rule (`concept_refusal`).
pub fn bundle_join(vault: &Path, rel: &str) -> Result<PathBuf, String> {
    let resolved = resolve(vault, rel)?;
    let landing = slashed(&resolved.landing);
    let inside = match bundle_root(vault) {
        Some(root) => resolved.landing.starts_with(root),
        // No bundle yet: the folder this write creates is the one it names.
        None => first_name(&resolved.landing).as_deref() == Some(crate::knowledge::KNOWLEDGE_DIR),
    };
    if !inside {
        return Err(format!(
            "{rel} resolves to {landing}, outside knowledge/ — a projection is written inside the \
             bundle or not at all"
        ));
    }
    if resolved.landing.extension().and_then(|e| e.to_str()) != Some("md") {
        return Err(format!("{rel}: a projection is a .md file"));
    }
    Ok(resolved.joined)
}

/// Why an agent's concept door refuses `rel`, or `None`: a concept an agent
/// writes or rechecks is a note the scan can list — no dot-folder or dotfile,
/// a `.md`, not under `views/` or `attachments/` (`note_refusal`). Written
/// where the scan cannot see it, a concept sits in the ledger and nowhere in
/// the app — no Knowledge row, no Review card, no `get_note` — while the
/// tool tells the agent it waits in Knowledge for review.
pub(crate) fn concept_refusal(rel: &str) -> Option<String> {
    note_refusal(Path::new(rel), MARKDOWN)
}

fn read_file(vault: &Path, rel: &str) -> Result<String, String> {
    std::fs::read_to_string(safe_join(vault, rel)?).map_err(|e| format!("{rel}: {e}"))
}

/// Recompose a file from a raw frontmatter block (with trailing newline) and
/// an untouched body. Empty/absent block → body only.
fn compose(block: Option<&str>, body: &str) -> String {
    match block {
        Some(b) if !b.trim().is_empty() => format!("---\n{b}---\n{body}"),
        _ => body.to_string(),
    }
}

fn serialize_mapping(mapping: &serde_yaml::Mapping) -> Result<Option<String>, String> {
    if mapping.is_empty() {
        return Ok(None);
    }
    serde_yaml::to_string(mapping)
        .map(Some)
        .map_err(|e| e.to_string())
}

/// Convert a JSON patch value to YAML for insertion into a mapping.
fn json_to_yaml(value: &serde_json::Value) -> serde_yaml::Value {
    match value {
        serde_json::Value::Null => serde_yaml::Value::Null,
        serde_json::Value::Bool(b) => serde_yaml::Value::Bool(*b),
        serde_json::Value::Number(n) => {
            serde_yaml::from_str(&n.to_string()).unwrap_or(serde_yaml::Value::Null)
        }
        serde_json::Value::String(s) => serde_yaml::Value::String(s.clone()),
        serde_json::Value::Array(items) => {
            serde_yaml::Value::Sequence(items.iter().map(json_to_yaml).collect())
        }
        serde_json::Value::Object(map) => {
            let mut m = serde_yaml::Mapping::new();
            for (k, v) in map {
                m.insert(serde_yaml::Value::String(k.clone()), json_to_yaml(v));
            }
            serde_yaml::Value::Mapping(m)
        }
    }
}

/// Record one committed write's hash in runtime.db's `vault_writes` (M21.8;
/// moved out of the epistemic ledger in M49.10), stamped with who made it,
/// in which run, and who approved it, from `by` (M58.1) — see
/// `runtime::vault_writes`. Best-effort: it observes writes, it never gates
/// them, and History reads the rows back (`runtime::activity`, M64.2).
fn shadow_write<D: Door>(vault: &Path, rel: &str, content: &str, kind: &str, by: &WriteReceipt<D>) {
    // Operational, not epistemic (M49.10, Q4): runtime.db, not the ledger.
    let hash = crate::ledger::sha256_hex(content.as_bytes());
    record(vault, kind, rel, None, Some(&hash), by);
}

/// Record one write in `vault_writes` under `by`'s stamp (M58.1): a rename's
/// `to`, a hash when the bytes are known. Best-effort, like `shadow_write`.
pub(super) fn record<D: Door>(
    vault: &Path,
    kind: &str,
    rel: &str,
    to: Option<&str>,
    content_hash: Option<&str>,
    by: &WriteReceipt<D>,
) {
    crate::runtime::vault_writes::record(
        vault,
        &crate::runtime::vault_writes::WriteRow {
            kind,
            path: rel,
            to,
            content_hash,
            actor: Some(by.actor()),
            run_id: by.run_id(),
            approved_by: by.approved_by(),
        },
    );
}

/// The kind a write that may create its file records (M58.1): `vault.write`
/// over a file that `existed`, judged under the write's lock, else
/// `vault.create`.
fn write_kind(existed: bool) -> &'static str {
    if existed {
        "vault.write"
    } else {
        "vault.create"
    }
}

/// The writers that record no `vault_writes` row, and why (M58.1, CV-33).
/// Every other writer records one row under its receipt's stamp.
pub const UNRECORDED: &[(&str, &str)] = &[
    (
        "create_folder",
        "a folder holds no bytes; each page later written into it is recorded",
    ),
    (
        "clean_orphan_temps",
        "the app's own temps from a crashed write, which no page ever held",
    ),
    (
        "ledger reconcile and recovery projections",
        "the ledger records them itself, and they read as changed through Knowledge",
    ),
    (
        "git conflict resolve, pull, pull_ff, merge abort and rebase abort",
        "git rewrites the working tree itself, past every door; history names the commit",
    ),
    (
        "save_connectors",
        "connector settings are .cerebro/ config, never a page",
    ),
    (
        "purge_expired",
        "the launch purge moves only .trash/ stamp dirs to the OS Trash, which no scan lists; \
         each item's delete was recorded when it went",
    ),
    (
        "shell-granted CLI writes",
        "the CLI's own Write, Edit and shell bypass the doors; the run books partial \
         (runs.writes_booked = 2) and M58.3 names its Write and Edit paths",
    ),
];

/// A file a knowledge projection wrote (M58.1): its path, and whether it was
/// absent before. A projection that rewrote identical bytes is none.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Projected {
    pub path: String,
    pub created: bool,
}

/// Record each file a Review decision or a run's commit projected, under
/// `by` (M58.1, Q1): `vault.create` for one it created, else `vault.write`,
/// with the bytes it holds now.
pub fn record_projected(vault: &Path, projected: &[Projected], by: &WriteReceipt<ConceptDoor>) {
    for file in projected {
        let hash = std::fs::read(vault.join(&file.path))
            .ok()
            .map(|bytes| crate::ledger::sha256_hex(&bytes));
        record(
            vault,
            write_kind(!file.created),
            &file.path,
            None,
            hash.as_deref(),
            by,
        );
    }
}

/// The bytes each of `paths` holds now, by hash, `None` for a file that is
/// absent: what [`record_changed`] compares against after a ledger write.
pub(crate) fn snapshot(vault: &Path, paths: &[&str]) -> Vec<(String, Option<String>)> {
    paths
        .iter()
        .map(|rel| {
            let hash = safe_join(vault, rel)
                .ok()
                .and_then(|abs| std::fs::read(abs).ok())
                .map(|bytes| crate::ledger::sha256_hex(&bytes));
            (rel.to_string(), hash)
        })
        .collect()
}

/// Record each path of `before` whose bytes changed since, under `by`
/// (M58.1): `vault.create` for one that was absent, else `vault.write`. A
/// path whose bytes did not change records nothing, so a no-op or a queued
/// concept write leaves no row.
pub(crate) fn record_changed<D: Door>(
    vault: &Path,
    before: &[(String, Option<String>)],
    by: &WriteReceipt<D>,
) {
    let paths: Vec<&str> = before.iter().map(|(rel, _)| rel.as_str()).collect();
    for ((rel, was), (_, now)) in before.iter().zip(snapshot(vault, &paths)) {
        if let Some(hash) = now.filter(|now| was.as_ref() != Some(now)) {
            record(vault, write_kind(was.is_some()), rel, None, Some(&hash), by);
        }
    }
}

/// `rel`'s refusal when it is a `.mmd` asked for a frontmatter patch.
///
/// A .mmd has NO frontmatter to patch (M29.23): its leading `---` block is
/// mermaid config — valid YAML, so without this guard a patch (including the
/// agent's MCP update_frontmatter) would merge into the diagram's config
/// header and reserialize it. Refused at the mechanism, not the callers, same
/// as vault containment, and before the note is judged.
fn refuse_mmd_patch(rel: &str) -> Result<(), String> {
    if rel.ends_with(".mmd") {
        return Err(format!(
            "{rel}: a .mmd is raw diagram source and has no frontmatter to update"
        ));
    }
    Ok(())
}

/// The bytes a frontmatter patch turns `current` into. `null` deletes a key;
/// existing keys keep their position; new keys append; unknown keys and the
/// body are untouched.
///
/// A patch that nulls out every remaining key leaves an empty mapping, which
/// serialises as no block at all — and then the body is the whole file, so a
/// `---` fence sitting in that body arrives at byte zero and becomes the
/// frontmatter the scanner reads (PR #17 security review). The agent's check
/// judges these bytes, under the write's lock (`patch_note_checked`).
pub(super) fn patch_bytes(
    rel: &str,
    current: &str,
    patch: &serde_json::Map<String, serde_json::Value>,
) -> Result<String, String> {
    let (block, body) = parse::split_frontmatter(current);
    let mut mapping = match block {
        Some(b) => parse::parse_frontmatter(b)
            .map_err(|e| format!("{rel}: cannot patch malformed frontmatter: {e}"))?,
        None => serde_yaml::Mapping::new(),
    };
    for (key, value) in patch {
        let key = serde_yaml::Value::String(key.clone());
        if value.is_null() {
            mapping.shift_remove(&key); // shift_remove preserves key order
        } else {
            mapping.insert(key, json_to_yaml(value)); // existing keys keep position
        }
    }
    let new_block = serialize_mapping(&mapping)?;
    Ok(compose(new_block.as_deref(), body))
}

/// Apply a JSON patch to a note's frontmatter (`patch_bytes`), under the
/// note's path lock. Returns the written bytes' SHA-256, the hash the next
/// scan reads (M55.2).
///
/// CRLF/BOM/trailing-whitespace-fence files (see the round-trip caveat at the
/// top of parse.rs) are normalized: the frontmatter block is reserialized and
/// the fences rewritten in LF form. The body is preserved byte-for-byte.
/// YAML comments and the original scalar quoting style inside the frontmatter
/// block are not preserved through reserialization.
pub fn update_frontmatter(
    vault: &Path,
    rel: &str,
    patch: &serde_json::Map<String, serde_json::Value>,
    by: &WriteReceipt<Human>,
) -> Result<String, String> {
    patch_in(
        vault,
        rel,
        patch,
        None,
        WriteMode::Commit,
        |_, _| Ok(()),
        by,
    )
    .map(|landing| landing.after)
    .map_err(String::from)
}

/// `update_frontmatter` for an agent: `expect`, when given, is the hash of
/// the bytes the agent read, and other bytes refuse as `Stale` (M55.3);
/// `check` judges the bytes the lock holds and the bytes the patch would
/// write, `(before, after)`, under the same lock as the write (M55.1). Either
/// refusal writes nothing. Returns the written bytes' SHA-256.
pub fn patch_note_checked(
    vault: &Path,
    rel: &str,
    patch: &serde_json::Map<String, serde_json::Value>,
    expect: Option<&str>,
    check: impl FnOnce(&str, &str) -> Result<(), String>,
    by: &WriteReceipt<Agent>,
) -> Result<String, NoteWriteError> {
    patch_note_in(vault, rel, patch, expect, WriteMode::Commit, check, by)
        .map(|landing| landing.after)
}

/// `patch_note_checked` in `mode` (M57.4c), returning the landing.
pub fn patch_note_in(
    vault: &Path,
    rel: &str,
    patch: &serde_json::Map<String, serde_json::Value>,
    expect: Option<&str>,
    mode: WriteMode,
    check: impl FnOnce(&str, &str) -> Result<(), String>,
    by: &WriteReceipt<Agent>,
) -> Result<Landing, NoteWriteError> {
    patch_in(vault, rel, patch, expect, mode, check, by)
}

/// The frontmatter patch both doors share, under either's receipt.
fn patch_in<D: Door>(
    vault: &Path,
    rel: &str,
    patch: &serde_json::Map<String, serde_json::Value>,
    expect: Option<&str>,
    mode: WriteMode,
    check: impl FnOnce(&str, &str) -> Result<(), String>,
    by: &WriteReceipt<D>,
) -> Result<Landing, NoteWriteError> {
    refuse_mmd_patch(rel)?;
    rewrite_note_in(
        vault,
        rel,
        MARKDOWN,
        expect,
        mode,
        |current| {
            let after = patch_bytes(rel, current, patch)?;
            check(current, &after)?;
            Ok(after)
        },
        by,
    )
}

/// A note's frontmatter as JSON, read from `current` the way `patch_bytes`
/// reads it: no block is an empty mapping, and a malformed block is refused
/// in `update_frontmatter`'s words (M60.4: what `set_fields` plans on).
pub(crate) fn frontmatter_json(
    rel: &str,
    current: &str,
) -> Result<serde_json::Map<String, serde_json::Value>, String> {
    let (block, _) = parse::split_frontmatter(current);
    let mapping = match block {
        Some(b) => parse::parse_frontmatter(b)
            .map_err(|e| format!("{rel}: cannot patch malformed frontmatter: {e}"))?,
        None => serde_yaml::Mapping::new(),
    };
    Ok(mapping
        .iter()
        .map(|(key, value)| (parse::yaml_key_string(key), parse::yaml_to_json(value)))
        .collect())
}

/// What `set_note_fields` landed, or in a preview would: where, and whether
/// the bytes changed. A plan that changes nothing writes nothing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FieldsWritten {
    pub landing: Landing,
    pub changed: bool,
}

/// An agent's schema-checked field write (M60.4, `set_fields`), on the one
/// note funnel: `note_join` refuses before the lock (a `.mmd` first, as
/// `patch_bytes` has no frontmatter to patch there), the lock is taken, the
/// file read, `expect` compared (M55.3), and `plan` turns the bytes under
/// the lock into a frontmatter patch, so list deltas compose with any write
/// that landed before. `patch_bytes` applies it, `check` judges
/// `(before, after)` (the governed check), and the bytes land unless `mode`
/// is a preview. An empty patch, or one that leaves the bytes as they were,
/// writes and records nothing (`changed` false).
pub fn set_note_fields(
    vault: &Path,
    rel: &str,
    plan: impl FnOnce(&str) -> Result<serde_json::Map<String, serde_json::Value>, String>,
    expect: Option<&str>,
    check: impl FnOnce(&str, &str) -> Result<(), String>,
    mode: WriteMode,
    by: &WriteReceipt<Agent>,
) -> Result<FieldsWritten, NoteWriteError> {
    refuse_mmd_patch(rel)?;
    let (landing, changed) = rewrite_note_outcome(
        vault,
        rel,
        MARKDOWN,
        expect,
        mode,
        true,
        |current| {
            let patch = plan(current)?;
            if patch.is_empty() {
                return Ok(current.to_string());
            }
            let after = patch_bytes(rel, current, &patch)?;
            check(current, &after)?;
            Ok(after)
        },
        by,
    )?;
    Ok(FieldsWritten { landing, changed })
}

/// The verify path (M23.4): the stamp is a field revision plus a
/// `belief.attested` pinned to the reviewed revision event and its
/// projection hash, and the file regenerates as the projection. Refuses
/// with `ledger_writer_unavailable` when no ledger writer is active
/// (M49.1). The lib.rs `verify_concept` command is the only caller.
pub fn verify_frontmatter(
    vault: &Path,
    rel: &str,
    patch: &serde_json::Map<String, serde_json::Value>,
    viewed_body_hash: &str,
    by: &WriteReceipt<ConceptDoor>,
) -> Result<(), String> {
    crate::ledger::concepts::verify_concept(vault, rel, patch, viewed_body_hash, by)
}

/// Replace the note body, preserving the frontmatter block byte-for-byte.
///
/// `.mmd` files are RAW (M29.20): mermaid's own `---` config header is
/// diagram syntax, so the body IS the whole file — no frontmatter compose.
/// Recorded as any save is, a diagram's included (M58.1).
pub fn save_note(
    vault: &Path,
    rel: &str,
    body: &str,
    by: &WriteReceipt<Human>,
) -> Result<(), String> {
    rewrite_note(
        vault,
        rel,
        MARKDOWN_OR_DIAGRAM,
        None,
        |current| Ok(compose_saved(rel, current, body)),
        by,
    )
    .map(drop)
    .map_err(String::from)
}

/// The bytes `save_note` turns `current` into for a new body: the existing
/// frontmatter block with the body composed under it. A note that has NO
/// block has its body as the whole file. A `.mmd` is the body itself.
pub(super) fn compose_saved(rel: &str, current: &str, body: &str) -> String {
    if rel.ends_with(".mmd") {
        return body.to_string();
    }
    let (block, _) = parse::split_frontmatter(current);
    compose(block, body)
}

/// The `type` a note's frontmatter declares, if the file exists and parses.
/// A test reader: the writers judge the bytes their lock holds instead.
/// Malformed frontmatter reads as untyped, which is also how scan.rs reads
/// it, and a .mmd is always untyped: its `---` header is mermaid config, and
/// a stray `type:` key in there is diagram data, not vault schema (M29.23).
#[cfg(test)]
pub fn note_type(vault: &Path, rel: &str) -> Option<String> {
    if rel.ends_with(".mmd") {
        return None;
    }
    let target = note_join(vault, rel, MARKDOWN).ok()?;
    parse::declared_type(&std::fs::read_to_string(target).ok()?)
}

/// Return the note body only (frontmatter stripped). `.mmd` files pass
/// through verbatim — their `---` header is mermaid config, not frontmatter.
pub fn read_note(vault: &Path, rel: &str) -> Result<String, String> {
    read_note_hashed(vault, rel).map(|(body, _)| body)
}

/// `read_note`, with the SHA-256 of the whole file it read the body from
/// (M55.2): one read, so the hash names exactly the bytes behind the body,
/// and it equals the scan's `Entry.hash` for those bytes.
pub fn read_note_hashed(vault: &Path, rel: &str) -> Result<(String, String), String> {
    let content = read_file(vault, rel)?;
    let hash = crate::ledger::sha256_hex(content.as_bytes());
    if rel.ends_with(".mmd") {
        return Ok((content, hash));
    }
    let (_, body) = parse::split_frontmatter(&content);
    Ok((body.to_string(), hash))
}

/// The bytes an append turns `current` into: its body with `addition`
/// appended as its own paragraph, under the frontmatter block it already has.
fn append_bytes(current: &str, addition: &str) -> String {
    let (block, body) = parse::split_frontmatter(current);
    let body = format!("{}\n\n{}\n", body.trim_end(), addition.trim());
    compose(block, &body)
}

/// Append `addition` to a markdown note, under its path lock (M55.1).
/// `expect`, when given, is the hash of the bytes the agent read, and other
/// bytes refuse as `Stale` (M55.3); `check` judges the bytes the lock holds
/// and the bytes the append would write, `(before, after)`. Either refusal
/// writes nothing. Returns the written bytes' SHA-256.
///
/// Markdown notes only, judged before a byte is read (PLATFORM-API-1). A
/// `.mmd` is refused outright rather than with the other non-notes because it
/// IS a note elsewhere — just not one markdown can be appended to: the text
/// lands in raw mermaid source, and the diagram stops parsing.
pub fn append_note_checked(
    vault: &Path,
    rel: &str,
    addition: &str,
    expect: Option<&str>,
    check: impl FnOnce(&str, &str) -> Result<(), String>,
    by: &WriteReceipt<Agent>,
) -> Result<String, NoteWriteError> {
    append_note_in(vault, rel, addition, expect, WriteMode::Commit, check, by)
        .map(|landing| landing.after)
}

/// `append_note_checked` in `mode` (M57.4c), returning the landing.
pub fn append_note_in(
    vault: &Path,
    rel: &str,
    addition: &str,
    expect: Option<&str>,
    mode: WriteMode,
    check: impl FnOnce(&str, &str) -> Result<(), String>,
    by: &WriteReceipt<Agent>,
) -> Result<Landing, NoteWriteError> {
    if rel.ends_with(".mmd") {
        return Err(format!(
            "{rel}: a .mmd is raw diagram source, and markdown appended to it is not a diagram"
        )
        .into());
    }
    rewrite_note_in(
        vault,
        rel,
        MARKDOWN,
        expect,
        mode,
        |current| {
            let after = append_bytes(current, addition);
            check(current, &after)?;
            Ok(after)
        },
        by,
    )
}

/// What an agent's quoted edit left behind (M55.5): the hash of the bytes it
/// wrote, as get_note's Hash line will print it, and the 1-based line where
/// each edit's new text starts, in the order the edits were given.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EditedNote {
    pub content_hash: String,
    pub lines: Vec<usize>,
    /// The hash of the bytes the edit replaced (M57.4c).
    pub before: String,
}

/// Replace quoted passages of a markdown note's body, in place, under its
/// path lock (M55.5): the agent's `edit_note`.
///
/// `rewrite_note` with a closure, so in order and under one lock: the target
/// is judged a note, a missing file is `no note at <rel>`, `expect` is
/// compared with the bytes the lock holds (M55.3), the edits are planned
/// against the body (`quote::plan_edits`), and `check` judges the bytes held
/// and the bytes the edits would land, `(before, after)`. Any refusal writes
/// nothing, so the edits land together or not at all. A plan that fails on a
/// note `check` refuses as it stands answers with `check`'s refusal, so a
/// governed note is never quoted back.
///
/// Every byte before the body (a BOM, the fences as spelled, the YAML) is
/// kept as it is, and so is every body byte no edit quoted. That is why this
/// never goes through `compose` or `save_note`, which rewrite the fences
/// and drop a BOM. Markdown notes only: a `.mmd` is not a note
/// here.
pub fn edit_note(
    vault: &Path,
    rel: &str,
    edits: &[super::quote::QuoteEdit],
    expect: Option<&str>,
    check: impl Fn(&str, &str) -> Result<(), String>,
    by: &WriteReceipt<Agent>,
) -> Result<EditedNote, NoteWriteError> {
    edit_note_in(vault, rel, edits, expect, WriteMode::Commit, check, by)
}

/// `edit_note` in `mode` (M57.4c): a preview plans and checks the edits on
/// the bytes the lock holds, and lands nothing.
pub fn edit_note_in(
    vault: &Path,
    rel: &str,
    edits: &[super::quote::QuoteEdit],
    expect: Option<&str>,
    mode: WriteMode,
    check: impl Fn(&str, &str) -> Result<(), String>,
    by: &WriteReceipt<Agent>,
) -> Result<EditedNote, NoteWriteError> {
    if !note_join(vault, rel, MARKDOWN)?.is_file() {
        return Err(format!("no note at {rel}").into());
    }
    let mut lines = Vec::new();
    let landing = rewrite_note_in(
        vault,
        rel,
        MARKDOWN,
        expect,
        mode,
        |current| {
            let (_, body) = parse::split_frontmatter(current);
            let prefix = &current[..current.len() - body.len()];
            let planned = match super::quote::plan_edits(body, prefix, edits) {
                Ok(planned) => planned,
                Err(refusal) => {
                    check(current, current)?;
                    return Err(refusal);
                }
            };
            let after = format!("{prefix}{}", planned.text);
            check(current, &after)?;
            lines = planned.lines;
            Ok(after)
        },
        by,
    )?;
    Ok(EditedNote {
        content_hash: landing.after,
        lines,
        before: landing.before.unwrap_or_default(),
    })
}

/// `<folder>/<stem>.md`: the name `create_note` gives a note.
fn note_in(folder: &str, stem: &str) -> String {
    // '' means the vault root — no separator, or the path grows a leading '/'.
    if folder.is_empty() {
        format!("{stem}.md")
    } else {
        format!("{folder}/{stem}.md")
    }
}

/// The file `create_note` names for `slug` in `folder`, before a `-2` makes
/// the name new (M54.10), or `None` when `slug` is not one name, which
/// `create_note` refuses in its own words.
pub(crate) fn planned_note_path(folder: &str, slug: &str) -> Option<String> {
    safe_component("slug", slug).ok()?;
    Some(note_in(folder, slug))
}

/// The names `create_note` tries for `slug` in `folder`, in order:
/// `<slug>.md`, then `<slug>-2.md`, `<slug>-3.md`, …
fn note_candidates<'a>(folder: &'a str, slug: &'a str) -> impl Iterator<Item = String> + 'a {
    (1..).map(move |n: u64| {
        if n == 1 {
            note_in(folder, slug)
        } else {
            note_in(folder, &format!("{slug}-{n}"))
        }
    })
}

/// Extensions `write_text_file` may create. `.mmd` only for now: the command
/// exists so a mermaid block can move its source out into a standalone
/// diagram file (M29.22) — it is not a general file-writing door.
const TEXT_FILE_EXTENSIONS: [&str; 1] = ["mmd"];

/// Write a raw text file at `rel`, deduping the STEM (`-2`, `-3`, …) when the
/// path is taken. Returns the vault-relative path actually written, recorded
/// as a `vault.create` (M58.1).
///
/// The extension allowlist lives HERE, beside the dedupe, rather than in the
/// lib.rs command: a raw-bytes writer that could be pointed at a `.md` would
/// bypass every invariant the note pipeline enforces, so the policy sits with
/// the mechanism. So do the note-target rules (`note_join`): a diagram in a
/// dot-folder is not one the scanner will ever show. The knowledge guard is
/// the door's: no receipt is minted for a path in `knowledge/`.
pub fn write_text_file(
    vault: &Path,
    rel: &str,
    content: &str,
    by: &WriteReceipt<Human>,
) -> Result<String, String> {
    let Some((stem, ext)) = rel.rsplit_once('.') else {
        return Err(format!("write_text_file requires an extension: {rel}"));
    };
    if !TEXT_FILE_EXTENSIONS.contains(&ext) {
        return Err(format!(
            "write_text_file only writes {TEXT_FILE_EXTENSIONS:?} files: {rel}"
        ));
    }
    note_join(vault, rel, &TEXT_FILE_EXTENSIONS)?;
    let candidates = (1..).map(|n: u64| {
        if n == 1 {
            rel.to_string()
        } else {
            format!("{stem}-{n}.{ext}")
        }
    });
    claim_free_name(
        vault,
        candidates,
        |candidate| note_join(vault, candidate, &TEXT_FILE_EXTENSIONS),
        |lock, written, target| {
            write_file(lock, target, content)?;
            shadow_write(vault, written, content, "vault.create", by);
            Ok(())
        },
    )
}

/// The one folder attachments live in.
///
/// Already excluded from the scanner (`scan.rs`), the watcher, and the folder
/// walker below, which is why a copied binary never surfaces as a note or
/// bounces back as a `vault-changed` event. Attachment writes are the first
/// thing that puts files there on purpose (M16.13c).
pub const ATTACHMENTS_DIR: &str = "attachments";

/// `report.pdf` → `attachments/report.pdf`, then `-2`, `-3`, …
///
/// Not `note_candidates`: that one hardcodes `.md`, and `report.pdf-2` is a
/// file the OS can no longer open. The dedupe goes on the STEM.
fn attachment_candidates(name: &str) -> impl Iterator<Item = String> + '_ {
    // A leading dot is the whole name (".gitignore"), not an extension.
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s, format!(".{e}")),
        _ => (name, String::new()),
    };
    (1..).map(move |n: u64| {
        let suffix = if n == 1 {
            String::new()
        } else {
            format!("-{n}")
        };
        format!("{ATTACHMENTS_DIR}/{stem}{suffix}{ext}")
    })
}

/// Copy a file from anywhere on disk into the vault's `attachments/` folder
/// and return its VAULT-RELATIVE path (M16.13c).
///
/// The destination folder is fixed here rather than taken from the caller.
/// A files field stores whatever string it is handed, so letting the frontend
/// choose would let a field drop a `.md` into a records folder, where the very
/// next scan would adopt it as a note — and `attachments/` is precisely the
/// one directory the scanner and the watcher already agree to ignore.
///
/// Removing a chip in the UI does NOT delete the copy. Dropping a reference is
/// not deleting a file, and in a files-first app the vault folder is the user's
/// to prune.
///
/// Recorded as a `vault.create` with no hash (M58.1): the copy is any file,
/// of any size, and reading it back to hash it would read its bytes twice.
pub fn import_attachment(
    vault: &Path,
    source: &str,
    by: &WriteReceipt<Human>,
) -> Result<String, String> {
    let src = Path::new(source);
    if !src.is_absolute() {
        return Err(format!("attachment source must be absolute: {source}"));
    }
    let meta = std::fs::metadata(src).map_err(|e| format!("{source}: {e}"))?;
    if !meta.is_file() {
        return Err(format!("not a file: {source}"));
    }
    let name = src
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| format!("unusable file name: {source}"))?;
    safe_component("attachment name", name)?;
    claim_free_name(
        vault,
        attachment_candidates(name),
        |candidate| safe_join(vault, candidate),
        |_lock, copied, dest| {
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            std::fs::copy(src, dest).map_err(|e| format!("{source}: {e}"))?;
            super::watcher::note_own_write(dest);
            record(vault, "vault.create", copied, None, None, by);
            Ok(())
        },
    )
}

/// The exact bytes `create_note` will write for a frontmatter map and a body.
///
/// Split out because a guard has to read what LANDS ON DISK, not what was
/// typed into the `frontmatter` argument: an all-empty mapping serialises as
/// no YAML block at all, and then `body` is the whole file — so a body that
/// opens with its own `---` fence becomes the frontmatter the scanner reads
/// (PR #17 security review). Composing in one place is what keeps the guard
/// and the write from ever disagreeing about that.
pub fn compose_new_note(
    frontmatter: &serde_json::Map<String, serde_json::Value>,
    slug: &str,
    body: &str,
) -> Result<String, String> {
    let mut mapping = serde_yaml::Mapping::new();
    for (k, v) in frontmatter {
        if v.is_null() {
            continue;
        }
        mapping.insert(serde_yaml::Value::String(k.clone()), json_to_yaml(v));
    }
    let block = serialize_mapping(&mapping)?;
    let body = if body.trim().is_empty() {
        format!("# {}\n", parse::humanize_stem(slug))
    } else {
        body.to_string()
    };
    Ok(match block {
        Some(b) => format!("---\n{b}---\n\n{body}"),
        None => body,
    })
}

/// Create `<folder>/<slug>.md` (deduping to `-2`, `-3`, …, unless
/// `IfExists::Refuse` refuses, which only `create_note_if` passes) with the
/// given frontmatter and body; empty body gets a humanized `# Title` line.
/// Returns the vault-relative path, recorded as a `vault.create` under a
/// person's or a run's receipt (M58.1).
pub fn create_note<D: CreatesNotes>(
    vault: &Path,
    folder: &str,
    slug: &str,
    frontmatter: &serde_json::Map<String, serde_json::Value>,
    body: &str,
    by: &WriteReceipt<D>,
) -> Result<String, String> {
    create_note_in(
        vault,
        folder,
        slug,
        frontmatter,
        body,
        WriteMode::Commit,
        by,
    )
    .map(|landing| landing.path)
}

/// `create_note` in `mode` (M57.4c): a preview picks the first free name,
/// judged and checked under its lock as the write would, and writes nothing.
pub fn create_note_in<D: CreatesNotes>(
    vault: &Path,
    folder: &str,
    slug: &str,
    frontmatter: &serde_json::Map<String, serde_json::Value>,
    body: &str,
    mode: WriteMode,
    by: &WriteReceipt<D>,
) -> Result<Landing, String> {
    create_note_if(
        vault,
        folder,
        slug,
        frontmatter,
        body,
        mode,
        IfExists::Suffix,
        by,
    )
    .map_err(String::from)
}

/// What a create does when `<folder>/<slug>.md` is already taken (M61.6b):
/// number a copy beside it (`-2`, `-3`, …), as every create always has, or
/// write nothing and name the note that holds the name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IfExists {
    Suffix,
    Refuse,
}

/// Why a create wrote nothing (M61.6b): told to refuse a taken name, it
/// found `<folder>/<slug>.md` under its lock (`Exists`, naming that path),
/// or it was refused in words. Its own type, not `NoteWriteError`, because
/// a rewrite never meets a taken name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CreateNoteError {
    Exists(String),
    Refused(String),
}

impl From<String> for CreateNoteError {
    fn from(message: String) -> Self {
        CreateNoteError::Refused(message)
    }
}

impl From<CreateNoteError> for String {
    /// The words a caller that does not answer `Exists` itself reads.
    fn from(error: CreateNoteError) -> Self {
        match error {
            CreateNoteError::Refused(message) => message,
            CreateNoteError::Exists(path) => {
                format!("{path} already exists, so nothing was written")
            }
        }
    }
}

/// `create_note_in` with a choice for a taken name (M61.6b). `Suffix`
/// numbers a copy exactly as `create_note` does. `Refuse` judges only
/// `<folder>/<slug>.md`, takes its path lock and asks the disk again under
/// it, so a twin whose name differs only in case counts where the disk folds
/// case; a taken name is `CreateNoteError::Exists`, with no write, no temp
/// file and no `vault_writes` row. A preview stops before the write either
/// way.
#[expect(
    clippy::too_many_arguments,
    reason = "create_note_in's seven plus the one choice it adds; a struct would only rename them"
)]
pub fn create_note_if<D: CreatesNotes>(
    vault: &Path,
    folder: &str,
    slug: &str,
    frontmatter: &serde_json::Map<String, serde_json::Value>,
    body: &str,
    mode: WriteMode,
    if_exists: IfExists,
    by: &WriteReceipt<D>,
) -> Result<Landing, CreateNoteError> {
    resolve(vault, folder).map_err(String::from)?; // folder must stay inside the vault
    safe_component("slug", slug)?;
    let content = compose_new_note(frontmatter, slug, body)?;
    let land = |lock: &PathLock, rel: &str, target: &Path| -> Result<(), String> {
        if mode == WriteMode::Commit {
            write_file(lock, target, &content)?;
            shadow_write(vault, rel, &content, "vault.create", by);
        }
        Ok(())
    };
    let path = match if_exists {
        // Judged on each file it may actually write (PLATFORM-API-1), and
        // picked under that file's lock, so two creates of one slug land in
        // two files.
        IfExists::Suffix => claim_free_name(
            vault,
            note_candidates(folder, slug),
            |rel| Ok(judge_note(vault, rel, MARKDOWN)?.joined),
            land,
        )?,
        IfExists::Refuse => {
            let rel = note_in(folder, slug);
            let target = judge_note(vault, &rel, MARKDOWN)
                .map_err(String::from)?
                .joined;
            let lock = lock_paths(vault, &[&rel])?;
            if target.exists() {
                return Err(CreateNoteError::Exists(rel));
            }
            land(&lock, &rel, &target)?;
            rel
        }
    };
    Ok(Landing {
        path,
        before: None,
        after: crate::ledger::sha256_hex(content.as_bytes()),
    })
}

/// What `create_note` judges before it writes, in its order and its words
/// (M54.10): the folder stays inside the vault, the slug is one name, and
/// the file the two name, made new with a `-2` or `-3`, is a note.
fn judge_new_note(vault: &Path, folder: &str, slug: &str) -> Result<String, NoTarget> {
    resolve(vault, folder)?; // folder must stay inside the vault
    safe_component("slug", slug).map_err(NoTarget::Malformed)?;
    let rel = note_candidates(folder, slug)
        .find(|candidate| !vault.join(candidate).exists())
        .unwrap_or_default();
    // Judged on the file it will actually write (PLATFORM-API-1): the folder
    // can be a dot-folder (`.git/hooks`), a skipped one, or a symlink into
    // either, and the slug can make a dotfile.
    judge_note(vault, &rel, MARKDOWN)?;
    Ok(rel)
}

/// Why `create_note` refuses to write `slug` in `folder` as no note it may
/// write, in its words, or `None` (M54.10): the check the agent's door makes
/// before dispatch. It names the file `create_note` would write, `-2`
/// included, because that is the name the refusal carries.
///
/// `None` as well where the call answers in other words: a slug that is not
/// one name, an empty folder, and a folder the disk could not resolve.
pub(crate) fn new_note_refusal(vault: &Path, folder: &str, slug: &str) -> Option<String> {
    refused(judge_new_note(vault, folder, slug))
}

/// Create or REPLACE a knowledge concept at an exact path (M6).
///
/// Unlike `create_note`, which numbers a copy beside a taken name unless told
/// to refuse, this never picks another filename: a concept has a
/// stable identity (its path is its OKF concept ID), so an agent revising one
/// must overwrite it rather than leave `churn-2.md` beside `churn.md`.
/// Intermediate directories are created — the agent organizes the bundle.
///
/// The concept write is a committed Belief transition and the file is its
/// byte-stable projection, written through the manifest-first protocol
/// (M23.3). Refuses with `ledger_writer_unavailable` when no ledger writer
/// is active (M49.1) — there is no file-first fallback. Booked under the
/// receipt's run when it has one (M49.9), and recorded under its stamp.
pub fn write_concept(
    vault: &Path,
    rel: &str,
    frontmatter: &serde_json::Map<String, serde_json::Value>,
    body: &str,
    by: &WriteReceipt<ConceptDoor>,
) -> Result<(), String> {
    crate::ledger::concepts::write_concept(vault, rel, frontmatter, body, by)
}

/// The exact-path writer behind `write_source`: the bytes it wrote, and
/// whether the file existed under its lock.
fn concept_write(
    vault: &Path,
    rel: &str,
    frontmatter: &serde_json::Map<String, serde_json::Value>,
    body: &str,
) -> Result<(String, bool), String> {
    // A cached source is a note like any other (PLATFORM-API-1), and the
    // frontend and `cache_source` find one by SCANNING, for its path or its
    // `source_id` — a copy written where the scan cannot see it reads as never
    // fetched, forever.
    let target = note_join(vault, rel, MARKDOWN)?;
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("{rel}: {e}"))?;
    }
    let mut mapping = serde_yaml::Mapping::new();
    for (k, v) in frontmatter {
        if v.is_null() {
            continue;
        }
        mapping.insert(serde_yaml::Value::String(k.clone()), json_to_yaml(v));
    }
    let block = serialize_mapping(&mapping)?;
    let body = body.trim_end();
    let content = match block {
        Some(b) => format!("---\n{b}---\n\n{body}\n"),
        None => format!("{body}\n"),
    };
    let lock = lock_paths(vault, &[rel])?;
    let existed = target.exists();
    write_file(&lock, &target, &content)?;
    Ok((content, existed))
}

/// Cached copies of fetched external material. Mirrors SOURCES_DIR in
/// src/engine/ingest.ts.
pub const SOURCES_DIR: &str = "sources";

/// Write a cached source doc. Same shape as `write_concept` but bounded to
/// `sources/`: the two folders are both machine-written, and letting one tool
/// write into the other's territory would make the boundary decorative.
pub fn write_source(
    vault: &Path,
    rel: &str,
    frontmatter: &serde_json::Map<String, serde_json::Value>,
    body: &str,
    by: &WriteReceipt<Agent>,
) -> Result<(), String> {
    if !(rel == SOURCES_DIR || rel.starts_with(&format!("{SOURCES_DIR}/"))) {
        return Err(format!(
            "cache_source only writes into {SOURCES_DIR}/; {rel} is outside it"
        ));
    }
    // A cached source is a vault write, not a knowledge event — the five
    // M21.8 kinds reserve knowledge.* for the bundle.
    let (content, existed) = concept_write(vault, rel, frontmatter, body)?;
    shadow_write(vault, rel, &content, write_kind(existed), by);
    Ok(())
}

/// Does a concept already live at this path? Read BEFORE writing, so the log
/// can say whether the write created something or revised it.
pub fn concept_exists(vault: &Path, rel: &str) -> bool {
    safe_join(vault, rel).map(|p| p.is_file()).unwrap_or(false)
}

/// Append the write to `knowledge/log.md`, creating the log if it is absent.
pub fn append_knowledge_log(
    vault: &Path,
    rel: &str,
    title: &str,
    existed: bool,
    by: &WriteReceipt<ConceptDoor>,
) -> Result<(), String> {
    // M23.3: the log is a projection too — the append is a Belief body
    // revision and the file is regenerated. No writer, no append (M49.1).
    crate::ledger::concepts::append_log(vault, rel, title, existed, by)
}

/// Replace the H1 line that `parse::extract_h1_title` would read the title
/// from (fenced/indented code lines are never the H1), or prepend one when
/// the body has no real H1. Only the H1 line itself is spliced; every other
/// byte of the body (including CRLF line endings) is preserved.
fn replace_h1(body: &str, title: &str) -> String {
    let h1_line = format!("# {title}");
    match parse::first_h1_line_start(body) {
        Some(start) => {
            let rest = &body[start..];
            // End of the H1 text, excluding the line terminator (LF or CRLF).
            let end = match rest.find('\n') {
                Some(i) if rest[..i].ends_with('\r') => start + i - 1,
                Some(i) => start + i,
                None => body.len(),
            };
            format!("{}{h1_line}{}", &body[..start], &body[end..])
        }
        None => format!("{h1_line}\n\n{body}"),
    }
}

/// Replace the first H1 line of the body, or insert one as the first line.
pub fn set_note_title(
    vault: &Path,
    rel: &str,
    title: &str,
    by: &WriteReceipt<Human>,
) -> Result<(), String> {
    // A .mmd's title IS its filename stem, and `# title` spliced into raw
    // mermaid source is a broken diagram (M29.21: the file tree already
    // declines to ask). Refused here, so no other caller can.
    if rel.ends_with(".mmd") {
        return Err(format!(
            "{rel}: a .mmd is raw diagram source, and its title is its filename — there is no H1 \
             to set"
        ));
    }
    rewrite_note(
        vault,
        rel,
        MARKDOWN,
        None,
        |current| Ok(retitle_bytes(current, title)),
        by,
    )
    .map(drop)
    .map_err(String::from)
}

/// The bytes `set_note_title` turns `current` into: its H1 spliced
/// (`replace_h1`), every other byte kept.
fn retitle_bytes(current: &str, title: &str) -> String {
    let (block, body) = parse::split_frontmatter(current);
    compose(block, &replace_h1(body, title))
}

fn collect_views_dir(
    vault: &Path,
    dir: &Path,
    project: Option<&str>,
    views: &mut Vec<ViewYaml>,
) -> Result<(), String> {
    if !dir.is_dir() {
        return Ok(());
    }
    for item in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
        let item = item.map_err(|e| e.to_string())?;
        let path = item.path();
        if path.extension().and_then(|e| e.to_str()) != Some("yml") {
            continue;
        }
        let Some(id) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        let yaml = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        views.push(ViewYaml {
            id: id.to_string(),
            yaml,
            project: project.map(str::to_string),
            // A legacy view has no Collection; it surfaces at the top level of
            // the sidebar rather than being force-fitted into one.
            collection: None,
            path: rel_path(vault, &path)?,
        });
    }
    Ok(())
}

/// Walk the folders the scanner walks, asked with its own predicate
/// (`scan::is_skipped_dir`) — skipping dot dirs, the legacy `views/` dirs,
/// and `attachments/`.
fn vault_walker(vault: &Path) -> impl Iterator<Item = walkdir::DirEntry> + '_ {
    walkdir::WalkDir::new(vault)
        .into_iter()
        .filter_entry(|e| {
            e.depth() == 0
                || e.file_type().is_file()
                || !super::scan::is_skipped_dir(&e.file_name().to_string_lossy())
        })
        .filter_map(Result::ok)
}

/// Every Collection in the vault: each folder holding a `collection.yml`.
pub fn list_collections(vault: &Path) -> Result<Vec<CollectionYaml>, String> {
    let mut out = Vec::new();
    for item in vault_walker(vault) {
        if !item.file_type().is_file() || item.file_name().to_string_lossy() != COLLECTION_MARKER {
            continue;
        }
        let Some(dir) = item.path().parent() else {
            continue;
        };
        out.push(CollectionYaml {
            folder: rel_path(vault, dir)?,
            yaml: std::fs::read_to_string(item.path()).map_err(|e| e.to_string())?,
        });
    }
    out.sort_by(|a, b| a.folder.cmp(&b.folder));
    Ok(out)
}

/// The Collection a path belongs to: the nearest ANCESTOR folder holding a
/// `collection.yml`. Same containment rule projects already use, so a List in a
/// sub-folder belongs to the Collection above it without restating it.
/// True when this folder's own note declares it a Collection (M47.5).
///
/// `delivery/delivery.md` carrying `type: Collection` is what a
/// `collection.yml` used to be. Only the FOLDER NOTE speaks for its folder —
/// a page of that type sitting anywhere else describes nothing but itself.
fn declared_by_page(dir: &Path) -> bool {
    let Some(name) = dir.file_name() else {
        return false;
    };
    let note = dir.join(format!("{}.md", name.to_string_lossy()));
    let Ok(text) = std::fs::read_to_string(&note) else {
        return false;
    };
    // The scanner's own read of `type:`, because the app believes the scanner:
    // a hand-rolled line match missed CRLF, a BOM, a quoted value and a trailing
    // comment, calling the folder a Collection while its Lists came back at the
    // vault root. Frontmatter only — `type: Collection` in prose is prose.
    parse::declared_type(&text).as_deref() == Some("Collection")
}

fn collection_of(vault: &Path, file: &Path) -> Option<String> {
    let mut dir = file.parent();
    while let Some(current) = dir {
        // Either marker counts. A vault mid-conversion has both shapes in it,
        // and a List whose container declared itself with a PAGE must not be
        // reported as living at the vault root — the app would then look for
        // it under a collection it does not have and find nothing.
        if current.join(COLLECTION_MARKER).is_file() || declared_by_page(current) {
            return rel_path(vault, current).ok();
        }
        if current == vault {
            break;
        }
        dir = current.parent();
    }
    None
}

/// Every List in the vault, in all three on-disk shapes (see `ViewYaml`).
/// Sorted by (collection, project, id) so the sidebar order is stable.
pub fn list_views(vault: &Path) -> Result<Vec<ViewYaml>, String> {
    let mut views = Vec::new();
    collect_views_dir(vault, &vault.join("views"), None, &mut views)?;

    for item in vault_walker(vault) {
        if !item.file_type().is_file() {
            continue;
        }
        let name = item.file_name().to_string_lossy().to_string();

        // Legacy project-scoped views: a views/ dir next to any project.md.
        if name == "project.md" {
            let Some(project_dir) = item.path().parent() else {
                continue;
            };
            let rel_project = rel_path(vault, item.path())?;
            collect_views_dir(
                vault,
                &project_dir.join("views"),
                Some(&rel_project),
                &mut views,
            )?;
            continue;
        }

        // M10 Lists: `<name>.list.yml` anywhere.
        if let Some(id) = name.strip_suffix(LIST_SUFFIX) {
            if id.is_empty() {
                continue;
            }
            views.push(ViewYaml {
                id: id.to_string(),
                yaml: std::fs::read_to_string(item.path()).map_err(|e| e.to_string())?,
                project: None,
                collection: collection_of(vault, item.path()),
                path: rel_path(vault, item.path())?,
            });
        }
    }

    views.sort_by(|a, b| {
        a.collection
            .cmp(&b.collection)
            .then(a.project.cmp(&b.project))
            .then(a.id.cmp(&b.id))
    });
    Ok(views)
}

/// Write `<folder>/collection.yml`, creating the folder if needed. Passing ""
/// is rejected: the vault root is not a Collection. Recorded as a
/// `vault.create` when the file was absent under its lock (M58.1), as are
/// `save_list` and `save_view`.
pub fn save_collection(
    vault: &Path,
    folder: &str,
    yaml: &str,
    by: &WriteReceipt<Human>,
) -> Result<(), String> {
    let dir = safe_join(vault, folder)?;
    let rel = format!("{folder}/{COLLECTION_MARKER}");
    save_config(vault, &rel, &dir.join(COLLECTION_MARKER), yaml, by)
}

/// Land one config file at `target` (`rel` in the vault) under its lock, and
/// record it as created or written.
fn save_config(
    vault: &Path,
    rel: &str,
    target: &Path,
    yaml: &str,
    by: &WriteReceipt<Human>,
) -> Result<(), String> {
    let lock = lock_paths(vault, &[rel])?;
    let existed = target.exists();
    write_file(&lock, target, yaml)?;
    shadow_write(vault, rel, yaml, write_kind(existed), by);
    Ok(())
}

/// Write a List. `folder` empty means the vault root (a top-level List);
/// otherwise `<folder>/<id>.list.yml`.
pub fn save_list(
    vault: &Path,
    folder: &str,
    id: &str,
    yaml: &str,
    by: &WriteReceipt<Human>,
) -> Result<(), String> {
    safe_component("list id", id)?;
    let base = if folder.is_empty() {
        vault.to_path_buf()
    } else {
        safe_join(vault, folder)?
    };
    let rel = if folder.is_empty() {
        format!("{id}{LIST_SUFFIX}")
    } else {
        format!("{folder}/{id}{LIST_SUFFIX}")
    };
    save_config(
        vault,
        &rel,
        &base.join(format!("{id}{LIST_SUFFIX}")),
        yaml,
        by,
    )
}

/// Write `<folder>/views/<id>.yml` verbatim (vault-root `views/` when folder
/// is None), creating the directory if needed. Legacy shape — kept so a vault
/// written before M10 can still be edited in place.
pub fn save_view(
    vault: &Path,
    id: &str,
    yaml: &str,
    folder: Option<&str>,
    by: &WriteReceipt<Human>,
) -> Result<(), String> {
    safe_component("view id", id)?;
    let base = match folder {
        Some(f) => safe_join(vault, f)?,
        None => vault.to_path_buf(),
    };
    let rel = match folder {
        Some(f) => format!("{f}/views/{id}.yml"),
        None => format!("views/{id}.yml"),
    };
    save_config(
        vault,
        &rel,
        &base.join("views").join(format!("{id}.yml")),
        yaml,
        by,
    )
}

// --- Vault format v2 file operations (M2 Task 3) ---

/// Create a directory (and parents) inside the vault. Records nothing (see
/// [`UNRECORDED`]).
pub fn create_folder(vault: &Path, rel: &str, _by: &WriteReceipt<Human>) -> Result<(), String> {
    let abs = safe_join(vault, rel)?;
    std::fs::create_dir_all(&abs).map_err(|e| e.to_string())
}

/// Move a note — or a whole folder — within the vault, and its comments with
/// it (M70.2). Refuses to clobber an existing target. Every path registers
/// as an own-write so the watcher doesn't bounce our move back as external
/// changes.
///
/// Both ends and both comment sidecars (a page's `.comments/<page>.json`, or
/// a folder's mirrored `.comments/<folder>`) are locked in one `lock_paths`
/// call (M55.1), so the target is judged free under its lock. A folder move
/// holds only the folder's keys, not those of the files inside it. Neither
/// end may have a hidden name (M60.8): `.trash/`, `.comments/` and `.git/`
/// are the app's and git's, and a page moved into one would leave the scan.
pub fn rename_note(
    vault: &Path,
    from: &str,
    to: &str,
    by: &WriteReceipt<Human>,
) -> Result<(), String> {
    rename_note_with(
        vault,
        from,
        to,
        |path| trash::delete(path).map_err(|e| e.to_string()),
        by,
    )
}

/// `rename_note` with the step that clears an orphan sidecar already at the
/// target passed in, so tests never reach the OS Trash.
///
/// In order, under the lock: the target must be free; an orphan sidecar at
/// the target goes to `remove` (a page created where a page was moved or
/// deleted outside Cerebro would otherwise inherit its threads); the sidecar
/// moves; the page moves, and if that fails the sidecar moves back. A refused
/// or failed rename leaves every file where it was. The page's move and its
/// sidecar's carry are each recorded under `by`. Either sidecar path reached
/// through a link (`comments::sidecar_join`) skips the orphan step and the
/// carry, logged, and the page still moves.
pub(crate) fn rename_note_with(
    vault: &Path,
    from: &str,
    to: &str,
    remove: impl Fn(&Path) -> Result<(), String>,
    by: &WriteReceipt<Human>,
) -> Result<(), String> {
    let src = safe_join(vault, from)?;
    let dst = safe_join(vault, to)?;
    for end in [from, to] {
        let hidden = Path::new(end).components().any(|c| match c {
            Component::Normal(name) => super::scan::is_hidden(&name.to_string_lossy()),
            _ => false,
        });
        if hidden {
            return Err(format!(
                "{end} is not a page Cerebro shows, so it can't be moved."
            ));
        }
    }
    let is_dir = src.is_dir();
    let carried =
        super::comments::carried_rel(from, is_dir).zip(super::comments::carried_rel(to, is_dir));
    let mut keys = vec![from, to];
    if let Some((side_from, side_to)) = &carried {
        keys.extend([side_from.as_str(), side_to.as_str()]);
    }
    let _lock = lock_paths(vault, &keys)?;
    if dst.exists() {
        return Err(format!("target already exists: {to}"));
    }
    // A missing source fails in the words the rename itself would use,
    // before any sidecar moves.
    std::fs::symlink_metadata(&src).map_err(|e| format!("{from}: {e}"))?;
    let mut moved = None;
    // A sidecar reached through a link is neither carried nor cleared: the
    // link could point at `.git/` or `.cerebro/`, and both steps act on
    // where the path lands.
    let sides = carried.as_ref().and_then(|(side_from, side_to)| {
        let judged = super::comments::sidecar_join(vault, side_from)
            .and_then(|old| super::comments::sidecar_join(vault, side_to).map(|new| (old, new)));
        match judged {
            Ok((old_side, new_side)) => Some((old_side, new_side, side_to)),
            Err(e) => {
                log::warn!("comments: the comments of {from} stay where they are: {e}");
                None
            }
        }
    });
    if let Some((old_side, new_side, side_to)) = sides {
        if new_side.exists() {
            log::warn!("comments: an orphan sidecar at {side_to} goes to the Trash first");
            remove(&new_side).map_err(|e| {
                format!("{to}: the comments already filed there could not be cleared ({e})")
            })?;
            super::watcher::note_own_write(&new_side);
            record(vault, "vault.delete", side_to, None, None, by);
        }
        if old_side.exists() {
            if let Some(parent) = new_side.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            std::fs::rename(&old_side, &new_side)
                .map_err(|e| format!("{from}: its comments could not move ({e})"))?;
            moved = Some((old_side, new_side));
        }
    }
    let renamed = dst
        .parent()
        .map_or(Ok(()), std::fs::create_dir_all)
        .and_then(|()| std::fs::rename(&src, &dst));
    if let Err(e) = renamed {
        if let Some((old_side, new_side)) = &moved {
            if let Err(back) = std::fs::rename(new_side, old_side) {
                log::warn!(
                    "comments: the sidecar of {from} stayed at {} after the rename failed: {back}",
                    new_side.display()
                );
            }
        }
        prune_empty_comment_folders(vault);
        return Err(format!("{from}: {e}"));
    }
    super::watcher::note_own_write(&src);
    super::watcher::note_own_write(&dst);
    record(vault, "vault.rename", from, Some(to), None, by);
    if let (Some((old_side, new_side)), Some((side_from, side_to))) = (&moved, &carried) {
        super::watcher::note_own_write(old_side);
        super::watcher::note_own_write(new_side);
        record(vault, "vault.rename", side_from, Some(side_to), None, by);
    }
    prune_empty_comment_folders(vault);
    Ok(())
}

/// Move a note or folder to the vault's own Trash, `.trash/<stamp>/<path>`,
/// and its comments after it (M60.8, `vault::trash`): nothing a person
/// deletes is hard-deleted, and Settings restores it byte for byte.
pub fn delete_note(
    vault: &Path,
    rel: &str,
    by: &WriteReceipt<Human>,
) -> Result<super::trash::TrashedItem, String> {
    super::trash::move_to_trash(vault, rel, by)
}

/// Remove every empty folder under `.comments/`, and `.comments/` itself
/// when nothing is left, so a carry leaves no empty folder behind. Never
/// follows a link: only real, empty directories go.
pub(super) fn prune_empty_comment_folders(vault: &Path) {
    let root = vault.join(super::comments::COMMENTS_DIR);
    let is_real_dir = std::fs::symlink_metadata(&root).is_ok_and(|m| m.is_dir());
    if !is_real_dir {
        return;
    }
    let dirs: Vec<PathBuf> = walkdir::WalkDir::new(&root)
        .contents_first(true)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_dir())
        .map(|e| e.into_path())
        .collect();
    for dir in dirs {
        // Fails, and is left alone, unless the folder is empty.
        let _ = std::fs::remove_dir(dir);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::testutil;

    /// A person's receipt, as an IPC command mints one.
    fn human() -> WriteReceipt<Human> {
        WriteReceipt::for_test(super::super::receipt::HUMAN_ACTOR, None)
    }

    /// A run's receipt, as an MCP door mints one.
    fn agent() -> WriteReceipt<Agent> {
        WriteReceipt::for_test("process:scout", Some("run-test"))
    }

    /// A person's concept receipt.
    fn concept() -> WriteReceipt<ConceptDoor> {
        WriteReceipt::for_test(super::super::receipt::HUMAN_ACTOR, None)
    }

    /// The janitor's receipt.
    fn janitor() -> WriteReceipt<System> {
        WriteReceipt::for_test(super::super::receipt::ORPHAN_TEMPS_ACTOR, None)
    }

    /// The runtime sink armed for one test, disarmed when it drops.
    struct Recording {
        _lock: std::sync::MutexGuard<'static, ()>,
        config: PathBuf,
    }

    impl Recording {
        fn new(label: &str) -> Self {
            let lock = crate::runtime::sink::test_lock();
            let config = testutil::temp_vault(label);
            crate::runtime::sink::arm(&config).unwrap();
            Self {
                _lock: lock,
                config,
            }
        }
    }

    impl Drop for Recording {
        fn drop(&mut self) {
            crate::runtime::sink::disarm();
            let _ = std::fs::remove_dir_all(&self.config);
        }
    }

    /// One recorded row: kind, path, hash, actor, run, approver.
    type Recorded = (
        String,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
    );

    /// `vault`'s rows in `vault_writes`, oldest first.
    fn recorded(vault: &Path) -> Vec<Recorded> {
        let vault_id = crate::runtime::scope::derive_vault_id(vault);
        crate::runtime::sink::with_sink(|conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT kind, path, content_hash, actor, run_id, approved_by \
                     FROM vault_writes WHERE vault_id = ?1 ORDER BY rowid",
                )
                .unwrap();
            stmt.query_map([&vault_id], |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                ))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
        })
        .unwrap()
    }

    fn hashed(bytes: &str) -> Option<String> {
        Some(crate::ledger::sha256_hex(bytes.as_bytes()))
    }

    /// The name of the function whose signature holds byte `at`.
    fn fn_at(source: &str, at: usize) -> String {
        let start = source[..at].rfind("fn ").expect("inside a fn");
        source[start + 3..]
            .chars()
            .take_while(|c| c.is_alphanumeric() || *c == '_')
            .collect()
    }

    // M58.1: every writer here, in the Trash (M60.8) and in the batch writer
    // (M60.6) takes a receipt, and either records a row under it or is
    // declared in UNRECORDED with its reason. A writer added with a receipt
    // and left off this table fails here.
    #[test]
    fn every_writer_records_its_stamp_or_is_declared() {
        const WRITERS: &[(&str, &str)] = &[
            ("clean_orphan_temps", "unrecorded"),
            ("rewrite_note", "vault.write"),
            ("rewrite_note_in", "vault.write"),
            ("restore_note", "vault.write"),
            ("shadow_write", "the funnel's row"),
            ("record", "one row"),
            ("record_projected", "vault.write or vault.create"),
            ("record_changed", "vault.write or vault.create"),
            ("update_frontmatter", "vault.write"),
            ("patch_note_checked", "vault.write"),
            ("patch_note_in", "vault.write"),
            ("patch_in", "vault.write"),
            (
                "rewrite_note_outcome",
                "vault.write, or nothing for identical bytes",
            ),
            (
                "set_note_fields",
                "vault.write, or nothing for identical bytes",
            ),
            ("verify_frontmatter", "the ledger's projection"),
            ("save_note", "vault.write"),
            ("append_note_checked", "vault.write"),
            ("append_note_in", "vault.write"),
            ("edit_note", "vault.write"),
            ("edit_note_in", "vault.write"),
            ("write_text_file", "vault.create"),
            ("import_attachment", "vault.create"),
            ("create_note", "vault.create"),
            ("create_note_in", "vault.create"),
            ("create_note_if", "vault.create"),
            ("write_concept", "the ledger's projections"),
            ("write_source", "vault.write or vault.create"),
            ("append_knowledge_log", "the ledger's projection"),
            ("set_note_title", "vault.write"),
            ("save_collection", "vault.write or vault.create"),
            ("save_config", "vault.write or vault.create"),
            ("save_list", "vault.write or vault.create"),
            ("save_view", "vault.write or vault.create"),
            ("create_folder", "unrecorded"),
            ("rename_note", "vault.rename"),
            ("rename_note_with", "vault.rename"),
            ("delete_note", "move_to_trash's"),
            ("trash_locked", "vault.delete"),
            ("carry_out", "vault.delete"),
            ("untrash_locked", "vault.create"),
            ("carry_back", "vault.create"),
            ("move_to_trash", "vault.delete"),
            ("restore_from_trash", "vault.create"),
            ("purge_expired", "unrecorded"),
            ("purge_expired_to_os_trash", "purge_expired's"),
            (
                "apply_batch",
                "vault.write, vault.create, and the Trash moves'",
            ),
            (
                "write_all",
                "the Trash moves' own; apply_batch records the rest",
            ),
            ("roll_back", "vault.write, and the Trash moves'"),
            ("recover", "roll_back's, stamped system:batch-recovery"),
        ];
        let mut taking: Vec<String> = Vec::new();
        for source in [
            include_str!("write.rs"),
            include_str!("trash.rs"),
            include_str!("batch.rs"),
        ] {
            let production = &source[..source.find("#[cfg(test)]\nmod tests").unwrap()];
            let mut from = 0;
            while let Some(i) = production[from..].find("&WriteReceipt<") {
                let at = from + i;
                let line_start = production[..at].rfind('\n').map_or(0, |n| n + 1);
                if !production[line_start..at].trim_start().starts_with("//") {
                    taking.push(fn_at(production, at));
                }
                from = at + 1;
            }
        }
        let mut table: Vec<String> = WRITERS.iter().map(|(name, _)| name.to_string()).collect();
        taking.sort();
        table.sort();
        assert_eq!(
            taking, table,
            "every receipt-taking writer is on the table, once"
        );
        for (name, kind) in WRITERS {
            if *kind == "unrecorded" {
                assert!(
                    UNRECORDED.iter().any(|(declared, _)| declared == name),
                    "{name} records nothing, so UNRECORDED names it"
                );
            }
        }
        assert!(UNRECORDED.iter().all(|(_, why)| !why.is_empty()));
    }

    #[test]
    fn a_diagram_save_is_recorded() {
        let _recording = Recording::new("wfm-diagram-recorded-config");
        let vault = testutil::temp_vault("wfm-diagram-recorded");
        testutil::write(&vault, "diagrams/flow.mmd", "flowchart TD\n");
        save_note(&vault, "diagrams/flow.mmd", "graph LR\n", &human()).unwrap();
        let me = Some(super::super::receipt::HUMAN_ACTOR.to_string());
        assert_eq!(
            recorded(&vault),
            vec![(
                "vault.write".into(),
                "diagrams/flow.mmd".into(),
                hashed("graph LR\n"),
                me,
                None,
                None
            )]
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn a_create_records_vault_create() {
        let _recording = Recording::new("wfm-create-recorded-config");
        let vault = testutil::temp_vault("wfm-create-recorded");
        let path =
            create_note(&vault, "notes", "fresh", &patch(&[]), "# Fresh\n", &agent()).unwrap();
        let diagram = write_text_file(&vault, "diagrams/new.mmd", "graph TD\n", &human()).unwrap();
        save_view(&vault, "v", "name: V\n", None, &human()).unwrap();
        save_view(&vault, "v", "name: W\n", None, &human()).unwrap();
        let rows: Vec<(String, String, Option<String>, Option<String>)> = recorded(&vault)
            .into_iter()
            .map(|r| (r.0, r.1, r.3, r.4))
            .collect();
        let me = Some(super::super::receipt::HUMAN_ACTOR.to_string());
        assert_eq!(
            rows,
            vec![
                (
                    "vault.create".into(),
                    path,
                    Some("process:scout".into()),
                    Some("run-test".into())
                ),
                ("vault.create".into(), diagram, me.clone(), None),
                (
                    "vault.create".into(),
                    "views/v.yml".into(),
                    me.clone(),
                    None
                ),
                ("vault.write".into(), "views/v.yml".into(), me, None),
            ]
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn an_import_records_no_hash() {
        let _recording = Recording::new("wfm-import-recorded-config");
        let vault = testutil::temp_vault("wfm-import-recorded");
        let source_dir = testutil::temp_vault("wfm-import-recorded-source");
        let source = source_dir.join("report.pdf");
        std::fs::write(&source, b"%PDF-1.4").unwrap();
        let rel = import_attachment(&vault, source.to_str().unwrap(), &human()).unwrap();
        let rows = recorded(&vault);
        assert_eq!(rows.len(), 1);
        assert_eq!(
            (rows[0].0.as_str(), rows[0].1.as_str()),
            ("vault.create", rel.as_str())
        );
        assert_eq!(rows[0].2, None, "the copy's bytes are not read twice");
        for dir in [&vault, &source_dir] {
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    #[test]
    fn a_preview_and_a_stale_write_record_nothing() {
        let _recording = Recording::new("wfm-preview-recorded-config");
        let vault = vault_with_note("wfm-preview-recorded");
        append_note_in(
            &vault,
            "items/atl-1.md",
            "Previewed.",
            None,
            WriteMode::Preview,
            |_, _| Ok(()),
            &agent(),
        )
        .unwrap();
        create_note_in(
            &vault,
            "notes",
            "previewed",
            &patch(&[]),
            "",
            WriteMode::Preview,
            &agent(),
        )
        .unwrap();
        let stale = append_note_checked(
            &vault,
            "items/atl-1.md",
            "Stale.",
            Some(&"0".repeat(64)),
            |_, _| Ok(()),
            &agent(),
        );
        assert!(matches!(stale, Err(NoteWriteError::Stale(_))));
        assert_eq!(recorded(&vault), Vec::<Recorded>::new());
        assert_eq!(read(&vault, "items/atl-1.md"), NOTE);
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn a_concept_write_records_only_changed_bytes() {
        let _recording = Recording::new("wfm-concept-recorded-config");
        let vault = testutil::temp_vault("wfm-concept-recorded");
        let _shadow = crate::ledger::shadow::testing::activated(&vault);
        let rel = "knowledge/concepts/churn.md";
        let fm = patch(&[
            ("type", serde_json::json!("Reference")),
            ("title", serde_json::json!("Churn")),
            (
                "generated",
                serde_json::json!({ "by": "agent:run-1", "at": "2026-08-09" }),
            ),
        ]);
        write_concept(&vault, rel, &fm, "# Churn\n", &concept()).unwrap();
        let first = recorded(&vault);
        assert_eq!(first.len(), 1, "{first:?}");
        assert_eq!(
            (first[0].0.as_str(), first[0].1.as_str()),
            ("vault.create", rel)
        );
        assert_eq!(first[0].2, hashed(&read(&vault, rel)));
        // The same concept again changes no byte, and records nothing.
        write_concept(&vault, rel, &fm, "# Churn\n", &concept()).unwrap();
        assert_eq!(recorded(&vault), first);
        crate::ledger::shadow::deactivate();
        let _ = std::fs::remove_dir_all(&vault);
    }

    const NOTE: &str = "---\ntype: Work item\nkey: ATL-1\nstatus: todo\ncustom_field: kept\n---\n\n# Ship the scanner\n\nBody stays.\n";

    fn vault_with_note(label: &str) -> std::path::PathBuf {
        let vault = testutil::temp_vault(label);
        testutil::write(&vault, "items/atl-1.md", NOTE);
        vault
    }

    fn read(vault: &Path, rel: &str) -> String {
        std::fs::read_to_string(vault.join(rel)).unwrap()
    }

    fn patch(pairs: &[(&str, serde_json::Value)]) -> serde_json::Map<String, serde_json::Value> {
        pairs
            .iter()
            .cloned()
            .map(|(k, v)| (k.to_string(), v))
            .collect()
    }

    #[test]
    fn update_preserves_order_and_unknown_keys_byte_for_byte() {
        let vault = vault_with_note("wfm-update");
        update_frontmatter(
            &vault,
            "items/atl-1.md",
            &patch(&[("status", serde_json::json!("done"))]),
            &human(),
        )
        .unwrap();
        assert_eq!(
            read(&vault, "items/atl-1.md"),
            "---\ntype: Work item\nkey: ATL-1\nstatus: done\ncustom_field: kept\n---\n\n# Ship the scanner\n\nBody stays.\n"
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    // M55.11: a page's icon and cover are frontmatter like any other key, so
    // a patch to another key reserializes their lines: an emoji (a ZWJ one
    // too), a quoted hex colour and an attachment path must come back
    // byte-identical, and a null icon removes that line alone.
    #[test]
    fn a_page_icon_and_cover_survive_another_keys_patch_byte_for_byte() {
        let vault = testutil::temp_vault("wfm-page-chrome");
        let colour = "---\nicon: \u{1F680}\nbadge: \u{1F9D1}\u{200D}\u{1F680}\ncover: '#3D8BE8'\nstatus: todo\n---\n\n# Launch\n";
        let file = "---\nicon: \u{1F9D1}\u{200D}\u{1F680}\ncover: attachments/c.png\nstatus: todo\n---\n\n# Crew\n";
        testutil::write(&vault, "notes/launch.md", colour);
        testutil::write(&vault, "notes/crew.md", file);
        let done = patch(&[("status", serde_json::json!("done"))]);
        update_frontmatter(&vault, "notes/launch.md", &done, &human()).unwrap();
        update_frontmatter(&vault, "notes/crew.md", &done, &human()).unwrap();
        assert_eq!(
            read(&vault, "notes/launch.md"),
            colour.replace("status: todo", "status: done")
        );
        assert_eq!(
            read(&vault, "notes/crew.md"),
            file.replace("status: todo", "status: done")
        );
        update_frontmatter(
            &vault,
            "notes/launch.md",
            &patch(&[("icon", serde_json::Value::Null)]),
            &human(),
        )
        .unwrap();
        assert_eq!(
            read(&vault, "notes/launch.md"),
            colour
                .replace("icon: \u{1F680}\n", "")
                .replace("status: todo", "status: done")
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    // M55.2: the write answers the hash of the bytes it landed, which is the
    // hash the next scan reads, and read_note_hashed names the same bytes.
    #[test]
    fn update_frontmatter_returns_the_hash_of_what_it_wrote() {
        let vault = vault_with_note("wfm-hash");
        let hash = update_frontmatter(
            &vault,
            "items/atl-1.md",
            &patch(&[("status", serde_json::json!("done"))]),
            &human(),
        )
        .unwrap();
        let landed = std::fs::read(vault.join("items/atl-1.md")).unwrap();
        assert_eq!(hash, crate::ledger::sha256_hex(&landed));
        let scanned = crate::vault::scan::scan_vault(&vault).unwrap();
        let entry = scanned.iter().find(|e| e.path == "items/atl-1.md").unwrap();
        assert_eq!(entry.hash.as_deref(), Some(hash.as_str()));
        let (body, read_hash) = read_note_hashed(&vault, "items/atl-1.md").unwrap();
        assert_eq!(read_hash, hash);
        assert_eq!(body, read_note(&vault, "items/atl-1.md").unwrap());
        let _ = std::fs::remove_dir_all(&vault);
    }

    // --- set_note_fields (M60.4) --------------------------------------------

    #[test]
    fn set_note_fields_changes_only_the_planned_keys() {
        let vault = vault_with_note("wfm-fields-planned");
        let written = set_note_fields(
            &vault,
            "items/atl-1.md",
            |_| {
                Ok(patch(&[
                    ("status", serde_json::json!("in-progress")),
                    ("tags", serde_json::json!(["a"])),
                ]))
            },
            None,
            |_, _| Ok(()),
            WriteMode::Commit,
            &agent(),
        )
        .unwrap();
        let landed = read(&vault, "items/atl-1.md");
        assert_eq!(
            landed,
            "---\ntype: Work item\nkey: ATL-1\nstatus: in-progress\ncustom_field: kept\ntags:\n- a\n---\n\n# Ship the scanner\n\nBody stays.\n"
        );
        assert!(written.changed);
        assert_eq!(
            written.landing.after,
            crate::ledger::sha256_hex(landed.as_bytes())
        );
        assert_eq!(written.landing.before, hashed(NOTE));
        let _ = std::fs::remove_dir_all(&vault);
    }

    // The plan reads the bytes the lock holds, so a write that landed first
    // is what it builds on (a list delta composes with it).
    #[test]
    fn set_note_fields_plans_against_the_bytes_under_the_lock() {
        let vault = vault_with_note("wfm-fields-locked");
        update_frontmatter(
            &vault,
            "items/atl-1.md",
            &patch(&[("status", serde_json::json!("done"))]),
            &human(),
        )
        .unwrap();
        let mut seen = None;
        set_note_fields(
            &vault,
            "items/atl-1.md",
            |current| {
                seen = frontmatter_json("items/atl-1.md", current)
                    .unwrap()
                    .get("status")
                    .cloned();
                Ok(patch(&[("owner", serde_json::json!(["[[ana]]"]))]))
            },
            None,
            |_, _| Ok(()),
            WriteMode::Commit,
            &agent(),
        )
        .unwrap();
        assert_eq!(seen, Some(serde_json::json!("done")));
        assert!(read(&vault, "items/atl-1.md").contains("status: done\n"));
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn a_stale_expectation_on_set_note_fields_writes_nothing() {
        let _recording = Recording::new("wfm-fields-stale-config");
        let vault = vault_with_note("wfm-fields-stale");
        let mut planned = false;
        let outcome = set_note_fields(
            &vault,
            "items/atl-1.md",
            |_| {
                planned = true;
                Ok(patch(&[("status", serde_json::json!("done"))]))
            },
            Some(&"0".repeat(64)),
            |_, _| Ok(()),
            WriteMode::Commit,
            &agent(),
        );
        assert!(matches!(outcome, Err(NoteWriteError::Stale(_))));
        assert!(!planned, "a stale expectation refuses before the plan");
        assert_eq!(read(&vault, "items/atl-1.md"), NOTE);
        assert_eq!(recorded(&vault), Vec::<Recorded>::new());
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn a_preview_of_set_note_fields_writes_nothing() {
        let _recording = Recording::new("wfm-fields-preview-config");
        let vault = vault_with_note("wfm-fields-preview");
        let previewed = set_note_fields(
            &vault,
            "items/atl-1.md",
            |_| Ok(patch(&[("status", serde_json::json!("done"))])),
            None,
            |_, _| Ok(()),
            WriteMode::Preview,
            &agent(),
        )
        .unwrap();
        assert!(previewed.changed);
        assert_ne!(previewed.landing.after, hashed(NOTE).unwrap());
        assert_eq!(read(&vault, "items/atl-1.md"), NOTE);
        assert_eq!(recorded(&vault), Vec::<Recorded>::new());
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn an_unchanged_plan_writes_and_records_nothing() {
        let _recording = Recording::new("wfm-fields-unchanged-config");
        let vault = vault_with_note("wfm-fields-unchanged");
        let mtime = || {
            std::fs::metadata(vault.join("items/atl-1.md"))
                .unwrap()
                .modified()
                .unwrap()
        };
        let before = mtime();
        for planned in [patch(&[]), patch(&[("status", serde_json::json!("todo"))])] {
            let written = set_note_fields(
                &vault,
                "items/atl-1.md",
                |_| Ok(planned),
                None,
                |_, _| Ok(()),
                WriteMode::Commit,
                &agent(),
            )
            .unwrap();
            assert!(!written.changed);
            assert_eq!(Some(written.landing.after), hashed(NOTE));
        }
        assert_eq!(read(&vault, "items/atl-1.md"), NOTE);
        assert_eq!(mtime(), before);
        assert_eq!(recorded(&vault), Vec::<Recorded>::new());
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn set_note_fields_refuses_what_the_check_or_the_plan_refuses() {
        let vault = vault_with_note("wfm-fields-refused");
        let checked = set_note_fields(
            &vault,
            "items/atl-1.md",
            |_| Ok(patch(&[("status", serde_json::json!("done"))])),
            None,
            |_, _| Err("governed".to_string()),
            WriteMode::Commit,
            &agent(),
        );
        assert_eq!(checked, Err(NoteWriteError::Refused("governed".into())));
        let planned = set_note_fields(
            &vault,
            "items/atl-1.md",
            |_| Err("schema".to_string()),
            None,
            |_, _| Ok(()),
            WriteMode::Commit,
            &agent(),
        );
        assert_eq!(planned, Err(NoteWriteError::Refused("schema".into())));
        assert_eq!(read(&vault, "items/atl-1.md"), NOTE);
        testutil::write(
            &vault,
            "items/bad.md",
            "---\nkey: [unclosed\n---\n\n# Bad\n",
        );
        let malformed = frontmatter_json("items/bad.md", &read(&vault, "items/bad.md"));
        assert!(malformed
            .unwrap_err()
            .starts_with("items/bad.md: cannot patch malformed frontmatter:"));
        let _ = std::fs::remove_dir_all(&vault);
    }

    /// This vault's `vault_writes` rows, oldest first, from the armed sink.
    fn vault_write_rows(vault: &Path) -> Vec<(String, String)> {
        let vault_id = crate::runtime::scope::derive_vault_id(vault);
        crate::runtime::sink::with_sink(|conn| {
            let mut stmt = conn
                .prepare("SELECT kind, path FROM vault_writes WHERE vault_id = ?1 ORDER BY rowid")
                .unwrap();
            stmt.query_map([&vault_id], |r| Ok((r.get(0)?, r.get(1)?)))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
        })
        .expect("the sink is armed")
    }

    // M55.3: an agent write that names the hash of other bytes than the lock
    // holds writes nothing at all.
    #[test]
    fn a_stale_expectation_writes_nothing() {
        let _lock = crate::runtime::sink::test_lock();
        let config = testutil::temp_vault("wfm-stale-config");
        crate::runtime::sink::arm(&config).unwrap();
        let vault = vault_with_note("wfm-stale");
        let read_hash = crate::ledger::sha256_hex(read(&vault, "items/atl-1.md").as_bytes());
        // Someone else writes the note after the agent read it.
        save_note(
            &vault,
            "items/atl-1.md",
            "\n# Ship the scanner\n\nEdited.\n",
            &human(),
        )
        .unwrap();
        let bytes = read(&vault, "items/atl-1.md");
        let actual = crate::ledger::sha256_hex(bytes.as_bytes());
        let modified = || {
            std::fs::metadata(vault.join("items/atl-1.md"))
                .unwrap()
                .modified()
                .unwrap()
        };
        let mtime = modified();
        let rows = vault_write_rows(&vault);
        let stale = NoteWriteError::Stale(StaleContent {
            path: "items/atl-1.md".into(),
            expected: read_hash.clone(),
            actual,
        });

        let patched = patch_note_checked(
            &vault,
            "items/atl-1.md",
            &patch(&[("status", serde_json::json!("done"))]),
            Some(&read_hash),
            |_, _| Ok(()),
            &agent(),
        );
        assert_eq!(patched, Err(stale.clone()));
        let appended = append_note_checked(
            &vault,
            "items/atl-1.md",
            "More.",
            Some(&read_hash),
            |_, _| panic!("a stale write never reaches its check"),
            &agent(),
        );
        assert_eq!(appended, Err(stale));

        assert_eq!(
            read(&vault, "items/atl-1.md"),
            bytes,
            "the bytes are unchanged"
        );
        assert_eq!(modified(), mtime, "the file was not rewritten");
        assert_eq!(vault_write_rows(&vault), rows, "no vault_writes row");
        assert!(temp_files(&vault).is_empty(), "no temp file");
        crate::runtime::sink::disarm();
        let _ = std::fs::remove_dir_all(&vault);
        let _ = std::fs::remove_dir_all(&config);
    }

    #[test]
    fn a_matching_expectation_writes_and_answers_the_new_hash() {
        let vault = vault_with_note("wfm-expect-match");
        let (_, read_hash) = read_note_hashed(&vault, "items/atl-1.md").unwrap();
        let patched = patch_note_checked(
            &vault,
            "items/atl-1.md",
            &patch(&[("status", serde_json::json!("done"))]),
            Some(&read_hash),
            |_, _| Ok(()),
            &agent(),
        )
        .unwrap();
        assert_eq!(
            patched,
            crate::ledger::sha256_hex(read(&vault, "items/atl-1.md").as_bytes())
        );
        // The answered hash is the next write's expectation.
        let appended = append_note_checked(
            &vault,
            "items/atl-1.md",
            "More.",
            Some(&patched),
            |_, _| Ok(()),
            &agent(),
        )
        .unwrap();
        let landed = read(&vault, "items/atl-1.md");
        assert_eq!(appended, crate::ledger::sha256_hex(landed.as_bytes()));
        assert!(landed.contains("status: done"), "{landed}");
        assert!(landed.ends_with("Body stays.\n\nMore.\n"), "{landed}");
        let _ = std::fs::remove_dir_all(&vault);
    }

    // M57.4c: a preview runs every writer's checks and lands nothing: no
    // temp file, no rewrite, no vault_writes row.
    #[test]
    fn a_preview_writes_nothing() {
        let _lock = crate::runtime::sink::test_lock();
        let config = testutil::temp_vault("wfm-preview-config");
        crate::runtime::sink::arm(&config).unwrap();
        let vault = vault_with_note("wfm-preview");
        let bytes = read(&vault, "items/atl-1.md");
        let before = crate::ledger::sha256_hex(bytes.as_bytes());
        let modified = || {
            std::fs::metadata(vault.join("items/atl-1.md"))
                .unwrap()
                .modified()
                .unwrap()
        };
        let mtime = modified();
        let rows = vault_write_rows(&vault);
        let preview = WriteMode::Preview;

        let patched = patch_note_in(
            &vault,
            "items/atl-1.md",
            &patch(&[("status", serde_json::json!("done"))]),
            Some(&before),
            preview,
            |_, _| Ok(()),
            &agent(),
        )
        .unwrap();
        assert_eq!(patched.path, "items/atl-1.md");
        assert_eq!(patched.before.as_deref(), Some(before.as_str()));
        assert_eq!(
            patched.after,
            crate::ledger::sha256_hex(bytes.replace("status: todo", "status: done").as_bytes()),
            "the hash of the bytes it would land"
        );
        let appended = append_note_in(
            &vault,
            "items/atl-1.md",
            "More.",
            None,
            preview,
            |_, _| Ok(()),
            &agent(),
        )
        .unwrap();
        assert_ne!(appended.after, before);
        let quote = crate::vault::quote::QuoteEdit {
            old: "Body stays.".into(),
            new: "Body moved.".into(),
            occurrence: None,
        };
        let edited = edit_note_in(
            &vault,
            "items/atl-1.md",
            &[quote],
            None,
            preview,
            |_, _| Ok(()),
            &agent(),
        )
        .unwrap();
        assert_eq!(edited.before, before);
        let created = create_note_in(
            &vault,
            "items",
            "fresh",
            &serde_json::Map::new(),
            "# Fresh\n",
            preview,
            &agent(),
        )
        .unwrap();
        assert_eq!(
            (created.path.as_str(), created.before),
            ("items/fresh.md", None)
        );

        assert_eq!(
            read(&vault, "items/atl-1.md"),
            bytes,
            "the bytes are unchanged"
        );
        assert_eq!(modified(), mtime, "the file was not rewritten");
        assert!(
            !vault.join("items/fresh.md").exists(),
            "no file was created"
        );
        assert_eq!(vault_write_rows(&vault), rows, "no vault_writes row");
        assert!(temp_files(&vault).is_empty(), "no temp file");
        crate::runtime::sink::disarm();
        let _ = std::fs::remove_dir_all(&vault);
        let _ = std::fs::remove_dir_all(&config);
    }

    // M57.4c: what the write would refuse, the preview refuses: a stale
    // expectation, and the caller's byte check.
    #[test]
    fn a_preview_refuses_what_the_write_would() {
        let vault = vault_with_note("wfm-preview-refuses");
        let stale = "0".repeat(64);
        let refused = patch_note_in(
            &vault,
            "items/atl-1.md",
            &patch(&[("status", serde_json::json!("done"))]),
            Some(&stale),
            WriteMode::Preview,
            |_, _| Ok(()),
            &agent(),
        );
        assert!(
            matches!(refused, Err(NoteWriteError::Stale(_))),
            "{refused:?}"
        );
        let governed = append_note_in(
            &vault,
            "items/atl-1.md",
            "More.",
            None,
            WriteMode::Preview,
            |_, after| {
                if after.contains("More.") {
                    Err("governed bytes".to_string())
                } else {
                    Ok(())
                }
            },
            &agent(),
        );
        assert_eq!(
            governed,
            Err(NoteWriteError::Refused("governed bytes".into()))
        );
        assert!(append_note_in(
            &vault,
            ".git/config",
            "More.",
            None,
            WriteMode::Preview,
            |_, _| Ok(()),
            &agent()
        )
        .is_err());
        assert_eq!(read(&vault, "items/atl-1.md"), NOTE);
        let _ = std::fs::remove_dir_all(&vault);
    }

    // M57.4c: a preview create names the file the create would write, the
    // first free name.
    #[test]
    fn a_preview_create_names_the_first_free_file() {
        let vault = vault_with_note("wfm-preview-create");
        testutil::write(&vault, "items/fresh.md", "# Taken\n");
        let landing = create_note_in(
            &vault,
            "items",
            "fresh",
            &serde_json::Map::new(),
            "",
            WriteMode::Preview,
            &agent(),
        )
        .unwrap();
        assert_eq!(landing.path, "items/fresh-2.md");
        assert!(!vault.join("items/fresh-2.md").exists());
        let written = create_note(
            &vault,
            "items",
            "fresh",
            &serde_json::Map::new(),
            "",
            &human(),
        )
        .unwrap();
        assert_eq!(
            written, landing.path,
            "the write lands where the preview said"
        );
        assert_eq!(
            crate::ledger::sha256_hex(read(&vault, &written).as_bytes()),
            landing.after
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn a_human_save_never_compares() {
        let vault = vault_with_note("wfm-human-wins");
        let (_, read_hash) = read_note_hashed(&vault, "items/atl-1.md").unwrap();
        // The note changes on disk after the person's editor read it...
        testutil::write(
            &vault,
            "items/atl-1.md",
            &NOTE.replace("Body stays.", "Outside."),
        );
        assert_ne!(
            read_note_hashed(&vault, "items/atl-1.md").unwrap().1,
            read_hash
        );
        // ...and the person's save and property edit still land: last write wins.
        save_note(
            &vault,
            "items/atl-1.md",
            "\n# Ship the scanner\n\nMine.\n",
            &human(),
        )
        .unwrap();
        update_frontmatter(
            &vault,
            "items/atl-1.md",
            &patch(&[("status", serde_json::json!("done"))]),
            &human(),
        )
        .unwrap();
        let landed = read(&vault, "items/atl-1.md");
        assert!(landed.contains("status: done"), "{landed}");
        assert!(landed.ends_with("Mine.\n"), "{landed}");
        assert!(!landed.contains("Outside."), "{landed}");
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn null_patch_value_deletes_the_key_preserving_order() {
        let vault = vault_with_note("wfm-delete");
        update_frontmatter(
            &vault,
            "items/atl-1.md",
            &patch(&[("key", serde_json::Value::Null)]),
            &human(),
        )
        .unwrap();
        assert_eq!(
            read(&vault, "items/atl-1.md"),
            "---\ntype: Work item\nstatus: todo\ncustom_field: kept\n---\n\n# Ship the scanner\n\nBody stays.\n"
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn new_keys_are_appended_at_the_end() {
        let vault = vault_with_note("wfm-append");
        update_frontmatter(
            &vault,
            "items/atl-1.md",
            &patch(&[("due", serde_json::json!("2026-08-01"))]),
            &human(),
        )
        .unwrap();
        let raw = read(&vault, "items/atl-1.md");
        assert!(
            raw.contains("custom_field: kept\ndue: 2026-08-01\n---\n"),
            "{raw}"
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    // split_frontmatter's byte-reproduction invariant only holds for LF-only,
    // BOM-free files with a bare `---` closing fence (parse.rs:9-15). Writes
    // may normalize fences to LF form but must never corrupt such files.
    #[test]
    fn update_normalizes_crlf_fences_without_corrupting_the_file() {
        let vault = testutil::temp_vault("wfm-crlf");
        testutil::write(
            &vault,
            "items/crlf.md",
            "---\r\ntype: Work item\r\nstatus: todo\r\n---\r\n\r\n# Crlf note\r\n\r\nBody stays.\r\n",
        );
        update_frontmatter(
            &vault,
            "items/crlf.md",
            &patch(&[("status", serde_json::json!("done"))]),
            &human(),
        )
        .unwrap();
        let raw = read(&vault, "items/crlf.md");
        // No duplicated or dropped fences.
        assert_eq!(raw.matches("---").count(), 2, "{raw}");
        // Frontmatter survives the patch (fences may be normalized to LF).
        let (block, body) = parse::split_frontmatter(&raw);
        let mapping = parse::parse_frontmatter(block.expect("frontmatter kept")).unwrap();
        assert_eq!(
            mapping.get("type").and_then(|v| v.as_str()),
            Some("Work item")
        );
        assert_eq!(mapping.get("status").and_then(|v| v.as_str()), Some("done"));
        // Body is untouched.
        assert_eq!(body, "\r\n# Crlf note\r\n\r\nBody stays.\r\n");
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn save_note_replaces_body_and_keeps_frontmatter_bytes() {
        let vault = vault_with_note("wfm-save");
        save_note(
            &vault,
            "items/atl-1.md",
            "\n# Ship the scanner\n\nNew body.\n",
            &human(),
        )
        .unwrap();
        assert_eq!(
            read(&vault, "items/atl-1.md"),
            "---\ntype: Work item\nkey: ATL-1\nstatus: todo\ncustom_field: kept\n---\n\n# Ship the scanner\n\nNew body.\n"
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn read_note_returns_body_only() {
        let vault = vault_with_note("wfm-read");
        assert_eq!(
            read_note(&vault, "items/atl-1.md").unwrap(),
            "\n# Ship the scanner\n\nBody stays.\n"
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    // M29.20: the raw round-trip. A .mmd whose first bytes are mermaid's own
    // `---` config header must survive read→save byte-identically — the note
    // pipeline would strip that header as frontmatter and destroy the file.
    #[test]
    fn mmd_round_trips_raw_through_read_and_save() {
        const MMD: &str =
            "---\ntitle: Pipeline\nconfig:\n  layout: elk\n---\nflowchart TD\n  A --> B\n";
        let vault = testutil::temp_vault("wfm-mmd-raw");
        testutil::write(&vault, "diagrams/pipeline.mmd", MMD);
        let read_back = read_note(&vault, "diagrams/pipeline.mmd").unwrap();
        assert_eq!(read_back, MMD);
        save_note(&vault, "diagrams/pipeline.mmd", &read_back, &human()).unwrap();
        assert_eq!(read(&vault, "diagrams/pipeline.mmd"), MMD);
        // Saving edited source writes exactly those bytes, header included.
        let edited = format!("{MMD}  B --> C\n");
        save_note(&vault, "diagrams/pipeline.mmd", &edited, &human()).unwrap();
        assert_eq!(read(&vault, "diagrams/pipeline.mmd"), edited);
        // Same contract as .md: save only overwrites an existing file.
        assert!(save_note(&vault, "diagrams/nope.mmd", "flowchart TD\n", &human()).is_err());
        let _ = std::fs::remove_dir_all(&vault);
    }

    // The other doors stay shut too (M29.23): mermaid's config header IS
    // valid YAML, so without these guards a frontmatter patch — including the
    // agent's MCP update_frontmatter — would merge into it and reserialize.
    #[test]
    fn mmd_refuses_frontmatter_updates_and_reads_as_untyped() {
        const MMD: &str = "---\ntype: Should never surface\nconfig:\n  layout: elk\n---\nflowchart TD\n  A --> B\n";
        let vault = testutil::temp_vault("wfm-mmd-doors");
        testutil::write(&vault, "diagrams/pipeline.mmd", MMD);
        let err = update_frontmatter(
            &vault,
            "diagrams/pipeline.mmd",
            &patch(&[("status", serde_json::json!("done"))]),
            &human(),
        )
        .unwrap_err();
        assert!(err.contains("no frontmatter"), "{err}");
        // The file is byte-identical — the refusal happened before any write.
        assert_eq!(read(&vault, "diagrams/pipeline.mmd"), MMD);
        // The header's `type:` key is diagram data, never vault schema.
        assert_eq!(note_type(&vault, "diagrams/pipeline.mmd"), None);
        let _ = std::fs::remove_dir_all(&vault);
    }

    // --- write_text_file (M29.22) -------------------------------------------

    #[test]
    fn write_text_file_writes_mmd_and_dedupes_the_stem() {
        let vault = testutil::temp_vault("wfm-textfile");
        let first =
            write_text_file(&vault, "diagrams/flowchart.mmd", "flowchart TD\n", &human()).unwrap();
        let second =
            write_text_file(&vault, "diagrams/flowchart.mmd", "graph LR\n", &human()).unwrap();
        assert_eq!(first, "diagrams/flowchart.mmd");
        assert_eq!(second, "diagrams/flowchart-2.mmd");
        // Neither clobbered the other, and the bytes are verbatim.
        assert_eq!(read(&vault, "diagrams/flowchart.mmd"), "flowchart TD\n");
        assert_eq!(read(&vault, "diagrams/flowchart-2.mmd"), "graph LR\n");
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn write_text_file_rejects_disallowed_extensions_knowledge_and_escapes() {
        let vault = testutil::temp_vault("wfm-textfile-guard");
        // A raw writer aimed at .md would bypass the whole note pipeline.
        assert!(write_text_file(&vault, "notes/evil.md", "# hi\n", &human()).is_err());
        assert!(write_text_file(&vault, "notes/evil.sh", "rm -rf\n", &human()).is_err());
        assert!(write_text_file(&vault, "notes/no-extension", "x\n", &human()).is_err());
        // The bundle is the agent's to write — same guard as every human door,
        // and no receipt is minted past it (M58.1).
        assert!(crate::knowledge::guard_human_write("knowledge/concept.mmd").is_err());
        // Containment, same as every other write.
        assert!(write_text_file(&vault, "../outside.mmd", "graph TD\n", &human()).is_err());
        assert!(write_text_file(&vault, "/tmp/abs.mmd", "graph TD\n", &human()).is_err());
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn create_note_writes_frontmatter_and_dedupes_slug() {
        let vault = testutil::temp_vault("wfm-create");
        let fm = patch(&[
            ("type", serde_json::json!("Work item")),
            ("status", serde_json::json!("todo")),
        ]);
        let first =
            create_note(&vault, "items", "new-item", &fm, "# New item\n", &human()).unwrap();
        let second =
            create_note(&vault, "items", "new-item", &fm, "# New item\n", &human()).unwrap();
        let third =
            create_note(&vault, "items", "new-item", &fm, "# New item\n", &human()).unwrap();
        assert_eq!(first, "items/new-item.md");
        assert_eq!(second, "items/new-item-2.md");
        assert_eq!(third, "items/new-item-3.md");
        assert_eq!(
            read(&vault, "items/new-item.md"),
            "---\ntype: Work item\nstatus: todo\n---\n\n# New item\n"
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn create_note_with_empty_body_gets_default_h1() {
        let vault = testutil::temp_vault("wfm-create-empty");
        create_note(&vault, "items", "empty-note", &patch(&[]), "", &human()).unwrap();
        // Sentence case per humanize_stem (engine/frontmatter.ts parity).
        assert_eq!(read(&vault, "items/empty-note.md"), "# Empty note\n");
        let _ = std::fs::remove_dir_all(&vault);
    }

    // M61.6b: told to refuse, a create over a taken slug writes nothing at
    // all, and says which note holds the name.
    #[test]
    fn create_note_refuses_a_taken_slug_when_asked() {
        let _recording = Recording::new("wfm-refuse-config");
        let vault = testutil::temp_vault("wfm-refuse");
        testutil::write(&vault, "items/new-item.md", "# Taken\n");
        let modified = || {
            std::fs::metadata(vault.join("items/new-item.md"))
                .unwrap()
                .modified()
                .unwrap()
        };
        let mtime = modified();
        for mode in [WriteMode::Commit, WriteMode::Preview] {
            let refused = create_note_if(
                &vault,
                "items",
                "new-item",
                &patch(&[]),
                "# New item\n",
                mode,
                IfExists::Refuse,
                &agent(),
            );
            assert_eq!(
                refused,
                Err(CreateNoteError::Exists("items/new-item.md".into())),
                "{mode:?}"
            );
        }
        assert_eq!(read(&vault, "items/new-item.md"), "# Taken\n");
        assert_eq!(modified(), mtime, "the file was not rewritten");
        assert!(!vault.join("items/new-item-2.md").exists(), "no copy");
        assert!(temp_files(&vault).is_empty(), "no temp file");
        assert_eq!(
            recorded(&vault),
            Vec::<Recorded>::new(),
            "no vault_writes row"
        );
        assert_eq!(
            String::from(CreateNoteError::Exists("items/new-item.md".into())),
            "items/new-item.md already exists, so nothing was written"
        );
        // A free name lands as the plain create would.
        let landed = create_note_if(
            &vault,
            "items",
            "other",
            &patch(&[]),
            "# Other\n",
            WriteMode::Commit,
            IfExists::Refuse,
            &agent(),
        )
        .unwrap();
        assert_eq!(landed.path, "items/other.md");
        assert_eq!(read(&vault, "items/other.md"), "# Other\n");
        assert_eq!(recorded(&vault).len(), 1);
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn create_note_still_numbers_a_copy_by_default() {
        let vault = testutil::temp_vault("wfm-suffix-default");
        testutil::write(&vault, "items/new-item.md", "# Taken\n");
        let numbered = create_note_if(
            &vault,
            "items",
            "new-item",
            &patch(&[]),
            "# New item\n",
            WriteMode::Commit,
            IfExists::Suffix,
            &human(),
        )
        .unwrap();
        assert_eq!(numbered.path, "items/new-item-2.md");
        let plain = create_note(
            &vault,
            "items",
            "new-item",
            &patch(&[]),
            "# New item\n",
            &human(),
        )
        .unwrap();
        assert_eq!(plain, "items/new-item-3.md");
        assert_eq!(read(&vault, "items/new-item.md"), "# Taken\n");
        let _ = std::fs::remove_dir_all(&vault);
    }

    // Two refusing creates of one free slug race: the name is asked again
    // under its lock, so exactly one lands and the other is refused.
    #[test]
    fn a_refusing_create_checks_under_the_lock() {
        let vault = testutil::temp_vault("wfm-refuse-race");
        std::fs::create_dir_all(vault.join("items")).unwrap();
        let start = std::sync::Arc::new(std::sync::Barrier::new(2));
        let racers: Vec<_> = (0..2)
            .map(|n| {
                let vault = vault.clone();
                let start = start.clone();
                std::thread::spawn(move || {
                    start.wait();
                    create_note_if(
                        &vault,
                        "items",
                        "raced",
                        &patch(&[]),
                        &format!("# Racer {n}\n"),
                        WriteMode::Commit,
                        IfExists::Refuse,
                        &human(),
                    )
                })
            })
            .collect();
        let outcomes: Vec<_> = racers.into_iter().map(|r| r.join().unwrap()).collect();
        let landed = outcomes.iter().filter(|o| o.is_ok()).count();
        assert_eq!(landed, 1, "{outcomes:?}");
        assert!(outcomes
            .iter()
            .any(|o| o == &Err(CreateNoteError::Exists("items/raced.md".into()))));
        let files: Vec<_> = std::fs::read_dir(vault.join("items"))
            .unwrap()
            .filter_map(Result::ok)
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(files, vec!["raced.md".to_string()]);
        let _ = std::fs::remove_dir_all(&vault);
    }

    // Where the disk folds case (APFS and HFS+ by default), `Raced.md` holds
    // the name `raced` too; where it does not, the two are different notes.
    #[test]
    fn refuse_matches_a_case_folded_name_where_the_disk_folds_case() {
        let vault = testutil::temp_vault("wfm-refuse-case");
        testutil::write(&vault, "items/Taken.md", "# Taken\n");
        let folds = vault.join("items/taken.md").exists();
        let outcome = create_note_if(
            &vault,
            "items",
            "taken",
            &patch(&[]),
            "# Taken again\n",
            WriteMode::Commit,
            IfExists::Refuse,
            &human(),
        );
        if folds {
            assert_eq!(
                outcome,
                Err(CreateNoteError::Exists("items/taken.md".into()))
            );
            assert_eq!(read(&vault, "items/Taken.md"), "# Taken\n");
        } else {
            assert_eq!(outcome.unwrap().path, "items/taken.md");
            assert_eq!(read(&vault, "items/Taken.md"), "# Taken\n");
        }
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn set_note_title_replaces_existing_h1() {
        let vault = vault_with_note("wfm-title");
        set_note_title(&vault, "items/atl-1.md", "Renamed item", &human()).unwrap();
        assert_eq!(
            read(&vault, "items/atl-1.md"),
            "---\ntype: Work item\nkey: ATL-1\nstatus: todo\ncustom_field: kept\n---\n\n# Renamed item\n\nBody stays.\n"
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn set_note_title_inserts_h1_when_missing() {
        let vault = testutil::temp_vault("wfm-title-insert");
        testutil::write(&vault, "items/no-title.md", "Just prose.\n");
        set_note_title(&vault, "items/no-title.md", "Now titled", &human()).unwrap();
        assert_eq!(
            read(&vault, "items/no-title.md"),
            "# Now titled\n\nJust prose.\n"
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    // set_note_title must agree with parse::extract_h1_title about which line
    // is the H1: fenced/indented code lines are never the title.
    #[test]
    fn set_note_title_skips_h1_inside_code_fences() {
        let vault = testutil::temp_vault("wfm-title-fence");
        testutil::write(
            &vault,
            "items/fenced.md",
            "---\ntype: Work item\n---\n\nintro\n\n```bash\n# a comment in code\necho hi\n```\n\n# Real title\n\nBody stays.\n",
        );
        set_note_title(&vault, "items/fenced.md", "Renamed", &human()).unwrap();
        assert_eq!(
            read(&vault, "items/fenced.md"),
            "---\ntype: Work item\n---\n\nintro\n\n```bash\n# a comment in code\necho hi\n```\n\n# Renamed\n\nBody stays.\n"
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn set_note_title_prepends_h1_when_only_fenced_h1_exists() {
        let vault = testutil::temp_vault("wfm-title-fence-only");
        testutil::write(&vault, "items/code.md", "```\n# only in code\n```\n");
        set_note_title(&vault, "items/code.md", "Now titled", &human()).unwrap();
        assert_eq!(
            read(&vault, "items/code.md"),
            "# Now titled\n\n```\n# only in code\n```\n"
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn set_note_title_preserves_crlf_body_bytes_outside_the_h1_line() {
        let vault = testutil::temp_vault("wfm-title-crlf");
        testutil::write(
            &vault,
            "items/crlf-title.md",
            "# Old title\r\n\r\nBody stays.\r\n",
        );
        set_note_title(&vault, "items/crlf-title.md", "New title", &human()).unwrap();
        assert_eq!(
            read(&vault, "items/crlf-title.md"),
            "# New title\r\n\r\nBody stays.\r\n"
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn a_list_belongs_to_the_collection_its_folder_note_declares() {
        // M47.5. A container used to be a folder holding `collection.yml`; it
        // is a folder whose own PAGE says `type: Collection` now. A List in
        // such a folder must report that folder as its collection — reported
        // as root-level, the app looks for it under a collection it does not
        // have and renders "This list no longer exists" on a list it just
        // created. Found exactly that way, on a freshly converted vault.
        let vault = testutil::temp_vault("wfm-collection-page");
        std::fs::create_dir_all(vault.join("delivery")).unwrap();
        std::fs::write(
            vault.join("delivery/delivery.md"),
            "---\ntype: Collection\nicon: rocket\n---\n\n# Delivery\n",
        )
        .unwrap();
        std::fs::write(
            vault.join("delivery/smoke.list.yml"),
            "name: Smoke\npresentation:\n  type: table\n",
        )
        .unwrap();

        let views = list_views(&vault).unwrap();
        assert_eq!(views.len(), 1);
        assert_eq!(views[0].collection.as_deref(), Some("delivery"));
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn a_page_of_that_type_elsewhere_does_not_declare_a_collection() {
        // Only the FOLDER NOTE speaks for its folder. A page merely carrying
        // the type would otherwise let any file rename a container it is not
        // even in.
        let vault = testutil::temp_vault("wfm-collection-stray");
        std::fs::create_dir_all(vault.join("inbox")).unwrap();
        std::fs::write(
            vault.join("inbox/delivery.md"),
            "---\ntype: Collection\n---\n\n# Delivery\n",
        )
        .unwrap();
        std::fs::write(vault.join("inbox/smoke.list.yml"), "name: Smoke\n").unwrap();

        let views = list_views(&vault).unwrap();
        assert_eq!(views.len(), 1);
        assert_eq!(views[0].collection, None);
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn a_folder_note_declares_a_collection_exactly_when_the_scanner_types_it_one() {
        // M48.7. A hand-rolled `---\n` + `type: Collection` line match
        // disagreed with the scanner, and the app reads the scanner: it called
        // the first four folders Collections while their Lists came back at
        // the vault root. Parity cases: mockIpc.test.ts.
        let vault = testutil::temp_vault("wfm-collection-shapes");
        let shapes = [
            (
                "crlf",
                "---\r\ntype: Collection\r\n---\r\n\r\n# Crlf\r\n",
                true,
            ),
            ("bom", "\u{feff}---\ntype: Collection\n---\n\n# Bom\n", true),
            (
                "quoted",
                "---\ntype: \"Collection\"\n---\n\n# Quoted\n",
                true,
            ),
            (
                "commented",
                "---\ntype: Collection # container\n---\n\n# C\n",
                true,
            ),
            (
                "prose",
                "---\ntitle: Prose\n---\n\ntype: Collection\n",
                false,
            ),
            (
                "nested",
                "---\nmeta:\n  type: Collection\n---\n\n# Nested\n",
                false,
            ),
        ];
        for (folder, note, _) in shapes {
            std::fs::create_dir_all(vault.join(folder)).unwrap();
            std::fs::write(vault.join(format!("{folder}/{folder}.md")), note).unwrap();
            std::fs::write(
                vault.join(format!("{folder}/{folder}.list.yml")),
                "name: L\n",
            )
            .unwrap();
        }

        let views = list_views(&vault).unwrap();
        assert_eq!(views.len(), shapes.len());
        for (folder, _, declares) in shapes {
            let view = views.iter().find(|v| v.id == folder).unwrap();
            let expected = declares.then_some(folder);
            assert_eq!(view.collection.as_deref(), expected, "{folder}");
        }
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn views_round_trip_as_raw_yaml() {
        let vault = testutil::temp_vault("wfm-views");
        assert!(list_views(&vault).unwrap().is_empty());
        save_view(
            &vault,
            "all-items",
            "name: All items\npresentation:\n  type: list\n",
            None,
            &human(),
        )
        .unwrap();
        save_view(&vault, "board", "name: Board\n", None, &human()).unwrap();
        let views = list_views(&vault).unwrap();
        assert_eq!(views.len(), 2);
        assert_eq!(views[0].id, "all-items");
        assert_eq!(
            views[0].yaml,
            "name: All items\npresentation:\n  type: list\n"
        );
        assert_eq!(views[0].project, None);
        assert_eq!(views[1].id, "board");
        let _ = std::fs::remove_dir_all(&vault);
    }

    // --- M10 Collections ---------------------------------------------------

    #[test]
    fn collections_are_folders_holding_a_marker() {
        let vault = testutil::temp_vault("wfm-collections");
        assert!(list_collections(&vault).unwrap().is_empty());
        save_collection(
            &vault,
            "product",
            "name: Product\nicon: package\n",
            &human(),
        )
        .unwrap();
        save_collection(&vault, "ops", "name: Ops\n", &human()).unwrap();
        // A nested Collection is legal — a Collection is just a marked folder.
        save_collection(&vault, "product/platform", "name: Platform\n", &human()).unwrap();

        let found = list_collections(&vault).unwrap();
        assert_eq!(
            found.iter().map(|c| c.folder.as_str()).collect::<Vec<_>>(),
            vec!["ops", "product", "product/platform"],
        );
        assert_eq!(found[1].yaml, "name: Product\nicon: package\n");
        assert!(vault.join("product/collection.yml").is_file());
        // Containment is enforced here, not in the caller.
        assert!(save_collection(&vault, "../outside", "name: E\n", &human()).is_err());
        assert!(save_collection(&vault, "", "name: E\n", &human()).is_err());
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn lists_belong_to_the_nearest_ancestor_collection() {
        let vault = testutil::temp_vault("wfm-lists");
        save_collection(&vault, "product", "name: Product\n", &human()).unwrap();
        save_list(&vault, "product", "roadmap", "name: Roadmap\n", &human()).unwrap();
        // A List in a plain sub-FOLDER still belongs to the Collection above
        // it — same containment rule projects already use.
        save_list(&vault, "product/q3", "risks", "name: Risks\n", &human()).unwrap();
        // A top-level List has no Collection rather than being force-fitted.
        save_list(&vault, "", "inbox-triage", "name: Triage\n", &human()).unwrap();

        let lists = list_views(&vault).unwrap();
        let by_id = |id: &str| lists.iter().find(|l| l.id == id).unwrap().clone();
        assert_eq!(by_id("roadmap").collection.as_deref(), Some("product"));
        assert_eq!(by_id("risks").collection.as_deref(), Some("product"));
        assert_eq!(by_id("inbox-triage").collection, None);
        assert_eq!(by_id("roadmap").path, "product/roadmap.list.yml");
        assert_eq!(by_id("risks").path, "product/q3/risks.list.yml");
        assert_eq!(by_id("inbox-triage").path, "inbox-triage.list.yml");
        assert!(save_list(&vault, "../outside", "evil", "name: E\n", &human()).is_err());
        assert!(save_list(&vault, "product", "sub/dir", "name: E\n", &human()).is_err());
        let _ = std::fs::remove_dir_all(&vault);
    }

    // The migration guarantee: a vault written before M10 keeps working, with
    // its legacy views surfacing as top-level Lists. Nothing has to move.
    #[test]
    fn legacy_views_load_beside_m10_lists() {
        let vault = testutil::temp_vault("wfm-legacy-lists");
        testutil::write(
            &vault,
            "projects/atlas/project.md",
            "---\ntype: Project\n---\n\n# Atlas\n",
        );
        save_view(&vault, "old-global", "name: Old global\n", None, &human()).unwrap();
        save_view(
            &vault,
            "old-scoped",
            "name: Old scoped\n",
            Some("projects/atlas"),
            &human(),
        )
        .unwrap();
        save_collection(&vault, "product", "name: Product\n", &human()).unwrap();
        save_list(&vault, "product", "roadmap", "name: Roadmap\n", &human()).unwrap();

        let lists = list_views(&vault).unwrap();
        assert_eq!(lists.len(), 3);
        let by_id = |id: &str| lists.iter().find(|l| l.id == id).unwrap().clone();
        // Legacy views carry no collection, so they list at the top level.
        assert_eq!(by_id("old-global").collection, None);
        assert_eq!(by_id("old-global").path, "views/old-global.yml");
        assert_eq!(
            by_id("old-scoped").project.as_deref(),
            Some("projects/atlas/project.md")
        );
        assert_eq!(by_id("roadmap").collection.as_deref(), Some("product"));
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn a_bare_list_suffix_is_not_a_list() {
        let vault = testutil::temp_vault("wfm-bare-list");
        // `.list.yml` with no name would produce an empty id, which is not a
        // thing the UI can navigate to or the writer can round-trip.
        testutil::write(&vault, ".list.yml", "name: Nameless\n");
        testutil::write(&vault, "notes.yml", "name: Not a list\n");
        assert!(list_views(&vault).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&vault);
    }

    // M2 Task 6: views/ dirs inside project folders are project-scoped.
    #[test]
    fn project_views_carry_their_project_and_sort_after_globals() {
        let vault = testutil::temp_vault("wfm-project-views");
        testutil::write(
            &vault,
            "projects/atlas/project.md",
            "---\ntype: Project\n---\n\n# Atlas\n",
        );
        save_view(&vault, "global", "name: Global\n", None, &human()).unwrap();
        save_view(
            &vault,
            "delivery",
            "name: Delivery\n",
            Some("projects/atlas"),
            &human(),
        )
        .unwrap();
        let views = list_views(&vault).unwrap();
        assert_eq!(views.len(), 2);
        assert_eq!(views[0].id, "global");
        assert_eq!(views[0].project, None);
        assert_eq!(views[1].id, "delivery");
        assert_eq!(
            views[1].project.as_deref(),
            Some("projects/atlas/project.md")
        );
        assert!(vault.join("projects/atlas/views/delivery.yml").is_file());
        // Escaping folders are rejected.
        assert!(save_view(&vault, "evil", "name: E\n", Some("../outside"), &human()).is_err());
        let _ = std::fs::remove_dir_all(&vault);
    }

    // Containment: rel paths, folders, slugs, and view ids reach Tauri IPC
    // unchanged (Task 7), so escapes must be rejected here.
    #[test]
    fn writes_reject_paths_that_escape_the_vault() {
        let vault = vault_with_note("wfm-escape");
        // A real file one level above the vault root: without containment,
        // "../<name>" reaches and modifies it.
        let victim = vault
            .parent()
            .unwrap()
            .join(format!("cerebro-victim-{}.md", std::process::id()));
        const VICTIM: &str = "---\nsafe: true\n---\nUntouched.\n";
        std::fs::write(&victim, VICTIM).unwrap();
        let victim_rel = format!("../{}", victim.file_name().unwrap().to_str().unwrap());
        let hacked = patch(&[("hacked", serde_json::json!(true))]);

        assert!(update_frontmatter(&vault, &victim_rel, &hacked, &human()).is_err());
        assert!(save_note(&vault, &victim_rel, "hacked\n", &human()).is_err());
        assert!(set_note_title(&vault, &victim_rel, "Hacked", &human()).is_err());
        assert!(read_note(&vault, &victim_rel).is_err());
        // Absolute paths must be rejected too: Path::join replaces the base.
        let abs = victim.to_str().unwrap();
        assert!(update_frontmatter(&vault, abs, &hacked, &human()).is_err());
        assert!(read_note(&vault, abs).is_err());
        // Traversal buried mid-path is still traversal.
        assert!(read_note(&vault, "items/../../x.md").is_err());

        assert_eq!(std::fs::read_to_string(&victim).unwrap(), VICTIM);
        let _ = std::fs::remove_file(&victim);
        let _ = std::fs::remove_dir_all(&vault);
    }

    // A component-only check (Task 7's `../` rejection) cannot see that a
    // perfectly normal-looking name resolves somewhere else on disk. This is
    // the M1 gap: a symlink planted inside the vault made every containment
    // check upstream of the filesystem call vacuously true.
    #[test]
    fn writes_reject_paths_through_a_symlink_that_escapes_the_vault() {
        let vault = vault_with_note("wfm-symlink-escape");
        let victim = vault
            .parent()
            .unwrap()
            .join(format!("cerebro-symlink-victim-{}.md", std::process::id()));
        const VICTIM: &str = "---\nsafe: true\n---\nUntouched.\n";
        std::fs::write(&victim, VICTIM).unwrap();

        // A symlink INSIDE the vault whose own name has no `..` and isn't
        // absolute, so it sails through the component check — but it
        // resolves outside the vault root.
        let link_rel = "link.md";
        std::os::unix::fs::symlink(&victim, vault.join(link_rel)).unwrap();

        let hacked = patch(&[("hacked", serde_json::json!(true))]);
        assert!(update_frontmatter(&vault, link_rel, &hacked, &human()).is_err());
        assert!(save_note(&vault, link_rel, "hacked\n", &human()).is_err());
        assert!(set_note_title(&vault, link_rel, "Hacked", &human()).is_err());
        assert!(read_note(&vault, link_rel).is_err());

        // Same attack one directory down: the escaping symlink is an
        // intermediate component, not the leaf, and the leaf itself does
        // not exist yet.
        let escape_dir_rel = "escape";
        std::os::unix::fs::symlink(vault.parent().unwrap(), vault.join(escape_dir_rel)).unwrap();
        let nested_rel = format!("{escape_dir_rel}/new-file.md");
        assert!(save_note(&vault, &nested_rel, "hacked\n", &human()).is_err());
        assert!(read_note(&vault, &nested_rel).is_err());

        assert_eq!(std::fs::read_to_string(&victim).unwrap(), VICTIM);
        let _ = std::fs::remove_file(&victim);
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn create_note_rejects_escaping_folder_and_non_component_slug() {
        let vault = testutil::temp_vault("wfm-create-escape");
        let fm = patch(&[]);
        assert!(create_note(&vault, "../escaped", "note", &fm, "x\n", &human()).is_err());
        assert!(create_note(&vault, "/tmp", "note", &fm, "x\n", &human()).is_err());
        assert!(create_note(&vault, "items", "../sneaky", &fm, "x\n", &human()).is_err());
        assert!(create_note(&vault, "items", "a/../b", &fm, "x\n", &human()).is_err());
        assert!(create_note(&vault, "items", "a/b", &fm, "x\n", &human()).is_err());
        assert!(create_note(&vault, "items", "", &fm, "x\n", &human()).is_err());
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn save_view_rejects_non_component_ids() {
        let vault = testutil::temp_vault("wfm-view-escape");
        assert!(save_view(&vault, "../../evil-view", "name: Evil\n", None, &human()).is_err());
        assert!(save_view(&vault, "nested/id", "name: Evil\n", None, &human()).is_err());
        assert!(save_view(&vault, "", "name: Evil\n", None, &human()).is_err());
        let _ = std::fs::remove_dir_all(&vault);
    }

    // --- Note targets (PLATFORM-API-1) -----------------------------------

    /// Every regular file under `vault`, dot-folders included, with its bytes:
    /// what "a refusal changed nothing" means. Symlinks are not followed, so
    /// a write carried through one shows up at the file it reached.
    /// The edit_note door's edit in the shared cases: the seed's heading.
    fn seed_to_landed() -> Vec<crate::vault::quote::QuoteEdit> {
        vec![crate::vault::quote::QuoteEdit {
            old: "Seed".into(),
            new: "Landed".into(),
            occurrence: None,
        }]
    }

    fn snapshot(vault: &Path) -> std::collections::BTreeMap<std::path::PathBuf, Vec<u8>> {
        walkdir::WalkDir::new(vault)
            .into_iter()
            .filter_map(Result::ok)
            .filter(|e| e.file_type().is_file())
            .map(|e| (e.path().to_path_buf(), std::fs::read(e.path()).unwrap()))
            .collect()
    }

    /// The cases src/lib/mockIpc.test.ts replays through the mock's doors.
    const NOTE_TARGETS: &str = include_str!("../../fixtures/note-targets.json");

    // The parity half: every note door here and its mock twin answer every
    // shared case alike — the agent's `.git/config` and ledger segment, the
    // upper-case spellings APFS folds onto them, the files an append or a
    // patch would corrupt — and a refusal leaves every byte where it was.
    #[test]
    fn note_targets_replay_the_shared_cases() {
        // The batch doors (M60.6) journal what they write.
        let _recording = Recording::new("wfm-note-targets-config");
        let file: serde_json::Value =
            serde_json::from_str(NOTE_TARGETS).expect("note-targets.json parses");
        let seed = file["seed"].as_str().expect("a seed");
        for case in file["cases"].as_array().expect("cases") {
            let vault = testutil::temp_vault("wfm-note-targets");
            let door = case["door"].as_str().expect("a door");
            let path = case["path"].as_str().unwrap_or_default();
            let edits = matches!(
                door,
                "save_note"
                    | "update_frontmatter"
                    | "set_note_title"
                    | "edit_note"
                    | "set_fields"
                    | "restore_version"
                    | "batch_patch"
                    | "batch_body"
            );
            if edits && case["seed"] != serde_json::json!(false) {
                testutil::write(&vault, path, seed);
            }
            let before = snapshot(&vault);
            let outcome = match door {
                "save_note" => {
                    save_note(&vault, path, "\n# Landed\n", &human()).map(|()| path.to_string())
                }
                "update_frontmatter" => update_frontmatter(
                    &vault,
                    path,
                    &patch(&[("status", serde_json::json!("done"))]),
                    &human(),
                )
                .map(|_| path.to_string()),
                "set_note_title" => {
                    set_note_title(&vault, path, "Landed", &human()).map(|()| path.to_string())
                }
                "create_note" => create_note(
                    &vault,
                    case["folder"].as_str().expect("a folder"),
                    case["slug"].as_str().expect("a slug"),
                    &patch(&[]),
                    "# Landed\n",
                    &human(),
                ),
                // Through the guard its door mints the receipt from (M58.1).
                "write_text_file" => {
                    crate::knowledge::guard_human_write(path).and_then(|cleared| {
                        write_text_file(&vault, path, "flowchart TD\n", &WriteReceipt::ipc(cleared))
                    })
                }
                "edit_note" => edit_note(
                    &vault,
                    path,
                    &seed_to_landed(),
                    None,
                    |_, _| Ok(()),
                    &agent(),
                )
                .map(|_| path.to_string())
                .map_err(String::from),
                // M60.4: the agent's field write, planning one key.
                "set_fields" => set_note_fields(
                    &vault,
                    path,
                    |_| Ok(patch(&[("status", serde_json::json!("done"))])),
                    None,
                    |_, _| Ok(()),
                    WriteMode::Commit,
                    &agent(),
                )
                .map(|_| path.to_string())
                .map_err(String::from),
                // M58.4: the command's own door, on a vault that is not a
                // repository: every case is a target it refuses first.
                "restore_version" => {
                    assert!(
                        case["lands"].is_null(),
                        "{case}: a restore lands only in a repository"
                    );
                    crate::git_commands::restore_note_version_in(
                        &vault.to_string_lossy(),
                        path,
                        &"0".repeat(40),
                        None,
                    )
                    .map(|_| path.to_string())
                }
                // M60.6: one op of a batch, through the batch writer.
                "batch_patch" | "batch_body" | "batch_create" => {
                    let op = match door {
                        "batch_patch" => {
                            serde_json::json!({ "op": "patch", "path": path, "set": { "status": "done" } })
                        }
                        "batch_body" => {
                            serde_json::json!({ "op": "body", "path": path, "body": "\n# Landed\n" })
                        }
                        _ => {
                            serde_json::json!({ "op": "create", "path": path, "content": "# Landed\n" })
                        }
                    };
                    super::super::batch::apply_batch(&vault, &[op], &human())
                        .map(|_| path.to_string())
                        .map_err(|error| match error {
                            super::super::batch::BatchError::Refused(message) => message,
                            super::super::batch::BatchError::Stale(stale) => stale.path,
                        })
                }
                other => panic!("no door called {other}"),
            };
            match (case["refused"].as_str(), case["lands"].as_str()) {
                (Some(fragment), None) => {
                    let err = outcome.expect_err(&format!("{case} must refuse"));
                    assert!(err.contains(fragment), "{case}: {err}");
                    assert_eq!(
                        snapshot(&vault),
                        before,
                        "{case}: the refusal changed bytes"
                    );
                }
                (None, Some(expected)) => {
                    let landed = outcome.unwrap_or_else(|e| panic!("{case} must land: {e}"));
                    assert_eq!(landed, expected, "{case}");
                    assert_ne!(snapshot(&vault), before, "{case}: nothing was written");
                }
                _ => panic!("{case} must name exactly one of `refused` and `lands`"),
            }
            let _ = std::fs::remove_dir_all(&vault);
        }
    }

    // M54.10: the agent's MCP doors ask the note doors' own judgement before
    // dispatch, to record a refusal against its run. Over the same shared
    // cases, the check refuses what a door refuses, in its words byte for
    // byte, lets through what lands, and changes nothing on disk.
    #[test]
    fn the_dispatch_check_agrees_with_every_note_door() {
        let file: serde_json::Value =
            serde_json::from_str(NOTE_TARGETS).expect("note-targets.json parses");
        let seed = file["seed"].as_str().expect("a seed");
        let mut replayed = 0;
        for case in file["cases"].as_array().expect("cases") {
            let door = case["door"].as_str().expect("a door");
            if !matches!(
                door,
                "save_note" | "update_frontmatter" | "create_note" | "edit_note"
            ) {
                continue;
            }
            let path = case["path"].as_str().unwrap_or_default();
            let folder = case["folder"].as_str().unwrap_or_default();
            let slug = case["slug"].as_str().unwrap_or_default();
            let vault = testutil::temp_vault("wfm-dispatch-check");
            if door != "create_note" && case["seed"] != serde_json::json!(false) {
                testutil::write(&vault, path, seed);
            }
            let before = snapshot(&vault);
            let verdict = match door {
                "create_note" => new_note_refusal(&vault, folder, slug),
                _ => note_target_refusal(&vault, path),
            };
            assert_eq!(snapshot(&vault), before, "{case}: the check changed bytes");
            if path.ends_with(".mmd") {
                // The markdown doors refuse a diagram at the door, as raw
                // diagram source (edit_note: as no note), so the check
                // leaves it to them.
                assert_eq!(verdict, None, "{case}");
            } else {
                match (case["refused"].as_str(), case["lands"].as_str()) {
                    (Some(fragment), None) => {
                        let message =
                            verdict.unwrap_or_else(|| panic!("{case} must refuse before dispatch"));
                        assert!(message.contains(fragment), "{case}: {message}");
                        // A path case asks the agent's append, a markdown door:
                        // save_note takes a .mmd too, so it words a non-note's
                        // refusal differently.
                        let door_says = match door {
                            "create_note" => create_note(
                                &vault,
                                folder,
                                slug,
                                &patch(&[]),
                                "# Landed\n",
                                &human(),
                            )
                            .map(drop),
                            "update_frontmatter" => update_frontmatter(
                                &vault,
                                path,
                                &patch(&[("status", serde_json::json!("done"))]),
                                &human(),
                            )
                            .map(drop),
                            "edit_note" => edit_note(
                                &vault,
                                path,
                                &seed_to_landed(),
                                None,
                                |_, _| Ok(()),
                                &agent(),
                            )
                            .map(drop)
                            .map_err(String::from),
                            _ => append_note_checked(
                                &vault,
                                path,
                                "Landed.",
                                None,
                                |_, _| Ok(()),
                                &agent(),
                            )
                            .map(drop)
                            .map_err(String::from),
                        }
                        .expect_err(&format!("{case} must refuse at its door"));
                        assert_eq!(message, door_says, "{case}");
                    }
                    (None, Some(_)) => assert_eq!(verdict, None, "{case}"),
                    _ => panic!("{case} must name exactly one of `refused` and `lands`"),
                }
            }
            replayed += 1;
            let _ = std::fs::remove_dir_all(&vault);
        }
        assert!(replayed > 0, "the shared cases hold note-door cases");
    }

    // --- edit_note (M55.5) ----------------------------------------------

    fn quote(old: &str, new: &str) -> crate::vault::quote::QuoteEdit {
        crate::vault::quote::QuoteEdit {
            old: old.into(),
            new: new.into(),
            occurrence: None,
        }
    }

    #[test]
    fn an_edit_changes_only_the_quoted_bytes() {
        // A BOM, a CRLF opening fence, a closing fence with trailing spaces,
        // a CRLF body and no final newline: every one of them is a byte a
        // composing writer would rewrite.
        let vault = testutil::temp_vault("wfm-edit-bytes");
        let original =
            "\u{feff}---\r\ntitle: Plan\r\n---  \r\n# Plan\r\n\r\nWe ship on Thursdays.\r\nLast line";
        testutil::write(&vault, "notes/plan.md", original);
        let edited = edit_note(
            &vault,
            "notes/plan.md",
            &[quote("Thursdays", "Fridays")],
            None,
            |_, _| Ok(()),
            &agent(),
        )
        .unwrap();
        let landed = std::fs::read_to_string(vault.join("notes/plan.md")).unwrap();
        assert_eq!(landed, original.replace("Thursdays", "Fridays"));
        assert_eq!(edited.lines, vec![3]);
        assert_eq!(
            edited.content_hash,
            crate::ledger::sha256_hex(landed.as_bytes())
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn an_ambiguous_edit_writes_nothing() {
        let vault = testutil::temp_vault("wfm-edit-ambiguous");
        let original = "# Plan\n\nThursdays ship.\nThursdays rest.\n";
        testutil::write(&vault, "notes/plan.md", original);
        let refusal = edit_note(
            &vault,
            "notes/plan.md",
            &[quote("Thursdays", "Fridays")],
            None,
            |_, _| Ok(()),
            &agent(),
        )
        .map_err(String::from)
        .unwrap_err();
        assert!(refusal.contains("appears 2 times"), "{refusal}");
        assert!(refusal.contains("  1. line 3: "), "{refusal}");
        assert!(refusal.contains("  2. line 4: "), "{refusal}");
        assert!(refusal.ends_with("\nNothing was written."), "{refusal}");
        assert_eq!(
            std::fs::read_to_string(vault.join("notes/plan.md")).unwrap(),
            original
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn a_missing_note_is_named_and_nothing_is_created() {
        let vault = testutil::temp_vault("wfm-edit-missing");
        let refusal = edit_note(
            &vault,
            "notes/none.md",
            &[quote("a", "b")],
            None,
            |_, _| Ok(()),
            &agent(),
        )
        .map_err(String::from)
        .unwrap_err();
        assert_eq!(refusal, "no note at notes/none.md");
        assert!(!vault.join("notes/none.md").exists());
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn a_stale_expect_hash_writes_nothing() {
        let vault = testutil::temp_vault("wfm-edit-stale");
        testutil::write(&vault, "notes/plan.md", "# Plan\n\nRead.\n");
        let read = crate::ledger::sha256_hex(b"# Plan\n\nRead.\n");
        let outside = "# Plan\n\nRead, then changed.\n";
        testutil::write(&vault, "notes/plan.md", outside);
        let outcome = edit_note(
            &vault,
            "notes/plan.md",
            &[quote("Plan", "Plans")],
            Some(&read),
            |_, _| Ok(()),
            &agent(),
        );
        match outcome {
            Err(NoteWriteError::Stale(stale)) => {
                assert_eq!(stale.path, "notes/plan.md");
                assert_eq!(stale.expected, read);
            }
            other => panic!("a stale hash is refused as stale: {other:?}"),
        }
        assert_eq!(
            std::fs::read_to_string(vault.join("notes/plan.md")).unwrap(),
            outside
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn a_current_expect_hash_lands() {
        let vault = testutil::temp_vault("wfm-edit-current");
        let original = "# Plan\n\nRead.\n";
        testutil::write(&vault, "notes/plan.md", original);
        let hash = crate::ledger::sha256_hex(original.as_bytes());
        let edited = edit_note(
            &vault,
            "notes/plan.md",
            &[quote("Read.", "Read and edited.")],
            Some(&hash),
            |_, _| Ok(()),
            &agent(),
        )
        .unwrap();
        assert_eq!(edited.lines, vec![3]);
        assert_eq!(
            std::fs::read_to_string(vault.join("notes/plan.md")).unwrap(),
            "# Plan\n\nRead and edited.\n"
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn two_edits_racing_on_one_hash_land_once() {
        let vault = testutil::temp_vault("wfm-edit-race");
        let original = "# Plan\n\nOne line.\n";
        testutil::write(&vault, "notes/plan.md", original);
        let hash = crate::ledger::sha256_hex(original.as_bytes());
        let racers: Vec<_> = [("One line.", "First racer."), ("Plan", "Second racer")]
            .into_iter()
            .map(|(old, new)| {
                let (vault, hash) = (vault.clone(), hash.clone());
                std::thread::spawn(move || {
                    edit_note(
                        &vault,
                        "notes/plan.md",
                        &[quote(old, new)],
                        Some(&hash),
                        |_, _| Ok(()),
                        &agent(),
                    )
                })
            })
            .collect();
        let outcomes: Vec<_> = racers.into_iter().map(|r| r.join().unwrap()).collect();
        let landed = outcomes.iter().filter(|o| o.is_ok()).count();
        let stale = outcomes
            .iter()
            .filter(|o| matches!(o, Err(NoteWriteError::Stale(_))))
            .count();
        assert_eq!((landed, stale), (1, 1), "{outcomes:?}");
        let note = std::fs::read_to_string(vault.join("notes/plan.md")).unwrap();
        assert!(
            note.contains("First racer.") != note.contains("Second racer"),
            "exactly one edit is on disk: {note}"
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn the_check_sees_the_bytes_it_would_write() {
        let vault = testutil::temp_vault("wfm-edit-check");
        let original = "---\ntitle: Plan\n---\n# Plan\n\nBody.\n";
        testutil::write(&vault, "notes/plan.md", original);
        let seen = std::sync::Mutex::new(None);
        let outcome = edit_note(
            &vault,
            "notes/plan.md",
            &[quote("Body.", "New body.")],
            None,
            |before, after| {
                *seen.lock().unwrap() = Some((before.to_string(), after.to_string()));
                Err("refused by the check".to_string())
            },
            &agent(),
        );
        assert_eq!(
            outcome.map_err(String::from).unwrap_err(),
            "refused by the check"
        );
        assert_eq!(
            seen.lock().unwrap().clone(),
            Some((
                original.to_string(),
                "---\ntitle: Plan\n---\n# Plan\n\nNew body.\n".to_string()
            ))
        );
        assert_eq!(
            std::fs::read_to_string(vault.join("notes/plan.md")).unwrap(),
            original,
            "an Err from the check writes nothing"
        );
        // A plan that fails on a note the check refuses answers with the
        // check's refusal, never with a listing of the note's text.
        let outcome = edit_note(
            &vault,
            "notes/plan.md",
            &[quote("nowhere", "x")],
            None,
            |_, _| Err("governed".to_string()),
            &agent(),
        );
        assert_eq!(outcome.map_err(String::from).unwrap_err(), "governed");
        let _ = std::fs::remove_dir_all(&vault);
    }

    // What the dispatch check codes is a refusal of the target. A malformed
    // argument or a disk that cannot answer is left to the door's own words,
    // and create_note's first refusal names the folder, as the door does.
    #[test]
    fn the_dispatch_check_codes_only_a_refusal_of_the_target() {
        let vault = testutil::temp_vault("wfm-dispatch-check-kinds");
        let fm = patch(&[]);
        let escaped = new_note_refusal(&vault, "../escaped", "note");
        assert_eq!(
            escaped,
            create_note(&vault, "../escaped", "note", &fm, "x\n", &human()).err()
        );
        assert_eq!(
            escaped.as_deref(),
            Some("path escapes the vault: \"../escaped\"")
        );
        assert_eq!(new_note_refusal(&vault, "", "x"), None, "an empty folder");
        assert_eq!(new_note_refusal(&vault, "records", "a/b"), None, "a slug");
        assert_eq!(note_target_refusal(&vault, ""), None, "an empty path");
        let gone = vault.join("no-such-vault");
        assert_eq!(note_target_refusal(&gone, "records/a.md"), None);
        assert_eq!(new_note_refusal(&gone, "records", "a"), None);
        assert!(save_note(&gone, "records/a.md", "x\n", &human()).is_err());

        // The planned name is create_note's, before a `-2` makes it new.
        assert_eq!(planned_note_path("", "x").as_deref(), Some("x.md"));
        assert_eq!(
            planned_note_path("records", "x").as_deref(),
            Some("records/x.md")
        );
        assert_eq!(planned_note_path("records", ".."), None);
        let _ = std::fs::remove_dir_all(&vault);
    }

    // Containment waves a symlink through when it points INSIDE the vault,
    // and `.git/` is inside the vault. So the note writers judge where a path
    // LANDS: an innocent name cannot carry a write into `.git/`.
    #[cfg(unix)]
    #[test]
    fn a_symlink_cannot_carry_a_note_write_into_git() {
        const GIT_CONFIG: &str = "[core]\n\trepositoryformatversion = 0\n";
        let vault = testutil::temp_vault("wfm-symlink-git");
        testutil::write(&vault, ".git/config", GIT_CONFIG);
        // Note-shaped, so only the landing can tell where it is.
        testutil::write(&vault, ".git/notes.md", NOTE);
        testutil::write(&vault, "records/real.md", NOTE);
        std::os::unix::fs::symlink(vault.join(".git"), vault.join("docs")).unwrap();
        std::os::unix::fs::symlink(vault.join(".git/config"), vault.join("records/config.md"))
            .unwrap();
        // Containment alone passes both: each resolves inside the vault.
        assert!(safe_join(&vault, "docs/notes.md").is_ok());
        assert!(safe_join(&vault, "records/config.md").is_ok());

        let before = snapshot(&vault);
        let hacked = patch(&[("hacked", serde_json::json!(true))]);
        let err = save_note(&vault, "docs/notes.md", "hacked\n", &human()).unwrap_err();
        assert!(err.contains("resolves to .git/notes.md"), "{err}");
        assert!(update_frontmatter(&vault, "docs/notes.md", &hacked, &human()).is_err());
        assert!(set_note_title(&vault, "docs/notes.md", "Hacked", &human()).is_err());
        assert!(append_note_checked(
            &vault,
            "docs/notes.md",
            "hacked",
            None,
            |_, _| Ok(()),
            &agent()
        )
        .is_err());
        // A folder that does not exist yet still lands under the link.
        let err =
            create_note(&vault, "docs/hooks", "pre-commit", &hacked, "x\n", &human()).unwrap_err();
        assert!(
            err.contains("resolves to .git/hooks/pre-commit.md"),
            "{err}"
        );
        assert!(create_note(&vault, "docs", "x", &hacked, "x\n", &human()).is_err());
        assert!(write_text_file(&vault, "docs/x.mmd", "graph TD\n", &human()).is_err());
        // A leaf link whose own name is a note.
        let err = update_frontmatter(&vault, "records/config.md", &hacked, &human()).unwrap_err();
        assert!(err.contains("resolves to .git/config"), "{err}");
        assert!(save_note(&vault, "records/config.md", "hacked\n", &human()).is_err());
        assert!(append_note_checked(
            &vault,
            "records/config.md",
            "hacked",
            None,
            |_, _| Ok(()),
            &agent()
        )
        .is_err());

        // Every byte where it was, nothing new under .git, the link a link.
        assert_eq!(snapshot(&vault), before);
        assert!(std::fs::symlink_metadata(vault.join("records/config.md"))
            .unwrap()
            .file_type()
            .is_symlink());
        // And an ordinary note beside them still lands.
        save_note(&vault, "records/real.md", "\n# Real\n", &human()).unwrap();
        let _ = std::fs::remove_dir_all(&vault);
    }

    // The disk the app ships for folds case — Unicode case, not just ASCII —
    // and `realpath` answers with the stored name, so a folded spelling is
    // judged by where it LANDS: `view` + U+017F LONG S is `views`, and
    // U+212A KELVIN SIGN + `nowledge` is the bundle. The bundle's guards hear
    // that spelling as the bundle too (M53.28), and the note doors refuse it
    // without them: they reach the bundle by its exact name or not at all.
    #[test]
    fn a_folded_spelling_cannot_reach_a_skipped_folder_or_the_bundle() {
        let vault = testutil::temp_vault("wfm-folding");
        testutil::write(&vault, "views/x.yml", "name: X\n");
        testutil::write(&vault, "knowledge/metrics/churn.md", NOTE);
        if !vault.join("VIEWS").exists() {
            // A case-sensitive volume (CI's ext4): these spellings name new,
            // unrelated folders there, so there is nothing to reach.
            let _ = std::fs::remove_dir_all(&vault);
            return;
        }
        let kelvin = "\u{212a}nowledge/metrics/churn.md";
        assert_eq!(
            crate::knowledge::canonical_path(kelvin).as_deref(),
            Some("knowledge/metrics/churn.md")
        );

        let before = snapshot(&vault);
        let err =
            create_note(&vault, "view\u{17f}", "x", &patch(&[]), "# X\n", &human()).unwrap_err();
        assert!(err.contains("resolves to views/x.md"), "{err}");
        // Plain ASCII case too: the scanner skips exactly `views/`, and this
        // `Views/` IS that folder here, so it lands there and refuses.
        let err = create_note(&vault, "Views", "x", &patch(&[]), "# X\n", &human()).unwrap_err();
        assert!(err.contains("resolves to views/x.md"), "{err}");
        let stamp = patch(&[("verified", serde_json::json!({ "by": "human:josef" }))]);
        let err = update_frontmatter(&vault, kelvin, &stamp, &human()).unwrap_err();
        assert!(err.contains("inside knowledge/"), "{err}");
        assert!(save_note(&vault, kelvin, "\n# Rewritten\n", &human()).is_err());
        assert!(set_note_title(&vault, kelvin, "Rewritten", &human()).is_err());
        let smuggled = create_note(
            &vault,
            "\u{212a}nowledge/metrics",
            "smuggled",
            &patch(&[]),
            "# S\n",
            &human(),
        );
        assert!(smuggled.is_err());
        assert_eq!(snapshot(&vault), before);
        let _ = std::fs::remove_dir_all(&vault);
    }

    // A note the scanner lists and the writers refuse is a page whose every
    // keystroke fails to save, so the writers take exactly what the scanner
    // lists. The views/attachments rule decides only what is VISIBLE — the
    // dot rule and the extension rule are the boundary — and the scanner
    // hides what the dot rule refuses (M53.25), names HFS+ hears with a
    // leading dot included. `Attachments/` (an Obsidian habit), `Views/`,
    // `notes/Views/` and `views./` are folders the scanner lists; `views/`
    // and `attachments/`, at any depth, are folders it skips, and a dotfile
    // or a dot-folder is a name it hides.
    #[test]
    fn the_note_writers_take_exactly_the_notes_the_scanner_lists() {
        let listed = |vault: &Path| -> Vec<String> {
            super::super::scan::scan_vault(vault)
                .unwrap()
                .into_iter()
                .map(|entry| entry.path)
                .collect()
        };
        let cases: &[(&[&str], &str)] = &[
            (&[], "records/ok.md"),
            (&[], "Attachments/b.md"),
            (&[], "Views/a.md"),
            (&[], "notes/Views/e.md"),
            (&[], "views./d.md"),
            (&[], "views/x.md"),
            (&[], "attachments/y.md"),
            (&[], "notes/views/z.md"),
            (&[], "records/.draft.md"),
            (&[], "\u{200c}.notes/e.md"),
            // Beside an existing `views/`, a folding disk files `Views/` inside
            // it, where the scanner never looks; a case-sensitive one makes a
            // folder of its own, which the scanner lists. Both agree either way.
            (&["views/x.yml"], "Views/plan.md"),
            (&["attachments/pic.png"], "ATTACHMENTS/notes.md"),
        ];
        for (beside, rel) in cases {
            // The editing doors, on a note that is already there.
            let vault = testutil::temp_vault("wfm-scanner-agrees");
            for file in beside.iter() {
                testutil::write(&vault, file, "x\n");
            }
            testutil::write(&vault, rel, NOTE);
            let visible = !listed(&vault).is_empty();
            let done = patch(&[("status", serde_json::json!("done"))]);
            let saved = save_note(&vault, rel, "\n# Saved\n", &human()).is_ok();
            assert_eq!(saved, visible, "{rel} beside {beside:?}: saved {saved}");
            assert_eq!(
                update_frontmatter(&vault, rel, &done, &human()).is_ok(),
                visible,
                "{rel}"
            );
            assert_eq!(
                set_note_title(&vault, rel, "Titled", &human()).is_ok(),
                visible,
                "{rel}"
            );
            let _ = std::fs::remove_dir_all(&vault);

            // And create: what it writes, the scanner lists; what it refuses,
            // written by hand instead, the scanner would never have shown.
            let vault = testutil::temp_vault("wfm-scanner-agrees-create");
            for file in beside.iter() {
                testutil::write(&vault, file, "x\n");
            }
            let (folder, leaf) = rel.rsplit_once('/').expect("a folder");
            let slug = leaf.trim_end_matches(".md");
            match create_note(&vault, folder, slug, &patch(&[]), "# Created\n", &human()) {
                Ok(created) => assert_eq!(listed(&vault).len(), 1, "{created}"),
                Err(_) => {
                    testutil::write(&vault, rel, NOTE);
                    assert_eq!(
                        listed(&vault),
                        Vec::<String>::new(),
                        "{rel} beside {beside:?}"
                    );
                }
            }
            let _ = std::fs::remove_dir_all(&vault);
        }
    }

    // M53.6: an agent's write is announced under the path the scan lists, so
    // the open page matches it however the agent spelled the file.
    #[test]
    fn landing_path_is_the_path_the_scan_lists() {
        let vault = vault_with_note("wfm-landing");
        let listed: Vec<String> = super::super::scan::scan_vault(&vault)
            .unwrap()
            .into_iter()
            .map(|entry| entry.path)
            .collect();
        assert_eq!(listed, ["items/atl-1.md"]);
        for spelling in ["items/atl-1.md", "./items/atl-1.md", "items/./atl-1.md"] {
            assert_eq!(
                landing_path(&vault, spelling).as_deref(),
                Some("items/atl-1.md"),
                "{spelling}"
            );
        }
        // On a disk that folds case (APFS, by default) the folder is named as
        // the disk stores it, which is the name the scan lists.
        if vault.join("ITEMS/atl-1.md").exists() {
            assert_eq!(
                landing_path(&vault, "ITEMS/atl-1.md").as_deref(),
                Some("items/atl-1.md")
            );
        }
        // Not written yet: the part that does not exist stays as asked.
        assert_eq!(
            landing_path(&vault, "./notes/new.md").as_deref(),
            Some("notes/new.md")
        );
        for outside in ["../x.md", "/etc/hosts", ""] {
            assert_eq!(landing_path(&vault, outside), None, "{outside:?}");
        }
        let _ = std::fs::remove_dir_all(&vault);
    }

    // The plant: a folder made under a spelling a folding disk hears as
    // `knowledge`, BEFORE the bundle exists, is the bundle from then on — the
    // bundle's own writes land in it — under a name that is not the bundle's
    // own. So the plant refuses at every note door, by NAME, whatever the
    // guards in front of them hear; and a bundle already stored that way
    // (planted before this check, or made by hand) is still the bundle by
    // IDENTITY, reached under that name or through a symlink.
    #[cfg(unix)]
    #[test]
    fn the_bundle_cannot_be_planted_under_another_spelling() {
        let vault = testutil::temp_vault("wfm-plant");
        let kelvin = "\u{212a}nowledge";
        let planted = create_note(
            &vault,
            &format!("{kelvin}/metrics"),
            "churn",
            &patch(&[]),
            "# Churn\n",
            &human(),
        );
        let err = planted.unwrap_err();
        assert!(err.contains("inside knowledge/ by another name"), "{err}");
        // HFS+ ignores U+200C in a name the way APFS folds the Kelvin sign.
        assert!(create_note(
            &vault,
            "know\u{200c}ledge",
            "x",
            &patch(&[]),
            "# X\n",
            &human()
        )
        .is_err());
        assert!(write_text_file(
            &vault,
            &format!("{kelvin}/flow.mmd"),
            "graph TD\n",
            &human()
        )
        .is_err());
        assert_eq!(
            std::fs::read_dir(&vault).unwrap().count(),
            0,
            "nothing was made"
        );

        // Planted anyway, with a concept in it — spelled as stored, so a
        // case-sensitive disk builds the same tree; on a folding one, this is
        // where `write_concept("knowledge/metrics/churn.md")` lands.
        testutil::write(&vault, &format!("{kelvin}/metrics/churn.md"), NOTE);
        std::os::unix::fs::symlink(vault.join(kelvin), vault.join("docs")).unwrap();
        if vault.join("knowledge").exists() {
            assert_eq!(bundle_root(&vault).as_deref(), Some(Path::new(kelvin)));
        }
        let before = snapshot(&vault);
        let stamp = patch(&[("verified", serde_json::json!({ "by": "human:josef" }))]);
        for rel in [
            format!("{kelvin}/metrics/churn.md"),
            "docs/metrics/churn.md".to_string(),
        ] {
            let err = update_frontmatter(&vault, &rel, &stamp, &human()).unwrap_err();
            assert!(
                err.contains("inside knowledge/ by another name"),
                "{rel}: {err}"
            );
            assert!(
                save_note(&vault, &rel, "\n# Rewritten\n", &human()).is_err(),
                "{rel}"
            );
            assert!(
                set_note_title(&vault, &rel, "Rewritten", &human()).is_err(),
                "{rel}"
            );
            assert!(
                append_note_checked(&vault, &rel, "More.", None, |_, _| Ok(()), &agent()).is_err(),
                "{rel}"
            );
        }
        let smuggled = create_note(
            &vault,
            "docs/metrics",
            "smuggled",
            &patch(&[]),
            "# S\n",
            &human(),
        );
        assert!(smuggled.is_err());
        assert_eq!(snapshot(&vault), before);
        let _ = std::fs::remove_dir_all(&vault);
    }

    // Identity on its own: where `knowledge` is a link to another folder, that
    // folder IS the bundle, under a name no fold could guess — so its notes
    // take no plain write, and a projection may land there.
    #[cfg(unix)]
    #[test]
    fn the_folder_knowledge_resolves_to_is_the_bundle() {
        let vault = testutil::temp_vault("wfm-bundle-identity");
        testutil::write(&vault, "kb/metrics/churn.md", NOTE);
        std::os::unix::fs::symlink(vault.join("kb"), vault.join("knowledge")).unwrap();
        assert_eq!(bundle_root(&vault).as_deref(), Some(Path::new("kb")));
        let before = snapshot(&vault);
        let stamp = patch(&[("verified", serde_json::json!({ "by": "human:josef" }))]);
        let err = update_frontmatter(&vault, "kb/metrics/churn.md", &stamp, &human()).unwrap_err();
        assert!(err.contains("inside knowledge/ by another name"), "{err}");
        assert!(save_note(&vault, "kb/metrics/churn.md", "\n# Rewritten\n", &human()).is_err());
        assert!(create_note(&vault, "kb", "smuggled", &patch(&[]), "# S\n", &human()).is_err());
        assert_eq!(snapshot(&vault), before);
        assert!(bundle_join(&vault, "knowledge/metrics/churn.md").is_ok());
        let _ = std::fs::remove_dir_all(&vault);
    }

    // The projection writer's door (ledger::manifest): a projection lands
    // inside the bundle as the filesystem resolves it, or nowhere. The
    // concept doors check only that a path is SPELLED `knowledge/…`, so a
    // symlink inside the bundle carried write_concept wherever it pointed.
    #[cfg(unix)]
    #[test]
    fn bundle_join_keeps_a_projection_inside_the_bundle() {
        let vault = testutil::temp_vault("wfm-bundle-join");
        let outside = testutil::temp_vault("wfm-bundle-join-outside");
        // No bundle yet: a projection may create it, and nothing else.
        assert!(bundle_join(&vault, "knowledge/metrics/churn.md").is_ok());
        let err = bundle_join(&vault, "records/x.md").unwrap_err();
        assert!(err.contains("outside knowledge/"), "{err}");

        testutil::write(&vault, "knowledge/metrics/churn.md", NOTE);
        testutil::write(&vault, "records/x.md", NOTE);
        testutil::write(&vault, ".git/config", "[core]\n");
        std::fs::create_dir_all(vault.join(".git/hooks")).unwrap();
        let link = |target: &Path, name: &str| {
            std::os::unix::fs::symlink(target, vault.join("knowledge").join(name)).unwrap()
        };
        link(&vault.join(".git/hooks"), "sys");
        link(&outside, "out");
        link(&vault.join("records"), "records");
        link(&vault.join("knowledge/metrics"), "current");

        assert!(bundle_join(&vault, "knowledge/metrics/churn.md").is_ok());
        assert!(bundle_join(&vault, "knowledge/metrics/new.md").is_ok());
        // A link that stays inside the bundle is just another way in.
        assert!(bundle_join(&vault, "knowledge/current/churn.md").is_ok());
        let err = bundle_join(&vault, "knowledge/sys/pre-commit.md").unwrap_err();
        assert!(
            err.contains("resolves to .git/hooks/pre-commit.md, outside knowledge/"),
            "{err}"
        );
        let err = bundle_join(&vault, "knowledge/out/escaped.md").unwrap_err();
        assert!(err.contains("escapes the vault"), "{err}");
        let err = bundle_join(&vault, "knowledge/records/x.md").unwrap_err();
        assert!(err.contains("resolves to records/x.md"), "{err}");
        // A dot-folder inside the bundle is still the bundle: a person files
        // concepts there by hand, and the agent doors keep agents out of it
        // (`concept_refusal`).
        assert!(bundle_join(&vault, "knowledge/.archive/x.md").is_ok());
        let err = bundle_join(&vault, "knowledge/metrics/churn.txt").unwrap_err();
        assert!(err.contains("a projection is a .md file"), "{err}");
        let err = bundle_join(&vault, "knowledge/../.git/x.md").unwrap_err();
        assert!(err.contains("escapes the vault"), "{err}");
        let _ = std::fs::remove_dir_all(&vault);
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[test]
    fn an_append_lands_on_markdown_notes_only() {
        let vault = vault_with_note("wfm-appended-body");
        testutil::write(&vault, "diagrams/flow.mmd", "flowchart TD\n  A --> B\n");
        let none = |_: &str, _: &str| Ok(());
        let hash = append_note_checked(&vault, "items/atl-1.md", "  More.  ", None, none, &agent())
            .unwrap();
        let landed = read(&vault, "items/atl-1.md");
        assert_eq!(
            landed,
            NOTE.replace("Body stays.\n", "Body stays.\n\nMore.\n")
        );
        assert_eq!(hash, crate::ledger::sha256_hex(landed.as_bytes()));
        // A .mmd is a note elsewhere — just not one markdown appends to.
        let err = String::from(
            append_note_checked(&vault, "diagrams/flow.mmd", "More.", None, none, &agent())
                .unwrap_err(),
        );
        assert!(err.contains("raw diagram source"), "{err}");
        let err = String::from(
            append_note_checked(&vault, ".git/config", "More.", None, none, &agent()).unwrap_err(),
        );
        assert!(err.starts_with("not a note: .git/config"), "{err}");
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn create_folder_and_rename_note_move_notes_and_folders_within_the_vault() {
        let vault = vault_with_note("wfm-rename");
        create_folder(&vault, "projects/atlas/items", &human()).unwrap();
        assert!(vault.join("projects/atlas/items").is_dir());
        rename_note(
            &vault,
            "items/atl-1.md",
            "projects/atlas/items/atl-1.md",
            &human(),
        )
        .unwrap();
        assert!(!vault.join("items/atl-1.md").exists());
        assert_eq!(read(&vault, "projects/atlas/items/atl-1.md"), NOTE);
        // Refuses to clobber an existing target.
        testutil::write(&vault, "items/atl-2.md", NOTE);
        assert!(rename_note(
            &vault,
            "items/atl-2.md",
            "projects/atlas/items/atl-1.md",
            &human()
        )
        .is_err());
        // Whole folders move too.
        rename_note(&vault, "items", "archive", &human()).unwrap();
        assert_eq!(read(&vault, "archive/atl-2.md"), NOTE);
        let _ = std::fs::remove_dir_all(&vault);
    }

    // delete_note moves into the vault's own Trash (M60.8), so its happy
    // path is tested below and in vault::trash. Guards are covered here.
    #[test]
    fn v2_ops_reject_escapes_and_missing_paths() {
        let vault = vault_with_note("wfm-v2-escape");
        assert!(create_folder(&vault, "../evil", &human()).is_err());
        assert!(create_folder(&vault, "/tmp/evil", &human()).is_err());
        assert!(rename_note(&vault, "items/atl-1.md", "../stolen.md", &human()).is_err());
        assert!(rename_note(&vault, "../victim.md", "items/x.md", &human()).is_err());
        assert!(rename_note(&vault, "items/nope.md", "items/still-nope.md", &human()).is_err());
        assert!(delete_note(&vault, "../victim.md", &human()).is_err());
        assert!(delete_note(&vault, "items/nope.md", &human()).is_err());
        // The escape attempts must not have touched the real note.
        assert_eq!(read(&vault, "items/atl-1.md"), NOTE);
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn update_survives_trailing_whitespace_closing_fence() {
        let vault = testutil::temp_vault("wfm-fence-ws");
        testutil::write(
            &vault,
            "items/ws.md",
            "---\ntype: Work item\nstatus: todo\n--- \nBody stays.\n",
        );
        update_frontmatter(
            &vault,
            "items/ws.md",
            &patch(&[("status", serde_json::json!("done"))]),
            &human(),
        )
        .unwrap();
        assert_eq!(
            read(&vault, "items/ws.md"),
            "---\ntype: Work item\nstatus: done\n---\nBody stays.\n"
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    // --- Attachments (M16.13c) ---------------------------------------------

    /// A file outside the vault, standing in for whatever the OS picker
    /// returns — the point of `import_attachment` is that the source is not
    /// vault-relative and not vault-contained.
    fn source_file(label: &str, name: &str, body: &str) -> std::path::PathBuf {
        let dir = testutil::temp_vault(label);
        let path = dir.join(name);
        std::fs::write(&path, body).unwrap();
        path
    }

    #[test]
    fn import_copies_into_attachments_and_returns_a_relative_path() {
        let vault = testutil::temp_vault("wfm-attach");
        let src = source_file("wfm-attach-src", "report.pdf", "%PDF-1.4");
        let rel = import_attachment(&vault, src.to_str().unwrap(), &human()).unwrap();

        assert_eq!(rel, "attachments/report.pdf");
        assert_eq!(read(&vault, &rel), "%PDF-1.4");
        // The original is COPIED, never moved — the user's Downloads folder is
        // not ours to empty.
        assert!(src.exists());
        let _ = std::fs::remove_dir_all(&vault);
        let _ = std::fs::remove_dir_all(src.parent().unwrap());
    }

    // `report.pdf-2` is a file the OS can no longer open, which is what
    // reusing `note_candidates`' `.md`-shaped dedupe would have produced.
    #[test]
    fn a_second_file_of_the_same_name_dedupes_the_stem_not_the_extension() {
        let vault = testutil::temp_vault("wfm-attach-dupe");
        let a = source_file("wfm-attach-dupe-a", "report.pdf", "first");
        let b = source_file("wfm-attach-dupe-b", "report.pdf", "second");
        assert_eq!(
            import_attachment(&vault, a.to_str().unwrap(), &human()).unwrap(),
            "attachments/report.pdf"
        );
        assert_eq!(
            import_attachment(&vault, b.to_str().unwrap(), &human()).unwrap(),
            "attachments/report-2.pdf"
        );
        // Neither clobbered the other.
        assert_eq!(read(&vault, "attachments/report.pdf"), "first");
        assert_eq!(read(&vault, "attachments/report-2.pdf"), "second");
        let _ = std::fs::remove_dir_all(&vault);
        let _ = std::fs::remove_dir_all(a.parent().unwrap());
        let _ = std::fs::remove_dir_all(b.parent().unwrap());
    }

    #[test]
    fn a_dotfile_name_keeps_its_leading_dot() {
        let vault = testutil::temp_vault("wfm-attach-dot");
        let a = source_file("wfm-attach-dot-a", ".gitignore", "node_modules");
        let b = source_file("wfm-attach-dot-b", ".gitignore", "target");
        assert_eq!(
            import_attachment(&vault, a.to_str().unwrap(), &human()).unwrap(),
            "attachments/.gitignore"
        );
        // Not "attachments/-2.gitignore": a leading dot is the whole name.
        assert_eq!(
            import_attachment(&vault, b.to_str().unwrap(), &human()).unwrap(),
            "attachments/.gitignore-2"
        );
        let _ = std::fs::remove_dir_all(&vault);
        let _ = std::fs::remove_dir_all(a.parent().unwrap());
        let _ = std::fs::remove_dir_all(b.parent().unwrap());
    }

    #[test]
    fn import_refuses_relative_sources_directories_and_missing_files() {
        let vault = testutil::temp_vault("wfm-attach-guard");
        // Relative: `Path::join` on a relative source would resolve against
        // the process CWD, which is not the vault and not the picker's folder.
        assert!(import_attachment(&vault, "../../etc/passwd", &human()).is_err());
        assert!(import_attachment(&vault, "", &human()).is_err());
        assert!(import_attachment(&vault, vault.to_str().unwrap(), &human()).is_err());
        assert!(import_attachment(&vault, "/nonexistent/nope.png", &human()).is_err());
        assert!(!vault.join(ATTACHMENTS_DIR).exists());
        let _ = std::fs::remove_dir_all(&vault);
    }

    // The folder is fixed by this function, not chosen by the caller: a files
    // field stores whatever string it is handed, and `attachments/` is the one
    // directory the scanner and the watcher already agree to ignore.
    #[test]
    fn an_imported_markdown_file_lands_where_the_scanner_will_not_adopt_it() {
        let vault = testutil::temp_vault("wfm-attach-md");
        let src = source_file("wfm-attach-md-src", "notes.md", "# Not a record");
        let rel = import_attachment(&vault, src.to_str().unwrap(), &human()).unwrap();
        assert!(rel.starts_with("attachments/"));
        assert!(crate::vault::scan::scan_vault(&vault).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&vault);
        let _ = std::fs::remove_dir_all(src.parent().unwrap());
    }

    // --- Path locks (M55.1) -------------------------------------------------

    use std::sync::mpsc;
    use std::time::Duration;

    /// Long enough that a write which could enter would have; short enough
    /// that a test proving a wait stays quick.
    const WAITS: Duration = Duration::from_millis(300);
    /// How long a test waits for something that must happen, so a lock that
    /// never releases fails the test instead of hanging it.
    const LANDS: Duration = Duration::from_secs(10);

    /// Run `write` on a thread of its own and hear its outcome on a channel.
    fn in_thread<T: Send + 'static>(
        write: impl FnOnce() -> T + Send + 'static,
    ) -> mpsc::Receiver<T> {
        let (sent, outcome) = mpsc::channel();
        std::thread::spawn(move || {
            let _ = sent.send(write());
        });
        outcome
    }

    #[cfg(unix)]
    #[test]
    fn lock_keys_hear_one_file_however_it_is_spelled() {
        let vault = testutil::temp_vault("wfm-lock-keys");
        testutil::write(&vault, "items/a.md", NOTE);
        testutil::write(&vault, "items/b.md", NOTE);
        testutil::write(&vault, "items/caf\u{e9}.md", NOTE);
        std::os::unix::fs::symlink(vault.join("items"), vault.join("linked")).unwrap();
        let key = |rel: &str| lock_key(&vault, rel).unwrap();
        let one = key("items/a.md");
        for spelling in [
            "./items/a.md",
            "items/./a.md",
            "ITEMS/A.md",
            "items/a\u{200c}.md",
            "it\u{feff}ems/a.md",
            "linked/a.md",
        ] {
            assert_eq!(key(spelling), one, "{spelling}");
        }
        // NFC and NFD spell one name.
        assert_eq!(key("items/cafe\u{301}.md"), key("items/caf\u{e9}.md"));
        assert_ne!(key("items/b.md"), one, "another file has its own key");
        assert!(lock_key(&vault, "../x.md").is_err());
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn two_writes_to_one_note_take_turns() {
        let vault = vault_with_note("wfm-lock-turns");
        let (entered, inside) = mpsc::channel();
        let (release, released) = mpsc::channel::<()>();
        let dir = vault.clone();
        let first = in_thread(move || {
            rewrite_note(
                &dir,
                "items/atl-1.md",
                MARKDOWN,
                None,
                |current| {
                    let _ = entered.send(());
                    let _ = released.recv_timeout(LANDS);
                    Ok(current.replace("Body stays.", "A was here."))
                },
                &human(),
            )
        });
        inside
            .recv_timeout(LANDS)
            .expect("the first write is inside");
        let dir = vault.clone();
        let second = in_thread(move || {
            update_frontmatter(
                &dir,
                "./items/atl-1.md",
                &patch(&[("status", serde_json::json!("done"))]),
                &human(),
            )
        });
        assert!(
            second.recv_timeout(WAITS).is_err(),
            "the second write entered while the first held the note"
        );
        release.send(()).unwrap();
        first.recv_timeout(LANDS).unwrap().unwrap();
        second.recv_timeout(LANDS).unwrap().unwrap();
        assert_eq!(
            read(&vault, "items/atl-1.md"),
            NOTE.replace("status: todo", "status: done")
                .replace("Body stays.", "A was here.")
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn writes_to_two_notes_overlap() {
        let vault = testutil::temp_vault("wfm-lock-overlap");
        testutil::write(&vault, "items/a.md", NOTE);
        testutil::write(&vault, "items/b.md", NOTE);
        let (a_in, hear_a) = mpsc::channel();
        let (b_in, hear_b) = mpsc::channel();
        // Each closure signals that it is inside, then waits for the other's
        // signal: only two writes inside at once can both see it.
        let inside = |rel: &'static str, mine: mpsc::Sender<()>, theirs: mpsc::Receiver<()>| {
            let dir = vault.clone();
            in_thread(move || {
                rewrite_note(
                    &dir,
                    rel,
                    MARKDOWN,
                    None,
                    |current| {
                        let _ = mine.send(());
                        theirs
                            .recv_timeout(LANDS)
                            .map_err(|_| format!("{rel}: the other write never came in"))?;
                        Ok(current.replace("Body stays.", "Both inside."))
                    },
                    &human(),
                )
            })
        };
        let a = inside("items/a.md", a_in, hear_b);
        let b = inside("items/b.md", b_in, hear_a);
        a.recv_timeout(LANDS * 2).unwrap().unwrap();
        b.recv_timeout(LANDS * 2).unwrap().unwrap();
        assert!(read(&vault, "items/a.md").contains("Both inside."));
        assert!(read(&vault, "items/b.md").contains("Both inside."));
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn an_agent_append_and_a_person_patch_both_land() {
        let vault = vault_with_note("wfm-lock-append-patch");
        let (entered, inside) = mpsc::channel();
        let (release, released) = mpsc::channel::<()>();
        let dir = vault.clone();
        let append = in_thread(move || {
            append_note_checked(
                &dir,
                "items/atl-1.md",
                "The agent's line.",
                None,
                |_, _| {
                    let _ = entered.send(());
                    let _ = released.recv_timeout(LANDS);
                    Ok(())
                },
                &agent(),
            )
        });
        inside.recv_timeout(LANDS).expect("the append is judging");
        let dir = vault.clone();
        let person = in_thread(move || {
            update_frontmatter(
                &dir,
                "items/atl-1.md",
                &patch(&[("status", serde_json::json!("done"))]),
                &human(),
            )
        });
        assert!(person.recv_timeout(WAITS).is_err(), "the patch waits");
        release.send(()).unwrap();
        append.recv_timeout(LANDS).unwrap().unwrap();
        person.recv_timeout(LANDS).unwrap().unwrap();
        let landed = read(&vault, "items/atl-1.md");
        assert!(landed.contains("status: done"), "{landed}");
        assert!(
            landed.ends_with("Body stays.\n\nThe agent's line.\n"),
            "{landed}"
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn two_creates_of_one_slug_land_in_two_files() {
        let vault = testutil::temp_vault("wfm-lock-create");
        let held = lock_paths(&vault, &["notes/x.md"]).unwrap();
        let dir = vault.clone();
        let create =
            in_thread(move || create_note(&dir, "notes", "x", &patch(&[]), "# Second\n", &human()));
        assert!(create.recv_timeout(WAITS).is_err(), "the create waits");
        write_file(&held, &vault.join("notes/x.md"), "# First\n").unwrap();
        drop(held);
        assert_eq!(create.recv_timeout(LANDS).unwrap().unwrap(), "notes/x-2.md");
        assert_eq!(read(&vault, "notes/x.md"), "# First\n");
        assert_eq!(read(&vault, "notes/x-2.md"), "# Second\n");

        // The same race for an imported attachment.
        let src = source_file("wfm-lock-attach-src", "report.pdf", "second");
        let held = lock_paths(&vault, &["attachments/report.pdf"]).unwrap();
        let (dir, source) = (vault.clone(), src.to_str().unwrap().to_string());
        let import = in_thread(move || import_attachment(&dir, &source, &human()));
        assert!(import.recv_timeout(WAITS).is_err(), "the import waits");
        write_file(&held, &vault.join("attachments/report.pdf"), "first").unwrap();
        drop(held);
        assert_eq!(
            import.recv_timeout(LANDS).unwrap().unwrap(),
            "attachments/report-2.pdf"
        );
        assert_eq!(read(&vault, "attachments/report.pdf"), "first");
        assert_eq!(read(&vault, "attachments/report-2.pdf"), "second");
        let _ = std::fs::remove_dir_all(&vault);
        let _ = std::fs::remove_dir_all(src.parent().unwrap());
    }

    // --- Comment sidecars follow their page (M70.2) -----------------------

    /// A `remove` that records what it was handed and deletes it outright,
    /// so no test reaches the OS Trash.
    type Removed = std::sync::Arc<Mutex<Vec<PathBuf>>>;

    fn recording_remove() -> (Removed, impl Fn(&Path) -> Result<(), String>) {
        let seen = std::sync::Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        let remove = move |path: &Path| {
            log.lock().unwrap().push(path.to_path_buf());
            if path.is_dir() {
                std::fs::remove_dir_all(path)
            } else {
                std::fs::remove_file(path)
            }
            .map_err(|e| e.to_string())
        };
        (seen, remove)
    }

    const SIDECAR: &str = "{\"format\":1,\"threads\":[]}\n";

    fn page_with_comments(label: &str) -> PathBuf {
        let vault = vault_with_note(label);
        testutil::write(&vault, ".comments/items/atl-1.md.json", SIDECAR);
        vault
    }

    #[test]
    fn renaming_a_page_carries_its_comments() {
        let vault = page_with_comments("wfm-carry-page");
        let (removed, remove) = recording_remove();
        rename_note_with(
            &vault,
            "items/atl-1.md",
            "archive/atl-1.md",
            remove,
            &human(),
        )
        .unwrap();
        assert_eq!(read(&vault, "archive/atl-1.md"), NOTE);
        assert_eq!(read(&vault, ".comments/archive/atl-1.md.json"), SIDECAR);
        assert!(!vault.join(".comments/items").exists());
        assert!(removed.lock().unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn renaming_a_folder_carries_every_sidecar_beneath_it() {
        let vault = page_with_comments("wfm-carry-folder");
        testutil::write(&vault, "items/deep/b.md", "# B\n");
        testutil::write(&vault, ".comments/items/deep/b.md.json", SIDECAR);
        let (_, remove) = recording_remove();
        rename_note_with(&vault, "items", "archive", remove, &human()).unwrap();
        assert_eq!(read(&vault, ".comments/archive/atl-1.md.json"), SIDECAR);
        assert_eq!(read(&vault, ".comments/archive/deep/b.md.json"), SIDECAR);
        assert!(!vault.join(".comments/items").exists());
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn a_refused_rename_moves_no_sidecar() {
        let vault = page_with_comments("wfm-carry-refused");
        testutil::write(&vault, "items/taken.md", "# Taken\n");
        let (removed, remove) = recording_remove();
        let err = rename_note_with(&vault, "items/atl-1.md", "items/taken.md", remove, &human())
            .unwrap_err();
        assert_eq!(err, "target already exists: items/taken.md");
        assert_eq!(read(&vault, ".comments/items/atl-1.md.json"), SIDECAR);
        assert!(!vault.join(".comments/items/taken.md.json").exists());
        assert!(removed.lock().unwrap().is_empty());
        // A missing page moves nothing either.
        let (_, remove) = recording_remove();
        testutil::write(&vault, ".comments/items/gone.md.json", SIDECAR);
        assert!(
            rename_note_with(&vault, "items/gone.md", "items/moved.md", remove, &human()).is_err()
        );
        assert_eq!(read(&vault, ".comments/items/gone.md.json"), SIDECAR);
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn a_failed_page_rename_puts_the_sidecar_back() {
        let vault = page_with_comments("wfm-carry-failed");
        // `blocker` is a file, so the page's new folder can't be made.
        testutil::write(&vault, "blocker", "not a folder");
        let (_, remove) = recording_remove();
        assert!(rename_note_with(
            &vault,
            "items/atl-1.md",
            "blocker/atl-1.md",
            remove,
            &human()
        )
        .is_err());
        assert_eq!(read(&vault, "items/atl-1.md"), NOTE);
        assert_eq!(read(&vault, ".comments/items/atl-1.md.json"), SIDECAR);
        assert!(
            !vault.join(".comments/blocker").exists(),
            "no folder is left behind"
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn an_orphan_sidecar_at_the_target_is_removed_first() {
        let vault = page_with_comments("wfm-carry-orphan");
        let orphan = "{\"format\":1,\"threads\":[{\"comments\":[]}]}\n";
        testutil::write(&vault, ".comments/archive/atl-1.md.json", orphan);
        let (removed, remove) = recording_remove();
        rename_note_with(
            &vault,
            "items/atl-1.md",
            "archive/atl-1.md",
            remove,
            &human(),
        )
        .unwrap();
        assert_eq!(
            *removed.lock().unwrap(),
            vec![vault.join(".comments/archive/atl-1.md.json")]
        );
        assert_eq!(read(&vault, ".comments/archive/atl-1.md.json"), SIDECAR);
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn a_comments_folder_linked_to_git_neither_carries_nor_clears() {
        // `.comments -> .git`: a folder renamed to `objects` would send
        // `.git/objects` to the OS Trash, and a folder named `hooks` would
        // carry `.git/hooks` away with it.
        let vault = vault_with_note("wfm-carry-git-link");
        testutil::write(&vault, ".git/objects/ab/cd", "blob");
        testutil::write(&vault, ".git/hooks/pre-push", "#!/bin/sh\n");
        testutil::write(&vault, "hooks/a.md", "# A\n");
        std::os::unix::fs::symlink(vault.join(".git"), vault.join(".comments")).unwrap();
        let (removed, remove) = recording_remove();
        rename_note_with(&vault, "items", "objects", remove, &human()).unwrap();
        assert!(
            removed.lock().unwrap().is_empty(),
            "nothing went to the Trash"
        );
        assert_eq!(read(&vault, ".git/objects/ab/cd"), "blob");
        assert_eq!(
            read(&vault, "objects/atl-1.md"),
            NOTE,
            "the folder still moves"
        );
        let (removed, remove) = recording_remove();
        rename_note_with(&vault, "hooks", "moved", remove, &human()).unwrap();
        assert!(removed.lock().unwrap().is_empty());
        assert_eq!(read(&vault, ".git/hooks/pre-push"), "#!/bin/sh\n");
        assert!(!vault.join(".git/moved").exists());
        assert_eq!(read(&vault, "moved/a.md"), "# A\n");
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn a_comments_folder_linked_to_the_ledger_leaves_it_in_place() {
        let vault = vault_with_note("wfm-carry-cerebro-link");
        testutil::write(&vault, ".cerebro/ledger/0001.ndjson", "{}\n");
        testutil::write(&vault, "ledger/a.md", "# A\n");
        std::os::unix::fs::symlink(vault.join(".cerebro"), vault.join(".comments")).unwrap();
        let (removed, remove) = recording_remove();
        rename_note_with(&vault, "ledger", "kept", remove, &human()).unwrap();
        assert!(removed.lock().unwrap().is_empty());
        let (removed, remove) = recording_remove();
        rename_note_with(&vault, "items", "ledger", remove, &human()).unwrap();
        assert!(
            removed.lock().unwrap().is_empty(),
            "the ledger is no orphan"
        );
        assert_eq!(read(&vault, ".cerebro/ledger/0001.ndjson"), "{}\n");
        assert!(!vault.join(".cerebro/kept").exists());
        assert_eq!(read(&vault, "ledger/atl-1.md"), NOTE);
        let _ = std::fs::remove_dir_all(&vault);
    }

    /// The one stamp dir in `vault`'s Trash.
    fn trash_stamp(vault: &Path) -> String {
        let stamps: Vec<String> = std::fs::read_dir(vault.join(super::super::trash::TRASH_DIR))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(stamps.len(), 1, "{stamps:?}");
        stamps[0].clone()
    }

    #[test]
    fn deleting_a_page_carries_its_comments_into_the_trash() {
        let vault = page_with_comments("wfm-delete-page");
        let item = delete_note(&vault, "items/atl-1.md", &human()).unwrap();
        let stamp = item.stamp;
        assert_eq!(
            read(&vault, &format!(".trash/{stamp}/items/atl-1.md")),
            NOTE
        );
        assert_eq!(
            read(
                &vault,
                &format!(".trash/{stamp}/.comments/items/atl-1.md.json")
            ),
            SIDECAR
        );
        assert!(!vault.join(".comments").exists());
        // A page with no comments carries only itself.
        testutil::write(&vault, "items/b.md", "# B\n");
        let item = delete_note(&vault, "items/b.md", &human()).unwrap();
        assert!(vault
            .join(format!(".trash/{}/items/b.md", item.stamp))
            .is_file());
        assert!(!vault
            .join(format!(".trash/{}/.comments", item.stamp))
            .exists());
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn deleting_a_folder_carries_its_comments_into_the_trash() {
        let vault = page_with_comments("wfm-delete-folder");
        testutil::write(&vault, "other/c.md", "# C\n");
        testutil::write(&vault, ".comments/other/c.md.json", SIDECAR);
        delete_note(&vault, "items", &human()).unwrap();
        let stamp = trash_stamp(&vault);
        assert_eq!(
            read(&vault, &format!(".trash/{stamp}/items/atl-1.md")),
            NOTE
        );
        assert_eq!(
            read(
                &vault,
                &format!(".trash/{stamp}/.comments/items/atl-1.md.json")
            ),
            SIDECAR
        );
        assert!(!vault.join(".comments/items").exists());
        assert_eq!(read(&vault, ".comments/other/c.md.json"), SIDECAR);
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn a_carry_leaves_no_empty_comment_folder() {
        let vault = page_with_comments("wfm-carry-prune");
        testutil::write(&vault, "items/deep/er/b.md", "# B\n");
        testutil::write(&vault, ".comments/items/deep/er/b.md.json", SIDECAR);
        let (_, remove) = recording_remove();
        rename_note_with(&vault, "items/deep/er/b.md", "b.md", &remove, &human()).unwrap();
        assert!(!vault.join(".comments/items/deep").exists());
        assert!(vault.join(".comments/items/atl-1.md.json").exists());
        delete_note(&vault, "b.md", &human()).unwrap();
        delete_note(&vault, "items/atl-1.md", &human()).unwrap();
        assert!(
            !vault.join(".comments").exists(),
            "nothing is left to keep it"
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn delete_note_moves_into_the_vault_trash_and_records_a_delete() {
        let _recording = Recording::new("wfm-delete-recorded-config");
        let vault = vault_with_note("wfm-delete-recorded");
        let item = delete_note(&vault, "items/atl-1.md", &human()).unwrap();
        assert_eq!(
            (item.path.as_str(), item.title.as_str(), item.pages),
            ("items/atl-1.md", "Ship the scanner", Some(1))
        );
        assert!(!vault.join("items/atl-1.md").exists());
        assert_eq!(
            read(&vault, &format!(".trash/{}/items/atl-1.md", item.stamp)),
            NOTE
        );
        let me = Some(super::super::receipt::HUMAN_ACTOR.to_string());
        assert_eq!(
            recorded(&vault),
            vec![(
                "vault.delete".into(),
                "items/atl-1.md".into(),
                None,
                me,
                None,
                None
            )]
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn rename_refuses_hidden_paths() {
        let vault = page_with_comments("wfm-rename-hidden");
        let (_, remove) = recording_remove();
        for (from, to) in [
            (
                "items/atl-1.md",
                ".trash/20261014T093000Z-a1b2/items/atl-1.md",
            ),
            ("items/atl-1.md", ".comments/atl-1.md"),
            (".comments/items/atl-1.md.json", "items/sidecar.json"),
            ("items/atl-1.md", "items/\u{200c}.obsidian/atl-1.md"),
        ] {
            let err = rename_note_with(&vault, from, to, &remove, &human()).unwrap_err();
            assert!(
                err.contains("is not a page Cerebro shows"),
                "{from} -> {to}: {err}"
            );
        }
        assert_eq!(read(&vault, "items/atl-1.md"), NOTE);
        assert_eq!(read(&vault, ".comments/items/atl-1.md.json"), SIDECAR);
        assert!(!vault.join(".trash").exists());
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn clean_orphan_temps_reaps_trash_manifest_temps() {
        let vault = vault_with_note("wfm-orphans-trash");
        let rel =
            format!(".trash/20261014T093000Z-a1b2/..trashed.json{TEMP_MARKER}00000000deadbeef");
        testutil::write(&vault, &rel, "half a manifest");
        backdate(&vault.join(&rel), 120);
        let fresh =
            format!(".trash/20261014T093000Z-a1b2/..trashed.json{TEMP_MARKER}00000000feedface");
        testutil::write(&vault, &fresh, "in flight");
        clean_orphan_temps(&vault, &janitor());
        assert!(!vault.join(&rel).exists());
        assert!(vault.join(&fresh).exists(), "a young temp is spared");
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn orphan_temps_under_comments_are_reaped() {
        let vault = page_with_comments("wfm-orphans-comments");
        let stale = vault.join(format!(
            ".comments/items/.atl-1.md.json{TEMP_MARKER}00000000deadbeef"
        ));
        std::fs::write(&stale, "half a sidecar").unwrap();
        backdate(&stale, 120);
        // Other dot-folders stay out of the walk.
        let foreign = vault.join(format!(".git/.config{TEMP_MARKER}00000000deadbeef"));
        testutil::write(
            &vault,
            &format!(".git/.config{TEMP_MARKER}00000000deadbeef"),
            "x",
        );
        backdate(&foreign, 120);
        clean_orphan_temps(&vault, &janitor());
        assert!(!stale.exists());
        assert!(foreign.exists());
        assert_eq!(read(&vault, ".comments/items/atl-1.md.json"), SIDECAR);
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn rename_holds_both_ends() {
        let vault = testutil::temp_vault("wfm-lock-rename");
        testutil::write(&vault, "items/a.md", NOTE);
        let held = lock_paths(&vault, &["items/b.md"]).unwrap();
        let dir = vault.clone();
        let rename = in_thread(move || rename_note(&dir, "items/a.md", "items/b.md", &human()));
        assert!(rename.recv_timeout(WAITS).is_err(), "the rename waits");
        write_file(&held, &vault.join("items/b.md"), "# B\n").unwrap();
        drop(held);
        let err = rename.recv_timeout(LANDS).unwrap().unwrap_err();
        assert_eq!(err, "target already exists: items/b.md");
        assert_eq!(read(&vault, "items/a.md"), NOTE);
        assert_eq!(read(&vault, "items/b.md"), "# B\n");
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn a_panic_inside_a_locked_write_releases_the_path() {
        let vault = vault_with_note("wfm-lock-panic");
        let dir = vault.clone();
        let panicked = std::thread::spawn(move || {
            rewrite_note(
                &dir,
                "items/atl-1.md",
                MARKDOWN,
                None,
                |_| panic!("a write that panics while it holds its path"),
                &human(),
            )
        })
        .join();
        assert!(panicked.is_err(), "the write panicked");
        let dir = vault.clone();
        let next = in_thread(move || {
            update_frontmatter(
                &dir,
                "items/atl-1.md",
                &patch(&[("status", serde_json::json!("done"))]),
                &human(),
            )
        });
        next.recv_timeout(LANDS)
            .expect("the panic released the path")
            .unwrap();
        assert!(read(&vault, "items/atl-1.md").contains("status: done"));
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn a_lock_taken_twice_by_one_write_refuses_instead_of_hanging() {
        let vault = vault_with_note("wfm-lock-twice");
        let dir = vault.clone();
        let nested = in_thread(move || {
            let mut inner = None;
            let outer = rewrite_note(
                &dir,
                "items/atl-1.md",
                MARKDOWN,
                None,
                |current| {
                    inner = Some(save_note(&dir, "./items/atl-1.md", "\n# Inner\n", &human()));
                    Ok(current.to_string())
                },
                &human(),
            );
            (outer, inner)
        });
        let (outer, inner) = nested
            .recv_timeout(LANDS)
            .expect("no write hangs on itself");
        assert_eq!(
            inner.unwrap().unwrap_err(),
            "./items/atl-1.md is already locked by this write"
        );
        outer.unwrap();
        assert_eq!(read(&vault, "items/atl-1.md"), NOTE);
        // One call naming one file twice takes it once.
        let both = lock_paths(&vault, &["items/atl-1.md", "./items/atl-1.md"]).unwrap();
        drop(both);
        let _ = std::fs::remove_dir_all(&vault);
    }

    // --- Atomic writes (M21.1) ---------------------------------------------

    /// Every atomic-write temp anywhere under the vault, dot-dirs included —
    /// the assertion net must be wider than the janitor's walk.
    fn temp_files(vault: &Path) -> Vec<std::path::PathBuf> {
        walkdir::WalkDir::new(vault)
            .into_iter()
            .filter_map(Result::ok)
            .filter(|e| e.file_type().is_file())
            .filter(|e| e.file_name().to_string_lossy().contains(TEMP_MARKER))
            .map(|e| e.into_path())
            .collect()
    }

    fn backdate(path: &Path, secs: u64) {
        let then = std::time::SystemTime::now() - std::time::Duration::from_secs(secs);
        let file = std::fs::File::options().write(true).open(path).unwrap();
        file.set_times(
            std::fs::FileTimes::new()
                .set_accessed(then)
                .set_modified(then),
        )
        .unwrap();
    }

    fn assert_aborted(status: std::process::ExitStatus) {
        #[cfg(unix)]
        {
            use std::os::unix::process::ExitStatusExt;
            // SIGABRT — the crash point fired. A plain test failure (panic)
            // exits with a code instead, and must not pass as a crash.
            assert_eq!(status.signal(), Some(6), "expected SIGABRT, got {status:?}");
        }
        #[cfg(not(unix))]
        assert!(
            !status.success(),
            "expected an aborted child, got {status:?}"
        );
    }

    #[test]
    fn writes_leave_no_temp_behind_on_success() {
        let vault = vault_with_note("wfm-atomic-clean");
        save_note(
            &vault,
            "items/atl-1.md",
            "\n# Ship the scanner\n\nNew body.\n",
            &human(),
        )
        .unwrap();
        update_frontmatter(
            &vault,
            "items/atl-1.md",
            &patch(&[("status", serde_json::json!("done"))]),
            &human(),
        )
        .unwrap();
        create_note(&vault, "items", "fresh", &patch(&[]), "# Fresh\n", &human()).unwrap();
        assert!(temp_files(&vault).is_empty());
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[cfg(unix)]
    #[test]
    fn writes_preserve_tightened_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let vault = vault_with_note("wfm-atomic-perms");
        let path = vault.join("items/atl-1.md");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        save_note(
            &vault,
            "items/atl-1.md",
            "\n# Ship the scanner\n\nPrivate.\n",
            &human(),
        )
        .unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn clean_orphan_temps_reaps_stale_and_spares_fresh() {
        let vault = testutil::temp_vault("wfm-orphans");
        testutil::write(&vault, "items/keep.md", "# Keep\n");
        // A crashed write from two minutes ago, nested one level down…
        let stale = vault.join(format!("items/.a.md{TEMP_MARKER}00000000deadbeef"));
        // …and a vault-root temp young enough to be a write in flight.
        let fresh = vault.join(format!(".b.yml{TEMP_MARKER}00000000cafebabe"));
        std::fs::write(&stale, "half a note").unwrap();
        std::fs::write(&fresh, "half a view").unwrap();
        backdate(&stale, 120);
        clean_orphan_temps(&vault, &janitor());
        assert!(!stale.exists(), "stale orphan must be reaped");
        assert!(
            fresh.exists(),
            "a fresh temp may belong to an in-flight write"
        );
        assert!(vault.join("items/keep.md").exists());
        let _ = std::fs::remove_dir_all(&vault);
    }

    // M60.6: a batch's temps live as long as the batch, which its journal
    // guards, so the janitor spares one younger than a day...
    #[test]
    fn a_fresh_batch_temp_survives_the_janitor() {
        let vault = testutil::temp_vault("wfm-batch-temp-fresh");
        let temp = vault.join(format!("items/.a.md{BATCH_TEMP_MARKER}00000000deadbeef"));
        testutil::write(&vault, "items/a.md", "# A\n");
        std::fs::write(&temp, "a staged page").unwrap();
        backdate(&temp, 120);
        clean_orphan_temps(&vault, &janitor());
        assert!(
            temp.exists(),
            "a batch temp outlives a single write's guard"
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    // ...and reaps one a day old, which both the journal and recovery missed.
    #[test]
    fn a_day_old_batch_temp_is_reaped() {
        let vault = testutil::temp_vault("wfm-batch-temp-old");
        let temp = vault.join(format!("items/.a.md{BATCH_TEMP_MARKER}00000000feedface"));
        testutil::write(&vault, "items/a.md", "# A\n");
        std::fs::write(&temp, "a staged page").unwrap();
        backdate(&temp, 24 * 60 * 60 + 60);
        clean_orphan_temps(&vault, &janitor());
        assert!(!temp.exists());
        assert!(vault.join("items/a.md").exists());
        let _ = std::fs::remove_dir_all(&vault);
    }

    /// Child body for the crash tests below: rewrite the fixture note through
    /// the atomic funnel. Ignored in normal runs — `run_crash_scenario`
    /// spawns it in a child process with `CEREBRO_CRASH_POINT` armed.
    #[test]
    #[ignore = "crash-scenario child body, spawned by the crash tests"]
    fn crash_scenario_overwrite_note() {
        let Ok(vault) = std::env::var("CEREBRO_CRASH_VAULT") else {
            return;
        };
        let vault = Path::new(&vault);
        let lock = lock_paths(vault, &["items/atl-1.md"]).unwrap();
        write_file(
            &lock,
            &vault.join("items/atl-1.md"),
            "# Rewritten by the crash scenario\n",
        )
        .unwrap();
    }

    #[test]
    fn crash_at_temp_written_leaves_destination_untouched() {
        let vault = vault_with_note("wfm-crash-temp");
        let status = testutil::run_crash_scenario(
            "vault::write::tests::crash_scenario_overwrite_note",
            "temp-written",
            &vault,
        );
        assert_aborted(status);
        // Old bytes intact; the half-finished write is only an orphan temp.
        assert_eq!(read(&vault, "items/atl-1.md"), NOTE);
        let orphans = temp_files(&vault);
        assert_eq!(orphans.len(), 1, "{orphans:?}");
        // The acceptance-matrix row ends "orphan reaped later": age it past
        // the guard and let the janitor prove that.
        backdate(&orphans[0], 120);
        clean_orphan_temps(&vault, &janitor());
        assert!(temp_files(&vault).is_empty());
        let _ = std::fs::remove_dir_all(&vault);
    }

    // M21.6: the funnel registers WHAT it wrote, so the watcher recognizes
    // the echo by content — and only the echo.
    #[test]
    fn the_write_funnel_registers_its_content_hash_with_the_watcher() {
        let vault = vault_with_note("wfm-hashed-own-write");
        save_note(
            &vault,
            "items/atl-1.md",
            "\n# Ship the scanner\n\nMine.\n",
            &human(),
        )
        .unwrap();
        let path = vault.join("items/atl-1.md");
        assert!(crate::vault::watcher::is_suppressed(&path));
        // A foreign edit right afterwards is not ours, window or no window.
        std::fs::write(&path, "someone else's bytes").unwrap();
        assert!(!crate::vault::watcher::is_suppressed(&path));
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn crash_after_rename_leaves_new_bytes_and_no_orphan() {
        let vault = vault_with_note("wfm-crash-rename");
        let status = testutil::run_crash_scenario(
            "vault::write::tests::crash_scenario_overwrite_note",
            "renamed-pre-dirsync",
            &vault,
        );
        assert_aborted(status);
        assert_eq!(
            read(&vault, "items/atl-1.md"),
            "# Rewritten by the crash scenario\n"
        );
        assert!(temp_files(&vault).is_empty());
        let _ = std::fs::remove_dir_all(&vault);
    }
}
