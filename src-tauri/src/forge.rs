//! Read-only pull requests through the person's gh login (M69.11).
//! No token is read by Cerebro, no result reaches disk, and no agent tool calls
//! this reader. URL and outcome semantics replay the shared PR case files.
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    io::{self, Read},
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Condvar, LazyLock, Mutex, MutexGuard,
    },
    time::{Duration, Instant},
};

const FIELDS: &str = "number,url,title,state,isDraft,mergedAt,closedAt,headRefName,baseRefName,author,body,reviewDecision,mergeStateStatus,statusCheckRollup,updatedAt";
const OUTPUT_CAP: usize = 2 * 1024 * 1024;
const DEADLINE: Duration = Duration::from_secs(15);
const SUCCESS_TTL: Duration = Duration::from_secs(60);
const FAILURE_TTL: Duration = Duration::from_secs(10);
const CACHE_ENTRIES: usize = 64;
const CACHE_BYTES: usize = 16 * 1024 * 1024;
const CHECKS_CAP: usize = 10_000;
const INSTALL_PATHS: &[&str] = &[
    "/opt/homebrew/bin/gh",
    "/usr/local/bin/gh",
    "/opt/local/bin/gh",
    "/usr/bin/gh",
];

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct PullRequestUrl {
    pub owner: String,
    pub repo: String,
    pub number: u64,
    pub canonical: String,
    pub key: String,
}
pub fn parse_pull_request_url(input: &str) -> Option<PullRequestUrl> {
    static URL: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(
        r"^(?i-u:https://(?:www\.)?github\.com)/([A-Za-z0-9][A-Za-z0-9-]{0,38})/([A-Za-z0-9._-]{1,100})/pull/([1-9][0-9]{0,9})(?:/(?:files|commits|checks))?(?:[?#][^\s%\\]*)?$"
    ).expect("the fixed GitHub PR grammar compiles")
    });
    if input
        .chars()
        .any(|c| c.is_whitespace() || c.is_control() || matches!(c, '\u{feff}' | '%' | '\\'))
    {
        return None;
    }
    let captures = URL.captures(input)?;
    let owner = captures[1].to_owned();
    let repo = captures[2].to_owned();
    if repo == "." || repo == ".." {
        return None;
    }
    let number = captures[3].parse().ok()?;
    let canonical = format!("https://github.com/{owner}/{repo}/pull/{number}");
    Some(PullRequestUrl {
        owner,
        repo,
        number,
        key: canonical.to_ascii_lowercase(),
        canonical,
    })
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PrCheck {
    CheckRun {
        name: Option<String>,
        status: Option<String>,
        conclusion: Option<String>,
    },
    StatusContext {
        name: Option<String>,
        state: Option<String>,
    },
    Unknown,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PullRequest {
    pub number: u64,
    pub url: String,
    pub title: Option<String>,
    pub state: String,
    pub is_draft: Option<bool>,
    pub merged_at: Option<String>,
    pub closed_at: Option<String>,
    pub head_ref_name: Option<String>,
    pub base_ref_name: Option<String>,
    pub author: Option<String>,
    pub body: Option<String>,
    pub review_decision: Option<String>,
    pub merge_state_status: Option<String>,
    pub updated_at: Option<String>,
    pub checks: Option<Vec<PrCheck>>,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Failure {
    InvalidUrl,
    GhMissing,
    NotSignedIn,
    NotFound,
    Offline,
    RateLimited,
    GhOutdated,
    TimedOut,
    Unreadable,
    Failed,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum PrRead {
    Read {
        state: ReadState,
        #[serde(rename = "checkedAt")]
        checked_at: String,
        pr: Box<PullRequest>,
    },
    Failed {
        state: Failure,
        #[serde(rename = "checkedAt")]
        checked_at: String,
    },
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum ReadState {
    #[serde(rename = "read")]
    Read,
}
impl PrRead {
    fn failed(state: Failure, checked_at: String) -> Self {
        Self::Failed { state, checked_at }
    }
    fn ttl(&self) -> Duration {
        match self {
            Self::Read { .. } => SUCCESS_TTL,
            Self::Failed { .. } => FAILURE_TTL,
        }
    }
}
fn stamp() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
fn text(value: &Value, key: &str) -> Option<String> {
    value.get(key)?.as_str().map(str::to_owned)
}
fn parse_pr(stdout: &str) -> Option<PullRequest> {
    let raw: Value = serde_json::from_str(stdout).ok()?;
    let number = raw.get("number")?.as_u64()?;
    let url = parse_pull_request_url(raw.get("url")?.as_str()?)?;
    if number != url.number {
        return None;
    }
    let state = raw.get("state")?.as_str()?.to_owned();
    if raw
        .get("statusCheckRollup")
        .and_then(Value::as_array)
        .is_some_and(|items| items.len() > CHECKS_CAP)
    {
        return None;
    }
    let checks = raw
        .get("statusCheckRollup")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(
                    |item| match item.get("__typename").and_then(Value::as_str) {
                        Some("CheckRun") => PrCheck::CheckRun {
                            name: text(item, "name"),
                            status: text(item, "status"),
                            conclusion: text(item, "conclusion"),
                        },
                        Some("StatusContext") => PrCheck::StatusContext {
                            name: text(item, "context"),
                            state: text(item, "state"),
                        },
                        _ => PrCheck::Unknown,
                    },
                )
                .collect()
        });
    Some(PullRequest {
        number,
        url: url.canonical,
        state,
        checks,
        title: text(&raw, "title"),
        is_draft: raw.get("isDraft").and_then(Value::as_bool),
        merged_at: text(&raw, "mergedAt"),
        closed_at: text(&raw, "closedAt"),
        head_ref_name: text(&raw, "headRefName"),
        base_ref_name: text(&raw, "baseRefName"),
        author: raw.get("author").and_then(|author| text(author, "login")),
        body: text(&raw, "body"),
        review_decision: text(&raw, "reviewDecision"),
        merge_state_status: text(&raw, "mergeStateStatus"),
        updated_at: text(&raw, "updatedAt"),
    })
}
fn classify(stderr: &str) -> Failure {
    let lower = stderr.to_ascii_lowercase();
    if ["rate limit", "rate_limit", "secondary rate", "http 429"]
        .iter()
        .any(|word| lower.contains(word))
    {
        Failure::RateLimited
    } else if [
        "not logged",
        "not signed",
        "auth login",
        "authentication",
        "http 401",
        "bad credentials",
    ]
    .iter()
    .any(|word| lower.contains(word))
    {
        Failure::NotSignedIn
    } else if [
        "could not resolve to a pullrequest",
        "could not resolve to a repository",
        "not found",
        "http 404",
        "no pull requests found",
    ]
    .iter()
    .any(|word| lower.contains(word))
    {
        Failure::NotFound
    } else if [
        "unknown flag",
        "unknown json field",
        "unknown command",
        "unsupported field",
    ]
    .iter()
    .any(|word| lower.contains(word))
    {
        Failure::GhOutdated
    } else if [
        "error connecting",
        "network",
        "no such host",
        "connection refused",
        "connection reset",
        "dial tcp",
        "tls handshake",
        "i/o timeout",
    ]
    .iter()
    .any(|word| lower.contains(word))
    {
        Failure::Offline
    } else {
        Failure::Failed
    }
}
fn interpret(exit: i32, stdout: &str, stderr: &str, checked_at: String) -> PrRead {
    if exit != 0 {
        return PrRead::failed(classify(stderr), checked_at);
    }
    match parse_pr(stdout) {
        Some(pr) => PrRead::Read {
            state: ReadState::Read,
            checked_at,
            pr: Box::new(pr),
        },
        None => PrRead::failed(Failure::Unreadable, checked_at),
    }
}

// Contract: https://cli.github.com/manual/gh_pr_view and
// https://cli.github.com/manual/gh_help_environment (checked 2026-10-15).
fn gh_command(binary: &Path, url: &PullRequestUrl) -> Command {
    let mut command = crate::spawn::command(binary);
    command
        .args(["pr", "view", &url.canonical, "--json", FIELDS])
        .current_dir(std::env::temp_dir());
    for (key, value) in [
        ("GH_PROMPT_DISABLED", "1"),
        ("GH_NO_UPDATE_NOTIFIER", "1"),
        ("GH_SPINNER_DISABLED", "1"),
        ("NO_COLOR", "1"),
        ("CLICOLOR", "0"),
        ("GH_PAGER", ""),
        ("PAGER", ""),
        ("LC_ALL", "C"),
    ] {
        command.env(key, value);
    }
    for key in [
        "GH_REPO",
        "GH_HOST",
        "GH_FORCE_TTY",
        "CLICOLOR_FORCE",
        "GH_DEBUG",
        "DEBUG",
    ] {
        command.env_remove(key);
    }
    command
}
fn executable(path: &Path) -> bool {
    let Ok(meta) = path.metadata() else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}
fn find_gh() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = INSTALL_PATHS.iter().map(PathBuf::from).collect();
    if let Some(home) = std::env::var_os("HOME") {
        candidates.push(PathBuf::from(home).join(".local/bin/gh"));
    }
    find_gh_with(&candidates, || {
        let mut command = crate::spawn::command("/usr/bin/which");
        command.arg("gh").current_dir(std::env::temp_dir());
        let output = capture(&mut command, Duration::from_secs(2), 4096).ok()?;
        if output.exit != 0 {
            return None;
        }
        let path = PathBuf::from(output.stdout.trim());
        (path.is_absolute() && executable(&path)).then_some(path)
    })
}
fn find_gh_with(
    candidates: &[PathBuf],
    fallback: impl FnOnce() -> Option<PathBuf>,
) -> Option<PathBuf> {
    candidates
        .iter()
        .find(|path| executable(path))
        .cloned()
        .or_else(fallback)
}

struct Captured {
    exit: i32,
    stdout: String,
    stderr: String,
}
#[cfg(unix)]
fn nonblocking(stdout: &std::process::ChildStdout) -> io::Result<()> {
    use std::os::fd::AsRawFd;
    // SAFETY: stdout owns this live descriptor. Only its status flags change;
    // the private drain thread remains its sole reader until it closes.
    let flags = unsafe { libc::fcntl(stdout.as_raw_fd(), libc::F_GETFL) };
    if flags < 0 {
        return Err(io::Error::last_os_error());
    }
    let changed =
        unsafe { libc::fcntl(stdout.as_raw_fd(), libc::F_SETFL, flags | libc::O_NONBLOCK) };
    if changed < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}
#[cfg(not(unix))]
fn nonblocking(_stdout: &std::process::ChildStdout) -> io::Result<()> {
    Err(io::Error::other(
        "bounded PR reads require nonblocking pipes",
    ))
}
fn capture(command: &mut Command, limit: Duration, cap: usize) -> Result<Captured, Failure> {
    capture_started(command, limit, cap, |_| {})
}
fn capture_started(
    command: &mut Command,
    limit: Duration,
    cap: usize,
    started: impl FnOnce(u32),
) -> Result<Captured, Failure> {
    let (supervised, mut stdout) = crate::spawn::supervise(command).map_err(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            Failure::GhMissing
        } else {
            Failure::Failed
        }
    })?;
    let handle = supervised.handle();
    started(handle.id());
    if nonblocking(&stdout).is_err() {
        handle.terminate(Duration::ZERO);
        let _ = supervised.finish(Duration::ZERO);
        return Err(Failure::Failed);
    }
    let stopped = Arc::new(AtomicBool::new(false));
    let stop = stopped.clone();
    let (sent, received) = mpsc::sync_channel(1);
    let drain = std::thread::Builder::new()
        .name("cerebro-pr-stdout".into())
        .spawn(move || {
            let mut bytes = Vec::new();
            let mut chunk = [0u8; 8192];
            let result = loop {
                if stop.load(Ordering::Acquire) {
                    break Err(Failure::TimedOut);
                }
                match stdout.read(&mut chunk) {
                    Ok(0) => break String::from_utf8(bytes).map_err(|_| Failure::Unreadable),
                    Ok(n) if bytes.len().saturating_add(n) > cap => break Err(Failure::Unreadable),
                    Ok(n) => bytes.extend_from_slice(&chunk[..n]),
                    Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(10))
                    }
                    Err(_) => break Err(Failure::Unreadable),
                }
            };
            let _ = sent.send(result);
        });
    let Ok(drain) = drain else {
        handle.terminate(Duration::ZERO);
        let _ = supervised.finish(Duration::ZERO);
        return Err(Failure::Failed);
    };
    let deadline = Instant::now() + limit;
    let mut output = None;
    let failure = loop {
        if output.is_none() {
            match received.try_recv() {
                Ok(Ok(value)) => output = Some(value),
                Ok(Err(failure)) => break Some(failure),
                Err(mpsc::TryRecvError::Disconnected) => break Some(Failure::Unreadable),
                Err(mpsc::TryRecvError::Empty) => {}
            }
        }
        if output.is_some() && !handle.alive() {
            break None;
        }
        if Instant::now() >= deadline {
            break Some(Failure::TimedOut);
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    if failure.is_some() {
        handle.terminate(Duration::from_secs(1));
    }
    stopped.store(true, Ordering::Release);
    let _ = drain.join();
    let (status, tail) = supervised.finish(Duration::from_millis(200));
    if let Some(failure) = failure {
        return Err(failure);
    }
    Ok(Captured {
        exit: status.and_then(|status| status.code()).unwrap_or(-1),
        stdout: output.unwrap_or_default(),
        stderr: tail.text(),
    })
}
fn read_using(url: &PullRequestUrl, binary: Option<PathBuf>, limit: Duration) -> PrRead {
    let Some(binary) = binary else {
        return PrRead::failed(Failure::GhMissing, stamp());
    };
    let output = capture(&mut gh_command(&binary, url), limit, OUTPUT_CAP);
    let read = match output {
        Ok(output) => interpret(output.exit, &output.stdout, &output.stderr, stamp()),
        Err(failure) => PrRead::failed(failure, stamp()),
    };
    // A CLI or unexpected redirect must not attribute a different PR's state
    // to the link the person opened. Case differences are the same identity.
    if let PrRead::Read { pr, .. } = &read {
        if parse_pull_request_url(&pr.url).is_none_or(|found| found.key != url.key) {
            return PrRead::failed(Failure::Unreadable, stamp());
        }
    }
    read
}

struct Cached {
    read: PrRead,
    at: Instant,
    bytes: usize,
}
#[derive(Default)]
struct Book {
    cache: HashMap<String, Cached>,
    pending: HashSet<String>,
    active: usize,
}
#[derive(Default)]
pub struct PrReader {
    book: Mutex<Book>,
    changed: Condvar,
}
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|error| error.into_inner())
}
impl PrReader {
    pub fn read(&self, url: &str, refresh: bool) -> PrRead {
        self.read_with(url, refresh, |url| read_using(url, find_gh(), DEADLINE))
    }
    fn read_with(
        &self,
        input: &str,
        mut refresh: bool,
        read: impl FnOnce(&PullRequestUrl) -> PrRead,
    ) -> PrRead {
        let Some(url) = parse_pull_request_url(input) else {
            return PrRead::failed(Failure::InvalidUrl, stamp());
        };
        let mut book = lock(&self.book);
        loop {
            book.cache
                .retain(|_, value| value.at.elapsed() < value.read.ttl());
            if book.pending.contains(&url.key) {
                book = self
                    .changed
                    .wait(book)
                    .unwrap_or_else(|error| error.into_inner());
                // A concurrent Refresh joins the current read, it does not
                // start another child as soon as the first one finishes.
                refresh = false;
                continue;
            }
            if !refresh {
                if let Some(cached) = book.cache.get(&url.key) {
                    return cached.read.clone();
                }
            }
            book.pending.insert(url.key.clone());
            break;
        }
        while book.active >= 2 {
            book = self
                .changed
                .wait(book)
                .unwrap_or_else(|error| error.into_inner());
        }
        book.active += 1;
        drop(book);
        struct Slot<'a> {
            reader: &'a PrReader,
            key: String,
        }
        impl Drop for Slot<'_> {
            fn drop(&mut self) {
                let mut book = lock(&self.reader.book);
                book.active -= 1;
                book.pending.remove(&self.key);
                self.reader.changed.notify_all();
            }
        }
        let _slot = Slot {
            reader: self,
            key: url.key.clone(),
        };
        let result = read(&url);
        // Normalized unknown checks can be larger than their input spelling.
        // Bound retained results by both count and serialized byte weight.
        let bytes = serde_json::to_vec(&result).map_or(CACHE_BYTES + 1, |value| value.len());
        let mut book = lock(&self.book);
        while book.cache.len() >= CACHE_ENTRIES
            || book
                .cache
                .values()
                .map(|value| value.bytes)
                .sum::<usize>()
                .saturating_add(bytes)
                > CACHE_BYTES
        {
            if let Some(oldest) = book
                .cache
                .iter()
                .min_by_key(|(_, value)| value.at)
                .map(|(key, _)| key.clone())
            {
                book.cache.remove(&oldest);
            } else {
                break;
            }
        }
        if bytes <= CACHE_BYTES {
            book.cache.insert(
                url.key,
                Cached {
                    read: result.clone(),
                    at: Instant::now(),
                    bytes,
                },
            );
        }
        drop(book);
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, sync::atomic::AtomicUsize};

    const URL: &str = "https://github.com/acme/notes/pull/42";
    const JSON: &str = r#"{"number":42,"url":"https://github.com/acme/notes/pull/42","state":"OPEN","isDraft":false,"statusCheckRollup":[]}"#;
    const TIME: &str = "2026-10-15T12:00:00Z";
    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            Self(crate::vault::testutil::temp_vault("forge"))
        }
        #[cfg(unix)]
        fn script(&self, name: &str, body: &str) -> PathBuf {
            use std::os::unix::fs::PermissionsExt;
            let path = self.0.join(name);
            fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
            path
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn read() -> PrRead {
        interpret(0, JSON, "", TIME.into())
    }
    fn failed() -> PrRead {
        PrRead::failed(Failure::Offline, TIME.into())
    }

    #[test]
    fn replays_pr_urls() {
        let cases: Value = serde_json::from_str(include_str!("../fixtures/pr-urls.json")).unwrap();
        for case in cases["cases"].as_array().unwrap() {
            let actual = parse_pull_request_url(case["input"].as_str().unwrap());
            assert_eq!(
                serde_json::to_value(actual).unwrap(),
                case["expect"],
                "{}",
                case["name"]
            );
        }
    }
    #[test]
    fn replays_pr_cases() {
        let cases: Value = serde_json::from_str(include_str!("../fixtures/pr-cases.json")).unwrap();
        for case in cases["cases"].as_array().unwrap() {
            let input = &case["input"];
            let checked_at = cases["checkedAt"].as_str().unwrap().to_owned();
            let actual = if let Some(failure) = input.get("failure") {
                PrRead::failed(serde_json::from_value(failure.clone()).unwrap(), checked_at)
            } else {
                interpret(
                    input["exit"].as_i64().unwrap() as i32,
                    input["stdout"].as_str().unwrap(),
                    input["stderr"].as_str().unwrap(),
                    checked_at,
                )
            };
            assert_eq!(
                serde_json::to_value(actual).unwrap(),
                case["expect"],
                "{}",
                case["name"]
            );
        }
    }
    #[test]
    fn the_gh_argv_is_one_read() {
        let url = parse_pull_request_url(
            "https://www.github.com/Acme/Notes/pull/42/files?ignored=yes#diff",
        )
        .unwrap();
        let command = gh_command(Path::new("/fake/gh"), &url);
        let args: Vec<_> = command
            .get_args()
            .map(|arg| arg.to_str().unwrap())
            .collect();
        assert_eq!(
            args,
            [
                "pr",
                "view",
                "https://github.com/Acme/Notes/pull/42",
                "--json",
                FIELDS
            ]
        );
        assert_eq!(
            command.get_current_dir(),
            Some(std::env::temp_dir().as_path())
        );
    }
    #[test]
    fn a_url_with_credentials_never_reaches_argv() {
        let reader = PrReader::default();
        let result = reader.read_with(
            "https://someone:secret@github.com/acme/notes/pull/42",
            false,
            |_| panic!("invalid URL reached the child"),
        );
        assert!(matches!(
            result,
            PrRead::Failed {
                state: Failure::InvalidUrl,
                ..
            }
        ));
        assert!(lock(&reader.book).pending.is_empty());
    }
    #[test]
    fn the_child_cannot_prompt_page_or_colour() {
        let command = gh_command(Path::new("/fake/gh"), &parse_pull_request_url(URL).unwrap());
        let envs: HashMap<_, _> = command.get_envs().collect();
        for (name, value) in [
            ("GH_PROMPT_DISABLED", "1"),
            ("GH_NO_UPDATE_NOTIFIER", "1"),
            ("GH_SPINNER_DISABLED", "1"),
            ("NO_COLOR", "1"),
            ("CLICOLOR", "0"),
            ("GH_PAGER", ""),
            ("PAGER", ""),
        ] {
            assert_eq!(
                envs.get(std::ffi::OsStr::new(name)),
                Some(&Some(std::ffi::OsStr::new(value)))
            );
        }
        for name in ["GH_REPO", "GH_HOST", "GH_FORCE_TTY", "CLICOLOR_FORCE"] {
            assert_eq!(envs.get(std::ffi::OsStr::new(name)), Some(&None));
        }
        for name in crate::spawn::REPO_SELECTING_VARS {
            assert_eq!(envs.get(std::ffi::OsStr::new(name)), Some(&None));
        }
    }
    #[test]
    #[cfg(unix)]
    fn gh_is_looked_for_where_installers_put_it() {
        assert!(INSTALL_PATHS.contains(&"/opt/homebrew/bin/gh"));
        assert!(INSTALL_PATHS.contains(&"/usr/local/bin/gh"));
        let temp = Temp::new();
        let executable = temp.script("gh", "exit 0");
        let candidates = [temp.0.join("missing"), executable.clone()];
        assert_eq!(
            find_gh_with(&candidates, || panic!("installed gh should win")),
            Some(executable)
        );
        assert_eq!(
            find_gh_with(&[], || Some(PathBuf::from("/fake/path/gh"))),
            Some(PathBuf::from("/fake/path/gh"))
        );
    }
    #[test]
    fn a_missing_gh_reads_gh_missing() {
        assert!(matches!(
            read_using(&parse_pull_request_url(URL).unwrap(), None, DEADLINE),
            PrRead::Failed {
                state: Failure::GhMissing,
                ..
            }
        ));
    }
    #[test]
    #[cfg(unix)]
    fn a_fake_gh_is_read_end_to_end() {
        let temp = Temp::new();
        let script = temp.script("gh", &format!("[ \"$1\" = pr ] && [ \"$2\" = view ] && [ \"$3\" = '{URL}' ] && [ \"$4\" = --json ] || exit 9\nprintf '%s' '{JSON}'"));
        let result = read_using(
            &parse_pull_request_url(URL).unwrap(),
            Some(script),
            DEADLINE,
        );
        assert!(
            matches!(result, PrRead::Read { pr, .. } if pr.number == 42 && pr.checks == Some(vec![]))
        );
    }
    #[test]
    #[cfg(unix)]
    fn a_slow_gh_is_ended_and_reads_timed_out() {
        let temp = Temp::new();
        let script = temp.script("gh", "sleep 30");
        let child = std::cell::Cell::new(None);
        let started = Instant::now();
        let result = capture_started(
            &mut gh_command(&script, &parse_pull_request_url(URL).unwrap()),
            Duration::from_millis(300),
            OUTPUT_CAP,
            |pid| child.set(Some(pid)),
        );
        assert!(matches!(result, Err(Failure::TimedOut)));
        assert!(started.elapsed() < Duration::from_secs(3));
        // Observe the spawned PID, rather than depending on the child's first
        // instruction running before the deliberately short 300 ms deadline.
        let pid = i32::try_from(child.get().unwrap()).unwrap();
        // SAFETY: signal zero only asks whether the toy child exists; it sends
        // no signal and cannot alter another process.
        assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
        assert_eq!(io::Error::last_os_error().raw_os_error(), Some(libc::ESRCH));
    }
    #[test]
    #[cfg(unix)]
    fn excessive_stdout_is_unreadable_and_the_writer_is_ended() {
        let temp = Temp::new();
        let script = temp.script("gh", "while :; do printf 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'; done");
        let started = Instant::now();
        let mut command = gh_command(&script, &parse_pull_request_url(URL).unwrap());
        assert!(matches!(
            capture(&mut command, Duration::from_secs(2), 1024),
            Err(Failure::Unreadable)
        ));
        assert!(started.elapsed() < Duration::from_secs(3));
    }
    #[test]
    #[cfg(unix)]
    fn a_descendant_holding_stdout_does_not_outlive_the_timeout() {
        let temp = Temp::new();
        let script = temp.script(
            "gh",
            "sleep 30 &\nprintf '%s' \"$!\" > \"$0.child\"\nexit 0",
        );
        let started = Instant::now();
        let pid_file = script.with_extension("child");
        let result = capture_started(
            &mut gh_command(&script, &parse_pull_request_url(URL).unwrap()),
            Duration::from_millis(300),
            OUTPUT_CAP,
            |_| {
                // Start this short deadline after the test descendant exists.
                // Never panic here: capture must still end/reap the leader if
                // the OS does not schedule the fixture within this setup bound.
                let until = Instant::now() + Duration::from_secs(2);
                while !pid_file.exists() && Instant::now() < until {
                    std::thread::sleep(Duration::from_millis(10));
                }
            },
        );
        assert!(matches!(result, Err(Failure::TimedOut)));
        assert!(started.elapsed() < Duration::from_secs(3));
        let pid = fs::read_to_string(pid_file).unwrap();
        let status = crate::spawn::command("/bin/ps")
            .args(["-p", &pid, "-o", "stat="])
            .output()
            .unwrap();
        let state = String::from_utf8_lossy(&status.stdout);
        // A reparented child can briefly remain as a zombie before init reaps
        // it. Neither that nor absence is a running process holding a pipe.
        assert!(
            state.trim().is_empty() || state.trim().starts_with('Z'),
            "descendant state: {state}"
        );
    }
    #[test]
    #[cfg(unix)]
    fn a_different_pr_in_cli_output_is_never_published_under_the_requested_link() {
        let temp = Temp::new();
        let other = JSON.replace("42", "43");
        let script = temp.script("gh", &format!("printf '%s' '{other}'"));
        assert!(matches!(
            read_using(
                &parse_pull_request_url(URL).unwrap(),
                Some(script),
                DEADLINE
            ),
            PrRead::Failed {
                state: Failure::Unreadable,
                ..
            }
        ));
    }
    #[test]
    fn cache_and_refresh_reuse_the_canonical_key() {
        let reader = PrReader::default();
        let calls = AtomicUsize::new(0);
        let fetch = |_: &PullRequestUrl| {
            calls.fetch_add(1, Ordering::SeqCst);
            read()
        };
        reader.read_with(URL, false, fetch);
        reader.read_with(
            "https://www.github.com/ACME/NOTES/pull/42/checks",
            false,
            fetch,
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        reader.read_with(URL, true, fetch);
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        lock(&reader.book).cache.get_mut(URL).unwrap().at = Instant::now() - SUCCESS_TTL;
        reader.read_with(URL, false, fetch);
        assert_eq!(calls.load(Ordering::SeqCst), 3);
    }
    #[test]
    fn failures_expire_after_ten_seconds() {
        let reader = PrReader::default();
        reader.read_with(URL, false, |_| failed());
        assert_eq!(
            reader.read_with(URL, false, |_| panic!("failure cache missed")),
            failed()
        );
        lock(&reader.book).cache.get_mut(URL).unwrap().at = Instant::now() - FAILURE_TTL;
        assert_eq!(reader.read_with(URL, false, |_| read()), read());
    }
    #[test]
    fn concurrent_refreshes_share_one_read() {
        let reader = PrReader::default();
        let calls = AtomicUsize::new(0);
        let barrier = std::sync::Barrier::new(9);
        std::thread::scope(|scope| {
            for _ in 0..8 {
                scope.spawn(|| {
                    barrier.wait();
                    reader.read_with(URL, true, |_| {
                        calls.fetch_add(1, Ordering::SeqCst);
                        std::thread::sleep(Duration::from_millis(100));
                        read()
                    })
                });
            }
            barrier.wait();
        });
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
    #[test]
    fn at_most_two_reads_are_active_across_distinct_urls() {
        let reader = PrReader::default();
        let active = AtomicUsize::new(0);
        let maximum = AtomicUsize::new(0);
        std::thread::scope(|scope| {
            for id in 1..9 {
                let url = format!("https://github.com/acme/notes/pull/{id}");
                let (reader, active, maximum) = (&reader, &active, &maximum);
                scope.spawn(move || {
                    reader.read_with(&url, false, |_| {
                        let count = active.fetch_add(1, Ordering::SeqCst) + 1;
                        maximum.fetch_max(count, Ordering::SeqCst);
                        std::thread::sleep(Duration::from_millis(25));
                        active.fetch_sub(1, Ordering::SeqCst);
                        failed()
                    })
                });
            }
        });
        assert_eq!(maximum.load(Ordering::SeqCst), 2);
        assert_eq!(lock(&reader.book).active, 0);
        assert!(lock(&reader.book).pending.is_empty());
    }
    #[test]
    fn an_unbounded_sequence_of_links_cannot_grow_the_cache() {
        let reader = PrReader::default();
        for id in 1..100 {
            reader.read_with(
                &format!("https://github.com/acme/notes/pull/{id}"),
                false,
                |_| failed(),
            );
        }
        assert_eq!(lock(&reader.book).cache.len(), CACHE_ENTRIES);
    }
    #[test]
    fn many_empty_checks_do_not_amplify_a_small_input_into_an_unbounded_result() {
        let mut raw: Value = serde_json::from_str(JSON).unwrap();
        raw["statusCheckRollup"] = Value::Array(vec![Value::Null; CHECKS_CAP + 1]);
        assert!(matches!(
            interpret(0, &raw.to_string(), "", TIME.into()),
            PrRead::Failed {
                state: Failure::Unreadable,
                ..
            }
        ));
    }
    #[test]
    fn large_bodies_obey_the_cache_byte_budget() {
        let reader = PrReader::default();
        let mut value = read();
        if let PrRead::Read { pr, .. } = &mut value {
            pr.body = Some("a".repeat(1024 * 1024));
        }
        for id in 1..20 {
            reader.read_with(
                &format!("https://github.com/acme/notes/pull/{id}"),
                false,
                |_| value.clone(),
            );
        }
        let book = lock(&reader.book);
        assert!(book.cache.len() < 16);
        assert!(book.cache.values().map(|value| value.bytes).sum::<usize>() <= CACHE_BYTES);
    }
}
