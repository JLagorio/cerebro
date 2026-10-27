//! Fixed failed-child-recovery restart profile. No writer or authority recreation.
use super::*;
fn require(ok: bool, code: &'static str) -> Result<(), &'static str> {
    if ok {
        Ok(())
    } else {
        Err(code)
    }
}
fn without_supplement(value: &Value) -> Value {
    let mut v = value.clone();
    if let Some(object) = v.as_object_mut() {
        object.remove("r1");
    }
    v
}
fn damaged(value: &Value) -> bool {
    if !value.is_object() {
        return false;
    }
    let mut v = value.clone();
    v["usage"] = json!("pending");
    audit::held(&v)
        && value["usage"] == "unknown"
        && value["r1"]["markers"] == json!([1, 1, 1])
        && value["r1"]["columnCounts"] == json!([39, 9, 9, 4, 13, 3, 17, 17])
        && value["r1"]["usage"] == json!(["text", "756e6b6e6f776e"])
}
fn save_r1(root: &Path, name: &str, value: &Value) -> Result<(), &'static str> {
    let bytes = serde_json::to_vec_pretty(value).map_err(|_| "r1-audit-encode")?;
    if bytes.len() > 16384 {
        return Err("r1-audit-cap");
    }
    create(&root.join(name), &bytes).map_err(|_| "r1-audit-create")
}
fn receipt(root: &Path) -> Result<Value, &'static str> {
    bounded_json(
        &root.parent().ok_or("r1-root")?.join("corruption.json"),
        16384,
    )
}

fn closed(value: &Value) -> bool {
    *value
        == json!({"inTransactionBefore":false,"activeConnectionsBefore":1,"activeCursorsBefore":0,
        "returnValue":null,"activeConnectionsAfter":0,"probe":{"errorType":"ProgrammingError",
        "message":"Cannot operate on a closed database.","sqliteErrorCode":null,"sqliteErrorName":null}})
}
fn original_files(root: &Path, r: &Value) -> Result<(), &'static str> {
    for name in ["runtime.db", "runtime.db-wal", "runtime.db-shm"] {
        let path = root.join("config").join(name);
        let initial = &r["filesBefore"][name];
        let current = fs::symlink_metadata(&path).map_err(|_| "r1-db-meta")?;
        for stage in [
            "filesBefore",
            "filesBeforeClose",
            "filesAfterClose",
            "filesAfterReadClose",
        ] {
            let row = &r[stage][name];
            require(
                row["exists"] == true
                    && row["path"] == path.to_string_lossy().as_ref()
                    && row["mode"] == 0o600
                    && row["nlink"] == 1
                    && row["uid"] == unsafe { libc::geteuid() }
                    && row["bytes"]
                        .as_u64()
                        .is_some_and(|n| n > 0 && n <= 16777216)
                    && ["path", "device", "inode", "uid", "mode", "nlink"]
                        .iter()
                        .all(|k| row[*k] == initial[*k]),
                "r1-original-sidecar",
            )?;
        }
        require(
            !current.file_type().is_symlink()
                && current.is_file()
                && initial["device"] == current.dev()
                && initial["inode"] == current.ino()
                && r["filesAfterReadClose"][name]["sha256"] == digest(&path)?,
            "r1-closed-tree-join",
        )?;
    }
    Ok(())
}

pub(crate) fn validate_reopen(root: &Path) -> Result<(), &'static str> {
    let outer = root.parent().ok_or("r1-root")?;
    let gate = bounded_json(&outer.join("r1-reopen.json"), 4096)?;
    require(
        gate.as_object().map(|v| v.len()) == Some(4)
            && gate["schema"] == 1
            && gate["fixture"] == root.to_string_lossy().as_ref()
            && gate["corruptionSha256"] == digest(&outer.join("corruption.json"))?
            && gate["reopenSha256"] == digest(&outer.join("reopen.json"))?,
        "r1-reopen-binding",
    )?;
    let r = receipt(root)?;
    let original = bounded_json(&root.join("restart-exited.json"), 8192)?;
    require(
        r["schema"] == 1
            && r["kind"] == "r1-one-cell-corruption"
            && r["fixture"] == root.to_string_lossy().as_ref()
            && r["aPid"] == original["pid"]
            && r["checkpointSha256"] == digest(&root.join("restart-exited.json"))?
            && r["compiledInputs"] == compiled_inputs()
            && r["columnsDigest"] == crate::ledger::sha256_hex(audit::r1::COLUMNS.as_bytes())
            && r["columnsDigest"] == r["after"]["r1"]["columnsDigest"]
            && r["columnsDigest"] == r["before"]["r1"]["columnsDigest"],
        "r1-corruption-origin",
    )?;
    require(
        without_supplement(&r["before"]) == original["snapshot"]
            && r["before"]["r1"]["markers"] == json!([1, 1, 1])
            && damaged(&r["after"]),
        "r1-corruption-baseline",
    )?;
    let mut expected = without_supplement(&r["before"]);
    expected["usage"] = json!("unknown");
    require(
        without_supplement(&r["after"]) == expected
            && r["before"]["r1"]["withoutUsageDigest"] == r["after"]["r1"]["withoutUsageDigest"]
            && r["before"]["r1"]["protectedDigest"] != r["after"]["r1"]["protectedDigest"]
            && r["changes"]
                == json!([{"group":"child-run","column":"usage_state","before":["text","70656e64696e67"],"after":["text","756e6b6e6f776e"]}])
            && r["mutation"]["rowcount"] == 1
            && r["mutation"]["changesDelta"] == 1
            && r["mutation"]["inTransactionAfter"] == false
            && r["mutation"]["commitRows"] == json!([])
            && r["mutation"]["commitRowcount"] == -1
            && r["connections"] == json!({"opened":2,"closed":2,"active":0,"maxActive":1})
            && r["schemaBefore"] == r["schemaAfter"]
            && r["schemaBefore"]["userVersion"] == 41
            && r["readbackEqual"] == true,
        "r1-one-cell-closed",
    )?;
    require(
        closed(&r["writerClose"])
            && closed(&r["readerClose"])
            && r["readerNoCkptReadback"] == true
            && r["config"]["noCkptReadback"] == true
            && r["config"]["walAutocheckpoint"] == 0
            && r["config"]["foreignKeys"] == 1
            && r["config"]["journalMode"] == "wal",
        "r1-explicit-closed",
    )?;
    original_files(root, &r)?;
    // Keep R0's seven-key full-tree, original checkpoint, required WAL/SHM and
    // single-use admission unchanged. Extra R1 receipt is checked before it.
    super::validate_reopen(root)
}
pub(super) fn verify(app: &AppHandle, window: &WebviewWindow) -> Result<(), &'static str> {
    let paths = app.state::<SmokePaths>();
    let r = receipt(&paths.root)?;
    let original = bounded_json(&paths.root.join("restart-exited.json"), 8192)?;
    let cutoff = crate::process_started_at();
    for key in ["claimedAt", "parentStarted"] {
        require(
            r["after"][key].as_str().ok_or("r1-old-stamp")? < cutoff.as_str(),
            "r1-actual-cutoff",
        )?;
    }
    require(
        original["pid"] != std::process::id() && original["compiledInputs"] == compiled_inputs(),
        "r1-new-process",
    )?;
    let known = SettingsRuntime::capture(&paths)?;
    require(
        serde_json::to_value(&known).map_err(|_| "r1-runtime")? == original["runtime"],
        "r1-original-runtime",
    )?;
    audit::arm_r1(&paths.config)?;
    let result = open(app, window, &paths.vault_a);
    let observed = audit::take(&paths.config)?;
    let attempt = json!({"schema":1,"profile":"r1","pid":std::process::id(),"cutoff":cutoff,
        "appSession":crate::runtime::sessions::session_id(),"compiledInputs":compiled_inputs(),
        "corruptionSha256":digest(&paths.root.parent().ok_or("r1-root")?.join("corruption.json"))?,
        "openOk":result.is_ok(),"opening":observed});
    // Same raw observer regardless of pass/refusal; persist before semantic assertions.
    save_r1(&paths.root, "restart-r1-attempt.json", &attempt)?;
    result?;
    known.recheck(&paths)?;
    require(
        accepted(&observed, &r["after"]),
        "r1-failed-child-generic-protection",
    )?;
    require(
        crate::runtime::sessions::session_id()
            != r["after"]["appSession"].as_str().ok_or("r1-old-session")?,
        "r1-new-session",
    )?;
    save(
        &paths.root,
        "restart-r1-report.json",
        &json!({"schema":1,"profile":"r1","pid":std::process::id(),
        "compiledInputs":compiled_inputs(),"recoveryRefused":true,"protectedRowsPreserved":true,
        "ordinaryParentRecovered":true,"independentUnionArmsProven":false,"r2Proven":false}),
    )?;
    paths.finished.store(true, Ordering::SeqCst);
    app.exit(0);
    loop {
        std::thread::park_timeout(Duration::from_secs(1));
    }
}
fn accepted(value: &Value, baseline: &Value) -> bool {
    let events = &value["events"];
    if !value["snapshotAvailable"].as_bool().unwrap_or(false)
        || events.as_array().is_none_or(|v| v.len() != 5)
        || !["storage", "child", "generic", "session", "bind"]
            .iter()
            .enumerate()
            .all(|(i, s)| events[i]["stage"] == *s)
        || ![0, 2, 3, 4].iter().all(|i| events[*i]["ok"] == true)
        || events[1]["ok"] != false
        || !events[1]["count"].is_null()
        || events[2]["count"] != 1
        || events[1]["snapshot"] != *baseline
        || !damaged(baseline)
    {
        return false;
    }
    let final_row = &value["snapshot"];
    let mut expected = baseline.clone();
    let Some(ended) = final_row["parentEnded"].as_str() else {
        return false;
    };
    let Some(claimed) = baseline["claimedAt"].as_str() else {
        return false;
    };
    let (Ok(ended_at), Ok(claimed_at)) = (
        chrono::DateTime::parse_from_rfc3339(ended),
        chrono::DateTime::parse_from_rfc3339(claimed),
    ) else {
        return false;
    };
    if ended_at < claimed_at {
        return false;
    }
    expected["parentOutcome"] = json!("abandoned_usage_unknown");
    expected["parentUsage"] = json!("unknown");
    expected["parentEnded"] = json!(ended);
    expected["oldPrecision"] = json!("heartbeat_lower_bound");
    *final_row == expected
}
