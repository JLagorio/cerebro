//! The first Rust reader of a vault's schema (M60.3): what a `type: Type`
//! doc declares, read by the rules `src/engine/schema.ts` `buildSchema`
//! applies, and the field-kind vocabulary both languages take from
//! `shared/schema/field-kinds.v1.json`.
//!
//! The artifact holds the facts (which atoms a kind accepts, its messages,
//! the filter families, the default statuses, the rollup results, the
//! virtual fields and the collation words) and its `cases` hold the parse
//! rules; `src/engine/fieldKindTable.ts` replays the same cases, so the two
//! readers cannot drift without a failing test (D3).
//!
//! Type docs are keyed by their title, and the last one in scan order wins,
//! as in `buildSchema`. The reader is scope-blind: a caller quoting a Type
//! doc to an agent applies read scope first.

use std::collections::{BTreeMap, HashMap};
use std::sync::OnceLock;

use indexmap::IndexMap;
use serde::Deserialize;
use serde_json::Value;

use super::dates::{self, RangeFault};
use super::entry::Entry;

/// The table, bound at compile time.
pub const FIELD_KINDS_JSON: &str = include_str!("../../../shared/schema/field-kinds.v1.json");

/// The committed SHA-256 of those bytes, checked when the table loads.
/// Regenerate it deliberately after an edit (see `write_field_kinds_digest`).
pub const FIELD_KINDS_DIGEST: &str = include_str!("../../../shared/schema/field-kinds.v1.sha256");

/// Repo-relative locations, for the tests that read the files on disk.
pub const FIELD_KINDS_PATH: &str = "shared/schema/field-kinds.v1.json";
pub const FIELD_KINDS_DIGEST_PATH: &str = "shared/schema/field-kinds.v1.sha256";

/// The format this build reads.
pub const FORMAT: u64 = 1;

const DATES_REF: &str = "shared/calendar/dates.v1.json";
const ATOMS: [&str; 7] = [
    "string",
    "number",
    "boolean",
    "string_list",
    "date_text",
    "date_range",
    "url_text",
];
const FAMILIES: [&str; 7] = [
    "text", "number", "date", "choice", "multi", "boolean", "any",
];
const ROLLUP_CALCS: [&str; 8] = [
    "count", "sum", "avg", "min", "max", "earliest", "latest", "show",
];
const ROLLUP_RESULTS: [&str; 3] = ["number", "value", "text"];
const STATUS_CHAIN: [&str; 3] = ["project", "type", "default"];
const VIRTUAL_FIELDS: [&str; 4] = ["title", "type", "createdAt", "modifiedAt"];

/// Every property kind, in the artifact's (and `FIELD_KINDS`') order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum FieldKind {
    Text,
    Number,
    Checkbox,
    Date,
    Daterange,
    Select,
    Multiselect,
    Status,
    Person,
    Relation,
    Url,
    Email,
    Phone,
    Files,
    Rollup,
    CreatedTime,
    LastEditedTime,
}

impl FieldKind {
    pub const ALL: [FieldKind; 17] = [
        FieldKind::Text,
        FieldKind::Number,
        FieldKind::Checkbox,
        FieldKind::Date,
        FieldKind::Daterange,
        FieldKind::Select,
        FieldKind::Multiselect,
        FieldKind::Status,
        FieldKind::Person,
        FieldKind::Relation,
        FieldKind::Url,
        FieldKind::Email,
        FieldKind::Phone,
        FieldKind::Files,
        FieldKind::Rollup,
        FieldKind::CreatedTime,
        FieldKind::LastEditedTime,
    ];

    /// The word a Type doc spells the kind with.
    pub fn id(self) -> &'static str {
        match self {
            FieldKind::Text => "text",
            FieldKind::Number => "number",
            FieldKind::Checkbox => "checkbox",
            FieldKind::Date => "date",
            FieldKind::Daterange => "daterange",
            FieldKind::Select => "select",
            FieldKind::Multiselect => "multiselect",
            FieldKind::Status => "status",
            FieldKind::Person => "person",
            FieldKind::Relation => "relation",
            FieldKind::Url => "url",
            FieldKind::Email => "email",
            FieldKind::Phone => "phone",
            FieldKind::Files => "files",
            FieldKind::Rollup => "rollup",
            FieldKind::CreatedTime => "created_time",
            FieldKind::LastEditedTime => "last_edited_time",
        }
    }

    pub fn from_id(id: &str) -> Option<FieldKind> {
        FieldKind::ALL.into_iter().find(|k| k.id() == id)
    }

    fn index(self) -> usize {
        FieldKind::ALL
            .iter()
            .position(|k| *k == self)
            .expect("every kind is in ALL")
    }
}

/// One kind's facts, as the artifact states them.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct KindFacts {
    pub kind: String,
    pub accepts: Vec<String>,
    pub multi: bool,
    pub computed: bool,
    /// Values are wikilinks to other pages: the kind honours `limit` and a
    /// reverse `from`.
    pub links: bool,
    pub groupable: bool,
    pub orderable: bool,
    pub numeric: bool,
    pub media: bool,
    pub filters: String,
    pub status_set: bool,
    pub legacy: bool,
    pub messages: BTreeMap<String, String>,
}

impl KindFacts {
    fn message(&self, key: &str, name: &str) -> String {
        self.messages
            .get(key)
            .or_else(|| self.messages.get("shape"))
            .map(|m| m.replace("{name}", name))
            .unwrap_or_default()
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RollupCalc {
    pub calc: String,
    pub result: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Collation {
    pub text_tests: String,
    pub equality: String,
    pub ordered: String,
    pub sort: String,
}

/// A status: an option with the group a board folds it into.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StatusDef {
    pub id: String,
    pub label: String,
    pub color: Option<String>,
    pub group: String,
    pub hollow: bool,
}

/// The loaded table. `cases` stay a `Value`: only the tests replay them.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct KindTable {
    pub format: u64,
    pub artifact_version: u64,
    pub rule_version: String,
    pub dates: String,
    pub atoms: Vec<String>,
    pub url_prefixes: Vec<String>,
    pub url_match: String,
    pub kinds: Vec<KindFacts>,
    pub filter_ops: Vec<String>,
    pub filter_families: IndexMap<String, Vec<String>>,
    pub status_groups: Vec<String>,
    pub status_group_default: String,
    pub status_chain: Vec<String>,
    pub default_statuses: Vec<StatusDef>,
    pub rollup_calcs: Vec<RollupCalc>,
    pub virtual_fields: Vec<String>,
    pub collation: Collation,
    pub cases: Value,
}

impl KindTable {
    /// The facts the artifact states for `kind`.
    pub fn facts(&self, kind: FieldKind) -> &KindFacts {
        &self.kinds[kind.index()]
    }
}

fn joined(list: &[&str]) -> String {
    list.join(", ")
}

fn collation_word(key: &str, got: &str, known: &str) -> Result<(), String> {
    if got == known {
        Ok(())
    } else {
        Err(format!(
            "field-kinds: collation {key} has an unknown word {got}"
        ))
    }
}

/// Parse and check a table, refusing in the words `fieldKindTable.ts` uses.
pub fn parse_table(raw: &str) -> Result<KindTable, String> {
    let t: KindTable = serde_json::from_str(raw).map_err(|e| format!("field-kinds: {e}"))?;
    if t.format != FORMAT {
        return Err(format!(
            "field-kinds: format must be {FORMAT}, not {}",
            t.format
        ));
    }
    if t.rule_version.trim().is_empty() {
        return Err("field-kinds: rule_version is empty".into());
    }
    if t.dates != DATES_REF {
        return Err(format!("field-kinds: dates must name {DATES_REF}"));
    }
    if t.atoms != ATOMS {
        return Err(format!(
            "field-kinds: atoms must be {} in order",
            joined(&ATOMS)
        ));
    }
    if t.url_prefixes.is_empty() {
        return Err("field-kinds: url_prefixes is empty".into());
    }
    if t.url_match != "prefix_ignoring_ascii_case" {
        return Err(format!(
            "field-kinds: url_match has an unknown word {}",
            t.url_match
        ));
    }
    let ids: Vec<&str> = FieldKind::ALL.iter().map(|k| k.id()).collect();
    if t.kinds
        .iter()
        .map(|k| k.kind.as_str())
        .ne(ids.iter().copied())
    {
        return Err(format!(
            "field-kinds: kinds must be {} in order",
            joined(&ids)
        ));
    }
    if t.filter_families.keys().map(String::as_str).ne(FAMILIES) {
        return Err(format!(
            "field-kinds: filter_families must be {} in order",
            joined(&FAMILIES)
        ));
    }
    for (family, ops) in &t.filter_families {
        if let Some(op) = ops.iter().find(|op| !t.filter_ops.contains(op)) {
            return Err(format!(
                "field-kinds: {family} names an operator {op} that filter_ops lacks"
            ));
        }
    }
    for k in &t.kinds {
        if let Some(atom) = k.accepts.iter().find(|a| !ATOMS.contains(&a.as_str())) {
            return Err(format!(
                "field-kinds: {} accepts an unknown atom {atom}",
                k.kind
            ));
        }
        if !FAMILIES.contains(&k.filters.as_str()) {
            return Err(format!(
                "field-kinds: {} filters by an unknown family {}",
                k.kind, k.filters
            ));
        }
        let mut required = vec!["shape"];
        if k.accepts.iter().any(|a| a == "date_range") {
            required.extend(["endpoint", "backwards"]);
        }
        if k.links {
            required.extend(["limit_one", "derived"]);
        }
        if let Some(missing) = required.iter().find(|m| !k.messages.contains_key(**m)) {
            return Err(format!(
                "field-kinds: {} is missing its {missing} message",
                k.kind
            ));
        }
    }
    if !t.status_groups.contains(&t.status_group_default) {
        return Err(format!(
            "field-kinds: status_group_default {} is not a status group",
            t.status_group_default
        ));
    }
    if t.status_chain != STATUS_CHAIN {
        return Err(format!(
            "field-kinds: status_chain must be {}",
            joined(&STATUS_CHAIN)
        ));
    }
    let mut seen: Vec<&str> = Vec::new();
    for s in &t.default_statuses {
        if !t.status_groups.contains(&s.group) {
            return Err(format!(
                "field-kinds: default status {} has an unknown group {}",
                s.id, s.group
            ));
        }
        if seen.contains(&s.id.as_str()) {
            return Err(format!(
                "field-kinds: default status {} is listed twice",
                s.id
            ));
        }
        seen.push(&s.id);
    }
    if t.rollup_calcs
        .iter()
        .map(|r| r.calc.as_str())
        .ne(ROLLUP_CALCS)
    {
        return Err(format!(
            "field-kinds: rollup_calcs must be {} in order",
            joined(&ROLLUP_CALCS)
        ));
    }
    if let Some(r) = t
        .rollup_calcs
        .iter()
        .find(|r| !ROLLUP_RESULTS.contains(&r.result.as_str()))
    {
        return Err(format!(
            "field-kinds: rollup {} has an unknown result {}",
            r.calc, r.result
        ));
    }
    if t.virtual_fields != VIRTUAL_FIELDS {
        return Err(format!(
            "field-kinds: virtual_fields must be {} in order",
            joined(&VIRTUAL_FIELDS)
        ));
    }
    collation_word("text_tests", &t.collation.text_tests, "lowercase")?;
    collation_word("equality", &t.collation.equality, "exact")?;
    collation_word("ordered", &t.collation.ordered, "number_date_code_unit")?;
    collation_word("sort", &t.collation.sort, "options_number_locale")?;
    Ok(t)
}

/// The compiled-in table, checked against its digest once.
pub fn table() -> Result<&'static KindTable, String> {
    static LOADED: OnceLock<Result<KindTable, String>> = OnceLock::new();
    LOADED
        .get_or_init(|| {
            if crate::ledger::sha256_hex(FIELD_KINDS_JSON.as_bytes()) != FIELD_KINDS_DIGEST.trim() {
                return Err(format!(
                    "field-kinds: the compiled bytes do not match {FIELD_KINDS_DIGEST_PATH}"
                ));
            }
            parse_table(FIELD_KINDS_JSON)
        })
        .as_ref()
        .map_err(Clone::clone)
}

// --- The Type-doc parse rules (buildSchema's) ------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FieldOption {
    pub id: String,
    pub label: String,
    pub color: Option<String>,
    pub hollow: bool,
}

/// A reverse source: the records of `type_name` whose `field` points here.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FromSpec {
    pub type_name: String,
    pub field: String,
}

/// One declared field: the parts a write is checked against. Display
/// settings (`format`, `dateFormat`, `visibility`, ...) stay TS-only UI.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FieldDef {
    pub name: String,
    pub kind: FieldKind,
    pub options: Option<Vec<FieldOption>>,
    pub target: Option<String>,
    pub limit_one: bool,
    pub relation: Option<String>,
    pub property: Option<String>,
    pub calculate: Option<String>,
    pub from: Option<FromSpec>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TypeSchema {
    pub name: String,
    pub fields: Vec<FieldDef>,
    pub statuses: Vec<StatusDef>,
    pub folder: Option<String>,
}

/// Which link of the status chain answered.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StatusSource {
    Project,
    Type,
    Default,
}

impl StatusSource {
    pub fn id(self) -> &'static str {
        match self {
            StatusSource::Project => "project",
            StatusSource::Type => "type",
            StatusSource::Default => "default",
        }
    }
}

/// `in-progress` → `In progress`: runs of `-` and `_` become one space, the
/// ends are trimmed, and the first character is capitalised.
pub fn humanize(id: &str) -> String {
    let mut words = String::with_capacity(id.len());
    let mut in_run = false;
    for c in id.chars() {
        if c == '-' || c == '_' {
            if !in_run {
                words.push(' ');
            }
            in_run = true;
        } else {
            words.push(c);
            in_run = false;
        }
    }
    let words = words.trim();
    let mut chars = words.chars();
    match chars.next() {
        None => id.to_string(),
        Some(first) => first.to_uppercase().chain(chars).collect(),
    }
}

/// The id a new option's label slugs to: trimmed, each whitespace run one
/// `-`, lowercased.
pub fn option_id(label: &str) -> String {
    let mut out = String::with_capacity(label.len());
    let mut in_run = false;
    for c in label.trim().chars() {
        if c.is_whitespace() {
            if !in_run {
                out.push('-');
            }
            in_run = true;
        } else {
            out.push(c);
            in_run = false;
        }
    }
    out.to_lowercase()
}

fn number_text(n: &serde_json::Number) -> String {
    n.to_string()
}

fn parse_option(raw: &Value) -> Option<FieldOption> {
    match raw {
        Value::String(id) => Some(FieldOption {
            id: id.clone(),
            label: humanize(id),
            color: None,
            hollow: false,
        }),
        Value::Object(o) => {
            let id = match o.get("id")? {
                Value::String(s) => s.clone(),
                Value::Number(n) => number_text(n),
                _ => return None,
            };
            Some(FieldOption {
                label: o
                    .get("label")
                    .and_then(Value::as_str)
                    .map_or_else(|| humanize(&id), str::to_string),
                color: o.get("color").and_then(Value::as_str).map(str::to_string),
                hollow: o.get("hollow") == Some(&Value::Bool(true)),
                id,
            })
        }
        _ => None,
    }
}

fn string_at(o: &serde_json::Map<String, Value>, key: &str) -> Option<String> {
    o.get(key).and_then(Value::as_str).map(str::to_string)
}

/// One `fields:` entry. An unknown or missing kind reads as text, and a
/// malformed key is dropped, never guessed at.
pub fn parse_field_def(name: &str, spec: &Value) -> FieldDef {
    let mut def = FieldDef {
        name: name.to_string(),
        kind: FieldKind::Text,
        options: None,
        target: None,
        limit_one: false,
        relation: None,
        property: None,
        calculate: None,
        from: None,
    };
    let kind_of = |v: Option<&Value>| {
        v.and_then(Value::as_str)
            .and_then(FieldKind::from_id)
            .unwrap_or(FieldKind::Text)
    };
    match spec {
        Value::String(_) => def.kind = kind_of(Some(spec)),
        Value::Object(s) => {
            def.kind = kind_of(s.get("kind"));
            if let Some(Value::Array(options)) = s.get("options") {
                def.options = Some(options.iter().filter_map(parse_option).collect());
            }
            def.target = string_at(s, "target");
            def.limit_one = match s.get("limit") {
                Some(Value::Number(n)) => n.as_f64() == Some(1.0),
                Some(Value::String(t)) => t == "1",
                _ => false,
            };
            def.relation = string_at(s, "relation");
            def.property = string_at(s, "property");
            def.calculate =
                string_at(s, "calculate").filter(|c| ROLLUP_CALCS.contains(&c.as_str()));
            if let Some(Value::Object(f)) = s.get("from") {
                if let (Some(type_name), Some(field)) =
                    (string_at(f, "type"), string_at(f, "field"))
                {
                    def.from = Some(FromSpec { type_name, field });
                }
            }
        }
        _ => {}
    }
    def
}

fn parse_fields(raw: Option<&Value>) -> Vec<FieldDef> {
    match raw {
        Some(Value::Object(map)) => map
            .iter()
            .map(|(name, spec)| parse_field_def(name, spec))
            .collect(),
        _ => Vec::new(),
    }
}

/// A `statuses:` list; an unknown group reads as the table's default group.
pub fn parse_statuses(raw: Option<&Value>, table: &KindTable) -> Vec<StatusDef> {
    let Some(Value::Array(items)) = raw else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|item| {
            let option = parse_option(item)?;
            let group = item
                .get("group")
                .and_then(Value::as_str)
                .filter(|g| table.status_groups.iter().any(|s| s == g))
                .unwrap_or(&table.status_group_default)
                .to_string();
            Some(StatusDef {
                id: option.id,
                label: option.label,
                color: option.color,
                group,
                hollow: option.hollow,
            })
        })
        .collect()
}

fn parse_folder(raw: Option<&Value>) -> Option<String> {
    let text = raw?.as_str()?.trim();
    if text.is_empty() {
        return None;
    }
    Some(text.trim_matches('/').to_string())
}

/// What a vault's Type docs declare, and the status chain over them.
#[derive(Debug, Clone)]
pub struct VaultSchema {
    types: HashMap<String, TypeSchema>,
    /// Every page's non-empty `statuses:`, by path: the project override.
    overrides: HashMap<String, Vec<StatusDef>>,
    defaults: Vec<StatusDef>,
}

impl VaultSchema {
    /// Read every `type: Type` doc; a later doc of the same title replaces
    /// an earlier one, as in `buildSchema`.
    pub fn from_entries(entries: &[Entry], table: &KindTable) -> VaultSchema {
        let mut types = HashMap::new();
        let mut overrides = HashMap::new();
        for e in entries {
            let statuses = parse_statuses(e.properties.get("statuses"), table);
            if e.entry_type.as_deref() == Some("Type") {
                types.insert(
                    e.title.clone(),
                    TypeSchema {
                        name: e.title.clone(),
                        fields: parse_fields(e.properties.get("fields")),
                        statuses: statuses.clone(),
                        folder: parse_folder(e.properties.get("folder")),
                    },
                );
            }
            if !statuses.is_empty() {
                overrides.insert(e.path.clone(), statuses);
            }
        }
        VaultSchema {
            types,
            overrides,
            defaults: table.default_statuses.clone(),
        }
    }

    pub fn type_named(&self, name: &str) -> Option<&TypeSchema> {
        self.types.get(name)
    }

    /// The field `name` as the entry's own type declares it.
    pub fn field_for(&self, entry: &Entry, name: &str) -> Option<&FieldDef> {
        let type_name = entry.entry_type.as_deref()?;
        self.types
            .get(type_name)?
            .fields
            .iter()
            .find(|f| f.name == name)
    }

    /// Project override, then the entry's own type, then the defaults.
    pub fn status_set_for(&self, entry: &Entry) -> (Vec<StatusDef>, StatusSource) {
        if let Some(over) = entry.project.as_ref().and_then(|p| self.overrides.get(p)) {
            return (over.clone(), StatusSource::Project);
        }
        if let Some(own) = entry
            .entry_type
            .as_deref()
            .and_then(|t| self.types.get(t))
            .filter(|t| !t.statuses.is_empty())
        {
            return (own.statuses.clone(), StatusSource::Type);
        }
        (self.defaults.clone(), StatusSource::Default)
    }

    /// The value a view reads for `name`, in `fieldValue`'s pinned order:
    /// an entry fact, then a declared created or edited time, then the
    /// relationship, then the property. A rollup or a derived relation reads
    /// None: Rust holds no relation index to compute them from, a gap the
    /// schema README records.
    pub fn field_value(&self, entry: &Entry, name: &str) -> Option<Value> {
        if let Some(v) = virtual_value(entry, name) {
            return v;
        }
        if let Some(def) = self.field_for(entry, name) {
            match def.kind {
                FieldKind::CreatedTime => return Some(Value::String(entry.created_at.clone())),
                FieldKind::LastEditedTime => return Some(Value::String(entry.modified_at.clone())),
                FieldKind::Rollup => return None,
                FieldKind::Person | FieldKind::Relation if def.from.is_some() => return None,
                _ => {}
            }
        }
        stored_value(entry, name)
    }
}

/// `Some(answer)` when `name` is a virtual field.
fn virtual_value(entry: &Entry, name: &str) -> Option<Option<Value>> {
    match name {
        "title" => Some(Some(Value::String(entry.title.clone()))),
        "type" => Some(entry.entry_type.clone().map(Value::String)),
        "createdAt" => Some(Some(Value::String(entry.created_at.clone()))),
        "modifiedAt" => Some(Some(Value::String(entry.modified_at.clone()))),
        _ => None,
    }
}

/// What the page stores for `name`: an entry fact, then the relationship
/// targets (bracket-stripped by the scanner), then the property.
pub fn stored_value(entry: &Entry, name: &str) -> Option<Value> {
    if let Some(v) = virtual_value(entry, name) {
        return v;
    }
    if let Some(targets) = entry.relationships.get(name) {
        return Some(Value::Array(
            targets.iter().cloned().map(Value::String).collect(),
        ));
    }
    entry.properties.get(name).cloned()
}

fn url_text(value: &Value, table: &KindTable) -> bool {
    let Some(text) = value.as_str() else {
        return false;
    };
    text.is_empty()
        || table.url_prefixes.iter().any(|p| {
            text.len() >= p.len()
                && text.is_char_boundary(p.len())
                && text[..p.len()].eq_ignore_ascii_case(p)
        })
}

fn atom_holds(atom: &str, value: &Value, table: &KindTable) -> bool {
    match atom {
        "string" => value.is_string(),
        "number" => value.is_number(),
        "boolean" => value.is_boolean(),
        "string_list" => value
            .as_array()
            .is_some_and(|items| items.iter().all(Value::is_string)),
        "date_text" => dates::is_date_text(value),
        "date_range" => value.is_object(),
        "url_text" => url_text(value, table),
        _ => false,
    }
}

/// Check one value against its declared field, in the order the schema
/// README states: null passes, then computed, derived, the accepted atoms,
/// a range's faults, and the one-link limit. The error is TS's sentence.
pub fn validate_value(def: &FieldDef, value: &Value, table: &KindTable) -> Result<(), String> {
    if value.is_null() {
        return Ok(());
    }
    let facts = table.facts(def.kind);
    let say = |key: &str| Err(facts.message(key, &def.name));
    if facts.computed {
        return say("shape");
    }
    if facts.links && def.from.is_some() {
        return say("derived");
    }
    let Some(atom) = facts.accepts.iter().find(|a| atom_holds(a, value, table)) else {
        return say("shape");
    };
    if atom == "date_range" {
        match dates::range_fault(value) {
            Some(RangeFault::Shape) => return say("shape"),
            Some(RangeFault::Endpoint) => return say("endpoint"),
            Some(RangeFault::Backwards) => return say("backwards"),
            None => {}
        }
    }
    if facts.links && def.limit_one && value.as_array().is_some_and(|items| items.len() > 1) {
        return say("limit_one");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn repo(rel: &str) -> std::path::PathBuf {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join(rel)
    }

    fn t() -> &'static KindTable {
        table().expect("the shipped table loads")
    }

    fn cases(section: &str) -> &'static Vec<Value> {
        t().cases[section]
            .as_array()
            .unwrap_or_else(|| panic!("cases.{section} is a list"))
    }

    #[test]
    fn the_loaded_bytes_match_the_committed_digest() {
        let committed = std::fs::read_to_string(repo(FIELD_KINDS_DIGEST_PATH))
            .expect("read the committed field-kind digest")
            .trim()
            .to_string();
        assert_eq!(
            crate::ledger::sha256_hex(FIELD_KINDS_JSON.as_bytes()),
            committed,
            "the table changed without regenerating {FIELD_KINDS_DIGEST_PATH} — run \
             `cargo test --lib vault::schema::tests::write_field_kinds_digest -- --ignored`"
        );
        let disk = std::fs::read_to_string(repo(FIELD_KINDS_PATH)).expect("read the table");
        assert_eq!(disk, FIELD_KINDS_JSON, "a stale build: recompile");
        t();
    }

    /// Re-stamp the digest after a deliberate table edit.
    #[test]
    #[ignore = "run explicitly after a deliberate field-kind edit"]
    fn write_field_kinds_digest() {
        let digest = crate::ledger::sha256_hex(FIELD_KINDS_JSON.as_bytes());
        std::fs::write(repo(FIELD_KINDS_DIGEST_PATH), format!("{digest}\n")).unwrap();
    }

    fn def_from_case(raw: &Value) -> FieldDef {
        parse_field_def(raw["name"].as_str().unwrap(), raw)
    }

    #[test]
    fn replays_the_value_cases() {
        for case in cases("values") {
            let name = case["name"].as_str().unwrap();
            let def = def_from_case(&case["def"]);
            let got = validate_value(&def, &case["value"], t()).err();
            assert_eq!(
                got.map(Value::String).unwrap_or(Value::Null),
                case["error"],
                "{name}"
            );
        }
    }

    fn option_json(o: &FieldOption) -> Value {
        json!({ "id": o.id, "label": o.label, "color": o.color, "hollow": o.hollow })
    }

    fn def_json(d: &FieldDef) -> Value {
        json!({
            "kind": d.kind.id(),
            "options": d.options.as_ref().map(|o| o.iter().map(option_json).collect::<Vec<_>>()),
            "target": d.target,
            "limit": if d.limit_one { json!(1) } else { Value::Null },
            "relation": d.relation,
            "property": d.property,
            "calculate": d.calculate,
            "from": d.from.as_ref().map(|f| json!({ "type": f.type_name, "field": f.field })),
        })
    }

    #[test]
    fn replays_the_field_def_cases() {
        for case in cases("field_defs") {
            let name = case["name"].as_str().unwrap();
            let def = parse_field_def(case["field"].as_str().unwrap(), &case["spec"]);
            assert_eq!(def_json(&def), case["expect"], "{name}");
        }
    }

    fn entry_from_case(raw: &Value) -> Entry {
        let mut e = Entry::empty_for_test(raw["path"].as_str().unwrap());
        e.title = raw["title"].as_str().unwrap().to_string();
        e.entry_type = raw["type"].as_str().map(str::to_string);
        e.project = raw["project"].as_str().map(str::to_string);
        e.properties = raw["properties"].as_object().cloned().unwrap_or_default();
        e
    }

    fn status_json(s: &StatusDef) -> Value {
        json!({ "id": s.id, "label": s.label, "color": s.color, "group": s.group, "hollow": s.hollow })
    }

    #[test]
    fn replays_the_status_chain_cases() {
        for case in cases("statuses") {
            let name = case["name"].as_str().unwrap();
            let entries: Vec<Entry> = case["entries"]
                .as_array()
                .unwrap()
                .iter()
                .map(entry_from_case)
                .collect();
            let schema = VaultSchema::from_entries(&entries, t());
            let subject = entries
                .iter()
                .find(|e| e.path == case["subject"].as_str().unwrap())
                .unwrap();
            let (set, source) = schema.status_set_for(subject);
            let got = json!({
                "source": source.id(),
                "statuses": set.iter().map(status_json).collect::<Vec<_>>(),
            });
            assert_eq!(got, case["expect"], "{name}");
        }
    }

    #[test]
    fn replays_the_option_and_label_cases() {
        for case in cases("options") {
            let label = case["label"].as_str().unwrap();
            assert_eq!(option_id(label), case["id"].as_str().unwrap(), "{label:?}");
        }
        for case in cases("labels") {
            let id = case["id"].as_str().unwrap();
            assert_eq!(humanize(id), case["label"].as_str().unwrap(), "{id:?}");
        }
    }

    #[test]
    fn replays_the_precedence_cases() {
        for case in cases("precedence") {
            let name = case["name"].as_str().unwrap();
            let raw = &case["entry"];
            let mut e = Entry::empty_for_test("records/alpha.md");
            e.title = raw["title"].as_str().unwrap().to_string();
            e.entry_type = raw["type"].as_str().map(str::to_string);
            e.properties = raw["properties"].as_object().cloned().unwrap_or_default();
            e.relationships = serde_json::from_value(raw["relationships"].clone()).unwrap();
            e.created_at = raw["createdAt"].as_str().unwrap().to_string();
            e.modified_at = raw["modifiedAt"].as_str().unwrap().to_string();
            let mut entries = vec![e.clone()];
            if let Some(type_name) = e.entry_type.clone() {
                let mut doc = Entry::empty_for_test("types/t.md");
                doc.title = type_name;
                doc.entry_type = Some("Type".into());
                doc.properties
                    .insert("fields".into(), case["fields"].clone());
                entries.insert(0, doc);
            }
            let schema = VaultSchema::from_entries(&entries, t());
            let got = schema
                .field_value(&e, case["field"].as_str().unwrap())
                .unwrap_or(Value::Null);
            assert_eq!(got, case["expect"], "{name}");
        }
    }

    #[test]
    fn refuses_a_table_whose_kinds_differ_from_the_enum() {
        let refuse = |edit: &dyn Fn(&mut Value)| {
            let mut v: Value = serde_json::from_str(FIELD_KINDS_JSON).unwrap();
            edit(&mut v);
            parse_table(&v.to_string()).unwrap_err()
        };
        let ids: Vec<&str> = FieldKind::ALL.iter().map(|k| k.id()).collect();
        assert_eq!(
            refuse(&|v| {
                let kinds = v["kinds"].as_array_mut().unwrap();
                kinds.swap(0, 1);
            }),
            format!("field-kinds: kinds must be {} in order", ids.join(", "))
        );
        assert_eq!(
            refuse(&|v| v["kinds"][0]["accepts"] = json!(["string", "prose"])),
            "field-kinds: text accepts an unknown atom prose"
        );
        assert_eq!(
            refuse(&|v| v["filter_families"]["date"] = json!(["equals", "around"])),
            "field-kinds: date names an operator around that filter_ops lacks"
        );
        assert_eq!(
            refuse(&|v| {
                v["kinds"][8]["messages"]
                    .as_object_mut()
                    .unwrap()
                    .remove("derived");
            }),
            "field-kinds: person is missing its derived message"
        );
        assert_eq!(
            refuse(&|v| v["format"] = json!(2)),
            "field-kinds: format must be 1, not 2"
        );
        assert_eq!(
            refuse(&|v| v["rule_version"] = json!(" ")),
            "field-kinds: rule_version is empty"
        );
        assert_eq!(
            refuse(&|v| v["default_statuses"][0]["group"] = json!("someday")),
            "field-kinds: default status backlog has an unknown group someday"
        );
        assert_eq!(
            refuse(&|v| v["default_statuses"][1]["id"] = json!("backlog")),
            "field-kinds: default status backlog is listed twice"
        );
        assert_eq!(
            refuse(&|v| v["collation"]["sort"] = json!("icu")),
            "field-kinds: collation sort has an unknown word icu"
        );
    }

    #[test]
    fn the_demo_vault_schema_reads() {
        let vault = repo("demo-vault");
        let entries = crate::vault::scan::scan_vault(&vault).expect("scan the demo vault");
        let schema = VaultSchema::from_entries(&entries, t());
        let work = schema
            .type_named("Work item")
            .expect("Work item is declared");
        let field = |name: &str| {
            work.fields
                .iter()
                .find(|f| f.name == name)
                .unwrap_or_else(|| panic!("Work item declares {name}"))
        };
        assert_eq!(field("assignee").kind, FieldKind::Person);
        let epic = field("epic");
        assert_eq!(epic.kind, FieldKind::Relation);
        assert_eq!(epic.target.as_deref(), Some("Epic"));
        assert_eq!(field("window").kind, FieldKind::Daterange);
        // No project.md in the corpus overrides it, so a work item's statuses
        // come from its Type doc.
        let record = entries
            .iter()
            .find(|e| e.entry_type.as_deref() == Some("Work item"))
            .expect("the demo vault holds a work item");
        let (set, source) = schema.status_set_for(record);
        assert_eq!(source, StatusSource::Type);
        assert_eq!(set, work.statuses);
        assert!(work.statuses.iter().any(|s| s.id == "progress"));
        // phx-421's fetched_at is the instant mcp.rs writes, and it checks.
        let source_type = schema.type_named("Source").expect("Source is declared");
        let fetched = source_type
            .fields
            .iter()
            .find(|f| f.name == "fetched_at")
            .expect("Source declares fetched_at");
        assert_eq!(
            validate_value(fetched, &json!("2026-07-28T09:20:00Z"), t()),
            Ok(())
        );
    }
}
