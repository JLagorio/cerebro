use super::*;
use std::{
    cell::Cell,
    sync::atomic::{AtomicBool, Ordering},
};

struct Fixture {
    root: PathBuf,
    context: AuthorityContext,
}
impl Fixture {
    fn new() -> Self {
        let root =
            fs::canonicalize(crate::vault::testutil::temp_vault("opening-output-gate")).unwrap();
        for name in ["config", "a", "b", "c", "output"] {
            fs::create_dir(root.join(name)).unwrap();
        }
        Self {
            context: AuthorityContext::new(root.join("config")),
            root,
        }
    }
    fn path(&self, name: &str) -> PathBuf {
        self.root.join(name)
    }
    fn choice(&self, parent: &str) -> NewDirectoryChoice {
        NewDirectoryChoice::new(&self.path(parent), "copy").unwrap()
    }
    fn publish(&self, name: &str) {
        let attempt = self.context.request_open(&self.path(name)).unwrap();
        crate::run_open_attempt(
            &self.context,
            &attempt,
            || {
                self.context
                    .publish_attempt_with(&attempt, || Ok(()))
                    .map_err(|e| e.message)
            },
            || Ok(()),
        )
        .unwrap();
    }
    fn reserve(&self, parent: &str) -> Result<OutputReservation, AuthorityError> {
        self.context
            .reserve_output(self.choice(parent), &[], || Ok(()))
            .map(|(lease, ())| lease)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn published_prior_and_requested_scopes_refuse_before_mkdir_while_public_root_is_none() {
    let f = Fixture::new();
    f.publish("a");
    let b = f.context.request_open(&f.path("b")).unwrap();
    assert!(f.context.active_root().unwrap().is_none());
    assert!(
        f.reserve("a").is_err(),
        "P2-02 prior watcher scope must survive invalidation"
    );
    assert!(
        f.reserve("b").is_err(),
        "P2-03 queued candidate must exclude output"
    );
    assert!(!f.path("a/copy").exists());
    assert!(!f.path("b/copy").exists());
    drop(f.reserve("output").unwrap());
    f.context.abandon_open(&b).unwrap();
    assert!(
        f.reserve("a").is_err(),
        "P2-12 failed open does not erase prior scope"
    );
}

#[test]
fn entered_scope_survives_newer_request_and_cleanup_is_inside_its_protection() {
    let f = Fixture::new();
    f.publish("a");
    let b = f.context.request_open(&f.path("b")).unwrap();
    let cleaned = Cell::new(false);
    let entered_denied = Cell::new(false);
    let cleanup_denied = Cell::new(false);
    let c = std::cell::RefCell::new(None);
    let result = crate::run_open_attempt(
        &f.context,
        &b,
        || {
            *c.borrow_mut() = Some(f.context.request_open(&f.path("c")).unwrap());
            entered_denied.set(f.reserve("b").is_err());
            Err::<(), _>("watcher start failed".into())
        },
        || {
            cleanup_denied.set(f.reserve("b").is_err());
            cleaned.set(true);
            Ok(())
        },
    );
    assert!(result.is_err());
    assert!(cleaned.get());
    assert!(
        entered_denied.get(),
        "P2-04 entered B is not replaced by queued C"
    );
    assert!(cleanup_denied.get(), "P2-13 cleanup must remain protected");
    drop(f.reserve("b").unwrap());
    assert!(
        f.reserve("c").is_err(),
        "P2-11 cleanup cannot clear a newer request"
    );
    assert!(f.reserve("a").is_err());
}

#[test]
fn failed_cleanup_retains_entered_scope_and_refuses_another_entry() {
    let f = Fixture::new();
    let b = f.context.request_open(&f.path("b")).unwrap();
    let result = crate::run_open_attempt(
        &f.context,
        &b,
        || Err::<(), _>("failed".into()),
        || Err("cleanup failed".into()),
    );
    assert!(result.is_err());
    assert!(f.reserve("b").is_err());
    let c = f.context.request_open(&f.path("c")).unwrap();
    let effect = Cell::new(false);
    assert!(crate::run_open_attempt(
        &f.context,
        &c,
        || {
            effect.set(true);
            Ok(())
        },
        || Ok(())
    )
    .is_err());
    assert!(!effect.get());
}

#[test]
fn output_wins_before_request_without_invalidating_active_or_agent_generation() {
    let f = Fixture::new();
    let agents = crate::agent::AgentState::default();
    let a = f.context.request_open(&f.path("a")).unwrap();
    agents.begin_open(a.generation()).unwrap();
    crate::run_open_attempt(
        &f.context,
        &a,
        || crate::finish_legacy_attempt(&f.context, &a, &agents, || {}).map_err(|e| e.message),
        || Ok(()),
    )
    .unwrap();
    let lease = f.reserve("output").unwrap();
    let generation = f.context.active.lock().unwrap().generation;
    assert!(f.context.request_open(&f.path("output")).is_err());
    assert!(f.context.request_open(&f.root).is_err());
    assert_eq!(f.context.active.lock().unwrap().generation, generation);
    assert_eq!(f.context.active_root().unwrap(), Some(f.path("a")));
    assert!(agents.prepare_run(&f.path("a")).is_ok());
    lease.validate().unwrap();
}

#[test]
fn stale_waiting_attempt_never_reaches_first_effect_and_agent_order_is_monotonic() {
    let f = Fixture::new();
    let agents = crate::agent::AgentState::default();
    let a = f.context.request_open(&f.path("a")).unwrap();
    let b = f.context.request_open(&f.path("b")).unwrap();
    agents.begin_open(b.generation()).unwrap();
    assert!(agents.begin_open(a.generation()).is_err());
    let effect = Cell::new(false);
    let cleanup_called = Cell::new(false);
    assert!(crate::run_open_attempt(
        &f.context,
        &a,
        || {
            effect.set(true);
            Ok(())
        },
        || {
            cleanup_called.set(true);
            Ok(())
        }
    )
    .is_err());
    assert!(!effect.get());
    assert!(
        !cleanup_called.get(),
        "unentered attempt must not cleanup another watcher"
    );
    crate::run_open_attempt(
        &f.context,
        &b,
        || crate::finish_legacy_attempt(&f.context, &b, &agents, || {}).map_err(|e| e.message),
        || Ok(()),
    )
    .unwrap();
    assert_eq!(f.context.active_root().unwrap(), Some(f.path("b")));
}

#[test]
fn reserved_output_allows_unrelated_switch_and_created_identity_is_protected_until_drop() {
    let f = Fixture::new();
    f.publish("a");
    let mut lease = f.reserve("output").unwrap();
    let output = lease.create_root().unwrap();
    output.validate().unwrap();
    f.publish("c");
    assert!(f.context.request_open(output.path()).is_err());
    assert!(f.context.request_open(&f.path("output")).is_err());
    lease.validate().unwrap();
    drop(output); // Source, final validator and every writer close before lease.
    assert!(f.context.request_open(&f.path("output")).is_err());
    drop(lease);
    f.publish("output");
}

#[test]
fn alias_and_renamed_parent_refuse_without_writing_a_replacement_tree() {
    let f = Fixture::new();
    let mut lease = f.reserve("output").unwrap();
    std::os::unix::fs::symlink(f.path("output"), f.path("alias")).unwrap();
    assert!(f.context.request_open(&f.path("alias")).is_err());
    fs::rename(f.path("output"), f.path("moved")).unwrap();
    fs::create_dir(f.path("output")).unwrap();
    assert!(lease.create_root().is_err());
    assert!(!f.path("output/copy").exists());
    assert!(!f.path("moved/copy").exists());
    assert!(f.context.request_open(&f.path("moved")).is_err());
}

#[test]
fn present_leaf_cannot_be_overwritten_and_single_output_slot_is_not_replaced() {
    let f = Fixture::new();
    let mut lease = f.reserve("output").unwrap();
    assert!(f.reserve("b").is_err());
    fs::write(f.path("output/copy"), b"foreign sentinel").unwrap();
    assert!(lease.create_root().is_err());
    assert_eq!(
        fs::read(f.path("output/copy")).unwrap(),
        b"foreign sentinel"
    );
}

#[test]
fn publication_rechecks_p1_and_failure_cleanup_precedes_entry_release() {
    let f = Fixture::new();
    let b = f.context.request_open(&f.path("b")).unwrap();
    let bound = Cell::new(false);
    let cleaned = Cell::new(false);
    let result = crate::run_open_attempt(
        &f.context,
        &b,
        || {
            fs::create_dir_all(f.path("b/nested/.cerebro")).unwrap();
            fs::write(
                f.path("b/nested/.cerebro/workspace-format.json"),
                br#"{"format":2,"state":"preparing"}"#,
            )
            .unwrap();
            f.context
                .publish_attempt_with(&b, || {
                    bound.set(true);
                    Ok(())
                })
                .map_err(|e| e.message)
        },
        || {
            cleaned.set(true);
            Ok(())
        },
    );
    assert!(result.is_err());
    assert!(!bound.get());
    assert!(cleaned.get());
    assert!(f.context.active_root().unwrap().is_none());
}

#[test]
fn unrelated_open_does_not_wait_for_copy_resources_and_admission_is_single_consumption() {
    let f = Fixture::new();
    let admitted = AtomicBool::new(false);
    let (mut lease, ()) = f
        .context
        .reserve_output(f.choice("output"), &[], || {
            assert!(!admitted.swap(true, Ordering::SeqCst));
            Ok(())
        })
        .unwrap();
    let output = lease.create_root().unwrap();
    std::thread::scope(|scope| {
        let done = scope.spawn(|| {
            f.publish("c");
        });
        done.join().unwrap(); // no sleep: this would deadlock if copy held ActiveRoot/OPEN_LOCK
    });
    lease.validate().unwrap();
    assert!(lease.create_root().is_err());
    drop(output);
    drop(lease);
}

#[cfg(target_os = "macos")]
fn mark_selected(f: &Fixture) {
    use std::os::unix::fs::PermissionsExt;
    let id = "3ee5b6eb-9f80-4bac-9538-f2a0c5938a62";
    fs::create_dir_all(f.path("config/workspaces").join(id)).unwrap();
    fs::write(
        f.path("config/workspaces/bindings.v1.json"),
        serde_json::json!({"version":1,"bindings":[{"workspaceId":id,"bodyRoot":f.path("a")}] })
            .to_string(),
    )
    .unwrap();
    fs::set_permissions(
        f.path("config/workspaces/bindings.v1.json"),
        fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    fs::create_dir_all(f.path("a/.cerebro")).unwrap();
    fs::write(f.path("a/.cerebro/workspace-format.json"), serde_json::json!({"format":2,"authority":"sqlite_metadata","state":"activated","workspaceId":id}).to_string()).unwrap();
    // Passive capture must not open SQLite, so a non-SQLite sentinel suffices.
    fs::write(
        f.path("config/workspaces").join(id).join("workspace.db"),
        b"no SQLite opened during capture",
    )
    .unwrap();
}

#[cfg(target_os = "macos")]
#[test]
fn selected_ticket_rejects_same_path_reopen_and_retired_window_before_first_write() {
    let f = Fixture::new();
    mark_selected(&f);
    f.publish("a");
    let ticket = f
        .context
        .capture_selected_backup_opening(&f.path("a"))
        .unwrap();
    f.publish("a");
    assert!(f
        .context
        .reserve_selected_output(ticket, f.choice("output"), || Ok(()))
        .is_err());
    assert!(!f.path("output/copy").exists());
    let ticket = f
        .context
        .capture_selected_backup_opening(&f.path("a"))
        .unwrap();
    assert!(f
        .context
        .reserve_selected_output(ticket, f.choice("output"), || Err(unavailable()))
        .is_err());
    drop(f.reserve("output").unwrap());
}

#[cfg(target_os = "macos")]
#[test]
fn admitted_selected_source_retains_original_binding_across_unrelated_switch() {
    let f = Fixture::new();
    mark_selected(&f);
    f.publish("a");
    let ticket = f
        .context
        .capture_selected_backup_opening(&f.path("a"))
        .unwrap();
    let (lease, source) = f
        .context
        .reserve_selected_output(ticket, f.choice("output"), || Ok(()))
        .unwrap();
    f.publish("c");
    assert_eq!(source.root(), f.path("a"));
    source
        .validate_binding(&resolve_with(&f.context, source.root()).unwrap().unwrap())
        .unwrap();
    lease.validate().unwrap();
}

#[test]
fn output_reserved_after_tree_observation_is_compared_at_request_gate() {
    let f = std::sync::Arc::new(Fixture::new());
    f.publish("a");
    let held = std::sync::Arc::new(Mutex::new(None));
    let hook_fixture = f.clone();
    let hook_held = held.clone();
    REQUEST_OBSERVED.with(|slot| {
        *slot.borrow_mut() = Some(Box::new(move || {
            *hook_held.lock().unwrap() = Some(hook_fixture.reserve("output").unwrap());
        }))
    });
    assert!(f.context.request_open(&f.path("output")).is_err());
    assert_eq!(f.context.active_root().unwrap(), Some(f.path("a")));
    assert!(!f.path("output/copy").exists());
    drop(held.lock().unwrap().take());
}

#[test]
fn installed_metadata_namespace_is_excluded_even_with_no_published_workspace() {
    let f = Fixture::new();
    assert!(f
        .context
        .reserve_output(f.choice("config"), &[], || Ok(()))
        .is_ok());
    fs::create_dir_all(f.path("config/workspaces")).unwrap();
    let choice = NewDirectoryChoice::new(&f.path("config/workspaces"), "copy").unwrap();
    assert!(f.context.reserve_output(choice, &[], || Ok(())).is_err());
    assert!(!f.path("config/workspaces/copy").exists());
}

#[test]
fn synchronous_preparation_writer_settles_before_superseding_open_enters() {
    let f = Fixture::new();
    let b = f.context.request_open(&f.path("b")).unwrap();
    let writing = AtomicBool::new(false);
    let (entered_tx, entered_rx) = std::sync::mpsc::sync_channel(0);
    let (release_tx, release_rx) = std::sync::mpsc::sync_channel(0);
    std::thread::scope(|threads| {
        let fixture = &f;
        let writer = &writing;
        let first = threads.spawn(move || {
            let f = fixture;
            let writing = writer;
            crate::run_open_attempt(
                &f.context,
                &b,
                || {
                    writing.store(true, Ordering::SeqCst);
                    entered_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                    fs::write(f.path("b/purge-finished"), b"finished").unwrap();
                    writing.store(false, Ordering::SeqCst);
                    f.context
                        .publish_attempt_with(&b, || Ok(()))
                        .map_err(|e| e.message)
                },
                || {
                    assert!(!writing.load(Ordering::SeqCst));
                    assert!(f.reserve("b").is_err());
                    Ok(())
                },
            )
        });
        entered_rx.recv().unwrap();
        let c = f.context.request_open(&f.path("c")).unwrap();
        assert!(f.reserve("b").is_err());
        let second = threads.spawn(move || {
            let f = fixture;
            let writing = writer;
            crate::run_open_attempt(
                &f.context,
                &c,
                || {
                    assert!(!writing.load(Ordering::SeqCst));
                    assert_eq!(fs::read(f.path("b/purge-finished")).unwrap(), b"finished");
                    f.context
                        .publish_attempt_with(&c, || Ok(()))
                        .map_err(|e| e.message)
                },
                || Ok(()),
            )
        });
        release_tx.send(()).unwrap();
        assert!(first.join().unwrap().is_err());
        second.join().unwrap().unwrap();
    });
    drop(f.reserve("b").unwrap());
}

#[test]
fn alias_retarget_after_observation_refuses_before_opening_or_agent_invalidation() {
    let f = std::sync::Arc::new(Fixture::new());
    f.publish("a");
    std::os::unix::fs::symlink(f.path("c"), f.path("b/alias")).unwrap();
    let held = std::sync::Arc::new(Mutex::new(None));
    let hook_fixture = f.clone();
    let hook_held = held.clone();
    let generation = f.context.active.lock().unwrap().generation;
    REQUEST_OBSERVED.with(|slot| {
        *slot.borrow_mut() = Some(Box::new(move || {
            *hook_held.lock().unwrap() = Some(hook_fixture.reserve("output").unwrap());
            fs::remove_file(hook_fixture.path("b/alias")).unwrap();
            std::os::unix::fs::symlink(hook_fixture.path("output"), hook_fixture.path("b/alias"))
                .unwrap();
        }))
    });
    let result = f.context.request_open(&f.path("b"));
    // Release owned fixtures before asserting so failure cannot strand cleanup.
    drop(held.lock().unwrap().take());
    assert!(
        result.is_err(),
        "P1 alias evidence must be revalidated at request gate"
    );
    assert_eq!(f.context.active.lock().unwrap().generation, generation);
    assert_eq!(f.context.active_root().unwrap(), Some(f.path("a")));
}

#[test]
fn ordinary_preparation_membership_changes_do_not_pin_an_obsolete_snapshot_epoch() {
    let f = Fixture::new();
    let attempt = f.context.request_open(&f.path("b")).unwrap();
    crate::run_open_attempt(
        &f.context,
        &attempt,
        || {
            fs::create_dir_all(f.path("b/.trash/new-item")).unwrap();
            fs::write(
                f.path("b/page.md"),
                b"ordinary acknowledged body/recovery write",
            )
            .unwrap();
            f.context
                .publish_attempt_with(&attempt, || Ok(()))
                .map_err(|error| error.message)
        },
        || Ok(()),
    )
    .unwrap();
    fs::write(
        f.path("b/another.md"),
        b"ordinary content after publication",
    )
    .unwrap();
    drop(f.reserve("output").unwrap());
    assert!(f.reserve("b").is_err());
}
#[test]
fn reserve_recaptures_new_aliases_without_requiring_old_directory_mtime() {
    let f = Fixture::new();
    f.publish("b");
    std::os::unix::fs::symlink(f.path("output"), f.path("b/new-alias")).unwrap();
    assert!(
        f.reserve("output").is_err(),
        "current published route reaches output parent"
    );
    assert!(!f.path("output/copy").exists());
}

#[test]
fn actual_opening_completion_callback_observes_no_open_lock() {
    let f = Fixture::new();
    let attempt = f.context.request_open(&f.path("b")).unwrap();
    let available = Cell::new(false);
    crate::run_open_attempt_then(
        &f.context,
        &attempt,
        || {
            f.context
                .publish_attempt_with(&attempt, || Ok(()))
                .map_err(|error| error.message)
        },
        || Ok(()),
        |_| {
            available.set(crate::OPEN_LOCK.try_lock().is_ok());
            Ok(())
        },
    )
    .unwrap();
    assert!(
        available.get(),
        "native observation callback must run outside OPEN_LOCK"
    );
}
#[test]
fn native_binding_cannot_recapture_a_fresh_same_path_opening() {
    let f = Fixture::new();
    let original = f.context.request_open(&f.path("b")).unwrap();
    crate::run_open_attempt(
        &f.context,
        &original,
        || {
            f.context
                .publish_attempt_with(&original, || Ok(()))
                .map_err(|error| error.message)
        },
        || Ok(()),
    )
    .unwrap();
    f.publish("b");
    let bound = Cell::new(false);
    let result = f
        .context
        .with_published_legacy_attempt(&original, &f.path("b"), || bound.set(true));
    assert!(result.is_err());
    assert!(!bound.get());
}

#[test]
fn output_progress_poison_preserves_created_fact_but_never_verifies_location() {
    let f = Fixture::new();
    let mut lease = f.reserve("output").unwrap();
    let output = lease.create_root().unwrap();
    let observer = lease.progress();
    let footprint = lease.footprint.clone();
    let result = std::thread::spawn(move || {
        let _held = footprint.lock().unwrap();
        panic!("synthetic progress-anchor poison");
    })
    .join();
    assert!(result.is_err());
    drop(output);
    drop(lease);
    let facts = observer.snapshot();
    assert_eq!(
        facts.phase,
        crate::workspace_migration::backup::OutputPhase::Created
    );
    assert_eq!(facts.location, OutputLocation::Unavailable);
}

#[cfg(target_os = "macos")]
#[test]
fn borrowed_selected_ticket_recheck_accepts_original_without_consuming_it() {
    let f = Fixture::new();
    mark_selected(&f);
    f.publish("a");
    let ticket = f
        .context
        .capture_selected_backup_opening(&f.path("a"))
        .unwrap();
    f.context.validate_selected_backup_opening(&ticket).unwrap();
    f.context.validate_selected_backup_opening(&ticket).unwrap();
    let (lease, source) = f
        .context
        .reserve_selected_output(ticket, f.choice("output"), || Ok(()))
        .unwrap();
    assert_eq!(source.root(), f.path("a"));
    drop(source);
    drop(lease);
    assert!(!f.path("output/copy").exists());
}
#[cfg(target_os = "macos")]
#[test]
fn borrowed_selected_ticket_recheck_refuses_same_path_reopen_before_pending_review() {
    let f = Fixture::new();
    mark_selected(&f);
    f.publish("a");
    let ticket = f
        .context
        .capture_selected_backup_opening(&f.path("a"))
        .unwrap();
    f.publish("a");
    assert!(f.context.validate_selected_backup_opening(&ticket).is_err());
    assert!(!f.path("output/copy").exists());
}

#[test]
fn legacy_ticket_same_opening_comparison_deduplicates_actual_captures_only() {
    let f = Fixture::new();
    f.publish("a");
    let (_, first) = f.context.capture_current_legacy_opening().unwrap();
    let other = f
        .context
        .clone()
        .capture_legacy_opening(&f.path("a"))
        .unwrap();
    assert!(first.same_as(&other));
    assert!(other.same_as(&first));
    f.publish("b");
    assert!(
        first.same_as(&other),
        "historical identity comparison is not current access"
    );
    assert!(f.context.with_legacy_opening(&first, || ()).is_err());
}
#[test]
fn legacy_ticket_same_path_after_reopening_is_a_distinct_original_ticket() {
    let f = Fixture::new();
    f.publish("a");
    let (_, first) = f.context.capture_current_legacy_opening().unwrap();
    f.publish("a");
    let (_, second) = f.context.capture_current_legacy_opening().unwrap();
    assert!(!first.same_as(&second));
    assert!(!second.same_as(&first));
    assert!(f.context.with_legacy_opening(&first, || ()).is_err());
    assert!(f.context.with_legacy_opening(&second, || ()).is_ok());
}
#[test]
fn legacy_ticket_same_path_and_generation_in_another_context_are_distinct() {
    let f = Fixture::new();
    f.publish("a");
    let (_, first) = f.context.capture_current_legacy_opening().unwrap();
    let second_context = AuthorityContext::new(f.path("config"));
    let attempt = second_context.request_open(&f.path("a")).unwrap();
    crate::run_open_attempt(
        &second_context,
        &attempt,
        || {
            second_context
                .publish_attempt_with(&attempt, || Ok(()))
                .map_err(|e| e.message)
        },
        || Ok(()),
    )
    .unwrap();
    let (_, second) = second_context.capture_current_legacy_opening().unwrap();
    assert!(!first.same_as(&second));
    assert!(!second.same_as(&first));
    assert!(f.context.with_legacy_opening(&second, || ()).is_err());
}
