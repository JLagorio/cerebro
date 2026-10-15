use std::collections::HashSet;

use indexmap::IndexMap;
use serde::Serialize;
use serde_json::{value::RawValue, Value};

use super::format::table;

pub type Fields = IndexMap<String, Box<RawValue>>;

#[derive(Debug, Serialize)]
pub struct Unreadable {
    pub reason: &'static str,
    pub message: String,
}

#[derive(Debug)]
pub struct Node {
    pub id: String,
    pub node_type: String,
    pub fields: Fields,
}

#[derive(Debug)]
pub struct ReadBoard {
    /// Blank text reads as the seed; an explicit {} keeps its absent arrays.
    pub source_empty: bool,
    pub fields: Fields,
    pub nodes: Vec<Node>,
    pub edges: Vec<Fields>,
    pub ink: Vec<Fields>,
    pub cerebro: Option<Fields>,
    pub cards: IndexMap<String, Fields>,
    pub problems: Vec<Value>,
}

fn refused(reason: &'static str, message: impl Into<String>) -> Unreadable {
    Unreadable {
        reason,
        message: message.into(),
    }
}
fn object(raw: &RawValue, what: &str) -> Result<Fields, Unreadable> {
    if !raw.get().trim_start().starts_with('{') {
        return Err(refused("not_board", format!("{what} must be an object.")));
    }
    serde_json::from_str(raw.get())
        .map_err(|_| refused("not_board", format!("{what} must have valid text keys.")))
}
fn list(raw: Option<&RawValue>, what: &str) -> Result<Vec<Box<RawValue>>, Unreadable> {
    let Some(raw) = raw else {
        return Ok(Vec::new());
    };
    serde_json::from_str(raw.get())
        .map_err(|_| refused("not_board", format!("{what} must be an array.")))
}
fn get<'a>(o: &'a Fields, key: &str) -> Option<&'a RawValue> {
    o.get(key).map(AsRef::as_ref)
}
fn text(raw: Option<&RawValue>, what: &str) -> Result<String, Unreadable> {
    raw.and_then(|v| serde_json::from_str::<String>(v.get()).ok())
        .ok_or_else(|| refused("invalid", format!("{what} must be valid text.")))
}
fn integer(raw: Option<&RawValue>, what: &str, min: i64, max: i64) -> Result<i64, Unreadable> {
    raw.and_then(|r| r.get().parse::<i64>().ok())
        .filter(|n| *n >= min && *n <= max)
        .ok_or_else(|| {
            refused(
                "invalid",
                format!("{what} must be a whole-number literal from {min} to {max}."),
            )
        })
}
fn optional(
    o: &Fields,
    key: &str,
    what: &str,
    vocabulary: Option<&[String]>,
) -> Result<Option<String>, Unreadable> {
    let Some(v) = get(o, key) else {
        return Ok(None);
    };
    let value = text(Some(v), &format!("{what}: {key}"))?;
    if let Some(vocab) = vocabulary {
        if !vocab.contains(&value) {
            return Err(refused(
                "invalid",
                format!("{what}: {key} must be one of {}.", vocab.join(", ")),
            ));
        }
    }
    Ok(Some(value))
}
fn id(o: &Fields, what: &str, ids: &mut HashSet<String>) -> Result<String, Unreadable> {
    let value = text(get(o, "id"), &format!("{what} id"))?;
    if value.is_empty() || value.chars().count() > table().limits.max_id_chars {
        return Err(refused(
            "invalid",
            format!(
                "{what} id must have 1 to {} characters.",
                table().limits.max_id_chars
            ),
        ));
    }
    if !ids.insert(value.clone()) {
        return Err(refused(
            "invalid",
            format!("{what} id {value} is repeated."),
        ));
    }
    Ok(value)
}
fn check_box(o: &Fields, what: &str) -> Result<(i64, i64), Unreadable> {
    let max = table().limits.max_coord;
    integer(get(o, "x"), &format!("{what}: x"), -max, max)?;
    integer(get(o, "y"), &format!("{what}: y"), -max, max)?;
    let width = integer(get(o, "width"), &format!("{what}: width"), 1, max)?;
    let height = integer(get(o, "height"), &format!("{what}: height"), 1, max)?;
    Ok((width, height))
}
fn color_problem(
    o: &Fields,
    what: &str,
    key: &str,
    problems: &mut Vec<Value>,
) -> Result<(), Unreadable> {
    if let Some(color) = optional(o, "color", what, None)? {
        let hex = color
            .strip_prefix('#')
            .is_some_and(|s| matches!(s.len(), 3 | 6) && s.bytes().all(|b| b.is_ascii_hexdigit()));
        if !hex && !table().vocab["color_presets"].contains(&color) {
            problems.push(serde_json::json!({"kind":"undrawable-color", "key":key, "color":color}));
        }
    }
    Ok(())
}

/// RawValue validates JSON without interpreting unknown strings or numbers.
/// This lexical pass adds the shared nesting cap, counting only containers.
fn depth_ok(raw: &str) -> bool {
    let mut depth = 0usize;
    let mut string = false;
    let mut escape = false;
    for b in raw.bytes() {
        if string {
            if escape {
                escape = false;
            } else if b == b'\\' {
                escape = true;
            } else if b == b'"' {
                string = false;
            }
        } else if b == b'"' {
            string = true;
        } else if matches!(b, b'{' | b'[') {
            depth += 1;
            if depth > table().limits.max_depth {
                return false;
            }
        } else if matches!(b, b'}' | b']') {
            depth = depth.saturating_sub(1);
        }
    }
    true
}

pub fn read(source: &str) -> Result<ReadBoard, Unreadable> {
    let limits = &table().limits;
    if source.len() > limits.max_bytes {
        return Err(refused(
            "too_large",
            format!(
                "This whiteboard is over the {} byte limit.",
                limits.max_bytes
            ),
        ));
    }
    let source = source.strip_prefix('\u{feff}').unwrap_or(source);
    if source
        .bytes()
        .all(|b| matches!(b, b' ' | b'\t' | b'\r' | b'\n'))
    {
        return Ok(ReadBoard {
            source_empty: true,
            fields: Fields::new(),
            nodes: Vec::new(),
            edges: Vec::new(),
            ink: Vec::new(),
            cerebro: None,
            cards: IndexMap::new(),
            problems: Vec::new(),
        });
    }
    let bad_json = || refused("not_json", "This whiteboard isn't valid JSON.");
    if !depth_ok(source) {
        return Err(bad_json());
    }
    let raw: Box<RawValue> = serde_json::from_str(source).map_err(|_| bad_json())?;
    let fields = object(&raw, "A whiteboard")?;
    let node_values = list(get(&fields, "nodes"), "Whiteboard nodes")?;
    let edge_values = list(get(&fields, "edges"), "Whiteboard edges")?;
    let cerebro = get(&fields, "cerebro")
        .map(|v| object(v, "Whiteboard extras"))
        .transpose()?;
    if let Some(extra) = &cerebro {
        let raw_version = get(extra, "version");
        let version: Option<f64> = raw_version.and_then(|v| serde_json::from_str(v.get()).ok());
        if !version.is_some_and(|v| table().cerebro_versions.iter().any(|n| v == *n as f64)) {
            let suffix = raw_version
                .filter(|v| {
                    v.get().starts_with('-')
                        || v.get().as_bytes().first().is_some_and(u8::is_ascii_digit)
                })
                .map(|v| format!(" ({})", v.get()))
                .unwrap_or_default();
            return Err(refused(
                "version",
                format!("This whiteboard uses an unsupported Cerebro version{suffix}."),
            ));
        }
    }
    let card_values = cerebro
        .as_ref()
        .and_then(|v| get(v, "cards"))
        .map(|v| object(v, "Card extras"))
        .transpose()?
        .unwrap_or_default();
    let ink_values = list(
        cerebro.as_ref().and_then(|v| get(v, "ink")),
        "Whiteboard ink",
    )?;
    if node_values.len() > limits.max_nodes
        || edge_values.len() > limits.max_edges
        || ink_values.len() > limits.max_strokes
    {
        return Err(refused(
            "too_large",
            "This whiteboard has more cards, connections or ink strokes than the limit.",
        ));
    }
    let mut node_ids = HashSet::new();
    let mut nodes = Vec::new();
    let mut problems = Vec::new();
    for raw in node_values {
        let o = object(&raw, "A card")?;
        let id = id(&o, "card", &mut node_ids)?;
        let what = format!("card {id}");
        let kind = text(get(&o, "type"), &format!("{what}: type"))?;
        if !table().vocab["node_types"].contains(&kind) {
            return Err(refused(
                "invalid",
                format!(
                    "{what}: type must be one of {}.",
                    table().vocab["node_types"].join(", ")
                ),
            ));
        }
        check_box(&o, &what)?;
        color_problem(&o, &what, &format!("n:{id}"), &mut problems)?;
        if let Some(raw) = get(&card_values, &id) {
            let extra = object(raw, &format!("{what} extras"))?;
            optional(&extra, "shape", &what, Some(&table().vocab["shapes"]))?;
        }
        match kind.as_str() {
            "text" => {
                text(get(&o, "text"), &format!("{what}: text"))?;
            }
            "file" => {
                if text(get(&o, "file"), &format!("{what}: file"))?.is_empty() {
                    return Err(refused(
                        "invalid",
                        format!("{what}: file must name a path."),
                    ));
                }
                optional(&o, "subpath", &what, None)?;
            }
            "link" => {
                text(get(&o, "url"), &format!("{what}: url"))?;
            }
            "group" => {
                optional(&o, "label", &what, None)?;
                optional(&o, "background", &what, None)?;
                optional(
                    &o,
                    "backgroundStyle",
                    &what,
                    Some(&table().vocab["background_styles"]),
                )?;
            }
            _ => unreachable!("checked node vocabulary"),
        }
        nodes.push(Node {
            id,
            node_type: kind,
            fields: o,
        });
    }
    let mut edge_ids = HashSet::new();
    let mut edges = Vec::new();
    for raw in edge_values {
        let o = object(&raw, "A connection")?;
        let id = id(&o, "connection", &mut edge_ids)?;
        let what = format!("connection {id}");
        for k in ["fromSide", "toSide"] {
            optional(&o, k, &what, Some(&table().vocab["sides"]))?;
        }
        for k in ["fromEnd", "toEnd"] {
            optional(&o, k, &what, Some(&table().vocab["ends"]))?;
        }
        optional(&o, "color", &what, None)?;
        optional(&o, "label", &what, None)?;
        let from = text(get(&o, "fromNode"), &format!("{what}: fromNode"))?;
        let to = text(get(&o, "toNode"), &format!("{what}: toNode"))?;
        let (from_gone, to_gone) = (!node_ids.contains(&from), !node_ids.contains(&to));
        if from_gone || to_gone {
            problems.push(serde_json::json!({"kind":"dangling-edge","key":format!("e:{id}"),"ends":if from_gone && to_gone {"both"} else if from_gone {"from"} else {"to"}}));
        }
        color_problem(&o, &what, &format!("e:{id}"), &mut problems)?;
        edges.push(o);
    }
    let mut ink_ids = HashSet::new();
    let mut ink = Vec::new();
    for raw in ink_values {
        let o = object(&raw, "An ink stroke")?;
        let id = id(&o, "ink stroke", &mut ink_ids)?;
        let what = format!("ink stroke {id}");
        let simulated: Option<bool> =
            get(&o, "simulated").and_then(|v| serde_json::from_str(v.get()).ok());
        if simulated.is_none() {
            return Err(refused(
                "invalid",
                format!("{what}: simulated must be true or false."),
            ));
        }
        let points = list(get(&o, "points"), &format!("{what}: points"))?
            .iter()
            .map(|v| integer(Some(v), &format!("{what}: point"), 0, limits.max_coord * 10))
            .collect::<Result<Vec<_>, _>>()?;
        optional(&o, "color", &what, None)?;
        let (width, height) = check_box(&o, &what)?;
        integer(
            get(&o, "size"),
            &format!("{what}: size"),
            1,
            limits.max_ink_size,
        )?;
        if points.is_empty() || !points.len().is_multiple_of(3) {
            return Err(refused(
                "invalid",
                format!("{what}: its points must be x, y and pressure triples, at least one."),
            ));
        }
        if points.len() / 3 > limits.max_ink_points {
            return Err(refused(
                "invalid",
                format!(
                    "{what}: it has {} samples; the limit is {}.",
                    points.len() / 3,
                    limits.max_ink_points
                ),
            ));
        }
        for (i, p) in points.chunks_exact(3).enumerate() {
            if p[0] > width * 10 || p[1] > height * 10 {
                return Err(refused(
                    "invalid",
                    format!("{what}: sample {} lies outside the stroke's box.", i + 1),
                ));
            }
            if p[2] > 1000 {
                return Err(refused(
                    "invalid",
                    format!(
                        "{what}: sample {} has pressure {}; pressure runs from 0 to 1000.",
                        i + 1,
                        p[2]
                    ),
                ));
            }
        }
        color_problem(&o, &what, &format!("i:{id}"), &mut problems)?;
        ink.push(o);
    }
    let mut cards = IndexMap::new();
    let mut orphans = 0;
    for (id, raw) in card_values {
        let extra = object(&raw, &format!("card {id} extras"))?;
        optional(
            &extra,
            "shape",
            &format!("card {id}"),
            Some(&table().vocab["shapes"]),
        )?;
        if node_ids.contains(&id) {
            cards.insert(id, extra);
        } else {
            orphans += 1;
        }
    }
    if orphans > 0 {
        problems.push(serde_json::json!({"kind":"orphan-card-extras","count":orphans}));
    }
    Ok(ReadBoard {
        source_empty: false,
        fields,
        nodes,
        edges,
        ink,
        cerebro,
        cards,
        problems,
    })
}

pub fn read_bytes(bytes: &[u8]) -> Result<ReadBoard, Unreadable> {
    if bytes.len() > table().limits.max_bytes {
        return Err(refused(
            "too_large",
            format!(
                "This whiteboard is over the {} byte limit.",
                table().limits.max_bytes
            ),
        ));
    }
    let source = std::str::from_utf8(bytes)
        .map_err(|_| refused("not_text", "This whiteboard is not valid UTF-8 text."))?;
    read(source)
}

pub fn texts_of(board: &ReadBoard) -> Vec<String> {
    board
        .nodes
        .iter()
        .filter_map(|n| {
            let key = match n.node_type.as_str() {
                "text" => "text",
                "group" => "label",
                _ => return None,
            };
            get(&n.fields, key)
                .and_then(|v| serde_json::from_str::<String>(v.get()).ok())
                .filter(|s| !s.is_empty())
        })
        .collect()
}
pub fn search_text(board: &ReadBoard) -> String {
    texts_of(board).join("\n")
}
pub fn file_refs_of(board: &ReadBoard) -> Vec<Value> {
    board.nodes.iter().filter(|n| n.node_type == "file").map(|n| {
        let mut v = serde_json::json!({"file": text(get(&n.fields,"file"),"file").expect("validated file")});
        if let Some(raw) = get(&n.fields,"subpath") { v["subpath"] = Value::String(text(Some(raw),"subpath").expect("validated subpath")); }
        v
    }).collect()
}
pub fn link_target_of_path(file: &str, subpath: Option<&str>) -> String {
    let name = file.rsplit('/').next().unwrap_or(file);
    let is_md = name
        .get(name.len().saturating_sub(3)..)
        .is_some_and(|s| s.eq_ignore_ascii_case(".md"));
    let target = if name.eq_ignore_ascii_case("project.md") && file.contains('/') {
        file.rsplit_once('/')
            .unwrap()
            .0
            .rsplit('/')
            .next()
            .unwrap_or("")
    } else if is_md {
        &name[..name.len() - 3]
    } else {
        name
    };
    match subpath.filter(|s| !s.is_empty()) {
        Some(s) if s.starts_with('#') => format!("{target}{s}"),
        Some(s) => format!("{target}#{s}"),
        None => target.to_string(),
    }
}

pub struct EntryFacts {
    pub snippet: String,
    pub links: Vec<String>,
}
pub fn entry_facts(board: &ReadBoard) -> EntryFacts {
    let search = search_text(board);
    let mut links = crate::vault::parse::extract_outgoing_links(&search);
    for n in board.nodes.iter().filter(|n| n.node_type == "file") {
        let file = text(get(&n.fields, "file"), "file").expect("validated file");
        let subpath =
            get(&n.fields, "subpath").and_then(|v| serde_json::from_str::<String>(v.get()).ok());
        let target = link_target_of_path(&file, subpath.as_deref());
        if !links.contains(&target) {
            links.push(target);
        }
    }
    EntryFacts {
        snippet: crate::vault::parse::extract_snippet(&search),
        links,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn shared() -> std::path::PathBuf {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../shared/canvas")
    }
    fn case_text(input: &str) -> String {
        if input.ends_with(".canvas") {
            std::fs::read_to_string(shared().join("goldens").join(input)).unwrap()
        } else {
            input.to_string()
        }
    }
    #[test]
    fn replays_the_shared_canvas_cases() {
        let cases: Value =
            serde_json::from_str(include_str!("../../../shared/canvas/cases.json")).unwrap();
        for case in cases.as_array().unwrap() {
            let source = case_text(case["input"].as_str().unwrap());
            let actual = read(&source);
            if case["ok"] == false {
                let err = actual.unwrap_err();
                assert_eq!(
                    err.reason,
                    case["reason"].as_str().unwrap(),
                    "{}",
                    case["name"]
                );
                assert_eq!(
                    err.message,
                    case["message"].as_str().unwrap(),
                    "{}",
                    case["name"]
                );
            } else {
                let board = actual.unwrap();
                assert_eq!(
                    serde_json::json!([board.nodes.len(), board.edges.len(), board.ink.len()]),
                    case["counts"],
                    "{}",
                    case["name"]
                );
                assert_eq!(
                    serde_json::json!(board.problems),
                    case["problems"],
                    "{}",
                    case["name"]
                );
                assert_eq!(
                    serde_json::json!(texts_of(&board)),
                    case["texts"],
                    "{}",
                    case["name"]
                );
                assert_eq!(
                    serde_json::json!(file_refs_of(&board)),
                    case["links"],
                    "{}",
                    case["name"]
                );
                assert_eq!(
                    search_text(&board),
                    case["search"].as_str().unwrap(),
                    "{}",
                    case["name"]
                );
            }
        }
    }
    #[test]
    fn repeated_keys_keep_their_first_place_and_last_value() {
        let board = read(r#"{"x":1,"y":3,"x":2}"#).unwrap();
        assert_eq!(board.fields.keys().collect::<Vec<_>>(), ["x", "y"]);
        assert_eq!(board.fields["x"].get(), "2");
    }
    #[test]
    fn raw_unknown_numbers_and_strings_never_pass_through_a_value() {
        let board =
            read(r#"{"extra":{"huge":1e999,"precise":9007199254740993,"lone":"\ud800"}}"#).unwrap();
        assert_eq!(
            board.fields["extra"].get(),
            r#"{"huge":1e999,"precise":9007199254740993,"lone":"\ud800"}"#
        );
    }
    #[test]
    fn depth_and_byte_caps_are_checked_before_reading_fields() {
        let source = format!("{}0{}", "[".repeat(33), "]".repeat(33));
        assert_eq!(read(&source).unwrap_err().reason, "not_json");
        assert_eq!(
            read(&" ".repeat(table().limits.max_bytes + 1))
                .unwrap_err()
                .reason,
            "too_large"
        );
        assert_eq!(read_bytes(&[0xff]).unwrap_err().reason, "not_text");
    }
    #[test]
    fn targets_and_entry_facts_use_card_content() {
        let board = read(&case_text("obsidian-layout.canvas")).unwrap();
        let facts = entry_facts(&board);
        assert_eq!(facts.links, ["Vision", "Launch#Next"]);
        assert_eq!(facts.snippet, "Roadmap Vision Release");
        assert_eq!(link_target_of_path("attachments/文😀", None), "文😀");
        assert_eq!(
            link_target_of_path("a/Page.MD", Some("Heading")),
            "Page#Heading"
        );
    }
}
