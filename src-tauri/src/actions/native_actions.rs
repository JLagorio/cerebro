//! Retained native ACT transaction/physical-lease bridge.
//! No path service, native proof factory, command, provider or IPC activation.
#![cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "guarded native operations are composed after retained row-owner verification"
    )
)]
use super::{NativeOwnerError, RuntimeOwner};
use crate::actions::{effect_kernel, effect_types::*};
use rusqlite::Connection;
fn action_transaction<T>(
    owner: &mut RuntimeOwner,
    operation: impl FnOnce(&Connection) -> Result<T, ActionError>,
) -> Result<T, ActionError> {
    let mut domain_error = None;
    let outcome = owner.classified_transaction(|conn| {
        operation(conn).map_err(|error| {
            domain_error = Some(error);
            NativeOwnerError::Unavailable
        })
    });
    match outcome {
        super::RuntimeTransactionOutcome::Committed(value) => Ok(value),
        super::RuntimeTransactionOutcome::NotCommitted(_) => Err(if owner.retired {
            effect_kernel::unavailable()
        } else {
            domain_error.unwrap_or_else(effect_kernel::unavailable)
        }),
        super::RuntimeTransactionOutcome::CommitUncertain => Err(effect_kernel::unavailable()),
    }
}
impl RuntimeOwner {
    fn action_submission_owner(
        &mut self,
        id: &InvocationId,
    ) -> Result<Option<crate::runtime::action_invocations::SubmissionOwner>, NativeOwnerError> {
        if !self.conn.is_autocommit() {
            return Err(NativeOwnerError::Unavailable);
        }
        self.validate()?;
        let directory = self.data_dir.clone();
        let identity = self.identity;
        let parent_identity = self.directory_identity;
        let outcome = self.classified_transaction(|conn| {
            crate::runtime::action_invocations::try_retained_submission_owner(
                conn,
                &directory,
                identity,
                parent_identity,
                &id.0,
            )
            .map_err(|_| NativeOwnerError::Unavailable)
        });
        let result = match outcome {
            super::RuntimeTransactionOutcome::Committed(lease) => Ok(lease),
            super::RuntimeTransactionOutcome::NotCommitted(error) => Err(error),
            super::RuntimeTransactionOutcome::CommitUncertain => Err(NativeOwnerError::Unavailable),
        };
        self.validate()?;
        if let Ok(Some(lease)) = &result {
            if !lease.matches_retained(&id.0, self.identity) {
                return Err(NativeOwnerError::Unavailable);
            }
        }
        result
    }
}
#[cfg(all(test, target_os = "macos"))]
#[path = "native_actions_tests.rs"]
mod tests;

#[path = "native_action_cancellation.rs"]
pub(super) mod cancellation;

#[path = "native_action_operations.rs"]
pub(super) mod operations;

#[path = "native_action_semantics.rs"]
pub(super) mod semantics;
