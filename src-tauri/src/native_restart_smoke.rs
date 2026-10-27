//! Native-feature-only fixed R0 roles. Metadata never reconstructs authority.
use super::*;
use serde_json::{json, Value};
#[path = "native_restart_audit.rs"]
pub(crate) mod audit;
pub(crate) use audit::note;
#[path = "native_restart_r1.rs"]
mod r1;
pub(crate) use r1::validate_reopen as validate_reopen_r1;
#[path = "native_restart_r2.rs"]
mod r2;
pub(crate) use r2::validate_reopen as validate_reopen_r2;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Role {
    None,
    Prepare,
    Verify,
    VerifyR1,
    PrepareR2,
    VerifyR2,
}
pub(crate) fn exit_rejected() -> ! {
    unsafe { libc::_exit(90) }
}
pub(crate) fn watchdog(seconds: u64) {
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(seconds));
        unsafe { libc::_exit(92) }
    });
}
pub(crate) fn active(app: &AppHandle) -> bool {
    app.try_state::<SmokePaths>()
        .is_some_and(|p| p.restart != Role::None)
}
fn bounded_json(path: &Path, cap: u64) -> Result<Value, &'static str> {
    settings_identity(path, false)?;
    let mut f = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(|_| "r0-json-open")?;
    let mut bytes = Vec::new();
    Read::by_ref(&mut f)
        .take(cap + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "r0-json-read")?;
    if bytes.len() as u64 > cap {
        return Err("r0-json-cap");
    }
    serde_json::from_slice(&bytes).map_err(|_| "r0-json-decode")
}
fn save(root: &Path, name: &str, value: &Value) -> Result<(), &'static str> {
    let bytes = serde_json::to_vec_pretty(value).map_err(|_| "r0-json-encode")?;
    if bytes.len() > 8192 {
        return Err("r0-audit-cap");
    }
    create(&root.join(name), &bytes).map_err(|_| "r0-audit-create")
}
fn digest(path: &Path) -> Result<String, &'static str> {
    settings_identity(path, false)?;
    let mut f = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(|_| "r0-hash-open")?;
    let mut h = Sha256::new();
    let mut total = 0_u64;
    let mut buf = [0; 8192];
    loop {
        let n = f.read(&mut buf).map_err(|_| "r0-hash-read")?;
        if n == 0 {
            break;
        }
        total += n as u64;
        if total > 1024 * 1024 * 1024 {
            return Err("r0-hash-cap");
        }
        h.update(&buf[..n]);
    }
    Ok(format!("{:x}", h.finalize()))
}
fn control(root: &Path) -> Result<Value, &'static str> {
    let parent = root.parent().ok_or("r0-parent")?;
    settings_identity(parent, true)?;
    if fs::canonicalize(parent).map_err(|_| "r0-parent-canonical")? != parent {
        return Err("r0-parent-alias");
    }
    let v = bounded_json(&parent.join("control.json"), 4096)?;
    if v.as_object().map(|o| o.len()) != Some(3)
        || v["schema"] != 1
        || v["fixture"] != root.to_string_lossy().as_ref()
        || v["supervisorPid"]
            .as_i64()
            .is_none_or(|v| v <= 1 || v > i32::MAX as i64)
    {
        return Err("r0-control-shape");
    }
    Ok(v)
}
pub(crate) fn control_endpoint(root: &Path) -> Result<(PathBuf, i32), &'static str> {
    let c = control(root)?;
    let pid = i32::try_from(c["supervisorPid"].as_i64().ok_or("r0-supervisor-pid")?)
        .map_err(|_| "r0-supervisor-pid")?;
    Ok((root.parent().ok_or("r0-control-parent")?.join("s"), pid))
}
fn collect(root: &Path, at: &Path, out: &mut Vec<String>) -> Result<(), &'static str> {
    if out.len() > 2048 {
        return Err("r0-tree-cap");
    }
    let mut entries = fs::read_dir(at)
        .map_err(|_| "r0-tree-read")?
        .take(2049)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "r0-tree-entry")?;
    if entries.len() + out.len() > 2048 {
        return Err("r0-tree-cap");
    }
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        let p = e.path();
        let m = fs::symlink_metadata(&p).map_err(|_| "r0-tree-meta")?;
        if m.file_type().is_symlink() || (!m.is_dir() && !m.is_file()) {
            return Err("r0-tree-type");
        }
        let relative = p.strip_prefix(root).map_err(|_| "r0-tree-relative")?;
        let name = relative.to_str().ok_or("r0-tree-utf8")?;
        if name.len() > 512 || relative.components().count() > 16 || out.len() >= 2048 {
            return Err("r0-tree-name-cap");
        }
        out.push(name.into());
        if m.is_dir() {
            collect(root, &p, out)?;
        }
    }
    Ok(())
}
// Runs before Tauri/setup/SQLite. Exact existing root including WAL; never reseed.
pub(crate) fn validate_reopen(root: &Path) -> Result<(), &'static str> {
    let c = control(root)?;
    if c["supervisorPid"] != unsafe { libc::getppid() } {
        return Err("r0-reopen-parent");
    }
    let gate = bounded_json(
        &root.parent().ok_or("r0-parent")?.join("reopen.json"),
        262144,
    )?;
    if gate.as_object().map(|o| o.len()) != Some(7)
        || gate["schema"] != 1
        || gate["fixture"] != root.to_string_lossy().as_ref()
        || gate["compiledInputs"] != compiled_inputs()
        || gate["aPid"].as_u64() == Some(std::process::id() as u64)
        || gate["binarySha256"] != digest(&std::env::current_exe().map_err(|_| "r0-exe")?)?
        || gate["checkpointSha256"] != digest(&root.join("restart-exited.json"))?
    {
        return Err("r0-reopen-gate");
    }
    let original = bounded_json(&root.join("restart-exited.json"), 8192)?;
    if gate["aPid"].as_i64().is_none_or(|p| p <= 1)
        || gate["aPid"] != original["pid"]
        || original["compiledInputs"] != gate["compiledInputs"]
        || original["exitedRetained"] != true
    {
        return Err("r0-reopen-checkpoint-join");
    }
    let expected = gate["files"].as_array().ok_or("r0-reopen-files")?;
    if expected.is_empty() || expected.len() > 2049 {
        return Err("r0-reopen-files-cap");
    }
    let mut names = vec![String::new()];
    collect(root, root, &mut names)?;
    names.sort();
    let mut given = Vec::new();
    let mut total = 0_u64;
    for row in expected {
        if row.as_object().map(|o| o.len()) != Some(6) {
            return Err("r0-reopen-row");
        }
        let name = row["path"].as_str().ok_or("r0-reopen-name")?;
        if !name.is_empty()
            && Path::new(name)
                .components()
                .any(|c| !matches!(c, std::path::Component::Normal(_)))
        {
            return Err("r0-reopen-component");
        }
        given.push(name.to_owned());
        let p = root.join(name);
        let dir = row["directory"].as_bool().ok_or("r0-reopen-type")?;
        let m = fs::symlink_metadata(&p).map_err(|_| "r0-reopen-meta")?;
        if m.file_type().is_symlink()
            || m.uid() != unsafe { libc::geteuid() }
            || m.mode() & 0o022 != 0
            || dir != m.is_dir()
            || (!dir && !m.is_file())
        {
            return Err("r0-reopen-node");
        }
        if row["dev"] != m.dev() || row["ino"] != m.ino() || row["mode"] != (m.mode() & 0o777) {
            return Err("r0-reopen-identity");
        }
        total = total
            .checked_add(if dir { 0 } else { m.len() })
            .ok_or("r0-tree-byte-overflow")?;
        if total > 2 * 1024 * 1024 * 1024 {
            return Err("r0-tree-byte-cap");
        }
        if (dir && !row["sha256"].is_null()) || (!dir && row["sha256"] != digest(&p)?) {
            return Err("r0-reopen-content");
        }
    }
    if names != given {
        return Err("r0-reopen-tree");
    }
    for name in [
        "config/runtime.db",
        "config/runtime.db-wal",
        "config/runtime.db-shm",
        "restart.marker",
        "restart-ready.json",
        "restart-exited.json",
        "bin/claude",
        "bin/smoke-shell",
    ] {
        if !names.iter().any(|p| p == name) {
            return Err("r0-reopen-required");
        }
    }
    if fs::read(root.join("restart.marker")).map_err(|_| "r0-marker")? != b"cerebro-r0-v1\n" {
        return Err("r0-marker");
    }
    create(
        &root.parent().ok_or("r0-parent")?.join("verify-used"),
        b"one fixed verify process\n",
    )
    .map_err(|_| "r0-replay")
}

// Private fields hold the actual opaque values. No metadata constructor exists.
pub(crate) struct Prepared {
    _caller: NativeDelegationCaller,
    _frozen: Arc<FrozenNativeChild>,
    _owner: OwnedChildRun,
    root: PathBuf,
    config: PathBuf,
    baseline: Value,
    prerequisites: Value,
    runtime: SettingsRuntime,
    closed_session: bool,
}
impl Prepared {
    pub(crate) fn endpoint(&self) -> Result<(PathBuf, i32), &'static str> {
        control_endpoint(&self.root)
    }
    // Independent reader acquires no Child/AgentState/caller/storage locks. The
    // retainer only receives bounded metadata; this is a fixed function, no callback.
    pub(crate) fn checkpoint(&self, exited: bool) -> Result<(), &'static str> {
        let root = self.root.clone();
        let config = self.config.clone();
        let closed_session = self.closed_session;
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        std::thread::spawn(move || {
            let _ = tx.send(if closed_session {
                audit::r2::snapshot(&config)
            } else {
                audit::snapshot(&config)
            });
        });
        let v = rx
            .recv_timeout(Duration::from_secs(6))
            .map_err(|_| "r0-independent-read-deadline")??;
        if !(if closed_session {
            r2::held(&v)
        } else {
            audit::held(&v)
        }) || v != self.baseline
        {
            return Err("r0-held-state-changed");
        }
        if settings_identity(&root, true)? != self.runtime.root
            || settings_identity(&self.config, true)? != self.runtime.config
            || settings_identity(&crate::runtime::runtime_db_path(&self.config), false)?
                != self.runtime.database
        {
            return Err("r0-held-runtime-changed");
        }
        save(
            &root,
            if exited {
                "restart-exited.json"
            } else {
                "restart-ready.json"
            },
            &json!({
            "schema":1,"pid":std::process::id(),"cutoff":crate::process_started_at(),"compiledInputs":compiled_inputs(),
            "runtime":self.runtime,"snapshot":v,"prerequisites":self.prerequisites,"exitedRetained":exited}),
        )
    }
}
fn prepare(
    app: &AppHandle,
    window: &WebviewWindow,
    closed_session: bool,
) -> Result<Prepared, &'static str> {
    let paths = app.state::<SmokePaths>();
    seed(&paths)?;
    open(app, window, &paths.vault_a)?;
    let known = SettingsRuntime::capture(&paths)?;
    let run = start_parent(app, window, &paths, None)?;
    if !available(app, window, run) {
        return Err("r0-original-parent");
    }
    let request = request()?;
    let caller = prepare_native_delegation(app, window, run).map_err(|_| "r0-caller")?;
    let allocation =
        reserve_native_delegation(app, window, &caller, &request).map_err(|_| "r0-reserve")?;
    let frozen = freeze_native_child(
        app,
        window,
        &caller,
        &request,
        NativeChildMode::LocalResearcher,
    )
    .map_err(|_| "r0-freeze")?;
    let replay = freeze_native_child(
        app,
        window,
        &caller,
        &request,
        NativeChildMode::LocalResearcher,
    )
    .map_err(|_| "r0-freeze-replay")?;
    let same = Arc::ptr_eq(&frozen, &replay)
        && frozen.view().allocation == &allocation
        && original_binding(&paths, &known, &frozen)?;
    if !same {
        return Err("r0-original-same-arc");
    }
    let owned = claim_native_child_run(app, window, &caller, &request, &frozen)
        .map_err(|_| "r0-actual-owner")?;
    if !actual_join(&paths, &known, &frozen, false)? {
        return Err("r0-actual-join");
    }
    let baseline = audit::snapshot(&paths.config)?;
    if !audit::held(&baseline) {
        return Err("r0-held-baseline");
    }
    let baseline = if closed_session {
        r2::close_before_hold(&paths, &known, &baseline)?
    } else {
        baseline
    };
    let held = Prepared {
        _caller: caller,
        _frozen: frozen,
        _owner: owned,
        root: paths.root.clone(),
        config: paths.config.clone(),
        baseline,
        prerequisites: json!({"actualOriginalParent":true,"originalReservation":true,"sameFrozenArc":same,"actualOwnedClaim":true}),
        runtime: known,
        closed_session,
    };
    // Selection clones the EXISTING slot's handle after every owner transaction and
    // freeze/launch/source guard has returned. This entry never returns after selection.
    app.state::<crate::agent::AgentState>()
        .native_restart_retain(run, held)
}
pub(crate) fn capture(app: &AppHandle, window: &WebviewWindow) -> ! {
    let paths = app.state::<SmokePaths>();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| match paths.restart {
        Role::Prepare => prepare(app, window, false).map(|_| ()),
        Role::PrepareR2 => prepare(app, window, true).map(|_| ()),
        Role::Verify => verify(app, window),
        Role::VerifyR1 => r1::verify(app, window),
        Role::VerifyR2 => r2::verify(app, window),
        Role::None => Err("r0-role"),
    }));
    let failure = match result {
        Ok(Err(e)) => e,
        Ok(Ok(())) => "r0-unexpected-return",
        Err(_) => "r0-panic",
    };
    let _ = save(
        &paths.root,
        "restart-failure.json",
        &json!({"schema":1,"failedStage":failure}),
    );
    exit_rejected()
}
fn verify(app: &AppHandle, window: &WebviewWindow) -> Result<(), &'static str> {
    let paths = app.state::<SmokePaths>();
    let before = bounded_json(&paths.root.join("restart-exited.json"), 8192)?;
    let baseline = before["snapshot"].clone();
    let cutoff = crate::process_started_at();
    let claimed = baseline["claimedAt"].as_str().ok_or("r0-old-claim")?;
    let started = baseline["parentStarted"].as_str().ok_or("r0-old-parent")?;
    if claimed >= cutoff.as_str()
        || started >= cutoff.as_str()
        || before["pid"] == std::process::id()
        || before["compiledInputs"] != compiled_inputs()
        || !audit::held(&baseline)
    {
        return Err("r0-old-cutoff-or-producer");
    }
    let known = SettingsRuntime::capture(&paths)?;
    if serde_json::to_value(&known).map_err(|_| "r0-runtime-encode")? != before["runtime"] {
        return Err("r0-runtime-replaced");
    }
    audit::arm(&paths.config)?;
    let first_result = open(app, window, &paths.vault_a);
    let first = audit::take(&paths.config)?;
    // BEFORE any semantic assertion; suppressed RED and GREEN share this observer.
    save(
        &paths.root,
        "restart-attempt.json",
        &json!({"schema":1,"pid":std::process::id(),"cutoff":cutoff,
        "appSession":crate::runtime::sessions::session_id(),"compiledInputs":compiled_inputs(),"openOk":first_result.is_ok(),"opening":first}),
    )?;
    first_result?;
    known.recheck(&paths)?;
    if !green(&first, &baseline, false) {
        return Err("r0-first-recovery");
    }
    audit::arm(&paths.config)?;
    let second_result = open(app, window, &paths.vault_a);
    let second = audit::take(&paths.config)?;
    save(
        &paths.root,
        "restart-second-attempt.json",
        &json!({"schema":1,"pid":std::process::id(),"openOk":second_result.is_ok(),"opening":second}),
    )?;
    second_result?;
    known.recheck(&paths)?;
    if !green(&second, &first["snapshot"], true) {
        return Err("r0-second-recovery");
    }
    save(
        &paths.root,
        "restart-report.json",
        &json!({"schema":1,"passed":true,"profile":"r0",
        "pid":std::process::id(),"compiledInputs":compiled_inputs(),"sameProcessSecondOpening":true}),
    )?;
    // B has no agent children; normal shutdown is allowed. A never reaches here.
    app.state::<SmokePaths>()
        .finished
        .store(true, Ordering::SeqCst);
    app.exit(0);
    loop {
        std::thread::park_timeout(Duration::from_secs(1));
    }
}
fn green(v: &Value, baseline: &Value, second: bool) -> bool {
    let events = &v["events"];
    let row = &v["snapshot"];
    let middle = &events[1]["snapshot"];
    let expected = if second { 0 } else { 1 };
    events.as_array().is_some_and(|a| a.len() == 5)
        && ["storage", "child", "generic", "session", "bind"]
            .iter()
            .enumerate()
            .all(|(i, s)| events[i]["stage"] == *s && events[i]["ok"] == true)
        && events[1]["count"] == expected
        && events[2]["count"] == expected
        && row["immutableDigest"] == baseline["immutableDigest"]
        && middle["immutableDigest"] == baseline["immutableDigest"]
        && row["counts"] == baseline["counts"]
        && row["joins"] == 1
        && row["consumptions"] == 0
        && row["state"] == "interrupted"
        && row["occupied"] == 0
        && row["outcome"] == "abandoned_usage_unknown"
        && row["usage"] == "unknown"
        && row["closeKind"] == "context_closed"
        && row["revision"] == 2
        && !row["ended"].is_null()
        && row["ended"] == row["runEnded"]
        && row["ended"] == row["nativeClosed"]
        && row["parentOutcome"] == "abandoned_usage_unknown"
        && !row["parentEnded"].is_null()
        && row["parentUsage"] == "unknown"
        && row["oldPrecision"] == "heartbeat_lower_bound"
        && row["oldClosed"].is_null()
        && row["appSession"] != crate::runtime::sessions::session_id()
        && middle["counts"] == baseline["counts"]
        && middle["joins"] == 1
        && middle["consumptions"] == 0
        && middle["state"] == "interrupted"
        && middle["occupied"] == 0
        && middle["outcome"] == "abandoned_usage_unknown"
        && middle["usage"] == "unknown"
        && middle["closeKind"] == "context_closed"
        && middle["revision"] == 2
        && !middle["ended"].is_null()
        && middle["ended"] == middle["runEnded"]
        && middle["ended"] == middle["nativeClosed"]
        && row["parentClose"].is_null()
        && row["parentRevision"] == 1
        && middle["parentClose"].is_null()
        && middle["parentRevision"] == 1
        && if second {
            row == baseline && middle == baseline
        } else {
            middle["parentOutcome"] == "running"
                && middle["parentEnded"].is_null()
                && middle["oldPrecision"] == "open"
        }
}
