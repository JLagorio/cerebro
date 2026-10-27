//! Structured reads over an already readable corpus (M62.2). The caller
//! supplies the time zone and day; this module performs no I/O and owns no
//! clock. Filter and sort semantics replay `fixtures/filter-cases.json`
//! against the TypeScript view, under D3.

use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};

use chrono::{NaiveDate, NaiveTime};
use chrono_tz::Tz;
use serde_json::{Map, Value};

use super::dates::{parse_date_text, read_date_value, resolve_relative};
use super::entry::Entry;
use super::schema::{self, FieldDef, FieldKind, KindTable, StatusSource, VaultSchema};

#[derive(Debug, Clone)]
pub(crate) struct Rule {
    pub field: String,
    pub op: String,
    pub value: Option<Value>,
}

#[derive(Debug, Clone)]
pub(crate) enum FilterNode {
    All(Vec<FilterNode>),
    Any(Vec<FilterNode>),
    Rule(Rule),
}

#[derive(Debug, Clone)]
pub(crate) struct SortSpec {
    pub field: String,
    pub descending: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct QueryRequest {
    pub type_name: Option<String>,
    pub filters: Option<FilterNode>,
    pub sort: Vec<SortSpec>,
    pub fields: Option<Vec<String>>,
    pub limit: usize,
    pub limit_cut: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Problem {
    pub position: String,
    pub message: String,
}

impl Problem {
    fn new(position: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            position: position.into(),
            message: message.into(),
        }
    }
}

fn refusal(problems: &[Problem]) -> String {
    format!(
        "Nothing was queried:\n{}",
        problems
            .iter()
            .map(|p| format!("- {}: {}", p.position, p.message))
            .collect::<Vec<_>>()
            .join("\n")
    )
}

fn parse_node(value: &Value, position: &str, group_only: bool) -> Result<FilterNode, Problem> {
    let shape = || Problem::new(position, "expected {\"all\": [...]} or {\"any\": [...]}");
    let map = value.as_object().ok_or_else(shape)?;
    if map.contains_key("all") || map.contains_key("any") {
        if map.len() != 1 {
            return Err(shape());
        }
        let all = map.contains_key("all");
        let key = if all { "all" } else { "any" };
        let children = map[key].as_array().ok_or_else(shape)?;
        let nodes = children
            .iter()
            .enumerate()
            .map(|(i, child)| parse_node(child, &format!("{position}.{key}[{i}]"), false))
            .collect::<Result<Vec<_>, _>>()?;
        return Ok(if all {
            FilterNode::All(nodes)
        } else {
            FilterNode::Any(nodes)
        });
    }
    if group_only {
        return Err(shape());
    }
    if map
        .keys()
        .any(|key| !["field", "op", "value"].contains(&key.as_str()))
    {
        return Err(Problem::new(position, "expected {field, op, value?}"));
    }
    let field = map
        .get("field")
        .and_then(Value::as_str)
        .ok_or_else(|| Problem::new(format!("{position}.field"), "expected a field name"))?;
    let op = map
        .get("op")
        .and_then(Value::as_str)
        .ok_or_else(|| Problem::new(format!("{position}.op"), "expected an operator name"))?;
    Ok(FilterNode::Rule(Rule {
        field: field.into(),
        op: op.into(),
        value: map.get("value").cloned(),
    }))
}

/// Shape errors stop parsing before semantic checks. The parser does not
/// invent a narrower request by dropping an unknown or unfinished condition.
pub(crate) fn parse_request(args: &Value) -> Result<QueryRequest, Problem> {
    let map = args
        .as_object()
        .ok_or_else(|| Problem::new("request", "expected an object"))?;
    let type_name = map
        .get("type")
        .map(|v| {
            v.as_str()
                .map(str::trim)
                .map(str::to_string)
                .ok_or_else(|| Problem::new("type", "expected a database name"))
        })
        .transpose()?;
    let filters = map
        .get("filters")
        .map(|v| parse_node(v, "filters", true))
        .transpose()?;
    let sort = if let Some(raw) = map.get("sort") {
        let list = raw
            .as_array()
            .ok_or_else(|| Problem::new("sort", "expected an array of {field, dir}"))?;
        list.iter()
            .enumerate()
            .map(|(i, row)| {
                let field = row.get("field").and_then(Value::as_str).ok_or_else(|| {
                    Problem::new(format!("sort[{i}].field"), "expected a field name")
                })?;
                let dir = row
                    .get("dir")
                    .and_then(Value::as_str)
                    .filter(|s| ["asc", "desc"].contains(s))
                    .ok_or_else(|| {
                        Problem::new(format!("sort[{i}].dir"), "expected asc or desc")
                    })?;
                Ok(SortSpec {
                    field: field.into(),
                    descending: dir == "desc",
                })
            })
            .collect::<Result<Vec<_>, Problem>>()?
    } else {
        Vec::new()
    };
    let fields = map
        .get("fields")
        .map(|raw| {
            let list = raw
                .as_array()
                .ok_or_else(|| Problem::new("fields", "expected an array of field names"))?;
            list.iter()
                .enumerate()
                .map(|(i, v)| {
                    v.as_str().map(str::to_string).ok_or_else(|| {
                        Problem::new(format!("fields[{i}]"), "expected a field name")
                    })
                })
                .collect()
        })
        .transpose()?;
    let requested_limit = map
        .get("limit")
        .map(|v| {
            v.as_f64()
                .filter(|n| n.is_finite() && n.floor() >= 1.0)
                .ok_or_else(|| Problem::new("limit", "expected a number of at least 1"))
        })
        .transpose()?
        .unwrap_or(50.0);
    Ok(QueryRequest {
        type_name,
        filters,
        sort,
        fields,
        limit: requested_limit.floor().min(100.0) as usize,
        limit_cut: requested_limit.floor() > 100.0,
    })
}

pub(crate) fn hidden_agent_field(entry_type: Option<&str>, key: &str) -> bool {
    entry_type == Some("Agent") && ["recent", "memory", "preferences"].contains(&key)
}

fn hidden_agent_key(entry: &Entry, key: &str) -> bool {
    hidden_agent_field(entry.entry_type.as_deref(), key)
}

/// The schema's precedence, with M59's private Agent state kept absent.
pub(crate) fn field_value(schema: &VaultSchema, entry: &Entry, name: &str) -> Option<Value> {
    if hidden_agent_key(entry, name) {
        None
    } else {
        schema.field_value(entry, name)
    }
}

fn is_template(entry: &Entry) -> bool {
    entry.path.starts_with("templates/")
}

fn type_names(entries: &[Entry]) -> Vec<String> {
    let mut names = BTreeSet::new();
    for entry in entries.iter().filter(|e| !is_template(e)) {
        if let Some(name) = &entry.entry_type {
            names.insert(name.clone());
        }
        if entry.entry_type.as_deref() == Some("Type") {
            names.insert(entry.title.clone());
        }
    }
    names.into_iter().collect()
}

fn suggested(name: &str, choices: &[String]) -> String {
    closest_name(name, choices)
        .map(|c| format!(" Closest: \"{c}\"."))
        .unwrap_or_default()
}

fn resolve_type(entries: &[Entry], wanted: &str) -> Result<String, String> {
    let names = type_names(entries);
    if let Some(name) = names.iter().find(|n| n.eq_ignore_ascii_case(wanted.trim())) {
        return Ok(name.clone());
    }
    Err(format!(
        "no note this run can read has type \"{wanted}\".{} Types in use: {}",
        suggested(wanted, &names),
        names.join(", ")
    ))
}

/// Receives only entries the run can read. A typed database includes its
/// knowledge pages; a typeless source is ordinary records, including untyped.
pub(crate) fn source_for<'a>(
    entries: &'a [Entry],
    type_name: Option<&str>,
) -> Result<Vec<&'a Entry>, String> {
    let wanted = type_name
        .map(|name| resolve_type(entries, name))
        .transpose()?;
    let mut source: Vec<_> = entries
        .iter()
        .filter(|entry| {
            !is_template(entry)
                && match &wanted {
                    Some(name) => entry.entry_type.as_ref() == Some(name),
                    None => {
                        entry.entry_type.as_deref() != Some("Type")
                            && !entry.path.starts_with("knowledge/")
                    }
                }
        })
        .collect();
    source.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(source)
}

/// Closest names are suggestions, never substitutions. Case wins, then
/// punctuation/spacing, then bounded Damerau-Levenshtein distance.
pub(crate) fn closest_name<'a>(wanted: &str, choices: &'a [String]) -> Option<&'a str> {
    let lower = wanted.to_lowercase();
    if let Some(name) = choices.iter().find(|name| name.to_lowercase() == lower) {
        return Some(name);
    }
    let spelling = |text: &str| {
        text.chars()
            .filter(|c| c.is_alphanumeric())
            .flat_map(char::to_lowercase)
            .collect::<String>()
    };
    let normalized = spelling(wanted);
    if !normalized.is_empty() {
        if let Some(name) = choices.iter().find(|name| spelling(name) == normalized) {
            return Some(name);
        }
    }
    let bound = if wanted.chars().count() >= 8 { 3 } else { 2 };
    choices
        .iter()
        .map(|name| (edit_distance(&lower, &name.to_lowercase(), bound), name))
        .filter(|(distance, _)| *distance <= bound)
        .min_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(b.1)))
        .map(|(_, name)| name.as_str())
}

fn edit_distance(a: &str, b: &str, bound: usize) -> usize {
    let a: Vec<_> = a.chars().collect();
    let b: Vec<_> = b.chars().collect();
    if a.len().abs_diff(b.len()) > bound {
        return bound + 1;
    }
    // Only the band that could still meet the bound is allocated. A long
    // authored field name must not allocate a quadratic edit-distance grid.
    let mut previous: BTreeMap<usize, usize> = (0..=b.len().min(bound)).map(|j| (j, j)).collect();
    let mut before_previous = BTreeMap::new();
    for i in 1..=a.len() {
        let mut row = BTreeMap::new();
        if i <= bound {
            row.insert(0, i);
        }
        for j in 1.max(i.saturating_sub(bound))..=b.len().min(i + bound) {
            let mut distance = (previous.get(&j).copied().unwrap_or(bound + 1) + 1)
                .min(row.get(&(j - 1)).copied().unwrap_or(bound + 1) + 1)
                .min(
                    previous.get(&(j - 1)).copied().unwrap_or(bound + 1)
                        + usize::from(a[i - 1] != b[j - 1]),
                );
            if i > 1 && j > 1 && a[i - 1] == b[j - 2] && a[i - 2] == b[j - 1] {
                distance =
                    distance.min(before_previous.get(&(j - 2)).copied().unwrap_or(bound + 1) + 1);
            }
            row.insert(j, distance);
        }
        if row.values().all(|value| *value > bound) {
            return bound + 1;
        }
        before_previous = previous;
        previous = row;
    }
    previous.get(&b.len()).copied().unwrap_or(bound + 1)
}

fn computed(def: &FieldDef) -> Option<&'static str> {
    match def.kind {
        FieldKind::Rollup => Some("a rollup"),
        FieldKind::Formula => Some("a formula"),
        FieldKind::Person | FieldKind::Relation if def.from.is_some() => {
            Some("the other side of a relation")
        }
        _ => None,
    }
}

#[derive(Debug)]
pub(crate) struct FieldInfo {
    pub kind: FieldKind,
    def: Option<FieldDef>,
    conflicting: bool,
    pub options: Vec<(String, String)>,
    pub recorded: Vec<Value>,
}

impl FieldInfo {
    /// Metadata facts for a held canonical field; this never grants access.
    pub(crate) fn held(kind: FieldKind) -> Self {
        Self {
            kind,
            def: None,
            conflicting: false,
            options: Vec::new(),
            recorded: Vec::new(),
        }
    }
    pub(crate) fn declared(&self) -> Option<&FieldDef> {
        self.def.as_ref()
    }
    pub(crate) fn is_conflicting(&self) -> bool {
        self.conflicting
    }
}

pub(crate) fn field_infos(
    source: &[&Entry],
    wanted: Option<&str>,
    schema: &VaultSchema,
    table: &KindTable,
) -> BTreeMap<String, FieldInfo> {
    let mut infos = BTreeMap::new();
    let mut types: BTreeSet<&str> = source
        .iter()
        .filter_map(|entry| entry.entry_type.as_deref())
        .collect();
    if let Some(name) = wanted {
        types.insert(name);
    }
    for name in types {
        if let Some(own) = schema.type_named(name) {
            for def in &own.fields {
                if hidden_agent_field(Some(name), &def.name) {
                    continue;
                }
                let options: Vec<(String, String)> = if def.kind == FieldKind::Status {
                    let statuses = if own.statuses.is_empty() {
                        &table.default_statuses
                    } else {
                        &own.statuses
                    };
                    statuses
                        .iter()
                        .map(|s| (s.id.clone(), s.label.clone()))
                        .collect()
                } else {
                    def.options
                        .as_ref()
                        .map(|opts| {
                            opts.iter()
                                .map(|o| (o.id.clone(), o.label.clone()))
                                .collect()
                        })
                        .unwrap_or_default()
                };
                let info = infos.entry(def.name.clone()).or_insert_with(|| FieldInfo {
                    kind: def.kind,
                    def: Some(def.clone()),
                    conflicting: false,
                    options: options.clone(),
                    recorded: Vec::new(),
                });
                if info.def.as_ref() != Some(def) || info.options != options {
                    info.conflicting = true;
                }
            }
        }
    }
    for entry in source {
        for key in entry.properties.keys().chain(entry.relationships.keys()) {
            if hidden_agent_key(entry, key) {
                continue;
            }
            infos.entry(key.clone()).or_insert_with(|| FieldInfo {
                kind: FieldKind::Text,
                def: None,
                conflicting: false,
                options: Vec::new(),
                recorded: Vec::new(),
            });
        }
        for (name, info) in &mut infos {
            if let Some(value) = field_value(schema, entry, name) {
                info.recorded.extend(
                    items(&value)
                        .into_iter()
                        .filter(|v| scalar_text(v).is_some())
                        .cloned(),
                );
            }
            if info.kind == FieldKind::Status
                && schema
                    .field_for(entry, name)
                    .is_some_and(|def| def.kind == FieldKind::Status)
            {
                for status in schema.status_set_for(entry).0 {
                    if !info.options.iter().any(|(id, _)| id == &status.id) {
                        info.options.push((status.id, status.label));
                    }
                }
            }
        }
    }
    for name in &table.virtual_fields {
        let kind = if ["createdAt", "modifiedAt"].contains(&name.as_str()) {
            FieldKind::Date
        } else {
            FieldKind::Text
        };
        infos.insert(
            name.clone(),
            FieldInfo {
                kind,
                def: None,
                conflicting: false,
                options: Vec::new(),
                recorded: Vec::new(),
            },
        );
    }
    infos
}

fn check_field<'a>(
    name: &str,
    position: &str,
    wanted: Option<&str>,
    infos: &'a BTreeMap<String, FieldInfo>,
    problems: &mut Vec<Problem>,
) -> Option<&'a FieldInfo> {
    let Some(info) = infos.get(name) else {
        let names: Vec<_> = infos.keys().cloned().collect();
        problems.push(Problem::new(
            position,
            format!(
                "\"{name}\" is not a field of {}.{} Fields: {}",
                wanted.unwrap_or("the readable records"),
                suggested(name, &names),
                names.join(", ")
            ),
        ));
        return None;
    };
    if info.conflicting {
        problems.push(Problem::new(
            position,
            format!("{name} is declared differently by these databases; name one type"),
        ));
        return None;
    }
    if let Some(kind) = info.def.as_ref().and_then(computed) {
        problems.push(Problem::new(
            position,
            format!("{name} is {kind}, which only the app computes, so it can't be queried here"),
        ));
        return None;
    }
    Some(info)
}

fn arity(op: &str) -> &'static str {
    match op {
        "is_empty" | "is_not_empty" => "no value",
        "any_of" | "none_of" => "a list of values",
        "is_between" => "two values, [low, high]",
        _ => "one value",
    }
}

fn scalar(value: &Value) -> bool {
    value.is_string() || value.is_number() || value.is_boolean()
}
fn present(value: &Value) -> bool {
    !value.is_null() && value.as_str() != Some("")
}

fn check_rule(
    rule: &Rule,
    position: &str,
    wanted: Option<&str>,
    infos: &BTreeMap<String, FieldInfo>,
    table: &KindTable,
    calendar: (Tz, NaiveDate),
    problems: &mut Vec<Problem>,
) {
    let info = check_field(&rule.field, position, wanted, infos, problems);
    if !table.filter_ops.contains(&rule.op) {
        problems.push(Problem::new(
            position,
            format!(
                "\"{}\" is not an operator.{}",
                rule.op,
                suggested(&rule.op, &table.filter_ops)
            ),
        ));
        return;
    }
    let Some(info) = info else {
        return;
    };
    check_rule_value(rule, position, info, table, Some(calendar), problems);
}

// A view is evaluated by the app. Its checker reuses the query's value rules,
// but has no clock: relative dates remain authored tokens and bounds involving
// them are not ordered here. The fixed day below only validates token syntax.
pub(crate) fn check_view_rule_value(
    rule: &Rule,
    info: &FieldInfo,
    table: &KindTable,
) -> Vec<String> {
    let value_info = FieldInfo {
        kind: info.kind,
        def: None,
        conflicting: false,
        options: Vec::new(),
        recorded: Vec::new(),
    };
    let mut problems = Vec::new();
    check_rule_value(rule, "", &value_info, table, None, &mut problems);
    problems.into_iter().map(|p| p.message).collect()
}

fn check_rule_value(
    rule: &Rule,
    position: &str,
    info: &FieldInfo,
    table: &KindTable,
    calendar: Option<(Tz, NaiveDate)>,
    problems: &mut Vec<Problem>,
) {
    let (zone, today) = calendar.unwrap_or((
        chrono_tz::UTC,
        NaiveDate::from_ymd_opt(2000, 1, 2).expect("syntax anchor is a valid day"),
    ));
    let family = &table.facts(info.kind).filters;
    let ops = &table.filter_families[family];
    if !ops.contains(&rule.op) {
        problems.push(Problem::new(
            position,
            format!(
                "{} doesn't apply to {} ({}); it takes {}",
                rule.op,
                rule.field,
                info.kind.id(),
                ops.join(", ")
            ),
        ));
        return;
    }
    let values: Vec<&Value> = match rule.op.as_str() {
        "is_empty" | "is_not_empty" => {
            if rule.value.is_some() {
                problems.push(Problem::new(
                    position,
                    format!("{} takes no value", rule.op),
                ));
            }
            return;
        }
        "is_between" => match rule
            .value
            .as_ref()
            .and_then(Value::as_array)
            .filter(|v| v.len() == 2 && v.iter().all(|v| scalar(v) && present(v)))
        {
            Some(values) => values.iter().collect(),
            None => Vec::new(),
        },
        "any_of" | "none_of" => match rule
            .value
            .as_ref()
            .and_then(Value::as_array)
            .filter(|v| !v.is_empty() && v.iter().all(|v| scalar(v) && present(v)))
        {
            Some(values) => values.iter().collect(),
            None => Vec::new(),
        },
        _ => rule
            .value
            .as_ref()
            .filter(|v| scalar(v) && present(v))
            .into_iter()
            .collect(),
    };
    if values.is_empty() {
        problems.push(Problem::new(
            position,
            format!("{} takes {}", rule.op, arity(&rule.op)),
        ));
        return;
    }
    let mut valid = true;
    for value in &values {
        let problem = match family.as_str() {
            "number" if numeric_text(value).is_none() => Some(format!("{} compares numbers, and {value} is not a number", rule.field)),
            "date" if !value.as_str().is_some_and(|v| parse_date_text(v, &zone).is_some() || resolve_relative(v, today, 0).is_some()) => Some(format!("{} compares dates, and {value} is not a date: use YYYY-MM-DD, YYYY-MM-DD HH:MM or a relative date such as today-7 or this_week", rule.field)),
            "boolean" if !value.is_boolean() => Some(format!("{} is a checkbox; use true or false", rule.field)),
            _ => None,
        };
        if let Some(problem) = problem {
            valid = false;
            problems.push(Problem::new(position, problem));
        }
        if !info.options.is_empty()
            && !info.recorded.contains(value)
            && !info
                .options
                .iter()
                .any(|(id, _)| value.as_str() == Some(id))
        {
            valid = false;
            let message = if let Some((id, _)) = info
                .options
                .iter()
                .find(|(_, label)| value.as_str() == Some(label))
            {
                format!("{value} is the label of {id}; filters take option ids, so use \"{id}\"")
            } else {
                let ids: Vec<_> = info.options.iter().map(|(id, _)| id.clone()).collect();
                format!(
                    "{value} is not an option of {}.{}",
                    rule.field,
                    suggested(value.as_str().unwrap_or_default(), &ids)
                )
            };
            problems.push(Problem::new(position, message));
        }
    }
    if valid
        && rule.op == "is_between"
        && (calendar.is_some()
            || !values.iter().any(|value| {
                value
                    .as_str()
                    .is_some_and(|text| resolve_relative(text, today, 0).is_some())
            }))
        && bounds_reversed(values[0], values[1], family, zone, today)
    {
        problems.push(Problem::new(
            position,
            format!(
                "is_between takes [low, high]; {} is after {}",
                values[0], values[1]
            ),
        ));
    }
}

fn bounds_reversed(low: &Value, high: &Value, family: &str, zone: Tz, today: NaiveDate) -> bool {
    if family != "date" {
        return compare(low, high, true, zone, today) == Some(Ordering::Greater);
    }
    let bound = |raw: &Value, upper: bool| {
        let text = raw.as_str()?;
        if let Some((start, end)) = resolve_relative(text, today, 0) {
            return Some((
                if upper { end } else { start },
                if upper {
                    NaiveTime::from_hms_opt(23, 59, 0)?
                } else {
                    NaiveTime::MIN
                },
            ));
        }
        let endpoint = parse_date_text(text, &zone)?;
        Some((
            endpoint.date,
            endpoint.time.unwrap_or(if upper {
                NaiveTime::from_hms_opt(23, 59, 0)?
            } else {
                NaiveTime::MIN
            }),
        ))
    };
    match (bound(low, false), bound(high, true)) {
        (Some(a), Some(b)) => a > b,
        _ => false,
    }
}

/// Every semantic problem is returned before execution, at its authored JSON
/// position. Names are drawn only from the already scoped source and schema.
pub(crate) fn check(
    entries: &[Entry],
    request: &QueryRequest,
    schema: &VaultSchema,
    table: &KindTable,
    zone: Tz,
    today: NaiveDate,
) -> Vec<Problem> {
    let mut problems = Vec::new();
    let wanted = match request
        .type_name
        .as_deref()
        .map(|n| resolve_type(entries, n))
        .transpose()
    {
        Ok(name) => name,
        Err(error) => {
            problems.push(Problem::new("type", error));
            None
        }
    };
    let source = source_for(entries, wanted.as_deref()).unwrap_or_default();
    let infos = field_infos(&source, wanted.as_deref(), schema, table);
    fn visit(
        node: &FilterNode,
        position: &str,
        depth: usize,
        count: &mut usize,
        deepest: &mut usize,
        check: &mut dyn FnMut(&Rule, &str),
    ) {
        match node {
            FilterNode::Rule(rule) => {
                *count += 1;
                check(rule, position);
            }
            FilterNode::All(nodes) | FilterNode::Any(nodes) => {
                *deepest = (*deepest).max(depth);
                let name = if matches!(node, FilterNode::All(_)) {
                    "all"
                } else {
                    "any"
                };
                for (i, node) in nodes.iter().enumerate() {
                    visit(
                        node,
                        &format!("{position}.{name}[{i}]"),
                        depth + 1,
                        count,
                        deepest,
                        check,
                    );
                }
            }
        }
    }
    if let Some(filter) = &request.filters {
        let mut count = 0;
        let mut deepest = 0;
        visit(
            filter,
            "filters",
            1,
            &mut count,
            &mut deepest,
            &mut |rule, position| {
                check_rule(
                    rule,
                    position,
                    wanted.as_deref(),
                    &infos,
                    table,
                    (zone, today),
                    &mut problems,
                )
            },
        );
        if count > 40 {
            problems.push(Problem::new("filters", "at most 40 conditions"));
        }
        if deepest > 3 {
            problems.push(Problem::new("filters", "at most 3 levels of nested groups"));
        }
    }
    if request.sort.len() > 4 {
        problems.push(Problem::new("sort", "at most 4 sort keys"));
    }
    for (i, spec) in request.sort.iter().enumerate() {
        let pos = format!("sort[{i}].field");
        if let Some(info) = check_field(&spec.field, &pos, wanted.as_deref(), &infos, &mut problems)
        {
            let facts = table.facts(info.kind);
            if info.kind == FieldKind::Daterange {
                problems.push(Problem::new(
                    pos,
                    format!(
                        "{} holds date ranges, which can't be sorted yet",
                        spec.field
                    ),
                ));
            } else if facts.multi && !info.def.as_ref().is_some_and(|def| def.limit_one) {
                problems.push(Problem::new(
                    pos,
                    format!("{} holds several values, so it can't be sorted", spec.field),
                ));
            }
        }
    }
    if let Some(fields) = &request.fields {
        if fields.len() > 30 {
            problems.push(Problem::new("fields", "at most 30 fields"));
        }
        for (i, name) in fields.iter().enumerate() {
            check_field(
                name,
                &format!("fields[{i}]"),
                wanted.as_deref(),
                &infos,
                &mut problems,
            );
        }
    }
    problems
}

/// Decimal grammar from TypeScript's numericText, with exactly its ASCII
/// whitespace. Hex, booleans, arrays and absence never become numbers.
pub(crate) fn numeric_text(value: &Value) -> Option<f64> {
    if let Some(number) = value.as_f64() {
        return number.is_finite().then_some(number);
    }
    let text = value
        .as_str()?
        .trim_matches([' ', '\t', '\n', '\x0c', '\r']);
    let bytes = text.as_bytes();
    let mut i = 0;
    if bytes.first().is_some_and(|b| *b == b'+' || *b == b'-') {
        i += 1;
    }
    let integer_start = i;
    while bytes.get(i).is_some_and(u8::is_ascii_digit) {
        i += 1;
    }
    let integer_digits = i - integer_start;
    let mut fractional_digits = 0;
    if bytes.get(i) == Some(&b'.') {
        i += 1;
        let start = i;
        while bytes.get(i).is_some_and(u8::is_ascii_digit) {
            i += 1;
        }
        fractional_digits = i - start;
    }
    if integer_digits + fractional_digits == 0 {
        return None;
    }
    if bytes.get(i).is_some_and(|b| *b == b'e' || *b == b'E') {
        i += 1;
        if bytes.get(i).is_some_and(|b| *b == b'+' || *b == b'-') {
            i += 1;
        }
        let start = i;
        while bytes.get(i).is_some_and(u8::is_ascii_digit) {
            i += 1;
        }
        if i == start {
            return None;
        }
    }
    if i != bytes.len() {
        return None;
    }
    text.parse::<f64>().ok().filter(|n| n.is_finite())
}

fn items(value: &Value) -> Vec<&Value> {
    match value {
        Value::Array(values) => values.iter().collect(),
        _ => vec![value],
    }
}
fn first(value: &Value) -> &Value {
    value
        .as_array()
        .map(|values| values.first().unwrap_or(&Value::Null))
        .unwrap_or(value)
}
fn empty(value: &Value) -> bool {
    value.is_null() || value.as_str() == Some("") || value.as_array().is_some_and(Vec::is_empty)
}
fn strict_equal(a: &Value, b: &Value) -> bool {
    match (a.as_f64(), b.as_f64()) {
        (Some(a), Some(b)) => a == b,
        _ => scalar(a) && scalar(b) && a == b,
    }
}
fn scalar_text(value: &Value) -> Option<String> {
    match value {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

fn compare(
    raw: &Value,
    target: &Value,
    relative: bool,
    zone: Tz,
    today: NaiveDate,
) -> Option<Ordering> {
    if empty(raw) || empty(target) {
        return None;
    }
    if let Some((start, end)) = target
        .as_str()
        .filter(|_| relative)
        .and_then(|s| resolve_relative(s, today, 0))
    {
        let day = read_date_value(raw, &zone)?.start.date;
        return Some(if day < start {
            Ordering::Less
        } else if day > end {
            Ordering::Greater
        } else {
            Ordering::Equal
        });
    }
    match (numeric_text(raw), numeric_text(target)) {
        (Some(a), Some(b)) => return a.partial_cmp(&b),
        (Some(_), None) | (None, Some(_)) => return None,
        (None, None) => {}
    }
    if let Some(bounds) = target.as_str().and_then(|s| parse_date_text(s, &zone)) {
        let item = read_date_value(raw, &zone)?.start;
        return Some(if let Some(time) = bounds.time {
            (item.date, item.time.unwrap_or(NaiveTime::MIN)).cmp(&(bounds.date, time))
        } else {
            item.date.cmp(&bounds.date)
        });
    }
    Some(scalar_text(raw)?.cmp(&scalar_text(target)?))
}

fn eval_rule(
    entry: &Entry,
    rule: &Rule,
    schema: &VaultSchema,
    table: &KindTable,
    zone: Tz,
    today: NaiveDate,
) -> bool {
    let value = field_value(schema, entry, &rule.field).unwrap_or(Value::Null);
    let target = rule.value.as_ref().unwrap_or(&Value::Null);
    let family = schema
        .field_for(entry, &rule.field)
        .map(|def| table.facts(def.kind).filters.as_str());
    let relative = !["title", "type"].contains(&rule.field.as_str())
        && family.is_none_or(|f| f == "date" || f == "any");
    let equals = || {
        let is_token = relative
            && target
                .as_str()
                .is_some_and(|s| resolve_relative(s, today, 0).is_some());
        items(&value).into_iter().any(|item| {
            (!is_token && !item.is_null() && scalar(item) && item == target)
                || compare(item, target, relative, zone, today) == Some(Ordering::Equal)
        })
    };
    let text_matches = |test: fn(&str, &str) -> bool| {
        scalar_text(target)
            .filter(|s| !s.is_empty())
            .is_some_and(|target| {
                items(&value)
                    .into_iter()
                    .filter_map(scalar_text)
                    .any(|text| test(&text.to_lowercase(), &target.to_lowercase()))
            })
    };
    let any = || {
        items(&value).into_iter().any(|item| {
            !item.is_null()
                && scalar(item)
                && items(target)
                    .into_iter()
                    .any(|target| strict_equal(item, target))
        })
    };
    let ordered = |target: &Value, keep: fn(Ordering) -> bool| {
        compare(first(&value), target, relative, zone, today).is_some_and(keep)
    };
    match rule.op.as_str() {
        "is_empty" => empty(&value),
        "is_not_empty" => !empty(&value),
        "equals" => equals(),
        "not_equals" => !equals(),
        "contains" => text_matches(|a, b| a.contains(b)),
        "does_not_contain" => !text_matches(|a, b| a.contains(b)),
        "starts_with" => text_matches(|a, b| a.starts_with(b)),
        "ends_with" => text_matches(|a, b| a.ends_with(b)),
        "any_of" => any(),
        "none_of" => !any(),
        "gt" | "after" => ordered(target, |c| c.is_gt()),
        "gte" | "on_or_after" => ordered(target, |c| !c.is_lt()),
        "lt" | "before" => ordered(target, |c| c.is_lt()),
        "lte" | "on_or_before" => ordered(target, |c| !c.is_gt()),
        "is_between" => target.as_array().is_some_and(|bounds| {
            bounds.len() == 2
                && ordered(&bounds[0], |c| !c.is_lt())
                && ordered(&bounds[1], |c| !c.is_gt())
        }),
        _ => false,
    }
}

pub(crate) fn evaluate(
    entry: &Entry,
    node: &FilterNode,
    schema: &VaultSchema,
    table: &KindTable,
    zone: Tz,
    today: NaiveDate,
) -> bool {
    match node {
        FilterNode::All(nodes) => nodes
            .iter()
            .all(|n| evaluate(entry, n, schema, table, zone, today)),
        FilterNode::Any(nodes) => nodes
            .iter()
            .any(|n| evaluate(entry, n, schema, table, zone, today)),
        FilterNode::Rule(rule) => eval_rule(entry, rule, schema, table, zone, today),
    }
}

fn sort_text(value: &Value) -> String {
    match value {
        Value::Object(_) => "[object Object]".into(),
        Value::Array(values) => values.iter().map(sort_text).collect::<Vec<_>>().join(","),
        Value::Null => String::new(),
        _ => scalar_text(value).unwrap_or_default(),
    }
}
pub(crate) fn text_order(a: &str, b: &str) -> Ordering {
    a.to_lowercase().cmp(&b.to_lowercase()).then_with(|| {
        // Equal letters put lowercase before uppercase, as the app's locale
        // ordering does for the pinned ASCII cases. Unicode quirks are named.
        for (a, b) in a.chars().zip(b.chars()) {
            let case = b.is_lowercase().cmp(&a.is_lowercase());
            if !case.is_eq() {
                return case;
            }
        }
        a.cmp(b)
    })
}

pub(crate) fn sort_rows(rows: &mut [&Entry], sort: &[SortSpec], schema: &VaultSchema) {
    let ranks: Vec<Option<Vec<String>>> = sort
        .iter()
        .map(|spec| {
            rows.iter()
                .find_map(|entry| {
                    schema.field_for(entry, &spec.field).map(|def| {
                        if def.kind == FieldKind::Status {
                            Some(
                                schema
                                    .status_set_for(entry)
                                    .0
                                    .into_iter()
                                    .map(|s| s.id)
                                    .collect(),
                            )
                        } else {
                            def.options
                                .as_ref()
                                .filter(|o| !o.is_empty())
                                .map(|o| o.iter().map(|o| o.id.clone()).collect())
                        }
                    })
                })
                .flatten()
        })
        .collect();
    rows.sort_by(|a, b| {
        for (spec, ranks) in sort.iter().zip(&ranks) {
            let a = field_value(schema, a, &spec.field).unwrap_or(Value::Null);
            let a = first(&a);
            let b = field_value(schema, b, &spec.field).unwrap_or(Value::Null);
            let b = first(&b);
            let (ea, eb) = (empty(a), empty(b));
            let result = if ea || eb {
                ea.cmp(&eb)
            } else {
                let ranks = ranks.as_ref().map(|r| {
                    (
                        r.iter().position(|v| v == &sort_text(a)),
                        r.iter().position(|v| v == &sort_text(b)),
                    )
                });
                match ranks {
                    Some((Some(_), None)) => Ordering::Less,
                    Some((None, Some(_))) => Ordering::Greater,
                    _ => {
                        let result = if let Some((Some(a), Some(b))) = ranks {
                            a.cmp(&b)
                        } else if let (Some(a), Some(b)) = (a.as_f64(), b.as_f64()) {
                            a.partial_cmp(&b).unwrap_or(Ordering::Equal)
                        } else {
                            text_order(&sort_text(a), &sort_text(b))
                        };
                        if spec.descending {
                            result.reverse()
                        } else {
                            result
                        }
                    }
                }
            };
            if !result.is_eq() {
                return result;
            }
        }
        Ordering::Equal
    });
}

fn scope(withheld: usize) -> String {
    match withheld {
        0 => String::new(),
        1 => " (1 note outside this run's read scope was not read)".into(),
        n => format!(" ({n} notes outside this run's read scope were not read)"),
    }
}
fn count_word(n: usize, singular: &str) -> String {
    if n == 1 {
        singular.into()
    } else {
        format!("{singular}s")
    }
}
fn record_words(name: Option<&str>, count: usize) -> String {
    format!(
        "{}{}",
        name.map(|n| format!("{n} ")).unwrap_or_default(),
        count_word(count, "record")
    )
}
fn type_counts(rows: &[&Entry]) -> Vec<(String, usize)> {
    let mut counts = BTreeMap::new();
    let mut untyped = 0;
    for entry in rows {
        if let Some(name) = &entry.entry_type {
            *counts.entry(name.clone()).or_default() += 1;
        } else {
            untyped += 1;
        }
    }
    let mut out: Vec<_> = counts.into_iter().collect();
    if untyped > 0 {
        out.push(("untyped".into(), untyped));
    }
    out
}
fn declared_names(source: &[&Entry], wanted: Option<&str>, schema: &VaultSchema) -> Vec<String> {
    let mut names = Vec::new();
    let mut types: Vec<_> = source
        .iter()
        .filter_map(|e| e.entry_type.as_deref())
        .collect();
    if let Some(name) = wanted {
        types.insert(0, name);
    }
    for name in types {
        if let Some(own) = schema.type_named(name) {
            for def in &own.fields {
                if hidden_agent_field(Some(name), &def.name) {
                    continue;
                }
                if !names.contains(&def.name) {
                    names.push(def.name.clone());
                }
            }
        }
    }
    names
}
fn held_keys(source: &[&Entry], declared: &[String]) -> Vec<(String, usize)> {
    let mut held = BTreeMap::new();
    for entry in source {
        let keys: BTreeSet<_> = entry
            .properties
            .keys()
            .chain(entry.relationships.keys())
            .collect();
        for key in keys {
            if !declared.contains(key)
                && !["title", "type", "createdAt", "modifiedAt"].contains(&key.as_str())
                && !hidden_agent_key(entry, key)
            {
                *held.entry(key.clone()).or_default() += 1;
            }
        }
    }
    held.into_iter().collect()
}
fn held_text(held: &[(String, usize)]) -> Option<String> {
    (!held.is_empty()).then(|| {
        format!(
            "Also held, not declared (read as text): {}",
            held.iter()
                .map(|(key, n)| format!("{key} ({n} {})", count_word(*n, "record")))
                .collect::<Vec<_>>()
                .join(", ")
        )
    })
}
fn field_details(
    name: &str,
    info: &FieldInfo,
    source: &[&Entry],
    schema: &VaultSchema,
    table: &KindTable,
    wanted: Option<&str>,
) -> String {
    let mut details = Vec::new();
    if let Some(def) = &info.def {
        if let Some(target) = &def.target {
            details.push(format!("links to {target}"));
        }
        if table.facts(def.kind).multi {
            details.push(if def.limit_one {
                "one value".into()
            } else {
                "several values".into()
            });
        } else {
            details.push("one value".into());
        }
        if def.kind == FieldKind::Status {
            let representative = source.iter().find(|e| schema.field_for(e, name).is_some());
            let (statuses, origin) = if let Some(entry) = representative {
                schema.status_set_for(entry)
            } else {
                (
                    wanted
                        .and_then(|n| schema.type_named(n))
                        .map(|t| t.statuses.clone())
                        .filter(|s| !s.is_empty())
                        .unwrap_or_else(|| table.default_statuses.clone()),
                    StatusSource::Default,
                )
            };
            let from = match origin {
                StatusSource::Project => representative
                    .and_then(|e| e.project.as_deref())
                    .unwrap_or("project"),
                StatusSource::Type => representative
                    .and_then(|e| e.entry_type.as_deref())
                    .or(wanted)
                    .unwrap_or("database"),
                StatusSource::Default => "the app's defaults",
            };
            details.push(format!(
                "statuses from {from}: {}",
                statuses
                    .iter()
                    .map(|s| format!("{} \"{}\" ({})", s.id, s.label, s.group))
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        } else if !info.options.is_empty() {
            details.push(format!(
                "options: {}",
                info.options
                    .iter()
                    .map(|(id, label)| format!("{id} \"{label}\""))
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
        if computed(def).is_some() {
            details.push("computed by the app, so it can't be queried".into());
        }
    } else {
        details.push("one value".into());
    }
    details.join("; ")
}
fn column_line(
    name: &str,
    info: &FieldInfo,
    source: &[&Entry],
    schema: &VaultSchema,
    table: &KindTable,
    wanted: Option<&str>,
) -> String {
    format!(
        "- {name}: {} — {}",
        info.kind.id(),
        field_details(name, info, source, schema, table, wanted)
    )
}
fn cut_value(value: Value, count: &mut usize) -> Value {
    match value {
        Value::String(text) if text.chars().count() > 300 => {
            *count += 1;
            Value::String(format!("{}…", text.chars().take(300).collect::<String>()))
        }
        Value::Array(values) => {
            Value::Array(values.into_iter().map(|v| cut_value(v, count)).collect())
        }
        Value::Object(values) => Value::Object(
            values
                .into_iter()
                .map(|(k, v)| (k, cut_value(v, count)))
                .collect(),
        ),
        value => value,
    }
}
fn used_filter_fields(node: &FilterNode, out: &mut Vec<String>) {
    match node {
        FilterNode::Rule(rule) => out.push(rule.field.clone()),
        FilterNode::All(nodes) | FilterNode::Any(nodes) => {
            for node in nodes {
                used_filter_fields(node, out);
            }
        }
    }
}

/// Render one checked query. Its rows and all explanatory counts are drawn
/// from the readable source, never from the withheld corpus.
pub(crate) fn answer_text(
    entries: &[Entry],
    request: &QueryRequest,
    schema: &VaultSchema,
    table: &KindTable,
    zone: Tz,
    today: NaiveDate,
    withheld: usize,
) -> Result<String, String> {
    let problems = check(entries, request, schema, table, zone, today);
    if !problems.is_empty() {
        return Err(refusal(&problems));
    }
    let wanted = request
        .type_name
        .as_deref()
        .map(|name| resolve_type(entries, name))
        .transpose()?;
    let source = source_for(entries, wanted.as_deref())?;
    let infos = field_infos(&source, wanted.as_deref(), schema, table);
    let declared = declared_names(&source, wanted.as_deref(), schema);
    let chosen = request.fields.clone().unwrap_or_else(|| {
        if declared.is_empty() {
            held_keys(&source, &declared)
                .into_iter()
                .map(|(key, _)| key)
                .collect()
        } else {
            declared
        }
    });
    let mut omitted = Vec::new();
    let mut columns = Vec::new();
    for name in chosen {
        let Some(info) = infos.get(&name) else {
            continue;
        };
        if info.def.as_ref().and_then(computed).is_some() {
            omitted.push(format!("{name} ({})", info.kind.id()));
        } else if info.conflicting {
            return Err(refusal(&[Problem::new("fields", format!("{name} is declared differently by these databases; name one type or choose other fields"))]));
        } else if !columns.contains(&name) {
            columns.push(name);
        }
    }
    if columns.len() > 30 {
        return Err(refusal(&[Problem::new(
            "fields",
            "at most 30 fields; choose the columns to return",
        )]));
    }
    let mut matches: Vec<_> = source
        .iter()
        .copied()
        .filter(|entry| {
            request
                .filters
                .as_ref()
                .is_none_or(|filter| evaluate(entry, filter, schema, table, zone, today))
        })
        .collect();
    sort_rows(&mut matches, &request.sort, schema);
    let total = matches.len();
    let shown = &matches[..total.min(request.limit)];
    let mut lines = Vec::new();
    let scope = scope(withheld);
    if total == 0 {
        lines.push(format!(
            "No {} match the filters.{scope}",
            record_words(wanted.as_deref(), 0)
        ));
    } else {
        let filtered = if request.filters.is_some() {
            " matching the filters"
        } else {
            ""
        };
        let sorted = if request.sort.is_empty() {
            String::new()
        } else {
            format!(
                ", sorted by {}",
                request
                    .sort
                    .iter()
                    .map(|s| format!("{} {}", s.field, if s.descending { "desc" } else { "asc" }))
                    .collect::<Vec<_>>()
                    .join(", then ")
            )
        };
        lines.push(format!(
            "{} of {total} {}{filtered}{sorted}{scope}:",
            shown.len(),
            record_words(wanted.as_deref(), total)
        ));
    }
    let mut cuts = 0;
    for entry in shown {
        let name = entry
            .entry_type
            .as_ref()
            .map(|name| format!(" [{name}]"))
            .unwrap_or_default();
        lines.push(format!("- {} — {}{name}", entry.path, entry.title));
        let mut values = Map::new();
        for name in &columns {
            if let Some(value) = field_value(schema, entry, name).filter(|value| !empty(value)) {
                values.insert(name.clone(), cut_value(value, &mut cuts));
            }
        }
        lines.push(format!("  {}", Value::Object(values)));
    }
    lines.push("Columns:".into());
    for name in &columns {
        lines.push(column_line(
            name,
            &infos[name],
            &source,
            schema,
            table,
            wanted.as_deref(),
        ));
    }
    lines.push(format!(
        "Types read: {}",
        type_counts(&source)
            .iter()
            .map(|(name, n)| format!("{name} ({n} {})", count_word(*n, "record")))
            .collect::<Vec<_>>()
            .join(", ")
    ));
    if total > shown.len() {
        if let Some(wanted) = wanted.as_deref() {
            let n = total - shown.len();
            lines.push(format!(
                "{n} more {} not shown; raise limit (at most 100) or narrow the filters.",
                record_words(Some(wanted), n)
            ));
        } else {
            for (name, n) in type_counts(&matches[shown.len()..]) {
                lines.push(format!(
                    "{n} more {} not shown; raise limit (at most 100) or narrow the filters.",
                    record_words(Some(&name), n)
                ));
            }
        }
    }
    if request.limit_cut {
        lines.push("The limit is at most 100.".into());
    }
    let mut used = columns;
    used.extend(request.sort.iter().map(|s| s.field.clone()));
    if let Some(filter) = &request.filters {
        used_filter_fields(filter, &mut used);
    }
    if used.iter().any(|name| {
        infos
            .get(name)
            .is_some_and(|info| table.facts(info.kind).filters == "date")
    }) {
        lines.push(format!(
            "Dates were read in {zone}; today is {today}, and weeks start on Sunday."
        ));
    }
    if request.sort.iter().any(|s| {
        infos
            .get(&s.field)
            .is_some_and(|i| i.options.is_empty() && table.facts(i.kind).filters == "text")
    }) {
        lines.push("Text sorted A to Z by letter, ignoring case; accents, other scripts and some punctuation can order differently than in the app.".into());
    }
    if !omitted.is_empty() {
        lines.push(format!("Not returned: {}; only the app computes rollups, formulas and the other side of a relation.", omitted.join(", ")));
    }
    if cuts > 0 {
        lines.push(format!(
            "{cuts} {} over 300 characters {} cut.",
            count_word(cuts, "value"),
            if cuts == 1 { "was" } else { "were" }
        ));
    }
    let parse_errors = source
        .iter()
        .filter(|entry| entry.parse_error.is_some())
        .count();
    if parse_errors > 0 {
        lines.push(format!("{parse_errors} {} {} frontmatter that could not be parsed, so their fields read as empty.", count_word(parse_errors, "record"), if parse_errors == 1 { "has" } else { "have" }));
    }
    Ok(lines.join("\n"))
}

pub(crate) fn records_text(
    entries: &[Entry],
    args: &Value,
    zone: Tz,
    today: NaiveDate,
    withheld: usize,
) -> Result<String, String> {
    let request = parse_request(args).map_err(|p| refusal(&[p]))?;
    let table = schema::table()?;
    let schema = VaultSchema::from_entries(entries, table);
    answer_text(entries, &request, &schema, table, zone, today, withheld)
}

pub(crate) fn describe_text(
    entries: &[Entry],
    args: &Value,
    zone: Tz,
    today: NaiveDate,
    withheld: usize,
) -> Result<String, String> {
    let wanted = args
        .get("type")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            "describe_database needs a type: the database's name, such as Decision".to_string()
        })?;
    let name = resolve_type(entries, wanted).map_err(|error| format!("type: {error}"))?;
    let table = schema::table()?;
    let schema = VaultSchema::from_entries(entries, table);
    let source = source_for(entries, Some(&name))?;
    let count = source.len();
    let Some(doc) = entries
        .iter()
        .rev()
        .find(|e| e.entry_type.as_deref() == Some("Type") && e.title == name)
    else {
        let mut lines = vec![format!(
            "No Type doc this run can read declares {name}; {count} {} carry it.{}",
            count_word(count, "record"),
            scope(withheld)
        )];
        if let Some(held) = held_text(&held_keys(&source, &[])) {
            lines.push(held);
        }
        return Ok(lines.join("\n"));
    };
    let own = schema
        .type_named(&name)
        .expect("the readable Type doc built this schema");
    let infos = field_infos(&source, Some(&name), &schema, table);
    let declared = declared_names(&source, Some(&name), &schema);
    let mut lines = vec![format!(
        "Database {name} ({}): {count} {}{}.",
        doc.path,
        count_word(count, "record"),
        scope(withheld)
    )];
    if let Some(folder) = &own.folder {
        lines.push(format!("New records are filed in {folder}."));
    }
    if let Some(deadline) = schema.deadline_field(&name) {
        lines.push(format!("Deadline: {}.", deadline.name));
    }
    lines.push("Fields, in order:".into());
    for def in &own.fields {
        if let Some(info) = infos.get(&def.name) {
            lines.push(column_line(
                &def.name,
                info,
                &source,
                &schema,
                table,
                Some(&name),
            ));
        }
    }
    lines.push("Every record also has title, type, createdAt and modifiedAt (file times on this disk, compared as dates).".into());
    if let Some(held) = held_text(&held_keys(&source, &declared)) {
        lines.push(held);
    }
    let (statuses, label) = if own.statuses.is_empty() {
        (
            &table.default_statuses,
            "Statuses (the app's defaults):".to_string(),
        )
    } else {
        (&own.statuses, format!("Statuses (from {name}):"))
    };
    lines.push(label);
    lines.push(
        statuses
            .iter()
            .map(|s| format!("{} \"{}\" ({})", s.id, s.label, s.group))
            .collect::<Vec<_>>()
            .join(" · "),
    );
    let overrides: Vec<_> = source
        .iter()
        .filter(|e| schema.status_set_for(e).1 == StatusSource::Project)
        .collect();
    if !overrides.is_empty() {
        let names: BTreeSet<_> = overrides
            .iter()
            .filter_map(|e| e.project.as_deref())
            .collect();
        lines.push(format!(
            "{} {} take their statuses from their project: {}",
            overrides.len(),
            count_word(overrides.len(), "record"),
            names.into_iter().collect::<Vec<_>>().join(", ")
        ));
    }
    lines.push("Operators by kind:".into());
    let mut families = BTreeSet::new();
    for def in &own.fields {
        if computed(def).is_none() {
            families.insert(table.facts(def.kind).filters.clone());
        }
    }
    families.insert("text".into());
    families.insert("date".into());
    for (family, ops) in &table.filter_families {
        if families.contains(family) {
            lines.push(format!("- {family}: {}", ops.join(", ")));
        }
    }
    lines.push("Dates: YYYY-MM-DD, YYYY-MM-DD HH:MM, today, yesterday, tomorrow, today-7, today+3, this_week, last_week, next_week, this_month, last_month, next_month.".into());
    lines.push(format!(
        "Dates are read in {zone}; today is {today}, and weeks start on Sunday."
    ));
    lines.push("Views:".into());
    if let Some(views) = doc.properties.get("views").and_then(Value::as_array) {
        for view in views.iter().take(20) {
            let id = view.get("id").and_then(Value::as_str).unwrap_or("unnamed");
            let name = view.get("name").and_then(Value::as_str).unwrap_or(id);
            let layout = view
                .pointer("/presentation/type")
                .and_then(Value::as_str)
                .unwrap_or("table");
            let stored = |value: Option<&Value>| {
                value
                    .filter(|v| !v.is_null())
                    .map(Value::to_string)
                    .unwrap_or_else(|| "none".into())
            };
            lines.push(format!(
                "- {id} \"{name}\" ({layout}): filters {}; sort {}",
                stored(view.get("filters")),
                stored(view.pointer("/presentation/sort"))
            ));
        }
    }
    Ok(lines.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixture() -> Value {
        serde_json::from_str(include_str!("../../fixtures/filter-cases.json")).unwrap()
    }
    fn corpus() -> Vec<Entry> {
        fixture()["corpus"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| {
                let mut entry = Entry::empty_for_test(row["path"].as_str().unwrap());
                entry.title = row["title"].as_str().unwrap().into();
                entry.entry_type = row["type"].as_str().map(str::to_string);
                entry.properties = row["properties"].as_object().unwrap().clone();
                entry.relationships = serde_json::from_value(row["relationships"].clone()).unwrap();
                entry.created_at = row["createdAt"].as_str().unwrap().into();
                entry.modified_at = row["modifiedAt"].as_str().unwrap().into();
                entry
            })
            .collect()
    }
    fn today() -> NaiveDate {
        NaiveDate::from_ymd_opt(2026, 7, 28).unwrap()
    }
    fn answer(args: Value) -> Result<String, String> {
        records_text(
            &corpus(),
            &args,
            chrono_tz::America::Los_Angeles,
            today(),
            0,
        )
    }
    fn reject(args: Value) -> String {
        answer(args).unwrap_err()
    }
    fn rule(field: &str, op: &str, value: Value) -> Value {
        json!({"type":"Deal", "filters":{"all":[{"field":field,"op":op,"value":value}]}})
    }

    #[test]
    fn replays_the_shared_filter_cases() {
        let fixture = fixture();
        let entries = corpus();
        let table = schema::table().unwrap();
        let schema = VaultSchema::from_entries(&entries, table);
        for row in fixture["cases"].as_array().unwrap() {
            let request = parse_request(row).unwrap();
            let zone = row["zone"]
                .as_str()
                .unwrap_or(fixture["zone"].as_str().unwrap())
                .parse()
                .unwrap();
            let today = row["today"]
                .as_str()
                .unwrap_or(fixture["today"].as_str().unwrap())
                .parse()
                .unwrap();
            let problems = check(&entries, &request, &schema, table, zone, today);
            assert!(problems.is_empty(), "{}: {problems:?}", row["why"]);
            let mut source = source_for(&entries, request.type_name.as_deref()).unwrap();
            source.retain(|entry| {
                request
                    .filters
                    .as_ref()
                    .is_none_or(|filter| evaluate(entry, filter, &schema, table, zone, today))
            });
            sort_rows(&mut source, &request.sort, &schema);
            assert_eq!(
                serde_json::to_value(source.iter().map(|e| &e.path).collect::<Vec<_>>()).unwrap(),
                row["expect"],
                "{}",
                row["why"]
            );
        }
    }

    #[test]
    fn replays_the_shared_number_readings() {
        for row in fixture()["numbers"].as_array().unwrap() {
            assert_eq!(
                numeric_text(&row["text"]),
                row["reads"].as_f64(),
                "{}",
                row["text"]
            );
        }
        for raw in [
            Value::Null,
            json!(true),
            json!([]),
            json!([5]),
            json!({"n":5}),
        ] {
            assert_eq!(numeric_text(&raw), None);
        }
    }

    #[test]
    fn the_operators_are_the_artifacts() {
        let table = schema::table().unwrap();
        let fixture = fixture();
        let mut used = BTreeSet::new();
        fn walk(value: &Value, used: &mut BTreeSet<String>) {
            if let Some(op) = value.get("op").and_then(Value::as_str) {
                used.insert(op.into());
            }
            match value {
                Value::Object(map) => {
                    for v in map.values() {
                        walk(v, used);
                    }
                }
                Value::Array(values) => {
                    for v in values {
                        walk(v, used);
                    }
                }
                _ => {}
            }
        }
        walk(&fixture["cases"], &mut used);
        assert_eq!(used, table.filter_ops.iter().cloned().collect());
        assert!(FieldKind::ALL.iter().all(|kind| table
            .filter_families
            .contains_key(&table.facts(*kind).filters)));
    }

    #[test]
    fn closest_name_prefers_case_then_spelling_then_edits() {
        let names = ["status", "due_date", "due"].map(str::to_string);
        for (input, expected) in [
            ("Status", Some("status")),
            ("due date", Some("due_date")),
            ("dew", Some("due")),
            ("stauts", Some("status")),
            ("xyzzy", None),
        ] {
            assert_eq!(closest_name(input, &names), expected);
        }
    }
    #[test]
    fn numeric_membership_has_jsons_one_number_type() {
        assert!(strict_equal(&json!(5), &json!(5.0)));
        assert!(!strict_equal(&json!(5), &json!("5")));
        assert!(!strict_equal(&json!(0), &json!(false)));
    }

    #[test]
    fn long_names_do_not_allocate_an_edit_distance_grid() {
        let name = "a".repeat(20_000);
        assert_eq!(
            closest_name(&(name.clone() + "b"), std::slice::from_ref(&name)),
            Some(name.as_str())
        );
        assert_eq!(closest_name(&"z".repeat(20_000), &[name]), None);
    }

    #[test]
    fn unknown_names_are_refused_with_readable_choices() {
        assert!(reject(json!({"type":"Deel"})).contains("Closest: \"Deal\""));
        assert!(reject(rule("vaule", "equals", json!(5)))
            .contains("\"vaule\" is not a field of Deal. Closest: \"value\"."));
        assert!(reject(rule("value", "equlas", json!(5)))
            .contains("\"equlas\" is not an operator. Closest: \"equals\"."));
        assert!(reject(rule("stage", "equals", json!("laed")))
            .contains("\"laed\" is not an option of stage. Closest: \"lead\"."));
        assert!(answer(rule("stage", "equals", json!("ghost"))).is_ok());
    }
    #[test]
    fn a_label_names_the_option_id() {
        assert!(reject(rule("priority","equals",json!("Urgent attention"))).contains("\"Urgent attention\" is the label of urgent; filters take option ids, so use \"urgent\""));
    }
    #[test]
    fn a_misfit_operator_is_refused() {
        assert!(reject(rule("value", "contains", json!(5)))
            .contains("contains doesn't apply to value (number); it takes equals"));
    }
    #[test]
    fn unfinished_conditions_are_refused() {
        for value in [Value::Null, json!(""), json!([])] {
            assert!(reject(rule("value", "equals", value)).contains("equals takes one value"));
        }
        assert!(
            reject(json!({"filters":{"all":[{"field":"title","op":"equals"}]}}))
                .contains("filters.all[0]")
        );
    }
    #[test]
    fn wrong_value_shapes_are_refused() {
        for (field, op, value, words) in [
            ("value", "equals", json!([5]), "one value"),
            ("stage", "any_of", json!("lead"), "a list of values"),
            ("value", "is_between", json!([5]), "two values, [low, high]"),
            ("value", "is_empty", json!(0), "no value"),
        ] {
            assert!(reject(rule(field, op, value)).contains(words));
        }
        assert!(reject(rule("value", "equals", json!("0x10"))).contains("is not a number"));
        assert!(reject(rule("close", "before", json!("next Tuesday")))
            .contains("is not a date: use YYYY-MM-DD"));
        assert!(reject(rule("done", "equals", json!("false")))
            .contains("done is a checkbox; use true or false"));
        assert_eq!(
            reject(json!({"filters":[]})),
            "Nothing was queried:\n- filters: expected {\"all\": [...]} or {\"any\": [...]}"
        );
    }
    #[test]
    fn reversed_bounds_are_refused() {
        assert!(reject(rule("value", "is_between", json!([9, 1])))
            .contains("is_between takes [low, high]; 9 is after 1"));
        assert!(reject(rule(
            "close",
            "is_between",
            json!(["2026-08-01", "2026-07-01"])
        ))
        .contains("is after"));
    }
    #[test]
    fn reversed_relative_bounds_are_refused_without_inventing_a_day() {
        assert!(reject(rule(
            "close",
            "is_between",
            json!(["tomorrow", "yesterday"])
        ))
        .contains("is after"));
        assert!(answer(rule("close", "is_between", json!(["today", "this_week"]))).is_ok());
        assert!(answer(rule(
            "close",
            "is_between",
            json!(["2026-07-28 14:00", "2026-07-28"])
        ))
        .is_ok());
    }

    #[test]
    fn a_rollup_is_refused() {
        assert!(reject(rule("total", "equals", json!(1)))
            .contains("total is a rollup, which only the app computes"));
    }
    #[test]
    fn a_formula_is_refused() {
        assert!(reject(json!({"type":"Deal","fields":["margin"]}))
            .contains("margin is a formula, which only the app computes"));
    }
    #[test]
    fn a_derived_relation_is_refused() {
        assert!(reject(rule("children", "contains", json!("deal")))
            .contains("children is the other side of a relation, which only the app computes"));
    }
    #[test]
    fn multi_value_and_range_sorts_are_refused() {
        assert!(
            reject(json!({"type":"Deal","sort":[{"field":"tags","dir":"asc"}]}))
                .contains("tags holds several values, so it can't be sorted")
        );
        assert!(
            reject(json!({"type":"Deal","sort":[{"field":"window","dir":"asc"}]}))
                .contains("window holds date ranges, which can't be sorted yet")
        );
    }
    #[test]
    fn created_and_edited_times_filter_sort_and_return() {
        for field in ["made", "edited"] {
            let mut args = rule(field, "on_or_before", json!("2026-07-30"));
            args["fields"] = json!([field]);
            args["sort"] = json!([{"field":field,"dir":"asc"}]);
            let text = answer(args).unwrap();
            assert!(text.contains("15 of 15 Deal records matching the filters"));
            assert!(text.contains(&format!("\"{field}\":\"2026-07-")));
            assert!(!text.contains("Not returned"));
        }
    }
    #[test]
    fn describe_marks_rollups_formulas_and_derived_relations_only() {
        let text = describe_text(
            &corpus(),
            &json!({"type":"Deal"}),
            chrono_tz::UTC,
            today(),
            0,
        )
        .unwrap();
        for field in ["total", "margin", "children"] {
            assert!(text
                .lines()
                .find(|s| s.starts_with(&format!("- {field}:")))
                .unwrap()
                .contains("computed by the app"));
        }
        for field in ["made", "edited"] {
            assert!(!text
                .lines()
                .find(|s| s.starts_with(&format!("- {field}:")))
                .unwrap()
                .contains("computed by the app"));
        }
        assert!(text.contains("Deadline: close."));
        assert!(text.contains("New records are filed in deals."));
        assert!(text.contains("- open \"Open\" (table): filters {\"all\""));
        assert!(
            text.contains("Dates are read in UTC; today is 2026-07-28, and weeks start on Sunday.")
        );
    }
    #[test]
    fn every_problem_is_listed_at_once() {
        let text = reject(
            json!({"type":"Deal","filters":{"all":[{"field":"missing","op":"equals","value":1},{"any":[{"field":"value","op":"contains","value":"a"},{"field":"stage","op":"equals","value":"Lead"}]}]},"sort":[{"field":"window","dir":"asc"}],"fields":["margin"]}),
        );
        for pos in [
            "filters.all[0]",
            "filters.all[1].any[0]",
            "filters.all[1].any[1]",
            "sort[0].field",
            "fields[0]",
        ] {
            assert!(text.contains(pos), "{text}");
        }
        assert_eq!(text.lines().count(), 6);
    }
    #[test]
    fn limits_are_refused_or_stated() {
        let rules = vec![json!({"field":"title","op":"is_not_empty"}); 41];
        assert!(reject(json!({"filters":{"all":rules}})).contains("at most 40 conditions"));
        assert!(
            reject(json!({"filters":{"all":[{"any":[{"all":[{"any":[]}]}]}]}}))
                .contains("at most 3 levels of nested groups")
        );
        assert!(
            reject(json!({"sort":vec![json!({"field":"title","dir":"asc"});5]}))
                .contains("at most 4 sort keys")
        );
        assert!(reject(json!({"fields":vec!["title";31]})).contains("at most 30 fields"));
        assert!(reject(json!({"limit":0})).contains("limit: expected a number of at least 1"));
        assert!(answer(json!({"type":"Deal","limit":101}))
            .unwrap()
            .contains("The limit is at most 100."));
        assert_eq!(parse_request(&json!({"limit":2.9})).unwrap().limit, 2);
    }
    #[test]
    fn a_typeless_query_refuses_a_field_two_databases_declare_differently() {
        let mut entries = corpus();
        let account = entries.iter_mut().find(|e| e.title == "Account").unwrap();
        account.properties["fields"]["value"] = json!("text");
        let text = records_text(
            &entries,
            &json!({"filters":{"all":[{"field":"value","op":"equals","value":5}]}}),
            chrono_tz::UTC,
            today(),
            0,
        )
        .unwrap_err();
        assert!(text.contains("value is declared differently by these databases"));
    }
    #[test]
    fn an_agents_memory_is_never_returned_or_matched() {
        let mut entry = Entry::empty_for_test("agents/private.md");
        entry.entry_type = Some("Agent".into());
        entry.properties = json!({"recent":"secret recent", "memory":"secret memory", "preferences":"secret preference", "role":"reader"}).as_object().unwrap().clone();
        let entries = [entry];
        let text = records_text(
            &entries,
            &json!({"type":"Agent"}),
            chrono_tz::UTC,
            today(),
            0,
        )
        .unwrap();
        assert!(!text.contains("secret"));
        assert!(!text.contains("memory"));
        assert!(records_text(&entries, &json!({"type":"Agent","filters":{"all":[{"field":"memory","op":"contains","value":"secret"}]}}), chrono_tz::UTC, today(), 0).unwrap_err().contains("is not a field"));
        let schema = VaultSchema::from_entries(&entries, schema::table().unwrap());
        assert_eq!(field_value(&schema, &entries[0], "memory"), None);
    }
    #[test]
    fn answer_names_columns_types_truncation_and_scope_without_hidden_names() {
        let text = records_text(
            &corpus(),
            &json!({"fields":["title"],"limit":2}),
            chrono_tz::UTC,
            today(),
            2,
        )
        .unwrap();
        assert!(text
            .starts_with("2 of 18 records (2 notes outside this run's read scope were not read):"));
        assert!(text.contains("Columns:\n- title: text — one value"));
        assert!(
            text.contains("Types read: Account (3 records), Deal (14 records), untyped (1 record)")
        );
        assert!(text.contains("14 more Deal records not shown"));
        let text = answer(
            json!({"type":"Deal","filters":{"all":[{"field":"value","op":"gt","value":500}]}}),
        )
        .unwrap();
        assert!(text.starts_with("No Deal records match the filters."));
    }
    #[test]
    fn absent_fields_are_omitted_and_long_values_counted() {
        let mut entries = corpus();
        let deal = entries
            .iter_mut()
            .find(|e| e.path == "deals/01.md")
            .unwrap();
        deal.properties
            .insert("note".into(), json!("x".repeat(301)));
        let text = records_text(
            &entries,
            &json!({"type":"Deal","fields":["note","value","done"],"limit":1}),
            chrono_tz::UTC,
            today(),
            0,
        )
        .unwrap();
        assert!(text.contains("\"value\":5"));
        assert!(text.contains("\"done\":false"));
        assert!(text.contains("1 value over 300 characters was cut."));
    }
    #[test]
    fn a_missing_readable_type_doc_exposes_only_held_keys() {
        let entries: Vec<_> = corpus()
            .into_iter()
            .filter(|e| e.entry_type.as_deref() != Some("Type"))
            .collect();
        let text = describe_text(
            &entries,
            &json!({"type":"Deal"}),
            chrono_tz::UTC,
            today(),
            1,
        )
        .unwrap();
        assert!(
            text.starts_with("No Type doc this run can read declares Deal; 15 records carry it.")
        );
        assert!(!text.contains("types/deal.md"));
        assert!(text.contains("Also held, not declared"));
        assert_eq!(
            describe_text(&entries, &json!({}), chrono_tz::UTC, today(), 0).unwrap_err(),
            "describe_database needs a type: the database's name, such as Decision"
        );
    }
    #[test]
    fn nothing_in_this_module_reads_the_clock() {
        let source = include_str!("query.rs");
        let body = source.split(concat!("#[cfg", "(test)]")).next().unwrap();
        for forbidden in [
            "::now(",
            "SystemTime",
            "std::fs",
            "std::env",
            "system_timezone(",
        ] {
            assert!(!body.contains(forbidden), "{forbidden}");
        }
    }
}
