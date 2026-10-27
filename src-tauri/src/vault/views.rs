//! Checked, read-only view suggestions (M62.4). The shared vocabulary is
//! `shared/schema/views.v1.json`; both validators replay the raw-note cases
//! in `fixtures/view-suggestion-cases.json`. A suggestion changes no file.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::OnceLock;

use indexmap::IndexMap;
use serde::Deserialize;
use serde_json::{Map, Value};

use super::entry::Entry;
use super::query;
use super::schema::{self, FieldKind, KindTable, VaultSchema};

pub const VIEWS_JSON: &str = include_str!("../../../shared/schema/views.v1.json");
pub const VIEWS_DIGEST: &str = include_str!("../../../shared/schema/views.v1.sha256");
pub const VIEWS_PATH: &str = "shared/schema/views.v1.json";
pub const VIEWS_DIGEST_PATH: &str = "shared/schema/views.v1.sha256";
const FORMAT: u64 = 1;
const NOTE: &str =
    "The user sees this view as a card with a live preview. Nothing is written unless they add it.";

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ViewType {
    pub id: String,
    pub suggestable: bool,
    pub needs: Vec<String>,
    pub reads: Vec<String>,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ChartKind {
    pub id: String,
    pub needs_axis: bool,
    pub reads: Vec<String>,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Slot {
    pub fact: Option<String>,
    pub family: Option<String>,
    pub verb: String,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Keys {
    pub view: Vec<String>,
    pub presentation: Vec<String>,
    pub group: Vec<String>,
    pub sort: Vec<String>,
    pub column: Vec<String>,
    pub chart: Vec<String>,
    pub gallery: Vec<String>,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Limits {
    pub name: usize,
    pub reasoning: usize,
    pub args_bytes: usize,
    pub group_levels: usize,
    pub sort_keys: usize,
    pub columns: usize,
    pub filter_rules: usize,
    pub filter_depth: usize,
    pub view_limit: usize,
    pub problems: usize,
    pub names_listed: usize,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Vocabulary {
    pub format: u64,
    pub artifact_version: u64,
    pub rule_version: String,
    pub view_types: Vec<ViewType>,
    pub chart_kinds: Vec<ChartKind>,
    pub chart_aggs: Vec<String>,
    pub measured_aggs: Vec<String>,
    pub chart_sorts: Vec<String>,
    pub directions: Vec<String>,
    pub date_buckets: Vec<String>,
    pub calendar_spans: Vec<String>,
    pub zooms: Vec<String>,
    pub slots: IndexMap<String, Slot>,
    pub keys: Keys,
    pub limits: Limits,
}

fn unique(values: &[String]) -> bool {
    !values.is_empty()
        && values.iter().all(|v| !v.is_empty())
        && values.iter().collect::<BTreeSet<_>>().len() == values.len()
}

fn kind_fact(table: &KindTable, kind: FieldKind, fact: &str) -> Option<bool> {
    let facts = table.facts(kind);
    match fact {
        "multi" => Some(facts.multi),
        "computed" => Some(facts.computed),
        "links" => Some(facts.links),
        "groupable" => Some(facts.groupable),
        "orderable" => Some(facts.orderable),
        "numeric" => Some(facts.numeric),
        "media" => Some(facts.media),
        "status_set" => Some(facts.status_set),
        "legacy" => Some(facts.legacy),
        _ => None,
    }
}

pub(crate) fn parse_table(raw: &str) -> Result<Vocabulary, String> {
    let vocabulary: Vocabulary =
        serde_json::from_str(raw).map_err(|_| "views: invalid table shape".to_string())?;
    if vocabulary.format != FORMAT {
        return Err(format!(
            "views: format must be {FORMAT}, not {}",
            vocabulary.format
        ));
    }
    if vocabulary.rule_version.trim().is_empty() {
        return Err("views: rule_version is empty".into());
    }
    if vocabulary.artifact_version == 0 {
        return Err("views: artifact_version must be positive".into());
    }
    let ids = vocabulary
        .view_types
        .iter()
        .map(|v| v.id.clone())
        .collect::<Vec<_>>();
    if !unique(&ids) {
        return Err("views: view_types must be non-empty and unique".into());
    }
    let ids = vocabulary
        .chart_kinds
        .iter()
        .map(|v| v.id.clone())
        .collect::<Vec<_>>();
    if !unique(&ids) {
        return Err("views: chart_kinds must be non-empty and unique".into());
    }
    for (name, keys) in [
        ("view", &vocabulary.keys.view),
        ("presentation", &vocabulary.keys.presentation),
        ("group", &vocabulary.keys.group),
        ("sort", &vocabulary.keys.sort),
        ("column", &vocabulary.keys.column),
        ("chart", &vocabulary.keys.chart),
        ("gallery", &vocabulary.keys.gallery),
    ] {
        if !unique(keys) {
            return Err(format!("views: keys.{name} must be non-empty and unique"));
        }
    }
    for view in &vocabulary.view_types {
        for need in &view.needs {
            if !["band", "dateField", "chart", "axis"].contains(&need.as_str()) {
                return Err(format!("views: unknown need {need}"));
            }
        }
        for key in &view.reads {
            if !vocabulary.keys.presentation.contains(key) {
                return Err(format!(
                    "views: view type {} reads unknown key {key}",
                    view.id
                ));
            }
        }
    }
    for chart in &vocabulary.chart_kinds {
        for key in &chart.reads {
            if !vocabulary.keys.chart.contains(key) {
                return Err(format!(
                    "views: chart kind {} reads unknown key {key}",
                    chart.id
                ));
            }
        }
    }
    for (name, words) in [
        ("chart_aggs", &vocabulary.chart_aggs),
        ("chart_sorts", &vocabulary.chart_sorts),
        ("directions", &vocabulary.directions),
        ("date_buckets", &vocabulary.date_buckets),
        ("calendar_spans", &vocabulary.calendar_spans),
        ("zooms", &vocabulary.zooms),
    ] {
        if !unique(words) {
            return Err(format!("views: {name} must be non-empty and unique"));
        }
    }
    if !unique(&vocabulary.measured_aggs)
        || vocabulary
            .measured_aggs
            .iter()
            .any(|v| !vocabulary.chart_aggs.contains(v))
    {
        return Err("views: measured_aggs must name chart_aggs".into());
    }
    let fields = schema::table()?;
    for name in [
        "group",
        "sort",
        "chart.xField",
        "chart.groupBy",
        "chart.value",
        "dateField",
        "gallery.cover",
        "dateBucket",
    ] {
        if !vocabulary.slots.contains_key(name) {
            return Err(format!("views: missing slot {name}"));
        }
    }
    for (name, slot) in &vocabulary.slots {
        if slot.fact.is_some() == slot.family.is_some() || slot.verb.is_empty() {
            return Err(format!(
                "views: slot {name} needs one fact or family and a verb"
            ));
        }
        if let Some(fact) = &slot.fact {
            if kind_fact(fields, FieldKind::Text, fact).is_none() {
                return Err(format!("views: slot {name} names unknown fact {fact}"));
            }
        }
        if let Some(family) = &slot.family {
            if !fields.filter_families.contains_key(family) {
                return Err(format!("views: slot {name} names unknown family {family}"));
            }
        }
    }
    let l = &vocabulary.limits;
    for (name, value) in [
        ("name", l.name),
        ("reasoning", l.reasoning),
        ("args_bytes", l.args_bytes),
        ("group_levels", l.group_levels),
        ("sort_keys", l.sort_keys),
        ("columns", l.columns),
        ("filter_rules", l.filter_rules),
        ("filter_depth", l.filter_depth),
        ("view_limit", l.view_limit),
        ("problems", l.problems),
        ("names_listed", l.names_listed),
    ] {
        if value == 0 {
            return Err(format!("views: limit {name} must be a positive integer"));
        }
    }
    Ok(vocabulary)
}

pub(crate) fn table() -> Result<&'static Vocabulary, String> {
    static TABLE: OnceLock<Result<Vocabulary, String>> = OnceLock::new();
    TABLE
        .get_or_init(|| {
            if crate::ledger::sha256_hex(VIEWS_JSON.as_bytes()) != VIEWS_DIGEST.trim() {
                return Err(format!(
                    "views: the compiled bytes do not match {VIEWS_DIGEST_PATH}"
                ));
            }
            parse_table(VIEWS_JSON)
        })
        .as_ref()
        .map_err(Clone::clone)
}

#[derive(Debug, Clone)]
pub(crate) struct Args {
    pub database: String,
    pub view: Map<String, Value>,
    pub reasoning: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ViewProblem {
    pub path: String,
    pub message: String,
}
#[derive(Debug, Clone)]
pub(crate) struct Suggestion {
    pub database: String,
    pub view: Value,
    pub reasoning: Option<String>,
}

pub(crate) fn parse_args(raw: &Value, vocabulary: &Vocabulary) -> Result<Args, String> {
    let map = raw.as_object().ok_or("suggest_view needs an object")?;
    let raw_bytes = serde_json::to_vec(raw)
        .map_err(|_| "suggest_view needs an object".to_string())?
        .len();
    if raw_bytes > vocabulary.limits.args_bytes {
        return Err(format!(
            "suggest_view takes at most {} bytes",
            vocabulary.limits.args_bytes
        ));
    }
    let database = map
        .get("database")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or("suggest_view needs database: the database's name")?;
    let view = map
        .get("view")
        .and_then(Value::as_object)
        .ok_or("suggest_view needs view: an object")?;
    let reasoning = if let Some(value) = map.get("reasoning") {
        Some(
            value
                .as_str()
                .filter(|s| s.chars().count() <= vocabulary.limits.reasoning)
                .ok_or_else(|| {
                    format!(
                        "reasoning must be a string of at most {} characters",
                        vocabulary.limits.reasoning
                    )
                })?
                .to_string(),
        )
    } else {
        None
    };
    Ok(Args {
        database: database.into(),
        view: view.clone(),
        reasoning,
    })
}

pub(crate) fn refusal_text(
    database: &str,
    problems: &[ViewProblem],
    vocabulary: &Vocabulary,
) -> String {
    let mut lines = vec![format!(
        "schema_invalid: this view of {database} can't be shown, so no card was made."
    )];
    for problem in problems.iter().take(vocabulary.limits.problems) {
        lines.push(format!("- {}: {}", problem.path, problem.message));
    }
    if problems.len() > vocabulary.limits.problems {
        lines.push(format!(
            "- and {} more.",
            problems.len() - vocabulary.limits.problems
        ));
    }
    lines.join("\n")
}

pub(crate) fn answer_json(suggestion: &Suggestion) -> String {
    let mut proposed = Map::new();
    proposed.insert(
        "database".into(),
        Value::String(suggestion.database.clone()),
    );
    proposed.insert("view".into(), suggestion.view.clone());
    if let Some(reasoning) = &suggestion.reasoning {
        proposed.insert("reasoning".into(), Value::String(reasoning.clone()));
    }
    let mut answer = Map::new();
    answer.insert("suggested".into(), Value::Object(proposed));
    answer.insert("note".into(), Value::String(NOTE.into()));
    Value::Object(answer).to_string()
}

fn words(values: &[String]) -> String {
    match values.split_last() {
        Some((last, before)) if !before.is_empty() => format!("{} or {last}", before.join(", ")),
        _ => values.join(""),
    }
}
fn bounded(values: &[String], limit: usize) -> String {
    let mut answer = values
        .iter()
        .take(limit)
        .cloned()
        .collect::<Vec<_>>()
        .join(", ");
    if values.len() > limit {
        answer.push_str(&format!(" and {} more", values.len() - limit));
    }
    answer
}

/// Resolution consults only readable Type docs. A record with an undeclared
/// type cannot grant a suggestion access to a schema outside this source.
pub(crate) fn resolve_database(entries: &[Entry], wanted: &str) -> Result<String, String> {
    let docs: Vec<_> = entries
        .iter()
        .filter(|entry| entry.entry_type.as_deref() == Some("Type") && entry.parse_error.is_none())
        .collect();
    if let Some(doc) = docs.iter().find(|entry| entry.title == wanted).or_else(|| {
        docs.iter()
            .find(|entry| entry.title.to_lowercase() == wanted.to_lowercase())
    }) {
        return Ok(doc.title.clone());
    }
    if let Some(doc) = entries.iter().find(|entry| {
        entry.path.starts_with("types/")
            && entry.parse_error.is_some()
            && entry.title.to_lowercase() == wanted.to_lowercase()
    }) {
        return Err(format!(
            "schema_invalid: {}'s Type doc has YAML errors, so its fields can't be checked.",
            doc.title
        ));
    }
    let names: Vec<_> = docs
        .iter()
        .map(|entry| entry.title.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let closest = query::closest_name(wanted, &names)
        .map(|name| format!(" Closest: \"{name}\"."))
        .unwrap_or_default();
    Err(format!("schema_invalid: type: no note this run can read has type \"{wanted}\".{closest} Types in use: {}", names.join(", ")))
}

type CanonicalRuleValidator<'a> = dyn Fn(&query::Rule, &query::FieldInfo) -> Vec<String> + 'a;

struct Checker<'a> {
    database: &'a str,
    vocabulary: &'a Vocabulary,
    kinds: &'a KindTable,
    infos: BTreeMap<String, query::FieldInfo>,
    names: Vec<String>,
    problems: Vec<ViewProblem>,
    rules: usize,
    canonical_rule: Option<&'a CanonicalRuleValidator<'a>>,
}
impl Checker<'_> {
    fn add(&mut self, path: &str, message: impl Into<String>) {
        self.problems.push(ViewProblem {
            path: path.into(),
            message: message.into(),
        });
    }
    fn enum_at(&mut self, path: &str, value: Option<&Value>, options: &[String]) {
        if !value
            .and_then(Value::as_str)
            .is_some_and(|value| options.iter().any(|option| option == value))
        {
            self.add(
                path,
                format!(
                    "{} is not one of {}.",
                    value.unwrap_or(&Value::Null),
                    words(options)
                ),
            );
        }
    }
    fn fits(&self, kind: FieldKind, slot: &str) -> bool {
        let slot = &self.vocabulary.slots[slot];
        slot.fact
            .as_ref()
            .map(|fact| kind_fact(self.kinds, kind, fact) == Some(true))
            .unwrap_or_else(|| slot.family.as_ref() == Some(&self.kinds.facts(kind).filters))
    }
    fn field_at(
        &mut self,
        path: &str,
        value: Option<&Value>,
        slot: Option<&str>,
    ) -> Option<(String, FieldKind)> {
        let Some(name) = value
            .and_then(Value::as_str)
            .filter(|name| !name.is_empty())
        else {
            self.add(path, "expected a field name");
            return None;
        };
        let Some(kind) = self.infos.get(name).map(|info| info.kind) else {
            let hint = query::closest_name(name, &self.names)
                .map(|close| format!("Did you mean \"{close}\"?"))
                .unwrap_or_else(|| {
                    format!(
                        "Its fields: {}.",
                        bounded(&self.names, self.vocabulary.limits.names_listed)
                    )
                });
            self.add(
                path,
                format!("{} has no field \"{name}\". {hint}", self.database),
            );
            return None;
        };
        if let Some(slot) = slot {
            if !self.fits(kind, slot) {
                let choices: Vec<_> = self
                    .names
                    .iter()
                    .filter(|name| self.fits(self.infos[*name].kind, slot))
                    .cloned()
                    .collect();
                let hint = if choices.is_empty() {
                    format!("None of {}'s fields can.", self.database)
                } else {
                    format!(
                        "Fields that can: {}.",
                        bounded(&choices, self.vocabulary.limits.names_listed)
                    )
                };
                self.add(
                    path,
                    format!(
                        "{name}, a {} field, can't {}. {hint}",
                        kind.id(),
                        self.vocabulary.slots[slot].verb
                    ),
                );
            }
        }
        Some((name.into(), kind))
    }
    fn unknown_keys(&mut self, map: &Map<String, Value>, keys: &[String], path: &str) {
        for key in map.keys().filter(|key| !keys.contains(key)) {
            self.add(&format!("{path}.{key}"), format!("leave \"{key}\" out."));
        }
    }
    fn filter(&mut self, raw: &Value, path: &str, depth: usize, group_only: bool) {
        let shape = "expected {\"all\": [...]} or {\"any\": [...]}";
        let Some(map) = raw.as_object() else {
            self.add(path, shape);
            return;
        };
        if map.contains_key("all") || map.contains_key("any") || group_only {
            let key = if map.contains_key("all") {
                "all"
            } else {
                "any"
            };
            let Some(children) = map
                .get(key)
                .and_then(Value::as_array)
                .filter(|_| map.len() == 1)
            else {
                self.add(path, shape);
                return;
            };
            if depth > self.vocabulary.limits.filter_depth {
                self.add(
                    "filters",
                    format!(
                        "at most {} levels of nested filters",
                        self.vocabulary.limits.filter_depth
                    ),
                );
                return;
            }
            for (i, child) in children.iter().enumerate() {
                self.filter(child, &format!("{path}.{key}[{i}]"), depth + 1, false);
            }
            return;
        }
        self.rules += 1;
        if map
            .keys()
            .any(|key| !["field", "op", "value"].contains(&key.as_str()))
        {
            self.add(path, "expected {field, op, value?}");
            return;
        }
        let Some(field) = map.get("field").and_then(Value::as_str) else {
            self.add(&format!("{path}.field"), "expected a field name");
            return;
        };
        let Some(op) = map.get("op").and_then(Value::as_str) else {
            self.add(&format!("{path}.op"), "expected an operator name");
            return;
        };
        let found = self.field_at(path, map.get("field"), None);
        if !self.kinds.filter_ops.iter().any(|word| word == op) {
            self.add(path, format!("\"{op}\" is not an operator."));
            return;
        }
        let Some((_, kind)) = found else {
            return;
        };
        let ops = &self.kinds.filter_families[&self.kinds.facts(kind).filters];
        if !ops.iter().any(|word| word == op) {
            self.add(
                path,
                format!(
                    "\"{op}\" doesn't apply to {field}, a {} field. It takes {}.",
                    kind.id(),
                    words(ops)
                ),
            );
            return;
        }
        let info = &self.infos[field];
        let rule = query::Rule {
            field: field.into(),
            op: op.into(),
            value: map.get("value").cloned(),
        };
        if let Some(validate) = self.canonical_rule {
            for problem in validate(&rule, info) {
                self.add(path, problem);
            }
            return;
        }
        let value_problems = query::check_view_rule_value(&rule, info, self.kinds);
        if !value_problems.is_empty() {
            for problem in value_problems {
                self.add(path, problem);
            }
            return;
        }
        if ![FieldKind::Status, FieldKind::Select, FieldKind::Multiselect].contains(&kind)
            || ![
                "equals",
                "not_equals",
                "any_of",
                "none_of",
                "contains",
                "does_not_contain",
            ]
            .contains(&op)
        {
            return;
        }
        let values: Vec<_> = match map.get("value") {
            Some(Value::Array(values)) => values.iter().collect(),
            Some(value) => vec![value],
            None => vec![],
        };
        let options = info.options.clone();
        let recorded = info.recorded.clone();
        let ids: Vec<_> = options.iter().map(|(id, _)| id.clone()).collect();
        for value in values {
            let token = value
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| value.to_string());
            if ids.contains(&token)
                || recorded
                    .iter()
                    .any(|record| record.as_str() == Some(&token))
            {
                continue;
            }
            let message = if let Some((id, _)) = options.iter().find(|(_, label)| label == &token) {
                format!(
                    "\"{token}\" is the label of {id}; filters take option ids, so use \"{id}\"."
                )
            } else {
                let hint = query::closest_name(&token, &ids)
                    .map(|close| format!("Did you mean \"{close}\"?"))
                    .unwrap_or_else(|| {
                        format!(
                            "Its options: {}.",
                            bounded(&ids, self.vocabulary.limits.names_listed)
                        )
                    });
                format!("{field} has no option \"{token}\". {hint}")
            };
            self.add(path, message);
        }
    }
    fn rows(&mut self, key: &str, raw: &Value, needs_band: bool) {
        let path = format!("presentation.{key}");
        let Some(rows) = raw.as_array() else {
            self.add(&path, "expected an array");
            return;
        };
        let (cap, what, keys) = match key {
            "group" => (
                self.vocabulary.limits.group_levels,
                "group levels",
                &self.vocabulary.keys.group,
            ),
            "sort" => (
                self.vocabulary.limits.sort_keys,
                "sort keys",
                &self.vocabulary.keys.sort,
            ),
            _ => (
                self.vocabulary.limits.columns,
                "columns",
                &self.vocabulary.keys.column,
            ),
        };
        if rows.len() > cap {
            self.add(&path, format!("at most {cap} {what}"));
        }
        if needs_band && rows.is_empty() {
            self.add(
                &path,
                "a board needs a group level naming the field its columns band by.",
            );
        }
        for (i, raw) in rows.iter().enumerate() {
            let at = format!("{path}[{i}]");
            let Some(row) = raw.as_object() else {
                self.add(&at, "expected an object");
                continue;
            };
            self.unknown_keys(row, keys, &at);
            let field = self.field_at(&at, row.get("field"), (key != "columns").then_some(key));
            if let Some(dir) = row.get("dir") {
                self.enum_at(&format!("{at}.dir"), Some(dir), &self.vocabulary.directions);
            } else if key == "sort" {
                self.add(&format!("{at}.dir"), "expected asc or desc");
            }
            if key == "group" {
                if row
                    .get("hideEmpty")
                    .is_some_and(|value| !value.is_boolean())
                {
                    self.add(&format!("{at}.hideEmpty"), "expected true or false");
                }
                if let Some(bucket) = row.get("dateBucket") {
                    self.enum_at(
                        &format!("{at}.dateBucket"),
                        Some(bucket),
                        &self.vocabulary.date_buckets,
                    );
                    if let Some((name, kind)) = field {
                        if !self.fits(kind, "dateBucket") {
                            self.add(
                                &format!("{at}.dateBucket"),
                                format!(
                                    "dateBucket needs a date field; {name} is a {} field.",
                                    kind.id()
                                ),
                            );
                        }
                    }
                }
            }
        }
    }
    fn chart(&mut self, raw: Option<&Value>, presentation: &Map<String, Value>) {
        let Some(chart) = raw
            .and_then(Value::as_object)
            .filter(|map| map.contains_key("kind"))
        else {
            self.add("presentation.chart", "a chart view needs chart.kind.");
            return;
        };
        let Some(kind) = self
            .vocabulary
            .chart_kinds
            .iter()
            .find(|kind| chart.get("kind").and_then(Value::as_str) == Some(&kind.id))
        else {
            self.enum_at(
                "presentation.chart.kind",
                chart.get("kind"),
                &self
                    .vocabulary
                    .chart_kinds
                    .iter()
                    .map(|kind| kind.id.clone())
                    .collect::<Vec<_>>(),
            );
            return;
        };
        self.unknown_keys(chart, &self.vocabulary.keys.chart, "presentation.chart");
        for key in chart.keys() {
            if key != "kind"
                && self.vocabulary.keys.chart.contains(key)
                && !kind.reads.contains(key)
            {
                self.add(
                    &format!("presentation.chart.{key}"),
                    format!("a {} chart doesn't read {key}.", kind.id),
                );
            }
        }
        let agg = chart.get("agg").and_then(Value::as_str).unwrap_or("count");
        if chart.contains_key("agg") {
            self.enum_at(
                "presentation.chart.agg",
                chart.get("agg"),
                &self.vocabulary.chart_aggs,
            );
        }
        if self.vocabulary.measured_aggs.iter().any(|word| word == agg)
            && !chart.contains_key("value")
        {
            self.add(
                "presentation.chart.value",
                format!("{agg} needs a value field to measure."),
            );
        } else if agg == "count" && chart.contains_key("value") {
            self.add(
                "presentation.chart.value",
                "count measures no value; leave value out.",
            );
        } else if chart.contains_key("value") {
            self.field_at(
                "presentation.chart.value",
                chart.get("value"),
                Some("chart.value"),
            );
        }
        if kind.needs_axis
            && !chart.contains_key("xField")
            && presentation
                .get("group")
                .and_then(Value::as_array)
                .is_none_or(|rows| rows.is_empty())
        {
            self.add(
                "presentation.chart.xField",
                format!("a {} chart needs chart.xField or a group level.", kind.id),
            );
        }
        for key in ["xField", "groupBy"] {
            if kind.reads.iter().any(|read| read == key) && chart.contains_key(key) {
                self.field_at(
                    &format!("presentation.chart.{key}"),
                    chart.get(key),
                    Some(&format!("chart.{key}")),
                );
            }
        }
        if kind.reads.iter().any(|key| key == "sort") && chart.contains_key("sort") {
            self.enum_at(
                "presentation.chart.sort",
                chart.get("sort"),
                &self.vocabulary.chart_sorts,
            );
        }
    }
    fn presentation(&mut self, raw: Option<&Value>) {
        let Some(map) = raw.and_then(Value::as_object) else {
            self.add("presentation", "expected an object");
            return;
        };
        let layout = self
            .vocabulary
            .view_types
            .iter()
            .find(|layout| map.get("type").and_then(Value::as_str) == Some(&layout.id));
        if let Some(layout) = layout {
            if !layout.suggestable {
                self.add(
                    "presentation.type",
                    format!(
                        "a {} is built on its page by hand, not suggested.",
                        layout.id
                    ),
                );
            }
        } else {
            self.enum_at(
                "presentation.type",
                map.get("type"),
                &self
                    .vocabulary
                    .view_types
                    .iter()
                    .map(|layout| layout.id.clone())
                    .collect::<Vec<_>>(),
            );
        }
        for key in map.keys() {
            if !self.vocabulary.keys.presentation.contains(key) {
                self.add(
                    &format!("presentation.{key}"),
                    format!("\"{key}\" is set on the database's page, not suggested."),
                );
            } else if key != "type" {
                if let Some(layout) = layout {
                    if !layout.reads.contains(key) {
                        self.add(
                            &format!("presentation.{key}"),
                            format!("a {} doesn't read {key}.", layout.id),
                        );
                    }
                }
            }
        }
        let Some(layout) = layout.filter(|layout| layout.suggestable) else {
            return;
        };
        for key in &self.vocabulary.keys.presentation {
            if !layout.reads.contains(key) {
                continue;
            }
            let value = map.get(key);
            let path = format!("presentation.{key}");
            match key.as_str() {
                "group" | "sort" | "columns" => {
                    let band = key == "group" && layout.needs.iter().any(|need| need == "band");
                    if let Some(value) = value {
                        self.rows(key, value, band);
                    } else if band {
                        self.add(
                            &path,
                            "a board needs a group level naming the field its columns band by.",
                        );
                    }
                }
                "dateField" => {
                    if let Some(value) = value {
                        self.field_at(&path, Some(value), Some("dateField"));
                    } else if layout.needs.iter().any(|need| need == "dateField") {
                        self.add(&path, format!("a {} needs a dateField.", layout.id));
                    }
                }
                "calendarSpan" if value.is_some() => {
                    self.enum_at(&path, value, &self.vocabulary.calendar_spans);
                }
                "zoom" if value.is_some() => {
                    self.enum_at(&path, value, &self.vocabulary.zooms);
                }
                "limit" => {
                    if let Some(value) = value {
                        if !value.as_f64().is_some_and(|n| {
                            n.is_finite()
                                && n.fract() == 0.0
                                && n >= 1.0
                                && n <= self.vocabulary.limits.view_limit as f64
                        }) {
                            self.add(
                                &path,
                                format!(
                                    "limit is a whole number from 1 to {}.",
                                    self.vocabulary.limits.view_limit
                                ),
                            );
                        }
                    }
                }
                "gallery" => {
                    if let Some(value) = value {
                        if let Some(gallery) = value.as_object() {
                            self.unknown_keys(gallery, &self.vocabulary.keys.gallery, &path);
                            if gallery.contains_key("cover") {
                                self.field_at(
                                    "presentation.gallery.cover",
                                    gallery.get("cover"),
                                    Some("gallery.cover"),
                                );
                            }
                        } else {
                            self.add(&path, "expected an object");
                        }
                    }
                }
                "chart" => self.chart(value, map),
                _ => {}
            }
        }
    }
}
fn canonical(raw: &Map<String, Value>, keys: &[String], vocabulary: &Vocabulary) -> Value {
    let mut result = Map::new();
    for key in keys {
        let Some(value) = raw.get(key) else {
            continue;
        };
        let row_keys = match key.as_str() {
            "group" => Some(&vocabulary.keys.group),
            "sort" => Some(&vocabulary.keys.sort),
            "columns" => Some(&vocabulary.keys.column),
            _ => None,
        };
        let value = if let Some(row_keys) = row_keys.filter(|_| value.is_array()) {
            Value::Array(
                value
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|row| {
                        canonical(row.as_object().expect("checked row"), row_keys, vocabulary)
                    })
                    .collect(),
            )
        } else if key == "chart" {
            canonical(
                value.as_object().expect("checked chart"),
                &vocabulary.keys.chart,
                vocabulary,
            )
        } else if key == "gallery" {
            canonical(
                value.as_object().expect("checked gallery"),
                &vocabulary.keys.gallery,
                vocabulary,
            )
        } else {
            value.clone()
        };
        result.insert(key.clone(), value);
    }
    Value::Object(result)
}

/// Every field, option and held value comes from the readable corpus supplied
/// by the caller. No evaluator, file I/O, clock or write is reachable here.
pub(crate) fn check(
    entries: &[Entry],
    args: &Args,
    vocabulary: &Vocabulary,
) -> Result<Suggestion, String> {
    let database = resolve_database(entries, &args.database)?;
    let kinds = schema::table()?;
    let schema = VaultSchema::from_entries(entries, kinds);
    let source: Vec<_> = query::source_for(entries, Some(&database))?
        .into_iter()
        .filter(|entry| !entry.path.starts_with("knowledge/"))
        .collect();
    let mut infos = query::field_infos(&source, Some(&database), &schema, kinds);
    if let Some(info) = infos.get_mut("createdAt") {
        info.kind = FieldKind::CreatedTime;
    }
    if let Some(info) = infos.get_mut("modifiedAt") {
        info.kind = FieldKind::LastEditedTime;
    }
    check_facts(args, vocabulary, database, infos, &schema, None)
}

/// The existing view vocabulary/presentation checker, supplied canonical held
/// field facts and a value validator by the guarded selected reader.
pub(crate) fn check_canonical(
    args: &Args,
    vocabulary: &Vocabulary,
    database: String,
    infos: BTreeMap<String, query::FieldInfo>,
    schema: &VaultSchema,
    validate: &CanonicalRuleValidator<'_>,
) -> Result<Suggestion, String> {
    check_facts(args, vocabulary, database, infos, schema, Some(validate))
}
fn check_facts(
    args: &Args,
    vocabulary: &Vocabulary,
    database: String,
    infos: BTreeMap<String, query::FieldInfo>,
    schema: &VaultSchema,
    canonical_rule: Option<&CanonicalRuleValidator<'_>>,
) -> Result<Suggestion, String> {
    let kinds = schema::table()?;
    let mut names = Vec::new();
    for name in schema
        .type_named(&database)
        .into_iter()
        .flat_map(|own| own.fields.iter().map(|field| &field.name))
        .chain(kinds.virtual_fields.iter())
    {
        if infos.contains_key(name) && !names.contains(name) {
            names.push(name.clone());
        }
    }
    for name in infos.keys() {
        if !names.contains(name) {
            names.push(name.clone());
        }
    }
    let mut checker = Checker {
        database: &database,
        vocabulary,
        kinds,
        infos,
        names,
        problems: Vec::new(),
        rules: 0,
        canonical_rule,
    };
    for key in args
        .view
        .keys()
        .filter(|key| !vocabulary.keys.view.contains(key))
    {
        checker.add(
            key,
            format!("a suggested view takes name, filters and presentation; leave \"{key}\" out."),
        );
    }
    let name = args
        .view
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if name.is_empty()
        || name.chars().count() > vocabulary.limits.name
        || name.contains(['\n', '\r'])
    {
        checker.add(
            "name",
            format!(
                "a view needs a name of 1 to {} characters on one line.",
                vocabulary.limits.name
            ),
        );
    }
    if let Some(filters) = args.view.get("filters") {
        checker.filter(filters, "filters", 1, true);
        if checker.rules > vocabulary.limits.filter_rules {
            checker.add(
                "filters",
                format!("at most {} filter rules", vocabulary.limits.filter_rules),
            );
        }
    }
    checker.presentation(args.view.get("presentation"));
    if !checker.problems.is_empty() {
        return Err(refusal_text(&database, &checker.problems, vocabulary));
    }
    let mut view = Map::new();
    view.insert("name".into(), Value::String(name.into()));
    if let Some(filters) = args.view.get("filters") {
        view.insert("filters".into(), filters.clone());
    }
    view.insert(
        "presentation".into(),
        canonical(
            args.view["presentation"]
                .as_object()
                .expect("checked presentation"),
            &vocabulary.keys.presentation,
            vocabulary,
        ),
    );
    Ok(Suggestion {
        database,
        view: Value::Object(view),
        reasoning: args.reasoning.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn repo(path: &str) -> std::path::PathBuf {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join(path)
    }
    fn fixture() -> Value {
        serde_json::from_str(include_str!("../../fixtures/view-suggestion-cases.json")).unwrap()
    }
    fn corpus() -> Vec<Entry> {
        let mut entries: Vec<_> = fixture()["corpus"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| {
                super::super::entry::build_entry(
                    row["path"].as_str().unwrap(),
                    row["content"].as_str().unwrap(),
                    "2026-07-28T00:00:00Z".into(),
                    "2026-07-28T00:00:00Z".into(),
                )
            })
            .collect();
        super::super::scan::assign_projects(&mut entries);
        entries
    }
    #[test]
    fn replays_the_view_suggestion_cases() {
        let entries = corpus();
        let vocabulary = table().unwrap();
        for row in fixture()["cases"].as_array().unwrap() {
            let actual = parse_args(&row["args"], vocabulary)
                .and_then(|args| check(&entries, &args, vocabulary))
                .map(|suggestion| answer_json(&suggestion));
            let expected = if let Some(answer) = row["expect"]["answer"].as_str() {
                Ok(answer.to_owned())
            } else {
                Err(row["expect"]["refusal"]
                    .as_str()
                    .or(row["expect"]["malformed"].as_str())
                    .unwrap()
                    .to_owned())
            };
            assert_eq!(actual, expected, "{}", row["name"]);
        }
    }
    #[test]
    fn agent_private_state_is_never_a_suggested_field() {
        let entries = vec![
            super::super::entry::build_entry("types/agent.md", "---\ntype: Type\nfields:\n  recent: text\n  memory: text\n  preferences: text\n  description: text\n---\n# Agent\n", String::new(), String::new()),
            super::super::entry::build_entry("library/scout.md", "---\ntype: Agent\nrecent: secret\nmemory: secret\npreferences: secret\n---\n# Scout\n", String::new(), String::new()),
        ];
        let vocabulary = table().unwrap();
        for field in ["recent", "memory", "preferences"] {
            let args = parse_args(&json!({"database":"Agent","view":{"name":"Private","presentation":{"type":"table","columns":[{"field":field}]}}}), vocabulary).unwrap();
            let text = check(&entries, &args, vocabulary).unwrap_err();
            assert!(
                text.contains(&format!("Agent has no field \"{field}\"")),
                "{text}"
            );
            assert!(
                text.ends_with("Its fields: description, title, type, createdAt, modifiedAt."),
                "{text}"
            );
        }
    }
    #[test]
    fn integer_json_spelling_does_not_change_a_limit() {
        let raw: Value = serde_json::from_str(r#"{"database":"Work","view":{"name":"One","presentation":{"type":"table","limit":1.0}}}"#).unwrap();
        let vocabulary = table().unwrap();
        let args = parse_args(&raw, vocabulary).unwrap();
        assert!(check(&corpus(), &args, vocabulary).is_ok());
    }
    #[test]
    fn the_loaded_bytes_match_the_committed_digest() {
        let committed = std::fs::read_to_string(repo(VIEWS_DIGEST_PATH)).unwrap();
        assert_eq!(
            crate::ledger::sha256_hex(VIEWS_JSON.as_bytes()),
            committed.trim()
        );
        assert_eq!(
            std::fs::read_to_string(repo(VIEWS_PATH)).unwrap(),
            VIEWS_JSON
        );
        table().unwrap();
    }
    #[test]
    #[ignore = "run explicitly after a deliberate view vocabulary edit"]
    fn write_views_digest() {
        let digest = crate::ledger::sha256_hex(VIEWS_JSON.as_bytes());
        std::fs::write(repo(VIEWS_DIGEST_PATH), format!("{digest}\n")).unwrap();
    }
    #[test]
    fn the_shipped_table_validates() {
        parse_table(VIEWS_JSON).unwrap();
    }
    #[test]
    fn refuses_a_malformed_table() {
        let original: Value = serde_json::from_str(VIEWS_JSON).unwrap();
        let mut bad = original.clone();
        bad["format"] = json!(2);
        assert_eq!(
            parse_table(&bad.to_string()).unwrap_err(),
            "views: format must be 1, not 2"
        );
        let mut bad = original.clone();
        bad["rule_version"] = json!("");
        assert_eq!(
            parse_table(&bad.to_string()).unwrap_err(),
            "views: rule_version is empty"
        );
        let mut bad = original.clone();
        bad["view_types"][1]["id"] = json!("table");
        assert_eq!(
            parse_table(&bad.to_string()).unwrap_err(),
            "views: view_types must be non-empty and unique"
        );
        let mut bad = original.clone();
        bad["view_types"][0]["needs"] = json!(["magic"]);
        assert_eq!(
            parse_table(&bad.to_string()).unwrap_err(),
            "views: unknown need magic"
        );
        let mut bad = original.clone();
        bad["chart_kinds"][0]["reads"] = json!(["magic"]);
        assert_eq!(
            parse_table(&bad.to_string()).unwrap_err(),
            "views: chart kind bar reads unknown key magic"
        );
        let mut bad = original.clone();
        bad["slots"]["group"]["fact"] = json!("magic");
        assert_eq!(
            parse_table(&bad.to_string()).unwrap_err(),
            "views: slot group names unknown fact magic"
        );
        let mut bad = original;
        bad["limits"]["columns"] = json!(0);
        assert_eq!(
            parse_table(&bad.to_string()).unwrap_err(),
            "views: limit columns must be a positive integer"
        );
    }
}
