//! Atomic schedule-to-native-run coordinator. Captured facts are not authority.
use super::{workflow_rows, RuntimeOwner};
use crate::{
    runtime::workflows as flow,
    workflows::{native_definition::NativeDefinition, schedule::Observation},
};
#[derive(Debug, Clone, PartialEq, Eq)]
pub(in crate::actions::native_owner) struct Expected {
    pub(in crate::actions::native_owner) activation: String,
    pub(in crate::actions::native_owner) workflow: String,
    pub(in crate::actions::native_owner) revision: u64,
    pub(in crate::actions::native_owner) epoch: String,
    pub(in crate::actions::native_owner) version: String,
    pub(in crate::actions::native_owner) configuration: String,
    pub(in crate::actions::native_owner) input_digest: String,
    pub(in crate::actions::native_owner) permission_digest: String,
    pub(in crate::actions::native_owner) trigger_digest: String,
    pub(in crate::actions::native_owner) cursor_ms: i64,
    pub(in crate::actions::native_owner) intended_ms: i64,
}
#[derive(Debug, PartialEq, Eq)]
pub(in crate::actions::native_owner) struct Claimed {
    pub(in crate::actions::native_owner) started: workflow_rows::Started,
    pub(in crate::actions::native_owner) occurrence: String,
    pub(in crate::actions::native_owner) intended_ms: i64,
}
/// Existing retained-owner classification and original-opening recheck surround
/// one transaction. No CurrentWorkflowOrigin or execution lease is constructed.
pub(in crate::actions::native_owner) fn claim_owned_rows(
    owner: &mut RuntimeOwner,
    facts: workflow_rows::OpeningFacts<'_>,
    expected: &Expected,
    definition: &NativeDefinition,
    observation: Observation,
    now: chrono::DateTime<chrono::Utc>,
    recheck: impl Fn() -> Result<(), flow::Error>,
) -> Result<Claimed, flow::Error> {
    super::row_transaction(owner, recheck, |conn| {
        claim_rows(conn, facts, expected, definition, observation, now)
    })
}
use crate::runtime::workflow_activations as activation;
use rusqlite::{params, Connection, OptionalExtension};
fn db(_: rusqlite::Error) -> flow::Error {
    flow::Error::Unavailable
}
fn hash(value: &str) -> String {
    crate::ledger::sha256_hex(value.as_bytes())
}
fn hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn integer(value: u64) -> Result<i64, flow::Error> {
    crate::actions::SafeCounter::new(value).map_err(|_| flow::Error::Capacity)?;
    i64::try_from(value).map_err(|_| flow::Error::Capacity)
}
fn counter(value: i64) -> Result<u64, flow::Error> {
    let value = u64::try_from(value).map_err(|_| flow::Error::Unavailable)?;
    crate::actions::SafeCounter::new(value)
        .map(|v| v.get())
        .map_err(|_| flow::Error::Unavailable)
}
pub(super) fn occurrence_key(
    facts: workflow_rows::OpeningFacts<'_>,
    expected: &Expected,
) -> Result<(String, String), flow::Error> {
    if !hex(&expected.activation, 32)
        || !hex(&expected.epoch, 32)
        || [
            &expected.version,
            &expected.configuration,
            &expected.input_digest,
            &expected.permission_digest,
            &expected.trigger_digest,
        ]
        .iter()
        .any(|v| !hex(v, 64))
    {
        return Err(flow::Error::Invalid);
    }
    counter(expected.intended_ms).map_err(|_| flow::Error::Invalid)?;
    let material = serde_json::to_string(&(
        "cerebro.workflow.schedule.occurrence",
        1,
        facts.owner,
        facts.vault,
        facts.store,
        facts.canonical_vault,
        &expected.activation,
        &expected.epoch,
        &expected.workflow,
        &expected.version,
        &expected.configuration,
        &expected.input_digest,
        &expected.permission_digest,
        &expected.trigger_digest,
        expected.intended_ms,
    ))
    .map_err(|_| flow::Error::Invalid)?;
    let occurrence = hash(&material);
    let start = occurrence[..32].to_owned();
    Ok((occurrence, start))
}
fn definition_matches(
    definition: &NativeDefinition,
    expected: &Expected,
) -> Result<(), flow::Error> {
    if definition.workflow() != expected.workflow
        || definition.version() != expected.version
        || hash(definition.input()) != expected.input_digest
        || super::workflow_configuration(definition).map_err(|_| flow::Error::Unavailable)?
            != expected.configuration
    {
        return Err(flow::Error::Denied);
    }
    Ok(())
}
#[expect(
    clippy::too_many_arguments,
    reason = "the native occurrence binds its complete original selection before shared start"
)]
fn start_selected(
    conn: &Connection,
    facts: workflow_rows::OpeningFacts<'_>,
    expected: &Expected,
    definition: &NativeDefinition,
    permissions: &workflow_rows::Permissions,
    key: &str,
    occurrence: &str,
    now: chrono::DateTime<chrono::Utc>,
) -> Result<workflow_rows::Started, flow::Error> {
    let steps = definition.steps();
    let selectors = definition
        .selectors()
        .into_iter()
        .map(|s| workflow_rows::SelectorRequest {
            step: s.step,
            action: s.action,
            definition: s.definition,
            connection: s.connection,
            account: s.account,
        })
        .collect::<Vec<_>>();
    let due = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(expected.intended_ms)
        .ok_or(flow::Error::Invalid)?;
    workflow_rows::start_scheduled_rows(
        conn,
        facts,
        workflow_rows::Start {
            key,
            workflow: definition.workflow(),
            version: definition.version(),
            schema: definition.schema(),
            input: definition.input(),
            configuration: &expected.configuration,
            permissions,
            selectors: &selectors,
            entry: definition.entry(),
            steps: &steps,
            now,
        },
        &expected.activation,
        &expected.epoch,
        occurrence,
        due,
    )
}
/// One original owner transaction recomputes the schedule and current account
/// continuity before the shared native/FLOW start writer creates any authority.
pub(in crate::actions::native_owner) fn claim_rows(
    conn: &Connection,
    facts: workflow_rows::OpeningFacts<'_>,
    expected: &Expected,
    definition: &NativeDefinition,
    observation: Observation,
    now: chrono::DateTime<chrono::Utc>,
) -> Result<Claimed, flow::Error> {
    if conn.is_autocommit() {
        return Err(flow::Error::Unavailable);
    }
    let scope = activation::Scope {
        owner: facts.owner,
        vault: facts.vault,
        store: facts.store,
        canonical_vault: facts.canonical_vault,
    };
    let current =
        activation::inspect_rows(conn, scope, &expected.workflow)?.ok_or(flow::Error::Denied)?;
    if current.id != expected.activation {
        return Err(flow::Error::Stale);
    }
    let (occurrence, key) = occurrence_key(facts, expected)?;
    // Look up the intended slot independently of its supplied digest, so altered
    // metadata cannot create a second identity or adopt a different recorded run.
    let recorded=conn.query_row("SELECT occurrence_digest,trigger_digest,workflow_run_id,start_key,definition_hash,configuration_digest,input_digest,permission_digest,event_digest FROM workflow_occurrences WHERE activation_id=?1 AND epoch=?2 AND intended_at_ms=?3",params![expected.activation,expected.epoch,expected.intended_ms],|row|Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?,row.get::<_,String>(3)?,row.get::<_,String>(4)?,row.get::<_,String>(5)?,row.get::<_,String>(6)?,row.get::<_,String>(7)?,row.get::<_,Option<String>>(8)?))).optional().map_err(db)?;
    if let Some((saved, trigger, run, start, version, configuration, input, permissions, event)) =
        recorded
    {
        if saved != occurrence
            || trigger != expected.trigger_digest
            || start != key
            || version != expected.version
            || configuration != expected.configuration
            || input != expected.input_digest
            || permissions != expected.permission_digest
            || event.is_some()
        {
            return Err(flow::Error::Conflict);
        }
        definition_matches(definition, expected)?;
        let original = workflow_rows::inspect_rows(conn, facts, &run).map_err(|error| {
            if error == flow::Error::Denied {
                flow::Error::Conflict
            } else {
                error
            }
        })?;
        let original_permissions = workflow_rows::permission_bytes(&original.original)?;
        if hash(&original_permissions) != expected.permission_digest {
            return Err(flow::Error::Conflict);
        }
        // The shared replay verifies actual FLOW start digest, frozen selectors,
        // original scope and recorded Schedule cause without issuing another grant.
        let replay = start_selected(
            conn,
            facts,
            expected,
            definition,
            &original.original,
            &key,
            &occurrence,
            now,
        )?;
        if replay != workflow_rows::Started::Observed(original) {
            return Err(flow::Error::Conflict);
        }
        return Ok(Claimed {
            started: replay,
            occurrence,
            intended_ms: expected.intended_ms,
        });
    }
    let ready = checked_current(conn, current, expected, definition, observation, now)?;
    if ready.plan.due_ms != Some(expected.intended_ms) {
        return Err(flow::Error::NotDue);
    }
    // Account pins are compared with actual current material inside the existing
    // start writer immediately before that same writer issues original grants.
    let started = start_selected(
        conn,
        facts,
        expected,
        definition,
        &ready.permissions,
        &key,
        &occurrence,
        now,
    )?;
    let workflow_rows::Started::New(origin) = &started else {
        return Err(flow::Error::Conflict);
    };
    conn.execute("INSERT INTO workflow_occurrences(activation_id,epoch,occurrence_digest,trigger_digest,intended_at_ms,event_digest,workflow_run_id,start_key,definition_hash,configuration_digest,input_digest,permission_digest,created_at_ms) VALUES(?1,?2,?3,?4,?5,NULL,?6,?7,?8,?9,?10,?11,?12)",params![expected.activation,expected.epoch,occurrence,expected.trigger_digest,expected.intended_ms,origin.flow_run,key,expected.version,expected.configuration,expected.input_digest,expected.permission_digest,now.timestamp_millis()]).map_err(db)?;
    advance_rows(conn, facts, expected, &ready, now)?;
    Ok(Claimed {
        started,
        occurrence,
        intended_ms: expected.intended_ms,
    })
}

struct Ready {
    current: activation::Activation,
    permissions: workflow_rows::Permissions,
    plan: crate::workflows::schedule::Plan,
    interval: u32,
    skipped: i64,
    coalesced: i64,
}
fn checked_current(
    conn: &Connection,
    current: activation::Activation,
    expected: &Expected,
    definition: &NativeDefinition,
    observation: Observation,
    now: chrono::DateTime<chrono::Utc>,
) -> Result<Ready, flow::Error> {
    if current.id != expected.activation {
        return Err(flow::Error::Stale);
    }
    if current.revision != expected.revision
        || current.epoch != expected.epoch
        || current.version != expected.version
        || current.configuration != expected.configuration
        || current.input_digest != expected.input_digest
        || current.permission_digest != expected.permission_digest
        || current.trigger_digest != expected.trigger_digest
        || current.cursor_ms != expected.cursor_ms
    {
        return Err(flow::Error::Stale);
    }
    if current.state != "enabled" || current.held {
        return Err(flow::Error::Denied);
    }
    definition_matches(definition, expected)?;
    let (interval, catch_up) = definition.schedule().ok_or(flow::Error::Denied)?;
    if activation::trigger_digest(
        definition.workflow(),
        definition.version(),
        interval,
        catch_up,
    )? != expected.trigger_digest
    {
        return Err(flow::Error::Denied);
    }
    let (body,permission_bytes,schema,stored_interval,stored_catch,skipped,coalesced):(String,String,String,i64,String,i64,i64)=conn.query_row("SELECT input_json,permissions_json,input_schema_digest,interval_seconds,catch_up,skipped_count,coalesced_count FROM workflow_activations WHERE activation_id=?1 AND input_bytes<=?2 AND length(CAST(input_json AS BLOB))<=?2 AND length(CAST(permissions_json AS BLOB))<=?3",params![expected.activation,i64::try_from(flow::step_value_bytes()).map_err(|_|flow::Error::Capacity)?,i64::try_from(flow::origin_policy().permission_bytes).map_err(|_|flow::Error::Capacity)?],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,row.get(6)?))).map_err(db)?;
    let catch_word = match catch_up {
        crate::workflows::schedule::CatchUp::SkipMissed => "skip_missed",
        crate::workflows::schedule::CatchUp::CoalesceLatest => "coalesce_latest",
    };
    if body != definition.input()
        || schema != definition.schema()
        || stored_interval != i64::from(interval)
        || stored_catch != catch_word
    {
        return Err(flow::Error::Denied);
    }
    let permissions: workflow_rows::Permissions =
        serde_json::from_str(&permission_bytes).map_err(|_| flow::Error::Unavailable)?;
    if workflow_rows::permission_bytes(&permissions)? != permission_bytes
        || hash(&permission_bytes) != expected.permission_digest
    {
        return Err(flow::Error::Denied);
    }
    let plan = crate::workflows::schedule::evaluate(crate::workflows::schedule::Request {
        anchor_ms: current.anchor_ms,
        cursor_ms: current.cursor_ms,
        now_ms: now.timestamp_millis(),
        interval_seconds: interval,
        catch_up,
        observation,
        enabled: true,
        ready: true,
        recovery_held: false,
    })
    .map_err(|_| flow::Error::Invalid)?;
    Ok(Ready {
        current,
        permissions,
        plan,
        interval,
        skipped,
        coalesced,
    })
}
fn advance_rows(
    conn: &Connection,
    facts: workflow_rows::OpeningFacts<'_>,
    expected: &Expected,
    ready: &Ready,
    now: chrono::DateTime<chrono::Utc>,
) -> Result<activation::Activation, flow::Error> {
    let current = &ready.current;
    let plan = &ready.plan;
    let interval = ready.interval;
    let skipped = ready.skipped;
    let coalesced = ready.coalesced;
    let next_revision = crate::actions::SafeCounter::new(current.revision)
        .and_then(|v| v.next())
        .map_err(|_| flow::Error::Capacity)?
        .get();
    let total_skipped = counter(skipped)?
        .checked_add(plan.skipped)
        .ok_or(flow::Error::Capacity)?;
    let total_coalesced = counter(coalesced)?
        .checked_add(plan.coalesced)
        .ok_or(flow::Error::Capacity)?;
    let first_skipped = if plan.skipped == 0 {
        None
    } else {
        plan.first_due_ms
    };
    let last_skipped = if let Some(first) = first_skipped {
        Some(
            first
                .checked_add(
                    i64::try_from(plan.skipped - 1)
                        .map_err(|_| flow::Error::Capacity)?
                        .checked_mul(i64::from(interval) * 1000)
                        .ok_or(flow::Error::Capacity)?,
                )
                .ok_or(flow::Error::Capacity)?,
        )
    } else {
        None
    };
    let changed=conn.execute("UPDATE workflow_activations SET cursor_ms=?2,revision=?3,observed_at_ms=?4,coverage_known=?5,skipped_count=?6,coalesced_count=?7,first_skipped_ms=coalesce(first_skipped_ms,?8),last_skipped_ms=coalesce(?9,last_skipped_ms),updated_at_ms=?4 WHERE activation_id=?1 AND revision=?10 AND epoch=?11 AND cursor_ms=?12 AND state='enabled'",params![expected.activation,plan.cursor_ms,integer(next_revision)?,now.timestamp_millis(),plan.coverage_known,integer(total_skipped)?,integer(total_coalesced)?,first_skipped,last_skipped,integer(expected.revision)?,expected.epoch,expected.cursor_ms]).map_err(db)?;
    if changed != 1 {
        return Err(flow::Error::Stale);
    }
    activation::inspect_rows(
        conn,
        activation::Scope {
            owner: facts.owner,
            vault: facts.vault,
            store: facts.store,
            canonical_vault: facts.canonical_vault,
        },
        &expected.workflow,
    )?
    .ok_or(flow::Error::Unavailable)
}

/// Finite schedule observation only. A returned due slot is not consumed and is
/// not authority; the actual claim coordinator must still compare it atomically.
#[derive(Debug, PartialEq, Eq)]
pub(in crate::actions::native_owner) struct Coverage {
    pub(in crate::actions::native_owner) current: activation::Activation,
    pub(in crate::actions::native_owner) plan: crate::workflows::schedule::Plan,
}
pub(in crate::actions::native_owner) fn observe_owned_rows(
    owner: &mut RuntimeOwner,
    facts: workflow_rows::OpeningFacts<'_>,
    expected: &Expected,
    definition: &NativeDefinition,
    observation: Observation,
    now: chrono::DateTime<chrono::Utc>,
    recheck: impl Fn() -> Result<(), flow::Error>,
) -> Result<Coverage, flow::Error> {
    super::row_transaction(owner, recheck, |conn| {
        observe_rows(conn, facts, expected, definition, observation, now)
    })
}
pub(in crate::actions::native_owner) fn observe_rows(
    conn: &Connection,
    facts: workflow_rows::OpeningFacts<'_>,
    expected: &Expected,
    definition: &NativeDefinition,
    observation: Observation,
    now: chrono::DateTime<chrono::Utc>,
) -> Result<Coverage, flow::Error> {
    let ready = current_ready(conn, facts, expected, definition, observation, now)?;
    let current = if ready.plan.due_ms.is_none() && ready.plan.cursor_ms > ready.current.cursor_ms {
        advance_rows(conn, facts, expected, &ready, now)?
    } else {
        ready.current
    };
    Ok(Coverage {
        current,
        plan: ready.plan,
    })
}

/// SELECT-only planning from the actual original configuration and current
/// account pins. The real claim recomputes this under its own transaction.
pub(in crate::actions::native_owner) fn preview_rows(
    conn: &Connection,
    facts: workflow_rows::OpeningFacts<'_>,
    expected: &Expected,
    definition: &NativeDefinition,
    observation: Observation,
    now: chrono::DateTime<chrono::Utc>,
) -> Result<Coverage, flow::Error> {
    let ready = current_ready(conn, facts, expected, definition, observation, now)?;
    Ok(Coverage {
        current: ready.current,
        plan: ready.plan,
    })
}
fn current_ready(
    conn: &Connection,
    facts: workflow_rows::OpeningFacts<'_>,
    expected: &Expected,
    definition: &NativeDefinition,
    observation: Observation,
    now: chrono::DateTime<chrono::Utc>,
) -> Result<Ready, flow::Error> {
    if conn.is_autocommit() {
        return Err(flow::Error::Unavailable);
    }
    let current = activation::inspect_rows(
        conn,
        activation::Scope {
            owner: facts.owner,
            vault: facts.vault,
            store: facts.store,
            canonical_vault: facts.canonical_vault,
        },
        &expected.workflow,
    )?
    .ok_or(flow::Error::Denied)?;
    let ready = checked_current(conn, current, expected, definition, observation, now)?;
    // Preview and finite skipped progress share actual current admission checks.
    // A disabled/rebound account or closed session never looks ready to either.
    workflow_rows::activation_ready_rows(
        conn,
        facts,
        &expected.activation,
        &expected.epoch,
        &ready.permissions,
    )?;
    Ok(ready)
}
