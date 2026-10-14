//! Claude Code's own session file for a vault, found and read back (M56.3).
//!
//! Cerebro spawns Claude Code with the vault as its cwd, and the CLI writes
//! every turn of a session to `<config home>/projects/<key>/<session>.jsonl`.
//! That file is the transcript: the panel's localStorage keeps only a cached
//! copy, and a thread whose copy is gone rebuilds from the file through the
//! same fold the live stream goes through (`super::fold`).
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

use std::ffi::OsString;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::Value;
use unicode_normalization::UnicodeNormalization;

use super::fold::{LineClass, TranscriptFold};
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

/// The Claude Code session a run goes to: the one it resumes, or one minted
/// for it, so its id is known before the CLI says a word.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CliSession {
    Resume(String),
    New(String),
}

impl CliSession {
    /// A request's session: a stored id resumes, nothing mints one, and a
    /// stored value that is not a session id is refused before anything runs.
    pub fn for_request(resume: Option<&str>) -> Result<Self, String> {
        match resume.map(str::trim).filter(|id| !id.is_empty()) {
            None => Ok(Self::New(mint_session_id())),
            Some(id) => parse_session_id(id).map(Self::Resume).ok_or_else(|| {
                let shown: String = id.chars().take(40).collect();
                format!(
                    "This conversation's stored Claude Code session ({}) is not a session id, so nothing was started. Start a new conversation.",
                    serde_json::Value::String(shown)
                )
            }),
        }
    }

    pub fn id(&self) -> &str {
        match self {
            Self::Resume(id) | Self::New(id) => id,
        }
    }

    /// The two argv elements that name the session.
    pub fn args(&self) -> [String; 2] {
        match self {
            Self::Resume(id) => ["--resume".into(), id.clone()],
            Self::New(id) => ["--session-id".into(), id.clone()],
        }
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
        /// Lines folded, blank and unparsable ones left out.
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

/// Fold the session `id` in `located`. Stores nothing: the file is read
/// through once and folded as it goes.
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
    let mut fold = TranscriptFold::default();
    let mut events = Vec::new();
    let mut unclassified: Vec<String> = Vec::new();
    let mut lines = 0usize;
    let mut raw = Vec::new();
    loop {
        raw.clear();
        match reader.read_until(b'\n', &mut raw) {
            Ok(0) => break,
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => {
                return unavailable(Unavailable::Unreadable, retention, Some(error.to_string()));
            }
        }
        let line = String::from_utf8_lossy(&raw);
        if line.trim().is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        lines += 1;
        let (class, folded) = fold.entry(&value);
        if let LineClass::Unclassified(kind) = class {
            if !unclassified.contains(&kind) {
                unclassified.push(kind);
            }
        }
        events.extend(folded);
    }
    events.extend(fold.finish());
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
            assert!(CliSession::for_request(Some(bad)).is_err() || bad.is_empty());
        }
        let refused = CliSession::for_request(Some("--dangerously-skip-permissions")).unwrap_err();
        assert!(refused.contains("not a session id"), "{refused}");
        assert_eq!(
            CliSession::for_request(Some(good)),
            Ok(CliSession::Resume(good.into()))
        );
        assert!(matches!(
            CliSession::for_request(Some("  ")),
            Ok(CliSession::New(_))
        ));
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
            matches!(CliSession::for_request(None), Ok(CliSession::New(id)) if parse_session_id(&id).is_some())
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
