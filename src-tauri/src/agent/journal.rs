//! The re-attach journal (M57.6): what an attended run said, held in memory
//! so a panel that was closed, or switched to another thread, can come back
//! to a run still going and read what it missed, each event once.
//!
//! Every event a run emits carries a run-local `seq` from 1 (`super::tag`).
//! An attended run's events are also appended here, from before the reader
//! starts, so even the first event is held for a subscription that arrives
//! late. `since` answers what came after a cursor: `Held` when the journal
//! still has everything after it, `Gap` when the cap dropped some of it, and
//! `Unknown` when it holds nothing for that run under that durable id (never
//! held, a run number from an earlier launch, or expired).
//!
//! Bounded on every axis, and never on disk: `RUN_BYTES` or `RUN_EVENTS` a
//! run (the oldest go first), `TOTAL_BYTES` in all (finished journals go
//! first, oldest first), and `KEEP_FINISHED` after a run ends. A run whose
//! card still waits for the person counts as live: its journal stays until
//! the card closes, and only then does the retention start. A vault switch
//! drops the old vault's journals (`release_other_vaults`); quitting drops
//! them all with the process.
//!
//! Pure: no I/O, and nothing here can panic. The lock is taken poisoned or
//! not, as `agent::lock` takes the slots, because the reader thread appends
//! on its per-event path and a panic there would leave a run unreaped.

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde::Serialize;

use super::TaggedEvent;

/// The most one run's journal holds, in serialized bytes.
pub const RUN_BYTES: usize = 4 * 1024 * 1024;
/// The most events one run's journal holds.
pub const RUN_EVENTS: usize = 20_000;
/// The most every journal holds together, in serialized bytes.
pub const TOTAL_BYTES: usize = 16 * 1024 * 1024;
/// How long a finished run's journal is kept for a late re-attach.
pub const KEEP_FINISHED: Duration = Duration::from_secs(30 * 60);

/// One held event: its seq, its serialized size and the event as it crossed
/// the channel.
#[derive(Debug, Clone)]
struct Held {
    seq: u64,
    bytes: usize,
    event: TaggedEvent,
}

#[derive(Debug)]
struct RunJournal {
    /// The durable id the run's row is keyed by: what a re-attach names, so
    /// a run number reused after a restart never answers for another run.
    run_id: String,
    /// The vault the run was asked in, as the slots key it.
    vault: PathBuf,
    /// The Claude Code session it runs in, which a waiting card names.
    session_id: String,
    events: VecDeque<Held>,
    /// The first seq the journal could still hold: one past the last it
    /// dropped, 1 while it has dropped nothing.
    first: u64,
    bytes: usize,
    /// When the run said its last event; None while it runs.
    finished: Option<Instant>,
    /// False once a vault switch let go of it: it goes the moment it ends.
    retain: bool,
}

/// What `since` answers.
#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum EventsSince {
    /// Every event after the cursor, in order; `done` once the run ended.
    Held {
        events: Vec<TaggedEvent>,
        done: bool,
    },
    /// The cap dropped events after the cursor: the journal starts at
    /// `first`, and `events` is what it still holds.
    Gap {
        first: u64,
        events: Vec<TaggedEvent>,
        done: bool,
    },
    /// Nothing held for this run under this id.
    Unknown,
}

/// Every attended run's journal, by run number.
#[derive(Debug, Default)]
pub struct Journal {
    runs: Mutex<HashMap<u64, RunJournal>>,
}

impl Journal {
    fn runs(&self) -> MutexGuard<'_, HashMap<u64, RunJournal>> {
        self.runs
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// The vaults the journals were asked in, for the caller that reads
    /// which of their sessions still have a card waiting.
    pub fn vaults(&self) -> Vec<PathBuf> {
        let mut vaults: Vec<PathBuf> = self.runs().values().map(|j| j.vault.clone()).collect();
        vaults.sort();
        vaults.dedup();
        vaults
    }

    /// Start holding `run`'s events, before its first one. Sweeps first, so
    /// a journal nobody came back for never outlives its bounds.
    pub fn open(
        &self,
        run: u64,
        run_id: &str,
        vault: &Path,
        session_id: &str,
        now: Instant,
        waiting: &HashSet<String>,
    ) {
        let mut runs = self.runs();
        sweep(&mut runs, now, waiting);
        runs.insert(
            run,
            RunJournal {
                run_id: run_id.to_string(),
                vault: vault.to_path_buf(),
                session_id: session_id.to_string(),
                events: VecDeque::new(),
                first: 1,
                bytes: 0,
                finished: None,
                retain: true,
            },
        );
    }

    /// Hold one event of `run`. Nothing for a run that was never opened.
    /// Past either cap of the run, its oldest events go.
    pub fn append(&self, run: u64, event: &TaggedEvent) {
        let bytes = serde_json::to_vec(event).map(|b| b.len()).unwrap_or(0);
        let mut runs = self.runs();
        let Some(journal) = runs.get_mut(&run) else {
            return;
        };
        journal.events.push_back(Held {
            seq: event.seq,
            bytes,
            event: event.clone(),
        });
        journal.bytes = journal.bytes.saturating_add(bytes);
        while journal.events.len() > RUN_EVENTS || journal.bytes > RUN_BYTES {
            let Some(dropped) = journal.events.pop_front() else {
                break;
            };
            journal.bytes = journal.bytes.saturating_sub(dropped.bytes);
            journal.first = dropped.seq.saturating_add(1);
        }
    }

    /// `run` said its last event at `at`. A journal a vault switch let go of
    /// goes now; any other is kept for KEEP_FINISHED.
    pub fn finish(&self, run: u64, at: Instant) {
        let mut runs = self.runs();
        let release = match runs.get_mut(&run) {
            Some(journal) if journal.retain => {
                journal.finished = Some(at);
                false
            }
            Some(_) => true,
            None => false,
        };
        if release {
            runs.remove(&run);
        }
    }

    /// A vault switch to `keep`: every other vault's finished journals go
    /// now, and its live ones go the moment their runs end.
    pub fn release_other_vaults(&self, keep: &Path) {
        let mut runs = self.runs();
        runs.retain(|_, journal| journal.vault == keep || journal.finished.is_none());
        for journal in runs.values_mut() {
            if journal.vault != keep {
                journal.retain = false;
            }
        }
    }

    /// What `run`, under the durable id `run_id`, said after the cursor
    /// `after`. `waiting` names the sessions whose card still waits, which
    /// keep their journals live. Sweeps first.
    pub fn since(
        &self,
        run: u64,
        run_id: &str,
        after: u64,
        now: Instant,
        waiting: &HashSet<String>,
    ) -> EventsSince {
        let mut runs = self.runs();
        sweep(&mut runs, now, waiting);
        let Some(journal) = runs.get(&run).filter(|j| j.run_id == run_id) else {
            return EventsSince::Unknown;
        };
        let events: Vec<TaggedEvent> = journal
            .events
            .iter()
            .filter(|held| held.seq > after)
            .map(|held| held.event.clone())
            .collect();
        let done = journal.finished.is_some();
        if after.saturating_add(1) < journal.first {
            EventsSince::Gap {
                first: journal.first,
                events,
                done,
            }
        } else {
            EventsSince::Held { events, done }
        }
    }
}

/// Keep the journals within their bounds: a finished one whose card still
/// waits starts its retention again, an expired one goes, and past the total
/// cap the finished ones go, oldest first.
fn sweep(runs: &mut HashMap<u64, RunJournal>, now: Instant, waiting: &HashSet<String>) {
    for journal in runs.values_mut() {
        if journal.finished.is_some() && waiting.contains(&journal.session_id) {
            journal.finished = Some(now);
        }
    }
    runs.retain(|_, journal| match journal.finished {
        Some(at) => now.saturating_duration_since(at) < KEEP_FINISHED,
        None => true,
    });
    let mut total: usize = runs.values().map(|j| j.bytes).sum();
    if total <= TOTAL_BYTES {
        return;
    }
    let mut finished: Vec<(Instant, u64)> = runs
        .iter()
        .filter(|(_, j)| !waiting.contains(&j.session_id))
        .filter_map(|(run, j)| j.finished.map(|at| (at, *run)))
        .collect();
    finished.sort_unstable();
    for (_, run) in finished {
        if total <= TOTAL_BYTES {
            break;
        }
        if let Some(journal) = runs.remove(&run) {
            total = total.saturating_sub(journal.bytes);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::AgentEvent;
    use super::*;

    const VAULT: &str = "/vault";

    fn none() -> HashSet<String> {
        HashSet::new()
    }

    fn event(run: u64, seq: u64, text: &str) -> TaggedEvent {
        TaggedEvent {
            run,
            seq,
            event: AgentEvent::TextDelta { text: text.into() },
        }
    }

    fn opened(run: u64, run_id: &str, now: Instant) -> Journal {
        let journal = Journal::default();
        journal.open(run, run_id, Path::new(VAULT), "session-1", now, &none());
        journal
    }

    fn seqs(answer: &EventsSince) -> Vec<u64> {
        match answer {
            EventsSince::Held { events, .. } | EventsSince::Gap { events, .. } => {
                events.iter().map(|e| e.seq).collect()
            }
            EventsSince::Unknown => vec![],
        }
    }

    #[test]
    fn seqs_are_held_in_order_and_read_after_the_cursor() {
        let now = Instant::now();
        let journal = opened(3, "run-a", now);
        for seq in 1..=5 {
            journal.append(3, &event(3, seq, "x"));
        }
        let all = journal.since(3, "run-a", 0, now, &none());
        assert_eq!(seqs(&all), vec![1, 2, 3, 4, 5]);
        let after = journal.since(3, "run-a", 3, now, &none());
        assert!(matches!(after, EventsSince::Held { done: false, .. }));
        assert_eq!(seqs(&after), vec![4, 5]);
        assert_eq!(
            journal.since(3, "run-a", 5, now, &none()),
            EventsSince::Held {
                events: vec![],
                done: false
            }
        );
    }

    #[test]
    fn an_unopened_run_is_never_held() {
        let now = Instant::now();
        let journal = opened(3, "run-a", now);
        journal.append(4, &event(4, 1, "x"));
        assert_eq!(
            journal.since(4, "run-a", 0, now, &none()),
            EventsSince::Unknown
        );
    }

    #[test]
    fn a_mismatched_or_missing_run_is_unknown() {
        let now = Instant::now();
        let journal = opened(3, "run-a", now);
        journal.append(3, &event(3, 1, "x"));
        // The same number under another durable id: a run from an earlier
        // launch never answers for this one.
        assert_eq!(
            journal.since(3, "run-b", 0, now, &none()),
            EventsSince::Unknown
        );
        assert_eq!(
            journal.since(9, "run-a", 0, now, &none()),
            EventsSince::Unknown
        );
    }

    #[test]
    fn a_full_run_journal_drops_its_oldest_and_reads_as_a_gap() {
        let now = Instant::now();
        // By count.
        let journal = opened(3, "run-a", now);
        let total = RUN_EVENTS as u64 + 10;
        for seq in 1..=total {
            journal.append(3, &event(3, seq, ""));
        }
        match journal.since(3, "run-a", 0, now, &none()) {
            EventsSince::Gap { first, events, .. } => {
                assert_eq!(first, 11);
                assert_eq!(events.len(), RUN_EVENTS);
                assert_eq!(events[0].seq, 11);
            }
            other => panic!("expected a gap, got {other:?}"),
        }
        // A cursor the journal still covers is no gap.
        assert!(matches!(
            journal.since(3, "run-a", 10, now, &none()),
            EventsSince::Held { .. }
        ));

        // By bytes: three events of a little over a third of the cap each.
        let journal = opened(5, "run-c", now);
        let big = "y".repeat(RUN_BYTES / 3 + 1);
        for seq in 1..=3 {
            journal.append(5, &event(5, seq, &big));
        }
        match journal.since(5, "run-c", 0, now, &none()) {
            EventsSince::Gap { first, events, .. } => {
                assert_eq!(first, 2);
                assert_eq!(events.iter().map(|e| e.seq).collect::<Vec<_>>(), vec![2, 3]);
            }
            other => panic!("expected a gap, got {other:?}"),
        }
    }

    #[test]
    fn a_finished_journal_expires_after_its_retention() {
        let start = Instant::now();
        let journal = opened(3, "run-a", start);
        journal.append(3, &event(3, 1, "x"));
        journal.finish(3, start);
        let before = start + KEEP_FINISHED - Duration::from_secs(1);
        assert!(matches!(
            journal.since(3, "run-a", 0, before, &none()),
            EventsSince::Held { done: true, .. }
        ));
        let after = start + KEEP_FINISHED;
        assert_eq!(
            journal.since(3, "run-a", 0, after, &none()),
            EventsSince::Unknown
        );
    }

    #[test]
    fn a_run_whose_card_waits_keeps_its_journal_past_its_retention() {
        let start = Instant::now();
        let journal = opened(3, "run-a", start);
        journal.append(3, &event(3, 1, "x"));
        journal.finish(3, start);
        let waiting: HashSet<String> = ["session-1".to_string()].into();
        let late = start + KEEP_FINISHED * 2;
        assert!(matches!(
            journal.since(3, "run-a", 0, late, &waiting),
            EventsSince::Held { done: true, .. }
        ));
        // The card closed: the retention starts from when it was last seen
        // waiting.
        let closed = late + KEEP_FINISHED - Duration::from_secs(1);
        assert!(matches!(
            journal.since(3, "run-a", 0, closed, &none()),
            EventsSince::Held { .. }
        ));
        assert_eq!(
            journal.since(3, "run-a", 0, late + KEEP_FINISHED, &none()),
            EventsSince::Unknown
        );
    }

    #[test]
    fn the_total_cap_drops_finished_journals_oldest_first() {
        let start = Instant::now();
        let journal = Journal::default();
        // Five journals of a little under 4 MiB each: 1 and 2 finished (1
        // first), 3 to 5 live. Together past 16 MiB, so the oldest finished
        // goes; then within the cap, the rest stay.
        let chunk = "z".repeat(RUN_BYTES / 2 - 64);
        for run in 1..=5u64 {
            journal.open(
                run,
                &format!("run-{run}"),
                Path::new(VAULT),
                &format!("s-{run}"),
                start,
                &none(),
            );
            journal.append(run, &event(run, 1, &chunk));
            journal.append(run, &event(run, 2, &chunk));
        }
        journal.finish(1, start);
        journal.finish(2, start + Duration::from_secs(1));
        let now = start + Duration::from_secs(2);
        assert_eq!(
            journal.since(1, "run-1", 0, now, &none()),
            EventsSince::Unknown
        );
        for run in 2..=5u64 {
            assert_ne!(
                journal.since(run, &format!("run-{run}"), 0, now, &none()),
                EventsSince::Unknown,
                "run {run} stays"
            );
        }
    }

    #[test]
    fn a_released_journal_is_dropped_when_its_run_finishes() {
        let now = Instant::now();
        let journal = Journal::default();
        journal.open(1, "old-live", Path::new("/old"), "s-1", now, &none());
        journal.open(2, "old-done", Path::new("/old"), "s-2", now, &none());
        journal.open(3, "kept", Path::new(VAULT), "s-3", now, &none());
        journal.finish(2, now);
        journal.release_other_vaults(Path::new(VAULT));
        // The old vault's finished journal went at once; its live one is
        // still read until its run ends.
        assert_eq!(
            journal.since(2, "old-done", 0, now, &none()),
            EventsSince::Unknown
        );
        assert!(matches!(
            journal.since(1, "old-live", 0, now, &none()),
            EventsSince::Held { done: false, .. }
        ));
        journal.finish(1, now);
        assert_eq!(
            journal.since(1, "old-live", 0, now, &none()),
            EventsSince::Unknown
        );
        journal.finish(3, now);
        assert!(matches!(
            journal.since(3, "kept", 0, now, &none()),
            EventsSince::Held { done: true, .. }
        ));
    }

    #[test]
    fn done_is_reported_once_the_run_has_finished() {
        let now = Instant::now();
        let journal = opened(3, "run-a", now);
        journal.append(3, &event(3, 1, "x"));
        assert!(matches!(
            journal.since(3, "run-a", 0, now, &none()),
            EventsSince::Held { done: false, .. }
        ));
        journal.append(
            3,
            &TaggedEvent {
                run: 3,
                seq: 2,
                event: AgentEvent::Done,
            },
        );
        journal.finish(3, now);
        let answer = journal.since(3, "run-a", 0, now, &none());
        assert!(matches!(answer, EventsSince::Held { done: true, .. }));
        assert_eq!(seqs(&answer), vec![1, 2]);
    }

    /// A run's stream as 2.1.250 forwards foreground subagents (M91.3b):
    /// `count` of them, one after another, each reading `reads` pages of
    /// `page` bytes and reporting a sentence. Synthetic ids only.
    fn subagent_stream(count: usize, reads: usize, page: usize) -> Vec<serde_json::Value> {
        use serde_json::json;
        let text = "A line of a page the subagent read. ".repeat(page / 36 + 1);
        let mut lines = vec![json!({ "type": "system", "subtype": "init",
            "session_id": "00000000-0000-4000-8000-000000009600", "model": "haiku" })];
        for agent in 0..count {
            let call = format!("toolu_{:024}", 9600 + agent);
            let forwarded = |mut line: serde_json::Value| {
                line["parent_tool_use_id"] = json!(call);
                line
            };
            lines.push(
                json!({ "type": "assistant", "parent_tool_use_id": null, "message": {
                "id": format!("msg_{:024}", 9600 + agent), "model": "haiku", "content": [
                { "type": "tool_use", "id": call, "name": "Agent", "input": {
                    "description": format!("Read part {agent}"),
                    "subagent_type": "cerebro-researcher",
                    "prompt": format!("Read part {agent} and report.") } }] } }),
            );
            lines.push(json!({ "type": "system", "subtype": "task_started",
                "task_id": format!("a{agent:016}"), "tool_use_id": call,
                "description": format!("Read part {agent}"), "subagent_type": "cerebro-researcher",
                "is_backgrounded": false, "spawn_depth": 1, "task_type": "local_agent" }));
            lines.push(forwarded(json!({ "type": "user", "message": { "content": [
                { "type": "text", "text": format!("Read part {agent} and report.") }] } })));
            for read in 0..reads {
                let id = format!("toolu_{:012}{:012}", 9700 + agent, read);
                lines.push(forwarded(json!({ "type": "assistant", "message": {
                    "id": format!("msg_{:012}{:012}", 9700 + agent, read), "model": "haiku",
                    "content": [{ "type": "tool_use", "id": id, "name": "Read",
                        "input": { "file_path": format!("notes/part-{agent}/page-{read}.md") } }] } })));
                lines.push(forwarded(json!({ "type": "user", "message": { "content": [
                    { "type": "tool_result", "tool_use_id": id, "content": &text[..page] }] } })));
                lines.push(json!({ "type": "system", "subtype": "task_progress",
                    "task_id": format!("a{agent:016}"), "tool_use_id": call,
                    "description": format!("Reading page {read}"),
                    "usage": { "total_tokens": 1000 * (read + 1), "tool_uses": read + 1,
                        "duration_ms": 500 * (read + 1) },
                    "last_tool_name": "Read" }));
            }
            lines.push(forwarded(json!({ "type": "assistant", "message": {
                "id": format!("msg_{:024}", 9800 + agent), "model": "haiku",
                "content": [{ "type": "text", "text": format!("Part {agent} says the launch holds.") }] } })));
            lines.push(json!({ "type": "system", "subtype": "task_notification",
                "task_id": format!("a{agent:016}"), "tool_use_id": call, "status": "completed",
                "usage": { "total_tokens": 1000 * reads, "tool_uses": reads, "duration_ms": 500 * reads } }));
            lines.push(json!({ "type": "user", "parent_tool_use_id": null, "message": { "content": [
                { "type": "tool_result", "tool_use_id": call, "content": [
                    { "type": "text", "text": format!("Part {agent} says the launch holds.") }] }] },
                "tool_use_result": { "status": "completed", "agentId": format!("a{agent:016}"),
                    "agentType": "cerebro-researcher", "totalToolUseCount": reads,
                    "totalDurationMs": 500 * reads } }));
        }
        lines.push(
            json!({ "type": "assistant", "parent_tool_use_id": null, "message": {
            "id": "msg_000000000000000000009699", "model": "haiku", "stop_reason": "end_turn",
            "content": [{ "type": "text", "text": "Every part says the launch holds." }] } }),
        );
        lines.push(
            json!({ "type": "result", "subtype": "success", "is_error": false,
            "result": "Every part says the launch holds.", "stop_reason": "end_turn",
            "session_id": "00000000-0000-4000-8000-000000009600" }),
        );
        lines
    }

    /// M91.3b: a subagent's call crosses as its preview, never whole, so a
    /// run that starts as many subagents as a session allows, each reading
    /// far more than it reports, keeps all of it in one run's journal. The
    /// same reading as whole payloads would not fit.
    #[test]
    fn a_run_of_subagents_fits_its_journal() {
        let most: usize = crate::policy::subagents::env()
            .find(|(name, _)| *name == "CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION")
            .and_then(|(_, value)| value.parse().ok())
            .expect("the policy bounds a session's subagents");
        let lines = subagent_stream(most, 12, 64 * 1024);
        let read: usize = lines.iter().map(|line| line.to_string().len()).sum();
        assert!(read > RUN_BYTES, "the reading alone would not fit: {read}");
        let folded = super::super::fold::fold_lines(&lines);
        assert!(
            folded.classes.unclassified.is_empty(),
            "{:?}",
            folded.classes
        );
        let started = folded
            .events
            .iter()
            .filter(|event| matches!(event, AgentEvent::SubagentStarted { .. }))
            .count();
        assert_eq!(started, most);
        let now = Instant::now();
        let journal = opened(3, "run-a", now);
        let count = folded.events.len();
        let mut bytes = 0;
        for (at, event) in folded.events.into_iter().enumerate() {
            let tagged = TaggedEvent {
                run: 3,
                seq: at as u64 + 1,
                event,
            };
            bytes += serde_json::to_vec(&tagged).unwrap().len();
            journal.append(3, &tagged);
        }
        assert!(count <= RUN_EVENTS, "{count}");
        assert!(bytes * 4 < RUN_BYTES, "{bytes} of {RUN_BYTES}");
        match journal.since(3, "run-a", 0, now, &none()) {
            EventsSince::Held { events, .. } => assert_eq!(events.len(), count),
            other => panic!("the journal dropped some: {other:?}"),
        }
    }

    #[test]
    fn the_answer_serializes_with_its_state() {
        let now = Instant::now();
        let journal = opened(3, "run-a", now);
        journal.append(3, &event(3, 1, "hi"));
        let held = serde_json::to_value(journal.since(3, "run-a", 0, now, &none())).unwrap();
        assert_eq!(
            held,
            serde_json::json!({
                "state": "held",
                "done": false,
                "events": [{ "run": 3, "seq": 1, "kind": "TextDelta", "text": "hi" }],
            })
        );
        let unknown = serde_json::to_value(EventsSince::Unknown).unwrap();
        assert_eq!(unknown, serde_json::json!({ "state": "unknown" }));
    }
}
