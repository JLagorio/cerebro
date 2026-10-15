//! AskUserQuestion's questions and answers (M57.3), pure.
//!
//! Claude Code 2.1.250's tool (its `sdk-tools.d.ts`): 1 to 4 questions,
//! each with a header, 2 to 4 options `{label, description, preview?}` and
//! `multiSelect`; Claude Code offers Other itself. The answer goes back as
//! the call's own input with `answers` set, mapping each question's text to
//! a string (`updated_input`), which the gate's allow carries (F9, derived
//! from the bundle; live run owed). A multi-select answer joins its values
//! as 2.1.250 joins them (`join`).
//!
//! These rules have a twin in `src/engine/questionForm.ts`, and
//! `src-tauri/fixtures/question-answers.json` holds the two together: both
//! replay its parse and answer cases, refusal for refusal, word for word
//! (D3 (a)). Cerebro checks an answer's membership and counts, nothing
//! more: what a person types under Other is theirs to say.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// The most a person may type under Other, in characters, once cleaned.
pub const OTHER_CHARS: usize = 2000;

/// One option a question offers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct QuestionOption {
    pub label: String,
    pub description: String,
    /// Agent-written text a card shows as text, never as markup.
    pub preview: Option<String>,
}

/// One question, as a card draws it. Field names follow the tool's input.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Question {
    pub question: String,
    /// The chip above the question; one over 12 characters is kept, and the
    /// card clips it.
    pub header: String,
    pub options: Vec<QuestionOption>,
    #[serde(rename = "multiSelect")]
    pub multi_select: bool,
}

/// A person's answer to one question, as the webview sends it: the labels
/// they picked, and what they typed under Other, if they chose it.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct QuestionAnswer {
    pub question: String,
    #[serde(default)]
    pub picked: Vec<String>,
    #[serde(default)]
    pub other: Option<String>,
}

fn text_of<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or_default()
}

/// The questions a call asks, or why a card cannot show them: 1 to 4
/// questions, each with text, no two alike, each offering 2 to 4 options
/// with labels, no two alike. A header or description that is not text
/// reads empty, a preview that is not text reads absent, and `multiSelect`
/// is true only when it is `true`. Unknown keys, and any `answers`,
/// `annotations` or `metadata` the call already holds, are ignored.
pub fn parse_questions(input: &Value) -> Result<Vec<Question>, String> {
    let list = input
        .get("questions")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    if !(1..=4).contains(&list.len()) {
        return Err(format!(
            "A question set holds 1 to 4 questions; this one holds {}.",
            list.len()
        ));
    }
    let mut set: Vec<Question> = Vec::new();
    for item in list {
        let text = text_of(item, "question");
        if text.trim().is_empty() {
            return Err("A question has no text.".into());
        }
        if set.iter().any(|q| q.question == text) {
            return Err(format!("Two questions read \"{text}\"."));
        }
        let offered = item
            .get("options")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default();
        if !(2..=4).contains(&offered.len()) {
            return Err(format!(
                "\"{text}\" offers {} options; a question offers 2 to 4.",
                offered.len()
            ));
        }
        let mut options: Vec<QuestionOption> = Vec::new();
        for option in offered {
            let label = text_of(option, "label");
            if label.trim().is_empty() {
                return Err(format!("\"{text}\" offers an option with no label."));
            }
            if options.iter().any(|o| o.label == label) {
                return Err(format!("\"{text}\" offers \"{label}\" twice."));
            }
            options.push(QuestionOption {
                label: label.to_string(),
                description: text_of(option, "description").to_string(),
                preview: option
                    .get("preview")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            });
        }
        set.push(Question {
            question: text.to_string(),
            header: text_of(item, "header").to_string(),
            options,
            multi_select: item.get("multiSelect").and_then(Value::as_bool) == Some(true),
        });
    }
    Ok(set)
}

/// Other's text, cleaned: control characters (C0, DEL, C1) become spaces,
/// and the ends are trimmed.
fn clean(raw: &str) -> String {
    raw.chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect::<String>()
        .trim()
        .to_string()
}

/// A multi-select answer's values joined as Claude Code 2.1.250 joins them:
/// a value holding `, ` or a double quote becomes its JSON string, and `, `
/// joins them all.
pub fn join(values: &[String]) -> String {
    values
        .iter()
        .map(|value| {
            if value.contains(", ") || value.contains('"') {
                serde_json::to_string(value).expect("a string serializes")
            } else {
                value.clone()
            }
        })
        .collect::<Vec<_>>()
        .join(", ")
}

/// The `answers` map for `set` from a person's answers, in the set's order,
/// or why it cannot be sent. Membership and counts only: every question
/// answered once, by its exact text; every pick one of its options, at most
/// once; a single-select question takes one value, a multi-select at least
/// one; Other is a value once cleaned, at most OTHER_CHARS characters, and
/// follows the picks. A single answer is its value; a multi-select one is
/// its values joined (`join`).
pub fn answers_for(
    set: &[Question],
    answers: &[QuestionAnswer],
) -> Result<Map<String, Value>, String> {
    if let Some(stray) = answers
        .iter()
        .find(|a| !set.iter().any(|q| q.question == a.question))
    {
        return Err(format!("No question reads \"{}\".", stray.question));
    }
    let mut map = Map::new();
    for question in set {
        let q = question.question.as_str();
        let mine: Vec<&QuestionAnswer> = answers.iter().filter(|a| a.question == q).collect();
        let answer = match mine.as_slice() {
            [] => return Err(format!("Answer every question: \"{q}\" has no answer.")),
            [one] => *one,
            _ => return Err(format!("\"{q}\" is answered twice.")),
        };
        let mut seen: Vec<&str> = Vec::new();
        for label in &answer.picked {
            if !question.options.iter().any(|o| &o.label == label) {
                return Err(format!("\"{label}\" is not an option of \"{q}\"."));
            }
            if seen.contains(&label.as_str()) {
                return Err(format!("\"{label}\" is picked twice for \"{q}\"."));
            }
            seen.push(label);
        }
        let other = answer.other.as_deref().map(clean);
        if other
            .as_deref()
            .is_some_and(|text| text.chars().count() > OTHER_CHARS)
        {
            return Err(format!(
                "Your answer for \"{q}\" is over {OTHER_CHARS} characters."
            ));
        }
        let mut values = answer.picked.clone();
        values.extend(other.clone().filter(|text| !text.is_empty()));
        if values.is_empty() {
            return Err(match other {
                Some(_) => format!("Type your answer for \"{q}\", or pick an option."),
                None => format!("Answer every question: \"{q}\" has no answer."),
            });
        }
        if !question.multi_select && values.len() > 1 {
            return Err(format!("\"{q}\" takes one answer."));
        }
        let value = if question.multi_select {
            join(&values)
        } else {
            values.remove(0)
        };
        map.insert(q.to_string(), Value::String(value));
    }
    Ok(map)
}

/// What the gate's allow hands Claude Code: the call's own input with
/// `answers` set and `annotations` left out. Every other key, `questions`
/// among them, stays as the agent wrote it.
pub fn updated_input(raw: &Value, answers: Map<String, Value>) -> Value {
    let mut out = Map::new();
    if let Some(object) = raw.as_object() {
        for (key, value) in object {
            if key != "answers" && key != "annotations" {
                out.insert(key.clone(), value.clone());
            }
        }
    }
    out.insert("answers".into(), Value::Object(answers));
    Value::Object(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const CASES: &str = include_str!("../../fixtures/question-answers.json");

    fn cases() -> Value {
        serde_json::from_str(CASES).expect("question-answers.json parses")
    }

    fn answers_of(value: &Value) -> Vec<QuestionAnswer> {
        serde_json::from_value(value.clone()).expect("a case's answers deserialize")
    }

    fn two_questions() -> Value {
        json!({ "questions": [
            { "question": "Which format?", "header": "Format", "multiSelect": false,
              "options": [ { "label": "Markdown", "description": "" },
                           { "label": "Plain text", "description": "" } ] },
            { "question": "Which sections?", "header": "Sections", "multiSelect": true,
              "options": [ { "label": "Summary", "description": "" },
                           { "label": "Risks", "description": "" },
                           { "label": "Next steps", "description": "" } ] }
        ] })
    }

    fn pick(question: &str, picked: &[&str], other: Option<&str>) -> QuestionAnswer {
        QuestionAnswer {
            question: question.into(),
            picked: picked.iter().map(|p| p.to_string()).collect(),
            other: other.map(str::to_string),
        }
    }

    #[test]
    fn replays_the_shared_question_cases() {
        let cases = cases();
        assert_eq!(cases["format"], 1);
        assert_eq!(
            cases["cli_version"], "2.1.250",
            "the pin the join rule was read from"
        );
        let parse = cases["parse_cases"].as_array().unwrap();
        assert!(parse.len() >= 8);
        for case in parse {
            let why = case["why"].as_str().unwrap();
            match parse_questions(&case["input"]) {
                Ok(set) => assert_eq!(
                    serde_json::to_value(&set).unwrap(),
                    case["questions"],
                    "{why}"
                ),
                Err(refused) => assert_eq!(json!(refused), case["refused"], "{why}"),
            }
        }
        let answer = cases["answer_cases"].as_array().unwrap();
        assert!(answer.len() >= 10);
        for case in answer {
            let why = case["why"].as_str().unwrap();
            let set = parse_questions(&case["input"]).expect(why);
            match answers_for(&set, &answers_of(&case["answers"])) {
                Ok(map) => assert_eq!(Value::Object(map), case["expected"], "{why}"),
                Err(refused) => assert_eq!(json!(refused), case["refused"], "{why}"),
            }
        }
    }

    #[test]
    fn a_multi_answer_joins_as_claude_code_joins() {
        let values = [
            "Plain".to_string(),
            "Summary, then risks".to_string(),
            "The \"short\" one".to_string(),
        ];
        assert_eq!(
            join(&values),
            r#"Plain, "Summary, then risks", "The \"short\" one""#
        );
        let set = parse_questions(&two_questions()).unwrap();
        let map = answers_for(
            &set,
            &[
                pick("Which format?", &["Markdown"], None),
                pick("Which sections?", &["Summary", "Risks"], None),
            ],
        )
        .unwrap();
        assert_eq!(map["Which format?"], "Markdown");
        assert_eq!(map["Which sections?"], "Summary, Risks");
    }

    #[test]
    fn other_is_the_value_and_counts_as_an_answer() {
        let set = parse_questions(&two_questions()).unwrap();
        let map = answers_for(
            &set,
            &[
                pick("Which format?", &[], Some("  HTML\u{7}please \n")),
                pick("Which sections?", &["Risks"], Some("Owners")),
            ],
        )
        .unwrap();
        assert_eq!(map["Which format?"], "HTML please");
        assert_eq!(
            map["Which sections?"], "Risks, Owners",
            "Other follows the picks"
        );
        // A pick and Other on a single-select question are two answers.
        assert_eq!(
            answers_for(
                &set,
                &[
                    pick("Which format?", &["Markdown"], Some("HTML")),
                    pick("Which sections?", &["Risks"], None),
                ]
            )
            .unwrap_err(),
            "\"Which format?\" takes one answer."
        );
    }

    #[test]
    fn the_updated_input_keeps_the_questions_byte_for_byte() {
        let raw = two_questions();
        let set = parse_questions(&raw).unwrap();
        let map = answers_for(
            &set,
            &[
                pick("Which format?", &["Plain text"], None),
                pick("Which sections?", &["Next steps"], None),
            ],
        )
        .unwrap();
        let out = updated_input(&raw, map);
        assert_eq!(
            serde_json::to_string(&out["questions"]).unwrap(),
            serde_json::to_string(&raw["questions"]).unwrap()
        );
        assert_eq!(
            out["answers"],
            json!({ "Which format?": "Plain text", "Which sections?": "Next steps" })
        );
    }

    #[test]
    fn stray_answers_and_annotations_are_ignored_for_asking() {
        let mut raw = two_questions();
        raw["answers"] = json!({ "Which format?": "Markdown" });
        raw["annotations"] = json!({ "Which format?": { "notes": "from the agent" } });
        raw["metadata"] = json!({ "source": "agent" });
        assert_eq!(
            parse_questions(&raw).unwrap(),
            parse_questions(&two_questions()).unwrap()
        );
        let set = parse_questions(&raw).unwrap();
        let map = answers_for(
            &set,
            &[
                pick("Which format?", &["Plain text"], None),
                pick("Which sections?", &["Summary"], None),
            ],
        )
        .unwrap();
        let out = updated_input(&raw, map);
        assert_eq!(
            out["answers"]["Which format?"], "Plain text",
            "the person's, not the agent's"
        );
        assert!(out.get("annotations").is_none());
        assert_eq!(out["metadata"], raw["metadata"]);
    }
}
