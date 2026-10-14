//! What a run may ask Claude Code for (M56.5): `shared/policy/run-options.v1.json`.
//!
//! A run names a model and an effort, from an Agent record or from the
//! conversation the person is in. Both reach the CLI's argv, and Claude Code
//! 2.1.250 takes an effort it does not know with a warning and an exit code
//! of 0, so a request it ignored would run at the default without a word.
//! Rust is where that is refused: `run_agent` and `tool_hand_to` check before
//! any token, lease or row exists, and `spawn_run` checks again before
//! admission, so no spawn path is left unchecked.
//!
//! The vocabulary lives once, in the artifact. `src/engine/runOptions.ts`
//! imports the same bytes, and both languages replay its `cases`, so the
//! picker that offers a value and the gate that refuses one cannot disagree.

use serde::Deserialize;

use super::AgentRequest;

/// The rule, compiled in. The TypeScript side holds no copy of it.
const RUN_OPTIONS: &str = include_str!("../../../shared/policy/run-options.v1.json");

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Artifact {
    format: u32,
    #[serde(rename = "rule")]
    _rule: String,
    #[serde(rename = "cli_version")]
    _cli_version: String,
    effort_levels: Vec<Labelled>,
    model: ModelShape,
    model_suggestions: Vec<Labelled>,
    value_chars: usize,
    messages: Messages,
    #[serde(rename = "cases")]
    _cases: Vec<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Labelled {
    id: String,
    #[serde(rename = "label")]
    _label: String,
}

/// The model-name shape: what keeps a vault-authored value one name, and
/// never a flag, a second argument or a control character.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ModelShape {
    max_chars: usize,
    first: First,
    also: String,
}

/// What a model name may start with. One spelling, so an artifact that
/// names another fails the parse rather than meaning something new.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
enum First {
    Alnum,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Messages {
    effort: String,
    model: String,
}

fn artifact() -> &'static Artifact {
    static RULE: std::sync::OnceLock<Artifact> = std::sync::OnceLock::new();
    RULE.get_or_init(|| parse(RUN_OPTIONS).expect("run-options.v1.json parses"))
}

fn parse(text: &str) -> Result<Artifact, String> {
    let artifact: Artifact = serde_json::from_str(text).map_err(|e| e.to_string())?;
    if artifact.format != 1 {
        return Err(format!("run-options format {} is not 1", artifact.format));
    }
    Ok(artifact)
}

/// A value nobody set: absent, or nothing but whitespace.
fn unset(value: Option<&str>) -> Option<&str> {
    value.filter(|v| !v.trim().is_empty())
}

/// The value as a refusal prints it: cut to `value_chars` characters, then
/// JSON-quoted, so a newline or a quote reads as itself and cannot end the
/// sentence it sits in. `JSON.stringify` gives the same bytes in TS.
fn quoted(value: &str) -> String {
    let limit = artifact().value_chars;
    let cut: String = if value.chars().count() > limit {
        value
            .chars()
            .take(limit)
            .chain(std::iter::once('…'))
            .collect()
    } else {
        value.to_string()
    };
    serde_json::to_string(&cut).unwrap_or_else(|_| "\"\"".into())
}

/// `a, b, c or d`: how the effort message lists the levels.
fn spoken_list(ids: &[&str]) -> String {
    match ids.split_last() {
        None => String::new(),
        Some((last, [])) => (*last).to_string(),
        Some((last, rest)) => format!("{} or {last}", rest.join(", ")),
    }
}

fn effort_message(value: &str) -> String {
    let a = artifact();
    let levels: Vec<&str> = a.effort_levels.iter().map(|l| l.id.as_str()).collect();
    a.messages
        .effort
        .replace("{levels}", &spoken_list(&levels))
        .replace("{value}", &quoted(value))
}

fn model_message(value: &str) -> String {
    let a = artifact();
    let aliases: Vec<&str> = a.model_suggestions.iter().map(|s| s.id.as_str()).collect();
    a.messages
        .model
        .replace("{aliases}", &aliases.join(", "))
        .replace("{value}", &quoted(value))
}

/// Whether `value` has the model-name shape. Says nothing about whether the
/// account can use it: a name the API refuses comes back as M56.4's
/// `model_unavailable` card.
fn is_model_name(value: &str) -> bool {
    let shape = &artifact().model;
    let mut chars = value.chars();
    let starts = match (chars.next(), &shape.first) {
        (Some(c), First::Alnum) => c.is_ascii_alphanumeric(),
        (None, _) => false,
    };
    starts
        && value.chars().count() <= shape.max_chars
        && chars.all(|c| c.is_ascii_alphanumeric() || shape.also.contains(c))
}

/// Refuse an effort Claude Code does not take. Absent or blank is unset,
/// which is always valid: no flag, and Claude Code's default.
pub fn validate_effort(value: Option<&str>) -> Result<(), String> {
    match unset(value) {
        None => Ok(()),
        Some(v) if artifact().effort_levels.iter().any(|l| l.id == v) => Ok(()),
        Some(v) => Err(effort_message(v)),
    }
}

/// Refuse a value that is not a model name. Absent or blank is unset.
pub fn validate_model(value: Option<&str>) -> Result<(), String> {
    match unset(value) {
        None => Ok(()),
        Some(v) if is_model_name(v) => Ok(()),
        Some(v) => Err(model_message(v)),
    }
}

/// Both of a request's choices, in argv order.
pub fn validate_request(req: &AgentRequest) -> Result<(), String> {
    validate_model(req.model.as_deref())?;
    validate_effort(req.effort.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn cases() -> Vec<Value> {
        let doc: Value = serde_json::from_str(RUN_OPTIONS).unwrap();
        doc["cases"].as_array().unwrap().clone()
    }

    #[test]
    fn replays_the_shared_cases() {
        let all = cases();
        assert!(all.len() > 20, "the artifact holds its cases");
        for case in all {
            let value = case["value"].as_str();
            let result = match case["field"].as_str().unwrap() {
                "effort" => validate_effort(value),
                "model" => validate_model(value),
                other => panic!("a case for an unknown field {other}"),
            };
            match case["verdict"].as_str().unwrap() {
                "unset" => {
                    assert!(result.is_ok(), "{case}");
                    assert!(unset(value).is_none(), "{case}: reads as unset");
                }
                "valid" => assert!(result.is_ok(), "{case}: {result:?}"),
                "refused" => {
                    let message = result.expect_err(&case.to_string());
                    if let Some(expected) = case["message"].as_str() {
                        assert_eq!(message, expected, "{case}");
                    }
                }
                other => panic!("an unknown verdict {other}"),
            }
        }
    }

    #[test]
    fn the_artifact_refuses_unknown_fields() {
        assert!(parse(RUN_OPTIONS).is_ok());
        let mut doc: Value = serde_json::from_str(RUN_OPTIONS).unwrap();
        doc["levels"] = Value::from("everything");
        assert!(
            parse(&doc.to_string()).is_err(),
            "a top-level key it does not know"
        );
        let mut doc: Value = serde_json::from_str(RUN_OPTIONS).unwrap();
        doc["effort_levels"][0]["models"] = Value::from("all");
        assert!(
            parse(&doc.to_string()).is_err(),
            "a level key it does not know"
        );
        let mut doc: Value = serde_json::from_str(RUN_OPTIONS).unwrap();
        doc["model"]["first"] = Value::from("anything");
        assert!(
            parse(&doc.to_string()).is_err(),
            "a first rule it cannot read"
        );
        let mut doc: Value = serde_json::from_str(RUN_OPTIONS).unwrap();
        doc["format"] = Value::from(2);
        assert!(parse(&doc.to_string()).is_err(), "another format");
    }

    #[test]
    fn an_unknown_effort_names_the_levels() {
        let message = validate_effort(Some("turbo")).unwrap_err();
        assert_eq!(
            message,
            "effort \"turbo\" is not one Claude Code accepts — use low, medium, high, xhigh or \
             max, or remove it for Claude Code's default. Nothing was started."
        );
        for level in &artifact().effort_levels {
            assert!(message.contains(&level.id), "{}", level.id);
            assert!(validate_effort(Some(&level.id)).is_ok());
        }
    }

    #[test]
    fn a_model_read_as_a_flag_is_refused() {
        for flag in ["-x", "--dangerously-skip-permissions", "--model=opus"] {
            let message = validate_model(Some(flag)).unwrap_err();
            assert!(
                message.starts_with(&format!("model \"{flag}\"")),
                "{message}"
            );
            assert!(message.contains("fable, opus, sonnet, haiku"), "{message}");
        }
        let mut req = test_request();
        req.model = Some("opus".into());
        req.effort = Some("--max".into());
        assert!(validate_request(&req).unwrap_err().starts_with("effort"));
        req.model = Some("-p".into());
        assert!(validate_request(&req).unwrap_err().starts_with("model"));
        req.model = None;
        req.effort = Some("  ".into());
        assert!(validate_request(&req).is_ok(), "blank is unset");
    }

    fn test_request() -> AgentRequest {
        serde_json::from_value(serde_json::json!({ "message": "hi" })).unwrap()
    }
}
