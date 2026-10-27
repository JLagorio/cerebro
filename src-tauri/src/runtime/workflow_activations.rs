//! Durable configuration and idempotency rows; never native execution authority.
use super::workflows::Error;
use crate::workflows::schedule::CatchUp;
use rusqlite::Connection;
#[derive(Debug, Clone, Copy)]
pub(crate) struct Scope<'a> {
    pub(crate) owner: &'a str,
    pub(crate) vault: &'a str,
    pub(crate) store: &'a str,
    pub(crate) canonical_vault: &'a str,
}
#[derive(Debug, Clone, Copy)]
pub(crate) struct Selection<'a> {
    pub(crate) workflow: &'a str,
    pub(crate) version: &'a str,
    pub(crate) schema: &'a str,
    pub(crate) configuration: &'a str,
    pub(crate) input: &'a str,
    pub(crate) permissions: &'a str,
    pub(crate) interval_seconds: u32,
    pub(crate) catch_up: CatchUp,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Activation {
    pub(crate) id: String,
    pub(crate) workflow: String,
    pub(crate) version: String,
    pub(crate) configuration: String,
    pub(crate) input_digest: String,
    pub(crate) permission_digest: String,
    pub(crate) trigger_digest: String,
    pub(crate) state: String,
    pub(crate) revision: u64,
    pub(crate) epoch: String,
    pub(crate) anchor_ms: i64,
    pub(crate) cursor_ms: i64,
    pub(crate) held: bool,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Receipt {
    pub(crate) operation: String,
    pub(crate) revision: u64,
    pub(crate) epoch: String,
    pub(crate) state: String,
    pub(crate) version: String,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Changed {
    pub(crate) receipt: Receipt,
    pub(crate) current: Activation,
    pub(crate) replayed: bool,
}

use super::workflows as flow;
use rusqlite::{params, OptionalExtension};
fn db(error: rusqlite::Error) -> Error {
    match error {
        rusqlite::Error::SqliteFailure(code, _) if code.code == rusqlite::ErrorCode::DiskFull => {
            Error::Capacity
        }
        _ => Error::Unavailable,
    }
}
fn hex(value: &str, size: usize) -> bool {
    value.len() == size
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn text(value: &str, max: usize) -> bool {
    !value.is_empty() && value.len() <= max && !value.chars().any(char::is_control)
}
fn hash(value: &str) -> String {
    crate::ledger::sha256_hex(value.as_bytes())
}
fn exact(value: u64) -> Result<i64, Error> {
    crate::actions::SafeCounter::new(value).map_err(|_| Error::Capacity)?;
    i64::try_from(value).map_err(|_| Error::Capacity)
}
fn clock(value: i64) -> Result<(), Error> {
    exact(u64::try_from(value).map_err(|_| Error::Invalid)?).map(|_| ())
}
fn counter(row: &rusqlite::Row<'_>, column: usize) -> rusqlite::Result<u64> {
    let value: i64 = row.get(column)?;
    let value = u64::try_from(value).map_err(|_| rusqlite::Error::InvalidQuery)?;
    if value == 0 || crate::actions::SafeCounter::new(value).is_err() {
        return Err(rusqlite::Error::InvalidQuery);
    }
    Ok(value)
}
fn size(value: usize) -> Result<i64, Error> {
    i64::try_from(value).map_err(|_| Error::Capacity)
}
fn next(value: u64) -> Result<u64, Error> {
    crate::actions::SafeCounter::new(value)
        .and_then(|v| v.next())
        .map(|v| v.get())
        .map_err(|_| Error::Capacity)
}
fn guarded(conn: &Connection, scope: Scope<'_>, workflow: &str) -> Result<(), Error> {
    if conn.is_autocommit() {
        return Err(Error::Unavailable);
    }
    if scope.owner != "human:me" {
        return Err(Error::Denied);
    }
    if !hex(scope.vault, 32)
        || !text(scope.store, 128)
        || !text(scope.canonical_vault, 4096)
        || !flow::identity(workflow)
    {
        return Err(Error::Invalid);
    }
    Ok(())
}
fn catch_word(value: CatchUp) -> &'static str {
    match value {
        CatchUp::SkipMissed => "skip_missed",
        CatchUp::CoalesceLatest => "coalesce_latest",
    }
}
fn catch_value(value: &str) -> Result<CatchUp, Error> {
    match value {
        "skip_missed" => Ok(CatchUp::SkipMissed),
        "coalesce_latest" => Ok(CatchUp::CoalesceLatest),
        _ => Err(Error::Invalid),
    }
}
/// Scheduling policy belongs in this identity; V47 engine configuration remains
/// its existing native serializer and is independently checked on continuation.
pub(crate) fn trigger_digest(
    workflow: &str,
    version: &str,
    interval: u32,
    catch_up: CatchUp,
) -> Result<String, Error> {
    crate::workflows::schedule::evaluate(crate::workflows::schedule::Request {
        anchor_ms: 0,
        cursor_ms: 0,
        now_ms: 0,
        interval_seconds: interval,
        catch_up,
        observation: crate::workflows::schedule::Observation::Unknown,
        enabled: false,
        ready: false,
        recovery_held: false,
    })
    .map_err(|_| Error::Invalid)?;
    let policy =
        crate::ledger::sha256_hex(include_bytes!("../../../shared/workflows/schedule.v1.json"));
    Ok(hash(
        &serde_json::to_string(&(
            "cerebro.workflow.activation.trigger",
            1,
            workflow,
            version,
            interval,
            catch_word(catch_up),
            policy,
        ))
        .map_err(|_| Error::Invalid)?,
    ))
}
fn permission_material(value: &str) -> Result<(), Error> {
    let limit = flow::origin_policy().permission_bytes;
    if value.len() > limit {
        return Err(Error::Capacity);
    }
    let checked = crate::actions::schema::workflow_canonical_json(
        value,
        limit,
        flow::action_output_json_depth(),
    )
    .map_err(|error| {
        if error.code == crate::actions::read_types::ActionErrorCode::LimitExceeded {
            Error::Capacity
        } else {
            Error::Invalid
        }
    })?;
    if !checked.starts_with('{') {
        return Err(Error::Invalid);
    }
    // Canonical parsing validates bounds/duplicate keys. Preserve the exact native
    // Permissions serializer bytes: sorting them would change V47 grant identity.
    // The genuine native caller validates typed selection/current account material.
    Ok(())
}
fn held(conn: &Connection, scope: Scope<'_>, workflow: &str) -> Result<bool, Error> {
    conn.query_row("SELECT EXISTS(SELECT 1 FROM workflow_activation_journal WHERE owner_person=?1 AND vault_id=?2 AND store_uuid=?3 AND workflow_id=?4 AND phase<>'reconciled')",params![scope.owner,scope.vault,scope.store,workflow],|row|row.get(0)).map_err(db)
}
struct Stored {
    view: Activation,
    path: String,
    schema: String,
    bytes: usize,
    input: Option<String>,
    permissions: Option<String>,
    interval: u32,
    catch_up: String,
}
fn stored_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Stored> {
    let bytes: i64 = row.get(14)?;
    let interval: i64 = row.get(17)?;
    Ok(Stored {
        view: Activation {
            id: row.get(0)?,
            workflow: row.get(1)?,
            version: row.get(2)?,
            configuration: row.get(3)?,
            input_digest: row.get(4)?,
            permission_digest: row.get(5)?,
            trigger_digest: row.get(6)?,
            state: row.get(7)?,
            revision: counter(row, 8)?,
            epoch: row.get(9)?,
            anchor_ms: row.get(10)?,
            cursor_ms: row.get(11)?,
            held: false,
        },
        path: row.get(12)?,
        schema: row.get(13)?,
        bytes: usize::try_from(bytes).map_err(|_| rusqlite::Error::InvalidQuery)?,
        input: row.get(15)?,
        permissions: row.get(16)?,
        interval: u32::try_from(interval).map_err(|_| rusqlite::Error::InvalidQuery)?,
        catch_up: row.get(18)?,
    })
}
fn load(conn: &Connection, scope: Scope<'_>, workflow: &str) -> Result<Option<Stored>, Error> {
    guarded(conn, scope, workflow)?;
    let found=conn.query_row("SELECT activation_id,workflow_id,definition_hash,configuration_digest,input_digest,permission_digest,trigger_digest,state,revision,epoch,anchor_ms,cursor_ms,canonical_vault_path,input_schema_digest,input_bytes,CASE WHEN input_bytes<=?5 AND length(CAST(input_json AS BLOB))<=?5 THEN input_json ELSE NULL END,CASE WHEN length(CAST(permissions_json AS BLOB))<=?6 THEN permissions_json ELSE NULL END,interval_seconds,catch_up FROM workflow_activations WHERE owner_person=?1 AND vault_id=?2 AND store_uuid=?3 AND workflow_id=?4",params![scope.owner,scope.vault,scope.store,workflow,size(flow::step_value_bytes())?,size(flow::origin_policy().permission_bytes)?],stored_row).optional().map_err(db)?;
    let Some(mut stored) = found else {
        return Ok(None);
    };
    if stored.path != scope.canonical_vault {
        return Err(Error::Denied);
    }
    let view = &stored.view;
    if !hex(&view.id, 32)
        || !hex(&view.epoch, 32)
        || [
            &view.version,
            &view.configuration,
            &view.input_digest,
            &view.permission_digest,
            &view.trigger_digest,
            &stored.schema,
        ]
        .iter()
        .any(|v| !hex(v, 64))
    {
        return Err(Error::Unavailable);
    }
    clock(view.anchor_ms).map_err(|_| Error::Unavailable)?;
    clock(view.cursor_ms).map_err(|_| Error::Unavailable)?;
    let catch_up = catch_value(&stored.catch_up).map_err(|_| Error::Unavailable)?;
    let trigger = trigger_digest(&view.workflow, &view.version, stored.interval, catch_up)
        .map_err(|_| Error::Unavailable)?;
    let period = i64::from(stored.interval)
        .checked_mul(1000)
        .ok_or(Error::Unavailable)?;
    if view.cursor_ms < view.anchor_ms || (view.cursor_ms - view.anchor_ms) % period != 0 {
        return Err(Error::Unavailable);
    }
    match view.state.as_str() {
        "removed" => {
            if stored.bytes != 0 || stored.input.is_some() || stored.permissions.is_some() {
                return Err(Error::Unavailable);
            }
        }
        "enabled" | "paused" => {
            let input = stored.input.as_deref().ok_or(Error::Unavailable)?;
            let permissions = stored.permissions.as_deref().ok_or(Error::Unavailable)?;
            if stored.bytes != input.len()
                || flow::canonical(input).map_err(|_| Error::Unavailable)? != input
                || hash(input) != view.input_digest
                || hash(permissions) != view.permission_digest
            {
                return Err(Error::Unavailable);
            }
            permission_material(permissions).map_err(|_| Error::Unavailable)?;
        }
        _ => return Err(Error::Unavailable),
    }
    stored.view.held = held(conn, scope, workflow)? || trigger != stored.view.trigger_digest;
    Ok(Some(stored))
}
pub(crate) fn inspect_rows(
    conn: &Connection,
    scope: Scope<'_>,
    workflow: &str,
) -> Result<Option<Activation>, Error> {
    load(conn, scope, workflow).map(|value| value.map(|stored| stored.view))
}
fn receipt(
    conn: &Connection,
    scope: Scope<'_>,
    key: &str,
    digest: &str,
    workflow: &str,
) -> Result<Option<Changed>, Error> {
    let found=conn.query_row("SELECT activation_id,request_digest,operation,applied_revision,applied_epoch,applied_state,applied_definition_hash FROM workflow_activation_requests WHERE owner_person=?1 AND vault_id=?2 AND store_uuid=?3 AND request_key=?4",params![scope.owner,scope.vault,scope.store,key],|row|Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,Receipt{operation:row.get(2)?,revision:counter(row,3)?,epoch:row.get(4)?,state:row.get(5)?,version:row.get(6)?}))).optional().map_err(db)?;
    let Some((activation, recorded, receipt)) = found else {
        return Ok(None);
    };
    if recorded != digest {
        return Err(Error::Conflict);
    }
    let current = load(conn, scope, workflow)?.ok_or(Error::Conflict)?.view;
    if current.id != activation
        || receipt.revision > current.revision
        || !hex(&receipt.epoch, 32)
        || !hex(&receipt.version, 64)
        || !matches!(
            (receipt.operation.as_str(), receipt.state.as_str()),
            ("enable", "enabled") | ("pause", "paused") | ("remove", "removed")
        )
    {
        return Err(Error::Conflict);
    }
    Ok(Some(Changed {
        receipt,
        current,
        replayed: true,
    }))
}
fn finish(
    conn: &Connection,
    scope: Scope<'_>,
    key: &str,
    digest: &str,
    operation: &str,
    workflow: &str,
    now: i64,
) -> Result<Changed, Error> {
    let current = load(conn, scope, workflow)?.ok_or(Error::Unavailable)?.view;
    conn.execute("INSERT INTO workflow_activation_requests(owner_person,vault_id,store_uuid,request_key,request_digest,activation_id,operation,applied_revision,applied_epoch,applied_state,applied_definition_hash,applied_at_ms) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",params![scope.owner,scope.vault,scope.store,key,digest,current.id,operation,exact(current.revision)?,current.epoch,current.state,current.version,now]).map_err(db)?;
    let receipt = Receipt {
        operation: operation.into(),
        revision: current.revision,
        epoch: current.epoch.clone(),
        state: current.state.clone(),
        version: current.version.clone(),
    };
    Ok(Changed {
        receipt,
        current,
        replayed: false,
    })
}
pub(crate) fn enable_rows(
    conn: &Connection,
    scope: Scope<'_>,
    key: &str,
    expected: u64,
    selected: Selection<'_>,
    now: i64,
) -> Result<Changed, Error> {
    guarded(conn, scope, selected.workflow)?;
    clock(now)?;
    exact(expected)?;
    if !hex(key, 32)
        || [selected.version, selected.schema, selected.configuration]
            .iter()
            .any(|value| !hex(value, 64))
    {
        return Err(Error::Invalid);
    }
    let input = flow::canonical(selected.input)?;
    permission_material(selected.permissions)?;
    let input_digest = hash(&input);
    let permission_digest = hash(selected.permissions);
    let trigger = trigger_digest(
        selected.workflow,
        selected.version,
        selected.interval_seconds,
        selected.catch_up,
    )?;
    let request = hash(
        &serde_json::to_string(&(
            "cerebro.workflow.activation.request",
            1,
            "enable",
            scope.owner,
            scope.vault,
            scope.store,
            scope.canonical_vault,
            selected.workflow,
            expected,
            selected.version,
            selected.schema,
            selected.configuration,
            &input_digest,
            &permission_digest,
            &trigger,
        ))
        .map_err(|_| Error::Invalid)?,
    );
    if let Some(replay) = receipt(conn, scope, key, &request, selected.workflow)? {
        return Ok(replay);
    }
    let previous = load(conn, scope, selected.workflow)?;
    if previous.as_ref().map_or(0, |old| old.view.revision) != expected {
        return Err(Error::Stale);
    }
    if held(conn, scope, selected.workflow)? {
        return Err(Error::Denied);
    }
    let revision = next(expected)?;
    let epoch = crate::ledger::new_id128();
    flow::capacity_change(
        conn,
        scope.vault,
        input.len(),
        previous.as_ref().map_or(0, |old| old.bytes),
    )?;
    if let Some(old) = previous {
        // Old account continuity material cannot cross an explicitly replaced epoch.
        conn.execute(
            "DELETE FROM workflow_activation_accounts WHERE activation_id=?1",
            [&old.view.id],
        )
        .map_err(db)?;
        let changed=conn.execute("UPDATE workflow_activations SET definition_hash=?2,input_schema_digest=?3,configuration_digest=?4,trigger_digest=?5,input_digest=?6,permission_digest=?7,input_json=?8,input_bytes=?9,permissions_json=?10,interval_seconds=?11,catch_up=?12,state='enabled',revision=?13,epoch=?14,anchor_ms=?15,cursor_ms=?15,observed_at_ms=NULL,coverage_known=0,skipped_count=0,coalesced_count=0,first_skipped_ms=NULL,last_skipped_ms=NULL,updated_at_ms=?15 WHERE activation_id=?1 AND revision=?16",params![old.view.id,selected.version,selected.schema,selected.configuration,trigger,input_digest,permission_digest,input,size(input.len())?,selected.permissions,i64::from(selected.interval_seconds),catch_word(selected.catch_up),exact(revision)?,epoch,now,exact(expected)?]).map_err(db)?;
        if changed != 1 {
            return Err(Error::Stale);
        }
    } else {
        let id = crate::ledger::new_id128();
        conn.execute("INSERT INTO workflow_activations(activation_id,owner_person,vault_id,store_uuid,canonical_vault_path,workflow_id,definition_hash,input_schema_digest,configuration_digest,trigger_digest,input_digest,permission_digest,input_json,input_bytes,permissions_json,interval_seconds,catch_up,state,revision,epoch,anchor_ms,cursor_ms,created_at_ms,updated_at_ms) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,'enabled',?18,?19,?20,?20,?20,?20)",params![id,scope.owner,scope.vault,scope.store,scope.canonical_vault,selected.workflow,selected.version,selected.schema,selected.configuration,trigger,input_digest,permission_digest,input,size(input.len())?,selected.permissions,i64::from(selected.interval_seconds),catch_word(selected.catch_up),exact(revision)?,epoch,now]).map_err(db)?;
    }
    finish(conn, scope, key, &request, "enable", selected.workflow, now)
}
fn change_state(
    conn: &Connection,
    scope: Scope<'_>,
    key: &str,
    workflow: &str,
    expected: u64,
    now: i64,
    remove: bool,
) -> Result<Changed, Error> {
    guarded(conn, scope, workflow)?;
    clock(now)?;
    exact(expected)?;
    if !hex(key, 32) {
        return Err(Error::Invalid);
    }
    let operation = if remove { "remove" } else { "pause" };
    let digest = hash(
        &serde_json::to_string(&(
            "cerebro.workflow.activation.request",
            1,
            operation,
            scope.owner,
            scope.vault,
            scope.store,
            scope.canonical_vault,
            workflow,
            expected,
        ))
        .map_err(|_| Error::Invalid)?,
    );
    if let Some(replay) = receipt(conn, scope, key, &digest, workflow)? {
        return Ok(replay);
    }
    let old = load(conn, scope, workflow)?.ok_or(Error::Denied)?;
    if old.view.revision != expected {
        return Err(Error::Stale);
    }
    if !remove && old.view.state == "removed" {
        return Err(Error::Denied);
    }
    let revision = next(expected)?;
    let changed = if remove {
        conn.execute(
            "DELETE FROM workflow_activation_accounts WHERE activation_id=?1",
            [&old.view.id],
        )
        .map_err(db)?;
        conn.execute("UPDATE workflow_activations SET state='removed',input_json=NULL,input_bytes=0,permissions_json=NULL,revision=?2,updated_at_ms=?3 WHERE activation_id=?1 AND revision=?4",params![old.view.id,exact(revision)?,now,exact(expected)?]).map_err(db)?
    } else {
        conn.execute("UPDATE workflow_activations SET state='paused',revision=?2,updated_at_ms=?3 WHERE activation_id=?1 AND revision=?4",params![old.view.id,exact(revision)?,now,exact(expected)?]).map_err(db)?
    };
    if changed != 1 {
        return Err(Error::Stale);
    }
    finish(conn, scope, key, &digest, operation, workflow, now)
}
pub(crate) fn pause_rows(
    conn: &Connection,
    scope: Scope<'_>,
    key: &str,
    workflow: &str,
    expected: u64,
    now: i64,
) -> Result<Changed, Error> {
    change_state(conn, scope, key, workflow, expected, now, false)
}
pub(crate) fn remove_rows(
    conn: &Connection,
    scope: Scope<'_>,
    key: &str,
    workflow: &str,
    expected: u64,
    now: i64,
) -> Result<Changed, Error> {
    change_state(conn, scope, key, workflow, expected, now, true)
}
#[cfg(test)]
#[path = "workflow_activation_tests.rs"]
mod tests;

/// Bounded operational selection for the captured native Sweep and human view.
/// These rows are data only; no origin, grant, occurrence or physical owner.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Material {
    pub(crate) current: Activation,
    pub(crate) input: Option<String>,
    pub(crate) permissions: Option<String>,
    pub(crate) observed_at_ms: Option<i64>,
    pub(crate) coverage_known: bool,
    pub(crate) skipped: u64,
    pub(crate) coalesced: u64,
    pub(crate) first_skipped_ms: Option<i64>,
    pub(crate) last_skipped_ms: Option<i64>,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SweepPage {
    pub(crate) items: Vec<Activation>,
    pub(crate) next: Option<String>,
}
pub(crate) fn material_rows(
    conn: &Connection,
    scope: Scope<'_>,
    workflow: &str,
) -> Result<Option<Material>, Error> {
    let Some(stored) = load(conn, scope, workflow)? else {
        return Ok(None);
    };
    let(observed,known,skipped,coalesced,first,last):(Option<i64>,bool,i64,i64,Option<i64>,Option<i64>)=conn.query_row("SELECT observed_at_ms,coverage_known,skipped_count,coalesced_count,first_skipped_ms,last_skipped_ms FROM workflow_activations WHERE activation_id=?1",[&stored.view.id],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?))).map_err(db)?;
    let checked_count = |value: i64| -> Result<u64, Error> {
        let value = u64::try_from(value).map_err(|_| Error::Unavailable)?;
        exact(value).map_err(|_| Error::Unavailable)?;
        Ok(value)
    };
    let skipped = checked_count(skipped)?;
    let coalesced = checked_count(coalesced)?;
    for value in [observed, first, last].into_iter().flatten() {
        clock(value).map_err(|_| Error::Unavailable)?;
    }
    if first.is_some() != last.is_some()
        || first.zip(last).is_some_and(|(a, b)| a > b)
        || (skipped == 0) != (first.is_none())
    {
        return Err(Error::Unavailable);
    }
    Ok(Some(Material {
        current: stored.view,
        input: stored.input,
        permissions: stored.permissions,
        observed_at_ms: observed,
        coverage_known: known,
        skipped,
        coalesced,
        first_skipped_ms: first,
        last_skipped_ms: last,
    }))
}
pub(crate) fn sweep_page_rows(
    conn: &Connection,
    scope: Scope<'_>,
    after: Option<&str>,
) -> Result<SweepPage, Error> {
    // Reuse the same original-scope grammar; this constant is not a selected row.
    guarded(conn, scope, "sweep")?;
    if after.is_some_and(|value| !hex(value, 32)) {
        return Err(Error::Invalid);
    }
    let limit = flow::execution_policy().reconciliation_batch;
    if limit == 0 {
        return Err(Error::Unavailable);
    }
    let fetch = limit.checked_add(1).ok_or(Error::Unavailable)?;
    let mut statement=conn.prepare("SELECT activation_id,workflow_id FROM workflow_activations WHERE owner_person=?1 AND vault_id=?2 AND store_uuid=?3 AND state='enabled' AND (?4 IS NULL OR activation_id>?4) ORDER BY activation_id LIMIT ?5").map_err(db)?;
    let rows = statement
        .query_map(
            params![scope.owner, scope.vault, scope.store, after, size(fetch)?],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .map_err(db)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db)?;
    let more = rows.len() > limit;
    let mut items = Vec::with_capacity(rows.len().min(limit));
    for (id, workflow) in rows.into_iter().take(limit) {
        let current = load(conn, scope, &workflow)?
            .ok_or(Error::Unavailable)?
            .view;
        if current.id != id || current.state != "enabled" {
            return Err(Error::Unavailable);
        }
        items.push(current);
    }
    let next = if more {
        items.last().map(|value| value.id.clone())
    } else {
        None
    };
    Ok(SweepPage { items, next })
}

/// Finite recovery identity only. The native file coordinator owns the exact
/// retained opening and publication edit guard; these rows mint no authority.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PublicationTransition {
    pub(crate) id: String,
    pub(crate) workflow: String,
    pub(crate) expected_revision: u64,
    pub(crate) expected_hash: String,
    pub(crate) phase: String,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PublicationTransitions {
    pub(crate) items: Vec<PublicationTransition>,
    pub(crate) next: Option<String>,
}
struct StoredPublicationTransition {
    value: PublicationTransition,
    owner: String,
    vault: String,
    store: String,
    path: String,
    created: i64,
    updated: i64,
}
fn publication_transition_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<StoredPublicationTransition> {
    Ok(StoredPublicationTransition {
        value: PublicationTransition {
            id: row.get(0)?,
            workflow: row.get(1)?,
            expected_revision: counter(row, 2)?,
            expected_hash: row.get(3)?,
            phase: row.get(4)?,
        },
        owner: row.get(5)?,
        vault: row.get(6)?,
        store: row.get(7)?,
        path: row.get(8)?,
        created: row.get(9)?,
        updated: row.get(10)?,
    })
}
fn checked_publication_transition(
    stored: StoredPublicationTransition,
    scope: Scope<'_>,
) -> Result<PublicationTransition, Error> {
    if stored.owner != scope.owner
        || stored.vault != scope.vault
        || stored.store != scope.store
        || stored.path != scope.canonical_vault
    {
        return Err(Error::Denied);
    }
    let value = stored.value;
    if !hex(&value.id, 32)
        || !flow::identity(&value.workflow)
        || !hex(&value.expected_hash, 64)
        || !matches!(
            value.phase.as_str(),
            "prepared" | "pointer_cleared" | "reconciled"
        )
    {
        return Err(Error::Unavailable);
    }
    clock(stored.created).map_err(|_| Error::Unavailable)?;
    clock(stored.updated).map_err(|_| Error::Unavailable)?;
    if stored.updated < stored.created {
        return Err(Error::Unavailable);
    }
    Ok(value)
}
fn publication_transition(
    conn: &Connection,
    scope: Scope<'_>,
    key: &str,
) -> Result<Option<PublicationTransition>, Error> {
    let stored = conn.query_row(
        "SELECT transition_id,workflow_id,expected_publication_revision,expected_definition_hash,phase,owner_person,vault_id,store_uuid,canonical_vault_path,created_at_ms,updated_at_ms FROM workflow_activation_journal WHERE transition_id=?1",
        [key], publication_transition_row,
    ).optional().map_err(db)?;
    stored
        .map(|stored| checked_publication_transition(stored, scope))
        .transpose()
}
fn matching_publication_transition(
    conn: &Connection,
    scope: Scope<'_>,
    expected: &PublicationTransition,
) -> Result<PublicationTransition, Error> {
    if !hex(&expected.id, 32)
        || !hex(&expected.expected_hash, 64)
        || expected.expected_revision == 0
        || !matches!(
            expected.phase.as_str(),
            "prepared" | "pointer_cleared" | "reconciled"
        )
    {
        return Err(Error::Invalid);
    }
    exact(expected.expected_revision)?;
    let current = publication_transition(conn, scope, &expected.id)?.ok_or(Error::Denied)?;
    if current.workflow != expected.workflow
        || current.expected_revision != expected.expected_revision
        || current.expected_hash != expected.expected_hash
    {
        return Err(Error::Conflict);
    }
    // Phase is reloaded: an older observation may replay a later committed phase.
    Ok(current)
}
pub(crate) fn prepare_unpublish_rows(
    conn: &Connection,
    scope: Scope<'_>,
    key: &str,
    workflow: &str,
    expected_revision: u64,
    expected_hash: &str,
    now: i64,
) -> Result<PublicationTransition, Error> {
    guarded(conn, scope, workflow)?;
    clock(now)?;
    if !hex(key, 32) || !hex(expected_hash, 64) || expected_revision == 0 {
        return Err(Error::Invalid);
    }
    // Both the publication tombstone and an enabled selection need room to advance.
    next(expected_revision)?;
    if let Some(current) = publication_transition(conn, scope, key)? {
        if current.workflow != workflow
            || current.expected_revision != expected_revision
            || current.expected_hash != expected_hash
        {
            return Err(Error::Conflict);
        }
        // Never pause again on replay, including after a later explicit Enable.
        return Ok(current);
    }
    let collision: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM workflow_activation_journal WHERE owner_person=?1 AND vault_id=?2 AND store_uuid=?3 AND workflow_id=?4 AND (expected_publication_revision=?5 OR phase<>'reconciled'))",
        params![scope.owner, scope.vault, scope.store, workflow, exact(expected_revision)?],
        |row| row.get(0),
    ).map_err(db)?;
    if collision {
        return Err(Error::Conflict);
    }
    let previous = load(conn, scope, workflow)?;
    let paused_revision = previous
        .as_ref()
        .filter(|stored| stored.view.state == "enabled")
        .map(|stored| next(stored.view.revision))
        .transpose()?;
    conn.execute(
        "INSERT INTO workflow_activation_journal(transition_id,owner_person,vault_id,store_uuid,canonical_vault_path,workflow_id,expected_publication_revision,expected_definition_hash,phase,created_at_ms,updated_at_ms) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,'prepared',?9,?9)",
        params![key, scope.owner, scope.vault, scope.store, scope.canonical_vault, workflow,
            exact(expected_revision)?, expected_hash, now],
    ).map_err(db)?;
    if let (Some(previous), Some(revision)) = (previous, paused_revision) {
        let changed = conn.execute(
            "UPDATE workflow_activations SET state='paused',revision=?2,updated_at_ms=MAX(updated_at_ms,?3) WHERE activation_id=?1 AND state='enabled' AND revision=?4",
            params![previous.view.id, exact(revision)?, now, exact(previous.view.revision)?],
        ).map_err(db)?;
        if changed != 1 {
            return Err(Error::Stale);
        }
    }
    publication_transition(conn, scope, key)?.ok_or(Error::Unavailable)
}
pub(crate) fn pointer_cleared_rows(
    conn: &Connection,
    scope: Scope<'_>,
    transition: &PublicationTransition,
    cleared_revision: u64,
    now: i64,
) -> Result<PublicationTransition, Error> {
    guarded(conn, scope, &transition.workflow)?;
    clock(now)?;
    let current = matching_publication_transition(conn, scope, transition)?;
    if cleared_revision != next(current.expected_revision)? {
        return Err(Error::Conflict);
    }
    if current.phase != "prepared" {
        return Ok(current);
    }
    let changed = conn.execute(
        "UPDATE workflow_activation_journal SET phase='pointer_cleared',updated_at_ms=MAX(updated_at_ms,?2) WHERE transition_id=?1 AND phase='prepared'",
        params![current.id, now],
    ).map_err(db)?;
    if changed != 1 {
        return Err(Error::Stale);
    }
    publication_transition(conn, scope, &current.id)?.ok_or(Error::Unavailable)
}
pub(crate) fn reconcile_unpublish_rows(
    conn: &Connection,
    scope: Scope<'_>,
    transition: &PublicationTransition,
    now: i64,
) -> Result<PublicationTransition, Error> {
    guarded(conn, scope, &transition.workflow)?;
    clock(now)?;
    let current = matching_publication_transition(conn, scope, transition)?;
    if current.phase == "prepared" {
        return Err(Error::Denied);
    }
    if current.phase == "reconciled" {
        return Ok(current);
    }
    let changed = conn.execute(
        "UPDATE workflow_activation_journal SET phase='reconciled',updated_at_ms=MAX(updated_at_ms,?2) WHERE transition_id=?1 AND phase='pointer_cleared'",
        params![current.id, now],
    ).map_err(db)?;
    if changed != 1 {
        return Err(Error::Stale);
    }
    publication_transition(conn, scope, &current.id)?.ok_or(Error::Unavailable)
}
pub(crate) fn pending_publications_rows(
    conn: &Connection,
    scope: Scope<'_>,
    after: Option<&str>,
) -> Result<PublicationTransitions, Error> {
    guarded(conn, scope, "publication-recovery")?;
    if after.is_some_and(|value| !hex(value, 32)) {
        return Err(Error::Invalid);
    }
    let limit = flow::execution_policy().reconciliation_batch;
    if limit == 0 {
        return Err(Error::Unavailable);
    }
    let fetch = limit.checked_add(1).ok_or(Error::Unavailable)?;
    let mut statement = conn.prepare(
        "SELECT transition_id,workflow_id,expected_publication_revision,expected_definition_hash,phase,owner_person,vault_id,store_uuid,canonical_vault_path,created_at_ms,updated_at_ms FROM workflow_activation_journal WHERE owner_person=?1 AND vault_id=?2 AND store_uuid=?3 AND phase<>'reconciled' AND (?4 IS NULL OR transition_id>?4) ORDER BY transition_id LIMIT ?5",
    ).map_err(db)?;
    let rows = statement
        .query_map(
            params![scope.owner, scope.vault, scope.store, after, size(fetch)?],
            publication_transition_row,
        )
        .map_err(db)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db)?;
    let more = rows.len() > limit;
    let items = rows
        .into_iter()
        .take(limit)
        .map(|stored| checked_publication_transition(stored, scope))
        .collect::<Result<Vec<_>, _>>()?;
    let next = if more {
        items.last().map(|value| value.id.clone())
    } else {
        None
    };
    Ok(PublicationTransitions { items, next })
}

/// Original finite recovery metadata only; this SELECT neither prepares a
/// transition nor grants permission to clear a publication file.
pub(crate) fn publication_transition_rows(
    conn: &Connection,
    scope: Scope<'_>,
    key: &str,
) -> Result<Option<PublicationTransition>, Error> {
    guarded(conn, scope, "publication-recovery")?;
    if !hex(key, 32) {
        return Err(Error::Invalid);
    }
    publication_transition(conn, scope, key)
}

/// Exact-workflow recovery lookup; absence is never inferred from a vault page.
pub(crate) fn pending_publication_for_rows(
    conn: &Connection,
    scope: Scope<'_>,
    workflow: &str,
) -> Result<Option<PublicationTransition>, Error> {
    guarded(conn, scope, workflow)?;
    let mut statement = conn.prepare(
        "SELECT transition_id,workflow_id,expected_publication_revision,expected_definition_hash,phase,owner_person,vault_id,store_uuid,canonical_vault_path,created_at_ms,updated_at_ms FROM workflow_activation_journal WHERE owner_person=?1 AND vault_id=?2 AND store_uuid=?3 AND workflow_id=?4 AND phase<>'reconciled' ORDER BY transition_id LIMIT 2",
    ).map_err(db)?;
    let mut rows = statement
        .query_map(
            params![scope.owner, scope.vault, scope.store, workflow],
            publication_transition_row,
        )
        .map_err(db)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db)?;
    // No caller may silently adopt one of multiple unresolved identities.
    if rows.len() > 1 {
        return Err(Error::Unavailable);
    }
    rows.pop()
        .map(|stored| checked_publication_transition(stored, scope))
        .transpose()
}
