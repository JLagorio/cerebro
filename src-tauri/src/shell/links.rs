//! Where the webview may go (M53.12): `shared/policy/links.v1.json`, read by
//! the two hooks `shell::build_main_window` attaches to the main window.
//!
//! Three verdicts. The ENTRY DOCUMENT loads: the app's own origin
//! (`tauri://localhost`, or the devUrl under `tauri dev`) at one of the
//! artifact's entry paths, with no credentials and no query. A fragment is
//! ignored, so an in-page `#anchor` still scrolls. An `http(s)` address leaves
//! for the system browser, and the webview stays on its page. Everything else
//! is refused: `mailto:`, `file:`, `blob:`, `about:`, and any OTHER path or
//! query on the app's own origin. That last one is the reason the entry is a
//! closed list: tauri's asset fallback serves `index.html` for every path it
//! cannot find (tauri-2.11.5 manager/mod.rs:405-425), so following a
//! vault-relative link reloads the whole app and drops whatever the open page
//! had not saved yet.
//!
//! `isWebUrl` (src/mermaid/flowchart/linkTargets.ts) reads the same scheme
//! list, and both languages replay the artifact's `cases`, so the badge that
//! offers a link and the guard that routes it cannot disagree about one.
//!
//! The origin is compared field by field, by hand: `Url::origin()` is opaque
//! for a non-special scheme like `tauri:`, and an opaque origin equals
//! nothing, itself included.
//!
//! macOS only, like the bundle: Windows and Android serve the app from
//! `http(s)://tauri.localhost`, an origin the artifact does not name, and the
//! system browser is reached through `/usr/bin/open`.

use tauri::webview::NewWindowResponse;
use tauri::Url;

/// The rule, compiled in. The TypeScript side holds no copy of it:
/// linkTargets.ts imports these same bytes.
const LINKS: &str = include_str!("../../../shared/policy/links.v1.json");

#[derive(serde::Deserialize)]
struct Artifact {
    entry: EntryArtifact,
    external_schemes: Vec<String>,
}

#[derive(serde::Deserialize)]
struct EntryArtifact {
    origin: String,
    paths: Vec<String>,
}

struct Rule {
    origin: Url,
    paths: Vec<String>,
    external_schemes: Vec<String>,
}

fn rule() -> &'static Rule {
    static RULE: std::sync::OnceLock<Rule> = std::sync::OnceLock::new();
    RULE.get_or_init(|| {
        let artifact: Artifact = serde_json::from_str(LINKS).expect("links.v1.json parses");
        Rule {
            origin: Url::parse(&artifact.entry.origin).expect("links.v1.json's origin parses"),
            paths: artifact.entry.paths,
            external_schemes: artifact.external_schemes,
        }
    })
}

/// What happens to one URL the webview was asked to load.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkVerdict {
    /// The entry document: the webview loads it.
    Allow,
    /// An `http(s)` address: the system browser opens it, the webview stays.
    External,
    /// Anything else: nothing happens.
    Deny,
}

impl LinkVerdict {
    /// The artifact's spelling of this verdict.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Allow => "allow",
            Self::External => "external",
            Self::Deny => "deny",
        }
    }
}

/// Classify one requested URL. `dev_root` is the devUrl under `tauri dev`
/// and `None` in a packaged build, where that address is just another web
/// page.
pub fn classify(url: &Url, dev_root: Option<&Url>) -> LinkVerdict {
    let rule = rule();
    let own_origin =
        same_origin(url, &rule.origin) || dev_root.is_some_and(|root| same_origin(url, root));
    if own_origin {
        let entry = url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && rule.paths.iter().any(|path| path == url.path());
        return if entry {
            LinkVerdict::Allow
        } else {
            LinkVerdict::Deny
        };
    }
    if is_external_scheme(url) {
        LinkVerdict::External
    } else {
        LinkVerdict::Deny
    }
}

fn is_external_scheme(url: &Url) -> bool {
    rule()
        .external_schemes
        .iter()
        .any(|scheme| scheme == url.scheme())
}

fn same_origin(a: &Url, b: &Url) -> bool {
    a.scheme() == b.scheme()
        && a.host_str() == b.host_str()
        && a.port_or_known_default() == b.port_or_known_default()
}

/// The navigation hook. `true` lets the webview go; an external address is
/// handed to `open` instead, and the webview stays where it is.
pub fn route_navigation(url: &Url, dev_root: Option<&Url>, open: &dyn Fn(&Url)) -> bool {
    match classify(url, dev_root) {
        LinkVerdict::Allow => true,
        LinkVerdict::External => {
            open(url);
            false
        }
        LinkVerdict::Deny => false,
    }
}

/// The new-window hook: every `target="_blank"` anchor, `window.open`,
/// BlockNote's link toolbar and tiptap's click handler arrive here. It never
/// creates a window, not even for the entry document: `capabilities/default.json`
/// grants exactly one label, and a second copy of the app would share no
/// state with the first. An external address goes to `open`.
pub fn route_new_window<R: tauri::Runtime>(
    url: &Url,
    dev_root: Option<&Url>,
    open: &dyn Fn(&Url),
) -> NewWindowResponse<R> {
    if classify(url, dev_root) == LinkVerdict::External {
        open(url);
    }
    NewWindowResponse::Deny
}

/// Hand an `http(s)` address to the system browser through `/usr/bin/open`:
/// the OS already does this, and the house rule is that a crate duplicating
/// what the platform provides does not qualify. A scheme outside the
/// artifact's `external_schemes` is dropped here as well, whoever the
/// caller, so the argument always begins with `http` and `open` can never
/// read it as a flag or a file.
///
/// On its own thread because the webview runs its hooks on the main thread
/// and `status()` waits for `open` to exit, which is what reaps the child.
/// The result is dropped: the page stays where it is either way, and a
/// refused link is just as silent.
pub fn open_in_browser(url: &Url) {
    if !is_external_scheme(url) {
        return;
    }
    let target = url.as_str().to_owned();
    let _ = std::thread::Builder::new()
        .name("cerebro-open-url".into())
        .spawn(move || {
            let _ = crate::spawn::command("/usr/bin/open").arg(target).status();
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    const VERDICTS: [LinkVerdict; 3] =
        [LinkVerdict::Allow, LinkVerdict::External, LinkVerdict::Deny];

    struct Case {
        raw: serde_json::Value,
        url: Url,
        dev_root: Option<Url>,
        verdict: String,
    }

    fn artifact() -> serde_json::Value {
        serde_json::from_str(LINKS).expect("links.v1.json parses")
    }

    fn cases() -> Vec<Case> {
        let cases: Vec<Case> = artifact()["cases"]
            .as_array()
            .expect("cases is a list")
            .iter()
            .map(|raw| {
                let url = raw["url"].as_str().expect("a case names its url");
                let dev_root = raw
                    .get("dev_root")
                    .map(|root| Url::parse(root.as_str().expect("dev_root is a string")))
                    .transpose()
                    .unwrap_or_else(|e| panic!("{raw}: dev_root does not parse: {e}"));
                Case {
                    url: Url::parse(url)
                        .unwrap_or_else(|e| panic!("{raw}: url does not parse: {e}")),
                    dev_root,
                    verdict: raw["verdict"].as_str().expect("a verdict").to_owned(),
                    raw: raw.clone(),
                }
            })
            .collect();
        assert!(cases.len() > 20, "the replay is reading the real artifact");
        cases
    }

    // linkTargets.test.ts replays the same file through `isWebUrl`, so the
    // two readers of one scheme list cannot drift.
    #[test]
    fn replays_the_shared_link_cases() {
        for case in cases() {
            assert_eq!(
                classify(&case.url, case.dev_root.as_ref()).as_str(),
                case.verdict,
                "{}",
                case.raw
            );
        }
    }

    #[test]
    fn the_link_rule_is_closed_and_canonical() {
        let artifact = artifact();
        assert_eq!(artifact["format"], 1);

        let schemes: Vec<&str> = artifact["external_schemes"]
            .as_array()
            .expect("external_schemes is a list")
            .iter()
            .map(|s| s.as_str().expect("a scheme is a string"))
            .collect();
        assert!(
            !schemes.is_empty(),
            "nothing would ever leave for the browser"
        );
        for scheme in &schemes {
            // `Url::scheme()` is always lowercase, so a capital here would
            // be a scheme no URL can ever match.
            let mut bytes = scheme.bytes();
            assert!(
                bytes.next().is_some_and(|b| b.is_ascii_lowercase())
                    && bytes.all(|b| b.is_ascii_lowercase()
                        || b.is_ascii_digit()
                        || b"+-.".contains(&b)),
                "{scheme:?} is not a lowercase ASCII scheme"
            );
        }
        assert!(
            schemes.windows(2).all(|pair| pair[0] < pair[1]),
            "external_schemes is sorted and unique: {schemes:?}"
        );

        let paths = &rule().paths;
        for required in ["", "/", "/index.html"] {
            assert!(
                paths.iter().any(|p| p == required),
                "entry.paths lacks {required:?}: the app could not load its own entry"
            );
        }
        assert_eq!(rule().origin.as_str(), "tauri://localhost");

        for case in artifact["cases"].as_array().unwrap() {
            // A misspelled key would replay the case as if it had no
            // dev_root, and pass or fail for the wrong reason.
            for key in case.as_object().expect("a case is an object").keys() {
                assert!(
                    ["url", "dev_root", "verdict"].contains(&key.as_str()),
                    "{case}: unknown key {key:?}"
                );
            }
        }
        let cases = cases();
        for verdict in VERDICTS {
            assert!(
                cases.iter().any(|c| c.verdict == verdict.as_str()),
                "no case pins {verdict:?}"
            );
        }
        for case in &cases {
            assert!(
                VERDICTS.iter().any(|v| v.as_str() == case.verdict),
                "{}: {:?} is not a verdict",
                case.raw,
                case.verdict
            );
        }
    }

    #[test]
    fn a_navigation_proceeds_only_on_the_entry_document() {
        for case in cases() {
            let opened = RefCell::new(Vec::new());
            let open = |url: &Url| opened.borrow_mut().push(url.clone());
            let proceeds = route_navigation(&case.url, case.dev_root.as_ref(), &open);
            let opened = opened.into_inner();
            match case.verdict.as_str() {
                "allow" => assert!(proceeds && opened.is_empty(), "{}", case.raw),
                "external" => {
                    assert!(!proceeds, "{}: the webview followed it", case.raw);
                    assert_eq!(opened, vec![case.url.clone()], "{}", case.raw);
                }
                _ => assert!(!proceeds && opened.is_empty(), "{}", case.raw),
            }
        }
    }

    #[test]
    fn a_new_window_is_never_created() {
        for case in cases() {
            let opened = RefCell::new(Vec::new());
            let open = |url: &Url| opened.borrow_mut().push(url.clone());
            let response = route_new_window::<tauri::Wry>(&case.url, case.dev_root.as_ref(), &open);
            assert!(matches!(response, NewWindowResponse::Deny), "{}", case.raw);
            let expected = if case.verdict == "external" {
                vec![case.url.clone()]
            } else {
                Vec::new()
            };
            assert_eq!(opened.into_inner(), expected, "{}", case.raw);
        }
    }
}
