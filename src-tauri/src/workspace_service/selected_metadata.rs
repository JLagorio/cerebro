//! Durable original-request metadata changes over the existing selected owner.
use super::*;
use crate::vault::schema::{self, FieldKind};
use crate::workspace_service::types::values::PropertyChange;
use serde::Deserialize;
use std::sync::OnceLock;
type Result<T> = std::result::Result<T, AuthorityError>;
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Policy {
    version: u32,
    selected_schema_version: i64,
    operation: String,
    max_changes: usize,
    max_stored_request_rows: usize,
    max_stored_request_bytes: usize,
    max_request_bytes: usize,
    value_rules: String,
    field_kinds: String,
    ordinary_target_rules: String,
    protected_keys: Vec<String>,
    provenance_keys: String,
    supported_declared_kinds: Vec<String>,
    supported_set_kinds: Vec<String>,
    set_kinds_by_declared_kind: std::collections::BTreeMap<String, Vec<String>>,
    remove: String,
    duplicate_keys: String,
    unchanged: String,
    request_evidence: String,
    schema_upgrade: String,
}
fn policy() -> &'static Policy {
    static POLICY: OnceLock<Policy> = OnceLock::new();
    POLICY.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../../../shared/workspace/metadata-patch.v1.json"
        ))
        .expect("metadata patch policy")
    })
}
pub(super) fn schema_version() -> i64 {
    policy().selected_schema_version
}
pub(super) fn policy_operation() -> &'static str {
    &policy().operation
}
pub(super) fn paired_schema(version: i64) -> bool {
    version == crate::workspace_migration::journal::rules().selected_schema_version
        || version == schema_version()
}
fn supported_policy() -> Result<()> {
    let p = policy();
    if p.version != 1
        || p.operation != "metadata.patch"
        || p.value_rules != "shared/workspace/values.v1.json"
        || p.field_kinds != schema::FIELD_KINDS_PATH
        || p.ordinary_target_rules != "shared/workspace/paired-change.v1.json"
        || p.provenance_keys != "shared/import/sources.v1.json#agent_guard"
        || p.remove != "declared_stored_fields_only"
        || p.duplicate_keys != "refuse"
        || p.unchanged != "durable_request_without_receipt_or_epoch_increment"
        || p.request_evidence != "original_exact_payload_target_path_expected_version"
        || p.schema_upgrade != "explicit_staged_only"
    {
        return Err(error(
            AuthorityErrorKind::UnsupportedOperation,
            "Metadata patch policy is unsupported.",
        ));
    }
    if p.set_kinds_by_declared_kind.len() != p.supported_declared_kinds.len()
        || p.supported_declared_kinds
            .iter()
            .any(|kind| !p.set_kinds_by_declared_kind.contains_key(kind))
        || p.set_kinds_by_declared_kind.values().any(|tags| {
            tags.is_empty()
                || tags.iter().collect::<BTreeSet<_>>().len() != tags.len()
                || tags.iter().any(|tag| !p.supported_set_kinds.contains(tag))
        })
    {
        return Err(error(
            AuthorityErrorKind::UnsupportedOperation,
            "Metadata field tag policy is unsupported.",
        ));
    }
    Ok(())
}
fn request_digest(path: &str, request: &MetadataPatchRequest) -> Result<String> {
    supported_policy()?;
    let expected = &request.expected_version;
    if !authority::uuid_valid(&request.request_key)
        || !authority::uuid_valid(&request.target.workspace_id)
        || !authority::uuid_valid(&request.target.record_id)
        || request.target.workspace_id == request.target.record_id
        || expected.kind != SelectedAuthorityKind::SqliteMetadata
        || expected.workspace_id != request.target.workspace_id
        || expected.record_id != request.target.record_id
    {
        return Err(error(
            AuthorityErrorKind::WrongIdentity,
            "The original metadata request identity is invalid.",
        ));
    }
    if expected
        .metadata_revision
        .parse::<i64>()
        .ok()
        .filter(|n| *n >= 1)
        .map(|n| n.to_string())
        .as_deref()
        != Some(expected.metadata_revision.as_str())
        || !hash_valid(&expected.metadata_hash)
        || !hash_valid(&expected.body_hash)
        || crate::files::bytes::rel_refusal("selected-authority", path).is_some()
        || path.len() > rules().limits.path_bytes
    {
        return Err(invalid(
            "The original metadata request expectation is invalid.",
        ));
    }
    if request.phase == MetadataPatchPhase::Start && request.original.is_some() {
        return Err(error(
            AuthorityErrorKind::WrongIdentity,
            "A fresh metadata request cannot replace its original operation.",
        ));
    }
    if request.changes.is_empty() {
        return Err(invalid("A metadata patch requires a change."));
    }
    if request.changes.len() > policy().max_changes {
        return Err(error(
            AuthorityErrorKind::SourceLimit,
            "Metadata patch exceeds its change bound.",
        ));
    }
    let mut keys = BTreeSet::new();
    for change in &request.changes {
        let key = match change {
            PropertyChange::Set { key, value } => {
                let source = serde_json::to_string(value)
                    .map_err(|_| invalid("Metadata value cannot be encoded."))?;
                if source.len() > value::max_source_bytes() {
                    return Err(error(
                        AuthorityErrorKind::SourceLimit,
                        "Metadata value exceeds its bound.",
                    ));
                }
                value::decode_tagged(&source).map_err(|e| invalid(&e.message))?;
                key
            }
            PropertyChange::Remove { key } => key,
        };
        if key.is_empty() || key.len() > rules().limits.path_bytes || !keys.insert(key) {
            return Err(invalid(
                "Metadata patch keys are empty, duplicate or oversized.",
            ));
        }
    }
    // Phase and supplied response evidence are deliberately excluded: Start
    // and Resolve must bind the same original semantic input, never later state.
    let payload = serde_json::to_vec(&(
        path,
        &request.target,
        &request.request_key,
        expected,
        &request.changes,
    ))
    .map_err(|_| invalid("Metadata request cannot be encoded."))?;
    if payload.len() > policy().max_request_bytes {
        return Err(error(
            AuthorityErrorKind::SourceLimit,
            "Metadata request exceeds its byte bound.",
        ));
    }
    Ok(crate::ledger::sha256_hex(&payload))
}
const REQUEST_COLUMNS: &str = "request_key,operation_id,workspace_id,record_id,path,payload_hash,expected_revision,expected_metadata_hash,expected_body_hash,result_kind,receipt_epoch,result_revision,result_metadata_hash,result_body_hash,actor,at";
struct Stored {
    key: String,
    operation_id: String,
    workspace: String,
    record: String,
    path: String,
    payload: String,
    expected_revision: i64,
    expected_metadata: String,
    expected_body: String,
    kind: String,
    epoch: Option<i64>,
    revision: i64,
    metadata: String,
    body: String,
    actor: String,
    at: String,
}
fn stored(row: &Row<'_>) -> Result<Stored> {
    Ok(Stored {
        key: text(row, 0, 36)?,
        operation_id: text(row, 1, 36)?,
        workspace: text(row, 2, 36)?,
        record: text(row, 3, 36)?,
        path: text(row, 4, rules().limits.path_bytes)?,
        payload: text(row, 5, 64)?,
        expected_revision: row
            .get(6)
            .map_err(|_| invalid("Original metadata expectation is invalid."))?,
        expected_metadata: text(row, 7, 64)?,
        expected_body: text(row, 8, 64)?,
        kind: text(row, 9, 16)?,
        epoch: row
            .get(10)
            .map_err(|_| invalid("Original metadata receipt link is invalid."))?,
        revision: row
            .get(11)
            .map_err(|_| invalid("Original metadata result revision is invalid."))?,
        metadata: text(row, 12, 64)?,
        body: text(row, 13, 64)?,
        actor: text(row, 14, 128)?,
        at: text(row, 15, 64)?,
    })
}
fn original_receipt(conn: &Connection, workspace: &str, epoch: i64) -> Result<OriginalReceipt> {
    let mut query=conn.prepare("SELECT record_id,previous_revision,revision,metadata_before_hash,metadata_after_hash,actor,operation,at,body_before_hash,body_after_hash,run_id,approved_by FROM metadata_receipts WHERE epoch=?1").map_err(|_|invalid("Original metadata receipt is unreadable."))?;
    let mut rows = query
        .query([epoch])
        .map_err(|_| invalid("Original metadata receipt is unreadable."))?;
    let row = rows
        .next()
        .map_err(|_| invalid("Original metadata receipt is unreadable."))?
        .ok_or_else(|| invalid("Original metadata receipt is missing."))?;
    store::decode_receipt_row(row, workspace, epoch)
        .map_err(|_| invalid("Original metadata receipt is invalid."))
}
struct IndexedRecord<'a> {
    record: &'a Record,
    metadata_hash: String,
}
type RecordIndex<'a> = BTreeMap<&'a str, IndexedRecord<'a>>;
fn record_index(records: &[Record]) -> RecordIndex<'_> {
    records
        .iter()
        .map(|record| {
            (
                record.id.as_str(),
                IndexedRecord {
                    record,
                    metadata_hash: crate::ledger::sha256_hex(record.metadata_source.as_bytes()),
                },
            )
        })
        .collect()
}
fn validate_stored(
    conn: &Connection,
    workspace: &str,
    epoch_limit: i64,
    records: &RecordIndex<'_>,
    request: &Stored,
) -> Result<()> {
    let current = records
        .get(request.record.as_str())
        .ok_or_else(|| invalid("Original metadata request names no current record."))?;
    let record = current.record;
    if !authority::uuid_valid(&request.key)
        || !authority::uuid_valid(&request.operation_id)
        || request.workspace != workspace
        || request.record != record.id
        || !super::record_path_valid(&request.path)
        || !hash_valid(&request.payload)
        || !hash_valid(&request.expected_metadata)
        || !hash_valid(&request.expected_body)
        || !hash_valid(&request.metadata)
        || !hash_valid(&request.body)
        || request.expected_revision < 1
        || request.revision < 1
        || request.revision > record.revision
        || request.expected_body != request.body
        || request.actor != crate::vault::receipt::HUMAN_ACTOR
        || chrono::DateTime::parse_from_rfc3339(&request.at).is_err()
        || (request.revision == record.revision
            && (request.metadata != current.metadata_hash || request.body != record.body_hash))
    {
        return Err(invalid(
            "Original metadata request evidence is inconsistent.",
        ));
    }
    match (request.kind.as_str(), request.epoch) {
        ("unchanged", None)
            if request.expected_revision == request.revision
                && request.expected_metadata == request.metadata =>
        {
            Ok(())
        }
        ("applied", Some(epoch))
            if epoch >= 1
                && epoch <= epoch_limit
                && request.expected_revision.checked_add(1) == Some(request.revision) =>
        {
            let receipt = original_receipt(conn, workspace, epoch)?;
            if receipt.record_id != request.record
                || receipt.previous_revision != request.expected_revision
                || receipt.revision != request.revision
                || receipt.metadata_before_hash != request.expected_metadata
                || receipt.metadata_after_hash != request.metadata
                || receipt.body_before_hash != request.expected_body
                || receipt.body_after_hash != request.body
                || receipt.operation != policy().operation
                || receipt.actor != request.actor
                || receipt.at != request.at
            {
                return Err(invalid("Original metadata request and receipt disagree."));
            }
            Ok(())
        }
        _ => Err(invalid("Original metadata request result is unsupported.")),
    }
}
fn stored_bytes(request: &Stored) -> Result<usize> {
    [
        &request.key,
        &request.operation_id,
        &request.workspace,
        &request.record,
        &request.path,
        &request.payload,
        &request.expected_metadata,
        &request.expected_body,
        &request.kind,
        &request.metadata,
        &request.body,
        &request.actor,
        &request.at,
    ]
    .into_iter()
    .try_fold(24usize, |total, text| total.checked_add(text.len()))
    .ok_or_else(|| {
        error(
            AuthorityErrorKind::SourceLimit,
            "Original metadata request history exceeds its byte bound.",
        )
    })
}
fn request_bounds() -> (usize, usize) {
    #[cfg(test)]
    if let Some(bounds) = REQUEST_BOUNDS.with(|slot| slot.get()) {
        return bounds;
    }
    (
        policy().max_stored_request_rows,
        policy().max_stored_request_bytes,
    )
}
fn validate_request_index(
    conn: &Connection,
    workspace: &str,
    epoch: i64,
    records: &RecordIndex<'_>,
) -> Result<()> {
    let (row_cap, byte_cap) = request_bounds();
    let query_cap = row_cap
        .checked_add(1)
        .and_then(|n| i64::try_from(n).ok())
        .ok_or_else(|| {
            error(
                AuthorityErrorKind::SourceLimit,
                "Original metadata request row bound is invalid.",
            )
        })?;
    let mut query = conn
        .prepare(&format!(
            "SELECT {REQUEST_COLUMNS} FROM metadata_requests ORDER BY request_key LIMIT ?1"
        ))
        .map_err(|_| invalid("Original metadata requests are unreadable."))?;
    let mut rows = query
        .query([query_cap])
        .map_err(|_| invalid("Original metadata requests are unreadable."))?;
    let mut count = 0usize;
    let mut bytes = 0usize;
    while let Some(row) = rows
        .next()
        .map_err(|_| invalid("Original metadata requests are unreadable."))?
    {
        if count >= row_cap {
            return Err(error(
                AuthorityErrorKind::SourceLimit,
                "Original metadata request history exceeds its row bound.",
            ));
        }
        let request = stored(row)?;
        count += 1;
        bytes = bytes
            .checked_add(stored_bytes(&request)?)
            .filter(|total| *total <= byte_cap)
            .ok_or_else(|| {
                error(
                    AuthorityErrorKind::SourceLimit,
                    "Original metadata request history exceeds its byte bound.",
                )
            })?;
        validate_stored(conn, workspace, epoch, records, &request)?;
    }
    let orphan:i64=conn.query_row("SELECT count(*) FROM metadata_receipts AS r LEFT JOIN metadata_requests AS q ON q.receipt_epoch=r.epoch WHERE r.operation='metadata.patch' AND q.request_key IS NULL",[],|r|r.get(0)).map_err(|_|invalid("Metadata receipt links are unreadable."))?;
    if orphan != 0 {
        return Err(invalid(
            "A metadata patch receipt has no original request evidence.",
        ));
    }
    Ok(())
}
pub(super) fn validate_requests(
    conn: &Connection,
    workspace: &str,
    snapshot: &Snapshot,
) -> Result<()> {
    if store::schema_version(conn)? != schema_version() {
        return Ok(());
    }
    validate_request_index(
        conn,
        workspace,
        snapshot.epoch,
        &record_index(&snapshot.records),
    )
}
fn lookup(conn: &Connection, key: &str) -> Result<Option<Stored>> {
    let mut query = conn
        .prepare(&format!(
            "SELECT {REQUEST_COLUMNS} FROM metadata_requests WHERE request_key=?1"
        ))
        .map_err(|_| invalid("Original metadata request is unreadable."))?;
    let mut rows = query
        .query([key])
        .map_err(|_| invalid("Original metadata request is unreadable."))?;
    rows.next()
        .map_err(|_| invalid("Original metadata request is unreadable."))?
        .map(stored)
        .transpose()
}
fn replay(
    conn: &Connection,
    binding: &SelectedBinding,
    snapshot: &Snapshot,
    path: &str,
    request: &MetadataPatchRequest,
    digest: &str,
    stored: &Stored,
) -> Result<MetadataPatchResult> {
    // Each caller supplies the same SQLite snapshot already checked by read_snapshot.
    let expected = &request.expected_version;
    if stored.workspace != request.target.workspace_id
        || stored.record != request.target.record_id
        || stored.path != path
        || stored.payload != digest
        || stored.expected_revision.to_string() != expected.metadata_revision
        || stored.expected_metadata != expected.metadata_hash
        || stored.expected_body != expected.body_hash
    {
        return Err(error(
            AuthorityErrorKind::WrongIdentity,
            "This metadata request key belongs to another original payload or target.",
        ));
    }
    let record = snapshot
        .records
        .iter()
        .find(|r| r.id == stored.record)
        .ok_or_else(|| invalid("Original metadata target is unavailable."))?;
    let version = SelectedRecordVersion {
        kind: SelectedAuthorityKind::SqliteMetadata,
        workspace_id: stored.workspace.clone(),
        record_id: stored.record.clone(),
        metadata_revision: stored.revision.to_string(),
        metadata_hash: stored.metadata.clone(),
        body_hash: stored.body.clone(),
    };
    let current_version = record_version(binding, record);
    let reconcile_required = current_version != version
        || record.path != stored.path
        || body(binding, record, rules().limits.body_bytes).is_err();
    if stored.kind == "unchanged" {
        if request.original.is_some() {
            return Err(error(
                AuthorityErrorKind::WrongIdentity,
                "An unchanged original request has no mutation receipt.",
            ));
        }
        return Ok(MetadataPatchResult::Unchanged {
            target: request.target.clone(),
            path: path.into(),
            request_key: request.request_key.clone(),
            version,
            current_version,
            reconcile_required,
        });
    }
    let receipt = original_receipt(
        conn,
        &binding.workspace_id,
        stored
            .epoch
            .ok_or_else(|| invalid("Original metadata receipt is missing."))?,
    )?;
    let operation = MetadataPatchOperation {
        target: request.target.clone(),
        path: path.into(),
        request_key: request.request_key.clone(),
        operation_id: stored.operation_id.clone(),
        version,
        receipt: Box::new(EditorReceiptView::from(&receipt)),
    };
    if request
        .original
        .as_deref()
        .is_some_and(|original| original != &operation)
    {
        return Err(error(
            AuthorityErrorKind::WrongIdentity,
            "Supplied metadata evidence does not match the original durable receipt.",
        ));
    }
    Ok(MetadataPatchResult::Applied {
        operation: Box::new(operation),
        current_version,
        reconcile_required,
    })
}
struct DeclaredFields<'a> {
    fields: &'a BTreeMap<String, PropertyValue>,
    declarations: Vec<&'a Record>,
}
fn declared_fields<'a>(
    binding: &SelectedBinding,
    snapshot: &'a Snapshot,
    record: &Record,
) -> Result<DeclaredFields<'a>> {
    supported_policy()?;
    store::ordinary_body_target(binding, snapshot, record)?;
    let PropertyValue::Object { value: properties } = &record.metadata else {
        return Err(invalid("Canonical properties must be an object."));
    };
    let name = match properties.get("type") {
        Some(PropertyValue::String { value }) => value,
        _ => {
            return Err(error(
                AuthorityErrorKind::UnsupportedOperation,
                "Metadata edits require one exact declared page type.",
            ))
        }
    };
    let mut declaration = None;
    let mut total = 0usize;
    let mut witnesses = Vec::new();
    for candidate in &snapshot.records {
        let PropertyValue::Object { value } = &candidate.metadata else {
            return Err(invalid("Canonical properties must be an object."));
        };
        if !matches!(value.get("type"),Some(PropertyValue::String{value}) if value=="Type") {
            continue;
        }
        let exact = body(binding, candidate, rules().limits.body_bytes)?;
        witnesses.push(candidate);
        total = total.checked_add(exact.len()).ok_or_else(|| {
            error(
                AuthorityErrorKind::SourceLimit,
                "Type bodies exceed their aggregate bound.",
            )
        })?;
        if total > rules().limits.aggregate_body_bytes {
            return Err(error(
                AuthorityErrorKind::SourceLimit,
                "Type bodies exceed their aggregate bound.",
            ));
        }
        if store::selected_title(&candidate.path, &exact).to_lowercase() == name.to_lowercase() {
            if store::selected_title(&candidate.path, &exact) != *name
                || declaration.replace(value).is_some()
            {
                return Err(error(
                    AuthorityErrorKind::UnsupportedOperation,
                    "The canonical type declaration is ambiguous.",
                ));
            }
        }
    }
    let fields = declaration
        .and_then(|value| value.get("fields"))
        .and_then(|v| match v {
            PropertyValue::Object { value } => Some(value),
            _ => None,
        })
        .ok_or_else(|| {
            error(
                AuthorityErrorKind::UnsupportedOperation,
                "Canonical editable fields are undeclared.",
            )
        })?;
    Ok(DeclaredFields {
        fields,
        declarations: witnesses,
    })
}
fn checked_field(fields: &BTreeMap<String, PropertyValue>, key: &str) -> Result<schema::FieldDef> {
    let table = schema::table().map_err(|e| error(AuthorityErrorKind::UnsupportedProjection, e))?;
    let provenance: serde_json::Value =
        serde_json::from_str(include_str!("../../../shared/import/sources.v1.json"))
            .map_err(|_| invalid("Provenance field policy is unavailable."))?;
    let protected = provenance["agent_guard"]
        .as_array()
        .ok_or_else(|| invalid("Provenance field policy is invalid."))?;
    if policy().protected_keys.iter().any(|item| item == key)
        || table.virtual_fields.iter().any(|item| item == key)
        || protected.iter().any(|value| value.as_str() == Some(key))
    {
        return Err(error(
            AuthorityErrorKind::UnsupportedOperation,
            "This field belongs to its canonical or provenance writer.",
        ));
    }
    let spec = fields.get(key).ok_or_else(|| {
        error(
            AuthorityErrorKind::UnsupportedOperation,
            "This stored field has no supported canonical declaration.",
        )
    })?;
    let declared = match spec {
        PropertyValue::String { value } => Some(value.as_str()),
        PropertyValue::Object { value } => match value.get("kind") {
            Some(PropertyValue::String { value }) => Some(value.as_str()),
            _ => None,
        },
        _ => None,
    };
    if !declared.is_some_and(|kind| {
        FieldKind::from_id(kind).is_some()
            && policy()
                .supported_declared_kinds
                .iter()
                .any(|allowed| allowed == kind)
    }) {
        return Err(error(
            AuthorityErrorKind::UnsupportedProjection,
            "This declared field kind has no supported canonical patch producer.",
        ));
    }
    if matches!(spec,PropertyValue::Object{value} if ["from","formula","source","relation","property","calculate"].iter().any(|key|value.contains_key(*key)))
    {
        return Err(error(
            AuthorityErrorKind::UnsupportedProjection,
            "Derived or malformed field declarations cannot grant a stored scalar edit.",
        ));
    }
    // The supported scalar is admitted from its exact canonical kind tag. Do not project
    // unrelated declaration members through the legacy value transport.
    let raw = serde_json::Value::String(
        declared
            .ok_or_else(|| {
                error(
                    AuthorityErrorKind::UnsupportedProjection,
                    "The field kind is unavailable.",
                )
            })?
            .to_owned(),
    );
    let def = schema::parse_field_def(key, &raw);
    if def.from.is_some() || def.formula.is_some() || table.facts(def.kind).computed {
        return Err(error(
            AuthorityErrorKind::UnsupportedProjection,
            "This field is derived or unsupported for a canonical scalar edit.",
        ));
    }
    Ok(def)
}
fn checked_scalar_value(def: &schema::FieldDef, value: &PropertyValue) -> Result<()> {
    let table = schema::table().map_err(|e| error(AuthorityErrorKind::UnsupportedProjection, e))?;
    let tag = match value {
        PropertyValue::String { .. } => "string",
        PropertyValue::Boolean { .. } => "boolean",
        PropertyValue::Null {} => "null",
        PropertyValue::Decimal { .. } => "decimal",
        PropertyValue::Date { .. } => "date",
        _ => {
            return Err(error(
                AuthorityErrorKind::UnsupportedProjection,
                "This patch supports exact admitted scalar tags or explicit null only.",
            ))
        }
    };
    if !policy()
        .supported_set_kinds
        .iter()
        .any(|allowed| allowed == tag)
        || !policy()
            .set_kinds_by_declared_kind
            .get(def.kind.id())
            .is_some_and(|tags| tags.iter().any(|allowed| allowed == tag))
    {
        return Err(error(
            AuthorityErrorKind::UnsupportedProjection,
            "This canonical value tag is unavailable for the field.",
        ));
    }
    if let PropertyValue::Decimal { .. } = value {
        let facts = table.facts(def.kind);
        // Number has an exact canonical carrier. No JSON Number/f64 roundtrip.
        if !facts.numeric || facts.computed || !facts.accepts.iter().any(|atom| atom == "number") {
            return Err(error(
                AuthorityErrorKind::UnsupportedProjection,
                "This canonical decimal is unavailable for the field.",
            ));
        }
        let source = serde_json::to_string(value).map_err(|_| {
            error(
                AuthorityErrorKind::UnsupportedProjection,
                "The exact decimal cannot be encoded.",
            )
        })?;
        value::decode_tagged(&source)
            .map_err(|e| error(AuthorityErrorKind::UnsupportedProjection, e.message))?;
        return Ok(());
    }
    let raw = match value {
        PropertyValue::String { value } => serde_json::Value::String(value.clone()),
        PropertyValue::Boolean { value } => serde_json::Value::Bool(*value),
        PropertyValue::Null {} => serde_json::Value::Null,
        PropertyValue::Date { value: day } => {
            // Tagged Date validates an exact calendar day, never a local time,
            // Instant or inferred String conversion. Preserve its source bytes.
            let source = serde_json::to_string(value).map_err(|_| {
                error(
                    AuthorityErrorKind::UnsupportedProjection,
                    "The exact calendar date cannot be encoded.",
                )
            })?;
            value::decode_tagged(&source)
                .map_err(|e| error(AuthorityErrorKind::UnsupportedProjection, e.message))?;
            serde_json::Value::String(day.clone())
        }
        _ => {
            return Err(error(
                AuthorityErrorKind::UnsupportedProjection,
                "This canonical scalar is unavailable for the field.",
            ))
        }
    };
    schema::validate_value(def, &raw, table)
        .map_err(|e| error(AuthorityErrorKind::UnsupportedProjection, e))
}
struct PatchPlan<'a> {
    metadata: String,
    declarations: Vec<&'a Record>,
}
fn patch_values<'a>(
    binding: &SelectedBinding,
    snapshot: &'a Snapshot,
    record: &Record,
    changes: &[PropertyChange],
) -> Result<PatchPlan<'a>> {
    let declaration = declared_fields(binding, snapshot, record)?;
    let PropertyValue::Object { value: properties } = &record.metadata else {
        return Err(invalid("Canonical properties must be an object."));
    };
    let mut next = properties.clone();
    for change in changes {
        let key = match change {
            PropertyChange::Set { key, .. } | PropertyChange::Remove { key } => key,
        };
        let def = checked_field(declaration.fields, key)?;
        match change {
            PropertyChange::Set { value, .. } => {
                checked_scalar_value(&def, value)?;
                next.insert(key.clone(), value.clone());
            }
            PropertyChange::Remove { .. } => {
                next.remove(key);
            }
        }
    }
    let source = serde_json::to_string(&PropertyValue::Object { value: next })
        .map_err(|_| invalid("Canonical metadata cannot be encoded."))?;
    if source.len() > value::max_source_bytes() {
        return Err(error(
            AuthorityErrorKind::SourceLimit,
            "Canonical metadata exceeds its value bound.",
        ));
    }
    value::decode_tagged(&source).map_err(|e| error(AuthorityErrorKind::SourceLimit, e.message))?;
    snapshot
        .records
        .iter()
        .try_fold(0usize, |total, other| {
            total.checked_add(if other.id == record.id {
                source.len()
            } else {
                other.metadata_source.len()
            })
        })
        .filter(|total| *total <= rules().limits.aggregate_metadata_bytes)
        .ok_or_else(|| {
            error(
                AuthorityErrorKind::SourceLimit,
                "Canonical metadata exceeds its aggregate bound.",
            )
        })?;
    Ok(PatchPlan {
        metadata: source,
        declarations: declaration.declarations,
    })
}
fn unknown(request: &MetadataPatchRequest, message: &str) -> MetadataPatchResult {
    MetadataPatchResult::OutcomeUnknown {
        request_key: request.request_key.clone(),
        error: missing(message),
    }
}
// The normal mint point stays production-owned. Only explicit disposable
// fixture export can install a scoped original stamp in a test thread.
#[cfg(test)]
std::thread_local! {
    static FIXTURE_OPERATION_STAMP: std::cell::RefCell<Option<(String,String)>> = const { std::cell::RefCell::new(None) };
}
fn operation_stamp() -> (String, String) {
    #[cfg(test)]
    if let Some(stamp) = FIXTURE_OPERATION_STAMP.with(|slot| slot.borrow().clone()) {
        return stamp;
    }
    (
        crate::workspace_migration::identity::mint_uuid_v4(),
        chrono::Utc::now().to_rfc3339(),
    )
}
#[cfg(test)]
pub(crate) fn with_operation_stamp_for_test<T>(
    operation_id: &str,
    at: &str,
    run: impl FnOnce() -> T,
) -> T {
    struct Reset(Option<(String, String)>);
    impl Drop for Reset {
        fn drop(&mut self) {
            FIXTURE_OPERATION_STAMP.with(|slot| {
                slot.replace(self.0.take());
            });
        }
    }
    let previous =
        FIXTURE_OPERATION_STAMP.with(|slot| slot.replace(Some((operation_id.into(), at.into()))));
    let _reset = Reset(previous);
    run()
}
pub(crate) fn patch_metadata(
    root: &Path,
    path: &str,
    request: &MetadataPatchRequest,
    by: &WriteReceipt<Human>,
) -> Result<MetadataPatchResult> {
    let digest = request_digest(path, request)?;
    let binding = authority::selected_binding(root)?;
    if binding.workspace_id != request.target.workspace_id {
        return Err(error(
            AuthorityErrorKind::WrongIdentity,
            "The original workspace identity changed.",
        ));
    }
    let guard = store::read_guard(&binding)?
        .ok_or_else(|| missing("This paired workspace has no trusted lock."))?;
    let _path = crate::vault::write::lock_selected_path(root, path)
        .map_err(|message| error(AuthorityErrorKind::UnsupportedOperation, message))?;
    let read = connection(&binding, false)?;
    if store::schema_version(&read)? != schema_version() {
        return Err(error(
            AuthorityErrorKind::UnsupportedFormat,
            "Durable metadata patches require explicit schema 4 staging.",
        ));
    }
    let read_tx = read
        .unchecked_transaction()
        .map_err(|_| missing("Canonical metadata is busy or unavailable."))?;
    let snapshot = read_snapshot(&read_tx, &binding)?;
    if let Some(original) = lookup(&read_tx, &request.request_key)? {
        let result = replay(
            &read_tx, &binding, &snapshot, path, request, &digest, &original,
        )?;
        store::binding_still(&binding, &guard, &read_tx)?;
        read_tx
            .commit()
            .map_err(|_| missing("Original metadata observation could not finish."))?;
        return Ok(result);
    }
    store::binding_still(&binding, &guard, &read_tx)?;
    read_tx
        .commit()
        .map_err(|_| missing("Original metadata observation could not finish."))?;
    drop(read);
    if request.phase == MetadataPatchPhase::Resolve {
        return Ok(unknown(
            request,
            "No original metadata request evidence can be proven; this resolve made no write.",
        ));
    }
    let mut conn = connection(&binding, true)?;
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|_| missing("Canonical metadata is busy or unavailable."))?;
    let snapshot = read_snapshot(&tx, &binding)?;
    if let Some(original) = lookup(&tx, &request.request_key)? {
        let result = replay(&tx, &binding, &snapshot, path, request, &digest, &original)?;
        store::binding_still(&binding, &guard, &tx)?;
        return Ok(result);
    }
    let record = snapshot
        .records
        .iter()
        .find(|record| record.path == path)
        .ok_or_else(|| missing("The canonical metadata target is unavailable."))?;
    let observed = store::expected_record(&binding, record, &request.expected_version)?;
    body(&binding, record, rules().limits.body_bytes)?;
    let plan = patch_values(&binding, &snapshot, record, &request.changes)?;
    let metadata = &plan.metadata;
    // Unchanged compares canonical tagged values, not accidental JSON spacing.
    let unchanged =
        value::decode_tagged(&metadata).map_err(|e| invalid(&e.message))? == record.metadata;
    let (operation_id, at) = operation_stamp();
    let (revision, epoch, after_hash) = if unchanged {
        (record.revision, None, observed.metadata_hash.clone())
    } else {
        let revision = record.revision.checked_add(1).ok_or_else(|| {
            error(
                AuthorityErrorKind::SourceLimit,
                "Canonical revision is exhausted.",
            )
        })?;
        let epoch = snapshot.epoch.checked_add(1).ok_or_else(|| {
            error(
                AuthorityErrorKind::SourceLimit,
                "Canonical metadata epoch is exhausted.",
            )
        })?;
        let after_hash = crate::ledger::sha256_hex(metadata.as_bytes());
        if tx.execute("UPDATE records SET revision=?1,metadata=?2 WHERE id=?3 AND path=?4 AND revision=?5 AND metadata=?6 AND body_hash=?7",rusqlite::params![revision,metadata,record.id,path,record.revision,record.metadata_source,record.body_hash]).map_err(|_|invalid("Canonical metadata update failed."))?!=1{return Err(error(AuthorityErrorKind::StaleMetadata,"Canonical metadata changed before its transaction."));}
        if tx
            .execute(
                "UPDATE workspace SET metadata_epoch=?1 WHERE singleton=1 AND metadata_epoch=?2",
                [epoch, snapshot.epoch],
            )
            .map_err(|_| invalid("Canonical epoch update failed."))?
            != 1
        {
            return Err(error(
                AuthorityErrorKind::StaleMetadata,
                "Workspace metadata changed before its transaction.",
            ));
        }
        tx.execute("INSERT INTO metadata_receipts(epoch,record_id,previous_revision,revision,metadata_before_hash,metadata_after_hash,actor,operation,at,body_before_hash,body_after_hash,run_id,approved_by) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?10,?11,?12)",rusqlite::params![epoch,record.id,record.revision,revision,observed.metadata_hash,after_hash,by.actor(),policy().operation,at,record.body_hash,by.run_id(),by.approved_by()]).map_err(|_|invalid("Canonical metadata receipt could not be recorded."))?;
        (revision, Some(epoch), after_hash)
    };
    tx.execute("INSERT INTO metadata_requests(request_key,operation_id,workspace_id,record_id,path,payload_hash,expected_revision,expected_metadata_hash,expected_body_hash,result_kind,receipt_epoch,result_revision,result_metadata_hash,result_body_hash,actor,at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?9,?14,?15)",rusqlite::params![request.request_key,operation_id,binding.workspace_id,record.id,path,digest,record.revision,observed.metadata_hash,record.body_hash,if unchanged{"unchanged"}else{"applied"},epoch,revision,after_hash,by.actor(),at]).map_err(|_|invalid("Original metadata request could not be recorded."))?;
    #[cfg(test)]
    super::before_commit();
    body(&binding, record, rules().limits.body_bytes)?;
    // Keep exactly the consulted declarations, including nonchosen candidates;
    // reselecting after drift could silently replace this attempt's authority.
    for declaration in &plan.declarations {
        body(&binding, declaration, rules().limits.body_bytes)?;
    }
    let projected = Record {
        id: record.id.clone(),
        path: record.path.clone(),
        revision,
        body_hash: record.body_hash.clone(),
        metadata_source: if unchanged {
            record.metadata_source.clone()
        } else {
            plan.metadata.clone()
        },
        metadata: if unchanged {
            record.metadata.clone()
        } else {
            value::decode_tagged(metadata).map_err(|e| invalid(&e.message))?
        },
    };
    let mut indexed = record_index(&snapshot.records);
    indexed.insert(
        record.id.as_str(),
        IndexedRecord {
            record: &projected,
            metadata_hash: after_hash.clone(),
        },
    );
    validate_request_index(
        &tx,
        &binding.workspace_id,
        epoch.unwrap_or(snapshot.epoch),
        &indexed,
    )?;
    store::binding_still(&binding, &guard, &tx)?;
    store::page_budget(&tx, &binding)?;
    if tx.commit().is_err() {
        return Ok(unknown(
            request,
            "The original metadata commit could not be confirmed.",
        ));
    }
    #[cfg(test)]
    store::after_commit();
    if store::binding_still(&binding, &guard, &conn).is_err() {
        return Ok(unknown(
            request,
            "The committed original metadata identity could not be revalidated.",
        ));
    }
    let result: Result<MetadataPatchResult> = (|| {
        let observed = conn
            .unchecked_transaction()
            .map_err(|_| missing("Committed metadata observation is unavailable."))?;
        let current = read_snapshot(&observed, &binding)?;
        let original = lookup(&observed, &request.request_key)?
            .ok_or_else(|| invalid("Committed metadata request is unavailable."))?;
        let result = replay(
            &observed, &binding, &current, path, request, &digest, &original,
        )?;
        store::binding_still(&binding, &guard, &observed)?;
        observed
            .commit()
            .map_err(|_| missing("Committed metadata observation could not finish."))?;
        Ok(result)
    })();
    Ok(result.unwrap_or_else(|_| {
        unknown(
            request,
            "The committed original metadata result could not be observed.",
        )
    }))
}

#[cfg(test)]
thread_local! {static REQUEST_BOUNDS:std::cell::Cell<Option<(usize,usize)>>=const{std::cell::Cell::new(None)};}
#[cfg(test)]
pub(crate) fn with_metadata_request_bounds_for_test<T>(
    rows: usize,
    bytes: usize,
    run: impl FnOnce() -> T,
) -> T {
    struct Reset(Option<(usize, usize)>);
    impl Drop for Reset {
        fn drop(&mut self) {
            REQUEST_BOUNDS.with(|slot| slot.set(self.0));
        }
    }
    let _restore = Reset(REQUEST_BOUNDS.with(|slot| slot.replace(Some((rows, bytes)))));
    run()
}

pub(crate) fn read_property(
    root: &Path,
    path: &str,
    target: &SelectedEditorTarget,
    field: &str,
) -> Result<SelectedPropertySnapshot> {
    supported_policy()?;
    if !authority::uuid_valid(&target.workspace_id)
        || !authority::uuid_valid(&target.record_id)
        || target.workspace_id == target.record_id
    {
        return Err(error(
            AuthorityErrorKind::WrongIdentity,
            "The original property target is invalid.",
        ));
    }
    if !super::record_path_valid(path)
        || path.len() > rules().limits.path_bytes
        || field.is_empty()
        || field.len() > rules().limits.path_bytes
    {
        return Err(invalid("The requested property locator is invalid."));
    }
    let binding = authority::selected_binding(root)?;
    if binding.workspace_id != target.workspace_id {
        return Err(error(
            AuthorityErrorKind::WrongIdentity,
            "The original property workspace changed.",
        ));
    }
    let guard = store::read_guard(&binding)?
        .ok_or_else(|| missing("This paired workspace has no trusted lock."))?;
    let _path = crate::vault::write::lock_selected_path(&binding.root, path)
        .map_err(|message| error(AuthorityErrorKind::UnsupportedOperation, message))?;
    let conn = connection(&binding, false)?;
    if store::schema_version(&conn)? != schema_version() {
        return Err(error(
            AuthorityErrorKind::UnsupportedFormat,
            "Requested property editing requires the explicit supported metadata schema.",
        ));
    }
    let tx = conn
        .unchecked_transaction()
        .map_err(|_| missing("Requested property snapshot is unavailable."))?;
    let snapshot = read_snapshot(&tx, &binding)?;
    let record = snapshot
        .records
        .iter()
        .find(|record| record.path == path)
        .ok_or_else(|| missing("The original property record is unavailable."))?;
    let version = store::editor_target(&binding, record, target)?;
    let bytes = store::observed_body(&binding, path)?;
    std::str::from_utf8(&bytes)
        .map_err(|_| invalid("The observed property page body is not UTF-8."))?;
    let observed_body_hash = crate::ledger::sha256_hex(&bytes);
    let coherence = if observed_body_hash == record.body_hash {
        EditorBodyCoherence::Paired
    } else {
        EditorBodyCoherence::ExternalChange
    };
    let PropertyValue::Object { value: properties } = &record.metadata else {
        return Err(invalid("Canonical properties must be an object."));
    };
    let value = match properties.get(field) {
        Some(value) => SelectedPropertyValue::Present {
            value: value.clone(),
        },
        None => SelectedPropertyValue::Absent {},
    };
    let mut witnesses = Vec::new();
    let admitted: Result<()> = (|| {
        let declaration = declared_fields(&binding, &snapshot, record)?;
        witnesses = declaration.declarations;
        let def = checked_field(declaration.fields, field)?;
        if let SelectedPropertyValue::Present { value: stored } = &value {
            checked_scalar_value(&def,stored).map_err(|_|error(AuthorityErrorKind::UnsupportedProjection,"The stored value needs a different typed editor. It is shown without converting it."))?;
        }
        Ok(())
    })();
    let mut read_only_reason = match admitted {
        Ok(()) => None,
        Err(error)
            if matches!(
                error.kind,
                AuthorityErrorKind::UnsupportedOperation
                    | AuthorityErrorKind::UnsupportedProjection
            ) =>
        {
            Some(error.message)
        }
        Err(error) => return Err(error),
    };
    if coherence == EditorBodyCoherence::ExternalChange && read_only_reason.is_none() {
        read_only_reason = Some(
            "The visible body changed. Reconcile it before editing canonical properties.".into(),
        );
    }
    for declaration in witnesses {
        body(&binding, declaration, rules().limits.body_bytes)?;
    }
    if store::observed_body(&binding, path)? != bytes {
        return Err(error(
            AuthorityErrorKind::SourceChanged,
            "The original property body changed while reading.",
        ));
    }
    store::binding_still(&binding, &guard, &tx)?;
    store::no_pending(&binding)?;
    tx.commit()
        .map_err(|_| missing("Requested property snapshot could not finish."))?;
    Ok(SelectedPropertySnapshot {
        target: target.clone(),
        path: path.into(),
        field: field.into(),
        version,
        value,
        observed_body_hash,
        coherence,
        editable: read_only_reason.is_none(),
        read_only_reason,
    })
}
