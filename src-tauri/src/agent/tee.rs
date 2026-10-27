//! The debug-only recorder (M56.2): a real Cerebro run, as Claude Code wrote
//! it, kept for the recording kit to sanitize into a fixture.
//!
//! A debug build started with the record-folder variable set (the one
//! `recording` reads, named once in this file's code) records every run that
//! goes through `agent::stream`. The run's child gets its own
//! `CLAUDE_CONFIG_DIR`, `<folder>/claude-config`, signed in once by the owner,
//! so the owner's own settings, hooks and sessions stay out of the recording
//! and the recording stays out of `~/.claude`. Under `<folder>/runs/`, each
//! run leaves three owner-only files named `<utc stamp>-<run>`, and a seated
//! run a fourth:
//!
//! - `.stream.jsonl`: stdout's bytes exactly as they were read;
//! - `.argv.json`: the argument vector, which names the MCP config's path and
//!   never its contents, where the bearer lives;
//! - `.end.json`: how the run ended (exit code or signal, cancelled, aborted,
//!   whether a result arrived, and the last characters of stderr);
//! - `.stdin.jsonl`: every line a seated run's stdin was sent (M92.13,
//!   `turn_input`), its prompt and its context ask, as they were written.
//!
//! The child never sees an API key or token (`CREDENTIALS`): a recording is
//! the owner's own login or nothing.
//!
//! In a release build `Recording` is an empty enum and `recording` returns
//! None, so the compiler proves the whole path dead and the variable is never
//! read. A recording never fails a run: an IO error turns it off for that run
//! with one warning. Raw files stay in the record folder; only
//! `scripts/cli-record/sanitize.ts` brings a run into the repo.

use std::fs::File;
use std::io::{Read, Write};
use std::path::Path;
#[cfg(debug_assertions)]
use std::path::PathBuf;
use std::process::ExitStatus;

use crate::spawn::StderrTail;

/// Where the record folder keeps the isolated Claude Code config.
#[cfg(debug_assertions)]
const CONFIG_DIR: &str = "claude-config";
/// Where the record folder keeps the runs.
#[cfg(debug_assertions)]
const RUNS_DIR: &str = "runs";
/// The credentials a recorded run's child never sees, so the CLI signs in
/// from the record folder's config and the recording names no API-key source.
pub(crate) const CREDENTIALS: [&str; 3] = [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
];
/// How much of stderr's end the end file keeps, in characters.
#[cfg(debug_assertions)]
const END_TAIL_CHARS: usize = 2000;

/// One run being recorded: its files and the config its child runs under.
#[cfg(debug_assertions)]
pub(crate) struct Recording {
    run: u64,
    config_dir: PathBuf,
    /// The stream file, until `tee` hands it to the reader.
    stream: Option<File>,
    end: PathBuf,
    /// Where a seated run's stdin is copied, made only when it is asked for
    /// (`stdin_copy`).
    stdin: PathBuf,
}

/// A release build records nothing: no value of this type can exist.
#[cfg(not(debug_assertions))]
pub(crate) enum Recording {}

/// The recording for run `run`, when this debug build was started with a
/// record folder; None otherwise, and always None in a release build.
#[cfg(debug_assertions)]
pub(crate) fn recording(run: u64, args: &[String]) -> Option<Recording> {
    let dir = std::env::var_os("CEREBRO_RECORD_DIR").filter(|dir| !dir.is_empty())?;
    recording_at(Path::new(&dir), run, args, chrono::Utc::now())
}

#[cfg(not(debug_assertions))]
pub(crate) fn recording(_run: u64, _args: &[String]) -> Option<Recording> {
    None
}

/// The recording for run `run` under the record folder `dir`, stamped `now`.
/// Writes the argv file and opens the stream file; None, with one warning,
/// when either cannot be made.
#[cfg(debug_assertions)]
pub(crate) fn recording_at(
    dir: &Path,
    run: u64,
    args: &[String],
    now: chrono::DateTime<chrono::Utc>,
) -> Option<Recording> {
    let runs = dir.join(RUNS_DIR);
    let base = format!("{}-{run}", now.format("%Y%m%dT%H%M%S%.3fZ"));
    let made = (|| -> std::io::Result<Recording> {
        owner_dir(&runs)?;
        let argv = serde_json::to_vec_pretty(args)?;
        owner_file(&runs.join(format!("{base}.argv.json")))?.write_all(&argv)?;
        let stream = owner_file(&runs.join(format!("{base}.stream.jsonl")))?;
        Ok(Recording {
            run,
            config_dir: dir.join(CONFIG_DIR),
            stream: Some(stream),
            end: runs.join(format!("{base}.end.json")),
            stdin: runs.join(format!("{base}.stdin.jsonl")),
        })
    })();
    match made {
        Ok(recording) => Some(recording),
        Err(error) => {
            log::warn!("agent run {run}: not recorded, the record folder refused it: {error}");
            None
        }
    }
}

#[cfg(debug_assertions)]
impl Recording {
    /// The isolated Claude Code config the run's child is given.
    pub(crate) fn config_dir(&self) -> &Path {
        &self.config_dir
    }

    /// `inner`, with every byte read from it copied to the stream file.
    pub(crate) fn tee<R: Read>(&mut self, inner: R) -> Tee<R> {
        Tee {
            inner,
            sink: self.stream.take(),
            run: self.run,
        }
    }

    /// The file a seated run's stdin is copied to (M92.13), made now: the
    /// turn input writes it each line it sends the run. None, with one
    /// warning, when it cannot be made; the run goes on unrecorded there.
    pub(crate) fn stdin_copy(&self) -> Option<File> {
        match owner_file(&self.stdin) {
            Ok(file) => Some(file),
            Err(error) => {
                log::warn!(
                    "agent run {}: its stdin is not recorded, the record folder refused it: {error}",
                    self.run
                );
                None
            }
        }
    }

    /// Write the end file: how the run ended. A failed write is one warning.
    pub(crate) fn finish(
        self,
        status: Option<ExitStatus>,
        stderr: &StderrTail,
        cancelled: bool,
        aborted: bool,
        saw_result: bool,
    ) {
        #[cfg(unix)]
        let signal = {
            use std::os::unix::process::ExitStatusExt;
            status.and_then(|status| status.signal())
        };
        #[cfg(not(unix))]
        let signal: Option<i32> = None;
        let end = serde_json::json!({
            "exit_code": status.and_then(|status| status.code()),
            "signal": signal,
            "cancelled": cancelled,
            "aborted": aborted,
            "result": saw_result,
            "stderr_tail": stderr.last_chars(END_TAIL_CHARS),
        });
        let written = serde_json::to_vec_pretty(&end)
            .map_err(std::io::Error::from)
            .and_then(|bytes| owner_file(&self.end)?.write_all(&bytes));
        if let Err(error) = written {
            log::warn!(
                "agent run {}: its recording's end was not written: {error}",
                self.run
            );
        }
    }
}

#[cfg(not(debug_assertions))]
impl Recording {
    pub(crate) fn config_dir(&self) -> &Path {
        match *self {}
    }

    pub(crate) fn tee<R: Read>(&mut self, _inner: R) -> Tee<R> {
        match *self {}
    }

    pub(crate) fn stdin_copy(&self) -> Option<File> {
        match *self {}
    }

    pub(crate) fn finish(
        self,
        _status: Option<ExitStatus>,
        _stderr: &StderrTail,
        _cancelled: bool,
        _aborted: bool,
        _saw_result: bool,
    ) {
        match self {}
    }
}

/// A reader that copies every byte it hands on to its sink, until the sink
/// fails; then it warns once and hands bytes on alone.
pub(crate) struct Tee<R> {
    inner: R,
    sink: Option<File>,
    run: u64,
}

impl<R: Read> Tee<R> {
    /// `inner` with nothing recorded.
    pub(crate) fn plain(inner: R) -> Self {
        Self {
            inner,
            sink: None,
            run: 0,
        }
    }
}

impl<R: Read> Read for Tee<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let read = self.inner.read(buf)?;
        if read > 0 {
            if let Some(sink) = self.sink.as_mut() {
                if let Err(error) = sink.write_all(&buf[..read]) {
                    log::warn!(
                        "agent run {}: its recording stopped, the stream file refused a write: {error}",
                        self.run
                    );
                    self.sink = None;
                }
            }
        }
        Ok(read)
    }
}

/// A folder only its owner can enter, made with its parents.
#[cfg(debug_assertions)]
fn owner_dir(path: &Path) -> std::io::Result<()> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
        builder.mode(0o700);
        builder.create(path)?;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
    }
    #[cfg(not(unix))]
    builder.create(path)
}

/// A new file only its owner can read or write.
#[cfg(debug_assertions)]
fn owner_file(path: &Path) -> std::io::Result<File> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

#[cfg(all(test, debug_assertions))]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn now() -> chrono::DateTime<chrono::Utc> {
        chrono::Utc
            .with_ymd_and_hms(2026, 1, 2, 3, 4, 5)
            .single()
            .unwrap()
    }

    /// A run's argv in `build_args`' shape: the message last, after `--`
    /// (M92.0).
    fn args() -> Vec<String> {
        [
            "-p",
            "--mcp-config",
            "/app/mcp-config-7.json",
            "--",
            "hello",
        ]
        .map(String::from)
        .to_vec()
    }

    fn files(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir.join(RUNS_DIR))
            .map(|entries| {
                entries
                    .filter_map(Result::ok)
                    .map(|entry| entry.file_name().to_string_lossy().into_owned())
                    .collect()
            })
            .unwrap_or_default();
        names.sort();
        names
    }

    #[test]
    fn a_tee_copies_every_byte_and_hands_it_on() {
        let dir = crate::vault::testutil::temp_vault("tee-copies");
        let mut recording = recording_at(&dir, 7, &args(), now()).expect("a recording");
        // Not UTF-8 and no trailing newline: the tee keeps bytes, not lines.
        let raw: Vec<u8> = b"{\"type\":\"system\"}\n\xff\xfe half a line".to_vec();
        let mut handed = Vec::new();
        recording
            .tee(std::io::Cursor::new(raw.clone()))
            .read_to_end(&mut handed)
            .unwrap();
        assert_eq!(handed, raw, "the reader gets every byte");
        let stream = dir
            .join(RUNS_DIR)
            .join("20260102T030405.000Z-7.stream.jsonl");
        assert_eq!(std::fs::read(stream).unwrap(), raw, "and so does the file");
        let argv: Vec<String> = serde_json::from_slice(
            &std::fs::read(dir.join(RUNS_DIR).join("20260102T030405.000Z-7.argv.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(argv, args(), "the argv, which names the config's path only");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_tee_that_cannot_open_its_file_records_nothing_and_the_read_goes_on() {
        let dir = crate::vault::testutil::temp_vault("tee-refused");
        // The record folder's runs/ is a file, so nothing can be made in it.
        std::fs::write(dir.join(RUNS_DIR), b"not a folder").unwrap();
        assert!(recording_at(&dir, 1, &args(), now()).is_none());

        // A sink that refuses its first write: the tee warns, drops it, and
        // the reader still gets every byte.
        let read_only = dir.join("read-only");
        std::fs::write(&read_only, b"").unwrap();
        let mut tee = Tee {
            inner: std::io::Cursor::new(b"line one\nline two\n".to_vec()),
            sink: Some(File::open(&read_only).unwrap()),
            run: 1,
        };
        let mut handed = Vec::new();
        tee.read_to_end(&mut handed).unwrap();
        assert_eq!(handed, b"line one\nline two\n");
        assert!(tee.sink.is_none(), "the recording is off for the run");
        assert_eq!(std::fs::read(&read_only).unwrap(), b"");

        let mut plain = Tee::plain(std::io::Cursor::new(b"x".to_vec()));
        let mut out = Vec::new();
        plain.read_to_end(&mut out).unwrap();
        assert_eq!(out, b"x");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn the_end_file_says_how_the_run_ended() {
        use std::os::unix::process::ExitStatusExt;
        let dir = crate::vault::testutil::temp_vault("tee-end");
        let end_of = |run: u64, status: ExitStatus, cancelled: bool, result: bool| {
            let recording = recording_at(&dir, run, &args(), now()).unwrap();
            let mut tail = StderrTail::default();
            tail.push("warning: one\n".repeat(400).as_bytes());
            tail.push(b"fatal: the last line\n");
            recording.finish(Some(status), &tail, cancelled, false, result);
            let path = dir
                .join(RUNS_DIR)
                .join(format!("20260102T030405.000Z-{run}.end.json"));
            serde_json::from_slice::<serde_json::Value>(&std::fs::read(path).unwrap()).unwrap()
        };

        let exited = end_of(1, ExitStatus::from_raw(3 << 8), false, false);
        assert_eq!(exited["exit_code"], 3);
        assert_eq!(exited["signal"], serde_json::Value::Null);
        assert_eq!(exited["cancelled"], false);
        assert_eq!(exited["aborted"], false);
        assert_eq!(exited["result"], false);
        let tail = exited["stderr_tail"].as_str().unwrap();
        assert!(tail.ends_with("fatal: the last line"), "{tail}");
        assert_eq!(tail.chars().count(), END_TAIL_CHARS);

        let stopped = end_of(2, ExitStatus::from_raw(15), true, true);
        assert_eq!(stopped["exit_code"], serde_json::Value::Null);
        assert_eq!(stopped["signal"], 15);
        assert_eq!(stopped["cancelled"], true);
        assert_eq!(stopped["result"], true);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn recorded_files_are_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = crate::vault::testutil::temp_vault("tee-owner");
        let recording = recording_at(&dir, 4, &args(), now()).unwrap();
        recording.finish(None, &StderrTail::default(), false, false, true);
        let mode = |path: &Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&dir.join(RUNS_DIR)), 0o700);
        let names = files(&dir);
        assert_eq!(
            names,
            [
                "20260102T030405.000Z-4.argv.json",
                "20260102T030405.000Z-4.end.json",
                "20260102T030405.000Z-4.stream.jsonl",
            ]
        );
        for name in names {
            assert_eq!(mode(&dir.join(RUNS_DIR).join(&name)), 0o600, "{name}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A seated run's argv in `build_args`' shape (M92.13): stream-json
    /// input, and no message, which rides stdin.
    fn seated_args() -> Vec<String> {
        [
            "-p",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--mcp-config",
            "/app/mcp-config-8.json",
        ]
        .map(String::from)
        .to_vec()
    }

    #[cfg(unix)]
    #[test]
    fn a_seated_run_records_what_its_stdin_was_sent_beside_the_rest() {
        use std::os::unix::fs::PermissionsExt;
        let dir = crate::vault::testutil::temp_vault("tee-stdin");
        let recording = recording_at(&dir, 8, &seated_args(), now()).unwrap();
        let lines = "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"hello\"}}\n";
        recording
            .stdin_copy()
            .expect("the stdin file")
            .write_all(lines.as_bytes())
            .unwrap();
        recording.finish(None, &StderrTail::default(), false, false, true);
        let names = files(&dir);
        assert_eq!(
            names,
            [
                "20260102T030405.000Z-8.argv.json",
                "20260102T030405.000Z-8.end.json",
                "20260102T030405.000Z-8.stdin.jsonl",
                "20260102T030405.000Z-8.stream.jsonl",
            ]
        );
        let stdin = dir
            .join(RUNS_DIR)
            .join("20260102T030405.000Z-8.stdin.jsonl");
        assert_eq!(std::fs::read_to_string(&stdin).unwrap(), lines);
        assert_eq!(
            std::fs::metadata(&stdin).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let argv: Vec<String> = serde_json::from_slice(
            &std::fs::read(dir.join(RUNS_DIR).join("20260102T030405.000Z-8.argv.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(argv, seated_args(), "no message rides its argv");
        // Made once: a second copy would write over the first's lines.
        let again = recording_at(&dir, 9, &seated_args(), now()).unwrap();
        assert!(again.stdin_copy().is_some());
        assert!(again.stdin_copy().is_none(), "the file is new or nothing");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_config_dir_sits_in_the_record_dir() {
        let dir = crate::vault::testutil::temp_vault("tee-config");
        let recording = recording_at(&dir, 5, &args(), now()).unwrap();
        assert_eq!(recording.config_dir(), dir.join("claude-config"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The variable is read once, by an item a release build compiles out.
    #[test]
    fn the_record_dir_is_read_only_in_debug_builds() {
        const VAR: &str = concat!("CEREBRO_", "RECORD_DIR");
        let source = include_str!("tee.rs");
        let code = source
            .split("\nmod tests {")
            .next()
            .expect("the file has a code half");
        let lines: Vec<&str> = code.lines().collect();
        let uses: Vec<usize> = lines
            .iter()
            .enumerate()
            .filter(|(_, line)| !line.trim_start().starts_with("//") && line.contains(VAR))
            .map(|(at, _)| at)
            .collect();
        assert_eq!(uses.len(), 1, "named once in code: {uses:?}");
        let item = (0..uses[0])
            .rev()
            .find(|&at| lines[at].starts_with("pub(crate) fn ") || lines[at].starts_with("fn "))
            .expect("inside a function");
        let attributes: Vec<&str> = lines[..item]
            .iter()
            .rev()
            .take_while(|line| line.starts_with("#[") || line.starts_with("///"))
            .copied()
            .collect();
        assert!(
            attributes.contains(&"#[cfg(debug_assertions)]"),
            "{} must be a debug-only item: {attributes:?}",
            lines[item]
        );
    }
}
