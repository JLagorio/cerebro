//! Which PROCESS had which vault open, and when (M49.9, K25).
//!
//! `app_sessions` has existed since M25.3 with no production writer — its
//! open/heartbeat/close functions were called only by catch-up's tests. On
//! 2026-08-17 two builds wrote the same vault and nothing in runtime.db could
//! say so: no row carried a pid, a build, or a time. This is that writer.
//!
//! The session id IS the process identity — pid, build, and the instant the
//! process started — so no schema change is needed to name it, and an older
//! build reading the same database reads an ordinary id. Reminder catch-up reads
//! the closure retained by `window_for`; a webview reload keeps that window.

use std::collections::HashMap;
use std::sync::{Mutex, Once, OnceLock};

use chrono::Utc;

use super::catchup::{close_session, heartbeat, open_session, HEARTBEAT_SECONDS};
use super::VaultScope;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionWindow {
    pub closed_at: String,
    pub precision: String,
    pub reopened_at: String,
    pub cause: String,
}
fn process_start() -> &'static chrono::DateTime<Utc> {
    static START: OnceLock<chrono::DateTime<Utc>> = OnceLock::new();
    START.get_or_init(Utc::now)
}
fn windows() -> &'static Mutex<HashMap<String, SessionWindow>> {
    static WINDOWS: OnceLock<Mutex<HashMap<String, SessionWindow>>> = OnceLock::new();
    WINDOWS.get_or_init(|| Mutex::new(HashMap::new()))
}
pub fn window_for(vault_id: &str) -> Option<SessionWindow> {
    windows().lock().ok()?.get(vault_id).cloned()
}
fn session_window(
    closed: super::catchup::ClosedInterval,
    now: chrono::DateTime<Utc>,
    start: chrono::DateTime<Utc>,
) -> SessionWindow {
    let cause =
        if chrono::DateTime::parse_from_rfc3339(&closed.app_closed_at).is_ok_and(|at| at > start) {
            "vault"
        } else {
            "app"
        };
    SessionWindow {
        closed_at: closed.app_closed_at,
        precision: closed.precision.into(),
        reopened_at: now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        cause: cause.into(),
    }
}

/// This process's session id: `pid <n> · <build> · <started>`.
pub fn session_id() -> &'static str {
    static ID: OnceLock<String> = OnceLock::new();
    ID.get_or_init(|| {
        format!(
            "pid {} · {} · {}",
            std::process::id(),
            crate::app_config::build_label(),
            process_start().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        )
    })
}

/// The (vault_id, store_uuid) this process has open, if any.
fn current() -> &'static Mutex<Option<(String, String)>> {
    static CURRENT: Mutex<Option<(String, String)>> = Mutex::new(None);
    &CURRENT
}

/// Record that this process opened `scope`. A reload of the vault it
/// already has open only heartbeats; switching vaults closes the previous
/// session first. A folder no ledger has claimed yet has no store id to
/// key a session by, and is skipped rather than keyed by an invented one.
pub fn track(scope: &VaultScope) {
    let Some(store) = scope.store_uuid.clone() else {
        return;
    };
    let next = (scope.vault_id.clone(), store);
    let Ok(mut open) = current().lock() else {
        return;
    };
    let start = *process_start();
    let now = Utc::now();
    if open.as_ref() == Some(&next) {
        super::sink::with_sink(|conn| heartbeat(conn, session_id(), &next.0, &next.1, now));
        return;
    }
    if let Some(previous) = open.take() {
        super::sink::with_sink(|conn| {
            close_session(conn, session_id(), &previous.0, &previous.1, now)
        });
    }
    let opened =
        super::sink::with_sink(|conn| open_session(conn, session_id(), &next.0, &next.1, now));
    if let Some(Ok(closed)) = opened {
        if let Ok(mut windows) = windows().lock() {
            if let Some(closed) = closed {
                windows.insert(next.0.clone(), session_window(closed, now, start));
            } else {
                windows.remove(&next.0);
            }
        }
        *open = Some(next);
        start_heartbeat();
    }
}

/// Close the open session cleanly — the app is exiting.
pub fn close_current() {
    let Ok(mut open) = current().lock() else {
        return;
    };
    if let Some((vault_id, store)) = open.take() {
        super::sink::with_sink(|conn| {
            close_session(conn, session_id(), &vault_id, &store, Utc::now())
        });
    }
}

/// One heartbeat thread per process, stamping whichever session is open.
fn start_heartbeat() {
    static STARTED: Once = Once::new();
    STARTED.call_once(|| {
        let _ = std::thread::Builder::new()
            .name("cerebro-session-heartbeat".into())
            .spawn(|| loop {
                std::thread::sleep(std::time::Duration::from_secs(HEARTBEAT_SECONDS as u64));
                let open = current().lock().ok().and_then(|open| open.clone());
                if let Some((vault_id, store)) = open {
                    super::sink::with_sink(|conn| {
                        heartbeat(conn, session_id(), &vault_id, &store, Utc::now())
                    });
                }
            });
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn closure_cause_distinguishes_process_start_and_a_later_vault_switch() {
        let start = "2026-07-28T12:00:00Z"
            .parse::<chrono::DateTime<Utc>>()
            .unwrap();
        for (at, cause) in [
            ("2026-07-28T11:00:00Z", "app"),
            ("2026-07-28T12:01:00Z", "vault"),
        ] {
            let closed = super::super::catchup::ClosedInterval {
                app_closed_at: at.into(),
                precision: "clean_exact",
            };
            assert_eq!(
                session_window(closed, start + chrono::Duration::hours(1), start).cause,
                cause
            );
        }
    }

    #[test]
    fn opening_a_vault_records_this_process_and_a_switch_closes_it_cleanly() {
        let _sink = super::super::sink::test_lock();
        let dir = crate::vault::testutil::temp_vault("sessions");
        super::super::sink::arm(&dir).unwrap();
        let rows = || {
            super::super::sink::with_sink(|conn| {
                let mut stmt = conn
                    .prepare(
                        "SELECT session_id, vault_id, close_precision FROM app_sessions \
                         ORDER BY vault_id",
                    )
                    .unwrap();
                stmt.query_map([], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                    ))
                })
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
            })
            .unwrap()
        };
        let register = |vault: &str| {
            let path = dir.join(vault);
            std::fs::create_dir_all(&path).unwrap();
            let vault_id = super::super::sink::with_sink(|conn| {
                super::super::scope::register(conn, &path).unwrap()
            })
            .unwrap();
            VaultScope {
                vault_id,
                store_uuid: Some(format!("store-{vault}")),
            }
        };
        let a = register("va");
        track(&a);
        assert_eq!(window_for(&a.vault_id), None);
        track(&a); // a webview reload: no second row
        let first = rows();
        assert_eq!(first.len(), 1, "{first:?}");
        assert!(first[0]
            .0
            .starts_with(&format!("pid {} · ", std::process::id())));
        assert!(first[0].0.contains(&crate::app_config::build_label()));
        assert_eq!(first[0].2, "open");

        let b = register("vb");
        track(&b);
        let after = rows();
        assert_eq!(after.len(), 2);
        // By vault, never by position: vault ids do not sort in the order
        // the vaults were opened.
        let precision = |vault: &VaultScope| {
            after
                .iter()
                .find(|(_, id, _)| *id == vault.vault_id)
                .map(|(_, _, precision)| precision.clone())
                .unwrap()
        };
        assert_eq!(
            precision(&a),
            "clean_exact",
            "the switched-from session closed"
        );
        assert_eq!(precision(&b), "open");
        track(&a);
        let window = window_for(&a.vault_id).unwrap();
        assert_eq!(window.precision, "clean_exact");
        assert_eq!(window.cause, "vault");
        track(&a);
        assert_eq!(window_for(&a.vault_id), Some(window));
        let reopened = rows();
        assert_eq!(
            reopened
                .iter()
                .find(|(_, id, _)| id == &a.vault_id)
                .unwrap()
                .2,
            "open"
        );
        close_current();
        assert!(rows()
            .iter()
            .all(|(_, _, precision)| precision == "clean_exact"));
        super::super::sink::disarm();
        let _ = std::fs::remove_dir_all(&dir);
    }
}
