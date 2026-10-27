//! Private sequential orchestration. Returned work is data, never native authority.
use super::{
    definition::{self, Definition, Operation, ValidatedDefinition, WaitUntil},
    mapping,
};
use crate::{
    actions::{
        read_types::ActionErrorCode,
        schema,
        workflow_requests::{self, FrozenRequest, Selectors},
    },
    runtime::{workflow_action_inputs, workflows as rows},
};
use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Error {
    Runtime(rows::Error),
    InvalidDefinition,
    InvalidInput,
    MissingStepOutput,
    MappingInvalid,
    OutputLimit,
    Unavailable,
}
impl From<rows::Error> for Error {
    fn from(value: rows::Error) -> Self {
        Self::Runtime(value)
    }
}
pub(super) struct Start<'a> {
    pub key: &'a str,
    pub definition: &'a ValidatedDefinition,
    pub input: &'a str,
    pub configuration: &'a str,
    pub grants: &'a str,
    pub act_scope: Option<&'a str>,
    pub act_run: Option<&'a str>,
    pub now: i64,
}
#[derive(Debug, Clone)]
pub(crate) struct Snapshot {
    run: rows::Run,
    definition: Definition,
    step: usize,
    step_revision: u64,
    configuration: String,
    input: String,
    outputs: BTreeMap<String, String>,
}
#[derive(Debug)]
#[expect(
    clippy::large_enum_variant,
    reason = "bounded run snapshot is owned until pure mapping completes outside the storage lock"
)]
pub(crate) enum Plan {
    Observed(rows::Run),
    Pending(Snapshot),
}
#[derive(Debug)]
enum OperationWork {
    Read {
        schema: String,
        next: String,
    },
    Local {
        output: String,
        next: Option<String>,
    },
    Timer {
        due: i64,
    },
    External {
        schema: String,
        expires: i64,
    },
    Action {
        action: String,
        definition: String,
        connection: String,
        account: String,
    },
}
#[derive(Debug)]
pub(crate) struct Prepared {
    snapshot: Snapshot,
    input: String,
    operation: OperationWork,
}
#[derive(Debug)]
pub(crate) struct ReadWork {
    pub claim: rows::Claim,
    pub query: String,
    version: String,
    output_schema: String,
    next: String,
}
#[derive(Debug)]
pub(crate) struct ActionWork {
    pub claim: rows::Claim,
    pub request: FrozenRequest,
}
#[derive(Debug)]
pub(crate) enum Applied {
    Advanced(rows::Run),
    Read(ReadWork),
    Action(ActionWork),
    Waiting(rows::Wait),
}
pub(crate) struct ActionSnapshot<'a> {
    pub snapshot_digest: &'a str,
    pub configuration_digest: &'a str,
}
fn db(_: rusqlite::Error) -> Error {
    Error::Unavailable
}
fn checked(definition: &ValidatedDefinition) -> Result<ValidatedDefinition, Error> {
    let checked =
        definition::validate(&definition.canonical).map_err(|_| Error::InvalidDefinition)?;
    if checked.definition_hash != definition.definition_hash {
        return Err(Error::InvalidDefinition);
    }
    Ok(checked)
}
fn counter(value: i64) -> Result<u64, Error> {
    if !(1..=9_007_199_254_740_991).contains(&value) {
        return Err(Error::Unavailable);
    }
    u64::try_from(value).map_err(|_| Error::Unavailable)
}
fn size(value: usize) -> Result<i64, Error> {
    i64::try_from(value).map_err(|_| Error::Unavailable)
}
fn hash(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}
fn mapping_error(error: mapping::MappingError) -> Error {
    match error {
        mapping::MappingError::MissingInput { .. }
        | mapping::MappingError::MissingStepOutput { .. } => Error::MissingStepOutput,
        mapping::MappingError::OutputLimit => Error::OutputLimit,
        mapping::MappingError::InvalidSchema => Error::InvalidDefinition,
        mapping::MappingError::ContextLimit => Error::Unavailable,
        _ => Error::MappingInvalid,
    }
}
pub(super) fn contract(operation: &Operation) -> (rows::Kind, Option<&str>, Option<&str>) {
    match operation {
        Operation::Read { next_step_id, .. } => (rows::Kind::Read, Some(next_step_id), None),
        Operation::Transform { next_step_id, .. } => {
            (rows::Kind::Transform, Some(next_step_id), None)
        }
        Operation::Condition {
            if_true, if_false, ..
        } => (rows::Kind::Condition, Some(if_true), Some(if_false)),
        Operation::Action { next_step_id, .. } => (rows::Kind::Action, Some(next_step_id), None),
        Operation::Wait {
            until: WaitUntil::Timer { .. },
            next_step_id,
        } => (rows::Kind::Timer, Some(next_step_id), None),
        Operation::Wait {
            until: WaitUntil::ExternalInput { .. },
            next_step_id,
        } => (rows::Kind::ExternalInput, Some(next_step_id), None),
        Operation::Result { .. } => (rows::Kind::Result, None, None),
    }
}
fn kind(kind: rows::Kind) -> &'static str {
    match kind {
        rows::Kind::Read => "read",
        rows::Kind::Transform => "transform",
        rows::Kind::Condition => "condition",
        rows::Kind::Action => "action",
        rows::Kind::Timer => "timer",
        rows::Kind::ExternalInput => "external_input",
        rows::Kind::Result => "result",
    }
}
fn produces(operation: &Operation) -> bool {
    matches!(
        operation,
        Operation::Read { .. }
            | Operation::Transform { .. }
            | Operation::Action { .. }
            | Operation::Wait {
                until: WaitUntil::ExternalInput { .. },
                ..
            }
    )
}
fn value(
    conn: &Connection,
    run: &str,
    reference: &str,
    digest: &str,
    role: &str,
    step: &str,
    ordinal: i64,
) -> Result<String, Error> {
    let found:Option<(String,String)>=conn.query_row("SELECT canonical_json,digest FROM workflow_values WHERE run_id=?1 AND value_ref=?2 AND role=?3 AND step_id=?4 AND ordinal=?5 AND byte_count<=?6",params![run,reference,role,step,ordinal,size(definition::limits().step_output_bytes)?],|row|Ok((row.get(0)?,row.get(1)?))).optional().map_err(db)?;
    let (value, stored) = found.ok_or(Error::Runtime(rows::Error::MissingValue))?;
    if stored != digest
        || hash(&value) != digest
        || schema::workflow_canonical_json(
            &value,
            definition::limits().step_output_bytes,
            definition::limits().json_depth,
        )
        .map_err(|_| Error::Unavailable)?
            != value
    {
        return Err(Error::Unavailable);
    }
    Ok(value)
}
pub(super) fn start_rows(
    conn: &Connection,
    scope: rows::Scope<'_>,
    start: Start<'_>,
) -> Result<rows::Started, Error> {
    if conn.is_autocommit() {
        return Err(Error::Runtime(rows::Error::Unavailable));
    }
    let checked = checked(start.definition)?;
    definition::validate_input(&checked, start.input).map_err(|_| Error::InvalidInput)?;
    let steps: Vec<_> = checked
        .definition
        .steps
        .iter()
        .map(|step| {
            let (kind, next, otherwise) = contract(&step.operation);
            rows::Step {
                id: &step.step_id,
                kind,
                next,
                otherwise,
            }
        })
        .collect();
    rows::start_rows(
        conn,
        scope,
        rows::Start {
            key: start.key,
            workflow: &checked.definition.workflow_id,
            version: &checked.definition_hash,
            schema_digest: &checked.definition.input_schema_digest,
            input: start.input,
            configuration: start.configuration,
            grants: start.grants,
            act_scope: start.act_scope,
            act_run: start.act_run,
            entry: &checked.definition.entry_step_id,
            steps: &steps,
            now: start.now,
        },
    )
    .map_err(Error::from)
}
pub(super) fn plan_rows(
    conn: &Connection,
    scope: rows::Scope<'_>,
    id: &str,
    definition: &ValidatedDefinition,
) -> Result<Plan, Error> {
    let run = rows::inspect_rows(conn, scope, id)?;
    let checked = checked(definition)?;
    let (workflow,schema_digest,input_ref,configuration):(String,String,String,String)=conn.query_row("SELECT workflow_id,input_schema_digest,input_ref,configuration_digest FROM workflow_runs WHERE run_id=?1",[id],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?))).map_err(db)?;
    if run.version != checked.definition_hash
        || workflow != checked.definition.workflow_id
        || schema_digest != checked.definition.input_schema_digest
    {
        return Err(Error::InvalidDefinition);
    }
    if run.state != "queued" || run.cancel_requested {
        return Ok(Plan::Observed(run));
    }
    let cursor = run.cursor.as_deref().ok_or(Error::Unavailable)?;
    let index = checked
        .definition
        .steps
        .iter()
        .position(|step| step.step_id == cursor)
        .ok_or(Error::InvalidDefinition)?;
    let (state,attempt,revision,stored_kind,next,otherwise,position):(String,i64,i64,String,Option<String>,Option<String>,i64)=conn.query_row("SELECT state,attempt_ordinal,revision,kind,next_step,otherwise_step,definition_ordinal FROM workflow_steps WHERE run_id=?1 AND step_id=?2",params![id,cursor],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,row.get(6)?))).map_err(db)?;
    let (expected_kind, expected_next, expected_otherwise) =
        contract(&checked.definition.steps[index].operation);
    if state != "pending" || attempt != 0 {
        return Err(Error::Runtime(rows::Error::Stale));
    }
    if stored_kind != kind(expected_kind)
        || next.as_deref() != expected_next
        || otherwise.as_deref() != expected_otherwise
        || position != size(index)?
    {
        return Err(Error::InvalidDefinition);
    }
    let input = value(conn, id, &input_ref, &run.input_digest, "run_input", "", 0)?;
    definition::validate_input(&checked, &input).map_err(|_| Error::Unavailable)?;
    let mut statement=conn.prepare("SELECT step_id,attempt_ordinal,output_ref,output_digest,kind FROM workflow_steps WHERE run_id=?1 AND state='succeeded' ORDER BY definition_ordinal LIMIT ?2").map_err(db)?;
    let recorded = statement
        .query_map(
            params![
                id,
                size(
                    definition::limits()
                        .steps
                        .checked_add(1)
                        .ok_or(Error::Unavailable)?
                )?
            ],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, String>(4)?,
                ))
            },
        )
        .map_err(db)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db)?;
    if recorded.len() > definition::limits().steps {
        return Err(Error::Unavailable);
    }
    let mut outputs = BTreeMap::new();
    for (step, attempt, reference, digest, stored_kind) in recorded {
        counter(attempt)?;
        let producer = checked
            .definition
            .steps
            .iter()
            .find(|candidate| candidate.step_id == step)
            .ok_or(Error::InvalidDefinition)?;
        if kind(contract(&producer.operation).0) != stored_kind {
            return Err(Error::InvalidDefinition);
        }
        if produces(&producer.operation) {
            let reference = reference.ok_or(Error::Unavailable)?;
            let digest = digest.ok_or(Error::Unavailable)?;
            outputs.insert(
                step.clone(),
                value(conn, id, &reference, &digest, "step_output", &step, attempt)?,
            );
        }
    }
    Ok(Plan::Pending(Snapshot {
        run,
        definition: checked.definition,
        step: index,
        step_revision: counter(revision)?,
        configuration,
        input,
        outputs,
    }))
}
pub(super) fn prepare(plan: &Snapshot) -> Result<Prepared, Error> {
    let context = mapping::Context::new(&plan.input, &plan.outputs).map_err(mapping_error)?;
    let (input, operation) = match &plan.definition.steps[plan.step].operation {
        Operation::Read {
            query,
            output_schema,
            next_step_id,
        } => {
            let query = mapping::evaluate(query, &context, None).map_err(mapping_error)?;
            let parsed: serde_json::Value =
                serde_json::from_str(&query).map_err(|_| Error::MappingInvalid)?;
            crate::vault::query::parse_request(&parsed).map_err(|_| Error::MappingInvalid)?;
            (
                query,
                OperationWork::Read {
                    schema: output_schema.get().into(),
                    next: next_step_id.clone(),
                },
            )
        }
        Operation::Transform {
            mapping,
            output_schema,
            next_step_id,
        } => {
            let output = mapping::evaluate(mapping, &context, Some(output_schema.get()))
                .map_err(mapping_error)?;
            (
                output.clone(),
                OperationWork::Local {
                    output,
                    next: Some(next_step_id.clone()),
                },
            )
        }
        Operation::Condition {
            predicate,
            if_true,
            if_false,
        } => {
            let answer = mapping::predicate(predicate, &context).map_err(mapping_error)?;
            let output = (if answer { "true" } else { "false" }).to_owned();
            (
                output.clone(),
                OperationWork::Local {
                    output,
                    next: Some((if answer { if_true } else { if_false }).clone()),
                },
            )
        }
        Operation::Action {
            action_id,
            definition_digest,
            connection_id,
            account_id,
            input,
            next_step_id: _,
        } => {
            let schema = workflow_requests::input_schema_for(action_id, definition_digest)
                .map_err(|_| Error::Unavailable)?;
            let input = mapping::evaluate(input, &context, Some(&schema)).map_err(mapping_error)?;
            (
                input,
                OperationWork::Action {
                    action: action_id.clone(),
                    definition: definition_digest.clone(),
                    connection: connection_id.clone(),
                    account: account_id.clone(),
                },
            )
        }
        Operation::Wait {
            until: WaitUntil::Timer { at },
            ..
        } => {
            let due = chrono::DateTime::parse_from_rfc3339(at)
                .map_err(|_| Error::InvalidDefinition)?
                .timestamp_millis();
            (
                serde_json::json!({"kind":"timer","at":at}).to_string(),
                OperationWork::Timer { due },
            )
        }
        Operation::Wait {
            until: WaitUntil::ExternalInput { schema, expires_at },
            ..
        } => {
            let expires = chrono::DateTime::parse_from_rfc3339(expires_at)
                .map_err(|_| Error::InvalidDefinition)?
                .timestamp_millis();
            let digest = schema::workflow_schema_digest(schema.get())
                .map_err(|_| Error::InvalidDefinition)?;
            (serde_json::json!({"kind":"external_input","schemaDigest":digest,"expiresAt":expires_at}).to_string(),OperationWork::External{schema:schema.get().into(),expires})
        }
        Operation::Result { output } => {
            let output = mapping::evaluate(output, &context, None).map_err(mapping_error)?;
            (output.clone(), OperationWork::Local { output, next: None })
        }
    };
    Ok(Prepared {
        snapshot: plan.clone(),
        input,
        operation,
    })
}
fn current(conn: &Connection, scope: rows::Scope<'_>, plan: &Snapshot) -> Result<(), Error> {
    let run = rows::inspect_rows(conn, scope, &plan.run.id)?;
    if run != plan.run || run.state != "queued" || run.cancel_requested {
        return Err(Error::Runtime(rows::Error::Stale));
    }
    let (revision,state,configuration):(i64,String,String)=conn.query_row("SELECT s.revision,s.state,r.configuration_digest FROM workflow_steps s JOIN workflow_runs r USING(run_id) WHERE s.run_id=?1 AND s.step_id=?2",params![run.id,plan.definition.steps[plan.step].step_id],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?))).map_err(db)?;
    if counter(revision)? != plan.step_revision
        || state != "pending"
        || configuration != plan.configuration
    {
        return Err(Error::Runtime(rows::Error::Stale));
    }
    Ok(())
}
pub(super) fn apply_rows(
    conn: &Connection,
    scope: rows::Scope<'_>,
    prepared: Prepared,
    snapshot: Option<ActionSnapshot<'_>>,
    process: &str,
    now: i64,
) -> Result<Applied, Error> {
    current(conn, scope, &prepared.snapshot)?;
    let action_selectors = if let OperationWork::Action {
        action,
        definition,
        connection,
        account,
    } = &prepared.operation
    {
        let snapshot = snapshot.ok_or(Error::Unavailable)?;
        if snapshot.configuration_digest != prepared.snapshot.configuration {
            return Err(Error::Runtime(rows::Error::Denied));
        }
        Some(Selectors {
            action_id: action.clone(),
            definition_digest: definition.clone(),
            connection_id: connection.clone(),
            account_id: account.clone(),
            snapshot_digest: snapshot.snapshot_digest.into(),
        })
    } else {
        if snapshot.is_some() {
            return Err(Error::InvalidInput);
        }
        None
    };
    let claim = rows::claim_rows(
        conn,
        scope,
        &prepared.snapshot.run.id,
        prepared.snapshot.run.revision,
        &prepared.input,
        process,
        now,
    )?;
    match prepared.operation {
        OperationWork::Read { schema, next } => Ok(Applied::Read(ReadWork {
            claim,
            query: prepared.input,
            version: prepared.snapshot.run.version,
            output_schema: schema,
            next,
        })),
        OperationWork::Local { output, next } => {
            rows::finish_rows(conn, scope, &claim, &output, next.as_deref(), now)
                .map(Applied::Advanced)
                .map_err(Error::from)
        }
        OperationWork::Timer { due } => {
            rows::park_rows(conn, scope, &claim, rows::WaitFor::Timer { due }, now)
                .map(Applied::Waiting)
                .map_err(Error::from)
        }
        OperationWork::External { schema, expires } => rows::park_rows(
            conn,
            scope,
            &claim,
            rows::WaitFor::ExternalInput {
                schema: &schema,
                expires,
            },
            now,
        )
        .map(Applied::Waiting)
        .map_err(Error::from),
        OperationWork::Action { .. } => {
            let request = workflow_requests::freeze(
                action_selectors.ok_or(Error::Unavailable)?,
                &prepared.input,
                &claim.request_key,
            )
            .map_err(|_| Error::InvalidInput)?;
            workflow_action_inputs::freeze_rows(
                conn,
                scope,
                &claim,
                &request,
                &prepared.snapshot.configuration,
            )?;
            Ok(Applied::Action(ActionWork { claim, request }))
        }
    }
}
pub(super) fn reject_rows(
    conn: &Connection,
    scope: rows::Scope<'_>,
    plan: &Snapshot,
    error: Error,
    now: i64,
) -> Result<rows::Run, Error> {
    current(conn, scope, plan)?;
    let reason = match error {
        Error::MissingStepOutput => "missing_step_output",
        Error::MappingInvalid => "mapping_invalid",
        Error::OutputLimit => "output_limit",
        _ => return Err(error),
    };
    rows::fail_pending_rows(
        conn,
        scope,
        &plan.run.id,
        plan.run.revision,
        (
            &plan.definition.steps[plan.step].step_id,
            plan.step_revision,
        ),
        reason,
        now,
    )
    .map_err(Error::from)
}
pub(super) fn settle_read_rows(
    conn: &Connection,
    scope: rows::Scope<'_>,
    work: &ReadWork,
    definition: &ValidatedDefinition,
    output: Result<&str, super::read::Error>,
    now: i64,
) -> Result<rows::Run, Error> {
    rows::check_claim_rows(conn, scope, &work.claim)?;
    let checked = checked(definition)?;
    let run = rows::inspect_rows(conn, scope, &work.claim.run)?;
    if checked.definition_hash != work.version || run.version != work.version {
        return Err(Error::InvalidDefinition);
    }
    let step = checked
        .definition
        .steps
        .iter()
        .find(|step| step.step_id == work.claim.step)
        .ok_or(Error::InvalidDefinition)?;
    let Operation::Read {
        output_schema,
        next_step_id,
        ..
    } = &step.operation
    else {
        return Err(Error::InvalidDefinition);
    };
    if output_schema.get() != work.output_schema || *next_step_id != work.next {
        return Err(Error::InvalidDefinition);
    }
    let output = match output {
        Ok(output) => output,
        Err(super::read::Error::OutputLimit) => {
            return rows::fail_rows(conn, scope, &work.claim, "output_limit", now)
                .map_err(Error::from)
        }
        Err(_) => {
            return rows::fail_rows(conn, scope, &work.claim, "read_unavailable", now)
                .map_err(Error::from)
        }
    };
    let canonical = match schema::workflow_canonical_json(
        output,
        definition::limits().step_output_bytes,
        definition::limits().json_depth,
    ) {
        Ok(value) => value,
        Err(error) => {
            return rows::fail_rows(
                conn,
                scope,
                &work.claim,
                if error.code == ActionErrorCode::LimitExceeded {
                    "output_limit"
                } else {
                    "invalid_output"
                },
                now,
            )
            .map_err(Error::from)
        }
    };
    if let Err(error) = schema::workflow_validate_input(&work.output_schema, &canonical) {
        return rows::fail_rows(
            conn,
            scope,
            &work.claim,
            if error.code == ActionErrorCode::LimitExceeded {
                "output_limit"
            } else {
                "invalid_output"
            },
            now,
        )
        .map_err(Error::from);
    }
    rows::finish_rows(conn, scope, &work.claim, &canonical, Some(&work.next), now)
        .map_err(Error::from)
}

// Comparison-only original work identity; no native authority is exposed.
impl Snapshot {
    pub(crate) fn run_id(&self) -> &str {
        &self.run.id
    }
}
impl Prepared {
    pub(crate) fn run_id(&self) -> &str {
        self.snapshot.run_id()
    }
}

#[cfg(test)]
#[path = "runner_tests.rs"]
mod tests;
