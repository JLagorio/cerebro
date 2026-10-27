//! Actual selected saved-view service: one exact Type-owned view, evaluated by
//! the shared selected query semantics over one checked snapshot of the
//! published opening. It reads only; no record, receipt, request or body moves.
#[cfg(unix)]
use super::semantics as semantic;
use super::*;
#[cfg(unix)]
use crate::vault::{query as legacy, schema};
#[cfg(unix)]
use serde_json::{json, Value};

type Result<T> = std::result::Result<T, AuthorityError>;

#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "No native saved-view command reads canonical frames yet."
    )
)]
pub(crate) fn read_saved_view(
    root: &Path,
    path: &str,
    request: &SelectedSavedViewRequest,
    zone: chrono_tz::Tz,
    today: chrono::NaiveDate,
) -> Result<SelectedSavedViewFrame> {
    #[cfg(unix)]
    {
        read(root, path, request, zone, today)
    }
    #[cfg(not(unix))]
    {
        let _ = (root, path, request, zone, today);
        Err(error(
            AuthorityErrorKind::UnsupportedOperation,
            "Canonical saved-view frames are unavailable on this platform.",
        ))
    }
}

#[cfg(unix)]
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Policy {
    version: u32,
    layouts: Vec<SelectedSavedViewLayout>,
    max_rows: usize,
    default_rows: usize,
    default_column_count: usize,
    max_response_bytes: usize,
    source: String,
    variant: String,
    request_values: String,
    response: String,
}
#[cfg(unix)]
fn policy() -> Result<&'static Policy> {
    static POLICY: std::sync::OnceLock<std::result::Result<Policy, String>> =
        std::sync::OnceLock::new();
    POLICY
        .get_or_init(|| {
            let all: Value =
                serde_json::from_str(include_str!("../../../shared/workspace/values.v1.json"))
                    .map_err(|_| "Saved-view vocabulary is unavailable.")?;
            // An artifact layout the closed frame enum cannot name fails here.
            let policy: Policy = serde_json::from_value(all["selectedSavedView"].clone())
                .map_err(|_| "Saved-view vocabulary is invalid.")?;
            if policy.version != 1
                || policy.source != "type_owned_canonical_saved_view"
                || policy.variant != "exact_saved_only"
                || policy.request_values != "native_canonical_tags"
                || policy.response != "same_snapshot_entries_schema_evidence"
                || policy.layouts.is_empty()
                || policy.default_rows == 0
                || policy.default_rows > policy.max_rows
            {
                return Err("Saved-view vocabulary is unsupported.".into());
            }
            Ok(policy)
        })
        .as_ref()
        .map_err(|message| error(AuthorityErrorKind::UnsupportedOperation, message.clone()))
}

/// Presentation members the frame applies itself. A non-empty group is
/// refused below; nothing is banded by a renderer over partial rows.
#[cfg(unix)]
const APPLIED: [&str; 5] = ["type", "group", "sort", "columns", "limit"];
/// Drawing settings with no effect on which rows, values or order a frame
/// carries. The renderer reads them from the returned configuration.
#[cfg(unix)]
const DRAWN: [&str; 19] = [
    "rowHeight",
    "titleWidth",
    "frozenColumns",
    "titlePosition",
    "chips",
    "cardSize",
    "cardPreview",
    "colorColumns",
    "dateField",
    "zoom",
    "dependencyField",
    "gallery",
    "chart",
    "dashboard",
    "whiteboard",
    "calendarSpan",
    "showWeekends",
    "weekStart",
    "showTable",
];
/// Footer calculations aggregate rows the frame may not carry; refused.
#[cfg(unix)]
const FOOTERS: [&str; 1] = ["titleCalc"];

#[cfg(unix)]
fn unsupported(message: impl Into<String>) -> AuthorityError {
    error(AuthorityErrorKind::UnsupportedProjection, message)
}
#[cfg(unix)]
fn members<'a>(
    value: Option<&'a PropertyValue>,
    what: &str,
) -> Result<&'a BTreeMap<String, PropertyValue>> {
    match value {
        Some(PropertyValue::Object { value }) => Ok(value),
        _ => Err(unsupported(format!(
            "The saved view's {what} must be an object."
        ))),
    }
}
#[cfg(unix)]
fn text<'a>(value: Option<&'a PropertyValue>, what: &str) -> Result<&'a str> {
    match value {
        Some(PropertyValue::String { value }) => Ok(value),
        _ => Err(unsupported(format!(
            "The saved view's {what} must be text."
        ))),
    }
}
#[cfg(unix)]
fn list<'a>(value: Option<&'a PropertyValue>, what: &str) -> Result<&'a [PropertyValue]> {
    match value {
        None | Some(PropertyValue::Null {}) => Ok(&[]),
        Some(PropertyValue::Array { value }) => Ok(value),
        _ => Err(unsupported(format!(
            "The saved view's {what} must be a list."
        ))),
    }
}
#[cfg(unix)]
fn present(value: Option<&PropertyValue>) -> bool {
    !matches!(value, None | Some(PropertyValue::Null {}))
}
/// Unclassified members may change rows; they are refused, never ignored.
#[cfg(unix)]
fn closed<'a>(
    map: &BTreeMap<String, PropertyValue>,
    known: impl IntoIterator<Item = &'a str> + Clone,
    what: &str,
) -> Result<()> {
    match map
        .keys()
        .find(|key| !known.clone().into_iter().any(|name| name == key.as_str()))
    {
        Some(key) => Err(unsupported(format!(
            "The saved view's {what} member {key} has no canonical frame support."
        ))),
        None => Ok(()),
    }
}
#[cfg(unix)]
fn tagged(value: &PropertyValue) -> Result<Value> {
    serde_json::to_value(value).map_err(|_| invalid("A saved-view value cannot be encoded."))
}
/// Tagged groups and rules take the shared query shape. Operands keep their
/// exact canonical tags, so the shared evaluator decodes them without rounding.
#[cfg(unix)]
fn filter_shape(node: &PropertyValue) -> Result<Value> {
    let PropertyValue::Object { value: node } = node else {
        return tagged(node);
    };
    let mut shaped = serde_json::Map::new();
    for (key, member) in node {
        let value = match (key.as_str(), member) {
            ("all" | "any", PropertyValue::Array { value }) => {
                Value::Array(value.iter().map(filter_shape).collect::<Result<_>>()?)
            }
            ("field" | "op", PropertyValue::String { value }) => Value::String(value.clone()),
            ("value", PropertyValue::Array { value }) => {
                Value::Array(value.iter().map(tagged).collect::<Result<_>>()?)
            }
            _ => tagged(member)?,
        };
        shaped.insert(key.clone(), value);
    }
    Ok(Value::Object(shaped))
}
/// The one view whose id is exactly the requested id; never a first or default.
#[cfg(unix)]
fn exact_view<'a>(
    declaration: &'a BTreeMap<String, PropertyValue>,
    id: &str,
) -> Result<&'a PropertyValue> {
    let Some(PropertyValue::Array { value: views }) = declaration.get("views") else {
        return Err(unsupported("This Type declares no saved-view list."));
    };
    let mut found = views.iter().filter(|view| {
        matches!(view, PropertyValue::Object { value } if matches!(value.get("id"), Some(PropertyValue::String { value }) if value == id))
    });
    let view = found
        .next()
        .ok_or_else(|| unsupported("This Type declares no saved view with the requested id."))?;
    if found.next().is_some() {
        return Err(unsupported(
            "More than one saved view declares the requested id.",
        ));
    }
    Ok(view)
}
#[cfg(unix)]
fn saved_record(row: &semantic::Row) -> Result<SelectedSavedViewRecord> {
    let entry = &row.entry;
    let lost = || invalid("A canonical row has no paired authority evidence.");
    Ok(SelectedSavedViewRecord {
        path: entry.path.clone(),
        filename: entry.filename.clone(),
        folder: entry.folder.clone(),
        project: entry.project.clone(),
        title: entry.title.clone(),
        entry_type: entry.entry_type.clone(),
        snippet: entry.snippet.clone(),
        outgoing_links: entry.outgoing_links.clone(),
        created_at: entry.created_at.clone(),
        modified_at: entry.modified_at.clone(),
        hash: entry.hash.clone().ok_or_else(lost)?,
        authority: entry.authority.clone().ok_or_else(lost)?,
        // The complete tagged Object, with the scan's legacy-key meaning.
        canonical_properties: SelectedEntryProperties {
            value: PropertyValue::Object {
                value: row.properties.clone(),
            },
            unavailable_legacy_keys: legacy_projection(&row.properties).1,
        },
    })
}

#[cfg(unix)]
fn read(
    root: &Path,
    path: &str,
    request: &SelectedSavedViewRequest,
    zone: chrono_tz::Tz,
    today: chrono::NaiveDate,
) -> Result<SelectedSavedViewFrame> {
    let policy = policy()?;
    let (target, expected) = (&request.target, &request.expected_version);
    if expected.workspace_id != target.workspace_id || expected.record_id != target.record_id {
        return Err(error(
            AuthorityErrorKind::WrongIdentity,
            "The expected version names another record than the saved view's Type.",
        ));
    }
    if !record_path_valid(path)
        || path.len() > rules().limits.path_bytes
        || request.view_id.is_empty()
        || request.view_id.len() > rules().limits.path_bytes
    {
        return Err(invalid("The requested saved-view locator is invalid."));
    }
    let context = authority::context()?;
    let binding = authority::selected_binding(root)?;
    if binding.workspace_id != target.workspace_id {
        return Err(error(
            AuthorityErrorKind::WrongIdentity,
            "The original saved-view workspace changed.",
        ));
    }
    // The exact published selected incarnation, the ticket portable backup
    // also holds: a same-path reopen or a replaced database object is refused
    // at the publication gate below, never adopted.
    let opening = context.capture_selected_backup_opening(&binding.root)?;
    let guard = store::read_guard(&binding)?
        .ok_or_else(|| missing("This paired workspace has no trusted lock."))?;
    let conn = connection(&binding, false)?;
    let tx = conn
        .unchecked_transaction()
        .map_err(|_| missing("Canonical saved-view snapshot is unavailable."))?;
    let snapshot = read_snapshot(&tx, &binding)?;
    check_pairing(&binding, &snapshot)?;
    let declaration = snapshot
        .records
        .iter()
        .find(|record| record.path == path)
        .ok_or_else(|| missing("The saved view's Type record is unavailable."))?;
    store::editor_target(&binding, declaration, target)?;
    // Changed Type metadata is stale; a newer view is never selected silently.
    store::expected_record(&binding, declaration, expected)?;
    let type_id = declaration.id.clone();
    let epoch = snapshot.epoch.to_string();
    // Every body, the Type's included, is read against its paired hash here.
    let frame = semantic::frame_rows(&binding, snapshot.records, &|_| true)?;
    let result = evaluate(
        policy,
        &frame,
        &type_id,
        &request.view_id,
        epoch,
        zone,
        today,
    )?;
    bounded(&result, response_limit(policy))?;
    #[cfg(test)]
    before_publish();
    // Publication gate: the same opening, binding, lock and database handle,
    // with no paired change begun, or nothing is returned.
    context.validate_selected_backup_opening(&opening)?;
    store::binding_still(&binding, &guard, &tx)?;
    store::no_pending(&binding)?;
    tx.commit()
        .map_err(|_| missing("Canonical saved-view snapshot could not finish."))?;
    Ok(result)
}

#[cfg(unix)]
fn evaluate(
    policy: &Policy,
    frame: &semantic::Frame,
    type_id: &str,
    view_id: &str,
    snapshot_epoch: String,
    zone: chrono_tz::Tz,
    today: chrono::NaiveDate,
) -> Result<SelectedSavedViewFrame> {
    let declaration = frame
        .rows
        .iter()
        .find(|row| row.id == type_id)
        .ok_or_else(|| missing("The saved view's Type record is unavailable."))?;
    if declaration.entry.entry_type.as_deref() != Some("Type") {
        return Err(unsupported(
            "Saved views are read only from a Type declaration.",
        ));
    }
    let database = declaration.entry.title.as_str();
    let configuration = exact_view(&declaration.properties, view_id)?;
    let saved = members(Some(configuration), "configuration")?;
    closed(
        saved,
        ["id", "name", "icon", "filters", "presentation"],
        "view",
    )?;
    let view_name = text(saved.get("name"), "name")?.to_owned();
    let presentation = members(saved.get("presentation"), "presentation")?;
    closed(
        presentation,
        APPLIED.into_iter().chain(DRAWN).chain(FOOTERS),
        "presentation",
    )?;
    if FOOTERS.iter().any(|key| present(presentation.get(*key))) {
        return Err(unsupported(
            "A footer calculation has no canonical frame value.",
        ));
    }
    let layout_name = text(presentation.get("type"), "layout")?;
    let layout =
        serde_json::from_value::<SelectedSavedViewLayout>(Value::String(layout_name.to_owned()))
            .ok()
            .filter(|layout| policy.layouts.contains(layout))
            .ok_or_else(|| {
                unsupported(format!(
                    "The {layout_name} layout has no canonical frame support."
                ))
            })?;
    if !list(presentation.get("group"), "grouping")?.is_empty() {
        return Err(unsupported(
            "Grouped saved views have no canonical frame support.",
        ));
    }
    let configured = list(presentation.get("columns"), "columns")?;
    let mut visible = Vec::new();
    for column in configured {
        let column = members(Some(column), "column")?;
        closed(
            column,
            ["field", "hidden", "width", "wrap", "calc"],
            "column",
        )?;
        if present(column.get("calc")) {
            return Err(unsupported(
                "A footer calculation has no canonical frame value.",
            ));
        }
        let field = text(column.get("field"), "column field")?;
        match column.get("hidden") {
            None | Some(PropertyValue::Null {} | PropertyValue::Boolean { value: false }) => {
                visible.push(field.to_owned())
            }
            Some(PropertyValue::Boolean { value: true }) => {}
            _ => return Err(unsupported("A column's hidden flag must be true or false.")),
        }
    }
    let sort = list(presentation.get("sort"), "sort")?
        .iter()
        .map(|spec| {
            let spec = members(Some(spec), "sort")?;
            closed(spec, ["field", "dir"], "sort")?;
            Ok(json!({"field":text(spec.get("field"), "sort field")?,"dir":text(spec.get("dir"), "sort direction")?}))
        })
        .collect::<Result<Vec<_>>>()?;
    let mut args = json!({ "sort": sort });
    if present(saved.get("filters")) {
        args["filters"] = filter_shape(saved.get("filters").expect("present filters"))?;
    }
    // The shared parser holds the stored shape: groups, rules and directions.
    let query = legacy::parse_request(&args).map_err(|problem| {
        unsupported(format!(
            "Saved view {}: {}",
            problem.position, problem.message
        ))
    })?;
    let limit = match presentation.get("limit") {
        None | Some(PropertyValue::Null {}) => None,
        Some(PropertyValue::Decimal { value })
            if !value.starts_with('0') && value.bytes().all(|byte| byte.is_ascii_digit()) =>
        {
            // A whole number past usize still asks for every row.
            Some(value.parse::<usize>().unwrap_or(usize::MAX))
        }
        _ => {
            return Err(unsupported(
                "A saved view's limit must be a positive whole number.",
            ))
        }
    };
    let table = schema::table()
        .map_err(|message| error(AuthorityErrorKind::UnsupportedOperation, message))?;
    let rows = semantic::source(frame, Some(database))?;
    if rows
        .iter()
        .any(|row| row.entry.entry_type.as_deref() != Some(database))
    {
        return Err(unsupported(
            "The database name resolves to records of another spelling.",
        ));
    }
    let infos = semantic::canonical_infos(&rows, Some(database), &frame.schema, table);
    let names = if configured.is_empty() {
        frame
            .schema
            .type_named(database)
            .map(|own| {
                own.fields
                    .iter()
                    .filter(|def| !legacy::hidden_agent_field(Some(database), &def.name))
                    .take(policy.default_column_count)
                    .map(|def| def.name.clone())
                    .collect()
            })
            .unwrap_or_default()
    } else {
        visible
    };
    // A computed or conflicting column is refused even when no row shows it.
    let columns = names
        .into_iter()
        .map(|name| {
            let kind = semantic::checked_info(&name, &infos)?.kind.id().to_owned();
            Ok(SelectedSavedViewColumn { name, kind })
        })
        .collect::<Result<Vec<_>>>()?;
    let projects = rows
        .iter()
        .copied()
        .filter_map(|row| row.entry.project.as_deref())
        .collect::<BTreeSet<_>>();
    // The declaration, plus any project status override a row's options read.
    let schema_evidence = frame
        .rows
        .iter()
        .filter(|row| {
            row.id == type_id
                || (projects.contains(row.entry.path.as_str())
                    && row.entry.properties.contains_key("statuses"))
        })
        .map(saved_record)
        .collect::<Result<Vec<_>>>()?;
    // Predicate and sort checks inspect every source value before any output.
    let checked = query
        .filters
        .as_ref()
        .map(|filter| {
            semantic::checked_filter(filter, &rows, &frame.schema, &infos, table, zone, today)
        })
        .transpose()?;
    let rows = semantic::sorted(rows, &query.sort, &frame.schema, &infos, table, zone, today)?;
    let mut matched = Vec::new();
    for row in rows {
        if checked
            .as_ref()
            .map(|filter| semantic::matches_filter(row, filter, &frame.schema, zone, today))
            .transpose()?
            .unwrap_or(true)
        {
            matched.push(row);
        }
    }
    let total = matched.len();
    let shown = total.min(limit.unwrap_or(policy.default_rows).min(policy.max_rows));
    let count = |value: usize| {
        u32::try_from(value).map_err(|_| {
            error(
                AuthorityErrorKind::SourceLimit,
                "Saved-view counts exceed their bound.",
            )
        })
    };
    Ok(SelectedSavedViewFrame {
        type_record: saved_record(declaration)?,
        schema_evidence,
        entries: matched
            .into_iter()
            .take(shown)
            .map(saved_record)
            .collect::<Result<_>>()?,
        columns,
        layout,
        view_id: view_id.to_owned(),
        view_name,
        configuration: configuration.clone(),
        total: count(total)?,
        shown: count(shown)?,
        // Rows the view itself would show that the frame bound withheld.
        capped: shown < total.min(limit.unwrap_or(usize::MAX)),
        snapshot_epoch,
        timezone: zone.name().to_owned(),
        today: today.to_string(),
    })
}

/// The whole frame fits its response bound, or it is refused. Exact values
/// and evidence are never truncated to fit.
#[cfg(unix)]
fn bounded(frame: &SelectedSavedViewFrame, limit: usize) -> Result<()> {
    struct Budget(usize);
    impl std::io::Write for Budget {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0 = self
                .0
                .checked_sub(bytes.len())
                .ok_or_else(|| std::io::Error::other("saved-view response bound"))?;
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    serde_json::to_writer(Budget(limit), frame).map_err(|failure| {
        if failure.is_io() {
            error(
                AuthorityErrorKind::SourceLimit,
                "The saved-view frame exceeds its response bound.",
            )
        } else {
            invalid("The saved-view frame cannot be encoded.")
        }
    })
}
#[cfg(unix)]
fn response_limit(policy: &Policy) -> usize {
    #[cfg(test)]
    if let Some(limit) = RESPONSE_LIMIT.with(|slot| slot.get()) {
        return limit;
    }
    policy.max_response_bytes
}

#[cfg(test)]
thread_local! {
    static BEFORE_PUBLISH:std::cell::RefCell<Option<Box<dyn FnOnce()>>>=std::cell::RefCell::new(None);
    static RESPONSE_LIMIT:std::cell::Cell<Option<usize>>=const {std::cell::Cell::new(None)};
}
#[cfg(all(test, unix))]
fn before_publish() {
    if let Some(hook) = BEFORE_PUBLISH.with(|slot| slot.borrow_mut().take()) {
        hook();
    }
}
#[cfg(test)]
pub(crate) fn with_saved_view_before_publish_for_test<T>(
    before: impl FnOnce() + 'static,
    run: impl FnOnce() -> T,
) -> T {
    struct Reset(Option<Box<dyn FnOnce()>>);
    impl Drop for Reset {
        fn drop(&mut self) {
            BEFORE_PUBLISH.with(|slot| *slot.borrow_mut() = self.0.take());
        }
    }
    let _reset = Reset(BEFORE_PUBLISH.with(|slot| slot.borrow_mut().replace(Box::new(before))));
    run()
}
#[cfg(test)]
pub(crate) fn with_saved_view_response_limit_for_test<T>(
    limit: usize,
    run: impl FnOnce() -> T,
) -> T {
    struct Reset(Option<usize>);
    impl Drop for Reset {
        fn drop(&mut self) {
            RESPONSE_LIMIT.with(|slot| slot.set(self.0));
        }
    }
    let _reset = Reset(RESPONSE_LIMIT.with(|slot| slot.replace(Some(limit))));
    run()
}
