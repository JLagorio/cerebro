//! ACT-owned opaque display/active-owner references. SELECT-only, no capabilities.
use super::{effect_record, effect_types::*, schema};
use rusqlite::{params, Connection, OptionalExtension};
fn text(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= schema::history_limits().max_id_bytes
        && !value.chars().any(char::is_control)
}
struct Effect {
    id: String,
    state: InvocationState,
}
fn inspect(
    conn: &Connection,
    vault: &str,
    store: &str,
    run: &str,
    actor: &str,
) -> Result<(Vec<Effect>, bool), ()> {
    if ![vault, store, run, actor].into_iter().all(text) {
        return Err(());
    }
    let original:Option<(String,String,String,String,String,Option<String>,Option<String>,Option<String>,Option<String>,Option<String>)>=conn.query_row("SELECT owner_person,vault_id,store_uuid,actor_id,source_kind,parent_run_id,client_id,child_job_id,closed_at,close_kind FROM action_native_runs WHERE run_id=?1",[run],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,row.get(6)?,row.get(7)?,row.get(8)?,row.get(9)?))).optional().map_err(|_|())?;
    let closed = if let Some((
        owner,
        actual_vault,
        actual_store,
        actual_actor,
        kind,
        parent,
        client,
        child,
        closed,
        close_kind,
    )) = original
    {
        if owner != "human:me"
            || actual_vault != vault
            || actual_store != store
            || actual_actor != actor
            || kind != "run"
            || parent.is_some()
            || client.is_some()
            || child.is_some()
            || closed.is_some() != close_kind.is_some()
        {
            return Err(());
        }
        if let Some(closed) = closed {
            effect_record::timestamp(&closed).map_err(|_| ())?;
            if !matches!(
                close_kind.as_deref(),
                Some("completed" | "stopped" | "revoked" | "context_closed")
            ) {
                return Err(());
            }
            true
        } else {
            false
        }
    } else {
        let known:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM chat_generation_runs m JOIN chat_generations g USING(generation_id) WHERE m.run_id=?1 AND g.owner_person='human:me' AND g.vault_id=?2 AND g.store_uuid=?3 AND g.actor_id=?4)",params![run,vault,store,actor],|row|row.get(0)).map_err(|_|())?;
        if !known {
            return Err(());
        }
        false
    };
    let subject = ActionSubjectView {
        vault_id: vault.into(),
        run_id: run.into(),
        actor_id: actor.into(),
        child_job_id: None,
        client_id: None,
    };
    let key = effect_record::scope_key(&subject).map_err(|_| ())?;
    let legacy = effect_record::legacy_scope_key(&subject).map_err(|_| ())?;
    let limits = schema::history_limits();
    let mut statement=conn.prepare("SELECT invocation_id,subject_scope,request_key,request_digest,revision,state,length(CAST(payload AS BLOB)) FROM action_invocations WHERE subject_scope IN (?1,?2) ORDER BY invocation_id LIMIT ?3").map_err(|_|())?;
    let mut rows = statement
        .query(params![
            key,
            legacy,
            i64::try_from(limits.max_effects.saturating_add(1)).map_err(|_| ())?
        ])
        .map_err(|_| ())?;
    let mut result = Vec::new();
    let mut total = 0usize;
    let mut metadata = 0usize;
    while let Some(row) = rows.next().map_err(|_| ())? {
        if result.len() >= limits.max_effects {
            return Err(());
        }
        let mut fields = Vec::with_capacity(5);
        for (index, cap) in [(0, 32), (1, 64), (2, 256), (3, 64), (5, 32)] {
            let value = row
                .get_ref(index)
                .map_err(|_| ())?
                .as_str()
                .map_err(|_| ())?;
            if value.is_empty() || value.len() > cap {
                return Err(());
            }
            metadata = metadata
                .checked_add(value.len())
                .filter(|used| *used <= limits.max_metadata_bytes)
                .ok_or(())?;
            fields.push(value.to_owned());
        }
        let bytes: usize =
            usize::try_from(row.get::<_, i64>(6).map_err(|_| ())?).map_err(|_| ())?;
        total = total
            .checked_add(bytes)
            .filter(|used| *used <= limits.max_stored_payload_bytes_total)
            .ok_or(())?;
        if bytes > limits.max_stored_payload_bytes
            || !effect_record::hex_id(&fields[0], 32)
            || !effect_record::hex_id(&fields[3], 64)
        {
            return Err(());
        }
        let revision: u64 = u64::try_from(row.get::<_, i64>(4).map_err(|_| ())?).map_err(|_| ())?;
        SafeCounter::new(revision).map_err(|_| ())?;
        // Fetch only after the entire borrowed size preflight for this row.
        let raw:String=conn.query_row("SELECT CASE WHEN length(CAST(payload AS BLOB))<=?2 THEN payload ELSE NULL END FROM action_invocations WHERE invocation_id=?1",params![fields[0],i64::try_from(limits.max_stored_payload_bytes).map_err(|_|())?],|row|row.get(0)).map_err(|_|())?;
        let record = effect_record::decode_history(&raw).map_err(|_| ())?;
        let encoded_state = serde_json::to_value(record.details.effect.state).map_err(|_| ())?;
        let actual_key = if record.lookup_version == 0 {
            effect_record::legacy_scope_key(&record.scope)
        } else {
            effect_record::scope_key(&record.scope)
        }
        .map_err(|_| ())?;
        let request = if record.lookup_version == 0 {
            effect_record::legacy_request_digest(&record.request)
        } else {
            effect_record::request_digest(&record.request)
        }
        .map_err(|_| ())?;
        if record.scope != subject
            || actual_key != fields[1]
            || record.details.effect.invocation_id.0 != fields[0]
            || record.request.request_key != fields[2]
            || record.request_digest != fields[3]
            || request != fields[3]
            || record.revision() != revision
            || encoded_state.as_str() != Some(fields[4].as_str())
        {
            return Err(());
        }
        result.push(Effect {
            id: fields.remove(0),
            state: record.details.effect.state,
        });
    }
    Ok((result, closed))
}
pub(crate) fn references(
    conn: &Connection,
    vault: &str,
    store: &str,
    run: &str,
    actor: &str,
) -> Result<Vec<String>, ()> {
    inspect(conn, vault, store, run, actor)
        .map(|(effects, _)| effects.into_iter().map(|effect| effect.id).collect())
}
pub(crate) fn active_owners(
    conn: &Connection,
    vault: &str,
    store: &str,
    run: &str,
    actor: &str,
) -> Result<Vec<String>, ()> {
    inspect(conn, vault, store, run, actor).map(|(effects, closed)| {
        effects
            .into_iter()
            .filter(|effect| {
                matches!(
                    effect.state,
                    InvocationState::Prepared
                        | InvocationState::AwaitingApproval
                        | InvocationState::Ready
                        | InvocationState::Dispatched
                ) || (!closed && effect.state == InvocationState::OutcomeUnknown)
            })
            .map(|effect| effect.id)
            .collect()
    })
}
#[cfg(test)]
#[path = "chat_retention_tests.rs"]
mod tests;
