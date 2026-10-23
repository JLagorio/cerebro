//! The sweep over real recordings (M56.2, test-only).
//!
//! `fixtures/cli-stream/real/` holds Claude Code runs as the CLI wrote them,
//! brought in only through `scripts/cli-record/sanitize.ts`: each one a
//! `<name>.stream.jsonl`, its `<name>.meta.json`, and the run's session file
//! as `<name>.session.jsonl` where the run wrote one. Every recording there is
//! found when the tests run, with nothing to register, so a new recording is
//! swept the moment it lands.
//!
//! The sweep is how a CLI format change becomes a failing test: a kind a
//! recording shows, in its stream or its session file, that
//! `kinds::STREAM_KINDS` neither translates nor ignores fails it, the fold
//! (M56.3) must classify every real line, and a one-turn recording's stream
//! and session file must fold to the same content.

use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::Value;

use super::fold::{self, LineClass, TranscriptFold};
use super::kinds;

/// The corpus is at least this big (the M56.2 plan's floor).
const MIN_RECORDINGS: usize = 8;

/// A recording's meta file, as the sanitizer writes it. Unknown fields are
/// refused, so a field the sanitizer adds is a field this reads.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Meta {
    format: u32,
    cli_version: String,
    /// spike, scripted or app: what made the run.
    source: String,
    /// live, or derived: written in the recorded shape from the CLI's own
    /// code, and owed a live run.
    recorded: String,
    #[serde(default)]
    derived_from: Option<Vec<String>>,
    transport: String,
    scenario: String,
    proves: String,
    /// result, killed, deferred or refused.
    ends: String,
    /// The session file's synthetic name, when the run wrote one.
    session: Option<String>,
    sanitizer: u32,
}

struct Recording {
    name: String,
    /// Every stream line with its 1-based line number.
    stream: Vec<(usize, Value)>,
    session: Option<Vec<(usize, Value)>>,
    meta: Meta,
}

fn real_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/cli-stream/real")
}

/// Every non-empty line of `path`, parsed; a line that does not parse panics
/// with its file and number.
fn lines(path: &Path) -> Vec<(usize, Value)> {
    let text = std::fs::read_to_string(path)
        .unwrap_or_else(|error| panic!("{} is unreadable: {error}", path.display()));
    text.lines()
        .enumerate()
        .filter(|(_, line)| !line.trim().is_empty())
        .map(|(at, line)| {
            let value = serde_json::from_str(line).unwrap_or_else(|error| {
                panic!("{}:{} does not parse: {error}", path.display(), at + 1)
            });
            (at + 1, value)
        })
        .collect()
}

/// Every recording under `real/`, by name.
fn recordings() -> Vec<Recording> {
    let dir = real_dir();
    let mut names: Vec<String> = std::fs::read_dir(&dir)
        .unwrap_or_else(|error| panic!("{} is unreadable: {error}", dir.display()))
        .filter_map(Result::ok)
        .filter_map(|entry| {
            entry
                .file_name()
                .to_str()?
                .strip_suffix(".stream.jsonl")
                .map(str::to_string)
        })
        .collect();
    names.sort();
    names
        .into_iter()
        .map(|name| {
            let meta_path = dir.join(format!("{name}.meta.json"));
            let meta: Meta = serde_json::from_str(
                &std::fs::read_to_string(&meta_path)
                    .unwrap_or_else(|error| panic!("{name} has no meta: {error}")),
            )
            .unwrap_or_else(|error| panic!("{name}'s meta does not read: {error}"));
            let session_path = dir.join(format!("{name}.session.jsonl"));
            Recording {
                stream: lines(&dir.join(format!("{name}.stream.jsonl"))),
                session: session_path.exists().then(|| lines(&session_path)),
                meta,
                name,
            }
        })
        .collect()
}

fn is_type(line: &Value, kind: &str) -> bool {
    line.get("type").and_then(Value::as_str) == Some(kind)
}

#[test]
fn every_real_recording_shows_only_classified_kinds() {
    let mut unclassified = Vec::new();
    for recording in recordings() {
        for (at, line) in &recording.stream {
            for kind in kinds::unclassified(line) {
                unclassified.push(format!("{}.stream.jsonl:{at}: {kind}", recording.name));
            }
        }
    }
    assert!(
        unclassified.is_empty(),
        "give each kind a row in kinds::STREAM_KINDS, translated or ignored with its reason: \
         {unclassified:#?}"
    );
}

#[test]
fn every_real_stream_and_session_file_folds_with_no_unclassified_line() {
    let mut unclassified = Vec::new();
    for recording in recordings() {
        let files = [
            ("stream", Some(&recording.stream)),
            ("session", recording.session.as_ref()),
        ];
        for (format, lines) in files {
            let Some(lines) = lines else { continue };
            let mut fold = TranscriptFold::default();
            for (at, line) in lines {
                if let (LineClass::Unclassified(kind), _) = fold.entry(line) {
                    unclassified.push(format!("{}.{format}.jsonl:{at}: {kind}", recording.name));
                }
                // The fold and the table agree: a line the table fully lists
                // is never unclassified by the fold.
            }
        }
    }
    assert!(
        unclassified.is_empty(),
        "give each kind an arm in the fold and a row in kinds::STREAM_KINDS: {unclassified:#?}"
    );
}

#[test]
fn a_one_turn_recording_folds_to_the_same_content_from_both_formats() {
    let mut compared = 0;
    for recording in recordings() {
        let Some(session) = &recording.session else {
            continue;
        };
        let values = |lines: &[(usize, Value)]| -> Vec<Value> {
            lines.iter().map(|(_, line)| line.clone()).collect()
        };
        let from_file = fold::turn_content(&fold::fold_lines(&values(session)).events);
        let from_stream = fold::turn_content(&fold::fold_lines(&values(&recording.stream)).events);
        // A session that spans several turns (a resume, the stream-json
        // transport) is the goldens' case, where each turn's stream is known.
        if from_file.len() != 1 || from_stream.len() != 1 {
            continue;
        }
        fold::assert_same_turn(&recording.name, &from_stream[0], &from_file[0]);
        compared += 1;
    }
    assert!(
        compared >= 6,
        "only {compared} one-turn recordings compared"
    );
}

#[test]
fn every_real_line_parses() {
    for recording in recordings() {
        assert!(
            !recording.stream.is_empty(),
            "{} has an empty stream",
            recording.name
        );
        if let Some(session) = &recording.session {
            assert!(
                !session.is_empty(),
                "{} has an empty session file",
                recording.name
            );
        }
    }
}

#[test]
fn every_real_recording_has_a_meta_that_names_its_cli_version() {
    for Recording {
        name,
        stream,
        session,
        meta,
    } in recordings()
    {
        assert_eq!((meta.format, meta.sanitizer), (1, 1), "{name}");
        assert!(
            ["spike", "scripted", "app"].contains(&meta.source.as_str()),
            "{name}: source {}",
            meta.source
        );
        assert!(
            ["per-turn", "stream-json-input"].contains(&meta.transport.as_str()),
            "{name}: transport {}",
            meta.transport
        );
        assert!(
            ["result", "killed", "deferred", "refused"].contains(&meta.ends.as_str()),
            "{name}: ends {}",
            meta.ends
        );
        match meta.recorded.as_str() {
            "live" => assert!(
                meta.derived_from.is_none(),
                "{name}: live, so derived from nothing"
            ),
            "derived" => assert!(
                meta.derived_from
                    .as_ref()
                    .is_some_and(|from| !from.is_empty()),
                "{name}: a derived recording names what it was derived from"
            ),
            other => panic!("{name}: recorded {other}"),
        }
        assert!(
            !meta.scenario.is_empty() && !meta.proves.is_empty(),
            "{name}"
        );
        assert_eq!(
            meta.session.is_some(),
            session.is_some(),
            "{name}: the meta names a session file exactly when one is committed"
        );
        let inits: Vec<&Value> = stream
            .iter()
            .map(|(_, line)| line)
            .filter(|line| is_type(line, "system") && line["subtype"] == "init")
            .collect();
        assert!(!inits.is_empty(), "{name} shows no init");
        for init in inits {
            assert_eq!(
                init["claude_code_version"].as_str(),
                Some(meta.cli_version.as_str()),
                "{name}: every init names the meta's CLI version"
            );
        }
    }
}

#[test]
fn a_recording_without_a_result_says_how_it_ended() {
    for recording in recordings() {
        let has_result = recording
            .stream
            .iter()
            .any(|(_, line)| is_type(line, "result"));
        if has_result {
            continue;
        }
        assert!(
            ["killed", "deferred", "refused"].contains(&recording.meta.ends.as_str()),
            "{} has no result, so its meta says how it ended, not {}",
            recording.name,
            recording.meta.ends
        );
    }
}

#[test]
fn the_real_corpus_holds_at_least_eight_recordings() {
    let found = recordings().len();
    assert!(
        found >= MIN_RECORDINGS,
        "{found} recordings under real/, at least {MIN_RECORDINGS} wanted"
    );
}

#[test]
fn the_deferred_recording_folds_to_its_suspension_from_both_formats() {
    // M57.1. The spike's defer run (derived until the owner's login records
    // it): its result names the held call, so the stream folds to that call
    // deferred and nothing after, and the session file agrees, whether it
    // holds the hook's marker (a recorded run) or only the unanswered call.
    let recording = recordings()
        .into_iter()
        .find(|recording| recording.name == "spike-defer")
        .expect("the spike's defer run is under real/");
    assert_eq!(recording.meta.ends, "deferred");
    let values = |lines: &[(usize, Value)]| -> Vec<Value> {
        lines.iter().map(|(_, line)| line.clone()).collect()
    };
    let stream = fold::fold_lines(&values(&recording.stream));
    let session = fold::fold_lines(&values(recording.session.as_ref().unwrap()));
    assert!(
        stream.classes.unclassified.is_empty(),
        "{:?}",
        stream.classes
    );
    assert!(
        session.classes.unclassified.is_empty(),
        "{:?}",
        session.classes
    );
    let Some(super::AgentEvent::ToolDeferred {
        tool_id, tool_name, ..
    }) = stream.events.last()
    else {
        panic!("the stream ends suspended: {:?}", stream.events);
    };
    assert_eq!(tool_name, "mcp__probe__slow_echo");
    assert!(!stream.events.iter().any(|event| matches!(
        event,
        super::AgentEvent::Result { .. } | super::AgentEvent::TurnEnded { .. }
    )));
    let from_stream = fold::turn_content(&stream.events);
    let from_file = fold::turn_content(&session.events);
    assert_eq!((from_stream.len(), from_file.len()), (1, 1));
    fold::assert_same_turn(&recording.name, &from_stream[0], &from_file[0]);
    assert!(session.events.iter().any(|event| matches!(
        event,
        super::AgentEvent::ToolStart { tool_id: id, .. } if id == tool_id
    )));
}
