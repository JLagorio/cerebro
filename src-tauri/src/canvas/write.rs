//! The JSON Canvas writer: the same layout and retained raw values as scene/jsonCanvas.ts.
use indexmap::IndexMap;
use serde_json::{value::RawValue, Value};

use super::{
    format::table,
    read::{Fields, ReadBoard},
};

type Pairs = IndexMap<String, String>;
fn quote(text: &str) -> String {
    serde_json::to_string(text).expect("valid Unicode serializes")
}
/// Remove only JSON whitespace outside strings, never interpreting an unknown
/// number, escaped surrogate, duplicate member or escape spelling.
fn minify(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut string = false;
    let mut escape = false;
    for c in raw.chars() {
        if string {
            out.push(c);
            if escape {
                escape = false;
            } else if c == '\\' {
                escape = true;
            } else if c == '"' {
                string = false;
            }
        } else if c == '"' {
            string = true;
            out.push(c);
        } else if !matches!(c, ' ' | '\t' | '\r' | '\n') {
            out.push(c);
        }
    }
    out
}
fn normalized(raw: &RawValue) -> String {
    // Every known field was validated by the reader. Integers need this arm
    // because serde_json preserves negative-zero as a float when read as Value.
    if let Ok(number) = raw.get().parse::<i64>() {
        return number.to_string();
    }
    if let Ok(points) = serde_json::from_str::<Vec<Box<RawValue>>>(raw.get()) {
        return format!(
            "[{}]",
            points
                .iter()
                .map(|p| normalized(p))
                .collect::<Vec<_>>()
                .join(",")
        );
    }
    let value: Value = serde_json::from_str(raw.get()).expect("validated known field");
    serde_json::to_string(&value).expect("known values serialize")
}
fn pairs(fields: &Fields, known: Pairs, order: &[String]) -> Pairs {
    let mut values: Pairs = fields
        .iter()
        .filter(|(key, _)| !order.contains(key))
        .map(|(key, value)| (key.clone(), minify(value.get())))
        .collect();
    values.extend(known);
    let mut result = Pairs::new();
    for key in fields.keys().chain(order).chain(values.keys()) {
        if let Some(value) = values.get(key) {
            result.insert(key.clone(), value.clone());
        }
    }
    result
}
fn compact(fields: &Pairs) -> String {
    format!(
        "{{{}}}",
        fields
            .iter()
            .map(|(key, value)| format!("{}:{value}", quote(key)))
            .collect::<Vec<_>>()
            .join(",")
    )
}
fn item(fields: &Fields, kind: &str) -> String {
    let order = &table().key_order[kind];
    let known = order
        .iter()
        .filter_map(|key| fields.get(key).map(|raw| (key.clone(), normalized(raw))))
        .collect();
    compact(&pairs(fields, known, order))
}
fn multiline(fields: &Pairs, level: usize) -> String {
    if fields.is_empty() {
        return "{}".to_string();
    }
    let indent = &table().layout.indent;
    format!(
        "{{\n{}\n{}}}",
        fields
            .iter()
            .map(|(key, value)| format!("{}{}: {value}", indent.repeat(level), quote(key)))
            .collect::<Vec<_>>()
            .join(",\n"),
        indent.repeat(level - 1)
    )
}
fn array(rows: Vec<String>, level: usize) -> String {
    if rows.is_empty() {
        return "[]".to_string();
    }
    let indent = &table().layout.indent;
    format!(
        "[\n{}\n{}]",
        rows.into_iter()
            .map(|row| format!("{}{row}", indent.repeat(level)))
            .collect::<Vec<_>>()
            .join(",\n"),
        indent.repeat(level - 1)
    )
}

pub fn write(board: &ReadBoard) -> String {
    let mut known = Pairs::new();
    // An empty source is the seed; an explicitly empty object stays an object.
    // The reader retains that distinction without retaining the input bytes.
    let seed = board.source_empty;
    if !board.nodes.is_empty() || seed || board.fields.contains_key("nodes") {
        known.insert(
            "nodes".into(),
            array(
                board
                    .nodes
                    .iter()
                    .map(|node| item(&node.fields, &node.node_type))
                    .collect(),
                2,
            ),
        );
    }
    if !board.edges.is_empty() || seed || board.fields.contains_key("edges") {
        known.insert(
            "edges".into(),
            array(
                board.edges.iter().map(|edge| item(edge, "edge")).collect(),
                2,
            ),
        );
    }
    let mut cards = Pairs::new();
    for node in &board.nodes {
        if let Some(fields) = board.cards.get(&node.id) {
            let mut values = Pairs::new();
            if node.node_type == "text" {
                if let Some(shape) = fields.get("shape") {
                    values.insert("shape".into(), normalized(shape));
                }
            }
            cards.insert(
                node.id.clone(),
                compact(&pairs(fields, values, &table().key_order["card"])),
            );
        }
    }
    if board.cerebro.is_some() || !cards.is_empty() || !board.ink.is_empty() {
        let empty = Fields::new();
        let original = board.cerebro.as_ref().unwrap_or(&empty);
        let mut extra = Pairs::from_iter([(
            "version".to_string(),
            table().cerebro_versions[0].to_string(),
        )]);
        if !cards.is_empty() || original.contains_key("cards") {
            extra.insert("cards".into(), multiline(&cards, 3));
        }
        if !board.ink.is_empty() || original.contains_key("ink") {
            extra.insert(
                "ink".into(),
                array(
                    board
                        .ink
                        .iter()
                        .map(|stroke| item(stroke, "stroke"))
                        .collect(),
                    3,
                ),
            );
        }
        known.insert(
            "cerebro".into(),
            multiline(&pairs(original, extra, &table().key_order["cerebro"]), 2),
        );
    }
    let mut output = multiline(&pairs(&board.fields, known, &table().key_order["board"]), 1);
    if table().layout.trailing_newline {
        output.push('\n');
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::canvas::read::read;
    fn case_text(source: &str) -> String {
        if source.ends_with(".canvas") {
            std::fs::read_to_string(
                std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../shared/canvas/goldens")
                    .join(source),
            )
            .unwrap()
        } else {
            source.into()
        }
    }
    #[test]
    fn replays_the_shared_canvas_goldens() {
        let cases: Value =
            serde_json::from_str(include_str!("../../../shared/canvas/cases.json")).unwrap();
        for case in cases
            .as_array()
            .unwrap()
            .iter()
            .filter(|case| case["ok"] == true)
        {
            let source = case_text(case["input"].as_str().unwrap());
            let expected = case["canonical"].as_str().unwrap();
            let expected = if expected == "same" {
                source.clone()
            } else {
                case_text(expected)
            };
            let output = write(&read(&source).unwrap());
            assert_eq!(output, expected, "{}", case["name"]);
            assert_eq!(write(&read(&output).unwrap()), output, "{}", case["name"]);
        }
    }
    #[test]
    fn unknown_values_keep_their_raw_text() {
        let source =
            r#"{"unknown": {"a":1.50,"a":1e3,"s":"\ud800","space":"a b"},"nodes":[],"edges":[]}"#;
        let output = write(&read(source).unwrap());
        assert!(output.contains(r#""unknown": {"a":1.50,"a":1e3,"s":"\ud800","space":"a b"}"#));
    }
    #[test]
    fn strings_escape_as_json_stringify_does() {
        let source = r#"{"nodes":[{"id":"a","type":"text","text":"\u001f\u2028\u007f😀","x":-0,"y":0,"width":1,"height":1}]}"#;
        let output = write(&read(source).unwrap());
        assert!(output.contains("\"text\":\"\\u001f\u{2028}\u{7f}😀\""));
        assert!(output.contains("\"x\":0"));
    }
    #[test]
    fn deep_nesting_is_unavailable_not_a_crash() {
        let source = format!("{{\"unknown\":{}0{}}}", "[".repeat(40), "]".repeat(40));
        assert!(read(&source).is_err());
    }
}
