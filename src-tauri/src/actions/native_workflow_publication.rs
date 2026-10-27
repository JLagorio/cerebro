//! One retained runtime plus the actual retained file edit; no origin constructor.
use super::{workflow_rows, RuntimeOwner};
use crate::{
    runtime::{workflow_activations as activation, workflows as flow},
    workflows::publication,
};

/// Finite original acknowledgement, distinct from the publication currently
/// selected by a later writer. The native/UI consumer must preserve that split.
pub(in crate::actions::native_owner) struct Completed {
    pub(in crate::actions::native_owner) value: publication::Unpublished,
    pub(in crate::actions::native_owner) replayed: bool,
}
pub(in crate::actions::native_owner) fn file_error(error: publication::Error) -> flow::Error {
    match error {
        publication::Error::Conflict => flow::Error::Conflict,
        publication::Error::InvalidPath | publication::Error::InvalidJson => flow::Error::Invalid,
        publication::Error::LimitExceeded => flow::Error::Capacity,
        // Busy, descriptor loss, unsupported file state and postrename
        // uncertainty all leave the original request pending for observation.
        _ => flow::Error::Unavailable,
    }
}
fn scope(facts: workflow_rows::OpeningFacts<'_>) -> activation::Scope<'_> {
    activation::Scope {
        owner: facts.owner,
        vault: facts.vault,
        store: facts.store,
        canonical_vault: facts.canonical_vault,
    }
}
fn same_transition(
    transition: &activation::PublicationTransition,
    original: &publication::Reference,
) -> bool {
    transition.workflow == original.workflow_id
        && transition.expected_revision == original.revision
        && transition.expected_hash == original.definition_hash
}

pub(in crate::actions::native_owner) fn unpublish_owned(
    owner: &mut RuntimeOwner,
    facts: workflow_rows::OpeningFacts<'_>,
    edit: &publication::Edit<'_>,
    original: &publication::Reference,
    key: &str,
    now: i64,
    recheck: impl Fn() -> Result<(), flow::Error>,
) -> Result<publication::Unpublished, flow::Error> {
    complete_owned(owner, facts, edit, original, key, now, recheck).map(|completed| completed.value)
}

pub(in crate::actions::native_owner) fn complete_owned(
    owner: &mut RuntimeOwner,
    facts: workflow_rows::OpeningFacts<'_>,
    edit: &publication::Edit<'_>,
    original: &publication::Reference,
    key: &str,
    now: i64,
    recheck: impl Fn() -> Result<(), flow::Error>,
) -> Result<Completed, flow::Error> {
    recheck()?;
    if edit.root().to_str() != Some(facts.canonical_vault) {
        return Err(flow::Error::Denied);
    }
    if original.revision == 0 {
        return Err(flow::Error::Invalid);
    }
    let revision = crate::actions::SafeCounter::new(original.revision)
        .and_then(|value| value.next())
        .map_err(|_| flow::Error::Capacity)?
        .get();
    let expected = publication::Unpublished {
        previous: original.clone(),
        revision,
        transition_id: key.into(),
    };
    // File validation occurs outside SQLite. The genuine native caller retains
    // its opening/storage guard, while edit retains the same file descriptors.
    let file = edit.read().map_err(file_error)?;
    let recorded = owner
        .read_snapshot(|read| {
            Ok((|| {
                recheck()?;
                let recorded =
                    activation::publication_transition_rows(read.conn, scope(facts), key)?;
                recheck()?;
                Ok::<_, flow::Error>(recorded)
            })())
        })
        .map_err(|_| flow::Error::Unavailable)??;
    let replayed = recorded.is_some();
    if let Some(recorded) = &recorded {
        if !same_transition(recorded, original) {
            return Err(flow::Error::Conflict);
        }
        if recorded.phase == "reconciled" {
            // This is a historical committed result, not adoption/clearing of
            // the file currently selected. Never pause a later explicit Enable.
            #[cfg(test)]
            stage(Stage::Reconciled);
            return Ok(Completed {
                value: expected,
                replayed: true,
            });
        }
    }
    let original_live = file.publication.as_ref() == Some(original);
    let matching_tombstone = file.unpublished.as_ref() == Some(&expected);
    if !original_live && !matching_tombstone {
        return Err(flow::Error::Conflict);
    }
    if matching_tombstone && recorded.is_none() {
        return Err(flow::Error::Denied);
    }
    if original_live
        && recorded
            .as_ref()
            .is_some_and(|value| value.phase == "pointer_cleared")
    {
        return Err(flow::Error::Conflict);
    }
    let transition = super::row_transaction(owner, &recheck, |conn| {
        activation::prepare_unpublish_rows(
            conn,
            scope(facts),
            key,
            &original.workflow_id,
            original.revision,
            &original.definition_hash,
            now,
        )
    })?;
    if transition.phase == "reconciled" {
        #[cfg(test)]
        stage(Stage::Reconciled);
        return Ok(Completed {
            value: expected,
            replayed: true,
        });
    }
    if transition.phase == "pointer_cleared" && !matching_tombstone {
        return Err(flow::Error::Conflict);
    }
    #[cfg(test)]
    stage(Stage::Prepared);
    // No file mutation is reachable after a lost prepare acknowledgement.
    recheck()?;
    owner.validate().map_err(|_| flow::Error::Unavailable)?;
    let cleared = edit.unpublish(original, key).map_err(file_error)?;
    if cleared != expected {
        return Err(flow::Error::Conflict);
    }
    #[cfg(test)]
    stage(Stage::Cleared);
    recheck()?;
    let observed = edit.read().map_err(file_error)?;
    if observed.unpublished.as_ref() != Some(&cleared)
        || observed.publication.is_some()
        || observed.revision != cleared.revision
    {
        return Err(flow::Error::Conflict);
    }
    // A separate known commit removes the hold only after the actual same-file
    // tombstone was observed. This transaction performs SQL and original checks,
    // never file publication I/O; the retained edit excludes another publisher.
    super::row_transaction(owner, &recheck, |conn| {
        let observed = activation::pointer_cleared_rows(
            conn,
            scope(facts),
            &transition,
            cleared.revision,
            now,
        )?;
        activation::reconcile_unpublish_rows(conn, scope(facts), &observed, now)
    })?;
    #[cfg(test)]
    stage(Stage::Reconciled);
    // A later current-opening failure cannot erase this known final commit.
    Ok(Completed {
        value: cleared,
        replayed,
    })
}

// Test-only interruption observations at known boundaries. No fake file writer,
// RuntimeOwner, opening or execution authority is supplied by these hooks.
#[cfg(test)]
#[derive(Clone, Copy, PartialEq, Eq)]
pub(in crate::actions::native_owner) enum Stage {
    Prepared,
    Cleared,
    Reconciled,
}
#[cfg(test)]
type StageHook = Box<dyn FnMut(Stage)>;
#[cfg(test)]
thread_local! {
    static STAGE_HOOK: std::cell::RefCell<Option<StageHook>> = const { std::cell::RefCell::new(None) };
}
#[cfg(test)]
fn stage(point: Stage) {
    STAGE_HOOK.with(|slot| {
        if let Some(hook) = slot.borrow_mut().as_mut() {
            hook(point);
        }
    });
}
#[cfg(test)]
pub(in crate::actions::native_owner) fn with_stage_hook<T>(
    hook: impl FnMut(Stage) + 'static,
    work: impl FnOnce() -> T,
) -> T {
    struct Reset(Option<Box<dyn FnMut(Stage)>>);
    impl Drop for Reset {
        fn drop(&mut self) {
            STAGE_HOOK.with(|slot| *slot.borrow_mut() = self.0.take());
        }
    }
    let _reset = Reset(STAGE_HOOK.with(|slot| slot.replace(Some(Box::new(hook)))));
    work()
}

#[derive(Debug, PartialEq, Eq)]
pub(in crate::actions::native_owner) struct RecoveredPage {
    pub(in crate::actions::native_owner) reconciled: usize,
    pub(in crate::actions::native_owner) next: Option<String>,
}

/// Requires the caller's genuine original opening/storage guard. The page is
/// independent of enabled selections because prepare deliberately pauses them.
pub(in crate::actions::native_owner) fn recover_pending_owned(
    owner: &mut RuntimeOwner,
    facts: workflow_rows::OpeningFacts<'_>,
    root: &std::path::Path,
    after: Option<&str>,
    now: i64,
    recheck: impl Fn() -> Result<(), flow::Error>,
) -> Result<RecoveredPage, flow::Error> {
    recheck()?;
    if root.to_str() != Some(facts.canonical_vault) {
        return Err(flow::Error::Denied);
    }
    let page = owner
        .read_snapshot(|read| {
            Ok((|| {
                recheck()?;
                let page = activation::pending_publications_rows(read.conn, scope(facts), after)?;
                recheck()?;
                Ok::<_, flow::Error>(page)
            })())
        })
        .map_err(|_| flow::Error::Unavailable)??;
    let mut reconciled = 0;
    for transition in page.items {
        recheck()?;
        // No SQL transaction spans opening the original descriptor or publishing.
        let directory = publication::Directory::open_existing(root, &transition.workflow)
            .map_err(file_error)?;
        let edit = directory.edit().map_err(file_error)?;
        recover_transition_owned(owner, facts, &edit, &transition, now, &recheck)?;
        reconciled += 1;
    }
    Ok(RecoveredPage {
        reconciled,
        next: page.next,
    })
}

/// Publish must use this exact workflow lookup before its existing file CAS.
pub(in crate::actions::native_owner) fn recover_workflow_owned(
    owner: &mut RuntimeOwner,
    facts: workflow_rows::OpeningFacts<'_>,
    edit: &publication::Edit<'_>,
    workflow: &str,
    now: i64,
    recheck: impl Fn() -> Result<(), flow::Error>,
) -> Result<bool, flow::Error> {
    recheck()?;
    if edit.root().to_str() != Some(facts.canonical_vault) {
        return Err(flow::Error::Denied);
    }
    let pending = owner
        .read_snapshot(|read| {
            Ok((|| {
                recheck()?;
                let pending =
                    activation::pending_publication_for_rows(read.conn, scope(facts), workflow)?;
                recheck()?;
                Ok::<_, flow::Error>(pending)
            })())
        })
        .map_err(|_| flow::Error::Unavailable)??;
    let Some(pending) = pending else {
        return Ok(false);
    };
    recover_transition_owned(owner, facts, edit, &pending, now, &recheck)?;
    Ok(true)
}

fn recover_transition_owned(
    owner: &mut RuntimeOwner,
    facts: workflow_rows::OpeningFacts<'_>,
    edit: &publication::Edit<'_>,
    transition: &activation::PublicationTransition,
    now: i64,
    recheck: &impl Fn() -> Result<(), flow::Error>,
) -> Result<(), flow::Error> {
    let original = publication::Reference {
        workflow_id: transition.workflow.clone(),
        definition_hash: transition.expected_hash.clone(),
        revision: transition.expected_revision,
    };
    // These SELECT-derived fields are comparison data. The sole coordinator
    // reloads the original journal and verifies the actual file before mutation.
    complete_owned(owner, facts, edit, &original, &transition.id, now, recheck)?;
    Ok(())
}
