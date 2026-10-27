//! Fixed actual closed-old-session restart. No historical authority constructor.
use super::*;
fn require(ok: bool, code: &'static str) -> Result<(), &'static str> {
    if ok {
        Ok(())
    } else {
        Err(code)
    }
}
fn scalar(v: &Value) -> Value {
    let mut out = v.clone();
    if let Some(o) = out.as_object_mut() {
        o.remove("r2");
    }
    out
}
fn stamp(v: &Value) -> Option<chrono::DateTime<chrono::FixedOffset>> {
    let s = v.as_str()?;
    if !s.ends_with('Z') || s.len() > 64 {
        return None;
    }
    chrono::DateTime::parse_from_rfc3339(s).ok()
}
fn at_least(a: &Value, b: &Value) -> bool {
    match (stamp(a), stamp(b)) {
        (Some(a), Some(b)) => a >= b,
        _ => false,
    }
}
fn fixed(v: &Value) -> bool {
    let a = &v["r2"];
    a["version"] == 1
        && a["columnsDigest"] == crate::ledger::sha256_hex(audit::r2::COLUMNS.as_bytes())
        && a["columnCounts"] == json!([39, 9, 9, 4, 13, 3, 17, 17, 39, 7])
        && a["markers"] == json!([1, 1, 1])
        && a["clientTokens"] == 0
        && a["groupDigests"].as_array().is_some_and(|x| {
            x.len() == 10
                && x.iter().all(|v| {
                    v.as_str().is_some_and(|s| {
                        s.len() == 64
                            && s.bytes()
                                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                    })
                })
        })
        && [
            "fullDigest",
            "withoutSessionCloseDigest",
            "withoutChildTerminalDigest",
            "withoutParentTerminalDigest",
        ]
        .iter()
        .all(|k| {
            a[*k].as_str().is_some_and(|s| {
                s.len() == 64
                    && s.bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            })
        })
}
pub(super) fn held(v: &Value) -> bool {
    if !v.is_object() {
        return false;
    }
    let mut open = scalar(v);
    open["oldPrecision"] = json!("open");
    open["oldClosed"] = Value::Null;
    audit::held(&open)
        && v["parentUsage"] == "pending"
        && fixed(v)
        && v["oldPrecision"] == "clean_exact"
        && v["oldClosed"] == v["oldHeartbeat"]
        && at_least(&v["oldClosed"], &v["claimedAt"])
        && v["r2"]["sessionCount"] == 1
        && v["r2"]["sessionWindow"].is_null()
}
fn closure(before: &Value, after: &Value) -> bool {
    if !audit::held(before)
        || !fixed(before)
        || before["parentUsage"] != "pending"
        || !held(after)
        || before["r2"]["sessionCount"] != 1
        || !before["r2"]["sessionWindow"].is_null()
    {
        return false;
    }
    let mut expected = scalar(before);
    expected["oldPrecision"] = json!("clean_exact");
    expected["oldClosed"] = after["oldClosed"].clone();
    expected["oldHeartbeat"] = after["oldClosed"].clone();
    scalar(after) == expected
        && before["r2"]["withoutSessionCloseDigest"] == after["r2"]["withoutSessionCloseDigest"]
        && before["r2"]["fullDigest"] != after["r2"]["fullDigest"]
        && (0..9).all(|i| before["r2"]["groupDigests"][i] == after["r2"]["groupDigests"][i])
        && before["r2"]["groupDigests"][9] != after["r2"]["groupDigests"][9]
}
fn save_r2(root: &Path, name: &str, value: &Value) -> Result<(), &'static str> {
    let bytes = serde_json::to_vec_pretty(value).map_err(|_| "r2-encode")?;
    if bytes.len() > 16384 {
        return Err("r2-evidence-cap");
    }
    create(&root.join(name), &bytes).map_err(|_| "r2-evidence-create")
}
pub(super) fn close_before_hold(
    paths: &SmokePaths,
    known: &SettingsRuntime,
    healthy: &Value,
) -> Result<Value, &'static str> {
    let before = audit::r2::snapshot(&paths.config)?;
    require(scalar(&before) == *healthy, "r2-original-open-baseline")?;
    // Actual existing writer, while A is alive, before the retained Child lock.
    // Unit return is not a success observation; only the following rows establish closure.
    crate::runtime::sessions::close_current();
    let after = audit::r2::snapshot(&paths.config)?;
    save_r2(
        &paths.root,
        "restart-session-close.json",
        &json!({"schema":1,"profile":"r2-actual-session-close",
        "pid":std::process::id(),"compiledInputs":compiled_inputs(),"runtime":known,"before":before,"after":after}),
    )?;
    known.recheck(paths)?;
    require(closure(&before, &after), "r2-actual-session-close")?;
    Ok(after)
}
fn close_record(root: &Path, original: &Value) -> Result<Value, &'static str> {
    let close = bounded_json(&root.join("restart-session-close.json"), 16384)?;
    require(
        close["schema"] == 1
            && close["profile"] == "r2-actual-session-close"
            && close["pid"] == original["pid"]
            && close["compiledInputs"] == original["compiledInputs"]
            && close["runtime"] == original["runtime"]
            && close["after"] == original["snapshot"]
            && closure(&close["before"], &close["after"]),
        "r2-closure-checkpoint",
    )?;
    Ok(close)
}
pub(crate) fn validate_reopen(root: &Path) -> Result<(), &'static str> {
    let original = bounded_json(&root.join("restart-exited.json"), 8192)?;
    close_record(root, &original)?;
    // Original exact full tree includes the closure receipt, required WAL/SHM and
    // unchanged genuine A checkpoint; original gate remains single-use.
    super::validate_reopen(root)
}
fn child_terminal(before: &Value, after: &Value) -> bool {
    if !held(before) || !fixed(after) || !at_least(&after["ended"], &before["oldClosed"]) {
        return false;
    }
    let mut expected = scalar(before);
    for (key, value) in [
        ("state", json!("interrupted")),
        ("occupied", json!(0)),
        ("outcome", json!("abandoned_usage_unknown")),
        ("usage", json!("unknown")),
        ("revision", json!(2)),
        ("closeKind", json!("context_closed")),
        ("ended", after["ended"].clone()),
        ("runEnded", after["ended"].clone()),
        ("nativeClosed", after["ended"].clone()),
    ] {
        expected[key] = value;
    }
    scalar(after) == expected
        && after["r2"]["sessionCount"] == 1
        && after["r2"]["sessionWindow"].is_null()
        && after["r2"]["withoutChildTerminalDigest"] == before["r2"]["withoutChildTerminalDigest"]
        && after["r2"]["fullDigest"] != before["r2"]["fullDigest"]
        && [3, 4, 5, 7, 8, 9]
            .iter()
            .all(|i| after["r2"]["groupDigests"][*i] == before["r2"]["groupDigests"][*i])
}
fn parent_terminal(middle: &Value, after: &Value) -> bool {
    if !fixed(after) || !at_least(&after["parentEnded"], &middle["ended"]) {
        return false;
    }
    let mut expected = scalar(middle);
    expected["parentOutcome"] = json!("abandoned_usage_unknown");
    expected["parentUsage"] = json!("unknown");
    expected["parentEnded"] = after["parentEnded"].clone();
    let w = &after["r2"]["sessionWindow"];
    scalar(after) == expected
        && after["r2"]["sessionCount"] == 2
        && w["precision"] == "clean_exact"
        && w["cause"] == "app"
        && w["closedAt"] == middle["oldClosed"]
        && at_least(&w["reopenedAt"], &middle["oldClosed"])
        && after["r2"]["withoutParentTerminalDigest"] == middle["r2"]["withoutParentTerminalDigest"]
        && after["r2"]["fullDigest"] != middle["r2"]["fullDigest"]
        && (0..10)
            .filter(|i| *i != 8)
            .all(|i| after["r2"]["groupDigests"][i] == middle["r2"]["groupDigests"][i])
}
fn accepted(observed: &Value, baseline: &Value) -> bool {
    let e = &observed["events"];
    observed["snapshotAvailable"] == true
        && e.as_array().is_some_and(|a| a.len() == 5)
        && ["storage", "child", "generic", "session", "bind"]
            .iter()
            .enumerate()
            .all(|(i, s)| e[i]["stage"] == *s && e[i]["ok"] == true)
        && e[1]["count"] == 1
        && e[2]["count"] == 1
        && child_terminal(baseline, &e[1]["snapshot"])
        && parent_terminal(&e[1]["snapshot"], &observed["snapshot"])
}
pub(super) fn verify(app: &AppHandle, window: &WebviewWindow) -> Result<(), &'static str> {
    let paths = app.state::<SmokePaths>();
    let original = bounded_json(&paths.root.join("restart-exited.json"), 8192)?;
    close_record(&paths.root, &original)?;
    let baseline = &original["snapshot"];
    let cutoff = crate::process_started_at();
    require(
        original["pid"] != std::process::id() && original["compiledInputs"] == compiled_inputs(),
        "r2-fresh-process",
    )?;
    for key in ["claimedAt", "parentStarted", "oldClosed"] {
        require(
            baseline[key].as_str().ok_or("r2-old-stamp")? < cutoff.as_str(),
            "r2-actual-cutoff",
        )?;
    }
    let known = SettingsRuntime::capture(&paths)?;
    require(
        serde_json::to_value(&known).map_err(|_| "r2-runtime")? == original["runtime"],
        "r2-original-runtime",
    )?;
    let pre_open = audit::r2::snapshot(&paths.config)?;
    save_r2(
        &paths.root,
        "restart-r2-before.json",
        &json!({"schema":1,"pid":std::process::id(),"snapshot":pre_open}),
    )?;
    require(
        pre_open == *baseline && held(&pre_open),
        "r2-preopening-closed-history",
    )?;
    audit::arm_r2(&paths.config)?;
    let result = open(app, window, &paths.vault_a);
    let observed = audit::take(&paths.config)?;
    save_r2(
        &paths.root,
        "restart-r2-attempt.json",
        &json!({"schema":1,"profile":"r2-closed-session",
        "pid":std::process::id(),"cutoff":cutoff,"appSession":crate::runtime::sessions::session_id(),
        "compiledInputs":compiled_inputs(),"closeAuditSha256":digest(&paths.root.join("restart-session-close.json"))?,
        "openOk":result.is_ok(),"opening":observed}),
    )?;
    result?;
    known.recheck(&paths)?;
    require(accepted(&observed, baseline), "r2-closed-history-recovery")?;
    require(
        crate::runtime::sessions::session_id()
            != baseline["appSession"].as_str().ok_or("r2-old-session")?,
        "r2-new-session",
    )?;
    save(
        &paths.root,
        "restart-r2-report.json",
        &json!({"schema":1,"profile":"r2-closed-session","pid":std::process::id(),
        "compiledInputs":compiled_inputs(),"closedSessionChildRecovered":true,"ordinaryParentRecovered":true,
        "laterCleanCatchupObserved":true,"resumedCliAdmissionProven":false,"stopOrQuitProven":false}),
    )?;
    paths.finished.store(true, Ordering::SeqCst);
    app.exit(0);
    loop {
        std::thread::park_timeout(Duration::from_secs(1));
    }
}
