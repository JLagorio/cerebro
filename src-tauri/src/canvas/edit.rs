//! One checked canvas operation batch. The caller owns scope and the path lock;
//! this planner owns only a copied board and never touches disk.
use super::{
    agent_limits::EditLimits,
    answer::Target,
    format::table,
    read::{self, Fields, Node, ReadBoard},
    write,
};
use serde::Serialize;
use serde_json::{value::RawValue, Map, Value};
use std::collections::HashSet;

pub struct Request<'a> {
    ops: &'a [Value],
}
pub fn parse_request(args: &Map<String, Value>) -> Result<Request<'_>, String> {
    let ops = args
        .get("ops")
        .and_then(Value::as_array)
        .ok_or("edit_canvas needs `ops`, a list of operations")?;
    Ok(Request { ops })
}
pub fn parse_create_request(args: &Map<String, Value>) -> Result<Request<'_>, String> {
    let ops = match args.get("ops") {
        None => &[][..],
        Some(value) => value
            .as_array()
            .map(Vec::as_slice)
            .ok_or("create_canvas needs `ops`, a list of operations")?,
    };
    Ok(Request { ops })
}
pub fn plan_create(request: &Request<'_>, ctx: &mut Context<'_>) -> Result<Plan, String> {
    let seed = write::empty_board();
    if request.ops.is_empty() {
        return Ok(Plan {
            content: seed,
            ops: vec![],
            created: vec![],
            warnings: vec![],
        });
    }
    let hash = crate::ledger::sha256_hex(seed.as_bytes());
    plan(&seed, &hash, request, ctx)
        .map_err(|reason| reason.replacen("edit_canvas", "create_canvas", 1))
}
pub struct Context<'a> {
    pub limits: &'a EditLimits,
    pub web_schemes: &'a [String],
    pub target_state: &'a mut dyn FnMut(&str) -> Target,
    pub board_path: &'a str,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Created {
    pub op: usize,
    pub id: String,
}
#[derive(Debug)]
pub struct Plan {
    pub content: String,
    pub ops: Vec<String>,
    pub created: Vec<Created>,
    pub warnings: Vec<String>,
}
const NODE_FIELDS: &[&str] = &[
    "x", "y", "width", "height", "color", "text", "file", "subpath", "url", "label",
];
const EDGE_FIELDS: &[&str] = &[
    "fromNode", "toNode", "fromSide", "toSide", "fromEnd", "toEnd", "color", "label",
];
fn words(parts: &[String]) -> String {
    match parts {
        [] => String::new(),
        [one] => one.clone(),
        [head @ .., last] => format!("{} and {last}", head.join(", ")),
    }
}
fn quote(value: &str) -> String {
    serde_json::to_string(value).expect("text serializes")
}
fn raw(value: &Value) -> Box<RawValue> {
    RawValue::from_string(value.to_string()).expect("JSON serializes")
}
fn field_text(fields: &Fields, key: &str) -> String {
    fields
        .get(key)
        .and_then(|v| serde_json::from_str(v.get()).ok())
        .unwrap_or_default()
}
fn string<'a>(op: &'a Map<String, Value>, key: &str, n: usize) -> Result<&'a str, String> {
    op.get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("Op {n}: `{key}` must be text."))
}
fn id(value: &str, n: usize, limits: &EditLimits) -> Result<(), String> {
    if value.is_empty()
        || value.len() > limits.id_chars
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
    {
        return Err(format!(
            "Op {n}: {} can't be an id. Use 1 to {} letters, digits, - or _.",
            quote(value),
            limits.id_chars
        ));
    }
    Ok(())
}
fn minted(hash: &str, n: usize, ids: &HashSet<String>) -> String {
    let seed = format!("{hash}:{n}");
    let mut k = 0;
    loop {
        let input = if k == 0 {
            seed.clone()
        } else {
            format!("{seed}:{k}")
        };
        let candidate = crate::ledger::sha256_hex(input.as_bytes())[..16].to_owned();
        if !ids.contains(&candidate) {
            return candidate;
        }
        k += 1;
    }
}
fn fresh_id(
    op: &Map<String, Value>,
    n: usize,
    hash: &str,
    ids: &HashSet<String>,
    limits: &EditLimits,
) -> Result<String, String> {
    let value = match op.get("id") {
        None => minted(hash, n, ids),
        Some(_) => string(op, "id", n)?.to_owned(),
    };
    id(&value, n, limits)?;
    if ids.contains(&value) {
        return Err(format!("Op {n}: the id {value} is already on this board."));
    }
    Ok(value)
}
fn required(op: &Map<String, Value>, key: &str, kind: &str, n: usize) -> Result<(), String> {
    if !op.contains_key(key) {
        return Err(format!("Op {n}: a {kind} node needs `{key}`."));
    }
    Ok(())
}
fn content_field(kind: &str) -> Option<&'static str> {
    match kind {
        "text" => Some("text"),
        "file" => Some("file"),
        "link" => Some("url"),
        _ => None,
    }
}
fn validate_fields(
    op: &Map<String, Value>,
    kind: &str,
    n: usize,
    ctx: &Context<'_>,
) -> Result<Vec<(String, Option<Value>)>, String> {
    let mut out = Vec::new();
    let fields = if kind == "edge" {
        EDGE_FIELDS
    } else {
        NODE_FIELDS
    };
    for key in fields {
        let Some(value) = op.get(*key) else { continue };
        if matches!(*key, "x" | "y" | "width" | "height") {
            let max = table().limits.max_coord;
            let min = if matches!(*key, "width" | "height") {
                1
            } else {
                -max
            };
            let number = value
                .as_f64()
                .filter(|v| {
                    v.is_finite() && v.fract() == 0.0 && *v >= min as f64 && *v <= max as f64
                })
                .ok_or_else(|| {
                    format!("Op {n}: `{key}` must be a whole number from {min} to {max}.")
                })?;
            out.push(((*key).into(), Some(Value::from(number as i64))));
            continue;
        }
        if kind != "edge" && matches!(*key, "text" | "file" | "subpath" | "url" | "label") {
            let allowed = content_field(kind) == Some(*key)
                || (*key == "label" && kind == "group")
                || (*key == "subpath" && kind == "file");
            if !allowed {
                return Err(format!("Op {n}: a {kind} node takes no `{key}`."));
            }
        }
        let text = string(op, key, n)?;
        if text.is_empty()
            && matches!(
                *key,
                "color" | "subpath" | "label" | "fromSide" | "toSide" | "fromEnd" | "toEnd"
            )
        {
            out.push(((*key).into(), None));
            continue;
        }
        let max = match *key {
            "text" => Some(ctx.limits.text_chars),
            "label" => Some(ctx.limits.label_chars),
            "file" => Some(ctx.limits.file_chars),
            "subpath" => Some(ctx.limits.subpath_chars),
            "url" => Some(ctx.limits.url_chars),
            _ => None,
        };
        if max.is_some_and(|max| text.chars().count() > max) {
            return Err(format!(
                "Op {n}: `{key}` is longer than {} characters.",
                max.unwrap()
            ));
        }
        if matches!(*key, "text" | "label")
            && text
                .chars()
                .any(|c| c < ' ' && !(*key == "text" && matches!(c, '\t' | '\n' | '\r')))
        {
            return Err(format!(
                "Op {n}: `{key}` holds a control character a board can't carry."
            ));
        }
        match *key {
            "color"
                if !(table().vocab["color_presets"].iter().any(|c| c == text)
                    || (text.len() == 7
                        && text.starts_with('#')
                        && text[1..].bytes().all(|b| b.is_ascii_hexdigit()))) =>
            {
                return Err(format!(
                    "Op {n}: {} isn't a colour. Use a preset 1 to 6, or #rrggbb.",
                    quote(text)
                ));
            }
            "file" => {
                if text.is_empty()
                    || text.starts_with('/')
                    || text.contains('\\')
                    || text.chars().any(char::is_control)
                    || text
                        .split('/')
                        .any(|part| part.is_empty() || part.starts_with('.'))
                {
                    return Err(format!("Op {n}: {} isn't a path inside the vault. Name a file such as notes/plan.md, with no ../, leading / or hidden folder.",quote(text)));
                }
                if text == ctx.board_path {
                    return Err(format!("Op {n}: a card can't show its own board."));
                }
            }
            "subpath" if !text.starts_with('#') => {
                return Err(format!("Op {n}: `subpath` must start with #."));
            }
            "url" => {
                let valid = text.split_once("://").is_some_and(|(scheme, rest)| {
                    !rest.is_empty()
                        && ctx
                            .web_schemes
                            .iter()
                            .any(|s| s.eq_ignore_ascii_case(scheme))
                }) && !text.chars().any(|c| c.is_control() || c.is_whitespace());
                if !valid {
                    return Err(format!(
                        "Op {n}: {} isn't a web address. Start it with {}://.",
                        quote(text),
                        ctx.web_schemes.join(" or ")
                    ));
                }
            }
            "fromSide" | "toSide" if !table().vocab["sides"].iter().any(|s| s == text) => {
                return Err(format!(
                    "Op {n}: {} isn't a side. Use top, right, bottom or left.",
                    quote(text)
                ));
            }
            "fromEnd" | "toEnd" if !table().vocab["ends"].iter().any(|s| s == text) => {
                return Err(format!(
                    "Op {n}: {} isn't an edge end. Use none or arrow.",
                    quote(text)
                ));
            }
            "fromNode" | "toNode" => id(text, n, ctx.limits)?,
            _ => {}
        }
        out.push((
            (*key).into(),
            Some(Value::from(if *key == "color" {
                text.to_ascii_lowercase()
            } else {
                text.into()
            })),
        ));
    }
    Ok(out)
}
fn equal(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| equal(a, b))
        }
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len() && a.iter().all(|(k, a)| b.get(k).is_some_and(|b| equal(a, b)))
        }
        _ => a == b,
    }
}
fn set(fields: &mut Fields, changes: Vec<(String, Option<Value>)>) -> Vec<String> {
    let mut changed = Vec::new();
    for (key, next) in changes {
        let before = fields
            .get(&key)
            .map(|v| serde_json::from_str::<Value>(v.get()).expect("valid field"));
        if match (&before, &next) {
            (None, None) => true,
            (Some(a), Some(b)) => equal(a, b),
            _ => false,
        } {
            continue;
        }
        if let Some(value) = next {
            fields.insert(key.clone(), raw(&value));
        } else {
            fields.shift_remove(&key);
        }
        changed.push(key);
    }
    changed
}
fn ordered_new(fields: Fields, kind: &str) -> Fields {
    table().key_order[kind]
        .iter()
        .filter_map(|key| fields.get(key).map(|value| (key.clone(), value.clone())))
        .collect()
}
fn file_warning(
    fields: &Fields,
    id: &str,
    n: usize,
    ctx: &mut Context<'_>,
    warnings: &mut Vec<String>,
) -> Result<(), String> {
    let file = field_text(fields, "file");
    let words=match (ctx.target_state)(&file){
        Target::Missing=>Some(format!("The card {id} points at {file}, which is not in the vault; it keeps that path.")),
        Target::Unchecked=>Some(format!("The card {id} points at {file}, outside what this run may read, so it was not checked.")),
        // Lexical path validity was checked above; a symlink may still leave it.
        Target::Outside=>return Err(format!("Op {n}: {} isn't a path inside the vault. Name a file such as notes/plan.md, with no ../, leading / or hidden folder.", quote(&file))),
        Target::Exists=>None,
    };
    if let Some(words) = words {
        warnings.push(words);
    }
    Ok(())
}
fn check_ends(fields: &Fields, n: usize, nodes: &HashSet<String>) -> Result<(), String> {
    for key in ["fromNode", "toNode"] {
        let target = field_text(fields, key);
        if !nodes.contains(&target) {
            return Err(format!(
                "Op {n}: the edge would point at {}, which is not on the board.",
                quote(&target)
            ));
        }
    }
    Ok(())
}
fn same_fields(a: &Fields, b: &Fields, known: &[String], skip: &[&str]) -> bool {
    let keys_of = |fields: &Fields| {
        fields
            .keys()
            .filter(|k| !skip.contains(&k.as_str()))
            .cloned()
            .collect::<HashSet<_>>()
    };
    let keys = keys_of(a);
    if keys != keys_of(b) {
        return false;
    }
    keys.iter().all(|key| {
        if known.contains(key) {
            let a: Value = serde_json::from_str(a[key].get()).expect("validated known field");
            let b: Value = serde_json::from_str(b[key].get()).expect("validated known field");
            equal(&a, &b)
        } else {
            write::minify(a[key].get()) == write::minify(b[key].get())
        }
    })
}
fn same_board(a: &ReadBoard, b: &ReadBoard) -> bool {
    let order = &table().key_order;
    same_fields(&a.fields, &b.fields, &[], &["nodes", "edges", "cerebro"])
        && a.nodes.len() == b.nodes.len()
        && a.nodes.iter().zip(&b.nodes).all(|(a, b)| {
            a.id == b.id
                && a.node_type == b.node_type
                && same_fields(&a.fields, &b.fields, &order[&a.node_type], &[])
        })
        && a.edges.len() == b.edges.len()
        && a.edges
            .iter()
            .zip(&b.edges)
            .all(|(a, b)| same_fields(a, b, &order["edge"], &[]))
        && a.ink.len() == b.ink.len()
        && a.ink
            .iter()
            .zip(&b.ink)
            .all(|(a, b)| same_fields(a, b, &order["stroke"], &[]))
        && match (&a.cerebro, &b.cerebro) {
            (None, None) => true,
            (Some(a), Some(b)) => same_fields(a, b, &[], &["version", "cards", "ink"]),
            _ => false,
        }
        && a.cards.len() == b.cards.len()
        && a.cards.iter().all(|(id, a)| {
            b.cards
                .get(id)
                .is_some_and(|b| same_fields(a, b, &order["card"], &[]))
        })
}

pub fn plan(
    text: &str,
    before_hash: &str,
    request: &Request<'_>,
    ctx: &mut Context<'_>,
) -> Result<Plan, String> {
    plan_with(text, before_hash, request, ctx, write::write)
}
fn plan_with(
    text: &str,
    before_hash: &str,
    request: &Request<'_>,
    ctx: &mut Context<'_>,
    write: impl FnOnce(&ReadBoard) -> String,
) -> Result<Plan, String> {
    if request.ops.len() > ctx.limits.ops {
        return Err(format!(
            "edit_canvas takes at most {} ops in one call; this call has {}.",
            ctx.limits.ops,
            request.ops.len()
        ));
    }
    if request.ops.is_empty() {
        return Err("edit_canvas needs at least one op.".into());
    }
    let mut board = read::read(text).map_err(|error| {
        format!(
            "{} can't be read as a whiteboard ({}), so it was left as it is.",
            ctx.board_path, error.message
        )
    })?;
    let mut node_ids: HashSet<String> = board.nodes.iter().map(|n| n.id.clone()).collect();
    let mut ids = node_ids.clone();
    ids.extend(board.edges.iter().map(|e| field_text(e, "id")));
    let mut lines = Vec::new();
    let mut created = Vec::new();
    let mut warnings = Vec::new();
    let mut changed = false;
    for (index, value) in request.ops.iter().enumerate() {
        let n = index + 1;
        let op = value
            .as_object()
            .ok_or_else(|| format!("Op {n} must be an object with `op`."))?;
        let kind = op.get("op").and_then(Value::as_str).unwrap_or_default();
        if !["add_node", "update_node", "add_edge", "update_edge"].contains(&kind) {
            return Err(format!(
                "Op {n}: `op` must be add_node, update_node, add_edge or update_edge."
            ));
        }
        let node = kind.ends_with("node");
        let add = kind.starts_with("add");
        let allowed = if node { NODE_FIELDS } else { EDGE_FIELDS };
        let mut extras: Vec<_> = op
            .keys()
            .filter(|key| {
                !(allowed.contains(&key.as_str())
                    || matches!(key.as_str(), "op" | "id")
                    || node && key.as_str() == "type")
            })
            .collect();
        extras.sort();
        if let Some(key) = extras.first() {
            return Err(format!("Op {n}: {key} isn't something {kind} sets."));
        }
        if node && !add && op.contains_key("type") {
            return Err(format!("Op {n}: a node's type can't change."));
        }
        if add && node {
            let node_type = op
                .get("type")
                .and_then(Value::as_str)
                .filter(|t| table().vocab["node_types"].iter().any(|known| known == t))
                .ok_or_else(|| {
                    format!("Op {n}: add_node needs `type`: text, file, link or group.")
                })?;
            for key in ["x", "y", "width", "height"] {
                required(op, key, node_type, n)?;
            }
            if let Some(field) = content_field(node_type) {
                required(op, field, node_type, n)?;
            }
            let changes = validate_fields(op, node_type, n, ctx)?;
            let id = fresh_id(op, n, before_hash, &ids, ctx.limits)?;
            let mut fields = Fields::new();
            fields.insert("id".into(), raw(&Value::from(id.clone())));
            fields.insert("type".into(), raw(&Value::from(node_type)));
            set(&mut fields, changes);
            let fields = ordered_new(fields, node_type);
            if node_type == "file" {
                file_warning(&fields, &id, n, ctx, &mut warnings)?;
            }
            board.nodes.push(Node {
                id: id.clone(),
                node_type: node_type.into(),
                fields,
            });
            node_ids.insert(id.clone());
            ids.insert(id.clone());
            created.push(Created {
                op: n,
                id: id.clone(),
            });
            lines.push(format!("Added the {node_type} node {id}."));
            changed = true;
        } else if add {
            let changes = validate_fields(op, "edge", n, ctx)?;
            let id = fresh_id(op, n, before_hash, &ids, ctx.limits)?;
            let mut fields = Fields::new();
            fields.insert("id".into(), raw(&Value::from(id.clone())));
            set(&mut fields, changes);
            let fields = ordered_new(fields, "edge");
            check_ends(&fields, n, &node_ids)?;
            lines.push(format!(
                "Added the edge {id} from {} to {}.",
                field_text(&fields, "fromNode"),
                field_text(&fields, "toNode")
            ));
            board.edges.push(fields);
            ids.insert(id.clone());
            created.push(Created { op: n, id });
            changed = true;
        } else {
            if !op.contains_key("id") || !allowed.iter().any(|key| op.contains_key(*key)) {
                return Err(format!(
                    "Op {n}: {kind} needs `id` and at least one field to change."
                ));
            }
            let id = string(op, "id", n)?;
            self::id(id, n, ctx.limits)?;
            if node {
                let found = board
                    .nodes
                    .iter_mut()
                    .find(|node| node.id == id)
                    .ok_or_else(|| {
                        format!("Op {n}: no node with id {} on this board.", quote(id))
                    })?;
                let changes = validate_fields(op, &found.node_type, n, ctx)?;
                let fields = set(&mut found.fields, changes);
                if found.node_type == "file" && fields.iter().any(|f| f == "file") {
                    file_warning(&found.fields, id, n, ctx, &mut warnings)?;
                }
                if fields.is_empty() {
                    lines.push(format!("Node {id} already had those values."));
                } else {
                    lines.push(format!("Changed {} on node {id}.", words(&fields)));
                    changed = true;
                }
            } else {
                let found = board
                    .edges
                    .iter_mut()
                    .find(|edge| field_text(edge, "id") == id)
                    .ok_or_else(|| {
                        format!("Op {n}: no edge with id {} on this board.", quote(id))
                    })?;
                let changes = validate_fields(op, "edge", n, ctx)?;
                let fields = set(found, changes);
                if op.contains_key("fromNode") || op.contains_key("toNode") {
                    check_ends(found, n, &node_ids)?;
                }
                if fields.is_empty() {
                    lines.push(format!("Edge {id} already had those values."));
                } else {
                    lines.push(format!("Changed {} on edge {id}.", words(&fields)));
                    changed = true;
                }
            }
        }
    }
    for (what, count, max) in [
        ("nodes", board.nodes.len(), table().limits.max_nodes),
        ("edges", board.edges.len(), table().limits.max_edges),
    ] {
        if count > max {
            return Err(format!(
                "The board would hold {count} {what}; a board holds at most {max}."
            ));
        }
    }
    let content = if changed { write(&board) } else { text.into() };
    if content.len() > table().limits.max_bytes {
        return Err(format!(
            "The board would hold {} bytes; a board holds at most {}.",
            content.len(),
            table().limits.max_bytes
        ));
    }
    if !read::read(&content).is_ok_and(|after| same_board(&board, &after)) {
        return Err(
            "The changed board would not read back as planned, so it was left as it is.".into(),
        );
    }
    Ok(Plan {
        content,
        ops: lines,
        created,
        warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn run(source: &str, hash: &str, ops: Value) -> Result<Plan, String> {
        let args = json!({"ops":ops});
        let request = parse_request(args.as_object().unwrap()).unwrap();
        let mut target = |_: &str| Target::Missing;
        plan(
            source,
            hash,
            &request,
            &mut Context {
                limits: &super::super::agent_limits::table().edit,
                web_schemes: &["http".into(), "https".into()],
                target_state: &mut target,
                board_path: "boards/plan.canvas",
            },
        )
    }
    #[test]
    fn replays_the_shared_canvas_edit_cases() {
        let cases: Value =
            serde_json::from_str(include_str!("../../fixtures/canvas-edit-cases.json")).unwrap();
        for case in cases["edits"].as_array().unwrap() {
            let source = case["source"].as_str().unwrap();
            let mut limits: Value =
                serde_json::from_str(super::super::agent_limits::LIMITS_JSON).unwrap();
            if let Some(overrides) = case["limits"].as_object() {
                for (key, value) in overrides {
                    limits["edit"][key] = value.clone();
                }
            }
            let limits: EditLimits = serde_json::from_value(limits["edit"].clone()).unwrap();
            let mut target = |path: &str| match case["targets"][path].as_str().unwrap_or("missing")
            {
                "exists" => Target::Exists,
                "outside" => Target::Outside,
                "unchecked" => Target::Unchecked,
                _ => Target::Missing,
            };
            let request = parse_request(case.as_object().unwrap()).unwrap();
            let answer = plan(
                source,
                &crate::ledger::sha256_hex(source.as_bytes()),
                &request,
                &mut Context {
                    limits: &limits,
                    web_schemes: &["http".into(), "https".into()],
                    target_state: &mut target,
                    board_path: "boards/plan.canvas",
                },
            );
            if let Some(refusal) = case["refusal"].as_str() {
                assert_eq!(answer.unwrap_err(), refusal, "{}", case["name"]);
            } else {
                let answer = answer.unwrap_or_else(|e| panic!("{}: {e}", case["name"]));
                assert_eq!(
                    answer.content,
                    case["after"].as_str().unwrap(),
                    "{}",
                    case["name"]
                );
                assert_eq!(
                    json!({"ops":answer.ops,"created":answer.created,"warnings":answer.warnings}),
                    case["report"],
                    "{}",
                    case["name"]
                );
            }
        }
    }
    #[test]
    fn replays_the_create_cases() {
        let cases: Value =
            serde_json::from_str(include_str!("../../fixtures/canvas-edit-cases.json")).unwrap();
        for case in cases["creates"].as_array().unwrap() {
            let mut target = |_: &str| Target::Missing;
            let result =
                parse_create_request(case["args"].as_object().unwrap()).and_then(|request| {
                    plan_create(
                        &request,
                        &mut Context {
                            limits: &super::super::agent_limits::table().edit,
                            web_schemes: &["http".into(), "https".into()],
                            target_state: &mut target,
                            board_path: case["path"].as_str().unwrap(),
                        },
                    )
                });
            if let Some(refusal) = case["refusal"].as_str() {
                assert_eq!(result.unwrap_err(), refusal, "{}", case["name"]);
            } else {
                let answer = result.unwrap_or_else(|error| panic!("{}: {error}", case["name"]));
                assert_eq!(
                    answer.content,
                    case["after"].as_str().unwrap(),
                    "{}",
                    case["name"]
                );
                assert_eq!(
                    json!({"ops":answer.ops,"created":answer.created,"warnings":answer.warnings}),
                    case["report"],
                    "{}",
                    case["name"]
                );
            }
        }
    }
    #[test]
    fn minted_ids_retry_collisions() {
        let first = crate::ledger::sha256_hex(b"hash:1")[..16].to_string();
        let next = crate::ledger::sha256_hex(b"hash:1:1")[..16].to_string();
        let source =
            json!({"nodes":[{"id":first,"type":"group","x":0,"y":0,"width":1,"height":1}]})
                .to_string();
        let answer = run(
            &source,
            "hash",
            json!([{"op":"add_node","type":"group","x":0,"y":0,"width":1,"height":1}]),
        )
        .unwrap();
        assert_eq!(answer.created, vec![Created { op: 1, id: next }]);
    }
    #[test]
    fn a_readback_mismatch_is_refused() {
        let args =
            json!({"ops":[{"op":"add_node","type":"group","x":0,"y":0,"width":1,"height":1}]});
        let request = parse_request(args.as_object().unwrap()).unwrap();
        let mut target = |_: &str| Target::Missing;
        let mut ctx = Context {
            limits: &super::super::agent_limits::table().edit,
            web_schemes: &[],
            target_state: &mut target,
            board_path: "boards/plan.canvas",
        };
        let answer = plan_with("{}", "hash", &request, &mut ctx, |_| "{}".into());
        assert_eq!(
            answer.unwrap_err(),
            "The changed board would not read back as planned, so it was left as it is."
        );
    }
}
