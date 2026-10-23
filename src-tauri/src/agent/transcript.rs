//! Claude Code's own session file for a vault, found and read back (M56.3).
//!
//! Cerebro spawns Claude Code with the vault as its cwd, and the CLI writes
//! every turn of a session to `<config home>/projects/<key>/<session>.jsonl`.
//! That file is the transcript: the panel's localStorage keeps only a cached
//! copy, and a thread whose copy is gone rebuilds from the file through the
//! same fold the live stream goes through (`super::fold`). A session's
//! subagents keep transcripts of their own beside it (M91.3b),
//! `<session>/subagents/agent-<agent id>.jsonl` with a `.meta.json` each:
//! this module finds and reads them, and the fold merges them in and says
//! what they mean (CV-27).
//!
//! Three things here must match CLI 2.1.250 exactly, or the file is never
//! found and a live thread reads as cleared:
//!
//! - **The key** (`cli_key`): the NFC form of the vault's real path, with every
//!   UTF-16 unit outside `[A-Za-z0-9]` turned into `-`. Past 200 units it keeps
//!   the first 200, then `-` and base36 of the absolute 32-bit Java string hash
//!   of the path. `fixtures/cli-slugs.json` holds vectors node computed with
//!   that rule, and the live check names the folders the CLI made.
//! - **The config home** (`config_home`): `CLAUDE_CONFIG_DIR`, resolved against
//!   the vault when relative or empty, else `~/.claude`. With a non-empty
//!   `CLAUDE_CONFIG_DIR`, a valid `CLAUDE_CODE_PROJECT_DIR_NAME` replaces the
//!   key, and the folder it names is shared with whatever else names it.
//! - **The retention** (`retention_from`): `cleanupPeriodDays` in
//!   `<config home>/settings.json`, 30 when unset, and no sweep at all when it
//!   is not a positive integer or the file cannot be read. The CLI sweeps a
//!   session by its file's mtime, so a missing file is read as swept only once
//!   the conversation's last turn is at least that old.
//!
//! The env is read here and never set (M53.21): every rule has a pure seam
//! (`CliEnv`) that tests drive instead.
//!
//! A session id is accepted only as a lowercase UUID (`parse_session_id`), so
//! a stored id can neither become a CLI flag nor leave the projects folder.
//! A branch (M91.6) names its source session and the line it forks at the
//! same way, and the line is checked against the source's file through the
//! fold before anything runs (`check_fork`).

use std::collections::VecDeque;
use std::ffi::OsString;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use unicode_normalization::UnicodeNormalization;

use super::fold::{LineClass, SessionFold, SubagentTranscript};
use super::AgentEvent;

/// The CLI version the key rule, the retention rule and the fixtures name.
pub const CLI_VERSION: &str = "2.1.250";

/// How many UTF-16 units of a key the CLI keeps before it adds a hash.
const KEY_UNITS: usize = 200;

/// The retention Claude Code applies when its settings name none.
pub const DEFAULT_RETENTION_DAYS: u32 = 30;

/// The process environment the locator reads, as plain values so a test can
/// build one without touching the real env.
#[derive(Debug, Clone, Default)]
pub struct CliEnv {
    /// `CLAUDE_CONFIG_DIR`, as set (possibly empty).
    pub config_dir: Option<OsString>,
    /// `CLAUDE_CODE_PROJECT_DIR_NAME`, as set.
    pub project_dir_name: Option<OsString>,
    /// `HOME`.
    pub home: Option<PathBuf>,
}

impl CliEnv {
    /// The environment Cerebro was started with, and so the one its CLI
    /// children inherit. Read only.
    pub fn from_process() -> Self {
        Self {
            config_dir: std::env::var_os("CLAUDE_CONFIG_DIR"),
            project_dir_name: std::env::var_os("CLAUDE_CODE_PROJECT_DIR_NAME"),
            home: std::env::var_os("HOME").map(PathBuf::from),
        }
    }
}

/// Where the CLI keeps one vault's sessions.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CliProjectDir {
    /// `<config home>/projects`, the folder every key lives in.
    pub projects: PathBuf,
    /// `<projects>/<key>`.
    pub dir: PathBuf,
    /// True when `CLAUDE_CODE_PROJECT_DIR_NAME` chose the folder, so it may
    /// hold other projects' sessions too.
    pub shared: bool,
}

impl CliProjectDir {
    /// The config home the projects folder sits in.
    pub fn config_home(&self) -> &Path {
        self.projects.parent().unwrap_or(&self.projects)
    }
}

/// The Java string hash of `text`, over its UTF-16 units, as the CLI's
/// bundle computes it.
fn java_hash(text: &str) -> i32 {
    text.encode_utf16().fold(0i32, |hash, unit| {
        hash.wrapping_mul(31).wrapping_add(i32::from(unit))
    })
}

fn base36(mut n: u64) -> String {
    const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if n == 0 {
        return "0".into();
    }
    let mut out = Vec::new();
    while n > 0 {
        out.push(DIGITS[(n % 36) as usize]);
        n /= 36;
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

/// The folder name CLI 2.1.250 gives a project at `path` (already real).
pub fn cli_key(path: &str) -> String {
    let normal: String = path.nfc().collect();
    let key: String = normal
        .encode_utf16()
        .map(|unit| match char::from_u32(u32::from(unit)) {
            Some(c) if c.is_ascii_alphanumeric() => c,
            _ => '-',
        })
        .collect();
    if key.len() <= KEY_UNITS {
        return key;
    }
    // Every unit is ASCII by now, so a byte cut is a unit cut. The absolute
    // value is taken wide, so the most negative hash reads `zik0zk`.
    let hash = i64::from(java_hash(&normal)).unsigned_abs();
    format!("{}-{}", &key[..KEY_UNITS], base36(hash))
}

/// An NFC copy of `path`, as the CLI normalizes the config home.
fn nfc_path(path: &Path) -> PathBuf {
    PathBuf::from(path.to_string_lossy().nfc().collect::<String>())
}

/// `CLAUDE_CONFIG_DIR`, resolved against the vault when relative or empty,
/// else `~/.claude`. None only when neither is known.
pub fn config_home(env: &CliEnv, vault: &Path) -> Option<PathBuf> {
    let home = match &env.config_dir {
        Some(dir) => {
            let dir = PathBuf::from(dir);
            if dir.is_absolute() {
                dir
            } else {
                vault.join(dir)
            }
        }
        None => env.home.as_ref()?.join(".claude"),
    };
    Some(nfc_path(&home))
}

/// A `CLAUDE_CODE_PROJECT_DIR_NAME` the CLI would honour: 1 to 64 of
/// `[A-Za-z0-9_-]`, and never a device name.
fn project_dir_override(env: &CliEnv) -> Option<String> {
    let config = env.config_dir.as_ref()?;
    if config.is_empty() {
        return None;
    }
    let name = env.project_dir_name.as_ref()?.to_str()?;
    let shaped = (1..=64).contains(&name.len())
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    if !shaped {
        return None;
    }
    let lower = name.to_ascii_lowercase();
    let device = ["con", "prn", "aux", "nul"].contains(&lower.as_str())
        || ((lower.starts_with("com") || lower.starts_with("lpt"))
            && lower.len() == 4
            && lower.as_bytes()[3].is_ascii_digit());
    (!device).then(|| name.to_string())
}

/// Where the CLI keeps `vault`'s sessions under `env`. The vault is keyed by
/// its real path, or by the path as given when it cannot be resolved.
pub fn cli_project_dir_in(env: &CliEnv, vault: &Path) -> Option<CliProjectDir> {
    let real = std::fs::canonicalize(vault).unwrap_or_else(|_| vault.to_path_buf());
    let projects = config_home(env, &real)?.join("projects");
    let (name, shared) = match project_dir_override(env) {
        Some(name) => (name, true),
        None => (cli_key(&real.to_string_lossy()), false),
    };
    Some(CliProjectDir {
        dir: projects.join(name),
        projects,
        shared,
    })
}

/// Where the CLI keeps `vault`'s sessions: the one locator (the workspace
/// count, its purge and every transcript read go through it).
pub fn cli_project_dir(vault: &Path) -> Option<CliProjectDir> {
    cli_project_dir_in(&CliEnv::from_process(), vault)
}

/// `<project dir>/<id>.jsonl`, for a session id that is one.
pub fn session_file(vault: &Path, id: &str) -> Option<PathBuf> {
    let id = parse_session_id(id)?;
    Some(cli_project_dir(vault)?.dir.join(format!("{id}.jsonl")))
}

/// `<project dir>/<id>/`, the folder some sessions keep beside their file.
pub fn session_dir(vault: &Path, id: &str) -> Option<PathBuf> {
    let id = parse_session_id(id)?;
    Some(cli_project_dir(vault)?.dir.join(id))
}

// ---------------------------------------------------------------------------
// Session ids
// ---------------------------------------------------------------------------

/// `id`, when it is a lowercase 8-4-4-4-12 hex UUID; None otherwise. Nothing
/// else reaches argv or a path.
pub fn parse_session_id(id: &str) -> Option<String> {
    let bytes = id.as_bytes();
    if bytes.len() != 36 {
        return None;
    }
    let shaped = bytes.iter().enumerate().all(|(at, b)| match at {
        8 | 13 | 18 | 23 => *b == b'-',
        _ => b.is_ascii_digit() || (b'a'..=b'f').contains(b),
    });
    shaped.then(|| id.to_string())
}

/// A fresh v4 UUID, RFC 4122 variant, lowercase.
pub fn mint_session_id() -> String {
    let mut bytes: [u8; 16] = rand::random();
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

/// Where a branch leaves its conversation (M91.6), as a request names it:
/// the session it forks, and the anchor it forks at, the uuid of the line one
/// of that session's turns ended on. Both are read as session ids are
/// (`parse_session_id`) before either reaches argv or a path.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct ForkRequest {
    pub from: String,
    pub at: String,
}

/// Why a branch was refused before anything started (M91.6). The words are
/// Rust's, and the panel shows them as they are.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ForkRefused {
    /// The request names a session to resume as well: a branch runs in a
    /// session of its own.
    AlsoResumes,
    /// The source or the anchor is not shaped as a session id is.
    Malformed,
    /// The source's session file is not in Claude Code's folder: never
    /// recorded, emptied, or swept.
    NoSource,
    /// The source's file is there, or may be, and could not be read.
    Unreadable,
    /// The anchor is not where one of the source's turns ended (`check_fork`).
    NotAnAnchor,
}

impl std::fmt::Display for ForkRefused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::AlsoResumes => "A branch starts a Claude Code session of its own, and this one also names a session to continue, so nothing was started.",
            Self::Malformed => "The turn this branch starts from is not named by a Claude Code session and line, so nothing was started.",
            Self::NoSource => "Claude Code no longer has the conversation this branch starts from, so nothing was started.",
            Self::Unreadable => "Claude Code's record of the conversation this branch starts from could not be read, so nothing was started.",
            Self::NotAnAnchor => "Claude Code's record of that conversation has no turn ending where this branch starts, so nothing was started.",
        })
    }
}

/// The Claude Code session a run goes to: the one it resumes, one minted for
/// it, or one minted for a branch (M91.6), so its id is known before the CLI
/// says a word.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CliSession {
    Resume(String),
    New(String),
    /// A branch (M91.6): Claude Code copies `from`'s conversation, up to its
    /// line `at`, into the session `id` minted here, and the run goes on in
    /// `id`. `from` is only read.
    Fork {
        from: String,
        at: String,
        id: String,
    },
}

impl CliSession {
    /// A request's session: a stored id resumes, a branch (M91.6) mints the
    /// session it runs in, and nothing mints one. A stored value that is not
    /// a session id, a branch whose source or anchor is not one, and a
    /// request naming both a session and a branch are refused before anything
    /// runs. Reading nothing, it leaves a branch's anchor to `checked`.
    pub fn for_request(resume: Option<&str>, fork: Option<&ForkRequest>) -> Result<Self, String> {
        let resume = resume.map(str::trim).filter(|id| !id.is_empty());
        match (resume, fork) {
            (Some(_), Some(_)) => Err(ForkRefused::AlsoResumes.to_string()),
            (None, Some(fork)) => {
                match (parse_session_id(&fork.from), parse_session_id(&fork.at)) {
                    (Some(from), Some(at)) => Ok(Self::Fork {
                        from,
                        at,
                        id: mint_session_id(),
                    }),
                    _ => Err(ForkRefused::Malformed.to_string()),
                }
            }
            (None, None) => Ok(Self::New(mint_session_id())),
            (Some(id), None) => parse_session_id(id).map(Self::Resume).ok_or_else(|| {
                let shown: String = id.chars().take(40).collect();
                format!(
                    "This conversation's stored Claude Code session ({}) is not a session id, so nothing was started. Start a new conversation.",
                    serde_json::Value::String(shown)
                )
            }),
        }
    }

    /// The session the run goes to: a branch's minted one, never its
    /// source, so the run's seat, journal, meter row and `Spawned` all name
    /// the session it writes.
    pub fn id(&self) -> &str {
        match self {
            Self::Resume(id) | Self::New(id) | Self::Fork { id, .. } => id,
        }
    }

    /// The argv elements that name the session. A branch's are the ones
    /// 2.1.250 forks with (measured, M91.6): its source resumed up to the
    /// anchor, forked, and run as the minted id.
    pub fn args(&self) -> Vec<String> {
        match self {
            Self::Resume(id) => vec!["--resume".into(), id.clone()],
            Self::New(id) => vec!["--session-id".into(), id.clone()],
            Self::Fork { from, at, id } => vec![
                "--resume".into(),
                from.clone(),
                "--resume-session-at".into(),
                at.clone(),
                "--fork-session".into(),
                "--session-id".into(),
                id.clone(),
            ],
        }
    }

    /// The session, once a branch's anchor is known to be where one of its
    /// source's turns ended in `vault`'s Claude Code folder (`check_fork`),
    /// or refused in `ForkRefused`'s words. Any other session as it is.
    pub fn checked(self, vault: &Path) -> Result<Self, String> {
        if let Self::Fork { from, at, .. } = &self {
            check_fork(vault, from, at).map_err(|refused| refused.to_string())?;
        }
        Ok(self)
    }
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

/// What reading `<config home>/settings.json` found.
#[derive(Debug, Clone, Copy)]
pub enum Settings<'a> {
    /// No file.
    Missing,
    /// A file that could not be read.
    Unreadable,
    Text(&'a str),
}

/// How many days Claude Code keeps a session after its last turn, by 2.1.250's
/// rule; None when it never sweeps (a `cleanupPeriodDays` that is not a
/// positive integer, or settings it cannot read or parse).
pub fn retention_from(settings: Settings<'_>) -> Option<u32> {
    let text = match settings {
        Settings::Missing => return Some(DEFAULT_RETENTION_DAYS),
        Settings::Unreadable => return None,
        Settings::Text(text) => text,
    };
    let parsed: Value = serde_json::from_str(text).ok()?;
    match parsed.get("cleanupPeriodDays") {
        None => Some(DEFAULT_RETENTION_DAYS),
        Some(days) => days
            .as_u64()
            .filter(|days| *days > 0)
            .map(|days| u32::try_from(days).unwrap_or(u32::MAX)),
    }
}

/// The retention the settings in `config_home` name.
pub fn retention_in(config_home: &Path) -> Option<u32> {
    match std::fs::read_to_string(config_home.join("settings.json")) {
        Ok(text) => retention_from(Settings::Text(&text)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            retention_from(Settings::Missing)
        }
        Err(_) => retention_from(Settings::Unreadable),
    }
}

/// The retention for `vault`'s config home.
pub fn retention_days(vault: &Path) -> Option<u32> {
    let env = CliEnv::from_process();
    config_home(&env, vault).and_then(|home| retention_in(&home))
}

// ---------------------------------------------------------------------------
// Reading back
// ---------------------------------------------------------------------------

/// Why a transcript cannot be read. Typed here; the panel words each one.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Unavailable {
    /// Gone before the retention ran out: emptied from Settings, or by hand.
    Cleared,
    /// Gone after it: Claude Code's own sweep.
    Expired,
    /// No session was ever recorded for the conversation.
    NotRecorded,
    /// There, or maybe there, but it could not be read.
    Unreadable,
}

/// What reading a conversation's session file found.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum TranscriptRead {
    Read {
        events: Vec<AgentEvent>,
        /// Lines folded, its subagents' included (M91.3b), blank and
        /// unparsable ones left out.
        lines: usize,
        /// Kinds the fold could not classify, sorted, once each.
        unclassified: Vec<String>,
    },
    Unavailable {
        reason: Unavailable,
        /// The retention in force, or None when Claude Code never sweeps.
        retention_days: Option<u32>,
        #[serde(skip_serializing_if = "Option::is_none")]
        detail: Option<String>,
    },
}

/// A missing file: expired once the last turn is at least the retention old,
/// cleared before that, and cleared always when nothing sweeps or the last
/// turn is unknown.
pub fn classify_missing(
    last_active: Option<DateTime<Utc>>,
    retention: Option<u32>,
    now: DateTime<Utc>,
) -> Unavailable {
    match (last_active, retention) {
        (Some(last), Some(days)) if now - last >= chrono::Duration::days(i64::from(days)) => {
            Unavailable::Expired
        }
        _ => Unavailable::Cleared,
    }
}

fn unavailable(
    reason: Unavailable,
    retention: Option<u32>,
    detail: Option<String>,
) -> TranscriptRead {
    TranscriptRead::Unavailable {
        reason,
        retention_days: retention,
        detail,
    }
}

/// The most of a subagent transcript one chunk holds in memory (M91.3b),
/// by lines and by bytes, whichever comes first.
const CHUNK_LINES: usize = 64;
const CHUNK_BYTES: u64 = 256 * 1024;

/// The most of a subagent's meta that is read: a few short fields.
const META_BYTES: u64 = 64 * 1024;

/// A subagent transcript's parsed lines, read a chunk at a time (M91.3b).
/// The file is open only while a chunk is read, so a session with many
/// subagents never holds many files open; the first chunk is one line, all
/// the merge looks at until the subagent's turn comes. Blank and unparsable
/// lines are left out, as the session file's are, and a read that fails
/// ends the transcript where it failed.
struct ChunkedLines {
    path: PathBuf,
    /// Where the next chunk starts, in bytes.
    offset: u64,
    lines: VecDeque<Value>,
    /// How many lines the next chunk reads at most.
    batch: usize,
    done: bool,
}

impl ChunkedLines {
    fn new(path: PathBuf) -> Self {
        Self {
            path,
            offset: 0,
            lines: VecDeque::new(),
            batch: 1,
            done: false,
        }
    }

    fn refill(&mut self) {
        use std::io::{Seek, SeekFrom};
        let opened = std::fs::File::open(&self.path).and_then(|mut file| {
            file.seek(SeekFrom::Start(self.offset))?;
            Ok(file)
        });
        let Ok(file) = opened else {
            self.done = true;
            return;
        };
        let mut reader = BufReader::new(file);
        let mut raw = Vec::new();
        let mut read = 0u64;
        while self.lines.len() < self.batch && read < CHUNK_BYTES {
            raw.clear();
            match reader.read_until(b'\n', &mut raw) {
                Ok(0) => {
                    self.done = true;
                    break;
                }
                Ok(count) => read += count as u64,
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => {
                    self.done = true;
                    break;
                }
            }
            let line = String::from_utf8_lossy(&raw);
            if let Ok(value) = serde_json::from_str::<Value>(&line) {
                self.lines.push_back(value);
            }
        }
        self.offset += read;
        self.batch = CHUNK_LINES;
    }
}

impl Iterator for ChunkedLines {
    type Item = Value;

    fn next(&mut self) -> Option<Value> {
        loop {
            if let Some(line) = self.lines.pop_front() {
                return Some(line);
            }
            if self.done {
                return None;
            }
            self.refill();
        }
    }
}

/// The subagents' own transcripts in `dir`, a session's `subagents/`
/// folder (M91.3b): each `agent-<agent id>.jsonl`, by name, with the
/// `.meta.json` beside it when that can be read. A folder that is missing or
/// cannot be listed holds none, and a transcript that cannot be read gives no
/// lines: the session file still reads, its subagents' steps not recorded.
fn subagent_transcripts(dir: &Path) -> Vec<SubagentTranscript> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut stems: Vec<String> = entries
        .filter_map(Result::ok)
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| name.starts_with("agent-"))
        .filter_map(|name| name.strip_suffix(".jsonl").map(str::to_string))
        .collect();
    stems.sort();
    stems
        .into_iter()
        .map(|stem| SubagentTranscript {
            meta: read_meta(&dir.join(format!("{stem}.meta.json"))),
            lines: Box::new(ChunkedLines::new(dir.join(format!("{stem}.jsonl")))),
        })
        .collect()
}

/// A subagent's meta, parsed, when it can be read: a few short fields, so
/// no more than `META_BYTES` of it is.
fn read_meta(path: &Path) -> Option<Value> {
    use std::io::Read;
    let mut text = String::new();
    std::fs::File::open(path)
        .ok()?
        .take(META_BYTES)
        .read_to_string(&mut text)
        .ok()?;
    serde_json::from_str(&text).ok()
}

/// The next parsed line of a session file, None at its end: blank and
/// unparsable lines are skipped, and a read that fails says why.
fn next_line(reader: &mut impl BufRead, raw: &mut Vec<u8>) -> std::io::Result<Option<Value>> {
    loop {
        raw.clear();
        match reader.read_until(b'\n', raw) {
            Ok(0) => return Ok(None),
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        }
        let line = String::from_utf8_lossy(raw);
        if line.trim().is_empty() {
            continue;
        }
        if let Ok(value) = serde_json::from_str::<Value>(&line) {
            return Ok(Some(value));
        }
    }
}

/// Fold the session `id` in `located`, its subagents' own transcripts merged
/// in (M91.3b). Stores nothing: each file is read through once and folded as
/// it goes. Only the session's own folder is read. A branch's session
/// (M91.6) holds the turns Claude Code copied from its source, but their
/// subagents' transcripts stay in the source's folder, so a subagent a copied
/// turn started reads with its report and without its steps: how 2.1.250
/// stamps the copied lines is unmeasured, and the merge places subagent
/// lines by time.
pub fn read_in(
    located: Option<&CliProjectDir>,
    retention: Option<u32>,
    session: Option<&str>,
    last_active: Option<DateTime<Utc>>,
    now: DateTime<Utc>,
) -> TranscriptRead {
    let Some(id) = session.and_then(parse_session_id) else {
        return unavailable(Unavailable::NotRecorded, retention, None);
    };
    let Some(located) = located else {
        return unavailable(
            Unavailable::Unreadable,
            retention,
            Some("there is no home folder to find Claude Code's folder in".into()),
        );
    };
    let path = located.dir.join(format!("{id}.jsonl"));
    let file = match std::fs::File::open(&path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return unavailable(
                classify_missing(last_active, retention, now),
                retention,
                None,
            );
        }
        Err(error) => {
            return unavailable(Unavailable::Unreadable, retention, Some(error.to_string()));
        }
    };
    let mut reader = BufReader::new(file);
    let mut fold = SessionFold::new(subagent_transcripts(
        &located.dir.join(&id).join("subagents"),
    ));
    let mut events = Vec::new();
    let mut unclassified: Vec<String> = Vec::new();
    let mut lines = 0usize;
    let mut sink = |class: LineClass, folded: Vec<AgentEvent>| {
        lines += 1;
        if let LineClass::Unclassified(kind) = class {
            if !unclassified.contains(&kind) {
                unclassified.push(kind);
            }
        }
        events.extend(folded);
    };
    let mut raw = Vec::new();
    loop {
        match next_line(&mut reader, &mut raw) {
            Ok(Some(value)) => fold.entry(&value, &mut sink),
            Ok(None) => break,
            Err(error) => {
                return unavailable(Unavailable::Unreadable, retention, Some(error.to_string()));
            }
        }
    }
    let end = fold.finish(&mut sink);
    events.extend(end);
    unclassified.sort();
    TranscriptRead::Read {
        events,
        lines,
        unclassified,
    }
}

/// Read a conversation's transcript back from Claude Code's folder for
/// `vault`: `read_cli_transcript`'s whole job.
pub fn read_cli_transcript(
    vault: &Path,
    session: Option<&str>,
    last_active: Option<DateTime<Utc>>,
) -> TranscriptRead {
    let located = cli_project_dir(vault);
    let retention = located
        .as_ref()
        .and_then(|located| retention_in(located.config_home()));
    read_in(
        located.as_ref(),
        retention,
        session,
        last_active,
        Utc::now(),
    )
}

/// A run's transcript as its detail shows it (M56.9): the session file read
/// back, and how many runs share the session, since a resumed conversation's
/// turns all land in one file and the detail shows all of it.
#[derive(Debug, Clone, Serialize)]
pub struct RunTranscript {
    pub runs_in_session: u64,
    /// The retention Claude Code is configured with for the run's vault, or
    /// None when it never sweeps or there is no folder to look in. Carried
    /// beside the read so a transcript that was read can name it too.
    pub retention_days: Option<u32>,
    pub read: TranscriptRead,
}

/// Read a run's transcript (M56.9, D5): folded on read and stored nowhere.
///
/// A run with no vault (its vault is no longer registered) or no session
/// reads as not recorded; there is no folder to look in, so no retention is
/// named either. Otherwise this is [`read_cli_transcript`] at `now`, so a
/// missing file is told expired or cleared by the retention Claude Code is
/// configured with, never by a number written here.
pub fn read_run_transcript(
    vault: Option<&Path>,
    session: Option<&str>,
    last_active: Option<DateTime<Utc>>,
    runs_in_session: u64,
    now: DateTime<Utc>,
) -> RunTranscript {
    let (retention_days, read) = match (vault, session) {
        (Some(vault), Some(session)) => {
            let located = cli_project_dir(vault);
            let retention = located
                .as_ref()
                .and_then(|located| retention_in(located.config_home()));
            let read = read_in(located.as_ref(), retention, Some(session), last_active, now);
            (retention, read)
        }
        _ => (None, unavailable(Unavailable::NotRecorded, None, None)),
    };
    RunTranscript {
        runs_in_session,
        retention_days,
        read,
    }
}

// ---------------------------------------------------------------------------
// Where a branch may start (M91.6)
// ---------------------------------------------------------------------------

/// Is `at` where one of the session `from`'s turns ended in `vault`'s Claude
/// Code folder (M91.6)? A branch keeps its source's conversation up to that
/// line and goes on from it, so the line must be an anchor the fold gives
/// the source: the uuid of a turn's last main-thread assistant line, as its
/// `TurnEnded` names it, which is the anchor the panel branches from. A
/// prompt, a tool's result, a subagent's line, a line mid-turn and a line the
/// file does not hold are none, so a branch never starts mid-turn. A turn a
/// `result` cut short (a turn limit, say) can still end on a call whose
/// result follows its anchor. The file is read through the fold that replays
/// it (CV-27), up to the turn that ends at `at`; its subagents' transcripts
/// are not read.
pub fn check_fork(vault: &Path, from: &str, at: &str) -> Result<(), ForkRefused> {
    check_fork_in(cli_project_dir(vault).as_ref(), from, at)
}

/// `check_fork` in `located`: the seam the tests drive.
pub fn check_fork_in(
    located: Option<&CliProjectDir>,
    from: &str,
    at: &str,
) -> Result<(), ForkRefused> {
    let (Some(from), Some(at)) = (parse_session_id(from), parse_session_id(at)) else {
        return Err(ForkRefused::Malformed);
    };
    let Some(located) = located else {
        return Err(ForkRefused::Unreadable);
    };
    let file = match std::fs::File::open(located.dir.join(format!("{from}.jsonl"))) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(ForkRefused::NoSource)
        }
        Err(_) => return Err(ForkRefused::Unreadable),
    };
    let ends_at = |events: &[AgentEvent]| {
        events.iter().any(|event| {
            matches!(event, AgentEvent::TurnEnded { last_uuid: Some(anchor), .. } if *anchor == at)
        })
    };
    let mut reader = BufReader::new(file);
    let mut fold = SessionFold::new(Vec::new());
    let mut found = false;
    let mut raw = Vec::new();
    while !found {
        match next_line(&mut reader, &mut raw) {
            Ok(Some(value)) => fold.entry(&value, &mut |_, events| found |= ends_at(&events)),
            Ok(None) => break,
            Err(_) => return Err(ForkRefused::Unreadable),
        }
    }
    if !found {
        let end = fold.finish(&mut |_, events| found |= ends_at(&events));
        found |= ends_at(&end);
    }
    if found {
        Ok(())
    } else {
        Err(ForkRefused::NotAnAnchor)
    }
}

// ---------------------------------------------------------------------------
// A deferral the session file leaves open (M57.1)
// ---------------------------------------------------------------------------

/// How much of a session file's end is read for a deferral marker: what CLI
/// 2.1.250 reads on resume (derived from its bundle; live run owed).
pub const DEFERRAL_TAIL_BYTES: u64 = 1024 * 1024;

/// The call a session's last `hook_deferred_tool` attachment holds, while no
/// later line answers it: the call Claude Code re-runs through PreToolUse
/// before anything else when the session resumes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingDeferral {
    pub tool_use_id: String,
    pub tool_name: String,
}

/// The session's unresolved deferral, if its file holds one. A file that
/// cannot be found or read holds none, since Claude Code cannot resume it
/// either.
pub fn pending_deferral(vault: &Path, session: &str) -> Option<PendingDeferral> {
    pending_deferral_at(&session_file(vault, session)?)
}

/// `pending_deferral` over a path: the last `DEFERRAL_TAIL_BYTES` of it.
pub(crate) fn pending_deferral_at(path: &Path) -> Option<PendingDeferral> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = std::fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    file.seek(SeekFrom::Start(len.saturating_sub(DEFERRAL_TAIL_BYTES)))
        .ok()?;
    let mut tail = Vec::new();
    file.read_to_end(&mut tail).ok()?;
    pending_deferral_in(&String::from_utf8_lossy(&tail))
}

/// The rule, pure, as 2.1.250 applies it (derived): the LAST attachment line
/// of type `hook_deferred_tool` names the call, and it is unresolved when no
/// later line holds its id as a `tool_use_id` key. The CLI tests that by
/// substring, and so does this: a later line that merely quotes the key is
/// read as answering it, which only ever skips a settle, never adds one.
pub fn pending_deferral_in(tail: &str) -> Option<PendingDeferral> {
    let lines: Vec<&str> = tail.lines().collect();
    let (at, marker) = lines.iter().enumerate().rev().find_map(|(at, line)| {
        if !line.contains("hook_deferred_tool") {
            return None;
        }
        let value: Value = serde_json::from_str(line).ok()?;
        if value.get("type").and_then(Value::as_str) != Some("attachment") {
            return None;
        }
        let attachment = value.get("attachment")?;
        if attachment.get("type").and_then(Value::as_str) != Some("hook_deferred_tool") {
            return None;
        }
        let id = attachment.get("toolUseID").and_then(Value::as_str)?;
        let name = attachment
            .get("toolName")
            .and_then(Value::as_str)
            .unwrap_or_default();
        Some((
            at,
            PendingDeferral {
                tool_use_id: id.to_string(),
                tool_name: name.to_string(),
            },
        ))
    })?;
    let compact = format!("\"tool_use_id\":\"{}\"", marker.tool_use_id);
    let spaced = format!("\"tool_use_id\": \"{}\"", marker.tool_use_id);
    let answered = lines[at + 1..]
        .iter()
        .any(|line| line.contains(&compact) || line.contains(&spaced));
    (!answered).then_some(marker)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Deserialize)]
    struct Vectors {
        cli_version: String,
        keys: Vec<KeyCase>,
        retention: Vec<RetentionCase>,
    }

    #[derive(Deserialize)]
    struct KeyCase {
        name: String,
        path: String,
        units: usize,
        key: String,
    }

    #[derive(Deserialize)]
    struct RetentionCase {
        name: String,
        settings: Option<String>,
        days: Option<u32>,
    }

    fn vectors() -> Vectors {
        serde_json::from_str(include_str!("../../fixtures/cli-slugs.json")).unwrap()
    }

    fn env_with(config: Option<&str>, name: Option<&str>) -> CliEnv {
        CliEnv {
            config_dir: config.map(OsString::from),
            project_dir_name: name.map(OsString::from),
            home: Some(PathBuf::from("/home-of-test")),
        }
    }

    #[test]
    fn cli_slugs_match_cli_2_1_250() {
        let vectors = vectors();
        assert_eq!(vectors.cli_version, CLI_VERSION);
        assert!(vectors.keys.len() >= 10);
        for case in vectors.keys {
            let normal: String = case.path.nfc().collect();
            assert_eq!(normal.encode_utf16().count(), case.units, "{}", case.name);
            assert_eq!(cli_key(&case.path), case.key, "{}", case.name);
        }
        assert_eq!(base36(2_147_483_648), "zik0zk");
    }

    #[test]
    fn a_vault_is_slugged_by_its_real_path() {
        let root = crate::vault::testutil::temp_vault("cli-key-symlink");
        let real = root.join("real vault");
        std::fs::create_dir_all(&real).unwrap();
        let link = root.join("link");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let env = env_with(Some("/config"), None);
        let located = cli_project_dir_in(&env, &link).unwrap();
        let target = std::fs::canonicalize(&real).unwrap();
        assert_eq!(
            located.dir,
            PathBuf::from("/config/projects").join(cli_key(&target.to_string_lossy()))
        );
        assert!(located.dir.to_string_lossy().ends_with("-real-vault"));
        assert!(!located.shared);
        // A path that does not resolve is keyed as given.
        let gone = cli_project_dir_in(&env, Path::new("/no/such/vault")).unwrap();
        assert_eq!(gone.dir, PathBuf::from("/config/projects/-no-such-vault"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn the_projects_dir_follows_claude_config_dir() {
        let vault = Path::new("/no/such/vault");
        let dir = |env: CliEnv| cli_project_dir_in(&env, vault).map(|d| (d.projects, d.shared));
        assert_eq!(
            dir(env_with(None, None)),
            Some((PathBuf::from("/home-of-test/.claude/projects"), false)),
            "unset: ~/.claude"
        );
        assert_eq!(
            dir(env_with(Some("/elsewhere/cfg"), None)),
            Some((PathBuf::from("/elsewhere/cfg/projects"), false))
        );
        assert_eq!(
            dir(env_with(Some("rel/cfg"), None)),
            Some((PathBuf::from("/no/such/vault/rel/cfg/projects"), false)),
            "relative resolves against the vault"
        );
        assert_eq!(
            dir(env_with(Some(""), None)),
            Some((PathBuf::from("/no/such/vault/projects"), false)),
            "empty resolves to the vault"
        );
        assert_eq!(
            dir(CliEnv::default()),
            None,
            "no config dir and no home: nowhere to look"
        );

        let shared =
            cli_project_dir_in(&env_with(Some("/cfg"), Some("team_notes-1")), vault).unwrap();
        assert_eq!(shared.dir, PathBuf::from("/cfg/projects/team_notes-1"));
        assert!(shared.shared);
        let long = "x".repeat(65);
        for ignored in ["../x", "con", "COM1", "lpt9", "", long.as_str()] {
            let located =
                cli_project_dir_in(&env_with(Some("/cfg"), Some(ignored)), vault).unwrap();
            assert!(!located.shared, "{ignored:?} is ignored");
            assert_eq!(located.dir, PathBuf::from("/cfg/projects/-no-such-vault"));
        }
        for config in [None, Some("")] {
            let located = cli_project_dir_in(&env_with(config, Some("team")), vault).unwrap();
            assert!(
                !located.shared,
                "the override needs a non-empty CLAUDE_CONFIG_DIR: {config:?}"
            );
        }
    }

    #[test]
    fn session_ids_are_uuids_or_nothing() {
        let good = "00000000-0000-4000-8000-000000000001";
        assert_eq!(parse_session_id(good).as_deref(), Some(good));
        for bad in [
            "--dangerously-skip-permissions",
            "../x",
            "00000000-0000-4000-8000-00000000001",
            "",
            "00000000-0000-4000-8000-00000000000G",
            "00000000-0000-4000-8000-00000000000A",
            "00000000_0000-4000-8000-000000000001",
            "../../00000000-0000-4000-8000-0000000",
        ] {
            assert_eq!(parse_session_id(bad), None, "{bad:?}");
            assert!(CliSession::for_request(Some(bad), None).is_err() || bad.is_empty());
        }
        let refused =
            CliSession::for_request(Some("--dangerously-skip-permissions"), None).unwrap_err();
        assert!(refused.contains("not a session id"), "{refused}");
        assert_eq!(
            CliSession::for_request(Some(good), None),
            Ok(CliSession::Resume(good.into()))
        );
        assert!(matches!(
            CliSession::for_request(Some("  "), None),
            Ok(CliSession::New(_))
        ));
    }

    // --- Branches (M91.6) -----------------------------------------------------

    const SOURCE: &str = "00000000-0000-4000-8000-000000009500";
    /// Where the subagent fixture's one turn ended: its last main-thread
    /// assistant line.
    const ANCHOR: &str = "00000000-0000-4000-8000-000009500111";

    fn fork(from: &str, at: &str) -> ForkRequest {
        ForkRequest {
            from: from.into(),
            at: at.into(),
        }
    }

    #[test]
    fn a_branch_mints_its_own_session_and_names_its_source() {
        let session = CliSession::for_request(None, Some(&fork(SOURCE, ANCHOR))).unwrap();
        let CliSession::Fork { from, at, id } = &session else {
            panic!("a branch: {session:?}");
        };
        assert_eq!((from.as_str(), at.as_str()), (SOURCE, ANCHOR));
        assert_eq!(parse_session_id(id).as_deref(), Some(id.as_str()));
        assert_eq!(&id[14..15], "4", "minted as every new session is: {id}");
        assert_ne!(id, SOURCE, "never the source's session");
        assert_eq!(session.id(), id, "the run goes on in the minted one");
        // A blank stored session is none, so the branch still mints.
        assert!(matches!(
            CliSession::for_request(Some("  "), Some(&fork(SOURCE, ANCHOR))),
            Ok(CliSession::Fork { .. })
        ));
        let again = CliSession::for_request(None, Some(&fork(SOURCE, ANCHOR))).unwrap();
        assert_ne!(again.id(), session.id(), "each branch its own");
    }

    #[test]
    fn a_branch_runs_with_the_measured_fork_argv() {
        let session = CliSession::Fork {
            from: SOURCE.into(),
            at: ANCHOR.into(),
            id: ID.into(),
        };
        assert_eq!(
            session.args(),
            [
                "--resume",
                SOURCE,
                "--resume-session-at",
                ANCHOR,
                "--fork-session",
                "--session-id",
                ID
            ]
        );
    }

    #[test]
    fn a_branch_that_cannot_be_named_or_also_resumes_is_refused() {
        for (from, at) in [
            ("--dangerously-skip-permissions", ANCHOR),
            (SOURCE, "../../etc/passwd"),
            ("", ANCHOR),
            (SOURCE, "00000000-0000-4000-8000-00000950011A"),
        ] {
            assert_eq!(
                CliSession::for_request(None, Some(&fork(from, at))),
                Err(ForkRefused::Malformed.to_string()),
                "{from:?} {at:?}"
            );
            assert_eq!(
                check_fork_in(None, from, at),
                Err(ForkRefused::Malformed),
                "checked before any path is made"
            );
        }
        assert_eq!(
            CliSession::for_request(Some(ID), Some(&fork(SOURCE, ANCHOR))),
            Err(ForkRefused::AlsoResumes.to_string())
        );
        let words = ForkRefused::AlsoResumes.to_string();
        assert!(words.ends_with("so nothing was started."), "{words}");
    }

    /// The subagent fixture as session `SOURCE`, its subagent's transcript
    /// in the folder Claude Code keeps beside it.
    fn source_session(label: &str) -> (PathBuf, CliProjectDir) {
        let lines: Vec<Value> = serde_json::from_str(SUBAGENT_SESSION).unwrap();
        let (root, located) = session_at(label, SOURCE, &lines);
        let dir = located.dir.join(SOURCE).join("subagents");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("agent-a0000000000000001.jsonl"), SUBAGENT_LINES).unwrap();
        std::fs::write(dir.join("agent-a0000000000000001.meta.json"), SUBAGENT_META).unwrap();
        (root, located)
    }

    #[test]
    fn a_branch_starts_only_where_a_turn_of_its_source_ended() {
        let (root, located) = source_session("fork-anchor");
        assert_eq!(check_fork_in(Some(&located), SOURCE, ANCHOR), Ok(()));
        let refused = [
            // The turn's prompt, and the line that answers its Agent call.
            ("a prompt", "00000000-0000-4000-8000-000009500002"),
            ("a tool's result", "00000000-0000-4000-8000-000009500109"),
            // A main-thread line mid-turn: the Agent call, with no result.
            ("a line mid-turn", "00000000-0000-4000-8000-000009500102"),
            // The subagent's own last line, in its transcript beside the file.
            ("a subagent's line", "00000000-0000-4000-8000-000009500108"),
            ("an unknown line", "00000000-0000-4000-8000-000000000999"),
        ];
        for (what, at) in refused {
            assert_eq!(
                check_fork_in(Some(&located), SOURCE, at),
                Err(ForkRefused::NotAnAnchor),
                "{what}"
            );
        }
        // A sidechain line an older layout keeps in the session file itself
        // is a subagent's, whatever it says.
        let sidechain = serde_json::json!({
            "type": "assistant", "isSidechain": true, "timestamp": "2026-10-22T12:00:09.000Z",
            "uuid": "00000000-0000-4000-8000-000009500120",
            "message": { "id": "msg_side", "model": "claude-haiku-4-5", "role": "assistant",
                "stop_reason": "end_turn",
                "content": [{ "type": "text", "text": "A subagent's last word." }] }
        });
        let mut text =
            std::fs::read_to_string(located.dir.join(format!("{SOURCE}.jsonl"))).unwrap();
        text.push_str(&format!("{sidechain}\n"));
        std::fs::write(located.dir.join(format!("{SOURCE}.jsonl")), text).unwrap();
        assert_eq!(
            check_fork_in(
                Some(&located),
                SOURCE,
                "00000000-0000-4000-8000-000009500120"
            ),
            Err(ForkRefused::NotAnAnchor)
        );
        assert_eq!(check_fork_in(Some(&located), SOURCE, ANCHOR), Ok(()));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn a_branch_may_start_after_any_turn_its_source_ended() {
        let lines: Vec<Value> = serde_json::from_str(include_str!(
            "../../fixtures/cli-stream/transcript-two-turns.session.json"
        ))
        .unwrap();
        let (root, located) = session_at("fork-two-turns", ID, &lines);
        // The first turn ends at its last answer, which the fold reads as
        // ended when the second prompt comes; the second at the file's end.
        for at in [
            "00000000-0000-4000-8000-000000000015",
            "00000000-0000-4000-8000-000000000022",
        ] {
            assert_eq!(check_fork_in(Some(&located), ID, at), Ok(()), "{at}");
        }
        for (what, at) in [
            (
                "the first answer's opening words",
                "00000000-0000-4000-8000-000000000010",
            ),
            (
                "a call its result answers later",
                "00000000-0000-4000-8000-000000000011",
            ),
            ("the second prompt", "00000000-0000-4000-8000-000000000020"),
        ] {
            assert_eq!(
                check_fork_in(Some(&located), ID, at),
                Err(ForkRefused::NotAnAnchor),
                "{what}"
            );
        }
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn a_branch_whose_source_is_gone_or_unreadable_is_refused() {
        let (root, located) = source_session("fork-gone");
        let gone = "00000000-0000-4000-8000-000000000404";
        assert_eq!(
            check_fork_in(Some(&located), gone, ANCHOR),
            Err(ForkRefused::NoSource)
        );
        // A folder where the file should be cannot be read as one.
        std::fs::create_dir_all(located.dir.join(format!("{gone}.jsonl"))).unwrap();
        assert_eq!(
            check_fork_in(Some(&located), gone, ANCHOR),
            Err(ForkRefused::Unreadable)
        );
        // No home folder to find Claude Code's folder in.
        assert_eq!(
            check_fork_in(None, SOURCE, ANCHOR),
            Err(ForkRefused::Unreadable)
        );
        // Each refusal is worded, and says nothing ran.
        for refused in [
            ForkRefused::AlsoResumes,
            ForkRefused::Malformed,
            ForkRefused::NoSource,
            ForkRefused::Unreadable,
            ForkRefused::NotAnAnchor,
        ] {
            let words = refused.to_string();
            assert!(words.ends_with("so nothing was started."), "{words}");
        }
        let _ = std::fs::remove_dir_all(root);
    }

    // A branch's session holds the turns Claude Code copied from its source
    // and none of their subagents' transcripts, which stay in the source's
    // folder: a replay reads only the branch's own, so the copied subagent
    // keeps its report and reads no steps.
    #[test]
    fn a_branch_replays_its_copied_subagent_without_its_steps() {
        let (root, located) = source_session("fork-replay");
        let branch = "00000000-0000-4000-8000-000000009600";
        let copied: String = serde_json::from_str::<Vec<Value>>(SUBAGENT_SESSION)
            .unwrap()
            .iter()
            .map(|line| format!("{line}\n"))
            .collect();
        std::fs::write(located.dir.join(format!("{branch}.jsonl")), copied).unwrap();
        let read = read_in(Some(&located), Some(30), Some(branch), None, Utc::now());
        let TranscriptRead::Read { events, .. } = read else {
            panic!("the branch reads: {read:?}");
        };
        assert_eq!(parented(&events), 0, "its copied subagent's steps");
        let report = events.iter().find_map(|event| match event {
            AgentEvent::ToolResult {
                data: crate::agent::ToolResultData::Agent { summary, .. },
                ..
            } => summary.clone(),
            _ => None,
        });
        assert_eq!(
            report.as_deref(),
            Some("The launch note is ready for review, but its press list is still open."),
            "the copied report still crosses"
        );
        // The source itself still reads its subagent's steps.
        let TranscriptRead::Read { events, .. } =
            read_in(Some(&located), Some(30), Some(SOURCE), None, Utc::now())
        else {
            panic!("the source reads");
        };
        assert_eq!(parented(&events), 5);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn minted_session_ids_are_v4_and_distinct() {
        let a = mint_session_id();
        let b = mint_session_id();
        assert_ne!(a, b);
        for id in [&a, &b] {
            assert_eq!(parse_session_id(id).as_deref(), Some(id.as_str()), "{id}");
            assert_eq!(&id[14..15], "4", "version 4: {id}");
            assert!("89ab".contains(&id[19..20]), "RFC 4122 variant: {id}");
        }
        assert!(
            matches!(CliSession::for_request(None, None), Ok(CliSession::New(id)) if parse_session_id(&id).is_some())
        );
        assert_eq!(
            CliSession::New(a.clone()).args(),
            ["--session-id".to_string(), a.clone()]
        );
        assert_eq!(
            CliSession::Resume(a.clone()).args(),
            ["--resume".to_string(), a]
        );
    }

    #[test]
    fn no_session_or_vault_reads_not_recorded() {
        let now = Utc::now();
        let session = "00000000-0000-4000-8000-000000000001";
        for (vault, id) in [
            (None, Some(session)),
            (Some(Path::new("/no/such/vault")), None),
            (None, None),
        ] {
            let read = read_run_transcript(vault, id, None, 3, now);
            assert_eq!(read.runs_in_session, 3);
            assert_eq!(
                read.retention_days, None,
                "no folder, so no retention named"
            );
            assert!(
                matches!(
                    read.read,
                    TranscriptRead::Unavailable {
                        reason: Unavailable::NotRecorded,
                        ..
                    }
                ),
                "{vault:?} {id:?}"
            );
        }
        let wire = serde_json::to_value(read_run_transcript(None, None, None, 1, now)).unwrap();
        assert_eq!(wire["runs_in_session"], 1);
        assert_eq!(wire["read"]["state"], "unavailable");
        assert_eq!(wire["read"]["reason"], "not_recorded");
    }

    #[test]
    fn a_missing_session_is_expired_only_past_the_retention() {
        let now = DateTime::parse_from_rfc3339("2026-07-28T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let days_ago = |days: i64| Some(now - chrono::Duration::days(days));
        assert_eq!(
            classify_missing(days_ago(30), Some(30), now),
            Unavailable::Expired
        );
        assert_eq!(
            classify_missing(days_ago(40), Some(30), now),
            Unavailable::Expired
        );
        assert_eq!(
            classify_missing(days_ago(29), Some(30), now),
            Unavailable::Cleared
        );
        assert_eq!(classify_missing(None, Some(30), now), Unavailable::Cleared);
        for age in [1, 400, 4000] {
            assert_eq!(
                classify_missing(days_ago(age), None, now),
                Unavailable::Cleared,
                "nothing sweeps, so a missing file was removed: {age} days"
            );
        }
    }

    #[test]
    fn retention_reads_cleanup_period_days() {
        let vectors = vectors();
        assert!(vectors.retention.len() >= 7);
        for case in vectors.retention {
            let settings = match &case.settings {
                None => Settings::Missing,
                Some(text) => Settings::Text(text),
            };
            assert_eq!(retention_from(settings), case.days, "{}", case.name);
        }
        assert_eq!(retention_from(Settings::Unreadable), None);
        let home = crate::vault::testutil::temp_vault("cli-retention");
        assert_eq!(retention_in(&home), Some(30), "no file");
        std::fs::write(home.join("settings.json"), r#"{"cleanupPeriodDays": 12}"#).unwrap();
        assert_eq!(retention_in(&home), Some(12));
        let _ = std::fs::remove_dir_all(home);
    }

    /// A projects folder in a temp dir, holding `lines` as session `id`.
    fn session_at(label: &str, id: &str, lines: &[Value]) -> (PathBuf, CliProjectDir) {
        let root = crate::vault::testutil::temp_vault(label);
        let located = CliProjectDir {
            projects: root.join("projects"),
            dir: root.join("projects/-vault"),
            shared: false,
        };
        std::fs::create_dir_all(&located.dir).unwrap();
        let text: String = lines.iter().map(|line| format!("{line}\n")).collect();
        std::fs::write(located.dir.join(format!("{id}.jsonl")), text).unwrap();
        (root, located)
    }

    const ID: &str = "00000000-0000-4000-8000-000000000001";

    #[test]
    fn reading_a_session_file_folds_it() {
        let lines: Vec<Value> = serde_json::from_str(include_str!(
            "../../fixtures/cli-stream/transcript-two-turns.session.json"
        ))
        .unwrap();
        let (root, located) = session_at("cli-read", ID, &lines);
        let read = read_in(Some(&located), Some(30), Some(ID), None, Utc::now());
        let expected = super::super::fold::fold_lines(&lines);
        match read {
            TranscriptRead::Read {
                events,
                lines: count,
                unclassified,
            } => {
                assert_eq!(
                    serde_json::to_value(&events).unwrap(),
                    serde_json::to_value(&expected.events).unwrap()
                );
                assert_eq!(count, lines.len());
                assert!(unclassified.is_empty(), "{unclassified:?}");
            }
            other => panic!("expected a read, got {other:?}"),
        }
        // A blank or unparsable line is skipped, never fatal.
        let mut text = std::fs::read_to_string(located.dir.join(format!("{ID}.jsonl"))).unwrap();
        text.push_str("\nnot json\n\n");
        std::fs::write(located.dir.join(format!("{ID}.jsonl")), text).unwrap();
        assert!(matches!(
            read_in(Some(&located), Some(30), Some(ID), None, Utc::now()),
            TranscriptRead::Read { lines: count, .. } if count == lines.len()
        ));
        // Gone: cleared or expired by the clock.
        std::fs::remove_file(located.dir.join(format!("{ID}.jsonl"))).unwrap();
        let now = Utc::now();
        assert!(matches!(
            read_in(
                Some(&located),
                Some(30),
                Some(ID),
                Some(now - chrono::Duration::days(40)),
                now
            ),
            TranscriptRead::Unavailable {
                reason: Unavailable::Expired,
                retention_days: Some(30),
                ..
            }
        ));
        assert!(matches!(
            read_in(Some(&located), Some(30), Some(ID), Some(now), now),
            TranscriptRead::Unavailable {
                reason: Unavailable::Cleared,
                ..
            }
        ));
        let _ = std::fs::remove_dir_all(root);
    }

    // --- A session's subagents (M91.3b) ---------------------------------------

    const SUBAGENT_SESSION: &str =
        include_str!("../../fixtures/cli-stream/transcript-subagent.session.json");
    const SUBAGENT_LINES: &str = include_str!(
        "../../fixtures/cli-stream/transcript-subagent.agents/agent-a0000000000000001.jsonl"
    );
    const SUBAGENT_META: &str = include_str!(
        "../../fixtures/cli-stream/transcript-subagent.agents/agent-a0000000000000001.meta.json"
    );

    /// The session's subagents folder, as Claude Code lays it out.
    fn subagents_dir(located: &CliProjectDir) -> PathBuf {
        let dir = located.dir.join(ID).join("subagents");
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn parented(events: &[AgentEvent]) -> usize {
        serde_json::to_value(events)
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .filter(|event| event.get("parent").is_some())
            .count()
    }

    #[test]
    fn a_session_reads_its_subagents_own_transcripts() {
        let lines: Vec<Value> = serde_json::from_str(SUBAGENT_SESSION).unwrap();
        let (root, located) = session_at("cli-subagents", ID, &lines);
        let dir = subagents_dir(&located);
        std::fs::write(dir.join("agent-a0000000000000001.jsonl"), SUBAGENT_LINES).unwrap();
        std::fs::write(dir.join("agent-a0000000000000001.meta.json"), SUBAGENT_META).unwrap();
        let read = read_in(Some(&located), Some(30), Some(ID), None, Utc::now());
        let TranscriptRead::Read {
            events,
            lines: count,
            unclassified,
        } = read
        else {
            panic!("expected a read, got {read:?}");
        };
        let subagent: Vec<Value> = SUBAGENT_LINES
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(count, lines.len() + subagent.len());
        assert!(unclassified.is_empty(), "{unclassified:?}");
        let expected = super::super::fold::fold_session(
            &lines,
            vec![SubagentTranscript {
                meta: Some(serde_json::from_str(SUBAGENT_META).unwrap()),
                lines: Box::new(subagent.into_iter()),
            }],
        );
        assert_eq!(
            serde_json::to_value(&events).unwrap(),
            serde_json::to_value(&expected.events).unwrap()
        );
        assert_eq!(
            parented(&events),
            5,
            "the subagent's steps, each naming its call"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn a_subagent_transcript_that_cannot_be_read_leaves_the_session_whole() {
        let lines: Vec<Value> = serde_json::from_str(SUBAGENT_SESSION).unwrap();
        let (root, located) = session_at("cli-subagents-unreadable", ID, &lines);
        let dir = subagents_dir(&located);
        // A transcript that cannot be read as a file, beside its meta.
        std::fs::create_dir_all(dir.join("agent-a0000000000000001.jsonl")).unwrap();
        std::fs::write(dir.join("agent-a0000000000000001.meta.json"), SUBAGENT_META).unwrap();
        // One whose meta does not parse, so no call holds its lines.
        std::fs::write(
            dir.join("agent-b.jsonl"),
            format!("{SUBAGENT_LINES}not json\n\n"),
        )
        .unwrap();
        std::fs::write(dir.join("agent-b.meta.json"), "{ \"toolUseId\": ").unwrap();
        // A meta with no transcript, and a file that is neither.
        std::fs::write(dir.join("agent-c.meta.json"), SUBAGENT_META).unwrap();
        std::fs::write(dir.join("notes.txt"), "not a transcript").unwrap();
        let read = read_in(Some(&located), Some(30), Some(ID), None, Utc::now());
        let TranscriptRead::Read {
            events,
            unclassified,
            ..
        } = read
        else {
            panic!("the session still reads: {read:?}");
        };
        assert!(unclassified.is_empty(), "{unclassified:?}");
        assert_eq!(
            parented(&events),
            0,
            "its subagent's steps are not recorded"
        );
        assert_eq!(
            serde_json::to_value(&events).unwrap(),
            serde_json::to_value(super::super::fold::fold_lines(&lines).events).unwrap(),
            "and the session file's own fold is whole"
        );
        // No subagents folder at all reads the same.
        std::fs::remove_dir_all(&dir).unwrap();
        assert!(matches!(
            read_in(Some(&located), Some(30), Some(ID), None, Utc::now()),
            TranscriptRead::Read { events: again, .. }
                if serde_json::to_value(&again).unwrap() == serde_json::to_value(&events).unwrap()
        ));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn a_subagent_transcript_is_read_a_chunk_at_a_time() {
        let root = crate::vault::testutil::temp_vault("cli-subagent-chunks");
        let path = root.join("agent-x.jsonl");
        let total = CHUNK_LINES * 3 + 5;
        let mut text = String::new();
        for n in 0..total {
            text.push_str(&format!("{{\"n\":{n}}}\n"));
            if n == CHUNK_LINES {
                text.push_str("\nnot json\n");
            }
        }
        std::fs::write(&path, &text).unwrap();
        let mut lines = ChunkedLines::new(path.clone());
        // The first look reads one line, all the merge needs until the
        // subagent's turn comes; the next reads a chunk.
        assert_eq!(lines.next(), Some(serde_json::json!({ "n": 0 })));
        assert!(lines.lines.is_empty());
        assert_eq!(lines.next(), Some(serde_json::json!({ "n": 1 })));
        assert_eq!(lines.lines.len(), CHUNK_LINES - 1);
        let rest: Vec<u64> = lines.map(|line| line["n"].as_u64().unwrap()).collect();
        assert_eq!(rest, (2..total as u64).collect::<Vec<_>>());
        // A chunk stops at its bytes, a line past them at most.
        let wide = format!("{{\"pad\":\"{}\"}}\n", "x".repeat(100 * 1024)).repeat(5);
        std::fs::write(&path, wide).unwrap();
        let mut lines = ChunkedLines::new(path.clone());
        assert!(lines.next().is_some());
        assert!(lines.next().is_some());
        assert!(lines.lines.len() < 3, "{}", lines.lines.len());
        assert_eq!(lines.count(), 3);
        // A transcript gone before it is read gives nothing, and ends.
        let mut gone = ChunkedLines::new(root.join("absent.jsonl"));
        assert_eq!(gone.next(), None);
        assert!(gone.done);
        let _ = std::fs::remove_dir_all(root);
    }

    // M56.4: a thread rebuilt from its session file shows the same card the
    // live turn did, reset time and all.
    #[test]
    fn a_jsonl_limit_line_restores_with_its_notice() {
        let history: Value = serde_json::from_str(include_str!(
            "../../fixtures/cli-stream/jsonl/usage-limit-weekly.json"
        ))
        .unwrap();
        let lines = vec![
            serde_json::json!({ "type": "user", "uuid": "00000000-0000-4000-8000-000000000050",
                "message": { "role": "user", "content": "What changed this week?" },
                "version": "2.1.250" }),
            history["line"].clone(),
        ];
        let (root, located) = session_at("cli-limit", ID, &lines);
        let read = read_in(Some(&located), Some(30), Some(ID), None, Utc::now());
        let TranscriptRead::Read { events, .. } = read else {
            panic!("expected a read, got {read:?}");
        };
        let notice = events
            .iter()
            .find_map(|event| match event {
                AgentEvent::Error { notice, .. } => notice.clone(),
                _ => None,
            })
            .expect("the limit line's error carries its notice");
        assert_eq!(notice.kind, super::super::failure::FailureKind::UsageLimit);
        assert_eq!(notice.window.as_deref(), Some("weekly"));
        assert_eq!(notice.resets_at.as_deref(), Some("2026-01-01T00:00:00Z"));
        assert_eq!(notice.cli_version.as_deref(), Some("2.1.250"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn an_unreadable_session_file_reads_unreadable() {
        use std::os::unix::fs::PermissionsExt;
        let (root, located) = session_at("cli-unreadable", ID, &[serde_json::json!({})]);
        let file = located.dir.join(format!("{ID}.jsonl"));
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o000)).unwrap();
        // Root reads through any mode, so there is nothing to prove there.
        if std::fs::File::open(&file).is_err() {
            assert!(matches!(
                read_in(Some(&located), Some(30), Some(ID), None, Utc::now()),
                TranscriptRead::Unavailable {
                    reason: Unavailable::Unreadable,
                    detail: Some(_),
                    ..
                }
            ));
        }
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn no_session_id_reads_not_recorded() {
        let located = CliProjectDir {
            projects: PathBuf::from("/nowhere/projects"),
            dir: PathBuf::from("/nowhere/projects/-vault"),
            shared: false,
        };
        for session in [None, Some("mock-session"), Some("../../etc/passwd")] {
            let read = read_in(Some(&located), Some(30), session, None, Utc::now());
            assert!(
                matches!(
                    read,
                    TranscriptRead::Unavailable {
                        reason: Unavailable::NotRecorded,
                        ..
                    }
                ),
                "{session:?}: {read:?}"
            );
        }
        let wire = serde_json::to_value(read_in(None, None, None, None, Utc::now())).unwrap();
        assert_eq!(
            wire,
            serde_json::json!({ "state": "unavailable", "reason": "not_recorded", "retention_days": null })
        );
    }

    // --- A deferral left open (M57.1) --------------------------------------

    fn marker(id: &str, name: &str) -> String {
        serde_json::json!({
            "type": "attachment",
            "attachment": {
                "type": "hook_deferred_tool", "toolUseID": id, "toolName": name,
                "toolInput": {}, "hookName": "PreToolUse:x", "hookEvent": "PreToolUse",
                "permissionMode": "acceptEdits"
            },
            "uuid": format!("u-{id}")
        })
        .to_string()
    }

    fn answer(id: &str) -> String {
        serde_json::json!({ "type": "user", "message": { "role": "user", "content": [
            { "type": "tool_result", "tool_use_id": id, "content": "ok" } ] } })
        .to_string()
    }

    #[test]
    fn pending_deferral_finds_the_last_unresolved_marker() {
        let tail = [
            r#"{"type":"user","message":{"role":"user","content":"go"}}"#.to_string(),
            marker("toolu_a", "mcp__cerebro__append_to_note"),
            answer("toolu_a"),
            marker("toolu_b", "mcp__cerebro__edit_note"),
            r#"{"type":"last-prompt","lastPrompt":"go"}"#.to_string(),
        ]
        .join("\n");
        assert_eq!(
            pending_deferral_in(&tail),
            Some(PendingDeferral {
                tool_use_id: "toolu_b".into(),
                tool_name: "mcp__cerebro__edit_note".into()
            })
        );
        // A marker named in some other line's text is not a marker.
        let quoted = r#"{"type":"user","message":{"content":"hook_deferred_tool"}}"#;
        assert_eq!(pending_deferral_in(quoted), None);
    }

    #[test]
    fn a_marker_answered_later_is_resolved() {
        let tail = [marker("toolu_a", "Bash"), answer("toolu_a")].join("\n");
        assert_eq!(pending_deferral_in(&tail), None);
        // The CLI's own test is a substring one, and so is this one: a later
        // line that spells the key with a space reads as answered too.
        let spaced = format!(
            "{}\n{{\"type\": \"user\", \"tool_use_id\": \"toolu_a\"}}",
            marker("toolu_a", "Bash")
        );
        assert_eq!(pending_deferral_in(&spaced), None);
        // Only a LATER line resolves it.
        let earlier = [answer("toolu_a"), marker("toolu_a", "Bash")].join("\n");
        assert!(pending_deferral_in(&earlier).is_some());
    }

    #[test]
    fn only_the_last_mebibyte_is_read() {
        let root = crate::vault::testutil::temp_vault("deferral-tail");
        let path = root.join("session.jsonl");
        let filler = format!(
            "{{\"type\":\"summary\",\"pad\":\"{}\"}}\n",
            "x".repeat(1000)
        );
        let mut text = marker("toolu_old", "Bash");
        text.push('\n');
        while (text.len() as u64) < DEFERRAL_TAIL_BYTES + 4096 {
            text.push_str(&filler);
        }
        std::fs::write(&path, &text).unwrap();
        // The marker sits before the last mebibyte, so it is never read.
        assert_eq!(pending_deferral_at(&path), None);
        text.push_str(&marker("toolu_new", "Bash"));
        text.push('\n');
        std::fs::write(&path, &text).unwrap();
        assert_eq!(
            pending_deferral_at(&path).map(|p| p.tool_use_id),
            Some("toolu_new".to_string())
        );
    }

    #[test]
    fn an_unreadable_session_has_none() {
        let root = crate::vault::testutil::temp_vault("deferral-missing");
        assert_eq!(pending_deferral_at(&root.join("absent.jsonl")), None);
        // A folder where the file should be cannot be read either.
        assert_eq!(pending_deferral_at(&root), None);
        // And a session id that is not one never becomes a path.
        assert_eq!(pending_deferral(&root, "../../etc/passwd"), None);
    }
}
