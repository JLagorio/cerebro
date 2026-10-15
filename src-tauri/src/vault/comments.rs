//! Page comments (M70.2): a page's threads live beside it, never in it.
//!
//! Each `.md` page may have one sidecar, `<vault>/.comments/<page path>.json`
//! (the M70.1 record settles the place: tracked by git, outside the scan).
//! Nothing here ever writes the page. A comment write takes the page's path
//! lock and the sidecar's (M55.1), reads the sidecar, applies one op and
//! writes it back through the atomic funnel (`write::write_file`), so two
//! writes take turns and neither loses the other. A rename or delete carries
//! the sidecar (`write::rename_note_with`; a delete into the vault's Trash
//! and back out, `trash::trash_locked` and `trash::untrash_locked`, M60.8).
//!
//! **Format v1**, the one format every later part writes: two-space JSON and a
//! final newline. Keys in order: file `{format, threads}`; thread `{anchor?,
//! resolved?, deleted?, comments}`; comment `{id, author, created, body,
//! deleted?, run_id?, state?, answers?}`; anchor `{quote, occurrence, before,
//! after}`; stamp `{at, by}`. An optional key is omitted when unset. A
//! thread's id is its first comment's. Ids are 16 lowercase hex characters
//! and times RFC 3339 UTC to the second. An author is `human:owner`,
//! `claude-code`, `process:<name>` or `agent:<id>`. `run_id` is the run an
//! agent's comment came from (`comment_tools.rs`, M70.3, writes it). `state`
//! and `answers` mark an agent's answer to a person's @mention (M70.4): the
//! thread turn posts a pending placeholder naming the comment it answers
//! (`agent::thread_turn`), and `settle_answer` replaces it in place. No
//! comment op writes either.
//!
//! A sidecar that does not parse reads as unavailable with its reason and is
//! never overwritten. The exact place a shape check failed goes to the
//! diagnostic log (M53.24), never into the message.
//!
//! Mirrored by `src/engine/comments.ts` and the mock (`src/lib/mockIpc.ts`);
//! all three replay `src-tauri/fixtures/comment-cases.json`.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::write;

/// The vault folder every sidecar lives under.
pub const COMMENTS_DIR: &str = ".comments";
/// The format this build writes, and the newest it reads.
pub const FORMAT: u64 = 1;
/// The most characters (code points) a comment's body holds.
pub const MAX_BODY_CHARS: usize = 10_000;
/// The most characters an anchor's quote holds.
pub const MAX_QUOTE_CHARS: usize = 1_000;
/// The most characters of context on each side of a quote.
pub const MAX_CONTEXT_CHARS: usize = 40;
/// The most bytes one sidecar may hold.
pub const MAX_FILE_BYTES: usize = 1024 * 1024;
/// The author every comment a person writes carries (D1: single user).
pub const OWNER: &str = "human:owner";

/// Why a sidecar can't be read: four reasons, in the words both backends use.
pub const CONFLICTED: &str = "it has unresolved merge conflict markers";
pub const NOT_JSON: &str = "it is not valid JSON";
pub const NEWER: &str = "it was written by a newer Cerebro";
pub const MISSHAPEN: &str = "it does not match the comments format";

// --- The format --------------------------------------------------------------

/// One page's sidecar.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CommentsFile {
    pub format: u64,
    pub threads: Vec<Thread>,
}

/// One thread: an anchor (none for a comment on the whole page), its stamps,
/// and its comments, oldest first.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Thread {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anchor: Option<Anchor>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved: Option<Stamp>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deleted: Option<Stamp>,
    pub comments: Vec<Comment>,
}

impl Thread {
    /// A thread's id is its first comment's (the shape check refuses a
    /// thread with none).
    pub fn id(&self) -> &str {
        self.comments.first().map_or("", |c| c.id.as_str())
    }
}

/// One comment. A deleted one keeps its place with an empty body.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Comment {
    pub id: String,
    pub author: String,
    pub created: String,
    pub body: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deleted: Option<Stamp>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<CommentState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub answers: Option<String>,
}

/// Where an agent's answer stands (M70.4's thread turn writes it).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CommentState {
    Pending,
    Answered,
    Failed,
}

/// What a thread is about, as text: the quote, which copy of it (from 1),
/// and the context on each side, in the page's reader text (M70.1).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Anchor {
    pub quote: String,
    pub occurrence: u64,
    pub before: String,
    pub after: String,
}

/// Who did something, and when.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Stamp {
    pub at: String,
    pub by: String,
}

impl CommentsFile {
    /// A page with no sidecar has no threads.
    pub fn empty() -> Self {
        CommentsFile {
            format: FORMAT,
            threads: Vec::new(),
        }
    }

    fn ids(&self) -> impl Iterator<Item = &str> {
        self.threads
            .iter()
            .flat_map(|t| t.comments.iter().map(|c| c.id.as_str()))
    }
}

// --- Paths -------------------------------------------------------------------

/// Is `rel` a page a sidecar may belong to: `/`-separated names, none empty
/// and none hidden as the scanner hears it (so no `.` or `..`), ending in
/// `.md`?
pub fn is_page(rel: &str) -> bool {
    let names: Vec<&str> = rel.split('/').collect();
    names
        .iter()
        .all(|n| !n.is_empty() && !super::scan::is_hidden(n))
        && rel.ends_with(".md")
}

/// Is `rel` a folder whose pages' sidecars may be mirrored?
fn is_page_folder(rel: &str) -> bool {
    rel.split('/')
        .all(|n| !n.is_empty() && !super::scan::is_hidden(n))
}

/// The sidecar of page `page`.
pub fn sidecar_rel(page: &str) -> String {
    format!("{COMMENTS_DIR}/{page}.json")
}

/// The folder holding the sidecars of every page under `folder`.
pub fn sidecar_folder_rel(folder: &str) -> String {
    format!("{COMMENTS_DIR}/{folder}")
}

/// The page a sidecar belongs to, or `None` when `rel` is no page's sidecar.
pub fn page_of_sidecar(rel: &str) -> Option<String> {
    let page = rel
        .strip_prefix(COMMENTS_DIR)?
        .strip_prefix('/')?
        .strip_suffix(".json")?;
    is_page(page).then(|| page.to_string())
}

/// What a rename or delete of `rel` carries: the sidecar of a page, the
/// mirrored folder of a folder, or nothing.
pub(crate) fn carried_rel(rel: &str, is_dir: bool) -> Option<String> {
    if is_dir {
        is_page_folder(rel).then(|| sidecar_folder_rel(rel))
    } else {
        is_page(rel).then(|| sidecar_rel(rel))
    }
}

// --- Parsing -----------------------------------------------------------------

/// A sidecar that can't be read: the reason, and where its shape broke.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Unreadable {
    pub reason: &'static str,
    /// A JSON pointer for the log; empty when the whole text is at fault.
    pub pointer: String,
}

fn misshapen(pointer: impl Into<String>) -> Unreadable {
    Unreadable {
        reason: MISSHAPEN,
        pointer: pointer.into(),
    }
}

/// Does a line start with a git conflict marker?
fn conflicted(text: &str) -> bool {
    text.split('\n').any(|line| {
        ["<<<<<<<", "|||||||", "=======", ">>>>>>>"]
            .iter()
            .any(|marker| line.starts_with(marker))
    })
}

/// A JSON number that is a whole number a double holds exactly, as
/// `JSON.parse` sees it, so `2.0` reads as `2` in both backends.
fn integer(value: &Value) -> Option<i64> {
    const SAFE: f64 = 9_007_199_254_740_991.0;
    value.as_i64().or_else(|| {
        value
            .as_f64()
            .filter(|f| f.fract() == 0.0 && f.abs() <= SAFE)
            .map(|f| f as i64)
    })
}

/// Read a sidecar's text: conflict markers, then JSON, then the format, then
/// the shape.
pub fn parse_comments(text: &str) -> Result<CommentsFile, Unreadable> {
    if conflicted(text) {
        return Err(Unreadable {
            reason: CONFLICTED,
            pointer: String::new(),
        });
    }
    let value: Value = serde_json::from_str(text).map_err(|_| Unreadable {
        reason: NOT_JSON,
        pointer: String::new(),
    })?;
    file_from_value(&value)
}

/// The format check and the shape check over a parsed value (the fixture's
/// file objects come through here too).
pub fn file_from_value(value: &Value) -> Result<CommentsFile, Unreadable> {
    if let Some(format) = value.get("format").and_then(integer) {
        if format > FORMAT as i64 {
            return Err(Unreadable {
                reason: NEWER,
                pointer: "/format".to_string(),
            });
        }
    }
    let root = object(value, "", &["format", "threads"], &[])?;
    if integer(&root["format"]) != Some(FORMAT as i64) {
        return Err(misshapen("/format"));
    }
    let Value::Array(raw_threads) = &root["threads"] else {
        return Err(misshapen("/threads"));
    };
    let mut seen = HashSet::new();
    let mut threads = Vec::with_capacity(raw_threads.len());
    for (i, raw) in raw_threads.iter().enumerate() {
        threads.push(thread_from_value(raw, &format!("/threads/{i}"), &mut seen)?);
    }
    Ok(CommentsFile {
        format: FORMAT,
        threads,
    })
}

fn object<'v>(
    value: &'v Value,
    at: &str,
    required: &[&str],
    optional: &[&str],
) -> Result<&'v Map<String, Value>, Unreadable> {
    let Value::Object(map) = value else {
        return Err(misshapen(at));
    };
    if let Some(key) = map
        .keys()
        .find(|k| !required.contains(&k.as_str()) && !optional.contains(&k.as_str()))
    {
        return Err(misshapen(format!("{at}/{key}")));
    }
    if let Some(key) = required.iter().find(|k| !map.contains_key(**k)) {
        return Err(misshapen(format!("{at}/{key}")));
    }
    Ok(map)
}

fn string<'v>(map: &'v Map<String, Value>, key: &str, at: &str) -> Result<&'v str, Unreadable> {
    map[key]
        .as_str()
        .ok_or_else(|| misshapen(format!("{at}/{key}")))
}

/// A string that must pass `check`.
fn checked(
    map: &Map<String, Value>,
    key: &str,
    at: &str,
    check: fn(&str) -> bool,
) -> Result<String, Unreadable> {
    let s = string(map, key, at)?;
    if check(s) {
        Ok(s.to_string())
    } else {
        Err(misshapen(format!("{at}/{key}")))
    }
}

/// An optional key, which may be absent but never `null`.
fn optional<'v, T>(
    map: &'v Map<String, Value>,
    key: &str,
    read: impl FnOnce(&'v Value) -> Result<T, Unreadable>,
) -> Result<Option<T>, Unreadable> {
    map.get(key).map(read).transpose()
}

fn thread_from_value(
    value: &Value,
    at: &str,
    seen: &mut HashSet<String>,
) -> Result<Thread, Unreadable> {
    let map = object(value, at, &["comments"], &["anchor", "resolved", "deleted"])?;
    let anchor = optional(map, "anchor", |v| {
        anchor_from_value(v, &format!("{at}/anchor"))
    })?;
    let resolved = optional(map, "resolved", |v| {
        stamp_from_value(v, &format!("{at}/resolved"))
    })?;
    let deleted = optional(map, "deleted", |v| {
        stamp_from_value(v, &format!("{at}/deleted"))
    })?;
    let Value::Array(raw) = &map["comments"] else {
        return Err(misshapen(format!("{at}/comments")));
    };
    if raw.is_empty() {
        return Err(misshapen(format!("{at}/comments")));
    }
    let mut comments = Vec::with_capacity(raw.len());
    for (i, c) in raw.iter().enumerate() {
        let at = format!("{at}/comments/{i}");
        let comment = comment_from_value(c, &at)?;
        if !seen.insert(comment.id.clone()) {
            return Err(misshapen(format!("{at}/id")));
        }
        comments.push(comment);
    }
    Ok(Thread {
        anchor,
        resolved,
        deleted,
        comments,
    })
}

fn anchor_from_value(value: &Value, at: &str) -> Result<Anchor, Unreadable> {
    let map = object(value, at, &["quote", "occurrence", "before", "after"], &[])?;
    let occurrence = integer(&map["occurrence"])
        .filter(|n| *n >= 1)
        .ok_or_else(|| misshapen(format!("{at}/occurrence")))?;
    Ok(Anchor {
        quote: string(map, "quote", at)?.to_string(),
        occurrence: occurrence as u64,
        before: string(map, "before", at)?.to_string(),
        after: string(map, "after", at)?.to_string(),
    })
}

fn stamp_from_value(value: &Value, at: &str) -> Result<Stamp, Unreadable> {
    let map = object(value, at, &["at", "by"], &[])?;
    Ok(Stamp {
        at: checked(map, "at", at, is_time)?,
        by: checked(map, "by", at, is_author)?,
    })
}

fn comment_from_value(value: &Value, at: &str) -> Result<Comment, Unreadable> {
    let map = object(
        value,
        at,
        &["id", "author", "created", "body"],
        &["deleted", "run_id", "state", "answers"],
    )?;
    let state = optional(map, "state", |v| match v.as_str() {
        Some("pending") => Ok(CommentState::Pending),
        Some("answered") => Ok(CommentState::Answered),
        Some("failed") => Ok(CommentState::Failed),
        _ => Err(misshapen(format!("{at}/state"))),
    })?;
    Ok(Comment {
        id: checked(map, "id", at, is_id)?,
        author: checked(map, "author", at, is_author)?,
        created: checked(map, "created", at, is_time)?,
        body: string(map, "body", at)?.to_string(),
        deleted: optional(map, "deleted", |v| {
            stamp_from_value(v, &format!("{at}/deleted"))
        })?,
        run_id: optional(map, "run_id", |_| checked(map, "run_id", at, is_run_id))?,
        state,
        answers: optional(map, "answers", |_| checked(map, "answers", at, is_id))?,
    })
}

/// Sixteen lowercase hex characters.
pub fn is_id(s: &str) -> bool {
    s.len() == 16 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// A name after `process:` or `agent:`: not blank, no control character.
fn is_name(s: &str) -> bool {
    !s.trim().is_empty() && !s.chars().any(char::is_control)
}

/// `human:owner`, `claude-code`, `process:<name>` or `agent:<id>`.
pub fn is_author(s: &str) -> bool {
    s == OWNER
        || s == crate::mcp::DEFAULT_ACTOR
        || s.strip_prefix("process:").is_some_and(is_name)
        || s.strip_prefix("agent:").is_some_and(is_name)
}

fn is_run_id(s: &str) -> bool {
    is_name(s)
}

/// RFC 3339 UTC to the second, a real calendar day: `2026-10-14T09:00:00Z`.
pub fn is_time(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 20 {
        return false;
    }
    let shape_ok = b.iter().enumerate().all(|(i, c)| match i {
        4 | 7 => *c == b'-',
        10 => *c == b'T',
        13 | 16 => *c == b':',
        19 => *c == b'Z',
        _ => c.is_ascii_digit(),
    });
    if !shape_ok {
        return false;
    }
    let num = |from: usize, to: usize| -> u32 { s[from..to].parse().unwrap_or(u32::MAX) };
    let (year, month, day) = (num(0, 4), num(5, 7), num(8, 10));
    let (hour, minute, second) = (num(11, 13), num(14, 16), num(17, 19));
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return false,
    };
    (1..=days).contains(&day) && hour < 24 && minute < 60 && second < 60
}

/// The bytes written: pretty JSON with a two-space indent, raw non-ASCII, and
/// a final newline.
pub fn serialize_comments(file: &CommentsFile) -> String {
    let mut text = serde_json::to_string_pretty(file).unwrap_or_default();
    text.push('\n');
    text
}

// --- Ops ---------------------------------------------------------------------

/// An anchor as a caller sends it, checked before it is stored. The
/// occurrence arrives signed so a bad one meets our words, not serde's.
#[derive(Debug, Clone, Deserialize)]
pub struct AnchorInput {
    pub quote: String,
    pub occurrence: i64,
    pub before: String,
    pub after: String,
}

/// One change to a page's threads.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum CommentOp {
    /// A new thread: about a passage, or the whole page with no anchor.
    Start {
        #[serde(default)]
        anchor: Option<AnchorInput>,
        body: String,
    },
    /// A comment at the end of a thread; it reopens a resolved one.
    Reply {
        thread: String,
        body: String,
    },
    /// Resolve or reopen. A closing note is posted in the same change, and
    /// only when the thread is being resolved.
    SetResolved {
        thread: String,
        resolved: bool,
        #[serde(default)]
        closing: Option<String>,
    },
    DeleteComment {
        thread: String,
        comment: String,
    },
    DeleteThread {
        thread: String,
    },
}

/// What an op needs besides the file: fresh ids (one per new comment), the
/// time, the author, the run that wrote it, and the page, for messages.
#[derive(Debug, Clone, Deserialize)]
pub struct OpContext {
    pub ids: Vec<String>,
    pub now: String,
    pub by: String,
    #[serde(default)]
    pub run_id: Option<String>,
    pub page: String,
}

/// A body as stored: trimmed, not empty, within the limit.
fn body_of(raw: &str) -> Result<String, String> {
    let body = raw.trim();
    if body.is_empty() {
        return Err("A comment needs some text.".to_string());
    }
    let n = body.chars().count();
    if n > MAX_BODY_CHARS {
        return Err(format!(
            "A comment holds at most {MAX_BODY_CHARS} characters; this one has {n}."
        ));
    }
    Ok(body.to_string())
}

fn anchor_of(input: &AnchorInput) -> Result<Anchor, String> {
    if input.quote.trim().is_empty() {
        return Err("A comment's quote can't be empty.".to_string());
    }
    let n = input.quote.chars().count();
    if n > MAX_QUOTE_CHARS {
        return Err(format!(
            "A comment's quote holds at most {MAX_QUOTE_CHARS} characters; this one has {n}."
        ));
    }
    if input.occurrence < 1 {
        return Err("A comment's occurrence counts from 1.".to_string());
    }
    if input.before.chars().count() > MAX_CONTEXT_CHARS
        || input.after.chars().count() > MAX_CONTEXT_CHARS
    {
        return Err(format!(
            "A comment's context holds at most {MAX_CONTEXT_CHARS} characters on each side."
        ));
    }
    Ok(Anchor {
        quote: input.quote.clone(),
        occurrence: input.occurrence as u64,
        before: input.before.clone(),
        after: input.after.clone(),
    })
}

fn new_comment(ctx: &OpContext, body: String) -> Result<Comment, String> {
    let id = ctx
        .ids
        .first()
        .cloned()
        .ok_or_else(|| "Cerebro had no fresh comment id to give.".to_string())?;
    Ok(Comment {
        id,
        author: ctx.by.clone(),
        created: ctx.now.clone(),
        body,
        deleted: None,
        run_id: ctx.run_id.clone(),
        state: None,
        answers: None,
    })
}

fn stamp(ctx: &OpContext) -> Stamp {
    Stamp {
        at: ctx.now.clone(),
        by: ctx.by.clone(),
    }
}

/// The index of thread `id`, or the refusal naming it.
fn find_thread(file: &CommentsFile, id: &str, page: &str) -> Result<usize, String> {
    file.threads
        .iter()
        .position(|t| t.id() == id)
        .ok_or_else(|| format!("No comment thread {id} on {page}."))
}

const DELETED_THREAD: &str = "That comment thread was deleted.";

/// Apply one op: the new file, `None` when nothing changes, or the refusal.
/// Pure: ids, time and author come in `ctx`.
pub fn apply_op(
    file: &CommentsFile,
    op: &CommentOp,
    ctx: &OpContext,
) -> Result<Option<CommentsFile>, String> {
    let mut next = file.clone();
    match op {
        CommentOp::Start { anchor, body } => {
            let body = body_of(body)?;
            let anchor = anchor.as_ref().map(anchor_of).transpose()?;
            next.threads.push(Thread {
                anchor,
                resolved: None,
                deleted: None,
                comments: vec![new_comment(ctx, body)?],
            });
        }
        CommentOp::Reply { thread, body } => {
            let i = find_thread(file, thread, &ctx.page)?;
            let t = &mut next.threads[i];
            if t.deleted.is_some() {
                return Err(DELETED_THREAD.to_string());
            }
            let body = body_of(body)?;
            t.comments.push(new_comment(ctx, body)?);
            t.resolved = None;
        }
        CommentOp::SetResolved {
            thread,
            resolved,
            closing,
        } => {
            let i = find_thread(file, thread, &ctx.page)?;
            let t = &mut next.threads[i];
            if t.deleted.is_some() {
                return Err(DELETED_THREAD.to_string());
            }
            if t.resolved.is_some() == *resolved {
                return Ok(None);
            }
            if !*resolved {
                t.resolved = None;
            } else {
                if let Some(closing) = closing {
                    let body = body_of(closing)?;
                    t.comments.push(new_comment(ctx, body)?);
                }
                t.resolved = Some(stamp(ctx));
            }
        }
        CommentOp::DeleteComment { thread, comment } => {
            let i = find_thread(file, thread, &ctx.page)?;
            let t = &mut next.threads[i];
            let j = t
                .comments
                .iter()
                .position(|c| c.id == *comment)
                .ok_or_else(|| format!("No comment {comment} in that thread."))?;
            if t.comments[j].deleted.is_some() {
                return Ok(None);
            }
            if t.deleted.is_some() {
                return Err(DELETED_THREAD.to_string());
            }
            t.comments[j].body = String::new();
            t.comments[j].deleted = Some(stamp(ctx));
            if t.comments.iter().all(|c| c.deleted.is_some()) {
                t.deleted = Some(stamp(ctx));
            }
        }
        CommentOp::DeleteThread { thread } => {
            let i = find_thread(file, thread, &ctx.page)?;
            let t = &mut next.threads[i];
            if t.deleted.is_some() {
                return Ok(None);
            }
            for c in t.comments.iter_mut().filter(|c| c.deleted.is_none()) {
                c.body = String::new();
                c.deleted = Some(stamp(ctx));
            }
            t.deleted = Some(stamp(ctx));
        }
    }
    Ok(Some(next))
}

// --- Disk ----------------------------------------------------------------------

/// The page a comment belongs to: a markdown note the note writers would
/// take (`note_join`: no dot-path, no non-note, nothing in `views/` or
/// `attachments/`, no bundle alias, no symlink out), that exists as a file.
/// A concept page in `knowledge/` qualifies: a comment writes no page byte,
/// so no knowledge guard applies.
pub fn comment_page(vault: &Path, page: &str) -> Result<PathBuf, String> {
    let joined = write::note_join(vault, page, write::MARKDOWN)?;
    if joined.is_file() {
        Ok(joined)
    } else {
        Err(format!("no note at {page}"))
    }
}

/// Where `page`'s sidecar is, judged by [`sidecar_join`].
fn sidecar_path(vault: &Path, page: &str) -> Result<(String, PathBuf), String> {
    let rel = sidecar_rel(page);
    let abs = sidecar_join(vault, &rel)?;
    Ok((rel, abs))
}

/// Where `rel`, a path under `.comments/`, is on disk, judged: contained in
/// the vault (`safe_join`, so a `.comments` linked out of it is refused, as
/// any escape is), with no name from `.comments` down a symlink, the leaf
/// included, and landing at `rel` up to case folding. Containment alone is
/// not enough: a `.comments`, or a folder in it, linked to `.git/`,
/// `.cerebro/` or `knowledge/` would carry a comment write, a rename's carry
/// or an orphan's trip to the OS Trash into that folder. Every sidecar read,
/// write, carry and orphan step goes through here (`rewrite`, `read_threads`,
/// `write::rename_note_with`, `trash::carry_out`/`carry_back`).
pub(crate) fn sidecar_join(vault: &Path, rel: &str) -> Result<PathBuf, String> {
    let under = rel
        .strip_prefix(COMMENTS_DIR)
        .is_some_and(|rest| rest.is_empty() || rest.starts_with('/'));
    if !under {
        return Err(format!("{rel} is not under {COMMENTS_DIR}/"));
    }
    let abs = write::safe_join(vault, rel)?;
    let linked = || format!("{rel} is reached through a link, so no comments are kept there");
    let mut at = vault.to_path_buf();
    for name in rel.split('/') {
        at.push(name);
        match std::fs::symlink_metadata(&at) {
            Ok(meta) if meta.file_type().is_symlink() => return Err(linked()),
            Ok(_) => {}
            Err(_) => break,
        }
    }
    let lands = write::landing_path(vault, rel).ok_or_else(linked)?;
    if lands.to_lowercase() != rel.to_lowercase() {
        return Err(linked());
    }
    Ok(abs)
}

/// A sidecar's bytes as a file, or the reason they can't be read, logged
/// with where.
fn parse_bytes(page: &str, text: &[u8]) -> Result<CommentsFile, String> {
    let parsed = std::str::from_utf8(text)
        .map_err(|_| Unreadable {
            reason: NOT_JSON,
            pointer: String::new(),
        })
        .and_then(parse_comments);
    parsed.map_err(|unreadable| {
        log::warn!(
            "comments: the sidecar of {page} can't be read at {:?}: {}",
            unreadable.pointer,
            unreadable.reason
        );
        unreadable.reason.to_string()
    })
}

/// A sidecar's bytes, or `None` when the page has none.
fn read_sidecar(abs: &Path) -> Result<Option<Vec<u8>>, String> {
    match std::fs::read(abs) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// `page`'s threads. No sidecar is zero threads; one that can't be read is
/// its reason, never an empty file (CV-05). Reads take no lock.
pub fn read_comments(vault: &Path, page: &str) -> Result<CommentsFile, String> {
    sidecar_path(vault, page)?;
    read_threads(vault, page)
        .map_err(|reason| format!("Comments for {page} can't be read: {reason}."))
}

/// `read_comments` with the bare reason a sidecar can't be read, for the
/// sentences an agent reads around it (`comment_tools.rs`, M70.3).
pub fn read_threads(vault: &Path, page: &str) -> Result<CommentsFile, String> {
    let (_, abs) = sidecar_path(vault, page)?;
    match read_sidecar(&abs)? {
        None => Ok(CommentsFile::empty()),
        Some(bytes) => parse_bytes(page, &bytes),
    }
}

/// The `list_comments` command: the page must exist, then its threads.
pub fn list_comments(vault: &Path, page: &str) -> Result<CommentsFile, String> {
    comment_page(vault, page)?;
    read_comments(vault, page)
}

/// Rewrite `page`'s sidecar under the page's and the sidecar's path locks:
/// the page must exist, the sidecar must read (an unreadable one refuses and
/// is never overwritten), `change` computes the next file (`None` writes
/// nothing), and the result must fit the cap and read back before it is
/// written. Records one `vault.comment` row for the sidecar under `actor`
/// and the run that asked (M58.1): a comment changes no page, so it never
/// reads as a change to one. M70.3 and M70.4 write through here too.
pub(crate) fn rewrite(
    vault: &Path,
    page: &str,
    actor: &str,
    run_id: Option<&str>,
    change: impl FnOnce(&CommentsFile) -> Result<Option<CommentsFile>, String>,
) -> Result<CommentsFile, String> {
    write::note_join(vault, page, write::MARKDOWN)?;
    let (rel, abs) = sidecar_path(vault, page)?;
    let lock = write::lock_paths(vault, &[page, &rel])?;
    comment_page(vault, page)?;
    let unreadable = |reason: String| {
        format!("Comments for {page} can't be read ({reason}), so nothing was written.")
    };
    let current = match read_sidecar(&abs).map_err(unreadable)? {
        None => CommentsFile::empty(),
        Some(bytes) => parse_bytes(page, &bytes).map_err(unreadable)?,
    };
    let Some(next) = change(&current)? else {
        return Ok(current);
    };
    let text = serialize_comments(&next);
    check_size(page, &text)?;
    if let Err(back) = parse_comments(&text) {
        return Err(format!(
            "Comments for {page} would not read back ({}), so nothing was written.",
            back.reason
        ));
    }
    write::write_file(&lock, &abs, &text)?;
    let hash = crate::ledger::sha256_hex(text.as_bytes());
    crate::runtime::vault_writes::record(
        vault,
        &crate::runtime::vault_writes::WriteRow {
            kind: "vault.comment",
            path: &rel,
            to: None,
            content_hash: Some(&hash),
            actor: Some(actor),
            run_id,
            approved_by: None,
        },
    );
    Ok(next)
}

/// The size cap, in the words both backends use.
pub fn check_size(page: &str, text: &str) -> Result<(), String> {
    if text.len() > MAX_FILE_BYTES {
        return Err(format!(
            "Comments for {page} would pass 1 MiB, so nothing was written."
        ));
    }
    Ok(())
}

/// An id no comment in `file` has.
pub(crate) fn fresh_id(file: &CommentsFile) -> String {
    loop {
        let id = format!("{:016x}", rand::random::<u64>());
        if !file.ids().any(|taken| taken == id) {
            return id;
        }
    }
}

/// Now, RFC 3339 UTC to the second.
pub(crate) fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

/// Apply one op to `page`'s sidecar as `by`, with the run that asked (`None`
/// for a person). Answers the file as written, or as it stands when the op
/// changed nothing.
pub fn write_comment(
    vault: &Path,
    page: &str,
    op: &CommentOp,
    by: &str,
    run_id: Option<&str>,
) -> Result<CommentsFile, String> {
    rewrite(vault, page, by, run_id, |file| {
        let ctx = OpContext {
            ids: vec![fresh_id(file)],
            now: now(),
            by: by.to_string(),
            run_id: run_id.map(str::to_string),
            page: page.to_string(),
        };
        apply_op(file, op, &ctx)
    })
}

/// What settling an agent's answer did (M70.4).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Settled {
    /// The placeholder now holds the answer, in its place.
    Written,
    /// The placeholder, or its thread, was deleted (or is no longer the
    /// run's pending one), so nothing was written.
    Gone,
}

/// Replace run `run_id`'s pending placeholder `comment` in `thread` with
/// `body`, now in `state`, under the sidecar's lock (M70.4). The comment
/// keeps its id, author and place. A deleted thread or comment, or one that
/// is no longer this run's pending placeholder, is `Gone` and writes nothing:
/// a person who deleted the placeholder dropped the answer.
#[expect(
    clippy::too_many_arguments,
    reason = "each names one part of the placeholder the thread turn bound"
)]
pub(crate) fn settle_answer(
    vault: &Path,
    page: &str,
    thread: &str,
    comment: &str,
    run_id: &str,
    actor: &str,
    body: &str,
    state: CommentState,
) -> Result<Settled, String> {
    let mut settled = Settled::Gone;
    rewrite(vault, page, actor, Some(run_id), |file| {
        let mut next = file.clone();
        let Some(t) = next
            .threads
            .iter_mut()
            .find(|t| t.id() == thread && t.deleted.is_none())
        else {
            return Ok(None);
        };
        let Some(c) = t.comments.iter_mut().find(|c| {
            c.id == comment
                && c.deleted.is_none()
                && c.state == Some(CommentState::Pending)
                && c.run_id.as_deref() == Some(run_id)
        }) else {
            return Ok(None);
        };
        c.body = body.to_string();
        c.state = Some(state);
        settled = Settled::Written;
        Ok(Some(next))
    })?;
    Ok(settled)
}

/// Every page that has a sidecar, by the sidecar's path, sorted. A folder
/// that can't be read lists nothing under it, and a `.comments` that is not a
/// real folder (a link, out of the vault or into it) lists nothing at all:
/// [`sidecar_join`] would refuse every read, and walkdir follows a root link
/// by default, so a `.comments -> ~` would walk the home folder on every open.
pub fn pages_with_threads(vault: &Path) -> Vec<String> {
    let root = vault.join(COMMENTS_DIR);
    match std::fs::symlink_metadata(&root) {
        Ok(m) if m.file_type().is_dir() => {}
        Ok(m) if m.file_type().is_symlink() => {
            log::warn!("comments: {COMMENTS_DIR} is a link, so no page's threads are listed");
            return Vec::new();
        }
        _ => return Vec::new(),
    }
    let mut pages: Vec<String> = walkdir::WalkDir::new(&root)
        .follow_root_links(false)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_file())
        .filter_map(|e| {
            let rel = e
                .path()
                .strip_prefix(vault)
                .ok()?
                .to_str()?
                .replace('\\', "/");
            page_of_sidecar(&rel)
        })
        .collect();
    pages.sort();
    pages
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::testutil;

    const CASES: &str = include_str!("../../fixtures/comment-cases.json");
    const PAGE: &str = "notes/plan.md";
    const PAGE_BYTES: &str =
        "---\nstatus: draft\n---\n\n# Plan\n\nWe ship on Thursdays, after the freeze.\n";

    fn cases() -> Value {
        serde_json::from_str(CASES).unwrap()
    }

    fn vault_with_page(label: &str) -> PathBuf {
        let vault = testutil::temp_vault(label);
        testutil::write(&vault, PAGE, PAGE_BYTES);
        vault
    }

    fn start(body: &str) -> CommentOp {
        CommentOp::Start {
            anchor: None,
            body: body.to_string(),
        }
    }

    fn sidecar(vault: &Path) -> PathBuf {
        vault.join(sidecar_rel(PAGE))
    }

    #[test]
    fn the_limits_match_the_fixture() {
        let limits = &cases()["limits"];
        assert_eq!(limits["dir"], COMMENTS_DIR);
        assert_eq!(limits["format"], FORMAT);
        assert_eq!(limits["body"], MAX_BODY_CHARS);
        assert_eq!(limits["quote"], MAX_QUOTE_CHARS);
        assert_eq!(limits["context"], MAX_CONTEXT_CHARS);
        assert_eq!(limits["file_bytes"], MAX_FILE_BYTES);
        assert_eq!(limits["owner"], OWNER);
    }

    #[test]
    fn replays_the_shared_comment_cases() {
        let cases = cases();
        for row in cases["paths"].as_array().unwrap() {
            if let Some(folder) = row.get("folder").and_then(Value::as_str) {
                assert_eq!(sidecar_folder_rel(folder), row["sidecar_folder"], "{row}");
                continue;
            }
            let side = row["sidecar"].as_str().unwrap();
            match row["page"].as_str() {
                Some(page) => {
                    assert_eq!(sidecar_rel(page), side, "{row}");
                    assert_eq!(page_of_sidecar(side).as_deref(), Some(page), "{row}");
                    assert!(is_page(page), "{row}");
                }
                None => assert_eq!(page_of_sidecar(side), None, "{row}"),
            }
        }
        for row in cases["parse"].as_array().unwrap() {
            let name = row["name"].as_str().unwrap();
            let parsed = parse_comments(row["text"].as_str().unwrap());
            match row.get("reason") {
                Some(reason) => assert_eq!(parsed.unwrap_err().reason, reason, "{name}"),
                None => assert_eq!(
                    serde_json::to_value(parsed.unwrap_or_else(|e| panic!("{name}: {e:?}")))
                        .unwrap(),
                    row["file"],
                    "{name}"
                ),
            }
        }
        for row in cases["ops"].as_array().unwrap() {
            let name = row["name"].as_str().unwrap();
            let before = match &row["before"] {
                Value::Null => CommentsFile::empty(),
                value => file_from_value(value).unwrap_or_else(|e| panic!("{name}: {e:?}")),
            };
            let op: CommentOp = serde_json::from_value(row["op"].clone()).unwrap();
            let ctx: OpContext = serde_json::from_value(row["ctx"].clone()).unwrap();
            let outcome = apply_op(&before, &op, &ctx);
            match &row["after"] {
                Value::String(s) if s == "unchanged" => {
                    assert_eq!(outcome, Ok(None), "{name}")
                }
                Value::Object(o) if o.contains_key("error") => {
                    assert_eq!(outcome.unwrap_err(), o["error"], "{name}")
                }
                after => {
                    let next = outcome
                        .unwrap_or_else(|e| panic!("{name}: {e}"))
                        .unwrap_or_else(|| panic!("{name}: unchanged"));
                    assert_eq!(serde_json::to_value(&next).unwrap(), *after, "{name}");
                    // Every file an op writes reads back as itself.
                    assert_eq!(
                        parse_comments(&serialize_comments(&next)),
                        Ok(next),
                        "{name}"
                    );
                }
            }
        }
        for row in cases["bytes"].as_array().unwrap() {
            let name = row["name"].as_str().unwrap();
            let file = file_from_value(&row["file"]).unwrap_or_else(|e| panic!("{name}: {e:?}"));
            assert_eq!(serialize_comments(&file), row["text"], "{name}");
        }
    }

    /// The page's bytes and modification time, to the nanosecond.
    fn page_state(vault: &Path) -> (Vec<u8>, std::time::SystemTime) {
        let path = vault.join(PAGE);
        (
            std::fs::read(&path).unwrap(),
            std::fs::metadata(&path).unwrap().modified().unwrap(),
        )
    }

    #[test]
    fn a_comment_never_touches_the_page_bytes() {
        let vault = vault_with_page("comments-page-bytes");
        let before = page_state(&vault);
        let anchored = CommentOp::Start {
            anchor: Some(AnchorInput {
                quote: "after the freeze".into(),
                occurrence: 1,
                before: "We ship on Thursdays, ".into(),
                after: ".".into(),
            }),
            body: "Is this right?".into(),
        };
        let file = write_comment(&vault, PAGE, &anchored, OWNER, None).unwrap();
        assert_eq!(page_state(&vault), before);
        let thread = file.threads[0].id().to_string();
        let reply = write_comment(
            &vault,
            PAGE,
            &CommentOp::Reply {
                thread: thread.clone(),
                body: "Yes.".into(),
            },
            OWNER,
            None,
        )
        .unwrap();
        assert_eq!(page_state(&vault), before);
        let second = reply.threads[0].comments[1].id.clone();
        let ops = [
            CommentOp::SetResolved {
                thread: thread.clone(),
                resolved: true,
                closing: None,
            },
            CommentOp::SetResolved {
                thread: thread.clone(),
                resolved: false,
                closing: None,
            },
            CommentOp::DeleteComment {
                thread: thread.clone(),
                comment: second,
            },
            start("The whole page."),
            CommentOp::DeleteThread {
                thread: thread.clone(),
            },
        ];
        for op in &ops {
            let written = write_comment(&vault, PAGE, op, OWNER, None).unwrap();
            assert_eq!(page_state(&vault), before, "{op:?}");
            assert_eq!(read_comments(&vault, PAGE).unwrap(), written, "{op:?}");
        }
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn a_concept_page_takes_comments() {
        let vault = testutil::temp_vault("comments-concept");
        let concept = "knowledge/systems/status-model.md";
        let bytes = "---\ntype: System\n---\n\n# Status model\n";
        testutil::write(&vault, concept, bytes);
        let file = write_comment(&vault, concept, &start("Still true?"), OWNER, None).unwrap();
        assert_eq!(file.threads.len(), 1);
        assert_eq!(std::fs::read_to_string(vault.join(concept)).unwrap(), bytes);
        assert!(vault
            .join(".comments/knowledge/systems/status-model.md.json")
            .is_file());
        // The bundle by another name is still refused, by the note door.
        let err = write_comment(
            &vault,
            "Knowledge/systems/status-model.md",
            &start("x"),
            OWNER,
            None,
        )
        .unwrap_err();
        assert!(err.contains("inside knowledge/ by another name"), "{err}");
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn the_scan_search_and_folder_list_never_see_a_sidecar() {
        let vault = vault_with_page("comments-unseen");
        write_comment(&vault, PAGE, &start("zebracorn remark"), OWNER, None).unwrap();
        // A sidecar named like a page, too.
        testutil::write(&vault, ".comments/notes/plan.md", "# zebracorn\n");
        let entries = crate::vault::scan::scan_vault(&vault).unwrap();
        assert_eq!(
            entries.iter().map(|e| e.path.as_str()).collect::<Vec<_>>(),
            vec![PAGE]
        );
        // Search ranks the scan's entries (mcp.rs search_notes), so a body the
        // scan never holds is a body search never finds.
        assert!(entries
            .iter()
            .all(|e| !format!("{e:?}").contains("zebracorn")));
        let folders = crate::vault::scan::list_folders(&vault).unwrap();
        assert!(
            folders.iter().all(|f| !f.contains(".comments")),
            "{folders:?}"
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn an_unreadable_sidecar_is_never_overwritten() {
        let vault = vault_with_page("comments-unreadable");
        let rows = [
            (
                "<<<<<<< HEAD\n{}\n=======\n{}\n>>>>>>> theirs\n",
                CONFLICTED,
            ),
            ("{not json", NOT_JSON),
            ("{\"format\":2,\"threads\":[]}\n", NEWER),
        ];
        for (text, reason) in rows {
            testutil::write(&vault, &sidecar_rel(PAGE), text);
            assert_eq!(
                read_comments(&vault, PAGE).unwrap_err(),
                format!("Comments for {PAGE} can't be read: {reason}.")
            );
            assert_eq!(
                write_comment(&vault, PAGE, &start("Hm."), OWNER, None).unwrap_err(),
                format!("Comments for {PAGE} can't be read ({reason}), so nothing was written.")
            );
            assert_eq!(std::fs::read_to_string(sidecar(&vault)).unwrap(), text);
        }
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn an_absent_sidecar_reads_as_no_threads() {
        let vault = vault_with_page("comments-absent");
        assert_eq!(list_comments(&vault, PAGE).unwrap(), CommentsFile::empty());
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn a_comment_needs_a_markdown_note_that_exists() {
        let vault = vault_with_page("comments-targets");
        testutil::write(&vault, ".x/a.md", "# A\n");
        testutil::write(&vault, "a.mmd", "flowchart LR\n");
        testutil::write(&vault, "views/a.md", "# A\n");
        for (page, words) in [
            (".x/a.md", "dot-folders and dotfiles hold no notes"),
            ("a.mmd", "only .md files are notes"),
            ("views/a.md", "views/ and attachments/ hold no notes"),
            ("../a.md", "path escapes the vault"),
            ("notes/missing.md", "no note at notes/missing.md"),
            ("notes", "only .md files are notes"),
        ] {
            let err = write_comment(&vault, page, &start("Hm."), OWNER, None).unwrap_err();
            assert!(err.contains(words), "{page}: {err}");
            let listed = list_comments(&vault, page).unwrap_err();
            assert!(listed.contains(words), "{page}: {listed}");
        }
        assert!(!vault.join(COMMENTS_DIR).exists(), "nothing was written");
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[cfg(unix)]
    #[test]
    fn a_comments_folder_linked_out_of_the_vault_is_refused() {
        let vault = vault_with_page("comments-linked");
        let outside = testutil::temp_vault("comments-linked-outside");
        std::os::unix::fs::symlink(&outside, vault.join(COMMENTS_DIR)).unwrap();
        let err = write_comment(&vault, PAGE, &start("Hm."), OWNER, None).unwrap_err();
        assert!(err.contains("path escapes the vault"), "{err}");
        let err = read_comments(&vault, PAGE).unwrap_err();
        assert!(err.contains("path escapes the vault"), "{err}");
        assert_eq!(std::fs::read_dir(&outside).unwrap().count(), 0);
        // The vault-open listing never walks the folder the link points at.
        testutil::write(&outside, "notes/plan.md.json", "{}\n");
        assert!(pages_with_threads(&vault).is_empty());
        for dir in [&vault, &outside] {
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    /// The bytes of every file under `dir`, by path.
    fn files_under(dir: &Path) -> Vec<(PathBuf, Vec<u8>)> {
        let mut files: Vec<_> = walkdir::WalkDir::new(dir)
            .into_iter()
            .filter_map(Result::ok)
            .filter(|e| e.file_type().is_file())
            .map(|e| (e.path().to_path_buf(), std::fs::read(e.path()).unwrap()))
            .collect();
        files.sort();
        files
    }

    #[test]
    fn a_comments_folder_linked_inside_the_vault_is_refused() {
        for (label, target, link) in [
            ("comments-to-git", ".git", COMMENTS_DIR),
            ("comments-to-knowledge", "knowledge", COMMENTS_DIR),
            ("comments-folder-to-cerebro", ".cerebro", ".comments/notes"),
        ] {
            let vault = vault_with_page(label);
            testutil::write(&vault, &format!("{target}/notes/plan.md.json"), "{}\n");
            testutil::write(&vault, &format!("{target}/plan.md.json"), "{}\n");
            let link = vault.join(link);
            std::fs::create_dir_all(link.parent().unwrap()).unwrap();
            std::os::unix::fs::symlink(vault.join(target), &link).unwrap();
            let before = files_under(&vault.join(target));
            let err = write_comment(&vault, PAGE, &start("Hm."), OWNER, None).unwrap_err();
            assert!(err.contains("reached through a link"), "{label}: {err}");
            let err = read_comments(&vault, PAGE).unwrap_err();
            assert!(err.contains("reached through a link"), "{label}: {err}");
            assert_eq!(files_under(&vault.join(target)), before, "{label}");
            if link.ends_with(COMMENTS_DIR) {
                assert!(pages_with_threads(&vault).is_empty(), "{label}");
            }
            let _ = std::fs::remove_dir_all(&vault);
        }
    }

    #[test]
    fn a_sidecar_that_is_a_link_is_refused() {
        let vault = vault_with_page("comments-leaf-link");
        testutil::write(&vault, ".git/config", "[core]\n");
        std::fs::create_dir_all(sidecar(&vault).parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(vault.join(".git/config"), sidecar(&vault)).unwrap();
        let err = write_comment(&vault, PAGE, &start("Hm."), OWNER, None).unwrap_err();
        assert!(err.contains("reached through a link"), "{err}");
        assert!(read_comments(&vault, PAGE).is_err());
        assert_eq!(
            std::fs::read_to_string(vault.join(".git/config")).unwrap(),
            "[core]\n"
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn two_comment_writes_on_one_page_both_land() {
        let vault = vault_with_page("comments-two-writers");
        let threads: Vec<_> = (0..8)
            .map(|n| {
                let dir = vault.clone();
                std::thread::spawn(move || {
                    write_comment(&dir, PAGE, &start(&format!("Comment {n}")), OWNER, None)
                })
            })
            .collect();
        for t in threads {
            t.join().unwrap().unwrap();
        }
        let file = read_comments(&vault, PAGE).unwrap();
        let mut bodies: Vec<_> = file
            .threads
            .iter()
            .map(|t| t.comments[0].body.clone())
            .collect();
        bodies.sort();
        assert_eq!(
            bodies,
            (0..8).map(|n| format!("Comment {n}")).collect::<Vec<_>>()
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn a_comment_write_is_recorded_as_a_vault_comment() {
        let _sink = crate::runtime::sink::test_lock();
        let config = testutil::temp_vault("comments-recorded-config");
        let vault = vault_with_page("comments-recorded");
        crate::runtime::sink::arm(&config).unwrap();
        write_comment(&vault, PAGE, &start("Recorded."), OWNER, None).unwrap();
        let mine = std::fs::read_to_string(sidecar(&vault)).unwrap();
        write_comment(
            &vault,
            PAGE,
            &start("Noted."),
            "process:scout",
            Some("run-1"),
        )
        .unwrap();
        let theirs = std::fs::read_to_string(sidecar(&vault)).unwrap();
        let vault_id = crate::runtime::scope::derive_vault_id(&vault);
        type Row = (
            String,
            String,
            Option<String>,
            Option<String>,
            Option<String>,
        );
        let rows: Vec<Row> = crate::runtime::sink::with_sink(|conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT kind, path, content_hash, actor, run_id FROM vault_writes \
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
        .unwrap();
        // A comment changes no page, so it is its own kind, never a write.
        assert_eq!(
            rows,
            vec![
                (
                    "vault.comment".to_string(),
                    ".comments/notes/plan.md.json".to_string(),
                    Some(crate::ledger::sha256_hex(mine.as_bytes())),
                    Some(OWNER.to_string()),
                    None,
                ),
                (
                    "vault.comment".to_string(),
                    ".comments/notes/plan.md.json".to_string(),
                    Some(crate::ledger::sha256_hex(theirs.as_bytes())),
                    Some("process:scout".to_string()),
                    Some("run-1".to_string()),
                ),
            ]
        );
        crate::runtime::sink::disarm();
        for dir in [&vault, &config] {
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    #[test]
    fn a_file_past_one_mebibyte_is_refused() {
        let vault = vault_with_page("comments-cap");
        // Fill a file to just under the cap with 9,000-character comments,
        // then ask for one more of 10,000, which cannot fit.
        let mut file = CommentsFile::empty();
        let comment = |n: u64| Comment {
            id: format!("{n:016x}"),
            author: OWNER.into(),
            created: "2026-10-14T09:00:00Z".into(),
            body: "x".repeat(9_000),
            deleted: None,
            run_id: None,
            state: None,
            answers: None,
        };
        let mut n = 0;
        while serialize_comments(&file).len() + 9_300 <= MAX_FILE_BYTES {
            file.threads.push(Thread {
                anchor: None,
                resolved: None,
                deleted: None,
                comments: vec![comment(n)],
            });
            n += 1;
        }
        let text = serialize_comments(&file);
        assert!(text.len() < MAX_FILE_BYTES, "{}", text.len());
        testutil::write(&vault, &sidecar_rel(PAGE), &text);
        let err =
            write_comment(&vault, PAGE, &start(&"y".repeat(10_000)), OWNER, None).unwrap_err();
        assert_eq!(
            err,
            format!("Comments for {PAGE} would pass 1 MiB, so nothing was written.")
        );
        assert_eq!(std::fs::read_to_string(sidecar(&vault)).unwrap(), text);
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn a_file_that_would_not_read_back_is_never_written() {
        let vault = vault_with_page("comments-read-back");
        let err = write_comment(&vault, PAGE, &start("Hm."), "nobody", None).unwrap_err();
        assert_eq!(
            err,
            format!(
                "Comments for {PAGE} would not read back ({MISSHAPEN}), so nothing was written."
            )
        );
        assert!(!sidecar(&vault).exists());
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn fresh_ids_never_repeat_in_a_file() {
        let mut file = CommentsFile::empty();
        let mut seen = HashSet::new();
        for _ in 0..500 {
            let id = fresh_id(&file);
            assert!(is_id(&id), "{id}");
            assert!(seen.insert(id.clone()), "{id} repeated");
            file.threads.push(Thread {
                anchor: None,
                resolved: None,
                deleted: None,
                comments: vec![Comment {
                    id,
                    author: OWNER.into(),
                    created: "2026-10-14T09:00:00Z".into(),
                    body: "x".into(),
                    deleted: None,
                    run_id: None,
                    state: None,
                    answers: None,
                }],
            });
        }
        assert!(is_time(&now()), "{}", now());
    }
}
