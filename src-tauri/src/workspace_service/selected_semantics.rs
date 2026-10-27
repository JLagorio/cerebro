//! Canonical structured reads over one actual guarded selected snapshot.
//! Private MCP callers retain current authority; rows never mint a grant.
use super::*;
use crate::vault::{
    agenda, dates, query as legacy,
    schema::{self, FieldKind, KindTable, VaultSchema},
    views,
};
use serde::Deserialize;
use serde_json::{Map, Value};
use std::{cmp::Ordering, sync::OnceLock};
type Result<T> = std::result::Result<T, AuthorityError>;
fn unsupported(message: impl Into<String>) -> AuthorityError {
    error(AuthorityErrorKind::UnsupportedProjection, message)
}
fn bad(message: impl Into<String>) -> AuthorityError {
    error(AuthorityErrorKind::UnsupportedOperation, message)
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QueryPolicy {
    temporal_sort: TemporalSortPolicy,
    version: u32,
    field_kinds: String,
    tagged_scalar_kinds: Vec<String>,
    raw_scalar_kinds: Vec<String>,
    raw_numbers: String,
    raw_integer_limit_ref: String,
    array_operands: String,
    missing_equals_scalar: bool,
    cross_kind_equality: String,
    cross_kind_ordering: String,
    decimal_comparison: String,
    date_string_operands: String,
    result_values: String,
    empty_values: Vec<String>,
    sort_empty: String,
    sort_tie: String,
    default_order: String,
    raw_null: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TemporalSortPolicy {
    primary: String,
    calendar_day_time: String,
    same_midnight: String,
    repeated_wall_time: String,
    tie: String,
}
struct Policy {
    query: QueryPolicy,
    safe_integer: u64,
}
fn policy() -> Result<&'static Policy> {
    static POLICY: OnceLock<std::result::Result<Policy, String>> = OnceLock::new();
    POLICY
        .get_or_init(|| {
            let all: Value =
                serde_json::from_str(include_str!("../../../shared/workspace/values.v1.json"))
                    .map_err(|_| "Selected query vocabulary is unavailable.")?;
            let query: QueryPolicy = serde_json::from_value(all["selectedQuery"].clone())
                .map_err(|_| "Selected query vocabulary is invalid.")?;
            if query.temporal_sort.primary != "shared_calendar_local_date_wall_time"
                || query.temporal_sort.calendar_day_time != "midnight"
                || query.temporal_sort.same_midnight != "date_before_instant"
                || query.temporal_sort.repeated_wall_time != "absolute_nanosecond"
                || query.temporal_sort.tie != "record_id"
                || query.version != 1
                || query.field_kinds != schema::FIELD_KINDS_PATH
                || query.raw_numbers != "canonical_safe_integers_only"
                || query.raw_integer_limit_ref != "decimal.legacyMaxSafeInteger"
                || query.array_operands != "operator_lists_only"
                || query.missing_equals_scalar
                || query.cross_kind_equality != "unequal"
                || query.cross_kind_ordering != "unsupported"
                || query.decimal_comparison != "exact_numeric_value"
                || query.date_string_operands != "declared_date_family_only"
                || query.result_values != "tagged_present_keys_only"
                || query.sort_empty != "last"
                || query.sort_tie != "record_id"
                || query.default_order != "path"
                || query.raw_null != "explicit_null_when_value_key_present"
            {
                return Err("Selected query vocabulary is unsupported.".into());
            }
            let safe_integer = all["decimal"]["legacyMaxSafeInteger"]
                .as_str()
                .and_then(|value| value.parse().ok())
                .ok_or("Selected numeric bound is unavailable.")?;
            Ok(Policy {
                query,
                safe_integer,
            })
        })
        .as_ref()
        .map_err(|message| bad(message.clone()))
}
struct Row {
    entry: Entry,
    id: String,
    properties: BTreeMap<String, PropertyValue>,
}
struct Frame {
    rows: Vec<Row>,
    schema: VaultSchema,
    withheld: usize,
}
fn frame(root: &Path, admits: &dyn Fn(&str) -> bool) -> Result<Frame> {
    policy()?;
    let binding = authority::selected_binding(root)?;
    let guard = store::read_guard(&binding)?;
    let conn = connection(&binding, false)?;
    let tx = conn
        .unchecked_transaction()
        .map_err(|_| missing("Canonical semantic snapshot is unavailable."))?;
    let snapshot = read_snapshot(&tx, &binding)?;
    check_pairing(&binding, &snapshot)?;
    let mut rows = Vec::new();
    let mut withheld = 0usize;
    let mut total = 0usize;
    let mut types = BTreeSet::new();
    for record in snapshot.records {
        if !admits(&record.path) {
            withheld += 1;
            continue;
        }
        let PropertyValue::Object { value: properties } = &record.metadata else {
            return Err(invalid("Canonical properties must be an object."));
        };
        let entry_type = match properties.get("type") {
            None | Some(PropertyValue::Null {}) => None,
            Some(PropertyValue::String { value }) => Some(value.clone()),
            _ => return Err(unsupported("Canonical type must be text or null.")),
        };
        let remaining = u64::try_from(rules().limits.aggregate_body_bytes.saturating_sub(total))
            .map_err(|_| unsupported("Canonical body budget is unavailable."))?;
        let exact = body(&binding, &record, rules().limits.body_bytes.min(remaining))?;
        total = total
            .checked_add(exact.len())
            .ok_or_else(|| unsupported("Canonical body budget exceeded."))?;
        let mut projected = Map::new();
        let keys = if entry_type.as_deref() == Some("Type") {
            &["fields", "statuses", "folder", "deadline"][..]
        } else if record.path.rsplit('/').next() == Some("project.md") {
            &["statuses"][..]
        } else {
            &[][..]
        };
        for key in keys {
            if let Some(value) = properties.get(*key) {
                projected.insert(
                    (*key).into(),
                    value::legacy_value(value).map_err(|error| {
                        unsupported(format!(
                            "Schema declaration cannot be represented exactly: {}",
                            error.message
                        ))
                    })?,
                );
            }
        }
        let unavailable_legacy_keys = properties
            .keys()
            .filter(|key| !projected.contains_key(key.as_str()))
            .cloned()
            .collect();
        let metadata = EntryMetadata {
            properties: projected,
            entry_type,
            canonical_properties: SelectedEntryProperties {
                value: record.metadata.clone(),
                unavailable_legacy_keys,
            },
        };
        let entry = entry_with_metadata(&binding, &record, &exact, metadata)?;
        if entry.entry_type.as_deref() == Some("Type") && !types.insert(entry.title.to_lowercase())
        {
            return Err(unsupported(
                "More than one readable Type doc declares the same database meaning.",
            ));
        }
        let PropertyValue::Object { value: properties } = record.metadata else {
            return Err(invalid("Canonical properties must be an object."));
        };
        rows.push(Row {
            entry,
            id: record.id,
            properties,
        });
    }
    let mut entries = rows.iter().map(|row| row.entry.clone()).collect::<Vec<_>>();
    crate::vault::scan::assign_projects(&mut entries);
    for (row, entry) in rows.iter_mut().zip(&entries) {
        row.entry.project = entry.project.clone();
    }
    let schema = VaultSchema::from_entries(&entries, schema::table().map_err(bad)?);
    store::handle_unmoved(&tx)?;
    private_database(&binding)?;
    if let Some(guard) = &guard {
        guard.validate()?;
    }
    if authority::selected_binding(root)? != binding {
        return Err(error(
            AuthorityErrorKind::WrongIdentity,
            "Canonical semantic binding changed.",
        ));
    }
    tx.commit()
        .map_err(|_| missing("Canonical semantic snapshot could not finish."))?;
    Ok(Frame {
        rows,
        schema,
        withheld,
    })
}

fn kind(value: &PropertyValue) -> &'static str {
    match value {
        PropertyValue::Null {} => "null",
        PropertyValue::String { .. } => "string",
        PropertyValue::Boolean { .. } => "boolean",
        PropertyValue::Decimal { .. } => "decimal",
        PropertyValue::Date { .. } => "date",
        PropertyValue::Instant { .. } => "instant",
        PropertyValue::Array { .. } => "array",
        PropertyValue::Object { .. } => "object",
        PropertyValue::Relation { .. } => "relation",
    }
}
fn scalar_operand(raw: &Value) -> Result<PropertyValue> {
    let policy = policy()?;
    let value = match raw {
        Value::Null => PropertyValue::Null {},
        Value::String(value) if policy.query.raw_scalar_kinds.iter().any(|k| k == "string") => {
            PropertyValue::String {
                value: value.clone(),
            }
        }
        Value::Bool(value) if policy.query.raw_scalar_kinds.iter().any(|k| k == "boolean") => {
            PropertyValue::Boolean { value: *value }
        }
        Value::Number(number) => {
            let text = if let Some(n) = number
                .as_i64()
                .filter(|n| n.unsigned_abs() <= policy.safe_integer)
            {
                n.to_string()
            } else if let Some(n) = number.as_u64().filter(|n| *n <= policy.safe_integer) {
                n.to_string()
            } else {
                return Err(unsupported("Numeric operands outside canonical safe integers require a tagged exact decimal lexeme."));
            };
            PropertyValue::Decimal { value: text }
        }
        Value::Object(_) => value::decode_tagged(&raw.to_string())
            .map_err(|failure| unsupported(failure.message))?,
        _ => {
            return Err(unsupported(
                "This predicate requires a supported scalar operand.",
            ))
        }
    };
    if !policy
        .query
        .tagged_scalar_kinds
        .iter()
        .any(|k| k == kind(&value))
    {
        return Err(unsupported(
            "Structural and relation predicates have no supported canonical identity semantics.",
        ));
    }
    Ok(value)
}
fn field(row: &Row, name: &str, schema: &VaultSchema) -> Option<PropertyValue> {
    if legacy::hidden_agent_field(row.entry.entry_type.as_deref(), name) {
        return None;
    }
    let timestamp = |value: &str| {
        if value.is_empty() {
            None
        } else {
            Some(PropertyValue::Instant {
                value: value.into(),
            })
        }
    };
    match name {
        "title" => Some(PropertyValue::String {
            value: row.entry.title.clone(),
        }),
        "createdAt" => timestamp(&row.entry.created_at),
        "modifiedAt" => timestamp(&row.entry.modified_at),
        _ => match schema.field_for(&row.entry, name).map(|def| def.kind) {
            Some(FieldKind::CreatedTime) => timestamp(&row.entry.created_at),
            Some(FieldKind::LastEditedTime) => timestamp(&row.entry.modified_at),
            _ => row.properties.get(name).cloned(),
        },
    }
}
fn source<'a>(frame: &'a Frame, wanted: Option<&str>) -> Result<Vec<&'a Row>> {
    let entries = frame
        .rows
        .iter()
        .map(|row| row.entry.clone())
        .collect::<Vec<_>>();
    let paths = legacy::source_for(&entries, wanted)
        .map_err(bad)?
        .into_iter()
        .map(|entry| entry.path.as_str())
        .collect::<BTreeSet<_>>();
    let mut rows = frame
        .rows
        .iter()
        .filter(|row| paths.contains(row.entry.path.as_str()))
        .collect::<Vec<_>>();
    rows.sort_by(|a, b| a.entry.path.cmp(&b.entry.path));
    Ok(rows)
}
fn canonical_infos(
    rows: &[&Row],
    wanted: Option<&str>,
    schema: &VaultSchema,
    table: &KindTable,
) -> BTreeMap<String, legacy::FieldInfo> {
    let entries = rows.iter().map(|row| &row.entry).collect::<Vec<_>>();
    let mut infos = legacy::field_infos(&entries, wanted, schema, table);
    for row in rows {
        for (name, value) in &row.properties {
            if legacy::hidden_agent_field(row.entry.entry_type.as_deref(), name) {
                continue;
            }
            let info = infos.entry(name.clone()).or_insert_with(|| {
                legacy::FieldInfo::held(match value {
                    PropertyValue::Decimal { .. } => FieldKind::Number,
                    PropertyValue::Boolean { .. } => FieldKind::Checkbox,
                    PropertyValue::Date { .. } | PropertyValue::Instant { .. } => FieldKind::Date,
                    _ => FieldKind::Text,
                })
            });
            let strings = match value {
                PropertyValue::String { value } => vec![value],
                PropertyValue::Array { value } => value
                    .iter()
                    .filter_map(|value| match value {
                        PropertyValue::String { value } => Some(value),
                        _ => None,
                    })
                    .collect(),
                _ => Vec::new(),
            };
            for value in strings {
                let value = Value::String(value.clone());
                if !info.recorded.contains(&value) {
                    info.recorded.push(value);
                }
            }
        }
    }
    infos
}
fn checked_info<'a>(
    name: &str,
    infos: &'a BTreeMap<String, legacy::FieldInfo>,
) -> Result<&'a legacy::FieldInfo> {
    let info = infos
        .get(name)
        .ok_or_else(|| bad(format!("Unknown readable field: {name}.")))?;
    if info.is_conflicting() {
        return Err(unsupported(format!(
            "{name} has conflicting readable declarations; name one database."
        )));
    }
    if info.declared().is_some_and(|def| {
        matches!(def.kind, FieldKind::Rollup | FieldKind::Formula) || def.from.is_some()
    }) {
        return Err(unsupported(format!(
            "{name} is computed and has no canonical stored predicate value."
        )));
    }
    Ok(info)
}
fn family<'a>(name: &str, info: &'a legacy::FieldInfo, table: &'a KindTable) -> &'a str {
    if info.declared().is_none() && !table.virtual_fields.iter().any(|field| field == name) {
        "any"
    } else {
        &table.facts(info.kind).filters
    }
}
fn is_empty(value: Option<&PropertyValue>) -> Result<bool> {
    let modes = &policy()?.query.empty_values;
    Ok(match value {
        None => modes.iter().any(|m| m == "absent"),
        Some(PropertyValue::Null {}) => modes.iter().any(|m| m == "null"),
        Some(PropertyValue::String { value }) if value.is_empty() => {
            modes.iter().any(|m| m == "empty_string")
        }
        Some(PropertyValue::Array { value }) if value.is_empty() => {
            modes.iter().any(|m| m == "empty_array")
        }
        _ => false,
    })
}
fn date_text(value: &PropertyValue, ranges: bool) -> Result<Option<Value>> {
    match value {
        PropertyValue::Null {} => Ok(None),
        PropertyValue::Date { value } | PropertyValue::Instant { value } => Ok(Some(Value::String(value.clone()))),
        PropertyValue::Object { value } if ranges => {
            if value.keys().any(|key| !["start", "end"].contains(&key.as_str())) { return Err(unsupported("A canonical date range contains only start and end.")); }
            let mut result = Map::new();
            for (name, endpoint) in value { match endpoint {
                PropertyValue::Null {} => { result.insert(name.clone(), Value::Null); },
                PropertyValue::Date { value } | PropertyValue::Instant { value } => { result.insert(name.clone(), Value::String(value.clone())); },
                _ => return Err(unsupported("Canonical date-range endpoints require date or instant tags.")),
            } }
            Ok(Some(Value::Object(result)))
        },
        _ => Err(unsupported("A declared date requires canonical date or instant values; date-looking text is not converted.")),
    }
}
fn date_endpoint(
    value: &PropertyValue,
    ranges: bool,
    zone: chrono_tz::Tz,
) -> Result<Option<dates::Endpoint>> {
    date_text(value, ranges)?
        .map(|raw| {
            dates::read_date_value(&raw, &zone)
                .map(|value| value.start)
                .ok_or_else(|| {
                    unsupported(
                        "Canonical date value cannot be read by the shared calendar grammar.",
                    )
                })
        })
        .transpose()
}
fn compare(
    a: &PropertyValue,
    b: &PropertyValue,
    date_family: bool,
    zone: chrono_tz::Tz,
    today: chrono::NaiveDate,
) -> Result<Option<Ordering>> {
    // Two zoned instants compare as moments, including repeated local times.
    if let (PropertyValue::Instant { value: a }, PropertyValue::Instant { value: b }) = (a, b) {
        let a = chrono::DateTime::parse_from_rfc3339(a)
            .map_err(|_| unsupported("Invalid canonical instant."))?;
        let b = chrono::DateTime::parse_from_rfc3339(b)
            .map_err(|_| unsupported("Invalid canonical instant."))?;
        return Ok(Some(a.cmp(&b)));
    }
    if date_family {
        if let (PropertyValue::Instant { value: a }, PropertyValue::String { value: b }) = (a, b) {
            if let (Ok(a), Ok(b)) = (
                chrono::DateTime::parse_from_rfc3339(a),
                chrono::DateTime::parse_from_rfc3339(b),
            ) {
                return Ok(Some(a.cmp(&b)));
            }
        }
        let item = match a {
            PropertyValue::String { value } => dates::parse_date_text(value, &zone).or_else(|| {
                dates::resolve_relative(value, today, 0).map(|(date, _)| dates::Endpoint {
                    date,
                    time: None,
                    instant: false,
                })
            }),
            _ => date_endpoint(a, true, zone)?,
        };
        let Some(item) = item else {
            return Ok(None);
        };
        if let PropertyValue::String { value } = b {
            if let Some((start, end)) = dates::resolve_relative(value, today, 0) {
                return Ok(Some(if item.date < start {
                    Ordering::Less
                } else if item.date > end {
                    Ordering::Greater
                } else {
                    Ordering::Equal
                }));
            }
        }
        let bound = match b {
            PropertyValue::String { value } => dates::parse_date_text(value, &zone),
            _ => date_endpoint(b, false, zone)?,
        };
        let bound = bound.ok_or_else(|| {
            unsupported("Date operands require a shared calendar date or relative token.")
        })?;
        return Ok(Some(if let Some(time) = bound.time {
            (item.date, item.time.unwrap_or(chrono::NaiveTime::MIN)).cmp(&(bound.date, time))
        } else {
            item.date.cmp(&bound.date)
        }));
    }
    match (a, b) {
        (PropertyValue::Decimal { value: a }, PropertyValue::Decimal { value: b }) => {
            value::compare_decimals(a, b)
                .map(Some)
                .map_err(|e| unsupported(e.message))
        }
        (PropertyValue::String { value: a }, PropertyValue::String { value: b }) => {
            Ok(Some(a.cmp(b)))
        }
        (PropertyValue::Boolean { value: a }, PropertyValue::Boolean { value: b }) => {
            Ok(Some(a.cmp(b)))
        }
        (PropertyValue::Date { value: a }, PropertyValue::Date { value: b }) => Ok(Some(a.cmp(b))),
        (PropertyValue::Instant { value: a }, PropertyValue::Instant { value: b }) => {
            let a = chrono::DateTime::parse_from_rfc3339(a)
                .map_err(|_| unsupported("Invalid canonical instant."))?;
            let b = chrono::DateTime::parse_from_rfc3339(b)
                .map_err(|_| unsupported("Invalid canonical instant."))?;
            Ok(Some(a.cmp(&b)))
        }
        (PropertyValue::Null {}, PropertyValue::Null {}) => Ok(Some(Ordering::Equal)),
        _ if policy()?
            .query
            .tagged_scalar_kinds
            .iter()
            .any(|k| k == kind(a))
            && policy()?
                .query
                .tagged_scalar_kinds
                .iter()
                .any(|k| k == kind(b)) =>
        {
            Ok(None)
        }
        _ => Err(unsupported(
            "Structural and relation comparison is unsupported.",
        )),
    }
}

struct CheckedRule {
    field: String,
    op: String,
    targets: Vec<PropertyValue>,
    date: bool,
    multi: bool,
}
enum CheckedFilter {
    All(Vec<CheckedFilter>),
    Any(Vec<CheckedFilter>),
    Rule(CheckedRule),
}
fn rule_values(rule: &legacy::Rule) -> Result<Vec<PropertyValue>> {
    match rule.op.as_str() {
        "is_empty" | "is_not_empty" => {
            if rule.value.is_some() {
                return Err(bad("Empty predicates take no value."));
            }
            Ok(Vec::new())
        }
        "any_of" | "none_of" | "is_between" => {
            let values = rule.value.as_ref().and_then(Value::as_array).filter(|values| !values.is_empty() && (rule.op != "is_between" || values.len()==2)).ok_or_else(||bad("List predicates require a nonempty operand list; between requires two bounds."))?;
            values.iter().map(scalar_operand).collect()
        }
        _ => Ok(vec![scalar_operand(rule.value.as_ref().ok_or_else(
            || bad("This predicate requires a present value key."),
        )?)?]),
    }
}
fn ordered(op: &str) -> bool {
    [
        "gt",
        "gte",
        "lt",
        "lte",
        "before",
        "after",
        "on_or_before",
        "on_or_after",
        "is_between",
    ]
    .contains(&op)
}
fn text_op(op: &str) -> bool {
    ["contains", "does_not_contain", "starts_with", "ends_with"].contains(&op)
}
fn rule_for(
    rule: &legacy::Rule,
    rows: &[&Row],
    schema: &VaultSchema,
    infos: &BTreeMap<String, legacy::FieldInfo>,
    table: &KindTable,
    zone: chrono_tz::Tz,
    today: chrono::NaiveDate,
    view: bool,
) -> Result<CheckedRule> {
    let info = checked_info(&rule.field, infos)?;
    let family = family(&rule.field, info, table);
    if !table.filter_ops.contains(&rule.op) || !table.filter_families[family].contains(&rule.op) {
        return Err(bad(format!(
            "{} does not apply to {} ({}).",
            rule.op,
            rule.field,
            info.kind.id()
        )));
    }
    let targets = rule_values(rule)?;
    if table.facts(info.kind).links && !["is_empty", "is_not_empty"].contains(&rule.op.as_str()) {
        return Err(unsupported(
            "Relation predicates require canonical target-identity semantics and are unavailable.",
        ));
    }
    let date = family == "date";
    let multi = info.declared().is_some()
        && table.facts(info.kind).multi
        && table
            .facts(info.kind)
            .accepts
            .iter()
            .any(|value| value == "string_list")
        && !table.facts(info.kind).links;
    for target in &targets {
        if matches!(target, PropertyValue::Null {}) && !ordered(&rule.op) && !text_op(&rule.op) {
            continue;
        }
        let valid = match family {
            "number" => matches!(target, PropertyValue::Decimal { .. }),
            "boolean" => matches!(target, PropertyValue::Boolean { .. }),
            "date" => match target {
                PropertyValue::Date { .. } | PropertyValue::Instant { .. } => true,
                PropertyValue::String { value } => {
                    dates::parse_date_text(value, &zone).is_some()
                        || dates::resolve_relative(value, today, 0).is_some()
                }
                _ => false,
            },
            "text" | "choice" | "multi" => matches!(target, PropertyValue::String { .. }),
            _ => !text_op(&rule.op) || matches!(target, PropertyValue::String { .. }),
        };
        if !valid {
            return Err(unsupported(format!(
                "Operand kind is unsupported for {}.",
                rule.field
            )));
        }
        if [FieldKind::Status, FieldKind::Select, FieldKind::Multiselect].contains(&info.kind)
            && (view || !info.options.is_empty())
        {
            let PropertyValue::String { value } = target else {
                return Err(unsupported("Option predicates require exact option ids."));
            };
            if !info.options.iter().any(|(id, _)| id == value)
                && !info
                    .recorded
                    .iter()
                    .any(|record| record.as_str() == Some(value))
            {
                return Err(bad(format!(
                    "{value} is not a recorded option id of {}.",
                    rule.field
                )));
            }
        }
    }
    let checked = CheckedRule {
        field: rule.field.clone(),
        op: rule.op.clone(),
        targets,
        date,
        multi,
    };
    // Inspect every referenced value before any Boolean branch can short-circuit.
    for row in rows {
        let raw = field(row, &rule.field, schema);
        if ["is_empty", "is_not_empty"].contains(&rule.op.as_str()) {
            is_empty(raw.as_ref())?;
            continue;
        }
        let Some(raw) = raw.as_ref() else {
            continue;
        };
        if matches!(raw, PropertyValue::Null {}) {
            continue;
        }
        let items = scalar_items(raw, multi, date)?;
        for item in items {
            if date {
                date_endpoint(item, info.kind == FieldKind::Daterange, zone)?;
            } else {
                if family == "number" && !matches!(item, PropertyValue::Decimal { .. })
                    || family == "boolean" && !matches!(item, PropertyValue::Boolean { .. })
                    || text_op(&rule.op) && !matches!(item, PropertyValue::String { .. })
                {
                    return Err(unsupported(format!(
                        "Stored value kind is unsupported for {}.",
                        rule.field
                    )));
                }
                if !policy()?
                    .query
                    .tagged_scalar_kinds
                    .iter()
                    .any(|k| k == kind(item))
                {
                    return Err(unsupported(
                        "Structural and relation predicates are unsupported.",
                    ));
                }
            }
            for target in &checked.targets {
                if matches!(target, PropertyValue::Null {}) {
                    continue;
                }
                if ordered(&rule.op) && compare(item, target, date, zone, today)?.is_none() {
                    return Err(unsupported(
                        "Ordered comparison across canonical kinds is unsupported.",
                    ));
                }
            }
        }
    }
    if rule.op=="is_between" && !(view && checked.targets.iter().any(|value|matches!(value,PropertyValue::String { value } if dates::resolve_relative(value,today,0).is_some()))) && compare(&checked.targets[0],&checked.targets[1],date,zone,today)?.is_some_and(|order|order.is_gt()) { return Err(bad("Between bounds must be in low-to-high order.")); }
    Ok(checked)
}
fn scalar_items(value: &PropertyValue, multi: bool, date: bool) -> Result<Vec<&PropertyValue>> {
    match value {
        PropertyValue::Array { value }
            if multi
                && value
                    .iter()
                    .all(|item| matches!(item, PropertyValue::String { .. })) =>
        {
            Ok(value.iter().collect())
        }
        PropertyValue::Array { .. } => Err(unsupported(
            "Only flat declared string-list predicate values are supported.",
        )),
        PropertyValue::Object { .. } if date => Ok(vec![value]),
        PropertyValue::Object { .. } | PropertyValue::Relation { .. } => Err(unsupported(
            "Structural and relation predicates are unsupported.",
        )),
        _ => Ok(vec![value]),
    }
}
fn checked_filter(
    node: &legacy::FilterNode,
    rows: &[&Row],
    schema: &VaultSchema,
    infos: &BTreeMap<String, legacy::FieldInfo>,
    table: &KindTable,
    zone: chrono_tz::Tz,
    today: chrono::NaiveDate,
) -> Result<CheckedFilter> {
    Ok(match node {
        legacy::FilterNode::All(nodes) => CheckedFilter::All(
            nodes
                .iter()
                .map(|node| checked_filter(node, rows, schema, infos, table, zone, today))
                .collect::<Result<_>>()?,
        ),
        legacy::FilterNode::Any(nodes) => CheckedFilter::Any(
            nodes
                .iter()
                .map(|node| checked_filter(node, rows, schema, infos, table, zone, today))
                .collect::<Result<_>>()?,
        ),
        legacy::FilterNode::Rule(rule) => CheckedFilter::Rule(rule_for(
            rule, rows, schema, infos, table, zone, today, false,
        )?),
    })
}
fn equals(
    a: &PropertyValue,
    b: &PropertyValue,
    date: bool,
    zone: chrono_tz::Tz,
    today: chrono::NaiveDate,
) -> Result<bool> {
    if matches!(a, PropertyValue::Null {}) || matches!(b, PropertyValue::Null {}) {
        return Ok(matches!(
            (a, b),
            (PropertyValue::Null {}, PropertyValue::Null {})
        ));
    }
    Ok(compare(a, b, date, zone, today)? == Some(Ordering::Equal))
}
fn matches_rule(
    row: &Row,
    rule: &CheckedRule,
    schema: &VaultSchema,
    zone: chrono_tz::Tz,
    today: chrono::NaiveDate,
) -> Result<bool> {
    let raw = field(row, &rule.field, schema);
    if rule.op == "is_empty" {
        return is_empty(raw.as_ref());
    }
    if rule.op == "is_not_empty" {
        return Ok(!is_empty(raw.as_ref())?);
    }
    let items = raw
        .as_ref()
        .map(|raw| scalar_items(raw, rule.multi, rule.date))
        .transpose()?
        .unwrap_or_default();
    let mut any_equal = false;
    let mut any_text = false;
    let mut any_ordered = false;
    for item in items {
        for target in &rule.targets {
            if equals(item, target, rule.date, zone, today)? {
                any_equal = true;
            }
        }
        if text_op(&rule.op) {
            if let (PropertyValue::String { value: a }, Some(PropertyValue::String { value: b })) =
                (item, rule.targets.first())
            {
                let a = a.to_lowercase();
                let b = b.to_lowercase();
                if !b.is_empty()
                    && match rule.op.as_str() {
                        "starts_with" => a.starts_with(&b),
                        "ends_with" => a.ends_with(&b),
                        _ => a.contains(&b),
                    }
                {
                    any_text = true;
                }
            }
        }
        if ordered(&rule.op) && !matches!(item, PropertyValue::Null {}) {
            let a = compare(item, &rule.targets[0], rule.date, zone, today)?;
            any_ordered |= match rule.op.as_str() {
                "gt" | "after" => a.is_some_and(|o| o.is_gt()),
                "gte" | "on_or_after" => a.is_some_and(|o| !o.is_lt()),
                "lt" | "before" => a.is_some_and(|o| o.is_lt()),
                "lte" | "on_or_before" => a.is_some_and(|o| !o.is_gt()),
                "is_between" => {
                    a.is_some_and(|o| !o.is_lt())
                        && compare(item, &rule.targets[1], rule.date, zone, today)?
                            .is_some_and(|o| !o.is_gt())
                }
                _ => false,
            };
        }
    }
    Ok(match rule.op.as_str() {
        "equals" | "any_of" => any_equal,
        "not_equals" | "none_of" => !any_equal,
        "contains" | "starts_with" | "ends_with" => any_text,
        "does_not_contain" => !any_text,
        _ => any_ordered,
    })
}
fn matches_filter(
    row: &Row,
    node: &CheckedFilter,
    schema: &VaultSchema,
    zone: chrono_tz::Tz,
    today: chrono::NaiveDate,
) -> Result<bool> {
    match node {
        CheckedFilter::Rule(rule) => matches_rule(row, rule, schema, zone, today),
        CheckedFilter::All(nodes) => {
            for node in nodes {
                if !matches_filter(row, node, schema, zone, today)? {
                    return Ok(false);
                }
            }
            Ok(true)
        }
        CheckedFilter::Any(nodes) => {
            for node in nodes {
                if matches_filter(row, node, schema, zone, today)? {
                    return Ok(true);
                }
            }
            Ok(false)
        }
    }
}

fn scope_words(withheld: usize) -> String {
    if withheld == 0 {
        String::new()
    } else {
        format!(" ({withheld} notes outside this run's read scope were not read)")
    }
}
/// An immutable total key, separate from day-wide predicate comparisons.
/// All temporal values use the same caller-zone civil ordering. Absolute
/// instants break only repeated wall-time ties; no Date becomes an instant.
#[derive(PartialEq, Eq, PartialOrd, Ord)]
struct TemporalSortKey {
    local: chrono::NaiveDateTime,
    tag_order: u8,
    instant: Option<chrono::DateTime<chrono::Utc>>,
}
fn temporal_sort_key(
    value: &PropertyValue,
    range: bool,
    zone: chrono_tz::Tz,
) -> Result<TemporalSortKey> {
    let value = match value {
        PropertyValue::Object { value } if range => value.get("start").ok_or_else(|| {
            unsupported("Canonical date-range sorting requires a start endpoint.")
        })?,
        value => value,
    };
    let endpoint = date_endpoint(value, false, zone)?
        .ok_or_else(|| unsupported("Canonical temporal sorting requires a date or instant."))?;
    let (tag_order, instant) = match value {
        PropertyValue::Date { .. } => (0, None),
        PropertyValue::Instant { value } => (
            1,
            Some(
                chrono::DateTime::parse_from_rfc3339(value)
                    .map_err(|_| unsupported("Invalid canonical instant."))?
                    .with_timezone(&chrono::Utc),
            ),
        ),
        _ => {
            return Err(unsupported(
                "Canonical temporal sorting requires a date or instant tag.",
            ))
        }
    };
    Ok(TemporalSortKey {
        local: endpoint
            .date
            .and_time(endpoint.time.unwrap_or(chrono::NaiveTime::MIN)),
        tag_order,
        instant,
    })
}
struct SortKey {
    value: Option<PropertyValue>,
    empty: bool,
    temporal: Option<TemporalSortKey>,
}
fn sorted<'a>(
    rows: Vec<&'a Row>,
    sort: &[legacy::SortSpec],
    schema: &VaultSchema,
    infos: &BTreeMap<String, legacy::FieldInfo>,
    table: &KindTable,
    zone: chrono_tz::Tz,
    today: chrono::NaiveDate,
) -> Result<Vec<&'a Row>> {
    if sort.is_empty() {
        return Ok(rows);
    }
    let mut keyed = rows
        .into_iter()
        .map(|row| (row, Vec::<SortKey>::new()))
        .collect::<Vec<_>>();
    for spec in sort {
        let info = checked_info(&spec.field, infos)?;
        if !table.facts(info.kind).orderable {
            return Err(unsupported(format!("{} cannot be ordered.", spec.field)));
        }
        let date = family(&spec.field, info, table) == "date";
        let mut previous: Option<PropertyValue> = None;
        for (row, keys) in &mut keyed {
            let raw = field(row, &spec.field, schema);
            let empty = is_empty(raw.as_ref())?;
            let mut temporal = None;
            if !empty {
                let value = raw.as_ref().expect("nonempty values are present");
                scalar_items(value, false, date)?;
                if date {
                    temporal = Some(temporal_sort_key(
                        value,
                        info.kind == FieldKind::Daterange,
                        zone,
                    )?);
                } else {
                    if family(&spec.field, info, table) == "number"
                        && !matches!(value, PropertyValue::Decimal { .. })
                    {
                        return Err(unsupported(
                            "A declared numeric sort requires canonical decimal values.",
                        ));
                    }
                    if let Some(previous) = &previous {
                        if compare(previous, value, false, zone, today)?.is_none() {
                            return Err(unsupported(
                                "Sort across canonical value kinds is unsupported.",
                            ));
                        }
                    } else {
                        compare(value, value, false, zone, today)?;
                        previous = Some(value.clone());
                    }
                }
            }
            keys.push(SortKey {
                value: raw,
                empty,
                temporal,
            });
        }
    }
    keyed.sort_by(|(a, ak), (b, bk)| {
        for ((spec, a), b) in sort.iter().zip(ak).zip(bk) {
            let order = if a.empty || b.empty {
                a.empty.cmp(&b.empty)
            } else if let (Some(a), Some(b)) = (&a.temporal, &b.temporal) {
                let order = a.cmp(b);
                if spec.descending {
                    order.reverse()
                } else {
                    order
                }
            } else {
                let info = &infos[&spec.field];
                let a = a.value.as_ref().expect("checked key");
                let b = b.value.as_ref().expect("checked key");
                let ranks = if let (
                    PropertyValue::String { value: a },
                    PropertyValue::String { value: b },
                ) = (a, b)
                {
                    Some((
                        info.options.iter().position(|(id, _)| id == a),
                        info.options.iter().position(|(id, _)| id == b),
                    ))
                } else {
                    None
                };
                match ranks {
                    Some((Some(_), None)) => Ordering::Less,
                    Some((None, Some(_))) => Ordering::Greater,
                    _ => {
                        let order = if let Some((Some(a), Some(b))) = ranks {
                            a.cmp(&b)
                        } else if let (
                            PropertyValue::String { value: a },
                            PropertyValue::String { value: b },
                        ) = (a, b)
                        {
                            legacy::text_order(a, b)
                        } else {
                            compare(a, b, false, zone, today)
                                .expect("sort values were prevalidated")
                                .expect("sort domains were prevalidated")
                        };
                        if spec.descending {
                            order.reverse()
                        } else {
                            order
                        }
                    }
                }
            };
            if !order.is_eq() {
                return order;
            }
        }
        a.id.cmp(&b.id)
    });
    Ok(keyed.into_iter().map(|(row, _)| row).collect())
}
pub(crate) fn query_records(
    root: &Path,
    admits: &dyn Fn(&str) -> bool,
    args: &Value,
    zone: chrono_tz::Tz,
    today: chrono::NaiveDate,
) -> Result<String> {
    let frame = frame(root, admits)?;
    let table = schema::table().map_err(bad)?;
    let request = legacy::parse_request(args)
        .map_err(|problem| bad(format!("{}: {}", problem.position, problem.message)))?;
    let rows = source(&frame, request.type_name.as_deref())?;
    let infos = canonical_infos(&rows, request.type_name.as_deref(), &frame.schema, table);
    if let Some(fields) = &request.fields {
        for name in fields {
            checked_info(name, &infos)?;
        }
    }
    let checked = request
        .filters
        .as_ref()
        .map(|filter| checked_filter(filter, &rows, &frame.schema, &infos, table, zone, today))
        .transpose()?;
    // Sort validation precedes filtering too: unsupported source values cannot be hidden.
    let rows = sorted(
        rows,
        &request.sort,
        &frame.schema,
        &infos,
        table,
        zone,
        today,
    )?;
    let mut matched = Vec::new();
    for row in rows {
        if checked
            .as_ref()
            .map(|filter| matches_filter(row, filter, &frame.schema, zone, today))
            .transpose()?
            .unwrap_or(true)
        {
            matched.push(row);
        }
    }
    let total = matched.len();
    let shown = total.min(request.limit);
    let mut lines = vec![format!(
        "{shown} of {total} readable records{}; canonical present values are tagged.",
        scope_words(frame.withheld)
    )];
    for row in matched.into_iter().take(request.limit) {
        lines.push(format!(
            "- {} — {} [{}]",
            row.entry.path,
            row.entry.title,
            row.entry.entry_type.as_deref().unwrap_or("untyped")
        ));
        let names = request.fields.clone().unwrap_or_else(|| {
            row.properties
                .keys()
                .filter(|key| !legacy::hidden_agent_field(row.entry.entry_type.as_deref(), key))
                .cloned()
                .collect()
        });
        let mut values = Map::new();
        for name in names {
            if let Some(value) = field(row, &name, &frame.schema) {
                values.insert(
                    name,
                    serde_json::to_value(value)
                        .map_err(|_| bad("Canonical query output could not be encoded."))?,
                );
            }
        }
        lines.push(format!("  {}", Value::Object(values)));
    }
    if request.limit_cut {
        lines.push("The requested limit was capped at 100 records.".into());
    }
    Ok(lines.join("\n"))
}
pub(crate) fn describe_database(
    root: &Path,
    admits: &dyn Fn(&str) -> bool,
    args: &Value,
    zone: chrono_tz::Tz,
    today: chrono::NaiveDate,
) -> Result<String> {
    let frame = frame(root, admits)?;
    let table = schema::table().map_err(bad)?;
    let wanted = args
        .get("type")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .ok_or_else(|| bad("describe_database needs a type: the database's name."))?;
    let rows = source(&frame, Some(wanted))?;
    let entries = frame
        .rows
        .iter()
        .map(|row| row.entry.clone())
        .collect::<Vec<_>>();
    let name = views::resolve_database(&entries, wanted).ok();
    let label = name
        .as_deref()
        .or_else(|| rows.first().and_then(|row| row.entry.entry_type.as_deref()))
        .unwrap_or(wanted);
    let infos = canonical_infos(&rows, Some(label), &frame.schema, table);
    let doc = frame
        .rows
        .iter()
        .find(|row| row.entry.entry_type.as_deref() == Some("Type") && row.entry.title == label);
    let mut lines = vec![if let Some(doc) = doc {
        format!(
            "Database {label} ({}): {} records{}.",
            doc.entry.path,
            rows.len(),
            scope_words(frame.withheld)
        )
    } else {
        format!(
            "No Type doc this run can read declares {label}; {} records carry it{}.",
            rows.len(),
            scope_words(frame.withheld)
        )
    }];
    if let Some(own) = frame.schema.type_named(label) {
        if let Some(folder) = &own.folder {
            lines.push(format!("New records are filed in {folder}."));
        }
        if let Some(deadline) = frame.schema.deadline_field(label) {
            lines.push(format!("Deadline: {}.", deadline.name));
        }
        lines.push("Fields, in order:".into());
        for def in &own.fields {
            if legacy::hidden_agent_field(Some(label), &def.name) {
                continue;
            }
            let info = &infos[&def.name];
            let operators = &table.filter_families[&table.facts(def.kind).filters];
            let computed = table.facts(def.kind).computed
                && !matches!(def.kind, FieldKind::CreatedTime | FieldKind::LastEditedTime)
                || def.from.is_some();
            lines.push(format!(
                "- {} ({}): {}{}",
                def.name,
                def.kind.id(),
                if computed {
                    "computed; unavailable to stored predicates".into()
                } else {
                    format!("operators {}", operators.join(", "))
                },
                if info.options.is_empty() {
                    String::new()
                } else {
                    format!(
                        "; option ids {}",
                        info.options
                            .iter()
                            .map(|(id, label)| format!("{id} \"{label}\""))
                            .collect::<Vec<_>>()
                            .join(", ")
                    )
                }
            ));
        }
        let statuses = if own.statuses.is_empty() {
            &table.default_statuses
        } else {
            &own.statuses
        };
        lines.push(format!(
            "Statuses: {}",
            statuses
                .iter()
                .map(|s| format!("{} \"{}\" ({})", s.id, s.label, s.group))
                .collect::<Vec<_>>()
                .join(" · ")
        ));
    }
    let held = infos
        .iter()
        .filter(|(name, info)| info.declared().is_none() && !table.virtual_fields.contains(name))
        .map(|(name, _)| name.clone())
        .collect::<Vec<_>>();
    if !held.is_empty() {
        lines.push(format!(
            "Also held, not declared (canonical tags retained): {}.",
            held.join(", ")
        ));
    }
    lines.push("Every record also has title, type, createdAt and modifiedAt; absent file times remain unavailable.".into());
    lines.push(format!("Date operands follow the shared calendar grammar in {zone}; today is {today}. Date-looking text is never converted by an undeclared or text field."));
    if let Some(views) = doc.and_then(|doc| doc.properties.get("views")) {
        lines.push(format!(
            "Stored views (canonical values): {}",
            serde_json::to_string(views).map_err(|_| bad("Stored views could not be encoded."))?
        ));
    }
    Ok(lines.join("\n"))
}
pub(crate) fn agenda_text(
    root: &Path,
    admits: &dyn Fn(&str) -> bool,
    wanted: Option<&str>,
    window: &agenda::Window,
    zone: chrono_tz::Tz,
    limit: usize,
    limit_cut: bool,
) -> Result<String> {
    let frame = frame(root, admits)?;
    let mut entries = frame
        .rows
        .iter()
        .map(|row| row.entry.clone())
        .collect::<Vec<_>>();
    let wanted = wanted
        .map(|wanted| {
            if let Some(doc) = entries.iter().find(|entry| {
                entry.entry_type.as_deref() == Some("Type")
                    && entry.title.eq_ignore_ascii_case(wanted)
            }) {
                Ok(doc.title.clone())
            } else {
                let rows = source(&frame, Some(wanted))?;
                rows.first()
                    .and_then(|row| row.entry.entry_type.clone())
                    .ok_or_else(|| bad("No readable record carries the requested type."))
            }
        })
        .transpose()?;
    for (row, entry) in frame.rows.iter().zip(&mut entries) {
        if wanted
            .as_deref()
            .is_some_and(|wanted| row.entry.entry_type.as_deref() != Some(wanted))
        {
            continue;
        }
        let Some(own) = row
            .entry
            .entry_type
            .as_deref()
            .and_then(|name| frame.schema.type_named(name))
        else {
            continue;
        };
        for def in &own.fields {
            if legacy::hidden_agent_field(row.entry.entry_type.as_deref(), &def.name) {
                continue;
            }
            let Some(value) = row.properties.get(&def.name) else {
                continue;
            };
            let projected = match def.kind {
                FieldKind::Date | FieldKind::Daterange => {
                    date_text(value, def.kind == FieldKind::Daterange)?
                }
                FieldKind::Repeat => match value {
                    PropertyValue::String { value } => Some(Value::String(value.clone())),
                    PropertyValue::Null {} => None,
                    _ => {
                        return Err(unsupported(
                            "Canonical recurrence rules require stored text.",
                        ))
                    }
                },
                _ => None,
            };
            if let Some(projected) = projected {
                entry.properties.insert(def.name.clone(), projected);
                if let Some(canonical) = entry.canonical_properties.as_mut() {
                    canonical
                        .unavailable_legacy_keys
                        .retain(|key| key != &def.name);
                }
            }
        }
    }
    let agenda = agenda::collect(&entries, &frame.schema, wanted.as_deref(), window, zone);
    Ok(agenda::answer_text(
        &agenda,
        window,
        &agenda::Listing {
            type_name: wanted.as_deref(),
            limit,
            limit_cut,
            withheld: frame.withheld,
            zone,
        },
    ))
}

pub(crate) fn suggest_view(
    root: &Path,
    admits: &dyn Fn(&str) -> bool,
    args: &views::Args,
    vocabulary: &views::Vocabulary,
) -> Result<views::Suggestion> {
    let frame = frame(root, admits)?;
    let table = schema::table().map_err(bad)?;
    let entries = frame
        .rows
        .iter()
        .map(|row| row.entry.clone())
        .collect::<Vec<_>>();
    let database = views::resolve_database(&entries, &args.database).map_err(bad)?;
    let rows = source(&frame, Some(&database))?
        .into_iter()
        .filter(|row| !row.entry.path.starts_with("knowledge/"))
        .collect::<Vec<_>>();
    let mut infos = canonical_infos(&rows, Some(&database), &frame.schema, table);
    if let Some(info) = infos.get_mut("createdAt") {
        info.kind = FieldKind::CreatedTime;
    }
    if let Some(info) = infos.get_mut("modifiedAt") {
        info.kind = FieldKind::LastEditedTime;
    }
    let syntax_day = chrono::NaiveDate::from_ymd_opt(2000, 1, 2).expect("valid syntax anchor");
    // This validates capabilities and authored syntax only, never evaluates or
    // executes a suggested view. Relative tokens remain in the returned value.
    let validate = |rule: &legacy::Rule, _: &legacy::FieldInfo| {
        rule_for(
            rule,
            &rows,
            &frame.schema,
            &infos,
            table,
            chrono_tz::UTC,
            syntax_day,
            true,
        )
        .err()
        .map(|error| vec![error.message])
        .unwrap_or_default()
    };
    // Keep the callback's borrowed facts alive while moving a separately built
    // presentation fact map into the shared checker.
    let mut presentation_infos = canonical_infos(&rows, Some(&database), &frame.schema, table);
    if let Some(info) = presentation_infos.get_mut("createdAt") {
        info.kind = FieldKind::CreatedTime;
    }
    if let Some(info) = presentation_infos.get_mut("modifiedAt") {
        info.kind = FieldKind::LastEditedTime;
    }
    views::check_canonical(
        args,
        vocabulary,
        database,
        presentation_infos,
        &frame.schema,
        &validate,
    )
    .map_err(bad)
}
