//! The Rust rails (M53.21), pinned where they are configured.
//!
//! Clippy holds three rails, and only while the configuration says so:
//!
//! - A suppression is a reasoned expectation. `[lints.clippy]` in Cargo.toml
//!   denies `allow_attributes`, so a lint is silenced with `#[expect]`, which
//!   fails the gate once the lint stops firing, and it denies
//!   `allow_attributes_without_reason`, so every expectation says why.
//! - Children start in [`crate::spawn`], and nothing changes this process's
//!   environment. clippy.toml bans `Command::new`, `set_var` and
//!   `remove_var`, and Cargo.toml denies the `disallowed_methods` lint that
//!   reads that list.
//! - Nothing prints (M53.24). Cargo.toml denies `print_stdout` and
//!   `print_stderr`, so a line goes to the diagnostic log through `log::`,
//!   and the few prints left each carry a reasoned expectation.
//!
//! These tests read that configuration, so deleting a line of it fails here
//! instead of switching a rail off without a word. They also close the gaps
//! clippy leaves by design: it runs both suppression lints only under an MSRV
//! that has lint reasons, `allow_attributes` skips an inner `#![allow]`, and
//! an attribute inside a `cfg_attr` is linted only by a build whose cfg holds.
//!
//! One rail is not clippy's: the diagnostic log has no reader. Only
//! [`crate::diagnostics`] names its files, so no other Rust file and no file
//! of the web app can open them.

use std::path::{Path, PathBuf};

const CARGO_TOML: &str = include_str!("../Cargo.toml");
const CLIPPY_TOML: &str = include_str!("../clippy.toml");

/// Lint reasons were stabilized in Rust 1.81. Told an older MSRV, clippy
/// runs neither suppression lint (measured on clippy 0.1.95).
const LINT_REASONS: (u32, u32) = (1, 81);

/// The lints that make every suppression a reasoned expectation.
const SUPPRESSION_LINTS: [&str; 2] = ["allow_attributes", "allow_attributes_without_reason"];

/// The lints that keep this crate from printing (M53.24).
const PRINT_LINTS: [&str; 2] = ["print_stdout", "print_stderr"];

/// The one file that may name the diagnostic log's files.
const LOG_OWNER: &str = "src/diagnostics.rs";

/// The calls clippy.toml must refuse.
const BANNED: [&str; 3] = [
    "std::process::Command::new",
    "std::env::set_var",
    "std::env::remove_var",
];

/// A source file: its path within the crate, and its text.
type Source = (PathBuf, String);

/// The quoted string `value` starts with, if it starts with one.
fn quoted(value: &str) -> Option<&str> {
    let rest = value.trim_start().strip_prefix('"')?;
    rest.find('"').map(|end| &rest[..end])
}

/// The quoted value of `key = "..."` somewhere in `line`.
fn field<'a>(line: &'a str, key: &str) -> Option<&'a str> {
    line.match_indices(key).find_map(|(at, _)| {
        let rest = line[at + key.len()..].trim_start().strip_prefix('=')?;
        quoted(rest)
    })
}

/// The `key = value` rows of the TOML table `[name]`, values untouched.
fn table<'a>(toml: &'a str, name: &str) -> Vec<(&'a str, &'a str)> {
    let header = format!("[{name}]");
    let mut inside = false;
    let mut rows = Vec::new();
    for line in toml.lines().map(str::trim) {
        if line.starts_with('[') {
            inside = line == header;
        } else if inside && !line.starts_with('#') {
            if let Some((key, value)) = line.split_once('=') {
                rows.push((key.trim(), value.trim()));
            }
        }
    }
    rows
}

/// The level a Cargo.toml's `[lints.clippy]` sets for `lint`: a bare
/// `"deny"`, or the `level` of an inline table.
fn clippy_level<'a>(cargo: &'a str, lint: &str) -> Option<&'a str> {
    let (_, value) = table(cargo, "lints.clippy")
        .into_iter()
        .find(|(key, _)| *key == lint)?;
    quoted(value).or_else(|| field(value, "level"))
}

/// The problem, if `cargo` does not deny `lint`.
fn undenied(cargo: &str, lint: &str) -> Option<String> {
    let level = clippy_level(cargo, lint);
    (!matches!(level, Some("deny" | "forbid")))
        .then(|| format!("[lints.clippy] must deny {lint}; it sets {level:?}"))
}

/// `1.81` or `1.81.0`, as (major, minor).
fn version(raw: &str) -> Option<(u32, u32)> {
    let mut parts = raw.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next().map_or(Some(0), |part| part.parse().ok())?;
    Some((major, minor))
}

/// Every MSRV older than lint reasons that clippy could be told, by where it
/// is told: Cargo.toml's `rust-version`, clippy.toml's `msrv`, and a
/// `clippy::msrv` attribute in a source.
fn msrv_problems(cargo: &str, clippy: &str, sources: &[Source]) -> Vec<String> {
    let mut told: Vec<(String, Option<&str>)> = table(cargo, "package")
        .into_iter()
        .filter(|(key, _)| *key == "rust-version")
        .map(|(_, value)| ("Cargo.toml's rust-version".to_string(), quoted(value)))
        .collect();
    for line in clippy.lines() {
        if let Some((key, value)) = line.split_once('=') {
            if key.trim() == "msrv" {
                told.push(("clippy.toml's msrv".to_string(), quoted(value)));
            }
        }
    }
    for (path, text) in sources {
        for (index, line) in text.lines().enumerate() {
            let line = line.trim_start();
            if line.starts_with("#![clippy::msrv") || line.starts_with("#[clippy::msrv") {
                let value = line.split_once('=').and_then(|(_, value)| quoted(value));
                told.push((format!("{}:{}", path.display(), index + 1), value));
            }
        }
    }
    told.into_iter()
        .filter(|(_, raw)| raw.and_then(version).is_none_or(|msrv| msrv < LINT_REASONS))
        .map(|(place, raw)| {
            format!("{place} tells clippy an MSRV of {raw:?}, older than lint reasons (1.81)")
        })
        .collect()
}

/// What keeps a clippy.toml from banning each of [`BANNED`] with a reason.
/// Its `disallowed-methods` list holds one entry per line.
fn ban_problems(clippy: &str) -> Vec<String> {
    let mut lines = clippy.lines().map(str::trim);
    let opened = lines.by_ref().any(|line| {
        line.split_once('=')
            .is_some_and(|(key, value)| key.trim() == "disallowed-methods" && value.trim() == "[")
    });
    if !opened {
        return vec!["clippy.toml has no `disallowed-methods = [` line opening the list".into()];
    }
    let entries: Vec<(&str, Option<&str>)> = lines
        .take_while(|line| !line.starts_with(']'))
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .map(|line| {
            let path = field(line, "path").or_else(|| quoted(line)).unwrap_or(line);
            (path, field(line, "reason"))
        })
        .collect();
    BANNED
        .iter()
        .filter_map(|banned| {
            let reason = entries
                .iter()
                .find(|(path, _)| path == banned)
                .and_then(|(_, reason)| *reason);
            reason
                .is_none_or(|reason| reason.trim().is_empty())
                .then(|| format!("clippy.toml must ban {banned} with a reason; it has {reason:?}"))
        })
        .collect()
}

/// Every inner allow, by place.
fn inner_allows(sources: &[Source]) -> Vec<String> {
    sources
        .iter()
        .flat_map(|(path, text)| {
            text.lines()
                .enumerate()
                .filter(|(_, line)| line.trim_start().starts_with("#![allow("))
                .map(move |(index, _)| format!("{}:{}", path.display(), index + 1))
        })
        .collect()
}

/// What sits inside the parenthesis that `rest` follows, up to its match.
fn inside_parens(rest: &str) -> Option<&str> {
    let mut depth = 1usize;
    for (at, c) in rest.char_indices() {
        match c {
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth == 0 {
                    return Some(&rest[..at]);
                }
            }
            _ => {}
        }
    }
    None
}

/// Every allow inside a `cfg_attr`, and every expect there without a reason,
/// by the place the attribute opens.
fn hidden_suppressions(sources: &[Source]) -> Vec<String> {
    let mut found = Vec::new();
    for (path, text) in sources {
        // Comment lines go blank, so prose about attributes is not read as
        // one and every line keeps its number.
        let code = text
            .lines()
            .map(|line| {
                if line.trim_start().starts_with("//") {
                    ""
                } else {
                    line
                }
            })
            .collect::<Vec<_>>()
            .join("\n");
        for (at, needle) in code.match_indices("cfg_attr(") {
            let before = &code[..at];
            if !(before.ends_with("#[") || before.ends_with("#![")) {
                continue;
            }
            let Some(body) = inside_parens(&code[at + needle.len()..]) else {
                continue;
            };
            let allow = body.contains("allow(");
            let unreasoned_expect = body.contains("expect(") && !body.contains("reason");
            if allow || unreasoned_expect {
                let line = before.matches('\n').count() + 1;
                found.push(format!("{}:{line}", path.display()));
            }
        }
    }
    found
}

/// The diagnostic log's two file names, put together here so this file holds
/// neither.
fn log_files() -> [String; 2] {
    [
        ["cerebro", "jsonl"].join("."),
        ["cerebro", "1", "jsonl"].join("."),
    ]
}

/// Every source that names one of the log's files, other than its owner.
fn log_readers(sources: &[Source]) -> Vec<String> {
    let names = log_files();
    sources
        .iter()
        .filter(|(path, _)| path != Path::new(LOG_OWNER))
        .filter(|(_, text)| names.iter().any(|name| text.contains(name.as_str())))
        .map(|(path, _)| path.display().to_string())
        .collect()
}

/// Every file under `dir` that `keep` accepts, sorted.
fn walk(dir: &Path, keep: fn(&Path) -> bool) -> Vec<PathBuf> {
    fn visit(dir: &Path, keep: fn(&Path) -> bool, found: &mut Vec<PathBuf>) {
        let entries =
            std::fs::read_dir(dir).unwrap_or_else(|e| panic!("reading {}: {e}", dir.display()));
        for entry in entries {
            let path = entry.expect("a directory entry").path();
            if path.is_dir() {
                visit(&path, keep, found);
            } else if keep(&path) {
                found.push(path);
            }
        }
    }
    let mut found = Vec::new();
    visit(dir, keep, &mut found);
    found.sort();
    found
}

/// Every `.rs` file under src/, sorted.
fn sources() -> Vec<Source> {
    let crate_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let sources: Vec<Source> = walk(&crate_dir.join("src"), |path| {
        path.extension().is_some_and(|ext| ext == "rs")
    })
    .into_iter()
    .map(|path| {
        let text = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("reading {}: {e}", path.display()));
        let within = path.strip_prefix(crate_dir).unwrap_or(&path).to_path_buf();
        (within, text)
    })
    .collect();
    // A walk that found nothing would pass every scan.
    for expected in ["src/lib.rs", "src/rails.rs"] {
        assert!(
            sources.iter().any(|(path, _)| path == Path::new(expected)),
            "the source walk missed {expected}"
        );
    }
    sources
}

/// Every file of the web app, under the repo's src/, by its path from this
/// crate (`../src/...`). A file that is not UTF-8 is read lossily.
fn web_sources() -> Vec<Source> {
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    let sources: Vec<Source> = walk(&repo.join("src"), |_| true)
        .into_iter()
        .map(|path| {
            let bytes =
                std::fs::read(&path).unwrap_or_else(|e| panic!("reading {}: {e}", path.display()));
            let within = Path::new("..").join(path.strip_prefix(&repo).unwrap_or(&path));
            (within, String::from_utf8_lossy(&bytes).into_owned())
        })
        .collect();
    assert!(
        sources
            .iter()
            .any(|(path, _)| path == Path::new("../src/main.tsx")),
        "the web walk missed src/main.tsx"
    );
    sources
}

/// `#[allow]` is refused and an expectation must say why, and no MSRV clippy
/// could be told switches either lint off.
#[test]
fn suppressions_are_reasoned_expectations() {
    let problems: Vec<String> = SUPPRESSION_LINTS
        .iter()
        .filter_map(|lint| undenied(CARGO_TOML, lint))
        .chain(msrv_problems(CARGO_TOML, CLIPPY_TOML, &sources()))
        .collect();
    assert!(problems.is_empty(), "{problems:#?}");
}

/// clippy.toml refuses a raw spawn and any change to this process's
/// environment, each entry with the reason clippy prints beside its refusal,
/// and Cargo.toml denies the lint that reads the list.
#[test]
fn spawns_and_env_mutation_are_banned_with_reasons() {
    let problems: Vec<String> = undenied(CARGO_TOML, "disallowed_methods")
        .into_iter()
        .chain(ban_problems(CLIPPY_TOML))
        .collect();
    assert!(problems.is_empty(), "{problems:#?}");
}

/// Nothing prints (M53.24): Cargo.toml denies both print lints, so a print
/// fails the gate unless it carries a reasoned expectation.
#[test]
fn nothing_prints() {
    let problems: Vec<String> = PRINT_LINTS
        .iter()
        .filter_map(|lint| undenied(CARGO_TOML, lint))
        .collect();
    assert!(problems.is_empty(), "{problems:#?}");
}

/// The diagnostic log has no reader (M53.24): only diagnostics.rs names its
/// files, so no other Rust file and nothing in the web app can open them.
/// Product logic that acted on the log would make it a third record (CV-06).
#[test]
fn the_log_has_no_reader() {
    let mut everything = sources();
    let names = log_files();
    assert!(
        everything.iter().any(|(path, text)| {
            path == Path::new(LOG_OWNER) && names.iter().all(|name| text.contains(name.as_str()))
        }),
        "{LOG_OWNER} must name both of the log's files, or this scan looks for the wrong ones"
    );
    everything.extend(web_sources());
    let readers = log_readers(&everything);
    assert!(
        readers.is_empty(),
        "only {LOG_OWNER} may name the diagnostic log's files: {readers:?}"
    );
}

/// No inner allow anywhere in src/: clippy's `allow_attributes` looks at
/// outer attributes only, so that is the one spelling of `allow` it lets by.
#[test]
fn no_inner_allow_slips_past() {
    let found = inner_allows(&sources());
    assert!(
        found.is_empty(),
        "an inner allow gets past clippy's allow_attributes; make it an inner \
         expect with a reason: {found:?}"
    );
}

/// No `allow` inside a `cfg_attr`, and no `expect` there without a reason.
/// Clippy lints such an attribute only on a build whose cfg holds, so one
/// behind a platform or release cfg would never meet either lint here.
#[test]
fn no_suppression_hides_in_a_cfg_attr() {
    let found = hidden_suppressions(&sources());
    assert!(
        found.is_empty(),
        "a suppression inside cfg_attr meets clippy only where its cfg holds; \
         write it as a reasoned expect that every build sees: {found:?}"
    );
}

/// Each reader above, handed what it exists to refuse, refuses it: a reader
/// that lost its input would otherwise pass the real tree without a word.
#[test]
fn every_reader_refuses_what_it_guards_against() {
    let cargo = [
        "[package]",
        "rust-version = \"1.80\"",
        "",
        "[lints.clippy]",
        "allow_attributes = \"warn\"",
        "allow_attributes_without_reason = { level = \"deny\", priority = 1 }",
    ]
    .join("\n");
    assert!(undenied(&cargo, "allow_attributes").is_some());
    assert_eq!(undenied(&cargo, "allow_attributes_without_reason"), None);
    assert!(undenied(&cargo, "disallowed_methods").is_some());
    assert!(undenied(&cargo, "print_stdout").is_some());

    let clippy = [
        "msrv = \"1.70\"",
        "disallowed-methods = [",
        "    { path = \"std::process::Command::new\" },",
        "    \"std::env::set_var\",",
        "    { path = \"std::env::remove_var\", reason = \"set it on the Command\" },",
        "]",
    ]
    .join("\n");
    let bans = ban_problems(&clippy);
    assert_eq!(bans.len(), 2, "{bans:#?}");
    assert!(bans[0].contains("std::process::Command::new"), "{bans:#?}");
    assert!(bans[1].contains("std::env::set_var"), "{bans:#?}");
    assert_eq!(ban_problems("").len(), 1);

    // `@` stands in for `#`, so this file's own scans do not read the probe
    // as attributes.
    let probe = [
        "mod m {",
        "    @![allow(dead_code)]",
        "}",
        "@![clippy::msrv = \"1.79\"]",
        "@[cfg_attr(",
        "    windows,",
        "    allow(dead_code)",
        ")]",
        "fn a() {}",
        "@[cfg_attr(test, expect(dead_code))]",
        "fn b() {}",
        "@[cfg_attr(test, expect(dead_code, reason = \"r\"))]",
        "fn c() {}",
        "// @[cfg_attr(test, allow(dead_code))] is prose, not an attribute",
    ]
    .join("\n")
    .replace('@', "#");
    let probe = [(PathBuf::from("src/probe.rs"), probe)];
    let old = msrv_problems(&cargo, &clippy, &probe);
    assert_eq!(old.len(), 3, "{old:#?}");
    for (problem, place) in old.iter().zip([
        "Cargo.toml's rust-version",
        "clippy.toml's msrv",
        "src/probe.rs:4",
    ]) {
        assert!(problem.starts_with(place), "{problem}");
    }
    assert_eq!(
        msrv_problems("[package]\nrust-version = \"1.81\"\n", "", &[]),
        Vec::<String>::new()
    );
    assert_eq!(inner_allows(&probe), ["src/probe.rs:2"]);
    assert_eq!(
        hidden_suppressions(&probe),
        ["src/probe.rs:5", "src/probe.rs:10"]
    );

    let [current, previous] = log_files();
    let mentions = [
        (PathBuf::from(LOG_OWNER), current.clone()),
        (PathBuf::from("src/probe.rs"), format!("read {previous}")),
        (
            PathBuf::from("../src/lib/probe.ts"),
            format!("open('{current}')"),
        ),
        (PathBuf::from("src/quiet.rs"), "logs/".to_string()),
    ];
    assert_eq!(
        log_readers(&mentions),
        ["src/probe.rs", "../src/lib/probe.ts"]
    );
}
