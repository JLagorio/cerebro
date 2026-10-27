//! Workflow transaction kernel. Rows are not native/ACT authority.
//! The owning service authenticates and validates immutable definitions first.
#![expect(
    dead_code,
    reason = "M98 runtime boundary precedes native service wiring"
)]
use rusqlite::Connection;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Error {
    Unavailable,
    Invalid,
    Denied,
    Conflict,
    Stale,
    NotDue,
    Capacity,
    MissingValue,
}
#[derive(Clone, Copy)]
pub(crate) struct Scope<'a> {
    pub owner: &'a str,
    pub vault: &'a str,
    pub store: &'a str,
    pub actor: &'a str,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Kind {
    Read,
    Transform,
    Condition,
    Action,
    Timer,
    ExternalInput,
    Result,
}
#[derive(Clone)]
pub(crate) struct Step<'a> {
    pub id: &'a str,
    pub kind: Kind,
    pub next: Option<&'a str>,
    pub otherwise: Option<&'a str>,
}
pub(crate) struct Start<'a> {
    pub key: &'a str,
    pub workflow: &'a str,
    pub version: &'a str,
    pub schema_digest: &'a str,
    pub input: &'a str,
    pub configuration: &'a str,
    pub grants: &'a str,
    pub act_scope: Option<&'a str>,
    pub act_run: Option<&'a str>,
    pub entry: &'a str,
    pub steps: &'a [Step<'a>],
    pub now: i64,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Run {
    pub id: String,
    pub version: String,
    pub input_digest: String,
    pub state: String,
    pub reason: Option<String>,
    pub cursor: Option<String>,
    pub revision: u64,
    pub cancel_requested: bool,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Started {
    New(Run),
    Observed(Run),
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Claim {
    pub run: String,
    pub step: String,
    pub ordinal: u64,
    pub lease: String,
    pub run_revision: u64,
    pub step_revision: u64,
    pub request_key: String,
    pub input_digest: String,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Wait {
    pub id: String,
    pub run: String,
    pub version: String,
    pub step: String,
    pub ordinal: u64,
    pub revision: u64,
    pub kind: String,
    pub state: String,
}
pub(crate) enum WaitFor<'a> {
    Timer { due: i64 },
    ExternalInput { schema: &'a str, expires: i64 },
}
pub(crate) enum Signal<'a> {
    Timer { ready: bool },
    ExternalInput { value: &'a str },
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Resumed {
    Advanced(Run),
    AlreadyConsumed(Run),
    NotDue(Wait),
    Rejected(Wait),
    Blocked(Run),
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum EffectState {
    AwaitingApproval,
    Ready,
    Dispatched,
    Succeeded,
    Failed,
    Denied,
    Expired,
    Unknown,
    Cancelled,
    Revoked,
    OutputUnavailable,
}
/// Internal canonical ACT projection, never deserialized caller decisions.
pub(crate) struct Effect<'a> {
    pub step: &'a str,
    pub ordinal: u64,
    pub request_key: &'a str,
    pub invocation: &'a str,
    pub approval: Option<&'a str>,
    pub revision: u64,
    pub state: EffectState,
    pub output: Option<&'a str>,
}

use rusqlite::{params, OptionalExtension};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::OnceLock;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Limits {
    steps: usize,
    step_output_bytes: usize,
    run_output_bytes: usize,
    json_depth: usize,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RuntimePolicy {
    format_version: u32,
    active_vault_bytes: usize,
    completed_detail_retention: String,
    execution: ExecutionPolicy,
    origin: OriginPolicy,
    catalog: CatalogPolicy,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ExecutionPolicy {
    pub(crate) reconciliation_batch: usize,
    pub(crate) max_workers: usize,
    pub(crate) max_queued_runs: usize,
    pub(crate) minimum_wake_interval_ms: u64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct OriginPolicy {
    pub(crate) permission_bytes: usize,
    pub(crate) read_prefixes: usize,
    pub(crate) account_grants: usize,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CatalogPolicy {
    pub(crate) page_size: usize,
    pub(crate) scan_entries: usize,
    pub(crate) versions_per_workflow: usize,
}
pub(crate) fn catalog_policy() -> &'static CatalogPolicy {
    &policy().catalog
}
pub(crate) fn execution_policy() -> &'static ExecutionPolicy {
    &policy().execution
}
pub(crate) fn origin_policy() -> &'static OriginPolicy {
    &policy().origin
}
fn limits() -> &'static Limits {
    static LIMITS: OnceLock<Limits> = OnceLock::new();
    LIMITS.get_or_init(|| {
        serde_json::from_str(include_str!("../../../shared/workflows/format.v1.json"))
            .expect("workflow format limits")
    })
}
fn policy() -> &'static RuntimePolicy {
    static POLICY: OnceLock<RuntimePolicy> = OnceLock::new();
    POLICY.get_or_init(|| {
        let policy: RuntimePolicy =
            serde_json::from_str(include_str!("../../../shared/workflows/runtime.v1.json"))
                .expect("workflow runtime policy");
        assert_eq!(policy.format_version, 1);
        assert_eq!(policy.completed_detail_retention, "off");
        policy
    })
}
#[cfg(test)]
thread_local! { static VAULT_LIMIT: std::cell::Cell<Option<usize>> = const { std::cell::Cell::new(None) }; }
fn vault_limit() -> usize {
    #[cfg(test)]
    if let Some(limit) = VAULT_LIMIT.with(|value| value.get()) {
        return limit;
    }
    policy().active_vault_bytes
}
#[cfg(test)]
pub(super) fn with_active_vault_limit<T>(bytes: usize, operation: impl FnOnce() -> T) -> T {
    struct Reset(Option<usize>);
    impl Drop for Reset {
        fn drop(&mut self) {
            VAULT_LIMIT.with(|value| value.set(self.0));
        }
    }
    let _reset = Reset(VAULT_LIMIT.with(|value| value.replace(Some(bytes))));
    operation()
}
fn db(error: rusqlite::Error) -> Error {
    match error {
        rusqlite::Error::SqliteFailure(code, _) if code.code == rusqlite::ErrorCode::DiskFull => {
            Error::Capacity
        }
        _ => Error::Unavailable,
    }
}
fn hex(value: &str, n: usize) -> bool {
    value.len() == n
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
fn text(value: &str, max: usize) -> bool {
    !value.is_empty() && value.len() <= max && !value.chars().any(char::is_control)
}
pub(super) fn identity(value: &str) -> bool {
    text(value, 128)
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
}
fn digest(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}
pub(super) fn canonical(value: &str) -> Result<String, Error> {
    let result = crate::actions::schema::workflow_canonical_json(
        value,
        limits().step_output_bytes,
        limits().json_depth,
    )
    .map_err(|error| {
        if error.code == crate::actions::read_types::ActionErrorCode::LimitExceeded {
            Error::Capacity
        } else {
            Error::Invalid
        }
    })?;
    if result.len() > limits().step_output_bytes {
        return Err(Error::Capacity);
    }
    Ok(result)
}
fn guarded(conn: &Connection, scope: Scope<'_>) -> Result<(), Error> {
    if conn.is_autocommit() {
        return Err(Error::Unavailable);
    }
    if !text(scope.owner, 128)
        || !hex(scope.vault, 32)
        || !text(scope.store, 128)
        || !text(scope.actor, 128)
    {
        return Err(Error::Invalid);
    }
    Ok(())
}
fn integer(value: u64) -> Result<i64, Error> {
    if value > 9_007_199_254_740_991 {
        return Err(Error::Invalid);
    }
    i64::try_from(value).map_err(|_| Error::Invalid)
}
fn size(value: usize) -> Result<i64, Error> {
    i64::try_from(value).map_err(|_| Error::Capacity)
}
fn sql_counter(row: &rusqlite::Row<'_>, column: usize) -> rusqlite::Result<u64> {
    let value: i64 = row.get(column)?;
    let value = u64::try_from(value).map_err(|_| rusqlite::Error::InvalidQuery)?;
    if value > 9_007_199_254_740_991 {
        return Err(rusqlite::Error::InvalidQuery);
    }
    Ok(value)
}
fn sql_size(row: &rusqlite::Row<'_>, column: usize) -> rusqlite::Result<usize> {
    let value: i64 = row.get(column)?;
    usize::try_from(value).map_err(|_| rusqlite::Error::InvalidQuery)
}
fn bumped(value: u64) -> Result<i64, Error> {
    integer(value.checked_add(1).ok_or(Error::Capacity)?)
}
fn run_from(row: &rusqlite::Row<'_>) -> rusqlite::Result<Run> {
    Ok(Run {
        id: row.get(0)?,
        version: row.get(1)?,
        input_digest: row.get(2)?,
        state: row.get(3)?,
        reason: row.get(4)?,
        cursor: row.get(5)?,
        revision: sql_counter(row, 6)?,
        cancel_requested: row.get(7)?,
    })
}
pub(crate) fn inspect_rows(conn: &Connection, scope: Scope<'_>, run: &str) -> Result<Run, Error> {
    guarded(conn, scope)?;
    conn.query_row("SELECT run_id,definition_hash,input_digest,state,reason,cursor,revision,cancel_requested FROM workflow_runs WHERE run_id=?1 AND owner_person=?2 AND vault_id=?3 AND store_uuid=?4 AND actor_id=?5",params![run,scope.owner,scope.vault,scope.store,scope.actor],run_from).optional().map_err(db)?.ok_or(Error::Denied)
}
fn capacity(conn: &Connection, scope: Scope<'_>, additional: usize) -> Result<(), Error> {
    capacity_change(conn, scope.vault, additional, 0)
}
/// One vault budget covers active FLOW values/reservations and retained activation
/// inputs across every runtime-store identity. A replacement discounts only its
/// already checked existing activation input, within this same transaction.
pub(super) fn capacity_change(
    conn: &Connection,
    vault: &str,
    additional: usize,
    replaced: usize,
) -> Result<(), Error> {
    if conn.is_autocommit() {
        return Err(Error::Unavailable);
    }
    let values:i64=conn.query_row("SELECT coalesce(sum(v.byte_count),0) FROM workflow_values v JOIN workflow_runs r USING(run_id) WHERE r.vault_id=?1",[vault],|r|r.get(0)).map_err(db)?;
    let reserved: i64 = conn
        .query_row(
            "SELECT coalesce(sum(reserved_bytes),0) FROM workflow_runs WHERE vault_id=?1",
            [vault],
            |r| r.get(0),
        )
        .map_err(db)?;
    let configured: i64 = conn
        .query_row(
            "SELECT coalesce(sum(input_bytes),0) FROM workflow_activations WHERE vault_id=?1",
            [vault],
            |r| r.get(0),
        )
        .map_err(db)?;
    let configured = usize::try_from(configured).map_err(|_| Error::Unavailable)?;
    if replaced > configured {
        return Err(Error::Unavailable);
    }
    let used = usize::try_from(values)
        .map_err(|_| Error::Unavailable)?
        .checked_add(usize::try_from(reserved).map_err(|_| Error::Unavailable)?)
        .ok_or(Error::Capacity)?
        .checked_add(configured)
        .ok_or(Error::Capacity)?;
    let projected = used
        .checked_sub(replaced)
        .ok_or(Error::Unavailable)?
        .checked_add(additional)
        .ok_or(Error::Capacity)?;
    if projected > vault_limit() {
        return Err(Error::Capacity);
    }
    Ok(())
}
fn put_value(
    conn: &Connection,
    run: &str,
    role: &str,
    step: &str,
    ordinal: u64,
    value: &str,
) -> Result<(String, String), Error> {
    let reference = crate::ledger::new_id128();
    let hash = digest(value);
    conn.execute("INSERT INTO workflow_values(run_id,value_ref,digest,role,step_id,ordinal,canonical_json,byte_count) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",params![run,reference,hash,role,step,integer(ordinal)?,value,size(value.len())?]).map_err(db)?;
    Ok((reference, hash))
}
pub(crate) fn value_rows(
    conn: &Connection,
    scope: Scope<'_>,
    run: &str,
    hash: &str,
) -> Result<String, Error> {
    inspect_rows(conn, scope, run)?;
    if !hex(hash, 64) {
        return Err(Error::Invalid);
    }
    let value:String=conn.query_row("SELECT canonical_json FROM workflow_values WHERE run_id=?1 AND digest=?2 AND byte_count<=?3 LIMIT 1",params![run,hash,size(limits().step_output_bytes)?],|r|r.get(0)).optional().map_err(db)?.ok_or(Error::MissingValue)?;
    if digest(&value) != hash || canonical(&value)? != value {
        return Err(Error::Unavailable);
    }
    Ok(value)
}
impl Kind {
    fn word(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::Transform => "transform",
            Self::Condition => "condition",
            Self::Action => "action",
            Self::Timer => "timer",
            Self::ExternalInput => "external_input",
            Self::Result => "result",
        }
    }
}
fn graph(start: &Start<'_>) -> Result<(), Error> {
    if start.steps.is_empty() || start.steps.len() > limits().steps {
        return Err(Error::Invalid);
    }
    let mut index = BTreeMap::new();
    for step in start.steps {
        if !identity(step.id) || index.insert(step.id, step).is_some() {
            return Err(Error::Invalid);
        }
    }
    if !index.contains_key(start.entry) {
        return Err(Error::Invalid);
    }
    let mut incoming: BTreeMap<&str, usize> = index.keys().map(|id| (*id, 0)).collect();
    for step in start.steps {
        match step.kind {
            Kind::Result if step.next.is_none() && step.otherwise.is_none() => (),
            Kind::Condition if step.next.is_some() && step.otherwise.is_some() => (),
            Kind::Result | Kind::Condition => return Err(Error::Invalid),
            _ if step.next.is_some() && step.otherwise.is_none() => (),
            _ => return Err(Error::Invalid),
        }
        for next in step
            .next
            .into_iter()
            .chain(step.otherwise)
            .collect::<BTreeSet<_>>()
        {
            *incoming.get_mut(next).ok_or(Error::Invalid)? += 1;
        }
    }
    if incoming[start.entry] != 0 {
        return Err(Error::Invalid);
    }
    let mut queue = vec![start.entry];
    let mut reached = 0;
    while let Some(id) = queue.pop() {
        reached += 1;
        let step = index[id];
        for next in step
            .next
            .into_iter()
            .chain(step.otherwise)
            .collect::<BTreeSet<_>>()
        {
            let count = incoming.get_mut(next).ok_or(Error::Invalid)?;
            *count -= 1;
            if *count == 0 {
                queue.push(next);
            }
        }
    }
    if reached != start.steps.len() {
        return Err(Error::Invalid);
    }
    Ok(())
}
pub(crate) fn start_rows(
    conn: &Connection,
    scope: Scope<'_>,
    start: Start<'_>,
) -> Result<Started, Error> {
    guarded(conn, scope)?;
    graph(&start)?;
    if !hex(start.key, 32)
        || !identity(start.workflow)
        || [
            start.version,
            start.schema_digest,
            start.configuration,
            start.grants,
        ]
        .iter()
        .any(|v| !hex(v, 64))
        || start.act_scope.is_some() != start.act_run.is_some()
        || start.act_scope.is_some_and(|s| !hex(s, 64))
        || start.act_run.is_some_and(|s| !text(s, 128))
    {
        return Err(Error::Invalid);
    }
    let input = canonical(start.input)?;
    let input_hash = digest(&input);
    let steps: Vec<_> = start
        .steps
        .iter()
        .map(|s| (s.id, s.kind.word(), s.next, s.otherwise))
        .collect();
    let request = digest(
        &serde_json::to_string(&(
            "cerebro.workflow.start",
            1,
            scope.actor,
            start.workflow,
            start.version,
            start.schema_digest,
            &input_hash,
            start.configuration,
            start.grants,
            start.act_scope,
            start.act_run,
            start.entry,
            &steps,
        ))
        .map_err(|_| Error::Invalid)?,
    );
    let existing:Option<(String,String,String)>=conn.query_row("SELECT run_id,start_digest,actor_id FROM workflow_runs WHERE owner_person=?1 AND vault_id=?2 AND store_uuid=?3 AND start_key=?4",params![scope.owner,scope.vault,scope.store,start.key],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(db)?;
    if let Some((id, old, actor)) = existing {
        if old != request || actor != scope.actor {
            return Err(Error::Conflict);
        }
        return inspect_rows(conn, scope, &id).map(Started::Observed);
    }
    capacity(conn, scope, input.len())?;
    let run = crate::ledger::new_id128();
    let reference = crate::ledger::new_id128();
    conn.execute("INSERT INTO workflow_runs(run_id,owner_person,vault_id,store_uuid,actor_id,workflow_id,definition_hash,input_schema_digest,start_key,start_digest,input_ref,input_digest,configuration_digest,grant_digest,act_scope_digest,act_run_id,state,cursor,revision,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,'queued',?17,1,?18,?18)",params![run,scope.owner,scope.vault,scope.store,scope.actor,start.workflow,start.version,start.schema_digest,start.key,request,reference,input_hash,start.configuration,start.grants,start.act_scope,start.act_run,start.entry,start.now]).map_err(db)?;
    conn.execute("INSERT INTO workflow_values(run_id,value_ref,digest,role,step_id,ordinal,canonical_json,byte_count) VALUES(?1,?2,?3,'run_input','',0,?4,?5)",params![run,reference,input_hash,input,size(input.len())?]).map_err(db)?;
    for (ordinal, step) in start.steps.iter().enumerate() {
        conn.execute("INSERT INTO workflow_steps(run_id,step_id,definition_ordinal,kind,next_step,otherwise_step,state,revision,updated_at) VALUES(?1,?2,?3,?4,?5,?6,'pending',1,?7)",params![run,step.id,size(ordinal)?,step.kind.word(),step.next,step.otherwise,start.now]).map_err(db)?;
    }
    inspect_rows(conn, scope, &run).map(Started::New)
}
#[derive(Debug)]
struct StepRow {
    id: String,
    kind: String,
    next: Option<String>,
    otherwise: Option<String>,
    state: String,
    ordinal: u64,
    revision: u64,
    lease: Option<String>,
    input_digest: Option<String>,
    effect_revision: u64,
}
fn step_row(conn: &Connection, run: &str, step: &str) -> Result<StepRow, Error> {
    conn.query_row("SELECT step_id,kind,next_step,otherwise_step,state,attempt_ordinal,revision,lease_token,input_digest,effect_revision FROM workflow_steps WHERE run_id=?1 AND step_id=?2",params![run,step],|r|Ok(StepRow{id:r.get(0)?,kind:r.get(1)?,next:r.get(2)?,otherwise:r.get(3)?,state:r.get(4)?,ordinal:sql_counter(r,5)?,revision:sql_counter(r,6)?,lease:r.get(7)?,input_digest:r.get(8)?,effect_revision:sql_counter(r,9)?})).optional().map_err(db)?.ok_or(Error::Stale)
}
fn current(
    conn: &Connection,
    scope: Scope<'_>,
    run: &str,
    expected: u64,
) -> Result<(Run, StepRow), Error> {
    let run = inspect_rows(conn, scope, run)?;
    if run.revision != expected {
        return Err(Error::Stale);
    }
    let step = step_row(conn, &run.id, run.cursor.as_deref().ok_or(Error::Stale)?)?;
    Ok((run, step))
}
fn claimed(conn: &Connection, scope: Scope<'_>, claim: &Claim) -> Result<(Run, StepRow), Error> {
    let (run, step) = current(conn, scope, &claim.run, claim.run_revision)?;
    if run.cancel_requested
        || run.state != "running"
        || step.state != "running"
        || step.id != claim.step
        || step.ordinal != claim.ordinal
        || step.revision != claim.step_revision
        || step.lease.as_deref() != Some(claim.lease.as_str())
        || step.input_digest.as_deref() != Some(claim.input_digest.as_str())
    {
        return Err(Error::Stale);
    }
    let key:String=conn.query_row("SELECT request_key FROM workflow_attempts WHERE run_id=?1 AND step_id=?2 AND ordinal=?3",params![run.id,step.id,integer(step.ordinal)?],|r|r.get(0)).map_err(db)?;
    if key != claim.request_key {
        return Err(Error::Stale);
    }
    Ok((run, step))
}

/// Bound used by original-input metadata readers; policy remains shared data.
pub(crate) fn step_value_bytes() -> usize {
    limits().step_output_bytes
}
pub(crate) fn definition_step_limit() -> usize {
    limits().steps
}
/// Shared claim check for dependent metadata writers; opens no transaction.
pub(crate) fn check_claim_rows(
    conn: &Connection,
    scope: Scope<'_>,
    claim: &Claim,
) -> Result<(), Error> {
    claimed(conn, scope, claim).map(|_| ())
}
/// A pure mapping rejection has no input value to freeze and no external work.
pub(crate) fn fail_pending_rows(
    conn: &Connection,
    scope: Scope<'_>,
    id: &str,
    expected: u64,
    expected_step: (&str, u64),
    reason: &str,
    now: i64,
) -> Result<Run, Error> {
    let (run, step) = current(conn, scope, id, expected)?;
    if run.state != "queued"
        || run.cancel_requested
        || step.state != "pending"
        || step.ordinal != 0
        || step.id != expected_step.0
        || step.revision != expected_step.1
    {
        return Err(Error::Stale);
    }
    if !matches!(
        reason,
        "missing_step_output" | "mapping_invalid" | "output_limit"
    ) {
        return Err(Error::Invalid);
    }
    dispose(conn, scope, &run, Some(&step), "failed", reason, now)
}

pub(crate) fn claim_rows(
    conn: &Connection,
    scope: Scope<'_>,
    id: &str,
    expected: u64,
    input: &str,
    process: &str,
    now: i64,
) -> Result<Claim, Error> {
    let (run, step) = current(conn, scope, id, expected)?;
    if run.state != "queued" || run.cancel_requested || step.state != "pending" || step.ordinal != 0
    {
        return Err(Error::Stale);
    }
    if !text(process, 1024) {
        return Err(Error::Invalid);
    }
    if step.kind == "action" {
        let bound:bool=conn.query_row("SELECT act_scope_digest IS NOT NULL AND act_run_id IS NOT NULL FROM workflow_runs WHERE run_id=?1",[id],|r|r.get(0)).map_err(db)?;
        if !bound {
            return Err(Error::Denied);
        }
    }
    let input = canonical(input)?;
    let (output, reserved): (usize, usize) = conn
        .query_row(
            "SELECT output_bytes,reserved_bytes FROM workflow_runs WHERE run_id=?1",
            [id],
            |r| Ok((sql_size(r, 0)?, sql_size(r, 1)?)),
        )
        .map_err(db)?;
    if reserved != 0
        || output
            .checked_add(limits().step_output_bytes)
            .ok_or(Error::Capacity)?
            > limits().run_output_bytes
    {
        return Err(Error::Capacity);
    }
    capacity(
        conn,
        scope,
        input
            .len()
            .checked_add(limits().step_output_bytes)
            .ok_or(Error::Capacity)?,
    )?;
    let revision = bumped(run.revision)?;
    let step_revision = bumped(step.revision)?;
    let (reference, input_hash) = put_value(conn, id, "step_input", &step.id, 1, &input)?;
    let lease = crate::ledger::new_id128();
    let key = digest(
        &serde_json::to_string(&("cerebro.workflow.action-request", 1, id, &step.id, 1u64))
            .map_err(|_| Error::Invalid)?,
    );
    conn.execute("INSERT INTO workflow_attempts(run_id,step_id,ordinal,request_key,input_ref,input_digest,created_at) VALUES(?1,?2,1,?3,?4,?5,?6)",params![id,step.id,key,reference,input_hash,now]).map_err(db)?;
    let changed=conn.execute("UPDATE workflow_steps SET state='running',attempt_ordinal=1,revision=?3,lease_token=?4,process_id=?5,input_ref=?6,input_digest=?7,updated_at=?8 WHERE run_id=?1 AND step_id=?2 AND revision=?9 AND state='pending'",params![id,step.id,step_revision,lease,process,reference,input_hash,now,integer(step.revision)?]).map_err(db)?;
    if changed != 1 {
        return Err(Error::Stale);
    }
    let changed=conn.execute("UPDATE workflow_runs SET state='running',revision=?2,reserved_bytes=?3,updated_at=?4 WHERE run_id=?1 AND revision=?5 AND cancel_requested=0",params![id,revision,size(limits().step_output_bytes)?,now,integer(expected)?]).map_err(db)?;
    if changed != 1 {
        return Err(Error::Stale);
    }
    Ok(Claim {
        run: id.into(),
        step: step.id,
        ordinal: 1,
        lease,
        run_revision: u64::try_from(revision).map_err(|_| Error::Unavailable)?,
        step_revision: u64::try_from(step_revision).map_err(|_| Error::Unavailable)?,
        request_key: key,
        input_digest: input_hash,
    })
}

fn clean_terminal(conn: &Connection, run: &str) -> Result<(), Error> {
    // Off is a policy invariant, not an inferred retention period. Operational
    // ACT records and the workflow's minimal identities are never removed here.
    if policy().completed_detail_retention != "off" {
        return Err(Error::Unavailable);
    }
    super::dispatch::finish_workflow_operation_rows(conn, run).map_err(|_| Error::Unavailable)?;
    crate::actions::output_handoff::terminal_cleanup_rows(conn, run)?;
    conn.execute("DELETE FROM workflow_values WHERE run_id=?1", [run])
        .map_err(db)?;
    Ok(())
}
fn finish_transition(
    conn: &Connection,
    scope: Scope<'_>,
    run: &Run,
    step: &StepRow,
    output: &str,
    successor: Option<&str>,
    now: i64,
) -> Result<Run, Error> {
    if run.cancel_requested {
        return Err(Error::Stale);
    }
    match step.kind.as_str() {
        "result" if successor.is_none() => (),
        "condition"
            if (output == "true" && successor == step.next.as_deref())
                || (output == "false" && successor == step.otherwise.as_deref()) =>
        {
            ()
        }
        "result" | "condition" => return Err(Error::Invalid),
        _ if successor.is_some() && successor == step.next.as_deref() => (),
        _ => return Err(Error::Invalid),
    }
    let (spent, reserved): (usize, usize) = conn
        .query_row(
            "SELECT output_bytes,reserved_bytes FROM workflow_runs WHERE run_id=?1",
            [&run.id],
            |r| Ok((sql_size(r, 0)?, sql_size(r, 1)?)),
        )
        .map_err(db)?;
    if output.len() > reserved
        || spent.checked_add(output.len()).ok_or(Error::Capacity)? > limits().run_output_bytes
    {
        return Err(Error::Capacity);
    }
    let (reference, hash) =
        put_value(conn, &run.id, "step_output", &step.id, step.ordinal, output)?;
    let changed=conn.execute("UPDATE workflow_steps SET state='succeeded',revision=?3,lease_token=NULL,output_ref=?4,output_digest=?5,reason=NULL,updated_at=?6 WHERE run_id=?1 AND step_id=?2 AND revision=?7",params![run.id,step.id,bumped(step.revision)?,reference,hash,now,integer(step.revision)?]).map_err(db)?;
    if changed != 1 {
        return Err(Error::Stale);
    }
    // Only nodes unreachable from the chosen cursor are skipped. A merge still
    // reachable through the selected branch remains pending.
    let mut statement = conn
        .prepare(
            "SELECT step_id,next_step,otherwise_step,state FROM workflow_steps WHERE run_id=?1",
        )
        .map_err(db)?;
    let graph = statement
        .query_map([&run.id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, String>(3)?,
            ))
        })
        .map_err(db)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db)?;
    if graph.len() > limits().steps {
        return Err(Error::Unavailable);
    }
    let mut reachable = BTreeSet::new();
    let mut queue = successor.into_iter().map(str::to_owned).collect::<Vec<_>>();
    while let Some(id) = queue.pop() {
        if !reachable.insert(id.clone()) {
            continue;
        }
        let (_, next, other, _) = graph
            .iter()
            .find(|(step, _, _, _)| step == &id)
            .ok_or(Error::Invalid)?;
        queue.extend(next.iter().chain(other).cloned());
    }
    for (id, _, _, state) in graph {
        if state == "pending" && !reachable.contains(&id) {
            conn.execute("UPDATE workflow_steps SET state='skipped',revision=revision+1,reason='branch_not_selected',updated_at=?3 WHERE run_id=?1 AND step_id=?2 AND state='pending'",params![run.id,id,now]).map_err(db)?;
        }
    }
    let state = if successor.is_some() {
        "queued"
    } else {
        "succeeded"
    };
    let changed=conn.execute("UPDATE workflow_runs SET state=?2,reason=NULL,cursor=?3,revision=?4,reserved_bytes=0,output_bytes=?5,updated_at=?6 WHERE run_id=?1 AND revision=?7 AND cancel_requested=0",params![run.id,state,successor,bumped(run.revision)?,size(spent.checked_add(output.len()).ok_or(Error::Capacity)?)?,now,integer(run.revision)?]).map_err(db)?;
    if changed != 1 {
        return Err(Error::Stale);
    }
    if successor.is_none() {
        clean_terminal(conn, &run.id)?;
    }
    inspect_rows(conn, scope, &run.id)
}
pub(crate) fn finish_rows(
    conn: &Connection,
    scope: Scope<'_>,
    claim: &Claim,
    output: &str,
    successor: Option<&str>,
    now: i64,
) -> Result<Run, Error> {
    let (run, step) = claimed(conn, scope, claim)?;
    if !matches!(
        step.kind.as_str(),
        "read" | "transform" | "condition" | "result"
    ) {
        return Err(Error::Denied);
    }
    let output = canonical(output)?;
    finish_transition(conn, scope, &run, &step, &output, successor, now)
}
fn dispose(
    conn: &Connection,
    scope: Scope<'_>,
    run: &Run,
    step: Option<&StepRow>,
    state: &str,
    reason: &str,
    now: i64,
) -> Result<Run, Error> {
    if !matches!(state, "failed" | "cancelled" | "blocked")
        || !identity(reason)
        || reason.len() > 64
    {
        return Err(Error::Invalid);
    }
    let terminal = state != "blocked";
    if let Some(step) = step {
        conn.execute("UPDATE workflow_steps SET state=?3,reason=?4,revision=?5,lease_token=NULL,updated_at=?6 WHERE run_id=?1 AND step_id=?2 AND revision=?7",params![run.id,step.id,state,reason,bumped(step.revision)?,now,integer(step.revision)?]).map_err(db)?;
    }
    if terminal {
        conn.execute("UPDATE workflow_steps SET state=?2,reason=?3,revision=revision+1,updated_at=?4 WHERE run_id=?1 AND state='pending'",params![run.id,if state=="cancelled"{"cancelled"}else{"skipped"},reason,now]).map_err(db)?;
        conn.execute("UPDATE workflow_waits SET state='cancelled',revision=revision+1,updated_at=?2 WHERE run_id=?1 AND state='pending'",params![run.id,now]).map_err(db)?;
    }
    let changed=conn.execute("UPDATE workflow_runs SET state=?2,reason=?3,revision=?4,cursor=CASE WHEN ?5 THEN NULL ELSE cursor END,reserved_bytes=CASE WHEN ?5 THEN 0 ELSE reserved_bytes END,updated_at=?6 WHERE run_id=?1 AND revision=?7",params![run.id,state,reason,bumped(run.revision)?,terminal,now,integer(run.revision)?]).map_err(db)?;
    if changed != 1 {
        return Err(Error::Stale);
    }
    if terminal {
        clean_terminal(conn, &run.id)?;
    }
    inspect_rows(conn, scope, &run.id)
}
pub(crate) fn fail_rows(
    conn: &Connection,
    scope: Scope<'_>,
    claim: &Claim,
    reason: &str,
    now: i64,
) -> Result<Run, Error> {
    let (run, step) = claimed(conn, scope, claim)?;
    if step.kind == "action" {
        return Err(Error::Denied);
    }
    if !matches!(
        reason,
        "missing_step_output"
            | "mapping_invalid"
            | "output_limit"
            | "read_unavailable"
            | "invalid_output"
            | "capacity_unavailable"
    ) {
        return Err(Error::Invalid);
    }
    dispose(conn, scope, &run, Some(&step), "failed", reason, now)
}
fn wait_from(row: &rusqlite::Row<'_>) -> rusqlite::Result<Wait> {
    Ok(Wait {
        id: row.get(0)?,
        run: row.get(1)?,
        version: row.get(2)?,
        step: row.get(3)?,
        ordinal: sql_counter(row, 4)?,
        revision: sql_counter(row, 5)?,
        kind: row.get(6)?,
        state: row.get(7)?,
    })
}
fn wait_row(conn: &Connection, id: &str) -> Result<Wait, Error> {
    conn.query_row("SELECT continuation_id,run_id,definition_hash,step_id,attempt_ordinal,revision,kind,state FROM workflow_waits WHERE continuation_id=?1",[id],wait_from).optional().map_err(db)?.ok_or(Error::Denied)
}
pub(crate) fn park_rows(
    conn: &Connection,
    scope: Scope<'_>,
    claim: &Claim,
    wait: WaitFor<'_>,
    now: i64,
) -> Result<Wait, Error> {
    let (run, step) = claimed(conn, scope, claim)?;
    let (kind, due, expires, schema) = match wait {
        WaitFor::Timer { due } if step.kind == "timer" => ("timer", Some(due), None, None),
        WaitFor::ExternalInput { schema, expires } if step.kind == "external_input" => {
            crate::actions::schema::workflow_schema_digest(schema).map_err(|_| Error::Invalid)?;
            (
                "external_input",
                None,
                Some(expires),
                Some(canonical(schema)?),
            )
        }
        _ => return Err(Error::Denied),
    };
    let schema = if let Some(schema) = schema {
        capacity(conn, scope, schema.len())?;
        Some(put_value(
            conn,
            &run.id,
            "wait_schema",
            &step.id,
            step.ordinal,
            &schema,
        )?)
    } else {
        None
    };
    let id = crate::ledger::new_id128();
    conn.execute("INSERT INTO workflow_waits(continuation_id,run_id,definition_hash,step_id,attempt_ordinal,kind,state,revision,due_at,expires_at,schema_ref,schema_digest,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,'pending',1,?7,?8,?9,?10,?11,?11)",params![id,run.id,run.version,step.id,integer(step.ordinal)?,kind,due,expires,schema.as_ref().map(|s|s.0.as_str()),schema.as_ref().map(|s|s.1.as_str()),now]).map_err(db)?;
    conn.execute("UPDATE workflow_steps SET state='waiting',revision=?3,lease_token=NULL,updated_at=?4 WHERE run_id=?1 AND step_id=?2 AND revision=?5",params![run.id,step.id,bumped(step.revision)?,now,integer(step.revision)?]).map_err(db)?;
    conn.execute("UPDATE workflow_runs SET state='waiting',revision=?2,updated_at=?3 WHERE run_id=?1 AND revision=?4",params![run.id,bumped(run.revision)?,now,integer(run.revision)?]).map_err(db)?;
    wait_row(conn, &id)
}
fn referenced_value(conn: &Connection, run: &str, reference: &str) -> Result<String, Error> {
    let (value,hash):(String,String)=conn.query_row("SELECT canonical_json,digest FROM workflow_values WHERE run_id=?1 AND value_ref=?2 AND byte_count<=?3",params![run,reference,size(limits().step_output_bytes)?],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(db)?.ok_or(Error::MissingValue)?;
    if canonical(&value)? != value || digest(&value) != hash {
        return Err(Error::Unavailable);
    }
    Ok(value)
}
pub(crate) fn resume_rows(
    conn: &Connection,
    scope: Scope<'_>,
    id: &str,
    expected: u64,
    key: &str,
    signal: Signal<'_>,
    now: i64,
) -> Result<Resumed, Error> {
    guarded(conn, scope)?;
    if !hex(id, 32) || !hex(key, 32) {
        return Err(Error::Invalid);
    }
    let wait = wait_row(conn, id)?;
    let run = inspect_rows(conn, scope, &wait.run)?;
    let (due,expires,schema,old_key,old_digest):(Option<i64>,Option<i64>,Option<String>,Option<String>,Option<String>)=conn.query_row("SELECT due_at,expires_at,schema_ref,signal_key,signal_digest FROM workflow_waits WHERE continuation_id=?1",[id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).map_err(db)?;
    let value = match signal {
        Signal::Timer { ready } if wait.kind == "timer" => {
            if !ready {
                return Err(Error::Denied);
            }
            Ok("null".to_owned())
        }
        Signal::ExternalInput { value } if wait.kind == "external_input" => canonical(value),
        _ => return Err(Error::Denied),
    };
    let signal_digest = value.as_ref().ok().map(|value| digest(value));
    if wait.state == "consumed" {
        if expected.checked_add(1) != Some(wait.revision) {
            return Err(Error::Stale);
        }
        if old_key.as_deref() != Some(key) || old_digest != signal_digest {
            return Err(Error::Conflict);
        }
        return Ok(Resumed::AlreadyConsumed(run));
    }
    if wait.state != "pending"
        || wait.revision != expected
        || run.cancel_requested
        || run.state != "waiting"
        || run.version != wait.version
        || run.cursor.as_deref() != Some(wait.step.as_str())
    {
        return Err(Error::Stale);
    }
    let step = step_row(conn, &run.id, &wait.step)?;
    if step.state != "waiting" || step.ordinal != wait.ordinal {
        return Err(Error::Stale);
    }
    if expires.is_some_and(|expires| now >= expires) {
        conn.execute("UPDATE workflow_waits SET state='expired',revision=?2,updated_at=?3 WHERE continuation_id=?1 AND revision=?4 AND state='pending'",params![id,bumped(wait.revision)?,now,integer(expected)?]).map_err(db)?;
        return dispose(
            conn,
            scope,
            &run,
            Some(&step),
            "blocked",
            "input_expired",
            now,
        )
        .map(Resumed::Blocked);
    }
    if wait.kind == "timer" && due.ok_or(Error::Unavailable)? > now {
        return Ok(Resumed::NotDue(wait));
    }
    let valid = match value {
        Ok(value) => {
            if let Some(reference) = schema {
                let schema = referenced_value(conn, &run.id, &reference)?;
                if crate::actions::schema::workflow_validate_input(&schema, &value).is_err() {
                    None
                } else {
                    Some(value)
                }
            } else {
                Some(value)
            }
        }
        Err(_) => None,
    };
    let Some(value) = valid else {
        conn.execute("UPDATE workflow_waits SET rejection_count=min(rejection_count+1,9007199254740991),rejection_reason='invalid_external_input' WHERE continuation_id=?1 AND state='pending' AND revision=?2",params![id,integer(expected)?]).map_err(db)?;
        return Ok(Resumed::Rejected(wait));
    };
    let changed=conn.execute("UPDATE workflow_waits SET state='consumed',revision=?2,signal_key=?3,signal_digest=?4,updated_at=?5 WHERE continuation_id=?1 AND state='pending' AND revision=?6",params![id,bumped(wait.revision)?,key,signal_digest,now,integer(expected)?]).map_err(db)?;
    if changed != 1 {
        return Err(Error::Stale);
    }
    finish_transition(conn, scope, &run, &step, &value, step.next.as_deref(), now)
        .map(Resumed::Advanced)
}

pub(crate) fn cancel_rows(
    conn: &Connection,
    scope: Scope<'_>,
    id: &str,
    expected: u64,
    now: i64,
) -> Result<Run, Error> {
    let mut run = inspect_rows(conn, scope, id)?;
    if run.revision != expected {
        return Err(Error::Stale);
    }
    if matches!(run.state.as_str(), "succeeded" | "failed" | "cancelled") {
        return Ok(run);
    }
    let step = run
        .cursor
        .as_deref()
        .map(|id| step_row(conn, &run.id, id))
        .transpose()?;
    let effect_unsettled = step.as_ref().is_some_and(|step| {
        step.kind == "action"
            && step.ordinal > 0
            && matches!(step.state.as_str(), "running" | "waiting" | "blocked")
    });
    conn.execute(
        "UPDATE workflow_runs SET cancel_requested=1 WHERE run_id=?1 AND revision=?2",
        params![id, integer(expected)?],
    )
    .map_err(db)?;
    conn.execute("UPDATE workflow_waits SET state='cancelled',revision=revision+1,updated_at=?2 WHERE run_id=?1 AND state='pending'",params![id,now]).map_err(db)?;
    run.cancel_requested = true;
    if effect_unsettled {
        let reason = if run.reason.as_deref() == Some("effect_outcome_unknown") {
            "effect_outcome_unknown"
        } else {
            "action_cancel_pending"
        };
        dispose(conn, scope, &run, step.as_ref(), "blocked", reason, now)
    } else {
        dispose(
            conn,
            scope,
            &run,
            step.as_ref(),
            "cancelled",
            "cancelled",
            now,
        )
    }
}
pub(crate) fn action_output_allocation() -> usize {
    limits().step_output_bytes
}
pub(crate) fn action_output_json_depth() -> usize {
    limits().json_depth
}

pub(crate) fn effect_rows(
    conn: &Connection,
    scope: Scope<'_>,
    id: &str,
    expected: u64,
    effect: Effect<'_>,
    now: i64,
) -> Result<Run, Error> {
    effect_rows_inner(conn, scope, id, expected, effect, false, now)
}
#[expect(
    clippy::too_many_arguments,
    reason = "the ACT receipt proof binds the existing FLOW transition"
)]
pub(crate) fn effect_receipt_rows(
    conn: &Connection,
    scope: Scope<'_>,
    id: &str,
    expected: u64,
    effect: Effect<'_>,
    receipt: &crate::actions::output_handoff::VerifiedOutput,
    now: i64,
) -> Result<Run, Error> {
    if !receipt.matches(scope, id, &effect) {
        return Err(Error::Denied);
    }
    effect_rows_inner(conn, scope, id, expected, effect, true, now)
}
#[expect(
    clippy::too_many_arguments,
    reason = "shared projection includes its authenticated receipt disposition"
)]
fn effect_rows_inner(
    conn: &Connection,
    scope: Scope<'_>,
    id: &str,
    expected: u64,
    effect: Effect<'_>,
    verified_receipt: bool,
    now: i64,
) -> Result<Run, Error> {
    // This is a transaction-local projection of an ACT-owner observation. It
    // cannot prepare, approve, dispatch, reconcile or cancel a provider action.
    let (run, step) = current(conn, scope, id, expected)?;
    if step.kind != "action"
        || step.id != effect.step
        || step.ordinal != effect.ordinal
        || !matches!(step.state.as_str(), "running" | "waiting" | "blocked")
        || !matches!(run.state.as_str(), "running" | "waiting" | "blocked")
    {
        return Err(Error::Stale);
    }
    if !hex(effect.request_key, 64)
        || !text(effect.invocation, 128)
        || effect.approval.is_some_and(|id| !text(id, 128))
        || effect.revision == 0
    {
        return Err(Error::Invalid);
    }
    integer(effect.revision)?;
    let (key,invocation,prior_approval):(String,Option<String>,Option<String>)=conn.query_row("SELECT request_key,invocation_id,approval_id FROM workflow_attempts WHERE run_id=?1 AND step_id=?2 AND ordinal=?3",params![id,step.id,integer(step.ordinal)?],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).map_err(db)?;
    if key != effect.request_key
        || invocation
            .as_deref()
            .is_some_and(|id| id != effect.invocation)
    {
        return Err(Error::Denied);
    }
    if effect.revision < step.effect_revision {
        return Err(Error::Stale);
    }
    if effect.revision == step.effect_revision {
        // An ACT-minted receipt may fill a missing body without inventing a
        // newer invocation revision. Cancellation can overlay the block reason;
        // it still must settle this exact authenticated success and discard it.
        let fill_output = verified_receipt
            && effect.state == EffectState::Succeeded
            && run.state == "blocked"
            && step.state == "blocked"
            && (run.reason.as_deref() == Some("action_output_unavailable")
                || (run.cancel_requested
                    && matches!(
                        run.reason.as_deref(),
                        Some("action_cancel_pending" | "effect_outcome_unknown")
                    )))
            && invocation.as_deref() == Some(effect.invocation)
            && prior_approval.as_deref() == effect.approval;
        if !fill_output {
            // Ordinary SELECT-only expiry/revocation keeps its existing rules.
            let reason = match effect.state {
                EffectState::Expired => "approval_expired",
                EffectState::Revoked => "authority_changed",
                _ => return Err(Error::Stale),
            };
            if invocation.as_deref() != Some(effect.invocation)
                || prior_approval.as_deref() != effect.approval
                || effect.output.is_some()
            {
                return Err(Error::Stale);
            }
            if run.state == "blocked" && run.reason.as_deref() == Some(reason) {
                return Ok(run);
            }
            if run.state != "waiting"
                || !matches!(
                    run.reason.as_deref(),
                    Some("approval_pending" | "action_ready")
                )
            {
                return Err(Error::Stale);
            }
        }
    }
    if effect.state == EffectState::AwaitingApproval && effect.approval.is_none() {
        return Err(Error::Invalid);
    }
    let output = if effect.state == EffectState::Succeeded {
        Some(canonical(effect.output.ok_or(Error::Invalid)?)?)
    } else {
        if effect.output.is_some() {
            return Err(Error::Invalid);
        }
        None
    };
    conn.execute("UPDATE workflow_attempts SET invocation_id=?4,approval_id=?5 WHERE run_id=?1 AND step_id=?2 AND ordinal=?3",params![id,step.id,integer(step.ordinal)?,effect.invocation,effect.approval]).map_err(db)?;
    conn.execute(
        "UPDATE workflow_steps SET effect_revision=?3 WHERE run_id=?1 AND step_id=?2",
        params![id, step.id, integer(effect.revision)?],
    )
    .map_err(db)?;
    // Only a real ACT approval produces a person_approval wait. Actions that
    // need no approval reconcile through their durable invocation/attempt link;
    // no fake approval or workflow-owned remote task is created.
    if effect.approval.is_some()
        && !run.cancel_requested
        && effect.state == EffectState::AwaitingApproval
    {
        let existing:Option<(String,String,Option<String>,i64)>=conn.query_row("SELECT continuation_id,state,approval_id,revision FROM workflow_waits WHERE run_id=?1 AND step_id=?2 AND attempt_ordinal=?3",params![id,step.id,integer(step.ordinal)?],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional().map_err(db)?;
        if let Some((wait, state, approval, revision)) = existing {
            let replaced = approval.as_deref() != effect.approval;
            if state == "expired"
                && !replaced
                && matches!(
                    effect.state,
                    EffectState::AwaitingApproval | EffectState::Ready | EffectState::Dispatched
                )
            {
                return Err(Error::Stale);
            }
            if replaced && matches!(state.as_str(), "pending" | "expired" | "consumed") {
                // ACT explicitly retired/replaced this approval under the same
                // invocation/request. Observe its new identity; never renew it
                // ourselves or let an old wait revision consume the replacement.
                let revision = u64::try_from(revision).map_err(|_| Error::Unavailable)?;
                conn.execute("UPDATE workflow_waits SET invocation_id=?2,approval_id=?3,state=?4,revision=?5,signal_key=NULL,signal_digest=NULL,updated_at=?6 WHERE continuation_id=?1 AND revision=?7",params![wait,effect.invocation,effect.approval,if effect.state==EffectState::Expired{"expired"}else{"pending"},bumped(revision)?,now,integer(revision)?]).map_err(db)?;
            } else {
                conn.execute("UPDATE workflow_waits SET invocation_id=?2,approval_id=?3,updated_at=?4 WHERE continuation_id=?1",params![wait,effect.invocation,effect.approval,now]).map_err(db)?;
            }
        } else {
            conn.execute("INSERT INTO workflow_waits(continuation_id,run_id,definition_hash,step_id,attempt_ordinal,kind,state,revision,invocation_id,approval_id,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,'person_approval','pending',1,?6,?7,?8,?8)",params![crate::ledger::new_id128(),id,run.version,step.id,integer(step.ordinal)?,effect.invocation,effect.approval,now]).map_err(db)?;
        }
    }
    if matches!(
        effect.state,
        EffectState::Ready
            | EffectState::Dispatched
            | EffectState::Unknown
            | EffectState::OutputUnavailable
            | EffectState::Succeeded
            | EffectState::Failed
            | EffectState::Denied
            | EffectState::Cancelled
    ) {
        conn.execute("UPDATE workflow_waits SET state='consumed',revision=revision+1,updated_at=?4 WHERE run_id=?1 AND step_id=?2 AND attempt_ordinal=?3 AND state='pending'",params![id,step.id,integer(step.ordinal)?,now]).map_err(db)?;
    }
    match effect.state {
        EffectState::OutputUnavailable => dispose(
            conn,
            scope,
            &run,
            Some(&step),
            "blocked",
            "action_output_unavailable",
            now,
        ),
        EffectState::Unknown => dispose(
            conn,
            scope,
            &run,
            Some(&step),
            "blocked",
            "effect_outcome_unknown",
            now,
        ),
        EffectState::Expired => {
            conn.execute("UPDATE workflow_waits SET state='expired',revision=revision+1,updated_at=?4 WHERE run_id=?1 AND step_id=?2 AND attempt_ordinal=?3 AND state='pending'",params![id,step.id,integer(step.ordinal)?,now]).map_err(db)?;
            dispose(
                conn,
                scope,
                &run,
                Some(&step),
                "blocked",
                "approval_expired",
                now,
            )
        }
        EffectState::Revoked => dispose(
            conn,
            scope,
            &run,
            Some(&step),
            "blocked",
            "authority_changed",
            now,
        ),
        EffectState::Cancelled => dispose(
            conn,
            scope,
            &run,
            Some(&step),
            "cancelled",
            "action_cancelled",
            now,
        ),
        EffectState::Denied => dispose(
            conn,
            scope,
            &run,
            Some(&step),
            "failed",
            "approval_denied",
            now,
        ),
        EffectState::Failed => dispose(
            conn,
            scope,
            &run,
            Some(&step),
            if run.cancel_requested {
                "cancelled"
            } else {
                "failed"
            },
            if run.cancel_requested {
                "cancelled"
            } else {
                "action_failed"
            },
            now,
        ),
        EffectState::Succeeded if run.cancel_requested => dispose(
            conn,
            scope,
            &run,
            Some(&step),
            "cancelled",
            "cancelled_after_effect",
            now,
        ),
        EffectState::Succeeded => finish_transition(
            conn,
            scope,
            &run,
            &step,
            output.as_deref().ok_or(Error::Invalid)?,
            step.next.as_deref(),
            now,
        ),
        EffectState::Dispatched if run.cancel_requested => dispose(
            conn,
            scope,
            &run,
            Some(&step),
            "blocked",
            "effect_outcome_unknown",
            now,
        ),
        _ if run.cancel_requested => dispose(
            conn,
            scope,
            &run,
            Some(&step),
            "blocked",
            "action_cancel_pending",
            now,
        ),
        state => {
            let reason = match state {
                EffectState::AwaitingApproval => "approval_pending",
                EffectState::Ready => "action_ready",
                EffectState::Dispatched => "action_dispatched",
                _ => return Err(Error::Invalid),
            };
            conn.execute("UPDATE workflow_steps SET state='waiting',revision=?3,reason=?4,lease_token=NULL,updated_at=?5 WHERE run_id=?1 AND step_id=?2 AND revision=?6",params![id,step.id,bumped(step.revision)?,reason,now,integer(step.revision)?]).map_err(db)?;
            let changed=conn.execute("UPDATE workflow_runs SET state='waiting',revision=?2,reason=?3,updated_at=?4 WHERE run_id=?1 AND revision=?5",params![id,bumped(run.revision)?,reason,now,integer(expected)?]).map_err(db)?;
            if changed != 1 {
                return Err(Error::Stale);
            }
            inspect_rows(conn, scope, id)
        }
    }
}
pub(crate) fn recover_rows(
    conn: &Connection,
    scope: Scope<'_>,
    process: &str,
    limit: usize,
    now: i64,
) -> Result<usize, Error> {
    guarded(conn, scope)?;
    if !text(process, 1024) || limit == 0 || limit > limits().steps {
        return Err(Error::Invalid);
    }
    let mut statement=conn.prepare("SELECT r.run_id FROM workflow_runs r JOIN workflow_steps s ON s.run_id=r.run_id AND s.step_id=r.cursor WHERE r.owner_person=?1 AND r.vault_id=?2 AND r.store_uuid=?3 AND r.actor_id=?4 AND r.state='running' AND s.state='running' AND s.process_id<>?5 ORDER BY r.created_at,r.run_id LIMIT ?6").map_err(db)?;
    let runs = statement
        .query_map(
            params![
                scope.owner,
                scope.vault,
                scope.store,
                scope.actor,
                process,
                size(limit)?
            ],
            |r| r.get::<_, String>(0),
        )
        .map_err(db)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db)?;
    for id in &runs {
        let run = inspect_rows(conn, scope, id)?;
        let step = step_row(conn, id, run.cursor.as_deref().ok_or(Error::Unavailable)?)?;
        let reason = if step.kind == "action" {
            "action_reconcile_required"
        } else {
            "step_interrupted"
        };
        dispose(conn, scope, &run, Some(&step), "blocked", reason, now)?;
    }
    Ok(runs.len())
}

#[cfg(test)]
#[path = "workflow_tests.rs"]
mod tests;
