//! Explicit retention mutations. No implicit enabling, Stop or effect cancellation.
use super::*;
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Setting {
    pub choice: RetentionChoice,
    pub revision: u64,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PruneReport {
    pub removed_messages: u64,
    pub removed_search_rows: u64,
    pub logical_bytes_released: u64,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum DeleteResult {
    Deleted,
    AlreadyDeleted,
    BlockedActive { owners: Vec<String> },
}
fn integer(value: i64) -> Result<u64, Error> {
    u64::try_from(value).map_err(unavailable)
}
pub(crate) fn set_rows(
    conn: &Connection,
    scope: Scope<'_>,
    selected: RetentionChoice,
    expected: u64,
) -> Result<Setting, Error> {
    checked(conn, scope)?;
    if expected >= 9_007_199_254_740_991 {
        return Err(Error::Invalid);
    }
    let revision:Option<i64>=conn.query_row("SELECT revision FROM conversation_retention WHERE owner_person=?1 AND vault_id=?2 AND store_uuid=?3",params![scope.owner,scope.vault,scope.store],|row|row.get(0)).optional().map_err(unavailable)?;
    let actual = revision.map(integer).transpose()?.unwrap_or(0);
    if actual != expected {
        return Err(Error::Conflict);
    }
    let next = actual.checked_add(1).ok_or(Error::Unavailable)?;
    conn.execute("INSERT INTO conversation_retention(owner_person,vault_id,store_uuid,choice,revision) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(owner_person,vault_id,store_uuid) DO UPDATE SET choice=excluded.choice,revision=excluded.revision",params![scope.owner,scope.vault,scope.store,selected.word(),i64::try_from(next).map_err(unavailable)?]).map_err(unavailable)?;
    Ok(Setting {
        choice: selected,
        revision: next,
    })
}
pub(crate) fn prune_rows(
    conn: &Connection,
    scope: Scope<'_>,
    now: i64,
) -> Result<PruneReport, Error> {
    checked(conn, scope)?;
    if now < 0 {
        return Err(Error::Invalid);
    }
    let (messages,bytes):(i64,i64)=conn.query_row("SELECT count(*),coalesce(sum(c.logical_bytes),0) FROM conversation_content c JOIN conversation_bindings b USING(generation_id) WHERE b.owner_person=?1 AND b.vault_id=?2 AND b.store_uuid=?3 AND c.expires_at IS NOT NULL AND c.expires_at<=?4",params![scope.owner,scope.vault,scope.store,now],|row|Ok((row.get(0)?,row.get(1)?))).map_err(unavailable)?;
    let search:i64=conn.query_row("SELECT count(*) FROM conversation_search s JOIN conversation_content c USING(generation_id) JOIN conversation_bindings b USING(generation_id) WHERE b.owner_person=?1 AND b.vault_id=?2 AND b.store_uuid=?3 AND c.expires_at IS NOT NULL AND c.expires_at<=?4",params![scope.owner,scope.vault,scope.store,now],|row|row.get(0)).map_err(unavailable)?;
    conn.execute("UPDATE conversation_threads SET title=NULL,title_generation_id=NULL WHERE owner_person=?1 AND vault_id=?2 AND store_uuid=?3 AND title_generation_id IN (SELECT generation_id FROM conversation_content WHERE expires_at IS NOT NULL AND expires_at<=?4)",params![scope.owner,scope.vault,scope.store,now]).map_err(unavailable)?;
    conn.execute("UPDATE conversation_bindings SET archive_state='expired' WHERE owner_person=?1 AND vault_id=?2 AND store_uuid=?3 AND generation_id IN (SELECT generation_id FROM conversation_content WHERE expires_at IS NOT NULL AND expires_at<=?4)",params![scope.owner,scope.vault,scope.store,now]).map_err(unavailable)?;
    // FK cascade removes derived search in the same transaction as content.
    conn.execute("DELETE FROM conversation_content WHERE generation_id IN (SELECT c.generation_id FROM conversation_content c JOIN conversation_bindings b USING(generation_id) WHERE b.owner_person=?1 AND b.vault_id=?2 AND b.store_uuid=?3 AND c.expires_at IS NOT NULL AND c.expires_at<=?4)",params![scope.owner,scope.vault,scope.store,now]).map_err(unavailable)?;
    let legacy = super::legacy::prune_rows(conn, scope, now)?;
    Ok(PruneReport {
        removed_messages: integer(messages)?
            .checked_add(legacy.removed_messages)
            .ok_or(Error::Unavailable)?,
        removed_search_rows: integer(search)?
            .checked_add(legacy.removed_search_rows)
            .ok_or(Error::Unavailable)?,
        logical_bytes_released: integer(bytes)?
            .checked_add(legacy.logical_bytes_released)
            .ok_or(Error::Unavailable)?,
    })
}
fn references(
    conn: &Connection,
    sql: &str,
    scope: Scope<'_>,
    thread: &str,
) -> Result<Vec<String>, Error> {
    let mut statement = conn.prepare(sql).map_err(unavailable)?;
    let rows = statement
        .query_map(
            params![scope.owner, scope.vault, scope.store, thread],
            |row| {
                let value = row.get_ref(0)?.as_str()?;
                if value.is_empty() || value.len() > 128 {
                    return Err(rusqlite::Error::InvalidQuery);
                }
                Ok(value.to_owned())
            },
        )
        .map_err(unavailable)?;
    let values = rows
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(unavailable);
    values
}
pub(crate) fn delete_rows(
    conn: &Connection,
    scope: Scope<'_>,
    thread: &str,
    now: i64,
) -> Result<DeleteResult, Error> {
    checked(conn, scope)?;
    if !opaque(thread) || now < 0 {
        return Err(Error::Invalid);
    }
    let tombstone:Option<Option<i64>>=conn.query_row("SELECT tombstone_at FROM conversation_threads WHERE owner_person=?1 AND vault_id=?2 AND store_uuid=?3 AND thread_id=?4",params![scope.owner,scope.vault,scope.store,thread],|row|row.get(0)).optional().map_err(unavailable)?;
    if !matches!(tombstone, Some(None)) {
        return Ok(DeleteResult::AlreadyDeleted);
    }
    let owners=references(conn,"SELECT g.current_run_id FROM chat_generations g JOIN conversation_bindings b USING(generation_id) WHERE b.owner_person=?1 AND b.vault_id=?2 AND b.store_uuid=?3 AND b.thread_id=?4 AND g.state IN ('admitted','running','deferred') ORDER BY g.generation_id LIMIT 128",scope,thread)?;
    if !owners.is_empty() {
        return Ok(DeleteResult::BlockedActive { owners });
    }
    let owners=references(conn,"SELECT r.job_id FROM child_job_reservations r JOIN chat_delegation_intents i USING(slot_id) JOIN chat_generation_runs m ON m.run_id=i.parent_run_id JOIN conversation_bindings b USING(generation_id) WHERE b.owner_person=?1 AND b.vault_id=?2 AND b.store_uuid=?3 AND b.thread_id=?4 AND r.occupies_slot=1 ORDER BY r.job_id LIMIT 128",scope,thread)?;
    if !owners.is_empty() {
        return Ok(DeleteResult::BlockedActive { owners });
    }
    let owners=references(conn,"SELECT p.pending_id FROM pending_writes p JOIN chat_generation_runs m ON m.run_id=p.run_id JOIN conversation_bindings b USING(generation_id) WHERE b.owner_person=?1 AND b.vault_id=?2 AND b.store_uuid=?3 AND b.thread_id=?4 AND p.vault_id=b.vault_id AND p.state IN ('pending','applying') ORDER BY p.pending_id LIMIT 128",scope,thread)?;
    if !owners.is_empty() {
        return Ok(DeleteResult::BlockedActive { owners });
    }
    // Explicit deletion may inspect its selected thread's history, in bounded
    // pages. Routine launch/recovery never scans this historical inventory.
    let mut after = String::new();
    loop {
        let mut statement=conn.prepare("SELECT m.run_id,g.actor_id FROM chat_generation_runs m JOIN chat_generations g USING(generation_id) JOIN conversation_bindings b USING(generation_id) WHERE b.owner_person=?1 AND b.vault_id=?2 AND b.store_uuid=?3 AND b.thread_id=?4 AND m.run_id>?5 ORDER BY m.run_id LIMIT 128").map_err(unavailable)?;
        let page = statement
            .query_map(
                params![scope.owner, scope.vault, scope.store, thread, after],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .map_err(unavailable)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(unavailable)?;
        if page.is_empty() {
            break;
        }
        for (run, actor) in &page {
            if !opaque(run) || !opaque(actor) {
                return Err(Error::Unavailable);
            }
            let owners = crate::actions::chat_retention::active_owners(
                conn,
                scope.vault,
                scope.store,
                run,
                actor,
            )
            .map_err(unavailable)?;
            if !owners.is_empty() {
                return Ok(DeleteResult::BlockedActive { owners });
            }
        }
        after = page.last().ok_or(Error::Unavailable)?.0.clone();
        if page.len() < 128 {
            break;
        }
    }
    let legacy_owners = super::legacy::active_owners(conn, scope, thread)?;
    if !legacy_owners.is_empty() {
        return Ok(DeleteResult::BlockedActive {
            owners: legacy_owners,
        });
    }
    conn.execute("UPDATE conversation_threads SET title=NULL,title_generation_id=NULL,tombstone_at=?5,updated_at=max(updated_at,?5) WHERE owner_person=?1 AND vault_id=?2 AND store_uuid=?3 AND thread_id=?4 AND tombstone_at IS NULL",params![scope.owner,scope.vault,scope.store,thread,now]).map_err(unavailable)?;
    conn.execute("UPDATE conversation_bindings SET display_json=NULL,pending_json=NULL,archive_state=CASE WHEN completed_at IS NULL THEN 'pending' ELSE 'deleted' END WHERE owner_person=?1 AND vault_id=?2 AND store_uuid=?3 AND thread_id=?4",params![scope.owner,scope.vault,scope.store,thread]).map_err(unavailable)?;
    conn.execute("DELETE FROM conversation_content WHERE generation_id IN (SELECT generation_id FROM conversation_bindings WHERE owner_person=?1 AND vault_id=?2 AND store_uuid=?3 AND thread_id=?4)",params![scope.owner,scope.vault,scope.store,thread]).map_err(unavailable)?;
    super::legacy::delete_rows(conn, scope, thread)?;
    Ok(DeleteResult::Deleted)
}
#[cfg(test)]
#[path = "retention_tests.rs"]
mod tests;
