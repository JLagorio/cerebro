//! The vault's own Trash (M60.8): nothing a person deletes is hard-deleted.
//!
//! A delete moves the item into one stamp dir, `.trash/<stamp>/`, at its
//! vault path, with its comment sidecar (a page's `.comments/<page>.json`, or
//! a folder's mirrored `.comments/<folder>`) under `.trash/<stamp>/.comments/`
//! and a manifest, `.trashed.json`, beside them: `{format, path, kind, title,
//! deleted_at}`, two-space JSON with a final newline. A stamp is the UTC
//! second plus four random lowercase hex characters,
//! `YYYYMMDDTHHMMSSZ-hhhh`, so stamps sort by time and two deletes in one
//! second take two dirs.
//!
//! `.trash/` is a dot-folder, so the scan, folder listing, search and every
//! Cerebro agent tool already pass it by (`scan::is_hidden`), and git ignores
//! it (`git::commit::IGNORE_ENTRIES`). Restore puts the item and its sidecar
//! back and refuses to overwrite anything. The launch purge
//! (`purge_expired_to_os_trash`) hands stamp dirs older than [`KEEP_DAYS`],
//! judged by the stamp and never by mtime, to the macOS Trash. Names in
//! `.trash/` that are no stamp (Obsidian keeps its own flat files there) are
//! never listed and never purged.
//!
//! Lock order: a move holds its path locks (M55.1) over the item, its sidecar
//! and the stamp's manifest. Restore also takes [`TRASH_LOCK`], a leaf mutex
//! shared only with the purge, so the purge never takes a stamp dir a
//! restore is emptying. The batch writer (`vault::batch`, M60.6) moves its
//! deletes and restores through [`trash_locked`] and [`untrash_locked`] under
//! the locks it took for the whole batch.
//!
//! Mirrored by the mock (`src/lib/mockIpc.ts`) and `src/engine/trash.ts`; all
//! replay `src-tauri/fixtures/trash-cases.json`.

use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};

use chrono::{DateTime, NaiveDate, Utc};
use serde::Serialize;

use super::receipt::{Door, Human, System, WriteReceipt};
use super::write::{self, PathLock};

/// The vault folder the Trash lives in.
pub const TRASH_DIR: &str = ".trash";
/// Each stamp dir's manifest.
pub const MANIFEST: &str = ".trashed.json";
/// How long an item waits before the launch purge moves it to the OS Trash.
pub const KEEP_DAYS: i64 = 30;
/// The manifest format this build writes, and the newest it reads.
pub const MANIFEST_FORMAT: u64 = 1;

/// What a stamp dir holds: a file, a folder, or something with no readable
/// manifest, which lists but never restores.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TrashKind {
    File,
    Folder,
    Unreadable,
}

/// One item in the Trash, as Settings lists it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashedItem {
    pub stamp: String,
    /// The vault path it came from, or for an unreadable item the stamp dir
    /// it sits in.
    pub path: String,
    pub kind: TrashKind,
    /// The title it had when it went, empty for an unreadable item.
    pub title: String,
    /// When it went, RFC 3339 UTC to the second.
    pub deleted_at: String,
    /// The pages inside: 1 or 0 for a file, every `.md` and `.mmd` for a
    /// folder, `None` when nobody could count them (CV-05).
    pub pages: Option<u64>,
}

/// The manifest beside a trashed item. Field order is the file's key order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Manifest {
    pub format: u64,
    pub path: String,
    pub kind: TrashKind,
    pub title: String,
    pub deleted_at: String,
}

/// What the launch purge did: stamp dirs it handed over, and those it kept
/// because the OS Trash refused them.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PurgeReport {
    pub moved: usize,
    pub kept: usize,
}

// --- Words (trash-cases.json `words`) ----------------------------------------

/// A delete of a path the scan hides.
pub fn not_a_page(path: &str) -> String {
    format!("{path} is not a page Cerebro shows, so it can't go to the Trash.")
}

/// A restore onto a path something now holds.
pub fn already_exists(path: &str) -> String {
    format!("{path} already exists, so nothing was restored. Move or rename that page first.")
}

/// A restore of a stamp dir whose manifest can't be read.
pub const UNREADABLE: &str = "This Trash item can't be read, so it can't be restored.";

/// A restore of a stamp that holds nothing to restore.
pub fn nothing_at(stamp: &str) -> String {
    format!("Nothing in the Trash at {stamp}.")
}

/// Two deletes minted one stamp; the second mints again.
pub(crate) const STAMP_TAKEN: &str = "that Trash stamp is taken";

// --- Stamps ------------------------------------------------------------------

/// The stamp for a delete at `now`, with `rng` as its four hex characters.
pub fn new_stamp(now: DateTime<Utc>, rng: u16) -> String {
    format!("{}-{rng:04x}", now.format("%Y%m%dT%H%M%SZ"))
}

/// The second a stamp names, or `None` when `name` is no stamp.
pub fn parse_stamp(name: &str) -> Option<DateTime<Utc>> {
    let bytes = name.as_bytes();
    let digits = |range: std::ops::Range<usize>| -> Option<u32> {
        let part = name.get(range)?;
        part.bytes()
            .all(|b| b.is_ascii_digit())
            .then(|| part.parse().ok())
            .flatten()
    };
    if bytes.len() != 21 || bytes[8] != b'T' || bytes[15] != b'Z' || bytes[16] != b'-' {
        return None;
    }
    if !bytes[17..]
        .iter()
        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(b))
    {
        return None;
    }
    let date = NaiveDate::from_ymd_opt(digits(0..4)? as i32, digits(4..6)?, digits(6..8)?)?;
    let time = date.and_hms_opt(digits(9..11)?, digits(11..13)?, digits(13..15)?)?;
    Some(time.and_utc())
}

/// A second as the manifest spells it.
fn rfc3339(at: DateTime<Utc>) -> String {
    at.format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

/// Is a stamp dir minted at `at` past `keep_days` at `now`?
pub fn expired(at: DateTime<Utc>, now: DateTime<Utc>, keep_days: i64) -> bool {
    at + chrono::Duration::days(keep_days) < now
}

// --- Manifests ---------------------------------------------------------------

/// A manifest's bytes: two-space JSON and a final newline.
pub fn manifest_bytes(manifest: &Manifest) -> String {
    let mut text = serde_json::to_string_pretty(manifest).expect("a manifest serializes");
    text.push('\n');
    text
}

/// Is `rel` a vault path a Trash item may name: `/`-separated names, none
/// empty, `.`, `..` or hidden as the scan hears it?
fn is_item_path(rel: &str) -> bool {
    !rel.is_empty()
        && rel
            .split('/')
            .all(|name| !name.is_empty() && name != ".." && !super::scan::is_hidden(name))
}

/// A manifest's text read back, or `None` when it can't be: not JSON, a
/// newer format, a path that is not an item path, a kind that is neither
/// `file` nor `folder`, or a missing title or time.
pub fn parse_manifest(text: &str) -> Option<Manifest> {
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    let object = value.as_object()?;
    let text_of = |key: &str| object.get(key)?.as_str().map(str::to_string);
    let format = object.get("format")?.as_u64()?;
    if format != MANIFEST_FORMAT {
        return None;
    }
    let path = text_of("path").filter(|p| is_item_path(p))?;
    let kind = match object.get("kind")?.as_str()? {
        "file" => TrashKind::File,
        "folder" => TrashKind::Folder,
        _ => return None,
    };
    Some(Manifest {
        format,
        path,
        kind,
        title: text_of("title")?,
        deleted_at: text_of("deleted_at")?,
    })
}

pub(crate) fn stamp_rel(stamp: &str) -> String {
    format!("{TRASH_DIR}/{stamp}")
}

pub(crate) fn manifest_rel(stamp: &str) -> String {
    format!("{TRASH_DIR}/{stamp}/{MANIFEST}")
}

/// Does a stamp dir hold anything but dot-names (its manifest, a manifest
/// temp, a sidecar left behind)? A trashed item never has a hidden name.
fn holds_an_item(stamp_dir: &Path) -> bool {
    std::fs::read_dir(stamp_dir).is_ok_and(|entries| {
        entries
            .filter_map(Result::ok)
            .any(|entry| !super::scan::is_hidden(&entry.file_name().to_string_lossy()))
    })
}

/// A stamp's manifest, under the words a restore refuses with.
pub(crate) fn read_manifest(vault: &Path, stamp: &str) -> Result<Manifest, String> {
    if parse_stamp(stamp).is_none() {
        return Err(nothing_at(stamp));
    }
    let dir = write::safe_join(vault, &stamp_rel(stamp))?;
    match std::fs::read_to_string(dir.join(MANIFEST)) {
        Ok(text) => parse_manifest(&text).ok_or_else(|| UNREADABLE.to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            if holds_an_item(&dir) {
                Err(UNREADABLE.to_string())
            } else {
                Err(nothing_at(stamp))
            }
        }
        Err(_) => Err(UNREADABLE.to_string()),
    }
}

/// The vault path a stamp would restore to: what `restore_from_trash`'s
/// command guards before it mints a receipt.
pub fn restore_target(vault: &Path, stamp: &str) -> Result<String, String> {
    read_manifest(vault, stamp).map(|manifest| manifest.path)
}

// --- Moves -------------------------------------------------------------------

/// The leaf lock restore and the purge share. Holds no data.
static TRASH_LOCK: Mutex<()> = Mutex::new(());

fn trash_lock() -> MutexGuard<'static, ()> {
    TRASH_LOCK.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The title an item had: a page's as the scan reads it, a folder's or any
/// other file's name.
fn title_of(rel: &str, abs: &Path, is_dir: bool) -> String {
    let name = rel.rsplit('/').next().unwrap_or(rel).to_string();
    if is_dir || !(rel.ends_with(".md") || rel.ends_with(".mmd")) {
        return name;
    }
    let content = std::fs::read_to_string(abs).unwrap_or_default();
    super::entry::build_entry(rel, &content, String::new(), String::new()).title
}

/// The pages an item holds: 1 or 0 for a file, every `.md` and `.mmd` under
/// a folder whose names the scan shows, `None` when the walk failed.
fn count_pages(abs: &Path, rel: &str, is_dir: bool) -> Option<u64> {
    let is_page = |name: &str| name.ends_with(".md") || name.ends_with(".mmd");
    if !is_dir {
        return Some(u64::from(is_page(rel)));
    }
    let mut pages = 0;
    for entry in walkdir::WalkDir::new(abs).min_depth(1) {
        let entry = entry.ok()?;
        let inside = entry.path().strip_prefix(abs).ok()?;
        let shown = inside.components().all(|c| match c {
            Component::Normal(name) => !super::scan::is_hidden(&name.to_string_lossy()),
            _ => false,
        });
        if shown && entry.file_type().is_file() && is_page(&entry.file_name().to_string_lossy()) {
            pages += 1;
        }
    }
    Some(pages)
}

/// Remove a stamp dir's manifest: the one file under `vault/` this module
/// unlinks, and never a page.
fn remove_manifest(path: &Path) {
    if let Err(e) = std::fs::remove_file(path) {
        if e.kind() != std::io::ErrorKind::NotFound {
            log::warn!("trash: a manifest stayed at {}: {e}", path.display());
        }
    }
}

/// Remove every empty folder under `root`, `root` included. Never follows a
/// link: only real, empty directories go.
fn prune_empty_dirs(root: &Path) {
    let is_real_dir = std::fs::symlink_metadata(root).is_ok_and(|m| m.is_dir());
    if !is_real_dir {
        return;
    }
    let dirs: Vec<PathBuf> = walkdir::WalkDir::new(root)
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

/// Move `rel` into the stamp dir `stamp`, under `lock`, which holds `rel`,
/// its sidecar and the stamp's manifest.
///
/// In order: a path with a hidden name refuses (`.trash/`, `.git/` and
/// `.comments/` never go), then a missing one; the destination resolves
/// through `safe_join`, so a `.trash` linked out of the vault refuses; the
/// stamp dir is claimed; the manifest is written first (`trash-manifest-
/// written`); the item moves (`trash-moved`) and is recorded as a
/// `vault.delete` under `by`; then its sidecar follows, and a sidecar that
/// fails to move is logged and the delete stands.
pub(crate) fn trash_locked<D: Door>(
    vault: &Path,
    rel: &str,
    stamp: &str,
    lock: &PathLock,
    by: &WriteReceipt<D>,
) -> Result<TrashedItem, String> {
    let src = write::safe_join(vault, rel)?;
    if !is_item_path(rel) {
        return Err(not_a_page(rel));
    }
    let meta = std::fs::symlink_metadata(&src).map_err(|_| format!("not found: {rel}"))?;
    let at = parse_stamp(stamp).ok_or_else(|| nothing_at(stamp))?;
    let is_dir = meta.is_dir();
    let dest = write::safe_join(vault, &format!("{}/{rel}", stamp_rel(stamp)))?;
    let stamp_dir = write::safe_join(vault, &stamp_rel(stamp))?;
    if let Some(trash) = stamp_dir.parent() {
        std::fs::create_dir_all(trash).map_err(|e| format!("{TRASH_DIR}: {e}"))?;
    }
    match std::fs::create_dir(&stamp_dir) {
        Ok(()) => {}
        // A stamp dir holding no manifest and no item is one a restore
        // emptied but could not prune (its sidecar stayed): a batch rolling
        // that restore back (M60.6) moves the page back into it.
        Err(e)
            if e.kind() == std::io::ErrorKind::AlreadyExists
                && (stamp_dir.join(MANIFEST).exists() || holds_an_item(&stamp_dir)) =>
        {
            return Err(STAMP_TAKEN.to_string())
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(format!("{TRASH_DIR}: {e}")),
    }
    let title = title_of(rel, &src, is_dir);
    let manifest = Manifest {
        format: MANIFEST_FORMAT,
        path: rel.to_string(),
        kind: if is_dir {
            TrashKind::Folder
        } else {
            TrashKind::File
        },
        title: title.clone(),
        deleted_at: rfc3339(at),
    };
    let manifest_abs = vault.join(manifest_rel(stamp));
    if let Err(e) = write::write_file(lock, &manifest_abs, &manifest_bytes(&manifest)) {
        prune_empty_dirs(&stamp_dir);
        return Err(e);
    }
    crate::crash::crash_point("trash-manifest-written");
    let moved = dest
        .parent()
        .map_or(Ok(()), std::fs::create_dir_all)
        .and_then(|()| {
            super::watcher::note_own_write(&src);
            std::fs::rename(&src, &dest)
        });
    if let Err(e) = moved {
        remove_manifest(&manifest_abs);
        prune_empty_dirs(&stamp_dir);
        return Err(format!("{rel}: {e}"));
    }
    crate::crash::crash_point("trash-moved");
    write::record(vault, "vault.delete", rel, None, None, by);
    if let Some(side) = super::comments::carried_rel(rel, is_dir) {
        carry_out(vault, &side, stamp, lock, by);
        write::prune_empty_comment_folders(vault);
    }
    Ok(TrashedItem {
        stamp: stamp.to_string(),
        path: rel.to_string(),
        kind: manifest.kind,
        title,
        deleted_at: manifest.deleted_at,
        pages: count_pages(&dest, rel, is_dir),
    })
}

/// Move a trashed item's sidecar into its stamp dir. Best-effort: a sidecar
/// that stays is logged, and the page's delete stands. One reached through a
/// link (`comments::sidecar_join`) stays, so the carry never moves the
/// folder a link names.
fn carry_out<D: Door>(
    vault: &Path,
    side: &str,
    stamp: &str,
    lock: &PathLock,
    by: &WriteReceipt<D>,
) {
    let from = match super::comments::sidecar_join(vault, side) {
        Ok(from) if from.exists() => from,
        Ok(_) => return,
        Err(e) => {
            log::warn!("comments: {side} was not looked for: {e}");
            return;
        }
    };
    if !lock.covers(&from) {
        log::warn!("comments: {side} stayed, its lock was not held");
        return;
    }
    let moved = write::safe_join(vault, &format!("{}/{side}", stamp_rel(stamp))).and_then(|to| {
        to.parent()
            .map_or(Ok(()), std::fs::create_dir_all)
            .and_then(|()| std::fs::rename(&from, &to))
            .map_err(|e| e.to_string())
    });
    match moved {
        Ok(()) => {
            super::watcher::note_own_write(&from);
            write::record(vault, "vault.delete", side, None, None, by);
        }
        Err(e) => log::warn!("comments: {side} stayed after its page went to the Trash: {e}"),
    }
}

/// Move the item in stamp dir `stamp` back to its vault path, under `lock`,
/// which holds that path, its sidecar and the stamp's manifest. Returns the
/// path restored.
///
/// In order: the manifest is read (an unreadable one refuses), and its path
/// must be one `lock` holds; a knowledge/ target refuses in the bundle
/// guard's words; the item must be in the stamp dir; anything now at the
/// target refuses, and nothing moves. Under [`TRASH_LOCK`] the item moves
/// back (`untrash-moved`) and is recorded as a `vault.create` with its
/// file's hash (none for a folder); its sidecar returns unless one now sits
/// at its place, which keeps the Trash copy and logs; then the manifest and
/// the empty stamp dir go.
pub(crate) fn untrash_locked<D: Door>(
    vault: &Path,
    stamp: &str,
    lock: &PathLock,
    by: &WriteReceipt<D>,
) -> Result<String, String> {
    let manifest = read_manifest(vault, stamp)?;
    let target = manifest.path;
    let dest = write::safe_join(vault, &target)?;
    if !lock.covers(&dest) {
        return Err(UNREADABLE.to_string());
    }
    crate::knowledge::guard_human_write(&target).map(drop)?;
    let stamp_dir = write::safe_join(vault, &stamp_rel(stamp))?;
    let item = write::safe_join(vault, &format!("{}/{target}", stamp_rel(stamp)))?;
    let is_dir = manifest.kind == TrashKind::Folder;
    let _trash = trash_lock();
    match std::fs::symlink_metadata(&item) {
        Ok(meta) if meta.is_dir() == is_dir => {}
        Ok(_) => return Err(UNREADABLE.to_string()),
        Err(_) => return Err(nothing_at(stamp)),
    }
    if std::fs::symlink_metadata(&dest).is_ok() {
        return Err(already_exists(&target));
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("{target}: {e}"))?;
    }
    super::watcher::note_own_write(&dest);
    std::fs::rename(&item, &dest).map_err(|e| format!("{target}: {e}"))?;
    crate::crash::crash_point("untrash-moved");
    let hash = (!is_dir)
        .then(|| std::fs::read(&dest).ok())
        .flatten()
        .map(|bytes| crate::ledger::sha256_hex(&bytes));
    write::record(vault, "vault.create", &target, None, hash.as_deref(), by);
    if let Some(side) = super::comments::carried_rel(&target, is_dir) {
        carry_back(vault, &side, stamp, is_dir, by);
    }
    remove_manifest(&stamp_dir.join(MANIFEST));
    prune_empty_dirs(&stamp_dir);
    Ok(target)
}

/// Return a restored item's sidecar from its stamp dir, unless one now sits
/// at its place, or its place is reached through a link
/// (`comments::sidecar_join`): then the Trash copy stays, logged.
fn carry_back<D: Door>(vault: &Path, side: &str, stamp: &str, is_dir: bool, by: &WriteReceipt<D>) {
    let Ok(from) = write::safe_join(vault, &format!("{}/{side}", stamp_rel(stamp))) else {
        return;
    };
    if std::fs::symlink_metadata(&from).is_err() {
        return;
    }
    let to = match super::comments::sidecar_join(vault, side) {
        Ok(to) => to,
        Err(e) => {
            log::warn!("comments: {side} stayed in the Trash: {e}");
            return;
        }
    };
    if std::fs::symlink_metadata(&to).is_ok() {
        log::warn!(
            "comments: {side} already holds comments, so the Trash keeps the restored page's"
        );
        return;
    }
    let moved = to
        .parent()
        .map_or(Ok(()), std::fs::create_dir_all)
        .and_then(|()| std::fs::rename(&from, &to));
    match moved {
        Ok(()) => {
            super::watcher::note_own_write(&to);
            let hash = (!is_dir)
                .then(|| std::fs::read(&to).ok())
                .flatten()
                .map(|bytes| crate::ledger::sha256_hex(&bytes));
            write::record(vault, "vault.create", side, None, hash.as_deref(), by);
        }
        Err(e) => log::warn!("comments: {side} stayed in the Trash: {e}"),
    }
}

/// Move `rel`, a page or folder, to the vault's Trash, its comments after
/// it. Mints a stamp, locks the item, its sidecar and the manifest, and
/// moves (see [`trash_locked`]). A stamp another delete took mints again.
pub fn move_to_trash(
    vault: &Path,
    rel: &str,
    by: &WriteReceipt<Human>,
) -> Result<TrashedItem, String> {
    for _ in 0..8 {
        let stamp = new_stamp(Utc::now(), rand::random::<u16>());
        if vault.join(TRASH_DIR).join(&stamp).exists() {
            continue;
        }
        let is_dir = write::safe_join(vault, rel)?.is_dir();
        let side = super::comments::carried_rel(rel, is_dir);
        let manifest = manifest_rel(&stamp);
        let mut keys = vec![rel, manifest.as_str()];
        if let Some(side) = &side {
            keys.push(side.as_str());
        }
        let lock = write::lock_paths(vault, &keys)?;
        match trash_locked(vault, rel, &stamp, &lock, by) {
            Err(e) if e == STAMP_TAKEN => continue,
            moved => return moved,
        }
    }
    Err(format!("{rel}: no free Trash stamp"))
}

/// Restore the item in stamp dir `stamp` (see [`untrash_locked`]). Returns
/// the vault path it came back to.
pub fn restore_from_trash(
    vault: &Path,
    stamp: &str,
    by: &WriteReceipt<Human>,
) -> Result<String, String> {
    let manifest = read_manifest(vault, stamp)?;
    let side = super::comments::carried_rel(&manifest.path, manifest.kind == TrashKind::Folder);
    let manifest_at = manifest_rel(stamp);
    let mut keys = vec![manifest.path.as_str(), manifest_at.as_str()];
    if let Some(side) = &side {
        keys.push(side.as_str());
    }
    let lock = write::lock_paths(vault, &keys)?;
    untrash_locked(vault, stamp, &lock, by)
}

/// The item a stamp dir holds, as Settings lists it, or `None` when it
/// holds none: a readable manifest whose item is gone (a restore or a
/// delete stopped midway), or no manifest and nothing but dot-names.
fn listed(vault: &Path, stamp: &str, at: DateTime<Utc>) -> Option<TrashedItem> {
    let dir = vault.join(TRASH_DIR).join(stamp);
    let manifest = std::fs::read_to_string(dir.join(MANIFEST))
        .ok()
        .and_then(|text| parse_manifest(&text));
    match manifest {
        Some(manifest) => {
            let item = dir.join(&manifest.path);
            std::fs::symlink_metadata(&item).ok()?;
            let is_dir = manifest.kind == TrashKind::Folder;
            Some(TrashedItem {
                stamp: stamp.to_string(),
                pages: count_pages(&item, &manifest.path, is_dir),
                path: manifest.path,
                kind: manifest.kind,
                title: manifest.title,
                deleted_at: manifest.deleted_at,
            })
        }
        None => holds_an_item(&dir).then(|| TrashedItem {
            stamp: stamp.to_string(),
            path: stamp_rel(stamp),
            kind: TrashKind::Unreadable,
            title: String::new(),
            deleted_at: rfc3339(at),
            pages: None,
        }),
    }
}

/// The stamp dirs in `.trash/`, newest first, with the second each names.
/// Names that are no stamp, and anything not a real folder, are passed by.
fn stamp_dirs(vault: &Path) -> Result<Vec<(String, DateTime<Utc>)>, String> {
    let root = write::safe_join(vault, TRASH_DIR)?;
    let entries = match std::fs::read_dir(&root) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("{TRASH_DIR}: {e}")),
    };
    let mut stamps: Vec<(String, DateTime<Utc>)> = entries
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_ok_and(|t| t.is_dir()))
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            parse_stamp(&name).map(|at| (name, at))
        })
        .collect();
    stamps.sort_by(|a, b| b.0.cmp(&a.0));
    Ok(stamps)
}

/// Every item in the Trash, newest first. A stamp dir without a readable
/// manifest lists as unreadable, never dropped; a read of `.trash/` that
/// fails is an error, never an empty Trash.
pub fn list_trash(vault: &Path) -> Result<Vec<TrashedItem>, String> {
    Ok(stamp_dirs(vault)?
        .into_iter()
        .filter_map(|(stamp, at)| listed(vault, &stamp, at))
        .collect())
}

/// Hand every stamp dir older than `keep_days` at `now`, by its stamp, to
/// `remove`, and keep any it refuses. Records nothing: it moves only
/// `.trash/`, which no scan lists (`write::UNRECORDED`).
pub fn purge_expired(
    vault: &Path,
    now: DateTime<Utc>,
    keep_days: i64,
    mut remove: impl FnMut(&Path) -> Result<(), String>,
    _by: &WriteReceipt<System>,
) -> PurgeReport {
    let mut report = PurgeReport::default();
    let stamps = match stamp_dirs(vault) {
        Ok(stamps) => stamps,
        Err(e) => {
            log::warn!("trash: the purge could not read {TRASH_DIR}: {e}");
            return report;
        }
    };
    let _trash = trash_lock();
    for (stamp, at) in stamps.into_iter().rev() {
        if !expired(at, now, keep_days) {
            continue;
        }
        match remove(&vault.join(TRASH_DIR).join(&stamp)) {
            Ok(()) => report.moved += 1,
            Err(e) => {
                log::warn!("trash: {stamp} stays in {TRASH_DIR}, the OS Trash refused it: {e}");
                report.kept += 1;
            }
        }
    }
    report
}

/// The OS Trash the launch purge hands old items to. On macOS it asks
/// NSFileManager, which needs no Finder Automation prompt and offers no Put
/// Back.
#[cfg(target_os = "macos")]
fn os_trash() -> trash::TrashContext {
    use trash::macos::{DeleteMethod, TrashContextExtMacos};
    let mut context = trash::TrashContext::new();
    context.set_delete_method(DeleteMethod::NsFileManager);
    context
}

#[cfg(not(target_os = "macos"))]
fn os_trash() -> trash::TrashContext {
    trash::TrashContext::new()
}

/// The launch purge: [`purge_expired`] past [`KEEP_DAYS`], into the OS
/// Trash.
pub fn purge_expired_to_os_trash(vault: &Path, by: &WriteReceipt<System>) -> PurgeReport {
    let context = os_trash();
    purge_expired(
        vault,
        Utc::now(),
        KEEP_DAYS,
        |path| context.delete(path).map_err(|e| e.to_string()),
        by,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::testutil;
    use serde_json::Value;

    const CASES: &str = include_str!("../../fixtures/trash-cases.json");

    fn cases() -> Value {
        serde_json::from_str(CASES).expect("trash-cases.json parses")
    }

    fn human() -> WriteReceipt<Human> {
        WriteReceipt::for_test(super::super::receipt::HUMAN_ACTOR, None)
    }

    fn purger() -> WriteReceipt<System> {
        WriteReceipt::for_test(super::super::receipt::TRASH_PURGE_ACTOR, None)
    }

    fn at(text: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(text)
            .unwrap()
            .with_timezone(&Utc)
    }

    fn seed(vault: &Path, files: &Value) {
        for (rel, bytes) in files.as_object().into_iter().flatten() {
            testutil::write(vault, rel, bytes.as_str().unwrap());
        }
    }

    fn read(vault: &Path, rel: &str) -> String {
        std::fs::read_to_string(vault.join(rel)).unwrap()
    }

    /// Every regular file under `dir`, dot-folders included, with its bytes,
    /// relative and `/`-joined.
    fn tree(dir: &Path) -> Vec<(String, Vec<u8>)> {
        let mut files: Vec<(String, Vec<u8>)> = walkdir::WalkDir::new(dir)
            .into_iter()
            .filter_map(Result::ok)
            .filter(|e| e.file_type().is_file())
            .map(|e| {
                let rel = e.path().strip_prefix(dir).unwrap().to_string_lossy();
                (rel.replace('\\', "/"), std::fs::read(e.path()).unwrap())
            })
            .collect();
        files.sort();
        files
    }

    /// The one stamp dir in `.trash/`.
    fn only_stamp(vault: &Path) -> String {
        let stamps: Vec<String> = std::fs::read_dir(vault.join(TRASH_DIR))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(stamps.len(), 1, "{stamps:?}");
        stamps[0].clone()
    }

    #[test]
    fn the_keep_days_match_the_fixture() {
        let file = cases();
        assert_eq!(file["keep_days"].as_i64(), Some(KEEP_DAYS));
        assert_eq!(file["trash_dir"].as_str(), Some(TRASH_DIR));
        assert_eq!(file["manifest_name"].as_str(), Some(MANIFEST));
    }

    #[test]
    fn replays_the_shared_trash_cases() {
        let file = cases();
        let words = &file["words"];
        assert_eq!(not_a_page("{path}"), words["not_a_page"].as_str().unwrap());
        assert_eq!(already_exists("{path}"), words["exists"].as_str().unwrap());
        assert_eq!(UNREADABLE, words["unreadable"].as_str().unwrap());
        assert_eq!(nothing_at("{stamp}"), words["nothing"].as_str().unwrap());

        for case in file["stamps"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            assert_eq!(parse_stamp(name), case["at"].as_str().map(at), "{name:?}");
        }
        for case in file["minted"].as_array().unwrap() {
            let rng = u16::try_from(case["rng"].as_u64().unwrap()).unwrap();
            assert_eq!(
                new_stamp(at(case["at"].as_str().unwrap()), rng),
                case["name"].as_str().unwrap()
            );
        }
        for case in file["manifests"].as_array().unwrap() {
            let item = &case["item"];
            let manifest = Manifest {
                format: MANIFEST_FORMAT,
                path: item["path"].as_str().unwrap().into(),
                kind: match item["kind"].as_str().unwrap() {
                    "file" => TrashKind::File,
                    _ => TrashKind::Folder,
                },
                title: item["title"].as_str().unwrap().into(),
                deleted_at: item["deleted_at"].as_str().unwrap().into(),
            };
            let bytes = case["bytes"].as_str().unwrap();
            assert_eq!(manifest_bytes(&manifest), bytes);
            assert_eq!(parse_manifest(bytes), Some(manifest));
        }
        for text in file["unreadable_manifests"].as_array().unwrap() {
            assert_eq!(parse_manifest(text.as_str().unwrap()), None, "{text}");
        }
        for case in file["purge"].as_array().unwrap() {
            let stamp = parse_stamp(case["stamp"].as_str().unwrap()).unwrap();
            let now = at(case["now"].as_str().unwrap());
            assert_eq!(
                expired(stamp, now, KEEP_DAYS),
                case["moves"].as_bool().unwrap(),
                "{case}"
            );
        }

        // Deletes, each in a fresh vault.
        for case in file["delete"].as_array().unwrap() {
            let vault = testutil::temp_vault("trash-cases-delete");
            seed(&vault, &file["delete_seed"]);
            let before = tree(&vault);
            let path = case["path"].as_str().unwrap();
            let outcome = move_to_trash(&vault, path, &human());
            match case["refused"].as_str() {
                Some(words) => {
                    assert_eq!(outcome.unwrap_err(), words, "{case}");
                    assert_eq!(tree(&vault), before, "{case}: a refusal moves nothing");
                }
                None => {
                    let item = outcome.unwrap_or_else(|e| panic!("{case}: {e}"));
                    let lands = &case["lands"];
                    assert_eq!(item.path, path);
                    assert_eq!(
                        serde_json::to_value(item.kind).unwrap(),
                        lands["kind"],
                        "{case}"
                    );
                    assert_eq!(item.title, lands["title"].as_str().unwrap(), "{case}");
                    assert_eq!(item.pages, lands["pages"].as_u64(), "{case}");
                    assert!(!vault.join(path).exists());
                    assert_eq!(list_trash(&vault).unwrap()[0], item, "{case}");
                }
            }
            let _ = std::fs::remove_dir_all(&vault);
        }

        // The listing.
        let list = &file["list"];
        let vault = testutil::temp_vault("trash-cases-list");
        seed(&vault, &list["seed"]);
        assert_eq!(
            serde_json::to_value(list_trash(&vault).unwrap()).unwrap(),
            list["items"]
        );
        let _ = std::fs::remove_dir_all(&vault);

        // Restores, each over the listing's seed.
        for case in file["restore"].as_array().unwrap() {
            let vault = testutil::temp_vault("trash-cases-restore");
            seed(&vault, &list["seed"]);
            seed(&vault, &case["occupied"]);
            let before = tree(&vault);
            let stamp = case["stamp"].as_str().unwrap();
            let outcome = restore_from_trash(&vault, stamp, &human());
            match case["refused"].as_str() {
                Some(words) => {
                    let err = outcome.unwrap_err();
                    assert!(err.contains(words), "{case}: {err}");
                    assert_eq!(tree(&vault), before, "{case}: a refusal moves nothing");
                }
                None => {
                    let restored = outcome.unwrap_or_else(|e| panic!("{case}: {e}"));
                    assert_eq!(restored, case["restores"].as_str().unwrap());
                    assert!(vault.join(&restored).exists());
                    assert!(!vault.join(TRASH_DIR).join(stamp).exists(), "{case}");
                    assert!(list_trash(&vault)
                        .unwrap()
                        .iter()
                        .all(|item| item.stamp != stamp));
                }
            }
            let _ = std::fs::remove_dir_all(&vault);
        }
    }

    const PAGE: &str = "---\ntype: Note\n---\n\n# A\n\nBody \u{2014} kept.\n";
    const SIDECAR: &str = "{\n  \"format\": 1,\n  \"threads\": []\n}\n";

    #[test]
    fn delete_then_restore_returns_identical_bytes() {
        let vault = testutil::temp_vault("trash-round-trip");
        testutil::write(&vault, "notes/a.md", PAGE);
        testutil::write(&vault, ".comments/notes/a.md.json", SIDECAR);
        testutil::write(&vault, "folder/b.md", "# B\n");
        testutil::write(&vault, "folder/deep/c.mmd", "graph TD\n");
        testutil::write(&vault, ".comments/folder/b.md.json", SIDECAR);
        let before = tree(&vault);

        let page = move_to_trash(&vault, "notes/a.md", &human()).unwrap();
        let stamp = page.stamp.clone();
        assert_eq!(read(&vault, &format!(".trash/{stamp}/notes/a.md")), PAGE);
        assert_eq!(
            read(&vault, &format!(".trash/{stamp}/.comments/notes/a.md.json")),
            SIDECAR
        );
        assert!(
            !vault.join(".comments/notes").exists(),
            "no empty folder left"
        );
        let manifest = parse_manifest(&read(&vault, &format!(".trash/{stamp}/{MANIFEST}")));
        assert_eq!(
            manifest.map(|m| (m.path, m.kind, m.title)),
            Some(("notes/a.md".into(), TrashKind::File, "A".into()))
        );
        let folder = move_to_trash(&vault, "folder", &human()).unwrap();
        assert_eq!(folder.pages, Some(2));
        assert!(!vault.join("folder").exists());
        assert!(!vault.join(".comments").exists());

        assert_eq!(
            restore_from_trash(&vault, &stamp, &human()).unwrap(),
            "notes/a.md"
        );
        assert_eq!(
            restore_from_trash(&vault, &folder.stamp, &human()).unwrap(),
            "folder"
        );
        assert_eq!(
            tree(&vault),
            before,
            "every byte came back, comments included"
        );
        assert!(list_trash(&vault).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn a_comments_folder_linked_inside_the_vault_is_never_carried() {
        let vault = testutil::temp_vault("trash-comments-link");
        testutil::write(&vault, ".git/hooks/pre-push", "#!/bin/sh\n");
        testutil::write(&vault, "hooks/a.md", PAGE);
        testutil::write(&vault, "notes/a.md", PAGE);
        testutil::write(&vault, ".comments/notes/a.md.json", SIDECAR);
        let page = move_to_trash(&vault, "notes/a.md", &human()).unwrap();
        assert!(!vault.join(".comments").exists());

        // `.comments -> .git`: trashing `hooks` must not take `.git/hooks`.
        std::os::unix::fs::symlink(vault.join(".git"), vault.join(".comments")).unwrap();
        let folder = move_to_trash(&vault, "hooks", &human()).unwrap();
        assert_eq!(read(&vault, ".git/hooks/pre-push"), "#!/bin/sh\n");
        assert!(!vault
            .join(format!(".trash/{}/.comments", folder.stamp))
            .exists());

        // `.comments -> knowledge`: a restore leaves its sidecar in the Trash.
        std::fs::remove_file(vault.join(".comments")).unwrap();
        std::fs::create_dir_all(vault.join("knowledge")).unwrap();
        std::os::unix::fs::symlink(vault.join("knowledge"), vault.join(".comments")).unwrap();
        restore_from_trash(&vault, &page.stamp, &human()).unwrap();
        assert_eq!(read(&vault, "notes/a.md"), PAGE);
        assert!(!vault.join("knowledge/notes").exists());
        assert_eq!(
            read(
                &vault,
                &format!(".trash/{}/.comments/notes/a.md.json", page.stamp)
            ),
            SIDECAR
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn restore_refuses_to_overwrite() {
        let vault = testutil::temp_vault("trash-overwrite");
        testutil::write(&vault, "notes/a.md", PAGE);
        let item = move_to_trash(&vault, "notes/a.md", &human()).unwrap();
        testutil::write(&vault, "notes/a.md", "# Someone else\n");
        let before = tree(&vault);
        assert_eq!(
            restore_from_trash(&vault, &item.stamp, &human()).unwrap_err(),
            already_exists("notes/a.md")
        );
        assert_eq!(tree(&vault), before, "both files unchanged");
        assert_eq!(read(&vault, "notes/a.md"), "# Someone else\n");
        assert_eq!(
            read(&vault, &format!(".trash/{}/notes/a.md", item.stamp)),
            PAGE
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn a_restored_page_keeps_the_trash_copy_of_comments_a_new_page_holds() {
        let vault = testutil::temp_vault("trash-sidecar-taken");
        testutil::write(&vault, "notes/a.md", PAGE);
        testutil::write(&vault, ".comments/notes/a.md.json", SIDECAR);
        let item = move_to_trash(&vault, "notes/a.md", &human()).unwrap();
        let newer = "{\n  \"format\": 1,\n  \"threads\": [{\"comments\": []}]\n}\n";
        testutil::write(&vault, ".comments/notes/a.md.json", newer);
        restore_from_trash(&vault, &item.stamp, &human()).unwrap();
        assert_eq!(read(&vault, "notes/a.md"), PAGE);
        assert_eq!(read(&vault, ".comments/notes/a.md.json"), newer);
        assert_eq!(
            read(
                &vault,
                &format!(".trash/{}/.comments/notes/a.md.json", item.stamp)
            ),
            SIDECAR
        );
        assert!(
            list_trash(&vault).unwrap().is_empty(),
            "nothing left to restore"
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn a_trashed_page_is_outside_scan_and_folder_listing() {
        let vault = testutil::temp_vault("trash-hidden");
        testutil::write(&vault, "notes/a.md", PAGE);
        testutil::write(&vault, "notes/b.md", "# B\n");
        move_to_trash(&vault, "notes/a.md", &human()).unwrap();
        let paths: Vec<String> = crate::vault::scan::scan_vault(&vault)
            .unwrap()
            .into_iter()
            .map(|e| e.path)
            .collect();
        assert_eq!(paths, vec!["notes/b.md".to_string()]);
        let folders = crate::vault::scan::list_folders(&vault).unwrap();
        assert_eq!(folders, vec!["notes".to_string()]);
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn stamps_sort_by_time_and_never_collide() {
        let earlier = new_stamp(at("2026-10-14T09:30:00Z"), 0xffff);
        let later = new_stamp(at("2026-10-14T09:30:01Z"), 0x0000);
        assert!(earlier < later, "a stamp sorts by its second first");
        let vault = testutil::temp_vault("trash-collide");
        for n in 0..20 {
            testutil::write(&vault, &format!("notes/{n}.md"), "# N\n");
        }
        let stamps: std::collections::BTreeSet<String> = (0..20)
            .map(|n| {
                move_to_trash(&vault, &format!("notes/{n}.md"), &human())
                    .unwrap()
                    .stamp
            })
            .collect();
        assert_eq!(stamps.len(), 20, "twenty deletes, twenty stamp dirs");
        let listed: Vec<String> = list_trash(&vault)
            .unwrap()
            .into_iter()
            .map(|item| item.stamp)
            .collect();
        let mut newest_first: Vec<String> = stamps.into_iter().collect();
        newest_first.reverse();
        assert_eq!(listed, newest_first);
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn an_item_without_a_manifest_lists_as_unreadable_and_never_restores() {
        let vault = testutil::temp_vault("trash-unreadable");
        testutil::write(&vault, "notes/a.md", PAGE);
        let item = move_to_trash(&vault, "notes/a.md", &human()).unwrap();
        std::fs::remove_file(vault.join(format!(".trash/{}/{MANIFEST}", item.stamp))).unwrap();
        let listed = list_trash(&vault).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].kind, TrashKind::Unreadable);
        assert_eq!(listed[0].path, format!(".trash/{}", item.stamp));
        assert_eq!(listed[0].pages, None);
        assert_eq!(
            restore_from_trash(&vault, &item.stamp, &human()).unwrap_err(),
            UNREADABLE
        );
        assert!(!vault.join("notes/a.md").exists());
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn non_stamp_entries_are_ignored_and_never_purged() {
        let vault = testutil::temp_vault("trash-foreign");
        testutil::write(&vault, ".trash/old-note.md", "Obsidian's\n");
        testutil::write(&vault, ".trash/Some folder/a.md", "# A\n");
        assert!(list_trash(&vault).unwrap().is_empty());
        let mut handed = Vec::new();
        let report = purge_expired(
            &vault,
            at("2099-01-01T00:00:00Z"),
            KEEP_DAYS,
            |path| {
                handed.push(path.to_path_buf());
                Ok(())
            },
            &purger(),
        );
        assert_eq!(report, PurgeReport::default());
        assert!(handed.is_empty());
        let _ = std::fs::remove_dir_all(&vault);
    }

    fn stamped(vault: &Path, stamp: &str) {
        testutil::write(
            vault,
            &format!(".trash/{stamp}/notes/{stamp}.md"),
            "# Old\n",
        );
        let manifest = Manifest {
            format: MANIFEST_FORMAT,
            path: format!("notes/{stamp}.md"),
            kind: TrashKind::File,
            title: "Old".into(),
            deleted_at: rfc3339(parse_stamp(stamp).unwrap()),
        };
        testutil::write(
            vault,
            &format!(".trash/{stamp}/{MANIFEST}"),
            &manifest_bytes(&manifest),
        );
    }

    #[test]
    fn purge_moves_only_items_past_thirty_days() {
        let vault = testutil::temp_vault("trash-purge");
        let now = at("2026-10-14T09:30:00Z");
        let old = new_stamp(now - chrono::Duration::days(31), 1);
        let kept = new_stamp(now - chrono::Duration::days(29), 2);
        stamped(&vault, &old);
        stamped(&vault, &kept);
        // The stamp decides, never mtime: the old dir was written just now.
        let mut handed = Vec::new();
        let report = purge_expired(
            &vault,
            now,
            KEEP_DAYS,
            |path| {
                handed.push(path.to_path_buf());
                std::fs::remove_dir_all(path).map_err(|e| e.to_string())
            },
            &purger(),
        );
        assert_eq!(report, PurgeReport { moved: 1, kept: 0 });
        assert_eq!(handed, vec![vault.join(TRASH_DIR).join(&old)]);
        let listed: Vec<String> = list_trash(&vault)
            .unwrap()
            .into_iter()
            .map(|i| i.stamp)
            .collect();
        assert_eq!(listed, vec![kept]);
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn purge_keeps_an_item_the_os_trash_refused() {
        let vault = testutil::temp_vault("trash-purge-refused");
        let now = at("2026-10-14T09:30:00Z");
        let old = new_stamp(now - chrono::Duration::days(40), 3);
        stamped(&vault, &old);
        let report = purge_expired(
            &vault,
            now,
            KEEP_DAYS,
            |_| Err("the Trash said no".into()),
            &purger(),
        );
        assert_eq!(report, PurgeReport { moved: 0, kept: 1 });
        assert_eq!(list_trash(&vault).unwrap()[0].stamp, old);
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[cfg(unix)]
    #[test]
    fn a_trash_linked_out_of_the_vault_is_refused() {
        let vault = testutil::temp_vault("trash-linked");
        let outside = testutil::temp_vault("trash-linked-outside");
        testutil::write(&vault, "notes/a.md", PAGE);
        std::os::unix::fs::symlink(&outside, vault.join(TRASH_DIR)).unwrap();
        let err = move_to_trash(&vault, "notes/a.md", &human()).unwrap_err();
        assert!(err.contains("escapes the vault"), "{err}");
        assert_eq!(read(&vault, "notes/a.md"), PAGE);
        assert!(tree(&outside).is_empty(), "nothing landed outside");
        assert!(
            list_trash(&vault).is_err(),
            "a Trash outside the vault is no Trash"
        );
        for dir in [&vault, &outside] {
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    #[test]
    fn restore_refuses_knowledge_and_hidden_targets() {
        let vault = testutil::temp_vault("trash-targets");
        let stamp = "20261014T093000Z-a1b2";
        for (target, words) in [
            ("knowledge/a.md", "read-only"),
            (".git/a.md", UNREADABLE),
            ("notes/../../a.md", UNREADABLE),
        ] {
            let _ = std::fs::remove_dir_all(vault.join(TRASH_DIR));
            testutil::write(&vault, &format!(".trash/{stamp}/a.md"), "# A\n");
            let manifest = format!(
                "{{\"format\":1,\"path\":\"{target}\",\"kind\":\"file\",\"title\":\"A\",\
                 \"deleted_at\":\"2026-10-14T09:30:00Z\"}}"
            );
            testutil::write(&vault, &format!(".trash/{stamp}/{MANIFEST}"), &manifest);
            let before = tree(&vault);
            let err = restore_from_trash(&vault, stamp, &human()).unwrap_err();
            assert!(err.contains(words), "{target}: {err}");
            assert_eq!(tree(&vault), before, "{target}");
        }
        let _ = std::fs::remove_dir_all(&vault);
    }

    /// The name of the last `fn` declared before byte `at`.
    fn fn_at(source: &str, at: usize) -> String {
        let start = source[..at].rfind("fn ").expect("inside a fn");
        source[start + 3..]
            .chars()
            .take_while(|c| c.is_alphanumeric() || *c == '_')
            .collect()
    }

    // CV-37: nothing under vault/ unlinks a page. The only removals are the
    // write funnel's temps, the janitor's crashed temps, a stamp dir's
    // manifest and empty folders (`remove_dir`, which fails on anything
    // else); the OS Trash takes only the purge's stamp dirs and an orphan
    // sidecar a rename clears.
    #[test]
    fn no_vault_writer_unlinks_a_page() {
        const ALLOWED: &[(&str, &str, &str)] = &[
            ("write.rs", "remove_file", "write_file"),
            ("write.rs", "remove_file", "clean_orphan_temps"),
            ("trash.rs", "remove_file", "remove_manifest"),
            ("write.rs", "trash::delete", "rename_note"),
            ("trash.rs", ".delete(path)", "purge_expired_to_os_trash"),
            // M60.6: a rollback removes the batch's own staged temps, never
            // a page; a created page goes to the Trash.
            ("batch.rs", "remove_file", "roll_back"),
            // M66.6: cleanup is armed only after exclusive staging creation
            // and accepts only its fixed hidden prefix plus a nonce. It never
            // removes the installed attachment or an authored page.
            ("attachments.rs", "remove_file", "remove_staged"),
            ("attachments.rs", "libc::unlinkat", "remove_staged"),
            // M93.9: the private app-data journal removes only its two fixed
            // unpublished setup filenames while holding service ownership.
            // It never removes the installed DB, a recovery copy or a page.
            ("recovery.rs", "remove_file", "install"),
        ];
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/vault");
        let mut found = Vec::new();
        for entry in std::fs::read_dir(&dir).unwrap() {
            let path = entry.unwrap().path();
            let name = path.file_name().unwrap().to_string_lossy().into_owned();
            if !name.ends_with(".rs") || name == "testutil.rs" {
                continue;
            }
            let text = std::fs::read_to_string(&path).unwrap();
            // An out-of-line test module carries its own compile-time
            // exclusion, as the receipt guard reads it (receipt.rs).
            if text.starts_with("#![cfg(test)]\n") {
                continue;
            }
            let production = text
                .find("#[cfg(test)]\nmod tests")
                .map_or(text.as_str(), |cut| &text[..cut]);
            let mut offset = 0;
            for line in production.split_inclusive('\n') {
                let code = line.split("//").next().unwrap_or_default();
                for needle in [
                    "remove_file",
                    "remove_dir_all",
                    "trash::delete",
                    ".delete(path)",
                    "libc::unlinkat",
                ] {
                    if let Some(i) = code.find(needle) {
                        found.push((name.clone(), needle, fn_at(production, offset + i)));
                    }
                }
                offset += line.len();
            }
        }
        for (file, needle, function) in &found {
            assert!(
                ALLOWED
                    .iter()
                    .any(|(f, n, func)| f == file && n == needle && func == function),
                "{file}: {needle} in {function} may unlink a page"
            );
        }
        assert!(found
            .iter()
            .any(|(f, n, _)| f == "trash.rs" && *n == "remove_file"));
    }

    // --- Crash harness (CI's Linux job; the Mac skips `crash`) --------------

    const CRASH_STAMP: &str = "20261014T093000Z-c0de";

    /// Child: trash `notes/a.md`, or restore `CRASH_STAMP` when the armed
    /// point is a restore's.
    #[test]
    #[ignore = "crash-scenario child body, spawned by the crash tests"]
    fn crash_scenario_trash() {
        let Ok(vault) = std::env::var("CEREBRO_CRASH_VAULT") else {
            return;
        };
        let vault = PathBuf::from(vault);
        let point = std::env::var("CEREBRO_CRASH_POINT").unwrap_or_default();
        if point.starts_with("untrash") {
            let _ = restore_from_trash(&vault, CRASH_STAMP, &human());
        } else {
            let _ = move_to_trash(&vault, "notes/a.md", &human());
        }
    }

    fn crash_vault(label: &str) -> PathBuf {
        let vault = testutil::temp_vault(label);
        testutil::write(&vault, "notes/a.md", PAGE);
        testutil::write(&vault, ".comments/notes/a.md.json", SIDECAR);
        vault
    }

    #[test]
    fn crash_trash_between_manifest_and_move_leaves_the_page() {
        let vault = crash_vault("trash-crash-manifest");
        let status = testutil::run_crash_scenario(
            "vault::trash::tests::crash_scenario_trash",
            "trash-manifest-written",
            &vault,
        );
        assert!(!status.success(), "the child dies at the point");
        assert_eq!(read(&vault, "notes/a.md"), PAGE);
        assert_eq!(read(&vault, ".comments/notes/a.md.json"), SIDECAR);
        assert!(
            list_trash(&vault).unwrap().is_empty(),
            "a manifest alone lists nothing"
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn crash_trash_after_move_lists_the_item() {
        let vault = crash_vault("trash-crash-moved");
        let status = testutil::run_crash_scenario(
            "vault::trash::tests::crash_scenario_trash",
            "trash-moved",
            &vault,
        );
        assert!(!status.success());
        assert!(!vault.join("notes/a.md").exists());
        let listed = list_trash(&vault).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].path, "notes/a.md");
        let stamp = only_stamp(&vault);
        assert_eq!(read(&vault, &format!(".trash/{stamp}/notes/a.md")), PAGE);
        // The sidecar had not moved yet: M70.2's orphan, which a later page
        // created at this path has cleared on its rename.
        assert_eq!(read(&vault, ".comments/notes/a.md.json"), SIDECAR);
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn crash_untrash_after_move_lists_nothing() {
        let vault = testutil::temp_vault("trash-crash-untrash");
        testutil::write(&vault, &format!(".trash/{CRASH_STAMP}/notes/a.md"), PAGE);
        let manifest = Manifest {
            format: MANIFEST_FORMAT,
            path: "notes/a.md".into(),
            kind: TrashKind::File,
            title: "A".into(),
            deleted_at: "2026-10-14T09:30:00Z".into(),
        };
        testutil::write(
            &vault,
            &format!(".trash/{CRASH_STAMP}/{MANIFEST}"),
            &manifest_bytes(&manifest),
        );
        let status = testutil::run_crash_scenario(
            "vault::trash::tests::crash_scenario_trash",
            "untrash-moved",
            &vault,
        );
        assert!(!status.success());
        assert_eq!(read(&vault, "notes/a.md"), PAGE);
        assert!(list_trash(&vault).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&vault);
    }
}
