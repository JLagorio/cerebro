//! Fresh selected search text and exact visible-body evidence. No conversion,
//! mutation, grant, metadata locator or legacy property projection is issued.
use super::*;
use crate::{
    search::MetaField,
    source_location::SourceSnapshot,
    vault::corpus::{Corpus, CorpusText, SEARCH_BODY_CAP},
};

fn kind(record: &Record) -> Result<Option<String>, AuthorityError> {
    let PropertyValue::Object { value } = &record.metadata else {
        return Err(invalid("Canonical record properties must be an object."));
    };
    match value.get("type") {
        None | Some(PropertyValue::Null {}) => Ok(None),
        Some(PropertyValue::String { value }) => Ok(Some(value.clone())),
        _ => Err(error(
            AuthorityErrorKind::UnsupportedProjection,
            "Canonical page type must be text or absent.",
        )),
    }
}
// Flatten ONLY search text. Exact tagged metadata remains on the canonical
// record; no number ever passes through JSON Number, f64 or legacy_value.
fn texts(value: &PropertyValue, output: &mut Vec<String>) {
    match value {
        PropertyValue::String { value }
        | PropertyValue::Decimal { value }
        | PropertyValue::Date { value }
        | PropertyValue::Instant { value } => output.push(value.clone()),
        PropertyValue::Boolean { value } => output.push(value.to_string()),
        PropertyValue::Relation { spelling, .. } => output.push(spelling.clone()),
        PropertyValue::Array { value } => {
            for item in value {
                texts(item, output);
            }
        }
        PropertyValue::Object { .. } | PropertyValue::Null {} => {}
    }
}
fn fields(
    record: &Record,
    title: &str,
    entry_type: Option<&str>,
) -> Result<Vec<MetaField>, AuthorityError> {
    let PropertyValue::Object { value } = &record.metadata else {
        return Err(invalid("Canonical record properties must be an object."));
    };
    let projected = value
        .iter()
        .map(|(key, value)| {
            let mut flattened = Vec::new();
            texts(value, &mut flattened);
            (
                key.clone(),
                serde_json::Value::Array(
                    flattened
                        .into_iter()
                        .map(serde_json::Value::String)
                        .collect(),
                ),
            )
        })
        .collect();
    // Existing searchable_fields alone owns private Agent keys, page chrome,
    // underscore keys, trimming and duplicate-title suppression.
    Ok(crate::search::searchable_fields(
        title,
        entry_type,
        &projected,
        &BTreeMap::new(),
    ))
}
fn checked_read(
    binding: &SelectedBinding,
    guard: &Option<store::WorkspaceLock>,
    conn: &Connection,
) -> Result<(), AuthorityError> {
    store::handle_unmoved(conn)?;
    private_database(binding)?;
    if let Some(guard) = guard {
        guard.validate()?;
    }
    if authority::selected_binding(&binding.root)? != *binding {
        return Err(error(
            AuthorityErrorKind::WrongIdentity,
            "The selected search binding changed.",
        ));
    }
    Ok(())
}
/// Search-only corpus is deliberately fresh. It cannot replace or be reused as
/// the ordinary Entry projection cache, which retains its exact DTO refusals.
pub(crate) fn search_snapshot(root: &Path) -> Result<Corpus, AuthorityError> {
    let binding = authority::selected_binding(root)?;
    let guard = store::read_guard(&binding)?;
    let conn = connection(&binding, false)?;
    let tx = conn
        .unchecked_transaction()
        .map_err(|_| missing("Canonical search snapshot is unavailable."))?;
    let snapshot = read_snapshot(&tx, &binding)?;
    check_pairing(&binding, &snapshot)?;
    let mut entries = Vec::new();
    let mut searched = Vec::new();
    let mut total = 0usize;
    for record in &snapshot.records {
        let remaining = rules().limits.aggregate_body_bytes.saturating_sub(total);
        let cap = u64::try_from(remaining).map_err(|_| {
            error(
                AuthorityErrorKind::SourceLimit,
                "Selected search body budget is unavailable.",
            )
        })?;
        let exact = body(&binding, record, rules().limits.body_bytes.min(cap))?;
        total = total.checked_add(exact.len()).ok_or_else(|| {
            error(
                AuthorityErrorKind::SourceLimit,
                "Selected search body budget exceeded.",
            )
        })?;
        let PropertyValue::Object { value: metadata } = &record.metadata else {
            return Err(invalid("Canonical record properties must be an object."));
        };
        // Search deliberately issues no legacy metadata projection. Its text
        // still comes ONLY from the existing privacy-filtered typed fields.
        let projected = EntryMetadata {
            properties: serde_json::Map::new(),
            entry_type: kind(record)?,
            canonical_properties: SelectedEntryProperties {
                value: record.metadata.clone(),
                unavailable_legacy_keys: metadata.keys().cloned().collect(),
            },
        };
        let entry = entry_with_metadata(&binding, record, &exact, projected)?;
        let search_fields = fields(record, &entry.title, entry.entry_type.as_deref())?;
        let mut end = exact
            .len()
            .min(SEARCH_BODY_CAP)
            .min(crate::source_location::rules().max_body_bytes);
        while !exact.is_char_boundary(end) {
            end -= 1;
        }
        let capped = end < exact.len();
        searched.push(CorpusText {
            search_fields: Some(search_fields),
            source: Some(SourceSnapshot {
                raw_sha256: record.body_hash.clone(),
                carrier: "markdown",
                body_start_utf8: 0,
                searched_body_bytes: end,
                capped,
            }),
            body: exact[..end].to_owned(),
            capped,
        });
        entries.push(entry);
    }
    checked_read(&binding, &guard, &tx)?;
    tx.commit()
        .map_err(|_| missing("Canonical search snapshot could not finish."))?;
    crate::vault::scan::assign_projects(&mut entries);
    Ok(Corpus {
        entries,
        texts: searched,
    })
}
/// Exact selected body read for source resolution. Source admission precedes
/// this call; canonical pairing and its original verified store are mandatory.
pub(crate) fn source_body(root: &Path, path: &str) -> Result<String, AuthorityError> {
    let binding = authority::selected_binding(root)?;
    let guard = store::read_guard(&binding)?;
    let conn = connection(&binding, false)?;
    let tx = conn
        .unchecked_transaction()
        .map_err(|_| missing("Canonical source snapshot is unavailable."))?;
    let snapshot = read_snapshot(&tx, &binding)?;
    let record = snapshot
        .records
        .iter()
        .find(|record| record.path == path)
        .ok_or_else(|| missing("Canonical source record is unavailable."))?;
    let cap = u64::try_from(crate::source_location::rules().max_source_bytes).map_err(|_| {
        error(
            AuthorityErrorKind::SourceLimit,
            "Source read budget is unavailable.",
        )
    })?;
    let exact = body(&binding, record, rules().limits.body_bytes.min(cap))?;
    checked_read(&binding, &guard, &tx)?;
    tx.commit()
        .map_err(|_| missing("Canonical source snapshot could not finish."))?;
    Ok(exact)
}
