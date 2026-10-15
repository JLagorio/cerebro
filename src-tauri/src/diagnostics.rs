//! The diagnostic log (M53.24): one capped, redacted JSONL file under
//! `app_dir()/logs`. A Finder-launched app's stderr goes nowhere, so without
//! this file a warning, a panic or a webview error would leave no trace.
//!
//! **What lands here.** Every `log::` line this crate writes at Info and up,
//! and Warn and up from dependencies: tauri, wry and tao log through the same
//! facade. Each panic, with its location and thread. Each uncaught webview
//! error, through [`log_frontend`]. One JSON object per line: `ts`, `level`,
//! `target` and `msg`, then `loc` and `thread` on a panic, or `source` and
//! `stack` on a webview error. Each process starts with a session line that
//! names its build and pid.
//!
//! **What it is not.** It is neither of CV-06's records. Product logic never
//! reads it, no refusal lands here, no command exports it, and nothing in it
//! reaches the vault or `runtime.db`. It is a file for a person to read after
//! something broke.
//!
//! **Bounds.** A write that would take the file past 1 MiB first renames it
//! over the one previous file, so the log never holds more than two. A
//! message is cut at 2 KiB. Every field is redacted ([`redact`]) before it is
//! written. Pattern redaction is defence in depth: a call site still never
//! logs a note body or a credential.
//!
//! **Before the app is ready.** [`init`] runs first in `run`, and [`arm`]
//! runs on `RunEvent::Ready`. Lines logged in between wait in memory, at most
//! 256 with the rest counted, and follow the session line once the file
//! opens. A panic that ends the process before then never reaches the file;
//! stderr still shows it.
//!
//! **Nothing else prints.** Cargo.toml denies `print_stdout` and
//! `print_stderr`. A debug build mirrors each `log::` line to stderr, so
//! `pnpm tauri dev` still shows it; that mirror and two `#[ignore]`d digest
//! writers are the only prints, each under a reasoned expectation.

use std::any::Any;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::panic::Location;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, Once, PoisonError, TryLockError};
use std::time::Duration;

use log::{Level, LevelFilter, Log, Metadata, Record};
use serde::Deserialize;
use serde_json::{Map, Value};

/// The log's file, in `app_dir()/logs`.
const FILE: &str = "cerebro.jsonl";
/// The one earlier file a rotation keeps.
const PREVIOUS: &str = "cerebro.1.jsonl";
/// The most bytes either file holds.
const CAP: u64 = 1024 * 1024;
/// Lines held before the file opens; later ones are only counted.
const PENDING_MAX: usize = 256;
/// A message's byte limit, after redaction.
const MSG_MAX: usize = 2 * 1024;
/// A webview error's `source`, and any short field, after redaction.
const SOURCE_MAX: usize = 512;
/// A webview error's `stack`, after redaction.
const STACK_MAX: usize = 4 * 1024;

/// This crate's target: a `log::` macro names its module path.
const CRATE: &str = env!("CARGO_CRATE_NAME");
/// The target of a webview error, from [`log_frontend`].
const WEBVIEW: &str = "webview";
/// The target of a panic, from the hook [`init`] installs.
const PANIC: &str = "panic";

/// How long the panic hook waits for a busy sink: tries, and the pause
/// between them.
const PANIC_TRIES: u32 = 20;
const PANIC_PAUSE: Duration = Duration::from_millis(5);

static LOGGER: Logger = Logger {
    sink: Mutex::new(Sink::new()),
};

/// Install the logger and the panic hook. The first thing `run` does; a
/// second call changes nothing.
pub fn init() {
    static INSTALLED: Once = Once::new();
    INSTALLED.call_once(|| {
        if log::set_logger(&LOGGER).is_ok() {
            log::set_max_level(LevelFilter::Info);
        }
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            let thread = std::thread::current();
            let line = panic_record(info.payload(), info.location(), thread.name()).to_string();
            write_unless_busy(&LOGGER.sink, &line);
            previous(info);
        }));
    });
}

/// Open the file and write what waited. Called on `RunEvent::Ready`, which
/// tauri raises right after `setup`. A second call changes nothing, and a
/// failure turns the log off for the rest of the session.
pub fn arm(app: &tauri::AppHandle) {
    let dir = crate::app_config::app_dir(app).map(|dir| dir.join("logs"));
    let session = session_record().to_string();
    let mut sink = LOGGER.lock();
    match dir {
        Ok(dir) => sink.arm(&dir, CAP, &session),
        Err(_) => sink.turn_off(),
    }
}

/// One uncaught webview error, as `src/lib/diagnostics.ts` sends it. Read
/// leniently: an unknown field is ignored and a missing one is empty.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct FrontendEntry {
    /// `error` or `warn`; anything else is logged as `error`.
    pub level: String,
    pub message: String,
    /// `file:line:col`, when the webview knew it.
    pub source: Option<String>,
    pub stack: Option<String>,
}

/// The webview's door into the diagnostic log: `installErrorReporting` sends
/// each uncaught error and unhandled rejection here, as raw text. It returns
/// nothing, and no command reads the log back.
#[tauri::command(async)]
pub fn log_frontend(entry: FrontendEntry) {
    let line = webview_record(&entry).to_string();
    LOGGER.lock().write(&line);
}

struct Logger {
    sink: Mutex<Sink>,
}

impl Logger {
    /// The sink, even after a panic poisoned its lock: a line lost mid-write
    /// costs less than a log that stops for the rest of the session.
    fn lock(&self) -> MutexGuard<'_, Sink> {
        self.sink.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

impl Log for Logger {
    fn enabled(&self, metadata: &Metadata<'_>) -> bool {
        admits(metadata)
    }

    fn log(&self, record: &Record<'_>) {
        if !admits(record.metadata()) {
            return;
        }
        let line =
            facade_record(record.level(), record.target(), &record.args().to_string()).to_string();
        mirror(&line);
        self.lock().write(&line);
    }

    // Each line is one unbuffered write, so nothing waits to be flushed.
    fn flush(&self) {}
}

/// Info and up from this crate, the webview and panics; Warn and up from
/// every dependency.
fn admits(metadata: &Metadata<'_>) -> bool {
    let target = metadata.target();
    let ours = target == CRATE
        || target
            .strip_prefix(CRATE)
            .is_some_and(|rest| rest.starts_with("::"))
        || target == WEBVIEW
        || target == PANIC;
    metadata.level() <= if ours { Level::Info } else { Level::Warn }
}

/// A debug build's copy of each `log::` line, so `pnpm tauri dev` still
/// shows it. A release build has no terminal to show it in.
#[expect(
    clippy::print_stderr,
    reason = "dev-only mirror so pnpm tauri dev still shows diagnostics; the file is the copy \
              that persists"
)]
fn mirror(line: &str) {
    if cfg!(debug_assertions) {
        eprintln!("{line}");
    }
}

/// Write `line` unless another holder keeps the sink busy past the panic
/// hook's patience. A blocking lock here would deadlock a panic raised while
/// this thread holds the sink; the price is that panic's line. Returns
/// whether the line was written.
fn write_unless_busy(sink: &Mutex<Sink>, line: &str) -> bool {
    for _ in 0..PANIC_TRIES {
        match sink.try_lock() {
            Ok(mut sink) => {
                sink.write(line);
                return true;
            }
            Err(TryLockError::Poisoned(poisoned)) => {
                poisoned.into_inner().write(line);
                return true;
            }
            Err(TryLockError::WouldBlock) => std::thread::sleep(PANIC_PAUSE),
        }
    }
    false
}

/// Where lines go: held until the file opens, then appended to it.
enum Sink {
    /// Before [`arm`]: the first [`PENDING_MAX`] lines, and a count of the
    /// rest.
    Pending { lines: Vec<String>, dropped: u64 },
    /// Writing to the file.
    Armed(Armed),
    /// The file could not be opened, or a write failed: lines are dropped.
    Off,
}

impl Sink {
    const fn new() -> Sink {
        Sink::Pending {
            lines: Vec::new(),
            dropped: 0,
        }
    }

    /// Append one finished line, or hold it until the file opens.
    fn write(&mut self, line: &str) {
        match self {
            Sink::Pending { lines, dropped } => {
                if lines.len() < PENDING_MAX {
                    lines.push(line.to_string());
                } else {
                    *dropped += 1;
                }
            }
            Sink::Armed(armed) => {
                if armed.append(line).is_err() {
                    *self = Sink::Off;
                }
            }
            Sink::Off => {}
        }
    }

    /// Open `dir`'s file and write `session`, then every held line in order,
    /// then how many were dropped. Only a pending sink arms; a failure turns
    /// it off.
    fn arm(&mut self, dir: &Path, cap: u64, session: &str) {
        let Sink::Pending { lines, dropped } = self else {
            return;
        };
        let held = std::mem::take(lines);
        let dropped = *dropped;
        let opened = Armed::open(dir, cap).and_then(|mut armed| {
            armed.append(session)?;
            for line in &held {
                armed.append(line)?;
            }
            if dropped > 0 {
                armed.append(&dropped_record(dropped).to_string())?;
            }
            Ok(armed)
        });
        *self = match opened {
            Ok(armed) => Sink::Armed(armed),
            Err(_) => Sink::Off,
        };
    }

    /// A sink that will never arm stops holding lines.
    fn turn_off(&mut self) {
        if let Sink::Pending { .. } = self {
            *self = Sink::Off;
        }
    }
}

/// The open file, and how many bytes it holds.
struct Armed {
    dir: PathBuf,
    file: File,
    bytes: u64,
    cap: u64,
}

impl Armed {
    fn open(dir: &Path, cap: u64) -> std::io::Result<Armed> {
        std::fs::create_dir_all(dir)?;
        let file = open_private(&dir.join(FILE))?;
        let bytes = file.metadata()?.len();
        Ok(Armed {
            dir: dir.to_path_buf(),
            file,
            bytes,
            cap,
        })
    }

    /// Append `line` and its newline in one write. A line that would take a
    /// non-empty file past the cap first renames the file over the previous
    /// one and starts a fresh one.
    fn append(&mut self, line: &str) -> std::io::Result<()> {
        let mut bytes = Vec::with_capacity(line.len() + 1);
        bytes.extend_from_slice(line.as_bytes());
        bytes.push(b'\n');
        let len = bytes.len() as u64;
        if self.bytes > 0 && self.bytes + len > self.cap {
            std::fs::rename(self.dir.join(FILE), self.dir.join(PREVIOUS))?;
            self.file = open_private(&self.dir.join(FILE))?;
            self.bytes = 0;
        }
        self.file.write_all(&bytes)?;
        self.bytes += len;
        Ok(())
    }
}

/// The log file, opened to append, created readable by its owner only. A
/// rename keeps the mode, so the previous file is private too.
fn open_private(path: &Path) -> std::io::Result<File> {
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

/// A line's four leading fields, every string redacted and cut to its limit.
fn base(level: &str, target: &str, msg: &str) -> Map<String, Value> {
    let mut object = Map::new();
    object.insert(
        "ts".into(),
        chrono::Utc::now()
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
            .into(),
    );
    object.insert("level".into(), level.into());
    object.insert("target".into(), scrub(target, SOURCE_MAX).into());
    object.insert("msg".into(), scrub(msg, MSG_MAX).into());
    object
}

/// A `log::` line.
fn facade_record(level: Level, target: &str, msg: &str) -> Value {
    Value::Object(base(&level.as_str().to_ascii_lowercase(), target, msg))
}

/// The line each process starts its part of the file with.
fn session_record() -> Value {
    let mut object = base("info", "session", "session started");
    object.insert(
        "build".into(),
        scrub(&crate::app_config::build_label(), SOURCE_MAX).into(),
    );
    object.insert("pid".into(), std::process::id().into());
    Value::Object(object)
}

/// What the held lines lost, when more were logged than the sink holds.
fn dropped_record(dropped: u64) -> Value {
    let mut object = base(
        "warn",
        module_path!(),
        &format!("{dropped} line(s) logged before the log file opened were dropped"),
    );
    object.insert("dropped".into(), dropped.into());
    Value::Object(object)
}

/// A webview error: its level forced to `error` or `warn`, each field
/// redacted and clamped.
fn webview_record(entry: &FrontendEntry) -> Value {
    let level = if entry.level.eq_ignore_ascii_case("warn") {
        "warn"
    } else {
        "error"
    };
    let mut object = base(level, WEBVIEW, &entry.message);
    if let Some(source) = &entry.source {
        object.insert("source".into(), scrub(source, SOURCE_MAX).into());
    }
    if let Some(stack) = &entry.stack {
        object.insert("stack".into(), scrub(stack, STACK_MAX).into());
    }
    Value::Object(object)
}

/// A panic: its message when the payload is a string, where it was raised,
/// and on which thread.
fn panic_record(
    payload: &(dyn Any + Send),
    location: Option<&Location<'_>>,
    thread: Option<&str>,
) -> Value {
    let msg = payload
        .downcast_ref::<&str>()
        .copied()
        .or_else(|| payload.downcast_ref::<String>().map(String::as_str))
        .unwrap_or("a panic whose payload is not a string");
    let mut object = base("error", PANIC, msg);
    if let Some(location) = location {
        let loc = format!(
            "{}:{}:{}",
            location.file(),
            location.line(),
            location.column()
        );
        object.insert("loc".into(), scrub(&loc, SOURCE_MAX).into());
    }
    object.insert(
        "thread".into(),
        scrub(thread.unwrap_or("<unnamed>"), SOURCE_MAX).into(),
    );
    Value::Object(object)
}

/// Redacted, then cut to `max` bytes. Redacting first means a cut never
/// leaves a credential short enough to slip past the shape rules.
fn scrub(text: &str, max: usize) -> String {
    clamp(&redact(text), max)
}

/// `text` cut to at most `max` bytes on a character boundary, with a marker
/// saying how many bytes went.
fn clamp(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_string();
    }
    let mut cut = max;
    while !text.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{} [truncated {} bytes]", &text[..cut], text.len() - cut)
}

/// What a masked value becomes.
const MASK: &str = "[redacted]";

/// Keys whose value is masked, matched on the end of the lowercased key, so
/// `GITHUB_TOKEN` and `mcpToken` match and `input_tokens` does not.
const SECRET_KEYS: [&str; 13] = [
    "token",
    "secret",
    "password",
    "passwd",
    "apikey",
    "api_key",
    "api-key",
    "authorization",
    "credential",
    "credentials",
    "private_key",
    "secret_key",
    "access_key",
];

/// HTTP auth schemes. After one, the credential is the next word, and the
/// scheme stays readable.
const SCHEMES: [&str; 4] = ["bearer", "basic", "token", "digest"];

/// The prefixes of keys a connector is likely to hold: Anthropic and OpenAI,
/// GitHub, Slack, GitLab, AWS and Cerebro's personal tokens.
const KEY_PREFIXES: [&str; 13] = [
    "cbr_",
    "sk-",
    "ghp_",
    "gho_",
    "ghs_",
    "ghu_",
    "github_pat_",
    "xoxb-",
    "xoxp-",
    "xoxa-",
    "xoxr-",
    "glpat-",
    "AKIA",
];

/// A prefixed key is at least this long, prefix included.
const KEY_MIN: usize = 20;

/// The length of a bearer `mcp.rs` mints: lowercase ASCII letters only.
const TOKEN_LEN: usize = 32;

/// Mask what looks like a credential. Hand-rolled, with no regex crate:
///
/// 1. The value after `Bearer ` (any case).
/// 2. The value after `=` or `:` when the key before it names a secret
///    ([`SECRET_KEYS`]). A quoted value is masked inside its quotes.
/// 3. The password in a URL: `scheme://user:[redacted]@host`.
/// 4. A word of [`KEY_MIN`] or more characters that starts with one of
///    [`KEY_PREFIXES`]. The prefix stays readable.
/// 5. A run of exactly 32 lowercase ASCII letters, the shape of the bearer
///    `mcp.rs` mints for each run.
///
/// The only copy of these rules is here: the webview sends raw text.
fn redact(text: &str) -> String {
    let text = mask_bearers(text);
    let text = mask_secret_values(&text);
    let text = mask_url_passwords(&text);
    let text = mask_key_prefixes(&text);
    mask_token_shape(&text)
}

/// Where an unquoted value stops.
fn ends_value(c: char) -> bool {
    c.is_whitespace()
        || matches!(
            c,
            '"' | '\'' | '`' | ',' | ';' | '&' | '(' | ')' | '[' | ']' | '{' | '}' | '<' | '>'
        )
}

/// The span to mask in `value`, as offsets into it: inside its quotes when
/// it opens with one, escaped (`\"`) or not, else up to [`ends_value`].
/// `None` when it is empty or masked already.
fn value_span(value: &str) -> Option<(usize, usize)> {
    for quote in ["\\\"", "\\'", "\"", "'"] {
        if let Some(inner) = value.strip_prefix(quote) {
            let len = if quote.len() == 2 {
                inner.find(quote)
            } else {
                closing_quote(inner, quote)
            }
            .unwrap_or(inner.len());
            let open = quote.len();
            return (len > 0 && !inner.starts_with(MASK)).then_some((open, open + len));
        }
    }
    // An unquoted `[redacted]` stops at its bracket, so it is never masked
    // twice.
    let len = value.find(ends_value).unwrap_or(value.len());
    (len > 0).then_some((0, len))
}

/// Where the quote that closes a value is, past escaped ones.
fn closing_quote(inner: &str, quote: &str) -> Option<usize> {
    let mut escaped = false;
    for (at, c) in inner.char_indices() {
        if escaped {
            escaped = false;
        } else if c == '\\' {
            escaped = true;
        } else if quote.starts_with(c) {
            return Some(at);
        }
    }
    None
}

/// Rule 1: the value after `Bearer` and a blank.
fn mask_bearers(text: &str) -> String {
    const WORD: &str = "bearer";
    // ASCII lowercasing keeps every byte offset.
    let lower = text.to_ascii_lowercase();
    let mut out = String::with_capacity(text.len());
    let mut copied = 0;
    let mut from = 0;
    while let Some(found) = lower[from..].find(WORD) {
        from += found + WORD.len();
        let rest = &text[from..];
        let value = rest.trim_start_matches([' ', '\t']);
        if value.len() == rest.len() {
            continue;
        }
        let offset = text.len() - value.len();
        let Some((start, end)) = value_span(value) else {
            continue;
        };
        out.push_str(&text[copied..offset + start]);
        out.push_str(MASK);
        copied = offset + end;
        from = copied;
    }
    out.push_str(&text[copied..]);
    out
}

/// Rule 2: the value after a secret-named key.
fn mask_secret_values(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut copied = 0;
    let mut at = 0;
    while at < bytes.len() {
        if is_separator(bytes, at) && key_before(text, at).is_some_and(names_secret) {
            if let Some((start, end)) = value_after(text, at + 1) {
                out.push_str(&text[copied..start]);
                out.push_str(MASK);
                copied = end;
                at = end;
                continue;
            }
        }
        at += 1;
    }
    out.push_str(&text[copied..]);
    out
}

/// A lone `=` or `:`: not `==`, `!=`, `<=`, `>=`, `=>` or a path's `::`.
fn is_separator(bytes: &[u8], at: usize) -> bool {
    let before = at.checked_sub(1).map(|i| bytes[i]);
    let after = bytes.get(at + 1).copied();
    match bytes[at] {
        b'=' => {
            !matches!(before, Some(b'=' | b'!' | b'<' | b'>'))
                && !matches!(after, Some(b'=' | b'>'))
        }
        b':' => before != Some(b':') && after != Some(b':'),
        _ => false,
    }
}

fn is_key_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.')
}

/// The key that ends just before `at`, past blanks and one closing quote,
/// escaped (`\"`) or not.
fn key_before(text: &str, at: usize) -> Option<&str> {
    let head = text[..at].trim_end_matches([' ', '\t']);
    let head = head.strip_suffix(['"', '\'']).map_or(head, |unquoted| {
        unquoted.strip_suffix('\\').unwrap_or(unquoted)
    });
    let key = &head[head.trim_end_matches(is_key_char).len()..];
    (!key.is_empty()).then_some(key)
}

fn names_secret(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    SECRET_KEYS.iter().any(|secret| key.ends_with(secret))
}

/// The byte range to mask in the value that starts after `from`, past
/// blanks ([`value_span`]). After an unquoted auth scheme it is the
/// credential that follows, and the scheme stays readable. `None` when there
/// is nothing to mask, or it is masked already.
fn value_after(text: &str, from: usize) -> Option<(usize, usize)> {
    let value = text[from..].trim_start_matches([' ', '\t']);
    let offset = text.len() - value.len();
    let (start, end) = value_span(value)?;
    let unquoted_scheme = start == 0
        && SCHEMES
            .iter()
            .any(|scheme| value[..end].eq_ignore_ascii_case(scheme));
    if unquoted_scheme {
        let after = &value[end..];
        let credential = after.trim_start_matches([' ', '\t']);
        if credential.len() < after.len() && !credential.is_empty() {
            // `None` when rule 1 masked the credential already.
            let at = text.len() - credential.len();
            return value_span(credential).map(|(from, to)| (at + from, at + to));
        }
    }
    Some((offset + start, offset + end))
}

/// Rule 3: a URL's password, between `user:` and `@host`.
fn mask_url_passwords(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut copied = 0;
    let mut from = 0;
    while let Some(found) = text[from..].find("://") {
        let authority_at = from + found + "://".len();
        let rest = &text[authority_at..];
        let authority_len = rest
            .find(|c: char| c == '/' || c == '?' || c == '#' || ends_value(c))
            .unwrap_or(rest.len());
        from = authority_at + authority_len;
        let authority = &rest[..authority_len];
        let Some(at_sign) = authority.rfind('@') else {
            continue;
        };
        let Some(colon) = authority[..at_sign].find(':') else {
            continue;
        };
        let password = &authority[colon + 1..at_sign];
        if password.is_empty() || password == MASK {
            continue;
        }
        out.push_str(&text[copied..authority_at + colon + 1]);
        out.push_str(MASK);
        copied = authority_at + at_sign;
    }
    out.push_str(&text[copied..]);
    out
}

/// Rule 4: a long word that starts with a known key prefix.
fn mask_key_prefixes(text: &str) -> String {
    let is_word = |b: u8| b.is_ascii_alphanumeric() || b == b'_' || b == b'-';
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut copied = 0;
    let mut at = 0;
    while at < bytes.len() {
        if !is_word(bytes[at]) {
            at += 1;
            continue;
        }
        let start = at;
        while at < bytes.len() && is_word(bytes[at]) {
            at += 1;
        }
        let word = &text[start..at];
        if word.len() < KEY_MIN {
            continue;
        }
        if let Some(prefix) = KEY_PREFIXES
            .iter()
            .find(|prefix| word.starts_with(**prefix))
        {
            out.push_str(&text[copied..start + prefix.len()]);
            out.push_str(MASK);
            copied = at;
        }
    }
    out.push_str(&text[copied..]);
    out
}

/// Rule 5: a run of exactly [`TOKEN_LEN`] lowercase ASCII letters. No word a
/// diagnostic holds is that long, and a 32-hex id has digits in it.
fn mask_token_shape(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut copied = 0;
    let mut at = 0;
    while at < bytes.len() {
        if !bytes[at].is_ascii_lowercase() {
            at += 1;
            continue;
        }
        let start = at;
        while at < bytes.len() && bytes[at].is_ascii_lowercase() {
            at += 1;
        }
        if at - start == TOKEN_LEN {
            out.push_str(&text[copied..start]);
            out.push_str(MASK);
            copied = at;
        }
    }
    out.push_str(&text[copied..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::testutil;

    /// Each line of a log file, parsed: a line that is not one JSON object
    /// fails here.
    fn read_lines(path: &Path) -> Vec<Value> {
        let text = std::fs::read_to_string(path).expect("the log file");
        assert!(text.is_empty() || text.ends_with('\n'), "{text:?}");
        text.lines()
            .map(|line| {
                serde_json::from_str(line)
                    .unwrap_or_else(|e| panic!("{line:?} is not one JSON object: {e}"))
            })
            .collect()
    }

    fn msgs(lines: &[Value]) -> Vec<&str> {
        lines
            .iter()
            .map(|line| line["msg"].as_str().expect("a msg"))
            .collect()
    }

    /// A line the facade would write, numbered.
    fn numbered(n: usize) -> String {
        facade_record(Level::Info, "cerebro_lib::probe", &format!("line {n}")).to_string()
    }

    fn session() -> String {
        session_record().to_string()
    }

    /// A credential-shaped string, built at run time so this file holds no
    /// literal a secret scanner would stop a push for.
    fn fake(prefix: &str, len: usize) -> String {
        let body: String = "A7".chars().cycle().take(len - prefix.len()).collect();
        format!("{prefix}{body}")
    }

    #[test]
    fn each_line_is_one_json_object() {
        let dir = testutil::temp_vault("diagnostics-lines");
        let logger = Logger {
            sink: Mutex::new(Sink::new()),
        };
        logger.log(
            &Record::builder()
                .args(format_args!("held until {}", "armed"))
                .level(Level::Warn)
                .target("cerebro_lib::probe")
                .build(),
        );
        logger.lock().arm(&dir, CAP, &session());
        logger.log(
            &Record::builder()
                .args(format_args!("two\nlines, \"quoted\""))
                .level(Level::Info)
                .target("cerebro_lib::probe")
                .build(),
        );
        logger.log(
            &Record::builder()
                .args(format_args!("below a dependency's floor"))
                .level(Level::Info)
                .target("wry")
                .build(),
        );
        let entry = FrontendEntry {
            level: "error".into(),
            message: "Uncaught TypeError: x is undefined".into(),
            source: Some("tauri://localhost/assets/index.js:1:2".into()),
            stack: Some("at f (index.js:1:2)".into()),
        };
        logger.lock().write(&webview_record(&entry).to_string());
        let panic = panic_record(&"boom", Some(Location::caller()), Some("main"));
        logger.lock().write(&panic.to_string());

        let lines = read_lines(&dir.join(FILE));
        let targets: Vec<&str> = lines
            .iter()
            .map(|line| line["target"].as_str().expect("a target"))
            .collect();
        assert_eq!(
            targets,
            [
                "session",
                "cerebro_lib::probe",
                "cerebro_lib::probe",
                WEBVIEW,
                PANIC
            ]
        );
        for line in &lines {
            let object = line.as_object().expect("an object");
            let leading: Vec<&str> = object.keys().map(String::as_str).take(4).collect();
            assert_eq!(leading, ["ts", "level", "target", "msg"], "{line}");
            let ts = object["ts"].as_str().expect("a ts");
            chrono::DateTime::parse_from_rfc3339(ts).expect("ts is RFC 3339");
            assert!(object["level"].is_string() && object["msg"].is_string());
        }
        assert_eq!(lines[1]["level"], "warn");
        assert_eq!(lines[2]["msg"], "two\nlines, \"quoted\"");
        assert_eq!(lines[3]["source"], "tauri://localhost/assets/index.js:1:2");
        assert_eq!(lines[4]["thread"], "main");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.join(FILE))
                .expect("the log file")
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600, "readable by its owner only");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_file_rotates_at_its_cap_and_keeps_one_previous() {
        let dir = testutil::temp_vault("diagnostics-rotate");
        let cap = 1000;
        let mut sink = Sink::new();
        sink.arm(&dir, cap, &session());
        let mut previous_starts = Vec::new();
        for n in 0..40 {
            sink.write(&numbered(n));
            if let Ok(previous) = std::fs::read_to_string(dir.join(PREVIOUS)) {
                let first = previous.lines().next().unwrap_or_default().to_string();
                if previous_starts.last() != Some(&first) {
                    previous_starts.push(first);
                }
            }
        }
        assert!(matches!(sink, Sink::Armed(_)));
        assert!(
            previous_starts.len() >= 3,
            "40 lines of ~100 bytes rotate a 1000-byte cap several times: {previous_starts:#?}"
        );
        assert!(
            previous_starts[0].contains("\"target\":\"session\""),
            "the first rotation keeps the session line"
        );
        assert!(
            !previous_starts.last().unwrap().contains("session"),
            "a later rotation replaces the previous file"
        );

        let mut names: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(names, [PREVIOUS, FILE], "never more than two files");
        for name in [FILE, PREVIOUS] {
            let len = std::fs::metadata(dir.join(name)).unwrap().len();
            assert!(len <= cap, "{name} holds {len} bytes, over its {cap}");
        }

        // Nothing between the two files went missing, and the newest line is
        // the current file's last.
        let previous = read_lines(&dir.join(PREVIOUS));
        let current = read_lines(&dir.join(FILE));
        let joined: Vec<&str> = msgs(&previous).into_iter().chain(msgs(&current)).collect();
        let first: usize = joined[0]
            .strip_prefix("line ")
            .and_then(|n| n.parse().ok())
            .expect("a numbered line");
        let expected: Vec<String> = (first..40).map(|n| format!("line {n}")).collect();
        assert_eq!(joined, expected);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn lines_before_arming_are_kept_then_flushed_in_order() {
        let dir = testutil::temp_vault("diagnostics-pending");
        let mut sink = Sink::new();
        for n in 0..PENDING_MAX + 44 {
            sink.write(&numbered(n));
        }
        sink.arm(&dir, CAP, &session());
        sink.write(&numbered(9999));

        let lines = read_lines(&dir.join(FILE));
        assert_eq!(lines.len(), PENDING_MAX + 3);
        assert_eq!(lines[0]["target"], "session");
        assert_eq!(lines[0]["pid"], std::process::id());
        let build = lines[0]["build"].as_str().expect("a build");
        assert!(build.contains(env!("CARGO_PKG_VERSION")), "{build}");
        let held = msgs(&lines[1..=PENDING_MAX]);
        let expected: Vec<String> = (0..PENDING_MAX).map(|n| format!("line {n}")).collect();
        assert_eq!(
            held, expected,
            "held lines follow the session line in order"
        );
        let dropped = &lines[PENDING_MAX + 1];
        assert_eq!(dropped["level"], "warn");
        assert_eq!(dropped["dropped"], 44);
        assert_eq!(lines[PENDING_MAX + 2]["msg"], "line 9999");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn arming_twice_changes_nothing_and_a_failed_arm_turns_the_log_off() {
        let dir = testutil::temp_vault("diagnostics-arm");
        let mut sink = Sink::new();
        sink.arm(&dir, CAP, &session());
        sink.arm(&dir, CAP, &session());
        sink.write(&numbered(1));
        let lines = read_lines(&dir.join(FILE));
        assert_eq!(msgs(&lines), ["session started", "line 1"]);

        // A file where the folder should be: nothing opens, nothing panics,
        // and nothing is held any more.
        let blocked = dir.join("blocked");
        std::fs::write(&blocked, "").unwrap();
        let mut sink = Sink::new();
        sink.write(&numbered(2));
        sink.arm(&blocked, CAP, &session());
        assert!(matches!(sink, Sink::Off));
        sink.write(&numbered(3));
        sink.arm(&dir, CAP, &session());
        assert!(matches!(sink, Sink::Off), "an off sink stays off");

        // With no app directory to arm in, the sink stops holding lines.
        let mut sink = Sink::new();
        sink.write(&numbered(4));
        sink.turn_off();
        assert!(matches!(sink, Sink::Off));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The panic hook gives up on a sink another holder keeps busy, which
    /// is what keeps a panic raised inside the logger from deadlocking it.
    #[test]
    fn a_panic_never_waits_forever_on_a_busy_sink() {
        let sink = Mutex::new(Sink::new());
        let held = sink.lock().unwrap();
        assert!(!write_unless_busy(&sink, "from inside the logger"));
        drop(held);
        assert!(write_unless_busy(&sink, "once it is free"));
        let guard = sink.lock().unwrap();
        let Sink::Pending { lines, .. } = &*guard else {
            panic!("the sink was never armed");
        };
        assert_eq!(lines, &["once it is free"]);
    }

    #[test]
    fn redaction_masks_bearers_and_secret_keys() {
        let github = fake("ghp_", 40);
        let slack = fake("xoxb-", 50);
        let cases = [
            (
                "Authorization: Bearer abc.def".to_string(),
                "Authorization: Bearer [redacted]".to_string(),
            ),
            (
                "curl -H \"authorization: BEARER abc.def\" http://127.0.0.1:4100".into(),
                "curl -H \"authorization: BEARER [redacted]\" http://127.0.0.1:4100".into(),
            ),
            (
                "Authorization: Basic dXNlcjpwYXNz".into(),
                "Authorization: Basic [redacted]".into(),
            ),
            (
                "sent Bearer \"abc def\" and token: Bearer 'xyz'".into(),
                "sent Bearer \"[redacted]\" and token: Bearer '[redacted]'".into(),
            ),
            (
                format!("GITHUB_TOKEN={github}"),
                "GITHUB_TOKEN=[redacted]".into(),
            ),
            (
                format!("{{\"env\":{{\"SLACK_BOT_TOKEN\":\"{slack}\"}}}}"),
                "{\"env\":{\"SLACK_BOT_TOKEN\":\"[redacted]\"}}".into(),
            ),
            (
                "{\\\"api_key\\\":\\\"hunter2\\\"}".into(),
                "{\\\"api_key\\\":\\\"[redacted]\\\"}".into(),
            ),
            ("password: hunter2".into(), "password: [redacted]".into()),
            (
                "mcpToken: \"lettersanddigits123\", next".into(),
                "mcpToken: \"[redacted]\", next".into(),
            ),
            (
                "client_secret='s3cr3t' AWS_SECRET_ACCESS_KEY=wJalr/K7MDENG".into(),
                "client_secret='[redacted]' AWS_SECRET_ACCESS_KEY=[redacted]".into(),
            ),
        ];
        for (raw, masked) in cases {
            assert_eq!(redact(&raw), masked, "{raw}");
            assert_eq!(redact(&masked), masked, "redacting twice changes nothing");
        }
    }

    #[test]
    fn a_personal_token_is_redacted() {
        let token = format!("cbr_{}", "a".repeat(64));
        assert_eq!(redact(&token), "cbr_[redacted]");
        let bearer = redact(&format!("Bearer {token}"));
        assert!(!bearer.contains(&token));
        assert!(bearer.contains("[redacted]"));
    }

    #[test]
    fn redaction_masks_the_mcp_token_shape_and_key_prefixes() {
        let token = "abcdefghijklmnopqrstuvwxyzabcdef";
        assert_eq!(token.len(), TOKEN_LEN);
        assert_eq!(
            redact(&format!("run refused, the request carried {token}.")),
            "run refused, the request carried [redacted]."
        );
        assert_eq!(
            redact(&format!("http://127.0.0.1:4100/mcp?run={token}")),
            "http://127.0.0.1:4100/mcp?run=[redacted]"
        );
        for prefix in KEY_PREFIXES {
            let key = fake(prefix, 40);
            assert_eq!(
                redact(&format!("spawn failed ({key})")),
                format!("spawn failed ({prefix}[redacted])"),
                "{prefix}"
            );
        }
        let aws = fake("AKIA", 20);
        assert_eq!(redact(&aws), "AKIA[redacted]", "20 characters is enough");
        assert_eq!(
            redact("git push failed: https://me:hunter2@example.com/org/repo.git"),
            "git push failed: https://me:[redacted]@example.com/org/repo.git"
        );
    }

    #[test]
    fn redaction_leaves_ordinary_diagnostics_alone() {
        let ordinary = [
            "ambient ingest: skipped (Paused)".to_string(),
            "/Users/me/Vault/records/a.md could not be read".into(),
            "run 0123456789abcdef0123456789abcdef finished".into(),
            "input_tokens: 12, output_tokens: 40, cacheReadInputTokens: 3".into(),
            format!("{} {}", "a".repeat(31), "b".repeat(33)),
            "cerebro_lib::runtime::sink at 12:30:05".into(),
            "ssh://git@github.com/org/repo.git".into(),
            "task-0123456789abcdefghij is not a key".into(),
            "if a == b && c >= d { e => f } else { g != h }".into(),
            "conflict gauntlet: 2 resolved apart, 0 contradiction edge(s) opened".into(),
            "a token was never minted".into(),
            String::new(),
        ];
        for text in ordinary {
            assert_eq!(redact(&text), text);
        }
    }

    #[test]
    fn a_webview_entry_is_clamped_levelled_and_redacted() {
        let entry = FrontendEntry {
            level: "fatal".into(),
            message: format!("probe Bearer abc {}", "x".repeat(10 * 1024)),
            source: Some(format!("index.js:{}", "1".repeat(1024))),
            stack: Some("at f (index.js:1:2)\n".repeat(400)),
        };
        let line = webview_record(&entry);
        assert_eq!(
            line["level"], "error",
            "a level other than warn is an error"
        );
        assert_eq!(line["target"], WEBVIEW);

        let redacted = format!("probe Bearer [redacted] {}", "x".repeat(10 * 1024));
        let msg = line["msg"].as_str().unwrap();
        assert_eq!(
            msg,
            format!(
                "{} [truncated {} bytes]",
                &redacted[..MSG_MAX],
                redacted.len() - MSG_MAX
            )
        );
        for (field, max) in [("source", SOURCE_MAX), ("stack", STACK_MAX)] {
            let value = line[field].as_str().unwrap();
            let (kept, marker) = value.split_at(max);
            assert!(!kept.contains("[truncated"), "{field}");
            assert!(
                marker.starts_with(" [truncated ") && marker.ends_with(" bytes]"),
                "{field}: {marker}"
            );
        }

        let warn = webview_record(&FrontendEntry {
            level: "WARN".into(),
            message: "slow".into(),
            ..FrontendEntry::default()
        });
        assert_eq!(warn["level"], "warn");
        assert!(warn.get("source").is_none() && warn.get("stack").is_none());

        // Lenient: an unknown field is ignored and a missing one is empty.
        let parsed: FrontendEntry =
            serde_json::from_value(serde_json::json!({ "message": "m", "extra": 1 })).unwrap();
        assert_eq!(webview_record(&parsed)["level"], "error");
        assert_eq!(webview_record(&parsed)["msg"], "m");
    }

    #[test]
    fn a_clamp_never_splits_a_character() {
        let text = "é".repeat(10);
        let clamped = clamp(&text, 5);
        assert_eq!(clamped, format!("{} [truncated 16 bytes]", "é".repeat(2)));
    }

    #[test]
    fn a_panic_record_names_message_location_and_thread() {
        let here = Location::caller();
        let from_str = panic_record(&"boom with password=hunter2", Some(here), Some("worker"));
        assert_eq!(from_str["level"], "error");
        assert_eq!(from_str["target"], PANIC);
        assert_eq!(from_str["msg"], "boom with password=[redacted]");
        assert_eq!(
            from_str["loc"],
            format!("{}:{}:{}", here.file(), here.line(), here.column())
        );
        assert_eq!(from_str["thread"], "worker");

        let from_string = panic_record(&String::from("index 7 out of range"), None, None);
        assert_eq!(from_string["msg"], "index 7 out of range");
        assert!(from_string.get("loc").is_none());
        assert_eq!(from_string["thread"], "<unnamed>");

        let opaque = panic_record(&7_u8, None, Some("main"));
        assert_eq!(opaque["msg"], "a panic whose payload is not a string");
    }

    #[test]
    fn dependencies_need_warn_and_ours_take_info() {
        let admitted = |target: &str, level: Level| {
            admits(&Metadata::builder().target(target).level(level).build())
        };
        assert_eq!(CRATE, "cerebro_lib");
        assert!(admitted(module_path!(), Level::Info));
        assert!(admitted("cerebro_lib", Level::Info));
        assert!(admitted("cerebro_lib::ingest::ambient", Level::Info));
        assert!(!admitted("cerebro_lib::ingest::ambient", Level::Debug));
        assert!(admitted(WEBVIEW, Level::Info));
        assert!(admitted(PANIC, Level::Info));
        assert!(!admitted("wry", Level::Info));
        assert!(admitted("wry", Level::Warn));
        assert!(admitted("tao::platform_impl", Level::Error));
        assert!(
            !admitted("cerebro_library::x", Level::Info),
            "a longer name is not this crate"
        );
    }
}
