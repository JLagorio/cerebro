//! The batch writer (M60.6): a database-wide change lands whole or not at
//! all.
//!
//! A property rename, a kind change, a property copy or a bulk delete writes
//! many pages. One `write_file` per page left a half-renamed database behind
//! any failure halfway. A batch is checked whole first, under every path
//! lock it touches; then journaled in runtime.db with every page's
//! pre-image (`runtime::batch_journal`), staged temp by temp, and only then
//! renamed into place. The journal row's delete is the commit point. A batch
//! that fails after its row exists is put back in process; one a crash or a
//! quit stopped is put back at the next launch (`recover`).
//!
//! Ops arrive as JSON (`parse_ops`), tagged by `op` in snake case with
//! camelCase fields:
//!
//! - `import {system, recordId, url?, path, content}`: one stamped copy per
//!   source identity. The import mutex is held before path locks; a single
//!   vault walk plans creates or checked replacements. Edited copies stay.
//! - `patch {path, set, expectHash?}`: a frontmatter patch, as
//!   `update_frontmatter` applies it.
//! - `create {path, content}`: a new page, its whole bytes.
//! - `body {path, body, expectHash?}`: a new body under the page's own
//!   frontmatter, as `save_note` composes it.
//! - `delete {path, expectHash?}`: the page and its comments to the vault's
//!   Trash (`trash::trash_locked`).
//! - `restore {path, stamp}`: a Trash item back to `path`
//!   (`trash::untrash_locked`).
//! - `replace_file {path, content, expectHash}`: byte-exact, checked replacement.
//!   It is the only write on its path.
//! - `rename {from, to}`: a page or folder and its comments, in request
//!   order after every write. The journal carries both names.
//! - `revert {path, afterHash?, before?, keys?, trashed?, restored?}`: undo
//!   (M60.7), built from one `FileResult` of an earlier change. A page that
//!   change trashed comes back from its stamp, unless its path is taken or
//!   the item left the Trash. A page it created or restored goes to the
//!   Trash, and a page it rewrote gets `before` back, only while the page
//!   still holds `afterHash`. A rewritten page that changed since reverts
//!   key by key when the change patched frontmatter alone: a key still
//!   holding its after value takes its before value, and the rest stay as
//!   they are, named in `FileResult.skipped` (a page now gone skips whole).
//!   Anything else that changed since refuses the whole change as `Stale`
//!   (D2 (c)). Its result holds what it overwrote, so redo is the revert of
//!   undo's result.
//!
//! Checks, in order, before anything is written: the count, each op's
//! words, each write path as a note (`note_join`, markdown only) outside
//! knowledge/, the per-path order (patch and body apply in order; a create
//! or restore comes first and once; delete, revert and replace_file stand alone), the
//! journal,
//! then under the locks: each page read, its existence and Trash
//! preconditions, every `expectHash` (D2 (c): a mismatch is `Stale`, M55.3),
//! the new bytes from the writers' own pure helpers, and the byte cap. A
//! page whose bytes would not change is not written. Any refusal leaves
//! every byte, mtime, temp, journal row and `vault_writes` row as it was.
//!
//! Mirrored by the mock (`src/lib/mockIpc.ts` `applyBatch`); both replay
//! `src-tauri/fixtures/batch-cases.json`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::{Map, Value};

use super::receipt::{Door, Human, System, WriteReceipt};
use super::trash;
use super::write::{self, PathLock, StaleContent};
use crate::runtime::batch_journal::{self, JournalFile};

/// The most ops one change may hold (Q15). batch-cases.json's `limits`.
pub const MAX_BATCH_OPS: usize = 2000;
/// The most bytes one change may hold, pre-images and new bytes together
/// (Q15). batch-cases.json's `limits`.
pub const MAX_BATCH_BYTES: usize = 16 * 1024 * 1024;

/// The words a change over its byte cap refuses with.
pub const TOO_LARGE: &str = "A change can hold at most 16 MiB of pages, so nothing was written.";

/// The words a change over its op cap refuses with.
pub fn too_many(n: usize) -> String {
    format!("A change can hold at most {MAX_BATCH_OPS} steps; this one has {n}, so nothing was written.")
}

/// The words an op that can't be read refuses with: `n` counts from 1.
fn unreadable(n: usize, what: &str) -> String {
    format!("Step {n} can't be read: {what}.")
}

fn not_first(path: &str) -> String {
    format!(
        "{path}: a create or restore must be the first step on its page, so nothing was written."
    )
}

fn not_alone(path: &str) -> String {
    format!("{path}: a delete must be the only step on its page, so nothing was written.")
}

fn revert_not_alone(path: &str) -> String {
    format!("{path}: a revert must be the only step on its page, so nothing was written.")
}

fn missing(path: &str) -> String {
    format!("{path} doesn't exist, so nothing was written.")
}

fn exists(path: &str) -> String {
    format!("{path} already exists, so nothing was written.")
}

fn wrong_item(stamp: &str, held: &str, path: &str) -> String {
    format!("The Trash item at {stamp} is {held}, not {path}, so nothing was written.")
}

/// The words a stale `expectHash` refuses the change with (D2 (c)): the
/// IPC answers these, and records one operational `stale_content` row.
pub fn stale_words(path: &str) -> String {
    format!("stale_content: {path} changed since this change was prepared, so nothing was written.")
}

/// The words a change with no journal refuses with.
pub fn no_journal() -> String {
    format!(
        "Couldn't start the change: {}, so nothing was written.",
        batch_journal::UNAVAILABLE
    )
}

/// A failure after the journal row, put back in process.
fn rolled_back(error: &str) -> String {
    format!("Couldn't finish the change, so every page was put back: {error}")
}

/// A failure after the journal row whose rollback failed too: the row stays
/// for the next launch.
fn left_for_next_open(error: &str) -> String {
    format!(
        "Couldn't finish the change: {error}. Some pages couldn't be put back yet; Cerebro \
         puts them back when it next opens this vault."
    )
}

/// One op, read.
#[derive(Debug, Clone, PartialEq)]
pub enum BatchOp {
    Import(crate::import::plan::Request),
    Patch {
        path: String,
        set: Map<String, Value>,
        expect: Option<String>,
    },
    Create {
        path: String,
        content: String,
    },
    Body {
        path: String,
        body: String,
        expect: Option<String>,
    },
    Delete {
        path: String,
        expect: Option<String>,
    },
    Restore {
        path: String,
        stamp: String,
    },
    ReplaceFile {
        path: String,
        content: String,
        expect: String,
    },
    Rename {
        from: String,
        to: String,
    },
    /// Undo of one page of an earlier change (M60.7): see the module doc.
    Revert {
        path: String,
        after_hash: Option<String>,
        before: Option<String>,
        keys: Vec<KeyChange>,
        trashed: Option<String>,
        restored: Option<String>,
    },
}

/// What a revert does to its page, read from the result it was built from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Revert<'a> {
    /// The change trashed the page: it comes back from this stamp.
    Untrash(&'a str),
    /// The change created or restored the page: it goes to the Trash.
    Retrash,
    /// The change rewrote the page: `before` comes back.
    Rewrite,
}

impl BatchOp {
    pub fn path(&self) -> &str {
        match self {
            BatchOp::Patch { path, .. }
            | BatchOp::Create { path, .. }
            | BatchOp::Body { path, .. }
            | BatchOp::Delete { path, .. }
            | BatchOp::Restore { path, .. }
            | BatchOp::Revert { path, .. }
            | BatchOp::ReplaceFile { path, .. } => path,
            BatchOp::Rename { from, .. } => from,
            BatchOp::Import(request) => &request.path,
        }
    }

    fn expect(&self) -> Option<&str> {
        match self {
            BatchOp::Patch { expect, .. }
            | BatchOp::Body { expect, .. }
            | BatchOp::Delete { expect, .. } => expect.as_deref(),
            BatchOp::ReplaceFile { expect, .. } => Some(expect),
            BatchOp::Create { .. }
            | BatchOp::Restore { .. }
            | BatchOp::Revert { .. }
            | BatchOp::Rename { .. }
            | BatchOp::Import(_) => None,
        }
    }

    fn starts_a_page(&self) -> bool {
        matches!(
            self,
            BatchOp::Create { .. } | BatchOp::Restore { .. } | BatchOp::Revert { .. }
        )
    }

    fn revert(&self) -> Option<Revert<'_>> {
        match self {
            BatchOp::Revert {
                trashed: Some(stamp),
                ..
            } => Some(Revert::Untrash(stamp)),
            BatchOp::Revert {
                restored: Some(_), ..
            }
            | BatchOp::Revert { before: None, .. } => Some(Revert::Retrash),
            BatchOp::Revert { .. } => Some(Revert::Rewrite),
            _ => None,
        }
    }

    /// The stamp this op takes from the Trash: a restore's, or a revert of a
    /// trashed page's.
    fn own_stamp(&self) -> Option<&str> {
        match (self, self.revert()) {
            (BatchOp::Restore { stamp, .. }, _) => Some(stamp),
            (_, Some(Revert::Untrash(stamp))) => Some(stamp),
            _ => None,
        }
    }
}

/// One frontmatter key a patch changed, before and after, as JSON.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct KeyChange {
    pub key: String,
    pub before: Value,
    pub after: Value,
}

/// The keys a revert left as they are because they changed since (M60.7),
/// and `reason: "gone"` when the whole page was gone.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Skipped {
    pub keys: Vec<String>,
    pub reason: Option<&'static str>,
}

/// One page a batch wrote, paired with what undo needs (M60.7): the bytes
/// it held before (`None` when it was absent), both hashes (`after_hash`
/// `None` when it went to the Trash), each patched key's change, the Trash
/// stamp a delete moved it into or a restore took it from, and what a revert
/// left alone. A page a revert skipped whole is listed with nothing written.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileResult {
    pub path: String,
    pub before_hash: Option<String>,
    pub after_hash: Option<String>,
    pub before: Option<String>,
    pub keys: Vec<KeyChange>,
    pub trashed: Option<String>,
    pub restored: Option<String>,
    pub skipped: Option<Skipped>,
    /// A rename's source; ordinary writes omit this key.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub moved_from: Option<String>,
}

/// A landed batch: its id and one result per page it wrote, in the order
/// each page first appears in the ops.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchApplied {
    pub batch_id: String,
    pub files: Vec<FileResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub imports: Option<Vec<crate::import::plan::ImportResult>>,
}

/// Why a batch wrote nothing: an `expectHash` that no longer holds, or a
/// refusal in words.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BatchError {
    Stale(StaleContent),
    Refused(String),
}

impl From<String> for BatchError {
    fn from(message: String) -> Self {
        BatchError::Refused(message)
    }
}

/// What a launch's rollback did: the pages of unfinished batches, the ones
/// put back as they were, and the ones left alone because they changed
/// since.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct RecoveryReport {
    pub unfinished: usize,
    pub restored: usize,
    pub kept: usize,
}

// --- Parsing -------------------------------------------------------------------

/// The keys each op takes.
fn keys_of(op: &str) -> Option<&'static [&'static str]> {
    Some(match op {
        "import" => &["op", "system", "recordId", "url", "path", "content"],
        "patch" => &["op", "path", "set", "expectHash"],
        "create" => &["op", "path", "content"],
        "body" => &["op", "path", "body", "expectHash"],
        "delete" => &["op", "path", "expectHash"],
        "restore" => &["op", "path", "stamp"],
        "replace_file" => &["op", "path", "content", "expectHash"],
        "rename" => &["op", "from", "to"],
        "revert" => &[
            "op",
            "path",
            "afterHash",
            "before",
            "keys",
            "trashed",
            "restored",
        ],
        _ => return None,
    })
}

/// Read every op, pinning each word: the first that can't be read refuses
/// the whole change, named by its place (from 1).
pub fn parse_ops(values: &[Value]) -> Result<Vec<BatchOp>, String> {
    values
        .iter()
        .enumerate()
        .map(|(i, value)| parse_op(i + 1, value))
        .collect()
}

fn parse_op(n: usize, value: &Value) -> Result<BatchOp, String> {
    let object = value
        .as_object()
        .ok_or_else(|| unreadable(n, "it is not an object"))?;
    let op = object.get("op").and_then(Value::as_str).unwrap_or_default();
    let allowed = keys_of(op).ok_or_else(|| {
        unreadable(
            n,
            "its op must be patch, create, body, delete, restore, revert, rename, replace_file or import",
        )
    })?;
    if let Some(key) = object.keys().find(|key| !allowed.contains(&key.as_str())) {
        return Err(unreadable(n, &format!("{key} is not part of a {op} step")));
    }
    let text = |key: &str| -> Result<String, String> {
        object
            .get(key)
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| unreadable(n, &format!("{key} must be text")))
    };
    if op == "rename" {
        return Ok(BatchOp::Rename {
            from: text("from")?,
            to: text("to")?,
        });
    }
    let path = text("path")?;
    let hash_at = |key: &str| -> Result<Option<String>, String> {
        match object.get(key) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(hash))
                if hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit()) =>
            {
                Ok(Some(hash.to_ascii_lowercase()))
            }
            Some(_) => Err(unreadable(n, &format!("{key} must be a 64-character hash"))),
        }
    };
    let expect = || hash_at("expectHash");
    let maybe_text = |key: &str| -> Result<Option<String>, String> {
        match object.get(key) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(text)) => Ok(Some(text.clone())),
            Some(_) => Err(unreadable(n, &format!("{key} must be text"))),
        }
    };
    Ok(match op {
        "import" => BatchOp::Import(crate::import::plan::Request {
            system: text("system")?,
            record_id: text("recordId")?,
            url: maybe_text("url")?,
            path,
            content: text("content")?,
        }),
        "patch" => {
            let set = object
                .get("set")
                .and_then(Value::as_object)
                .cloned()
                .ok_or_else(|| unreadable(n, "set must be an object"))?;
            BatchOp::Patch {
                path,
                set,
                expect: expect()?,
            }
        }
        "create" => BatchOp::Create {
            path,
            content: text("content")?,
        },
        "body" => BatchOp::Body {
            path,
            body: text("body")?,
            expect: expect()?,
        },
        "delete" => BatchOp::Delete {
            path,
            expect: expect()?,
        },
        "replace_file" => BatchOp::ReplaceFile {
            path,
            content: text("content")?,
            expect: expect()?
                .ok_or_else(|| unreadable(n, "expectHash must be a 64-character hash"))?,
        },
        "restore" => BatchOp::Restore {
            path,
            stamp: text("stamp")?,
        },
        _ => {
            let after_hash = hash_at("afterHash")?;
            let before = maybe_text("before")?;
            let trashed = maybe_text("trashed")?;
            let restored = maybe_text("restored")?;
            if trashed.is_none() && after_hash.is_none() {
                return Err(unreadable(n, "afterHash must be a 64-character hash"));
            }
            let keys = match object.get("keys") {
                None | Some(Value::Null) => Vec::new(),
                Some(Value::Array(items)) => items
                    .iter()
                    .map(|item| {
                        let key = item.get("key").and_then(Value::as_str);
                        match (key, item.as_object()) {
                            (Some(key), Some(change)) => Ok(KeyChange {
                                key: key.to_string(),
                                before: change.get("before").cloned().unwrap_or(Value::Null),
                                after: change.get("after").cloned().unwrap_or(Value::Null),
                            }),
                            _ => Err(unreadable(n, "each of keys must name its key")),
                        }
                    })
                    .collect::<Result<_, _>>()?,
                Some(_) => return Err(unreadable(n, "keys must be a list")),
            };
            BatchOp::Revert {
                path,
                after_hash,
                before,
                keys,
                trashed,
                restored,
            }
        }
    })
}

// --- Planning ------------------------------------------------------------------

/// The ops on one page, in order, and the Trash stamp the page may move
/// through.
struct Page {
    path: String,
    abs: PathBuf,
    ops: Vec<BatchOp>,
    /// A delete's fresh stamp, a restore's own, or the stamp a created page
    /// goes to if the batch is put back.
    stamp: Option<String>,
}

impl Page {
    fn first(&self) -> &BatchOp {
        &self.ops[0]
    }

    fn sidecar(&self) -> Option<String> {
        super::comments::carried_rel(&self.path, false)
    }
}

/// What the batch will do to one page.
struct Planned {
    path: String,
    abs: PathBuf,
    before: Option<String>,
    after: Option<String>,
    keys: Vec<KeyChange>,
    trashed: Option<String>,
    restored: Option<String>,
    /// Where a page that is written stages its bytes, vault-relative.
    temp: Option<String>,
    /// The `vault_writes` kind its staged write records after the commit.
    kind: Option<&'static str>,
    sidecar: Option<String>,
    rollback_stamp: Option<String>,
    /// What a revert left as it was.
    skipped: Option<Skipped>,
    moved_from: Option<String>,
}

impl Planned {
    /// Whether the batch writes or moves this page: a page a revert only
    /// skipped is reported, never journaled or touched.
    fn touches(&self) -> bool {
        self.temp.is_some()
            || self.trashed.is_some()
            || self.restored.is_some()
            || self.moved_from.is_some()
    }

    fn journal(&self) -> JournalFile {
        JournalFile {
            path: self.path.clone(),
            temp: self.temp.clone(),
            before: self.before.clone(),
            before_hash: self.before.as_deref().map(hash),
            after_hash: self.after.as_deref().map(hash),
            trashed: self.trashed.clone(),
            restored: self.restored.clone(),
            sidecar: self.sidecar.clone(),
            moved_from: self.moved_from.clone(),
        }
    }

    fn result(&self) -> FileResult {
        FileResult {
            path: self.path.clone(),
            before_hash: self.before.as_deref().map(hash),
            after_hash: self.after.as_deref().map(hash),
            before: self.before.clone(),
            keys: self.keys.clone(),
            trashed: self.trashed.clone(),
            restored: self.restored.clone(),
            skipped: self.skipped.clone(),
            moved_from: self.moved_from.clone(),
        }
    }
}

fn hash(text: &str) -> String {
    crate::ledger::sha256_hex(text.as_bytes())
}

/// Group the ops by page, first appearance first, and hold each page to the
/// per-path order.
fn pages(vault: &Path, ops: Vec<BatchOp>) -> Result<Vec<Page>, String> {
    let mut pages: Vec<Page> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    for op in ops {
        // Two spellings of one page are one page.
        let key = write::landing_path(vault, op.path()).unwrap_or_else(|| op.path().to_string());
        match index.get(&key) {
            Some(&at) => pages[at].ops.push(op),
            None => {
                index.insert(key, pages.len());
                pages.push(Page {
                    path: op.path().to_string(),
                    abs: vault.join(op.path()),
                    ops: vec![op],
                    stamp: None,
                });
            }
        }
    }
    for page in &pages {
        if page.ops.len() > 1
            && page
                .ops
                .iter()
                .any(|op| matches!(op, BatchOp::ReplaceFile { .. }))
        {
            return Err(format!("{}: a replace_file must be the only write step on its page, so nothing was written.", page.path));
        }
        let reverts = page.ops.iter().any(|op| op.revert().is_some());
        if reverts && page.ops.len() > 1 {
            return Err(revert_not_alone(&page.path));
        }
        if page.ops.iter().skip(1).any(BatchOp::starts_a_page) {
            return Err(not_first(&page.path));
        }
        let deletes = page
            .ops
            .iter()
            .any(|op| matches!(op, BatchOp::Delete { .. }));
        if deletes && page.ops.len() > 1 {
            return Err(not_alone(&page.path));
        }
    }
    Ok(pages)
}

/// The keys `lock_paths` takes for the batch: every page, and for a page
/// that may move through the Trash its sidecar and its stamp's manifest.
fn lock_keys(pages: &[Page]) -> Vec<String> {
    let mut keys = Vec::new();
    for page in pages {
        keys.push(page.path.clone());
        if let Some(stamp) = &page.stamp {
            if let Some(side) = page.sidecar() {
                keys.push(side);
            }
            keys.push(trash::manifest_rel(stamp));
        }
    }
    keys
}

/// A fresh Trash stamp for each page that needs one, none of them taken.
fn mint_stamps(vault: &Path, pages: &mut [Page]) {
    let mut taken: Vec<String> = Vec::new();
    for page in pages.iter_mut() {
        let first = page.first();
        let fresh = matches!(first, BatchOp::Delete { .. } | BatchOp::Create { .. })
            || first.revert() == Some(Revert::Retrash);
        page.stamp = match first.own_stamp() {
            Some(stamp) => Some(stamp.to_string()),
            None if fresh => {
                let mut stamp = trash::new_stamp(Utc::now(), rand::random::<u16>());
                while taken.contains(&stamp) || vault.join(trash::TRASH_DIR).join(&stamp).exists() {
                    stamp = trash::new_stamp(Utc::now(), rand::random::<u16>());
                }
                taken.push(stamp.clone());
                Some(stamp)
            }
            _ => None,
        };
    }
}

/// Read a page, `None` when it is absent.
fn read_page(path: &str, abs: &Path) -> Result<Option<String>, String> {
    match std::fs::read_to_string(abs) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("{path}: {e}")),
    }
}

/// A frontmatter key's value in `text`, as JSON; null when the page, its
/// frontmatter or the key is absent.
fn key_value(text: Option<&str>, key: &str) -> Value {
    let Some(text) = text else {
        return Value::Null;
    };
    let (block, _) = super::parse::split_frontmatter(text);
    block
        .and_then(|block| super::parse::parse_frontmatter(block).ok())
        .and_then(|mapping| {
            mapping
                .get(serde_yaml::Value::String(key.to_string()))
                .map(super::parse::yaml_to_json)
        })
        .unwrap_or(Value::Null)
}

/// The vault-relative temp a page stages its bytes in.
fn temp_rel(path: &str) -> String {
    let rel = Path::new(path);
    let name = rel
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let temp = format!(
        ".{name}{}{:016x}",
        write::BATCH_TEMP_MARKER,
        rand::random::<u64>()
    );
    match rel.parent().map(|p| p.to_string_lossy().into_owned()) {
        Some(parent) if !parent.is_empty() => format!("{parent}/{temp}"),
        _ => temp,
    }
}

/// The Trash item a restore, or a revert of a trashed page, takes back:
/// its bytes, once the manifest names `path`, the item is there and nothing
/// holds `path` now.
fn trash_item(
    vault: &Path,
    page: &Page,
    stamp: &str,
    now: &Option<String>,
) -> Result<String, String> {
    let manifest = trash::read_manifest(vault, stamp)?;
    if manifest.path != page.path {
        return Err(wrong_item(stamp, &manifest.path, &page.path));
    }
    if manifest.kind != trash::TrashKind::File {
        return Err(trash::UNREADABLE.to_string());
    }
    let item = write::safe_join(vault, &format!("{}/{}", trash::stamp_rel(stamp), page.path))?;
    let bytes = read_page(&page.path, &item)?.ok_or_else(|| trash::nothing_at(stamp))?;
    if now.is_some() || std::fs::symlink_metadata(&page.abs).is_ok() {
        return Err(trash::already_exists(&page.path));
    }
    Ok(bytes)
}

/// Whether the page a revert names was rewritten by frontmatter patches
/// alone: `before` patched with each key's after value lands on
/// `after_hash`. A body change, or bytes the patch can't reproduce, reads as
/// not, so a page changed since refuses rather than mixing two bodies.
fn patched_alone(path: &str, before: &str, keys: &[KeyChange], after_hash: &str) -> bool {
    let set: Map<String, Value> = keys
        .iter()
        .map(|k| (k.key.clone(), k.after.clone()))
        .collect();
    write::patch_bytes(path, before, &set).is_ok_and(|bytes| hash(&bytes) == after_hash)
}

fn stale(path: &str, expected: &str, now: &Option<String>) -> BatchError {
    BatchError::Stale(StaleContent {
        path: path.to_string(),
        expected: expected.to_string(),
        actual: now.as_deref().map(hash).unwrap_or_default(),
    })
}

/// Plan every page under the lock: read, preconditions, expectations, then
/// bytes, each phase over every page before the next.
fn plan(vault: &Path, pages: &[Page]) -> Result<Vec<Planned>, BatchError> {
    let mut current: Vec<Option<String>> = Vec::with_capacity(pages.len());
    for page in pages {
        current.push(read_page(&page.path, &page.abs)?);
    }
    // The bytes each page starts from: what the batch's first op takes.
    let mut start: Vec<Option<String>> = Vec::with_capacity(pages.len());
    for (page, now) in pages.iter().zip(&current) {
        let first = page.first();
        start.push(match (first, first.own_stamp()) {
            (BatchOp::Create { .. }, _) => {
                if now.is_some() {
                    return Err(exists(&page.path).into());
                }
                None
            }
            (_, Some(stamp)) => Some(trash_item(vault, page, stamp, now)?),
            // A revert of a rewrite skips a page that is gone; its other
            // forms are held to their hash below.
            (BatchOp::Revert { .. }, None) => now.clone(),
            (BatchOp::ReplaceFile { expect, .. }, None) if now.is_none() => {
                return Err(stale(&page.path, expect, now));
            }
            _ => {
                if now.is_none() {
                    return Err(missing(&page.path).into());
                }
                now.clone()
            }
        });
    }
    for (page, now) in pages.iter().zip(&current) {
        for op in &page.ops {
            if let Some(expected) = op.expect() {
                let actual = now.as_deref().map(hash).unwrap_or_default();
                if actual != expected {
                    return Err(BatchError::Stale(StaleContent {
                        path: page.path.clone(),
                        expected: expected.to_string(),
                        actual,
                    }));
                }
            }
            // A revert holds its page to the bytes the change left (D2 (c)),
            // except a frontmatter-only rewrite, which reverts key by key,
            // and a rewritten page now gone, which skips whole.
            if let (
                Some(mode),
                BatchOp::Revert {
                    after_hash,
                    before,
                    keys,
                    ..
                },
            ) = (op.revert(), op)
            {
                let expected = after_hash.as_deref().unwrap_or_default();
                let held = now.as_deref().map(hash).as_deref() == Some(expected);
                let reverts = match mode {
                    Revert::Untrash(_) => true,
                    Revert::Retrash => held,
                    Revert::Rewrite => {
                        held || now.is_none()
                            || before
                                .as_deref()
                                .is_some_and(|b| patched_alone(&page.path, b, keys, expected))
                    }
                };
                if !reverts {
                    return Err(stale(&page.path, expected, now));
                }
            }
        }
    }
    let mut planned = Vec::new();
    for ((page, base), now) in pages.iter().zip(start).zip(&current) {
        let mut state = base.clone();
        let mut trashed = None;
        let mut patched: Vec<String> = Vec::new();
        let mut skipped: Option<Skipped> = None;
        for op in &page.ops {
            match op {
                BatchOp::Create { content, .. } | BatchOp::ReplaceFile { content, .. } => {
                    state = Some(content.clone())
                }
                BatchOp::Import(_) => {
                    return Err("An import must be planned before its writes."
                        .to_string()
                        .into())
                }
                BatchOp::Rename { .. } => {
                    return Err("a rename cannot be planned as a page write"
                        .to_string()
                        .into())
                }
                BatchOp::Restore { .. } => {}
                BatchOp::Patch { set, .. } => {
                    let text = state.clone().unwrap_or_default();
                    state = Some(write::patch_bytes(&page.path, &text, set)?);
                    for key in set.keys() {
                        if !patched.contains(key) {
                            patched.push(key.clone());
                        }
                    }
                }
                BatchOp::Body { body, .. } => {
                    let text = state.clone().unwrap_or_default();
                    state = Some(write::compose_saved(&page.path, &text, body));
                }
                BatchOp::Delete { .. } => {
                    trashed = page.stamp.clone();
                    state = None;
                }
                BatchOp::Revert {
                    after_hash,
                    before,
                    keys,
                    ..
                } => match op.revert() {
                    Some(Revert::Untrash(_)) | None => {}
                    Some(Revert::Retrash) => {
                        trashed = page.stamp.clone();
                        state = None;
                    }
                    Some(Revert::Rewrite) => {
                        let names = || keys.iter().map(|k| k.key.clone()).collect::<Vec<_>>();
                        let Some(text) = now else {
                            skipped = Some(Skipped {
                                keys: names(),
                                reason: Some("gone"),
                            });
                            continue;
                        };
                        if after_hash.as_deref() == Some(hash(text).as_str()) {
                            state = before.clone();
                            patched = names();
                            continue;
                        }
                        let mut set = Map::new();
                        let mut kept = Vec::new();
                        for change in keys {
                            if key_value(Some(text), &change.key) == change.after {
                                set.insert(change.key.clone(), change.before.clone());
                                patched.push(change.key.clone());
                            } else {
                                kept.push(change.key.clone());
                            }
                        }
                        if !set.is_empty() {
                            state = Some(write::patch_bytes(&page.path, text, &set)?);
                        }
                        if !kept.is_empty() {
                            skipped = Some(Skipped {
                                keys: kept,
                                reason: None,
                            });
                        }
                    }
                },
            }
        }
        let restored = page.first().own_stamp().map(str::to_string);
        let created = matches!(page.first(), BatchOp::Create { .. });
        let rewrites = state.is_some() && (created || state != base);
        if !rewrites && trashed.is_none() && restored.is_none() && skipped.is_none() {
            continue;
        }
        let keys = patched
            .into_iter()
            .map(|key| KeyChange {
                before: key_value(base.as_deref(), &key),
                after: key_value(state.as_deref(), &key),
                key,
            })
            .collect();
        let kind = rewrites.then_some(if created {
            "vault.create"
        } else {
            "vault.write"
        });
        planned.push(Planned {
            path: page.path.clone(),
            abs: page.abs.clone(),
            sidecar: (trashed.is_some() || restored.is_some())
                .then(|| page.sidecar())
                .flatten(),
            rollback_stamp: created.then(|| page.stamp.clone()).flatten(),
            temp: rewrites.then(|| temp_rel(&page.path)),
            before: base,
            after: state,
            keys,
            trashed,
            restored,
            kind,
            skipped,
            moved_from: None,
        });
    }
    let bytes: usize = planned
        .iter()
        .map(|p| p.before.as_ref().map_or(0, String::len) + p.after.as_ref().map_or(0, String::len))
        .sum();
    if bytes > MAX_BATCH_BYTES {
        return Err(TOO_LARGE.to_string().into());
    }
    Ok(planned)
}

/// Moves are kept in request order, after all page writes.
struct Rename {
    from: String,
    to: String,
}

fn normalized(path: &str) -> String {
    Path::new(path)
        .components()
        .map(|c| c.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

fn beneath(path: &str, parent: &str) -> Option<String> {
    if path == parent {
        Some(String::new())
    } else {
        path.strip_prefix(&format!("{parent}/"))
            .map(|tail| format!("/{tail}"))
    }
}

/// Where a name in the virtual, moved tree came from on the initial disk.
/// A source moved away and not replaced names nothing.
fn origin_of(path: &str, prior: &[Rename]) -> Option<String> {
    let mut path = normalized(path);
    for step in prior.iter().rev() {
        let from = normalized(&step.from);
        let to = normalized(&step.to);
        if let Some(tail) = beneath(&path, &to) {
            path = format!("{from}{tail}");
        } else if beneath(&path, &from).is_some() {
            return None;
        }
    }
    Some(path)
}

enum MoveNode {
    Directory,
    File(Option<String>),
}

/// The disk after planned writes but before moves. Text is needed only to
/// report a file's hashes; a binary attachment may move without being read
/// as a markdown page.
fn move_node(vault: &Path, path: &str, writes: &[Planned]) -> Result<Option<MoveNode>, String> {
    if let Some(page) = writes.iter().find(|p| normalized(&p.path) == path) {
        return Ok(page.after.clone().map(|text| MoveNode::File(Some(text))));
    }
    let abs = write::safe_join(vault, path)?;
    match std::fs::metadata(&abs) {
        Ok(meta) if meta.is_dir() => Ok(Some(MoveNode::Directory)),
        Ok(_) => {
            let bytes = std::fs::read(&abs).map_err(|e| format!("{path}: {e}"))?;
            Ok(Some(MoveNode::File(String::from_utf8(bytes).ok())))
        }
        Err(e)
            if matches!(
                e.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
            ) =>
        {
            // Staging a create makes its parents too.
            Ok(writes
                .iter()
                .any(|p| p.after.is_some() && beneath(&normalized(&p.path), path).is_some())
                .then_some(MoveNode::Directory))
        }
        Err(e) => Err(format!("{path}: {e}")),
    }
}

fn virtual_node(
    vault: &Path,
    path: &str,
    prior: &[Rename],
    writes: &[Planned],
) -> Result<Option<MoveNode>, String> {
    let node = match origin_of(path, prior) {
        Some(origin) => move_node(vault, &origin, writes)?,
        None => None,
    };
    if node.is_some() {
        return Ok(node);
    }
    // A preceding move can create a destination's parent directory. Carry
    // those parent names through subsequent moves just like existing ones.
    for (i, step) in prior.iter().enumerate() {
        for parent in Path::new(&step.to)
            .ancestors()
            .skip(1)
            .filter(|p| !p.as_os_str().is_empty())
        {
            let mut name = normalized(&parent.to_string_lossy());
            for later in &prior[i + 1..] {
                if let Some(tail) = beneath(&name, &normalized(&later.from)) {
                    name = format!("{}{tail}", normalized(&later.to));
                }
            }
            if name == normalized(path) {
                return Ok(Some(MoveNode::Directory));
            }
        }
    }
    Ok(None)
}

/// Validate every move against the names earlier moves leave. No rename,
/// temp or journal row exists until this succeeds whole.
fn plan_renames(
    vault: &Path,
    steps: &[Rename],
    writes: &[Planned],
) -> Result<Vec<Planned>, BatchError> {
    let mut planned = Vec::new();
    for (i, step) in steps.iter().enumerate() {
        let prior = &steps[..i];
        if virtual_node(vault, &step.to, prior, writes)?.is_some() {
            return Err(format!("target already exists: {}", step.to).into());
        }
        let source =
            virtual_node(vault, &step.from, prior, writes)?.ok_or_else(|| missing(&step.from))?;
        let is_dir = matches!(source, MoveNode::Directory);
        if let Some(origin) = origin_of(&step.to, prior) {
            if let Some(side) = super::comments::carried_rel(&origin, is_dir) {
                // A batch must be able to put every byte back. The ordinary
                // rename sends an orphan to OS Trash, which has no journaled
                // inverse, so a batch leaves that case for a direct rename.
                if super::comments::sidecar_join(vault, &side).is_ok_and(|p| p.exists()) {
                    return Err(format!("target comments already exist: {}", step.to).into());
                }
            }
        }
        if is_dir && beneath(&normalized(&step.to), &normalized(&step.from)).is_some() {
            return Err(format!(
                "{} can't be moved inside itself, so nothing was written.",
                step.from
            )
            .into());
        }
        let mut parent = Path::new(&step.to).parent();
        while let Some(path) = parent.filter(|p| !p.as_os_str().is_empty()) {
            if matches!(
                virtual_node(vault, &path.to_string_lossy(), prior, writes)?,
                Some(MoveNode::File(_))
            ) {
                return Err(format!(
                    "{} is not a folder, so nothing was written.",
                    path.display()
                )
                .into());
            }
            parent = path.parent();
        }
        let before = match source {
            MoveNode::File(text) => text,
            MoveNode::Directory => None,
        };
        planned.push(Planned {
            path: step.to.clone(),
            abs: vault.join(&step.to),
            before: before.clone(),
            after: before,
            keys: Vec::new(),
            trashed: None,
            restored: None,
            temp: None,
            kind: None,
            sidecar: super::comments::carried_rel(&step.to, is_dir),
            rollback_stamp: None,
            skipped: None,
            moved_from: Some(step.from.clone()),
        });
    }
    let bytes: usize = writes
        .iter()
        .chain(&planned)
        .map(|p| p.before.as_ref().map_or(0, String::len) + p.after.as_ref().map_or(0, String::len))
        .sum();
    if bytes > MAX_BATCH_BYTES {
        return Err(TOO_LARGE.to_string().into());
    }
    Ok(planned)
}

// --- Applying ------------------------------------------------------------------

/// Apply `ops` as one change, all or nothing (see the module doc), as the
/// person `by` names. Creates make their missing parent folders; an
/// in-process rollback removes only those new folders that are still empty.
/// Returns one result per page written.
pub fn apply_batch(
    vault: &Path,
    ops: &[Value],
    by: &WriteReceipt<Human>,
) -> Result<BatchApplied, BatchError> {
    apply_batch_at(
        vault,
        ops,
        by,
        &Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
    )
}

/// A fixed clock for the shared replay; the receipt alone supplies the actor.
pub(crate) fn apply_batch_at(
    vault: &Path,
    ops: &[Value],
    by: &WriteReceipt<Human>,
    now: &str,
) -> Result<BatchApplied, BatchError> {
    crate::workspace_service::boundary::guard_legacy_scope(vault, None, true)
        .map_err(|e| BatchError::Refused(e.message))?;
    if ops.len() > MAX_BATCH_OPS {
        return Err(too_many(ops.len()).into());
    }
    if !ops
        .iter()
        .any(|op| op.get("op").and_then(Value::as_str) == Some("import"))
    {
        return apply_expanded(vault, ops, by);
    }
    let parsed = parse_ops(ops)?;
    // An import takes this mutex before any path lock. Concurrent imports
    // discover the same identity only after the preceding batch commits.
    let _import = crate::import::lock();
    let requests: Vec<_> = parsed
        .iter()
        .enumerate()
        .filter_map(|(i, op)| match op {
            BatchOp::Import(request) => Some((i, request.clone())),
            _ => None,
        })
        .collect();
    let other: Vec<String> = parsed
        .iter()
        .flat_map(|op| match op {
            BatchOp::Import(_) => Vec::new(),
            BatchOp::Rename { from, to } => vec![from.clone(), to.clone()],
            _ => vec![op.path().to_string()],
        })
        .collect();
    let (files, occupied) = crate::import::plan::read_vault(vault)?;
    let planned = crate::import::plan::plan(&requests, &files, &occupied, &other, now, by.actor())?;
    let replacements: HashMap<_, _> = planned.writes.into_iter().collect();
    let expanded: Vec<_> = parsed
        .iter()
        .enumerate()
        .filter_map(|(index, op)| {
            if matches!(op, BatchOp::Import(_)) {
                replacements.get(&index).cloned()
            } else {
                Some(ops[index].clone())
            }
        })
        .collect();
    #[cfg(test)]
    seams::park_import();
    let mut applied = apply_expanded(vault, &expanded, by)?;
    applied.imports = Some(planned.imports);
    Ok(applied)
}

fn apply_expanded(
    vault: &Path,
    ops: &[Value],
    by: &WriteReceipt<Human>,
) -> Result<BatchApplied, BatchError> {
    let ops = parse_ops(ops)?;
    let mut renames = Vec::new();
    let mut writes = Vec::new();
    for op in ops {
        if let BatchOp::Rename { from, to } = op {
            crate::knowledge::guard_human_move(&from, &to).map(drop)?;
            write::rename_paths(vault, &from, &to)?;
            for end in [&from, &to] {
                if let Some(landing) = write::landing_path(vault, end) {
                    crate::knowledge::guard_human_write(&landing).map(drop)?;
                    write::rename_paths(vault, &landing, &landing)?;
                }
            }
            renames.push(Rename { from, to });
        } else {
            if !renames.is_empty() {
                return Err(
                    "Every write must precede every rename, so nothing was written."
                        .to_string()
                        .into(),
                );
            }
            write::note_join(vault, op.path(), write::MARKDOWN)?;
            crate::knowledge::guard_human_write(op.path()).map(drop)?;
            writes.push(op);
        }
    }
    let mut pages = pages(vault, writes)?;
    let batch_id = format!("{:032x}", rand::random::<u128>());
    if pages.is_empty() && renames.is_empty() {
        return Ok(BatchApplied {
            batch_id,
            files: Vec::new(),
            imports: None,
        });
    }
    if !crate::runtime::sink::is_armed() {
        return Err(no_journal().into());
    }
    let lock = lock_all(vault, &mut pages, &renames)?;
    let mut planned = plan(vault, &pages)?;
    let moved = plan_renames(vault, &renames, &planned)?;
    planned.extend(moved);
    if !planned.iter().any(Planned::touches) {
        return Ok(BatchApplied {
            batch_id,
            files: planned.iter().map(Planned::result).collect(),
            imports: None,
        });
    }
    let journal: Vec<JournalFile> = planned
        .iter()
        .filter(|p| p.touches())
        .map(Planned::journal)
        .collect();
    let new_parents = missing_parents(vault, planned.iter().map(|page| page.abs.as_path()));
    batch_journal::begin(vault, &batch_id, &journal, by.actor())
        .map_err(|e| format!("Couldn't start the change: {e}, so nothing was written."))?;
    crate::crash::crash_point("batch-journaled");
    let touched: Vec<&Planned> = planned.iter().filter(|p| p.touches()).collect();
    if let Err(error) = write_all(vault, &batch_id, &touched, &lock, by) {
        let stamps: HashMap<String, String> = planned
            .iter()
            .filter_map(|p| Some((p.path.clone(), p.rollback_stamp.clone()?)))
            .collect();
        return Err(match roll_back(vault, &journal, &lock, &stamps, by) {
            Ok(_) => {
                prune_new_parents(&new_parents);
                let _ = batch_journal::finish(&batch_id);
                rolled_back(&error)
            }
            Err(also) => {
                log::warn!("batch: {batch_id} stays journaled for the next open: {also}");
                left_for_next_open(&error)
            }
        }
        .into());
    }
    for page in &planned {
        if let (Some(kind), Some(after)) = (page.kind, &page.after) {
            write::record(vault, kind, &page.path, None, Some(&hash(after)), by);
        }
    }
    Ok(BatchApplied {
        batch_id,
        files: planned.iter().map(Planned::result).collect(),
        imports: None,
    })
}

/// Take every path the batch touches, retrying the stamps when another
/// delete took one meanwhile.
fn lock_all(vault: &Path, pages: &mut [Page], renames: &[Rename]) -> Result<PathLock, String> {
    for _ in 0..8 {
        mint_stamps(vault, pages);
        let mut keys = lock_keys(pages);
        for (i, step) in renames.iter().enumerate() {
            keys.extend(write::rename_lock_keys(&step.from, &step.to));
            for end in [&step.from, &step.to] {
                if let Some(origin) = origin_of(end, &renames[..i]) {
                    keys.extend(write::rename_lock_keys(&origin, &origin));
                }
            }
        }
        // Cleanup of a new empty parent must not race another writer that
        // just created it but has not yet placed its file inside it.
        let targets: Vec<PathBuf> = pages
            .iter()
            .map(|page| page.abs.clone())
            .chain(renames.iter().map(|step| vault.join(&step.to)))
            .collect();
        for parent in missing_parents(vault, targets.iter().map(PathBuf::as_path)) {
            keys.push(
                parent
                    .strip_prefix(vault)
                    .map_err(|e| e.to_string())?
                    .to_string_lossy()
                    .replace('\\', "/"),
            );
        }
        let refs: Vec<&str> = keys.iter().map(String::as_str).collect();
        let lock = write::lock_paths(vault, &refs)?;
        let fresh_taken = pages.iter().any(|page| {
            page.first().own_stamp().is_none()
                && page
                    .stamp
                    .as_ref()
                    .is_some_and(|stamp| vault.join(trash::TRASH_DIR).join(stamp).exists())
        });
        if !fresh_taken {
            return Ok(lock);
        }
    }
    Err("no free Trash stamp, so nothing was written.".to_string())
}

/// Missing ancestors below the vault, deepest first. Existing empty folders
/// belong to the person and must never be removed by a failed batch.
fn missing_parents<'a>(vault: &Path, targets: impl Iterator<Item = &'a Path>) -> Vec<PathBuf> {
    let mut parents = Vec::new();
    for target in targets {
        for parent in target.ancestors().skip(1) {
            if parent == vault
                || !parent.starts_with(vault)
                || std::fs::symlink_metadata(parent).is_ok()
            {
                break;
            }
            if !parents.iter().any(|taken| taken == parent) {
                parents.push(parent.to_path_buf());
            }
        }
    }
    parents.sort_by_key(|parent| std::cmp::Reverse(parent.components().count()));
    parents
}

fn prune_new_parents(parents: &[PathBuf]) {
    for parent in parents {
        // remove_dir is deliberately empty-only: an outside writer's file
        // is never removed, and a replaced symlink is never followed.
        match std::fs::remove_dir(parent) {
            Ok(()) => {
                if let Some(above) = parent.parent() {
                    if let Err(error) = write::sync_dir(above) {
                        log::warn!(
                            "batch: removed new folder {} but could not sync it: {error}",
                            parent.display()
                        );
                    }
                }
            }
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::NotFound | std::io::ErrorKind::DirectoryNotEmpty
                ) => {}
            Err(error) => log::warn!(
                "batch: could not remove new empty folder {}: {error}",
                parent.display()
            ),
        }
    }
}

/// The write half, after the journal row: stage, mark, rename and move,
/// sync, commit.
fn write_all(
    vault: &Path,
    batch_id: &str,
    planned: &[&Planned],
    lock: &PathLock,
    by: &WriteReceipt<Human>,
) -> Result<(), String> {
    for page in planned {
        if let (Some(temp), Some(after)) = (&page.temp, &page.after) {
            write::stage_temp(&vault.join(temp), &page.abs, after)
                .map_err(|e| format!("{}: {e}", page.path))?;
        }
    }
    crate::crash::crash_point("batch-staged");
    crate::crash::stop_point("batch-staged");
    #[cfg(test)]
    seams::park();
    batch_journal::mark_applying(batch_id)?;
    for (i, page) in planned.iter().enumerate() {
        #[cfg(test)]
        seams::fail_at(i)?;
        if let Some(from) = &page.moved_from {
            write::rename_carrying(
                vault,
                from,
                &page.path,
                lock,
                |_| Err("a batch cannot discard comments it could not restore".to_string()),
                by,
            )?;
            crate::crash::crash_point("batch-renamed");
            crate::crash::stop_point("batch-renamed");
        }
        if let Some(stamp) = &page.restored {
            trash::untrash_locked(vault, stamp, lock, by)?;
        }
        if let (Some(temp), Some(after)) = (&page.temp, &page.after) {
            write::rename_into_place(lock, &vault.join(temp), &page.abs, hash(after))
                .map_err(|e| format!("{}: {e}", page.path))?;
            if let Some(parent) = page.abs.parent() {
                write::sync_dir(parent)?;
            }
        }
        if let Some(stamp) = &page.trashed {
            trash::trash_locked(vault, &page.path, stamp, lock, by)?;
        }
        if i == 0 {
            crate::crash::crash_point("batch-renamed-first");
            crate::crash::stop_point("batch-renamed-first");
        }
    }
    batch_journal::finish(batch_id)?;
    crate::crash::crash_point("batch-committed");
    Ok(())
}

// --- Putting back --------------------------------------------------------------

/// The bytes at `abs`, by hash, `None` when nothing is there.
fn hash_at(abs: &Path) -> Option<String> {
    std::fs::read(abs)
        .ok()
        .map(|bytes| crate::ledger::sha256_hex(&bytes))
}

/// Put every page of a journal row back as it was, last page first, under
/// `lock`, which holds every path, sidecar and manifest the row names and
/// the stamp `stamps` gives each created page. A page that holds neither the
/// bytes the batch wrote nor the ones it replaced changed since: it is left
/// alone, logged by path, and counted as kept. What it puts back is
/// recorded under `by` (M58.1): a page's old bytes as a `vault.write`, and
/// each Trash move as the move records itself. Returns (put back, kept).
/// Running it again changes nothing.
fn roll_back<D: Door>(
    vault: &Path,
    files: &[JournalFile],
    lock: &PathLock,
    stamps: &HashMap<String, String>,
    by: &WriteReceipt<D>,
) -> Result<(usize, usize), String> {
    let (mut restored, mut kept) = (0, 0);
    for file in files.iter().rev() {
        if let Some(temp) = &file.temp {
            match std::fs::remove_file(vault.join(temp)) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(format!("{temp}: {e}")),
            }
        }
        if let Some(from) = &file.moved_from {
            let old = write::safe_join(vault, from)?;
            let new = write::safe_join(vault, &file.path)?;
            let old_exists = std::fs::symlink_metadata(&old).is_ok();
            let new_exists = std::fs::symlink_metadata(&new).is_ok();
            if new_exists != old_exists {
                write::recover_rename(vault, from, &file.path, lock, by)?;
                restored += 1;
            } else if !old_exists && !new_exists {
                // A later folder/main-file step may never have started.
                // If its original name still exists, there is no move to undo.
                let previous: Vec<Rename> = files
                    .iter()
                    .take_while(|p| !std::ptr::eq(*p, file))
                    .filter_map(|p| {
                        Some(Rename {
                            from: p.moved_from.clone()?,
                            to: p.path.clone(),
                        })
                    })
                    .collect();
                let unstarted =
                    origin_of(from, &previous).is_some_and(|origin| vault.join(origin).exists());
                if unstarted {
                    restored += 1;
                } else {
                    log::warn!(
                        "batch: rename {} -> {} has neither endpoint; left for review",
                        from,
                        file.path
                    );
                    kept += 1;
                }
            } else {
                log::warn!(
                    "batch: rename {} -> {} has both endpoints; neither was overwritten",
                    from,
                    file.path
                );
                kept += 1;
            }
            continue;
        }
        let abs = vault.join(&file.path);
        let now = hash_at(&abs);
        let back = if let Some(stamp) = &file.trashed {
            let item = vault.join(trash::stamp_rel(stamp)).join(&file.path);
            if now.is_none() && std::fs::symlink_metadata(&item).is_ok() {
                trash::untrash_locked(vault, stamp, lock, by)?;
                true
            } else {
                now.is_some() && now == file.before_hash
            }
        } else if let Some(stamp) = &file.restored {
            if now.is_none() {
                let item = vault.join(trash::stamp_rel(stamp)).join(&file.path);
                std::fs::symlink_metadata(&item).is_ok()
            } else if now == file.after_hash || now == file.before_hash {
                if now != file.before_hash {
                    let before = file.before.as_deref().unwrap_or_default();
                    write::write_file(lock, &abs, before)?;
                }
                trash::trash_locked(vault, &file.path, stamp, lock, by)?;
                true
            } else {
                false
            }
        } else if file.before.is_none() {
            if now.is_none() {
                true
            } else if now == file.after_hash {
                let stamp = stamps
                    .get(&file.path)
                    .ok_or_else(|| format!("{}: no Trash stamp to put it in", file.path))?;
                trash::trash_locked(vault, &file.path, stamp, lock, by)?;
                true
            } else {
                false
            }
        } else if now == file.after_hash {
            write::write_file(lock, &abs, file.before.as_deref().unwrap_or_default())?;
            write::record(
                vault,
                "vault.write",
                &file.path,
                None,
                file.before_hash.as_deref(),
                by,
            );
            true
        } else {
            now.is_some() && now == file.before_hash
        };
        if back {
            restored += 1;
        } else {
            log::warn!(
                "batch: {} changed since the change stopped, so it was left alone",
                file.path
            );
            kept += 1;
        }
    }
    Ok((restored, kept))
}

/// Put back every batch `vault` left unfinished that started before
/// `started_before`: the launch's rollback, run by `start_watcher` before
/// the Trash purge and the watcher. A batch this process started after the
/// line may still be running (a webview reload re-runs the open), so it
/// waits for the next launch. Each row is re-read under its locks, and one
/// already gone is skipped. Never fails the open: a row it can't put back is
/// logged and stays.
pub fn recover(
    vault: &Path,
    started_before: DateTime<Utc>,
    by: &WriteReceipt<System>,
) -> RecoveryReport {
    let mut report = RecoveryReport::default();
    let cutoff = started_before.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let rows = match batch_journal::pending(vault, &cutoff) {
        Ok(rows) => rows,
        Err(e) => {
            log::warn!("batch: unfinished changes could not be read: {e}");
            return report;
        }
    };
    for row in rows {
        let mut stamps: HashMap<String, String> = HashMap::new();
        let mut keys: Vec<String> = Vec::new();
        for file in &row.files {
            keys.push(file.path.clone());
            if let Some(from) = &file.moved_from {
                keys.extend(write::rename_lock_keys(from, &file.path));
                continue;
            }
            let stamp = file.trashed.clone().or_else(|| file.restored.clone());
            let stamp = match stamp {
                Some(stamp) => stamp,
                None if file.before.is_none() => {
                    let fresh = trash::new_stamp(Utc::now(), rand::random::<u16>());
                    stamps.insert(file.path.clone(), fresh.clone());
                    fresh
                }
                None => continue,
            };
            if let Some(side) = super::comments::carried_rel(&file.path, false) {
                keys.push(side);
            }
            keys.push(trash::manifest_rel(&stamp));
        }
        let refs: Vec<&str> = keys.iter().map(String::as_str).collect();
        let lock = match write::lock_paths(vault, &refs) {
            Ok(lock) => lock,
            Err(e) => {
                log::warn!(
                    "batch: {} could not be locked to put back: {e}",
                    row.batch_id
                );
                continue;
            }
        };
        match batch_journal::get(&row.batch_id) {
            Ok(Some(_)) => {}
            Ok(None) => continue,
            Err(e) => {
                log::warn!("batch: {} could not be read again: {e}", row.batch_id);
                continue;
            }
        }
        match roll_back(vault, &row.files, &lock, &stamps, by) {
            Ok((restored, kept)) => {
                if let Err(e) = batch_journal::finish(&row.batch_id) {
                    log::warn!(
                        "batch: {} was put back but stays journaled: {e}",
                        row.batch_id
                    );
                }
                report.unfinished += row.files.len();
                report.restored += restored;
                report.kept += kept;
            }
            Err(e) => log::warn!("batch: {} could not be put back yet: {e}", row.batch_id),
        }
    }
    report
}

/// Test-only seams: a batch parked after its temps, and a rename that fails.
#[cfg(test)]
pub(crate) mod seams {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::mpsc::{Receiver, SyncSender};
    use std::sync::Mutex;

    /// The page whose apply step fails, or `usize::MAX` for none.
    pub static FAIL_AT: AtomicUsize = AtomicUsize::new(usize::MAX);

    /// The next batch to reach `batch-staged` says so on the sender and
    /// waits on the receiver.
    pub static PARK: Mutex<Option<(SyncSender<()>, Receiver<()>)>> = Mutex::new(None);
    pub static IMPORT_PARK: Mutex<Option<(SyncSender<()>, Receiver<()>)>> = Mutex::new(None);
    pub(super) fn park_import() {
        let parked = IMPORT_PARK.lock().unwrap_or_else(|e| e.into_inner()).take();
        if let Some((parked, release)) = parked {
            let _ = parked.send(());
            let _ = release.recv();
        }
    }

    pub(super) fn fail_at(i: usize) -> Result<(), String> {
        if FAIL_AT.load(Ordering::SeqCst) == i {
            return Err("the disk refused the rename (test fault)".to_string());
        }
        Ok(())
    }

    pub(super) fn park() {
        let parked = PARK.lock().unwrap_or_else(|e| e.into_inner()).take();
        if let Some((parked, release)) = parked {
            let _ = parked.send(());
            let _ = release.recv();
        }
    }
}

#[cfg(test)]
mod tests {
    include!("../import/batch_tests.rs");
    use super::*;
    use crate::vault::receipt::{BATCH_RECOVERY_ACTOR, HUMAN_ACTOR};
    use crate::vault::testutil;
    use serde_json::json;
    use std::sync::atomic::Ordering;

    const CASES: &str = include_str!("../../fixtures/batch-cases.json");

    const A: &str = "---\nstatus: todo\n---\n\n# A\n";
    const B: &str = "---\nstatus: todo\nestimate: S\n---\n\n# B\n";
    const C: &str = "---\nstatus: done\n---\n\n# C\n";

    fn human() -> WriteReceipt<Human> {
        WriteReceipt::for_test(HUMAN_ACTOR, None)
    }

    fn recovery() -> WriteReceipt<System> {
        WriteReceipt::for_test(BATCH_RECOVERY_ACTOR, None)
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

    fn vault_with(label: &str, files: &[(&str, &str)]) -> PathBuf {
        let vault = testutil::temp_vault(label);
        for (rel, text) in files {
            testutil::write(&vault, rel, text);
        }
        vault
    }

    fn read(vault: &Path, rel: &str) -> Option<String> {
        std::fs::read_to_string(vault.join(rel)).ok()
    }

    /// Every file under the vault with its bytes and mtime: what "nothing
    /// changed" compares.
    fn tree(vault: &Path) -> Vec<(String, Vec<u8>, std::time::SystemTime)> {
        let mut files: Vec<_> = walkdir::WalkDir::new(vault)
            .into_iter()
            .filter_map(Result::ok)
            .filter(|e| e.file_type().is_file())
            .map(|e| {
                let rel = e
                    .path()
                    .strip_prefix(vault)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/");
                let meta = e.metadata().unwrap();
                (
                    rel,
                    std::fs::read(e.path()).unwrap(),
                    meta.modified().unwrap(),
                )
            })
            .collect();
        files.sort_by(|a, b| a.0.cmp(&b.0));
        files
    }

    fn temps(vault: &Path) -> Vec<String> {
        tree(vault)
            .into_iter()
            .map(|(rel, _, _)| rel)
            .filter(|rel| rel.contains(write::BATCH_TEMP_MARKER))
            .collect()
    }

    /// `vault`'s rows in `vault_writes`: kind, path, actor.
    fn rows(vault: &Path) -> Vec<(String, String, String)> {
        let vault_id = crate::runtime::scope::derive_vault_id(vault);
        crate::runtime::sink::with_sink(|conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT kind, path, actor FROM vault_writes WHERE vault_id = ?1 ORDER BY rowid",
                )
                .unwrap();
            stmt.query_map([&vault_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
        })
        .unwrap_or_default()
    }

    fn journal_rows() -> i64 {
        crate::runtime::sink::with_sink(|conn| {
            conn.query_row("SELECT count(*) FROM batch_journal", [], |r| r.get(0))
                .unwrap()
        })
        .unwrap_or(0)
    }

    fn apply(vault: &Path, ops: Value) -> Result<BatchApplied, BatchError> {
        apply_batch(vault, ops.as_array().unwrap(), &human())
    }

    fn refusal(outcome: Result<BatchApplied, BatchError>) -> String {
        match outcome {
            Ok(applied) => panic!("expected a refusal, got {applied:?}"),
            Err(BatchError::Refused(message)) => message,
            Err(BatchError::Stale(stale)) => stale_words(&stale.path),
        }
    }

    /// The stamp dirs that hold `rel` with exactly `bytes`.
    fn trashed_as(vault: &Path, rel: &str, bytes: &str) -> usize {
        std::fs::read_dir(vault.join(trash::TRASH_DIR))
            .map(|entries| {
                entries
                    .filter_map(Result::ok)
                    .filter(|e| {
                        std::fs::read_to_string(e.path().join(rel)).ok().as_deref() == Some(bytes)
                    })
                    .count()
            })
            .unwrap_or(0)
    }

    fn frontmatter_of(text: &str) -> Value {
        let (block, _) = crate::vault::parse::split_frontmatter(text);
        match block {
            Some(block) => crate::vault::parse::yaml_to_json(&serde_yaml::Value::Mapping(
                crate::vault::parse::parse_frontmatter(block).unwrap(),
            )),
            None => Value::Null,
        }
    }

    fn body_of(text: &str) -> &str {
        crate::vault::parse::split_frontmatter(text).1
    }

    // The parity half: the mock (src/lib/mockIpc.test.ts) replays the same
    // cases through its applyBatch.
    #[test]
    fn replays_the_shared_batch_cases() {
        let file: Value = serde_json::from_str(CASES).unwrap();
        for case in file["cases"].as_array().unwrap() {
            let _recording = Recording::new("batch-cases-config");
            if case["journal"] == json!(false) {
                crate::runtime::sink::disarm();
            }
            let vault = testutil::temp_vault("batch-cases");
            let seed = case["seed"].as_object().unwrap();
            for (rel, text) in seed {
                testutil::write(&vault, rel, text.as_str().unwrap());
            }
            let mut ops = case["ops"].clone();
            for op in ops.as_array_mut().unwrap() {
                let named = op["expectHash"]
                    .as_str()
                    .and_then(|h| h.strip_prefix("HASH:"))
                    .map(str::to_string);
                if let Some(rel) = named {
                    op["expectHash"] = json!(hash(seed[&rel].as_str().unwrap()));
                }
            }
            let before = tree(&vault);
            let outcome = if let Some(now) = case["now"].as_str() {
                apply_batch_at(&vault, ops.as_array().unwrap(), &human(), now)
            } else {
                apply(&vault, ops)
            };
            let name = case["name"].as_str().unwrap();
            if let Some(fragment) = case["refused"].as_str() {
                let message = refusal(outcome);
                assert!(message.contains(fragment), "{name}: {message}");
                assert_eq!(tree(&vault), before, "{name}: a refusal changes nothing");
                assert_eq!(rows(&vault), vec![], "{name}: a refusal records nothing");
                let _ = std::fs::remove_dir_all(&vault);
                continue;
            }
            let applied = outcome.unwrap_or_else(|e| panic!("{name}: {e:?}"));
            if let Some(imports) = case.get("imports") {
                assert_eq!(
                    serde_json::to_value(&applied.imports).unwrap(),
                    *imports,
                    "{name}"
                );
            }
            for (path, text) in case["afterRaw"].as_object().into_iter().flatten() {
                assert_eq!(
                    read(&vault, path).as_deref(),
                    text.as_str(),
                    "{name}: {path}"
                );
            }
            let written: Vec<&str> = applied.files.iter().map(|f| f.path.as_str()).collect();
            let expected: Vec<&str> = case["written"]
                .as_array()
                .unwrap()
                .iter()
                .map(|p| p.as_str().unwrap())
                .collect();
            assert_eq!(written, expected, "{name}");
            for (rel, want) in case["after"].as_object().into_iter().flatten() {
                let text = read(&vault, rel);
                match want {
                    Value::Null => assert_eq!(text, None, "{name}: {rel} is absent"),
                    want => {
                        let text = text.unwrap_or_else(|| panic!("{name}: {rel} is missing"));
                        assert_eq!(frontmatter_of(&text), want["frontmatter"], "{name}: {rel}");
                        assert_eq!(body_of(&text), want["body"].as_str().unwrap(), "{name}");
                    }
                }
            }
            for (rel, keys) in case["keys"].as_object().into_iter().flatten() {
                let result = applied.files.iter().find(|f| &f.path == rel).unwrap();
                assert_eq!(serde_json::to_value(&result.keys).unwrap(), *keys, "{name}");
            }
            for rel in case["trashed"].as_array().into_iter().flatten() {
                let rel = rel.as_str().unwrap();
                let seeded = seed[rel].as_str().unwrap();
                assert_eq!(trashed_as(&vault, rel, seeded), 1, "{name}: {rel}");
            }
            assert!(temps(&vault).is_empty(), "{name}: no temp stays");
            assert_eq!(journal_rows(), 0, "{name}: the row is gone at commit");
            let _ = std::fs::remove_dir_all(&vault);
        }
    }

    #[test]
    fn the_limits_match_the_fixture() {
        let file: Value = serde_json::from_str(CASES).unwrap();
        assert_eq!(file["limits"]["maxOps"], json!(MAX_BATCH_OPS));
        assert_eq!(file["limits"]["maxBytes"], json!(MAX_BATCH_BYTES));
    }

    #[test]
    fn a_stale_op_leaves_every_page_alone() {
        let _recording = Recording::new("batch-stale-config");
        let vault = vault_with("batch-stale", &[("records/a.md", A), ("records/b.md", B)]);
        let before = tree(&vault);
        let outcome = apply(
            &vault,
            json!([
                { "op": "patch", "path": "records/a.md", "set": { "status": "done" } },
                { "op": "delete", "path": "records/b.md", "expectHash": hash("not these bytes") },
            ]),
        );
        let Err(BatchError::Stale(stale)) = outcome else {
            panic!("expected Stale, got {outcome:?}");
        };
        assert_eq!(stale.path, "records/b.md");
        assert_eq!(stale.actual, hash(B));
        assert_eq!(tree(&vault), before, "bytes and mtimes");
        assert!(temps(&vault).is_empty());
        assert_eq!(journal_rows(), 0);
        assert_eq!(rows(&vault), vec![]);
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn ops_on_one_page_apply_in_order() {
        let _recording = Recording::new("batch-order-config");
        let vault = vault_with("batch-order", &[("records/a.md", A)]);
        apply(
            &vault,
            json!([
                { "op": "patch", "path": "records/a.md", "set": { "status": "done" } },
                { "op": "patch", "path": "records/a.md", "set": { "status": "review" } },
                { "op": "body", "path": "records/a.md", "body": "\n# A\n\nLast.\n" },
            ]),
        )
        .unwrap();
        assert_eq!(
            read(&vault, "records/a.md").unwrap(),
            "---\nstatus: review\n---\n\n# A\n\nLast.\n"
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn a_batch_refuses_without_a_journal() {
        let _lock = crate::runtime::sink::test_lock();
        crate::runtime::sink::disarm();
        let vault = vault_with("batch-no-journal", &[("records/a.md", A)]);
        let before = tree(&vault);
        let message = refusal(apply(
            &vault,
            json!([{ "op": "patch", "path": "records/a.md", "set": { "status": "done" } }]),
        ));
        assert_eq!(message, no_journal());
        assert_eq!(tree(&vault), before);
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn a_batch_refuses_knowledge_and_non_notes() {
        let _recording = Recording::new("batch-targets-config");
        let vault = vault_with(
            "batch-targets",
            &[
                ("records/a.md", A),
                ("knowledge/concepts/x.md", "# X\n"),
                (".git/config", "[core]\n"),
                ("records/a.yml", "a: 1\n"),
            ],
        );
        let before = tree(&vault);
        for (path, fragment) in [
            ("knowledge/concepts/x.md", "read-only"),
            ("Knowledge/concepts/x.md", "knowledge/ by another name"),
            (".git/config", "not a note"),
            ("records/a.yml", "not a note"),
            (".trash/20261014T093000Z-a1b2/records/a.md", "not a note"),
            ("../outside.md", "escapes the vault"),
        ] {
            let message = refusal(apply(
                &vault,
                json!([
                    { "op": "patch", "path": "records/a.md", "set": { "status": "done" } },
                    { "op": "patch", "path": path, "set": { "status": "done" } },
                ]),
            ));
            assert!(message.contains(fragment), "{path}: {message}");
            assert_eq!(tree(&vault), before, "{path}");
        }
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn a_batch_over_its_caps_writes_nothing() {
        let _recording = Recording::new("batch-caps-config");
        let vault = vault_with("batch-caps", &[("records/a.md", A)]);
        let before = tree(&vault);
        let one = json!({ "op": "patch", "path": "records/a.md", "set": { "status": "done" } });
        let many: Vec<Value> = vec![one; MAX_BATCH_OPS + 1];
        assert_eq!(
            refusal(apply_batch(&vault, &many, &human())),
            too_many(MAX_BATCH_OPS + 1)
        );
        let huge = "x".repeat(MAX_BATCH_BYTES);
        assert_eq!(
            refusal(apply(
                &vault,
                json!([
                    { "op": "patch", "path": "records/a.md", "set": { "status": "done" } },
                    { "op": "create", "path": "records/huge.md", "content": huge },
                ]),
            )),
            TOO_LARGE
        );
        assert_eq!(tree(&vault), before);
        assert_eq!(journal_rows(), 0);
        let _ = std::fs::remove_dir_all(&vault);
    }

    /// Release a parked batch when dropped, even when an assertion fails.
    struct Release(Option<std::sync::mpsc::SyncSender<()>>);

    impl Drop for Release {
        fn drop(&mut self) {
            if let Some(release) = self.0.take() {
                let _ = release.send(());
            }
        }
    }

    /// Park the next batch at `batch-staged`; the receiver hears it park.
    fn park_next() -> (std::sync::mpsc::Receiver<()>, Release) {
        let (parked_tx, parked_rx) = std::sync::mpsc::sync_channel(1);
        let (release_tx, release_rx) = std::sync::mpsc::sync_channel(1);
        *seams::PARK.lock().unwrap() = Some((parked_tx, release_rx));
        (parked_rx, Release(Some(release_tx)))
    }

    const WAIT: std::time::Duration = std::time::Duration::from_secs(10);

    #[test]
    fn a_batch_holds_every_path_lock() {
        let _recording = Recording::new("batch-locks-config");
        let vault = vault_with("batch-locks", &[("records/a.md", A), ("records/b.md", B)]);
        let (parked, mut release) = park_next();
        let batch_vault = vault.clone();
        let batch = std::thread::spawn(move || {
            apply(
                &batch_vault,
                json!([
                    { "op": "patch", "path": "records/a.md", "set": { "status": "done" } },
                    { "op": "patch", "path": "records/b.md", "set": { "status": "done" } },
                ]),
            )
        });
        parked.recv_timeout(WAIT).expect("the batch parks");
        let (saved_tx, saved_rx) = std::sync::mpsc::channel();
        let save_vault = vault.clone();
        let save = std::thread::spawn(move || {
            let saved = write::save_note(
                &save_vault,
                "records/b.md",
                "\n# B\n\nMine.\n",
                None,
                &human(),
            );
            let _ = saved_tx.send(());
            saved
        });
        assert!(
            saved_rx
                .recv_timeout(std::time::Duration::from_millis(300))
                .is_err(),
            "a single write to one of the batch's pages waits for it"
        );
        let _ = release.0.take().map(|tx| tx.send(()));
        batch.join().unwrap().unwrap();
        saved_rx.recv_timeout(WAIT).expect("the save lands after");
        save.join().unwrap().unwrap();
        assert_eq!(
            read(&vault, "records/b.md").unwrap(),
            "---\nstatus: done\nestimate: S\n---\n\n# B\n\nMine.\n",
            "the save built on the batch's bytes"
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn delete_and_restore_ops_move_through_the_trash() {
        let _recording = Recording::new("batch-trash-config");
        let vault = vault_with(
            "batch-trash",
            &[
                ("records/a.md", A),
                ("records/b.md", B),
                (
                    ".comments/records/a.md.json",
                    "{\"format\":1,\"threads\":[]}\n",
                ),
            ],
        );
        let deleted = apply(
            &vault,
            json!([
                { "op": "delete", "path": "records/a.md", "expectHash": hash(A) },
                { "op": "delete", "path": "records/b.md" },
            ]),
        )
        .unwrap();
        assert!(read(&vault, "records/a.md").is_none());
        assert!(read(&vault, ".comments/records/a.md.json").is_none());
        let stamps: Vec<String> = deleted
            .files
            .iter()
            .map(|f| f.trashed.clone().unwrap())
            .collect();
        assert_ne!(stamps[0], stamps[1], "each page takes its own stamp");
        assert_eq!(deleted.files[0].after_hash, None);
        assert_eq!(trashed_as(&vault, "records/a.md", A), 1);
        let restored = apply(
            &vault,
            json!([
                { "op": "restore", "path": "records/a.md", "stamp": stamps[0] },
                { "op": "restore", "path": "records/b.md", "stamp": stamps[1] },
            ]),
        )
        .unwrap();
        assert_eq!(
            restored.files[0].restored.as_deref(),
            Some(stamps[0].as_str())
        );
        assert_eq!(read(&vault, "records/a.md").unwrap(), A, "identical bytes");
        assert_eq!(read(&vault, "records/b.md").unwrap(), B);
        assert!(read(&vault, ".comments/records/a.md.json").is_some());
        assert!(trash::list_trash(&vault).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn results_carry_pre_images_hashes_and_key_changes() {
        let _recording = Recording::new("batch-results-config");
        let vault = vault_with("batch-results", &[("records/a.md", A)]);
        let applied = apply(
            &vault,
            json!([
                { "op": "patch", "path": "records/a.md", "set": { "status": "done", "tags": ["x"] } },
                { "op": "create", "path": "records/new.md", "content": "# New\n" },
            ]),
        )
        .unwrap();
        assert_eq!(applied.batch_id.len(), 32);
        let after = read(&vault, "records/a.md").unwrap();
        assert_eq!(
            applied.files[0],
            FileResult {
                path: "records/a.md".into(),
                before_hash: Some(hash(A)),
                after_hash: Some(hash(&after)),
                before: Some(A.into()),
                keys: vec![
                    KeyChange {
                        key: "status".into(),
                        before: json!("todo"),
                        after: json!("done")
                    },
                    KeyChange {
                        key: "tags".into(),
                        before: Value::Null,
                        after: json!(["x"])
                    },
                ],
                trashed: None,
                restored: None,
                skipped: None,
                moved_from: None,
            }
        );
        assert_eq!(applied.files[1].before, None);
        assert_eq!(applied.files[1].after_hash, Some(hash("# New\n")));
        let wire = serde_json::to_value(&applied).unwrap();
        assert!(wire["batchId"].is_string() && wire["files"][0]["beforeHash"].is_string());
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn an_unchanged_page_is_not_written() {
        let _recording = Recording::new("batch-unchanged-config");
        let vault = vault_with(
            "batch-unchanged",
            &[("records/a.md", A), ("records/b.md", B)],
        );
        let before = tree(&vault);
        let applied = apply(
            &vault,
            json!([
                { "op": "patch", "path": "records/a.md", "set": { "status": "todo" } },
                { "op": "patch", "path": "records/b.md", "set": { "status": "done" } },
            ]),
        )
        .unwrap();
        assert_eq!(applied.files.len(), 1);
        let a_now = tree(&vault).into_iter().find(|f| f.0 == "records/a.md");
        let a_was = before.into_iter().find(|f| f.0 == "records/a.md");
        assert_eq!(a_now, a_was, "bytes and mtime");
        let written: Vec<String> = rows(&vault).into_iter().map(|r| r.1).collect();
        assert_eq!(written, vec!["records/b.md".to_string()]);
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn a_rename_that_fails_midway_puts_every_page_back() {
        let _recording = Recording::new("batch-fault-config");
        let vault = vault_with(
            "batch-fault",
            &[
                ("records/a.md", A),
                ("records/b.md", B),
                ("records/c.md", C),
            ],
        );
        seams::FAIL_AT.store(2, Ordering::SeqCst);
        let outcome = apply(
            &vault,
            json!([
                { "op": "patch", "path": "records/a.md", "set": { "status": "done" } },
                { "op": "delete", "path": "records/b.md" },
                { "op": "patch", "path": "records/c.md", "set": { "status": "todo" } },
                { "op": "create", "path": "records/new.md", "content": "# New\n" },
            ]),
        );
        seams::FAIL_AT.store(usize::MAX, Ordering::SeqCst);
        let message = refusal(outcome);
        assert!(
            message.starts_with("Couldn't finish the change, so every page was put back: "),
            "{message}"
        );
        assert_eq!(read(&vault, "records/a.md").unwrap(), A);
        assert_eq!(read(&vault, "records/b.md").unwrap(), B);
        assert_eq!(read(&vault, "records/c.md").unwrap(), C);
        assert!(read(&vault, "records/new.md").is_none());
        assert!(temps(&vault).is_empty());
        assert!(trash::list_trash(&vault).unwrap().is_empty());
        assert_eq!(journal_rows(), 0);
        let _ = std::fs::remove_dir_all(&vault);
    }

    /// A journal row for a batch that renamed `records/a.md` and stopped
    /// before `records/b.md`, which a person has since edited by hand.
    fn unfinished(vault: &Path) -> String {
        let id = "e".repeat(32);
        let a_after = "---\nstatus: done\n---\n\n# A\n";
        let b_after = "---\nstatus: done\nestimate: S\n---\n\n# B\n";
        let file = |path: &str, before: &str, after: &str| JournalFile {
            path: path.into(),
            temp: Some(temp_rel(path)),
            before: Some(before.into()),
            before_hash: Some(hash(before)),
            after_hash: Some(hash(after)),
            trashed: None,
            restored: None,
            sidecar: None,
            moved_from: None,
        };
        let files = vec![
            file("records/a.md", A, a_after),
            file("records/b.md", B, b_after),
        ];
        testutil::write(vault, "records/a.md", a_after);
        testutil::write(vault, "records/b.md", "# B\n\nEdited by hand.\n");
        testutil::write(vault, files[1].temp.as_deref().unwrap(), b_after);
        batch_journal::begin(vault, &id, &files, HUMAN_ACTOR).unwrap();
        id
    }

    fn far_future() -> DateTime<Utc> {
        Utc::now() + chrono::Duration::days(1)
    }

    #[test]
    fn recovery_leaves_a_page_changed_since_alone() {
        let _recording = Recording::new("batch-recover-kept-config");
        let vault = testutil::temp_vault("batch-recover-kept");
        unfinished(&vault);
        let report = recover(&vault, far_future(), &recovery());
        assert_eq!(
            report,
            RecoveryReport {
                unfinished: 2,
                restored: 1,
                kept: 1
            }
        );
        assert_eq!(read(&vault, "records/a.md").unwrap(), A);
        assert_eq!(
            read(&vault, "records/b.md").unwrap(),
            "# B\n\nEdited by hand.\n"
        );
        assert!(temps(&vault).is_empty());
        assert_eq!(journal_rows(), 0);
        let stamped: Vec<(String, String, String)> = rows(&vault);
        assert_eq!(
            stamped,
            vec![(
                "vault.write".to_string(),
                "records/a.md".to_string(),
                BATCH_RECOVERY_ACTOR.to_string()
            )],
            "recovery records what it put back, stamped as itself"
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn recovery_twice_changes_nothing() {
        let _recording = Recording::new("batch-recover-twice-config");
        let vault = testutil::temp_vault("batch-recover-twice");
        unfinished(&vault);
        recover(&vault, far_future(), &recovery());
        let once = tree(&vault);
        let again = recover(&vault, far_future(), &recovery());
        assert_eq!(again, RecoveryReport::default());
        assert_eq!(tree(&vault), once);
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn recovery_leaves_a_batch_this_process_is_running_alone() {
        let _recording = Recording::new("batch-recover-live-config");
        let vault = vault_with("batch-recover-live", &[("records/a.md", A)]);
        let started = Utc::now() - chrono::Duration::seconds(1);
        let (parked, mut release) = park_next();
        let batch_vault = vault.clone();
        let batch = std::thread::spawn(move || {
            apply(
                &batch_vault,
                json!([{ "op": "patch", "path": "records/a.md", "set": { "status": "done" } }]),
            )
        });
        parked.recv_timeout(WAIT).expect("the batch parks");
        assert_eq!(journal_rows(), 1, "the parked batch is journaled");
        let report = recover(&vault, started, &recovery());
        assert_eq!(
            report,
            RecoveryReport::default(),
            "a live batch is not touched"
        );
        assert_eq!(temps(&vault).len(), 1, "its temp stays");
        let _ = release.0.take().map(|tx| tx.send(()));
        batch.join().unwrap().unwrap();
        assert_eq!(
            read(&vault, "records/a.md").unwrap(),
            "---\nstatus: done\n---\n\n# A\n"
        );
        assert_eq!(journal_rows(), 0);
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn batch_writes_record_human_rows() {
        let _recording = Recording::new("batch-rows-config");
        let vault = vault_with("batch-rows", &[("records/a.md", A), ("records/b.md", B)]);
        apply(
            &vault,
            json!([
                { "op": "patch", "path": "records/a.md", "set": { "status": "done" } },
                { "op": "delete", "path": "records/b.md" },
                { "op": "create", "path": "records/new.md", "content": "# New\n" },
            ]),
        )
        .unwrap();
        let me = HUMAN_ACTOR.to_string();
        let mut got = rows(&vault);
        got.sort();
        assert_eq!(
            got,
            vec![
                ("vault.create".into(), "records/new.md".into(), me.clone()),
                ("vault.delete".into(), "records/b.md".into(), me.clone()),
                ("vault.write".into(), "records/a.md".into(), me),
            ]
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    // --- Revert (M60.7) --------------------------------------------------------

    /// One revert op per page `applied` changed, as src/engine/undoPlan.ts
    /// `revertOps` builds them: a result whose hashes match and that moved
    /// nothing through the Trash is left out.
    fn revert_ops(applied: &BatchApplied) -> Value {
        Value::Array(
            applied
                .files
                .iter()
                .filter(|f| {
                    f.before_hash != f.after_hash || f.trashed.is_some() || f.restored.is_some()
                })
                .map(|f| {
                    json!({
                        "op": "revert",
                        "path": f.path,
                        "afterHash": f.after_hash,
                        "before": f.before,
                        "keys": f.keys,
                        "trashed": f.trashed,
                        "restored": f.restored,
                    })
                })
                .collect(),
        )
    }

    // The parity half: the mock (src/lib/mockIpc.test.ts) replays the same
    // reverts through its applyBatch.
    #[test]
    fn replays_the_shared_revert_cases() {
        let file: Value = serde_json::from_str(CASES).unwrap();
        for case in file["reverts"].as_array().unwrap() {
            let _recording = Recording::new("revert-cases-config");
            let name = case["name"].as_str().unwrap();
            let vault = testutil::temp_vault("revert-cases");
            let seed = case["seed"].as_object().unwrap();
            for (rel, text) in seed {
                testutil::write(&vault, rel, text.as_str().unwrap());
            }
            let first =
                apply(&vault, case["ops"].clone()).unwrap_or_else(|e| panic!("{name}: {e:?}"));
            let changed: Vec<(String, Option<String>)> = first
                .files
                .iter()
                .map(|f| (f.path.clone(), read(&vault, &f.path)))
                .collect();
            for (rel, text) in case["between"].as_object().into_iter().flatten() {
                match text.as_str() {
                    Some(text) => testutil::write(&vault, rel, text),
                    None => std::fs::remove_file(vault.join(rel)).unwrap(),
                }
            }
            if case["emptyTrash"] == json!(true) {
                std::fs::remove_dir_all(vault.join(trash::TRASH_DIR)).unwrap();
            }
            let before = tree(&vault);
            let rows_before = rows(&vault).len();
            let outcome = apply(&vault, revert_ops(&first));
            if let Some(fragment) = case["refused"].as_str() {
                let message = refusal(outcome);
                assert!(message.contains(fragment), "{name}: {message}");
                assert_eq!(
                    tree(&vault),
                    before,
                    "{name}: a refused undo changes nothing"
                );
                assert_eq!(
                    rows(&vault).len(),
                    rows_before,
                    "{name}: and records nothing"
                );
                let _ = std::fs::remove_dir_all(&vault);
                continue;
            }
            let undone = outcome.unwrap_or_else(|e| panic!("{name}: {e:?}"));
            let written: Vec<&str> = undone.files.iter().map(|f| f.path.as_str()).collect();
            let expected: Vec<&str> = case["written"]
                .as_array()
                .unwrap()
                .iter()
                .map(|p| p.as_str().unwrap())
                .collect();
            assert_eq!(written, expected, "{name}");
            for rel in case["exact"].as_array().into_iter().flatten() {
                let rel = rel.as_str().unwrap();
                assert_eq!(
                    read(&vault, rel).as_deref(),
                    seed[rel].as_str(),
                    "{name}: {rel}"
                );
            }
            for (rel, want) in case["after"].as_object().into_iter().flatten() {
                let text = read(&vault, rel);
                match want {
                    Value::Null => assert_eq!(text, None, "{name}: {rel} is absent"),
                    want => {
                        let text = text.unwrap_or_else(|| panic!("{name}: {rel} is missing"));
                        assert_eq!(frontmatter_of(&text), want["frontmatter"], "{name}: {rel}");
                        assert_eq!(body_of(&text), want["body"].as_str().unwrap(), "{name}");
                    }
                }
            }
            for (rel, want) in case["skipped"].as_object().into_iter().flatten() {
                let result = undone.files.iter().find(|f| &f.path == rel).unwrap();
                assert_eq!(
                    serde_json::to_value(&result.skipped).unwrap(),
                    *want,
                    "{name}"
                );
            }
            for (rel, bytes) in case["trashedAs"].as_object().into_iter().flatten() {
                let bytes = bytes.as_str().unwrap();
                assert_eq!(trashed_as(&vault, rel, bytes), 1, "{name}: {rel}");
            }
            if case["redo"] == json!(true) {
                apply(&vault, revert_ops(&undone)).unwrap_or_else(|e| panic!("{name}: {e:?}"));
                for (rel, bytes) in &changed {
                    assert_eq!(&read(&vault, rel), bytes, "{name}: redo puts back {rel}");
                }
            }
            assert!(temps(&vault).is_empty(), "{name}: no temp stays");
            assert_eq!(journal_rows(), 0, "{name}: no row stays");
            let _ = std::fs::remove_dir_all(&vault);
        }
    }

    #[test]
    fn revert_restores_exact_bytes_when_nothing_changed_since() {
        let _recording = Recording::new("revert-exact-config");
        // Comments and quoting a reserializing patch would drop.
        let quoted = "---\n# kept\nstatus: 'todo'\nsize:   M\n---\n\n# Q\n";
        let vault = vault_with(
            "revert-exact",
            &[("records/q.md", quoted), ("records/b.md", B)],
        );
        let applied = apply(
            &vault,
            json!([
                { "op": "patch", "path": "records/q.md", "set": { "status": "done" } },
                { "op": "patch", "path": "records/b.md", "set": { "estimate": null } },
            ]),
        )
        .unwrap();
        assert_ne!(read(&vault, "records/q.md").unwrap(), quoted);
        let undone = apply(&vault, revert_ops(&applied)).unwrap();
        assert_eq!(
            read(&vault, "records/q.md").unwrap(),
            quoted,
            "byte for byte"
        );
        assert_eq!(read(&vault, "records/b.md").unwrap(), B);
        assert!(undone.files.iter().all(|f| f.skipped.is_none()));
        assert_eq!(
            undone.files[1].keys,
            vec![KeyChange {
                key: "estimate".into(),
                before: Value::Null,
                after: json!("S")
            }],
            "its result holds the change it undid"
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn revert_skips_keys_changed_since_and_keeps_the_rest() {
        let _recording = Recording::new("revert-skip-config");
        let vault = vault_with("revert-skip", &[("records/a.md", A), ("records/b.md", B)]);
        let applied = apply(
            &vault,
            json!([
                { "op": "patch", "path": "records/a.md", "set": { "status": "done", "size": "S" } },
                { "op": "patch", "path": "records/b.md", "set": { "status": "done" } },
            ]),
        )
        .unwrap();
        // Someone moved a's status on by hand; its size and all of b stand.
        testutil::write(
            &vault,
            "records/a.md",
            "---\nstatus: review\nsize: S\n---\n\n# A\n\nMine.\n",
        );
        let undone = apply(&vault, revert_ops(&applied)).unwrap();
        let a = read(&vault, "records/a.md").unwrap();
        assert_eq!(frontmatter_of(&a), json!({ "status": "review" }));
        assert_eq!(
            body_of(&a),
            "\n# A\n\nMine.\n",
            "the body changed since stays"
        );
        assert_eq!(read(&vault, "records/b.md").unwrap(), B);
        assert_eq!(
            undone.files[0].skipped,
            Some(Skipped {
                keys: vec!["status".into()],
                reason: None
            })
        );
        assert_eq!(undone.files[1].skipped, None);
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn revert_of_a_changed_body_refuses_as_stale_content() {
        let _recording = Recording::new("revert-body-config");
        let vault = vault_with("revert-body", &[("records/a.md", A), ("records/b.md", B)]);
        let applied = apply(
            &vault,
            json!([
                { "op": "patch", "path": "records/b.md", "set": { "status": "done" } },
                { "op": "body", "path": "records/a.md", "body": "\n# A\n\nNew.\n" },
            ]),
        )
        .unwrap();
        testutil::write(
            &vault,
            "records/a.md",
            "---\nstatus: todo\n---\n\n# A\n\nMine.\n",
        );
        let before = tree(&vault);
        let outcome = apply(&vault, revert_ops(&applied));
        let Err(BatchError::Stale(stale)) = outcome else {
            panic!("expected Stale, got {outcome:?}");
        };
        assert_eq!(stale.path, "records/a.md");
        assert_eq!(tree(&vault), before, "nothing was undone, b included");
        assert_eq!(journal_rows(), 0);
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn revert_of_a_create_moves_it_to_the_trash() {
        let _recording = Recording::new("revert-create-config");
        let vault = testutil::temp_vault("revert-create");
        let applied = apply(
            &vault,
            json!([{ "op": "create", "path": "records/new.md", "content": "# New\n" }]),
        )
        .unwrap();
        let undone = apply(&vault, revert_ops(&applied)).unwrap();
        assert!(read(&vault, "records/new.md").is_none());
        assert_eq!(trashed_as(&vault, "records/new.md", "# New\n"), 1);
        assert!(undone.files[0].trashed.is_some());
        assert_eq!(undone.files[0].before.as_deref(), Some("# New\n"));
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn revert_of_a_delete_comes_back_unless_the_path_is_taken() {
        let _recording = Recording::new("revert-delete-config");
        let vault = vault_with("revert-delete", &[("records/a.md", A), ("records/b.md", B)]);
        let deleted = apply(
            &vault,
            json!([
                { "op": "delete", "path": "records/a.md" },
                { "op": "delete", "path": "records/b.md" },
            ]),
        )
        .unwrap();
        testutil::write(&vault, "records/b.md", "# Someone else\n");
        let before = tree(&vault);
        let message = refusal(apply(&vault, revert_ops(&deleted)));
        assert_eq!(message, trash::already_exists("records/b.md"));
        assert_eq!(tree(&vault), before, "a stays in the Trash too");
        std::fs::remove_file(vault.join("records/b.md")).unwrap();
        let undone = apply(&vault, revert_ops(&deleted)).unwrap();
        assert_eq!(read(&vault, "records/a.md").unwrap(), A, "identical bytes");
        assert_eq!(read(&vault, "records/b.md").unwrap(), B);
        assert_eq!(undone.files[0].restored, deleted.files[0].trashed);
        assert!(trash::list_trash(&vault).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn redo_is_the_revert_of_an_undo() {
        let _recording = Recording::new("revert-redo-config");
        let vault = vault_with("revert-redo", &[("records/a.md", A), ("records/b.md", B)]);
        let applied = apply(
            &vault,
            json!([
                { "op": "patch", "path": "records/a.md", "set": { "status": "done" } },
                { "op": "delete", "path": "records/b.md" },
                { "op": "create", "path": "records/new.md", "content": "# New\n" },
            ]),
        )
        .unwrap();
        let written = read(&vault, "records/a.md").unwrap();
        let undone = apply(&vault, revert_ops(&applied)).unwrap();
        assert_eq!(read(&vault, "records/a.md").unwrap(), A);
        assert_eq!(read(&vault, "records/b.md").unwrap(), B);
        assert!(read(&vault, "records/new.md").is_none());
        let redone = apply(&vault, revert_ops(&undone)).unwrap();
        assert_eq!(read(&vault, "records/a.md").unwrap(), written);
        assert!(read(&vault, "records/b.md").is_none());
        assert_eq!(read(&vault, "records/new.md").unwrap(), "# New\n");
        assert_eq!(trashed_as(&vault, "records/b.md", B), 1);
        // And undo again: the chain holds both ways.
        apply(&vault, revert_ops(&redone)).unwrap();
        assert_eq!(read(&vault, "records/a.md").unwrap(), A);
        assert_eq!(read(&vault, "records/b.md").unwrap(), B);
        let _ = std::fs::remove_dir_all(&vault);
    }

    /// An undo is the person's own change: its writes record as theirs.
    #[test]
    fn a_revert_records_human_rows() {
        let _recording = Recording::new("revert-rows-config");
        let vault = vault_with("revert-rows", &[("records/a.md", A)]);
        let applied = apply(
            &vault,
            json!([{ "op": "patch", "path": "records/a.md", "set": { "status": "done" } }]),
        )
        .unwrap();
        apply(&vault, revert_ops(&applied)).unwrap();
        let got: Vec<(String, String, String)> = rows(&vault);
        assert!(got.iter().all(|row| row.2 == HUMAN_ACTOR));
        assert_eq!(
            got.last().cloned().unwrap(),
            (
                "vault.write".into(),
                "records/a.md".into(),
                HUMAN_ACTOR.to_string()
            )
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    // --- Stopped batches (Mac-safe) --------------------------------------------
    //
    // A child process applies a batch and leaves at a stop point through
    // `std::process::exit`, never an abort; the parent opens the same
    // runtime database and recovers, as the next launch would.

    /// The ops every stopped batch applies: two patches and a delete.
    fn stopped_ops() -> Value {
        json!([
            { "op": "patch", "path": "records/a.md", "set": { "status": "done" } },
            { "op": "patch", "path": "records/b.md", "set": { "status": "done" } },
            { "op": "delete", "path": "records/c.md" },
        ])
    }

    #[test]
    #[ignore = "child body, spawned by the stopped-batch tests"]
    fn batch_stop_child() {
        let (Ok(config), Ok(vault)) = (
            std::env::var("CEREBRO_BATCH_CONFIG"),
            std::env::var("CEREBRO_BATCH_VAULT"),
        ) else {
            return;
        };
        crate::runtime::sink::arm(Path::new(&config)).unwrap();
        let _ = apply(Path::new(&vault), stopped_ops());
    }

    fn stopped_at(point: &str, label: &str) {
        let _lock = crate::runtime::sink::test_lock();
        crate::runtime::sink::disarm();
        let config = testutil::temp_vault(&format!("{label}-config"));
        let vault = vault_with(
            label,
            &[
                ("records/a.md", A),
                ("records/b.md", B),
                ("records/c.md", C),
            ],
        );
        let output = testutil::run_test_child(
            "vault::batch::tests::batch_stop_child",
            &[
                ("CEREBRO_STOP_POINT", std::ffi::OsStr::new(point)),
                ("CEREBRO_BATCH_CONFIG", config.as_os_str()),
                ("CEREBRO_BATCH_VAULT", vault.as_os_str()),
            ],
        );
        assert_eq!(
            output.status.code(),
            Some(86),
            "the child stops at {point}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        // Where the child left the vault.
        assert!(!temps(&vault).is_empty() || point != "batch-staged");
        crate::runtime::sink::arm(&config).unwrap();
        assert_eq!(journal_rows(), 1, "the stopped batch is still journaled");
        let report = recover(&vault, Utc::now(), &recovery());
        assert_eq!(
            report,
            RecoveryReport {
                unfinished: 3,
                restored: 3,
                kept: 0
            }
        );
        assert_eq!(read(&vault, "records/a.md").unwrap(), A);
        assert_eq!(read(&vault, "records/b.md").unwrap(), B);
        assert_eq!(read(&vault, "records/c.md").unwrap(), C);
        assert!(temps(&vault).is_empty());
        assert!(trash::list_trash(&vault).unwrap().is_empty());
        assert_eq!(journal_rows(), 0);
        crate::runtime::sink::disarm();
        for dir in [&vault, &config] {
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    #[test]
    fn a_batch_stopped_between_its_temps_and_renames_rolls_back_on_the_next_start() {
        stopped_at("batch-staged", "batch-stopped-staged");
    }

    #[test]
    fn a_batch_stopped_after_its_first_rename_rolls_back_on_the_next_start() {
        stopped_at("batch-renamed-first", "batch-stopped-renamed");
    }

    #[test]
    fn a_rename_op_moves_the_page_and_carries_its_comments() {
        let _recording = Recording::new("batch-rename-config");
        let vault = vault_with(
            "batch-rename",
            &[("notes/a.md", A), (".comments/notes/a.md.json", "comments")],
        );
        let applied = apply(
            &vault,
            json!([{ "op": "rename", "from": "notes/a.md", "to": "notes/b.md" }]),
        )
        .unwrap();
        assert_eq!(read(&vault, "notes/b.md").as_deref(), Some(A));
        assert_eq!(
            read(&vault, ".comments/notes/b.md.json").as_deref(),
            Some("comments")
        );
        assert!(!vault.join("notes/a.md").exists());
        assert!(!vault.join(".comments/notes/a.md.json").exists());
        assert_eq!(applied.files[0].moved_from.as_deref(), Some("notes/a.md"));
        assert_eq!(applied.files[0].after_hash, Some(hash(A)));
        assert_eq!(journal_rows(), 0);
        let _ = std::fs::remove_dir_all(vault);
    }

    #[test]
    fn rename_ops_follow_the_names_earlier_renames_leave() {
        let _recording = Recording::new("batch-folder-rename-config");
        let vault = vault_with(
            "batch-folder-rename",
            &[
                ("old/old.md", A),
                ("old/child.md", B),
                (".comments/old/old.md.json", "comments"),
            ],
        );
        let applied = apply(
            &vault,
            json!([
                { "op": "replace_file", "path": "old/old.md", "content": C, "expectHash": hash(A) },
                { "op": "rename", "from": "old", "to": "new" },
                { "op": "rename", "from": "new/old.md", "to": "new/new.md" }
            ]),
        )
        .unwrap();
        assert_eq!(read(&vault, "new/new.md").as_deref(), Some(C));
        assert_eq!(read(&vault, "new/child.md").as_deref(), Some(B));
        assert_eq!(
            read(&vault, ".comments/new/new.md.json").as_deref(),
            Some("comments")
        );
        assert!(!vault.join("old").exists());
        assert_eq!(applied.files[1].before_hash, None);
        assert_eq!(applied.files[2].before_hash, Some(hash(C)));
        let _ = std::fs::remove_dir_all(vault);
    }

    #[test]
    fn a_later_failure_puts_the_rename_back() {
        let _recording = Recording::new("batch-rename-failure-config");
        let vault = vault_with(
            "batch-rename-failure",
            &[
                ("notes/a.md", A),
                ("notes/citer.md", B),
                ("notes/other.md", C),
                (".comments/notes/a.md.json", "comments"),
            ],
        );
        let before = snapshot_bytes(&vault);
        seams::FAIL_AT.store(2, Ordering::SeqCst);
        let outcome = apply(
            &vault,
            json!([
                { "op": "replace_file", "path": "notes/citer.md", "content": "[[b]]\n", "expectHash": hash(B) },
                { "op": "rename", "from": "notes/a.md", "to": "notes/b.md" },
                { "op": "rename", "from": "notes/other.md", "to": "notes/last.md" }
            ]),
        );
        seams::FAIL_AT.store(usize::MAX, Ordering::SeqCst);
        assert!(refusal(outcome).contains("every page was put back"));
        assert_eq!(snapshot_bytes(&vault), before);
        assert_eq!(journal_rows(), 0);
        let _ = std::fs::remove_dir_all(vault);
    }

    fn snapshot_bytes(vault: &Path) -> Vec<(String, Vec<u8>)> {
        tree(vault)
            .into_iter()
            .map(|(path, bytes, _)| (path, bytes))
            .collect()
    }

    fn journal_move(from: &str, to: &str, before: Option<&str>) -> JournalFile {
        JournalFile {
            path: to.into(),
            moved_from: Some(from.into()),
            before: before.map(str::to_string),
            before_hash: before.map(hash),
            after_hash: before.map(hash),
            temp: None,
            trashed: None,
            restored: None,
            sidecar: None,
        }
    }

    #[test]
    fn recovery_renames_back_a_journaled_rename() {
        let _recording = Recording::new("batch-move-recovery-config");
        let vault = vault_with(
            "batch-move-recovery",
            &[("new/new.md", A), (".comments/new/new.md.json", "comments")],
        );
        batch_journal::begin(
            &vault,
            &"a".repeat(32),
            &[
                journal_move("old", "new", None),
                journal_move("new/old.md", "new/new.md", Some(A)),
            ],
            HUMAN_ACTOR,
        )
        .unwrap();
        let report = recover(
            &vault,
            Utc::now() + chrono::Duration::seconds(1),
            &recovery(),
        );
        assert_eq!((report.restored, report.kept), (2, 0));
        assert_eq!(read(&vault, "old/old.md").as_deref(), Some(A));
        assert_eq!(
            read(&vault, ".comments/old/old.md.json").as_deref(),
            Some("comments")
        );
        assert!(!vault.join("new").exists());
        assert_eq!(journal_rows(), 0);
        let _ = std::fs::remove_dir_all(vault);
    }

    #[test]
    fn recovery_leaves_an_unstarted_folder_and_main_rename_alone() {
        let _recording = Recording::new("batch-unstarted-moves-config");
        let vault = vault_with("batch-unstarted-moves", &[("old/old.md", A)]);
        let before = tree(&vault);
        batch_journal::begin(
            &vault,
            &"b".repeat(32),
            &[
                journal_move("old", "new", None),
                journal_move("new/old.md", "new/new.md", Some(A)),
            ],
            HUMAN_ACTOR,
        )
        .unwrap();
        let report = recover(
            &vault,
            Utc::now() + chrono::Duration::seconds(1),
            &recovery(),
        );
        assert_eq!((report.restored, report.kept), (2, 0));
        assert_eq!(tree(&vault), before);
        let _ = std::fs::remove_dir_all(vault);
    }

    #[test]
    fn recovery_rejoins_comments_when_either_half_of_a_move_stopped() {
        let _recording = Recording::new("batch-half-move-config");
        // A stop during apply leaves the page home and its comments moved;
        // a stop during rollback leaves the comments home and its page moved.
        for (page, comments) in [
            ("old/old.md", ".comments/new/old.md.json"),
            ("new/old.md", ".comments/old/old.md.json"),
        ] {
            let vault = vault_with("batch-half-move", &[(page, A), (comments, "comments")]);
            batch_journal::begin(
                &vault,
                &"c".repeat(32),
                &[
                    journal_move("old", "new", None),
                    journal_move("new/old.md", "new/new.md", Some(A)),
                ],
                HUMAN_ACTOR,
            )
            .unwrap();
            let report = recover(
                &vault,
                Utc::now() + chrono::Duration::seconds(1),
                &recovery(),
            );
            assert_eq!((report.restored, report.kept), (2, 0), "{page}");
            assert_eq!(read(&vault, "old/old.md").as_deref(), Some(A));
            assert_eq!(
                read(&vault, ".comments/old/old.md.json").as_deref(),
                Some("comments")
            );
            assert!(!vault.join("new").exists());
            assert!(!vault.join(".comments/new").exists());
            assert_eq!(journal_rows(), 0);
            let _ = std::fs::remove_dir_all(vault);
        }
    }

    #[test]
    fn recovery_of_a_split_move_keeps_both_comments_when_the_old_name_was_reused() {
        let _recording = Recording::new("batch-half-move-conflict-config");
        let vault = vault_with(
            "batch-half-move-conflict",
            &[
                ("notes/a.md", A),
                (".comments/notes/a.md.json", "new comments"),
                (".comments/notes/b.md.json", "original comments"),
            ],
        );
        batch_journal::begin(
            &vault,
            &"d".repeat(32),
            &[journal_move("notes/a.md", "notes/b.md", Some(A))],
            HUMAN_ACTOR,
        )
        .unwrap();
        let before = snapshot_bytes(&vault);
        recover(
            &vault,
            Utc::now() + chrono::Duration::seconds(1),
            &recovery(),
        );
        assert_eq!(snapshot_bytes(&vault), before);
        assert_eq!(journal_rows(), 1, "a conflicting recovery stays journaled");
        let _ = std::fs::remove_dir_all(vault);
    }

    #[test]
    fn a_batch_never_discards_an_orphan_sidecar_it_could_not_restore() {
        let _recording = Recording::new("batch-orphan-move-config");
        let vault = vault_with(
            "batch-orphan-move",
            &[("notes/a.md", A), (".comments/notes/b.md.json", "orphan")],
        );
        let before = tree(&vault);
        let outcome = apply(
            &vault,
            json!([{ "op": "rename", "from": "notes/a.md", "to": "notes/b.md" }]),
        );
        assert!(refusal(outcome).contains("target comments already exist: notes/b.md"));
        assert_eq!(tree(&vault), before);
        let _ = std::fs::remove_dir_all(vault);
    }

    #[test]
    fn a_failed_create_batch_removes_only_its_new_empty_parent_folders() {
        let _recording = Recording::new("batch-create-parents-config");
        for existing_records in [false, true] {
            let vault = testutil::temp_vault("batch-create-parents");
            if existing_records {
                std::fs::create_dir(vault.join("records")).unwrap();
            }
            seams::FAIL_AT.store(1, Ordering::SeqCst);
            let outcome = apply(
                &vault,
                json!([
                    { "op": "create", "path": "types/books.md", "content": "# Books\n" },
                    { "op": "create", "path": "records/books/dune.md", "content": "# Dune\n" }
                ]),
            );
            seams::FAIL_AT.store(usize::MAX, Ordering::SeqCst);
            assert!(refusal(outcome).contains("every page was put back"));
            assert!(!vault.join("types").exists());
            assert!(!vault.join("records/books").exists());
            assert_eq!(vault.join("records").exists(), existing_records);
            assert_eq!(trashed_as(&vault, "types/books.md", "# Books\n"), 1);
            assert!(temps(&vault).is_empty());
            assert_eq!(journal_rows(), 0);
            let _ = std::fs::remove_dir_all(vault);
        }
    }

    #[test]
    fn the_batch_records_its_rename_and_writes_stamped_as_you() {
        let _recording = Recording::new("batch-move-receipts-config");
        let vault = vault_with(
            "batch-move-receipts",
            &[("notes/a.md", A), ("notes/citer.md", B)],
        );
        apply(&vault, json!([
            { "op": "replace_file", "path": "notes/citer.md", "content": C, "expectHash": hash(B) },
            { "op": "rename", "from": "notes/a.md", "to": "notes/b.md" }
        ])).unwrap();
        assert_eq!(
            rows(&vault),
            vec![
                (
                    "vault.rename".into(),
                    "notes/a.md".into(),
                    HUMAN_ACTOR.into()
                ),
                (
                    "vault.write".into(),
                    "notes/citer.md".into(),
                    HUMAN_ACTOR.into()
                )
            ]
        );
        let _ = std::fs::remove_dir_all(vault);
    }

    #[test]
    #[ignore = "stop-point child, spawned by the link-keeping rename crash test on Linux"]
    fn crash_scenario_link_keeping_rename() {
        let (Ok(config), Ok(vault)) = (
            std::env::var("CEREBRO_BATCH_CONFIG"),
            std::env::var("CEREBRO_BATCH_VAULT"),
        ) else {
            return;
        };
        crate::runtime::sink::arm(Path::new(&config)).unwrap();
        let _ = apply(
            Path::new(&vault),
            json!([
                { "op": "replace_file", "path": "notes/citer.md", "content": "[[b]]\n", "expectHash": hash(B) },
                { "op": "rename", "from": "notes/a.md", "to": "notes/b.md" }
            ]),
        );
    }

    #[test]
    fn crash_a_link_keeping_rename_cut_after_its_rename_puts_everything_back() {
        link_keeping_rename_stopped_at("batch-renamed");
    }

    #[test]
    fn crash_a_link_keeping_rename_cut_between_comments_and_page_puts_everything_back() {
        link_keeping_rename_stopped_at("rename-comments-carried");
    }

    fn link_keeping_rename_stopped_at(point: &str) {
        let _lock = crate::runtime::sink::test_lock();
        crate::runtime::sink::disarm();
        let config = testutil::temp_vault("batch-link-rename-stop-config");
        let vault = vault_with(
            "batch-link-rename-stop",
            &[
                ("notes/a.md", A),
                ("notes/citer.md", B),
                (".comments/notes/a.md.json", "comments"),
            ],
        );
        let before = snapshot_bytes(&vault);
        let output = testutil::run_test_child(
            "vault::batch::tests::crash_scenario_link_keeping_rename",
            &[
                ("CEREBRO_STOP_POINT", std::ffi::OsStr::new(point)),
                ("CEREBRO_BATCH_CONFIG", config.as_os_str()),
                ("CEREBRO_BATCH_VAULT", vault.as_os_str()),
            ],
        );
        assert_eq!(output.status.code(), Some(86));
        crate::runtime::sink::arm(&config).unwrap();
        let report = recover(&vault, Utc::now(), &recovery());
        assert_eq!((report.restored, report.kept), (2, 0));
        assert_eq!(snapshot_bytes(&vault), before);
        assert_eq!(journal_rows(), 0);
        assert!(temps(&vault).is_empty());
        crate::runtime::sink::disarm();
        for dir in [vault, config] {
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    // --- Crash points (CI's Linux job) -----------------------------------------
    //
    // The same batch aborted at each crash point by the M21 harness. These
    // children abort, which wedges macOS, so the Mac's skip list leaves them
    // to CI.

    fn crash_config(vault: &Path) -> PathBuf {
        PathBuf::from(format!("{}-config", vault.display()))
    }

    #[test]
    #[ignore = "crash-scenario child body, spawned by the batch crash tests"]
    fn crash_scenario_batch() {
        let Ok(vault) = std::env::var("CEREBRO_CRASH_VAULT") else {
            return;
        };
        let vault = Path::new(&vault);
        crate::runtime::sink::arm(&crash_config(vault)).unwrap();
        let _ = apply(vault, stopped_ops());
    }

    /// Abort the batch at `point`, then recover as the next launch would.
    /// Returns the vault, for the caller's own asserts, and the report.
    fn crashed_at(point: &str, label: &str) -> (PathBuf, RecoveryReport) {
        let _lock = crate::runtime::sink::test_lock();
        crate::runtime::sink::disarm();
        let vault = vault_with(
            label,
            &[
                ("records/a.md", A),
                ("records/b.md", B),
                ("records/c.md", C),
            ],
        );
        let status = testutil::run_crash_scenario(
            "vault::batch::tests::crash_scenario_batch",
            point,
            &vault,
        );
        assert!(!status.success(), "{point}: the child must have aborted");
        crate::runtime::sink::arm(&crash_config(&vault)).unwrap();
        let report = recover(&vault, Utc::now(), &recovery());
        assert!(temps(&vault).is_empty(), "{point}: no temp stays");
        assert_eq!(journal_rows(), 0, "{point}: no row stays");
        crate::runtime::sink::disarm();
        let _ = std::fs::remove_dir_all(crash_config(&vault));
        (vault, report)
    }

    fn assert_put_back(vault: &Path) {
        assert_eq!(read(vault, "records/a.md").unwrap(), A);
        assert_eq!(read(vault, "records/b.md").unwrap(), B);
        assert_eq!(read(vault, "records/c.md").unwrap(), C);
        assert!(trash::list_trash(vault).unwrap().is_empty());
    }

    #[test]
    fn crash_batch_journaled_rolls_back() {
        let (vault, report) = crashed_at("batch-journaled", "batch-crash-journaled");
        assert_eq!(report.unfinished, 3);
        assert_put_back(&vault);
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn crash_batch_staged_rolls_back() {
        let (vault, report) = crashed_at("batch-staged", "batch-crash-staged");
        assert_eq!(report.unfinished, 3);
        assert_put_back(&vault);
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn crash_batch_mid_renames_rolls_back() {
        let (vault, report) = crashed_at("batch-renamed-first", "batch-crash-renames");
        assert_eq!((report.restored, report.kept), (3, 0));
        assert_put_back(&vault);
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn crash_batch_committed_keeps_every_new_byte() {
        let (vault, report) = crashed_at("batch-committed", "batch-crash-committed");
        assert_eq!(report, RecoveryReport::default());
        assert_eq!(
            read(&vault, "records/a.md").unwrap(),
            "---\nstatus: done\n---\n\n# A\n"
        );
        assert!(read(&vault, "records/c.md").is_none());
        assert_eq!(trashed_as(&vault, "records/c.md", C), 1);
        let _ = std::fs::remove_dir_all(&vault);
    }
}
