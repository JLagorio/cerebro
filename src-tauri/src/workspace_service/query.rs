//! Test/tool-only projection into the existing shared schema/filter evaluator.
//! Exact tagged values remain canonical; unsupported query projections refuse.
use super::{
    types::{prototype::*, values::*},
    value,
};
use crate::vault::{entry::Entry, query as legacy, schema};
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

fn projection(value: &PropertyValue) -> Result<serde_json::Value> {
    match value {
        PropertyValue::Relation {
            spelling,
            resolution: RelationResolution::Resolved { .. },
            ..
        } => Ok(serde_json::Value::String(spelling.clone())),
        PropertyValue::Array { value } => Ok(serde_json::Value::Array(
            value.iter().map(projection).collect::<Result<_>>()?,
        )),
        _ => value::legacy_value(value).map_err(|e| error("unsupported_query_value", e.message)),
    }
}
pub(crate) fn entry(row: &RecordSnapshot, needed: Option<&BTreeSet<String>>) -> Result<Entry> {
    let source =
        std::str::from_utf8(&row.body).map_err(|_| error("invalid_body", "Body is not UTF-8."))?;
    let mut entry =
        crate::vault::entry::build_entry(&row.record.path, source, String::new(), String::new());
    entry.entry_type = match row.record.properties.get("type") {
        Some(PropertyValue::String { value }) => Some(value.clone()),
        None | Some(PropertyValue::Null {}) => None,
        _ => {
            return Err(error(
                "schema_invalid",
                "The type declaration must be text or absent.",
            ))
        }
    };
    entry.properties.clear();
    entry.relationships.clear();
    for (key, value) in &row.record.properties {
        if key == "type" {
            continue;
        }
        if !needed.is_none_or(|fields| fields.contains(key))
            && entry.entry_type.as_deref() != Some("Type")
        {
            continue;
        }
        let projected = projection(value)?;
        let relation = matches!(value, PropertyValue::Relation { .. })
            || matches!(value,PropertyValue::Array{value} if !value.is_empty() && value.iter().all(|v|matches!(v,PropertyValue::Relation{..})));
        if relation {
            let values = if let serde_json::Value::Array(values) = &projected {
                values.clone()
            } else {
                vec![projected.clone()]
            };
            let targets = values
                .iter()
                .flat_map(|v| {
                    v.as_str()
                        .map(crate::vault::parse::wikilink_targets)
                        .unwrap_or_default()
                })
                .collect::<Vec<_>>();
            if targets.is_empty() {
                return Err(error(
                    "unsupported_query_value",
                    "Relation spelling cannot be projected faithfully.",
                ));
            }
            entry.relationships.insert(key.clone(), targets);
        } else {
            entry.properties.insert(key.clone(), projected);
        }
    }
    Ok(entry)
}
pub(crate) fn validate_changes(
    rows: &[RecordSnapshot],
    candidate: &RecordSnapshot,
    keys: &[String],
) -> Result<()> {
    let table = schema::table().map_err(|e| error("schema_unavailable", e))?;
    let mut entries = Vec::new();
    for row in rows.iter().filter(|row|matches!(row.record.properties.get("type"),Some(PropertyValue::String{value}) if value=="Type")) {entries.push(entry(row,None)?);}
    let schema = schema::VaultSchema::from_entries(&entries, table);
    let candidate_entry = entry(candidate, Some(&BTreeSet::new()))?;
    for key in keys {
        if let Some(def) = schema.field_for(&candidate_entry, key) {
            if let Some(value) = candidate.record.properties.get(key) {
                schema::validate_value(def, &projection(value)?, table)
                    .map_err(|e| error("schema_invalid", e))?;
            }
        }
    }
    Ok(())
}
fn fields(node: &legacy::FilterNode, out: &mut BTreeSet<String>) {
    match node {
        legacy::FilterNode::Rule(rule) => {
            out.insert(rule.field.clone());
        }
        legacy::FilterNode::All(children) | legacy::FilterNode::Any(children) => {
            for child in children {
                fields(child, out);
            }
        }
    }
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    binding: String,
    offset: usize,
}
pub(crate) fn execute(
    scope: &PrototypeScope,
    rows: Vec<RecordSnapshot>,
    revision: u64,
    schema_revision: u64,
    request: &QueryRequest,
) -> Result<QueryPage> {
    let raw =
        serde_json::to_string(&request.query).map_err(|e| error("invalid_query", e.to_string()))?;
    value::decode_json(&raw, ValueSchema::Plain).map_err(|e| error("invalid_query", e.message))?;
    let object = request
        .query
        .as_object()
        .ok_or_else(|| error("invalid_query", "Query must be an object."))?;
    if object
        .keys()
        .any(|key| !["type", "filters", "sort"].contains(&key.as_str()))
    {
        return Err(error("invalid_query", "Unknown query property."));
    }
    let parsed =
        legacy::parse_request(&request.query).map_err(|p| error("invalid_query", p.message))?;
    let zone = request
        .zone
        .parse::<chrono_tz::Tz>()
        .map_err(|_| error("invalid_query", "Unknown time zone."))?;
    let today = chrono::NaiveDate::parse_from_str(&request.today, "%Y-%m-%d")
        .map_err(|_| error("invalid_query", "Invalid query day."))?;
    let mut needed = BTreeSet::new();
    if let Some(filter) = &parsed.filters {
        fields(filter, &mut needed);
    }
    needed.extend(parsed.sort.iter().map(|sort| sort.field.clone()));
    if needed
        .iter()
        .any(|field| ["createdAt", "modifiedAt"].contains(&field.as_str()))
    {
        return Err(error(
            "unsupported_query_value",
            "Creation/modification timestamps were not recorded by this prototype.",
        ));
    }
    let binding = crate::ledger::sha256_hex(
        format!(
            "{}|{revision}|{schema_revision}|{raw}|{}|{}",
            scope.fingerprint(),
            request.zone,
            request.today
        )
        .as_bytes(),
    );
    let offset = if let Some(raw) = &request.cursor {
        if raw.len() > 2048 {
            return Err(error("stale_cursor", "Cursor exceeds limit."));
        }
        let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(raw)
            .map_err(|_| error("stale_cursor", "Invalid cursor."))?;
        let cursor: Cursor = serde_json::from_slice(&decoded)
            .map_err(|_| error("stale_cursor", "Invalid cursor."))?;
        if cursor.binding != binding || cursor.offset == 0 || !cursor.offset.is_multiple_of(100) {
            return Err(error(
                "stale_cursor",
                "Cursor query, scope or snapshot changed.",
            ));
        }
        cursor.offset
    } else {
        0
    };
    let rows = rows
        .into_iter()
        .filter(|row| scope.can_read(&row.record.id))
        .collect::<Vec<_>>();
    let entries = rows
        .iter()
        .map(|row| entry(row, Some(&needed)))
        .collect::<Result<Vec<_>>>()?;
    let table = schema::table().map_err(|e| error("schema_unavailable", e))?;
    let schema = schema::VaultSchema::from_entries(&entries, table);
    let problems = legacy::check(&entries, &parsed, &schema, table, zone, today);
    if !problems.is_empty() {
        return Err(error(
            "invalid_query",
            problems
                .into_iter()
                .map(|p| p.message)
                .collect::<Vec<_>>()
                .join("; "),
        ));
    }
    let by_path = rows
        .iter()
        .map(|row| (row.record.path.as_str(), row))
        .collect::<BTreeMap<_, _>>();
    let mut source = legacy::source_for(&entries, parsed.type_name.as_deref())
        .map_err(|e| error("invalid_query", e))?;
    source.retain(|entry| {
        parsed
            .filters
            .as_ref()
            .is_none_or(|filter| legacy::evaluate(entry, filter, &schema, table, zone, today))
    });
    source.sort_by(|a, b| {
        by_path[a.path.as_str()]
            .record
            .id
            .cmp(&by_path[b.path.as_str()].record.id)
    });
    legacy::sort_rows(&mut source, &parsed.sort, &schema);
    if offset > source.len() {
        return Err(error("stale_cursor", "Cursor offset exceeds the snapshot."));
    }
    let page = source
        .iter()
        .skip(offset)
        .take(100)
        .map(|entry| (*by_path[entry.path.as_str()]).clone())
        .collect();
    let cursor = if offset + 100 < source.len() {
        Some(
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(
                serde_json::to_vec(&Cursor {
                    binding,
                    offset: offset + 100,
                })
                .map_err(|e| error("invalid_query", e.to_string()))?,
            ),
        )
    } else {
        None
    };
    Ok(QueryPage {
        rows: page,
        cursor,
        workspace_revision: revision,
        schema_revision,
    })
}
