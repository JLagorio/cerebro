//! Closed M93 measurement fixture. Never imported by the production app.
//! Synthetic failing/pending writer and explicit latency injection; no disk-save claim.
use super::{compiled_inputs, create, SmokePaths};
use crate::shell::quit::{SmokeDecision, SmokeEntry, SmokePending, SmokePhase};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::{Mutex, PoisonError};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Listener, Manager, WebviewWindow};

const TARGET: &str = "cerebro_lib::native_quit_smoke";
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(super) enum Case {
    FailedOwner,
    PendingOwner,
    LateUnresolved,
    #[serde(rename = "late-ipc-150")]
    LateIpc150,
    #[serde(rename = "late-ipc-350")]
    LateIpc350,
    SecondQuit,
    ExpiredSecondQuit,
    HungWebview,
}
impl Case {
    pub(super) fn parse(flag: &std::ffi::OsStr) -> Option<Self> {
        match flag.to_str()? {
            "--quit-failed-owner" => Some(Self::FailedOwner),
            "--quit-pending-owner" => Some(Self::PendingOwner),
            "--quit-late-unresolved" => Some(Self::LateUnresolved),
            "--quit-late-ipc-150" => Some(Self::LateIpc150),
            "--quit-late-ipc-350" => Some(Self::LateIpc350),
            "--quit-second-quit" => Some(Self::SecondQuit),
            "--quit-expired-second-quit" => Some(Self::ExpiredSecondQuit),
            "--quit-hung-webview" => Some(Self::HungWebview),
            _ => None,
        }
    }
    fn delay(self) -> u64 {
        match self {
            Self::LateIpc150 => 150,
            Self::LateIpc350 => 350,
            _ => 0,
        }
    }
}
#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(super) enum Stage {
    Flush,
    SettleFirst,
    Leave,
    SettleSecond,
    Writer,
    Retry,
    Cleanup,
    Heartbeat,
    ShellMounted,
}
#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(super) enum Edge {
    Enter,
    Complete,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Snapshot {
    latest_draft: String,
    generation: u64,
    acknowledged_generation: u64,
    in_flight_generation: Option<u64>,
    failed: bool,
    payload_sha256: String,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct OwnerKey {
    vault_id: String,
    path: String,
    owner_id: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct PhaseBatch {
    binding: String,
    format: u8,
    owner_key: OwnerKey,
    owner_instance: String,
    // Retain missing/null distinctions for the semantic decoder; no defaults.
    snapshots: Vec<Value>,
    events: Vec<Vec<Value>>,
    broken: Value,
}

#[derive(Debug)]
struct DecodedBatch {
    observations: Vec<Value>,
    last_sequence: u64,
}

// Pure frontend-evidence boundary. Native attempt/arm authority is joined later.
fn decode_phase_batch(batch: &PhaseBatch) -> Result<DecodedBatch, &'static str> {
    const INVALID: &str = "quit-phase-batch-invalid";
    if batch.format != 1
        || batch.binding.is_empty()
        || batch.binding.len() > 64
        || batch.owner_instance.is_empty()
        || batch.owner_instance.len() > 64
        || batch.owner_key.vault_id != "m93-controlled-vault"
        || batch.owner_key.path != "controlled.md"
        || batch.owner_key.owner_id != "m93-native-quit"
        || !batch.broken.is_null()
        || batch.snapshots.is_empty()
        || batch.snapshots.len() > 192
        || batch.events.is_empty()
        || batch.events.len() > 192
    {
        return Err(INVALID);
    }
    let mut wire = serde_json::to_value(batch).map_err(|_| INVALID)?;
    wire["kind"] = json!("phase-batch");
    if serde_json::to_vec(&wire).map_err(|_| INVALID)?.len() > 2048 {
        return Err(INVALID);
    }
    let mut generations = Vec::with_capacity(batch.snapshots.len());
    for raw in &batch.snapshots {
        let object = raw.as_object().ok_or(INVALID)?;
        if object.len() != 6 || !object.contains_key("inFlightGeneration") {
            return Err(INVALID);
        }
        let snapshot: Snapshot = serde_json::from_value(raw.clone()).map_err(|_| INVALID)?;
        let (draft, hash) = match snapshot.generation {
            0 => (
                "M93 controlled clean source\n",
                "dbbcd31435c629a3e3654a3b9f61127f81b9666c20ac1f8220c2c0091bc659c1",
            ),
            1 => (
                "M93 controlled retained draft\n",
                "11b39f197a8899b681e61889500aae56caf4c90a58e9ed6b777f2e0ee6e58074",
            ),
            _ => return Err(INVALID),
        };
        if snapshot.latest_draft != draft
            || snapshot.payload_sha256 != hash
            || snapshot.acknowledged_generation != 0
            || snapshot
                .in_flight_generation
                .is_some_and(|flight| flight == 0 || flight > snapshot.generation)
        {
            return Err(INVALID);
        }
        generations.push(snapshot.generation);
    }
    let phases = [
        ("flush", 2500_u64),
        ("settle-first", 750),
        ("leave", 750),
        ("settle-second", 750),
    ];
    let mut phase = 0;
    let mut entered: Option<f64> = None;
    let mut cleaned = false;
    let mut ended = false;
    let mut restored = false;
    let mut cancelled = false;
    let mut previous_ms = 0.0;
    let mut observations = Vec::with_capacity(batch.events.len());
    for (sequence, event) in batch.events.iter().enumerate() {
        if event.len() < 4 || event[0].as_u64() != Some(sequence as u64) {
            return Err(INVALID);
        }
        let ms = event[1].as_f64().ok_or(INVALID)?;
        if !ms.is_finite() || !(0.0..=60000.0).contains(&ms) || ms < previous_ms {
            return Err(INVALID);
        }
        previous_ms = ms;
        let tag = event[2].as_str().ok_or(INVALID)?;
        let index = usize::try_from(event[3].as_u64().ok_or(INVALID)?).map_err(|_| INVALID)?;
        let raw = batch.snapshots.get(index).ok_or(INVALID)?;
        if sequence == 0 && tag != "mount" {
            return Err(INVALID);
        }
        let mut data = match tag {
            "mount" if event.len() == 5 => {
                let mount = event[4].as_u64().ok_or(INVALID)?;
                if !((sequence == 0 && mount == 1)
                    || (sequence > 0 && ended && !restored && mount == 2))
                {
                    return Err(INVALID);
                }
                if mount == 2 {
                    restored = true;
                }
                json!({"kind":"stage","stage":"shell-mounted","edge":"complete","mount":mount})
            }
            "cleanup" if event.len() == 4 => {
                if phase != 2 || entered.is_none() || cleaned {
                    return Err(INVALID);
                }
                cleaned = true;
                json!({"kind":"stage","stage":"cleanup","edge":"complete"})
            }
            "writer" if event.len() == 4 && sequence > 0 => {
                json!({"kind":"stage","stage":"writer","edge":"enter"})
            }
            "enter" | "complete" => {
                let complete = tag == "complete";
                if event.len() != (if complete { 7 } else { 6 }) || sequence == 0 || ended {
                    return Err(INVALID);
                }
                let &(name, budget) = phases.get(phase).ok_or(INVALID)?;
                if event[4].as_str() != Some(name) || event[5].as_u64() != Some(budget) {
                    return Err(INVALID);
                }
                let mut data = json!({"kind":"stage","stage":name,"edge":tag,"budgetMs":budget});
                if complete {
                    let start = entered.ok_or(INVALID)?;
                    if ms - start >= budget as f64 || (phase == 2 && !cleaned) {
                        return Err(INVALID);
                    }
                    let result = event[6].as_object().ok_or(INVALID)?;
                    if result.len() != 2
                        || result.get("kind").and_then(Value::as_str) != Some("fulfilled")
                    {
                        return Err(INVALID);
                    }
                    let value = result.get("value").ok_or(INVALID)?;
                    let valid = match name {
                        "flush" => value.as_object().is_some_and(|value| {
                            value.len() == 2
                                && value.get("outcomes").is_some_and(Value::is_array)
                                && value
                                    .get("unresolvedOwnerIds")
                                    .and_then(Value::as_array)
                                    .is_some_and(Vec::is_empty)
                        }),
                        "settle-first" | "settle-second" => value.as_bool() == Some(true),
                        "leave" => value.as_bool() == Some(true),
                        _ => false,
                    };
                    if !valid {
                        return Err(INVALID);
                    }
                    data["result"] = event[6].clone();
                    entered = None;
                    phase += 1;
                } else {
                    if entered.is_some() {
                        return Err(INVALID);
                    }
                    entered = Some(ms);
                }
                data
            }
            "check" if event.len() == 6 && sequence > 0 => {
                let name = event[4].as_str().ok_or(INVALID)?;
                let valid = match name {
                    "hasUnresolved" => event[5].is_boolean(),
                    "pageWriteFailures" => event[5].as_u64().is_some(),
                    _ => false,
                };
                if !valid {
                    return Err(INVALID);
                }
                json!({"kind":"dependency-check","dependency":name,"value":event[5]})
            }
            "end" if event.len() == 5 => {
                if phase != 4
                    || entered.is_some()
                    || !cleaned
                    || ended
                    || event[4].as_bool() != Some(true)
                {
                    return Err(INVALID);
                }
                ended = true;
                json!({"kind":"end-leaving","hasUnresolved":event[4]})
            }
            "cancel" if event.len() == 4 => {
                if !ended || cancelled {
                    return Err(INVALID);
                }
                cancelled = true;
                json!({"kind":"cancel-wrapper"})
            }
            _ => return Err(INVALID),
        };
        if generations[index] != u64::from(cleaned) {
            return Err(INVALID);
        }
        let mut snapshot = raw.clone();
        snapshot["ownerKey"] = serde_json::to_value(&batch.owner_key).map_err(|_| INVALID)?;
        snapshot["ownerInstance"] = json!(batch.owner_instance);
        data["sequence"] = json!(sequence);
        data["ms"] = event[1].clone();
        data["binding"] = json!(batch.binding);
        data["snapshot"] = snapshot;
        if serde_json::to_vec(&data).map_err(|_| INVALID)?.len() > 2048 {
            return Err(INVALID);
        }
        observations.push(data);
    }
    if !ended || !restored || !cancelled {
        return Err(INVALID);
    }
    Ok(DecodedBatch {
        last_sequence: (observations.len() - 1) as u64,
        observations,
    })
}

// Two closed shapes: selected field presence never falls back to legacy admission.
#[derive(Deserialize, Serialize)]
#[serde(untagged, deny_unknown_fields)]
pub(super) enum Stayed {
    Legacy {
        ms: f64,
        snapshot: Snapshot,
    },
    Selected {
        ms: f64,
        // Selected missing/null evidence survives until semantic validation.
        snapshot: Value,
        binding: String,
        sequence: u64,
    },
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub(super) enum Probe {
    Ready,
    BindAttempt,
    PhaseBatch(PhaseBatch),
    WaitLateWindow {
        binding: String,
    },
    Stage {
        stage: Stage,
        edge: Edge,
        ms: f64,
        snapshot: Snapshot,
    },
    Stayed(Stayed),
    HangArmed {
        ms: f64,
        snapshot: Snapshot,
    },
}
// Genuine observer intake for the later consumer. This is not an arm API.
#[derive(Debug)]
struct NativeRead {
    observation: crate::shell::quit::SmokeObservation,
    captured_ns: u64,
}

// origin is the immutable native case-start origin, never a supplied deadline/arm.
// Call with no Trace lock held; smoke_observation releases the gate before returning.
fn read_native(
    state: &crate::shell::quit::QuitState,
    origin: Instant,
) -> Result<NativeRead, &'static str> {
    let observation = state.smoke_observation();
    if observation.broken {
        return Err("quit-native-observation-broken");
    }
    let elapsed = observation
        .observed_at
        .checked_duration_since(origin)
        .ok_or("quit-native-clock-reversed")?;
    let captured_ns =
        u64::try_from(elapsed.as_nanos()).map_err(|_| "quit-native-clock-unrepresentable")?;
    Ok(NativeRead {
        observation,
        captured_ns,
    })
}

#[derive(Default)]
struct Inner {
    origin: Option<Instant>,
    rows: Vec<Value>,
    broken: bool,
    ready: bool,
    stayed: u8,
    hang: bool,
    call: u32,
    emitted: u32,
    late: Option<LateSession>,
    outstanding: Option<(u32, Instant)>,
    admissions: Vec<Admission>,
    journal: Vec<SmokeEntry>,
    frozen: bool,
}
#[derive(Default)]
pub(super) struct Trace(Mutex<Inner>);
struct Admission {
    epoch: u64,
    call: u32,
    attempt: u32,
    requested_at: Instant,
    emitted: bool,
}
struct BatchReceipt {
    last_sequence: u64,
    last_ms: f64,
    owner: Value,
    received_at: Instant,
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum WaitState {
    Unused,
    Reserved,
    Admitted,
    Released(Instant),
    Consumed,
}
#[derive(Clone, Copy)]
struct LateWindow {
    arm: Instant,
    target: Instant,
    upper: Instant,
}
struct LateSession {
    epoch: u64,
    binding: String,
    arm: Option<Instant>,
    duration: Duration,
    ceiling: Instant,
    batch: Option<BatchReceipt>,
    wait: WaitState,
    window: Option<LateWindow>,
    ingress: Option<Instant>,
    injection: Option<Instant>,
    dispatch: Option<Instant>,
    cancel: Option<SmokeEntry>,
    deadline: Option<SmokeEntry>,
    returned: bool,
}
// An owned, one-shot reservation; the caller cannot supply its epoch or clone it.
#[derive(Debug)]
struct WaitReservation {
    epoch: u64,
    binding: String,
}
#[derive(Debug)]
enum LateAction {
    Reply(Value),
    Wait(WaitReservation),
}
fn selected(case: Case) -> bool {
    matches!(case, Case::LateIpc150 | Case::LateIpc350)
}
fn phase_name(phase: SmokePhase) -> &'static str {
    match phase {
        SmokePhase::Idle => "idle",
        SmokePhase::Preparing => "preparing",
        SmokePhase::Exiting => "exiting",
    }
}
fn native_ns(origin: Instant, captured: Instant) -> Result<u64, &'static str> {
    let elapsed = captured
        .checked_duration_since(origin)
        .ok_or("quit-native-clock-reversed")?;
    u64::try_from(elapsed.as_nanos()).map_err(|_| "quit-native-clock-unrepresentable")
}
// Caller holds Trace only. Preflight every full row before publishing any of a batch.
fn append_rows(trace: &mut Inner, events: Vec<(&str, Value)>) -> Result<(), &'static str> {
    if trace.frozen {
        return Err("quit-trace-frozen");
    }
    if trace.rows.len() >= 192 || trace.rows.len().saturating_add(events.len()) > 192 {
        trace.broken = true;
        return Err("quit-trace-cap");
    }
    let origin = *trace.origin.get_or_insert_with(Instant::now);
    let mut rows = Vec::with_capacity(events.len());
    for (event, data) in events {
        let row = json!({"ordinal":trace.rows.len()+rows.len()+1,
            "ms":origin.elapsed().as_secs_f64()*1000.0,"pid":std::process::id(),"event":event,"data":data});
        if serde_json::to_vec(&row).map_or(true, |bytes| bytes.len() > 2048) {
            trace.broken = true;
            return Err("quit-trace-row-cap");
        }
        rows.push(row);
    }
    for row in rows {
        log::info!(target: TARGET, "{}", row);
        trace.rows.push(row);
    }
    Ok(())
}
impl Inner {
    fn refuse(&mut self, reason: &'static str) {
        if !self.frozen && !self.broken {
            self.broken = true;
            let _ = append_rows(self, vec![("fixture-error", json!({"reason":reason}))]);
        }
    }
    fn origin(&self) -> Result<Instant, &'static str> {
        self.origin.ok_or("quit-native-origin-missing")
    }
    // Reads may overlap: identical producer prefixes are idempotent, never replayed.
    fn drain(&mut self, read: &NativeRead) -> Result<(), &'static str> {
        if self.frozen || self.broken {
            return Err("quit-trace-unavailable");
        }
        for (index, entry) in read.observation.entries.iter().enumerate() {
            if entry.sequence != index as u64 + 1
                || entry.captured_at > read.observation.observed_at
                || (index > 0
                    && entry.captured_at < read.observation.entries[index - 1].captured_at)
            {
                return Err("quit-native-journal-order");
            }
            if let Some(previous) = self.journal.get(index) {
                if previous != entry {
                    return Err("quit-native-journal-conflict");
                }
                continue;
            }
            if index != self.journal.len() {
                return Err("quit-native-journal-gap");
            }
            let captured = native_ns(self.origin()?, entry.captured_at)?;
            let (event, mut data) = match entry.decision {
                SmokeDecision::Admitted { epoch } => {
                    let (call, requested_at) = self.outstanding.ok_or("quit-admission-unowned")?;
                    if self.admissions.len() >= 2
                        || call as usize != self.admissions.len() + 1
                        || requested_at > entry.captured_at
                        || self
                            .admissions
                            .last()
                            .is_some_and(|prior| prior.epoch.checked_add(1) != Some(epoch))
                    {
                        return Err("quit-admission-order");
                    }
                    let attempt = self.admissions.len() as u32 + 1;
                    self.admissions.push(Admission {
                        epoch,
                        call,
                        attempt,
                        requested_at,
                        emitted: false,
                    });
                    self.outstanding = None;
                    (
                        "attempt-admitted",
                        json!({"epoch":epoch,"call":call,"attempt":attempt,"phase":"preparing"}),
                    )
                }
                SmokeDecision::Armed { epoch } => {
                    if !self.admissions.iter().any(|admission| admission.epoch == epoch)
                        || self.journal.iter().any(|prior| matches!(prior.decision, SmokeDecision::Armed { epoch: other } if other == epoch))
                    {
                        return Err("quit-arm-order");
                    }
                    if let Some(late) = self.late.as_mut().filter(|late| late.epoch == epoch) {
                        if late.arm.is_some_and(|arm| arm != entry.captured_at) {
                            return Err("quit-arm-conflict");
                        }
                        late.arm = Some(entry.captured_at);
                    }
                    (
                        "deadline-arm",
                        json!({"epoch":epoch,"durationMs":crate::shell::quit::QUIT_DEADLINE.as_millis()}),
                    )
                }
                SmokeDecision::Cancel {
                    epoch,
                    before,
                    after,
                    cancelled,
                } => {
                    let mut data = json!({"epoch":epoch,"before":phase_name(before),"after":phase_name(after),"cancelled":cancelled});
                    if let Some(late) = self.late.as_mut().filter(|late| late.epoch == epoch) {
                        if late.cancel.is_some() {
                            return Err("quit-cancel-duplicate");
                        }
                        late.cancel = Some(*entry);
                        data["binding"] = json!(late.binding);
                    }
                    ("gate-cancel", data)
                }
                SmokeDecision::Deadline {
                    timer_epoch,
                    gate_epoch,
                    before,
                    after,
                    exits,
                } => {
                    let mut data = json!({"epoch":gate_epoch,"timerEpoch":timer_epoch,
                        "before":phase_name(before),"after":phase_name(after),"exits":exits});
                    if let Some(late) = self.late.as_mut() {
                        if late.epoch == timer_epoch {
                            if late.deadline.is_some() {
                                return Err("quit-deadline-duplicate");
                            }
                            late.deadline = Some(*entry);
                        }
                        if late.epoch == gate_epoch {
                            data["binding"] = json!(late.binding);
                        }
                    }
                    ("gate-deadline", data)
                }
            };
            data["capturedNs"] = json!(captured);
            data["journalSequence"] = json!(entry.sequence);
            append_rows(self, vec![(event, data)])?;
            self.journal.push(*entry);
        }
        Ok(())
    }
    fn pending(read: &NativeRead) -> Result<SmokePending, &'static str> {
        let pending = read.observation.pending.ok_or("quit-late-not-pending")?;
        if read.observation.phase != SmokePhase::Preparing
            || pending.epoch != read.observation.epoch
            || pending.duration != crate::shell::quit::QUIT_DEADLINE
        {
            return Err("quit-late-pending-identity");
        }
        Ok(pending)
    }
    fn session(&self, epoch: u64, binding: &str) -> Result<&LateSession, &'static str> {
        self.late
            .as_ref()
            .filter(|late| late.epoch == epoch && late.binding == binding)
            .ok_or("quit-late-binding")
    }
    fn bound_data(&self, captured: Instant, phase: SmokePhase) -> Result<Value, &'static str> {
        let late = self.late.as_ref().ok_or("quit-late-binding")?;
        Ok(
            json!({"epoch":late.epoch,"binding":late.binding,"phase":phase_name(phase),
            "capturedNs":native_ns(self.origin()?,captured)?}),
        )
    }
}
impl Trace {
    fn reject<T>(&self, reason: &'static str) -> Result<T, &'static str> {
        self.0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .refuse(reason);
        Err(reason)
    }
    fn observe(&self, quit: &crate::shell::quit::QuitState) -> Result<NativeRead, &'static str> {
        let origin = self
            .0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .origin();
        match origin.and_then(|origin| read_native(quit, origin)) {
            Ok(read) => Ok(read),
            Err(reason) => self.reject(reason),
        }
    }
    fn commit<T>(
        &self,
        read: &NativeRead,
        action: impl FnOnce(&mut Inner) -> Result<T, &'static str>,
    ) -> Result<T, &'static str> {
        let mut inner = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        let result = inner.drain(read).and_then(|()| {
            if read.observation.entries.len() < inner.journal.len() {
                return Err("quit-native-observation-stale");
            }
            action(&mut inner)
        });
        if let Err(reason) = &result {
            inner.refuse(reason);
        }
        result
    }
    fn sync(&self, quit: &crate::shell::quit::QuitState) -> Result<NativeRead, &'static str> {
        let read = self.observe(quit)?;
        self.commit(&read, |_| Ok(()))?;
        Ok(read)
    }
    fn late_probe(
        &self,
        quit: &crate::shell::quit::QuitState,
        case: Case,
        probe: &Probe,
    ) -> Result<LateAction, &'static str> {
        if !selected(case) {
            return Err("quit-late-case");
        }
        let read = self.observe(quit)?;
        self.commit(&read, |inner| {
            if !inner.ready { return Err("quit-late-before-ready"); }
            if !(matches!(probe, Probe::Stayed(Stayed::Selected { .. })) && inner.late.is_some()) {
                Inner::pending(&read)?;
            }
            match probe {
                Probe::BindAttempt => {
                    let pending = Inner::pending(&read)?;
                    if inner.late.is_some() || inner.admissions.len() != 1 {
                        return Err("quit-late-bind-order");
                    }
                    let admission = &inner.admissions[0];
                    if admission.epoch != pending.epoch { return Err("quit-late-admission-identity"); }
                    let ceiling = admission.requested_at.checked_add(Duration::from_secs(10)).ok_or("quit-native-clock-unrepresentable")?;
                    let binding = format!("{:032x}", rand::random::<u128>());
                    inner.late = Some(LateSession { epoch: pending.epoch, binding: binding.clone(), arm: pending.armed_at,
                        duration: pending.duration, ceiling, batch: None, wait: WaitState::Unused, window: None,
                        ingress: None, injection: None, dispatch: None, cancel: None, deadline: None, returned: false });
                    let data = json!({"epoch":pending.epoch,"binding":binding,"phase":phase_name(read.observation.phase),"capturedNs":read.captured_ns});
                    append_rows(inner, vec![("attempt-bound",data)])?;
                    Ok(LateAction::Reply(json!({"binding":binding})))
                }
                Probe::PhaseBatch(batch) => {
                    let pending = Inner::pending(&read)?;
                    let late = inner.session(pending.epoch, &batch.binding)?;
                    if late.batch.is_some() || late.wait != WaitState::Unused { return Err("quit-phase-batch-order"); }
                    let decoded = decode_phase_batch(batch)?;
                    let last_ms = decoded.observations.last().and_then(|row| row["ms"].as_f64()).ok_or("quit-phase-batch-invalid")?;
                    let received_at = Instant::now();
                    let mut accepted = inner.bound_data(received_at,read.observation.phase)?;
                    accepted["lastSequence"] = json!(decoded.last_sequence);
                    let mut events: Vec<_> = decoded.observations.into_iter().map(|data| ("frontend",data)).collect();
                    events.push(("phase-batch-accepted",accepted));
                    append_rows(inner, events)?;
                    inner.late.as_mut().ok_or("quit-late-binding")?.batch = Some(BatchReceipt {
                        last_sequence:decoded.last_sequence,last_ms,received_at,
                        owner:json!({"ownerKey":batch.owner_key,"ownerInstance":batch.owner_instance}),
                    });
                    Ok(LateAction::Reply(Value::Null))
                }
                Probe::WaitLateWindow { binding } => {
                    let pending = Inner::pending(&read)?;
                    let late = inner.session(pending.epoch,binding)?;
                    if late.batch.is_none() || late.wait != WaitState::Unused { return Err("quit-wait-order"); }
                    let ticket = WaitReservation { epoch:late.epoch,binding:late.binding.clone() };
                    inner.late.as_mut().ok_or("quit-late-binding")?.wait = WaitState::Reserved;
                    Ok(LateAction::Wait(ticket))
                }
                Probe::Stayed(Stayed::Selected { ms,snapshot,binding,sequence }) => {
                    let late = inner.session(read.observation.epoch,binding)?;
                    let batch = late.batch.as_ref().ok_or("quit-stayed-order")?;
                    if case != Case::LateIpc150 || !late.returned || inner.stayed != 0
                        || read.observation.phase != SmokePhase::Idle || read.observation.pending.is_some()
                        || batch.last_sequence.checked_add(1) != Some(*sequence)
                        || !ms.is_finite() || *ms < batch.last_ms || *ms > 60000.0
                        || !late.cancel.is_some_and(|entry| matches!(entry.decision, SmokeDecision::Cancel {
                            epoch, before:SmokePhase::Preparing,after:SmokePhase::Idle,cancelled:true } if epoch == late.epoch))
                    { return Err("quit-stayed-order"); }
                    let object = snapshot.as_object().ok_or("quit-stayed-snapshot")?;
                    if object.len() != 8 || !object.contains_key("inFlightGeneration")
                        || snapshot["ownerKey"] != batch.owner["ownerKey"] || snapshot["ownerInstance"] != batch.owner["ownerInstance"]
                    { return Err("quit-stayed-snapshot"); }
                    let mut raw = snapshot.clone();
                    let object = raw.as_object_mut().ok_or("quit-stayed-snapshot")?;
                    object.remove("ownerKey"); object.remove("ownerInstance");
                    let actual:Snapshot = serde_json::from_value(raw).map_err(|_|"quit-stayed-snapshot")?;
                    if actual.latest_draft != "M93 controlled retained draft\n" || actual.generation != 1
                        || actual.acknowledged_generation != 0 || actual.in_flight_generation.is_some_and(|value| value != 1)
                        || actual.payload_sha256 != "11b39f197a8899b681e61889500aae56caf4c90a58e9ed6b777f2e0ee6e58074"
                    { return Err("quit-stayed-snapshot"); }
                    append_rows(inner, vec![("frontend",serde_json::to_value(probe).map_err(|_|"quit-probe-serialize")?)])?;
                    inner.stayed = 1;
                    Ok(LateAction::Reply(Value::Null))
                }
                _ => Err("quit-late-probe-order"),
            }
        })
    }
}

fn pending_matches(read: &NativeRead, late: &LateSession) -> Result<(), &'static str> {
    let pending = Inner::pending(read)?;
    if pending.epoch != late.epoch
        || pending.duration != late.duration
        || pending.armed_at != late.arm
    {
        return Err("quit-late-pending-identity");
    }
    Ok(())
}
impl Trace {
    fn admit_wait(
        &self,
        quit: &crate::shell::quit::QuitState,
        ticket: &WaitReservation,
    ) -> Result<Option<LateWindow>, &'static str> {
        let read = self.observe(quit)?;
        self.commit(&read, |inner| {
            let late = inner.session(ticket.epoch, &ticket.binding)?;
            pending_matches(&read, late)?;
            if late.wait != WaitState::Reserved {
                return Err("quit-wait-order");
            }
            let now = Instant::now();
            if now >= late.ceiling {
                return Err("quit-wait-ceiling");
            }
            let Some(arm) = late.arm else {
                return Ok(None);
            };
            if !inner
                .admissions
                .first()
                .is_some_and(|admission| admission.epoch == late.epoch && admission.emitted)
            {
                return Ok(None);
            }
            let due = arm
                .checked_add(late.duration)
                .ok_or("quit-native-clock-unrepresentable")?;
            let target = due
                .checked_sub(Duration::from_millis(250))
                .ok_or("quit-native-clock-unrepresentable")?;
            let upper = due
                .checked_sub(Duration::from_millis(150))
                .ok_or("quit-native-clock-unrepresentable")?;
            let batch = late.batch.as_ref().ok_or("quit-wait-order")?;
            if arm > read.observation.observed_at
                || batch.received_at > read.observation.observed_at
                || now >= target
                || target >= late.ceiling
            {
                return Err("quit-wait-headroom");
            }
            let window = LateWindow { arm, target, upper };
            let data = inner.bound_data(now, read.observation.phase)?;
            append_rows(inner, vec![("wait-admitted", data)])?;
            let late = inner.late.as_mut().ok_or("quit-late-binding")?;
            late.wait = WaitState::Admitted;
            late.window = Some(window);
            Ok(Some(window))
        })
    }
    fn release_wait(
        &self,
        quit: &crate::shell::quit::QuitState,
        ticket: &WaitReservation,
    ) -> Result<Value, &'static str> {
        let read = self.observe(quit)?;
        self.commit(&read, |inner| {
            let late = inner.session(ticket.epoch, &ticket.binding)?;
            pending_matches(&read, late)?;
            let window = late.window.ok_or("quit-wait-order")?;
            let now = Instant::now();
            if late.wait != WaitState::Admitted
                || late.arm != Some(window.arm)
                || read.observation.observed_at < window.target
                || read.observation.observed_at >= window.upper
                || now < window.target
                || now >= window.upper
            {
                return Err("quit-wait-window-missed");
            }
            let data = inner.bound_data(now, read.observation.phase)?;
            append_rows(inner, vec![("wait-released", data)])?;
            inner.late.as_mut().ok_or("quit-late-binding")?.wait = WaitState::Released(now);
            Ok(json!({"binding":ticket.binding}))
        })
    }
    fn cancel_ingress(
        &self,
        quit: &crate::shell::quit::QuitState,
        entered: Instant,
    ) -> Result<WaitReservation, &'static str> {
        let read = self.observe(quit)?;
        self.commit(&read, |inner| {
            let late = inner.late.as_ref().ok_or("quit-late-binding")?;
            pending_matches(&read, late)?;
            let window = late.window.ok_or("quit-cancel-order")?;
            let WaitState::Released(released) = late.wait else {
                return Err("quit-cancel-order");
            };
            if late.ingress.is_some()
                || entered < released
                || entered < window.target
                || entered >= window.upper
                || read.observation.observed_at < entered
                || read.observation.observed_at >= window.upper
                || Instant::now() >= window.upper
            {
                return Err("quit-cancel-window-missed");
            }
            let ticket = WaitReservation {
                epoch: late.epoch,
                binding: late.binding.clone(),
            };
            let data = inner.bound_data(entered, read.observation.phase)?;
            append_rows(inner, vec![("cancel-ingress", data)])?;
            let late = inner.late.as_mut().ok_or("quit-late-binding")?;
            late.ingress = Some(entered);
            late.wait = WaitState::Consumed;
            Ok(ticket)
        })
    }
    fn injection_entry(
        &self,
        quit: &crate::shell::quit::QuitState,
        ticket: &WaitReservation,
        case: Case,
        entered: Instant,
    ) -> Result<(), &'static str> {
        let read = self.observe(quit)?;
        self.commit(&read, |inner| {
            let late = inner.session(ticket.epoch, &ticket.binding)?;
            if read.observation.epoch != late.epoch
                || late.wait != WaitState::Consumed
                || late.injection.is_some()
                || entered < late.ingress.ok_or("quit-cancel-order")?
            {
                return Err("quit-cancel-order");
            }
            let mut data = inner.bound_data(entered, read.observation.phase)?;
            data["configuredMs"] = json!(case.delay());
            append_rows(inner, vec![("cancel-injection-enter", data)])?;
            inner.late.as_mut().ok_or("quit-late-binding")?.injection = Some(entered);
            Ok(())
        })
    }
    fn cancel_dispatch(
        &self,
        quit: &crate::shell::quit::QuitState,
        ticket: &WaitReservation,
        case: Case,
    ) -> Result<(), &'static str> {
        let read = self.observe(quit)?;
        self.commit(&read, |inner| {
            let late = inner.session(ticket.epoch,&ticket.binding)?;
            let now = Instant::now();
            if read.observation.epoch != late.epoch || late.dispatch.is_some()
                || now.checked_duration_since(late.injection.ok_or("quit-cancel-order")?)
                    .is_none_or(|elapsed| elapsed < Duration::from_millis(case.delay()))
            { return Err("quit-cancel-order"); }
            match read.observation.phase {
                SmokePhase::Preparing => pending_matches(&read,late)?,
                SmokePhase::Exiting if late.deadline.is_some_and(|entry| matches!(entry.decision,
                    SmokeDecision::Deadline { timer_epoch,gate_epoch,exits:true,.. } if timer_epoch == late.epoch && gate_epoch == late.epoch)) => {},
                _ => return Err("quit-cancel-phase"),
            }
            let mut data = inner.bound_data(now,read.observation.phase)?;
            data["configuredMs"] = json!(case.delay());
            data["injection"] = json!("pre-dispatch-native-delay");
            append_rows(inner, vec![("cancel-dispatch",data)])?;
            inner.late.as_mut().ok_or("quit-late-binding")?.dispatch = Some(now);
            Ok(())
        })
    }
    fn cancel_return(
        &self,
        quit: &crate::shell::quit::QuitState,
        ticket: &WaitReservation,
    ) -> Result<(), &'static str> {
        let read = self.observe(quit)?;
        self.commit(&read, |inner| {
            let late = inner.session(ticket.epoch, &ticket.binding)?;
            let cancel = late.cancel.ok_or("quit-cancel-decision-missing")?;
            if read.observation.epoch != late.epoch
                || late.returned
                || cancel.captured_at < late.dispatch.ok_or("quit-cancel-order")?
            {
                return Err("quit-cancel-order");
            }
            let data = inner.bound_data(Instant::now(), read.observation.phase)?;
            append_rows(inner, vec![("cancel-return", data)])?;
            inner.late.as_mut().ok_or("quit-late-binding")?.returned = true;
            Ok(())
        })
    }
}
// Only this owned worker sleeps for release. No webview, gate or Trace guard crosses sleep.
fn wait_late_window(app: AppHandle, ticket: WaitReservation) -> Result<Value, &'static str> {
    let window = loop {
        if let Some(window) = app.state::<Trace>().admit_wait(&app.state(), &ticket)? {
            break window;
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    if let Some(left) = window.target.checked_duration_since(Instant::now()) {
        std::thread::sleep(left);
    }
    app.state::<Trace>().release_wait(&app.state(), &ticket)
}
async fn selected_cancel(
    app: &AppHandle,
    case: Case,
    entered: Instant,
) -> Result<(), &'static str> {
    let ticket = app.state::<Trace>().cancel_ingress(&app.state(), entered)?;
    let handle = app.clone();
    let ticket = tauri::async_runtime::spawn_blocking(move || {
        let entered = Instant::now();
        handle
            .state::<Trace>()
            .injection_entry(&handle.state(), &ticket, case, entered)?;
        std::thread::sleep(Duration::from_millis(case.delay()));
        Ok::<_, &'static str>(ticket)
    })
    .await
    .map_err(|_| "quit-delay-worker")??;
    app.state::<Trace>()
        .cancel_dispatch(&app.state(), &ticket, case)?;
    crate::shell::quit::cancel_quit(app.state());
    app.state::<Trace>().cancel_return(&app.state(), &ticket)
}

fn selected_request(app: &AppHandle) -> Result<(), &'static str> {
    let call = {
        let state = app.state::<Trace>();
        let mut inner = state.0.lock().unwrap_or_else(PoisonError::into_inner);
        if inner.broken || inner.frozen || inner.outstanding.is_some() || inner.call >= 2 {
            return Err("quit-request-order");
        }
        inner.call += 1;
        let call = inner.call;
        inner.outstanding = Some((call, Instant::now()));
        append_rows(&mut inner, vec![("request-before", json!({"call":call}))])?;
        call
    };
    crate::shell::quit::request(app);
    let state = app.state::<Trace>();
    let read = state.observe(&app.state())?;
    state.commit(&read, |inner| {
        if inner.outstanding.is_some()
            || inner
                .admissions
                .last()
                .is_none_or(|admission| admission.call != call)
        {
            return Err("quit-admission-missing");
        }
        append_rows(inner, vec![("request-after", json!({"call":call}))])
    })
}
fn selected_emission(app: &AppHandle) -> Result<(), &'static str> {
    let state = app.state::<Trace>();
    let read = state.observe(&app.state())?;
    state.commit(&read, |inner| {
        let index = inner
            .admissions
            .iter()
            .position(|admission| admission.call == inner.call)
            .ok_or("quit-emission-unowned")?;
        let admission = &inner.admissions[index];
        if admission.emitted
            || admission.epoch != read.observation.epoch
            || inner.emitted.checked_add(1) != Some(admission.attempt)
        {
            return Err("quit-emission-order");
        }
        let data = json!({"call":admission.call,"attempt":inner.emitted+1,"epoch":admission.epoch});
        append_rows(inner, vec![("emitted-request", data)])?;
        inner.emitted += 1;
        inner.admissions[index].emitted = true;
        Ok(())
    })
}
fn selected_coordinator(app: &AppHandle, case: Case) -> Result<(), &'static str> {
    let first = Instant::now();
    let ceiling = first
        .checked_add(Duration::from_secs(10))
        .ok_or("quit-native-clock-unrepresentable")?;
    selected_request(app)?;
    loop {
        let state = app.state::<Trace>();
        let read = state.sync(&app.state())?;
        let survived = state.commit(&read, |inner| {
            let Some(late) = inner.late.as_ref() else { return Ok(false); };
            Ok(case == Case::LateIpc150 && inner.stayed == 1 && late.returned
                && read.observation.phase == SmokePhase::Idle && read.observation.epoch == late.epoch
                && late.deadline.is_some_and(|entry| matches!(entry.decision,SmokeDecision::Deadline {
                    timer_epoch,gate_epoch,before:SmokePhase::Idle,after:SmokePhase::Idle,exits:false
                } if timer_epoch == late.epoch && gate_epoch == late.epoch))
                && Instant::now().checked_duration_since(first).is_some_and(|elapsed| elapsed >= Duration::from_millis(5300)))
        })?;
        if survived {
            break;
        }
        if Instant::now() >= ceiling {
            return Err("quit-first-stay-ceiling");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let state = app.state::<Trace>();
    let read = state.observe(&app.state())?;
    state.commit(&read, |inner| {
        let late = inner.late.as_ref().ok_or("quit-late-binding")?;
        if read.observation.phase != SmokePhase::Idle || read.observation.epoch != late.epoch {
            return Err("quit-survival-identity");
        }
        let data = json!({"call":1,"epoch":late.epoch});
        append_rows(inner, vec![("survived", data)])
    })?;
    selected_request(app)?;
    let read = state.observe(&app.state())?;
    let epoch = state.commit(&read, |inner| {
        let pending = Inner::pending(&read)?;
        let second = inner
            .admissions
            .get(1)
            .ok_or("quit-second-admission-missing")?;
        if second.epoch != pending.epoch || !second.emitted {
            return Err("quit-second-emission-missing");
        }
        append_rows(
            inner,
            vec![("probe-cancel-dispatch", json!({"epoch":pending.epoch}))],
        )?;
        Ok(pending.epoch)
    })?;
    crate::shell::quit::cancel_quit(app.state());
    let read = state.observe(&app.state())?;
    state.commit(&read, |inner| {
        if read.observation.epoch != epoch || read.observation.phase != SmokePhase::Idle
            || !inner.journal.iter().any(|entry| matches!(entry.decision, SmokeDecision::Cancel {
                epoch:actual,before:SmokePhase::Preparing,after:SmokePhase::Idle,cancelled:true } if actual == epoch))
        { return Err("quit-second-cancel-missing"); }
        append_rows(inner,vec![("probe-cancel-return",json!({"epoch":epoch}))])
    })?;
    complete(app);
    Ok(())
}

fn active(app: &AppHandle) -> Option<Case> {
    app.state::<SmokePaths>().quit
}
fn record(app: &AppHandle, event: &str, data: Value) {
    let state = app.state::<Trace>();
    let mut trace = state.0.lock().unwrap_or_else(PoisonError::into_inner);
    let _ = append_rows(&mut trace, vec![(event, data)]);
}
pub(super) fn enabled(app: &AppHandle) -> bool {
    active(app).is_some()
}
fn fail(app: &AppHandle, reason: &'static str) {
    record(app, "fixture-error", json!({"reason":reason}));
    app.exit(2);
}
fn request(app: &AppHandle) {
    let call = {
        let state = app.state::<Trace>();
        let mut trace = state.0.lock().unwrap_or_else(PoisonError::into_inner);
        trace.call += 1;
        trace.call
    };
    record(app, "request-before", json!({"call":call}));
    crate::shell::quit::request(app);
    record(app, "request-after", json!({"call":call}));
}
fn wait(app: &AppHandle, ceiling: Instant, condition: impl Fn(&Inner) -> bool) -> bool {
    while Instant::now() < ceiling {
        if condition(
            &app.state::<Trace>()
                .0
                .lock()
                .unwrap_or_else(PoisonError::into_inner),
        ) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    false
}
fn complete(app: &AppHandle) {
    record(app, "fixture-complete-intent", json!({}));
    app.exit(0);
}
fn coordinator(app: AppHandle, case: Case) {
    if selected(case) {
        if let Err(reason) = selected_coordinator(&app, case) {
            let _ = app.state::<Trace>().reject::<()>(reason);
            app.exit(2);
        }
        return;
    }
    if case == Case::HungWebview {
        if !wait(&app, Instant::now() + Duration::from_secs(5), |t| t.hang) {
            fail(&app, "hang-handshake-missing");
            return;
        }
        std::thread::sleep(Duration::from_millis(200));
        request(&app);
        std::thread::sleep(Duration::from_secs(10));
        fail(&app, "hung-post-request-ceiling");
        return;
    }
    let first = Instant::now();
    request(&app);
    if case == Case::PendingOwner {
        std::thread::sleep(Duration::from_millis(100));
        request(&app);
    }
    if !wait(&app, first + Duration::from_secs(10), |t| t.stayed >= 1) {
        fail(&app, "first-stay-not-observed");
        return;
    }
    match case {
        Case::SecondQuit => {
            std::thread::sleep(Duration::from_secs(1));
            request(&app); // real host override: first canceled timer must not end this attempt.
        }
        Case::ExpiredSecondQuit => {
            std::thread::sleep(Duration::from_secs(31));
            let second = Instant::now();
            request(&app);
            if !wait(&app, second + Duration::from_secs(6), |t| t.stayed >= 2) {
                fail(&app, "expired-second-stay-missing");
                return;
            }
            if let Some(left) =
                (second + Duration::from_millis(5300)).checked_duration_since(Instant::now())
            {
                std::thread::sleep(left);
            }
            record(&app, "survived", json!({"call":2}));
            complete(&app);
        }
        _ => {
            if let Some(left) =
                (first + Duration::from_millis(5300)).checked_duration_since(Instant::now())
            {
                std::thread::sleep(left);
            }
            record(&app, "survived", json!({"call":1}));
            // This is a real extra attempt, accounted for in the trace. Native cancellation
            // immediately follows re-admission, without changing the production gate.
            request(&app);
            record(&app, "probe-cancel-dispatch", json!({}));
            crate::shell::quit::cancel_quit(app.state());
            record(&app, "probe-cancel-return", json!({}));
            complete(&app);
        }
    }
}
pub(super) fn bootstrap(app: &AppHandle, window: &WebviewWindow) -> Result<Value, &'static str> {
    let case = active(app).ok_or("not-quit-profile")?;
    if app
        .state::<SmokePaths>()
        .started
        .swap(true, std::sync::atomic::Ordering::SeqCst)
    {
        return Err("quit-bootstrap-repeated");
    }
    window
        .set_size(tauri::LogicalSize::new(900.0, 600.0))
        .map_err(|_| "quit-window-size")?;
    let size = window.inner_size().map_err(|_| "quit-window-read")?;
    let scale = window.scale_factor().map_err(|_| "quit-window-scale")?;
    let mut start = json!({"case":case,"root":app.state::<SmokePaths>().root,
        "binary":std::env::current_exe().ok(),"compiledInputs":compiled_inputs(),
        "windowPhysical":{"width":size.width,"height":size.height},"scaleFactor":scale,"injection":"controlled synthetic writer and fixed delays"});
    if selected(case) {
        start["measurementContract"] = json!("late-window-v1");
    }
    record(app, "case-start", start);
    let handle = app.clone();
    app.listen(crate::shell::quit::QUIT_REQUESTED_EVENT, move |_| {
        if selected(case) {
            if let Err(reason) = selected_emission(&handle) {
                let _ = handle.state::<Trace>().reject::<()>(reason);
                handle.exit(2);
            }
            return;
        }
        let (call, attempt) = {
            let state = handle.state::<Trace>();
            let mut trace = state.0.lock().unwrap_or_else(PoisonError::into_inner);
            trace.emitted += 1;
            (trace.call, trace.emitted)
        };
        record(
            &handle,
            "emitted-request",
            json!({"call":call,"attempt":attempt}),
        );
    });
    Ok(json!({"profile":"quit-timing","case":case,"nativePid":std::process::id()}))
}
// This guard runs before Trace acquisition or any legacy state mutation.
fn legacy_stayed_snapshot(probe: &Probe) -> Result<Option<&Snapshot>, &'static str> {
    match probe {
        Probe::Stayed(Stayed::Legacy { snapshot, .. }) => Ok(Some(snapshot)),
        Probe::Stayed(Stayed::Selected { .. }) => Err("quit-late-consumer-unimplemented"),
        _ => Ok(None),
    }
}

pub(super) async fn probe(app: &AppHandle, probe: Probe) -> Result<Value, &'static str> {
    let case = active(app).ok_or("not-quit-profile")?;
    if !app
        .state::<SmokePaths>()
        .started
        .load(std::sync::atomic::Ordering::SeqCst)
    {
        return Err("quit-probe-before-bootstrap");
    }
    if selected(case) {
        if matches!(&probe, Probe::Ready) {
            {
                let state = app.state::<Trace>();
                let mut trace = state.0.lock().unwrap_or_else(PoisonError::into_inner);
                if trace.ready || trace.broken || trace.frozen {
                    trace.refuse("quit-ready-repeated");
                    return Err("quit-ready-repeated");
                }
                append_rows(&mut trace, vec![("frontend", json!({"kind":"ready"}))])?;
                trace.ready = true;
            }
            let handle = app.clone();
            std::thread::spawn(move || coordinator(handle, case));
            return Ok(Value::Null);
        }
        let action = app
            .state::<Trace>()
            .late_probe(&app.state(), case, &probe)?;
        return match action {
            LateAction::Reply(value) => Ok(value),
            LateAction::Wait(ticket) => {
                let handle = app.clone();
                match tauri::async_runtime::spawn_blocking(move || wait_late_window(handle, ticket))
                    .await
                {
                    Ok(result) => result,
                    Err(_) => app.state::<Trace>().reject("quit-wait-worker"),
                }
            }
        };
    }
    // Legacy cases retain their closed Snapshot validation and old observations.
    let legacy_stayed = legacy_stayed_snapshot(&probe)?;
    let mut launch = false;
    {
        let state = app.state::<Trace>();
        let mut trace = state.0.lock().unwrap_or_else(PoisonError::into_inner);
        match &probe {
            Probe::Ready if !trace.ready => {
                trace.ready = true;
                launch = true;
            }
            Probe::Ready => return Err("quit-ready-repeated"),
            Probe::BindAttempt | Probe::PhaseBatch(_) | Probe::WaitLateWindow { .. } => {
                return Err("quit-late-consumer-unimplemented");
            }
            Probe::Stage { .. } | Probe::Stayed(_) | Probe::HangArmed { .. } => {
                let (ms, snapshot) = match &probe {
                    Probe::Stage { ms, snapshot, .. } | Probe::HangArmed { ms, snapshot } => {
                        (ms, snapshot)
                    }
                    Probe::Stayed(Stayed::Legacy { ms, .. }) => {
                        (ms, legacy_stayed.ok_or("quit-probe-bounds-or-order")?)
                    }
                    _ => return Err("quit-probe-bounds-or-order"),
                };
                let before_ready = matches!(
                    &probe,
                    Probe::Stage {
                        stage: Stage::Writer | Stage::Retry | Stage::ShellMounted,
                        ..
                    }
                );
                if (!trace.ready && !before_ready)
                    || !ms.is_finite()
                    || *ms < 0.0
                    || *ms > 60000.0
                    || snapshot.latest_draft.len() > 128
                    || snapshot.generation > 4
                    || snapshot.payload_sha256.len() != 64
                    || !snapshot
                        .payload_sha256
                        .bytes()
                        .all(|b| b.is_ascii_hexdigit())
                {
                    trace.broken = true;
                    return Err("quit-probe-bounds-or-order");
                }
                match &probe {
                    Probe::Stayed(_) if trace.stayed < 2 => trace.stayed += 1,
                    Probe::Stayed(_) => {
                        trace.broken = true;
                        return Err("quit-stay-cap");
                    }
                    Probe::HangArmed { .. } if case == Case::HungWebview && !trace.hang => {
                        trace.hang = true
                    }
                    Probe::HangArmed { .. } => {
                        trace.broken = true;
                        return Err("quit-hang-order");
                    }
                    _ => {}
                }
            }
        }
    }
    record(
        app,
        "frontend",
        serde_json::to_value(probe).map_err(|_| "quit-probe-serialize")?,
    );
    if launch {
        let handle = app.clone();
        std::thread::spawn(move || coordinator(handle, case));
    }
    Ok(Value::Null)
}
#[tauri::command(rename = "cancel_quit")]
pub(super) async fn native_smoke_cancel_quit(app: AppHandle) -> Result<(), &'static str> {
    let entered = Instant::now();
    let case = active(&app).ok_or("not-quit-profile")?;
    if selected(case) {
        return match selected_cancel(&app, case, entered).await {
            Ok(()) => Ok(()),
            Err(reason) => app.state::<Trace>().reject(reason),
        };
    }
    record(&app, "cancel-ingress", json!({}));
    if case.delay() > 0 {
        tauri::async_runtime::spawn_blocking(move || {
            std::thread::sleep(Duration::from_millis(case.delay()))
        })
        .await
        .map_err(|_| "quit-delay-worker")?;
    }
    record(
        &app,
        "cancel-dispatch",
        json!({"injection":"pre-dispatch-native-delay","configuredMs":case.delay()}),
    );
    crate::shell::quit::cancel_quit(app.state());
    record(&app, "cancel-return", json!({}));
    Ok(())
}
#[tauri::command(rename = "finish_quit")]
pub(super) fn native_smoke_finish_quit(app: AppHandle) -> Result<(), String> {
    if !enabled(&app) {
        return Err("not-quit-profile".into());
    }
    record(&app, "finish-dispatch", json!({}));
    let result = crate::shell::quit::finish_quit(app.clone(), app.state());
    record(
        &app,
        "finish-result",
        json!({"ok":result.is_ok(),"error":result.as_ref().err()}),
    );
    result
}
pub(super) fn watchdog(app: &AppHandle) {
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(60));
        record(&handle, "watchdog-intent", json!({}));
        handle.exit(2);
    });
}
pub(super) fn exit_requested(app: &AppHandle) {
    if active(app).is_some_and(selected) {
        let _ = app.state::<Trace>().sync(&app.state());
    }
    record(app, "exit-requested", json!({}));
}
pub(super) fn exit(app: &AppHandle) {
    let late = active(app).is_some_and(selected);
    if late {
        let _ = app.state::<Trace>().sync(&app.state());
    }
    let report = {
        let state = app.state::<Trace>();
        let mut trace = state.0.lock().unwrap_or_else(PoisonError::into_inner);
        if trace.frozen {
            return;
        }
        let _ = append_rows(&mut trace, vec![("exit", json!({}))]);
        if late {
            trace.frozen = true;
        }
        let mut report = json!({"format":1,"profile":"quit-timing","case":active(app),"nativePid":std::process::id(),
            "compiledInputs":compiled_inputs(),"trace":trace.rows,"traceBroken":trace.broken,
            "claims":{"controlledWriter":true,"controlledLegacyCleanup":true,"realEditorUi":false,
                "realDiskFailure":false,"physicalQuitShortcut":false,"packagedAcceptance":false}});
        if late {
            report["format"] = json!(2);
            report["measurementContract"] = json!("late-window-v1");
        }
        report
    };
    if let Ok(bytes) = serde_json::to_vec(&report) {
        if bytes.len() <= 65536 {
            let _ = create(&app.state::<SmokePaths>().root.join("report.json"), &bytes);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::Case;
    use std::ffi::OsStr;

    // Literal CLI/wire/delay expectations at the native-to-frontend boundary.
    const CASES: [(&str, &str, Case, u64); 8] = [
        ("--quit-failed-owner", "failed-owner", Case::FailedOwner, 0),
        (
            "--quit-pending-owner",
            "pending-owner",
            Case::PendingOwner,
            0,
        ),
        (
            "--quit-late-unresolved",
            "late-unresolved",
            Case::LateUnresolved,
            0,
        ),
        ("--quit-late-ipc-150", "late-ipc-150", Case::LateIpc150, 150),
        ("--quit-late-ipc-350", "late-ipc-350", Case::LateIpc350, 350),
        ("--quit-second-quit", "second-quit", Case::SecondQuit, 0),
        (
            "--quit-expired-second-quit",
            "expired-second-quit",
            Case::ExpiredSecondQuit,
            0,
        ),
        ("--quit-hung-webview", "hung-webview", Case::HungWebview, 0),
    ];

    #[test]
    fn case_flags_select_exact_variants() {
        let actual: Vec<_> = CASES
            .iter()
            .map(|&(flag, _, _, _)| (flag, Case::parse(OsStr::new(flag))))
            .collect();
        let expected: Vec<_> = CASES
            .iter()
            .map(|&(flag, _, case, _)| (flag, Some(case)))
            .collect();
        assert_eq!(actual, expected);
    }

    #[test]
    fn case_serialization_uses_closed_wire_vocabulary() {
        let actual: Vec<_> = CASES
            .iter()
            .map(|&(_, wire, case, _)| (wire, serde_json::to_value(case).expect("Case serializes")))
            .collect();
        let expected: Vec<_> = CASES
            .iter()
            .map(|&(_, wire, _, _)| (wire, serde_json::Value::String(wire.into())))
            .collect();
        assert_eq!(actual, expected);
    }

    #[test]
    fn case_deserialization_accepts_closed_wire_vocabulary() {
        let actual: Vec<_> = CASES
            .iter()
            .map(|&(_, wire, _, _)| {
                (
                    wire,
                    serde_json::from_value::<Case>(serde_json::Value::String(wire.into()))
                        .map_err(|error| error.to_string()),
                )
            })
            .collect();
        let expected: Vec<(&str, Result<Case, String>)> = CASES
            .iter()
            .map(|&(_, wire, case, _)| (wire, Ok(case)))
            .collect();
        assert_eq!(actual, expected);
    }

    #[test]
    fn case_delay_uses_literal_milliseconds() {
        let actual: Vec<_> = CASES
            .iter()
            .map(|&(_, wire, case, _)| (wire, case.delay()))
            .collect();
        let expected: Vec<_> = CASES
            .iter()
            .map(|&(_, wire, _, delay)| (wire, delay))
            .collect();
        assert_eq!(actual, expected);
    }

    #[test]
    fn case_wire_aliases_are_rejected() {
        let aliases = ["late-ipc150", "late-ipc350"];
        let actual: Vec<_> = aliases
            .iter()
            .map(|&wire| {
                (
                    wire,
                    serde_json::from_value::<Case>(serde_json::Value::String(wire.into())).is_err(),
                )
            })
            .collect();
        assert_eq!(actual, [("late-ipc150", true), ("late-ipc350", true)]);
    }

    #[test]
    fn case_cli_aliases_are_rejected() {
        for flag in ["--quit-late-ipc150", "--quit-late-ipc350"] {
            assert_eq!(Case::parse(OsStr::new(flag)), None, "{flag}");
        }
    }

    #[test]
    fn quit_commands_keep_production_ipc_names() {
        // These generated names are the match arms used by generate_handler!.
        assert_eq!(
            super::__tauri_command_name_native_smoke_cancel_quit!(),
            "cancel_quit"
        );
        assert_eq!(
            super::__tauri_command_name_native_smoke_finish_quit!(),
            "finish_quit"
        );
    }

    // Wire decoding only: these literal frontend observations install no native authority.
    fn wire_snapshot(dirty: bool) -> serde_json::Value {
        let (draft, generation, hash) = if dirty {
            (
                "M93 controlled retained draft\n",
                1,
                "11b39f197a8899b681e61889500aae56caf4c90a58e9ed6b777f2e0ee6e58074",
            )
        } else {
            (
                "M93 controlled clean source\n",
                0,
                "dbbcd31435c629a3e3654a3b9f61127f81b9666c20ac1f8220c2c0091bc659c1",
            )
        };
        serde_json::json!({
            "latestDraft": draft,
            "generation": generation,
            "acknowledgedGeneration": 0,
            "inFlightGeneration": null,
            "failed": false,
            "payloadSha256": hash,
        })
    }

    fn wire_phase_batch() -> serde_json::Value {
        serde_json::json!({
            "kind": "phase-batch",
            "binding": "opaque-wire-token",
            "format": 1,
            "ownerKey": {
                "vaultId": "m93-controlled-vault",
                "path": "controlled.md",
                "ownerId": "m93-native-quit",
            },
            "ownerInstance": "retained-1",
            "snapshots": [wire_snapshot(false), wire_snapshot(true)],
            "events": [
                [0, 0.0, "mount", 0, 1],
                [1, 10.0, "enter", 0, "flush", 2500],
                [2, 20.0, "complete", 0, "flush", 2500,
                    {"kind": "fulfilled", "value": {"outcomes": [], "unresolvedOwnerIds": []}}],
                [3, 21.0, "enter", 0, "settle-first", 750],
                [4, 30.0, "complete", 0, "settle-first", 750,
                    {"kind": "fulfilled", "value": true}],
                [5, 31.0, "enter", 0, "leave", 750],
                [6, 32.0, "cleanup", 1],
                [7, 40.0, "complete", 1, "leave", 750,
                    {"kind": "fulfilled", "value": true}],
                [8, 41.0, "enter", 1, "settle-second", 750],
                [9, 50.0, "complete", 1, "settle-second", 750,
                    {"kind": "fulfilled", "value": true}],
                [10, 51.0, "end", 1, true],
                [11, 60.0, "mount", 1, 2],
                [12, 61.0, "cancel", 1],
            ],
            "broken": null,
        })
    }

    #[test]
    fn late_window_wire_messages_decode_without_frontend_authority() {
        let messages = [
            serde_json::json!({"kind": "bind-attempt"}),
            wire_phase_batch(),
            serde_json::json!({"kind": "wait-late-window", "binding": "opaque-wire-token"}),
        ];
        let mut failures = Vec::new();
        for message in messages {
            assert!(serde_json::to_vec(&message).unwrap().len() <= 2048);
            match serde_json::from_value::<super::Probe>(message.clone()) {
                Ok(probe) => {
                    let retained = serde_json::to_value(probe).expect("decoded Probe serializes");
                    if retained != message {
                        failures.push(format!("wire fields lost: {message} -> {retained}"));
                    }
                }
                Err(error) => failures.push(format!("{}: {error}", message["kind"])),
            }
        }
        assert!(
            failures.is_empty(),
            "late-window wire decoding: {failures:?}"
        );
    }

    #[test]
    fn late_stayed_wire_retains_binding_sequence_and_owner_identity() {
        let mut snapshot = wire_snapshot(true);
        snapshot["ownerKey"] = serde_json::json!({
            "vaultId": "m93-controlled-vault",
            "path": "controlled.md",
            "ownerId": "m93-native-quit",
        });
        snapshot["ownerInstance"] = serde_json::json!("retained-1");
        let message = serde_json::json!({
            "kind": "stayed",
            "binding": "opaque-wire-token",
            "sequence": 13,
            "ms": 4870.0,
            "snapshot": snapshot,
        });
        let decoded = serde_json::from_value::<super::Probe>(message.clone());
        assert!(
            decoded.is_ok(),
            "selected Stayed wire refused: {:?}",
            decoded.as_ref().err()
        );
        let retained = serde_json::to_value(decoded.unwrap()).expect("decoded Stayed serializes");
        assert_eq!(
            retained, message,
            "binding, sequence and owner fields survive decoding"
        );
    }

    #[test]
    fn legacy_probe_wire_remains_closed() {
        let snapshot = wire_snapshot(false);
        let stage = serde_json::json!({
            "kind": "stage", "stage": "shell-mounted", "edge": "complete",
            "ms": 0.0, "snapshot": snapshot.clone(),
        });
        let messages = [
            serde_json::json!({"kind": "ready"}),
            stage.clone(),
            serde_json::json!({"kind": "stayed", "ms": 1.0, "snapshot": snapshot.clone()}),
            serde_json::json!({"kind": "hang-armed", "ms": 2.0, "snapshot": snapshot}),
        ];
        for message in messages {
            let decoded = serde_json::from_value::<super::Probe>(message.clone())
                .unwrap_or_else(|error| panic!("legacy wire refused: {error}"));
            assert_eq!(serde_json::to_value(decoded).unwrap(), message);
        }
        let mut unknown_field = stage.clone();
        unknown_field["unexpected"] = serde_json::json!(true);
        let mut unknown_snapshot_field = stage.clone();
        unknown_snapshot_field["snapshot"]["unexpected"] = serde_json::json!(true);
        let mut unknown_kind = stage;
        unknown_kind["kind"] = serde_json::json!("stage-alias");
        for invalid in [unknown_field, unknown_snapshot_field, unknown_kind] {
            assert!(serde_json::from_value::<super::Probe>(invalid).is_err());
        }
    }

    fn phase_batch_input(message: serde_json::Value) -> super::PhaseBatch {
        match serde_json::from_value::<super::Probe>(message).expect("batch wire decodes") {
            super::Probe::PhaseBatch(batch) => batch,
            _ => panic!("expected phase-batch wire variant"),
        }
    }

    #[test]
    fn phase_batch_accepts_confirmed_leave_from_current_quit_host() {
        let mut message = wire_phase_batch();
        message["events"][7][6]["value"] = serde_json::json!(true);
        let batch = phase_batch_input(message);
        assert!(super::decode_phase_batch(&batch).is_ok(), "the actual leave step confirms completion with true");
    }

    #[test]
    fn phase_batch_refuses_ambiguous_void_leave_from_old_quit_host() {
        let mut message = wire_phase_batch();
        message["events"][7][6]["value"] = serde_json::Value::Null;
        let batch = phase_batch_input(message);
        assert!(super::decode_phase_batch(&batch).is_err(), "void is not confirmation that the shell finished leaving");
    }

    #[test]
    fn compact_batch_preserves_frontend_observations() {
        let mut message = wire_phase_batch();
        let events = message["events"].as_array_mut().unwrap();
        events.insert(
            3,
            serde_json::json!([3, 20.5, "check", 0, "pageWriteFailures", 0]),
        );
        events.insert(8, serde_json::json!([8, 33.0, "writer", 1]));
        for (sequence, event) in events.iter_mut().enumerate() {
            event[0] = serde_json::json!(sequence);
        }
        assert!(serde_json::to_vec(&message).unwrap().len() <= 2048);
        let batch = phase_batch_input(message);
        let before = serde_json::to_value(&batch).unwrap();
        let decoded = super::decode_phase_batch(&batch);
        assert!(
            decoded.is_ok(),
            "complete compact batch refused: {:?}",
            decoded.as_ref().err()
        );
        let decoded = decoded.unwrap();
        // Expectations are literal observations, not calculated by the decoder.
        let expected_row = |sequence: u64, ms: f64, dirty: bool, mut data: serde_json::Value| {
            let mut snapshot = wire_snapshot(dirty);
            snapshot["ownerKey"] = serde_json::json!({
                "vaultId": "m93-controlled-vault", "path": "controlled.md", "ownerId": "m93-native-quit"
            });
            snapshot["ownerInstance"] = serde_json::json!("retained-1");
            data["sequence"] = serde_json::json!(sequence);
            data["ms"] = serde_json::json!(ms);
            data["binding"] = serde_json::json!("opaque-wire-token");
            data["snapshot"] = snapshot;
            data
        };
        let expected = vec![
            expected_row(
                0,
                0.0,
                false,
                serde_json::json!({"kind":"stage","stage":"shell-mounted","edge":"complete","mount":1}),
            ),
            expected_row(
                1,
                10.0,
                false,
                serde_json::json!({"kind":"stage","stage":"flush","edge":"enter","budgetMs":2500}),
            ),
            expected_row(
                2,
                20.0,
                false,
                serde_json::json!({"kind":"stage","stage":"flush","edge":"complete","budgetMs":2500,
                "result":{"kind":"fulfilled","value":{"outcomes":[],"unresolvedOwnerIds":[]}}}),
            ),
            expected_row(
                3,
                20.5,
                false,
                serde_json::json!({"kind":"dependency-check","dependency":"pageWriteFailures","value":0}),
            ),
            expected_row(
                4,
                21.0,
                false,
                serde_json::json!({"kind":"stage","stage":"settle-first","edge":"enter","budgetMs":750}),
            ),
            expected_row(
                5,
                30.0,
                false,
                serde_json::json!({"kind":"stage","stage":"settle-first","edge":"complete","budgetMs":750,
                "result":{"kind":"fulfilled","value":true}}),
            ),
            expected_row(
                6,
                31.0,
                false,
                serde_json::json!({"kind":"stage","stage":"leave","edge":"enter","budgetMs":750}),
            ),
            expected_row(
                7,
                32.0,
                true,
                serde_json::json!({"kind":"stage","stage":"cleanup","edge":"complete"}),
            ),
            expected_row(
                8,
                33.0,
                true,
                serde_json::json!({"kind":"stage","stage":"writer","edge":"enter"}),
            ),
            expected_row(
                9,
                40.0,
                true,
                serde_json::json!({"kind":"stage","stage":"leave","edge":"complete","budgetMs":750,
                "result":{"kind":"fulfilled","value":true}}),
            ),
            expected_row(
                10,
                41.0,
                true,
                serde_json::json!({"kind":"stage","stage":"settle-second","edge":"enter","budgetMs":750}),
            ),
            expected_row(
                11,
                50.0,
                true,
                serde_json::json!({"kind":"stage","stage":"settle-second","edge":"complete","budgetMs":750,
                "result":{"kind":"fulfilled","value":true}}),
            ),
            expected_row(
                12,
                51.0,
                true,
                serde_json::json!({"kind":"end-leaving","hasUnresolved":true}),
            ),
            expected_row(
                13,
                60.0,
                true,
                serde_json::json!({"kind":"stage","stage":"shell-mounted","edge":"complete","mount":2}),
            ),
            expected_row(14, 61.0, true, serde_json::json!({"kind":"cancel-wrapper"})),
        ];
        assert_eq!(decoded.last_sequence, 14);
        assert_eq!(decoded.observations, expected);
        assert_eq!(serde_json::to_value(&batch).unwrap(), before);
    }

    #[test]
    fn compact_batch_refuses_incomplete_ambiguous_or_over_cap_evidence() {
        type Mutation = (&'static str, fn(&mut serde_json::Value));
        let mutations: &[Mutation] = &[
            ("missing-restoration", |v| {
                v["events"].as_array_mut().unwrap().remove(11);
            }),
            ("duplicate-sequence", |v| {
                v["events"][3][0] = serde_json::json!(2);
            }),
            ("reversed-time", |v| {
                v["events"][3][1] = serde_json::json!(19.0);
            }),
            ("missing-snapshot", |v| {
                v["events"][6][3] = serde_json::json!(99);
            }),
            ("owner-key", |v| {
                v["ownerKey"]["ownerId"] = serde_json::json!("replacement");
            }),
            ("owner-instance-missing", |v| {
                v["ownerInstance"] = serde_json::json!("");
            }),
            ("wrong-hash", |v| {
                v["snapshots"][1]["payloadSha256"] = serde_json::json!("0".repeat(64));
            }),
            ("wrong-generation", |v| {
                v["snapshots"][1]["generation"] = serde_json::json!(0);
            }),
            ("unrecorded-flight", |v| {
                v["snapshots"][1]
                    .as_object_mut()
                    .unwrap()
                    .remove("inFlightGeneration");
            }),
            ("unknown-snapshot-field", |v| {
                v["snapshots"][1]["unknown"] = serde_json::json!(true);
            }),
            ("phase-rejected", |v| {
                v["events"][2][6] =
                    serde_json::json!({"kind":"rejected","code":"operation-rejected"});
            }),
            ("phase-result-missing", |v| {
                v["events"][2][6].as_object_mut().unwrap().remove("value");
            }),
            ("unresolved-settle", |v| {
                v["events"][4][6]["value"] = serde_json::json!(false);
            }),
            ("exhausted-budget", |v| {
                v["events"][2][1] = serde_json::json!(2510.0);
            }),
            ("changed-budget", |v| {
                v["events"][1][5] = serde_json::json!(2501);
            }),
            ("unconfirmed-leave-result", |v| {
                v["events"][7][6]["value"] = serde_json::json!(false);
            }),
            ("missing-unresolved-check", |v| {
                v["events"][10][4] = serde_json::Value::Null;
            }),
            ("broken", |v| {
                v["broken"] = serde_json::json!("event-cap");
            }),
            ("extra-tuple-value", |v| {
                v["events"][6]
                    .as_array_mut()
                    .unwrap()
                    .push(serde_json::json!(0));
            }),
            ("unknown-tag", |v| {
                v["events"][6][2] = serde_json::json!("cleanup-alias");
            }),
            ("row-cap", |v| {
                let extra = v["events"][6].clone();
                while v["events"].as_array().unwrap().len() < 193 {
                    v["events"].as_array_mut().unwrap().push(extra.clone());
                }
            }),
            ("input-byte-cap", |v| {
                v["ownerInstance"] = serde_json::json!("x".repeat(2049));
            }),
        ];
        for &(label, mutate) in mutations {
            let mut message = wire_phase_batch();
            mutate(&mut message);
            let batch = phase_batch_input(message);
            let before = serde_json::to_value(&batch).unwrap();
            assert!(
                super::decode_phase_batch(&batch).is_err(),
                "accepted {label}"
            );
            assert_eq!(
                serde_json::to_value(&batch).unwrap(),
                before,
                "mutated {label}"
            );
        }
    }

    #[test]
    fn legacy_stayed_refuses_present_null_or_partial_selected_fields() {
        let legacy = serde_json::json!({
            "kind": "stayed", "ms": 1.0, "snapshot": wire_snapshot(false)
        });
        let decoded = serde_json::from_value::<super::Probe>(legacy.clone())
            .expect("ordinary legacy Stayed decodes");
        assert!(
            matches!(super::legacy_stayed_snapshot(&decoded), Ok(Some(_))),
            "the ordinary legacy control must still be admitted"
        );
        let selected_fields = [
            ("binding-null", serde_json::json!({"binding":null})),
            ("sequence-null", serde_json::json!({"sequence":null})),
            (
                "both-null",
                serde_json::json!({"binding":null,"sequence":null}),
            ),
            (
                "binding-only",
                serde_json::json!({"binding":"opaque-wire-token"}),
            ),
            ("sequence-only", serde_json::json!({"sequence":13})),
            (
                "null-binding-with-sequence",
                serde_json::json!({"binding":null,"sequence":13}),
            ),
            (
                "binding-with-null-sequence",
                serde_json::json!({"binding":"opaque-wire-token","sequence":null}),
            ),
        ];
        let mut admitted = Vec::new();
        for (label, fields) in selected_fields {
            let mut message = legacy.clone();
            message
                .as_object_mut()
                .unwrap()
                .extend(fields.as_object().unwrap().clone());
            // Refusal may occur at closed wire decoding or at the actual guard
            // that probe calls before taking Trace or incrementing stayed.
            if let Ok(decoded) = serde_json::from_value::<super::Probe>(message) {
                if super::legacy_stayed_snapshot(&decoded).is_ok() {
                    admitted.push(label);
                }
            }
        }
        assert!(
            admitted.is_empty(),
            "selected-field payloads reached legacy admission: {admitted:?}"
        );
    }

    #[test]
    fn legacy_stayed_omitted_flight_normalizes_before_trace_serialization() {
        let normalized = serde_json::json!({
            "kind": "stayed", "ms": 1.0, "snapshot": wire_snapshot(false)
        });
        // Explicit null remains a passing control for the old normalized shape.
        let explicit = serde_json::from_value::<super::Probe>(normalized.clone()).unwrap();
        assert!(matches!(
            super::legacy_stayed_snapshot(&explicit),
            Ok(Some(_))
        ));
        assert_eq!(serde_json::to_value(explicit).unwrap(), normalized);

        let mut omitted = normalized.clone();
        omitted["snapshot"]
            .as_object_mut()
            .unwrap()
            .remove("inFlightGeneration");
        let decoded = serde_json::from_value::<super::Probe>(omitted)
            .expect("the old Snapshot accepts an omitted optional flight");
        assert!(
            matches!(super::legacy_stayed_snapshot(&decoded), Ok(Some(_))),
            "valid legacy omission stays admitted"
        );
        // probe uses this same Serialize operation for its frontend trace row.
        assert_eq!(
            serde_json::to_value(decoded).unwrap(),
            normalized,
            "legacy trace keeps the original explicit-null normalization"
        );
    }

    #[test]
    fn selected_stayed_retains_raw_missing_and_null_flight_distinction() {
        for omit in [false, true] {
            let mut snapshot = wire_snapshot(true);
            snapshot["ownerKey"] = serde_json::json!({
                "vaultId":"m93-controlled-vault", "path":"controlled.md", "ownerId":"m93-native-quit"
            });
            snapshot["ownerInstance"] = serde_json::json!("retained-1");
            if omit {
                snapshot
                    .as_object_mut()
                    .unwrap()
                    .remove("inFlightGeneration");
            }
            let message = serde_json::json!({
                "kind":"stayed", "binding":"opaque-wire-token", "sequence":13,
                "ms":4870.0, "snapshot":snapshot
            });
            let decoded = serde_json::from_value::<super::Probe>(message.clone())
                .expect("selected raw evidence decodes without inventing omitted values");
            assert_eq!(
                serde_json::to_value(decoded).unwrap(),
                message,
                "selected raw evidence must not inherit legacy normalization, omit={omit}"
            );
        }
    }

    #[test]
    fn native_intake_preserves_real_idle_and_capture_clock() {
        use crate::shell::quit::{QuitState, SmokePhase};
        use std::time::Instant;

        // These are actual captures, not installed gate/timer observations.
        let origin = Instant::now();
        let state = QuitState::default();
        let mut previous_ns = None;
        for _ in 0..2 {
            let before = Instant::now();
            let read = super::read_native(&state, origin);
            let after = Instant::now();
            assert!(
                read.is_ok(),
                "actual Idle observer intake unavailable: {:?}",
                read.as_ref().err()
            );
            let read = read.unwrap();
            assert_eq!(read.observation.phase, SmokePhase::Idle);
            assert_eq!(read.observation.epoch, 0);
            assert_eq!(
                read.observation.pending, None,
                "no pending attempt or arm exists"
            );
            assert!(read.observation.entries.is_empty());
            assert!(!read.observation.broken);
            assert!(
                before <= read.observation.observed_at && read.observation.observed_at <= after
            );
            let elapsed = read
                .observation
                .observed_at
                .checked_duration_since(origin)
                .expect("the actual read follows the case origin");
            assert_eq!(read.captured_ns, u64::try_from(elapsed.as_nanos()).unwrap());
            if let Some(previous) = previous_ns {
                assert!(
                    read.captured_ns >= previous,
                    "actual repeated read clock reversed"
                );
            }
            previous_ns = Some(read.captured_ns);

            // Intake cannot create an admission, arm, decision or replacement gate.
            let untouched = state.smoke_observation();
            assert_eq!(untouched.phase, read.observation.phase);
            assert_eq!(untouched.epoch, read.observation.epoch);
            assert_eq!(untouched.pending, read.observation.pending);
            assert_eq!(untouched.entries, read.observation.entries);
            assert!(!untouched.broken);
        }
    }

    // Configure only fixture prerequisites. No native admission, epoch, binding,
    // timer arm, journal entry or accepted frontend evidence is installed.
    fn listener_ready_trace() -> super::Trace {
        super::Trace(std::sync::Mutex::new(super::Inner {
            origin: Some(std::time::Instant::now()),
            ready: true,
            ..super::Inner::default()
        }))
    }

    fn selected_probe_messages() -> Vec<serde_json::Value> {
        let mut snapshot = wire_snapshot(true);
        snapshot["ownerKey"] = serde_json::json!({
            "vaultId":"m93-controlled-vault", "path":"controlled.md", "ownerId":"m93-native-quit"
        });
        snapshot["ownerInstance"] = serde_json::json!("retained-1");
        vec![
            serde_json::json!({"kind":"bind-attempt"}),
            wire_phase_batch(),
            serde_json::json!({"kind":"wait-late-window","binding":"untrusted-wire-token"}),
            serde_json::json!({"kind":"stayed","binding":"untrusted-wire-token",
                "sequence":13,"ms":1.0,"snapshot":snapshot}),
        ]
    }

    #[test]
    fn selected_probes_refuse_actual_idle_with_trace_failure_evidence() {
        use crate::shell::quit::{QuitState, SmokePhase};
        let mut missing = Vec::new();
        for case in [Case::LateIpc150, Case::LateIpc350] {
            for message in selected_probe_messages() {
                let label = format!("{case:?}/{}", message["kind"]);
                let probe: super::Probe = serde_json::from_value(message).unwrap();
                let trace = listener_ready_trace();
                let quit = QuitState::default();
                let result = trace.late_probe(&quit, case, &probe);
                if !matches!(result, Err("quit-late-not-pending")) {
                    missing.push(format!("{label}: actual Idle refusal: {result:?}"));
                }
                let inner = trace.0.lock().unwrap();
                if !inner.broken {
                    missing.push(format!("{label}: refusal did not break selected evidence"));
                }
                assert!(
                    inner.late.is_none(),
                    "{label}: refused request created a session"
                );
                assert_eq!(
                    (inner.call, inner.emitted, inner.stayed),
                    (0, 0, 0),
                    "{label}"
                );
                assert!(inner.ready && !inner.hang, "{label}: legacy state changed");
                if inner.rows.len() != 1 {
                    missing.push(format!(
                        "{label}: expected bounded refusal row, got {}",
                        inner.rows.len()
                    ));
                } else {
                    let row = &inner.rows[0];
                    assert_eq!(row["event"], "fixture-error", "{label}");
                    assert_eq!(
                        row["data"],
                        serde_json::json!({"reason":"quit-late-not-pending"}),
                        "{label}"
                    );
                    assert_eq!(row["ordinal"], 1, "{label}");
                    assert_eq!(
                        row["pid"],
                        std::process::id(),
                        "{label}: actual process identity"
                    );
                    let ms = row["ms"].as_f64().expect("recorded native receipt time");
                    assert!(ms.is_finite() && ms >= 0.0, "{label}");
                    assert!(serde_json::to_vec(row).unwrap().len() <= 2048, "{label}");
                }
                drop(inner);
                let actual = quit.smoke_observation();
                assert_eq!(actual.phase, SmokePhase::Idle, "{label}");
                assert_eq!(actual.epoch, 0, "{label}");
                assert_eq!(actual.pending, None, "{label}: no pending epoch or arm");
                assert!(actual.entries.is_empty() && !actual.broken, "{label}");
            }
        }
        // Evaluate all eight boundaries before reporting the missing behavior.
        assert!(missing.is_empty(), "{}", missing.join("\n"));
    }

    #[test]
    fn selected_probe_door_does_not_mutate_non_selected_profiles() {
        use crate::shell::quit::{QuitState, SmokePhase};
        for case in [
            Case::FailedOwner,
            Case::PendingOwner,
            Case::LateUnresolved,
            Case::SecondQuit,
            Case::ExpiredSecondQuit,
            Case::HungWebview,
        ] {
            for message in selected_probe_messages() {
                let probe: super::Probe = serde_json::from_value(message).unwrap();
                let trace = listener_ready_trace();
                let quit = QuitState::default();
                let origin = trace.0.lock().unwrap().origin;
                assert!(trace.late_probe(&quit, case, &probe).is_err(), "{case:?}");
                let inner = trace.0.lock().unwrap();
                assert_eq!(inner.origin, origin);
                assert!(inner.ready && !inner.broken && !inner.hang);
                assert_eq!((inner.call, inner.emitted, inner.stayed), (0, 0, 0));
                assert!(inner.rows.is_empty() && inner.late.is_none());
                drop(inner);
                let actual = quit.smoke_observation();
                assert_eq!(actual.phase, SmokePhase::Idle);
                assert_eq!(actual.epoch, 0);
                assert_eq!(actual.pending, None);
                assert!(actual.entries.is_empty() && !actual.broken);
            }
        }
    }
}
