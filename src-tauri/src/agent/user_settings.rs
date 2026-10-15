//! The person's own Claude Code settings, counted (M57.2).
//!
//! Every Cerebro run starts with `--setting-sources user`, so the person's
//! own allow rules and hooks act before Cerebro's ask gate does: a command
//! they allow runs without a card. Settings says so beside Shell access, and
//! this module counts what it says: the strings in `permissions.allow`,
//! `permissions.ask` and `permissions.deny` of `<config home>/settings.json`,
//! and the hook events whose list is not empty. It never returns a rule's
//! text, so nothing the person wrote there leaves this function but numbers
//! and event names.
//!
//! Read only, and read where the CLI reads it: the config home is
//! `transcript::config_home` (M56.3), the same resolver the session locator
//! uses. Settings an organization manages live elsewhere and are not read.

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

/// What the disclosure can say. A read that failed says so (CV-05): it
/// never reads as a file holding nothing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum UserSettings {
    /// The file was read: how many rules of each kind it holds, and the
    /// events that carry at least one hook, in the file's order.
    Read {
        path: String,
        allow: usize,
        ask: usize,
        deny: usize,
        hook_events: Vec<String>,
    },
    /// No settings file where the CLI would look.
    Absent { path: String },
    /// A file is there and could not be read as settings.
    Unreadable { path: String, detail: String },
}

/// How many strings `permissions.<key>` holds; anything else counts none.
fn count(permissions: Option<&Value>, key: &str) -> usize {
    permissions
        .and_then(|p| p.get(key))
        .and_then(Value::as_array)
        .map_or(0, |rules| {
            rules.iter().filter(|rule| rule.is_string()).count()
        })
}

/// The summary of the settings file under `config_home`.
pub fn summary(config_home: &Path) -> UserSettings {
    let path: PathBuf = config_home.join("settings.json");
    let shown = path.to_string_lossy().to_string();
    let raw = match std::fs::read(&path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return UserSettings::Absent { path: shown }
        }
        Err(error) => {
            return UserSettings::Unreadable {
                path: shown,
                detail: error.to_string(),
            }
        }
    };
    let parsed: Value = match serde_json::from_slice(&raw) {
        Ok(parsed) => parsed,
        Err(error) => {
            return UserSettings::Unreadable {
                path: shown,
                detail: format!("not JSON: {error}"),
            }
        }
    };
    let Some(settings) = parsed.as_object() else {
        return UserSettings::Unreadable {
            path: shown,
            detail: "not a JSON object".into(),
        };
    };
    let permissions = settings.get("permissions");
    let hook_events = settings
        .get("hooks")
        .and_then(Value::as_object)
        .map(|hooks| {
            hooks
                .iter()
                .filter(|(_, list)| list.as_array().is_some_and(|list| !list.is_empty()))
                .map(|(event, _)| event.clone())
                .collect()
        })
        .unwrap_or_default();
    UserSettings::Read {
        path: shown,
        allow: count(permissions, "allow"),
        ask: count(permissions, "ask"),
        deny: count(permissions, "deny"),
        hook_events,
    }
}

/// The summary for the config home Cerebro's runs in `vault` use.
pub fn for_vault(vault: &Path) -> UserSettings {
    let env = super::transcript::CliEnv::from_process();
    match super::transcript::config_home(&env, vault) {
        Some(home) => summary(&home),
        None => UserSettings::Unreadable {
            path: "~/.claude/settings.json".into(),
            detail: "no home folder is set".into(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn home(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cerebro-user-settings-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(dir: &Path, value: &str) {
        std::fs::write(dir.join("settings.json"), value).unwrap();
    }

    #[test]
    fn counts_rules_and_hook_events() {
        let dir = home("counts");
        write(
            &dir,
            &json!({
                "permissions": {
                    "allow": ["Bash(git status:*)", "Bash(ls:*)", "Read", 7],
                    "ask": ["Bash(rm:*)"],
                    "deny": ["WebFetch", "Bash(curl:*)"]
                },
                "hooks": {
                    "PreToolUse": [{ "matcher": "Bash", "hooks": [] }],
                    "Stop": [{ "hooks": [] }],
                    "Notification": []
                }
            })
            .to_string(),
        );
        assert_eq!(
            summary(&dir),
            UserSettings::Read {
                path: dir.join("settings.json").to_string_lossy().to_string(),
                allow: 3,
                ask: 1,
                deny: 2,
                hook_events: vec!["PreToolUse".into(), "Stop".into()],
            }
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn empty_hook_lists_and_missing_sections_count_none() {
        let dir = home("empty");
        write(
            &dir,
            r#"{"hooks": {"PreToolUse": [], "Stop": {}}, "model": "x"}"#,
        );
        let UserSettings::Read {
            allow,
            ask,
            deny,
            hook_events,
            ..
        } = summary(&dir)
        else {
            panic!("a settings file with nothing in it still reads");
        };
        assert_eq!((allow, ask, deny), (0, 0, 0));
        assert!(hook_events.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_absent_file_says_where_it_looked() {
        let dir = home("absent");
        assert_eq!(
            summary(&dir),
            UserSettings::Absent {
                path: dir.join("settings.json").to_string_lossy().to_string()
            }
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn malformed_json_and_a_non_object_read_unreadable() {
        let dir = home("malformed");
        for body in ["{not json", "[1, 2]", "\"text\""] {
            write(&dir, body);
            assert!(
                matches!(summary(&dir), UserSettings::Unreadable { .. }),
                "{body}"
            );
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn a_file_nobody_may_read_reads_unreadable() {
        use std::os::unix::fs::PermissionsExt;
        let dir = home("chmod");
        write(&dir, "{}");
        let path = dir.join("settings.json");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000)).unwrap();
        // Root reads anything, so the case only means something as a user.
        if std::fs::read(&path).is_err() {
            assert!(matches!(summary(&dir), UserSettings::Unreadable { .. }));
        }
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_result_holds_no_rule_text() {
        let dir = home("no-text");
        write(
            &dir,
            r#"{"permissions": {"allow": ["Bash(secret-tool:*)"], "deny": ["Read(~/private/**)"]},
                "hooks": {"PreToolUse": [{"hooks": [{"type": "command", "command": "/opt/hook.sh"}]}]}}"#,
        );
        let shown = serde_json::to_string(&summary(&dir)).unwrap();
        for text in ["secret-tool", "private", "hook.sh", "command"] {
            assert!(!shown.contains(text), "{text} leaked: {shown}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
