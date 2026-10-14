//! Open with (M55.9): what the app may hand to the rest of the Mac.
//!
//! Exactly two kinds of target leave the app here, and nothing else does:
//!
//! - a markdown note inside the vault, judged by `vault::write::existing_note`
//!   (the note writers' own door, so M53.4's refusals hold), which Finder
//!   reveals (`open -R`) or the default app opens (`open`, then `open -t`);
//! - an agent link, built here from `shared/policy/agent-links.v1.json` and
//!   only from it: one of its bases, its param and the prompt, percent-encoded
//!   the way `encodeURIComponent` encodes. A link over the artifact's
//!   `max_url_bytes` is never opened; the caller copies the prompt instead.
//!
//! Each target goes to `/usr/bin/open` as one argument, never through a
//! shell, and the clipboard is written through `/usr/bin/pbcopy`, which
//! needs no user gesture: WebKit allows a clipboard write only inside one,
//! and a prompt is built after two awaits. "Agent link" and not "hand-off",
//! because `hand_to` and `start_handoff_run` already mean one agent handing
//! work to another.
//!
//! Every action goes through the [`Desktop`] seam, so the tests pass a
//! recorder and no cargo test starts a process. macOS only, like the bundle.

use std::ffi::OsString;
use std::io::Write as _;
use std::path::Path;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use crate::vault::write::existing_note;

/// The rule, compiled in. The TypeScript side reads only the ids and labels.
const AGENT_LINKS: &str = include_str!("../../../shared/policy/agent-links.v1.json");

/// How long `/usr/bin/open` may take before it is killed.
const OPEN_TIMEOUT: Duration = Duration::from_secs(10);
/// How long `/usr/bin/pbcopy` may take before it is killed.
const COPY_TIMEOUT: Duration = Duration::from_secs(5);
/// How often a bounded wait looks at the child again.
const POLL: Duration = Duration::from_millis(25);

/// What `pbcopy` stores as something other than plain text: it reads a
/// leading RTF or EPS header as that type, so the paste would not be the
/// prompt.
const RICH_HEADERS: [&str; 2] = ["{\\rtf", "%!PS-Adobe"];

#[derive(Debug, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Artifact {
    format: u32,
    #[expect(
        dead_code,
        reason = "the rule is for the reader; serde must still accept the key"
    )]
    rule: String,
    max_url_bytes: usize,
    targets: Vec<AgentTarget>,
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "only the tests replay the cases")
    )]
    cases: Vec<LinkCase>,
}

/// One app a page can be handed to.
#[derive(Debug, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct AgentTarget {
    id: String,
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the menu reads labels in TypeScript")
    )]
    label: String,
    base: String,
    param: String,
}

/// One replayed case: a prompt (or `repeat` × `times`), and exactly one of
/// the URL it builds, that URL's length, or `too_long`.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(deny_unknown_fields)]
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "only the tests replay the cases")
)]
struct LinkCase {
    target: String,
    prompt: Option<String>,
    repeat: Option<String>,
    times: Option<usize>,
    url: Option<String>,
    bytes: Option<usize>,
    too_long: Option<bool>,
}

/// The artifact, read strictly: unknown keys refuse, and so does any format
/// but 1.
fn parse(raw: &str) -> Result<Artifact, String> {
    let artifact: Artifact =
        serde_json::from_str(raw).map_err(|e| format!("agent-links.v1.json: {e}"))?;
    if artifact.format != 1 {
        return Err(format!(
            "agent-links.v1.json: format {} is not 1",
            artifact.format
        ));
    }
    Ok(artifact)
}

fn artifact() -> &'static Artifact {
    static ARTIFACT: OnceLock<Artifact> = OnceLock::new();
    ARTIFACT.get_or_init(|| parse(AGENT_LINKS).expect("agent-links.v1.json parses"))
}

/// Percent-encode every UTF-8 byte except `A-Z a-z 0-9 - _ . ! ~ * ' ( )`:
/// `encodeURIComponent`'s set, so a space is `%20`, never `+`.
pub fn encode_component(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(char::from(byte));
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// What one agent link would be.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LinkPlan {
    Url(String),
    /// Over `max_url_bytes`: nothing opens it.
    TooLong,
}

/// The link for `target` carrying `prompt`, or a refusal for an id the
/// artifact does not name.
pub fn agent_link_url(target: &str, prompt: &str) -> Result<LinkPlan, String> {
    let artifact = artifact();
    let found = artifact
        .targets
        .iter()
        .find(|t| t.id == target)
        .ok_or_else(|| format!("{target} is not an app Open with knows"))?;
    let url = format!(
        "{}?{}={}",
        found.base,
        found.param,
        encode_component(prompt)
    );
    Ok(if url.len() > artifact.max_url_bytes {
        LinkPlan::TooLong
    } else {
        LinkPlan::Url(url)
    })
}

/// What an agent link did, as the webview reads it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentLinkOutcome {
    Opened,
    /// Never handed to `open`; the caller copies the prompt.
    TooLong,
    /// `open` found nothing to open it with; the caller copies the prompt.
    NoApp,
}

/// The two things Open with asks of the Mac.
pub trait Desktop {
    /// Run `/usr/bin/open` with `args`; `true` when it exits 0.
    fn open(&self, args: &[OsString]) -> Result<bool, String>;
    /// Put `text` on the clipboard as plain text.
    fn copy(&self, text: &str) -> Result<(), String>;
}

/// Finder selects the note.
pub fn reveal_with(desktop: &dyn Desktop, vault: &Path, path: &str) -> Result<(), String> {
    let abs = existing_note(vault, path)?;
    if desktop.open(&["-R".into(), abs.into_os_string()])? {
        Ok(())
    } else {
        Err(format!("Finder couldn't show {path}"))
    }
}

/// The app the Mac opens markdown with opens the note; with none set, the
/// default text editor (`open -t`).
pub fn open_default_with(desktop: &dyn Desktop, vault: &Path, path: &str) -> Result<(), String> {
    let abs = existing_note(vault, path)?.into_os_string();
    if desktop.open(std::slice::from_ref(&abs))? || desktop.open(&["-t".into(), abs])? {
        Ok(())
    } else {
        Err("No app is set to open Markdown files".to_string())
    }
}

/// Hand `prompt` to `target`. A link that is too long never reaches `open`,
/// and one that `open` cannot place, or could not run, is `NoApp`: either
/// way the prompt still has somewhere to go, the clipboard.
pub fn agent_link_with(
    desktop: &dyn Desktop,
    target: &str,
    prompt: &str,
) -> Result<AgentLinkOutcome, String> {
    match agent_link_url(target, prompt)? {
        LinkPlan::TooLong => Ok(AgentLinkOutcome::TooLong),
        LinkPlan::Url(url) => Ok(match desktop.open(&[url.into()]) {
            Ok(true) => AgentLinkOutcome::Opened,
            Ok(false) | Err(_) => AgentLinkOutcome::NoApp,
        }),
    }
}

/// Put `text` on the clipboard, refusing what `pbcopy` would store as rich
/// text or EPS.
pub fn copy_with(desktop: &dyn Desktop, text: &str) -> Result<(), String> {
    if RICH_HEADERS.iter().any(|header| text.starts_with(header)) {
        return Err("That text starts like a rich-text file, so it can't be copied".to_string());
    }
    desktop.copy(text)
}

/// The real Mac: `/usr/bin/open` and `/usr/bin/pbcopy`, each bounded.
pub struct SystemDesktop;

/// The `pbcopy` child, built and not started. Its stdin is piped, and it
/// speaks UTF-8: with no locale (an app launched from Finder has none)
/// pbcopy reads its input in the C encoding, and `café` would paste as
/// mojibake.
fn pbcopy_command() -> Command {
    let mut cmd = crate::spawn::command("/usr/bin/pbcopy");
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .env("LANG", "en_US.UTF-8")
        .env("LC_ALL", "en_US.UTF-8");
    cmd
}

/// Wait for `child` up to `limit`, killing and reaping it past that.
fn wait_bounded(mut child: Child, what: &str, limit: Duration) -> Result<ExitStatus, String> {
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status),
            Ok(None) if started.elapsed() < limit => std::thread::sleep(POLL),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("{what} took more than {} s", limit.as_secs()));
            }
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("waiting for {what}: {e}"));
            }
        }
    }
}

impl Desktop for SystemDesktop {
    fn open(&self, args: &[OsString]) -> Result<bool, String> {
        let child = crate::spawn::command("/usr/bin/open")
            .args(args)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("starting open: {e}"))?;
        Ok(wait_bounded(child, "open", OPEN_TIMEOUT)?.success())
    }

    fn copy(&self, text: &str) -> Result<(), String> {
        let mut child = pbcopy_command()
            .spawn()
            .map_err(|e| format!("starting pbcopy: {e}"))?;
        // Written on its own thread so a pbcopy that stops reading cannot
        // hold the wait below; killing it ends the write with a broken pipe.
        let writer = child.stdin.take().map(|mut stdin| {
            let bytes = text.as_bytes().to_vec();
            std::thread::spawn(move || stdin.write_all(&bytes))
        });
        let status = wait_bounded(child, "pbcopy", COPY_TIMEOUT)?;
        let written = writer.map(|w| w.join());
        match written {
            Some(Ok(Err(e))) => return Err(format!("writing to pbcopy: {e}")),
            Some(Err(_)) => return Err("writing to pbcopy failed".to_string()),
            _ => {}
        }
        if status.success() {
            Ok(())
        } else {
            Err("pbcopy couldn't write the clipboard".to_string())
        }
    }
}

/// Reveal a vault note in Finder.
#[tauri::command(async)]
pub fn reveal_in_finder(vault: String, path: String) -> Result<(), String> {
    reveal_with(&SystemDesktop, Path::new(&vault), &path)
}

/// Open a vault note in the app the Mac opens markdown with.
#[tauri::command(async)]
pub fn open_in_default_app(vault: String, path: String) -> Result<(), String> {
    open_default_with(&SystemDesktop, Path::new(&vault), &path)
}

/// Hand a prompt to one of the artifact's agent apps.
#[tauri::command(async)]
pub fn open_agent_link(target: String, prompt: String) -> Result<AgentLinkOutcome, String> {
    agent_link_with(&SystemDesktop, &target, &prompt)
}

/// Write the clipboard without a user gesture.
#[tauri::command(async)]
pub fn write_clipboard(text: String) -> Result<(), String> {
    copy_with(&SystemDesktop, &text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::testutil::{temp_vault, write};
    use std::cell::RefCell;

    /// A Desktop that records what it was asked and answers from a script.
    struct Recorder {
        opens: RefCell<Vec<Vec<OsString>>>,
        copies: RefCell<Vec<String>>,
        /// Each `open` answers the next of these; past the end, `true`.
        answers: RefCell<Vec<Result<bool, String>>>,
    }

    impl Recorder {
        fn new(answers: Vec<Result<bool, String>>) -> Self {
            Self {
                opens: RefCell::new(Vec::new()),
                copies: RefCell::new(Vec::new()),
                answers: RefCell::new(answers),
            }
        }
        fn opens(&self) -> Vec<Vec<OsString>> {
            self.opens.borrow().clone()
        }
    }

    impl Desktop for Recorder {
        fn open(&self, args: &[OsString]) -> Result<bool, String> {
            self.opens.borrow_mut().push(args.to_vec());
            let mut answers = self.answers.borrow_mut();
            if answers.is_empty() {
                Ok(true)
            } else {
                answers.remove(0)
            }
        }
        fn copy(&self, text: &str) -> Result<(), String> {
            self.copies.borrow_mut().push(text.to_string());
            Ok(())
        }
    }

    fn case_prompt(case: &LinkCase) -> String {
        match (&case.prompt, &case.repeat, case.times) {
            (Some(prompt), None, None) => prompt.clone(),
            (None, Some(repeat), Some(times)) => repeat.repeat(times),
            _ => panic!("{case:?}: give a prompt, or repeat and times"),
        }
    }

    #[test]
    fn replays_the_agent_link_cases() {
        let cases = &artifact().cases;
        assert!(cases.len() >= 10, "the replay is reading the real artifact");
        for case in cases {
            let plan = agent_link_url(&case.target, &case_prompt(case))
                .unwrap_or_else(|e| panic!("{case:?}: {e}"));
            match (&case.url, case.bytes, case.too_long) {
                (Some(url), None, None) => assert_eq!(plan, LinkPlan::Url(url.clone()), "{case:?}"),
                (None, Some(bytes), None) => match plan {
                    LinkPlan::Url(url) => assert_eq!(url.len(), bytes, "{case:?}"),
                    LinkPlan::TooLong => panic!("{case:?}: refused as too long"),
                },
                (None, None, Some(true)) => assert_eq!(plan, LinkPlan::TooLong, "{case:?}"),
                _ => panic!("{case:?}: give exactly one of url, bytes or too_long: true"),
            }
        }
        // The boundary itself: the largest URL builds, one byte more does not.
        let max = artifact().max_url_bytes;
        let built_len = |c: &LinkCase| {
            let target = artifact()
                .targets
                .iter()
                .find(|t| t.id == c.target)
                .unwrap();
            format!("{}?{}=", target.base, target.param).len()
                + encode_component(&case_prompt(c)).len()
        };
        assert!(
            cases.iter().any(|c| c.bytes == Some(max)),
            "no case builds a URL of exactly {max} bytes"
        );
        assert!(
            cases
                .iter()
                .any(|c| c.too_long == Some(true) && built_len(c) == max + 1),
            "no case is refused at exactly {} bytes",
            max + 1
        );
    }

    #[test]
    fn the_agent_link_table_is_closed() {
        let artifact = artifact();
        assert_eq!(artifact.format, 1);
        assert_eq!(artifact.max_url_bytes, 8192);
        assert!(!artifact.targets.is_empty());
        let mut ids: Vec<&str> = Vec::new();
        for target in &artifact.targets {
            let kebab = !target.id.is_empty()
                && !target.id.starts_with('-')
                && !target.id.ends_with('-')
                && !target.id.contains("--")
                && target
                    .id
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
            assert!(kebab, "{:?} is not a kebab-case id", target.id);
            assert!(!ids.contains(&target.id.as_str()), "{} twice", target.id);
            ids.push(&target.id);
            assert!(
                !target.label.trim().is_empty(),
                "{} has no label",
                target.id
            );
            let base = tauri::Url::parse(&target.base)
                .unwrap_or_else(|e| panic!("{}: base does not parse: {e}", target.id));
            assert!(
                base.query().is_none()
                    && base.fragment().is_none()
                    && base.username().is_empty()
                    && base.password().is_none()
                    && !target.base.contains('?')
                    && !target.base.contains('#'),
                "{}: a base carries no query, fragment or userinfo",
                target.id
            );
            assert!(
                !target.param.is_empty() && target.param.bytes().all(|b| b.is_ascii_lowercase()),
                "{}: param {:?} is not [a-z]+",
                target.id,
                target.param
            );
            assert!(
                artifact
                    .cases
                    .iter()
                    .any(|c| c.target == target.id && c.url.is_some()),
                "{} has no exact-URL case",
                target.id
            );
        }
        assert_eq!(
            ids,
            ["claude-code-web", "codex", "cursor", "zed"],
            "menu order"
        );
        for case in &artifact.cases {
            assert!(
                ids.contains(&case.target.as_str()),
                "{case:?}: unknown target"
            );
        }

        // Unknown keys are refused at every level, so a misspelt one cannot
        // replay a case as if it were absent.
        let value: serde_json::Value = serde_json::from_str(AGENT_LINKS).unwrap();
        for pointer in ["", "/targets/0", "/cases/0"] {
            let mut bad = value.clone();
            bad.pointer_mut(pointer)
                .and_then(|v| v.as_object_mut())
                .expect("an object")
                .insert("surprise".into(), serde_json::json!(1));
            assert!(
                parse(&bad.to_string()).is_err(),
                "an unknown key at {pointer:?} was accepted"
            );
        }
        let mut format_two = value.clone();
        format_two["format"] = serde_json::json!(2);
        assert!(
            parse(&format_two.to_string()).is_err(),
            "format 2 was accepted"
        );

        // Two-space JSON, LF, one trailing newline.
        assert!(!AGENT_LINKS.contains('\r') && !AGENT_LINKS.contains('\t'));
        assert!(AGENT_LINKS.ends_with("}\n") && !AGENT_LINKS.ends_with("\n\n"));
    }

    #[test]
    fn encoding_is_encode_uri_component() {
        assert_eq!(encode_component("a b"), "a%20b");
        assert_eq!(encode_component("&=#+%"), "%26%3D%23%2B%25");
        assert_eq!(encode_component("\n"), "%0A");
        assert_eq!(encode_component("caf\u{e9}"), "caf%C3%A9");
        assert_eq!(encode_component("\u{1f680}"), "%F0%9F%9A%80");
        assert_eq!(encode_component("-_.!~*'()"), "-_.!~*'()");
        assert_eq!(encode_component("AZaz09"), "AZaz09");
        // Every other printable ASCII byte is escaped.
        for byte in 0x20u8..0x7f {
            let kept = byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte);
            let encoded = encode_component(&char::from(byte).to_string());
            assert_eq!(encoded.len() == 1, kept, "{:?}", char::from(byte));
        }
    }

    #[test]
    fn a_too_long_link_never_reaches_open() {
        let desktop = Recorder::new(vec![]);
        let prompt = "a".repeat(artifact().max_url_bytes);
        for target in &artifact().targets {
            assert_eq!(
                agent_link_with(&desktop, &target.id, &prompt),
                Ok(AgentLinkOutcome::TooLong)
            );
        }
        assert!(desktop.opens().is_empty());
    }

    #[test]
    fn an_unknown_target_is_refused_before_anything_runs() {
        let desktop = Recorder::new(vec![]);
        for target in ["vscode", "", "Codex", "codex://new"] {
            assert!(
                agent_link_with(&desktop, target, "hi").is_err(),
                "{target:?}"
            );
        }
        assert!(desktop.opens().is_empty());
    }

    #[test]
    fn a_link_nothing_opens_is_no_app() {
        let desktop = Recorder::new(vec![Ok(false), Err("starting open: gone".into())]);
        assert_eq!(
            agent_link_with(&desktop, "zed", "hi there"),
            Ok(AgentLinkOutcome::NoApp)
        );
        assert_eq!(
            agent_link_with(&desktop, "zed", "hi there"),
            Ok(AgentLinkOutcome::NoApp)
        );
        assert_eq!(
            agent_link_with(&desktop, "zed", "hi there"),
            Ok(AgentLinkOutcome::Opened)
        );
        // One argument each time: the link itself.
        let link: OsString = "zed://agent?prompt=hi%20there".into();
        assert_eq!(desktop.opens(), vec![vec![link.clone()]; 3]);
        assert_eq!(
            serde_json::to_value(AgentLinkOutcome::TooLong).unwrap(),
            serde_json::json!("too_long")
        );
        assert_eq!(
            serde_json::to_value(AgentLinkOutcome::NoApp).unwrap(),
            serde_json::json!("no_app")
        );
    }

    #[test]
    fn reveal_and_open_take_only_a_note_inside_the_vault() {
        let vault = temp_vault("open-with-door");
        write(&vault, "notes/a.md", "# A\n");
        write(&vault, "notes/a.txt", "a\n");
        write(&vault, "views/x.md", "# X\n");
        write(&vault, ".git/config", "[core]\n");
        let outside = temp_vault("open-with-outside");
        write(&outside, "secret.md", "# S\n");
        std::os::unix::fs::symlink(outside.join("secret.md"), vault.join("notes/out.md")).unwrap();
        std::os::unix::fs::symlink(&outside, vault.join("away")).unwrap();

        let desktop = Recorder::new(vec![]);
        assert_eq!(reveal_with(&desktop, &vault, "notes/a.md"), Ok(()));
        assert_eq!(open_default_with(&desktop, &vault, "notes/a.md"), Ok(()));
        assert_eq!(desktop.opens().len(), 2);

        let refused = Recorder::new(vec![]);
        for rel in [
            "../x.md",
            "/etc/hosts",
            ".git/config",
            "notes/a.txt",
            "notes",
            "missing.md",
            "views/x.md",
            "notes/out.md",
            "away/secret.md",
        ] {
            assert!(reveal_with(&refused, &vault, rel).is_err(), "reveal {rel}");
            assert!(
                open_default_with(&refused, &vault, rel).is_err(),
                "open {rel}"
            );
        }
        assert!(refused.opens().is_empty(), "{:?}", refused.opens());
        assert_eq!(
            reveal_with(&refused, &vault, "missing.md"),
            Err("missing.md is not a file in the vault".to_string())
        );
        // Nothing on disk moved.
        assert_eq!(
            std::fs::read_to_string(vault.join("notes/a.md")).unwrap(),
            "# A\n"
        );
        std::fs::remove_dir_all(&vault).unwrap();
        std::fs::remove_dir_all(&outside).unwrap();
    }

    #[test]
    fn reveal_passes_dash_r_and_the_canonical_path() {
        let vault = temp_vault("open-with-reveal");
        write(&vault, "notes/a.md", "# A\n");
        let canonical = vault.join("notes/a.md").canonicalize().unwrap();
        let desktop = Recorder::new(vec![]);
        reveal_with(&desktop, &vault, "./notes/a.md").unwrap();
        assert_eq!(
            desktop.opens(),
            vec![vec![OsString::from("-R"), canonical.into_os_string()]]
        );
        let failing = Recorder::new(vec![Ok(false)]);
        assert!(reveal_with(&failing, &vault, "notes/a.md").is_err());
        std::fs::remove_dir_all(&vault).unwrap();
    }

    #[test]
    fn the_default_editor_falls_back_to_dash_t() {
        let vault = temp_vault("open-with-default");
        write(&vault, "notes/a.md", "# A\n");
        let abs = vault
            .join("notes/a.md")
            .canonicalize()
            .unwrap()
            .into_os_string();

        let fallback = Recorder::new(vec![Ok(false), Ok(true)]);
        assert_eq!(open_default_with(&fallback, &vault, "notes/a.md"), Ok(()));
        assert_eq!(
            fallback.opens(),
            vec![vec![abs.clone()], vec![OsString::from("-t"), abs.clone()]]
        );

        let first = Recorder::new(vec![Ok(true)]);
        assert_eq!(open_default_with(&first, &vault, "notes/a.md"), Ok(()));
        assert_eq!(first.opens(), vec![vec![abs]]);

        let neither = Recorder::new(vec![Ok(false), Ok(false)]);
        assert_eq!(
            open_default_with(&neither, &vault, "notes/a.md"),
            Err("No app is set to open Markdown files".to_string())
        );
        std::fs::remove_dir_all(&vault).unwrap();
    }

    #[test]
    fn the_clipboard_child_speaks_utf8() {
        let cmd = pbcopy_command();
        assert_eq!(cmd.get_program(), "/usr/bin/pbcopy");
        assert_eq!(cmd.get_args().count(), 0);
        let envs: Vec<_> = cmd.get_envs().collect();
        for key in ["LANG", "LC_ALL"] {
            assert!(
                envs.iter()
                    .any(|(k, v)| *k == key && *v == Some("en_US.UTF-8".as_ref())),
                "{key} is not en_US.UTF-8: {envs:?}"
            );
        }
        // std::process::Command has no getter for its stdio, so the builder's
        // own text is the witness that the text reaches pbcopy on stdin.
        let body = include_str!("open.rs")
            .split("fn pbcopy_command() -> Command {")
            .nth(1)
            .and_then(|rest| rest.split("\n}\n").next())
            .expect("pbcopy_command's body");
        assert!(body.contains(".stdin(Stdio::piped())"), "{body}");
    }

    #[test]
    fn rich_text_headers_are_refused() {
        let desktop = Recorder::new(vec![]);
        for text in ["{\\rtf1\\ansi hi}", "%!PS-Adobe-3.0\n"] {
            assert!(copy_with(&desktop, text).is_err(), "{text:?}");
        }
        assert!(desktop.copies.borrow().is_empty());
        copy_with(&desktop, "caf\u{e9} \u{2014} \u{1f680}").unwrap();
        copy_with(&desktop, "Not {\\rtf at the start").unwrap();
        assert_eq!(desktop.copies.borrow().len(), 2);
    }
}
