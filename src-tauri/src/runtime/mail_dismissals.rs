//! A person's dismissed correspondents, local to runtime.db and one vault.
//! D3: src-tauri/fixtures/mail-dismissal-cases.json also runs in unfiled.test.ts
//! and mockIpc.test.ts. These addresses never enter the vault or the ledger.
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailDismissal {
    pub kind: String,
    pub value: String,
    pub dismissed_at: String,
}

// ECMAScript trim/\s, deliberately distinct from Rust trim used by the
// existing mailbox normalizer. In particular JS trims FEFF, but not NEL.
fn js_space(c: char) -> bool {
    matches!(c, '\u{0009}'..='\u{000d}' | ' ' | '\u{00a0}' | '\u{1680}'
        | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}'
        | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

fn normalize_domain(raw: &str) -> Option<String> {
    let value = raw.trim_matches(js_space);
    if value.is_empty() || value.chars().any(|c| js_space(c) || c.is_control()) {
        return None;
    }
    let has_scheme = value.split_once(':').is_some_and(|(prefix, _)| {
        prefix.starts_with(|c: char| c.is_ascii_alphabetic())
            && prefix
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c))
    });
    let url = tauri::Url::parse(&if has_scheme {
        value.to_owned()
    } else {
        format!("https://{value}")
    })
    .ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    // Url distinguishes IP hosts; the TypeScript WHATWG reader does too.
    let host = url
        .domain()?
        .strip_suffix('.')
        .unwrap_or(url.domain()?)
        .to_ascii_lowercase();
    if !host.contains('.')
        || !host
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || ".-".contains(c))
        || host
            .split('.')
            .any(|part| part.is_empty() || part.starts_with('-') || part.ends_with('-'))
        || host.chars().all(|c| c.is_ascii_digit() || c == '.')
    {
        return None;
    }
    Some(host)
}

pub fn normalize(kind: &str, raw: &str) -> Result<String, String> {
    let value = match kind {
        "address" => crate::mail::address::normalize_address(raw),
        "domain" => normalize_domain(raw),
        _ => return Err("Choose an address or domain to dismiss.".into()),
    };
    value
        .filter(|v| (3..=320).contains(&v.chars().count()))
        .ok_or_else(|| format!("Use a valid mail {kind} with 3 to 320 characters."))
}

pub fn read(conn: &Connection, vault_id: &str) -> Result<Vec<MailDismissal>, String> {
    let mut statement = conn.prepare(
        "SELECT kind,value,dismissed_at FROM mail_dismissals WHERE vault_id=?1 ORDER BY kind,value",
    ).map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([vault_id], |row| {
            Ok(MailDismissal {
                kind: row.get(0)?,
                value: row.get(1)?,
                dismissed_at: row.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

pub fn dismiss(conn: &Connection, vault_id: &str, kind: &str, raw: &str) -> Result<(), String> {
    dismiss_at(conn, vault_id, kind, raw, &super::now_utc())
}
fn dismiss_at(
    conn: &Connection,
    vault_id: &str,
    kind: &str,
    raw: &str,
    at: &str,
) -> Result<(), String> {
    let value = normalize(kind, raw)?;
    conn.execute(
        "INSERT OR IGNORE INTO mail_dismissals(vault_id,kind,value,dismissed_at) VALUES(?1,?2,?3,?4)",
        params![vault_id, kind, value, at],
    ).map_err(|e| e.to_string())?;
    Ok(())
}
pub fn restore(conn: &Connection, vault_id: &str, kind: &str, raw: &str) -> Result<(), String> {
    let value = normalize(kind, raw)?;
    conn.execute(
        "DELETE FROM mail_dismissals WHERE vault_id=?1 AND kind=?2 AND value=?3",
        params![vault_id, kind, value],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    fn connection() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON; CREATE TABLE vault_registry(vault_id TEXT PRIMARY KEY); INSERT INTO vault_registry VALUES ('one'),('two');").unwrap();
        conn.execute_batch(super::super::schema::SCHEMA_V31)
            .unwrap();
        conn
    }
    #[test]
    fn replays_the_shared_mail_dismissal_cases() {
        let cases: Value =
            serde_json::from_str(include_str!("../../fixtures/mail-dismissal-cases.json")).unwrap();
        for case in cases["cases"].as_array().unwrap() {
            let result = normalize(
                case["kind"].as_str().unwrap(),
                case["value"].as_str().unwrap(),
            );
            if let Some(error) = case["error"].as_str() {
                assert_eq!(result.unwrap_err(), error, "{case}");
            } else {
                assert_eq!(
                    result.unwrap(),
                    case["normalized"].as_str().unwrap(),
                    "{case}"
                );
            }
        }
        let conn = connection();
        for row in cases["rows"].as_array().unwrap() {
            dismiss_at(
                &conn,
                row["vault"].as_str().unwrap(),
                row["kind"].as_str().unwrap(),
                row["value"].as_str().unwrap(),
                row["at"].as_str().unwrap(),
            )
            .unwrap();
        }
        assert_eq!(
            serde_json::to_value(read(&conn, "one").unwrap()).unwrap(),
            cases["one"]
        );
        restore(&conn, "one", "address", "DANA@ACME.EXAMPLE").unwrap();
        assert_eq!(read(&conn, "one").unwrap().len(), 1);
        assert_eq!(read(&conn, "two").unwrap().len(), 1);
        restore(&conn, "one", "address", "DANA@ACME.EXAMPLE").unwrap();
    }
    #[test]
    fn mail_dismissal_checks_hold_even_for_direct_sql() {
        let conn = connection();
        for (vault, kind, value, at) in [
            ("absent", "address", "a@b.example", "2026-10-15T00:00:00Z"),
            ("one", "company", "acme.example", "2026-10-15T00:00:00Z"),
            ("one", "domain", "UPPER.example", "2026-10-15T00:00:00Z"),
            ("one", "domain", "ab", "2026-10-15T00:00:00Z"),
            ("one", "domain", "acme.example", "today"),
        ] {
            assert!(conn
                .execute(
                    "INSERT INTO mail_dismissals VALUES(?1,?2,?3,?4)",
                    params![vault, kind, value, at]
                )
                .is_err());
        }
        assert!(conn
            .execute(
                "INSERT INTO mail_dismissals VALUES('one','address',?1,'2026-10-15T00:00:00Z')",
                ["a".repeat(321)]
            )
            .is_err());
    }
    #[test]
    fn an_unavailable_dismissal_table_never_reads_as_empty() {
        assert!(read(&Connection::open_in_memory().unwrap(), "one").is_err());
    }
    #[test]
    fn a_dismissal_survives_a_real_database_reopen() {
        let dir = crate::vault::testutil::temp_vault("mail-dismissal-reopen");
        let conn = super::super::open(&dir).unwrap();
        let vault_id = super::super::scope::register(&conn, &dir).unwrap();
        dismiss_at(
            &conn,
            &vault_id,
            "address",
            "Dana@Acme.Example",
            "2026-10-15T02:00:00Z",
        )
        .unwrap();
        drop(conn);
        let conn = super::super::open(&dir).unwrap();
        assert_eq!(
            read(&conn, &vault_id).unwrap(),
            vec![MailDismissal {
                kind: "address".into(),
                value: "dana@acme.example".into(),
                dismissed_at: "2026-10-15T02:00:00Z".into(),
            }]
        );
        restore(&conn, &vault_id, "address", "dana@acme.example").unwrap();
        drop(conn);
        let conn = super::super::open(&dir).unwrap();
        assert!(read(&conn, &vault_id).unwrap().is_empty());
        drop(conn);
        let _ = std::fs::remove_dir_all(dir);
    }
    #[test]
    fn dismissal_words_never_include_the_private_input() {
        assert_eq!(
            normalize("company", "private@acme.example"),
            Err("Choose an address or domain to dismiss.".into())
        );
        assert_eq!(
            json!(normalize("address", "private").unwrap_err()),
            json!("Use a valid mail address with 3 to 320 characters.")
        );
    }
}
