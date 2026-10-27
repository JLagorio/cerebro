//! Metadata transactions only. The native owner authenticates before calling;
//! a row or caller-supplied selector is never a dispatch capability.
use rusqlite::Connection;
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Error {
    Unavailable,
    Invalid,
    Conflict,
    Denied,
}
#[derive(Clone, Copy)]
pub(crate) struct Scope<'a> {
    pub owner: &'a str,
    pub vault: &'a str,
    pub store: &'a str,
    pub actor: &'a str,
    pub process: &'a str,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Receipt {
    pub generation_id: String,
    pub first_run_id: String,
    pub current_run_id: String,
    pub state: String,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Admission {
    New(Receipt),
    Observed(Receipt),
}
#[derive(Debug, Clone, Copy)]
pub(crate) enum End {
    Deferred,
    Completed,
    Failed,
    Cancelled,
    Interrupted,
}

use rusqlite::{params, OptionalExtension};
fn unavailable<T>(_: T) -> Error {
    Error::Unavailable
}
fn hex(value: &str, n: usize) -> bool {
    value.len() == n
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn checked(conn: &Connection, scope: Scope<'_>) -> Result<(), Error> {
    if conn.is_autocommit() {
        return Err(Error::Unavailable);
    }
    if scope.owner != "human:me"
        || !hex(scope.vault, 32)
        || [scope.store, scope.actor]
            .iter()
            .any(|s| s.is_empty() || s.len() > 128)
        || scope.process.is_empty()
        || scope.process.len() > 1024
    {
        return Err(Error::Invalid);
    }
    Ok(())
}
fn text(row: &rusqlite::Row<'_>, at: usize, max: usize) -> rusqlite::Result<String> {
    let value = row.get_ref(at)?.as_str()?;
    if value.len() > max {
        return Err(rusqlite::Error::InvalidQuery);
    }
    Ok(value.to_owned())
}
fn receipt(row: &rusqlite::Row<'_>) -> rusqlite::Result<Receipt> {
    Ok(Receipt {
        generation_id: text(row, 0, 32)?,
        first_run_id: text(row, 1, 32)?,
        current_run_id: text(row, 2, 32)?,
        state: text(row, 3, 16)?,
    })
}
fn by_id(conn: &Connection, id: &str) -> Result<Receipt, Error> {
    conn.query_row("SELECT generation_id,first_run_id,current_run_id,state FROM chat_generations WHERE generation_id=?1",[id],receipt).map_err(unavailable)
}

pub(crate) fn begin_rows(
    conn: &Connection,
    scope: Scope<'_>,
    key: &str,
    digest: &str,
) -> Result<Admission, Error> {
    checked(conn, scope)?;
    if !hex(key, 32) || !hex(digest, 64) {
        return Err(Error::Invalid);
    }
    let existing=conn.query_row("SELECT generation_id,first_run_id,current_run_id,state,request_digest,actor_id FROM chat_generations WHERE owner_person=?1 AND vault_id=?2 AND store_uuid=?3 AND request_key=?4",params![scope.owner,scope.vault,scope.store,key],|row|Ok((receipt(row)?,text(row,4,64)?,text(row,5,128)?))).optional().map_err(unavailable)?;
    if let Some((record, old_digest, actor)) = existing {
        if old_digest != digest || actor != scope.actor {
            return Err(Error::Conflict);
        }
        return Ok(Admission::Observed(record));
    }
    let generation = crate::ledger::new_id128();
    let run = crate::ledger::new_run_id();
    conn.execute("INSERT INTO chat_generations(generation_id,owner_person,vault_id,store_uuid,actor_id,request_key,request_digest,first_run_id,current_run_id,state) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?8,'admitted')",params![generation,scope.owner,scope.vault,scope.store,scope.actor,key,digest,run]).map_err(unavailable)?;
    conn.execute("INSERT INTO chat_generation_runs(run_id,generation_id,app_session_id,state) VALUES(?1,?2,?3,'admitted')",params![run,generation,scope.process]).map_err(unavailable)?;
    Ok(Admission::New(by_id(conn, &generation)?))
}
struct Member {
    generation: String,
    state: String,
    current: String,
    predecessor: Option<String>,
    session: Option<String>,
    cancel_requested: bool,
}
fn member(conn: &Connection, scope: Scope<'_>, run: &str) -> Result<Option<Member>, Error> {
    // Check global membership first. A mismatched scope is denied, not legacy.
    let exists: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM chat_generation_runs WHERE run_id=?1)",
            [run],
            |r| r.get(0),
        )
        .map_err(unavailable)?;
    if !exists {
        return Ok(None);
    }
    conn.query_row("SELECT m.generation_id,m.state,g.current_run_id,m.predecessor_run_id,m.cli_session_id,g.cancel_requested FROM chat_generation_runs m JOIN chat_generations g USING(generation_id) WHERE m.run_id=?1 AND g.owner_person=?2 AND g.vault_id=?3 AND g.store_uuid=?4 AND g.actor_id=?5 AND m.app_session_id=?6",params![run,scope.owner,scope.vault,scope.store,scope.actor,scope.process],|r|Ok(Member {generation:text(r,0,32)?,state:text(r,1,16)?,current:text(r,2,32)?,predecessor:r.get(3)?,session:r.get(4)?,cancel_requested:r.get(5)?})).optional().map_err(unavailable)?.ok_or(Error::Denied).map(Some)
}
pub(crate) fn bind_session_rows(
    conn: &Connection,
    scope: Scope<'_>,
    run: &str,
    session: &str,
) -> Result<(), Error> {
    checked(conn, scope)?;
    if !crate::runtime::cause::is_cli_session_id(session) {
        return Err(Error::Invalid);
    }
    let m = member(conn, scope, run)?.ok_or(Error::Denied)?;
    if m.state != "admitted"
        || m.current != run
        || m.session.as_deref().is_some_and(|s| s != session)
    {
        return Err(Error::Denied);
    }
    conn.execute(
        "UPDATE chat_generation_runs SET cli_session_id=?2,state='running' WHERE run_id=?1",
        params![run, session],
    )
    .map_err(unavailable)?;
    conn.execute(
        "UPDATE chat_generations SET state='running' WHERE generation_id=?1 AND current_run_id=?2",
        params![m.generation, run],
    )
    .map_err(unavailable)?;
    Ok(())
}
pub(crate) fn resume_rows(
    conn: &Connection,
    scope: Scope<'_>,
    source_run: &str,
    session: &str,
    answer_key: &str,
) -> Result<Option<Admission>, Error> {
    checked(conn, scope)?;
    if !hex(answer_key, 32) || !crate::runtime::cause::is_cli_session_id(session) {
        return Err(Error::Invalid);
    }
    let Some(m) = member(conn, scope, source_run)? else {
        return Ok(None);
    };
    if m.session.as_deref() != Some(session) {
        return Err(Error::Denied);
    }
    let replay: Option<(String, String)> = conn
        .query_row(
            "SELECT generation_id,predecessor_run_id FROM chat_generation_runs WHERE answer_key=?1",
            [answer_key],
            |r| Ok((text(r, 0, 32)?, text(r, 1, 32)?)),
        )
        .optional()
        .map_err(unavailable)?;
    if let Some((generation, source)) = replay {
        if generation != m.generation || source != source_run {
            return Err(Error::Denied);
        }
        return Ok(Some(Admission::Observed(by_id(conn, &generation)?)));
    }
    if m.cancel_requested
        || m.current != source_run
        || !matches!(m.state.as_str(), "running" | "deferred")
    {
        return Err(Error::Denied);
    }
    let run = crate::ledger::new_run_id();
    conn.execute("INSERT INTO chat_generation_runs(run_id,generation_id,predecessor_run_id,answer_key,cli_session_id,app_session_id,state) VALUES(?1,?2,?3,?4,?5,?6,'admitted')",params![run,m.generation,source_run,answer_key,session,scope.process]).map_err(unavailable)?;
    conn.execute("UPDATE chat_generations SET current_run_id=?2,state='admitted' WHERE generation_id=?1 AND current_run_id=?3",params![m.generation,run,source_run]).map_err(unavailable)?;
    Ok(Some(Admission::New(by_id(conn, &m.generation)?)))
}
pub(crate) fn finish_rows(
    conn: &Connection,
    scope: Scope<'_>,
    run: &str,
    end: End,
) -> Result<(), Error> {
    checked(conn, scope)?;
    let m = member(conn, scope, run)?.ok_or(Error::Denied)?;
    if !matches!(m.state.as_str(), "admitted" | "running") {
        return Ok(());
    }
    let word = match end {
        End::Deferred if m.cancel_requested => "cancelled",
        End::Deferred => "deferred",
        End::Completed => "completed",
        End::Failed => "failed",
        End::Cancelled => "cancelled",
        End::Interrupted => "interrupted",
    };
    conn.execute(
        "UPDATE chat_generation_runs SET state=?2 WHERE run_id=?1",
        params![run, word],
    )
    .map_err(unavailable)?;
    conn.execute(
        "UPDATE chat_generations SET state=?3 WHERE generation_id=?1 AND current_run_id=?2",
        params![m.generation, run, word],
    )
    .map_err(unavailable)?;
    super::conversations::settle_best_effort_rows(
        conn,
        scope,
        &m.generation,
        run,
        chrono::Utc::now().timestamp_millis(),
    );
    Ok(())
}
pub(crate) fn fail_unstarted_rows(
    conn: &Connection,
    scope: Scope<'_>,
    run: &str,
) -> Result<(), Error> {
    checked(conn, scope)?;
    let m = member(conn, scope, run)?.ok_or(Error::Denied)?;
    if !matches!(m.state.as_str(), "admitted" | "running") {
        return Ok(());
    }
    conn.execute(
        "UPDATE chat_generation_runs SET state='failed' WHERE run_id=?1",
        [run],
    )
    .map_err(unavailable)?;
    if let Some(prior) = m.predecessor {
        let mut prior_state: String = conn
            .query_row(
                "SELECT state FROM chat_generation_runs WHERE run_id=?1",
                [&prior],
                |r| text(r, 0, 16),
            )
            .map_err(unavailable)?;
        if m.cancel_requested && prior_state == "deferred" {
            conn.execute(
                "UPDATE chat_generation_runs SET state='cancelled' WHERE run_id=?1",
                [&prior],
            )
            .map_err(unavailable)?;
            prior_state = "cancelled".into();
        }
        conn.execute("UPDATE chat_generations SET current_run_id=?3,state=?4 WHERE generation_id=?1 AND current_run_id=?2",params![m.generation,run,prior,prior_state]).map_err(unavailable)?;
    } else {
        conn.execute("UPDATE chat_generations SET state='failed' WHERE generation_id=?1 AND current_run_id=?2",params![m.generation,run]).map_err(unavailable)?;
    }
    let current = by_id(conn, &m.generation)?.current_run_id;
    super::conversations::settle_best_effort_rows(
        conn,
        scope,
        &m.generation,
        &current,
        chrono::Utc::now().timestamp_millis(),
    );
    Ok(())
}
pub(crate) fn recover_rows(conn: &Connection, scope: Scope<'_>) -> Result<(), Error> {
    checked(conn, scope)?;
    conn.execute("UPDATE chat_generation_runs SET state='interrupted' WHERE app_session_id<>?4 AND state IN ('admitted','running','deferred') AND generation_id IN (SELECT generation_id FROM chat_generations WHERE owner_person=?1 AND vault_id=?2 AND store_uuid=?3)",params![scope.owner,scope.vault,scope.store,scope.process]).map_err(unavailable)?;
    conn.execute("UPDATE chat_generations SET state='interrupted' WHERE owner_person=?1 AND vault_id=?2 AND store_uuid=?3 AND current_run_id IN (SELECT run_id FROM chat_generation_runs WHERE state='interrupted')",params![scope.owner,scope.vault,scope.store]).map_err(unavailable)?;
    let mut statement=conn.prepare("SELECT g.generation_id,g.current_run_id FROM chat_generations g JOIN conversation_bindings b USING(generation_id) WHERE g.owner_person=?1 AND g.vault_id=?2 AND g.store_uuid=?3 AND g.state='interrupted' AND b.archive_state='pending' AND b.completed_at IS NULL ORDER BY g.generation_id LIMIT 128").map_err(unavailable)?;
    let terminal = statement
        .query_map(params![scope.owner, scope.vault, scope.store], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(unavailable)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(unavailable)?;
    for (generation, run) in terminal {
        super::conversations::settle_best_effort_rows(
            conn,
            scope,
            &generation,
            &run,
            chrono::Utc::now().timestamp_millis(),
        );
    }
    Ok(())
}

#[cfg(test)]
#[path = "chat_generation_tests.rs"]
mod tests;

/// The exact pending interaction records cancellation intent. A running process
/// still owns its observed outcome; only a closed deferred member settles here.
pub(crate) fn cancel_wait_rows(
    conn: &Connection,
    scope: Scope<'_>,
    run: &str,
) -> Result<(), Error> {
    checked(conn, scope)?;
    let m = member(conn, scope, run)?.ok_or(Error::Denied)?;
    conn.execute(
        "UPDATE chat_generations SET cancel_requested=1 WHERE generation_id=?1",
        [&m.generation],
    )
    .map_err(unavailable)?;
    conn.execute("UPDATE chat_generation_runs SET state='cancelled' WHERE run_id=(SELECT current_run_id FROM chat_generations WHERE generation_id=?1) AND state='deferred'",[&m.generation]).map_err(unavailable)?;
    conn.execute("UPDATE chat_generations SET state='cancelled' WHERE generation_id=?1 AND current_run_id IN (SELECT run_id FROM chat_generation_runs WHERE state='cancelled')",[&m.generation]).map_err(unavailable)?;
    super::conversations::settle_best_effort_rows(
        conn,
        scope,
        &m.generation,
        &m.current,
        chrono::Utc::now().timestamp_millis(),
    );
    Ok(())
}
/// Called only after the interaction owner reports that the reaped member
/// never consumed its held answer and returned that exact card to Waiting.
pub(crate) fn restore_waiting_rows(
    conn: &Connection,
    scope: Scope<'_>,
    run: &str,
) -> Result<(), Error> {
    checked(conn, scope)?;
    let m = member(conn, scope, run)?.ok_or(Error::Denied)?;
    if m.predecessor.is_none() {
        return Err(Error::Denied);
    }
    fail_unstarted_rows(conn, scope, run)
}

#[cfg(test)]
#[path = "conversation_archive_tests.rs"]
mod conversation_archive_tests;
