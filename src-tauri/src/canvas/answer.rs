//! Bounded, plain JSON read answers. Contents are data; this module opens no files.
use super::{
    agent_limits::ReadLimits,
    format::table,
    read::{Fields, Node, ReadBoard},
};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};

#[derive(Debug, Default)]
pub struct Request {
    pub start: Option<usize>,
    pub ids: Option<Vec<String>>,
}
impl Request {
    pub fn parse(args: &Value, limits: &ReadLimits) -> Result<Self, String> {
        let start = match args.get("start") {
            None => None,
            Some(value) => Some(
                value
                    .as_u64()
                    .filter(|n| *n > 0)
                    .and_then(|n| usize::try_from(n).ok())
                    .ok_or("start must be a whole node number from 1.")?,
            ),
        };
        let ids = match args.get("ids") {
            None => None,
            Some(value) => {
                let list = value
                    .as_array()
                    .ok_or("ids must be an array of node ids.")?;
                if list.len() > limits.ids {
                    return Err(format!(
                        "`ids` holds at most {} ids; this call has {}.",
                        limits.ids,
                        list.len()
                    ));
                }
                Some(
                    list.iter()
                        .map(|v| {
                            v.as_str()
                                .map(str::to_string)
                                .ok_or("ids must contain only node ids as text.".to_string())
                        })
                        .collect::<Result<Vec<_>, _>>()?,
                )
            }
        };
        if start.is_some() && ids.is_some() {
            return Err("Pass `start` or `ids`, not both.".into());
        }
        Ok(Self { start, ids })
    }
}
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Target {
    Exists,
    Missing,
    Unchecked,
    Outside,
}
#[derive(Serialize)]
struct Reply {
    board: Value,
    nodes: Vec<Value>,
    edges: Vec<Value>,
    hash: String,
    warnings: Vec<String>,
    truncated: bool,
    next_start: Option<usize>,
}
fn text(fields: &Fields, key: &str) -> Option<String> {
    fields
        .get(key)
        .and_then(|v| serde_json::from_str(v.get()).ok())
}
fn number(fields: &Fields, key: &str) -> i64 {
    fields[key].get().parse().expect("validated whole geometry")
}
fn known(fields: &Fields, kind: &str) -> Value {
    let mut values = serde_json::Map::new();
    for key in &table().key_order[kind] {
        if let Some(raw) = fields.get(key) {
            let value = if ["x", "y", "width", "height"].contains(&key.as_str()) {
                json!(number(fields, key))
            } else {
                serde_json::from_str(raw.get()).expect("validated known field")
            };
            values.insert(key.clone(), value);
        }
    }
    Value::Object(values)
}
fn node_value(
    node: &Node,
    n: usize,
    board: &ReadBoard,
    target: &mut impl FnMut(&str) -> Target,
) -> Value {
    let mut value = known(&node.fields, &node.node_type);
    value["n"] = json!(n);
    if node.node_type == "file" {
        value["target"] = json!(target(value["file"].as_str().expect("validated file")));
    }
    if node.node_type == "text" {
        if let Some(kind) = board
            .cards
            .get(&node.id)
            .and_then(|fields| text(fields, "shape"))
        {
            value["kind"] = json!(kind);
        }
    }
    value
}
fn summary(board: &ReadBoard) -> Value {
    let mut by_type: BTreeMap<&str, usize> = table().vocab["node_types"]
        .iter()
        .map(|kind| (kind.as_str(), 0))
        .collect();
    for node in &board.nodes {
        *by_type
            .get_mut(node.node_type.as_str())
            .expect("known type") += 1;
    }
    let mut bounds: Option<(i64, i64, i64, i64)> = None;
    for fields in board
        .nodes
        .iter()
        .map(|node| &node.fields)
        .chain(&board.ink)
    {
        let x = number(fields, "x");
        let y = number(fields, "y");
        let right = x + number(fields, "width");
        let bottom = y + number(fields, "height");
        bounds = Some(match bounds {
            None => (x, y, right, bottom),
            Some((left, top, r, b)) => (left.min(x), top.min(y), r.max(right), b.max(bottom)),
        });
    }
    json!({"nodes":board.nodes.len(),"edges":board.edges.len(),"by_type":by_type,
        "bounds":bounds.map(|(x,y,r,b)|json!({"x":x,"y":y,"width":r-x,"height":b-y})),
        "drawings":board.ink.len(),"cerebro":board.cerebro.as_ref().map(|_|table().cerebro_versions[0])})
}
fn encoded(reply: &Reply) -> String {
    serde_json::to_string(reply).expect("read answer serializes")
}
fn clipped(text: &str, chars: usize) -> String {
    text.chars().take(chars).collect()
}
/// Only the first selected node may be shortened: otherwise continuation starts
/// before the node, preserving all of its text on the next page.
fn fit_first(reply: &mut Reply, limit: usize, original_chars: usize) -> Result<(), String> {
    if encoded(reply).len() <= limit {
        return Ok(());
    }
    let warning = format!(
        "Node {} text was cut to fit; it holds {original_chars} characters.",
        reply.nodes[0]["id"].as_str().unwrap()
    );
    if !reply.warnings.iter().any(|word| word == &warning) {
        reply.warnings.push(warning);
    }
    loop {
        if encoded(reply).len() <= limit {
            return Ok(());
        }
        let node = reply.nodes[0].as_object_mut().expect("node object");
        let largest = node
            .iter()
            .filter(|(key, _)| !["id", "type", "target", "kind"].contains(&key.as_str()))
            .filter_map(|(key, value)| {
                value
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .map(|s| (key.clone(), s.chars().count()))
            })
            .max_by_key(|(_, len)| *len);
        let Some((key, length)) = largest else {
            return Err("The read byte limit is too small to return a whiteboard node.".into());
        };
        let old = node[&key].as_str().unwrap();
        node.insert(key, Value::String(clipped(old, length / 2)));
    }
}

pub fn answer(
    board: &ReadBoard,
    hash: &str,
    path: &str,
    request: &Request,
    limits: &ReadLimits,
    mut target: impl FnMut(&str) -> Target,
) -> Result<String, String> {
    if request.start.is_some_and(|start| start > board.nodes.len()) {
        return Err(format!(
            "`start` counts nodes from 1, and {path} has {}.",
            board.nodes.len()
        ));
    }
    let node_ids: HashSet<&str> = board.nodes.iter().map(|node| node.id.as_str()).collect();
    let requested = request
        .ids
        .as_ref()
        .map(|ids| ids.iter().map(String::as_str).collect::<HashSet<_>>());
    let mut reply = Reply {
        board: summary(board),
        nodes: vec![],
        edges: vec![],
        hash: hash.into(),
        warnings: vec![],
        truncated: false,
        next_start: None,
    };
    if let Some(ids) = &request.ids {
        let mut seen = HashSet::new();
        let mut omitted = 0;
        for id in ids.iter().filter(|id| !node_ids.contains(id.as_str())) {
            if seen.insert(id) {
                reply.warnings.push(format!(
                    "No node with id {} on this board.",
                    json!(clipped(id, table().limits.max_id_chars))
                ));
                // Unknown ids cannot crowd a selected first node out of its page.
                // Keep warning detail bounded, then count every omitted warning.
                if encoded(&reply).len() > limits.bytes / 2 {
                    reply.warnings.pop();
                    omitted += 1;
                }
            }
        }
        if omitted > 0 {
            reply.warnings.push(format!(
                "{omitted} other requested ids are not on this board."
            ));
        }
    }
    let candidates: Vec<_> = board
        .nodes
        .iter()
        .enumerate()
        .filter(|(index, node)| match &requested {
            Some(ids) => ids.contains(node.id.as_str()),
            None => index + 1 >= request.start.unwrap_or(1),
        })
        .collect();
    let candidate_count = candidates.len();
    let continuation = |shown: usize, next: usize| {
        if request.ids.is_some() {
            format!("Only {shown} of the {candidate_count} nodes asked for came back; ask for the rest in another call.")
        } else {
            format!("Only part of the board came back. Pass start {next} to read on.")
        }
    };
    let mut included_edges = HashSet::new();
    let mut content_cut = false;
    for (index, node) in candidates {
        if reply.nodes.len() >= limits.nodes {
            reply.truncated = true;
            reply.next_start = Some(index + 1);
            reply
                .warnings
                .push(continuation(reply.nodes.len(), index + 1));
            break;
        }
        let prior_nodes = reply.nodes.len();
        let prior_edges = reply.edges.len();
        reply
            .nodes
            .push(node_value(node, index + 1, board, &mut target));
        let mut added = Vec::new();
        for (edge_index, edge) in board.edges.iter().enumerate() {
            if included_edges.contains(&edge_index) {
                continue;
            }
            let from = text(edge, "fromNode").expect("validated end");
            let to = text(edge, "toNode").expect("validated end");
            if from != node.id && to != node.id {
                continue;
            }
            let mut value = known(edge, "edge");
            let missing: Vec<_> = [&from, &to]
                .into_iter()
                .filter(|id| !node_ids.contains(id.as_str()))
                .collect();
            if !missing.is_empty() {
                value["dangling"] = json!(missing);
            }
            reply.edges.push(value);
            added.push(edge_index);
        }
        // Reserve the continuation fields even while judging the last node.
        reply.truncated = true;
        reply.next_start = Some(index + 2);
        let continuation_index = reply.warnings.len();
        reply
            .warnings
            .push(continuation(reply.nodes.len(), index + 2));
        if encoded(&reply).len() > limits.bytes {
            if prior_nodes > 0 {
                reply.nodes.truncate(prior_nodes);
                reply.edges.truncate(prior_edges);
                reply.next_start = Some(index + 1);
                reply.warnings[continuation_index] = continuation(reply.nodes.len(), index + 1);
                break;
            }
            reply.edges.clear();
            content_cut = true;
            let original_chars = reply.nodes[0]
                .as_object()
                .unwrap()
                .values()
                .filter_map(Value::as_str)
                .map(|s| s.chars().count())
                .max()
                .unwrap_or(0);
            fit_first(&mut reply, limits.bytes, original_chars)?;
            if !added.is_empty() {
                let warning_index = reply.warnings.len();
                reply.warnings.push(format!(
                    "Node {} has more edges than fit; {} of {} came back.",
                    node.id,
                    added.len(),
                    added.len()
                ));
                fit_first(&mut reply, limits.bytes, original_chars)?;
                for edge_index in &added {
                    let edge = &board.edges[*edge_index];
                    let mut value = known(edge, "edge");
                    let missing: Vec<_> = [
                        text(edge, "fromNode").unwrap(),
                        text(edge, "toNode").unwrap(),
                    ]
                    .into_iter()
                    .filter(|id| !node_ids.contains(id.as_str()))
                    .collect();
                    if !missing.is_empty() {
                        value["dangling"] = json!(missing);
                    }
                    reply.edges.push(value);
                    if encoded(&reply).len() > limits.bytes {
                        reply.edges.pop();
                        break;
                    }
                }
                reply.warnings[warning_index] = format!(
                    "Node {} has more edges than fit; {} of {} came back.",
                    node.id,
                    reply.edges.len(),
                    added.len()
                );
                // Omitted edges remain eligible at the next node. Marking all
                // candidates would make that node look fully read on this page.
                added.truncate(reply.edges.len());
            }
        }
        reply.warnings.remove(continuation_index);
        included_edges.extend(added);
        reply.truncated = content_cut;
        reply.next_start = None;
    }
    let output = encoded(&reply);
    if output.len() > limits.bytes {
        return Err("The read byte limit is too small to return this whiteboard summary.".into());
    }
    Ok(output)
}
