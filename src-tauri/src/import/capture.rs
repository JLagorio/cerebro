//! Run-owned connector results (M69.5). Memory only: neither Debug nor a
//! transcript event exposes their content. A lease removes every byte on exit.
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fmt;
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

const RUN_CAP: usize = 8;
pub const CAPTURE_CAP: usize = 4 * 1024 * 1024;
const TOTAL_CAP: usize = 16 * 1024 * 1024;
const WAIT_CAP: Duration = Duration::from_secs(3);

#[derive(Clone)]
pub struct Capture {
    pub text: Arc<str>,
    pub is_error: bool,
    pub truncated: bool,
    key: Option<Key>,
}
#[derive(Clone, PartialEq, Eq)]
struct Key {
    generation: u64,
    sequence: u64,
}
#[cfg(test)]
impl Capture {
    pub fn fixture(text: &str, is_error: bool, truncated: bool) -> Self {
        Self {
            text: Arc::from(text),
            is_error,
            truncated,
            key: None,
        }
    }
}
impl fmt::Debug for Capture {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Capture")
            .field("bytes", &self.text.len())
            .field("is_error", &self.is_error)
            .field("truncated", &self.truncated)
            .finish_non_exhaustive()
    }
}
struct Slot {
    sequence: u64,
    call: String,
    page: String,
    answer: Option<Capture>,
}
struct Run {
    next: u64,
    generation: u64,
    names: HashSet<String>,
    slots: Vec<Slot>,
    composable: HashSet<String>,
}
#[derive(Default)]
struct Book {
    generation: u64,
    runs: HashMap<String, Run>,
    bytes: usize,
}
#[derive(Default)]
struct Store {
    book: Mutex<Book>,
    changed: Condvar,
}
fn global() -> &'static Arc<Store> {
    static STORE: OnceLock<Arc<Store>> = OnceLock::new();
    STORE.get_or_init(|| Arc::new(Store::default()))
}

/// Exact CLI spellings, and only servers/tools the run actually holds. No
/// generic `fetch` is eligible without a separately reviewed live recording.
pub fn eligible_names(
    held: bool,
    servers: &[(String, String)],
    allow: &[String],
    deny: &[String],
) -> Vec<String> {
    if !held {
        return Vec::new();
    }
    servers
        .iter()
        .filter_map(|(_, cli)| {
            let server = format!("mcp__{cli}");
            let name = format!("{server}__notion-fetch");
            (allow.iter().any(|v| v == &server || v == &name)
                && !deny.contains(&name)
                && !deny.contains(&server))
            .then_some(name)
        })
        .collect()
}

/// The stream owns this lease; the fold gets a handle that cannot prolong it.
pub struct Lease {
    handle: Handle,
}
impl Lease {
    pub fn handle(&self) -> Handle {
        self.handle.clone()
    }
}
impl Drop for Lease {
    fn drop(&mut self) {
        self.handle
            .store
            .end(&self.handle.run, self.handle.generation);
    }
}
#[derive(Clone)]
pub struct Handle {
    store: Arc<Store>,
    run: String,
    generation: u64,
}
impl fmt::Debug for Handle {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("CaptureHandle { .. }")
    }
}
pub fn arm(run: &str, names: Vec<String>) -> Option<Lease> {
    global().arm(run, names)
}
pub fn find(run: &str, page: &str, wait: Duration) -> Option<Capture> {
    global().find(run, page, wait)
}
pub fn allow_composed(run: &str, page: &str, capture: &Capture) -> bool {
    global().allow_composed(run, page, capture)
}
pub fn may_compose(run: &str, page: &str) -> bool {
    global()
        .book
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .runs
        .get(run)
        .is_some_and(|state| state.composable.contains(page))
}
impl Store {
    fn allow_composed(&self, run: &str, page: &str, capture: &Capture) -> bool {
        let Some(key) = &capture.key else {
            return false;
        };
        let mut book = self.book.lock().unwrap_or_else(|e| e.into_inner());
        let Some(state) = book.runs.get_mut(run) else {
            return false;
        };
        if state.generation != key.generation
            || !state
                .slots
                .iter()
                .rev()
                .find(|slot| slot.page == page)
                .is_some_and(|slot| slot.sequence == key.sequence && slot.answer.is_some())
        {
            return false;
        }
        state.composable.insert(page.into());
        true
    }
    fn arm(self: &Arc<Self>, run: &str, names: Vec<String>) -> Option<Lease> {
        if names.is_empty() || run.is_empty() {
            return None;
        }
        let mut book = self.book.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(old) = book.runs.remove(run) {
            book.bytes -= slot_bytes(&old);
        }
        book.generation += 1;
        let generation = book.generation;
        book.runs.insert(
            run.into(),
            Run {
                next: 0,
                generation,
                names: names.into_iter().collect(),
                slots: Vec::new(),
                composable: HashSet::new(),
            },
        );
        self.changed.notify_all();
        Some(Lease {
            handle: Handle {
                store: self.clone(),
                run: run.into(),
                generation,
            },
        })
    }
    fn end(&self, run: &str, generation: u64) {
        let mut book = self.book.lock().unwrap_or_else(|e| e.into_inner());
        if book
            .runs
            .get(run)
            .is_some_and(|state| state.generation == generation)
        {
            let removed = book.runs.remove(run).expect("checked run");
            book.bytes -= slot_bytes(&removed);
            self.changed.notify_all();
        }
    }
    fn find(&self, run: &str, page: &str, wait: Duration) -> Option<Capture> {
        let deadline = Instant::now() + wait.min(WAIT_CAP);
        let mut book = self.book.lock().unwrap_or_else(|e| e.into_inner());
        let generation = book.runs.get(run)?.generation;
        loop {
            let state = book
                .runs
                .get(run)
                .filter(|state| state.generation == generation)?;
            // The newest request for this page owns the answer: an earlier
            // success cannot hide a fresh failed or still-pending fetch.
            let slot = state.slots.iter().rev().find(|slot| slot.page == page)?;
            if let Some(answer) = &slot.answer {
                return Some(answer.clone());
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return None;
            }
            let (next, _) = self
                .changed
                .wait_timeout(book, remaining)
                .unwrap_or_else(|e| e.into_inner());
            book = next;
        }
    }
}
fn slot_bytes(run: &Run) -> usize {
    run.slots
        .iter()
        .filter_map(|slot| slot.answer.as_ref())
        .map(|answer| answer.text.len())
        .sum()
}
impl Handle {
    pub fn begin(&self, name: &str, call: &str, input: Option<&Value>) {
        let Some(input) = input else { return };
        let page = ["id", "page", "url"].iter().find_map(|key| {
            input
                .get(key)
                .and_then(Value::as_str)
                .and_then(|value| super::canonical_record_id("notion", value).ok())
        });
        let Some(page) = page else { return };
        let mut book = self.store.book.lock().unwrap_or_else(|e| e.into_inner());
        let Some(run) = book
            .runs
            .get_mut(&self.run)
            .filter(|run| run.generation == self.generation)
        else {
            return;
        };
        if !run.names.contains(name)
            || call.is_empty()
            || call.len() > 256
            || run.slots.iter().any(|slot| slot.call == call)
        {
            return;
        }
        let released = if run.slots.len() == RUN_CAP {
            let old = run.slots.remove(0);
            if !run.slots.iter().any(|slot| slot.page == old.page) {
                run.composable.remove(&old.page);
            }
            old.answer.map_or(0, |answer| answer.text.len())
        } else {
            0
        };
        run.composable.remove(&page);
        run.next += 1;
        run.slots.push(Slot {
            sequence: run.next,
            call: call.into(),
            page,
            answer: None,
        });
        book.bytes -= released;
    }
    pub fn put(&self, call: &str, text: &str, is_error: bool) {
        let mut book = self.store.book.lock().unwrap_or_else(|e| e.into_inner());
        let budget = TOTAL_CAP.saturating_sub(book.bytes).min(CAPTURE_CAP);
        let Some(run) = book
            .runs
            .get_mut(&self.run)
            .filter(|run| run.generation == self.generation)
        else {
            return;
        };
        let Some(slot) = run
            .slots
            .iter_mut()
            .find(|slot| slot.call == call && slot.answer.is_none())
        else {
            return;
        };
        let mut end = text.len().min(budget);
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        slot.answer = Some(Capture {
            text: Arc::from(&text[..end]),
            is_error,
            truncated: end < text.len(),
            key: Some(Key {
                generation: self.generation,
                sequence: slot.sequence,
            }),
        });
        book.bytes += end;
        self.store.changed.notify_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    const PAGE: &str = "11111111111111111111111111111111";
    const TOOL: &str = "mcp__notion__notion-fetch";
    fn setup() -> (Arc<Store>, Lease, Handle) {
        let store = Arc::new(Store::default());
        let lease = store.arm("run", vec![TOOL.into()]).unwrap();
        let handle = lease.handle();
        (store, lease, handle)
    }
    fn begin(handle: &Handle, call: &str) {
        handle.begin(TOOL, call, Some(&json!({"id":PAGE})));
    }
    #[test]
    fn lives_until_the_run_ends_and_never_crosses_runs() {
        let (store, lease, handle) = setup();
        begin(&handle, "call");
        handle.put("call", "private content", false);
        assert_eq!(
            &*store.find("run", PAGE, Duration::ZERO).unwrap().text,
            "private content"
        );
        assert!(store.find("other", PAGE, Duration::ZERO).is_none());
        drop(lease);
        assert!(store.find("run", PAGE, Duration::ZERO).is_none());
        handle.put("call", "late", false);
        assert_eq!(store.book.lock().unwrap().bytes, 0);
    }
    #[test]
    fn waits_only_for_a_matching_pending_call_then_gives_up() {
        let (store, _lease, handle) = setup();
        begin(&handle, "call");
        assert!(store.find("run", PAGE, Duration::from_millis(2)).is_none());
        std::thread::scope(|scope| {
            scope.spawn(|| {
                std::thread::sleep(Duration::from_millis(10));
                handle.put("call", "arrived", false);
            });
            assert_eq!(
                &*store
                    .find("run", PAGE, Duration::from_secs(1))
                    .unwrap()
                    .text,
                "arrived"
            );
        });
        begin(&handle, "new");
        assert!(store.find("run", PAGE, Duration::ZERO).is_none());
        handle.put("new", "failed", true);
        assert!(store.find("run", PAGE, Duration::ZERO).unwrap().is_error);
    }
    #[test]
    fn bounds_each_capture_the_run_and_all_runs() {
        let (store, _lease, handle) = setup();
        let big = "é".repeat(CAPTURE_CAP);
        for i in 0..9 {
            let call = i.to_string();
            begin(&handle, &call);
            handle.put(&call, &big, false);
        }
        let book = store.book.lock().unwrap();
        let run = &book.runs["run"];
        assert_eq!(run.slots.len(), RUN_CAP);
        assert_eq!(book.bytes, TOTAL_CAP);
        assert!(run
            .slots
            .iter()
            .all(|s| s.answer.as_ref().unwrap().truncated));
        assert_eq!(
            run.slots[0].answer.as_ref().unwrap().text.len(),
            CAPTURE_CAP
        );
        drop(book);
        let other = store.arm("other", vec![TOOL.into()]).unwrap();
        begin(&other.handle(), "other");
        other.handle().put("other", "full", false);
        assert!(store
            .find("other", PAGE, Duration::ZERO)
            .unwrap()
            .text
            .is_empty());
    }
    #[test]
    fn eligible_names_follow_the_cli_spelling() {
        let servers = vec![("Notion work".into(), "notion-work".into())];
        let allow = vec!["mcp__notion-work".into()];
        assert!(eligible_names(false, &servers, &allow, &[]).is_empty());
        assert_eq!(
            eligible_names(true, &servers, &allow, &[]),
            ["mcp__notion-work__notion-fetch"]
        );
        assert!(eligible_names(
            true,
            &servers,
            &allow,
            &["mcp__notion-work__notion-fetch".into()]
        )
        .is_empty());
        let (store, _lease, handle) = setup();
        for name in [
            "mcp__notion__notion-fetch2",
            "mcp__notion__NOTION-FETCH",
            "mcp__x__notion-fetch-x",
            "fetch",
        ] {
            handle.begin(name, name, Some(&json!({"id":PAGE})));
            handle.put(name, "never", false);
        }
        assert!(store.find("run", PAGE, Duration::ZERO).is_none());
        assert!(store.arm("none", vec![]).is_none());
    }
    #[test]
    fn debug_redacts_and_an_old_lease_cannot_end_a_new_run() {
        let (store, lease, handle) = setup();
        begin(&handle, "call");
        handle.put("call", "PRIVATE", false);
        assert!(
            !format!("{:?} {:?}", handle, store.find("run", PAGE, Duration::ZERO))
                .contains("PRIVATE")
        );
        let next = store.arm("run", vec![TOOL.into()]).unwrap();
        drop(lease);
        begin(&next.handle(), "next");
        next.handle().put("next", "new", false);
        assert_eq!(
            &*store.find("run", PAGE, Duration::ZERO).unwrap().text,
            "new"
        );
    }
}

#[cfg(test)]
mod composition_tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn a_stale_refusal_cannot_authorize_a_new_fetch_and_eviction_bounds_permissions() {
        let store = Arc::new(Store::default());
        let lease = store.arm("run", vec!["fetch".into()]).unwrap();
        let handle = lease.handle();
        let first = "1".repeat(32);
        handle.begin("fetch", "old", Some(&json!({"id":first})));
        handle.put("old", "old content", false);
        let old = store.find("run", &first, Duration::ZERO).unwrap();
        assert!(store.allow_composed("run", &first, &old));
        handle.begin("fetch", "new", Some(&json!({"id":first})));
        assert!(!store.allow_composed("run", &first, &old));
        assert!(store.book.lock().unwrap().runs["run"].composable.is_empty());
        handle.put("new", "new content", false);
        assert!(!store.allow_composed("run", &first, &old));
        for n in 2..=20 {
            let page = format!("{n:032x}");
            let call = n.to_string();
            handle.begin("fetch", &call, Some(&json!({"id":page})));
            handle.put(&call, "answer", false);
            let answer = store.find("run", &page, Duration::ZERO).unwrap();
            assert!(store.allow_composed("run", &page, &answer));
        }
        let book = store.book.lock().unwrap();
        assert_eq!(book.runs["run"].composable.len(), RUN_CAP);
        assert!(!book.runs["run"].composable.contains(&first));
    }
}
