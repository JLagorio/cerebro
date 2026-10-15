//! Personal tokens for other apps (M62.5). Only fingerprints persist.
//!
//! Names and grants replay `src-tauri/fixtures/client-tokens.json` in Rust
//! and the browser mock. The manifest alone decides which toolsets may be
//! granted; these checks only normalize the person's grant and its folders.

use std::fmt;

use rand::{rngs::OsRng, RngCore};
use rusqlite::{params, Connection, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};

use crate::{ledger::sha256_hex, policy::tools};

pub const MAX_TOKENS: usize = 20;
pub const MAX_FOLDERS: usize = 20;
pub const NAME_CAP: usize = 100;
pub const FOLDER_CAP: usize = 512;
pub const UNAVAILABLE: &str =
    "Cerebro's runtime database isn't open, so tokens can't be read or made.";
pub const AT_CAP: &str = "You have 20 tokens. Revoke one to make another.";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClientTokenRequest {
    pub name: String,
    pub toolsets: Vec<String>,
    pub write_scope: Vec<String>,
    pub read_scope: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Grant {
    pub toolsets: Vec<String>,
    pub write_scope: Vec<String>,
    pub read_scope: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientToken {
    pub token_id: String,
    pub vault_id: String,
    pub vault_path: String,
    pub name: String,
    pub slug: String,
    pub toolsets: Vec<String>,
    pub write_scope: Vec<String>,
    pub read_scope: Option<Vec<String>>,
    pub created_at: String,
    pub last_used_at: Option<String>,
    pub current_vault: bool,
}

/// Returned only by create, never kept in process state. The only intentional
/// serialization of a secret is this once-only IPC response to its creator.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedClientToken {
    pub token: ClientToken,
    pub secret: String,
}

impl fmt::Debug for CreatedClientToken {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let suffix = self
            .secret
            .get(self.secret.len().saturating_sub(4)..)
            .unwrap_or("");
        f.debug_struct("CreatedClientToken")
            .field("token", &self.token)
            .field("secret", &format_args!("cbr_…{suffix}"))
            .finish()
    }
}

fn controls(c: char) -> bool {
    matches!(c, '\u{0}'..='\u{1f}' | '\u{7f}'..='\u{9f}')
}

pub fn name_and_slug(raw: &str) -> Result<(String, String), String> {
    let name = raw.trim();
    if name.is_empty() || name.chars().count() > NAME_CAP {
        return Err("Give this token a name from 1 to 100 characters.".into());
    }
    if name.chars().any(controls) {
        return Err("A token name can't contain control characters.".into());
    }
    let mut slug = String::new();
    let mut separator = false;
    for c in name.chars() {
        if c.is_ascii_alphanumeric() {
            if separator && !slug.is_empty() {
                slug.push('-');
            }
            slug.push(c.to_ascii_lowercase());
            separator = false;
        } else {
            separator = true;
        }
    }
    slug.truncate(32);
    // A cut can land on a separator. Keep the same trim rule after the cut.
    let slug = slug.trim_matches('-');
    Ok((
        name.into(),
        if slug.is_empty() { "app" } else { slug }.into(),
    ))
}

fn folders(raw: &[String], writing: bool) -> Result<Vec<String>, String> {
    let axis = if writing { "write" } else { "read" };
    let mut normalized = Vec::new();
    for folder in raw {
        let mut value = folder.trim();
        // Match whole ./ prefixes, never trim arbitrary '.' characters.
        loop {
            value = value.trim_matches('/');
            if let Some(rest) = value.strip_prefix("./") {
                value = rest;
            } else {
                break;
            }
        }
        if value.is_empty() || value == "." {
            return Err(format!(
                "Choose a {axis} folder inside the vault, not the whole vault."
            ));
        }
        if value.len() > FOLDER_CAP {
            return Err(format!("A {axis} folder must be at most 512 bytes."));
        }
        if value.contains('\\') || value.chars().any(controls) {
            return Err(format!(
                "A {axis} folder can't contain a backslash or control characters."
            ));
        }
        if value.split('/').any(|part| part.starts_with('.')) {
            return Err(format!(
                "A {axis} folder can't contain a hidden or parent directory."
            ));
        }
        let folder = value
            .split('/')
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join("/");
        if writing && crate::knowledge::is_knowledge_path(&folder) {
            return Err("A token can't write in Knowledge.".into());
        }
        if !normalized.contains(&folder) {
            normalized.push(folder);
        }
    }
    if normalized.is_empty() || normalized.len() > MAX_FOLDERS {
        return Err(format!("Choose from 1 to 20 {axis} folders."));
    }
    Ok(normalized)
}

pub fn validate_grant(
    toolsets: &[String],
    write_scope: &[String],
    read_scope: Option<&[String]>,
) -> Result<Grant, String> {
    tools::client_tool_names(toolsets)?;
    let writing = toolsets.iter().any(|set| tools::toolset_writes(set));
    Ok(Grant {
        toolsets: toolsets.to_vec(),
        write_scope: if writing {
            folders(write_scope, true)?
        } else {
            Vec::new()
        },
        read_scope: read_scope.map(|scope| folders(scope, false)).transpose()?,
    })
}

fn random_hex<const N: usize>() -> Result<String, String> {
    let mut bytes = [0u8; N];
    OsRng
        .try_fill_bytes(&mut bytes)
        .map_err(|_| "Couldn't make a secure token. Try again.".to_string())?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn db_error(error: rusqlite::Error) -> String {
    // Never interpolate a SQL parameter, token, fingerprint or caller input.
    format!("Couldn't read or change personal tokens: {error}")
}

pub fn create(
    conn: &Connection,
    vault_id: &str,
    request: &ClientTokenRequest,
    now: &str,
) -> Result<CreatedClientToken, String> {
    let (name, slug) = name_and_slug(&request.name)?;
    let grant = validate_grant(
        &request.toolsets,
        &request.write_scope,
        request.read_scope.as_deref(),
    )?;
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate).map_err(db_error)?;
    let duplicate: bool = tx
        .query_row(
            "SELECT EXISTS (SELECT 1 FROM client_tokens WHERE vault_id = ?1 AND slug = ?2)",
            params![vault_id, slug],
            |row| row.get(0),
        )
        .map_err(db_error)?;
    if duplicate {
        return Err("This vault already has a token with that name. Choose another name.".into());
    }
    let vault_path = super::scope::path_of(&tx, vault_id)?
        .ok_or_else(|| "Open this vault before making a token.".to_string())?;
    let token_id = random_hex::<16>()?;
    let secret = format!("cbr_{}", random_hex::<32>()?);
    let fingerprint = sha256_hex(secret.as_bytes());
    let changed = tx
        .execute(
            "INSERT INTO client_tokens (token_id, vault_id, name, slug, secret_sha256, toolsets, \
         write_scope, read_scope, created_at) SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9 \
         WHERE (SELECT count(*) FROM client_tokens) < ?10",
            params![
                token_id,
                vault_id,
                name,
                slug,
                fingerprint,
                serde_json::to_string(&grant.toolsets).expect("strings serialize"),
                serde_json::to_string(&grant.write_scope).expect("strings serialize"),
                grant
                    .read_scope
                    .as_ref()
                    .map(|scope| serde_json::to_string(scope).expect("strings serialize")),
                now,
                MAX_TOKENS as i64
            ],
        )
        .map_err(db_error)?;
    if changed == 0 {
        return Err(AT_CAP.into());
    }
    tx.commit().map_err(db_error)?;
    Ok(CreatedClientToken {
        token: ClientToken {
            token_id,
            vault_id: vault_id.into(),
            vault_path,
            name,
            slug,
            toolsets: grant.toolsets,
            write_scope: grant.write_scope,
            read_scope: grant.read_scope,
            created_at: now.into(),
            last_used_at: None,
            current_vault: true,
        },
        secret,
    })
}

fn json_array(row: &rusqlite::Row<'_>, index: usize) -> rusqlite::Result<Vec<String>> {
    let raw: String = row.get(index)?;
    serde_json::from_str(&raw).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            index,
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })
}

pub fn list(conn: &Connection, current_vault: Option<&str>) -> Result<Vec<ClientToken>, String> {
    let mut statement = conn
        .prepare(
            "SELECT t.token_id, t.vault_id, v.vault_path, t.name, t.slug, t.toolsets, \
         t.write_scope, t.read_scope, t.created_at, t.last_used_at FROM client_tokens t \
         JOIN vault_registry v ON v.vault_id = t.vault_id ORDER BY t.created_at, t.token_id",
        )
        .map_err(db_error)?;
    let rows = statement
        .query_map([], |row| {
            let vault_id: String = row.get(1)?;
            let read_raw: Option<String> = row.get(7)?;
            Ok(ClientToken {
                token_id: row.get(0)?,
                current_vault: current_vault == Some(vault_id.as_str()),
                vault_id,
                vault_path: row.get(2)?,
                name: row.get(3)?,
                slug: row.get(4)?,
                toolsets: json_array(row, 5)?,
                write_scope: json_array(row, 6)?,
                read_scope: read_raw.map(|_| json_array(row, 7)).transpose()?,
                created_at: row.get(8)?,
                last_used_at: row.get(9)?,
            })
        })
        .map_err(db_error)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(db_error)
}

pub fn revoke(conn: &Connection, token_id: &str) -> Result<bool, String> {
    conn.execute("DELETE FROM client_tokens WHERE token_id = ?1", [token_id])
        .map(|changed| changed != 0)
        .map_err(db_error)
}

/// Authentication material is process-local and never serialized or printed.
pub struct LiveToken {
    pub token: ClientToken,
    fingerprint: String,
}

impl fmt::Debug for LiveToken {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("LiveToken")
            .field("token", &self.token)
            .finish_non_exhaustive()
    }
}

impl LiveToken {
    pub fn fingerprint(&self) -> &str {
        &self.fingerprint
    }
    pub fn grant(&self) -> Grant {
        Grant {
            toolsets: self.token.toolsets.clone(),
            write_scope: self.token.write_scope.clone(),
            read_scope: self.token.read_scope.clone(),
        }
    }
}

/// Read and revalidate grants for every authentication. A revoked row can
/// never survive in an authentication cache; an unreadable or stale grant
/// fails closed rather than silently changing its reach.
pub fn live(conn: &Connection) -> Result<Vec<LiveToken>, String> {
    let tokens = list(conn, None)?;
    if tokens.len() > MAX_TOKENS {
        return Err("Personal token storage exceeds its limit.".into());
    }
    tokens
        .into_iter()
        .map(|token| {
            let grant = validate_grant(
                &token.toolsets,
                &token.write_scope,
                token.read_scope.as_deref(),
            )?;
            let (name, slug) = name_and_slug(&token.name)?;
            if grant.write_scope != token.write_scope
                || grant.read_scope != token.read_scope
                || name != token.name
                || slug != token.slug
            {
                return Err("A stored personal token no longer has a valid grant.".into());
            }
            let fingerprint = conn
                .query_row(
                    "SELECT secret_sha256 FROM client_tokens WHERE token_id = ?1",
                    [&token.token_id],
                    |row| row.get(0),
                )
                .map_err(db_error)?;
            Ok(LiveToken { token, fingerprint })
        })
        .collect()
}

pub fn stamp_used(conn: &Connection, token_id: &str, now: &str) -> Result<bool, String> {
    conn.execute("UPDATE client_tokens SET last_used_at = CASE WHEN last_used_at IS NULL OR last_used_at < ?2 THEN ?2 ELSE last_used_at END WHERE token_id = ?1", params![token_id, now])
        .map(|changed| changed != 0).map_err(db_error)
}

pub fn session_id() -> Result<String, String> {
    random_hex::<16>()
}

/// Used only in tests to verify the persisted representation without adding
/// a production accessor that could accidentally expose the fingerprint.
#[cfg(test)]
fn stored_hash(conn: &Connection, token_id: &str) -> Option<String> {
    use rusqlite::OptionalExtension;
    conn.query_row(
        "SELECT secret_sha256 FROM client_tokens WHERE token_id = ?1",
        [token_id],
        |r| r.get(0),
    )
    .optional()
    .unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{runtime, vault::testutil};
    use serde_json::{json, Value};
    use std::sync::{Arc, Barrier};

    const NOW: &str = "2026-10-15T12:00:00.000Z";

    fn request(name: &str) -> ClientTokenRequest {
        ClientTokenRequest {
            name: name.into(),
            toolsets: vec!["read".into()],
            write_scope: vec![],
            read_scope: None,
        }
    }

    fn registered(label: &str) -> (std::path::PathBuf, Connection, String) {
        let dir = testutil::temp_vault(label);
        let conn = runtime::open(&dir).unwrap();
        let vault = runtime::scope::register(&conn, &dir).unwrap();
        (dir, conn, vault)
    }

    #[test]
    fn names_and_grants_replay_the_shared_cases() {
        let cases: Value =
            serde_json::from_str(include_str!("../../fixtures/client-tokens.json")).unwrap();
        assert_eq!(cases["limits"]["tokens"], MAX_TOKENS);
        assert_eq!(cases["limits"]["folders"], MAX_FOLDERS);
        assert_eq!(cases["limits"]["nameChars"], NAME_CAP);
        assert_eq!(cases["limits"]["folderBytes"], FOLDER_CAP);
        for case in cases["names"].as_array().unwrap() {
            let actual = match name_and_slug(case["name"].as_str().unwrap()) {
                Ok((name, slug)) => json!({"name":name,"slug":slug}),
                Err(refusal) => json!({"refusal":refusal}),
            };
            assert_eq!(actual, case["expect"], "{case}");
        }
        for case in cases["grants"].as_array().unwrap() {
            let value = &case["request"];
            let strings =
                |key: &str| -> Vec<String> { serde_json::from_value(value[key].clone()).unwrap() };
            let read: Option<Vec<String>> =
                serde_json::from_value(value["readScope"].clone()).unwrap();
            let actual = match validate_grant(
                &strings("toolsets"),
                &strings("writeScope"),
                read.as_deref(),
            ) {
                Ok(grant) => json!({"grant":grant}),
                Err(refusal) => json!({"refusal":refusal}),
            };
            assert_eq!(actual, case["expect"], "{}", case["name"]);
        }
    }

    #[test]
    fn a_minted_token_is_stored_as_its_hash_alone() {
        let (dir, conn, vault) = registered("client-token-secret");
        let created = create(&conn, &vault, &request("Terminal"), NOW).unwrap();
        assert_eq!(created.secret.len(), 68);
        assert!(created.secret.starts_with("cbr_"));
        assert!(created.secret[4..]
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)));
        assert_eq!(
            stored_hash(&conn, &created.token.token_id),
            Some(sha256_hex(created.secret.as_bytes()))
        );
        assert_eq!(created.token.token_id.len(), 32);
        let listed = serde_json::to_string(&list(&conn, Some(&vault)).unwrap()).unwrap();
        assert!(!listed.contains(&created.secret));
        assert!(!listed.contains(&sha256_hex(created.secret.as_bytes())));
        for name in ["runtime.db", "runtime.db-wal"] {
            let bytes = std::fs::read(dir.join(name)).unwrap_or_default();
            assert!(
                !bytes
                    .windows(created.secret.len())
                    .any(|part| part == created.secret.as_bytes()),
                "{name}"
            );
        }
        drop(conn);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_created_token_never_prints_its_secret() {
        let (dir, conn, vault) = registered("client-token-debug");
        let created = create(&conn, &vault, &request("Terminal"), NOW).unwrap();
        let printed = format!("{created:?}");
        assert!(!printed.contains(&created.secret));
        assert!(printed.contains(&format!("cbr_…{}", &created.secret[64..])));
        drop(conn);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn the_twenty_first_token_is_refused_even_when_two_creates_race() {
        let (dir, conn, vault) = registered("client-token-cap-race");
        for i in 0..19 {
            create(&conn, &vault, &request(&format!("token-{i}")), NOW).unwrap();
        }
        let barrier = Arc::new(Barrier::new(2));
        let handles: Vec<_> = (0..2)
            .map(|i| {
                let path = runtime::runtime_db_path(&dir);
                let vault = vault.clone();
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    let conn = Connection::open(path).unwrap();
                    conn.busy_timeout(std::time::Duration::from_secs(5))
                        .unwrap();
                    conn.pragma_update(None, "foreign_keys", true).unwrap();
                    barrier.wait();
                    create(&conn, &vault, &request(&format!("racer-{i}")), NOW)
                })
            })
            .collect();
        let results: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
        assert_eq!(
            results.iter().find_map(|r| r.as_ref().err()),
            Some(&AT_CAP.to_string())
        );
        assert_eq!(list(&conn, Some(&vault)).unwrap().len(), MAX_TOKENS);
        // The cap is app-wide even when the new name belongs to another vault.
        let another = runtime::scope::register(&conn, &dir.join("another")).unwrap();
        assert_eq!(
            create(&conn, &another, &request("new name"), NOW).unwrap_err(),
            AT_CAP
        );
        drop(conn);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_name_this_vault_holds_is_refused_and_another_vaults_is_not() {
        let (dir, conn, vault) = registered("client-token-name");
        create(&conn, &vault, &request("Claude Code"), NOW).unwrap();
        assert_eq!(
            create(&conn, &vault, &request("claude_code"), NOW).unwrap_err(),
            "This vault already has a token with that name. Choose another name."
        );
        let other = runtime::scope::register(&conn, &dir.join("other")).unwrap();
        create(&conn, &other, &request("Claude Code"), NOW).unwrap();
        assert_eq!(list(&conn, None).unwrap().len(), 2);
        drop(conn);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn revoke_deletes_the_row() {
        let (dir, conn, vault) = registered("client-token-revoke");
        let created = create(&conn, &vault, &request("Terminal"), NOW).unwrap();
        assert!(revoke(&conn, &created.token.token_id).unwrap());
        assert!(!revoke(&conn, &created.token.token_id).unwrap());
        assert!(list(&conn, Some(&vault)).unwrap().is_empty());
        assert!(stored_hash(&conn, &created.token.token_id).is_none());
        drop(conn);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn tokens_list_with_their_vault_and_whether_it_is_this_one() {
        let (dir, conn, vault) = registered("client-token-vaults");
        let other_path = dir.join("other");
        let other = runtime::scope::register(&conn, &other_path).unwrap();
        create(&conn, &vault, &request("Here"), NOW).unwrap();
        create(&conn, &other, &request("There"), NOW).unwrap();
        let tokens = list(&conn, Some(&vault)).unwrap();
        assert!(
            tokens
                .iter()
                .find(|t| t.name == "Here")
                .unwrap()
                .current_vault
        );
        let there = tokens.iter().find(|t| t.name == "There").unwrap();
        assert!(!there.current_vault);
        assert_eq!(
            there.vault_path,
            runtime::scope::canonical_path(&other_path)
        );
        drop(conn);
        let _ = std::fs::remove_dir_all(dir);
    }
    #[test]
    fn authentication_revalidates_grants_and_never_debugs_fingerprints() {
        let (dir, conn, vault) = registered("client-live-grants");
        let created = create(&conn, &vault, &request("App"), NOW).unwrap();
        let tokens = live(&conn).unwrap();
        let printed = format!("{:?}", tokens[0]);
        assert!(!printed.contains(&created.secret));
        assert!(!printed.contains(tokens[0].fingerprint()));
        conn.execute(
            "UPDATE client_tokens SET toolsets='[\"read\",\"propose\"]' WHERE token_id=?1",
            [&created.token.token_id],
        )
        .unwrap();
        assert!(live(&conn).is_err());
        drop(conn);
        let _ = std::fs::remove_dir_all(dir);
    }
    #[test]
    fn last_used_never_moves_backwards_and_revoked_tokens_cannot_be_stamped() {
        let (dir, conn, vault) = registered("client-live-stamp");
        let created = create(&conn, &vault, &request("App"), NOW).unwrap();
        let id = &created.token.token_id;
        assert!(stamp_used(&conn, id, "2026-10-15T12:03:00.000Z").unwrap());
        assert!(stamp_used(&conn, id, NOW).unwrap());
        assert_eq!(
            list(&conn, None).unwrap()[0].last_used_at.as_deref(),
            Some("2026-10-15T12:03:00.000Z")
        );
        revoke(&conn, id).unwrap();
        assert!(!stamp_used(&conn, id, NOW).unwrap());
        drop(conn);
        let _ = std::fs::remove_dir_all(dir);
    }
}
