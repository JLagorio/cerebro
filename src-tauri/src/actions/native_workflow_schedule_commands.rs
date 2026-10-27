//! Authenticated native schedule doors. Wire context/permissions are selectors.
use super::{
    action_error, activation_service, commands, kernel, row_transaction, runtime_commands, views,
    worker::monitor, workflow_rows, WorkflowOpening,
};
use crate::{
    actions::SafeCounter,
    runtime::{workflow_activations as activation, workflows as flow},
    workflows::{native_definition::NativeDefinition, schedule, transport::*},
};
use std::sync::Arc;
use tauri::{AppHandle, WebviewWindow};
fn scope(opening: &WorkflowOpening) -> activation::Scope<'_> {
    let facts = opening.facts();
    activation::Scope {
        owner: facts.owner,
        vault: facts.vault,
        store: facts.store,
        canonical_vault: facts.canonical_vault,
    }
}
fn counter(value: u64) -> Result<SafeCounter, flow::Error> {
    SafeCounter::new(value).map_err(|_| flow::Error::Unavailable)
}
fn instant(value: i64) -> Result<SafeCounter, flow::Error> {
    counter(u64::try_from(value).map_err(|_| flow::Error::Unavailable)?)
}
fn optional_instant(value: Option<i64>) -> Result<Option<SafeCounter>, flow::Error> {
    value.map(instant).transpose()
}
fn state(value: &str) -> Result<WorkflowScheduleState, flow::Error> {
    match value {
        "enabled" => Ok(WorkflowScheduleState::Enabled),
        "paused" => Ok(WorkflowScheduleState::Paused),
        "removed" => Ok(WorkflowScheduleState::Removed),
        _ => Err(flow::Error::Unavailable),
    }
}
fn configuration(
    value: activation::Material,
) -> Result<WorkflowScheduleConfiguration, flow::Error> {
    let permissions = value
        .permissions
        .map(|bytes| {
            let parsed: workflow_rows::Permissions =
                serde_json::from_str(&bytes).map_err(|_| flow::Error::Unavailable)?;
            if workflow_rows::permission_bytes(&parsed)? != bytes {
                return Err(flow::Error::Unavailable);
            }
            views::permission_view(parsed)
        })
        .transpose()?;
    let row = value.current;
    Ok(WorkflowScheduleConfiguration {
        activation_id: row.id,
        version: WorkflowVersionRef {
            workflow_id: row.workflow,
            definition_hash: row.version,
        },
        state: state(&row.state)?,
        revision: counter(row.revision)?,
        epoch: row.epoch,
        configuration_digest: row.configuration,
        input_digest: row.input_digest,
        permission_digest: row.permission_digest,
        trigger_digest: row.trigger_digest,
        anchor_ms: instant(row.anchor_ms)?,
        cursor_ms: instant(row.cursor_ms)?,
        recovery_held: row.held,
        coverage_known: value.coverage_known,
        skipped_count: counter(value.skipped)?,
        coalesced_count: counter(value.coalesced)?,
        observed_at_ms: optional_instant(value.observed_at_ms)?,
        first_skipped_ms: optional_instant(value.first_skipped_ms)?,
        last_skipped_ms: optional_instant(value.last_skipped_ms)?,
        input_json: value.input,
        permissions,
    })
}
fn read<T>(
    app: &AppHandle,
    opening: &WorkflowOpening,
    operation: impl FnOnce(&rusqlite::Connection) -> Result<T, flow::Error>,
) -> Result<T, WorkflowError> {
    opening
        .guarded(app, |owner, _| {
            owner
                .read_snapshot(|read| Ok(operation(read.conn)))
                .map_err(|_| kernel::unavailable())?
                .map_err(action_error)
        })
        .map_err(commands::action)
}
fn known_ack(
    conn: &rusqlite::Connection,
    opening: &WorkflowOpening,
    changed: activation::Changed,
) -> Result<WorkflowScheduleAck, flow::Error> {
    let material = activation::material_rows(conn, scope(opening), &changed.current.workflow)?
        .ok_or(flow::Error::Unavailable)?;
    if material.current != changed.current {
        return Err(flow::Error::Stale);
    }
    let operation = match changed.receipt.operation.as_str() {
        "enable" => WorkflowScheduleOperation::Enable,
        "pause" => WorkflowScheduleOperation::Pause,
        "remove" => WorkflowScheduleOperation::Remove,
        _ => return Err(flow::Error::Unavailable),
    };
    let workflow_id = changed.current.workflow.clone();
    let receipt = WorkflowScheduleReceipt {
        operation,
        revision: counter(changed.receipt.revision)?,
        epoch: changed.receipt.epoch,
        state: state(&changed.receipt.state)?,
        version: WorkflowVersionRef {
            workflow_id: workflow_id.clone(),
            definition_hash: changed.receipt.version,
        },
    };
    Ok(WorkflowScheduleAck {
        context: commands::observed(opening),
        workflow_id,
        receipt,
        current: configuration(material)?,
        replayed: changed.replayed,
        monitoring: None,
    })
}
fn readiness(
    conn: &rusqlite::Connection,
    opening: &WorkflowOpening,
    current: &activation::Activation,
) -> WorkflowScheduleReadiness {
    if current.held {
        return WorkflowScheduleReadiness::RecoveryHeld;
    }
    match current.state.as_str() {
        "paused" => WorkflowScheduleReadiness::Paused,
        "removed" => WorkflowScheduleReadiness::Removed,
        "enabled" => {
            match monitor::preview_selected_rows(conn, opening, current, chrono::Utc::now()) {
                Ok(_) => WorkflowScheduleReadiness::Ready,
                Err(flow::Error::Denied) => WorkflowScheduleReadiness::NeedsAccess,
                Err(_) => WorkflowScheduleReadiness::Unavailable,
            }
        }
        _ => WorkflowScheduleReadiness::Unavailable,
    }
}
pub(crate) fn workflow_schedule(
    app: &AppHandle,
    window: &WebviewWindow,
    requested: WorkflowContext,
    workflow: String,
) -> Result<WorkflowScheduleView, WorkflowError> {
    let opening = commands::bound(app, window, &requested)?;
    let (configuration, readiness) =
        read(app, &opening, |conn| {
            match activation::material_rows(conn, scope(&opening), &workflow)? {
                Some(material) => {
                    let readiness = readiness(conn, &opening, &material.current);
                    Ok((Some(configuration(material)?), readiness))
                }
                None => Ok((None, WorkflowScheduleReadiness::Unconfigured)),
            }
        })?;
    // Process-book inspection is outside all original-opening/storage guards.
    let monitoring = monitor::state(&opening);
    opening.current(app).map_err(commands::action)?;
    Ok(WorkflowScheduleView {
        context: commands::observed(&opening),
        workflow_id: workflow,
        configuration,
        readiness,
        monitoring,
    })
}
pub(crate) fn workflow_schedule_enable(
    app: &AppHandle,
    window: &WebviewWindow,
    request: WorkflowScheduleEnableRequest,
) -> Result<WorkflowScheduleAck, WorkflowError> {
    let opening = commands::bound(app, window, &request.context)?;
    let permissions = runtime_commands::permissions(&request.permissions);
    let (result, current) = opening
        .guarded_rows(app, |owner, recheck| {
            let definition = NativeDefinition::load(
                &opening.root,
                &request.version.workflow_id,
                &request.version.definition_hash,
                &request.input_json,
            )
            .map_err(|error| {
                action_error(match error {
                    crate::workflows::native_definition::Error::InvalidInput => {
                        flow::Error::Invalid
                    }
                    _ => flow::Error::Unavailable,
                })
            })?;
            let directory = crate::workflows::publication::Directory::open_existing(
                &opening.root,
                &request.version.workflow_id,
            )
            .map_err(|error| action_error(super::publication_service::file_error(error)))?;
            let edit = directory
                .edit()
                .map_err(|error| action_error(super::publication_service::file_error(error)))?;
            activation_service::enable_published_owned(
                owner,
                opening.facts(),
                &edit,
                activation_service::Enable {
                    key: &request.request_key,
                    expected: request.expected_revision.get(),
                    definition: &definition,
                    permissions: &permissions,
                    now: chrono::Utc::now(),
                },
                || recheck().map_err(|_| flow::Error::Unavailable),
                |conn, changed| known_ack(conn, &opening, changed),
            )
            .map_err(action_error)
        })
        .map_err(commands::action)?;
    let mut ack = result.map_err(commands::action)?;
    // Known commit is preserved independently of later opening/queue installation.
    // Same-key replay stays observational even after Pause or another explicit epoch.
    if !ack.replayed {
        ack.monitoring = Some(if current {
            monitor::install_captured(app, opening)
        } else {
            WorkflowMonitoring::Unavailable
        });
    }
    Ok(ack)
}
fn change(
    app: &AppHandle,
    opening: Arc<WorkflowOpening>,
    request: WorkflowScheduleChangeRequest,
    remove: bool,
) -> Result<WorkflowScheduleAck, WorkflowError> {
    let (result, _current) = opening
        .guarded_rows(app, |owner, recheck| {
            row_transaction(
                owner,
                || recheck().map_err(|_| flow::Error::Unavailable),
                |conn| {
                    let changed = if remove {
                        activation::remove_rows(
                            conn,
                            scope(&opening),
                            &request.request_key,
                            &request.workflow_id,
                            request.expected_revision.get(),
                            chrono::Utc::now().timestamp_millis(),
                        )?
                    } else {
                        activation::pause_rows(
                            conn,
                            scope(&opening),
                            &request.request_key,
                            &request.workflow_id,
                            request.expected_revision.get(),
                            chrono::Utc::now().timestamp_millis(),
                        )?
                    };
                    known_ack(conn, &opening, changed)
                },
            )
            .map_err(action_error)
        })
        .map_err(commands::action)?;
    // Pause affects future occurrence admission only. Existing run/ACT/wait rows
    // and their original cancellation/settlement ownership remain untouched.
    result.map_err(commands::action)
}
pub(crate) fn workflow_schedule_pause(
    app: &AppHandle,
    window: &WebviewWindow,
    request: WorkflowScheduleChangeRequest,
) -> Result<WorkflowScheduleAck, WorkflowError> {
    let opening = commands::bound(app, window, &request.context)?;
    change(app, opening, request, false)
}
pub(crate) fn workflow_schedule_remove(
    app: &AppHandle,
    window: &WebviewWindow,
    request: WorkflowScheduleChangeRequest,
) -> Result<WorkflowScheduleAck, WorkflowError> {
    let opening = commands::bound(app, window, &request.context)?;
    change(app, opening, request, true)
}
pub(crate) fn workflow_schedule_preview(
    app: &AppHandle,
    window: &WebviewWindow,
    requested: WorkflowContext,
    workflow: String,
) -> Result<WorkflowSchedulePreview, WorkflowError> {
    let opening = commands::bound(app, window, &requested)?;
    read(app, &opening, |conn| {
        let material = activation::material_rows(conn, scope(&opening), &workflow)?
            .ok_or(flow::Error::Denied)?;
        let current = &material.current;
        let plan = if current.state == "enabled" && !current.held {
            monitor::preview_selected_rows(conn, &opening, current, chrono::Utc::now())?
        } else {
            let definition = NativeDefinition::load(
                &opening.root,
                &current.workflow,
                &current.version,
                material.input.as_deref().ok_or(flow::Error::Denied)?,
            )
            .map_err(|_| flow::Error::Unavailable)?;
            let (interval_seconds, catch_up) = definition.schedule().ok_or(flow::Error::Denied)?;
            schedule::evaluate(schedule::Request {
                anchor_ms: current.anchor_ms,
                cursor_ms: current.cursor_ms,
                now_ms: chrono::Utc::now().timestamp_millis(),
                interval_seconds,
                catch_up,
                observation: schedule::Observation::Unknown,
                enabled: current.state == "enabled",
                ready: false,
                recovery_held: current.held,
            })
            .map_err(|_| flow::Error::Unavailable)?
        };
        let disposition = match plan.disposition {
            schedule::Disposition::Idle => WorkflowScheduleDisposition::Idle,
            schedule::Disposition::Due => WorkflowScheduleDisposition::Due,
            schedule::Disposition::Paused => WorkflowScheduleDisposition::Paused,
            schedule::Disposition::NotReady => WorkflowScheduleDisposition::NotReady,
            schedule::Disposition::RecoveryHeld => WorkflowScheduleDisposition::RecoveryHeld,
            schedule::Disposition::ClockBackwards => WorkflowScheduleDisposition::ClockBackwards,
        };
        Ok(WorkflowSchedulePreview {
            context: commands::observed(&opening),
            workflow_id: workflow,
            revision: counter(current.revision)?,
            epoch: current.epoch.clone(),
            disposition,
            coverage_known: plan.coverage_known,
            due_at_ms: optional_instant(plan.due_ms)?,
            cursor_ms: instant(plan.cursor_ms)?,
            skipped_count: counter(plan.skipped)?,
            coalesced_count: counter(plan.coalesced)?,
        })
    })
}
